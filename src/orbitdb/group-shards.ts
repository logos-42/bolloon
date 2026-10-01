/**
 * group-shards.ts — 群事件流的分片 + 尾部读取 (P0b/P3, 2026-09-30)
 *
 * 为什么需要它 (P0b 实测):
 *   OrbitDB 打开一个 events store 时, 要从 heads 起**遍历整条 oplog DAG** 逐块取
 *   (@orbitdb/core 4.0.0 src/oplog/log.js:272), 且**日志要到遍历结束才成形**
 *   (中途 all() 恒为 0)。真两节点实测: 301 条 = 70s 才一次成形, 1001 条在 300s 窗口里完不成。
 *   ⇒ 每开一次群 = O(总条数) 次取块 ⇒ **1 万 agent 规模下不可用**。
 *
 * 本模块给出的是"打开成本由**单片大小**决定"的写法:
 *   · 一个群 = 一串 events store (`<group>-s000`, `-s001`, …), 每片最多 SHARD_SIZE 条;
 *   · 另有一个极小的 **keyvalue manifest store** 记录各片的名字/地址/条数;
 *   · 读尾部 = 读 manifest (1 个 key) + **只打开最后一片** ⇒ 不随总历史增长;
 *   · 要读旧片时再按地址打开那一片 (按需)。
 *
 * 注意: 本模块**不改变**既有 `bolloon-gw-group-<name>` 单库群的语义 (那是 gateway-group.ts 的地盘),
 * 它给的是新写入路径。旧群里已有的数据照旧可读。
 */
import type { OrbitDBStore } from './cid-database.js';

/** 每片最多多少条 —— 直接决定"打开一片"的成本上界 (越小越快, 但片数越多) */
export const SHARD_SIZE = 200;

/**
 * 片 store 的写入白名单 (2026-10-01 收紧)。
 * 之前分片模块硬写 `write: ['*']` (任何人可写) —— 那是 P0 阶段为了让"非创建者也能验证"留下的口子,
 * 在 1 万 agent 场景下是**真敞口**。现在改成显式参数:
 *   · 不传 (默认) ⇒ **创建者独占** (不传 write 列表给 IPFSAccessController ⇒ 它落到 write=[创建者身份 id],
 *     这正是 @orbitdb/core 的默认语义);
 *   · 要允许多成员写, 由调用方显式传各自的 **OrbitDB 写身份** (见 group-access.ts 的白名单派生)。
 * 注意: 打开**既有**地址时 ACL 来自 manifest, 传什么都不改变既有片的权限 (只能新建时收紧)。
 */
export interface ShardWritePolicy {
  /** 允许写入这些 OrbitDB 写身份; 省略 = 只有创建者可写 */
  writeList?: string[];
}
const aclOf = (policy?: ShardWritePolicy): { accessController?: { write: string[] } } =>
  policy?.writeList && policy.writeList.length ? { accessController: { write: policy.writeList } } : {};

/**
 * 片级 store 缓存 (与 src/agents/gateway-group.ts 的 storeCache 同一套 idiom)。
 * 没有它, `appendEvent` 每写一条都会再 openStore 一次 —— 1000 条 = 1000 次重复打开,
 * 既慢又可能把同一个库开出多个句柄。
 */
const shardCache = new Map<string, OrbitDBStore>();
/**
 * 片内条数缓存 (2026-10-01 回归修复)。
 * 轮转判据**必须**用这里 (片自己的真实长度), 不能用 manifest 里的 count ——
 * 我为了消掉 manifest 的 O(N) 把它改成"只在轮转时落盘", 结果 count 永远停在旧值 ⇒ 再也不开新片 (实测 1000 条只有 1 片)。
 * 首次碰到某片时用 `all().length` 对齐一次, 之后逐条自增 (不每条都读一遍)。
 */
const countCache = new Map<string, number>();
function cached(key: string, make: () => Promise<OrbitDBStore>): Promise<OrbitDBStore> {
  const hit = shardCache.get(key);
  if (hit) return Promise.resolve(hit);
  return make().then((st) => { shardCache.set(key, st); return st; });
}

export interface ShardInfo {
  /** 第几片 (从 0 起) */
  index: number;
  /** store 名 */
  name: string;
  /** orbitdb 地址 (可分享给别人按需打开) */
  address: string;
  /** 这片里已写多少条 */
  count: number;
  /** 首条 / 末条的时间戳 (便于按时间找片) */
  fromTs: number;
  toTs: number;
}

export interface ShardManifest {
  v: 1;
  group: string;
  shards: ShardInfo[];
  updatedAt: number;
}

/** manifest store 名 (keyvalue, 极小: 只有一个 key) */
export const manifestStoreName = (group: string): string => `bolloon-gw-shards-${group}`;
/** 第 i 片的 store 名 */
export const shardStoreName = (group: string, i: number): string => `bolloon-gw-group-${group}-s${String(i).padStart(3, '0')}`;

/**
 * 有界等待 manifest 到达 (2026-09-30 实测踩的竞态)。
 * OrbitDB 按地址打开 store 是**异步同步**的: open() 很快返回 (实测 174ms), 但内容要靠 pubsub/取块
 * 慢慢到 —— 立刻 `get('manifest')` 会拿到空。任何真实读者都必须等, 且等待要有界、要如实报"等到没有"。
 */
export async function waitForManifest(
  store: OrbitDBStore,
  group: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ manifest: ShardManifest; waitedMs: number; complete: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const pollMs = opts.pollMs ?? 250;
  const t0 = Date.now();
  for (;;) {
    const m = await readManifest(store, group);
    if (m.shards.length > 0) return { manifest: m, waitedMs: Date.now() - t0, complete: true };
    if (Date.now() - t0 >= timeoutMs) return { manifest: m, waitedMs: Date.now() - t0, complete: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 只读 manifest: 1 个 key ⇒ 与新节点的历史长度无关 */
export async function readManifest(store: OrbitDBStore, group: string): Promise<ShardManifest> {
  const raw = (await store.get('manifest')) as ShardManifest | null | undefined;
  if (raw && raw.v === 1 && Array.isArray(raw.shards)) return raw;
  return { v: 1, group, shards: [], updatedAt: 0 };
}

/**
 * 追加一条事件: 写进最后一片; 满了就开新片并把 manifest 指过去。
 * 调用方需先把 manifest store 打开 (keyvalue) — 见 openGroupShards()。
 */
export async function appendEvent(
  db: { openStore(name: string, type: 'keyvalue' | 'events', opts?: { accessController?: { write: string[] } }): Promise<OrbitDBStore> },
  manifestStore: OrbitDBStore,
  group: string,
  event: unknown,
  now = Date.now(),
  policy?: ShardWritePolicy,
): Promise<{ shard: ShardInfo; address: string; index: number }> {
  const manifest = await readManifest(manifestStore, group);
  const openShardByName = (name: string) => cached(name, () => db.openStore(name, 'events', aclOf(policy)));

  /** 片真实长度: 首次对齐后用缓存自增 */
  const lenOf = async (store: OrbitDBStore, name: string): Promise<number> => {
    if (!countCache.has(name)) countCache.set(name, (await store.all()).length);
    return countCache.get(name)!;
  };

  let last = manifest.shards[manifest.shards.length - 1];
  if (!last) {
    const name = shardStoreName(group, 0);
    const store = await openShardByName(name);
    countCache.set(name, 0);
    last = { index: 0, name, address: store.address, count: 0, fromTs: now, toTs: now };
    manifest.shards.push(last);
    manifest.updatedAt = now;
    await manifestStore.put('manifest', JSON.parse(JSON.stringify(manifest)));
  }

  let store = await openShardByName(last.name);
  let len = await lenOf(store, last.name);
  if (len >= SHARD_SIZE) {
    // 轮转: 开新片 + **这时才落盘 manifest** (每 SHARD_SIZE 条一次 ⇒ manifest oplog 是 O(片数))
    const index = last.index + 1;
    const name = shardStoreName(group, index);
    const st = await openShardByName(name);
    countCache.set(name, 0);
    last = { index, name, address: st.address, count: 0, fromTs: now, toTs: now };
    manifest.shards.push(last);
    manifest.updatedAt = now;
    await manifestStore.put('manifest', JSON.parse(JSON.stringify(manifest)));
    store = st;
    len = 0;
  }

  await store.add(event);
  countCache.set(last.name, len + 1);
  last.count = len + 1;
  last.toTs = now;
  return { shard: last, address: last.address, index: len };
}

/** 列出各片 (只读 manifest, **不打开任何片**) */
export async function listShards(manifestStore: OrbitDBStore, group: string): Promise<ShardInfo[]> {
  return (await readManifest(manifestStore, group)).shards;
}

/**
 * 读尾部: 只打开**最后一片** (或不含给定片号的最后一片)。
 * 这就是"打开成本不随总历史增长"的落点。
 */
export async function readTail(
  db: { openStoreByAddress(address: string, type: 'keyvalue' | 'events', opts?: { replica?: boolean; accessController?: { write: string[] } }): Promise<OrbitDBStore | null> },
  manifestStore: OrbitDBStore,
  group: string,
  opts: { skipShards?: number; waitMs?: number; pollMs?: number; settleMs?: number; policy?: ShardWritePolicy } = {},
): Promise<{ entries: Array<{ key: string; value: unknown }>; shard: ShardInfo | null; openedShards: number; waitedMs: number; complete: boolean }> {
  const shards = await listShards(manifestStore, group);
  const skip = opts.skipShards ?? 0;
  const target = shards[shards.length - 1 - skip] ?? null;
  if (!target) return { entries: [], shard: null, openedShards: 0, waitedMs: 0, complete: false };
  const store = await cached(`addr:${target.address}`, async () => {
    const st = await db.openStoreByAddress(target.address, 'events', aclOf(opts.policy));
    if (!st) throw new Error(`分片 ${target.index} 打不开 (${target.address})`);
    return st;
  });
  // 同样是有界等待: 只等**这一片** (片大小有上界 ⇒ 等待时间有上界, 与总历史无关)
  const timeoutMs = opts.waitMs ?? 60000;
  const pollMs = opts.pollMs ?? 250;
  const settleMs = opts.settleMs ?? 2000;   // 连续这么久没有新条目 ⇒ 认为这片同步完了
  const t0 = Date.now();
  let lastCount = -1, lastGrowthAt = Date.now();
  for (;;) {
    const entries = await store.all();
    if (entries.length !== lastCount) { lastCount = entries.length; lastGrowthAt = Date.now(); }
    const settled = lastCount > 0 && Date.now() - lastGrowthAt >= settleMs;
    if (settled) return { entries, shard: target, openedShards: 1, waitedMs: Date.now() - t0, complete: true };
    if (Date.now() - t0 >= timeoutMs) return { entries, shard: target, openedShards: 1, waitedMs: Date.now() - t0, complete: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 按需打开某个旧片 (要读历史时才付它的代价) */
export async function openShard(
  db: { openStore(name: string, type: 'keyvalue' | 'events', opts?: { accessController?: { write: string[] } }): Promise<OrbitDBStore> },
  group: string,
  index: number,
  policy?: ShardWritePolicy,
): Promise<OrbitDBStore> {
  const name = shardStoreName(group, index);
  return cached(name, () => db.openStore(name, 'events', aclOf(policy)));
}
