import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  HyperswarmCommunicator,
  createHyperswarmCommunicator,
  createTopic,
  KeyManager,
  AgentAuthManager,
  type P2PConnection,
} from '@diap/sdk';
import type { AgentVerificationManager } from '@diap/sdk';
import { documentReader } from '../documents/reader.js';
import { initMinimax, getMinimax } from '../constraints/index.js';
import { createAgentSession, type AgentSession, type StreamCallback, type StreamEvent } from '../agents/pi-sdk.js';
import { llmConfigStore, type ModelProvider, PROVIDER_INFO } from '../llm/config-store.js';
import { videoConfigStore, type VideoProvider } from '../llm/video-config-store.js';
import { audioConfigStore, type AudioProvider } from '../llm/audio-config-store.js';
import { irohTransport } from '../network/iroh-transport.js';
import { createAgentDelegateApp } from './agent-delegate-server.js';
import { createIrohDelegateTransport } from './iroh-delegate-transport.js';
import { verifyMessage, isAddress, getAddress } from 'viem';

// 前端资源路径: 兼容 src 运行 + dist 运行 + npm 全局安装
// - src 跑 (tsx):   __dirname = .../src/web  →  .../dist/web
// - dist 跑 (npm):  __dirname = .../dist/web → 自身就是 web 根
// - 环境变量覆盖:  BOLLOON_WEB_ROOT=xxx
// ESM scope 没有 __dirname, 这里自己声明
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
let _baseDirname = __dirname_local;
function resolveWebRoot(): string {
  if (process.env.BOLLOON_WEB_ROOT && fsSync.existsSync(process.env.BOLLOON_WEB_ROOT)) {
    return process.env.BOLLOON_WEB_ROOT;
  }
  const d = _baseDirname;
  const candidates = [
    path.join(d, '..', '..', 'dist', 'web'),         // 2026-06-15 优先: src/web → dist/web (build 产物)
    path.join(d),                                    // dist/web (npm 跑时)
    path.join(d, '..', 'web'),                       // dist/ → web/ 兄弟
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(path.join(c, 'index.html'))) return c;
  }
  return candidates[0];
}
const webRoot = resolveWebRoot();
console.log(`[web] webRoot = ${webRoot}`);

const SHARED_SESSION_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');
const SESSION_CACHE_PATH = path.join(SHARED_SESSION_PATH, 'cache');
const CHANNELS_PATH = path.join(SHARED_SESSION_PATH, 'channels.json');
const THEME_PATH = path.join(SHARED_SESSION_PATH, 'theme.json');
const IPFS_ENDPOINT = 'http://127.0.0.1:5001';

// iroh P2P 状态
interface IrohNodeInfo {
  did: string;
  cid: string;
  irohNodeId: string;
  name: string;
  initialized: boolean;
}
let irohNodeInfo: IrohNodeInfo | null = null;
let irohInitialized = false;

interface Channel {
  id: string;
  name: string;
  agentId: string;
  did?: string;
  // 2026-06-11: channel 级 persona + 关联文档 (从 ~/.bolloon/persona.json 复制或独立覆盖)
  persona?: {
    name?: string;
    description?: string;
    personality?: string;
    greeting?: string;
    capabilities?: string[];
    interests?: string[];
  };
  // 关联的文档 ID 列表 (启动 LLM 时自动加载到 context)
  linkedDocumentIds?: string[];
  publicKey?: string;
  cid?: string;
  /** 轻量引用：从 didDocument 只挑出 cid/ipnsName, 不存整份文档 */
  didDocRef?: { cid?: string; ipnsName?: string };
  /** 加密钱包地址（公链地址, e.g. 0x...）— 与频道绑定, 启用自动 on-chain 工具调用 */
  walletAddress?: string;
  /** 钱包注册时间 */
  walletRegisteredAt?: string;
  /** 钱包绑定签名凭证 (EIP-191 personal_sign 签名 channelId + DID) */
  walletBinding?: {
    address: string;
    signature: string;
    message: string;
    did: string;
    signedAt: string;
  };
  /** 自动工具调用开关 — 当 LLM 决定调用受信任工具时, agent 是否自动执行 */
  autoInvokeTools?: boolean;
  createdAt: string;
  updatedAt: string;
  currentSessionId?: string;
  sessions?: SessionSummary[];
  /** 用户在盾牌里手动绑定的判断力 (LLM 跑 channel 时会注入). 默认 []. */
  bound_judgment_ids?: string[];
  /** v3: 显式共享给哪些 P2P 好友 (peerPublicKey 列表). 只有这些 peer 能看到这个 channel. */
  shared_with_peers?: string[];
  /** v3: 自动生成的 share ID (短字符串), 方便分享给 P2P 好友. */
  share_id?: string;
}

interface SessionSummary {
  id: string;
  createdAt: string;
  messageCount: number;
  preview: string;
}

interface SessionMessage {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: string;
  /** v3: 'local' = channel 内部 owner 发的, 'remote' = 远端访客通过 P2P 发的, 'ai-mention' = 同节点其他 channel 的 AI @-mention, 'ai-mention-remote' = 远端节点的 AI @-mention */
  source?: 'local' | 'remote' | 'ai-mention' | 'ai-mention-remote';
  /** v3: 当 source='remote' 或 'ai-mention-remote' 时记录对方 publicKey */
  fromPublicKey?: string;
  /** v3: 当 source 是 ai-mention* 时, 是哪个 channel 触发的 */
  originChannelId?: string;
  originChannelName?: string;
}

interface Session {
  channelId: string;
  sessionId: string;
  messages: SessionMessage[];
  lastUpdated: string;
}

async function ensureSessionDirs() {
  await fs.mkdir(SESSION_CACHE_PATH, { recursive: true });
}

/** 粗校验链上地址格式 — 不做 EIP-55 校验, 避免阻塞 UI; 失败返回空字符串 */
function isValidWalletAddress(addr: unknown): string {
  if (typeof addr !== 'string') return '';
  const a = addr.trim();
  if (!a) return '';
  // EVM: 0x + 40 hex chars
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  // Sui / Aptos: 0x + 64 hex chars
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) return a;
  // Solana: base58, 32-44 chars
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !a.startsWith('0x')) return a;
  return '';
}

async function loadChannels(): Promise<Channel[]> {
  try {
    const data = await fs.readFile(CHANNELS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveChannels(channels: Channel[]): Promise<void> {
  // 写盘前剥掉任何遗留的 didDocument 字段, 防止历史脏数据撑大文件
  const sanitized = channels.map(ch => {
    const { didDocument: _omit, ...rest } = ch as any;
    return rest as Channel;
  });
  const jsonStr = JSON.stringify(sanitized, null, 2);

  // 写盘保护: 内容和上次完全一致就跳过, 避免 SSE ping / 重新 init 触发的无意义写盘
  if (jsonStr === lastChannelsJson) {
    return; // 静默跳过, 不打日志
  }
  lastChannelsJson = jsonStr;

  console.log('[saveChannels] 保存频道数据, 数量:', sanitized.length);
  console.log('[saveChannels] JSON 长度:', jsonStr.length);
  await fs.writeFile(CHANNELS_PATH, jsonStr);
  // 写盘即令缓存失效: 用 lastChannelsWriteAt 标记, getChannelsWithDID 会检查
  lastChannelsWriteAt = Date.now();
}

// 写盘去重: 上次写盘内容, 用于跳过幂等调用
let lastChannelsJson = '';

// 模块级: 最近一次 channels.json 写盘时间. saveChannels 在模块顶层,
// getChannelsWithDID 在 createWebServer 内部, 跨作用域用模块变量桥接.
let lastChannelsWriteAt = 0;

async function loadSession(channelId: string, sessionId?: string): Promise<Session | null> {
  // sessionId is optional for backward compatibility; if provided, load specific session
  const key = sessionId ? `${channelId}:${sessionId}` : channelId;
  const sessionPath = path.join(SESSION_CACHE_PATH, `${key}.json`);
  try {
    // 内存保护: 拒绝加载过大的 session 文件 (> 50MB 视为异常, 避免 OOM)
    const stat = await fs.stat(sessionPath);
    if (stat.size > 50 * 1024 * 1024) {
      console.warn(`[loadSession] session 过大 (${stat.size} bytes): ${key}`);
      return null;
    }
    const data = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveSession(session: Session): Promise<void> {
  const key = session.sessionId ? `${session.channelId}:${session.sessionId}` : session.channelId;
  const sessionPath = path.join(SESSION_CACHE_PATH, `${key}.json`);
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
}

async function loadTheme(): Promise<{ theme: 'light' | 'dark'; agentId: string }> {
  try {
    const data = await fs.readFile(THEME_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { theme: 'light', agentId: '' };
  }
}

async function saveTheme(theme: 'light' | 'dark', agentId: string): Promise<void> {
  await fs.writeFile(THEME_PATH, JSON.stringify({ theme, agentId }, null, 2));
}

// ==================== Task Queue & Workflow System ====================

const TASK_QUEUE_PATH = path.join(SHARED_SESSION_PATH, 'task-queue.json');
const WORKFLOW_STATE_PATH = path.join(SHARED_SESSION_PATH, 'workflow-state.json');

interface Task {
  id: string;
  type: 'read' | 'summarize' | 'improve' | 'chat' | 'workflow';
  title: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
  progress: number; // 0-100
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  steps?: TaskStep[];
  currentStep?: number;
}

interface TaskStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
}

interface WorkflowState {
  channelId: string;
  tasks: Task[];
  lastUpdated: string;
}

async function loadTaskQueue(): Promise<Task[]> {
  try {
    const data = await fs.readFile(TASK_QUEUE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveTaskQueue(tasks: Task[]): Promise<void> {
  await fs.writeFile(TASK_QUEUE_PATH, JSON.stringify(tasks, null, 2));
}

async function loadWorkflowState(channelId: string): Promise<WorkflowState | null> {
  try {
    const data = await fs.readFile(WORKFLOW_STATE_PATH, 'utf-8');
    const states = JSON.parse(data) as WorkflowState[];
    return states.find(s => s.channelId === channelId) || null;
  } catch {
    return null;
  }
}

async function saveWorkflowState(state: WorkflowState): Promise<void> {
  try {
    const data = await fs.readFile(WORKFLOW_STATE_PATH, 'utf-8');
    const states = JSON.parse(data) as WorkflowState[];
    const index = states.findIndex(s => s.channelId === state.channelId);
    if (index >= 0) {
      states[index] = state;
    } else {
      states.push(state);
    }
    await fs.writeFile(WORKFLOW_STATE_PATH, JSON.stringify(states, null, 2));
  } catch {
    await fs.writeFile(WORKFLOW_STATE_PATH, JSON.stringify([state], null, 2));
  }
}

let isExecutingTask = false;
let executionTaskId: string | null = null;

async function executeTask(task: Task, channelId: string): Promise<void> {
  if (isExecutingTask) return;
  isExecutingTask = true;
  executionTaskId = task.id;

  const agent = await getAgentForChannel(channelId);
  const tasks = await loadTaskQueue();
  const taskIndex = tasks.findIndex(t => t.id === task.id);
  if (taskIndex >= 0) {
    tasks[taskIndex].status = 'running';
    tasks[taskIndex].updatedAt = new Date().toISOString();
    await saveTaskQueue(tasks);
  }

  broadcast({ type: 'task_status', taskId: task.id, status: 'running', progress: 0 }, channelId);

  try {
    let result = '';

    switch (task.type) {
      case 'chat':
        if (task.description) {
          broadcast({ type: 'status', content: `执行任务: ${task.title}` }, channelId);
          result = await agent.prompt(task.description);
        }
        break;

      case 'read':
        if (task.description) {
          broadcast({ type: 'status', content: `读取文档: ${task.description}` }, channelId);
          const content = await documentReader.read(task.description);
          result = `📄 文档读取完成\n\n${content.text.substring(0, 500)}${content.text.length > 500 ? '...' : ''}`;
        }
        break;

      case 'summarize':
        if (task.description) {
          broadcast({ type: 'status', content: `总结文档: ${task.description}` }, channelId);
          const content = await documentReader.read(task.description);
          const llm = getMinimax();
          const summary = await llm.summarize(content.text);
          result = `📝 文档总结:\n\n${summary.summary}`;
        }
        break;

      case 'workflow':
        // 执行多步骤工作流
        if (task.steps && task.steps.length > 0) {
          let loopCount = 0;
          for (let i = 0; i < task.steps.length; i++) {
            // 广播循环开始
            loopCount++;
            broadcast({ type: 'workflow_loop', loopCount, content: `开始步骤 ${i + 1}/${task.steps.length}: ${task.steps[i].name}` }, channelId);

            task.steps[i].status = 'running';
            broadcast({ type: 'task_status', taskId: task.id, status: 'running', currentStep: i, totalSteps: task.steps.length }, channelId);
            broadcast({ type: 'workflow_step', step: `步骤 ${i + 1}`, content: `执行中: ${task.steps[i].name}` }, channelId);

            // 执行步骤 - 模拟流式输出
            for (let j = 0; j < 3; j++) {
              await new Promise(resolve => setTimeout(resolve, 300));
              broadcast({ type: 'workflow_step', step: `步骤 ${i + 1}`, content: `执行中... (${(j + 1) * 33}%)` }, channelId);
            }

            task.steps[i].status = 'completed';
            task.progress = Math.round(((i + 1) / task.steps.length) * 100);

            broadcast({ type: 'workflow_step', step: `步骤 ${i + 1}`, content: `✅ 完成: ${task.steps[i].name}` }, channelId);
            broadcast({ type: 'workflow_loop', loopCount, status: 'completed', content: `步骤 ${i + 1} 完成` }, channelId);
            broadcast({ type: 'task_status', taskId: task.id, progress: task.progress }, channelId);
          }
          result = '✅ 工作流执行完成';
          broadcast({ type: 'workflow_loop', loopCount, status: 'finished', content: result }, channelId);
        }
        break;

      default:
        result = '未知任务类型';
    }

    // 更新任务状态
    const tasks = await loadTaskQueue();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx].status = 'completed';
      tasks[idx].progress = 100;
      tasks[idx].result = result;
      tasks[idx].updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
    }

    broadcast({ type: 'task_status', taskId: task.id, status: 'completed', progress: 100, result }, channelId);
    broadcast({ type: 'ai', content: result }, channelId);

  } catch (error: any) {
    const tasks = await loadTaskQueue();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx].status = 'failed';
      tasks[idx].error = error.message;
      tasks[idx].updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
    }

    broadcast({ type: 'task_status', taskId: task.id, status: 'failed', error: error.message }, channelId);
    broadcast({ type: 'error', content: `任务执行失败: ${error.message}` }, channelId);
  }

  isExecutingTask = false;
  executionTaskId = null;
}

interface SSEClient {
  res: express.Response;
  channelId?: string;
}

let sseClients: Set<SSEClient> = new Set();
// v3: 远端 channel UI 元数据缓存 — key: peerId, value: sanitize 过的 channel 列表
// in-memory only, 进程重启清空 (judgment 内容永远不在这里)
let remoteChannelCache: Map<string, Array<Record<string, unknown>>> = new Map();

// 2026-06-10: 持久化 remote channel cache 到 ~/.bolloon/remote-channels-cache.json
// 之前是纯内存 Map, nodeA 重启后所有对端 channel 列表丢失, 需要等对面再推一次
const REMOTE_CACHE_FILE = `${process.env.HOME || '/tmp'}/.bolloon/remote-channels-cache.json`;
async function loadRemoteChannelCacheFromDisk(): Promise<void> {
  try {
    const { readFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (!existsSync(REMOTE_CACHE_FILE)) return;
    const raw = await readFile(REMOTE_CACHE_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [pk, list] of Object.entries(obj)) {
        if (Array.isArray(list)) {
          remoteChannelCache.set(pk, list as Array<Record<string, unknown>>);
        }
      }
      console.log(`[v3-meta] 从磁盘恢复 ${remoteChannelCache.size} 个 peer 的 channel cache`);
    }
  } catch (err) {
    console.warn('[v3-meta] 恢复 remote channel cache 失败 (非致命):', (err as Error).message);
  }
}
async function persistRemoteChannelCache(): Promise<void> {
  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (!existsSync(`${process.env.HOME || '/tmp'}/.bolloon`)) {
      await mkdir(`${process.env.HOME || '/tmp'}/.bolloon`, { recursive: true });
    }
    const obj: Record<string, unknown> = {};
    for (const [pk, list] of remoteChannelCache.entries()) {
      obj[pk] = list;
    }
    await writeFile(REMOTE_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[v3-meta] 持久化 remote channel cache 失败 (非致命):', (err as Error).message);
  }
}
// 启动时立即同步读一次 (异步, 不阻塞)
loadRemoteChannelCacheFromDisk();
// v3: P2PDirect 引用 (Hyperswarm 薄包装) - 模块级, 因为 web server 闭包里不可用
let v3P2PRef: import('../network/p2p-direct.js').P2PDirect | null = null;
// 2026-06-10: watchdog 提升到 module-level, 让 broadcast() / 模块级业务函数能埋点喂活动
// 之前在 createWebServer 闭包内, 闭包外的 broadcast() 拿不到 → 误判 30min 无活动 → 自杀.
let watchdogRef: any = null;
// v3: 等待中的 history RPC (B 端 chat-history endpoint 用) — rpcId → { resolve, reject }
const v3PendingHistoryGets: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }> = new Map();
let channelSessions: Map<string, AgentSession> = new Map(); // key: channelId
let sessionMessages: Map<string, any[]> = new Map(); // key: channelId + sessionId

/**
 * v3 重做: 构造 channel 的两路 judgment prompt 片段
 *   路 1: 用户在盾牌里手动绑定的 judgment (channel.bound_judgment_ids)
 *   路 2: 全局 judgment 列表 (供 LLM 在主调用中按需挑选, 写入回复)
 * 返回 "" 表示完全没数据; 否则返回完整 "[系统上下文] ..." 块 (含尾部换行)
 * 失败非致命 — 任何异常都返回空串, 保证 LLM 调用不被阻塞
 */

/**
 * v3: 过滤 channel 元数据, 只返回对远端 peer 安全的字段.
 * 关键: bound_judgment_ids / walletBinding / autoInvokeTools 内部状态不外传.
 * judgment 内容永远不会出现在 RPC 响应里 (judgment 始终在 A 节点内存, 由 A 跑 LLM).
 *
 * Phase 3 分享模式: 加 peerPublicKey 参数 — 只有 shared_with_peers 包含此 peer 的 channel 才返回.
 * peerPublicKey 不传 = admin 路径, 返回所有 channel (老行为).
 */
function sanitizeChannelForPeer(
  ch: Channel,
  peerPublicKey?: string
): Record<string, unknown> | null {
  // Phase 3 核心: 分享过滤
  if (peerPublicKey) {
    const shared = Array.isArray(ch.shared_with_peers) ? ch.shared_with_peers : [];
    if (!shared.includes(peerPublicKey)) {
      return null; // 没分享给这个 peer, 不返回
    }
  }
  return {
    id: ch.id,
    name: ch.name,
    did: ch.did,
    publicKey: ch.publicKey,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
    hasWallet: !!ch.walletAddress,
    share_id: ch.share_id,
    // 🔒 不返回: bound_judgment_ids, walletAddress, walletBinding, autoInvokeTools, sessions, shared_with_peers
  };
}

/** v3 新增: 判断 channel 是否分享给 peerPublicKey */
function isSharedWith(ch: Channel, peerPublicKey: string): boolean {
  const shared = Array.isArray(ch.shared_with_peers) ? ch.shared_with_peers : [];
  return shared.includes(peerPublicKey);
}

/**
 * v3 新增: 解析 LLM 回复里的 @-mentions, 把消息发到目标 channel.
 *
 * 语法: "@渠道名 消息内容" — 渠道名匹配 local channels by name, 或 remote channels by name.
 * - 本地 channel: 直接 push 到 session
 * - 远端 channel: 通过 P2P RPC 转发到对端
 *
 * 返回: 解析到的 mention 列表, 供 SSE 广播
 */
async function routeMentionsInReply(
  originChannelId: string,
  replyText: string,
  localChannels: any[],
  remoteChannels: any[]
): Promise<Array<{ targetName: string; targetId: string; source: 'local' | 'remote'; text: string; status: 'sent' | 'failed' }>> {
  const results: any[] = [];
  // 解析: 匹配 @渠道名 后面跟一段文字 (到下一个 @ 或 行尾)
  // 渠道名: 中文/英文/数字/下划线/连字符, 1-30 字符
  const regex = /@([一-龥A-Za-z0-9_\-]{1,30})\s+([^\n@]+?)(?=(?:\s*@[一-龥A-Za-z0-9_\-]{1,30}\s)|$)/g;
  const matches = [...replyText.matchAll(regex)];

  if (matches.length === 0) return results;

  // 找当前 channel 的 name (用于日志)
  let originChannelName = originChannelId;
  try {
    const chs = await loadChannels();
    const oc = chs.find(c => c.id === originChannelId);
    if (oc) originChannelName = oc.name;
  } catch {}

  console.log(`[v3-cross] (${originChannelName}) 解析到 ${matches.length} 个 @-mention`);

  for (const m of matches) {
    const targetName = m[1].trim();
    const text = m[2].trim();
    if (!text) continue;

    // 优先本地 (本地 channel 不能有 ownerPublicKey)
    const localTarget = localChannels.find(c => c.name === targetName);
    const remoteTarget = !localTarget ? remoteChannels.find(c => c.name === targetName) : null;

    if (localTarget) {
      // 本地: 直接 push 到 session
      try {
        const existing = await loadSession(localTarget.id, 'default');
        const session: Session = existing || {
          channelId: localTarget.id, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString()
        };
        session.messages.push({
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'ai' as const,
          content: text,
          timestamp: new Date().toISOString(),
          source: 'ai-mention' as any,             // v3: 标记是其他 channel 的 AI @-mention 进来的
          originChannelId,                        // 谁 @ 过来的
          originChannelName                       // 渠道名 (方便显示)
        });
        session.lastUpdated = new Date().toISOString();
        await saveSession(session);
        console.log(`[v3-cross] (${originChannelName}) @${targetName} → 本地 channel ${localTarget.id}, 存了 ${text.length} chars`);
        // 推 SSE 让本地 UI 知道有 AI 跨渠道消息
        broadcast({
          type: 'cross-mention-received',
          originChannelId, originChannelName,
          targetChannelId: localTarget.id, targetChannelName: localTarget.name,
          text, source: 'ai-mention'
        }, 'broadcast');
        results.push({ targetName, targetId: localTarget.id, source: 'local', text, status: 'sent' });
      } catch (err) {
        console.error(`[v3-cross] @${targetName} 本地存失败:`, (err as Error).message);
        results.push({ targetName, targetId: localTarget.id, source: 'local', text, status: 'failed' });
      }
    } else if (remoteTarget) {
      // 远端: 通过 P2P RPC 转发
      const ownerPk = remoteTarget._ownerPublicKey;
      if (!v3P2PRef) {
        console.warn(`[v3-cross] P2PDirect 未启动, 跳过远端 @${targetName}`);
        results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'failed' });
        continue;
      }
      try {
        const rpc = JSON.stringify({
          v: 3, op: 'agent.cross.post',
          payload: {
            targetChannelId: remoteTarget.id,
            targetChannelName: remoteTarget.name,
            originChannelId,
            originChannelName,
            text,
            fromPublicKey: v3P2PRef.getPublicKey()
          }
        });
        const ok = v3P2PRef.sendTo(ownerPk, rpc);
        if (ok) {
          console.log(`[v3-cross] (${originChannelName}) @${targetName} → 远端 peer ${ownerPk.substring(0,12)}... (channelId=${remoteTarget.id})`);
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'sent' });
        } else {
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'failed' });
        }
      } catch (err) {
        console.error(`[v3-cross] @${targetName} 远端 RPC 失败:`, (err as Error).message);
        results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'failed' });
      }
    } else {
      console.warn(`[v3-cross] @${targetName} 找不到匹配 channel (本地 ${localChannels.length} 个, 远端 ${remoteChannels.length} 个)`);
    }
  }

  return results;
}

/**
 * v3: 处理 Hyperswarm 通道收到的 v3 RPC 消息
 * 设计: 用 HyperswarmCommunicator (DHT topic 自动发现) 取代 iroh 直接 connect
 *   - A 启动 → broadcast(agent.meta.list.reply) → 所有已连接 peer 缓存 A 的 channel
 *   - B 启动 → 同样 broadcast
 *   - 任何节点收到 list 请求 → 回 list.reply
 */
async function handleV3P2PMessage(parsed: any, conn: P2PConnection, comm: HyperswarmCommunicator): Promise<void> {
  const op = parsed.op;
  const peerKey = conn.publicKey;

  if (op === 'agent.meta.list') {
    // 对方问我的 channel 列表 — 只返回分享给他的
    try {
      const channels = await loadChannels();
      const publicMeta = channels
        .map(ch => sanitizeChannelForPeer(ch, peerKey))
        .filter((x): x is Record<string, unknown> => x !== null);
      const reply = JSON.stringify({ v: 3, op: 'agent.meta.list.reply', payload: { channels: publicMeta } });
      await comm.sendToConnection(conn.id, reply);
      console.log(`[v3] 回 ${peerKey.substring(0,12)}... list.reply (${publicMeta.length} 个分享给 ta)`);
    } catch (err) {
      console.error('[v3] 处理 agent.meta.list 失败:', (err as Error).message);
    }
    return;
  }

  if (op === 'agent.meta.list.reply') {
    // 对方把他自己的 channel 列表推给我 — 缓存
    const list = parsed.payload?.channels || [];
    remoteChannelCache.set(peerKey, list);
    console.log(`[v3] 收到 ${peerKey.substring(0,12)}... 的 ${list.length} 个 channel, 已缓存`);
    broadcast({
      type: 'remote-channel-update',
      peerId: peerKey,
      channels: list
    }, 'p2p-global');
    return;
  }

  if (op === 'agent.meta.get') {
    // 对方问单条 channel — 回
    const channelId = parsed.payload?.channelId;
    if (channelId) {
      const channels = await loadChannels();
      const ch = channels.find(c => c.id === channelId);
      if (ch) {
        // Phase 3: 分享过滤 — 必须分享给该 peer
        const sanitized = sanitizeChannelForPeer(ch, peerKey);
        if (sanitized) {
          const reply = JSON.stringify({ v: 3, op: 'agent.meta.get.reply', payload: { channel: sanitized } });
          await comm.sendToConnection(conn.id, reply);
        } else {
          const reply = JSON.stringify({ v: 3, op: 'agent.meta.get.reply', payload: { error: 'not shared with you' } });
          await comm.sendToConnection(conn.id, reply);
        }
      }
    }
    return;
  }

  if (op === 'agent.meta.get.reply') {
    const ch = parsed.payload?.channel;
    if (ch && ch.id) {
      const list = remoteChannelCache.get(peerKey) || [];
      const idx = list.findIndex((c: any) => c.id === ch.id);
      if (idx >= 0) list[idx] = ch;
      else list.push(ch);
      remoteChannelCache.set(peerKey, list);
      broadcast({
        type: 'remote-channel-update',
        peerId: peerKey,
        channels: list
      }, 'p2p-global');
    }
    return;
  }

  if (op === 'agent.chat.send') {
    // B 端发来: 在 A 节点上对 channelId 跑 LLM, 结果回 B
    // judgment 永远在 A 节点 (buildJudgmentHint 已经用 bound_judgment_ids)
    const { channelId, text, fromPublicKey } = parsed.payload || {};
    if (!channelId || !text) {
      console.warn(`[v3] agent.chat.send 缺少 channelId/text`);
      return;
    }
    const senderKey = fromPublicKey || peerKey;
    console.log(`[v3] 收到 ${senderKey.substring(0,12)}... 对 channel ${channelId} 的 chat: "${text.substring(0, 40)}..."`);
    try {
      // 1. 找到 channel
      const channels = await loadChannels();
      const ch = channels.find(c => c.id === channelId);
      if (!ch) {
        const reply = JSON.stringify({
          v: 3, op: 'agent.chat.reply',
          payload: { channelId, fromPublicKey: v3P2PRef?.getPublicKey() || '', error: 'channel not found', text: '' }
        });
        await comm.sendToConnection(conn.id, reply);
        return;
      }
      // v3 新增: 持久化 B 的 user 消息到 A 的 session — 让历史可拉
      try {
        const existing = await loadSession(channelId, 'default');
        const session: Session = existing || {
          channelId, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString()
        };
        session.messages.push({
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'user',
          content: text,
          timestamp: new Date().toISOString(),
          source: 'remote',                      // v3: 标记远端访客
          fromPublicKey: senderKey               // v3: 记录对方 publicKey
        });
        session.lastUpdated = new Date().toISOString();
        await saveSession(session);
        console.log(`[v3] (${channelId}) 存 user 消息 (${text.length} chars) 到 A 的 session (来自 ${senderKey.substring(0,12)}...)`);
      } catch (saveErr) {
        console.warn(`[v3] 存 user 消息失败 (不影响 chat):`, (saveErr as Error).message);
      }

      // v3 修复: 同步给 A 自己的 UI — broadcast SSE 事件让 A 的 owner 实时看到 B 的消息
      broadcast({
        type: 'user',
        content: text,
        channelId,
        source: 'remote',
        fromPublicKey: senderKey
      }, channelId);

      // v3 新增: 告诉 B "我开始想了, 用了哪些 judgment" — 让 B 看到决策依据
      const judgmentHint = await buildJudgmentHint(ch, channelId);
      const usedJudgments = await extractJudgmentsFromHint(ch);
      try {
        const thinkingStart = JSON.stringify({
          v: 3, op: 'agent.chat.thinking',
          payload: {
            channelId,
            phase: 'start',
            fromPublicKey: v3P2PRef?.getPublicKey() || '',
            hint: judgmentHint,
            usedJudgments,
            userText: text
          }
        });
        await comm.sendToConnection(conn.id, thinkingStart);
      } catch {}

      // 2. 跑 LLM (复用 Phase 1 的 buildJudgmentHint — 注入 channel 的 judgment)
      const { getMinimax } = await import('../constraints/index.js');
      const llm = getMinimax();
      // v3 新增: 在 prompt 头部标记"这是远端访客", 让 AI 知道对方不是自己 owner
      const visitorHint = `[系统上下文] 消息来源: 远端访客 (P2P 连接, publicKey=${senderKey.substring(0, 12)}...). 对方不是你 owner, 是通过 P2P 网络访问你这个 channel 的合作者. 称呼对方时可用 "远端访客" / "朋友" / "合作者", 不要叫 "用户".\n\n`;
      // v3 新增: 也注入 channel 目录给 LLM (B 的 channel 也可以 @-mention 其他)
      let dirHint = '';
      const localChannels = (await loadChannels()).filter(c => c.id !== channelId);
      const remoteChannels: any[] = [];
      for (const [peerPk, list] of remoteChannelCache.entries()) {
        if (peerPk === senderKey) continue; // 跳过发起方
        for (const ch of list) {
          remoteChannels.push({ ...ch, _ownerPublicKey: peerPk });
        }
      }
      if (localChannels.length > 0 || remoteChannels.length > 0) {
        dirHint += '[系统上下文] 可用渠道 (你可以用 @渠道名 消息内容 给它们发消息):\n';
        for (const c of localChannels) {
          dirHint += `  - [本地] @${c.name} (id=${c.id})\n`;
        }
        for (const c of remoteChannels) {
          dirHint += `  - [远端, owner=${(c._ownerPublicKey || '').substring(0,8)}…] @${c.name} (id=${c.id})\n`;
        }
        dirHint += '语法: 在回复中写 "@渠道名 我要说的话" 即可. 消息会持久化到目标 channel 的 session.\n\n';
      }
      const fullPrompt = `${visitorHint}${dirHint}${judgmentHint}${text}`;
      let fullResponse = '';
      // v3 新增: 流式 token 节流推给 B — 让 B 看到过程
      let lastFlushAt = 0;
      let usedJudgmentIds: string[] = [];
      const streamCallback: any = (event: any) => {
        // P0.5: 注入门回传
        if (event?.type === 'used_judgments' && Array.isArray(event.usedIds)) {
          usedJudgmentIds = event.usedIds;
          return;
        }
        if (event.type === 'token') {
          fullResponse += event.content;
          if (fullResponse.length - lastFlushAt >= 20) {
            lastFlushAt = fullResponse.length;
            const msg = JSON.stringify({
              v: 3, op: 'agent.chat.thinking',
              payload: { channelId, phase: 'token', partial: fullResponse, fromPublicKey: v3P2PRef?.getPublicKey() || '' }
            });
            comm.sendToConnection(conn.id, msg).catch(() => {});
          }
        }
      };
      const agent = await getAgentForChannel(channelId, ch.did || '', ch.name, ch.didDocRef);
      fullResponse = await agent.promptStream(fullPrompt, streamCallback, undefined, channelId);

      // v3 新增: 存 A 的 assistant 消息到 session — B 拉历史时能看到完整对话
      try {
        const existing = await loadSession(channelId, 'default');
        const session: Session = existing || {
          channelId, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString()
        };
        session.messages.push({
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'ai',
          content: fullResponse,
          ...(usedJudgmentIds.length > 0 ? { metadata: { usedJudgmentIds } } : {}),
          timestamp: new Date().toISOString()
        });
        session.lastUpdated = new Date().toISOString();
        await saveSession(session);
        console.log(`[v3] (${channelId}) 存 assistant 回复 (${fullResponse.length} chars) 到 A 的 session`);
      } catch (saveErr) {
        console.warn(`[v3] 存 assistant 消息失败 (不影响):`, (saveErr as Error).message);
      }

      // v3 修复: 同步给 A 自己的 UI — broadcast AI 回复给 A 的 owner 实时看到
      broadcast({
        type: 'ai',
        content: fullResponse,
        channelId
      }, channelId);

      // 3. 把完整回复发给 B
      const reply = JSON.stringify({
        v: 3, op: 'agent.chat.reply',
        payload: {
          channelId,
          fromPublicKey: v3P2PRef?.getPublicKey() || '',
          text: fullResponse
        }
      });
      await comm.sendToConnection(conn.id, reply);
      console.log(`[v3] 回 chat.reply 给 ${senderKey.substring(0,12)}... (${fullResponse.length} chars)`);
    } catch (err) {
      console.error(`[v3] agent.chat.send 处理失败:`, (err as Error).message);
      try {
        const reply = JSON.stringify({
          v: 3, op: 'agent.chat.reply',
          payload: { channelId, fromPublicKey: v3P2PRef?.getPublicKey() || '', error: (err as Error).message, text: '' }
        });
        await comm.sendToConnection(conn.id, reply);
      } catch {}
    }
    return;
  }

  if (op === 'agent.history.get') {
    // v3 新增: B 拉 A 的 channel 历史 (含所有 message + judgment hint)
    // 共享过滤: 只返回 B 可见的 channel + 包含的 judgment
    const { channelId, rpcId, fromPublicKey } = parsed.payload || {};
    if (!channelId || !rpcId) {
      console.warn(`[v3] agent.history.get 缺少 channelId/rpcId`);
      return;
    }
    try {
      const channels = await loadChannels();
      const ch = channels.find(c => c.id === channelId);
      if (!ch) {
        const err = JSON.stringify({
          v: 3, op: 'agent.history.get.reply',
          payload: { rpcId, error: 'channel not found', messages: [], judgments: { bound: [], candidates: [] } }
        });
        await comm.sendToConnection(conn.id, err);
        return;
      }
      // 共享过滤: 必须 peerKey 在 shared_with_peers 里 (避免泄露未分享的 channel)
      const peerKey = fromPublicKey;
      if (!peerKey || !isSharedWith(ch, peerKey)) {
        const err = JSON.stringify({
          v: 3, op: 'agent.history.get.reply',
          payload: { rpcId, error: 'channel not shared with you', messages: [], judgments: { bound: [], candidates: [] } }
        });
        await comm.sendToConnection(conn.id, err);
        return;
      }
      // 加载 A 端 session
      const session = await loadSession(channelId, 'default');
      // 加载 channel 用到的 judgment
      const judgments = await extractJudgmentsFromHint(ch);
      const reply = JSON.stringify({
        v: 3, op: 'agent.history.get.reply',
        payload: {
          rpcId,
          channelId,
          messages: session?.messages || [],
          lastUpdated: session?.lastUpdated,
          judgments,
          channelName: ch.name
        }
      });
      await comm.sendToConnection(conn.id, reply);
      console.log(`[v3] 回 history.reply 给 ${peerKey.substring(0,12)}... (channelId=${channelId}, ${session?.messages?.length || 0} messages)`);
    } catch (err) {
      console.error(`[v3] agent.history.get 处理失败:`, (err as Error).message);
      try {
        const errMsg = JSON.stringify({
          v: 3, op: 'agent.history.get.reply',
          payload: { rpcId, error: (err as Error).message, messages: [], judgments: { bound: [], candidates: [] } }
        });
        await comm.sendToConnection(conn.id, errMsg);
      } catch {}
    }
    return;
  }

  // v3 新增: 收到远端发来的 @-mention 跨渠道消息, 存到本地 target channel
  if (op === 'agent.cross.post') {
    const { targetChannelId, targetChannelName, originChannelId, originChannelName, text, fromPublicKey } = parsed.payload || {};
    if (!targetChannelId || !text) {
      console.warn(`[v3-cross] agent.cross.post 缺少 targetChannelId/text`);
      return;
    }
    try {
      // 找 channel — 必须存在于本节点
      const channels = await loadChannels();
      const ch = channels.find(c => c.id === targetChannelId);
      if (!ch) {
        console.warn(`[v3-cross] agent.cross.post: 本节点无 channel ${targetChannelId}, 忽略`);
        return;
      }
      // 存到 session — 这是一条来自其他节点的 LLM @-mention
      const existing = await loadSession(targetChannelId, 'default');
      const session: Session = existing || {
        channelId: targetChannelId, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString()
      };
      session.messages.push({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'ai' as const,
        content: text,
        timestamp: new Date().toISOString(),
        source: 'ai-mention-remote' as any,    // v3: 来自其他节点的 AI @-mention
        originChannelId,                        // 哪个 channel 触发的
        originChannelName,
        fromPublicKey                          // 哪个节点来的
      });
      session.lastUpdated = new Date().toISOString();
      await saveSession(session);
      console.log(`[v3-cross] 收到远端 @-mention: ${originChannelName} → 本地 ${targetChannelName} (${text.length} chars)`);
      // 推 SSE 让本地 UI 知道有跨渠道消息到达
      broadcast({
        type: 'cross-mention-received',
        originChannelId, originChannelName,
        targetChannelId, targetChannelName: ch.name,
        text, source: 'ai-mention-remote',
        fromPublicKey
      }, 'broadcast');
    } catch (err) {
      console.error(`[v3-cross] 处理 agent.cross.post 失败:`, (err as Error).message);
    }
    return;
  }

  console.log(`[v3] 收到未知 op: ${op}`);
}

async function buildJudgmentHint(
  channel: Channel | undefined | null,
  channelIdForLog: string
): Promise<string> {
  try {
    const { loadAllJudgments, initializeValueStore } = await import(
      '../pi-ecosystem-judgment/human-value-store.js'
    );
    await initializeValueStore();
    const allJudgments = await loadAllJudgments();
    if (allJudgments.length === 0) return '';

    const boundIds = new Set(
      channel && Array.isArray(channel.bound_judgment_ids) ? channel.bound_judgment_ids : []
    );
    const bound = allJudgments.filter(j => j.id !== undefined && boundIds.has(j.id));
    const others = allJudgments.filter(j => j.id !== undefined && !boundIds.has(j.id));

    let hint = '';

    // 路 1: 用户手动绑定的 judgment — 硬约束, 必须遵循
    if (bound.length > 0) {
      hint += `[系统上下文] 此 channel 用户绑定了 ${bound.length} 条判断力, 必须严格遵循:\n`;
      for (const j of bound) {
        const decision = (j.decision || '').toString().slice(0, 200);
        const reasonList = Array.isArray(j.reasons) ? j.reasons : [];
        const reasonText = reasonList.length > 0
          ? ` (理由: ${reasonList.join('; ').slice(0, 100)})`
          : '';
        hint += `- ${decision}${reasonText}\n`;
      }
      hint += '\n';
    }

    // 路 2: 全局 judgment 候选池 — 软参考, LLM 自己挑
    if (others.length > 0) {
      hint += `[系统上下文] 候选判断力 (用户未明确绑定, 你可以按相关性自主选择参考):\n`;
      for (const j of others) {
        const decision = (j.decision || '').toString().slice(0, 120);
        hint += `- [id=${j.id}] ${decision}\n`;
      }
      hint += `\n[系统上下文] 如果你的回复参考了某条候选判断力, 请在回复中自然提及 "我参考了你的判断: <decision 简述>" 即可, 无需复述 id.\n\n`;
    }

    console.log(
      `[v3] channel ${channelIdForLog} 注入: 绑定 ${bound.length} 条, 候选 ${others.length} 条`
    );
    return hint;
  } catch (err) {
    console.error(`[v3] 加载判断力失败 (非致命):`, (err as Error).message);
    return '';
  }
}

/**
 * v3 新增: 把 channel 当前用到的 judgment 提取成结构化数据, 给 B 端 UI 显示.
 * 返回 { bound: [...], candidates: [...] } — bound 是硬绑定, candidates 是参考池.
 */
async function extractJudgmentsFromHint(
  channel: Channel | undefined | null
): Promise<{ bound: any[]; candidates: any[] }> {
  try {
    const { loadAllJudgments, initializeValueStore } = await import(
      '../pi-ecosystem-judgment/human-value-store.js'
    );
    await initializeValueStore();
    const allJudgments = await loadAllJudgments();
    if (allJudgments.length === 0) return { bound: [], candidates: [] };

    const boundIds = new Set(
      channel && Array.isArray(channel.bound_judgment_ids) ? channel.bound_judgment_ids : []
    );

    const summarize = (j: any) => ({
      id: j.id,
      decision: (j.decision || '').toString().slice(0, 200),
      reasons: Array.isArray(j.reasons) ? j.reasons : [],
      domain: j.domain,
      stakes: j.stakes
    });

    const bound = allJudgments
      .filter((j: any) => j.id !== undefined && boundIds.has(j.id))
      .map(summarize);
    const candidates = allJudgments
      .filter((j: any) => j.id !== undefined && !boundIds.has(j.id))
      .map(summarize);

    return { bound, candidates };
  } catch (err) {
    console.warn(`[v3] extractJudgmentsFromHint 失败:`, (err as Error).message);
    return { bound: [], candidates: [] };
  }
}

async function getAgentForChannel(
  channelId: string,
  channelDid?: string,
  channelName?: string,
  channelDidDoc?: any
): Promise<AgentSession> {
  // 获取当前 channel 的 currentSessionId
  const channels = await loadChannels();
  const channel = channels.find(c => c.id === channelId);
  const currentSessionId = channel?.currentSessionId || 'default';
  const sessionKey = `${channelId}:${currentSessionId}`;

  console.log(`[Agent] 获取频道 ${channelId} 的 session, sessionKey = ${sessionKey}`);

  const existingSession = channelSessions.get(sessionKey);

  // 如果已有 session，检查是否需要更新 identity
  if (existingSession) {
    console.log(`[Agent] 找到现有 session: ${sessionKey}`);
    const currentIdentity = existingSession.getIdentity();

    // 如果当前 identity 没有真实 DID，或者 DID 与频道的 DID 不匹配，需要重建
    let needsUpdate = !currentIdentity.did.startsWith('did:pi:') ||
                        (channelDid && !currentIdentity.did.includes(channelId));

    if (!needsUpdate && channelDid && currentIdentity.did !== channelDid) {
      needsUpdate = true;
    }

    if (needsUpdate && channelDid) {
      // 更新现有 session 的 identity
      existingSession.updateIdentity({
        did: channelDid,
        name: channelName || `Channel-${channelId.slice(-6)}`,
        publicKey: '',
        createdAt: Date.now(),
        cid: channelDidDoc?.cid,
        ipnsName: channelDidDoc?.ipnsName
      });
      console.log(`[Agent] 频道 ${channelId} 身份更新: DID = ${channelDid}`);
    }
    return existingSession;
  }

  // 构建频道的身份文档 (从 didDocRef 拿 cid/ipnsName, 不读整份 didDocument)
  const identityDoc = channelDid ? {
    did: channelDid,
    name: channelName || `Channel-${channelId.slice(-6)}`,
    publicKey: '',
    createdAt: Date.now(),
    cid: channelDidDoc?.cid,
    ipnsName: channelDidDoc?.ipnsName
  } : undefined;

  console.log(`[Agent] 创建新 session: ${sessionKey}`);
  const session = await createAgentSession({
    cwd: process.cwd(),
    peerId: `channel-${channelId}:${currentSessionId}`,
    identityDoc
  }, true); // forceNew: true 强制创建新实例
  channelSessions.set(sessionKey, session);

  if (channelDid) {
    console.log(`[Agent] 新建频道 ${channelId} session, DID = ${channelDid}, sessionId = ${currentSessionId}`);
  } else {
    console.log(`[Agent] 新建频道 ${channelId} session, 使用默认身份, sessionId = ${currentSessionId}`);
  }

  return session;
}

export interface CreateWebServerOptions {
  selfImprove?: boolean;
}

let selfImproveEnabled = false;

export async function createWebServer(port: number = 3000, options: CreateWebServerOptions = {}) {
  selfImproveEnabled = options.selfImprove ?? false;
  // 防止 P2P DHT 超时等错误导致进程崩溃
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[警告] 未处理的 Promise 拒绝:', reason);
  });

  // Bolloon Bootstrap (幂等, 重复调不会重复挂定时器)
  // 这里独立调一次以保证 CLI-only 模式 (无 index.ts 引导) 也能 bootstrap
  try {
    const { bootstrapBolloon } = await import(
      '../pi-ecosystem-judgment/human-value-pipeline.js'
    );
    const bs = await bootstrapBolloon({ cwd: process.cwd() });
    console.log(`[createWebServer] bootstrap 完成 (${bs.durationMs}ms)`);
  } catch (err) {
    console.warn('[createWebServer] bootstrap 失败 (非致命):', err);
  }

  // 重置旧的 agent session，确保使用新的 LLM 配置
  const { resetAgentSession } = await import('../agents/pi-sdk.js');
  resetAgentSession();

  // 初始化 LLM（从配置文件读取 MiniMax 配置）
  initMinimax();

  // ==================== P2P DIAP 身份初始化 ====================
  let p2pIdentity = {
    did: '',
    name: '',
    publicKey: '',
    keypair: null as any
  };
  let p2pCommunicator: HyperswarmCommunicator | null = null;

  // v3: 定期 broadcast — 每个 peer 只收到分享给他的 channel (按 peer 个性化)
  // 走 known_peers (持久化) + sendTo (自动 joinPeer 重连), 不只 conns
  // 定义在此处 (所有 try 外部), 确保 route handlers 也能访问
  const v3BroadcastOwn = async () => {
    if (!v3P2PRef) return { sent: 0, total: 0 };
    const channels = await loadChannels();
    const { listPeers } = await import('../network/known-peers.js');
    const peers = await listPeers();
    const myPk = v3P2PRef.getPublicKey();
    // 2026-06-10: 本机名字一起携带, 对端能直接显示 + 落到自己的 known_peers
    let myName = process.env.BOLLOON_USER_NAME || process.env.USER || 'node';
    try {
      const { readFileSync, existsSync } = await import('fs');
      const cfgPath = `${process.env.HOME || '/tmp'}/.bolloon/config.json`;
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        if (cfg.userName) myName = cfg.userName;
      }
    } catch {}
    let sent = 0;
    for (const peer of peers) {
      if (peer.publicKey === myPk) continue;
      const sharedForPeer = channels
        .map(ch => sanitizeChannelForPeer(ch, peer.publicKey))
        .filter((x): x is Record<string, unknown> => x !== null);
      if (sharedForPeer.length > 0) {
        const msg = JSON.stringify({
          v: 3, op: 'agent.meta.list.reply',
          payload: { channels: sharedForPeer, name: myName, fromPublicKey: myPk }
        });
        const ok = v3P2PRef.sendTo(peer.publicKey, msg);
        if (ok) {
          sent++;
          console.log(`[v3] broadcast: ${peer.name || peer.publicKey.substring(0,8)} → ${sharedForPeer.length} 个 channel`);
        }
      }
    }
    console.log(`[v3] broadcast 完成: sent=${sent}/${peers.length} 个 peer`);
    return { sent, total: peers.length };
  };

  try {
    console.log('开始生成 P2P 身份...');

    // 生成 DIAP 身份
    const kp = KeyManager.generate();
    console.log('KeyManager.generate() 完成, kp:', !!kp, 'kp.did:', kp?.did);
    console.log('kp.publicKey:', kp?.publicKey);

    const did = kp.did || 'did:unknown:123456';
    console.log(`DID: ${did}`);

    const username = 'web-user';
    const suffix = did?.split(':').pop()?.substring(0, 4) || 'xxxx';
    const name = `blln-${username}-${suffix}`;

    p2pIdentity = {
      did: did || '',
      name,
      publicKey: Buffer.from(kp.publicKey).toString('hex'),
      keypair: kp
    };

    console.log(`P2P 身份已生成: ${p2pIdentity.did}`);

    // 尝试发布 DID 到 IPFS
    try {
      const auth = await AgentAuthManager.newWithRemoteIpfs('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
      await auth.registerAgent({ name, services: [] }, kp, '');
      console.log('P2P DID 已发布到 IPFS');
    } catch (e) {
      console.log('P2P DID 本地模式运行');
    }

    // v3: 完全用 P2PDirect 取代 @diap/sdk 的 HyperswarmCommunicator
    // 原因: @diap/sdk 的 sendToConnection 是 stub, 不真发数据
    // 这里故意不启动 p2pCommunicator (保持 null), 让 P2PDirect 独占 hyperswarm 通道
    try {
      const { P2PDirect } = await import('../network/p2p-direct.js');
      v3P2PRef = new P2PDirect({ name: 'v3' });
      await v3P2PRef.start();
      await v3P2PRef.joinTopic(Buffer.from('bolloon-agent-harness'));

      v3P2PRef.on('data', (evt: any) => {
        try {
          const parsed = JSON.parse(evt.data.toString('utf-8'));
          if (parsed && parsed.v === 3 && parsed.op) {
            // v3 跨用户 chat: B 端收到 A 的 chat.reply, 直接 SSE 推给前端
            if (parsed.op === 'agent.chat.reply') {
              console.log(`[v3] 收到来自 ${evt.fromPublicKey.substring(0,12)}... 的 chat.reply (${(parsed.payload?.text || '').length} chars)`);
              broadcast({
                type: 'remote-chat-reply',
                fromPublicKey: evt.fromPublicKey,
                channelId: parsed.payload?.channelId,
                text: parsed.payload?.text || '',
                error: parsed.payload?.error
              }, 'p2p-global');
              return;
            }
            // v3 新增: B 端收到 A 的 thinking (开始 + 流式 token)
            if (parsed.op === 'agent.chat.thinking') {
              const phase = parsed.payload?.phase;
              if (phase === 'start') {
                console.log(`[v3] 收到来自 ${evt.fromPublicKey.substring(0,12)}... 的 thinking start (judgments: bound=${(parsed.payload?.usedJudgments?.bound || []).length}, candidates=${(parsed.payload?.usedJudgments?.candidates || []).length})`);
              }
              broadcast({
                type: 'remote-chat-thinking',
                fromPublicKey: evt.fromPublicKey,
                channelId: parsed.payload?.channelId,
                phase: parsed.payload?.phase,
                partial: parsed.payload?.partial,
                hint: parsed.payload?.hint,
                usedJudgments: parsed.payload?.usedJudgments,
                userText: parsed.payload?.userText
              }, 'p2p-global');
              return;
            }
            // v3 新增: B 端收到 A 的 history reply → resolve pending promise
            if (parsed.op === 'agent.history.get.reply') {
              const rpcId = parsed.payload?.rpcId;
              if (rpcId && v3PendingHistoryGets.has(rpcId)) {
                const pending = v3PendingHistoryGets.get(rpcId)!;
                v3PendingHistoryGets.delete(rpcId);
                if (parsed.payload?.error) {
                  pending.reject(new Error(parsed.payload.error));
                } else {
                  pending.resolve({
                    channelId: parsed.payload.channelId,
                    messages: parsed.payload.messages || [],
                    lastUpdated: parsed.payload.lastUpdated,
                    judgments: parsed.payload.judgments || { bound: [], candidates: [] },
                    channelName: parsed.payload.channelName
                  });
                }
              }
              return;
            }
            const commShim = {
              sendToConnection: (_id: string, data: string) => {
                v3P2PRef!.sendTo(evt.fromPublicKey, data);
                return Promise.resolve();
              }
            };
            // v3 新增: 好友申请 RPC — 任何对端可以发, 推到前端 UI 让用户接受
            if (parsed.op === 'agent.friend.request') {
              console.log(`[v3-friend] 收到 ${evt.fromPublicKey.substring(0,12)}... 的好友申请: ${parsed.payload?.name || '(无名字)'}`);
              broadcast({
                type: 'friend-request',
                fromPublicKey: evt.fromPublicKey,
                fromName: parsed.payload?.name || ('peer-' + evt.fromPublicKey.substring(0, 8)),
                message: parsed.payload?.message || '想加你为 P2P 好友',
                requestId: parsed.payload?.requestId,    // 2026-06-10: 透传 requestId 给前端
                timestamp: Date.now()
              }, 'p2p-global');
              // 2026-06-10 新增: 立刻发 ack 回给发送方, 让发送方 UI 知道"对方收到了"
              try {
                const ackRpc = JSON.stringify({
                  v: 3,
                  op: 'agent.friend.request.ack',
                  payload: {
                    requestId: parsed.payload?.requestId,
                    receivedBy: v3P2PRef?.getPublicKey(),
                    timestamp: Date.now()
                  }
                });
                v3P2PRef?.sendTo(evt.fromPublicKey, ackRpc);
              } catch (err) {
                console.warn('[v3-friend] 发 ack 失败 (不阻塞):', (err as Error).message);
              }
              return;
            }
            // 2026-06-10 新增: 发送方收到对方 ack → SSE 推前端, 显示"对方已收到"
            if (parsed.op === 'agent.friend.request.ack') {
              console.log(`[v3-friend] 收到 ack: requestId=${(parsed.payload?.requestId || '').substring(0,8)} 来自 ${evt.fromPublicKey.substring(0,12)}...`);
              broadcast({
                type: 'friend-request-ack',
                requestId: parsed.payload?.requestId,
                receivedBy: parsed.payload?.receivedBy,
                timestamp: Date.now()
              }, 'p2p-global');
              return;
            }
            // v3 修复: agent.meta.list.reply 也走 v3P2PRef.on('data') (因为 handleV3P2PMessage 只走老通道)
            if (parsed.op === 'agent.meta.list.reply') {
              const list = parsed.payload?.channels || [];
              remoteChannelCache.set(evt.fromPublicKey, list);
              // 2026-06-10: 持久化到 ~/.bolloon/remote-channels-cache.json, 重启后不丢
              persistRemoteChannelCache();
              // 2026-06-10: 接收侧记录对方名字 (来自 list.reply payload.name), 落 known_peers
              const senderName = parsed.payload?.name;
              if (senderName && typeof senderName === 'string') {
                import('../network/known-peers.js').then(({ addOrUpdatePeer }) =>
                  addOrUpdatePeer(senderName, evt.fromPublicKey)
                ).catch(err => console.warn('[v3] 记录对端名字失败:', (err as Error).message));
              }
              console.log(`[v3] 收到 ${evt.fromPublicKey.substring(0,12)}... 的 ${list.length} 个 channel, 已缓存 (sender=${senderName || '?'})`);
              broadcast({
                type: 'remote-channel-update',
                peerId: evt.fromPublicKey,
                peerName: senderName,           // 2026-06-10: 一并带名字到 UI
                channels: list
              }, 'p2p-global');
              return;
            }
            // 2026-06-10: 收到对方请求本机的 channel 列表 (启动时主动发请求, 加速 cache 填充)
            if (parsed.op === 'agent.meta.list.request') {
              console.log(`[v3-meta] 收到 ${evt.fromPublicKey.substring(0,12)}... 的 channel 列表请求 → 立刻回包`);
              // 不能 await (在 on('data') sync 回调里), 改用 .then 异步处理
              loadChannels().then(channels => {
                const sharedForPeer = channels
                  .map(ch => sanitizeChannelForPeer(ch, evt.fromPublicKey))
                  .filter((x): x is Record<string, unknown> => x !== null);
                const msg = JSON.stringify({
                  v: 3, op: 'agent.meta.list.reply',
                  payload: { channels: sharedForPeer }
                });
                v3P2PRef!.sendTo(evt.fromPublicKey, msg);
              }).catch(err => console.warn('[v3-meta] 回应 channel 列表失败:', (err as Error).message));
              return;
            }
            handleV3P2PMessage(parsed, { id: evt.fromPublicKey, publicKey: evt.fromPublicKey } as any, commShim as any);
          }
        } catch (err) {
          console.error('[v3-P2PDirect] 解析/处理消息失败:', (err as Error).message);
        }
      });

      // 新连接进来 → 主动发我分享给 ta 的 channel 列表
      v3P2PRef.on('connection', (evt: any) => {
        // 2026-06-10: 喂 watchdog —— 新连接到来是真实业务活动
        watchdogRef?.recordActivity?.();
        setTimeout(async () => {
          try {
            const channels = await loadChannels();
            const publicMeta = channels
              .map(ch => sanitizeChannelForPeer(ch, evt.remotePublicKey))
              .filter((x): x is Record<string, unknown> => x !== null);
            const msg = JSON.stringify({ v: 3, op: 'agent.meta.list.reply', payload: { channels: publicMeta } });
            v3P2PRef!.sendTo(evt.remotePublicKey, msg);
            console.log(`[v3] 新连接 ${evt.remotePublicKey.substring(0,12)}... → 发 ${publicMeta.length} 个分享给 ta`);
          } catch (err) {
            console.error('[v3] 新连接发 list.reply 失败:', (err as Error).message);
          }
        }, 500);
      });

      console.log(`[v3] P2PDirect 已启动, role=${v3P2PRef.getRole()}, publicKey=${v3P2PRef.getPublicKey().substring(0,12)}...`);

      // v3: 启动后自动重连 known peers — 让"启动就互联"成为现实
      setTimeout(async () => {
        try {
          const { listPeers, markConnected } = await import('../network/known-peers.js');
          const peers = await listPeers();
          if (peers.length === 0) {
            console.log(`[v3] 没有 known peers, 跳过自动重连`);
            return;
          }
          const swarm = (v3P2PRef as any).swarm;
          if (!swarm) return;
          for (const peer of peers) {
            try {
              await swarm.joinPeer(Buffer.from(peer.publicKey, 'hex'));
              await markConnected(peer.name || '');
              console.log(`[v3] 自动重连 ${peer.name} (${peer.publicKey.substring(0, 12)}...) ✓`);
            } catch (err) {
              console.warn(`[v3] 自动重连 ${peer.name} 失败:`, (err as Error).message);
            }
          }
          // 触发一次 broadcast 推送给所有重连的 peer
          setTimeout(() => v3BroadcastOwn(), 2000);
          // 2026-06-10: 同时主动请求每个 known peer 把 ta 的 channel 列表推过来
          // 避免对面 publicKey 没变但 cache 丢了(本机重启) → 一直空
          setTimeout(() => requestChannelsFromAllPeers(), 3500);
        } catch (err) {
          console.error('[v3] 自动重连失败:', (err as Error).message);
        }
      }, 5000); // 5s 后再重连, 让 swarm 充分 bootstrap

      // 2026-06-10 新增: 主动向所有 known peer 发起 channel 列表请求
      async function requestChannelsFromAllPeers() {
        if (!v3P2PRef) return;
        try {
          const { listPeers } = await import('../network/known-peers.js');
          const peers = await listPeers();
          const myPk = v3P2PRef.getPublicKey();
          const req = JSON.stringify({ v: 3, op: 'agent.meta.list.request', payload: { fromPublicKey: myPk } });
          let sent = 0;
          for (const peer of peers) {
            if (peer.publicKey === myPk) continue;
            // 用 sendToWithWait, 等 conn 就绪再发 (同 Step 5 sendToWithWait 修复)
            const r = await v3P2PRef.sendToWithWait(peer.publicKey, req, 3000);
            if (r === 'SENT') sent++;
          }
          console.log(`[v3-meta] requestChannelsFromAllPeers → sent=${sent}/${peers.length - 1}`);
        } catch (err) {
          console.warn('[v3-meta] requestChannelsFromAllPeers failed:', (err as Error).message);
        }
      }
      // 立即跑一次 + 每 30s 兜底 (跟 v3BroadcastOwn 一样的节奏)
      setTimeout(requestChannelsFromAllPeers, 4000);
      setInterval(requestChannelsFromAllPeers, 30000);
    } catch (err) {
      console.error('[v3] P2PDirect 启动失败:', (err as Error).message);
      v3P2PRef = null;
    }

    // 首次广播: 等 swarm bootstrap 完成后推一次
    setTimeout(v3BroadcastOwn, 3000);
    // v3 修复: 用 setInterval 替代一次性 setTimeout, 确保分享变更后能持续推送给 peer
    setInterval(v3BroadcastOwn, 30000);

    // 保留 @diap/sdk 的旧实例 (它的 Hyperswarm 实例能帮 P2PDirect 做 DHT bootstrap)
    try {
      const rawSeed = crypto.getRandomValues(new Uint8Array(32));
      p2pCommunicator = createHyperswarmCommunicator({
        server: true,
        client: true,
        autoConnect: true,
        maxConnections: 50,
        seed: rawSeed
      } as any);
      p2pCommunicator.on('message', async (msg: any, conn: P2PConnection) => {
        // 旧 p2p_message 路径 (非 v3)
        const content = new TextDecoder().decode(msg.content);
        broadcast({ type: 'p2p_message', from: conn.publicKey.substring(0, 8), content }, undefined);
      });
      await p2pCommunicator.start();
      // @diap/sdk 也 join topic — 它的 Hyperswarm 实例帮 P2PDirect 做 DHT 引导
      // @diap/sdk 收到的数据是 mock (不真发), 但 DHT 发现 + 节点连接是 OK 的
      const oldTopic = createTopic('bolloon-agent-harness') as Buffer;
      await p2pCommunicator.joinTopic(oldTopic);
      console.log(`P2P 老通道已就绪 (DHT bootstrap 帮 P2PDirect, 实际数据走 P2PDirect)`);
    } catch (e: any) {
      console.log(`P2P 老通道初始化失败: ${e.message}`);
    }
  } catch (e: any) {
    console.log(`P2P 身份初始化失败: ${e.message}`);
  }

  const app = express();
  const server = createServer(app);

  await ensureSessionDirs();

  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  app.use(express.static(webRoot));

  app.get('/', (req, res) => {
    res.sendFile(join(webRoot, 'index.html'));
  });

  app.get('/api-config', (req, res) => {
    // 防御: sendFile 在文件缺失时会异步抛 NotFoundError, 这里用同步读 + send 兜底
    const filePath = join(webRoot, 'api-config.html');
    if (!fsSync.existsSync(filePath)) {
      // 回退到 SPA 主页, 避免 404 崩溃
      return res.status(404).type('text/plain').send('api-config.html not found; please run `npm run build:web`');
    }
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        console.error('[api-config] sendFile failed:', err.message);
        res.status(500).type('text/plain').send('api-config.html send error: ' + err.message);
      }
    });
  });

  // 全局兜底: 任何 next(err) 走到这里, 给出结构化 4xx/5xx 而不是默认 HTML
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] unhandled error on', req.method, req.path, '-', err?.message || err);
    if (res.headersSent) return;
    res.status(err?.status || 500).type('text/plain').send(
      `Error ${err?.status || 500}: ${err?.message || 'internal error'} on ${req.method} ${req.path}`
    );
  });

  app.get('/events', (req, res) => {
    const channelId = req.query.channelId as string;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    // 2026-06-11: 改 keep-alive → close
    // 原因: SSE 长连接占着 keep-alive 槽 (HTTP/1.1 + 浏览器 max 6 并发), 后续同源 fetch 排队 30s+
    // 设 close 让浏览器把 SSE 当长期流, 不抢占普通请求的 keep-alive 槽
    res.setHeader('Connection', 'close');
    // 反向代理 (nginx/cloudflair) 需要: 禁用缓冲 + 立即 flush
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientInfo = { res, channelId };
    sseClients.add(clientInfo as any);
    console.log(`[SSE] 客户端连接 channelId=${channelId || '(broadcast)'}, 总数=${sseClients.size}`);

    req.on('close', () => {
      sseClients.delete(clientInfo as any);
      try { res.end(); } catch {}
      console.log(`[SSE] 客户端断开 channelId=${channelId || '(broadcast)'}, 剩余=${sseClients.size}`);
    });
  });

  app.post('/message', async (req, res) => {
    const { text, channelId, channelDid } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    if (!channelId) {
      return res.status(400).json({ error: 'No channelId provided' });
    }

    // 获取频道信息（只取轻量引用, 不再读完整 DID 文档）
    const channels = await loadChannels();
    const channel = channels.find(c => c.id === channelId);
    const currentSessionId = channel?.currentSessionId || 'default';
    const realChannelDid = channelDid || channel?.did || '';
    const realChannelName = channel?.name || '';
    const realChannelDidDoc = channel?.didDocRef;

    broadcast({ type: 'user', content: text }, channelId);

    // 2026-06-11: /message 端点立即返回 202, LLM 后续处理挪到 setImmediate 后台跑
    // 之前 res.json 在 try 块末尾 (line 1815), 需要等 LLM (5-15s) + 落盘 + suggestRename (5-8s) = 13s+
    // 客户端 fetch 占用 13s, 视觉像"卡死", 切其他 channel 也感觉"无法加载"
    // 修法: 立即 res.json(202), try 块主体仍跑 (LLM 流 + 落盘) 但不阻塞 HTTP 响应
    //     关键: res.json 之后不能再调用 res.json (会抛 ERR_HTTP_HEADERS_SENT), 所以 try 块末尾的 res.json 必须用 res.headersSent 守卫
    res.status(202).json({ ok: true, async: true, channelId, sessionId: currentSessionId });
    console.log(`[v3-async] /message 立即返回 202, channel=${channelId}, text length=${text.length}`);

    // 提前捕获 wallet/autoTools 到本地变量, 避免下面 try 块内的 inner const channel
    // (line ~638) 与这里外层的 const channel 形成 shadowing 让 TS 误报"使用前未声明"
    const boundWalletAddress = channel?.walletAddress;
    const autoToolsEnabled = channel?.autoInvokeTools !== false; // 默认开启
    // 捕获外层 channel 到独立变量, 避免被 try 块内 (line 740+) 的 const channel 遮蔽
    const channelForJudgment = channel;

    // per-channel queue 检查: 已在跑就入队, 等当前跑完自动接上
    const runState = getOrCreateRunState(channelId);
    if (runState.running) {
      runState.queue.push({ channelId, text, boundWalletAddress, autoToolsEnabled });
      broadcastQueueUpdate(channelId);
      console.log(`[queue] /message 入队 channel=${channelId}, queue len=${runState.queue.length}`);
      return;
    }
    runState.running = true;
    runState.abortController = new AbortController();
    broadcastQueueUpdate(channelId);

    try {
      const agent = await getAgentForChannel(channelId, realChannelDid, realChannelName, realChannelDidDoc);
      let fullResponse = '';
      // P0.5: 注入门回传的 usedIds, 落 session message metadata, UI 可查
      let usedJudgmentIds: string[] = [];

      const streamCallback: StreamCallback = (event: StreamEvent) => {
        // P0.5: 捕获注入门回传
        if ((event as any).type === 'used_judgments' && Array.isArray((event as any).usedIds)) {
          usedJudgmentIds = (event as any).usedIds;
          // 同步推给前端 (用于 finalizeTimelineAsMessage 时给 addMessage 传 usedIds)
          broadcast({ type: 'used_judgments', usedIds: usedJudgmentIds }, channelId);
          return;
        }
        // 阶段事件 (注入门 / D 触发)
        if ((event as any).type === 'phase') {
          broadcast({
            type: 'phase',
            phase: (event as any).phase,
            detail: (event as any).detail,
            usedCount: (event as any).usedCount,
          }, channelId);
          return;
        }
        // 同时发送给流式显示和工作流显示
        if (event.type === 'token' || event.type === 'thinking') {
          broadcast({ type: 'stream', streamType: event.type, content: event.content }, channelId);
          // 同时作为 workflow_step 显示（用于动态 loop 循环）
          if (event.content) {
            broadcast({ type: 'workflow_step', step: 'AI 思考', content: event.content.substring(0, 100) }, channelId);
          }
        } else if (event.type === 'status' || event.type === 'tool') {
          broadcast({ type: 'status', tool: event.tool, content: event.content }, channelId);
          broadcast({ type: 'workflow_step', step: event.tool || '系统', content: event.content }, channelId);
          console.log(`[SSE 广播] workflow_step: step=${event.tool}, content="${event.content?.substring(0, 80)}..."`);
        } else if (event.type === 'step_start' || event.type === 'step_done' || event.type === 'step_error') {
          // 2026-06-15: 步骤状态机事件 — 原样转发 (前端 step-timeline 组件订阅)
          broadcast({
            type: event.type,
            tool: event.tool,
            content: event.content,
            success: event.success,
            output: event.output,
            error: event.error,
            args: event.args,
          }, channelId);
        } else if (event.type === 'error') {
          broadcast({ type: 'error', content: event.content }, channelId);
        }
      };

      console.log(`[消息处理] 开始处理用户消息, channelId: ${channelId}, sessionId: ${currentSessionId}`);

      // 将真实 DID 作为上下文前缀，让 AI 使用真实的 DID 而不是自己编造的
      let contextHint = '';
      if (realChannelDid) contextHint += `[系统上下文] 当前频道名称: ${realChannelName}, 你的真实 DID: ${realChannelDid}\n`;
      // v3 新增: 标识发送方 — 让 AI 分清内部 owner vs 远端访客
      contextHint += `[系统上下文] 消息来源: 本地 (channel 内部 owner / 此机器上的用户). 称呼对方时用 "你" 或 "用户" 即可.\n`;
      if (boundWalletAddress) {
        contextHint += `[系统上下文] 已绑定的加密钱包地址: ${boundWalletAddress}。当用户授权或启用自动工具调用时, 可使用该地址发起链上操作。\n`;
      }
      if (autoToolsEnabled) {
        contextHint += `[系统上下文] 自动工具调用已开启: 你可以使用受信任的本地工具 (shell / 文件 / skill) 而无需逐次询问用户。\n`;
      } else {
        contextHint += `[系统上下文] 自动工具调用已关闭: 每次执行工具前必须先与用户确认。\n`;
      }

      // v3: 注入 channel 绑定的判断力 (judgment_ids)
      // 这是 v3 的核心 — channel 跑 LLM 时, 它的判断力 = 绑定的 judgment 列表
      const judgmentHint = await buildJudgmentHint(channelForJudgment, channelId);
      if (judgmentHint) contextHint += judgmentHint;

      // 2026-06-10: 注入 skills 列表 (本机 ~/.bolloon/skills/ 下所有 skills)
      // 让 LLM 知道有哪些 skill 可用, 在回复中提示用户
      try {
        const { loadSkillsFromPaths, defaultSkillPaths, describeSkill } = await import('../agents/skill-loader.js');
        const paths = defaultSkillPaths();
        const skills = await loadSkillsFromPaths(paths);
        if (skills.length > 0) {
          contextHint += `[系统上下文] 本机已加载的 skills (${skills.length} 个, 你可以提示用户主动调用):\n`;
          for (const s of skills.slice(0, 20)) {  // 上限 20 避免 prompt 过长
            const desc = (s.description || '').slice(0, 80);
            contextHint += `  - /${s.name}${desc ? ' — ' + desc : ''}\n`;
          }
          contextHint += '调用语法: 用户说 "/技能名 ..." 或 你回复时建议 "/技能名 ..." 让用户主动触发.\n\n';
        }
      } catch (err) {
        // 静默失败 — skills 不是核心, 加载失败不阻塞
      }

      // 2026-06-10: 注入 human values 摘要 (最常用的 judgment / 价值偏好)
      // 与 judgment 不同: values 是更宏观的"用户偏好", judgment 是针对具体决策的约束
      try {
        const { loadAllJudgments } = await import('../pi-ecosystem-judgment/human-value-store.js');
        const allJudgments = await loadAllJudgments().catch(() => []);
        // 把所有 judgment 视作软参考 (跟 buildJudgmentHint 的 candidates 同理)
        if (Array.isArray(allJudgments) && allJudgments.length > 0) {
          contextHint += `[系统上下文] 用户的核心价值倾向 (来自 ${allJudgments.length} 条历史 judgment, 软参考, 体现而非复述):\n`;
          for (const j of allJudgments.slice(0, 8)) {
            const decision = (j.decision || '').slice(0, 80);
            contextHint += `  - ${decision}\n`;
          }
          contextHint += '\n';
        }
      } catch (err) {
        // 静默失败
      }

      // 2026-06-10: 注入 documents 列表 (本机 documents/ 目录的文档元数据)
      // 让 LLM 知道有文档存在, 用户可主动要求读
      try {
        const { documentStore } = await import('../documents/store.js');
        const docs = await documentStore.getReceivedDocuments(50).catch(() => []);
        if (Array.isArray(docs) && docs.length > 0) {
          contextHint += `[系统上下文] 本机 documents (${docs.length} 篇, 用户可让你读):\n`;
          for (const d of docs.slice(0, 10)) {
            const name = d.fileName || d.id || '(未命名)';
            const size = d.fileSize ? ` (${Math.round(d.fileSize / 1024)}KB)` : '';
            const sender = d.fromNodeId ? ` [来自 ${d.fromNodeIdShort || d.fromNodeId.substring(0,8)}…]` : '';
            contextHint += `  - ${name}${size}${sender}\n`;
          }
          contextHint += '用户提到某文档时, 你可以调用读文档工具读取并总结.\n\n';
        }
      } catch (err) {
        // 静默失败
      }

      // 2026-06-11: 注入此 channel 专属的 persona + 关联文档 (从 channel 字段读, LLM 长期记忆)
      const chPersona = channelForJudgment?.persona;
      if (chPersona && typeof chPersona === 'object') {
        contextHint += '[系统上下文] 此 channel 的人设 (你是这个角色):\n';
        if (chPersona.name) contextHint += `  名字: ${chPersona.name}\n`;
        if (chPersona.description) contextHint += `  描述: ${chPersona.description}\n`;
        if (chPersona.personality) contextHint += `  性格: ${chPersona.personality}\n`;
        if (chPersona.greeting) contextHint += `  问候: ${chPersona.greeting}\n`;
        if (Array.isArray(chPersona.capabilities) && chPersona.capabilities.length > 0) {
          contextHint += `  能力: ${chPersona.capabilities.join('、')}\n`;
        }
        if (Array.isArray(chPersona.interests) && chPersona.interests.length > 0) {
          contextHint += `  兴趣: ${chPersona.interests.join('、')}\n`;
        }
        contextHint += '回复时应自然体现这个角色 (不要硬搬原文, 像这个角色说话即可).\n\n';
      }
      const linkedIds = channelForJudgment?.linkedDocumentIds;
      if (Array.isArray(linkedIds) && linkedIds.length > 0) {
        try {
          const { documentStore } = await import('../documents/store.js');
          contextHint += `[系统上下文] 此 channel 关联了 ${linkedIds.length} 篇文档 (已自动加载内容, 你应基于它们回答):\n`;
          let loaded = 0;
          for (const docId of linkedIds.slice(0, 10)) {
            const doc = await documentStore.readDocument(docId).catch(() => null);
            if (!doc) continue;
            const name = doc.metadata?.fileName || docId;
            const content = (doc.content || '').slice(0, 1500);  // 单篇 1.5KB 上限, 总 prompt 防爆
            contextHint += `\n--- 文档: ${name} ---\n${content}\n--- 文档结束 ---\n`;
            loaded++;
          }
          if (loaded === 0) {
            contextHint += `(但加载失败, 文档可能已被删除)\n\n`;
          } else {
            contextHint += '\n';
          }
        } catch (err) {
          console.warn('[v3-persona] 加载关联文档失败 (非致命):', (err as Error).message);
        }
      }

      // v3 新增: 注入"可用渠道"目录, 让 LLM 知道可以 @-mention 哪些 channel
      // - 本地 channels (除了自己)
      // - 远端 channels (remoteChannelCache 缓存的)
      const localChannels = (await loadChannels()).filter(c => c.id !== channelId);
      const remoteChannels: any[] = [];
      for (const [peerPk, list] of remoteChannelCache.entries()) {
        for (const ch of list) {
          remoteChannels.push({ ...ch, _ownerPublicKey: peerPk });
        }
      }
      if (localChannels.length > 0 || remoteChannels.length > 0) {
        contextHint += '[系统上下文] 可用渠道 (你可以用 @渠道名 消息内容 给它们发消息):\n';
        for (const c of localChannels) {
          contextHint += `  - [本地] @${c.name} (id=${c.id})\n`;
        }
        for (const c of remoteChannels) {
          contextHint += `  - [远端, owner=${(c._ownerPublicKey || '').substring(0,8)}…] @${c.name} (id=${c.id})\n`;
        }
        contextHint += '语法: 当你想给其他渠道发消息, 在回复中写 "@渠道名 我要说的话" 即可. 消息会持久化到目标 channel 的 session, 你之后能看到"自己"在那里说的话.\n';
        // 2026-06-10 强化: 当用户消息里出现 @渠道名, 默认是请你代为转发, 务必在回复里包含对应的 @ 转发
        if (remoteChannels.length > 0) {
          contextHint += '重要: 上面列表里 [远端] 标记的 channel 在另一台机器上, 你可以像 @本地 channel 一样 @ 它们 — 我会通过 P2P 自动把消息送达对方智能体, 对方智能体的回复也会同步回来.\n';
          contextHint += '当用户在消息里 @ 了某个 (本地或远端) channel, 默认意图是希望你代为转发 — 你应该在回复中写出对应的 "@渠道名 转发内容", 否则用户的请求不会被路由出去.\n\n';
        } else {
          contextHint += '\n';
        }
      }

      if (contextHint) contextHint += '\n';
      try {
        fullResponse = await agent.promptStream(contextHint + text, streamCallback, runState.abortController?.signal, channelId);
      } catch (err: any) {
        // abort 抛错: 保留已输出的部分 (fullResponse 可能是空字符串)
        if (runState.abortController?.signal.aborted || err?.name === 'AbortError') {
          console.log(`[chat] aborted channel=${channelId}`);
        } else {
          throw err;
        }
      }
      // abort 模式: 给 partial 拼后缀
      if (runState.abortController?.signal.aborted && fullResponse.trim().length > 0) {
        fullResponse = fullResponse + '\n\n_[生成已中断]_';
      }

      // v3 新增: 解析 LLM 回复里的 @-mentions, 转发到目标 channel
      await routeMentionsInReply(channelId, fullResponse, localChannels, remoteChannels);

      broadcast({ type: 'ai', content: fullResponse }, channelId);

      const existingSession = await loadSession(channelId, currentSessionId);
      const session: Session = existingSession || { channelId, sessionId: currentSessionId, messages: [], lastUpdated: new Date().toISOString() };
      session.sessionId = currentSessionId;
      // v3: 加 source 标记 (local = 内部 owner, remote = 远端访客)
      session.messages.push({ id: crypto.randomUUID(), type: 'user' as const, content: text, timestamp: new Date().toISOString(), source: 'local' as any });
      session.messages.push({
        id: crypto.randomUUID(),
        type: 'ai' as const,
        content: fullResponse,
        timestamp: new Date().toISOString(),
        source: 'local' as any,
        // P0.5: 这条 AI 回复引用了哪些 judgment (注入门回传)
        ...(usedJudgmentIds.length > 0 ? { metadata: { usedJudgmentIds } } : {}),
      });
      session.lastUpdated = new Date().toISOString();
      await saveSession(session);

      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      // 2026-06-11: 移除 suggestRename 的二次 LLM 调用 — 之前每次用户发消息, 智能体 channel 都会再调一次 LLM (5-8s) 自动改名
      // 影响: (1) /message 端点被拖慢 5-8s (2) LLM 客户端排队, 其他 channel 跟着卡
      // 现在改名逻辑挪到 /api/agent-rename 端点, 用户主动触发才跑
      if (channel) {
        channel.updatedAt = new Date().toISOString();
        await saveChannels(channels);
      }

      broadcast({ type: 'done' }, channelId);

      // D 触发: AI 被动捕获判断力 (后台异步, 不阻塞主对话)
      setImmediate(() => {
        try {
          const lastTurns = session.messages.slice(-6).map((m) => ({
            role: (m.type === 'user' ? 'human' : 'agent') as 'human' | 'agent',
            content: m.content,
          }));
          if (lastTurns.length < 2) return;
          broadcast({ type: 'phase', phase: 'd_detect', detail: '监测对话...' }, channelId);
          import('../pi-ecosystem-judgment/human-value-pipeline.js')
            .then(async ({ detectAndDistillFromChannel, throttleDHook }) => {
              // channel 维度 5min 节流, 防对话卡顿时 LLM 反复触发
              if (!throttleDHook(channelId, 5 * 60_000)) {
                console.log(`[D-hook ${channelId}] throttled (within 5min)`);
                broadcast({ type: 'phase', phase: 'd_skip', detail: 'throttled' }, channelId);
                return null;
              }
              broadcast({ type: 'phase', phase: 'd_distill', detail: '蒸馏判断力...' }, channelId);
              return detectAndDistillFromChannel(lastTurns, { channelId });
            })
            .then((result) => {
              if (result && result.triggered) {
                console.log(
                  `[D-hook ${channelId}] stored: ${result.reason}`,
                  result.evolved
                );
                broadcast({ type: 'phase', phase: 'd_done', detail: result.reason }, channelId);
              } else if (result && result.reason) {
                console.log(`[D-hook ${channelId}] skipped: ${result.reason}`);
                broadcast({ type: 'phase', phase: 'd_skip', detail: result.reason }, channelId);
              }
            })
            .catch((err) => {
              console.warn(`[D-hook ${channelId}] failed:`, err);
              broadcast({ type: 'phase', phase: 'd_error', detail: String(err) }, channelId);
            });
        } catch (err) {
          console.warn(`[D-hook ${channelId}] sync error:`, err);
        }
      });

      // 2026-06-11: 202 已发的话, 不要重复 res.json (会抛 ERR_HTTP_HEADERS_SENT)
      if (!res.headersSent) res.json({ ok: true });
    } catch (err: any) {
      broadcast({ type: 'error', content: err.message }, channelId);
      broadcast({ type: 'done' }, channelId);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      // queue dequeue: 跑完或失败都要清状态
      // 当前实现: 自动接下一条需要把 ~200 行 try 块抽函数, 暂不抽.
      // 替代: 用户点 [队列 +N] 按钮时, 客户端发起一个特殊的 HTTP 请求触发下一条
      // (在 client.js 实现). 这里只清状态 + 广播.
      runState.running = false;
      runState.abortController = null;
      broadcastQueueUpdate(channelId);
    }
  });

  // ---------- 频道元数据后台修复队列 ----------
  // 关键点: 旧实现会在每次 GET /channels 时同步执行 KeyManager.generate() + IPFS POST,
  // 多频道场景下持续分配密钥对 + 发起 HTTP 请求, 几轮就会把 Node 内存撑爆。
  // 新实现: 入队 + 节流(2s) + 单飞, 立刻返回当前 channels, 修复异步进行。
  const didFixQueue = new Set<string>(); // 待修复的 channelId
  let didFixRunning = false;
  let didFixTimer: NodeJS.Timeout | null = null;

  // ---------- per-channel 消息 queue + abort 状态 ----------
  // 同 channel 串行 (避免 LLM 调用互踩上下文), 跨 channel 互不干扰
  interface PendingMessage {
    channelId: string;
    text: string;
    boundWalletAddress?: string;
    autoToolsEnabled?: boolean;
    // (req, res 已经在 /message 里 res.status(202) 返回, 入队的只是要重跑的内容参数)
  }
  interface ChannelRunState {
    running: boolean;
    queue: PendingMessage[];
    abortController: AbortController | null;
  }
  const channelRunState: Map<string, ChannelRunState> = new Map();
  function getOrCreateRunState(channelId: string): ChannelRunState {
    let s = channelRunState.get(channelId);
    if (!s) {
      s = { running: false, queue: [], abortController: null };
      channelRunState.set(channelId, s);
    }
    return s;
  }
  function broadcastQueueUpdate(channelId: string): void {
    const s = channelRunState.get(channelId);
    const queueLength = s ? s.queue.length : 0;
    const running = s ? s.running : false;
    try { broadcast({ type: 'queue_update', channelId, queueLength, running }, channelId); } catch { /* */ }
  }

  function scheduleDidFix(channelId: string) {
    didFixQueue.add(channelId);
    if (didFixTimer) return;
    didFixTimer = setTimeout(() => {
      didFixTimer = null;
      void runDidFixOnce();
    }, 2000);
  }

  async function runDidFixOnce(): Promise<void> {
    if (didFixRunning) return;
    didFixRunning = true;
    try {
      while (didFixQueue.size > 0) {
        const id = didFixQueue.values().next().value as string;
        didFixQueue.delete(id);
        try {
          await fixOneChannelDID(id);
        } catch (e) {
          console.log(`[DID 修复] ${id} 失败: ${(e as Error).message}`);
        }
      }
    } finally {
      didFixRunning = false;
    }
  }

  async function fixOneChannelDID(channelId: string): Promise<void> {
    const channels = await loadChannels();
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return;
    const didMissing = !channel.did || channel.did === 'undefined' || channel.did === 'null' || channel.did === '';
    if (!didMissing) return;

    let kp: any;
    try {
      kp = KeyManager.generate();
    } catch {
      kp = null;
    }
    if (kp && kp.did) {
      channel.did = kp.did;
      channel.publicKey = Buffer.from(kp.publicKey).toString('hex');
    } else {
      // 兜底: 用 channelId 派生, 不阻塞 UI
      channel.did = `did:web:${channel.id}`;
      channel.publicKey = `pk_${channel.id}`;
    }
    console.log(`[DID 修复] ${channel.name} DID = ${channel.did}`);

    // IPFS 注册: 失败也无所谓, 后续可重试
    try {
      const auth = await AgentAuthManager.newWithRemoteIpfs('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
      const result = await auth.registerAgent({ name: channel.name, services: [] }, kp, '');
      channel.cid = result.cid || channel.cid;
      // 关键: 不再保存整份 didDocument, 只留 cid/ipnsName 两个引用字段
      if (result.didDocument) {
        channel.didDocRef = {
          cid: result.cid,
          ipnsName: (result.didDocument as any)?.ipnsName
        };
        delete (channel as any).didDocument;
      }
    } catch {
      // IPFS 不可用, 跳过 — 下次再试
    }
    await saveChannels(channels);
  }

  // 频道列表响应缓存: 短时间内重复请求走缓存, 避免每次重读 + 重序列化 channels.json
  // 跨作用域 (saveChannels 在模块顶层, 本函数在 createWebServer 内) 用 lastChannelsWriteAt 协调失效
  const channelsCache = { data: null as Channel[] | null, cachedAt: 0 };
  const CHANNELS_CACHE_TTL_MS = 500;

  /** 获取频道列表 — 立即返回, 缺 DID 的频道入队后台修复 */
  async function getChannelsWithDID(): Promise<Channel[]> {
    const now = Date.now();
    // 缓存命中: 数据有效 AND 在写盘之后 AND 在 TTL 内
    if (channelsCache.data && channelsCache.cachedAt > lastChannelsWriteAt && channelsCache.cachedAt + CHANNELS_CACHE_TTL_MS > now) {
      return channelsCache.data;
    }
    const channels = await loadChannels();
    // 防御性剥除: 任何旧 channels.json 残留的 didDocument 都不返回给客户端
    const sanitized = channels.map(ch => {
      const { didDocument: _omit, ...rest } = ch as any;
      return rest as Channel;
    });
    for (const channel of sanitized) {
      const didMissing = !channel.did || channel.did === 'undefined' || channel.did === 'null' || channel.did === '';
      if (didMissing) {
        scheduleDidFix(channel.id);
      }
    }
    channelsCache.data = sanitized;
    channelsCache.cachedAt = now;
    return sanitized;
  }

app.get('/channels', async (_req, res) => {
  try {
    console.log('[API] /channels 被调用');
    const channels = await getChannelsWithDID();
    console.log('[获取频道] 返回', channels.length, '个');
    channels.forEach((ch, i) => {
      console.log(`  [${i}] ${ch.name} - did: ${ch.did || '无'} - cid: ${ch.cid || '无'}`);
    });
    res.json(channels);
  } catch (err: any) {
    console.error('[API] /channels 错误:', err);
    res.status(500).json({ error: err.message });
  }
});

  // v3: 列出本节点缓存的远端 channel (按 peerId 分组)
  app.get('/api/remote-channels', async (_req, res) => {
    try {
      const out: Array<{ peerId: string; channels: Array<Record<string, unknown>>; peerName?: string }> = [];
      // 2026-06-11: 合并 known_peers + cache, 避免 cache 空时 UI 一个 peer 都看不到
      // (cache 是纯内存, 重启即丢; known_peers 持久化, 至少能让 UI 显示"这些 peer 我认识")
      const { listPeers } = await import('../network/known-peers.js');
      const knownPeers = await listPeers();
      const knownByPk = new Map<string, { name?: string }>();
      for (const p of knownPeers) knownByPk.set(p.publicKey, { name: p.name });
      for (const [peerId, list] of remoteChannelCache.entries()) {
        out.push({ peerId, channels: list, peerName: knownByPk.get(peerId)?.name });
      }
      // known_peers 里但 cache 没的, 占位推进 out (channels=[]) 让 UI 能渲染 peer header
      for (const [peerId, info] of knownByPk.entries()) {
        if (!remoteChannelCache.has(peerId)) {
          out.push({ peerId, channels: [], peerName: info.name });
        }
      }
      res.json({ count: out.length, peers: out });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3 测试专用: 直接注入远端频道缓存 (绕过 P2P)
  // 仅当 NODE_ENV=test 时可用
  app.post('/api/test/inject-remote-channel', async (req, res) => {
    if (process.env.NODE_ENV !== 'test') {
      return res.status(403).json({ error: 'only available in test mode' });
    }
    try {
      const { peerPublicKey, channel } = req.body || {};
      if (!peerPublicKey || !channel) {
        return res.status(400).json({ error: 'peerPublicKey and channel required' });
      }
      const list = remoteChannelCache.get(peerPublicKey) || [];
      list.push(channel);
      remoteChannelCache.set(peerPublicKey, list);
      broadcast({ type: 'remote-channel-update', peerId: peerPublicKey, channels: list }, 'p2p-global');
      res.json({ ok: true, count: list.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3: 主动向所有已连接 P2P peer 拉 channel 列表
  // 用法: B 端用户点 "刷新远端智能体" → 触发本 endpoint
  app.post('/api/remote-channels/refresh', async (_req, res) => {
    try {
      // Phase 3: 优先用 P2PDirect conns (Phase 2/3 的真实通道)
      if (v3P2PRef) {
        const conns = (v3P2PRef as any).conns as Map<string, any>;
        const peerIds = Array.from(conns.keys()).filter(pk => {
          const c = conns.get(pk);
          return c && !c.destroyed;
        });
        if (peerIds.length === 0) {
          return res.json({ ok: true, sent: 0, note: 'no connected peers (P2PDirect)' });
        }
        // 让每个 peer 拉 list — Phase 3 个性化分享过滤
        let sent = 0;
        for (const peerPk of peerIds) {
          const ok = await (v3P2PRef as any).sendTo(peerPk, JSON.stringify({ v: 3, op: 'agent.meta.list', payload: {} }));
          if (ok) sent++;
        }
        return res.json({ ok: true, sent, total: peerIds.length });
      }
      // Fallback: 老 iroh 路径
      const peers = irohTransport.getPeers ? irohTransport.getPeers() : [];
      const peerIds = Array.isArray(peers) ? peers.map((p: any) => p.nodeId || p) : [];
      if (peerIds.length === 0) {
        return res.json({ ok: true, sent: 0, note: 'no connected peers' });
      }
      let sent = 0;
      for (const peerId of peerIds) {
        const ok = await irohTransport.sendMessage(
          peerId,
          'agent.meta.list',
          new TextEncoder().encode('{}')
        );
        if (ok) sent++;
      }
      res.json({ ok: true, sent, total: peerIds.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== v3: 主动 connect 到对端, 再发 agent.meta.list =====
  // 用法: POST /api/remote-channels/connect { targetAddr: "<完整 EndpointAddr 含 relay URL>" }
  // targetAddr 应来自对端 GET /api/iroh-addr (完整字符串, 不只是 nodeId)
  // 兼容旧用法: 也接受 targetNodeId, 但只有 nodeId 不一定能 connect 成功
  app.post('/api/remote-channels/connect', async (req, res) => {
    try {
      const { targetAddr, targetNodeId } = req.body || {};
      const target = targetAddr || targetNodeId;
      if (!target || typeof target !== 'string') {
        return res.status(400).json({ error: 'targetAddr (or targetNodeId) required' });
      }
      console.log(`[v3] 主动 connect 到 ${target.substring(0, 32)}...`);
      // iroh connect 接受 nodeId 或完整 addr 字符串 — 用完整 addr 才会成功
      const ok = await irohTransport.connect(target);
      if (!ok) {
        return res.status(502).json({
          error: 'connect failed',
          hint: '传 targetAddr (完整 EndpointAddr 字符串, 含 relay URL) 而非仅 nodeId'
        });
      }
      // 立即发 agent.meta.list 请求对端返回元数据
      const sent = await irohTransport.sendMessage(
        target,
        'agent.meta.list',
        new TextEncoder().encode('{}')
      );
      console.log(`[v3] connect+list 发送结果: connect=ok, list=${sent}`);
      res.json({ ok: true, connected: true, sent, target });
    } catch (err: any) {
      console.error('[v3] /api/remote-channels/connect 失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/channels', async (req, res) => {
    try {
      const { name, agentId, walletAddress, autoInvokeTools, bound_judgment_ids, personaOverride, linkedDocumentIds } = req.body;
      console.log(`[创建频道] 收到请求: name=${name}, agentId=${agentId}, wallet=${walletAddress ? 'yes' : 'no'}, boundJudgments=${Array.isArray(bound_judgment_ids) ? bound_judgment_ids.length : 0}`);
      if (!name || !agentId) {
        return res.status(400).json({ error: 'name and agentId required' });
      }
      const channels = await loadChannels();
      const id = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      // 校验钱包地址格式 (粗校验: 0x + 40 hex / Solana base58 / Sui 0x+64)
      const validWallet = isValidWalletAddress(walletAddress);

      // 过滤 bound_judgment_ids: 只保留 string
      const safeBoundIds = Array.isArray(bound_judgment_ids)
        ? bound_judgment_ids.filter((x: unknown) => typeof x === 'string' && (x as string).length > 0)
        : [];

      // 2026-06-11: persona 加载 — 优先用 personaOverride, 否则从 ~/.bolloon/persona.json 读全局默认
      let channelPersona: Channel['persona'];
      if (personaOverride && typeof personaOverride === 'object') {
        channelPersona = {
          name: personaOverride.name,
          description: personaOverride.description,
          personality: personaOverride.personality,
          greeting: personaOverride.greeting,
          capabilities: Array.isArray(personaOverride.capabilities) ? personaOverride.capabilities.slice(0, 20) : undefined,
          interests: Array.isArray(personaOverride.interests) ? personaOverride.interests.slice(0, 20) : undefined,
        };
      } else {
        try {
          const { readFileSync, existsSync } = await import('fs');
          const personaPath = `${process.env.HOME || '/tmp'}/.bolloon/persona.json`;
          if (existsSync(personaPath)) {
            const p = JSON.parse(readFileSync(personaPath, 'utf-8'));
            channelPersona = {
              name: p.name,
              description: p.description,
              personality: p.personality,
              greeting: p.greeting,
              capabilities: Array.isArray(p.capabilities) ? p.capabilities.slice(0, 20) : undefined,
              interests: Array.isArray(p.interests) ? p.interests.slice(0, 20) : undefined,
            };
          }
        } catch (err) {
          console.warn('[创建频道] 加载 persona.json 失败 (非致命):', (err as Error).message);
        }
      }

      // 过滤 linkedDocumentIds: 只保留 string
      const safeLinkedDocIds = Array.isArray(linkedDocumentIds)
        ? linkedDocumentIds.filter((x: unknown) => typeof x === 'string' && (x as string).length > 0).slice(0, 50)
        : [];

      // 先创建频道（不阻塞等待 DID 生成）
      const channel: Channel = {
        id,
        name,
        agentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentSessionId: `sess_${Date.now()}`,
        walletAddress: validWallet || undefined,
        walletRegisteredAt: validWallet ? new Date().toISOString() : undefined,
        autoInvokeTools: autoInvokeTools !== false, // 默认 true
        bound_judgment_ids: safeBoundIds,
        persona: channelPersona,
        linkedDocumentIds: safeLinkedDocIds,
        sessions: [{
          id: `sess_${Date.now()}`,
          createdAt: new Date().toISOString(),
          messageCount: 0,
          preview: ''
        }]
      };

      console.log(`[创建频道] 先保存频道 ID: ${id}`);
      channels.push(channel);
      await saveChannels(channels);
      await saveSession({ channelId: id, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString() });
      res.json(channel);

      // 后台生成 DID — 用统一的修复队列, 避免每个 POST 都启动独立 setTimeout
      console.log(`[创建频道] 加入 DID 修复队列...`);
      scheduleDidFix(id);
    } catch (err: any) {
      console.error('[创建频道] 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 创建新 Session（在现有 Channel 下）
  app.post('/channels/:channelId/sessions', async (req, res) => {
    try {
      const { channelId } = req.params;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      const sessionId = `sess_${Date.now()}`;
      const session: SessionSummary = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        messageCount: 0,
        preview: ''
      };

      if (!channel.sessions) {
        channel.sessions = [];
      }
      channel.sessions.push(session);
      channel.currentSessionId = sessionId;
      channel.updatedAt = new Date().toISOString();

      await saveChannels(channels);
      await saveSession({ channelId, sessionId, messages: [], lastUpdated: new Date().toISOString() });

      res.json({ session, currentSessionId: sessionId });
    } catch (err: any) {
      console.error('[创建Session] 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 获取 Channel 下的所有 Sessions
  app.get('/channels/:channelId/sessions', async (req, res) => {
    try {
      const { channelId } = req.params;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      res.json({
        sessions: channel.sessions || [],
        currentSessionId: channel.currentSessionId
      });
    } catch (err: any) {
      console.error('[获取Sessions] 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 切换 Session
  app.post('/channels/:channelId/sessions/:sessionId/switch', async (req, res) => {
    try {
      const { channelId, sessionId } = req.params;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      channel.currentSessionId = sessionId;
      channel.updatedAt = new Date().toISOString();
      await saveChannels(channels);

      res.json({ ok: true, currentSessionId: sessionId });
    } catch (err: any) {
      console.error('[切换Session] 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 删除单个 Session
  app.delete('/channels/:channelId/sessions/:sessionId', async (req, res) => {
    try {
      const { channelId, sessionId } = req.params;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      // 不允许删除最后一个 session —— 至少要保留一个
      if (!channel.sessions || channel.sessions.length <= 1) {
        return res.status(400).json({ error: 'At least one session is required' });
      }

      const sessionIndex = channel.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex === -1) {
        return res.status(404).json({ error: 'Session not found' });
      }

      channel.sessions.splice(sessionIndex, 1);

      // 如果删除的是当前 session，切换到列表里的第一个
      if (channel.currentSessionId === sessionId) {
        const nextSession = channel.sessions[0];
        channel.currentSessionId = nextSession.id;
      }

      channel.updatedAt = new Date().toISOString();
      await saveChannels(channels);

      // 删除 session 文件
      try {
        await fs.unlink(path.join(SESSION_CACHE_PATH, `${channelId}:${sessionId}.json`));
      } catch {}

      res.json({ ok: true, currentSessionId: channel.currentSessionId });
    } catch (err: any) {
      console.error('[删除Session] 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/channels/:channelId', async (req, res) => {
    try {
      const { channelId } = req.params;
      const channels = await loadChannels();
      const index = channels.findIndex(c => c.id === channelId);
      if (index === -1) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      const channel = channels[index];
      channels.splice(index, 1);
      await saveChannels(channels);

      // 清理该 channel 名下所有的 session 文件 + 默认 session 文件
      const candidates = new Set<string>([`${channelId}.json`]);
      if (channel.sessions) {
        channel.sessions.forEach(s => candidates.add(`${channelId}:${s.id}.json`));
      }
      for (const filename of candidates) {
        try {
          await fs.unlink(path.join(SESSION_CACHE_PATH, filename));
        } catch {}
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/channels/:channelId', async (req, res) => {
    try {
      const { channelId } = req.params;
      const { name, walletAddress, autoInvokeTools, bound_judgment_ids, shared_with_peers, persona, linkedDocumentIds } = req.body;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (typeof name === 'string' && name.trim()) {
        channel.name = name.trim();
      }
      // 2026-06-11: 改 persona (允许 null 重置回全局默认)
      if (persona !== undefined) {
        if (persona === null) {
          channel.persona = undefined;
        } else if (typeof persona === 'object') {
          channel.persona = {
            name: persona.name,
            description: persona.description,
            personality: persona.personality,
            greeting: persona.greeting,
            capabilities: Array.isArray(persona.capabilities) ? persona.capabilities.slice(0, 20) : channel.persona?.capabilities,
            interests: Array.isArray(persona.interests) ? persona.interests.slice(0, 20) : channel.persona?.interests,
          };
        }
      }
      // 2026-06-11: 改关联文档列表 (数组整体替换, 空数组 = 解绑所有)
      if (Array.isArray(linkedDocumentIds)) {
        channel.linkedDocumentIds = linkedDocumentIds.filter((x: unknown) => typeof x === 'string' && (x as string).length > 0).slice(0, 50);
      }
      // walletAddress 允许 null/'' 来解绑
      if (walletAddress !== undefined) {
        if (walletAddress === null || walletAddress === '') {
          channel.walletAddress = undefined;
          channel.walletRegisteredAt = undefined;
        } else {
          const valid = isValidWalletAddress(walletAddress);
          if (!valid) {
            return res.status(400).json({ error: 'Invalid wallet address format' });
          }
          channel.walletAddress = valid;
          channel.walletRegisteredAt = channel.walletRegisteredAt || new Date().toISOString();
        }
      }
      if (typeof autoInvokeTools === 'boolean') {
        channel.autoInvokeTools = autoInvokeTools;
      }
      // bound_judgment_ids: 允许数组(替换)/null(清空)/undefined(不改)
      if (bound_judgment_ids !== undefined) {
        if (bound_judgment_ids === null) {
          channel.bound_judgment_ids = [];
        } else if (Array.isArray(bound_judgment_ids)) {
          channel.bound_judgment_ids = bound_judgment_ids.filter(
            (x: unknown) => typeof x === 'string' && (x as string).length > 0
          );
        } else {
          return res.status(400).json({ error: 'bound_judgment_ids must be array or null' });
        }
        console.log(`[Channel ${channelId}] 绑定判断力: ${channel.bound_judgment_ids.length} 条`);
      }
      // Phase 3: shared_with_peers (显式分享给指定 peerPublicKey 列表)
      if (shared_with_peers !== undefined) {
        if (shared_with_peers === null) {
          channel.shared_with_peers = [];
        } else if (Array.isArray(shared_with_peers)) {
          channel.shared_with_peers = shared_with_peers.filter(
            (x: unknown) => typeof x === 'string' && (x as string).length === 64  // iroh/hyperswarm pubkey 32 字节 = 64 hex
          );
        } else {
          return res.status(400).json({ error: 'shared_with_peers must be array of publicKey hex' });
        }
        console.log(`[Channel ${channelId}] 分享给 ${channel.shared_with_peers.length} 个 peer`);
      }
      // 首次保存时自动生成 share_id (短字符串, 方便粘贴)
      if (!channel.share_id) {
        channel.share_id = `shr_${channelId.slice(3, 12)}_${Math.random().toString(36).substring(2, 8)}`;
        console.log(`[Channel ${channelId}] 自动生成 share_id: ${channel.share_id}`);
      }
      channel.updatedAt = new Date().toISOString();
      await saveChannels(channels);
      // v3 修复: 分享变更后立即广播给所有 peer, 不用等对方手动刷新
      if (shared_with_peers !== undefined) {
        v3BroadcastOwn().catch(err => console.error('[v3] broadcast after share update failed:', err));
      }
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 钱包 DID 绑定: 客户端用钱包私钥对 (channelId + DID) 做 EIP-191 personal_sign,
   * 服务端用 viem.verifyMessage 校验签名恢复出地址, 校验一致才落盘
   * body: { walletAddress, signature, message, did, autoInvokeTools? }
   */
  app.post('/channels/:channelId/bind-wallet', async (req, res) => {
    try {
      const { channelId } = req.params;
      const { walletAddress, signature, message, did, autoInvokeTools } = req.body || {};
      if (!walletAddress || !signature || !message || !did) {
        return res.status(400).json({ error: '缺少必填字段: walletAddress, signature, message, did' });
      }
      if (!isAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid wallet address format' });
      }
      // 防 message 重放: 必须包含本次 channelId + did
      if (!message.includes(`Channel ID: ${channelId}`) || !message.includes(`Agent DID: ${did}`)) {
        return res.status(400).json({ error: 'Challenge message does not match channelId/did' });
      }
      // viem 校验签名: recoverMessage 返回签名地址 (EIP-191 personal_sign)
      const recovered = await verifyMessage({
        address: getAddress(walletAddress),
        message,
        signature,
      }).catch(() => false);
      if (!recovered) {
        return res.status(400).json({ error: '签名验证失败, 钱包私钥与地址不匹配或 message 被篡改' });
      }
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      // 签名里写的 DID 必须 = 当前 channel 的 DID (防绑定到旧 DID)
      if (channel.did && channel.did !== did) {
        return res.status(400).json({
          error: `签名 DID (${did}) 与当前 channel DID (${channel.did}) 不一致`,
        });
      }
      channel.walletAddress = getAddress(walletAddress);
      channel.walletRegisteredAt = channel.walletRegisteredAt || new Date().toISOString();
      channel.walletBinding = {
        address: channel.walletAddress,
        signature,
        message,
        did,
        signedAt: new Date().toISOString(),
      };
      if (typeof autoInvokeTools === 'boolean') {
        channel.autoInvokeTools = autoInvokeTools;
      }
      channel.updatedAt = new Date().toISOString();
      await saveChannels(channels);
      console.log(`[Wallet] channel ${channelId} 绑定钱包 ${channel.walletAddress} 到 DID ${did}`);
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/sessions/:channelId', async (req, res) => {
    try {
      const session = await loadSession(req.params.channelId, req.query.sessionId as string | undefined);
      res.json(session || { channelId: req.params.channelId, sessionId: req.query.sessionId || 'default', messages: [], lastUpdated: null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 增量追加消息到 session (前端落盘用, 避免丢消息)
  // body: { message: { type, content, timestamp? } }
  app.patch('/sessions/:channelId/:sessionId', async (req, res) => {
    try {
      const { channelId, sessionId } = req.params;
      const { message } = req.body || {};
      if (!message || (message.type !== 'user' && message.type !== 'ai') || typeof message.content !== 'string') {
        return res.status(400).json({ error: 'invalid message' });
      }
      const existing = await loadSession(channelId, sessionId);
      const session: Session = existing || { channelId, sessionId, messages: [], lastUpdated: new Date().toISOString() };
      session.sessionId = sessionId;
      // 去重: 跳过与最后一条完全相同的 (避免 SSE 重复推导致双写)
      const last = session.messages[session.messages.length - 1];
      if (last && last.type === message.type && last.content === message.content) {
        return res.json({ ok: true, count: session.messages.length, deduped: true });
      }
      session.messages.push({
        id: message.id || crypto.randomUUID(),
        type: message.type,
        content: message.content,
        timestamp: message.timestamp || new Date().toISOString()
      });
      session.lastUpdated = new Date().toISOString();
      await saveSession(session);
      res.json({ ok: true, count: session.messages.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/theme', async (req, res) => {
    try {
      const themeData = await loadTheme();
      res.json(themeData);
    } catch (err: any) {
      res.json({ theme: 'light', agentId: '' });
    }
  });

  app.post('/theme', async (req, res) => {
    try {
      const { theme, agentId } = req.body;
      if (theme !== 'light' && theme !== 'dark') {
        return res.status(400).json({ error: 'Invalid theme' });
      }
      await saveTheme(theme, agentId || '');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 重新生成回复
  app.post('/regenerate', async (req, res) => {
    const { channelId, userMessage } = req.body;
    if (!channelId) {
      return res.status(400).json({ error: 'No channelId provided' });
    }
    if (!userMessage) {
      return res.status(400).json({ error: 'No userMessage provided' });
    }

    try {
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      const currentSessionId = channel?.currentSessionId || 'default';
      const realChannelDid = channel?.did || '';
      const realChannelName = channel?.name || '';
      const realChannelDidDoc = channel?.didDocRef;

      // 通知前端开始重新生成
      broadcast({ type: 'regenerating', channelId }, channelId);

      const agent = await getAgentForChannel(channelId, realChannelDid, realChannelName, realChannelDidDoc);
      let fullResponse = '';
      let usedJudgmentIds: string[] = [];

      const streamCallback: StreamCallback = (event: StreamEvent) => {
        // P0.5: 注入门回传
        if ((event as any).type === 'used_judgments' && Array.isArray((event as any).usedIds)) {
          usedJudgmentIds = (event as any).usedIds;
          return;
        }
        if (event.type === 'token' || event.type === 'thinking') {
          broadcast({ type: 'stream', streamType: event.type, content: event.content }, channelId);
        } else if (event.type === 'status' || event.type === 'tool') {
          broadcast({ type: 'status', tool: event.tool, content: event.content }, channelId);
        } else if (event.type === 'step_start' || event.type === 'step_done' || event.type === 'step_error') {
          // 2026-06-15: 步骤状态机事件 — 原样转发
          broadcast({
            type: event.type,
            tool: event.tool,
            content: event.content,
            success: event.success,
            output: event.output,
            error: event.error,
            args: event.args,
          }, channelId);
        } else if (event.type === 'error') {
          broadcast({ type: 'error', content: event.content }, channelId);
        }
      };

      // 重新生成时只发送用户消息 (v3: 同时注入 channel 绑定的判断力)
      const regenHint = await buildJudgmentHint(channel, channelId);
      fullResponse = await agent.promptStream(regenHint + userMessage, streamCallback, undefined, channelId);

      broadcast({ type: 'ai', content: fullResponse }, channelId);

      // 更新 session
      const existingSession = await loadSession(channelId, currentSessionId);
      if (existingSession && existingSession.messages.length > 0) {
        // 移除最后一个 AI 消息，替换为新的
        const lastAiIndex = existingSession.messages.map((m: any) => m.type).lastIndexOf('ai');
        if (lastAiIndex !== -1) {
          existingSession.messages = existingSession.messages.slice(0, lastAiIndex);
        }
        existingSession.messages.push({
          id: crypto.randomUUID(),
          type: 'ai' as const,
          content: fullResponse,
          timestamp: new Date().toISOString(),
          ...(usedJudgmentIds.length > 0 ? { metadata: { usedJudgmentIds } } : {}),
        });
        existingSession.lastUpdated = new Date().toISOString();
        await saveSession(existingSession);
      }

      broadcast({ type: 'done' }, channelId);
      res.json({ ok: true });
    } catch (err: any) {
      broadcast({ type: 'error', content: err.message }, channelId);
      broadcast({ type: 'done' }, channelId);
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== Task Queue API ====================

  // 获取所有任务
  app.get('/api/tasks', async (req, res) => {
    try {
      const tasks = await loadTaskQueue();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建新任务
  app.post('/api/tasks', async (req, res) => {
    try {
      const { type, title, description, steps } = req.body;
      if (!type || !title) {
        return res.status(400).json({ error: 'type and title required' });
      }

      const tasks = await loadTaskQueue();
      const task: Task = {
        id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type,
        title,
        description,
        status: 'pending',
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: steps?.map((s: string, i: number) => ({
          id: `step_${i}`,
          name: s,
          status: 'pending'
        }))
      };

      tasks.push(task);
      await saveTaskQueue(tasks);

      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取单个任务
  app.get('/api/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新任务
  app.patch('/api/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { status, currentStep } = req.body;
      const tasks = await loadTaskQueue();
      const taskIndex = tasks.findIndex(t => t.id === taskId);
      if (taskIndex === -1) {
        return res.status(404).json({ error: 'Task not found' });
      }

      if (status) {
        tasks[taskIndex].status = status;
      }
      if (currentStep !== undefined) {
        tasks[taskIndex].currentStep = currentStep;
      }
      tasks[taskIndex].updatedAt = new Date().toISOString();

      await saveTaskQueue(tasks);
      res.json(tasks[taskIndex]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除任务
  app.delete('/api/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const tasks = await loadTaskQueue();
      const filtered = tasks.filter(t => t.id !== taskId);
      await saveTaskQueue(filtered);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 执行任务（自动执行下一步）
  app.post('/api/tasks/:taskId/execute', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { channelId } = req.body;
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }

      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      if (isExecutingTask) {
        return res.status(409).json({ error: 'Another task is currently executing' });
      }

      // 异步执行任务
      executeTask(task, channelId);

      res.json({ ok: true, taskId: task.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 执行下一个待处理任务
  app.post('/api/tasks/execute-next', async (req, res) => {
    try {
      const { channelId } = req.body;
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }

      const tasks = await loadTaskQueue();
      const nextTask = tasks.find(t => t.status === 'pending');

      if (!nextTask) {
        return res.json({ ok: false, message: 'No pending tasks' });
      }

      if (isExecutingTask) {
        return res.status(409).json({ error: 'Another task is currently executing' });
      }

      // 异步执行任务
      executeTask(nextTask, channelId);

      res.json({ ok: true, taskId: nextTask.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建并执行工作流
  app.post('/api/workflow', async (req, res) => {
    try {
      const { channelId, title, steps } = req.body;
      if (!channelId || !steps || !Array.isArray(steps)) {
        return res.status(400).json({ error: 'channelId and steps required' });
      }

      const tasks = await loadTaskQueue();
      const task: Task = {
        id: `wf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type: 'workflow',
        title: title || '工作流',
        description: `包含 ${steps.length} 个步骤的工作流`,
        status: 'pending',
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: steps.map((s: string, i: number) => ({
          id: `step_${i}`,
          name: s,
          status: 'pending'
        })),
        currentStep: 0
      };

      tasks.push(task);
      await saveTaskQueue(tasks);

      // 自动开始执行
      if (!isExecutingTask) {
        executeTask(task, channelId);
      }

      res.json({ ok: true, task });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== LLM 配置 API ====================

  // 获取所有 LLM 配置
  app.get('/api/llm-config', async (req, res) => {
    try {
      const config = await llmConfigStore.getConfig();
      const providerInfo = llmConfigStore.getAllProviderInfo();

      // 隐藏 API Key
      const safeConfig = {
        ...config,
        providers: Object.fromEntries(
          Object.entries(config.providers).map(([key, val]) => [
            key,
            { ...val, apiKey: val.apiKey ? '***' + val.apiKey.slice(-4) : '' }
          ])
        ),
        providerInfo
      };

      res.json(safeConfig);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新 LLM 配置
  app.post('/api/llm-config', async (req, res) => {
    try {
      const { provider, config } = req.body;

      if (!provider || !config) {
        return res.status(400).json({ error: 'provider and config required' });
      }

      // 如果前端发的是掩码（***xxx），从当前配置里取真实 key
      const currentConfig = await llmConfigStore.getProvider(provider as ModelProvider);
      if (currentConfig && config.apiKey && config.apiKey.startsWith('***')) {
        config.apiKey = currentConfig.apiKey;
      }

      await llmConfigStore.updateProvider(provider, config);

      // 如果是活跃供应商，重新初始化 Pi SDK
      const currentActive = await llmConfigStore.getActiveProvider();
      if (provider === currentActive) {
        const newConfig = await llmConfigStore.getActiveProviderConfig();
        if (newConfig) {
          initMinimax({
            provider,
            apiKey: newConfig.apiKey || undefined,
            baseUrl: newConfig.baseUrl || undefined,
            model: newConfig.model || undefined
          });
        }
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 设置活跃供应商
  app.post('/api/llm-provider', async (req, res) => {
    try {
      const { provider } = req.body;

      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      await llmConfigStore.setActiveProvider(provider as ModelProvider);

      // 重新初始化 Pi SDK
      const config = await llmConfigStore.getActiveProviderConfig();
      if (config) {
        initMinimax({
          provider: provider as ModelProvider,
          apiKey: config.apiKey || undefined,
          baseUrl: config.baseUrl || undefined,
          model: config.model || undefined
        });
      }

      res.json({ ok: true, provider });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 测试供应商连接
  app.post('/api/llm-test', async (req, res) => {
    try {
      const { provider } = req.body;

      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      const result = await llmConfigStore.testProvider(provider as ModelProvider);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== 视频生成配置 (Seedance 等) ====================

  // 获取视频生成配置
  app.get('/api/video-config', async (req, res) => {
    try {
      const config = await videoConfigStore.getConfig();
      const providerInfo = videoConfigStore.getAllProviderInfo();

      // 脱敏：不返回 apiKey 明文
      const masked = Object.fromEntries(
        Object.entries(config.providers).map(([key, val]) => [
          key,
          { ...val, apiKey: val.apiKey ? '***' + val.apiKey.slice(-4) : '' }
        ])
      );

      res.json({
        activeProvider: config.activeProvider,
        providers: masked,
        providerInfo
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新视频供应商配置
  app.post('/api/video-config', async (req, res) => {
    try {
      const { provider, config } = req.body;

      if (!provider || !config) {
        return res.status(400).json({ error: 'provider and config required' });
      }

      // 如果前端发的是掩码（***xxx），从当前配置里取真实 key
      const currentConfig = await videoConfigStore.getProvider(provider as VideoProvider);
      if (currentConfig && config.apiKey && config.apiKey.startsWith('***')) {
        config.apiKey = currentConfig.apiKey;
      }

      await videoConfigStore.updateProvider(provider as VideoProvider, config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 测试视频供应商连接
  app.post('/api/video-test', async (req, res) => {
    try {
      const { provider } = req.body;

      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      const result = await videoConfigStore.testProvider(provider as VideoProvider);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== 音频生成配置 (TTS / Music) ====================

  // 获取音频配置
  app.get('/api/audio-config', async (req, res) => {
    try {
      const config = await audioConfigStore.getConfig();
      const providerInfo = audioConfigStore.getAllProviderInfo();

      const masked = Object.fromEntries(
        Object.entries(config.providers).map(([key, val]) => [
          key,
          { ...val, apiKey: val.apiKey ? '***' + val.apiKey.slice(-4) : '' }
        ])
      );

      res.json({
        activeProvider: config.activeProvider,
        providers: masked,
        providerInfo
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新音频供应商配置
  app.post('/api/audio-config', async (req, res) => {
    try {
      const { provider, config } = req.body;
      if (!provider || !config) {
        return res.status(400).json({ error: 'provider and config required' });
      }

      // 掩码回写真实 key
      const currentConfig = await audioConfigStore.getProvider(provider as AudioProvider);
      if (currentConfig && config.apiKey && config.apiKey.startsWith('***')) {
        config.apiKey = currentConfig.apiKey;
      }

      await audioConfigStore.updateProvider(provider as AudioProvider, config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 测试音频供应商连接
  app.post('/api/audio-test', async (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }
      const result = await audioConfigStore.testProvider(provider as AudioProvider);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 统一 AI 解析入口：CLI / 接收方节点 调这里完成 LLM + judgment + harness
  // 入参: { text, mimeType, fileName, fromNodeId, source }
  // 出参: { summary, qualityScore, judgmentId?, gateArtifact? }
  app.post('/api/ai-parse', async (req, res) => {
    try {
      const { text, mimeType, fileName, fromNodeId, source } = req.body || {};
      if (!text || !fileName) {
        return res.status(400).json({ error: 'text and fileName required' });
      }

      const truncated = text.length > 6000 ? text.substring(0, 6000) + '...[截断]' : text;
      const prompt = `请分析以下 ${mimeType || 'text'} 文档，并给出 (1) 一句话中文摘要 (2) 三个关键要点 (3) 质量评分(0-1)。\n\n文件名: ${fileName}\n\n内容:\n${truncated}`;

      // 1. LLM 解析
      const llm = getMinimax();
      const t0 = Date.now();
      const llmResult = await llm.summarize(prompt);
      const dt = Date.now() - t0;

      const out: any = {
        ok: true,
        summary: llmResult.summary,
        qualityScore: llmResult.qualityScore,
        latencyMs: dt,
        mimeType: mimeType || 'text/plain',
        fileName,
      };

      // 2. 蒸馏为 judgment (异步,失败不影响主返回)
      try {
        const judgmentMod = await import('../pi-ecosystem-judgment/index.js');
        await judgmentMod.initializeJudgmentStore();
        const j = await judgmentMod.createJudgment({
          type: 'trajectory',
          content: `AI 解析 ${fileName}: ${llmResult.summary.slice(0, 200)}`,
          source: 'agent',
          confidence: Math.min(1, llmResult.qualityScore),
          context: `ai-parse:${mimeType || 'text'}:${source || 'p2p'}`,
          evidence: {
            trajectory: [{
              timestamp: new Date().toISOString(),
              action: `parse:${fileName}`,
              outcome: `score=${llmResult.qualityScore.toFixed(2)}`,
              approved: true,
            }],
          },
        });
        out.judgmentId = j.id;
      } catch (e) {
        out.judgmentError = (e as Error).message;
      }

      // 3. 在 harness 落产物 (异步,失败不影响)
      try {
        const harnessMod = await import('../bollharness-integration/index.js');
        const gate = new harnessMod.GateStateMachine();
        gate.submitArtifact(`ai-parse:${fileName}`, {
          summary: llmResult.summary,
          score: llmResult.qualityScore,
          fromNodeId: fromNodeId || null,
          parsedAt: Date.now(),
        });
        out.gateArtifact = `ai-parse:${fileName}`;
      } catch (e) {
        out.gateError = (e as Error).message;
      }

      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== P2P Network API ====================

  // 获取当前身份
  app.get('/api/identity', async (_req, res) => {
    console.log('收到 /api/identity 请求');
    console.log('p2pIdentity.did:', p2pIdentity.did);
    try {
      res.json({
        did: p2pIdentity.did,
        name: p2pIdentity.name,
        publicKey: p2pIdentity.publicKey
      });
    } catch (err: any) {
      console.error('API identity 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // v3 测试: 返回 iroh endpoint 完整地址 (含 relay URL), 这才是 connect() 真正需要的
  app.get('/api/iroh-addr', async (_req, res) => {
    try {
      const addr = irohTransport.getEndpointAddr
        ? irohTransport.getEndpointAddr()
        : irohTransport.getNodeId();
      res.json({ addr });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3: 暴露 P2PDirect 自己的 publicKey + 本机名字, 对方可用它主动 connect 并自动取名
  app.get('/api/p2p-publickey', async (_req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ error: 'P2PDirect not started' });
      }
      const publicKey = v3P2PRef.getPublicKey();
      // 2026-06-10: 把本机 user/agent name 一起返回, 对方拿到后能直接用
      let name = process.env.BOLLOON_USER_NAME || process.env.USER || 'node';
      try {
        const { readFileSync, existsSync } = await import('fs');
        const cfgPath = `${process.env.HOME || '/tmp'}/.bolloon/config.json`;
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          if (cfg.userName) name = cfg.userName;
        }
      } catch {}
      res.json({ publicKey, name, role: v3P2PRef.getRole() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3: known peers CRUD (持久化到 ~/.bolloon/known_peers.json)
  // GET 列表, POST 加/更新, DELETE 删, PATCH 重命名
  app.get('/api/p2p-peers', async (_req, res) => {
    try {
      const { listPeers } = await import('../network/known-peers.js');
      const peers = await listPeers();
      res.json({ count: peers.length, peers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/p2p-peers', async (req, res) => {
    try {
      const { name, publicKey, notes } = req.body || {};
      if (!name || !publicKey) return res.status(400).json({ error: 'name and publicKey required' });
      if (typeof publicKey !== 'string' || publicKey.length !== 64) {
        return res.status(400).json({ error: 'publicKey must be 64-char hex (32 bytes)' });
      }
      const { addOrUpdatePeer } = await import('../network/known-peers.js');
      await addOrUpdatePeer(name, publicKey, notes);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.delete('/api/p2p-peers/:name', async (req, res) => {
    try {
      const { removePeer } = await import('../network/known-peers.js');
      await removePeer(req.params.name);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // 2026-06-10: PATCH 重命名 / 改备注 / 同时影响 publicKey
  // 用法: PATCH /api/p2p-peers/:name { name?, notes?, publicKey? }
  app.patch('/api/p2p-peers/:name', async (req, res) => {
    try {
      const { addOrUpdatePeer, removePeer } = await import('../network/known-peers.js');
      const { readFile, writeFile } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const filePath = `${process.env.HOME || '/tmp'}/.bolloon/known_peers.json`;
      if (!existsSync(filePath)) return res.status(404).json({ error: 'no known_peers.json' });
      const data = JSON.parse(await readFile(filePath, 'utf-8'));
      const oldName = req.params.name;
      const oldEntry = data.peers[oldName];
      if (!oldEntry) return res.status(404).json({ error: `peer "${oldName}" not found` });
      const { name: newName, notes, publicKey: newPk } = req.body || {};
      const finalName = newName || oldName;
      const finalPk = newPk || oldEntry.publicKey;
      if (finalName !== oldName) {
        delete data.peers[oldName];
      }
      data.peers[finalName] = {
        ...oldEntry,
        publicKey: finalPk,
        name: finalName,
        notes: notes !== undefined ? notes : oldEntry.notes
      };
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      res.json({ ok: true, peer: data.peers[finalName] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3: 主动 connect 到对端的 P2PDirect publicKey
  // 用法: POST /api/remote-channels/p2p-connect { targetPublicKey: "<hex>" }
  app.post('/api/remote-channels/p2p-connect', async (req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ error: 'P2PDirect not started' });
      }
      const { targetPublicKey, name, persist } = req.body || {};
      if (!targetPublicKey || typeof targetPublicKey !== 'string') {
        return res.status(400).json({ error: 'targetPublicKey required (hex)' });
      }
      // v3P2PRef 直接连到目标 publicKey (用 hyperswarm 的 joinPeer API)
      const swarm = (v3P2PRef as any).swarm;
      if (!swarm) return res.status(503).json({ error: 'swarm not available' });
      const conn = await swarm.joinPeer(Buffer.from(targetPublicKey, 'hex'));
      console.log(`[v3] 已主动 joinPeer ${targetPublicKey.substring(0, 12)}...`);

      // 自动持久化 (默认开启) — 之后启动自动重连
      let persistedAs: string | null = null;
      if (persist !== false) {
        const { addOrUpdatePeer, findNameByPublicKey } = await import('../network/known-peers.js');
        // 优先用客户端传的 name, 否则用 publicKey 前 8 位
        const peerName = name || `peer-${targetPublicKey.substring(0, 8)}`;
        // 如果 publicKey 已被别的 name 占用, 用现有 name
        const existingName = await findNameByPublicKey(targetPublicKey);
        persistedAs = existingName ?? peerName ?? `peer-${targetPublicKey.substring(0, 8)}`;
        await addOrUpdatePeer(persistedAs, targetPublicKey);
        console.log(`[v3] 自动持久化 peer: ${persistedAs}`);
      }

      res.json({ ok: true, target: targetPublicKey, persistedAs });
    } catch (err: any) {
      console.error('[v3] p2p-connect 失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // v3: 主动给对端发好友申请 — 推到对端 UI 让对方接受
  // 用法: POST /api/friend-request { targetPublicKey, name, message }
  // 2026-06-10 改: 用 sendToWithWait 等握手完成, 不再 fire-and-forget; 返回结构化 code 让前端知道失败
  app.post('/api/friend-request', async (req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ ok: false, code: 'P2P_NOT_STARTED', error: 'P2PDirect not started' });
      }
      const { targetPublicKey, name, message } = req.body || {};
      if (!targetPublicKey || typeof targetPublicKey !== 'string' || targetPublicKey.length !== 64) {
        return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'targetPublicKey (64 hex) required' });
      }
      // 先 joinPeer 触发握手 (注意: joinPeer 不阻塞到 conn 就绪)
      const swarm = (v3P2PRef as any).swarm;
      if (swarm) {
        try { await swarm.joinPeer(Buffer.from(targetPublicKey, 'hex')); } catch {}
      }
      // 主动把对方加为本机 known_peers (本地视角认为对方是朋友)
      const { addOrUpdatePeer, findNameByPublicKey } = await import('../network/known-peers.js');
      const existing = await findNameByPublicKey(targetPublicKey);
      const peerName = name || existing || `peer-${targetPublicKey.substring(0, 8)}`;
      await addOrUpdatePeer(peerName, targetPublicKey);
      // 构造 RPC, 推到对端 — 对端会 SSE 推 friend-request 到前端
      const myPk = v3P2PRef.getPublicKey();
      const requestId = crypto.randomUUID();
      const rpc = JSON.stringify({
        v: 3,
        op: 'agent.friend.request',
        payload: {
          requestId,                  // 2026-06-10: 加 requestId, ack 时回带
          fromPublicKey: myPk,
          name: peerName,
          message: message || '想加你为 P2P 好友, 共享 channel 协作'
        }
      });
      // 2026-06-10: 用 sendToWithWait, 等 conn 真就绪后再发, 默认 5s 超时
      const result = await v3P2PRef.sendToWithWait(targetPublicKey, rpc, 5000);
      console.log(`[v3-friend] ${myPk.substring(0,12)}... 发送好友申请给 ${targetPublicKey.substring(0,12)}... (result=${result}, requestId=${requestId.substring(0,8)})`);
      if (result !== 'SENT') {
        return res.status(502).json({
          ok: false,
          code: result,            // NO_CONN / WRITE_FAIL
          error: result === 'NO_CONN'
            ? '对方未在线, 请确认对方已启动 bolloon 并互联'
            : '写入 P2P 通道失败, 请重试',
          persistedAs: peerName    // 本地仍持久化, 等对方上线再 retry 即可
        });
      }
      res.json({ ok: true, sent: true, code: 'SENT', persistedAs: peerName, requestId });
    } catch (err: any) {
      console.error('[v3-friend] friend-request 失败:', err);
      res.status(500).json({ ok: false, code: 'EXCEPTION', error: err.message });
    }
  });

  // v3: 接受对方的好友申请 — 把对方加为 known_peers, 立即推我的 channel 列表给 ta
  // 用法: POST /api/friend-accept { fromPublicKey, name }
  app.post('/api/friend-accept', async (req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ error: 'P2PDirect not started' });
      }
      const { fromPublicKey, name } = req.body || {};
      if (!fromPublicKey || typeof fromPublicKey !== 'string' || fromPublicKey.length !== 64) {
        return res.status(400).json({ error: 'fromPublicKey (64 hex) required' });
      }
      // 持久化
      const { addOrUpdatePeer, findNameByPublicKey } = await import('../network/known-peers.js');
      const existing = await findNameByPublicKey(fromPublicKey);
      const peerName = name || existing || `peer-${fromPublicKey.substring(0, 8)}`;
      await addOrUpdatePeer(peerName, fromPublicKey);
      // joinPeer 确保连接存在 (连接可能已在 friend-request 时建立, 这里可能是 no-op)
      const swarm = (v3P2PRef as any).swarm;
      if (swarm) {
        try { await swarm.joinPeer(Buffer.from(fromPublicKey, 'hex')); } catch {}
      }
      // v3 修复: 主动广播自己的 channel 列表给新好友,
      // 不能依赖 connection handler, 因为连接在 friend-request 阶段已建立, 不会触发新 connection 事件
      v3BroadcastOwn().catch(err => console.error('[v3] broadcast after friend-accept failed:', err));
      console.log(`[v3-friend] 接受好友申请: ${fromPublicKey.substring(0,12)}... → ${peerName}`);
      res.json({ ok: true, persistedAs: peerName });
    } catch (err: any) {
      console.error('[v3-friend] friend-accept 失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // v3: 给远端 channel 发消息 (B 节点) - 通过 P2PDirect 转发到 A, A 跑 LLM, 回 B
  // 用法: POST /api/remote-channels/chat-send
  //   { targetPublicKey, channelId, text }
  app.post('/api/remote-channels/chat-send', async (req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ error: 'P2PDirect not started' });
      }
      const { targetPublicKey, channelId, text } = req.body || {};
      if (!targetPublicKey || !channelId || !text) {
        return res.status(400).json({ error: 'targetPublicKey, channelId, text required' });
      }
      if (typeof text !== 'string' || text.length === 0 || text.length > 8000) {
        return res.status(400).json({ error: 'text length must be 1-8000' });
      }
      const fromPk = v3P2PRef.getPublicKey();
      const msg = JSON.stringify({
        v: 3,
        op: 'agent.chat.send',
        payload: { channelId, text, fromPublicKey: fromPk }
      });
      const ok = v3P2PRef.sendTo(targetPublicKey, msg);
      if (!ok) {
        return res.status(502).json({
          error: 'peer not connected. POST /api/remote-channels/p2p-connect first.'
        });
      }
      // 2026-06-10: 喂 watchdog — chat-send 成功是真实业务活动
      watchdogRef?.recordActivity?.();
      console.log(`[v3] chat-send 转发到 ${targetPublicKey.substring(0, 12)}... (channelId=${channelId})`);
      res.json({ ok: true, sent: true });
    } catch (err: any) {
      console.error('[v3] chat-send 失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // v3 新增: B 拉 A 的 channel 历史 + 用了哪些 judgment
  // GET /api/remote-channels/chat-history?targetPublicKey=...&channelId=...
  // 实现: B → POST 给 A 一个 agent.history.get RPC → A 把 session 返回 → B 渲染
  app.get('/api/remote-channels/chat-history', async (req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ error: 'P2PDirect not started' });
      }
      const targetPublicKey = String(req.query.targetPublicKey || '');
      const channelId = String(req.query.channelId || '');
      if (!targetPublicKey || !channelId) {
        return res.status(400).json({ error: 'targetPublicKey, channelId required' });
      }

      // 通过 RPC 拉 A 的 session — A 端收到后异步回复
      const fromPk = v3P2PRef.getPublicKey();
      const rpcId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg = JSON.stringify({
        v: 3,
        op: 'agent.history.get',
        payload: { rpcId, channelId, fromPublicKey: fromPk }
      });
      const ok = v3P2PRef.sendTo(targetPublicKey, msg);
      if (!ok) {
        return res.status(502).json({ error: 'peer not connected' });
      }

      // 等待 A 异步回复 (15s timeout) — 用一个 Promise 等
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          v3PendingHistoryGets.delete(rpcId);
          reject(new Error('A 端 15s 内未回复, 可能未分享该 channel'));
        }, 15000);
        v3PendingHistoryGets.set(rpcId, {
          resolve: (data) => { clearTimeout(timer); resolve(data); },
          reject: (err) => { clearTimeout(timer); reject(err); }
        });
      });

      console.log(`[v3] chat-history 从 ${targetPublicKey.substring(0,12)}... 拉到 ${(result.messages || []).length} 条`);
      res.json(result);
    } catch (err: any) {
      console.error('[v3] chat-history 失败:', err.message);
      res.status(504).json({ error: err.message });
    }
  });

  // 获取已连接的节点
  app.get('/api/peers', async (_req, res) => {
    try {
      if (!p2pCommunicator) {
        res.json([]);
        return;
      }
      const connections = p2pCommunicator.getConnections();
      const peers = connections.map((conn: P2PConnection) => ({
        id: conn.publicKey.substring(0, 16),
        publicKey: conn.publicKey,
        peerId: conn.publicKey
      }));
      res.json(peers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取已发现的所有节点（包括通过 CID 解析的）
  app.get('/api/discovered-peers', async (_req, res) => {
    try {
      // 从全局状态获取已发现的节点
      const discovered = (global as any).discoveredAgents || [];
      res.json(discovered);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== iroh P2P API ====================

  // 初始化 iroh P2P（带持久化）
  app.post('/api/iroh/init', async (_req, res) => {
    try {
      if (irohInitialized && irohNodeInfo) {
        res.json({ ok: true, ...irohNodeInfo });
        return;
      }

      console.log('[iroh API] 初始化 iroh...');

      // 启动 iroh（启用持久化）
      await irohTransport.start(undefined, true);
      const nodeId = irohTransport.getNodeId() || '';

      console.log(`[iroh API] iroh 节点 ID: ${nodeId.substring(0, 20)}...`);

      // 生成 DID
      const keyPair = KeyManager.generate();
      const did = keyPair.did;

      // 构建节点信息文档
      const nodeDoc = {
        id: did,
        name: `bolloon-web-${Date.now()}`,
        version: '1.0',
        capabilities: ['chat', 'ai', 'judgment-injection', 'web-interface'],
        interests: ['ai', 'p2p', 'judgment-system'],
        irohNodeId: nodeId,
        channels: [{ id: 'main', name: '主对话' }],
        createdAt: new Date().toISOString()
      };

      // 发布到 IPFS（可选，如果 IPFS 不可用则跳过）
      let cid = '';
      try {
        const formData = new FormData();
        const blob = new Blob([JSON.stringify(nodeDoc)], { type: 'application/json' });
        formData.append('file', blob, 'node-info.json');

        const ipfsRes = await fetch(`${IPFS_ENDPOINT}/api/v0/add`, {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(5000)
        });
        const ipfsResult = await ipfsRes.text();
        const cidMatch = ipfsResult.match(/"Hash":"([^"]+)"/);
        cid = cidMatch ? cidMatch[1] : '';
        console.log(`[iroh API] CID 发布成功: ${cid.substring(0, 20)}...`);
      } catch (ipfsErr) {
        console.warn('[iroh API] IPFS 不可用，跳过 CID 发布:', (ipfsErr as Error).message);
        // 生成一个假的 CID 用于本地测试（格式：Qm + 44个随机字符）
        const randomPart = Array.from({ length: 44 }, () => Math.random().toString(36)[2]).join('').substring(0, 44);
        cid = `Qm${randomPart}`;
        console.log(`[iroh API] 使用本地 CID: ${cid.substring(0, 20)}...`);
      }

      irohNodeInfo = {
        did,
        cid,
        irohNodeId: nodeId,
        name: nodeDoc.name,
        initialized: true
      };
      irohInitialized = true;

      // 挂载 agent-delegate app (manifest 协议 + agent_delegate)
      // 必须在 irohInitialized 之后挂, 因为适配器要监听 irohTransport.onMessage
      try {
        const delegateTransport = createIrohDelegateTransport({ verbose: true });
        const delegateApp = createAgentDelegateApp(delegateTransport);
        app.use('/api/agent', delegateApp);
        console.log('[iroh API] agent-delegate app 已挂载到 /api/agent');
      } catch (e) {
        console.error('[iroh API] 挂载 agent-delegate app 失败:', e);
      }

      // 设置消息处理
      irohTransport.onMessage('chat', (msg) => {
        const content = new TextDecoder().decode(msg.payload);
        console.log(`[iroh] 收到消息 from ${msg.from.substring(0, 12)}...`);

        // 通过 SSE 广播给所有客户端
        broadcast({
          type: 'p2p_message',
          from: msg.from,
          content,
          timestamp: Date.now()
        }, 'p2p-global');
      });

      // ============ v3: 跨用户 channel 元数据 RPC ============
      // 设计原则: judgment / bound_judgment_ids / wallet 等敏感字段绝不出现在 RPC 响应里.
      // 收到 'agent.meta.list' → 返回本节点所有 channel 的 UI 元数据 (无 judgment)
      // 收到 'agent.meta.get' + channelId → 返回单条 channel 的 UI 元数据
      // B 节点收到响应 → 存到远端 cache → 渲染到 "远端智能体" 区域

      // B 侧: 收到对端的 list/get 回复 → 更新远端 cache → SSE 推给前端
      irohTransport.onMessage('agent.meta.list.reply', (msg) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg.payload));
          if (!data.ok) return;
          const peerId = msg.from;
          const list = Array.isArray(data.channels) ? data.channels : [];
          remoteChannelCache.set(peerId, list);
          console.log(`[v3] 缓存远端 peer ${peerId.substring(0, 12)}... 的 ${list.length} 个 channel`);
          broadcast({
            type: 'remote-channel-update',
            peerId,
            channels: list
          }, 'p2p-global');
        } catch (err) {
          console.error('[v3] 处理 agent.meta.list.reply 失败:', err);
        }
      });

      irohTransport.onMessage('agent.meta.get.reply', (msg) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg.payload));
          if (!data.ok || !data.channel) return;
          const peerId = msg.from;
          const ch = data.channel;
          const list = remoteChannelCache.get(peerId) || [];
          const idx = list.findIndex(c => c.id === ch.id);
          if (idx >= 0) list[idx] = ch;
          else list.push(ch);
          remoteChannelCache.set(peerId, list);
          broadcast({
            type: 'remote-channel-update',
            peerId,
            channels: list
          }, 'p2p-global');
        } catch (err) {
          console.error('[v3] 处理 agent.meta.get.reply 失败:', err);
        }
      });

      // A 侧: 收到对端的 list/get 请求
      irohTransport.onMessage('agent.meta.list', async (msg) => {
        console.log(`[v3] 收到 agent.meta.list from ${msg.from.substring(0, 12)}...`);
        try {
          const channels = await loadChannels();
          // iroh 路径保留 (admin / debug 用, 不走分享过滤)
          const publicMeta = channels.map((ch) => sanitizeChannelForPeer(ch));
          const response = JSON.stringify({ ok: true, channels: publicMeta });
          const encoded = new TextEncoder().encode(response);
          // 沿用 msg.from 路由回去
          irohTransport.sendMessage(msg.from, 'agent.meta.list.reply', encoded).catch(err => {
            console.error('[v3] 发送 agent.meta.list.reply 失败:', err);
          });
        } catch (err) {
          console.error('[v3] 处理 agent.meta.list 失败:', err);
        }
      });

      irohTransport.onMessage('agent.meta.get', async (msg) => {
        try {
          const req = JSON.parse(new TextDecoder().decode(msg.payload));
          const channelId = req.channelId;
          console.log(`[v3] 收到 agent.meta.get for ${channelId} from ${msg.from.substring(0, 12)}...`);
          const channels = await loadChannels();
          const ch = channels.find(c => c.id === channelId);
          if (!ch) {
            const response = JSON.stringify({ ok: false, error: 'channel not found' });
            irohTransport.sendMessage(msg.from, 'agent.meta.get.reply', new TextEncoder().encode(response));
            return;
          }
          const response = JSON.stringify({ ok: true, channel: sanitizeChannelForPeer(ch) });
          irohTransport.sendMessage(msg.from, 'agent.meta.get.reply', new TextEncoder().encode(response));
        } catch (err) {
          console.error('[v3] 处理 agent.meta.get 失败:', err);
        }
      });

      irohTransport.onMessage('ai-dialogue', (msg) => {
        const content = new TextDecoder().decode(msg.payload);
        console.log(`[iroh] 收到 AI 对话 from ${msg.from.substring(0, 12)}...`);

        broadcast({
          type: 'p2p_message',
          content,
          timestamp: Date.now()
        }, 'p2p-global');
      });

      console.log(`[iroh API] 初始化完成: DID=${did}, CID=${cid}`);

      res.json({ ok: true, ...irohNodeInfo });
    } catch (err: any) {
      console.error('[iroh API] 初始化失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 获取 iroh 节点信息
  app.get('/api/iroh/info', async (_req, res) => {
    if (!irohInitialized || !irohNodeInfo) {
      res.json({ initialized: false });
      return;
    }
    res.json({
      initialized: true,
      did: irohNodeInfo.did,
      cid: irohNodeInfo.cid,
      irohNodeId: irohNodeInfo.irohNodeId,
      name: irohNodeInfo.name
    });
  });

  // 通过 CID 或 Node ID 连接到其他节点
  app.post('/api/iroh/connect', async (req, res) => {
    try {
      const { cid } = req.body;

      if (!cid) {
        return res.status(400).json({ error: 'CID required' });
      }

      if (!irohInitialized) {
        return res.status(500).json({ error: 'iroh not initialized' });
      }

      let targetNodeId: string;
      let nodeName = 'Unknown';

      console.log(`[iroh API] 连接到: ${cid}`);

      // 检查是 Node ID（64字符十六进制）还是 CID
      const isNodeId = /^[a-f0-9]{64}$/i.test(cid);

      if (isNodeId) {
        // 直接使用 Node ID
        targetNodeId = cid;
        console.log(`[iroh API] 使用直接 Node ID: ${targetNodeId.substring(0, 20)}...`);
      } else {
        // 从 IPFS 获取节点信息
        try {
          const ipfsRes = await fetch(`${IPFS_ENDPOINT}/api/v0/cat?arg=${cid}`, {
            method: 'POST'
          });
          const content = await ipfsRes.text();
          const doc = JSON.parse(content);

          if (!doc.irohNodeId) {
            return res.status(400).json({ error: '节点信息中不包含 irohNodeId' });
          }

          targetNodeId = doc.irohNodeId;
          nodeName = doc.name || 'Unknown';
          console.log(`[iroh API] 从 IPFS 获取节点: ${targetNodeId.substring(0, 20)}...`);
        } catch {
          return res.status(400).json({ error: '无法从 CID 获取节点信息，请确认 CID 有效' });
        }
      }

      // 发送连接消息
      const message = JSON.stringify({
        type: 'hello',
        from: irohNodeInfo?.irohNodeId,
        name: irohNodeInfo?.name,
        timestamp: Date.now()
      });

      const success = await irohTransport.sendMessage(
        targetNodeId,
        'chat',
        new TextEncoder().encode(message)
      );

      if (success) {
        console.log(`[iroh API] 连接成功!`);
        res.json({
          ok: true,
          targetNodeId,
          nodeName
        });
      } else {
        console.log(`[iroh API] 连接失败（对方可能离线）`);
        res.json({
          ok: false,
          error: '连接失败，对方可能离线',
          targetNodeId
        });
      }
    } catch (err: any) {
      console.error('[iroh API] 连接错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 发送消息给指定节点
  app.post('/api/iroh/send', async (req, res) => {
    try {
      const { targetNodeId, type, content } = req.body;

      if (!targetNodeId || !content) {
        return res.status(400).json({ error: 'targetNodeId and content required' });
      }

      if (!irohInitialized) {
        return res.status(500).json({ error: 'iroh not initialized' });
      }

      const messageType = type || 'chat';
      const success = await irohTransport.sendMessage(
        targetNodeId,
        messageType,
        new TextEncoder().encode(content)
      );

      res.json({ ok: success });
    } catch (err: any) {
      console.error('[iroh API] 发送消息错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 获取已连接的 iroh 节点列表
  app.get('/api/iroh/peers', async (_req, res) => {
    try {
      if (!irohInitialized) {
        res.json([]);
        return;
      }

      const peers = irohTransport.getConnectedPeers();
      res.json(peers.map((nodeId: string) => ({
        nodeId,
        shortId: nodeId.substring(0, 16)
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取离线消息数量
  app.get('/api/iroh/offline-count', async (_req, res) => {
    try {
      if (!irohInitialized) {
        res.json({ count: 0 });
        return;
      }

      const count = irohTransport.getPendingOfflineCount();
      res.json({ count });
    } catch (err: any) {
      res.json({ count: 0 });
    }
  });

  // 获取当前频道的身份信息
  app.get('/api/channel-identity/:channelId', async (req, res) => {
    try {
      const { channelId } = req.params;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      res.json({
        did: channel.did || '',
        cid: channel.cid || '',
        publicKey: channel.publicKey || '',
        name: channel.name
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 通过 DID/CID 连接远程智能体
  app.post('/api/connect', async (req, res) => {
    try {
      const { did, cid, ipnsName } = req.body;
      if (!did && !cid && !ipnsName) {
        return res.status(400).json({ error: 'DID, CID or IPNS name required' });
      }

      console.log(`[连接] 尝试连接 DID: ${did}, CID: ${cid}, IPNS: ${ipnsName}`);

      let doc: any = null;

      // 1. 通过 CID 或 IPNS 解析 DiapDoc
      if (cid || ipnsName) {
        try {
          const { IpfsClient } = await import('@diap/sdk');
          const ipfs = new IpfsClient('http://127.0.0.1:5001', null);

          let resolvedCid = cid;
          if (ipnsName) {
            resolvedCid = await ipfs.resolveIpns(ipnsName);
          }

          if (resolvedCid) {
            const content = await ipfs.get(resolvedCid);
            doc = JSON.parse(content);
            console.log(`[连接] 解析 DiapDoc 成功: ${doc.name}`);
          }
        } catch (e) {
          console.warn(`[连接] 解析 IPFS 内容失败:`, e);
        }
      }

      // 2. 如果有 DID，检查是否已连接
      if (did) {
        // 广播连接请求
        if (p2pCommunicator) {
          const payload = JSON.stringify({
            type: 'connect_request',
            requesterDid: did,
            targetDid: did,
            timestamp: Date.now()
          });
          // 广播到网络
          console.log(`[连接] 广播连接请求: ${did}`);
        }
      }

      // 3. 将解析的文档添加到已发现列表
      if (doc) {
        const discovered = (global as any).discoveredAgents || [];
        const existing = discovered.findIndex((a: any) => a.did === doc.id);
        if (existing >= 0) {
          discovered[existing] = { ...discovered[existing], ...doc, lastSeen: Date.now() };
        } else {
          discovered.push({
            did: doc.id || doc.did,
            name: doc.name,
            capabilities: doc.capabilities || [],
            interests: doc.interests || [],
            channels: doc.channels || [],
            cid: cid,
            ipnsName: ipnsName,
            lastSeen: Date.now()
          });
        }
        (global as any).discoveredAgents = discovered;

        // 广播发现事件到前端
        broadcast({ type: 'peer_discovered', peer: doc });
      }

      res.json({
        ok: true,
        did: doc?.id || did,
        name: doc?.name,
        capabilities: doc?.capabilities || [],
        channels: doc?.channels || [],
        message: doc ? 'DiapDoc 解析成功' : '连接请求已发送'
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 发送 P2P 消息
  app.post('/api/message-p2p', async (req, res) => {
    try {
      const { peerId, did, message } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'message required' });
      }

      let targetPeerId = peerId;

      // 如果没有 peerId，通过 DID 查找
      if (!targetPeerId && did) {
        const discovered = (global as any).discoveredAgents || [];
        const peer = discovered.find((a: any) => a.did === did);
        if (peer) {
          targetPeerId = peer.peerId;
        }
      }

      if (!targetPeerId) {
        // 如果没有 P2P 连接，将消息存储到本地队列
        const messageQueue = (global as any).messageQueue || [];
        messageQueue.push({
          did,
          message,
          timestamp: Date.now(),
          status: 'pending'
        });
        (global as any).messageQueue = messageQueue;
        res.json({ ok: true, queued: true, message: '消息已加入队列，等待对方上线' });
        return;
      }

      // 通过 P2P 发送消息（如果可用）
      try {
        const comm = p2pCommunicator as any;
        if (comm && typeof comm.send === 'function') {
          await comm.send(message, targetPeerId);
          res.json({ ok: true, sent: true });
          return;
        }
      } catch {}

      // 如果 P2P 不可用，消息已在上面加入队列
      res.json({ ok: true, queued: true, message: '消息已加入队列，等待对方上线' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取待接收的消息队列
  app.get('/api/peer-messages', async (_req, res) => {
    try {
      const messageQueue = (global as any).messageQueue || [];
      const pendingMessages = messageQueue.filter((m: any) => m.status === 'pending');
      res.json(pendingMessages);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Chat inbox: 列出所有 peer 的 inbox + outbox
  app.get('/api/chat/inbox', async (_req, res) => {
    try {
      const { getInbox } = await import('../agents/p2p-chat-tools.js');
      const entries = await getInbox();
      // 按 status 分组, 时间倒序
      const grouped = {
        received: entries.filter((e: any) => e.status === 'received'),
        drafted:  entries.filter((e: any) => e.status === 'drafted'),
        sent:     entries.filter((e: any) => e.status === 'sent'),
        dismissed: entries.filter((e: any) => e.status === 'dismissed'),
      };
      res.json({ total: entries.length, grouped, all: entries });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 触发 processPendingInbox (手动 wake-up)
  app.post('/api/chat/process-pending', async (_req, res) => {
    try {
      const { processPendingInbox } = await import('../agents/p2p-chat-tools.js');
      const r = await processPendingInbox();
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 终止当前 channel 的 LLM 流 (UI 终止按钮)
  app.post('/api/chat/abort', async (req, res) => {
    try {
      const { channelId } = req.body as { channelId?: string };
      if (!channelId) return res.status(400).json({ error: 'channelId required' });
      const s = channelRunState.get(channelId);
      if (s?.abortController) {
        s.abortController.abort();
        console.log(`[abort] user aborted channel=${channelId}`);
        return res.json({ ok: true, aborted: true });
      }
      res.json({ ok: true, aborted: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 用户审阅: 批准 draft
  app.post('/api/chat/approve', async (req, res) => {
    try {
      const { messageId, peerDID, finalText } = req.body || {};
      if (!messageId || !peerDID) return res.status(400).json({ error: 'messageId and peerDID required' });
      const { approveAndSend } = await import('../agents/p2p-chat-tools.js');
      const ok = await approveAndSend(messageId, peerDID, finalText);
      res.json({ ok, messageId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 用户审阅: 丢弃 draft
  app.post('/api/chat/dismiss', async (req, res) => {
    try {
      const { messageId, peerDID } = req.body || {};
      if (!messageId || !peerDID) return res.status(400).json({ error: 'messageId and peerDID required' });
      const { dismissDraft } = await import('../agents/p2p-chat-tools.js');
      const ok = await dismissDraft(messageId, peerDID);
      res.json({ ok, messageId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 标记消息已读
  app.post('/api/peer-messages/:messageId/read', async (req, res) => {
    try {
      const { messageId } = req.params;
      const messageQueue = (global as any).messageQueue || [];
      const msg = messageQueue.find((m: any) => m.id === messageId);
      if (msg) {
        msg.status = 'read';
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== P2P 连接进度 SSE ====================

  // 连接进度流（用于实时显示解析进度）
  const connectProgressClients = new Map<string, any>();

  app.get('/api/p2p/connect/progress', async (req, res) => {
    const sessionId = crypto.randomUUID();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ type: 'start', sessionId })}\n\n`);

    connectProgressClients.set(sessionId, res);

    req.on('close', () => {
      connectProgressClients.delete(sessionId);
    });
  });

  function emitConnectProgress(sessionId: string, data: any) {
    const client = connectProgressClients.get(sessionId);
    if (client) {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  // 取消连接
  app.post('/api/p2p/connect/cancel', async (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && connectProgressClients.has(sessionId)) {
      connectProgressClients.get(sessionId).end();
      connectProgressClients.delete(sessionId);
    }
    res.json({ ok: true });
  });

  // ==================== P2P 连接历史 API ====================

  const P2P_HISTORY_PATH = path.join(SHARED_SESSION_PATH, 'p2p-history.json');

  async function loadP2PHistory() {
    try {
      const data = await fs.readFile(P2P_HISTORY_PATH, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async function saveP2PHistory(history: any[]) {
    await fs.writeFile(P2P_HISTORY_PATH, JSON.stringify(history, null, 2));
  }

  // 获取连接历史
  app.get('/api/p2p/history', async (_req, res) => {
    try {
      const history = await loadP2PHistory();
      res.json(history);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 添加到连接历史
  app.post('/api/p2p/history', async (req, res) => {
    try {
      const history = await loadP2PHistory();
      const entry = req.body;

      // 检查是否已存在
      const existingIndex = history.findIndex((h: any) => h.did === entry.did);
      if (existingIndex >= 0) {
        history[existingIndex] = { ...history[existingIndex], ...entry, lastConnectedAt: Date.now() };
      } else {
        history.unshift({ ...entry, id: crypto.randomUUID(), lastConnectedAt: Date.now(), lastMessageAt: 0, totalMessages: 0 });
      }

      await saveP2PHistory(history);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新连接历史
  app.patch('/api/p2p/history/:id', async (req, res) => {
    try {
      const history = await loadP2PHistory();
      const { id } = req.params;
      const updates = req.body;

      const index = history.findIndex((h: any) => h.id === id);
      if (index >= 0) {
        history[index] = { ...history[index], ...updates };
        await saveP2PHistory(history);
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除连接历史
  app.delete('/api/p2p/history/:id', async (req, res) => {
    try {
      const history = await loadP2PHistory();
      const { id } = req.params;

      const filtered = history.filter((h: any) => h.id !== id);
      await saveP2PHistory(filtered);

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== P2P 偏好设置 API ====================

  const P2P_PREFS_PATH = path.join(SHARED_SESSION_PATH, 'p2p-preferences.json');

  async function loadP2PPreferences() {
    try {
      const data = await fs.readFile(P2P_PREFS_PATH, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {
        autoReconnect: true,
        autoConnectOnStartup: true,
        preferredNodes: [],
        maxOfflineQueue: 100,
        notifications: {
          newMessage: true,
          connectionEstablished: true,
          peerWentOnline: true,
          peerWentOffline: true
        }
      };
    }
  }

  async function saveP2PPreferences(prefs: any) {
    await fs.writeFile(P2P_PREFS_PATH, JSON.stringify(prefs, null, 2));
  }

  app.get('/api/p2p/preferences', async (_req, res) => {
    try {
      const prefs = await loadP2PPreferences();
      res.json(prefs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/p2p/preferences', async (req, res) => {
    try {
      const current = await loadP2PPreferences();
      const updates = req.body;
      await saveP2PPreferences({ ...current, ...updates });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取持久连接列表
  app.get('/api/p2p/persistent-connections', async (_req, res) => {
    try {
      const sessionProvider = app.locals.sessionProvider;
      if (!sessionProvider) {
        return res.json([]);
      }
      const channels = sessionProvider.getAllChannels().filter((ch: any) => ch.peerId);
      res.json(
        channels.map((ch: any) => ({
          id: ch.id,
          peerId: ch.peerId || '',
          peerDid: ch.peerDid || '',
          peerName: ch.peerName || 'Unknown',
          cid: ch.cid || '',
          status: ch.peerId ? 'connected' : 'disconnected',
          lastConnectedAt: new Date(ch.updatedAt).getTime(),
          channelId: ch.id,
          isAutoConnect: false
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新连接状态
  app.post('/api/p2p/connection-status', async (req, res) => {
    try {
      const { id, status, channelId } = req.body;
      const sessionProvider = app.locals.sessionProvider;
      if (sessionProvider && channelId) {
        await sessionProvider.setChannelInfo(channelId, {
          peerId: status === 'connected' ? (req.body.peerId || 'connected') : undefined
        });
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建对话通道
  app.post('/api/p2p/create-channel', async (req, res) => {
    try {
      const { peerDid, peerName, cid, peerId } = req.body;
      const sessionProvider = app.locals.sessionProvider;
      if (!sessionProvider) {
        return res.status(500).json({ error: 'sessionProvider not available' });
      }
      const channel = await sessionProvider.getOrCreatePeerChannel(peerDid, peerName);
      await sessionProvider.setChannelInfo(channel.id, { peerId: peerId || '', cid: cid || '' });
      res.json({ channelId: channel.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // CID 解析
  app.post('/api/p2p/resolve-cid', async (req, res) => {
    try {
      const { cid } = req.body;
      const { DiapDocParser } = await import('../social/channels/diap-doc-parser.js');
      const parser = new DiapDocParser();
      const result = await parser.parseFromCID(cid);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // P2P 工具调用
  app.post('/api/p2p/tool-call', async (req, res) => {
    try {
      const { tool, targetDid, payload } = req.body;

      let result;
      switch (tool) {
        case 'system_info':
          const { getLocalSystemInfo } = await import('./components/p2p/p2p-tools.js');
          result = getLocalSystemInfo();
          break;
        case 'file_list':
          const { getLocalFileList } = await import('./components/p2p/p2p-tools.js');
          result = getLocalFileList(payload?.path || '/');
          break;
        default:
          return res.status(400).json({ error: `Unknown tool: ${tool}` });
      }

      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== 24h Heartbeat System ====================

  let healthMonitor: any = null;
  let watchdog: any = null;

  // 延迟导入避免循环依赖
  try {
    const { createHealthMonitor, createWatchdog } = await import('../heartbeat/index.js');
    healthMonitor = createHealthMonitor();
    // 把 watchdog 静默阈值拉到 30 分钟, 避免开发期 / 用户空闲时被误杀
    watchdog = createWatchdog({ silentThresholdMs: 30 * 60 * 1000 });
    // 2026-06-10: 同步到 module-level, 让 broadcast() / P2P handler / chat-send 都能喂活动
    watchdogRef = watchdog;

    console.log('[24h] Heartbeat modules loaded');
  } catch (err) {
    console.warn('[24h] Failed to load heartbeat modules:', err);
  }

  // 健康检查端点
  app.get('/api/health', async (req, res) => {
    try {
      if (!healthMonitor) {
        res.status(503).json({ error: 'Health monitor not initialized' });
        return;
      }

      const status = await healthMonitor.check();

      // 记录心跳活跃
      healthMonitor.recordHeartbeat?.();
      watchdog?.recordActivity?.('health_check');

      // 根据状态返回不同 HTTP 状态码
      const httpStatus = status.status === 'healthy' ? 200 :
                         status.status === 'degraded' ? 200 : 503;

      res.status(httpStatus).json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 看门狗状态
  app.get('/api/watchdog', async (req, res) => {
    try {
      if (!watchdog) {
        res.status(503).json({ error: 'Watchdog not initialized' });
        return;
      }

      const state = watchdog.getState();
      res.json(state);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 看门狗重置
  app.post('/api/watchdog/reset', async (req, res) => {
    try {
      if (watchdog) {
        watchdog.reset();
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== Judgments (v1 核心: 让我能记录判断) ====================
  // POST /api/judgments       — 记录一个判断
  // GET  /api/judgments       — 列出所有判断 (新→旧)
  // 存储: ~/.bolloon/human-values/judgments.json (human-value-store)
  //      极简版: 只记录 decision + reason; 其它字段可选
  app.post('/api/judgments', async (req, res) => {
    try {
      const { decision, reason, context } = req.body as {
        decision?: string; reason?: string; context?: { domain?: string; stakes?: string };
      };
      if (!decision || typeof decision !== 'string' || !decision.trim()) {
        return res.status(400).json({ error: 'decision required' });
      }
      const { storeHumanJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const j = await storeHumanJudgment({
        decision: decision.trim(),
        decision_type: 'approve',
        reasons: reason ? [reason.trim()] : [],
        values_derived: [],
        context: {
          domain: context?.domain || 'general',
          complexity: 'moderate',
          stakes: (context?.stakes as 'low' | 'medium' | 'high' | 'critical') || 'medium',
          time_pressure: 'low',
        },
        metadata: {
          source: 'explicit',
          confidence: 0.8,
          revisable: true,
        },
      });
      res.json({ ok: true, judgment: j });
    } catch (err: any) {
      console.error('[judgments] POST failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/judgments', async (req, res) => {
    try {
      const { listJudgmentsByStatus, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const status = (typeof req.query.status === 'string' ? req.query.status : 'all') as
        | 'active'
        | 'pending'
        | 'superseded'
        | 'rejected'
        | 'all';
      const all = await listJudgmentsByStatus(status);
      all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      res.json({ count: all.length, status, judgments: all });
    } catch (err: any) {
      console.error('[judgments] GET failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 蒸馏 B 触发 (人类点按钮) — 同步执行演化对齐
  app.post('/api/judgments/distill-from-conversation', async (req, res) => {
    try {
      const { channelId, messageId, recentTurns } = req.body as {
        channelId?: string;
        messageId?: string;
        recentTurns?: number;
      };
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }

      // 取 channel 最近的对话
      const channels = await loadChannels();
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) return res.status(404).json({ error: 'channel not found' });

      const currentSessionId = channel.currentSessionId;
      if (!currentSessionId) {
        return res.status(400).json({ error: 'no active session in channel' });
      }
      const session = await loadSession(channelId, currentSessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      // 取最近 N 轮 (默认 10), 转成 DistillTurn 格式
      const limit = Math.min(Math.max(recentTurns ?? 10, 2), 30);
      const turns = session.messages.slice(-limit).map((m) => ({
        role: (m.type === 'user' ? 'human' : 'agent') as 'human' | 'agent',
        content: m.content,
      }));

      const { distillAndStoreFromChannel } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const result = await distillAndStoreFromChannel(turns, { channelId });

      res.json({
        ok: true,
        triggered: result.triggered,
        reason: result.reason,
        judgment: result.judgment,
        evolved: result.evolved,
      });
    } catch (err: any) {
      console.error('[judgments] distill-from-conversation failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 蒸馏 D 触发 (AI 被动) — 后台异步,不阻塞 HTTP 响应
  app.post('/api/judgments/detect-and-distill', async (req, res) => {
    try {
      const { channelId, turns } = req.body as {
        channelId?: string;
        turns?: Array<{ role: 'human' | 'agent'; content: string }>;
      };

      // 先立即返回 202, 不等 LLM
      res.status(202).json({ ok: true, queued: true });

      if (!channelId || !Array.isArray(turns) || turns.length === 0) {
        return;
      }

      // 异步处理 (不 await, 不阻塞响应)
      setImmediate(async () => {
        try {
          const { detectAndDistillFromChannel } = await import(
            '../pi-ecosystem-judgment/human-value-pipeline.js'
          );
          const result = await detectAndDistillFromChannel(turns, { channelId });
          if (result.triggered) {
            console.log(`[D-hook] ${channelId}: ${result.reason}`, result.evolved);
          }
        } catch (err) {
          console.warn('[D-hook] background failed:', err);
        }
      });
    } catch (err: any) {
      console.error('[judgments] detect-and-distill failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 判断力使用回溯 (P0.5): 给定 judgmentIds, 反查对应的 decision 文本
  // 用途: UI 上"这条 AI 回复引用了哪些原则"
  app.post('/api/judgments/resolve-usage', async (req, res) => {
    try {
      const { ids } = req.body as { ids?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.json({ items: [] });
      }
      const { loadAllJudgments } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      const all = await loadAllJudgments();
      const byId = new Map(all.map((j) => [j.id, j]));
      const items = ids
        .map((id) => byId.get(id))
        .filter((j): j is NonNullable<typeof j> => Boolean(j))
        .map((j) => ({
          id: j.id,
          decision: j.decision,
          status: j.status ?? 'active',
          timestamp: j.timestamp,
        }));
      res.json({ items });
    } catch (err: any) {
      console.error('[judgments] resolve-usage failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 判断力违规日志 (P3 UI): 读 violations.jsonl
  app.get('/api/judgments/violations', async (req, res) => {
    try {
      const { getRecentViolations } = await import(
        '../pi-ecosystem-judgment/monitor-gate.js'
      );
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 200);
      const items = await getRecentViolations(limit);
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[judgments] violations failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 类 B 自适应扫描: 读 judgments.json + usage.jsonl, 给出 stale/rising/unused 建议
  // ?force=1 跳过 24h 缓存
  app.get('/api/judgments/adaptive-suggestions', async (req, res) => {
    try {
      const { getCachedScan } = await import(
        '../pi-ecosystem-judgment/adaptive-scan.js'
      );
      const force = String(req.query.force ?? '') === '1';
      const result = await getCachedScan(force);
      res.json(result);
    } catch (err: any) {
      console.error('[judgments] adaptive-scan failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Bootstrap Context 调试视图: 返出完整 BolloonContext
  app.get('/api/bolloon/context', async (req, res) => {
    try {
      const { getCachedBolloonContext } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const force = String(req.query.force ?? '') === '1';
      const ctx = await getCachedBolloonContext({ cwd: process.cwd() }, force);
      res.json(ctx);
    } catch (err: any) {
      console.error('[bolloon] context failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 阶段 B: 周报 (weekly-report.ts 产物) — 仅 API 读取, 不做 UI tab
  // GET /api/reports           → { files: ['2026-W24.md', ...] }
  // GET /api/reports/2026-W24  → { week, content }
  app.get('/api/reports', async (_req, res) => {
    try {
      const dir = path.join(os.homedir(), '.bolloon', 'reports');
      try {
        const entries = await fs.readdir(dir);
        const files = entries
          .filter((f) => f.endsWith('.md'))
          .sort()
          .reverse(); // 新的在前
        res.json({ dir, files });
      } catch {
        res.json({ dir, files: [] });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/:week', async (req, res) => {
    try {
      const week = req.params.week;
      // 严格校验, 防路径穿越
      if (!/^\d{4}-W\d{1,2}$/.test(week)) {
        return res.status(400).json({ error: 'week must match YYYY-Www' });
      }
      const file = path.join(os.homedir(), '.bolloon', 'reports', `${week}.md`);
      try {
        const content = await fs.readFile(file, 'utf-8');
        res.json({ week, content, length: content.length });
      } catch {
        res.status(404).json({ error: 'not found', week });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 阶段 C 护栏 5: auto-evolve baseline 管理 (无 UI, 仅 API)
  // GET    /api/auto-evolve/baselines             → 列出所有 baseline tag
  // GET    /api/auto-evolve/baselines/:tag/diff  → 看某 baseline 的 diff 摘要
  // POST   /api/auto-evolve/rollback {tag}       → 回滚到指定 baseline
  app.get('/api/auto-evolve/baselines', async (_req, res) => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const pExec = promisify(execFile);
      const { stdout } = await pExec('git', [
        'tag', '-l', 'auto-evolve-baseline-*', '--format=%(refname:short)|%(contents)|%(objectname:short)|%(taggerdate:iso)',
      ], { cwd: process.cwd() });
      const tags = stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [tag, msg, sha, date] = line.split('|');
        return { tag, message: msg || '', sha, date };
      });
      res.json({ tags, count: tags.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/auto-evolve/baselines/:tag/diff', async (req, res) => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const pExec = promisify(execFile);
      const tag = req.params.tag;
      if (!/^auto-evolve-baseline-[\w-]+$/.test(tag)) {
        return res.status(400).json({ error: 'tag must match auto-evolve-baseline-*' });
      }
      const { stdout } = await pExec('git', ['show', '--stat', '--no-color', tag], { cwd: process.cwd() });
      res.json({ tag, diff: stdout.slice(0, 5000) }); // 限长 5KB
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bootstrap Context → 拼好的 system prompt 片段 (供调试看注入效果)
  app.get('/api/bolloon/context/system-prompt', async (req, res) => {
    try {
      const { getCachedBolloonContext } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const { formatContextForSystemPrompt } = await import(
        '../bootstrap/project-context.js'
      );
      const ctx = await getCachedBolloonContext({ cwd: process.cwd() });
      const systemAddition = formatContextForSystemPrompt(ctx, {
        maxChars: parseInt(String(req.query.max ?? '4000'), 10) || 4000,
      });
      res.json({ systemAddition, length: systemAddition.length, truncated: systemAddition.includes('截断模式') });
    } catch (err: any) {
      console.error('[bolloon] context/system-prompt failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // system-prompt health (P-Action 2 — Harness Gardening)
  // 返回每层 lifecycle 状态: ok | stale | overdue-review | missing-frontmatter | dynamic
  // query: ?activeOnly=1 → 只返回当前 context 激活的层
  // ============================================================
  app.get('/api/prompt/health', async (req, res) => {
    try {
      const { listLayers } = await import('../llm/system-prompt/registry.js');
      const { evaluateLayers, markActive } = await import('../llm/system-prompt/health.js');
      const all = listLayers() as Array<any>;
      const baseReport = evaluateLayers(all);

      // 如果 query 里有 activeOnly, 跑一次 assembleSystemPrompt 拿激活列表
      if (String(req.query.activeOnly ?? '') === '1') {
        const { assembleSystemPrompt } = await import('../llm/system-prompt/registry.js');
        const channel = String(req.query.channel ?? 'local') as 'local' | 'p2p-visitor' | 'p2p-agent';
        const role = req.query.role as any;
        const tool = req.query.tool as any;
        try {
          const r = await assembleSystemPrompt({ channel, role, tool });
          const activeIds = new Set(r.layerIds);
          res.json(markActive(baseReport, activeIds));
        } catch (err: any) {
          console.warn('[prompt-health] assembleSystemPrompt failed (silent, returning base report):', err);
          res.json(baseReport);
        }
      } else {
        res.json(baseReport);
      }
    } catch (err: any) {
      console.error('[prompt-health] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 自适应接受/拒绝: 写 evolution.jsonl 留痕, 接受时同时 patch judgments.json
  // body: { action: 'accept'|'reject'|'revert', suggestion, appliedPatch? }
  // query: ?auto=1  → 类 B 自动路径, 受 auto-evolve-policy 网关保护
  //         缺省    → 用户在 UI 手动触发, 不查开关 (避免阻塞用户)
  app.post('/api/judgments/adaptive-apply', async (req, res) => {
    try {
      const isAuto = req.query.auto === '1' || req.query.auto === 'true';
      const { action, suggestion, appliedPatch } = req.body as {
        action: 'accept' | 'reject' | 'revert';
        suggestion: { judgmentId: string; kind: string; decision: string; reason: string; action: string; metrics: unknown; scannedAt: string; key: string };
        appliedPatch?: Record<string, unknown>;
      };
      if (!action || !suggestion?.judgmentId) {
        return res.status(400).json({ error: 'action and suggestion.judgmentId required' });
      }
      const { updateJudgmentStatus } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      const { logEvolution } = await import(
        '../pi-ecosystem-judgment/adaptive-scan.js'
      );
      // accept 时: 真正改库
      if (action === 'accept') {
        // 阶段 A: 自动路径需先过 auto-evolve-policy 网关
        if (isAuto) {
          const { requireDataLayerAutoEvolve } = await import(
            '../utils/auto-evolve-policy.js'
          );
          try {
            await requireDataLayerAutoEvolve('adaptive-apply.auto.deprecate');
          } catch (err: any) {
            return res.status(423).json({
              error: 'data-layer-auto-evolve-disabled',
              message: err.message,
              hint: '设 BOLLOON_AUTO_EVOLVE_DATA=1 或在 self-improve-policy.json 加 dataLayerAutoEvolve: true',
            });
          }
        }
        if (suggestion.action === 'deprecate') {
          // 标记 superseded (语义: 不再用, 但保留可回滚)
          await updateJudgmentStatus(suggestion.judgmentId, 'superseded', {
            evolutionReason: 'merged', // 借 merged 字段表达"被自适应废弃"
          });
        } else if (suggestion.action === 'boost') {
          // boost: 用户手动接受后, 不改库本身 (weight 在 getRelevantValues 里动态算),
          // 但写 evolution 留痕, 未来可以基于此调整算法
          // 当前不直接改库, 仅留痕
        }
        // 'review' 类不需要自动改库, 仅 log 接受
      }
      await logEvolution({
        ts: new Date().toISOString(),
        action,
        suggestion: suggestion as any,
        appliedPatch,
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[judgments] adaptive-apply failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 演化日志 (audit / 一键回滚源)
  app.get('/api/judgments/evolution-log', async (req, res) => {
    try {
      const { readEvolutionLog } = await import(
        '../pi-ecosystem-judgment/adaptive-scan.js'
      );
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
      const items = await readEvolutionLog(limit);
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[judgments] evolution-log failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 阶段 2: Causal-judge 4 个 endpoint
  app.get('/api/judgments/causal/correlation', async (req, res) => {
    try {
      const { runCorrelationAnalysis } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const topN = Math.min(Math.max(parseInt(String(req.query.topN ?? '5'), 10) || 5, 1), 50);
      const useLLM = String(req.query.useLLM ?? '1') !== '0';
      const items = await runCorrelationAnalysis({ topN, useLLM });
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[causal] correlation failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/judgments/causal/intervention', async (req, res) => {
    try {
      const { runIntervention } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const { judgmentId, scenario } = req.query as { judgmentId?: string; scenario?: string };
      if (!judgmentId) return res.status(400).json({ error: 'judgmentId required' });
      const result = await runIntervention(judgmentId, { scenarioContext: scenario });
      res.json(result);
    } catch (err: any) {
      console.error('[causal] intervention failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/judgments/causal/counterfactual', async (req, res) => {
    try {
      const { runCounterfactualAudit } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const { userInput, aiReply, violatedPrinciples } = req.body as {
        userInput?: string;
        aiReply?: string;
        violatedPrinciples?: Array<{ principle: string; reason: string }>;
      };
      if (!userInput || !aiReply) {
        return res.status(400).json({ error: 'userInput and aiReply required' });
      }
      const audit = await runCounterfactualAudit({
        userInput,
        aiReply,
        violatedPrinciples: violatedPrinciples ?? [],
      });
      res.json(audit);
    } catch (err: any) {
      console.error('[causal] counterfactual failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/judgments/causal/audit-log', async (req, res) => {
    try {
      const { readCounterfactualLog } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 200);
      const items = await readCounterfactualLog(limit);
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[causal] audit-log failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 导入判断: 接受 { filename, content (base64), context }.
  // 支持 .json / .yaml / .yml / .md / .txt / .html. 完全离线解析, 不调 LLM.
  // 解析规则:
  //   - .json: 顶层数组 [{decision, reason?, context?}, ...] 或 {judgments: [...]} 或 {items: [...]}
  //   - .yaml/.yml: 期望顶层数组 (用 js-yaml); 不支持复杂结构
  //   - .md/.txt/.html: 每一段 (按空行分隔) 算一条判断, 首行非空 = decision, 整段 = content
  //                     如果首行是 markdown 标题 (# ...) 则去掉 #, 整段去掉首行后作 reason
  app.post('/api/judgments/import', async (req, res) => {
    try {
      const { filename, content, context } = req.body as {
        filename?: string; content?: string; context?: { domain?: string; stakes?: string };
      };
      if (!filename || !content) {
        return res.status(400).json({ error: 'filename and content (base64) required' });
      }
      let raw: string;
      try { raw = Buffer.from(content, 'base64').toString('utf-8'); }
      catch { return res.status(400).json({ error: 'content is not valid base64' }); }

      const lower = filename.toLowerCase();
      let items: Array<{ decision: string; reason?: string; context?: any }> = [];
      if (lower.endsWith('.json')) {
        try {
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed) ? parsed
            : Array.isArray(parsed?.judgments) ? parsed.judgments
            : Array.isArray(parsed?.items) ? parsed.items
            : null;
          if (!arr) return res.status(400).json({ error: 'JSON must be an array, or {judgments:[]}/{items:[]}' });
          for (const it of arr) {
            if (it && typeof it.decision === 'string' && it.decision.trim()) {
              items.push({ decision: it.decision.trim(), reason: it.reason, context: it.context });
            }
          }
        } catch (e: any) {
          return res.status(400).json({ error: 'JSON parse failed: ' + e.message });
        }
      } else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        try {
          const yaml = (await import('js-yaml')).default;
          const parsed = yaml.load(raw);
          if (!Array.isArray(parsed)) return res.status(400).json({ error: 'YAML must be a top-level array' });
          for (const it of parsed) {
            if (it && typeof it.decision === 'string' && it.decision.trim()) {
              items.push({ decision: it.decision.trim(), reason: it.reason, context: it.context });
            }
          }
        } catch (e: any) {
          return res.status(400).json({ error: 'YAML parse failed: ' + e.message });
        }
      } else if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.html') || lower.endsWith('.htm')) {
        // 通用纯文本: 按空行分段, 每段是一条判断
        // 对 .html 先剥掉标签, 但保留段落分隔
        let text = raw;
        if (lower.endsWith('.html') || lower.endsWith('.htm')) {
          text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     // 块级标签 -> 双换行 (保留段落分隔)
                     .replace(/<\/?(p|div|h[1-6]|li|tr|br)[^>]*>/gi, '\n\n')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        }
        const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0);
        for (const block of blocks) {
          const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          if (lines.length === 0) continue;
          let decision = lines[0];
          // 如果首行是 markdown 标题, 去掉 # 前缀
          decision = decision.replace(/^#+\s*/, '');
          // 如果整段就是一个短句 (没有换行), 直接当 decision
          const reason = lines.length > 1 ? lines.slice(1).join(' ').trim() || undefined : undefined;
          if (decision) items.push({ decision, reason });
        }
      } else {
        return res.status(400).json({ error: 'unsupported file type (use .json .yaml .yml .md .txt .html)' });
      }

      if (items.length === 0) {
        return res.status(400).json({ error: 'no parseable judgments found in file' });
      }

      const { storeHumanJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();

      const imported: any[] = [];
      const errors: string[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const it = items[i];
          const j = await storeHumanJudgment({
            decision: it.decision,
            decision_type: 'approve',
            reasons: it.reason ? [String(it.reason)] : [],
            values_derived: [],
            context: {
              domain: it.context?.domain || context?.domain || 'general',
              complexity: 'moderate',
              stakes: (it.context?.stakes as any) || context?.stakes || 'medium',
              time_pressure: 'low',
            },
            metadata: {
              source: 'explicit',
              confidence: 0.8,
              revisable: true,
            },
          });
          imported.push(j);
        } catch (e: any) {
          errors.push(`#${i + 1} (${items[i].decision.substring(0, 30)}): ${e.message}`);
        }
      }

      res.json({ ok: true, imported: imported.length, failed: errors.length, errors: errors.slice(0, 5), judgments: imported });
    } catch (err: any) {
      console.error('[judgments] import failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 修改判断 (手动编辑 decision / reasons / context / values_derived)
  app.patch('/api/judgments/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { updateJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const updated = await updateJudgment(id, req.body || {});
      if (!updated) return res.status(404).json({ error: 'judgment not found' });
      res.json({ ok: true, judgment: updated });
    } catch (err: any) {
      console.error('[judgments] PATCH failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 删除判断
  app.delete('/api/judgments/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { deleteJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const ok = await deleteJudgment(id);
      if (!ok) return res.status(404).json({ error: 'judgment not found' });
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[judgments] DELETE failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 批量删除: { ids: ['hv-xxx', ...] } → { ok, deleted, notFound }
  app.post('/api/judgments/batch-delete', async (req, res) => {
    try {
      const ids = (req.body && Array.isArray(req.body.ids)) ? (req.body.ids as unknown[]) : null;
      if (!ids) return res.status(400).json({ error: 'ids array required' });
      const { deleteJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const idStrs = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
      let deleted = 0;
      const notFound: string[] = [];
      for (const id of idStrs) {
        const ok = await deleteJudgment(id);
        if (ok) deleted++; else notFound.push(id);
      }
      res.json({ ok: true, deleted, notFound });
    } catch (err: any) {
      console.error('[judgments] batch-delete failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // AI 自动委派: 根据新判断的 capability / context 找最匹配的远端 agent, 委派任务
  // 由前端在 POST /api/judgments 成功后调用 (fire-and-forget)
  // 出参: { matched, targetAgent, response | skipped, reason }
  app.post('/api/judgments/auto-delegate', async (req, res) => {
    try {
      const { judgmentId, capability, instruction } = req.body as {
        judgmentId?: string; capability?: string; instruction?: string;
      };
      if (!judgmentId && !capability) {
        return res.status(400).json({ error: 'judgmentId or capability required' });
      }
      const cap = capability || 'general';
      // 用 agent-manifest-protocol 里的 pickAgent (内存) — 走本节点已经缓存的远端 manifest
      const manifestMod = await import('../agents/agent-manifest-protocol.js');
      const picked = manifestMod.pickAgent(cap);
      if (!picked) {
        return res.json({ ok: true, matched: false, reason: 'no remote agent matches capability' });
      }
      // 命中后, 用 iroh delegate transport 真正发过去
      // 注: irohDelegateTransport.sendToNode 走的是 sendToNode(publicKey, frame, timeoutMs)
      // irohTransport 的 sendMessage 不等回包, 所以委托是 fire-and-forget
      // 想等回包需要新接口. 这里先把 "找得到目标 + 发送成功" 作为成功.
      // TODO: 接入 requestResponse 等待远端 agent_response
      try {
        const idMod = await import('../network/iroh-integration.js');
        const integ = idMod.getIrohIntegration();
        if (!integ || !integ.getNodeId()) {
          return res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: false, reason: 'iroh not initialized' });
        }
        // 用 pickAgent 选出来的 agent 关联的 irohNodeId (有的话), 没有就跳到本地自处理
        const targetIrohNodeId = picked.agent.irohNodeId;
        if (!targetIrohNodeId) {
          return res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: false, reason: 'target agent has no irohNodeId (peer identity not bound)' });
        }
        const ok = await integ.sendTo(targetIrohNodeId, 'agent_delegate', new TextEncoder().encode(JSON.stringify({
          type: 'agent_delegate',
          payload: {
            capability: cap,
            instruction: instruction || `请执行我的判断: ${judgmentId}`,
            fromAgentId: 'local-judgment',
          },
          ts: Date.now(),
          fromDid: '',
        })));
        res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: ok });
      } catch (e: any) {
        res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: false, error: e.message });
      }
    } catch (err: any) {
      console.error('[judgments] auto-delegate failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // (判断的 UI 已合并到主页面 header 的盾牌按钮 + modal, 不再走独立路由)

  // 启动看门狗监控
  if (watchdog) {
    // level 1 (内存爆) → 进程自杀, 依赖外层 supervisor / 用户重启 (Windows 任务计划/手动)
    // 否则 Node.js 高 GC 压力下 HTTP 响应丢失, 客户端 fetch 永远 pending
    watchdog.registerRestartStrategy(1, () => {
      // 2026-06-10: 改为不退出, 因为我们直接后台 tsx 启动没有外层 supervisor.
      // 误判主要因 recordActivity 仅在显式调用时刷新, 而 broadcast/SSE/连接均不触发.
      // 退出策略原文保留在注释里:
      //   console.error('[Watchdog] memory critical, 进程退出 (期望外层重启)');
      //   setTimeout(() => process.exit(1), 100);
      console.warn('[Watchdog] silentThreshold 触发, 但跳过 process.exit (无 supervisor)');
    });
    watchdog.start();
    console.log('[24h] Watchdog started');
  }

  // 定期健康检查（不阻塞主服务器启动）
  if (healthMonitor) {
    healthMonitor.startPeriodicCheck(60000);
    console.log('[24h] Health monitor periodic check started');
  }

  // ==================== Self-Improve 端点 ====================
  // 查看当前策略 (白名单 / 黑名单)
  app.get('/api/self-improve/policy', async (_req: any, res: any) => {
    const { loadPolicy } = await import('../agents/shell-guard.js');
    const policy = loadPolicy(true); // 强制重读
    if (!policy) {
      res.status(500).json({ error: '策略加载失败, 当前用硬编码兜底' });
      return;
    }
    res.json(policy);
  });

  // 更新策略 (白名单 / 黑名单)
  // **仅供人手动调用**, 不会暴露给 AI
  app.put('/api/self-improve/policy', async (req: any, res: any) => {
    const { writePolicy, auditShellCall } = await import('../agents/shell-guard.js');
    const newPolicy = req.body;
    if (!newPolicy || typeof newPolicy !== 'object') {
      res.status(400).json({ error: 'body 必须是对象' });
      return;
    }
    // 极简校验
    if (!Array.isArray(newPolicy.commandAllowlist) || !Array.isArray(newPolicy.pathAllowlist) || !Array.isArray(newPolicy.pathDenylist)) {
      res.status(400).json({ error: 'commandAllowlist/pathAllowlist/pathDenylist 必须是数组' });
      return;
    }
    try {
      const success = writePolicy(newPolicy);
      if (success) {
        auditShellCall('allowed', 'api:PUT:/api/self-improve/policy', [], `人类用户更新策略`);
        res.json({ ok: true, message: '策略已更新, 60 秒内生效' });
      } else {
        res.status(500).json({ error: '写入策略文件失败' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 查看审计日志
  app.get('/api/self-improve/audit', async (_req: any, res: any) => {
    try {
      const { POLICY_AUDIT_PATH_PUBLIC } = await import('../agents/shell-guard.js');
      const fs = await import('fs/promises');
      const auditPath = POLICY_AUDIT_PATH_PUBLIC;
      const exists = await fs.stat(auditPath).then(() => true).catch(() => false);
      if (!exists) {
        res.json([]);
        return;
      }
      const content = await fs.readFile(auditPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean).slice(-200); // 最近 200 条
      const entries = lines.map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
      res.json(entries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 手动触发 (供前端按钮 / 调试用)
  app.post('/api/self-improve/trigger', async (req: any, res: any) => {
    const { goal, kind } = req.body || {};
    const { reportSelfImproveEvent } = await import('../heartbeat/self-improve-bus.js');
    const result = reportSelfImproveEvent({
      kind: kind || 'user-requested',
      details: String(goal || '用户手动触发')
    });
    res.json(result);
  });

  // 事件历史 (供前端显示 / 调试)
  app.get('/api/self-improve/history', async (_req: any, res: any) => {
    const { getEventHistory } = await import('../heartbeat/self-improve-bus.js');
    res.json(getEventHistory());
  });

  // ============================================================
  // Permission Mode (P2.2 — UI 暴露开关)
  // 优先级: 运行时 session 覆盖 > env BOLLOON_PERM_MODE > 'default'
  // 运行时覆盖存在 ~/.bolloon/sessions/permission-mode.json, 每次 promptStream 入口读取
  // ============================================================

  const PERM_MODE_FILE = path.join(
    process.env.HOME || os.homedir() || '/tmp',
    '.bolloon', 'sessions', 'permission-mode.json'
  );

  function readPermModeOverride(): { mode: string; ts: string } | null {
    try {
      // 同步读, 文件很小
      const raw = fsSync.readFileSync(PERM_MODE_FILE, 'utf-8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj.mode === 'string') {
        return { mode: obj.mode, ts: obj.ts || new Date().toISOString() };
      }
    } catch { /* 不存在 = 无 override */ }
    return null;
  }

  function writePermModeOverride(mode: string): void {
    try {
      const dir = path.dirname(PERM_MODE_FILE);
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.writeFileSync(PERM_MODE_FILE, JSON.stringify({ mode, ts: new Date().toISOString() }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[server] writePermModeOverride failed:', err);
    }
  }

  // 读当前生效 mode (runtime override > env > default)
  app.get('/api/permission-mode', async (_req: any, res: any) => {
    const { resolvePermissionMode, ALL_PERMISSION_MODES } = await import('../agents/permission-mode.js');
    const override = readPermModeOverride();
    const envMode = process.env.BOLLOON_PERM_MODE || null;
    const effective = resolvePermissionMode();
    res.json({
      effective,
      override: override?.mode || null,
      overrideTs: override?.ts || null,
      env: envMode,
      allowed: ALL_PERMISSION_MODES,
      description: {
        default: '每次工具调用询问; shell 走 shell-guard',
        acceptEdits: 'edit_*/write_* 跳过黑名单; shell 仍走 shell-guard',
        bypassPermissions: '非 shell 全部放行; shell 永远走 shell-guard (硬约束)',
      },
    });
  });

  // 设 runtime override (存盘, 下次 promptStream 入口读取生效)
  app.post('/api/permission-mode', async (req: any, res: any) => {
    const { resolvePermissionMode, ALL_PERMISSION_MODES } = await import('../agents/permission-mode.js');
    const mode = String(req.body?.mode || '');
    if (!ALL_PERMISSION_MODES.includes(mode as any)) {
      return res.status(400).json({
        error: `Invalid mode. Allowed: ${ALL_PERMISSION_MODES.join(', ')}`,
        allowed: ALL_PERMISSION_MODES,
      });
    }
    const oldMode = readPermModeOverride()?.mode || process.env.BOLLOON_PERM_MODE || 'default';
    writePermModeOverride(mode);
    // 写历史 (append-only JSONL, 跟 bolloon 其他 audit 一致)
    try {
      const HISTORY_FILE = path.join(
        process.env.HOME || os.homedir() || '/tmp',
        '.bolloon', 'sessions', 'permission-mode-history.jsonl'
      );
      fsSync.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fsSync.appendFileSync(HISTORY_FILE, JSON.stringify({
        ts: new Date().toISOString(),
        from: oldMode,
        to: mode,
        source: 'api',
      }) + '\n', 'utf-8');
    } catch { /* 历史写失败不阻塞主流程 */ }
    console.log(`[server] permission-mode override set to "${mode}" via API (was "${oldMode}")`);
    res.json({
      ok: true,
      mode,
      previousMode: oldMode,
      ts: new Date().toISOString(),
      note: '新 mode 在下一次 promptStream 入口生效 (不打断当前对话)',
    });
  });

  // 取消 runtime override, 回到 env 或 default
  app.delete('/api/permission-mode', async (_req: any, res: any) => {
    const oldMode = readPermModeOverride()?.mode || process.env.BOLLOON_PERM_MODE || 'default';
    try {
      if (fsSync.existsSync(PERM_MODE_FILE)) fsSync.unlinkSync(PERM_MODE_FILE);
    } catch (err) {
      console.warn('[server] delete perm-mode override failed:', err);
    }
    // 写历史
    try {
      const HISTORY_FILE = path.join(
        process.env.HOME || os.homedir() || '/tmp',
        '.bolloon', 'sessions', 'permission-mode-history.jsonl'
      );
      fsSync.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fsSync.appendFileSync(HISTORY_FILE, JSON.stringify({
        ts: new Date().toISOString(),
        from: oldMode,
        to: 'env-or-default',
        source: 'api',
        action: 'delete-override',
      }) + '\n', 'utf-8');
    } catch { /* ignore */ }
    res.json({ ok: true, note: '已删除 runtime override, 回到 env / default' });
  });

  // 历史 (类似 self-improve history, 供前端 timeline)
  app.get('/api/permission-mode/history', async (_req: any, res: any) => {
    const HISTORY_FILE = path.join(
      process.env.HOME || os.homedir() || '/tmp',
      '.bolloon', 'sessions', 'permission-mode-history.jsonl'
    );
    try {
      if (!fsSync.existsSync(HISTORY_FILE)) return res.json([]);
      const lines = fsSync.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
      const entries = lines.map((l: string) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.json(entries.slice(-50));  // 最近 50 条
    } catch (err) {
      res.json([]);
    }
  });

  // 健康检查错误数 ≥ 2 -> 触发自改信号
  if (healthMonitor) {
    healthMonitor.startPeriodicCheck(60000, (status: any) => {
      const errorCount = Object.values(status.checks as Record<string, { status: string }>)
        .filter((c) => c.status === 'error').length;
      if (errorCount >= 2) {
        import('../heartbeat/self-improve-bus.js').then(({ reportSelfImproveEvent }) => {
          const failedKeys = Object.entries(status.checks as Record<string, { status: string }>)
            .filter(([_, c]) => c.status === 'error').map(([k]) => k).join(', ');
          reportSelfImproveEvent({
            kind: 'silent-timeout',
            details: `健康检查有 ${errorCount} 项失败: ${failedKeys}`
          });
        });
      }
    });
  }

  // 安装自改总线 -> SSE 桥
  void installSelfImproveHook();

  // 端口冲突时自动找下一个可用端口（最多 10 次），避免 EADDRINUSE 直接崩溃
  return new Promise<{ app: express.Express; server: ReturnType<typeof createServer>; port: number }>((resolve, reject) => {
    const maxAttempts = 10;
    const startPort = port;
    let currentPort = startPort;
    let attempt = 0;
    // 局部可变 server 引用 — listen 失败后必须重新 createServer 再 listen
    let currentServer: ReturnType<typeof createServer> = server;

    const tryListen = () => {
      currentServer.removeAllListeners('error');
      currentServer.once('error', onError);
      currentServer.listen(currentPort, () => {
        if (currentPort !== startPort) {
          console.warn(`⚠ 端口 ${startPort} 被占用，已自动切换到 ${currentPort}`);
        }
        console.log(`Web 服务器启动完成: http://localhost:${currentPort}`);
        console.log('服务器已监听');
        // 安装 chat bus -> SSE 桥 (供前端 inbox UI 实时刷新)
        void installChatBusHook();
        setInterval(() => {
          for (const client of sseClients) {
            client.res.write(': ping\n\n');
          }
        }, 30000);
        resolve({ app, server: currentServer, port: currentPort });
      });
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (err && err.code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
        attempt += 1;
        const nextPort = currentPort + 1;
        console.log(`⚠ 端口 ${currentPort} 被占用，尝试 ${nextPort}...`);
        try { currentServer.close(); } catch { /* ignore */ }
        // 重新创建 server 实例（listen 失败后原 server 无法再次 listen）
        currentServer = createServer(app);
        currentPort = nextPort;
        tryListen();
      } else {
        reject(err);
      }
    };

    tryListen();
  });
}

function broadcast(data: { type: string; [key: string]: unknown }, channelId?: string) {
  // 2026-06-10: 喂 watchdog, 避免 30min 空闲被误判 (recordActivity 内有 5s 去抖)
  watchdogRef?.recordActivity?.();
  const envelope = { ...data, channelId };
  const message = `data: ${JSON.stringify(envelope)}\n\n`;
  console.log(`[broadcast] type=${data.type}, channelId=${channelId}, clients=${sseClients.size}`);
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
async function installChatBusHook(): Promise<void> {
  if (chatBusHookInstalled) return;
  chatBusHookInstalled = true;
  try {
    const { chatEventBus } = await import('../agents/p2p-chat-tools.js');
    chatEventBus.on('chat', (ev: any) => {
      // 推送给所有 SSE 客户端 (channelId 留空 = 广播)
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
async function installSelfImproveHook(): Promise<void> {
  if (selfImproveHookInstalled) return;
  selfImproveHookInstalled = true;
  try {
    const { onSelfImproveTrigger } = await import('../heartbeat/self-improve-bus.js');
    const { runSelfImproveLoop } = await import('../agents/pi-sdk.js');

    // 监听自改事件 -> 跑循环 + 广播到前端
    onSelfImproveTrigger(async (event, goal) => {
      broadcast({
        type: 'self_improve_triggered',
        eventKind: event.kind,
        details: event.details,
        goal,
        ts: Date.now()
      }, undefined);

      // 实际跑循环 (创分支等)
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

function getUserName(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const match = home.match(/\/Users\/(\w+)/);
  if (match) return match[1];
  const user = process.env.USERNAME || process.env.USER || 'user';
  return user.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function bootstrapIdentity() {
  console.log('🔐 身份生成...');
  const kp = KeyManager.generate();
  const did = kp.did;
  const username = getUserName();
  const suffix = did.split(':').pop()?.substring(0, 4);
  const name = `blln-${username}-${suffix}`;
  console.log(`   DID: ${did.substring(0, 30)}...`);
  return { keypair: kp, did, name };
}

export function publishDIDBackground(name: string, kp: any) {
  console.log('📝 IPNS注册(后台)...');
  let retries = 0;

  const attempt = async () => {
    try {
      const auth = await AgentAuthManager.newWithRemoteIpfs('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
      await auth.registerAgent({ name, services: [] }, kp, '');
      console.log('✅ IPNS注册成功');
    } catch (e: any) {
      retries++;
      if (retries < 10) {
        setTimeout(attempt, 60000);
      }
    }
  };

  setTimeout(attempt, 100);
}

export async function bootstrapP2P(verifier: AgentVerificationManager): Promise<HyperswarmCommunicator> {
  console.log('🌐 P2P连接...');
  const rawSeed = crypto.getRandomValues(new Uint8Array(32));
  const comm = createHyperswarmCommunicator({ server: true, client: true, autoConnect: true, maxConnections: 50, seed: rawSeed } as any);

  await comm.start();
  const topic = createTopic('bolloon-agent-harness') as Buffer;
  await comm.joinTopic(topic);
  console.log('   P2P已就绪');

  return comm;
}

export async function openBrowser(url: string) {
  const { exec } = await import('child_process');
  const { platform } = await import('os');
  const p = platform();

  let cmd;
  if (p === 'darwin') {
    cmd = `open ${url}`;
  } else if (p === 'win32') {
    cmd = `start ${url}`;
  } else {
    cmd = `xdg-open ${url}`;
  }

  exec(cmd, (err) => {
    if (err) {
      console.error('打开浏览器失败:', err.message);
    }
  });
}
