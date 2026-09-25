/**
 * continuation-decision.ts — P0「节奏由进展决定」判定器 (2026-09-25)
 *
 * 归属: `docs/wiki/goal-continuation-flywheel.md` §13「P0 节奏」。本文件**独占**:
 *   - 不写入冻结面 (`types.ts` / `index.ts`), 不 import 其它阶段的实现文件;
 *   - 不接任何现有调用方 (接线是 P1 单一所有者的事);
 *   - 阶段间只通过 `types.ts` 的类型耦合 —— 这里只 `import type`, 运行期零依赖。
 *
 * 三条纪律 (与 §14「共同约定」逐条对应):
 *
 *   ① **纯函数 · 无 I/O · 可回放**
 *      时间一律由 `now` 注入 (不读真实钟); 不 import fs / 网络 / crypto; 不调用
 *      `Date.now` / `new Date` / `Math.random` / `randomUUID`。`decisionId` 由 (goalId, runId)
 *      派生 —— 同一批事实重放, 得到**逐字节相同**的决策, 不会造出第二条决策。
 *
 *   ② **节奏由进展决定, 不由轮次/时长决定**
 *      唯一有资格"继续"的是 `ProgressDelta` 里的**新的可核验证据**或**新满足的判据**。
 *      `stepsAdvanced`(步数) / `unresolvedDelta` / "跑了第几轮" / "跑了多久" **都不是进展**:
 *      没有证据就没有继续的资格 (types.ts §1), 宁可交人。
 *
 *   ③ **硬底线是安全线, 不是任务节奏**
 *      单 Run 时间上限 · 单 Goal 预算上限 · 无进展熔断阈值只决定"什么时候必须停"。
 *      `applyHardLimits` 只能**收紧** (自治决策 → 交人), 永不放开; 非自治决策原样返回。
 *
 * 判定优先级 (先命中先返回, 每条都给出结构化 reason):
 *   ⓪ `now` 不可解析 → 交人 (时间不可信, 不做任何自动判断)
 *   ① Goal 已是终态 → 幂等 mirror 成 complete / fail
 *   ② 判据全满足 → 过完成门才 complete; 判据没被确认 / 完全没有证据 → 交人
 *   ③ 三类硬底线 (单 Run 超时 / Goal 预算用尽 / 无进展熔断) → 交人
 *   ④ Supervisor 已判失速 (goal.status='stalled') → 交人
 *   ⑤ 不可恢复的 Run 失败 (auth / policy_denied / persist_failed / repeat_failure)
 *   ⑥ 等外部 / 等时间 / 等子 Agent → wait
 *   ⑦ 人主动暂停 → pause
 *   ⑧ 目标等人 → ask_human
 *   ⑨ 有可核验进展 → continue
 *   ⑩ 目标声明了未就绪的必需能力 → delegate (下一步该派给具备该能力的执行者)
 *   ⑪ 以上都不成立 (本轮没有新证据) → 交人, 不许自动继续
 */

import type { GoalRecord } from '../goal-store.js';
import type { RunRecord } from '../run-store.js';
import type {
  ContinuationDecision,
  ContinuationDecisionKind,
  ContinuationState,
  HardLimits,
  IsoTimestamp,
  ProgressDelta,
  RiskLevel,
  StopReason,
} from './types.js';

/**
 * `decideContinuation` 的入参 (与 §14 冻结签名逐字一致; 单独命名便于接线层直接引用
 * `Parameters<typeof decideContinuation>[0]`, 不需要手抄一份)。
 *
 * 注意 `goal.budget` 用的是 `GoalRecord` 既有口径 (`maxRuns` / `deadlineMs`), 与
 * `HardLimits.maxGoalBudget` (原子单位/步数上限) 是**两条不同的安全线**, 两条都判定。
 */
export interface DecideContinuationInput {
  goal: GoalRecord;
  run: RunRecord;
  now: IsoTimestamp;
  /** 本轮的进展证据 —— 没有它就没有"继续"的资格 */
  progress: ProgressDelta;
  /**
   * 连续"无新证据且无新完成判据"的 Run 数 —— **含本轮**。
   * 只与 `HardLimits.noProgressCircuitBreaker` 比较, **不**当作"第几轮"用。
   */
  noProgressStreak: number;
  hardLimits: HardLimits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具 (全部不导出: 冻结面只认 §14 的三个函数, 其余是实现细节)
// ─────────────────────────────────────────────────────────────────────────────

const RISK_ORDER: readonly RiskLevel[] = ['low', 'medium', 'high'];

/** 提高风险级别 (只能往上, 不许往下) */
function bumpRisk(r: RiskLevel, steps = 1): RiskLevel {
  const i = RISK_ORDER.indexOf(r);
  const base = i < 0 ? 0 : i;
  return RISK_ORDER[Math.min(RISK_ORDER.length - 1, base + steps)];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 时间戳只信 `Date.parse` 能解析的 (解析不了 = 不可信, 不做自动判断) */
function parseTs(ts: string | null | undefined): number {
  if (typeof ts !== 'string' || ts.trim() === '') return Number.NaN;
  return Date.parse(ts);
}

/** 正有限数 (时间/预算类安全线) */
function isPosFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** 正整数计数 (熔断阈值这种"计数类"安全线; 0/负数/小数 = 未定义) */
function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

/** 去空 + 去重, 保序 */
function uniq(xs: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const x of xs ?? []) {
    if (typeof x === 'string' && x.trim() !== '' && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * **有可核验进展吗** —— 唯一有资格继续的东西。
 * `stepsAdvanced` / `unresolvedDelta` / 轮次 / 时长**刻意不算**:
 * "禁止用轮次/时长冒充进展" (types.ts §1)。
 */
function hasVerifiableProgress(p: ProgressDelta): boolean {
  return p.newEvidence.length > 0 || p.newlyCompletedCriteria.length > 0;
}

/** 自治决策 (真的会往下跑): 只有它们存在"被收紧"的空间 */
const AUTONOMOUS: readonly ContinuationDecisionKind[] = ['continue', 'delegate'];

function isAutonomous(k: ContinuationDecisionKind): boolean {
  return AUTONOMOUS.includes(k);
}

/**
 * decision → 允许自洽出现的 state (types.ts §1: "决策时的状态 (与 decision 必须自洽)")。
 * `pause` 映射到 `waiting_external`: 语义是"等用户 resume (等一个外部动作唤醒)",
 * 状态枚举里没有 paused, 这是唯一自洽的选择。
 */
const DECISION_STATES: Record<ContinuationDecisionKind, readonly ContinuationState[]> = {
  continue: ['progressing'],
  wait: ['waiting_external', 'waiting_agent'],
  delegate: ['waiting_agent'],
  ask_human: ['needs_decision', 'no_progress', 'blocked'],
  complete: ['completed'],
  fail: ['failed'],
  pause: ['waiting_external'],
};

/** 低信心不是"可以忽略", 是"该问人" (types.ts §1) */
const LOW_CONFIDENCE = 0.5;

/** Run 还"没跑干净"的状态: 它们存在时不许判完成 (与 goal-store 完成门同一口径) */
const UNSETTLED_RUN_STATUSES: readonly string[] = ['failed', 'interrupted', 'stalled'];

/**
 * **还在跑**的 Run 状态 (没有给出任何结束结论的那种)。
 * 单 Run 时间上限给这类 Run 计龄时必须用 `now` —— 它们的 `updatedAt` 只是"最后一次心跳",
 * 用它会得出"这个跑了 3 小时的 Run 只跑了 0ms"的假结论 (P5 验收修复的一部分)。
 * 注意 `failed`/`interrupted`/`stalled` 不在这个集合里但由 `UNSETTLED_RUN_STATUSES` 一起覆盖
 * (它们是"已经停了但没收尾"的中间态, 同样按 now 计龄)。
 */
const RUN_ACTIVE_STATUSES: readonly string[] = ['queued', 'running'];

/** 缺权限类失败: 不重试, 交人 (run-store 的错误分类表) */
const PERMISSION_FAILURES: readonly string[] = ['auth', 'policy_denied'];

interface Draft {
  decision: ContinuationDecisionKind;
  state: ContinuationState;
  reason: string;
  nextAction: string;
  expectedOutcome: string;
  confidence: number;
  wakeAt?: IsoTimestamp | null;
  requiredCapability?: string | null;
  riskLevel: RiskLevel;
  stopReason?: StopReason | null;
}

interface Ctx {
  goal: GoalRecord;
  run: RunRecord;
  now: IsoTimestamp;
  progress: ProgressDelta;
  unresolvedItems: string[];
  evidenceRefs: string[];
}

/** 把 Draft 补成一条**字段齐全**的 `ContinuationDecision` (缺字段 = 收尾没做完) */
function finalize(draft: Draft, ctx: Ctx): ContinuationDecision {
  const terminal = draft.decision === 'complete' || draft.decision === 'fail';
  // 未解决项变多 (unresolvedDelta > 0) 是风险信号: 只在非终态决策上抬一级
  const riskLevel = !terminal && ctx.progress.unresolvedDelta > 0 ? bumpRisk(draft.riskLevel) : draft.riskLevel;
  return {
    // 派生自 (goalId, runId): 一个 Run 只允许一条决策, 重放不产生第二条
    decisionId: `decision:${ctx.goal.goalId}:${ctx.run.runId}`,
    goalId: ctx.goal.goalId,
    runId: ctx.run.runId,
    decision: draft.decision,
    state: draft.state,
    reason: draft.reason,
    nextAction: draft.nextAction,
    expectedOutcome: draft.expectedOutcome,
    confidence: clamp01(draft.confidence),
    progressDelta: {
      newEvidence: [...ctx.progress.newEvidence],
      newlyCompletedCriteria: [...ctx.progress.newlyCompletedCriteria],
      stepsAdvanced: ctx.progress.stepsAdvanced,
      unresolvedDelta: ctx.progress.unresolvedDelta,
    },
    unresolvedItems: [...ctx.unresolvedItems],
    wakeAt: draft.wakeAt ?? null,
    requiredCapability: draft.requiredCapability ?? null,
    riskLevel,
    stopReason: draft.stopReason ?? null,
    evidenceRefs: [...ctx.evidenceRefs],
    decidedAt: ctx.now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 P0-1: decideContinuation
// ─────────────────────────────────────────────────────────────────────────────

export function decideContinuation(input: DecideContinuationInput): ContinuationDecision {
  const { goal, run, now, progress, noProgressStreak, hardLimits } = input;

  // 合并视图: `progress` = 本轮新增、**尚未落盘**的那部分证据/判据, 与 Goal 上的历史取并集。
  // 刻意**只认 Goal 上的证据 + 本轮新增** (不把 run.evidence 也算进来): 这样完成判定与
  // goal-store 完成门 `evaluateGoalCompletion` 在 progress 为空时**逐例等价** (见测试 ④)。
  const criteriaDone = new Set<number>([...goal.completedCriteria, ...progress.newlyCompletedCriteria]);
  const allCriteriaDone = goal.successCriteria.length > 0 && goal.successCriteria.every((_, i) => criteriaDone.has(i));
  const remaining = goal.successCriteria.filter((_, i) => !criteriaDone.has(i)).length;
  const evidenceRefs = uniq([...(goal.evidence ?? []), ...progress.newEvidence]).slice(-20);
  const unresolvedItems = uniq(goal.unresolvedItems);
  const hasProgress = hasVerifiableProgress(progress);
  const ctx: Ctx = { goal, run, now, progress, unresolvedItems, evidenceRefs };

  const resumePoint = ((run.checkpoint?.nextAction ?? goal.continuation?.nextAction ?? '') || '').trim();
  const firstUnmet = goal.successCriteria.findIndex((_, i) => !criteriaDone.has(i));
  const objectiveBrief = goal.objective.slice(0, 40);
  const continueNextAction = resumePoint
    || (firstUnmet >= 0
      ? `满足判据 [${firstUnmet}] ${goal.successCriteria[firstUnmet]}`
      : `为「${objectiveBrief}」产出下一条可核验证据`);
  const continueExpected = remaining > 0
    ? `下一轮至少新增 1 条可核验证据, 并推进剩余 ${remaining} 条判据中的至少 1 条`
    : `下一轮清掉未解决项 (${unresolvedItems.length} 项) 中的至少 1 项`;

  // ⓪ 时间不可信 → 交人 (保守方向: 不因一个坏时间戳就开轮)
  const nowMs = parseTs(now);
  if (!Number.isFinite(nowMs)) {
    return finalize({
      decision: 'ask_human',
      state: 'needs_decision',
      reason: `now 不是可解析的时间戳 ("${now}") → 时间不可信, 不做任何自动节奏判断`,
      nextAction: '等人给出可信时间戳 (或修好时钟) 后再决定是否继续',
      expectedOutcome: '一个可解析的 now (ISO-8601)',
      confidence: 0.2,
      riskLevel: 'high',
    }, ctx);
  }

  // ① Goal 已是终态 → 幂等 mirror (同一批事实重放, 结果一致)
  if (goal.status === 'completed') {
    return finalize({
      decision: 'complete',
      state: 'completed',
      reason: `goal.status 已是 completed (${evidenceRefs.length} 条证据, 判据 ${criteriaDone.size}/${goal.successCriteria.length}) → 终态不再起新 Run`,
      nextAction: '不再起新 Run; 需要继续就新建 Goal 或改判据 (改判据必须增版本号)',
      expectedOutcome: '无 (终态: 没有下一步产出)',
      confidence: 1,
      riskLevel: 'low',
    }, ctx);
  }
  if (goal.status === 'failed' || goal.status === 'abandoned') {
    const stopReason: StopReason = goal.status === 'failed' ? 'objective_unreachable' : 'out_of_scope';
    return finalize({
      decision: 'fail',
      state: 'failed',
      reason: `goal.status 已是 ${goal.status} → 判据不可能再满足 (stopReason=${stopReason})${goal.resolution?.reason ? `, 记录: ${goal.resolution.reason}` : ''}`,
      nextAction: `不再起新 Run; 保留 stopReason=${stopReason} 的事实, 交人决定撤销 / 改判据 / 改计划`,
      expectedOutcome: `无 (终态: stopReason=${stopReason})`,
      confidence: 1,
      riskLevel: 'medium',
      stopReason,
    }, ctx);
  }

  // ② 判据全满足: 过完成门才 complete, 否则问人 (不许"看着像完成"就完成)
  const runUnsettled = UNSETTLED_RUN_STATUSES.includes(String(run.status));
  const criteriaProposedUnconfirmed = goal.criteriaSource === 'agent_proposed' && goal.criteriaConfirmed !== true;
  const criteriaUntrusted = criteriaProposedUnconfirmed || goal.criteriaConfirmed === false;
  if (allCriteriaDone) {
    if (criteriaUntrusted) {
      return finalize({
        decision: 'ask_human',
        state: 'needs_decision',
        reason: `判据 ${criteriaDone.size}/${goal.successCriteria.length} 已全满足, 但判据${criteriaProposedUnconfirmed ? '是 agent 提的候选、未经人确认' : '未被确认'} → 不许判完成, 需人确认判据 (criteriaVersion=${goal.criteriaVersion ?? 1})`,
        nextAction: '等人确认判据 (确认后才会走完成门)',
        expectedOutcome: '人对判据的确认 (criteriaConfirmed=true)',
        confidence: 0.3,
        riskLevel: 'medium',
      }, ctx);
    }
    if (evidenceRefs.length === 0) {
      return finalize({
        decision: 'ask_human',
        state: 'needs_decision',
        reason: `判据 ${criteriaDone.size}/${goal.successCriteria.length} 已全满足, 但**一条证据都没有** → 不许判完成 (漂亮但无证据不算完成)`,
        nextAction: '等人确认要补哪些证据, 或指认哪条已有事实可作证据',
        expectedOutcome: '至少 1 条可核验证据引用 (路径 / 哈希 / 回执 / run 步骤号)',
        confidence: 0.3,
        riskLevel: 'medium',
      }, ctx);
    }
    if (!runUnsettled && unresolvedItems.length === 0) {
      return finalize({
        decision: 'complete',
        state: 'completed',
        reason: `判据 ${criteriaDone.size}/${goal.successCriteria.length} 全满足 + 证据 ${evidenceRefs.length} 条 + 无未解决项 + 最近 Run 状态 ${run.status} (已收干净) → 完成门通过`,
        nextAction: '不再起新 Run (目标已结束); 需要继续就新建 Goal 或改判据 (改判据必须增版本号)',
        expectedOutcome: '无 (终态: 没有下一步产出)',
        confidence: 1,
        riskLevel: 'low',
      }, ctx);
    }
    // 判据全满足但最近 Run 没跑干净 / 还有未解决项 → 不完成, 继续走下面的规则 (该重跑就重跑)
  }

  // ③ 三类硬底线 (安全线, 不是节奏): 命中即"必须停", 一律交人 ——— 不许自动开下一轮
  const breaker = isCount(hardLimits.noProgressCircuitBreaker) ? hardLimits.noProgressCircuitBreaker : 1;
  // ★ 2026-09-25 (P5 验收修复): 「本轮跑了多久」必须用**这一段 Run 自己的时长** ——
  //   已结束/已收干净的 Run 用它的最后一次写入 (`updatedAt` ≈ 结束时刻), **还在跑**的
  //   (`queued`/`running`/`failed`/`interrupted`/`stalled` = 没给出结束结论的) 才用 now。
  //   原来一律 `now - startedAt`: 只要上一次 Run 结束得早, 之后**任何一次等待**都会被算成
  //   "本轮超时" (等 wakeAt / 等外部事件 > 30min 尤其明显) → 事件到了也开不了下一轮,
  //   长等待永远醒不过来 (P5 ⑥ 实测)。安全线本身不动: **还在跑**的超长 Run 仍然照拦 (用 now 计龄)。
  // 缺/坏时间戳时退回 now (= 旧行为, 门禁只会更严不会更松)
  const runUpdatedMs = parseTs(run.updatedAt);
  const runActive = runUnsettled || RUN_ACTIVE_STATUSES.includes(String(run.status));
  const runEndMs = runActive || !Number.isFinite(runUpdatedMs) ? nowMs : runUpdatedMs;
  const runElapsedMs = runEndMs - parseTs(run.startedAt);
  if (isPosFinite(hardLimits.maxRunDurationMs) && Number.isFinite(runElapsedMs) && runElapsedMs > hardLimits.maxRunDurationMs) {
    return finalize({
      decision: 'ask_human',
      state: 'needs_decision',
      reason: `本轮已超出单 Run 时间上限 (${runElapsedMs}ms > ${hardLimits.maxRunDurationMs}ms, 从 ${run.startedAt} 到 ${runActive ? now : run.updatedAt}${runActive ? ' (仍在跑)' : ' (已结束)'}) → 硬底线是安全线: 不许自动开下一轮`,
      nextAction: '等人决定: 放宽单 Run 时间上限 / 拆小目标 / 改计划后再开新 Run',
      expectedOutcome: '人对单 Run 时间上限的一个取舍',
      confidence: 0.3,
      riskLevel: 'high',
    }, ctx);
  }
  const maxRuns = goal.budget?.maxRuns;
  if (isCount(maxRuns) && (goal.runs?.length ?? 0) >= maxRuns) {
    return finalize({
      decision: 'ask_human',
      state: 'blocked',
      reason: `单 Goal 预算用尽: 已跑 ${goal.runs?.length ?? 0} 个 Run, 达到 budget.maxRuns=${maxRuns} (硬底线)`,
      nextAction: '等人追加预算 (扩预算不许 Agent 自动批) 或缩小范围',
      expectedOutcome: '人对预算的一个取舍 (追加 / 缩小范围 / 终止)',
      confidence: 0.3,
      riskLevel: 'high',
    }, ctx);
  }
  const deadlineMs = goal.budget?.deadlineMs;
  const goalElapsedMs = nowMs - parseTs(goal.createdAt);
  if (isPosFinite(deadlineMs) && Number.isFinite(goalElapsedMs) && goalElapsedMs > deadlineMs) {
    return finalize({
      decision: 'ask_human',
      state: 'blocked',
      reason: `单 Goal 预算用尽: 已过 ${goalElapsedMs}ms, 超过 budget.deadlineMs=${deadlineMs}ms (硬底线)`,
      nextAction: '等人决定: 延长 deadline / 缩小范围 / 终止目标',
      expectedOutcome: '人对 deadline 的一个取舍',
      confidence: 0.3,
      riskLevel: 'high',
    }, ctx);
  }
  if (!hasProgress && noProgressStreak >= breaker) {
    return finalize({
      decision: 'ask_human',
      state: 'no_progress',
      reason: `连续 ${noProgressStreak} 个 Run 无新证据 / 无新判据, 达到无进展熔断阈值 ${breaker} → 熔断, 不许再自动跑 (第几轮本来就不是继续的依据)`,
      nextAction: '等人决定: 改判据 / 改计划 / 补条件 / 撤销目标, 并说明下一轮该产出什么证据',
      expectedOutcome: '人给出的一个方向性取舍 (不是"再跑一轮看看")',
      confidence: 0.3,
      riskLevel: 'high',
    }, ctx);
  }

  // ④ Supervisor 已判失速 (goal.status='stalled')
  if (goal.status === 'stalled') {
    return finalize({
      decision: 'ask_human',
      state: 'no_progress',
      reason: `goal.status 已是 stalled (Supervisor 已判失速), 本轮新增证据 ${progress.newEvidence.length} 条 / 新判据 ${progress.newlyCompletedCriteria.length} 条`,
      nextAction: '等人决定终止 / 改判据 / 补条件后重开',
      expectedOutcome: '人对失速目标的一个取舍',
      confidence: 0.3,
      riskLevel: 'high',
    }, ctx);
  }

  // ⑤ 不可恢复的 Run 失败 (错误分类表: 这几种不是"这次没跑好")
  const errorClass = run.errorClass;
  if (run.status === 'failed' && errorClass && PERMISSION_FAILURES.includes(String(errorClass))) {
    return finalize({
      decision: 'ask_human',
      state: 'blocked',
      reason: `Run 因 ${errorClass} 失败 (缺权限/被策略拒绝): 不重试也跑不动, 人不补权限则永远停在这里`,
      nextAction: '等人补齐权限 / 解除策略限制后再开新 Run',
      expectedOutcome: '权限到位后重跑同一个子目标',
      confidence: 0.4,
      riskLevel: 'high',
    }, ctx);
  }
  if (run.status === 'failed' && errorClass === 'persist_failed') {
    return finalize({
      decision: 'fail',
      state: 'failed',
      reason: `核心状态写不进盘 (errorClass=persist_failed): 这次运行在事实层面不存在 → 继续也改变不了结果`,
      nextAction: '不再起新 Run; 先修存储/权限问题, 交人决定是否重开目标',
      expectedOutcome: '无 (终态: stopReason=objective_unreachable)',
      confidence: 1,
      riskLevel: 'medium',
      stopReason: 'objective_unreachable',
    }, ctx);
  }
  if (run.status === 'failed' && errorClass === 'repeat_failure') {
    return finalize({
      decision: 'ask_human',
      state: 'needs_decision',
      reason: 'Run 因 repeat_failure 失败 (同一问题反复失败, 已熔断): 再自动重试只是重复消耗',
      nextAction: '等人决定换方法 / 换执行者 / 改判据 / 终止',
      expectedOutcome: '人给出的换法方向 (不是"再试一次")',
      confidence: 0.3,
      riskLevel: 'high',
    }, ctx);
  }

  // ⑥ 等外部 / 等时间 / 等子 Agent → wait (由事件或 wakeAt 唤醒)
  const waitingOnDelegate = goal.continuation?.external?.expectedSource === 'delegate';
  const waiting = run.status === 'awaiting_external'
    || goal.status === 'awaiting_external'
    || goal.status === 'retry_wait'
    || (run.status === 'failed' && errorClass === 'external_no_reply');
  if (waiting) {
    const wakeAt = goal.continuation?.wakeAt ?? null;
    const needsExternal = goal.continuation?.needsExternal ?? null;
    const what = waitingOnDelegate
      ? `等子 Agent 回报 (work 未回, 由它回报后唤醒)`
      : needsExternal
        ? `等外部回应 (${needsExternal})`
        : wakeAt
          ? `等到 ${wakeAt} 再跑`
          : '等外部事件 (没有 wakeAt, 只能由事件唤醒)';
    return finalize({
      decision: 'wait',
      state: waitingOnDelegate ? 'waiting_agent' : 'waiting_external',
      reason: `本轮在等外部: run.status=${run.status} / goal.status=${goal.status}${errorClass ? ` / errorClass=${errorClass}` : ''}; ${what}${wakeAt ? `, wakeAt=${wakeAt}` : ''}`,
      nextAction: `${what}${resumePoint ? `; 唤醒后从 "${resumePoint}" 继续` : ''}`,
      expectedOutcome: '收到对应的外部回应或到点唤醒, 然后开下一轮',
      confidence: 0.7,
      wakeAt,
      riskLevel: 'low',
    }, ctx);
  }

  // ⑦ 人主动暂停 (不是自动决策)
  if (goal.status === 'paused' || run.status === 'paused') {
    return finalize({
      decision: 'pause',
      state: 'waiting_external',
      reason: `人主动暂停 (goal.status=${goal.status} / run.status=${run.status}) → 只有用户 resume 才会继续, 不自动唤醒`,
      nextAction: '等用户 resume (paused 不是自动决策, 也不由本判定器解除)',
      expectedOutcome: '用户 resume 后开下一轮',
      confidence: 1,
      riskLevel: 'low',
    }, ctx);
  }

  // ⑧ 目标等人
  if (goal.status === 'needs_human') {
    return finalize({
      decision: 'ask_human',
      state: 'needs_decision',
      reason: `goal.status=needs_human (等人 approve / 取舍)${goal.continuation?.wakeReason ? `, wakeReason=${goal.continuation.wakeReason}` : ''}${goal.continuation?.needsExternal ? `, 等: ${goal.continuation.needsExternal}` : ''}`,
      nextAction: '等人给出判据 / 预算 / 权限 / 取舍上的决定, 再开下一轮',
      expectedOutcome: `人给出的一个决定 (${goal.continuation?.needsExternal ?? '判据 / 预算 / 权限 / 取舍'})`,
      confidence: 0.3,
      riskLevel: 'medium',
    }, ctx);
  }

  // ⑨ 有可核验进展 → 继续 (唯一有资格"继续"的东西)
  if (hasProgress) {
    const strong = progress.newEvidence.length > 0 && progress.newlyCompletedCriteria.length > 0;
    return finalize({
      decision: 'continue',
      state: 'progressing',
      reason: `本轮有可核验进展: 新增证据 ${progress.newEvidence.length} 条, 新满足判据 [${progress.newlyCompletedCriteria.join(', ')}] (剩余 ${remaining} 条判据, 未解决项 ${unresolvedItems.length} 项) → 直接开下一轮`,
      nextAction: continueNextAction,
      expectedOutcome: continueExpected,
      confidence: strong ? 0.95 : 0.85,
      riskLevel: strong && unresolvedItems.length === 0 ? 'low' : 'medium',
    }, ctx);
  }

  // ⑩ 目标声明了未就绪的必需能力 → delegate (下一步该派给具备该能力的执行者)
  //    '?' 前缀 = 可选, 不构成必需能力 (goal-store: "前缀 '?' = 可选")
  const requiredSkills = (goal.requiredSkills ?? []).filter((s) => !s.startsWith('?'));
  const frozenSkills = new Set((goal.skillSnapshot ?? []).map((s) => s.name));
  const missingCapability = requiredSkills.find((s) => !frozenSkills.has(s));
  if (missingCapability) {
    return finalize({
      decision: 'delegate',
      state: 'waiting_agent',
      reason: `本轮没有新证据 (新增证据 0 条 / 新判据 0 条, 未达熔断阈值 ${breaker}), 且目标声明的必需能力「${missingCapability}」不在本节点已冻结的技能快照里 → 继续也改变不了结果, 该派活`,
      nextAction: `签 AgentWorkContract: 把需要「${missingCapability}」的单一子目标派给具备该能力的执行者 (限工具 + 预算上限 + 成功判据 + 必带证据)`,
      expectedOutcome: `带回符合 reportSchema 的结构化回报 (含逐条证据), 覆盖能力「${missingCapability}」`,
      confidence: 0.6,
      requiredCapability: missingCapability,
      riskLevel: 'medium',
    }, ctx);
  }

  // ⑪ 以上都不成立: 本轮没有新证据 → 不许自动继续 (没有证据就没有继续的资格)
  const criteriaHint = allCriteriaDone
    ? `; 判据 ${criteriaDone.size}/${goal.successCriteria.length} 已全满足, 但完成门不放行 (最近 Run 状态 ${run.status}${runUnsettled ? ' (没跑干净)' : ''}, 未解决项 ${unresolvedItems.length} 项) → 也不许自动继续`
    : '';
  return finalize({
    decision: 'ask_human',
    state: 'needs_decision',
    reason: `本轮没有新的可核验证据 / 新满足判据 (stepsAdvanced=${progress.stepsAdvanced} 不算进展), 无进展 ${noProgressStreak} 轮 < 熔断阈值 ${breaker} → 没有"继续"的资格, 需人定夺${criteriaHint}`,
    nextAction: '等人确认是否值得再跑一轮, 并指定下一轮必须产出什么证据',
    expectedOutcome: '人指定的一条可核验证据 (路径 / 哈希 / 回执 / run 步骤号)',
    confidence: 0.3,
    riskLevel: 'medium',
  }, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 P0-2: applyHardLimits (只能收紧)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把三类硬底线套到一条决策上 —— **只能收紧, 永不放开**:
 *   - 非自治决策 (`wait` / `ask_human` / `pause` / `complete` / `fail`) 原样返回 (对象同一引用);
 *   - 自治决策 (`continue` / `delegate`) 只要命中一条"安全线不可用", 就降级为 `ask_human`,
 *     并且 `riskLevel` 只许往上抬, `wakeAt` / `requiredCapability` 清空 (不再自动跑, 也不派遣)。
 *
 * "安全线不可用" 的判据 (每一条都是"没有它就不该自动继续"):
 *   1. `continue` 自称自治, 但 `progressDelta` 里没有任何新证据 / 新判据
 *      (禁止用轮次/时长/步数冒充进展) —— 只对 `continue` 生效: `delegate` 的资格来自
 *      "缺能力", 它本来就不需要进展证据;
 *   2. `noProgressCircuitBreaker` 不是 >=1 的整数 (熔断阈值未定义);
 *   3. `maxRunDurationMs` 不是正有限数 (单 Run 时间上限未定义);
 *   4. `maxGoalBudget === null` (未设上限 → **必须由人显式确认**, 见 types.ts §1) 或非法。
 */
export function applyHardLimits(d: ContinuationDecision, limits: HardLimits): ContinuationDecision {
  if (!isAutonomous(d.decision)) return d;

  const blockedBy: string[] = [];
  if (d.decision === 'continue' && !hasVerifiableProgress(d.progressDelta)) {
    blockedBy.push('决策自称 continue 但 progressDelta 里没有新证据/新判据 (禁止用轮次/时长/步数冒充进展)');
  }
  if (!isCount(limits.noProgressCircuitBreaker)) {
    blockedBy.push(`无进展熔断阈值未定义 (${String(limits.noProgressCircuitBreaker)}: 需要 >=1 的整数)`);
  }
  if (!isPosFinite(limits.maxRunDurationMs)) {
    blockedBy.push(`单 Run 时间上限未定义 (${String(limits.maxRunDurationMs)}: 需要正的有限毫秒数)`);
  }
  if (limits.maxGoalBudget === null) {
    blockedBy.push('未设单 Goal 预算上限 → 必须由人显式确认才能继续');
  } else if (!isPosFinite(limits.maxGoalBudget)) {
    blockedBy.push(`单 Goal 预算上限非法 (${String(limits.maxGoalBudget)})`);
  }
  if (blockedBy.length === 0) return d;

  return {
    ...d,
    decision: 'ask_human',
    state: 'needs_decision',
    reason: `${d.reason} | 硬底线收紧: ${blockedBy.join('; ')}`,
    nextAction: '等人确认预算上限 / 时间上限 / 熔断阈值, 以及本决策是否值得继续',
    expectedOutcome: '人对硬底线的一个确认 (设上限 / 降范围 / 终止)',
    wakeAt: null,
    requiredCapability: null,
    riskLevel: bumpRisk(d.riskLevel),
    stopReason: null,
    // confidence 不变: 收紧是"资格"问题, 不是"信心"问题; 而 ask_human 本身不因信心放行
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 P0-3: isRunnable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这条决策"现在能不能直接起下一轮" —— 最后一道路闸, 只回答 yes/no + 结构化 reason。
 *
 * 拒绝的情形 (每一条都对应类型面的一句硬规则):
 *   - `now` 不可解析 (时间不可信) · `confidence` 越界 (决策不完整)
 *   - `decision` 与 `state` 不自洽 (types.ts §1: 两者必须自洽)
 *   - 终态 `complete` / `fail`: 不再起新 Run
 *   - `pause` / `ask_human`: 等人, 不自动继续
 *   - `delegate` 缺 `requiredCapability` 或缺 `nextAction`: 决策不完整, 不许派遣
 *   - `continue` / `delegate` 信心 < 0.5: "低信心不是可以忽略, 是该问人"
 *   - `wait`: `wakeAt === null` = 等事件 (不按时间跑); `wakeAt` 已到 = 可以跑; 未到 = 不跑
 */
export function isRunnable(d: ContinuationDecision, now: IsoTimestamp): { runnable: boolean; reason: string } {
  const no = (reason: string) => ({ runnable: false, reason });

  const nowMs = parseTs(now);
  if (!Number.isFinite(nowMs)) return no(`now 不可解析 ("${now}"): 时间不可信 → 不自动继续`);

  if (typeof d.confidence !== 'number' || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) {
    return no(`confidence 越界 (${String(d.confidence)}): 决策不完整 → 不自动继续`);
  }

  const allowed = (DECISION_STATES as Record<string, readonly ContinuationState[] | undefined>)[d.decision];
  if (!allowed) return no(`未知 decision (${String(d.decision)}): 不自动继续`);
  if (!allowed.includes(d.state)) {
    return no(`decision=${d.decision} 与 state=${d.state} 不自洽: 不自动继续`);
  }

  switch (d.decision) {
    case 'complete':
      return no('目标已完成: 不再起新 Run');
    case 'fail':
      return no(`目标判为不可达 (stopReason=${d.stopReason ?? '缺失'}): 不再起新 Run`);
    case 'pause':
      return no('人主动暂停: 等用户 resume, 不自动继续');
    case 'ask_human':
      return no(`需要人决定 (state=${d.state}): 不自动继续`);
    case 'delegate': {
      const cap = (d.requiredCapability ?? '').trim();
      if (!cap) return no('delegate 缺 requiredCapability: 决策不完整 → 不派遣');
      if (d.confidence < LOW_CONFIDENCE) return no(`delegate 信心 ${d.confidence} < ${LOW_CONFIDENCE}: 低信心该问人, 不派遣`);
      if (!d.nextAction.trim()) return no('delegate 缺 nextAction: 决策不完整 → 不派遣');
      return { runnable: true, reason: `可派遣: 需要能力「${cap}」` };
    }
    case 'continue': {
      if (d.confidence < LOW_CONFIDENCE) return no(`continue 信心 ${d.confidence} < ${LOW_CONFIDENCE}: 低信心该问人, 不自动继续`);
      if (!d.nextAction.trim()) return no('continue 缺 nextAction (下一步做什么): 决策不完整 → 不自动继续');
      return { runnable: true, reason: '有可核验进展: 可直接开下一个 Run' };
    }
    case 'wait': {
      if (d.wakeAt === null) return no(`等外部/等子 Agent (state=${d.state}), 没有 wakeAt: 只能由事件唤醒, 不自动继续`);
      const wakeMs = parseTs(d.wakeAt);
      if (!Number.isFinite(wakeMs)) return no(`wakeAt 不可解析 ("${d.wakeAt}"): 不自动继续`);
      if (wakeMs <= nowMs) return { runnable: true, reason: `唤醒时间已到 (wakeAt=${d.wakeAt}): 可以起下一轮` };
      return no(`未到唤醒时间 (wakeAt=${d.wakeAt}, 还差 ${wakeMs - nowMs}ms)`);
    }
    default:
      return no(`未处理的 decision (${String(d.decision)}): 不自动继续`);
  }
}
