/**
 * unreported-escape.test.ts — 2026-08-10: unreported 循环逃生门
 *
 * 背景: LLM 成功执行工具后想 <final gen> 但不把结果写进回复 → 循环注入 hint 让其继续总结.
 *   旧逻辑无上限 (MAX_REACT_ITERATIONS=10000) → 用户实测 11 次 "🔄 还有 1 个工具结果未汇报" 死循环.
 *   修复: decideUnreported 纯函数 — 未达上限 (默认 3) 再提示一次, 超限强制收尾.
 */
import { describe, it, expect } from 'vitest';
import { decideUnreported } from '../agents/pi-sdk.js';

describe('decideUnreported (逃生门)', () => {
  it('无积压 → none (不干预)', () => {
    expect(decideUnreported(0, 0, 3)).toBe('none');
    expect(decideUnreported(0, 5, 3)).toBe('none');
  });

  it('有积压且未达上限 → retry (再提示一次)', () => {
    expect(decideUnreported(1, 0, 3)).toBe('retry');
    expect(decideUnreported(2, 2, 3)).toBe('retry');
  });

  it('有积压且达上限 → force-final (强制收尾, 防死循环)', () => {
    expect(decideUnreported(1, 3, 3)).toBe('force-final');
    expect(decideUnreported(5, 3, 3)).toBe('force-final');
    expect(decideUnreported(1, 10, 3)).toBe('force-final');
  });

  it('上限可配 (max=1 → 第一次 retry, 第二次强制)', () => {
    expect(decideUnreported(1, 0, 1)).toBe('retry');
    expect(decideUnreported(1, 1, 1)).toBe('force-final');
  });
});
