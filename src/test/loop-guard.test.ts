import { describe, it, expect } from 'vitest';
import {
  detectRepeatingCalls,
  toolCallArgsHash,
  buildReviewHint,
} from '../agents/loop-review.js';

describe('循环工作流检测 (Hermes wedged-loop 思想: 有活动无进展)', () => {
  it('连续 3 次相同工具+参数 → 判循环', () => {
    const recent = [
      { name: 'read_document', argsHash: 'a' },
      { name: 'read_document', argsHash: 'a' },
      { name: 'read_document', argsHash: 'a' },
    ];
    expect(detectRepeatingCalls(recent)).toEqual({ repeating: true, name: 'read_document' });
  });

  it('不足 3 次 / 参数不同 / 工具不同 → 不判循环', () => {
    expect(detectRepeatingCalls([{ name: 'x', argsHash: 'a' }])).toEqual({ repeating: false });
    expect(detectRepeatingCalls([
      { name: 'x', argsHash: 'a' },
      { name: 'x', argsHash: 'a' },
      { name: 'x', argsHash: 'b' },
    ])).toEqual({ repeating: false });
    expect(detectRepeatingCalls([
      { name: 'x', argsHash: 'a' },
      { name: 'y', argsHash: 'a' },
      { name: 'x', argsHash: 'a' },
    ])).toEqual({ repeating: false });
  });

  it('只取最近 window 条 (窗口滚动)', () => {
    const recent = [
      { name: 'x', argsHash: 'old' },
      { name: 'r', argsHash: 'a' },
      { name: 'r', argsHash: 'a' },
      { name: 'r', argsHash: 'a' },
    ];
    expect(detectRepeatingCalls(recent)).toEqual({ repeating: true, name: 'r' });
  });

  it('参数稳定哈希: 键顺序无关', () => {
    expect(toolCallArgsHash({ a: 1, b: 2 })).toBe(toolCallArgsHash({ b: 2, a: 1 }));
    expect(toolCallArgsHash({ a: 1 })).not.toBe(toolCallArgsHash({ a: 2 }));
    expect(toolCallArgsHash(undefined)).toBe(toolCallArgsHash({}));
  });
});

describe('完成契约 (Hermes completion contract: 宣布完成必须展示证据)', () => {
  it('review 提示包含证据要求', () => {
    const hint = buildReviewHint({ reviewsDone: 0, userIntent: '写个测试', completedTools: ['terminal'] });
    expect(hint).toContain('完成契约');
    expect(hint).toContain('具体证据');
    expect(hint).toContain('只写结论不算完成');
  });

  it('行动日志逐条列出', () => {
    const hint = buildReviewHint({
      reviewsDone: 0,
      userIntent: 'x',
      completedTools: ['t1'],
      actionLog: [
        { tool: 't1', argsPreview: '--a', resultPreview: 'ok', success: true },
        { tool: 't2', argsPreview: '', resultPreview: 'failed', success: false },
      ],
    });
    expect(hint).toContain('1. t1(--a) → ✓ ok');
    expect(hint).toContain('2. t2 → ✗ failed');
  });
});
