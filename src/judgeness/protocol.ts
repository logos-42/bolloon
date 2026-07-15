/**
 * judgeness · protocol.ts
 *
 * 4 新 P2P kind (扩展 judgment-protocol 的 Kind 枚举):
 *   - hearth_description_publish: A 告知 B "我公开了 jd <id>"
 *   - hearth_description_query:    A 向 B 询问 jd <id> 正文
 *   - hearth_autoadd_invite:      A 邀请 B 加入 channel <topic>
 *   - hearth_block:               A 屏蔽 B / 某 channel
 *
 * 复用 src/agents/judgment-protocol.ts 的 listener 安装模式 (174-194).
 * Transport 仍走 IrohTransport (不另起), 复用 sendMessage.
 *
 * 防御期 (现在 → 6 月):
 *   - 此文件已发布, 但 4 kind 仅在 enum 占位; 不会发帧.
 *   - 相持期开始才真正调用 sendMessage.
 */

import { EventEmitter } from 'events';
import { irohTransport as defaultIrohTransport, type IrohTransport } from '../network/iroh-transport.js';
import { resolveGate2, resolveGate3 } from './visibility.js';
import type {
  HearthKind,
  HearthFrame,
  JudgenessPubkeyContext,
} from './types.js';

// ---------------------------------------------------------------------------
// 4 帧协议载荷
// ---------------------------------------------------------------------------

export interface HearthDescriptionPublish {
  publishId: string;
  fromNodeId: string;
  descriptionId: string;          // jd-id
  visibility: string;             // publish 时的 visibility (allowlist / public / peers)
  channelTopic?: string;
  ts: number;
}

export interface HearthDescriptionQuery {
  queryId: string;
  fromNodeId: string;
  descriptionId: string;
  ts: number;
}

export interface HearthAutoaddInvite {
  inviteId: string;
  fromNodeId: string;
  channelTopic: string;
  visibility: 'public' | 'allowlist' | 'peers'; // 协议硬约束: 不传 'private'
  ts: number;
}

export interface HearthBlock {
  blockId: string;
  fromNodeId: string;
  targetNodeId: string;
  channelTopic?: string;          // 不传 = 全 channel 屏蔽
  ts: number;
}

// 帧 union
export type HearthAnyFrame =
  | { kind: 'hearth_description_publish'; payload: HearthDescriptionPublish }
  | { kind: 'hearth_description_query';    payload: HearthDescriptionQuery }
  | { kind: 'hearth_autoadd_invite';      payload: HearthAutoaddInvite }
  | { kind: 'hearth_block';               payload: HearthBlock };

// ---------------------------------------------------------------------------
// 事件总线 (UI / CLI 订阅)
// ---------------------------------------------------------------------------

export type HearthEvent =
  | { kind: 'publish_sent';     publishId: string; peer: string }
  | { kind: 'publish_received'; publishId: string; fromNodeId: string }
  | { kind: 'query_received';   queryId: string; fromNodeId: string; descriptionId: string }
  | { kind: 'invite_sent';      inviteId: string; peer: string }
  | { kind: 'invite_received';  inviteId: string; fromNodeId: string; channelTopic: string }
  | { kind: 'block_received';   blockId: string; fromNodeId: string; targetNodeId: string };

class HearthEventBus extends EventEmitter {}
export const hearthEventBus = new HearthEventBus();

// ---------------------------------------------------------------------------
// 帧构造 / 解析
// ---------------------------------------------------------------------------

function encode(f: HearthAnyFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kind: f.kind, payload: f.payload, ts: f.payload.ts }));
}

function decode(buf: Uint8Array): HearthAnyFrame | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(buf));
    if (!obj?.kind || !obj.payload) return null;
    if (!isHearthKind(obj.kind)) return null;
    return obj as HearthAnyFrame;
  } catch {
    return null;
  }
}

function isHearthKind(k: string): k is HearthKind {
  return (
    k === 'hearth_description_publish' ||
    k === 'hearth_description_query' ||
    k === 'hearth_autoadd_invite' ||
    k === 'hearth_block'
  );
}

// ---------------------------------------------------------------------------
// 协议硬约束 (发送前 throw)
// ---------------------------------------------------------------------------

/** 在调用 transport.sendMessage 前必跑一次 */
export function validateFrameBeforeSend(frame: HearthAnyFrame): void {
  const p: any = frame.payload;
  switch (frame.kind) {
    case 'hearth_description_publish':
      if (!p.descriptionId) throw new Error('hearth_description_publish: descriptionId required');
      if (!p.visibility) throw new Error('hearth_description_publish: visibility required');
      break;
    case 'hearth_description_query':
      if (!p.descriptionId) throw new Error('hearth_description_query: descriptionId required');
      break;
    case 'hearth_autoadd_invite':
      if (!p.channelTopic) throw new Error('hearth_autoadd_invite: channelTopic required');
      if (p.visibility === 'private') throw new Error('hearth_autoadd_invite: visibility=private forbidden');
      break;
    case 'hearth_block':
      if (p.targetNodeId === p.fromNodeId) throw new Error('hearth_block: cannot block self');
      break;
  }
}

// ---------------------------------------------------------------------------
// Listener 安装 (每 transport 各装一次, 复用 judgment-protocol 模式)
// ---------------------------------------------------------------------------

interface HearthState {
  listenersInstalled: boolean;
}
const states = new WeakMap<IrohTransport, HearthState>();

function getState(t: IrohTransport): HearthState {
  let s = states.get(t);
  if (!s) { s = { listenersInstalled: false }; states.set(t, s); }
  return s;
}

export function ensureHearthListeners(transport: IrohTransport = defaultIrohTransport): void {
  const s = getState(transport);
  if (s.listenersInstalled) return;
  s.listenersInstalled = true;

  transport.onMessage('hearth_description_publish', async (msg) => {
    const f = decode(msg.payload);
    if (!f || f.kind !== 'hearth_description_publish') return;
    const p = f.payload;
    hearthEventBus.emit('event', { kind: 'publish_received', publishId: p.publishId, fromNodeId: p.fromNodeId } as HearthEvent);
    await onPublishReceived(transport, p);
  });

  transport.onMessage('hearth_description_query', async (msg) => {
    const f = decode(msg.payload);
    if (!f || f.kind !== 'hearth_description_query') return;
    const p = f.payload;
    hearthEventBus.emit('event', { kind: 'query_received', queryId: p.queryId, fromNodeId: p.fromNodeId, descriptionId: p.descriptionId } as HearthEvent);
    await onQueryReceived(transport, p);
  });

  transport.onMessage('hearth_autoadd_invite', async (msg) => {
    const f = decode(msg.payload);
    if (!f || f.kind !== 'hearth_autoadd_invite') return;
    const p = f.payload;
    hearthEventBus.emit('event', { kind: 'invite_received', inviteId: p.inviteId, fromNodeId: p.fromNodeId, channelTopic: p.channelTopic } as HearthEvent);
    await onAutoaddInviteReceived(transport, p);
  });

  transport.onMessage('hearth_block', async (msg) => {
    const f = decode(msg.payload);
    if (!f || f.kind !== 'hearth_block') return;
    const p = f.payload;
    hearthEventBus.emit('event', { kind: 'block_received', blockId: p.blockId, fromNodeId: p.fromNodeId, targetNodeId: p.targetNodeId } as HearthEvent);
    await onBlockReceived(p);
  });
}

// ---------------------------------------------------------------------------
// Listener handlers (实现都先 stub, 等相持期再接 store / p2p-direct)
// ---------------------------------------------------------------------------

async function onPublishReceived(_t: IrohTransport, _p: HearthDescriptionPublish): Promise<void> {
  // TODO(相持期): 校验 fromNodeId 在 allowlist 内, 然后 fetch cache
}

async function onQueryReceived(_t: IrohTransport, _p: HearthDescriptionQuery): Promise<void> {
  // TODO(相持期): 闸 3 后, 把对应 description 走 visibility scrubber 后回发
}

async function onAutoaddInviteReceived(
  _t: IrohTransport,
  p: HearthAutoaddInvite
): Promise<void> {
  // 闸 2: 检查 fromNodeId 是否在 allowlist, 且 channel 隐私策略兼容
  const ctx: JudgenessPubkeyContext = { pubkey: p.fromNodeId, role: 'agent', channelTopic: p.channelTopic };
  const g2 = await resolveGate2(p.fromNodeId, p.channelTopic);
  if (!g2.allow) {
    // 自动回一个 block
    await sendBlock(_t, p.fromNodeId, p.channelTopic);
  }
}

async function onBlockReceived(p: HearthBlock): Promise<void> {
  // TODO(相持期): 加入 inbound 黑名单, 后续入站全 reject
  void p;
}

// ---------------------------------------------------------------------------
// 发送接口 (相持期 / 反攻期主用)
// ---------------------------------------------------------------------------

export async function sendPublish(
  transport: IrohTransport,
  descriptionId: string,
  toNodeId: string,
  visibility: string,
  channelTopic?: string
): Promise<void> {
  const frame: HearthAnyFrame = {
    kind: 'hearth_description_publish',
    payload: {
      publishId: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromNodeId: toNodeId,        // 占位: 真实发送时本方 nodeId 由 transport 提供, 这里用目标
      descriptionId,
      visibility,
      channelTopic,
      ts: Date.now(),
    },
  };
  validateFrameBeforeSend(frame);
  await transport.sendMessage(toNodeId, frame.kind, encode(frame));
  hearthEventBus.emit('event', { kind: 'publish_sent', publishId: frame.payload.publishId, peer: toNodeId } as HearthEvent);
}

export async function sendQuery(
  transport: IrohTransport,
  descriptionId: string,
  toNodeId: string
): Promise<void> {
  const frame: HearthAnyFrame = {
    kind: 'hearth_description_query',
    payload: {
      queryId: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromNodeId: toNodeId,
      descriptionId,
      ts: Date.now(),
    },
  };
  validateFrameBeforeSend(frame);
  await transport.sendMessage(toNodeId, frame.kind, encode(frame));
}

export async function sendAutoaddInvite(
  transport: IrohTransport,
  channelTopic: string,
  toNodeId: string,
  visibility: 'public' | 'allowlist' | 'peers' = 'allowlist'
): Promise<void> {
  const frame: HearthAnyFrame = {
    kind: 'hearth_autoadd_invite',
    payload: {
      inviteId: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromNodeId: toNodeId,
      channelTopic,
      visibility,
      ts: Date.now(),
    },
  };
  validateFrameBeforeSend(frame);
  await transport.sendMessage(toNodeId, frame.kind, encode(frame));
  hearthEventBus.emit('event', { kind: 'invite_sent', inviteId: frame.payload.inviteId, peer: toNodeId } as HearthEvent);
}

export async function sendBlock(
  transport: IrohTransport,
  targetNodeId: string,
  channelTopic?: string,
  fromNodeId: string = '__self__'
): Promise<void> {
  const frame: HearthAnyFrame = {
    kind: 'hearth_block',
    payload: {
      blockId: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromNodeId,
      targetNodeId,
      channelTopic,
      ts: Date.now(),
    },
  };
  validateFrameBeforeSend(frame);
  await transport.sendMessage(targetNodeId, frame.kind, encode(frame));
}

// ---------------------------------------------------------------------------
// 防御期唯一可对外暴露的健康查询 (无 IO)
// ---------------------------------------------------------------------------

export function listHearthKinds(): readonly HearthKind[] {
  return ['hearth_description_publish', 'hearth_description_query', 'hearth_autoadd_invite', 'hearth_block'];
}

// 关闭 lint: resolveGate3 未在本文件直用, 给相持期 protocol listener 用
void resolveGate3;
