/**
 * chain-index-query.ts — 链上索引的**只读查询接口** (P5, ③)
 * =========================================================================
 * 只做四件事, 全部是**读已落盘索引**, 不发任何 RPC、不写盘、不签名:
 *   ① 按 taskKey 查 escrow 时间线      → getEscrowTimeline(taskKey)
 *   ② 按 cursor(区块号+logIndex) 增量拉取 → fetchIndexSince(cursor, {limit})
 *   ③ 全量统计 (tasks/released/refunded/disputed/expired) → getIndexStats()
 *   ④ 当前索引高度 + 最后同步时间      → getIndexStatus()
 *
 * 为什么单独一个文件: 网页/工具/别的进程都可能要读, 而**读不该需要 RPC**。
 * 这里构造的 ChainIndexer 一律是只读模式 (deploymentBlock 显式给 0, 不查 manifest),
 * 真去读链会明确报 'chain_index_readonly' —— 不静默返回空。
 */

import { ChainIndexer, chainIndexPath, deriveEscrowState, byBlockLogIndex, type ChainIndexEntry, type ChainIndexFile, type ChainIndexIdentity } from './chain-indexer.js';
import { DEFAULT_CONFIRMATIONS } from './chain-config.js';

export interface IndexQueryOptions {
  home?: string;
  /** 直接给索引文件路径 (测试/多链并用) */
  indexPath?: string;
}

let overridePath: string | null = null;

/** 测试/嵌入用: 把索引文件路径钉死 (null = 恢复默认 ~/.bolloon/chain/index.json) */
export function setChainIndexPathForTesting(p: string | null): void {
  overridePath = p;
}
export function currentIndexPath(home?: string): string {
  return overridePath || chainIndexPath(home);
}

/** 只读模式的 indexer (故意不查 manifest: 查索引不需要知道部署块) */
function readonlyIndexer(opts: IndexQueryOptions = {}): ChainIndexer {
  const p = currentIndexPath(opts.home);
  return new ChainIndexer({
    // 只读: 给个占位 provider, 真调链会抛 chain_index_readonly
    provider: {
      async getBlockNumber(): Promise<number> { throw new Error('chain_index_readonly: 只读查询不发 RPC'); },
      async getBlock(): Promise<null> { throw new Error('chain_index_readonly: 只读查询不发 RPC'); },
      async getLogs(): Promise<any[]> { throw new Error('chain_index_readonly: 只读查询不发 RPC'); },
    },
    escrowAddress: '0x' + '00'.repeat(20),
    deploymentBlock: 0,
    deploymentSource: 'readonly-query (不需要起点)',
    home: opts.home,
    indexPath: p,
    confirmations: DEFAULT_CONFIRMATIONS,
  });
}

/** 读索引文件 (没有 → 空索引, 不假装有) */
export function readIndexFile(opts: IndexQueryOptions = {}): ChainIndexFile {
  return readonlyIndexer(opts).load();
}

export interface IndexStatus {
  indexPath: string;
  chainId: number;
  networkName: string;
  escrowAddress: string;
  deploymentBlock: number;
  deploymentSource: string;
  /** ★ 落盘身份 (chainId + escrowAddress + deploymentBlock) —— 「这份索引属于哪次部署」的唯一口径 */
  identity: ChainIndexIdentity;
  lastSyncedBlock: number;
  lastSyncedAt: number | null;
  lastSyncedAgoMs: number | null;
  headBlock: number | null;
  headBlockHash: string | null;
  entries: number;
  suspects: number;
  confirmations: { confirmed: number; finalized: number };
  pageSize: number;
  reorgDepth: number;
  rebuiltAt: number | null;
  updatedAt: number;
  /** 索引落后 head 多少块 (读盘快照的 head, 不是链当前 head) */
  lagFromSnapshot: number | null;
}

/** ④ 当前索引高度 + 最后同步时间 */
export function getIndexStatus(opts: IndexQueryOptions = {}): IndexStatus {
  const s = readIndexFile(opts);
  return {
    indexPath: currentIndexPath(opts.home),
    chainId: s.chainId, networkName: s.networkName,
    escrowAddress: s.escrowAddress, deploymentBlock: s.deploymentBlock, deploymentSource: s.deploymentSource,
    identity: s.identity ?? { chainId: s.chainId, escrowAddress: s.escrowAddress.toLowerCase(), deploymentBlock: s.deploymentBlock },
    lastSyncedBlock: s.lastSyncedBlock, lastSyncedAt: s.lastSyncedAt,
    lastSyncedAgoMs: s.lastSyncedAt == null ? null : Date.now() - s.lastSyncedAt,
    headBlock: s.headBlock, headBlockHash: s.headBlockHash,
    entries: s.entries.length, suspects: s.entries.filter((e) => e.suspect).length,
    confirmations: s.confirmations, pageSize: s.pageSize, reorgDepth: s.reorgDepth,
    rebuiltAt: s.rebuiltAt ?? null, updatedAt: s.updatedAt,
    lagFromSnapshot: s.headBlock == null ? null : Math.max(0, s.headBlock - (s.lastSyncedBlock + 1)),
  };
}

export interface IndexStats {
  entries: number;
  suspects: number;
  tasks: number;
  created: number;
  proofSubmitted: number;
  released: number;
  refunded: number;
  disputed: number;
  expired: number;
  byFinality: { observed: number; confirmed: number; finalized: number };
  byEvent: Record<string, number>;
  lastSyncedBlock: number;
  lastSyncedAt: number | null;
  headBlock: number | null;
  deploymentBlock: number;
  chainId: number;
  escrowAddress: string;
}

/** ③ 全量统计。suspect (被回退) 的记录**不计入**业务计数, 但单独报出来。 */
export function getIndexStats(opts: IndexQueryOptions = {}): IndexStats {
  const s = readIndexFile(opts);
  const live = s.entries.filter((e) => !e.suspect);
  const byEvent: Record<string, number> = {};
  for (const e of live) byEvent[e.eventName] = (byEvent[e.eventName] || 0) + 1;
  const byFinality = { observed: 0, confirmed: 0, finalized: 0 };
  for (const e of s.entries) byFinality[e.finality]++;
  const n = (name: string) => live.filter((e) => e.eventName === name).length;
  return {
    entries: s.entries.length,
    suspects: s.entries.filter((e) => e.suspect).length,
    tasks: new Set(live.filter((e) => e.eventName === 'EscrowCreatedV2').map((e) => e.taskKey.toLowerCase())).size,
    created: n('EscrowCreatedV2'),
    proofSubmitted: n('ProofSubmittedV2'),
    released: n('ReleasedV2'),
    refunded: n('RefundedV2'),
    disputed: n('DisputedV2'),
    expired: n('ExpiredV2'),
    byFinality, byEvent,
    lastSyncedBlock: s.lastSyncedBlock, lastSyncedAt: s.lastSyncedAt, headBlock: s.headBlock,
    deploymentBlock: s.deploymentBlock, chainId: s.chainId, escrowAddress: s.escrowAddress,
  };
}

export interface EscrowTimelineItem {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  eventName: string;
  args: Record<string, string>;
  confirmations: number;
  finality: string;
  suspect: boolean;
  suspectReason?: string;
}

export interface EscrowTimeline {
  taskKey: string;
  /** 从事件推出的状态 (只按事件推, 不读链) */
  state: string | null;
  events: EscrowTimelineItem[];
  count: number;
  /** 时间线里有没有被回退 (suspect) 的记录 */
  hasSuspect: boolean;
}

const slim = (e: ChainIndexEntry): EscrowTimelineItem => ({
  blockNumber: e.blockNumber, blockHash: e.blockHash, txHash: e.txHash, logIndex: e.logIndex,
  eventName: e.eventName, args: e.args, confirmations: e.confirmations, finality: e.finality,
  suspect: e.suspect, suspectReason: e.suspectReason,
});

/** ① 按 taskKey 查 escrow 时间线 (块号 + logIndex 升序) */
export function getEscrowTimeline(taskKey: string, opts: IndexQueryOptions = {}): EscrowTimeline {
  const key = String(taskKey || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) {
    // 非法 taskKey 不硬搜: 直接空时间线 + 明确说明 (路由层会回 400)
    return { taskKey: key, state: null, events: [], count: 0, hasSuspect: false };
  }
  const events = readIndexFile(opts).entries
    .filter((e) => e.taskKey.toLowerCase() === key)
    .sort(byBlockLogIndex);
  return {
    taskKey: key,
    state: deriveEscrowState(events),
    events: events.map(slim),
    count: events.length,
    hasSuspect: events.some((e) => e.suspect),
  };
}

export interface IndexCursor { blockNumber: number; logIndex: number }

export interface IndexPage {
  events: EscrowTimelineItem[];
  nextCursor: IndexCursor | null;
  hasMore: boolean;
  /** 剩余待拉条数 (含本页) */
  remaining: number;
  cursor: IndexCursor | null;
  limit: number;
}

/** ② 按 cursor 增量拉取 (严格大于 cursor 的 (blockNumber, logIndex)) */
export function fetchIndexSince(cursor: IndexCursor | null, opts: IndexQueryOptions & { limit?: number } = {}): IndexPage {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)));
  const all = readIndexFile(opts).entries
    .filter((e) => {
      if (!cursor) return true;
      const cb = Number(cursor.blockNumber), cl = Number(cursor.logIndex);
      return e.blockNumber > cb || (e.blockNumber === cb && e.logIndex > cl);
    })
    .sort(byBlockLogIndex);
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map(slim),
    nextCursor: last ? { blockNumber: last.blockNumber, logIndex: last.logIndex } : (cursor ?? null),
    hasMore: all.length > page.length,
    remaining: all.length,
    cursor: cursor ?? null,
    limit,
  };
}

// 索引目录/路径的唯一出口在 chain-indexer.ts (chainIndexDir / chainIndexPath) —— 这里不重复导出,
// 否则 index.ts 的 `export *` 会出现同名歧义 (ESM 下歧义名会被静默丢掉)。

