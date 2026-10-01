/**
 * 底栏不许超宽 (2026-10-01, 修"整个底栏被重复打印")。
 *
 * 症状 (用户屏): 同一条状态栏 + 输入提示 + 分界线在屏上出现三份, 只有计时在变。
 * 根因: 底栏里用了 East Asian Width = **Ambiguous(A)** 的字符 (· ↑ ◎ ≈ │ — ─ …), 在部分终端/字体下
 *   占 2 列, 而我们按 1 列算 ⇒ 整行超宽 1–2 列 ⇒ 终端自动折行 ⇒ Ink 的光标数学被打乱 ⇒ 整块底栏重打。
 *   (也解释了"偶尔": ◎ 要有缓存命中数、↑ 要有 t/s 才出现)
 * 口径: 底栏一律用 **保守测宽** dispWidthSafe (这些字符按 2 列算) ⇒ 宁可短一列, 绝不超宽。
 */
import { describe, it, expect } from 'vitest';
import { dispWidthSafe, fitSegments, rightAlignPad } from '../cli/status-segments.js';

describe('保守测宽 (dispWidthSafe)', () => {
  it('Ambiguous 字符按 2 列算 (这就是防折行的关键)', () => {
    expect(dispWidthSafe('·')).toBe(2);
    expect(dispWidthSafe('↑')).toBe(2);
    expect(dispWidthSafe('◎')).toBe(2);
    expect(dispWidthSafe('≈')).toBe(2);
    expect(dispWidthSafe('│')).toBe(2);
    expect(dispWidthSafe('─')).toBe(2);
  });

  it('中日韩等真宽字符仍算 2, ASCII 仍算 1', () => {
    expect(dispWidthSafe('中文')).toBe(4);
    expect(dispWidthSafe('abc')).toBe(3);
    expect(dispWidthSafe('a中')).toBe(3);
  });

  it('真实状态栏样例: 保守宽度必须 <= 终端宽 - 1 (那才是"绝不折行"的判据)', () => {
    const width = 110;
    const left = 'deepseek-flash v0.5.4  │ 智能体 (ch:ch_1785668) │ ⏱ 7m 46s │ 0/1M │ [░░░░░░░░░░] 0.00% │ ✓ 7.5s │ ↑ ≈23 t/s │ ◎ 89.2% │ ⚙ 0';
    const title = '询问 AI 身份并了解小红';
    for (const [l, t] of [[left, title], [left, ''], [left.slice(0, 40), title]] as const) {
      const used = dispWidthSafe(l);
      const pad = rightAlignPad(used, dispWidthSafe(t), width);
      const total = pad === null ? used : used + pad + dispWidthSafe(t);
      expect(total, `这行在 ${width} 列终端里超了: ${total}`).toBeLessThanOrEqual(width - 1);
    }
  });

  it('fitSegments 支持注入保守测宽 ⇒ 取舍结果一定放得下', () => {
    const segs = ['⏱ 7m 46s', '0/1M', '[░░░░░░░░░░] 0.00%', '✓ 7.5s', '↑ ≈23 t/s', '◎ 89.2%', '⚙ 0'];
    const avail = 60;
    const kept = fitSegments(segs, avail, dispWidthSafe);
    const total = kept.reduce((n, x) => n + dispWidthSafe(x) + 3, 0);
    expect(total).toBeLessThanOrEqual(avail);
  });
});
