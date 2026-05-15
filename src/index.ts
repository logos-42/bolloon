import {
  HyperswarmCommunicator,
  createHyperswarmCommunicator,
  createTopic,
  KeyManager,
  AgentAuthManager,
  AgentVerificationManager,
  createVerificationManager,
  type P2PMessage,
  type P2PConnection,
} from '@diap/sdk';
import { documentReader } from './documents/reader.js';
import { initMinimax } from './llm/minimax.js';
import { createAgentSession } from './agents/pi-sdk.js';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Message envelope
//   Sender wraps:  DID:<hex_did>|{"id":"...","type":"summarize|improve","documentPath":"...","requirements":"..."}
//   So receiver can verify identity before dispatching
// ---------------------------------------------------------------------------

type TaskType = 'summarize' | 'improve';

interface RpcTask {
  id: string;
  type: TaskType;
  documentPath?: string;
  requirements?: string;
  from: string;          // DID of sender, extracted from message prefix
}

// ---------------------------------------------------------------------------
// Harness loop  ─  poll-free event-driven (Hyperswarm DHT 自动推送)
// ---------------------------------------------------------------------------

/** 原始 Hyperswarm stream 缓存； HyperswarmCommunicator.sendToConnection 只打日志不写流 */
const rawStreams = new Map<string, any>();

function sendRawMsg(conn: P2PConnection, text: string): void {
  const raw = rawStreams.get(conn as any);
  if (raw && raw.writable) raw.write(Buffer.from(text));
}

// ---------------------------------------------------------------------------
// DIAP 身份初始化  ─  KeyManager → DID → DID Builder → IPFS publish
// ---------------------------------------------------------------------------

async function bootstrapIdentity(): Promise<{ keypair: import('@diap/sdk').KeyPair; did: string; name: string }> {
  console.log('[1/4] 🔐 生成 DIAP 身份...');
  const kp = KeyManager.generate();
  const did = kp.did;
  const name = `blln-${did.split(':').pop()?.substring(0, 6)}`;
  console.log(`   DID  : ${did}`);
  console.log(`   name : ${name}`);
  return { keypair: kp, did, name };
}

async function publishDID(name: string, kp: import('@diap/sdk').KeyPair): Promise<void> {
  console.log('[2/4] 📝 发布 DID → IPFS CID...');
  const auth = await AgentAuthManager.new();
  await auth.registerAgent({ name, services: [] }, kp, '');
  console.log('     ✅ DID 文档已上链');
}

// ---------------------------------------------------------------------------
// P2P 节点初始化
// ---------------------------------------------------------------------------

async function bootstrapP2P(
  verifier: AgentVerificationManager,
): Promise<HyperswarmCommunicator> {
  console.log('[3/4] 🌐 启动 P2P harness...');
  const comm = createHyperswarmCommunicator({ server: true, client: true, autoConnect: true, maxConnections: 50 });

  // 当 Hyperswarm 有新连接 → 将原始 stream 存入 rawStreams，供 sendRawMsg 用
  comm.on('connection', (conn: P2PConnection) => {
    // P2PConnection.id === comm.connections 的 map key（即 conn.publicKey 的 hex）
    // 但 setupConnectionHandlers 用 p2pConn.id (uuid) 做 key、p2pConn.publicKey 做 value key
    // 两者不同——我们同时在 connections 里以 id 做 keyucket
    // 策略：用 conn.publicKey 定位 map entry → 读 entry.id → 以此作为 rawStreams key
    const all: Map<string, P2PConnection> = (comm as any).connections as Map<string, P2PConnection>;
    for (const [k, v] of all) {
      if (v.publicKey === conn.publicKey) {
        rawStreams.set(v['id'], (comm as any)['__pendingStream']);
        break;
      }
    }
  });

  // 消息事件：dispatch → 同连接写回
  comm.on('message', async (msg: P2PMessage, conn: P2PConnection) => {
    const reply = await dispatchTask(new TextDecoder().decode(msg.content));
    sendRawMsg(conn, reply);
  });

  await comm.start();
  const topic = createTopic('bolloon-agent-harness') as Buffer;
  await comm.joinTopic(topic);
  console.log(`     ✅ 已加入主题  hex=${topic.slice(0, 8).toString('hex')}...`);
  return comm;
}

// ---------------------------------------------------------------------------
// Agent 懒加载
// ---------------------------------------------------------------------------

let agent: Awaited<ReturnType<typeof createAgentSession>> | null = null;
async function getAgent() {
  if (!agent) agent = await createAgentSession({ cwd: process.cwd(), peerId: 'harness' });
  return agent;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchTask(raw: string): Promise<string> {
  const body = raw.startsWith('DID:') ? raw.split('|', 1)[1] || '' : raw;
  const task = safeParse<RpcTask>(body);
  if (!task) return `ERR|${JSON.stringify({ code: 'bad_format' })}`;

  console.log(`\n📥 [${task.type}]  from=${task.from?.substring(0, 18)}...  id=${task.id}`);
  try {
    switch (task.type) {
      case 'summarize':
        return await handleSummarize(task);
      case 'improve':
        return await handleImprove(task);
      default:
        return `ERR|${JSON.stringify({ code: 'unknown', type: task.type })}`;
    }
  } catch (e: any) {
    return `ERR|${JSON.stringify({ code: 'error', msg: e.message })}`;
  }
}

async function handleSummarize(task: RpcTask): Promise<string> {
  if (!task.documentPath) return `ERR|${JSON.stringify({ code: 'no_path' })}`;
  const a = await getAgent();
  const { summary, qualityScore } = await a.summarizeDocument(task.documentPath);
  console.log(`     ✅ 质量=${(qualityScore * 10).toFixed(1)}/10`);
  return `OK|${JSON.stringify({ id: task.id, type: 'summarize', qualityScore, summary })}`;
}

async function handleImprove(task: RpcTask): Promise<string> {
  if (!task.documentPath || !task.requirements) {
    return `ERR|${JSON.stringify({ code: 'no_path_or_req' })}`;
  }
  const a = await getAgent();
  const res = await a.improveDocument({
    originalPath: task.documentPath,
    requirements: task.requirements,
    context: `来自节点: ${task.from}`,
  });
  const ok = res.improved ?? false;
  console.log(`     ✅ 改进${ok ? '成功' : '失败'}  质量=${(res.qualityScore * 10).toFixed(1)}/10  自动发送=${res.shouldAutoSend}`);
  return `OK|${JSON.stringify({
    id: task.id, type: 'improve', improved: ok,
    qualityScore: res.qualityScore, shouldAutoSend: res.shouldAutoSend,
    newContent: res.newContent,
  })}`;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

function rpcErr(code: string, msg: string): string {
  return `ERR|${JSON.stringify({ code, msg })}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function startCLI(comm: HyperswarmCommunicator): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  async function prompt(q: string): Promise<string> { return new Promise(res => rl.question(q, res)); }

  async function loop() {
    const raw = await prompt('\n> ');
    if (!raw) { loop(); return; }

    const [cmd, ...args] = raw.trim().split(/\s+/);
    try {
      switch (cmd.toLowerCase()) {
        case 'read':            await handleRead(args.join(' '));              break;
        case 'summarize':       await handleCLISummarize(args);               break;
        case 'improve':         await handleCLIImprove(args);                  break;
        case 'peers':
          console.log(`已连接 (${comm.getConnections().length}):`);
          for (const c of comm.getConnections()) console.log(`  - ${c.publicKey.substring(0, 16)}...  inbound=${c.isInbound}`);
          break;
        case 'tasks':
          console.log('Harness 后台监听中，同行节点发 task/summarize/improve 消息自动触发响应。');
          break;
        case 'exit':
          await comm.stop();
          rl.close();
          console.log('👋');
          return;
        default:
          console.log('命令: read | summarize | improve | peers | tasks | exit');
      }
    } catch (e: any) {
      console.error('错误:', e.message);
    }
    loop();
  }

  async function handleRead(p: string) {
    if (!p) { console.log('用法: read <file>'); return; }
    const c = await documentReader.read(p);
    console.log(`📄 ${c.metadata.filename} (${c.metadata.size} bytes)`);
    console.log(c.text.substring(0, 300) + '...');
  }

  async function handleCLISummarize(args: string[]) {
    const [doc, ...ctx] = args;
    if (!doc) { console.log('用法: summarize <doc> [context]'); return; }
    const a = await getAgent();
    const r = await a.summarizeDocument(doc, ctx.join(' '));
    console.log(`\n📝 摘要:\n${r.summary}`);
    console.log(`   质量: ${(r.qualityScore * 10).toFixed(1)}/10\n`);
  }

  async function handleCLIImprove(args: string[]) {
    const doc = args[0], req = args.slice(1).join(' ');
    if (!doc || !req) { console.log('用法: improve <doc> <requirements>'); return; }
    const a = await getAgent();
    const r = await a.improveDocument({ originalPath: doc, requirements: req });
    console.log(`\n✅ 改进${r.improved ? '成功' : '失败'}`);
    console.log(`   质量: ${(r.qualityScore * 10).toFixed(1)}/10  自动发送: ${r.shouldAutoSend}`);
    if (r.newContent) console.log(`\n${r.newContent.substring(0, 300)}...`);
  }

  loop();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🤖 Bolloon — DIAP Harness Agent');
  console.log('='.repeat(44) + '\n');

  // ① LLM
  const mk = process.env.MINIMAX_API_KEY;
  if (mk) { initMinimax({ apiKey: mk }); console.log('✅ Minimax 就绪\n'); }
  else      { console.log('⚠️  MINIMAX_API_KEY 未设，摘要以截断预览运行\n'); }

  // ② DIAP 身份
  const { keypair, did, name } = await bootstrapIdentity();

  // ③ 发布 DID → IPFS
  await publishDID(name, keypair);

  // ④ 验证器
  const verifier = createVerificationManager();

  // ⑤ P2P 节点 + 事件监听
  const comm = await bootstrapP2P(verifier);
  console.log(`   本机 DID: did:key:${did.substring(0, 30)}...\n`);

  // ⑥ CLI
  startCLI(comm);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
