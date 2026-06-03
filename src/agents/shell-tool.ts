/**
 * Shell 工具: 给 Bolloon agent 跑受限的 shell 命令
 *
 * 这个工具**只做两件事**:
 *   1. 把命令交给硬护栏检查
 *   2. 在沙箱 cwd 下用 child_process 执行
 *
 * AI 完全自主触发自改, 但 shell 工具本身**只接受白名单内命令**.
 * 禁区列表在 shell-guard.ts, AI 改不了那个文件.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import { checkCommand, checkWritePath, getSandboxCwd } from './shell-guard.js';

export interface ShellExecResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  /** true 表示被护栏拒绝, AI 不应该重试 */
  deniedByGuard?: boolean;
}

/**
 * 在沙箱里跑一条命令
 * @param cmd  可执行文件名, 必须命中白名单
 * @param args 参数列表
 * @param opts.timeoutMs 超时毫秒, 默认 30s
 * @param opts.allowedWriteTargets 允许的写入路径, 命中禁区列表的路径会拒
 */
export async function shellExec(
  cmd: string,
  args: string[] = [],
  opts: { timeoutMs?: number; allowedWriteTargets?: string[] } = {}
): Promise<ShellExecResult> {
  // 1. 护栏检查
  const cmdCheck = checkCommand(cmd, args);
  if (!cmdCheck.allowed) {
    return {
      success: false,
      error: `[shell-guard] ${cmdCheck.reason}`,
      deniedByGuard: true
    };
  }

  // 2. 写入目标检查
  if (opts.allowedWriteTargets) {
    for (const target of opts.allowedWriteTargets) {
      const pathCheck = checkWritePath(target);
      if (!pathCheck.allowed) {
        return {
          success: false,
          error: `[shell-guard] ${pathCheck.reason}`,
          deniedByGuard: true
        };
      }
    }
  }

  // 3. 确保沙箱存在
  const sandboxCwd = getSandboxCwd();
  try {
    fs.mkdirSync(sandboxCwd, { recursive: true });
  } catch {
    // 已经存在则忽略
  }

  // 4. 跑命令
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: sandboxCwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // 禁止 git 弹交互
      shell: false,  // **关键**: 禁用 shell, 防止元字符注入
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ success: false, error: `命令超时 (>${opts.timeoutMs || 30000}ms)`, exitCode: -1 });
    }, opts.timeoutMs || 30000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: `启动失败: ${err.message}` });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
      if (code === 0) {
        resolve({ success: true, output, exitCode: 0 });
      } else {
        resolve({ success: false, output, error: `exit code ${code}`, exitCode: code ?? -1 });
      }
    });
  });
}
