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
import { irohTransport } from './network/iroh-transport.js';
import { HybridMessenger } from './network/hybrid-messenger.js';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import { documentReader } from './documents/reader.js';
import { initMinimax } from './constraints/index.js';
import { createAgentSession } from './agents/pi-sdk.js';
import { createSubAgentManager } from './agents/subagent-manager.js';
import { getGlobalSharedContext } from './social/global-shared-context.js';
import { BollharnessIntegration, createBollharnessIntegration } from './bollharness-integration/index.js';
import * as readline from 'readline';
import { printBanner, renderDashboard, renderDialog, renderUserMessage, renderAgentMessage, renderToolCall, flowConnector, termWidth } from './cli/loading-tui.js';

// 启动自动检查更新：后台、节流、检测到新版本自动安装（可被 --no-update / BOLLOON_SKIP_UPDATE 关闭）

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _BOLLOON_VERSION = ((): string => {
  try { return _require('../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';
const BG_WHITE = '\x1b[47m';
const BG_BLUE = '\x1b[44m';
const BLACK = '\x1b[30m';
const MOVE_UP = '\x1b[A';
const CLEAR_LINE = '\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const s = {
  banner: () => {
    printBanner(_BOLLOON_VERSION);
  },

  step: (num: number, total: number, text: string, status?: 'ok' | 'loading' | 'warn' | 'error') => {
    const check = status === 'ok' ? `${GREEN}✓` :
                  status === 'loading' ? `${YELLOW}⟳` :
                  status === 'warn' ? `${YELLOW}⚠` :
                  status === 'error' ? `${MAGENTA}✗` :
                  `${CYAN}●`;
    console.log(`  ${check} ${WHITE}[${num}/${total}]${GRAY} ${text}${RESET}`);
  },

  success: (text: string) => console.log(`  ${GREEN}✓${RESET} ${text}`),
  warn: (text: string) => console.log(`  ${YELLOW}⚠${RESET} ${text}`),
  error: (text: string) => console.log(`  ${MAGENTA}✗${RESET} ${text}`),
  info: (text: string) => console.log(`  ${CYAN}●${RESET} ${text}`),

  section: (title: string) => {
    console.log(`\n${BLUE}━━━ ${WHITE}${BOLD}${title}${RESET} ${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  },

  divider: () => console.log(`\n${GRAY}${'─'.repeat(50)}${RESET}\n`),

  prompt: (text: string) => console.log(`\n${CYAN}❯ ${WHITE}${text}${RESET}`),

  response: (label: string, content: string) => {
    console.log(`\n${GREEN}${label}${RESET}\n${content}\n`);
  },

  agentCard: (agent: { name: string; id: string; status: string; capabilities: string[]; did?: string }) => {
    const statusColor = agent.status === 'active' ? GREEN :
                        agent.status === 'idle' ? YELLOW :
                        agent.status === 'busy' ? MAGENTA : GRAY;
    console.log(`  ${WHITE}${BOLD}${agent.name}${RESET}`);
    console.log(`    ${GRAY}ID:${RESET} ${agent.id}`);
    console.log(`    ${GRAY}状态:${RESET} ${statusColor}${agent.status}${RESET}`);
    console.log(`    ${GRAY}能力:${RESET} ${agent.capabilities.join(', ')}`);
    if (agent.did) console.log(`    ${GRAY}DID:${RESET} ${agent.did}`);
    console.log();
  },

  Thinking: () => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    return setInterval(() => {
      process.stdout.write(`\r  ${YELLOW}${frames[i++ % frames.length]} 思考中...${RESET}    `);
    }, 80);
  },

  clearThinking: (interval: ReturnType<typeof setInterval>) => {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
  },

  dialog: async (title: string, promptText: string): Promise<string> => {
    return new Promise((resolve) => {
      console.log(renderDialog({ title, prompt: promptText }));
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(`${CYAN}❯ ${RESET}`, (input) => {
        rl.close();
        resolve(input.trim());
      });
    });
  }
};

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
  s.step(1, 5, '生成 DIAP 身份', 'loading');
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir?.() || '.';
  const identityPath = path.join(homeDir, '.bolloon', 'identity.json');
  let kp: import('@diap/sdk').KeyPair;
  let reused = false;
  try {
    if (existsSync(identityPath)) {
      kp = await KeyManager.fromFile(identityPath);
      reused = true;
    } else throw 0;
  } catch {
    kp = KeyManager.generate();
    mkdirSync(path.dirname(identityPath), { recursive: true });
    await KeyManager.saveToFile(kp, identityPath);
  }
  const did = kp.did;
  const username = getUserName();
  const suffix = did.split(':').pop()?.substring(0, 4);
  const name = `blln-${username}-${suffix}`;
  console.log(`     ${reused ? GRAY+'复用 ' : ''}${GRAY}DID:${RESET} ${did}`);
  console.log(`     ${GRAY}名称:${RESET} ${name}`);
  s.step(1, 5, reused ? '复用 DIAP 身份' : '生成 DIAP 身份', 'ok');
  return { keypair: kp, did, name };
}

function publishDID(name: string, kp: import('@diap/sdk').KeyPair): Promise<{ cid?: string; ipnsName?: string }> {
  // 2026-06-17: 去掉 IPNS 重试机制 — 老逻辑 60s × 10 次 = 10 分钟阻塞,
  //   严重拖慢 agent 启动. 失败就立刻 fallback, 不阻塞主流程.
  s.step(2, 5, '发布 DID → IPFS (后台)', 'loading');

  return new Promise((resolve) => {
    const attempt = async () => {
      try {
        const auth = await AgentAuthManager.newWithRemoteIpfs('http://127.0.0.1:5001', 'http://127.0.0.1:8080');
        const result = await auth.registerAgent({ name, services: [] }, kp, '');
        s.step(2, 5, '发布 DID → IPFS', 'ok');
        resolve({ cid: result.cid });
      } catch (e: any) {
        // 一次失败直接放弃 — 本地模式运行就够了, 不重试
        process.stdout.write(`     ${YELLOW}⚠ IPFS 发布失败 (${e?.message?.slice(0, 80) || 'unknown'}), 本地模式运行${RESET}\n`);
        s.step(2, 5, '发布 DID → IPFS', 'warn');
        resolve({});
      }
    };

    attempt();
  });
}

// ---------------------------------------------------------------------------
// P2P 节点初始化
// ---------------------------------------------------------------------------

async function bootstrapP2P(
  verifier: AgentVerificationManager,
): Promise<HyperswarmCommunicator> {
  s.step(3, 5, '启动 P2P 网络', 'loading');
  const rawSeed = crypto.getRandomValues(new Uint8Array(32));
  const seed: any = rawSeed;
  const comm = createHyperswarmCommunicator({ server: true, client: true, autoConnect: true, maxConnections: 50, seed });

  comm.on('connection', (conn: P2PConnection) => {
    const shortId = conn.publicKey.substring(0, 8);
    s.info(`🔌 连接: ${shortId}...`);
    const all: Map<string, P2PConnection> = (comm as any).connections as Map<string, P2PConnection>;
    for (const [k, v] of all) {
      if (v.publicKey === conn.publicKey) {
        rawStreams.set(v['id'], (comm as any)['__pendingStream']);
        break;
      }
    }
  });

  comm.on('message', async (msg: P2PMessage, conn: P2PConnection) => {
    const content = new TextDecoder().decode(msg.content);
    const shortId = conn.publicKey.substring(0, 8);
    s.prompt(`📩 收到 ${shortId}: ${content.substring(0, 50)}...`);
    const reply = await dispatchTask(content);
    sendRawMsg(conn, reply);
  });

  await comm.start();
  const topic = createTopic('bolloon-agent-harness') as Buffer;
  await comm.joinTopic(topic);
  console.log(`     ${GRAY}主题:${RESET} ${topic.slice(0, 8).toString('hex')}...`);
  s.step(3, 5, '启动 P2P 网络', 'ok');
  return comm;
}

// ---------------------------------------------------------------------------
// iroh/Hybrid P2P 初始化
// ---------------------------------------------------------------------------

async function bootstrapIroh(keypair: any, name: string): Promise<void> {
  s.step(4, 5, '启动 iroh P2P', 'loading');

  try {
    const node = await irohTransport.start();
    console.log(`     ${GRAY}iroh:${RESET} ${node.nodeId.substring(0, 16)}...`);

    hybridMessenger = new HybridMessenger({
      preferIrohForLarge: true,
      largeThresholdBytes: 64 * 1024,
      enableRelay: true,
    });

    hybridMessenger.onMessage('task', async (msg) => {
      console.log(`[iroh] Task from ${msg.from.substring(0, 12)}...: ${new TextDecoder().decode(msg.payload).substring(0, 50)}...`);
    });

    hybridMessenger.onMessage('blob', async (msg) => {
      console.log(`[iroh] Blob from ${msg.from.substring(0, 12)}...: ${msg.payload.length} bytes`);
    });

    hybridMessenger.onMessage('response', async (msg) => {
      console.log(`[iroh] Response from ${msg.from.substring(0, 12)}...`);
    });

    if (agentIdentity) {
      agentIdentity.irohNodeId = node.nodeId;
    }

    s.step(4, 5, '启动 iroh P2P', 'ok');
  } catch (e: any) {
    s.step(4, 5, '启动 iroh P2P', 'warn');
    console.log(`     ${YELLOW}iroh 启动失败: ${e.message}${RESET}`);
    console.log(`     ${GRAY}继续使用 Hyperswarm P2P${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// Agent 懒加载
// ---------------------------------------------------------------------------

let agent: Awaited<ReturnType<typeof createAgentSession>> | null = null;
let harness: BollharnessIntegration | null = null;
let hybridMessenger: HybridMessenger | null = null;
let agentIdentity: {
  did: string;
  name: string;
  publicKey: string;
  peerId?: string;
  p2pChannel?: string;
  cid?: string;
  ipnsName?: string;
  irohNodeId?: string;
} | null = null;

async function getAgent() {
  if (!agent) {
    const identityDoc = agentIdentity ? {
      did: agentIdentity.did,
      name: agentIdentity.name,
      publicKey: agentIdentity.publicKey,
      createdAt: Date.now(),
      peerId: agentIdentity.peerId,
      p2pChannel: agentIdentity.p2pChannel,
      cid: agentIdentity.cid,
      ipnsName: agentIdentity.ipnsName
    } : undefined;
    agent = await createAgentSession({
      cwd: process.cwd(),
      peerId: 'harness',
      identityDoc
    });
  }
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
// CLI with persistent bottom prompt
// ---------------------------------------------------------------------------

const SAVE_CURSOR = '\x1b[s';
const RESTORE_CURSOR = '\x1b[u';
const MOVE_TO_BOTTOM = '\x1b[999A';
const HIDE_CURSOR_SEQ = '\x1b[?25l';
const SHOW_CURSOR_SEQ = '\x1b[?25h';
const MOVE_UP_1 = '\x1b[1A';

let isRunning = false;
let currentInput = '';
let promptVisible = false;

function getTermHeight(): number {
  return process.stdout.rows || 24;
}

function moveCursorToBottom(): void {
  const height = getTermHeight();
  process.stdout.write(`\x1b[${height};1H`);
}

function showBottomPrompt(): void {
  if (!isRunning) return;
  promptVisible = true;
  process.stdout.write(SAVE_CURSOR);
  moveCursorToBottom();
  process.stdout.write(`${CYAN}❯ ${RESET}${currentInput}${HIDE_CURSOR_SEQ}`);
  process.stdout.write(RESTORE_CURSOR);
}

function clearPromptLine(): void {
  if (!promptVisible) return;
  process.stdout.write(SAVE_CURSOR);
  moveCursorToBottom();
  process.stdout.write(CLEAR_LINE);
  process.stdout.write(RESTORE_CURSOR);
  promptVisible = false;
}

function startCLI(comm: HyperswarmCommunicator): void {
  isRunning = true;
  currentInput = '';
  promptVisible = false;

  try {
    (process.stdin as any).setRawMode(true);
  } catch {
  }
  readline.emitKeypressEvents(process.stdin);

  process.stdout.write(CLEAR_LINE);

  // ── Bolloon Agent 仪表盘 (ASCII 艺术字 + 品牌图标) ──
  printBanner(_BOLLOON_VERSION);
  let peerCount = 0;
  try { peerCount = comm.getConnections().length; } catch { /* */ }
  const llmName = process.env.MINIMAX_API_KEY ? 'MiniMax'
    : process.env.OPENAI_API_KEY ? 'OpenAI'
    : process.env.ANTHROPIC_API_KEY ? 'Anthropic'
    : process.env.DEEPSEEK_API_KEY ? 'DeepSeek'
    : '未配置';
  process.stdout.write(renderDashboard({
    title: '系统状态',
    rows: [
      { label: 'LLM Provider', status: llmName === '未配置' ? 'warn' : 'ok', detail: llmName },
      { label: 'P2P 节点', status: peerCount > 0 ? 'ok' : 'warn', detail: `${peerCount} 个` },
      { label: '输入方式', status: 'info', detail: '底部对话框' },
    ],
  }) + '\n');
  process.stdout.write(renderDialog({
    title: 'Bolloon Agent',
    prompt: '输入消息开始对话 · 输入 help 查看命令',
  }) + '\n');

  showBottomPrompt();

  const promptTimer = setInterval(() => {
    if (isRunning && promptVisible) {
      showBottomPrompt();
    }
  }, 500);

  const handleInput = (chunk: Buffer, key: { name: string; ctrl: boolean }) => {
    if (!isRunning) return;

    if (key.ctrl && key.name === 'c') {
      clearPromptLine();
      process.stdout.write(`\n${CYAN}👋 再见！${RESET}\n`);
      try { (process.stdin as any).setRawMode(false); } catch {}
      clearInterval(promptTimer);
      process.exit(0);
      return;
    }

    if (key.name === 'return') {
      const trimmed = currentInput.trim();
      currentInput = '';
      clearPromptLine();

      if (trimmed) {
        process.stdout.write('\n');
        processInput(trimmed, comm).then(() => {
          if (isRunning) showBottomPrompt();
        });
      } else {
        showBottomPrompt();
      }
      return;
    }

    if (key.name === 'backspace') {
      if (currentInput.length > 0) {
        currentInput = currentInput.slice(0, -1);
        showBottomPrompt();
      }
      return;
    }

    if (key.name === 'escape' || (key.ctrl && key.name === 'u')) {
      currentInput = '';
      showBottomPrompt();
      return;
    }

    if (key.name === 'tab') {
      return;
    }

    if (key.name && key.name.length === 1) {
      currentInput += chunk.toString();
      showBottomPrompt();
    }
  };

  process.stdin.on('data', handleInput);

  process.on('exit', () => {
    isRunning = false;
    process.stdout.write(SHOW_CURSOR_SEQ);
  });
}

async function processInput(input: string, comm: HyperswarmCommunicator): Promise<void> {
  const trimmed = input.trim();

  if (trimmed === '退出' || trimmed === 'exit' || trimmed === 'quit') {
    clearPromptLine();
    process.stdout.write(`${CYAN}👋 再见！${RESET}\n`);
    isRunning = false;
    process.stdin.destroy();
    comm.stop();
    return;
  }

  if (trimmed.toLowerCase() === 'peers') {
    const peers = comm.getConnections();
    process.stdout.write(`${GRAY}已连接节点: ${peers.length}${RESET}\n`);
    for (const c of peers) {
      process.stdout.write(`  ${GRAY}·${RESET} ${c.publicKey.substring(0, 16)}...\n`);
    }
    return;
  }

  if (trimmed.toLowerCase() === 'iroh') {
    const nodeId = irohTransport.getNodeId();
    const running = irohTransport.isRunning();
    const peers = irohTransport.getPeers();
    process.stdout.write(`${GRAY}iroh 状态:${RESET}\n`);
    process.stdout.write(`  ${GRAY}运行中:${RESET} ${running ? '是' : '否'}\n`);
    process.stdout.write(`  ${GRAY}Node ID:${RESET} ${nodeId ? nodeId.substring(0, 24) + '...' : 'N/A'}\n`);
    process.stdout.write(`  ${GRAY}已知节点:${RESET} ${peers.length}\n`);
    if (hybridMessenger) {
      process.stdout.write(`  ${GRAY}HybridMessenger:${RESET} 就绪\n`);
    }
    return;
  }

  if (trimmed.toLowerCase().startsWith('add_friend ') || trimmed.toLowerCase() === 'add_friend') {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2 || (parts.length === 2 && parts[1].length !== 64)) {
      process.stdout.write(`${GRAY}用法: add_friend <64字符hex publicKey> [备注名]\n${RESET}`);
      process.stdout.write(`${GRAY}示例: add_friend a1b2c3d4e5f6... 同事-张磊\n${RESET}`);
      return;
    }
    const pk = parts[1];
    const name = parts.slice(2).join(' ') || '';
    process.stdout.write(`${GRAY}正在发送好友申请给 ${pk.substring(0, 16)}...${RESET}\n`);
    try {
      const port = process.env.PORT || '54188';
      const res = await fetch(`http://127.0.0.1:${port}/api/friend-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPublicKey: pk, name: name || undefined })
      });
      const data = await res.json();
      if (!res.ok) {
        const reason = data.code === 'NO_CONN' ? '对方未在线, 已本地记住, 等对方上线后自动重连' : (data.error || '请求失败');
        process.stdout.write(`${MAGENTA}✗ 添加好友失败: ${reason}${RESET}\n`);
        if (data.persistedAs) process.stdout.write(`${GRAY}本地已保存为: ${data.persistedAs}${RESET}\n`);
      } else {
        process.stdout.write(`${GREEN}✓ 好友申请已发送给 ${data.persistedAs || name || pk.substring(0, 12)}...${RESET}\n`);
      }
    } catch (err: any) {
      process.stdout.write(`${MAGENTA}✗ 添加好友失败: ${err.message || String(err)}${RESET}\n`);
    }
    return;
  }

  try {
    // 已发送消息框
    process.stdout.write(renderUserMessage(trimmed) + '\n');
    const a = await getAgent();
    const boxW = Math.min(termWidth() - 2, 76);
    const pending: { tool: string; args: any; t0: number }[] = [];
    let firstEvent = true;
    const clearThinking = () => {
      if (firstEvent) {
        process.stdout.write('\r' + ' '.repeat(30) + '\r');
        firstEvent = false;
      }
    };
    const onStream = (e: any) => {
      if (e.type === 'step_start') {
        pending.push({ tool: e.tool, args: e.args, t0: Date.now() });
      } else if (e.type === 'step_done' || e.type === 'step_error') {
        const p = pending.shift();
        clearThinking();
        // 连接线只在第 2 个及之后的工具框前出现
        if (!firstEvent) process.stdout.write(flowConnector(boxW) + '\n');
        process.stdout.write(
          renderToolCall({
            tool: e.tool ?? p?.tool ?? '?',
            args: p?.args,
            status: e.type === 'step_done' ? 'ok' : 'error',
            output: e.output,
            error: e.error,
            durationMs: p ? Date.now() - p.t0 : undefined,
            width: boxW,
          }) + '\n',
        );
      }
    };
    const response = await a.prompt(trimmed, { onStream });
    clearThinking();
    // 智能体回复框 (圆角)
    process.stdout.write(renderAgentMessage(response) + '\n');
  } catch (e: any) {
    if (!e.message?.includes('ERR_USE_AFTER_CLOSE') && !e.message?.includes('write after end')) {
      process.stdout.write(`${MAGENTA}❌ ${e.message}${RESET}\n`);
    }
  }
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
  { name: 'list_agents', description: '列出所有 SubAgent', example: '--agents' },
  { name: 'register_agent', description: '注册新 SubAgent', example: '--register-agent <name> [capabilities...]' },
  { name: 'delegate_task', description: '委派任务给最佳 Agent', example: '--delegate <task> [capabilities...]' },
  { name: 'global_context', description: '显示全局共享上下文', example: '--context' },
  { name: 'global_agents', description: '显示全局 Agent 注册表', example: '--global-agents' },
  { name: 'add_action', description: '添加用户行动到共享上下文', example: '--add-action <content> [importance]' },
  { name: 'harness_init', description: '初始化 Bollharness 治理框架', example: '--harness-init' },
  { name: 'harness_gate', description: '显示当前 Gate 状态', example: '--harness-gate' },
  { name: 'harness_transition', description: '执行 Gate 转移', example: '--harness-transition [PASS|BLOCK]' },
  { name: 'harness_skill', description: '执行 Harness Skill', example: '--harness-skill <name> [action]' },
  { name: 'harness_classify', description: '分类变更类型', example: '--harness-classify <description>' },
  { name: 'harness_context', description: '获取文件上下文', example: '--harness-context <file>' },
  { name: 'harness_check', description: '执行 Guard 检查', example: '--harness-check <file>' },
  { name: 'update_check', description: '检查 npm 包更新', example: '--update-check' },
  { name: 'update_now', description: '立即更新到最新版本', example: '--update-now [package]' },
];

async function runToolCommand(
  tool: string,
  args: string[],
  outputJson: boolean,
  comm: HyperswarmCommunicator,
  model?: string,
  prompt?: string
): Promise<void> {
  const a = await getAgent();
  const startTime = Date.now();
  let response: string;
  let error: string | undefined;
  let metadata: NonInteractiveResult['metadata'] = {
    peers: comm?.getConnections().length || 0
  };

  const toolLabels: Record<string, string> = {
    'read': '读取文档',
    'summarize': '总结文档',
    'improve': '改进文档',
    'prompt': 'AI 对话',
    'agents': '列出 Agent',
    'register-agent': '注册 Agent',
    'delegate': '委派任务',
    'context': '全局上下文',
    'global-agents': 'Agent 注册表',
    'add-action': '添加行动',
    'peers': '列出节点',
    'broadcast': '广播消息',
    'identity': '显示身份',
    'logs': '操作日志',
    'tools': '可用工具'
  };

  const label = toolLabels[tool] || tool;
  const thinking = s.Thinking();

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
        response = `${GREEN}📄 ${content.metadata.filename}${RESET}\n${GRAY}大小: ${content.metadata.size} 字节${RESET}\n\n${content.text}`;
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

      case 'iroh': {
        const nodeId = irohTransport.getNodeId();
        const running = irohTransport.isRunning();
        const irohPeers = irohTransport.getPeers();
        const messenger = hybridMessenger ? 'HybridMessenger 就绪' : 'HybridMessenger 未初始化';
        response = `iroh P2P 状态:
  运行中: ${running ? '是' : '否'}
  Node ID: ${nodeId ? nodeId.substring(0, 32) + '...' : 'N/A'}
  已知节点: ${irohPeers.length}
  ${messenger}`;
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

      // ---- Collaboration: 派任务给对端 agent 跑, 等回结果 ----
      // 走 P2PDirect, 不经 GitHub
      case 'collab': {
        response = '';
        const [peerOrName, ...rest] = args;
        const task = rest.join(' ').trim();
        if (!peerOrName || !task) {
          response = '用法: --collab <peer-name-or-publicKey> "<任务描述>"';
          error = response;
          break;
        }
        let targetPk = peerOrName;
        if (!/^[0-9a-fA-F]{64}$/.test(peerOrName)) {
          const { listPeers } = await import('./network/known-peers.js');
          const peers = await listPeers();
          for (const p of peers) {
            if (p.name === peerOrName) { targetPk = p.publicKey; break; }
          }
          if (targetPk === peerOrName) {
            response = `❌ 找不到 peer "${peerOrName}" (也不是 64-hex publicKey)`;
            error = response;
            break;
          }
        }
        const { resolveIdentity } = await import('./git-transport/chat-repo.js');
        const { P2PDirect } = await import('./network/p2p-direct.js');
        const id = await resolveIdentity();
        const requestId = `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 启动一个 listen 实例专门等 reply (含超时)
        const p2pListen = new P2PDirect({ name: 'cli-collab-listen', role: id.role });
        const replyPromise = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('reply timeout (90s)'));
          }, 90_000);
          p2pListen.on('data', (ev: any) => {
            try {
              const text = Buffer.isBuffer(ev.data) ? ev.data.toString('utf8') : String(ev.data);
              if (ev.fromPublicKey !== targetPk) return; // 不是对方回的就忽略
              const env = JSON.parse(text);
              if (env?.v === 3 && env?.op === 'agent.collab.reply' && env.payload?.requestId === requestId) {
                clearTimeout(timer);
                resolve(env.payload);
              }
            } catch {}
          });
        });

        try {
          await p2pListen.start();
          await p2pListen.joinTopic(Buffer.from('bolloon-agent-harness'));

          const envelope = JSON.stringify({
            v: 3,
            op: 'agent.collab.run',
            payload: {
              requestId,
              task,
              fromRole: id.role,
              fromPk: id.publicKey,
              ts: new Date().toISOString(),
              timeoutMs: 85_000,
            },
          });
          const sent = await p2pListen.sendToWithWait(targetPk, Buffer.from(envelope), 8000);
          if (!sent) {
            response = `❌ 握手超时: 对方 ${targetPk.slice(0, 12)}... 不可达`;
            error = response;
            try { await p2pListen.stop(); } catch {}
            break;
          }
          process.stdout.write(`⏳ 任务已派给 ${targetPk.slice(0, 12)}..., 等回复 (最多 90s)...\n`);
          const reply = await replyPromise;
          const lines = [
            `✅ 协作完成 (${reply.durationMs ? Math.round(reply.durationMs / 1000) + 's' : '?'})`,
            `   任务:  ${task.slice(0, 80)}${task.length > 80 ? '...' : ''}`,
            ``,
            `📥 对方结果:`,
            `${reply.result || '(empty)'}`,
          ];
          response = lines.join('\n');
        } catch (e: any) {
          response = `❌ 协作失败: ${e?.message ?? e}`;
          error = response;
        } finally {
          try { await p2pListen.stop(); } catch {}
        }
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

      // ==================== Bollharness Commands ====================

      case 'harness-init': {
        harness = createBollharnessIntegration();
        const skills = harness!.listSkills();
        const harnessSkills = harness!.listHarnessSkills();
        response = `✅ Bollharness 初始化成功\n\n` +
          `已加载 Skills: ${skills.length}\n` +
          `已加载 Harness Skills: ${harnessSkills.length}\n\n` +
          `Skills:\n${skills.map(s => `  - ${s.name}: ${s.description}`).join('\n')}\n\n` +
          `Gates: 0-8 (8-Gate 工作流)`;
        // Fix 1: write-back 初始化摘要到 AGENTS.md
        try {
          const fs_write = await import('fs');
          const agentMd = path.join(process.cwd(), 'AGENTS.md');
          const entry = `\n<!-- bolloon-init -->\n**Bollharness 初始化**: ${new Date().toISOString().slice(0, 10)} | Skills: ${skills.length} | Gates: 0-8\n`;
          fs_write.appendFileSync(agentMd, entry);
        } catch { /* 静默 */ }
        break;
      }

      case 'harness-gate': {
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const gate = harness!.getCurrentGate();
        const gatePack = harness!.getGatePack();
        const blockers = (gatePack.blockers as string[]) || [];
        response = `🚪 当前 Gate: ${gate}\n\n` +
          `Entry: ${gatePack.entry_satisfied ? '✅ 满足' : '❌ 未满足'}\n` +
          `要求产物: ${gatePack.required_artifact}\n` +
          `下一步 Skill: ${gatePack.required_next_skill}\n` +
          `Blockers: ${blockers.length > 0 ? blockers.join(', ') : '无'}`;
        break;
      }

      case 'harness-transition': {
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const [verdict] = args;
        const result = await harness!.transitionGate(
          verdict ? { verdict: verdict as 'PASS' | 'BLOCK', details: '' } : undefined
        );
        const transitionBlockers = (result.transition as { blockers?: string[] })?.blockers || [];
        response = `🔄 Gate 转移: ${result.success ? '✅ 成功' : '❌ 失败'}\n` +
          `Blockers: ${transitionBlockers.length > 0 ? transitionBlockers.join(', ') : '无'}`;
        break;
      }

      case 'harness-skill': {
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const [skillName, action] = args;
        if (!skillName) {
          const skills = harness!.listSkills();
          response = `📋 可用 Skills (${skills.length}):\n\n` +
            skills.map(s => `  ${s.name}: ${s.description}`).join('\n');
          break;
        }
        const result = await harness!.executeSkill(skillName, { action: action || 'get_gate' });
        response = `🎯 Skill '${skillName}' 执行结果:\n\n${result.result || result.error}`;
        break;
      }

      case 'harness-classify': {
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const [description] = args;
        if (!description) {
          response = '用法: --harness-classify <变更描述>';
          error = response;
          break;
        }
        const result = harness!.classifyChange(description);
        response = `📊 变更分类: ${result.classification}\n` +
          `最小路径: ${result.minimum_gates}\n` +
          `快速通道: ${result.fast_track ? '✅ 可用' : '❌ 不可用'}`;
        // Fix 1: write-back 分类结果到 CLAUDE.md
        try {
          const fs_write = await import('fs');
          const agentMd = path.join(process.cwd(), 'CLAUDE.md');
          const entry = `\n<!-- bolloon-classify -->\n**变更分类**: ${result.classification} | ${description} | ${new Date().toISOString().slice(0, 10)}\n`;
          fs_write.appendFileSync(agentMd, entry);
        } catch { /* 静默 */ }
        break;
      }

      case 'harness-context': {
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const [filePath] = args;
        if (!filePath) {
          response = '用法: --harness-context <文件路径>';
          error = response;
          break;
        }
        const context = harness!.getContext(filePath);
        response = `📄 文件: ${filePath}\n\n上下文:\n${context || '无匹配上下文'}`;
        break;
      }

      case 'harness-check': {
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const [filePath] = args;
        if (!filePath) {
          response = '用法: --harness-check <文件路径>';
          error = response;
          break;
        }
        const result = await harness!.processFileEdit(filePath);
        response = `🔍 Guard 检查: ${filePath}\n\n` +
          `通过: ${result.success ? '✅' : '❌'}\n` +
          `错误: ${result.errors.length > 0 ? result.errors.join('\n') : '无'}`;
        break;
      }

      case 'harness-archive': {
        const a = await getAgent();
        const sessionHarness = (a as any).getHarness?.();
        if (sessionHarness) {
          (a as any).archiveToHarness?.();
          response = `📦 Session 已归档到 Pi SDK Harness`;
        } else {
          if (!harness) {
            harness = createBollharnessIntegration();
          }
          const logs = (a as any).getOperationLogs?.() || [];
          const archive = harness.archiveSession(logs);
          response = `📦 Session 已归档:\n` +
            `ID: ${archive.id}\n` +
            `Gate: ${archive.gate}\n` +
            `动作数: ${archive.actionCount}\n` +
            `摘要: ${archive.summary}`;
        }
        break;
      }

      case 'harness-sessions': {
        const a = await getAgent();
        const sessionHarness = (a as any).getHarness?.();
        if (sessionHarness) {
          harness = sessionHarness;
        }
        if (!harness) {
          harness = createBollharnessIntegration();
        }
        const archives = harness.getSessionArchives();
        if (archives.length === 0) {
          response = '暂无 Session 归档记录';
          break;
        }
        response = `📜 Session 归档记录 (${archives.length}):\n\n`;
        for (const archive of archives.slice(-10)) {
          response += `### ${archive.id}\n`;
          response += `Gate: ${archive.gate} | 动作: ${archive.actionCount}\n`;
          response += `摘要: ${archive.summary}\n\n`;
        }
        break;
      }

      case 'harness-session-context': {
        const a = await getAgent();
        const sessionHarness = (a as any).getHarness?.();
        if (sessionHarness) {
          const [sessionId] = args;
          const context = sessionHarness.getSessionContext(sessionId || undefined);
          response = `📄 Pi SDK Session 上下文:\n\n${context}`;
        } else {
          if (!harness) {
            harness = createBollharnessIntegration();
          }
          const [sessionId] = args;
          const context = harness.getSessionContext(sessionId || undefined);
          response = `📄 Session 上下文:\n\n${context}`;
        }
        break;
      }

      case 'agents': {
        const manager = await createSubAgentManager();
        const agents = await manager.getAllAgents();
        if (agents.length === 0) {
          response = '暂无注册的 SubAgent';
        } else {
          response = `📋 已注册 SubAgent (${agents.length}):\n\n`;
          for (const agent of agents) {
            response += `  [${agent.status}] ${agent.name} (${agent.id})\n`;
            response += `    能力: ${agent.capabilities.join(', ')}\n`;
            response += `    DID: ${agent.did || 'N/A'}\n\n`;
          }
        }
        break;
      }

      case 'register-agent': {
        const [name, ...capabilities] = args;
        if (!name) {
          response = '用法: --register-agent <name> [capability1] [capability2] ...';
          error = response;
          break;
        }
        const manager = await createSubAgentManager();
        const agent = await manager.registerAgent({
          name,
          capabilities: capabilities.length > 0 ? capabilities : ['general'],
          did: `did:local:${Date.now()}`
        });
        response = `✅ SubAgent 注册成功:\n  ID: ${agent.id}\n  名称: ${agent.name}\n  能力: ${agent.capabilities.join(', ')}`;
        break;
      }

      case 'delegate': {
        const [taskDesc, ...requiredCaps] = args;
        if (!taskDesc) {
          response = '用法: --delegate <任务描述> [能力要求1] [能力要求2] ...';
          error = response;
          break;
        }
        const manager = await createSubAgentManager();
        const a = await getAgent();
        const { task, agent } = await manager.delegateTask(
          'cli-user',
          taskDesc,
          requiredCaps.length > 0 ? requiredCaps : ['general']
        );
        if (agent) {
          response = `✅ 任务已委派:\n  任务ID: ${task.id}\n  执行Agent: ${agent.name} (${agent.id})\n  状态: ${task.status}`;
        } else {
          response = `⚠️ 未找到合适的Agent，任务已创建:\n  任务ID: ${task.id}\n  状态: ${task.status}`;
        }
        break;
      }

      case 'engine': {
        const { delegateToEngine } = await import('./external-engines/delegate.js');
        const engineId = args[0];
        if (!engineId) {
          response = '用法: --engine <engine-id> [--model <model>] <prompt>\n可用引擎: opencode, codex, claude-code, hermes';
          error = response;
          break;
        }
        const result = await delegateToEngine(engineId, prompt || '', {
          ...(model ? { model } : {}),
        });
        const elapsed = Date.now() - startTime;
        if (result.success) {
          response = result.output || '(无输出)';
        } else {
          response = `❌ 委派失败: ${result.error}`;
          if (result.output) response += `\n[输出]\n${result.output.slice(0, 2000)}`;
        }
        metadata = { ...metadata, duration: elapsed };
        break;
      }

      case 'context': {
        const ctx = await getGlobalSharedContext();
        response = await ctx.getContextSummary();
        break;
      }

      case 'global-agents': {
        const ctx = await getGlobalSharedContext();
        const agents = await ctx.getAllAgents();
        if (agents.length === 0) {
          response = '全局注册表暂无 Agent';
        } else {
          response = `🌐 全局 Agent 注册表 (${agents.length}):\n\n`;
          for (const agent of agents) {
            response += `  [${agent.status}] ${agent.name || agent.agentId}\n`;
            response += `    ID: ${agent.agentId}\n`;
            response += `    DID: ${agent.did || 'N/A'}\n`;
            response += `    能力: ${agent.capabilities.join(', ')}\n\n`;
          }
        }
        break;
      }

      case 'add-action': {
        const [content, importance] = args;
        if (!content) {
          response = '用法: --add-action <内容> [重要性(1-10)]';
          error = response;
          break;
        }
        const ctx = await getGlobalSharedContext();
        await ctx.addUserAction(content, undefined, undefined, parseInt(importance || '5', 10));
        response = `✅ 已添加用户行动: ${content.substring(0, 50)}...`;
break;
      }

      // ==================== Update Commands ====================

      case 'update-check': {
        const { checkForUpdates } = await import('./utils/auto-update.js');
        const info = await checkForUpdates();
        if (info && info.outdated) {
          response = `📦 发现更新可用:\n\n` +
            `当前版本: ${info.version}\n` +
            `最新版本: ${info.latest}\n\n` +
            `待更新包:\n${info.packages.map(p => `  - ${p.name}: ${p.current} → ${p.latest}`).join('\n')}\n\n` +
            `运行 --update-now 进行更新`;
        } else {
          response = `✅ 已是最新版本 (${info?.version || 'unknown'})`;
        }
        break;
      }

      case 'update-now': {
        const { performUpdate } = await import('./utils/auto-update.js');
        const packages = args.length > 0 ? args : undefined;
        const result = await performUpdate(packages as string[] | undefined);
        if (result.success) {
          response = `✅ 更新成功${result.updatedPackages ? `: ${result.updatedPackages.join(', ')}` : ''}`;
          if (result.updated) {
            response += `\n\n${YELLOW}请重新启动应用以使用新版本${RESET}`;
          }
        } else {
          response = `❌ 更新失败: ${result.error}`;
          error = response;
        }
        break;
      }

      // ---- chat transport (commits-as-messages) ----
      case 'chat-init': {
        const { chatInit } = await import('./git-transport/chat-repo.js');
        const r = await chatInit(process.cwd());
        response = ['✅ chat-init', ...r.messages].join('\n');
        break;
      }
      case 'chat-send': {
        const { chatSend, resolveIdentity } = await import('./git-transport/chat-repo.js');
        // body 优先: 显式参数 > stdin
        let body = args.join(' ').trim();
        if (!body && !process.stdin.isTTY) {
          body = await new Promise<string>((resolve) => {
            let chunks = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (c) => { chunks += c; });
            process.stdin.on('end', () => resolve(chunks.trim()));
            process.stdin.on('error', () => resolve(''));
            // 1s timeout 防止无 stdin 时挂住
            setTimeout(() => resolve(chunks.trim()), 1000);
          });
        }
        const r = await chatSend({ repoDir: process.cwd(), body });
        if (!r.ok) {
          response = `❌ chat-send: ${r.reason}`;
          error = response;
        } else {
          const id = await resolveIdentity();
          const lines = [
            `✅ chat-send`,
            `   role:    ${id.role}`,
            `   sha:     ${r.sha?.slice(0, 12)}`,
            `   pushed:  ${r.pushed ? 'yes' : 'no (will retry on next send)'}`,
            `   file:    ${r.filePath}`,
            `   p2pNotify: ${r.p2pNotifyEligible ? 'eligible' : 'skipped (>4 KiB)'}`,
          ];
          response = lines.join('\n');
          // 短消息且 P2P 在线 → 走 v3 RPC 推通知 (best-effort)
          if (r.p2pNotifyEligible && r.sha) {
            try {
              const { listPeers } = await import('./network/known-peers.js');
              const peers = listPeers();
              const peerPks = Object.values(peers).map((p: any) => p.publicKey);
              if (peerPks.length > 0 && comm && typeof (comm as any).sendTo === 'function') {
                const envelope = JSON.stringify({
                  v: 3,
                  op: 'agent.chat.gitnotify',
                  payload: { sha: r.sha, fromPk: id.publicKey, role: id.role, ts: new Date().toISOString(), file: r.filePath },
                });
                let pushed = 0;
                for (const pk of peerPks) {
                  try {
                    (comm as any).sendTo(pk, envelope);
                    pushed++;
                  } catch {}
                }
                response += `\n   p2p:     sent to ${pushed}/${peerPks.length} peer(s)`;
              } else {
                response += `\n   p2p:     no peers or no sendTo`;
              }
            } catch (e: any) {
              response += `\n   p2p:     notify failed (${e?.message ?? e})`;
            }
          }
        }
        break;
      }
      case 'chat-pull': {
        const { chatPull } = await import('./git-transport/chat-repo.js');
        const { renderOneLine } = await import('./git-transport/chat-render.js');
        const r = await chatPull({ repoDir: process.cwd() });
        if (!r.ok) {
          response = `❌ chat-pull: ${r.reason}`;
          error = response;
        } else if (r.newMessages.length === 0) {
          response = `✅ chat-pull: 0 new (${r.newCommits} commit(s) scanned)`;
        } else {
          response = [
            `✅ chat-pull: ${r.newMessages.length} new message(s)`,
            ...r.newMessages.map(renderOneLine),
          ].join('\n');
        }
        break;
      }
      case 'chat-list': {
        const { listMessages } = await import('./git-transport/chat-render.js');
        const limit = (() => {
          const idx = args.indexOf('--limit');
          if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1], 10);
          return 20;
        })();
        const withIdx = args.indexOf('--with');
        const withRole = withIdx >= 0 ? args[withIdx + 1] : undefined;
        const all = listMessages(process.cwd(), withRole, limit);
        const { renderOneLine } = await import('./git-transport/chat-render.js');
        if (all.length === 0) {
          response = '(no messages yet — try `bolloon --chat-init` first)';
        } else {
          response = [
            `📜 ${all.length} message(s)${withRole ? ` (with=${withRole})` : ''}:`,
            ...all.map(renderOneLine),
          ].join('\n');
        }
        break;
      }
      case 'chat-watch': {
        // 长循环, 直接 runToolCommand 内部跑, main 末尾的 process.exit(0) 不会触发
        // (见 main() 特判)
        const { chatWatch } = await import('./git-transport/chat-watch.js');
        const idx = args.indexOf('--interval');
        const intervalMs = idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : undefined;
        await chatWatch({ repoDir: process.cwd(), intervalMs });
        response = '✅ chat-watch stopped';
        break;
      }
      case 'chat-status': {
        const { chatStatus } = await import('./git-transport/chat-repo.js');
        const s = await chatStatus({ repoDir: process.cwd() });
        const lines = [
          `📡 chat status`,
          `   role:     ${s.role}`,
          `   publicKey: ${s.publicKey.slice(0, 16)}...`,
          `   repo:     ${s.repoDir}`,
          `   remote:   ${s.remote ?? '(none — local-only mode)'}`,
          `   branch:   ${s.branch ?? '(unknown)'}`,
          `   head:     ${s.head ?? '(no commits)'}`,
          `   ahead/behind: ${s.ahead ?? 0} / ${s.behind ?? 0}`,
          `   mode:     ${s.mode}`,
          `   files:    ${s.fileCount} (${Object.entries(s.byRole).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
        ];
        response = lines.join('\n');
        break;
      }

      // ---- P2P-only chat (no git, no GitHub) ----
      case 'chat-p2p-send': {
        response = '';
        // 形态: --chat-p2p-send <peerOrName> "消息正文"
        // peerOrName: 64-hex publicKey 或 known_peers.json 里的 name
        // 走 P2PDirect (纯 TS, 不走坏了的 @diap/sdk HyperswarmCommunicator)
        const [peerOrName, ...rest] = args;
        const body = rest.join(' ').trim();
        if (!peerOrName || !body) {
          response = '用法: --chat-p2p-send <peer-name-or-publicKey> "消息正文"';
          error = response;
          break;
        }
        let targetPk = peerOrName;
        if (!/^[0-9a-fA-F]{64}$/.test(peerOrName)) {
          const { listPeers } = await import('./network/known-peers.js');
          const peers = await listPeers();
          for (const p of peers) {
            if (p.name === peerOrName) { targetPk = p.publicKey; break; }
          }
          if (targetPk === peerOrName) {
            response = `❌ 找不到 peer "${peerOrName}" (也不是 64-hex publicKey)`;
            error = response;
            break;
          }
        }
        const { resolveIdentity } = await import('./git-transport/chat-repo.js');
        const { P2PDirect } = await import('./network/p2p-direct.js');
        const id = await resolveIdentity();
        const envelope = JSON.stringify({
          v: 3,
          op: 'agent.chat.direct',
          payload: {
            text: body,
            fromRole: id.role,
            fromPk: id.publicKey,
            ts: new Date().toISOString(),
          },
        });
        const p2p = new P2PDirect({ name: 'cli-send', role: id.role });
        try {
          await p2p.start();
          await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));
          const sent = await p2p.sendToWithWait(targetPk, Buffer.from(envelope), 8000);
          if (sent) {
            response = `✅ 私发 → ${targetPk.slice(0, 12)}...\n   role: ${id.role}\n   text: ${body.slice(0, 80)}${body.length > 80 ? '...' : ''}\n   (P2P-only, 未写入 git / GitHub)`;
          } else {
            response = `❌ 握手超时: 对方 ${targetPk.slice(0, 12)}... 未在 8s 内响应 (对方可能离线 / NAT 后 / DHT 还在 bootstrap)`;
            error = response;
          }
        } catch (e: any) {
          response = `❌ 发送失败: ${e?.message ?? e}`;
          error = response;
        } finally {
          try { await p2p.stop(); } catch {}
        }
        break;
      }
      case 'chat-p2p-listen': {
        response = '';
        // 后台长循环: P2PDirect 监听, 只打印 op=agent.chat.direct 的
        const { resolveIdentity } = await import('./git-transport/chat-repo.js');
        const { P2PDirect } = await import('./network/p2p-direct.js');
        const id = await resolveIdentity();
        const p2p = new P2PDirect({ name: 'cli-listen', role: id.role });
        process.stdout.write(`[chat-p2p-listen] role=${id.role} pk=${id.publicKey.slice(0, 12)} listening on bolloon-agent-harness\n`);
        process.stdout.write(`[chat-p2p-listen] press Ctrl-C to stop\n`);

        const onData = (ev: any) => {
          try {
            const text = Buffer.isBuffer(ev.data) ? ev.data.toString('utf8') : String(ev.data);
            try {
              const env = JSON.parse(text);
              if (env && env.v === 3 && env.op === 'agent.chat.direct') {
                const { text: body, fromRole } = env.payload || {};
                const ts = (env.payload?.ts || new Date().toISOString()).replace('T', ' ').replace(/\.\d+Z$/, '');
                process.stdout.write(`\n[${ts} ${fromRole || ev.fromPublicKey?.slice(0, 12)} → me] ${body}\n> `);
                return;
              }
            } catch { /* 非 v3 envelope, 当 raw 显示 */ }
            process.stdout.write(`\n[raw ${ev.fromPublicKey?.slice(0, 12)}] ${text.slice(0, 200)}\n> `);
          } catch (e: any) {
            process.stdout.write(`[chat-p2p-listen] decode error: ${e?.message ?? e}\n`);
          }
        };
        p2p.on('data', onData);

        let lastPing = 0;
        const keepAlive = setInterval(() => {
          const now = Date.now();
          if (now - lastPing > 5 * 60_000) {
            process.stdout.write(`[chat-p2p-listen] alive, role=${id.role}\n`);
            lastPing = now;
          }
        }, 30_000);

        const stop = async () => {
          process.stdout.write(`\n[chat-p2p-listen] stopping...\n`);
          try { p2p.off('data', onData); } catch {}
          clearInterval(keepAlive);
          try { await p2p.stop(); } catch {}
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        process.on('SIGHUP', stop);

        await p2p.start();
        await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));
        process.stdout.write(`[chat-p2p-listen] joined topic ✓\n> `);

        await new Promise(() => {});
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

  s.clearThinking(thinking);

  if (outputJson) {
    const result: NonInteractiveResult = {
      success: !error,
      response,
      error,
      metadata
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (error) {
      s.divider();
      console.log(`${MAGENTA}${error}${RESET}\n`);
    } else {
      s.divider();
      console.log(`${response}\n`);
    }
    console.log(`${GRAY}耗时: ${metadata.duration}ms${RESET}`);
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
      await runToolCommand(tool, toolArgs, false, comm, args.model, prompt);
    } else if (prompt) {
      const a = await getAgent();
      console.log(await a.prompt(prompt));
    }

    console.log = originalLog;
    await fs.writeFile(output, outputBuffer.trim(), 'utf-8');
    console.log(`✅ 结果已保存到: ${output}`);
    return;
  }

  if (tool === 'prompt' && prompt) {
    // 2026-06-15: --prompt "text" 走直接调 a.prompt(prompt) 路径, 避开 runToolCommand
    //   (case 'prompt' 内的 [text] = args 从 toolArgs 取值是空数组, 永远报"缺少 prompt 文本"是 CLI bug)
    const startTime = Date.now();
    const a = await getAgent();
    try {
      const response = await a.prompt(prompt);
      const elapsed = Date.now() - startTime;
      if (json) {
        console.log(JSON.stringify({ success: true, response, elapsedMs: elapsed }, null, 2));
      } else {
        console.log(response);
        console.log(`\n耗时: ${elapsed}ms`);
      }
    } catch (e: any) {
      const error = e?.message || String(e);
      if (json) {
        console.log(JSON.stringify({ success: false, error }, null, 2));
      } else {
        console.log(`\n错误: ${error}`);
      }
      process.exit(1);
    }
    return;
  }

  if (tool) {
    await runToolCommand(tool, toolArgs, !!json, comm, args.model, prompt);
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
  iroh?: boolean;
  identity?: boolean;
  logs?: boolean;
  broadcast?: boolean;
  send?: boolean;
  search?: boolean;
  model?: string;
  engine?: string;
  output?: string;
  tool?: string;
  toolArgs: string[];
  agents?: boolean;
  registerAgent?: boolean;
  delegate?: boolean;
  context?: boolean;
  globalAgents?: boolean;
  addAction?: boolean;
  tui?: boolean;
  updateCheck?: boolean;
  updateNow?: boolean;
  // --- chat transport (commits as messages) ---
  chatInit?: boolean;
  chatSend?: boolean;
  chatPull?: boolean;
  chatList?: boolean;
  chatWatch?: boolean;
  chatStatus?: boolean;
  // --- P2P-only chat (no git) ---
  chatP2pSend?: boolean;
  chatP2pListen?: boolean;
  collab?: boolean;
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
      case '--iroh':
        result.iroh = true;
        result.tool = 'iroh';
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
      case '--agents':
        result.agents = true;
        result.tool = 'agents';
        break;
      case '--register-agent':
        result.registerAgent = true;
        result.tool = 'register-agent';
        const regArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          regArgs.push(args[++i]);
        }
        result.toolArgs = regArgs;
        break;
      case '--delegate':
        result.delegate = true;
        result.tool = 'delegate';
        const delArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          delArgs.push(args[++i]);
        }
        result.toolArgs = delArgs;
        break;
      case '--engine':
      case '-e':
        result.engine = args[++i];
        result.tool = 'engine';
        result.toolArgs = [result.engine];
        break;
      case '--context':
        result.context = true;
        result.tool = 'context';
        break;
      case '--global-agents':
        result.globalAgents = true;
        result.tool = 'global-agents';
        break;
      case '--add-action':
        result.addAction = true;
        result.tool = 'add-action';
        const actionArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          actionArgs.push(args[++i]);
        }
        result.toolArgs = actionArgs;
        break;
      case '--harness-init':
        result.tool = 'harness-init';
        break;
      case '--harness-gate':
        result.tool = 'harness-gate';
        break;
      case '--harness-transition':
        result.tool = 'harness-transition';
        const transitionArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          transitionArgs.push(args[++i]);
        }
        result.toolArgs = transitionArgs;
        break;
      case '--harness-skill':
        result.tool = 'harness-skill';
        const skillArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          skillArgs.push(args[++i]);
        }
        result.toolArgs = skillArgs;
        break;
      case '--harness-classify':
        result.tool = 'harness-classify';
        const classifyArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          classifyArgs.push(args[++i]);
        }
        result.toolArgs = classifyArgs;
        break;
      case '--harness-context':
        result.tool = 'harness-context';
        const contextArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          contextArgs.push(args[++i]);
        }
        result.toolArgs = contextArgs;
        break;
      case '--harness-check':
        result.tool = 'harness-check';
        const checkArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          checkArgs.push(args[++i]);
        }
        result.toolArgs = checkArgs;
        break;
      case '--harness-archive':
        result.tool = 'harness-archive';
        break;
      case '--harness-sessions':
        result.tool = 'harness-sessions';
        break;
      case '--harness-session-context':
        result.tool = 'harness-session-context';
        const sessionArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          sessionArgs.push(args[++i]);
        }
        result.toolArgs = sessionArgs;
        break;
      // --- chat transport (commits as messages) ---
      case '--chat-init':
        result.chatInit = true;
        result.tool = 'chat-init';
        break;
      case '--chat-send':
        result.chatSend = true;
        result.tool = 'chat-send';
        // 吃掉所有非 flag 参数作为消息体 (--chat-send "消息正文" 或 stdin)
        const chatSendArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          chatSendArgs.push(args[++i]);
        }
        result.toolArgs = chatSendArgs;
        break;
      case '--chat-pull':
        result.chatPull = true;
        result.tool = 'chat-pull';
        break;
      case '--chat-list':
        result.chatList = true;
        result.tool = 'chat-list';
        break;
      case '--chat-watch':
        result.chatWatch = true;
        result.tool = 'chat-watch';
        const watchArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          watchArgs.push(args[++i]);
        }
        result.toolArgs = watchArgs;
        break;
      case '--chat-status':
        result.chatStatus = true;
        result.tool = 'chat-status';
        break;
      case '--chat-p2p-send':
        result.tool = 'chat-p2p-send';
        const p2pSendArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          p2pSendArgs.push(args[++i]);
        }
        result.toolArgs = p2pSendArgs;
        break;
      case '--chat-p2p-listen':
        result.tool = 'chat-p2p-listen';
        break;
      case '--collab':
        result.tool = 'collab';
        const collabArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          collabArgs.push(args[++i]);
        }
        result.toolArgs = collabArgs;
        break;
      case '--update-check':
        result.updateCheck = true;
        result.tool = 'update-check';
        break;
      case '--update-now':
        result.updateNow = true;
        result.tool = 'update-now';
        const updateArgs: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          updateArgs.push(args[++i]);
        }
        result.toolArgs = updateArgs;
        break;
      case '--tui':
        result.tui = true;
        break;
      case '--model':
      case '-m':
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
        if (!arg.startsWith('-') && !result.prompt) {
          result.prompt = arg;
          if (!result.tool) result.tool = 'prompt';
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

  # SubAgent 管理
  --agents                   列出所有 SubAgent
  --register-agent <name> [cap1] [cap2]...  注册新 SubAgent
  --delegate <任务描述> [能力要求...]  委派任务给最佳 Agent

  # 全局共享上下文
  --context                  显示全局共享上下文摘要
  --global-agents            显示全局 Agent 注册表
  --add-action <内容> [重要性]  添加用户行动到共享上下文

  # Bollharness 治理框架
  --harness-init             初始化 Bollharness 治理框架
  --harness-gate             显示当前 Gate 状态
  --harness-transition [PASS|BLOCK]  执行 Gate 转移
  --harness-skill <name> [action]  执行 Harness Skill
  --harness-classify <描述>  分类变更类型
  --harness-context <file>   获取文件上下文
  --harness-check <file>     执行 Guard 检查
  --harness-archive          归档当前 Session 到 Harness
  --harness-sessions         列出 Session 归档记录
  --harness-session-context [id]  获取 Session 上下文

  # 自动更新
  --update-check             检查 npm 包更新
  --update-now [pkg]        更新到最新版本

  # 跨机聊天 (commits-as-messages, 共享 GitHub 仓库)
  --chat-init                初始化 .comm/ 目录 (一次性)
  --chat-send "消息正文"     把消息写到 .comm/<role>/, commit + push
  --chat-pull                拉取远端 .comm/ 的新消息并显示
  --chat-list                列出本地所有已同步消息
  --chat-watch [--interval 15s]  后台定时拉取, 有新消息时输出
  --chat-status              一屏查看: role / publicKey / remote / ahead-behind

  # 纯 P2P 私聊 (不走 GitHub, 不写 git, 不持久化)
  --chat-p2p-send <peer|publicKey> "消息正文"   通过 P2P 直接发一条
  --chat-p2p-listen          后台监听对方 P2P 私聊消息 (Ctrl-C 退出)

  # 跨机 agent 协作 (对方 bolloon --web 起着才能处理, 走 P2P 不经 GitHub)
  --collab <peer|publicKey> "<任务描述>"  派任务给对端 LLM 干活, 等回结果 (90s 超时)

  # 外部编码智能体委派
  --engine, -e <id> [--model <m>] <prompt>  委派任务给外部引擎，如 opencode/codex
  --model <name>             指定委派时使用的模型

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

  # 外部引擎委派
  npx tsx src/index.ts --engine opencode --model opencode/deepseek-v4-flash-free "说你好"

  # Web 模式
  npx tsx src/index.ts --web

环境变量:
  MINIMAX_API_KEY       MiniMax API 密钥
  DEEPSEEK_API_KEY      DeepSeek API 密钥
  KIMI_API_KEY / MOONSHOT_API_KEY  Kimi/Moonshot API 密钥
  GLM_API_KEY / ZHIPU_API_KEY      智谱 GLM API 密钥
  QWEN_API_KEY / DASHSCOPE_API_KEY 通义千问 API 密钥
  OPENAI_API_KEY        OpenAI API 密钥（Pi SDK）
  ANTHROPIC_API_KEY     Anthropic API 密钥（Pi SDK）
  PORT                  Web 服务端口（默认 54188）
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * 以相同参数重新启动当前 Node 进程（用于更新后自动应用新版本）。
 * 先 detached 拉起新进程，再退出旧进程。
 */
function restartCurrentProcess(): void {
  try {
    const entry = process.argv[1];
    const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
      stdio: 'inherit',
      detached: true,
      env: { ...process.env },
    });
    child.unref();
  } catch {
    // 拉起失败则退回手动重启
  }
  process.exit(0);
}

async function main() {

  try {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // 启动自动更新检查（后台执行，不阻塞主流程）。
  // 检测到新版本会自动安装；安装成功后自动重启以应用新版本。
  // 可用 --no-update / BOLLOON_SKIP_UPDATE 关闭，
  // 或用 config.json 的 autoUpdate:false / autoRestart:false / BOLLOON_AUTO_UPDATE=1 控制。
  // 手动检查: bolloon --update-check
  // 手动更新: bolloon --update-now [package]
  if (!args.updateCheck && !args.updateNow) {
    void (async () => {
      try {
        const { checkAndUpdate } = await import('./utils/auto-update.js');
        await checkAndUpdate({ onUpdated: restartCurrentProcess });
      } catch {
        // 自动更新失败不影响主程序启动
      }
    })();
  }

  const mode = args.web ? 'web' : 'cli';
  const isNonInteractive = !!(args.tool || args.prompt);

  const originalLog = console.log;
  const originalInfo = console.info;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  const isSdkLog = (msg: string): boolean => {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(msg);
  };

  const isCLIInteractive = mode === 'cli' && !isNonInteractive;
  if (isCLIInteractive) {
    console.log = () => {};
    console.info = () => {};
    process.stdout.write = () => true as any;
  }

  if (isNonInteractive) {
    console.error = () => {};
  }

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  // 2026-06-15: 修复 — 之前 anthropic 401 是因为 shell env 残留的旧 ANTHROPIC_API_KEY 抢了 provider 选择
  //   用 BOLLOON_LLM_PROVIDER env 显式覆盖, 否则还是按 env hasXxx 顺序自动选
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY && !process.env.BOLLOON_LLM_PROVIDER;
  const hasMinimax = !!process.env.MINIMAX_API_KEY;
  const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
  const hasKimi = !!(process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY);
  const hasGlm = !!(process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY);
  const hasQwen = !!(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY);
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasOllama = !!process.env.OLLAMA_BASE_URL;

  const llmProvider = hasOpenAI ? 'OpenAI' :
                      hasAnthropic ? 'Anthropic' :
                      hasOpenRouter ? 'OpenRouter' :
                      hasGemini ? 'Gemini' :
                      hasOllama ? 'Ollama' :
                      hasMinimax ? 'MiniMax' :
                      hasDeepSeek ? 'DeepSeek' :
                      hasKimi ? 'Kimi' :
                      hasGlm ? 'GLM' :
                      hasQwen ? 'Qwen' : null;

  if (llmProvider) {
    initMinimax({ provider: llmProvider.toLowerCase() as any });
  } else {
    if (isNonInteractive) {
      s.warn('未设置任何 LLM API Key，功能受限');
    }
  }

  const { keypair, did, name } = await bootstrapIdentity();
  agentIdentity = { did, name, publicKey: Buffer.from(keypair.publicKey).toString('hex') };

  publishDID(name, keypair).then(({ cid, ipnsName }) => {
    if (cid) agentIdentity!.cid = cid;
    if (ipnsName) agentIdentity!.ipnsName = ipnsName;
  }).catch(() => {});

  

  const verifier = createVerificationManager();
  let comm: HyperswarmCommunicator | null = null;

  try {
    if (mode === 'web') {
      bootstrapP2P(verifier).then(c => {
        comm = c;
        const connections = c.getConnections();
        if (connections.length > 0) {
          agentIdentity!.peerId = connections[0].publicKey;
          agentIdentity!.p2pChannel = 'bolloon-agent-harness';
        }
      }).catch(err => {
  
        s.warn(`P2P Web 模式启动失败: ${err.message}`);
      });
    } else {
      comm = await bootstrapP2P(verifier);
      const connections = comm.getConnections();
      if (connections.length > 0) {
        agentIdentity.peerId = connections[0].publicKey;
        agentIdentity.p2pChannel = 'bolloon-agent-harness';
      }
    }
  } catch (err: any) {
    s.warn(`P2P 初始化失败: ${err.message}`);
    s.warn('将使用无 P2P 模式运行');
  }

  await bootstrapIroh(keypair, name);

  // Bolloon Bootstrap: 启动扫描 + Context 收集 + 挂定时任务
  // 失败静默 (主流程不被阻塞)
  try {
    const { bootstrapBolloon } = await import('./pi-ecosystem-judgment/human-value-pipeline.js');
    s.info('正在 bootstrap bolloon 上下文...');
    const bs = await bootstrapBolloon({ cwd: process.cwd() });
    s.info(`Bootstrap 完成 (${bs.durationMs}ms, ${bs.errors.length} 个非致命错误)`);
  } catch (err: any) {
    s.warn(`Bootstrap 失败 (非致命, 主流程继续): ${err.message}`);
  }

  if (mode === 'web') {
    const port = parseInt(process.env.PORT || '54188');
    // 2026-06-16: BOLLOON_DEV_MODE=1 或 selfImprove=true 启动项 → 开发者模式, 启用自迭代 (健康监控+自改总线)
    // 默认用户模式: 不自迭代, 自改卡片不自动出现, 仍可 POST /api/self-improve/trigger 手动触发
    const selfImprove = process.env.BOLLOON_DEV_MODE === '1' || process.env.BOLLOON_DEV_MODE === 'true';
    if (selfImprove) {
      console.log('[startup] BOLLOON_DEV_MODE=1, 开发者模式: 自迭代已启用');
    }
    const { createWebServer, openBrowser } = await import('./web/server.js');

    // 2026-06-24: CLI 默认 loopback bind (安全), LAN 访问需 BOLLOON_HOST=0.0.0.0
    const bindHost = process.env.BOLLOON_HOST;
    const { port: actualPort } = await createWebServer(port, { selfImprove, ...(bindHost ? { host: bindHost } : {}) });

    const displayHost = bindHost ?? '127.0.0.1';
    s.success(`浏览器已打开 → http://${displayHost}:${actualPort}`);
    openBrowser(`http://${displayHost}:${actualPort}`);
  } else if (isNonInteractive) {
    console.log = originalLog;
    console.info = originalInfo;
    process.stdout.write = originalStdoutWrite;
    s.info('执行命令...');
    console.log();
    await runNonInteractive(args, comm!);
    comm?.stop();
    // chat-watch / chat-p2p-listen 是长循环, 不会自然 return, 走 SIGINT 自然退出
    if (!args.chatWatch && args.tool !== 'chat-p2p-listen') {
      process.exit(0);
    }
  } else {
    console.log = originalLog;
    console.info = originalInfo;
    process.stdout.write = originalStdoutWrite;

    startCLI(comm!);
  }
  } catch (e) {
    throw e;
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
