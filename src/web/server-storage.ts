/**
 * server-storage.ts — server.ts 拆出的持久化层
 *
 * 包含:
 *   - loadChannels / saveChannels + 去重 + 写盘保护
 *   - loadSession / saveSession + 50MB 内存保护
 *   - loadTheme / saveTheme
 *   - 任务队列 (loadTaskQueue / saveTaskQueue / executeTask)
 *
 * 从 src/web/server.ts 抽出 (2026-07-06).
 * Channel / Session / Task / SessionMessage / SessionSummary type 来自 ./server-types.ts.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  CHANNELS_PATH,
  SESSION_CACHE_PATH,
  TASK_QUEUE_PATH,
  THEME_PATH,
  type Channel,
  type Session,
  type Task,
} from './server-types.js';
import { saveWindow as saveSessionWindow, loadWindow as loadSessionWindow } from '../bootstrap/session-window.js';
import { parentsSatisfied } from './task-deps.js';

// 写盘去重: 上次写盘内容, 用于跳过幂等调用
let lastChannelsJson = '';
// 写盘保护: 任何调用 saveChannels 后更新
let lastChannelsWriteAt = 0;
// 2026-07-24: 简单的互斥锁, 防止并发 loadChannels→modify→saveChannels 的经典 read-modify-write 竞争
let channelsLock: Promise<any> = Promise.resolve();

export function getLastChannelsWriteAt(): number {
  return lastChannelsWriteAt;
}

/** 对 channels 执行原子化的 read-modify-write, 自带互斥锁 */
export async function updateChannels(fn: (channels: Channel[]) => Channel[]): Promise<Channel[]> {
  const run = channelsLock.then(async () => {
    const chs = await rawLoadChannels();
    const result = fn(chs);
    await rawSaveChannels(result);
    return result;
  });
  // 2026-08-02 fix: 失败不毒化锁链 — 之前 channelsLock = channelsLock.then(...),
  //   某次 fn 抛错 → 整个链变 rejected → 之后所有 updateChannels 直接 reject,
  //   fn 不再执行 → UI 创建 channel 偶发"不落盘" (静默丢失).
  channelsLock = run.catch((e) => {
    console.error('[updateChannels] 失败 (已隔离, 不影响后续操作):', e?.message || e);
    return undefined;
  });
  return run;
}

async function rawLoadChannels(): Promise<Channel[]> {
  try {
    const data = await fs.readFile(CHANNELS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (readErr: any) {
    // 2026-07-24: 主文件损坏时尝试从 .tmp 恢复
    if (readErr?.code !== 'ENOENT') {
      console.warn('[loadChannels] channels.json 解析失败, 尝试从 .tmp 恢复:', readErr?.message?.slice(0, 80));
      try {
        const tmpData = await fs.readFile(CHANNELS_PATH + '.tmp', 'utf-8');
        const recovered = JSON.parse(tmpData);
        console.log(`[loadChannels] 从 .tmp 恢复成功: ${recovered.length} 个 channel`);
        // 立即把恢复的内容写回主文件
        await fs.writeFile(CHANNELS_PATH, tmpData, 'utf-8');
        return recovered;
      } catch (tmpErr: any) {
        console.warn('[loadChannels] .tmp 恢复也失败:', tmpErr?.message?.slice(0, 80));
      }
    }
    return [];
  }
}

async function rawSaveChannels(channels: Channel[]): Promise<void> {
  const sanitized = channels.map(ch => {
    const { didDocument: _omit, ...rest } = ch as any;
    return rest as Channel;
  });
  const jsonStr = JSON.stringify(sanitized, null, 2);
  if (jsonStr === lastChannelsJson) return;
  lastChannelsJson = jsonStr;
  console.log('[saveChannels] 保存频道数据, 数量:', sanitized.length);
  // 2026-07-24: 原子写入 — 先写 .tmp 再 rename, 防止崩溃导致 channels.json 损坏
  const tmpPath = CHANNELS_PATH + '.tmp';
  await fs.writeFile(tmpPath, jsonStr, 'utf-8');
  await fs.rename(tmpPath, CHANNELS_PATH);
  lastChannelsWriteAt = Date.now();
}

export async function loadChannels(): Promise<Channel[]> {
  return rawLoadChannels();
}

export async function saveChannels(channels: Channel[]): Promise<void> {
  return rawSaveChannels(channels);
}

/**
 * loadSession 加 L0 window fallback 链 (2026-07-07 P0-B):
 *   1) full session.json (主路径)
 *   2) full 超 50MB 拒加载 → 读 <key>.window.json
 *   3) window 也没有 → 返回 null (前端 fallback "你好! 我是 Bolloon Agent")
 */
export async function loadSession(channelId: string, sessionId?: string): Promise<Session | null> {
  const key = sessionId ? `${channelId}:${sessionId}` : channelId;
  const sessionPath = `${SESSION_CACHE_PATH}/${key}.json`;
  const sid = sessionId || 'default';
  try {
    // 内存保护: 拒绝加载过大的 session 文件 (> 50MB 视为异常, 避免 OOM)
    const stat = await fs.stat(sessionPath);
    if (stat.size > 50 * 1024 * 1024) {
      console.warn(`[loadSession] session 过大 (${stat.size} bytes): ${key}, fallback to window`);
      return await loadSessionWindowFallback(channelId, sid);
    }
    const data = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    // 文件不存在 → 仍尝试 window (可能上次 session 删了, window 还在)
    return await loadSessionWindowFallback(channelId, sid);
  }
}

/** window-only fallback: 窗口消息填入 Session.messages, 其他字段填占位 */
async function loadSessionWindowFallback(channelId: string, sessionId: string): Promise<Session | null> {
  const win = await loadSessionWindow(channelId, sessionId);
  if (!win || win.messages.length === 0) return null;
  console.log(`[loadSession] window fallback for ${channelId}: ${sessionId}, ${win.messages.length} msgs (${win.totalBehind} behind)`);
  // WindowEntry → SessionMessage 映射 (id/timestamp 缺失时补占位)
  const messages: Session['messages'] = win.messages.map((m, idx) => ({
    id: m.id || `win-${win.lastUpdated}-${idx}`,
    type: (m.type === 'user' || m.type === 'ai' ? m.type : 'user'),
    content: m.content,
    timestamp: m.timestamp || win.lastUpdated,
    metadata: m.metadata,
  }));
  return {
    channelId,
    sessionId,
    messages,
    lastUpdated: win.lastUpdated,
    _windowOnly: true as const,
    _totalBehind: win.totalBehind,
  } as unknown as Session;
}

export async function saveSession(session: Session): Promise<void> {
  const key = session.sessionId ? `${session.channelId}:${session.sessionId}` : session.channelId;
  const sessionPath = `${SESSION_CACHE_PATH}/${key}.json`;
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
  // L0 窗口联动 (2026-07-07): 同步写最近 30 条到 <key>.window.json
  // 失败静默 — 不阻塞主对话流
  try {
    await saveSessionWindow(
      session.channelId,
      session.sessionId || 'default',
      session.messages || [],
      { windowSize: 30 }
    );
  } catch (e: any) {
    console.warn(`[saveSession] window write failed for ${key}: ${e?.message || e}`);
  }
}

export async function loadTheme(): Promise<{ theme: 'light' | 'dark'; agentId: string }> {
  try {
    const data = await fs.readFile(THEME_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { theme: 'light', agentId: '' };
  }
}

export async function saveTheme(theme: 'light' | 'dark', agentId: string): Promise<void> {
  await fs.writeFile(THEME_PATH, JSON.stringify({ theme, agentId }, null, 2));
}

// ==================== Task Queue & Workflow System ====================

let isExecutingTask = false;
let executionTaskId: string | null = null;

export function isTaskExecuting(): boolean {
  return isExecutingTask;
}

export function getExecutingTaskId(): string | null {
  return executionTaskId;
}

export async function loadTaskQueue(): Promise<Task[]> {
  try {
    const data = await fs.readFile(TASK_QUEUE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function saveTaskQueue(tasks: Task[]): Promise<void> {
  await fs.writeFile(TASK_QUEUE_PATH, JSON.stringify(tasks, null, 2));
}

// ==================== 任务认领 CAS (2026-08-11, Hermes kanban 模式) ====================
// kanban_db.py: "WAL + BEGIN IMMEDIATE + compare-and-swap on tasks.status/claim_lock —
//   至多一个 worker 能认领任务, 输家看到 0 行受影响就退出, 无重试循环, 无分布式锁."
// Bolloon 对应: 任务队列是 JSON 文件, 用进程内互斥链 (withTaskQueueLock) 序列化
//   load→CAS(status==='pending'→'running')→save, 输家返回 null/not-pending, 不重试.

let taskQueueLock: Promise<void> = Promise.resolve();

function withTaskQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = taskQueueLock.then(fn);
  taskQueueLock = run.then(() => undefined, () => undefined);
  return run;
}

export type ClaimResult = 'claimed' | 'not-pending' | 'busy' | 'parents-undone';

/** 认领 TTL 默认 15min (BOLLOON_CLAIM_TTL_SECONDS 可调) — Hermes DEFAULT_CLAIM_TTL_SECONDS=15*60 */
export function claimTtlSeconds(): number {
  const v = Number(process.env.BOLLOON_CLAIM_TTL_SECONDS || '');
  return v > 0 ? v : 15 * 60;
}

/**
 * CAS 认领指定任务: 只有 status==='pending' 才能认领成功 (原子翻成 running).
 * 认领点强制父依赖不变式 (Hermes kanban): 任一父未 completed/cancelled → 不认领, 返回 'parents-undone'.
 * 认领写 claim_expires (TTL) — 崩溃/卡死后由 releaseStaleClaims 释放, 锁不泄漏.
 */
export async function claimTaskForExecution(taskId: string): Promise<ClaimResult> {
  if (isExecutingTask) return 'busy';
  return withTaskQueueLock(async () => {
    if (isExecutingTask) return 'busy';
    const tasks = await loadTaskQueue();
    const t = tasks.find((x) => x.id === taskId);
    if (!t || t.status !== 'pending') return 'not-pending';
    // 父依赖不变式: 父未完成 → 拒绝认领 (依赖悬空时任务不可执行)
    if (!parentsSatisfied(t, tasks)) return 'parents-undone';
    t.status = 'running';
    t.claimExpires = Date.now() + claimTtlSeconds() * 1000;
    t.updatedAt = new Date().toISOString();
    await saveTaskQueue(tasks);
    isExecutingTask = true;
    executionTaskId = taskId;
    return 'claimed';
  });
}

/**
 * CAS 认领下一个 pending 任务; 无任务/已被认领 → null (输家不重试).
 * 只认领父依赖满足的 pending — 父未完成的任务跳过 (等父 done 后可被认领), 不阻塞队列.
 */
export async function claimNextPendingTask(): Promise<Task | null> {
  if (isExecutingTask) return null;
  return withTaskQueueLock(async () => {
    if (isExecutingTask) return null;
    const tasks = await loadTaskQueue();
    const t = tasks.find((x) => x.status === 'pending' && parentsSatisfied(x, tasks));
    if (!t) return null;
    t.status = 'running';
    t.claimExpires = Date.now() + claimTtlSeconds() * 1000;
    t.updatedAt = new Date().toISOString();
    await saveTaskQueue(tasks);
    isExecutingTask = true;
    executionTaskId = t.id;
    return t;
  });
}

/**
 * 心跳续期 (Hermes kanban_heartbeat): 执行中有实质进展时调用, 把 claim_expires 推到 now+TTL.
 * CAS: 只续期当前执行中的任务 (executionTaskId 匹配 + status==='running').
 */
export async function heartbeatTaskExecution(taskId: string): Promise<boolean> {
  return withTaskQueueLock(async () => {
    if (executionTaskId !== taskId) return false;
    const tasks = await loadTaskQueue();
    const t = tasks.find((x) => x.id === taskId);
    if (!t || t.status !== 'running') return false;
    t.claimExpires = Date.now() + claimTtlSeconds() * 1000;
    t.updatedAt = new Date().toISOString();
    await saveTaskQueue(tasks);
    return true;
  });
}

/**
 * 释放过期认领 (Hermes release_stale_claims): 扫所有 running 且 claim_expires 已过期的任务
 * → 释放 in-memory 锁 + 任务回 pending (可重新认领执行). 防 executeTask 卡死/崩溃后锁泄漏.
 * 返回释放数量. 安全可频繁调用.
 */
export async function releaseStaleClaims(): Promise<number> {
  return withTaskQueueLock(async () => {
    const now = Date.now();
    const tasks = await loadTaskQueue();
    const stale = tasks.filter((t) => t.status === 'running' && t.claimExpires !== undefined && t.claimExpires < now);
    if (stale.length === 0) return 0;
    for (const t of stale) {
      t.status = 'pending';
      t.claimExpires = undefined;
      t.updatedAt = new Date().toISOString();
    }
    await saveTaskQueue(tasks);
    // 当前执行锁指向过期任务 → 一并释放 (卡死的 executeTask 其锁也失效)
    if (executionTaskId && stale.some((t) => t.id === executionTaskId)) {
      isExecutingTask = false;
      executionTaskId = null;
    }
    return stale.length;
  });
}

/** 执行 task 的 helper 标记 (server.ts 内部 still 持有 lock) */
export function startTaskExecution(taskId: string): boolean {
  if (isExecutingTask) return false;
  isExecutingTask = true;
  executionTaskId = taskId;
  return true;
}

export function endTaskExecution(): void {
  isExecutingTask = false;
  executionTaskId = null;
}
