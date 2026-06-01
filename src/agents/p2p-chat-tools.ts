/**
 * p2p-chat-tools — 异步 chat 通道 + 持久化 inbox + 判断力外包 (draft)
 *
 * 解决痛点: 两个节点的智能体代替各自人类主人做异步判断
 *
 * 流程:
 *   1. A 节点 (人类在线) 通过 sendChat(peerDID, text) 发消息 → iroh 'agent_chat'
 *   2. B 节点 (人类可能离线):
 *        - onMessage('agent_chat') → 落 ~/.bolloon/inbox/<peerDID>.jsonl
 *        - 状态 = 'received' (未处理)
 *   3. B 节点 wake-up (processPendingInbox) → 扫描 status='received' 的消息
 *        - 调 LLM 生成 draft (注入主人历史判断 + ValueProfile)
 *        - 写 status='drafted', draft 落盘
 *        - 通过 'agent_chat' 消息类型回送 draft (前缀 [DRAFT] 表明是代回)
 *   4. A 节点收到 draft → 写到 A 的 outbox (inbox 中 from=B 的那条)
 *   5. B 人类上线 → getInbox() 看到 'drafted' 状态的条目, approveAndSend / dismissDraft
 *
 * 镜像 p2p-document-tools.ts 风格: iroh 消息 + 可注入 transport (支持多实例测试)
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { irohTransport as defaultIrohTransport, type IrohTransport } from '../network/iroh-transport.js';
import { getRelevantValues, getValueProfile, loadAllJudgments } from '../pi-ecosystem-judgment/human-value-store.js';

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

// ============================================================================
// 类型
// ============================================================================

export type ChatMessageStatus = 'received' | 'drafted' | 'sent' | 'dismissed';

export interface ChatMessage {
  id: string;
  peerDID: string;
  fromNodeId: string;
  text: string;
  timestamp: number;
  receivedAt: number;
  status: ChatMessageStatus;
  draft?: string;
  draftConfidence?: number;
  draftReasoning?: string;
  draftAt?: number;
  sentText?: string;
  sentAt?: number;
  inboundDraft?: string;
  inboundDraftAt?: number;
}

export type ChatMessageHandler = (msg: ChatMessage, from: string) => void;

// ============================================================================
// 每 transport 一份状态 (支持多 IrohTransport 实例)
// ============================================================================

interface ChatModuleState {
  handlers: Set<ChatMessageHandler>;
  listenerInstalled: boolean;
}

const states = new WeakMap<IrohTransport, ChatModuleState>();

function getState(transport: IrohTransport): ChatModuleState {
  let s = states.get(transport);
  if (!s) {
    s = { handlers: new Set(), listenerInstalled: false };
    states.set(transport, s);
  }
  return s;
}

// ============================================================================
// Inbox 存储
// ============================================================================

function inboxDir(): string {
  return path.join(homeDir(), '.bolloon', 'inbox');
}

function inboxPath(peerDID: string): string {
  const safe = peerDID.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(inboxDir(), `${safe}.jsonl`);
}

function outboxPath(): string {
  return path.join(inboxDir(), '_outbox.jsonl');
}

async function appendInbox(peerDID: string, entry: ChatMessage): Promise<void> {
  await fs.mkdir(inboxDir(), { recursive: true });
  await fs.appendFile(inboxPath(peerDID), JSON.stringify(entry) + '\n', 'utf-8');
}

async function readInbox(peerDID: string): Promise<ChatMessage[]> {
  try {
    const content = await fs.readFile(inboxPath(peerDID), 'utf-8');
    return content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ChatMessage);
  } catch { return []; }
}

async function rewriteInbox(peerDID: string, entries: ChatMessage[]): Promise<void> {
  await fs.mkdir(inboxDir(), { recursive: true });
  await fs.writeFile(inboxPath(peerDID), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

async function updateInboxEntry(peerDID: string, id: string, patch: Partial<ChatMessage>): Promise<ChatMessage | null> {
  const entries = await readInbox(peerDID);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  entries[idx] = { ...entries[idx], ...patch };
  await rewriteInbox(peerDID, entries);
  return entries[idx];
}

async function markOutboundDraft(originalId: string, draft: string, at: number): Promise<void> {
  try {
    const content = await fs.readFile(outboxPath(), 'utf-8');
    const entries: ChatMessage[] = content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const idx = entries.findIndex((e) => e.id === originalId);
    if (idx >= 0) {
      entries[idx].inboundDraft = draft;
      entries[idx].inboundDraftAt = at;
      await fs.writeFile(outboxPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    }
  } catch { /* no outbox */ }
}

// ============================================================================
// Listener 安装 (每个 transport 各装一次)
// ============================================================================

function ensureListener(transport: IrohTransport): void {
  const s = getState(transport);
  if (s.listenerInstalled) return;
  s.listenerInstalled = true;
  transport.onMessage('agent_chat', (msg) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload)) as { kind: string; id: string; text: string; originalId?: string };
      void handleIncomingChat(transport, msg.from, data);
    } catch (e) {
      console.error('[ChatReceiver] parse err:', (e as Error).message);
    }
  });
}

async function handleIncomingChat(transport: IrohTransport, fromNodeId: string, data: { kind: string; id: string; text: string; originalId?: string }): Promise<void> {
  const peerDID = fromNodeId;
  if (data.kind === 'user') {
    const entry: ChatMessage = {
      id: data.id, peerDID, fromNodeId, text: data.text,
      timestamp: Date.now(), receivedAt: Date.now(), status: 'received',
    };
    await appendInbox(peerDID, entry);
    const preview = data.text.slice(0, 60);
    const peerShort = peerDID.slice(0, 12);
    console.log('[ChatReceiver] received from ' + peerShort + ': ' + preview);
    for (const h of getState(transport).handlers) {
      try { h(entry, fromNodeId); } catch {}
    }
  } else if (data.kind === 'draft' && data.originalId) {
    await markOutboundDraft(data.originalId, data.text, Date.now());
    console.log('[ChatReceiver] inbound draft for ' + data.originalId);
  }
}

// ============================================================================
// 公共 API (可注入 transport)
// ============================================================================

export function onChatMessage(handler: ChatMessageHandler, transport: IrohTransport = defaultIrohTransport): void {
  getState(transport).handlers.add(handler);
  ensureListener(transport);
}

export async function initChatReceiver(transport: IrohTransport = defaultIrohTransport): Promise<void> {
  ensureListener(transport);
  await fs.mkdir(inboxDir(), { recursive: true });
  console.log('[ChatReceiver] Initialized at', inboxDir(), 'transport=', (transport as any) === defaultIrohTransport ? 'singleton' : 'instance');
}

export async function sendChat(peerDID: string, text: string, transport: IrohTransport = defaultIrohTransport): Promise<string> {
  const id = crypto.randomUUID();
  const ok = await transport.sendMessage(
    peerDID, 'agent_chat',
    new TextEncoder().encode(JSON.stringify({ kind: 'user', id, text })),
  );
  if (ok) {
    const entry: ChatMessage = {
      id, peerDID,
      fromNodeId: transport.getNodeId() || '',
      text, timestamp: Date.now(), receivedAt: Date.now(),
      status: 'sent', sentText: text, sentAt: Date.now(),
    };
    await fs.mkdir(inboxDir(), { recursive: true });
    await fs.appendFile(outboxPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } else {
    console.warn(`[ChatReceiver] send to ${peerDID.slice(0, 12)}... failed`);
  }
  return id;
}

export async function getInbox(peerDID?: string): Promise<ChatMessage[]> {
  if (peerDID) return readInbox(peerDID);
  try {
    const files = await fs.readdir(inboxDir());
    const all: ChatMessage[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
      const peerDID = f.replace('.jsonl', '').replace(/_/g, ':');
      all.push(...await readInbox(peerDID));
    }
    return all.sort((a, b) => b.receivedAt - a.receivedAt);
  } catch { return []; }
}

// ============================================================================
// Draft 引擎
// ============================================================================

async function buildValueHint(text: string): Promise<string> {
  try {
    const allJudgments = await loadAllJudgments();
    const relevant = await getRelevantValues(text, undefined);
    const profile = await getValueProfile('me');
    const profileHint = [
      `quality_focus=${profile.quality_focus.toFixed(2)}`,
      `efficiency_focus=${profile.efficiency_focus.toFixed(2)}`,
      `safety_focus=${profile.safety_focus.toFixed(2)}`,
      `collaboration_focus=${profile.collaboration_focus.toFixed(2)}`,
      `learning_focus=${profile.learning_focus.toFixed(2)}`,
    ].join(', ');
    const reasons = allJudgments
      .filter((j) => (j.reasons || []).length > 0)
      .slice(-10)
      .flatMap((j) => j.reasons || [])
      .slice(0, 20);
    return `\n[主人历史判断 (style 参考, 不可外泄)]\n关注维度: ${profileHint}\n关键理由示例: ${reasons.join(' | ').slice(0, 400) || '(无)'}\n`;
  } catch (e) {
    return '';
  }
}

export async function generateDraft(
  messageId: string,
  peerDID: string,
  transport: IrohTransport = defaultIrohTransport,
): Promise<ChatMessage | null> {
  const entries = await readInbox(peerDID);
  const entry = entries.find((e) => e.id === messageId);
  if (!entry) return null;
  if (entry.status !== 'received') return entry;

  const valueHint = await buildValueHint(entry.text);
  const promptForDraft = `你是主人的代理. 对方发来这条消息: "${entry.text.slice(0, 1500)}"\n${valueHint}\n请基于主人的历史判断, 用 1-2 句话代主人拟一个回复草案. 草案要保留主人的语气和立场, 开头标注 [DRAFT]. 直接给草案文本, 不要解释.`;

  let draftText = '';
  let confidence = 0.5;
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error('OPENAI_API_KEY not set');
    const openaiBase = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4';
    const r = await fetch(`${openaiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: openaiModel,
        messages: [
          { role: 'system', content: '你是主人的代理. 你的输出会被主人审阅后才发出. 请谨慎.' },
          { role: 'user', content: promptForDraft },
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const data = await r.json() as any;
      draftText = (data.choices?.[0]?.message?.content || '').trim();
      confidence = 0.7;
    } else {
      console.warn(`[DraftEngine] LLM ${r.status}`);
    }
  } catch (e) {
    console.warn(`[DraftEngine] LLM call failed: ${(e as Error).message}`);
  }

  if (!draftText) {
    draftText = `[DRAFT] 已收到. (本地 draft 引擎未配置 LLM, 主人上线后请手写回复)`;
    confidence = 0.1;
  }

  const updated = await updateInboxEntry(peerDID, messageId, {
    status: 'drafted', draft: draftText, draftConfidence: confidence,
    draftReasoning: valueHint.slice(0, 200), draftAt: Date.now(),
  });

  if (updated) {
    const sent = await transport.sendMessage(
      peerDID, 'agent_chat',
      new TextEncoder().encode(JSON.stringify({ kind: 'draft', id: crypto.randomUUID(), text: draftText, originalId: messageId })),
    );
    if (sent) console.log('[DraftEngine] draft sent to ' + peerDID.slice(0, 12) + ' for ' + messageId.slice(0, 8));
    else console.warn(`[DraftEngine] failed to send draft`);
  }
  return updated;
}

export async function processPendingInbox(transport: IrohTransport = defaultIrohTransport): Promise<{ processed: number; skipped: number }> {
  await fs.mkdir(inboxDir(), { recursive: true });
  const files = await fs.readdir(inboxDir());
  let processed = 0, skipped = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
    const peerDID = f.replace('.jsonl', '').replace(/_/g, ':');
    const entries = await readInbox(peerDID);
    for (const e of entries) {
      if (e.status === 'received') {
        const r = await generateDraft(e.id, peerDID, transport);
        if (r) processed++; else skipped++;
      }
    }
  }
  return { processed, skipped };
}

export async function approveAndSend(
  messageId: string, peerDID: string, finalText?: string,
  transport: IrohTransport = defaultIrohTransport,
): Promise<boolean> {
  const entries = await readInbox(peerDID);
  const entry = entries.find((e) => e.id === messageId);
  if (!entry || entry.status !== 'drafted') return false;
  const text = finalText || entry.draft || '';
  const ok = await transport.sendMessage(
    peerDID, 'agent_chat',
    new TextEncoder().encode(JSON.stringify({ kind: 'user', id: crypto.randomUUID(), text })),
  );
  if (ok) {
    await updateInboxEntry(peerDID, messageId, { status: 'sent', sentText: text, sentAt: Date.now() });
  }
  return ok;
}

export async function dismissDraft(messageId: string, peerDID: string): Promise<boolean> {
  const entries = await readInbox(peerDID);
  const entry = entries.find((e) => e.id === messageId);
  if (!entry) return false;
  await updateInboxEntry(peerDID, messageId, { status: 'dismissed' });
  return true;
}

export const p2pChatTools = {
  sendChat, getInbox, processPendingInbox, generateDraft, approveAndSend, dismissDraft, onChatMessage, initChatReceiver,
};
