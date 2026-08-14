/**
 * econ-integration.test.ts — Polymarket × Agent 经济集成 (2026-08-13, Task C4)
 *
 * createOrderEcon: 带 Policy 回调检查的下单 (不真实下单, 验证策略门).
 * import 子包 src (constraint-runtime 独立 workspace, 根测试直接相对引用).
 */
import { describe, it, expect } from 'vitest';
import { createOrderEcon, POLYMARKET_CONTRACT_OVERVIEW } from '../constraint-runtime/src/tools/PolymarketSDK/econ-integration.js';

describe('Polymarket 经济集成 (createOrderEcon)', () => {
  const baseParams = {
    privateKey: '0x' + '1'.repeat(64),
    marketId: '0xcondition-id-test',
    side: 'BUY' as const,
    price: 0.5,
    size: 10,
  };

  it('policy 回调拒绝 → 不下单', async () => {
    const r = await createOrderEcon(baseParams, {
      policyCheck: async () => ({ allowed: false, reason: '日预算超限' }),
    });
    expect(r.success).toBe(false);
    expect(r.policy?.allowed).toBe(false);
    expect(r.policy?.reason).toContain('日预算超限');
  });

  it('policy 回调放行 → 下单 (mock createOrder) 并记录花费', async () => {
    let spent = 0;
    let ordered = false;
    const r = await createOrderEcon(baseParams, {
      policyCheck: async () => ({ allowed: true }),
      recordSpend: async (amt) => { spent += amt; },
      createOrderImpl: async () => { ordered = true; return { success: true, orderId: '0xorder1' }; },
    });
    expect(r.policy?.allowed).toBe(true);
    expect(spent).toBe(5); // 0.5 * 10
    expect(ordered).toBe(true);
    expect(r.order?.orderId).toBe('0xorder1');
  });

  it('maxSpendUsdc 超限 → 拒绝 (无 policy 回调时降级检查)', async () => {
    const r = await createOrderEcon(baseParams, { maxSpendUsdc: 1 });
    expect(r.success).toBe(false);
    expect(r.policy?.allowed).toBe(false);
  });

  it('合约架构摘要存在', () => {
    expect(POLYMARKET_CONTRACT_OVERVIEW).toContain('CTF');
    expect(POLYMARKET_CONTRACT_OVERVIEW).toContain('NegRisk');
    expect(POLYMARKET_CONTRACT_OVERVIEW).toContain('USDC');
  });
});
