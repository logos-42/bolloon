/**
 * seller-signing.ts — 卖方本机签名交付 (bolloon-x402-seller/1)
 *
 * 一句话: **私钥只在卖方本机**, 服务器只持卖方 DIAP **公钥**。
 *
 * 为什么需要这一层(而不是让服务器签):
 *   付费信息端点 (pay.bolloon.cn) 跑在别人的机器/云上。把 DIAP 私钥放上去 = 把
 *   "卖方身份" 交给部署方; 一旦服务器被拿到, 攻击者能签出**任何**内容的信封
 *   (签名是身份, 不是内容)。所以 ECS 上**没有**私钥 —— 即使付款校验通过, 它也
 *   只能回 `202 已付款待签名`, 等本机签完再交付。
 *
 * 链路 (每一步都有机器可读的事实):
 *   买方 → GET /api/x402/info/:id (无付款头) → 402 + accepts        [既有行为, 一字不改]
 *   买方 → 带 X-PAYMENT 再来 → 服务器结算 → 落一条 pending (待办)
 *        → 回 202 { status: 'paid_awaiting_signature', pendingId }
 *   本机 → bolloon x402 pending list (HMAC 认证) → 看到待办
 *   本机 → 人/智能体确认 (show 展示付款凭据/内容哈希/来源)
 *   本机 → bolloon x402 pending sign <id> → **复用既有 ed25519Sign** 签信封
 *        → POST 回服务器 → 服务器用**卖方公钥**验签后才收下
 *   买方 → 带**同一张** X-PAYMENT 再来 → 200 + 已签名信封 (按 receiptHash 取回)
 *        → 买方离线验签 (ed25519Verify / verifyEnvelope)
 *
 * 认证: 0600 共享密钥文件 + HMAC-SHA256(含时间戳与 nonce) —— 防重放见 §auth。
 * 幂等: 同一 receiptHash 只会有**一条** pending; 一旦签过, 再拿同一张凭据来取
 *       永远拿同一个信封 (不会重复签、不会重复交付)。
 *
 * 诚实口径 (不许美化):
 *   · 卖方不在线 ⇒ 买方**只能**拿到 "已付款待签名" (202), **拿不到信封** ——
 *     这条路径上的钱已经收了, 交付是异步的, 文档必须这么讲。
 *   · 服务器没配共享密钥 ⇒ 待办端点一律拒绝 (403), **不是** "没有待办"。
 *   · 本机没有该 item 的内容 / 内容哈希对不上 ⇒ **拒签** (绝不签一个对不上的信封)。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  canonicalize, computeContentHash, sha256Hex, ed25519Verify, buildSignedEnvelope,
  type InfoSource, type PaidInfoEnvelope,
} from './paid-info-protocol.js';

// ────────────────────────────────────────────────────────────── 常量 / 协议

export const SELLER_PROTOCOL = 'bolloon-x402-seller/1';
export const SELLER_AUTH_PROTOCOL = 'bolloon-x402-seller-auth/1';
/** 时间戳允许偏移 (ms): 超出即拒 (时钟偏移不是重放, 但重放窗口就靠它兜底) */
export const AUTH_MAX_SKEW_MS = 5 * 60 * 1000;
/** 待办默认存活 (超过就过期: 卖方长期不在线时不许无限期挂着 "可交付") */
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SELLER_AUTH_FILE = 'x402-seller-auth.json';
export const SELLER_PENDING_DIRNAME = 'x402-seller-pending';
export const SELLER_KEY_FILE = 'seller-key.json';

/** 队列端点前缀 —— nginx 只放行 `^~ /api/x402/`, 所以只能长在这下面 */
export const SELLER_API_PREFIX = '/api/x402/seller';

// ────────────────────────────────────────────────────────────── 路径

/** 本机/服务端的 bolloon 主目录 (与 server.mjs 的 BOLLOON_HOME_DIR 同源) */
export function sellerHome(explicit?: string): string {
  return explicit || process.env.BOLLOON_SELLER_HOME || process.env.BOLLOON_HOME_DIR || os.homedir();
}

export function sellerAuthPath(home?: string): string {
  return path.join(sellerHome(home), '.bolloon', SELLER_AUTH_FILE);
}

export function sellerPendingDir(home?: string): string {
  return path.join(sellerHome(home), '.bolloon', SELLER_PENDING_DIRNAME);
}

/** 卖方公钥钉钉子文件 (只有公钥, 可以放服务器; 服务器**拿不到**私钥) */
export function sellerKeyPath(home?: string): string {
  return path.join(sellerHome(home), '.bolloon', SELLER_KEY_FILE);
}

function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ────────────────────────────────────────────────────────────── 认证 (HMAC + 时间戳 + 一次性 nonce)

export interface SellerAuthConfig {
  protocol: typeof SELLER_AUTH_PROTOCOL;
  /** 密钥 id (可公开; 用来在日志里指认是哪把共享密钥, 而不是打印密钥本身) */
  keyId: string;
  /** base64 的 32 字节共享密钥 —— **只在 0600 文件里**, 不进日志/命令行/会话 */
  secret: string;
  /** 队列端点 (卖方本机连哪个服务器) */
  endpoint?: string;
  createdAt: string;
}

/** 生成一把新的共享密钥 (不落盘; 落盘用 saveSellerAuth) */
export function generateSellerAuth(endpoint?: string, keyId?: string): SellerAuthConfig {
  const secret = crypto.randomBytes(32).toString('base64');
  const kid = keyId || `sk_${sha256Hex(secret).slice(0, 12)}`;
  return { protocol: SELLER_AUTH_PROTOCOL, keyId: kid, secret, ...(endpoint ? { endpoint } : {}), createdAt: new Date().toISOString() };
}

/** 落盘: 目录 0700 / 文件 0600 (唯一允许的共享密钥落地通道) */
export async function saveSellerAuth(cfg: SellerAuthConfig, home?: string): Promise<string> {
  const file = sellerAuthPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

export async function loadSellerAuth(home?: string): Promise<SellerAuthConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(sellerAuthPath(home), 'utf-8'));
    if (!parsed?.keyId || !parsed?.secret) return null;
    return parsed as SellerAuthConfig;
  } catch {
    return null;
  }
}

/** 共享密钥指纹 (可打印): 用指纹说 "用的是哪把", 而不是打印密钥 */
export function sellerAuthFingerprint(cfg: { secret: string }): string {
  return `sha256:${sha256Hex(cfg.secret).slice(0, 16)}`;
}

/** 被签的规范串 —— 方法/路径/时间戳/nonce/请求体哈希 五样缺一不可 */
export function authCanonicalString(input: { method: string; path: string; ts: string; nonce: string; body?: string }): string {
  const bodyHash = sha256Hex(String(input.body ?? ''));
  return [String(input.method).toUpperCase(), input.path, String(input.ts), String(input.nonce), bodyHash].join('\n');
}

export function computeAuthSignature(secretB64: string, input: { method: string; path: string; ts: string; nonce: string; body?: string }): string {
  const key = Buffer.from(secretB64, 'base64');
  return crypto.createHmac('sha256', key).update(authCanonicalString(input), 'utf-8').digest('hex');
}

export interface SellerAuthHeaders { [k: string]: string }

/** 客户端: 为一次请求生成认证头 (提交给 fetch 用) */
export function signSellerRequest(
  cfg: SellerAuthConfig,
  req: { method: string; path: string; body?: string },
  now: number = Date.now(),
): SellerAuthHeaders {
  const ts = String(now);
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    'x-bolloon-seller-key': cfg.keyId,
    'x-bolloon-seller-ts': ts,
    'x-bolloon-seller-nonce': nonce,
    'x-bolloon-seller-sig': computeAuthSignature(cfg.secret, { method: req.method, path: req.path, ts, nonce, body: req.body }),
  };
}

/** 服务端: 一次性 nonce 台账 (落盘, 重启后仍然记得 → 重启不能当"重放窗口刷新") */
export class NonceLedger {
  private readonly file: string;
  private seen: Record<string, number> = {};
  private loaded = false;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      if (parsed && typeof parsed.seen === 'object') this.seen = parsed.seen;
    } catch { /* 首次运行没有台账 = 空台账 */ }
  }

  /**
   * 记下 nonce。已见过 (或在窗口内见过) → false (重放)。
   * 过期的 nonce 顺手清掉 (台账不会无限长)。
   */
  async accept(nonce: string, ts: number, now: number = Date.now()): Promise<boolean> {
    await this.ensureLoaded();
    if (Object.prototype.hasOwnProperty.call(this.seen, nonce)) return false;
    this.seen[nonce] = ts;
    const cutoff = now - AUTH_MAX_SKEW_MS;
    for (const [n, t] of Object.entries(this.seen)) if (t < cutoff) delete this.seen[n];
    const snapshot = JSON.stringify({ seen: this.seen });
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, snapshot, { mode: 0o600 });
      })
      .catch(() => undefined);
    await this.writeChain;
    return true;
  }
}

export interface VerifyAuthResult { ok: boolean; code?: string; detail: string }

/**
 * 服务端: 校验认证头。三道门一个都不能省:
 *   ① 签名 (HMAC-SHA256, timingSafeEqual 比较)
 *   ② 时间戳 (|now - ts| ≤ 5min)
 *   ③ 一次性 nonce (台账里没出现过) —— **必须在签名通过之后才记账**,
 *      否则攻击者可以拿垃圾签名把好 nonce 耗掉 (拒绝服务)。
 */
export async function verifySellerAuth(
  cfg: SellerAuthConfig | null | undefined,
  req: { method: string; path: string; headers: Record<string, string | undefined>; body?: string },
  ledger: NonceLedger,
  now: number = Date.now(),
): Promise<VerifyAuthResult> {
  if (!cfg?.keyId || !cfg?.secret) return { ok: false, code: 'SELLER_AUTH_NOT_CONFIGURED', detail: '本部署未配置卖方共享密钥 → 无权拉取待办' };
  const h = req.headers;
  const keyId = h['x-bolloon-seller-key'];
  const ts = h['x-bolloon-seller-ts'];
  const nonce = h['x-bolloon-seller-nonce'];
  const sig = h['x-bolloon-seller-sig'];
  if (!keyId || !ts || !nonce || !sig) return { ok: false, code: 'SELLER_AUTH_REQUIRED', detail: '缺少 x-bolloon-seller-{key,ts,nonce,sig} 之一' };
  if (keyId !== cfg.keyId) return { ok: false, code: 'SELLER_AUTH_KEY_UNKNOWN', detail: `未知 keyId: ${String(keyId).slice(0, 32)}` };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, code: 'SELLER_AUTH_BAD_TS', detail: `时间戳不是数字: ${String(ts).slice(0, 32)}` };
  const skew = Math.abs(now - tsNum);
  if (skew > AUTH_MAX_SKEW_MS) return { ok: false, code: 'SELLER_AUTH_EXPIRED', detail: `时间戳偏移 ${Math.round(skew / 1000)}s 超出允许 ±${AUTH_MAX_SKEW_MS / 1000}s` };
  const expected = computeAuthSignature(cfg.secret, { method: req.method, path: req.path, ts: String(ts), nonce: String(nonce), body: req.body });
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(sig), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'SELLER_AUTH_SIGNATURE_INVALID', detail: 'HMAC 不匹配 (密钥不对, 或方法/路径/时间戳/nonce/请求体被改动)' };
  const fresh = await ledger.accept(String(nonce), tsNum, now);
  if (!fresh) return { ok: false, code: 'SELLER_AUTH_REPLAY', detail: `nonce ${String(nonce).slice(0, 16)}… 已经用过 (一次性, 防重放)` };
  return { ok: true, detail: `keyId=${cfg.keyId} nonce=${String(nonce).slice(0, 16)}…` };
}

// ────────────────────────────────────────────────────────────── 待办记录

export interface PendingPayment {
  mode: 'facilitator' | 'local-dev';
  /** 结算回执原文 (X-PAYMENT-RESPONSE)。卖方本机要用它重建 receiptHash —— 签名必须绑同一张凭据 */
  receipt: string;
  /** sha256:<hex> of receipt —— 幂等键 (买方重试/重复付款都靠它) */
  receiptHash: string;
  txHash?: string;
  payer?: string;
  network: string;
  amount: string;
  currency: string;
  settledAt: string;
}

export interface PendingSignRequest {
  protocol: typeof SELLER_PROTOCOL;
  pendingId: string;
  status: 'awaiting_signature' | 'signed' | 'expired';
  itemId: string;
  title: string;
  providerDid: string;
  /** 卖方**发布时**定的内容哈希 —— 签名时必须逐字对上, 否则拒签 */
  contentHash: string;
  contentCid?: string;
  source: InfoSource;
  price: { amount: string; currency: string; network: string; payTo: string };
  payment: PendingPayment;
  /** 买方何时触发结算 (服务器时间) */
  createdAt: string;
  /** 过了这个点就不能再签 (卖方长期不在线 ≠ 永久可交付) */
  expiresAt: string;
  signedAt?: string;
  /** 已签信封的哈希 (审计用; 信封本体另存 envelopes/<receiptHash>.json) */
  envelopeHash?: string;
}

function pendingFile(pendingId: string, home?: string): string {
  return path.join(sellerPendingDir(home), `${safeId(pendingId)}.json`);
}

function envelopeFile(receiptHash: string, home?: string): string {
  return path.join(sellerPendingDir(home), 'envelopes', `${safeId(receiptHash)}.json`);
}

export function newPendingId(receiptHash: string): string {
  return `pnd_${sha256Hex(receiptHash).slice(0, 16)}`;
}

/** 幂等键: 由 receiptHash 派生 pendingId ⇒ 同一张凭据**只可能**有一条待办 */
export async function readPending(pendingId: string, home?: string): Promise<PendingSignRequest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(pendingFile(pendingId, home), 'utf-8'));
    return parsed?.pendingId ? parsed as PendingSignRequest : null;
  } catch {
    return null;
  }
}

export async function writePending(rec: PendingSignRequest, home?: string): Promise<void> {
  const dir = sellerPendingDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const f = pendingFile(rec.pendingId, home);
  const tmp = `${f}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  await fs.rename(tmp, f);
}

export async function listPending(home?: string): Promise<PendingSignRequest[]> {
  const dir = sellerPendingDir(home);
  try {
    const files = await fs.readdir(dir);
    const out: PendingSignRequest[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
        if (parsed?.pendingId) out.push(parsed);
      } catch { /* 跳过坏文件 (不因一个坏文件看不到全部待办) */ }
    }
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } catch {
    return [];
  }
}

/** 过了 expiresAt 就如实标过期 (不改写文件, 读时判 —— 磁盘上的事实保持原样) */
export function pendingView(rec: PendingSignRequest, now: number = Date.now()): PendingSignRequest {
  if (rec.status === 'awaiting_signature' && Date.parse(rec.expiresAt) < now) return { ...rec, status: 'expired' };
  return rec;
}

export async function findPendingByReceiptHash(receiptHash: string, home?: string): Promise<PendingSignRequest | null> {
  return readPending(newPendingId(receiptHash), home);
}

export async function getStoredEnvelope(receiptHash: string, home?: string): Promise<PaidInfoEnvelope | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(envelopeFile(receiptHash, home), 'utf-8'));
    return parsed?.proof ? parsed as PaidInfoEnvelope : null;
  } catch {
    return null;
  }
}

export async function storeEnvelope(receiptHash: string, envelope: PaidInfoEnvelope, home?: string): Promise<string> {
  const f = envelopeFile(receiptHash, home);
  await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  await fs.rename(tmp, f);
  return f;
}

/** 收到付款后落一条待办 (幂等: 同一 receiptHash 已存在就原样返回, 不动盘) */
export async function enqueuePending(
  input: {
    item: { id: string; title: string; provider: { did: string }; contentHash: string; contentCid?: string; source: InfoSource; price: PendingSignRequest['price'] };
    payment: Omit<PendingPayment, 'receiptHash' | 'settledAt'> & { settledAt?: string };
  },
  home?: string,
  now: number = Date.now(),
): Promise<{ pending: PendingSignRequest; created: boolean }> {
  const receiptHash = `sha256:${sha256Hex(input.payment.receipt)}`;
  const pendingId = newPendingId(receiptHash);
  const existing = await readPending(pendingId, home);
  if (existing) {
    // 幂等: 已有待办 (哪怕已签) 一律原样返回, 不产生第二条
    if (await getStoredEnvelope(receiptHash, home)) return { pending: existing, created: false };
    return { pending: existing, created: false };
  }
  const rec: PendingSignRequest = {
    protocol: SELLER_PROTOCOL,
    pendingId,
    status: 'awaiting_signature',
    itemId: input.item.id,
    title: input.item.title,
    providerDid: input.item.provider?.did || '',
    contentHash: input.item.contentHash,
    ...(input.item.contentCid ? { contentCid: input.item.contentCid } : {}),
    source: input.item.source,
    price: { ...input.item.price },
    payment: {
      mode: input.payment.mode,
      receipt: input.payment.receipt,
      receiptHash,
      ...(input.payment.txHash ? { txHash: input.payment.txHash } : {}),
      ...(input.payment.payer ? { payer: input.payment.payer } : {}),
      network: input.payment.network,
      amount: input.payment.amount,
      currency: input.payment.currency,
      settledAt: input.payment.settledAt || new Date(now).toISOString(),
    },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
  };
  await writePending(rec, home);
  return { pending: rec, created: true };
}

// ────────────────────────────────────────────────────────────── 买方取件 (付款之后)

export interface PaidDelivery {
  kind: 'envelope' | 'awaiting_signature' | 'expired';
  envelope?: PaidInfoEnvelope;
  pending?: PendingSignRequest;
  pendingId: string;
  /** 买方该做什么 (给智能体/人的下一步) */
  hint: string;
}

/**
 * ★ 买方的取件通道: 用 **取件 token** (202 响应里给的 pendingId) 再取一次。
 *
 * 为什么不靠 "重放同一张 X-PAYMENT":
 *   `checkAndSettlePayment` 每次结算都会**再跑一次** verify/settle, 而回执本身带
 *   时间戳 (local-dev 的 `settledAt` 是 `new Date()`) ⇒ "重放凭据" 会得到**另一个**
 *   receiptHash ⇒ 又落一条新待办, 永远取不回刚才那个信封; facilitator 模式下重放还会
 *   被 facilitator 判成重复结算 (钱已经动过, 不该再动)。所以取件必须有**独立的只读通道**。
 *
 * token 强度 (如实): pendingId = sha256(receiptHash) 前 16 位 hex = 64 bit, 由**买方自己的
 * 凭据哈希**派生 ⇒ 只有付过款的一方拿得到。它是**不记名 token** (谁拿到谁能取内容):
 * facilitator 模式下 receipt 由 facilitator 签发 (含 txHash), 买方之外不可推导;
 * local-dev 模式下买方能自己算出 receipt ⇒ token 不提供任何保密性 (**联调模式不是安全边界**)。
 */
export async function resolvePendingDelivery(
  args: { itemId: string; pendingId: string },
  home?: string,
  now: number = Date.now(),
): Promise<PaidDelivery | null> {
  const rec = await readPending(args.pendingId, home);
  if (!rec) return null;
  // token 绑定本条 item: 拿 A 的 token 去读 B 的路径 → 当作不存在
  if (rec.itemId !== args.itemId) return null;
  const view = pendingView(rec, now);
  if (view.status === 'expired') {
    return { kind: 'expired', pendingId: rec.pendingId, pending: view, hint: '待办已过期 (卖方长期未签) — 请人工处理, 不要重复付款' };
  }
  if (view.status === 'signed') {
    const env = await getStoredEnvelope(rec.payment.receiptHash, home);
    if (env) return { kind: 'envelope', envelope: env, pending: view, pendingId: rec.pendingId, hint: '交付完成: 请用 ed25519Verify / verifyEnvelope 离线验签' };
    // 状态写着已签但没有信封 = 事实不自洽 → 如实说, 不许拿旧内容冒充
    return { kind: 'awaiting_signature', pending: view, pendingId: rec.pendingId, hint: '待办标记为已签但信封文件缺失 — 这不是"交付完成", 请人工核对' };
  }
  const ageSec = Math.max(0, Math.round((now - Date.parse(rec.createdAt)) / 1000));
  return {
    kind: 'awaiting_signature',
    pending: view,
    pendingId: rec.pendingId,
    hint: `卖方还没签名 (已等 ${ageSec}s): 稍后用**同一个 token** 再取; 卖方不在线时就一直停在这里 —— 这是"已付款待签名", 不是失败`,
  };
}

/** 买方**刚付完款**时走这条: 已经签过就把信封给出去, 没签过就落待办并回 "已付款待签名" */
export async function resolvePaidDelivery(
  args: {
    item: { id: string; title: string; provider: { did: string }; contentHash: string; contentCid?: string; source: InfoSource; price: PendingSignRequest['price'] };
    payment: { mode: 'facilitator' | 'local-dev'; receipt: string; txHash?: string; payer?: string; network: string; amount: string; currency: string };
  },
  home?: string,
  now: number = Date.now(),
): Promise<PaidDelivery> {
  const receiptHash = `sha256:${sha256Hex(args.payment.receipt)}`;
  const signed = await getStoredEnvelope(receiptHash, home);
  const pendingId = newPendingId(receiptHash);
  if (signed) {
    const pending = await readPending(pendingId, home);
    return { kind: 'envelope', envelope: signed, ...(pending ? { pending } : {}), pendingId, hint: '交付完成: 请用 ed25519Verify / verifyEnvelope 离线验签' };
  }
  const { pending } = await enqueuePending({ item: args.item, payment: args.payment }, home, now);
  if (new Date(pending.expiresAt).getTime() < now && pending.status !== 'signed') {
    return { kind: 'expired', pending, pendingId, hint: '待办已过期: 卖方长期未签, 请人工处理 (不要重复付款)' };
  }
  return {
    kind: 'awaiting_signature',
    pending,
    pendingId,
    hint: '已付款待签名: 卖方本机尚未签发信封 (卖方不在线时拿不到内容, 这不是失败 —— 凭据已绑定本条资源, 签好后用**取件 token** GET /api/x402/info/<itemId>/pending/<pendingId> 取回; 别重放 X-PAYMENT, 那会再跑一遍结算)',
  };
}

// ────────────────────────────────────────────────────────────── 收下已签信封 (服务器侧校验)

export interface AcceptEnvelopeResult {
  ok: boolean;
  code?: string;
  detail: string;
  envelopeHash?: string;
  envelope?: PaidInfoEnvelope;
}

/**
 * 服务器侧: 收下本机签好的信封。**四道门**, 缺一道都不收:
 *   ① 待办存在且还是 awaiting_signature
 *   ② 签名自带公钥 == 钉住的卖方公钥 (防 "谁都能签一个信封塞进来")
 *   ③ ed25519Verify 通过 (载荷 = canonical(proof.payload))
 *   ④ 载荷自洽: itemId / providerDid / contentHash / receiptHash 与待办逐字一致
 *      + 内容本体哈希 == item.contentHash (防 "挂 A 卖 B" 在服务器侧被悄悄放过)
 */
export async function acceptSignedEnvelope(
  args: { pendingId: string; envelope: any; sellerPublicKeyHex?: string; sellerDid?: string },
  home?: string,
): Promise<AcceptEnvelopeResult> {
  const pending = await readPending(args.pendingId, home);
  if (!pending) return { ok: false, code: 'PENDING_NOT_FOUND', detail: `没有这条待办: ${args.pendingId}` };
  const env = args.envelope;
  if (!env?.proof?.signature || !env?.proof?.payload || !env?.proof?.publicKeyHex) {
    return { ok: false, code: 'ENVELOPE_MISSING_PROOF', detail: '信封缺少 proof.signature / payload / publicKeyHex' };
  }
  if (pending.status === 'signed') {
    const existing = await getStoredEnvelope(pending.payment.receiptHash, home);
    const same = !!existing && canonicalize(existing) === canonicalize(env);
    if (same) return { ok: true, detail: '这条待办已经收过同一个信封 (幂等)', envelopeHash: `sha256:${sha256Hex(canonicalize(env))}`, envelope: existing! };
    return { ok: false, code: 'PENDING_ALREADY_SIGNED', detail: '这条待办已经签过, 且这次提交的是**另一个**信封 —— 拒绝改写已交付的事实' };
  }
  if (pending.status === 'expired' || Date.parse(pending.expiresAt) < Date.now()) {
    return { ok: false, code: 'PENDING_EXPIRED', detail: `待办已过期 (${pending.expiresAt}) —— 拒绝签发` };
  }
  if (args.sellerPublicKeyHex) {
    if (String(env.proof.publicKeyHex).toLowerCase() !== String(args.sellerPublicKeyHex).toLowerCase()) {
      return { ok: false, code: 'SELLER_KEY_MISMATCH', detail: '签名公钥与本部署钉住的卖方公钥不一致 —— 拒绝收下' };
    }
  } else {
    return { ok: false, code: 'SELLER_KEY_NOT_PINNED', detail: '本部署未钉住卖方公钥 → 无法判断这个信封是不是卖方签的 (拒绝收下, 不是"先信一次")' };
  }
  const sigOk = await ed25519Verify(env.proof.publicKeyHex, canonicalize(env.proof.payload), env.proof.signature);
  if (!sigOk) return { ok: false, code: 'SIGNATURE_INVALID', detail: 'ed25519Verify 失败 (载荷被改动, 或不是这把钥匙签的)' };
  const p = env.proof.payload;
  if (p.itemId !== pending.itemId || p.providerDid !== pending.providerDid || p.contentHash !== pending.contentHash || p.receiptHash !== pending.payment.receiptHash) {
    return {
      ok: false,
      code: 'PAYLOAD_MISMATCH',
      detail: `载荷绑定与待办不一致 (itemId ${p.itemId === pending.itemId ? 'ok' : 'MISMATCH'} · providerDid ${p.providerDid === pending.providerDid ? 'ok' : 'MISMATCH'} · contentHash ${p.contentHash === pending.contentHash ? 'ok' : 'MISMATCH'} · receiptHash ${p.receiptHash === pending.payment.receiptHash ? 'ok' : 'MISMATCH'})`,
    };
  }
  const actualHash = computeContentHash(String(env.content ?? ''));
  if (actualHash !== pending.contentHash) {
    return { ok: false, code: 'CONTENT_HASH_MISMATCH', detail: `内容哈希对不上 (收到 ${actualHash}, 待办要求 ${pending.contentHash}) —— 拒绝收下` };
  }
  if (pending.status !== 'awaiting_signature' && pending.status !== 'signed') {
    return { ok: false, code: 'PENDING_STATE_INVALID', detail: `待办状态 ${pending.status} 不能接收信封` };
  }
  const envelopeHash = `sha256:${sha256Hex(canonicalize(env))}`;
  await storeEnvelope(pending.payment.receiptHash, env, home);
  await writePending({ ...pending, status: 'signed', signedAt: new Date().toISOString(), envelopeHash }, home);
  return { ok: true, detail: '信封已验签收下 (服务器只验证, 不持有私钥)', envelopeHash, envelope: env };
}

// ────────────────────────────────────────────────────────────── HTTP 面 (服务器挂载点)

export interface SellerHttpRequest {
  method: string;
  /** pathname (不含 query) */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string | undefined>;
  bodyText?: string;
}

export interface SellerHttpResponse { status: number; headers: Record<string, string>; body: string }

export interface SellerGatewayOptions {
  home?: string;
  /** 共享密钥 (缺省 = 从 0600 文件读) */
  auth?: SellerAuthConfig | null;
  /** 钉住的卖方公钥 (缺省 = 从 seller-key.json 读) */
  sellerPublicKeyHex?: string;
  sellerDid?: string;
  ledger?: NonceLedger;
  now?: () => number;
  /** 队列里最多返回多少条 (默认 200) */
  maxList?: number;
}

export function sellerApiPaths(): { list: string; show: (id: string) => string; envelope: (id: string) => string } {
  return {
    list: `${SELLER_API_PREFIX}/pending`,
    show: (id) => `${SELLER_API_PREFIX}/pending/${encodeURIComponent(id)}`,
    envelope: (id) => `${SELLER_API_PREFIX}/pending/${encodeURIComponent(id)}/envelope`,
  };
}

/** 买方取件路径 (只读, 不用付款头, 不重跑结算; token = 202 响应里的 pendingId) */
export function paidInfoRetrievePath(itemId: string, pendingId: string): string {
  return `/api/x402/info/${encodeURIComponent(itemId)}/pending/${encodeURIComponent(pendingId)}`;
}

function json(res: SellerHttpResponse, status: number, obj: unknown): SellerHttpResponse {
  return { ...res, status, body: JSON.stringify(obj, null, 2), headers: { ...res.headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } };
}

/**
 * 处理 `/api/x402/seller/**`。返回 {status, headers, body}; **不碰** 402 那条路。
 * 服务端 (server.mjs) 只需把 req 转成 SellerHttpRequest 再写回。
 */
export async function handleSellerApi(opts: SellerGatewayOptions, req: SellerHttpRequest): Promise<SellerHttpResponse> {
  const home = opts.home;
  const now = opts.now ? opts.now() : Date.now();
  const base: SellerHttpResponse = { status: 500, headers: {}, body: '' };
  const auth = opts.auth !== undefined ? opts.auth : await loadSellerAuth(home);
  const ledger = opts.ledger ?? new NonceLedger(path.join(sellerPendingDir(home), '.nonces.json'));

  const method = String(req.method || 'GET').toUpperCase();
  // 查询串不参与签名 (signSellerRequest 只签 pathname) —— 这里也只用 pathname
  const p = String(req.path || '').replace(/\/+$/, '') || '/';

  if (method !== 'GET' && method !== 'POST') {
    return json({ ...base, headers: { Allow: 'GET, POST' } }, 405, { error: '队列端点只认 GET / POST' });
  }

  // ① 认证 (所有队列端点都要)
  const verdict = await verifySellerAuth(auth, { method, path: req.path, headers: req.headers, body: req.bodyText }, ledger, now);
  if (!verdict.ok) {
    const status = verdict.code === 'SELLER_AUTH_NOT_CONFIGURED' ? 403 : 401;
    return json(base, status, { ok: false, code: verdict.code, error: verdict.detail, hint: verdict.code === 'SELLER_AUTH_NOT_CONFIGURED' ? '本部署未配置共享密钥 (0600 文件) → 卖方本机也无权拉取' : '检查本机 ~/.bolloon/x402-seller-auth.json 与服务端是否同一把密钥; 时间戳是否同步' });
  }

  const paths = sellerApiPaths();
  const showMatch = p.match(new RegExp(`^${SELLER_API_PREFIX}/pending/([^/]+)$`));
  const envMatch = p.match(new RegExp(`^${SELLER_API_PREFIX}/pending/([^/]+)/envelope$`));

  // 列出待办
  if (method === 'GET' && p === paths.list) {
    const want = String(req.query?.status || '').trim();
    const all = (await listPending(home)).map((r) => pendingView(r, now));
    const filtered = want ? all.filter((r) => r.status === want) : all;
    const limit = Math.min(Number(opts.maxList ?? 200) || 200, 1000);
    const items = filtered.slice(0, limit);
    return json(base, 200, {
      ok: true,
      protocol: SELLER_PROTOCOL,
      count: items.length,
      total: all.length,
      awaitingSignature: all.filter((r) => r.status === 'awaiting_signature').length,
      // 待办里**不带** privateKey/secret; receipt 是结算凭据原文 (卖方要用它重建 receiptHash)
      pending: items,
      note: '私钥不在这里 —— 服务器只持卖方公钥; 本机签完 POST 回 /pending/:id/envelope 即可交付',
    });
  }

  // 单条
  if (method === 'GET' && showMatch) {
    const rec = await readPending(decodeURIComponent(showMatch[1]), home);
    if (!rec) return json(base, 404, { ok: false, code: 'PENDING_NOT_FOUND', error: '没有这条待办' });
    const view = pendingView(rec, now);
    const envelope = view.status === 'signed' ? await getStoredEnvelope(view.payment.receiptHash, home) : null;
    return json(base, 200, { ok: true, protocol: SELLER_PROTOCOL, pending: view, envelopeHash: view.envelopeHash || null, delivered: !!envelope });
  }

  // 回传已签信封
  if (method === 'POST' && envMatch) {
    const pendingId = decodeURIComponent(envMatch[1]);
    let body: any;
    try {
      body = JSON.parse(String(req.bodyText || ''));
    } catch {
      return json(base, 400, { ok: false, code: 'INVALID_ARGUMENT', error: '请求体不是合法 JSON' });
    }
    const envelope = body?.envelope ?? body;
    const res = await acceptSignedEnvelope({
      pendingId,
      envelope,
      sellerPublicKeyHex: opts.sellerPublicKeyHex,
      sellerDid: opts.sellerDid,
    }, home);
    if (!res.ok) {
      const status = res.code === 'PENDING_NOT_FOUND' ? 404 : res.code === 'PENDING_ALREADY_SIGNED' ? 409 : res.code === 'SELLER_KEY_NOT_PINNED' ? 503 : 400;
      return json(base, status, { ok: false, code: res.code, error: res.detail });
    }
    return json(base, 200, {
      ok: true,
      pendingId,
      status: 'signed',
      envelopeHash: res.envelopeHash,
      detail: res.detail,
      buyerHint: '买方带**同一张** X-PAYMENT 再请求一次原 URL 即可取回信封',
    });
  }

  return json(base, 404, { ok: false, code: 'NOT_FOUND', error: `未知队列路径: ${method} ${p}` });
}

// ────────────────────────────────────────────────────────────── 本机侧 (CLI 用)

export interface SellerClientOptions {
  endpoint: string;
  auth: SellerAuthConfig;
  fetchImpl?: typeof fetch;
}

export interface SellerClientResult { status: number; ok: boolean; json: any; text: string }

/** 本机侧: 带认证地请求服务器队列端点 (签名在 signSellerRequest 里做)
 *  注意: 被签的只有 **pathname**; `urlPath` 允许带查询串 (查询串不参与签名) */
export async function sellerClientRequest(opts: SellerClientOptions, req: { method: 'GET' | 'POST'; path: string; urlPath?: string; body?: string }): Promise<SellerClientResult> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.endpoint.replace(/\/+$/, '')}${req.urlPath ?? req.path}`;
  const headers: Record<string, string> = { ...signSellerRequest(opts.auth, { method: req.method, path: req.path, body: req.body }) };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await f(url, { method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}) });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 也如实带回原文 */ }
  return { status: res.status, ok: res.ok, json: parsed, text };
}

/** 本机侧: 从待办 + 本机 item/内容 构造已签信封 (**复用既有 buildSignedEnvelope → ed25519Sign**) */
export async function signPending(
  args: {
    pending: PendingSignRequest;
    item: { contentHash: string; [k: string]: any };
    content: string;
    keypair: { did: string; publicKey: Uint8Array | string; privateKey: Uint8Array | string };
  },
): Promise<PaidInfoEnvelope> {
  const { pending, item, content, keypair } = args;
  if (String(item.contentHash) !== String(pending.contentHash)) {
    throw new Error(`本机 item 的内容哈希 (${String(item.contentHash).slice(0, 28)}…) 与待办要求 (${String(pending.contentHash).slice(0, 28)}…) 不一致 —— 拒签 (可能本机内容已改版)`);
  }
  if (keypair.did && pending.providerDid && keypair.did !== pending.providerDid) {
    throw new Error(`本机钥匙的 DID (${keypair.did}) 不是这条 item 的卖方 (${pending.providerDid}) —— 拒签`);
  }
  return buildSignedEnvelope({
    item: item as any,
    content,
    keypair: keypair as any,
    payment: {
      mode: pending.payment.mode,
      receipt: pending.payment.receipt,
      ...(pending.payment.txHash ? { txHash: pending.payment.txHash } : {}),
      network: pending.payment.network,
      amount: pending.payment.amount,
      currency: pending.payment.currency,
      ...(pending.payment.payer ? { payer: pending.payment.payer } : {}),
      settledAt: pending.payment.settledAt,
    },
    issuedAt: new Date().toISOString(),
  });
}

// ────────────────────────────────────────────────────────────── 卖方钥匙定位

export interface ResolvedSellerKey {
  did: string;
  publicKeyHex: string;
  /** 32 字节 hex 私钥 —— **只在本进程内存里用, 绝不打印/落日志** */
  privateKeyHex: string;
  source: string;
}

/**
 * 找到能给这个 DID 签名的本机钥匙。**只读既有身份文件, 绝不新建**:
 *   ① --agent <agentId> → ~/.bolloon/agent-keys/<agentId>.json
 *   ② ~/.bolloon/identity.json (DIAP 身份, 与 `routes-x402-info.ts` 的 loadProviderKeypair 同源)
 *   ③ 扫 ~/.bolloon/agent-keys/*.json 兜底
 * 传了 did 就**必须**匹配 (否则等于用错钥匙签别人的单); 找不到就如实报错 ——
 * 不静默生成一把新钥匙 (那等于换了个卖方身份)。
 */
export async function resolveSellerKey(did: string, opts: { agentId?: string; home?: string } = {}): Promise<ResolvedSellerKey | null> {
  const home = sellerHome(opts.home);
  const read = async (file: string, source: string): Promise<ResolvedSellerKey | null> => {
    try {
      const j = JSON.parse(await fs.readFile(file, 'utf-8'));
      if (!j?.privateKey) return null;
      if (did && j.did && j.did !== did) return null;
      const priv = String(j.privateKey).replace(/^0x/, '');
      if (priv.length !== 64) return null;
      return { did: j.did || did, publicKeyHex: String(j.publicKey || '').replace(/^0x/, ''), privateKeyHex: priv, source };
    } catch {
      return null;
    }
  };

  if (opts.agentId) {
    return read(path.join(home, '.bolloon', 'agent-keys', `${safeId(opts.agentId)}.json`), `agent-keys/${safeId(opts.agentId)}.json`);
  }
  // ★ 不指定 agent 时: **先认身份文件** (~/.bolloon/identity.json) —— 它与 `routes-x402-info.ts` 的
  //   loadProviderKeypair 同源, 也就是"这份内容是谁发布的"。不能按文件名排序抓 agent-keys 里的第一个:
  //   本机 agent-keys/ 下通常躺着好几个测试 agent, 按排序第一个拿到的是**别人**的钥匙 ⇒
  //   与待办 providerDid 对不上 (甚至可能"用错钥匙签了别人的单")。真撞过: 排序第一是 `agent-__.json`。
  const id = await read(path.join(home, '.bolloon', 'identity.json'), 'identity.json');
  if (id) return id;
  const keysDir = path.join(home, '.bolloon', 'agent-keys');
  try {
    const files = (await fs.readdir(keysDir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const hit = await read(path.join(keysDir, f), `agent-keys/${f}`);
      if (hit) return hit;
    }
  } catch { /* 没有 agent-keys 目录 */ }
  return null;
}
