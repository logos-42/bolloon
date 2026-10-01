/**
 * 一轮并行提醒 (2026-10-01, 用户: 「为什么这么慢」)。
 * 量到的事实: 每次 LLM 往返平均 3338ms(工具自身只占 4%), 而"一轮发多个工具"只占 12/63 ✗
 *   ⇒ 回合时长 ≈ 往返次数 × 3.3 秒 ✓。
 * 契约: 只对**只读**工具提醒(写类串行更安全) · 一轮多个工具时不提醒 · 带**代价数字**而不是空口号。
 */
import { describe, it, expect } from 'vitest';
import { batchHint } from '../agents/tool-loop-guard.js';

describe('一轮并行提醒', () => {
  it('只读工具 + 本轮只发一个 ⇒ 提醒, 且带代价数字', () => {
    const h = batchHint('grep_files', 1);
    expect(h).toContain('同一轮可以一次发多个工具');
    expect(h).toContain('3.3');
  });
  it('写类工具 ⇒ 不催(串行更安全)', () => {
    expect(batchHint('write_file', 1)).toBe('');
    expect(batchHint('edit_file', 1)).toBe('');
  });
  it('一轮已经发了多个 ⇒ 不必提醒', () => {
    expect(batchHint('grep_files', 3)).toBe('');
  });
});
