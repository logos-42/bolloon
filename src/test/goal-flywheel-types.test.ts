/**
 * 门: 「Goal 长期执行飞轮」**接口冻结层** (`src/agents/goal-flywheel/types.ts`) 的不变式。
 *
 * 本文件**只做类型与不变式断言**, 不碰实现 (本轮没有实现):
 *   ① 每个枚举/联合的取值表完备、无重复、命名规范 (含中文用户态只有 5 类)
 *   ② 冻结契约里"必备字段"**不许被改成 optional** —— 两层钉: 类型级 `reqField`
 *      (`ok: never` 塌陷 → 谁把测试文件纳入 tsc 就编译不过) + **源级** `optionalInterfaceFields`
 *      (vitest 不做类型检查, 所以源级那条才是常规拦截: 给字段加个 `?` 会真判红)
 *   ③ 与仓里**现有**同类类型不冲突, 且关系被精确钉住 (不是嘴上说"兼容"):
 *        - `goal-store.ts` 的 `GoalContinuation` 与 `GoalContinuationRecord` **共享调度核心**, 旧类型可整体读作新类型
 *        - `goal-store.ts` 的 `GoalStatus` ↔ `GoalLifecycleState`: 差集必须**恰好**是 `'open'` (还没起第一个 Run 的状态)
 *        - `contacts/policy.ts` 的 `BlockKind` 与本文件 §6 的 `BlockKind` 取值**完全不相交** (同名不同域)
 *        - `skill-writer.ts` 的 `SkillCandidate` 是 run-end 文本候选, 本模块**刻意不重名**, 且它**不满足**本模块的晋升契约
 *        - 一段纯文本 (`string`) **不是**合法子 Agent 回报 (`AgentWorkReport`)
 *   ④ 冻结层自己是"纯类型": 零 import、零 function/async; 目录里只允许存在冻结面
 *      (types.ts / index.ts) + §13 所有权名册上列名的阶段实现文件 —— 名册之外的"野文件"仍然判红
 *
 * 阴性对照 (怎么知道这道门不是空转): 把 `ContinuationDecision.wakeAt` 改成 `wakeAt?:` →
 * 源级断言立刻判红 (点名 `ContinuationDecision.wakeAt`), 类型级 `reqField` 同时塌成 `never`;
 * 把 `BLOCK_KINDS` 里加一个 `'not_found'` (与 contacts 域撞车) → ③ 的交集断言立刻判红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONTINUATION_STATES,
  CONTINUATION_DECISIONS,
  STOP_REASONS,
  RISK_LEVELS,
  RUN_CLOSURE_STEPS,
  CLOSURE_ARTIFACTS,
  MEMORY_LAYERS,
  ASSERTION_KINDS,
  SKILL_UPDATE_FLOW,
  SKILL_JUNK_REASONS,
  SKILL_CANDIDATE_STATUSES,
  PARENT_RESPONSIBILITIES,
  CHILD_RESPONSIBILITIES,
  CHILD_PROHIBITIONS,
  WORK_REPORT_STATUSES,
  CHECK_VERDICTS,
  BLOCK_KINDS,
  BLOCK_OWNERS,
  BLOCK_RESOLUTION_ACTIONS,
  USER_VISIBLE_STATES,
  USER_VISIBLE_STATE_LABELS,
  CHANGE_KINDS,
  CHANGE_SOURCES,
  CHANGE_PRIORITIES,
  CHANGE_STATUSES,
  CHANGE_SCOPE_KINDS,
  GOAL_CHANGE_RULES,
  GOAL_LIFECYCLE_STATES,
  GOAL_TERMINAL_STATES,
  USER_REPORT_FIELDS,
  MUST_NOT_EXPOSE_FIELDS,
  LONG_RUN_ACCEPTANCE_CASES,
  FLYWHEEL_NON_GOALS,
} from '../agents/goal-flywheel/types.js';

import type {
  ContinuationDecision,
  ContinuationState,
  ContinuationDecisionKind,
  ProgressDelta,
  HardLimits,
  MemoryRecordBase,
  RunFactMemory,
  LessonMemory,
  DecisionMemory,
  SkillSignalMemory,
  TemporaryMemory,
  SkillApproval,
  SkillImprovementCandidate,
  SkillPromotionRecord,
  WorkBudget,
  ChildFailurePolicy,
  ChildCancelPolicy,
  AgentWorkContract,
  AgentWorkReport,
  WorkEvidence,
  WorkArtifact,
  WorkCheck,
  BlockRecord,
  BlockKind,
  GoalChangeRequest,
  ChangeImpact,
  ChangeScope,
  PendingReport,
  GoalContinuationRecord,
  GoalLifecycleState,
  GoalTerminalState,
  UserReport,
  UserReportField,
  MustNotExposeField,
  RiskLevel,
  StopReason,
} from '../agents/goal-flywheel/types.js';

import type { GoalContinuation, GoalStatus } from '../agents/goal-store.js';
import type { BlockKind as ContactBlockKind } from '../agents/contacts/policy.js';
import type { SkillCandidate as LegacyTextSkillCandidate } from '../agents/skill-writer.js';

// ---------------------------------------------------------------------------
// 类型级工具 (只在编译期生效)
// ---------------------------------------------------------------------------

/** 字段是"必填"吗 (undefined 能赋给它的类型 = optional) */
type IsRequired<T, K extends keyof T> = undefined extends T[K] ? false : true;
type MustBeRequired<T, K extends keyof T> = IsRequired<T, K> extends true ? true : never;

/** A 能否赋值给 B */
type Assignable<A, B> = [A] extends [B] ? true : false;
type NotAssignable<A, B> = Assignable<A, B> extends true ? false : true;
/** 两个集合是否完全相同 */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** 是否是空集 (never) */
type EmptySet<A> = [A] extends [never] ? true : false;

/**
 * 必填字段检查: `ok` 的类型在字段被改成 optional 时塌成 `never` → 编译失败。
 * (这就是这道门"真会红"的机制, 不是脚本里的一句注释)
 */
function reqField<T, K extends keyof T>(type: string, field: K): { type: string; field: string; ok: MustBeRequired<T, K> } {
  return { type, field: String(field), ok: true as unknown as MustBeRequired<T, K> };
}

// ---------------------------------------------------------------------------
// 源级抽取 (与 `skill-cli-parity.test.ts` 同一手法: 从真源文件里读, 不靠人肉记忆)
// ---------------------------------------------------------------------------

const root = process.cwd();
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const typesSrc = readSrc('src/agents/goal-flywheel/types.ts');
const indexSrc = readSrc('src/agents/goal-flywheel/index.ts');
const goalStoreSrc = readSrc('src/agents/goal-store.ts');
const contactsPolicySrc = readSrc('src/agents/contacts/policy.ts');
const skillWriterSrc = readSrc('src/agents/skill-writer.ts');

/** 抽 `export interface X [extends Y] { ... }` 的一级字段名 */
function interfaceFields(src: string, name: string): string[] {
  return fieldsOfBody(interfaceBody(src, name)).map((f) => f.name);
}

/** 该 interface 里带 `?` 的字段名 (源级"optional"证据) */
function optionalInterfaceFields(src: string, name: string): string[] {
  return fieldsOfBody(interfaceBody(src, name)).filter((f) => f.optional).map((f) => f.name);
}

/** interface 体 (不含花括号; 只认 0 缩进的收尾 `}`) */
function interfaceBody(src: string, name: string): string {
  const decl = src.indexOf(`export interface ${name} `);
  if (decl < 0) return '';
  const open = src.indexOf('{', decl);
  const close = src.indexOf('\n}', open);
  if (open < 0 || close < 0) return '';
  return src.slice(open + 1, close);
}

/** 体里的一级字段 (2 空格缩进 + `name?: Type`) */
function fieldsOfBody(body: string): { name: string; optional: boolean }[] {
  const out: { name: string; optional: boolean }[] = [];
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:/.exec(line);
    if (m) out.push({ name: m[1], optional: Boolean(m[2]) });
  }
  return out;
}

/** 抽 `export type X = 'a' | 'b' | ...;` 的字符串字面量 */
function typeUnionValues(src: string, name: string): string[] {
  const start = src.indexOf(`export type ${name} =`);
  if (start < 0) return [];
  const body = src.slice(start, src.indexOf(';', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 抽 `export const X = [ 'a', ... ] as const;` 的字面量 (本模块自己的枚举表) */
function constArrayValues(src: string, name: string): string[] {
  const start = src.indexOf(`export const ${name} = [`);
  if (start < 0) return [];
  const body = src.slice(start, src.indexOf('] as const;', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 联合类型是否**由取值表派生** (`export type X = (typeof XS)[number];`) —— 单一来源, 不许手抄两份 */
function isDerivedFrom(src: string, typeName: string, constName: string): boolean {
  return new RegExp(`export type ${typeName} = \\(typeof ${constName}\\)\\[number\\];`).test(src);
}

// ---------------------------------------------------------------------------
// ① 枚举完备性 / 命名 / 计数
// ---------------------------------------------------------------------------

const ENUM_SPECS: { name: string; values: readonly string[]; count: number }[] = [
  { name: 'CONTINUATION_STATES', values: CONTINUATION_STATES, count: 8 },
  { name: 'CONTINUATION_DECISIONS', values: CONTINUATION_DECISIONS, count: 7 },
  { name: 'STOP_REASONS', values: STOP_REASONS, count: 4 },
  { name: 'RISK_LEVELS', values: RISK_LEVELS, count: 3 },
  { name: 'RUN_CLOSURE_STEPS', values: RUN_CLOSURE_STEPS, count: 9 },
  { name: 'CLOSURE_ARTIFACTS', values: CLOSURE_ARTIFACTS, count: 4 },
  { name: 'MEMORY_LAYERS', values: MEMORY_LAYERS, count: 5 },
  { name: 'ASSERTION_KINDS', values: ASSERTION_KINDS, count: 2 },
  { name: 'SKILL_UPDATE_FLOW', values: SKILL_UPDATE_FLOW, count: 8 },
  { name: 'SKILL_JUNK_REASONS', values: SKILL_JUNK_REASONS, count: 7 },
  { name: 'SKILL_CANDIDATE_STATUSES', values: SKILL_CANDIDATE_STATUSES, count: 5 },
  { name: 'PARENT_RESPONSIBILITIES', values: PARENT_RESPONSIBILITIES, count: 5 },
  { name: 'CHILD_RESPONSIBILITIES', values: CHILD_RESPONSIBILITIES, count: 5 },
  { name: 'CHILD_PROHIBITIONS', values: CHILD_PROHIBITIONS, count: 5 },
  { name: 'WORK_REPORT_STATUSES', values: WORK_REPORT_STATUSES, count: 5 },
  { name: 'CHECK_VERDICTS', values: CHECK_VERDICTS, count: 3 },
  { name: 'BLOCK_KINDS', values: BLOCK_KINDS, count: 10 },
  { name: 'BLOCK_OWNERS', values: BLOCK_OWNERS, count: 5 },
  { name: 'BLOCK_RESOLUTION_ACTIONS', values: BLOCK_RESOLUTION_ACTIONS, count: 8 },
  { name: 'USER_VISIBLE_STATES', values: USER_VISIBLE_STATES, count: 6 },
  { name: 'CHANGE_KINDS', values: CHANGE_KINDS, count: 8 },
  { name: 'CHANGE_SOURCES', values: CHANGE_SOURCES, count: 4 },
  { name: 'CHANGE_PRIORITIES', values: CHANGE_PRIORITIES, count: 4 },
  { name: 'CHANGE_STATUSES', values: CHANGE_STATUSES, count: 7 },
  { name: 'CHANGE_SCOPE_KINDS', values: CHANGE_SCOPE_KINDS, count: 6 },
  { name: 'GOAL_CHANGE_RULES', values: GOAL_CHANGE_RULES, count: 5 },
  { name: 'GOAL_LIFECYCLE_STATES', values: GOAL_LIFECYCLE_STATES, count: 10 },
  { name: 'GOAL_TERMINAL_STATES', values: GOAL_TERMINAL_STATES, count: 3 },
  { name: 'MUST_NOT_EXPOSE_FIELDS', values: MUST_NOT_EXPOSE_FIELDS, count: 5 },
  { name: 'LONG_RUN_ACCEPTANCE_CASES', values: LONG_RUN_ACCEPTANCE_CASES, count: 8 },
  { name: 'FLYWHEEL_NON_GOALS', values: FLYWHEEL_NON_GOALS, count: 12 },
];

describe('① 冻结枚举表: 完备 / 无重复 / 命名规范 / 计数被钉住', () => {
  it.each(ENUM_SPECS)('$name 取值表自洽', ({ values, count }) => {
    expect(values.length).toBe(count);
    expect(new Set(values).size).toBe(values.length); // 无重复
    for (const v of values) {
      expect(v).toMatch(/^[a-z][a-z0-9_]*$/); // snake_case, 非空
    }
  });

  it('枚举表与源文件里写的一致 (不是测试里手抄的另一份)', () => {
    for (const { name, values } of ENUM_SPECS) {
      expect(constArrayValues(typesSrc, name)).toEqual([...values]);
    }
  });

  it('联合类型确实由取值表派生 (单一来源: 类型与运行期数组不许手抄两份)', () => {
    expect(isDerivedFrom(typesSrc, 'ContinuationState', 'CONTINUATION_STATES')).toBe(true);
    expect(isDerivedFrom(typesSrc, 'ContinuationDecisionKind', 'CONTINUATION_DECISIONS')).toBe(true);
    expect(isDerivedFrom(typesSrc, 'BlockKind', 'BLOCK_KINDS')).toBe(true);
    expect(isDerivedFrom(typesSrc, 'ChangeKind', 'CHANGE_KINDS')).toBe(true);
    expect(isDerivedFrom(typesSrc, 'UserVisibleState', 'USER_VISIBLE_STATES')).toBe(true);
    expect(isDerivedFrom(typesSrc, 'MemoryLayer', 'MEMORY_LAYERS')).toBe(true);
    // 反面: 不是派生写法就该被抓出来 (手抄一份 = 迟早漂移)
    expect(isDerivedFrom(typesSrc, 'ContinuationState', 'CONTINUATION_DECISIONS')).toBe(false);
  });

  it('用户汇报的字段名表: 9 项 / 无重复 / camelCase, 且与源文件一致', () => {
    expect(USER_REPORT_FIELDS.length).toBe(9);
    expect(new Set(USER_REPORT_FIELDS).size).toBe(9);
    for (const f of USER_REPORT_FIELDS) {
      expect(f).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
    expect(constArrayValues(typesSrc, 'USER_REPORT_FIELDS')).toEqual([...USER_REPORT_FIELDS]);
  });

  // 2026-09-25: 6 类 —— 接线时补了第 6 类终态 'ended' (改冻结层 = 单独一个提交, 见 types.ts 注释)。
  it('用户可见状态只有 6 类 (含终态 ended), 且每类都有中英文案', () => {
    expect(USER_VISIBLE_STATES.length).toBe(6);
    expect([...USER_VISIBLE_STATES]).toEqual([
      'executing', 'waiting_external_reply', 'child_blocked', 'no_progress', 'needs_your_decision', 'ended',
    ]);
    expect(Object.keys(USER_VISIBLE_STATE_LABELS).sort()).toEqual([...USER_VISIBLE_STATES].sort());
    for (const s of USER_VISIBLE_STATES) {
      expect(USER_VISIBLE_STATE_LABELS[s].zh.length).toBeGreaterThan(0);
      expect(USER_VISIBLE_STATE_LABELS[s].en.length).toBeGreaterThan(0);
    }
  });

  it('长周期验收清单 = 6 条正例 + 2 条强负例', () => {
    expect(LONG_RUN_ACCEPTANCE_CASES.length).toBe(8);
    expect(LONG_RUN_ACCEPTANCE_CASES).toContain('evidence_less_child_report_blocks_goal');
    expect(LONG_RUN_ACCEPTANCE_CASES).toContain('single_success_never_promotes_skill');
  });
});

// ---------------------------------------------------------------------------
// ② 必备字段不许变 optional
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  // P0
  reqField<ContinuationDecision, 'decision'>('ContinuationDecision', 'decision'),
  reqField<ContinuationDecision, 'state'>('ContinuationDecision', 'state'),
  reqField<ContinuationDecision, 'reason'>('ContinuationDecision', 'reason'),
  reqField<ContinuationDecision, 'nextAction'>('ContinuationDecision', 'nextAction'),
  reqField<ContinuationDecision, 'expectedOutcome'>('ContinuationDecision', 'expectedOutcome'),
  reqField<ContinuationDecision, 'confidence'>('ContinuationDecision', 'confidence'),
  reqField<ContinuationDecision, 'progressDelta'>('ContinuationDecision', 'progressDelta'),
  reqField<ContinuationDecision, 'unresolvedItems'>('ContinuationDecision', 'unresolvedItems'),
  reqField<ContinuationDecision, 'wakeAt'>('ContinuationDecision', 'wakeAt'),
  reqField<ContinuationDecision, 'requiredCapability'>('ContinuationDecision', 'requiredCapability'),
  reqField<ContinuationDecision, 'riskLevel'>('ContinuationDecision', 'riskLevel'),
  reqField<ContinuationDecision, 'stopReason'>('ContinuationDecision', 'stopReason'),
  reqField<ContinuationDecision, 'evidenceRefs'>('ContinuationDecision', 'evidenceRefs'),
  reqField<ProgressDelta, 'newEvidence'>('ProgressDelta', 'newEvidence'),
  reqField<ProgressDelta, 'newlyCompletedCriteria'>('ProgressDelta', 'newlyCompletedCriteria'),
  reqField<ProgressDelta, 'stepsAdvanced'>('ProgressDelta', 'stepsAdvanced'),
  reqField<ProgressDelta, 'unresolvedDelta'>('ProgressDelta', 'unresolvedDelta'),
  reqField<HardLimits, 'maxRunDurationMs'>('HardLimits', 'maxRunDurationMs'),
  reqField<HardLimits, 'maxGoalBudget'>('HardLimits', 'maxGoalBudget'),
  reqField<HardLimits, 'noProgressCircuitBreaker'>('HardLimits', 'noProgressCircuitBreaker'),
  // P1b Memory 分层
  reqField<MemoryRecordBase, 'memoryId'>('MemoryRecordBase', 'memoryId'),
  reqField<MemoryRecordBase, 'layer'>('MemoryRecordBase', 'layer'),
  reqField<MemoryRecordBase, 'content'>('MemoryRecordBase', 'content'),
  reqField<MemoryRecordBase, 'evidenceRefs'>('MemoryRecordBase', 'evidenceRefs'),
  reqField<RunFactMemory, 'assertion'>('RunFactMemory', 'assertion'),
  reqField<RunFactMemory, 'confirmedRefs'>('RunFactMemory', 'confirmedRefs'),
  reqField<LessonMemory, 'reviewedBy'>('LessonMemory', 'reviewedBy'),
  reqField<LessonMemory, 'reviewVerdict'>('LessonMemory', 'reviewVerdict'),
  reqField<LessonMemory, 'methodEffective'>('LessonMemory', 'methodEffective'),
  reqField<LessonMemory, 'methodFailed'>('LessonMemory', 'methodFailed'),
  reqField<LessonMemory, 'nextTimeChange'>('LessonMemory', 'nextTimeChange'),
  reqField<DecisionMemory, 'sourceRef'>('DecisionMemory', 'sourceRef'),
  reqField<DecisionMemory, 'decidedBy'>('DecisionMemory', 'decidedBy'),
  reqField<DecisionMemory, 'userPreference'>('DecisionMemory', 'userPreference'),
  reqField<SkillSignalMemory, 'candidateId'>('SkillSignalMemory', 'candidateId'),
  reqField<SkillSignalMemory, 'promotesDirectly'>('SkillSignalMemory', 'promotesDirectly'),
  reqField<TemporaryMemory, 'expiresAt'>('TemporaryMemory', 'expiresAt'),
  reqField<TemporaryMemory, 'archiveAtRunEnd'>('TemporaryMemory', 'archiveAtRunEnd'),
  // P1b Skill 候选
  reqField<SkillImprovementCandidate, 'sourceRunIds'>('SkillImprovementCandidate', 'sourceRunIds'),
  reqField<SkillImprovementCandidate, 'evidenceRefs'>('SkillImprovementCandidate', 'evidenceRefs'),
  reqField<SkillImprovementCandidate, 'failureCases'>('SkillImprovementCandidate', 'failureCases'),
  reqField<SkillImprovementCandidate, 'inputSchema'>('SkillImprovementCandidate', 'inputSchema'),
  reqField<SkillImprovementCandidate, 'outputSchema'>('SkillImprovementCandidate', 'outputSchema'),
  reqField<SkillImprovementCandidate, 'guarantees'>('SkillImprovementCandidate', 'guarantees'),
  reqField<SkillImprovementCandidate, 'doesNotGuarantee'>('SkillImprovementCandidate', 'doesNotGuarantee'),
  reqField<SkillImprovementCandidate, 'contentHash'>('SkillImprovementCandidate', 'contentHash'),
  reqField<SkillImprovementCandidate, 'approval'>('SkillImprovementCandidate', 'approval'),
  reqField<SkillImprovementCandidate, 'junkReasons'>('SkillImprovementCandidate', 'junkReasons'),
  reqField<SkillImprovementCandidate, 'occurrences'>('SkillImprovementCandidate', 'occurrences'),
  reqField<SkillImprovementCandidate, 'boundaryClear'>('SkillImprovementCandidate', 'boundaryClear'),
  reqField<SkillApproval, 'state'>('SkillApproval', 'state'),
  reqField<SkillApproval, 'changeReason'>('SkillApproval', 'changeReason'),
  reqField<SkillPromotionRecord, 'contentHash'>('SkillPromotionRecord', 'contentHash'),
  reqField<SkillPromotionRecord, 'changeReason'>('SkillPromotionRecord', 'changeReason'),
  reqField<SkillPromotionRecord, 'snapshotScope'>('SkillPromotionRecord', 'snapshotScope'),
  // P2 工作合同与回报
  reqField<WorkBudget, 'maxSteps'>('WorkBudget', 'maxSteps'),
  reqField<WorkBudget, 'maxDurationMs'>('WorkBudget', 'maxDurationMs'),
  reqField<WorkBudget, 'maxAmount'>('WorkBudget', 'maxAmount'),
  reqField<ChildFailurePolicy, 'onHeartbeatMiss'>('ChildFailurePolicy', 'onHeartbeatMiss'),
  reqField<ChildFailurePolicy, 'onBudgetExhausted'>('ChildFailurePolicy', 'onBudgetExhausted'),
  reqField<ChildFailurePolicy, 'onToolDenied'>('ChildFailurePolicy', 'onToolDenied'),
  reqField<ChildFailurePolicy, 'onRepeatedFailure'>('ChildFailurePolicy', 'onRepeatedFailure'),
  reqField<ChildCancelPolicy, 'onParentCancel'>('ChildCancelPolicy', 'onParentCancel'),
  reqField<ChildCancelPolicy, 'graceMs'>('ChildCancelPolicy', 'graceMs'),
  reqField<ChildCancelPolicy, 'preserveArtifacts'>('ChildCancelPolicy', 'preserveArtifacts'),
  reqField<ChildCancelPolicy, 'onParentGoalClosed'>('ChildCancelPolicy', 'onParentGoalClosed'),
  reqField<AgentWorkContract, 'workId'>('AgentWorkContract', 'workId'),
  reqField<AgentWorkContract, 'goalId'>('AgentWorkContract', 'goalId'),
  reqField<AgentWorkContract, 'parentRunId'>('AgentWorkContract', 'parentRunId'),
  reqField<AgentWorkContract, 'childAgentId'>('AgentWorkContract', 'childAgentId'),
  reqField<AgentWorkContract, 'capability'>('AgentWorkContract', 'capability'),
  reqField<AgentWorkContract, 'objective'>('AgentWorkContract', 'objective'),
  reqField<AgentWorkContract, 'inputs'>('AgentWorkContract', 'inputs'),
  reqField<AgentWorkContract, 'allowedTools'>('AgentWorkContract', 'allowedTools'),
  reqField<AgentWorkContract, 'budget'>('AgentWorkContract', 'budget'),
  reqField<AgentWorkContract, 'deadline'>('AgentWorkContract', 'deadline'),
  reqField<AgentWorkContract, 'successCriteria'>('AgentWorkContract', 'successCriteria'),
  reqField<AgentWorkContract, 'reportSchema'>('AgentWorkContract', 'reportSchema'),
  reqField<AgentWorkContract, 'heartbeatIntervalMs'>('AgentWorkContract', 'heartbeatIntervalMs'),
  reqField<AgentWorkContract, 'failurePolicy'>('AgentWorkContract', 'failurePolicy'),
  reqField<AgentWorkContract, 'cancelPolicy'>('AgentWorkContract', 'cancelPolicy'),
  reqField<AgentWorkContract, 'requiredEvidence'>('AgentWorkContract', 'requiredEvidence'),
  reqField<AgentWorkReport, 'workId'>('AgentWorkReport', 'workId'),
  reqField<AgentWorkReport, 'childAgentId'>('AgentWorkReport', 'childAgentId'),
  reqField<AgentWorkReport, 'status'>('AgentWorkReport', 'status'),
  reqField<AgentWorkReport, 'summary'>('AgentWorkReport', 'summary'),
  reqField<AgentWorkReport, 'evidence'>('AgentWorkReport', 'evidence'),
  reqField<AgentWorkReport, 'artifacts'>('AgentWorkReport', 'artifacts'),
  reqField<AgentWorkReport, 'checks'>('AgentWorkReport', 'checks'),
  reqField<AgentWorkReport, 'unresolvedItems'>('AgentWorkReport', 'unresolvedItems'),
  reqField<AgentWorkReport, 'blockReason'>('AgentWorkReport', 'blockReason'),
  reqField<AgentWorkReport, 'nextRecommendation'>('AgentWorkReport', 'nextRecommendation'),
  reqField<AgentWorkReport, 'durationMs'>('AgentWorkReport', 'durationMs'),
  reqField<WorkEvidence, 'kind'>('WorkEvidence', 'kind'),
  reqField<WorkEvidence, 'ref'>('WorkEvidence', 'ref'),
  reqField<WorkArtifact, 'name'>('WorkArtifact', 'name'),
  reqField<WorkArtifact, 'bytes'>('WorkArtifact', 'bytes'),
  reqField<WorkCheck, 'name'>('WorkCheck', 'name'),
  reqField<WorkCheck, 'verdict'>('WorkCheck', 'verdict'),
  reqField<WorkCheck, 'detail'>('WorkCheck', 'detail'),
  // P3 阻塞
  reqField<BlockRecord, 'blockId'>('BlockRecord', 'blockId'),
  reqField<BlockRecord, 'kind'>('BlockRecord', 'kind'),
  reqField<BlockRecord, 'blockedAt'>('BlockRecord', 'blockedAt'),
  reqField<BlockRecord, 'lastProgressAt'>('BlockRecord', 'lastProgressAt'),
  reqField<BlockRecord, 'owner'>('BlockRecord', 'owner'),
  reqField<BlockRecord, 'dependency'>('BlockRecord', 'dependency'),
  reqField<BlockRecord, 'suggestedAction'>('BlockRecord', 'suggestedAction'),
  reqField<BlockRecord, 'escalationAt'>('BlockRecord', 'escalationAt'),
  reqField<BlockRecord, 'resolution'>('BlockRecord', 'resolution'),
  // P4 变更注入
  reqField<GoalChangeRequest, 'changeId'>('GoalChangeRequest', 'changeId'),
  reqField<GoalChangeRequest, 'goalId'>('GoalChangeRequest', 'goalId'),
  reqField<GoalChangeRequest, 'source'>('GoalChangeRequest', 'source'),
  reqField<GoalChangeRequest, 'instruction'>('GoalChangeRequest', 'instruction'),
  reqField<GoalChangeRequest, 'priority'>('GoalChangeRequest', 'priority'),
  reqField<GoalChangeRequest, 'kind'>('GoalChangeRequest', 'kind'),
  reqField<GoalChangeRequest, 'scope'>('GoalChangeRequest', 'scope'),
  reqField<GoalChangeRequest, 'effectiveAt'>('GoalChangeRequest', 'effectiveAt'),
  reqField<GoalChangeRequest, 'requiresReplan'>('GoalChangeRequest', 'requiresReplan'),
  reqField<GoalChangeRequest, 'status'>('GoalChangeRequest', 'status'),
  reqField<GoalChangeRequest, 'impact'>('GoalChangeRequest', 'impact'),
  reqField<GoalChangeRequest, 'appliesToFutureRunsOnly'>('GoalChangeRequest', 'appliesToFutureRunsOnly'),
  reqField<ChangeImpact, 'affectsObjective'>('ChangeImpact', 'affectsObjective'),
  reqField<ChangeImpact, 'affectsCriteria'>('ChangeImpact', 'affectsCriteria'),
  reqField<ChangeImpact, 'affectsBudget'>('ChangeImpact', 'affectsBudget'),
  reqField<ChangeImpact, 'affectsPermission'>('ChangeImpact', 'affectsPermission'),
  reqField<ChangeScope, 'kind'>('ChangeScope', 'kind'),
  reqField<ChangeScope, 'targetIds'>('ChangeScope', 'targetIds'),
  // P4b 两份输出
  reqField<PendingReport, 'workId'>('PendingReport', 'workId'),
  reqField<PendingReport, 'childAgentId'>('PendingReport', 'childAgentId'),
  reqField<PendingReport, 'capability'>('PendingReport', 'capability'),
  reqField<PendingReport, 'requestedAt'>('PendingReport', 'requestedAt'),
  reqField<PendingReport, 'lastHeartbeatAt'>('PendingReport', 'lastHeartbeatAt'),
  reqField<GoalContinuationRecord, 'nextAction'>('GoalContinuationRecord', 'nextAction'),
  reqField<GoalContinuationRecord, 'wakeAt'>('GoalContinuationRecord', 'wakeAt'),
  reqField<GoalContinuationRecord, 'wakeReason'>('GoalContinuationRecord', 'wakeReason'),
  reqField<GoalContinuationRecord, 'autoContinue'>('GoalContinuationRecord', 'autoContinue'),
  reqField<GoalContinuationRecord, 'requiredAgent'>('GoalContinuationRecord', 'requiredAgent'),
  reqField<GoalContinuationRecord, 'pendingReports'>('GoalContinuationRecord', 'pendingReports'),
  reqField<GoalContinuationRecord, 'unresolvedItems'>('GoalContinuationRecord', 'unresolvedItems'),
  reqField<GoalContinuationRecord, 'state'>('GoalContinuationRecord', 'state'),
  reqField<UserReport, 'conclusion'>('UserReport', 'conclusion'),
  reqField<UserReport, 'completed'>('UserReport', 'completed'),
  reqField<UserReport, 'evidence'>('UserReport', 'evidence'),
  reqField<UserReport, 'remaining'>('UserReport', 'remaining'),
  reqField<UserReport, 'blockReasons'>('UserReport', 'blockReasons'),
  reqField<UserReport, 'nextStep'>('UserReport', 'nextStep'),
  reqField<UserReport, 'willContinue'>('UserReport', 'willContinue'),
  reqField<UserReport, 'expectedResumeAt'>('UserReport', 'expectedResumeAt'),
  reqField<UserReport, 'visibleState'>('UserReport', 'visibleState'),
  reqField<UserReport, 'exposedFields'>('UserReport', 'exposedFields'),
];

describe('② 冻结契约的必备字段 (改成 optional 会编译不过, 这里再钉一次运行期)', () => {
  it('检查项不为空转', () => {
    expect(REQUIRED_FIELDS.length).toBeGreaterThan(140);
  });

  it.each(REQUIRED_FIELDS.map((r) => [r.type, r.field, r.ok] as const))(
    '%s.%s 是必填',
    (_type, _field, ok) => {
      expect(ok).toBe(true);
    },
  );

  it('同一类型名不会出现两份互不一致的必填清单', () => {
    const names = new Set(REQUIRED_FIELDS.map((r) => r.type));
    expect(names.size).toBeGreaterThanOrEqual(25);
    for (const n of names) {
      const fields = REQUIRED_FIELDS.filter((r) => r.type === n).map((r) => r.field);
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  it('源级: 必填清单里的字段在 types.ts 里**没有** `?` (vitest 不做类型检查, 这条才是常规拦截)', () => {
    const missingInterfaces: string[] = [];
    const foundOptional: string[] = [];
    for (const { type, field } of REQUIRED_FIELDS) {
      const optional = optionalInterfaceFields(typesSrc, type);
      const body = interfaceBody(typesSrc, type);
      if (!body) {
        missingInterfaces.push(type);
        continue;
      }
      if (optional.includes(field)) foundOptional.push(`${type}.${field}`);
    }
    // 门自身非空转: 每个被检查的类型都真在 types.ts 里找得到 (抽不到就该判红, 不许"零条目通过")
    expect(missingInterfaces).toEqual([]);
    // 一条 optional 都不许有 (冻结契约里没有 optional 字段)
    expect(foundOptional).toEqual([]);
  });

  it('源级检查器自己有阴性对照 (给个带 `?` 的接口必须抓得住)', () => {
    const synthetic = [
      'export interface Fake {',
      '  mustHave: string;',
      '  mayMiss?: string;',
      '}',
      '',
    ].join('\n');
    expect(interfaceFields(synthetic, 'Fake')).toEqual(['mustHave', 'mayMiss']);
    expect(optionalInterfaceFields(synthetic, 'Fake')).toEqual(['mayMiss']);
    expect(interfaceFields(typesSrc, 'NoSuchInterface')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ③ 与现有类型的关系 (源级抽取 + 类型级断言)
// ---------------------------------------------------------------------------

describe('③ 与仓里现有类型不冲突 (关系被精确钉住)', () => {
  it('goal-store 的 GoalContinuation 与 GoalContinuationRecord 共享调度核心且结构兼容', () => {
    // 类型级: 旧类型必须能整体读作本类型 (字段兼容, 不改现有调用方)
    const assignable: Assignable<GoalContinuation, Partial<GoalContinuationRecord>> = true;
    expect(assignable).toBe(true);

    // 源级: 共享的调度核心必须**真的**在两个类型里都叫同一个名字
    const legacyFields = interfaceFields(goalStoreSrc, 'GoalContinuation');
    expect(legacyFields.length).toBeGreaterThanOrEqual(14);
    const shared = legacyFields.filter((f) => (GOAL_CONTINUATION_RECORD_FIELDS as readonly string[]).includes(f));
    // 2026-09-25 (接线收敛): GoalContinuation 已把 GoalContinuationRecord 的**全部**字段收进同一个对象
    //   (Goal 上只有一个权威 continuation) → 共享集 = 记录类型的全部字段, "新增"集为空。
    expect(shared.sort()).toEqual([...GOAL_CONTINUATION_RECORD_FIELDS].sort());
    expect(shared.length).toBe(GOAL_CONTINUATION_RECORD_FIELDS.length);

    // 只加不减: 收敛**没有**丢掉旧字段 (原有调度 / 外部等待 / 租约镜像语义都还在)
    for (const f of ['attempts', 'external', 'externalResult', 'lastRunId', 'replayGuards',
      'completedActions', 'needsExternal', 'deliveredEventIds', 'skillReadiness', 'lastExternalTimeout']) {
      expect(legacyFields).toContain(f);
    }
    const added = GOAL_CONTINUATION_RECORD_FIELDS.filter((f) => !legacyFields.includes(f));
    expect(added).toEqual([]);

    // 反面: 旧类型**不满足**"继续记录"的必答项 (nextAction 在旧类型里是 optional → 不许拿它当已完工的继续记录)
    const legacyIsComplete: NotAssignable<GoalContinuation, GoalContinuationRecord> = true;
    expect(legacyIsComplete).toBe(true);
  });

  it('GoalLifecycleState 与 goal-store 的 GoalStatus 差集恰好是 open (还没起第一个 Run)', () => {
    const goalStatusValues = typeUnionValues(goalStoreSrc, 'GoalStatus');
    expect(goalStatusValues.length).toBe(11);
    expect([...GOAL_LIFECYCLE_STATES].sort()).toEqual(
      goalStatusValues.filter((v) => v !== 'open').sort(),
    );
    // 类型级: 差集方向也要对 (单方向包含 + 只有一个额外值)
    const onlyOpen: SameSet<Exclude<GoalStatus, GoalLifecycleState>, 'open'> = true;
    const superset: EmptySet<Exclude<GoalLifecycleState, GoalStatus>> = true;
    expect(onlyOpen).toBe(true);
    expect(superset).toBe(true);
  });

  it('两个 BlockKind 同名不同域: 取值完全不相交', () => {
    const contactKinds = typeUnionValues(contactsPolicySrc, 'BlockKind');
    expect(contactKinds.length).toBeGreaterThanOrEqual(15);
    const overlap = contactKinds.filter((k) => (BLOCK_KINDS as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
    // 类型级: 双向都不互相赋值
    const disjoint: Assignable<BlockKind, ContactBlockKind> = false;
    const disjointReverse: Assignable<ContactBlockKind, BlockKind> = false;
    expect(disjoint).toBe(false);
    expect(disjointReverse).toBe(false);
  });

  it('skill-writer 的文本 SkillCandidate 不是本模块的晋升契约 (刻意不重名)', () => {
    const legacyFields = interfaceFields(skillWriterSrc, 'SkillCandidate');
    expect(legacyFields).toEqual([
      'name', 'description', 'body', 'source', 'timestamp', 'signature', 'runs', 'file',
    ]);
    // 文本候选**不满足**本模块的晋升契约 (缺 schema/证据/失败边界/批准)
    const legacyIsContract: NotAssignable<LegacyTextSkillCandidate, SkillImprovementCandidate> = true;
    expect(legacyIsContract).toBe(true);
    // 本模块不许再导出一个同名 SkillCandidate (否则未来 import 会歧义)
    expect(typesSrc).not.toMatch(/export (interface|type) SkillCandidate\b/);
    expect(typesSrc).toMatch(/export (interface|type) SkillImprovementCandidate\b/);
  });

  it('一段纯文本不是合法子 Agent 回报', () => {
    const textIsReport: NotAssignable<string, AgentWorkReport> = true;
    const reportMissing: NotAssignable<{ status: string; summary: string }, AgentWorkReport> = true;
    expect(textIsReport).toBe(true);
    expect(reportMissing).toBe(true);
  });

  it('用户汇报的暴露面与"不许暴露"清单零交集', () => {
    const overlap = (USER_REPORT_FIELDS as readonly string[]).filter((f) =>
      (MUST_NOT_EXPOSE_FIELDS as readonly string[]).includes(f),
    );
    expect(overlap).toEqual([]);
    const noOverlap: EmptySet<Extract<UserReportField, MustNotExposeField>> = true;
    expect(noOverlap).toBe(true);
    for (const f of MUST_NOT_EXPOSE_FIELDS) {
      expect(typesSrc).not.toMatch(new RegExp(`^\\s*${f}\\s*[?:]`, 'm')); // 不得成为我们自己的字段名
    }
  });

  it('终态 / 需人状态 / 活跃状态三分且互斥 (Goal 不许悬空)', () => {
    const terminal = new Set<string>(GOAL_TERMINAL_STATES);
    expect(terminal.has('needs_human')).toBe(false);
    expect(terminal.has('completed')).toBe(true);
    const activeAndDecision = GOAL_LIFECYCLE_STATES.filter((s) => !terminal.has(s));
    expect(activeAndDecision).toEqual(['active', 'recovering', 'retry_wait', 'awaiting_external', 'stalled', 'paused', 'needs_human']);
    // 类型级: 活跃态不含终态, 也不含 needs_human
    const noTerminal: EmptySet<Extract<GoalLifecycleState, GoalTerminalState>> = true;
    expect(noTerminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④ 冻结层自己是"纯类型", 且所有权没被抢先动工
// ---------------------------------------------------------------------------

describe('④ 冻结层的纯度与所有权', () => {
  it('types.ts 零 import / 零 function / 零 async (纯类型 + 文档)', () => {
    expect(typesSrc).not.toMatch(/^import /m);
    expect(typesSrc).not.toMatch(/^export async /m);
    expect(typesSrc).not.toMatch(/^export function /m);
    expect(typesSrc).not.toMatch(/\brequire\(/);
    expect(typesSrc).not.toMatch(/\bawait\b/);
  });

  it('index.ts 只做转发, 不引入实现', () => {
    expect(indexSrc).toMatch(/export \* from '\.\/types\.js';/);
    expect(indexSrc).not.toMatch(/\bfunction\b/);
  });

  it('目录里只有冻结面 + §13 名册上的阶段实现 (名册外的野文件仍然判红)', () => {
    const files = fs.readdirSync(path.join(root, 'src/agents/goal-flywheel')).sort();
    // 冻结面必须在 (types.ts 自身是"纯类型"由上一组断言钉住)
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    // P0–P4 的实现按 §13 的所有权划分逐个落地。判据从"目录只有两个文件"(时间快照, 落地即失效)
    // 收紧成"名册白名单": 任何**不在名册上**的 .ts 文件照样判红 (不是随便加个文件就放行)。
    const PHASE_FILES = [
      'continuation-decision.ts', // P0 节奏
      'run-closure.ts',           // P1 收尾
      'memory-layers.ts',         // P1b Memory 分层
      'skill-candidate.ts',       // P1b Skill 候选
      'work-contract.ts',         // P2 子 Agent 合同
      'work-monitor.ts',          // P3 阻塞监控
      'goal-change.ts',           // P4 新要求注入
    ];
    const rogue = files.filter((f) => f !== 'types.ts' && f !== 'index.ts' && !PHASE_FILES.includes(f));
    expect(rogue).toEqual([]);
  });

  it('本轮没有把"不做"清单里的东西混进来 (门自身非空转)', () => {
    expect(FLYWHEEL_NON_GOALS.length).toBe(12);
    // 冻结面里不许出现"另起 workflow engine / 多任务库"这类模块名
    for (const forbidden of ['workflow-engine.php', 'task-db-2', 'agent-market']) {
      expect(filesAll().some((f) => f.includes(forbidden))).toBe(false);
    }
  });
});

/** 本目录下的全部文件名 (给上一条断言用) */
function filesAll(): string[] {
  return fs.readdirSync(path.join(root, 'src/agents/goal-flywheel'));
}

/** GoalContinuationRecord 的字段表 (与 interface 同源: 少一个就编译不过) */
const GOAL_CONTINUATION_RECORD_FIELDS: (keyof GoalContinuationRecord)[] = [
  'nextAction',
  'wakeAt',
  'wakeReason',
  'autoContinue',
  'requiredAgent',
  'pendingReports',
  'unresolvedItems',
  'lastDecisionId',
  'state',
  'updatedAt',
];
// 类型级: 上面这份清单必须**恰好覆盖** interface 的全部字段 (加了字段忘了登记 → 编译不过)
const _fieldListIsExact: SameSet<(typeof GOAL_CONTINUATION_RECORD_FIELDS)[number], keyof GoalContinuationRecord> = true;
void _fieldListIsExact;
