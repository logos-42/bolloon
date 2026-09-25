/**
 * goal-flywheel/wiring/index.ts — 接线接缝的对外入口 (M0)
 *
 * 只做转发: 接缝名册在 `seams.ts` (M0 冻结), 五个接缝实现各归各的阶段文件。
 * 这里**不定义任何函数** —— 与 `../index.ts` 同一纪律 (转发行, 不夹带实现)。
 *
 * M1–M4 各自只 import 自己那个接缝文件; 想拿到接缝实例请走 M0 接线层
 * (`src/agents/goal-flywheel-wiring.ts` 的 `flywheelSeams()`), 它负责注入真依赖。
 */

export {
  DEFAULT_ALLOW,
  FROZEN_RULES,
  FROZEN_RULE_TEXT,
  FUNNEL_ALIASES,
  FUNNEL_CALL_RE,
  FUNNEL_ENTRY,
  SCANNED_SOURCES,
  SEAM_IDS,
  SEAM_MODULES,
  SEAM_ROSTER,
  SKILL_CHANNEL_EVIDENCE,
  TERMINAL_PATHS,
  WIRING_CALLERS,
  WIRING_STAGES,
  canRunStagesInParallel,
  filesOfStage,
  isRefusal,
  refuse,
  seamModuleOf,
  seamOf,
  seamRosterViolations,
  scanChildCannotMutateGoal,
  scanFunnelAliases,
  scanOnlyCloseRunCloses,
  scanOnlyGoalReducerWritesState,
  scanOnlySupervisorDecides,
  scanSkillChannel,
  scanTerminalPaths,
  stageOf,
  type FrozenRule,
  type RosterViolation,
  type RuleViolation,
  type SeamDescriptor,
  type SeamId,
  type SeamRefusal,
  type SourceFile,
  type TerminalPath,
  type WiringCaller,
  type WiringStage,
} from './seams.js';

export {
  CONTINUATION_SEAM_ID,
  RHYTHM_BASIS_TEXT,
  SAFETY_CAPS,
  SAFETY_CAP_TEXT,
  SEAM_CAP_DEFAULTS,
  SEAM_RHYTHM_REQUIRED,
  SEAM_ROUNDS_AS_RHYTHM,
  bindingCaps,
  createContinuationSeam,
  judgeInjectedOutcome,
  judgeLegacyStop,
  planRhythm,
  rhythmicDecision,
  safetyCapsFrom,
  scanContinuationSeamRhythm,
  type ContinuationPreflight,
  type ContinuationSeam,
  type ContinuationSeamDeps,
  type GoalStepOutcome,
  type LegacyRhythmConfig,
  type LegacyStopClaim,
  type LegacyStopJudgement,
  type RhythmBasis,
  type RhythmFacts,
  type RhythmPlan,
  type SafetyCap,
} from './continuation.js';

export {
  CLOSURE_IDEMPOTENCY_NOTE,
  CLOSURE_SEAM_ID,
  CLOSURE_TERMINAL_KINDS,
  auditClosureOutcome,
  auditTerminalCoverage,
  closureTerminalKindFor,
  createClosureSeam,
  probeClosureArtifacts,
  terminalKindAccepts,
  terminalRegistryCoverage,
  type ClosureAudit,
  type ClosureOutcomeView,
  type ClosureReceipt,
  type ClosureSeam,
  type ClosureSeamDeps,
  type ClosureTerminalKind,
  type CloseRunOnceResult,
  type TerminalCoverage,
  type TrialOpeningView,
} from './closure.js';

export {
  CONTRACT_SEAM_ID,
  CONTRACT_REFUSAL_CODES,
  childMatchesContract,
  createContractSeam,
  createContractSeamFromLogic,
  realIssueContract,
  realReportVerdict,
  type ChildDispatchPort,
  type ContractIssueInput,
  type ContractRefusalCode,
  type ContractSeam,
  type ContractSeamDeps,
  type DispatchOutcome,
  type DispatchReceipt,
  type ReportVerdict,
} from './contract.js';

export {
  INTERNAL_VISIBLE_WORDS,
  MONITOR_SEAM_ID,
  MONITOR_SWEEP_DEFAULT_LIMIT,
  MONITOR_SWEEP_MAX_LIMIT,
  USER_FACING_STATES,
  createMonitorSeam,
  createVisibleStateProbe,
  describeVisibleState,
  isUserVisibleState,
  scanInternalLeak,
  userFacingState,
  type BlockHandlingView,
  type MonitoredGoal,
  type MonitorSeam,
  type MonitorSeamDeps,
  type MonitorTickView,
  type VisibleStateSeamDeps,
  type VisibleStateView,
} from './monitor.js';

export {
  CHANGE_SEAM_ID,
  USER_ONLY_CHANGE_KINDS,
  changeVisibleState,
  createChangeSeam,
  type ChangeIngestInput,
  type ChangeIngestView,
  type ChangeSeam,
  type ChangeSeamDeps,
  type ChildEditionDelivery,
  type RunBoundaryOutcome,
  type RunningRunFact,
  type RunStopRequest,
  type StopRunStatus,
  type StopRunningRun,
} from './change.js';

// ---------------------------------------------------------------------------
// 跨阶段的**纯函数面** (2026-09-25 串行收口): 接缝与宿主都用的判定/归一化在这里一并转发 ——
// 宿主与界面要的是"同一份口径", 不该各自深入阶段目录再 import 一遍 (M3 报的"index 补导"的完整形态)。
//
// 转发的是**同一个函数对象**, 不是同名的壳: 见 `goal-flywheel-m0-serial-hooks.test.ts` ⑥ 的恒等断言。
// 尤其 `toUserVisibleState` / `normalizeContinuationRecord` —— 工作监控与 web 路由直传**部分**
// continuation 时必须读同一份归一化 (2026-09-25 跨阶段真问题 ①)。
// ---------------------------------------------------------------------------
export {
  normalizeContinuationRecord,
  toUserVisibleState,
} from '../work-monitor.js';

export { planChangeInjection } from '../goal-change.js';

export { USER_VISIBLE_STATES } from '../types.js';
