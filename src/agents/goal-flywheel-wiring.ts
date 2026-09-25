/**
 * goal-flywheel-wiring.ts — 把 P0–P4 的**七个独立模块**接进真实执行路径 (2026-09-25)
 *
 * 为什么单独一个文件 (而不是改 `src/agents/goal-flywheel/` 里已有的文件):
 *   §13 的所有权表把 P0–P4 的文件锁成"只准各阶段自己写", 且 `goal-flywheel-types.test.ts`
 *   有一条**名册白名单**门 (目录里出现名册外的 .ts 就判红)。接线层属于"改现有调用方"这一类,
 *   因此它落在目录**外面**, 只 import, 不侵入。
 *
 * 本文件是**唯一**的适配层 (设计 §2 "Goal 上只有一个权威 continuation"):
 *   ① 节奏 (P0): `decideGoalStep` = 读权威 continuation → 读最近 Run 进展 →
 *      `decideContinuation` + `applyHardLimits` + `isRunnable` → 回答"现在该不该跑这一轮"。
 *      **有进展就继续, 没有进展就交人** —— 轮次/时长不是继续的依据 (只由熔断阈值兜底)。
 *   ② 收尾 (P1): `closeGoalRun` 用真 store 注入 `closeRun` 的依赖 (Memory 落盘 / Skill 候选 /
 *      P0 决策器), 成功 / 失败 / 中断恢复的 Run 结尾都走同一条 9 步流水线。
 *   ③ 合同 (P2): `dispatchChildWork` (派遣必签合同) / `handleChildReport`
 *      (`validateChildReport` + `acceptsAsComplete` —— 漂亮但无证据的回报不算完成)。
 *   ④ 阻塞 (P3): `collectWorkBlocks` + `applyBlockHandling` (子无心跳先查执行权, 升级/接管)。
 *   ⑤ 变更 (P4): `ingestGoalChange` 原话逐字入档 + 版本号 + 下一 Run 指令; 当前 Run 历史不改写。
 *   ⑥ 视图: `goalVisibleState` = `toUserVisibleState` (用户只看到六类, 不出现内部词)。
 *
 * 与既有 reducer 的分工 (必须说清, 否则两套机制会打架):
 *   · **飞轮决定"还要不要继续"** (是否停 / 是否交人 / 是否熔断);
 *   · 既有的 `decideGoalOutcome` (execution-supervisor) 退化为**运输层**: 可恢复失败等多久
 *     (退避/wakeAt/attempts/retry_wait)。它**只能被飞轮收紧** —— 见 `mergeGoalOutcome`:
 *       - 飞轮判 fail/complete/pause/熔断 → 一律照飞轮的停 (运输层无权放开);
 *       - 运输层因"轮次用尽"要停, 但飞轮说**有进展**且不是硬错误 → 继续跑 (轮次不再是主停止条件);
 *       - 其余情况运输层照旧 (退避语义不变)。
 *   无进展熔断阈值默认 = 旧的自动继续次数 + 1 (`BOLLOON_GOAL_NO_PROGRESS_BREAKER` 可调),
 *   因此"连续 N 轮没证据就交人"的行为与旧阈值一致, 但依据从"第几轮"换成了"有没有新证据"。
 *
 * 落盘布局 (全部相对 `os.homedir()`, 与 goal-store / run-store 同一手法):
 *   <home>/.bolloon/goal-decisions/<goalId>--<runId>.json   每次决策的可回放记录
 *   <home>/.bolloon/goal-works/<goalId>/<workId>.json       子 Agent 工作合同 (+ .hb / .report)
 *   <home>/.bolloon/goal-reports/<goalId>--<runId>.json     给用户的汇报 (P4b 第一份输出)
 *   <home>/.bolloon/skill-candidates/<candidateId>.json     Skill 改进候选 (永不写 skills/)
 *   <home>/.bolloon/memory-layers/<layer>/<memoryId>.json   分层记忆 (memory-layers.ts 自己落)
 *
 * 不做 (设计 §10): 不新增调度器 / 不另起 workflow engine / 不建第二个任务库。
 *   本文件的全部状态都挂在既有 Goal / Run 文件与上面几个目录里。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  addEvidence,
  listGoals,
  readGoal,
  setContinuation,
  updateGoal,
  type GoalContinuation,
  type GoalRecord,
  type GoalStatus,
} from './goal-store.js';
import { readRun, type RunRecord } from './run-store.js';
import { applyHardLimits, decideContinuation, isRunnable } from './goal-flywheel/continuation-decision.js';
import { closeRun, type CloseRunInput, type CloseRunResult } from './goal-flywheel/run-closure.js';
import { writeMemoryRecords } from './goal-flywheel/memory-layers.js';
import { assessCandidate } from './goal-flywheel/skill-candidate.js';
import { acceptsAsComplete, issueWorkContract, stableHash, validateChildReport } from './goal-flywheel/work-contract.js';
import { detectBlocks, planBlockHandling, toUserVisibleState } from './goal-flywheel/work-monitor.js';
import { applyChange, classifyChange, ingestChange, nextStatusFor, shouldSupersedePending } from './goal-flywheel/goal-change.js';
import type { ChangeApplication } from './goal-flywheel/goal-change.js';
import type {
  AgentWorkContract,
  AgentWorkReport,
  BlockRecord,
  BlockResolutionAction,
  ChangeSource,
  ContinuationDecision,
  GoalChangeRequest,
  GoalContinuationRecord,
  GoalLifecycleState,
  HardLimits,
  IsoTimestamp,
  MemoryRecord,
  PendingReport,
  ProgressDelta,
  SkillImprovementCandidate,
  UserVisibleState,
  WorkBudget,
} from './goal-flywheel/types.js';

// ============================================================================
// §0. 路径 / 常量 (全部导出: 测试与调用方不许自己手抄布局)
// ============================================================================

export const GOAL_DECISIONS_ROOT = '.bolloon/goal-decisions';
export const GOAL_WORKS_ROOT = '.bolloon/goal-works';
export const GOAL_REPORTS_ROOT = '.bolloon/goal-reports';
export const SKILL_CANDIDATES_ROOT = '.bolloon/skill-candidates';

/** 三类硬底线 (安全线, 不是任务节奏) 的接线层默认值 —— 字面量常量, 便于与 env 比对 */
export const HARD_LIMIT_DEFAULTS = {
  maxRunDurationMs: 30 * 60_000,
  maxGoalBudget: 50,
  noProgressCircuitBreaker: 3,
} as const;

/** 同上, 冻结面类型形态 */
export const DEFAULT_HARD_LIMITS: HardLimits = {
  /** 单 Run 时间上限 (30 分钟; `BOLLOON_GOAL_MAX_RUN_MS` 可调) */
  maxRunDurationMs: 30 * 60_000,
  /**
   * 单 Goal 预算上限 (默认 50 个 Run; `BOLLOON_GOAL_MAX_RUNS` 可调)。
   * 刻意**不**留 null: 冻结语义里 `maxGoalBudget === null` = "必须由人显式确认",
   * 留 null 会把**每一次**自治继续都收紧成"交人" (等于没有飞轮)。所以这里注入一个
   * 真实上限 (达到就停), 而不是把上限留空。
   */
  maxGoalBudget: 50,
  /** 无进展熔断阈值 (默认 3; `BOLLOON_GOAL_NO_PROGRESS_BREAKER` 可调) */
  noProgressCircuitBreaker: HARD_LIMIT_DEFAULTS.noProgressCircuitBreaker,
};

/** 不可恢复的 Run 失败分类 (运输层与飞轮都不许因此自动续跑) */
export const HARD_STOP_ERROR_CLASSES: readonly string[] = [
  'auth',
  'persist_failed',
  'corrupt_state',
  'policy_denied',
  'repeat_failure',
  'bad_args',
  'no_such_tool',
];

export function bolloonHome(): string {
  return os.homedir();
}

function safeName(id: string): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function atomicWrite(file: string, payload: string): Promise<void> {
  return (async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, file);
  })();
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function envNum(name: string, dflt: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

function uniqNonEmpty(xs: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const x of xs) {
    const s = typeof x === 'string' ? x.trim() : '';
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** GoalStatus → 冻结面的生命周期状态 (`open` = 还没起第一个 Run → 读作 active) */
export function lifecycleOf(status: GoalStatus | string): GoalLifecycleState {
  return (status === 'open' ? 'active' : String(status)) as GoalLifecycleState;
}

// ============================================================================
// §1. 三类硬底线 (只保留、只收紧)
// ============================================================================

/**
 * 从 Goal / Run 事实 + 环境变量算出三类硬底线。
 *
 * - `maxRunDurationMs`: Run 自己的预算 (`run.budget.deadlineMs`) 优先, 否则接线层默认;
 * - `maxGoalBudget`: Goal 自己的预算 (`budget.maxRuns` / `budget.deadlineMs`) 优先, 否则默认;
 * - `noProgressCircuitBreaker`: **默认 = 旧的自动继续次数 + 1** —— 这样"连续 N 轮无证据 → 交人"
 *   的阈值与旧行为一致, 但依据是"有没有新证据"而不是"第几轮"(见文件头)。
 */
export function hardLimitsFor(input: { goal: GoalRecord; run: RunRecord | null; maxRetries?: number }): HardLimits {
  const runDeadline = input.run?.budget?.deadlineMs;
  const goalBudget = input.goal.budget?.maxRuns ?? input.goal.budget?.deadlineMs;
  const breakerBase = typeof input.maxRetries === 'number' && Number.isFinite(input.maxRetries) && input.maxRetries >= 0
    ? input.maxRetries + 1
    : HARD_LIMIT_DEFAULTS.noProgressCircuitBreaker;
  return {
    maxRunDurationMs: typeof runDeadline === 'number' && runDeadline > 0
      ? runDeadline
      : envNum('BOLLOON_GOAL_MAX_RUN_MS', HARD_LIMIT_DEFAULTS.maxRunDurationMs),
    maxGoalBudget: typeof goalBudget === 'number' && goalBudget > 0
      ? goalBudget
      : envNum('BOLLOON_GOAL_MAX_RUNS', HARD_LIMIT_DEFAULTS.maxGoalBudget),
    noProgressCircuitBreaker: Math.max(1, Math.floor(envNum('BOLLOON_GOAL_NO_PROGRESS_BREAKER', breakerBase))),
  };
}

// ============================================================================
// §2. 每次决策的可回放记录 (P0 第 2 条: "每次决策落盘可回放")
// ============================================================================

export interface DecisionRecordSnapshot {
  status: GoalStatus;
  completedCriteria: number[];
  evidenceCount: number;
  unresolvedItems: string[];
  criteriaVersion: number;
}

export interface DecisionRecord {
  goalId: string;
  runId: string;
  /** preflight = 跑之前的"该不该跑"; closure = Run 收尾后的权威决策 */
  phase: 'preflight' | 'closure';
  decision: ContinuationDecision;
  runnable: boolean;
  runnableReason: string;
  noProgressStreak: number;
  hardLimits: HardLimits;
  goalSnapshot: DecisionRecordSnapshot;
  recordedAt: IsoTimestamp;
}

export function decisionFilePath(goalId: string, runId: string, phase: 'preflight' | 'closure', home = bolloonHome()): string {
  return path.join(home, GOAL_DECISIONS_ROOT, `${safeName(goalId)}--${safeName(runId)}--${phase}.json`);
}

export async function writeDecisionRecord(rec: DecisionRecord, home = bolloonHome()): Promise<string> {
  const file = decisionFilePath(rec.goalId, rec.runId, rec.phase, home);
  await atomicWrite(file, JSON.stringify(rec, null, 2));
  return file;
}

export async function readDecisionRecords(goalId: string, home = bolloonHome()): Promise<DecisionRecord[]> {
  const dir = path.join(home, GOAL_DECISIONS_ROOT);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const prefix = `${safeName(goalId)}--`;
  const out: DecisionRecord[] = [];
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    const rec = await readJson<DecisionRecord>(path.join(dir, f));
    if (rec && rec.goalId === goalId) out.push(rec);
  }
  // 回放顺序 = 决策时间 (同一时间戳时按 phase: preflight 在 closure 之前)
  out.sort((a, b) => {
    const t = String(a.recordedAt).localeCompare(String(b.recordedAt));
    if (t !== 0) return t;
    return a.phase === b.phase ? 0 : a.phase === 'preflight' ? -1 : 1;
  });
  return out;
}

// ============================================================================
// §3. 进展与无进展连续计数 (进展 = 新的可核验证据 / 新满足的判据)
// ============================================================================

/** 一个 Run 产出的可核验证据 (Run 级 evidence + 成功步骤的事实摘要, 与既有证据写法一致) */
export function runEvidenceOf(run: RunRecord): string[] {
  return uniqNonEmpty([
    ...(run.evidence ?? []),
    ...(run.steps ?? [])
      .filter((s) => s.ok)
      .map((s) => `${run.runId}/${s.tool}: ${String(s.summary || '(完成)').slice(0, 120)}`),
  ]);
}

/**
 * 本轮的 `ProgressDelta`。
 *   - `newEvidence`  = 本轮新增的可核验证据 (Run 的 evidence + 成功步骤);
 *   - `newlyCompletedCriteria` = 判据面**相对上一次决策快照**的增量 (拿不到快照 = 不猜, 记空);
 *   - `stepsAdvanced` = 成功步数 (只作观察, **不算进展**);
 *   - `unresolvedDelta` = 未解决项相对快照的变化。
 */
export function computeRunProgress(
  goal: GoalRecord,
  run: RunRecord,
  prev: DecisionRecordSnapshot | null,
): ProgressDelta {
  return {
    newEvidence: runEvidenceOf(run),
    newlyCompletedCriteria: prev
      ? goal.completedCriteria.filter((i) => !prev.completedCriteria.includes(i))
      : [],
    stepsAdvanced: (run.steps ?? []).filter((s) => s.ok).length,
    unresolvedDelta: prev ? goal.unresolvedItems.length - prev.unresolvedItems.length : 0,
  };
}

function isEmptyProgress(p: ProgressDelta): boolean {
  return (p?.newEvidence?.length ?? 0) === 0 && (p?.newlyCompletedCriteria?.length ?? 0) === 0;
}

/**
 * 连续"无新证据且无新判据"的 Run 数 (**含本轮**)。
 *
 * 依据全部来自盘上的事实 (不猜): 每个历史 Run 优先用它那次收尾记下的 `progressDelta`;
 * 没有收尾记录的历史 Run (接线之前就存在的) 用它自己的 Run 事实判空 (evidence + 成功步骤都为空)。
 */
export async function deriveNoProgressStreak(
  goal: GoalRecord,
  currentRunId: string,
  currentProgress: ProgressDelta,
  records: DecisionRecord[],
  home = bolloonHome(),
): Promise<number> {
  if (!isEmptyProgress(currentProgress)) return 0;
  const closureByRun = new Map<string, ProgressDelta>();
  for (const r of records) {
    if (r.phase !== 'closure') continue;
    closureByRun.set(r.runId, r.decision.progressDelta);
  }
  let streak = 1;
  const history = (goal.runs ?? []).filter((id) => id !== currentRunId);
  for (let i = history.length - 1; i >= 0; i--) {
    const rid = history[i];
    let p = closureByRun.get(rid);
    if (!p) {
      const run = await readRun(rid).catch(() => null);
      if (!run) break; // 读不到事实 → 不猜, 停止回数
      p = { newEvidence: runEvidenceOf(run), newlyCompletedCriteria: [], stepsAdvanced: 0, unresolvedDelta: 0 };
    }
    if (!isEmptyProgress(p)) break;
    streak++;
  }
  void home;
  return streak;
}

// ============================================================================
// §4. 跑之前的节奏判定 (P0)
// ============================================================================

export interface GoalStepDecision {
  goalId: string;
  /** 最近一条 Run 事实 (还没跑过任何 Run 时为 null) */
  run: RunRecord | null;
  /** 首个 Run 之前没有 Run 事实 → 决策为 null (见 reason), 不是编一条决策出来 */
  decision: ContinuationDecision | null;
  runnable: boolean;
  reason: string;
  noProgressStreak: number;
  progress: ProgressDelta | null;
  hardLimits: HardLimits;
}

/**
 * "这个 Goal 现在该不该开下一轮" —— 飞轮节奏的唯一入口。
 *
 * 顺序: 读权威 continuation (goal.continuation) → 读最近 Run 事实 → 读历史决策记录 →
 *       `decideContinuation` → `applyHardLimits` (只收紧) → `isRunnable` → 三类硬底线复核。
 *
 * `writeRecord` 打开时把这次判定按 `phase='preflight'` 落盘 (可回放)。
 */
export async function decideGoalStep(input: {
  goalId: string;
  now?: IsoTimestamp;
  maxRetries?: number;
  home?: string;
  writeRecord?: boolean;
}): Promise<GoalStepDecision | null> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const goal = await readGoal(input.goalId);
  if (!goal) return null;

  const lastRunId = goal.currentRunId || goal.runs?.[goal.runs.length - 1];
  const run = lastRunId ? await readRun(lastRunId).catch(() => null) : null;
  const hardLimits = hardLimitsFor({ goal, run, maxRetries: input.maxRetries });

  // 还没有 Run 事实 → 首个 Run 直接开 (目标本身就是人的意图, 无需先自证进展)
  if (!run) {
    const reason = 'first_run: 还没有 Run 事实 —— 首个 Run 直接开 (目标由人写, 不需要先自证进展)';
    if (input.writeRecord) {
      await writeDecisionRecord(
        {
          goalId: goal.goalId,
          runId: '(none)',
          phase: 'preflight',
          decision: null as unknown as ContinuationDecision,
          runnable: true,
          runnableReason: reason,
          noProgressStreak: 0,
          hardLimits,
          goalSnapshot: snapshotOf(goal),
          recordedAt: now,
        },
        home,
      ).catch(() => null);
    }
    return { goalId: goal.goalId, run: null, decision: null, runnable: true, reason, noProgressStreak: 0, progress: null, hardLimits };
  }

  const records = await readDecisionRecords(goal.goalId, home);
  const prevSnapshot = [...records].reverse().find((r) => r.phase === 'closure')?.goalSnapshot ?? null;
  const progress = computeRunProgress(goal, run, prevSnapshot);
  const streak = await deriveNoProgressStreak(goal, run.runId, progress, records, home);

  const raw = decideContinuation({ goal, run, now, progress, noProgressStreak: streak, hardLimits });
  const tightened = applyHardLimits(raw, hardLimits);
  const gate = isRunnable(tightened, now);

  // 三类硬底线复核 (单 Goal 预算上限: 飞轮的 BudgetDelta 之外必须真的拦住)
  let runnable = gate.runnable;
  let reason = gate.reason;
  const runsUsed = (goal.runs ?? []).length;
  const budgetCap = hardLimits.maxGoalBudget;
  if (runnable && typeof budgetCap === 'number' && runsUsed >= budgetCap) {
    runnable = false;
    reason = `硬底线: 单 Goal 预算已用尽 (${runsUsed} >= ${budgetCap} 个 Run) → 交人复核, 不自动开下一轮`;
  }

  if (input.writeRecord) {
    await writeDecisionRecord(
      {
        goalId: goal.goalId,
        runId: run.runId,
        phase: 'preflight',
        decision: tightened,
        runnable,
        runnableReason: reason,
        noProgressStreak: streak,
        hardLimits,
        goalSnapshot: snapshotOf(goal),
        recordedAt: now,
      },
      home,
    ).catch(() => null);
  }

  return {
    goalId: goal.goalId,
    run,
    decision: tightened,
    runnable,
    reason,
    noProgressStreak: streak,
    progress,
    hardLimits,
  };
}

export function snapshotOf(goal: GoalRecord): DecisionRecordSnapshot {
  return {
    status: goal.status,
    completedCriteria: [...goal.completedCriteria],
    evidenceCount: (goal.evidence ?? []).length,
    unresolvedItems: [...goal.unresolvedItems],
    criteriaVersion: goal.criteriaVersion ?? 1,
  };
}

// ============================================================================
// §5. 收尾 (P1) —— 真 store 注入 closeRun 的全部依赖
// ============================================================================

/** `<home>/.bolloon/skills/<name>/SKILL.md` 的 contentHash (用来证明"没覆盖正在执行的 snapshot") */
export async function skillSnapshotHash(name: string, home = bolloonHome()): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(home, '.bolloon', 'skills', safeName(name), 'SKILL.md'), 'utf8');
    const { createHash } = await import('crypto');
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export const SKILL_CANDIDATE_BOUNDARY_NOTE =
  'Skill 自动更新不覆盖正在执行的 snapshot: 候选只写进 <home>/.bolloon/skill-candidates/, '
  + "`snapshotScope='next_run_only'` 且 `appliesToRunningRun=false` (新版本只影响下一次 Run)。";

/**
 * 收尾候选的 `contentHash` (P5 验收修复)。
 *
 * 只覆盖**草案内容** —— 名字 / 用途 / 输入输出契约 / 保证与不保证 / 失败边界 / 证据面 / 出现次数与边界清晰度;
 * **不含** candidateId / proposedAt / sourceRunIds (同一份内容来自不同 Run 必须是同一个哈希, 否则
 * `assessCandidate` 的 `duplicate_of_existing` 永远判不出来)。算法用 `work-contract.stableHash`
 * (与工作合同/快照同一套哈希口径), 不是 crypto —— 内容哈希只需**可比**, 不需要抗碰撞强度。
 */
export function candidateContentHash(c: SkillImprovementCandidate): string {
  const parts = [
    `name=${c.name}`,
    `purpose=${c.purpose}`,
    `input=${c.inputSchema}`,
    `output=${c.outputSchema}`,
    `guarantees=${[...(c.guarantees ?? [])].join('|')}`,
    `doesNotGuarantee=${[...(c.doesNotGuarantee ?? [])].join('|')}`,
    `failureCases=${[...(c.failureCases ?? [])].join('|')}`,
    `evidenceRefs=${[...(c.evidenceRefs ?? [])].join('|')}`,
    `occurrences=${c.occurrences}`,
    `boundaryClear=${c.boundaryClear === true}`,
  ];
  return stableHash(parts.join('\u0000'));
}

/**
 * 写一条 Skill 改进候选 (closeRun 的 `deps.writeCandidate`)。
 *
 * 两道门:
 *   ① 垃圾候选**不落盘** (`assessCandidate` 的垃圾理由非空 → 返回 null, 并留下原因);
 *   ② **永不写** `<home>/.bolloon/skills/` —— 正在执行的 Skill snapshot 不可能被自动更新覆盖;
 *      候选记录里显式标注 `snapshotScope='next_run_only'` 与冻结时的运行中哈希 (可核验)。
 */
export async function writeSkillCandidate(
  c: SkillImprovementCandidate,
  ctx: { home?: string; existing?: { name: string; contentHash: string; version: string }[]; now?: IsoTimestamp; runningSnapshotHash?: string | null } = {},
): Promise<string | null> {
  const home = ctx.home ?? bolloonHome();
  const existing = ctx.existing ?? [];
  const assessment = assessCandidate(c, existing);
  if (assessment.junkReasons.length > 0) return null;
  const runningSnapshotHash = ctx.runningSnapshotHash ?? (await skillSnapshotHash(c.name, home));
  const payload = {
    ...c,
    snapshotScope: 'next_run_only' as const,
    appliesToRunningRun: false,
    runningSnapshotHash,
    comparison: assessment.comparison,
    promotable: assessment.promotable,
    boundaryNote: SKILL_CANDIDATE_BOUNDARY_NOTE,
    recordedAt: ctx.now ?? new Date().toISOString(),
  };
  const file = path.join(home, SKILL_CANDIDATES_ROOT, `${safeName(c.candidateId)}.json`);
  const prev = await readJson<Record<string, unknown>>(file);
  if (prev && JSON.stringify(prev) !== JSON.stringify(payload) && prev.runningSnapshotHash === runningSnapshotHash) {
    // 同一候选 id 已有不同内容 → 不覆盖 (候选是事实记录, 不是可变状态)
    return null;
  }
  await atomicWrite(file, JSON.stringify(payload, null, 2));
  return file;
}

export interface CloseGoalRunOutcome {
  result: CloseRunResult;
  /** 这次收尾真正落盘的产物 (可核验: 测试就是看这些文件在不在) */
  written: string[];
  rejected: { memoryId: string; reason: string }[];
  candidatePaths: string[];
  /** 每轮一份的**用户汇报** (P4b 第一份输出) */
  reportPath: string;
  decisionRecordPath: string;
  continuationPatch: Partial<GoalContinuation>;
}

/**
 * Run 收尾 (P1): **成功 / 失败 / 中断恢复的 Run 结尾都走这一条**。
 *
 * 注入真依赖: `writeMemory` = `memory-layers.writeMemoryRecords` (真落盘),
 * `writeCandidate` = `writeSkillCandidate` (过垃圾门, 绝不覆盖运行中的 snapshot),
 * `decide` = `decideContinuation` **外面套 `applyHardLimits`** (只收紧)。
 *
 * 返回的 `continuationPatch` 是"Goal 上唯一的权威 continuation"的飞轮部分;
 * 与运输层合并由 `mergeGoalOutcome` 负责 (单一处收敛)。
 */
export async function closeGoalRun(input: {
  goalId: string;
  runId: string;
  now?: IsoTimestamp;
  finalReview?: string;
  maxRetries?: number;
  home?: string;
}): Promise<CloseGoalRunOutcome | null> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const run = await readRun(input.runId).catch(() => null);
  const goal = await readGoal(input.goalId);
  if (!run || !goal) return null;

  const records = await readDecisionRecords(goal.goalId, home);
  const prevSnapshot = [...records].reverse().find((r) => r.phase === 'closure')?.goalSnapshot ?? null;
  const progress = computeRunProgress(goal, run, prevSnapshot);
  const streak = await deriveNoProgressStreak(goal, run.runId, progress, records, home);
  const hardLimits = hardLimitsFor({ goal, run, maxRetries: input.maxRetries });

  // ★ 进展口径对齐 (接线层的判断, 单一处):
  //   `closeRun` 内部按 `run.evidence` 算"本轮可核验证据", 而真实执行器 (pi-sdk harness / CLI)
  //   通常只记 `steps`; 只认 evidence 的话"有进展就不停"在真实路径里永远不成立 (每个 Run 都会被
  //   判成 ⑪ 没有继续的资格) —— 与飞轮设计 (P0: 节奏由进展决定) 相反。
  //   这里把**成功步骤的事实摘要**并入 Run 的证据面, 与既有 `applyDecision` 的证据同步
  //   (run.steps.filter(ok) → addEvidence) 和 `runEvidenceOf` 同一口径。
  const runForClosure: RunRecord = {
    ...run,
    evidence: uniqNonEmpty([
      ...(run.evidence ?? []),
      ...(run.steps ?? []).filter((s) => s.ok).map((s) => `${run.runId}/${s.tool}: ${String(s.summary || '(完成)').slice(0, 120)}`),
    ]),
  };
  const existingSkills = (goal.skillSnapshot ?? []).map((s) => ({ name: s.name, contentHash: s.contentHash, version: s.version }));
  const candidatePaths: string[] = [];

  const result = await closeRun(
    {
      goalId: goal.goalId,
      runId: run.runId,
      run: runForClosure,
      finalReview: input.finalReview ?? '',
      now,
      goal,
      noProgressStreak: streak,
      hardLimits,
    } satisfies CloseRunInput,
    {
      writeMemory: (batch: MemoryRecord[], at: IsoTimestamp) => writeMemoryRecords(home, batch, at),
      writeCandidate: async (c: SkillImprovementCandidate) => {
        const p = await writeSkillCandidate(c, { home, existing: existingSkills, now, });
        if (p) candidatePaths.push(p);
        return p;
      },
      decide: (decisionInput) => applyHardLimits(decideContinuation(decisionInput), decisionInput.hardLimits),
      // ★ 2026-09-25 (P5 验收修复): 候选的 contentHash 由**这里**注入 (run-closure 不 import 别的阶段
      //   实现, 见它的文件头边界) —— 缺了它, 每份候选都被第二道门以 `unverifiable_result` 拒收。
      contentHashOf: candidateContentHash,
    },
  );

  // 用户汇报落盘 (每 Run 一份, 可回放)
  const reportPath = path.join(home, GOAL_REPORTS_ROOT, `${safeName(goal.goalId)}--${safeName(run.runId)}.json`);
  await atomicWrite(reportPath, JSON.stringify(result.userReport, null, 2));

  // 决策记录落盘 (closure 阶段 = 权威决策)
  const decisionRecordPath = await writeDecisionRecord(
    {
      goalId: goal.goalId,
      runId: run.runId,
      phase: 'closure',
      decision: result.decision,
      runnable: isRunnable(result.decision, now).runnable,
      runnableReason: isRunnable(result.decision, now).reason,
      noProgressStreak: streak,
      hardLimits,
      goalSnapshot: snapshotOf(goal),
      recordedAt: now,
    },
    home,
  );

  const memoryFiles = result.facts.map((f) => path.join(home, '.bolloon', 'memory-layers', 'run_fact', `${safeName(f.memoryId)}.json`));

  return {
    result,
    written: memoryFiles,
    rejected: [],
    candidatePaths,
    reportPath,
    decisionRecordPath,
    continuationPatch: toGoalStoreContinuation(result.continuation),
  };
}

/**
 * `GoalContinuationRecord` (飞轮权威) → `GoalContinuation` (goal-store 落盘形态)。
 *
 * 这是**唯一**的收敛点 (§2 "Goal 上只有一个权威 continuation"): 别处不许再拼一套。
 * 共享调度核心字段直接对齐; 旧字段 (attempts / external / lastRunId / replayGuards …) 不在这里
 * 覆盖 (它们由运输层提供), 由调用方合并。
 */
export function toGoalStoreContinuation(rec: GoalContinuationRecord): Partial<GoalContinuation> {
  return {
    nextAction: rec.nextAction,
    wakeAt: rec.wakeAt ?? undefined,
    wakeReason: wakeReasonFor(rec.state),
    autoContinue: rec.autoContinue,
    updatedAt: rec.updatedAt,
    state: rec.state,
    lastDecisionId: rec.lastDecisionId ?? undefined,
    requiredAgent: rec.requiredAgent ?? undefined,
    unresolvedItems: [...rec.unresolvedItems],
    pendingReports: [...rec.pendingReports],
  };
}

/** GoalLifecycleState → goal-store 的 wakeReason 闭集 (别造新取值: 类型面是字面量联合) */
export function wakeReasonFor(state: GoalLifecycleState): GoalContinuation['wakeReason'] {
  switch (state) {
    case 'active':
      return 'active';
    case 'recovering':
      return 'recovering';
    case 'retry_wait':
      return 'retry_wait';
    case 'awaiting_external':
      return 'awaiting_external';
    case 'stalled':
      return 'stalled';
    case 'paused':
      return 'paused';
    case 'needs_human':
      return 'needs_human';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'active';
  }
}

// ============================================================================
// §6. 飞轮 ⊕ 运输层: 单一处合并 (轮次不再是主停止条件)
// ============================================================================

export interface LegacyGoalDecision {
  goalStatus: GoalStatus;
  continuation: Partial<GoalContinuation>;
  reason: string;
}

export interface MergedGoalOutcome {
  goalStatus: GoalStatus;
  continuation: Partial<GoalContinuation>;
  reason: string;
  /** 飞轮是否**明确要求停** (停就是停: 运输层只能收紧, 不能放开) */
  flywheelStop: boolean;
  /** 飞轮是否覆盖了"轮次用尽"的停止 (记录原因, 便于审计) */
  roundsOverridden: boolean;
}

/**
 * 把飞轮决策与既有运输层 reducer 合并成**一份**落盘 continuation。
 *
 * 规则 (与文件头一致):
 *   ① 飞轮终态 / 熔断 / 暂停 → 照飞轮停 (`flywheelStop=true`, autoContinue=false);
 *   ② 运输层因"轮次用尽"要停, 但**飞轮说还有进展**且不是硬错误 → 继续 (轮次不再是主停止条件);
 *   ③ 其余情况运输层照旧 (退避 / wakeAt / attempts 语义不变), 飞轮提供 nextAction / 决策 id /
 *      未解决项 / 待回报 / state。
 */
export function mergeGoalOutcome(input: {
  legacy: LegacyGoalDecision;
  flywheel: CloseRunResult;
  run: RunRecord | null;
  pendingReports?: PendingReport[];
  /** 覆盖"轮次用尽"时要用它把 wakeAt 置成"现在" (空着 = 只能靠事件唤醒, 那等于没覆盖) */
  now?: IsoTimestamp;
}): MergedGoalOutcome {
  const { legacy, flywheel, run } = input;
  const fy = flywheel.decision;
  const rec = flywheel.continuation;
  const base: Partial<GoalContinuation> = { ...legacy.continuation };
  const hardError = HARD_STOP_ERROR_CLASSES.includes(String(run?.errorClass || ''));
  const flywheelFields = toGoalStoreContinuation({ ...rec, pendingReports: input.pendingReports ?? rec.pendingReports });

  let goalStatus: GoalStatus = legacy.goalStatus;
  let reason = legacy.reason;
  let flywheelStop = false;
  let roundsOverridden = false;

  if (fy.decision === 'fail') {
    goalStatus = 'failed';
    flywheelStop = true;
    reason = `飞轮判不可达: ${fy.reason}`;
  } else if (fy.decision === 'complete') {
    goalStatus = 'completed';
    reason = `飞轮判完成 (仍要过 goal-store 完成门): ${fy.reason}`;
  } else if (fy.decision === 'pause') {
    goalStatus = 'paused';
    flywheelStop = true;
    reason = `飞轮: 人主动暂停 (不自动唤醒): ${fy.reason}`;
  } else if (fy.decision === 'ask_human' && (fy.state === 'no_progress' || fy.state === 'blocked')) {
    goalStatus = 'needs_human';
    flywheelStop = true;
    reason = `飞轮收紧 (${fy.state}): ${fy.reason}`;
  } else if (
    (fy.decision === 'continue' || fy.decision === 'delegate' || fy.decision === 'wait')
    && legacy.goalStatus === 'needs_human'
    && !hardError
  ) {
    // ② 轮次用尽 ≠ 该停: 只要本轮有可核验进展, 继续
    goalStatus = run && run.status === 'failed' ? 'retry_wait' : 'active';
    roundsOverridden = true;
    reason = `飞轮覆盖轮次上限 (本轮有进展, 不是硬错误): ${fy.reason}`;
  }

  const continuation: Partial<GoalContinuation> = flywheelStop
    ? {
      ...base,
      ...flywheelFields,
      autoContinue: false,
      wakeAt: undefined,
      wakeReason: goalStatus === 'completed' ? 'completed' : goalStatus === 'failed' ? 'failed' : goalStatus === 'paused' ? 'paused' : 'needs_human',
    }
    : {
      ...base,
      ...flywheelFields,
      // 运输层是"何时再唤醒"的权威; 飞轮只是补上"下一步是什么"(没有既定时才用它)
      autoContinue: base.autoContinue !== false,
      wakeAt: base.wakeAt ?? flywheelFields.wakeAt,
      wakeReason: base.wakeReason ?? flywheelFields.wakeReason,
      state: lifecycleOf(goalStatus),
    };
  // ② 的落盘面: 覆盖了"轮次用尽"就必须把运输层的**停**一并撤掉 ——
  //   否则 legacy 那边写下的 `autoContinue:false` 仍会把 Goal 锁在"等人"里 (等于没覆盖)。
  //   `wakeAt = now`: 退避已用尽, 立刻可跑; 且 `isRunnable('wait')` 对"没有 wakeAt"是
  //   **拒绝**的 (只能靠事件唤醒) —— 不写就会在下一 tick 被自己的前置判定拦住 (前后不自洽)。
  if (roundsOverridden) {
    continuation.autoContinue = true;
    continuation.wakeAt = input.now ?? base.wakeAt;
    continuation.wakeReason = goalStatus === 'retry_wait' ? 'retry_wait' : 'active';
  }
  continuation.state = lifecycleOf(goalStatus);

  return { goalStatus, continuation, reason, flywheelStop, roundsOverridden };
}

// ============================================================================
// §7. P2 子 Agent 工作合同 (派遣必发合同 / 回报必核验)
// ============================================================================

export function workDirFor(goalId: string, home = bolloonHome()): string {
  return path.join(home, GOAL_WORKS_ROOT, safeName(goalId));
}

export function contractPathFor(goalId: string, workId: string, home = bolloonHome()): string {
  return path.join(workDirFor(goalId, home), `${safeName(workId)}.json`);
}

export function reportPathFor(goalId: string, workId: string, home = bolloonHome()): string {
  return path.join(workDirFor(goalId, home), `${safeName(workId)}.report.json`);
}

export function heartbeatPathFor(goalId: string, workId: string, home = bolloonHome()): string {
  return path.join(workDirFor(goalId, home), `${safeName(workId)}.hb.json`);
}

/**
 * 派遣一个子 Agent 工作: **必发合同** (`issueWorkContract`), 并把"还没回报"这件事写进
 * Goal 的权威 continuation (`pendingReports`), 而不是只发一句话。
 *
 * 合同不合法 → `issueWorkContract` 抛 `WorkContractError` (不做"差不多就行")。
 */
export async function dispatchChildWork(input: {
  goalId: string;
  parentRunId: string;
  childAgentId: string;
  capability: string;
  objective: string;
  inputs?: Record<string, unknown>;
  allowedTools?: string[];
  budget: WorkBudget;
  deadline?: IsoTimestamp | null;
  successCriteria: string[];
  now?: IsoTimestamp;
  issuedBy?: string;
  home?: string;
}): Promise<AgentWorkContract> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const contract = issueWorkContract({
    goalId: input.goalId,
    parentRunId: input.parentRunId,
    childAgentId: input.childAgentId,
    capability: input.capability,
    objective: input.objective,
    inputs: input.inputs ?? {},
    allowedTools: input.allowedTools ?? [],
    budget: input.budget,
    deadline: input.deadline ?? null,
    successCriteria: input.successCriteria,
    now,
    issuedBy: input.issuedBy ?? 'supervisor',
  });
  await atomicWrite(contractPathFor(contract.goalId, contract.workId, home), JSON.stringify(contract, null, 2));

  const goal = await readGoal(input.goalId);
  if (goal) {
    const pending: PendingReport[] = [
      ...(goal.continuation?.pendingReports ?? []).filter((p) => p.workId !== contract.workId),
      {
        workId: contract.workId,
        childAgentId: contract.childAgentId,
        capability: contract.capability,
        requestedAt: now,
        deadlineAt: contract.deadline,
        lastHeartbeatAt: null,
      },
    ];
    await setContinuation(input.goalId, { pendingReports: pending, wakeReason: 'active', state: lifecycleOf(goal.status), updatedAt: now });
  }
  return contract;
}

/** 收下子 Agent 回报 (谁收到谁调): 核验 + 是否接受为完成; **不接受就不算完成** */
export async function handleChildReport(input: {
  goalId: string;
  workId: string;
  report: AgentWorkReport;
  now?: IsoTimestamp;
  home?: string;
}): Promise<{ outcome: 'accepted' | 'incomplete' | 'no_contract'; accepted: boolean; reason: string; missingFields: string[]; missingEvidence: string[]; violation: string | null }> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const contract = await readJson<AgentWorkContract>(contractPathFor(input.goalId, input.workId, home));
  if (!contract) {
    return { outcome: 'no_contract', accepted: false, reason: `没有找到合同 ${input.workId} → 没有合同的回报不核验也不接受`, missingFields: [], missingEvidence: [], violation: null };
  }
  const validation = validateChildReport(contract, input.report);
  const verdict = acceptsAsComplete(contract, input.report);
  await atomicWrite(reportPathFor(input.goalId, input.workId, home), JSON.stringify({ report: input.report, validation, verdict, recordedAt: now }, null, 2));

  if (!verdict.accepted) {
    // 不接受为完成 → pendingReports 保持 (下一步还是"等/要"这个回报), 绝不当完成记账
    const goal = await readGoal(input.goalId);
    if (goal) {
      const pending = (goal.continuation?.pendingReports ?? []).filter((p) => p.workId !== input.workId);
      pending.push({
        workId: contract.workId,
        childAgentId: contract.childAgentId,
        capability: contract.capability,
        requestedAt: goal.continuation?.pendingReports?.find((p) => p.workId === input.workId)?.requestedAt ?? now,
        deadlineAt: contract.deadline,
        lastHeartbeatAt: input.report.reportedAt ?? null,
      });
      await setContinuation(input.goalId, { pendingReports: pending, updatedAt: now });
    }
    return {
      outcome: 'incomplete',
      accepted: false,
      reason: verdict.reason,
      missingFields: validation.missingFields,
      missingEvidence: validation.missingEvidence,
      violation: validation.violation,
    };
  }

  const goal = await readGoal(input.goalId);
  if (goal) {
    await addEvidence(input.goalId, input.report.evidence.slice(0, 5).map((e) => `${contract.workId}: ${e.ref} (${e.note || e.kind})`)).catch(() => null);
    await setContinuation(input.goalId, {
      pendingReports: (goal.continuation?.pendingReports ?? []).filter((p) => p.workId !== input.workId),
      updatedAt: now,
    });
  }
  return { outcome: 'accepted', accepted: true, reason: verdict.reason, missingFields: [], missingEvidence: [], violation: null };
}

// ============================================================================
// §8. P3 阻塞监控 (Watchdog 只看进程存活 ≠ 看任务是否卡住)
// ============================================================================

export async function recordWorkHeartbeat(goalId: string, workId: string, at?: IsoTimestamp, home = bolloonHome()): Promise<void> {
  const at2 = at ?? new Date().toISOString();
  await atomicWrite(heartbeatPathFor(goalId, workId, home), JSON.stringify({ workId, at: at2 }, null, 2));
}

/**
 * 读盘上的待回报工作 → `detectBlocks`。**只诊断**: 接管 / 上报这些副作用由 `applyBlockHandling` 做。
 */
export async function collectWorkBlocks(input: {
  goalId: string;
  now?: IsoTimestamp;
  runnerAvailable?: boolean;
  home?: string;
}): Promise<BlockRecord[]> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const goal = await readGoal(input.goalId);
  if (!goal) return [];
  const pending = goal.continuation?.pendingReports ?? [];
  if (pending.length === 0) return [];
  const lease = goal.lease;
  const leaseOwner = lease && Date.parse(String(lease.leaseUntil || '')) > Date.parse(now) ? lease.owner : null;

  const out: BlockRecord[] = [];
  for (const p of pending) {
    const contract = await readJson<AgentWorkContract>(contractPathFor(input.goalId, p.workId, home));
    if (!contract) continue;
    const hb = await readJson<{ at?: string }>(heartbeatPathFor(input.goalId, p.workId, home));
    const reportFile = await readJson<{ report?: AgentWorkReport }>(reportPathFor(input.goalId, p.workId, home));
    const report = reportFile?.report ?? null;
    const blocks = detectBlocks({
      contract,
      report,
      lastHeartbeatAt: hb?.at ?? p.lastHeartbeatAt ?? null,
      lastProgressAt: p.requestedAt ?? contract.issuedAt,
      now,
      leaseOwner,
      runnerAvailable: input.runnerAvailable !== false,
    });
    // 有回报但**核验不过** → 这份回报不能被当成"已回报" (报告不完整 → 要求补齐)
    if (report) {
      const validation = validateChildReport(contract, report);
      if (!validation.ok) {
        const already = blocks.some((b) => b.kind === 'report_missing');
        if (!already) {
          blocks.push({
            blockId: `blk:${contract.workId}:report_missing`,
            kind: 'report_missing',
            goalId: contract.goalId,
            runId: contract.parentRunId,
            workId: contract.workId,
            childAgentId: contract.childAgentId,
            blockedAt: report.reportedAt ?? now,
            lastProgressAt: report.reportedAt ?? now,
            owner: 'child',
            dependency: `report:${contract.reportSchema}`,
            suggestedAction: 'request_report',
            escalationAt: null,
            resolvedAt: null,
            resolution: null,
            note: `报告核验不过 (${[...validation.missingFields, ...validation.missingEvidence].join('; ')}${validation.violation ? `; 越界=${validation.violation}` : ''}) → 不接受为完成, 要求补充`,
          });
        }
      }
    }
    out.push(...blocks);
  }
  return out;
}

export interface BlockHandlingOutcome {
  actions: { workId: string; kind: string; action: BlockResolutionAction; note: string }[];
  /** 因阻塞升级到人类的 Goal */
  escalated: string[];
  /** 父可接管的工作 (执行权空闲且合同允许) */
  takeovers: string[];
  /** 需要"要求补齐/发调整指令"的工作 */
  requests: string[];
}

/**
 * 按 `planBlockHandling` 处理阻塞 (副作用: 升级 = Goal → needs_human; 接管 = 记事实 + 清待回报)。
 * 工具/权限/预算被阻**永不**自动绕过 Harness (`planBlockHandling` 本身就不会给出 takeover)。
 */
export async function applyBlockHandling(input: {
  goalId: string;
  blocks: BlockRecord[];
  now?: IsoTimestamp;
  home?: string;
}): Promise<BlockHandlingOutcome> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const out: BlockHandlingOutcome = { actions: [], escalated: [], takeovers: [], requests: [] };
  const escalatedBlocks: string[] = [];
  for (const b of input.blocks.filter((x) => x.resolvedAt === null)) {
    const action = planBlockHandling(b);
    out.actions.push({ workId: b.workId ?? '-', kind: b.kind, action, note: b.note });
    if (action === 'needs_human' || action === 'escalate_parent' || action === 'change_plan') {
      escalatedBlocks.push(`${b.kind}(${b.workId ?? '-'}): ${b.note}`);
      if (action === 'needs_human') out.escalated.push(b.workId ?? '-');
    } else if (action === 'takeover') {
      out.takeovers.push(b.workId ?? '-');
    } else {
      out.requests.push(`${b.kind}(${b.workId ?? '-'}) → ${action}`);
    }
  }
  if (escalatedBlocks.length > 0) {
    const goal = await readGoal(input.goalId);
    if (goal && !['completed', 'failed', 'abandoned'].includes(goal.status)) {
      await setContinuation(input.goalId, {
        state: 'needs_human',
        autoContinue: false,
        wakeReason: 'needs_human',
        needsExternal: escalatedBlocks.join(' | ').slice(0, 300),
        unresolvedItems: uniqNonEmpty([...(goal.continuation?.unresolvedItems ?? []), ...escalatedBlocks.map((s) => s.slice(0, 200))]),
        updatedAt: now,
      });
      await updateGoal(input.goalId, { status: 'needs_human', unresolvedItems: goal.unresolvedItems.slice(0, 30) });
    }
  }
  if (out.takeovers.length > 0) {
    const goal = await readGoal(input.goalId);
    if (goal) {
      const taken = new Set(out.takeovers);
      await setContinuation(input.goalId, {
        pendingReports: (goal.continuation?.pendingReports ?? []).filter((p) => !taken.has(p.workId)),
        updatedAt: now,
      });
      await addEvidence(input.goalId, out.takeovers.map((w) => `父接管: ${w} (子无心跳且执行权空闲, 合同允许 takeover)`)).catch(() => null);
    }
  }
  void home;
  return out;
}

/**
 * 还没回报的子 Agent 工作的合同摘要 (写进下一个 Run 的指令 —— 规则 5 要求子拿到同一份合同)。
 * 没有合同时返回 null (不编)。
 */
export async function pendingContractDigest(goalId: string, home = bolloonHome()): Promise<string | null> {
  const goal = await readGoal(goalId);
  const pending = goal?.continuation?.pendingReports ?? [];
  if (pending.length === 0) return null;
  const lines: string[] = [];
  for (const p of pending) {
    const c = await readJson<AgentWorkContract>(contractPathFor(goalId, p.workId, home));
    if (!c) {
      lines.push(`- workId=${p.workId} 能力「${p.capability}」: 合同文件缺失 (不许凭记忆派活, 必须重新签发合同)`);
      continue;
    }
    lines.push(
      `- workId=${c.workId} 能力「${c.capability}」报告协议=${c.reportSchema} 必带证据=[${c.requiredEvidence.join(', ')}] `
      + `成功判据=[${c.successCriteria.join(' | ')}] 心跳=${c.heartbeatIntervalMs}ms`,
    );
  }
  return `还在等回报的子 Agent 工作 (回报必须过 ${WORK_REPORT_SCHEMA_LIKE} 核验, 漂亮但没有逐条证据的回报不算完成):\n${lines.join('\n')}`;
}

const WORK_REPORT_SCHEMA_LIKE = 'validateChildReport/acceptsAsComplete';

/** 用户可见状态 (六类里的一类): 内部词 (lease / reducer / retry attempt / owner) 绝不出现 */
export async function goalVisibleState(input: {
  goalId: string;
  blocks?: BlockRecord[];
  decision?: ContinuationDecision | null;
  now?: IsoTimestamp;
  home?: string;
}): Promise<UserVisibleState> {
  const goal = await readGoal(input.goalId);
  if (!goal) return 'needs_your_decision';
  const blocks = input.blocks ?? (await collectWorkBlocks({ goalId: input.goalId, now: input.now, home: input.home }));
  const decision = input.decision ?? null;
  return toUserVisibleState(goal.continuation ? { ...goal.continuation } as GoalContinuationRecord : null, blocks, decision);
}

// ============================================================================
// §9. P4 新要求注入 (原话逐字入档 + 版本 + 只影响下一 Run)
// ============================================================================

export interface GoalChangeIngestOutcome {
  request: GoalChangeRequest;
  application: ChangeApplication;
  /** 是否真的改了判据版本 (规则 3: 只有"用户 + 改判据"才 +1) */
  criteriaVersionBumpedTo: number | null;
  persistedPath: string;
  /** 下一 Run 的指令 (写进 continuation.nextAction, 下一个 Run 真的会读到) */
  nextRunDirective: string | null;
}

/**
 * 接收一条用户(或 agent 提出的)新要求:
 *   `ingestChange` (逐字) → `classifyChange` (8 类分诊) → `applyChange` (生效判定) →
 *   落盘 + 写进 Goal (变更记录 / 判据版本 / 下一 Run 指令)。
 *
 * **当前 Run 的历史不改写** (规则 4): 本函数只写 Goal 上的变更记录与"下一次 Run"的指令,
 * 不碰任何已发生 Run 的记录 (`job change` 里没有任何回填路径)。
 */
export async function ingestGoalChange(input: {
  goalId: string;
  instruction: string;
  source?: ChangeSource;
  recordedBy?: string;
  now?: IsoTimestamp;
  scopeWorkIds?: string[];
  home?: string;
}): Promise<GoalChangeIngestOutcome | null> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const goal = await readGoal(input.goalId);
  if (!goal) return null;
  const source: ChangeSource = input.source ?? 'user';
  const requestRaw = ingestChange({
    goalId: goal.goalId,
    source,
    instruction: input.instruction,
    recordedBy: input.recordedBy ?? 'user',
    now,
  });
  const classified = classifyChange(requestRaw, { successCriteria: goal.successCriteria, budget: goal.budget });
  const application = applyChange(classified, { criteriaVersion: goal.criteriaVersion ?? 1 });
  const status = nextStatusFor(application.outcome);

  // 用户撤销 → 之前未生效的变更一律作废 (规则 1 的推论)
  const changes: GoalChangeRequest[] = (goal.goalChanges ?? []).map((c) => {
    if (shouldSupersedePending(classified) && (c.status === 'needs_approval' || c.status === 'triaged')) {
      return { ...c, status: 'superseded' as const };
    }
    return c;
  });
  changes.push({ ...classified, status });

  const patch: Partial<GoalRecord> = { goalChanges: changes };
  let bumped: number | null = null;
  if (application.outcome === 'next_run' && classified.kind === 'success_criteria_change' && application.criteriaVersion !== (goal.criteriaVersion ?? 1)) {
    patch.criteriaVersion = application.criteriaVersion;
    bumped = application.criteriaVersion;
  }
  if (application.outcome === 'next_run' && classified.kind === 'abort') {
    patch.status = 'abandoned';
    patch.resolution = { reason: `用户明确撤销 (${classified.changeId}): ${classified.instruction.slice(0, 120)}`, at: now };
  }
  await updateGoal(goal.goalId, patch);

  const nextRunDirective = application.outcome === 'rejected' ? null : application.nextRunDirective;
  if (nextRunDirective) {
    await setContinuation(goal.goalId, {
      nextAction: nextRunDirective,
      wakeReason: 'active',
      autoContinue: patch.status === 'abandoned' ? false : goal.continuation?.autoContinue !== false,
      state: lifecycleOf(patch.status ?? goal.status),
      updatedAt: now,
    });
  }

  const persistedPath = path.join(home, '.bolloon', 'goal-changes', `${safeName(goal.goalId)}.json`);
  await atomicWrite(persistedPath, JSON.stringify({ goalId: goal.goalId, changes, updatedAt: now }, null, 2));

  return { request: classified, application, criteriaVersionBumpedTo: bumped, persistedPath, nextRunDirective };
}

/**
 * 下一个 Run 要读到的动态要求: 已生效但还没被任何 Run 消费的变更 → 拼成指令。
 * (父/子 Agent 与下一 Run 都从这里读同一份事实。)
 */
export async function nextRunChangeDirective(goalId: string): Promise<string | null> {
  const goal = await readGoal(goalId);
  if (!goal) return null;
  const applied = (goal.goalChanges ?? []).filter((c) => c.status === 'scheduled_next_run' || c.status === 'applied');
  if (applied.length === 0) return null;
  const tail = (goal.runs ?? []).length;
  const live = applied.filter((c) => (c as GoalChangeRequest & { consumedAtRunCount?: number }).consumedAtRunCount === undefined
    || (c as GoalChangeRequest & { consumedAtRunCount?: number }).consumedAtRunCount === tail);
  if (live.length === 0) return null;
  const lines = live.map((c) => `- [${c.kind}] 原话: ${c.instruction}`);
  return `用户/外部注入的新要求 (只影响后续 Run, 不改写已发生历史; criteriaVersion=v${goal.criteriaVersion ?? 1}):\n${lines.join('\n')}`;
}

/** 标记"这批变更已经被第 N 个 Run 读到" (版本下发可核验) */
export async function markChangesConsumed(goalId: string, runCount: number, now: IsoTimestamp = new Date().toISOString()): Promise<void> {
  const goal = await readGoal(goalId);
  if (!goal) return;
  const changes = (goal.goalChanges ?? []).map((c) => (
    c.status === 'scheduled_next_run'
      ? ({ ...c, status: 'applied' as const, consumedAtRunCount: runCount, consumedAt: now } as GoalChangeRequest)
      : c
  ));
  await updateGoal(goalId, { goalChanges: changes });
}

// ============================================================================
// §10. 给 CLI / Web 的一行视图 (复用同一份 toUserVisibleState)
// ============================================================================

/** 一次 tick 里给某个 Goal 的飞轮摘要 (调度报告用) */
export interface FlywheelTickNote {
  goalId: string;
  decision: string;
  state: string;
  runnable: boolean;
  reason: string;
  noProgressStreak: number;
  visibleState: UserVisibleState;
  nextAction: string;
}

export async function flywheelTickNote(input: {
  goalId: string;
  step: GoalStepDecision;
  now?: IsoTimestamp;
  home?: string;
}): Promise<FlywheelTickNote> {
  const blocks = await collectWorkBlocks({ goalId: input.goalId, now: input.now, home: input.home });
  const goal = await readGoal(input.goalId);
  const visible = toUserVisibleState(
    goal?.continuation ? ({ ...goal.continuation } as GoalContinuationRecord) : null,
    blocks,
    input.step.decision,
  );
  return {
    goalId: input.goalId,
    decision: input.step.decision?.decision ?? 'first_run',
    state: input.step.decision?.state ?? 'progressing',
    runnable: input.step.runnable,
    reason: input.step.reason,
    noProgressStreak: input.step.noProgressStreak,
    visibleState: visible,
    nextAction: input.step.decision?.nextAction ?? '(首个 Run)',
  };
}

/** 扫出"有待回报子工作"的 Goal (阻塞巡检的输入面, 有界) */
export async function listGoalsWithPendingWork(limit = 20): Promise<GoalRecord[]> {
  const goals = await listGoals({ limit: 200 });
  return goals.filter((g) => (g.continuation?.pendingReports?.length ?? 0) > 0).slice(0, limit);
}
