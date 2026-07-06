/**
 * server-sse.ts — server.ts 拆出的 SSE 实时推送层
 *
 * 包含:
 *   - sseClients: 客户端连接 Set
 *   - broadcast(): 推 SSE 事件 + 加 seq/msgId envelope
 *   - nextEventSeq / nextMsgId: 用于客户端断线重连 resume
 *   - installChatBusHook / installSelfImproveHook: 桥接 chat event bus / self-improve bus → SSE
 *
 * 从 src/web/server.ts 抽出 (2026-07-06).
 * SSEClient type 来自 ./server-types.ts.
 */

import * as crypto from 'crypto';
import type { SSEClient } from './server-types.js';

const sseClients: Set<SSEClient> = new Set();

export function getSseClients(): Set<SSEClient> {
  return sseClients;
}

export function addSseClient(client: SSEClient): void {
  sseClients.add(client);
}

export function removeSseClient(client: SSEClient): void {
  sseClients.delete(client);
}

// 2026-07-06: 每个 channelId 维护递增 sequence + msgId, 让前端能去重 + 重连后 resume
const channelEventSeq: Map<string, number> = new Map();
const channelMsgIds: Map<string, string> = new Map(); // channelId -> 上一条 msgId (uuid)

export function nextEventSeq(channelId: string | undefined): number {
  if (!channelId) return 0;
  const cur = channelEventSeq.get(channelId) || 0;
  const next = cur + 1;
  channelEventSeq.set(channelId, next);
  return next;
}

export function nextMsgId(channelId: string | undefined): string {
  const id = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  if (channelId) channelMsgIds.set(channelId, id);
  return id;
}

/**
 * 给 watchdog 喂活动, 让 broadcast() / 模块级业务函数能埋点喂活动
 * 之前在 createWebServer 闭包内, 闭包外的 broadcast() 拿不到 → 误判 30min 无活动 → 自杀.
 */
let watchdogRef: any = null;
export function setWatchdogRef(ref: any): void {
  watchdogRef = ref;
}

export function broadcast(data: { type: string; [key: string]: unknown }, channelId?: string): void {
  watchdogRef?.recordActivity?.();
  const seq = nextEventSeq(channelId);
  const msgId = (data.type === 'ai' || data.type === 'user')
    ? nextMsgId(channelId)
    : `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const envelope = { ...data, channelId, seq, msgId };
  const message = `data: ${JSON.stringify(envelope)}\n\n`;
  console.log(`[broadcast] type=${data.type}, channelId=${channelId}, seq=${seq}, msgId=${msgId}, clients=${sseClients.size}`);
  for (const client of sseClients) {
    if (!channelId || client.channelId === channelId) {
      try {
        client.res.write(message);
      } catch (e: unknown) {
        console.error(`[broadcast] 写入失败:`, (e as Error).message);
      }
    }
  }
}

// ============================================================================
// Chat 事件总线 -> SSE 桥 (供前端 inbox UI 用)
// ============================================================================
let chatBusHookInstalled = false;
export async function installChatBusHook(): Promise<void> {
  if (chatBusHookInstalled) return;
  chatBusHookInstalled = true;
  try {
    const { chatEventBus } = await import('../agents/p2p-chat-tools.js');
    chatEventBus.on('chat', (ev: any) => {
      broadcast({ type: 'chat_event', chatKind: ev.kind, payload: ev }, undefined);
    });
    console.log('[chat-bus] SSE bridge installed');
  } catch (e) {
    console.warn('[chat-bus] install failed:', (e as Error).message);
  }
}

// ============================================================================
// Self-Improve Bus -> SSE 桥 (供前端 / 用户看到自改触发)
// ============================================================================
let selfImproveHookInstalled = false;
export async function installSelfImproveHook(): Promise<void> {
  if (selfImproveHookInstalled) return;
  selfImproveHookInstalled = true;
  try {
    const { onSelfImproveTrigger } = await import('../heartbeat/self-improve-bus.js');
    const { runSelfImproveLoop } = await import('../agents/pi-sdk.js');

    onSelfImproveTrigger(async (event, goal) => {
      broadcast({
        type: 'self_improve_triggered',
        eventKind: event.kind,
        details: event.details,
        goal,
        ts: Date.now()
      }, undefined);

      const result = await runSelfImproveLoop(goal);

      broadcast({
        type: 'self_improve_result',
        success: result.success,
        output: result.output,
        error: result.error,
        ts: Date.now()
      }, undefined);
    });

    console.log('[self-improve] SSE bridge installed');
  } catch (e) {
    console.warn('[self-improve] install failed:', (e as Error).message);
  }
}
