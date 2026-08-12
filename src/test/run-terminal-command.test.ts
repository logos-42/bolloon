/**
 * run-terminal-command.test.ts — 2026-08-12 (Task2)
 *
 * 覆盖: 统一终端执行入口 runTerminalCommand
 *   - 单命令执行 / 多命令并行
 *   - 护栏拒绝 (高危命令)
 *   - 与 shell_exec/terminal 共享宽松护栏
 */
import { describe, it, expect } from 'vitest';
import { runTerminalCommand } from '../agents/pi-sdk-tools.js';

describe('runTerminalCommand (统一终端入口, Task2)', () => {
  it('单命令: echo 正常执行返回输出', async () => {
    const r = await runTerminalCommand('echo hello-task2', { timeoutMs: 5000 });
    expect(r.success).toBe(true);
    expect(r.output).toContain('hello-task2');
  });

  it('多命令并行: commands 数组全部执行', async () => {
    const r = await runTerminalCommand('', {
      timeoutMs: 10000,
      commands: ['echo one', 'echo two', 'echo three'],
    });
    expect(r.success).toBe(true);
    expect(r.parallel).toBe(true);
    expect(r.count).toBe(3);
    expect(r.output).toContain('one');
    expect(r.output).toContain('two');
    expect(r.output).toContain('three');
  });

  it('护栏拒绝: 高危命令返回 deniedByGuard', async () => {
    const r = await runTerminalCommand('sudo rm -rf /', { timeoutMs: 5000 });
    expect(r.success).toBe(false);
    expect(r.deniedByGuard).toBe(true);
  });

  it('护栏拒绝: commands 数组内任一高危即整体拒', async () => {
    const r = await runTerminalCommand('', {
      timeoutMs: 5000,
      commands: ['echo safe', 'kill -9 1234'],
    });
    expect(r.success).toBe(false);
    expect(r.deniedByGuard).toBe(true);
  });

  it('多命令: 一条失败时返回失败 + partial 结果', async () => {
    // 用必然失败的命令 (Windows 与 POSIX 通用: 不存在的可执行文件)
    const r = await runTerminalCommand('', {
      timeoutMs: 10000,
      commands: ['echo ok-line', 'this_command_does_not_exist_xyz'],
    });
    expect(r.success).toBe(false);
    expect(Array.isArray(r.partial)).toBe(true);
    expect(r.output).toContain('ok-line');
  });
});
