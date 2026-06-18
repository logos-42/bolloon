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

/**
 * 把参数 quote 一下,避免 shell 元字符注入 (&& | ; ` > < 等).
 * Windows: 用双引号包, 内部双引号转义.
 */
function shellQuoteArgs(arg: string): string {
  if (process.platform !== 'win32') return arg;  // POSIX shell 由 checkCommand 防护
  if (!/[\s"&|<>^()%!`]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

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

  // 3. 确定运行 cwd
  // M3.5 (2026-06-17): 之前所有命令强制跑在 .bolloon-shell-sandbox/, 但 git / npm install / 读 cwd 相对路径 都会失败
  //   现在策略: 写命令 (echo > / cat > / sed -i) 走 sandbox (隔离), 读命令 (ls / cat / head / git / npm) 走 cwd (能访问 .git)
  //   简单判断: 第一个 arg 含 '>' '|' '<file' 'sed -i' 'tee' 的走 sandbox, 否则走 cwd
  const WRITE_HINT_RE = /^(>|>>|tee\s|sed\s.*-i|.*>\s*\S+|.*\|\s*\S+\s*>)/;
  const looksLikeWrite = args.some((a) => WRITE_HINT_RE.test(a));
  let cwd: string;
  if (looksLikeWrite) {
    cwd = getSandboxCwd();
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {
      // 已经存在则忽略
    }
  } else {
    cwd = process.cwd();
  }

  // 4. 跑命令
  // M3.5 (2026-06-17): Windows 上 ls/cat/pwd 不在 PATH, 必须用 cmd 内置命令 (dir/type/cd)
  //   但 cmd 内置命令不能在 shell: false 下跑, 切到 shell: true (Windows shell: cmd.exe, POSIX shell: /bin/sh)
  //   风险: 元字符注入 — 通过 checkCommand + arg denylist 防护, 加 shellQuoteArgs() 转义
  const isWindows = process.platform === 'win32';
  const needsShell = isWindows;  // Windows: 必须用 shell 才能跑 cmd 内置
  const quotedArgs = isWindows ? args.map(shellQuoteArgs) : args;

  return new Promise((resolve) => {
    const proc = spawn(cmd, quotedArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // 禁止 git 弹交互
      shell: needsShell,
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
