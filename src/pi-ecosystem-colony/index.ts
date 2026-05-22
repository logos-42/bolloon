/**
 * Pi Ant Colony Integration for Bolloon
 *
 * Multi-agent collaboration system with white-box signal protocol.
 * Based on oh-pi's ant colony system: COLONY_SIGNAL protocol for agent coordination.
 *
 * Signal Protocol:
 * COLONY_SIGNAL:LAUNCHED → SCOUTING → WORKING → REVIEWING → COMPLETE
 *
 * Key features:
 * - Fully visible signal protocol (no black boxes)
 * - Per-ant turn limits, cost tracking, concurrent scheduling
 * - White-box design: no "what is it doing in the background" anxiety
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';

export type ColonySignal =
  | 'LAUNCHED'
  | 'SCOUTING'
  | 'WORKING'
  | 'REVIEWING'
  | 'COMPLETE'
  | 'FAILED'
  | 'ABORTED';

export type AntRole = 'scout' | 'worker' | 'reviewer' | 'coordinator';

export interface Ant {
  id: string;
  name: string;
  role: AntRole;
  signal: ColonySignal;
  turnCount: number;
  maxTurns: number;
  tokenBudget: number;
  tokensUsed: number;
  task?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ColonyTask {
  id: string;
  description: string;
  status: 'pending' | 'dispatched' | 'in_progress' | 'completed' | 'failed';
  assignedAnts: string[];
  results: Map<string, string>;
  createdAt: string;
  completedAt?: string;
}

export interface ColonySignalEvent {
  antId: string;
  antName: string;
  fromSignal: ColonySignal;
  toSignal: ColonySignal;
  timestamp: string;
  details?: string;
}

// Colony state
const ants: Map<string, Ant> = new Map();
const tasks: Map<string, ColonyTask> = new Map();
const signalHistory: ColonySignalEvent[] = [];

const STATE_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'colony');

// Event emitter
class ColonyEventEmitter extends EventEmitter {}
const colonyEvents = new ColonyEventEmitter();

/**
 * Generate a unique ant ID
 */
function generateAntId(): string {
  return `ant-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Register a new ant in the colony
 */
export function registerAnt(
  name: string,
  role: AntRole,
  maxTurns: number = 10,
  tokenBudget: number = 50000
): Ant {
  const id = generateAntId();
  const ant: Ant = {
    id,
    name,
    role,
    signal: 'LAUNCHED',
    turnCount: 0,
    maxTurns,
    tokenBudget,
    tokensUsed: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  ants.set(id, ant);
  emitSignal(id, 'LAUNCHED');

  console.log(`[Colony] Registered ant: ${name} (${role})`);
  return ant;
}

/**
 * Emit a signal transition
 */
function emitSignal(antId: string, newSignal: ColonySignal, details?: string): void {
  const ant = ants.get(antId);
  if (!ant) return;

  const event: ColonySignalEvent = {
    antId,
    antName: ant.name,
    fromSignal: ant.signal,
    toSignal: newSignal,
    timestamp: new Date().toISOString(),
    details,
  };

  signalHistory.push(event);
  if (signalHistory.length > 100) {
    signalHistory.shift();
  }

  ant.signal = newSignal;
  ant.updatedAt = new Date().toISOString();
  ants.set(antId, ant);

  colonyEvents.emit('signal', event);
  console.log(`[Colony] ${ant.name}: ${event.fromSignal} → ${event.toSignal}${details ? ` (${details})` : ''}`);
}

/**
 * Transition ant to SCOUTING
 */
export function antScouting(antId: string, task: string): void {
  const ant = ants.get(antId);
  if (!ant) return;

  ant.task = task;
  ants.set(antId, ant);
  emitSignal(antId, 'SCOUTING', `Task: ${task.substring(0, 50)}...`);
}

/**
 * Transition ant to WORKING
 */
export function antWorking(antId: string): void {
  const ant = ants.get(antId);
  if (!ant) return;

  emitSignal(antId, 'WORKING');
}

/**
 * Transition ant to REVIEWING
 */
export function antReviewing(antId: string): void {
  emitSignal(antId, 'REVIEWING');
}

/**
 * Complete ant work
 */
export function antComplete(antId: string, result: string): void {
  const ant = ants.get(antId);
  if (!ant) return;

  ant.result = result;
  ants.set(antId, ant);
  emitSignal(antId, 'COMPLETE', `Result: ${result.substring(0, 50)}...`);
}

/**
 * Fail ant work
 */
export function antFail(antId: string, error: string): void {
  const ant = ants.get(antId);
  if (!ant) return;

  ant.result = error;
  ants.set(antId, ant);
  emitSignal(antId, 'FAILED', error);
}

/**
 * Abort ant work
 */
export function antAbort(antId: string, reason: string): void {
  emitSignal(antId, 'ABORTED', reason);
}

/**
 * Increment turn count
 */
export function antTick(antId: string, tokensUsed: number = 0): void {
  const ant = ants.get(antId);
  if (!ant) return;

  ant.turnCount++;
  ant.tokensUsed += tokensUsed;
  ant.updatedAt = new Date().toISOString();
  ants.set(antId, ant);

  // Check if exceeded limits
  if (ant.turnCount >= ant.maxTurns) {
    antAbort(antId, 'Max turns exceeded');
  } else if (ant.tokensUsed >= ant.tokenBudget) {
    antAbort(antId, 'Token budget exceeded');
  }
}

/**
 * Create a colony task
 */
export function createTask(description: string): ColonyTask {
  const id = `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const task: ColonyTask = {
    id,
    description,
    status: 'pending',
    assignedAnts: [],
    results: new Map(),
    createdAt: new Date().toISOString(),
  };

  tasks.set(id, task);
  console.log(`[Colony] Created task: ${id} - ${description.substring(0, 50)}...`);
  return task;
}

/**
 * Dispatch task to ants
 */
export function dispatchTask(taskId: string, antIds: string[]): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.status = 'dispatched';
  task.assignedAnts = antIds;
  tasks.set(taskId, task);

  for (const antId of antIds) {
    const ant = ants.get(antId);
    if (ant) {
      antScouting(antId, task.description);
    }
  }

  console.log(`[Colony] Dispatched task ${taskId} to ${antIds.length} ants`);
}

/**
 * Record ant result for a task
 */
export function recordResult(taskId: string, antId: string, result: string): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.results.set(antId, result);

  // Check if all ants completed
  if (task.results.size === task.assignedAnts.length) {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();

    for (const id of task.assignedAnts) {
      antReviewing(id);
    }
  }

  tasks.set(taskId, task);
}

/**
 * Get ant by ID
 */
export function getAnt(antId: string): Ant | undefined {
  return ants.get(antId);
}

/**
 * List all ants
 */
export function listAnts(): Ant[] {
  return Array.from(ants.values());
}

/**
 * List ants by role
 */
export function listAntsByRole(role: AntRole): Ant[] {
  return Array.from(ants.values()).filter((a) => a.role === role);
}

/**
 * Get ants by signal state
 */
export function listAntsBySignal(signal: ColonySignal): Ant[] {
  return Array.from(ants.values()).filter((a) => a.signal === signal);
}

/**
 * Get active ants (not complete/failed/aborted)
 */
export function getActiveAnts(): Ant[] {
  return Array.from(ants.values()).filter((a) =>
    !['COMPLETE', 'FAILED', 'ABORTED'].includes(a.signal)
  );
}

/**
 * Get task by ID
 */
export function getTask(taskId: string): ColonyTask | undefined {
  return tasks.get(taskId);
}

/**
 * List all tasks
 */
export function listTasks(): ColonyTask[] {
  return Array.from(tasks.values());
}

/**
 * Get signal history
 */
export function getSignalHistory(): ColonySignalEvent[] {
  return [...signalHistory];
}

/**
 * Get colony status
 */
export function getColonyStatus(): {
  antCount: number;
  activeAnts: number;
  taskCount: number;
  activeTasks: number;
  signalDistribution: Record<ColonySignal, number>;
} {
  const antList = Array.from(ants.values());
  const taskList = Array.from(tasks.values());

  const signalDistribution: Record<ColonySignal, number> = {
    LAUNCHED: 0,
    SCOUTING: 0,
    WORKING: 0,
    REVIEWING: 0,
    COMPLETE: 0,
    FAILED: 0,
    ABORTED: 0,
  };

  for (const ant of antList) {
    signalDistribution[ant.signal]++;
  }

  return {
    antCount: antList.length,
    activeAnts: antList.filter((a) => !['COMPLETE', 'FAILED', 'ABORTED'].includes(a.signal)).length,
    taskCount: taskList.length,
    activeTasks: taskList.filter((t) => t.status === 'in_progress' || t.status === 'dispatched').length,
    signalDistribution,
  };
}

/**
 * Subscribe to colony events
 */
export function onColonyEvent(
  event: 'signal' | 'antRegistered' | 'taskCreated',
  callback: (...args: unknown[]) => void
): void {
  colonyEvents.on(event, callback);
}

/**
 * Unsubscribe from colony events
 */
export function offColonyEvent(
  event: 'signal' | 'antRegistered' | 'taskCreated',
  callback: (...args: unknown[]) => void
): void {
  colonyEvents.off(event, callback);
}

/**
 * Get formatted colony dump for debugging
 */
export function getColonyDump(): string {
  const status = getColonyStatus();
  const active = getActiveAnts();

  let dump = '# Colony Status\n\n';
  dump += `Ants: ${status.antCount} total, ${status.activeAnts} active\n`;
  dump += `Tasks: ${status.taskCount} total, ${status.activeTasks} active\n\n`;

  dump += '## Signal Distribution\n';
  for (const [signal, count] of Object.entries(status.signalDistribution)) {
    if (count > 0) {
      dump += `- ${signal}: ${count}\n`;
    }
  }

  dump += '\n## Active Ants\n';
  for (const ant of active) {
    dump += `- ${ant.name} (${ant.role}): ${ant.signal} [${ant.turnCount}/${ant.maxTurns} turns, ${ant.tokensUsed}/${ant.tokenBudget} tokens]\n`;
    if (ant.task) {
      dump += `  Task: ${ant.task.substring(0, 60)}...\n`;
    }
  }

  dump += '\n## Recent Signals\n';
  const recent = signalHistory.slice(-10);
  for (const event of recent.reverse()) {
    dump += `- ${event.timestamp}: ${event.antName}: ${event.fromSignal} → ${event.toSignal}\n`;
  }

  return dump;
}

/**
 * Persist colony state
 */
export async function persistColony(): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });

    const state = {
      ants: Array.from(ants.values()),
      tasks: Array.from(tasks.entries()).map(([id, t]) => ({
        ...t,
        results: Array.from(t.results.entries()),
      })),
      signalHistory: signalHistory.slice(-50),
      persistedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(STATE_DIR, 'colony.json'), JSON.stringify(state, null, 2));
    console.log('[Colony] Persisted state');
  } catch (e) {
    console.warn('[Colony] Failed to persist:', e);
  }
}

/**
 * Load colony state
 */
export async function loadColony(): Promise<void> {
  try {
    const data = await fs.readFile(path.join(STATE_DIR, 'colony.json'), 'utf-8');
    const state = JSON.parse(data);

    ants.clear();
    for (const a of state.ants) {
      ants.set(a.id, a);
    }

    tasks.clear();
    for (const t of state.tasks) {
      tasks.set(t.id, { ...t, results: new Map(t.results) });
    }

    signalHistory.length = 0;
    signalHistory.push(...state.signalHistory);

    console.log(`[Colony] Loaded ${ants.size} ants, ${tasks.size} tasks`);
  } catch {
    // No persisted state
  }
}