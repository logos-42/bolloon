/**
 * project-state.ts — 项目当前状态 (Layer 3)
 *
 * 2026-07-07 新增. 解决:
 *   - judgment 是"决策规则", 项目当前状态/目标/约束/待办没有结构化记录
 *   - 用户开启新 session 时无法 auto-inject "上次我们做到哪"
 *   - 远端/本地协作时, 双方项目状态不同步
 *
 * 设计:
 *   - state.json: ~/.bolloon/project/<safe-channelId>/state.json
 *   - 字段: goal / constraints / todos / done / updatedAt / updatedBy / version
 *   - 写盘走 append-only diff (每次写盘生成新版本号, 不覆盖历史快照)
 *   - 失败静默不阻塞主对话
 *
 * 触发:
 *   - server.ts: LLM 回答完后, prompt 注入当前 state (LLM 不会自动改, 只读取)
 *   - 用户可手动调 PATCH /api/state/:channelId 改写
 *   - future: 加 LLM 自动建议更新 (UI 弹 confirm)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============== 类型 ==============

export interface ProjectState {
  /** 唯一项目目标, 一句话 */
  goal: string;
  /** 约束条件列表 (例如 "不能用 npm 包" / "必须跨平台") */
  constraints: string[];
  /** 当前待办 (open tasks) */
  todos: string[];
  /** 已完成事项 (closed tasks) — 倒序, 最多保留 20 条 */
  done: string[];
  /** 最后更新时间 (ISO) */
  updatedAt: string;
  /** 最后更新者 (user / agent / system) */
  updatedBy: string;
  /** 版本号 (monotonic, 每次写盘 +1) */
  version: number;
}

export interface ReadStateOptions {
  channelId: string;
  home?: string;
}

export interface WriteStateOptions {
  channelId: string;
  state: Omit<ProjectState, 'updatedAt' | 'version'>;
  home?: string;
}

export interface MergeStateOptions {
  channelId: string;
  /** 部分字段 patch */
  patch: Partial<Pick<ProjectState, 'goal' | 'constraints' | 'todos' | 'done'>>;
  updatedBy: string;
  home?: string;
}

// ============== 路径 ==============

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function getStateDir(channelId: string, home?: string): string {
  return path.join(home || os.homedir(), '.bolloon', 'project', sanitize(channelId));
}

export function getStatePath(channelId: string, home?: string): string {
  return path.join(getStateDir(channelId, home), 'state.json');
}

export function getStateBackupPath(channelId: string, home?: string): string {
  return path.join(getStateDir(channelId, home), 'state.backup.jsonl');
}

// ============== 默认 ==============

export function defaultState(channelId: string): ProjectState {
  return {
    goal: '',
    constraints: [],
    todos: [],
    done: [],
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'system',
    version: 0,
  };
}

// ============== 读取 ==============

/**
 * 读 state.json. 文件不存在 → 返回默认空 state.
 * 损坏 → 返回默认 state + console.warn, 不抛错.
 */
export async function readState(opts: ReadStateOptions): Promise<ProjectState> {
  const filePath = getStatePath(opts.channelId, opts.home);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return defaultState(opts.channelId);
    return {
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.filter((x: any) => typeof x === 'string') : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos.filter((x: any) => typeof x === 'string') : [],
      done: Array.isArray(parsed.done) ? parsed.done.filter((x: any) => typeof x === 'string') : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : 'system',
      version: typeof parsed.version === 'number' ? parsed.version : 0,
    };
  } catch (e: any) {
    if (e?.code !== 'ENOENT') console.warn(`[project-state] ${opts.channelId} 损坏: ${e?.message || e}`);
    return defaultState(opts.channelId);
  }
}

// ============== 写 ==============

/**
 * 完整覆盖写入 state.json. 自动:
 *   1. 备份当前 state 到 state.backup.jsonl (append-only)
 *   2. 设置 updatedAt + version +1
 *   3. done 数组截断到 20 条
 */
export async function writeState(opts: WriteStateOptions): Promise<{ path: string; version: number }> {
  const filePath = getStatePath(opts.channelId, opts.home);
  const backupPath = getStateBackupPath(opts.channelId, opts.home);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // 备份当前 (append-only)
  const cur = await readState(opts);
  if (cur.version > 0) {
    const line = JSON.stringify({ ...cur, backupAt: new Date().toISOString() }) + '\n';
    try {
      await fs.appendFile(backupPath, line, 'utf-8');
    } catch (e: any) {
      console.warn(`[project-state] backup 失败: ${e?.message || e}`);
    }
  }

  const next: ProjectState = {
    goal: opts.state.goal,
    constraints: opts.state.constraints || [],
    todos: opts.state.todos || [],
    done: (opts.state.done || []).slice(-20),
    updatedAt: new Date().toISOString(),
    updatedBy: opts.state.updatedBy || 'system',
    version: cur.version + 1,
  };

  await fs.writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8');
  return { path: filePath, version: next.version };
}

/**
 * 部分字段 patch. 合并现有 state + patch.
 */
export async function mergeState(opts: MergeStateOptions): Promise<ProjectState> {
  const cur = await readState(opts);
  const merged = {
    goal: opts.patch.goal ?? cur.goal,
    constraints: opts.patch.constraints ?? cur.constraints,
    todos: opts.patch.todos ?? cur.todos,
    done: opts.patch.done ?? cur.done,
    updatedBy: opts.updatedBy,
  };
  const r = await writeState({ channelId: opts.channelId, state: merged, home: opts.home });
  return { ...merged, updatedAt: new Date().toISOString(), version: r.version };
}

// ============== 简易操作 ==============

/** 加一条 todo */
export async function addTodo(opts: { channelId: string; text: string; home?: string }): Promise<ProjectState> {
  const cur = await readState(opts);
  const todos = [...cur.todos, opts.text];
  return mergeState({ channelId: opts.channelId, patch: { todos }, updatedBy: 'user', home: opts.home });
}

/** 标记 todo 完成 (移到 done) */
export async function markTodoDone(opts: { channelId: string; text: string; home?: string }): Promise<ProjectState> {
  const cur = await readState(opts);
  const todos = cur.todos.filter(t => t !== opts.text);
  const done = [opts.text, ...cur.done].slice(0, 20);
  return mergeState({ channelId: opts.channelId, patch: { todos, done }, updatedBy: 'user', home: opts.home });
}

/** 清空所有 todos (批量完成) */
export async function clearTodos(opts: { channelId: string; home?: string }): Promise<ProjectState> {
  return mergeState({ channelId: opts.channelId, patch: { todos: [] }, updatedBy: 'user', home: opts.home });
}

/** 格式化 state 为 LLM prompt 注入文本 (单段落, ≤ 600 字) */
export function formatStateForPrompt(state: ProjectState): string {
  if (state.version === 0 && !state.goal) return '';
  const lines: string[] = [];
  if (state.goal) lines.push(`目标: ${state.goal}`);
  if (state.constraints.length > 0) lines.push(`约束: ${state.constraints.slice(0, 5).join('; ')}`);
  if (state.todos.length > 0) lines.push(`待办 (${state.todos.length}): ${state.todos.slice(0, 5).join('; ')}`);
  if (state.done.length > 0) lines.push(`已完成 (最近): ${state.done.slice(0, 3).join('; ')}`);
  if (lines.length === 0) return '';
  return `## 项目当前状态 (v${state.version}, ${state.updatedBy} @ ${state.updatedAt.slice(0, 16)})\n${lines.join('\n')}`;
}