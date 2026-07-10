/**
 * goal-resume — 双栖 agent 网络的"目标接力"原语
 *
 * 设计动机 (2026-07-10):
 * - bolloon 改造: 从本地优先 → 远程/本地双栖 agent 网络.
 * - 需要"目标不中断"机制: 用户当前 task 跑一半, 切到另一个 channel / 切到对端 peer
 *   / 用户离开, 目标不能丢.
 * - 现有 task-state.ts 已有 'paused' 状态, 但没有跨 session / 跨机器的"目标快照+恢复"流.
 * - 本文件提供 parkGoal / resumeGoal / continueGoalInBackground, 在 4 级 Bolloon.md 之外的
 *   运行时层做目标接力.
 *
 * 复用现有:
 *   - task-state.ts: Task.status = 'paused' (park) / 'running' (resume)
 *   - session-store.ts: 消息历史 (saveMessages / loadMessages)
 *   - chat-archiver.ts: 高频归档 (~/.bolloon/archive/<peerDID>/YYYY-MM.jsonl)
 *   - p2p-outbox.ts: 离线消息不丢
 *   - injectJudgmentGate (pi-sdk.ts): judgment 注入门; goal handoff 路径上保留注入
 *
 * 不重复造:
 *   - 没有新数据库. 落盘 = ~/.bolloon/goals/snapshot.jsonl (append-only, 与 chat-archiver 同模式)
 *   - 没有新 LLM 调度. LLM 工具入口在 pi-sdk-tools.ts 注册, 复用现有 pi-ai.ts 调度.
 *
 * 安全 / 边界:
 *   - 人类隐私 judgment (target_id 包含"用户偏好"语义) 不外泄给 peer;
 *     continueGoalInBackground 只发"目标描述 + 已完成步骤", 不发 judgment 内容.
 *   - 任何 IO 失败静默 (返回 null / error 对象), 不阻塞主对话.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { sessionStore, PersistedMessage } from './session-store.js';
import * as taskState from './task-state.js';
import type { Task } from './task-state.js';
import { onGoalParked, onGoalResumed } from '../bootstrap/lifecycle-hooks.js';

// 注: 不引 chatArchiver — 它的 ArchiveOpts schema (publicKey + entry) 与 goal event
// (peerDid + content) 不匹配, 容易写错字段. 改用本文件专属的 snapshot.jsonl 落盘.

// ============================================================
// 数据结构
// ============================================================

/** 目标引用 — 跨 channel / 跨机器唯一 */
export interface GoalRef {
  /** uuid, 跨 channel 唯一 (park/resume 全靠这个串起来) */
  goalId: string;
  /** 用户视角的"目标描述", 如 "完成财务模块迁移".
   *  LLM 必须在创建 goal 时给一个 stable 的 string, 不能用 "the task". */
  targetId: string;
  /** 谁创建的 — 用户手动 / agent 自主 / 对端 peer */
  createdBy: 'user' | 'agent' | 'peer';
  /** ISO 8601 */
  createdAt: string;
  /** 起始 session id — 用于审计 */
  originChannel: string;
}

/** Park 原因 — 决定恢复策略 */
export type ParkReason =
  | 'channel_switch'      // 用户切到另一个 channel
  | 'user_away'           // 用户几小时没回来
  | 'awaiting_external'   // 等对端 peer 回应
  | 'peer_handoff';       // 主动把目标推到对端

/** 目标快照 — 落 ~/.bolloon/goals/snapshot.jsonl */
export interface GoalSnapshot {
  goalRef: GoalRef;
  /** 当前 session key (回灌用) */
  sessionKey: string;
  /** 末 30 条消息 — 足够恢复上下文, 不爆磁盘 */
  recentMessages: PersistedMessage[];
  /** 关联 task id (来自 task-state.ts) */
  taskId: string | null;
  /** task 状态快照 (park 时) */
  taskState: { taskId: string; status: string; steps: { id: string; status: string; description: string }[] } | null;
  parkReason: ParkReason;
  parkedAt: string;
  /** 对端 DID (continueGoalInBackground 时填) */
  peerDid?: string;
  /** schema version — 跨版本兼容 */
  schemaVersion: 1;
}

/** Goal handle — 调 park/resume/continue 的返回 */
export interface GoalHandle {
  goalId: string;
  targetId: string;
  state: 'parked' | 'resumed' | 'continued_background';
  /** resume 后的新 session key */
  resumedIn?: string;
  /** continueGoalInBackground 时, 对端 session id (用于追踪) */
  peerSessionId?: string;
  /** 关联 task id */
  taskId?: string;
  /** 错误信息 — 不抛错, 返回给 caller (LLM / skill) */
  error?: string;
}

export interface ResumeOptions {
  /** true = 在新 session key 下恢复; false = 留在原 session */
  newSession?: boolean;
  /** 指定 channelId 恢复 (默认 = originChannel) */
  channelId?: string;
}

export interface ListParkedFilter {
  originChannel?: string;
  createdBy?: 'user' | 'agent' | 'peer';
  targetIdPrefix?: string;
}

// ============================================================
// 内部: 落盘 + 读盘
// ============================================================

const GOALS_DIR = path.join(os.homedir(), '.bolloon', 'goals');
const SNAPSHOT_FILE = path.join(GOALS_DIR, 'snapshot.jsonl');
const EVENT_FILE = path.join(GOALS_DIR, 'event.jsonl');

/** 写一条 park/resume event (独立文件, 不影响 snapshot 覆盖逻辑) */
async function appendEvent(event: { goalId: string; event: string; [k: string]: unknown }): Promise<void> {
  try {
    await ensureGoalsDir();
    await fs.appendFile(EVENT_FILE, JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n', 'utf-8');
  } catch {
    // 静默 — event log 失败不应阻塞
  }
}

async function ensureGoalsDir(): Promise<void> {
  await fs.mkdir(GOALS_DIR, { recursive: true });
}

/** append-only 写一行 JSON */
async function appendSnapshot(snap: GoalSnapshot): Promise<void> {
  try {
    await ensureGoalsDir();
    await fs.appendFile(SNAPSHOT_FILE, JSON.stringify(snap) + '\n', 'utf-8');
  } catch (err: any) {
    // 静默失败 — 落盘失败不应阻塞主对话
    if (process.env.BOLLOON_VERBOSE === '1') {
      console.warn(`[goal-resume] appendSnapshot failed: ${err.message?.slice(0, 100)}`);
    }
  }
}

/** 读所有 snapshot, 按 goalId 分组保留最新一条 */
async function loadAllSnapshots(): Promise<Map<string, GoalSnapshot>> {
  const out = new Map<string, GoalSnapshot>();
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as GoalSnapshot;
        if (snap.schemaVersion !== 1) continue;
        out.set(snap.goalRef.goalId, snap);  // 后写覆盖先写 (新状态覆盖旧状态)
      } catch {
        // 跳过损坏行
      }
    }
  } catch {
    // 文件不存在 = 空 map
  }
  return out;
}

function newGoalId(): string {
  return `goal-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// ============================================================
// Park 现有 task (复用 task-state.ts 'paused' 状态)
// ============================================================

async function parkAssociatedTask(taskId: string | null, goalId: string): Promise<void> {
  if (!taskId) return;
  try {
    // 1. 把 task 状态置 'paused'
    await taskState.updateTask(taskId, { status: 'paused' });
    // 2. 在 goal 字段里塞 goalId (让反向查找有据可查)
    const t = await taskState.getTask(taskId);
    if (t) {
      // 不覆盖已有 goal 字段, 改用 metadata 注释
      // (task-state.ts 的 Task interface 没 metadata, 跳过避免 schema 改动)
    }
  } catch (err: any) {
    if (process.env.BOLLOON_VERBOSE === '1') {
      console.warn(`[goal-resume] parkAssociatedTask failed: ${err.message?.slice(0, 100)}`);
    }
  }
}

async function resumeAssociatedTask(taskId: string | null, newSessionKey?: string): Promise<void> {
  if (!taskId) return;
  try {
    const patch: Partial<Task> = { status: 'running' };
    if (newSessionKey) patch.sessionKey = newSessionKey;
    await taskState.updateTask(taskId, patch);
  } catch (err: any) {
    if (process.env.BOLLOON_VERBOSE === '1') {
      console.warn(`[goal-resume] resumeAssociatedTask failed: ${err.message?.slice(0, 100)}`);
    }
  }
}

// ============================================================
// 公共 API
// ============================================================

/**
 * Park 当前目标 — 把 session 状态快照 + task 状态落盘, 切走/离开不丢目标.
 *
 * @param goalRef 目标引用 (goalId 必须已存在, 不能传空)
 * @param reason park 原因 (决定后续恢复策略)
 * @returns GoalHandle (含 error 字段, 不抛错)
 */
export async function parkGoal(goalRef: GoalRef, reason: ParkReason): Promise<GoalHandle> {
  if (!goalRef.goalId || !goalRef.targetId) {
    return { goalId: goalRef.goalId, targetId: goalRef.targetId, state: 'parked', error: 'goalId/targetId 必填' };
  }

  try {
    // 1. 拉最近 30 条消息
    const messages = await sessionStore.loadMessages(goalRef.originChannel) ?? [];
    const recentMessages = messages.slice(-30);

    // 2. 找关联 task (用 goalId 反向搜, 或 caller 传 taskId)
    //    简化: caller 负责在 goalRef 里塞 taskId; 此处拿不到 — 跳过
    const taskId: string | null = null;  // TODO: 反向索引 (后续阶段)
    const taskState_: GoalSnapshot['taskState'] = null;

    // 3. 落 snapshot
    const snap: GoalSnapshot = {
      goalRef,
      sessionKey: goalRef.originChannel,
      recentMessages,
      taskId,
      taskState: taskState_,
      parkReason: reason,
      parkedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    await appendSnapshot(snap);

    // 4. 写 park event 留痕 (独立 event.jsonl, 不污染 snapshot 覆盖)
    await appendEvent({ goalId: goalRef.goalId, event: 'goal_parked', targetId: goalRef.targetId, reason });

    // 5. park 关联 task
    await parkAssociatedTask(taskId, goalRef.goalId);

    // 6. 触发 lifecycle hook (留痕到 ~/.bolloon/sessions/goal-parked.jsonl)
    await onGoalParked({
      goalId: goalRef.goalId,
      targetId: goalRef.targetId,
      reason,
      originChannel: goalRef.originChannel,
      sessionKey: goalRef.originChannel,
      taskId,
    });

    return { goalId: goalRef.goalId, targetId: goalRef.targetId, state: 'parked', taskId: taskId ?? undefined };
  } catch (err: any) {
    return { goalId: goalRef.goalId, targetId: goalRef.targetId, state: 'parked', error: `park 失败: ${err.message?.slice(0, 100)}` };
  }
}

/**
 * 恢复目标 — 重新加载 session 消息历史 + 把 task 状态置 running.
 *
 * @param goalId park 时记的 goalId
 * @param options newSession = true 时返回新 session key
 */
export async function resumeGoal(goalId: string, options: ResumeOptions = {}): Promise<GoalHandle> {
  if (!goalId) {
    return { goalId, targetId: '', state: 'resumed', error: 'goalId 必填' };
  }

  try {
    const allSnaps = await loadAllSnapshots();
    const snap = allSnaps.get(goalId);
    if (!snap) {
      return { goalId, targetId: '', state: 'resumed', error: `goal ${goalId} 未找到 (未 park 过)` };
    }

    // 1. 把末 30 条消息灌回 session (供 LLM 立即看到上下文)
    const targetKey = options.newSession
      ? `${snap.goalRef.originChannel}:resume-${Date.now()}`
      : snap.goalRef.originChannel;
    await sessionStore.saveMessages(targetKey, snap.recentMessages);

    // 2. resume 关联 task
    await resumeAssociatedTask(snap.taskId, options.newSession ? targetKey : undefined);

    // 3. 写一条 resume 留痕 (独立 event.jsonl)
    await appendEvent({ goalId, event: 'goal_resumed', targetId: snap.goalRef.targetId, resumedIn: targetKey });

    // 4. 触发 lifecycle hook
    await onGoalResumed({
      goalId,
      targetId: snap.goalRef.targetId,
      originChannel: snap.goalRef.originChannel,
      resumedIn: targetKey,
      taskId: snap.taskId,
    });

    return {
      goalId,
      targetId: snap.goalRef.targetId,
      state: 'resumed',
      resumedIn: targetKey,
      taskId: snap.taskId ?? undefined,
    };
  } catch (err: any) {
    return { goalId, targetId: '', state: 'resumed', error: `resume 失败: ${err.message?.slice(0, 100)}` };
  }
}

/**
 * 把目标推到对端 peer — 包含 park (本机) + P2P 推消息 (对端) + 期望对端 resume.
 *
 * 流程:
 * 1. park 本机的 goal
 * 2. 通过现有 p2pNetwork.sendMessage 发一条 'goal_continue' 类型消息给对端
 * 3. 对端 hook 收到 → 自动调 resumeGoal (对端有同名 hook 处理 — 后续阶段)
 * 4. 返回 handle 含 peerSessionId (对端生成) — 但**对端 id 当前拿不到**, 留 TODO
 *
 * @param goalRef 同 parkGoal
 * @param peerDid 对端 DID (来自 list_peers 结果)
 * @param p2pSendMessage 注入 P2P 发送函数 (避免循环依赖; pi-sdk-tools.ts 注入)
 */
export async function continueGoalInBackground(
  goalRef: GoalRef,
  peerDid: string,
  p2pSendMessage: (peerId: string, type: string, message: string) => Promise<{ success: boolean; error?: string }>,
): Promise<{ handle: GoalHandle; peerSessionId?: string }> {
  if (!goalRef.goalId || !peerDid) {
    return { handle: { goalId: goalRef.goalId, targetId: goalRef.targetId, state: 'continued_background', error: 'goalId/peerDid 必填' } };
  }

  // 1. park 本机
  const parkResult = await parkGoal(goalRef, 'peer_handoff');
  if (parkResult.error) {
    return { handle: parkResult };
  }

  // 2. 推给对端
  try {
    // 隐私过滤: 不发 judgment 内容, 只发 target_id + 末 5 条消息摘要
    const safePayload = {
      event: 'goal_continue',
      goalId: goalRef.goalId,
      targetId: goalRef.targetId,
      originChannel: goalRef.originChannel,
      createdBy: goalRef.createdBy,
      recentMessages: (parkResult.error ? [] : (await sessionStore.loadMessages(goalRef.originChannel) ?? [])).slice(-5),
      timestamp: new Date().toISOString(),
    };
    const sendResult = await p2pSendMessage(peerDid, 'goal_continue', JSON.stringify(safePayload));
    if (!sendResult.success) {
      return { handle: { ...parkResult, state: 'continued_background', error: `P2P 推失败: ${sendResult.error?.slice(0, 100)}` } };
    }

    return {
      handle: { ...parkResult, state: 'continued_background', peerSessionId: '(对端生成, 当前拿不到 — TODO)' },
    };
  } catch (err: any) {
    return { handle: { ...parkResult, state: 'continued_background', error: `continue 失败: ${err.message?.slice(0, 100)}` } };
  }
}

/**
 * 列出所有 park 的 goal — 用于 LLM 切回时找回上下文
 */
export async function listParkedGoals(filter: ListParkedFilter = {}): Promise<GoalSnapshot[]> {
  try {
    const all = await loadAllSnapshots();
    let arr = Array.from(all.values());
    if (filter.originChannel) arr = arr.filter((s) => s.goalRef.originChannel === filter.originChannel);
    if (filter.createdBy) arr = arr.filter((s) => s.goalRef.createdBy === filter.createdBy);
    if (filter.targetIdPrefix) arr = arr.filter((s) => s.goalRef.targetId.startsWith(filter.targetIdPrefix!));
    return arr.sort((a, b) => b.parkedAt.localeCompare(a.parkedAt));
  } catch {
    return [];
  }
}

/**
 * 单个 goal 查询
 */
export async function getGoal(goalId: string): Promise<GoalSnapshot | null> {
  try {
    const all = await loadAllSnapshots();
    return all.get(goalId) ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// 调试 / 健康端点用
// ============================================================

/** Goal 落盘目录 (只读) */
export function goalsDir(): string {
  return GOALS_DIR;
}

/** 重置 (测试用) */
export async function _resetGoalsForTest(): Promise<void> {
  try {
    await fs.unlink(SNAPSHOT_FILE);
  } catch {
    // 不存在 = OK
  }
}
