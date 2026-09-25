/**
 * wiring/continuation.ts — 接缝 ①「这个 Goal 现在该不该开下一轮, 为什么?」  (**M1 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'continuation'`, `stage: 'M1'`。
 * M1 只准改本文件 + 本接缝声明的 `wiringPoints` (`goal-flywheel/continuation-decision.ts`)。
 *
 * ## 这条接缝钉住的冻结规则
 *
 * **只有 Supervisor 能决定是否继续** (规则 ①)。
 * 钉法不是文档, 是**调用方必须显式声明身份**: 接缝的入口 `preflight()` 要一个
 * `caller` 字段, 非 `supervisor` 一律拒绝。于是"Runner 自己觉得还能再跑一轮"这种
 * 绕过在类型上就写不出来, 在运行时会拿到一条结构化拒绝。
 *
 * ## M1 的实质: 自适应节奏 —— 固定轮次降级为**安全上限**
 *
 * 接缝不再是把注入的结论原样转出去, 它自己把 P0 编起来 (P0 = 本阶段自己的实现模块
 * `../continuation-decision.js`, 见 `seams.ts` 头部的接缝形态第 ③ 条):
 *
 * ```
 * 事实 (goal + run + progress + noProgressStreak)
 *   → decideContinuation        (节奏: 有没有**新的可核验证据**)
 *   → applyHardLimits           (三类上限: 只能收紧, 永不放开)
 *   → isRunnable                (最后一道路闸)
 *   → 归因: 是「进展」在说话, 还是「哪一条上限」在说话
 * ```
 *
 * 三类安全上限 (设计稿 §4, 字面登记在 `SAFETY_CAPS`): **单 Run 时间 · 单 Goal 预算 ·
 * 无进展熔断阈值**。它们只回答"什么时候必须停", **不回答"什么时候继续"**。
 * 每一条都交给 P0 去执行 (接缝不自己数任何计数): 时间与熔断阈值 P0 直接吃 `hardLimits`;
 * 「单 Goal 预算」P0 走的是 Goal 自己的预算口径, 所以这里把降级来的上限**投影**成那个口径
 * (`factsWithBudgetCap`), 而不是在同一份事实上再判一遍。
 * 旧配置里的固定轮次 (`maxRounds` / `maxRetries`) 在 `safetyCapsFrom()` 里被**登记成**
 * 这两条上限 (总 Run 数 / 熔断阈值) —— 于是"第几轮"再也不能自己决定停或不停:
 * 只有上限真的触顶它才说话, 有进展就继续。P0 本身根本不读轮次, 本文件也不读。
 *
 * ## 归因怎么做: 反事实, 不抄一遍逻辑
 *
 * "哪条上限在说话"不是本文件用几个 `if` 重新推一遍 (那就成了两套事实), 而是**拿 P0 自己当判据**:
 * 把某条上限放宽后**结论变了**, 说明是它在决定 (`bindingCaps`)。放宽了结论也不变 = 这次停跟它无关
 * (是"没有继续的资格"/终态/等人), 于是不会被错记成"被上限拦住"。
 * 上限**没定义** (例如 `maxGoalBudget === null`) 也算它在说话 —— `applyHardLimits` 会收紧成交人,
 * 而放宽后那条收紧理由会消失, 反事实照样抓得到。
 *
 * ## 事实从哪来 (接缝自己不读盘)
 *
 *   · `deps.readFacts` (规范口径): **只读事实, 不判定** —— 判定由本接缝用 P0 做, 全量决策随结果返回;
 *   · `deps.decide` (旧口径): 接线层注入的整条判定结论。事实拿不到时的兜底, 只能核验
 *     **无进展熔断**这一条上限 (其余上限没有事实就没法核验 → 如实标 `unattributableStop`, 不假装验过;
 *     自称的上限若与阈值对不上 → **真拒**, 见 `judgeInjectedOutcome`)。
 *
 * 本文件**不读盘、不读钟**: `now` 由调用方注入。
 */

import { applyHardLimits, decideContinuation, isRunnable, type DecideContinuationInput } from '../continuation-decision.js';
import { refuse, stripBlockComments, type SeamRefusal, type WiringCaller } from './seams.js';
import type {
  ContinuationDecision,
  ContinuationDecisionKind,
  ContinuationState,
  HardLimits,
  IsoTimestamp,
  ProgressDelta,
  StopReason,
} from '../types.js';

export const CONTINUATION_SEAM_ID = 'continuation' as const;

// ============================================================================
// §1. 三类安全上限: 固定轮次在这里被降级
// ============================================================================

/** 三类安全上限的机器名 (设计稿 §4 的"保留三类硬底线") */
export const SAFETY_CAPS = ['max_run_duration', 'goal_budget', 'no_progress_breaker'] as const;
export type SafetyCap = (typeof SAFETY_CAPS)[number];

export const SAFETY_CAP_TEXT: Record<SafetyCap, string> = {
  max_run_duration: '单 Run 时间上限',
  goal_budget: '单 Goal 预算上限 (总 Run 数)',
  no_progress_breaker: '无进展熔断阈值',
};

/** 接缝自己的上限默认值 (与接线层 M0 同一口径; 接缝不 import 接线层, 所以在这里登记一份) */
export const SEAM_CAP_DEFAULTS = {
  maxRunDurationMs: 30 * 60_000,
  maxGoalBudget: 50,
  noProgressCircuitBreaker: 3,
} as const;

/** 旧节奏配置 (固定轮次时代的旋钮) —— 它们只当上限用 */
export interface LegacyRhythmConfig {
  /** 旧的"第 N 轮就停" → 降级为「单 Goal 预算上限」(总 Run 数) */
  maxRounds?: number | null;
  /** 运输层的 retry 上限 → 降级为「无进展熔断阈值」(阈值 = maxRetries + 1) */
  maxRetries?: number | null;
  /** 单 Run 时间上限 (本来就是安全线; 调用方可把 Run 自己的 deadline 传进来) */
  maxRunDurationMs?: number | null;
  /** 显式上限 (最后覆盖; `maxGoalBudget: null` = 未设上限 → 必须由人确认, 这是显式语义) */
  limits?: Partial<HardLimits> | null;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
const isZeroOrCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isPosFinite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * 旧配置 → 三类安全上限。**这是"固定轮次降级"的唯一实现处**。
 *
 * 降级不是"少看一眼", 而是**换一件事管**: 轮次从"继续/停止的依据"变成"总 Run 数的上限"。
 * 于是旧配置的语义被保住 (跑不到第 N 轮以上), 但节奏改由进展决定。
 */
export function safetyCapsFrom(config: LegacyRhythmConfig = {}): HardLimits {
  let maxRunDurationMs: number = SEAM_CAP_DEFAULTS.maxRunDurationMs;
  let maxGoalBudget: number | null = SEAM_CAP_DEFAULTS.maxGoalBudget;
  let noProgressCircuitBreaker: number = SEAM_CAP_DEFAULTS.noProgressCircuitBreaker;

  // 旧的固定轮次 → 单 Goal 预算上限 (Run 数上限)
  if (isCount(config.maxRounds)) maxGoalBudget = config.maxRounds;
  // 运输层的 maxRetries → 无进展熔断阈值 (与 M0 `hardLimitsFor` 同口径: 阈值 = maxRetries + 1)
  if (isZeroOrCount(config.maxRetries)) noProgressCircuitBreaker = Math.max(1, config.maxRetries + 1);
  if (isPosFinite(config.maxRunDurationMs)) maxRunDurationMs = config.maxRunDurationMs;

  const explicit = config.limits;
  if (explicit) {
    // 只有 `undefined` 算"没说"; `null` 是显式语义 (未设上限 → applyHardLimits 会收紧成交人), 不许被默认值盖掉
    if (explicit.maxRunDurationMs !== undefined) maxRunDurationMs = explicit.maxRunDurationMs;
    if (explicit.maxGoalBudget !== undefined) maxGoalBudget = explicit.maxGoalBudget;
    if (explicit.noProgressCircuitBreaker !== undefined) noProgressCircuitBreaker = explicit.noProgressCircuitBreaker;
  }
  return { maxRunDurationMs, maxGoalBudget, noProgressCircuitBreaker };
}

// ============================================================================
// §2. 节奏管线 (纯函数): 判定 → 收紧 → 放行 + 上限归因 (反事实)
// ============================================================================

/**
 * 事实面 = P0 的入参**去掉 `hardLimits`**。
 * 上限不由调用方夹带: 它们必须经 `safetyCapsFrom()` 从旧配置/显式配置降级得到 ——
 * 否则"上限"与"节奏"又能被两个地方各设一套。
 */
export type RhythmFacts = Omit<DecideContinuationInput, 'hardLimits'>;

/** 放宽后的取值: 大到事实上不可能触顶, 但仍是合法上限 (P0 对上限合法性有判据: 正有限数 / >=1 的整数) */
const RELAXED_LIMIT = Number.MAX_SAFE_INTEGER;

/** 上限的**事实层来源**: Goal 自带的 `budget` (maxRuns / deadlineMs) 也是「单 Goal 预算上限」 */
function relaxFactSource(facts: RhythmFacts, cap: SafetyCap): RhythmFacts {
  return cap === 'goal_budget' ? { ...facts, goal: { ...facts.goal, budget: undefined } } : facts;
}

/** 放宽这一条上限 (其余保持不变) */
function capsRelaxingOne(caps: HardLimits, cap: SafetyCap): HardLimits {
  const out: HardLimits = { ...caps };
  if (cap === 'max_run_duration') out.maxRunDurationMs = RELAXED_LIMIT;
  else if (cap === 'goal_budget') out.maxGoalBudget = RELAXED_LIMIT;
  else out.noProgressCircuitBreaker = RELAXED_LIMIT;
  return out;
}

/**
 * 把「单 Goal 预算上限」用 **P0 听得懂的口径**表达出来, 而不是在接缝里自己数 Run。
 *
 * 为什么不在接缝里数: 轮次数只有 P0 的预算法则会判 (它读 Goal 自带的 `budget.maxRuns` + Run 列表),
 * 接缝再数一遍就是**第二套事实** —— 而且那正是"用轮次当节奏"的老毛病 (本文件的源码判据也不允许)。
 * 所以这里只做一件事: 把降级来的上限投影成 Goal 的预算口径, 判定仍然只有 P0 那一个出口。
 *
 * 优先级 (与 M0 `hardLimitsFor` 同口径: "Goal 自己声明了预算就用它, 否则退回默认上限"):
 *   · Goal **声明**了 `budget.maxRuns` → 用它 (人的意图优先于旧配置; 要让上限更严就改 Goal 的预算,
 *     那是人的取舍, 见 P4 规则 2 "扩/改预算不许 Agent 自动批");
 *   · Goal 没声明 → 用上限里的 `maxGoalBudget` (旧 maxRounds 降级来的, 或默认 50) —— 它**真的能停**;
 *   · `maxGoalBudget === null` (未设上限) → **不投影**: 那种情况由 `applyHardLimits` 收紧成交人。
 */
function factsWithBudgetCap(facts: RhythmFacts, caps: HardLimits): RhythmFacts {
  const declared = facts.goal.budget?.maxRuns;
  const cap = caps.maxGoalBudget;
  const usable = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined;
  const effective: number | undefined = typeof declared === 'number' ? declared : usable;
  if (effective === undefined || effective === declared) return facts; // 事实已经表达了这条上限
  return { ...facts, goal: { ...facts.goal, budget: { ...(facts.goal.budget ?? {}), maxRuns: effective } } };
}

/** 本接缝的节奏管线: **唯一的决策出口** (纯函数, 同一批事实重放得到同一条决策) */
export function rhythmicDecision(facts: RhythmFacts, caps: HardLimits): ContinuationDecision {
  return applyHardLimits(decideContinuation({ ...factsWithBudgetCap(facts, caps), hardLimits: caps }), caps);
}

/**
 * 决策的**结论投影**: 除 `reason` 之外的一切。
 *
 * 为什么把 `reason` 排除掉: P0 的理由文本里嵌着上限的**真值** (熔断阈值 / 毫秒数 / Run 数),
 * 拿它做比对会把"数字变了"当成"结论变了" —— 于是没触顶的上限也被记成在说话 (实测踩过)。
 * 结论投影只看真正决定行为的字段: decision / state / nextAction / wakeAt / requiredCapability /
 * riskLevel / stopReason / confidence … 上限真的在说话时, 这些里至少有一个会变。
 */
function verdictOf(d: ContinuationDecision): string {
  return JSON.stringify({ ...d, reason: null });
}

/**
 * 哪几条安全上限**真的在决定结论** (触顶 + 起决定作用; 触顶但被别条覆盖的不算)。
 *
 * 判据是**反事实**, 不是本文件手算一遍 (手算就是第二套事实):
 *   把这一条上限 (连它的事实层来源) 放宽 → **结论投影变了** ⟹ 是它在说话;
 *   结论没变 ⟹ 这次停跟它无关 (可能压根没触顶, 也可能被更靠前的规则先拦下了)。
 *
 * 于是"上限没定义"也被算成它在说话 (`maxGoalBudget: null` → `applyHardLimits` 收紧成交人;
 * 放宽后那条收紧理由消失, 结论就变了), 而"没有继续的资格"(⑪) 永远不会被错记成"被上限拦住"。
 * 顺序 = P0 的判定顺序 (单 Run 时间 → 单 Goal 预算 → 无进展熔断)。
 */
export function bindingCaps(facts: RhythmFacts, caps: HardLimits): SafetyCap[] {
  const base = verdictOf(rhythmicDecision(facts, caps));
  const out: SafetyCap[] = [];
  for (const cap of SAFETY_CAPS) {
    if (verdictOf(rhythmicDecision(relaxFactSource(facts, cap), capsRelaxingOne(caps, cap))) !== base) out.push(cap);
  }
  return out;
}

/** 主节奏依据 (调用方/用户可见态要的是"为什么", 不是一串内部状态) */
export type RhythmBasis = 'progress' | 'delegate' | 'wait' | 'cap' | 'human' | 'terminal';

export const RHYTHM_BASIS_TEXT: Record<RhythmBasis, string> = {
  progress: '有可核验进展',
  delegate: '缺能力该派活',
  wait: '等外部 / 等事件',
  cap: '安全上限触顶',
  human: '没有继续的资格 (交人定夺)',
  terminal: '终态 (完成 / 不可达)',
};

function basisOf(d: ContinuationDecision, caps: readonly SafetyCap[]): RhythmBasis {
  if (d.decision === 'complete' || d.decision === 'fail') return 'terminal';
  if (d.decision === 'wait' || d.decision === 'pause') return 'wait';
  if (caps.length > 0) return 'cap';
  if (d.decision === 'continue') return 'progress';
  if (d.decision === 'delegate') return 'delegate';
  return 'human';
}

export interface RhythmPlan {
  goalId: string;
  /** P0 的**完整**决策 (字段齐全; 不做有损投影 —— 调用方要 wakeAt / nextAction / riskLevel 都有) */
  decision: ContinuationDecision;
  /** 现在能不能直接起下一轮 (isRunnable) */
  runnable: boolean;
  /** P0 的判定理由 (为什么是这个结论; 内含上限真值, 便于审计) */
  decisionReason: string;
  /** isRunnable 的放行理由 (能不能直接开下一轮) */
  runnableReason: string;
  basis: RhythmBasis;
  /** 真的在说话的安全上限 (可能多条, 按 P0 的判定顺序) */
  caps: SafetyCap[];
  /** 第一条说话的上限 (P0 先命中先返回, 所以它就是"主因") */
  bindingCap: SafetyCap | null;
  /** 本次生效的三类上限 (可审计: 旧配置被降级成了什么) */
  capsInEffect: HardLimits;
  noProgressStreak: number;
}

/**
 * 这个 Goal 现在该不该开下一轮 —— **纯函数版** (接缝的 `preflight` 与宿主都可直接用)。
 * 决策只来自 P0; 上限只来自 `safetyCapsFrom` 的降级结果。
 */
export function planRhythm(facts: RhythmFacts, config: LegacyRhythmConfig = {}): RhythmPlan {
  const capsInEffect = safetyCapsFrom(config);
  const decision = rhythmicDecision(facts, capsInEffect);
  const gate = isRunnable(decision, facts.now);
  const caps = bindingCaps(facts, capsInEffect);
  return {
    goalId: facts.goal.goalId,
    decision,
    runnable: gate.runnable,
    decisionReason: decision.reason,
    runnableReason: gate.reason,
    basis: basisOf(decision, caps),
    caps,
    bindingCap: caps[0] ?? null,
    capsInEffect,
    noProgressStreak: facts.noProgressStreak,
  };
}

// ============================================================================
// §3. 「轮次不许当节奏」的裁决 (旧结论 vs 事实算出的节奏)
// ============================================================================

export interface LegacyStopClaim {
  runnable: boolean;
  reason: string;
}

export interface LegacyStopJudgement {
  /** 最终该不该停 */
  stop: boolean;
  /** 旧结论的"停"被推翻了 (有进展 / 上限没触顶) */
  overridden: boolean;
  reason: string;
}

/**
 * 一个**自称停**的旧结论 (例如运输层的"已到最大轮次 → 交人") 该不该被采纳。
 *
 * 规则 (与设计稿 §4 逐条对应):
 *   · 上限触顶 / 终态 / 等外部 → 停得住 (上限是安全线, 该停就停);
 *   · 有可核验进展且三类上限一条都没触顶 → **推翻旧结论, 继续** (轮次不再是停止依据);
 *   · 其余 (没有继续的资格, basis='human') → 照旧停, 理由是"没证据", 不是"第几轮"。
 */
export function judgeLegacyStop(claim: LegacyStopClaim, plan: RhythmPlan): LegacyStopJudgement {
  if (claim.runnable) return { stop: false, overridden: false, reason: claim.reason };
  if (plan.basis === 'terminal' || plan.basis === 'wait') {
    return { stop: true, overridden: false, reason: `停得住 (${RHYTHM_BASIS_TEXT[plan.basis]}): ${claim.reason}` };
  }
  if (plan.caps.length > 0) {
    return {
      stop: true,
      overridden: false,
      reason: `停得住 (安全上限触顶: ${plan.caps.map((c) => SAFETY_CAP_TEXT[c]).join(' + ')}): ${claim.reason}`,
    };
  }
  if (plan.basis === 'progress' && plan.runnable) {
    return {
      stop: false,
      overridden: true,
      reason: `旧结论「${claim.reason}」被推翻: 本轮有可核验进展, 且三类安全上限一条都没触顶 `
        + '→ 继续 (轮次/时长不是停止依据, 只有上限能停)',
    };
  }
  return {
    stop: true,
    overridden: false,
    reason: `停得住 (${RHYTHM_BASIS_TEXT[plan.basis]}): ${claim.reason}`,
  };
}

// ============================================================================
// §4. 接缝本体 (对外形态保持不变: 调用方仍拿到 goalId/runnable/reason/decision)
// ============================================================================

/** 判定结论的最小面 (与 GoalStepDecision 同口径, 但**不 import** 接线层, 避免耦合) */
export interface GoalStepOutcome {
  goalId: string;
  runnable: boolean;
  reason: string;
  noProgressStreak: number;
  decision: {
    decision: ContinuationDecisionKind;
    state: ContinuationState;
    nextAction: string;
    requiredCapability: string | null;
    decisionId: string;
  } | null;
  /** 注入方**自称**触顶的安全上限 (可核验的只有无进展熔断, 见 `judgeInjectedOutcome`) */
  caps?: readonly SafetyCap[];
  /** 主动要求停止的理由 (决策器给出的原话) */
  stopReason?: StopReason | null;
  /** 本轮进展 (给了它才能核验"有进展就不停") */
  progress?: ProgressDelta | null;
}

/** preflight 的结论: `GoalStepOutcome` 的超集 + 节奏归因 (旧调用方不受影响) */
export interface ContinuationPreflight extends GoalStepOutcome {
  /** 结论从哪来: 事实自己判定 / 注入的判定器 */
  source: 'facts' | 'injected';
  basis: RhythmBasis;
  caps: SafetyCap[];
  bindingCap: SafetyCap | null;
  capsInEffect: HardLimits;
  /** 完整决策 (有事实时必有; 注入路径没有 —— 注入的是有损投影) */
  fullDecision: ContinuationDecision | null;
  /**
   * 这次判定用的**事实本体** (规范路径才有; 注入路径为 null)。
   *
   * 为什么把事实也返回出来: 判定结论是"事实的函数", 调用方要落**回放记录** (goalSnapshot /
   * noProgressStreak / 用了哪条 Run) 时不必再读一次盘 —— 那会造出第二份可能不一致的事实。
   * 注入路径为 null 是**如实**: 那条路径上根本没有可交还的事实。
   */
  facts: RhythmFacts | null;
  /** 这个"停"没有任何可核验的上限对应 (缺事实时如实标注, 不假装验过) */
  unattributableStop: boolean;
}

export interface ContinuationSeamDeps {
  /**
   * 旧口径 (M0 现有注入): 已经判定好的结论 —— 事实拿不到时的兜底。
   * 它**不是**节奏的权威: 只有上限触顶/终态/等外部才停得住, 其余见 `judgeLegacyStop`。
   */
  decide?: (input: {
    goalId: string;
    now: IsoTimestamp;
    maxRetries?: number;
    writeRecord?: boolean;
  }) => Promise<GoalStepOutcome | null>;
  /** 规范口径 (M1): **只读事实, 不判定** —— 判定由本接缝用 P0 自己编 */
  readFacts?: (input: { goalId: string; now: IsoTimestamp }) => Promise<RhythmFacts | null>;
}

export interface ContinuationSeam {
  readonly id: typeof CONTINUATION_SEAM_ID;
  readonly stage: 'M1';
  /**
   * 跑之前的节奏判定。
   *
   * `caller !== 'supervisor'` → 拒绝 (规则 ①)。拒绝是**结构化**的:
   * 上层能原样把它记进 `report.skipped` / `report.errors`, 而不是"静默不跑"。
   */
  preflight(input: {
    goalId: string;
    caller: WiringCaller;
    now: IsoTimestamp;
    maxRetries?: number;
    /** 旧的固定轮次 (第 N 轮就停) —— 只当安全上限, 见 `safetyCapsFrom` */
    maxRounds?: number;
    maxRunDurationMs?: number;
    limits?: Partial<HardLimits> | null;
    writeRecord?: boolean;
  }): Promise<ContinuationPreflight | SeamRefusal | null>;
}

/**
 * 注入的结论 → 可核验的节奏归因。
 *
 * 投影里能核验的只有**无进展熔断** (它只需要 `noProgressStreak`)。
 * 自称别的上限 (时间/预算) 缺事实 → 不认, 但如实标注 (不假装验过);
 * 自称熔断却数与阈值对不上 → **真拒** (用轮次冒充安全上限)。
 */
export function judgeInjectedOutcome(
  out: GoalStepOutcome,
  caps: HardLimits,
): ContinuationPreflight | SeamRefusal {
  const claimed = (out.caps ?? []).filter((c): c is SafetyCap => (SAFETY_CAPS as readonly string[]).includes(c));
  const stop = out.runnable !== true;
  const state = out.decision?.state ?? null;
  const kind = out.decision?.decision ?? null;

  const claimsBreaker = claimed.includes('no_progress_breaker');
  const breakerTripped = out.noProgressStreak >= caps.noProgressCircuitBreaker;
  if (claimsBreaker && !breakerTripped) {
    return refuse(
      'only_supervisor_decides_continuation',
      `拒绝: 注入的结论自称「${SAFETY_CAP_TEXT.no_progress_breaker}」触顶, 但 noProgressStreak=`
      + `${out.noProgressStreak} < 阈值 ${caps.noProgressCircuitBreaker} —— 用轮次冒充安全上限: `
      + '只有上限真的触顶才能停 (这不算安全线, 是拿"第几轮"当节奏)',
    );
  }
  // 不管自称不自称: 阈值真的到了, 这条上限就是从事实核验得到的
  const verifiedBreaker = stop && (state === 'no_progress') && breakerTripped;
  const unverifiable = claimed.filter((c) => c !== 'no_progress_breaker');

  let basis: RhythmBasis;
  if (!stop) {
    basis = kind === 'delegate' ? 'delegate' : kind === 'continue' ? 'progress' : 'wait';
  } else if (kind === 'complete' || kind === 'fail') {
    basis = 'terminal';
  } else if (kind === 'wait' || kind === 'pause') {
    basis = 'wait';
  } else if (verifiedBreaker) {
    basis = 'cap';
  } else {
    basis = 'human';
  }

  const caps_: SafetyCap[] = verifiedBreaker ? ['no_progress_breaker'] : [];
  const unattributableStop = stop
    && basis !== 'cap' && basis !== 'terminal' && basis !== 'wait';
  const note = unattributableStop
    ? (unverifiable.length
      ? ` (自称的上限 ${unverifiable.map((c) => SAFETY_CAP_TEXT[c]).join(' + ')} 缺事实, 不可核验 → 不认)`
      : ' (缺事实: 时间/预算两类上限无法核验, 只核验了无进展熔断)')
    : '';

  return {
    ...out,
    source: 'injected',
    basis,
    caps: caps_,
    bindingCap: caps_[0] ?? null,
    capsInEffect: caps,
    fullDecision: null,
    facts: null,
    unattributableStop,
    reason: `${out.reason}${note}`,
  };
}

export function createContinuationSeam(deps: ContinuationSeamDeps): ContinuationSeam {
  return {
    id: CONTINUATION_SEAM_ID,
    stage: 'M1',
    async preflight(input) {
      if (input.caller !== 'supervisor') {
        return refuse(
          'only_supervisor_decides_continuation',
          `拒绝: caller=${input.caller} 想决定"是否继续 (goal=${input.goalId})" —— `
          + '只有 Supervisor 能决定是否继续 (Runner/子 Agent 只能上报事实与建议)',
        );
      }
      if (!input.goalId) {
        return refuse('only_supervisor_decides_continuation', '拒绝: 没有 goalId 的节奏判定等于给不存在的目标排队');
      }

      const config: LegacyRhythmConfig = {
        maxRounds: input.maxRounds,
        maxRetries: input.maxRetries,
        maxRunDurationMs: input.maxRunDurationMs,
        limits: input.limits,
      };
      const capsInEffect = safetyCapsFrom(config);

      // 规范路径: 事实 → P0 (判定由本接缝做, 全量决策随结果返回)
      if (deps.readFacts) {
        const facts = await deps.readFacts({ goalId: input.goalId, now: input.now });
        if (facts) {
          const plan = planRhythm(facts, config);
          const capNote = plan.caps.length > 0
            ? `, 上限: ${plan.caps.map((c) => SAFETY_CAP_TEXT[c]).join(' + ')}`
            : '';
          return {
            goalId: plan.goalId,
            runnable: plan.runnable,
            reason: `[${RHYTHM_BASIS_TEXT[plan.basis]}${capNote}] ${plan.decisionReason} | 放行: ${plan.runnableReason}`,
            noProgressStreak: plan.noProgressStreak,
            decision: {
              decision: plan.decision.decision,
              state: plan.decision.state,
              nextAction: plan.decision.nextAction,
              requiredCapability: plan.decision.requiredCapability,
              decisionId: plan.decision.decisionId,
            },
            caps: plan.caps,
            stopReason: plan.decision.stopReason,
            progress: plan.decision.progressDelta,
            source: 'facts',
            basis: plan.basis,
            bindingCap: plan.bindingCap,
            capsInEffect,
            fullDecision: plan.decision,
            facts,
            unattributableStop: false,
          };
        }
        // 事实读不到 → 不猜 (下面还有没兜底, 没有就如实说)
        if (!deps.decide) return null;
      }

      if (!deps.decide) {
        return refuse(
          'only_supervisor_decides_continuation',
          '拒绝: 接缝既没有 readFacts 也没有 decide —— 没有事实就没有节奏判定, 不许编一条决策出来',
        );
      }

      const out = await deps.decide({
        goalId: input.goalId,
        now: input.now,
        maxRetries: input.maxRetries,
        writeRecord: input.writeRecord,
      });
      if (!out) return null;
      return judgeInjectedOutcome(out, capsInEffect);
    },
  };
}

// ============================================================================
// §5. 源码级判据 (供门与变异验证: 本接缝的"自适应节奏"接线是不是还在)
// ============================================================================

/**
 * 必须有: P0 的三个函数 + 上限登记函数 (少一个 = 节奏或上限被摘掉)。
 *
 * 为什么用 `fn.name` 而不是把函数名抄成字面量: 抄成字面量的那一行**自己就含**着这个
 * 名字 —— 于是这道判据会被自己满足 (门空转)。取运行期函数名, 判据只可能在**真的调用**处命中。
 */
export const SEAM_RHYTHM_REQUIRED: readonly string[] = [
  `${decideContinuation.name}(`,
  `${applyHardLimits.name}(`,
  `${isRunnable.name}(`,
  `${safetyCapsFrom.name}(`,
];

/**
 * 不许有: 拿轮次/轮数自己判停 (轮次只准经 `safetyCapsFrom` 变成安全上限)。
 *
 * 词根 + 后缀拼出来, 同样是为了**不自证违规**: 把 `runsUsed` 直接写成本判据里的一行,
 * 那一行就会被自己的模式命中 → 干净树永远判红, 门就废了。
 */
const RHYTHM_FORBIDDEN_ROOTS = ['runs', 'round', 'attempt'] as const;

export const SEAM_ROUNDS_AS_RHYTHM: readonly RegExp[] = [
  /\bgoal\s*\.\s*runs\b/,
  ...RHYTHM_FORBIDDEN_ROOTS.map((root) => new RegExp(`\\b${root}(?:No|Used|Count)?\\s*>=`)),
];

/**
 * 纯函数判据: 吃源码文本, 吐违规清单。
 * 与 `seams.ts` 同一手法 —— 于是"改坏主不变量 → 必须判红"可以在测试里**每次跑都在验**,
 * 而不是我口头说验过 (见 `src/test/goal-flywheel-wiring-continuation.test.ts` 的变异段)。
 */
export function scanContinuationSeamRhythm(text: string): { ok: boolean; violations: string[] } {
  const code = stripBlockComments(String(text)).split(/\r?\n/).map((s) => {
    const i = s.indexOf('//');
    return i >= 0 ? s.slice(0, i) : s;
  }).join('\n');
  const violations: string[] = [];
  for (const needle of SEAM_RHYTHM_REQUIRED) {
    if (!code.includes(needle)) violations.push(`缺少 ${needle} —— 节奏/上限的接线被摘掉了`);
  }
  for (const re of SEAM_ROUNDS_AS_RHYTHM) {
    if (re.test(code)) violations.push(`出现"按轮次停"的写法 (${String(re)}) —— 轮次只准经 safetyCapsFrom 变成安全上限`);
  }
  return { ok: violations.length === 0, violations };
}
