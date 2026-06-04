/**
 * Core E2E - 双进程对接测试 (Hyperswarm 直连, 不依赖 NAT 穿透)
 *
 * 用法:
 *   终端 1: npx tsx src/test/core-e2e.ts server
 *   终端 2: npx tsx src/test/core-e2e.ts client
 *
 * 验证:
 *   1) Hyperswarm 主题内自动发现 (server 写公钥 → client joinPeer)
 *   2) iroh secretKey 落 ~/.bolloon/iroh-secret-{role}.json (跨重启稳定)
 *   3) **manifest 协议** (建联一次, 拿到对方所有 agent 清单)
 *   4) **DOC 驱动交流** (doc_chunk)
 *   5) **异步 chat** (agent_chat)
 *   6) **agent_delegate** (按 capability 选对方 agent 委派)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import { KeyManager } from '@diap/sdk';
import { loadOrCreateIrohSecret } from '../agents/iroh-secret.js';
import {
  buildManifestRequest, buildManifestPayload, buildAgentDelegateRequest, buildAgentResponse,
  parseFrame, setLocalManifest, addLocalAgent, cacheRemoteManifest, pickAgent,
  type AgentManifest, type AgentManifestEntry,
} from '../agents/agent-manifest-protocol.js';

const ROLE = process.argv[2] || 'server';
const TOPIC_STR = 'bolloon-core-e2e-v1';
const INBOX_DIR = path.join(os.homedir(), '.bolloon', 'e2e-inbox');
fs.mkdirSync(INBOX_DIR, { recursive: true });

// ============== 1) iroh secretKey 落盘 ==============
const sec = loadOrCreateIrohSecret(ROLE);
console.log(`[iroh-secret] ${sec.reused ? '复用' : '新建'} iroh-secret-${ROLE}.json (createdAt=${sec.createdAt})`);

// ============== 2) 本节点智能体清单 ==============
const OWN_AGENTS: AgentManifestEntry[] = [
  { id: `${ROLE}-writer`, name: `${ROLE} 的写作 agent`, capabilities: ['writing', 'summarize'], status: 'active' },
  { id: `${ROLE}-coder`, name: `${ROLE} 的编程 agent`, capabilities: ['coding', 'review'], status: 'idle' },
  { id: `${ROLE}-planner`, name: `${ROLE} 的规划 agent`, capabilities: ['planning', 'writing'], status: 'active' },
];
setLocalManifest({ ownerName: ROLE, ownerPublicKey: '', agents: OWN_AGENTS });

// ============== 3) Hyperswarm ==============
async function sendJson(sock: any, frame: string) {
  sock.write(b4a.from(frame));
  const f = parseFrame(frame);
  if (f) console.log(`  [${ROLE}.send] -> ${f.type}: ${JSON.stringify(f.payload).substring(0, 80)}`);
}

async function handleIncoming(sock: any, text: string, swarm: Hyperswarm) {
  const f = parseFrame(text);
  if (!f) { console.log(`  [${ROLE}.recv] raw: ${text.substring(0, 80)}`); return; }
  console.log(`  [${ROLE}.recv] <- ${f.type}`);

  switch (f.type) {
    case 'manifest_request': {
      const local = {
        ownerName: ROLE,
        ownerPublicKey: swarm.keyPair?.publicKey?.toString('hex')?.substring(0, 16) || '',
        agents: OWN_AGENTS,
        publishedAt: Date.now(),
      };
      await sendJson(sock, buildManifestPayload(local));
      break;
    }
    case 'manifest_payload': {
      const m = f.payload as AgentManifest;
      console.log(`  [${ROLE}] ✅ 收到对方 manifest: owner=${m.ownerName}, agents=${m.agents.length} 个`);
      for (const a of m.agents) {
        console.log(`     - ${a.name} (${a.id}) capabilities=[${a.capabilities.join(',')}] status=${a.status}`);
      }
      cacheRemoteManifest(m);
      fs.writeFileSync(path.join(INBOX_DIR, `manifest-${m.ownerName}.json`), JSON.stringify(m, null, 2));
      break;
    }
    case 'agent_chat': {
      console.log(`  [${ROLE}.chat] 收到聊天: "${f.payload.text}"`);
      await sendJson(sock, JSON.stringify({ type: 'agent_chat_ack', payload: { text: `[${ROLE}] 已收到` }, ts: Date.now() }));
      break;
    }
    case 'doc_chunk': {
      console.log(`  [${ROLE}.doc] 收到文档片段 (${f.payload.content.length} 字节): "${f.payload.content.substring(0, 40)}..."`);
      await sendJson(sock, JSON.stringify({ type: 'doc_chunk_ack', payload: { fileName: f.payload.fileName, bytes: f.payload.content.length }, ts: Date.now() }));
      break;
    }
    case 'agent_delegate': {
      const req = f.payload as any;
      const target = OWN_AGENTS.find((a) => a.capabilities.includes(req.capability)) || OWN_AGENTS[0];
      console.log(`  [${ROLE}.delegate] 委派给 ${target.name}, 任务: ${req.instruction.substring(0, 40)}`);
      await sendJson(sock, buildAgentResponse({
        ok: true,
        delegatedTo: target.id,
        resultCid: `mock-result-${Date.now()}`,
        summary: `[${target.name}] 已基于文档 "${req.docPath || '(inline)'}" 完成: ${req.instruction.substring(0, 30)}`,
      }));
      break;
    }
    case 'agent_response': {
      const r = f.payload as any;
      console.log(`  [${ROLE}.response] ✅ 收到回包:`);
      console.log(`     ok=${r.ok} delegatedTo=${r.delegatedTo} resultCid=${r.resultCid}`);
      console.log(`     summary: ${r.summary}`);
      fs.writeFileSync(path.join(INBOX_DIR, `last-response.json`), JSON.stringify(r, null, 2));
      break;
    }
    case 'agent_chat_ack':
    case 'doc_chunk_ack':
      console.log(`  [${ROLE}.ack] ${f.type}: ${JSON.stringify(f.payload)}`);
      break;
    default:
      console.log(`  [${ROLE}.recv] 未知 type: ${f.type}`);
  }
}

async function main() {
  console.log(`\n=== Core E2E (Hyperswarm 直连) — 角色: ${ROLE} ===\n`);

  // DIAP 身份
  const kp = KeyManager.generate();
  console.log(`[1] DIAP 身份: DID=${kp.did}`);

  // Hyperswarm
  const swarm = new Hyperswarm();
  const topic = b4a.from(TOPIC_STR, 'utf-8').slice(0, 32);
  const discovery = swarm.join(topic, { server: true, client: true });
  await discovery.flushed();
  const pk = swarm.keyPair?.publicKey?.toString('hex') || '';
  console.log(`[2] 节点公钥: ${pk.substring(0, 20)}...`);

  fs.writeFileSync(path.join(INBOX_DIR, `${ROLE}-publickey.txt`), pk);

  if (ROLE === 'client') {
    const serverKeyPath = path.join(INBOX_DIR, 'server-publickey.txt');
    if (fs.existsSync(serverKeyPath)) {
      const serverKey = fs.readFileSync(serverKeyPath, 'utf-8').trim();
      console.log(`[3] 主动 joinPeer server: ${serverKey.substring(0, 20)}...`);
      swarm.joinPeer(b4a.from(serverKey, 'hex'));
    }
  } else {
    console.log(`[3] server 等待 client 拨入...`);
  }

  let peerSock: any = null;
  const ready = new Promise<void>((resolve) => {
    swarm.on('connection', (sock: any) => {
      if (peerSock) { sock.destroy(); return; }
      peerSock = sock;
      console.log(`\n  🔌 收到对端连接: ${sock.remotePublicKey?.toString('hex')?.substring(0, 16)}...`);
      sock.on('data', (data: Buffer) => {
        handleIncoming(sock, data.toString('utf-8'), swarm).catch((e) => console.error('handle err', e));
      });
      resolve();
    });
  });

  await Promise.race([ready, new Promise<void>((r) => setTimeout(() => r(), 60000))]);
  if (!peerSock) { console.log('❌ 超时未等到对端'); process.exit(1); }

  // 节点握手 → 拉 manifest
  await new Promise((r) => setTimeout(r, 500));
  console.log(`\n[4] 节点握手 → 拉对方 manifest`);
  await sendJson(peerSock, buildManifestRequest());

  // DOC 驱动
  await new Promise((r) => setTimeout(r, 500));
  console.log(`\n[5] DOC 驱动 (doc_chunk)`);
  await sendJson(peerSock, JSON.stringify({
    type: 'doc_chunk',
    payload: { fileName: '想法.md', content: '# 想法\n\n我想做一个跨用户多 agent 协作的工具' },
    ts: Date.now(),
  }));

  // 异步 chat
  await new Promise((r) => setTimeout(r, 500));
  console.log(`\n[6] 异步聊天 (agent_chat)`);
  await sendJson(peerSock, JSON.stringify({ type: 'agent_chat', payload: { text: '你好, 我是 ' + ROLE }, ts: Date.now() }));

  // agent_delegate
  await new Promise((r) => setTimeout(r, 500));
  console.log(`\n[7] 委派任务 (agent_delegate)`);
  await sendJson(peerSock, buildAgentDelegateRequest({
    capability: 'writing',
    docPath: '/local/想法.md',
    instruction: '请基于这份想法, 拟一份 100 字大纲',
    fromAgentId: `${ROLE}-main`,
  }));

  console.log(`\n[8] 等待响应...`);
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`\n[done] ${ROLE} 退出`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
