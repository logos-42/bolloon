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
  /**
   * 2026-10-02 K4-B 迁移说明 (旧断言为什么变了, 以及"差量是什么"):
   *   旧断言查的是 pi-sdk 里**老 `runReActLoop`** 的三条接线:
   *     `decideMaxIterations(iterBudget.used, iterBudget.maxTotal)` · `isRefundableTool(toolCall.name)` · `this.iterBudget.refund()`。
   *   老 loop 已删除 (K4-B 合并两套 loop), 三条接线随之消失 ⇒ 断言迁移到**现在唯一的 loop**(pivot)的真机制上:
   *     pivot 的迭代上限来自**复杂度画像** (`effectiveConfig.maxIterations`) + token 预算, 由 `shouldContinue()` 判定。
   *   ⚠️ **行为差量 (如实记, 不是零差量)**: 老 loop 的"IterationBudget 净用量 + 批处理工具退还迭代"这套
   *     在 pivot 上没有等价物 —— CLI 从此按 pivot 的画像预算走, **不再有"用 execute_code 退还迭代"这条**。
   *     `src/agents/iteration-budget.ts` 模块**保留备查** (纯函数 + 有单测), 但目前**生产零消费**。
   */
  it('现在唯一的 loop (pivot) 用画像配置的迭代上限, 且老 loop 的退还接线确实已随它删除', () => {
    const pivot = fs.readFileSync(path.join(process.cwd(), 'src/agents/workflow-pivot-loop.ts'), 'utf-8');
    const sdk = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    expect(pivot).toContain('effectiveConfig.maxIterations');
    expect(pivot).toContain('shouldContinue(');
    expect(sdk).not.toContain('this.iterBudget.refund()');           // 老接线不许"复活"
    expect(sdk).not.toContain('decideMaxIterations(iterBudget.used'); // 同上
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
