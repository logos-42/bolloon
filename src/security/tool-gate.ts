/**
 * Tool Gate — 8 道安全 gate (调工具前/后的快速判断)
 *
 * 跟 harness-integration/gate-state-machine 区别:
 * - 后者: 工程化工作流 8-gate (HARNESS-DEV 流程)
 * - 本文件: 工具调用安全 8-gate (防越权 / 防注入 / 防越界)
 *
 * 每道 gate 独立可禁用, 调用方按顺序串联
 * 任何 gate failed = 拒绝 tool 调用 + 返回 reason
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import { runBuiltinGuards, auditToolOutput, type GuardHit, type GuardSeverity } from './builtin-guards.js';

export type GateId = 'whitelist' | 'schema' | 'channel' | 'rate' | 'inject' | 'output' | 'chain' | 'blacklist';

export interface GateResult {
  gate: GateId;
  allowed: boolean;
  reason?: string;
  /** 仅供 UI / 日志 */
  evidence?: string;
}

export interface GateContext {
  tool: string;
  args: Record<string, unknown>;
  channelId?: string;
  /** 当前 ReAct 循环已调的 tool 调用数 (本轮) */
  toolCallCountInTurn?: number;
  /** 最近 N 次 tool 调用的 (tool, ms) 列表, 供速率限制 */
  recentCalls?: Array<{ tool: string; ts: number }>;
}

// ============================================================
// Gate 1: 白名单
// ============================================================

const TOOL_WHITELIST = new Set<string>([
  // 已有 tool (见 pi-sdk.ts registerTools)
  'read_document', 'summarize_document', 'improve_document',
  'list_peers', 'send_message', 'broadcast_message',
  'get_identity', 'list_skills', 'create_judgment',
  'shell_exec', 'shell',
  'read', 'write', 'edit_file', 'list_files',
  'list_sessions', 'get_session_state', 'list_messages',
  'send_to_channel', 'create_channel',
  // M2.1 (2026-06-17): 新增的 10 个 agent 工具 (跟 pi-sdk registerTools 同步)
  'write_file', 'git_diff', 'git_commit', 'git_push', 'git_branch',
  'create_task', 'update_task', 'get_task', 'list_tasks',
  'use_skill', 'self_improve',
  // 2026-06-19: M4 新增 (跟 pi-sdk.ts registerTools 同步)
  'read_file', 'delete_file', 'mkdir', 'move_file',
  'grep_files', 'glob_files',
  'git_log', 'git_show', 'git_stash',
  'vitest_run', 'tsc_check',
  // 2026-06-19: Agent Mesh 通信工具 (跟 pi-sdk.ts registerTools 同步)
  'check_inbox', 'send_to_peer', 'p2p_broadcast', 'send_to_local_agent', 'list_local_agents', 'agent_call',
  // 2026-06-24: Wallet + Polymarket + Safe 工具 (跟 pi-sdk.ts _registerWalletTools 同步)
  'wallet_create', 'wallet_import', 'wallet_get_balance', 'wallet_sign_message', 'wallet_send_tx', 'wallet_transfer_token', 'wallet_autopay',
  'polymarket_list_markets', 'polymarket_get_market', 'polymarket_get_orders', 'polymarket_create_order', 'polymarket_cancel_order',
  'safe_deploy',
  // MCP 注册的工具
  'mcp_tool',
  // 2026-07-29: 同步 pi-sdk-tools.ts 注册的全部工具
  'read_directory', 'add_friend_by_id', 'delegate_to_engine',
  'set_persona', 'get_operation_logs', 'park_goal',
  'list_channels', 'list_local_channels',
  // 2026-08-02: skill 沉淀工具 (skill-writer.ts)
  'create_skill', 'update_skill', 'list_skill_candidates', 'promote_skill',
]);

export const gateWhitelist: GateResult = { gate: 'whitelist', allowed: true };

/**
 * @deprecated 不再被 TOOL_GATES 调用 (2026-07-29). 保留仅供测试直接引用.
 * 工具准入由 `tools` 参数 (OpenAI 原生格式) 控制, 不再需要第二层白名单.
 */
export function checkWhitelist(ctx: GateContext): GateResult {
  if (TOOL_WHITELIST.has(ctx.tool)) {
    return gateWhitelist;
  }
  return {
    gate: 'whitelist',
    allowed: false,
    reason: `工具 '${ctx.tool}' 不在白名单`,
    evidence: `白名单: ${Array.from(TOOL_WHITELIST).slice(0, 5).join(', ')}...`,
  };
}

// ============================================================
// Gate 2: args 形状校验 (防 schema 注入)
// ============================================================

const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

export function checkSchema(ctx: GateContext): GateResult {
  // 1) 直接遍历 args (JSON.stringify 会丢 __proto__, 必须手动检查)
  function walkKeys(obj: unknown, path: string[] = []): string | null {
    if (obj === null || typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
      if ((DANGEROUS_KEYS as readonly string[]).includes(k)) {
        return [...path, k].join('.');
      }
      const found = walkKeys((obj as Record<string, unknown>)[k], [...path, k]);
      if (found) return found;
    }
    return null;
  }
  const dangerousKey = walkKeys(ctx.args);
  if (dangerousKey) {
    return {
      gate: 'schema',
      allowed: false,
      reason: `args 含 prototype pollution 风险 key: ${dangerousKey}`,
      evidence: dangerousKey,
    };
  }
  // 2) args 字符串过深 (>10000 字符) — 可能是 prompt injection 试图污染
  const json = JSON.stringify(ctx.args);
  if (json.length > 10000) {
    return {
      gate: 'schema',
      allowed: false,
      reason: `args 过长 (${json.length} 字符), 可能含 prompt injection`,
      evidence: `前 100 字符: ${json.substring(0, 100)}`,
    };
  }
  return { gate: 'schema', allowed: true };
}

// ============================================================
// Gate 3: channel 权限 (channelId 是否被允许调该 tool)
// ============================================================

/** 工具 → 哪些 channelId 不允许 (黑名单模式, 留作扩展) */
const TOOL_CHANNEL_RESTRICT: Record<string, Array<string | RegExp>> = {
  // 'shell_exec': [/^ch_system_/],  // 示例: 某些 system channel 禁 shell
};

export function checkChannel(ctx: GateContext): GateResult {
  if (!ctx.channelId) {
    return { gate: 'channel', allowed: true };
  }
  const restrictions = TOOL_CHANNEL_RESTRICT[ctx.tool];
  if (!restrictions) {
    return { gate: 'channel', allowed: true };
  }
  for (const r of restrictions) {
    if (typeof r === 'string' && r === ctx.channelId) {
      return { gate: 'channel', allowed: false, reason: `channel '${ctx.channelId}' 不允许调 '${ctx.tool}'` };
    }
    if (r instanceof RegExp && r.test(ctx.channelId)) {
      return { gate: 'channel', allowed: false, reason: `channel '${ctx.channelId}' 匹配禁模式 ${r}` };
    }
  }
  return { gate: 'channel', allowed: true };
}

// ============================================================
// Gate 4: 速率限制 (同 tool 1min 内最多 N 次)
// ============================================================

const RATE_LIMIT_PER_MIN = 5;

export function checkRate(ctx: GateContext): GateResult {
  const recent = ctx.recentCalls ?? [];
  const now = Date.now();
  const window = 60_000;
  const sameTool = recent.filter((c) => c.tool === ctx.tool && now - c.ts < window);
  if (sameTool.length >= RATE_LIMIT_PER_MIN) {
    return {
      gate: 'rate',
      allowed: false,
      reason: `工具 '${ctx.tool}' 在 1 分钟内已被调 ${sameTool.length} 次 (上限 ${RATE_LIMIT_PER_MIN})`,
      evidence: `最近 ${sameTool.length} 次调用时间: ${sameTool.map((c) => new Date(c.ts).toISOString()).join(', ')}`,
    };
  }
  return { gate: 'rate', allowed: true };
}

// ============================================================
// Gate 5: prompt injection 检测
// ============================================================

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bignore (previous|all|above) (instructions?|prompts?)\b/i, label: 'ignore previous' },
  { re: /\b(disregard|forget) (everything|all|instructions?)\b/i, label: 'disregard' },
  { re: /\byou are now\b/i, label: 'role override' },
  { re: /\bnew instructions?:\s*\[/i, label: 'new instructions block' },
  { re: /<\|im_start\|>/, label: 'chatml tag' },
  { re: /<\|im_end\|>/, label: 'chatml tag' },
  { re: /\bSYSTEM:\s/i, label: 'system tag' },
];

export function checkInject(ctx: GateContext): GateResult {
  const concat = JSON.stringify(ctx.args);
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(concat)) {
      return {
        gate: 'inject',
        allowed: false,
        reason: `args 含 prompt injection 模式: ${label}`,
        evidence: `匹配: ${label}`,
      };
    }
  }
  return { gate: 'inject', allowed: true };
}

// ============================================================
// Gate 6: 输出审查 (tool 执行后, 审计 tool 返的字符串)
// 单独入口 auditOutput, 不是调 tool 前的 gate
// ============================================================

export function checkOutput(output: string): GateResult {
  const hit = auditToolOutput(output);
  if (!hit) {
    return { gate: 'output', allowed: true };
  }
  return {
    gate: 'output',
    allowed: hit.severity !== 'critical',
    reason: hit.reason,
    evidence: hit.evidence,
  };
}

// ============================================================
// Gate 7: 链式调用限制 (单轮最多 5 个 tool, 防 agent 循环)
// ============================================================

const MAX_TOOL_CALLS_PER_TURN = 5;

export function checkChain(ctx: GateContext): GateResult {
  const count = ctx.toolCallCountInTurn ?? 0;
  if (count >= MAX_TOOL_CALLS_PER_TURN) {
    return {
      gate: 'chain',
      allowed: false,
      reason: `单轮已调 ${count} 个 tool (上限 ${MAX_TOOL_CALLS_PER_TURN})`,
      evidence: `当前轮 tool 调用次数: ${count}`,
    };
  }
  return { gate: 'chain', allowed: true };
}

// ============================================================
// Gate 8: 黑名单 (复用 PreToolUse hook 已有 6 条规则, 重新实现于此)
// ============================================================

const DANGEROUS_CMD_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\s+\//, reason: '禁止递归删除根目录' },
  { re: /\bgit\s+push\s+.*--force\b/, reason: '禁止 force push' },
  { re: /\brm\s+-rf\s+~\//, reason: '禁止递归删除 home' },
  { re: /\bdd\s+if=.*\s+of=\/dev\//, reason: '禁止 dd 覆盖块设备' },
  { re: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: '禁止 curl|sh 直执行' },
  { re: />\s*\/dev\/sd[a-z]/, reason: '禁止写裸设备' },
];

export function checkBlacklist(ctx: GateContext): GateResult {
  if (ctx.tool !== 'shell' && ctx.tool !== 'shell_exec' && ctx.tool !== 'bash') {
    return { gate: 'blacklist', allowed: true };
  }
  const cmd = String(ctx.args.command || ctx.args.cmd || '');
  for (const { re, reason } of DANGEROUS_CMD_PATTERNS) {
    if (re.test(cmd)) {
      return { gate: 'blacklist', allowed: false, reason, evidence: cmd.substring(0, 100) };
    }
  }
  return { gate: 'blacklist', allowed: true };
}

// ============================================================
// 整合入口: 一次性跑 8-gate (除了 output gate, 那个是 post-call)
// ============================================================

export interface ToolGateCheckResult {
  allowed: boolean;
  rejectedBy?: GateId;
  reason?: string;
  /** 8-gate 各自结果, 调试用 */
  details: GateResult[];
}

const TOOL_GATES: Array<(ctx: GateContext) => GateResult> = [
  checkSchema,
  checkChannel,
  checkRate,
  checkInject,
  checkChain,  // 链式限制前置 (chain)
  checkBlacklist,
  // checkOutput 不在 tool.execute 前
];

export function runToolGates(ctx: GateContext): ToolGateCheckResult {
  const details: GateResult[] = [];
  for (const check of TOOL_GATES) {
    try {
      const r = check(ctx);
      details.push(r);
      if (!r.allowed) {
        return { allowed: false, rejectedBy: r.gate, reason: r.reason, details };
      }
    } catch (err) {
      // 静默: 任意 gate 自身挂掉 = pass (fail-open)
      console.warn(`[tool-gate] ${check.name} failed (non-fatal, allowing):`, err);
    }
  }
  return { allowed: true, details };
}

/** Post-call: 审查 tool 返的 output */
export function runOutputGate(output: string): ToolGateCheckResult {
  const r = checkOutput(output);
  return { allowed: r.allowed, rejectedBy: r.gate, reason: r.reason, details: [r] };
}
