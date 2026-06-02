/**
 * Self-Improve Event Bus
 *
 * 心跳事件 → 自改触发器 (解耦 watchdog)
 *
 * 设计原则:
 *   - Watchdog 负责保活 (重启进程), 不知道"自改"是什么
 *   - Self-Improve Bus 监听"信号事件" (CI 失败, 任务连续失败, 静默超时)
 *   - 信号达到阈值 + 通过冷却期 → 触发 runSelfImproveLoop
 *   - 触发时通过 SSE 广播给前端, 用户能在 UI 里看到
 *
 * 关键不变量:
 *   1. 心跳**不**直接调自改 - 通过 emit() 异步触发
 *   2. 触发频率受 SELF_IMPROVE_COOLDOWN_MS 限制
 *   3. 同类事件 24 小时内只触发 1 次
 *   4. 触发后不阻塞健康检查
 */

import { SELF_IMPROVE_COOLDOWN_MS } from '../agents/shell-guard.js';

export type SelfImproveEvent =
  | { kind: 'ci-failed'; details: string }
  | { kind: 'task-failures'; details: string }
  | { kind: 'silent-timeout'; details: string }
  | { kind: 'user-requested'; details: string };

interface EventRecord {
  at: number;
  count: number;
}

const EVENT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 小时内同类型只触发 1 次

const eventHistory: Map<SelfImproveEvent['kind'], EventRecord> = new Map();
let lastTriggerAt: number | null = null;

type Listener = (event: SelfImproveEvent, goal: string) => void | Promise<void>;
const listeners: Set<Listener> = new Set();

/**
 * 订阅自改触发事件
 */
export function onSelfImproveTrigger(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 心跳事件 → 自改总线
 *
 * @returns { triggered: boolean, reason?: string }
 */
export function reportSelfImproveEvent(event: SelfImproveEvent): { triggered: boolean; reason?: string } {
  // 1. 24 小时同类事件冷却
  const prev = eventHistory.get(event.kind);
  if (prev && Date.now() - prev.at < EVENT_COOLDOWN_MS) {
    return { triggered: false, reason: `同类事件 ${event.kind} 在 24h 内已记录过, 跳过` };
  }

  // 2. 累加计数
  eventHistory.set(event.kind, {
    at: Date.now(),
    count: (prev?.count || 0) + 1
  });

  // 3. 自改循环冷却
  if (lastTriggerAt && Date.now() - lastTriggerAt < SELF_IMPROVE_COOLDOWN_MS) {
    const waitHrs = Math.ceil((SELF_IMPROVE_COOLDOWN_MS - (Date.now() - lastTriggerAt)) / 3600000);
    return { triggered: false, reason: `自改冷却中, 还需要约 ${waitHrs} 小时` };
  }

  // 4. 触发
  lastTriggerAt = Date.now();
  const goal = `信号事件: ${event.kind} - ${event.details}`;

  console.log(`[self-improve-bus] 🚀 触发自改循环: ${goal}`);

  // 异步触发所有 listener, 不阻塞调用方
  Promise.resolve().then(async () => {
    for (const listener of listeners) {
      try {
        await listener(event, goal);
      } catch (err) {
        console.error(`[self-improve-bus] listener 失败:`, err);
      }
    }
  });

  return { triggered: true };
}

/**
 * 获取当前事件历史 (供调试 / UI 显示)
 */
export function getEventHistory(): Array<{ kind: string; at: string; count: number }> {
  return Array.from(eventHistory.entries()).map(([kind, rec]) => ({
    kind,
    at: new Date(rec.at).toISOString(),
    count: rec.count
  }));
}

/**
 * 强制重置 (仅供调试)
 */
export function resetSelfImproveBus(): void {
  eventHistory.clear();
  lastTriggerAt = null;
  console.log('[self-improve-bus] 已重置');
}
