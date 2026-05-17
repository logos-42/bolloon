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
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { documentReader } from './documents/reader.js';
import { initMinimax } from './constraints/index.js';
import { createAgentSession } from './agents/pi-sdk.js';
import * as readline from 'readline';

// @ts-ignore - noble/ed25519 v3 requires sha512 to be set
(ed25519.hashes as any).sha512 = sha512;

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

function getUserName(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const match = home.match(/\/Users\/(\w+)/);
  if (match) return match[1];
  const user = process.env.USERNAME || process.env.USER || 'user';
  return user.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function bootstrapIdentity(): Promise<{ keypair: import('@diap/sdk').KeyPair; did: string; name: string }> {
  console.log('[1/4] 🔐 生成 DIAP 身份...');
  const kp = KeyManager.generate();
  const did = kp.did;
  const username = getUserName();
  const suffix = did.split(':').pop()?.substring(0, 4);
  const name = `blln-${username}-${suffix}`;
  console.log(`   DID  : ${did}`);
  console.log(`   name : ${name}`);
  return { keypair: kp, did, name };
}

function publishDID(name: string, kp: import('@diap/sdk').KeyPair): void {
  console.log('[2/4] 📝 发布 DID → IPFS CID (后台进行)...');
  let retries = 0;
  const maxRetries = 10;

  const attempt = async () => {
    try {
      const auth = await AgentAuthManager.newWithRemoteIpfs('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
      await auth.registerAgent({ name, services: [] }, kp, '');
      console.log('     ✅ DID/IPNS 发布成功 (后台)');
    } catch (e: any) {
      retries++;
      if (retries < maxRetries) {
        console.log(`     ⏳ IPNS发布失败(${retries}/${maxRetries}), 60秒后重试...`);
        setTimeout(attempt, 60000);
      } else {
        console.log('     ⚠️  IPNS发布重试结束，DID生成成功（本地模式）');
      }
    }
  };

  setTimeout(attempt, 100);
}

// ---------------------------------------------------------------------------
// P2P 节点初始化
// ---------------------------------------------------------------------------

async function bootstrapP2P(
  verifier: AgentVerificationManager,
): Promise<HyperswarmCommunicator> {
  console.log('[3/4] 🌐 启动 P2P harness...');
  const rawSeed = crypto.getRandomValues(new Uint8Array(32));
  const seed: any = rawSeed;
  const comm = createHyperswarmCommunicator({ server: true, client: true, autoConnect: true, maxConnections: 50, seed });

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
  let rl: readline.Interface | null = null;
  let isRunning = true;

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  async function prompt(q: string): Promise<string> { return new Promise(res => rl!.question(q, res)); }

  async function loop() {
    if (!isRunning || !rl) return;
    try {
      const raw = await prompt('\n> ');
      if (!raw || !isRunning) { loop(); return; }

      const input = raw.trim();
      if (input === '退出' || input === 'exit' || input === 'quit') {
        isRunning = false;
        rl.close();
        comm.stop();
        console.log('\n👋 再见！\n');
        return;
      }

      if (input.toLowerCase() === 'peers') {
        console.log(`\n已连接节点: ${comm.getConnections().length}`);
        for (const c of comm.getConnections()) {
          console.log(`  · ${c.publicKey.substring(0, 16)}...`);
        }
        loop();
        return;
      }

      if (!input) { loop(); return; }

      const a = await getAgent();
      const response = await a.prompt(input);
      console.log(`\n${response}\n`);
      loop();
    } catch (e: any) {
      if (!isRunning) return;
      if (e.message?.includes('ERR_USE_AFTER_CLOSE') || e.message?.includes('readline was closed')) {
        return;
      }
      console.error(`\n❌ ${e.message}\n`);
      loop();
    }
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
// Non-Interactive Mode (for AI consumption)
// ---------------------------------------------------------------------------

interface NonInteractiveResult {
  success: boolean;
  response?: string;
  error?: string;
  metadata?: {
    duration?: number;
    qualityScore?: number;
    peers?: number;
    file?: string;
  };
}

const AVAILABLE_TOOLS = [
  { name: 'read_document', description: '读取文档 (txt, md, pdf, docx)', example: '--read <file>' },
  { name: 'summarize_document', description: '总结文档内容', example: '--summarize <file>' },
  { name: 'improve_document', description: '改进文档内容', example: '--improve <file> <requirements>' },
  { name: 'list_peers', description: '列出已连接的对等节点', example: '--peers' },
  { name: 'send_message', description: '向对等节点发送消息', example: '--send <peerId> <message>' },
  { name: 'broadcast_message', description: '广播消息到所有节点', example: '--broadcast <message>' },
  { name: 'get_identity', description: '获取当前智能体身份', example: '--identity' },
  { name: 'get_operation_logs', description: '获取操作日志', example: '--logs' },
  { name: 'search_files', description: '搜索文件', example: '--search <keyword>' },
  { name: 'prompt', description: '通用 AI 对话', example: '--prompt <text>' },
];

async function runToolCommand(
  tool: string,
  args: string[],
  outputJson: boolean,
  comm: HyperswarmCommunicator
): Promise<void> {
  const a = await getAgent();
  const startTime = Date.now();
  let response: string;
  let error: string | undefined;
  let metadata: NonInteractiveResult['metadata'] = {
    peers: comm?.getConnections().length || 0
  };

  try {
    switch (tool) {
      case 'read': {
        const [filePath] = args;
        if (!filePath) {
          response = '错误: 缺少文件路径参数';
          error = response;
          break;
        }
        const content = await documentReader.read(filePath);
        response = `📄 ${content.metadata.filename}\n大小: ${content.metadata.size} 字节\n\n${content.text}`;
        break;
      }

      case 'summarize': {
        const [filePath, ...ctx] = args;
        if (!filePath) {
          response = '错误: 缺少文件路径参数';
          error = response;
          break;
        }
        const result = await a.summarizeDocument(filePath, ctx.join(' '));
        response = `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
        metadata.qualityScore = result.qualityScore;
        break;
      }

      case 'improve': {
        const [filePath, ...req] = args;
        if (!filePath || req.length === 0) {
          response = '错误: 缺少文件路径或需求参数';
          error = response;
          break;
        }
        const result = await a.improveDocument({
          originalPath: filePath,
          requirements: req.join(' ')
        });
        response = result.newContent || '';
        if (!result.improved) {
          response = '错误: 改进失败';
          error = response;
        }
        metadata.qualityScore = result.qualityScore;
        break;
      }

      case 'peers': {
        const peers = comm?.getConnections() || [];
        if (peers.length === 0) {
          response = '当前无连接的对等节点';
        } else {
          response = `已连接节点 (${peers.length}):\n${peers.map((c: P2PConnection) => `  · ${c.publicKey.substring(0, 16)}...`).join('\n')}`;
        }
        break;
      }

      case 'identity': {
        const identity = a.getIdentity();
        response = JSON.stringify(identity, null, 2);
        break;
      }

      case 'logs': {
        const logs = (a as any).getOperationLogs?.() || [];
        response = logs.length === 0
          ? '暂无操作日志'
          : logs.map((l: { timestamp: number; status: string; action: string }) => `[${new Date(l.timestamp).toISOString()}] ${l.status}: ${l.action}`).join('\n');
        break;
      }

      case 'search': {
        const [keyword] = args;
        if (!keyword) {
          response = '错误: 缺少搜索关键词';
          error = response;
          break;
        }
        response = `搜索功能开发中，关键字: ${keyword}`;
        break;
      }

      case 'broadcast': {
        const [message] = args;
        if (!message) {
          response = '错误: 缺少广播消息内容';
          error = response;
          break;
        }
        await a.broadcast(message);
        response = `广播已发送: ${message.substring(0, 50)}...`;
        break;
      }

      case 'send': {
        const [peerId, ...messageParts] = args;
        if (!peerId || messageParts.length === 0) {
          response = '错误: 缺少节点ID或消息内容';
          error = response;
          break;
        }
        await a.sendMessage(peerId, messageParts.join(' '));
        response = `消息已发送到 ${peerId.substring(0, 16)}...`;
        break;
      }

      case 'prompt': {
        const [text] = args;
        if (!text) {
          response = '错误: 缺少 prompt 文本';
          error = response;
          break;
        }
        response = await a.prompt(text);
        break;
      }

      case 'tools': {
        response = '🛠️ 可用工具:\n\n' + AVAILABLE_TOOLS.map(t =>
          `  ${t.name}\n    ${t.description}\n    示例: ${t.example}`
        ).join('\n\n');
        break;
      }

      default:
        response = `错误: 未知工具 "${tool}"`;
        error = response;
    }
  } catch (e: any) {
    response = `错误: ${e.message}`;
    error = response;
  }

  metadata.duration = Date.now() - startTime;

  if (outputJson) {
    const result: NonInteractiveResult = {
      success: !error,
      response,
      error,
      metadata
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(response);
  }
}

async function runNonInteractive(
  args: ParsedArgs,
  comm: HyperswarmCommunicator
): Promise<void> {
  const { prompt, json, output, tool, toolArgs } = args;

  if (output) {
    const originalLog = console.log;
    let outputBuffer = '';
    console.log = (...params: any[]) => {
      outputBuffer += params.join(' ') + '\n';
    };

    if (tool) {
      await runToolCommand(tool, toolArgs, false, comm);
    } else if (prompt) {
      const a = await getAgent();
      console.log(await a.prompt(prompt));
    }

    console.log = originalLog;
    await fs.writeFile(output, outputBuffer.trim(), 'utf-8');
    console.log(`✅ 结果已保存到: ${output}`);
    return;
  }

  if (tool) {
    await runToolCommand(tool, toolArgs, !!json, comm);
  } else if (prompt) {
    const startTime = Date.now();
    const a = await getAgent();
    let response: string;
    try {
      response = await a.prompt(prompt);
    } catch (e: any) {
      response = `错误: ${e.message}`;
    }

    const duration = Date.now() - startTime;
    const peers = comm?.getConnections().length || 0;

    if (json) {
      const result: NonInteractiveResult = {
        success: !response.startsWith('错误:'),
        response,
        error: response.startsWith('错误:') ? response : undefined,
        metadata: { duration, peers }
      };
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(response);
    }
  }
}

interface ParsedArgs {
  prompt?: string;
  json?: boolean;
  web?: boolean;
  help?: boolean;
  tools?: boolean;
  read?: boolean;
  summarize?: boolean;
  improve?: boolean;
  peers?: boolean;
  identity?: boolean;
  logs?: boolean;
  broadcast?: boolean;
  send?: boolean;
  search?: boolean;
  model?: string;
  output?: string;
  tool?: string;
  toolArgs: string[];
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = { toolArgs: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--prompt':
      case '-p':
        result.prompt = args[++i];
        result.tool = 'prompt';
        break;
      case '--json':
      case '-j':
        result.json = true;
        break;
      case '--web':
        result.web = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--tools':
        result.tools = true;
        result.tool = 'tools';
        break;
      case '--read':
        result.read = true;
        result.tool = 'read';
        result.toolArgs = [args[++i]].filter(Boolean);
        break;
      case '--summarize':
        result.summarize = true;
        result.tool = 'summarize';
        const summarizeArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          summarizeArgs.push(args[++i]);
        }
        result.toolArgs = summarizeArgs;
        break;
      case '--improve':
        result.improve = true;
        result.tool = 'improve';
        const improveArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          improveArgs.push(args[++i]);
        }
        result.toolArgs = improveArgs;
        break;
      case '--peers':
        result.peers = true;
        result.tool = 'peers';
        break;
      case '--identity':
        result.identity = true;
        result.tool = 'identity';
        break;
      case '--logs':
        result.logs = true;
        result.tool = 'logs';
        break;
      case '--broadcast':
        result.broadcast = true;
        result.tool = 'broadcast';
        result.toolArgs = [args[++i]].filter(Boolean);
        break;
      case '--send':
        result.send = true;
        result.tool = 'send';
        const sendArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          sendArgs.push(args[++i]);
        }
        result.toolArgs = sendArgs;
        break;
      case '--search':
        result.search = true;
        result.tool = 'search';
        result.toolArgs = [args[++i]].filter(Boolean);
        break;
      case '--model':
        result.model = args[++i];
        break;
      case '--output':
      case '-o':
        result.output = args[++i];
        break;
      case '--':
        result.toolArgs = args.slice(i + 1);
        i = args.length;
        break;
      default:
        if (!arg.startsWith('-') && !result.prompt && !result.tool) {
          result.prompt = arg;
          result.tool = 'prompt';
        }
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
🤖 Bolloon Agent - AI 可调用文档处理智能体

用法:
  npx tsx src/index.ts [选项] [参数]

选项:
  # 文档处理
  --read <file>              读取文档 (txt, md, pdf, docx)
  --summarize <file> [ctx]  总结文档，可选上下文
  --improve <file> <req>     改进文档，req 为改进要求

  # P2P 网络
  --peers                    列出已连接的对等节点
  --broadcast <msg>          广播消息到所有节点
  --send <peerId> <msg>      向指定节点发送消息

  # 智能体
  --identity                 显示当前智能体身份
  --logs                     显示操作日志
  --search <keyword>         搜索文件
  --tools                    显示所有可用工具

  # AI 对话
  --prompt, -p <text>        通用 AI 对话（默认）
  --model <name>             指定使用的模型

  # 输出控制
  --json, -j                 输出 JSON 格式
  --output, -o <file>        结果保存到文件
  --web                      启动 Web UI 模式
  --help, -h                 显示帮助信息

示例:
  # 文档处理
  npx tsx src/index.ts --read 想法.md
  npx tsx src/index.ts --summarize docs/想法.md
  npx tsx src/index.ts --improve docs/README.md "让内容更简洁"
  npx tsx src/index.ts --read 想法.md -o summary.txt

  # P2P 网络
  npx tsx src/index.ts --peers
  npx tsx src/index.ts --broadcast "Hello everyone"
  npx tsx src/index.ts --send QmABC... "私信内容"

  # AI 对话
  npx tsx src/index.ts --prompt "总结 README.md"
  npx tsx src/index.ts -p "分析这个项目" -j

  # 交互模式
  npx tsx src/index.ts

  # Web 模式
  npx tsx src/index.ts --web

环境变量:
  MINIMAX_API_KEY       MiniMax API 密钥
  OPENAI_API_KEY        OpenAI API 密钥（Pi SDK）
  ANTHROPIC_API_KEY     Anthropic API 密钥（Pi SDK）
  PORT                  Web 服务端口（默认 54188）
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const mode = args.web ? 'web' : 'cli';
  const isNonInteractive = !!(args.tool || args.prompt);

  if (isNonInteractive) {
    console.error = () => {}; // Suppress console.error in non-interactive mode
  }

  console.log('\n🤖 Bolloon Agent\n');

  // ① LLM - 支持多种 provider
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasMinimax = !!process.env.MINIMAX_API_KEY;
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasOllama = !!process.env.OLLAMA_BASE_URL;

  if (hasOpenAI || hasAnthropic || hasOpenRouter || hasGemini || hasOllama || hasMinimax) {
    const provider = hasOpenAI ? 'openai' : hasAnthropic ? 'anthropic' : hasOpenRouter ? 'openrouter' : hasGemini ? 'gemini' : hasOllama ? 'ollama' : 'minimax';
    initMinimax({ provider: provider as any });
  } else if (isNonInteractive) {
    console.log('⚠️  未设置任何 LLM API Key，功能受限（支持 OPENAI_API_KEY, ANTHROPIC_API_KEY, MINIMAX_API_KEY 等）');
  } else {
    console.log('⚠️  未设置任何 LLM API Key，功能受限（支持 OPENAI_API_KEY, ANTHROPIC_API_KEY, MINIMAX_API_KEY 等）\n');
  }

  // ② DIAP 身份
  const { keypair, name } = await bootstrapIdentity();

  // ③ 发布 DID → IPFS (后台)
  publishDID(name, keypair);

  // ④ P2P 节点
  const verifier = createVerificationManager();
  let comm: HyperswarmCommunicator | null = null;

  if (mode === 'web') {
    bootstrapP2P(verifier).then(c => { comm = c; }).catch(err => {
      console.log('⚠️  P2P 连接失败，Web 模式继续运行:', err.message);
    });
  } else {
    comm = await bootstrapP2P(verifier);
  }

  if (mode === 'web') {
    const port = parseInt(process.env.PORT || '54188');
    const { createWebServer, openBrowser } = await import('./web/server.js');

    console.log('\n🌐 启动Web服务...');
    await createWebServer(port);

    console.log(`\n✅ 浏览器已打开 → http://localhost:${port}\n`);
    openBrowser(`http://localhost:${port}`);
  } else if (isNonInteractive) {
    await runNonInteractive(args, comm!);
    comm?.stop();
    process.exit(0);
  } else {
    console.log('\n💬 对话模式已启动\n');
    console.log('━'.repeat(30));
    console.log('\n你可以这样说：');
    console.log('  "读取 想法.md"');
    console.log('  "总结 这段文字的内容"');
    console.log('  "改进 src/index.ts，让代码更清晰"');
    console.log('\n输入 "退出" 结束对话\n');

    startCLI(comm!);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
