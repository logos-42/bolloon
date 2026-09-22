/**
 * paid-info-store.ts — 微支付信息服务: 发布 / 索引 / 402 收款 / 付款校验
 *
 * 三个角色:
 *   ① 提供方 (卖方): publishInfo() 落盘 → GET /api/x402/info/:id 未付款返回 402 (x402 v2 accepts),
 *      付款通过 → 结算 → 返回带签名的信封 (content + proof + payment)
 *   ② 购买方 (买方): buyInfo() 走标准 x402 客户端 (402 → 钱包签名 → 重试) 拿到信封
 *   ③ 验真: verifyEnvelope() 分档报告 (见 paid-info-protocol.ts)
 *
 * 支付两种模式:
 *   facilitator — 真链上: BOLLOON_X402_FACILITATOR=https://... → POST /verify + /settle
 *   local-dev   — 本机联调: 显式 env BOLLOON_X402_LOCAL_VERIFY=1, 回执带 mode:'local-dev'
 *                 (验真报告会标注"非链上支付", 绝不冒充真实付款)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  INFO_PROTOCOL, computeContentHash, sha256Hex,
  type PaidInfoItem, type InfoSource, type InfoCategory,
} from './paid-info-protocol.js';
// 只引类型 (编译期擦除): 别把 ethers 拖进 x402 模块图 —— 真链验证器是动态 import 的
import type {
  ChainSettlementVerifier, ChainSettlementExpect, ChainSettlementVerdict,
} from '../chain/chain-settlement.js';

// ---------------------------------------------------------------- 存储

export interface StoredInfo { item: PaidInfoItem; content: string }

export function x402InfoDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'x402-info');
}

function itemFile(id: string, home: string): string {
  return path.join(x402InfoDir(home), `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export interface PublishInfoInput {
  title: string;
  category: InfoCategory;
  content: string;
  description?: string;
  price: { amount: string; currency: 'USDC' | 'ETH'; network?: string; payTo: string };
  source: InfoSource;
  provider: { did: string; name?: string; agentId?: string; endpoint?: string };
  contentCid?: string;
  id?: string;
}

export async function publishInfo(input: PublishInfoInput, opts: { home?: string } = {}): Promise<PaidInfoItem> {
  const home = opts.home ?? os.homedir();
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title 必填');
  if (!String(input.content ?? '').length) throw new Error('content 必填 (要卖的信息本体)');
  if (!input.price?.payTo) throw new Error('price.payTo 必填 (收款地址)');
  if (!input.provider?.did) throw new Error('provider.did 必填 (卖方 DIAP 身份)');
  const id = input.id || `info_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const item: PaidInfoItem = {
    protocol: INFO_PROTOCOL,
    id,
    title,
    category: input.category || 'other',
    description: input.description,
    price: {
      amount: String(input.price.amount ?? '0'),
      currency: input.price.currency || 'USDC',
      network: input.price.network || 'base-sepolia',
      payTo: input.price.payTo,
    },
    provider: input.provider,
    contentHash: computeContentHash(String(input.content)),
    contentCid: input.contentCid,
    source: input.source || { kind: 'self', refs: [] },
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(x402InfoDir(home), { recursive: true });
  await fs.writeFile(itemFile(id, home), JSON.stringify({ item, content: String(input.content) }, null, 2), 'utf-8');
  return item;
}

export async function listInfo(home: string = os.homedir()): Promise<PaidInfoItem[]> {
  try {
    const dir = x402InfoDir(home);
    const files = await fs.readdir(dir);
    const out: PaidInfoItem[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
        if (parsed?.item) out.push(parsed.item);
      } catch { /* 跳过坏文件 */ }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch {
    return [];
  }
}

export async function getStoredInfo(id: string, home: string = os.homedir()): Promise<StoredInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(itemFile(id, home), 'utf-8'));
    return parsed?.item ? parsed : null;
  } catch {
    return null;
  }
}

export async function removeInfo(id: string, home: string = os.homedir()): Promise<boolean> {
  try {
    await fs.rm(itemFile(id, home));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- x402 402 / 校验

const USDC_BY_NETWORK: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
};
/** 原生 ETH 在 x402 里用零地址占位 */
const NATIVE_ASSET = '0x0000000000000000000000000000000000000000';

export function assetFor(currency: string, network: string): string {
  if (currency === 'USDC') return USDC_BY_NETWORK[network] || USDC_BY_NETWORK['base-sepolia'];
  return NATIVE_ASSET;
}

/** 人类金额 → 原子单位 (USDC 6 位 / ETH 18 位), 纯整数运算防浮点误差 */
export function toAtomicAmount(amount: string, currency: string): string {
  const decimals = currency === 'USDC' ? 6 : 18;
  const s = String(amount || '0').trim();
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  const int = i.replace(/[^0-9]/g, '') || '0';
  return `${int}${frac}`.replace(/^0+(?=\d)/, '');
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string; serviceName?: string; tags?: string[] };
  accepts: Array<Record<string, unknown>>;
}

/** 生成 x402 v2 规范的 402 响应体 */
export function buildPaymentRequired(item: PaidInfoItem, url?: string, error?: string): PaymentRequiredBody {
  const network = item.price.network;
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: {
      url: url || item.provider.endpoint || `bolloon://x402/info/${item.id}`,
      description: item.description || item.title,
      mimeType: 'application/json',
      serviceName: 'bolloon-paid-info',
      tags: [item.category],
    },
    accepts: [{
      scheme: 'exact',
      network,
      asset: assetFor(item.price.currency, network),
      amount: toAtomicAmount(item.price.amount, item.price.currency),
      payTo: item.price.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: item.price.currency, itemId: item.id, category: item.category, providerDid: item.provider.did },
    }],
  };
}

export function decodePaymentHeader(header: string): any | null {
  try {
    const raw = Buffer.from(String(header || '').trim(), 'base64').toString('utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function encodePaymentResponse(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

export interface PaymentOutcome {
  ok: boolean;
  mode: 'facilitator' | 'local-dev' | 'none';
  /** 回执原文 (X-PAYMENT-RESPONSE 的值) */
  receipt?: string;
  txHash?: string;
  payer?: string;
  network?: string;
  error?: string;
  /** ★ 这次调用是否**真的发起过支付尝试** (有凭据 + 走到校验/结算) —— 有尝试就不能当"没付过钱" */
  attempted?: boolean;
  /** ★ 结算结果**不确定** (settle 失败/facilitator 不可达): 可能钱已经动了 → 必须先对账, 不许自动重付 */
  settlementUncertain?: boolean;
  /** ★ facilitator **明确拒绝**了这笔凭据 → 钱一定没动 (可安全重试) */
  verifyRejected?: boolean;
}

export interface CheckPaymentOptions {
  paymentHeader?: string;
  requirements: PaymentRequiredBody;
  facilitatorUrl?: string;
  /** 显式允许本机联调凭据 (默认 false) */
  allowLocalDev?: boolean;
  fetchImpl?: typeof fetch;
  /** 这张凭据必须是为这条资源付的 (防跨资源复用) */
  expectedItemId?: string;
}

/**
 * 校验并结算一笔微支付。
 * facilitator 模式走标准 /verify + /settle; local-dev 只在显式开启时可用并如实标记。
 */
export async function checkAndSettlePayment(opts: CheckPaymentOptions): Promise<PaymentOutcome> {
  const req = opts.requirements.accepts[0];
  const network = String(req.network);
  if (!opts.paymentHeader) return { ok: false, mode: 'none', error: '缺少 X-PAYMENT 头 (未付款)', attempted: false };
  const payload = decodePaymentHeader(opts.paymentHeader);
  if (!payload) return { ok: false, mode: 'none', error: 'X-PAYMENT 不是合法 base64 JSON', attempted: false };

  const facilitatorUrl = opts.facilitatorUrl ?? process.env.BOLLOON_X402_FACILITATOR ?? '';
  const allowLocalDev = opts.allowLocalDev ?? (process.env.BOLLOON_X402_LOCAL_VERIFY === '1');

  // ★ 凭据绑定校验必须在**分模式之前** (两种模式都查): 拿旧回执去换另一条资源 → 一律拒绝。
  //   真跑抓到过: 这段原来只对 local-dev 生效, facilitator 模式提前 return → 跨资源复用没被拦。
  const boundItem = payload?.accepted?.extra?.itemId || payload?.accepted?.itemId || payload?.itemId;
  if (opts.expectedItemId) {
    if (!boundItem) {
      return { ok: false, mode: 'none', attempted: false, error: '支付凭据没有绑定 itemId: 无法证明这笔钱是为这条资源付的' };
    }
    if (String(boundItem) !== String(opts.expectedItemId)) {
      return { ok: false, mode: 'none', attempted: false, error: `支付凭据绑定的资源 (${boundItem}) 与本次请求 (${opts.expectedItemId}) 不一致 — 回执不能跨资源复用` };
    }
  }

  if (facilitatorUrl) {
    const f = opts.fetchImpl ?? fetch;
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: req };
    try {
      const vres = await f(`${facilitatorUrl.replace(/\/$/, '')}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const v = await vres.json() as any;
      if (!v?.isValid) {
        return { ok: false, mode: 'facilitator', attempted: true, verifyRejected: true, settlementUncertain: false, error: `facilitator 校验未通过: ${v?.invalidReason || v?.invalidMessage || 'unknown'}` };
      }
      const sres = await f(`${facilitatorUrl.replace(/\/$/, '')}/settle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const s = await sres.json() as any;
      if (!s?.success) {
        // settle 失败: 链上可能已经动了钱 → 不确定 (不是"没付过")
        return { ok: false, mode: 'facilitator', attempted: true, verifyRejected: false, settlementUncertain: true, error: `结算失败: ${s?.errorReason || s?.errorMessage || 'unknown'}` };
      }
      const receipt = encodePaymentResponse(s);
      return { ok: true, mode: 'facilitator', receipt, txHash: s.transaction, payer: s.payer || v.payer, network, attempted: true };
    } catch (e: any) {
      return { ok: false, mode: 'facilitator', attempted: true, verifyRejected: false, settlementUncertain: true, error: `facilitator 不可达: ${String(e?.message || e).slice(0, 160)}` };
    }
  }

  if (!allowLocalDev) {
    return {
      ok: false,
      mode: 'none',
      attempted: false,
      error: '未配置 facilitator (BOLLOON_X402_FACILITATOR), 也未开启本机联调模式 (BOLLOON_X402_LOCAL_VERIFY=1) — 无法校验真实付款',
    };
  }

  // 本机联调: 只检查 payload 声明的收款/金额与要求一致, 明确标记非链上
  const accepted = payload.accepted || {};
  if (accepted.payTo && String(accepted.payTo).toLowerCase() !== String(req.payTo).toLowerCase()) {
    return { ok: false, mode: 'local-dev', error: '本机联调: 付款声明收款地址与要求不一致' };
  }
  if (accepted.amount && String(accepted.amount) !== String(req.amount)) {
    return { ok: false, mode: 'local-dev', error: '本机联调: 付款声明金额与要求不一致' };
  }
  const receiptObj = {
    mode: 'local-dev',
    success: true,
    network,
    payer: payload.payer || 'local-dev',
    transaction: `local-dev:${sha256Hex(JSON.stringify(payload)).slice(0, 32)}`,
    settledAt: new Date().toISOString(),
    note: '本机联调凭据, 非链上支付',
  };
  return { ok: true, mode: 'local-dev', receipt: encodePaymentResponse(receiptObj), txHash: receiptObj.transaction, payer: receiptObj.payer, network };
}

// ---------------------------------------------------------------- 买方

export interface BuyInfoResult {
  ok: boolean;
  status?: number;
  /** 策略门拒绝 (Phase 2): 没有签名、没有链上交易、没有扣预算、没有交付 */
  policyDenied?: boolean;
  /** 卖方声明的元数据 (来自 402 / 免费元数据) */
  metadata?: any;
  /** 已验真的信封 (直接给智能体用) */
  envelope?: any;
  verify?: import('./paid-info-protocol.js').VerifyReport;
  payment?: {
    mode: string; txHash?: string; receipt?: string;
    /** 发起过支付尝试 (有凭据 / 走到校验结算) */
    attempted?: boolean;
    /** 付款这一步**已经完成** (回执/链上事实在手), 后面失败的是资源侧 */
    settled?: boolean;
    /** 结算结果不确定 (可能已付) → 先对账 */
    settlementUncertain?: boolean;
    /** facilitator 明确拒绝 → 钱一定没动 */
    verifyRejected?: boolean;
    /** ★ F5: 链上**真**验证结论 —— 拿到 txHash 不等于已验证; 只有 receipt.status=1 + 确认数够 + 事件对得上才 true */
    chainSettled?: boolean;
    /** 链上判定状态: confirmed/finalized/pending/unknown/reverted/event_mismatch/reorged/... */
    chainSettlementStatus?: string;
    /** 判定理由 (可读, 审计用) */
    chainSettlementReason?: string;
    /** 判定时的确认数 (与门槛一起看才有意义) */
    confirmations?: number;
    confirmationsRequired?: number;
    /** RPC 能不能到 (false 时上面的 unknown 才解释得通) */
    rpcAvailable?: boolean;
  };
  raw?: string;
  error?: string;
}

/**
 * 购买一条信息: 未付款时服务端回 402, 这里用标准 x402 客户端 (402→签名→重试) 完成支付。
 * 无钱包私钥时, 只有显式 allowLocalDev 才走本机联调头。
 */
function makeTracker(onEvent?: (e: { kind: string; detail?: string; patch?: Record<string, unknown> }) => Promise<void>) {
  return async (e: { kind: string; detail?: string; patch?: Record<string, unknown> }) => { if (onEvent) await onEvent(e).catch(() => null); };
}

// ── F5: 链上真验证接入 (拿 txHash ≠ 链上已验证) ──────────────────────────────

export interface ChainSettlementOptions {
  /** 注入验证器 (测试 / 自定义链); 缺省 = 用本机链配置做真链验证 */
  verifier?: ChainSettlementVerifier;
  /** 期望: escrow 模式要 taskKey/resultHash; erc20_transfer 模式要 token/收款方 */
  expect?: ChainSettlementExpect;
  /** 判定门槛 (缺省 'confirmed') */
  gate?: 'confirmed' | 'finalized';
  /** 持久记录里的旧事实 (给重组检测用) */
  recorded?: { blockNumber?: number | null; confirmations?: number; status?: string };
}

/**
 * ★ F5 修复点。
 * 老代码: `chainSettled = !!txHash` —— 拿到 txHash 就宣称链上已验证 (从不读 receipt/事件/确认数)。
 * 新逻辑:
 *   · 没有 txHash              → `not_attempted`, chainSettled=false (没发过链上交易)
 *   · 读不到 RPC / receipt     → `unknown`, chainSettled=false (不确定 ≠ 没付)
 *   · receipt.status == 0      → `reverted`, chainSettled=false
 *   · 确认数 < 门槛            → `pending`, chainSettled=false
 *   · 事件(taskKey/resultHash)对不上 → `event_mismatch`, chainSettled=false
 *   · 全过                     → `confirmed`/`finalized`, chainSettled=true
 * 验证器本身抛错也**不会**炸付款路径: 一律降级成 `unknown` + chainSettled=false (fail-closed)。
 */
export async function verifyPaymentOnChain(args: {
  txHash: string;
  chainSettlement?: ChainSettlementOptions;
}): Promise<ChainSettlementVerdict> {
  const gate = args.chainSettlement?.gate || 'confirmed';
  const txHash = String(args.txHash || '');
  if (!txHash) {
    return {
      chainSettled: false, status: 'not_attempted',
      reason: 'facilitator 说成功但没给 txHash: 没有链上交易可查, 不能认定链上结算完成',
      confirmationsRequired: 0, requiredGate: gate, rpcAvailable: true, checkedAt: Date.now(), evidence: {},
    };
  }
  try {
    const verifier = args.chainSettlement?.verifier
      ?? (await import('../chain/chain-settlement.js')).createDefaultChainSettlementVerifier({ gate });
    return await verifier({ txHash, expect: args.chainSettlement?.expect, gate, recorded: args.chainSettlement?.recorded });
  } catch (e: any) {
    return {
      chainSettled: false, status: 'unknown',
      reason: `链上验证器抛错 → 不能判已结算: ${String(e?.message || e).slice(0, 200)}`,
      txHash, confirmationsRequired: 0, requiredGate: gate, rpcAvailable: false,
      checkedAt: Date.now(), evidence: { verifierError: String(e?.message || e).slice(0, 200) },
    };
  }
}

export async function buyInfo(params: {
  url: string;
  privateKey?: string;
  maxPaymentAmount?: string;
  network?: string;
  rpcUrl?: string;
  allowLocalDev?: boolean;
  resolveDid?: import('./paid-info-protocol.js').DidKeyResolver;
  expectItemId?: string;
  fetchImpl?: typeof fetch;
  /** Phase 2 策略门: 在**任何签名/解密/付款之前**调用; 返回 ok:false 就必须原样停下 */
  prePayGuard?: (info: { requirements: any; url: string }) => Promise<{ ok: boolean; reason?: string }>;
  /** Phase 5 审计: 交易记录钩子 (每次状态推进都回调) */
  onEvent?: (e: { kind: string; detail?: string; patch?: Record<string, unknown> }) => Promise<void>;
  /**
   * ★ F5 (可选, 不传 = 用本机链配置做真链验证; 配置取不到则如实判"未结算/不确定"):
   * 链上结算的真验证参数。老调用方不传这个字段也能跑 (签名兼容)。
   */
  chainSettlement?: ChainSettlementOptions;
}): Promise<BuyInfoResult> {
  const { verifyEnvelope } = await import('./paid-info-protocol.js');
  const doFetch = params.fetchImpl ?? fetch;
  const trackEvent = makeTracker(params.onEvent);

  // ① 先探一次: 判断是否 402 (以及免费信息直接返回)
  let res: Response;
  try {
    res = await doFetch(params.url, { method: 'GET' });
  } catch (e: any) {
    return { ok: false, error: `请求失败: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (res.status !== 402) {
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      // 免费 (或已经不带支付就给了内容)
      const parsed = safeJson(text);
      const report = parsed?.proof ? await verifyEnvelope(parsed, { resolveDid: params.resolveDid, expectItemId: params.expectItemId }) : undefined;
      return { ok: true, status: res.status, envelope: parsed, verify: report, raw: text };
    }
    return { ok: false, status: res.status, error: `服务端返回 ${res.status}: ${text.slice(0, 200)}` };
  }

  // ② 402 → (策略门) → 支付 → 重试
  const requirementBody = safeJson(await res.text());
  const requirements = requirementBody?.accepts?.[0];
  if (!requirements) return { ok: false, status: 402, error: '402 响应缺少 accepts' };
  const metadata = requirementBody?.metadata || requirementBody?.item || null;
  await trackEvent({ kind: 'payment_required', detail: `amount=${requirements.amount} network=${requirements.network}` });

  // Phase 2: 策略门 —— 必须在解密钱包/签名/付款之前 (顺序不可颠倒)
  if (params.prePayGuard) {
    const gate = await params.prePayGuard({ requirements, url: params.url });
    if (!gate.ok) {
      await trackEvent({ kind: 'policy_denied', detail: gate.reason });
      return { ok: false, status: 402, policyDenied: true, error: gate.reason || '策略拒绝', metadata, raw: JSON.stringify(requirementBody) };
    }
    await trackEvent({ kind: 'policy_allowed', detail: '策略通过, 允许进入付款' });
  }

  let paymentHeader = '';
  let mode = '';
  if (params.privateKey) {
    // 标准 x402 客户端: 用 @x402/fetch 里同一套 createX402PaymentFetch 完成签名支付
    const { createX402PaymentFetch } = await import('./x402Pay.js');
    const paymentFetch = await createX402PaymentFetch({
      privateKey: params.privateKey,
      network: params.network,
      maxPaymentAmount: params.maxPaymentAmount,
      rpcUrl: params.rpcUrl,
    });
    // ★ 真把付款凭据发出去了 → 结算事实 payment_submitted (这一步之后失败都不能当"没付过钱")
    await trackEvent({ kind: 'payment_sending', detail: 'facilitator 模式: 已发出 x402 付款请求', patch: { settlementFact: 'payment_submitted' } as any });
    const retry = await paymentFetch(params.url, { method: 'GET' });
    const text = await retry.text();
    const parsed = safeJson(text);
    const receipt = retry.headers.get('x-payment-response') || parsed?.payment?.receipt || '';
    // ★ 链上事实需要 txHash: facilitator 说成功但没有 txHash → 不能标 chainSettled (真跑抓到过这类"假结算")
    const txHash = parsed?.payment?.txHash || retry.headers.get('x-payment-txhash') || parsed?.txHash || '';
    if (retry.status < 200 || retry.status >= 300) {
      // 付款这一步已经发出去了 (可能已上链), 只是拿资源失败 → 绝不许当"没付过钱"
      // ★ F5: 有 txHash 就去链上真查一遍, 而不是"有 txHash 就算结算"
      const v = await verifyPaymentOnChain({ txHash, chainSettlement: params.chainSettlement });
      return {
        ok: false, status: retry.status,
        payment: {
          mode: 'facilitator', receipt: receipt || undefined, attempted: true, settled: true,
          settlementUncertain: !receipt && !v.chainSettled,
          chainSettled: v.chainSettled, chainSettlementStatus: v.status, chainSettlementReason: v.reason,
          confirmations: v.confirmations, confirmationsRequired: v.confirmationsRequired, rpcAvailable: v.rpcAvailable,
          ...(txHash ? { txHash } : {}),
        },
        error: `付款后重试失败 ${retry.status}: ${text.slice(0, 200)}`,
      };
    }
    mode = 'facilitator';
    // ★ F5 修复: 拿到 txHash ≠ 链上已验证。真验证 = receipt(status==1) + 确认数 + 事件(taskKey/resultHash) + 合约 escrow 状态。
    const verdict = await verifyPaymentOnChain({ txHash, chainSettlement: params.chainSettlement });
    await trackEvent({
      kind: 'settled',
      detail: `mode=facilitator receipt=${receipt.slice(0, 24)}… txHash=${txHash ? `${String(txHash).slice(0, 16)}…` : '(缺失: 不能认定链上结算完成)'} 链上判定=${verdict.status}` +
        (verdict.confirmations != null ? ` 确认数=${verdict.confirmations}/${verdict.confirmationsRequired}` : ''),
      patch: {
        paymentMode: 'facilitator', paymentReceipt: receipt,
        chainSettled: verdict.chainSettled,
        chainSettlementStatus: verdict.status,
        chainSettlementReason: verdict.reason,
        ...(verdict.confirmations != null ? { chainConfirmations: verdict.confirmations } : {}),
        ...(verdict.rpcAvailable ? {} : { chainRpcAvailable: false }),
        ...(txHash ? { txHash: String(txHash) } : {}),
      },
    });
    const report = parsed?.proof ? await verifyEnvelope(parsed, { resolveDid: params.resolveDid, expectItemId: params.expectItemId }) : undefined;
    if (report) await trackEvent({ kind: 'delivered', detail: `trust=${report.trust}`, patch: { verificationTrust: report.trust as any, contentHash: parsed?.contentHash, protocolVerified: report.trust === 'verified' } });
    return {
      ok: true, status: retry.status, envelope: parsed, verify: report, metadata, raw: text,
      payment: {
        mode, receipt,
        ...(txHash ? { txHash } : {}),
        attempted: true, settled: true,
        settlementUncertain: verdict.status === 'unknown' || verdict.status === 'config_unavailable' || !verdict.rpcAvailable,
        chainSettled: verdict.chainSettled,
        chainSettlementStatus: verdict.status,
        chainSettlementReason: verdict.reason,
        confirmations: verdict.confirmations,
        confirmationsRequired: verdict.confirmationsRequired,
        rpcAvailable: verdict.rpcAvailable,
      },
    };
  }

  if (!params.allowLocalDev) {
    return { ok: false, status: 402, error: '需要钱包私钥才能支付 (未提供 privateKey; 本机联调请显式 allowLocalDev)' };
  }
  paymentHeader = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: requirements,
    payload: { localDev: true, at: new Date().toISOString() },
    payer: 'local-dev',
  }), 'utf-8').toString('base64');
  await trackEvent({ kind: 'payment_sending', detail: 'local-dev 模式: 已发出 X-PAYMENT 请求 (非链上)', patch: { settlementFact: 'payment_submitted' } as any });
  const retry = await doFetch(params.url, { method: 'GET', headers: { 'X-PAYMENT': paymentHeader } });
  const text = await retry.text();
  const parsed = safeJson(text);
  if (retry.status < 200 || retry.status >= 300) {
    return {
      ok: false, status: retry.status,
      payment: { mode: 'local-dev', attempted: true, settled: false, settlementUncertain: false },
      error: `本机联调付款被拒 ${retry.status}: ${text.slice(0, 200)}`,
    };
  }
  mode = 'local-dev';
  const receiptLd = retry.headers.get('x-payment-response') || parsed?.payment?.receipt || '';
  await trackEvent({ kind: 'settled', detail: 'mode=local-dev (非链上)', patch: { paymentMode: 'local-dev', paymentReceipt: receiptLd, chainSettled: false } });
  const report = parsed?.proof ? await verifyEnvelope(parsed, { resolveDid: params.resolveDid, expectItemId: params.expectItemId }) : undefined;
  if (report) await trackEvent({ kind: 'delivered', detail: `trust=${report.trust} (本机联调)`, patch: { verificationTrust: report.trust as any, contentHash: parsed?.contentHash, protocolVerified: report.trust !== 'unverified' } });
  return {
    ok: true, status: retry.status, envelope: parsed, verify: report, metadata,
    payment: { mode, receipt: receiptLd, attempted: true }, raw: text,
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
