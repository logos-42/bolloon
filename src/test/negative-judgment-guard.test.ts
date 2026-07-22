/**
 * negative-judgment-guard.test.ts — 判断力负向回收单测 (2026-07-22 设计 B)
 *
 * 验证: injectNegativeGuard 筛选 (reject + active + high/critical stakes + 高置信) /
 *       排序 (critical 优先) / 避免清单格式化 / maxChars 截断 / 边界
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock human-value-store 的 loadAllJudgments (injectNegativeGuard 内部调用)
vi.mock('../pi-ecosystem-judgment/human-value-store.js', () => ({
  loadAllJudgments: vi.fn(),
  getRelevantValues: vi.fn(),
  findRecentSimilarDecisions: vi.fn(),
}));

import { injectNegativeGuard } from '../pi-ecosystem-judgment/injection-gate.js';
import { loadAllJudgments } from '../pi-ecosystem-judgment/human-value-store.js';

const mockedLoadAll = loadAllJudgments as unknown as ReturnType<typeof vi.fn>;

describe('injectNegativeGuard (判断力负向回收 → 避免清单)', () => {
  beforeEach(() => {
    mockedLoadAll.mockReset();
  });

  it('无 reject 类 → empty-negatives', async () => {
    mockedLoadAll.mockResolvedValue([
      { id: 'a', decision_type: 'approve', status: 'active', context: { stakes: 'high' }, metadata: { confidence: 0.9 }, decision: 'do X' },
    ]);
    const r = await injectNegativeGuard('test', {}, {});
    expect(r.didInject).toBe(false);
    expect(r.skipReason).toBe('empty-negatives');
  });

  it('reject + critical + 高置信 → 注入避免清单', async () => {
    mockedLoadAll.mockResolvedValue([
      { id: 'n1', decision_type: 'reject', status: 'active', context: { stakes: 'critical' }, metadata: { confidence: 0.9 }, decision: '不要在生产环境跑未测试的迁移' },
      { id: 'n2', decision_type: 'reject', status: 'active', context: { stakes: 'high' }, metadata: { confidence: 0.8 }, decision: '不要跳过 code review' },
    ]);
    const r = await injectNegativeGuard('test', {}, {});
    expect(r.didInject).toBe(true);
    expect(r.usedIds).toEqual(['n1', 'n2']);
    expect(r.systemAddition).toContain('避免清单');
    expect(r.systemAddition).toContain('不要在生产环境跑未测试的迁移');
    expect(r.systemAddition).toContain('source: injection-gate (negative)');
  });

  it('低置信 (<0.7) 被过滤', async () => {
    mockedLoadAll.mockResolvedValue([
      { id: 'n1', decision_type: 'reject', status: 'active', context: { stakes: 'high' }, metadata: { confidence: 0.5 }, decision: 'low conf reject' },
    ]);
    const r = await injectNegativeGuard('test', {}, {});
    expect(r.didInject).toBe(false);
    expect(r.skipReason).toBe('empty-negatives');
  });

  it('低 stakes (low/medium) 被过滤', async () => {
    mockedLoadAll.mockResolvedValue([
      { id: 'n1', decision_type: 'reject', status: 'active', context: { stakes: 'medium' }, metadata: { confidence: 0.9 }, decision: 'med stakes' },
    ]);
    const r = await injectNegativeGuard('test', {}, {});
    expect(r.didInject).toBe(false);
  });

  it('status=rejected 被过滤 (只注入 active 的否决, 已推翻的不重复注入)', async () => {
    mockedLoadAll.mockResolvedValue([
      { id: 'n1', decision_type: 'reject', status: 'rejected', context: { stakes: 'critical' }, metadata: { confidence: 0.9 }, decision: 'old reject' },
    ]);
    const r = await injectNegativeGuard('test', {}, {});
    expect(r.didInject).toBe(false);
  });

  it('critical 排序在 high 之前', async () => {
    mockedLoadAll.mockResolvedValue([
      { id: 'high1', decision_type: 'reject', status: 'active', context: { stakes: 'high' }, metadata: { confidence: 0.95 }, decision: 'high stakes' },
      { id: 'crit1', decision_type: 'reject', status: 'active', context: { stakes: 'critical' }, metadata: { confidence: 0.8 }, decision: 'critical stakes' },
    ]);
    const r = await injectNegativeGuard('test', {}, { topN: 2 });
    expect(r.usedIds[0]).toBe('crit1');
    expect(r.usedIds[1]).toBe('high1');
  });

  it('maxChars 截断生效', async () => {
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push({
        id: `n${i}`,
        decision_type: 'reject',
        status: 'active',
        context: { stakes: 'critical' },
        metadata: { confidence: 0.9 },
        decision: '避免'.repeat(50) + i,
      });
    }
    mockedLoadAll.mockResolvedValue(list);
    const r = await injectNegativeGuard('test', {}, { topN: 10, maxChars: 200 });
    expect(r.didInject).toBe(true);
    expect(r.systemAddition).toContain('截断');
  });

  it('空输入 → no-input', async () => {
    const r = await injectNegativeGuard('', {}, {});
    expect(r.didInject).toBe(false);
    expect(r.skipReason).toBe('no-input');
  });

  it('topN 限制生效', async () => {
    const list = [];
    for (let i = 0; i < 5; i++) {
      list.push({
        id: `n${i}`,
        decision_type: 'reject',
        status: 'active',
        context: { stakes: 'critical' },
        metadata: { confidence: 0.9 },
        decision: `avoid ${i}`,
      });
    }
    mockedLoadAll.mockResolvedValue(list);
    const r = await injectNegativeGuard('test', {}, { topN: 2 });
    expect(r.usedIds.length).toBe(2);
    expect(r.matchedCount).toBe(5); // 总匹配 5, 只取 top 2
  });
});
