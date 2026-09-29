/**
 * x402-seller-summary.test.ts — 公开只读汇总 (bolloon-x402-seller-summary/1) 的聚焦测试
 *
 * 这条链路最要紧的两句话:
 *   ① **每笔都来自链上核验过的台账** (receipt.status=1 + USDC Transfer→payTo + ≥2 RPC 一致,
 *      由 direct-payment.ts 落盘) ⇒ 汇总行必须带 tx_hash + 块号 + 浏览器链接, 可被第三方独立复核;
 *   ② **公开面不许带任何凭据/地址** —— 取件 token · 凭据原文/回执哈希 · 密钥/DID ·
 *      任何 EOA/合约地址(付款人 from / 收款人 to / 资产 asset / item 的 payTo) 一律不出。
 *
 * 全程 0 真网络 / 0 链上交易: 台账与队列都在临时 HOME 里用真文件写出来, 被测代码走真读盘路径。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SELLER_SUMMARY_PROTOCOL, SELLER_SUMMARY_PATH,
  buildSellerSummary, sellerSummaryResponse, auditSellerSummaryLeaks,
  DIRECT_TX_LEDGER_FILENAME, SELLER_PENDING_DIRNAME,
} from '../agents/x402/seller-summary.js';
import { fromAtomicAmount, toAtomicAmount } from '../agents/x402/paid-info-store.js';

const TXHASH = `0x${'8d06bc84'.padEnd(64, 'a')}`.slice(0, 66);
const TXHASH_OLD = `0x${'11'.repeat(32)}`;
const PAY_TO = '0xb4e9dCF79055A8232670ebb1c8c664Dff4E70066';
const PAYER = '0x6a3f797592bed028f6afd6da82339c8e815480eb';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ITEM = 'info_efficode_spec_pack';

let HOME = '';

function seedLedger(txs: Record<string, unknown>) {
  const dir = path.join(HOME, '.bolloon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, DIRECT_TX_LEDGER_FILENAME), JSON.stringify({ protocol: 'bolloon-x402-direct/1', txs }, null, 2));
}

function seedItem(itemId: string, currency = 'USDC', network = 'base') {
  const dir = path.join(HOME, '.bolloon', 'x402-info');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${itemId}.json`), JSON.stringify({ item: { id: itemId, price: { currency, network, payTo: PAY_TO, amount: '0.01' } } }));
}

function seedPending(name: string, rec: Record<string, unknown>) {
  const dir = path.join(HOME, '.bolloon', SELLER_PENDING_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rec, null, 2));
}

/** 一笔**链上已核验**的直付台账行 (字段与 direct-payment.ts 的 DirectTxRecord 同形) */
function ledgerRow(over: Record<string, unknown> = {}) {
  return {
    txHash: TXHASH, itemId: ITEM, network: 'base', chainId: 8453, asset: USDC,
    to: PAY_TO, from: PAYER, amount: '10000', blockNumber: 51901934, confirmations: 13,
    verifiedBy: ['mainnet.base.org', 'base.drpc.org'], settledAt: '2026-09-28T11:00:39.813Z',
    receiptHash: 'sha256:fb2c7becc20499bd42396e7292552af718bb0b7056dc34cc5122fc51234a98b0',
    ...over,
  };
}

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-summary-'));
});

describe('常量 (与 server.mjs / nginx 白名单对齐)', () => {
  it('协议名与路径固定', () => {
    expect(SELLER_SUMMARY_PROTOCOL).toBe('bolloon-x402-seller-summary/1');
    expect(SELLER_SUMMARY_PATH).toBe('/api/x402/seller/summary');
    // nginx 只放行 ^~ /api/x402/ ⇒ 路径必须长在它下面 (改了会被拦成 404)
    expect(SELLER_SUMMARY_PATH.startsWith('/api/x402/')).toBe(true);
  });
});

describe('金额折算 (纯整数, 与 402 的原子口径互逆)', () => {
  it('fromAtomicAmount 是 toAtomicAmount 的逆', () => {
    for (const [human, currency] of [['0.01', 'USDC'], ['1', 'USDC'], ['0.000001', 'USDC'], ['1', 'ETH']] as const) {
      const atomic = toAtomicAmount(human, currency);
      expect(fromAtomicAmount(atomic, currency)).toBe(human === '1' ? '1' : human);
    }
    expect(fromAtomicAmount('10000', 'USDC')).toBe('0.01');
    expect(fromAtomicAmount('0', 'USDC')).toBe('0');
    expect(fromAtomicAmount('不是数字', 'USDC')).toBe('不是数字');   // 不折算, 不编数
  });
});

describe('buildSellerSummary: 链上核验台账 → 公开聚合', () => {
  it('一笔已核验成交: 计数 / 按 item 汇总 / 最近一笔带 tx_hash + 块号 + basescan 链接', async () => {
    seedLedger({ [TXHASH]: ledgerRow() });
    seedItem(ITEM);
    seedPending('pnd_x', { pendingId: 'pnd_x', status: 'signed', itemId: ITEM, createdAt: '2026-09-28T11:00:39.817Z', expiresAt: '2026-10-05T11:00:39.817Z', payment: { txHash: TXHASH } });

    const s = await buildSellerSummary(HOME);
    expect(s.protocol).toBe(SELLER_SUMMARY_PROTOCOL);
    expect(s.ok).toBe(true);
    expect(s.totals.chain_verified_sales).toBe(1);
    expect(s.totals.delivered).toBe(1);
    expect(s.totals.awaiting_signature).toBe(0);
    expect(s.totals.pending_total).toBe(1);
    expect(s.revenue.amount_atomic).toBe('10000');
    expect(s.revenue.amount_display).toBe('0.01 USDC');
    expect(s.by_item).toHaveLength(1);
    expect(s.by_item[0]).toMatchObject({ item_id: ITEM, sales: 1, amount_atomic: '10000', currency: 'USDC', network: 'base' });
    expect(s.latest).toMatchObject({
      item_id: ITEM, amount_atomic: '10000', amount_display: '0.01 USDC',
      network: 'base', chain_id: 8453, block_number: 51901934, tx_hash: TXHASH,
      explorer_tx: `https://basescan.org/tx/${TXHASH}`,
    });
    expect(s.sales).toHaveLength(1);
    expect(s.delivered_tx_hashes).toEqual([TXHASH]);   // 已交付笔数 → 对应链上 txHash 列表
    // 自述: 必须写明「卖方本机台账(链下)」且每笔对应**链上可核验**的交易;
    // 不许拿"本机观察"当**成交来源** (成交事实以链上为准)
    const scopeText = JSON.stringify(s.scope);
    expect(scopeText).toMatch(/链下|off-chain/i);
    expect(scopeText).toMatch(/本机|seller's own|seller-side/i);
    expect(scopeText).toMatch(/链上核验|on-chain verification/i);
    expect(scopeText).not.toMatch(/本机观察|本节点观察|locally observed/i);
  });

  it('已交付笔数 → txHash 列表: 没有可核验哈希的交付如实计数, 不编一个哈希', async () => {
    seedLedger({ [TXHASH]: ledgerRow() });
    seedPending('pnd_ok', { pendingId: 'pnd_ok', status: 'signed', itemId: ITEM, expiresAt: '2030-01-01T00:00:00.000Z', payment: { txHash: TXHASH } });
    seedPending('pnd_no_tx', { pendingId: 'pnd_no_tx', status: 'signed', itemId: ITEM, expiresAt: '2030-01-01T00:00:00.000Z', payment: {} });
    const s = await buildSellerSummary(HOME);
    expect(s.totals.delivered).toBe(2);
    expect(s.totals.delivered_unverifiable).toBe(1);
    expect(s.delivered_tx_hashes).toEqual([TXHASH]);   // 只有真有的那个, 没有就空着
    expect(JSON.stringify(s)).not.toContain('undefined');
  });

  it('多笔按时间倒序 + 按 item 分组求和 (原子串相加, 无浮点)', async () => {
    seedLedger({
      [TXHASH]: ledgerRow(),
      [TXHASH_OLD]: ledgerRow({ txHash: TXHASH_OLD, amount: '20000', settledAt: '2026-09-01T00:00:00.000Z', blockNumber: 51_000_000, itemId: 'info_other' }),
    });
    seedItem(ITEM);
    seedItem('info_other');
    const s = await buildSellerSummary(HOME);
    expect(s.totals.chain_verified_sales).toBe(2);
    expect(s.revenue.amount_atomic).toBe('30000');
    expect(s.revenue.amount_display).toBe('0.03 USDC');
    expect(s.by_item.map((x) => [x.item_id, x.amount_atomic]).sort()).toEqual([['info_efficode_spec_pack', '10000'], ['info_other', '20000']]);
    expect(s.sales[0].tx_hash).toBe(TXHASH);          // 新的在前
    expect(s.latest?.tx_hash).toBe(TXHASH);
  });

  it('读不到任何源 → 空数组 + 0, 且仍 ok (不是 500)', async () => {
    const s = await buildSellerSummary(HOME);   // 临时 HOME 里什么都没有
    expect(s.ok).toBe(true);
    expect(s.totals).toEqual({ chain_verified_sales: 0, delivered: 0, delivered_unverifiable: 0, awaiting_signature: 0, pending_total: 0 });
    expect(s.delivered_tx_hashes).toEqual([]);
    expect(s.sales).toEqual([]);
    expect(s.latest).toBeNull();
    expect(s.by_item).toEqual([]);
    expect(s.revenue.amount_atomic).toBe('0');

    const http = await sellerSummaryResponse(HOME);
    expect(http.status).toBe(200);
    expect(JSON.parse(http.body).sales).toEqual([]);
  });

  it('坏文件 / 形状不对的台账行不炸也不进公开面', async () => {
    seedLedger({
      [TXHASH]: ledgerRow(),
      bad: { txHash: 'not-a-txhash', itemId: ITEM } as unknown as never,
    });
    fs.writeFileSync(path.join(HOME, '.bolloon', DIRECT_TX_LEDGER_FILENAME + '.junk'), '{ 这不是 JSON');
    seedPending('pnd_broken', { notAPending: true });
    const s = await buildSellerSummary(HOME);
    expect(s.totals.chain_verified_sales).toBe(1);
    expect(s.privacy_blocked).toBe(1);          // 形状不对的那行被挡在外面, 如实计数
    expect(s.totals.pending_total).toBe(0);     // 坏待办文件不算待办
  });

  it('待签名 vs 已交付分开数 (过期的待签名不冒充可交付)', async () => {
    seedLedger({});
    seedPending('pnd_a', { pendingId: 'pnd_a', status: 'awaiting_signature', itemId: ITEM, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    seedPending('pnd_b', { pendingId: 'pnd_b', status: 'awaiting_signature', itemId: ITEM, expiresAt: new Date(Date.now() - 86400000).toISOString() });
    seedPending('pnd_c', { pendingId: 'pnd_c', status: 'signed', itemId: ITEM, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const s = await buildSellerSummary(HOME);
    expect(s.totals.pending_total).toBe(3);
    expect(s.totals.awaiting_signature).toBe(1);   // 过期那条不算
    expect(s.totals.delivered).toBe(1);
  });
});

describe('隐私红线: 公开面不许出现凭据 / 地址', () => {
  it('真数据形状下: 序列化结果无 EOA 地址 / 凭据 / 取件 token / 密钥键', async () => {
    seedLedger({ [TXHASH]: ledgerRow() });
    seedItem(ITEM);
    // 队列里放一个"该有的敏感内容": 凭据原文 + 付款人地址 + 取件 token 形态的 id
    seedPending('pnd_6396ee5824eaa79f', {
      pendingId: 'pnd_6396ee5824eaa79f', status: 'signed', itemId: ITEM,
      payment: { mode: 'direct', receipt: 'eyJwcm...SECRET-RECEIPT', receiptHash: 'sha256:fb2c7bec', txHash: TXHASH, payer: PAYER, network: 'base', amount: '0.01', currency: 'USDC', settledAt: '2026-09-28T11:00:39.817Z' },
      providerDid: 'did:key:z6MkjpvG9Zu3DSYpE72LCApMVKYkZa4WMNGyPRBVc8acn83g',
      expiresAt: '2026-10-05T11:00:39.817Z',
    });
    const s = await buildSellerSummary(HOME);
    const body = JSON.stringify(s);
    expect(s.privacy_blocked).toBe(0);
    expect(auditSellerSummaryLeaks(s)).toEqual([]);
    expect(body).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);   // 无任何 EOA/合约地址 (与 64 位哈希区分)
    expect(body).not.toContain(PAY_TO);
    expect(body).not.toContain(PAYER);
    expect(body).not.toContain(USDC);
    expect(body).not.toContain('SECRET-RECEIPT');
    expect(body).not.toContain('pnd_6396ee5824eaa79f');   // 取件 token 形态的 id 不出
    // 键名层面: 不许出现凭据/地址/密钥类键 (值里的口径说明文字可以提 "receipt status=1")
    const FORBIDDEN_KEYS = new Set(['receipt', 'receiptHash', 'payer', 'payTo', 'pay_to', 'privateKey', 'secret', 'signature', 'wallet', 'address', 'from', 'to', 'asset', 'providerDid', 'pendingId', 'envelopeHash']);
    const keys: string[] = [];
    const walk = (o: any) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) { keys.push(k); walk(v); }
    };
    walk(s);
    expect(keys.filter((k) => FORBIDDEN_KEYS.has(k) || /^did:/.test(k))).toEqual([]);
    expect(body).toContain(TXHASH);                       // 但 tx_hash 必须给 (公开链上事实)
    expect(body).toContain('basescan.org/tx/');
  });

  it('审计器能抓到注入的泄漏 (变异验证: 不红就是空门)', () => {
    const leaky = {
      protocol: SELLER_SUMMARY_PROTOCOL,
      sales: [{ item_id: ITEM, tx_hash: TXHASH, payer: PAYER }],              // 键名泄漏
      latest: { to: PAY_TO, tx_hash: TXHASH },                                // 地址键
      by_item: [{ item_id: ITEM, note: `收款到 ${PAY_TO}` }],                  // 值里塞地址
      extra: `hash=${TXHASH}`,                                                // 非白名单键下的裸哈希
      explorer_tx: `https://basescan.org/address/${PAY_TO}`,                   // 假的浏览器链接形状
      delivered_tx_hashes: [TXHASH, PAYER],                                    // 列表里混进地址 → 必须拦
    };
    const issues = auditSellerSummaryLeaks(leaky);
    expect(issues.length).toBeGreaterThanOrEqual(6);
    expect(issues.join('\n')).toMatch(/payer/);
    expect(issues.join('\n')).toMatch(/0x\+40/);
    expect(issues.join('\n')).toMatch(/explorer_tx/);
    expect(issues.join('\n')).toMatch(/delivered_tx_hashes/);
  });

  it('未知链 (无浏览器) → 不给 explorer_tx, 也不编死链', async () => {
    seedLedger({ [TXHASH]: ledgerRow({ chainId: 31337, network: 'localhost' }) });
    const s = await buildSellerSummary(HOME);
    expect(s.sales[0].tx_hash).toBe(TXHASH);
    expect('explorer_tx' in s.sales[0]).toBe(false);
    expect(JSON.stringify(s)).not.toContain('localhost/tx/');
  });
});

/**
 * 消费方互操作 (统一索引区): 那边按 `body.txs` 建 txHash 索引, 用来判定
 * 「链上扫到的收款里, 哪些经 x402 流程」。形状一旦漂, 那边会静默变成"口径未知",
 * 所以这里**照抄它认字段的规则** (txHash/tx_hash + itemId/amount/settledAt)，钉住契约。
 */
describe('互操作: txs 映射 (给统一索引区做交叉核)', () => {
  it('txs 是 {txHash: {itemId, amount, settledAt}} 映射, 且 total_atomic 可读', async () => {
    seedLedger({ [TXHASH]: ledgerRow() });
    seedItem(ITEM);
    const s = await buildSellerSummary(HOME);
    expect(Object.keys(s.txs)).toEqual([TXHASH]);
    expect(s.txs[TXHASH]).toEqual({ itemId: ITEM, amount: '10000', settledAt: '2026-09-28T11:00:39.813Z' });
    expect(s.total_atomic).toBe('10000');
    // 照消费方的抽取规则跑一遍 (对象映射分支: key 当 txHash, 值里读 camelCase)
    const recognized = Object.entries(s.txs).filter(([k, v]) =>
      /^0x[0-9a-f]{64}$/.test(k.toLowerCase()) && typeof (v as any).itemId === 'string');
    expect(recognized).toHaveLength(1);
  });

  it('txs 行里塞第四个字段 / 键不是哈希 → 审计判红 (变异验证)', () => {
    expect(auditSellerSummaryLeaks({ txs: { [TXHASH]: { itemId: ITEM, amount: '1', settledAt: 'x', payer: PAYER } } }).join('\n'))
      .toMatch(/字段不在白名单/);
    expect(auditSellerSummaryLeaks({ txs: { [PAY_TO]: { itemId: ITEM, amount: '1', settledAt: 'x' } } }).join('\n'))
      .toMatch(/键必须是 0x\+64/);
  });
});
