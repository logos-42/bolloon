/**
 * seller-summary.ts — 卖方端点的**公开只读汇总** (bolloon-x402-seller-summary/1)
 *
 * 一句话: 把「真成交」变成网页上看得见、且**能在链上独立核验**的数字。
 *
 * 与卖方签名队列 (bolloon-x402-seller/1) 的分工:
 *   · 那条是**私有**通道 (HMAC 认证, 带付款凭据原文) —— 只给卖方本机用;
 *   · 这条是**公开只读**聚合 —— 只出**链上可核验的事实**: 每笔带 tx_hash + 块号 +
 *     区块浏览器链接; 绝不带取件 token / 凭据回执 / 任何 EOA 地址。
 *
 * 数据源 (每次请求**实时读盘**, 不缓存; 读不到 → 空数组 + 0 且仍 200, 不 500):
 *   ① 直付台账  <home>/.bolloon/x402-direct-txs.json
 *      —— 每一条 = 一次**链上核验通过**的买方直付 (receipt.status=1 · 日志里有 USDC
 *         Transfer→payTo · value >= accepts.amount · **≥2 条不同 RPC 结论一致**),
 *         由 `direct-payment.ts` 落盘。行里带 tx_hash / block_number ⇒ 可在区块浏览器复核。
 *   ② 交付队列  <home>/.bolloon/x402-seller-pending/*.json
 *      —— 只用来数 delivered (已签) / awaiting_signature (待签), **不读凭据原文**。
 *
 * 诚实口径 (不许美化):
 *   · 计数口径 = 「**本端点收款地址**上、经链上核验的直付成交」; 它**不是**全网站点销量,
 *     也**不是**合约托管/结算总量 (托管结算在链上合约里, 不在这条口径内)。
 *   · 每条都附 tx_hash + 块号 ⇒ 买方/任何第三方可**自己**上链复核, 不必信本端点。
 *   · 核验依赖公共 RPC (≥2 条一致才算事实) ⇒ 出现矛盾时那笔**不会被记进台账**。
 *
 * 隐私红线 (硬; 见 `auditSellerSummaryLeaks`):
 *   绝不返回 取件 token · 付款凭据原文/回执哈希 · 任何密钥/DID · **任何 EOA 或合约地址**
 *   (付款人 `from` / 收款人 `to` / 资产合约 `asset` / item 的 `payTo` 一律不出)。
 *   允许: `tx_hash`(0x+64) 与 `explorer_tx`(区块浏览器交易链接) —— 公开链上事实。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { explorerTxUrl, isExplorerUrl } from '../chain/explorer.js';
import { fromAtomicAmount } from './paid-info-store.js';

// ────────────────────────────────────────────────────────────── 常量

export const SELLER_SUMMARY_PROTOCOL = 'bolloon-x402-seller-summary/1';
/** 队列端点前缀之上; nginx 只放行 `^~ /api/x402/` ⇒ 只能长在这下面 */
export const SELLER_SUMMARY_PATH = '/api/x402/seller/summary';

/** 直付台账文件名 (与 direct-payment.ts 的 DIRECT_TX_LEDGER_FILE 同一份事实) */
export const DIRECT_TX_LEDGER_FILENAME = 'x402-direct-txs.json';
/** 交付队列目录名 (与 seller-signing.ts 的 SELLER_PENDING_DIRNAME 同一份事实) */
export const SELLER_PENDING_DIRNAME = 'x402-seller-pending';

// ────────────────────────────────────────────────────────────── 形状

/** 一笔**链上已核验**的直付成交 (网页上可核验的最小单位) */
export interface SellerSummarySale {
  /** 链上结算时间 (台账首见时间; 第二次提交同一 txHash 会复用 ⇒ 稳定) */
  settled_at: string;
  item_id: string;
  /** 原子单位 (USDC 6 位 ⇒ "10000" = 0.01 USDC) */
  amount_atomic: string;
  /** 人类可读 ("0.01 USDC"); 认不出币种时**不折算**, 退化成原子串本身 */
  amount_display: string;
  currency: string;
  network: string;
  chain_id: number;
  /** 块号 —— 与 tx_hash 一起构成可核验坐标 */
  block_number: number;
  /** 公开链上事实 (允许出现) */
  tx_hash: string;
  /** `https://<explorer>/tx/0x…`; 该链没有已知浏览器时**键不存在** (绝不编死链) */
  explorer_tx?: string;
}

export interface SellerSummaryByItem {
  item_id: string;
  sales: number;
  amount_atomic: string;
  amount_display: string;
  currency: string;
  network: string;
}

export interface SellerSummary {
  protocol: typeof SELLER_SUMMARY_PROTOCOL;
  ok: boolean;
  /**
   * 自述 (口径)。**必须**讲清: 这是**卖方本机的链下台账**, 不是链上索引;
   * 每笔对应一笔**已在链上核验过**的直付交易 (tx_hash + 块号), 可独立复核。
   */
  scope: {
    title: { zh: string; en: string };
    ledger: { zh: string; en: string };
    verifiable: { zh: string; en: string };
    not: { zh: string; en: string };
  };
  generated_at: string;
  totals: {
    /** 链上核验通过的直付成交笔数 (= sales.length) */
    chain_verified_sales: number;
    /** 已签名交付笔数 (队列里 status=signed) */
    delivered: number;
    /** 已签交付里**没有**可核验 txHash 的条数 (正常应为 0; 非 0 说明交付凭据不全) */
    delivered_unverifiable: number;
    /** 已付款待卖方签名 (过期的待签名不算) */
    awaiting_signature: number;
    /** 待办总数 (队列里的记录数) */
    pending_total: number;
  };
  /**
   * 已交付笔数对应的链上 txHash 列表 (去重; 时间倒序)。
   * 供统一索引区判定「其中哪些经 x402 流程」—— 这里只给 txHash, 不给任何地址/凭据。
   */
  delivered_tx_hashes: string[];
  /**
   * txHash → { itemId, amount, settledAt } 映射 (字段名 camelCase)。
   * 这是给**统一索引区**做「链上收款 ≠ 一笔, 但其中哪些走了 x402」交叉核的最小机器面
   * (消费方按 txHash 建索引; 键即哈希, 值里不含地址/凭据)。
   */
  txs: Record<string, { itemId: string; amount: string; settledAt: string }>;
  /** 总收款原子串 (与 revenue.amount_atomic 同值的扁平副本, 方便机器读) */
  total_atomic: string;
  /** 总收款 (按 item 汇总; 原子串 + 人读) */
  revenue: { amount_atomic: string; amount_display: string; currency: string };
  by_item: SellerSummaryByItem[];
  /** 最近一笔 (无成交 → null) */
  latest: SellerSummarySale | null;
  /** 每笔一行 (按时间倒序) */
  sales: SellerSummarySale[];
  /** 因隐私红线被剔除的条目数 (正常恒 0; >0 说明实现有 bug, 但要如实报出来) */
  privacy_blocked: number;
}

// ────────────────────────────────────────────────────────────── 隐私守卫

/**
 * 本模块**允许**输出的键名白名单 (精确匹配)。
 * 白名单先判 —— 否则 `awaiting_signature` 会被 `signature` 那条禁用词误伤。
 * 白名单只免掉「键名检查」, 值形态检查照旧全过 (地址/裸哈希越界一样拦)。
 */
const ALLOWED_KEYS = new Set([
  'protocol', 'ok', 'scope', 'title', 'ledger', 'verifiable', 'not',
  'generated_at', 'totals', 'chain_verified_sales', 'delivered', 'delivered_unverifiable',
  'awaiting_signature', 'pending_total', 'delivered_tx_hashes', 'txs', 'total_atomic',
  'revenue', 'by_item', 'item_id', 'itemId', 'sales', 'amount', 'amount_atomic', 'amount_display', 'currency',
  'network', 'chain_id', 'block_number', 'tx_hash', 'explorer_tx', 'latest', 'privacy_blocked',
  'settled_at', 'settledAt', 'zh', 'en',
]);
/** `txs` 映射里每一行允许出现的字段 (消费方按 txHash 取这三项做交叉核) */
const TXS_ROW_KEYS = new Set(['itemId', 'amount', 'settledAt']);
/** 禁用的键名 (命中即剔除): 凭据 / token / 密钥 / DID / 任何地址类键 */
const FORBIDDEN_KEY_RE = /(receipt|token|payer|payto|pay_to|private|secret|seed|mnemonic|signature|wallet|address|did|^from$|^to$|^asset$|^tx$)/i;
/**
 * EOA / 合约地址形状 (0x + **正好** 40 hex): 一律不许出现 —— 白名单键也没有例外。
 * 用负向回顾/前瞻把它与 0x+64 的交易哈希区分开 (否则 64 位哈希的前 40 位会被误判成地址)。
 */
const ADDRESSISH_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
/** 裸交易哈希形状 (0x + 64 hex): **只允许**在 tx_hash 键下 */
const BARE_TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** 任何 0x+64 hex 片段: 只允许出现在 tx_hash / explorer_tx 键下 */
const ANY_TXHASH_RE = /0x[0-9a-fA-F]{64}/;

/**
 * 汇总自检: 返回违反隐私红线的路径清单 (空 = 通过)。
 * 判据是「**键名 + 值形态**」双重: 光靠键名挡不住调用方把地址塞进自造字段。
 */
export function auditSellerSummaryLeaks(obj: unknown, at = '$'): string[] {
  const issues: string[] = [];
  if (obj === null || obj === undefined) return issues;
  if (typeof obj === 'string') {
    // 顶层裸字符串: 地址形态 / 裸哈希都算越界 (白名单只在**键**层面成立)
    if (ADDRESSISH_RE.test(obj)) issues.push(`${at}: 出现 0x+40 地址形态`);
    else if (BARE_TXHASH_RE.test(obj)) issues.push(`${at}: 裸 0x+64 哈希出现在非白名单键下`);
    return issues;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => issues.push(...auditSellerSummaryLeaks(v, `${at}[${i}]`)));
    return issues;
  }
  if (typeof obj !== 'object') return issues;

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = `${at}.${k}`;
    const allowedKey = ALLOWED_KEYS.has(k);
    if (!allowedKey && FORBIDDEN_KEY_RE.test(k)) { issues.push(`${key}: 键名命中禁用词`); continue; }
    // 白名单第二处: 已交付 txHash 列表 —— 只允许裸交易哈希 (0x+64), 不给地址/凭据
    if (k === 'delivered_tx_hashes') {
      if (!Array.isArray(v)) issues.push(`${key}: 必须是字符串数组`);
      else v.forEach((h, i) => {
        if (typeof h !== 'string' || !BARE_TXHASH_RE.test(h)) issues.push(`${key}[${i}]: 只允许 0x+64 交易哈希`);
      });
      continue;
    }
    // 白名单第三处: txHash → 行 的映射。**键本身是哈希**, 所以键形状要单独验;
    // 行内只允许消费方约定的三个字段 (多一个字段 = 可能夹带地址/凭据)。
    if (k === 'txs') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { issues.push(`${key}: 必须是 {txHash: 行} 映射`); continue; }
      for (const [th, row] of Object.entries(v as Record<string, unknown>)) {
        const short = `${th.slice(0, 12)}…`;
        if (!BARE_TXHASH_RE.test(th)) { issues.push(`${key}.${short}: 键必须是 0x+64 交易哈希`); continue; }
        if (!row || typeof row !== 'object') { issues.push(`${key}.${short}: 行必须是对象`); continue; }
        for (const f of Object.keys(row as Record<string, unknown>)) {
          if (!TXS_ROW_KEYS.has(f)) issues.push(`${key}.${short}.${f}: 字段不在白名单 (只许 itemId/amount/settledAt)`);
        }
        issues.push(...auditSellerSummaryLeaks(row, `${key}.${short}`));
      }
      continue;
    }
    if (typeof v === 'string') {
      if (ADDRESSISH_RE.test(v)) issues.push(`${key}: 值出现 0x+40 地址形态`);
      if (BARE_TXHASH_RE.test(v) && k !== 'tx_hash') issues.push(`${key}: 裸 0x+64 哈希只允许在 tx_hash 键下`);
      if (ANY_TXHASH_RE.test(v) && k !== 'tx_hash' && k !== 'explorer_tx') issues.push(`${key}: 0x+64 只允许在 tx_hash / explorer_tx 键下`);
      if (k === 'explorer_tx' && !isExplorerUrl(v)) issues.push(`${key}: explorer_tx 形状不对 (只认 /tx/0x64hex)`);
      continue;
    }
    issues.push(...auditSellerSummaryLeaks(v, key));
  }
  return issues;
}

// ────────────────────────────────────────────────────────────── 读盘 (实时, 不缓存)

function ledgerPath(home: string): string {
  return path.join(home, '.bolloon', DIRECT_TX_LEDGER_FILENAME);
}
function pendingDir(home: string): string {
  return path.join(home, '.bolloon', SELLER_PENDING_DIRNAME);
}
function itemPath(itemId: string, home: string): string {
  const id = String(itemId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(home, '.bolloon', 'x402-info', `${id}.json`);
}

interface RawLedgerTx {
  txHash?: string; itemId?: string; network?: string; chainId?: number;
  amount?: string; blockNumber?: number; settledAt?: string;
}

/** 读直付台账 (坏文件 / 不存在 → 空; 绝不抛) */
async function readLedgerTxs(home: string): Promise<RawLedgerTx[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath(home), 'utf-8'));
    const txs = parsed?.txs;
    if (!txs || typeof txs !== 'object') return [];
    return Object.values(txs as Record<string, RawLedgerTx>).filter((r) => !!r && typeof r === 'object');
  } catch {
    return [];
  }
}

/** 读交付队列的**计数与已交付 txHash**(只取状态/时间/链上哈希; 凭据原文一律不读出来) */
async function readQueueCounts(home: string): Promise<{
  delivered: number; awaiting: number; total: number;
  deliveredTxHashes: string[]; deliveredUnverifiable: number;
}> {
  const dir = pendingDir(home);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { delivered: 0, awaiting: 0, total: 0, deliveredTxHashes: [], deliveredUnverifiable: 0 };
  }
  let delivered = 0; let awaiting = 0; let total = 0; let unverifiable = 0;
  const txHashes: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;   // 目录里的 .nonces.json 不算待办
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
      if (!rec?.pendingId) continue;
      total += 1;
      const expired = rec.status === 'awaiting_signature' && Date.parse(rec.expiresAt) < Date.now();
      if (rec.status === 'signed') {
        delivered += 1;
        // 已交付 → 交出它对应的链上 txHash (供统一索引区判定「其中经 x402 流程」)
        const tx = String(rec?.payment?.txHash || '').toLowerCase();
        if (BARE_TXHASH_RE.test(tx)) txHashes.push(tx);
        else unverifiable += 1;    // 没有可核验哈希的交付: 计数如实留痕, 不编一个哈希
      } else if (rec.status === 'awaiting_signature' && !expired) awaiting += 1;
    } catch { /* 坏文件跳过 (不因一个坏文件看不到全部) */ }
  }
  return { delivered, awaiting, total, deliveredTxHashes: [...new Set(txHashes)], deliveredUnverifiable: unverifiable };
}

/** item 的币种/网络 (取自上架条目本身); 读不到 → 交给调用方按资产地址兜底 */
async function readItemMeta(itemId: string, home: string): Promise<{ currency?: string; network?: string } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(itemPath(itemId, home), 'utf-8'));
    const price = parsed?.item?.price;
    if (!price) return null;
    return {
      ...(price.currency ? { currency: String(price.currency) } : {}),
      ...(price.network ? { network: String(price.network) } : {}),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────── 聚合

function fmt(atomic: string, currency: string): string {
  return `${fromAtomicAmount(atomic, currency)} ${currency}`;
}

/**
 * 构建公开只读汇总。**每笔都来自链上核验过的台账**; 读不到任何源就回空数组 + 0 (仍 ok)。
 * 不缓存: 每次调用真读盘 (改价/新成交不必重启服务)。
 */
export async function buildSellerSummary(
  home: string = os.homedir(),
  now: number = Date.now(),
): Promise<SellerSummary> {
  const [rawTxs, queue] = await Promise.all([readLedgerTxs(home), readQueueCounts(home)]);

  // item → 币种/网络 (每个 item 只读一次)
  const metaCache = new Map<string, { currency?: string; network?: string } | null>();
  const rows: SellerSummarySale[] = [];
  let blocked = 0;

  for (const r of rawTxs) {
    const txHash = String(r.txHash || '').toLowerCase();
    const itemId = String(r.itemId || '');
    if (!BARE_TXHASH_RE.test(txHash) || !itemId) { blocked += 1; continue; }  // 形状不对 = 不进公开面
    const chainId = Number(r.chainId);
    // item 元数据 (币种/网络) 每个 item 只读一次; 读不到就只信台账自己的字段
    if (!metaCache.has(itemId)) metaCache.set(itemId, await readItemMeta(itemId, home));
    const meta = metaCache.get(itemId);
    const network = String(r.network || meta?.network || '');
    const currency = meta?.currency || 'USDC';   // x402 付费信息默认 USDC
    const amountAtomic = String(r.amount || '0');
    const explorer = explorerTxUrl(chainId, txHash);
    rows.push({
      settled_at: String(r.settledAt || ''),
      item_id: itemId,
      amount_atomic: amountAtomic,
      amount_display: fmt(amountAtomic, currency),
      currency,
      network,
      chain_id: Number.isFinite(chainId) ? chainId : 0,
      block_number: Number(r.blockNumber) || 0,
      tx_hash: txHash,
      ...(explorer ? { explorer_tx: explorer } : {}),
    });
  }

  rows.sort((a, b) => String(b.settled_at).localeCompare(String(a.settled_at)));

  // 按 item 汇总
  const byItem = new Map<string, SellerSummaryByItem>();
  for (const s of rows) {
    const cur = byItem.get(s.item_id) || {
      item_id: s.item_id, sales: 0, amount_atomic: '0',
      amount_display: fmt('0', s.currency), currency: s.currency, network: s.network,
    };
    const summed = (BigInt(cur.amount_atomic) + BigInt(/^\d+$/.test(s.amount_atomic) ? s.amount_atomic : '0')).toString();
    cur.sales += 1;
    cur.amount_atomic = summed;
    cur.amount_display = fmt(summed, cur.currency);
    byItem.set(s.item_id, cur);
  }

  const revenueAtomic = [...byItem.values()]
    .reduce((n, x) => n + BigInt(x.amount_atomic), 0n).toString();
  const revenueCurrency = [...byItem.values()][0]?.currency || 'USDC';

  const summary: SellerSummary = {
    protocol: SELLER_SUMMARY_PROTOCOL,
    ok: true,
    scope: {
      title: {
        zh: '卖方本机台账 (链下) — 已交付笔数与对应链上 txHash',
        en: 'Seller-side ledger (off-chain) — delivered count and the matching on-chain txHashes',
      },
      ledger: {
        zh: '这是**卖方本机**的交付台账 (链下记录), 不是链上索引; 每笔对应一笔**已在链上核验过**的直付交易 (收据 status=1 · 日志里有 USDC Transfer→收款地址 · 金额≥报价 · ≥2 条独立 RPC 结论一致), 行内带 tx_hash 与块号。',
        en: 'This is the seller\'s own local delivery ledger (an off-chain record), not a chain index. Every row corresponds to a direct payment that already passed on-chain verification (receipt status=1, a USDC Transfer log to the pay-to address, amount >= the quote, and >=2 independent RPCs agreeing) and carries its tx_hash and block number.',
      },
      verifiable: {
        zh: '成交事实以链上为准: 用每笔的 tx_hash 与块号在区块浏览器上独立复核, 不必信本台账。',
        en: 'The on-chain record is the authority: take each row\'s tx_hash and block number to a block explorer and verify it yourself; you do not need to trust this ledger.',
      },
      not: {
        zh: '不是全网站点销量, 也不是合约托管/结算总量 (托管结算发生在链上合约, 不在这条口径内)。',
        en: 'Not a site-wide sales figure, and not the escrow contract\'s settlement total (escrow settlement lives on-chain in the contract and is out of this scope).',
      },
    },
    generated_at: new Date(now).toISOString(),
    totals: {
      chain_verified_sales: rows.length,
      delivered: queue.delivered,
      delivered_unverifiable: queue.deliveredUnverifiable,
      awaiting_signature: queue.awaiting,
      pending_total: queue.total,
    },
    delivered_tx_hashes: queue.deliveredTxHashes,
    txs: Object.fromEntries(rows.map((s) => [s.tx_hash, { itemId: s.item_id, amount: s.amount_atomic, settledAt: s.settled_at }])),
    total_atomic: revenueAtomic,
    revenue: {
      amount_atomic: revenueAtomic,
      amount_display: fmt(revenueAtomic, revenueCurrency),
      currency: revenueCurrency,
    },
    by_item: [...byItem.values()],
    latest: rows[0] || null,
    sales: rows,
    privacy_blocked: blocked,
  };

  // 最后一跳守卫 (belt & braces): 逐行与整对象过隐私审计。
  //   · 行级泄漏 ⇒ 剔除该行并计数 (绝不静默放行);
  //   · 顶层泄漏 (只可能是实现 bug) ⇒ **不对外给这个对象**, 退回空结果 + 如实计数,
  //     宁少报也不泄漏 (这条兜底在真数据上应当恒不触发 —— 单测会钉住)。
  const clean: SellerSummarySale[] = [];
  for (const s of summary.sales) {
    if (auditSellerSummaryLeaks(s, '$.sales[i]').length === 0) clean.push(s);
    else blocked += 1;
  }
  summary.sales = clean;
  summary.latest = clean[0] || null;
  summary.txs = Object.fromEntries(clean.map((s) => [s.tx_hash, { itemId: s.item_id, amount: s.amount_atomic, settledAt: s.settled_at }]));
  summary.totals.chain_verified_sales = clean.length;
  if (auditSellerSummaryLeaks(summary).length > 0) {
    summary.sales = [];
    summary.latest = null;
    summary.by_item = [];
    summary.delivered_tx_hashes = [];
    summary.txs = {};
    summary.total_atomic = '0';
    summary.totals.chain_verified_sales = 0;
    summary.revenue = { amount_atomic: '0', amount_display: fmt('0', revenueCurrency), currency: revenueCurrency };
  }
  summary.privacy_blocked = blocked;
  return summary;
}

/** HTTP 形状 (server.mjs 直接写回): 永远 200 + no-store; 读不到就空数组 + 0 */
export async function sellerSummaryResponse(home?: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let summary: SellerSummary;
  try {
    summary = await buildSellerSummary(home);
  } catch (e) {
    const empty: SellerSummary = {
      protocol: SELLER_SUMMARY_PROTOCOL,
      ok: false,
      scope: {
        title: { zh: '卖方本机台账 (链下) — 已交付笔数与对应链上 txHash', en: 'Seller-side ledger (off-chain) — delivered count and matching on-chain txHashes' },
        ledger: { zh: '卖方本机的交付台账 (链下记录), 不是链上索引; 每笔对应一笔经链上核验的直付交易。', en: 'The seller\'s local delivery ledger (an off-chain record), not a chain index; each row maps to an on-chain-verified direct payment.' },
        verifiable: { zh: '每笔可用 tx_hash 在区块浏览器独立复核。', en: 'Verify each row by tx_hash on a block explorer.' },
        not: { zh: '不是全网站点销量, 也不是合约托管结算总量。', en: 'Not a site-wide figure, not escrow settlement.' },
      },
      generated_at: new Date().toISOString(),
      totals: { chain_verified_sales: 0, delivered: 0, delivered_unverifiable: 0, awaiting_signature: 0, pending_total: 0 },
      delivered_tx_hashes: [],
      txs: {},
      total_atomic: '0',
      revenue: { amount_atomic: '0', amount_display: '0 USDC', currency: 'USDC' },
      by_item: [],
      latest: null,
      sales: [],
      privacy_blocked: 0,
    };
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Summary-Degraded': String(e && (e as Error).message || e).slice(0, 120) },
      body: JSON.stringify(empty, null, 2),
    };
  }
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(summary, null, 2),
  };
}
