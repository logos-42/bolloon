/**
 * 代码写改的"类型门" (2026-10-01)。为什么单独立门: "一轮只跑一次"这条最容易写错
 *   —— 写成"每个文件跑一次"就会把一回合烧成大几十秒的 tsc ✗。
 * 背景事实: bolloon 早有 tsc 闸(pre-commit lefthook · build:main · tsc_check 工具),
 *   缺的是"**改完自动跑**" ⇒ 这条门锁住"自动"这条链路 ✓。
 */
import { describe, it, expect } from 'vitest';
import { codeWriteTarget, decideTypecheck, formatTypecheckResult, isTypeScriptFile } from '../kernel/code-write-gate.js';

describe('代码写改 ⇒ 类型门', () => {
  it('只对 TS/TSX 源码生效 (改 md/py/json 不该触发 tsc)', () => {
    expect(isTypeScriptFile('src/a.ts')).toBe(true);
    expect(isTypeScriptFile('src/a.tsx')).toBe(true);
    expect(isTypeScriptFile('docs/a.md')).toBe(false);
    expect(isTypeScriptFile('x.py')).toBe(false);
    expect(isTypeScriptFile('package.json')).toBe(false);
  });
  it('只有"写改类工具 + TS 路径"才算 (读文件/终端命令不算)', () => {
    expect(codeWriteTarget('write_file', { path: 'src/a.ts' })).toBe('src/a.ts');
    expect(codeWriteTarget('edit_file', { path: 'src/b.tsx' })).toBe('src/b.tsx');
    expect(codeWriteTarget('read_file', { path: 'src/a.ts' })).toBeNull();
    expect(codeWriteTarget('terminal', { command: 'echo > src/a.ts' })).toBeNull();
    expect(codeWriteTarget('write_file', { path: 'README.md' })).toBeNull();
  });
  it('**一轮只跑一次** (改了 8 个 TS 也只跑一次)', () => {
    expect(decideTypecheck(['a.ts', 'b.ts', 'c.ts'], false)).toBe(true);
    expect(decideTypecheck(['a.ts', 'b.ts'], true), '本回合已跑过就不该再跑').toBe(false);
    expect(decideTypecheck([], false), '没改 TS 就别跑').toBe(false);
  });
  it('结果给一行可读状态: 通过 / 没过(含错误条数与前几条)', () => {
    expect(formatTypecheckResult(true, '')).toContain('✅');
    const out = Array.from({ length: 12 }, (_v, i) => `src/x${i}.ts(1,2): error TS2322: 类型不匹配`).join('\n');
    const f = formatTypecheckResult(false, out);
    expect(f).toContain('❌');
    expect(f).toContain('12 个错误');
    expect(f).toContain('还有');
    expect(f).toContain('先修类型再继续');
  });
});
