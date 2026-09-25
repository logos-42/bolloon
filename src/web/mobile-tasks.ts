/**
 * mobile-tasks.ts — 手机端「任务协作」能力层 (2026-09-25)
 *
 * 四项能力的手机侧实现 (桌面/CLI 同一套存储与协议, **手机不是第二个权威源**):
 *   ① 入群        → 桌面 `/api/mobile/tasks/groups*` → `gateway-group.ts` (与 CLI `bolloon task group …` 同一份 store)
 *   ② 发任务公告   → 桌面 `/api/mobile/tasks/announce|publish|post` → `task-group.ts` / `task-board.ts` (与 CLI 同函数)
 *   ③ 看飞轮进度   → 桌面 `/api/mobile/tasks/flywheel` → `goal-store` 只读 + `goal-flywheel` 冻结类型投影
 *   ④ 授权签名     → 每个**高风险**动作: 展示待发内容 → 设备私钥 (Ed25519) 签规范载荷 → 桌面验签才执行
 *
 * 纪律 (与本仓其它手机模块一致):
 *   · **浏览器安全**: 不 import 任何 node: 模块 (纯函数与 fetch)。
 *   · **不支持设备签名就明说**: 没有 WebCrypto/Ed25519 → 返回 device_signing_unavailable, **绝不发未签名请求**。
 *   · **桌面离线不假装成功**: 直接返回 desktop_offline (任务动作**不进离线队列** ——
 *     一张几小时后突然生效的"发公告/入群"批准比失败更危险; 这条与 contacts 队列的取舍不同, 是刻意的)。
 *   · **本地先过隐私闸**: 群消息文本用桌面同一份规则表 (`task-public-text.ts`) 预检, 命中就本地拒发。
 *   · **只渲染脱敏视图**: 页面数据一律经 `mobile-task-views.ts` 投影 (id 只给缩短形式)。
 */

import {
  canonicalTaskActionPayload, taskActionContentText, checkTaskActionFreshness,
  TASK_ACTION_DEFAULT_TTL_MS, MOBILE_TASK_ACTION_KINDS,
  type MobileTaskActionKind, type SignedTaskAction, type SignableTaskAction, type TaskActionRequest, type TaskActionSignature,
} from '../agents/mobile-task-actions.js';
import { requirePublicText, type PrivacyViolation } from '../agents/task-public-text.js';
import {
  buildBoardView, buildTrailView, buildGroupsView, describeTaskActionForConfirm,
  type MobileBoardView, type MobileTrailView, type MobileGroupItem,
} from '../agents/mobile-task-views.js';
import { findInternalFieldLeaks, type MobileFlywheelView } from '../agents/mobile-flywheel-view.js';
import { signPayloadOnDevice, sha256HexOf, ed25519Available, type StorageLike } from './mobile-contacts.js';

type FetchLike = (input: string, init?: any) => Promise<any>;

export interface MobileTasksDeps {
  storage?: StorageLike;
  cryptoObj?: Crypto;
  fetchImpl?: FetchLike;
  /** 桌面基址 (不传 → 读设置里存的 bolloon_desktop_base_url) */
  base?: string;
  /** 本机 owner did (只用于记账; 身份由设备签名证明) */
  ownerDid?: string;
  grantedBy?: string;
  now?: () => number;
  ttlMs?: number;
}

export interface MobileTasksResult<T = unknown> {
  ok: boolean;
  /** 机器可读原因 (desktop_offline / device_signing_unavailable / privacy_denied / desktop_rejected …) */
  code?: string;
  error?: string;
  data?: T;
  /** 额外人话说明 (例如"桌面不在线时不假装已生效") */
  note?: string;
  violations?: PrivacyViolation[];
}

const K_TASKS_HINT = 'bolloon.mobile.tasks.hint.v1';

function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* 隐私模式 */ }
  const mem = new Map<string, string>();
  return { getItem: (k) => (mem.has(k) ? mem.get(k)! : null), setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } };
}

async function baseOf(deps: MobileTasksDeps): Promise<string> {
  if (deps.base && String(deps.base).trim()) return String(deps.base).replace(/\/+$/, '');
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem('bolloon_desktop_base_url');
      if (v) return String(v).replace(/\/+$/, '');
    }
  } catch { /* 忽略 */ }
  return '';
}

function fetchOf(deps: MobileTasksDeps): FetchLike {
  return deps.fetchImpl || ((globalThis as any).fetch as FetchLike);
}

async function getJson(base: string, path: string, f: FetchLike): Promise<{ status: number; json: any }> {
  const res = await f(`${base}${path}`);
  let json: any = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, json };
}

async function postJson(base: string, path: string, body: unknown, f: FetchLike): Promise<{ status: number; json: any }> {
  const res = await f(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, json };
}

const OFFLINE_NOTE = '地址在 我 → 设置 → 电脑端地址 里填; 手机不替桌面记账';

/** 读接口统一错误映射 (桌面不在线 → 明说, 不返回空壳当成功) */
function mapFail<T>(r: { status: number; json: any }, what: string): MobileTasksResult<T> {
  const code = r.json?.code ? String(r.json.code) : (r.status ? `desktop_http_${r.status}` : 'desktop_unreachable');
  return { ok: false, code, error: `${what} 失败: ${r.json?.error || r.json?.message || code}`, note: OFFLINE_NOTE };
}

// ── 请求构造 (空字段一律显式 null: 桌面据此重算内容摘要) ─────────────────────

export function emptyTaskActionRequest(kind: MobileTaskActionKind): TaskActionRequest {
  return {
    kind, groupRef: null, announcementId: null, capability: null, instruction: null,
    budgetHuman: null, currency: null, deadline: null, criteria: null, round: null, price: null,
    hash: null, bytes: null, checks: null, verdict: null, trailKind: null,
  };
}

// ── 签名 (高风险动作唯一入口) ────────────────────────────────────────────────

export interface SignedTaskActionResult {
  signed: SignedTaskAction;
  contentText: string;
  confirm: { titleZh: string; titleEn: string; lines: Array<{ k: string; v: string }> };
}

/**
 * 构造并签一个动作。**没有设备签名能力 → 直接失败** (没有"不签名也能过"的路径)。
 * 群消息类动作在签名前先过本地隐私闸 (与桌面同一份规则表)。
 */
export async function signTaskAction(req: TaskActionRequest, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<SignedTaskActionResult>> {
  const storage = deps.storage || defaultStorage();
  const c = deps.cryptoObj || (globalThis as any).crypto;
  if (!ed25519Available(c)) {
    return { ok: false, code: 'device_signing_unavailable', error: '本机 WebView 不支持 Ed25519 设备签名 —— 请在桌面端执行这个动作 (或升级系统 WebView)' };
  }
  if (!(MOBILE_TASK_ACTION_KINDS as readonly string[]).includes(String(req?.kind))) {
    return { ok: false, code: 'unknown_kind', error: `未知动作: ${String((req as any)?.kind || '')}` };
  }
  // 群消息类动作: 先本地过闸 (桌面还会再过一遍, 两道都要)
  const text = taskActionContentText(req);
  if (req.kind === 'trail_post' || req.kind === 'announce_publish' || req.kind === 'announce_to_group') {
    for (const fieldText of [req.round, req.price, req.criteria, req.checks, req.verdict, req.capability, req.hash]) {
      if (!fieldText) continue;
      const gate = requirePublicText(String(fieldText));
      if (!gate.ok) {
        return { ok: false, code: 'privacy_denied', error: `本地隐私闸拦下: ${gate.violations.map((v) => v.rule).join(', ')} (群里/公告里不放标识符)`, violations: gate.violations };
      }
    }
  }
  const now = deps.now ? deps.now() : Date.now();
  const ttl = Math.min(Number(deps.ttlMs) || TASK_ACTION_DEFAULT_TTL_MS, TASK_ACTION_DEFAULT_TTL_MS);
  let contentDigest: string;
  try {
    contentDigest = await sha256HexOf(text, c);
  } catch (e: any) {
    return { ok: false, code: 'device_signing_unavailable', error: String(e?.message || e) };
  }
  const action: SignableTaskAction = {
    actionId: `act-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: req.kind,
    deviceId: '', // 由 signPayloadOnDevice 填 (它知道设备 id)
    ownerDid: String(deps.ownerDid || '').trim(),
    targetRef: String(req.groupRef || req.announcementId || ''),
    contentDigest,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    grantedBy: deps.grantedBy || 'leo',
    via: 'mobile',
  };
  // 设备 id 必须先落到载荷里 (签名是对**含 deviceId 的载荷**做的), 且与签名同源
  let signature: TaskActionSignature;
  try {
    const { loadOrCreateDeviceKey, signPayloadWithMaterial } = await import('./mobile-contacts.js');
    const material = await loadOrCreateDeviceKey(storage, c);
    action.deviceId = material.deviceId;
    signature = await signPayloadWithMaterial(canonicalTaskActionPayload(action), material, c);
    if (signature.deviceId !== action.deviceId) {
      return { ok: false, code: 'device_signing_unavailable', error: '设备密钥不一致 (签名与载荷设备对不上) → 不发送' };
    }
    const fresh = checkTaskActionFreshness(action, now);
    if (!fresh.ok) return { ok: false, code: fresh.reason, error: `动作时效不合法: ${fresh.reason}` };
  } catch (e: any) {
    return { ok: false, code: 'device_signing_unavailable', error: String(e?.message || e).slice(0, 160) };
  }
  return {
    ok: true,
    data: { signed: { action, signature }, contentText: text, confirm: describeTaskActionForConfirm(req.kind, req) },
  };
}

// ── 执行 (签名 → 桌面验签 → 桌面执行) ────────────────────────────────────────

export async function executeTaskAction(
  req: TaskActionRequest,
  deps: MobileTasksDeps = {},
): Promise<MobileTasksResult<{ text?: string; announcementId?: string; group?: any; kind: string }>> {
  const storage = deps.storage || defaultStorage();
  const base = await baseOf(deps);
  if (!base) return { ok: false, code: 'desktop_offline', error: '还没设置电脑端地址: 高风险动作必须由桌面执行 (手机签了名也要送到桌面)', note: OFFLINE_NOTE };
  const signed = await signTaskAction(req, { ...deps, storage });
  if (!signed.ok || !signed.data) return { ok: false, code: signed.code, error: signed.error, violations: signed.violations };
  const f = fetchOf(deps);
  let r: { status: number; json: any };
  try {
    r = await postJson(base, '/api/mobile/tasks/execute', { request: req, ...signed.data.signed }, f);
  } catch (e: any) {
    return { ok: false, code: 'desktop_offline', error: `桌面不可达: ${String(e?.message || e).slice(0, 120)}`, note: OFFLINE_NOTE };
  }
  if (r.status !== 200 || !r.json?.ok) return mapFail(r, '执行');
  return { ok: true, data: r.json as any, note: '桌面已验签并执行 (同一套存储与协议)' };
}

/** 预览群消息正文 (由桌面用**将要发送的同一个构造器**生成; 只给要发进群的那一行) */
export async function previewGroupMessage(
  req: TaskActionRequest,
  deps: MobileTasksDeps = {},
): Promise<MobileTasksResult<{ text: string; contentText: string; digestPreview: string }>> {
  const base = await baseOf(deps);
  if (!base) return { ok: false, code: 'desktop_offline', error: '预览需要桌面在线 (群消息由桌面的构造器生成)', note: OFFLINE_NOTE };
  const c = deps.cryptoObj || (globalThis as any).crypto;
  let digestPreview = '';
  try { digestPreview = await sha256HexOf(taskActionContentText(req), c); } catch { digestPreview = ''; }
  const f = fetchOf(deps);
  try {
    const r = await postJson(base, '/api/mobile/tasks/preview', { request: req }, f);
    if (r.status !== 200 || !r.json?.ok) return mapFail(r, '预览');
    return { ok: true, data: { text: String(r.json.text || ''), contentText: taskActionContentText(req), digestPreview } };
  } catch (e: any) {
    return { ok: false, code: 'desktop_offline', error: `桌面不可达: ${String(e?.message || e).slice(0, 120)}`, note: OFFLINE_NOTE };
  }
}

// ── ① 入群 (与 CLI `task group list|join|leave|create` 同一份 store) ─────────

export async function listGroups(deps: MobileTasksDeps = {}): Promise<MobileTasksResult<MobileGroupItem[]>> {
  const base = await baseOf(deps);
  if (!base) return { ok: false, code: 'desktop_offline', error: '看群列表需要电脑端在线 (群存在于桌面节点的 OrbitDB)', note: OFFLINE_NOTE };
  try {
    const r = await getJson(base, '/api/mobile/tasks/groups', fetchOf(deps));
    if (r.status !== 200 || !r.json?.ok) return mapFail(r, '读群列表');
    return { ok: true, data: buildGroupsView(r.json.groups || []) };
  } catch (e: any) {
    return { ok: false, code: 'desktop_offline', error: `桌面不可达: ${String(e?.message || e).slice(0, 120)}`, note: OFFLINE_NOTE };
  }
}

/** 入群 (高风险: 要签名) */
export function joinGroup(link: string, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<any>> {
  const req = { ...emptyTaskActionRequest('group_join'), groupRef: String(link || '').trim() };
  return executeTaskAction(req, deps);
}

/** 退群 (高风险: 要签名) */
export function leaveGroup(groupRef: string, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<any>> {
  const req = { ...emptyTaskActionRequest('group_leave'), groupRef: String(groupRef || '').trim() };
  return executeTaskAction(req, deps);
}

/** 建群 (高风险: 要签名; 建完自动入群) */
export function createGroup(name: string, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<any>> {
  const req = { ...emptyTaskActionRequest('group_create'), groupRef: String(name || '').trim() };
  return executeTaskAction(req, deps);
}

// ── ② 发任务公告 ────────────────────────────────────────────────────────────

/** 看板 (只读): 与 CLI `bolloon task board` 同一份事实 */
export async function loadBoard(deps: MobileTasksDeps = {}): Promise<MobileTasksResult<MobileBoardView>> {
  const base = await baseOf(deps);
  if (!base) return { ok: false, code: 'desktop_offline', error: '看板需要电脑端在线 (公告板在桌面节点上)', note: OFFLINE_NOTE };
  const now = deps.now ? deps.now() : Date.now();
  try {
    const r = await getJson(base, '/api/mobile/tasks/board', fetchOf(deps));
    if (r.status !== 200 || !r.json?.ok) return mapFail(r, '读看板');
    return { ok: true, data: buildBoardView(r.json, now) };
  } catch (e: any) {
    return { ok: false, code: 'desktop_offline', error: `桌面不可达: ${String(e?.message || e).slice(0, 120)}`, note: OFFLINE_NOTE };
  }
}

/** 发布一条待接单公告 (高风险: 要签名; 与 CLI `task publish` 同一函数) */
export function publishAnnouncement(input: {
  capability: string; instruction: string; budgetHuman: string; currency?: string;
  /** `+2h` / `+1d` / 未来毫秒时间戳 (桌面 parseDeadline 解析; 不填 = 桌面默认 24h) */
  deadline?: string | null;
}, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<any>> {
  const req: TaskActionRequest = {
    ...emptyTaskActionRequest('announce_publish'),
    capability: String(input.capability || '').trim(),
    instruction: String(input.instruction || ''),
    budgetHuman: String(input.budgetHuman || '').trim(),
    currency: String(input.currency || 'USDC').toUpperCase(),
    deadline: input.deadline ? String(input.deadline).trim() : null,
  };
  return executeTaskAction(req, deps);
}

/** 把板上的一条公告发进群 (高风险: 要签名; 与 CLI `task announce` 同一函数) */
export function announceIntoGroup(input: { groupRef: string; announcementId: string; round?: string | null; criteria?: string | null }, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<any>> {
  const req: TaskActionRequest = {
    ...emptyTaskActionRequest('announce_to_group'),
    groupRef: String(input.groupRef || '').trim(),
    announcementId: String(input.announcementId || '').trim(),
    round: input.round ? String(input.round) : null,
    criteria: input.criteria ? String(input.criteria) : null,
  };
  return executeTaskAction(req, deps);
}

/** 过程留痕: 接单 / 交付 / 初筛 / 终审 (高风险: 要签名; 与 CLI `task post` 同一函数) */
export function postTrail(input: {
  kind: 'claim' | 'deliver' | 'screen' | 'final';
  groupRef: string; announcementId: string;
  round?: string | null; price?: string | null; hash?: string | null; bytes?: number | null;
  checks?: string | null; verdict?: string | null;
}, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<any>> {
  const req: TaskActionRequest = {
    ...emptyTaskActionRequest('trail_post'),
    groupRef: String(input.groupRef || '').trim(),
    announcementId: String(input.announcementId || '').trim(),
    round: input.round ? String(input.round) : null,
    price: input.price ? String(input.price) : null,
    hash: input.hash ? String(input.hash) : null,
    bytes: typeof input.bytes === 'number' ? input.bytes : null,
    checks: input.checks ? String(input.checks) : null,
    verdict: input.verdict ? String(input.verdict) : null,
    trailKind: input.kind,
  };
  return executeTaskAction(req, deps);
}

/** 读群里的一期过程痕迹 (只读): 与 CLI `bolloon task trail --group …` 同一份汇总 */
export async function loadTrail(input: { groupRef: string; announcementId?: string | null; limit?: number }, deps: MobileTasksDeps = {}): Promise<MobileTasksResult<MobileTrailView>> {
  const base = await baseOf(deps);
  if (!base) return { ok: false, code: 'desktop_offline', error: '读群痕迹需要电脑端在线', note: OFFLINE_NOTE };
  const q = new URLSearchParams();
  q.set('group', String(input.groupRef || '').trim());
  if (input.announcementId) q.set('announcementId', String(input.announcementId));
  if (input.limit) q.set('limit', String(input.limit));
  try {
    const r = await getJson(base, `/api/mobile/tasks/trail?${q.toString()}`, fetchOf(deps));
    if (r.status !== 200 || !r.json?.ok) return mapFail(r, '读群痕迹');
    return { ok: true, data: buildTrailView(r.json.summary || r.json) };
  } catch (e: any) {
    return { ok: false, code: 'desktop_offline', error: `桌面不可达: ${String(e?.message || e).slice(0, 120)}`, note: OFFLINE_NOTE };
  }
}

// ── ③ 看飞轮进度 (只读消费 goal-flywheel 冻结类型) ───────────────────────────

export async function loadFlywheel(deps: MobileTasksDeps = {}): Promise<MobileTasksResult<{ goals: MobileFlywheelView[]; hint: string | null }>> {
  const base = await baseOf(deps);
  if (!base) return { ok: false, code: 'desktop_offline', error: '看飞轮进度需要电脑端在线 (Goal 记录在桌面节点上)', note: OFFLINE_NOTE };
  try {
    const r = await getJson(base, '/api/mobile/tasks/flywheel', fetchOf(deps));
    if (r.status !== 200 || !r.json?.ok) return mapFail(r, '读飞轮进度');
    const goals: MobileFlywheelView[] = Array.isArray(r.json.goals) ? r.json.goals : [];
    // 桌面投影里若混进内部字段 → 手机**拒绝渲染** (宁可显示"读不到", 也不把内部状态摆给用户)
    const leaks = findInternalFieldLeaks(JSON.stringify(goals));
    if (leaks.length) return { ok: false, code: 'view_leak', error: `视图里含内部字段 (${leaks.join(', ')}) → 拒绝渲染` };
    return { ok: true, data: { goals, hint: r.json.hint ? String(r.json.hint) : null } };
  } catch (e: any) {
    return { ok: false, code: 'desktop_offline', error: `桌面不可达: ${String(e?.message || e).slice(0, 120)}`, note: OFFLINE_NOTE };
  }
}

// ── 小工具 (UI 直接用) ─────────────────────────────────────────────────────

/** 上一次操作的提示 (给 UI 跨页显示; 只存极短文本, 不含标识符) */
export function setTaskHint(text: string, storage: StorageLike = defaultStorage()): void {
  try { storage.setItem(K_TASKS_HINT, String(text || '').slice(0, 160)); } catch { /* 忽略 */ }
}
export function getTaskHint(storage: StorageLike = defaultStorage()): string {
  try { return String(storage.getItem(K_TASKS_HINT) || ''); } catch { return ''; }
}

export { requirePublicText, describeTaskActionForConfirm, buildBoardView, buildTrailView, buildGroupsView };
