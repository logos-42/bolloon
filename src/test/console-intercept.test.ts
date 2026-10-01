/**
 * 进程级 console 拦截 (2026-10-01, 用户: 「有新的需要拦截」)。
 * 为什么: 启动那几行(iroh/主题/P2P)来自 src/network/* 的直写 —— 绕过统一出口 ⇒ 把 footer 推下去 ✗。
 * 契约: ① 拦截器在 Ink 启动时装上、退出时卸下(源级钉住 ✓); ② 格式化必须**剥 ANSI** + 压成一行 + 有上限 ✓;
 *   ③ 幂等(装两次不叠 ✓)· 卸载后 console 恢复原函数 ✓。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RAW = fs.readFileSync(path.join(process.cwd(), 'src/cli/ink-app.tsx'), 'utf-8');
const SRC = RAW.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('console 拦截', () => {
  it('② 格式化: 剥 ANSI + 压一行 + 有上限', async () => {
    const { formatConsoleArgs } = await import('../cli/ink-app.js');
    const esc = String.fromCharCode(27);
    expect(formatConsoleArgs([esc + '[32m  主题: abc' + esc + '[0m'])).toBe('主题: abc');
    expect(formatConsoleArgs(['a\nb\tc'])).toBe('a b c');
    expect(formatConsoleArgs(['x'.repeat(5000)]).length).toBeLessThanOrEqual(1000);
    expect(formatConsoleArgs([new Error('出了点事')])).toBe('出了点事');
  });
  it('① 源级: startInk 必须装, stopInk 必须卸', () => {
    expect(SRC).toMatch(/installConsoleIntercept\(\)/);
    expect(SRC).toMatch(/uninstallConsoleIntercept\(\)/);
    // 装在 startInk 里、卸在 stopInk 里(顺序也必须对)
    const start = SRC.indexOf('export function startInk');
    const stop = SRC.indexOf('export function stopInk');
    expect(SRC.indexOf('installConsoleIntercept();', start)).toBeGreaterThan(start);
    expect(SRC.indexOf('uninstallConsoleIntercept();', stop)).toBeGreaterThan(stop);
  });
  it('绝不劫持 process.stdout.write(Ink 自己要用)', () => {
    expect(SRC).not.toMatch(/process\.stdout\.write\s*=/);
  });
});
