/**
 * Lifecycle Hooks — SessionStart / Stop / PreToolUse
 *
 * 失败静默: 任意 hook 挂掉不抛错, 仅 console.warn.
 * 任何调用方都可以放心 await, 不会阻塞主对话.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getCachedBolloonContext, clearBolloonContextCache } from './context-collector.js';
import { formatContextForSystemPrompt } from './project-context.js';

// ============================================================
// SessionStart
// ============================================================

export interface SessionStartOptions {
  /** channelId 暂时不传到 context (单 channel 维度, plan 范围) */
  channelId?: string;
  /** 工作目录, 默认 process.cwd() */
  cwd?: string;
  /** 强制重扫, 跳过 24h 缓存 */
  force?: boolean;
  /** system prompt 片段字符上限 */
  maxChars?: number;
}

export interface SessionStartResult {
  /** 拼到 system prompt 头部的 markdown 文本 */
  systemAddition: string;
  /** 收集耗时 ms */
  collectMs: number;
  /** 是否被截断 */
  truncated: boolean;
}

let lastSessionStartAt = 0;
const MIN_INTERVAL_MS = 5000; // 同一进程 5s 内最多触发一次, 防止循环

export async function onSessionStart(opts: SessionStartOptions = {}): Promise<SessionStartResult> {
  const start = Date.now();
  if (start - lastSessionStartAt < MIN_INTERVAL_MS) {
    // 限流: 返回空 (调用方已经有缓存, 不需要重算)
    return { systemAddition: '', collectMs: 0, truncated: false };
  }
  lastSessionStartAt = start;

  try {
    const ctx = await getCachedBolloonContext(
      { cwd: opts.cwd ?? process.cwd() },
      opts.force ?? false
    );
    const systemAddition = formatContextForSystemPrompt(ctx, { maxChars: opts.maxChars });
    return {
      systemAddition,
      collectMs: Date.now() - start,
      truncated: systemAddition.length > 0 && systemAddition.includes('截断模式'),
    };
  } catch (err) {
    console.warn('[lifecycle-hooks] onSessionStart failed (silent):', err);
    return { systemAddition: '', collectMs: Date.now() - start, truncated: false };
  }
}

export function clearSessionStartCache(): void {
  lastSessionStartAt = 0;
  clearBolloonContextCache();
}

// ============================================================
// Stop
// ============================================================

export interface StopOptions {
  channelId: string;
  messages?: number;
  durationMs: number;
  /** 注入门使用过的 judgment ids (供审计) */
  usedJudgmentIds?: string[];
}

export interface StopResult {
  persisted: boolean;
  path: string | null;
}

const STOP_LOG = (os.homedir() || process.env.HOME || '/tmp') + '/.bolloon/sessions';

/**
 * 把本次 session 摘要写 ~/.bolloon/sessions/<channelId>/last-stop.json
 * 不重复写完整 session 持久化 (已由 createWebServer 内的 saveSession 处理)
 */
export async function onStop(opts: StopOptions): Promise<StopResult> {
  try {
    const dir = path.join(STOP_LOG, sanitizeChannelId(opts.channelId));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'last-stop.json');
    const entry = {
      ts: new Date().toISOString(),
      channelId: opts.channelId,
      messages: opts.messages ?? 0,
      durationMs: opts.durationMs,
      usedJudgmentIds: opts.usedJudgmentIds ?? [],
    };
    await fs.writeFile(file, JSON.stringify(entry, null, 2), 'utf-8');
    return { persisted: true, path: file };
  } catch (err) {
    console.warn('[lifecycle-hooks] onStop failed (silent):', err);
    return { persisted: false, path: null };
  }
}

function sanitizeChannelId(id: string): string {
  // 防止路径穿越
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ============================================================
// PreToolUse (接口预留, 当前仅实现白名单 + 危险命令拦截)
// ============================================================

export interface PreToolUseOptions {
  tool: string;
  args: Record<string, unknown>;
}

export interface PreToolUseResult {
  allowed: boolean;
  reason?: string;
}

// 黑名单: 高危 shell 命令模式
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\s+\//, reason: '禁止递归删除根目录' },
  { re: /\bgit\s+push\s+.*--force\b/, reason: '禁止 force push' },
  { re: /\brm\s+-rf\s+~\//, reason: '禁止递归删除 home' },
  { re: /\bdd\s+if=.*\s+of=\/dev\//, reason: '禁止 dd 覆盖块设备' },
  { re: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: '禁止 curl|sh 直执行' },
  { re: />\s*\/dev\/sd[a-z]/, reason: '禁止写裸设备' },
];

/**
 * PreToolUse: 当前实现"危险命令拦截" (黑名单)
 * 白名单机制未启用 (默认放行所有非黑名单)
 * PreToolUse hook 接入 pi-sdk.ts 的 ReAct 循环是下个迭代
 */
export async function onPreToolUse(opts: PreToolUseOptions): Promise<PreToolUseResult> {
  try {
    // 仅检查 shell 类工具的命令字符串
    if (opts.tool === 'shell' || opts.tool === 'shell_exec' || opts.tool === 'bash') {
      const cmd = String(opts.args.command || opts.args.cmd || '');
      for (const { re, reason } of DANGEROUS_PATTERNS) {
        if (re.test(cmd)) {
          return { allowed: false, reason };
        }
      }
    }
    return { allowed: true };
  } catch (err) {
    console.warn('[lifecycle-hooks] onPreToolUse failed (silent):', err);
    return { allowed: true };  // 失败放行 (不阻塞)
  }
}

// ============================================================
// 测试辅助: 获取 STOP_LOG 路径 (供测试覆盖路径)
// ============================================================

export function getStopLogPathForTest(): string {
  return STOP_LOG;
}
