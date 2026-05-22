/**
 * Pi Goals Integration for Bolloon
 *
 * Provides persistent goal tracking and workflow orchestration.
 * Based on pi-goals philosophy: goal-oriented agent workflows with budget enforcement.
 *
 * Key features:
 * - Persistent goal state across sessions
 * - Goal queue with FIFO execution
 * - Budget enforcement (max time/tokens, min work thresholds)
 * - Workflow templates with {{args}} placeholders
 * - Churn monitoring to detect drift/stalling
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Goal state
export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  budget?: GoalBudget;
  result?: string;
  error?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused' | 'cutoff';

export interface GoalBudget {
  maxTimeMs: number;
  maxTokens: number;
  minWorkMs?: number;
  minTokens?: number;
}

export interface GoalQueue {
  goals: Goal[];
  currentIndex: number;
}

// Workflow template
export interface WorkflowTemplate {
  name: string;
  description?: string;
  goals: string[];
  args?: Record<string, { description?: string; default?: string }>;
  gate?: string;
}

// Churn detection
export interface ChurnEvent {
  goalId: string;
  type: 'drift' | 'stall' | 'repeat';
  message: string;
  timestamp: string;
}

// State
let goalQueue: Goal[] = [];
let currentIndex = 0;
const GOALS_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'goals');
const GOALS_FILE = path.join(GOALS_DIR, 'queue.json');
const CHURN_FILE = path.join(GOALS_DIR, 'churn.json');
const TEMPLATES_DIR = path.join(process.cwd(), '.pi-goals');
const TEMPLATES_DIR_ALT = path.join(process.cwd(), '.ai', '.pi-goals');

// Churn monitoring
let churnEvents: ChurnEvent[] = [];
let lastGoalSnapshot: { goalId: string; hash: string; timestamp: string } | null = null;

/**
 * Generate a unique goal ID
 */
function generateGoalId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a new goal
 */
export async function createGoal(objective: string, budget?: GoalBudget, metadata?: Record<string, unknown>): Promise<Goal> {
  const goal: Goal = {
    id: generateGoalId(),
    objective,
    status: 'pending',
    createdAt: new Date().toISOString(),
    budget,
    metadata,
  };

  goalQueue.push(goal);
  await persistGoals();

  console.log(`[PiGoals] Created goal: ${goal.id} - ${objective.substring(0, 50)}...`);
  return goal;
}

/**
 * Create a queue of goals
 */
export async function createGoalQueue(objectives: string[], budgets?: GoalBudget[]): Promise<Goal[]> {
  const goals = await Promise.all(
    objectives.map((obj, i) => createGoal(obj, budgets?.[i]))
  );
  return goals;
}

/**
 * Get current goal
 */
export function getCurrentGoal(): Goal | undefined {
  return goalQueue[currentIndex];
}

/**
 * Start current goal
 */
export async function startCurrentGoal(): Promise<Goal | undefined> {
  const goal = getCurrentGoal();
  if (goal) {
    goal.status = 'in_progress';
    goal.startedAt = new Date().toISOString();
    await persistGoals();
    console.log(`[PiGoals] Started goal: ${goal.id}`);
  }
  return goal;
}

/**
 * Complete current goal with result
 */
export async function completeCurrentGoal(result?: string): Promise<Goal | undefined> {
  const goal = getCurrentGoal();
  if (goal) {
    goal.status = 'completed';
    goal.completedAt = new Date().toISOString();
    goal.result = result;

    // Summarize for context management
    goal.summary = summarizeGoal(goal);

    // Check budget enforcement
    if (goal.budget?.minWorkMs || goal.budget?.minTokens) {
      const meetsMin = checkMinimumWork(goal);
      if (!meetsMin) {
        console.warn(`[PiGoals] Goal ${goal.id} did not meet minimum work threshold`);
      }
    }

    currentIndex++;
    await persistGoals();
    await persistChurn();

    console.log(`[PiGoals] Completed goal: ${goal.id} (${currentIndex}/${goalQueue.length})`);
  }
  return goal;
}

/**
 * Fail current goal
 */
export async function failCurrentGoal(error: string): Promise<Goal | undefined> {
  const goal = getCurrentGoal();
  if (goal) {
    goal.status = 'failed';
    goal.completedAt = new Date().toISOString();
    goal.error = error;
    goal.summary = summarizeGoal(goal);

    currentIndex++;
    await persistGoals();

    console.log(`[PiGoals] Failed goal: ${goal.id} - ${error}`);
  }
  return goal;
}

/**
 * Cutoff current goal (exceeded budget)
 */
export async function cutoffCurrentGoal(reason: string): Promise<Goal | undefined> {
  const goal = getCurrentGoal();
  if (goal) {
    goal.status = 'cutoff';
    goal.completedAt = new Date().toISOString();
    goal.error = reason;
    goal.summary = summarizeGoal(goal);

    currentIndex++;
    await persistGoals();

    addChurnEvent(goal.id, 'drift', `Goal cut off: ${reason}`);

    console.log(`[PiGoals] Cutoff goal: ${goal.id} - ${reason}`);
  }
  return goal;
}

/**
 * Pause current goal
 */
export async function pauseCurrentGoal(): Promise<Goal | undefined> {
  const goal = getCurrentGoal();
  if (goal) {
    goal.status = 'paused';
    goal.completedAt = new Date().toISOString();
    await persistGoals();
    console.log(`[PiGoals] Paused goal: ${goal.id}`);
  }
  return goal;
}

/**
 * Check budget for a goal
 */
export function checkBudget(goal: Goal, elapsedMs?: number, tokensUsed?: number): { exceeded: boolean; reason?: string } {
  if (!goal.budget) return { exceeded: false };

  if (goal.budget.maxTimeMs && elapsedMs && elapsedMs > goal.budget.maxTimeMs) {
    return { exceeded: true, reason: `Time budget exceeded: ${elapsedMs}ms > ${goal.budget.maxTimeMs}ms` };
  }

  if (goal.budget.maxTokens && tokensUsed && tokensUsed > goal.budget.maxTokens) {
    return { exceeded: true, reason: `Token budget exceeded: ${tokensUsed} > ${goal.budget.maxTokens}` };
  }

  return { exceeded: false };
}

/**
 * Check minimum work threshold
 */
function checkMinimumWork(goal: Goal): boolean {
  if (!goal.budget) return true;

  // Simplified - in practice would track actual time/token usage
  if (goal.budget.minWorkMs && goal.startedAt) {
    const elapsed = Date.now() - new Date(goal.startedAt).getTime();
    if (elapsed < goal.budget.minWorkMs) {
      return false;
    }
  }

  return true;
}

/**
 * Detect churn (goal drift, stall, repeat)
 */
function detectChurn(goal: Goal): ChurnEvent | null {
  if (!lastGoalSnapshot || lastGoalSnapshot.goalId !== goal.id) {
    lastGoalSnapshot = {
      goalId: goal.id,
      hash: hashGoal(goal),
      timestamp: new Date().toISOString(),
    };
    return null;
  }

  const currentHash = hashGoal(goal);

  // Same goal, same state - stall
  if (currentHash === lastGoalSnapshot.hash) {
    const stallTime = Date.now() - new Date(lastGoalSnapshot.timestamp).getTime();
    if (stallTime > 5 * 60 * 1000) {
      // 5 minutes
      return {
        goalId: goal.id,
        type: 'stall',
        message: `Goal stalled for ${Math.floor(stallTime / 60000)} minutes`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  lastGoalSnapshot = {
    goalId: goal.id,
    hash: currentHash,
    timestamp: new Date().toISOString(),
  };

  return null;
}

/**
 * Hash goal state for churn detection
 */
function hashGoal(goal: Goal): string {
  return `${goal.id}-${goal.status}-${goal.objective.substring(0, 50)}`;
}

/**
 * Add a churn event
 */
function addChurnEvent(goalId: string, type: ChurnEvent['type'], message: string): void {
  const event: ChurnEvent = {
    goalId,
    type,
    message,
    timestamp: new Date().toISOString(),
  };
  churnEvents.push(event);

  if (churnEvents.length > 50) {
    churnEvents = churnEvents.slice(-25);
  }
}

/**
 * Get churn events for current goal
 */
export function getChurnForGoal(goalId: string): ChurnEvent[] {
  return churnEvents.filter((e) => e.goalId === goalId);
}

/**
 * Summarize a goal for context management
 */
function summarizeGoal(goal: Goal): string {
  const duration = goal.startedAt && goal.completedAt
    ? Math.round((new Date(goal.completedAt).getTime() - new Date(goal.startedAt).getTime()) / 1000)
    : 0;

  return `[${goal.status.toUpperCase()}] ${goal.objective.substring(0, 100)}${goal.objective.length > 100 ? '...' : ''} | Duration: ${duration}s`;
}

/**
 * Get goal statistics
 */
export function getGoalStats(): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  paused: number;
  cutoff: number;
} {
  return {
    total: goalQueue.length,
    pending: goalQueue.filter((g) => g.status === 'pending').length,
    inProgress: goalQueue.filter((g) => g.status === 'in_progress').length,
    completed: goalQueue.filter((g) => g.status === 'completed').length,
    failed: goalQueue.filter((g) => g.status === 'failed').length,
    paused: goalQueue.filter((g) => g.status === 'paused').length,
    cutoff: goalQueue.filter((g) => g.status === 'cutoff').length,
  };
}

/**
 * Get queue summary
 */
export function getQueueSummary(): string {
  const stats = getGoalStats();
  const current = getCurrentGoal();

  let summary = `# Goal Queue\n\n`;
  summary += `Total: ${stats.total} | Pending: ${stats.pending} | Active: ${stats.inProgress} | Done: ${stats.completed + stats.failed + stats.cutoff}\n\n`;

  if (current) {
    summary += `Current: ${current.objective}\n`;
    summary += `Status: ${current.status}\n`;
    if (current.budget) {
      summary += `Budget: maxTime=${current.budget.maxTimeMs}ms, maxTokens=${current.budget.maxTokens}\n`;
    }
  }

  summary += `\n## Recent Goals\n`;
  const recent = goalQueue.slice(-5).reverse();
  for (const g of recent) {
    summary += `- [${g.status}] ${g.objective.substring(0, 60)}${g.objective.length > 60 ? '...' : ''}\n`;
  }

  return summary;
}

/**
 * Persist goals to disk
 */
async function persistGoals(): Promise<void> {
  try {
    await fs.mkdir(GOALS_DIR, { recursive: true });
    await fs.writeFile(
      GOALS_FILE,
      JSON.stringify(
        {
          goals: goalQueue,
          currentIndex,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (e) {
    console.warn('[PiGoals] Failed to persist:', e);
  }
}

/**
 * Persist churn events
 */
async function persistChurn(): Promise<void> {
  try {
    await fs.mkdir(GOALS_DIR, { recursive: true });
    await fs.writeFile(CHURN_FILE, JSON.stringify(churnEvents, null, 2));
  } catch (e) {
    console.warn('[PiGoals] Failed to persist churn:', e);
  }
}

/**
 * Load goals from disk
 */
export async function loadGoals(): Promise<void> {
  try {
    const data = await fs.readFile(GOALS_FILE, 'utf-8');
    const state = JSON.parse(data);
    goalQueue = state.goals || [];
    currentIndex = state.currentIndex || 0;
    console.log(`[PiGoals] Loaded ${goalQueue.length} goals, current index: ${currentIndex}`);
  } catch {
    goalQueue = [];
    currentIndex = 0;
  }
}

/**
 * Load churn events
 */
async function loadChurn(): Promise<void> {
  try {
    const data = await fs.readFile(CHURN_FILE, 'utf-8');
    churnEvents = JSON.parse(data);
  } catch {
    churnEvents = [];
  }
}

/**
 * Clear all goals
 */
export async function clearGoals(): Promise<void> {
  goalQueue = [];
  currentIndex = 0;
  await persistGoals();
  console.log('[PiGoals] Cleared all goals');
}

/**
 * Remove completed goals and compact queue
 */
export async function compactQueue(): Promise<void> {
  const completed = goalQueue.filter((g) =>
    ['completed', 'failed', 'cutoff'].includes(g.status)
  );

  // Keep only summaries for completed goals
  goalQueue = goalQueue.filter((g) =>
    ['pending', 'in_progress', 'paused'].includes(g.status)
  );

  // Re-index
  currentIndex = Math.min(currentIndex, goalQueue.length);

  await persistGoals();
  console.log(`[PiGoals] Compacted queue: removed ${completed.length} completed goals`);
}

/**
 * Load workflow templates
 */
export async function loadTemplates(): Promise<WorkflowTemplate[]> {
  const templates: WorkflowTemplate[] = [];

  for (const dir of [TEMPLATES_DIR, TEMPLATES_DIR_ALT]) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const content = await fs.readFile(path.join(dir, file), 'utf-8');
          const template = parseTemplate(file.replace('.md', ''), content);
          if (template) {
            templates.push(template);
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return templates;
}

/**
 * Parse a workflow template
 */
function parseTemplate(name: string, content: string): WorkflowTemplate | null {
  const lines = content.split('\n');

  // Simple frontmatter parsing
  let description = '';
  const goals: string[] = [];
  const args: Record<string, { description?: string; default?: string }> = {};
  let gate: string | undefined;

  let inGoals = false;
  for (const line of lines) {
    if (line.startsWith('description:')) {
      description = line.replace('description:', '').trim();
    } else if (line.startsWith('gate:')) {
      gate = line.replace('gate:', '').trim();
    } else if (line.startsWith('---')) {
      inGoals = !inGoals;
    } else if (inGoals && line.trim().startsWith('-')) {
      goals.push(line.trim().substring(1).trim());
    } else if (line.includes(':')) {
      const [key, ...rest] = line.split(':');
      if (rest.length > 0) {
        const value = rest.join(':').trim();
        if (value.startsWith('{{') && value.endsWith('}}')) {
          args[key.trim()] = { default: value };
        } else {
          args[key.trim()] = { description: value };
        }
      }
    }
  }

  if (goals.length === 0) {
    return null;
  }

  return { name, description, goals, args, gate };
}

/**
 * Create goals from a template
 */
export async function createFromTemplate(
  templateName: string,
  args: Record<string, string>
): Promise<Goal[]> {
  const templates = await loadTemplates();
  const template = templates.find((t) => t.name === templateName);

  if (!template) {
    throw new Error(`Template not found: ${templateName}`);
  }

  const goals: Goal[] = [];
  for (const goalText of template.goals) {
    // Replace {{args}}
    let objective = goalText;
    for (const [key, value] of Object.entries(args)) {
      objective = objective.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    const goal = await createGoal(objective, undefined, { template: templateName });
    goals.push(goal);
  }

  return goals;
}

/**
 * Continue working on current goal (anti-stall)
 */
export async function nudgeCurrentGoal(): Promise<Goal | undefined> {
  const goal = getCurrentGoal();
  if (goal) {
    const churn = detectChurn(goal);
    if (churn) {
      addChurnEvent(goal.id, churn.type, churn.message);
      console.warn(`[PiGoals] Churn detected: ${churn.message}`);
    }
  }
  return goal;
}
