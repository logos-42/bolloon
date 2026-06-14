/**
 * Builtin Guards — Tool 输出审计 (4 个内置)
 *
 * 跟 harness-integration/guard-checker 互补: 后者对**文件**做静态检查,
 * 本文件对**tool 返的字符串**做动态内容审计.
 *
 * 设计原则:
 * - 任何 guard 自身挂掉 = pass (fail-open), 不阻塞主对话
 * - 每个 guard 返回 severity (critical/warning/info) + reason
 * - critical 触发 reject; warning 触发 log + 允许
 */

import * as path from 'path';
import * as os from 'os';

export type GuardSeverity = 'critical' | 'warning' | 'info';
export interface GuardHit {
  guard: string;
  severity: GuardSeverity;
  reason: string;
  /** 截断后的命中片段, 供 UI 显示 (避免泄露) */
  evidence: string;
}

const MAX_EVIDENCE = 120;

// ============================================================
// 1. no-secret-leak: tool output 不含 ~/.bolloon/iroh-secret-*.json 等
// ============================================================

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /iroh-secret-[a-zA-Z0-9_]+\.json/, label: 'iroh secret' },
  { re: /p2p-direct-secret-[a-zA-Z0-9_]+\.json/, label: 'p2p-direct secret' },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: 'private key' },
  // 通用 API key 模式 (sk- / sk-proj- / sk-ant- / ghp_ / xoxb-)
  { re: /\b(sk-(?:proj-|ant-)?[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{20,})/, label: 'API key' },
];

export function guardNoSecretLeak(output: string): GuardHit | null {
  for (const { re, label } of SECRET_PATTERNS) {
    const m = output.match(re);
    if (m) {
      return {
        guard: 'no-secret-leak',
        severity: 'critical',
        reason: `tool output 含 ${label} 模式, 可能泄露敏感凭据`,
        evidence: m[0].substring(0, MAX_EVIDENCE) + '***',
      };
    }
  }
  return null;
}

// ============================================================
// 2. no-process-escape: shell 工具的 args 不含交互式 reverse shell
// ============================================================

const ESCAPE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bbash\s+-i\b/, label: 'bash interactive' },
  // netcat listener 允许任意顺序的 -e / -l 标志
  { re: /\bnc\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[el][a-zA-Z]*\b/, label: 'netcat listener' },
  { re: /\bnc\b.*-l/, label: 'netcat listener (loose)' },
  { re: /\bpython[23]?\s+-c\s+["'].*import\s+socket.*subprocess/m, label: 'python reverse shell' },
  { re: /`[^`]+`/, label: 'backtick exec' },  // 简单检测
  { re: /\$\(\s*curl\b/, label: 'command sub + curl' },
];

export function guardNoProcessEscape(args: Record<string, unknown>): GuardHit | null {
  const cmd = String(args.command || args.cmd || '');
  for (const { re, label } of ESCAPE_PATTERNS) {
    if (re.test(cmd)) {
      return {
        guard: 'no-process-escape',
        severity: 'critical',
        reason: `shell 参数含 ${label} 模式, 可能建立 reverse shell`,
        evidence: cmd.substring(0, MAX_EVIDENCE),
      };
    }
  }
  return null;
}

// ============================================================
// 3. no-network-leak: tool args 不含外网 URL (除非 userInput 明确表示要发外网)
// ============================================================

/**
 * 简单检测: http(s)://外网域名 (非 localhost / 127.0.0.1 / 内网 IP)
 */
const URL_RE = /\bhttps?:\/\/([a-zA-Z0-9.-]+)/g;
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

export function guardNoNetworkLeak(args: Record<string, unknown>): GuardHit | null {
  const cmd = String(args.command || args.cmd || args.url || '');
  const matches = [...cmd.matchAll(URL_RE)];
  for (const m of matches) {
    const host = m[1];
    if (!ALLOWED_HOSTS.has(host) && !host.endsWith('.local')) {
      return {
        guard: 'no-network-leak',
        severity: 'warning',  // 警告而非 critical — LLM 可能确实要发外网
        reason: `检测到外网 URL: ${host}`,
        evidence: m[0].substring(0, MAX_EVIDENCE),
      };
    }
  }
  return null;
}

// ============================================================
// 4. no-recursive-tool: tool args 不含调用 tool 的迹象
// ============================================================

const TOOL_NAME_HINTS = ['tool', 'mcp_', 'pi_ecosystem', 'bollharness'];
const RECURSIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bexec(?:ute)?[_(tool|shell_exec|bash)\b]/, label: 'recursive tool call' },
  { re: /\bdispatch_to_agent\b/, label: 'agent dispatch loop' },
];

export function guardNoRecursiveTool(args: Record<string, unknown>): GuardHit | null {
  const cmd = JSON.stringify(args);
  for (const hint of TOOL_NAME_HINTS) {
    // args 里引用 tool 调用名是合理的 (e.g. description), 只看递归模式
  }
  for (const { re, label } of RECURSIVE_PATTERNS) {
    if (re.test(cmd)) {
      return {
        guard: 'no-recursive-tool',
        severity: 'warning',
        reason: `检测到 ${label} 模式, agent 可能进入死循环`,
        evidence: cmd.substring(0, MAX_EVIDENCE),
      };
    }
  }
  return null;
}

// ============================================================
// 聚合入口: 给一个 tool 调用的 args, 跑所有 guard
// ============================================================

export interface BuiltinGuardResult {
  hits: GuardHit[];
  /** critical hit 数, 0 = 通过, >0 = 拒绝 */
  criticalCount: number;
}

export function runBuiltinGuards(args: Record<string, unknown>): BuiltinGuardResult {
  const hits: GuardHit[] = [];
  hits.push(...compact([guardNoProcessEscape(args), guardNoNetworkLeak(args), guardNoRecursiveTool(args)]));
  const criticalCount = hits.filter((h) => h.severity === 'critical').length;
  return { hits, criticalCount };
}

/** Tool output 审计 (secret leak) — 单独入口, 不在 args guard 里 */
export function auditToolOutput(output: string): GuardHit | null {
  return guardNoSecretLeak(output);
}

function compact<T>(arr: Array<T | null | undefined>): T[] {
  return arr.filter((x): x is T => x !== null && x !== undefined);
}
