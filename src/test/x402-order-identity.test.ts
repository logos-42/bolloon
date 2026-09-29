/**
 * x402-order-identity.test.ts — **订单标识 (约定 v1, 标签 "BOL1")** 的聚焦测试
 *
 * 要证明的三件事 (缺一条这套测试就没意义):
 *   ① **约定 v1 是可复算的**: keccak256 与 ethers 逐字一致 · nonce 字节布局确定 · 卖方拿本店
 *      item + 解出的 orderSeq 能复算出同一个哈希 ⇒ "订单自证"不是口号。
 *   ② **EIP-712 域不是猜的**: 用链上实测的 `DOMAIN_SEPARATOR()` 作锚 —— 顺带**证伪**
 *      "name 写 USDC" 这种直觉 (USDC 的 EIP-712 name 是 "USD Coin", 用错 chain 上必 revert)。
 *   ③ **诚实降级**: 没有 AuthorizationUsed / 标签不对 / 哈希对不上本店 item / 同 (payer,nonce)
 *      被换 txHash 重放 —— 一律**如实降级或拒绝**, 绝不让"直转"看起来像"自证"。
 *
 * 全程 **0 链上交易 / 0 真钱 / 0 真网络**: receipt 与日志都是夹具, 由**真 HTTP JSON-RPC 服务**回放
 * (走真的 fetch/JSON-RPC 路径, 不是假 fetch 讲道理)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { keccak256 as ethersKeccak, toUtf8Bytes, TypedDataEncoder, Wallet } from 'ethers';

import {
  ORDER_IDENTITY_PROTOCOL, ORDER_NONCE_TAG, ORDER_NONCE_TAG_ASCII,
  EIP3009_AUTHORIZATION_USED_TOPIC0, EIP3009_TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  USDC_EIP712_NAME_CANDIDATES,
  keccak256Hex, eip712DomainSeparator, eip712DomainTypehash, eip3009Typehash,
  computeOrderNonce, decodeOrderNonce, matchOrderNonce, orderItemHash24,
  orderIdentityFromLogs, readOrderIdentityFromTx, shortOrderIdentity, orderIdentityDigest,
  type OrderIdentity,
} from '../agents/x402/order-identity.js';
import {
  ERC20_TRANSFER_TOPIC0, settleDirectPayment, handleDirectPayment, verifyDirectTransfer,
  buildDirectReceipt, DirectTxLedger, directTxLedgerPath, directHealth,
} from '../agents/x402/direct-payment.js';
import { publishInfo } from '../agents/x402/paid-info-store.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0xb4e9dCF79055A8232670ebb1c8c664Dff4E70066';
const PAYER = '0x6a3f797592bed028f6afd6da82339c8e815480eb';
const OTHER_PAYER = '0x2222222222222222222222222222222222222222';
const ITEM_ID = 'info_oi_probe';
const ITEM_AMOUNT = '10000';       // 0.01 USDC (原子单位)
const BLOCK = 51_930_000;
/** 链上实测 (2026-09-29, mainnet.base.org 与 base.drpc.org 同值): Base USDC 的 EIP-712 域分隔符 */
const USDC_ONCHAIN_DOMAIN_SEPARATOR = '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-oi-'));
const HOME = path.join(TMP, 'home');
const TXHASH = `0x${'a1'.repeat(32)}`;
const TXHASH2 = `0x${'b2'.repeat(32)}`;

// ═══════════════════════════════════════════════ 夹具: 真 HTTP JSON-RPC 服务 (回放 receipt)

function pad32(addr: string): string {
  return `0x${String(addr).replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
}

interface FixtureOpts {
  status?: 0 | 1;
  blockNumber?: number;
  transfer?: { from?: string; to?: string; value?: string } | null;
  /** 《AuthorizationUsed(payer, nonce)》—— 传 null 就不放这条 (普通转账) */
  auth?: { payer?: string; nonce: string } | null;
  /** 故意把 AuthorizationUsed 的 topic0 换掉 (模拟"别的授权事件") */
  authTopic0?: string;
  /** 让 nonce 变成脏数据 (形状不对) */
  authNonceRaw?: string;
}

function log(address: string, topics: string[], data = '0x') {
  return { address, topics, data, blockNumber: `0x${BLOCK.toString(16)}` };
}

function receiptFixture(o: FixtureOpts = {}) {
  const logs: any[] = [];
  if (o.transfer !== null) {
    const t = o.transfer || {};
    logs.push(log(USDC_BASE, [
      ERC20_TRANSFER_TOPIC0, pad32(t.from ?? PAYER), pad32(t.to ?? PAY_TO),
    ], `0x${BigInt(t.value ?? ITEM_AMOUNT).toString(16).padStart(64, '0')}`));
  }
  if (o.auth !== null && o.auth !== undefined) {
    logs.push(log(USDC_BASE, [
      o.authTopic0 ?? EIP3009_AUTHORIZATION_USED_TOPIC0,
      pad32(o.auth.payer ?? PAYER),
      o.authNonceRaw ?? o.auth.nonce,
    ]));
  }
  const bn = o.blockNumber ?? BLOCK;
  return {
    transactionHash: TXHASH,
    blockNumber: `0x${bn.toString(16)}`,
    status: o.status === 0 ? '0x0' : '0x1',
    logs: logs.map((l) => ({ ...l, blockNumber: `0x${bn.toString(16)}` })),
  };
}

async function startRpc(receipt: any, latestBlock = BLOCK + 5) {
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
        case 'eth_chainId': return reply('0x2105');
        // 回放夹具: 被问哪一笔就把它自己那个 txHash 回填进去 (与真 RPC 一样)
        case 'eth_getTransactionReceipt': return reply({ ...receipt, transactionHash: body.params?.[0] ?? receipt.transactionHash });
        case 'eth_blockNumber': return reply(`0x${latestBlock.toString(16)}`);
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

async function twoRpcs(receipt: any, latestBlock = BLOCK + 5) {
  const a = await startRpc(receipt, latestBlock);
  const b = await startRpc(receipt, latestBlock);
  return { urls: [a.url, b.url], hits: a.hits, close: async () => { await a.close(); await b.close(); } };
}

let item: Awaited<ReturnType<typeof publishInfo>>;

beforeAll(async () => {
  item = await publishInfo({
    id: ITEM_ID,
    title: '订单标识探针条目',
    category: 'data',
    content: JSON.stringify({ probe: 'order-identity' }),
    price: { amount: '0.01', currency: 'USDC', network: 'base', payTo: PAY_TO },
    source: { kind: 'self', refs: [] },
    provider: { did: 'did:key:z6MkOrderIdentityProbePlaceholder00000000' },
  }, { home: HOME });
});

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

// ═══════════════════════════════════════════════ A. 约定 v1: 可复算的字节事实

describe('A. 约定 v1 (纯函数): keccak / 域 / nonce 布局', () => {
  it('keccak256 与 ethers 逐字一致 (含 >136 字节的多块输入)', () => {
    for (const v of ['', 'abc', 'hello world', 'BOL1', `${ITEM_ID}:0`, 'x'.repeat(200), '订单标识']) {
      expect(keccak256Hex(v)).toBe(ethersKeccak(toUtf8Bytes(v)));
    }
  });

  it('EIP-712 域分隔符 == ethers 的计算 == 链上实测值; 且**证伪** name="USDC" 这种猜法', () => {
    const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
    expect(eip712DomainSeparator(domain)).toBe(TypedDataEncoder.hashDomain(domain));
    expect(eip712DomainSeparator(domain).toLowerCase()).toBe(USDC_ONCHAIN_DOMAIN_SEPARATOR);
    // ★ 用错的 name 签出来链上必 revert —— 所以买方 CLI 是**读链上 DOMAIN_SEPARATOR 反查**, 不写死
    const wrong = eip712DomainSeparator({ ...domain, name: 'USDC' });
    expect(wrong.toLowerCase()).not.toBe(USDC_ONCHAIN_DOMAIN_SEPARATOR);
    expect(USDC_EIP712_NAME_CANDIDATES[0]).toBe('USD Coin');
  });

  it('类型串哈希与实测口径一致 (防漂移)', () => {
    expect(eip712DomainTypehash()).toBe(ethersKeccak(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')));
    expect(eip3009Typehash()).toBe(ethersKeccak(toUtf8Bytes('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')));
    // 主题0 与"实测可用"的那个值一致 (非索引参数无 ⇒ nonce 在 topics[2])
    expect(EIP3009_AUTHORIZATION_USED_TOPIC0).toBe('0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5');
    expect(EIP3009_TRANSFER_WITH_AUTHORIZATION_SELECTOR).toBe('0xe3ee160e');
    expect(ORDER_NONCE_TAG).toBe('0x424f4c31');
    expect(ORDER_NONCE_TAG_ASCII).toBe('BOL1');
    expect(ORDER_IDENTITY_PROTOCOL).toBe('bolloon-x402-order-identity/1');
  });

  it('nonce 字节布局: tag(4B) ‖ orderSeq(uint32 BE) ‖ keccak256(itemId‖uint256be(seq))[0..23]', () => {
    const seq = 7;
    const nonce = computeOrderNonce(ITEM_ID, seq);
    expect(nonce).toHaveLength(2 + 64);
    const bytes = Buffer.from(nonce.slice(2), 'hex');
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('BOL1');
    expect(bytes.readUInt32BE(4)).toBe(seq);
    // 后 24 字节 = 独立算一遍 keccak256(utf8(itemId) ‖ uint256be(seq)) 的前 24 字节
    const seqWord = Buffer.alloc(32); seqWord.writeUInt32BE(seq, 28);
    const expectHash = ethersKeccak(Buffer.concat([toUtf8Bytes(ITEM_ID), seqWord]));
    expect(`0x${bytes.subarray(8).toString('hex')}`).toBe(`${expectHash.slice(0, 2 + 48)}`);
    expect(orderItemHash24(ITEM_ID, seq)).toBe(`0x${bytes.subarray(8).toString('hex')}`);
  });

  it('解出来能对回去: orderSeq / itemIdHash / 标签', () => {
    const d = decodeOrderNonce(computeOrderNonce(ITEM_ID, 42));
    expect(d.shape).toBe('ok');
    expect(d.tagPresent).toBe(true);
    expect(d.tag).toBe('BOL1');
    expect(d.orderSeq).toBe(42);
    expect(d.itemIdHash).toBe(orderItemHash24(ITEM_ID, 42));
    expect(matchOrderNonce(d, [ITEM_ID])).toEqual([ITEM_ID]);
    expect(matchOrderNonce(d, ['别的item'])).toEqual([]);
  });

  it('同一买家重复买同件要换 seq (nonce 必不同); 不同 item 同 seq 也不同', () => {
    expect(computeOrderNonce(ITEM_ID, 0)).not.toBe(computeOrderNonce(ITEM_ID, 1));
    expect(computeOrderNonce(ITEM_ID, 0)).not.toBe(computeOrderNonce('别的item', 0));
    expect(() => computeOrderNonce(ITEM_ID, 2 ** 32)).toThrow();
  });
});

// ═══════════════════════════════════════════════ B. 日志 → 订单标识 (纯函数)

describe('B. orderIdentityFromLogs: 标签在不在 / 对不对得上本店 item', () => {
  const transfer = () => log(USDC_BASE, [ERC20_TRANSFER_TOPIC0, pad32(PAYER), pad32(PAY_TO)], `0x${BigInt(ITEM_AMOUNT).toString(16).padStart(64, '0')}`);
  const auth = (nonce: string, payer = PAYER) => log(USDC_BASE, [EIP3009_AUTHORIZATION_USED_TOPIC0, pad32(payer), nonce]);
  const o = (logs: any[], itemIds = [ITEM_ID]) => orderIdentityFromLogs(logs, { itemIds, asset: USDC_BASE });

  it('标签正确 + 哈希对得上本店 item → self-attested (唯一算自证的情况)', () => {
    const id = o([transfer(), auth(computeOrderNonce(ITEM_ID, 3))]);
    expect(id.mode).toBe('self-attested');
    expect(id.selfAttested).toBe(true);
    expect(id.degraded).toBe(false);
    expect(id.orderSeq).toBe(3);
    expect(id.matchedItemIds).toEqual([ITEM_ID]);
    expect(id.payer).toBe(PAYER);
    expect(id.detail).toContain(ITEM_ID);
  });

  it('标签正确但哈希对不上本店任何 item → item-mismatch (如实降级, 不假装自证)', () => {
    const id = o([transfer(), auth(computeOrderNonce('别人家的item', 3))]);
    expect(id.mode).toBe('item-mismatch');
    expect(id.selfAttested).toBe(false);
    expect(id.degraded).toBe(true);
    expect(id.orderSeq).toBe(3);
    expect(id.matchedItemIds).toEqual([]);
    expect(id.detail).toContain('不假装自证');
  });

  it('同样的 orderSeq 但 item 不同 → 哈希不同 (所以"碰巧对上"是不可能的)', () => {
    expect(orderItemHash24(ITEM_ID, 3)).not.toBe(orderItemHash24('别人家的item', 3));
    expect(o([transfer(), auth(computeOrderNonce('别人家的item', 3))]).mode).toBe('item-mismatch');
  });

  it('有 AuthorizationUsed 但 nonce 没带 BOL1 标签 (随机 nonce) → not-bol1 (降级)', () => {
    const id = o([transfer(), auth(`0x${'77'.repeat(32)}`)]);
    expect(id.mode).toBe('not-bol1');
    expect(id.selfAttested).toBe(false);
    expect(id.tagPresent).toBe(false);
    expect(id.detail).toContain('BOL1');
  });

  it('普通转账 (日志里根本没有 AuthorizationUsed) → no-authorization-used (降级)', () => {
    const id = o([transfer()]);
    expect(id.mode).toBe('no-authorization-used');
    expect(id.selfAttested).toBe(false);
    expect(id.degraded).toBe(true);
    expect(id.nonce).toBeNull();
    expect(id.detail).toContain('直转(无订单标识)');
  });

  it('AuthorizationUsed 的 topic0 不对 (别的授权事件) → 同样当没有 (不硬认)', () => {
    const id = o([transfer(), log(USDC_BASE, [`0x${'dead'.repeat(16)}`, pad32(PAYER), computeOrderNonce(ITEM_ID, 3)])]);
    expect(id.mode).toBe('no-authorization-used');
  });

  it('别的合约发的 AuthorizationUsed 不算数 (只认 asset 合约)', () => {
    const id = o([transfer(), log('0x4200000000000000000000000000000000000006', [EIP3009_AUTHORIZATION_USED_TOPIC0, pad32(PAYER), computeOrderNonce(ITEM_ID, 3)])]);
    expect(id.mode).toBe('no-authorization-used');
  });

  it('nonce 形状不对 (脏数据) → malformed-nonce (不崩, 也不当自证)', () => {
    const id = o([transfer(), log(USDC_BASE, [EIP3009_AUTHORIZATION_USED_TOPIC0, pad32(PAYER), '0x00'])]);
    expect(id.mode).toBe('malformed-nonce');
    expect(id.selfAttested).toBe(false);
  });

  it('空/缺参数不崩 (安全默认 = 降级)', () => {
    expect(orderIdentityFromLogs(undefined, { itemIds: [ITEM_ID], asset: USDC_BASE }).mode).toBe('no-authorization-used');
    expect(orderIdentityFromLogs([], { itemIds: [] }).mode).toBe('no-authorization-used');
    const id = orderIdentityFromLogs([auth(computeOrderNonce(ITEM_ID, 3))], { itemIds: [] });
    expect(id.mode).toBe('item-mismatch');   // 没给本店 item ⇒ 无从复算 ⇒ 不算自证
  });

  it('短写/摘要稳定 (台账与页面用)', () => {
    const id = o([transfer(), auth(computeOrderNonce(ITEM_ID, 5))]);
    expect(shortOrderIdentity(id)).toBe(`BOL1/seq=5/item=${ITEM_ID}`);
    expect(orderIdentityDigest(id)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(orderIdentityDigest(id)).toBe(orderIdentityDigest(o([transfer(), auth(computeOrderNonce(ITEM_ID, 5))])));
    expect(orderIdentityDigest(null)).toBe('none');
  });
});

// ═══════════════════════════════════════════════ C. 台账: (payer, nonce) 只能用一次

describe('C. 幂等台账: 同一 (payer, nonce) 换 txHash = 重放 → 拒', () => {
  const tmpFile = path.join(TMP, 'ledger-nonce.json');
  const base = {
    itemId: ITEM_ID, network: 'base', chainId: 8453, asset: USDC_BASE, to: PAY_TO,
    from: PAYER, amount: ITEM_AMOUNT, blockNumber: BLOCK, confirmations: 5,
    verifiedBy: ['a', 'b'], receiptHash: 'sha256:0',
  };

  it('第一次认领成功; 同 nonce+同 payer 换另一笔 txHash → NONCE_ALREADY_USED', async () => {
    const ledger = new DirectTxLedger(tmpFile);
    const orderIdentity = orderIdentityFromLogs(
      [log(USDC_BASE, [EIP3009_AUTHORIZATION_USED_TOPIC0, pad32(PAYER), computeOrderNonce(ITEM_ID, 0)])],
      { itemIds: [ITEM_ID], asset: USDC_BASE },
    );
    const r1 = await ledger.claim({ ...base, txHash: TXHASH, orderIdentity });
    expect(r1.ok).toBe(true);
    const r2 = await ledger.claim({ ...base, txHash: TXHASH2, orderIdentity });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('NONCE_ALREADY_USED');
    expect(String(r2.detail)).toContain('只能用一次');
  });

  it('★ 不同买家可用**同一个 nonce** (去重键是 (payer, nonce), 不是 nonce 单独)', async () => {
    const ledger = new DirectTxLedger(path.join(TMP, 'ledger-two-payers.json'));
    const nonce = computeOrderNonce(ITEM_ID, 0);
    const idFor = (payer: string) => orderIdentityFromLogs(
      [log(USDC_BASE, [EIP3009_AUTHORIZATION_USED_TOPIC0, pad32(payer), nonce])],
      { itemIds: [ITEM_ID], asset: USDC_BASE },
    );
    const a = await ledger.claim({ ...base, txHash: TXHASH, orderIdentity: idFor(PAYER) });
    const b = await ledger.claim({ ...base, txHash: TXHASH2, from: OTHER_PAYER, orderIdentity: idFor(OTHER_PAYER) });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('老记录 (没有订单标识) 不受影响, 且回执逐字与"加这功能之前"同算法', async () => {
    const ledger = new DirectTxLedger(path.join(TMP, 'ledger-legacy.json'));
    const r1 = await ledger.claim({ ...base, txHash: TXHASH });
    expect(r1.ok).toBe(true);
    expect(r1.record!.orderIdentity).toBeUndefined();
    // 没有 orderIdentity 的回执里不许出现这个键 (老账单一字节都不许变)
    const decoded = JSON.parse(Buffer.from(buildDirectReceipt(r1.record!), 'base64').toString('utf-8'));
    expect(decoded.orderIdentity).toBeUndefined();
    expect(decoded.protocol).toBe('bolloon-x402-direct/1');
  });
});

// ═══════════════════════════════════════════════ D. 卖方链上核验 (假 RPC 回放)

describe('D. 卖方核验: 从同一条交易的日志里读出订单标识', () => {
  // 每个用例一笔**独立**的交易 (台账是按 txHash 幂等的: 复用同一个 txHash 会命中"同一条待办")
  let txSeq = 0;
  const tx = () => `0x${(++txSeq).toString(16).padStart(64, '0')}`;
  const settle = (urls: string[], txHash: string, over: Record<string, unknown> = {}) => settleDirectPayment({
    item, txHash, home: HOME, rpcUrls: urls, allowDisabled: true, ...over,
  });

  it('两条 RPC 一致 (AuthorizationUsed + Transfer) → ok + self-attested + 回执带订单标识', async () => {
    const nonce = computeOrderNonce(ITEM_ID, 11);
    const r = await twoRpcs(receiptFixture({ auth: { nonce } }));
    const h = tx();
    try {
      const out = await settle(r.urls, h);
      expect(out.ok).toBe(true);
      expect(out.orderIdentitySelfAttested).toBe(true);
      expect(out.orderIdentity?.mode).toBe('self-attested');
      expect(out.orderIdentity?.orderSeq).toBe(11);
      expect(out.orderIdentity?.nonce).toBe(nonce);
      expect(out.orderIdentity?.matchedItemIds).toEqual([ITEM_ID]);
      // 回执 (卖方远端只读汇总/台账读的就是它) 里也写清了自证
      const decoded = JSON.parse(Buffer.from(String(out.receipt), 'base64').toString('utf-8'));
      expect(decoded.orderIdentity.selfAttested).toBe(true);
      expect(decoded.orderIdentity.orderSeq).toBe(11);
      expect(decoded.orderIdentity.items).toEqual([ITEM_ID]);
      expect(decoded.orderIdentity.nonce).toBe(nonce);
      // 台账落盘也带 (下次/重启后仍能读出来)
      const ledger = JSON.parse(fs.readFileSync(directTxLedgerPath(HOME), 'utf-8'));
      expect(ledger.txs[h].orderIdentity.mode).toBe('self-attested');
      expect(fs.statSync(directTxLedgerPath(HOME)).mode & 0o777).toBe(0o600);
    } finally { await r.close(); }
  });

  it('普通转账 (只有 Transfer, 没有 AuthorizationUsed) → 交付照旧, 但**如实降级**', async () => {
    const r = await twoRpcs(receiptFixture({ auth: null }));
    try {
      const out = await settle(r.urls, tx());
      expect(out.ok).toBe(true);
      expect(out.orderIdentitySelfAttested).toBe(false);
      expect(out.orderIdentity?.mode).toBe('no-authorization-used');
      expect(out.orderIdentity?.degraded).toBe(true);
      expect(String(out.orderIdentity?.detail)).toContain('直转(无订单标识)');
    } finally { await r.close(); }
  });

  it('nonce 带 BOL1 但哈希对不上本店 item → 交付照旧, 订单标识降级为 item-mismatch', async () => {
    const r = await twoRpcs(receiptFixture({ auth: { nonce: computeOrderNonce('别人家的item', 11) } }));
    try {
      const out = await settle(r.urls, tx());
      expect(out.ok).toBe(true);
      expect(out.orderIdentitySelfAttested).toBe(false);
      expect(out.orderIdentity?.mode).toBe('item-mismatch');
    } finally { await r.close(); }
  });

  it('★ 一条 RPC 看到 AuthorizationUsed 另一条没看到 → rpc_disagreement (绝不挑好的信)', async () => {
    const nonce = computeOrderNonce(ITEM_ID, 11);
    const a = await startRpc(receiptFixture({ auth: { nonce } }));
    const b = await startRpc(receiptFixture({ auth: null }));
    try {
      const out = await settle([a.url, b.url], tx());
      expect(out.ok).toBe(false);
      expect(out.verdict?.status).toBe('rpc_disagreement');
      expect(out.code).toBe('DIRECT_PAYMENT_NOT_VERIFIED');
    } finally { await a.close(); await b.close(); }
  });

  it('★ nonce 重放: 链上第二笔必 revert (status=0) → 核验不过 (402 路径), 台账不留痕', async () => {
    const before = Object.keys(JSON.parse(fs.readFileSync(directTxLedgerPath(HOME), 'utf-8')).txs || {}).length;
    const r = await twoRpcs(receiptFixture({ status: 0, auth: { nonce: computeOrderNonce(ITEM_ID, 11) } }));
    try {
      const out = await settle(r.urls, tx());
      expect(out.ok).toBe(false);
      expect(out.code).toBe('DIRECT_PAYMENT_NOT_VERIFIED');
      expect(out.verdict?.status).toBe('reverted');
      // 回滚的交易连订单标识都不该被当成"见到过成功的授权"
      const after = Object.keys(JSON.parse(fs.readFileSync(directTxLedgerPath(HOME), 'utf-8')).txs || {}).length;
      expect(after).toBe(before);
    } finally { await r.close(); }
  });

  it('HTTP 202 回显里带 orderIdentity + payment.orderIdentitySelfAttested', async () => {
    const nonce = computeOrderNonce(ITEM_ID, 12);
    const r = await twoRpcs(receiptFixture({ auth: { nonce } }));
    try {
      const out = await handleDirectPayment({
        item, bodyText: JSON.stringify({ txHash: tx() }), home: HOME,
        rpcUrls: r.urls, allowDisabled: true,
      });
      expect(out.status).toBe(202);
      const body = JSON.parse(out.body);
      expect(body.orderIdentity.mode).toBe('self-attested');
      expect(body.orderIdentity.selfAttested).toBe(true);
      expect(body.orderIdentity.matchedItemIds).toEqual([ITEM_ID]);
      expect(body.payment.orderIdentitySelfAttested).toBe(true);
      expect(body.payment.orderIdentityMode).toBe('self-attested');
      expect(body.payment.custody).toBe('none');
    } finally { await r.close(); }
  });

  it('核验没过 (事件对不上) 的 402 里也如实给出"这笔交易声明的订单身份"', async () => {
    const r = await twoRpcs(receiptFixture({ transfer: { to: OTHER_PAYER }, auth: { nonce: computeOrderNonce(ITEM_ID, 13) } }));
    try {
      const out = await handleDirectPayment({
        item, bodyText: JSON.stringify({ txHash: tx() }), home: HOME,
        rpcUrls: r.urls, allowDisabled: true,
      });
      expect(out.status).toBe(402);
      const body = JSON.parse(out.body);
      expect(body.accepts[0].amount).toBe(ITEM_AMOUNT);   // accepts 逐字不变
      expect(body.paymentAttempt.orderIdentity.mode).toBe('self-attested');
      expect(body.paymentAttempt.verified).toBe(false);
    } finally { await r.close(); }
  });

  it('health 自述里带订单标识约定 (机器可读; 不懂 = 页面不该声称)', () => {
    const h = directHealth({ BOLLOON_X402_DIRECT: '1' } as any);
    const oi = h.orderIdentity as any;
    expect(oi.protocol).toBe(ORDER_IDENTITY_PROTOCOL);
    expect(oi.tag).toBe('BOL1');
    expect(oi.eventTopic0).toBe(EIP3009_AUTHORIZATION_USED_TOPIC0);
    expect(String(oi.layout)).toContain('orderSeq');
  });
});

// ═══════════════════════════════════════════════ E. 只读入口 (给公示/索引线)

describe('E. readOrderIdentityFromTx: 只读、不写盘、不交付', () => {
  it('给定 txHash + 本店 item → 返回 orderIdentity (自证成功)', async () => {
    const nonce = computeOrderNonce(ITEM_ID, 21);
    const rpc = await startRpc(receiptFixture({ auth: { nonce } }));
    try {
      const r = await readOrderIdentityFromTx({ txHash: TXHASH, itemIds: [ITEM_ID], asset: USDC_BASE, rpcUrl: rpc.url });
      expect(r.ok).toBe(true);
      expect(r.blockNumber).toBe(BLOCK);
      expect(r.orderIdentity?.mode).toBe('self-attested');
      expect(r.orderIdentity?.matchedItemIds).toEqual([ITEM_ID]);
      const r2 = await readOrderIdentityFromTx({ txHash: TXHASH, itemIds: ['别的item'], asset: USDC_BASE, rpcUrl: rpc.url });
      expect(r2.orderIdentity?.mode).toBe('item-mismatch');
    } finally { await rpc.close(); }
  });

  it('普通转账 → 降级 (页面只能写"直转", 不许写"自证")', async () => {
    const rpc = await startRpc(receiptFixture({ auth: null }));
    try {
      const r = await readOrderIdentityFromTx({ txHash: TXHASH, itemIds: [ITEM_ID], asset: USDC_BASE, rpcUrl: rpc.url });
      expect(r.ok).toBe(true);
      expect(r.orderIdentity?.selfAttested).toBe(false);
      expect(r.orderIdentity?.mode).toBe('no-authorization-used');
    } finally { await rpc.close(); }
  });

  it('txHash 形状不对 / RPC 读不到 → ok:false + 说清原因 (不抛异常, 不当成"没付过")', async () => {
    const bad = await readOrderIdentityFromTx({ txHash: '0x1234', itemIds: [ITEM_ID], rpcUrl: 'http://127.0.0.1:9' });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('形状');
    const dead = await readOrderIdentityFromTx({ txHash: TXHASH, itemIds: [ITEM_ID], rpcUrl: 'http://127.0.0.1:9' });
    expect(dead.ok).toBe(false);
    expect(String(dead.error)).toContain('RPC 读不到');
  });
});

// ═══════════════════════════════════════════════ F. 买方侧参数不被走样

describe('F. 买方签名口径 (离线可验的部分)', () => {
  it('用约定 v1 的 nonce 签 EIP-3009, 验签回买方地址 (签名结构可用)', async () => {
    const w = Wallet.createRandom();
    const nonce = computeOrderNonce(ITEM_ID, 0);
    const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    };
    const value = { from: w.address, to: PAY_TO, value: ITEM_AMOUNT, validAfter: 0, validBefore: 2_000_000_000, nonce };
    const sig = await w.signTypedData(domain, types, value);
    const { verifyTypedData } = await import('ethers');
    expect(verifyTypedData(domain, types, value, sig)).toBe(w.address);
    // 改一个字节 (金额/收款人) → 验签必失败 (证明这笔授权是绑死的)
    expect(verifyTypedData(domain, types, { ...value, value: '20000' }, sig)).not.toBe(w.address);
    expect(verifyTypedData(domain, types, { ...value, to: OTHER_PAYER }, sig)).not.toBe(w.address);
    expect(verifyTypedData(domain, types, { ...value, nonce: computeOrderNonce(ITEM_ID, 1) }, sig)).not.toBe(w.address);
  });

  it('卖方核验的输出不含任何私钥/密钥字段 (回执/台账同源可查)', async () => {
    const nonce = computeOrderNonce(ITEM_ID, 31);
    const r = await twoRpcs(receiptFixture({ auth: { nonce } }));
    try {
      const out = await settleDirectPayment({
        item, txHash: TXHASH2, home: HOME, rpcUrls: r.urls, allowDisabled: true,
      });
      const raw = String(out.receipt);
      for (const bad of ['privateKey', 'secret', 'mnemonic', 'seed']) expect(raw).not.toContain(bad);
      // 订单标识里只有公开事实: nonce / seq / 哈希 / itemId
      expect(out.orderIdentity).toBeTruthy();
      expect(JSON.stringify(out.orderIdentity)).not.toContain('private');
    } finally { await r.close(); }
  });
});
