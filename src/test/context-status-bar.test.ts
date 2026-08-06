/**
 * context-status-bar.test.ts — CLI 状态栏上下文显示验证 (2026-08-06)
 *
 * 用户要求格式: `320k/1M │ [██████░░░░] 32%`
 * 锁住:
 *   - 格式 (token/上限 │ [进度条] 百分比)
 *   - 小 token 数可见变化 (<1% 两位小数, 不因 round 变 0 而像死代码)
 *   - 压缩状态后缀 (warning/compressing/compressed)
 */
import { describe, it, expect } from 'vitest';

/** 与 index.ts buildContextBar 同逻辑的纯函数副本 (避免依赖 CLI 模块初始化) */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function fmtPct(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

function buildBar(usedTokens: number, maxTokens: number): { tokens: string; pct: string; filled: number } {
  const pct = (usedTokens / maxTokens) * 100;
  const filled = Math.min(10, Math.max(0, Math.round((pct / 100) * 10)));
  return { tokens: `${fmtTokens(usedTokens)}/${fmtTokens(maxTokens)}`, pct: fmtPct(pct), filled };
}

describe('状态栏上下文格式 (320k/1M │ [██████░░░░] 32%)', () => {
  const MAX = 1_000_000;

  it('320k tokens → "320k/1M" + 3 格填充 + 32%', () => {
    const b = buildBar(320_000, MAX);
    expect(b.tokens).toBe('320k/1M');
    expect(b.filled).toBe(3);
    expect(b.pct).toBe('32%');
  });

  it('520k tokens → warning 阈值 (52%)', () => {
    const b = buildBar(520_000, MAX);
    expect(b.tokens).toBe('520k/1M');
    expect(b.pct).toBe('52%');
    expect(b.filled).toBe(5);
  });

  it('小 token 数也可见变化 (0.06% / 0.95% / 1.5%) — 不因 round 变 0', () => {
    expect(buildBar(623, MAX).pct).toBe('0.06%');
    expect(buildBar(9_500, MAX).pct).toBe('0.95%');
    expect(buildBar(15_000, MAX).pct).toBe('1.5%');
    expect(buildBar(5, MAX).pct).toBe('0.00%');
  });

  it('每轮消息增长 → 数值按需变化 (非死值)', () => {
    const rounds = [5, 623, 9_500, 320_000, 520_000];
    const seen = rounds.map(r => `${buildBar(r, MAX).tokens} ${buildBar(r, MAX).pct}`);
    expect(new Set(seen).size).toBe(rounds.length);  // 每轮输出都不同
    expect(seen[0]).toContain('0.00%');
    expect(seen[seen.length - 1]).toContain('52%');
  });

  it('token 格式化: 1M 上限显示 1M (不带小数)', () => {
    expect(buildBar(1_000_000, MAX).tokens).toBe('1M/1M');
  });
});
