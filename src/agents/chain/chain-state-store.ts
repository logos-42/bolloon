/**
 * chain-state-store.ts — 链上状态的持久化 / 重启恢复 / 重组对账 (P3, ④)
 *
 * 为什么必须有:
 *   进程会被杀, 会重启, 会被 rollback。重启后必须能回答:
 *     「哪些交易已上链 / 待确认 / 已确认 / 被重组」—— 而不是靠内存里的对象猜。
 *
 * 落盘位置: `~/.bolloon/chain/chain-state.json` (原子写: tmp + rename)。
 * 每条记录必须带的**关键状态**:
 *   链上 escrow 地址 · txHash · taskKey · 确认数 · 最后检查块 · 判定状态 · 是否不可信
 *
 * 重组的两条检出路径 (都**不**静默当已结算):
 *   ① 同一 txHash 出现在另一个块号 (或链上查不到了) → `reorged` + suspect=true
 *   ② 之前核上的事件在链上"消失" (logs 里没了) → `event_mismatch` + suspect=true
 *
 * 本模块只负责"记"和"对账", 判定本身仍只由 chain-settlement.ts 给。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { bolloonHome } from './chain-config.js';
import type { ChainSettlementStatus, ChainSettlementVerdict } from './chain-settlement.js';
import { verifyChainSettlement } from './chain-settlement.js';
import type { EscrowClient } from './escrow-client.js';
import type { ChainTxMethod } from './chain-wallet.js';

export const CHAIN_STATE_SCHEMA_VERSION = 1;

export interface ChainTxHistoryEntry {
  at: number;
  status: ChainSettlementStatus;
  txHash?: string;
  blockNumber?: number | null;
  confirmations?: number;
  reason?: string;
}

export interface ChainTxRecord {
  requestId: string;
  method: ChainTxMethod;
  taskKey: string;
  /** ★ 链上 escrow 合约地址 (关键状态) */
  escrowAddress: string;
  chainId: number;
  /** ★ txHash (关键状态; 空 = 交易从未发出) */
  txHash: string;
  /** ★ 确认数 (关键状态) */
  confirmations: number;
  /** ★ 最后检查块 (关键状态; 决定重启后从哪接着对账) */
  lastCheckedBlock: number | null;
  blockNumber: number | null;
  status: ChainSettlementStatus;
  /** ★ 是否不可信 (重组/被推翻) —— 一旦 true, 任何下游都不许当已结算 */
  suspect: boolean;
  suspectReason?: string;
  reason: string;
  resultHash?: string;
  eventMatched?: boolean | null;
  matchedEvent?: string;
  escrowState?: string | null;
  firstSeenAt: number;
  updatedAt: number;
  history: ChainTxHistoryEntry[];
}

export interface ChainStateFile {
  schemaVersion: number;
  updatedAt: number;
  /** 每个字段来源说明 (审计) */
  escrowAddresses: string[];
  records: Record<string, ChainTxRecord>;
}

export interface ChainReconciliationReport {
  checkedAt: number;
  /** 本次对账**范围内的记录总数** (不变式: considered === scanned + skippedFinalized.length) */
  considered: number;
  /** 真花了 RPC 去链上复核的记录数 */
  scanned: number;
  /** 现在链上已确认/最终确定的 */
  confirmed: Array<{ requestId: string; taskKey: string; txHash: string; status: ChainSettlementStatus; confirmations: number }>;
  /**
   * ★ 已最终确定 (finalized) 且未被标可疑 → 本轮**按设计跳过复核**的记录。
   *
   * 这不是「没对账」, 更不是「没结算」: 它们依然是已结算的, 只是这一轮没再花 RPC 复核一遍。
   * 调用方必须把 `confirmed` 和 `skippedFinalized` **合起来**看 (见 `reconciledSettledIds`);
   * 只看 `confirmed` 会把「已最终确定」误读成「链上什么都没有」——
   * 这正是共享忙链上 `verify-chain-bridge` 偶发假失败的根因 (那条记录的确认数早过 finalized 门槛)。
   */
  skippedFinalized: Array<{ requestId: string; taskKey: string; txHash: string; status: ChainSettlementStatus; confirmations: number; reason: string }>;
  /** 还没到确认门槛 */
  pending: Array<{ requestId: string; taskKey: string; txHash: string; confirmations: number; required: number }>;
  /** 被重组的 (不可信) */
  reorged: Array<{ requestId: string; taskKey: string; txHash: string; reason: string }>;
  /** 依然不知道的 (RPC 不可用 / receipt 读不到) */
  unknown: Array<{ requestId: string; taskKey: string; txHash: string; reason: string }>;
  /** 明确失败的 */
  reverted: Array<{ requestId: string; taskKey: string; txHash: string; reason: string }>;
  /** 本轮新标为不可信的 */
  newlySuspect: string[];
  rpcErrors: number;
}

/**
 * ★ 对账之后「仍然已结算」的 requestId 集合 = 本轮重算为 confirmed/finalized 的
 * **加上** 已 finalized 被按设计跳过的。
 *
 * 存在的理由: `skipFinalized` 是省 RPC 的优化, 但它的副作用是让 `confirmed` 少了人 ——
 * 用它来判断「这条还没对账 / 没结算」就会得出**错的**结论。这个函数把两种事实合起来,
 * 让「跳过」不可能被误读成「没结算」。
 */
export function reconciledSettledIds(report: ChainReconciliationReport): string[] {
  return Array.from(new Set([
    ...report.confirmed.map((r) => r.requestId),
    ...report.skippedFinalized.map((r) => r.requestId),
  ]));
}

export function chainStateDir(home?: string): string {
  return path.join(bolloonHome(home), 'chain');
}

export function chainStatePath(home?: string): string {
  return path.join(chainStateDir(home), 'chain-state.json');
}

export function emptyChainState(): ChainStateFile {
  return { schemaVersion: CHAIN_STATE_SCHEMA_VERSION, updatedAt: Date.now(), escrowAddresses: [], records: {} };
}

export function loadChainState(home?: string): ChainStateFile {
  const p = chainStatePath(home);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && typeof j === 'object' && j.records && typeof j.records === 'object') {
      return {
        schemaVersion: Number(j.schemaVersion) || CHAIN_STATE_SCHEMA_VERSION,
        updatedAt: Number(j.updatedAt) || 0,
        escrowAddresses: Array.isArray(j.escrowAddresses) ? j.escrowAddresses.map(String) : [],
        records: j.records,
      };
    }
  } catch { /* 没有 / 坏了 → 空状态 (不猜) */ }
  return emptyChainState();
}

export async function saveChainState(state: ChainStateFile, home?: string): Promise<void> {
  const dir = chainStateDir(home);
  await fsp.mkdir(dir, { recursive: true });
  const p = chainStatePath(home);
  const tmp = `${p}.tmp`;
  const out: ChainStateFile = { ...state, updatedAt: Date.now() };
  // escrowAddresses 从记录里重建 (别让两份真相漂开)
  out.escrowAddresses = Array.from(new Set(Object.values(out.records).map((r) => r.escrowAddress))).filter(Boolean);
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

/** 落盘一条记录 (幂等 upsert; 追加 history) */
export async function upsertChainTx(
  rec: Omit<ChainTxRecord, 'firstSeenAt' | 'updatedAt' | 'history' | 'suspect'> & {
    firstSeenAt?: number; history?: ChainTxHistoryEntry[]; suspect?: boolean;
  },
  home?: string,
): Promise<ChainTxRecord> {
  const state = loadChainState(home);
  const prev = state.records[rec.requestId];
  const now = Date.now();
  const merged: ChainTxRecord = {
    ...(prev || {}),
    ...rec,
    suspect: rec.suspect ?? prev?.suspect ?? false,
    firstSeenAt: prev?.firstSeenAt ?? rec.firstSeenAt ?? now,
    updatedAt: now,
    history: [
      ...(prev?.history || rec.history || []),
      { at: now, status: rec.status, txHash: rec.txHash, blockNumber: rec.blockNumber, confirmations: rec.confirmations, reason: rec.reason },
    ],
  };
  state.records[rec.requestId] = merged;
  await saveChainState(state, home);
  return merged;
}

/** 把一次判定落盘 (verdict → record) */
export async function recordVerdict(
  base: Pick<ChainTxRecord, 'requestId' | 'method' | 'taskKey' | 'escrowAddress' | 'chainId' | 'txHash'> & { resultHash?: string },
  verdict: ChainSettlementVerdict,
  home?: string,
): Promise<ChainTxRecord> {
  const suspectStatuses: ChainSettlementStatus[] = ['reorged'];
  const prev = loadChainState(home).records[base.requestId];
  const suspect = suspectStatuses.includes(verdict.status)
    ? true
    : (prev?.suspect || false);
  return upsertChainTx({
    ...base,
    resultHash: base.resultHash ?? prev?.resultHash,
    confirmations: verdict.confirmations ?? 0,
    lastCheckedBlock: verdict.latestBlock ?? prev?.lastCheckedBlock ?? null,
    // ★ 新判定没带块号时, **保留旧事实里的块号** —— "这笔曾记在哪个块"是重组复核的唯一证据;
    //   判定成 reorged 时判定器不带块号, 若这里覆盖成 null, 下一次对账就只能报 unknown
    //   (说不出"它是被回滚的"), 重组证据被自己抹掉。
    blockNumber: verdict.blockNumber ?? prev?.blockNumber ?? null,
    status: verdict.status,
    suspect,
    suspectReason: verdict.status === 'reorged' ? verdict.reason : prev?.suspectReason,
    reason: verdict.reason,
    eventMatched: verdict.eventMatched ?? null,
    matchedEvent: verdict.matchedEvent,
    escrowState: verdict.escrowState ?? null,
  }, home);
}

// ── 重启恢复 (纯读盘, 不发任何 RPC) ─────────────────────────────────────────

export interface ChainStateRecovery {
  total: number;
  /** 链上已确认或最终确定, 且未被标不可信 */
  settled: ChainTxRecord[];
  /** 上链了但确认数不够 */
  pending: ChainTxRecord[];
  /** 被重组 (不可信) */
  reorged: ChainTxRecord[];
  /** 状态未知 (RPC 读不到等) */
  unknown: ChainTxRecord[];
  /** 明确回滚 */
  reverted: ChainTxRecord[];
  /** 事件对不上 */
  eventMismatch: ChainTxRecord[];
  /** 任何被标不可信的记录 (哪怕状态看起来是 confirmed) */
  suspect: ChainTxRecord[];
  escrowAddresses: string[];
  lastCheckedBlock: number | null;
}

/**
 * 从**持久记录**重建状态 (进程重启后第一步就该调它)。
 * 不联网: 只用落盘的事实。`suspect` 记录一律不算 settled。
 */
export function recoverChainState(home?: string): ChainStateRecovery {
  const state = loadChainState(home);
  const all = Object.values(state.records);
  const settled = all.filter((r) => (r.status === 'confirmed' || r.status === 'finalized') && !r.suspect);
  const byStatus = (s: ChainSettlementStatus) => all.filter((r) => r.status === s);
  return {
    total: all.length,
    settled,
    pending: byStatus('pending'),
    reorged: byStatus('reorged'),
    unknown: byStatus('unknown').concat(byStatus('config_unavailable')),
    reverted: byStatus('reverted'),
    eventMismatch: byStatus('event_mismatch'),
    suspect: all.filter((r) => r.suspect),
    escrowAddresses: state.escrowAddresses,
    lastCheckedBlock: all.reduce<number | null>((acc, r) => (r.lastCheckedBlock != null && (acc == null || r.lastCheckedBlock > acc) ? r.lastCheckedBlock : acc), null),
  };
}

// ── 重组对账 (会发 RPC; 只动"还没最终确定"或"被标可疑"的记录) ────────────────

export interface ReconcileOptions {
  gate?: 'confirmed' | 'finalized';
  /** 只对账这些 requestId (缺省 = 全对账) */
  only?: string[];
  home?: string;
  /**
   * 已最终确定 (finalized) 且未被标可疑的**跳过链上复核** (省 RPC; 缺省 true)。
   *
   * ★ 跳过的记录会**显式出现在报告的 `skippedFinalized` 里** —— 绝不静默消失,
   *   因为「没出现在 confirmed 里」不等于「没结算」(见 reconciledSettledIds)。
   *   要强制每条都真去链上重算 (例如深重组排查), 传 `skipFinalized: false`。
   */
  skipFinalized?: boolean;
}

/**
 * ★ 对账: 把每条记录的**旧事实** (blockNumber/confirmations/eventMatched)
 * 交给唯一判定器重算一遍, 并按结果落盘。
 *
 * 报告**不许静默丢记录**: 范围内的每条记录要么进 `scanned` 的判定结果, 要么进
 * `skippedFinalized` (不变式: `considered === scanned + skippedFinalized.length`)。
 *
 * 重组两条路径都在这里显式检出:
 *   · 块号变了 / 链上查不到了 → verdict.status = 'reorged' → suspect = true
 *   · 事件"消失"了 (之前 eventMatched=true, 现在 false) → suspect = true
 */
export async function reconcileChainState(
  client: EscrowClient,
  opts: ReconcileOptions = {},
): Promise<ChainReconciliationReport> {
  const state = loadChainState(opts.home);
  const report: ChainReconciliationReport = {
    checkedAt: Date.now(), considered: 0, scanned: 0,
    confirmed: [], skippedFinalized: [], pending: [], reorged: [], unknown: [], reverted: [], newlySuspect: [], rpcErrors: 0,
  };
  const gate = opts.gate || 'confirmed';
  const shouldSkipFinalized = opts.skipFinalized !== false;

  for (const rec of Object.values(state.records)) {
    if (opts.only && !opts.only.includes(rec.requestId)) continue;
    report.considered++;
    const isFinalized = rec.status === 'finalized' && !rec.suspect;
    if (shouldSkipFinalized && isFinalized) {
      // ★ 显式记账: 「跳过」必须被说出来。否则报告会把「已最终确定」表达成「查不到这条」,
      //   调用方 (账单/验收) 就会把已结算当成没对账 —— 那是会撒谎的门。
      report.skippedFinalized.push({
        requestId: rec.requestId, taskKey: rec.taskKey, txHash: rec.txHash,
        status: rec.status, confirmations: rec.confirmations,
        reason: `已是 finalized 且未被标可疑 → 按设计跳过复核 (skipFinalized=true)。它仍是已结算, 只是本轮没重算`,
      });
      continue;
    }
    report.scanned++;

    const verdict = await verifyChainSettlement(client, {
      txHash: rec.txHash,
      gate,
      expect: rec.taskKey ? { kind: 'escrow', taskKey: rec.taskKey, resultHash: rec.resultHash } : undefined,
      recorded: { blockNumber: rec.blockNumber, confirmations: rec.confirmations, status: rec.status },
    });

    // 事件"消失" = 重组 (旧判定说对得上, 现在对不上)
    const eventVanished = rec.eventMatched === true && verdict.eventMatched === false && verdict.status === 'event_mismatch';

    const prevSuspect = rec.suspect;
    const effective: ChainSettlementVerdict = eventVanished
      ? { ...verdict, status: 'reorged', chainSettled: false, reason: `重组: 之前核上的事件 ${rec.matchedEvent || ''} 在链上消失了 (${verdict.reason})` }
      : verdict;

    const after = await recordVerdict(
      { requestId: rec.requestId, method: rec.method, taskKey: rec.taskKey, escrowAddress: rec.escrowAddress, chainId: rec.chainId, txHash: rec.txHash, resultHash: rec.resultHash },
      effective,
      opts.home,
    );
    // 事件消失也要显式标不可信 (recordVerdict 只对 'reorged' 自动标)
    if (eventVanished && !after.suspect) {
      const st = loadChainState(opts.home);
      if (st.records[rec.requestId]) {
        st.records[rec.requestId].suspect = true;
        st.records[rec.requestId].suspectReason = '事件在链上消失 (重组)';
        await saveChainState(st, opts.home);
      }
    }

    const now = loadChainState(opts.home).records[rec.requestId] || rec;
    if (now.suspect && !prevSuspect) report.newlySuspect.push(rec.requestId);

    if (!effective.rpcAvailable) report.rpcErrors++;
    const item = { requestId: rec.requestId, taskKey: rec.taskKey, txHash: rec.txHash };
    switch (effective.status) {
      case 'reorged': report.reorged.push({ ...item, reason: effective.reason }); break;
      case 'reverted': report.reverted.push({ ...item, reason: effective.reason }); break;
      case 'pending': report.pending.push({ ...item, confirmations: effective.confirmations ?? 0, required: effective.confirmationsRequired }); break;
      case 'confirmed':
      case 'finalized': report.confirmed.push({ ...item, status: effective.status, confirmations: effective.confirmations ?? 0 }); break;
      default:
        // unknown / config_unavailable / event_mismatch / not_attempted → 一律进 unknown (诚实: 不知道)
        report.unknown.push({ ...item, reason: effective.reason });
        break;
    }
  }
  return report;
}

/** 人工/程序显式标不可信 (绝不静默) */
export async function markSuspect(requestId: string, reason: string, home?: string): Promise<ChainTxRecord | null> {
  const state = loadChainState(home);
  const rec = state.records[requestId];
  if (!rec) return null;
  rec.suspect = true;
  rec.suspectReason = reason;
  rec.updatedAt = Date.now();
  rec.history.push({ at: rec.updatedAt, status: rec.status, txHash: rec.txHash, blockNumber: rec.blockNumber, confirmations: rec.confirmations, reason: `标记不可信: ${reason}` });
  await saveChainState(state, home);
  return rec;
}

export function getChainTxRecord(requestId: string, home?: string): ChainTxRecord | null {
  return loadChainState(home).records[requestId] || null;
}

export function findByTxHash(txHash: string, home?: string): ChainTxRecord | null {
  const h = String(txHash || '').toLowerCase();
  return Object.values(loadChainState(home).records).find((r) => String(r.txHash).toLowerCase() === h) || null;
}
