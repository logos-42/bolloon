/**
 * process-runner.ts — 后台进程管理 (2026-08-12, TaskD)
 *
 * 借鉴 hermes terminal_tool: 长期运行命令不应阻塞对话.
 *   - foreground: 命令结束立即返回 (即使超时设长, 不 sleep 阻塞)
 *   - background: spawn 后台执行, 返回 session_id, 用 process(action=poll/wait/kill) 管理
 *   - 禁止 nohup/setsid/trailing '&' — 用 background 让系统跟踪进程
 *
 * 进程注册表: 模块级 Map<sessionId, {proc, cmd, startedAt, output[]}>, 供 process 工具查询.
 */

import { spawn, type ChildProcess } from 'child_process';
import os from 'node:os';
import fs from 'node:fs';
import * as path from 'path';

export interface BackgroundSession {
  id: string;
  cmd: string;
  cwd: string;
  startedAt: number;
  exitCode: number | null;
  status: 'running' | 'exited' | 'killed' | 'error';
  output: string;
  error?: string;
  proc: ChildProcess | null;
  /** 系统 pid (落盘后重启也能按它探活 ✓) */
  pid?: number;
  /** true = 本进程不是它的父进程(重启后从盘上恢复的) ⇒ 只能 poll/kill 按 pid 来 ✓ */
  detached?: boolean;
}

const sessions = new Map<string, BackgroundSession>();
let seq = 0;

function genId(): string {
  seq++;
  return `proc-${Date.now().toString(36)}-${seq}`;
}

/**
 * 后台启动一个 shell 命令. 立即返回 session 记录 (不阻塞).
 * 命令字符串经调用方 (runTerminalCommand) 护栏检查.
 */
export function spawnBackground(raw: string, cwd: string = process.cwd()): BackgroundSession {
  const id = genId();
  const session: BackgroundSession = { id, cmd: raw.slice(0, 300), cwd, startedAt: Date.now(), exitCode: null, status: 'running', output: '', proc: null };
  sessions.set(id, session);
  // Windows 用 cmd /c; POSIX 用 /bin/sh -c
  const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/c', raw] : ['-c', raw];
  try {
    const proc = spawn(shell, shellArgs, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    session.proc = proc;
    session.pid = proc.pid;
    persistSessions();
    proc.stdout.on('data', (d) => { session.output = (session.output + d.toString()).slice(-16000); });
    proc.stderr.on('data', (d) => { session.output = (session.output + d.toString()).slice(-16000); });
    proc.on('close', (code) => { session.exitCode = code; session.status = 'exited'; persistSessions(); });
    proc.on('error', (e) => { session.status = 'error'; session.error = e.message; persistSessions(); });
  } catch (e: any) {
    session.status = 'error';
    session.error = e?.message;
  }
  return session;
}

/** 查询后台进程状态 (不阻塞). 返回脱敏视图. */
export function pollSession(id: string): { ok: boolean; found?: boolean; session?: Partial<BackgroundSession> } {
  const s = sessions.get(id);
  if (!s) return { ok: false, found: false };
  return {
    ok: true,
    found: true,
    session: {
      id: s.id, cmd: s.cmd, startedAt: s.startedAt, exitCode: s.exitCode,
      status: s.status, output: s.output.slice(-4000), error: s.error,
    },
  };
}

/** 等待后台进程结束 (最多 timeoutMs). 返回最终状态. */
export async function waitSession(id: string, timeoutMs: number = 30000): Promise<{ ok: boolean; session?: any; error?: string }> {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: `未知 session ${id}` };
  if (s.status !== 'running') {
    return { ok: true, session: { id: s.id, status: s.status, exitCode: s.exitCode, output: s.output.slice(-4000) } };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && s.status === 'running') {
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    ok: s.status !== 'running',
    session: { id: s.id, status: s.status, exitCode: s.exitCode, output: s.output.slice(-4000), timedOut: s.status === 'running' },
  };
}

/** 杀死后台进程. 返回是否已终止. */
export function killSession(id: string): { ok: boolean; reason?: string } {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: `未知 session ${id}` };
  if (s.status !== 'running' || !s.proc) {
    return { ok: true, reason: `进程已 ${s.status}` };
  }
  try {
    if (process.platform === 'win32') s.proc.kill('SIGTERM'); else s.proc.kill('SIGTERM');
    s.status = 'killed';
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `kill 失败: ${e?.message}` };
  }
}

/** 列出所有后台进程 */
export function listSessions(): Array<{ id: string; cmd: string; status: string; exitCode: number | null }> {
  return Array.from(sessions.values()).map((s) => ({ id: s.id, cmd: s.cmd, status: s.status, exitCode: s.exitCode }));
}

/** session id 合法性 (防注入) */
export function isValidSessionId(id: string): boolean {
  return /^proc-[a-z0-9]+-\d+$/.test(id || '');
}

export function sessionIdFromPath(p: string): string {
  return path.basename(String(p || '').trim());
}


// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01 (用户: 「bolloon 后台开进程后无法回来进行管理」):
//   实测根因: 会话表是**内存 Map** ✗ 且不落盘 ⇒ 重启/换一轮后 bolloon **忘了**后台进程 ✗
//   ⇒ `process list` 空的 ⇒ "回不来管理" ✓。修: 落盘 `~/.bolloon/processes.json` +
//   **懒恢复**(list/poll 时若表里没有就从盘上读 ✓) + 按 pid 探活(活着 ⇒ detached=true 仍可 kill ✓; 死了 ⇒ lost ✓)。
// ─────────────────────────────────────────────────────────────────────────────

export function processesPath(home = os.homedir()): string {
  return path.join(home, '.bolloon', 'processes.json');
}

/** 探活: 只发 0 号信号, 真 kill 什么都不做 ✓ (EPERM 也算活着 ✓) */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** 把当前的会话表写到盘上 (best-effort, 绝不影响命令执行 ✓) */
export function persistSessions(home = os.homedir()): void {
  try {
    const rows = [...sessions.values()].map((s) => ({
      id: s.id, cmd: s.cmd, cwd: s.cwd, startedAt: s.startedAt,
      status: s.status, exitCode: s.exitCode, pid: s.pid ?? null,
    }));
    fs.mkdirSync(path.dirname(processesPath(home)), { recursive: true });
    fs.writeFileSync(processesPath(home), JSON.stringify(rows, null, 0), 'utf-8');
  } catch { /* 落盘失败不影响执行 */ }
}

/** 懒恢复: 表里没有的就从盘上读回来, 并按 pid 探活 ✓ */
export function restoreSessions(home = os.homedir()): number {
  let n = 0;
  try {
    const file = processesPath(home);
    if (!fs.existsSync(file)) return 0;
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.id || sessions.has(r.id)) continue;
      const alive = isPidAlive(Number(r.pid));
      sessions.set(r.id, {
        id: String(r.id), cmd: String(r.cmd || ''), cwd: String(r.cwd || process.cwd()),
        startedAt: Number(r.startedAt) || Date.now(), exitCode: r.exitCode ?? null,
        status: r.status === 'running' ? (alive ? 'running' : 'exited') : (r.status || 'exited'),
        output: alive ? '(重启后恢复: 进程仍在跑, 输出不再采集 —— 需要结果就重新跑或用文件落盘)' : '',
        proc: null, pid: Number(r.pid) || undefined, detached: true,
      } as any);
      n++;
    }
  } catch { /* 坏文件忽略 */ }
  return n;
}
