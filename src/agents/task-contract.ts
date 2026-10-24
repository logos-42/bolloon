/**
 * task-contract.ts — bolloon-task/1 任务协议 (Phase 1)
 *
 * 把「任务委派」与「交易协议」统一起来: agent_delegate 是快速委派, 这里给出**标准化任务生命周期**。
 * 设计要点 (leo 2026-09-21 计划 + 支付规则修正):
 *   · 任务状态与支付事实**严格分离** —— "已付款" 永远不等于 "任务成功"
 *   · requestId 幂等; taskId 生命周期; capability 匹配; budget 约束; signature 证明来源
 *   · 任务正文只走 P2P / 受保护链路, **绝不进公开脉冲**
 *   · 支付模式: manual | policy | autonomous | **agent-authorized** (受控自主签名)
 *   · 私钥只在**本机进程**内可用: 公共网页 / P2P 消息 / Pulse / 公开交易记录永远拿不到;
 *     每次签名写审计账本; 越权网络 / 越额 / 重复 requestId 一律拒绝
 *
 * 本文件是纯契约层 (类型 + 状态机 + 校验 + 签名 + 审计 + 公开投影), 不做 IO 编排。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { canonicalize } from './network-pulse.js';
import { bolloonHome } from '../bootstrap/env-loader.js';

export const TASK_PROTOCOL = 'bolloon-task/1';

// ── 任务状态机 ──────────────────────────────────────────────────────────────

export const TASK_STATES = [
  'discovered',        // 发现候选
  'quoted',            // 已报价
  'policy_denied',     // 策略拒绝 (终态)
  'submitted',         // 已签名发出
  'accepted',          // 对方接受
  'payment_required',  // 等付款
  'paying',            // 付款中
  'paid',              // 付款已提交 (≠ 成功)
  'running',           // 对方执行中
  'delivered',         // 已交付
  'verified',          // 已验真 (终态)
  'rejected',          // 对方拒绝 (终态)
  'failed',            // 失败 (终态)
  'cancelled',         // 取消 (终态)
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** 合法迁移图 (非法迁移一律**拒绝**, 不静默修正) */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  discovered: ['quoted', 'policy_denied', 'cancelled'],
  quoted: ['submitted', 'policy_denied', 'cancelled'],
  policy_denied: [],
  submitted: ['accepted', 'rejected', 'payment_required', 'failed', 'cancelled'],
  accepted: ['payment_required', 'paying', 'running', 'rejected', 'failed', 'cancelled'],
  payment_required: ['paying', 'cancelled', 'failed'],
  paying: ['paid', 'payment_required', 'failed'],          // 不确定 → 回到 payment_required 等对账 (不许当失败)
  paid: ['running', 'delivered', 'failed'],
  running: ['delivered', 'failed'],
  delivered: ['verified', 'failed'],                        // 交付后必须验真才算成功
  verified: [],
  rejected: [],
  failed: [],
  cancelled: [],
};

export const TASK_TERMINAL_STATES: TaskState[] = ['policy_denied', 'verified', 'rejected', 'failed', 'cancelled'];

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}
export function isTaskTerminal(s: TaskState): boolean {
  return TASK_TERMINAL_STATES.includes(s);
}
export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return Array.isArray(TASK_TRANSITIONS[from]) && TASK_TRANSITIONS[from].includes(to);
}
export function checkTaskMove(from: TaskState, to: TaskState): { ok: boolean; reason?: string } {
  if (!isTaskState(from) || !isTaskState(to)) return { ok: false, reason: `未知任务状态: ${String(from)} → ${String(to)}` };
  if (from === to) return { ok: true };
  if (!canTransitionTask(from, to)) {
    return { ok: false, reason: `非法任务迁移 ${from} → ${to} (拒绝, 不静默修正)` };
  }
  return { ok: true };
}

// ── 支付事实 (与任务状态分离) ───────────────────────────────────────────────

/** 与 `x402/settlement-state.ts` 的两层事实保持同一套取值 (单测里有对齐断言) */
export const TASK_PAYMENT_FACTS = [
  'unpaid', 'payment_submitted', 'payment_verified', 'partially_settled',
  'fully_settled', 'refund_pending', 'refunded', 'unknown',
] as const;
export type TaskPaymentFact = (typeof TASK_PAYMENT_FACTS)[number];

export function isPaymentFact(v: unknown): v is TaskPaymentFact {
  return typeof v === 'string' && (TASK_PAYMENT_FACTS as readonly string[]).includes(v);
}

/** local-dev 能到哪一步 (与 x402 红线一致: 永不 fully_settled) */
export function maxFactForMode(mode: 'facilitator' | 'local-dev' | 'none'): TaskPaymentFact {
  // 与 settlement-state 的 CHAIN_BACKED_FACTS / LOCAL_DEV_MAX_FACT 对齐 (单测有断言)
  return mode === 'facilitator' ? 'fully_settled' : mode === 'local-dev' ? 'payment_submitted' : 'unpaid';
}

/** "成功" 的唯一判据: 任务 verified ∧ 支付事实到链上口径 */
export function isTaskSuccessful(task: { state: TaskState; paymentFact: TaskPaymentFact }): boolean {
  return task.state === 'verified'
    && (task.paymentFact === 'fully_settled' || task.paymentFact === 'payment_verified');
}

// ── 支付模式 (含 leo 修正的 agent-authorized) ───────────────────────────────

export const PAYMENT_MODES = ['manual', 'policy', 'autonomous', 'agent-authorized'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export function isPaymentMode(v: unknown): v is PaymentMode {
  return typeof v === 'string' && (PAYMENT_MODES as readonly string[]).includes(v);
}

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface TaskBudget {
  maxAmount: string;                    // 正整数原子单位字符串 (与 x402 一致)
  currency: 'USDC' | 'ETH';
  network: string;
}

export interface TaskRequest {
  protocol: typeof TASK_PROTOCOL;
  taskId: string;
  requestId: string;
  capability: string;
  /** 任务正文 —— 只走 P2P/受保护链路, 不进公开投影 */
  instruction: string;
  budget?: TaskBudget;
  paymentMode: PaymentMode;
  deadline?: number;
  buyerDid: string;
  providerDid: string;
  signature: string;
}

export interface TaskQuote {
  protocol: typeof TASK_PROTOCOL;
  taskId: string;
  requestId: string;
  capability: string;
  amount: string;
  currency: 'USDC' | 'ETH';
  network: string;
  payTo?: string;
  validUntil?: number;
  providerDid: string;
  signature?: string;
}

export interface TaskAccept {
  protocol: typeof TASK_PROTOCOL;
  taskId: string;
  requestId: string;
  accepted: true;
  providerDid: string;
  etaMs?: number;
  signature?: string;
}

export interface TaskReject {
  protocol: typeof TASK_PROTOCOL;
  taskId: string;
  requestId: string;
  accepted: false;
  reason: string;
  signature?: string;
}

export interface TaskResult {
  protocol: typeof TASK_PROTOCOL;
  taskId: string;
  requestId: string;
  ok: boolean;
  summary: string;
  contentHash?: string;
  cid?: string;
  deliveredAt: number;
  signature?: string;
}

export type TaskFailureStage = 'discovery' | 'quote' | 'policy' | 'payment' | 'execution' | 'delivery' | 'verification';

export interface TaskFailure {
  protocol: typeof TASK_PROTOCOL;
  taskId: string;
  requestId: string;
  stage: TaskFailureStage;
  reason: string;
  retryable: boolean;
  signature?: string;
}

// ── 幂等 id ─────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** 由 (任务正文, capability, 买方) 确定性派生 requestId —— 重发不会产生第二笔付款 */
export function taskRequestId(input: { instruction: string; capability: string; buyerDid: string; salt?: string }): string {
  const h = sha256Hex(`${input.instruction.trim()}|${input.capability}|${input.buyerDid}|${input.salt || ''}`);
  return `treq-${h.slice(0, 16)}`;
}

export function newTaskId(now = Date.now()): string {
  return `task-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── 校验 ────────────────────────────────────────────────────────────────────

const ATOMIC_RE = /^[0-9]+$/;   // 原子单位必须是正整数 (浮点/负数/空一律拒)

export function validateTaskRequest(
  req: Partial<TaskRequest>,
  opts: { now?: number; maxSkewMs?: number; allowedNetworks?: string[]; maxAmountAtomic?: string } = {},
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const now = opts.now ?? Date.now();
  if (req?.protocol !== TASK_PROTOCOL) issues.push(`协议版本不对: ${String(req?.protocol)} (要 ${TASK_PROTOCOL})`);
  for (const k of ['taskId', 'requestId', 'capability', 'instruction', 'buyerDid', 'providerDid'] as const) {
    if (!String((req as any)?.[k] || '').trim()) issues.push(`缺字段 ${k}`);
  }
  if (!isPaymentMode(req?.paymentMode)) issues.push(`支付模式非法: ${String(req?.paymentMode)}`);
  if (req?.budget) {
    const b = req.budget;
    if (!ATOMIC_RE.test(String(b.maxAmount ?? ''))) issues.push(`budget.maxAmount 必须是正整数原子单位字符串 (收到 ${String(b.maxAmount)})`);
    if (b.currency !== 'USDC' && b.currency !== 'ETH') issues.push(`budget.currency 只支持 USDC/ETH (收到 ${String(b.currency)})`);
    if (!String(b.network || '').trim()) issues.push('budget.network 必填');
    if (opts.allowedNetworks?.length && !opts.allowedNetworks.includes(String(b.network))) issues.push(`网络不在允许列表: ${String(b.network)}`);
    if (opts.maxAmountAtomic && ATOMIC_RE.test(String(b.maxAmount ?? '')) && BigInt(b.maxAmount) > BigInt(opts.maxAmountAtomic)) {
      issues.push(`预算超过单笔上限: ${b.maxAmount} > ${opts.maxAmountAtomic}`);
    }
  }
  if (req?.deadline !== undefined) {
    if (!Number.isFinite(req.deadline)) issues.push('deadline 非法');
    else if (req.deadline <= now) issues.push(`deadline 已过期 (${req.deadline} <= ${now})`);
  }
  if (!String(req?.signature || '').trim()) issues.push('缺签名 (任务必须由发送方签名)');
  // 时钟漂移 (防重放): 只看 deadline 是否荒谬地久远
  const maxSkew = opts.maxSkewMs ?? 24 * 60 * 60 * 1000;
  if (req?.deadline !== undefined && req.deadline > now + maxSkew * 30) issues.push('deadline 过远 (疑似伪造)');
  return { ok: issues.length === 0, issues };
}

/** 报价与请求是否自洽 (agent 不得接受被篡改的报价) */
export function validateQuoteAgainstRequest(quote: Partial<TaskQuote>, req: Partial<TaskRequest>, opts: { maxAmountAtomic?: string } = {}): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (quote?.protocol !== TASK_PROTOCOL) issues.push(`报价协议版本不对: ${String(quote?.protocol)}`);
  if (!quote?.taskId || quote.taskId !== req?.taskId) issues.push('报价的 taskId 与请求不一致 (可能被篡改)');
  if (!quote?.requestId || quote.requestId !== req?.requestId) issues.push('报价的 requestId 与请求不一致 (回执不能跨请求复用)');
  if (quote?.capability !== req?.capability) issues.push(`报价能力与请求不一致: ${String(quote?.capability)} ≠ ${String(req?.capability)}`);
  if (!ATOMIC_RE.test(String(quote?.amount ?? ''))) issues.push(`报价金额必须是正整数原子单位字符串 (收到 ${String(quote?.amount)})`);
  if (req?.budget) {
    if (quote?.currency !== req.budget.currency) issues.push('报价币种与预算不一致');
    if (quote?.network !== req.budget.network) issues.push('报价网络与预算不一致');
    if (ATOMIC_RE.test(String(quote?.amount ?? '')) && BigInt(String(quote?.amount)) > BigInt(req.budget.maxAmount)) {
      issues.push(`报价超过任务预算: ${quote.amount} > ${req.budget.maxAmount}`);
    }
  }
  if (opts.maxAmountAtomic && ATOMIC_RE.test(String(quote?.amount ?? '')) && BigInt(String(quote?.amount)) > BigInt(opts.maxAmountAtomic)) {
    issues.push(`报价超过单笔上限: ${quote.amount} > ${opts.maxAmountAtomic}`);
  }
  return { ok: issues.length === 0, issues };
}

/** 接收方去重: 同一个 requestId 只接受一次 (重复请求不得重复执行/重复收费) */
export function dedupeInbox<T extends { requestId: string }>(inbox: T[], incoming: T): { dup: boolean; reason?: string } {
  const hit = inbox.find((x) => x.requestId === incoming.requestId);
  return hit ? { dup: true, reason: `requestId ${incoming.requestId} 已在收件箱 (幂等: 不重复接受)` } : { dup: false };
}

// ── 签名 (受控自主签名: 私钥只在本机进程) ───────────────────────────────────

/** 签名覆盖内容: 去掉 signature 字段后的规范化 JSON */
export function signablePayload<T extends { signature?: string }>(payload: T): string {
  const { signature, ...rest } = payload as any;
  void signature;
  return canonicalize(rest);
}

export async function signTaskEnvelope<T extends { signature?: string }>(
  payload: T,
  keypair: any,
): Promise<T & { signature: string }> {
  const { KeyManager } = await import('@diap/sdk');
  // 与 src/network/agent-network.ts 一致: 签名输入是 Uint8Array
  const bytes = new TextEncoder().encode(signablePayload(payload));
  const sig: any = await (KeyManager as any).sign(keypair, bytes);
  return { ...payload, signature: typeof sig === 'string' ? sig : Buffer.from(sig).toString('base64') };
}

/**
 * 信封里的签名是 **base64 字符串** (便于走 JSON/P2P), 但 @diap/sdk 的
 * `KeyManager.verify` 要的是 64 字节 `Uint8Array` (ed25519) —— 必须解码回去。
 * 同时容忍 128 位十六进制写法 (老格式)。
 */
export function decodeSignature(sig: string): Uint8Array {
  if (/^[0-9a-f]{128}$/i.test(sig)) return new Uint8Array(Buffer.from(sig, 'hex'));
  return new Uint8Array(Buffer.from(sig, 'base64'));
}

export async function verifyTaskEnvelope(payload: { signature?: string }, publicKey: any): Promise<boolean> {
  try {
    if (!payload?.signature) return false;
    const { KeyManager } = await import('@diap/sdk');
    const bytes = new TextEncoder().encode(signablePayload(payload as any));
    return await (KeyManager as any).verify(publicKey, bytes, decodeSignature(payload.signature));
  } catch {
    return false;
  }
}

// ── 钱包 / 签名授权闸 (Phase 3 核心, 这里先落成纯函数) ───────────────────────

export interface WalletSignRequest {
  mode: PaymentMode;
  /** 用户是否在本地显式开启了自主签名 */
  agentAuthorized: boolean;
  amountAtomic: string;
  network: string;
  capability: string;
  requestId: string;
  /** 已签名过的 requestId (幂等: 同一个只签一次) */
  signedRequestIds?: string[];
  /** 策略 */
  allowedNetworks?: string[];
  allowedCapabilities?: string[];
  maxPerTxAtomic?: string;
  spentTodayAtomic?: string;
  dailyLimitAtomic?: string;
  /** 钱包是否可用 */
  walletAvailable: boolean;
  /** 是否 local-dev (local-dev 不允许被当成链上结算) */
  localDev?: boolean;
}

export interface WalletSignDecision { allowed: boolean; reason?: string; checks: Record<string, boolean> }

/**
 * **受控自主签名** 的唯一放行判据。任何一条不满足 → 拒绝签名 (fail-closed)。
 * 注意: 私钥永远不进这里 —— 这里只决定"允不允许让本机钱包模块去签"。
 */
export function authorizeWalletSignature(req: WalletSignRequest): WalletSignDecision {
  const checks: Record<string, boolean> = {
    modeIsAutonomous: req.mode === 'autonomous' || req.mode === 'agent-authorized',
    agentAuthorized: req.agentAuthorized === true,
    walletAvailable: req.walletAvailable === true,
    networkAllowed: !req.allowedNetworks?.length || req.allowedNetworks.includes(req.network),
    capabilityAllowed: !req.allowedCapabilities?.length || req.allowedCapabilities.includes(req.capability),
    underPerTx: !req.maxPerTxAtomic || (ATOMIC_RE.test(req.amountAtomic) && BigInt(req.amountAtomic) <= BigInt(req.maxPerTxAtomic)),
    underDaily: !req.dailyLimitAtomic || BigInt(req.spentTodayAtomic || '0') + BigInt(ATOMIC_RE.test(req.amountAtomic) ? req.amountAtomic : '0') <= BigInt(req.dailyLimitAtomic),
    notDuplicate: !(req.signedRequestIds || []).includes(req.requestId),
    amountIsInteger: ATOMIC_RE.test(req.amountAtomic),
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (failed.length) return { allowed: false, reason: `拒绝签名: ${failed.join(', ')}`, checks };
  return { allowed: true, checks };
}

// ── 签名审计账本 (每次签名都要可查) ─────────────────────────────────────────

export interface SignatureAuditEntry {
  at: number;
  kind: 'task_payment' | 'task_result' | 'task_request' | 'wallet_payload';
  mode: PaymentMode;
  requestId: string;
  taskId?: string;
  amountAtomic?: string;
  currency?: string;
  network?: string;
  capability?: string;
  signerFingerprint: string;
  /** 只记摘要, 不记私钥、不记任务正文 */
  payloadDigest: string;
}

// 2026-10-24 (回归修): 2bfb463 的 env 收口把 h 参数吞了 —— recordSignatureAudit/readSignatureAudit
//   传了 home 也写进真实 ~/.bolloon (task-contract / chain-wallet-authorization / network-pulse-consistency 三条红,
//   TDD 的隔离 temp home 全失效)。语义恢复: 传 h ⇒ <h>/.bolloon · 不传 ⇒ bolloonHome()。
const auditFile = (h?: string): string =>
  path.join(h ? path.join(h, '.bolloon') : bolloonHome(), 'wallet-signatures.jsonl');

export async function recordSignatureAudit(entry: Omit<SignatureAuditEntry, 'at' | 'payloadDigest'> & { payloadDigest?: string }, h?: string): Promise<void> {
  const row: SignatureAuditEntry = { at: Date.now(), payloadDigest: entry.payloadDigest || '', ...entry } as SignatureAuditEntry;
  try {
    fs.mkdirSync(path.dirname(auditFile(h)), { recursive: true });
    fs.appendFileSync(auditFile(h), JSON.stringify(row) + '\n', 'utf8');
    // ★ 公开观察层: 钱包签名是一次真实活动 → 计一次签名 (fire-and-forget, 只计数不记内容)
    try {
      const np: any = await import('./network-pulse.js');
      void np.recordNetworkEvent({
        type: 'wallet_signed',
        did: entry.signerFingerprint,
        agentId: entry.taskId || entry.requestId,
        taskId: entry.taskId || entry.requestId,
        signed: true,
      }, h);
    } catch { /* noop */ }
  } catch { /* 审计写失败不该炸主流程, 但调用方应看到 */ }
}

export async function readSignatureAudit(h?: string, limit = 50): Promise<SignatureAuditEntry[]> {
  try {
    const lines = fs.readFileSync(auditFile(h), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as SignatureAuditEntry);
  } catch {
    return [];
  }
}

/** 审计条目里绝不允许出现的东西 */
export const AUDIT_FORBIDDEN_KEYS = ['privateKey', 'secret', 'instruction', 'taskText', 'mnemonic', 'seed'];

export function assertAuditSafe(entry: unknown): string[] {
  const issues: string[] = [];
  const walk = (v: any, p: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (AUDIT_FORBIDDEN_KEYS.includes(k)) issues.push(`${p}.${k} 不该出现在签名审计里`);
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(entry, '$');
  return issues;
}

// ── 公开投影 (Phase 5 用: 匿名经济活动, 不含私人信息) ────────────────────────

export type AmountBucket = 'tiny' | 'small' | 'medium' | 'large';

/** 金额只以**区间**对外 (不暴露精确金额) */
export function amountBucket(amountAtomic: string): AmountBucket {
  if (!ATOMIC_RE.test(amountAtomic)) return 'tiny';
  const n = Number(amountAtomic);
  if (n < 10_000) return 'tiny';        // < 0.01 USDC
  if (n < 100_000) return 'small';      // < 0.1
  if (n < 1_000_000) return 'medium';   // < 1
  return 'large';
}

export interface TaskPublicSummary {
  kind: 'task_posted' | 'task_accepted' | 'task_completed' | 'trade_settled' | 'trade_verified';
  capabilityGroup: string;
  amountBucket?: AmountBucket;
  settlement: 'chain' | 'local-dev' | 'none';
  state: TaskState;
}

/**
 * 任务的**公开摘要**: 只保留可公开的粗粒度事实。
 * 绝不包含: DID / 任务正文 / 精确金额 / 交易哈希 / 私有 Agent 名。
 */
export function toPublicSummary(task: {
  state: TaskState;
  capability: string;
  amountAtomic?: string;
  paymentFact?: TaskPaymentFact;
  paymentMode?: 'facilitator' | 'local-dev' | 'none';
}, opts: { capabilityGroupOf?: (raw: string) => string } = {}): TaskPublicSummary {
  const group = opts.capabilityGroupOf ? opts.capabilityGroupOf(task.capability) : 'other';
  const settlement: TaskPublicSummary['settlement'] =
    task.paymentFact === 'fully_settled' ? 'chain'
      : task.paymentFact === 'payment_submitted' || task.paymentMode === 'local-dev' ? 'local-dev'
        : 'none';
  const kind: TaskPublicSummary['kind'] =
    task.state === 'verified' ? 'trade_verified'
      : task.state === 'delivered' ? 'task_completed'
        : task.state === 'accepted' || task.state === 'running' ? 'task_accepted'
          : 'task_posted';
  return {
    kind,
    capabilityGroup: group,
    ...(task.amountAtomic ? { amountBucket: amountBucket(task.amountAtomic) } : {}),
    settlement,
    state: task.state,
  };
}
