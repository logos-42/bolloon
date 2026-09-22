/**
 * chain-paid-info-f5.test.ts — F5 修复的回归测试: 「拿到 txHash ≠ 链上已验证」
 *
 * 老问题 (src/agents/x402/paid-info-store.ts):
 *   `chainSettled = !!txHash` —— 拿到 txHash 就判链上结算, 从不读 receipt/事件/确认数。
 *
 * 覆盖:
 *   · verifyPaymentOnChain: 没 txHash / 确认数不够 / receipt 失败 / 事件不匹配 / RPC 读不到 → 一律 chainSettled=false
 *   · buyInfo 端到端接线: facilitator 返回 txHash 时**必须**经过真验证器, 才决定 chainSettled
 *   · 默认验证器 (无注入) + 链配置/链不可用 → 如实判未结算, 绝不冒报
 *   · 旧调用方 (不传 chainSettlement) 签名兼容, 不炸
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// facilitator 付款路径打桩: 真 createX402PaymentFetch 要连网, 这里换成假的
const H = vi.hoisted(() => ({
  TXH: '0x' + 'aa'.repeat(32),
  /** 'withTxHash' = facilitator 回执带 txHash; 'noTxHash' = 不带 (不能认定链上结算) */
  mode: 'withTxHash' as 'withTxHash' | 'noTxHash',
}));

vi.mock('../agents/x402/x402Pay.js', () => ({
  createX402PaymentFetch: async () => {
    return async () => {
      const body: any = { ok: true, payment: { receipt: 'rcpt-1' }, contentHash: 'h' };
      if (H.mode === 'withTxHash') body.payment.txHash = H.TXH;
      return new Response(
        JSON.stringify(body),
        { status: 200, headers: { 'content-type': 'application/json', 'x-payment-response': 'rcpt-1' } },
      );
    };
  },
}));

import { verifyPaymentOnChain, buyInfo } from '../agents/x402/paid-info-store.js';
import type { ChainSettlementVerdict, ChainSettlementVerifier } from '../agents/chain/chain-settlement.js';
import { ESCROW_ADDR, TASK_KEY, RESULT_HASH } from './chain-test-helpers.js';

const PK = '0x' + '33'.repeat(32);
const TXH = H.TXH;

const verdict = (over: Partial<ChainSettlementVerdict>): ChainSettlementVerdict => ({
  chainSettled: false, status: 'unknown', reason: 'stub', confirmationsRequired: 1, requiredGate: 'confirmed',
  rpcAvailable: true, checkedAt: Date.now(), evidence: {}, ...over,
});

describe('verifyPaymentOnChain — F5 判定', () => {
  it('★ 没有 txHash → not_attempted + chainSettled=false (杜绝"有 hash 就算结算")', async () => {
    const v = await verifyPaymentOnChain({ txHash: '' });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('not_attempted');
    expect(v.reason).toContain('没有链上交易可查');
  });

  it('确认数不够 → pending + chainSettled=false', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'pending', confirmations: 0, confirmationsRequired: 1, reason: '确认数 0 < 1' });
    const v = await verifyPaymentOnChain({ txHash: TXH, chainSettlement: { verifier } });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('pending');
  });

  it('确认数够 + 事件对得上 → confirmed + chainSettled=true', async () => {
    const verifier: ChainSettlementVerifier = async (req) => {
      expect(req.txHash).toBe(TXH);
      expect(req.expect?.taskKey).toBe(TASK_KEY);
      return verdict({ status: 'confirmed', chainSettled: true, confirmations: 3, reason: 'ok' });
    };
    const v = await verifyPaymentOnChain({
      txHash: TXH,
      chainSettlement: { verifier, expect: { kind: 'escrow', taskKey: TASK_KEY, resultHash: RESULT_HASH } },
    });
    expect(v.chainSettled).toBe(true);
    expect(v.status).toBe('confirmed');
  });

  it('receipt 失败 (reverted) → chainSettled=false', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'reverted', reason: 'receipt.status = 0' });
    const v = await verifyPaymentOnChain({ txHash: TXH, chainSettlement: { verifier } });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('reverted');
  });

  it('事件不匹配 → chainSettled=false', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'event_mismatch', eventMatched: false, reason: '不是我们要的那笔' });
    const v = await verifyPaymentOnChain({ txHash: TXH, chainSettlement: { verifier } });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
  });

  it('重组 → chainSettled=false', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'reorged', reason: '重组' });
    const v = await verifyPaymentOnChain({ txHash: TXH, chainSettlement: { verifier } });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('reorged');
  });

  it('★ 验证器抛错 → 降级 unknown + chainSettled=false (fail-closed, 不炸付款路径)', async () => {
    const verifier: ChainSettlementVerifier = async () => { throw new Error('boom'); };
    const v = await verifyPaymentOnChain({ txHash: TXH, chainSettlement: { verifier } });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('unknown');
    expect(v.reason).toContain('不能判已结算');
  });
});

describe('buyInfo — facilitator 路径真接链验证', () => {
  let events: any[];
  beforeEach(() => { events = []; });
  afterEach(() => { vi.unstubAllEnvs(); });

  const fetch402 = (async () => new Response(JSON.stringify({
    accepts: [{ scheme: 'exact', network: 'base-sepolia', amount: '10000', payTo: '0x' + '11'.repeat(20) }],
    metadata: { id: 'info-1' },
  }), { status: 402, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  const run = (chainSettlement?: any) => buyInfo({
    url: 'http://x/info-1',
    privateKey: PK,
    fetchImpl: fetch402,
    chainSettlement,
    onEvent: async (e) => { events.push(e); },
  });

  const settledPatch = () => events.find((e) => e.kind === 'settled')?.patch || {};

  it('★ 拿到 txHash 但确认数不够 → chainSettled=false (老代码这里会是 true)', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'pending', confirmations: 0, confirmationsRequired: 1, reason: '确认数 0 < 1' });
    const r = await run({ verifier });
    expect(r.ok).toBe(true);
    expect(r.payment!.chainSettled).toBe(false);
    expect(r.payment!.chainSettlementStatus).toBe('pending');
    expect(settledPatch().chainSettled).toBe(false);
  });

  it('★ 确认数够 + 事件对得上 → chainSettled=true, 且事件 patch 带上判定与理由', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'confirmed', chainSettled: true, confirmations: 2, confirmationsRequired: 1, reason: 'receipt.status=1, 确认数 2 >= 1' });
    const r = await run({ verifier, expect: { kind: 'escrow', taskKey: TASK_KEY } });
    expect(r.payment!.chainSettled).toBe(true);
    expect(r.payment!.confirmations).toBe(2);
    const p = settledPatch();
    expect(p.chainSettled).toBe(true);
    expect(p.chainSettlementStatus).toBe('confirmed');
    expect(String(p.chainSettlementReason)).toContain('确认数');
  });

  it('★ 验证器说 RPC 读不到 → chainSettled=false + settlementUncertain=true (不确定 ≠ 失败)', async () => {
    const verifier: ChainSettlementVerifier = async () => verdict({ status: 'unknown', rpcAvailable: false, reason: '读 receipt 失败' });
    const r = await run({ verifier });
    expect(r.payment!.chainSettled).toBe(false);
    expect(r.payment!.settlementUncertain).toBe(true);
    expect(r.payment!.rpcAvailable).toBe(false);
    expect(settledPatch().chainRpcAvailable).toBe(false);
  });

  it('facilitator 没给 txHash → 不调验证器, chainSettled=false', async () => {
    const spy = vi.fn(async () => verdict({ status: 'confirmed', chainSettled: true }));
    H.mode = 'noTxHash';
    try {
      const r = await run({ verifier: spy });
      expect(r.payment!.chainSettled).toBe(false);
      expect(r.payment!.chainSettlementStatus).toBe('not_attempted');
      expect(spy).not.toHaveBeenCalled();
    } finally { H.mode = 'withTxHash'; }
  });

  it('★ 拿到的 txHash 必须原样交给验证器 (不是"有 hash 就算数")', async () => {
    const seen: string[] = [];
    const verifier: ChainSettlementVerifier = async (req) => {
      seen.push(String(req.txHash));
      return verdict({ status: 'pending', confirmations: 0, confirmationsRequired: 1, reason: '不够' });
    };
    const r = await run({ verifier });
    expect(seen).toEqual([TXH]);
    expect(r.payment!.txHash).toBe(TXH);
    expect(r.payment!.chainSettled).toBe(false);
  });

  it('★ 不传 chainSettlement 且链不可用 → 缺省验证器如实判未结算 (绝不冒报已结算)', async () => {
    // 指向一个必然连不通的 RPC: 缺省验证器会尝试真连 → 失败 → unknown
    process.env.BOLLOON_CHAIN_RPC_URL = 'http://127.0.0.1:1';
    process.env.BOLLOON_ESCROW_ADDRESS = ESCROW_ADDR;
    process.env.BOLLOON_CHAIN_ID = '31337';
    const r = await run(undefined);
    expect(r.ok).toBe(true);                       // 付款这一步没被链验证拖垮
    expect(r.payment!.chainSettled).toBe(false);   // 但绝不宣称链上已验证
    expect(['unknown', 'config_unavailable']).toContain(String(r.payment!.chainSettlementStatus));
    expect(String(r.payment!.chainSettlementReason)).toBeTruthy();
  });

  it('旧调用方签名兼容: 不传 chainSettlement 也能拿到结果 (不炸)', async () => {
    // ★ 定位 (2026-09-22, 这条原来是"确定性红"): 红的**不是实现, 是这条测试自己漏了前提**。
    //   它删掉 3 个 env 锚就默认"链配置三层都拿不到" —— 但第 ② 层正是
    //   `$HOME/.bolloon/chain.json` (chain-config.ts: bolloonHome() = home || process.env.HOME || os.homedir())。
    //   开发机上那份文件是有的 (rpcUrl=127.0.0.1:8545 + escrow + token, 2026-09-22 16:17 写的) →
    //   缺省验证器**建 client 成功** → 拿那个假 txHash 去 8545 查 → receipt 读不到 → status='unknown',
    //   而断言要的是 'config_unavailable'。
    //   实测依据: 完全同一份代码 `HOME=<空目录> npx vitest run <本文件>` → 15/15 全绿; 只差 HOME。
    //   ⇒ 所以改**前提**, 不放宽断言: 把 HOME 钉到一个新建的空目录 (再删掉其它链锚), 让"三层都拿不到"真成立。
    //     4 条断言一条没减, 并额外锁住"理由要点名链配置"—— 这条测试从此不依赖"这台机器恰好配了什么"。
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-f5-nohome-'));
    vi.stubEnv('HOME', emptyHome);
    for (const k of [
      'BOLLOON_CHAIN_RPC_URL', 'BOLLOON_ESCROW_ADDRESS', 'BOLLOON_CHAIN_ID',
      'BOLLOON_RPC_URL', 'RPC_URL', 'BOLLOON_NETWORK_NAME', 'BOLLOON_TOKEN_ADDRESS',
    ]) delete process.env[k];
    try {
      // 前提自证: 这个 HOME 下确实没有 chain.json (否则测的还是"环境巧合")
      expect(fs.existsSync(path.join(emptyHome, '.bolloon', 'chain.json'))).toBe(false);
      const r = await run(undefined);
      expect(r.ok).toBe(true);
      expect(r.payment!.mode).toBe('facilitator');
      expect(r.payment!.chainSettled).toBe(false);
      expect(r.payment!.chainSettlementStatus).toBe('config_unavailable');
      expect(String(r.payment!.chainSettlementReason)).toMatch(/链配置/);   // 理由必须是"配置取不到", 不是含糊的 unknown
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('local-dev 路径永远是 chainSettled=false (链上没动过钱)', async () => {
    const r = await buyInfo({
      url: 'http://x/info-1',
      allowLocalDev: true,
      fetchImpl: (async (url: any, init: any) => {
        if (!init?.headers) return new Response(JSON.stringify({ accepts: [{ scheme: 'exact', network: 'base-sepolia', amount: '1', payTo: '0x1' }] }), { status: 402, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      onEvent: async (e) => { events.push(e); },
    });
    expect(r.ok).toBe(true);
    expect(r.payment!.mode).toBe('local-dev');
    expect(settledPatch().chainSettled).toBe(false);
  });
});
