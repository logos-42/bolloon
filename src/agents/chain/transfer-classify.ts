/**
 * transfer-classify.ts — 转账索引的**纯**部分 (类型 + 分类 + 折算 + 汇总)
 * =========================================================================
 * 为什么单独一个文件: 这两半的**加载代价**完全不同 ——
 *   · 本文件: 零依赖 (不 import ethers / 不发 RPC / 不读盘) ⇒ 公开页/快照构建可以**静态**引入;
 *   · `transfer-index.ts`: 要 JSON-RPC provider (ethers) 与文件系统 ⇒ 只在**同步**路径上加载。
 * 把纯函数放在这里, network-pulse 才不必为了 `formatUnits` 把 ethers 拖进网页进程。
 *
 * 分类口径 (leo 2026-09-29 实测拍板; **不许**只按"USDC 转到该地址"计数):
 *   · `escrow_settlement`  from == escrow 合约 → 「escrow 退款/释放」(实测块 51685757 / 51686009
 *                          两笔 +0.001 与那两笔 Disputed→Refunded **逐块对应**) —— 钱退回, **不是收入**;
 *   · `self_transfer`      from ∈ 自己地址集 (可配 ownAddresses) → 「转入(非销售)」;
 *   · `external_payment`   其余 → 「外部付款」(与卖方端点台账对上的加标「经 x402 流程」);
 *   · `outbound`           关注地址**付出** → 不进「链上转入」计数。
 */

export const TRANSFER_INDEX_SCHEMA_VERSION = 1;

/** Transfer(address indexed from, address indexed to, uint256 value) 的 topic0 */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type TransferClass = 'escrow_settlement' | 'self_transfer' | 'external_payment' | 'outbound';

/** Base 主网 USDC (缺省 token; 也可由 chain.json 的 tokenAddress / env 覆盖) */
export const USDC_BY_CHAIN: Record<number, string> = {
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
};

/** 0x + 40 位十六进制 (地址形状; 与 explorer.ts 的同一套尺子) */
export const TRANSFER_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** 原子单位 → 十进制字符串 (纯整数运算, 不经过浮点; 去掉末尾多余的 0) */
export function formatUnits(atomic: string | bigint, decimals: number): string {
  const v = BigInt(typeof atomic === 'bigint' ? atomic : (String(atomic || '0').trim() || '0'));
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const d = Math.max(0, Math.floor(decimals));
  const base = 10n ** BigInt(d);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(d, '0').replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

export interface TransferIndexEntry {
  /** 去重键 = `txHash:logIndex` (小写) */
  key: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  /** 该 Transfer 日志所在的 token 合约 (小写) */
  address: string;
  /** 付款方 EOA (小写) —— **只在本机索引里**, 不进公开快照 (隐私门会拒 0x40) */
  from: string;
  /** 收款方 (小写) */
  to: string;
  /** 原子单位金额 (字符串, 不丢精度) */
  value: string;
  /** 方向: in = 关注地址收到; out = 关注地址付出 */
  direction: 'in' | 'out';
  confirmations: number;
  finality: 'observed' | 'confirmed' | 'finalized';
  /** 本节点首次观察到该条的时间 (ms) */
  firstSeenAt: number;
  /** 被回退 / 重扫后不再出现 → 标 true 并保留 */
  suspect?: boolean;
  suspectReason?: string;
}

export interface TransferIndexRun {
  at: number;
  mode: 'sync' | 'backfill';
  scanFrom: number;
  scanTo: number;
  pages: number;
  blocksScanned: number;
  logsFound: number;
  inserted: number;
  deduped: number;
  rewritten: number;
  markedSuspect: number;
  headBlock: number;
  durationMs: number;
}

export interface TransferIndexFile {
  schemaVersion: number;
  chainId: number;
  networkName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** 关注地址集 (小写, 升序去重) */
  watchAddresses: string[];
  fromBlock: number;
  lastSyncedBlock: number;
  lastSyncedAt: number | null;
  headBlock: number | null;
  headBlockHash: string | null;
  pageSize: number;
  reorgDepth: number;
  entries: TransferIndexEntry[];
  runs: TransferIndexRun[];
  updatedAt: number;
}

/**
 * 一条转账的**分类** (纯函数: 输入事实 + 配置, 输出分类)。
 * 为什么在**读**的时候算而不是写索引时算: 分类规则 / 自己地址集是会变的
 * (把 0xb4cb8009… 认成"自己钱包"之前, 它只是一个外部地址) ⇒ 历史行必须能被重新分类,
 * 而不是把当时的判断固化进索引。索引里只存**链上事实** (from/to/value/块号)。
 */
export function classifyTransfer(
  e: Pick<TransferIndexEntry, 'from' | 'to' | 'direction'>,
  cfg: { watchAddresses?: string[]; ownAddresses?: string[]; escrowAddress?: string | null },
): TransferClass {
  const from = String(e.from || '').toLowerCase();
  const to = String(e.to || '').toLowerCase();
  const watch = new Set((cfg.watchAddresses || []).map((a) => String(a).toLowerCase()));
  if (e.direction === 'out' || (watch.has(from) && !watch.has(to))) return 'outbound';
  const escrow = String(cfg.escrowAddress || '').toLowerCase();
  if (escrow && from === escrow) return 'escrow_settlement';
  if ((cfg.ownAddresses || []).map((a) => String(a).toLowerCase()).includes(from)) return 'self_transfer';
  return 'external_payment';
}

export interface TransferSummary {
  /** 关注地址集/起点是否配好 (false = 这一格如实「未配置」, 不是 0) */
  configured: boolean;
  reason: string;
  entries: number;
  suspects: number;
  /** 转入 (to ∈ 关注地址集) */
  inbound: number;
  inbound_atomic: string;
  inbound_display: string;
  by_class: Record<'escrow_settlement' | 'self_transfer' | 'external_payment', number>;
  by_class_atomic: Record<'escrow_settlement' | 'self_transfer' | 'external_payment', string>;
  /** 出账 (from ∈ 关注地址集) */
  outbound: number;
  outbound_atomic: string;
  token_symbol: string;
  token_decimals: number;
  watch_addresses_count: number;
  own_addresses_count: number;
  from_block: number;
  last_synced_block: number;
  last_synced_at: number | null;
  head_block: number | null;
  /** 汇总里有多少行还只是 `observed` (未达 confirmed 门槛) —— 如实标出 */
  pending_observation: number;
}

/** 已落盘转账索引 → 汇总 (纯函数; 不发网络、不读配置以外的东西) */
export function summarizeTransfers(
  state: TransferIndexFile,
  cfg: { watchAddresses?: string[]; ownAddresses?: string[]; escrowAddress?: string | null; tokenSymbol?: string; tokenDecimals?: number; enabled?: boolean; reason?: string },
): TransferSummary {
  const live = (state.entries || []).filter((e) => !e.suspect);
  const by_class = { escrow_settlement: 0, self_transfer: 0, external_payment: 0 };
  const by_class_atomic = { escrow_settlement: '0', self_transfer: '0', external_payment: '0' };
  let inbound = 0, inboundAtomic = 0n, outbound = 0, outboundAtomic = 0n, pending = 0;
  for (const e of live) {
    if (e.finality === 'observed') pending++;
    const v = BigInt(e.value || '0');
    if (e.direction === 'out') { outbound++; outboundAtomic += v; continue; }
    inbound++;
    inboundAtomic += v;
    const c = classifyTransfer(e, cfg);
    if (c !== 'outbound') {
      by_class[c]++;
      by_class_atomic[c] = (BigInt(by_class_atomic[c]) + v).toString();
    }
  }
  const decimals = Number.isInteger(state.tokenDecimals) ? state.tokenDecimals : (cfg.tokenDecimals ?? 6);
  return {
    configured: cfg.enabled !== false && !!((state.watchAddresses || cfg.watchAddresses || []).length),
    reason: cfg.reason || '',
    entries: live.length,
    suspects: (state.entries || []).length - live.length,
    inbound, inbound_atomic: inboundAtomic.toString(), inbound_display: formatUnits(inboundAtomic, decimals),
    by_class, by_class_atomic,
    outbound, outbound_atomic: outboundAtomic.toString(),
    token_symbol: state.tokenSymbol || cfg.tokenSymbol || '',
    token_decimals: decimals,
    watch_addresses_count: (state.watchAddresses || cfg.watchAddresses || []).length,
    own_addresses_count: (cfg.ownAddresses || []).length,
    from_block: state.fromBlock,
    last_synced_block: state.lastSyncedBlock,
    last_synced_at: state.lastSyncedAt,
    head_block: state.headBlock,
    pending_observation: pending,
  };
}
