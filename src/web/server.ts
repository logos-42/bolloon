import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as fs from 'fs/promises';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SHARED_SESSION_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');
const SESSION_CACHE_PATH = path.join(SHARED_SESSION_PATH, 'cache');
const CHANNELS_PATH = path.join(SHARED_SESSION_PATH, 'channels.json');
const THEME_PATH = path.join(SHARED_SESSION_PATH, 'theme.json');

interface Channel {
  id: string;
  name: string;
  agentId: string;
  did?: string;
  publicKey?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionMessage {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: string;
}

interface Session {
  channelId: string;
  messages: SessionMessage[];
  lastUpdated: string;
}

async function ensureSessionDirs() {
  await fs.mkdir(SESSION_CACHE_PATH, { recursive: true });
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
  await fs.writeFile(CHANNELS_PATH, JSON.stringify(channels, null, 2));
}

async function loadSession(channelId: string): Promise<Session | null> {
  const sessionPath = path.join(SESSION_CACHE_PATH, `${channelId}.json`);
  try {
    const data = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveSession(session: Session): Promise<void> {
  const sessionPath = path.join(SESSION_CACHE_PATH, `${session.channelId}.json`);
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
        if (task.steps && task.currentStep !== undefined) {
          for (let i = task.currentStep; i < task.steps.length; i++) {
            task.steps[i].status = 'running';
            broadcast({ type: 'task_status', taskId: task.id, status: 'running', currentStep: i, totalSteps: task.steps.length }, channelId);

            broadcast({ type: 'status', content: `执行步骤 ${i + 1}/${task.steps.length}: ${task.steps[i].name}` }, channelId);

            // 执行步骤（这里简化处理，实际可能需要更复杂的逻辑）
            await new Promise(resolve => setTimeout(resolve, 500));
            task.steps[i].status = 'completed';
            task.progress = Math.round(((i + 1) / task.steps.length) * 100);
            broadcast({ type: 'task_status', taskId: task.id, progress: task.progress }, channelId);
          }
          result = '✅ 工作流执行完成';
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
let channelSessions: Map<string, AgentSession> = new Map();

async function getAgentForChannel(channelId: string): Promise<AgentSession> {
  if (!channelSessions.has(channelId)) {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: `channel-${channelId}`
    });
    channelSessions.set(channelId, session);
  }
  return channelSessions.get(channelId)!;
}

export async function createWebServer(port: number = 3000) {
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
    console.log('KeyManager.generate() 完成');

    const did = kp.did;
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

  const staticPath = join(__dirname, '..', '..', 'src', 'web');
  app.use(express.static(staticPath));

  app.get('/', (req, res) => {
    res.sendFile(join(staticPath, 'index.html'));
  });

  app.get('/api-config', (req, res) => {
    res.sendFile(join(staticPath, 'api-config.html'));
  });

  app.get('/events', (req, res) => {
    const channelId = req.query.channelId as string;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientInfo = { res, channelId };
    sseClients.add(clientInfo as any);

    req.on('close', () => {
      sseClients.delete(clientInfo as any);
    });
  });

  app.post('/message', async (req, res) => {
    const { text, channelId } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    if (!channelId) {
      return res.status(400).json({ error: 'No channelId provided' });
    }

    broadcast({ type: 'user', content: text }, channelId);

    try {
      const agent = await getAgentForChannel(channelId);
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

      fullResponse = await agent.promptStream(text, streamCallback);

      broadcast({ type: 'ai', content: fullResponse }, channelId);

      const existingSession = await loadSession(channelId);
      const session: Session = existingSession || { channelId, messages: [], lastUpdated: new Date().toISOString() };
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

  app.get('/channels', async (req, res) => {
    try {
      const channels = await loadChannels();
      res.json(channels);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/channels', async (req, res) => {
    try {
      const { name, agentId } = req.body;
      if (!name || !agentId) {
        return res.status(400).json({ error: 'name and agentId required' });
      }
      const channels = await loadChannels();
      const id = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      // 为每个频道生成独立的 DIAP 身份
      let channelDid = '';
      let channelPublicKey = '';
      try {
        const kp = KeyManager.generate();
        channelDid = kp.did || '';
        channelPublicKey = Buffer.from(kp.publicKey).toString('hex');
        console.log(`频道 ${name} 的 DID: ${channelDid}`);
      } catch (e) {
        console.log(`频道 ${name} 生成 DID 失败`);
      }

      const channel: Channel = {
        id,
        name,
        agentId,
        did: channelDid,
        publicKey: channelPublicKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      channels.push(channel);
      await saveChannels(channels);
      await saveSession({ channelId: id, messages: [], lastUpdated: new Date().toISOString() });
      res.json(channel);
    } catch (err: any) {
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
      channels.splice(index, 1);
      await saveChannels(channels);
      try {
        await fs.unlink(path.join(SESSION_CACHE_PATH, `${channelId}.json`));
      } catch {}
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/channels/:channelId', async (req, res) => {
    try {
      const { channelId } = req.params;
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Name required' });
      }
      const channels = await loadChannels();
      const channel = channels.find(c => c.id === channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      channel.name = name;
      channel.updatedAt = new Date().toISOString();
      await saveChannels(channels);
      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/sessions/:channelId', async (req, res) => {
    try {
      const session = await loadSession(req.params.channelId);
      res.json(session || { channelId: req.params.channelId, messages: [], lastUpdated: null });
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
        publicKey: conn.publicKey
      }));
      res.json(peers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 连接新节点
  app.post('/api/connect', async (req, res) => {
    try {
      const { did } = req.body;
      if (!did) {
        return res.status(400).json({ error: 'DID required' });
      }
      // TODO: 实现 DID 解析和连接逻辑
      res.json({ ok: true, did, message: '连接请求已发送' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 发送 P2P 消息
  app.post('/api/message-p2p', async (req, res) => {
    try {
      const { peerId, message } = req.body;
      if (!peerId || !message) {
        return res.status(400).json({ error: 'peerId and message required' });
      }
      // TODO: 调用 P2P 模块发送消息
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return new Promise<{ app: express.Express; server: typeof server }>((resolve) => {
    server.listen(port, () => {
      setInterval(() => {
        for (const client of sseClients) {
          client.res.write(': ping\n\n');
        }
      }, 30000);
      resolve({ app, server });
    });
  });
}

function broadcast(data: object, channelId?: string) {
  const envelope = { ...data, channelId };
  const message = `data: ${JSON.stringify(envelope)}\n\n`;
  for (const client of sseClients) {
    if (!channelId || client.channelId === channelId) {
      client.res.write(message);
    }
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
  const cmd = process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(cmd);
}