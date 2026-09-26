/**
 * goal-store.ts — GoalStore: **目标事实来源** (2026-09-16 Milestone 2)
 *
 * 与既有模型的关系 (leo 2026-09-16: 先明确唯一关系, 不急着删旧模块):
 *   GoalStore (本文件, `~/.bolloon/goals/<goalId>.json`)  = 目标的**唯一事实来源**
 *   RunStore  (`~/.bolloon/runs/<runId>.json`)              = 一次执行的**唯一事实来源**
 *   SessionStore                                            = 对话上下文来源
 *   Task/Plan                                               = Goal 的执行辅助结构 (不承载目标状态)
 *   旧模型保留但降级为"入口/草稿": `pi-ecosystem-goals` 的 queue.json (目标队列) 与
 *   `goal-resume` 的 park/resume (双栖接力) 仍是生产者, 迁移留待后续批次 —— 不删。
 *
 * 关键规则 (协议 §「关键规则」):
 *   - Goal 永远不能因为一次 prompt 结束就自动消失
 *   - Run 结束 ≠ Goal 完成; 只有 successCriteria 全部满足 (且有证据) 才能 completed
 *   - 不允许"done 但目标没达成"伪装成功
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * 2026-09-16 (M2-B/A): Goal 状态机与 leo 计划的 2-C 唤醒表 1:1 对齐。
 * 语义: active=现在就能推进; recovering=崩溃接管中; retry_wait=等 retryAt; awaiting_external=等外部事件;
 *       stalled=失速待 Supervisor 决策; paused/needs_human=等人; completed/failed/abandoned=终态。
 */
// 2026-09-19: 外部事件来源 (含 'contact' = 手机/邮箱回复)。定义在这里, external-events 复用,
//   避免 goal-store ←→ external-events 循环 import。
export type GoalExternalSource = 'p2p' | 'delegate' | 'http' | 'contact' | 'any';

// 2026-09-25 (飞轮接线): 类型**只读**引用冻结面 (types.ts 零 import, 因此不构成循环);
//   用途: Goal.continuation 上与 GoalContinuationRecord 收敛的那几个字段 (见下)。
import type { GoalChangeRequest, GoalContinuationRecord, GoalLifecycleState, PendingReport, UserVisibleState } from './goal-flywheel/types.js';
import { toUserVisibleState } from './goal-flywheel/work-monitor.js';

export type GoalStatus =
  | 'open' | 'active' | 'recovering' | 'retry_wait' | 'awaiting_external' | 'stalled'
  | 'paused' | 'needs_human' | 'completed' | 'failed' | 'abandoned';

/** 可被 Supervisor 自动唤醒推进的状态 (其余必须等人或等外部事件) */
export const GOAL_RUNNABLE_STATUSES: GoalStatus[] = ['open', 'active', 'recovering', 'retry_wait', 'stalled'];

/**
 * 2026-09-16 (M2-A): 长期执行的**调度元数据** —— 回答"这个目标下一次该在何时、因为什么被唤醒"。
 * 不新增第四套目标库: 它就挂在 Goal 上 (GoalStore 仍是唯一长期事实来源)。
 */
export interface GoalContinuation {
  /** 下一个 Run 的入口动作 (来自上一个 Run 的 checkpoint) */
  nextAction?: string;
  /** 唤醒原因: 状态机语义 */
  wakeReason?: 'new_goal' | 'active' | 'recovering' | 'retry_wait' | 'awaiting_external' | 'stalled' | 'paused' | 'needs_human' | 'completed' | 'failed';
  /** 何时可被唤醒 (retry_wait 用; ISO 时间) */
  wakeAt?: string;
  /** 是否允许自动继续 (false = 必须人等: paused / needs_human) */
  autoContinue: boolean;
  /** 在等什么外部事件 (peer/delegate/网络), 人可读描述 */
  needsExternal?: string;
  /** 已完成动作数 (跨 Run 汇总, 用于 continuation 指令) */
  completedActions?: number;
  /** 跨 Run 的非幂等重放守卫 (上一个 Run 已成功的非幂等动作) */
  replayGuards?: { tool: string; argsDigest?: string; summary: string }[];
  /** 自动继续的尝试次数 (退避/熔断用) */
  attempts?: number;
  /** 最近一次执行的 runId */
  lastRunId?: string;
  /** 2026-09-16 (2-C.4): 正在等待的外部事件 (来源/关联/过期) —— 事件处理器只认这份事实 */
  external?: {
    requestId: string;
    continuationId: string;
    expectedSource: GoalExternalSource;
    expectedEvent?: string;
    createdAt: string;
    expiresAt: string;
    note?: string;
  };
  /** 最近一次外部事件结果 (事实) */
  externalResult?: { eventId: string; source: string; fromDid?: string; at: string; payload?: unknown };
  /** 已处理过的 eventId (幂等去重, 最多留 20 条) */
  deliveredEventIds?: string[];
  /** 2026-09-16 (2-G.2): 技能就绪事实 (最近一次门禁结论) */
  skillReadiness?: { ok: boolean; at: string; reason?: string; missing?: string[]; drift?: { name: string; expected?: string; actual: string }[]; degradations?: string[] };
  /** 外部等待超时的原因 (转人工时写) */
  lastExternalTimeout?: string;
  // ───────────────────────────────────────────────────────────────────────────
  // 2026-09-25 (飞轮接线): GoalContinuation 与冻结面 `GoalContinuationRecord` 收敛到一处 ——
  //   下面几个字段就是 `GoalContinuationRecord` 里"旧类型没有"的那部分, 现在**写在同一个对象上**
  //   (不再各存一套继续机制)。唯一写入者是 `goal-flywheel-wiring.ts` 的
  //   `toGoalStoreContinuation()` (见该文件 §5)。
  // ───────────────────────────────────────────────────────────────────────────
  /** 当前长期生命周期状态 (与 goal.status 同域; `open` 读作 `active`) */
  state?: GoalLifecycleState;
  /** 最近一次继续决策 id (`decision:<goalId>:<runId>`, 决策记录可回放) */
  lastDecisionId?: string;
  /** 下一步由谁执行 (null = 本节点即可; delegate 决策会填能力名) */
  requiredAgent?: string;
  /** 仍未解决项 (飞轮收尾写入; 非空不许判完成) */
  unresolvedItems?: string[];
  /** 还没回报的子 Agent 工作 (P2 合同签发时写入, 回报被接受后移除) */
  pendingReports?: PendingReport[];
  updatedAt?: string;
}

/** 2026-09-16 (M2-B): 执行权租约 —— 保证同一 Goal 同时只有一个 worker */
export interface GoalLease {
  owner: string;
  leaseId: string;
  claimedAt: string;
  lastHeartbeat: string;
  leaseUntil: string;
}

/** Goal 的持久化形态 */
export interface GoalRecord {
  goalId: string;
  objective: string;
  /** 完成判据 (可判定条目; 空数组 = 未声明判据, 一律不许自动判完成) */
  successCriteria: string[];
  constraints: string[];
  budget?: { maxRuns?: number; deadlineMs?: number };
  status: GoalStatus;
  channelId?: string;
  agentId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** 当前/最近一次执行 */
  currentRunId?: string;
  /** 该目标下所有执行 (历史保留) */
  runs: string[];
  /** 已满足的判据下标 */
  completedCriteria: number[];
  /** 未解决项 (失败步骤/待人工确认) —— 非空则不许判完成 */
  unresolvedItems: string[];
  /** 目标级证据 (成功步骤的事实摘要) */
  evidence: string[];
  /** 2026-09-16 (2-G.2): 这个目标依赖的技能 (前缀 '?' = 可选) —— 首次执行时冻结版本+hash */
  requiredSkills?: string[];
  /** 2026-09-16 (2-F): 判据从哪来 (user = 用户明确给出; agent_proposed = 候选, 未确认前不许完成) */
  criteriaSource?: 'user' | 'agent_proposed' | 'imported' | 'unknown';
  /** 判据是否已被确认 (候选判据 false → 永不自动完成) */
  criteriaConfirmed?: boolean;
  /** 判据版本 (每次改判据 +1, 便于审计"用的哪一版判据") */
  criteriaVersion?: number;
  criteriaConfirmedBy?: string;
  criteriaConfirmedAt?: string;
  /** 候选判据 (未确认时留痕) */
  proposedCriteria?: string[];
  /** 冻结的技能快照 (后续 Run 不重新随意扫目录; 漂移要人工批准) */
  skillSnapshot?: { name: string; version: string; contentHash: string; source?: string; resolvedAt: string }[];
  resolution?: { reason: string; at: string };
  /** 长期执行调度元数据 (M2-A) */
  continuation?: GoalContinuation;
  /**
   * 2026-09-25 (飞轮接线 P4): 新要求注入的记录 —— **原话逐字** + 分诊 + 生效状态 + 判据版本。
   * 只影响后续 Run (不改写已发生的历史); 由 `goal-flywheel-wiring.ingestGoalChange` 写入。
   */
  goalChanges?: GoalChangeRequest[];
  /** 执行权租约镜像 (真值在 <goalId>.lease 文件; 这里只为可读) */
  lease?: GoalLease;
  /**
   * 2026-09-26 (P7 接线): Goal 的**可选**模型策略 (`auto` / `pinned` / `session`)。
   *
   * 形状与 `model-policy.GoalModelPolicy` 同域, 这里只写结构类型 —— 免得 goal-store ↔ model-policy
   * 互相静态 import 成环。读取优先级由 `readGoalModelPolicy` 定: **记录上这个字段优先**, 没有再读
   * 同级的 sidecar 文件。一次 `/model` 切换**不许**改写它 (Goal 的模型策略是用户对这条目标的决定)。
   * 通过既有的 `updateGoal(goalId, { modelPolicy })` 写入, 不需要另开写口。
   */
  modelPolicy?: {
    mode: 'auto' | 'pinned' | 'session';
    pin?: { provider: string; model: string; baseUrl?: string };
    note?: string;
    updatedBy?: string;
    updatedAt?: string;
  } | null;
}

export interface CreateGoalOptions {
  objective: string;
  /** 2026-09-16 (2-G.2): 依赖的技能 (前缀 '?' = 可选) */
  requiredSkills?: string[];
  successCriteria?: string[];
  constraints?: string[];
  budget?: GoalRecord['budget'];
  channelId?: string;
  agentId?: string;
  createdBy?: string;
}

export function goalsDir(): string {
  return path.join(os.homedir(), '.bolloon', 'goals');
}

function goalPath(goalId: string): string {
  return path.join(goalsDir(), `${goalId}.json`);
}

/** 原子写 (tmp + rename): 读到的永远是完整 JSON */
async function writeGoal(rec: GoalRecord): Promise<void> {
  await fs.mkdir(goalsDir(), { recursive: true });
  const p = goalPath(rec.goalId);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/** 同 goal 的进程内串行化 (并发写不覆盖判据/证据) */
const goalLocks = new Map<string, Promise<unknown>>();
async function withGoalLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
  const prev = goalLocks.get(goalId) || Promise.resolve();
  const mine = prev.catch(() => {}).then(fn);
  const tail = mine.catch(() => {});
  goalLocks.set(goalId, tail);
  try { return await mine; }
  finally { if (goalLocks.get(goalId) === tail) goalLocks.delete(goalId); }
}

export function newGoalId(): string {
  return `g-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function createGoal(opts: CreateGoalOptions): Promise<GoalRecord> {
  // 2026-09-16 (Phase 3 硬门禁): 初始化未就绪时**不允许创建长期 Goal**。
  //   生产环境生效; 测试环境跳过 (用例跑在隔离 HOME, 本来就没有真实配置)。
  if (!process.env.VITEST && process.env.BOLLOON_SETUP_IN_PROGRESS !== '1') {
    try {
      const { getSetupGateCached } = await import('../setup/setup-store.js');
      const { gate, state } = await getSetupGateCached();
      if (gate !== 'ready') {
        throw new Error(`初始化未就绪 (${gate}, 阶段 ${state.stage}) — 不允许创建 Goal; 先 \`bolloon setup\``);
      }
    } catch (err: any) {
      if (/初始化未就绪/.test(String(err?.message || ''))) throw err;
      // 门禁自身不可读 → fail-closed (不放行)
      throw new Error(`初始化状态不可读, 拒绝创建 Goal (fail-closed): ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  const now = new Date().toISOString();
  const rec: GoalRecord = {
    goalId: newGoalId(),
    objective: String(opts.objective || '').slice(0, 500),
    successCriteria: (opts.successCriteria || []).map((c) => String(c).slice(0, 200)).slice(0, 20),
    // 用户明确给出判据 → 直接视为已确认 (criteriaSource=user); 没给 → unknown, 之后由 agent 提候选
    criteriaSource: (opts.successCriteria && opts.successCriteria.length) ? 'user' : 'unknown',
    criteriaConfirmed: !!(opts.successCriteria && opts.successCriteria.length),
    criteriaVersion: 1,
    constraints: (opts.constraints || []).map((c) => String(c).slice(0, 200)).slice(0, 20),
    requiredSkills: (opts.requiredSkills || []).map((c) => String(c).slice(0, 120)).slice(0, 20),
    budget: opts.budget,
    status: 'open',
    channelId: opts.channelId,
    agentId: opts.agentId,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
    runs: [],
    completedCriteria: [],
    unresolvedItems: [],
    evidence: [],
  };
  await writeGoal(rec);
  return rec;
}

export async function readGoal(goalId: string): Promise<GoalRecord | null> {
  if (!goalId) return null;
  try {
    return JSON.parse(await fs.readFile(goalPath(goalId), 'utf8')) as GoalRecord;
  } catch {
    return null;
  }
}

export async function listGoals(opts: { status?: GoalStatus | GoalStatus[]; limit?: number } = {}): Promise<GoalRecord[]> {
  let files: string[] = [];
  try { files = await fs.readdir(goalsDir()); } catch { return []; }
  const out: GoalRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const g = await readGoal(f.replace(/\.json$/, ''));
    if (!g) continue;
    if (opts.status) {
      const want = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (!want.includes(g.status)) continue;
    }
    out.push(g);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out;
}

/**
 * 低层写入原语: 把 patch 合并进 goal.json。
 *
 * ★ 2026-09-25 (M0 接线冻结, 规则 ②「只有 Goal reducer 能改 Goal 状态」):
 *   改 `status` 的**唯一**合法调用方是 `goal-state-reducer.ts` 的 `reduceGoalState`。
 *   其他任何模块想改状态, 都必须表达成一个 intent 交给 reducer (它负责: 终态保护 /
 *   完成门 / continuation 的唤醒语义 / 审计痕迹)。直接在这里写 status 会被
 *   `src/test/goal-flywheel-m0-freeze.test.ts` 的源码级门判红 (按**文件**粒度扫, 不按行)。
 *   非状态字段 (evidence / criteria / title ...) 仍可直接调本函数。
 */
export async function updateGoal(goalId: string, patch: Partial<GoalRecord>): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    const next: GoalRecord = { ...rec, ...patch, goalId: rec.goalId, updatedAt: new Date().toISOString() };
    await writeGoal(next);
    return next;
  });
}

/**
 * 把一次 Run 挂到 Goal 上 (Run 反查 Goal 的入口)。
 * 幂等: 同一 runId 重复挂不会产生重复条目。
 */
export async function attachRun(goalId: string, runId: string, opts: { makeCurrent?: boolean } = {}): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    if (!rec.runs.includes(runId)) rec.runs.push(runId);
    if (opts.makeCurrent !== false) rec.currentRunId = runId;
    if (rec.status === 'open') rec.status = 'active';
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/** 标记某条判据已满足 (+可选证据) */
export async function markCriterion(goalId: string, index: number, satisfied: boolean, evidence?: string): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    if (index < 0 || index >= rec.successCriteria.length) return rec;
    const set = new Set(rec.completedCriteria);
    if (satisfied) set.add(index); else set.delete(index);
    rec.completedCriteria = Array.from(set).sort((a, b) => a - b);
    if (evidence) rec.evidence = [...rec.evidence, String(evidence).slice(0, 300)].slice(-50);
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/** 记录未解决项 (失败步骤 / 待人工确认) —— 有未解决项就不许判完成 */
export async function setUnresolved(goalId: string, items: string[]): Promise<GoalRecord | null> {
  return updateGoal(goalId, { unresolvedItems: items.map((i) => String(i).slice(0, 300)).slice(0, 30) });
}

export async function addEvidence(goalId: string, evidence: string[]): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    rec.evidence = [...rec.evidence, ...evidence.map((e) => String(e).slice(0, 300))].slice(-50);
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/**
 * 完成门 (Milestone 4): **确定性**判定, 不看模型怎么说。
 *   全部必要判据满足 + 有证据 + 无未解决项 → 才允许 completed。
 *   未声明 successCriteria 的目标**永不**自动完成 (需要人显式确认) —— 否则"模型说完成"就变成了完成。
 */
export function evaluateGoalCompletion(goal: GoalRecord, opts: { lastRunStatus?: string } = {}): { complete: boolean; reason: string; missing: string[] } {
  if (!goal.successCriteria.length) {
    return { complete: false, reason: '未声明 successCriteria: 不允许自动判完成 (需人工确认)', missing: [] };
  }
  // 2-F: 候选判据 (未确认) 不许当作完成条件
  if (goal.criteriaSource === 'agent_proposed' && goal.criteriaConfirmed !== true) {
    return { complete: false, reason: `判据是 agent 提的候选 (v${goal.criteriaVersion || 1}), 未经人确认 → 不许判完成`, missing: goal.successCriteria };
  }
  if (goal.criteriaConfirmed === false) {
    return { complete: false, reason: '判据未确认 → 不许判完成', missing: goal.successCriteria };
  }
  // 2-F: 最近一条 Run 还处于"没跑完"的状态 (失败/中断/失速) → 不许判完成
  const lastRunStatus = opts.lastRunStatus;
  if (lastRunStatus && ['failed', 'interrupted', 'stalled'].includes(String(lastRunStatus))) {
    return { complete: false, reason: `最近一条 Run 状态是 ${lastRunStatus} (未处理好) → 不许判完成`, missing: [] };
  }
  const missing = goal.successCriteria
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !goal.completedCriteria.includes(i))
    .map(({ c, i }) => `[${i}] ${c}`);
  if (missing.length) {
    return { complete: false, reason: `还有 ${missing.length} 条判据未满足`, missing };
  }
  if (!goal.evidence.length) {
    return { complete: false, reason: '没有证据 (evidence 为空): 不许判完成', missing: [] };
  }
  if (goal.unresolvedItems.length) {
    return { complete: false, reason: `还有 ${goal.unresolvedItems.length} 项未解决`, missing: goal.unresolvedItems };
  }
  return { complete: true, reason: '全部判据满足 + 有证据 + 无未解决项', missing: [] };
}

/**
 * 设置/确认判据 (2-F)。
 *   source: 谁给的 (user 显式给 / agent_proposed 候选 / imported)
 *   confirm: 是否视为已确认 —— **候选判据必须显式 confirm 才可能完成**
 */
export async function setCriteria(
  goalId: string,
  opts: { criteria?: string[]; source?: GoalRecord['criteriaSource']; confirm?: boolean; by?: string },
): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    if (opts.criteria) {
      rec.successCriteria = opts.criteria.map((c) => String(c).slice(0, 200)).slice(0, 20);
      rec.criteriaVersion = (rec.criteriaVersion || 1) + 1;
      rec.completedCriteria = [];                       // 判据变了 → 之前的满足记录作废 (避免拿旧判据凑完成)
    }
    if (opts.source) rec.criteriaSource = opts.source;
    if (opts.confirm !== undefined) {
      rec.criteriaConfirmed = opts.confirm;
      rec.criteriaConfirmedBy = opts.confirm ? (opts.by || 'human') : undefined;
      rec.criteriaConfirmedAt = opts.confirm ? new Date().toISOString() : undefined;
    }
    if (opts.source === 'agent_proposed' && !opts.confirm) rec.proposedCriteria = rec.successCriteria;
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/** 通过完成门就落 completed, 否则保持原状态并回传原因 (不静默) */
export async function completeGoalIfEligible(goalId: string): Promise<{ ok: boolean; reason: string; goal: GoalRecord | null; missing?: string[] }> {
  const goal = await readGoal(goalId);
  if (!goal) return { ok: false, reason: `goal 不存在: ${goalId}`, goal: null };
  // 2-F: 把"最近一条 Run 的真实状态"一起纳入完成门 (失败/中断/失速时不许判完成)
  let lastRunStatus: string | undefined;
  try {
    const lastRunId = goal.currentRunId || goal.runs?.[goal.runs.length - 1];
    if (lastRunId) {
      const { readRun } = await import('./run-store.js');
      lastRunStatus = (await readRun(lastRunId))?.status;
    }
  } catch { /* 读不到就不加这一条约束, 其余判据照旧 */ }
  const verdict = evaluateGoalCompletion(goal, { lastRunStatus });
  if (!verdict.complete) return { ok: false, reason: verdict.reason, goal, missing: verdict.missing };
  const next = await updateGoal(goalId, {
    status: 'completed',
    resolution: { reason: verdict.reason, at: new Date().toISOString() },
  });
  return { ok: true, reason: verdict.reason, goal: next };
}

/**
 * 找一个"还在进行中"的目标 (供 prompt 入口判断"继续还是新建")。
 * 只看 open/active, 且限定 channel+agent (不同智能体的目标不混)。
 */
export async function findActiveGoal(opts: { channelId?: string; agentId?: string }): Promise<GoalRecord | null> {
  const all = await listGoals({ status: ['open', 'active'] });
  for (const g of all) {
    if (opts.channelId && g.channelId && g.channelId !== opts.channelId) continue;
    if (opts.agentId && g.agentId && g.agentId !== opts.agentId) continue;
    return g;
  }
  return null;
}

/** 给 CLI/Web 的一行摘要 */
export function formatGoalLine(g: GoalRecord): string {
  const done = `${g.completedCriteria.length}/${g.successCriteria.length || 0}`;
  return `${g.goalId}  [${g.status.padEnd(9)}] 判据 ${done.padStart(4)}  run=${(g.currentRunId || '-').slice(0, 12)}  ${g.objective.slice(0, 44)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-16 (M2-A): continuation —— "下一次何时、因为什么被唤醒"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 写调度元数据 (合并式)。
 * 这是 2-A 的落地: Goal 永远能回答"下一步是什么/还需不需要自动继续/在等什么"。
 */
export async function setContinuation(goalId: string, patch: Partial<GoalContinuation>): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    rec.continuation = {
      ...(rec.continuation || { autoContinue: true }),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/** 幂等地累加自动继续尝试次数 (退避用) */
export async function bumpContinuationAttempts(goalId: string): Promise<number> {
  const rec = await readGoal(goalId);
  const n = (rec?.continuation?.attempts || 0) + 1;
  await setContinuation(goalId, { attempts: n });
  return n;
}

export async function resetContinuationAttempts(goalId: string): Promise<void> {
  await setContinuation(goalId, { attempts: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-16 (M2-B): 执行权租约 (跨进程排他) —— 真值在 <goalId>.lease 文件, 用 O_EXCL 独占创建
// ─────────────────────────────────────────────────────────────────────────────

function leasePath(goalId: string): string {
  return path.join(goalsDir(), `${goalId}.lease`);
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export interface LeaseClaimResult {
  ok: boolean;
  lease?: GoalLease & { pid?: number; host?: string };
  reason?: string;
  /** 被拒时: 当前持有者 */
  holder?: GoalLease & { pid?: number; host?: string };
}

export async function readLease(goalId: string): Promise<(GoalLease & { pid?: number; host?: string }) | null> {
  try {
    return JSON.parse(await fs.readFile(leasePath(goalId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 抢执行权 (原子: 独占创建 lease 文件)。
 * 可回收条件 (任一):
 *   ① leaseUntil 已过期 (TTL)
 *   ② 持有者进程已不在 (更早回收 —— 持有者可证明已死, 不必等满 TTL)
 * 不可回收: 持有者活着且未过期 → 明确返回 ok:false + holder (调用方据此"让路", 不是报错)
 */
export async function claimGoal(
  goalId: string,
  opts: { owner: string; ttlMs?: number; now?: number } = { owner: 'unknown' },
): Promise<LeaseClaimResult> {
  const ttl = opts.ttlMs ?? 90_000;
  const now = opts.now ?? Date.now();
  await fs.mkdir(goalsDir(), { recursive: true });
  const p = leasePath(goalId);

  for (let attempt = 0; attempt < 2; attempt++) {
    const claimedAt = new Date(now).toISOString();
    const lease: GoalLease & { pid: number; host: string } = {
      owner: opts.owner,
      leaseId: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      claimedAt,
      lastHeartbeat: claimedAt,
      leaseUntil: new Date(now + ttl).toISOString(),
      pid: process.pid,
      host: os.hostname(),
    };
    try {
      const fh = await fs.open(p, 'wx');
      await fh.writeFile(JSON.stringify(lease, null, 2), 'utf8');
      await fh.close();
      // 镜像到 Goal 文件 (只为可读; 真值在 lease 文件)
      await updateGoal(goalId, { lease: { owner: lease.owner, leaseId: lease.leaseId, claimedAt, lastHeartbeat: claimedAt, leaseUntil: lease.leaseUntil } });
      return { ok: true, lease };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return { ok: false, reason: `lease 文件不可创建: ${String((err as Error)?.message || err).slice(0, 120)}` };
      }
      const holder = await readLease(goalId);
      if (!holder) { await fs.rm(p, { force: true }); continue; }   // 坏文件 → 当陈旧回收
      const expired = Date.parse(String(holder.leaseUntil || '')) <= now;
      const dead = holder.pid ? !pidAlive(Number(holder.pid)) : false;
      if (expired || dead) {
        await fs.rm(p, { force: true });
        continue;
      }
      return { ok: false, reason: `lease 被占用 (owner=${holder.owner}, until=${holder.leaseUntil})`, holder };
    }
  }
  return { ok: false, reason: 'lease 抢占重试后仍失败' };
}

/** 续租 (必须带自己的 leaseId: 被接管后旧 worker 不能再续租, 也就不能再写) */
export async function heartbeatGoal(goalId: string, leaseId: string, ttlMs = 90_000, now = Date.now()): Promise<{ ok: boolean; reason?: string; lease?: GoalLease }> {
  const cur = await readLease(goalId);
  if (!cur) return { ok: false, reason: 'lease 不存在 (可能已过期被回收)' };
  if (cur.leaseId !== leaseId) return { ok: false, reason: `lease 已被接管 (当前 owner=${cur.owner})` };
  const next = { ...cur, lastHeartbeat: new Date(now).toISOString(), leaseUntil: new Date(now + ttlMs).toISOString() };
  try {
    await fs.writeFile(leasePath(goalId), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, reason: `续租写失败: ${String((err as Error)?.message || err).slice(0, 120)}` };
  }
  await updateGoal(goalId, { lease: { owner: next.owner, leaseId: next.leaseId, claimedAt: next.claimedAt, lastHeartbeat: next.lastHeartbeat, leaseUntil: next.leaseUntil } });
  return { ok: true, lease: next };
}

/** 释放执行权 (只释放自己的那把) */
export async function releaseGoal(goalId: string, leaseId: string): Promise<{ ok: boolean; reason?: string }> {
  const cur = await readLease(goalId);
  if (!cur) {
    await updateGoal(goalId, { lease: undefined });
    return { ok: true };
  }
  if (cur.leaseId !== leaseId) return { ok: false, reason: `lease 已被接管, 未释放 (当前 owner=${cur.owner})` };
  await fs.rm(leasePath(goalId), { force: true });
  await updateGoal(goalId, { lease: undefined });
  return { ok: true };
}

/**
 * 扫出"现在就该跑"的 Goal (M2-B 第 1-2 步: 扫描 + 判断可否唤醒)。
 * 规则: 状态 ∈ active/recovering; autoContinue !== false; wakeAt 未到则跳过; 有活租约则跳过。
 * 返回附带"为什么没被选"的说明, 便于诊断 (不静默)。
 */
export async function listRunnableGoals(opts: { now?: number; owner?: string } = {}): Promise<{
  runnable: GoalRecord[];
  skipped: { goalId: string; status: GoalStatus; reason: string }[];
}> {
  const now = opts.now ?? Date.now();
  const all = await listGoals({ limit: 100 });
  const runnable: GoalRecord[] = [];
  const skipped: { goalId: string; status: GoalStatus; reason: string }[] = [];
  for (const g of all) {
    const c = g.continuation;
    const skip = (reason: string) => skipped.push({ goalId: g.goalId, status: g.status, reason });

    // 终态 / 等人 / 等外部事件 → 一律不自动唤醒 (这是 2-C 唤醒表的硬规则)
    if (g.status === 'completed' || g.status === 'failed' || g.status === 'abandoned') continue;
    if (g.status === 'paused') { skip('paused: 等用户 resume (重启也不会自动跑)'); continue; }
    if (g.status === 'needs_human') { skip(`needs_human: 等人工 approve (${c?.wakeReason || ''})`); continue; }
    if (g.status === 'awaiting_external' || c?.wakeReason === 'awaiting_external') {
      skip(`awaiting_external: 等外部事件${c?.needsExternal ? ` (${c.needsExternal})` : ''}, 不重复发送`);
      continue;
    }
    if (c?.autoContinue === false) { skip(`autoContinue=false (${c.wakeReason || '等人'})`); continue; }
    if (g.status === 'retry_wait' || (c?.wakeAt && Date.parse(c.wakeAt) > now)) {
      if (c?.wakeAt && Date.parse(c.wakeAt) > now) { skip(`retry_wait: 时间未到 (${c.wakeAt})`); continue; }
      // retry_wait 且时间已到 → 可跑
    }
    const lease = await readLease(g.goalId);
    const held = !!lease && Date.parse(String(lease.leaseUntil || '')) > now && (lease.pid ? pidAlive(Number(lease.pid)) : true);
    if (held) { skip(`lease 被 ${lease!.owner} 持有至 ${lease!.leaseUntil}`); continue; }
    runnable.push(g);
  }
  // 先跑等着跑最久的 (公平性: 不让一个 Goal 霸占所有 tick)
  runnable.sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));
  return { runnable, skipped };
}

/** CLI/Web 可见的长期执行诊断 (每个 Goal 为什么在/不在跑) */
export async function wakeReport(now = Date.now()): Promise<{
  goalId: string; status: GoalStatus; wake: string; autoContinue: boolean; lease?: string;
  /** 2026-09-25 (飞轮接线 P3): 用户可见六类之一 —— 界面只暴露这个, 不暴露内部状态 */
  visible: UserVisibleState;
  /** 下一步 (飞轮收尾写下的权威 nextAction; 没有则空串) */
  nextAction: string;
  /** 连续无进展轮数 (飞轮熔断依据) —— 只给诊断, 不是"第几轮" */
  noProgressStreakNote?: string;
}[]> {
  const goals = await listGoals({ limit: 50 });
  const out: { goalId: string; status: GoalStatus; wake: string; autoContinue: boolean; lease?: string; visible: UserVisibleState; nextAction: string }[] = [];
  for (const g of goals) {
    const c = g.continuation;
    const lease = await readLease(g.goalId);
    const live = lease && Date.parse(String(lease.leaseUntil || '')) > now && (lease.pid ? pidAlive(Number(lease.pid)) : true);
    let wake = '立即';
    if (g.status === 'completed') wake = '不再唤醒';
    else if (g.status === 'paused' || c?.autoContinue === false) wake = `等人 (${c?.wakeReason || g.status})`;
    else if (c?.wakeAt && Date.parse(c.wakeAt) > now) {
      const left = Math.round((Date.parse(c.wakeAt) - now) / 1000);
      wake = `等时间 (${c.wakeAt}, 还剩 ${left}s${c.attempts ? `, 已自动继续 ${c.attempts} 次` : ''})`;
    }
    else if (g.status === 'awaiting_external' || c?.wakeReason === 'awaiting_external' || c?.external) {
      const what = c?.needsExternal || (c?.external ? `${c.external.expectedSource}${c.external.expectedEvent ? `:${c.external.expectedEvent}` : ''} (requestId=${c.external.requestId}, 过期 ${c.external.expiresAt})` : '');
      wake = `等外部事件${what ? ` (${what})` : ''}`;
    }
    else if (live) wake = `已被 ${lease!.owner} 认领`;
    // 用户视野: 只经 toUserVisibleState 映射; 阻塞明细由飞轮接线层的 collectWorkBlocks 提供
    //   (这里传空阻塞表: goal-store 不读子工作目录, 保持单一事实来源)。
    const visible = toUserVisibleState(continuationView(c, g.status), [], null);
    out.push({ goalId: g.goalId, status: g.status, wake, autoContinue: c?.autoContinue !== false, lease: live ? lease!.owner : undefined, visible, nextAction: c?.nextAction ?? '' });
  }
  return out;
}

/**
 * 把 Goal 上收敛后的 continuation 读成冻结面 `GoalContinuationRecord`。
 * 缺失字段按"没有"补默认值 —— 不许因为少一个字段就崩 (界面是只读视图)。
 */
function continuationView(c: GoalContinuation | undefined, status: GoalStatus): GoalContinuationRecord | null {
  if (!c) return null;
  return {
    nextAction: c.nextAction ?? '',
    wakeAt: c.wakeAt ?? null,
    wakeReason: c.wakeReason ?? 'active',
    autoContinue: c.autoContinue !== false,
    requiredAgent: c.requiredAgent ?? null,
    pendingReports: c.pendingReports ?? [],
    unresolvedItems: c.unresolvedItems ?? [],
    lastDecisionId: c.lastDecisionId ?? null,
    state: c.state ?? (status === 'open' ? 'active' : status),
    updatedAt: c.updatedAt ?? '',
  };
}
