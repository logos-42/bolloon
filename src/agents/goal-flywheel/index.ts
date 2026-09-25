/**
 * goal-flywheel/index.ts — 「Goal 长期执行飞轮」对外入口 (2026-09-25)
 *
 * 冻结的接口类型在 `types.ts`; P0–P4 的实现逐个从本入口转发 (接线是单一所有者的事,
 * 这里的转发面 = 接线层真正用到的那些):
 *   P0 节奏由进展决定       → continuation-decision.ts
 *   P1 强制收尾飞轮         → run-closure.ts
 *   P1b Memory / Skill 候选 → memory-layers.ts · skill-candidate.ts
 *   P2 子 Agent 工作合同    → work-contract.ts
 *   P3 阻塞监控             → work-monitor.ts
 *   P4 新要求注入           → goal-change.ts
 *
 * 真实调用路径的适配层 (`src/agents/goal-flywheel-wiring.ts`) **不在这里** —— 它 import
 * goal-store / run-store, 属于"接线 = 改现有调用方"那一层, 放在目录外面只 import, 不侵入。
 *
 * 本文件只做转发: 不夹带实现、不定义函数 (由 `goal-flywheel-types.test.ts` 的门钉住)。
 * 类型一律用内联 `type` 修饰符跟在值后面转发 —— 与本目录既有的"转发行写法"门保持一致。
 */

export * from './types.js';

export {
  applyHardLimits,
  decideContinuation,
  isRunnable,
  type DecideContinuationInput,
} from './continuation-decision.js';

export {
  CLOSURE_DEFAULT_NO_PROGRESS_CIRCUIT_BREAKER,
  CLOSURE_MAX_EVIDENCE,
  CLOSURE_MAX_FACTS,
  CLOSURE_MIN_PURPOSE_LENGTH,
  CLOSURE_RESULT_FIELDS,
  CLOSURE_STEP_ORDER,
  RunClosureError,
  closeRun,
  gateClosureCandidate,
  parseFinalReview,
  type CloseRunDeps,
  type CloseRunInput,
  type CloseRunResult,
  type ClosureDecider,
  type ContinuationDecisionInput,
  type ParsedRunReview,
  type ReviewFactClaim,
  type ReviewSkillClaim,
} from './run-closure.js';

export {
  MEMORY_LAYERS_ROOT,
  MEMORY_REJECT_REASONS,
  expireTemporary,
  memoryFileName,
  memoryFilePath,
  validateMemoryRecordForWrite,
  writeMemoryRecords,
  type MemoryRejectReason,
  type MemoryWriteResult,
} from './memory-layers.js';

export {
  TEMP_PATH_HINTS,
  assessCandidate,
  bumpSkillVersion,
  deriveJunkReasons,
  draftPromotion,
  looksLikeTempPath,
  type CandidateAssessment,
  type ExistingSkillIdentity,
} from './skill-candidate.js';

export {
  CRITERION_REF_PREFIX,
  DEFAULT_CANCEL_POLICY,
  DEFAULT_FAILURE_POLICY,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_INTERVAL_MS,
  NOT_CHECKABLE_FROM_REPORT,
  REPORT_CHECKABLE_PROHIBITIONS,
  WORK_REPORT_SCHEMA,
  WorkContractError,
  acceptsAsComplete,
  criterionRef,
  issueWorkContract,
  stableHash,
  validateChildReport,
} from './work-contract.js';

export {
  ADJUSTMENT_ALREADY_GIVEN_MULTIPLE,
  BLOCK_HANDLING_DEFAULTS,
  DEFAULT_ESCALATION_MS,
  DEFAULT_REPORT_GRACE_MS,
  HEARTBEAT_MISS_MULTIPLE,
  NO_PROGRESS_FALLBACK_MS,
  NO_PROGRESS_HEARTBEAT_MULTIPLE,
  REPORT_GRACE_HEARTBEAT_MULTIPLE,
  TERMINAL_GOAL_STATES,
  USER_VISIBLE_BLOCK_PRIORITY,
  USER_VISIBLE_STATE_FOR_BLOCK_KIND,
  detectBlocks,
  heartbeatWindowMs,
  missingReportParts,
  noProgressWindowMs,
  planBlockHandling,
  reportGraceMs,
  toUserVisibleState,
  type DetectBlocksInput,
} from './work-monitor.js';

export {
  applyChange,
  approvalAsUserChange,
  childChangeDirective,
  classifyChange,
  detectBudgetDirection,
  detectChangeIntents,
  ingestChange,
  isWidening,
  nextStatusFor,
  scopeChangeToWork,
  shouldSupersedePending,
  type BudgetDelta,
  type BudgetDirection,
  type ChangeApplication,
  type ChildChangeDirective,
} from './goal-change.js';
