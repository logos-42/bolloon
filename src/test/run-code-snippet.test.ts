/**
 * run-code-snippet.test.ts — 2026-08-12 (TaskA)
 *
 * terminal 便捷代码运行: runCodeSnippet 自动识别代码块 → 写脚本 → 执行.
 *   - python/js 代码执行
 *   - 空 code / 不支持语言报错
 */
import { describe, it, expect } from 'vitest';
import { runCodeSnippet } from '../agents/pi-sdk-tools.js';

describe('runCodeSnippet (terminal 便捷代码运行, TaskA)', () => {
  it('空 code 返回错误', async () => {
    const r = await runCodeSnippet({ code: '' });
    expect(r.success).toBe(false);
  });

  it('不支持的语言返回错误', async () => {
    const r = await runCodeSnippet({ code: 'x', language: 'ruby' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('不支持');
  });

  it('Python 代码执行 (自动写脚本)', async () => {
    const r = await runCodeSnippet({ code: 'print(6*7)', language: 'python', timeoutMs: 15000, tmpDir: process.env.TEMP || '/tmp' });
    if (!r.success && r.error?.includes('python3')) { return; } // 无 python 环境跳过
    expect(r.success).toBe(true);
    expect(r.output).toContain('42');
  });

  it('JS 代码执行', async () => {
    const r = await runCodeSnippet({ code: 'console.log(1+1)', language: 'js', timeoutMs: 15000, tmpDir: process.env.TEMP || '/tmp' });
    if (!r.success && r.error?.includes('node')) { return; }
    expect(r.success).toBe(true);
    expect(r.output).toContain('2');
  });

  it('代码报错返回 exit code', async () => {
    const r = await runCodeSnippet({ code: 'print(undefined_var_xyz)', language: 'python', timeoutMs: 15000, tmpDir: process.env.TEMP || '/tmp' });
    if (!r.success && r.error?.includes('python3')) { return; }
    expect(r.success).toBe(false);
  });
});
