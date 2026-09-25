/**
 * goal-flywheel/types.ts — 「Goal 长期执行飞轮」**接口冻结层** (2026-09-25)
 *
 * 这一层**只有类型与文档**, 没有实现, 不改任何现有调用方。
 * 目的: 把已经存在但没收敛的能力, 收敛成一个**长期执行飞轮**的可复用接口面 ——
 * 而不是再造一个更大的 Agent 平台。
 *
 * 飞轮 (一轮的目标生命周期):
 *   目标 → 判断下一步 → 自主决定节奏 → 执行或派遣 → 监控阻塞 → 动态注入新要求
 *        → 汇总结果 → 写入 Memory → 形成 Skill 改进候选 → 下一次直接复用
 *
 * 与既有模块的关系 (刻意不重复、不冲突):
 *   - `goal-store.ts` 的 `GoalContinuation` 是**已有**的调度元数据 (nextAction/wakeAt/…)。
 *     本文件**不重复定义**它, 而是给出**冻结超集** `GoalContinuationRecord`
 *     (机器继续记录) —— 见 §7。两者必须结构兼容, 由 `goal-flywheel-types.test.ts` 钉住。
 *   - `skill-writer.ts` 的 `SkillCandidate` 是 run-end 的**文本候选** (name/description/body)。
 *     本飞轮的 Skill 改进候选是**更强的结构** (必须有输入输出 schema/失败边界/证据/批准),
 *     因此刻意命名为 `SkillImprovementCandidate` —— **不是同一个东西**, 见 §4。
 *   - `contacts/policy.ts` 的 `BlockKind` 是**联系方式策略域**的拒绝原因;
 *     本文件 §6 的 `BlockKind` 是**长期执行域**的阻塞类型。同名不同域, 永不合并。
 *   - `Watchdog/heartbeat` 只看进程存活; 本文件的 `BlockRecord` 看的是**任务有没有卡住**。
 *
 * 硬底线 (不是"任务节奏", 而是安全线): 单 Run 时间上限 · 单 Goal 预算上限 ·
 * 无进展熔断阈值 —— 见 `HardLimits`。**不再以「第几轮」作为继续依据**。
 */

// ============================================================================
// §0. 共同标量
// ============================================================================

/** ISO-8601 时间戳 (与全仓既有事实字段同一写法) */
export type IsoTimestamp = string;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// ============================================================================
// §1. P0 — 节奏由进展决定 (ContinuationDecision)
// ============================================================================

/** 长期执行的状态: 它描述"为什么下一步是它", 不描述"跑了第几轮" */
export const CONTINUATION_STATES = [
  'progressing',        // 有新的可核验进展
  'blocked',            // 被阻塞 (见 BlockRecord)
  'waiting_external',   // 等外部回话 (事件或 wakeAt 唤醒)
  'waiting_agent',      // 等子 Agent / 另一个执行者回报
  'needs_decision',     // 需要人做一个取舍
  'no_progress',        // 连续无新证据 / 无新完成判据 → stalled
  'completed',          // 判据全满足且有证据
  'failed',             // 判据不可能再满足 (不是"这次没跑好")
] as const;
export type ContinuationState = (typeof CONTINUATION_STATES)[number];

/** 每个 Run 结束必须产出的**唯一决策** (Agent 提, Supervisor 采用) */
export const CONTINUATION_DECISIONS = [
  'continue',    // 有进展 → 直接开下一个 Run
  'wait',        // 等外部/等时间 → 挂 wakeAt 或等事件
  'delegate',    // 需要另一个 Agent/能力 → 签 AgentWorkContract
  'ask_human',   // 需要人决定 (判据 / 预算 / 权限 / 取舍)
  'complete',    // 判据全满足且有证据
  'fail',        // 不可能再满足 (附原因)
  'pause',       // 人主动暂停 (不是自动决策)
] as const;
export type ContinuationDecisionKind = (typeof CONTINUATION_DECISIONS)[number];

/** Agent 判断"继续没有价值"时, 必须交出的理由 (由 Supervisor 负责真的停) */
export const STOP_REASONS = [
  'no_value_continuing',    // 继续也改变不了结果
  'objective_unreachable',  // 客观不可能 (缺条件/缺权限/物理限制)
  'duplicate_work',         // 与已完成的工作重复
  'out_of_scope',           // 超出了目标范围
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** 本轮的**进展证据** —— 没有它就没有"继续"的资格 (禁止用轮次/时长冒充进展) */
export interface ProgressDelta {
  /** 本轮新增的可核验证据 (引用 run/step/文件哈希/回执等) */
  newEvidence: string[];
  /** 本轮新满足的判据下标 (与 GoalRecord.completedCriteria 同一口径) */
  newlyCompletedCriteria: number[];
  /** 本轮真正推进的步数 (有产出的步, 不是"调用过工具") */
  stepsAdvanced: number;
  /** 与上一轮相比, 仍未解决项是变少还是没变 */
  unresolvedDelta: number;
}

/**
 * 每个 Run 结束产出的**结构化继续决策** (至少这些字段)。
 * 取值可以是 null (例如不等待就没有 wakeAt), 但**不允许缺字段** —— 缺字段 = 没做完收尾。
 */
export interface ContinuationDecision {
  decisionId: string;
  goalId: string;
  runId: string;
  /** 决策类型 */
  decision: ContinuationDecisionKind;
  /** 决策时的状态 (与 decision 必须自洽) */
  state: ContinuationState;
  /** 为什么这样决定 (人可读, 必须引用本轮事实) */
  reason: string;
  /** 下一步具体做什么 (decision='wait' 时写"等什么") */
  nextAction: string;
  /** 预期产出 (可被下一次 Run 检验, 不许写"继续推进") */
  expectedOutcome: string;
  /** 信心 0..1 (低信心不是"可以忽略", 是"该问人") */
  confidence: number;
  /** 进展证据 */
  progressDelta: ProgressDelta;
  /** 仍未解决项 */
  unresolvedItems: string[];
  /** 何时唤醒 (ISO; 不等待则 null) */
  wakeAt: IsoTimestamp | null;
  /** 下一步需要的能力 (delegate 时必有; 否则 null) */
  requiredCapability: string | null;
  /** 风险级别 */
  riskLevel: RiskLevel;
  /** Agent 主动要求停止时的理由 (decision='fail'/'complete' 之外必须 null) */
  stopReason: StopReason | null;
  /** 支撑本决策的证据引用 */
  evidenceRefs: string[];
  /** 产出时间 */
  decidedAt: IsoTimestamp;
}

/**
 * **三类硬底线** (安全线, 不是任务节奏):
 * 单 Run 时间上限 · 单 Goal 预算上限 · 无进展熔断阈值。
 * 它们决定"什么时候必须停", 不决定"什么时候继续"。
 */
export interface HardLimits {
  /** 单 Run 时间上限 (毫秒) */
  maxRunDurationMs: number;
  /** 单 Goal 预算上限 (原子单位/步数; null = 未设上限, 此时必须由人显式确认) */
  maxGoalBudget: number | null;
  /** 连续无新证据/无新完成判据的熔断阈值 (达到即 stalled → needs_human) */
  noProgressCircuitBreaker: number;
}

// ============================================================================
// §2. P1 — 强制收尾飞轮 (四类产物)
// ============================================================================

/**
 * Run 结束的**固定顺序** (成功 / 失败 / 中断恢复后的 Run **都必须走**):
 *   主执行结束 → 读完整步骤与证据 → Final Review → 提取事实/教训/Skill 候选
 *   → 写 Memory → 写 Skill Candidate → 更新 Goal continuation → 用户汇报 → 决定是否继续
 */
export const RUN_CLOSURE_STEPS = [
  'run_ended',
  'read_full_steps_and_evidence',
  'final_review',
  'extract_facts_lessons_and_candidates',
  'write_memory',
  'write_skill_candidate',
  'update_goal_continuation',
  'user_report',
  'continuation_decision',
] as const;
export type RunClosureStep = (typeof RUN_CLOSURE_STEPS)[number];

/** 收尾产物的四类 (缺任何一类 = 收尾未完成) */
export const CLOSURE_ARTIFACTS = [
  'facts',        // 发生了什么 / 哪些证据已确认 / 哪些只是推测
  'lessons',      // 什么方法有效 / 失败 / 下次改什么
  'skill_candidates', // 仅当: 重复出现 + 可复用 + 边界清晰 + 输入输出明确 + 有真实成功证据
  'next_step',    // 下次先做什么 / 为何 / 等什么 / 需哪个 Agent 与 Skill
] as const;
export type ClosureArtifact = (typeof CLOSURE_ARTIFACTS)[number];

// ============================================================================
// §3. P1b — Memory 分层
// ============================================================================

export const MEMORY_LAYERS = [
  'run_fact',     // 每次可自动写
  'lesson',       // 需 Review 判为可复用
  'decision',     // 涉用户偏好或重要取舍, 必须保留来源
  'skill_signal', // 只生成候选, 不许直接成 Skill
  'temporary',    // 任务结束自动过期归档
] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

/** 事实的确定性: 已确认 vs 推测 (推测**永不**当证据用) */
export const ASSERTION_KINDS = ['confirmed', 'inferred'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export interface MemoryRecordBase {
  memoryId: string;
  layer: MemoryLayer;
  goalId: string | null;
  runId: string | null;
  content: string;
  evidenceRefs: string[];
  createdAt: IsoTimestamp;
}

/** run_fact: 每次可自动写 —— 发生了什么 / 哪些证据已确认 / 哪些只是推测 */
export interface RunFactMemory extends MemoryRecordBase {
  layer: 'run_fact';
  assertion: AssertionKind;
  /** assertion='confirmed' 时必须有来源 */
  confirmedRefs: string[];
}

/** lesson: 只有被 Review 判为可复用才允许写 */
export interface LessonMemory extends MemoryRecordBase {
  layer: 'lesson';
  reviewedBy: string;
  reviewVerdict: 'reusable' | 'one_off';
  methodEffective: string;
  methodFailed: string;
  nextTimeChange: string;
}

/** decision: 涉及用户偏好或重要取舍 → **必须**保留来源 */
export interface DecisionMemory extends MemoryRecordBase {
  layer: 'decision';
  /** 来源 (用户原话 / 变更请求 id / 判据版本) —— 必填 */
  sourceRef: string;
  decidedBy: string;
  userPreference: boolean;
  alternatives: string[];
}

/** skill_signal: 只是"这里可能值得做成 Skill"的信号, 不携带转正权 */
export interface SkillSignalMemory extends MemoryRecordBase {
  layer: 'skill_signal';
  candidateId: string;
  /** 只生成候选, 永远是 false */
  promotesDirectly: false;
}

/** temporary: 任务结束自动过期归档 */
export interface TemporaryMemory extends MemoryRecordBase {
  layer: 'temporary';
  expiresAt: IsoTimestamp;
  /** 会话/任务结束时必须归档 (类型级陈述) */
  archiveAtRunEnd: true;
}

export type MemoryRecord =
  | RunFactMemory
  | LessonMemory
  | DecisionMemory
  | SkillSignalMemory
  | TemporaryMemory;

// ============================================================================
// §4. P1b — Skill 改进候选与更新流程
// ============================================================================

/** Skill 更新流程 (固定 8 步; 自动更新**不得**覆盖正在执行的 snapshot) */
export const SKILL_UPDATE_FLOW = [
  'run_evidence',
  'review_extract_candidate',
  'compare_with_existing_skill',
  'validate_candidate',
  'draft_new_version',
  'run_skill_acceptance',
  'approve',
  'write_content_hash_and_change_reason',
] as const;
export type SkillUpdateStep = (typeof SKILL_UPDATE_FLOW)[number];

/**
 * **防 Skill 垃圾**: 命中任意一条 → 不得成为正式 Skill。
 * (一次偶然成功不得直接成正式 Skill)
 */
export const SKILL_JUNK_REASONS = [
  'single_success',          // 只成功一次
  'no_io_schema',            // 无明确输入输出
  'temp_path_dependency',    // 依赖临时路径
  'no_failure_boundary',     // 无失败边界
  'unverifiable_result',     // 结果不可验证
  'one_line_experience',     // 只是一句经验
  'duplicate_of_existing',   // 与已有重复
] as const;
export type SkillJunkReason = (typeof SKILL_JUNK_REASONS)[number];

export const SKILL_CANDIDATE_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'promoted',
] as const;
export type SkillCandidateStatus = (typeof SKILL_CANDIDATE_STATUSES)[number];

/** 批准事实 (正式变更必备字段之一) */
export interface SkillApproval {
  state: 'not_requested' | 'pending' | 'approved' | 'rejected';
  approvedBy: string | null;
  approvedAt: IsoTimestamp | null;
  /** 变更原因 (写入正式 Skill 的 hash 记录) */
  changeReason: string | null;
}

/**
 * Skill **改进候选**。
 *
 * 注意: 刻意不叫 `SkillCandidate` —— 那个名字已属于 `skill-writer.ts` 的 run-end 文本候选
 * (name/description/body/source/signature)。本类型是更强的结构: 没有 schema / 失败边界 /
 * 证据 / 批准, 就**不能**成为正式 Skill。
 *
 * 必备字段 (与 leo 的冻结清单一一对应):
 *   sourceRunIds · evidenceRefs · failureCases · inputSchema · outputSchema
 *   · guarantees · doesNotGuarantee · contentHash · approval
 */
export interface SkillImprovementCandidate {
  candidateId: string;
  /** 建议的 Skill 名 */
  name: string;
  /** 它解决什么 (一句话, 不许写成"经验总结") */
  purpose: string;
  /** 来自哪些 Run (可回放) */
  sourceRunIds: string[];
  /** 支撑证据引用 */
  evidenceRefs: string[];
  /** **失败边界**: 什么情况下它会失效 (空数组 = 不合格) */
  failureCases: string[];
  /** 输入契约 (schema 名或 JSON Schema 文本) */
  inputSchema: string;
  /** 输出契约 */
  outputSchema: string;
  /** 保证什么 */
  guarantees: string[];
  /** **不**保证什么 (声明 guarantees 必须同时声明它) */
  doesNotGuarantee: string[];
  /** 草案内容哈希 (还没有草案时 null) */
  contentHash: string | null;
  /** 批准事实 */
  approval: SkillApproval;
  /** 状态 */
  status: SkillCandidateStatus;
  /** 重复出现次数 (>=2 才具备转正资格) */
  occurrences: number;
  /** 边界是否清晰 (由 Review 判定) */
  boundaryClear: boolean;
  /** 命中的"垃圾"理由 (非空 → 不得晋升) */
  junkReasons: SkillJunkReason[];
  proposedAt: IsoTimestamp;
  proposedByRunId: string;
}

/** 正式 Skill 变更记录 (批准后才写; 带 contentHash 与变更原因) */
export interface SkillPromotionRecord {
  skillName: string;
  fromVersion: string | null;
  toVersion: string;
  contentHash: string;
  changeReason: string;
  sourceRunIds: string[];
  evidenceRefs: string[];
  failureCases: string[];
  inputSchema: string;
  outputSchema: string;
  guarantees: string[];
  doesNotGuarantee: string[];
  approval: SkillApproval;
  /** 只影响**下一次** Run; 不覆盖正在执行的 Skill snapshot (类型级陈述) */
  snapshotScope: 'next_run_only';
  promotedAt: IsoTimestamp;
}

// ============================================================================
// §5. P2 — 子 Agent 工作合同 (AgentWorkContract) 与结构化回报
// ============================================================================

/** 子 Agent 可选用的预算 (父给的上限, 子**不得**自行扩大) */
export interface WorkBudget {
  maxSteps: number | null;
  maxDurationMs: number | null;
  maxAmount: number | null;
  currency: string | null;
}

/** 子 Agent 失败时的处置策略 (由父在合同里定, 子不许改) */
export interface ChildFailurePolicy {
  onHeartbeatMiss: 'stall' | 'takeover' | 'escalate';
  onBudgetExhausted: 'stop_and_report' | 'report_partial';
  onToolDenied: 'report' | 'replan_within_contract';
  onRepeatedFailure: 'stop_and_report' | 'escalate';
}

/** 取消策略 */
export interface ChildCancelPolicy {
  onParentCancel: 'immediate' | 'graceful';
  graceMs: number;
  preserveArtifacts: boolean;
  onParentGoalClosed: 'stop' | 'finish_current_step';
}

/**
 * **子 Agent 工作合同** —— 父派遣子之前必须签的东西。
 * 有合同才有: 统一任务合同 / 心跳 / 阻塞上报 / 变更注入 / 最终汇报。
 */
export interface AgentWorkContract {
  workId: string;
  goalId: string;
  /** 派它的那个 Run */
  parentRunId: string;
  childAgentId: string;
  /** 需要的能力 (与 Goal.requiredCapability 同一口径) */
  capability: string;
  /** 单一明确子目标 (禁止塞"顺便也把…做了") */
  objective: string;
  /** 输入 (结构化, 子只读) */
  inputs: Record<string, unknown>;
  /** **只允许**用这些工具 */
  allowedTools: string[];
  budget: WorkBudget;
  deadline: IsoTimestamp | null;
  /** 成功判据 (子不许私改) */
  successCriteria: string[];
  /** 回报必须符合的形状名 (例如 'bolloon-work-report/1') */
  reportSchema: string;
  /** 心跳间隔 (毫秒) */
  heartbeatIntervalMs: number;
  failurePolicy: ChildFailurePolicy;
  cancelPolicy: ChildCancelPolicy;
  /** 必须带回的证据 (缺 = 报告不完整 = 不算完成) */
  requiredEvidence: string[];
  issuedAt: IsoTimestamp;
  issuedBy: string;
}

/** 父负责做的事 */
export const PARENT_RESPONSIBILITIES = [
  'decompose_goal',
  'assign_work',
  'merge_results',
  'final_judgement',
  'report_to_user',
] as const;
export type ParentResponsibility = (typeof PARENT_RESPONSIBILITIES)[number];

/** 子负责做的事 */
export const CHILD_RESPONSIBILITIES = [
  'single_clear_subgoal',
  'only_contract_allowed_tools',
  'periodic_heartbeat',
  'report_blocks_proactively',
  'structured_result',
] as const;
export type ChildResponsibility = (typeof CHILD_RESPONSIBILITIES)[number];

/** 子 Agent **不得**做的事 (越界即判失败, 由父/监控层拦) */
export const CHILD_PROHIBITIONS = [
  'mutate_parent_goal_state',
  'expand_own_budget',
  'spawn_unbounded_subtasks',
  'mark_unverified_as_complete',
  'rewrite_success_criteria',
] as const;
export type ChildProhibition = (typeof CHILD_PROHIBITIONS)[number];

export const WORK_REPORT_STATUSES = [
  'completed',
  'partial',
  'blocked',
  'failed',
  'cancelled',
] as const;
export type WorkReportStatus = (typeof WORK_REPORT_STATUSES)[number];

export const CHECK_VERDICTS = ['pass', 'fail', 'unknown'] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

/** 子 Agent 带回的证据 (可核验引用, 不是形容词) */
export interface WorkEvidence {
  kind: string;
  /** 引用 (路径 / 哈希 / 回执 / run 步骤号) */
  ref: string;
  note: string | null;
}

/** 子 Agent 产出的工件 */
export interface WorkArtifact {
  name: string;
  path: string | null;
  hash: string | null;
  cid: string | null;
  bytes: number | null;
}

/** 子 Agent 自报的检查结果 (逐条, 不是"全部通过") */
export interface WorkCheck {
  name: string;
  verdict: CheckVerdict;
  detail: string;
}

/**
 * **子 Agent 的结构化回报** —— 子**不能只回一段文本**。
 * 缺 `evidence` / `checks` 的报告 = 报告不完整 = 父**不接受为完成**。
 */
export interface AgentWorkReport {
  workId: string;
  childAgentId: string;
  status: WorkReportStatus;
  summary: string;
  /** 证据 (空数组 = 漂亮但无证据 → 父 Goal 不许完成) */
  evidence: WorkEvidence[];
  artifacts: WorkArtifact[];
  /** 逐条检查结果 */
  checks: WorkCheck[];
  unresolvedItems: string[];
  /** 被阻塞时的阻塞记录 (无阻塞则 null; 不许写成一句"有问题") */
  blockReason: BlockRecord | null;
  /** 下一步建议 (给父决策用) */
  nextRecommendation: string;
  /** 耗时 (毫秒) */
  durationMs: number;
  reportedAt: IsoTimestamp;
}

// ============================================================================
// §6. P3 — 阻塞监控 (WorkMonitor / BlockRecord)
// ============================================================================

/**
 * 长期执行域的阻塞类型。
 * 与 `contacts/policy.ts` 的 `BlockKind` (联系方式策略拒绝原因) **同名不同域**, 永不合并。
 */
export const BLOCK_KINDS = [
  'no_heartbeat',        // 子 Agent 不发心跳了
  'waiting_dependency',  // 等依赖 (另一个 work / 外部服务)
  'repeated_failure',    // 反复失败
  'no_progress',         // 活着但没进展
  'tool_blocked',        // 工具/资源被阻
  'budget_blocked',      // 预算用尽 (硬底线)
  'permission_blocked',  // 权限不足
  'runner_unavailable',  // 没有可用执行器 (只诊断, 不假装跑过)
  'external_timeout',    // 外部等待超时
  'report_missing',      // 报告不完整 / 根本没回
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** 谁该处理这个阻塞 */
export const BLOCK_OWNERS = ['parent', 'child', 'external', 'system', 'user'] as const;
export type BlockOwner = (typeof BLOCK_OWNERS)[number];

/** 处理动作 (监控层可选的动作集, 不自动绕过 Harness) */
export const BLOCK_RESOLUTION_ACTIONS = [
  'send_adjustment',   // 先发一次调整指令
  'replace_child',     // 停掉并替换执行者
  'takeover',          // 父接管 (先查 lease)
  'request_report',    // 要求补齐报告
  'escalate_parent',   // 上报父
  'change_plan',       // 允许父改计划
  'wait_dependency',   // 继续等 (挂 escalationAt)
  'needs_human',       // 转人工
] as const;
export type BlockResolutionAction = (typeof BLOCK_RESOLUTION_ACTIONS)[number];

/** 每一种阻塞都必须带这些事实 (缺一项 = 说不清卡在哪) */
export interface BlockRecord {
  blockId: string;
  kind: BlockKind;
  goalId: string;
  runId: string | null;
  workId: string | null;
  childAgentId: string | null;
  /** 什么时候开始卡 */
  blockedAt: IsoTimestamp;
  /** 最后一次有进展的时间 (用来算"多久没动") */
  lastProgressAt: IsoTimestamp;
  /** 谁负责处理 */
  owner: BlockOwner;
  /** 在等什么 (人可读) */
  dependency: string | null;
  /** 建议动作 */
  suggestedAction: BlockResolutionAction;
  /** 什么时候必须升级 (不许无限等) */
  escalationAt: IsoTimestamp | null;
  /** 已解决时间 (未解决 null) */
  resolvedAt: IsoTimestamp | null;
  /** 实际采取的动作 (未解决 null) */
  resolution: BlockResolutionAction | null;
  /** 说明 */
  note: string;
}

/**
 * 用户可见的**六类**状态 (其余内部状态不外露):
 *   正在执行 / 等待外部回复 / 子 Agent 被阻塞 / 暂时没有进展 / 需要你决定 / **已结束**
 *
 * 第 6 类 (`ended`) 是 2026-09-25 接线时补的: 前五类里没有"已结束", 于是 P1 的收尾汇报只能
 * 借用 `executing` —— 把一个**已经结束**的目标显示成"正在执行"正是 P3/P4 要防的假象。
 * 补法只有一种: 改冻结层 + 单独一个提交 (见 `goal-flywheel-types.test.ts` 的计数门)。
 */
export const USER_VISIBLE_STATES = [
  'executing',
  'waiting_external_reply',
  'child_blocked',
  'no_progress',
  'needs_your_decision',
  // 2026-09-25 新增 (第 6 类): 目标已结束 (completed / failed / abandoned) ——
  //   "已结束"必然需要人接一下 (接受结论 / 重试 / 立新目标), 但**不许**说成"正在执行"。
  'ended',
] as const;
export type UserVisibleState = (typeof USER_VISIBLE_STATES)[number];

/** 用户态文案 (只暴露六类, 不出现 lease/reducer/retry counter 这类内部词) */
export const USER_VISIBLE_STATE_LABELS: Record<UserVisibleState, { zh: string; en: string }> = {
  executing: { zh: '正在执行', en: 'Executing' },
  waiting_external_reply: { zh: '等待外部回复', en: 'Waiting for an external reply' },
  child_blocked: { zh: '子 Agent 被阻塞', en: 'A sub-agent is blocked' },
  no_progress: { zh: '暂时没有进展', en: 'Temporarily no progress' },
  needs_your_decision: { zh: '需要你决定', en: 'Your decision is needed' },
  ended: { zh: '已结束', en: 'Ended' },
};

// ============================================================================
// §7. P4 / P4b — 新要求注入 (GoalChangeRequest) 与两份输出
// ============================================================================

/** 变更分类 */
export const CHANGE_KINDS = [
  'clarification',           // 补充说明 (不改判据)
  'priority_change',         // 优先级变化
  'success_criteria_change', // 完成判据变化 (必须增版本号)
  'budget_change',           // 预算变化 (扩大不许 Agent 自动批)
  'permission_change',       // 权限变化
  'scope_expansion',         // 扩大范围
  'scope_reduction',         // 缩小范围
  'abort',                   // 撤销 / 终止
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_SOURCES = ['user', 'agent', 'external', 'system'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** `user_revocation` 优先级最高 (用户明确撤销压过一切) */
export const CHANGE_PRIORITIES = ['user_revocation', 'high', 'normal', 'low'] as const;
export type ChangePriority = (typeof CHANGE_PRIORITIES)[number];

export const CHANGE_STATUSES = [
  'received',
  'triaged',
  'needs_approval',
  'scheduled_next_run',
  'applied',
  'rejected',
  'superseded',
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const CHANGE_SCOPE_KINDS = [
  'goal',
  'run',
  'criteria',
  'budget',
  'permission',
  'child_work',
] as const;
export type ChangeScopeKind = (typeof CHANGE_SCOPE_KINDS)[number];

/** 变更影响面 (判断要不要重规划的依据) */
export interface ChangeImpact {
  affectsObjective: boolean;
  affectsCriteria: boolean;
  affectsBudget: boolean;
  affectsPermission: boolean;
  affectedWorkIds: string[];
}

/** 变更作用范围 */
export interface ChangeScope {
  kind: ChangeScopeKind;
  targetIds: string[];
}

/** 新要求注入的固定规则 (写进类型, 不靠记忆) */
export const GOAL_CHANGE_RULES = [
  'user_revocation_wins',        // 用户明确撤销优先级最高
  'agent_cannot_approve_budget', // 扩预算不得由 Agent 自动批准
  'criteria_change_bumps_version', // 改完成判据必须增版本号
  'history_not_rewritten',       // 当前 Run 历史不可被新要求改写 (只影响后续)
  'children_receive_new_version', // 子 Agent 必须收到变更版本
] as const;
export type GoalChangeRule = (typeof GOAL_CHANGE_RULES)[number];

/**
 * **新要求注入**: 用户在长期执行中途说的话, 必须变成一条可追溯的记录,
 * 而不是"顺手改掉当前 Run 的判据"。
 */
export interface GoalChangeRequest {
  changeId: string;
  goalId: string;
  /** 谁提的 */
  source: ChangeSource;
  /** 原文逐字 (不许改写用户原话) */
  instruction: string;
  /** 变更摘要 (规范化后的理解; 未解析时 null) */
  interpreted: string | null;
  priority: ChangePriority;
  kind: ChangeKind;
  scope: ChangeScope;
  impact: ChangeImpact;
  /** 何时生效 (本飞轮语义: 最早是"下一次 Run") */
  effectiveAt: IsoTimestamp;
  /** 是否必须重规划 */
  requiresReplan: boolean;
  status: ChangeStatus;
  /** 记录时间与记录者 */
  recordedAt: IsoTimestamp;
  recordedBy: string;
  /** 只影响后续 Run, 不改写已发生的历史 (类型级陈述) */
  appliesToFutureRunsOnly: true;
}

/** 未回报的子 Agent 工作 (机器继续记录的一部分) */
export interface PendingReport {
  workId: string;
  childAgentId: string;
  capability: string;
  requestedAt: IsoTimestamp;
  deadlineAt: IsoTimestamp | null;
  lastHeartbeatAt: IsoTimestamp | null;
}

/**
 * **机器继续记录** —— 写进 Goal.continuation。
 *
 * 与 `goal-store.ts` 的 `GoalContinuation` 关系: 二者**共享调度核心**
 * (nextAction / wakeAt / wakeReason / autoContinue / updatedAt), 本类型在其上补机器继续记录
 * 需要的字段 (requiredAgent / pendingReports / unresolvedItems / lastDecisionId / state)。
 * 方向是**旧类型可整体读作本类型** (`GoalContinuation` → `Partial<GoalContinuationRecord>` 可赋值),
 * 但**刻意不把 legacy 的外部等待域字段搬到这一层**。这里是**冻结面**, 不改现有调用方;
 * P1 实现时再把两者收敛到一处。
 */
export interface GoalContinuationRecord {
  /** 下一步是什么 (必答, 不许为空串) */
  nextAction: string;
  /** 何时继续 (立即/到点/等事件则 null) */
  wakeAt: IsoTimestamp | null;
  /** 为何继续 / 为何等 */
  wakeReason: string;
  /** 是否允许自动继续 */
  autoContinue: boolean;
  /** 下一步由谁执行 (null = 本节点即可) */
  requiredAgent: string | null;
  /** 还没回报的子任务 */
  pendingReports: PendingReport[];
  /** 仍未解决项 */
  unresolvedItems: string[];
  /** 最近一次继续决策 id */
  lastDecisionId: string | null;
  /** 当前长期状态 */
  state: GoalLifecycleState;
  updatedAt: IsoTimestamp;
}

/** 长期执行生命周期状态 (与 goal-store 的 GoalStatus 同域; 这里作为冻结面重列一次) */
export const GOAL_LIFECYCLE_STATES = [
  'active',
  'recovering',
  'retry_wait',
  'awaiting_external',
  'stalled',
  'paused',
  'needs_human',
  'completed',
  'failed',
  'abandoned',
] as const;
export type GoalLifecycleState = (typeof GOAL_LIFECYCLE_STATES)[number];

/** 只有这几个状态可以"结束" (其余必须回答下一步) */
export const GOAL_TERMINAL_STATES = ['completed', 'failed', 'abandoned'] as const;
export type GoalTerminalState = (typeof GOAL_TERMINAL_STATES)[number];

/** 需要有人的状态 (可以停在这里, 但必须说清等人做什么) */
export type GoalDecisionState = 'needs_human';

/** 必须继续的状态 (不允许悬空) */
export type GoalActiveState = Exclude<GoalLifecycleState, GoalTerminalState | GoalDecisionState>;

/**
 * **Goal 不允许进入"没有下一步"的悬空态** —— 类型级表达:
 *   终态 → 没有 continuation (但有 resolution)
 *   needs_human → 必须说明等谁/等什么
 *   其余状态 → **必须**有 continuation
 */
export type GoalContinuationEnvelope =
  | { state: GoalTerminalState; continuation: null; resolution: { reason: string; at: IsoTimestamp } }
  | { state: GoalDecisionState; continuation: GoalContinuationRecord | null; needsHumanReason: string }
  | { state: GoalActiveState; continuation: GoalContinuationRecord; nextCheckAt: IsoTimestamp | null };

/** 汇报里**允许出现**的字段名 (与 MUST_NOT_EXPOSE_FIELDS 无交集) */
export const USER_REPORT_FIELDS = [
  'conclusion',
  'completed',
  'evidence',
  'remaining',
  'blockReasons',
  'nextStep',
  'willContinue',
  'expectedResumeAt',
  'visibleState',
] as const;
export type UserReportField = (typeof USER_REPORT_FIELDS)[number];

/** 汇报里**不得出现**的内部字段 (只给用户看结论与下一步) */
export const MUST_NOT_EXPOSE_FIELDS = [
  'lease',
  'reducer',
  'internal_status',
  'retry_counter',
  'worker_owner',
] as const;
export type MustNotExposeField = (typeof MUST_NOT_EXPOSE_FIELDS)[number];

/** **用户汇报** (P4b 的第一份输出) */
export interface UserReport {
  /** 当前结论 */
  conclusion: string;
  /** 已完成 */
  completed: string[];
  /** 证据 */
  evidence: string[];
  /** 仍未完成 */
  remaining: string[];
  /** 阻塞原因 (人可读) */
  blockReasons: string[];
  /** 下一步 */
  nextStep: string;
  /** 是否会继续 */
  willContinue: boolean;
  /** 预计何时继续 (null = 等人/等事件) */
  expectedResumeAt: IsoTimestamp | null;
  /** 用户可见状态 (只在五类里) */
  visibleState: UserVisibleState;
  /** 暴露面 (类型级约束: 只允许 USER_REPORT_FIELDS 里的字段名) */
  exposedFields: UserReportField[];
  generatedAt: IsoTimestamp;
}

// ============================================================================
// §8. P5 — 统一长周期验收 (后续阶段跑; 本轮只冻结用例清单)
// ============================================================================

export const LONG_RUN_ACCEPTANCE_CASES = [
  // 正例
  'self_terminate_by_evidence',            // 不设最大轮次, 按证据自行结束
  'no_progress_circuit_breaker',           // 无进展自动熔断
  'child_block_detected_and_handled',      // 子 Agent 被阻塞被发现/接管/升级
  'user_change_effective_next_run',        // 用户中途注入新要求 → 下一 Run 生效
  'run_end_writes_memory_and_candidate',   // Run 结束自动写 Memory + Skill Candidate
  'auto_resume_by_wake_at_or_event',       // 汇报后按 wakeAt/事件自动继续
  // 强负例
  'evidence_less_child_report_blocks_goal', // 漂亮但无证据 → 父 Goal **不完成**
  'single_success_never_promotes_skill',    // 只有一次偶然成功 → **不得**自动晋升正式 Skill
] as const;
export type LongRunAcceptanceCase = (typeof LONG_RUN_ACCEPTANCE_CASES)[number];

// ============================================================================
// §9. 本轮**不做** (写进类型面, 防止被"顺手实现")
// ============================================================================

export const FLYWHEEL_NON_GOALS = [
  'unbounded_autonomous_agent_swarms',
  'auto_spawn_many_subagents',
  'multi_level_recursive_delegation',
  'agent_run_its_own_agent_marketplace',
  'auto_write_every_result_as_skill',
  'auto_overwrite_formal_skills',
  'evidence_less_smart_scoring',
  'complex_pm_dashboards',
  'multiple_task_databases',
  'a_second_workflow_engine',
  'fixed_round_count_masquerading_as_long_run',
  'running_forever_instead_of_real_progress',
] as const;
export type FlywheelNonGoal = (typeof FLYWHEEL_NON_GOALS)[number];
