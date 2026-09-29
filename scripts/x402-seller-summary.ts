/**
 * x402-seller-summary.ts — 读卖方端点的**只读汇总** (GET /api/x402/seller/summary)
 *
 * 用途: 网关页付款行的「其中经 x402 流程」判定 —— 拿卖方端点台账里的 txHash 列表
 *   与链上扫到的收款做**交叉核** (链上只有普通 ERC-20 转账, 单看链分不出"走没走 x402")。
 *
 * 认证: 本机 0600 共享密钥 (~/.bolloon/x402-seller-auth.json) 的 HMAC-SHA256
 *   (方法/路径/时间戳/nonce/请求体哈希 —— 与卖方端点同一套, 见 x402/seller-signing.ts)。
 *
 * 诚实口径 (硬要求): 任何一步失败 (无密钥文件 / 端点不可达 / 非 200 / 形状不对) →
 *   写**一条明确原因**的 `unavailable`, **绝不**回落成"0 笔" —— 0 的意思是"一笔都没有", 那是另一句话。
 *
 * 落盘: ~/.bolloon/x402-seller-summary.json (缓存 + 取数时刻 + 来源 + 原因), 供导出脚本读。
 * 本脚本**只 GET**, 不 POST, 不改远端任何状态。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { authCanonicalString, computeAuthSignature } from '../src/agents/x402/seller-signing.js';
import { bolloonHome } from '../src/agents/chain/chain-config.js';

export interface SellerSummaryCache {
  available: boolean;
  reason: string;
  fetched_at: number;
  endpoint: string;
  /** 端点报的 x402 直付笔数 (available=false → null) */
  count: number | null;
  /** txHash (小写) → { itemId?, amount?, settledAt? } (available=false → 空对象) */
  txs: Record<string, { itemId?: string; amount?: string; settledAt?: string }>;
  /** 端点原文里的总额 (有就留, 没有就 null —— 不自己算) */
  total_atomic?: string | null;
  http_status?: number;
  source?: string;
}

const AUTH_FILE = (home?: string) => path.join(bolloonHome(home), 'x402-seller-auth.json');
export const summaryCachePath = (home?: string) => path.join(bolloonHome(home), 'x402-seller-summary.json');

/** 读本机卖方认证配置 (只取 keyId/secret/endpoint; 密钥**不进任何输出**) */
export function readSellerAuth(home?: string): { keyId: string; secret: string; endpoint: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE(home), 'utf8'));
    if (!raw?.secret || !raw?.keyId) return null;
    return { keyId: String(raw.keyId), secret: String(raw.secret), endpoint: String(raw.endpoint || 'https://pay.bolloon.cn') };
  } catch { return null; }
}

function unavailable(reason: string, endpoint: string, extra: Partial<SellerSummaryCache> = {}): SellerSummaryCache {
  return { available: false, reason, fetched_at: Date.now(), endpoint, count: null, txs: {}, total_atomic: null, ...extra };
}

/** 从端点返回体里抽出 txHash 列表 (形状宽容, 但**认不出就不猜**: 认不出 → unavailable) */
function extractTxs(body: any): { txs: Record<string, { itemId?: string; amount?: string; settledAt?: string }>; total: string | null } | null {
  const out: Record<string, { itemId?: string; amount?: string; settledAt?: string }> = {};
  const take = (row: any) => {
    const h = String(row?.txHash || row?.tx_hash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) return false;
    out[h] = {
      itemId: row?.itemId != null ? String(row.itemId) : undefined,
      amount: row?.amount != null ? String(row.amount) : undefined,
      settledAt: row?.settledAt != null ? String(row.settledAt) : undefined,
    };
    return true;
  };
  let any = false;
  if (Array.isArray(body?.txs)) { for (const r of body.txs) any = take(r) || any; }
  else if (body?.txs && typeof body.txs === 'object') {
    for (const [k, v] of Object.entries(body.txs)) { any = take({ txHash: k, ...(v as any) }) || any; }
  }
  if (!any && Array.isArray(body?.entries)) { for (const r of body.entries) any = take(r) || any; }
  if (!any && Array.isArray(body?.payments)) { for (const r of body.payments) any = take(r) || any; }
  if (!any) return null;
  const total = body?.totalAtomic != null ? String(body.totalAtomic) : (body?.total_atomic != null ? String(body.total_atomic) : null);
  return { txs: out, total };
}

/**
 * 取卖方端点的只读汇总 + 落盘缓存。**永不抛** (失败 = 一条 available:false + 原因)。
 * @param dryRun 只取数不落盘 (测试用)
 */
export async function fetchSellerSummary(opts: { home?: string; endpoint?: string; timeoutMs?: number; dryRun?: boolean; fetchImpl?: typeof fetch } = {}): Promise<SellerSummaryCache> {
  const auth = readSellerAuth(opts.home);
  const endpoint = String(opts.endpoint || auth?.endpoint || 'https://pay.bolloon.cn').replace(/\/$/, '');
  const urlPath = '/api/x402/seller/summary';
  if (!auth) return unavailable(`本机没有卖方认证密钥 (~/.bolloon/x402-seller-auth.json 读不到) → 无法认证读取汇总`, endpoint, { source: 'seller-endpoint' });
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = computeAuthSignature(auth.secret, { method: 'GET', path: urlPath, ts, nonce });
  const f = opts.fetchImpl || fetch;
  let res: Response;
  try {
    res = await f(`${endpoint}${urlPath}`, {
      method: 'GET',
      headers: {
        'x-bolloon-seller-key': auth.keyId,
        'x-bolloon-seller-ts': ts,
        'x-bolloon-seller-nonce': nonce,
        'x-bolloon-seller-sig': sig,
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
    });
  } catch (e: any) {
    return unavailable(`卖方端点不可达/超时 (${String(e?.message || e).slice(0, 120)}) → 经 x402 流程口径未知`, endpoint, { source: 'seller-endpoint' });
  }
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    return unavailable(`卖方端点回 HTTP ${res.status}${body?.code ? ` (${body.code})` : ''} → 经 x402 流程口径未知`, endpoint, { http_status: res.status, source: 'seller-endpoint' });
  }
  const parsed = extractTxs(body);
  if (!parsed) return unavailable(`卖方端点回了 200 但体里认不出 txHash 列表 (形状变了?) → 经 x402 流程口径未知`, endpoint, { http_status: res.status, source: 'seller-endpoint' });
  const cache: SellerSummaryCache = {
    available: true,
    reason: `卖方端点只读汇总 (${endpoint}${urlPath}) 取到 ${Object.keys(parsed.txs).length} 笔`,
    fetched_at: Date.now(), endpoint,
    count: Object.keys(parsed.txs).length,
    txs: parsed.txs,
    total_atomic: parsed.total,
    http_status: res.status,
    source: 'seller-endpoint',
  };
  if (!opts.dryRun) {
    try {
      fs.mkdirSync(path.dirname(summaryCachePath(opts.home)), { recursive: true });
      fs.writeFileSync(summaryCachePath(opts.home), JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch { /* 落盘失败不影响返回 (但导出脚本会拿不到缓存 → 如实未知) */ }
  }
  return cache;
}

/** 读缓存 (导出脚本用: 只读盘, **不发网络**) */
export function readSellerSummaryCache(home?: string): SellerSummaryCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(summaryCachePath(home), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw as SellerSummaryCache;
  } catch { return null; }
}

// CLI: npx tsx scripts/x402-seller-summary.ts
if (process.argv[1] && /x402-seller-summary\.(ts|js)$/.test(process.argv[1])) {
  fetchSellerSummary({}).then((s) => {
    // 只打印聚合与原因, 不打印任何 txHash/地址 (它不该出现在日志里)
    console.log(`[seller-summary] available=${s.available} count=${s.count === null ? 'unknown' : s.count} total_atomic=${s.total_atomic ?? 'null'} http=${s.http_status ?? '-'}`);
    console.log(`[seller-summary] 原因: ${s.reason}`);
    process.exit(s.available ? 0 : 3);
  }).catch((e) => { console.error('[seller-summary] 失败:', e?.message || e); process.exit(1); });
}
