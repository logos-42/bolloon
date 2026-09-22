/**
 * transaction-protocol.ts — 最小 Agent 资源交易协议 (Phase 0 冻结, 2026-09-16)
 *
 * 设计来自 `docs/design-layer.md` / `docs/design-layer2.md` 的"Agent 资源交易闭环" +
 * leo 的最小闭环规格 (跨境信息 0.001 USDC / Base Sepolia / x402 exact / 内容哈希+卖方签名+回执绑定)。
 *
 * 两条不可混淆的红线 (整个协议的可信度都建立在这上面):
 *   ① **本机联调 ≠ 真实支付**: `paymentMode='local-dev'` 的交易**永远不能**标 `verified`
 *      —— 它只是"协议闭环通过"(链上没动过钱), 验真分档最高到 `self-attested`。
 *   ② **支付成功 ≠ 交易成功**: 付款后交付失败是 `delivery_failed`, 验真失败是 `verification_failed`,
 *      两者都**不是**成功; 付款回执不能脱离原内容复用。
 */

import { sha256Hex } from './paid-info-protocol.js';
// 类型专用导入 (会被擦除, 不产生运行时循环依赖)
import type { TransactionMilestone, DisputeRecord } from './milestone-settlement.js';

// ── 资源元数据 (交易的输入侧) ────────────────────────────────────────────────

export interface InfoItemMetadata {
  itemId: string;
  title: string;
  category: string;
  /** 正文内容哈希 (卖方在发布时算好) */
  contentHash: string;
  source?: { kind?: string; refs?: string[]; note?: string };
  providerDid: string;
  /** 人可读价格 (如 "0.001") */
  price: string;
  currency: string;
  network: string;
  payTo: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── 交易状态 (leo 的 10 态; 括号里是 design-layer2 §三 九态机的对应) ──────────

export const TRANSACTION_STATUSES = [
  'discovered',        // 发现资源 (≈ Discovered)
  'quoted',            // 拿到报价/402 要求 (≈ Quoted)
  'policy_denied',     // 策略拒绝: 不解密/不签名/不扣预算/不交付
  'payment_required',  // 需要付款
  'paying',            // 付款中 (≈ Authorized+Accepted+Executing)
  'settled',           // 链上/联调结算完成
  'delivered',         // 内容已交付 (≈ Delivered)
  'verified',          // 全部条件满足 (仅 facilitator 真实结算可达)
  'delivery_failed',   // 付了钱但没拿到合格交付
  'verification_failed', // 付了钱+拿到内容但验真不过
  'failed',            // 其它失败
] as const;
export type TransactionStatus = typeof TRANSACTION_STATUSES[number];

export type PaymentMode = 'facilitator' | 'local-dev' | 'none' | 'escrow';
/** 与 paid-info-protocol 的验真分档一致 */
export type TrustLevel = 'verified' | 'self-attested' | 'content-only' | 'unverified';

export interface TransactionEvent {
  at: string;
  kind: string;
  detail?: string;
}

export interface TransactionRecord {
  transactionId: string;
  /** 幂等键: 同一 requestId 重放不得重复付款 */
  requestId: string;
  itemId: string;
  buyerDid: string;
  providerDid: string;
  price?: string;
  amount?: string;
  currency?: string;
  network?: string;
  payTo?: string;
  paymentMode: PaymentMode;
  paymentReceipt?: string;
  txHash?: string;
  receiptHash?: string;
  /** 卖方声明的正文哈希 (来自元数据/信封) */
  contentHash?: string;
  /** 买方实际收到的正文字节哈希 (交付校验用; 协议规范化哈希) */
  deliveryHash?: string;
  /** 交付正文字节的 sha256 (盘上正文重算可比; 与协议层规范化哈希分开) */
  deliveryBytesHash?: string;
  verificationTrust?: TrustLevel;
  /** 链上是否真的结算过 (local-dev 永远 false) */
  chainSettled: boolean;
  /** 协议层验真是否通过 (与 chainSettled 分开记, 不许混为一谈) */
  protocolVerified?: boolean;
  status: TransactionStatus;
  /** 记录 schema 版本 (v2 = 两层状态: status + settlementFact, 见 settlement-state.ts) */
  schemaVersion?: number;
  /** 结算事实 (钱到底动没动): unpaid / payment_submitted / payment_verified / partially_settled / fully_settled / refund_pending / refunded / unknown */
  settlementFact?: string;
  /** 里程碑 (分阶段服务; Phase 4) */
  milestones?: TransactionMilestone[];
  /** 争议记录 (Phase 4; 一旦存在 → 不许重付/不许 verified/不许静默关闭) */
  dispute?: DisputeRecord;
  /** 责任候选 (机器只给候选, 不做赔偿判决) */
  responsibility?: { type: string; reason: string; evidence: string[] };
  /** 资源执行证据 (Phase 2: 买到的是可执行资源时才可能有) */
  execution?: { ok: boolean; tool?: string; startedAt?: string; durationMs?: number; outputHash?: string; schemaOk?: boolean; sourceDeclared?: boolean; reason?: string };
  /**
   * 资源侧结果 (2026-09-18 M1–M4 收口): 一眼能看出"钱花了之后资源到底成没成",
   * 不用从一堆事件里反推。失败阶段也钉在这里 (M4 归责用)。
   */
  resourceOutcome?: {
    installed: boolean;
    executed: boolean;
    outputContract: 'pass' | 'fail' | 'not_run';
    criteriaHit: boolean;
    failureStage?: 'install' | 'execute' | 'output_contract';
  };
  /** Goal 判据是否命中 (verified 门的一项) */
  goalCriteriaMet?: boolean;
  policyDecision?: { allowed: boolean; reason?: string; dailySpent?: number };
  failureReason?: string;
  /** 与长期执行挂钩 (支付必须成为可审计的 Run 步骤) */
  goalId?: string;
  runId?: string;
  startedAt: string;
  settledAt?: string;
  deliveredAt?: string;
  verifiedAt?: string;
  events: TransactionEvent[];
}

export function newTransactionId(seed = Date.now().toString(36)): string {
  return `tx-${seed}-${Math.random().toString(36).slice(2, 8)}`;
}

export function event(kind: string, detail?: string): TransactionEvent {
  return { at: new Date().toISOString(), kind, detail };
}

/** 回执哈希 = 对回执原文取哈希 (信封里 receiptHash 必须等于它) */
export function computeReceiptHash(receipt: string): string {
  return sha256Hex(String(receipt || ''));
}

/** 交付哈希 = 对买方拿到的正文取哈希 */
export function computeDeliveryHash(content: string): string {
  return sha256Hex(String(content ?? ''));
}

/**
 * 最小成功条件 (全部满足才算 `verified`):
 *   支付成功 + 收到内容 + contentHash 匹配 + 卖方签名验证通过 + 回执哈希与信封绑定
 *   + itemId/payTo/amount/network 全部一致 + **链上真的结算过**。
 * 本机联调 (chainSettled=false) 最高只能是 `delivered` + `self-attested`。
 */
export function evaluateTransactionSuccess(rec: TransactionRecord): { success: boolean; reason: string; chainRequired: boolean } {
  if (rec.paymentMode === 'local-dev' || rec.chainSettled !== true) {
    return { success: false, reason: '本机联调: 协议闭环成立, 但链上没有真实结算 → 不能判 verified', chainRequired: true };
  }
  if (!rec.txHash) return { success: false, reason: '没有 txHash', chainRequired: true };
  if (!rec.contentHash || !rec.deliveryHash) return { success: false, reason: '缺少内容哈希或交付哈希', chainRequired: true };
  if (rec.contentHash !== rec.deliveryHash) return { success: false, reason: '内容哈希不匹配 (内容被换过)', chainRequired: true };
  if (rec.verificationTrust !== 'verified') return { success: false, reason: `验真分档是 ${rec.verificationTrust || '未验'}, 不是 verified`, chainRequired: true };
  if (!rec.receiptHash) return { success: false, reason: '缺少回执哈希 (回执与信封未绑定)', chainRequired: true };
  return { success: true, reason: '支付完成 + 内容匹配 + 卖方签名通过 + 回执绑定 + 字段一致 + 链上结算', chainRequired: true };
}

/** 402 要求与元数据是否自洽 (篡改任何一项都必须拒绝) */
export function validatePaymentRequirements(input: {
  requirements: { payTo?: string; amount?: string; network?: string; asset?: string; extra?: any };
  metadata: Partial<InfoItemMetadata>;
  expected?: { itemId?: string; maxAmount?: string; currency?: string; networks?: string[] };
}): { ok: boolean; reason?: string } {
  const r = input.requirements || {};
  const m = input.metadata || {};
  const exp = input.expected || {};
  if (exp.itemId && m.itemId && exp.itemId !== m.itemId) return { ok: false, reason: `402 的 itemId (${m.itemId}) 与预期 (${exp.itemId}) 不一致` };
  // ★ 402 自带的 itemId 也要与 metadata/预期对齐 (与 payTo/network 的检查对称):
  //   真跑抓到过 —— 402 声称另一条资源而 metadata 正常时, 原来完全不查。
  const rItem = String((r as any).itemId || (r as any).extra?.itemId || '');
  if (rItem) {
    if (m.itemId && rItem !== String(m.itemId)) return { ok: false, reason: `402 的 itemId (${rItem}) 与元数据 (${m.itemId}) 不一致 (被篡改?)` };
    if (exp.itemId && rItem !== String(exp.itemId)) return { ok: false, reason: `402 的 itemId (${rItem}) 与预期 (${exp.itemId}) 不一致` };
  }
  if (!r.payTo) return { ok: false, reason: '402 缺少收款地址 payTo' };
  if (m.payTo && String(r.payTo).toLowerCase() !== String(m.payTo).toLowerCase()) return { ok: false, reason: '402 的 payTo 与元数据不一致 (被篡改?)' };
  if (!r.amount) return { ok: false, reason: '402 缺少金额' };
  if (!r.network) return { ok: false, reason: '402 缺少网络' };
  if (m.network && String(r.network) !== String(m.network)) return { ok: false, reason: `402 的网络 (${r.network}) 与元数据 (${m.network}) 不一致` };
  if (exp.networks && !exp.networks.includes(String(r.network))) return { ok: false, reason: `网络 ${r.network} 不在允许网络里 (${exp.networks.join(', ')})` };
  if (exp.maxAmount) {
    const a = Number(r.amount) / 1e6;                 // USDC 原子单位 (6 位小数)
    const max = Number(exp.maxAmount);
    if (Number.isFinite(a) && Number.isFinite(max) && a > max) return { ok: false, reason: `402 金额 ${a} 超过允许上限 ${max}` };
  }
  return { ok: true };
}
