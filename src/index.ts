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
import { printBanner, renderDashboard, renderDialog, renderUserMessage, renderAgentMessage, renderMessageBox, renderToolCall, renderToolCallListItem, renderToolCallBody, renderToolCallsHeader, renderToolCallsFooter, flowConnector, termWidth, brandArtLines, boxTop, boxRow, boxBottom, dispWidth } from './cli/loading-tui.js';
import type { ToolCallListItem } from './cli/loading-tui.js';
import { startInk, stopInk, inkAppendLine as appendLine, inkSetStatus, inkSetThinking, inkSetTransient } from './cli/ink-app.js';
import * as dbgFs from 'fs';

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

// Bolloon Web UI 配色 truecolor ANSI — 与 loading-tui.ts 一致
function fg(r: number, g: number, b: number): string { return `\x1b[38;2;${r};${g};${b}m`; }
const C_ACCENT = fg(0xc4, 0xd6, 0x40);  // #c4d640
const C_TEXT   = fg(0xd8, 0xd8, 0xc8);  // #d8d8c8
const C_DIM    = fg(0x90, 0x90, 0x88);  // #909088
const C_OK     = fg(0x22, 0xc5, 0x5e);  // #22c55e
const C_ERROR  = fg(0xef, 0x44, 0x44);  // #ef4444
const C_WARN   = fg(0xf5, 0x9e, 0x0b);  // #f59e0b

// 向下兼容 — 旧名映射到新色
const CYAN   = C_ACCENT;
const GREEN  = C_OK;
const YELLOW = C_WARN;
const MAGENTA = C_ERROR;
const WHITE  = C_TEXT;
const GRAY   = C_DIM;
const BLUE   = C_DIM;
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
    const frames = ['(｀・ω・´)', '(´･_･`)', '(｡•́︿•̀｡)', 'ᕙ(▀̿̿Ĺ̯̿̿▀̿ ̿)ᕗ', '(◕‿◕)'];
    let i = 0;
    let dots = 0;
    const frame = frames[0];
    appendLine(`  ${frame} 思考...`);
    return setInterval(() => {
      i = (i + 1) % frames.length;
      dots = (dots + 1) % 4;
      const dotStr = '.'.repeat(dots || 1);
      appendLine(`\r  ${frames[i]} 思考${dotStr}   `);
    }, 600);
  },

  clearThinking: (interval: ReturnType<typeof setInterval>) => {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
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
        appendLine(`     ${YELLOW}⚠ IPFS 发布失败 (${e?.message?.slice(0, 80) || 'unknown'}), 本地模式运行${RESET}`);
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

/** 启动路径网络操作超时门: 超时 reject (由调用方 catch 降级) — 防止弱网下 CLI 卡死在启动 (2026-08-07) */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    ),
  ]);
}

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
/** 2026-08-09: agent 当前绑定的 channel id (null = 默认 harness 身份) — 切换时据此重建 */
let agentBoundChannelId: string | null = null;
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
  // 2026-08-09: agent 身份绑定当前 active channel — 切换 / 新建 channel 后重建.
  //   旧实现: agent 全局单例 + peerId:'harness' 固定, 切 channel 身份不变 (bug).
  //   新实现: channel 有 agentId/did/publicKey/persona 时按 channel 建 session,
  //   agentIdentity 同步更新, loadSessionKey 回灌该 channel 的历史.
  const targetChannelId = cliActiveChannelId || null;
  if (agent && agentBoundChannelId === targetChannelId) return agent;

  // 读取当前 active channel 的持久身份
  let chIdentity: { agentId?: string; did?: string; publicKey?: string; name?: string; persona?: any; currentSessionId?: string } | null = null;
  if (targetChannelId) {
    try {
      const { getIdentityStore } = await import('./agents/agent-identity-store.js');
      const store = getIdentityStore();
      await store.load();
      const ch = store.rawChannels.find((c: any) => c.id === targetChannelId);
      if (ch) chIdentity = ch as any;
    } catch { /* 读不到就退默认 */ }
  }

  let identityDoc: any;
  if (chIdentity?.did && chIdentity.publicKey) {
    // channel 已有持久 DID → 用 channel 身份
    identityDoc = {
      did: chIdentity.did,
      name: chIdentity.persona?.name || chIdentity.name || 'agent',
      publicKey: chIdentity.publicKey,
      createdAt: Date.now(),
    };
  } else if (agentIdentity) {
    identityDoc = {
      did: agentIdentity.did,
      name: agentIdentity.name,
      publicKey: agentIdentity.publicKey,
      createdAt: Date.now(),
      peerId: agentIdentity.peerId,
      p2pChannel: agentIdentity.p2pChannel,
      cid: agentIdentity.cid,
      ipnsName: agentIdentity.ipnsName
    };
  } else {
    identityDoc = undefined;
  }

  const loadSessionKey = targetChannelId
    ? `${targetChannelId}:${chIdentity?.currentSessionId || 'default'}`
    : undefined;

  agent = await createAgentSession({
    cwd: process.cwd(),
    peerId: targetChannelId ?? 'harness',
    identityDoc,
    // 2026-08-09: 透传 channel.agentId → persona docs 按 agent 加载 (身份真正变化)
    agentId: chIdentity?.agentId || (targetChannelId ? undefined : agentIdentity?.name),
    loadSessionKey,
  });
  agentBoundChannelId = targetChannelId;

  // 同步 agentIdentity (状态栏 / 身份引用)
  if (chIdentity) {
    agentIdentity = {
      did: chIdentity.did || agentIdentity?.did || '',
      name: chIdentity.persona?.name || chIdentity.name || 'agent',
      publicKey: chIdentity.publicKey || agentIdentity?.publicKey || '',
      peerId: targetChannelId ?? undefined,
    };
  }
  return agent;
}

/** 强制重建 agent (切 channel / 新建 agent 后调用) */
function invalidateAgent(): void {
  agent = null;
  agentBoundChannelId = null;
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
// 2026-07-28: 改用 readline.createInterface + replReadline 循环

let isRunning = false;
let queueMode = false;
const pendingQueue: string[] = [];
let cliStartTime = 0;
let cliModelName = '…';
let cliAgentName = '…';
let cliActiveChannelId: string | null = null;
// 2026-08-12: 当前 active channel 的 agentId (如 agent-alice). memory 落盘按 agentId 存,
//   /memory /resume /did 读路径必须用 agentId 而非 display name (cliAgentName), 否则路径不一致读不到.
let cliAgentId: string | null = null;
// 2026-08-10: CLI 自动整理心跳 (与社交心跳并列, 独立于 server) — 退出时 stop
let cliOrganizeHeartbeat: { stop(): void; runOnce(): Promise<unknown> } | null = null;

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** 2026-08-12: 返回当前 agentId (memory 路径用). 优先 cliAgentId, fallback cliAgentName. */
function getCliAgentId(): string {
  if (cliAgentId) return cliAgentId;
  // 无显式 agentId 时退到 cliAgentName (harness 默认 'agent', 其余用名字)
  return cliAgentName === 'bolloon' ? 'agent' : (cliAgentName || 'agent');
}

/** 2026-08-06: 从 ContextManager 读上下文用量 (CLI 状态栏数据源, 失败退化 0/1M) */
// 2026-08-07: 不能用 require 加载 ESM 模块 (ERR_REQUIRE_ESM) → startCLI 里 await import 一次缓存引用,
//   同步函数 getCliCtxUsage/getStatus 复用 — 之前裸 require 与 _require 都抛错被 catch → 状态栏恒 0/1M
let _ctxManagerRef: { getContextManager: () => any } | null = null;
function getCliCtxUsage(): { pct: number; usedTokens: number; maxTokens: number; stage: string } {
  try {
    const cm = _ctxManagerRef?.getContextManager();
    if (!cm) return { pct: 0, usedTokens: 0, maxTokens: 1_000_000, stage: 'normal' };
    const u = cm.getUsage();
    return {
      // 保留浮点 (0-100), 由 buildContextBar 格式化 — round 会让 <0.5% 全变 0, 状态栏像死代码
      pct: Math.min(100, u.pct * 100),
      usedTokens: u.usedTokens,
      maxTokens: u.maxTokens,
      stage: u.stage,
    };
  } catch {
    return { pct: 0, usedTokens: 0, maxTokens: 1_000_000, stage: 'normal' };
  }
}

/** 上下文进度条: 320k/1M │ [██████░░░░] 32% (bolloon 色系: #c4d640 主色) */
function buildContextBar(usage: { pct: number; usedTokens: number; maxTokens: number; stage: string }): string {
  const barLen = 10;
  const filled = Math.min(barLen, Math.max(0, Math.round((usage.pct / 100) * barLen)));
  const barColor = usage.stage === 'warning' || usage.stage === 'compressing' ? C_WARN : C_ACCENT;
  const bar = `${C_DIM}[${RESET}${barColor}${'█'.repeat(filled)}${RESET}${C_DIM}${'░'.repeat(barLen - filled)}${RESET}${C_DIM}]${RESET}`;
  const fmtK = (n: number) => (n >= 1_000_000 ? (n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`) : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const usageTxt = `${C_TEXT}${fmtK(usage.usedTokens)}/${fmtK(usage.maxTokens)}${RESET}`;
  // 百分比: >=10% 整数, >=1% 一位小数, <1% 两位小数 (1M 窗口下小 token 数也可见变化)
  const pctTxt = usage.pct >= 10 ? `${Math.round(usage.pct)}%` : usage.pct >= 1 ? `${usage.pct.toFixed(1)}%` : `${usage.pct.toFixed(2)}%`;
  let suffix = '';
  if (usage.stage === 'warning') suffix = ` ${C_WARN}⚠ 即将压缩${RESET}`;
  else if (usage.stage === 'compressing') suffix = ` ${C_WARN}🗜️ 压缩中...${RESET}`;
  else if (usage.stage === 'compressed') suffix = ` ${C_OK}✓ 已压缩${RESET}`;
  return `${usageTxt} ${C_DIM}│${RESET} ${bar} ${barColor}${pctTxt}${RESET}${suffix}`;
}

/** 状态栏: 模型 │ 当前智能体 (含 channel) │ ⏱ 时间 │ 320k/1M │ [██████░░░░] 32% (bolloon 色系) */
function getStatus(): string {
  const usage = getCliCtxUsage();
  const agentPart = cliActiveChannelId ? `${cliAgentName} ${C_DIM}(ch:${cliActiveChannelId.slice(0, 10)})${RESET}` : cliAgentName;
  return `${C_ACCENT}${cliModelName}${RESET}${C_DIM}  │${RESET} ${agentPart} ${C_DIM}│${RESET} ⏱ ${C_TEXT}${fmtDuration(Date.now() - cliStartTime)}${RESET}${C_DIM} │${RESET} ${buildContextBar(usage)}`;
}

function statusBarLine(): string {
  const dur = cliStartTime ? fmtDuration(Date.now() - cliStartTime) : '0s';
  const usage = getCliCtxUsage();
  return `${C_ACCENT}${cliModelName}${RESET}${C_DIM}  │${RESET} ${cliAgentName} ${C_DIM}│${RESET} ⏱ ${C_ACCENT}${dur}${RESET} ${C_DIM}│${RESET} ${buildContextBar(usage)}`;
}

async function startCLI(comm: HyperswarmCommunicator): Promise<void> {
  isRunning = true;

  // CLI 模式下静音所有 console.log/warn
  // (Ink 用自己的 render 引擎, console.log 输出会污染终端)
  console.log = () => {};
  console.warn = () => {};
  // 同时过滤 process.stdout.write — 阻止 [xxx] 前缀的输出
  const _origStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    // 过滤以 [ 开头的行 (agent 内部日志)
    if (s.trimStart().startsWith('[')) return true;
    return _origStdout(chunk, ...rest);
  }) as any;

  let peerCount = 0;
  try { peerCount = comm.getConnections().length; } catch { /* */ }
  
  // 读取 LLM 模型名 — 优先 bolloon-config.json (activeProvider), 再退 env (2026-08-07:
  //   之前只读 env → 用户配了配置文件但状态栏显示"未配置")
  const providerNames: [string, string][] = [
    ['OPENAI_API_KEY', 'OpenAI'],
    ['ANTHROPIC_API_KEY', 'Anthropic'],
    ['DEEPSEEK_API_KEY', 'DeepSeek'],
    ['GOOGLE_API_KEY', 'Google'],
    ['GROQ_API_KEY', 'Groq'],
    ['MINIMAX_API_KEY', 'MiniMax'],
    ['XAI_API_KEY', 'xAI'],
    ['TOGETHER_API_KEY', 'Together'],
  ];
  let foundProvider = providerNames.find(([k]) => process.env[k]);
  cliModelName = foundProvider ? foundProvider[1] : '未配置';
  // bolloon-config.json activeProvider 优先 (用户真实配置来源)
  try {
    const { llmConfigStore } = await import('./llm/config-store.js');
    await llmConfigStore.initialize();
    const active = await llmConfigStore.getActiveProvider();
    if (active) {
      const label = String(active).trim();
      cliModelName = label || cliModelName;
      const cfg = await llmConfigStore.getActiveProviderConfig().catch(() => null);
      const model = cfg?.model;
      if (model) cliModelName = `${label} · ${model}`;
    }
  } catch { /* config-store 失败静默, 用 env 结果 */ }
  cliAgentName = agentIdentity?.name || 'bolloon';
  cliStartTime = Date.now();

  // 2026-08-10: 启动后台拉起本地 Kubo (IPFS) — fire-and-forget, 失败静默 (ipfs 工具内会再尝试).
  //   背景: 实测日志 ipfs_add 失败 "发送上传请求失败: http://127.0.0.1:5001/api/v0/add" —
  //   Kubo daemon 没起, 而 CLI 启动路径 (startCLI) 之前从不调 checkKuboSetup (只有 Web server 调).
  //   BOLLOON_SKIP_KUBO=1 可禁用 (pty 测试用临时 HOME 时避免拉起指向临时 repo 的 daemon 污染 5001)
  if (process.env.BOLLOON_SKIP_KUBO !== '1') {
    void (async () => {
      try {
        const sdk = await import('@diap/sdk');
        const checkKuboSetup = (sdk as any).checkKuboSetup;
        if (typeof checkKuboSetup === 'function') {
          await checkKuboSetup(true, true);
        }
      } catch { /* Kubo 拉起失败静默 — ipfs 工具内 ensureKuboReady 会再尝试 */ }
    })();
  }

  // 恢复上次 active channel (session 恢复: CLI 与 Web 共用 active-channel.json)
  try {
    const { getIdentityStore } = await import('./agents/agent-identity-store.js');
    const store = getIdentityStore();
    await store.load();
    const active = await store.getActive();
    if (active) {
      cliAgentName = active.name;
      cliActiveChannelId = active.channelId ?? null;
      // 2026-08-12: 同步 agentId (memory 路径一致) — 从 rawChannels 按 channelId 取 agentId
      const raw = active.channelId ? store.rawChannels.find((c: any) => c.id === active.channelId) : undefined;
      cliAgentId = raw?.agentId || null;
    }
  } catch {
    /* 无 channels/active 记录时保持默认 */
  }

  // 进入 Ink TUI 输入循环
  // 2026-08-06: 初始状态栏也带上下文显示 (0/1M │ [░░░░░░░░░░] 0%)
  // 2026-08-07: 缓存 ContextManager 引用 (require 加载 ESM 抛 ERR_REQUIRE_ESM, 状态栏恒 0 根因)
  try {
    _ctxManagerRef = await import('./bootstrap/context-manager.js');
  } catch { /* 降级: getCliCtxUsage 返回 0/1M */ }
  const initialStatus = `${C_ACCENT}${cliModelName}${RESET}${C_DIM}  │${RESET} ${cliAgentName} ${C_DIM}│${RESET} ⏱ 0s${C_DIM} │${RESET} ${buildContextBar(getCliCtxUsage())}`;
  startInk(
    (text: string) => { processInput(text, comm); },
    initialStatus,
    getStatus,
  );

  // 2026-08-10: 自动整理心跳 (CLI 侧, 与社交心跳并列) — 启动后立即"固定看一下 skills view"
  //   (扫描遗留 skills), 之后按周期 (默认 30min, env BOLLOON_ORGANIZE_HEARTBEAT_MS) 完整进化经验.
  //   显示走 transient 颜文字行: 触发时显示, 结束后清空 (显示为空).
  try {
    const { startOrganizeHeartbeat } = await import('./agents/skill-organizer.js');
    let firstOrganizeScan = true; // 启动第一轮只做快速遗留扫描 (无 LLM), 不阻塞启动
    cliOrganizeHeartbeat = startOrganizeHeartbeat({
      intervalMs: Number(process.env.BOLLOON_ORGANIZE_HEARTBEAT_MS) || 30 * 60_000,
      onStart: () => inkSetTransient(`${C_DIM}(｀・ω・´) 自动整理经验中...${RESET}`),
      onEnd: (r) => {
        inkSetTransient(null); // 结束后去除显示效果 (显示为空)
        // 2026-08-10: 整理结果统一进 bolloon 艺术字框 (renderMessageBox 圆角框, 与反思框同款)
        const boxLines: string[] = [];
        if (r && r.leftovers.length > 0) {
          boxLines.push(`🧹 遗留 skills (${r.leftovers.length}): ${r.leftovers.slice(0, 8).map(l => l.name).join(', ')}${r.leftovers.length > 8 ? ' ...' : ''}`);
        }
        if (r && r.evolved.length > 0) {
          boxLines.push(`✨ 经验进化: ${r.evolved.join(', ')}`);
        }
        // 知识层整理汇总 (Context OS/社交/智能体/judgeness/项目/画像/日志/目标)
        const kSections = (r?.knowledge?.sections || []).filter(s => s.handled > 0 || s.error);
        if (kSections.length > 0) {
          boxLines.push(`🧠 知识整理: ${kSections.map(s => s.error ? `${s.label}✗` : `${s.label}✓`).join(' ')}`);
        }
        if (boxLines.length > 0) {
          appendLine(renderMessageBox({ title: '自动整理完成', body: boxLines.join('\n'), color: C_ACCENT, maxLines: 10 }));
        }
      },
      onError: () => inkSetTransient(null),
      run: async () => {
        // 启动第一轮 (firstOrganizeScan=true) 只做快速扫描 — 不拿 LLM, 立即执行.
        // 后续周期轮才取 agent LLM 做完整经验进化 (2026-08-10: getAgent 在无 LLM 环境可能
        //   长时间挂起 → 8s 超时降级为仅扫描)
        let llm: ((p: string) => Promise<string>) | undefined;
        const needEvolve = !firstOrganizeScan;
        if (needEvolve) {
          try {
            const a = await Promise.race([
              getAgent().catch(() => null),
              new Promise<null>((res) => setTimeout(() => res(null), 8000)),
            ]);
            if (a && typeof (a as any).promptStream === 'function') {
              llm = (p: string) => (a as any).promptStream(p, () => {}, undefined, cliActiveChannelId || undefined);
            }
          } catch { /* 无 agent → 仅扫描 */ }
        }
        const { runAutoOrganize } = await import('./agents/skill-organizer.js');
        const evolve = needEvolve && !!llm;
        firstOrganizeScan = false;
        return runAutoOrganize({ llm, source: 'cli:organize-heartbeat', evolve });
      },
    });
    // 启动即跑一轮: 每次打开后固定看一下 skills view (遗留扫描, 快, 不阻塞)
    // 延迟 3s 等 Ink 挂载完成 (global __inkAppend/__inkSetTransient 注册) — 否则首轮显示丢失
    setTimeout(() => { cliOrganizeHeartbeat?.runOnce().catch(() => {}); }, 3000);
  } catch { /* 自动整理启动失败不阻塞 CLI */ }

  // ==================== 2026-08-11: cron 调度心跳 (借鉴 Hermes cron/scheduler.py) ====================
  // 轻量定时任务: 每隔一段时间扫一次 due 的 job, 把 job.prompt 投给 agent 执行.
  // 不阻塞启动, 失败不崩溃 (各自 try/catch), 继承 organize heartbeat 的"静默降级"心智.
  let cliCronTimer: NodeJS.Timeout | null = null;
  try {
    const { Scheduler } = await import('./cron/scheduler.js');
    const cronScheduler = new Scheduler({
      now: () => new Date(),
      exec: async (job) => {
        // 借 agent 执行任务 prompt (脱壳为 text 提示). 无 agent / 超时 / 失败 → 抛出交给 scheduler 记录失败
        const a = await Promise.race([
          await getAgent().catch(() => null),
          new Promise<null>((res) => setTimeout(() => res(null), 8000)),
        ]).catch(() => null);
        if (!a || typeof (a as any).promptStream !== 'function') {
          throw new Error('无可用 agent, 跳过调度任务');
        }
        await (a as any).promptStream?.(`[cron] ${job.name}: ${job.prompt}`, () => {}, undefined, cliActiveChannelId || undefined);
      },
    });
    const cronIntervalMs = Number(process.env.BOLLOON_CRON_HEARTBEAT_MS) || 60_000;
    cliCronTimer = setInterval(() => {
      cronScheduler.tick().catch((e: any) => {
        console.error('[cron] 调度心跳失败 (不影响主流程):', e?.message ?? e);
      });
    }, cronIntervalMs);
    // 启动延迟一轮, 避开启动峰值
    setTimeout(() => { cronScheduler.tick().catch(() => {}); }, 15_000);
  } catch { /* cron 调度启动失败不阻塞 CLI */ }

  // Wait on a promise that resolves on Ctrl+C / 双击 Esc
  // (ink-app 的 requestExit 调 __inkRequestExit → resolve, 清理后 process.exit)
  let cliExitResolve: () => void = () => {};
  const exitPromise = new Promise<void>(resolve => { cliExitResolve = resolve; });
  (globalThis as any).__inkRequestExit = () => { cliExitResolve(); };
  await exitPromise;
  delete (globalThis as any).__inkRequestExit;
  stopInk();
  appendLine(`\n${CYAN}👋 再见！${RESET}`);
  try { cliOrganizeHeartbeat?.stop(); } catch { /* 非致命 */ }
  if (cliCronTimer) clearInterval(cliCronTimer);
  comm.stop();
  process.exit(0);
}

async function processInput(input: string, comm: HyperswarmCommunicator): Promise<void> {
  const trimmed = input.trim();
  // TUI tool call state (local to this invocation)
  const tuiToolCalls: Array<{ tool: string; args: any; _t: number }> = [];
  let tuiToolCounter = 0;
  // run-end 经验整理: 收集本轮连续成功的工具 (≥2 个自动写候选, 颜文字加载)
  const runEndOkSteps: Array<{ status: string; name: string; output?: string }> = [];
  // each iteration
  let lastToolEvent: { tool: string; args: any } | null = null;

  // !command — 直接执行终端命令. 2026-08-12 (Task4): 支持多命令 (&& / ;) 逐段顺序执行 + 加载显示.
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    if (!cmd) { appendLine(`${C_DIM}!<命令> 执行终端命令 (支持 && 串联多命令), 如 !ls -la${RESET}`); return; }
    const { execSync } = await import('child_process');
    // 拆成多段: && 逻辑与 (前失败则停) / ; 无条件顺序. 保留每段顺序执行, 显示加载态.
    const segments = cmd.split(/\s*;\s*/).filter(Boolean);
    try {
      for (const seg of segments) {
        const segCmds = seg.split(/\s*&&\s*/).filter(Boolean);
        for (const c of segCmds) {
          appendLine(`${C_DIM}── $ ${c}${RESET}`);
          try {
            const out = execSync(c, { timeout: 30000, encoding: 'utf-8', cwd: process.cwd() });
            appendLine(`${C_DIM}${out || '(无输出)'}${RESET}`);
          } catch (e: any) {
            appendLine(`${C_ERROR}${e.stderr || e.message}${RESET}`);
            // && 逻辑与: 某段失败则中止后续 && 段
            break;
          }
        }
      }
    } finally {
      appendLine(`${C_DIM}──${RESET}`);
    }
    return;
  }

  // /channel — 切换当前智能体 (agent channel), 参数 name/id/number 自动解析
  if (trimmed.toLowerCase().startsWith('/channel')) {
    const q = trimmed.slice('/channel'.length).trim();
    try {
      const { getIdentityStore } = await import('./agents/agent-identity-store.js');
      const store = getIdentityStore();
      await store.load();
      if (!q) {
        // 无参: 列出所有 channel + active
        const list = await store.listForDisplay();
        const active = await store.getActive();
        if (list.length === 0) { appendLine(`${C_DIM}暂无智能体 channel (channels.json 为空)${RESET}`); return; }
        appendLine(`${C_ACCENT}智能体列表:${RESET} (${active ? `当前: ${active.name}` : ''})`);
        for (const { index, identity, active: isActive } of list) {
          const mark = isActive ? '●' : '○';
          appendLine(`  ${mark} ${index}. ${identity.name}  ${C_DIM}${identity.id.slice(0, 24)}${RESET}`);
        }
        appendLine(`${C_DIM}用法: /channel <名字|id|序号>${RESET}`);
        return;
      }
      const r = await store.resolve(q);
      if (!r) {
        appendLine(`${C_ERROR}未找到智能体: '${q}'${RESET} (可用 /channel 查看列表)`);
        return;
      }
      const prev = await store.getActive();
      await store.setActive(r.channel.id);
      cliAgentName = r.identity.name;
      cliActiveChannelId = r.channel.id;
      cliAgentId = r.channel.agentId || null; // 2026-08-12: memory 路径一致
      // 2026-08-09: 切 channel 必须重建 agent session — 否则身份/记忆停留在旧 channel (bug 修复)
      invalidateAgent();
      // 立即重建 (提前建好, 避免下次输入才卡顿; 失败不阻塞切换)
      try { await getAgent(); } catch { /* 非致命, 下次输入时再试 */ }
      inkSetStatus(getStatus()); // 触发状态栏立即重绘 (无需等 1s 定时器)
      const extra = prev && prev.name !== r.identity.name ? ` (从 ${prev.name} 切换)` : '';
      appendLine(`${C_ACCENT}→ 当前智能体: ${r.identity.name}${RESET}${extra}`);
      appendLine(`${C_DIM}  channel: ${r.channel.id}  [${r.match}]${RESET}`);
      appendLine(`${C_DIM}  persona: ${r.channel.persona?.description || r.channel.persona?.personality || '无'}${RESET}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/channel 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /new agent <名字> — 创建新智能体 channel (2026-08-08)
  if (trimmed.toLowerCase().startsWith('/new agent')) {
    const q = trimmed.slice('/new agent'.length).trim();
    if (!q) {
      appendLine(`${C_DIM}用法: /new agent <名字> — 新建一个智能体 channel 并切换过去${RESET}`);
      return;
    }
    try {
      const [name, ...rest] = q.split(/\s+/);
      const personaHint = rest.join(' ').trim();
      const { getIdentityStore } = await import('./agents/agent-identity-store.js');
      const store = getIdentityStore();
      await store.load();
      // 2026-08-09: 复用 server-storage updateChannels 原子写 (互斥锁) — 旧实现裸 readFile→push→writeFile
      //   与 Web server 并发写 channels.json 互相覆盖 → 创建的 agent 重启后丢失 (bug 修复)
      const { updateChannels } = await import('./web/server-storage.js');
      const dupName = store.rawChannels.find((c: any) => c.name === name.trim());
      if (dupName) {
        appendLine(`${C_ERROR}同名智能体已存在: '${dupName.name}' (id=${dupName.id})${RESET}`);
        return;
      }
      const id = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const agentId = `agent-${name.trim().toLowerCase().replace(/\s+/g, '-')}`;
      const ch: any = {
        id,
        name: name.trim(),
        agentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentSessionId: 'default',
      };
      if (personaHint) ch.persona = { name: name.trim(), description: personaHint };
      // 2026-08-09: 立即生成该 agent 的持久 DID 身份 (agent-keys/<agentId>.json) —
      //   与 server fixOneChannelDID 对齐, 保证 CLI 新建的 agent 身份稳定且归属用户 DID
      try {
        const { loadOrCreateAgentIdentity } = await import('./agents/agent-identity.js');
        const idt = loadOrCreateAgentIdentity(agentId);
        ch.did = idt.did;
        ch.publicKey = idt.publicKey;
      } catch { /* DID 生成失败不阻塞创建 */ }
      const channels = await updateChannels((chs) => [...chs, ch]);
      // 2026-08-12 (TaskFix): CLI 创建的 agent 同步写 agents.json + 关联 channelId —
      //   与 server 创建 channel 逻辑对齐. 否则 CLI 创建的 agent 不在 agents.json,
      //   重启后 server 的 healMissingChannels 只能从 agents.json 恢复 → 该 agent 永远消失.
      try {
        const agentsPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'agents', 'agents.json');
        await fs.mkdir(path.dirname(agentsPath), { recursive: true });
        let arr: any[] = [];
        try { arr = JSON.parse(await fs.readFile(agentsPath, 'utf-8')); } catch {}
        if (!Array.isArray(arr)) arr = [];
        const exists = arr.find((a: any) => a && a.id === agentId);
        if (exists) {
          exists.channelId = id;
          exists.name = name.trim();
          exists.lastActive = new Date().toISOString();
        } else {
          arr.push({
            id: agentId,
            name: name.trim(),
            did: `did:local:${id}`,
            description: `Agent ${name} (auto-registered from channel ${id})`,
            status: 'active',
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            channelId: id,
          });
        }
        await fs.writeFile(agentsPath, JSON.stringify(arr, null, 2), 'utf-8');
        console.log(`[创建频道] agent 同步进 agents.json: ${agentId} → channel ${id}`);
      } catch { /* agents.json 写失败不阻塞创建 */ }
      // 刷新 store 缓存 (updateChannels 走了 server-storage, store 内存还是旧的)
      await store.load();
      await store.setActive(id);
      cliAgentName = name.trim();
      cliActiveChannelId = id;
      cliAgentId = agentId; // 2026-08-12: memory 路径一致
      // 2026-08-09: 新建 agent 后立即重建 session — 否则新 agent 身份不加载 (bug 修复)
      invalidateAgent();
      try { await getAgent(); } catch { /* 非致命 */ }
      inkSetStatus(getStatus());
      appendLine(`${C_OK}✓ 已创建智能体 channel: ${name.trim()}${RESET} (${C_DIM}${id}${RESET})${personaHint ? `\n  ${C_DIM}persona: ${personaHint}${RESET}` : ''}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/new agent 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /new session — 当前 channel 开新会话 (2026-08-08)
  if (trimmed.toLowerCase() === '/new session') {
    try {
      const { readFile, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      const home = process.env.HOME || '/tmp';
      const channelsPath = join(home, '.bolloon', 'sessions', 'channels.json');
      const newSessionId = `sess_${Date.now()}`;
      let saved = false;
      try {
        const parsed = JSON.parse(await readFile(channelsPath, 'utf-8'));
        const channels: any[] = Array.isArray(parsed) ? parsed : parsed?.channels || [];
        for (const c of channels) {
          if (cliActiveChannelId && c.id === cliActiveChannelId) { c.currentSessionId = newSessionId; saved = true; }
          else if (!cliActiveChannelId && c.id === channels[0]?.id) { c.currentSessionId = newSessionId; saved = true; }
        }
        await writeFile(channelsPath, JSON.stringify(Array.isArray(parsed) ? channels : { ...parsed, channels }, null, 2), 'utf-8');
      } catch { /* 无 channels.json → 仅提示 */ }
      // 重置 agent 消息历史 (新会话空窗口)
      try {
        const a = await getAgent();
        if (a && (a as any).messageHistory) (a as any).messageHistory = [];
      } catch { /* 非致命 */ }
      appendLine(`${C_OK}✓ 已新建会话${RESET} session=${C_DIM}${newSessionId}${RESET}${saved ? ` (channel: ${cliActiveChannelId || 'default'})` : ''}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/new session 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /queue — 切换队列模式
  if (trimmed.toLowerCase() === '/queue') {
    queueMode = !queueMode;
    appendLine(`${C_WARN}队列 ${queueMode ? '开启' : '关闭'}${RESET} (${pendingQueue.length} 条)`);
    return;
  }

  // /dequeue — 出队一条
  if (trimmed.toLowerCase() === '/dequeue' || trimmed.toLowerCase() === '/dq') {
    const next = pendingQueue.shift();
    if (next) appendLine(`${C_WARN}出队:${RESET} ${next}`);
    else appendLine(`${C_DIM}队列为空${RESET}`);
    return;
  }

  // 队列模式: 入队
  if (queueMode) {
    pendingQueue.push(trimmed);
    appendLine(`${C_WARN}[${pendingQueue.length}]${RESET} 已入队`);
    return;
  }

  // 队列非空: 也入队末尾 (排队执行)
  if (pendingQueue.length > 0) {
    pendingQueue.push(trimmed);
    appendLine(`${C_WARN}[队列 ${pendingQueue.length}]${RESET} 已入队, 执行完当前后自动运行`);
    return;
  }

  // ==================== 2026-08-06: 系统命令组 (/model /now /ipfs /memory ...) ====================
  const cmd = trimmed.toLowerCase();

  // /model — 模型供应商选择器 (ink 交互渲染, 复用 MentionPopup)
  if (cmd === '/model') {
    try {
      const { llmConfigStore, PROVIDER_INFO } = await import('./llm/config-store.js');
      await llmConfigStore.initialize();
      const config = await llmConfigStore.getConfig();
      const items = Object.entries(config.providers).map(([name, p]) => ({
        kind: 'command' as const,
        label: name,
        hint: `${String((PROVIDER_INFO as any)[name]?.name || '').padEnd(14)} ${p.apiKey ? '🔑' : p.requiresApiKey ? '⚠ 无key' : ''}  ${p.model || ''}`,
        insert: name,
      }));
      (globalThis as any).__inkOpenPicker?.(items, '选择模型供应商 (↑↓ 选择 · Enter 确认 · Esc 取消)', async (it: any) => {
        try {
          await llmConfigStore.setActiveProvider(it.label as any);
          const active = await llmConfigStore.getActiveProvider();
          appendLine(`${C_OK}✓ 已切换到 ${it.label} (${String((PROVIDER_INFO as any)[it.label]?.name || '')})${RESET}`);
          appendLine(`${C_DIM}  当前模型: ${config.providers[it.label as keyof typeof config.providers]?.model || '默认'}${RESET}`);
        } catch (e: any) {
          appendLine(`${C_ERROR}✗ 切换失败: ${String(e.message || e).slice(0, 150)}${RESET}`);
        }
      });
    } catch (e: any) {
      appendLine(`${C_ERROR}/model 失败: ${String(e.message || e).slice(0, 150)}${RESET}`);
    }
    return;
  }

  // /login — GitHub / Google 账号登录骨架 (2026-08-08, 无真实 OAuth, 先做选择 + 记录)
  if (cmd === '/login') {
    try {
      const { readFile, writeFile, mkdir } = await import('fs/promises');
      const { join } = await import('path');
      const home = process.env.HOME || '/tmp';
      const accPath = join(home, '.bolloon', 'accounts.json');
      let accs: any[] = [];
      try { const parsed = JSON.parse(await readFile(accPath, 'utf-8')); accs = Array.isArray(parsed) ? parsed : []; } catch { /* 无 */ }
      const gh = accs.filter((a: any) => a.provider === 'github');
      const gg = accs.filter((a: any) => a.provider === 'google');
      const items = [
        { kind: 'command' as const, label: 'GitHub', hint: gh.length ? `已登录 ${gh.length} 个账号` : '未登录', insert: 'GitHub' },
        { kind: 'command' as const, label: 'Google', hint: gg.length ? `已登录 ${gg.length} 个账号` : '未登录', insert: 'Google' },
      ];
      (globalThis as any).__inkOpenPicker?.(items, '登录账号 (骨架) · 选择服务 · Esc 取消', async (it: any) => {
        const provider = it.label.toLowerCase();
        try {
          const existing = accs.find((a: any) => a.provider === provider);
          if (existing) {
            appendLine(`${C_OK}✓ ${it.label}: 已登录${RESET} 账号=${existing.username || existing.email || '?'} (${existing.loggedAt || ''})`);
            appendLine(`  ${C_DIM}token: ${existing.token ? '已保存' : '无'} (未做真实 OAuth, 仅骨架)${RESET}`);
            return;
          }
          // 骨架: 记录一个占位账号 (真实 OAuth 后续接入, 在此扩展)
          const entry = { provider, username: `user-${provider}`, email: '', token: '', loggedAt: new Date().toISOString(), skeleton: true };
          accs.push(entry);
          await mkdir(join(home, '.bolloon'), { recursive: true });
          await writeFile(accPath, JSON.stringify(accs, null, 2), 'utf-8');
          appendLine(`${C_OK}✓ ${it.label} 登录骨架已记录 (未做真实 OAuth)${RESET}`);
          appendLine(`  ${C_DIM}后续接入: 这里会打开浏览器授权并交换 token${RESET}`);
        } catch (e: any) {
          appendLine(`${C_ERROR}✗ /login 失败: ${String(e.message || e).slice(0, 150)}${RESET}`);
        }
      });
    } catch (e: any) {
      appendLine(`${C_ERROR}/login 失败: ${String(e.message || e).slice(0, 150)}${RESET}`);
    }
    return;
  }

  // /logout — 显示当前供应商 (减法: 登出 = 查看当前, 切换走 /model)
  if (cmd === '/logout') {
    try {
      const { llmConfigStore, PROVIDER_INFO } = await import('./llm/config-store.js');
      await llmConfigStore.initialize();
      const active = await llmConfigStore.getActiveProvider();
      const cfg = await llmConfigStore.getActiveProviderConfig();
      appendLine(`${C_DIM}当前供应商:${RESET} ${C_ACCENT}${active}${RESET} (${String((PROVIDER_INFO as any)[active]?.name || '')})`);
      appendLine(`${C_DIM}  模型: ${cfg?.model || '默认'}${RESET}`);
      appendLine(`${C_DIM}  切换: /model 打开选择器${RESET}`);
    } catch { /* 静默 */ }
    return;
  }

  // /now — 当前状态总览
  if (cmd === '/now') {
    try {
      const cm = require('./bootstrap/context-manager.js').getContextManager();
      const usage = cm.getUsage();
      appendLine(`${C_ACCENT}● 当前状态${RESET}`);
      appendLine(`  ${C_DIM}智能体:${RESET} ${cliAgentName} ${cliActiveChannelId ? `(${C_DIM}ch:${cliActiveChannelId.slice(0, 12)}${RESET})` : ''}`);
      appendLine(`  ${C_DIM}运行:${RESET} ${fmtDuration(Date.now() - cliStartTime)}`);
      appendLine(`  ${C_DIM}上下文:${RESET} ${(usage.usedTokens / 1000).toFixed(0)}k / ${(usage.maxTokens / 1000).toFixed(0)}k tokens (${Math.round(usage.pct * 100)}%)${usage.stage === 'warning' ? ` ${C_WARN}⚠ 即将压缩${RESET}` : ''}`);
      const a = await getAgent();
      appendLine(`  ${C_DIM}消息:${RESET} ${(a as any).messageHistory?.length ?? 0} 条`);
    } catch { /* 静默 */ }
    return;
  }

  // /tools — 可用工具列表 (2026-08-08: 读 getToolList, 显示名 + 参数)
  if (cmd === '/tools') {
    try {
      const a = await getAgent();
      const list = (a as any).getToolList?.() ?? [];
      appendLine(`${C_ACCENT}可用工具 (${list.length}):${RESET}`);
      if (list.length === 0) { appendLine(`  ${C_DIM}无 (agent 未初始化工具列表)${RESET}`); }
      for (const t of list.slice(0, 40)) {
        const params = Array.isArray(t.parameters) && t.parameters.length > 0 ? `(${t.parameters.join(',')})` : '';
        const desc = t.description ? `  ${C_DIM}${String(t.description).split('\n')[0].slice(0, 40)}${RESET}` : '';
        appendLine(`  ${C_DIM}·${RESET} ${t.name}${params}${desc}`);
      }
      if (list.length > 40) appendLine(`  ${C_DIM}... 共 ${list.length} 个${RESET}`);
    } catch { /* 静默 */ }
    return;
  }

  // /suggestions — 建议队列 (/suggestions [list|accept <n>|dismiss <n>|clear|catalog|install <key>])
  // 借鉴 Hermes cron/suggestions.py: 有界待办建议, dedup + 用户消费
  if (cmd === '/suggestions' || cmd.startsWith('/suggestions ')) {
    try {
      const { handleSuggestionsCommand } = await import('./cron/suggestions-command.js');
      const res = await handleSuggestionsCommand(trimmed.slice('/suggestions'.length));
      appendLine(`${C_ACCENT}◎ 建议${RESET}`);
      appendLine(res.text);
    } catch (e: any) {
      appendLine(`${C_ERROR}✗ /suggestions 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /cron — 定时任务 (/cron list | add <name> <schedule> <prompt> | rm <id> | on/off <id>)
  // 借鉴 Hermes cron/scheduler.py: 轻量单文件定时任务 + 调度 tick
  if (cmd === '/cron' || cmd.startsWith('/cron ')) {
    const { listJobs, addJob, removeJob, setEnabled } = await import('./cron/jobs-store.js');
    const { parseSchedule } = await import('./cron/cron-parser.js');
    const parts = trimmed.slice('/cron'.length).trim().split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() ?? 'list';
    try {
      if (action === 'list') {
        const jobs = await listJobs();
        if (jobs.length === 0) {
          appendLine(`${C_ACCENT}⏱ 定时任务${RESET}${C_DIM} 空 — 用 /cron add <名称> '<schedule>' <prompt> 添加${RESET}`);
          appendLine(`${C_DIM}  示例: /cron add 每日复盘 '0 18 * * *' 总结今天工作并写进 wiki${RESET}`);
        } else {
          appendLine(`${C_ACCENT}⏱ 定时任务 (${jobs.length}):${RESET}`);
          for (const j of jobs) {
            const next = (() => { try { return parseSchedule(j.schedule)?.next.toISOString(); } catch { return null; } })();
            appendLine(`  ${j.enabled ? C_ACCENT + '●' + RESET : C_DIM + '○' + RESET} [${C_DIM}${j.id.slice(0, 8)}${RESET}] ${j.name} ${C_DIM}· ${j.schedule}${RESET}`);
            appendLine(`    ${C_DIM}prompt: ${j.prompt.slice(0, 60)}${RESET}`);
            if (next) appendLine(`    ${C_DIM}下次: ${next} · 已跑 ${j.runCount} 次${RESET}`);
          }
        }
      } else if (action === 'add') {
        // 参数: <name> <schedule> <prompt...> — name 可能带空格, 用引号/斜杠分隔
        const m = trimmed.slice('/cron'.length).trim().match(/^add\s+(.*?)\s+'([^']+)'?\s+(.*)$/);
        if (!m || !parseSchedule(m[2])) {
          appendLine(`${C_WARN}用法: /cron add <名称> '<schedule>' <prompt>${RESET}`);
        } else {
          const job = await addJob({ name: m[1], schedule: m[2], prompt: m[3] }, os.homedir());
          appendLine(`${C_OK}✓ 已创建任务 ${job.name} (${job.schedule})${RESET}`);
        }
      } else if (action === 'rm') {
        const ok = await removeJob(parts[1], os.homedir());
        appendLine(`${ok ? C_OK + '✓' + RESET + ' 已删除' : C_ERROR + '✗ 未找到' + RESET} 任务 ${parts[1] ?? ''}`);
      } else if (action === 'on' || action === 'off') {
        const en = action === 'on';
        const j = await setEnabled(parts[1], en, os.homedir());
        appendLine(j ? `${C_OK}✓ ${en ? '启用' : '停用'} ${j.name}${RESET}` : `${C_ERROR}✗ 未找到 ${parts[1]}${RESET}`);
      } else {
        appendLine(`${C_DIM}用法: /cron list | add | rm <id> | on/off <id>${RESET}`);
      }
    } catch (e: any) {
      appendLine(`${C_ERROR}✗ /cron 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /session — 当前会话信息
  if (cmd === '/session') {
    try {
      const a = await getAgent();
      const h = (a as any).messageHistory ?? [];
      appendLine(`${C_ACCENT}会话:${RESET}`);
      appendLine(`  ${C_DIM}channel:${RESET} ${(a as any).currentChannelId || '—'}`);
      appendLine(`  ${C_DIM}agent:${RESET} ${(a as any).currentAgentId || '—'}`);
      appendLine(`  ${C_DIM}消息:${RESET} ${h.length} 条 (${h.length > 15 ? `${h.length - 15} 条已压缩` : '窗口内'})`);
    } catch { /* 静默 */ }
    return;
  }

  // /memory — 记忆摘要 (memory-compressor 落盘文件)
  if (cmd === '/memory') {
    try {
      const { getMemoryDir } = await import('./bootstrap/memory-compressor.js');
      const { readdir, readFile } = await import('fs/promises');
      const { join } = await import('path');
      const dir = getMemoryDir(getCliAgentId());
      const files = (await readdir(join(dir, 'sessions')).catch(() => [])).filter((f: string) => f.endsWith('.summary.md'));
      appendLine(`${C_ACCENT}记忆摘要 (${files.length} 个 session):${RESET}`);
      for (const f of files.slice(-5)) {
        try {
          const raw = await readFile(join(dir, 'sessions', f), 'utf-8');
          const tail = raw.trim().split('\n').slice(-6).join(' ').slice(0, 180);
          appendLine(`  ${C_DIM}·${RESET} ${f.replace('.summary.md', '').slice(-30)}`);
          appendLine(`    ${C_DIM}${tail}${RESET}`);
        } catch { /* 跳过 */ }
      }
    } catch { /* 静默 */ }
    return;
  }

  // /resume — 恢复: 最近记忆摘要 + 进行中计划
  if (cmd === '/resume' || cmd.startsWith('/resume ')) {
    try {
      const { getMemoryDir } = await import('./bootstrap/memory-compressor.js');
      const { readFile, readdir } = await import('fs/promises');
      const { join } = await import('path');
      const dir = getMemoryDir(getCliAgentId());
      const files = (await readdir(join(dir, 'sessions')).catch(() => [])).filter((f: string) => f.endsWith('.summary.md'));
      appendLine(`${C_ACCENT}↻ 恢复上下文:${RESET}`);
      if (files.length > 0) {
        const f = files[files.length - 1];
        const raw = await readFile(join(dir, 'sessions', f), 'utf-8');
        const block = raw.trim().split('\n').slice(-12).join('\n').slice(-1200);
        appendLine(`  ${C_DIM}最近记忆 (${f.slice(0, 24)}...):${RESET}`);
        for (const line of block.split('\n').slice(-8)) appendLine(`  ${C_DIM}${line.slice(0, 100)}${RESET}`);
      } else {
        appendLine(`  ${C_DIM}暂无记忆摘要${RESET}`);
      }
      const { listActivePlans } = await import('./agents/plan-store.js');
      const plans = await listActivePlans();
      if (plans.length > 0) {
        appendLine(`  ${C_DIM}进行中计划 (${plans.length}):${RESET}`);
        for (const p of plans.slice(0, 3)) appendLine(`  ${C_ACCENT}·${RESET} ${(p as any).goal || (p as any).planId} ${C_DIM}${(p as any).status || ''}${RESET}`);
      }
    } catch { /* 静默 */ }
    return;
  }

  // /goal — 进行中的目标/计划; /goal <文本> 设定新目标并触发循环 (2026-08-08)
  if (cmd === '/goal') {
    try {
      const { listActivePlans } = await import('./agents/plan-store.js');
      const plans = await listActivePlans();
      appendLine(`${C_ACCENT}目标 (${plans.length} 个进行中):${RESET}`);
      if (plans.length === 0) { appendLine(`  ${C_DIM}无进行中计划 — 可用 /goal <目标> 设定 或 /plan 创建${RESET}`); }
      for (const p of plans.slice(0, 5)) {
        appendLine(`  ${C_ACCENT}●${RESET} ${(p as any).goal || (p as any).planId} ${C_DIM}[${(p as any).status || 'active'}]${RESET}`);
        const steps = Array.isArray((p as any).steps) ? (p as any).steps : [];
        const done = steps.filter((s: any) => s.done || s.status === 'done').length;
        if (steps.length > 0) appendLine(`    ${C_DIM}${done}/${steps.length} 步完成${RESET}`);
      }
    } catch { /* 静默 */ }
    return;
  }
  if (cmd.startsWith('/goal ')) {
    const q = trimmed.slice('/goal '.length).trim();
    try {
      const { createPlan } = await import('./agents/plan-store.js');
      const r = await createPlan({ goal: q, steps: [q], createdBy: 'user', originChannel: cliActiveChannelId || 'cli' });
      if (!r.ok || !r.plan) { appendLine(`${C_ERROR}/goal 设定失败: ${r.error || '未知'}${RESET}`); return; }
      appendLine(`${C_OK}✓ 目标已设定: ${C_ACCENT}${q}${RESET} (${C_DIM}plan ${r.plan.planId}${RESET})`);
      // 触发自我改进循环 (沙箱分支, 输出供用户审)
      const { runSelfImproveLoop } = await import('./agents/pi-sdk-session-factory.js');
      const loop = await runSelfImproveLoop(q).catch(() => ({ success: false, error: '未启动' }));
      if (loop.success) appendLine(`  ${C_DIM}${(loop as any).output}${RESET}`);
      else appendLine(`  ${C_WARN}⚠ 循环未启动: ${loop.error}${RESET}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/goal 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /plan — 循环过程工具: 创建/查看计划 (2026-08-08)
  //   /plan <目标> :: <步骤1> | <步骤2> ...  创建
  //   /plan                         查看进行中
  if (cmd.startsWith('/plan ')) {
    const q = trimmed.slice('/plan '.length).trim();
    const [goalText, ...rest] = q.split('::');
    const stepsFlat = rest.length > 0 ? rest[0] : '';
    const steps = stepsFlat ? stepsFlat.split(/\s*[|｜]\s*/).map(s => s.trim()).filter(Boolean) : [goalText].filter(Boolean);
    try {
      const { createPlan } = await import('./agents/plan-store.js');
      const r = await createPlan({ goal: goalText || q, steps: steps.length ? steps : [goalText], createdBy: 'user', originChannel: cliActiveChannelId || 'cli' });
      if (!r.ok || !r.plan) { appendLine(`${C_ERROR}/plan 创建失败: ${r.error || '未知'}${RESET}`); return; }
      appendLine(`${C_OK}✓ 计划已创建: ${C_ACCENT}${r.plan.goal}${RESET} (${C_DIM}${r.plan.planId} · ${r.plan.steps.length} 步${RESET})`);
      for (const s of r.plan.steps) appendLine(`  ${C_DIM}· ${s.description}${RESET}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/plan 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /todo — 循环过程工具: 查看/勾选步骤 (2026-08-08)
  if (cmd === '/todo') {
    try {
      const { listActivePlans } = await import('./agents/plan-store.js');
      const plans = await listActivePlans();
      if (plans.length === 0) { appendLine(`${C_DIM}无进行中计划 — 可用 /plan <目标> 创建${RESET}`); return; }
      for (const p of plans.slice(0, 3)) {
        appendLine(`${C_ACCENT}● ${p.goal}${RESET} ${C_DIM}[${p.status || 'active'}]${RESET}`);
        const steps = Array.isArray(p.steps) ? p.steps : [];
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          const done = (s as any).status === 'done' || (s as any).done;
          appendLine(`  ${done ? '✓' : '○'} ${i + 1}. ${(s as any).description || ''}${done ? '' : `  ${C_DIM}/todo ${p.planId} ${i + 1} 勾选${RESET}`}`);
        }
      }
    } catch { /* 静默 */ }
    return;
  }
  if (/^\/todo\s+\S+\s+\d+/.test(trimmed.toLowerCase())) {
    const parts = trimmed.split(/\s+/);
    const planId = parts[1];
    const idx = parseInt(parts.slice(2).join(' ').trim(), 10) - 1 || 0;
    try {
      const { loadPlan, updatePlan } = await import('./agents/plan-store.js');
      const plan = await loadPlan(planId);
      if (!plan) { appendLine(`${C_ERROR}/todo 失败: plan '${planId}' 不存在${RESET}`); return; }
      const step = plan.steps[idx];
      if (!step) { appendLine(`${C_ERROR}/todo 失败: 无第 ${idx + 1} 步${RESET}`); return; }
      await updatePlan(planId, { stepId: step.id, status: 'done' });
      const done = plan.steps.filter(s => s.status === 'done' || (s as any).done).length + 1;
      const total = plan.steps.length;
      const allDone = done >= total;
      appendLine(`${C_OK}✓ 勾选 ${idx + 1}. ${(step as any).description}${RESET} (${done}/${total})${allDone ? `\n  ${C_ACCENT}🎯 循环达到完成标准, 可以 review 结束: /review ${planId}${RESET}` : ''}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/todo 失败: ${String(e.message || e).slice(0, 150)}${RESET}`);
    }
    return;
  }

  // /skill — 技能候选 (skill-writer 落盘)
  if (cmd === '/skill') {
    try {
      const { listSkillCandidates } = await import('./agents/skill-writer.js');
      const cands = await listSkillCandidates();
      appendLine(`${C_ACCENT}技能候选 (${cands.length}):${RESET}`);
      if (cands.length === 0) { appendLine(`  ${C_DIM}无候选 — 连续成功工具调用 ≥2 自动生成${RESET}`); }
      for (const c of cands.slice(0, 8)) {
        appendLine(`  ${C_DIM}·${RESET} ${c.name || '?'} ${C_DIM}(${c.source || ''})${RESET}`);
      }
    } catch { /* 静默 */ }
    return;
  }

  // /skills [名] — 查看正式技能 (2026-08-12 Task5): 无参列全部, 带名看详情. 运行时开始前的技能 view.
  if (cmd === '/skills' || cmd.startsWith('/skills ')) {
    try {
      const { defaultSkillPaths, loadSkillsDir } = await import('./agents/skill-loader.js');
      const dirs = defaultSkillPaths();
      const metas: Array<{ name: string; description: string; status: string; triggers: string[]; body: string }> = [];
      for (const d of dirs) {
        const m = await loadSkillsDir(d);
        for (const s of m) if (s.status === 'active' && !metas.some(x => x.name === s.name)) metas.push(s as any);
      }
      const q = cmd.startsWith('/skills ') ? cmd.slice('/skills '.length).trim().toLowerCase() : '';
      if (!q) {
        appendLine(`${C_ACCENT}技能 (${metas.length}):${RESET}`);
        if (metas.length === 0) appendLine(`  ${C_DIM}暂无正式技能 — run-end 经验可沉淀为 skill${RESET}`);
        for (const s of metas.slice(0, 20)) {
          const desc = (s.description || '').slice(0, 60);
          appendLine(`  ${C_DIM}·${RESET} ${C_ACCENT}${s.name}${RESET}${desc ? `  ${C_DIM}${desc}${RESET}` : ''}`);
        }
        appendLine(`${C_DIM}用法: /skills <名> 查看详情${RESET}`);
      } else {
        const hit = metas.find(s => s.name.toLowerCase() === q || s.name.toLowerCase().includes(q));
        if (!hit) { appendLine(`${C_WARN}未找到技能: '${q}'${RESET}`); return; }
        appendLine(`${C_ACCENT}═ ${hit.name} ═${RESET}`);
        if (hit.description) appendLine(`  ${C_DIM}描述:${RESET} ${hit.description}`);
        if (hit.triggers && hit.triggers.length > 0) appendLine(`  ${C_DIM}触发:${RESET} ${hit.triggers.join(', ')}`);
        const body = (hit.body || '').trim().slice(0, 1200);
        if (body) appendLine(`  ${C_DIM}---${RESET}\n${body}`);
      }
    } catch (e: any) { appendLine(`${C_ERROR}/skills 失败: ${String(e?.message || e).slice(0, 120)}${RESET}`); }
    return;
  }

  // /mcp — MCP 插件/工具列表
  if (cmd === '/mcp') {
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      let servers: Record<string, any> = {};
      try { servers = JSON.parse(await readFile(join(process.env.HOME || '/tmp', '.mcp.json'), 'utf-8')).mcpServers || {}; } catch { /* 无 */ }
      appendLine(`${C_ACCENT}MCP 服务器 (${Object.keys(servers).length}):${RESET}`);
      if (Object.keys(servers).length === 0) { appendLine(`  ${C_DIM}无 (~/.mcp.json 未配置)${RESET}`); }
      for (const [name, s] of Object.entries(servers)) {
        const cmdStr = (s as any)?.command || '';
        appendLine(`  ${C_DIM}·${RESET} ${name} ${C_DIM}(${String(cmdStr).slice(0, 40)})${RESET}`);
      }
    } catch { /* 静默 */ }
    return;
  }

  // /agent — 当前智能体身份
  if (cmd === '/agent') {
    try {
      const a = await getAgent();
      appendLine(`${C_ACCENT}智能体:${RESET}`);
      appendLine(`  ${C_DIM}名称:${RESET} ${cliAgentName}`);
      appendLine(`  ${C_DIM}agentId:${RESET} ${(a as any).currentAgentId || '—'}`);
      appendLine(`  ${C_DIM}channel:${RESET} ${cliActiveChannelId || '—'}`);
    } catch { /* 静默 */ }
    return;
  }

  // /did — DID 身份
  if (cmd === '/did') {
    try {
      const { loadOrCreateAgentIdentity } = await import('./agents/agent-identity.js');
      const identity = loadOrCreateAgentIdentity(getCliAgentId());
      appendLine(`${C_ACCENT}DID 身份:${RESET}`);
      appendLine(`  ${C_DIM}did:${RESET} ${identity.did}`);
      appendLine(`  ${C_DIM}publicKey:${RESET} ${identity.publicKey?.slice(0, 32) || '—'}...`);
      appendLine(`  ${C_DIM}发布:${RESET} 可用 publish_did 工具发布到 IPFS+IPNS`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/did 失败: ${String(e.message || e).slice(0, 120)}${RESET}`);
    }
    return;
  }

  // /ipfs — Kubo 状态
  if (cmd === '/ipfs') {
    try {
      const { kuboApi } = await import('./agents/pi-sdk-tools.js');
      const id = await kuboApi('/api/v0/id');
      const peers = await kuboApi('/api/v0/swarm/peers');
      const pins = await kuboApi('/api/v0/pin/ls?type=recursive');
      appendLine(`${C_ACCENT}IPFS (Kubo):${RESET}`);
      appendLine(`  ${C_DIM}节点:${RESET} ${String((id as any).ID || '').slice(0, 24)}...`);
      appendLine(`  ${C_DIM}版本:${RESET} ${(id as any).AgentVersion || ''}`);
      appendLine(`  ${C_DIM}peers:${RESET} ${(peers as any)?.Peers?.length ?? 0}`);
      appendLine(`  ${C_DIM}pins:${RESET} ${(pins as any)?.Keys ? Object.keys((pins as any).Keys).length : 0}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/ipfs 失败: ${String(e.message || e).slice(0, 120)}${RESET}`);
    }
    return;
  }

  // /ipns — IPNS 状态 (keys + self 解析)
  if (cmd === '/ipns') {
    try {
      const { kuboApi } = await import('./agents/pi-sdk-tools.js');
      const keys = await kuboApi('/api/v0/key/list');
      const keyList = (keys as any)?.Keys || [];
      appendLine(`${C_ACCENT}IPNS keys (${keyList.length}):${RESET}`);
      for (const k of keyList.slice(0, 10)) {
        appendLine(`  ${C_DIM}·${RESET} ${k.Name} ${C_DIM}${String(k.Id).slice(0, 20)}...${RESET}`);
      }
      try {
        const r = await kuboApi('/api/v0/name/resolve?arg=ui-deploy&recursive=true&nocache=true', undefined, 15000);
        appendLine(`  ${C_DIM}ui-deploy →${RESET} ${(r as any).Path || ''}`);
      } catch { /* 无 ui-deploy */ }
    } catch (e: any) {
      appendLine(`${C_ERROR}/ipns 失败: ${String(e.message || e).slice(0, 120)}${RESET}`);
    }
    return;
  }

  // /wallet — 钱包状态
  if (cmd === '/wallet') {
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      let wallets: any[] = [];
      try { wallets = JSON.parse(await readFile(join(process.env.HOME || '/tmp', '.bolloon', 'wallets.json'), 'utf-8')); } catch { /* 无 */ }
      appendLine(`${C_ACCENT}钱包 (${Array.isArray(wallets) ? wallets.length : 0}):${RESET}`);
      if (!Array.isArray(wallets) || wallets.length === 0) {
        appendLine(`  ${C_DIM}无 — 可用 wallet_create 工具创建 EVM 钱包${RESET}`);
      }
      for (const w of (Array.isArray(wallets) ? wallets : []).slice(0, 5)) {
        appendLine(`  ${C_DIM}·${RESET} ${(w as any).name || (w as any).address?.slice(0, 12) || '?'} ${C_DIM}${String((w as any).address || '').slice(0, 16)}...${RESET}`);
      }
    } catch { /* 静默 */ }
    return;
  }

  // /email — 邮件配置管理; /email <host:port:user:from> 设置 / /email clear 清除 (2026-08-08)
  if (cmd === '/email') {
    try {
      const { readFile, writeFile, mkdir } = await import('fs/promises');
      const { join } = await import('path');
      const p = join(process.env.HOME || '/tmp', '.bolloon', 'smtp.json');
      let cfg: any = null;
      try { cfg = JSON.parse(await readFile(p, 'utf-8')); } catch { /* 无 */ }
      appendLine(`${C_ACCENT}邮件 (SMTP):${RESET}`);
      if (!cfg) { appendLine(`  ${C_DIM}未配置 smtp.json — 发件人: Leo <2844169590@qq.com>${RESET}`); }
      else {
        appendLine(`  ${C_DIM}host:${RESET} ${cfg.host || 'smtp.qq.com'}`);
        appendLine(`  ${C_DIM}发件人:${RESET} ${cfg.from || cfg.user || '—'}`);
      }
      appendLine(`  ${C_DIM}用法: /email <host:port:user:from> 设置 · /email clear 清除 · /email pass <授权码> 设密码${RESET}`);
    } catch { /* 静默 */ }
    return;
  }
  if (cmd === '/email clear') {
    try {
      const { writeFile, mkdir } = await import('fs/promises');
      const { join } = await import('path');
      const p = join(process.env.HOME || '/tmp', '.bolloon', 'smtp.json');
      await mkdir(join(process.env.HOME || '/tmp', '.bolloon'), { recursive: true });
      await writeFile(p, '{}', 'utf-8');
      appendLine(`${C_OK}✓ smtp 配置已清除${RESET}`);
    } catch { appendLine(`${C_ERROR}/email clear 失败${RESET}`); }
    return;
  }
  if (cmd.startsWith('/email ')) {
    const q = trimmed.slice('/email '.length).trim();
    try {
      const { writeFile, mkdir } = await import('fs/promises');
      const { join } = await import('path');
      const p = join(process.env.HOME || '/tmp', '.bolloon', 'smtp.json');
      await mkdir(join(process.env.HOME || '/tmp', '.bolloon'), { recursive: true });
      let cfg: any = {};
      try { cfg = JSON.parse(await import('fs/promises').then(m => m.readFile(p, 'utf-8'))); } catch { /* 无 */ }
      if (cmd.startsWith('/email pass')) {
        cfg.pass = q;
        await writeFile(p, JSON.stringify(cfg, null, 2), 'utf-8');
        appendLine(`${C_OK}✓ SMTP 授权码已保存${RESET}`);
        return;
      }
      const parts = q.split(':');
      if (parts.length >= 3) {
        cfg = { host: parts[0], port: parseInt(parts[1], 10) || 465, user: parts[2], from: parts[3] || parts[2], pass: cfg.pass };
        await writeFile(p, JSON.stringify(cfg, null, 2), 'utf-8');
        appendLine(`${C_OK}✓ SMTP 已设置: ${cfg.host}:${cfg.port} (发件人 ${cfg.from})${RESET}`);
      } else {
        appendLine(`${C_DIM}格式不对: /email <host:port:user:from> 或 /email clear 或 /email pass <授权码>${RESET}`);
      }
    } catch (e: any) {
      appendLine(`${C_ERROR}/email 设置失败: ${String(e.message || e).slice(0, 150)}${RESET}`);
    }
    return;
  }

  // /loop — 当前循环状态; /loop <目标> <完成标准> 设目标+标准并启动循环 (2026-08-08)
  if (cmd === '/loop') {
    try {
      const a = await getAgent();
      const h = (a as any).messageHistory ?? [];
      let tokens = 0;
      try {
        const { estimateTokens } = require('./context-compaction/index.js');
        tokens = estimateTokens(h);
      } catch { tokens = Math.round(JSON.stringify(h).length / 4); }
      appendLine(`${C_ACCENT}Loop 状态:${RESET}`);
      appendLine(`  ${C_DIM}消息:${RESET} ${h.length} 条 (窗口 15, ${Math.max(0, h.length - 15)} 条早期压缩)`);
      appendLine(`  ${C_DIM}token:${RESET} ${(tokens / 1000).toFixed(1)}k / 1M (${((tokens / 1_000_000) * 100).toFixed(2)}%)`);
      appendLine(`  ${C_DIM}用法: /loop <目标> (| <完成标准>) — 设目标并循环, 达到标准自动结束${RESET}`);
    } catch { /* 静默 */ }
    return;
  }
  if (cmd.startsWith('/loop ')) {
    const q = trimmed.slice('/loop '.length).trim();
    const [goalText, criteriaText] = q.split(/\s*[|｜]\s*/).map(s => s.trim());
    try {
      const { createPlan } = await import('./agents/plan-store.js');
      const criterion = criteriaText ? `达到标准: ${criteriaText}` : '';
      const r = await createPlan({
        goal: goalText || q,
        steps: [goalText || q, criterion].filter(Boolean),
        createdBy: 'user',
        originChannel: cliActiveChannelId || 'cli',
      });
      if (!r.ok || !r.plan) { appendLine(`${C_ERROR}/loop 启动失败: ${r.error || '未知'}${RESET}`); return; }
      appendLine(`${C_OK}✓ 循环已启动: ${C_ACCENT}${goalText}${RESET}${criteriaText ? `\n  ${C_DIM}完成标准: ${criteriaText}${RESET}` : ''} (${C_DIM}plan ${r.plan.planId}${RESET})`);
      appendLine(`  ${C_DIM}当标准达成时用 /todo 勾选最后一步 / 或 review 后自动结束循环${RESET}`);
      // 启动自我改进循环
      const { runSelfImproveLoop } = await import('./agents/pi-sdk-session-factory.js');
      const loop = await runSelfImproveLoop(goalText).catch(() => ({ success: false, error: '未启动' }));
      if (loop.success) appendLine(`  ${C_DIM}${(loop as any).output}${RESET}`);
      else appendLine(`  ${C_WARN}⚠ 循环未启动: ${loop.error}${RESET}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/loop 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  // /judgement — 判断力列表
  if (cmd === '/judgement' || cmd === '/judgments') {
    try {
      const { loadAllJudgments } = await import('./pi-ecosystem-judgment/human-value-store.js');
      const all = await loadAllJudgments().catch(() => []);
      appendLine(`${C_ACCENT}判断力 (${all.length} 条):${RESET}`);
      for (const j of all.slice(0, 8)) {
        appendLine(`  ${C_DIM}·${RESET} ${String((j as any).decision || '').slice(0, 70)}`);
      }
    } catch { /* 静默 */ }
    return;
  }

  // /insight — Context OS 08-Insights 资产
  if (cmd === '/insight') {
    try {
      const { readContextAssets, readAssetBody } = await import('./bootstrap/context-os.js');
      const listings = await readContextAssets('08-Insights');
      const files = listings[0]?.files || [];
      appendLine(`${C_ACCENT}洞察 (${files.length} 篇):${RESET}`);
      if (files.length === 0) { appendLine(`  ${C_DIM}无 — 价值点路由自动沉淀 insight 到 08-Insights${RESET}`); }
      for (const f of files.slice(0, 6)) {
        const body = await readAssetBody('08-Insights', f.file).catch(() => null);
        const firstLine = (body?.body || '').split('\n').filter(l => l.trim() && !l.startsWith('---')).slice(0, 2).join(' ').slice(0, 90);
        appendLine(`  ${C_ACCENT}·${RESET} ${f.title} ${C_DIM}${firstLine ? '— ' + firstLine : ''}${RESET}`);
      }
    } catch { /* 静默 */ }
    return;
  }

  // /wiki — wiki 状态
  if (cmd === '/wiki') {
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      const root = process.cwd();
      const statusPath = join(root, 'docs', 'wiki', 'current-status.md');
      const raw = await readFile(statusPath, 'utf-8');
      const title = raw.match(/^title:\s*(.+)$/m)?.[1] || 'current-status';
      const confirmed = raw.match(/^last_confirmed:\s*(.+)$/m)?.[1] || '?';
      const supported = (raw.match(/\|\|+/g) || []).length;
      appendLine(`${C_ACCENT}Wiki:${RESET} ${title}`);
      appendLine(`  ${C_DIM}last_confirmed:${RESET} ${confirmed}`);
      appendLine(`  ${C_DIM}已支持条目:${RESET} ${supported}`);
      appendLine(`  ${C_DIM}位置:${RESET} docs/wiki/ (wiki-first 范式)`);
    } catch { /* 静默 */ }
    return;
  }

  // /dream — 随机灵感; /dream <主题> 把用户主题落盘到梦想文档并触发循环 (2026-08-08)
  if (cmd === '/dream') {
    try {
      const { readContextAssets, readAssetBody } = await import('./bootstrap/context-os.js');
      const layers = ['08-Insights', '07-Knowledge', '12-Analysis'];
      const pool: string[] = [];
      for (const layer of layers) {
        const listings = await readContextAssets(layer);
        for (const f of (listings[0]?.files || []).slice(0, 5)) {
          const body = await readAssetBody(layer, f.file).catch(() => null);
          const lines = (body?.body || '').split('\n').filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('未来'));
          if (lines[0]) pool.push(lines[0].trim().slice(0, 100));
        }
      }
      if (pool.length === 0) {
        appendLine(`${C_DIM}🌙 梦境空空 — 多对话让记忆沉淀出洞察后, /dream 就有素材了${RESET}`);
      } else {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        appendLine(`${C_DIM}🌙 ${pick}${RESET}`);
      }
      appendLine(`  ${C_DIM}用法: /dream <主题> — 把主题写入梦想文档并启动循环${RESET}`);
    } catch { /* 静默 */ }
    return;
  }
  if (cmd.startsWith('/dream ')) {
    const topic = trimmed.slice('/dream '.length).trim();
    try {
      const { writeFile, mkdir } = await import('fs/promises');
      const { join } = await import('path');
      const home = process.env.HOME || '/tmp';
      const dreamDir = join(home, '.bolloon', 'dreams');
      await mkdir(dreamDir, { recursive: true });
      // 梦想文档路径: 用户名 + 主题 → 文件名 (用户信息集成进路径)
      const userTag = (cliAgentName || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const safeTopic = topic.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').slice(0, 40);
      const dreamPath = join(dreamDir, `${new Date().toISOString().slice(0, 10)}-${userTag}-${safeTopic}.md`);
      const doc = `# 🌙 Dream: ${topic}\n\ndate: ${new Date().toISOString()}\nuser: ${cliAgentName || 'user'}\nchannel: ${cliActiveChannelId || 'cli'}\n\n> 自动生成于 /dream, 触发循环去探索这个主题。\n`;
      await writeFile(dreamPath, doc, 'utf-8');
      appendLine(`${C_OK}✓ 梦想文档已写入: ${C_DIM}${dreamPath}${RESET}`);
      // 触发循环
      const { createPlan } = await import('./agents/plan-store.js');
      const r = await createPlan({ goal: `探索主题: ${topic}`, steps: [`研读 ${topic}`, '产出洞察'], createdBy: 'user', originChannel: cliActiveChannelId || 'cli' });
      if (r.ok) appendLine(`  ${C_DIM}循环已关联 plan ${r.plan?.planId}${RESET}`);
      const { runSelfImproveLoop } = await import('./agents/pi-sdk-session-factory.js');
      const loop = await runSelfImproveLoop(`探索主题: ${topic}`).catch(() => ({ success: false, error: '未启动' }));
      if (loop.success) appendLine(`  ${C_DIM}${(loop as any).output}${RESET}`);
      else appendLine(`  ${C_WARN}⚠ 循环未启动: ${loop.error}${RESET}`);
    } catch (e: any) {
      appendLine(`${C_ERROR}/dream 失败: ${String(e.message || e).slice(0, 200)}${RESET}`);
    }
    return;
  }

  if (trimmed.toLowerCase() === '/help' || trimmed === 'help') {
    appendLine(`${C_DIM}命令:${RESET}`);
    appendLine(`  ${C_ACCENT}!<cmd>${RESET}  执行终端命令  ${C_DIM}如 !ls -la${RESET}`);
    appendLine(`  ${C_ACCENT}/queue${RESET}  切换队列模式  ${C_DIM}输入排队, 当前结束后自动执行${RESET}`);
    appendLine(`  ${C_ACCENT}/dequeue${RESET} 出队一条`);
    appendLine(`  ${C_ACCENT}/channel [名字|id|序号]${RESET} 切换当前智能体  ${C_DIM}无参列出所有; 支持名字/ID/序号三种解析${RESET}`);
    appendLine(`  ${C_ACCENT}/model${RESET}    模型供应商选择器  ${C_DIM}↑↓ 选择 · Enter 确认 · Esc 取消${RESET}`);
    appendLine(`  ${C_ACCENT}/login${RESET}    登录 GitHub/Google 账号 (骨架)  ${C_DIM}暂无真实 OAuth${RESET}`);
    appendLine(`  ${C_ACCENT}/logout${RESET}  查看当前供应商`);
    appendLine(`  ${C_ACCENT}/new agent${RESET}  创建新智能体 channel  ${C_DIM}/new agent <名字>${RESET}`);
    appendLine(`  ${C_ACCENT}/new session${RESET}  开新会话  ${C_DIM}清空当前 channel 消息窗口${RESET}`);
    appendLine(`  ${C_ACCENT}/now${RESET}    当前状态总览  ${C_DIM}智能体/运行时间/上下文 tokens/消息数${RESET}`);
    appendLine(`  ${C_ACCENT}/session${RESET} 当前会话信息  ${C_DIM}channel/agent/消息窗口${RESET}`);
    appendLine(`  ${C_ACCENT}/loop${RESET}   循环状态/启动  ${C_DIM}/loop <目标> (| <完成标准>)${RESET}`);
    appendLine(`  ${C_ACCENT}/memory${RESET} 记忆摘要  ${C_DIM}memory-compressor 落盘摘要${RESET}`);
    appendLine(`  ${C_ACCENT}/resume${RESET} 恢复上下文  ${C_DIM}最近记忆 + 进行中计划${RESET}`);
    appendLine(`  ${C_ACCENT}/goal${RESET}   查看/设定目标  ${C_DIM}/goal 查看 · /goal <目标> 设定+循环${RESET}`);
    appendLine(`  ${C_ACCENT}/plan${RESET}   创建计划  ${C_DIM}/plan <目标> :: <步骤1>|<步骤2>${RESET}`);
    appendLine(`  ${C_ACCENT}/todo${RESET}   查看/勾选循环步骤  ${C_DIM}/todo <planId> <序号>${RESET}`);
    appendLine(`  ${C_ACCENT}/tools${RESET}  可用工具列表 (名/参数/简介)`);
    appendLine(`  ${C_ACCENT}/skill${RESET}  技能候选  ${C_DIM}skill-writer 沉淀候选${RESET}`);
    appendLine(`  ${C_ACCENT}/skills${RESET} 查看正式技能  ${C_DIM}/skills <名> 看详情 (运行时开始前 view)${RESET}`);
    appendLine(`  ${C_ACCENT}/mcp${RESET}    MCP 服务器列表`);
    appendLine(`  ${C_ACCENT}/agent${RESET}  当前智能体身份`);
    appendLine(`  ${C_ACCENT}/did${RESET}    DID 身份`);
    appendLine(`  ${C_ACCENT}/ipfs${RESET}   Kubo 状态  ${C_DIM}节点/peers/pins${RESET}`);
    appendLine(`  ${C_ACCENT}/ipns${RESET}   IPNS keys + resolve`);
    appendLine(`  ${C_ACCENT}/wallet${RESET} 钱包状态`);
    appendLine(`  ${C_ACCENT}/email${RESET}  邮件配置管理  ${C_DIM}/email 查看 · <host:port:user:from> 设置 · clear 清除${RESET}`);
    appendLine(`  ${C_ACCENT}/judgement${RESET} 判断力列表`);
    appendLine(`  ${C_ACCENT}/insight${RESET} Context OS 洞察 (08-Insights)`);
    appendLine(`  ${C_ACCENT}/wiki${RESET}   wiki 状态`);
    appendLine(`  ${C_ACCENT}/suggestions${RESET} 建议队列  ${C_DIM}list · accept <n> · dismiss <n> · clear · catalog · install${RESET}`);
    appendLine(`  ${C_ACCENT}/cron${RESET}   定时任务  ${C_DIM}list · add <名> '<schedule>' <prompt> · rm/on/off <id>${RESET}`);
    appendLine(`  ${C_ACCENT}/dream${RESET}  随机灵感  ${C_DIM}/dream <主题> 写入梦想文档并触发循环${RESET}`);
    appendLine(`  ${C_ACCENT}@名字${RESET}     @ 命中智能体  ${C_DIM}弹出窗选择后发送给智能体${RESET}`);
    appendLine(`  ${C_ACCENT}/名字${RESET}     / 命中命令/技能/插件  ${C_DIM}输入 / 自动弹出${RESET}`);
    appendLine(`  ${C_ACCENT}#路径${RESET}     # 命中文件  ${C_DIM}输入 # 自动弹出文件列表${RESET}`);
    appendLine(`  ${C_ACCENT}Tab${RESET}       补齐命令  ${C_DIM}普通输入也能 Tab 补 /命令 use_skill 技能 @智能体 #文件${RESET}`);
    appendLine(`  ${C_ACCENT}↑/↓${RESET}       切换历史输入  ${C_DIM}↑ 翻上一条, ↓ 回下一条/草稿${RESET}`);
    appendLine(`  ${C_ACCENT}peers${RESET}   查看 P2P 节点`);
    appendLine(`  ${C_ACCENT}iroh${RESET}    查看 iroh 状态`);
    appendLine(`  ${C_ACCENT}add_friend${RESET} 添加好友`);
    appendLine(`  ${C_ACCENT}Esc 双击${RESET}  退出当前进程`);
    appendLine(`  ${C_ACCENT}exit${RESET}    退出`);
    return;
  }

  if (trimmed === '退出' || trimmed === 'exit' || trimmed === 'quit') {
    appendLine(`\n${CYAN}👋 再见！${RESET}`);
    isRunning = false;
    return;
  }

  if (trimmed.toLowerCase() === 'peers') {
    const peers = comm.getConnections();
    appendLine(`${GRAY}已连接节点: ${peers.length}${RESET}`);
    for (const c of peers) {
      appendLine(`  ${GRAY}·${RESET} ${c.publicKey.substring(0, 16)}...`);
    }
    return;
  }

  if (trimmed.toLowerCase() === 'iroh') {
    const nodeId = irohTransport.getNodeId();
    const running = irohTransport.isRunning();
    const peers = irohTransport.getPeers();
    appendLine(`${GRAY}iroh 状态:${RESET}`);
    appendLine(`  ${GRAY}运行中:${RESET} ${running ? '是' : '否'}`);
    appendLine(`  ${GRAY}Node ID:${RESET} ${nodeId ? nodeId.substring(0, 24) + '...' : 'N/A'}`);
    appendLine(`  ${GRAY}已知节点:${RESET} ${peers.length}`);
    if (hybridMessenger) {
      appendLine(`  ${GRAY}HybridMessenger:${RESET} 就绪`);
    }
    return;
  }

  if (trimmed.toLowerCase().startsWith('add_friend ') || trimmed.toLowerCase() === 'add_friend') {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2 || (parts.length === 2 && parts[1].length !== 64)) {
      appendLine(`${GRAY}用法: add_friend <64字符hex publicKey> [备注名]\n${RESET}`);
      appendLine(`${GRAY}示例: add_friend a1b2c3d4e5f6... 同事-张磊\n${RESET}`);
      return;
    }
    const pk = parts[1];
    const name = parts.slice(2).join(' ') || '';
    appendLine(`${GRAY}正在发送好友申请给 ${pk.substring(0, 16)}...${RESET}`);
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
        appendLine(`${MAGENTA}✗ 添加好友失败: ${reason}${RESET}`);
        if (data.persistedAs) appendLine(`${GRAY}本地已保存为: ${data.persistedAs}${RESET}`);
      } else {
        appendLine(`${GREEN}✓ 好友申请已发送给 ${data.persistedAs || name || pk.substring(0, 12)}...${RESET}`);
      }
    } catch (err: any) {
      appendLine(`${MAGENTA}✗ 添加好友失败: ${err.message || String(err)}${RESET}`);
    }
    return;
  }

  try {
    // 双横线分割
    appendLine(`${C_DIM}${'─'.repeat(8)} · ${'─'.repeat(8)}${RESET}`);
    appendLine(renderUserMessage(trimmed));
    // 启动思考动画
    inkSetThinking(true);

    const a = await getAgent();
    const boxW = Math.min(termWidth() - 2, 76);
    // 工具调用显示由 tui-shell 的 onStream handler 处理

    const response = await a.prompt(trimmed, {
      onStream: (e) => {
        // 2026-08-07: 中间思考/状态显示 — 之前只显示工具步骤, LLM 的思考过程
        //   (thinking / status / phase / Reflection) 全被丢弃 → 用户只能看到输入和最终输出
        // 用户偏好 (2026-08-07): 思考过程 = 圆角框渲染 (和回复同路径 renderMessageBox),
        //   颜文字动画 (inkSetThinking) 只表示"正在运行", 不承载思考内容
        if (e.type === 'thinking' && e.content) {
          // thinking 事件只有 "🤔 开始思考..." 占位 → 不 appendLine, 运行过程由动画表示;
          //   真正思考内容在 status 的 Reflection/💡 事件 → 下方框渲染
        } else if ((e as any).phase && !e.type) {
          // 2026-08-12 (Task4): phase (意图识别/工具选择/规划) 是模型内部规划过程,
          //   用户偏好"中间过程不显示" → 静默丢弃, 不污染终端. (仅 Reflection 框保留, 走 status 分支)
        } else if (e.type === 'status' && e.content) {
          const content = String(e.content);
          // Reflection / 反思 / 💡 → 圆角思考框 (和回复一样走 renderMessageBox, 白字+亮边框)
          if (content.includes('Reflection') || content.includes('反思') || content.includes('💡')) {
            const body = content.replace(/^💡\s*/, '').slice(0, 1500);
            if (body.trim()) appendLine(renderMessageBox({ title: '💡 反思', body, color: C_WARN }));
          } else if (!content.includes('🔄 循环') && !content.includes('📋 参数')
              && !content.includes('🔍 任务复杂度') && !content.includes('⚙️ 动态配置')
              && !content.includes('⏹️ pivot loop')
              // 2026-08-12 (Task4): 循环过渡噪音 — "工具执行完成继续循环"/"继续总结" 是内部推进过程,
              //   不是给用户看的内容, 一律静默丢弃 (用户抱怨"每次显示触发下一轮循环"的真凶).
              && !content.includes('继续循环') && !content.includes('继续总结')) {
            appendLine(`${C_DIM}${content}${RESET}`);
          }
        } else if (e.type === 'step_start') {
          tuiToolCounter++;
          const toolName = e.tool || '?';
          tuiToolCalls.push({ tool: toolName, args: e.args, _t: Date.now() });
          // 2026-08-12 (TaskA): 工具命中要干净 — step_start 不 appendLine 到消息流 (避免重复),
          //   改用 transient 行显示"正在执行"(消息流只在 done 时出现一次完成行).
          if (toolName !== 'system' && toolName !== 'loop' && toolName !== '?') {
            const activeNames = tuiToolCalls.map(c => c.tool).filter(t => t !== 'system' && t !== 'loop' && t !== '?');
            const label = activeNames.length > 1 ? `执行 ${activeNames.length} 个工具: ${activeNames.join(', ')}` : `🔧 ${toolName}`;
            inkSetTransient(`${C_DIM}${label} 运行中...${RESET}`);
          }
        } else if (e.type === 'step_done' || e.type === 'step_error') {
          const p = tuiToolCalls.shift();
          const doneItem: ToolCallListItem = {
            tool: e.tool ?? (p?.tool ?? '?'),
            args: p?.args,
            status: e.type === 'step_done' ? 'ok' : 'error',
            output: e.output,
            error: e.error,
            durationMs: p ? Date.now() - p._t : undefined,
          };
          if (e.type === 'step_done') {
            const t = e.tool ?? p?.tool;
            if (t && t !== 'system' && t !== '?') {
              runEndOkSteps.push({ status: 'ok', name: t, output: e.output });
            }
          }
          // 2026-08-12 (TaskA): 每个工具只在消息流出现一次 (done 时 appendLine 完成行).
          //   不 replaceLastLine (并行/thinking 交错会替换错行); 完成行固定追加.
          const doneTool = e.tool ?? p?.tool;
          if (doneTool !== 'system' && doneTool !== 'loop' && doneTool !== '?') {
            appendLine(renderToolCallListItem(doneItem, tuiToolCalls.length + 1, tuiToolCounter));
          }
          // 更新 transient: 还有进行中的工具 → 显示下一个; 否则清空 (交回 thinking 动画)
          const remaining = tuiToolCalls.filter(c => c.tool !== 'system' && c.tool !== 'loop' && c.tool !== '?');
          if (remaining.length > 0) {
            const label = remaining.length > 1 ? `执行 ${remaining.length} 个工具: ${remaining.map(c => c.tool).join(', ')}` : `🔧 ${remaining[0].tool}`;
            inkSetTransient(`${C_DIM}${label} 运行中...${RESET}`);
          } else {
            inkSetTransient(null);
          }
        }
      }
    });
    // 智能体回复框
    appendLine(renderAgentMessage(response));
    // 停止思考动画
    inkSetThinking(false);
    // 2026-08-04: run-end 经验整理 — 连续成功工具 ≥2 自动写 skill 候选
    // 2026-08-10: 显示改走 transient 行 (颜文字位置): 开始时显示, 结束后清空 (显示为空),
    //   不再追加 ✨ 消息行 → 不残留显示效果
    if (runEndOkSteps.length >= 2) {
      inkSetTransient(`${C_DIM}(｀・ω・´) 整理本轮经验中... ${runEndOkSteps.length} 个工具调用${RESET}`);
      setImmediate(async () => {
        try {
          const { writeRunEndSkillCandidates } = await import('./agents/skill-writer.js');
          await writeRunEndSkillCandidates(runEndOkSteps, 'cli:interactive');
        } catch { /* 非致命, 静默 */ }
        finally {
          inkSetTransient(null); // 结束后去除显示效果 (显示为空)
        }
      });
    }
    // 2026-08-12 (TaskM2, hermes sync 模式): CLI 对话结束后同步记忆 — 每轮 compressSessionToMemory
    //   把本会话消息压缩成摘要 (≥4 新消息触发), 供后续运行时 recallMemory 自动召回 (跨 session 记忆).
    //   Web 模式 server.ts 已有, CLI 之前缺失 → CLI 下无摘要可召回. 失败静默, 不阻塞对话.
    if (cliActiveChannelId) {
      setImmediate(async () => {
        try {
          const { compressSessionToMemory } = await import('./bootstrap/memory-compressor.js');
          const channelForMem = String(cliActiveChannelId || '');
          let sessionId = 'default';
          try {
            const { getIdentityStore } = await import('./agents/agent-identity-store.js');
            const store = getIdentityStore();
            await store.load();
            const ch = store.rawChannels.find((c: any) => c.id === channelForMem);
            if (ch && (ch as any).currentSessionId) sessionId = String((ch as any).currentSessionId);
          } catch { /* 读 sessionId 失败用 default */ }
          await compressSessionToMemory({
            agentId: getCliAgentId(),
            channelId: channelForMem,
            sessionId,
          });
        } catch { /* 记忆压缩失败静默 */ }
      });
    }
    // 更新状态栏: 上下文进度 (2026-08-06: 每轮按当前 messageHistory 重算并写回 ContextManager,
    //   保证状态栏按需更新 — 不依赖 pi-sdk loop 内部上报, 1s 定时器读到的一定是最新值)
    // 2026-08-07 修复: pi-sdk loop 每轮已用 estimateHistoryTokens() 上报 ContextManager (pi-sdk.ts:1223),
    //   这里直接读现值 — 之前用 (a as any).messageHistory 重算, 私有字段拿不到恒为 [] → 0,
    //   还把 pi-sdk 上报的真实值覆盖成 0 (状态栏永远 0.00% 的根因)
    try {
      const { getContextManager } = await import('./bootstrap/context-manager.js');
      const cm = getContextManager();
      let usage = cm.getUsage();
      if (!usage || usage.usedTokens <= 0) {
        // fallback: 非交互/异常路径 pi-sdk 未上报时兜底估算 (4 字符 ≈ 1 token)
        const hist = (a as any)?.agent?.messageHistory ?? (a as any)?.piAgent?.messageHistory ?? [];
        let t = 0;
        try {
          const { estimateTokens } = _require('./context-compaction/index.js');
          t = estimateTokens(hist);
        } catch {
          t = Math.max(0, Math.round(JSON.stringify(hist).length / 4));
        }
        usage = cm.updateUsage(Math.max(t, usage?.usedTokens ?? 0));
      }
      const usageView = {
        // 保留浮点 (0-100), buildContextBar 内部格式化
        pct: Math.min(100, (usage.usedTokens / Math.max(1, usage.maxTokens)) * 100),
        usedTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
        stage: usage.stage,
      };
      const statusText = `${C_ACCENT}${cliModelName}${RESET}${C_DIM}  │${RESET} ${cliAgentName} ${C_DIM}│${RESET} ⏱ ${fmtDuration(Date.now() - cliStartTime)}${C_DIM} │${RESET} ${buildContextBar(usageView)}`;
      inkSetStatus(statusText);
    } catch { /* 降级容忍 */ }
    // 自动消费队列
    if (pendingQueue.length > 0) {
      const next = pendingQueue.shift()!;
      appendLine(`${C_WARN}⏩ 自动执行队列 [${pendingQueue.length + 1}/${pendingQueue.length + 1}]${RESET}`);
      await processInput(next, comm);
      return;
    }
    inkSetThinking(false);
  } catch (e: any) {
    inkSetThinking(false);
    if (!e.message?.includes('ERR_USE_AFTER_CLOSE') && !e.message?.includes('write after end')) {
      appendLine(`${MAGENTA}❌ ${e.message}${RESET}`);
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
          appendLine(`⏳ 任务已派给 ${targetPk.slice(0, 12)}..., 等回复 (最多 90s)...`);
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
        appendLine(`[chat-p2p-listen] role=${id.role} pk=${id.publicKey.slice(0, 12)} listening on bolloon-agent-harness`);
        appendLine(`[chat-p2p-listen] press Ctrl-C to stop`);

        const onData = (ev: any) => {
          try {
            const text = Buffer.isBuffer(ev.data) ? ev.data.toString('utf8') : String(ev.data);
            try {
              const env = JSON.parse(text);
              if (env && env.v === 3 && env.op === 'agent.chat.direct') {
                const { text: body, fromRole } = env.payload || {};
                const ts = (env.payload?.ts || new Date().toISOString()).replace('T', ' ').replace(/\.\d+Z$/, '');
                appendLine(`\n[${ts} ${fromRole || ev.fromPublicKey?.slice(0, 12)} → me] ${body}\n> `);
                return;
              }
            } catch { /* 非 v3 envelope, 当 raw 显示 */ }
            appendLine(`\n[raw ${ev.fromPublicKey?.slice(0, 12)}] ${text.slice(0, 200)}\n> `);
          } catch (e: any) {
            appendLine(`[chat-p2p-listen] decode error: ${e?.message ?? e}`);
          }
        };
        p2p.on('data', onData);

        let lastPing = 0;
        const keepAlive = setInterval(() => {
          const now = Date.now();
          if (now - lastPing > 5 * 60_000) {
            appendLine(`[chat-p2p-listen] alive, role=${id.role}`);
            lastPing = now;
          }
        }, 30_000);

        const stop = async () => {
          appendLine(`\n[chat-p2p-listen] stopping...`);
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
        appendLine(`[chat-p2p-listen] joined topic ✓\n> `);

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
    // 2026-08-07: 只吞 SDK 结构化日志 (2026-...T 前缀直接写 stdout 的), 其余 (Ink ANSI 渲染) 走原始 write
    //   不能整体 no-op — Ink 渲染依赖 write callback, 且 pty/管道缓冲满时 no-op 会掩盖真实写状态
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      const s = String(chunk);
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return true; // SDK 结构化日志 → 吞
      return (originalStdoutWrite as any)(chunk, ...rest);
    }) as any;
    // 2026-08-07: 交互模式静音 auto-update 后台通知 (stderr), 避免 "🔍 检查更新" 污染 TUI
    void import('./utils/auto-update.js').then(({ setNotifyQuiet }) => setNotifyQuiet(true)).catch(() => {});
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

  // 2026-08-07: CLI 模式后台自动安装/启动本地 Kubo (web 模式 server.ts 已有, CLI 缺 → IPNS 发布后无法解析的根因)
  //   fire-and-forget, 不阻塞启动; Kubo 就绪后才发布 DID (避免 registerAgent 在 Kubo 未启动时 30s 超时)
  //   装好后 /ipfs /ipns /ipfs_add /ipns_publish 工具可用
  void (async () => {
    let kuboReady = false;
    try {
      const sdk = await import('@diap/sdk');
      const checkKuboSetup = (sdk as any).checkKuboSetup;
      if (typeof checkKuboSetup === 'function') {
        const setup = await checkKuboSetup(true, true);
        kuboReady = !!(setup?.ready && setup?.daemonRunning);
        s.info(kuboReady ? 'IPFS 本地 Kubo 就绪 → IPNS 发布/解析可用' : 'Kubo 不可用, IPFS 降级本地模式');
      }
    } catch (e: any) {
      s.warn(`Kubo 自动安装失败 (非致命): ${String(e?.message || e).slice(0, 120)}`);
    }
    publishDID(name, keypair).then(({ cid, ipnsName }) => {
      if (cid) agentIdentity!.cid = cid;
      if (ipnsName) agentIdentity!.ipnsName = ipnsName;
    }).catch(() => {});
  })();

  

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
      // 2026-08-07: 弱网下 hyperswarm DHT start/joinTopic 可能无限挂起 → 20s 超时门, 超时降级无 P2P 模式
      comm = await withTimeout(bootstrapP2P(verifier), 20_000, 'P2P 网络初始化')
        .catch((err: Error) => {
          s.warn(`P2P 初始化超时/失败, 降级无 P2P 模式: ${err.message}`);
          return null;
        });
      if (comm) {
        const connections = comm.getConnections();
        if (connections.length > 0) {
          agentIdentity.peerId = connections[0].publicKey;
          agentIdentity.p2pChannel = 'bolloon-agent-harness';
        }
      }
    }
  } catch (err: any) {
    s.warn(`P2P 初始化失败: ${err.message}`);
    s.warn('将使用无 P2P 模式运行');
  }

  await withTimeout(bootstrapIroh(keypair, name), 15_000, 'iroh P2P 初始化')
    .catch((err: Error) => s.warn(`iroh 初始化超时, 继续使用 Hyperswarm P2P: ${err.message}`));

  // Bolloon Bootstrap: 启动扫描 + Context 收集 + 挂定时任务
  // 失败静默 (主流程不被阻塞)
  try {
    const { bootstrapBolloon } = await import('./pi-ecosystem-judgment/human-value-pipeline.js');
    s.info('正在 bootstrap bolloon 上下文...');
    const bs = await withTimeout(bootstrapBolloon({ cwd: process.cwd() }), 20_000, 'Bolloon 上下文扫描');
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

    await startCLI(comm!);
  }
  } catch (e) {
    throw e;
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
