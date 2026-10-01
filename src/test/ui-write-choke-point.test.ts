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
  it('裸 console.log 只许出现在**兜底函数**内部(writeOut 的溢出分支 / flushBootBuffer 的异常分支)', () => {
    // 2026-10-01: 这个门第一次写成"全文件 ≤1" ✗ —— 加了启动日志缓冲后就**误报**了 ✓
    //   (那两处直写是**兜底语义** ✓: 缓冲满了 / 灌进去抛错 ⇒ 宁可难看也别丢日志 ✓)。
    //   契约改成更准的: 每一处裸直写都必须**落在兜底函数体内**, 别处一处不许有 ✓。
    const fnRanges: Array<[number, number]> = [];
    // 兜底函数白名单: 只许这几处有裸直写(writeOut 的兜底 / writeOutWarn 的兜底 / flushBootBuffer 的异常分支)
    for (const name of ['function writeOut', 'function writeOutWarn', 'export function flushBootBuffer']) {
      const i = CODE.indexOf(name);
      if (i < 0) continue;
      // 函数体: 从名字后第一个 { 到匹配的 } (够用: 这两个函数没有嵌套花括号式子)
      const open = CODE.indexOf('{', i);
      let depth = 0, end = open;
      for (let k = open; k < CODE.length; k++) {
        if (CODE[k] === '{') depth++;
        else if (CODE[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      fnRanges.push([i, end]);
    }
    expect(fnRanges.length, '没定位到兜底函数').toBe(3);
    const offenders: number[] = [];
    for (const m of CODE.matchAll(RAW_LOG)) {
      const at = m.index ?? 0;
      if (!fnRanges.some(([a, b]) => at >= a && at <= b)) offenders.push(at);
    }
    expect(offenders, `有 ${offenders.length} 处裸 console.log 不在兜底函数里, 应收口到 writeOut()`).toEqual([]);
  });
  it('writeOut 依据"启动面板是否画好"决定走 Ink 还是直写', () => {
    expect(CODE).toContain('function writeOut');
    expect(CODE).toMatch(/startupPanelReady[\s\S]{0,80}appendLine/);
  });
});
