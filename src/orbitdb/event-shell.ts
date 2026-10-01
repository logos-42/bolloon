/**
 * event-shell.ts — 智能体事件网络的「统一事件外壳」(P2, 2026-10-01)
 *
 * 目标 (docs/wiki/agent-event-network-plan.md §P2):
 *   把 message / delegation / proposal / vote / result / observation / payment / task /
 *   discovery / error 统一成**一种**事件信封; 事件本体只放 **元数据 + CID**(大内容按 CID 惰性取,
 *   与 `cid-database.ts` 的 lazily-fetch 一致)。
 *
 * 四条硬要求 (每条都能被 `scripts/verify-event-index.ts` 真跑出来, 不是注释里的承诺):
 *
 *   ① 严格校验, 不默许:
 *      未知 type / 缺必填 / summary 超预算 / topic·capability 超长 / cid 不是合法 CID
 *      → `inspectEvent` 逐条报 issue, `validateEvent` 直接抛 `EventValidationError`。
 *      (「默认值时隐式补一个空串然后照常放行」正是本文件要避免的"默许"。)
 *
 *   ② 时间非单调必须报出来:
 *      单条事件谈不上"单调", 所以单调性只在**流**上判: `checkMonotonicTs(events)` 给 issue 列表,
 *      `inspectEventStream(raws, { monotonic: 'enforce' })` 把它算进 `ok`,
 *      `assertMonotonicTs(events)` 抛 `TS_NOT_MONOTONIC`。
 *      默认 `monotonic:'report'` —— 如实报出但不算失败, 因为**多写者合并后的流本来就不保证全局单调**
 *      (强行要求会让合法数据永远读不进来)。"如实报" ≠ "强行禁止"。
 *
 *   ③ canonical 序列化(键排序) —— 内容寻址的地基:
 *      `canonicalJson(v)` 递归键排序 + 丢弃 undefined (dag-cbor 编不了 undefined);
 *      **非有限数字直接抛**, 拒绝 `JSON.stringify` 那种把 NaN/Infinity 静默变成 null 的行为。
 *      于是同一语义事件在**任何库 / 任何进程**里序列化出来的字节相同 ⇒ `eventCid` 可作为事件 id。
 *
 *   ④ 向后兼容: 老记录 (cid-database.ts 的 `CIDRecord`: memory/context/state/ui/knowledge,
 *      字段是 `{id, agentId, timestamp, type, content, metadata, version, parentId?}`)
 *      走 `readEvent` 自动映射成外壳; **缺的字段逐条报 warning**, 不假装老记录本来就有。
 */

import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';

/** 外壳版本 (加字段/改语义时 +1; 读侧对更高版本报 UNSUPPORTED_VERSION, 不静默降级) */
export const EVENT_SHELL_VERSION = 1;

/** 统一事件类型 (P2 要求至少覆盖这十种) */
export const EVENT_TYPES = [
  'message',
  'delegation',
  'proposal',
  'vote',
  'result',
  'observation',
  'payment',
  'task',
  'discovery',
  'error',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 引用关系 (refs[]): 只放 id, 绝不放正文 */
export const REF_TYPES = ['event', 'cid', 'did', 'group', 'external'] as const;
export type RefType = (typeof REF_TYPES)[number];
export type RefRel = 'parent' | 'reply-to' | 'caused-by' | 'refers-to' | 'votes-on' | 'targets' | 'produced-by';

export interface EventRef {
  type: RefType;
  /** 被引用者的标识 (事件 id / CID / DID / 群名)。**不校验格式** —— 标识空间会演进, 只要求非空 */
  id: string;
  /** 关系语义 (可选; 用 `Rel` 里的取值, 但留 string 以便演进) */
  rel?: string;
}

/**
 * 统一事件外壳。
 * 必填: v / id / type / actor / actorId / group / ts / summary
 * 可选: refs (缺省 []), topic, capability, cid, metadata
 * 注意: 外壳里**没有 content 字段** —— 正文只在 IPFS 里, 外壳只带 `cid`。
 */
export interface EventShell {
  /** 外壳版本 */
  v: number;
  /** 事件 id (内容寻址: `await eventCid(不含 id 的外壳)`; 同语义同 id) */
  id: string;
  type: EventType;
  /** 人类可读的 actor 名 (agent 名 / 昵称) */
  actor: string;
  /** DID-ish 身份标识 (授权/验签用) */
  actorId: string;
  /** 事件所属群 / store 名 */
  group: string;
  /** 事件时间 (ms since epoch) */
  ts: number;
  /** 引用 (父事件 / 触发者 / 目标…); 只放 id */
  refs: EventRef[];
  /** 索引维度一: 主题 */
  topic?: string;
  /** 索引维度二: 能力 (这个事件需要/提供了什么能力) */
  capability?: string;
  /** 短摘要 —— 索引里放的就是它。**上限 MAX_SUMMARY_LEN**, 由校验强制 */
  summary: string;
  /** 正文 CID (大内容在 IPFS; 按需 `load(cid)` 取) */
  cid?: string;
  /** 非索引元数据 (外壳里不参与内容寻址之外的语义) */
  metadata?: Record<string, unknown>;
}

/** 建新事件时的入参 (id 可省 —— `buildEvent` 会算) */
export type NewEventInput = Omit<EventShell, 'id' | 'v' | 'refs'> & {
  v?: number;
  refs?: EventRef[];
  /** 正文 (会被算成 cid; 不进外壳) */
  content?: unknown;
};

/** 必填字段 (缺一个就是 issue; refs 不在其中 —— 默认 []) */
export const REQUIRED_FIELDS = ['v', 'id', 'type', 'actor', 'actorId', 'group', 'ts', 'summary'] as const;

/** 摘要上限 (索引里只允许出现的有界摘要; 正文超预算的部分绝不进索引) */
export const MAX_SUMMARY_LEN = 160;

/** topic / capability 长度上限 (它们会变成索引 key 的一部分) */
export const MAX_LABEL_LEN = 120;

// ─────────────────────────────── 校验 ───────────────────────────────

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export class EventValidationError extends Error {
  readonly code: string;
  readonly issues: ValidationIssue[];
  constructor(code: string, issues: ValidationIssue[], message?: string) {
    const head = issues[0] ? `${issues[0].field}: ${issues[0].message}` : '无细节';
    super(message ?? `事件校验失败 [${code}] (${issues.length} 条): ${head}`);
    this.name = 'EventValidationError';
    this.code = code;
    this.issues = issues;
  }
}

export interface InspectResult {
  ok: boolean;
  event?: EventShell;
  issues: ValidationIssue[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function isKnownEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

/** 是不是一个合法 CID (bafy… / bafk… 等; 不合法就 false, 不抛) */
export function isCid(s: unknown): boolean {
  if (typeof s !== 'string' || !s.length) return false;
  try {
    CID.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * 严格校验一个**新外壳**。返回 issue 列表而不是抛 —— 调用方自己决定报/抛。
 * `strictUnknownFields`: 未知顶层字段也报 issue (默认关 —— 前向兼容: 未来版本加的字段不该让旧读侧拒收)。
 */
export function inspectEvent(raw: unknown, opts?: { strictUnknownFields?: boolean }): InspectResult {
  const issues: ValidationIssue[] = [];
  const push = (field: string, code: string, message: string): void => {
    issues.push({ field, code, message });
  };

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ field: '(root)', code: 'NOT_OBJECT', message: `事件必须是对象, 实际是 ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}` }] };
  }

  // v
  if (!('v' in raw)) push('v', 'MISSING_FIELD', '缺外壳版本 v');
  else if (typeof raw.v !== 'number' || !Number.isInteger(raw.v)) push('v', 'BAD_FIELD_TYPE', `v 必须是整数, 实际 ${JSON.stringify(raw.v)}`);
  else if (raw.v < 1) push('v', 'BAD_VALUE', `v 必须 ≥1, 实际 ${raw.v}`);
  else if (raw.v > EVENT_SHELL_VERSION) push('v', 'UNSUPPORTED_VERSION', `外壳版本 ${raw.v} 高于本代码支持的 ${EVENT_SHELL_VERSION}`);

  // id
  if (!('id' in raw)) push('id', 'MISSING_FIELD', '缺事件 id');
  else if (!isNonEmptyString(raw.id)) push('id', 'BAD_FIELD_TYPE', 'id 必须是非空字符串');

  // type
  if (!('type' in raw)) push('type', 'MISSING_FIELD', '缺事件 type');
  else if (typeof raw.type !== 'string') push('type', 'BAD_FIELD_TYPE', `type 必须是字符串, 实际 ${typeof raw.type}`);
  else if (!isKnownEventType(raw.type)) push('type', 'UNKNOWN_TYPE', `未知事件类型 ${JSON.stringify(raw.type)}; 已知: ${EVENT_TYPES.join('/')}`);

  // actor / actorId / group
  for (const f of ['actor', 'actorId', 'group'] as const) {
    if (!(f in raw)) push(f, 'MISSING_FIELD', `缺 ${f}`);
    else if (!isNonEmptyString(raw[f])) push(f, 'BAD_FIELD_TYPE', `${f} 必须是非空字符串`);
  }

  // ts
  if (!('ts' in raw)) push('ts', 'MISSING_FIELD', '缺时间戳 ts');
  else if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) push('ts', 'BAD_FIELD_TYPE', `ts 必须是有限数字, 实际 ${JSON.stringify(raw.ts)}`);
  else if (raw.ts < 0) push('ts', 'BAD_VALUE', `ts 不能为负, 实际 ${raw.ts}`);

  // summary (有界)
  if (!('summary' in raw)) push('summary', 'MISSING_FIELD', '缺摘要 summary');
  else if (typeof raw.summary !== 'string') push('summary', 'BAD_FIELD_TYPE', 'summary 必须是字符串');
  else if (raw.summary.length > MAX_SUMMARY_LEN) push('summary', 'SUMMARY_TOO_LONG', `summary ${raw.summary.length} 字 > 上限 ${MAX_SUMMARY_LEN} (摘要必须是有界的, 否则索引里就装进正文了)`);

  // topic / capability (非空 + 有界)
  for (const f of ['topic', 'capability'] as const) {
    const v = raw[f];
    if (v === undefined || v === null) continue;
    if (!isNonEmptyString(v)) push(f, 'BAD_FIELD_TYPE', `${f} 若出现必须是非空字符串`);
    else if (v.length > MAX_LABEL_LEN) push(f, 'LABEL_TOO_LONG', `${f} ${v.length} 字 > 上限 ${MAX_LABEL_LEN}`);
  }

  // cid (正文 CID) —— 出现就必须真能 parse
  if (raw.cid !== undefined && raw.cid !== null) {
    if (!isNonEmptyString(raw.cid)) push('cid', 'BAD_FIELD_TYPE', 'cid 必须是非空字符串');
    else if (!isCid(raw.cid)) push('cid', 'INVALID_CID', `cid 不是合法 CID: ${String(raw.cid).slice(0, 80)}`);
  }

  // refs
  const refs: EventRef[] = [];
  if (raw.refs !== undefined && raw.refs !== null) {
    if (!Array.isArray(raw.refs)) push('refs', 'BAD_FIELD_TYPE', 'refs 必须是数组');
    else {
      raw.refs.forEach((r: unknown, i: number) => {
        if (!isPlainObject(r)) return push(`refs[${i}]`, 'BAD_REF', '引用必须是对象');
        if (!isNonEmptyString(r.id)) return push(`refs[${i}].id`, 'BAD_REF', '引用 id 必须是非空字符串');
        if (!isNonEmptyString(r.type)) return push(`refs[${i}].type`, 'BAD_REF', '引用 type 必须是非空字符串');
        if (!(REF_TYPES as readonly string[]).includes(r.type as string)) {
          return push(`refs[${i}].type`, 'BAD_REF', `引用 type ${JSON.stringify(r.type)} 不在 ${REF_TYPES.join('/')}`);
        }
        if (r.rel !== undefined && !isNonEmptyString(r.rel)) return push(`refs[${i}].rel`, 'BAD_REF', 'rel 若出现必须是非空字符串');
        const ref: EventRef = { type: r.type as RefType, id: r.id as string };
        if (r.rel !== undefined) ref.rel = r.rel as string;
        refs.push(ref);
      });
    }
  }

  // metadata
  if (raw.metadata !== undefined && raw.metadata !== null && !isPlainObject(raw.metadata)) {
    push('metadata', 'BAD_FIELD_TYPE', 'metadata 必须是对象');
  }

  // 未知顶层字段 (可选严格)
  if (opts?.strictUnknownFields) {
    const known = new Set<string>([...REQUIRED_FIELDS, 'refs', 'topic', 'capability', 'cid', 'metadata']);
    for (const k of Object.keys(raw)) if (!known.has(k)) push(k, 'UNKNOWN_FIELD', `未知顶层字段 ${k}`);
  }

  if (issues.length) return { ok: false, issues };

  const event: EventShell = {
    v: raw.v as number,
    id: raw.id as string,
    type: raw.type as EventType,
    actor: raw.actor as string,
    actorId: raw.actorId as string,
    group: raw.group as string,
    ts: raw.ts as number,
    refs,
    summary: raw.summary as string,
  };
  if (raw.topic !== undefined && raw.topic !== null) event.topic = raw.topic as string;
  if (raw.capability !== undefined && raw.capability !== null) event.capability = raw.capability as string;
  if (raw.cid !== undefined && raw.cid !== null) event.cid = raw.cid as string;
  if (isPlainObject(raw.metadata) && Object.keys(raw.metadata).length) event.metadata = raw.metadata;
  return { ok: true, event, issues: [] };
}

/** 严格校验, 不合格直接抛 (写侧入口) */
export function validateEvent(raw: unknown, opts?: { strictUnknownFields?: boolean }): EventShell {
  const r = inspectEvent(raw, opts);
  if (!r.ok || !r.event) throw new EventValidationError('EVENT_INVALID', r.issues);
  return r.event;
}

// ─────────────────────── 时间单调性 (流级) ───────────────────────

/**
 * 非递减检查。`ts[i] < ts[i-1]` → issue (把它如实报出来, 而不是默默 sort 了事)。
 * 注意: 这是**流**的性质, 不是单条事件的性质。
 */
export function checkMonotonicTs(events: ReadonlyArray<{ ts: number; id?: string }>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    if (cur.ts < prev.ts) {
      issues.push({
        field: `[${i}].ts`,
        code: 'TS_NOT_MONOTONIC',
        message: `时间倒退: ts=${cur.ts} < 上一条 ts=${prev.ts} (回退 ${prev.ts - cur.ts}ms; id=${cur.id ?? '?'})`,
      });
    }
  }
  return issues;
}

/** 非递减断言 (要"硬失败"的调用方用这个) */
export function assertMonotonicTs(events: ReadonlyArray<{ ts: number; id?: string }>): void {
  const issues = checkMonotonicTs(events);
  if (issues.length) throw new EventValidationError('TS_NOT_MONOTONIC', issues);
}

// ─────────────────────── canonical 序列化 ───────────────────────

/**
 * 递归 canonical 化: 对象键排序 / 丢弃 undefined 值 / 数组保序。
 * 非有限数字与 bigint **抛** —— 静默转 null 就是在"默许"数据损坏。
 */
export function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new TypeError(`canonicalize: 非有限数字 ${String(value)} (拒绝静默变 null)`);
    return value;
  }
  if (t === 'bigint') throw new TypeError('canonicalize: bigint 无法 canonical 编码 (会让跨语言字节不一致)');
  if (t === 'undefined') return undefined; // 由调用方丢弃
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (v === undefined) throw new TypeError(`canonicalize: 数组第 ${i} 项是 undefined (JSON 会静默变 null)`);
      return canonicalize(v);
    });
  }
  if (t === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = canonicalize(src[k]);
      if (v === undefined) continue;
      out[k] = v;
    }
    return out;
  }
  throw new TypeError(`canonicalize: 不支持的类型 ${t}`);
}

/** canonical JSON 字符串 (键排序, 无 undefined) */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** 内容 → CID (dag-cbor + sha2-256 + CIDv1 codec 0x71)。与 cid-database.ts 的 contentToCid 同语义 ⇒ CID 可互通 */
export async function contentCid(content: unknown): Promise<string> {
  const clean = canonicalize(content);
  const bytes = dagCbor.encode(clean === undefined ? null : clean);
  const hash = await sha256.digest(bytes);
  return CID.createV1(0x71, hash).toString();
}

/**
 * 外壳 → 事件 id (内容寻址)。**剔除 `id` 自己** —— 否则自指, 算不出来。
 * 同语义事件 (字段全部相同) ⇒ 同 CID, 跨库/跨节点都对得上。
 */
export async function eventCid(shell: Omit<EventShell, 'id'> & { id?: string }): Promise<string> {
  const copy: Record<string, unknown> = { ...(shell as unknown as Record<string, unknown>) };
  delete copy.id;
  return contentCid(copy);
}

/** 摘要: 有界 (≤maxLen), 单行。content 是对象时优先取语义字段, 否则用 canonical JSON —— 保证确定性 */
export function deriveSummary(content: unknown, maxLen: number = MAX_SUMMARY_LEN): string {
  let text = '';
  if (content === null || content === undefined) text = '';
  else if (typeof content === 'string') text = content;
  else if (typeof content === 'number' || typeof content === 'boolean') text = String(content);
  else if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    let picked: unknown;
    for (const k of ['summary', 'text', 'note', 'message', 'title', 'name']) {
      if (typeof o[k] === 'string' && (o[k] as string).length) {
        picked = o[k];
        break;
      }
    }
    text = typeof picked === 'string' ? picked : canonicalJson(content);
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) : oneLine;
}

/** 造一个新外壳: 算 cid(若给了 content) + 算 id(内容寻址) + 补 summary(若没给) */
export async function buildEvent(input: NewEventInput): Promise<EventShell> {
  const shell: Omit<EventShell, 'id'> & { id?: string } = {
    v: input.v ?? EVENT_SHELL_VERSION,
    type: input.type,
    actor: input.actor,
    actorId: input.actorId,
    group: input.group,
    ts: input.ts,
    refs: input.refs ?? [],
    summary: input.summary ?? deriveSummary(input.content),
    ...(input.topic !== undefined ? { topic: input.topic } : {}),
    ...(input.capability !== undefined ? { capability: input.capability } : {}),
    ...(input.content !== undefined ? { cid: await contentCid(input.content) } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
  shell.id = await eventCid(shell);
  const event = validateEvent(shell);
  return event;
}

// ─────────────────────── 向后兼容: 老记录 ───────────────────────

/** cid-database.ts 的老记录类型 (没有 sort 之外的语义) */
export const LEGACY_CID_TYPES = ['memory', 'context', 'state', 'ui', 'knowledge'] as const;
export type LegacyCidType = (typeof LEGACY_CID_TYPES)[number];

/**
 * 老类型 → 外壳类型的**映射** (只做最接近的归类, 原类型仍完整保留在 metadata.legacy 里)。
 * 为什么要映射而不是原样留着: 外壳的 type 是**闭集** (索引/路由都按它分支),
 * 放一个集合外的值进去就会让下游到处是 `if (type === 'memory')` 的补丁。
 */
export const LEGACY_TYPE_MAP: Record<LegacyCidType, EventType> = {
  memory: 'observation',
  context: 'observation',
  state: 'result',
  ui: 'observation',
  knowledge: 'discovery',
};

export function isLegacyRecord(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  if (isKnownEventType(raw.type) && 'actorId' in raw) return false; // 已是新外壳
  const hasId = isNonEmptyString(raw.id);
  const looksLegacy = 'agentId' in raw || 'timestamp' in raw || 'content' in raw;
  const legacyType = typeof raw.type === 'string' && (LEGACY_CID_TYPES as readonly string[]).includes(raw.type);
  return hasId && (looksLegacy || legacyType);
}

export interface LegacyReadResult {
  event: EventShell;
  legacy: true;
  warnings: string[];
}

/** 老记录 → 外壳。缺什么补什么, 并且**逐条报**补了什么 (不含糊其辞) */
export function fromLegacyRecord(raw: Record<string, unknown>): LegacyReadResult {
  const warnings: string[] = [];
  const id = isNonEmptyString(raw.id) ? raw.id : '';
  if (!id) warnings.push('老记录没有 id');
  const legacyType = typeof raw.type === 'string' ? raw.type : '';
  const mapped = (LEGACY_CID_TYPES as readonly string[]).includes(legacyType)
    ? LEGACY_TYPE_MAP[legacyType as LegacyCidType]
    : 'observation';
  if (!(LEGACY_CID_TYPES as readonly string[]).includes(legacyType)) {
    warnings.push(`老记录 type=${JSON.stringify(legacyType)} 不在 ${LEGACY_CID_TYPES.join('/')} 里, 归为 observation`);
  }

  const md = isPlainObject(raw.metadata) ? raw.metadata : {};
  const agentId = isNonEmptyString(raw.agentId) ? raw.agentId : '';
  if (!agentId) warnings.push('老记录缺 agentId, actor 置为空串');
  const actorId = isNonEmptyString(md.actorId) ? (md.actorId as string) : agentId;
  if (!isNonEmptyString(md.actorId)) warnings.push('老记录缺 actorId —— 用 agentId 顶替 (没有伪造 DID)');
  const group = isNonEmptyString(md.group) ? (md.group as string) : '';
  if (!group) warnings.push('老记录缺 group, 置为空串');

  const ts = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : 0;
  if (raw.timestamp === undefined) warnings.push('老记录缺 timestamp, ts 置为 0');

  let summary = isNonEmptyString(md.summary) ? (md.summary as string) : '';
  if (!summary) {
    summary = deriveSummary(raw.content);
    warnings.push('老记录缺 summary, 由 content 现推 (≤' + MAX_SUMMARY_LEN + ' 字)');
  } else if (summary.length > MAX_SUMMARY_LEN) {
    summary = summary.slice(0, MAX_SUMMARY_LEN);
    warnings.push(`老记录 summary 超 ${MAX_SUMMARY_LEN} 字, 截断为有界摘要`);
  }

  const refs: EventRef[] = [];
  if (isNonEmptyString(raw.parentId)) {
    refs.push({ type: 'event', id: raw.parentId as string, rel: 'parent' });
  }
  if (raw.version !== undefined && typeof raw.version !== 'number') {
    warnings.push(`老记录 version 不是数字 (${JSON.stringify(raw.version)}), 原样放进 metadata.legacy`);
  }

  const topic = isNonEmptyString(md.topic) ? (md.topic as string) : undefined;
  const capability = isNonEmptyString(md.capability) ? (md.capability as string) : undefined;
  const cidField = isNonEmptyString(md.cid) ? (md.cid as string) : id;
  if (!isNonEmptyString(md.cid) && id) warnings.push('老记录没有单独的正文字段, cid 用记录 id (老记录本身就是内容寻址的)');

  const legacyMeta: Record<string, unknown> = {
    legacy: { type: legacyType, version: raw.version ?? null, agentId, keys: Object.keys(raw).sort() },
  };
  for (const k of ['topic', 'capability', 'cid', 'group', 'actorId'] as const) {
    if (md[k] !== undefined) legacyMeta[k] = md[k];
  }

  const event: EventShell = {
    v: EVENT_SHELL_VERSION,
    id,
    type: mapped,
    actor: agentId,
    actorId,
    group,
    ts,
    refs,
    summary,
    metadata: legacyMeta,
  };
  if (topic) event.topic = topic;
  if (capability) event.capability = capability;
  if (cidField) event.cid = cidField;
  return { event, legacy: true, warnings };
}

export type ReadResult =
  | { ok: true; event: EventShell; legacy: boolean; warnings: string[] }
  | { ok: false; code: string; message: string; issues: ValidationIssue[] };

/**
 * 读入口: 新外壳走严格校验, 老记录走兼容映射。
 * 两种都不是 → 如实报 UNRECOGNIZED_RECORD (不硬塞一个空壳)。
 */
export function inspectReadableEvent(raw: unknown): ReadResult {
  if (isPlainObject(raw) && isKnownEventType(raw.type) && 'actorId' in raw) {
    const r = inspectEvent(raw);
    if (!r.ok || !r.event) return { ok: false, code: 'EVENT_INVALID', message: r.issues[0]?.message ?? '外壳校验失败', issues: r.issues };
    return { ok: true, event: r.event, legacy: false, warnings: [] };
  }
  if (isLegacyRecord(raw)) {
    const r = fromLegacyRecord(raw as Record<string, unknown>);
    return { ok: true, event: r.event, legacy: true, warnings: r.warnings };
  }
  return {
    ok: false,
    code: 'UNRECOGNIZED_RECORD',
    message: `既不是事件外壳 (缺 actorId/type 不在闭集) 也不是老 CIDRecord: keys=${isPlainObject(raw) ? Object.keys(raw).join(',') : typeof raw}`,
    issues: [],
  };
}

/** 读入口 (抛版) */
export function readEvent(raw: unknown): EventShell {
  const r = inspectReadableEvent(raw);
  if (!r.ok) throw new EventValidationError(r.code, r.issues.length ? r.issues : [{ field: '(root)', code: r.code, message: r.message }]);
  return r.event;
}

export type MonotonicMode = 'off' | 'report' | 'enforce';

export interface StreamInspection {
  ok: boolean;
  events: EventShell[];
  issues: ValidationIssue[];
  legacyCount: number;
}

/**
 * 流级读入 + 校验。
 * `monotonic`:
 *   'off'     — 不查时间顺序
 *   'report'  — (默认) TS_NOT_MONOTONIC 进 issues, **不算失败**
 *   'enforce' — TS_NOT_MONOTONIC 让 ok=false (要拒绝乱序流的调用方用)
 * `LEGACY_COERCED` 是"读老记录时补了什么"的告知, 从不影响 ok。
 */
export function inspectEventStream(raws: readonly unknown[], opts?: { monotonic?: MonotonicMode }): StreamInspection {
  const events: EventShell[] = [];
  const issues: ValidationIssue[] = [];
  let legacyCount = 0;

  raws.forEach((raw, i) => {
    const r = inspectReadableEvent(raw);
    if (!r.ok) {
      issues.push({ field: `[${i}]`, code: r.code, message: r.message });
      return;
    }
    if (r.legacy) {
      legacyCount++;
      for (const w of r.warnings) issues.push({ field: `[${i}]`, code: 'LEGACY_COERCED', message: w });
    }
    events.push(r.event);
  });

  const mode: MonotonicMode = opts?.monotonic ?? 'report';
  const monoIssues = mode === 'off' ? [] : checkMonotonicTs(events);
  issues.push(...monoIssues);

  const hard = issues.filter(
    (x) => x.code !== 'LEGACY_COERCED' && !(x.code === 'TS_NOT_MONOTONIC' && mode === 'report'),
  );
  return { ok: hard.length === 0, events, issues, legacyCount };
}
