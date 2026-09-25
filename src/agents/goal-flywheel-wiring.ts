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
// 2026-09-25 (M0 接线冻结, 规则 ②): Goal 状态只有一个写入出口
import { reduceGoalState } from './goal-state-reducer.js';

// 接缝的拒绝类型与判别器一并从这里转发 (调用方不必再 import 接缝目录)
export { isRefusal } from './goal-flywheel/wiring/index.js';
export type {
  SeamRefusal,
  WiringCaller,
  SeamId,
  WiringStage,
  // ★ 2026-09-25 (串行收口): 其余新成员也一并转发 —— 宿主 (Supervisor/CLI/Web) 要用的类型
  //   不必再深入接缝目录自己 import (M3 报的"wiring/index 补导"同类问题在这一层也补上)
  MonitorTickView,
  MonitoredGoal,
  BlockHandlingView,
  VisibleStateView,
  ContractSeam,
  ChildDispatchPort,
  DispatchReceipt,
  DispatchOutcome,
  ClosureTerminalKind,
  ClosureReceipt,
  RhythmFacts,
  RhythmBasis,
  SafetyCap,
  ContinuationPreflight,
  TrialOpeningView,
} from './goal-flywheel/wiring/index.js';
import { addRunEvidence, readRun, setRunStatus, type RunRecord } from './run-store.js';
import { applyHardLimits, decideContinuation, isRunnable } from './goal-flywheel/continuation-decision.js';
import { closeRun, CLOSURE_STEP_ORDER, type CloseRunInput, type CloseRunResult } from './goal-flywheel/run-closure.js';
import { writeMemoryRecords } from './goal-flywheel/memory-layers.js';
import {
  assessCandidate,
  openSkillTrial,
  settleSkillTrial,
  type SkillChannelAdmission,
  type SkillTrialRecord,
  type SkillTrialSettlement,
} from './goal-flywheel/skill-candidate.js';
import { acceptsAsComplete, issueWorkContract, stableHash, validateChildReport } from './goal-flywheel/work-contract.js';
import { detectBlocks, planBlockHandling, toUserVisibleState } from './goal-flywheel/work-monitor.js';
import { applyChange, classifyChange, ingestChange, isRunInFlight, nextStatusFor, shouldSupersedePending } from './goal-flywheel/goal-change.js';
import type { ChangeApplication } from './goal-flywheel/goal-change.js';
// 2026-09-25 (M0 接线冻结): 唯一责任链的五个接缝 (各阶段独占一个文件; 依赖在这里注入)
import {
  createChangeSeam,
  createClosureSeam,
  createContinuationSeam,
  createContractSeam,
  createMonitorSeam,
  bindingCaps,
  closureTerminalKindFor,
  isRefusal,
  type ChangeSeam,
  type ChangeIngestView,
  type ClosureOutcomeView,
  type ClosureSeam,
  type CloseRunOnceResult,
  type ClosureTerminalKind,
  type ContractSeam,
  type ContinuationSeam,
  type MonitorSeam,
  type MonitorTickView,
  type RhythmBasis,
  type RhythmFacts,
  type SafetyCap,
  type TrialOpeningView,
  type SeamRefusal,
  type WiringCaller,
} from './goal-flywheel/wiring/index.js';
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
  UserReport,
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
  /**
   * closure 阶段额外落盘的**收尾产物本体** (2026-09-25, 收尾幂等):
   * 「这条 Run 已经收过尾」的第二次调用要把同一份事实**读回来**, 而不是重跑一遍或编一份。
   * 因此收尾记录必须自带 continuation 与用户汇报 —— 只存决策的话, 第二次调用只能拿到半个事实。
   */
  continuation?: GoalContinuationRecord;
  userReport?: UserReport;
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

// ============================================================================
// §4.1 主循环走**规范节奏路径** (M1 接缝的 `readFacts` 钩子 + 回放记录)
// ============================================================================

/**
 * `readFacts` 的读盘留痕 —— "主循环这一 tick 真的读了事实"要有**可核验的证据**,
 * 而不是靠读代码相信接线接上了。
 *
 * 它记录的是**事实读**这件事本身 (谁/何时/读到哪条 Run), 不是判定结论 (结论在决策记录里)。
 */
export interface FactsReadNote {
  goalId: string;
  now: IsoTimestamp;
  /** 这次事实读用的那条 Run (首个 Run 之前为 null) */
  runId: string | null;
  factsFound: boolean;
  /** 读盘失败时的原文 (成功为 null) —— 不许静默把"读不到"当成"没有事实" */
  error: string | null;
  at: IsoTimestamp;
}

/** 留痕上限 (有界: 长跑进程不许攒一条无限长的数组) */
export const FACTS_READ_NOTE_MAX = 50;
let factsReadLog: FactsReadNote[] = [];

/** 事实读留痕 (最近 FACTS_READ_NOTE_MAX 条, 最旧的在最前) */
export function factsReadNotes(): readonly FactsReadNote[] {
  return factsReadLog;
}

/** 测试用: 清空留痕 (不影响接缝实例) */
export function resetFactsReadNotesForTest(): void {
  factsReadLog = [];
}

function noteFactsRead(n: Omit<FactsReadNote, 'at'>): void {
  factsReadLog.push({ ...n, at: new Date().toISOString() });
  while (factsReadLog.length > FACTS_READ_NOTE_MAX) factsReadLog.shift();
}

/**
 * `readFacts({goalId, now})` 的**真实现** —— 只读事实, 不判定 (`readRhythmFacts` 的名字在说这件事)。
 *
 * 读的是: Goal (权威 continuation / 判据 / 跑过几条 Run) + 最近一条 Run (证据 / 步骤) +
 * 历史决策记录 (算进展增量与无进展连击)。判定交给 M1 接缝 (它用 P0 自己编), 本函数**不**碰决策。
 *
 * 返回 null 的两种情形**都如实留痕**, 且语义不同:
 *   · `factsFound=false` + `error=null` = 还没有 Run 事实 (首个 Run 之前: 没有"上一轮"可读);
 *   · `error!=null` = 读盘失败 (拿不到事实 ≠ 没有事实)。
 * 两种情形下接缝都会走注入兜底 (结果为 `source='injected'`, 不假装是事实判的)。
 */
export async function readRhythmFacts(input: {
  goalId: string;
  now: IsoTimestamp;
  home?: string;
}): Promise<RhythmFacts | null> {
  const home = input.home ?? bolloonHome();
  try {
    const goal = await readGoal(input.goalId);
    if (!goal) {
      noteFactsRead({ goalId: input.goalId, now: input.now, runId: null, factsFound: false, error: `goal 不存在: ${input.goalId}` });
      return null;
    }
    const lastRunId = goal.currentRunId || goal.runs?.[goal.runs.length - 1];
    const run = lastRunId ? await readRun(lastRunId).catch(() => null) : null;
    if (!run) {
      noteFactsRead({ goalId: goal.goalId, now: input.now, runId: null, factsFound: false, error: null });
      return null; // 首个 Run 之前没有"上一轮"事实 —— 不编一条空 Run 出来
    }
    const records = await readDecisionRecords(goal.goalId, home);
    const prevSnapshot = [...records].reverse().find((r) => r.phase === 'closure')?.goalSnapshot ?? null;
    const progress = computeRunProgress(goal, run, prevSnapshot);
    const noProgressStreak = await deriveNoProgressStreak(goal, run.runId, progress, records, home);
    noteFactsRead({ goalId: goal.goalId, now: input.now, runId: run.runId, factsFound: true, error: null });
    return { goal, run, now: input.now, progress, noProgressStreak };
  } catch (e) {
    noteFactsRead({ goalId: input.goalId, now: input.now, runId: null, factsFound: false, error: String((e as Error)?.message || e) });
    return null;
  }
}

/** 主循环拿到的节奏判定: `GoalStepDecision` + **这一步走的是哪条路** (可核验, 不靠读代码) */
export interface SupervisorStepDecision extends GoalStepDecision {
  /** `facts` = 走 M1 接缝的规范路径 (事实→P0); `injected` = 事实拿不到, 退回旧注入口径 */
  source: 'facts' | 'injected';
  /** 主节奏依据 (注入路径为 null: 那条路没有节奏归因, 如实留白) */
  basis: RhythmBasis | null;
  /** 这一步在说话的安全上限 (注入路径为空: 缺事实就核验不了) */
  caps: SafetyCap[];
  bindingCap: SafetyCap | null;
}

/**
 * Supervisor **唯一**的节奏判定入口: 走 M1 接缝 (`flywheelSeams().continuation.preflight`)。
 *
 * 为什么还要经过接缝而不是直接 `decideGoalStep`: 接缝是**规范口径** (`readFacts` → P0 → 归因),
 * 而 `decideGoalStep` 是"接线层自己再判一遍"的旧路。主循环走接缝 = 全仓只有一套节奏判定。
 *
 * 上限 (`limits`) 为什么由这里先算一次: M1 刻意**不许事实读夹带上限** (`RhythmFacts` 里没有
 * `hardLimits`) —— 上限是宿主配置 (goal.budget / run.deadlineMs / `BOLLOON_GOAL_MAX_RUNS`),
 * 必须由调用方经 `safetyCapsFrom()` 注入。所以这里先读一次 Goal/Run 算上限, 事实读本身由接缝
 * 通过 `readRhythmFacts` 再做 (两次读都在同一次判定里, 且**上限只可能来自宿主配置**, 不会被
 * 事实读改写)。
 *
 * 回放记录 (`writeRecord`): 接缝不写记录 (它不碰盘), 所以 preflight 记录由**这里**落盘 ——
 * 与 `decideGoalStep` 写的是同一份形状 (事实 → 结论), 保证 `.bolloon/goal-decisions/` 的记录流不断。
 */
export async function preflightGoalStep(input: {
  goalId: string;
  now: IsoTimestamp;
  maxRetries?: number;
  maxRounds?: number;
  maxRunDurationMs?: number;
  writeRecord?: boolean;
  home?: string;
}): Promise<SupervisorStepDecision | SeamRefusal | null> {
  const home = input.home ?? bolloonHome();
  const goal = await readGoal(input.goalId);
  if (!goal) return null;
  const lastRunId = goal.currentRunId || goal.runs?.[goal.runs.length - 1];
  const run = lastRunId ? await readRun(lastRunId).catch(() => null) : null;
  const hardLimits = hardLimitsFor({ goal, run, maxRetries: input.maxRetries });

  const pre = await flywheelSeams().continuation.preflight({
    goalId: input.goalId,
    caller: 'supervisor',
    now: input.now,
    maxRetries: input.maxRetries,
    maxRounds: input.maxRounds,
    maxRunDurationMs: input.maxRunDurationMs,
    limits: hardLimits,
    writeRecord: false, // 记录由本函数按**同一份事实**落盘 (见下), 不让接缝去写
  });

  if (pre && !isRefusal(pre) && pre.source === 'facts' && pre.facts) {
    const facts = pre.facts;
    const step: SupervisorStepDecision = {
      goalId: facts.goal.goalId,
      run: facts.run,
      decision: pre.fullDecision,
      runnable: pre.runnable,
      reason: pre.reason,
      noProgressStreak: pre.noProgressStreak,
      progress: facts.progress,
      hardLimits: pre.capsInEffect,
      source: 'facts',
      basis: pre.basis,
      caps: pre.caps,
      bindingCap: pre.bindingCap,
    };
    if (input.writeRecord) {
      await writeDecisionRecord(
        {
          goalId: step.goalId,
          runId: facts.run.runId,
          phase: 'preflight',
          decision: step.decision as ContinuationDecision,
          runnable: step.runnable,
          runnableReason: step.reason,
          noProgressStreak: step.noProgressStreak,
          hardLimits: step.hardLimits,
          goalSnapshot: snapshotOf(goal),
          recordedAt: input.now,
        },
        home,
      ).catch(() => null);
    }
    return step;
  }

  // 事实拿不到 (还没有 Run 事实 / 读盘失败) 或接缝真拒 → 退回旧口径, 并**如实标 source='injected'**
  const legacy = await decideGoalStep({
    goalId: input.goalId,
    now: input.now,
    maxRetries: input.maxRetries,
    home,
    writeRecord: input.writeRecord,
  });
  if (!legacy) {
    // 连旧口径都拿不到目标 → 接缝的拒绝原样上报 (有拒绝就是有拒绝), 否则如实返回 null
    return pre && isRefusal(pre) ? pre : null;
  }
  return { ...legacy, source: 'injected', basis: null, caps: [], bindingCap: null };
}

/**
 * 反事实归因: **这一步在说话的是哪条安全上限** (M1 `bindingCaps` 的真调用方, 2026-09-25 串行收口)。
 *
 * 判据是反事实, 不是把上限数字比一遍 (手算就是第二套事实): 把某条上限**连它的事实层来源**放宽 →
 * 结论投影变了 ⟹ 是它在说话; 结论没变 ⟹ 这次停跟它无关。见 `continuation.ts` 的 `bindingCaps`。
 *
 * 事实不足时如实说: 还没有 Run 事实 (首个 Run 之前 / 读盘失败) → `factsFound=false` + `bindingCap=null`
 * + `reason` 说清,**不猜**一条"最像的"上限出来。
 *
 * 上限来源与 `preflightGoalStep` 同一份推导 (`hardLimitsFor`: Goal 自报的 `budget` 优先于 env/默认)。
 */
export async function explainBindingCap(input: {
  goalId: string;
  now?: IsoTimestamp;
  maxRetries?: number;
  home?: string;
}): Promise<{
  goalId: string;
  now: IsoTimestamp;
  factsFound: boolean;
  caps: SafetyCap[];
  bindingCap: SafetyCap | null;
  reason: string;
}> {
  const home = input.home ?? bolloonHome();
  const now = input.now ?? new Date().toISOString();
  const goal = await readGoal(input.goalId);
  if (!goal) {
    return { goalId: input.goalId, now, factsFound: false, caps: [], bindingCap: null, reason: `goal 不存在: ${input.goalId} → 没有事实就没有上限归因` };
  }
  const lastRunId = goal.currentRunId || goal.runs?.[goal.runs.length - 1];
  const run = lastRunId ? await readRun(lastRunId).catch(() => null) : null;
  const facts = await readRhythmFacts({ goalId: input.goalId, now, home });
  if (!facts) {
    return { goalId: input.goalId, now, factsFound: false, caps: [], bindingCap: null, reason: '读不到节奏事实 (还没有 Run / 读盘失败) → 上限无从核验, 不做归因' };
  }
  const caps = bindingCaps(facts, hardLimitsFor({ goal, run, maxRetries: input.maxRetries }));
  return {
    goalId: input.goalId,
    now,
    factsFound: true,
    caps,
    bindingCap: caps[0] ?? null,
    reason: caps.length > 0
      ? `在说话的安全上限 (反事实: 放宽它结论就变): ${caps.join(', ')}`
      : '没有任何安全上限在说话 (这一步的结论不是被上限拦下的)',
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
  ctx: {
    home?: string;
    existing?: { name: string; contentHash: string; version: string }[];
    now?: IsoTimestamp;
    runningSnapshotHash?: string | null;
    /** 通道 ①–⑤ 的准入结论 (候选产出处当场做); 缺了它候选文件里就没有"开过试用没有"这条事实 */
    admission?: SkillChannelAdmission | null;
  } = {},
): Promise<string | null> {
  const home = ctx.home ?? bolloonHome();
  const existing = ctx.existing ?? [];
  const assessment = assessCandidate(c, existing);
  if (assessment.junkReasons.length > 0) return null;
  const runningSnapshotHash = ctx.runningSnapshotHash ?? (await skillSnapshotHash(c.name, home));
  const file = path.join(home, SKILL_CANDIDATES_ROOT, `${safeName(c.candidateId)}.json`);
  const prev = await readJson<Record<string, unknown>>(file);
  const payload = {
    ...c,
    snapshotScope: 'next_run_only' as const,
    appliesToRunningRun: false,
    runningSnapshotHash,
    comparison: assessment.comparison,
    promotable: assessment.promotable,
    boundaryNote: SKILL_CANDIDATE_BOUNDARY_NOTE,
    recordedAt: ctx.now ?? new Date().toISOString(),
    /**
     * ★ 通道状态 (2026-09-25 串行收口): 候选文件是**这条候选唯一的事实落点** ——
     * 准入 (①–⑤) 与试用记录写在这里, 结算 (⑥ 提升/回退) 也写回这里。
     * 不新开目录/不新增存储: `trial` 就是"这份候选当前处在试用的哪一步"。
     * 准入**不是**晋升 (`promotion` 在准入侧恒为 null, 由 `settleSkillTrial` 才能给出)。
     */
    channel: ctx.admission
      ? {
        ok: ctx.admission.ok,
        stages: ctx.admission.stages,
        refusal: ctx.admission.refusal,
        note: '准入 ≠ 晋升: 提升的唯一出口是 settleSkillTrial (下一条 Run 成功复用并带证据)',
      }
      : null,
    trial: ctx.admission?.trial ?? null,
    /**
     * 提升记录: 候选产出时**显式**写 `null` (不是省略这个键) ——
     * 「键缺席」会被读成"没查过", `null` 才是"查过, 还没有"。已有记录一律保留 (提升过的不许被
     * 一次重复收尾抹掉; 与下面那条"同一候选 id 不同内容不覆盖"的守卫同一方向)。
     */
    promotion: (prev?.promotion ?? null) as unknown,
  };
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
  /** ★ 每条候选的通道准入结论 (开过试用 / 为什么没开) —— 候选产出处就是通道入口 (2026-09-25) */
  trials: SkillTrialOpenView[];
  /** 每轮一份的**用户汇报** (P4b 第一份输出) */
  reportPath: string;
  decisionRecordPath: string;
  continuationPatch: Partial<GoalContinuation>;
}

/** 一条候选的通道准入结论 (给上层看"开过试用没有", 不只给个路径) */
export interface SkillTrialOpenView {
  candidateId: string;
  skillName: string;
  admission: SkillChannelAdmission;
  /** 候选文件路径 (垃圾候选不落盘 → null) */
  path: string | null;
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
  // ★ 串行收口: 盘上**还挂在试用位**的候选也算"已有" —— 同一条要求被下一条 Run 又提一遍时,
  //   那是 `duplicate_of_existing` (不需要新版本), 不该再写一份候选、更不该再开一次试用
  //   (候选 id 带 Run, 所以"同名同内容"在这里是常态; 见 trialingSkillsOfGoal)。
  for (const t of await trialingSkillsOfGoal(home, goal.runs ?? [])) {
    if (!existingSkills.some((e) => e.name === t.name && e.contentHash === t.contentHash)) existingSkills.push(t);
  }
  const candidatePaths: string[] = [];
  const trialOpenings: SkillTrialOpenView[] = [];
  /** 同一批里**排在前面**的候选 (批内去重: 同名第二次不许再开一次试用) */
  const batchSiblings: SkillImprovementCandidate[] = [];

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
        // ★ 候选产出处 = 通道入口 (2026-09-25 串行收口): 候选**一被写出来**就过 ①–⑤ 准入。
        //   准入不是晋升 (promotion 恒为 null), 但"开过试用没有"必须当场有结论 ——
        //   否则下一条 Run 的复用确认 (settleSkillTrial) 根本没有试用记录可结算 (M2 报的钩子)。
        //   试用记录写进**候选文件本身** (已有落点, 不新开目录/不新增存储)。
        const admission = openSkillTrial({
          candidate: c,
          existing: existingSkills,
          siblings: batchSiblings,
          requestedBy: 'closure',
          runningSnapshotHash: await skillSnapshotHash(c.name, home),
          now,
        });
        const p = await writeSkillCandidate(c, { home, existing: existingSkills, now, admission });
        if (p) {
          candidatePaths.push(p);
          batchSiblings.push(c);
        }
        trialOpenings.push({ candidateId: c.candidateId, skillName: c.name, admission, path: p });
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

  // 决策记录落盘 (closure 阶段 = 权威决策 + 收尾产物本体: 收尾幂等靠它读回事实)
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
      continuation: result.continuation,
      userReport: result.userReport,
    },
    home,
  );

  const memoryFiles = result.facts.map((f) => path.join(home, '.bolloon', 'memory-layers', 'run_fact', `${safeName(f.memoryId)}.json`));

  return {
    result,
    written: memoryFiles,
    rejected: [],
    candidatePaths,
    trials: trialOpenings,
    reportPath,
    decisionRecordPath,
    continuationPatch: toGoalStoreContinuation(result.continuation),
  };
}

// ============================================================================
// §6.1 Skill 试用结算 (通道 ⑥ 的真调用方: **下一条 Run 成功点**)
// ============================================================================

/** 一条候选的结算结论 (宿主用它记账/上报; 不提升时 `reason` 说清为什么) */
export interface SkillTrialSettlementView {
  candidateId: string;
  skillName: string;
  status: SkillTrialRecord['status'];
  promoted: boolean;
  toVersion: string | null;
  reason: string;
  /** 结算写回的候选文件 (读不到文件时为 null) */
  path: string | null;
}

/** 盘上候选文件里本模块要读的字段 (其余原样保留: 草案内容不许被这里改) */
interface CandidateFileShape {
  candidateId?: string;
  name?: string;
  contentHash?: string;
  trial?: SkillTrialRecord | null;
  promotion?: unknown;
  [k: string]: unknown;
}

/**
 * 把通道状态写回候选文件 —— **只动 `trial` / `promotion` 两个键**, 草案内容一个字节都不改。
 *
 * 为什么绕过 `writeSkillCandidate` 的"同名不同内容不覆盖"守卫: 那条守卫保护的是**草案**
 * (候选是事实记录), 而通道状态 (trialing → promoted / rolled_back) 本来就是会变的状态 ——
 * 这是它唯一允许的写回点 (而且写回的就是"试用被兑现/回退"这个事实)。
 */
async function writeCandidateChannelState(
  file: string,
  patch: { trial: SkillTrialRecord; promotion?: unknown },
): Promise<void> {
  const cur = await readJson<CandidateFileShape>(file);
  if (!cur) return;
  await atomicWrite(file, JSON.stringify({
    ...cur,
    trial: patch.trial,
    promotion: patch.promotion ?? cur.promotion ?? null,
  }, null, 2));
}

/**
 * `existing` 里要计入的**已挂试用**的 Skill 身份 (2026-09-25 串行收口)。
 *
 * 为什么必须有这一条: 候选 id 里带 Run (`cand:<runId>:<i>:<name>`), 所以同一条要求被**下一条 Run
 * 又提一遍**时是一份**新候选** —— 盘上于是出现两份同名同内容的候选, 各开一次试用。而"同名同内容"
 * 在冻结纪律里就是 `duplicate_of_existing` (不需要新版本): **已经挂在试用位 (还没提升) 的那一份
 * 就是"已有"**。不认它, 一条变更会有两条提升记录, 且第二份候选永远等不到兑现。
 *
 * 归属只认**可核验的 Run 来源**: 候选的 `sourceRunIds` 里有一条属于本 Goal (`goal.runs`)。
 * 读不到目录 = 没有候选 (不是"候选都通过了")。
 */
async function trialingSkillsOfGoal(
  home: string,
  goalRunIds: readonly string[],
): Promise<{ name: string; contentHash: string; version: string }[]> {
  const ids = new Set((goalRunIds ?? []).map((x) => String(x)));
  const out: { name: string; contentHash: string; version: string }[] = [];
  for (const { rec } of await listTrialingCandidates(home)) {
    const trial = rec.trial as SkillTrialRecord;
    const src = Array.isArray(rec.sourceRunIds) ? rec.sourceRunIds.map((x) => String(x)) : [];
    if (!src.some((r) => ids.has(r))) continue;
    out.push({
      name: String(rec.name ?? trial.skillName),
      contentHash: String(rec.contentHash ?? trial.contentHash),
      version: String(trial.toVersion),
    });
  }
  return out;
}

/**
 * 盘上"还在试用位"的候选 (通道 ⑥ 的输入面)。
 * 读不到目录 = 没有任何候选 (不是"候选都通过/都失败")。
 */
async function listTrialingCandidates(home: string): Promise<{ file: string; rec: CandidateFileShape }[]> {
  const dir = path.join(home, SKILL_CANDIDATES_ROOT);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { file: string; rec: CandidateFileShape }[] = [];
  for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
    const file = path.join(dir, f);
    const rec = await readJson<CandidateFileShape>(file);
    if (rec?.trial && rec.trial.status === 'trialing') out.push({ file, rec });
  }
  return out;
}

/**
 * ★ 通道 ⑥ 的真调用方 (2026-09-25 串行收口): **下一条 Run 的成功点**结算所有还挂在试用位上的候选。
 *
 * 判定纪律 (全部来自盘上事实, 不靠调用方"记得"):
 *   · 兑现试用的 Run 必须**不是**开试用那条 (`settleSkillTrial` 会拒同一条 Run 自称成功);
 *   · 兑现的 Run 必须属于**同一个 Goal** (读 `trial.startedByRunId` 那条 Run 的 goalId 对照) ——
 *     别的 Goal 的成功不许把这份候选提升上去;
 *   · **复用必须带可核验证据**: 该 Run 的证据面里出现这条 Skill 名字的行; 一条都没有 → 不算复用
 *     (留在试用位, 与"无证据不许判目标完成"同一纪律);
 *   · Run 没成功 (status !== 'done') → `rolled_back`, **不提升**。
 *
 * 只产生**记录**: `SkillPromotionRecord` (校验 + 快照 + 可回退版本), 永不写 `skills/` (冻结规则 ⑥)。
 */
export async function settleSkillTrialsForRun(input: {
  goalId: string;
  runId: string;
  /** 这条 Run 的结局 (只有 'done' 算成功复用) */
  runStatus: string;
  /** 这条 Run 的证据面 (不给就从 Run 记录现读) */
  evidenceRefs?: readonly string[];
  now: IsoTimestamp;
  /** 批准人 (提升是正式变更: 必须有人/主体批准); 默认 supervisor (触发方就是它) */
  approvedBy?: string;
  home?: string;
}): Promise<SkillTrialSettlementView[]> {
  const home = input.home ?? bolloonHome();
  const run = await readRun(input.runId).catch(() => null);
  const evidencePool = input.evidenceRefs
    ? input.evidenceRefs.map((x) => String(x ?? ''))
    : run ? runEvidenceOf(run) : [];
  const succeeded = String(input.runStatus) === 'done';
  const out: SkillTrialSettlementView[] = [];

  for (const { file, rec } of await listTrialingCandidates(home)) {
    const trial = rec.trial as SkillTrialRecord;
    const candidateId = String(rec.candidateId ?? trial.candidateId ?? '');
    const skillName = String(rec.name ?? trial.skillName ?? '');
    const push = (v: Omit<SkillTrialSettlementView, 'candidateId' | 'skillName' | 'path'>): void => {
      out.push({ candidateId, skillName, path: file, ...v });
    };

    if (trial.startedByRunId === input.runId) {
      // 这份试用**就是本条 Run 开的** → 它不是"被本条 Run 结算"的对象 (试用的兑现窗口在它之后)。
      // 所以这里**跳过**而不是记一条 `same_run_cannot_promote` 的"结算结论": 报告里的
      // `skillTrials` 说的是"这一轮的结局对哪份试用做了裁决", 把刚开出的那份算进来会读成
      // "结算过了但没提升" —— 事实是**还没到结算的时候** (候选文件原封不动, 下一条 Run 再结算)。
      // (纯函数 `settleSkillTrial` 的同一守卫仍然在: 直连调用它的地方照样判红, 见 closure 测试。)
      continue;
    }
    // 跨 Goal 保护: 读不到开试用那条 Run 就**不结算** (拿不到事实不下结论, 也不提升)
    const fromRun = trial.startedByRunId ? await readRun(trial.startedByRunId).catch(() => null) : null;
    if (!fromRun) {
      push({ status: trial.status, promoted: false, toVersion: null, reason: `trial_origin_run_unreadable: 读不到开试用那条 Run (${trial.startedByRunId || '(空)'}) → 不结算 (拿不到事实就不提升)` });
      continue;
    }
    if (String(fromRun.goalId ?? '') !== input.goalId) {
      push({ status: trial.status, promoted: false, toVersion: null, reason: `trial_belongs_to_other_goal: 试用属于 ${fromRun.goalId} 的 Run, 与本 Goal (${input.goalId}) 不同 → 不结算` });
      continue;
    }

    const reuseEvidence = succeeded
      ? evidencePool.filter((e) => skillName && e.includes(skillName))
      : [];
    const settlement: SkillTrialSettlement = settleSkillTrial({
      trial,
      candidate: rec as unknown as SkillImprovementCandidate,
      reuse: {
        runId: input.runId,
        succeeded,
        evidenceRefs: reuseEvidence,
        approvedBy: input.approvedBy ?? 'supervisor',
        changeReason: succeeded
          ? `复用确认: 下一条 Run (${input.runId}) 成功并带 ${reuseEvidence.length} 条点名「${skillName}」的证据`
          : `下一条 Run (${input.runId}) 未成功 (status=${input.runStatus}) → 复用失败`,
        now: input.now,
      },
    });
    await writeCandidateChannelState(file, { trial: settlement.trial, promotion: settlement.promotion });
    push({
      status: settlement.status,
      promoted: settlement.ok,
      toVersion: settlement.promotion?.toVersion ?? null,
      reason: settlement.reason,
    });
  }
  return out;
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
  /**
   * 飞轮侧的收尾结论。**只要求它回答"下一步是什么"** (decision + continuation) ——
   * 刻意不绑 `CloseRunResult` 的整份形状: 收尾接缝 (M2 的 `wiring/closure.ts`) 传进来的
   * 是同一份事实的投影, 两者必须能直接对接, 而不是靠中间再拼一份。
   */
  flywheel: { decision: ContinuationDecision; continuation: GoalContinuationRecord };
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
  } else if (fy.decision === 'wait' && !hardError && legacy.goalStatus !== 'retry_wait') {
    // ★ M5-⑤ (2026-09-25) 真跑发现的不一致: 飞轮说"等"的时候, Goal 状态**和**用户可见态也必须说"等"。
    //   `lifecycleOf('active')` 会把 continuation.state 写成 `active` → `toUserVisibleState` 读出
    //   "执行中", 而真相是"在等外部": 没有任何 Run 会再跑它 (等事件/等到点)。页面上的"在跑"是假的。
    //   等外部/等子 Agent (没有到点时间) = `awaiting_external` (只能由事件唤醒);
    //   有 `wakeAt` 的等待 = `retry_wait` (到点自动醒来跑下一轮)。
    goalStatus = fy.wakeAt ? 'retry_wait' : 'awaiting_external';
    reason = `飞轮: 在等 (${fy.state}): ${fy.reason}`;
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
      // 规则 ②: 状态 + continuation 一起经 Goal reducer 写。
      // 旧写法是 setContinuation(...) + updateGoal(status:'needs_human') 两连 —— 后者是绕过 reducer 的
      // 状态写入 (被 M0 门禁按文件粒度判红后改道到这里)。语义不变: 交人 + 不再自动唤醒 + 记阻塞摘要。
      await reduceGoalState({
        goalId: input.goalId,
        intent: 'block_escalated_human',
        now,
        by: 'supervisor',
        reason: escalatedBlocks.join(' | '),
        needsExternalText: escalatedBlocks.join(' | ').slice(0, 300),
        unresolvedItems: uniqNonEmpty([
          ...(goal.continuation?.unresolvedItems ?? []),
          ...escalatedBlocks.map((s) => s.slice(0, 200)),
        ]).slice(0, 30),
      });
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
  // ★ M5-⑥ (2026-09-25): 把 Goal **本体**的状态一起交给投影 —— 只喂 continuation 时, 一份落后的
  //   派生记录就能把"已完成"说成"正在执行" (真跑复现: status=completed / visible=executing)。
  return toUserVisibleState(
    goal.continuation ? { ...goal.continuation } as GoalContinuationRecord : null,
    blocks,
    decision,
    goal.status,
  );
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
  const revoked = application.outcome === 'next_run' && classified.kind === 'abort';
  if (revoked) {
    // 规则 ②: 状态只有 Goal reducer 能写。这里走的是"用户明确撤销"这一类 (只有人能提, 见 change 接缝)。
    const applied = await reduceGoalState({
      goalId: goal.goalId,
      intent: 'user_revoked_goal',
      now,
      by: input.recordedBy ?? 'user',
      reason: `用户明确撤销 (${classified.changeId}): ${classified.instruction.slice(0, 120)}`,
    });
    if (!applied.ok) throw new Error(`撤销状态写入失败 (不静默): ${applied.reason}`);
  }
  // 这一条 updateGoal 只写"变更记录/判据版本", **不写状态** (状态已由 reducer 负责)
  await updateGoal(goal.goalId, patch);

  const nextRunDirective = application.outcome === 'rejected' ? null : application.nextRunDirective;
  if (nextRunDirective) {
    await setContinuation(goal.goalId, {
      nextAction: nextRunDirective,
      wakeReason: 'active',
      autoContinue: revoked ? false : goal.continuation?.autoContinue !== false,
      state: lifecycleOf(revoked ? 'abandoned' : goal.status),
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
  /**
   * ★ 这一步的节奏结论**从哪来** (2026-09-25 串行收口): `facts` = 走 M1 接缝的事实路径
   * (`readFacts` → P0 → 归因), `injected` = 事实拿不到时的旧注入口径。
   * 放在报告里是为了让"主循环真的走了新路径"可核验, 而不是只能读代码相信。
   */
  source: 'facts' | 'injected';
  /** 主节奏依据 (注入路径为 null) */
  basis: RhythmBasis | null;
  /** 在说话的安全上限 (注入路径为空) */
  caps: SafetyCap[];
}

export async function flywheelTickNote(input: {
  goalId: string;
  step: GoalStepDecision | SupervisorStepDecision;
  now?: IsoTimestamp;
  home?: string;
  /**
   * 这一 tick 里**统一巡检** (`monitor.sweepAll`) 已经查出来的阻塞 (没有才自己读)。
   * 为什么要这个入口: 巡检一次就够了 —— 同一条 tick 里再读一遍盘等于两份口径,
   * 而且「统一巡检」的意义就是**一次调用给全部结论**。
   */
  blocks?: BlockRecord[] | null;
}): Promise<FlywheelTickNote> {
  const blocks = input.blocks ?? await collectWorkBlocks({ goalId: input.goalId, now: input.now, home: input.home });
  const goal = await readGoal(input.goalId);
  const visible = toUserVisibleState(
    goal?.continuation ?? null,
    blocks,
    input.step.decision,
    // ★ M5-⑥: 调度报告里的用户可见态也必须认 Goal 本体的终态 —— 否则同一 tick 的报告中
    //   一个已完成目标会显示"正在执行", 与盘上事实相反。
    goal?.status ?? null,
  );
  const step = input.step as SupervisorStepDecision;
  return {
    goalId: input.goalId,
    decision: input.step.decision?.decision ?? 'first_run',
    state: input.step.decision?.state ?? 'progressing',
    runnable: input.step.runnable,
    reason: input.step.reason,
    noProgressStreak: input.step.noProgressStreak,
    visibleState: visible,
    nextAction: input.step.decision?.nextAction ?? '(首个 Run)',
    // 旧口径 (`GoalStepDecision` 不含 source) 如实标 injected —— 不假装是事实判的
    source: step.source ?? 'injected',
    basis: step.basis ?? null,
    caps: step.caps ?? [],
  };
}

/** 扫出"有待回报子工作"的 Goal (阻塞巡检的输入面, 有界) */
export async function listGoalsWithPendingWork(limit = 20): Promise<GoalRecord[]> {
  const goals = await listGoals({ limit: 200 });
  return goals.filter((g) => (g.continuation?.pendingReports?.length ?? 0) > 0).slice(0, limit);
}

// ============================================================================
// §11. 唯一责任链的接线 (M0) —— 接缝实例 / 收尾函数 / Run 终止钩子
// ============================================================================

/**
 * 收尾事实在 **Run 证据**里的锚点。
 *
 * 幂等判据为什么需要两个落点 (都是**已有**存储, 不新增):
 *   · 落点一 = Goal 的 closure 决策记录 (`.bolloon/goal-decisions/<goal>--<run>--closure.json`);
 *   · 落点二 = Run 自己的 evidence。
 * 只认落点一的话: 那条记录一丢 (误删 / 目录被清 / 换机器只搬了 runs/), 下一次调用会**当作没收过
 * 再收一遍** —— 于是第二条 Memory / 第二份 Skill 候选 / 第二条 closure 记录 = 又是两套事实。
 * Run 记录是跟着 Run 走的, 它上面的锚点不会因为 Goal 目录被动而消失。
 */
export const CLOSURE_EVIDENCE_PREFIX = '收尾已执行 (closeRun 9 步队列)';

/** 同一条 Run 是否已经收过尾 (两个已有落点的并集; 拿不到事实就返回 false = 会去收, 而不是假装收过) */
export async function hasClosureRecord(goalId: string, runId: string, home = bolloonHome()): Promise<boolean> {
  if (!goalId || !runId) return false;
  const records = await readDecisionRecords(goalId, home).catch(() => [] as DecisionRecord[]);
  if (records.some((r) => r.phase === 'closure' && r.runId === runId)) return true;
  const run = await readRun(runId).catch(() => null);
  return (run?.evidence || []).some((e) => String(e).includes(CLOSURE_EVIDENCE_PREFIX));
}

/** 把 CloseGoalRunOutcome 收成接缝视图 (接缝不 import 本文件的类型, 所以在这里做形状转换) */
function toClosureView(outcome: CloseGoalRunOutcome, runStatus: string): ClosureOutcomeView {
  return {
    runId: outcome.result.decision.runId,
    goalId: outcome.result.decision.goalId,
    steps: outcome.result.steps.length,
    decision: outcome.result.decision,
    continuation: outcome.result.continuation,
    userReport: outcome.result.userReport,
    runStatus,
    memories: outcome.written.length,
    candidates: outcome.result.candidates.length,
    // 候选产出处开出的试用: 只转发结构化结论 (准入的六阶段逐条裁决 + 卡在哪一步)
    trials: (outcome.trials ?? []).map((t) => ({
      candidateId: t.candidateId,
      skillName: t.skillName,
      ok: !!t.admission?.ok,
      stages: (t.admission?.stages ?? []).map((s) => ({ stage: String(s.stage), status: String(s.status), reason: String(s.reason ?? '') })),
      refusal: t.admission?.refusal ? { stage: String(t.admission.refusal.stage), reason: String(t.admission.refusal.reason ?? '') } : null,
      path: t.path,
    })),
    reportPath: outcome.reportPath,
    decisionRecordPath: outcome.decisionRecordPath,
  };
}

let seamsCache: FlywheelSeams | null = null;

// ============================================================================
// §11.1 非 web 宿主的接入面 (CLI / supervisor / 崩溃恢复)
//   —— 与 web 路由走**同一份**接缝, 不再"只有 /api 那条路能停 Run"
// ============================================================================

/** Goal 上当前那条 Run 的记录 (currentRunId 优先; 否则 runs 列表末条 —— 与 decideGoalStep 同一口径) */
async function readCurrentRunRecord(goalId: string): Promise<RunRecord | null> {
  const g = await readGoal(goalId);
  if (!g) return null;
  const id = g.currentRunId || g.runs?.[g.runs.length - 1];
  if (!id) return null;
  return readRun(id).catch(() => null);
}

/**
 * 在跑的 Run 的事实 (注入 change 接缝的 `runningRun` 端口)。
 *
 * `null` 的语义是**明确"当前没有在跑的 Run"** (目标上没挂 Run) —— 与 `undefined`(宿主不知道)
 * 严格区分: 前者接缝可以断言"变更只影响后续 Run", 后者只能如实标 `factsMissing`。读盘失败时
 * 抛错 (由接缝捕获 → 也是 factsMissing), 绝不谎报"没有在跑的 Run"。
 */
export async function readRunningRunFact(goalId: string): Promise<{ runId: string; status: string } | null> {
  const run = await readCurrentRunRecord(goalId);
  return run ? { runId: run.runId, status: String(run.status) } : null;
}

/**
 * 停 Run 的执行器 (注入 change 接缝的 `stopRunningRun` 端口)。
 *
 * 真实现就是**既有外部控制面原语** `setRunStatus` —— 与 `/api/runs/:id/abort` 同一条路,
 * 不新造停止通道; 写的是 Run 记录, 执行器下一轮读到就自行停下 (非法迁移会被 store 拒,
 * 这时如实返回 `ok:false` + 原因, 不假装停过)。
 */
export async function stopRunByExternalControl(i: {
  goalId: string;
  runId: string;
  runStatus: 'paused' | 'aborted';
  reason: string;
  now: IsoTimestamp;
}): Promise<{ ok: boolean; reason: string }> {
  const r = await setRunStatus(i.runId, i.runStatus, {
    error: `变更注入 (${i.goalId}): ${String(i.reason).slice(0, 120)}`,
  });
  return { ok: !!r.ok, reason: r.reason || (r.ok ? `已写 ${i.runId} → ${i.runStatus} (at ${i.now})` : '') };
}

/**
 * **非 web 宿主**提一条要求/撤销的唯一入口 (CLI / supervisor / 恢复脚本都走它)。
 *
 * 与 `/api/goals/:id/requirement` 的关系: **同一个接缝**, 同一份判定 (`planChangeInjection`),
 * 同一个停止原语 (`setRunStatus`)。路由做的是"从 HTTP 读事实再注入", 这里做的是"宿主自己读事实"
 * —— 事实来源相同 (`readRunningRunFact` / `pendingReports`), 所以两条路的结论一致。
 *
 * 返回 `SeamRefusal`/`null` 时**照原样**交给调用方 (拒绝了就是拒绝了, 不包装成 ok)。
 */
export async function ingestRequirementViaSeam(input: {
  goalId: string;
  instruction: string;
  source?: ChangeSource;
  recordedBy?: string;
  caller?: WiringCaller;
  now?: IsoTimestamp;
  workId?: string | null;
  liveWorkIds?: readonly string[];
}): Promise<ChangeIngestView | SeamRefusal | null> {
  const caller: WiringCaller = input.caller ?? 'human';
  const now = input.now ?? new Date().toISOString();
  const seam = flywheelSeams().change;
  const view = await seam.ingestChange({
    goalId: input.goalId,
    instruction: input.instruction,
    source: input.source ?? 'user',
    recordedBy: input.recordedBy ?? `${caller}:${process.pid}`,
    now,
    caller,
    workId: input.workId ?? null,
    ...(input.liveWorkIds !== undefined ? { liveWorkIds: input.liveWorkIds } : {}),
  });
  if (isRefusal(view) || view === null) return view;
  // 与 web 路由同一条兜底: 接缝自己没执行器 (老依赖注入下的形态) → 这里按计划把"停"落到真 Run 上。
  // M0 已注入 stopRunningRun, 正常情况下 `stopped` 已经是 true, 这段不会重复动手 (见 runBoundary.stopped)。
  if (view.runBoundary.action === 'stop_running_run' && !view.runBoundary.stopped) {
    const boundary = await seam.applyRunBoundary({
      plan: view.plan,
      now,
      stop: (i) => stopRunByExternalControl(i),
    });
    return { ...view, runBoundary: boundary };
  }
  return view;
}

export interface FlywheelSeams {
  continuation: ContinuationSeam;
  closure: ClosureSeam;
  contract: ContractSeam;
  monitor: MonitorSeam;
  change: ChangeSeam;
}

/**
 * 五个接缝的实例 (依赖在这里注入 —— 接缝文件自己不读盘)。
 *
 * 只构造一次 (memoize): 派生接缝与 Run 的事实面无关, 重建没有意义。
 * 测试想换注入 (例如假的 purgeTemporary) 走 `resetFlywheelSeamsForTest()`。
 */
export function flywheelSeams(): FlywheelSeams {
  if (seamsCache) return seamsCache;
  seamsCache = {
    continuation: createContinuationSeam({
      /**
       * ★ 规范路径 (2026-09-25 串行收口): 主循环的节奏判定**只读事实, 判定归接缝**。
       * 以前这里注入的是 `decide` (整条判定结论) —— 于是"接线层又判了一遍", M1 的自适应节奏
       * 在真路径上从未接管。现在 `readFacts` 是权威口径, `decide` 只作事实拿不到时的兜底
       * (兜底结果会被接缝标成 `source='injected'`, 不假装是事实判的)。
       */
      readFacts: readRhythmFacts,
      decide: async (i) => {
        const step = await decideGoalStep({ goalId: i.goalId, now: i.now, maxRetries: i.maxRetries, writeRecord: i.writeRecord });
        if (!step) return null;
        return {
          goalId: step.goalId,
          runnable: step.runnable,
          reason: step.reason,
          noProgressStreak: step.noProgressStreak,
          decision: step.decision
            ? {
              decision: step.decision.decision,
              state: step.decision.state,
              nextAction: step.decision.nextAction,
              requiredCapability: step.decision.requiredCapability,
              decisionId: step.decision.decisionId,
            }
            : null,
        };
      },
    }),
    closure: createClosureSeam({
      hasClosure: (goalId, runId) => hasClosureRecord(goalId, runId),
      closeGoalRun: async (i) => {
        // Run 的状态是收尾事实的一部分 (用户汇报 / 决策记录都要它) —— 在这里读一次并带进视图
        const runBefore = await readRun(i.runId).catch(() => null);
        const out = await closeGoalRun({ goalId: i.goalId, runId: i.runId, now: i.now, finalReview: i.finalReview, maxRetries: i.maxRetries });
        // 幂等的第二锚点: 把"这条 Run 收过尾了"刻在 **Run 自己的证据**上 (见 CLOSURE_EVIDENCE_PREFIX)
        if (out) {
          await addRunEvidence(i.runId, [
            `${CLOSURE_EVIDENCE_PREFIX} → ${out.result.decision.decision} (goal=${i.goalId}, at=${i.now})`,
          ]).catch(() => null);
        }
        return out ? toClosureView(out, String(runBefore?.status ?? '')) : null;
      },
      purgeTemporary: async () => {
        // P1b: temporary 层任务结束自动过期归档 (没有 temporary 记录时是 0)
        const dir = path.join(bolloonHome(), '.bolloon', 'memory-layers', 'temporary');
        let files: string[] = [];
        try { files = await fs.readdir(dir); } catch { return 0; }
        let archived = 0;
        for (const f of files.filter((x) => x.endsWith('.json'))) {
          const rec = await readJson<{ expiresAt?: string }>(path.join(dir, f));
          if (!rec?.expiresAt) continue;
          if (Date.parse(rec.expiresAt) > Date.now()) continue;
          const dest = path.join(bolloonHome(), '.bolloon', 'memory-layers', 'archived');
          await fs.mkdir(dest, { recursive: true }).catch(() => null);
          await fs.rename(path.join(dir, f), path.join(dest, f)).then(() => { archived++; }).catch(() => null);
        }
        return archived;
      },
    }),
    contract: createContractSeam({
      issue: (i) => dispatchChildWork({
        goalId: i.goalId,
        parentRunId: i.parentRunId,
        childAgentId: i.childAgentId,
        capability: i.capability,
        objective: i.objective,
        inputs: i.inputs,
        allowedTools: i.allowedTools,
        budget: i.budget,
        deadline: i.deadline,
        successCriteria: i.successCriteria,
        now: i.now,
        issuedBy: i.issuedBy,
      }),
      accept: (i) => handleChildReport({ goalId: i.goalId, workId: i.workId, report: i.report, now: i.now }),
    }),
    monitor: createMonitorSeam({
      collect: (i) => collectWorkBlocks({ goalId: i.goalId, now: i.now, runnerAvailable: i.runnerAvailable }),
      handle: (i) => applyBlockHandling({ goalId: i.goalId, blocks: i.blocks, now: i.now }),
      goalsWithPendingWork: async (limit) => (await listGoalsWithPendingWork(limit)).map((g) => ({ goalId: g.goalId })),
      /**
       * ★ 用户可见面 (2026-09-25 串行收口): 注进去, `sweepAll` 才不是"半个人"
       * —— 没有它每一格都会因可见态拒绝而记 error, 于是 `silentRisk=true` +
       * `escalated` 里塞满"巡检未完成: <goalId>" (把"没注入探针"演成"巡检失败")。
       * 走的是**同一份**判定 (`goalVisibleState` → `toUserVisibleState`), 界面不另拼一套状态。
       */
      visible: (i) => goalVisibleState({ goalId: i.goalId, blocks: i.blocks, now: i.now }),
    }),
    change: createChangeSeam({
      ingest: (i) => ingestGoalChange({
        goalId: i.goalId,
        instruction: i.instruction,
        source: i.source,
        recordedBy: i.recordedBy,
        now: i.now,
        scopeWorkIds: i.workId ? [i.workId] : undefined,
      }).then((out) => {
        if (!out) throw new Error(`变更无法入档 (goal=${i.goalId})`);
        return { request: out.request, classification: out.application, application: out.application };
      }),
      nextRunDirective: (goalId) => nextRunChangeDirective(goalId),
      markConsumed: (goalId, runIndex, now) => markChangesConsumed(goalId, runIndex, now),
      visibleState: (i) => goalVisibleState({ goalId: i.goalId, now: i.now }),
      pending: async (goalId) => {
        const g = await readGoal(goalId);
        return (g?.goalChanges ?? []).filter((c) => c.status === 'needs_approval' || c.status === 'scheduled_next_run' || c.status === 'triaged');
      },
      /**
       * ★ 在跑的 Run 的事实 (2026-09-25 串行收口): 以前**只有** web 路由按参数传,
       * 于是任何非 web 宿主 (CLI / supervisor / 崩溃恢复脚本) 提撤销时, 接缝拿到的是
       * `factsMissing=true` → 判定"不断言停不停" → **在跑的 Run 停不下来**。
       * 现在把"读当前 Run 状态"这件事实注入接缝 (真实现 = 读 Goal 的 currentRunId → readRun)。
       */
      runningRun: (goalId) => readRunningRunFact(goalId),
      /** ★ 停 Run 的执行器 = 既有的 `setRunStatus` 原语 (与 web 的 abort 路由同一个) */
      stopRunningRun: (i) => stopRunByExternalControl(i),
      /** ★ 在跑的子 Agent 工作 (规则 5 的下发对象): 从父 Goal 登记的 pendingReports 读 */
      liveWorkIds: async (goalId) => {
        const g = await readGoal(goalId);
        return (g?.continuation?.pendingReports ?? []).map((p) => String(p?.workId ?? '')).filter(Boolean);
      },
    }),
  };
  return seamsCache;
}

/** 测试用: 丢掉接缝实例 (下次 `flywheelSeams()` 重新注入) */
export function resetFlywheelSeamsForTest(): void {
  seamsCache = null;
}

/**
 * **收尾唯一入口** (规则 ③ + ④): 所有终止路径都调它, 它再调 `closeRun` (经 closure 接缝)。
 *
 * 幂等: 同一条 runId 只真收一次 (第二次 `alreadyClosed=true`)。因此
 * "Runner 自己收 + Supervisor 又收"不会写出两套产物。
 *
 * 返回值刻意是 union (`CloseRunOnceResult | SeamRefusal`), 让调用方能如实区分
 * "收过了 / 真收了 / 拒绝 (说不清是哪条 Run)" 三种情形, 而不是一个 boolean。
 */
export async function closeRunOnce(input: {
  goalId: string;
  runId: string;
  caller?: WiringCaller;
  now?: IsoTimestamp;
  finalReview?: string;
  maxRetries?: number;
  /**
   * 宿主**申明**的终止原因 (冻结闭集见 `CLOSURE_TERMINAL_KINDS`)。
   *
   * 为什么必须能透传 (2026-09-25 串行收口): 收尾回执 (ClosureReceipt) 上"申明的原因"与
   * "从 Run 状态推导的原因"是**两条事实**, 缺了申明就只有推导 —— 于是"超时 / 支付·权限·工具失败 /
   * 子 Agent 被阻塞"这类**具体**原因在回执里看不到, 只剩一个笼统的 `failure`。
   * 不给也不编: 不传就是"没有申明"(推导仍然在), 传了但与该 Run 状态不符时由接缝的审计标出来。
   */
  terminalKind?: ClosureTerminalKind;
}): Promise<CloseRunOnceResult | SeamRefusal> {
  const seamResult = await flywheelSeams().closure.closeRunOnce({
    goalId: input.goalId,
    runId: input.runId,
    caller: input.caller ?? 'supervisor',
    now: input.now ?? new Date().toISOString(),
    finalReview: input.finalReview,
    maxRetries: input.maxRetries,
    terminalKind: input.terminalKind,
  });
  if (isRefusal(seamResult)) return seamResult;
  if (!seamResult.alreadyClosed) return seamResult;
  // 已经收过尾 → 把**那次**的事实读回来 (幂等但不丢事实): 上层仍能拿到 continuation 与用户汇报
  const back = await readClosureOutcome(input.goalId, input.runId);
  return {
    ...seamResult,
    outcome: back,
    reason: back
      ? seamResult.reason
      : `${seamResult.reason} —— 但收尾事实读不回来 (closure 决策记录缺 continuation/userReport): 上层必须如实记"收过了、事实缺失", 不许当没收过再收一遍`,
  };
}

/**
 * 从 Run 的事实**推**一个宿主该申明的终止原因 (喂给 `closeRunOnce` 的 `terminalKind`)。
 *
 * 为什么不让调用方(或这里)随便编: 申明的种类必须与该 Run 状态**相容** (由 `terminalKindAccepts`
 * 校验), 否则收尾审计会把它记成"申明与事实不符" —— 自己给自己造审计缺口。
 * 所以这里只在事实**足够具体**时给出更细的原因:
 *   · `failed` + 权限/支付类 errorClass → 权限·支付·工具失败 (最常被"重试掉"的三类);
 *   · `failed` + 超时/预算类文本       → 超时·预算耗尽;
 *   · `stalled` + 子 Agent 文本        → 子 Agent 被阻塞; 否则失速;
 *   · 其余一律交回 `closureTerminalKindFor` 的推导 (退回一个**主归属**, 不硬编更细的类别)。
 */
export function claimedTerminalKindForRun(run: RunRecord | null): ClosureTerminalKind | undefined {
  if (!run) return undefined;
  const status = String(run.status ?? '');
  const errorClass = String((run as { errorClass?: string }).errorClass ?? '');
  const text = `${errorClass} ${String(run.error ?? '')} ${String(run.summary ?? '')}`;
  if (status === 'failed' && (errorClass === 'auth' || errorClass === 'policy_denied')) {
    return 'permission_or_payment_or_tool_failure';
  }
  if (status === 'failed' && /timeout|超时|deadline|budget|预算|quota/i.test(text)) return 'timeout';
  if (status === 'stalled') return /子|child/i.test(text) ? 'child_agent_blocked' : 'stall';
  const derived = closureTerminalKindFor(status);
  return derived ? derived as ClosureTerminalKind : undefined;
}

/**
 * 一条 Run **开出**的 Skill 试用 —— 从盘上候选文件读回来 (读回路径的 `trials`, 2026-09-25 串行收口)。
 *
 * 为什么不返回 `[]` 就算: 试用记录本来就写在**候选文件本身** (`trial.startedByRunId` = 提出候选的
 * 那条 Run, 由 `run-closure.ts` 填成收尾的那条 Run), 所以"这条 Run 开过哪些试用"是**可读的事**。
 * 返回空数组会被读成"这条 Run 没开过试用"—— 那是编态。读不到目录 = 真的一个候选都没有。
 */
async function trialsOfRun(runId: string, home: string): Promise<TrialOpeningView[]> {
  const dir = path.join(home, SKILL_CANDIDATES_ROOT);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: TrialOpeningView[] = [];
  for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
    const rec = await readJson<CandidateFileShape & { channel?: { ok?: unknown; stages?: unknown; refusal?: unknown } }>(path.join(dir, f));
    const trial = (rec?.trial ?? null) as SkillTrialRecord | null;
    if (!rec || String(trial?.startedByRunId ?? '') !== runId) continue;
    const ch = rec.channel ?? null;
    const stages = Array.isArray(ch?.stages) ? ch!.stages as { stage?: unknown; status?: unknown; reason?: unknown }[] : [];
    const refusal = ch?.refusal && typeof ch.refusal === 'object' ? ch.refusal as { stage?: unknown; reason?: unknown } : null;
    out.push({
      candidateId: String(rec.candidateId ?? trial?.candidateId ?? ''),
      skillName: String(rec.name ?? trial?.skillName ?? ''),
      // 准入结论以**盘上记的那一份**为准; 没记过 (老候选) → false, 不假装开过试用
      ok: ch?.ok === true,
      stages: stages.map((s) => ({ stage: String(s.stage ?? ''), status: String(s.status ?? ''), reason: String(s.reason ?? '') })),
      refusal: refusal ? { stage: String(refusal.stage ?? ''), reason: String(refusal.reason ?? '') } : null,
      path: path.join(dir, f),
    });
  }
  return out;
}

/**
 * 一条**已经收过尾的 Run**: 把**那次收尾的事实读回来** (不重跑, 也不编)。
 *
 * 依据就是 `closeGoalRun` 自己写下的 closure 决策记录 (它自带 continuation 与用户汇报)。
 * 读不到就返回 null —— 调用方必须如实说"收过了但事实读不回来", 而不是当作没收过再收一遍。
 */
export async function readClosureOutcome(goalId: string, runId: string, home = bolloonHome()): Promise<ClosureOutcomeView | null> {
  const records = await readDecisionRecords(goalId, home).catch(() => [] as DecisionRecord[]);
  const rec = records.find((r) => r.phase === 'closure' && r.runId === runId);
  if (!rec) return null;
  if (!rec.continuation || !rec.userReport) return null;
  const run = await readRun(runId).catch(() => null);
  const reportPath = path.join(home, GOAL_REPORTS_ROOT, `${safeName(goalId)}--${safeName(runId)}.json`);
  return {
    runId,
    goalId,
    // 步数是**冻结面**的收尾流水线长度: 收尾是固定 9 步, 不随读写路径变化
    steps: CLOSURE_STEP_ORDER.length,
    decision: rec.decision,
    continuation: rec.continuation,
    userReport: rec.userReport,
    runStatus: String(run?.status ?? ''),
    memories: 0,
    candidates: 0,
    // 读回路径上的试用: 从候选文件本身读 (不是空数组 —— 见 trialsOfRun 的注释)
    trials: await trialsOfRun(runId, home),
    reportPath,
    decisionRecordPath: decisionFilePath(goalId, runId, 'closure', home),
  };
}

/**
 * 一次继续决策 → Goal 状态 (给**没有 Supervisor 宿主**的 Runner 用)。
 *
 * 只是把决策的语义翻译成 Goal 生命周期状态, **不做任何判定**:
 *   complete → completed (仍要过完成门) · fail → failed · pause → paused ·
 *   ask_human → needs_human · delegate → active (派活期间目标还在推进) ·
 *   wait/continue → active。
 */
export function goalStatusFromDecision(d: ContinuationDecision): GoalStatus {
  switch (d.decision) {
    case 'complete': return 'completed';
    case 'fail': return 'failed';
    case 'pause': return 'paused';
    case 'ask_human': return 'needs_human';
    // ★ M5-⑤ (2026-09-25 真跑验收): decision='wait' 以前落进 default 的 'active' —— 于是
    //   "Run 停在等外部"的 Goal 在盘上写着 active, 界面显示"执行中", 但飞轮判 runnable=false:
    //   没有任何人会跑它, 直到可信事件到达。状态必须和等待同义 (客户看到的和系统认定的同一份)。
    case 'wait': return d.state === 'waiting_external' ? 'awaiting_external' : 'retry_wait';
    default: return 'active';
  }
}

/**
 * 把一条收尾结论经 **Goal reducer** 落进 Goal (唯一漏斗, 规则 ②)。
 *
 * 这是"链的下半段": 收尾写了产物 (上半段), 这一步写回"下一步是什么" —— 下一次 continuation。
 * Supervisor 用它自己的运输层版本 (带退避), 非 Supervisor 宿主 (CLI / 崩溃恢复 / 失速) 用这一份。
 */
export async function applyClosureToGoal(
  goalId: string,
  view: ClosureOutcomeView,
  by = 'system',
  now = new Date().toISOString(),
): Promise<{ status: string | null; gateRejected?: string }> {
  const applied = await reduceGoalState({
    goalId,
    intent: 'closure_outcome',
    now,
    by,
    outcome: {
      goalStatus: goalStatusFromDecision(view.decision),
      continuation: toGoalStoreContinuation(view.continuation),
      reason: view.decision.reason,
    },
    runId: view.runId,
  });
  return { status: applied.status, gateRejected: applied.gateRejected };
}

/**
 * Run 被**底层状态机**判成终止时 (崩溃恢复 → interrupted / 失速 → stalled) 的回调。
 *
 * `run-store` 不认识 Goal, 也不该认识 —— 所以它只暴露一个注册点; 由接线层注册本函数。
 * 于是"崩溃恢复"与"失速"这两条终止路径也进了唯一责任链 (规则 ④):
 * 拿到 Run 事实 → 找它的 Goal → 走 `closeRunOnce` → 把下一步经 reducer 写回 Goal。
 */
export async function onRunTerminal(input: { runId: string; status: string; goalId?: string | null }): Promise<{ closed: boolean; reason: string; applied: string | null }> {
  const run = await readRun(input.runId).catch(() => null);
  const goalId = input.goalId || run?.goalId || '';
  if (!goalId) return { closed: false, reason: `Run ${input.runId} 没有绑 Goal → 无从收尾 (不假装收过)`, applied: null };
  const out = await closeRunOnce({ goalId, runId: input.runId, caller: 'system', finalReview: `底层状态机判为 ${input.status}: ${run?.error || ''}`.trim() });
  if (isRefusal(out)) return { closed: false, reason: out.reason, applied: null };
  if (out.alreadyClosed) return { closed: false, reason: out.reason, applied: null };
  if (!out.outcome) return { closed: true, reason: out.reason, applied: null };
  // 收尾产物有了 → 立刻把"下一步"写回 Goal (否则崩溃恢复这一轮等于白收: 下次还得从零开始)
  const applied = await applyClosureToGoal(goalId, out.outcome, 'system');
  return { closed: true, reason: out.reason, applied: applied.status };
}

/** 把 Run 终止钩子装进 run-store (幂等; 谁宿主谁装) */
export async function installRunTerminalHook(): Promise<void> {
  const { setOnRunTerminal } = await import('./run-store.js');
  setOnRunTerminal(async (rec) => {
    await onRunTerminal({ runId: rec.runId, status: rec.status, goalId: rec.goalId }).catch(() => null);
  });
}

/**
 * 非 Supervisor 宿主 (CLI `bolloon task` / 独立进程) 的收尾入口。
 *
 * 做的事和 Supervisor 完全一样, 只是没有运输层的退避语义 —— 所以它：
 *   ① `closeRunOnce` 收尾 (幂等); ② 把"下一步是什么"经 Goal reducer 落进 Goal。
 * 于是"CLI 任务跑完"与"Supervisor 推进一轮"在**同一份事实**上收口, 不再各写一套。
 */
export async function closeTaskRun(
  runId: string,
  goalId: string,
  note: string,
  by = 'cli',
): Promise<{ closed: boolean; reason: string; decision: string | null }> {
  const now = new Date().toISOString();
  const out = await closeRunOnce({ goalId, runId, caller: 'runner', now, finalReview: note });
  if (isRefusal(out)) return { closed: false, reason: out.reason, decision: null };
  if (!out.outcome) return { closed: false, reason: out.reason, decision: null };
  const view = out.outcome;
  await applyClosureToGoal(goalId, view, by, now);
  return { closed: !out.alreadyClosed, reason: out.reason, decision: view.decision.decision };
}
