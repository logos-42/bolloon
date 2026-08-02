import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  validateMessageInput,
  validateChannelInput,
  healthCheck,
} from './input-validator.js';
import { segmentChatReply, type ChatSegment } from '../agents/chat-segmenter.js';
import { registerJudgmentsRoutes } from './routes-judgments.js';
import { registerLlmConfigRoutes } from './routes-llm-config.js';
import { registerExternalEngineRoutes } from './routes-external-engines.js';
import { registerTaskRoutes } from './routes-tasks.js';
import { loadPeerTier, recordInteraction, recordViolation, checkToolAccess, tierLabel } from '../social/dunbar-tier.js';
import { registerHearthRoutes } from './routes-hearth.js';
import { loadOrCreateAgentIdentity } from '../agents/agent-identity.js';

// 2026-07-06: 类型抽到 ./server-types.ts (channel / session / task / sse client / iroh info / paths)
import {
  type Channel,
  type Session,
  type SessionMessage,
  type SessionSummary,
  type Task,
  type IrohNodeInfo,
  type CreateWebServerOptions,
  type SSEClient,
  CHANNELS_PATH,
  SESSION_CACHE_PATH,
  SHARED_SESSION_PATH,
  THEME_PATH,
  TASK_QUEUE_PATH,
  IPFS_ENDPOINT,
} from './server-types.js';
// 同时也 re-export 出去 (其它地方可能从 './server.js' 引用)
export {
  type Channel,
  type Session,
  type SessionMessage,
  type SessionSummary,
  type Task,
  type IrohNodeInfo,
  type CreateWebServerOptions,
  type SSEClient,
  CHANNELS_PATH,
  SESSION_CACHE_PATH,
  SHARED_SESSION_PATH,
  THEME_PATH,
  TASK_QUEUE_PATH,
  IPFS_ENDPOINT,
} from './server-types.js';

// 读自身 package.json 拿 version (health endpoint 用)
//   路径: src/web/server.ts → ../../package.json (编译后 dist/web/server.js)
let cachedVersion: string | null = null;
function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = fileURLToPath(import.meta.url);
    const hereDir = path.dirname(here);
    // 试 ../package.json (相对 dist/web/) 或 ../../package.json (相对 src/web/)
    let raw: string | null = null;
    for (const rel of ['../package.json', '../../package.json']) {
      try {
        raw = fsSync.readFileSync(path.join(hereDir, rel), 'utf-8');
        break;
      } catch {}
    }
    cachedVersion = raw ? ((JSON.parse(raw).version as string) ?? '0.0.0') : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

// 2026-06-17: 终端静默 — server.ts 高频 spam (LLM 流式每个 token 一次 broadcast,
// 每次 P2P 收发 [v3]/[v3-meta]/[v3-cross]/[v3-friend] 各一次) 全部走 console.log proxy,
// 默认 (BOLLOON_VERBOSE != '1') 完全不打;VERBOSE=1 时恢复.
// 注意: console.error 走原生,所有错误仍然可见.
const VERBOSE = process.env.BOLLOON_VERBOSE === '1';
const SUPPRESSED_LOG_PREFIXES = [
  '[broadcast]',
  '[SSE 广播]',
  '[API] /channels',
  '[获取频道]',
  '[v3]',
  '[v3-meta]',
  '[v3-cross]',
  '[v3-friend]',
  '[v3-async]',
  '[saveChannels]',
];
const _origConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]): void => {
  if (VERBOSE) return _origConsoleLog(...args);
  const first = args[0];
  if (typeof first === 'string') {
    for (const p of SUPPRESSED_LOG_PREFIXES) {
      if (first.startsWith(p)) return;
    }
  }
  return _origConsoleLog(...args);
};
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
// 2026-07-05: peer 目录管理 + manifest 协议
import * as peerFs from '../network/peer-fs.js';
import { buildManifestPayload, type AgentManifest, type AgentManifestEntry, type ManifestGroup, type ManifestFunction, type ManifestExportment, type ManifestScience } from '../agents/agent-manifest-protocol.js';
import { loadLocalResources, writeRemoteResources } from '../network/peer-resource-bridge.js';

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

// iroh P2P 状态

let irohNodeInfo: IrohNodeInfo | null = null;
let irohInitialized = false;









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

// 2026-07-06: loadChannels / saveChannels / loadSession / saveSession / loadTheme / saveTheme
// 已抽到 ./server-storage.ts — 这里只保留旧引用供 createWebServer 内部闭包使用
// TODO: 后续让所有调用走 import, 然后删除这段冗余定义
import {
  loadChannels as _loadChannels,
  saveChannels as _saveChannels,
  loadSession as _loadSession,
  saveSession as _saveSession,
  loadTheme as _loadTheme,
  saveTheme as _saveTheme,
  getLastChannelsWriteAt,
  updateChannels,
} from './server-storage.js';

// 包装成闭包内可用的形式, 保持 createWebServer 内代码不用改
const loadChannels = _loadChannels;
const saveChannels = _saveChannels;
const loadSession = _loadSession;
const saveSession = _saveSession;
const loadTheme = _loadTheme;
const saveTheme = _saveTheme;
// 2026-07-06: Task Queue 已抽到 ./routes-tasks.ts + ./server-storage.ts


let sseClients: Set<SSEClient> = new Set();
// v3: 远端 channel UI 元数据缓存 — key: peerId, value: sanitize 过的 channel 列表
// in-memory only, 进程重启清空 (judgment 内容永远不在这里)
let remoteChannelCache: Map<string, Array<Record<string, unknown>>> = new Map();

// 2026-08-02: 待处理好友申请 (pending friend requests) — 收到 agent.friend.request 时暂存,
//   人类通过 UI 处理, 智能体通过工具 list_pending_friend_requests / accept_friend_request 处理。
//   key: requestId, value: 申请详情 (含 fromPublicKey / name / message / 备注)
const pendingFriendRequests: Map<string, {
  requestId: string;
  fromPublicKey: string;
  fromName: string;
  message: string;
  note?: string;         // 2026-08-02: 申请方填的备注 (自我介绍 / 来源)
  receivedAt: number;
}> = new Map();

// 2026-07-05: 一次性 prompt 附加块 — key: channelId, value: 下一次 LLM prompt 时 prepend 的内容
//   用于 manifest-loader 加载对方能力后, 仅影响本次对话, 不污染主 prompt
const nextPromptHints: Map<string, string> = new Map();

// 2026-07-05: 直接读 ~/.bolloon/agents/agents.json, 跳过 subagent-manager 的 lazy init
//   原因: getSubAgentManager().getAllAgents() 只在 SubAgentManager.initialize() 后才加载,
//   但没人调 initialize(), 永远返回 []. 这里用 raw 文件 IO 直接拿数据.
async function loadLocalSubAgents(): Promise<any[]> {
  try {
    const fsPromises = await import('fs/promises');
    const path = await import('path');
    const home = process.env.BOLLOON_HOME || process.env.HOME || '/tmp';
    const file = path.join(home, '.bolloon', 'agents', 'agents.json');
    const raw = await fsPromises.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    process.stderr.write(`[LOADED] ${arr.length} agents from ${file}\n`);
    return arr;
  } catch (e: any) {
    process.stderr.write(`[LOAD FAIL] ${e?.message}\n`);
    return [];
  }
}

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

// 2026-08-02: pending 好友申请持久化 — 重启后智能体/人类仍能看到未处理的申请
const PENDING_FRIEND_REQ_FILE = `${process.env.HOME || '/tmp'}/.bolloon/pending-friend-requests.json`;
async function loadPendingFriendRequestsFromDisk(): Promise<void> {
  try {
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (!existsSync(PENDING_FRIEND_REQ_FILE)) return;
    const raw = await readFile(PENDING_FRIEND_REQ_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [reqId, r] of Object.entries(obj)) {
        if (r && typeof r === 'object' && (r as any).fromPublicKey) {
          pendingFriendRequests.set(reqId, r as any);
        }
      }
      console.log(`[v3-friend] 从磁盘恢复 ${pendingFriendRequests.size} 个待处理好友申请`);
    }
  } catch (err) {
    console.warn('[v3-friend] 恢复 pending 好友申请失败 (非致命):', (err as Error).message);
  }
}
async function persistPendingFriendRequests(): Promise<void> {
  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (!existsSync(`${process.env.HOME || '/tmp'}/.bolloon`)) {
      await mkdir(`${process.env.HOME || '/tmp'}/.bolloon`, { recursive: true });
    }
    const obj: Record<string, unknown> = {};
    for (const [reqId, r] of pendingFriendRequests.entries()) {
      obj[reqId] = r;
    }
    await writeFile(PENDING_FRIEND_REQ_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[v3-friend] 持久化 pending 好友申请失败 (非致命):', (err as Error).message);
  }
}
// 启动时恢复 (异步, 不阻塞主流程)
loadPendingFriendRequestsFromDisk();
// v3: P2PDirect 引用 (Hyperswarm 薄包装) - 模块级, 因为 web server 闭包里不可用
let v3P2PRef: import('../network/p2p-direct.js').P2PDirect | null = null;
// 2026-07-21: 智能体社交心跳实例 (beacon + 自主决策发起对话), data 事件处理器会引用它
let agentHeartbeat: import('../social/agent-heartbeat.js').AgentHeartbeat | null = null;
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
        const rpcPayload = {
          targetChannelId: remoteTarget.id,
          targetChannelName: remoteTarget.name,
          originChannelId,
          originChannelName,
          text,
          fromPublicKey: v3P2PRef.getPublicKey()
        };
        // 2026-07-05: 用 outbox.sendOrQueue 兜底 — 对方不在线时自动入队, 上线后批量重发
        const { sendOrQueue } = await import('../network/p2p-outbox.js');
        const r = await sendOrQueue(ownerPk, 'agent.cross.post', rpcPayload, v3P2PRef);
        if (r === 'SENT') {
          console.log(`[v3-cross] (${originChannelName}) @${targetName} → 远端 peer ${ownerPk.substring(0,12)}... (channelId=${remoteTarget.id})`);
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'sent' });
        } else if (r === 'QUEUED') {
          console.log(`[v3-cross] (${originChannelName}) @${targetName} → 远端 peer ${ownerPk.substring(0,12)}... 已入队 (对方不在线)`);
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'queued' });
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
    const { channelId, text, fromPublicKey, autoInvokeTools } = parsed.payload || {};
    if (!channelId || !text) {
      console.warn(`[v3] agent.chat.send 缺少 channelId/text`);
      return;
    }
    const senderKey = fromPublicKey || peerKey;
    // 2026-08-02: 发送方工具开关 (P2P 对话栏的 🔧 toggle) — 显式 false 时远端消息不调工具
    const remoteToolsOverride = typeof autoInvokeTools === 'boolean' ? autoInvokeTools : null;

    // 2026-07-29: Dunbar Tier 检查 — 远端 agent 不能触发禁区工具
    const tierState = await loadPeerTier(senderKey);
    if (tierState.tier === 'blocked') {
      const reply = JSON.stringify({
        v: 3, op: 'agent.chat.reply',
        payload: { channelId, fromPublicKey: v3P2PRef?.getPublicKey() || '', error: 'blocked', text: '❌ 您已被本地系统加入通信黑名单。如需解除请联系系统管理员。' }
      });
      await comm.sendToConnection(conn.id, reply);
      return;
    }
    // 2026-07-29: 语义分析 — 分析远端聊天内容, 隐式滑动 trustScore
    recordInteraction(senderKey, text).catch(() => {});

    console.log(`[v3] 收到 ${senderKey.substring(0,12)}... (${tierLabel(tierState.tier)}) 对 channel ${channelId} 的 chat: "${text.substring(0, 40)}..."`);

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

      // 2026-07-05: 同时追加到 sender 的 peer 月度归档 — 让 A 本地的"与 sender 对话历史"也能离线查看
      try {
        const { appendChatArchive } = await import('../bootstrap/chat-archiver.js');
        const chanObj = (await loadChannels()).find(c => c.id === channelId);
        await appendChatArchive({
          publicKey: senderKey,
          entry: {
            ts: new Date().toISOString(),
            source: 'remote',
            channelId, channelName: chanObj?.name,
            text,
            fromPublicKey: senderKey,
            msgType: 'user',
          }
        });
        // 顺手把 sender 加入 known peers (如果没有)
        const { addOrUpdatePeer } = await import('../network/known-peers.js');
        await addOrUpdatePeer(undefined, senderKey);
      } catch (archiveErr: any) {
        console.warn('[chat-archive] remote user 归档失败 (non-fatal):', archiveErr?.message?.slice(0, 200));
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
      // 2026-06-15: P2P 远端访客路径也用显式 marker 包裹 text
      // 2026-06-15 二次修: 把 text 放在最前 (与主路径 server.ts:1868 对齐),
      //   避免 LLM 被 judgmentHint 末尾的 "..." 误判为整个 input 被截断
      // 2026-08-02: 发送方工具开关 (P2P 🔧 toggle) — false 时禁止本轮工具调用
      const toolsGateHint = remoteToolsOverride === false
        ? '\n[系统指令] 本轮对话**禁止调用任何工具**, 直接基于已有知识回答即可.\n\n'
        : '';
      const fullPrompt = `【本轮用户请求】\n${text}\n【请求结束】\n\n${visitorHint}${dirHint}${toolsGateHint}${judgmentHint}\n`;
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
        // 2026-08-02 fix: 远端路径转发 step 事件 (工具调用过程) — 之前只转 token,
        //   B 端 P2P 对话看不到工具调用步骤. 复用 agent.chat.thinking 的 phase=step 通道.
        else if (event.type === 'step_start' || event.type === 'step_done' || event.type === 'step_error') {
          const msg = JSON.stringify({
            v: 3, op: 'agent.chat.thinking',
            payload: {
              channelId,
              phase: 'step',
              stepType: event.type,
              tool: event.tool,
              content: event.content,
              success: event.success,
              output: event.output,
              error: event.error,
              args: event.args,
              fromPublicKey: v3P2PRef?.getPublicKey() || ''
            }
          });
          comm.sendToConnection(conn.id, msg).catch(() => {});
        }
      };
      const agent = await getAgentForChannel(channelId, ch.did || '', ch.name, ch.didDocRef);
      fullResponse = await agent.promptStream(fullPrompt, streamCallback, undefined, channelId);

      // 2026-07-06: 防御性兜底
      if (!fullResponse.trim()) {
        fullResponse = '⚠️ AI 未返回内容, 请重试';
      }

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

      // 2026-07-05: A 的 assistant 回复也归档到 sender 的月度 — 这样 sender 本地也有一份"与 A 的对话"
      try {
        const { appendChatArchive } = await import('../bootstrap/chat-archiver.js');
        const chanObj = (await loadChannels()).find(c => c.id === channelId);
        await appendChatArchive({
          publicKey: senderKey,
          entry: {
            ts: new Date().toISOString(),
            source: 'ai-mention-remote',
            channelId, channelName: chanObj?.name,
            text: `[${v3P2PRef?.getPublicKey()?.slice(0, 12)}…] ${fullResponse.slice(0, 1500)}`,
            fromPublicKey: v3P2PRef?.getPublicKey(),
            msgType: 'ai',
          }
        });
      } catch (archiveErr: any) {
        console.warn('[chat-archive] remote ai 归档失败 (non-fatal):', archiveErr?.message?.slice(0, 200));
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

  // v3 新增: --collab CLI 派任务过来, 对方 web 收到后跑 LLM 干活, 回结果
  if (op === 'agent.collab.run') {
    const { requestId, task, fromPublicKey, fromRole, timeoutMs } = parsed.payload || {};
    if (!requestId || !task) {
      console.warn(`[v3-collab] agent.collab.run 缺少 requestId/task`);
      return;
    }
    const senderKey = fromPublicKey || peerKey;
    console.log(`[v3-collab] 收到 ${senderKey.substring(0, 12)}... (${fromRole}) 的协作任务: "${task.substring(0, 60)}..."`);
    const startTs = Date.now();
    try {
      // 调 LLM: 走 getAgentForChannel 拿 agent, 用 prompt() 拿 string 结果
      const visitorHint = `[系统上下文] 协作任务来源: 远端 peer (P2P, publicKey=${senderKey.substring(0, 12)}..., role=${fromRole || 'unknown'}). 这是通过 P2P 派过来的协作任务, 回答后会自动回到对方那里. 简洁完成, 不需要反问.\n\n`;
      const fullPrompt = `【本轮协作任务】\n${task}\n【任务结束】\n\n${visitorHint}`;
      // 临时用 channelId = "__collab__" 拿个一次性 agent
      const collabChannelId = `__collab_${senderKey.substring(0, 8)}__`;
      const agent = await getAgentForChannel(collabChannelId, '', `collab-${senderKey.substring(0, 8)}`, undefined);
      const resultText = await agent.prompt(fullPrompt);
      const reply = JSON.stringify({
        v: 3,
        op: 'agent.collab.reply',
        payload: {
          requestId,
          fromPublicKey: v3P2PRef?.getPublicKey() || '',
          result: resultText || '(empty)',
          durationMs: Date.now() - startTs,
        },
      });
      await comm.sendToConnection(conn.id, reply);
      console.log(`[v3-collab] 已回 reply (${Date.now() - startTs}ms, ${(resultText || '').length} chars)`);
    } catch (e: any) {
      console.error(`[v3-collab] 处理失败:`, (e as Error).message);
      try {
        const errReply = JSON.stringify({
          v: 3, op: 'agent.collab.reply',
          payload: { requestId, fromPublicKey: v3P2PRef?.getPublicKey() || '', error: (e as Error).message, result: '' }
        });
        await comm.sendToConnection(conn.id, errReply);
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

      // 2026-07-05: 跨渠道 @-mention 也归档到 fromPublicKey 的月度 — 本节点 owner 看月度历史能还原跨节点对话
      if (fromPublicKey) {
        try {
          const { appendChatArchive } = await import('../bootstrap/chat-archiver.js');
          await appendChatArchive({
            publicKey: fromPublicKey,
            entry: {
              ts: new Date().toISOString(),
              source: 'ai-mention-remote',
              channelId: targetChannelId, channelName: targetChannelName,
              text: `[跨渠道] from ${originChannelName}: ${text.slice(0, 1500)}`,
              fromPublicKey,
              msgType: 'ai',
            }
          });
        } catch (archiveErr: any) {
          console.warn('[chat-archive] cross.post 归档失败 (non-fatal):', archiveErr?.message?.slice(0, 200));
        }
      }
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

  // ============== 2026-07-05: agent.manifest.exchange ==============
  // 对方问: "给我你的 agent 清单 + capabilities"
  // 我们回: agent.manifest.exchange.reply, 含本地 SubAgent + persona 描述
  if (op === 'agent.manifest.exchange') {
    try {
      // 直接读 agents.json, 跳过 subagent-manager 的 lazy initialize
      const localAgents = await loadLocalSubAgents();
      // 转成 AgentManifestEntry
      const entries: AgentManifestEntry[] = localAgents.map((a: any) => ({
        id: a.id,
        name: a.name,
        capabilities: a.capabilities || [],
        status: a.status || 'active',
        peerId: a.peerId,
        irohNodeId: a.irohNodeId,
        sessionId: a.sessionId,
        cid: a.cid,
        ipnsName: a.ipnsName,
      }));
      // 读本地 persona 拿 owner 名字 + 简介
      let ownerName = '';
      let ownerDescription = '';
      try {
        const { readFileSync, existsSync } = await import('fs');
        const p = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');
        if (existsSync(p)) {
          const pj = JSON.parse(readFileSync(p, 'utf-8'));
          ownerName = pj.name || '';
          ownerDescription = pj.description || '';
        }
      } catch {}
      const manifest: AgentManifest = {
        ownerName,
        ownerDescription,
        ownerPublicKey: v3P2PRef?.getPublicKey() || '',
        agents: entries,
        publishedAt: Date.now(),
        ...(await loadLocalResources()),
      };
      const reply = JSON.stringify({
        v: 3, op: 'agent.manifest.exchange.reply',
        payload: {
          manifest,
          since: parsed.payload?.since || 0,
        }
      });
      await comm.sendToConnection(conn.id, reply);
      // 2026-07-05: P2PDirect.sendToWithWait 双发 (兼容同机 P2PDirect 互不相连场景)
      if (v3P2PRef && peerKey) {
        try {
          const r = await v3P2PRef.sendToWithWait(peerKey, reply, 2000);
          console.log(`[v3-manifest] 回 ${peerKey.substring(0,12)}... manifest (comm=${await comm.sendToConnection.length}, p2p=${r}, ${entries.length} agents)`);
        } catch {}
      } else {
        console.log(`[v3-manifest] 回 ${peerKey.substring(0,12)}... manifest (${entries.length} agents, owner=${ownerName || '?'})`);
      }
    } catch (err) {
      console.error('[v3-manifest] 处理 agent.manifest.exchange 失败:', (err as Error).message);
    }
    return;
  }

  // 对方推 manifest 过来 (我们这边是接收方)
  if (op === 'agent.manifest.exchange.reply') {
    try {
      const manifest = parsed.payload?.manifest as AgentManifest;
      if (!manifest || !manifest.ownerPublicKey) {
        console.warn('[v3-manifest] manifest.exchange.reply 缺 manifest/ownerPublicKey');
        return;
      }
      // 2026-07-05 修复: 跳过自己的 manifest (Hyperswarm 内部 peer discovery 会推送自己)
      const peerKey2 = manifest.ownerPublicKey;
      if (v3P2PRef && peerKey2 === v3P2PRef.getPublicKey()) {
        return;
      }
      // 增量: 如果 since >= 本地最新 ts, 跳过
      const existing = await peerFs.readPeerIndex(peerKey2);
      if (existing?.manifestTs && existing.manifestTs >= manifest.publishedAt && parsed.payload?.since) {
        console.log(`[v3-manifest] ${peerKey2.substring(0,12)}... manifest 已是最新 (ts=${manifest.publishedAt}), 跳过`);
        return;
      }
      // 写 peer.json + _index.json + 每个 agent 的 md
      await peerFs.upsertPeer({
        publicKey: peerKey2,
        name: manifest.ownerName,
        lastSeenAt: new Date().toISOString(),
        lastManifestTs: manifest.publishedAt,
        manifestCount: (await peerFs.getPeer(peerKey2))?.manifestCount ?? 0 + 1,
      });
      // 拼 _index.json
      const ownerDescription = (manifest as any).ownerDescription || '';
      const idx: peerFs.PeerIndexFile = {
        version: 1,
        publicKey: peerKey2,
        ownerName: manifest.ownerName,
        ownerDescription,
        agents: manifest.agents as peerFs.PeerAgentEntry[],
        groups: manifest.groups,
        functions: manifest.functions,
        exportments: manifest.exportments,
        updatedAt: new Date().toISOString(),
        manifestTs: manifest.publishedAt,
      };
      await peerFs.writePeerIndex(peerKey2, idx);
      // 每个 agent 写一份 markdown
      for (const a of manifest.agents) {
        await peerFs.writeAgentDescription(peerKey2, a as peerFs.PeerAgentEntry, ownerDescription);
      }
      // 2026-07-05: 4 类资源 (groups/function/exportment/science) 也落盘
      const counts = await writeRemoteResources(peerKey2, manifest);
      // capability-index.md (≤500 字, 进 prompt)
      await peerFs.writeCapabilityIndex(peerKey2, idx);
      console.log(`[v3-manifest] 收到 ${peerKey2.substring(0,12)}... manifest (${manifest.agents.length} agents, owner=${manifest.ownerName || '?'}, +g${counts.groups}/f${counts.functions}/e${counts.exportments}/s${counts.sciences}) → 落盘`);
      // 推 SSE 让前端知道"对方能力刷新了"
      broadcast({
        type: 'peer-manifest-updated',
        fromPublicKey: peerKey2,
        ownerName: manifest.ownerName,
        agentCount: manifest.agents.length,
        capabilityIndex: await peerFs.readCapabilityIndex(peerKey2),
      }, 'p2p-global');
    } catch (err) {
      console.error('[v3-manifest] 处理 manifest.exchange.reply 失败:', (err as Error).message);
    }
    return;
  }

  // 对方问: "给我某个 agent 的详细描述" (markdown 全文)
  if (op === 'agent.resource.get') {
    try {
      const agentId = parsed.payload?.agentId;
      if (!agentId) return;
      // 2026-07-05: 4 类资源 (group/function/exportment/science) 也走同一个 RPC
      // 识别方式: id 前缀 group:/fn:/game:/exp:  → 读 ~/.bolloon/local-resources/<cat>/<id>.md
      let body = '';
      const prefixMatch = String(agentId).match(/^(group|fn|game|exp):(.+)$/);
      if (prefixMatch) {
        const cat = prefixMatch[1] === 'fn' ? 'functions'
                  : prefixMatch[1] === 'game' ? 'exportments'
                  : prefixMatch[1] === 'exp' ? 'sciences'
                  : 'groups';
        try {
          const fsPromises = await import('fs/promises');
          const safe = String(prefixMatch[2]).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          const file = path.join(process.env.HOME || '/tmp', '.bolloon', 'local-resources', cat, `${safe}.md`);
          body = await fsPromises.readFile(file, 'utf-8');
        } catch { body = ''; }
        const reply = JSON.stringify({
          v: 3, op: 'agent.resource.get.reply',
          payload: { agentId, body: body || '(空)', fromPublicKey: v3P2PRef?.getPublicKey() || '' }
        });
        await comm.sendToConnection(conn.id, reply);
        return;
      }
      // 默认: 读本地 persona/<agentId>/agent.md (6 段 persona 之一)
      try {
        const fsPromises = await import('fs/promises');
        const safeId = (agentId as string).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const file = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona', safeId, 'agent.md');
        body = await fsPromises.readFile(file, 'utf-8');
      } catch { body = ''; }
      // fallback: 用 subagent-manager 的 description
      if (!body) {
        const all = await loadLocalSubAgents();
        const a = all.find((x: any) => x.id === agentId);
        if (a?.persona?.description) body = a.persona.description;
      }
      const reply = JSON.stringify({
        v: 3, op: 'agent.resource.get.reply',
        payload: { agentId, body: body || '(空)', fromPublicKey: v3P2PRef?.getPublicKey() || '' }
      });
      await comm.sendToConnection(conn.id, reply);
    } catch (err) {
      console.error('[v3-manifest] resource.get 失败:', (err as Error).message);
    }
    return;
  }

  // 对方回某 agent 的详细描述
  if (op === 'agent.resource.get.reply') {
    // 由 caller 端通过 rpcId 解析 (这里只 log)
    console.log(`[v3-manifest] 收到 agent.resource.get.reply (agentId=${parsed.payload?.agentId}, body=${(parsed.payload?.body || '').length} chars)`);
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

    // 2026-07-06: 硬上限 — judgment 总数可能 1875 条 (1.3MB), 全注入会把 LLM context 撑爆
    // MiniMax-M3 只有 8K context ≈ 32K 字符, 完整 judgment hint 必须 < 8K 字符
    const HARD_LIMIT = 6000; // 总 hint 字符数 < 6K (留 ~26K 给 user + contextHint 其他部分)
    const BOUND_MAX = 16;    // 绑定最多 16 条
    const OTHERS_MAX = 24;   // 候选最多 24 条
    let boundIncluded = 0;
    let othersIncluded = 0;
    let boundSkipped = 0;
    let othersSkipped = 0;

    // 路 1: 用户手动绑定的 judgment — 硬约束, 必须遵循
    if (bound.length > 0) {
      const headerText = `[系统上下文] 此 channel 用户绑定了 ${bound.length} 条判断力, 必须严格遵循:\n`;
      hint += headerText;
      for (const j of bound) {
        if (boundIncluded >= BOUND_MAX) { boundSkipped++; continue; }
        if (hint.length >= HARD_LIMIT) { boundSkipped++; continue; }
        const decision = (j.decision || '').toString().slice(0, 200);
        const reasonList = Array.isArray(j.reasons) ? j.reasons : [];
        const reasonText = reasonList.length > 0
          ? ` (理由: ${reasonList.join('; ').slice(0, 100)})`
          : '';
        const line = `- ${decision}${reasonText}\n`;
        if (hint.length + line.length > HARD_LIMIT) { boundSkipped++; continue; }
        hint += line;
        boundIncluded++;
      }
      hint += '\n';
    }

    // 路 2: 全局 judgment 候选池 — 软参考, LLM 自己挑
    if (others.length > 0) {
      const headerText = `[系统上下文] 候选判断力 (用户未明确绑定, 你可以按相关性自主选择参考, 共 ${others.length} 条):\n`;
      const footerText = `\n[系统上下文] 如果你的回复参考了某条候选判断力, 请在回复中自然提及 "我参考了你的判断: <decision 简述>" 即可, 无需复述 id.\n\n`;
      // 先判断 header + footer 能不能放
      if (hint.length + headerText.length + footerText.length < HARD_LIMIT) {
        hint += headerText;
        // 按 id 排序 (deterministic 取最近 N 条)
        for (const j of others) {
          if (othersIncluded >= OTHERS_MAX) { othersSkipped++; continue; }
          if (hint.length + footerText.length >= HARD_LIMIT) { othersSkipped++; continue; }
          const decision = (j.decision || '').toString().slice(0, 120);
          const line = `- [id=${j.id}] ${decision}\n`;
          if (hint.length + line.length + footerText.length > HARD_LIMIT) { othersSkipped++; continue; }
          hint += line;
          othersIncluded++;
        }
        hint += footerText;
      } else {
        othersSkipped = others.length;
      }
    }

    // 2026-07-06: 加个 truncate hint (在统计日志打印出来)
    if (boundSkipped > 0 || othersSkipped > 0) {
      console.log(`[v3] channel ${channelIdForLog} judgment hint truncated: bound=${boundIncluded}/${bound.length} (skip ${boundSkipped}), others=${othersIncluded}/${others.length} (skip ${othersSkipped}), hint=${hint.length} chars / limit ${HARD_LIMIT}`);
    }
    console.log(
      `[v3] channel ${channelIdForLog} 注入: 绑定 ${bound.length} 条, 候选 ${others.length} 条 (实际 ${boundIncluded}+${othersIncluded})`
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
    identityDoc,
    // 2026-07-04: 透传 agentId 让 onSessionStart 加载 persona docs
    agentId: channel?.agentId,
    // M2.3 (2026-06-17): 构造时从 session JSON 回灌历史 — 服务重启后 LLM 仍记得前面对话
    //   key 跟 server.ts:240 写入路径保持一致: ~/.bolloon/sessions/cache/<key>.json
    loadSessionKey: sessionKey,
    // M3.1 (2026-06-17): 默认启用 WorkflowPivotLoop — web 路径以前死代码, 现在用
    //   pivot loop 自带 quality scoring + task complexity analysis + 30 iters cap
    //   (老 ReAct 10000 iter cap 容易跑飞)
    usePivotLoop: true,
  }, true); // forceNew: true 强制创建新实例
  channelSessions.set(sessionKey, session);

  if (channelDid) {
    console.log(`[Agent] 新建频道 ${channelId} session, DID = ${channelDid}, sessionId = ${currentSessionId}`);
  } else {
    console.log(`[Agent] 新建频道 ${channelId} session, 使用默认身份, sessionId = ${currentSessionId}`);
  }

  return session;
}

// 2026-07-06: CreateWebServerOptions 抽到 ./server-types.ts (顶部 re-export)
let selfImproveEnabled = false;

// ========== 端口锁 + 优雅关闭 ==========

const LOCK_PATH = path.join(os.homedir(), '.bolloon', 'port.lock.json');
let activeServer: ReturnType<typeof createServer> | null = null;
let cleanupDone = false;

function cleanupAndExit(signal: string): void {
  if (cleanupDone) return;
  cleanupDone = true;
  console.log(`[server] 收到 ${signal}, 开始清理...`);
  // 优雅停止社交心跳: 清理 beacon/social 定时器, 防止进程退出前仍一直社交
  try { agentHeartbeat?.stop(); } catch (e: any) { console.warn('[heartbeat] 停止失败:', e?.message); }
  try { fsSync.unlinkSync(LOCK_PATH); } catch (e: any) { if (e?.code !== 'ENOENT') console.warn(`[port-lock] 删锁失败:`, e?.message); }
  if (activeServer) {
    activeServer.close(() => { process.exit(0); });
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}

function writeLock(port: number): void {
  try {
    fsSync.writeFileSync(LOCK_PATH, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (e: any) {
    console.warn(`[port-lock] 写锁文件失败:`, e?.message);
  }
}

function checkStaleLock(startPort: number): void {
  try {
    const raw = fsSync.readFileSync(LOCK_PATH, 'utf-8');
    const lock = JSON.parse(raw);
    if (!lock?.pid || lock.pid === process.pid) return;
    if (lock.port < startPort || lock.port > startPort + 10) return;
    try {
      process.kill(lock.pid, 0);
      console.warn(`⚠ 旧进程 PID ${lock.pid} 仍存活 (端口 ${lock.port}), 尝试终止...`);
      process.kill(lock.pid, 'SIGTERM');
    } catch (e2: any) {
      if (e2?.code === 'ESRCH') {
        console.log(`[port-lock] 上一实例 (PID ${lock.pid}) 已结束`);
      }
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') console.warn(`[port-lock] 读取失败:`, e?.message);
  }
}

export async function createWebServer(port: number = 3000, options: CreateWebServerOptions = {}) {
  selfImproveEnabled = options.selfImprove ?? false;
  // 防止 P2P DHT 超时等错误导致进程崩溃
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[警告] 未处理的 Promise 拒绝:', reason);
  });
  // 优雅关闭信号
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));
  process.on('SIGINT', () => cleanupAndExit('SIGINT'));

  // 启动前检查残存锁文件
  checkStaleLock(port);

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

    // 加载或生成持久化的 P2P 身份
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const p2pIdentityPath = path.join(homeDir, '.bolloon', 'p2p-identity.json');
    let kp: import('@diap/sdk').KeyPair;
    let reused = false;
    try {
      if (fsSync.existsSync(p2pIdentityPath)) {
        const raw = fsSync.readFileSync(p2pIdentityPath, 'utf-8');
        const j = JSON.parse(raw);
        const pkBytes = Buffer.from(j.privateKey, 'hex');
        if (pkBytes.length === 32) {
          kp = KeyManager.fromPrivateKey(pkBytes);
          reused = true;
        } else throw 0;
      } else throw 0;
    } catch {
      kp = KeyManager.generate();
      const privateKeyHex = Buffer.from(kp.privateKey).toString('hex');
      const publicKeyHex = Buffer.from(kp.publicKey).toString('hex');
      fsSync.mkdirSync(path.dirname(p2pIdentityPath), { recursive: true });
      fsSync.writeFileSync(p2pIdentityPath, JSON.stringify({
        keyType: 'Ed25519', privateKey: privateKeyHex, publicKey: publicKeyHex,
        did: kp.did, createdAt: new Date().toISOString(), version: '1.0'
      }, null, 2), { mode: 0o600 });
      try { fsSync.chmodSync(p2pIdentityPath, 0o600); } catch { /* ignore */ }
    }
    console.log(reused ? `复用 P2P 身份: ${kp.did.substring(0, 24)}...` : `新建 P2P 身份: ${kp.did.substring(0, 24)}...`);
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
              const replyText = parsed.payload?.text || '';
              const replyChannelId = parsed.payload?.channelId;
              console.log(`[v3] 收到来自 ${evt.fromPublicKey.substring(0,12)}... 的 chat.reply (${replyText.length} chars, channel=${replyChannelId})`);
              broadcast({
                type: 'remote-chat-reply',
                fromPublicKey: evt.fromPublicKey,
                channelId: replyChannelId,
                text: replyText,
                error: parsed.payload?.error
              }, 'p2p-global');
              // 2026-07-27: 把远端回复持久化到本地 session, 让 LLM 下次能读到上下文
              if (replyChannelId && replyText) {
                import('../web/server-storage.js').then(async ({ loadSession, saveSession }) => {
                  try {
                    const existing = await loadSession(replyChannelId, 'default');
                    const session: any = existing || { channelId: replyChannelId, sessionId: 'default', messages: [], lastUpdated: '' };
                    session.messages.push({
                      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      type: 'ai',
                      content: replyText,
                      timestamp: new Date().toISOString(),
                      source: 'remote-reply',
                      fromPublicKey: evt.fromPublicKey,
                    });
                    session.lastUpdated = new Date().toISOString();
                    await saveSession(session);
                    console.log(`[v3] chat.reply 已持久化到 session (${replyChannelId}): ${replyText.substring(0, 40)}...`);
                  } catch (e: any) {
                    console.warn('[v3] chat.reply 持久化失败:', e?.message?.substring(0, 100));
                  }
                }).catch(() => {});
              }
              return;
            }
            // 2026-07-21: 社交心跳 beacon — 远端智能体宣告存活/能力, 更新本地 liveness
            if (parsed.op === 'agent.heartbeat') {
              agentHeartbeat?.handleIncoming('agent.heartbeat', parsed.payload, evt.fromPublicKey);
              // 2026-07-29: 收到心跳也记录交互 (Dunbar 自动归类)
              // 2026-08-02 fix: 之前不传 text → inferOpponentMove('') = defect,
              //   heartbeat 被误判为背叛 → trustScore 持续下跌 → peer 跌入 blocked,
              //   导致对端消息被拒 (❌ 您已被本地系统加入通信黑名单)。
              //   改为传存活信号文本, 让机器协议消息判为 cooperate (在线维持连接 = 合作)。
              recordInteraction(evt.fromPublicKey, 'heartbeat 存活信号(自动)').catch(() => {});
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
                  const replyPayload = {
                    channelId: parsed.payload.channelId,
                    messages: parsed.payload.messages || [],
                    lastUpdated: parsed.payload.lastUpdated,
                    judgments: parsed.payload.judgments || { bound: [], candidates: [] },
                    channelName: parsed.payload.channelName
                  };
                  // 2026-07-07 P0-C: 远端 channel 历史镜像 (B 端副本, 防 A 端删/损坏即丢)
                  // fire-and-forget — 不阻塞 RPC reply 返回 (上层是 on('data') 同步回调)
                  import('../bootstrap/remote-mirror.js')
                    .then(({ mirrorRemoteHistory }) => mirrorRemoteHistory({
                      targetPublicKey: evt.fromPublicKey,
                      channelId: parsed.payload.channelId,
                      channelName: parsed.payload.channelName,
                      messages: parsed.payload.messages || [],
                      lastUpdated: parsed.payload.lastUpdated,
                    }))
                    .then((r: any) => {
                      if (!r?.ok) console.warn(`[v3-history] mirror 失败: ${r?.error}`);
                    })
                    .catch((mirrorErr: any) => {
                      console.warn(`[v3-history] mirror 抛错 (${evt.fromPublicKey.substring(0,12)}/${parsed.payload.channelId}): ${mirrorErr?.message || mirrorErr}`);
                    });
                  pending.resolve(replyPayload);
                }
              }
              return;
            }
            const commShim = {
              sendToConnection: async (_id: string, data: string) => {
                // 尝试解析 JSON 提取 op + payload，走 outbox（连接断开也不丢消息）
                try {
                  const parsed = JSON.parse(data);
                  if (parsed && parsed.v === 3 && parsed.op) {
                    const { sendOrQueue } = await import('../network/p2p-outbox.js');
                    await sendOrQueue(evt.fromPublicKey, parsed.op, parsed.payload || {}, v3P2PRef);
                    return;
                  }
                } catch {}
                // 兜底：直接发送
                v3P2PRef!.sendTo(evt.fromPublicKey, data);
              }
            };
            // v3 新增: 好友申请 RPC — 任何对端可以发, 推到前端 UI 让用户接受
            if (parsed.op === 'agent.friend.request') {
              console.log(`[v3-friend] 收到 ${evt.fromPublicKey.substring(0,12)}... 的好友申请: ${parsed.payload?.name || '(无名字)'}`);
              const reqFromName = parsed.payload?.name || ('peer-' + evt.fromPublicKey.substring(0, 8));
              const reqMessage = parsed.payload?.message || '想加你为 P2P 好友';
              // 2026-08-02: 备注 = 申请消息或显式 note 字段 (自我介绍 / 来源), 存 pending 供智能体工具查询
              const reqNote = parsed.payload?.note || reqMessage;
              if (parsed.payload?.requestId) {
                pendingFriendRequests.set(parsed.payload.requestId, {
                  requestId: parsed.payload.requestId,
                  fromPublicKey: evt.fromPublicKey,
                  fromName: reqFromName,
                  message: reqMessage,
                  note: reqNote,
                  receivedAt: Date.now(),
                });
                persistPendingFriendRequests();  // 2026-08-02: 落盘, 重启不丢
              }
              broadcast({
                type: 'friend-request',
                fromPublicKey: evt.fromPublicKey,
                fromName: reqFromName,
                message: reqMessage,
                note: reqNote,                     // 2026-08-02: 透传备注给 UI
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
            // 2026-07-05: v3 P2PDirect 主路径也要独立处理 manifest.exchange.reply — 否则只走老通道就拿不到
            if (parsed.op === 'agent.manifest.exchange.reply') {
              const manifest = parsed.payload?.manifest as AgentManifest;
              if (!manifest || !manifest.ownerPublicKey) {
                console.warn('[v3-manifest] manifest.exchange.reply 缺 manifest/ownerPublicKey');
                return;
              }
              const peerKey2 = manifest.ownerPublicKey;
              // 2026-07-05 修复: 跳过自己的 manifest
              if (v3P2PRef && peerKey2 === v3P2PRef.getPublicKey()) {
                return;
              }
              // 异步落盘, 不阻塞 data handler
              (async () => {
                try {
                  const existing = await peerFs.readPeerIndex(peerKey2);
                  if (existing?.manifestTs && existing.manifestTs >= manifest.publishedAt && parsed.payload?.since) {
                    console.log(`[v3-manifest] ${peerKey2.substring(0,12)}... manifest 已是最新, 跳过`);
                    return;
                  }
                  await peerFs.upsertPeer({
                    publicKey: peerKey2,
                    name: manifest.ownerName,
                    lastSeenAt: new Date().toISOString(),
                    lastManifestTs: manifest.publishedAt,
                  });
                  const ownerDescription = (manifest as any).ownerDescription || '';
                  const idx: peerFs.PeerIndexFile = {
                    version: 1,
                    publicKey: peerKey2,
                    ownerName: manifest.ownerName,
                    ownerDescription,
                    agents: manifest.agents as peerFs.PeerAgentEntry[],
                    groups: manifest.groups,
                    functions: manifest.functions,
                    exportments: manifest.exportments,
                    updatedAt: new Date().toISOString(),
                    manifestTs: manifest.publishedAt,
                  };
                  await peerFs.writePeerIndex(peerKey2, idx);
                  for (const a of manifest.agents) {
                    await peerFs.writeAgentDescription(peerKey2, a as peerFs.PeerAgentEntry, ownerDescription);
                  }
                  const counts = await writeRemoteResources(peerKey2, manifest);
                  await peerFs.writeCapabilityIndex(peerKey2, idx);
                  console.log(`[v3-manifest] (P2PDirect) 收到 ${peerKey2.substring(0,12)}... manifest (${manifest.agents.length} agents, owner=${manifest.ownerName || '?'}, +g${counts.groups}/f${counts.functions}/e${counts.exportments}/s${counts.sciences}) → 落盘`);
                  // 2026-07-27: 如果是自动发现的 peer，用 manifest 中的名字更新
                  if (manifest.ownerName) {
                    import('../network/auto-peer-discovery.js').then(({ updateDiscoveredPeerName }) =>
                      updateDiscoveredPeerName(peerKey2, manifest.ownerName).catch(() => {})
                    ).catch(() => {});
                  }
                  broadcast({
                    type: 'peer-manifest-updated',
                    fromPublicKey: peerKey2,
                    ownerName: manifest.ownerName,
                    agentCount: manifest.agents.length,
                    capabilityIndex: await peerFs.readCapabilityIndex(peerKey2),
                  }, 'p2p-global');

                  // 2026-07-27: 对 manifest 中有 cid/ipnsName 的 agent 解析 DID 文档
                  // 不阻塞主流程，fire-and-forget 后台进行
                  const agentsWithDID = manifest.agents.filter((a: any) => a.cid || a.ipnsName);
                  if (agentsWithDID.length > 0) {
                    import('../network/did-agent-resolver.js').then(({ resolveAgentsFromManifest, persistResolvedAgent }) =>
                      resolveAgentsFromManifest(agentsWithDID).then(resolved => {
                        for (const r of resolved) {
                          persistResolvedAgent(peerKey2, r).catch(() => {});
                        }
                      }).catch(() => {})
                    ).catch(() => {});
                  }
                } catch (err) {
                  console.error('[v3-manifest] (P2PDirect) manifest.exchange.reply 失败:', (err as Error).message);
                }
              })();
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

      // === 2026-07-21: 智能体社交心跳 (beacon + 自主决策发起对话) ===
      // beacon 周期向已知 peer 宣告存活/能力; social 循环让本地 agent 自主决定跟哪个远端智能体发起对话.
      // 远端唤醒/回复链路已存在 (agent.chat.send → server.ts:529 跑 LLM → agent.chat.reply → SSE remote-chat-reply).
      try {
        const { AgentHeartbeat } = await import('../social/agent-heartbeat.js');
        const socialOn = process.env.BOLLOON_AGENT_HEARTBEAT_SOCIAL !== '0';
        const myName = await (async () => {
          let n = process.env.BOLLOON_USER_NAME || process.env.USER || 'node';
          try {
            const { readFileSync, existsSync } = await import('fs');
            const cfgPath = `${process.env.HOME || '/tmp'}/.bolloon/config.json`;
            if (existsSync(cfgPath)) {
              const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
              if (cfg.userName) n = cfg.userName;
            }
          } catch {}
          return n;
        })();
        agentHeartbeat = new AgentHeartbeat({
          enabled: true,
          socialEnabled: socialOn,
          beaconIntervalMs: Number(process.env.BOLLOON_HEARTBEAT_BEACON_MS) || 30_000,
          socialIntervalMs: Number(process.env.BOLLOON_HEARTBEAT_SOCIAL_MS) || 120_000,
          cooldownMs: Number(process.env.BOLLOON_HEARTBEAT_COOLDOWN_MS) || 10 * 60_000,
          self: async () => {
            const channels = await loadChannels();
            const myPk = v3P2PRef?.getPublicKey() || '';
            return {
              publicKey: myPk,
              agentId: channels[0]?.agentId,
              name: myName,
              channels: channels.map((c: any) => ({ id: c.id, name: c.name })),
            };
          },
          getPeers: async () => {
            const { listPeers } = await import('../network/known-peers.js');
            const kp = await listPeers();
            const myPk = v3P2PRef?.getPublicKey() || '';
            const peers: any[] = [];
            for (const p of kp) {
              if (p.publicKey === myPk) continue;
              const cached = remoteChannelCache.get(p.publicKey) || [];
              peers.push({
                publicKey: p.publicKey,
                name: p.name,
                channels: cached.map((c: any) => ({ id: c.id, name: c.name })),
              });
            }
            return peers;
          },
          transport: {
            send: async (pk: string, op: string, payload: any) => {
              const { sendOrQueue } = await import('../network/p2p-outbox.js');
              return sendOrQueue(pk, op, payload, v3P2PRef);
            },
          },
          decide: socialOn ? llmSocialDecide : undefined,
          // 目标: 社交服务于"与网络中的其他智能体建立并维持协作". 配额/效果阈值防止一直社交.
          // owner 可通过 env BOLLOON_AGENT_GOAL 覆盖描述; 也可经 RPC setGoal 运行时注入.
          getGoal: async () => ({
            id: 'owner-collab',
            description: process.env.BOLLOON_AGENT_GOAL || '与网络中的其他智能体建立并维持协作关系, 主动分享进展并获取所需信息',
            maxInitiations: Number(process.env.BOLLOON_HEARTBEAT_GOAL_MAX) || 8,
            effectThreshold: Number(process.env.BOLLOON_HEARTBEAT_GOAL_EFFECT) || 3,
          }),
          // 效果度量: 远端回了非空且有实质内容的消息, 视为推进了目标 (生产可换 LLM 判定 achievedGoal)
          assessEffect: ({ replyText }) => {
            const t = (replyText || '').trim();
            return { advanced: t.length > 0, achievedGoal: false };
          },
          onPeerAlive: (peer: any) => {
            broadcast({
              type: 'peer-heartbeat',
              fromPublicKey: peer.publicKey,
              name: peer.name,
              channels: peer.channels,
              ts: Date.now(),
            }, 'p2p-global');
          },
          // 每次社交 tick 喂给 24h 看门狗, 防止误判卡死重启
          onActivity: () => {
            try { watchdogRef?.recordActivity?.('agent-heartbeat'); } catch {}
          },
          // 生命周期阶段变化 → 推 SSE 给前端展示
          onLifecycleChange: (phase: any, snap: any) => {
            broadcast({
              type: 'agent-lifecycle',
              phase,
              snapshot: snap,
              ts: Date.now(),
            }, 'p2p-global');
          },
        });
        agentHeartbeat.start();
        // 注册到全局, 让 24h HealthMonitor.checkHeartbeat 能观测到本智能体 (getDiscoveredAgents/isAntColonyEnabled)
        (global as any).socialHeartbeat = agentHeartbeat;
        (global as any).agentHeartbeat = agentHeartbeat;
      } catch (hbErr) {
        console.warn('[heartbeat] 启动失败 (non-fatal):', (hbErr as Error)?.message);
      }

      // 社交决策: 让本地 agent (用第一个本地 channel 的身份) 判断是否主动联络某 peer
      // 目标感知: ctx.goal 是当前要达成的目标, 决策应服务于它, 达成后可声明 goalAchieved 进入 RESTING
      async function llmSocialDecide(ctx: { self: any; peers: any[]; goal?: any }): Promise<{
        initiate: boolean;
        targetPeerPublicKey?: string;
        targetChannelId?: string;
        message?: string;
        goalAchieved?: boolean;
        reason?: string;
      }> {
        try {
          const channels = await loadChannels();
          const local = channels[0];
          if (!local) return { initiate: false };
          const agent = await getAgentForChannel(local.id, local.did || '', local.name, local.didDocRef);
          const peerLines = ctx.peers
            .map((p: any) => `- ${p.name || p.publicKey.slice(0, 8)} (pk=${p.publicKey.slice(0, 12)}…): 渠道[${p.channels.map((c: any) => c.name).join(', ') || '无'}]`)
            .join('\n');
          const goalDesc = ctx.goal ? `当前目标: ${ctx.goal.description} (已发起 ${ctx.goal.initiationsUsed}/${ctx.goal.maxInitiations}, 有效回复 ${ctx.goal.effectfulReplies}/${ctx.goal.effectThreshold})` : '当前无明确目标';
          const prompt =
`你是智能体「${ctx.self.name || '本地智能体'}」。你通过 P2P 网络认识以下其他智能体:
${peerLines}

${goalDesc}

规则:
1. 社交是为了达成上述目标, 不是闲聊。只在你有真正有价值的信息要分享/询问、且能推进目标时才主动发起。
2. 不要重复最近已经聊过的话题, 不要每条心跳都发消息, 保持克制。
3. 如果目标已经通过已有交流达成 (或你认为无需再聊), 输出 {"initiate": false, "goalAchieved": true}。
4. 如果决定发起, 选一个最合适的目标渠道 (用对方渠道的真实 id)。

现在是否要主动联系其中某个智能体? 只输出一个 JSON 对象, 不要任何其他文字:
{"initiate": true 或 false, "goalAchieved": true 或 false, "targetPeerPublicKey": "对方 pk", "targetChannelId": "对方渠道 id", "message": "你要说的话"}
若不想发起, 输出 {"initiate": false}。`;
          const raw = await agent.promptStream(prompt, () => {}, undefined, local.id);
          const m = raw.match(/\{[\s\S]*\}/);
          if (!m) return { initiate: false };
          const obj = JSON.parse(m[0]);
          return {
            initiate: !!obj.initiate,
            goalAchieved: !!obj.goalAchieved,
            targetPeerPublicKey: obj.targetPeerPublicKey,
            targetChannelId: obj.targetChannelId,
            message: obj.message,
          };
        } catch (err) {
          console.warn('[heartbeat] 社交决策 LLM 失败 (跳过本次发起):', (err as Error)?.message);
          return { initiate: false };
        }
      }

      // 新连接进来 → 主动发我分享给 ta 的 channel 列表 + 自动发现好友
      v3P2PRef.on('connection', (evt: any) => {
        // 2026-06-10: 喂 watchdog —— 新连接到来是真实业务活动
        watchdogRef?.recordActivity?.();

        // 2026-07-27: 自动发现 — 通过 topic 进来的新 peer 自动加好友
        // fire-and-forget: 不阻塞 connection 处理主流程
        import('../network/auto-peer-discovery.js').then(({ tryAutoDiscoverPeer }) => {
          const localPk = v3P2PRef?.getPublicKey() || '';
          tryAutoDiscoverPeer(evt.remotePublicKey, localPk).catch((e: any) =>
            console.warn('[auto-discover] 失败:', (e as Error)?.message)
          );
        }).catch(() => {});

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

        // 2026-07-05: 新连接到来立刻推自己的 manifest — 让对方秒知道我有哪些 agent
        setTimeout(async () => {
          try {
            // 跳过自己的连接 (Hyperswarm 内部 peer discovery 会推自己过来, 形成循环)
            if (v3P2PRef && evt.remotePublicKey === v3P2PRef.getPublicKey()) {
              return;
            }
            const localAgents = await loadLocalSubAgents();
            const entries: AgentManifestEntry[] = localAgents.map((a: any) => ({
              id: a.id, name: a.name,
              capabilities: a.capabilities || [],
              status: a.status || 'active',
              peerId: a.peerId, irohNodeId: a.irohNodeId,
              sessionId: a.sessionId, cid: a.cid, ipnsName: a.ipnsName,
            }));
            let ownerName = '';
            try {
              const fsPromises = await import('fs/promises');
              const p = (process.env.HOME || '/tmp') + '/.bolloon/persona.json';
              const raw = await fsPromises.readFile(p, 'utf-8');
              ownerName = JSON.parse(raw).name || '';
            } catch {}
            const manifest: AgentManifest = {
              ownerName,
              ownerPublicKey: v3P2PRef?.getPublicKey() || '',
              agents: entries,
              publishedAt: Date.now(),
              ...(await loadLocalResources()),
            };
            const msg = JSON.stringify({
              v: 3, op: 'agent.manifest.exchange.reply',
              payload: { manifest, since: 0 }
            });
            const r = await v3P2PRef!.sendToWithWait(evt.remotePublicKey, msg, 3000);
            console.log(`[v3-manifest] 新连接 ${evt.remotePublicKey.substring(0,12)}... → 主动推 manifest (${entries.length} agents, p2p=${r})`);
          } catch (err) {
            console.error('[v3-manifest] 新连接推 manifest 失败:', (err as Error).message);
          }
        }, 800);
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
          // 2026-07-05: 拉每个 known peer 的 manifest (agent 能力清单)
          setTimeout(() => requestManifestsFromAllPeers(), 4500);
          // 2026-07-05: 对方刚连上来, 把本地的 outbox 重发出去
          setTimeout(() => flushAllOutboxes(), 6000);
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

      // 2026-07-05 新增: 主动向所有 known peer 发起 manifest 拉取
      async function requestManifestsFromAllPeers() {
        if (!v3P2PRef) return;
        try {
          const { listPeers } = await import('../network/known-peers.js');
          const peers = await listPeers();
          const myPk = v3P2PRef.getPublicKey();
          let sent = 0;
          for (const peer of peers) {
            if (peer.publicKey === myPk) continue;
            // 增量: since = 本地已有的 lastManifestTs, 对端 manifestTs <= since 则跳过
            const peerRec = await peerFs.getPeer(peer.publicKey);
            const since = peerRec?.lastManifestTs || 0;
            const req = JSON.stringify({
              v: 3, op: 'agent.manifest.exchange',
              payload: { since, fromPublicKey: myPk }
            });
            const r = await v3P2PRef.sendToWithWait(peer.publicKey, req, 3000);
            if (r === 'SENT') sent++;
          }
          console.log(`[v3-manifest] requestManifestsFromAllPeers → sent=${sent}/${peers.length - 1}`);
        } catch (err) {
          console.warn('[v3-manifest] requestManifestsFromAllPeers failed:', (err as Error).message);
        }
      }
      // 每 5 分钟兜底 (manifest 增量拉取)
      setInterval(requestManifestsFromAllPeers, 5 * 60 * 1000);

      // 2026-07-05 新增: 把每个 peer 的 outbox 队列重发出去 (对方上线后)
      async function flushAllOutboxes() {
        if (!v3P2PRef) return;
        try {
          const { listPeers } = await import('../network/known-peers.js');
          const peers = await listPeers();
          const myPk = v3P2PRef.getPublicKey();
          let totalFlushed = 0;
          for (const peer of peers) {
            if (peer.publicKey === myPk) continue;
            const outbox = await peerFs.readOutbox(peer.publicKey);
            if (outbox.length === 0) continue;
            let sent = 0;
            for (const entry of outbox) {
              const rpc = JSON.stringify({ v: 3, op: entry.op, payload: entry.payload });
              const r = await v3P2PRef.sendToWithWait(peer.publicKey, rpc, 3000);
              if (r === 'SENT') sent++;
            }
            if (sent > 0) {
              // 全部成功 → 清空; 部分成功 → 写回剩余 (简单起见, 全成功才清)
              if (sent === outbox.length) {
                await peerFs.clearOutbox(peer.publicKey);
                totalFlushed += sent;
                console.log(`[v3-outbox] flush → ${peer.publicKey.substring(0,12)}... 重发 ${sent} 条 ✓`);
              }
            }
          }
          if (totalFlushed > 0) {
            console.log(`[v3-outbox] 累计重发 ${totalFlushed} 条离线消息`);
          }
        } catch (err) {
          console.warn('[v3-outbox] flushAllOutboxes failed:', (err as Error).message);
        }
      }
      // 每 15s 兜底 flush (连接窗口通常 5-10s, 要能抓住窗口 flush 出去)
      setInterval(flushAllOutboxes, 15 * 1000);
    } catch (err) {
      console.error('[v3] P2PDirect 启动失败:', (err as Error).message);
      v3P2PRef = null;
    }

    // 首次广播: 等 swarm bootstrap 完成后推一次
    setTimeout(v3BroadcastOwn, 3000);
    // v3 修复: 用 setInterval 替代一次性 setTimeout, 确保分享变更后能持续推送给 peer
    setInterval(v3BroadcastOwn, 30000);

    // 保留 @diap/sdk 的旧实例 (它的 Hyperswarm 实例能帮 P2PDirect 做 DHT bootstrap)
    // 2026-07-04: @diap/sdk v0.2.0 已修复 seed/*update*/connect 类型, 此处走正常路径.
    try {
      const rawSeed = crypto.getRandomValues(new Uint8Array(32));
      p2pCommunicator = createHyperswarmCommunicator({
        server: true,
        client: true,
        autoConnect: true,
        maxConnections: 50,
        seed: rawSeed
      });
      p2pCommunicator.on('message', async (msg: any, conn: P2PConnection) => {
        // 旧 p2p_message 路径 (非 v3)
        const content = new TextDecoder().decode(msg.content);
        broadcast({ type: 'p2p_message', from: conn.publicKey.substring(0, 8), content }, undefined);

        // 2026-07-05: 老通道也要走 v3 RPC handler — 兼容同机/跨机 P2PDirect 互不相连的场景
        //   实测: P2PDirect 用 hyperswarm 4.x, 同机 2 role 互不相连; 但 @diap/sdk 0.1.10 的 HyperswarmCommunicator 能互通
        //   所以 manifest/exchange/chat.send 都可能从老通道来, 必须进 handleV3P2PMessage
        try {
          const parsed = JSON.parse(content);
          if (parsed && parsed.v === 3 && parsed.op && p2pCommunicator) {
            await handleV3P2PMessage(parsed, conn, p2pCommunicator);
          }
        } catch (err) {
          // 非 v3 JSON 帧 (老 p2p_message), 静默忽略
        }
      });
      await p2pCommunicator.start();
      // @diap/sdk 也 join topic — 它的 Hyperswarm 实例帮 P2PDirect 做 DHT 引导
      // v0.2.1 (2026-07-28): hyperswarm seed 类型固定 + join() 返回 { refresh, flushed, destroy }
      //   discovery.update 错误已彻底修复. catch 保留做防御性兜底.
      const oldTopic = createTopic('bolloon-agent-harness');
      try {
        await p2pCommunicator.joinTopic(oldTopic);
        console.log(`P2P 老通道已就绪 (DHT bootstrap 帮 P2PDirect, 实际数据走 P2PDirect)`);
      } catch (joinErr: any) {
        const msg = String(joinErr?.message || joinErr);
        if (msg.includes('discovery.update') || msg.includes('is not a function')) {
          console.warn(`[v3-legacy] joinTopic 触发旧版兼容警告: ${msg}`);
        } else {
          throw joinErr;
        }
      }
    } catch (e: any) {
      console.log(`P2P 老通道初始化失败: ${e.message}`);
    }
  } catch (e: any) {
    console.log(`P2P 身份初始化失败: ${e.message}`);
  }

  const app = express();
  const server = createServer(app);

  await ensureSessionDirs();

  // 2026-07-15 修 Bug 3 续: attachment 路由需要单独大 limit body parser.
  //   关键: 必须挂在主 app.use(express.json()) 之前, 否则 4MB attachment 在主 100KB parser 阶段就被拒.
  //   path-prefix 让它只对 /api/attachments/* 生效, 不污染其他端点的限制.
  app.use('/api/attachments', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '100kb' }));

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
  // 2026-07-01 (v0.2.6 修复): 前端 message-renderer import 了 src/agents/chat-segmenter.js,
  //   浏览器加载时按相对路径解析成 /agents/chat-segmenter.js. 这个路径在 webRoot (dist/web) 之外.
  //   解决: 把 dist/agents 也 mount 到 /agents 静态路径, 让前端 import 解析成功.
  //   这条不破坏 segmenter 内部 import (Node 走文件系统, 浏览器走 HTTP).
  const agentsRoot = path.join(webRoot, '..', 'agents');
  app.use('/agents', express.static(agentsRoot));

  app.get('/', (req, res) => {
    res.sendFile(join(webRoot, 'index.html'));
  });

  // 2026-06-17: /api-config 与 / 改用 fs.readFileSync + res.send 兑底,
  //   不再依赖 express.sendFile. 原因: npm 全局安装路径下, send library 偶发报
  //   "Not Found" 即使 fs.existsSync+fs.stat 都成功. 现象: 页面 200 但内容是
  //   "api-config.html send error: Not Found" 5xx 错误页. 同步读 + res.type().send
  //   可靠返回原始 HTML bytes.
  function serveStaticHtml(relPath: string, notFoundMsg: string, label: string): (req: express.Request, res: express.Response) => void {
    return (_req, res) => {
      const filePath = join(webRoot, relPath);
      if (!fsSync.existsSync(filePath)) {
        return res.status(404).type('text/plain').send(notFoundMsg);
      }
      try {
        const html = fsSync.readFileSync(filePath);
        res.type('text/html; charset=utf-8').send(html);
      } catch (err) {
        console.error(`[${label}] readFileSync failed:`, (err as Error).message);
        if (!res.headersSent) {
          res.status(500).type('text/plain').send(`${relPath} read error: ${(err as Error).message}`);
        }
      }
    };
  }

  app.get('/', serveStaticHtml('index.html', 'index.html not found; please run `npm run build:web`', 'index'));
  app.get('/api-config', serveStaticHtml('api-config.html', 'api-config.html not found; please run `npm run build:web`', 'api-config'));

  // 2026-07-01 (v0.2.5): 输入验证 + 健康检查 API
  //   - POST /api/validate-input: 前端发送前预校验, 避免后端 reject
  //   - GET  /api/health: liveness probe + validators 清单
  //   这些端点不依赖 LLM / P2P, 永远可以响应.
  app.post('/api/validate-input', async (req, res) => {
    try {
      const body = req.body ?? {};
      const kind = body.kind || 'message';
      let result;
      if (kind === 'channel') {
        result = validateChannelInput({ name: body.name, agentId: body.agentId });
      } else {
        result = validateMessageInput({ text: body.text, channelId: body.channelId });
      }
      res.json({
        ok: result.ok,
        severity: result.severity ?? (result.ok ? 'info' : 'block'),
        reason: result.reason,
        cleaned: result.cleaned,
        kind,
      });
    } catch (e: any) {
      res.status(400).json({ ok: false, severity: 'block', reason: e?.message ?? 'parse error' });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json(healthCheck(getPackageVersion()));
  });

  app.get('/api/tools', (_req, res) => {
    res.json([]);  // tool-manifest 已废弃, 工具列表由 pi-sdk.ts this.tools 维护
  });

  // 2026-07-28: 用户 DID 身份端点 — 静默生成/加载, 持久化到 ~/.bolloon/identity/user.json
  let userIdentityCache: Record<string, string> | null = null;
  const IDENTITY_DIR = `${process.env.HOME || '/tmp'}/.bolloon/identity`;

  async function loadOrCreateUserIdentity() {
    if (userIdentityCache) return userIdentityCache;
    try {
      const { readFileSync, existsSync, mkdirSync, writeFileSync } = await import('fs');
      const file = `${IDENTITY_DIR}/user.json`;
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.did && parsed.publicKeyHex) {
          userIdentityCache = parsed;
          return parsed;
        }
      }
      // 生成新 DID keypair
      const kp = KeyManager.generate();
      const didShort = kp.did.split(':').pop()?.substring(0, 8) || 'unknown';
      const publicKeyHex = Buffer.from(kp.publicKey).toString('hex');
      const username = getUserName();
      const identity = {
        did: kp.did,
        didShort,
        publicKeyHex,
        name: `blln-${username}`,
        createdAt: new Date().toISOString(),
      };
      mkdirSync(IDENTITY_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
      userIdentityCache = identity;
      console.log(`[user-identity] ✅ DID: ${kp.did.substring(0, 30)}...`);
      return identity;
    } catch (e: any) {
      console.warn('[user-identity] 加载失败:', e.message);
      return { did: '', didShort: 'anon', publicKeyHex: '', name: getUserName() };
    }
  }

  app.get('/api/user/identity', async (_req, res) => {
    const identity = await loadOrCreateUserIdentity();
    res.json(identity);
  });

  // 2026-08-02: 修改左下角用户名 (写回 ~/.bolloon/identity/user.json)
  app.put('/api/user/identity', async (req, res) => {
    try {
      const { name } = req.body || {};
      const newName = String(name || '').trim().slice(0, 40);
      if (!newName) return res.status(400).json({ error: 'name 必填' });
      const identity = await loadOrCreateUserIdentity();
      identity.name = newName;
      userIdentityCache = identity;
      const { mkdirSync, writeFileSync } = await import('fs');
      mkdirSync(IDENTITY_DIR, { recursive: true });
      writeFileSync(`${IDENTITY_DIR}/user.json`, JSON.stringify(identity, null, 2), { mode: 0o600 });
      console.log(`[user-identity] 名字已更新: ${newName}`);
      res.json(identity);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2026-07-01 (v0.2.6): 前后端分离核心 — 后端切 LLM 输出为结构化 segments
  //   - POST /api/segment-reply { reply, knownTools }
  //   - 返回 ChatSegment[] (think / text / env_details / tool_call / final)
  //   前端拿到 segments 后只渲染, 不知道任何 LLM 格式 (minimax <invoke>, Hermes <tool_call>, Qwen function_calls, JSON 形式)
  app.post('/api/segment-reply', async (req, res) => {
    try {
      const body = req.body ?? {};
      const reply = typeof body.reply === 'string' ? body.reply : '';
      const knownToolsArr = Array.isArray(body.knownTools) ? body.knownTools : [];
      const knownToolNames = new Set<string>(knownToolsArr.filter((s: any) => typeof s === 'string'));
      const segments: ChatSegment[] = segmentChatReply(reply, { knownToolNames });
      res.json({
        ok: true,
        input_length: reply.length,
        segments,
        segments_count: segments.length,
        has_think: segments.some(s => s.type === 'think'),
        has_tool_call: segments.some(s => s.type === 'tool_call'),
        has_final: segments.some(s => s.type === 'final'),
      });
    } catch (e: any) {
      res.status(400).json({ ok: false, reason: e?.message ?? 'parse error' });
    }
  });

  // 2026-07-15 修 Bug 3: 拖拽文件上传
  //   - POST /api/attachments/upload  body: { filename, mimeType, content: base64 }
  //   - 文件落到 ~/.bolloon/attachments/<YYYY-MM>/<uuid>__<safeName>
  //   - 返回 { ok, attachmentId, url, size, mimeType, filename }
  //   - 前端拿到 attachmentId 后, 在消息文本里插一个 [attachment:id] 标记
  //     (这条消息发出去时 server 端 /message 把它解析成 contextHint + 行内下载链接)
  //   没用 multer/formidable — 复用 base64 JSON 简化, 跟 existing /api/judgments/import 同样的传输方式
  //   body parser 在上面 path-prefix 中间件已挂, 这里直接 handler 即可.
  const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10MB 单文件硬上限
  app.post('/api/attachments/upload', async (req, res) => {
    try {
      const body = req.body ?? {};
      const filename = String(body.filename || '').trim();
      const mimeType = String(body.mimeType || 'application/octet-stream');
      const content = String(body.content || '');
      if (!filename || !content) {
        return res.status(400).json({ ok: false, error: 'filename 与 content 必填' });
      }
      // base64 → bytes
      const buf = Buffer.from(content, 'base64');
      if (buf.length === 0) {
        return res.status(400).json({ ok: false, error: '文件为空' });
      }
      if (buf.length > ATTACHMENT_MAX_BYTES) {
        return res.status(413).json({
          ok: false,
          error: `文件超过 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB 上限`,
        });
      }
      // safeName: 跟 safeChannelName 同样规则, 防路径穿越 + Windows 非法字符
      //   注意: 把 . 也加进替换 (不然 "../../" 被转成 "..__" 还残留 .. 序列), 整个文件 base 安全
      const safeName = filename
        .replace(/[\\/:*?"<>|\x00-\x1f.]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120) || 'unnamed';
      if (safeName !== filename) {
        console.log(`[attachments] safeName 转换: "${filename}" → "${safeName}"`);
      }
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      const attachmentsDir = path.join(
        process.env.HOME || '/tmp',
        '.bolloon', 'attachments', month
      );
      await fs.mkdir(attachmentsDir, { recursive: true });
      const attachmentId = `${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
      const storedFilename = `${attachmentId}__${safeName}`;
      const fullPath = path.join(attachmentsDir, storedFilename);
      await fs.writeFile(fullPath, buf);
      const urlPath = `/api/attachments/${attachmentId}`;
      console.log(`[attachments] 上传 ${filename} (${buf.length}B, ${mimeType}) → ${fullPath}`);
      res.json({
        ok: true,
        attachmentId,
        url: urlPath,
        filename,
        storedFilename,
        size: buf.length,
        mimeType,
      });
    } catch (e: any) {
      console.error('[attachments] upload failed:', e?.message || e);
      res.status(500).json({ ok: false, error: e?.message || '上传失败' });
    }
  });

  // GET /api/attachments/:id — 下载 (按 attachmentId 找当月目录; 月份遍历回退)
  app.get('/api/attachments/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_]/g, '');
      if (!id) return res.status(400).type('text/plain').send('invalid id');
      const attachmentsRoot = path.join(process.env.HOME || '/tmp', '.bolloon', 'attachments');
      // 先按当前月 → 前一月 → …→ 全部月份列表 (3 个月够历史用)
      const candidates: string[] = [];
      const now = new Date();
      for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const month = d.toISOString().slice(0, 7);
        try {
          const files = await fs.readdir(path.join(attachmentsRoot, month));
          for (const f of files) {
            if (f.startsWith(id + '__')) candidates.push(path.join(attachmentsRoot, month, f));
          }
        } catch { /* month dir 可能不存在, 跳过 */ }
        if (candidates.length > 0) break;
      }
      if (candidates.length === 0) {
        return res.status(404).type('text/plain').send('attachment not found');
      }
      const fullPath = candidates[0];
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        return res.status(404).type('text/plain').send('attachment missing');
      }
      // 从文件名还原原 mimeType: 按扩展名猜
      const fileBase = path.basename(fullPath);
      const origName = fileBase.substring(id.length + 2); // 跳过 "<id>__"
      const ext = path.extname(origName).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
        '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
        '.zip': 'application/zip',
        '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const buf = await fs.readFile(fullPath);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(origName)}`);
      res.send(buf);
    } catch (e: any) {
      console.error('[attachments] download failed:', e?.message || e);
      res.status(500).type('text/plain').send('download error: ' + (e?.message || ''));
    }
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
    const { text, channelId, channelDid, attachments } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    // 2026-08-02: / 斜杠命令路由 — 用户输入 /plan /todo /task 等快捷命令时,
    //   直接把命令转成结构化指令注入 contextHint, 引导 LLM 调用对应工具.
    //   前端 / 菜单插入的是 "/plan 目标; 步骤" 这类文本, 这里解析成提示.
    let slashCommandHint = '';
    try {
      const slashMatch = String(text).match(/^\/([a-z-]+)\s*(.*)$/is);
      if (slashMatch) {
        const [, cmdRaw, cmdArgs] = slashMatch;
        const cmd = cmdRaw.toLowerCase();
        const argText = String(cmdArgs || '').trim();
        const hints: Record<string, string> = {
          plan: `用户输入了 /plan 命令, 参数: "${argText}". 请调用 create_plan 工具: goal=参数中 ";" 前的部分 (或整句), steps=";" 后的步骤列表 (逗号分隔). 若参数为空, 先向用户确认目标和步骤.`,
          todo: `用户输入了 /todo 命令, 参数: "${argText}". 请调用 update_plan 勾选步骤状态: 格式 "计划ID; 步骤ID; done|blocked". 参数不完整就向用户要.`,
          review: `用户输入了 /review 命令, 参数: "${argText}". 请调用 review_plan: 格式 "计划ID; 审查总结". 参数不完整就向用户要.`,
          task: `用户输入了 /task 命令, 参数: "${argText}". 请调用 create_task 创建任务.`,
          goal: `用户输入了 /goal 命令, 参数: "${argText}". 请调用 park_goal 暂停目标.`,
          skill: `用户输入了 /skill 命令, 参数: "${argText}". 请调用 create_skill 沉淀技能.`,
          'add-friend': `用户输入了 /add-friend 命令, 参数: "${argText}". 请调用 add_friend_by_id 添加好友 (参数: 64位 hex 公钥 + 可选备注).`,
          help: `用户输入了 /help. 请简要列出可用命令: /plan /todo /review /task /goal /skill /add-friend, 各一句话说明.`,
        };
        if (hints[cmd]) {
          slashCommandHint = `[系统上下文] 快捷命令路由:\n${hints[cmd]}\n\n`;
          console.log(`[slash] 命令 /${cmd} 参数="${argText.slice(0, 80)}"`);
        }
      }
    } catch { /* 命令解析失败忽略 */ }

    // 2026-07-15 修 Bug 3: 拖拽附件 — LLM 在 contextHint 里看到文件清单, 用户文本保持可读
    //   替代方案: 把 [attachment:id] 标记塞 text 里, 这里解析回 attachments 数组
    let parsedAttachments: Array<{ attachmentId: string; filename?: string; mimeType?: string; size?: number }> = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      parsedAttachments = attachments.filter((a: any) =>
        a && typeof a.attachmentId === 'string' && a.attachmentId.length > 0
      );
    } else {
      // 兼容老前端: 从 text 里抽 [attachment:<id>] 标记
      const rx = /\[attachment:([a-zA-Z0-9_]+)\]/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(String(text))) !== null) {
        parsedAttachments.push({ attachmentId: m[1] });
      }
    }
    const attachmentContext = parsedAttachments.length > 0
      ? `[系统上下文] 用户上传了 ${parsedAttachments.length} 个附件: ` +
        parsedAttachments.map(a => `${a.filename || a.attachmentId} (id=${a.attachmentId}, mime=${a.mimeType || '?'}, size=${a.size ?? '?'}B, URL=/api/attachments/${a.attachmentId})`).join('; ') +
        `\n你需要时可以调用文件读工具 (curl /api/attachments/<id>) 拉取真实内容。\n\n`
      : '';

    if (!channelId) {
      return res.status(400).json({ error: 'No channelId provided' });
    }

    // 获取频道信息（只取轻量引用, 不再读完整 DID 文档）
    const channels = await loadChannels();
    const channel = channels.find(c => c.id === channelId);

    // 2026-07-07 H2 修复: channel 不存在 → 404 (之前静默通过, 消息写到孤儿目录)
    if (!channel) {
      return res.status(404).json({ error: 'channel not found', channelId });
    }
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
    // 2026-08-02: 支持 per-message 覆盖 — 前端"发送默认配置"toggle 传 autoInvokeTools,
    //   有则用消息级设置, 没有则回落到 channel 配置 (默认开启)
    const autoToolsEnabled = typeof (req.body as any)?.autoInvokeTools === 'boolean'
      ? (req.body as any).autoInvokeTools
      : channel?.autoInvokeTools !== false;
    // 捕获外层 channel 到独立变量, 避免被 try 块内 (line 740+) 的 const channel 遮蔽
    const channelForJudgment = channel;

    // per-channel queue 检查: 已在跑就入队, 等当前跑完自动接上
    const runState = getOrCreateRunState(channelId);
    if (runState.running) {
      // 2026-07-15 修 Bug 8: 入队时保留 attachments + channelDid, 否则下一轮执行时会丢附件
      runState.queue.push({
        channelId,
        text,
        boundWalletAddress,
        autoToolsEnabled,
        attachments: parsedAttachments,
        channelDid,
      });
      broadcastQueueUpdate(channelId);
      console.log(`[queue] /message 入队 channel=${channelId}, queue len=${runState.queue.length}, attach=${parsedAttachments.length}`);
      return;
    }
    runState.running = true;
    runState.abortController = new AbortController();
    // 2026-07-04: pivot loop safety net — 防止 LLM hang (minimax M3
    //   偶尔反复 think 不输出 <final gen>, pivot 连 5 次无进展时会 hang 在
    //   quality 评估). setTimeout 让 LLM 客户端收 signal 主动 break.
    // 2026-07-06: 30s 太短 — minimax M3 单次 LLM 约 10s, pivot 默认 moderate profile 30 iter
    //   留 ~300s. 之前 30s 自动 abort 时, 一次"你好"调用就被截断, 用户看到 ❌ 循环异常 + 空内容.
    //   改为 5 分钟 = 5x 实际耗时上限.
    const PIVOT_FORCE_TIMEOUT_MS = 5 * 60 * 1000;
    const forceTimeout = setTimeout(() => {
      console.warn(`[server] /message pivot 强制 timeout (${PIVOT_FORCE_TIMEOUT_MS}ms), aborting`);
      runState.abortController?.abort();
    }, PIVOT_FORCE_TIMEOUT_MS);
    broadcastQueueUpdate(channelId);

    // 2026-07-01 (v0.2.5): hoist sessionKey 到 try 外, 让 finally 块的 saveCurrentSession 能用
    const sessionKey = `${channelId}:${currentSessionId}`;
    let agent: AgentSession | null = null;

    try {
      agent = await getAgentForChannel(channelId, realChannelDid, realChannelName, realChannelDidDoc);
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
        } else if ((event as any).type === 'reply-preview') {
          // 2026-07-06: pivot 每 iter 把完整 reply 推给前端 — 前端可以更新临时气泡
          //   等 loop 退完 type=ai 终文事件覆盖. 不依赖整个 promptWithPivotLoop 返回.
          //   这样 pivot 中途网络慢 / 5min-long 任务, 用户看到中间内容不是空白 + '任务处理超时'.
          broadcast({
            type: 'reply-preview',
            content: (event as any).content,
            iteration: (event as any).iteration,
          }, channelId);
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
          // 2026-06-16: 累积 step 到 runState, 供 /api/loop/inspect 读取
          try {
            if (event.type === 'step_done' || event.type === 'step_error') {
              const rs = channelRunState.get(channelId);
              if (rs) {
                if (!rs.lastSteps) rs.lastSteps = [];
                rs.lastSteps.push({
                  name: String(event.tool || event.content || 'step').slice(0, 60),
                  status: event.type === 'step_error' ? 'failed' : (event.success === false ? 'failed' : 'ok'),
                  durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
                  output: event.output ? String(event.output).slice(0, 800) : (event.error ? String(event.error).slice(0, 800) : undefined),
                });
              }
            }
          } catch { /* non-fatal */ }
        } else if (event.type === 'error') {
          broadcast({ type: 'error', content: event.content }, channelId);
        }
      };

      console.log(`[消息处理] 开始处理用户消息, channelId: ${channelId}, sessionId: ${currentSessionId}`);

      // 将真实 DID 作为上下文前缀，让 AI 使用真实的 DID 而不是自己编造的
      let contextHint = '';
      // 2026-08-02: slash 命令提示 (在 /message 开头解析, 这里注入)
      if (slashCommandHint) contextHint += slashCommandHint;
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
      // 2026-08-02: memory 回读 — 把本 channel 的历史记忆摘要注入 contextHint.
      //   memory-compressor 每次 /message 后把增量摘要 append 到
      //   ~/.bolloon/memory/<agentId>/sessions/<safe-channel>__<safe-session>.summary.md,
      //   但之前只写不读, 对话完全无记忆. 这里取尾部最近 3 段增量摘要回灌给 LLM.
      try {
        const { getSessionSummaryPath, getMemoryDir, sanitizeAgentId } = await import('../bootstrap/memory-compressor.js');
        const { readFile, readdir } = await import('fs/promises');
        const { join } = await import('path');
        const agentId = channelForJudgment?.agentId;
        if (agentId) {
          // 优先读当前 channel 的 summary (如果有)
          const currentSummary = getSessionSummaryPath(agentId, channelId, currentSessionId);
          const summariesToRead: string[] = [];
          try {
            const raw = await readFile(currentSummary, 'utf-8');
            if (raw.trim()) summariesToRead.push(raw);
          } catch { /* 当前 channel 还没有摘要 */ }
          // 再兜底读同 agent 其他 channel 的最近摘要 (跨 channel 记忆)
          if (summariesToRead.length === 0) {
            try {
              const sessionsDir = join(getMemoryDir(agentId), 'sessions');
              const files = (await readdir(sessionsDir)).filter(f => f.endsWith('.summary.md'));
              // 按文件名排序取最近 2 个 (文件名含时间戳, 近似排序)
              const recent = files.sort().slice(-2);
              for (const f of recent) {
                if (f.includes(sanitizeAgentId(channelId))) continue; // 跳过已读的当前 channel
                try {
                  const raw = await readFile(join(sessionsDir, f), 'utf-8');
                  if (raw.trim()) summariesToRead.push(raw);
                } catch { /* 单个摘要读失败跳过 */ }
              }
            } catch { /* 无 sessions 目录 */ }
          }
          if (summariesToRead.length > 0) {
            const memBlock = summariesToRead.map(s => s.trim().slice(-1500)).join('\n\n---\n\n');
            contextHint += `[系统上下文] 本 channel 的历史记忆 (来自 memory-compressor 摘要, 帮助你延续之前的对话, 引用而非复述):\n${memBlock.slice(-2500)}\n\n`;
          }
        }
      } catch (memErr) {
        // 静默失败 — memory 回读不是核心, 失败不阻塞
      }
      // 2026-08-02: plan 回读 — 把进行中的计划注入 contextHint (在 memory 之后)
      //   配合 create_plan / update_plan / review_plan 工具, 让 LLM 每次对话都能看到
      //   未完成的计划并继续推进.
      try {
        const { listActivePlans, planToContext } = await import('../agents/plan-store.js');
        const plans = await listActivePlans();
        if (plans.length > 0) {
          const plansBlock = plans.slice(0, 3).map(p => planToContext(p)).join('\n\n');
          contextHint += `[系统上下文] 进行中的计划 (来自 plan-store, 执行中每完成一步调 update_plan 勾选):\n${plansBlock}\n\n`;
        }
      } catch (planErr) {
        // 静默失败
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

      // 2026-07-06: 全局 contextHint 硬裁 — MiniMax-M3 context window 8K token ≈ 32K 字符
      //   如果 contextHint 超过 14K 字符 (留 ~18K 给 userText + LLM 输出 + system), 主动截断
      const CONTEXT_LIMIT = 14000;
      let contextTruncated = false;
      if (contextHint.length > CONTEXT_LIMIT) {
        const originalLen = contextHint.length;
        contextHint = contextHint.slice(0, CONTEXT_LIMIT);
        contextHint += `\n[系统上下文] (...剩余 ${originalLen - CONTEXT_LIMIT} 字符因 context window 限制已截断, 完整内容请用 /judgments 查)\n`;
        contextTruncated = true;
        console.warn(`[chat] channel=${channelId} contextHint truncated: ${originalLen} -> ${contextHint.length} chars`);
      }
      try {
        // 2026-06-15: 把 user text 单独 marker 包起来, LLM 不会被 8K+ 的 system context 吞掉
        //   (之前 contextHint + text 拼成一整段当 user role, 24 字符的 user input 埋在 8K+ 里看不出)
        //   修法: contextHint 当 "背景信息", text 当 "本轮用户请求" — 显式 marker 让 LLM 区分
        // 2026-06-15 二次修: 把 text 放在最前 (LLM 看到 input 第一眼是 user text, 不会被 judgmentHint 末尾
        //   的 "..." 误判为整个 input 截断)
        // 2026-07-05: prepend nextPromptHints (manifest-loader 加载的对方能力, 仅本次生效)
        let extraHint = '';
        const hint = nextPromptHints.get(channelId);
        if (hint) {
          extraHint = hint + '\n\n';
          nextPromptHints.delete(channelId);
        }
        // 2026-07-15 修 Bug 3: 拖拽附件 — attachmentContext 提到 contextHint 最前, LLM 第一眼看到文件清单
        const markedPrompt = `${extraHint}【本轮用户请求】\n${text}\n【请求结束】\n\n${attachmentContext}${contextHint}`;
        fullResponse = await agent.promptStream(markedPrompt, streamCallback, runState.abortController?.signal, channelId);
      } catch (err: any) {
        // abort 抛错: 保留已输出的部分 (fullResponse 可能是空字符串)
        if (runState.abortController?.signal.aborted || err?.name === 'AbortError') {
          console.log(`[chat] aborted channel=${channelId}`);
          // 2026-07-06: abort 时 fullResponse 可能为空 (LLM 还没输出), 必须给用户一个反馈
          if (!fullResponse.trim()) {
            fullResponse = '⚠️ 生成已中断 (用户取消)';
          }
        } else {
          // M1.2 (2026-06-17): 不再 rethrow — 把错误塞到 fullResponse 让 broadcast 出来, 后续 session 仍保存
          // 旧行为: 抛到外层 catch, 触发 500 + 用户消息丢失 (session 不保存)
          console.error(`[chat] LLM 调用失败 channel=${channelId}:`, err);
          fullResponse = `[错误: LLM 调用失败] ${String(err?.message || err).slice(0, 300)}`;
          broadcast({ type: 'error', content: fullResponse }, channelId);
        }
      }
      // abort 模式: 给 partial 拼后缀 — 只在 LLM 真有输出时加中断标记,
      //   跳过空响应 + 跳过 [AI 服务调用失败] fallback (这些本身就是错误占位, 拼
      //   "[生成已中断]" 会误导用户)
      const hasRealLlmOutput =
        fullResponse.trim().length > 0 &&
        !fullResponse.trimStart().startsWith('[AI 服务调用失败]');
      if (runState.abortController?.signal.aborted && hasRealLlmOutput) {
        fullResponse = fullResponse + '\n\n_[生成已中断]_';
      }

      // 2026-06-18: 修 lastFinalReply 没设 → /api/loop/inspect 永远返回空
      runState.lastFinalReply = fullResponse;

      // 2026-07-06: 防御性兜底 — fullResponse 为空时, 前端 segmentChatReply('') 返回 [],
      //   导致气泡不渲染, 用户只看到"思考中"占位符. 这里保证永远有内容可渲染.
      if (!fullResponse.trim()) {
        fullResponse = '⚠️ AI 未返回内容, 请重试';
        console.warn(`[chat] fullResponse empty for channel=${channelId}, using fallback`);
      }

      // v3 新增: 解析 LLM 回复里的 @-mentions, 转发到目标 channel
      await routeMentionsInReply(channelId, fullResponse, localChannels, remoteChannels);

      broadcast({ type: 'ai', content: fullResponse }, channelId);

      const existingSession = await loadSession(channelId, currentSessionId);
      const session: Session = existingSession || { channelId, sessionId: currentSessionId, messages: [], lastUpdated: new Date().toISOString() };
      session.sessionId = currentSessionId;
      // v3: 加 source 标记 (local = 内部 owner, remote = 远端访客)
      // 2026-07-15 修 Bug 4: client.ts sendMessage 已经通过 persistLastMessageToServer PATCH /sessions/.../...
      //   把 user msg 落盘一次 (立即落, 切走再切回不丢). 这里再 push 一次 → session.messages 出现两条相同的 user msg,
      //   loadSession 重渲染时两条都上屏, 表现"每条 user 气泡重复两次".
      //   修法: 持久化以 client PATCH 为准, /message 这边只 push ai 消息. 同时去重检查上次的 user 避免极端竞态 (并行 PATCH).
      const lastMsg = session.messages[session.messages.length - 1];
      const userAlreadyPushed = lastMsg && lastMsg.type === 'user' && lastMsg.content === text;
      if (!userAlreadyPushed) {
        session.messages.push({ id: crypto.randomUUID(), type: 'user' as const, content: text, timestamp: new Date().toISOString(), source: 'local' as any });
      }
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

      // 2026-07-04: 写 session 后, 调 memory-compressor 把消息历史压缩到
      //   ~/.bolloon/memory/<channel.agentId>/sessions/<safe-channel>__<safe-session>.summary.md
      // 失败静默, 不阻塞 /message 主路径.
      try {
        const channelsForMemory = await loadChannels();
        const channelForMemory = channelsForMemory.find(c => c.id === channelId);
        if (channelForMemory?.agentId) {
          const { compressSessionToMemory } = await import('../bootstrap/memory-compressor.js');
          const compressRes = await compressSessionToMemory({
            agentId: channelForMemory.agentId,
            channelId,
            sessionId: currentSessionId,
          });
          if (!compressRes.skipped && compressRes.bytesWritten > 0) {
            console.log(`[memory] compressed ${compressRes.messagesCount} new messages for ${channelForMemory.agentId}/${channelId} → ${compressRes.summaryPath} (${compressRes.bytesWritten}B)`);
          }
        }
      } catch (memErr: any) {
        console.warn('[memory] compressSessionToMemory failed (non-fatal):', memErr?.message?.slice(0, 200));
      }

      // 2026-07-05: 把 session 里的 user/ai 消息按涉及到的远端 peer 归档到月度 markdown
      //   触发条件: 消息里出现过 @远端 channel, 或者 session 历史上与该 peer 通信过
      //   失败静默, 不阻塞主对话
      try {
        const { appendChatArchive } = await import('../bootstrap/chat-archiver.js');
        // 找到这条消息涉及到的远端 peer (从 routeMentionsInReply 的结果推断 — 简单起见直接遍历 remoteChannels)
        const localChannels2 = (await loadChannels());
        const remoteChannels2: any[] = [];
        for (const [peerPk, list] of remoteChannelCache.entries()) {
          for (const ch of list) {
            remoteChannels2.push({ ...ch, _ownerPublicKey: peerPk });
          }
        }
        // 找出本次 text/fullResponse 里出现 @ 的 channel 对应的 owner pk
        const peerSet = new Set<string>();
        const mentionRe = /@([一-龥A-Za-z0-9_\-]{1,30})/g;
        const mentionedNames = new Set<string>();
        for (const m of text.matchAll(mentionRe)) mentionedNames.add(m[1]);
        for (const m of fullResponse.matchAll(mentionRe)) mentionedNames.add(m[1]);
        for (const rc of remoteChannels2) {
          if (mentionedNames.has(rc.name)) peerSet.add(rc._ownerPublicKey);
        }
        // 追加到每个相关 peer 的月度归档
        for (const pk of peerSet) {
          await appendChatArchive({
            publicKey: pk,
            entry: {
              ts: new Date().toISOString(),
              source: 'local',
              channelId, channelName: (await loadChannels()).find(c => c.id === channelId)?.name,
              text: `[本节点] user: ${text.slice(0, 500)}\n[本节点] ai: ${fullResponse.slice(0, 800)}`,
              fromPublicKey: v3P2PRef?.getPublicKey(),
              msgType: 'user',
            }
          });
        }
      } catch (archiveErr: any) {
        console.warn('[chat-archive] append failed (non-fatal):', archiveErr?.message?.slice(0, 200));
      }

      // 2026-07-05: 懒加载触发器 — 探测到 @-mention 远端 / 连续失败 / 关键词, 拉对方 manifest
      //   把 capability-index 拼到下一次 prompt 上下文 (只生效 1 次, 不污染主循环)
      try {
        const { detectLoadTrigger, loadPeerManifest, clearFailure } = await import('../agents/peer-manifest-loader.js');
        const remoteChannelsForDetect: any[] = [];
        for (const [peerPk, list] of remoteChannelCache.entries()) {
          for (const ch of list) {
            remoteChannelsForDetect.push({ ...ch, _ownerPublicKey: peerPk });
          }
        }
        // 检测 + 加载
        const detection = detectLoadTrigger({
          text,
          channelId,
          remoteChannels: remoteChannelsForDetect,
        });
        if (detection.shouldLoad && detection.remotePublicKey && v3P2PRef) {
          const result = await loadPeerManifest(
            {
              channelId,
              channelName: (await loadChannels()).find(c => c.id === channelId)?.name,
              reason: detection.reason!,
              triggerValue: detection.triggerValue!,
              remotePublicKey: detection.remotePublicKey,
            },
            { p2p: v3P2PRef }
          );
          if (result && result.promptBlock) {
            console.log(`[manifest-loader] ${detection.reason} → ${detection.remotePublicKey.slice(0,12)}... (${result.durationMs}ms, rpc=${result.rpcTriggered}, agents=${result.agentDescriptions.length})`);
            // 把 promptBlock 推给前端 + 写入一次性的 prompt 附加 (nextPromptHint 全局变量, 在下次 agent.promptStream 前 prepend)
            broadcast({
              type: 'peer-manifest-loaded',
              fromPublicKey: detection.remotePublicKey,
              reason: detection.reason,
              promptBlock: result.promptBlock,
              capabilityIndex: result.capabilityIndex,
            }, channelId);
            // 缓存到 channel 维度的 nextPromptHint (下一次 LLM prompt 前 inject)
            nextPromptHints.set(channelId, (nextPromptHints.get(channelId) || '') + '\n\n' + result.promptBlock);
            clearFailure(channelId);
          }
        } else {
          // 没触发, 也清掉连续失败计数 (用户消息说明对话还在正常进行)
          clearFailure(channelId);
        }
      } catch (loaderErr: any) {
        console.warn('[manifest-loader] failed (non-fatal):', loaderErr?.message?.slice(0, 200));
      }

      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      // 2026-06-11: 移除 suggestRename 的二次 LLM 调用 — 之前每次用户发消息, 智能体 channel 都会再调一次 LLM (5-8s) 自动改名
      // 影响: (1) /message 端点被拖慢 5-8s (2) LLM 客户端排队, 其他 channel 跟着卡
      // 现在改名逻辑挪到 /api/agent-rename 端点, 用户主动触发才跑
      if (channel) {
        channel.updatedAt = new Date().toISOString();
        // 2026-08-02 fix: 原子写入, 防并发覆盖丢 channel
        await updateChannels((chs) => {
          const c = chs.find(x => x.id === channelId);
          if (c) c.updatedAt = channel.updatedAt;
          return chs;
        });
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
      // 2026-07-04: 清掉 pivot 强制 timeout timer, 避免 hang 情况下 timer 在
      //   process 里一直挂着. forceTimeout 在 try 外创建, finally 在闭包里
      //   能直接拿到引用.
      clearTimeout(forceTimeout);

      // queue dequeue: 跑完或失败都要清状态
      runState.running = false;
      runState.abortController = null;
      broadcastQueueUpdate(channelId);

      // 2026-07-15 修 Bug 8: 队列自动 drain — 之前只清状态不抽下一条, 用户连续发的所有
      //   第二轮起全卡在 queue 里出不来, 表现"第二轮没反应".
      //   修复: finally 里查 queue, 非空就异步 fire-and-forget 起下一轮.
      //   实现要点:
      //     1. 用 setImmediate / Promise.resolve() 让 res.headersSent 干净
      //     2. 不能 await (否则阻塞 finally 后面的 saveSession; 而且这就是 fire-and-forget)
      //     3. 重新 build contextHint, 走相同 LLM 路径
      if (runState.queue.length > 0) {
        const next = runState.queue.shift()!;
        console.log(`[queue-drain] channel=${next.channelId} text="${next.text.slice(0, 30)}" attach=${(next.attachments?.length ?? 0)}`);
        // 异步跑下一条 (fire-and-forget)
        setImmediate(() => {
          void runMessageFromQueue(next).catch((e: any) => {
            console.error('[queue-drain] error:', e?.message?.slice(0, 200));
          });
        });
      }

      // 2026-07-01 (v0.2.5): 持久化当前 messageHistory — 让 web 用户跨刷新保留对话.
      //   saveCurrentSession 失败静默, 不阻塞 channel 状态清理.
      //   saveCurrentSession 内部走 SessionStore (默认 ~/.bolloon/sessions/cache/<sessionKey>.json).
      //   agent 可能在 try 抛错后仍为 null (getAgentForChannel 失败), null-guard 跳过 save.
      if (agent) {
        try {
          await agent.saveCurrentSession(sessionKey);
        } catch (saveErr: any) {
          console.warn(`[web] saveCurrentSession failed (non-fatal): ${saveErr.message?.slice(0, 100)}`);
        }
      }

      // 2026-08-02: run-end skill 候选扫描 (fire-and-forget, 不阻塞 finally)
      //   从本轮 lastSteps 提取连续成功的工具调用模式, 写入 ~/.bolloon/skill-candidates/.
      //   agent 之后可调 list_skill_candidates / promote_skill 决定是否转正.
      try {
        const steps = runState.lastSteps || [];
        const okTools = steps.filter(s => s.status === 'ok' && s.name && s.name !== 'system');
        if (okTools.length >= 2) {
          setImmediate(async () => {
            try {
              const { writeSkillCandidate } = await import('../agents/skill-writer.js');
              const toolNames = okTools.map(s => s.name).slice(0, 5).join(', ');
              const body = `## 背景\n本轮对话连续成功调用了 ${okTools.length} 个工具: ${toolNames}.\n\n## 流程\n${okTools.map(s => `1. 调用 ${s.name}${s.output ? ': ' + String(s.output).slice(0, 120) : ''}`).join('\n')}\n\n## 注意事项\n- 工具名以 list_skills / get_operation_logs 的实际注册名为准\n- 沉淀为正式 skill 前请人工确认流程可复用\n`;
              const candName = `auto-${okTools[0].name}-${Date.now().toString(36)}`;
              const file = await writeSkillCandidate({
                name: candName,
                description: `自动候选: ${okTools.length} 个工具连续成功 (${toolNames})`,
                body,
                source: `channel:${channelId}`,
                timestamp: new Date().toISOString(),
              });
              console.log(`[skill-candidates] 写入候选 ${file} (${okTools.length} tools)`);
            } catch (candErr: any) {
              console.warn('[skill-candidates] 写入失败 (non-fatal):', candErr?.message?.slice(0, 150));
            }
          });
        }
      } catch { /* 非致命 */ }
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
    // 2026-07-15 修 Bug 8: 入队的消息保留 attachments, 不然第二轮发送文件会丢
    attachments?: Array<{ attachmentId: string; filename?: string; mimeType?: string; size?: number }>;
    // req 上传附件给 LLM 时需要的 channelDid 也得传过来
    channelDid?: string;
  }
  interface ChannelRunState {
    running: boolean;
    queue: PendingMessage[];
    abortController: AbortController | null;
    // 2026-06-16: loop 检查 — 最近一轮的步骤/摘要/最终回复/token
    lastSteps?: Array<{ name: string; status: string; durationMs?: number; output?: string }>;
    lastSummary?: string;
    lastFinalReply?: string;
    lastTokens?: { input?: number; output?: number };
  }
  const channelRunState: Map<string, ChannelRunState> = new Map();
  function getOrCreateRunState(channelId: string): ChannelRunState {
    let s = channelRunState.get(channelId);
    if (!s) {
      s = { running: false, queue: [], abortController: null, lastSteps: [], lastSummary: '', lastFinalReply: '', lastTokens: {} };
      channelRunState.set(channelId, s);
    }
    return s;
  }

  /** 抽离 attachment contextHint 出来 — 给 queue-drain 用; /message 主路径有 inline 等价版避免重复 hoist 错误 */
  function buildAttachmentContextForQueue(parsedAttachments: any[]): string {
    if (!parsedAttachments || parsedAttachments.length === 0) return '';
    return `[系统上下文] 用户上传了 ${parsedAttachments.length} 个附件: ` +
      parsedAttachments.map((a: any) => `${a.filename || a.attachmentId} (id=${a.attachmentId}, mime=${a.mimeType || '?'}, size=${a.size ?? '?'}B, URL=/api/attachments/${a.attachmentId})`).join('; ') +
      `\n你可以调用文件读工具 (curl /api/attachments/<id>) 拉取真实内容。\n\n`;
  }

  /**
   * 2026-07-15 修 Bug 8: 队列消息的执行器 — finally 排空 queue 时调这里
   * 跑下一条 queued 消息.
   *
   * 设计: 这是个 fire-and-forget wrapper, 复用 /message 主路径的 broadcast / save / etc.
   * 简化路径 (跟主路径 500 行 try 块相比):
   *   - 不重新建载 judgment hint / persona / context — server.ts 这次明确把这些容
   *     易"廉价放"在 /message 主路径, queue 路径只用基本标识
   *   - 仍然是合法: agent.promptStream → broadcast(type:user) → broadcast(type:ai) → done
   *   - 处理 attachments: 跟主路径一样
   *
   * 如果要 1:1 复刻主路径的所有 hooks (judgment hint / persona / manifest / etc),
   * 后续可以把 /message 主路径的 try 块抽成 runPromptChannel 共享.
   */
  async function runMessageFromQueue(queued: any): Promise<void> {
    const { channelId, text, attachments, channelDid: reqChannelDid, boundWalletAddress, autoToolsEnabled } = queued;
    const runState = getOrCreateRunState(channelId);
    if (runState.running) return; // 防重入 — queue 已经并发去重
    runState.running = true;
    runState.abortController = new AbortController();

    const currentSessionId = (await loadChannels()).find(c => c.id === channelId)?.currentSessionId || 'default';
    const realChannelDid = reqChannelDid || (await loadChannels()).find(c => c.id === channelId)?.did || '';

    const parsedAttachments: Array<{ attachmentId: string; filename?: string; mimeType?: string; size?: number }> =
      Array.isArray(attachments) ? attachments : [];
    const attachmentContext = buildAttachmentContextForQueue(parsedAttachments);
    const sessionKey = `${channelId}:${currentSessionId}`;

    // 防 LLM hang 安全网
    const PIVOT_FORCE_TIMEOUT_MS = 5 * 60 * 1000;
    const forceTimeout = setTimeout(() => {
      console.warn(`[server] queue-drain pivot 强制 timeout, aborting`);
      runState.abortController?.abort();
    }, PIVOT_FORCE_TIMEOUT_MS);

    let agent: AgentSession | null = null;

    try {
      // 1) broadcast user 给前端 (跟主路径一致)
      broadcast({ type: 'user', content: text }, channelId);

      // 2) 取 agent + session
      agent = await getAgentForChannel(channelId, currentSessionId).catch(() => null);
      if (!agent) {
        throw new Error(`No agent for channel=${channelId}`);
      }

      // 3) 重 build contextHint (基本版, 不全 500 行 hook)
      //   原因: queue-drain 是常见调试路径, 全量 hooks 性能大. 关键是 attachments 带上.
      const contextHint = attachmentContext + `[系统上下文] 队列消息 (auto-drain)\n`;
      // 4) promptStream
      const markedPrompt = `【本轮用户请求】\n${text}\n【请求结束】\n\n${contextHint}`;
      const fullResponse = await agent.promptStream(markedPrompt, () => {}, runState.abortController?.signal, channelId);

      if (!fullResponse.trim()) {
        broadcast({ type: 'error', content: '⚠️ AI 未返回内容' }, channelId);
      } else {
        broadcast({ type: 'ai', content: fullResponse }, channelId);
        // 落 session
        try {
          const existing = await loadSession(channelId, currentSessionId);
          const session: any = existing || { channelId, sessionId: currentSessionId, messages: [], lastUpdated: new Date().toISOString() };
          session.sessionId = currentSessionId;
          // 跟主路径相同: 不重复 push user (主路径已 broadcast/push), 只 push ai
          session.messages.push({
            id: crypto.randomUUID(),
            type: 'ai' as const,
            content: fullResponse,
            timestamp: new Date().toISOString(),
            source: 'local' as any,
          });
          session.lastUpdated = new Date().toISOString();
          await saveSession(session);
        } catch (e: any) {
          console.warn('[queue-drain] saveSession failed:', e?.message?.slice(0, 100));
        }
      }

      broadcast({ type: 'done' }, channelId);
    } catch (err: any) {
      console.warn('[queue-drain] failed:', err?.message?.slice(0, 200));
      broadcast({ type: 'error', content: 'queue-drain: ' + (err?.message || 'failed') }, channelId);
    } finally {
      clearTimeout(forceTimeout);
      runState.running = false;
      runState.abortController = null;
      broadcastQueueUpdate(channelId);

      // 递归 drain — 同 /message 主路径 finally 行为保持一致
      if (runState.queue.length > 0) {
        const next = runState.queue.shift()!;
        console.log(`[queue-drain-recursive] channel=${next.channelId} text="${next.text.slice(0, 30)}"`);
        setImmediate(() => {
          void runMessageFromQueue(next).catch((e: any) => {
            console.error('[queue-drain-recursive] error:', e?.message?.slice(0, 200));
          });
        });
      }

      if (agent) {
        try { await agent.saveCurrentSession(sessionKey); } catch {}
      }
    }
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

    let identity: import('../agents/agent-identity.js').AgentIdentity | null = null;
    try {
      // 用 agentId 作为持久化身份的 key — 确保同一 agentId 跨重启稳定
      identity = loadOrCreateAgentIdentity(channel.agentId || channel.id);
      channel.did = identity.did;
      channel.publicKey = identity.publicKey;
    } catch (e) {
      // 兜底: 用 channelId 派生, 不阻塞 UI
      console.warn(`[DID 修复] ${channel.name} agentIdentity 加载失败:`, (e as Error).message);
      channel.did = `did:web:${channel.id}`;
      channel.publicKey = `pk_${channel.id}`;
    }
    console.log(`[DID 修复] ${channel.name} DID = ${channel.did} (${identity?.reused ? '复用' : '新建'} agent 持久身份)`);

    // IPFS 注册: 失败也无所谓, 后续可重试
    try {
      const pkBytes = Buffer.from(channel.publicKey, 'hex');
      const kp = { privateKey: new Uint8Array(32), publicKey: pkBytes, did: channel.did };
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
    // 2026-08-02 fix: 原子写入 — DID 修复是异步队列, 与创建/改名的裸 saveChannels
    //   并发时用旧数组覆盖 (lost update), 这是"重启后 channel 消失"的根因之一.
    await updateChannels((chs) => {
      const c = chs.find(x => x.id === channelId);
      if (c) {
        c.did = channel.did;
        c.publicKey = channel.publicKey;
        c.cid = channel.cid;
        c.didDocRef = channel.didDocRef;
        c.updatedAt = new Date().toISOString();
      }
      return chs;
    });
  }

  // 频道列表响应缓存: 短时间内重复请求走缓存, 避免每次重读 + 重序列化 channels.json
  // 跨作用域 (saveChannels 在模块顶层, 本函数在 createWebServer 内) 用 lastChannelsWriteAt 协调失效
  const channelsCache = { data: null as Channel[] | null, cachedAt: 0 };
  const CHANNELS_CACHE_TTL_MS = 500;

  /** 获取频道列表 — 立即返回, 缺 DID 的频道入队后台修复 */
  async function getChannelsWithDID(): Promise<Channel[]> {
    const now = Date.now();
    // 缓存命中: 数据有效 AND 在写盘之后 AND 在 TTL 内
    if (channelsCache.data && channelsCache.cachedAt > getLastChannelsWriteAt() && channelsCache.cachedAt + CHANNELS_CACHE_TTL_MS > now) {
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
    // 2026-06-17: 缓存命中 → 0 行;未命中 → 1 行 summary (上面 console.log proxy 已吃掉 [API] /channels 等旧日志)
    const t0 = Date.now();
    const now = t0;
    const hit = !!(channelsCache.data && channelsCache.cachedAt > getLastChannelsWriteAt() && channelsCache.cachedAt + CHANNELS_CACHE_TTL_MS > now);
    const channels = await getChannelsWithDID();
    if (!hit) {
      console.log(`[channels] refresh, n=${channels.length}, t=+${Date.now() - t0}ms`);
    }
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
      // 2026-08-02 fix: 同 agentId 下禁止重名 — 之前用户连点两次"新建智能体"生成两个同名
      //   "智能体" channel, UI 无法区分 (分享栏名字对不上 id). 同 agentId 同名直接拒绝.
      const dupName = channels.find(c => c.agentId === agentId && c.name === name.trim());
      if (dupName) {
        return res.status(400).json({
          error: `同名智能体已存在 (${dupName.name}, id=${dupName.id}), 请换一个名字`
        });
      }
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
      // 2026-08-02 fix: 用 updateChannels 原子写入 — 之前 channels.push + saveChannels(channels)
      //   是裸 read-modify-write, 与 /message updatedAt 保存等并发时会互相覆盖 (lost update),
      //   新 channel 可能被旧数组冲掉 → 重启后只剩一个 channel 的 bug.
      await updateChannels((chs) => {
        chs.push(channel);
        return chs;
      });
      await saveSession({ channelId: id, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString() });

      // 2026-07-15 修 Bug 6: 同步把 agent 定义写进 ~/.bolloon/agents/agents.json
      //   之前 channel 只落 channels.json, 不会出现在 agents.json 里.
      //   重新启动 server 时 loadLocalSubAgents 只读 agents.json — 用户以为"智能体没保存".
      //   修法: 直接读 + append (idempotent) 写 agents.json, 用 channel.agentId 作为主键 (跟 channels.json 引用对齐).
      //   不走 SubAgentManager.registerAgent 因为它会自己生成新 id, 跟 channel.agentId 对不上.
      try {
        const agentsPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'agents', 'agents.json');
        await fs.mkdir(path.dirname(agentsPath), { recursive: true });
        let arr: any[] = [];
        try { arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8')); } catch {}
        if (!Array.isArray(arr)) arr = [];
        const exists = arr.some(a => a && a.id === agentId);
        if (!exists) {
          arr.push({
            id: agentId,
            name,
            did: `did:local:${id}`,
            description: `Agent ${name} (auto-registered from channel ${id})`,
            capabilities: Array.isArray(channelPersona?.capabilities) ? channelPersona.capabilities : [],
            status: 'active',
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            channelId: id,
          });
          await fs.writeFile(agentsPath, JSON.stringify(arr, null, 2), 'utf-8');
          console.log(`[创建频道] agent 写进 agents.json: name=${name} id=${agentId}`);
        }
      } catch (e: any) {
        console.warn('[创建频道] 写 agents.json 失败 (非致命):', e?.message?.slice(0, 120));
      }

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

      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) {
          if (!c.sessions) c.sessions = [];
          c.sessions.push(session);
          c.currentSessionId = sessionId;
          c.updatedAt = new Date().toISOString();
        }
        return chs;
      });
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
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) { c.currentSessionId = sessionId; c.updatedAt = new Date().toISOString(); }
        return chs;
      });

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
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c && c.sessions) {
          const idx = c.sessions.findIndex(s => s.id === sessionId);
          if (idx >= 0) c.sessions.splice(idx, 1);
          if (c.currentSessionId === sessionId && c.sessions[0]) {
            c.currentSessionId = c.sessions[0].id;
          }
          c.updatedAt = new Date().toISOString();
        }
        return chs;
      });

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
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const idx = chs.findIndex(c => c.id === channelId);
        if (idx >= 0) chs.splice(idx, 1);
        return chs;
      });

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

      // 2026-07-15 修 Bug 7: 同步清理 agents.json 里挂在这个 channel 下的 agent 定义
      //   之前 v0.3.6 (Bug 6) 创建频道时同步往 agents.json append, 删频道却没删回来
      //   → agents.json 里残留孤儿 agent, 重启后 loadLocalSubAgents 还能读到这些 — 看起来像"删不掉"
      //   修法: 用 channel.agentId 找, 同步从 agents.json 删一条
      try {
        const agentsPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'agents', 'agents.json');
        const raw = await fs.readFile(agentsPath, 'utf-8').catch(() => '');
        if (raw) {
          let arr: any[] = [];
          try { arr = JSON.parse(raw); } catch {}
          if (!Array.isArray(arr)) arr = [];
          const before = arr.length;
          arr = arr.filter(a => !(a && (a.id === channel.agentId || a.channelId === channelId)));
          if (arr.length !== before) {
            await fs.writeFile(agentsPath, JSON.stringify(arr, null, 2), 'utf-8');
            console.log(`[删除频道] agents.json 清掉 ${before - arr.length} 条 orphan agent (channel=${channelId})`);
          }
        }
      } catch (e: any) {
        console.warn('[删除频道] 清理 agents.json 失败 (非致命):', e?.message?.slice(0, 120));
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
      // 2026-08-02 fix: 原子写入 — 之前回调只写 shared_with_peers/share_id, name 等字段
      //   只改了外层内存对象, 磁盘没落 → 改名后重启名字回退 / 与 UI 显示不一致 ("改名没修好")
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) {
          if (typeof name === 'string' && name.trim()) c.name = name.trim();
          if (persona !== undefined) {
            if (persona === null) c.persona = undefined;
            else if (typeof persona === 'object') c.persona = channel.persona;
          }
          if (Array.isArray(linkedDocumentIds)) c.linkedDocumentIds = channel.linkedDocumentIds;
          if (walletAddress !== undefined) {
            c.walletAddress = channel.walletAddress;
            c.walletRegisteredAt = channel.walletRegisteredAt;
          }
          if (typeof autoInvokeTools === 'boolean') c.autoInvokeTools = channel.autoInvokeTools;
          if (bound_judgment_ids !== undefined) c.bound_judgment_ids = channel.bound_judgment_ids;
          if (shared_with_peers !== undefined) c.shared_with_peers = channel.shared_with_peers;
          if (!c.share_id) c.share_id = channel.share_id;
          c.updatedAt = new Date().toISOString();
        }
        return chs;
      });
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
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) {
          c.walletAddress = walletAddress;
          c.walletRegisteredAt = new Date().toISOString();
          if (typeof autoInvokeTools === 'boolean') c.autoInvokeTools = autoInvokeTools;
          c.updatedAt = new Date().toISOString();
        }
        return chs;
      });
      console.log(`[Wallet] channel ${channelId} 绑定钱包 ${channel.walletAddress} 到 DID ${did}`);
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 存储加密私钥: 客户端用 DID 派生 AES-GCM 密钥加密私钥后上传.
   * body: { encryptedPrivateKey (base64), encryptedPrivateKeyIv (base64), autoPayEnabled? }
   */
  app.post('/channels/:channelId/encrypted-key', async (req, res) => {
    try {
      const { channelId } = req.params;
      const { encryptedPrivateKey, encryptedPrivateKeyIv, autoPayEnabled } = req.body || {};
      if (!encryptedPrivateKey || !encryptedPrivateKeyIv) {
        return res.status(400).json({ error: '缺少必填字段: encryptedPrivateKey, encryptedPrivateKeyIv' });
      }
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      channel.encryptedPrivateKey = encryptedPrivateKey;
      channel.encryptedPrivateKeyIv = encryptedPrivateKeyIv;
      if (typeof autoPayEnabled === 'boolean') {
        channel.autoPayEnabled = autoPayEnabled;
      }
      channel.updatedAt = new Date().toISOString();
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) {
          c.encryptedPrivateKey = encryptedPrivateKey;
          c.encryptedPrivateKeyIv = encryptedPrivateKeyIv;
          if (typeof autoPayEnabled === 'boolean') c.autoPayEnabled = autoPayEnabled;
          c.updatedAt = new Date().toISOString();
        }
        return chs;
      });
      console.log(`[Wallet] channel ${channelId} 已存储加密私钥 (autoPay=${channel.autoPayEnabled})`);
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** 清除加密私钥 (用户选择不再自动支付) */
  app.delete('/channels/:channelId/encrypted-key', async (req, res) => {
    try {
      const { channelId } = req.params;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      channel.encryptedPrivateKey = undefined;
      channel.encryptedPrivateKeyIv = undefined;
      channel.autoPayEnabled = false;
      channel.updatedAt = new Date().toISOString();
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) {
          c.encryptedPrivateKey = undefined;
          c.encryptedPrivateKeyIv = undefined;
          c.autoPayEnabled = false;
          c.updatedAt = new Date().toISOString();
        }
        return chs;
      });
      console.log(`[Wallet] channel ${channelId} 已清除加密私钥`);
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** 切换 autoPay 开关 */
  app.patch('/channels/:channelId/auto-pay', async (req, res) => {
    try {
      const { channelId } = req.params;
      const { autoPayEnabled } = req.body || {};
      if (typeof autoPayEnabled !== 'boolean') {
        return res.status(400).json({ error: 'autoPayEnabled 必须是 boolean' });
      }
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      channel.autoPayEnabled = autoPayEnabled;
      channel.updatedAt = new Date().toISOString();
      // 2026-08-02 fix: 原子写入
      await updateChannels((chs) => {
        const c = chs.find(x => x.id === channelId);
        if (c) { c.autoPayEnabled = autoPayEnabled; c.updatedAt = new Date().toISOString(); }
        return chs;
      });
      console.log(`[Wallet] channel ${channelId} autoPay → ${autoPayEnabled}`);
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2026-07-07 P1-C: 列出 channel 的项目事件日志 (L2)
  // 用于客户端时间线折叠块 + LLM prompt 注入
  app.get('/api/events/:channelId', async (req, res) => {
    try {
      const { listEvents } = await import('../bootstrap/event-log.js');
      const limit = parseInt((req.query.limit as string) || '20', 10);
      const type = req.query.type as any;
      const events = await listEvents({
        channelId: req.params.channelId,
        limit: Math.min(limit, 100),
        type: type || undefined,
      });
      res.json({ events, total: events.length });
    } catch (err: any) {
      console.warn(`[api/events] ${req.params.channelId} 失败: ${err?.message || err}`);
      res.json({ events: [], total: 0 });
    }
  });

  // 2026-07-07 P1-C: 追加一条事件 (前端按钮 / 自动检测)
  app.post('/api/events/:channelId', async (req, res) => {
    try {
      const { appendEvent, EVENT_TYPES } = await import('../bootstrap/event-log.js');
      const { type, summary, detail, source, agentId } = req.body || {};
      if (!type || !EVENT_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of ${EVENT_TYPES.join(', ')}` });
      }
      if (!summary || typeof summary !== 'string') {
        return res.status(400).json({ error: 'summary required' });
      }
      const r = await appendEvent({
        channelId: req.params.channelId,
        type,
        summary: summary.slice(0, 200),
        detail: detail || {},
        source: source || 'user',
        agentId,
      });
      res.json({ ok: true, ...r });
    } catch (err: any) {
      console.warn(`[api/events POST] ${req.params.channelId} 失败: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/sessions/:channelId', async (req, res) => {
    try {
      // 2026-07-07 H2 修复: channel 不存在 → 404 (之前返回空 Session 导致客户端误以为是空对话)
      const channels = await loadChannels();
      if (!channels.find(c => c.id === req.params.channelId)) {
        return res.status(404).json({ error: 'channel not found', channelId: req.params.channelId });
      }
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
      // 2026-06-15: 同 /message 路径, 用显式 marker 包裹 userMessage, 避免 LLM 把它当背景信息
      const regenHint = await buildJudgmentHint(channel, channelId);
      const markedRegen = `${regenHint}\n\n【本轮用户请求】\n${userMessage}\n【请求结束】\n`;
      fullResponse = await agent.promptStream(markedRegen, streamCallback, undefined, channelId);

      // 2026-07-06: 防御性兜底 — 同 /message 路径
      if (!fullResponse.trim()) {
        fullResponse = '⚠️ AI 未返回内容, 请重试';
      }

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

  // 2026-07-06: Task Queue API 抽到 ./routes-tasks.ts
  registerTaskRoutes(app, { broadcast, getAgentForChannel });

  // 2026-07-06: LLM/Video/Audio 配置路由抽到 ./routes-llm-config.ts
  registerLlmConfigRoutes(app);

  // 2026-07-22: 外部编码智能体 (codex/claude-code/opencode/openclaw/hermes/实验 API)
  // 发现 + 配置为供应商 + 委派
  registerExternalEngineRoutes(app);

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
      const { removePeer, listPeers } = await import('../network/known-peers.js');
      // 2026-08-02: 删除好友时同时撤回分享 — 从所有 channel 的 shared_with_peers 移除该 peer
      // 参数支持 name 或 publicKey (陌生 peer 只有 publicKey, 不在 known_peers)
      const peers = await listPeers();
      const param = req.params.name;
      const target = peers.find(p => p.name === param) || peers.find(p => p.publicKey === param);
      if (target) {
        const { readFile, writeFile } = await import('fs/promises');
        const channelsPath = `${process.env.HOME || '/tmp'}/.bolloon/sessions/channels.json`;
        try {
          const raw = await readFile(channelsPath, 'utf-8');
          const chData = JSON.parse(raw);
          const chs = Array.isArray(chData) ? chData : (chData.channels || []);
          let changed = 0;
          for (const ch of chs) {
            if (Array.isArray(ch.shared_with_peers) && ch.shared_with_peers.includes(target.publicKey)) {
              ch.shared_with_peers = ch.shared_with_peers.filter((pk: string) => pk !== target.publicKey);
              changed++;
            }
          }
          if (changed > 0) {
            if (Array.isArray(chData)) await writeFile(channelsPath, JSON.stringify(chs, null, 2), 'utf-8');
            else { chData.channels = chs; await writeFile(channelsPath, JSON.stringify(chData, null, 2), 'utf-8'); }
            console.log(`[p2p-peers] 删除好友 ${param}: 撤回 ${changed} 个 channel 的分享`);
          }
        } catch (e: any) {
          console.warn('[p2p-peers] 撤回 channel 分享失败 (non-fatal):', e?.message?.slice(0, 120));
        }
      }
      // 2026-08-02: 同时清掉 remote channel cache (内存 + 磁盘) — 否则 topic 在线节点
      //   删除后仍以 "陌生 peer" (peer-xxx) 出现在 UI, 无法真正删除
      try {
        const targetPk = target?.publicKey || (param.length === 64 ? param : null);
        if (targetPk) remoteChannelCache.delete(targetPk);
        const { existsSync } = await import('fs');
        if (existsSync(REMOTE_CACHE_FILE)) {
          const { readFile, writeFile } = await import('fs/promises');
          const cacheObj = JSON.parse(await readFile(REMOTE_CACHE_FILE, 'utf-8'));
          if (cacheObj && typeof cacheObj === 'object') {
            const pkToDel = targetPk || Object.keys(cacheObj).find((k: string) => k === param);
            if (pkToDel && cacheObj[pkToDel]) {
              delete cacheObj[pkToDel];
              await writeFile(REMOTE_CACHE_FILE, JSON.stringify(cacheObj, null, 2), 'utf-8');
              console.log(`[p2p-peers] 已清 remote cache: ${pkToDel.substring(0, 12)}...`);
            }
          }
        }
      } catch (e: any) {
        console.warn('[p2p-peers] 清 remote cache 失败 (non-fatal):', e?.message?.slice(0, 120));
      }
      // 陌生 peer (只有 publicKey) 不在 known_peers, removePeer 无操作也 ok
      await removePeer(target?.name || param);
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
      const { targetPublicKey, name, message, note } = req.body || {};
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
          message: message || '想加你为 P2P 好友, 共享 channel 协作',
          note: note || message || undefined,   // 2026-08-02: 备注 (自我介绍/来源), 优先显式 note
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

  // v3: 待处理好友申请查询 (智能体工具 list_pending_friend_requests 用)
  // 用法: GET /api/friend-requests
  app.get('/api/friend-requests', async (_req, res) => {
    const list = Array.from(pendingFriendRequests.values()).map(r => ({
      requestId: r.requestId,
      fromPublicKey: r.fromPublicKey,
      fromName: r.fromName,
      message: r.message,
      note: r.note || '',
      receivedAt: r.receivedAt,
    }));
    res.json({ count: list.length, requests: list });
  });

  // v3: 忽略/拒绝一个待处理好友申请 (智能体工具 ignore_friend_request 用)
  // 用法: POST /api/friend-requests/ignore { requestId }
  app.post('/api/friend-requests/ignore', async (req, res) => {
    try {
      const { requestId } = req.body || {};
      if (!requestId || !pendingFriendRequests.has(requestId)) {
        return res.status(404).json({ error: `未找到 requestId=${requestId} 的申请` });
      }
      const r = pendingFriendRequests.get(requestId)!;
      pendingFriendRequests.delete(requestId);
      persistPendingFriendRequests();  // 2026-08-02: 落盘
      console.log(`[v3-friend] 忽略好友申请: ${r.fromName} (${r.fromPublicKey.substring(0, 12)}...)`);
      res.json({ ok: true, ignored: r.fromName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3: 接受对方的好友申请 — 把对方加为 known_peers, 立即推我的 channel 列表给 ta
  // 用法: POST /api/friend-accept { fromPublicKey, name, requestId? }
  app.post('/api/friend-accept', async (req, res) => {
    try {
      if (!v3P2PRef) {
        return res.status(503).json({ error: 'P2PDirect not started' });
      }
      const { fromPublicKey, name, requestId } = req.body || {};
      if (!fromPublicKey || typeof fromPublicKey !== 'string' || fromPublicKey.length !== 64) {
        return res.status(400).json({ error: 'fromPublicKey (64 hex) required' });
      }
      // 2026-08-02: 接受后清掉 pending 条目 (若带了 requestId)
      if (requestId) {
        pendingFriendRequests.delete(requestId);
        persistPendingFriendRequests();
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
      const { targetPublicKey, channelId, text, autoInvokeTools } = req.body || {};
      if (!targetPublicKey || !channelId || !text) {
        return res.status(400).json({ error: 'targetPublicKey, channelId, text required' });
      }
      if (typeof text !== 'string' || text.length === 0 || text.length > 8000) {
        return res.status(400).json({ error: 'text length must be 1-8000' });
      }
      const fromPk = v3P2PRef.getPublicKey();
      // 2026-07-27: 改用 sendOrQueue (先尝试直发, 失败则入队, 不断线不丢)
      // 2026-08-02: 透传 autoInvokeTools (发送方工具开关设置, 只对本次远端消息生效)
      const { sendOrQueue } = await import('../network/p2p-outbox.js');
      const r = await sendOrQueue(targetPublicKey, 'agent.chat.send', {
        channelId, text, fromPublicKey: fromPk,
        ...(typeof autoInvokeTools === 'boolean' ? { autoInvokeTools } : {}),
      }, v3P2PRef);
      if (r === 'FAILED') {
        return res.status(502).json({ error: 'send failed: peer not reachable' });
      }
      // 2026-06-10: 喂 watchdog — chat-send 成功是真实业务活动
      watchdogRef?.recordActivity?.();
      console.log(`[v3] chat-send 转发到 ${targetPublicKey.substring(0, 12)}... (channelId=${channelId}) => ${r}`);
      res.json({ ok: true, sent: r === 'SENT', queued: r === 'QUEUED' });
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
  // 2026-07-22 设计 C: 引擎背压 API (涡轮增压表, 隐式可观测 — 废气内容不暴露, 只展示压力等级)
  app.get('/api/engine/backpressure', async (_req, res) => {
    try {
      const { getBackpressure } = await import('../bootstrap/exhaust-scrubber.js');
      const snap = getBackpressure();
      res.json({ ok: true, ...snap });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/iroh/info', async (_req, res) => {
    if (!irohInitialized || !irohNodeInfo) {
      res.json({ initialized: false });
      return;
    }
    // 2026-07-04: irohTransport.getNodeId() 在某些环境下返回空字符串 (@rayhanadev/iroh + Windows
    //   native binding 启动延迟). fallback: 用 v3 P2PDirect (hyperswarm) 的 publicKey 兜底,
    //   保证客户端拿到一个可用的 peer id (v3 是实际数据通道, 不是 mock).
    let effectiveNodeId = irohNodeInfo.irohNodeId;
    if (!effectiveNodeId && v3P2PRef) {
      try {
        effectiveNodeId = v3P2PRef.getPublicKey() || '';
        if (effectiveNodeId) {
          console.log('[iroh API] irohNodeId 为空, fallback 到 v3 P2PDirect publicKey:', effectiveNodeId.substring(0, 16) + '...');
        }
      } catch { /* ignore */ }
    }
    res.json({
      initialized: true,
      did: irohNodeInfo.did,
      cid: irohNodeInfo.cid,
      irohNodeId: effectiveNodeId,
      irohNodeIdSource: effectiveNodeId === irohNodeInfo.irohNodeId ? 'iroh' : (effectiveNodeId ? 'v3-p2p-fallback' : 'unavailable'),
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
        // 2026-08-02 fix: abort 后立即广播 done — 之前前端靠 1.5s 兜底 setTimeout 切回 idle,
        //   视觉上"点了没反应". 这里主动推 done, 前端 finalizeTimelineAsMessage + setSendMode('idle') 立刻生效.
        try {
          broadcast({ type: 'done' }, channelId);
        } catch { /* 广播失败不影响 abort 主流程 */ }
        return res.json({ ok: true, aborted: true });
      }
      res.json({ ok: true, aborted: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2026-07-06: SSE 断连恢复 — 拉该 channel 从 afterSeq 之后的 AI 回复 + 状态
  // body: { channelId, sessionId?, afterSeq }
  app.post('/api/chat/resume', async (req, res) => {
    try {
      const { channelId, sessionId, afterSeq } = req.body as { channelId?: string; sessionId?: string; afterSeq?: number };
      if (!channelId) return res.status(400).json({ error: 'channelId required' });
      const curSeq = channelEventSeq.get(channelId) || 0;
      // 1) 拉 session.messages — 这部分已经持久化, 不依赖内存 state
      const sess = await loadSession(channelId, sessionId || 'default');
      const messages = sess?.messages || [];
      // 2) 找从 afterSeq 之后发生的 user/ai 消息 (从 messages[] 推导出"事后视角")
      // 注意: messages[] 是按时间顺序, 没有 seq 字段; 我们用 lastUpdated + AI msgId 列表 推断
      // 简单方案: 返回 channels 上 >= afterSeq 对应时间的 ai/user messages (按 timestamp 截)
      // 因为 seq 是事件层, messages 是实体层 — 这里实体层的 fallback 就够用
      const afterSeqNum = typeof afterSeq === 'number' ? afterSeq : 0;
      // 启发式: 如果当前 seq 已经超过 afterSeq, 至少漏了一些事件
      const missedSome = curSeq > afterSeqNum;
      // 3) 返回给前端的"补发包": 当 missedSome, 拿最近 1 轮 user+ai (最近的 ai message)
      let resume: any = {
        ok: true,
        channelId,
        currentSeq: curSeq,
        missedSome,
        recoveredMessages: [] as any[],
      };
      if (missedSome && messages.length > 0) {
        // 拿最后一条 ai message
        const lastAi = [...messages].reverse().find(m => m.type === 'ai');
        if (lastAi) {
          resume.recoveredMessages.push({
            msgId: lastAi.id || `recover_${Date.now()}`,
            type: 'ai',
            content: lastAi.content,
            source: lastAi.source,
            timestamp: lastAi.timestamp,
          });
        }
        // 拿最近一条 user message (如果不是用户本地发的, 也能补全)
        const lastUser = [...messages].reverse().find(m => m.type === 'user');
        if (lastUser) {
          resume.recoveredMessages.push({
            msgId: lastUser.id || `recover_user_${Date.now()}`,
            type: 'user',
            content: lastUser.content,
            source: lastUser.source,
            timestamp: lastUser.timestamp,
          });
        }
        // 4) 如果当前还在跑 (channelRunState.running), 通知前端"正在生成中"
        const runState = channelRunState.get(channelId);
        if (runState?.running) {
          resume.stillRunning = true;
          resume.partialText = runState.lastFinalReply || '';
        }
      }
      console.log(`[resume] channel=${channelId}, afterSeq=${afterSeqNum}, curSeq=${curSeq}, recovered=${resume.recoveredMessages.length}, stillRunning=${resume.stillRunning || false}`);
      res.json(resume);
    } catch (err: any) {
      console.error('[resume] failed:', err.message?.slice(0, 200));
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

  // 2026-07-06: judgments / self-improve / permission-mode 路由抽到 ./routes-judgments.ts
  registerJudgmentsRoutes(app);

  // 2026-07-15: judgeness · hearth 主路由 + peer 4 类写 API
  registerHearthRoutes(app);

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

  // 2026-06-16: 循环检查 — GET /api/loop/inspect?channelId=...
  // 返回最近一轮 ReAct loop 的产出: 步骤 / 工具调用 / 压缩摘要 / 最终回复 / token 用量.
  // 用于前端 status bar 的「✓ 检查」按钮弹 modal.
  app.get('/api/loop/inspect', async (req: any, res: any) => {
    try {
      const channelId = String(req.query.channelId || '');
      if (!channelId) return res.status(400).json({ error: 'channelId required' });
      const s = channelRunState.get(channelId);
      if (!s) return res.json({ summary: '该 channel 无活跃 loop', steps: [], finalReply: '' });
      const steps = (s.lastSteps || []).map((st: any) => ({
        name: st.name || st.tool || 'step',
        status: st.status || 'completed',
        durationMs: st.durationMs,
        output: st.output || st.result || '',
      }));
      res.json({
        summary: s.lastSummary || (s.running ? 'loop 仍在运行中' : 'loop 已结束'),
        steps,
        finalReply: s.lastFinalReply || '',
        tokens: s.lastTokens || {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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
  // 2026-06-16: 自迭代默认关 (用户模式), 仅 BOLLOON_DEV_MODE=1 或 selfImprove=true 启动项才装 callback
  if (healthMonitor) {
    if (selfImproveEnabled) {
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
    } else {
      // 用户模式: 只跑监控不打自改信号, 心跳仍工作
      healthMonitor.startPeriodicCheck(60000);
      console.log('[24h] Health monitor periodic check (no self-improve)');
    }
  }

  // 安装自改总线 -> SSE 桥 (开发者模式才装, 用户模式靠 /api/self-improve/trigger 手动触发)
  if (selfImproveEnabled) {
    void installSelfImproveHook();
  } else {
    console.log('[self-improve] 用户模式, installSelfImproveHook 跳过 (可用 POST /api/self-improve/trigger 手动触发)');
  }

  // 端口冲突时自动找下一个可用端口（最多 10 次），避免 EADDRINUSE 直接崩溃
  return new Promise<{ app: express.Express; server: ReturnType<typeof createServer>; port: number }>((resolve, reject) => {
    const maxAttempts = 10;
    const startPort = port;
    let currentPort = startPort;
    let attempt = 0;
    // 2026-06-24: 默认 loopback bind，避免在 LAN 上暴露 (CORS 已经 * 了)。
    // Electron 包装里强制 127.0.0.1; CLI 用户想 LAN 访问可显式 BOLLOON_HOST=0.0.0.0
    const bindHost = options.host ?? process.env.BOLLOON_HOST ?? '127.0.0.1';
    // 局部可变 server 引用 — listen 失败后必须重新 createServer 再 listen
    let currentServer: ReturnType<typeof createServer> = server;

    const tryListen = () => {
      currentServer.removeAllListeners('error');
      currentServer.once('error', onError);
      currentServer.listen(currentPort, bindHost, () => {
        if (currentPort !== startPort) {
          console.warn(`⚠ 端口 ${startPort} 被占用，已自动切换到 ${currentPort}`);
        }
        // 2026-06-24: BOLLOON_PORT=NNNN 是 Electron 主进程解析的契约行 (parseable),
        // 旧 marker ('服务器已监听') 也保留给日志/调试看。
        console.log(`BOLLOON_PORT=${currentPort}`);
        console.log(`BOLLOON_HOST=${bindHost}`);
        console.log(`Web 服务器启动完成: http://${bindHost}:${currentPort}`);
        console.log('服务器已监听');
        // 安装 chat bus -> SSE 桥 (供前端 inbox UI 实时刷新)
        void installChatBusHook();
        // 2026-06-16: ping 改为 data: {"type":"ping"} — 之前是 SSE 注释格式 (: ping\n\n),
        //   浏览器 EventSource 不触发 onmessage, 客户端 60s 阈值 (现已 30s) 误判死链.
        //   改后前端 onmessage 收到 ping 就重置 lastEventTime, 真死链才 30s 后重建.
        setInterval(() => {
          for (const client of sseClients) {
            try {
              client.res.write('data: {"type":"ping"}\n\n');
            } catch (err) {
              // socket 已断, 跳过 — client 端 onerror 会触发重连
              console.warn('[SSE ping] write 失败, 跳过该客户端:', (err as Error).message);
            }
          }
        }, 30000);
        // 2026-06-16: 全局捕获 socket error 事件, 避免未处理 EPIPE/ETIMEDOUT 让进程崩
currentServer.on('clientError', (err, socket) => {
           console.warn('[server] clientError:', (err as any).code, err.message);
          try { socket.end(); } catch {}
        });
        activeServer = currentServer;
        writeLock(currentPort);
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

// 2026-07-06: 每个 channelId 维护递增 sequence + msgId, 让前端能去重 + 重连后 resume
const channelEventSeq: Map<string, number> = new Map();
const channelMsgIds: Map<string, string> = new Map(); // channelId -> 上一条 msgId (uuid)

function nextEventSeq(channelId: string | undefined): number {
  if (!channelId) return 0;
  const cur = channelEventSeq.get(channelId) || 0;
  const next = cur + 1;
  channelEventSeq.set(channelId, next);
  return next;
}

function nextMsgId(channelId: string | undefined): string {
  const id = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  if (channelId) channelMsgIds.set(channelId, id);
  return id;
}

function broadcast(data: { type: string; [key: string]: unknown }, channelId?: string) {
  // 2026-06-10: 喂 watchdog, 避免 30min 空闲被误判 (recordActivity 内有 5s 去抖)
  watchdogRef?.recordActivity?.();
  // 2026-07-06: 加 seq + msgId, 前端断连重连后可请求 /api/chat/resume?channelId=X&afterSeq=N 拿回
  const seq = nextEventSeq(channelId);
  // 2026-07-06: 每次广播都用 crypto randomBytes 4 生成唯一 id — 防止 seq 撞车 + 前端 seenMsgIds 去重
  //   user/ai 用 nextMsgId (按 channelId 缓存最后一条) — 让 SSE onmessage 收到时识别
  //   其他事件用 evt_<ts>_<rand> 形式 — 让前端 seenMsgIds 集合能跨 emit 去重
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
  const comm = createHyperswarmCommunicator({ server: true, client: true, autoConnect: true, maxConnections: 50, seed: rawSeed });

  await comm.start();
  const topic = createTopic('bolloon-agent-harness');
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
