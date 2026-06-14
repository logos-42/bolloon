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
    let systemAddition = formatContextForSystemPrompt(ctx, { maxChars: opts.maxChars });
    // 在头部加 channel 标识 (供 LLM 知道当前对话归属)
    if (opts.channelId) {
      systemAddition = `# 当前 channel: ${opts.channelId}\n\n` + systemAddition;
    }
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
// PreToolUse (P2: 4 步链式 validator + permission mode)
// ============================================================

import { resolvePermissionMode, type PermissionMode } from '../agents/permission-mode.js';
import { validatePreToolUse } from '../agents/pre-tool-validator.js';

export interface PreToolUseOptions {
  tool: string;
  args: Record<string, unknown>;
  /** 可选, 不传则用 env BOLLOON_PERM_MODE 或 default */
  permissionMode?: PermissionMode;
}

export interface PreToolUseResult {
  allowed: boolean;
  reason?: string;
  /** P2: 哪一步拒绝的, 供 audit log */
  rejectedBy?: 'mode' | 'blacklist' | 'shell-guard' | 'schema';
  mode: PermissionMode;
  shellGuardRetained?: boolean;
}

/**
 * PreToolUse: 4 步链式 validator
 *   1. modeGate         (bypassPermissions + 非 shell 直接放行)
 *   2. blacklistGate    (6 模式危险命令)
 *   3. shellGuardGate   (路径黑名单, 绕过 mode 永远生效)
 *   4. schemaGate       (第一版 stub: always allow)
 *
 * 向后兼容: 不传 permissionMode → 默认 'default' (env BOLLOON_PERM_MODE 仍生效)
 * 失败静默: 任何异常 → allowed: true (与原行为一致)
 */
export async function onPreToolUse(opts: PreToolUseOptions): Promise<PreToolUseResult> {
  try {
    const mode = resolvePermissionMode({ permissionMode: opts.permissionMode });
    return validatePreToolUse(opts.tool, opts.args || {}, mode);
  } catch (err) {
    console.warn('[lifecycle-hooks] onPreToolUse failed (silent, allowing):', err);
    return { allowed: true, mode: 'default' };  // 失败放行 (不阻塞)
  }
}

// ============================================================
// 测试辅助: 获取 STOP_LOG 路径 (供测试覆盖路径)
// ============================================================

export function getStopLogPathForTest(): string {
  return STOP_LOG;
}
