import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
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
import { irohTransport } from '../network/iroh-transport.js';
import { createAgentDelegateApp } from './agent-delegate-server.js';
import { createIrohDelegateTransport } from './iroh-delegate-transport.js';
import { verifyMessage, isAddress, getAddress } from 'viem';

// 前端资源路径：在打包后会通过 CommonJS require 加载，使用 import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webRoot = path.join(__dirname, '..', '..', 'dist', 'web');

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
let channelSessions: Map<string, AgentSession> = new Map(); // key: channelId
let sessionMessages: Map<string, any[]> = new Map(); // key: channelId + sessionId

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

    // 初始化 P2P 通信器
    try {
      const rawSeed = crypto.getRandomValues(new Uint8Array(32));
      p2pCommunicator = createHyperswarmCommunicator({
        server: true,
        client: true,
        autoConnect: true,
        maxConnections: 50,
        seed: rawSeed
      } as any);

      p2pCommunicator.on('connection', (conn: P2PConnection) => {
        console.log(`P2P 连接: ${conn.publicKey.substring(0, 8)}...`);
      });

      p2pCommunicator.on('message', async (msg: any, conn: P2PConnection) => {
        const content = new TextDecoder().decode(msg.content);
        console.log(`P2P 收到消息: ${content.substring(0, 50)}...`);
        // 可以在这里处理接收到的消息
        broadcast({ type: 'p2p_message', from: conn.publicKey.substring(0, 8), content }, undefined);
      });

      await p2pCommunicator.start();
      const topic = createTopic('bolloon-agent-harness') as Buffer;
      await p2pCommunicator.joinTopic(topic);
      console.log(`P2P 网络已就绪`);
    } catch (e: any) {
      console.log(`P2P 网络初始化失败: ${e.message}`);
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
    res.setHeader('Connection', 'keep-alive');
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

    // 提前捕获 wallet/autoTools 到本地变量, 避免下面 try 块内的 inner const channel
    // (line ~638) 与这里外层的 const channel 形成 shadowing 让 TS 误报"使用前未声明"
    const boundWalletAddress = channel?.walletAddress;
    const autoToolsEnabled = channel?.autoInvokeTools !== false; // 默认开启

    try {
      const agent = await getAgentForChannel(channelId, realChannelDid, realChannelName, realChannelDidDoc);
      let fullResponse = '';

      const streamCallback: StreamCallback = (event: StreamEvent) => {
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
        } else if (event.type === 'error') {
          broadcast({ type: 'error', content: event.content }, channelId);
        }
      };

      console.log(`[消息处理] 开始处理用户消息, channelId: ${channelId}, sessionId: ${currentSessionId}`);

      // 将真实 DID 作为上下文前缀，让 AI 使用真实的 DID 而不是自己编造的
      let contextHint = '';
      if (realChannelDid) contextHint += `[系统上下文] 当前频道名称: ${realChannelName}, 你的真实 DID: ${realChannelDid}\n`;
      if (boundWalletAddress) {
        contextHint += `[系统上下文] 已绑定的加密钱包地址: ${boundWalletAddress}。当用户授权或启用自动工具调用时, 可使用该地址发起链上操作。\n`;
      }
      if (autoToolsEnabled) {
        contextHint += `[系统上下文] 自动工具调用已开启: 你可以使用受信任的本地工具 (shell / 文件 / skill) 而无需逐次询问用户。\n`;
      } else {
        contextHint += `[系统上下文] 自动工具调用已关闭: 每次执行工具前必须先与用户确认。\n`;
      }
      if (contextHint) contextHint += '\n';
      fullResponse = await agent.promptStream(contextHint + text, streamCallback);

      broadcast({ type: 'ai', content: fullResponse }, channelId);

      const existingSession = await loadSession(channelId, currentSessionId);
      const session: Session = existingSession || { channelId, sessionId: currentSessionId, messages: [], lastUpdated: new Date().toISOString() };
      session.sessionId = currentSessionId;
      session.messages.push({ id: crypto.randomUUID(), type: 'user' as const, content: text, timestamp: new Date().toISOString() });
      session.messages.push({ id: crypto.randomUUID(), type: 'ai' as const, content: fullResponse, timestamp: new Date().toISOString() });
      session.lastUpdated = new Date().toISOString();
      await saveSession(session);

      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (channel && channel.name === '智能体') {
        const renameSuggestion = await agent.suggestRename(session.messages);
        if (renameSuggestion) {
          channel.name = renameSuggestion;
          await saveChannels(channels);
          broadcast({ type: 'renamed', channelId, newName: renameSuggestion }, channelId);
        }
      }
      if (channel) {
        channel.updatedAt = new Date().toISOString();
        await saveChannels(channels);
      }

      broadcast({ type: 'done' }, channelId);
      res.json({ ok: true });
    } catch (err: any) {
      broadcast({ type: 'error', content: err.message }, channelId);
      broadcast({ type: 'done' }, channelId);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 频道元数据后台修复队列 ----------
  // 关键点: 旧实现会在每次 GET /channels 时同步执行 KeyManager.generate() + IPFS POST,
  // 多频道场景下持续分配密钥对 + 发起 HTTP 请求, 几轮就会把 Node 内存撑爆。
  // 新实现: 入队 + 节流(2s) + 单飞, 立刻返回当前 channels, 修复异步进行。
  const didFixQueue = new Set<string>(); // 待修复的 channelId
  let didFixRunning = false;
  let didFixTimer: NodeJS.Timeout | null = null;

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

  app.post('/channels', async (req, res) => {
    try {
      const { name, agentId, walletAddress, autoInvokeTools } = req.body;
      console.log(`[创建频道] 收到请求: name=${name}, agentId=${agentId}, wallet=${walletAddress ? 'yes' : 'no'}`);
      if (!name || !agentId) {
        return res.status(400).json({ error: 'name and agentId required' });
      }
      const channels = await loadChannels();
      const id = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      // 校验钱包地址格式 (粗校验: 0x + 40 hex / Solana base58 / Sui 0x+64)
      const validWallet = isValidWalletAddress(walletAddress);

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
      const { name, walletAddress, autoInvokeTools } = req.body;
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (typeof name === 'string' && name.trim()) {
        channel.name = name.trim();
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
      channel.updatedAt = new Date().toISOString();
      await saveChannels(channels);
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

      const streamCallback: StreamCallback = (event: StreamEvent) => {
        if (event.type === 'token' || event.type === 'thinking') {
          broadcast({ type: 'stream', streamType: event.type, content: event.content }, channelId);
        } else if (event.type === 'status' || event.type === 'tool') {
          broadcast({ type: 'status', tool: event.tool, content: event.content }, channelId);
        } else if (event.type === 'error') {
          broadcast({ type: 'error', content: event.content }, channelId);
        }
      };

      // 重新生成时只发送用户消息
      fullResponse = await agent.promptStream(userMessage, streamCallback);

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
          timestamp: new Date().toISOString()
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

  // 主人审阅: 批准 draft
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

  // 主人审阅: 丢弃 draft
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
    watchdog = createWatchdog();

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

  app.get('/api/judgments', async (_req, res) => {
    try {
      const { loadAllJudgments, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const all = await loadAllJudgments();
      // 新的在前
      all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      res.json({ count: all.length, judgments: all });
    } catch (err: any) {
      console.error('[judgments] GET failed:', err);
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
      console.error('[Watchdog] memory critical, 进程退出 (期望外层重启)');
      setTimeout(() => process.exit(1), 100);
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

  return new Promise<{ app: express.Express; server: typeof server }>((resolve) => {
    server.listen(port, () => {
      console.log(`Web 服务器启动完成: http://localhost:${port}`);
      console.log('服务器已监听');
      // 安装 chat bus -> SSE 桥 (供前端 inbox UI 实时刷新)
      void installChatBusHook();
      setInterval(() => {
        for (const client of sseClients) {
          client.res.write(': ping\n\n');
        }
      }, 30000);
      resolve({ app, server });
    });
  });
}

function broadcast(data: { type: string; [key: string]: unknown }, channelId?: string) {
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