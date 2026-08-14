/**
 * payment-approval.test.ts — 2026-08-13
 *
 * 人工支付审批流程 (YAML 验证门 confirm → 人工批准/拒绝):
 *   - create 创建 pending 审批
 *   - approve 批准后执行 executor
 *   - reject 拒绝
 *   - expireStale 超时自动拒绝
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PaymentApprovalStore, setApprovalExecutor, resetApprovalStore } from '../agents/payment-approval.js';

const tmpFile = path.join(os.tmpdir(), 'bolloon-approval-' + Date.now(), 'approvals.json');

describe('payment-approval (人工支付审批)', () => {
  beforeEach(async () => {
    resetApprovalStore();
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it('create 创建 pending 审批', async () => {
    const store = new PaymentApprovalStore(tmpFile);
    const a = await store.create({ service: 'coding', amount: 0.5, recipient: '0xabc', reason: '中额需确认' });
    expect(a.status).toBe('pending');
    expect(a.service).toBe('coding');
    expect(a.amount).toBe(0.5);
    const pending = await store.pending();
    expect(pending.length).toBe(1);
  });

  it('approve 批准后执行 executor (executed)', async () => {
    let executed = false;
    setApprovalExecutor(async () => { executed = true; return { ok: true, result: '支付成功' }; });
    const store = new PaymentApprovalStore(tmpFile);
    const a = await store.create({ service: 'coding', amount: 0.5, recipient: '0xabc', reason: 'r' });
    const r = await store.approve(a.id);
    expect(r.ok).toBe(true);
    expect(executed).toBe(true);
    expect(r.approval?.status).toBe('executed');
  });

  it('approve 执行器失败 → failed', async () => {
    setApprovalExecutor(async () => ({ ok: false, error: '链上失败' }));
    const store = new PaymentApprovalStore(tmpFile);
    const a = await store.create({ service: 'coding', amount: 0.5, recipient: '0xabc', reason: 'r' });
    const r = await store.approve(a.id);
    expect(r.ok).toBe(false);
    expect(r.approval?.status).toBe('failed');
    expect(r.error).toContain('链上失败');
  });

  it('reject 拒绝', async () => {
    const store = new PaymentApprovalStore(tmpFile);
    const a = await store.create({ service: 'coding', amount: 0.5, recipient: '0xabc', reason: 'r' });
    const r = await store.reject(a.id);
    expect(r.ok).toBe(true);
    expect(r.approval?.status).toBe('rejected');
  });

  it('不可重复批准/拒绝', async () => {
    const store = new PaymentApprovalStore(tmpFile);
    const a = await store.create({ service: 'coding', amount: 0.5, recipient: '0xabc', reason: 'r' });
    await store.approve(a.id);
    const again = await store.approve(a.id);
    expect(again.ok).toBe(false);
  });

  it('expireStale 超时自动拒绝', async () => {
    const store = new PaymentApprovalStore(tmpFile);
    const a = await store.create({ service: 'coding', amount: 0.5, recipient: '0xabc', reason: 'r' });
    // 用极短超时 (1ms) 模拟过期
    await new Promise((r) => setTimeout(r, 5));
    const expired = await store.expireStale(1);
    expect(expired).toBe(1);
    const refreshed = await store.get(a.id);
    expect(refreshed?.status).toBe('rejected');
  });
});
