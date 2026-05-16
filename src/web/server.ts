import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as readline from 'readline';
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
import { createAgentSession, type AgentSession } from '../agents/pi-sdk.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let agentSession: AgentSession | null = null;
let sseClients: Set<express.Response> = new Set();

async function getAgent(): Promise<AgentSession> {
  if (!agentSession) {
    agentSession = await createAgentSession({ cwd: process.cwd(), peerId: 'harness' });
  }
  return agentSession;
}

export async function createWebServer(port: number = 3000) {
  const app = express();
  const server = createServer(app);

  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  const staticPath = join(__dirname, '..', 'web');
  app.use(express.static(staticPath));

  app.get('/', (req, res) => {
    res.sendFile(join(staticPath, 'index.html'));
  });

  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.post('/message', async (req, res) => {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    broadcast({ type: 'user', content: text });

    try {
      const a = await getAgent();
      const response = await a.prompt(text);
      broadcast({ type: 'ai', content: response });
      broadcast({ type: 'done' });
      res.json({ ok: true });
    } catch (err: any) {
      broadcast({ type: 'error', content: err.message });
      broadcast({ type: 'done' });
      res.status(500).json({ error: err.message });
    }
  });

  return new Promise<{ app: express.Express; server: typeof server }>((resolve) => {
    server.listen(port, () => {
      setInterval(() => {
        for (const client of sseClients) {
          client.write(': ping\n\n');
        }
      }, 30000);
      resolve({ app, server });
    });
  });
}

function broadcast(data: object) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
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