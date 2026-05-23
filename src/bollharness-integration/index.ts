/**
 * Bollharness Integration for Bolloon - Enhanced with Pi Ecosystem
 *
 * This module provides compatibility between Bolloon's multi-agent system
 * and Bollharness's governance framework, now with deep Pi ecosystem integration.
 *
 * Pi Ecosystem Integration:
 * - MCP tools via pi-ecosystem-mcp (white-box tool calling)
 * - Goal tracking via pi-ecosystem-goals (persistent workflow)
 * - Subagents via pi-ecosystem-subagents (tmux-based light agents)
 * - Ant Colony via pi-ecosystem-colony (multi-agent signal protocol)
 */

export { BollharnessIntegration, createBollharnessIntegration, BollharnessHooks } from './integration.js';
export { GateStateMachine, type Gate } from './gate-state-machine.js';
export { GuardChecker, type GuardFinding, type GuardResult } from './guard-checker.js';
export { ContextRouter } from './context-router.js';
export { SkillAdapter, type AdaptedSkill, type SkillTriggers, type HarnessSkillMetadata } from './skill-adapter.js';

// Gate transition hooks
export {
  initializeGateHooks,
  onGateTransition,
  offGateTransition,
  executeGateTransitionHooks,
  addGateHook,
  clearGateHooks,
  listGateHooks,
  type GateHookConfig,
  type GateTransitionEvent,
} from './gate-transition-hooks.js';

// Judgment-aware context router exports
export {
  getJudgmentsForPath,
  getJudgmentsForFragment,
  getJudgmentsForContextRequest,
  getCoreJudgmentsForSession,
  generateJudgmentInjection,
  type JudgmentInjectOptions,
  type JudgmentContextResult,
} from './context-router-judgment.js';

// Pi Ecosystem re-exports for convenience
export {
  initializeMcpAdapter,
  discoverMcpServers,
  registerServer,
  registerTool,
  listTools,
  hasTool,
  getTool,
  executeTool,
  getToolCallLog,
  getAdapterStatus,
  type McpTool,
  type McpServerConfig,
} from '../pi-ecosystem-mcp/index.js';

export {
  createGoal,
  createGoalQueue,
  getCurrentGoal,
  startCurrentGoal,
  completeCurrentGoal,
  failCurrentGoal,
  cutoffCurrentGoal,
  pauseCurrentGoal,
  checkBudget,
  getGoalStats,
  getQueueSummary,
  loadGoals,
  clearGoals,
  compactQueue,
  loadTemplates,
  createFromTemplate,
  nudgeCurrentGoal,
  type Goal,
  type GoalBudget,
  type GoalQueue,
  type WorkflowTemplate,
} from '../pi-ecosystem-goals/index.js';

export {
  createSubagent,
  startSubagent,
  delegateTask,
  getSubagent,
  listSubagents,
  listRunningSubagents,
  terminateSubagent,
  getStats as getSubagentStats,
  parallelDelegate,
  splitTask,
  type Subagent,
  type SubagentResult,
} from '../pi-ecosystem-subagents/index.js';

export {
  registerAnt,
  antScouting,
  antWorking,
  antReviewing,
  antComplete,
  antFail,
  antAbort,
  antTick,
  createTask,
  dispatchTask,
  recordResult,
  getAnt,
  listAnts,
  listAntsByRole,
  listAntsBySignal,
  getActiveAnts,
  getTask,
  listTasks,
  getSignalHistory,
  getColonyStatus,
  getColonyDump,
  persistColony,
  loadColony,
  onColonyEvent,
  offColonyEvent,
  type Ant,
  type ColonyTask,
  type ColonySignalEvent,
  type ColonySignal,
  type AntRole,
} from '../pi-ecosystem-colony/index.js';

// Judgment exports
export {
  createJudgment,
  getAllJudgments,
  getJudgmentsByType,
  getJudgmentsForContext,
  getCombinedJudgments,
  calculateConfidence,
  buildValueFunction,
  getValueFunction,
  getJudgmentStats,
  loadFragmentJudgments,
} from '../pi-ecosystem-judgment/index.js';

export type {
  Judgment,
  JudgmentEvidence,
  DistillationRequest,
  ValueFunction,
} from '../pi-ecosystem-judgment/index.js';

// Distillation exports
export {
  initializeDistillation,
  detectTrigger,
  isJudgmentSignal,
  distillInput,
  processFeedback,
} from '../pi-ecosystem-judgment/distillation.js';

// Decision exports
export {
  setConfidenceThreshold,
  evaluateDecision,
  submitDecisionResponse,
  parseDecisionResponse,
  queryInternalAgents,
  processHumanFeedback,
  getPendingDecisions,
  getDecisionRequest,
} from '../pi-ecosystem-judgment/decision.js';

export type {
  DecisionLevel,
  DecisionRequest,
  DecisionResponse,
  AgentConsultationResult,
} from '../pi-ecosystem-judgment/decision.js';

/**
 * Pi Ecosystem Configuration
 */
export interface PiEcosystemConfig {
  mcpEnabled: boolean;
  goalsEnabled: boolean;
  subagentsEnabled: boolean;
  colonyEnabled: boolean;
}

/**
 * Combined Pi Ecosystem status
 */
export interface PiEcosystemStatus {
  initialized: boolean;
  mcp: {
    serverCount: number;
    toolCount: number;
    runningServers: string[];
  };
  goals: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
  };
  subagents: {
    total: number;
    running: number;
    completed: number;
    failed: number;
  };
  colony: {
    antCount: number;
    activeAnts: number;
    taskCount: number;
    activeTasks: number;
  };
}