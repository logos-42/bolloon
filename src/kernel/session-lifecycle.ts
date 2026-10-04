/**
 * session-lifecycle.ts — K10 余项: **会话生命周期端口** (把 pi-sdk 的运行/通道接线继续薄化)
 *
 * 搬走的是**规则**, 不是 I/O:
 *   · `save-session`    : 消息 → 落盘形态的映射 (role/content/toolCall/toolResult/toolCallId/timestamp/source) + key 校验
 *   · `peek-history`    : 读回后的**过滤/水合规则** (合法 role · 剔污染消息 · **保留"只有 tool call 没有正文"的合法消息**)
 *   · `resume-session`  : 同上 + 把水合结果**应用**回历史 (应用由端口做), 返回新增条数
 *   · `seed-run`        : 新一次运行的上下文种子 —— runId 来自**内核的活跃运行** (单一来源), extra 覆盖它 (**合并顺序是规则**)
 *
 * I/O (store 读写 · actor 快照 · 上下文工厂) 全部**端口注入** ⇒ 换存储 / 换 actor 实现只改注入点一处。
 *
 * 形状照抄 `run-lifecycle.ts` / `transport.ts` / `control.ts` (同一个仓库里只该有一种端口写法):
 *   端口注入 · **未注入即拒** (不静默降级) · 一律**返回结果对象不抛** · 端口用 `{ok:false}` 表达拒绝要被归一化 · 审计流水可读。
 *
 * 哪些**留在** pi-sdk: 谁在什么时候调 (入口/时机) + 端口实现 (真 store / 真 actor)。本文件不 import 任何 agent 侧模块。
 */

export type SessionOp = 'save-session' | 'peek-history' | 'resume-session' | 'seed-run';

export const SESSION_OPS: readonly SessionOp[] = ['save-session', 'peek-history', 'resume-session', 'seed-run'];

/** 哪些操作必须有会话 key (seed-run 例外: 它要的是**活跃运行**, 不是会话 key) */
export const SESSION_NEEDS_KEY: Readonly<Record<SessionOp, boolean>> = {
  'save-session': true,
  'peek-history': true,
  'resume-session': true,
  'seed-run': false,
};

export interface SessionRequest {
  op: SessionOp;
  /** 谁在写/在读 (审计): 'pi-session' / 'web' / 'test' —— 必填, 不许匿名 */
  origin: string;
  key?: string;
  /** 读回时最多取多少条 (默认 30, 与迁移前口径一致) */
  maxMessages?: number;
  /** seed-run 的额外字段 (覆盖活跃运行得到的 runId —— 合并顺序是规则, 归内核) */
  extra?: Record<string, unknown>;
}

export interface SessionPorts {
  /** 取当前历史的快照 (走 actor 邮箱的实现由注入方提供 —— 与 append 串行的语义在那边) */
  historySnapshot?(): Promise<readonly unknown[]> | readonly unknown[];
  saveMessages?(key: string, messages: readonly PersistedLike[]): Promise<unknown>;
  loadMessages?(key: string): Promise<readonly PersistedLike[] | null | undefined> | readonly PersistedLike[] | null | undefined;
  /** 把水合后的消息应用回当前历史, 返回**新增条数** (Resume 的语义在注入方) */
  applyHistory?(messages: readonly unknown[]): Promise<number> | number;
  /** 内核的活跃运行 id (单一来源) */
  activeRunId?(): string | undefined;
  /** 新建运行上下文 (工厂在注入方: 内核不 import agent 侧类型) */
  newRunContext?(runId: string | undefined, extra: Record<string, unknown>): unknown;
}

export interface SessionOutcome {
  ok: boolean;
  op: SessionOp;
  via: 'kernel-session-lifecycle';
  /** 失败原因 (ok=false 时必有) —— 不用异常表达"拒了" */
  detail?: string;
  /** 实际派发到的 port 名 (ok=true 时必有) */
  port?: string;
  /** 端口原样返回值 / 内核算出来的值 (peek 的数组 · resume 的条数 · seed 的上下文) */
  result?: unknown;
}

/** 端口**不抛异常但明确拒绝** (`{ ok: false, reason }`) 的归一化 —— 与 `control.ts` / `run-lifecycle.ts` 同口径 */
function portRefusal(res: unknown): string | null {
  if (res && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
    const r = res as { ok?: unknown; reason?: unknown };
    if (r.ok === false) return `端口拒绝: ${String(r.reason ?? '(未给原因)')}`;
  }
  return null;
}

interface AuditEntry {
  at: number;
  op: SessionOp;
  origin: string;
  target: string;
  ok: boolean;
  detail?: string;
}

const audit: AuditEntry[] = [];
const AUDIT_MAX = 200;

/** 审计流水 (最近 N 条; 测试与运维可读) */
export function sessionLifecycleAudit(): readonly AuditEntry[] {
  return audit;
}

export function resetSessionLifecycleAudit(): void {
  audit.length = 0;
}

function record(op: SessionOp, origin: string, target: string, ok: boolean, detail?: string): void {
  audit.push({ at: Date.now(), op, origin, target, ok, detail });
  if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
}

// ── 纯规则 (可单独判: 不碰 I/O) ──────────────────────────────────────────────

/** 会话 key 必须是非空字符串 —— 空 key 会让写入落到一个"共享黑洞"里, 必须当场拒 */
export function isValidSessionKey(key: unknown): key is string {
  return typeof key === 'string' && key.trim().length > 0;
}

/** 合法角色 (拒绝旧 schema `{type:'user'}` 那种没有 role 字段的) */
export const SESSION_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool', 'system']);

export interface PersistedLike {
  role: unknown;
  content: unknown;
  toolCall?: unknown;
  toolResult?: unknown;
  toolCallId?: unknown;
  timestamp?: number;
  source?: string;
}

/**
 * 落盘映射: 实时消息 → 持久形态。
 *   `timestamp` 取**写盘那一刻** (不是消息里的旧值) —— 迁移前就是这个口径, 明确保留。
 *   `source` 标记写入方 (默认 'pi-session')。
 */
export function toPersistedMessages(
  source: readonly unknown[],
  sourceTag = 'pi-session',
  now: () => number = Date.now,
): PersistedLike[] {
  const ts = now();
  return (source ?? []).map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    return {
      role: m.role,
      content: m.content,
      toolCall: m.toolCall,
      toolResult: m.toolResult,
      toolCallId: m.toolCallId,
      timestamp: ts,
      source: sourceTag,
    };
  });
}

/**
 * 读回水合 + 过滤规则 (逐字搬自 pi-sdk, 只去掉 instance 依赖)。
 * 三条"必须保留"的坑都在这:
 *   ① `content === ''` 但带 toolCall 的 assistant 消息**合法** (LLM 只输出工具调用没有正文) ⇒ 不许按"空内容"丢掉;
 *   ② 「[AI 服务调用失败]」/「[错误:」开头的污染消息要剔;
 *   ③ tool role 但没有 toolResult 的占位消息要剔。
 */
export function filterSessionMessages(loaded: readonly PersistedLike[] | null | undefined): unknown[] {
  if (!loaded) return [];
  const hydrated: unknown[] = [];
  for (const m of loaded) {
    if (!m || !SESSION_ROLES.has(String(m.role))) continue;
    if (typeof m.content === 'string' && m.content.startsWith('[AI 服务调用失败]')) continue;
    if (typeof m.content === 'string' && m.content.startsWith('[错误:')) continue;
    if (!m.content && !m.toolCall && !m.toolResult) continue;
    if (m.role === 'tool' && !m.toolResult) continue;
    hydrated.push({
      role: m.role,
      content: m.content ?? '',
      toolCall: m.toolCall,
      toolResult: m.toolResult,
      toolCallId: m.toolCallId,
    });
  }
  return hydrated;
}

/**
 * 过滤 + 截断 (取**最近** maxMessages 条) —— 给"自己不做截断"的调用方用。
 *   actor 的 `hydrateHistory(spec)` 管道自带截断 ⇒ 那边只该用 `filterSessionMessages` (别截两次)。
 */
export function hydrateSessionMessages(
  loaded: readonly PersistedLike[] | null | undefined,
  maxMessages = 30,
): unknown[] {
  const filtered = filterSessionMessages(loaded);
  const max = Number.isFinite(maxMessages) && maxMessages > 0 ? Math.floor(maxMessages) : 0;
  return max > 0 ? filtered.slice(-max) : [];
}

/**
 * 运行种子 = 活跃运行的 runId 打底 + `extra` 覆盖它 (**合并顺序是规则, 所以它归内核**)。
 *   与 `seed-run` 分支共用这一条规则; 同步调用点 (pi-sdk 的 `seedRunContext` 是同步签名) 直接调它, 不必为了合并一次规则绕异步端口。
 */
export function composeRunSeed(
  activeRunId: string | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { runId: activeRunId, ...extra };
}

// ── 派发 (唯一入口) ───────────────────────────────────────────────────────────

const missing = (what: string): string => `端口未注入: ${what} (拒绝静默降级)`;

/**
 * 会话生命周期的**唯一系统调用门**。
 *   未注入端口 / 缺 key ⇒ `{ ok:false }` (不抛); 端口抛错 ⇒ 也归一化成 `{ ok:false, detail }` (调用方按自己的响亮口径处理)。
 */
export async function submitSessionOp(request: SessionRequest, ports: SessionPorts): Promise<SessionOutcome> {
  const op = request?.op;
  const origin = String(request?.origin ?? '').trim() || 'unknown';
  const target = String(request?.key ?? '').trim() || '-';

  const fail = (detail: string): SessionOutcome => {
    record(op, origin, target, false, detail);
    return { ok: false, op, via: 'kernel-session-lifecycle', detail };
  };

  if (!SESSION_OPS.includes(op)) return fail(`未知会话操作: ${String(op)}`);
  if (!origin || origin === 'unknown') return fail('缺少 origin (审计要求, 不许匿名)');
  if (SESSION_NEEDS_KEY[op] && !isValidSessionKey(request.key)) return fail(`缺少合法会话 key (op=${op})`);

  try {
    if (op === 'save-session') {
      const key = request.key as string;
      if (!ports.saveMessages) return fail(missing('saveMessages'));
      if (!ports.historySnapshot) return fail(missing('historySnapshot'));
      const source = (await ports.historySnapshot()) ?? [];
      const persisted = toPersistedMessages(source);
      const res = await ports.saveMessages(key, persisted);
      const refusal = portRefusal(res);
      if (refusal) return fail(refusal);
      record(op, origin, target, true);
      return { ok: true, op, via: 'kernel-session-lifecycle', port: 'saveMessages', result: { count: persisted.length } };
    }

    if (op === 'peek-history') {
      const key = request.key as string;
      if (!ports.loadMessages) return fail(missing('loadMessages'));
      const loaded = await ports.loadMessages(key);
      const hydrated = hydrateSessionMessages(loaded as PersistedLike[], request.maxMessages ?? 30);
      record(op, origin, target, true);
      return { ok: true, op, via: 'kernel-session-lifecycle', port: 'loadMessages', result: hydrated };
    }

    if (op === 'resume-session') {
      const key = request.key as string;
      if (!ports.loadMessages) return fail(missing('loadMessages'));
      if (!ports.applyHistory) return fail(missing('applyHistory'));
      const loaded = await ports.loadMessages(key);
      const hydrated = hydrateSessionMessages(loaded as PersistedLike[], request.maxMessages ?? 30);
      const applied = (await ports.applyHistory(hydrated)) ?? 0;
      const refusal = portRefusal(applied);
      if (refusal) return fail(refusal);
      record(op, origin, target, true, `应用 ${hydrated.length} 条`);
      return { ok: true, op, via: 'kernel-session-lifecycle', port: 'applyHistory', result: Number(applied) || 0 };
    }

    // seed-run
    if (!ports.activeRunId) return fail(missing('activeRunId'));
    if (!ports.newRunContext) return fail(missing('newRunContext'));
    const activeRun = ports.activeRunId();
    const extra = (request.extra ?? {}) as Record<string, unknown>;
    // 合并顺序是规则: 先放活跃运行得到的 runId, 再让 extra 覆盖 (调用方显式传的优先)
    const seed = composeRunSeed(activeRun, extra);
    const ctx = ports.newRunContext(seed.runId as string | undefined, extra);
    const refusal = portRefusal(ctx);
    if (refusal) return fail(refusal);
    record(op, origin, target, true, `runId=${String(seed.runId ?? '(无)')}`);
    return { ok: true, op, via: 'kernel-session-lifecycle', port: 'newRunContext', result: ctx };
  } catch (err) {
    return fail(`端口抛错: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}

/**
 * 需要**响亮失败**的调用方 (写不进 = 事实层面没发生) 在派发后调它。
 *   与 `assertLifecycleOk` 同口径: 把 `{ok:false}` 变成抛, 而不是让调用方忘掉检查。
 */
export function assertSessionOk(out: SessionOutcome): void {
  if (!out.ok) throw new Error(`[kernel-session-lifecycle] ${out.op} 失败: ${out.detail ?? '(无原因)'}`);
}
