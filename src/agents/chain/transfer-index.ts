/**
 * transfer-index.ts — **关注地址集**内的 ERC-20 (USDC) 转账索引 (2026-09-29)
 * =========================================================================
 * 为什么需要它 (leo:「我要记录的是链上数据…网关要显示的是所有交互」):
 *   旧索引只扫 AgentEscrow 合约日志 ⇒ 走**直付 (买方自己发 USDC 到 payTo)** 的收款
 *   在链上**根本没有 escrow 事件** (x402 在链上没有自己的事件; 付款就是一笔普通 ERC-20
 *   USDC 转账) ⇒ 「所有交互」在旧口径里是漏的。
 *
 * 干什么: 把 `tokenAddress` (缺省 = 本链 USDC) 上 **to ∈ 关注地址集 / from ∈ 关注地址集**
 *   的 Transfer 日志扫进 `~/.bolloon/chain/transfers.json`, 让「链上转入」可核验
 *   (每笔带 txHash / 块号 / 原子金额; from/to 只留在本机索引里, 不进公开快照)。
 *
 * 硬约束 (每条都能被验收脚本证伪):
 *   ① 关注地址集来自**配置** (`~/.bolloon/chain.json` 的 `watchAddresses`), env
 *      (`BOLLOON_WATCH_ADDRESSES`) 可覆盖 —— **不硬编码任何单个地址**;
 *      没配 → 索引自称 `enabled:false` 且**不猜** (页面上这一格显示「未配置」, 不显示 0)。
 *   ② 分页 eth_getLogs ≤ pageSize (默认 2000 —— 实测 mainnet.base.org 的 eth_getLogs
 *      **单次上限 2000 块**, 3000/5000/10000 块窗口全被拒: `is limited to a 2,000 range`);
 *      provider 报错就**对半拆**再试, 不静默漏页。
 *   ③ 去重键 = `txHash:logIndex` (小写), 幂等重跑 0 重复。
 *   ④ 起点 `fromBlock` 来自配置 (`transferScanFromBlock`), 缺省 = 链索引的 deploymentBlock
 *      (即 Bolloon 在 Base 主网上的起点) —— **不是** 0, 也不是"最新块"(那会漏掉历史收款)。
 *   ⑤ 重组: 每次同步**强制回扫**最后 `reorgDepth` (默认 32) 块, 用重扫结果**重写**该窗口内的
 *      条目; 重扫后不再出现的键 → 标 `suspect` 并保留 (不静默丢弃)。
 *   ⑥ 本模块**只读链** (eth_getLogs / eth_getBlockByNumber), 不签名、不发交易、不碰私钥。
 *
 * 与 escrow 索引的关系: **互不影响**。escrow 索引 (`chain/index.json`) 的身份门 / 重组逻辑
 *   一行未动 —— 本模块用**另一个文件** (`chain/transfers.json`) 记自己的游标, 只做增量 + 回扫。
 *
 * 纯函数 (分类 / 折算 / 汇总) 在 `transfer-classify.ts` —— 这里只做 RPC + 落盘, 并把纯函数**转出**
 * (老调用方可以只 import 本文件)。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IndexRpcProvider } from './chain-indexer.js';
import { createJsonRpcProvider } from './escrow-client.js';
import { bolloonHome, chainConfigPath, DEFAULT_CONFIRMATIONS, type ChainConfirmations } from './chain-config.js';
import {
  TRANSFER_INDEX_SCHEMA_VERSION, ERC20_TRANSFER_TOPIC, USDC_BY_CHAIN, TRANSFER_ADDRESS_RE,
  type TransferIndexEntry, type TransferIndexFile, type TransferIndexRun,
} from './transfer-classify.js';

export * from './transfer-classify.js';
export type { TransferIndexEntry, TransferIndexFile, TransferIndexRun };

export interface TransferWatchConfig {
  enabled: boolean;
  reason: string;
  chainId: number;
  networkName: string;
  rpcUrl: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  watchAddresses: string[];
  /** 自己地址集 (小写) —— from ∈ 这里 → 「转入(非销售)」 */
  ownAddresses: string[];
  /** escrow 合约地址 (小写; from == 它 → 「escrow 退款/释放」) */
  escrowAddress: string;
  fromBlock: number;
  fromBlockSource: string;
  confirmations: ChainConfirmations;
  pageSize: number;
  reorgDepth: number;
}

export function transferIndexPath(home?: string): string {
  return path.join(bolloonHome(home), 'chain', 'transfers.json');
}

/** 读本机 chain.json (读不出 → 空对象; 不抛) */
function readChainJson(home?: string): any {
  try {
    return JSON.parse(fs.readFileSync(chainConfigPath(home), 'utf8'));
  } catch {
    return {};
  }
}

function resolveAddrSet(raw: string[], source: string): { addresses: string[]; source: string; rejected: string[] } {
  const addresses: string[] = [];
  const rejected: string[] = [];
  for (const a of raw) {
    if (TRANSFER_ADDRESS_RE.test(String(a))) addresses.push(String(a).toLowerCase());
    else rejected.push(String(a));
  }
  return { addresses: Array.from(new Set(addresses)).sort(), source, rejected };
}

/**
 * 关注地址集解析 (**唯一实现**): env `BOLLOON_WATCH_ADDRESSES` (逗号/空白分隔) 优先,
 * 其次 `~/.bolloon/chain.json` 的 `watchAddresses[]`。非法地址**全部丢弃并如实说明**
 * (不"猜一个像的" —— 地址猜错会把别人的流水索引成本节点的)。
 */
export function resolveWatchAddresses(home?: string, env: NodeJS.ProcessEnv = process.env): { addresses: string[]; source: string; rejected: string[] } {
  const envRaw = String(env.BOLLOON_WATCH_ADDRESSES || '').trim();
  if (envRaw) return resolveAddrSet(envRaw.split(/[\s,]+/).filter(Boolean), 'env BOLLOON_WATCH_ADDRESSES');
  const file = readChainJson(home);
  const arr = Array.isArray(file?.watchAddresses) ? file.watchAddresses : [];
  return resolveAddrSet(arr.map((x: any) => String(x)), arr.length ? `${chainConfigPath(home)} .watchAddresses[]` : '未配置');
}

/** 自己地址集解析 (env `BOLLOON_OWN_ADDRESSES` 优先, 其次 chain.json `ownAddresses[]`; 非法全丢) */
export function resolveOwnAddresses(home?: string, env: NodeJS.ProcessEnv = process.env): { addresses: string[]; source: string; rejected: string[] } {
  const envRaw = String(env.BOLLOON_OWN_ADDRESSES || '').trim();
  if (envRaw) return resolveAddrSet(envRaw.split(/[\s,]+/).filter(Boolean), 'env BOLLOON_OWN_ADDRESSES');
  const file = readChainJson(home);
  const arr = Array.isArray(file?.ownAddresses) ? file.ownAddresses : [];
  return resolveAddrSet(arr.map((x: any) => String(x)), arr.length ? `${chainConfigPath(home)} .ownAddresses[]` : '未配置');
}

/** 转账索引的配置 (纯读配置, 不发 RPC) */
export function readTransferWatchConfig(home?: string, env: NodeJS.ProcessEnv = process.env): TransferWatchConfig {
  const file = readChainJson(home);
  const chainId = Number.isInteger(Number(file?.chainId)) ? Number(file.chainId) : 0;
  const networkName = String(file?.networkName || 'unknown');
  const rpcUrl = String(env.BOLLOON_CHAIN_RPC_URL || file?.rpcUrl || '');
  const tokenAddress = String(env.BOLLOON_TRANSFER_TOKEN || file?.tokenAddress || USDC_BY_CHAIN[chainId] || '').toLowerCase();
  const tokenDecimals = Number.isInteger(Number(file?.tokenDecimals)) ? Number(file.tokenDecimals) : 6;
  const { addresses, source, rejected } = resolveWatchAddresses(home, env);
  const own = resolveOwnAddresses(home, env);
  const escrowAddress = String(env.BOLLOON_ESCROW_ADDRESS || file?.escrowAddress || '').toLowerCase();
  const envPage = Number(env.BOLLOON_INDEX_PAGE_SIZE);
  const pageSize = Math.max(1, Math.floor(Number.isInteger(envPage) && envPage > 0 ? envPage : 2000));
  const envDepth = Number(env.BOLLOON_INDEX_REORG_DEPTH);
  const reorgDepth = Math.max(1, Math.floor(Number.isInteger(envDepth) && envDepth > 0 ? envDepth : 32));
  const cfgFrom = Number(env.BOLLOON_TRANSFER_SCAN_FROM || file?.transferScanFromBlock);
  const fromConfigured = Number.isInteger(cfgFrom) && cfgFrom > 0;
  const missing: string[] = [];
  if (!TRANSFER_ADDRESS_RE.test(tokenAddress)) missing.push('tokenAddress');
  if (!addresses.length) missing.push(rejected.length ? `关注地址集全部非法: ${rejected.join(', ')}` : '关注地址集 (watchAddresses)');
  if (!rpcUrl) missing.push('rpcUrl');
  return {
    enabled: missing.length === 0,
    reason: missing.length ? `未配置/未启用: 缺 ${missing.join(' · ')} (来源: ${source})` : `关注地址集 ${addresses.length} 个 (${source})`,
    chainId, networkName, rpcUrl,
    tokenAddress,
    tokenSymbol: tokenAddress === USDC_BY_CHAIN[8453] || tokenAddress === USDC_BY_CHAIN[84532] ? 'USDC' : 'ERC20',
    tokenDecimals,
    watchAddresses: addresses,
    ownAddresses: own.addresses,
    escrowAddress,
    // 起点: 显式配置优先; 否则留给调用方用 escrow deploymentBlock 填 (见 syncTransfers 的 opts.fromBlock)
    fromBlock: fromConfigured ? cfgFrom : 0,
    fromBlockSource: fromConfigured ? '配置 transferScanFromBlock' : '未配置 → 由调用方给 (缺省 = escrow 部署块)',
    confirmations: DEFAULT_CONFIRMATIONS,
    pageSize, reorgDepth,
  };
}

function emptyIndex(cfg: TransferWatchConfig, fromBlock: number): TransferIndexFile {
  return {
    schemaVersion: TRANSFER_INDEX_SCHEMA_VERSION,
    chainId: cfg.chainId, networkName: cfg.networkName,
    tokenAddress: cfg.tokenAddress, tokenSymbol: cfg.tokenSymbol, tokenDecimals: cfg.tokenDecimals,
    watchAddresses: cfg.watchAddresses,
    fromBlock,
    lastSyncedBlock: fromBlock - 1,
    lastSyncedAt: null, headBlock: null, headBlockHash: null,
    pageSize: cfg.pageSize, reorgDepth: cfg.reorgDepth,
    entries: [], runs: [], updatedAt: Date.now(),
  };
}

export function readTransferIndex(home?: string): TransferIndexFile {
  const cfg = readTransferWatchConfig(home);
  const p = transferIndexPath(home);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return emptyIndex(cfg, cfg.fromBlock || 0); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return emptyIndex(cfg, cfg.fromBlock || 0);
  const dedup = new Map<string, TransferIndexEntry>();
  for (const e of raw.entries) {
    const key = String(e?.key || '');
    if (!key || dedup.has(key)) continue;              // 坏文件里的重复键不许渗进来
    dedup.set(key, e as TransferIndexEntry);
  }
  const entries = Array.from(dedup.values()).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return {
    ...emptyIndex(cfg, Number.isInteger(raw.fromBlock) ? Number(raw.fromBlock) : cfg.fromBlock),
    chainId: Number(raw.chainId) || cfg.chainId,
    networkName: String(raw.networkName || cfg.networkName),
    tokenAddress: String(raw.tokenAddress || cfg.tokenAddress).toLowerCase(),
    tokenSymbol: String(raw.tokenSymbol || cfg.tokenSymbol),
    tokenDecimals: Number.isInteger(raw.tokenDecimals) ? Number(raw.tokenDecimals) : cfg.tokenDecimals,
    watchAddresses: Array.isArray(raw.watchAddresses) ? raw.watchAddresses.map((a: any) => String(a).toLowerCase()) : cfg.watchAddresses,
    fromBlock: Number.isInteger(raw.fromBlock) ? Number(raw.fromBlock) : cfg.fromBlock,
    lastSyncedBlock: Number.isInteger(raw.lastSyncedBlock) ? Number(raw.lastSyncedBlock) : cfg.fromBlock - 1,
    lastSyncedAt: raw.lastSyncedAt ?? null,
    headBlock: Number.isInteger(raw.headBlock) ? Number(raw.headBlock) : null,
    headBlockHash: raw.headBlockHash ?? null,
    pageSize: Number(raw.pageSize) || cfg.pageSize,
    reorgDepth: Number(raw.reorgDepth) || cfg.reorgDepth,
    entries,
    runs: Array.isArray(raw.runs) ? raw.runs.slice(-50) : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

/** 原子写 (tmp + rename) */
export async function writeTransferIndex(home: string | undefined, state: TransferIndexFile): Promise<string> {
  const p = transferIndexPath(home);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  state.updatedAt = Date.now();
  state.runs = state.runs.slice(-50);
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.promises.rename(tmp, p);
  return p;
}

const topicForAddress = (a: string) => '0x' + a.replace(/^0x/, '').padStart(64, '0');

/**
 * 从原始日志取 logIndex: **原始 JSON-RPC 里叫 `logIndex`, ethers v6 的 Log 对象里叫 `index`**
 * (两个都要认 —— 只认一个的话 ethers 路径会全部拿到 undefined, 索引里全是 -1, 行会被当成非法丢弃:
 * 2026-09-29 实测踩过, 4 笔转入一笔都没出行)。同一套兼容在 chain-indexer.ts 的 logIndexOf 里。
 */
function logIndexOfRaw(raw: any): number {
  const n = Number(raw?.logIndex ?? raw?.index);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

export interface TransferSyncResult {
  ok: boolean;
  skipped?: string;
  indexPath?: string;
  configuration: TransferWatchConfig;
  scanFrom?: number;
  scanTo?: number;
  pages?: number;
  logsFound?: number;
  inserted?: number;
  deduped?: number;
  rewritten?: number;
  markedSuspect?: number;
  entries?: number;
  lastSyncedBlock?: number;
  headBlock?: number;
  /** 重扫窗口内**新出现**的收款 (给调用方做"有没有变化"判断) */
  received?: number;
  receivedAtomic?: string;
}

/**
 * 增量同步 (**唯一写入口**):
 *   scanFrom = min(强制回扫窗口起点, lastSyncedBlock + 1); fromBlock 覆盖时取更小的那个 (补扫)
 *   scanTo   = 当前链 head
 * 每次同步都回扫最后 `reorgDepth` 块并把该窗口内的条目**重写**; 重扫里消失的键标 suspect 保留。
 */
export async function syncTransfers(opts: {
  home?: string;
  provider?: IndexRpcProvider;
  /** 扫描下界 (缺省 = 配置的 fromBlock; 再缺省 = 调用方必须给) */
  fromBlock?: number;
  /** 配置不可用时的免责 (tests) */
  config?: TransferWatchConfig;
  log?: (m: string) => void;
  now?: number;
} = {}): Promise<TransferSyncResult> {
  const cfg = opts.config || readTransferWatchConfig(opts.home);
  const log = opts.log || (() => { /* 静默 */ });
  if (!cfg.enabled) return { ok: false, skipped: cfg.reason, configuration: cfg };

  const fromBlock = Math.max(0, Math.floor(opts.fromBlock ?? cfg.fromBlock));
  if (!Number.isInteger(fromBlock) || fromBlock <= 0) {
    return { ok: false, skipped: '缺扫描起点: 配置里没有 transferScanFromBlock, 调用方也没给 fromBlock (不猜 0 —— 从 0 开始扫会白扫几十万块)', configuration: cfg };
  }

  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const state = readTransferIndex(opts.home);
  // 起点只在**首次**或**显式补扫**时生效 (不许被后续增量悄悄改大 —— 那会漏历史收款)
  const effectiveFrom = state.entries.length === 0 && state.lastSyncedAt == null ? fromBlock : Math.min(fromBlock, state.fromBlock || fromBlock);
  const provider = opts.provider || (createJsonRpcProvider(cfg.rpcUrl) as unknown as IndexRpcProvider);

  const headNum = await provider.getBlockNumber();
  const headBlock = await provider.getBlock(headNum);
  if (!headBlock) throw new Error(`读不到 head 区块 ${headNum} (RPC 异常)`);

  const rewindFrom = Math.max(effectiveFrom, state.lastSyncedBlock - cfg.reorgDepth + 1);
  const incremental = state.lastSyncedBlock + 1;
  const scanFrom = Math.max(effectiveFrom, Math.min(incremental, rewindFrom));
  if (scanFrom > headNum) {
    return { ok: true, skipped: `已是最新 (lastSyncedBlock=${state.lastSyncedBlock} >= head=${headNum})`, configuration: cfg, lastSyncedBlock: state.lastSyncedBlock, headBlock: headNum };
  }

  // 逐页扫: 每个关注地址两条过滤 (from 侧 / to 侧)
  const found = new Map<string, any>();
  let pages = 0;
  const tryGet = async (filter: any, a: number, b: number): Promise<any[]> => {
    try {
      return await provider.getLogs({ ...filter, fromBlock: a, toBlock: b });
    } catch (e: any) {
      const msg = String(e?.shortMessage || e?.message || e);
      if (a === b) throw e;
      log(`  ⚠ eth_getLogs(${a}-${b}) 失败 (${msg.slice(0, 90)}) → 对半拆`);
      const mid = Math.floor((a + b) / 2);
      const left = await tryGet(filter, a, mid);
      const right = await tryGet(filter, mid + 1, b);
      return [...left, ...right];
    }
  };

  const filters: any[] = [];
  for (const w of cfg.watchAddresses) {
    filters.push({ address: cfg.tokenAddress, topics: [ERC20_TRANSFER_TOPIC, topicForAddress(w)] });            // from 侧
    filters.push({ address: cfg.tokenAddress, topics: [ERC20_TRANSFER_TOPIC, null, topicForAddress(w)] });      // to 侧
  }

  const watch = new Set(cfg.watchAddresses);
  for (let a = scanFrom; a <= headNum; a += cfg.pageSize) {
    const b = Math.min(a + cfg.pageSize - 1, headNum);
    for (const f of filters) {
      const logs = await tryGet(f, a, b);
      for (const l of logs || []) found.set(`${String(l.transactionHash).toLowerCase()}:${logIndexOfRaw(l)}`, l);
    }
    pages++;
    log(`  · 扫 ${a}-${b} (${pages} 页, 命中 ${found.size} 条)`);
  }

  // 重扫窗口内的旧条目先摘出去 (下面按重扫结果重写)
  const inWindow = (n: number) => n >= scanFrom && n <= headNum;
  const kept = state.entries.filter((e) => !inWindow(e.blockNumber));
  const removed = state.entries.filter((e) => inWindow(e.blockNumber));
  const byKey = new Map(kept.map((e) => [e.key, e]));
  let inserted = 0, deduped = 0, rewritten = 0;
  const finalityOf = (conf: number) => (conf >= cfg.confirmations.finalized ? 'finalized' : (conf >= cfg.confirmations.confirmed ? 'confirmed' : 'observed'));

  for (const [key, l] of found) {
    const prev = removed.find((e) => e.key === key);
    const topics: string[] = l.topics || [];
    const from = '0x' + String(topics[1] || '').slice(-40);
    const to = '0x' + String(topics[2] || '').slice(-40);
    const block = Number(l.blockNumber);
    const value = BigInt(l.data || '0x0').toString();
    const direction: 'in' | 'out' = watch.has(to.toLowerCase()) ? 'in' : 'out';
    const conf = Math.max(0, headNum - block + 1);
    const entry: TransferIndexEntry = {
      key,
      blockNumber: block,
      blockHash: String(l.blockHash || ''),
      txHash: String(l.transactionHash).toLowerCase(),
      txIndex: Number.isInteger(Number(l.transactionIndex)) ? Number(l.transactionIndex) : -1,
      logIndex: logIndexOfRaw(l),
      address: String(l.address || '').toLowerCase(),
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      value, direction,
      confirmations: conf,
      finality: finalityOf(conf) as any,
      firstSeenAt: prev?.firstSeenAt ?? now,
    };
    if (prev) {
      rewritten++;
      removed.splice(removed.indexOf(prev), 1);
    } else if (byKey.has(key)) deduped++;
    else inserted++;
    byKey.set(key, entry);
  }

  // 重扫窗口内**不再出现**的旧条目: 标 suspect 保留 (不静默丢弃)
  let markedSuspect = 0;
  for (const e of removed) {
    e.suspect = true;
    e.suspectReason = `重扫 [${scanFrom}, ${headNum}] 后该日志不再出现 (链回滚 / 重组)`;
    markedSuspect++;
    byKey.set(e.key, e);
  }

  // 更新窗口外条目的确认数 (head 在长)
  const entries = Array.from(byKey.values()).sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  for (const e of entries) {
    if (inWindow(e.blockNumber)) continue;
    e.confirmations = Math.max(0, headNum - e.blockNumber + 1);
    e.finality = (e.suspect ? 'observed' : finalityOf(e.confirmations)) as any;
  }

  const nextState: TransferIndexFile = {
    ...state,
    chainId: cfg.chainId || state.chainId,
    networkName: cfg.networkName || state.networkName,
    tokenAddress: cfg.tokenAddress, tokenSymbol: cfg.tokenSymbol, tokenDecimals: cfg.tokenDecimals,
    watchAddresses: cfg.watchAddresses,
    fromBlock: effectiveFrom,
    lastSyncedBlock: Math.max(state.lastSyncedBlock, headNum),
    lastSyncedAt: now,
    headBlock: headNum,
    headBlockHash: String(headBlock.hash || ''),
    pageSize: cfg.pageSize, reorgDepth: cfg.reorgDepth,
    entries,
    runs: [...state.runs, {
      at: now,
      mode: state.lastSyncedAt == null || effectiveFrom < state.fromBlock ? 'backfill' : 'sync',
      scanFrom, scanTo: headNum, pages,
      blocksScanned: headNum - scanFrom + 1,
      logsFound: found.size, inserted, deduped, rewritten, markedSuspect,
      headBlock: headNum, durationMs: Date.now() - t0,
    }],
  };
  const indexPath = await writeTransferIndex(opts.home, nextState);

  const live = entries.filter((e) => !e.suspect && e.direction === 'in');
  const inWindowNew = live.filter((e) => inWindow(e.blockNumber));
  return {
    ok: true, indexPath, configuration: cfg,
    scanFrom, scanTo: headNum, pages,
    logsFound: found.size, inserted, deduped, rewritten, markedSuspect,
    entries: entries.length, lastSyncedBlock: nextState.lastSyncedBlock, headBlock: headNum,
    received: inWindowNew.length,
    receivedAtomic: inWindowNew.reduce((n, e) => n + BigInt(e.value), 0n).toString(),
  };
}
