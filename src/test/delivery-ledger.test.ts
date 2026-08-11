import { describe, it, expect } from 'vitest';
import { DeliveryLedger, WARN_THROTTLE_WINDOW_MS } from '../web/delivery-ledger.js';

describe('DeliveryLedger (Hermes gateway delivery_ledger 模式)', () => {
  it('三态 checkpoint: pending → attempting → delivered', () => {
    const ledger = new DeliveryLedger();
    const rec = ledger.register('c1');
    expect(rec.state).toBe('pending');
    ledger.markAttempting('c1');
    expect(ledger.get('c1')?.state).toBe('attempting');
    ledger.markDelivered('c1');
    expect(ledger.get('c1')?.state).toBe('delivered');
    expect(ledger.get('c1')?.consecutiveFailures).toBe(0);
    expect(ledger.get('c1')?.lastDeliveredAt).toBeGreaterThan(0);
  });

  it('失败: 状态 failed + 连败计数 + 错误摘要', () => {
    const ledger = new DeliveryLedger();
    ledger.markAttempting('c1');
    ledger.markFailed('c1', new Error('EPIPE'));
    const rec = ledger.get('c1')!;
    expect(rec.state).toBe('failed');
    expect(rec.consecutiveFailures).toBe(1);
    expect(rec.lastError).toContain('EPIPE');
    ledger.markFailed('c1', new Error('EPIPE'));
    expect(ledger.get('c1')?.consecutiveFailures).toBe(2);
  });

  it('成功清零连败 (Hermes: 成功 reset 计数)', () => {
    const ledger = new DeliveryLedger();
    ledger.markFailed('c1', new Error('x'));
    ledger.markFailed('c1', new Error('x'));
    ledger.markDelivered('c1');
    expect(ledger.get('c1')?.consecutiveFailures).toBe(0);
  });

  it('同类错误节流: 窗口内第二次 shouldWarn=false', () => {
    const ledger = new DeliveryLedger();
    expect(ledger.shouldWarn('delivery-fail', 'EPIPE on socket')).toBe(true);
    expect(ledger.shouldWarn('delivery-fail', 'EPIPE on socket')).toBe(false); // 节流
    // 不同错误详情 → 新教训
    expect(ledger.shouldWarn('delivery-fail', 'ETIMEDOUT on socket')).toBe(true);
  });

  it('sweepDead: 无活动超时 → dead', () => {
    const ledger = new DeliveryLedger();
    ledger.register('c1'); // 只有 createdAt (现在)
    // 人为把 createdAt 改成过去
    const rec = ledger.get('c1')!;
    (rec as any).createdAt = Date.now() - 400_000;
    const dead = ledger.sweepDead(300_000);
    expect(dead).toEqual(['c1']);
    expect(ledger.get('c1')?.state).toBe('dead');
    // 二次 sweep 不重复
    expect(ledger.sweepDead(300_000)).toEqual([]);
  });

  it('stats 汇总', () => {
    const ledger = new DeliveryLedger();
    ledger.markDelivered('a');
    ledger.markDelivered('b');
    ledger.markFailed('c', new Error('x'));
    const s = ledger.stats();
    expect(s.total).toBe(3);
    expect(s.delivered).toBe(2);
    expect(s.failed).toBe(1);
  });

  it('remove + clear', () => {
    const ledger = new DeliveryLedger();
    ledger.register('a');
    ledger.remove('a');
    expect(ledger.get('a')).toBeUndefined();
    ledger.register('b');
    ledger.clear();
    expect(ledger.stats().total).toBe(0);
  });
});
