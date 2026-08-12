/**
 * python-exec.ts — Python 代码执行引擎 (2026-08-12, TaskP)
 *
 * 借鉴 hermes code_execution_tool: 让 agent 输入 Python 代码运行操作, 而非逐条 shell 命令.
 * 设计:
 *   - 把 LLM 给的 Python 代码写到临时文件, 用 python3 子进程执行 (隔离, 不污染主进程)
 *   - 带超时 + kill (子进程跑太久强制终止)
 *   - stdout/stderr 合并捕获 + 截断 (head+tail, 显式 truncation 标记 — hermes 模式)
 *   - 依赖检测: 找不到 python3 返回明确错误
 *
 * 安全: 不 eval (子进程隔离); 代码里若含高危 shell (os.system("rm -rf /") 等) 走 checkTerminalCommand 预检 (最佳努力).
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const MAX_OUTPUT = 16000; // 捕获输出上限 (head+tail)

export interface PythonExecOptions {
  /** Python 代码 */
  code: string;
  /** 超时毫秒 (默认 30000) */
  timeoutMs?: number;
  cwd?: string;
}

export interface PythonExecResult {
  success: boolean;
  output: string;
  stdoutTruncated?: boolean;
  exitCode?: number | null;
  error?: string;
  python?: string;
  deniedByGuard?: boolean;
}

/** 探测可用的 python 解释器 (python3 / python) */
async function detectPython(): Promise<string | null> {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(c, ['--version'], { stdio: 'ignore', windowsHide: true });
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code))));
        p.on('error', reject);
      });
      return c;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 截断输出: 保留 head + tail, 中间省略, 返回截断标记 (hermes 模式).
 */
export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  const head = text.slice(0, 4000);
  const tail = text.slice(-4000);
  return { text: `${head}\n…[输出截断 ${text.length - 8000} 字节]…\n${tail}`, truncated: true };
}

/** 最佳努力: 代码里明显的高危 shell 调用预检 (防 os.system("rm -rf /") 等) */
function checkDangerousCode(code: string): { allowed: boolean; reason?: string } {
  const dangerous = [
    { re: /os\.system\s*\(\s*["']\s*rm\s+(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\s+\//, reason: '禁止递归删除根目录' },
    { re: /shutil\.rmtree\s*\(\s*["']\s*\//, reason: '禁止删除根目录' },
    { re: /os\.system\s*\(\s*["']\s*(sudo|mkfs|dd\s+if=.*of=\/dev)/, reason: '禁止高危系统命令' },
  ];
  for (const { re, reason } of dangerous) {
    if (re.test(code)) return { allowed: false, reason };
  }
  return { allowed: true };
}

/**
 * 执行一段 Python 代码 (隔离子进程 + 超时 + 输出截断).
 */
export async function executePython(opts: PythonExecOptions): Promise<PythonExecResult> {
  const code = String(opts.code ?? '').trim();
  if (!code) return { success: false, error: 'code 必填', output: '' };

  // 高危代码预检 (最佳努力)
  const d = checkDangerousCode(code);
  if (!d.allowed) return { success: false, error: `[python-guard] ${d.reason}`, deniedByGuard: true, output: '' };

  // 探测 python
  const python = await detectPython();
  if (!python) {
    return { success: false, error: '未找到 python3/python 解释器, 无法执行 Python 代码', output: '' };
  }

  // 写临时文件
  const tmpFile = path.join(os.tmpdir(), `bolloon-py-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`);
  await fs.writeFile(tmpFile, code, 'utf-8');

  const timeoutMs = opts.timeoutMs ?? 30000;
  try {
    const result = await new Promise<PythonExecResult>((resolve) => {
      const proc = spawn(python, [tmpFile], {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 忽略 */ }
        resolve({ success: false, output: '', error: `Python 执行超时 (>${timeoutMs}ms), 已终止`, exitCode: -1, python });
      }, timeoutMs);

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ success: false, output: '', error: `启动失败: ${e.message}`, python }); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        const raw = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
        const { text, truncated } = truncateOutput(raw || '(无输出)');
        resolve({
          success: code === 0,
          output: text,
          stdoutTruncated: truncated,
          exitCode: code,
          error: code === 0 ? undefined : `exit code ${code}`,
          python,
        });
      });
    });
    return result;
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}
