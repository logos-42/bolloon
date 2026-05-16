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
  AgentVerificationManager,
  createVerificationManager,
  type P2PConnection,
} from '@diap/sdk';
import { documentReader } from '../documents/reader.js';
import { initMinimax, getMinimax } from '../runtime/context/sys-prompt.js';
import { createAgentSession, type AgentSession, type StreamCallback, type StreamEvent } from '../agents/pi-sdk.js';

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
      const channel: Channel = {
        id,
        name,
        agentId,
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

export async function bootstrapIdentity() {
  console.log('🔐 身份生成...');
  const kp = KeyManager.generate();
  const did = kp.did;
  const name = `blln-${did.split(':').pop()?.substring(0, 6)}`;
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