/**
 * cid-database.ts — 统一 CID 数据库层: CIDDatabase 接口 + OrbitDBAdapter (2026-08-06)
 *
 * 数据模型 (用户设计):
 *   {
 *     id: CID,            // 内容寻址 CID (dag-cbor encode + sha2-256, 内容不变 CID 不变)
 *     agentId: string,
 *     timestamp: number,
 *     type: "memory" | "context" | "state" | "ui" | "knowledge",
 *     content: object,
 *     metadata: object,
 *     version: number,    // 版本号 (update 递增)
 *     parentId?: string   // 上一版本 CID (版本链)
 *   }
 *
 * 存储:
 *   - OrbitDB keyvalue store (持久化 ~/.bolloon/orbitdb/, 数据库名 bolloon-cid-store)
 *   - key = record.id (CID), 支持 save/load/update/version/list/share
 *   - CID 用 multiformats 本地计算 (不依赖 helia dag API), share() 时才把块放入 helia
 */

import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';
import { concat as uint8Concat } from 'uint8arrays/concat';
import { createOrbitDB, type OrbitDB, type KeyValue } from '@orbitdb/core';
import * as orbitdbCoreNs from '@orbitdb/core';

/**
 * 运行时取 `IPFSAccessController` (2026-09-24)。
 *
 * 它在运行时是**真具名导出** (`@orbitdb/core` 4.0.0 `src/index.js:26`, 经
 * `./access-controllers/index.js` 二级再导出), 但该包是**纯 JS 包**: `package.json`
 * 既无 `types` 也无 `exports`、包内没有任何 `.d.ts` —— TS7 从 JS 推断导出集时看不见
 * 这个二级再导出, `import { IPFSAccessController }` 直接 TS2305。
 * 所以从命名空间按需取一次并显式收窄到已知形状; 不给整个模块上 `any`
 * (createOrbitDB / OrbitDB / KeyValue 仍照旧受类型检查)。
 */
const IPFSAccessController = (orbitdbCoreNs as unknown as {
  IPFSAccessController: (opts?: { write?: string[] }) => unknown;
}).IPFSAccessController;
import { createBolloonIpfs, type BolloonIpfs } from './ipfs-node.js';
import * as path from 'path';
import * as os from 'os';

export type CIDRecordType = 'memory' | 'context' | 'state' | 'ui' | 'knowledge';

/**
 * store 打不开 (地址不可解析 / 区块不在本地且没有 block broker 能去网上取)。
 *
 * 2026-09-24: 原来 `openStoreByAddress` 失败返回 null, 上游 (gateway-group) 把它当"空群",
 * 于是"读不到"被显示成"没有消息"。改成**抛**: 打不开 ≠ 没内容。
 */
export class OrbitDBStoreUnreachableError extends Error {
  readonly code = 'STORE_UNREACHABLE';
  constructor(readonly address: string, readonly cause?: unknown, readonly dataDir?: string) {
    const why = String((cause as Error)?.message ?? cause ?? '未知原因').slice(0, 200);
    super(`store 不可达 (${address}): ${why}`);
    this.name = 'OrbitDBStoreUnreachableError';
  }
}

export interface CIDRecord {
  id: string;            // CID (dag-cbor 内容寻址)
  agentId: string;
  timestamp: number;
  type: CIDRecordType;
  content: unknown;
  metadata: Record<string, unknown>;
  version: number;
  parentId?: string;
  dbAddress?: string;
}

export interface SaveOptions {
  agentId: string;
  type: CIDRecordType;
  content: unknown;
  metadata?: Record<string, unknown>;
}

export interface CIDDatabase {
  /** 保存一条记录 → 返回完整记录 (含内容寻址 CID) */
  save(data: SaveOptions): Promise<CIDRecord>;
  /** 按 CID 加载记录 (先查 OrbitDB KV, 找不到再尝试从 helia 网络拉块解码) */
  load(cid: string): Promise<CIDRecord | null>;
  /** 更新记录 → 生成新版本 (parentId 指向旧 CID) */
  update(cid: string, content: unknown, metadata?: Record<string, unknown>): Promise<CIDRecord | null>;
  /** 版本链 (从旧到新) */
  version(cid: string): Promise<CIDRecord[]>;
  /** 列出记录 (可按 agentId/type 过滤) */
  list(filter?: { agentId?: string; type?: CIDRecordType }): Promise<CIDRecord[]>;
  /** 分享: 把记录块放入 helia blockstore (可被网络拉取), 返回可分享标识 */
  share(cid: string): Promise<string>;
  /**
   * 2026-08-08: 在同一 OrbitDB 实例上打开附加 store (事件流 / 轨迹库等)。
   * 与 bolloon-cid-store 共享同一 helia 节点 + OrbitDB 实例 (单例, 不重复建节点)。
   * type: 'keyvalue' | 'events' — events 是 append-only 事件流 (WAL 复制用).
   */
  openStore(name: string, type?: 'keyvalue' | 'events', opts?: { accessController?: { write: string[] } }): Promise<OrbitDBStore>;
  /**
   * 2026-08-14: 按地址打开远端 store (共享网络 / 复制副本 / 群组)。
   *
   * `replica` (2026-09-24 修正既有错述): **不是 OrbitDB 的选项**。
   * `@orbitdb/core` 4.0.0 的 `open(address, {...})` 参数表里没有 `replica` (src/orbitdb.js:118),
   * 传了会被丢 —— 旧注释写的"replica=true 只读副本不写回"从来不是它的行为。
   * 真正的读/写闸门是 manifest 里的 ACL: `canAppend` 按 write 列表判定
   * (access-controllers/ipfs.js:78-87), **只读调用方本来就不 `put`**。
   * 参数保留 (gateway-group 等既有调用点仍传), 但不再冒充 OrbitDB 选项、不再往下传。
   *
   * `opts.accessController.write` **只对新建 store 生效**; 传的是**合法已存在地址**时
   * `@orbitdb/core` 会从 manifest 里取回 ACL 并**覆盖**入参 (src/orbitdb.js:129-131)
   * —— 即已有群的写权限是**建群时就烧进 manifest** 的, 事后改不了。
   *
   * 2026-09-24: 打开失败**抛 `OrbitDBStoreUnreachableError`** (不再返回 null)。
   * 返回 null 会让上游把"打不开"当成"空群/空列表" —— 那是把"读不到"伪装成"没有内容"。
   * (返回类型保留 `| null` 只为兼容测试替身; 真实现永不返回 null。)
   */
  openStoreByAddress(address: string, type?: 'keyvalue' | 'events', opts?: { replica?: boolean; accessController?: { write: string[] } }): Promise<OrbitDBStore | null>;
  /** 关闭数据库 */
  close(): Promise<void>;
  /** 底层 OrbitDB 实例 (调试/高级用) */
  readonly orbitdb?: OrbitDB;
}

/** 打开的附加 store 的通用最小接口 (keyvalue / events 共用) */
export interface OrbitDBStore {
  readonly address: string;
  /** keyvalue: put; events: add(值) — 统一写入口 */
  put(key: string, value: unknown): Promise<void>;
  /** events: append 一个值 (key 参数忽略) */
  add(value: unknown): Promise<void>;
  /** 全量读取: [{key, value}] (events 的 key=hash, value=payload) */
  all(): Promise<Array<{ key: string; value: unknown }>>;
  /** keyvalue: 读单键 */
  get(key: string): Promise<unknown>;
  /** 订阅底层变更 (join/write/replicate), 返回退订函数 */
  onChange(fn: () => void): () => void;
}

/** 内容 → CID (dag-cbor, sha2-256, codec 0x71); 先 JSON 清洗 (dag-cbor 不支持 undefined) */
export async function contentToCid(obj: unknown): Promise<string> {
  const cleaned = JSON.parse(JSON.stringify(obj)) as unknown; // 丢弃 undefined 字段
  const bytes = dagCbor.encode(cleaned);
  const hash = await sha256.digest(bytes);
  return CID.createV1(0x71, hash).toString();
}

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

/**
 * OrbitDB 身份在 keystore 里的槽名 (2026-09-24)。
 * 固定槽名 = 同一 dataDir 下每个进程读到**同一对密钥 / 同一个身份**。
 * 不固定 (@orbitdb/core 默认 createId() 随机 32 位) 会让每个进程变成新写入者,
 * 于是 `canAppend` 拿新身份去比对老 manifest 的 write 列表 → 一律拒绝。
 */
const ORBITDB_IDENTITY_ID = 'bolloon';

/**
 * `opts.accessController.write` → OrbitDB v4 的大写 `AccessController` 工厂 (2026-09-24)。
 *
 * @orbitdb/core v4 的 `open(address, options)` **只认大写 `AccessController`** (一个构造函数),
 * 小写 `accessController: { write: [...] }` 会被静默丢弃 → 新 store 落回默认策略
 * (`IPFSAccessController`: `write = write || [创建者身份 id]`, 即创建者独占写)。
 * 于是 gateway-group 一直传的 `write:['*']` (「群成员可广播」) **从来没生效过**。
 * 这里把已成文的选项接上; 对已存在的地址, manifest 里的 AC 仍优先 (这里不改变既有群)。
 */
function accessControllerOption(opts?: { accessController?: { write: string[] } }): Record<string, unknown> {
  const write = opts?.accessController?.write;
  return Array.isArray(write) && write.length ? { AccessController: IPFSAccessController({ write }) } : {};
}

/**
 * OrbitDB 后端实现。单例: 同一进程只建一个 (helia/OrbitDB 都是重量级节点)。
 */
export class OrbitDBAdapter implements CIDDatabase {
  private node: BolloonIpfs | null = null;
  private db: KeyValue | null = null;
  private _orbitdb: OrbitDB | null = null;
  readonly orbitdb: OrbitDB | undefined;

  constructor(readonly dataDir: string = path.join(home(), '.bolloon', 'orbitdb')) {}

  /** 落盘位置 (未初始化时 null; 诊断/验收用) */
  get ipfsPaths(): BolloonIpfs['paths'] | null {
    return this.node?.paths ?? null;
  }

  /** 懒初始化: 首次使用时启动 helia + OrbitDB + 打开 keyvalue store */
  private async ensure(): Promise<void> {
    if (this.db) return;
    this.node = await createBolloonIpfs(path.join(this.dataDir, 'ipfs'));
    // 2026-09-24: 身份必须**跨进程稳定**。不给 id 时 @orbitdb/core 用 createId()
    // (32 位随机串) 当 keystore 槽名 (src/orbitdb.js:43 `id = id || await createId()`
    // → :61 `createIdentity({ id })`) → 每个进程一对新密钥 → 新身份 → 写自己的 store
    // 会被访问控制拒掉 ("Key … is not allowed to write to the log")。
    // 给固定槽名后, 密钥从 <dataDir>/stores/keystore 读出复用 → 同 dataDir 同身份。
    // 类型注: `id` 是 @orbitdb/core 的真选项 (src/orbitdb.js:33), 但 TS7 从 JS 推断出的
    // 参数类型漏了它 → 显式取 Parameters<typeof createOrbitDB>[0] 再补 { id }
    // (不裸 any 掉整个入参)。
    const init: Parameters<typeof createOrbitDB>[0] & { id?: string } = {
      ipfs: this.node.helia as any,
      directory: path.join(this.dataDir, 'stores'),
      id: ORBITDB_IDENTITY_ID,
    };
    this._orbitdb = await createOrbitDB(init);
    this.db = await this._orbitdb.open('bolloon-cid-store', { type: 'keyvalue' });
    // 共享底层实例 (只读暴露)
    (this as any).orbitdb = this._orbitdb;
  }

  async save(data: SaveOptions): Promise<CIDRecord> {
    await this.ensure();
    // 内容寻址: CID 只基于业务内容 (agentId/type/content), 不含时间戳/版本 → 同内容同 CID
    const record: CIDRecord = {
      id: await contentToCid({ agentId: data.agentId, type: data.type, content: data.content }),
      agentId: data.agentId,
      timestamp: Date.now(),
      type: data.type,
      content: data.content,
      metadata: data.metadata ?? {},
      version: 1,
      dbAddress: this.db!.address,
    };
    // OrbitDB 用 dag-cbor 编码 value, 不支持 undefined 字段 → put 前 JSON 清洗
    await this.db!.put(record.id, JSON.parse(JSON.stringify(record)));
    return record;
  }

  async load(cid: string): Promise<CIDRecord | null> {
    await this.ensure();
    const rec = await this.db!.get(cid);
    if (rec) return rec as unknown as CIDRecord;
    // KV 无 → 尝试从 helia 拉块 (网络分享的 CID)
    try {
      const stream = this.node!.helia.blockstore.get(CID.parse(cid)) as unknown as AsyncIterable<Uint8Array>;
      let bytes = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
      for await (const chunk of stream) bytes = uint8Concat([bytes, chunk as Uint8Array<ArrayBuffer>]) as Uint8Array<ArrayBuffer>;
      return dagCbor.decode(bytes as any) as unknown as CIDRecord;
    } catch {
      return null;
    }
  }

  async update(cid: string, content: unknown, metadata?: Record<string, unknown>): Promise<CIDRecord | null> {
    await this.ensure();
    const old = await this.load(cid);
    if (!old) return null;
    const record: CIDRecord = {
      id: await contentToCid({ agentId: old.agentId, type: old.type, content }),
      agentId: old.agentId,
      timestamp: Date.now(),
      type: old.type,
      content,
      metadata: metadata ?? old.metadata,
      version: old.version + 1,
      parentId: old.id,
      dbAddress: this.db!.address,
    };
    await this.db!.put(record.id, JSON.parse(JSON.stringify(record)));
    return record;
  }

  async version(cid: string): Promise<CIDRecord[]> {
    await this.ensure();
    const chain: CIDRecord[] = [];
    let cur = await this.load(cid);
    // 从目标 CID 往回找最老, 再正序返回
    const rev: CIDRecord[] = [];
    let guard = 0;
    while (cur && guard++ < 1000) {
      rev.push(cur);
      cur = cur.parentId ? await this.load(cur.parentId) : null;
    }
    return rev.reverse();
  }

  async list(filter?: { agentId?: string; type?: CIDRecordType }): Promise<CIDRecord[]> {
    await this.ensure();
    // OrbitDB keyvalue.all() 返回 [{ key, value, hash }] 数组
    const all = (await this.db!.all()) as unknown as Array<{ key: string; value: unknown; hash: string }>;
    const records = all.map(e => e.value as unknown as CIDRecord);
    return records
      .filter(r => {
        if (!r || typeof r !== 'object') return false;
        if (filter?.agentId && r.agentId !== filter.agentId) return false;
        if (filter?.type && r.type !== filter.type) return false;
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async share(cid: string): Promise<string> {
    await this.ensure();
    const rec = await this.load(cid);
    if (!rec) throw new Error(`记录不存在: ${cid}`);
    // 把记录块写入 helia blockstore, 供网络 peers 通过 DHT 拉取
    await this.node!.helia.blockstore.put(CID.parse(rec.id), dagCbor.encode(rec));
    return `bolloon-cid://${rec.id}`;
  }

  /** 打开 store 的通用适配 (keyvalue/events 统一成 OrbitDBStore) */
  private wrapStore(raw: any): OrbitDBStore {
    return {
      address: raw.address,
      put: async (key, value) => { await raw.put(key, JSON.parse(JSON.stringify(value))); },
      add: async (value) => { await raw.add(JSON.parse(JSON.stringify(value))); },
      all: async () => {
        const entries = (await raw.all()) as Array<Record<string, unknown>>;
        // events store 的 all() 返回 { hash, payload } — 统一成 { key, value }
        return entries.map(e => ({
          key: String(e.key ?? e.hash ?? ''),
          value: e.payload !== undefined ? e.payload : e.value,
        }));
      },
      get: async (key) => { return (await raw.get(key)) as unknown; },
      onChange: (fn) => {
        const on = () => { try { fn(); } catch { /* 回调异常忽略 */ } };
        (raw.events as any)?.on?.('join', on);
        (raw.events as any)?.on?.('write', on);
        (raw.events as any)?.on?.('replicate', on);
        return () => {
          try {
            (raw.events as any)?.off?.('join', on);
            (raw.events as any)?.off?.('write', on);
            (raw.events as any)?.off?.('replicate', on);
          } catch { /* 忽略 */ }
        };
      },
    };
  }

  /**
   * 2026-08-08: 在同一 OrbitDB 实例上打开附加 store。
   * events 类型 = append-only 事件流 (WAL 复制 / 轨迹流用).
   * opts.accessController: 群组用 write:['*'] (任何人可写).
   */
  async openStore(name: string, type: 'keyvalue' | 'events' = 'keyvalue', opts?: { accessController?: { write: string[] } }): Promise<OrbitDBStore> {
    await this.ensure();
    const options: any = { type, ...accessControllerOption(opts) };
    const raw = (await this._orbitdb!.open(name, options)) as any;
    return this.wrapStore(raw);
  }

  /**
   * 2026-08-14: 按地址打开远端 store (Agent Gateway 共享网络 / 群组)。
   *
   * 2026-09-24: 失败改为**抛 OrbitDBStoreUnreachableError** (含原始错误原因),
   * 不再 `console.warn` + return null —— 那让"整个群读不到"在上层显示成"群里没有消息"。
   *
   * 2026-09-24 (修正既有错述): **不再往 OrbitDB 传 `replica`** ——
   * `@orbitdb/core` 4.0.0 的 `open()` 参数表里没有它 (src/orbitdb.js:118), 传了也被丢,
   * 之前的"replica=true 只读副本"是**不存在的语义**(等于什么都没做)。入参保留以兼容
   * 既有调用点, 但不再冒充 OrbitDB 选项。可写与否由 manifest 里的 ACL + 调用方是否 `put` 决定。
   * `opts.accessController` 在**打开既有地址**时同样不生效 (见接口注释: AC 由 manifest 决定)。
   */
  async openStoreByAddress(address: string, type: 'keyvalue' | 'events' = 'keyvalue', opts?: { replica?: boolean; accessController?: { write: string[] } }): Promise<OrbitDBStore | null> {
    await this.ensure();
    try {
      const options: any = { type, ...accessControllerOption(opts) };
      const raw = (await this._orbitdb!.open(address, options)) as any;
      return this.wrapStore(raw);
    } catch (err) {
      // 大声失败: 带上地址 + 原始原因 (最常见: "No block brokers capable of retrieving blocks ...")
      throw new OrbitDBStoreUnreachableError(address, err, this.dataDir);
    }
  }

  async close(): Promise<void> {
    try { await this._orbitdb?.stop(); } catch { /* 忽略 */ }
    try { await this.node?.stop(); } catch { /* 忽略 */ }
    this.db = null;
    this._orbitdb = null;
    this.node = null;
  }
}

/** 单例访问 (server/CLI 共享) */
let _adapter: OrbitDBAdapter | null = null;
export function getCIDDatabase(): CIDDatabase {
  if (!_adapter) _adapter = new OrbitDBAdapter();
  return _adapter;
}
