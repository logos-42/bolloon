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
import { ruleFor, dispWidthSafe, RULE_CHAR_SAFE_WIDTH, defaultRuleChar } from '../cli/status-segments.js';

describe('ruleFor: 满宽实线 (政策 2026-10-01 变更)', () => {
  it('线长按**字符数**铺满这一行 (口径 = 1 列)', () => {
    for (const w of [20, 30, 80, 100, 110, 134, 200]) {
      const n = ruleFor(w).length;
      expect(n, `width=${w}`).toBeGreaterThanOrEqual(Math.max(2, w - 2));
      expect(n, `width=${w}`).toBeLessThanOrEqual(w);
    }
  });
  it('**已知取舍 (写清, 免得后人以为忘了)**: `─` 是 Ambiguous 字符 —— 在某些把它渲染成 2 列的终端上,'
    + ' 这种满宽线会超出终端宽并触发折行(底栏重复打印)。那种机器请设 BOLLOON_RULE_CHAR_WIDTH=2。', () => {
    expect(dispWidthSafe('─')).toBe(2); // 保守模型里它是 2 列 (这正是那类终端的口径)
    expect(process.env.BOLLOON_RULE_CHAR_WIDTH).toBeUndefined(); // 默认不启用保守口径
  });

it('**满宽实线** (用户 2026-10-01: 「输入框宽度变窄了」+「我不要这样的虚线」)', () => {
    expect(defaultRuleChar()).toBe('─'); // 默认就是要好看的那个
    for (const w of [40, 80, 110, 134]) {
      // 按 1 列口径算 ⇒ 字符数正好铺满这一行
      expect(ruleFor(w).length).toBeGreaterThanOrEqual(w - 2);
      expect(ruleFor(w).length).toBeLessThanOrEqual(w);
    }
  });
  it('一键开关: BOLLOON_RULE_CHAR_WIDTH=2 ⇒ 退成半宽 (给"─ 是 2 列宽"的终端防折行)', () => {
    const saved = process.env.BOLLOON_RULE_CHAR_WIDTH;
    try {
      process.env.BOLLOON_RULE_CHAR_WIDTH = '2';
      expect(ruleFor(60).length).toBe(30);
    } finally {
      if (saved === undefined) delete process.env.BOLLOON_RULE_CHAR_WIDTH; else process.env.BOLLOON_RULE_CHAR_WIDTH = saved;
    }
  });
  it('**反例(归档)**: 老写法 `─`.repeat(W-1) 在"按 2 列渲染"的终端上**确实**会超宽 —— 这正是当初底栏重复打印的机理。'
    + ' 现在默认按 1 列算(用户要满宽实线), 所以这条只作为**机理记录**, 不再作为门禁判据。', () => {
    const W = 110;
    expect(dispWidthSafe('─'.repeat(W - 1))).toBeGreaterThan(W - 1); // 机理: 2 列口径下必然超宽
  });
});

describe('源码里不该再有硬算的分界线', () => {
  it('ink-app 里没有 `───.repeat(Math.max(10, W - 1))` 这种写法', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/cli/ink-app.tsx'), 'utf-8');
    const offenders = src.split('\n').filter((l) => l.includes("'─'.repeat(") && l.includes('W - 1'));
    expect(offenders, `还有 ${offenders.length} 处硬算: ${offenders.join(' | ')}`).toEqual([]);
  });
});
