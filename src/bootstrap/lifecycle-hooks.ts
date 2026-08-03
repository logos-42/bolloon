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
import { loadPersonaDocs, formatPersonaForSystemPrompt, loadPersonaJudgmentDeclaration, formatJudgmentDeclaration } from './persona-loader.js';

// ============================================================
// SessionStart
// ============================================================

export interface SessionStartOptions {
  /** channelId 暂时不传到 context (单 channel 维度, plan 范围) */
  channelId?: string;
  /** agentId 透传 (来自 Channel.agentId), 用来加载 persona 文档 */
  agentId?: string;
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
    // 在头部最前拼 persona 文档 (如果 agentId 存在)
    if (opts.agentId) {
      try {
        const docs = await loadPersonaDocs(opts.agentId);
        let personaText = formatPersonaForSystemPrompt(docs);
        // 2026-08-03 (Context OS P1): 追加 persona frontmatter 里的判断力声明
        //   (judgment_style / stakes_default / revisable) — 与 judgeness 5 维对应
        const decl = await loadPersonaJudgmentDeclaration(opts.agentId);
        const declText = formatJudgmentDeclaration(decl);
        if (declText) personaText = personaText ? `${personaText}\n\n${declText}` : declText;
        if (personaText) {
          systemAddition = personaText + '\n\n' + systemAddition;
        }
      } catch (err) {
        console.warn('[lifecycle-hooks] loadPersonaDocs failed (silent):', err);
      }
    }
    return {
      systemAddition,
      collectMs: Date.now() - start,
      truncated: systemAddition.length > 0 && systemAddition.includes('截断'),
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

// ============================================================
// PostToolUse (P+ : 工具调用后审计)
// ============================================================

export interface PostToolUseOptions {
  tool: string;
  args: Record<string, unknown>;
  result: { success: boolean; output?: string; error?: string };
  durationMs?: number;
}

export interface PostToolUseResult {
  /** 是否允许继续 (false = abort 整个 ReAct 循环) */
  continue: boolean;
  reason?: string;
}

/**
 * PostToolUse: 工具调用后审计
 * 默认 always continue. 项目可挂 shell-guard audit log / judgment 注入门 / 监控门
 * 失败静默: 任何异常 → continue: true (不阻塞主循环)
 */
export async function onPostToolUse(opts: PostToolUseOptions): Promise<PostToolUseResult> {
  try {
    // 审计日志: 写 ~/.bolloon/sessions/post-tool-audit.jsonl
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'post-tool-audit.jsonl'
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      tool: opts.tool,
      success: opts.result.success,
      durationMs: opts.durationMs ?? 0,
      // 不写 args (可能含密钥), 只写 result 的 success/error
      error: opts.result.error?.substring(0, 200) || null,
    };
    await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8').catch(() => { /* ignore */ });
    return { continue: true };
  } catch (err) {
    console.warn('[lifecycle-hooks] onPostToolUse failed (silent, allowing):', err);
    return { continue: true };
  }
}

// ============================================================
// JudgmentInjected (bolloon 独有 : 注入门使用时审计)
// ============================================================

export interface JudgmentInjectedOptions {
  judgmentIds: string[];
  channelId?: string;
  userInput?: string;
}

export async function onJudgmentInjected(opts: JudgmentInjectedOptions): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'judgment-injected.jsonl'
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      channelId: opts.channelId || 'unknown',
      judgmentIds: opts.judgmentIds,
      userInputSnippet: (opts.userInput || '').substring(0, 200),
    };
    await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8').catch(() => { /* ignore */ });
  } catch (err) {
    console.warn('[lifecycle-hooks] onJudgmentInjected failed (silent):', err);
  }
}

// ============================================================
// MonitorViolation (bolloon 独有 : 监控门审计违规)
// ============================================================

export interface MonitorViolationOptions {
  channelId?: string;
  judgmentId: string;
  rule: string;
  actualBehavior: string;
  severity: 'low' | 'medium' | 'high';
}

export async function onMonitorViolation(opts: MonitorViolationOptions): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'monitor-violation.jsonl'
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      channelId: opts.channelId || 'unknown',
      judgmentId: opts.judgmentId,
      rule: opts.rule.substring(0, 200),
      actualBehavior: opts.actualBehavior.substring(0, 200),
      severity: opts.severity,
    };
    await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8').catch(() => { /* ignore */ });
  } catch (err) {
    console.warn('[lifecycle-hooks] onMonitorViolation failed (silent):', err);
  }
}

// ============================================================
// GoalParked / GoalResumed (2026-07-10: 双栖 agent 网络"目标接力"用)
// ============================================================

export interface GoalParkedOptions {
  goalId: string;
  targetId: string;
  reason: 'channel_switch' | 'user_away' | 'awaiting_external' | 'peer_handoff';
  originChannel: string;
  sessionKey: string;
  taskId: string | null;
  peerDid?: string;
}

export async function onGoalParked(opts: GoalParkedOptions): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'goal-parked.jsonl'
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      goalId: opts.goalId,
      targetId: opts.targetId,
      reason: opts.reason,
      originChannel: opts.originChannel,
      sessionKey: opts.sessionKey,
      taskId: opts.taskId,
      peerDid: opts.peerDid,
    };
    await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8').catch(() => { /* ignore */ });
  } catch (err) {
    console.warn('[lifecycle-hooks] onGoalParked failed (silent):', err);
  }
}

export interface GoalResumedOptions {
  goalId: string;
  targetId: string;
  originChannel: string;
  resumedIn: string;       // 新 session key
  taskId: string | null;
  fromPeerDid?: string;    // 跨机器 resume 时填
}

export async function onGoalResumed(opts: GoalResumedOptions): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'goal-resumed.jsonl'
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      goalId: opts.goalId,
      targetId: opts.targetId,
      originChannel: opts.originChannel,
      resumedIn: opts.resumedIn,
      taskId: opts.taskId,
      fromPeerDid: opts.fromPeerDid,
    };
    await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8').catch(() => { /* ignore */ });
  } catch (err) {
    console.warn('[lifecycle-hooks] onGoalResumed failed (silent):', err);
  }
}
