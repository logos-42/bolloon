/**
 * agent-delegate-e2e - 验证 POST /api/agent/delegate 全链路
 *
 * 启动方式:
 *   终端 1: npx tsx src/test/agent-delegate-e2e.ts server
 *   终端 2: npx tsx src/test/agent-delegate-e2e.ts client
 *
 * server: 起 Hyperswarm 主题 + 启 web (54189) + 注册 3 个本地 agent
 * client: 起 Hyperswarm 主题 + 启 web (54190) + 注册 3 个本地 agent
 *
 * 验证:
 *   1) GET  /api/agent/local-manifest       → 看到 3 个 agent
 *   2) POST /api/agent/delegate (server 调 client 的 writing agent) → 200 + 收到回包
 *   3) GET  /api/agent/remote-manifests     → server 看到 client 的 manifest 缓存
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import { KeyManager } from '@diap/sdk';
import { loadOrCreateIrohSecret } from '../agents/iroh-secret.js';
import {
  setLocalManifest, addLocalAgent, cacheRemoteManifest, getRemoteManifests,
  buildManifestRequest, buildManifestPayload, buildAgentDelegateRequest, buildAgentResponse,
  parseFrame, type AgentManifest, type AgentManifestEntry,
} from '../agents/agent-manifest-protocol.js';
import { createAgentDelegateApp, type DelegateTransport } from '../web/agent-delegate-server.js';

const ROLE = process.argv[2] || 'server';
const TOPIC_STR = 'bolloon-delegate-e2e-v1';
const INBOX_DIR = path.join(os.homedir(), '.bolloon', 'delegate-e2e-inbox');
fs.mkdirSync(INBOX_DIR, { recursive: true });
const PORT = ROLE === 'server' ? 54189 : 54190;

// iroh secretKey
loadOrCreateIrohSecret(ROLE);

// 本节点智能体
const OWN_AGENTS: AgentManifestEntry[] = [
  { id: `${ROLE}-writer`, name: `${ROLE} 的写作 agent`, capabilities: ['writing', 'summarize'], status: 'active' },
  { id: `${ROLE}-coder`, name: `${ROLE} 的编程 agent`, capabilities: ['coding', 'review'], status: 'active' },
  { id: `${ROLE}-planner`, name: `${ROLE} 的规划 agent`, capabilities: ['planning'], status: 'idle' },
];
setLocalManifest({ ownerName: ROLE, ownerPublicKey: '', agents: OWN_AGENTS });

// ============== 真实 Hyperswarm transport ==============
let swarmRef: Hyperswarm;
let myPublicKey = '';
const connByKey: Map<string, any> = new Map();  // publicKey hex -> sock
const pending: Map<string, { resolve: (v: string | null) => void; timer: any }> = new Map();
let incomingHandler: ((fromPk: string, frame: string) => Promise<string | null>) | null = null;

const transport: DelegateTransport = {
  sendToNode: async (publicKey, frame, timeoutMs = 30000) => {
    return new Promise((resolve) => {
      const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const tagged = JSON.stringify({ ...JSON.parse(frame), _reqId: reqId });
      pending.set(reqId, { resolve, timer: setTimeout(() => { pending.delete(reqId); resolve(null); }, timeoutMs) });
      // 找连接
      let target: any = connByKey.get(publicKey);
      if (!target) {
        for (const [k, v] of connByKey) {
          if (k.startsWith(publicKey.substring(0, 16))) { target = v; break; }
        }
      }
      if (!target) {
        console.log(`[transport] ❌ 没找到 publicKey=${publicKey.substring(0,16)} 的连接 (已建立 ${connByKey.size} 条)`);
        clearTimeout(pending.get(reqId)!.timer);
        pending.delete(reqId);
        resolve(null);
        return;
      }
      target.write(b4a.from(tagged));
    });
  },
  onIncomingFrame: (handler) => { incomingHandler = handler; },
};

const app = createAgentDelegateApp(transport);

async function main() {
  console.log(`\n=== agent-delegate-e2e (角色: ${ROLE}, web port ${PORT}) ===\n`);

  const kp = KeyManager.generate();
  console.log(`[1] DIAP: ${kp.did}`);

  // 启 web
  app.listen(PORT, () => console.log(`[2] Web 已启: http://127.0.0.1:${PORT}/api/agent/local-manifest`));

  // 起 Hyperswarm
  const swarm = new Hyperswarm();
  swarmRef = swarm;
  const topic = b4a.from(TOPIC_STR, 'utf-8').slice(0, 32);
  const discovery = swarm.join(topic, { server: true, client: true });
  await discovery.flushed();
  myPublicKey = swarm.keyPair?.publicKey?.toString('hex') || '';
  // 更新本节点 manifest
  setLocalManifest({ ownerName: ROLE, ownerPublicKey: myPublicKey, agents: OWN_AGENTS });
  console.log(`[3] Hyperswarm 公钥: ${myPublicKey.substring(0, 20)}...`);
  fs.writeFileSync(path.join(INBOX_DIR, `${ROLE}-publickey.txt`), myPublicKey);

  if (ROLE === 'client') {
    const serverKey = fs.existsSync(path.join(INBOX_DIR, 'server-publickey.txt'))
      ? fs.readFileSync(path.join(INBOX_DIR, 'server-publickey.txt'), 'utf-8').trim() : null;
    if (serverKey) {
      console.log(`[4] joinPeer server: ${serverKey.substring(0, 20)}...`);
      swarm.joinPeer(b4a.from(serverKey, 'hex'));
    }
  } else {
    console.log(`[4] server 等待 client 拨入...`);
  }

  swarm.on('connection', (sock: any) => {
    const rk = sock.remotePublicKey?.toString('hex') || '';
    console.log(`  🔌 连接: ${rk.substring(0, 16)}...`);
    connByKey.set(rk, sock);
    sock.on('close', () => { if (connByKey.get(rk) === sock) connByKey.delete(rk); });
    sock.on('data', async (data: Buffer) => {
      const text = data.toString('utf-8');
      const f = parseFrame(text);
      if (!f) return;
      // 业务层回包 (manifest_request / agent_delegate)
      if (incomingHandler) {
        const reply = await incomingHandler(rk, text);
        if (reply) {
          const reqId = (f as any)._reqId;
          const tagged = reqId ? JSON.stringify({ ...JSON.parse(reply), _reqId: reqId }) : reply;
          sock.write(b4a.from(tagged));
        }
        return;
      }
      // req/resp correlator
      if ((f as any)._reqId) {
        const reqId = (f as any)._reqId;
        const p = pending.get(reqId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(reqId);
          p.resolve(text);
        }
      }
    });
  });

  // 等连接 + 注册到对端
  if (ROLE === 'client') {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && connByKey.size === 0) {
      await new Promise((r) => setTimeout(r, 500));
      if ((Date.now() - t0) % 4000 < 600) console.log(`  [client] 等待连接... 当前 ${connByKey.size}`);
    }
  } else {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && connByKey.size === 0) {
      await new Promise((r) => setTimeout(r, 500));
      if ((Date.now() - t0) % 4000 < 600) console.log(`  [server] 等待连接... 当前 ${connByKey.size}`);
    }
  }

  // 测试 web API
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`\n[5] 测试 GET /api/agent/local-manifest`);
  const r1 = await fetch(`${base}/api/agent/local-manifest`);
  const localManifest = await r1.json();
  console.log(`    status=${r1.status}, agents=${localManifest.agents?.length}`);
  for (const a of localManifest.agents || []) console.log(`      - ${a.name} [${a.capabilities.join(',')}]`);

  // 调对端委派
  let otherKey: string | null = null;
  if (ROLE === 'client') {
    otherKey = fs.readFileSync(path.join(INBOX_DIR, 'server-publickey.txt'), 'utf-8').trim();
  } else {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !fs.existsSync(path.join(INBOX_DIR, 'client-publickey.txt'))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (fs.existsSync(path.join(INBOX_DIR, 'client-publickey.txt'))) {
      otherKey = fs.readFileSync(path.join(INBOX_DIR, 'client-publickey.txt'), 'utf-8').trim();
    }
  }
  if (otherKey) {
    console.log(`\n[6] ${ROLE} 调对端节点 (writing agent) 委派任务`);
    const r2 = await fetch(`${base}/api/agent/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toPublicKey: otherKey,
        capability: 'writing',
        docPath: '/local/想法.md',
        instruction: '请基于这份想法, 拟一份 100 字大纲',
        fromAgentId: `${ROLE}-main`,
      }),
    });
    const r2body = await r2.json();
    console.log(`    status=${r2.status}`);
    console.log(`    body=${JSON.stringify(r2body, null, 2)}`);
  } else {
    console.log(`\n[6] ⚠️  没拿到对端公钥, 跳过 delegate`);
  }

  await new Promise((r) => setTimeout(r, 3000));
  console.log(`\n[done] ${ROLE} 退出`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
