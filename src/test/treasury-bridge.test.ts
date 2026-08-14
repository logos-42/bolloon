/**
 * treasury-bridge.test.ts — 2026-08-13
 *
 * Treasury 合约 × Agent 经济网络桥接:
 *   - treasuryPay 链下 Policy 校验 (拒绝/放行)
 *   - 未配置 RPC 时返回配置错误 (不真实上链)
 */
import { describe, it, expect } from 'vitest';
import { treasuryPay, treasuryStatus } from '../agents/treasury-bridge.js';

const cfg = {
  rpcUrl: 'https://sepolia.base.org',
  treasuryAddress: '0x' + '2'.repeat(40),
  tokenAddress: '0x' + '3'.repeat(40),
  privateKey: '0x' + '1'.repeat(64),
};

describe('treasury-bridge (Treasury × Agent 经济网络)', () => {
  it('policy 拒绝 → 不支付', async () => {
    const r = await treasuryPay(cfg, {
      agentAddress: '0x' + '4'.repeat(40),
      amount: 0.05,
      service: 'research',
      policyCheck: async () => ({ allowed: false, reason: '日预算超限' }),
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('日预算超限');
  });

  it('policy 放行 → 链上支付阶段 (dryRun, 不真实上链)', async () => {
    const r = await treasuryPay(cfg, {
      agentAddress: '0x' + '4'.repeat(40),
      amount: 0.05,
      service: 'research',
      policyCheck: async () => ({ allowed: true }),
      dryRun: true,
    });
    expect(r.checks?.policy?.allowed).toBe(true);
    expect(r.success).toBe(true);
    expect(r.txHash).toContain('dry-run');
  });

  it('treasuryStatus 未部署合约 → 返回错误', async () => {
    const s = await treasuryStatus(cfg);
    expect(s.ok).toBe(false);
  });
});
