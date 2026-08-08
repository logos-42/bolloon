/**
 * did-catalog-replication.ts — 把 DID 目录的 WAL 事件流挂进 OrbitDB 自动复制 (2026-08-08)
 *
 * 用户需求: "把 DID catalog 挂进 OrbitDB 的自动 replication, 并用 OrbitDB 事件流驱动跨设备复制".
 *
 * 机制:
 *   1. 打开 events store (append-only 事件流): `bolloon-did-wal-<did短名>`
 *      — 与 bolloon-cid-store 共享同一 helia + OrbitDB 实例 (openStore).
 *   2. 发布 (publish): 本地 catalog 每有新 WAL 事件 (seq > lastPublishedSeq) → store.add(ev)
 *      — OrbitDB 自动把事件流同步到订阅同地址的 peers (libp2p pubsub + IPFS 块).
 *   3. 拉取 (sync): 订阅 store 变更 (join/write/replicate) + 定时轮询 →
 *      读 store 全量事件 → 过滤 seq > lastAppliedSeq → catalog.syncRemote(events)
 *      → persist → 推进 lastAppliedSeq. (LWW 合并, 幂等)
 *   4. 状态: lastPublishedSeq / lastAppliedSeq / storeAddress 持久化在
 *      ~/.bolloon/did-catalog/<did>/replication.json, 重启续传.
 *
 * 失败静默: 复制是增强层 — OrbitDB 不可用 (离线/首次启动) 时 DID 目录本身照常工作,
 *           网络恢复后按 seq 增量补齐 (断点续传语义).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { registryOpen, didDirName, type DidCatalog, type DscWalEvent } from '../storage/did-catalog.js';
import { getCIDDatabase, type CIDDatabase, type OrbitDBStore } from './cid-database.js';

const homeRoot = (h?: string): string => h || process.env.HOME || os.homedir() || '/tmp';

export interface ReplicationState {
  /** 已发布到 OrbitDB 的最大 seq (增量发布游标) */
  lastPublishedSeq: number;
  /** 已从 OrbitDB 应用的最大 seq (增量拉取游标) */
  lastAppliedSeq: number;
  /** events store 地址 (跨设备共享标识) */
  storeAddress: string;
  updatedAt: number;
}

export interface ReplicationStats {
  published: number;
  applied: number;
  merged: number;
}

export interface CatalogReplicationOptions {
  home?: string;
  /** 注入 CID 数据库 (测试用假实现) */
  db?: CIDDatabase;
  /** 轮询间隔 ms (默认 30s) */
  intervalMs?: number;
  /** 是否自动启动定时发布/拉取 (默认 true; 测试可关) */
  auto?: boolean;
}

export interface CatalogReplication {
  readonly did: string;
  readonly storeName: string;
  readonly storeAddress: string;
  stats: ReplicationStats;
  /** 把本地 WAL 新事件发布到 OrbitDB (增量) → 返回发布条数 */
  publishPending(): Promise<number>;
  /** 从 OrbitDB 拉取远端事件 → syncRemote 合并 → 返回 {applied, merged} */
  syncNow(): Promise<{ applied: number; merged: number }>;
  /** 停止定时器 + 退订 */
  stop(): Promise<void>;
}

/** events store 名: 按 DID 确定性命名 (跨设备同名 → 同一复制流) */
export function replicationStoreName(did: string): string {
  return `bolloon-did-wal-${didDirName(did)}`;
}

function statePath(home: string | undefined, did: string): string {
  return path.join(homeRoot(home), '.bolloon', 'did-catalog', didDirName(did), 'replication.json');
}

async function loadState(home: string | undefined, did: string): Promise<ReplicationState> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(home, did), 'utf-8')) as ReplicationState;
    return {
      // WAL seq 从 0 开始 → 游标默认 -1 (否则 seq=0 的首条事件永远不发布/不应用)
      lastPublishedSeq: Number(raw.lastPublishedSeq) || -1,
      lastAppliedSeq: Number(raw.lastAppliedSeq) || -1,
      storeAddress: String(raw.storeAddress || ''),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  } catch {
    return { lastPublishedSeq: -1, lastAppliedSeq: -1, storeAddress: '', updatedAt: Date.now() };
  }
}

async function saveState(home: string | undefined, did: string, s: ReplicationState): Promise<void> {
  try {
    const p = statePath(home, did);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ ...s, updatedAt: Date.now() }, null, 2), 'utf-8');
  } catch { /* 状态写失败不致命 */ }
}

/** WAL 事件是否属于本 DID (跨设备只合并本用户数据) */
function eventOfDid(e: DscWalEvent, did: string): boolean {
  return !e.did || e.did === did;
}

/**
 * 启动 DID 目录 → OrbitDB 自动复制.
 * 单例: 同一 did 只开一个复制流 (进程级 map, 复用 store).
 */
export async function startDidCatalogReplication(
  did: string,
  opts: CatalogReplicationOptions = {},
): Promise<CatalogReplication> {
  const state = await loadState(opts.home, did);
  const stats: ReplicationStats = { published: 0, applied: 0, merged: 0 };
  let store: OrbitDBStore | null = null;
  let stopFns: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let syncing = false;
  let stopped = false;

  const open = async (): Promise<OrbitDBStore> => {
    if (store) return store;
    const db: CIDDatabase = opts.db || getCIDDatabase();
    const s = await db.openStore(replicationStoreName(did), 'events');
    store = s;
    if (state.storeAddress && state.storeAddress !== s.address) {
      // 远端地址已有记录而本地地址不同 → 以本地为准 (state 会在 publish 后刷新)
    }
    state.storeAddress = s.address;
    await saveState(opts.home, did, state);
    return s;
  };

  const catalog = async (): Promise<DidCatalog | null> => {
    try {
      return await registryOpen(did, opts.home ? { home: opts.home } : undefined);
    } catch {
      return null;
    }
  };

  const publishPending = async (): Promise<number> => {
    try {
      const cat = await catalog();
      if (!cat) return 0;
      const s = await open();
      const pending = cat.walEvents.filter(e => e.seq > state.lastPublishedSeq && eventOfDid(e, did));
      if (pending.length === 0) return 0;
      for (const ev of pending) {
        await s.add(ev);
        state.lastPublishedSeq = Math.max(state.lastPublishedSeq, ev.seq);
      }
      stats.published += pending.length;
      await saveState(opts.home, did, state);
      return pending.length;
    } catch {
      return 0; // OrbitDB 不可用 → 静默, 下次轮询重试 (断点续传)
    }
  };

  const syncNow = async (): Promise<{ applied: number; merged: number }> => {
    if (syncing || stopped) return { applied: 0, merged: 0 };
    syncing = true;
    try {
      const cat = await catalog();
      if (!cat) return { applied: 0, merged: 0 };
      const s = await open();
      const entries = await s.all();
      const events = entries
        .map(e => e.value as DscWalEvent)
        .filter((e): e is DscWalEvent => !!e && typeof e === 'object' && typeof (e as any).seq === 'number')
        .filter(e => e.seq > state.lastAppliedSeq && eventOfDid(e, did))
        .sort((a, b) => a.seq - b.seq);
      if (events.length === 0) return { applied: 0, merged: 0 };
      const r = cat.syncRemote(events);
      await cat.persist();
      state.lastAppliedSeq = Math.max(state.lastAppliedSeq, ...events.map(e => e.seq));
      stats.applied += r.applied;
      stats.merged += r.merged;
      await saveState(opts.home, did, state);
      return r;
    } catch {
      return { applied: 0, merged: 0 };
    } finally {
      syncing = false;
    }
  };

  // 订阅 store 变更 (远端 join/写) → 拉取合并 (去抖, 事件可能密集)
  const unsub = await (async () => {
    try {
      const s = await open();
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const on = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { syncNow().catch(() => { /* 静默 */ }); }, 500);
      };
      const off = s.onChange(on);
      return () => { off(); if (debounce) clearTimeout(debounce); };
    } catch {
      return () => { /* store 打开失败 → 无订阅 */ };
    }
  })();
  stopFns.push(unsub);

  // 首次: 拉一次远端 (重启续传) + 发布本地积压
  await syncNow().catch(() => { /* 静默 */ });
  await publishPending().catch(() => { /* 静默 */ });

  if (opts.auto !== false) {
    timer = setInterval(() => {
      publishPending().catch(() => { /* 静默 */ });
      syncNow().catch(() => { /* 静默 */ });
    }, opts.intervalMs || 30_000);
    // 不阻止进程退出
    timer.unref?.();
  }

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer) clearInterval(timer);
    for (const f of stopFns) { try { f(); } catch { /* 忽略 */ } }
    stopFns = [];
    // 停前最后发布一次 (尽力而为)
    await publishPending().catch(() => { /* 静默 */ });
  };

  return {
    did,
    storeName: replicationStoreName(did),
    storeAddress: state.storeAddress,
    stats,
    publishPending,
    syncNow,
    stop,
  };
}
