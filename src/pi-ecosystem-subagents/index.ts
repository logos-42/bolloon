/**
 * Pi Subagents Integration for Bolloon
 *
 * Lightweight subagent implementation based on tmux multi-session.
 * Based on pi-subagents philosophy: simple task delegation and result collection.
 *
 * Key differences from Claude Code subagents:
 * - tmux-based sessions (not black-box background processes)
 * - Simple task委托 and result回收
 * - Full visibility into what each subagent is doing
 * - No complex scheduling - suitable for single task splitting
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export type SubagentStatus = 'created' | 'running' | 'idle' | 'completed' | 'failed' | 'terminated';

export interface Subagent {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  sessionId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface SubagentResult {
  subagentId: string;
  success: boolean;
  result?: string;
  error?: string;
  duration?: number;
}

export interface SubagentDelegateOptions {
  name?: string;
  timeoutMs?: number;
  onProgress?: (progress: string) => void;
}

// Session management
const sessions: Map<string, Subagent> = new Map();
const tmuxSessions: Map<string, ChildProcess> = new Map();
const SESSION_PREFIX = 'bolloon-subagent-';
const STATE_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'subagents');

/**
 * Generate a unique subagent ID
 */
function generateId(): string {
  return `sa-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a new tmux session for a subagent
 */
export async function createSubagent(
  task: string,
  options: SubagentDelegateOptions = {}
): Promise<Subagent> {
  const id = generateId();
  const sessionId = `${SESSION_PREFIX}${id}`;
  const name = options.name || `subagent-${id.substring(0, 8)}`;

  const subagent: Subagent = {
    id,
    name,
    task,
    status: 'created',
    sessionId,
    createdAt: new Date().toISOString(),
  };

  sessions.set(id, subagent);

  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(STATE_DIR, `${id}.json`),
    JSON.stringify(subagent, null, 2)
  );

  console.log(`[PiSubagents] Created subagent: ${id} - ${name}`);
  return subagent;
}

/**
 * Start a subagent in a tmux session
 */
export async function startSubagent(
  id: string,
  command: string,
  options: SubagentDelegateOptions = {}
): Promise<SubagentResult> {
  const subagent = sessions.get(id);
  if (!subagent) {
    return { subagentId: id, success: false, error: 'Subagent not found' };
  }

  if (subagent.status === 'running') {
    return { subagentId: id, success: false, error: 'Subagent already running' };
  }

  subagent.status = 'running';
  subagent.startedAt = new Date().toISOString();
  await saveSubagent(subagent);

  return new Promise((resolve) => {
    // Create a detached tmux session running the command
    const tmuxCmd = spawn('tmux', [
      'new-session',
      '-d',
      '-s',
      subagent.sessionId,
      command,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    tmuxSessions.set(id, tmuxCmd);

    const timeoutMs = options.timeoutMs || 5 * 60 * 1000;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateSubagent(id);
      subagent.status = 'failed';
      subagent.error = 'Task timeout';
      resolve({
        subagentId: id,
        success: false,
        error: 'Task timeout',
      });
    }, timeoutMs);

    tmuxCmd.on('error', (err) => {
      clearTimeout(timeout);
      subagent.status = 'failed';
      subagent.error = String(err);
      sessions.set(id, subagent);
      resolve({ subagentId: id, success: false, error: String(err) });
    });

    tmuxCmd.on('exit', async (code) => {
      clearTimeout(timeout);
      subagent.completedAt = new Date().toISOString();

      if (timedOut) return;

      if (code === 0) {
        subagent.status = 'completed';
        // Try to capture output
        try {
          const output = await captureTmuxOutput(subagent.sessionId);
          subagent.result = output;
          resolve({
            subagentId: id,
            success: true,
            result: output,
            duration: subagent.startedAt
              ? Date.now() - new Date(subagent.startedAt).getTime()
              : undefined,
          });
        } catch {
          resolve({
            subagentId: id,
            success: true,
            duration: subagent.startedAt
              ? Date.now() - new Date(subagent.startedAt).getTime()
              : undefined,
          });
        }
      } else {
        subagent.status = 'failed';
        subagent.error = `Exit code: ${code}`;
        resolve({
          subagentId: id,
          success: false,
          error: `Exit code: ${code}`,
          duration: subagent.startedAt
            ? Date.now() - new Date(subagent.startedAt).getTime()
            : undefined,
        });
      }

      sessions.set(id, subagent);
      await saveSubagent(subagent);
    });
  });
}

/**
 * Delegate a task to a new subagent and start it
 */
export async function delegateTask(
  task: string,
  command: string,
  options: SubagentDelegateOptions = {}
): Promise<SubagentResult> {
  const subagent = await createSubagent(task, options);
  return startSubagent(subagent.id, command, options);
}

/**
 * Capture output from a tmux session
 */
async function captureTmuxOutput(sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const capture = spawn('tmux', ['capture-pane', '-t', sessionId, '-p']);
    let output = '';

    capture.stdout.on('data', (data) => {
      output += data.toString();
    });

    capture.on('error', reject);
    capture.on('close', () => {
      resolve(output.trim());
    });
  });
}

/**
 * Send input to a running subagent
 */
export async function sendToSubagent(id: string, input: string): Promise<void> {
  const subagent = sessions.get(id);
  if (!subagent) {
    throw new Error('Subagent not found');
  }

  return new Promise((resolve, reject) => {
    const tmux = spawn('tmux', ['send-keys', '-t', subagent.sessionId, input, 'Enter']);
    tmux.on('error', reject);
    tmux.on('close', () => resolve());
  });
}

/**
 * Get subagent status
 */
export function getSubagent(id: string): Subagent | undefined {
  return sessions.get(id);
}

/**
 * List all subagents
 */
export function listSubagents(): Subagent[] {
  return Array.from(sessions.values());
}

/**
 * List running subagents
 */
export function listRunningSubagents(): Subagent[] {
  return Array.from(sessions.values()).filter((s) => s.status === 'running');
}

/**
 * Terminate a subagent
 */
export async function terminateSubagent(id: string): Promise<void> {
  const subagent = sessions.get(id);
  if (!subagent) return;

  // Kill tmux session
  spawn('tmux', ['kill-session', '-t', subagent.sessionId]);

  const tmuxProcess = tmuxSessions.get(id);
  if (tmuxProcess) {
    tmuxProcess.kill();
    tmuxSessions.delete(id);
  }

  subagent.status = 'terminated';
  subagent.completedAt = new Date().toISOString();
  sessions.set(id, subagent);
  await saveSubagent(subagent);

  console.log(`[PiSubagents] Terminated subagent: ${id}`);
}

/**
 * Save subagent state to disk
 */
async function saveSubagent(subagent: Subagent): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(STATE_DIR, `${subagent.id}.json`),
      JSON.stringify(subagent, null, 2)
    );
  } catch (e) {
    console.warn('[PiSubagents] Failed to save subagent:', e);
  }
}

/**
 * Load subagents from disk
 */
export async function loadSubagents(): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const files = await fs.readdir(STATE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readFile(path.join(STATE_DIR, file), 'utf-8');
        const subagent = JSON.parse(data) as Subagent;
        sessions.set(subagent.id, subagent);
      }
    }
    console.log(`[PiSubagents] Loaded ${sessions.size} subagents`);
  } catch {
    // Directory doesn't exist
  }
}

/**
 * Get subagent statistics
 */
export function getStats(): {
  total: number;
  running: number;
  completed: number;
  failed: number;
} {
  const all = Array.from(sessions.values());
  return {
    total: all.length,
    running: all.filter((s) => s.status === 'running').length,
    completed: all.filter((s) => s.status === 'completed').length,
    failed: all.filter((s) => s.status === 'failed').length,
  };
}

/**
 * Clean up terminated subagents
 */
export async function cleanupSubagents(): Promise<void> {
  const terminated = Array.from(sessions.values()).filter(
    (s) => s.status === 'terminated' || s.status === 'completed' || s.status === 'failed'
  );

  for (const subagent of terminated) {
    try {
      await fs.unlink(path.join(STATE_DIR, `${subagent.id}.json`));
      sessions.delete(subagent.id);
    } catch {
      // File doesn't exist
    }
  }

  if (terminated.length > 0) {
    console.log(`[PiSubagents] Cleaned up ${terminated.length} subagents`);
  }
}

/**
 * Execute a task in parallel using multiple subagents
 */
export async function parallelDelegate(
  tasks: string[],
  commandFactory: (task: string) => string,
  options: SubagentDelegateOptions = {}
): Promise<SubagentResult[]> {
  const promises = tasks.map((task) => delegateTask(task, commandFactory(task), options));
  return Promise.all(promises);
}

/**
 * Split a long-form task across multiple subagents
 * (e.g., writing and researching simultaneously)
 */
export async function splitTask(
  mainTask: string,
  subtasks: string[],
  commandFactory: (subtask: string) => string,
  options: SubagentDelegateOptions = {}
): Promise<Map<string, SubagentResult>> {
  const results = new Map<string, SubagentResult>();

  // Create all subagents
  const subagents = await Promise.all(
    subtasks.map((st) => createSubagent(`${mainTask}: ${st}`, options))
  );

  // Start all in parallel
  const promises = subagents.map((sa, i) =>
    startSubagent(sa.id, commandFactory(subtasks[i]), options).then((r) => ({
      subtask: subtasks[i],
      result: r,
    }))
  );

  const settled = await Promise.all(promises);
  for (const { subtask, result } of settled) {
    results.set(subtask, result);
  }

  return results;
}