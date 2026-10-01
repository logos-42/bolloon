/**
 * 底栏分界线不许超宽 (2026-10-01, 用户实测: 底栏整块被重复打印 4 次)。
 *
 * 根因: 分界线写成 `'─'.repeat(W - 1)` —— `─`(U+2500) 的 East Asian Width 是 **Ambiguous**:
 *   按 1 列算应该正好 W-1 个, 但很多终端按 **2 列**渲染 ⇒ 整行 2×(W-1) 列 ⇒ 超出终端宽
 *   ⇒ 终端自动折行 ⇒ Ink 光标数学错乱 ⇒ 整块反复重打 ✗。
 * 规矩: 按**保守宽度**(Ambiguous 当 2 列)算字符数; 宁可线短, 绝不超宽。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ruleFor, dispWidthSafe, RULE_CHAR_SAFE_WIDTH } from '../cli/status-segments.js';

describe('ruleFor: 保守宽度下绝不超宽', () => {
  it('各种终端宽下, 画线的保守宽度都 <= 给定宽度', () => {
    for (const w of [20, 30, 80, 100, 110, 134, 200]) {
      const line = ruleFor(w);
      expect(dispWidthSafe(line), `width=${w} 超了`).toBeLessThanOrEqual(w);
      expect(line.length, `width=${w} 太短`).toBeGreaterThanOrEqual(2);
    }
  });
  it('画线字符本身被当成 2 列 (这就是当初的坑)', () => {
    expect(RULE_CHAR_SAFE_WIDTH).toBe(2);
  });
  it('**反例**: 老写法「─.repeat(W-1)」在这个宽度模型下必然超宽 (证明判据抓得住回归)', () => {
    const W = 110;
    const old = '─'.repeat(Math.max(10, W - 1));
    expect(dispWidthSafe(old)).toBeGreaterThan(W - 1);
    expect(dispWidthSafe(ruleFor(W - 1))).toBeLessThanOrEqual(W - 1);
  });
});

describe('源码里不该再有硬算的分界线', () => {
  it('ink-app 里没有 `───.repeat(Math.max(10, W - 1))` 这种写法', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/cli/ink-app.tsx'), 'utf-8');
    const offenders = src.split('\n').filter((l) => l.includes("'─'.repeat(") && l.includes('W - 1'));
    expect(offenders, `还有 ${offenders.length} 处硬算: ${offenders.join(' | ')}`).toEqual([]);
  });
});
