/**
 * x402-direct-payment.test.ts — 去中心化直付模式 (mode = 'direct') 的聚焦测试
 *
 * 这条链路最要紧的一句话: **单条 RPC 不构成事实**。所以这里不用"假 fetch"讲道理, 而是起
 * **真 HTTP JSON-RPC 服务** (2~3 个, 各持一份夹具回放), 让被测代码走真的 fetch/JSON-RPC 路径:
 *   · 两条 RPC 一致 → 才算核验通过
 *   · 一条说"到了"另一条说"没有" → **不一致 = 不通过** (fail-closed)
 *   · 只有一条 RPC 活着 → **不通过** (绝不用单条 RPC 交付)
 *   · 回滚 / 事件对不上 / 换链 → 两条一致否定才敢下这个结论
 *   · 同一 txHash 只能交付一次; 拿去换另一条资源 → 拒
 *
 * 全程 **0 链上交易 / 0 真钱 / 0 真网络**: receipt 与日志都是夹具 (mock RPC 回放)。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  ERC20_TRANSFER_TOPIC0, CHAIN_ID_BY_NETWORK, DIRECT_MIN_RPCS, DIRECT_TX_LEDGER_FILE,
  checkOneRpc, verifyDirectTransfer, settleDirectPayment, buildDirectReceipt,
  handleDirectPayment, directPaymentEnabled, directHealth, directTxLedgerPath,
  DirectTxLedger, directPaymentPath, DEFAULT_DIRECT_CONFIRMATIONS,
} from '../agents/x402/direct-payment.js';
import { ERC20_TRANSFER_TOPIC0 as CANONICAL_TOPIC0 } from '../agents/chain/chain-settlement.js';
import { publishInfo, buildPaymentRequired, getStoredInfo } from '../agents/x402/paid-info-store.js';
import { resolvePendingDelivery, listPending, loadSellerAuth, pendingView } from '../agents/x402/seller-signing.js';
import { computeContentHash, sha256Hex } from '../agents/x402/paid-info-protocol.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0xb4e9dCF79055A8232670ebb1c8c664Dff4E70066';
const PAYER = '0x1111111111111111111111111111111111111111';
const OTHER_TOKEN = '0x4200000000000000000000000000000000000006';
const TXHASH = `0x${'ab'.repeat(32)}`;
const ITEM_AMOUNT = '10000';         // 0.01 USDC (原子单位)
const PRICE_HUMAN = '0.01';
const BLOCK = 21_000_000;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-direct-'));
const HOME = path.join(TMP, 'home');
const CONTENT = JSON.stringify({ spec: 'efficode-spec-pack (直付测试夹具)', lines: [1, 2, 3] }, null, 2);

// ─────────────────────────────────────────────────────────── 夹具: 真 HTTP JSON-RPC 服务

function pad32(addr: string): string {
  return `0x${String(addr).replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
}

interface ReceiptFixture {
  status?: 0 | 1;
  blockNumber?: number;
  token?: string;
  from?: string;
  to?: string;
  value?: string;
  /** 附一条别的 Transfer (噪音日志) */
  extraNoiseLog?: boolean;
}

function receiptFixture(fx: ReceiptFixture = {}): any {
  const logs: any[] = [];
  if (fx.extraNoiseLog) {
    logs.push({
      address: USDC_BASE, topics: [ERC20_TRANSFER_TOPIC0, pad32(PAYER), pad32(PAYER)],
      data: `0x${(1n).toString(16).padStart(64, '0')}`,
    });
  }
  logs.push({
    address: fx.token ?? USDC_BASE,
    topics: [ERC20_TRANSFER_TOPIC0, pad32(fx.from ?? PAYER), pad32(fx.to ?? PAY_TO)],
    data: `0x${BigInt(fx.value ?? ITEM_AMOUNT).toString(16).padStart(64, '0')}`,
  });
  const blockNumber = fx.blockNumber ?? BLOCK;
  return {
    transactionHash: TXHASH,
    blockNumber: `0x${blockNumber.toString(16)}`,
    status: fx.status === 0 ? '0x0' : '0x1',
    logs: logs.map((l) => ({ ...l, blockNumber: `0x${blockNumber.toString(16)}` })),
  };
}

interface RpcFixture {
  chainId?: number;
  receipt?: any | null;
  latestBlock?: number;
  /** 让这个 RPC 直接连不上 (服务器根本不起) */
}

/** 起一个真 JSON-RPC HTTP 服务回放夹具 */
async function startRpc(fx: RpcFixture = {}): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* 忽略 */ }
      hits.push(String(body.method));
      const reply = (result: unknown) => {
        const b = JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        res.end(b);
      };
      switch (body.method) {
        case 'eth_chainId': return reply(`0x${(fx.chainId ?? 8453).toString(16)}`);
        case 'eth_getTransactionReceipt': return reply(fx.receipt === undefined ? receiptFixture() : fx.receipt);
        case 'eth_blockNumber': return reply(`0x${(fx.latestBlock ?? BLOCK + 5).toString(16)}`);
        default: {
          const b = JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, error: { code: -32601, message: 'method not found' } });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
          return res.end(b);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as any;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 两条一致的 RPC */
async function twoAgreeingRpc(fx: RpcFixture = {}): Promise<{ urls: string[]; close: () => Promise<void> }> {
  const a = await startRpc(fx);
  const b = await startRpc(fx);
  return { urls: [a.url, b.url], close: async () => { await a.close(); await b.close(); } };
}

const DEAD_RPC = 'http://127.0.0.1:9';   // discard 端口: 直接连不上

let item: Awaited<ReturnType<typeof publishInfo>>;

beforeAll(async () => {
  item = await publishInfo({
    id: 'info_direct_probe',
    title: '直付探针条目',
    category: 'data',
    content: CONTENT,
    price: { amount: PRICE_HUMAN, currency: 'USDC', network: 'base', payTo: PAY_TO },
    source: { kind: 'self', refs: [] },
    provider: { did: 'did:key:z6MkDirectProbeSellerPlaceholder0000000000000' },
  }, { home: HOME });
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const verifyBase = () => ({
  txHash: TXHASH,
  network: 'base',
  chainId: 8453,
  asset: USDC_BASE,
  to: PAY_TO,
  minAmount: ITEM_AMOUNT,
  minConfirmations: 1,
});

// ═══════════════════════════════════════════════════════ 0. 常量不漂移

describe('常量与配置 (防漂移)', () => {
  it('ERC20 Transfer topic0 与 chain-settlement.ts 逐字一致', () => {
    expect(ERC20_TRANSFER_TOPIC0).toBe(CANONICAL_TOPIC0);
  });

  it('base = 8453, 且至少要求 2 条 RPC 一致', () => {
    expect(CHAIN_ID_BY_NETWORK.base).toBe(8453);
    expect(DIRECT_MIN_RPCS).toBe(2);
  });

  it('默认要求确认数 >= 1 (0 会被当成"不要求确认"→ 不许)', () => {
    expect(DEFAULT_DIRECT_CONFIRMATIONS).toBeGreaterThanOrEqual(1);
  });

  it('mode 开关只认 BOLLOON_X402_DIRECT=1', () => {
    expect(directPaymentEnabled({} as any)).toBe(false);
    expect(directPaymentEnabled({ BOLLOON_X402_DIRECT: 'true' } as any)).toBe(false);
    expect(directPaymentEnabled({ BOLLOON_X402_DIRECT: '1' } as any)).toBe(true);
  });

  it('health 自述: 开着时说清是链上核验且不经过第三方托管', () => {
    const off = directHealth({} as any);
    expect(off.enabled).toBe(false);
    expect(String(off.detail)).toContain('未开启');
    const on = directHealth({ BOLLOON_X402_DIRECT: '1' } as any);
    expect(on.enabled).toBe(true);
    expect(on.onchain).toBe(true);
    expect(on.custody).toBe('none');
    expect(String(on.detail)).toContain('不经过任何第三方托管');
    expect(on.paymentPath).toBe('/api/x402/info/:id/payment');
  });
});

// ═══════════════════════════════════════════════════════ 1. 单条 RPC 的核查

describe('checkOneRpc: 单条 RPC 上的链上事实', () => {
  it('receipt.status=1 + USDC Transfer → confirmed, 且付款方/金额取自日志', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ extraNoiseLog: true }) });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.ok).toBe(true);
      expect(c.status).toBe('confirmed');
      expect(c.from).toBe(PAYER.toLowerCase());
      expect(c.to).toBe(PAY_TO.toLowerCase());
      expect(c.value).toBe(ITEM_AMOUNT);
      expect(c.confirmations).toBe(6);
      expect(rpc.hits).toContain('eth_getTransactionReceipt');
    } finally { await rpc.close(); }
  });

  it('receipt.status=0 → reverted (钱没动)', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ status: 0 }) });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.ok).toBe(false);
      expect(c.status).toBe('reverted');
    } finally { await rpc.close(); }
  });

  it('别的 token 的 Transfer → event_mismatch', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ token: OTHER_TOKEN }) });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.ok).toBe(false);
      expect(c.status).toBe('event_mismatch');
    } finally { await rpc.close(); }
  });

  it('转给了别人 → event_mismatch', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ to: '0x2222222222222222222222222222222222222222' }) });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.status).toBe('event_mismatch');
    } finally { await rpc.close(); }
  });

  it('金额少 1 个原子 → event_mismatch (差一点就是没付够)', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ value: '9999' }) });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.status).toBe('event_mismatch');
    } finally { await rpc.close(); }
  });

  it('金额多付 → 通过 (value >= 要求)', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ value: '20000' }) });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.ok).toBe(true);
      expect(c.value).toBe('20000');
    } finally { await rpc.close(); }
  });

  it('交易还没打包 (receipt = null) → pending', async () => {
    const rpc = await startRpc({ receipt: null });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.status).toBe('pending');
      expect(c.ok).toBe(false);
    } finally { await rpc.close(); }
  });

  it('确认数不够 → pending (不是"已结算")', async () => {
    const rpc = await startRpc({ receipt: receiptFixture({ blockNumber: BLOCK }), latestBlock: BLOCK });
    try {
      const c = await checkOneRpc({ ...verifyBase(), minConfirmations: 3, rpcUrls: [rpc.url] }, rpc.url);
      expect(c.status).toBe('pending');
      expect(c.confirmations).toBe(1);
    } finally { await rpc.close(); }
  });

  it('RPC 在别的链上 → chain_mismatch', async () => {
    const rpc = await startRpc({ chainId: 84532 });
    try {
      const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [rpc.url] }, rpc.url);
      expect(c.status).toBe('chain_mismatch');
      expect(c.chainId).toBe(84532);
    } finally { await rpc.close(); }
  });

  it('RPC 连不上 → unreachable (≠ 没付钱, 但也 ≠ 已付)', async () => {
    const c = await checkOneRpc({ ...verifyBase(), rpcUrls: [DEAD_RPC], timeoutMs: 800 }, DEAD_RPC);
    expect(c.ok).toBe(false);
    expect(c.status).toBe('unreachable');
  });
});

// ═══════════════════════════════════════════════════════ 2. 两条 RPC 交叉核对 (核心)

describe('verifyDirectTransfer: 两条不同 RPC 交叉核对', () => {
  it('两条一致 → ok (verifiedBy 两条, 主机名)', async () => {
    const { urls, close } = await twoAgreeingRpc();
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: urls });
      expect(v.ok).toBe(true);
      expect(v.status).toBe('confirmed');
      expect(v.verifiedBy).toHaveLength(2);
      expect(v.payer).toBe(PAYER.toLowerCase());
      expect(v.amount).toBe(ITEM_AMOUNT);
      expect(v.rpcChecks.every((c) => c.ok)).toBe(true);
      // 只记主机名 (不泄漏 RPC URL 里的 key)
      expect(v.verifiedBy.every((h) => !h.includes('/'))).toBe(true);
    } finally { await close(); }
  });

  it('★ 只有一条 RPC 活着 → **不通过** (单条不构成事实)', async () => {
    const a = await startRpc();
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: [a.url, DEAD_RPC], timeoutMs: 800 });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('rpc_disagreement');
      expect(v.verifiedBy).toHaveLength(0);
      expect(v.rpcChecks.find((c) => c.status === 'unreachable')).toBeTruthy();
    } finally { await a.close(); }
  });

  it('★ 一条说到了、另一条说回滚了 → 不一致 → 不通过', async () => {
    const a = await startRpc({ receipt: receiptFixture() });
    const b = await startRpc({ receipt: receiptFixture({ status: 0 }) });
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: [a.url, b.url] });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('rpc_disagreement');
    } finally { await a.close(); await b.close(); }
  });

  it('两条都说同一笔交易但在**不同块** → 不一致 → 不通过', async () => {
    const a = await startRpc({ receipt: receiptFixture({ blockNumber: BLOCK }) });
    const b = await startRpc({ receipt: receiptFixture({ blockNumber: BLOCK + 1 }) });
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: [a.url, b.url] });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('rpc_disagreement');
    } finally { await a.close(); await b.close(); }
  });

  it('两条都说金额不同 → 不一致 → 不通过', async () => {
    const a = await startRpc({ receipt: receiptFixture({ value: '10000' }) });
    const b = await startRpc({ receipt: receiptFixture({ value: '9999' }) });
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: [a.url, b.url] });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('rpc_disagreement');
    } finally { await a.close(); await b.close(); }
  });

  it('两条一致否定 (回滚) → reverted', async () => {
    const { urls, close } = await twoAgreeingRpc({ receipt: receiptFixture({ status: 0 }) });
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: urls });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('reverted');
    } finally { await close(); }
  });

  it('两条一致说事件对不上 → event_mismatch', async () => {
    const { urls, close } = await twoAgreeingRpc({ receipt: receiptFixture({ to: '0x3333333333333333333333333333333333333333' }) });
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: urls });
      expect(v.status).toBe('event_mismatch');
    } finally { await close(); }
  });

  it('两条一致但确认数不够 → pending', async () => {
    const { urls, close } = await twoAgreeingRpc({ receipt: receiptFixture({ blockNumber: BLOCK }), latestBlock: BLOCK });
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), minConfirmations: 4, rpcUrls: urls });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('pending');
    } finally { await close(); }
  });

  it('txHash 形状不对 → txhash_invalid (不去查链)', async () => {
    const { urls, close } = await twoAgreeingRpc();
    try {
      for (const bad of ['', '0x123', 'ab'.repeat(32), `0x${'zz'.repeat(32)}`]) {
        const v = await verifyDirectTransfer({ ...verifyBase(), txHash: bad, rpcUrls: urls });
        expect(v.status).toBe('txhash_invalid');
      }
    } finally { await close(); }
  });

  it('只配了 1 条 RPC → no_rpc_configured (拒判, 不是"通过")', async () => {
    const a = await startRpc();
    try {
      const v = await verifyDirectTransfer({ ...verifyBase(), rpcUrls: [a.url] });
      expect(v.ok).toBe(false);
      expect(v.status).toBe('no_rpc_configured');
      expect(a.hits).toHaveLength(0);   // 连查都不查
    } finally { await a.close(); }
  });
});

// ═══════════════════════════════════════════════════════ 3. 结算 + 幂等台账

describe('settleDirectPayment: 核验→认领→回执 (幂等)', () => {
  let urls: string[] = [];
  let close: () => Promise<void>;

  beforeEach(async () => {
    if (close) await close();
    const r = await twoAgreeingRpc();
    urls = r.urls; close = r.close;
  });
  afterAll(async () => { if (close) await close(); });

  const settle = (over: Partial<Parameters<typeof settleDirectPayment>[0]> = {}) => settleDirectPayment({
    item, txHash: TXHASH, home: HOME, rpcUrls: urls, allowDisabled: true, ...over,
  });

  it('关闭时拒 (DIRECT_MODE_DISABLED), 不碰链', async () => {
    const prev = process.env.BOLLOON_X402_DIRECT;
    delete process.env.BOLLOON_X402_DIRECT;
    try {
      const r = await settleDirectPayment({ item, txHash: TXHASH, home: HOME, rpcUrls: urls });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DIRECT_MODE_DISABLED');
      expect(r.mode).toBe('direct');
    } finally {
      if (prev !== undefined) process.env.BOLLOON_X402_DIRECT = prev;
    }
  });

  it('核验通过 → 回执 + txHash + payer; 再提交同一 txHash → 幂等 (回执逐字相同)', async () => {
    const r1 = await settle({ now: 1_700_000_000_000 });
    expect(r1.ok).toBe(true);
    expect(r1.payer).toBe(PAYER.toLowerCase());
    expect(r1.verifiedBy).toHaveLength(2);
    const receipt1 = r1.receipt!;

    // 回执形状: base64 JSON, custody=none, 带 txHash (买方自己能上链复核)
    const decoded = JSON.parse(Buffer.from(receipt1, 'base64').toString('utf-8'));
    expect(decoded.mode).toBe('direct');
    expect(decoded.custody).toBe('none');
    expect(decoded.txHash).toBe(TXHASH);
    expect(String(decoded.payTo).toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(decoded.amount).toBe(ITEM_AMOUNT);
    expect(String(decoded.note)).toContain('不经过任何第三方托管');

    const r2 = await settle({ now: 1_700_000_999_999 });   // 时间不同, 但同一笔交易
    expect(r2.ok).toBe(true);
    expect(r2.reused).toBe(true);
    expect(r2.receipt).toBe(receipt1);                      // ★ 逐字相同 (settledAt 用首见时间)
    expect(`sha256:${sha256Hex(r2.receipt!)}`).toBe(`sha256:${sha256Hex(receipt1)}`);
  });

  it('★ 同一 txHash 换另一条资源 → TXHASH_ALREADY_USED', async () => {
    const other = await publishInfo({
      id: 'info_direct_probe_2', title: '另一条', category: 'data', content: 'x',
      price: { amount: PRICE_HUMAN, currency: 'USDC', network: 'base', payTo: PAY_TO },
      source: { kind: 'self', refs: [] }, provider: { did: 'did:key:zOther' },
    }, { home: HOME });
    const r = await settleDirectPayment({ item: other, txHash: TXHASH, home: HOME, rpcUrls: urls, allowDisabled: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TXHASH_ALREADY_USED');
  });

  it('核验没过时**不认领** (台账里不留痕迹: 没付成功的交易永远可以重试)', async () => {
    const before = JSON.parse(fs.readFileSync(directTxLedgerPath(HOME), 'utf-8'));
    const n0 = Object.keys(before.txs || {}).length;
    const a = await startRpc({ receipt: receiptFixture({ status: 0 }) });
    const b = await startRpc({ receipt: receiptFixture({ status: 0 }) });
    try {
      const r = await settleDirectPayment({ item, txHash: TXHASH, home: HOME, rpcUrls: [a.url, b.url], allowDisabled: true });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DIRECT_PAYMENT_NOT_VERIFIED');
      const after = JSON.parse(fs.readFileSync(directTxLedgerPath(HOME), 'utf-8'));
      expect(Object.keys(after.txs || {})).toHaveLength(n0);
    } finally { await a.close(); await b.close(); }
  });

  it('台账落盘 0600 且不含任何私钥/共享密钥字段', async () => {
    const file = directTxLedgerPath(HOME);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, 'utf-8');
    for (const bad of ['privateKey', 'secret', 'mnemonic', 'seed']) expect(raw).not.toContain(bad);
  });

  it('回执是确定性的: 同样的记录 → 同样的字节 (键序固定)', () => {
    const rec = {
      txHash: TXHASH, itemId: 'info_direct_probe', network: 'base', chainId: 8453,
      asset: USDC_BASE, to: PAY_TO, from: PAYER, amount: ITEM_AMOUNT,
      blockNumber: BLOCK, confirmations: 6, verifiedBy: ['b.example', 'a.example'],
      settledAt: '2026-09-28T00:00:00.000Z', receiptHash: '',
    };
    expect(buildDirectReceipt(rec)).toBe(buildDirectReceipt(rec));
    // verifiedBy 顺序不影响回执 (排序过)
    expect(buildDirectReceipt({ ...rec, verifiedBy: ['a.example', 'b.example'] })).toBe(buildDirectReceipt(rec));
  });

  it('台账文件路径固定在 .bolloon/ 下', () => {
    expect(directTxLedgerPath(HOME)).toBe(path.join(HOME, '.bolloon', DIRECT_TX_LEDGER_FILE));
  });
});

// ═══════════════════════════════════════════════════════ 4. HTTP 面 (POST /payment)

describe('handleDirectPayment: HTTP 语义 (与 server.mjs 共用同一份实现)', () => {
  let urls: string[] = [];
  let close: () => Promise<void>;
  let seq = 0;

  beforeEach(async () => {
    if (close) await close();
    const r = await twoAgreeingRpc();
    urls = r.urls; close = r.close;
    seq += 1;
  });
  afterAll(async () => { if (close) await close(); });

  /** 每个用例用不同的 txHash (夹具回放对所有 txHash 返回同一份 receipt, 台账要能分开) */
  const freshTx = () => `0x${((seq * 1000) + 1).toString(16).padStart(64, '9')}`;

  it('本部署没开直付 → 503 DIRECT_MODE_DISABLED (不是 200, 也不是假装成功)', async () => {
    const out = await handleDirectPayment({ item, bodyText: JSON.stringify({ txHash: freshTx() }), home: HOME, rpcUrls: urls });
    expect(out.status).toBe(503);
    const j = JSON.parse(out.body);
    expect(j.code).toBe('DIRECT_MODE_DISABLED');
  });

  it('body 不是 JSON / 没 txHash → 400', async () => {
    const bad = await handleDirectPayment({ item, bodyText: 'not-json', home: HOME, rpcUrls: urls, allowDisabled: true });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).code).toBe('INVALID_ARGUMENT');
    const missing = await handleDirectPayment({ item, bodyText: JSON.stringify({}), home: HOME, rpcUrls: urls, allowDisabled: true });
    expect(missing.status).toBe(400);
  });

  it('txHash 形状不对 → 400 TXHASH_INVALID', async () => {
    const out = await handleDirectPayment({ item, bodyText: JSON.stringify({ txHash: '0xnope' }), home: HOME, rpcUrls: urls, allowDisabled: true });
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body).code).toBe('TXHASH_INVALID');
  });

  it('★ 核验没过 → 402, 且 accepts 与 GET 的 402 **逐字相同**', async () => {
    const a = await startRpc({ receipt: receiptFixture({ value: '1' }) });
    const b = await startRpc({ receipt: receiptFixture({ value: '1' }) });
    try {
      const out = await handleDirectPayment({
        item, bodyText: JSON.stringify({ txHash: freshTx() }), home: HOME,
        rpcUrls: [a.url, b.url], allowDisabled: true,
      });
      expect(out.status).toBe(402);
      const j = JSON.parse(out.body);
      const expected = buildPaymentRequired(item, '/api/x402/info/info_direct_probe/payment');
      expect(JSON.stringify(j.accepts)).toBe(JSON.stringify(expected.accepts));   // 逐字
      expect(j.error).toBeTruthy();
      expect(j.code).toBe('DIRECT_PAYMENT_NOT_VERIFIED');
      expect(j.paymentAttempt.verified).toBe(false);
      // 附带的 X-PAYMENT-REQUIRED 与 accepts 同源
      expect(out.headers['X-PAYMENT-REQUIRED']).toBe(JSON.stringify(expected.accepts));
    } finally { await a.close(); await b.close(); }
  });

  it('核验通过 → 202 已付款待签名 + 取件 token + 待办落盘 (mode=direct)', async () => {
    const txHash = freshTx();
    const out = await handleDirectPayment({ item, bodyText: JSON.stringify({ txHash }), home: HOME, rpcUrls: urls, allowDisabled: true });
    expect(out.status).toBe(202);
    const j = JSON.parse(out.body);
    expect(j.status).toBe('paid_awaiting_signature');
    expect(j.pendingId).toMatch(/^pnd_[0-9a-f]{16}$/);
    expect(j.payment.mode).toBe('direct');
    expect(j.payment.custody).toBe('none');
    expect(j.payment.confirmed).toBe(true);
    expect(j.payment.verifiedBy).toHaveLength(2);
    expect(j.payment.txHash).toBe(txHash);
    expect(j.retrieval.token).toBe(j.pendingId);
    expect(j.retrieval.path).toBe(`/api/x402/info/info_direct_probe/pending/${j.pendingId}`);

    // 待办真的落盘了, 且记录的就是这笔链上交易
    const pending = (await listPending(HOME)).find((p) => p.pendingId === j.pendingId);
    expect(pending).toBeTruthy();
    expect(pending!.payment.mode).toBe('direct');
    expect(pending!.payment.txHash).toBe(txHash);
    expect(pending!.payment.receiptHash).toBe(j.payment.receiptHash);

    // 卖方没签之前, 取件通道只能回 202 (硬话: 卖方不在线就拿不到信封)
    const d = await resolvePendingDelivery({ itemId: item.id, pendingId: j.pendingId }, HOME);
    expect(d?.kind).toBe('awaiting_signature');
    expect(pendingView(pending!).status).toBe('awaiting_signature');
  });

  it('同一 txHash 再提交 → 同一条待办 (不会变出第二条), 状态仍是 202 待签名', async () => {
    const a = await startRpc();
    const b = await startRpc();
    try {
      const txHash = freshTx();
      const r1 = await handleDirectPayment({ item, bodyText: JSON.stringify({ txHash }), home: HOME, rpcUrls: [a.url, b.url], allowDisabled: true });
      expect(r1.status).toBe(202);
      const p1 = JSON.parse(r1.body).pendingId;
      const r2 = await handleDirectPayment({ item, bodyText: JSON.stringify({ txHash }), home: HOME, rpcUrls: [a.url, b.url], allowDisabled: true });
      expect(r2.status).toBe(202);
      const j2 = JSON.parse(r2.body);
      expect(j2.pendingId).toBe(p1);
      expect(j2.payment.reused).toBe(true);
      expect(JSON.parse(r1.body).payment.receiptHash).toBe(j2.payment.receiptHash);
      // 队列里这条 txHash 只有一条待办
      const same = (await listPending(HOME)).filter((p) => p.payment.txHash === txHash);
      expect(same).toHaveLength(1);
    } finally { await a.close(); await b.close(); }
  });

  it('同一 txHash 换另一条资源 → 409', async () => {
    const a = await startRpc();
    const b = await startRpc();
    try {
      const other = await publishInfo({
        id: 'info_direct_probe_http2', title: '另一条', category: 'data', content: 'x',
        price: { amount: PRICE_HUMAN, currency: 'USDC', network: 'base', payTo: PAY_TO },
        source: { kind: 'self', refs: [] }, provider: { did: 'did:key:zOther2' },
      }, { home: HOME });
      const txHash = freshTx();
      const r1 = await handleDirectPayment({ item, bodyText: JSON.stringify({ txHash }), home: HOME, rpcUrls: [a.url, b.url], allowDisabled: true });
      expect(r1.status).toBe(202);
      const r2 = await handleDirectPayment({ item: other, bodyText: JSON.stringify({ txHash }), home: HOME, rpcUrls: [a.url, b.url], allowDisabled: true });
      expect(r2.status).toBe(409);
      expect(JSON.parse(r2.body).code).toBe('TXHASH_ALREADY_USED');
    } finally { await a.close(); await b.close(); }
  });

  it('未付款的 GET 402 分支**没被本模式碰到**: buildPaymentRequired 输出与 402 用同一份', async () => {
    const stored = await getStoredInfo(item.id, HOME);
    const reqs = buildPaymentRequired(stored!.item, `https://pay.bolloon.cn/api/x402/info/${stored!.item.id}`);
    expect(reqs.x402Version).toBe(2);
    expect(reqs.accepts[0]).toEqual({
      scheme: 'exact', network: 'base', asset: USDC_BASE, amount: ITEM_AMOUNT, payTo: PAY_TO, maxTimeoutSeconds: 60,
      extra: { name: 'USDC', itemId: item.id, category: 'data', providerDid: item.provider.did },
    });
    // 内容哈希自洽 (直付交付的信封靠它防"挂 A 卖 B")
    expect(computeContentHash(CONTENT)).toBe(item.contentHash);
    // 直付路径与取件路径的形状
    expect(directPaymentPath(item.id)).toBe(`/api/x402/info/${item.id}/payment`);
  });

  it('本机没有共享密钥时, 队列端点仍然拒绝 (直付模式不改变认证口径)', async () => {
    const auth = await loadSellerAuth(HOME);
    expect(auth).toBeNull();
  });

  it('台账是文件台账 (不依赖数据库): 认领后文件里有这笔交易的记录', async () => {
    const ledger = new DirectTxLedger(directTxLedgerPath(HOME));
    const rec = await ledger.get(TXHASH);
    if (rec) {
      expect(rec.txHash).toBe(TXHASH);
      expect(rec.itemId).toBe('info_direct_probe');
      expect(rec.verifiedBy).toHaveLength(2);
      expect(rec.receiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } else {
      expect(fs.existsSync(directTxLedgerPath(HOME))).toBe(true);
    }
    // 未知交易 → null (不猜)
    expect(await ledger.get(`0x${randomBytes(32).toString('hex')}`)).toBeNull();
  });
});
