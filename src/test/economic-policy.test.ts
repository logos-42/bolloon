/**
 * economic-policy.test.ts — 2026-08-13 (Phase E3)
 *
 * Policy Engine (支付授权安全核心):
 *   - 单笔上限 / 收款方白名单 / 服务白名单 / 日预算 / 速率限制
 *   - recordSpend 记录花费 (日预算冻结)
 *   - 新的一天重置
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalEconomicPolicy, resetEconomicPolicy } from '../agents/economic-policy.js';

const tmpFile = path.join(os.tmpdir(), 'bolloon-policy-' + Date.now(), 'policy.json');

describe('economic-policy (Policy Engine)', () => {
  beforeEach(async () => {
    resetEconomicPolicy();
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it('单笔超限拒绝', async () => {
    const p = new LocalEconomicPolicy(tmpFile);
    p.updateConfig({ perTransactionLimit: 1, dailyLimit: 10 });
    const d = await p.check({ payTo: '0xany', amount: 5, service: 'research' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('单笔超限');
  });

  it('收款方白名单拒绝', async () => {
    const p = new LocalEconomicPolicy(tmpFile);
    p.updateConfig({ allowedRecipients: ['0xgood'], dailyLimit: 10 });
    const d = await p.check({ payTo: '0xbad', amount: 0.5, service: 'research' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('收款方');
    const ok = await p.check({ payTo: '0xgood', amount: 0.5, service: 'research' });
    expect(ok.allowed).toBe(true);
  });

  it('服务白名单拒绝', async () => {
    const p = new LocalEconomicPolicy(tmpFile);
    p.updateConfig({ allowedServices: ['research'], dailyLimit: 10 });
    const d = await p.check({ payTo: '0xany', amount: 0.5, service: 'coding' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('服务');
  });

  it('日预算冻结 (recordSpend 累计)', async () => {
    const p = new LocalEconomicPolicy(tmpFile);
    p.updateConfig({ dailyLimit: 1, perTransactionLimit: 0.6 });
    await p.recordSpend(0.6);
    expect(await p.dailySpent()).toBe(0.6);
    const d = await p.check({ payTo: '0xany', amount: 0.6, service: 'x' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('日预算');
  });

  it('速率限制', async () => {
    const p = new LocalEconomicPolicy(tmpFile);
    p.updateConfig({ dailyLimit: 100, rateLimitPerMinute: 2 });
    expect((await p.check({ payTo: '0xany', amount: 0.1 })).allowed).toBe(true);
    await p.recordSpend(0.1);
    expect((await p.check({ payTo: '0xany', amount: 0.1 })).allowed).toBe(true);
    await p.recordSpend(0.1);
    const d = await p.check({ payTo: '0xany', amount: 0.1 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('速率');
  });

  it('持久化 (跨实例 daily spent)', async () => {
    const p1 = new LocalEconomicPolicy(tmpFile);
    await p1.load();
    p1.updateConfig({ dailyLimit: 10 });
    await p1.recordSpend(3);
    const p2 = new LocalEconomicPolicy(tmpFile);
    await p2.load();
    expect(await p2.dailySpent()).toBe(3);
  });
});
