/**
 * 思考记录显示 (2026-10-01 用户: 「思考的记录可以也显示出来吗」)。
 * 性质: 默认开 + 可一键关 + 有界 + 空内容不显示 + 与正文区分(调用方加标题)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { shouldShowReasoning, normalizeReasoning, formatReasoningForDisplay } from '../cli/reasoning-view.js';

describe('开关 (默认开, 可关)', () => {
  it('默认开; 0/false/off/no 关; 其他都算开', () => {
    expect(shouldShowReasoning({} as any)).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) expect(shouldShowReasoning({ BOLLOON_SHOW_THINKING: v } as any), v).toBe(false);
    for (const v of ['1', 'true', 'on', 'yes']) expect(shouldShowReasoning({ BOLLOON_SHOW_THINKING: v } as any), v).toBe(true);
  });
  it('关掉时 format 返回空串 (调用方据此不渲染)', () => {
    expect(formatReasoningForDisplay('想了很久', { enabled: false })).toBe('');
  });
});

describe('有界 + 空内容', () => {
  it('空/空白 ⇒ 空串 (不显示空框)', () => {
    expect(formatReasoningForDisplay('')).toBe('');
    expect(formatReasoningForDisplay('   \n\n  ')).toBe('');
  });
  it('超行数/超字符都截断并标出', () => {
    const many = Array.from({ length: 30 }, (_, i) => `第${i}行`).join('\n');
    const out = formatReasoningForDisplay(many, { maxLines: 5 });
    expect(out.split('\n').length).toBeLessThanOrEqual(6);
    expect(out).toContain('思考已截断');
    const long = 'x'.repeat(5000);
    expect(formatReasoningForDisplay(long, { maxChars: 100 }).length).toBeLessThanOrEqual(120);
  });
  it('归一化: 连续空行压成一个, 去掉行尾空白', () => {
    expect(normalizeReasoning('a  \n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('挂点存在 (源级核对: 别再只存不显示)', () => {
  it('pi-ai 把 reasoning 往上传 + CLI 侧渲染它', () => {
    const ai = fs.readFileSync(path.join(process.cwd(), 'src/llm/pi-ai.ts'), 'utf-8');
    expect(ai).toContain('reasoningContent');
    const cli = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
    expect(cli).toContain('formatReasoningForDisplay');
  });
});
