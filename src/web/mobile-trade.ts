/**
 * mobile-trade.ts — 手机端资源交易工作流 (Agent Economic Loop E2/E3/E4)
 *
 *   遵循 docs/wiki/agent-economic-protocol.md:
 *     E2 x402 支付闭环 — buyer → POST /agent/service/call → 402 Payment Required(price+wallet)
 *                        → x402_pay → 200 service result
 *     E3 Policy Engine  — 单笔限额 / 日累计预算 / 收款方白名单 / 服务白名单 / 信誉阈值
 *                        (纯函数判定 allow|confirm|deny, 非 AI 决策; 私钥隔离 — LLM 不见私钥)
 *     E4 Reputation     — 结算后 tasks++ / success|failed|disputed → score = success/tasks
 *
 *   手机端离线可用: 交易记录/信誉落 localStorage (可注入 storage 便于单测).
 *   全部外部依赖可注入 (fetchImpl / payFn / walletForAgent / policy), 单测无需浏览器.
 *   本模块被 mobile-core.ts import → esbuild bundle 进 mobile-core.js.
 */

// ============ 类型 ============

export type PolicyDecision = 'allow' | 'confirm' | 'deny';
export type ServiceOutcome = 'success' | 'failed' | 'disputed';
export type TradeStatus = 'success' | 'failed' | 'denied' | 'pending_approval' | 'replayed';

export interface ServicePrice {
  amount: number | string;
  currency: string;          // USDC / ETH / token
  per?: string;              // query / access / license
  token?: string;
}

/** 服务方 (provider) 声明 — 对应 E1 Registry 的 service 条目 */
export interface ServiceRef {
  name: string;
  agentId?: string;          // provider DID
  payTo?: string;            // 收款钱包 (provider wallet)
  price: ServicePrice;
  endpoint?: string;         // 服务 URL (agent:// 或 http(s)://)
  reputation?: number;       // 0..1 服务方信誉 (E4)
}

export interface ServiceRequest {
  requestId?: string;        // 防重放 (缺省自动生成)
  endpoint?: string;         // 覆盖 service.endpoint
  quantity?: number;         // 默认 1
  body?: unknown;            // 请求体
  buyer?: string;            // buyer agentId (钱包授权用)
  timestamp?: number;
}

export interface ServiceQuote {
  ok: boolean;
  error?: string;
  serviceName: string;
  amount: number;
  currency: string;
  payTo: string;
  per?: string;
  quantity: number;
  requestId: string;
  /** 防重放指纹: requestId|service|amount|currency|ts */
  fingerprint: string;
  ts: number;
  endpoint?: string;
}

export interface TradePolicy {
  /** 单笔上限 */
  perTransactionLimit: number;
  /** 日累计预算 */
  dailyLimit: number;
  /** 允许的收款方 (空 = 全部允许) */
  allowedRecipients: string[];
  /** 允许的服务 (空 = 全部允许) */
  allowedServices: string[];
  /** 服务方信誉阈值 (0..1); 低于则 deny */
  reputationThreshold: number;
  /** 超过该金额 → confirm (人工审批); 缺省不触发 confirm */
  confirmAbove?: number;
}

export interface PolicyIntent {
  payTo: string;
  amount: number;
  currency: string;
  service: string;
  requestId?: string;
  reputation?: number;
  timestamp?: number;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  reason: string;
  rule: string;
  dailySpent: number;
}

export interface PolicyOpts {
  dailySpent?: number;
  /** 覆盖 policy.confirmAbove */
  requireApprovalAbove?: number;
}

export interface TradeRecord {
  requestId: string;
  service: string;
  amount: number;
  currency: string;
  txHash?: string;
  status: TradeStatus;
  ts: number;
  payTo?: string;
  reason?: string;
  fingerprint?: string;
}

export interface TradeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Reputation {
  tasks: number;
  success: number;
  failed: number;
  disputed: number;
  score: number;
}

export interface ReputationStore {
  get(key: string): Reputation | Promise<Reputation>;
  set(key: string, rep: Reputation): void | Promise<void>;
}

export interface PaySpec { amount: number; currency: string; to: string; memo?: string; network?: string }
export interface PayResult { success: boolean; txHash?: string; error?: string; proof?: string }

export interface AgentWalletInfo {
  exists: boolean;
  agentId?: string;
  wallets: Array<{ id: string; name?: string; address: string; unlocked?: boolean }>;
  error?: string;
}

export interface PaymentRequirement { amount: number; currency: string; payTo: string; network?: string }

export interface TradeDeps {
  fetchImpl?: typeof fetch;
  /** 支付执行器 (优先级最高) — 一般绑定手机钱包 signer 或桌面 x402 */
  payFn?: (spec: PaySpec) => Promise<PayResult>;
  /** 桌面 x402 支付 (与 getPrivateKey 组合为默认 payFn) — 签名隔离: 仅此处见私钥 */
  x402Pay?: (params: { privateKey: string; amount: string; to: string; currency?: string; network?: string; memo?: string }) => Promise<{ success: boolean; txHash?: string; error?: string }>;
  /** 取已解锁钱包私钥 (返回 null = 未解锁) */
  getPrivateKey?: (walletId: string) => Promise<string | null> | string | null;
  /** 某 agent 被授权可用的钱包 (mobile-wallet.walletForAgent) */
  walletForAgent?: (agentId: string) => Promise<AgentWalletInfo> | AgentWalletInfo;
  network?: string;
  policy?: TradePolicy;
  /** 今日已花费 (缺省从交易记录统计) */
  dailySpent?: () => Promise<number> | number;
  now?: () => number;
  rid?: () => string;
  storage?: TradeStorage;
  reputationStore?: ReputationStore;
  /** 查服务方信誉 (0..1) — 缺省用 service.reputation */
  getReputation?: (service: ServiceRef) => Promise<number> | number;
}

export interface CallServiceParams {
  service: ServiceRef;
  request?: ServiceRequest;
  deps?: TradeDeps;
}

export interface CallServiceResult {
  ok: boolean;
  requestId: string;
  status: TradeStatus;
  result?: unknown;
  txHash?: string;
  paid?: number;
  currency?: string;
  needsApproval?: boolean;
  denied?: boolean;
  replayed?: boolean;
  reason?: string;
  error?: string;
  quote?: ServiceQuote;
  verdict?: PolicyVerdict;
}

export interface SettleAndRateParams {
  /** true→success / false→failed / 显式 'success'|'failed'|'disputed' */
  ok: boolean | ServiceOutcome;
  service: ServiceRef | { name?: string; agentId?: string; payTo?: string };
  deps?: TradeDeps;
}

export interface SettleResult {
  ok: boolean;
  key: string;
  outcome: ServiceOutcome;
  reputation: Reputation;
  score: number;
  error?: string;
}

// ============ 常量 ============

export const TRADE_STORE_KEY = 'bolloon_trades';
export const REP_STORE_KEY = 'bolloon_service_reputation';

export const DEFAULT_TRADE_POLICY: TradePolicy = {
  perTransactionLimit: 1,       // 单笔 ≤ 1
  dailyLimit: 10,               // 日累计 ≤ 10
  allowedRecipients: [],
  allowedServices: [],
  reputationThreshold: 0,
};

const ZERO_REP: Reputation = { tasks: 0, success: 0, failed: 0, disputed: 0, score: 0 };

// ============ 基础设施 (storage / 工具) ============

function ls(): TradeStorage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage as unknown as TradeStorage;
  } catch { /* 无 localStorage */ }
  return null;
}

/** 无 localStorage 时的进程内回退 (Node 测试/SSR) */
const mem = new Map<string, string>();
const MEM_STORAGE: TradeStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
};

function storageOf(injected?: TradeStorage): TradeStorage {
  return injected || ls() || MEM_STORAGE;
}

function nowDefault(): number { return Date.now(); }

function ridDefault(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

function numOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : NaN;
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

function serviceKey(service: { name?: string; agentId?: string; payTo?: string }): string {
  return String(service?.agentId || service?.payTo || service?.name || 'unknown');
}

// ============ E3: Policy Engine (纯函数) ============

/**
 * 纯函数策略判定 — 非 AI 决策 (对应 E3 / economic-policy.ts).
 * 顺序: 非法金额 → 单笔限额 → 收款方白名单 → 服务白名单 → 信誉阈值 → 日累计 → confirm 软阈值 → allow.
 */
export function evaluatePolicy(intent: PolicyIntent, policy: TradePolicy = DEFAULT_TRADE_POLICY, opts: PolicyOpts = {}): PolicyVerdict {
  const dailySpent = numOf(opts.dailySpent) || 0;
  const amount = numOf(intent?.amount);
  const payTo = String(intent?.payTo || '').toLowerCase();
  const service = String(intent?.service || '').toLowerCase();
  const base = { dailySpent };

  if (!Number.isFinite(amount) || amount < 0) {
    return { decision: 'deny', reason: `非法金额: ${String(intent?.amount)}`, rule: 'invalid_amount', ...base };
  }
  if (!payTo) {
    return { decision: 'deny', reason: '缺少收款方 (payTo)', rule: 'missing_payto', ...base };
  }
  // 1. 单笔限额
  if (amount > policy.perTransactionLimit) {
    return { decision: 'deny', reason: `单笔超限: ${amount} > ${policy.perTransactionLimit}`, rule: 'per_transaction_limit', ...base };
  }
  // 2. 收款方白名单 (空 = 全部允许)
  if (policy.allowedRecipients.length > 0 && !policy.allowedRecipients.some((r) => String(r).toLowerCase() === payTo)) {
    return { decision: 'deny', reason: `收款方不在白名单: ${payTo}`, rule: 'recipient_whitelist', ...base };
  }
  // 3. 服务白名单 (空 = 全部允许)
  if (policy.allowedServices.length > 0 && service && !policy.allowedServices.some((s) => String(s).toLowerCase() === service)) {
    return { decision: 'deny', reason: `服务不在白名单: ${service}`, rule: 'service_whitelist', ...base };
  }
  // 4. 信誉阈值
  const rep = numOf(intent?.reputation);
  const repVal = Number.isFinite(rep) ? rep : 0;
  if (policy.reputationThreshold > 0 && repVal < policy.reputationThreshold) {
    return { decision: 'deny', reason: `服务方信誉不足: ${repVal} < ${policy.reputationThreshold}`, rule: 'reputation_threshold', ...base };
  }
  // 5. 日累计预算
  if (dailySpent + amount > policy.dailyLimit) {
    return { decision: 'deny', reason: `日累计超限: ${dailySpent} + ${amount} > ${policy.dailyLimit}`, rule: 'daily_limit', ...base };
  }
  // 6. confirm 软阈值 (人工审批, 不自动签名)
  const confirmAbove = opts.requireApprovalAbove ?? policy.confirmAbove;
  if (confirmAbove !== undefined && Number.isFinite(confirmAbove) && amount > confirmAbove) {
    return { decision: 'confirm', reason: `金额 ${amount} > 审批阈值 ${confirmAbove}, 需人工批准`, rule: 'confirm_above', ...base };
  }
  return { decision: 'allow', reason: '策略通过', rule: 'allow', ...base };
}

// ============ E2: 报价 / 校验价格结构 ============

/** 生成报价 + 校验价格结构 (纯函数; 非法价格 → ok:false) */
export function quoteService(
  service: ServiceRef,
  request: ServiceRequest = {},
  opts: { now?: () => number; rid?: () => string } = {},
): ServiceQuote {
  const now = opts.now || nowDefault;
  const rid = opts.rid || ridDefault;
  const ts = request.timestamp ?? now();
  const requestId = String(request.requestId || '').trim() || rid();
  const name = String(service?.name || '').trim();
  const quantity = Number.isFinite(numOf(request.quantity)) && numOf(request.quantity) > 0 ? numOf(request.quantity) : 1;
  const price = service?.price;
  const currency = String(price?.currency || '').trim().toUpperCase();
  const payTo = String(service?.payTo || '').trim();

  const fail = (error: string): ServiceQuote => ({
    ok: false, error, serviceName: name, amount: NaN, currency, payTo,
    per: price?.per, quantity, requestId, fingerprint: '', ts, endpoint: request.endpoint || service?.endpoint,
  });

  if (!name) return fail('服务缺少 name');
  if (!price) return fail('服务缺少价格 (price)');
  const unit = numOf(price.amount);
  if (!Number.isFinite(unit) || unit < 0) return fail(`价格结构非法: amount=${String(price.amount)}`);
  if (!currency) return fail('价格缺少 currency');
  if (!payTo) return fail('服务缺少收款钱包 (payTo)');

  const amount = round2(unit * quantity);
  const fingerprint = `${requestId}|${name}|${amount}|${currency}|${ts}`;
  return {
    ok: true, serviceName: name, amount, currency, payTo,
    per: price.per, quantity, requestId, fingerprint, ts,
    endpoint: String(request.endpoint || service?.endpoint || '').trim() || undefined,
  };
}

// ============ E2: 交易记录存取 (localStorage) ============

export function listTrades(storage?: TradeStorage, opts: { limit?: number } = {}): TradeRecord[] {
  const s = storageOf(storage);
  let raw: string | null = null;
  try { raw = s.getItem(TRADE_STORE_KEY); } catch { raw = null; }
  if (!raw) return [];
  let arr: TradeRecord[] = [];
  try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p as TradeRecord[]; } catch { arr = []; }
  // 倒序: 新的在前 (ts 大者在前, 同 ts 按写入顺序靠后者在前)
  const ordered = arr.map((r, i) => ({ r, i })).sort((a, b) => (b.r.ts - a.r.ts) || (b.i - a.i)).map((x) => x.r);
  return opts.limit && opts.limit > 0 ? ordered.slice(0, opts.limit) : ordered;
}

export function appendTrade(
  rec: Omit<TradeRecord, 'ts' | 'currency'> & { ts?: number; currency?: string },
  storage?: TradeStorage,
): TradeRecord {
  const s = storageOf(storage);
  const full: TradeRecord = {
    requestId: String(rec.requestId || ''),
    service: String(rec.service || ''),
    amount: numOf(rec.amount) || 0,
    currency: String(rec.currency || 'USDC'),
    txHash: rec.txHash,
    status: rec.status,
    ts: typeof rec.ts === 'number' ? rec.ts : nowDefault(),
    payTo: rec.payTo,
    reason: rec.reason,
    fingerprint: rec.fingerprint,
  };
  const prev = listTrades(s).reverse(); // 还原写入顺序 (旧→新)
  prev.push(full);
  try { s.setItem(TRADE_STORE_KEY, JSON.stringify(prev)); } catch { /* 存储满 → 忽略 */ }
  return full;
}

export function clearTrades(storage?: TradeStorage): void {
  const s = storageOf(storage);
  try { s.setItem(TRADE_STORE_KEY, '[]'); } catch { /* 忽略 */ }
}

/** 防重放: 相同 requestId 已存在 → true (请求 ID + 金额 + 服务 + 时间戳 绑定) */
export function isReplayed(requestId: string, storage?: TradeStorage): boolean {
  if (!requestId) return false;
  return listTrades(storage).some((t) => t.requestId === requestId);
}

// ============ 信誉存储 (E4) ============

function repStoreOf(injected?: ReputationStore): ReputationStore {
  if (injected) return injected;
  const s = storageOf();
  return {
    get: (k) => {
      try { const raw = s.getItem(REP_STORE_KEY); const m = raw ? JSON.parse(raw) : {}; return (m && m[k]) ? { ...ZERO_REP, ...m[k] } : { ...ZERO_REP }; }
      catch { return { ...ZERO_REP }; }
    },
    set: (k, rep) => {
      try { const raw = s.getItem(REP_STORE_KEY); const m = raw ? JSON.parse(raw) : {}; m[k] = rep; s.setItem(REP_STORE_KEY, JSON.stringify(m)); }
      catch { /* 忽略 */ }
    },
  };
}

/** E4: 结算后更新服务方信誉 — tasks++ / success|failed|disputed → score = success/tasks */
export async function settleAndRate(params: SettleAndRateParams): Promise<SettleResult> {
  const deps = params.deps || {};
  const service = params.service || {};
  const key = serviceKey(service);
  const outcome: ServiceOutcome = typeof params.ok === 'string'
    ? params.ok
    : (params.ok ? 'success' : 'failed');
  if (!key || key === 'unknown') {
    return { ok: false, key, outcome, reputation: { ...ZERO_REP }, score: 0, error: '无法定位服务方 (缺 agentId/payTo/name)' };
  }
  try {
    const store = repStoreOf(deps.reputationStore);
    const cur: Reputation = { ...ZERO_REP, ...(await store.get(key) || {}) };
    cur.tasks += 1;
    if (outcome === 'success') cur.success += 1;
    else if (outcome === 'failed') cur.failed += 1;
    else cur.disputed += 1;
    cur.score = cur.tasks > 0 ? round2(cur.success / cur.tasks) : 0;
    await store.set(key, cur);
    return { ok: true, key, outcome, reputation: cur, score: cur.score };
  } catch (e) {
    return { ok: false, key, outcome, reputation: { ...ZERO_REP }, score: 0, error: `信誉更新失败: ${String((e as Error)?.message || e)}` };
  }
}

export async function getReputationOf(
  service: ServiceRef | { name?: string; agentId?: string; payTo?: string },
  deps: TradeDeps = {},
): Promise<Reputation> {
  try { return { ...ZERO_REP, ...(await repStoreOf(deps.reputationStore).get(serviceKey(service)) || {}) }; }
  catch { return { ...ZERO_REP }; }
}

// ============ E2: 402 解析 ============

function headerOf(res: unknown, name: string): string | undefined {
  const h = (res as { headers?: unknown })?.headers as Record<string, unknown> | { get?: (k: string) => string | null } | undefined;
  if (!h) return undefined;
  const g = (h as { get?: (k: string) => string | null }).get;
  if (typeof g === 'function') { const v = g.call(h, name); return v == null ? undefined : String(v); }
  const lower = name.toLowerCase();
  for (const k of Object.keys(h as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) { const v = (h as Record<string, unknown>)[k]; return v == null ? undefined : String(v); }
  }
  return undefined;
}

async function bodyOf(res: unknown): Promise<unknown> {
  const r = res as { json?: () => Promise<unknown>; text?: () => Promise<string>; body?: unknown };
  try { if (typeof r?.json === 'function') return await r.json(); } catch { /* 非 JSON */ }
  try {
    if (typeof r?.text === 'function') { const t = await r.text(); if (!t) return null; try { return JSON.parse(t); } catch { return t; } }
  } catch { /* 无 body */ }
  return r?.body ?? null;
}

/** 解析 402 Payment Required 的价格 (header 优先, 其次 body.payment) */
export function parse402(res: unknown, body?: unknown): PaymentRequirement | null {
  const b = (body && typeof body === 'object' ? (body as { payment?: Record<string, unknown> }) : {}) || {};
  const p = (b.payment || {}) as Record<string, unknown>;
  const amountRaw = headerOf(res, 'X-Payment-Amount') ?? p.amount ?? p.price;
  const currencyRaw = headerOf(res, 'X-Payment-Currency') ?? p.currency ?? 'USDC';
  const payToRaw = headerOf(res, 'X-Pay-To') ?? p.payTo ?? p.wallet ?? p.to;
  const networkRaw = headerOf(res, 'X-Payment-Network') ?? p.network;
  const amount = numOf(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (!payToRaw) return null;
  const currency = String(currencyRaw || 'USDC').toUpperCase();
  return { amount, currency, payTo: String(payToRaw), network: networkRaw ? String(networkRaw) : undefined };
}

// ============ 默认支付执行器 (签名隔离) ============

async function defaultPayFn(deps: TradeDeps, walletId: string | undefined, spec: PaySpec): Promise<PayResult> {
  if (deps.payFn) return deps.payFn(spec);
  if (!deps.getPrivateKey) return { success: false, error: '未提供 payFn / getPrivateKey (无法签名)' };
  if (!walletId) return { success: false, error: 'agent 未被授权任何钱包 (walletForAgent)' };
  const pk = await deps.getPrivateKey(walletId);
  if (!pk) return { success: false, error: '钱包已锁定, 请先解锁 (私钥仅在解锁后可取)' };
  if (!deps.x402Pay) return { success: false, error: '未注入 x402Pay 适配器 (桌面端 x402 未接线)' };
  try {
    const r = await deps.x402Pay({
      privateKey: pk, amount: String(spec.amount), to: spec.to,
      currency: spec.currency, network: spec.network || deps.network, memo: spec.memo,
    });
    return { success: !!r.success, txHash: r.txHash, error: r.error };
  } catch (e) {
    return { success: false, error: `x402 支付异常: ${String((e as Error)?.message || e)}` };
  }
}

async function resolveWallet(deps: TradeDeps, buyer?: string): Promise<{ id?: string; address?: string; error?: string }> {
  if (!deps.walletForAgent) return {};
  if (!buyer) return { error: '缺少 buyer agentId (无法定位钱包)' };
  const info = await deps.walletForAgent(buyer);
  if (!info || !info.exists || !info.wallets?.length) return { error: info?.error || `agent ${buyer} 未被授权任何钱包` };
  const w = info.wallets.find((x) => x.unlocked) || info.wallets[0];
  return { id: w.id, address: w.address };
}

// ============ E2: 402 → 支付 → 取结果 闭环 ============

/**
 * 调用付费服务: POST endpoint → 402(price+wallet) → 策略门 → x402_pay → 200 result.
 * 策略 confirm/deny 时**不支付**; 支付失败**不写成功记录**; 相同 requestId 直接判重放.
 */
export async function callService(params: CallServiceParams): Promise<CallServiceResult> {
  const deps = params.deps || {};
  const service = params.service;
  const request = params.request || {};
  const now = deps.now || nowDefault;
  const policy = deps.policy || DEFAULT_TRADE_POLICY;

  // 1. 报价 + 价格结构校验
  const quote = quoteService(service, request, { now, rid: deps.rid });
  const requestId = quote.requestId;
  if (!quote.ok) {
    return { ok: false, requestId, status: 'failed', error: quote.error, quote };
  }

  // 2. 防重放 (请求 ID + 金额 + 服务 + 时间戳 绑定)
  if (isReplayed(requestId, deps.storage)) {
    return { ok: false, requestId, status: 'replayed', replayed: true, reason: `重放请求被拒: ${requestId}`, quote };
  }

  // 3. 信誉 (E4) — service.reputation 优先, 否则查信誉库
  let reputation = numOf(service.reputation);
  if (!Number.isFinite(reputation) && deps.getReputation) {
    try { reputation = numOf(await deps.getReputation(service)); } catch { reputation = 0; }
  }
  const repVal = Number.isFinite(reputation) ? reputation : 0;

  // 4. 今日已花费 (日累计预算)
  let dailySpent = 0;
  if (deps.dailySpent) { try { dailySpent = numOf(await deps.dailySpent()) || 0; } catch { dailySpent = 0; } }
  else dailySpent = listTrades(deps.storage).filter((t) => t.status === 'success' && sameDay(t.ts, now())).reduce((s, t) => s + (numOf(t.amount) || 0), 0);

  // 5. Policy Engine (E3) — 非 AI 决策
  const verdict = evaluatePolicy(
    { payTo: quote.payTo, amount: quote.amount, currency: quote.currency, service: quote.serviceName, requestId, reputation: repVal, timestamp: quote.ts },
    policy,
    { dailySpent },
  );
  if (verdict.decision === 'deny') {
    appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'denied', payTo: quote.payTo, reason: verdict.reason, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
    return { ok: false, requestId, status: 'denied', denied: true, reason: verdict.reason, verdict, quote };
  }
  if (verdict.decision === 'confirm') {
    appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'pending_approval', payTo: quote.payTo, reason: verdict.reason, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
    return { ok: false, requestId, status: 'pending_approval', needsApproval: true, reason: verdict.reason, verdict, quote };
  }

  // 6. 钱包 (buyer)
  const wallet = await resolveWallet(deps, request.buyer);
  if (!deps.payFn && wallet.error) {
    return { ok: false, requestId, status: 'failed', error: wallet.error, verdict, quote };
  }

  const f = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, requestId, status: 'failed', error: '当前环境无 fetch', verdict, quote };
  const endpoint = quote.endpoint || String(service?.endpoint || '').trim();
  if (!endpoint) return { ok: false, requestId, status: 'failed', error: '服务缺少 endpoint', verdict, quote };

  const reqBody = JSON.stringify(request.body ?? {});
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'X-Request-Id': requestId };

  try {
    // ① 首次请求 → 期望 402
    const first = await f(endpoint, { method: 'POST', headers: baseHeaders, body: reqBody });
    const firstStatus = Number((first as { status?: number })?.status ?? 0);
    const firstBody = await bodyOf(first);

    if (firstStatus === 402) {
      const req = parse402(first, firstBody);
      if (!req) {
        appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'failed', payTo: quote.payTo, reason: '402 响应无法解析', fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
        return { ok: false, requestId, status: 'failed', error: '402 响应缺少价格/收款钱包', verdict, quote };
      }
      // 价格完整性: 402 声明金额/币种/收款方必须与报价一致 (防抬价/篡改)
      if (req.amount !== quote.amount || req.currency !== quote.currency || req.payTo.toLowerCase() !== quote.payTo.toLowerCase()) {
        appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'denied', payTo: quote.payTo, reason: '402 价格与报价不符', fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
        return { ok: false, requestId, status: 'denied', denied: true, reason: `402 价格与报价不符 (报价 ${quote.amount} ${quote.currency} → 402 ${req.amount} ${req.currency})`, verdict, quote };
      }
      // ② 支付 (签名隔离: 私钥仅在 defaultPayFn 内可见)
      const pay = await defaultPayFn(deps, wallet.id, { amount: req.amount, currency: req.currency, to: req.payTo, memo: `${quote.serviceName} ${requestId}`, network: req.network });
      if (!pay.success) {
        appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'failed', payTo: quote.payTo, reason: pay.error || '支付失败', fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
        if (deps.reputationStore) await settleAndRate({ ok: false, service, deps });
        return { ok: false, requestId, status: 'failed', error: pay.error || '支付失败', verdict, quote };
      }
      // ③ 携带支付凭据重试 → 200 取结果
      const proof = pay.proof || pay.txHash || '';
      const second = await f(endpoint, {
        method: 'POST',
        headers: { ...baseHeaders, 'X-Payment': proof, 'X-Payment-TxHash': pay.txHash || '', 'X-Payment-Request-Id': requestId },
        body: reqBody,
      });
      const secondStatus = Number((second as { status?: number })?.status ?? 0);
      const secondOk = (second as { ok?: boolean })?.ok ?? (secondStatus >= 200 && secondStatus < 300);
      const secondBody = await bodyOf(second);
      if (!secondOk) {
        appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'failed', txHash: pay.txHash, payTo: quote.payTo, reason: `支付后重试失败 ${secondStatus}`, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
        if (deps.reputationStore) await settleAndRate({ ok: false, service, deps });
        return { ok: false, requestId, status: 'failed', txHash: pay.txHash, error: `支付后重试失败 (${secondStatus})`, verdict, quote };
      }
      appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'success', txHash: pay.txHash, payTo: quote.payTo, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
      if (deps.reputationStore) await settleAndRate({ ok: true, service, deps });
      return { ok: true, requestId, status: 'success', result: secondBody, txHash: pay.txHash, paid: quote.amount, currency: quote.currency, verdict, quote };
    }

    // 非 402: 免费服务 (200) 或错误
    const firstOk = (first as { ok?: boolean })?.ok ?? (firstStatus >= 200 && firstStatus < 300);
    if (firstOk) {
      if (quote.amount > 0) {
        // 付费服务却直接放行 → 保守: 记录但标记异常
        return { ok: false, requestId, status: 'failed', error: `服务声明收费 ${quote.amount} ${quote.currency} 但未返回 402`, verdict, quote };
      }
      appendTrade({ requestId, service: quote.serviceName, amount: 0, currency: quote.currency, status: 'success', payTo: quote.payTo, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
      return { ok: true, requestId, status: 'success', result: firstBody, paid: 0, currency: quote.currency, verdict, quote };
    }
    appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'failed', payTo: quote.payTo, reason: `服务返回 ${firstStatus}`, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
    return { ok: false, requestId, status: 'failed', error: `服务返回 ${firstStatus}`, verdict, quote };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    appendTrade({ requestId, service: quote.serviceName, amount: quote.amount, currency: quote.currency, status: 'failed', payTo: quote.payTo, reason: msg, fingerprint: quote.fingerprint, ts: quote.ts }, deps.storage);
    return { ok: false, requestId, status: 'failed', error: `调用失败: ${msg}`, verdict, quote };
  }
}

export default {
  evaluatePolicy, quoteService, callService, settleAndRate, getReputationOf,
  appendTrade, listTrades, clearTrades, isReplayed, parse402,
  DEFAULT_TRADE_POLICY,
};
