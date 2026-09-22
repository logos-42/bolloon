/**
 * protocol-envelope.ts — P3 统一输出层 (P1 §2 冻结 JSON 信封 + §3 错误码 + §2.3 next_action 词表)
 *
 * 权威口径: `docs/wiki/access-protocol-v1.md`。本文件**只做四件事**, 不含任何业务逻辑:
 *   ① 全局选项解析: `--json` / `--quiet` / `--request-id <id>` / `--timeout <ms>`
 *   ② 信封构造: `{ ok, code, message, data, evidence, next_action }` (字段顺序与 §2 一致)
 *   ③ 输出: `--json` 信封 · `--quiet` 只出结果 · 默认人类可读 (既有体验是基线, 不许坏)
 *   ④ 兜底: 超时/异常也必须是**结构化失败** (§2 硬规则 1); 私钥类字段一律不进 stdout
 *
 * 2026-09-21 (P3): 此前 `src/` 里**没有任何** §3 错误码常量 (P1 §0 表逐条核对过) —— 本文件把它们落成常量。
 *
 * 三条不许破的规矩 (P1 §2 硬规则):
 *   1. 成功和失败都必须结构化 —— 失败也要 `ok:false` + `code` + `next_action`
 *   2. "已付款" ≠ "任务成功" —— `paid`/`delivered` 都不是成功; 成功判据是 §5.2 (任务层: state=verified ∧ 事实∈{fully_settled,payment_verified})
 *   3. 客户端必须忽略未知 `code` —— 所以本文件新增的码是**追加**, 不改任何冻结码的含义
 */

import { AUDIT_FORBIDDEN_KEYS } from '../agents/task-contract.js';

// ── §3 冻结错误码 (字面量与 P1 表逐条一致; 改含义 = 必须 bump 协议版本) ──────────

/** P1 §3 表里的码 (含成功码)。这些的含义**冻结**, 不许在 CLI 层重新解释。 */
export const FROZEN_CODES = [
  'TASK_SUBMITTED', 'TASK_ACCEPTED', 'TASK_COMPLETED', 'TASK_VERIFIED',
  'PAYMENT_REQUIRED', 'PAYMENT_PENDING', 'POLICY_DENIED', 'BUDGET_EXCEEDED',
  'NETWORK_NOT_JOINED', 'CAPABILITY_NOT_FOUND', 'RESULT_UNVERIFIED',
  'PROTOCOL_VERSION_UNSUPPORTED', 'PAYMENT_UNCERTAIN', 'DUPLICATE_REQUEST',
  'TASK_TRANSITION_REJECTED', 'SIGNATURE_REQUIRED', 'SIGNATURE_INVALID',
  'DEADLINE_EXPIRED', 'WALLET_UNAVAILABLE', 'AGENT_NOT_AUTHORIZED',
  'LOCAL_DEV_NOT_CHAIN', 'DISPUTE_OPEN', 'DELIVERY_FAILED',
] as const;

/**
 * P3 新增码 (P1 §1.3「新增错误码不 bump 版本」允许; 老客户端按 `ok:false` + `next_action` 处理, 不崩不猜)。
 * 只加**表里确实没有对应语义**的: 命令组自身的成败、参数错、找不到、超时、未实现。
 */
export const CLI_CODES = [
  // 命令组成功码
  'OK', 'NETWORK_JOINED', 'NETWORK_NODE_READY', 'AGENT_REGISTERED',
  'POLICY_UPDATED', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'RECOVERY_PLANNED',
  'WALLET_SIGNED', 'TASK_DELIVERED',
  // 任务态里 §3 没有单列的终态 (字面量取自冻结的 14 态状态机)
  'TASK_REJECTED', 'TASK_FAILED', 'TASK_CANCELLED',
  // 传输层 (§1.3「新增错误码不 bump 版本」): 帧没送到 / 没有可用传输
  'TRANSPORT_UNAVAILABLE', 'TRANSPORT_FAILED',
  // P6 链命令组的新增码 (append-only; 表里确实没有对应语义才加):
  //   配置/可达性/结论未定/链上回滚/找不到 escrow/资金不足/未授权/重组可疑
  'CHAIN_NOT_CONFIGURED', 'CHAIN_UNAVAILABLE', 'CHAIN_UNCERTAIN', 'CHAIN_TX_REVERTED',
  'ESCROW_NOT_FOUND', 'INSUFFICIENT_FUNDS', 'NOT_AUTHORIZED', 'REORG_SUSPECTED',
  // 2026-09-22 (P5 修正): **索引身份变更** (换合约部署 / anvil 重启换链实例) —— 这**不是重组**,
  //   混进 REORG_SUSPECTED 会把人引到错的方向 (去查分叉, 而真因是索引属于另一个合约/另一条链)。
  'INDEX_IDENTITY_CHANGED',
  // 通用失败码
  'C_NOT_IMPLEMENTED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'TIMEOUT', 'INTERNAL_ERROR',
] as const;

export type Code = (typeof FROZEN_CODES)[number] | (typeof CLI_CODES)[number];

/** §2.3 受控词表。`verify_result` 出现在 §3 表 (TASK_COMPLETED 行) 但 §2.3 表漏列 —— 以 §3 为准。 */
export const NEXT_ACTIONS = [
  'reconcile', 'approve_payment', 'needs_human', 'retry_same_request',
  'rejoin_network', 'redefine_capability', 'raise_budget', 'upgrade_client',
  'wait', 'verify_result',
] as const;
/** 带参数的词表项 (字面量在 payment-recovery.ts:299-300) */
export const NEXT_ACTION_PARAM_PREFIXES = ['x402_payment_retry:', 'x402_continue:'] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number] | `${(typeof NEXT_ACTION_PARAM_PREFIXES)[number]}${string}` | null;

// ── 全局选项 ────────────────────────────────────────────────────────────────

export interface CliFlags {
  /** `--json`: 输出完整信封 */
  json: boolean;
  /** `--quiet`: 只输出结果 (payload), 无信封无颜色 */
  quiet: boolean;
  /** `--request-id <id>`: 幂等键原样透传 (用在真实做幂等查找/派生的命令上) */
  requestId?: string;
  /** `--timeout <ms>`: 硬超时; 超时也要给结构化失败 (TIMEOUT) */
  timeoutMs?: number;
  /** 非选项参数 */
  positionals: string[];
  /** 具名选项 (可重复的收集成数组) */
  options: Map<string, string[]>;
  /** 原始参数 */
  raw: string[];
}

/** 带值的选项 (解析时要知道下一个 token 是不是值) */
const OPTIONS_WITH_VALUE = new Set([
  '--request-id', '--timeout', '--budget', '--per-purchase', '--daily', '--input',
  '--capability', '--name', '--price', '--per', '--description', '--wallet', '--endpoint',
  '--link', '--url', '--instruction', '--provider', '--amount', '--currency', '--network',
  '--per-tx', '--allow-recipient', '--allow-service', '--rate-limit', '--reason',
  // 2026-09-21 (P3 收尾): bolloon-task/1 真收发 + wallet sign 用到的选项
  '--payload', '--message', '--mode', '--task-id', '--deadline', '--salt', '--reply-to',
  '--peer', '--via', '--eta', '--deliver',
  // 2026-09-22 (P6): `bolloon chain` 用的选项 (只加链命令组自己的名字, 不改既有布尔开关的解析)
  '--task-key', '--agent', '--asset', '--result', '--manifest-digest',
  '--confirmation-window', '--proof-version', '--from-block', '--gate',
  // 2026-09-22 (P6b): 链上**写**操作的**授权意图**声明 (MCP 写 tool 必填; 只可能收紧, 不可能放权)
  '--payment-mode',
]);

export function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { json: false, quiet: false, positionals: [], options: new Map(), raw: args };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { flags.json = true; continue; }
    if (a === '--quiet' || a === '-q') { flags.quiet = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(0, eq) : a;
      let value = eq > 0 ? a.slice(eq + 1) : undefined;
      if (value === undefined && OPTIONS_WITH_VALUE.has(key) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
        value = args[++i];
      }
      const list = flags.options.get(key) || [];
      list.push(value === undefined ? 'true' : value);
      flags.options.set(key, list);
      continue;
    }
    flags.positionals.push(a);
  }
  const rid = flags.options.get('--request-id')?.[0];
  if (rid && rid !== 'true') flags.requestId = rid;
  const t = flags.options.get('--timeout')?.[0];
  if (t && t !== 'true') {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) flags.timeoutMs = Math.floor(n);
  }
  return flags;
}

/** 取单个选项值 (取最后一次出现的) */
export function opt(flags: CliFlags, name: string): string | undefined {
  const v = flags.options.get(name)?.slice(-1)[0];
  return v === 'true' ? undefined : v;
}
/** 取可重复选项的全部值 */
export function optAll(flags: CliFlags, name: string): string[] {
  return (flags.options.get(name) || []).filter((v) => v !== 'true');
}
export function has(flags: CliFlags, name: string): boolean {
  return flags.options.has(name);
}

// ── 信封 ────────────────────────────────────────────────────────────────────

/** P1 §2.1 冻结信封 */
export interface Envelope {
  ok: boolean;
  code: Code;
  message: string;
  data: Record<string, unknown>;
  evidence: string[];
  next_action: NextAction;
}

export interface CommandResult {
  envelope: Envelope;
  /** 人类可读输出 (默认模式用; `--json`/`--quiet` 下忽略) */
  human: string;
}

export function okEnvelope(code: Code, message: string, data: Record<string, unknown> = {}, evidence: string[] = [], next_action: NextAction = null): Envelope {
  return { ok: true, code, message, data, evidence, next_action };
}

export function failEnvelope(code: Code, message: string, data: Record<string, unknown> = {}, evidence: string[] = [], next_action: NextAction = null): Envelope {
  return { ok: false, code, message, data, evidence, next_action };
}

/**
 * 按"这个码是不是成功码"决定 `ok` (P1 §2.1: `ok` 是唯一分派位; §3 表把成功码与失败码分开)。
 * 状态类命令用它: 例如 `policy_denied` 必须是 `ok:false` —— 不许让客户端把被拒当成完成。
 */
export function envelopeForState(ok: boolean, code: Code, message: string, data: Record<string, unknown> = {}, evidence: string[] = [], next_action: NextAction = null): Envelope {
  return ok ? okEnvelope(code, message, data, evidence, next_action) : failEnvelope(code, message, data, evidence, next_action);
}

/** `C_NOT_IMPLEMENTED` 的统一说法: 如实说没实现 + 指出现成可用的替代路径 (绝不假装成功) */
export function notImplemented(message: string, data: Record<string, unknown> = {}): Envelope {
  return failEnvelope(
    'C_NOT_IMPLEMENTED',
    message,
    { reason: message, ...data },
    [],
    'upgrade_client',
  );
}

/**
 * 私钥类字段兜底剥离 (P1 §5.5): 复用契约层的 `AUDIT_FORBIDDEN_KEYS`
 * (`privateKey`/`secret`/`instruction`/`taskText`/`mnemonic`/`seed`) —— 绝不让它们进 stdout。
 * 命中即替换成 `[redacted]`, 并**不静默**: 顶层补 `redacted_fields` 供审计。
 */
export function redactSecrets(value: unknown, hits: string[] = [], path = '$'): unknown {
  if (Array.isArray(value)) return value.map((v, i) => redactSecrets(v, hits, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AUDIT_FORBIDDEN_KEYS.includes(k)) { hits.push(`${path}.${k}`); out[k] = '[redacted]'; continue; }
      out[k] = redactSecrets(v, hits, `${path}.${k}`);
    }
    return out;
  }
  return value;
}

/** 收敛成冻结字段顺序 + 兜底剥离 (所有对外输出都必须过这里) */
export function finalizeEnvelope(env: Envelope, flags?: CliFlags): Envelope {
  const hits: string[] = [];
  const data = redactSecrets(env.data || {}, hits) as Record<string, unknown>;
  if (hits.length) data.redacted_fields = hits;
  // `--request-id`: 幂等键原样透传/回显 (真实用它的命令会把它写进自己的查询路径)
  if (flags?.requestId && data.requestId === undefined) data.requestId = flags.requestId;
  return {
    ok: env.ok,
    code: env.code,
    message: env.message,
    data,
    evidence: Array.isArray(env.evidence) ? env.evidence : [],
    next_action: env.next_action ?? null,
  };
}

/** 老命令 (task/trace/p2p/x402) 的 `--json`: **保留既有顶层键** (基线兼容), 追加 §2 的 code/message/evidence/next_action */
export function legacyJson(payload: Record<string, unknown>, extra: { code: Code; message: string; evidence?: string[]; next_action?: NextAction }): Record<string, unknown> {
  const hits: string[] = [];
  const redacted = redactSecrets({ ...payload, code: extra.code, message: extra.message, evidence: extra.evidence || [], next_action: extra.next_action ?? null }, hits) as Record<string, unknown>;
  if (hits.length) redacted.redacted_fields = hits;
  return redacted;
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
// 与 cli-entry.ts 同一套 truecolor (#ef4444 / #c4d640) —— 注意必须写成十进制 RGB, 不能写 0x 字面量
const RED = '\x1b[38;2;239;68;68m';
const CYAN = '\x1b[38;2;196;214;64m';

/**
 * 打印命令结果并给出退出码 (0/1)。
 * · `--json`  → 完整信封 (2 空格缩进, 字段顺序与 §2 一致)
 * · `--quiet` → 只出结果 (payload 的 JSON)
 * · 默认      → 人类可读 (命令自带); 失败时补一行 机器可读的 code/next_action, 方便不解析 JSON 也能分派
 */
export function emit(env: Envelope, flags: CliFlags, human = ''): number {
  const e = finalizeEnvelope(env, flags);
  if (flags.json) {
    console.log(JSON.stringify(e, null, 2));
  } else if (flags.quiet) {
    console.log(JSON.stringify(e.data));
  } else {
    if (human.trim()) console.log(human.trimEnd());
    if (!e.ok) console.log(`\n${RED}✗ ${e.message}${RESET}\n  code=${e.code}  next_action=${e.next_action ?? 'null'}`);
  }
  return e.ok ? 0 : 1;
}

/** 异常兜底: 任何没被命令自己处理的错都变成结构化失败 (§2 硬规则 1) */
export function errorEnvelope(err: unknown): Envelope {
  const msg = String((err as any)?.message || err).slice(0, 300);
  return failEnvelope('INTERNAL_ERROR', `命令内部异常: ${msg}`, { error: msg }, [], 'needs_human');
}

/**
 * 跑一条命令: 统一套 `--timeout` (§ 超时也是结构化失败) 与异常兜底, 但**不打印**。
 * 2026-09-21 (P4): 从 `runCommand` 抽出 —— MCP 适配层要的是信封本身 (它不能往 stdout 打字,
 * stdout 是 JSON-RPC 流), 而超时/异常兜底必须与 CLI 是同一条实现 (绝不允许两套语义)。
 */
export async function commandResult(flags: CliFlags, fn: (f: CliFlags) => Promise<CommandResult>): Promise<CommandResult> {
  try {
    if (flags.timeoutMs) return await raceTimeout(fn(flags), flags.timeoutMs);
    return await fn(flags);
  } catch (err) {
    if (err instanceof CommandTimeout) {
      return {
        envelope: failEnvelope('TIMEOUT', `命令超时 (--timeout ${flags.timeoutMs}ms): 已经处理的部分结果没有落盘保证`, { timeoutMs: flags.timeoutMs ?? null }, [], 'retry_same_request'),
        human: '',
      };
    }
    return { envelope: errorEnvelope(err), human: '' };
  }
}

/**
 * 跑一条命令: 统一套 `--timeout` (§ 超时也是结构化失败) 与异常兜底, 然后按 `--json`/`--quiet`/默认输出。
 * 返回进程退出码 (0 = ok, 1 = 失败; 但**判据永远是 `ok`/`code`, 不是退出码**)。
 */
export async function runCommand(flags: CliFlags, fn: (f: CliFlags) => Promise<CommandResult>): Promise<number> {
  const result = await commandResult(flags, fn);
  return emit(result.envelope, flags, result.human);
}

class CommandTimeout extends Error {
  constructor() { super('command timeout'); this.name = 'CommandTimeout'; }
}

function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new CommandTimeout()); } }, ms);
    work.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } })
      .catch((e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

/** 人类可读输出的小工具 (与 cli-entry.ts 的配色一致) */
export const tone = { reset: RESET, bold: BOLD, red: RED, cyan: CYAN };
/** 把带 ANSI 色的帮助文本变成纯文本 (放进 `--json` 的 data 里时必须先过它) */
export function plain(t: string): string {
  // eslint-disable-next-line no-control-regex
  return String(t).replace(/\u001b\[[0-9;]*m/g, '');
}

export function line(label: string, value: string | number | boolean | undefined | null): string {
  return `  ${String(label).padEnd(14)} ${value === undefined || value === null || value === '' ? '(无)' : String(value)}`;
}
export function title(t: string): string {
  return `\n${BOLD}${t}${RESET}`;
}
export function hint(t: string): string {
  return `${CYAN}${t}${RESET}`;
}

/** 一行内看结论的失败摘要 (人读模式常用) */
export function failHuman(head: string, env: { code: Code; message: string; next_action: NextAction }): string {
  return `${head}\n  原因: ${env.message}\n  code: ${env.code} · 下一步: ${env.next_action ?? '无需额外动作'}`;
}

// ── 状态映射 (P1 §4: 内部态 → 对外 4 态; 内部态一个字都不改) ─────────────────

/**
 * 对外状态口径 (P1 §4)。§4 把内部 5 个 `HumanStatus` 合并成 4 态 (`report-card.ts:15`),
 * 逐行映射里出现的字面量就是下面这几个 —— 内部态本身一个字都不改。
 */
export type PublicStatus = '准备中' | '正在获取能力' | '正在执行' | '已完成' | '需要你处理' | '已完成或需要你处理';


/** 任务 14 态 (§4.1) → 对外 4 态 */
export function publicStatusForTask(state: string, nextAction?: NextAction): PublicStatus {
  switch (state) {
    case 'discovered':
    case 'quoted':
      return '准备中';
    case 'submitted':
    case 'accepted':
    case 'paid':
      return '正在获取能力';
    case 'paying':
      return nextAction === 'reconcile' ? '需要你处理' : '正在获取能力';
    case 'payment_required':
    case 'policy_denied':
    case 'rejected':
    case 'failed':
    case 'cancelled':
      return '需要你处理';
    case 'running':
      return '正在执行';
    case 'delivered':
      return '已完成或需要你处理';
    case 'verified':
      return '已完成';
    default:
      return '需要你处理';
  }
}

/** 交易 11 态 (§4.2) → 对外 4 态 */
export function publicStatusForTrade(status: string, nextAction?: NextAction): PublicStatus {
  switch (status) {
    case 'discovered':
    case 'quoted':
      return '准备中';
    case 'paying':
    case 'settled':
      return nextAction === 'reconcile' ? '需要你处理' : '正在获取能力';
    case 'delivered':
      return '已完成或需要你处理';
    case 'verified':
      return '已完成';
    case 'payment_required':
    case 'policy_denied':
    case 'delivery_failed':
    case 'verification_failed':
    case 'disputed':
    case 'failed':
      return '需要你处理';
    default:
      return '需要你处理';
  }
}

/**
 * 交易记录的对外口径 —— **local-dev 一律标 `local-dev`, 绝不冒充链上** (P1 §5.1 第 3 条)。
 * `success` 用 §7.1 的判据: `status==='verified'` ∧ 事实 ∈ {fully_settled, payment_verified}。
 */
export function settlementLabel(rec: { paymentMode?: string; chainSettled?: boolean; settlementFact?: string }): 'chain' | 'local-dev' | 'none' {
  if (rec.paymentMode === 'local-dev') return 'local-dev';
  if (rec.chainSettled === true && ['payment_verified', 'partially_settled', 'fully_settled'].includes(String(rec.settlementFact || ''))) return 'chain';
  return 'none';
}

export function isTradeSuccessful(rec: { status?: string; settlementFact?: string }): boolean {
  return String(rec.status) === 'verified' && ['fully_settled', 'payment_verified'].includes(String(rec.settlementFact || ''));
}
