/**
 * K4 内核控制面 (RunControl) 门 —— 真跑语义 + 台账一致性。
 *
 * 为什么单独一条真跑: 控制面是"channel 只提交请求、内核执行写"这条口径的**唯一落点**;
 * 它的拒收/派发/审计三件事只要错一件, 上游那几条越权欠账就会以"换个地方写"的形式复活。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  RUN_CONTROL_KINDS,
  RUN_CONTROL_REQUIRED,
  resetRunControlAudit,
  runControlAudit,
  submitRunControl,
} from '../kernel/control.js';
import { AUTHORITY_DEBT, AUTHORITY_DEBT_FROZEN_AT } from '../kernel/roster.js';

describe('K4 内核控制面 (RunControl) —— 真跑', () => {
  beforeEach(() => resetRunControlAudit());

  it('派发: record-recovery 走注入的 port, 并记审计', async () => {
    const seen: any[] = [];
    const out = await submitRunControl(
      { kind: 'record-recovery', origin: 'web', runId: 'run-1', payload: { action: 'resume' } },
      { recordRecovery: async (id, info) => { seen.push([id, info]); } },
    );
    expect(out.ok).toBe(true);
    expect(out.port).toBe('recordRecovery');
    expect(out.via).toBe('kernel-control');
    expect(seen).toEqual([['run-1', { action: 'resume' }]]);
    expect(runControlAudit()).toHaveLength(1);
    expect(runControlAudit()[0]).toMatchObject({ kind: 'record-recovery', origin: 'web', target: 'run-1', ok: true });
  });

  it('派发: set-run-status / wake-goal 各走自己的 port', async () => {
    const calls: string[] = [];
    const ports = {
      setRunStatus: async (id: string, st: string) => { calls.push(`run:${id}:${st}`); },
      setContinuation: async (id: string, p: any) => { calls.push(`goal:${id}:${p?.wakeReason}`); },
    };
    const a = await submitRunControl({ kind: 'set-run-status', origin: 'web', runId: 'r2', payload: { status: 'running' } }, ports);
    const b = await submitRunControl({ kind: 'wake-goal', origin: 'cli', goalId: 'g1', payload: { wakeReason: 'active' } }, ports);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(calls).toEqual(['run:r2:running', 'goal:g1:active']);
    expect(runControlAudit().map((e) => e.target)).toEqual(['r2', 'g1']);
  });

  it('拒收: 未知类型 / 匿名 / 缺定位字段 / 缺 port / port 抛错 —— 一律返回 ok=false, 不抛', async () => {
    const ports = { recordRecovery: async () => {} };
    const bad: any[] = [
      [{ kind: 'nope', origin: 'web', runId: 'r' }, ports],
      [{ kind: 'record-recovery', origin: '', runId: 'r' }, ports],
      [{ kind: 'record-recovery', origin: 'web' }, ports],                       // 缺 runId
      [{ kind: 'wake-goal', origin: 'web' }, ports],                            // 缺 goalId
      [{ kind: 'set-run-status', origin: 'web', runId: 'r', payload: {} }, ports], // 缺 status
      [{ kind: 'record-recovery', origin: 'web', runId: 'r' }, {}],              // port 未注入
    ];
    for (const [req, p] of bad) {
      const out = await submitRunControl(req, p as any);
      expect(out.ok, JSON.stringify(req)).toBe(false);
      expect(out.detail, JSON.stringify(req)).toBeTruthy();
    }
    const threw = await submitRunControl({ kind: 'record-recovery', origin: 'web', runId: 'r' }, {
      recordRecovery: async () => { throw new Error('store 炸了'); },
    });
    expect(threw.ok).toBe(false);
    expect(threw.detail).toContain('store 炸了');
    // 全部六次都进了审计 (拒收也要留痕 —— 否则"谁被拒过"无从追)
    expect(runControlAudit().filter((e) => !e.ok)).toHaveLength(7);
  });

  it('台账↔代码一致: 每种 kind 都声明了必填定位字段, 且审计上限可控', () => {
    for (const k of RUN_CONTROL_KINDS) {
      expect(['runId', 'goalId']).toContain(RUN_CONTROL_REQUIRED[k]);
    }
    expect(RUN_CONTROL_KINDS).toHaveLength(3);
  });
});

describe('K4 控制面与欠账台账的关系', () => {
  it('recordRecovery 那条欠账已还清并**从台账删掉** (双向判据会自己证明 channel 侧 0 调用)', () => {
    expect(AUTHORITY_DEBT.some((d) => d.call === 'recordRecovery')).toBe(false);
  });

  it('欠账棘轮: 条数 ≤ 冻结值, 且冻结值已随还款下调', () => {
    expect(AUTHORITY_DEBT.length).toBeLessThanOrEqual(AUTHORITY_DEBT_FROZEN_AT);
    expect(AUTHORITY_DEBT_FROZEN_AT).toBe(2);   // 3 → 2 (recordRecovery 已还)
  });
});
