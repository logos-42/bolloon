/**
 * UI 直写必须收口 (2026-10-01, 用户: 「还是UI有污染」)。
 * 为什么: Ink 设成 `patchConsole: false`(不接管 console)⇒ 运行期任何裸 `console.log` 都写在
 *   Ink 托管区**之外** ⇒ 每次直写都把正在渲染的 footer(提示行 + 分界线)往下推一份
 *   ⇒ 屏幕重复出现「· 回车发送 · ↑↓ 历史 …」✓(真机实测形态)。
 * 契约(源级棘轮): `src/index.ts` 里除 `writeOut()` 内部那一次真直写外, 不许再有裸 `console.log(`。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
// 剥注释(教训: 拿子串当判据前先排除注释 —— 否则会被"解释这条规矩的注释"绊倒)
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const RAW_LOG = /console\.log\(/g;

describe('UI 直写收口', () => {
  it('全文件只剩 writeOut 内部一次裸 console.log(其余全走统一出口)', () => {
    const n = (CODE.match(RAW_LOG) || []).length;
    expect(n, `还有 ${n} 处裸 console.log, 应收口到 writeOut()`).toBeLessThanOrEqual(1);
  });
  it('writeOut 依据"启动面板是否画好"决定走 Ink 还是直写', () => {
    expect(CODE).toContain('function writeOut');
    expect(CODE).toMatch(/startupPanelReady[\s\S]{0,80}appendLine/);
  });
});
