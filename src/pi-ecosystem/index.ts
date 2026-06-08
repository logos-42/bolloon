/**
 * Pi Ecosystem Integration for Bolloon
 *
 * Main entry point for Pi ecosystem packages integration.
 *
 * Installed packages:
 * - oh-pi: Configuration management (API keys, model selection, extensions)
 * - pi-mcp-adapter: MCP protocol bridge for tools
 * - pi-goals: Persistent goal tracking and workflow orchestration
 * - pi-subagents: Lightweight subagents based on tmux
 * - pi-ecosystem-colony: Ant colony multi-agent collaboration
 *
 * Design philosophy:
 * - Minimal primitives (read/write/edit/bash)
 * - No Plan Mode - direct execution
 * - No permission popups - use safe-guard extensions
 * - No built-in todos - use pi-goals
 * - White-box design - everything visible
 *
 * Token efficiency:
 * - Claude Code: 5k-8k token/request overhead
 * - Pi ecosystem: ~800 token/request
 * - Result: 80-90% token cost savings
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Re-export all modules with correct paths
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
  clearToolCallLog,
  startServer,
  stopServer,
  discoverTools,
  createTavilyTool,
  createAmapTool,
  getAdapterStatus,
  on as onMcpEvent,
  off as offMcpEvent,
} from '../pi-ecosystem-mcp/index.js';

export type { McpTool, McpServerConfig } from '../pi-ecosystem-mcp/index.js';

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
} from '../pi-ecosystem-goals/index.js';

export type { Goal, GoalBudget, GoalQueue, WorkflowTemplate, ChurnEvent } from '../pi-ecosystem-goals/index.js';

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
} from '../pi-ecosystem-subagents/index.js';

export type { Subagent, SubagentResult, SubagentDelegateOptions } from '../pi-ecosystem-subagents/index.js';

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
} from '../pi-ecosystem-colony/index.js';

export type { Ant, ColonyTask, ColonySignalEvent, ColonySignal, AntRole } from '../pi-ecosystem-colony/index.js';

// Judgment exports
export {
  createJudgment,
  updateJudgmentConfidence,
  getAllJudgments,
  getJudgmentsByType,
  getJudgmentsForContext,
  getCombinedJudgments,
  calculateConfidence,
  buildValueFunction,
  getValueFunction,
  getJudgmentStats,
  loadFragmentJudgments,
  clearCache,
} from '../pi-ecosystem-judgment/index.js';

export type {
  Judgment,
  JudgmentEvidence,
  TrajectoryPoint,
  PreferencePair,
  Correction,
  JudgmentFile,
  DistillationRequest,
  ValueFunction,
} from '../pi-ecosystem-judgment/index.js';

// Distillation exports
export {
  initializeDistillation,
  detectTrigger,
  detectCorrection,
  isJudgmentSignal,
  addToTrajectory,
  detectTrajectoryPattern,
  distillInput,
  processFeedback,
  getTrajectoryStats,
  clearTrajectory,
} from '../pi-ecosystem-judgment/distillation.js';

export type { FeedbackSignal, DistillationResult, TrajectoryEntry } from '../pi-ecosystem-judgment/distillation.js';

// Decision exports
export {
  setConfidenceThreshold,
  getConfidenceThreshold,
  setDefaultDecisionLevel,
  getDefaultDecisionLevel,
  evaluateDecision,
  submitDecisionResponse,
  isDecisionResponse,
  parseDecisionResponse,
  queryInternalAgents,
  processHumanFeedback,
  getPendingDecisions,
  getDecisionRequest,
  getDecisionStats,
  onDecisionEvent,
  offDecisionEvent,
} from '../pi-ecosystem-judgment/decision.js';

export type {
  DecisionLevel,
  ConsultationTarget,
  DecisionStatus,
  DecisionRequest,
  DecisionResponse,
  AgentConsultationResult,
} from '../pi-ecosystem-judgment/decision.js';

const PI_ECOSYSTEM_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'pi-ecosystem');
const CONFIG_FILE = path.join(PI_ECOSYSTEM_DIR, 'config.json');

export interface PiEcosystemConfig {
  model: string;
  apiKey?: string;
  extensions: string[];
  templates: string[];
  initializedAt?: string;
}

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

/**
 * Default Pi ecosystem configuration (mirrors oh-pi)
 */
const DEFAULT_CONFIG: PiEcosystemConfig = {
  model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
  extensions: [
    'safe-guard',
    'git-guard',
    'auto-session',
    'custom-footer',
    'context7',
    'web-search',
    'git-workflow',
  ],
  templates: [
    '/review',
    '/fix',
    '/commit',
    '/test',
    '/plan',
    '/debug',
    '/refactor',
    '/docs',
    '/search',
    '/colony',
  ],
};

/**
 * Initialize the Pi ecosystem (mirrors oh-pi setup)
 */
export async function initializePiEcosystem(config?: Partial<PiEcosystemConfig>): Promise<PiEcosystemConfig> {
  await fs.mkdir(PI_ECOSYSTEM_DIR, { recursive: true });

  let currentConfig = DEFAULT_CONFIG;

  try {
    const existing = await fs.readFile(CONFIG_FILE, 'utf-8');
    currentConfig = { ...DEFAULT_CONFIG, ...JSON.parse(existing) };
  } catch {
    // No existing config
  }

  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }

  currentConfig.initializedAt = new Date().toISOString();

  await fs.writeFile(CONFIG_FILE, JSON.stringify(currentConfig, null, 2));

  console.log('[PiEcosystem] Initialized with config:', JSON.stringify(currentConfig, null, 2));

  return currentConfig;
}

/**
 * Load Pi ecosystem configuration
 */
export async function loadPiConfig(): Promise<PiEcosystemConfig | null> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Check if Pi ecosystem is initialized
 */
export async function isPiEcosystemInitialized(): Promise<boolean> {
  try {
    await fs.access(CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get combined Pi ecosystem status
 */
export async function getPiEcosystemStatus(): Promise<PiEcosystemStatus> {
  const { getAdapterStatus } = await import('../pi-ecosystem-mcp/index.js');
  const { getGoalStats } = await import('../pi-ecosystem-goals/index.js');
  const { getStats } = await import('../pi-ecosystem-subagents/index.js');
  const { getColonyStatus } = await import('../pi-ecosystem-colony/index.js');
  const config = await loadPiConfig();

  const mcpStatus = getAdapterStatus();
  const goalStats = getGoalStats();
  const subagentStats = getStats();
  const colonyStatus = getColonyStatus();

  return {
    initialized: !!config?.initializedAt,
    mcp: mcpStatus,
    goals: goalStats,
    subagents: subagentStats,
    colony: colonyStatus,
  };
}

/**
 * Unified Pi ecosystem CLI-like interface
 */
export class PiEcosystem {
  private initialized: boolean = false;

  async initialize(config?: Partial<PiEcosystemConfig>): Promise<void> {
    if (this.initialized) return;

    const [mcp, goals, subagents, colony] = await Promise.all([
      import('../pi-ecosystem-mcp/index.js'),
      import('../pi-ecosystem-goals/index.js'),
      import('../pi-ecosystem-subagents/index.js'),
      import('../pi-ecosystem-colony/index.js'),
    ]);

    await mcp.initializeMcpAdapter();
    await goals.loadGoals();
    await subagents.loadSubagents();
    await colony.loadColony();

    await initializePiEcosystem(config);

    this.initialized = true;
    console.log('[PiEcosystem] Initialization complete');
  }

  async getStatus(): Promise<PiEcosystemStatus> {
    return getPiEcosystemStatus();
  }

  async addMcpTool(config: { name: string; command: string; args?: string[]; env?: Record<string, string> }): Promise<void> {
    const mcp = await import('../pi-ecosystem-mcp/index.js');
    mcp.registerServer(config);
  }

  async listMcpTools(): Promise<string[]> {
    const mcp = await import('../pi-ecosystem-mcp/index.js');
    return mcp.listTools().map(t => t.name);
  }

  async createGoal(objective: string, budget?: { maxTimeMs: number; maxTokens: number }): Promise<string> {
    const goals = await import('../pi-ecosystem-goals/index.js');
    const goal = await goals.createGoal(objective, budget);
    return goal.id;
  }

  async createGoalQueue(objectives: string[]): Promise<string[]> {
    const goals = await import('../pi-ecosystem-goals/index.js');
    const goalList = await goals.createGoalQueue(objectives);
    return goalList.map(g => g.id);
  }

  async getCurrentGoal(): Promise<string | null> {
    const goals = await import('../pi-ecosystem-goals/index.js');
    const goal = goals.getCurrentGoal();
    return goal?.id || null;
  }

  async advanceGoal(result?: string): Promise<void> {
    const goals = await import('../pi-ecosystem-goals/index.js');
    if (result) {
      await goals.completeCurrentGoal(result);
    } else {
      await goals.completeCurrentGoal();
    }
  }

  async delegateTask(task: string, command: string): Promise<string> {
    const subagents = await import('../pi-ecosystem-subagents/index.js');
    const result = await subagents.delegateTask(task, command);
    return result.subagentId;
  }

  async listSubagents(): Promise<string[]> {
    const subagents = await import('../pi-ecosystem-subagents/index.js');
    return subagents.listSubagents().map(s => s.id);
  }

  async registerAnt(name: string, role: 'scout' | 'worker' | 'reviewer' | 'coordinator'): Promise<string> {
    const colony = await import('../pi-ecosystem-colony/index.js');
    const ant = colony.registerAnt(name, role);
    return ant.id;
  }

  async createColonyTask(description: string): Promise<string> {
    const colony = await import('../pi-ecosystem-colony/index.js');
    const task = colony.createTask(description);
    return task.id;
  }

  async dispatchToColony(taskId: string, antIds: string[]): Promise<void> {
    const colony = await import('../pi-ecosystem-colony/index.js');
    colony.dispatchTask(taskId, antIds);
  }

  async persist(): Promise<void> {
    const colony = await import('../pi-ecosystem-colony/index.js');
    await colony.persistColony();
  }

  async shutdown(): Promise<void> {
    await this.persist();
    console.log('[PiEcosystem] Shutdown complete');
  }
}

let piEcosystemInstance: PiEcosystem | null = null;

export function getPiEcosystem(): PiEcosystem {
  if (!piEcosystemInstance) {
    piEcosystemInstance = new PiEcosystem();
  }
  return piEcosystemInstance;
}

export async function ohMyPi(config?: Partial<PiEcosystemConfig>): Promise<PiEcosystem> {
  const ecosystem = getPiEcosystem();
  await ecosystem.initialize(config);
  return ecosystem;
}