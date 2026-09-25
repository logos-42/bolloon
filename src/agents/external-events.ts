/**
 * external-events.ts — 外部等待 / 外部事件唤醒协议 (批次 2-C.4, 2026-09-16)
 *
 * 问题: `notifyExternal()` 之前只是个手动入口 (CLI `/wake`、`POST /api/goals/:id/wake`) ——
 *       真实 P2P / delegate 回包到达时**没有任何东西**知道该唤醒哪个 Goal, 也没有来源/关联/去重/过期校验。
 *
 * 协议 (与 leo 的规格 1:1):
 *   Goal 在等待时必须绑定: externalRequestId · continuationId · expectedSource · expectedEvent · createdAt · expiresAt
 *   收到事件时必须依次: ① 校验来源 ② 校验 correlation ③ 校验属于当前 continuation
 *                    ④ 用 eventId 去重 ⑤ 写入事件事实 (Goal 证据) ⑥ 唤醒 Goal ⑦ 由 Supervisor 下一轮继续
 *   **事件处理器不直接启动 agent** —— 它只写事实 + 唤醒; 谁来执行由 Supervisor 决定。
 */

import * as os from 'os';
import * as path from 'path';
import {
  readGoal, setContinuation, listGoals, addEvidence, type GoalRecord,
  type GoalExternalSource,
} from './goal-store.js';
// 2026-09-25 (M0 接线冻结, 规则 ②): Goal 状态变更只有一个漏斗
import { reduceGoalState } from './goal-state-reducer.js';
import { readRun, setRunStatus } from './run-store.js';

// 2026-09-19: 新增 'contact' —— 联系方式(手机/邮箱)回复也是外部事件, 复用同一套等待/唤醒/过期/provenance 校验,
//   不另造一套"等回信"机制 (correlation 由 requestId/continuationId 保证, 只唤醒对应 Goal)。
export type ExternalSource = GoalExternalSource;   // 定义在 goal-store (单一事实)

export interface ExternalWait {
  /** 外部请求 id (发送方生成; 回包必须带上) */
  requestId: string;
  /** 关联的 continuation (Goal 侧) */
  continuationId: string;
  /** 期望来源: 只接受这些来源的事件 */
  expectedSource: ExternalSource;
  /** 期望事件名 (可选; 空 = 任意事件名) */
  expectedEvent?: string;
  createdAt: string;
  expiresAt: string;
  /** 人可读描述 (展示用) */
  note?: string;
}

export interface ExternalEventInput {
  source: ExternalSource;
  eventId: string;
  requestId?: string;
  continuationId?: string;
  goalId?: string;
  fromDid?: string;
  eventName?: string;
  payload?: unknown;
}

export type DeliverReason =
  | 'delivered' | 'no_match' | 'source_mismatch' | 'correlation_mismatch'
  | 'event_mismatch' | 'expired' | 'duplicate' | 'not_waiting';

export interface DeliverResult {
  ok: boolean;
  reason: DeliverReason;
  detail?: string;
  goalId?: string;
  /** 是否真的唤醒了 (status 从 awaiting_external → active) */
  woke?: boolean;
}

// ── 绑定等待 ────────────────────────────────────────────────────────────────

export function defaultWaitExpiry(now = Date.now(), ttlMs = 30 * 60_000): string {
  return new Date(now + ttlMs).toISOString();
}

/** 生成 continuationId / requestId (调用方也可自带) */
export function newContinuationId(goalId: string): string {
  return `${goalId}:c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 把"这个 Goal 在等什么外部事件"写进 Goal continuation (持久化)。
 * 事件处理器只读这份事实, 不猜。
 */
export async function bindExternalWait(goalId: string, wait: ExternalWait): Promise<GoalRecord | null> {
  const rec = await setContinuation(goalId, { external: wait, needsExternal: wait.note || `${wait.expectedSource}${wait.expectedEvent ? `:${wait.expectedEvent}` : ''} (requestId=${wait.requestId})` });
  // 等待中也要让状态机一致: awaiting_external 由调用方/reducer 设置, 这里只保证等待事实在
  return rec;
}

/** 清掉等待事实 (唤醒/超时后) */
export async function clearExternalWait(goalId: string): Promise<GoalRecord | null> {
  return setContinuation(goalId, { external: undefined });
}

// ── 匹配 ────────────────────────────────────────────────────────────────────

function sourceMatches(expected: ExternalSource, actual: ExternalSource): boolean {
  if (expected === 'any') return true;
  return expected === actual;
}

interface Candidate { goal: GoalRecord; wait: ExternalWait; why?: string }

async function candidates(event: ExternalEventInput): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (event.goalId) {
    const g = await readGoal(event.goalId);
    if (g?.continuation?.external) out.push({ goal: g, wait: g.continuation.external });
    return out;
  }
  const all = await listGoals({ limit: 200 });
  for (const g of all) {
    const w = g.continuation?.external;
    if (w) out.push({ goal: g, wait: w });
  }
  return out;
}

// ── 投递 (唯一入口) ─────────────────────────────────────────────────────────

export interface DeliverDeps {
  /** 唤醒回调 (默认取 Supervisor.notifyExternal 的语义: 清等待 + 记一次唤醒) */
  wake?: (goalId: string) => Promise<boolean>;
  now?: () => number;
}

/**
 * 投递一个外部事件。校验顺序固定: 来源 → correlation → 属于当前 continuation → 过期 → 去重。
 * 任何一步不过 → **不唤醒**, 只返回原因 (调用方可以把不匹配的事件当普通消息继续走)。
 */
export async function deliverExternalEvent(event: ExternalEventInput, deps: DeliverDeps = {}): Promise<DeliverResult> {
  const now = deps.now ? deps.now() : Date.now();
  if (!event?.eventId) return { ok: false, reason: 'correlation_mismatch', detail: '事件缺少 eventId (无法去重)' };

  const cands = await candidates(event);
  if (cands.length === 0) return { ok: false, reason: 'no_match', detail: '没有 Goal 在等这个事件' };

  // 选出唯一匹配的 Goal (按 requestId/continuationId 精确; 退而按来源+事件名)
  let chosen: Candidate | undefined;
  let failReason: DeliverReason | undefined;
  let failDetail: string | undefined;

  for (const c of cands) {
    const w = c.wait;
    if (!sourceMatches(w.expectedSource, event.source)) { failReason ??= 'source_mismatch'; failDetail ??= `等待 ${w.expectedSource}, 收到 ${event.source}`; continue; }
    if (event.requestId && event.requestId !== w.requestId) { failReason ??= 'correlation_mismatch'; failDetail ??= `requestId 不匹配 (等 ${w.requestId}, 收到 ${event.requestId})`; continue; }
    if (!event.requestId && event.continuationId && event.continuationId !== w.continuationId) { failReason ??= 'correlation_mismatch'; failDetail ??= 'continuationId 不匹配'; continue; }
    if (!event.requestId && !event.continuationId) { failReason ??= 'correlation_mismatch'; failDetail ??= '事件没有 requestId/continuationId, 不能确认属于这次等待'; continue; }
    if (w.expectedEvent && event.eventName && event.eventName !== w.expectedEvent) { failReason ??= 'event_mismatch'; failDetail ??= `等 ${w.expectedEvent}, 收到 ${event.eventName}`; continue; }
    chosen = c;
    break;
  }

  if (!chosen) return { ok: false, reason: failReason || 'no_match', detail: failDetail };
  const { goal, wait } = chosen;

  // 过期
  if (Date.parse(wait.expiresAt) <= now) {
    return { ok: false, reason: 'expired', goalId: goal.goalId, detail: `等待已过期 (${wait.expiresAt})` };
  }

  // 去重 (同一 eventId 只处理一次; 跨进程看盘上事实)
  const seen = goal.continuation?.deliveredEventIds || [];
  if (seen.includes(event.eventId)) return { ok: false, reason: 'duplicate', goalId: goal.goalId, detail: `eventId ${event.eventId} 已处理过` };

  // 写入事件事实 (证据 + 去重表) —— 不在这里启动 agent
  await addEvidence(goal.goalId, [
    `外部事件 (${event.source}${event.fromDid ? `, ${String(event.fromDid).slice(0, 16)}…` : ''}): ${event.eventName || '结果'} eventId=${event.eventId} requestId=${event.requestId || '-'} payload=${JSON.stringify(event.payload ?? null).slice(0, 300)}`,
  ]).catch(() => { /* 证据写失败不阻断唤醒; continuation 里仍有事实 */ });

  // ★ 等待类的 continuation.state 也必须一起拉回 `active`:
  //   飞轮的"等外部"判定读的是 continuation.state (`state=waiting_external` → wait), 而界面
  //   (`toUserVisibleState`) 也只读 continuation —— 只改 wakeReason 不改 state 会留下
  //   "wakeReason=active 但 state=awaiting_external" 的自相矛盾 (M5-⑤ 真跑复现: Goal 显示已醒,
  //   下一轮却仍被判"在等外部", 永远没人跑)。
  const wasWaiting = ['awaiting_external', 'retry_wait', 'recovering'].includes(String(goal.status))
    || ['awaiting_external', 'retry_wait', 'recovering'].includes(String(goal.continuation?.state));
  await setContinuation(goal.goalId, {
    deliveredEventIds: [...seen, event.eventId].slice(-20),
    external: undefined,
    externalResult: { eventId: event.eventId, source: event.source, fromDid: event.fromDid, at: new Date(now).toISOString(), payload: event.payload } as any,
    wakeReason: 'active',
    needsExternal: undefined,
    autoContinue: true,
    wakeAt: undefined,
    ...(wasWaiting ? { state: 'active' as const } : {}),
  } as any);

  // 状态拉回 active (只有还在"等外部"的状态才动它) —— Supervisor 下一轮才会真的执行
  // 规则 ②: 状态变更经 Goal reducer (单一漏斗; 它自己会跳过终态 Goal)
  try {
    if (['awaiting_external', 'retry_wait', 'recovering'].includes(String(goal.status))) {
      await reduceGoalState({
        goalId: goal.goalId,
        intent: 'external_event_arrived',
        now: new Date(now).toISOString(),
        by: 'external-events',
      });
    }
  } catch { /* 状态写失败 → 下一轮仍会跳过等待; 事件事实已写入, 不丢 */ }

  // 唤醒 (由 Supervisor 下一轮真正执行)
  // `woke` 的语义跟着**盘上事实**走, 不只看宿主回调的返回值: 上面已经把等待事实清掉、把
  //   wakeReason/state 拉回 active 了 —— 宿主注入的 wake (= `Supervisor.notifyExternal`) 的
  //   "还在等外部吗"前置条件此刻已不成立, 它会早退返回 false。若照抄它的返回值, 一次真唤醒会被
  //   报成"没唤醒" (M5-⑤ 真跑就是这么读到的)。宿主回调仍然要调 (它有清等待/记次数的副作用)。
  let woke = false;
  if (deps.wake) await deps.wake(goal.goalId).catch(() => false);
  const after = await readGoal(goal.goalId);
  const stillWaiting = !!after && (
    ['awaiting_external', 'retry_wait', 'recovering'].includes(String(after.status))
    || after.continuation?.state === 'awaiting_external'
  );
  woke = !!after && !stillWaiting;

  return { ok: true, reason: 'delivered', goalId: goal.goalId, woke };
}

// ── 超时 (不允许无限等待) ───────────────────────────────────────────────────

export interface ExpiredWait { goalId: string; wait: ExternalWait; reason: string }

/**
 * 把所有"等待已过期"的 Goal 转成明确状态 (needs_human, autoContinue=false)。
 * 由 Supervisor 每轮 tick 开头调用 —— 超时不是失败, 但不能无限等。
 */
export async function expireExternalWaits(opts: { now?: number; goalIds?: string[] } = {}): Promise<ExpiredWait[]> {
  const now = opts.now ?? Date.now();
  const goals = opts.goalIds
    ? (await Promise.all(opts.goalIds.map((id) => readGoal(id)))).filter(Boolean) as GoalRecord[]
    : await listGoals({ limit: 200 });
  const out: ExpiredWait[] = [];
  for (const g of goals) {
    const w = g.continuation?.external;
    if (!w) continue;
    if (Date.parse(w.expiresAt) > now) continue;
    const reason = `外部事件超时 (${w.expectedSource}${w.expectedEvent ? `:${w.expectedEvent}` : ''}, requestId=${w.requestId}, 过期于 ${w.expiresAt}) → 转人工`;
    out.push({ goalId: g.goalId, wait: w, reason });
    // 规则 ②: 撤等待 + 转人工 + 证据, 一次走 Goal reducer (旧写法是 setContinuation + updateGoal + addEvidence 三连)
    await reduceGoalState({
      goalId: g.goalId,
      intent: 'external_wait_expired',
      now: new Date(now).toISOString(),
      by: 'external-events',
      reason,
    }).catch(() => { /* 状态写失败不影响把等待清掉 */ });
  }
  return out;
}
