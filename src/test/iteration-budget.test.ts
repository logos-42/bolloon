/**
 * 可退还的迭代预算 (2026-10-01 落实②: 奖励批处理, 压"一件小事花太多次工具调用")。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IterationBudget, REFUNDABLE_TOOLS, isRefundableTool, normalizeWarnRatio, shouldWarn, capsFromEnv } from '../agents/iteration-budget.js';

describe('IterationBudget', () => {
  it('consume 到顶就 false; remaining 归零', () => {
    const b = new IterationBudget(3);
    expect([b.consume(), b.consume(), b.consume()]).toEqual([true, true, true]);
    expect(b.consume()).toBe(false);
    expect(b.remaining).toBe(0);
    expect(b.depleted).toBe(true);
  });
  it('**refund 归还一次** (批处理工具换来的迭代不吃预算)', () => {
    const b = new IterationBudget(2);
    b.consume(); b.consume();
    expect(b.depleted).toBe(true);
    b.refund();
    expect(b.depleted).toBe(false);
    expect(b.consume()).toBe(true);
    expect(b.refunded).toBe(1);
    expect(b.describe()).toContain('退还 1 次');
  });
  it('refund 不会把 used 扣成负数', () => {
    const b = new IterationBudget(5);
    b.refund(); b.refund();
    expect(b.used).toBe(0);
  });
  it('非法 cap ⇒ 视作无限 (fail-open)', () => {
    const b = new IterationBudget(NaN);
    for (let i = 0; i < 10; i++) expect(b.consume()).toBe(true);
  });
});

describe('哪些工具值得退还', () => {
  it('execute_code 是 (一次能顶多次); 普通工具不是', () => {
    expect(isRefundableTool('execute_code')).toBe(true);
    expect(REFUNDABLE_TOOLS.has('execute_code')).toBe(true);
    for (const t of ['read_file', 'terminal', 'get_identity', '']) expect(isRefundableTool(t)).toBe(false);
  });
});

describe('警告比例 (fail-open: 坏值 = 关掉该功能, 不卡人)', () => {
  it('坏值 ⇒ null / 不警告', () => {
    for (const v of [0, 1, -0.5, 2, NaN, 'x', true, null]) {   // 注意: undefined 不算坏值(走默认 0.8)
      expect(normalizeWarnRatio(v)).toBeNull();
      expect(shouldWarn(9, 10, v as any)).toBe(false);
    }
  });
  it('undefined ⇒ 用默认 0.8 (9/10 该警告)', () => {
    expect(normalizeWarnRatio(undefined)).toBeNull();
    expect(shouldWarn(9, 10, undefined as any)).toBe(true);
    expect(shouldWarn(7, 10, undefined as any)).toBe(false);
  });
  it('80% ⇒ 从 8/10 起警告', () => {
    expect(shouldWarn(7, 10)).toBe(false);
    expect(shouldWarn(8, 10)).toBe(true);
    expect(new IterationBudget(10).warn()).toBe(false);
  });
});

describe('caps (env 可覆盖, 坏值回落默认)', () => {
  it('默认 500 / 50; env 覆盖生效; 坏值回落', () => {
    expect(capsFromEnv({} as any)).toEqual({ parent: 500, subagent: 50 });
    expect(capsFromEnv({ BOLLOON_MAX_ITERATIONS: '12' } as any).parent).toBe(12);
    expect(capsFromEnv({ BOLLOON_MAX_ITERATIONS: 'x' } as any).parent).toBe(500);
    expect(capsFromEnv({ BOLLOON_SUBAGENT_MAX_ITERATIONS: '0' } as any).subagent).toBe(50);
  });
});

describe('接线存在 (源级核对: 别只写模块忘了接)', () => {
  it('pi-sdk 的退出判定读**净**用量, 且批处理工具会退还', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    expect(src).toContain('decideMaxIterations(iterBudget.used, iterBudget.maxTotal)');
    expect(src).toContain('isRefundableTool(toolCall.name)');
    expect(src).toContain('this.iterBudget.refund()');
  });
});

describe('行为: 批处理确实延长有效寿命 (模拟一个只会用 execute_code 的 agent)', () => {
  it('cap=5: 不退还时第 6 次就停; 退还后还能继续跑', () => {
    // 不退还
    const a = new IterationBudget(5);
    let aRuns = 0;
    while (a.consume()) aRuns++;
    expect(aRuns).toBe(5);
    // 全用批处理工具 ⇒ 每次调用后退还
    const b = new IterationBudget(5);
    let bRuns = 0;
    for (let i = 0; i < 20; i++) {
      if (!b.consume()) break;
      bRuns++;
      if (isRefundableTool('execute_code')) b.refund();
    }
    expect(bRuns).toBe(20);      // 有效寿命被"批处理"换来了
    expect(b.used).toBe(0);
    expect(b.refunded).toBe(20);
  });
});
