/**
 * chain-indexer.ts — AgentEscrow 链上事件索引器 (P5: 链上索引器)
 * =========================================================================
 * 干什么: 把 AgentEscrow 的 **v2 事件** (5 个 + F2b 的 ExpiredV2) 从**部署区块**
 *   开始逐块扫进本机一个可重启、可对账的索引文件, 并提供只读查询底座。
 *
 * 六条硬约束 (每一条都能被验收脚本证伪):
 *   ① 起点来自**部署 manifest 的 deployment block**, 不硬编码
 *      (env BOLLOON_ESCROW_DEPLOYMENT_BLOCK → contracts/deployments/*.json 按
 *       chainId + 地址匹配 → 报错; 找不到就抛, 不猜 0)。
 *   ② 分页 eth_getLogs: 每次 to-from+1 ≤ pageSize (env BOLLOON_INDEX_PAGE_SIZE);
 *      provider 报 "range 太大" 时**自动对半拆**再试, 不静默漏页。
 *   ③ 增量: 记 `lastSyncedBlock`, 重启从它 +1 继续, 默认**不重扫** [deploymentBlock, lastSyncedBlock]。
 *   ④ 去重: 键 = `txHash:logIndex` (小写). 同一键永远只有一条; 幂等重跑 0 重复。
 *   ⑤ 重组: 拿已记的 head blockHash / recentBlocks 父哈希链跟当前链比对 →
 *      找到分叉点 → **回退** [fork+1, head] 区间并重扫; 被回退的记录标 `suspect=true`
 *      并保留 (不静默丢弃); 重扫时若日志重新出现 → 复位 suspect 并记 history。
 *   ⑥ 全量重建: `rebuild()` 无视 lastSyncedBlock 从 deploymentBlock 重扫一遍,
 *      与增量结果逐条比对 (compareIndexes) —— 不一致就说不一样, 不粉饰。
 *
 * 落盘: `~/.bolloon/chain/index.json` (原子写: tmp + rename; 每 N 页 checkpoint)。
 * 确认数分层 (门槛来自 chain-config 的配置: confirmed=1 / finalized=12):
 *   finality = 'finalized' (≥finalized) | 'confirmed' (≥confirmed) | 'observed'
 *   被回退 (suspect) 的记录一律降为 'observed' —— 它只是"曾在链上被观测到"。
 *
 * 本模块**只读链** (eth_getLogs / eth_getBlockByNumber), 不签名、不发交易、不碰私钥。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Interface } from 'ethers';
import {
  AGENT_ESCROW_V2_ABI,
  V2_EVENT_NAMES,
  createJsonRpcProvider,
  type V2EventName,
} from './escrow-client.js';
import {
  DEFAULT_CONFIRMATIONS,
  bolloonHome,
  deploymentsDir,
  type ChainConfirmations,
  type ChainConfig,
} from './chain-config.js';

export const CHAIN_INDEX_SCHEMA_VERSION = 2;

/** 索引器认的 v2 事件 = P3 的 5 个 + F2b 新增的 ExpiredV2 (逐字对齐 contracts/deployments/abis/AgentEscrow.json) */
export const EXPIRED_V2_EVENT_SIG =
  'event ExpiredV2(bytes32 indexed taskKey, address indexed caller, address indexed refundedTo, uint256 amount)';

export const INDEXED_EVENT_NAMES: readonly string[] = Object.freeze([...V2_EVENT_NAMES, 'ExpiredV2']);

export const INDEX_IFACE = new Interface([
  ...(AGENT_ESCROW_V2_ABI as unknown as string[]),
  EXPIRED_V2_EVENT_SIG,
]);

export type IndexFinality = 'observed' | 'confirmed' | 'finalized';

export interface ChainIndexHistoryNote {
  at: number;
  note: string;
  blockNumber?: number;
  blockHash?: string;
}

export interface ChainIndexEntry {
  /** 去重键 = `${txHash.toLowerCase()}:${logIndex}` */
  key: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number | null;
  logIndex: number;
  address: string;
  eventName: string;
  /** EscrowCreatedV2/ProofSubmittedV2/... 的 taskKey (indexed topic1) */
  taskKey: string;
  /** 解码后的 args (bigint → 十进制字符串; JSON 安全) */
  args: Record<string, string>;
  /** 同步当时的确认数 = headBlock - blockNumber + 1 */
  confirmations: number;
  finality: IndexFinality;
  /** 被回退 / 链上已消失 → true (保留记录, 不当没发生) */
  suspect: boolean;
  suspectReason?: string;
  firstSeenAt: number;
  updatedAt: number;
  history: ChainIndexHistoryNote[];
}

export interface ChainIndexRun {
  at: number;
  mode: 'sync' | 'rebuild';
  /** 调用方给的起点 (没给 = 增量) */
  requestedFrom: number | null;
  /** 实际扫的第一块 (重组回退 / 增量断点决定) */
  scanFrom: number;
  scanTo: number;
  pages: number;
  ranges: Array<{ from: number; to: number }>;
  blocksScanned: number;
  logsFound: number;
  inserted: number;
  deduped: number;
  restored: number;
  /** 本轮被标 suspect 的条数 (回退导致) */
  markedSuspect: number;
  /** 回退到的分叉点 (没重组 = null) */
  rewoundTo: number | null;
  headBlock: number;
  headBlockHash: string;
  durationMs: number;
  note?: string;
}

export interface ChainIndexFile {
  schemaVersion: number;
  chainId: number;
  networkName: string;
  escrowAddress: string;
  /** ★ manifest 里的部署区块 (索引起点) */
  deploymentBlock: number;
  deploymentSource: string;
  /** ★ 已完整扫过的高度; -1 = 从未同步 */
  lastSyncedBlock: number;
  lastSyncedAt: number | null;
  headBlock: number | null;
  headBlockHash: string | null;
  confirmations: ChainConfirmations;
  pageSize: number;
  reorgDepth: number;
  entries: ChainIndexEntry[];
  /** 最近若干块的 (number, hash, parentHash) —— 父哈希链比对用 */
  recentBlocks: Array<{ number: number; hash: string; parentHash: string }>;
  runs: ChainIndexRun[];
  rebuiltAt?: number;
  updatedAt: number;
}

export interface ChainSyncResult {
  mode: 'sync';
  requestedFrom: number | null;
  scanFrom: number;
  scanTo: number;
  pages: number;
  ranges: Array<{ from: number; to: number }>;
  blocksScanned: number;
  logsFound: number;
  inserted: number;
  deduped: number;
  restored: number;
  markedSuspect: number;
  rewoundTo: number | null;
  /** 回退后没能重新扫到 (仍 suspect) 的键 */
  orphans: string[];
  headBlock: number;
  headBlockHash: string;
  lastSyncedBlock: number;
  entries: number;
  suspects: number;
  durationMs: number;
  resynced: boolean;
}

export interface IndexComparison {
  same: boolean;
  countA: number;
  countB: number;
  missingInB: string[];
  extraInB: string[];
  mismatched: Array<{ key: string; field: string; a: unknown; b: unknown }>;
}

export interface ChainRebuildResult {
  mode: 'rebuild';
  pages: number;
  ranges: Array<{ from: number; to: number }>;
  blocksScanned: number;
  logsFound: number;
  entries: number;
  headBlock: number;
  comparison: IndexComparison;
  durationMs: number;
  persisted: boolean;
}

// ── 路径 ────────────────────────────────────────────────────────────────────

export function chainIndexDir(home?: string): string {
  return path.join(bolloonHome(home), 'chain');
}
export function chainIndexPath(home?: string): string {
  return path.join(chainIndexDir(home), 'index.json');
}

// ── 部署 manifest → deployment block (不硬编码) ───────────────────────────────

export interface DeploymentInfo {
  chainId: number;
  networkName: string;
  escrowAddress: string;
  deploymentBlock: number;
  source: string;
  manifestPath?: string;
}

export interface ResolveDeploymentOptions {
  chainId?: number;
  escrowAddress?: string;
  networkName?: string;
  deploymentsDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class ChainIndexError extends Error {
  constructor(message: string, public readonly missing: string[] = []) {
    super(message);
    this.name = 'ChainIndexError';
  }
}

/** 只读模式下的占位 provider: 只有真去调链时才报错, 查已落盘索引不受影响 */
const NO_RPC: IndexRpcProvider = {
  async getBlockNumber(): Promise<number> { throw new ChainIndexError('ChainIndexer 处于只读模式 (没给 provider/rpcUrl), 不能读链', ['rpcUrl']); },
  async getBlock(): Promise<null> { throw new ChainIndexError('ChainIndexer 处于只读模式 (没给 provider/rpcUrl), 不能读链', ['rpcUrl']); },
  async getLogs(): Promise<any[]> { throw new ChainIndexError('ChainIndexer 处于只读模式 (没给 provider/rpcUrl), 不能读链', ['rpcUrl']); },
};

export function defaultDeploymentsDir(): string {
  // 与 chain-config 的 manifest 层**同一份**目录口径 (env BOLLOON_DEPLOYMENTS_DIR 优先,
  // 其次从 cwd 往上找 contracts/deployments) —— 两处各写一遍就会给出两个答案。
  return deploymentsDir(process.env);
}

/**
 * 从部署 manifest 里读 **deployment block**。优先级:
 *   ① env BOLLOON_ESCROW_DEPLOYMENT_BLOCK / BOLLOON_INDEX_FROM_BLOCK
 *   ② contracts/deployments/*.json 里 chainId + AgentEscrow 地址都匹配的那份
 *   ③ 抛错 (不猜 0 —— 从 0 开始扫会白扫几十万块, 还会把假起点写进索引)
 */
export function resolveDeploymentInfo(opts: ResolveDeploymentOptions = {}): DeploymentInfo {
  const env = opts.env || process.env;
  const dir = opts.deploymentsDir || defaultDeploymentsDir();
  const wantAddr = (opts.escrowAddress || env.BOLLOON_ESCROW_ADDRESS || '').toLowerCase();
  const wantChain = opts.chainId ?? (env.BOLLOON_CHAIN_ID ? Number(env.BOLLOON_CHAIN_ID) : undefined);

  const envBlock = env.BOLLOON_ESCROW_DEPLOYMENT_BLOCK || env.BOLLOON_INDEX_FROM_BLOCK;
  const envBlockNum = envBlock && Number.isInteger(Number(envBlock)) && Number(envBlock) >= 0 ? Number(envBlock) : null;

  // ① env 显式给起点
  if (envBlockNum !== null) {
    return {
      chainId: wantChain ?? 0,
      networkName: opts.networkName || env.BOLLOON_NETWORK_NAME || 'unknown',
      escrowAddress: opts.escrowAddress || env.BOLLOON_ESCROW_ADDRESS || '',
      deploymentBlock: envBlockNum,
      source: env.BOLLOON_ESCROW_DEPLOYMENT_BLOCK ? 'env BOLLOON_ESCROW_DEPLOYMENT_BLOCK' : 'env BOLLOON_INDEX_FROM_BLOCK',
    };
  }

  // ② manifest
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    throw new ChainIndexError(
      `读不到部署 manifest 目录: ${dir} (设 BOLLOON_DEPLOYMENTS_DIR, 或给 deploymentBlock / env BOLLOON_INDEX_FROM_BLOCK)`,
      ['deploymentBlock'],
    );
  }
  const near: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let m: any;
    try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const escrow = (m?.contracts || []).find((c: any) => c?.name === 'AgentEscrow');
    if (!escrow) continue;
    const addrOk = !wantAddr || String(escrow.address).toLowerCase() === wantAddr;
    const chainOk = wantChain === undefined || Number(m.chainId) === Number(wantChain);
    if (addrOk && chainOk) {
      const blk = Number(escrow.blockNumber);
      if (!Number.isInteger(blk) || blk < 0) continue;
      // 多个匹配时取 deployment 最早的 (起点更保守, 不会漏)
      return {
        chainId: Number(m.chainId), networkName: String(m.networkName || opts.networkName || 'unknown'),
        escrowAddress: String(escrow.address), deploymentBlock: blk,
        source: `manifest ${path.relative(process.cwd(), p)} .contracts[AgentEscrow].blockNumber`,
        manifestPath: p,
      };
    }
    near.push(`${f}(chainId=${m?.chainId}, escrow=${escrow.address})`);
  }
  throw new ChainIndexError(
    `在 ${dir} 里找不到匹配的部署 manifest (want chainId=${wantChain ?? '?'} escrow=${wantAddr || '?'})。` +
    `已看到: ${near.join(', ') || '(无)'}。` +
    `索引起点必须来自 manifest 的 deployment block —— 拒绝猜。`,
    ['deploymentBlock'],
  );
}

// ── provider 窄接口 (可注入假链; 真链就是 JsonRpcProvider) ────────────────────

export interface IndexRpcProvider {
  getBlockNumber(): Promise<number>;
  getBlock(n: number | string): Promise<null | { number: number; hash: string; parentHash: string }>;
  getLogs(filter: {
    address?: string | string[];
    topics?: Array<string | string[] | null>;
    fromBlock?: number;
    toBlock?: number;
  }): Promise<any[]>;
}

export class ChainIndexer {
  readonly provider: IndexRpcProvider;
  readonly escrowAddress: string;
  readonly chainId: number;
  readonly networkName: string;
  readonly deploymentBlock: number;
  readonly deploymentSource: string;
  readonly confirmations: ChainConfirmations;
  readonly pageSize: number;
  readonly reorgDepth: number;
  readonly home?: string;
  /** 索引文件路径 (默认 ~/.bolloon/chain/index.json; 测试/多链并用可覆盖) */
  readonly indexPath: string;
  private readonly log: (m: string) => void;
  private readonly checkpointEvery: number;
  private destroyed = false;

  constructor(opts: {
    provider?: IndexRpcProvider;
    config?: ChainConfig;
    rpcUrl?: string;
    escrowAddress?: string;
    chainId?: number;
    networkName?: string;
    deploymentBlock?: number;
    deploymentSource?: string;
    deploymentsDir?: string;
    home?: string;
    pageSize?: number;
    reorgDepth?: number;
    checkpointEvery?: number;
    indexPath?: string;
    confirmations?: ChainConfirmations;
    log?: (m: string) => void;
  } = {}) {
    const env = process.env;
    const cfg = opts.config;
    const rpcUrl = opts.rpcUrl || cfg?.rpcUrl || '';
    const escrowAddress = opts.escrowAddress || cfg?.escrowAddress || env.BOLLOON_ESCROW_ADDRESS || '';
    this.chainId = opts.chainId ?? cfg?.chainId ?? (env.BOLLOON_CHAIN_ID ? Number(env.BOLLOON_CHAIN_ID) : 0);
    this.networkName = opts.networkName || cfg?.networkName || env.BOLLOON_NETWORK_NAME || 'unknown';
    this.escrowAddress = escrowAddress;
    this.confirmations = opts.confirmations || cfg?.confirmations || DEFAULT_CONFIRMATIONS;
    const envPage = Number(env.BOLLOON_INDEX_PAGE_SIZE);
    this.pageSize = Math.max(1, Math.floor(opts.pageSize ?? (Number.isInteger(envPage) && envPage > 0 ? envPage : 2000)));
    const envDepth = Number(env.BOLLOON_INDEX_REORG_DEPTH);
    this.reorgDepth = Math.max(1, Math.floor(opts.reorgDepth ?? (Number.isInteger(envDepth) && envDepth > 0 ? envDepth : 32)));
    this.checkpointEvery = Math.max(1, opts.checkpointEvery ?? 20);
    this.home = opts.home;
    this.indexPath = opts.indexPath || chainIndexPath(opts.home);
    this.log = opts.log || (() => { /* 静默 */ });

    if (opts.deploymentBlock != null) {
      if (!Number.isInteger(opts.deploymentBlock) || opts.deploymentBlock < 0) {
        throw new ChainIndexError(`deploymentBlock 非法: ${opts.deploymentBlock}`, ['deploymentBlock']);
      }
      this.deploymentBlock = opts.deploymentBlock;
      this.deploymentSource = opts.deploymentSource || '显式传入';
    } else {
      const info = resolveDeploymentInfo({
        chainId: this.chainId || undefined,
        escrowAddress: this.escrowAddress || undefined,
        networkName: this.networkName,
        deploymentsDir: opts.deploymentsDir,
      });
      this.deploymentBlock = info.deploymentBlock;
      this.deploymentSource = info.source;
      if (!this.escrowAddress) (this as any).escrowAddress = info.escrowAddress;
      if (!this.chainId) (this as any).chainId = info.chainId;
      if (this.networkName === 'unknown' && info.networkName) (this as any).networkName = info.networkName;
    }

    if (opts.provider) this.provider = opts.provider;
    else if (rpcUrl) this.provider = createJsonRpcProvider(rpcUrl) as unknown as IndexRpcProvider;
    else this.provider = NO_RPC; // 只读模式: 查已落盘索引不需要 RPC; 真调链时才报错
    if (!this.escrowAddress) throw new ChainIndexError('ChainIndexer: 缺 escrowAddress', ['escrowAddress']);
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { (this.provider as any).destroy?.(); } catch { /* noop */ }
  }

  // ── 落盘 ────────────────────────────────────────────────────────────────

  emptyIndex(): ChainIndexFile {
    return {
      schemaVersion: CHAIN_INDEX_SCHEMA_VERSION,
      chainId: this.chainId,
      networkName: this.networkName,
      escrowAddress: this.escrowAddress,
      deploymentBlock: this.deploymentBlock,
      deploymentSource: this.deploymentSource,
      lastSyncedBlock: this.deploymentBlock - 1,
      lastSyncedAt: null,
      headBlock: null,
      headBlockHash: null,
      confirmations: { ...this.confirmations },
      pageSize: this.pageSize,
      reorgDepth: this.reorgDepth,
      entries: [],
      recentBlocks: [],
      runs: [],
      updatedAt: Date.now(),
    };
  }

  load(): ChainIndexFile {
    const base = this.emptyIndex();
    const p = this.indexPath;
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return base; }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return base;
    const entries: ChainIndexEntry[] = [];
    const seen = new Set<string>();
    for (const e of raw.entries) {
      const key = String(e?.key || '');
      // 读盘路径也去重: 坏文件 / 手改文件里的重复键不许渗进来
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(this.normalizeEntry(e));
    }
    entries.sort(byBlockLogIndex);
    return {
      ...base,
      chainId: Number(raw.chainId) || base.chainId,
      networkName: String(raw.networkName || base.networkName),
      escrowAddress: String(raw.escrowAddress || base.escrowAddress),
      deploymentBlock: Number.isInteger(raw.deploymentBlock) ? Number(raw.deploymentBlock) : base.deploymentBlock,
      deploymentSource: String(raw.deploymentSource || base.deploymentSource),
      lastSyncedBlock: Number.isInteger(raw.lastSyncedBlock) ? Number(raw.lastSyncedBlock) : base.lastSyncedBlock,
      lastSyncedAt: raw.lastSyncedAt ?? null,
      headBlock: Number.isInteger(raw.headBlock) ? Number(raw.headBlock) : null,
      headBlockHash: raw.headBlockHash ?? null,
      confirmations: raw.confirmations?.confirmed ? {
        confirmed: Number(raw.confirmations.confirmed), finalized: Number(raw.confirmations.finalized),
      } : base.confirmations,
      pageSize: Number.isInteger(raw.pageSize) && raw.pageSize > 0 ? Number(raw.pageSize) : base.pageSize,
      reorgDepth: Number.isInteger(raw.reorgDepth) && raw.reorgDepth > 0 ? Number(raw.reorgDepth) : base.reorgDepth,
      entries,
      recentBlocks: Array.isArray(raw.recentBlocks)
        ? raw.recentBlocks.filter((b: any) => Number.isInteger(b?.number) && b?.hash).map((b: any) => ({ number: Number(b.number), hash: String(b.hash), parentHash: String(b.parentHash || '') }))
        : [],
      runs: Array.isArray(raw.runs) ? raw.runs.slice(-50) : [],
      rebuiltAt: raw.rebuiltAt ?? undefined,
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  private normalizeEntry(e: any): ChainIndexEntry {
    const txHash = String(e.txHash || '').toLowerCase();
    const logIndex = Number(e.logIndex) || 0;
    return {
      key: String(e.key || `${txHash}:${logIndex}`),
      blockNumber: Number(e.blockNumber) || 0,
      blockHash: String(e.blockHash || ''),
      txHash,
      txIndex: e.txIndex == null ? null : Number(e.txIndex),
      logIndex,
      address: String(e.address || this.escrowAddress),
      eventName: String(e.eventName || ''),
      taskKey: String(e.taskKey || ''),
      args: e.args && typeof e.args === 'object' ? { ...e.args } : {},
      confirmations: Number(e.confirmations) || 0,
      finality: (['observed', 'confirmed', 'finalized'].includes(e.finality) ? e.finality : 'observed') as IndexFinality,
      suspect: e.suspect === true,
      suspectReason: e.suspectReason,
      firstSeenAt: Number(e.firstSeenAt) || Date.now(),
      updatedAt: Number(e.updatedAt) || Date.now(),
      history: Array.isArray(e.history) ? e.history.slice(-20) : [],
    };
  }

  async save(state: ChainIndexFile): Promise<void> {
    const p = this.indexPath;
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    state.entries.sort(byBlockLogIndex);
    state.updatedAt = Date.now();
    state.runs = state.runs.slice(-50);
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(tmp, p);
  }

  // ── 链读取 ──────────────────────────────────────────────────────────────

  private async head(): Promise<{ number: number; hash: string; parentHash: string }> {
    const n = await this.provider.getBlockNumber();
    const b = await this.provider.getBlock(n);
    if (!b) throw new ChainIndexError(`读不到 head 区块 ${n} (RPC 异常)`);
    return { number: Number(b.number), hash: String(b.hash), parentHash: String(b.parentHash || '') };
  }

  private async blockAt(n: number): Promise<null | { number: number; hash: string; parentHash: string }> {
    const b = await this.provider.getBlock(n);
    if (!b) return null;
    return { number: Number(b.number), hash: String(b.hash), parentHash: String(b.parentHash || '') };
  }

  /**
   * 分页取日志。尊重 provider 的 block-range 限制:
   *   每页 ≤ pageSize; provider 报区间太大 → 对半拆再试 (自适应), 不静默跳过。
   */
  async fetchLogsRange(
    from: number,
    to: number,
    acc: { pages: number; ranges: Array<{ from: number; to: number }>; logs: any[]; halves: number },
    onPage?: (scannedTo: number, pages: number) => Promise<void>,
  ) {
    if (from > to) return;
    const topics = INDEXED_EVENT_NAMES.map((n) => {
      const frag = INDEX_IFACE.getEvent(n);
      if (!frag) throw new ChainIndexError(`本地 ABI 里没有事件 ${n}`);
      return String(frag.topicHash).toLowerCase();
    });
    const tryGet = async (a: number, b: number): Promise<any[] | null> => {
      try {
        return await this.provider.getLogs({
          address: this.escrowAddress,
          topics: [topics],
          fromBlock: a,
          toBlock: b,
        });
      } catch (e: any) {
        const msg = String(e?.shortMessage || e?.message || e);
        if (a === b) throw e;
        acc.halves++;
        this.log(`  ⚠ eth_getLogs(${a}-${b}) 失败 (${msg.slice(0, 90)}) → 对半拆`);
        const mid = Math.floor((a + b) / 2);
        const left = await tryGet(a, mid);
        const right = await tryGet(mid + 1, b);
        return [...(left || []), ...(right || [])];
      }
    };

    // 先按 pageSize 切; 单页失败再靠 tryGet 自适应对半拆
    for (let a = from; a <= to; a += this.pageSize) {
      const b = Math.min(a + this.pageSize - 1, to);
      const logs = await tryGet(a, b);
      acc.pages++;
      acc.ranges.push({ from: a, to: b });
      for (const l of logs || []) acc.logs.push(l);
      if (onPage) await onPage(b, acc.pages);
    }
  }

  // ── 解码 ────────────────────────────────────────────────────────────────

  private decodeLog(raw: any): { eventName: string; taskKey: string; args: Record<string, string> } | null {
    let parsed: any;
    try { parsed = INDEX_IFACE.parseLog({ topics: [...(raw.topics || [])], data: raw.data }); } catch { return null; }
    if (!parsed) return null;
    if (!INDEXED_EVENT_NAMES.includes(parsed.name)) return null;
    const args: Record<string, string> = {};
    parsed.fragment.inputs.forEach((inp: any, i: number) => {
      const v = parsed.args[i];
      args[inp.name] = typeof v === 'bigint' ? v.toString() : String(v);
    });
    const taskKey = String(parsed.args[0] ?? '').toLowerCase();
    return { eventName: parsed.name, taskKey, args };
  }

  finalityOf(confirmations: number, suspect: boolean): IndexFinality {
    if (suspect) return 'observed';
    if (confirmations >= this.confirmations.finalized) return 'finalized';
    if (confirmations >= this.confirmations.confirmed) return 'confirmed';
    return 'observed';
  }

  private refreshFinality(state: ChainIndexFile, headBlock: number): void {
    for (const e of state.entries) {
      const conf = headBlock - e.blockNumber + 1;
      e.confirmations = conf < 0 ? 0 : conf;
      e.finality = this.finalityOf(e.confirmations, e.suspect);
    }
  }

  private rememberBlock(state: ChainIndexFile, b: { number: number; hash: string; parentHash: string }): void {
    state.recentBlocks = state.recentBlocks.filter((x) => x.number !== b.number);
    state.recentBlocks.push(b);
    const min = Math.max(this.deploymentBlock - 1, b.number - 2 * this.reorgDepth);
    state.recentBlocks = state.recentBlocks.filter((x) => x.number >= min && x.number <= b.number).sort((x, y) => x.number - y.number);
  }

  /**
   * 记下 head 下面 `reorgDepth` 个块的哈希 —— 这是**分叉点能定准**的关键:
   * 只记 head 一个哈希的话, 重组时只能一路退到 deploymentBlock (浪费且不好解释)。
   * 代价 = 每次同步最多 reorgDepth 次 eth_getBlockByNumber (已记过的不重复取)。
   */
  private async rememberBlockWindow(state: ChainIndexFile, head: { number: number; hash: string; parentHash: string }): Promise<void> {
    this.rememberBlock(state, head);
    const have = new Set(state.recentBlocks.map((b) => b.number));
    const floor = Math.max(this.deploymentBlock - 1, head.number - this.reorgDepth);
    for (let n = head.number - 1; n >= floor; n--) {
      if (have.has(n)) continue;
      const b = await this.blockAt(n);
      if (!b) continue;
      state.recentBlocks.push(b);
    }
    const min = Math.max(this.deploymentBlock - 1, head.number - 2 * this.reorgDepth);
    state.recentBlocks = state.recentBlocks.filter((x) => x.number >= min && x.number <= head.number).sort((x, y) => x.number - y.number);
  }

  // ── 重组检测 ────────────────────────────────────────────────────────────

  /**
   * 父哈希链比对: 从已记高度往回找**分叉点** (第一个哈希仍然一致的块)。
   * 情况: ① 已记块号上的哈希变了 ② 已记块号在新链上没了 (rollback 后高度变低)
   *       ③ recentBlocks 里某块的 parentHash 对不上 → 都以"往回找第一个一致块"统一处理。
   * 找不到一致块 (超过 reorgDepth) → 回退到 deploymentBlock-1 (全量重扫), 如实标注 deep。
   */
  async detectReorg(state: ChainIndexFile, head: { number: number; hash: string; parentHash: string }): Promise<{
    reorged: boolean; forkPoint: number | null; reason?: string; checked: number;
  }> {
    if (state.headBlock == null || state.headBlockHash == null) return { reorged: false, forkPoint: null, checked: 0 };
    const recorded = new Map<number, string>();
    for (const b of state.recentBlocks) recorded.set(b.number, b.hash);
    if (state.headBlockHash) recorded.set(state.headBlock, state.headBlockHash);
    // 已入库事件所在的块也是锚点 (多一层: 就算 recentBlocks 被清空也能定准)
    for (const e of state.entries) if (e.blockHash) recorded.set(e.blockNumber, e.blockHash);

    const topRecorded = Math.max(...recorded.keys());
    const probeTop = Math.min(topRecorded, head.number);
    const probe = await this.blockAt(probeTop);
    if (probe && recorded.get(probeTop) && probe.hash === recorded.get(probeTop)) {
      // 已记最高块仍在同哈希上 (链变短的情况由 syncFrom 的"高于 head 的记录"分支处理)
      return { reorged: false, forkPoint: null, checked: 1 };
    }
    // 分歧: 往回走
    const floor = Math.max(this.deploymentBlock - 1, probeTop - this.reorgDepth);
    let checked = 0;
    for (let n = probeTop; n >= floor; n--) {
      checked++;
      const b = await this.blockAt(n);
      const rec = recorded.get(n);
      if (b && rec && b.hash === rec) {
        return { reorged: true, forkPoint: n, reason: `高度 ${probeTop} 的块哈希已变 (父哈希链分叉), 回退到同哈希块 ${n}`, checked };
      }
    }
    return {
      reorged: true,
      forkPoint: this.deploymentBlock - 1,
      reason: `超过 reorgDepth=${this.reorgDepth} 仍找不到一致的块 → 从 deploymentBlock 重扫`,
      checked,
    };
  }

  // ── 主流程: 增量同步 ────────────────────────────────────────────────────

  /**
   * 从 `deploymentBlock` (或已记高度 +1) 扫到 head。
   * @param fromBlock 显式起点 (手动补扫用); 不给 = 增量 (lastSyncedBlock+1)。低于 lastSyncedBlock 的补扫由去重保证不产生重复。
   */
  async syncFrom(fromBlock?: number): Promise<ChainSyncResult> {
    const t0 = Date.now();
    const state = this.load();
    const head = await this.head();

    // ① 重组检测 + 回退 (回退的记录**保留**, 标 suspect)
    const re = await this.detectReorg(state, head);
    let rewoundTo: number | null = null;
    const orphans: string[] = [];
    let markedSuspect = 0;
    // ①b 链比索引矮 (anvil_rollback / 快照回滚): 高于 head 的已入库日志在链上已不存在
    if (state.lastSyncedBlock > head.number || state.entries.some((e) => e.blockNumber > head.number)) {
      const gone = state.entries.filter((e) => e.blockNumber > head.number);
      for (const e of gone) {
        if (!e.suspect) {
          e.suspect = true;
          e.suspectReason = `链已回滚到 ${head.number} 块: 该日志 (块 ${e.blockNumber}) 在链上已不存在`;
          markedSuspect++;
        }
        e.history.push({ at: Date.now(), note: e.suspectReason! });
        e.updatedAt = Date.now();
        orphans.push(e.key);
      }
      state.lastSyncedBlock = Math.min(state.lastSyncedBlock, head.number);
      state.recentBlocks = state.recentBlocks.filter((b) => b.number <= head.number);
      if (gone.length) this.log(`  ⚠ 链高 ${head.number} < 索引高度: ${gone.length} 条记录所在块已消失 → 标 suspect (不删除)`);
    }
    if (re.reorged && re.forkPoint != null) {
      const fork = re.forkPoint;
      rewoundTo = fork;
      const affected = state.entries.filter((e) => e.blockNumber > fork);
      for (const e of affected) {
        if (!e.suspect) {
          e.suspect = true;
          e.suspectReason = `重组回退: ${re.reason}`;
          markedSuspect++;
        }
        e.history.push({ at: Date.now(), note: `回退 (suspect): ${re.reason}` });
        e.updatedAt = Date.now();
        orphans.push(e.key);
      }
      state.recentBlocks = state.recentBlocks.filter((b) => b.number <= fork);
      state.lastSyncedBlock = Math.min(state.lastSyncedBlock, fork);
      this.log(`  ⚠ 重组: ${re.reason}; 回退 ${affected.length} 条记录 (标 suspect, 不删除)`);
    }

    // ② 决定起点
    let scanFrom: number;
    if (rewoundTo != null) scanFrom = Math.max(rewoundTo + 1, state.deploymentBlock);
    else if (fromBlock != null) scanFrom = Math.max(fromBlock, state.deploymentBlock);
    else scanFrom = Math.max(state.lastSyncedBlock + 1, state.deploymentBlock);

    const scanTo = head.number;
    const acc = { pages: 0, ranges: [] as Array<{ from: number; to: number }>, logs: [] as any[], halves: 0 };

    // ③ 分页扫; checkpoint (每 checkpointEvery 页) 让重启能从已扫高度继续
    if (scanFrom <= scanTo) {
      await this.fetchLogsRange(scanFrom, scanTo, acc, async (scannedTo, pages) => {
        if (pages % this.checkpointEvery !== 0) return;
        state.lastSyncedBlock = Math.max(state.lastSyncedBlock, scannedTo);
        state.headBlock = head.number;
        state.headBlockHash = head.hash;
        this.refreshFinality(state, head.number);
        await this.save(state);
        this.log(`  ✓ checkpoint: lastSyncedBlock=${state.lastSyncedBlock} (${acc.logs.length} 条日志)`);
      });
    }

    // ④ 入库: 去重 (txHash:logIndex) + 重新出现 → 复位 suspect
    const byKey = new Map(state.entries.map((e) => [e.key, e]));
    let inserted = 0, deduped = 0, restored = 0;
    const touched = new Set<string>();
    for (const raw of acc.logs) {
      const txHash = String(raw?.transactionHash || '').toLowerCase();
      const logIndex = logIndexOf(raw);
      const blockNumber = Number(raw?.blockNumber);
      if (!/^0x[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(logIndex) || !Number.isInteger(blockNumber)) continue;
      const key = `${txHash}:${logIndex}`;
      if (touched.has(key)) { deduped++; continue; } // 同一次返回里重复 (不该有, 但也不许入库两次)
      touched.add(key);
      const dec = this.decodeLog(raw);
      if (!dec) continue;
      const blockHash = String(raw?.blockHash || '');
      const prev = byKey.get(key);
      if (prev && prev.blockHash === blockHash && raw?.removed !== true) {
        // 同块同哈希再次扫到: 正常情况是重复 → 去重; 但如果它被标过 suspect
        // (回退时整块消失、之后链又回到了同一块 —— 真链上 anvil_rollback + 重放会复现完全相同的块哈希),
        // 那就必须**复位 suspect**, 不能因为"哈希碰巧一样"就留着一个过期的可疑标记。
        if (prev.suspect) {
          prev.suspect = false;
          prev.suspectReason = undefined;
          prev.history.push({ at: Date.now(), note: `重新出现: 同块同哈希 (${blockNumber}/${blockHash.slice(0, 12)}…) 再次扫到 → 复位 suspect`, blockNumber, blockHash });
          prev.updatedAt = Date.now();
          restored++;
        } else deduped++;
        continue;
      }
      if (prev && raw?.removed !== true) {
        // 同一 txHash:logIndex 出现在**新的块**上 (重组后重新打包) → 更新事实并复位 suspect
        prev.blockNumber = blockNumber;
        prev.blockHash = blockHash;
        prev.txIndex = raw?.transactionIndex == null ? prev.txIndex : Number(raw.transactionIndex);
        prev.args = dec.args;
        prev.eventName = dec.eventName;
        prev.taskKey = dec.taskKey;
        if (prev.suspect) {
          prev.suspect = false;
          prev.suspectReason = undefined;
          prev.history.push({ at: Date.now(), note: `重新上链: 出现在新块 ${blockNumber} (哈希 ${blockHash.slice(0, 12)}…)`, blockNumber, blockHash });
          restored++;
        } else {
          prev.history.push({ at: Date.now(), note: `同键换块: ${prev.blockNumber} → ${blockNumber}`, blockNumber, blockHash });
        }
        prev.updatedAt = Date.now();
        continue;
      }
      if (prev && raw?.removed === true) {
        prev.suspect = true;
        prev.suspectReason = 'eth_getLogs 返回 removed=true (链已回滚该日志)';
        prev.history.push({ at: Date.now(), note: prev.suspectReason });
        prev.updatedAt = Date.now();
        continue;
      }
      const entry: ChainIndexEntry = {
        key, blockNumber, blockHash, txHash,
        txIndex: raw?.transactionIndex == null ? null : Number(raw.transactionIndex),
        logIndex,
        address: String(raw?.address || this.escrowAddress).toLowerCase(),
        eventName: dec.eventName,
        taskKey: dec.taskKey,
        args: dec.args,
        confirmations: 0,
        finality: 'observed',
        suspect: false,
        firstSeenAt: Date.now(),
        updatedAt: Date.now(),
        history: [{ at: Date.now(), note: `首次入库 (区块 ${blockNumber})`, blockNumber, blockHash }],
      };
      state.entries.push(entry);
      byKey.set(key, entry);
      inserted++;
    }

    // ⑤ 回退后没重新扫到的 (真消失了) → 仍 suspect, 明确记一笔
    const unresolved: string[] = [];
    if (rewoundTo != null) {
      for (const e of state.entries) {
        if (e.blockNumber > rewoundTo && e.suspect) {
          unresolved.push(e.key);
          if (!e.history.some((h) => h.note.includes('未再出现'))) {
            e.history.push({ at: Date.now(), note: `回退后重扫未再出现 (链上已无此日志) → 保持 suspect` });
          }
        }
      }
    }

    // ⑥ 收尾: 记高度 / head 哈希 / 确认数分层
    if (scanFrom <= scanTo) {
      state.lastSyncedBlock = Math.max(state.lastSyncedBlock, scanTo);
      state.lastSyncedAt = Date.now();
    }
    state.headBlock = head.number;
    state.headBlockHash = head.hash;
    await this.rememberBlockWindow(state, head);
    this.refreshFinality(state, head.number);
    // 落盘时记下这次用的配置 (读文件的人要知道 finality 是按哪个门槛算的)
    state.confirmations = { ...this.confirmations };
    state.pageSize = this.pageSize;
    state.reorgDepth = this.reorgDepth;
    const run: ChainIndexRun = {
      at: Date.now(), mode: 'sync',
      requestedFrom: fromBlock ?? null,
      scanFrom, scanTo,
      pages: acc.pages, ranges: acc.ranges,
      blocksScanned: scanFrom <= scanTo ? scanTo - scanFrom + 1 : 0,
      logsFound: acc.logs.length, inserted, deduped, restored, markedSuspect,
      rewoundTo, headBlock: head.number, headBlockHash: head.hash,
      durationMs: Date.now() - t0,
      note: acc.halves ? `自适应对半拆 ${acc.halves} 次` : undefined,
    };
    state.runs.push(run);
    await this.save(state);

    return {
      mode: 'sync', requestedFrom: fromBlock ?? null, scanFrom, scanTo,
      pages: acc.pages, ranges: acc.ranges, blocksScanned: run.blocksScanned,
      logsFound: acc.logs.length, inserted, deduped, restored, markedSuspect, rewoundTo,
      orphans: Array.from(new Set([...orphans, ...unresolved])),
      headBlock: head.number, headBlockHash: head.hash,
      lastSyncedBlock: state.lastSyncedBlock,
      entries: state.entries.length,
      suspects: state.entries.filter((e) => e.suspect).length,
      durationMs: run.durationMs,
      resynced: rewoundTo != null || (fromBlock != null && fromBlock < state.lastSyncedBlock),
    };
  }

  // ── 全量重建 ────────────────────────────────────────────────────────────

  /**
   * 无视 lastSyncedBlock, 从 deploymentBlock 全量重扫 (与增量走**同一条**扫码路径)。
   * 结果与现有增量索引逐条比对; `persist=true` 时用重建结果替换 entries
   * (已有的 suspect 记录若重建后仍不在链上 → 原样保留标 suspect, 不静默丢弃)。
   */
  async rebuild(opts: { persist?: boolean } = {}): Promise<ChainRebuildResult> {
    const t0 = Date.now();
    const state = this.load();
    const head = await this.head();
    const acc = { pages: 0, ranges: [] as Array<{ from: number; to: number }>, logs: [] as any[], halves: 0 };
    await this.fetchLogsRange(this.deploymentBlock, head.number, acc);

    const fresh: ChainIndexEntry[] = [];
    const seen = new Set<string>();
    for (const raw of acc.logs) {
      const txHash = String(raw?.transactionHash || '').toLowerCase();
      const logIndex = logIndexOf(raw);
      const blockNumber = Number(raw?.blockNumber);
      if (!/^0x[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(logIndex) || !Number.isInteger(blockNumber)) continue;
      const key = `${txHash}:${logIndex}`;
      if (seen.has(key)) continue;
      const dec = this.decodeLog(raw);
      if (!dec) continue;
      seen.add(key);
      const blockHash = String(raw?.blockHash || '');
      const conf = head.number - blockNumber + 1;
      fresh.push({
        key, blockNumber, blockHash, txHash,
        txIndex: raw?.transactionIndex == null ? null : Number(raw.transactionIndex),
        logIndex,
        address: String(raw?.address || this.escrowAddress).toLowerCase(),
        eventName: dec.eventName, taskKey: dec.taskKey, args: dec.args,
        confirmations: conf < 0 ? 0 : conf,
        finality: this.finalityOf(conf, false),
        suspect: false,
        firstSeenAt: Date.now(), updatedAt: Date.now(),
        history: [{ at: Date.now(), note: `全量重建 (区块 ${blockNumber})`, blockNumber, blockHash }],
      });
    }

    const comparison = compareIndexes(state.entries, fresh);

    if (opts.persist) {
      const rebuiltKeys = new Set(fresh.map((e) => e.key));
      // 审计留存: 旧的 suspect 记录若重建后不在链上 → 保留 (标 suspect, 说明原因)
      const carried = state.entries
        .filter((e) => e.suspect && !rebuiltKeys.has(e.key))
        .map((e) => ({
          ...e,
          suspect: true,
          suspectReason: e.suspectReason || '重建后链上已无此日志',
          history: [...e.history, { at: Date.now(), note: '全量重建: 链上已无此日志, 保留为 suspect 审计记录' }].slice(-20),
          updatedAt: Date.now(),
        }));
      const after: ChainIndexFile = {
        ...state,
        entries: [...fresh, ...carried],
        lastSyncedBlock: head.number,
        lastSyncedAt: Date.now(),
        headBlock: head.number,
        headBlockHash: head.hash,
        rebuiltAt: Date.now(),
        confirmations: { ...this.confirmations },
        pageSize: this.pageSize,
        reorgDepth: this.reorgDepth,
      };
      after.recentBlocks = [];
      await this.rememberBlockWindow(after, head);
      this.refreshFinality(after, head.number);
      after.runs.push({
        at: Date.now(), mode: 'rebuild', requestedFrom: this.deploymentBlock,
        scanFrom: this.deploymentBlock, scanTo: head.number, pages: acc.pages, ranges: acc.ranges,
        blocksScanned: head.number - this.deploymentBlock + 1, logsFound: acc.logs.length,
        inserted: fresh.length, deduped: acc.logs.length - fresh.length, restored: 0,
        markedSuspect: carried.length, rewoundTo: null, headBlock: head.number, headBlockHash: head.hash,
        durationMs: Date.now() - t0,
        note: `全量重建; 与增量比对: same=${comparison.same} (差 ${comparison.missingInB.length + comparison.extraInB.length + comparison.mismatched.length} 处)`,
      });
      await this.save(after);
    }

    return {
      mode: 'rebuild', pages: acc.pages, ranges: acc.ranges,
      blocksScanned: head.number - this.deploymentBlock + 1,
      logsFound: acc.logs.length, entries: fresh.length,
      headBlock: head.number, comparison, durationMs: Date.now() - t0, persisted: !!opts.persist,
    };
  }

  // ── 只读接口 (索引文件没有 → 返回空索引, 不假装有) ──────────────────────

  status(): {
    chainId: number; networkName: string; escrowAddress: string;
    deploymentBlock: number; deploymentSource: string;
    lastSyncedBlock: number; lastSyncedAt: number | null;
    headBlock: number | null; headBlockHash: string | null;
    entries: number; suspects: number;
    confirmations: ChainConfirmations; pageSize: number; reorgDepth: number;
    rebuiltAt: number | null; indexPath: string;
  } {
    const s = this.load();
    return {
      chainId: s.chainId, networkName: s.networkName, escrowAddress: s.escrowAddress,
      deploymentBlock: s.deploymentBlock, deploymentSource: s.deploymentSource,
      lastSyncedBlock: s.lastSyncedBlock, lastSyncedAt: s.lastSyncedAt,
      headBlock: s.headBlock, headBlockHash: s.headBlockHash,
      entries: s.entries.length, suspects: s.entries.filter((e) => e.suspect).length,
      confirmations: s.confirmations, pageSize: s.pageSize, reorgDepth: s.reorgDepth,
      rebuiltAt: s.rebuiltAt ?? null, indexPath: this.indexPath,
    };
  }

  /** 按 taskKey 查 escrow 时间线 (按 blockNumber, logIndex 升序) */
  timeline(taskKey: string): { taskKey: string; events: ChainIndexEntry[]; state: string | null; count: number; hasSuspect: boolean } {
    const key = String(taskKey || '').toLowerCase();
    const events = this.load().entries.filter((e) => e.taskKey.toLowerCase() === key).sort(byBlockLogIndex);
    return { taskKey: key, events, state: deriveEscrowState(events), count: events.length, hasSuspect: events.some((e) => e.suspect) };
  }

  /** cursor = (blockNumber, logIndex) 之后的事件, 升序返回 (增量拉取) */
  fetchAfter(cursor: { blockNumber: number; logIndex: number } | null, limit = 200): {
    events: ChainIndexEntry[]; nextCursor: { blockNumber: number; logIndex: number } | null; hasMore: boolean; total: number;
  } {
    const cb = cursor ? Number(cursor.blockNumber) : -1;
    const cl = cursor ? Number(cursor.logIndex) : -1;
    const all = this.load().entries
      .filter((e) => e.blockNumber > cb || (e.blockNumber === cb && e.logIndex > cl))
      .sort(byBlockLogIndex);
    const lim = Math.max(1, Math.min(2000, Math.floor(limit)));
    const page = all.slice(0, lim);
    const last = page[page.length - 1];
    return {
      events: page,
      nextCursor: last ? { blockNumber: last.blockNumber, logIndex: last.logIndex } : (cursor ?? null),
      hasMore: all.length > page.length,
      total: all.length,
    };
  }

  /** 全量统计 (tasks/released/refunded/disputed/expired ...) */
  stats(): {
    entries: number; suspects: number; tasks: number;
    created: number; proofSubmitted: number; released: number; refunded: number; disputed: number; expired: number;
    byFinality: Record<IndexFinality, number>;
    lastSyncedBlock: number; lastSyncedAt: number | null; headBlock: number | null;
    deploymentBlock: number; chainId: number; escrowAddress: string;
  } {
    const s = this.load();
    const live = s.entries.filter((e) => !e.suspect);
    const count = (n: string) => live.filter((e) => e.eventName === n).length;
    const tasks = new Set(live.filter((e) => e.eventName === 'EscrowCreatedV2').map((e) => e.taskKey.toLowerCase())).size;
    const byFinality: Record<IndexFinality, number> = { observed: 0, confirmed: 0, finalized: 0 };
    for (const e of s.entries) byFinality[e.finality]++;
    return {
      entries: s.entries.length, suspects: s.entries.filter((e) => e.suspect).length, tasks,
      created: count('EscrowCreatedV2'),
      proofSubmitted: count('ProofSubmittedV2'),
      released: count('ReleasedV2'),
      refunded: count('RefundedV2'),
      disputed: count('DisputedV2'),
      expired: count('ExpiredV2'),
      byFinality,
      lastSyncedBlock: s.lastSyncedBlock, lastSyncedAt: s.lastSyncedAt, headBlock: s.headBlock,
      deploymentBlock: s.deploymentBlock, chainId: s.chainId, escrowAddress: s.escrowAddress,
    };
  }
}

/** 从原始日志取 logIndex: 原始 JSON-RPC 里叫 logIndex, ethers v6 的 Log 对象里叫 index (两个都要认) */
function logIndexOf(raw: any): number {
  return Number(raw?.logIndex ?? raw?.index);
}

// ── 纯函数 ─────────────────────────────────────────────────────────────────

export function byBlockLogIndex(a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/** 从事件序列推 escrow 状态 (只按事件推, 不读链) */
export function deriveEscrowState(events: Array<{ eventName: string }>): string | null {
  if (!events.length) return null;
  const has = (n: string) => events.some((e) => e.eventName === n);
  if (has('ReleasedV2')) return 'RELEASED';
  if (has('RefundedV2')) return 'REFUNDED';
  if (has('ExpiredV2')) return 'EXPIRED';
  if (has('DisputedV2')) return 'DISPUTED';
  if (has('ProofSubmittedV2')) return 'ACTIVE (proof submitted)';
  if (has('EscrowCreatedV2')) return 'ACTIVE';
  return null;
}

/**
 * 逐条比对两份索引 (只看**链上事实**: 键/块号/块哈希/事件名/taskKey/logIndex/args)。
 * 确认数与 finality 随 head 变, 不参与比对 (这是设计, 不是漏项)。
 */
export function compareIndexes(a: ChainIndexEntry[], b: ChainIndexEntry[]): IndexComparison {
  const ma = new Map(a.map((e) => [e.key, e]));
  const mb = new Map(b.map((e) => [e.key, e]));
  const missingInB: string[] = [];
  const extraInB: string[] = [];
  const mismatched: Array<{ key: string; field: string; a: unknown; b: unknown }> = [];
  for (const [k, ea] of ma) {
    const eb = mb.get(k);
    if (!eb) { missingInB.push(k); continue; }
    for (const f of ['blockNumber', 'blockHash', 'eventName', 'taskKey', 'logIndex'] as const) {
      if (ea[f] !== eb[f]) mismatched.push({ key: k, field: f, a: ea[f], b: eb[f] });
    }
    const sa = JSON.stringify(ea.args), sb = JSON.stringify(eb.args);
    if (sa !== sb) mismatched.push({ key: k, field: 'args', a: sa, b: sb });
  }
  for (const k of mb.keys()) if (!ma.has(k)) extraInB.push(k);
  return {
    same: missingInB.length === 0 && extraInB.length === 0 && mismatched.length === 0,
    countA: ma.size, countB: mb.size, missingInB, extraInB, mismatched,
  };
}
