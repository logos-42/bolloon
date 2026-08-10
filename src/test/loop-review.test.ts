import { describe, it, expect } from 'vitest';
import {
  decideAfterReview,
  buildReviewHint,
  shouldReviewAgain,
  DEFAULT_MAX_REVIEWS,
} from '../agents/loop-review.js';
import type { ReviewState } from '../agents/loop-review.js';

function state(over: Partial<ReviewState> = {}): ReviewState {
  return {
    reviewsDone: 0,
    userIntent: '完成迁移模块',
    completedTools: ['read_file'],
    ...over,
  };
}

describe('loop-review (final 前目标对齐)', () => {
  it('默认最大 review 次数 = 2 (用户要求运行一两次)', () => {
    expect(DEFAULT_MAX_REVIEWS).toBe(2);
  });

  it('无用户需求也 review (final 前总是 LLM 自查, 规则只做上限兜底 — 2026-08-10)', () => {
    // 旧逻辑: 无 intent → 直接 finish (导致"发布 ipfs 网站"被误判 chitchat 后 1 次循环就结束)
    // 新逻辑: 结束权交给 LLM, 达上限才放行
    const d = decideAfterReview(state({ userIntent: '' }));
    expect(d.kind).toBe('continue-review');
    if (d.kind === 'continue-review') expect(d.hint).toContain('用户需求');
  });

  it('未达上限且有待对齐需求 → continue-review (续跑深挖)', () => {
    const r = decideAfterReview(state({ reviewsDone: 0 }));
    expect(r.kind).toBe('continue-review');
    if (r.kind === 'continue-review') {
      expect(r.reason).toContain('完成度自查');
      expect(r.hint).toContain('用户需求: 完成迁移模块');
      expect(r.hint).toContain('<final gen>');
    }
  });

  it('达上限 (2 次) 后 → finish (不无限续跑)', () => {
    const r = decideAfterReview(state({ reviewsDone: 2 }));
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') expect(r.reason).toBe('max-reviews-2');
  });

  it('每次续跑 reviewCount 递增后最终达到上限', () => {
    let reviewsDone = 0;
    const seq: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = decideAfterReview(state({ reviewsDone }));
      if (r.kind === 'continue-review') { reviewsDone++; seq.push('continue'); }
      else { seq.push('finish'); break; }
    }
    expect(reviewsDone).toBe(2);
    expect(seq).toEqual(['continue', 'continue', 'finish']);
  });

  it('shouldReviewAgain 布尔门一致', () => {
    expect(shouldReviewAgain(state({ reviewsDone: 0 }))).toBe(true);
    expect(shouldReviewAgain(state({ reviewsDone: 2, userIntent: 'x' }))).toBe(false);
    expect(shouldReviewAgain(state({ userIntent: '' }))).toBe(true); // 无需求也自查 (达上限才停)
  });

  it('completedTools 为空时 hint 说明尚未执行工具', () => {
    const h = buildReviewHint(state({ completedTools: [] }));
    expect(h).toContain('尚未执行工具');
  });

  it('hint 不引用已执行的重复动作 (提醒不再重复)', () => {
    const h = buildReviewHint(state({ completedTools: ['read_file'] }));
    expect(h).toContain('read_file');
    expect(h).toContain('不要重复');
  });

  it('actionLog 逐条注入 (带结果摘要, 供 LLM 对照目标核查)', () => {
    const h = buildReviewHint(state({
      completedTools: ['read_file', 'write_file'],
      actionLog: [
        { tool: 'read_file', argsPreview: '{path:"a.ts"}', resultPreview: '内容 abc', success: true },
        { tool: 'write_file', argsPreview: '{path:"b.ts"}', resultPreview: '写入成功', success: false },
      ],
    }));
    expect(h).toContain('本轮已执行动作 (逐条)');
    expect(h).toContain('read_file');
    expect(h).toContain('✓ 内容 abc');
    expect(h).toContain('write_file');
    expect(h).toContain('✗ 写入成功');
    expect(h).toContain('逐条对照「用户需求」');
  });
});