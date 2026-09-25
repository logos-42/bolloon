/**
 * goal-flywheel/run-closure.ts — P1「强制收尾飞轮」(2026-09-25)
 *
 * 职责: 把 **Run 结束** 这件事变成一条**固定顺序的流水线**, 成功 / 失败 / 中断恢复后的 Run
 *       都必须走同一条路 —— 而不是"只在成功时顺手收个尾"。
 * 产物四类 (缺任何一类 = 收尾未完成): 事实 / 教训 / Skill 改进候选 / 下一步建议。
 * 另外两份输出 (§P4b): 用户汇报 `UserReport` + 机器继续记录 `GoalContinuationRecord`。
 *
 * 边界 (与设计文档 `docs/wiki/goal-continuation-flywheel.md` §13/§14 一致):
 *   - **只读** `types.ts` (冻结面), 只通过它的类型与别的阶段耦合; 实现文件之间零 import。
 *   - 依赖**全部参数注入** (`CloseRunDeps`): Memory 写入 / Skill 候选写入 / 继续决策。
 *     P1b 的 `writeMemoryRecords`、P1b 的 `writeCandidate` 包装、P0 的 `decideContinuation`
 *     在接线时被注入进来即可 —— 本文件不 import 它们 (那也是它们此刻不存在的原因)。
 *   - 时间一律 `now: IsoTimestamp` 注入; **不读真实钟**, 不 import `fs`, 不做任何 I/O。
 *
 * 副作用时序 (如实说明): `deps.decide` 在**读完步骤与证据后立刻**调用 —— 因为 §5 的第 6/7/8
 *   步 (写 Skill 候选 / 更新 Goal continuation / 用户汇报) 都要用它的返回值。而 `steps`
 *   记录的是「收尾流水线走了哪 9 步」(§5 的冻结清单), 不是副作用的毫秒时序。
 *
 * `finalReview` 的形状 (P1 的输入契约): 一个**字符串**。
 *   - 是结构化 JSON (或文本里带 ```json 围栏 / 首个 `{...}` 块) 且带 `reviewedBy` → 被采信;
 *     参照 `bolloon-run-final-review/1`:
 *     {
 *       "reviewedBy": "leo",                       // 必填 —— 没有评审人的评审不予采信
 *       "verdict": "reusable" | "one_off" | "unknown",
 *       "methodEffective": "…", "methodFailed": "…", "nextTimeChange": "…",   // lesson 三件套
 *       "facts":   [{ "claim": "…", "assertion": "confirmed"|"inferred", "refs": ["…"] }],
 *       "skills":  [{ "name": "…", "purpose": "…", "occurrences": 2, "boundaryClear": true,
 *                     "inputSchema": "…", "outputSchema": "…", "guarantees": ["…"],
 *                     "doesNotGuarantee": ["…"], "failureCases": ["…"], "evidenceRefs": ["…"] }]
 *     }
 *   - 是一段散文 (或空) → **仍然收尾**, 但明确记为"评审非结构化": 不产 lesson, 不产 skill 候选,
 *     并把原因写进 `skipped`。这是刻意的: 收尾不能因为评审写得随意就静默跳过 (§5)。
 *
 * 两处**收尾收紧** (与 P0 的 `applyHardLimits` 同一精神: 只能收紧, 不能放宽):
 *   ① 决策为 `complete` 但本轮**没有任何已确认证据** → 不许以"完成"收场, 收紧为 `ask_human`;
 *   ② 决策为 `complete` 但 `unresolvedItems` 非空 → 同上 (未解决项非空则不许判完成)。
 *   所有收紧都在 `skipped` 里留下结构化原因, 并写进用户汇报的结论里。
 */
import { RUN_CLOSURE_STEPS } from './types.js';
import type {
  AssertionKind,
  ContinuationDecision,
  ContinuationDecisionKind,
  ContinuationState,
  GoalContinuationRecord,
  GoalLifecycleState,
  HardLimits,
  IsoTimestamp,
  LessonMemory,
  MemoryRecord,
  ProgressDelta,
  RunClosureStep,
  RunFactMemory,
  SkillImprovementCandidate,
  SkillJunkReason,
  SkillSignalMemory,
  UserReport,
  UserReportField,
  UserVisibleState,
} from './types.js';
import type { GoalRecord, GoalStatus } from '../goal-store.js';
import type { RunRecord, RunStep } from '../run-store.js';

// ============================================================================
// 上限 / 退化值 (全部显式命名, 便于接线层核对, 不做暗默认)
// ============================================================================

/** 一次收尾最多写多少条事实 (超出部分丢弃并记 `facts_capped`) */
export const CLOSURE_MAX_FACTS = 50;
/** 用户汇报里最多列多少条证据引用 */
export const CLOSURE_MAX_EVIDENCE = 50;
/** 调用方没注入 `hardLimits` 时的无进展熔断阈值 (退化值, 安全线仍由真的接线层注入) */
export const CLOSURE_DEFAULT_NO_PROGRESS_CIRCUIT_BREAKER = 3;
/** lesson 的一句话门槛: 短于此长度视为"只是一句经验", 不写 lesson */
export const CLOSURE_MIN_PURPOSE_LENGTH = 10;

// ============================================================================
// 依赖与结果 (§14 冻结的签名)
// ============================================================================

/**
 * `deps.decide` 的入参 —— 与 §14 里 `decideContinuation` 的第一个参数**同形**,
 * 因此 P0 的实现 (以及任何遵守该契约的实现) 可以直接赋给 `ClosureDecider`。
 */
export interface ContinuationDecisionInput {
  goal: GoalRecord;
  run: RunRecord;
  now: IsoTimestamp;
  progress: ProgressDelta;
  noProgressStreak: number;
  hardLimits: HardLimits;
}

/** P0 的决策函数 (注入; 本文件不 import 它的实现) */
export type ClosureDecider = (input: ContinuationDecisionInput) => ContinuationDecision;

export interface CloseRunDeps {
  /** 写这次收尾的全部 Memory 记录 (事实 / 教训 / skill 信号) */
  writeMemory: (
    records: MemoryRecord[],
    now: IsoTimestamp,
  ) => Promise<{ written: string[]; rejected: { memoryId: string; reason: string }[] }>;
  /** 写一条 Skill 改进候选; 返回落盘 id, 没写成返回 null */
  writeCandidate: (c: SkillImprovementCandidate) => Promise<string | null>;
  /** 继续决策 (P0) */
  decide: ClosureDecider;
  /**
   * 候选草案的内容哈希 (冻结字段 `contentHash` 的唯一来源)。
   *
   * **注入而不是 import**: 本文件不 import 别的阶段实现 (见文件头边界) —— 生产路径由接线层
   * (`goal-flywheel-wiring.closeGoalRun`) 注入用 `work-contract.stableHash` 算出的哈希。
   *
   * ★ 2026-09-25 (P5 验收修复): 原来是硬编码 `contentHash: null`, 于是**每一份**收尾候选都被
   *   第二道门以 `unverifiable_result` 拒收 (`writeSkillCandidate` 返回 null) —— "Run 结束自动写
   *   Skill 候选"在盘上等于零, 对人没有可审的产物。不注入时仍是 `null` (旧调用形行为不变)。
   */
  contentHashOf?: (candidate: SkillImprovementCandidate) => string | null;
}

export interface CloseRunInput {
  goalId: string;
  runId: string;
  run: RunRecord;
  /** Final Review 文本 (见文件头契约; 散文也能收尾, 但会被记为"非结构化") */
  finalReview: string;
  now: IsoTimestamp;
  /**
   * §14 的入参里没有, 但 `decide` 需要 —— 可选**追加**字段: 老调用形 (只给上面 5 个) 照样编译。
   * 不注入时的退化行为见 `deriveGoal()` (判据面为空 → 按冻结语义"空判据一律不许自动判完成")。
   */
  goal?: GoalRecord;
  /** 上一次收尾的连续无进展计数 (不注入时按本轮有无进展保守取 0/1) */
  noProgressStreak?: number;
  /** 三类硬底线 (不注入时用 `deriveHardLimits()` 的退化值) */
  hardLimits?: HardLimits;
}

/** §14 冻结的返回字段 (运行时键集必须**恰好**是这些) */
export const CLOSURE_RESULT_FIELDS = [
  'steps',
  'facts',
  'lessons',
  'candidates',
  'nextStep',
  'decision',
  'userReport',
  'continuation',
  'skipped',
] as const;

export interface CloseRunResult {
  /** 走过的收尾步骤 (§5 固定顺序; 被跳过的步骤也出现在这里, 原因在 `skipped`) */
  steps: RunClosureStep[];
  facts: RunFactMemory[];
  lessons: LessonMemory[];
  /** 提取到的**全部**候选 (含被门拦下的: `status='rejected'` + `junkReasons` 非空) */
  candidates: SkillImprovementCandidate[];
  /** 下一步 (必答, 不许为空串) */
  nextStep: string;
  decision: ContinuationDecision;
  userReport: UserReport;
  continuation: GoalContinuationRecord;
  /** 没做成 / 被收紧 / 被拒的步骤 + 结构化原因 (不许只有一个 boolean) */
  skipped: { step: RunClosureStep; reason: string }[];
}

/** 收尾自身无法继续的错误 (例如决策依赖失效 —— 宁可显式失败, 不编一个决策出来) */
export class RunClosureError extends Error {
  readonly step: RunClosureStep;
  constructor(step: RunClosureStep, message: string) {
    super(message);
    this.name = 'RunClosureError';
    this.step = step;
  }
}

// ---------------------------------------------------------------------------
// 类型级门 (由 `npx tsc --noEmit` 真判): 返回字段集不许漂移
// ---------------------------------------------------------------------------

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;

const RESULT_KEYS_MATCH_SECTION14: SameKeys<
  CloseRunResult,
  Record<(typeof CLOSURE_RESULT_FIELDS)[number], unknown>
> = true;
/** 编译期门: `CloseRunResult` 的键集与 §14 完全一致 (多/少一个 → tsc 判红) */
export const CLOSURE_RESULT_KEYS_EXACT: typeof RESULT_KEYS_MATCH_SECTION14 = true;

// ============================================================================
// Final Review 的解析 (纯函数, 无 I/O)
// ============================================================================

export interface ReviewFactClaim {
  claim: string;
  /** 评审**声明**的确定性 (原话) */
  declared: AssertionKind;
  /** 采信后的确定性 (声明 confirmed 却拿不出来源 → 降为 inferred) */
  assertion: AssertionKind;
  refs: string[];
}

export interface ReviewSkillClaim {
  name: string;
  purpose: string;
  occurrences: number;
  boundaryClear: boolean;
  inputSchema: string;
  outputSchema: string;
  guarantees: string[];
  doesNotGuarantee: string[];
  failureCases: string[];
  evidenceRefs: string[];
}

export interface ParsedRunReview {
  /** 是否被采信为结构化评审 (散文/空/没有评审人 → false) */
  structured: boolean;
  /** 为什么 (structured=true 时为 'ok') */
  reason: string;
  reviewedBy: string | null;
  verdict: 'reusable' | 'one_off' | 'unknown';
  methodEffective: string;
  methodFailed: string;
  nextTimeChange: string;
  facts: ReviewFactClaim[];
  skills: ReviewSkillClaim[];
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asTextArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter((s) => s.length > 0);
}

function asFiniteNumber(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

/** 从文本里捞出评审 JSON: 整体 → ```json 围栏 → 首个 `{...}` 块 */
function extractReviewJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(t);
  if (whole !== undefined) return whole;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const parsed = tryParse(t.slice(first, last + 1));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * 解析 Final Review。**没有评审人就不采信** (lesson 必须带 `reviewedBy`)。
 * 理由码: empty_final_review · no_json_found · not_a_json_object · missing_reviewed_by · ok
 */
export function parseFinalReview(finalReview: string): ParsedRunReview {
  const empty: ParsedRunReview = {
    structured: false,
    reason: 'empty_final_review',
    reviewedBy: null,
    verdict: 'unknown',
    methodEffective: '',
    methodFailed: '',
    nextTimeChange: '',
    facts: [],
    skills: [],
  };
  const raw = typeof finalReview === 'string' ? finalReview : '';
  if (!raw.trim()) return empty;
  const json = extractReviewJson(raw);
  if (json === undefined) return { ...empty, reason: 'no_json_found' };
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ...empty, reason: 'not_a_json_object' };
  }
  const obj = json as Record<string, unknown>;
  const reviewedBy = asText(obj.reviewedBy);
  if (!reviewedBy) return { ...empty, reason: 'missing_reviewed_by' };

  const verdictRaw = asText(obj.verdict);
  const verdict: ParsedRunReview['verdict'] =
    verdictRaw === 'reusable' || verdictRaw === 'one_off' ? verdictRaw : 'unknown';

  const facts: ReviewFactClaim[] = [];
  if (Array.isArray(obj.facts)) {
    for (const f of obj.facts) {
      if (!f || typeof f !== 'object') continue;
      const fo = f as Record<string, unknown>;
      const claim = asText(fo.claim);
      if (!claim) continue;
      const refs = asTextArray(fo.refs);
      // 声明 confirmed 但没有来源 → 降级为推测 (推测永不当证据)
      const declared: AssertionKind = asText(fo.assertion) === 'confirmed' ? 'confirmed' : 'inferred';
      const assertion: AssertionKind = declared === 'confirmed' && refs.length > 0 ? 'confirmed' : 'inferred';
      facts.push({ claim, declared, assertion, refs });
    }
  }

  const skills: ReviewSkillClaim[] = [];
  if (Array.isArray(obj.skills)) {
    for (const s of obj.skills) {
      if (!s || typeof s !== 'object') continue;
      const so = s as Record<string, unknown>;
      const name = asText(so.name);
      if (!name) continue;
      skills.push({
        name,
        purpose: asText(so.purpose),
        occurrences: asFiniteNumber(so.occurrences, 0),
        boundaryClear: asBool(so.boundaryClear, false),
        inputSchema: asText(so.inputSchema),
        outputSchema: asText(so.outputSchema),
        guarantees: asTextArray(so.guarantees),
        doesNotGuarantee: asTextArray(so.doesNotGuarantee),
        failureCases: asTextArray(so.failureCases),
        evidenceRefs: asTextArray(so.evidenceRefs),
      });
    }
  }

  return {
    structured: true,
    reason: 'ok',
    reviewedBy,
    verdict,
    methodEffective: asText(obj.methodEffective),
    methodFailed: asText(obj.methodFailed),
    nextTimeChange: asText(obj.nextTimeChange),
    facts,
    skills,
  };
}

// ============================================================================
// 候选门 (P1 版的"防 Skill 垃圾"检查, 只认冻结的 SkillJunkReason 取值)
// ============================================================================

const TEMP_PATH_HINT = /(^|[\s"'(=:])(\/tmp\/|tmp\/|\/var\/folders\/)/;

/**
 * 用**冻结的** `SkillJunkReason` 取值给一条评审候选过门。
 *
 * 与 P1b 的 `assessCandidate()` 的关系: 那个还做「与现有 Skill 比版本/重复」, 需要已有 Skill 列表;
 * 本文件在收尾时拿不到那份列表 (也不该 import 别的阶段), 因此**只**做自洽性门:
 * 一次偶然成功 · 无 IO 契约 · 无失败边界 · 依赖临时路径 · 结果不可验证 · 只是一句经验。
 * 命中任意一条 → `status='rejected'`, **绝不**送去 `writeCandidate`。
 */
export function gateClosureCandidate(raw: ReviewSkillClaim): {
  candidate: SkillImprovementCandidate;
  junk: SkillJunkReason[];
} {
  const junk: SkillJunkReason[] = [];
  if (raw.purpose.length < CLOSURE_MIN_PURPOSE_LENGTH) junk.push('one_line_experience');
  if (raw.occurrences < 2) junk.push('single_success');
  if (!raw.boundaryClear) junk.push('no_failure_boundary');
  if (raw.failureCases.length === 0) junk.push('no_failure_boundary');
  if (!raw.inputSchema || !raw.outputSchema) junk.push('no_io_schema');
  if (raw.evidenceRefs.length === 0) junk.push('unverifiable_result');
  if (raw.guarantees.length === 0 || raw.doesNotGuarantee.length === 0) junk.push('no_failure_boundary');
  const touchesTemp = [raw.inputSchema, raw.outputSchema, ...raw.evidenceRefs, ...raw.failureCases].some((s) =>
    TEMP_PATH_HINT.test(s),
  );
  if (touchesTemp) junk.push('temp_path_dependency');
  const unique = [...new Set(junk)];

  const candidate: SkillImprovementCandidate = {
    candidateId: `cand:${raw.name}`,
    name: raw.name,
    purpose: raw.purpose,
    sourceRunIds: [],
    evidenceRefs: [...raw.evidenceRefs],
    failureCases: [...raw.failureCases],
    inputSchema: raw.inputSchema,
    outputSchema: raw.outputSchema,
    guarantees: [...raw.guarantees],
    doesNotGuarantee: [...raw.doesNotGuarantee],
    contentHash: null,
    // 候选永远不带批准 —— 正式变更必须由人批 (冻结语义)
    approval: { state: 'not_requested', approvedBy: null, approvedAt: null, changeReason: null },
    status: unique.length > 0 ? 'rejected' : 'draft',
    occurrences: raw.occurrences,
    boundaryClear: raw.boundaryClear,
    junkReasons: unique,
    proposedAt: '',
    proposedByRunId: '',
  };
  return { candidate, junk: unique };
}

// ============================================================================
// 退化值 (调用方没注入时用; 全部写在注释里, 便于接线层核对)
// ============================================================================

/** Run 状态 → Goal 状态 (退化用; 与 goal-store 的语义同域) */
function goalStatusFromRun(status: RunRecord['status']): GoalStatus {
  switch (status) {
    case 'done':
      return 'active';
    case 'failed':
    case 'aborted':
      return 'failed';
    case 'interrupted':
      return 'recovering';
    case 'stalled':
      return 'stalled';
    case 'needs_human':
      return 'needs_human';
    case 'paused':
      return 'paused';
    case 'awaiting_external':
      return 'awaiting_external';
    default:
      return 'active';
  }
}

/**
 * 没注入 `goal` 时的退化 Goal: 只装 run 事实。
 * 关键: `successCriteria` 为空 → 按冻结语义「空判据一律不许自动判完成」,
 * 因此退化形态**不可能**自己判 complete —— 这是安全的默认方向。
 */
function deriveGoal(input: CloseRunInput): GoalRecord {
  const run = input.run;
  return {
    goalId: input.goalId,
    objective: run.goal || input.runId,
    successCriteria: [],
    constraints: [],
    status: goalStatusFromRun(run.status),
    createdAt: run.startedAt || input.now,
    updatedAt: input.now,
    currentRunId: input.runId,
    runs: [input.runId],
    completedCriteria: [],
    unresolvedItems: [],
    evidence: [...(run.evidence ?? [])],
  };
}

/** 没注入 `hardLimits` 时的退化底线 (maxGoalBudget=null 意味着"未设上限, 必须由人显式确认") */
function deriveHardLimits(input: CloseRunInput, goal: GoalRecord): HardLimits {
  const runDeadline = typeof input.run.budget?.deadlineMs === 'number' ? input.run.budget.deadlineMs : 0;
  const goalBudget = typeof goal.budget?.maxRuns === 'number' ? goal.budget.maxRuns : null;
  return {
    maxRunDurationMs: runDeadline,
    maxGoalBudget: goalBudget,
    noProgressCircuitBreaker: CLOSURE_DEFAULT_NO_PROGRESS_CIRCUIT_BREAKER,
  };
}

// ============================================================================
// 事实 / 教训 / 候选 的提取 (纯函数)
// ============================================================================

function stepRef(runId: string, step: RunStep): string {
  return `${runId}#step:${step.n}`;
}

function buildFacts(input: CloseRunInput, review: ParsedRunReview): { facts: RunFactMemory[]; overflow: number } {
  const now = input.now;
  const runId = input.runId;
  const run = input.run;
  const all: RunFactMemory[] = [];
  const push = (f: Omit<RunFactMemory, 'layer' | 'goalId' | 'runId' | 'createdAt'>): void => {
    all.push({ ...f, layer: 'run_fact', goalId: input.goalId, runId, createdAt: now });
  };

  // ① 逐步事实: 成功与失败都是**已确认**的事实 (失败也是事实, 不是"没发生")
  for (const s of run.steps ?? []) {
    const ref = stepRef(runId, s);
    push({
      memoryId: `mem:${runId}:step:${s.n}`,
      content: s.ok
        ? `步骤 ${s.n} (${s.tool}) 成功${s.summary ? `: ${s.summary}` : ''}`
        : `步骤 ${s.n} (${s.tool}) 失败: ${s.error ?? '(未记录错误)'}`,
      evidenceRefs: [ref],
      assertion: 'confirmed',
      confirmedRefs: [ref],
    });
  }

  // ② Run 级证据 (每条本身就是可核验引用)
  for (const [i, e] of (run.evidence ?? []).entries()) {
    if (!e || !e.trim()) continue;
    push({
      memoryId: `mem:${runId}:evidence:${i}`,
      content: `Run 级证据: ${e}`,
      evidenceRefs: [e],
      assertion: 'confirmed',
      confirmedRefs: [e],
    });
  }

  // ③ 结束状态事实
  if (run.error) {
    const ref = `${runId}#error`;
    push({
      memoryId: `mem:${runId}:error`,
      content: `Run 以 ${run.status} 结束: ${run.error}`,
      evidenceRefs: [ref],
      assertion: 'confirmed',
      confirmedRefs: [ref],
    });
  }
  if ((run.recovery ?? []).length > 0) {
    const last = run.recovery[run.recovery.length - 1];
    const ref = `${runId}#recovery:${run.recovery.length}`;
    push({
      memoryId: `mem:${runId}:recovery`,
      content: `本 Run 经历 ${run.recovery.length} 次恢复尝试 (最后一次: ${last.errorClass} → ${last.action}${last.recovered ? ', 已恢复' : ''})`,
      evidenceRefs: [ref],
      assertion: 'confirmed',
      confirmedRefs: [ref],
    });
  }

  // ④ 评审声明的事实: 推测**不带**任何证据引用 (推测永不当证据)
  for (const [i, f] of review.facts.entries()) {
    const inferred = f.assertion === 'inferred';
    const downgraded = inferred && f.declared === 'confirmed' && f.refs.length === 0;
    push({
      memoryId: `mem:${runId}:review-fact:${i}`,
      content: downgraded ? `${f.claim} (原报 confirmed 但无来源 → 降级为推测)` : f.claim,
      evidenceRefs: inferred ? [] : [...f.refs],
      assertion: f.assertion,
      confirmedRefs: inferred ? [] : [...f.refs],
    });
  }

  const capped = all.slice(0, CLOSURE_MAX_FACTS);
  const seen = new Set<string>();
  const facts = capped.filter((f) => (seen.has(f.memoryId) ? false : (seen.add(f.memoryId), true)));
  return { facts, overflow: all.length - capped.length };
}

function buildLesson(
  input: CloseRunInput,
  review: ParsedRunReview,
  confirmedRefs: string[],
): { lesson: LessonMemory | null; reason: string | null } {
  if (!review.structured) return { lesson: null, reason: `review_not_structured: ${review.reason}` };
  if (review.verdict === 'one_off') return { lesson: null, reason: 'review_verdict_one_off' };
  if (review.verdict !== 'reusable') return { lesson: null, reason: 'review_verdict_unknown' };
  const missing: string[] = [];
  if (!review.reviewedBy) missing.push('reviewedBy');
  if (!review.methodEffective) missing.push('methodEffective');
  if (!review.methodFailed) missing.push('methodFailed');
  if (!review.nextTimeChange) missing.push('nextTimeChange');
  if (missing.length > 0) return { lesson: null, reason: `lesson_fields_missing: ${missing.join(',')}` };
  const lesson: LessonMemory = {
    memoryId: `mem:${input.runId}:lesson`,
    layer: 'lesson',
    goalId: input.goalId,
    runId: input.runId,
    content: `教训: 有效=${review.methodEffective} / 失败=${review.methodFailed} / 下次=${review.nextTimeChange}`,
    evidenceRefs: confirmedRefs.slice(0, CLOSURE_MAX_EVIDENCE),
    createdAt: input.now,
    reviewedBy: review.reviewedBy ?? '',
    reviewVerdict: 'reusable',
    methodEffective: review.methodEffective,
    methodFailed: review.methodFailed,
    nextTimeChange: review.nextTimeChange,
  };
  return { lesson, reason: null };
}

function buildCandidates(
  input: CloseRunInput,
  review: ParsedRunReview,
  contentHashOf?: (candidate: SkillImprovementCandidate) => string | null,
): { candidates: SkillImprovementCandidate[]; reasons: string[] } {
  const reasons: string[] = [];
  const candidates: SkillImprovementCandidate[] = [];
  for (const [i, raw] of review.skills.entries()) {
    const { candidate } = gateClosureCandidate(raw);
    const base: SkillImprovementCandidate = {
      ...candidate,
      candidateId: `cand:${input.runId}:${i}:${raw.name}`,
      sourceRunIds: [input.runId],
      proposedAt: input.now,
      proposedByRunId: input.runId,
    };
    // ★ 2026-09-25 (P5 验收修复): 冻结字段 contentHash 由注入的哈希器算 (缺注入 → 保持 null)。
    //   哈希只覆盖**草案内容** (名字/用途/IO 契约/边界/证据面), 不含 candidateId/时间/Run 来源 ——
    //   同一份内容来自不同 Run 必须得到同一个哈希 (否则"与已有 Skill 重复"永远判不出来)。
    const hash = contentHashOf ? contentHashOf({ ...base, contentHash: null }) : null;
    const withRun: SkillImprovementCandidate = { ...base, contentHash: hash ?? base.contentHash };
    candidates.push(withRun);
    if (withRun.junkReasons.length > 0) {
      reasons.push(`${withRun.candidateId}: ${withRun.junkReasons.join(',')}`);
    }
  }
  return { candidates, reasons };
}

// ============================================================================
// 进展与决策
// ============================================================================

function computeProgress(run: RunRecord): ProgressDelta {
  const newEvidence = [...new Set((run.evidence ?? []).filter((e) => typeof e === 'string' && e.trim().length > 0))];
  return {
    newEvidence,
    // 判据面的增量要跟 Goal 的上一份 completedCriteria 比, 收尾层拿不到历史 → 交给接线层在 goal 里体现
    newlyCompletedCriteria: [],
    stepsAdvanced: (run.steps ?? []).filter((s) => s.ok).length,
    // 未解决项的变化同理需要上一轮快照; 收尾层不猜
    unresolvedDelta: 0,
  };
}

/** 决策与状态必须自洽 (冻结注释原话); 不自洽只记原因, 不替 P0 改判 */
const STATE_OK_FOR_DECISION: Record<ContinuationDecisionKind, ContinuationState[]> = {
  continue: ['progressing'],
  wait: ['waiting_external', 'waiting_agent'],
  delegate: ['waiting_agent', 'progressing'],
  ask_human: ['needs_decision', 'blocked', 'no_progress'],
  complete: ['completed'],
  fail: ['failed'],
  pause: ['needs_decision', 'blocked'],
};

/** decision → Goal 生命周期状态 (P1 自己拥有 GoalContinuationRecord)
 *
 * ★ 2026-09-26 (M2): 导出为**单一事实来源** —— 接线接缝 `wiring/closure.ts` 的收尾产物审计
 *   要用它在"决策 ↔ continuation.state"之间对齐, 不在这里重抄一份映射 (两套映射 = 两套事实)。
 */
export const GOAL_STATE_FOR_DECISION: Record<ContinuationDecisionKind, GoalLifecycleState> = {
  continue: 'active',
  wait: 'awaiting_external',
  delegate: 'active',
  ask_human: 'needs_human',
  complete: 'completed',
  fail: 'failed',
  pause: 'paused',
};

/**
 * 用户可见态 (2026-09-25 起是**六类**)。终态不再借用 `executing`:
 * 第 6 类 `ended` 已补进冻结面, 收尾汇报按它表达"已结束"。
 */
function visibleStateFor(decision: ContinuationDecision): UserVisibleState {
  if (decision.decision === 'ask_human') return 'needs_your_decision';
  if (decision.state === 'completed' || decision.state === 'failed') return 'ended';
  if (decision.state === 'waiting_external') return 'waiting_external_reply';
  if (decision.state === 'blocked') return 'child_blocked';
  if (decision.state === 'no_progress') return 'no_progress';
  // progressing / waiting_agent → 'executing' (系统在收尾, 不向用户索要决定)
  return 'executing';
}

/** 收尾收紧: 只能让"完成"变得更难, 不会把别的决策变成 complete */
function tightenDecision(
  decision: ContinuationDecision,
  confirmedRefs: string[],
): { decision: ContinuationDecision; notes: string[]; tightened: boolean } {
  const notes: string[] = [];
  if (decision.decision !== 'complete') return { decision, notes, tightened: false };
  const missing: string[] = [];
  if (confirmedRefs.length === 0) missing.push('complete_without_confirmed_evidence');
  if (decision.unresolvedItems.length > 0) missing.push(`complete_with_unresolved_items: ${decision.unresolvedItems.length}`);
  if (missing.length === 0) return { decision, notes, tightened: false };
  const next: ContinuationDecision = {
    ...decision,
    decision: 'ask_human',
    state: 'needs_decision',
    reason: `[收尾收紧] 原决策 complete 被拒 (${missing.join('; ')}); 原理由: ${decision.reason}`,
    nextAction: '补齐可核验证据或由人确认是否接受该结果',
    expectedOutcome: '有一条人能核对的决定: 接受该结果 / 补充证据后重跑',
    confidence: Math.min(decision.confidence, 0.5),
    wakeAt: null,
    stopReason: null,
  };
  notes.push(...missing);
  return { decision: next, notes, tightened: true };
}

function nextStepOf(decision: ContinuationDecision): { nextStep: string; note: string | null } {
  const action = decision.nextAction.trim();
  if (action) return { nextStep: action, note: null };
  if (decision.decision === 'complete' || decision.decision === 'fail') {
    return { nextStep: `无 (终态: ${decision.decision})`, note: null };
  }
  const fallback = decision.unresolvedItems.length > 0
    ? `先处理未解决项: ${decision.unresolvedItems[0]}`
    : `按 ${decision.decision} 继续 (决策未给 nextAction, 由收尾兜底)`;
  return { nextStep: fallback, note: 'next_action_empty: 决策未给下一步动作, 收尾已兜底' };
}

// ============================================================================
// 用户汇报 (P4b 第一份输出)
// ============================================================================

const REPORT_EXPOSED_FIELDS: UserReportField[] = [
  'conclusion',
  'completed',
  'evidence',
  'remaining',
  'blockReasons',
  'nextStep',
  'willContinue',
  'expectedResumeAt',
  'visibleState',
];

const CONCLUSION_BY_KIND: Record<ContinuationDecisionKind, string> = {
  continue: '本轮有进展, 继续推进',
  wait: '本轮结束, 等待外部条件',
  delegate: '本轮结束, 需要其他执行者接手',
  ask_human: '本轮结束, 需要你做一个决定',
  complete: '目标判据已满足, 本次执行结束',
  fail: '目标无法再满足, 本次执行结束',
  pause: '本次执行已暂停',
};

function buildUserReport(
  input: CloseRunInput,
  decision: ContinuationDecision,
  nextStep: string,
  facts: RunFactMemory[],
  confirmedRefs: string[],
  tightened: string[],
): UserReport {
  const okFacts = facts.filter((f) => f.assertion === 'confirmed' && /成功/.test(f.content));
  const failedFacts = facts.filter((f) => f.assertion === 'confirmed' && /失败/.test(f.content));
  const evidenceFactClaims = facts.filter((f) => f.assertion === 'confirmed' && /^Run 级证据: /.test(f.content));
  const completed = [...okFacts.map((f) => f.content), ...evidenceFactClaims.map((f) => f.content)];
  const blockReasons = failedFacts.map((f) => f.content);
  if (decision.state === 'blocked') blockReasons.push(decision.reason);
  const tail = tightened.length > 0 ? ` [收尾收紧: ${tightened.join('; ')}]` : '';
  const reason = decision.reason.trim() ? `: ${decision.reason.trim()}` : '';
  return {
    conclusion: `${CONCLUSION_BY_KIND[decision.decision]}${reason}${tail}`,
    completed,
    evidence: confirmedRefs.slice(0, CLOSURE_MAX_EVIDENCE),
    remaining: [...decision.unresolvedItems],
    blockReasons,
    nextStep,
    willContinue: decision.decision !== 'complete' && decision.decision !== 'fail' && decision.decision !== 'pause',
    expectedResumeAt: decision.wakeAt,
    visibleState: visibleStateFor(decision),
    exposedFields: [...REPORT_EXPOSED_FIELDS],
    generatedAt: input.now,
  };
}

function buildContinuation(
  input: CloseRunInput,
  decision: ContinuationDecision,
  nextStep: string,
): GoalContinuationRecord {
  const goalState = GOAL_STATE_FOR_DECISION[decision.decision];
  return {
    nextAction: nextStep,
    wakeAt: decision.wakeAt,
    wakeReason: decision.reason.trim() || `state=${goalState}`,
    autoContinue: decision.decision === 'continue' || decision.decision === 'wait' || decision.decision === 'delegate',
    requiredAgent: decision.decision === 'delegate' ? decision.requiredCapability : null,
    // 未回报的子任务只有拿到 AgentWorkContract 才知道 (P2); 收尾层不编
    pendingReports: [],
    unresolvedItems: [...decision.unresolvedItems],
    lastDecisionId: decision.decisionId,
    state: goalState,
    updatedAt: input.now,
  };
}

// ============================================================================
// 主流程
// ============================================================================

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

/**
 * Run 收尾 (§14 冻结签名)。**成功 / 失败 / 中断恢复后的 Run 都必须走这一条**。
 * 依赖失效时:
 *   - `writeMemory` / `writeCandidate` 抛错 → 记进 `skipped`, **继续**走完后面几步 (收尾不能中途断掉);
 *   - `decide` 抛错 → 抛 `RunClosureError` (结构化的"我回答不了下一步"), 不编一个决策出来。
 */
export async function closeRun(input: CloseRunInput, deps: CloseRunDeps): Promise<CloseRunResult> {
  const now = input.now;
  const runId = input.runId;
  const steps: RunClosureStep[] = [];
  const skipped: { step: RunClosureStep; reason: string }[] = [];
  const mark = (s: RunClosureStep): void => {
    steps.push(s);
  };

  // ── 第 1 步: 主执行结束 ────────────────────────────────────────────────
  mark('run_ended');
  if (input.run.status === 'running') {
    skipped.push({ step: 'run_ended', reason: 'run_still_running: 还在跑的 Run 没有"结束"可收尾' });
  }

  // ── 第 2 步: 读完整步骤与证据 ──────────────────────────────────────────
  mark('read_full_steps_and_evidence');
  const progress = computeProgress(input.run);
  const streak =
    typeof input.noProgressStreak === 'number'
      ? input.noProgressStreak
      : progress.newEvidence.length === 0 && progress.stepsAdvanced === 0
        ? 1
        : 0;
  const goal = input.goal ?? deriveGoal(input);
  const hardLimits = input.hardLimits ?? deriveHardLimits(input, goal);
  let decision: ContinuationDecision;
  try {
    decision = deps.decide({ goal, run: input.run, now, progress, noProgressStreak: streak, hardLimits });
  } catch (e) {
    throw new RunClosureError('continuation_decision', `继续决策失效, 收尾无法回答"下一步": ${errText(e)}`);
  }

  // ── 第 3 步: Final Review ────────────────────────────────────────────
  mark('final_review');
  const review = parseFinalReview(input.finalReview);
  if (!review.structured) {
    skipped.push({ step: 'final_review', reason: `final_review_unstructured: ${review.reason}` });
  }

  // ── 第 4 步: 提取事实 / 教训 / Skill 候选 ─────────────────────────────
  mark('extract_facts_lessons_and_candidates');
  const { facts, overflow } = buildFacts(input, review);
  if (overflow > 0) {
    skipped.push({
      step: 'extract_facts_lessons_and_candidates',
      reason: `facts_capped: 保留前 ${CLOSURE_MAX_FACTS} 条, 丢弃 ${overflow} 条`,
    });
  }
  const confirmedRefs = [
    ...new Set(facts.filter((f) => f.assertion === 'confirmed').flatMap((f) => f.confirmedRefs)),
  ];
  const { lesson, reason: lessonReason } = buildLesson(input, review, confirmedRefs);
  if (lessonReason) {
    skipped.push({ step: 'extract_facts_lessons_and_candidates', reason: `lesson_skipped: ${lessonReason}` });
  }
  const { candidates, reasons: candidateReasons } = buildCandidates(input, review, deps.contentHashOf);
  if (facts.length === 0 && !lesson && candidates.length === 0) {
    skipped.push({
      step: 'extract_facts_lessons_and_candidates',
      reason: 'nothing_to_extract: 本轮既无步骤/证据, 也没有被采信的结构化评审',
    });
  }

  // ── 第 5 步: 写 Memory ───────────────────────────────────────────────
  mark('write_memory');
  const signals: SkillSignalMemory[] = candidates.map((c) => ({
    memoryId: `mem:${runId}:signal:${c.candidateId}`,
    layer: 'skill_signal',
    goalId: input.goalId,
    runId,
    content: `Skill 改进候选信号: ${c.name} (${c.status})`,
    evidenceRefs: [...c.evidenceRefs],
    createdAt: now,
    candidateId: c.candidateId,
    promotesDirectly: false,
  }));
  const records: MemoryRecord[] = [...facts, ...(lesson ? [lesson] : []), ...signals];
  if (records.length === 0) {
    skipped.push({ step: 'write_memory', reason: 'no_memory_records: 本轮没有可写的事实/教训/信号' });
  } else {
    try {
      const res = await deps.writeMemory(records, now);
      const written = Array.isArray(res?.written) ? res.written : [];
      const rejected = Array.isArray(res?.rejected) ? res.rejected : [];
      for (const r of rejected) {
        skipped.push({ step: 'write_memory', reason: `memory_rejected: ${r.memoryId}: ${r.reason}` });
      }
      if (written.length + rejected.length !== records.length) {
        skipped.push({
          step: 'write_memory',
          reason: `memory_written_count_mismatch: 交 ${records.length} 条, 报告 written=${written.length} + rejected=${rejected.length}`,
        });
      }
    } catch (e) {
      skipped.push({ step: 'write_memory', reason: `write_memory_failed: ${errText(e)}` });
    }
  }

  // ── 第 6 步: 写 Skill 候选 ───────────────────────────────────────────
  mark('write_skill_candidate');
  const promotable = candidates.filter((c) => c.status !== 'rejected');
  if (candidates.length === 0) {
    skipped.push({ step: 'write_skill_candidate', reason: 'no_candidate_extracted' });
  } else if (promotable.length === 0) {
    skipped.push({
      step: 'write_skill_candidate',
      reason: `no_promotable_candidate: ${candidateReasons.join('; ')}`,
    });
  } else {
    for (const c of promotable) {
      try {
        const id = await deps.writeCandidate(c);
        if (!id) {
          skipped.push({ step: 'write_skill_candidate', reason: `candidate_not_written: ${c.candidateId}` });
        }
      } catch (e) {
        skipped.push({ step: 'write_skill_candidate', reason: `write_candidate_failed: ${c.candidateId}: ${errText(e)}` });
      }
    }
  }

  // ── 第 7 步: 更新 Goal continuation ──────────────────────────────────
  mark('update_goal_continuation');
  if (decision.decision === 'delegate' && !decision.requiredCapability) {
    skipped.push({
      step: 'update_goal_continuation',
      reason: 'delegate_without_capability: requiredAgent 将为空, 接线层无法派遣',
    });
  }

  // ── 第 8 步: 用户汇报 ────────────────────────────────────────────────
  mark('user_report');

  // ── 第 9 步: 决定是否继续 (采用 / 收紧) ───────────────────────────────
  mark('continuation_decision');
  if (!STATE_OK_FOR_DECISION[decision.decision].includes(decision.state)) {
    skipped.push({
      step: 'continuation_decision',
      reason: `decision_state_mismatch: decision=${decision.decision} state=${decision.state}`,
    });
  }
  if (decision.decision === 'fail' && !decision.stopReason) {
    skipped.push({ step: 'continuation_decision', reason: 'fail_without_stop_reason: 判 fail 必须给出停止理由' });
  }
  if (decision.decision !== 'fail' && decision.decision !== 'complete' && decision.stopReason) {
    skipped.push({
      step: 'continuation_decision',
      reason: `stop_reason_outside_terminal: decision=${decision.decision} 带了 stopReason`,
    });
  }
  const guarded = tightenDecision(decision, confirmedRefs);
  decision = guarded.decision;
  for (const note of guarded.notes) {
    skipped.push({ step: 'continuation_decision', reason: note });
  }
  const { nextStep, note: nextNote } = nextStepOf(decision);
  if (nextNote) skipped.push({ step: 'continuation_decision', reason: nextNote });

  // ── 收尾流水线自检 (M2): 固定 9 步 / 顺序固定 / 不重不漏 ──────────────────
  //   `steps` 是"收尾走了哪几步"的唯一记录; 一旦它缺步或换序, 这条纪律就不再是一句没人验的话。
  const stepAudit = auditClosureSteps(steps);
  if (!stepAudit.ok) {
    skipped.push({ step: 'run_ended', reason: `closure_step_order_violation: ${stepAudit.reason}` });
  }

  const userReport = buildUserReport(input, decision, nextStep, facts, confirmedRefs, guarded.notes);
  const continuation = buildContinuation(input, decision, nextStep);

  return { steps, facts, lessons: lesson ? [lesson] : [], candidates, nextStep, decision, userReport, continuation, skipped };
}

/** 收尾步骤的固定顺序 (§5) —— 导出一份, 便于接线层与门核对 */
export const CLOSURE_STEP_ORDER: readonly RunClosureStep[] = RUN_CLOSURE_STEPS;

/**
 * 收尾流水线自检 (M2): **步数固定 · 顺序固定 · 不重不漏**。
 *
 * 为什么需要它: "成功 / 失败 / 中断恢复后的 Run 都必须走完同一条流水线" 这句话, 之前只由
 * `steps` 数组的**长度**间接体现 —— 少一步/换序都不会有人发现。把这个判据做成纯函数后,
 * 收尾自己每次都会过它一遍 (违反就进 `skipped`), 测试也能把**人为改坏的步骤序列**喂给它。
 */
export function auditClosureSteps(steps: readonly RunClosureStep[]): { ok: boolean; reason: string } {
  const missing = RUN_CLOSURE_STEPS.filter((s) => !steps.includes(s));
  if (steps.length !== RUN_CLOSURE_STEPS.length || missing.length > 0) {
    return {
      ok: false,
      reason: `步数不对: 走了 ${steps.length} 步, 冻结面是 ${RUN_CLOSURE_STEPS.length} 步 (缺: ${missing.join(',') || '无'})`,
    };
  }
  for (const [i, expected] of RUN_CLOSURE_STEPS.entries()) {
    if (steps[i] !== expected) {
      return { ok: false, reason: `第 ${i + 1} 步是 ${String(steps[i])}, 冻结顺序要求 ${expected}` };
    }
  }
  return { ok: true, reason: `ok: ${RUN_CLOSURE_STEPS.length} 步按 §5 顺序走完` };
}
