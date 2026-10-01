/**
 * 工具描述合同 (2026-10-01, 用户: 「学习一下, 优化」)。
 *
 * 依据: 工具描述是模型的**唯一说明书** —— 描述错了, 行为就错(实测: 三句错话把"批量生成代码"逼成零碎调用)。
 * 对照运行时那套的做法: 它的 terminal 描述里**内联**一张对照表(grep/rg⇒search_files · cat/head/tail⇒read_file ·
 *   sed/awk⇒patch · find/ls⇒search_files · curl取正文⇒web_extract · echo>/heredoc⇒write_file),
 *   于是"终端习惯"永远被引流到专用工具。
 * 这条门的口径(棘轮式 —— 存量不强求一次清完, 但**不许变差**):
 *   ① 任何工具描述不得短于 24 字 (太短的描述等于没说"何时用/别用");
 *   ② terminal 必须带全 6 条对照(用 bolloon **自己的**工具名: grep_files/glob_files/list_files/read_file/edit_file/write_file/fetch_url);
 *   ③ "缺用途线索"的描述数量只许减不许增 (新工具必须写清用途才能进门)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk-tools.ts'), 'utf-8');

function tools(): Array<{ name: string; desc: string }> {
  const out: Array<{ name: string; desc: string }> = [];
  const re = /ctx\.tools\.set\('([^']+)',\s*\{([\s\S]{0,2000}?)\n\s*parameters:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) {
    // 描述可能是**多段字符串拼的** ('a' + 'b' + …) ⇒ 取整段后把所有字面量拼起来
    const blk = m[2];
    const di = blk.indexOf('description:');
    const seg = di >= 0 ? blk.slice(di) : '';
    const lits = [...seg.matchAll(/(['"])([\s\S]*?)\1/g)].map((x) => x[2]);
    out.push({ name: m[1], desc: lits.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

describe('工具描述合同', () => {
  it('① 没有描述短于 24 字的工具', () => {
    const bad = tools().filter((t) => t.desc.length < 24).map((t) => `${t.name}(${t.desc.length})`);
    expect(bad, `这些描述太短, 说不清何时用: ${bad.join(' ')}`).toEqual([]);
  });

  it('② terminal 描述带全"终端习惯 ⇒ 专用工具"对照表 (用 bolloon 自己的工具名)', () => {
    const term = tools().find((t) => t.name === 'terminal');
    expect(term, '没找到 terminal 工具').toBeTruthy();
    for (const pair of ['grep_files', 'glob_files', 'read_file', 'edit_file', 'write_file', 'fetch_url']) {
      expect(term!.desc, `terminal 描述缺 ${pair} 的指引`).toContain(pair);
    }
  });

  it('③ 缺"用途线索"的描述数只许减不许增 (棘轮: 当前基线 60)', () => {
    const noCue = tools().filter((t) => !/适合|用于|何时|优先|别用|别|要|想|只|先|当|用途/.test(t.desc));
    // 棘轮: 数字只能往下走; 新增工具必须写清用途, 否则这里会红
    expect(noCue.length, `无用途线索的描述变多了: ${noCue.slice(0, 8).map((t) => t.name).join(' ')}`).toBeLessThanOrEqual(60);
  });
});
