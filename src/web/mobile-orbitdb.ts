/**
 * mobile-orbitdb.ts — 手机端原生 OrbitDB (2026-10-07)
 *
 * 之前手机端只有「电脑端副本同步」(mobile-orbit.ts 的拉/推 merge)。
 * 本模块让手机端**真的跑一个 OrbitDB 实例**: 复用 mobile-helia 创建的真 helia IPFS 节点
 * (有 PeerID/bitswap), 用 @orbitdb/core 的浏览器安全配置 (MemoryStorage 注入, 无 Node fs)。
 *
 * 能力:
 *   - createMobileOrbitDB(): 建/取 OrbitDB 实例 (幂等, 绑定真 helia 节点)
 *   - openStore(name, type): 打开 kvstore / documents / eventlog (type: 'keyvalue'|'documents'|'events')
 *   - put / get / del / all (kvstore), query (documents)
 *   - 与桌面互通: store 地址是 orbitdb:// 形式, 桌面节点可 dial 同一地址 (经 IPFS pubsub)
 *
 * 浏览器安全边界:
 *   - 不用 Node fs: KeyStore/日志全用 MemoryStorage (前台内存; 重启后从桌面/网络重新同步)
 *   - 依赖动态 import: @orbitdb/core 的 browser bundle (webpack UMD) 只在真的用时加载
 *   - 不假装持久化: 手机是「前台参与节点」, 数据持久靠 IPFS 网络 (块在 bitswap 网络里)
 */
import type { MobileHeliaNode } from './mobile-helia.js';

let _orbit: any = null;
let _node: MobileHeliaNode | null = null;

/** 当前 OrbitDB 实例 (null = 未创建) */
export function getMobileOrbitDB(): any { return _orbit; }

/** 当前绑定的 helia 节点 (null = 未创建) */
export function getMobileOrbitNode(): MobileHeliaNode | null { return _node; }

/** 测试用: 重置实例 (不 stop 节点, 由调用方管) */
export function resetMobileOrbitDB(): void {
  _orbit = null;
  _node = null;
}

/**
 * 创建手机端 OrbitDB (幂等)。
 * 需要带 pubsub (gossipsub) 的 helia 节点 —— OrbitDB 4.x 的同步协议靠
 * ipfs.libp2p.services.pubsub.addEventListener/subscribe。
 * 不带 pubsub 的节点 (SDK 默认只启 identify) → open store 会抛
 * "Cannot read properties of undefined (reading 'addEventListener')"。
 * @returns { ok, orbit?, error? }
 */
export async function createMobileOrbitDB(node?: MobileHeliaNode | null): Promise<{ ok: boolean; orbit?: any; error?: string }> {
  if (_orbit) return { ok: true, orbit: _orbit };
  try {
    const activeNode = node ?? _node ?? null;
    if (!activeNode) return { ok: false, error: '需要 helia 节点 (先 startMobileHelia)' };
    _node = activeNode;

    // 动态 import @orbitdb/core (browser bundle; 避免顶层拖慢首屏)
    const orbitMod = await import('@orbitdb/core');
    // @orbitdb/core 的 browser bundle 类型导出不稳定 → 显式收成 any (运行时仍是同一函数)
    const createOrbitDB: any = (orbitMod as any).default ?? (orbitMod as any).createOrbitDB;
    if (typeof createOrbitDB !== 'function') return { ok: false, error: '@orbitdb/core 没有 createOrbitDB 导出' };

    // 用 MemoryStorage (浏览器无 fs) — KeyStore/日志都在内存
    const orbit = await createOrbitDB({
      ipfs: activeNode as any,
      // 浏览器安全: 全部内存, 不落盘 (真持久化靠 IPFS 网络)
      directory: undefined as any,
    });
    _orbit = orbit;
    return { ok: true, orbit };
  } catch (e: any) {
    return { ok: false, error: `创建 OrbitDB 失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/**
 * 用带 pubsub 的节点创建 OrbitDB。
 * 内部: 若当前节点没有 services.pubsub, 则用 mobile-helia 高级路径 (libp2pOptions + gossipsub)
 * 重建一个, 替换当前节点。返回重建结果。
 */
export async function createMobileOrbitDBWithPubsub(
  heliaMod?: typeof import('./mobile-helia.js'),
): Promise<{ ok: boolean; orbit?: any; node?: MobileHeliaNode | null; error?: string }> {
  try {
    const mh = heliaMod || (await import('./mobile-helia.js'));
    // 先试现有节点 (可能已有 pubsub)
    if (_node) {
      const hasPubsub = !!((_node as any)?.libp2p?.services?.pubsub);
      if (hasPubsub) {
        const r = await createMobileOrbitDB(_node);
        return { ok: r.ok, orbit: r.orbit, node: _node, error: r.error };
      }
    }
    // 没有 pubsub → 用 gossipsub 重建节点 (高级路径)
    // 注意: buildCustomHelia 的 services 是 identify+ping(+dht), libp2pOptions 整体展开会覆盖 services
    // → 必须带上 identify/ping 一起, 否则 circuit-relay transport 报 UnmetServiceDependenciesError
    const { gossipsub } = await import('@libp2p/gossipsub');
    const { identify } = await import('@libp2p/identify');
    const { ping } = await import('@libp2p/ping');
    const nodeR = await mh.createMobileHeliaNode({
      libp2pOptions: {
        services: {
          identify: identify(), ping: ping(),
          // allowPublishToZeroPeers: 单节点/刚启动时没有对端订阅也允许发布 (OrbitDB 4.x 同步需要);
          // emitSelf: 自己发布的也回放给自己 (本地 store 一致性)
          pubsub: gossipsub({ emitSelf: false, allowPublishToZeroTopicPeers: true }),
        },
      },
    });
    if (!nodeR.ok || !nodeR.node) return { ok: false, error: nodeR.error || '重建带 pubsub 的节点失败' };
    const r = await createMobileOrbitDB(nodeR.node);
    return { ok: r.ok, orbit: r.orbit, node: nodeR.node, error: r.error };
  } catch (e: any) {
    return { ok: false, error: `创建带 pubsub 的 OrbitDB 失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 打开 store (type: 'keyvalue' | 'documents' | 'events') */
export async function openStore(
  name: string,
  type: 'keyvalue' | 'documents' | 'events' = 'keyvalue',
  options: Record<string, unknown> = {},
): Promise<{ ok: boolean; store?: any; error?: string }> {
  try {
    if (!_orbit) {
      const r = await createMobileOrbitDB();
      if (!r.ok) return { ok: false, error: r.error };
    }
    const store = await _orbit.open(String(name || ''), { type, ...options });
    return { ok: true, store };
  } catch (e: any) {
    return { ok: false, error: `打开 store 失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** kvstore: put */
export async function kvPut(store: any, key: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
  try { await store.put(String(key), value); return { ok: true }; }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

/** kvstore: get */
export async function kvGet(store: any, key: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  try { return { ok: true, value: await store.get(String(key)) }; }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

/** kvstore: del */
export async function kvDel(store: any, key: string): Promise<{ ok: boolean; error?: string }> {
  try { await store.del(String(key)); return { ok: true }; }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

/** kvstore: 全部条目 */
export async function kvAll(store: any): Promise<{ ok: boolean; entries?: Record<string, unknown>; error?: string }> {
  try {
    // @orbitdb/core 4.x kvstore: all() 返回 [{key, value, hash}] 数组
    let all: Record<string, unknown> = {};
    if (typeof store.all === 'function') {
      const rows = (await store.all()) || [];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r && r.key !== undefined) all[String(r.key)] = r.value;
        }
      } else if (typeof rows === 'object') {
        all = rows as Record<string, unknown>;
      }
    } else if (store.iterator) {
      for (const [k, v] of (await store.iterator().collect())) {
        if (k !== undefined) all[String(k)] = v;
      }
    }
    return { ok: true, entries: all };
  } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

/** documents: 按索引查 (query(fn) — @orbitdb/core 4.x documents 的正确 API; indexBy 在 open 时声明) */
export async function docQuery(store: any, query: Record<string, unknown> | ((doc: any) => boolean)): Promise<{ ok: boolean; results?: unknown[]; error?: string }> {
  try {
    let r: unknown;
    if (typeof query === 'function') {
      r = await store.query(query);
    } else if (query && typeof query === 'object') {
      // 对象查询 → 转成匹配所有键值的函数 (与 indexBy 字段匹配)
      const keys = Object.keys(query);
      r = await store.query((doc: any) => keys.every((k) => doc?.[k] === (query as any)[k]));
    } else {
      r = await store.get(String(query ?? ''));
    }
    return { ok: true, results: Array.isArray(r) ? r : (r ? [r] : []) };
  } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

/** 关闭实例 (保留 helia 节点) */
export async function stopMobileOrbitDB(): Promise<{ ok: boolean }> {
  try {
    if (_orbit) await _orbit.stop();
    _orbit = null;
    return { ok: true };
  } catch { _orbit = null; return { ok: true }; }
}
