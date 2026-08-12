/**
 * python-exec.test.ts — 2026-08-12 (TaskP)
 *
 * Python 代码执行引擎 (hermes code_execution 简化复现):
 *   - executePython 隔离子进程跑代码
 *   - 输出截断 + 超时终止 + 高危代码预检
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { executePython, truncateOutput } from '../agents/python-exec.js';

let hasPy = false;
beforeAll(async () => {
  const r = await executePython({ code: 'print("probe")', timeoutMs: 5000 }).catch(() => ({ success: false }));
  hasPy = r.success === true;
});

describe('python-exec (Python 代码执行)', () => {
  it('truncateOutput: 超长输出截断 head+tail + 标记', () => {
    const long = 'x'.repeat(20000);
    const { text, truncated } = truncateOutput(long);
    expect(truncated).toBe(true);
    expect(text).toContain('输出截断');
    expect(text.length).toBeLessThan(10000);
  });

  it('truncateOutput: 短输出不截断', () => {
    const { text, truncated } = truncateOutput('hello');
    expect(truncated).toBe(false);
    expect(text).toBe('hello');
  });

  it('高危代码预检: os.system 删根被拒', async () => {
    const r = await executePython({ code: `import os\nos.system("rm -rf /")`, timeoutMs: 5000 });
    expect(r.deniedByGuard).toBe(true);
    expect(r.success).toBe(false);
  });

  it('空 code 返回错误', async () => {
    const r = await executePython({ code: '' });
    expect(r.success).toBe(false);
  });

  it('真实执行: 简单 Python 代码', { timeout: 10000 }, async () => {
    if (!hasPy) return; // 本机无 python 时跳过
    const r = await executePython({ code: 'print(21*2)', timeoutMs: 10000 });
    expect(r.success).toBe(true);
    expect(r.output).toContain('42');
  });

  it('真实执行: 代码报错返回 exit code', { timeout: 10000 }, async () => {
    if (!hasPy) return;
    const r = await executePython({ code: 'raise ValueError("boom")', timeoutMs: 10000 });
    expect(r.success).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });
});
