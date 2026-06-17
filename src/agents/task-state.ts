/**
 * Task State Machine — M3.2 (2026-06-17)
 *
 * 长期项目响应的核心: agent 能跟踪一个多步任务的进度, 跨 loop / 跨 session 持久化
 *
 * 设计:
 * - 状态写入 ~/.bolloon/tasks/<task-id>.yaml
 * - task-id 由 LLM 在 user request 进来时生成 (或由 intent-classifier 自动给)
 * - 每个 plan 步骤有 status: pending | running | done | failed | skipped
 * - 写盘后 agent 在每个 loop iter 读 plan, 选下一个 pending step
 *
 * 简化版: 不强制 LLM 生成 plan (M3.1 已把 task plan 作为可选项, LLM 走 multi_step intent 时
 *   主动 plan), 只提供 plan 状态机 + 持久化 + 给 agent 的 API
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskStep {
  id: string;
  description: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  /** 工具调用的结果摘要 (LLM 自填) */
  resultSummary?: string;
  error?: string;
}

export interface Task {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: 'planning' | 'running' | 'paused' | 'completed' | 'failed';
  steps: TaskStep[];
  /** 关联的 git branch (M3.4: 自动 commit 用) */
  branch?: string;
  /** 关联的 session key (重启后回溯) */
  sessionKey?: string;
}

const TASK_DIR = path.join(os.homedir(), '.bolloon', 'tasks');

async function ensureDir(): Promise<void> {
  await fs.mkdir(TASK_DIR, { recursive: true });
}

export function generateTaskId(): string {
  return `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * YAML 简单序列化 (避免拉 js-yaml 进 task 模块)
 * 只支持 Task schema
 */
function serializeTask(t: Task): string {
  const lines: string[] = [
    `id: ${t.id}`,
    `goal: ${JSON.stringify(t.goal)}`,
    `createdAt: ${t.createdAt}`,
    `updatedAt: ${t.updatedAt}`,
    `status: ${t.status}`,
    `branch: ${t.branch || ''}`,
    `sessionKey: ${t.sessionKey || ''}`,
    `steps:`,
  ];
  for (const s of t.steps) {
    lines.push(`  - id: ${s.id}`);
    lines.push(`    description: ${JSON.stringify(s.description)}`);
    lines.push(`    status: ${s.status}`);
    if (s.startedAt) lines.push(`    startedAt: ${s.startedAt}`);
    if (s.finishedAt) lines.push(`    finishedAt: ${s.finishedAt}`);
    if (s.resultSummary) lines.push(`    resultSummary: ${JSON.stringify(s.resultSummary)}`);
    if (s.error) lines.push(`    error: ${JSON.stringify(s.error)}`);
  }
  return lines.join('\n') + '\n';
}

function parseTask(content: string): Task | null {
  try {
    const lines = content.split('\n');
    const task: Task = {
      id: '', goal: '', createdAt: '', updatedAt: '', status: 'planning', steps: [],
    };
    let currentStep: TaskStep | null = null;
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('- id:')) {
        if (currentStep) task.steps.push(currentStep);
        currentStep = { id: trimmed.slice(6).trim(), description: '', status: 'pending' };
        continue;
      }
      if (currentStep && trimmed.startsWith('description:')) {
        currentStep.description = JSON.parse(trimmed.slice(12).trim());
        continue;
      }
      if (currentStep && trimmed.startsWith('status:')) {
        currentStep.status = trimmed.slice(7).trim() as StepStatus;
        continue;
      }
      if (currentStep && trimmed.startsWith('startedAt:')) {
        currentStep.startedAt = trimmed.slice(10).trim();
        continue;
      }
      if (currentStep && trimmed.startsWith('finishedAt:')) {
        currentStep.finishedAt = trimmed.slice(12).trim();
        continue;
      }
      if (currentStep && trimmed.startsWith('resultSummary:')) {
        currentStep.resultSummary = JSON.parse(trimmed.slice(15).trim());
        continue;
      }
      if (currentStep && trimmed.startsWith('error:')) {
        currentStep.error = JSON.parse(trimmed.slice(7).trim());
        continue;
      }
      if (trimmed.startsWith('id:')) {
        task.id = trimmed.slice(3).trim();
      } else if (trimmed.startsWith('goal:')) {
        task.goal = JSON.parse(trimmed.slice(5).trim());
      } else if (trimmed.startsWith('createdAt:')) {
        task.createdAt = trimmed.slice(10).trim();
      } else if (trimmed.startsWith('updatedAt:')) {
        task.updatedAt = trimmed.slice(10).trim();
      } else if (trimmed.startsWith('status:')) {
        task.status = trimmed.slice(7).trim() as Task['status'];
      } else if (trimmed.startsWith('branch:')) {
        const v = trimmed.slice(7).trim();
        if (v) task.branch = v;
      } else if (trimmed.startsWith('sessionKey:')) {
        const v = trimmed.slice(11).trim();
        if (v) task.sessionKey = v;
      }
    }
    if (currentStep) task.steps.push(currentStep);
    if (!task.id) return null;
    return task;
  } catch {
    return null;
  }
}

async function taskPath(id: string): Promise<string> {
  await ensureDir();
  return path.join(TASK_DIR, `${id}.yaml`);
}

export async function createTask(opts: { goal: string; sessionKey?: string; steps?: string[]; branch?: string }): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: generateTaskId(),
    goal: opts.goal,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    branch: opts.branch,
    sessionKey: opts.sessionKey,
    steps: (opts.steps || []).map((desc, i) => ({
      id: `step-${i + 1}`,
      description: desc,
      status: i === 0 ? 'running' : 'pending',
      startedAt: i === 0 ? now : undefined,
    })),
  };
  const p = await taskPath(task.id);
  await fs.writeFile(p, serializeTask(task), 'utf-8');
  return task;
}

export async function getTask(id: string): Promise<Task | null> {
  try {
    const p = await taskPath(id);
    const content = await fs.readFile(p, 'utf-8');
    return parseTask(content);
  } catch {
    return null;
  }
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
  const t = await getTask(id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  const p = await taskPath(id);
  await fs.writeFile(p, serializeTask(t), 'utf-8');
  return t;
}

export async function updateStep(taskId: string, stepId: string, patch: Partial<TaskStep>): Promise<Task | null> {
  const t = await getTask(taskId);
  if (!t) return null;
  const step = t.steps.find((s) => s.id === stepId);
  if (!step) return null;
  Object.assign(step, patch);
  // 推进下一步: 当前 step done → 下一个 pending 变 running
  if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') {
    step.finishedAt = step.finishedAt || new Date().toISOString();
    const nextPending = t.steps.find((s) => s.status === 'pending');
    if (nextPending && patch.status === 'done') {
      nextPending.status = 'running';
      nextPending.startedAt = new Date().toISOString();
    }
  }
  // 检查整 task 是否完成
  if (t.steps.every((s) => s.status === 'done' || s.status === 'skipped')) {
    t.status = 'completed';
  } else if (t.steps.some((s) => s.status === 'failed')) {
    // 不立即置 failed, 留个机会让 LLM 调整
  }
  t.updatedAt = new Date().toISOString();
  const p = await taskPath(taskId);
  await fs.writeFile(p, serializeTask(t), 'utf-8');
  return t;
}

export async function listTasks(limit = 20): Promise<Task[]> {
  try {
    await ensureDir();
    const files = await fs.readdir(TASK_DIR);
    const tasks: Task[] = [];
    for (const f of files) {
      if (!f.endsWith('.yaml')) continue;
      const content = await fs.readFile(path.join(TASK_DIR, f), 'utf-8');
      const t = parseTask(content);
      if (t) tasks.push(t);
    }
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  } catch {
    return [];
  }
}
