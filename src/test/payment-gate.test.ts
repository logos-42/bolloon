/**
 * payment-gate.test.ts — 2026-08-13
 *
 * YAML 驱动的支付验证门 (不全部交给 AI):
 *   - 规则链: auto-research allow / 中额 confirm / 黑名单 deny
 *   - 硬限制: 超单笔/日限 deny
 *   - 默认兜底 confirm
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PaymentGate, resetPaymentGate, getPaymentGate } from '../agents/payment-gate.js';

const tmpDir = path.join(os.tmpdir(), 'bolloon-paygate-' + Date.now());
const policyPath = path.join(tmpDir, 'payment-policy.yaml');

const TEST_POLICY = `
default_action: confirm
default_reason: "未命中规则需人工确认"
limits:
  max_per_transaction: 1.0
  max_daily_total: 10.0
rules:
  - id: deny-gambling
    action: deny
    services: [gambling]
    reason: "禁止赌博"
  - id: auto-research
    action: allow
    services: [research, data]
    max_amount: 0.05
  - id: confirm-medium
    action: confirm
    max_amount: 1.0
`;

describe('payment-gate (YAML 支付验证门)', () => {
  beforeEach(async () => {
    resetPaymentGate();
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(policyPath, TEST_POLICY, 'utf-8');
  });

  it('auto-research: 小额研究服务自动放行', () => {
    const gate = new PaymentGate(policyPath);
    const v = gate.evaluate({ service: 'research', amount: 0.05 });
    expect(v.decision).toBe('allow');
    expect(v.ruleId).toBe('auto-research');
  });

  it('confirm-medium: 中额需人工确认', () => {
    const gate = new PaymentGate(policyPath);
    const v = gate.evaluate({ service: 'coding', amount: 0.5 });
    expect(v.decision).toBe('confirm');
    expect(v.requiresApproval).toBe(true);
  });

  it('deny-gambling: 黑名单服务拒绝', () => {
    const gate = new PaymentGate(policyPath);
    const v = gate.evaluate({ service: 'gambling', amount: 0.01 });
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('赌博');
  });

  it('硬限制: 单笔超限 deny (覆盖规则)', () => {
    const gate = new PaymentGate(policyPath);
    const v = gate.evaluate({ service: 'research', amount: 5 });
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('单笔超限');
  });

  it('默认兜底: 未知服务 confirm (未超限)', () => {
    const gate = new PaymentGate(policyPath);
    const v = gate.evaluate({ service: 'weird', amount: 0.5 });
    expect(v.decision).toBe('confirm');
  });

  it('isAllowed 快捷判断 (仅 allow 为 true)', () => {
    const gate = new PaymentGate(policyPath);
    expect(gate.isAllowed({ service: 'research', amount: 0.05 }).allowed).toBe(true);
    expect(gate.isAllowed({ service: 'coding', amount: 0.5 }).allowed).toBe(false);
  });
});
