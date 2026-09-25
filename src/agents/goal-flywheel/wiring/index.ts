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
  createContinuationSeam,
  type ContinuationSeam,
  type ContinuationSeamDeps,
  type GoalStepOutcome,
} from './continuation.js';

export {
  CLOSURE_IDEMPOTENCY_NOTE,
  CLOSURE_SEAM_ID,
  createClosureSeam,
  type ClosureOutcomeView,
  type ClosureSeam,
  type ClosureSeamDeps,
  type CloseRunOnceResult,
} from './closure.js';

export {
  CONTRACT_SEAM_ID,
  createContractSeam,
  type ContractIssueInput,
  type ContractSeam,
  type ContractSeamDeps,
  type ReportVerdict,
} from './contract.js';

export {
  MONITOR_SEAM_ID,
  createMonitorSeam,
  createVisibleStateProbe,
  type BlockHandlingView,
  type MonitorSeam,
  type MonitorSeamDeps,
} from './monitor.js';

export {
  CHANGE_SEAM_ID,
  USER_ONLY_CHANGE_KINDS,
  createChangeSeam,
  type ChangeIngestInput,
  type ChangeIngestView,
  type ChangeSeam,
  type ChangeSeamDeps,
} from './change.js';
