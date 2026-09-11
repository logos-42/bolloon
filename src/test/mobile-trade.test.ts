/**
 * mobile-trade.test.ts — 手机端资源交易工作流 (E2 x402 闭环 / E3 Policy / E4 Reputation)
 *   全注入: fetchImpl / payFn / walletForAgent / policy / storage — 不依赖浏览器与网络.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  evaluatePolicy, quoteService, parse402,
  callService, settleAndRate, getReputationOf,
  appendTrade, listTrades, isReplayed,
  DEFAULT_TRADE_POLICY,
} from '../web/mobile-trade.js';
import type { TradePolicy, ServiceRef, TradeStorage } from '../web/mobile-trade.js';

function memStorage(): TradeStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

let storage: TradeStorage;

beforeEach(() => {
  storage = memStorage();
  (globalThis as any).localStorage = storage;
});

const POLICY: TradePolicy = { ...DEFAULT_TRADE_POLICY, perTransactionLimit: 1, dailyLimit: 10 };

const SERVICE: ServiceRef = {
  name: 'research',
  agentId: 'did:diap:provider',
  payTo: '0xProvider',
  price: { amount: '0.05', currency: 'USDC', per: 'query' },
  endpoint: 'http://desktop:8787/agent/service/call',
  reputation: 0.9,
};

/** 首次 → 402(price+wallet), 携带 X-Payment 重试 → 200 result */
function paywallFetch(calls: Array<{ url: any; init: any }>, onPaid?: (headers: any) => void) {
  return (async (url: any, init: any) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return {
        status: 402, ok: false,
        headers: { 'X-Payment-Amount': '0.05', 'X-Payment-Currency': 'USDC', 'X-Pay-To': '0xProvider', 'X-Payment-Network': 'base-sepolia' },
        json: async () => ({ error: 'Payment Required', payment: { amount: 0.05, currency: 'USDC', payTo: '0xProvider' } }),
      };
    }
    onPaid?.(init.headers);
    return { status: 200, ok: true, headers: {}, json: async () => ({ result: 'service-output' }) };
  }) as any;
}

// ============ E3: Policy Engine ============

describe('evaluatePolicy (E3 纯函数判定)', () => {
  const intent = { payTo: '0xProvider', amount: 0.05, currency: 'USDC', service: 'research', requestId: 'r1', reputation: 0.9 };

  it('限额内 + 白名单内 + 信誉足 → allow', () => {
    const v = evaluatePolicy(intent, { ...POLICY, allowedRecipients: ['0xProvider'], reputationThreshold: 0.5 }, { dailySpent: 0 });
    expect(v.decision).toBe('allow');
    expect(v.rule).toBe('allow');
  });

  it('超单笔限额 → deny (per_transaction_limit)', () => {
    const v = evaluatePolicy({ ...intent, amount: 5 }, POLICY, { dailySpent: 0 });
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('per_transaction_limit');
    expect(v.reason).toContain('单笔超限');
  });

  it('超日累计预算 → deny (daily_limit)', () => {
    const v = evaluatePolicy({ ...intent, amount: 1 }, POLICY, { dailySpent: 9.5 });
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('daily_limit');
    expect(v.reason).toContain('日累计超限');
  });

  it('收款方不在白名单 → deny (recipient_whitelist)', () => {
    const v = evaluatePolicy(intent, { ...POLICY, allowedRecipients: ['0xOnlyThis'] }, { dailySpent: 0 });
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('recipient_whitelist');
  });

  it('服务方信誉不足 → deny (reputation_threshold)', () => {
    const v = evaluatePolicy({ ...intent, reputation: 0.2 }, { ...POLICY, reputationThreshold: 0.6 }, { dailySpent: 0 });
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('reputation_threshold');
  });

  it('超过审批阈值 (软限) → confirm', () => {
    const v = evaluatePolicy({ ...intent, amount: 0.8 }, { ...POLICY, confirmAbove: 0.5 }, { dailySpent: 0 });
    expect(v.decision).toBe('confirm');
    expect(v.rule).toBe('confirm_above');
  });

  it('opts.requireApprovalAbove 覆盖 policy.confirmAbove', () => {
    const v = evaluatePolicy({ ...intent, amount: 0.8 }, { ...POLICY, confirmAbove: 5 }, { dailySpent: 0, requireApprovalAbove: 0.5 });
    expect(v.decision).toBe('confirm');
  });
});

// ============ E2: 报价 + 402 解析 ============

describe('quoteService / parse402', () => {
  it('合法价格 → 生成报价 (数量倍乘 + 指纹含 requestId/服务/金额/币种/ts)', () => {
    const q = quoteService(SERVICE, { requestId: 'req-x', quantity: 3 }, { now: () => 1000, rid: () => 'auto' });
    expect(q.ok).toBe(true);
    expect(q.amount).toBeCloseTo(0.15, 6);
    expect(q.requestId).toBe('req-x');
    expect(q.payTo).toBe('0xProvider');
    expect(q.fingerprint).toContain('req-x|research|0.15|USDC|1000');
  });

  it('价格结构非法 (amount 非数字) → ok:false', () => {
    const q = quoteService({ ...SERVICE, price: { amount: 'abc', currency: 'USDC' } }, {});
    expect(q.ok).toBe(false);
    expect(String(q.error)).toContain('价格结构非法');
  });

  it('缺收款钱包 → ok:false', () => {
    const q = quoteService({ ...SERVICE, payTo: '' }, {});
    expect(q.ok).toBe(false);
    expect(String(q.error)).toContain('payTo');
  });

  it('parse402 从 header 与 body.payment 都能解析', () => {
    const fromHeader = parse402({ headers: { 'X-Payment-Amount': '0.25', 'X-Payment-Currency': 'USDC', 'X-Pay-To': '0xP' } });
    expect(fromHeader).toEqual({ amount: 0.25, currency: 'USDC', payTo: '0xP', network: undefined });
    const fromBody = parse402({ headers: {} }, { payment: { amount: 1, currency: 'ETH', payTo: '0xQ' } });
    expect(fromBody?.amount).toBe(1);
    expect(fromBody?.currency).toBe('ETH');
    expect(parse402({ headers: {} }, { nothing: true })).toBeNull();
  });
});

// ============ E2: 402 → 支付 → 结果 闭环 ============

describe('callService (x402 闭环)', () => {
  it('402 → 支付 → 200: 完整闭环, 写入成功记录并携带支付凭据重试', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    let retryHeaders: any = null;
    const payFn = vi.fn(async () => ({ success: true, txHash: '0xtxhash' }));
    const r = await callService({
      service: SERVICE,
      request: { requestId: 'req-ok', buyer: 'did:diap:buyer' },
      deps: {
        fetchImpl: paywallFetch(calls, (h) => { retryHeaders = h; }),
        payFn, storage, policy: POLICY,
        walletForAgent: () => ({ exists: true, wallets: [{ id: 'w1', address: '0xBuyer', unlocked: true }] }),
      },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('success');
    expect(r.txHash).toBe('0xtxhash');
    expect(r.paid).toBeCloseTo(0.05, 6);
    expect((r.result as any).result).toBe('service-output');
    expect(payFn).toHaveBeenCalledTimes(1);
    expect(payFn.mock.calls[0][0]).toMatchObject({ amount: 0.05, currency: 'USDC', to: '0xProvider' });
    expect(calls.length).toBe(2);
    expect(retryHeaders['X-Payment']).toBe('0xtxhash');
    expect(listTrades(storage)[0].status).toBe('success');
    expect(listTrades(storage)[0].requestId).toBe('req-ok');
  });

  it('策略 confirm → 返回 needsApproval 且不支付', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    const payFn = vi.fn(async () => ({ success: true, txHash: '0xnever' }));
    const r = await callService({
      service: SERVICE,
      request: { requestId: 'req-confirm' },
      deps: { fetchImpl: paywallFetch(calls), payFn, storage, policy: { ...POLICY, confirmAbove: 0.01 } },
    });
    expect(r.ok).toBe(false);
    expect(r.needsApproval).toBe(true);
    expect(r.status).toBe('pending_approval');
    expect(payFn).not.toHaveBeenCalled();
    expect(calls.length).toBe(0); // 策略拦截在发起请求之前
    expect(listTrades(storage)[0].status).toBe('pending_approval');
  });

  it('策略 deny (超单笔) → 返回 denied 且不支付', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    const payFn = vi.fn(async () => ({ success: true, txHash: '0xnever' }));
    const r = await callService({
      service: { ...SERVICE, price: { amount: '9', currency: 'USDC' } },
      request: { requestId: 'req-deny' },
      deps: { fetchImpl: paywallFetch(calls), payFn, storage, policy: POLICY },
    });
    expect(r.denied).toBe(true);
    expect(r.status).toBe('denied');
    expect(payFn).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
    expect(listTrades(storage)[0].status).toBe('denied');
  });

  it('支付失败 → 不写成功记录, 记录 failed 且无 txHash', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    const r = await callService({
      service: SERVICE,
      request: { requestId: 'req-payfail' },
      deps: {
        fetchImpl: paywallFetch(calls),
        payFn: async () => ({ success: false, error: '余额不足' }),
        storage, policy: POLICY,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
    expect(String(r.error)).toContain('余额不足');
    const trades = listTrades(storage);
    expect(trades.some((t) => t.status === 'success')).toBe(false);
    expect(trades[0].status).toBe('failed');
    expect(trades[0].txHash).toBeUndefined();
    expect(calls.length).toBe(1); // 支付失败不重试
  });

  it('重放: 相同 requestId 再次调用 → 被拒且不支付', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    const payFn = vi.fn(async () => ({ success: true, txHash: '0xtx' }));
    const deps = { fetchImpl: paywallFetch(calls), payFn, storage, policy: POLICY };
    const first = await callService({ service: SERVICE, request: { requestId: 'req-replay' }, deps });
    expect(first.ok).toBe(true);
    const second = await callService({ service: SERVICE, request: { requestId: 'req-replay' }, deps });
    expect(second.replayed).toBe(true);
    expect(second.status).toBe('replayed');
    expect(second.ok).toBe(false);
    expect(payFn).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(2); // 仅第一次闭环产生 2 次请求
    expect(isReplayed('req-replay', storage)).toBe(true);
    expect(isReplayed('req-fresh', storage)).toBe(false);
  });

  it('402 价格被抬高 (与报价不符) → deny, 不支付', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    const tampered = (async (url: any, init: any) => {
      calls.push({ url, init });
      return { status: 402, ok: false, headers: { 'X-Payment-Amount': '0.5', 'X-Payment-Currency': 'USDC', 'X-Pay-To': '0xProvider' }, json: async () => ({}) };
    }) as any;
    const payFn = vi.fn(async () => ({ success: true, txHash: '0xnever' }));
    const r = await callService({ service: SERVICE, request: { requestId: 'req-tamper' }, deps: { fetchImpl: tampered, payFn, storage, policy: POLICY } });
    expect(r.denied).toBe(true);
    expect(String(r.reason)).toContain('价格与报价不符');
    expect(payFn).not.toHaveBeenCalled();
  });

  it('未授权钱包 (无 payFn) → 明确报错', async () => {
    const r = await callService({
      service: SERVICE,
      request: { requestId: 'req-nowallet', buyer: 'did:diap:buyer' },
      deps: { storage, policy: POLICY, walletForAgent: () => ({ exists: false, wallets: [] }) },
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('未被授权');
  });
});

// ============ E4: Reputation ============

describe('settleAndRate (E4)', () => {
  it('tasks 累加 + score = success/tasks (success/failed/disputed)', async () => {
    const repStore = (() => {
      const m = new Map<string, any>();
      return { get: (k: string) => m.get(k) || { tasks: 0, success: 0, failed: 0, disputed: 0, score: 0 }, set: (k: string, v: any) => { m.set(k, v); } };
    })();
    const deps = { reputationStore: repStore, storage };
    const a = await settleAndRate({ ok: true, service: SERVICE, deps });
    expect(a.reputation.tasks).toBe(1);
    expect(a.score).toBe(1);
    const b = await settleAndRate({ ok: true, service: SERVICE, deps });
    expect(b.reputation.tasks).toBe(2);
    expect(b.reputation.success).toBe(2);
    expect(b.score).toBe(1);
    const c = await settleAndRate({ ok: false, service: SERVICE, deps });
    expect(c.reputation.tasks).toBe(3);
    expect(c.reputation.failed).toBe(1);
    expect(c.score).toBe(0.67);
    const d = await settleAndRate({ ok: 'disputed', service: SERVICE, deps });
    expect(d.reputation.disputed).toBe(1);
    expect(d.reputation.tasks).toBe(4);
    expect(d.score).toBe(0.5);
    // 信誉库可读回
    const q = await getReputationOf(SERVICE, deps);
    expect(q.tasks).toBe(4);
    expect(q.score).toBe(0.5);
  });

  it('无法定位服务方 → ok:false', async () => {
    const r = await settleAndRate({ ok: true, service: { name: '' }, deps: { reputationStore: { get: () => ({ tasks: 0, success: 0, failed: 0, disputed: 0, score: 0 }), set: () => {} } } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('无法定位');
  });
});

// ============ 交易记录存取 ============

describe('appendTrade / listTrades', () => {
  it('listTrades 倒序 (ts 大者在前), 字段齐全', () => {
    appendTrade({ requestId: 't1', service: 'a', amount: 0.1, currency: 'USDC', status: 'success', ts: 100, txHash: '0x1' }, storage);
    appendTrade({ requestId: 't2', service: 'b', amount: 0.2, currency: 'USDC', status: 'failed', ts: 300 }, storage);
    appendTrade({ requestId: 't3', service: 'c', amount: 0.3, currency: 'USDC', status: 'denied', ts: 200 }, storage);
    const list = listTrades(storage);
    expect(list.map((t) => t.requestId)).toEqual(['t2', 't3', 't1']);
    expect(list[0]).toMatchObject({ service: 'b', amount: 0.2, currency: 'USDC', status: 'failed', ts: 300 });
    expect(listTrades(storage, { limit: 2 }).map((t) => t.requestId)).toEqual(['t2', 't3']);
    expect(listTrades()[0].requestId).toBe('t2');
  });

  it('相同 ts 时后写入的在前 (稳定倒序)', () => {
    appendTrade({ requestId: 'old', service: 'a', amount: 0, currency: 'USDC', status: 'success', ts: 500 }, storage);
    appendTrade({ requestId: 'new', service: 'a', amount: 0, currency: 'USDC', status: 'success', ts: 500 }, storage);
    expect(listTrades(storage).map((t) => t.requestId)).toEqual(['new', 'old']);
  });
});
