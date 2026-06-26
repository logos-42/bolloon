/**
 * judgment-protocol — bolloon 的 4 个核心协议消息
 *
 * 协议定义见 docs/真正要做的事.md §3.2:
 *   - ask       (A→B):   就决策 X 发起 3 个反方蒸馏
 *   - dissent   (A↔B):   双方反方观点互见
 *   - align     (A↔B):   基于反方互见形成对齐结论
 *   - reflect   (本地):   整链闭环后沉淀成 judgment
 *
 * Transport: iroh (复用现有 IrohTransport, 不另起).
 * 4 个消息 kind: 'judgment_ask' | 'judgment_dissent' | 'judgment_align'
 * reflect 不上链, 直接落 ~/.bolloon/judgments/{askId}.yaml
 *
 * 设计取舍:
 *   - 协议消息是 askId-keyed 的 (一个决策一条链)
 *   - dissent 至少 3 个反方 (协议硬约束, 协议四要素里"反方互见"的最小颗粒)
 *   - dissent 不要求显式命令 — 收到 ask 自动蒸馏本方 3 反方回发
 *   - align 必须引用 askId + at least 1 dissentId per side, 否则视为未基于"互见"
 *   - reflect 是本地, 写盘后 emit 一个 'reflected' 事件, UI 可订阅
 *
 * 蒸馏 (distillDissent) 调用现有 human-value-store 的判断力:
 *   loadAllJudgments + getValueProfile, 用 LLM 生成 3 个反方.
 * LLM 不可用时降级到启发式 (从历史 judgment 抽最近 3 条 reasons 当反方骨架).
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { irohTransport as defaultIrohTransport, type IrohTransport } from '../network/iroh-transport.js';
import { loadAllJudgments, getValueProfile, storeHumanJudgment, getRelevantValues } from '../pi-ecosystem-judgment/human-value-store.js';

// ============================================================================
// 类型
// ============================================================================

export interface JudgmentAsk {
  askId: string;
  decision: string;          // "我要不要和 X 签这个合同?"
  proposerNodeId: string;
  proposerName?: string;
  context?: string;          // 可选补充 (最多 500 字, 蒸馏用)
  ts: number;
}

export interface JudgmentDissent {
  dissentId: string;
  askId: string;
  fromNodeId: string;
  fromName?: string;
  dissents: string[];        // 长度 3..5, 协议硬约束
  ts: number;
}

export interface JudgmentAlign {
  alignId: string;
  askId: string;
  fromNodeId: string;
  fromName?: string;
  conclusion: string;        // "签, 30% 定金分 6 期"
  basedOn: {
    askId: string;
    dissentIds: string[];    // 必须至少 1 条 A 视角 + 1 条 B 视角
  };
  ts: number;
}

export interface JudgmentChain {
  ask: JudgmentAsk;
  dissents: JudgmentDissent[];
  aligns: JudgmentAlign[];
  status: 'open' | 'aligned' | 'reflected';
  createdAt: number;
  closedAt?: number;
}

// 事件总线 (UI / CLI 可订阅)
export type JudgmentEvent =
  | { kind: 'ask_sent';        askId: string; peerDID: string }
  | { kind: 'ask_received';    askId: string; fromNodeId: string }
  | { kind: 'dissent_sent';    dissentId: string; askId: string; peerDID: string }
  | { kind: 'dissent_received'; dissentId: string; askId: string; fromNodeId: string }
  | { kind: 'align_sent';      alignId: string; askId: string; peerDID: string }
  | { kind: 'align_received';  alignId: string; askId: string; fromNodeId: string }
  | { kind: 'reflected';       askId: string; judgmentId: string };

class JudgmentEventBus extends EventEmitter {}
export const judgmentEventBus = new JudgmentEventBus();

// ============================================================================
// 持久化 (本地 chain registry)
//   ~/.bolloon/judgments/chains/{askId}.json
//   ~/.bolloon/judgments/yaml/{askId}.yaml  (reflect 后写出)
// ============================================================================

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function chainsDir(): string {
  return path.join(homeDir(), '.bolloon', 'judgments', 'chains');
}

function yamlDir(): string {
  return path.join(homeDir(), '.bolloon', 'judgments', 'yaml');
}

function chainPath(askId: string): string {
  return path.join(chainsDir(), `${askId}.json`);
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(chainsDir(), { recursive: true });
  await fs.mkdir(yamlDir(), { recursive: true });
}

async function readChain(askId: string): Promise<JudgmentChain | null> {
  try {
    const buf = await fs.readFile(chainPath(askId), 'utf-8');
    return JSON.parse(buf) as JudgmentChain;
  } catch { return null; }
}

async function writeChain(chain: JudgmentChain): Promise<void> {
  await ensureDirs();
  await fs.writeFile(chainPath(chain.ask.askId), JSON.stringify(chain, null, 2), 'utf-8');
}

// ============================================================================
// 帧构造 / 解析
// ============================================================================

function encodeAskFrame(ask: JudgmentAsk): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kind: 'judgment_ask', payload: ask, ts: ask.ts }));
}

function encodeDissentFrame(d: JudgmentDissent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kind: 'judgment_dissent', payload: d, ts: d.ts }));
}

function encodeAlignFrame(a: JudgmentAlign): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kind: 'judgment_align', payload: a, ts: a.ts }));
}

function decodeFrame(buf: Uint8Array): { kind: string; payload: any } | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(buf));
    if (typeof obj?.kind === 'string' && obj.payload) return obj;
    return null;
  } catch { return null; }
}

// ============================================================================
// Listener (每 transport 各装一次)
// ============================================================================

interface JudgmentModuleState {
  listenersInstalled: boolean;
}
const states = new WeakMap<IrohTransport, JudgmentModuleState>();

function getState(transport: IrohTransport): JudgmentModuleState {
  let s = states.get(transport);
  if (!s) { s = { listenersInstalled: false }; states.set(transport, s); }
  return s;
}

function ensureListeners(transport: IrohTransport): void {
  const s = getState(transport);
  if (s.listenersInstalled) return;
  s.listenersInstalled = true;

  transport.onMessage('judgment_ask', async (msg) => {
    const frame = decodeFrame(msg.payload);
    if (!frame) return;
    const ask = frame.payload as JudgmentAsk;
    await onAskReceived(transport, ask);
  });

  transport.onMessage('judgment_dissent', async (msg) => {
    const frame = decodeFrame(msg.payload);
    if (!frame) return;
    const dissent = frame.payload as JudgmentDissent;
    await onDissentReceived(transport, dissent);
  });

  transport.onMessage('judgment_align', async (msg) => {
    const frame = decodeFrame(msg.payload);
    if (!frame) return;
    const align = frame.payload as JudgmentAlign;
    await onAlignReceived(transport, align);
  });
}

// ============================================================================
// 蒸馏 (dissent 生成) — 协议核心载荷
// ============================================================================

/**
 * 基于本方判断力 + ask 内容, 蒸馏 3 个反方观点.
 * 协议硬约束: 至少 3 个, 最多 5 个.
 */
export async function distillDissent(ask: JudgmentAsk): Promise<string[]> {
  const allJudgments = await loadAllJudgments().catch(() => []);
  const valueProfile = await getValueProfile('me').catch(() => null);
  const relevant = await getRelevantValues(ask.decision, undefined).catch(() => []);

  const valueHint = valueProfile ? [
    `quality_focus=${valueProfile.quality_focus.toFixed(2)}`,
    `efficiency_focus=${valueProfile.efficiency_focus.toFixed(2)}`,
    `safety_focus=${valueProfile.safety_focus.toFixed(2)}`,
    `collaboration_focus=${valueProfile.collaboration_focus.toFixed(2)}`,
    `learning_focus=${valueProfile.learning_focus.toFixed(2)}`,
  ].join(', ') : '';

  const recentReasons = allJudgments
    .filter((j) => (j as any).reasons?.length > 0)
    .slice(-10)
    .flatMap((j: any) => j.reasons || [])
    .slice(0, 20);

  const prompt = `你是用户的判断力代理. 用户发起了一个决定: "${ask.decision}"
${ask.context ? `\n补充: ${ask.context}` : ''}

[用户价值画像] ${valueHint}
[相关历史判断 (${relevant.length} 条)] ${relevant.slice(0, 3).map((j: any) => j.decision || '').join(' | ').slice(0, 300)}
[历史理由样本] ${recentReasons.join(' | ').slice(0, 400) || '(无)'}

请基于上述判断力, 生成正好 3 个"反方观点" (用户应该考虑但可能忽略的风险/盲点).
要求:
- 每个反方 1-2 句, 总长 < 80 字
- 必须是这个特定决定的"反对声音", 不是通用建议
- 第 1 个: 历史/经验类风险
- 第 2 个: 关系/信任类风险
- 第 3 个: 隐藏代价/时间类风险
- 用 JSON 数组返回: ["反方1", "反方2", "反方3"]`;

  // LLM 调用 (OpenAI 兼容, 复用 p2p-chat-tools 的方式)
  let dissents: string[] = [];
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error('no LLM key');
    const openaiBase = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4';
    const r = await fetch(`${openaiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: openaiModel,
        messages: [
          { role: 'system', content: '你只输出 JSON 数组, 不要解释. 必须正好 3 个元素.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const data = await r.json() as any;
      const text = (data.choices?.[0]?.message?.content || '').trim();
      // 尝试提取 JSON 数组
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) dissents = parsed.filter((s) => typeof s === 'string' && s.trim()).slice(0, 5);
      }
    }
  } catch (e) {
    console.warn('[judgment-protocol] LLM distill failed:', (e as Error).message);
  }

  // Fallback: 启发式 — 从历史 judgment 抽 3 条理由做骨架
  if (dissents.length < 3) {
    const fallback = recentReasons.slice(0, 5);
    while (dissents.length < 3 && fallback.length > 0) {
      dissents.push(`[启发式] ${fallback.shift()}`);
    }
  }
  while (dissents.length < 3) {
    dissents.push(`[占位反方 ${dissents.length + 1}] 这个决定可能忽略的盲点 (LLM 不可用, 请人工补充)`);
  }
  return dissents.slice(0, 5);
}

// ============================================================================
// 协议 handler — 收到对方消息时
// ============================================================================

async function onAskReceived(transport: IrohTransport, ask: JudgmentAsk): Promise<void> {
  console.log(`[judgment-protocol] ask 收到: "${ask.decision.slice(0, 40)}..." from ${ask.proposerNodeId.slice(0, 12)}`);
  // 1) 落本地 chain (init open)
  let chain = await readChain(ask.askId);
  if (!chain) {
    chain = { ask, dissents: [], aligns: [], status: 'open', createdAt: Date.now() };
    await writeChain(chain);
  }
  judgmentEventBus.emit('judgment', { kind: 'ask_received', askId: ask.askId, fromNodeId: ask.proposerNodeId } satisfies JudgmentEvent);

  // 2) 自动蒸馏我方 3 反方, 作为 dissent 回发 (协议: ask 必触发 dissent)
  const dissents = await distillDissent(ask);
  const myNodeId = transport.getNodeId() || 'unknown';
  const dissent: JudgmentDissent = {
    dissentId: crypto.randomUUID(),
    askId: ask.askId,
    fromNodeId: myNodeId,
    dissents,
    ts: Date.now(),
  };
  await sendDissentInternal(transport, ask.proposerNodeId, dissent);
}

async function onDissentReceived(transport: IrohTransport, dissent: JudgmentDissent): Promise<void> {
  console.log(`[judgment-protocol] dissent 收到: ${dissent.dissents.length} 反方 for ask ${dissent.askId.slice(0, 8)} from ${dissent.fromNodeId.slice(0, 12)}`);
  const chain = await readChain(dissent.askId);
  if (!chain) {
    console.warn(`[judgment-protocol] 收到 dissent 但找不到对应 ask ${dissent.askId}, 跳过`);
    return;
  }
  // 去重 (同一节点可能重发)
  if (!chain.dissents.some((d) => d.dissentId === dissent.dissentId)) {
    chain.dissents.push(dissent);
    await writeChain(chain);
  }
  judgmentEventBus.emit('judgment', { kind: 'dissent_received', dissentId: dissent.dissentId, askId: dissent.askId, fromNodeId: dissent.fromNodeId } satisfies JudgmentEvent);
}

async function onAlignReceived(transport: IrohTransport, align: JudgmentAlign): Promise<void> {
  console.log(`[judgment-protocol] align 收到: "${align.conclusion.slice(0, 40)}..." for ask ${align.askId.slice(0, 8)}`);
  const chain = await readChain(align.askId);
  if (!chain) {
    console.warn(`[judgment-protocol] 收到 align 但找不到对应 ask ${align.askId}, 跳过`);
    return;
  }
  if (!chain.aligns.some((a) => a.alignId === align.alignId)) {
    chain.aligns.push(align);
    chain.status = 'aligned';
    chain.closedAt = Date.now();
    await writeChain(chain);
  }
  judgmentEventBus.emit('judgment', { kind: 'align_received', alignId: align.alignId, askId: align.askId, fromNodeId: align.fromNodeId } satisfies JudgmentEvent);
}

// ============================================================================
// 公共 API — 调用方 (CLI / Web / Skill) 用
// ============================================================================

export async function initJudgmentProtocol(transport: IrohTransport = defaultIrohTransport): Promise<void> {
  ensureListeners(transport);
  await ensureDirs();
  console.log('[judgment-protocol] initialized, chains dir =', chainsDir());
}

export async function sendAsk(
  peerDID: string,
  decision: string,
  opts: { context?: string; proposerName?: string } = {},
  transport: IrohTransport = defaultIrohTransport,
): Promise<JudgmentAsk> {
  ensureListeners(transport);
  const myNodeId = transport.getNodeId() || 'unknown';
  const ask: JudgmentAsk = {
    askId: crypto.randomUUID(),
    decision,
    proposerNodeId: myNodeId,
    proposerName: opts.proposerName,
    context: opts.context?.slice(0, 500),
    ts: Date.now(),
  };
  // 先落本地 chain (open)
  await writeChain({ ask, dissents: [], aligns: [], status: 'open', createdAt: Date.now() });
  // 上链
  const ok = await transport.sendMessage(peerDID, 'judgment_ask', encodeAskFrame(ask));
  console.log(`[judgment-protocol] ask -> ${peerDID.slice(0, 12)}: "${decision.slice(0, 40)}..." (${ok ? 'SENT' : 'FAIL'})`);
  judgmentEventBus.emit('judgment', { kind: 'ask_sent', askId: ask.askId, peerDID } satisfies JudgmentEvent);
  return ask;
}

async function sendDissentInternal(transport: IrohTransport, peerDID: string, dissent: JudgmentDissent): Promise<void> {
  // 落本地 chain
  const chain = await readChain(dissent.askId);
  if (chain && !chain.dissents.some((d) => d.dissentId === dissent.dissentId)) {
    chain.dissents.push(dissent);
    await writeChain(chain);
  }
  // 上链
  const ok = await transport.sendMessage(peerDID, 'judgment_dissent', encodeDissentFrame(dissent));
  console.log(`[judgment-protocol] dissent -> ${peerDID.slice(0, 12)}: ${dissent.dissents.length} 反方 (${ok ? 'SENT' : 'FAIL'})`);
  judgmentEventBus.emit('judgment', { kind: 'dissent_sent', dissentId: dissent.dissentId, askId: dissent.askId, peerDID } satisfies JudgmentEvent);
}

/**
 * 显式补发 dissent (例如收到 ask 后 LLM 还没好, 后续可重发更准的).
 * 协议上 dissent 在 ask 收到时自动回发, 这个 API 是给"主动想换反方"用的.
 */
export async function sendDissent(
  peerDID: string,
  askId: string,
  dissents: string[],
  transport: IrohTransport = defaultIrohTransport,
): Promise<JudgmentDissent> {
  ensureListeners(transport);
  if (dissents.length < 3 || dissents.length > 5) {
    throw new Error(`协议硬约束: dissent 必须 3-5 个, 实际 ${dissents.length}`);
  }
  const myNodeId = transport.getNodeId() || 'unknown';
  const dissent: JudgmentDissent = {
    dissentId: crypto.randomUUID(),
    askId,
    fromNodeId: myNodeId,
    dissents,
    ts: Date.now(),
  };
  await sendDissentInternal(transport, peerDID, dissent);
  return dissent;
}

/**
 * align — 显式协议消息, 必须基于 askId + 双方 dissentIds.
 * 协议校验: basedOn.dissentIds 必须非空 (否则视为"未基于互见").
 */
export async function sendAlign(
  peerDID: string,
  askId: string,
  conclusion: string,
  dissentIds: string[],
  transport: IrohTransport = defaultIrohTransport,
): Promise<JudgmentAlign> {
  ensureListeners(transport);
  if (dissentIds.length === 0) {
    throw new Error('协议硬约束: align 必须引用至少 1 条 dissent (否则不是基于反方互见)');
  }
  const myNodeId = transport.getNodeId() || 'unknown';
  const align: JudgmentAlign = {
    alignId: crypto.randomUUID(),
    askId,
    fromNodeId: myNodeId,
    conclusion,
    basedOn: { askId, dissentIds },
    ts: Date.now(),
  };
  // 落本地 chain
  const chain = await readChain(askId);
  if (chain) {
    chain.aligns.push(align);
    chain.status = 'aligned';
    chain.closedAt = Date.now();
    await writeChain(chain);
  }
  // 上链
  const ok = await transport.sendMessage(peerDID, 'judgment_align', encodeAlignFrame(align));
  console.log(`[judgment-protocol] align -> ${peerDID.slice(0, 12)}: "${conclusion.slice(0, 40)}..." (${ok ? 'SENT' : 'FAIL'})`);
  judgmentEventBus.emit('judgment', { kind: 'align_sent', alignId: align.alignId, askId, peerDID } satisfies JudgmentEvent);
  return align;
}

/**
 * reflect — 把整链 (ask + 所有 dissent + 所有 align) 沉淀成 1 个 HumanJudgment,
 * 写进 ~/.bolloon/judgments/yaml/{askId}.yaml, 并调 storeHumanJudgment 注入判断力库.
 * 这是协议的"复利起点": 下次 distillDissent 会看到这条.
 */
export async function reflect(askId: string, transport: IrohTransport = defaultIrohTransport): Promise<{ judgmentId: string; yamlPath: string } | null> {
  const chain = await readChain(askId);
  if (!chain) return null;
  if (chain.status === 'reflected') {
    console.warn(`[judgment-protocol] ask ${askId} 已 reflect 过, 跳过`);
    return null;
  }

  // 1) 序列化整链成 yaml (手搓, 避免引 js-yaml 依赖)
  const yamlLines: string[] = [];
  yamlLines.push(`# bolloon judgment reflection`);
  yamlLines.push(`# generated: ${new Date().toISOString()}`);
  yamlLines.push(`askId: ${chain.ask.askId}`);
  yamlLines.push(`decision: ${yamlEscape(chain.ask.decision)}`);
  yamlLines.push(`proposer: ${chain.ask.proposerNodeId}`);
  yamlLines.push(`createdAt: "${new Date(chain.createdAt).toISOString()}"`);
  yamlLines.push(`status: reflected`);
  yamlLines.push('');
  yamlLines.push(`dissents:`);
  for (const d of chain.dissents) {
    yamlLines.push(`  - from: ${d.fromNodeId}`);
    yamlLines.push(`    ts: "${new Date(d.ts).toISOString()}"`);
    yamlLines.push(`    points:`);
    for (const p of d.dissents) {
      yamlLines.push(`      - ${yamlEscape(p)}`);
    }
  }
  yamlLines.push('');
  yamlLines.push(`aligns:`);
  for (const a of chain.aligns) {
    yamlLines.push(`  - from: ${a.fromNodeId}`);
    yamlLines.push(`    ts: "${new Date(a.ts).toISOString()}"`);
    yamlLines.push(`    conclusion: ${yamlEscape(a.conclusion)}`);
    yamlLines.push(`    basedOnDissentIds: [${a.basedOn.dissentIds.join(', ')}]`);
  }
  yamlLines.push('');

  await ensureDirs();
  const yPath = path.join(yamlDir(), `${askId}.yaml`);
  await fs.writeFile(yPath, yamlLines.join('\n'), 'utf-8');

  // 2) 注入判断力库 (供下次 distillDissent 用)
  let judgmentId = '';
  try {
    // 找出我方的 dissent (如果有) 作为本节点判断
    const myNodeId = transport.getNodeId() || '';
    const myDissent = chain.dissents.find((d) => d.fromNodeId === myNodeId);
    const lastAlign = chain.aligns[chain.aligns.length - 1];

    const stored = await storeHumanJudgment({
      decision: `judgment-protocol: ${chain.ask.decision.slice(0, 80)}`,
      reasoning: [
        `ask: ${chain.ask.decision}`,
        myDissent ? `my-dissent: ${myDissent.dissents.join(' / ')}` : '',
        lastAlign ? `conclusion: ${lastAlign.conclusion}` : '',
      ].filter(Boolean),
      confidence: chain.aligns.length > 0 ? 0.8 : 0.5,
      domain: 'judgment-protocol',
      tags: ['judgment-protocol', `ask:${askId.slice(0, 8)}`],
      source: 'judgment-protocol',
    } as any);
    judgmentId = stored.id;
  } catch (e) {
    console.warn('[judgment-protocol] storeHumanJudgment 失败 (yaml 已写):', (e as Error).message);
  }

  // 3) 更新 chain 状态
  chain.status = 'reflected';
  chain.closedAt = Date.now();
  await writeChain(chain);

  console.log(`[judgment-protocol] reflect 完成: askId=${askId.slice(0, 8)} yaml=${yPath}`);
  judgmentEventBus.emit('judgment', { kind: 'reflected', askId, judgmentId } satisfies JudgmentEvent);
  return { judgmentId, yamlPath: yPath };
}

/** 读 ask 的整链 (UI / CLI 用) */
export async function getChain(askId: string): Promise<JudgmentChain | null> {
  return readChain(askId);
}

/** 列所有 ask (按时间倒序) */
export async function listChains(limit = 50): Promise<JudgmentChain[]> {
  await ensureDirs();
  const files = (await fs.readdir(chainsDir()))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: JudgmentChain[] = [];
  for (const f of files) {
    try {
      const buf = await fs.readFile(path.join(chainsDir(), f), 'utf-8');
      out.push(JSON.parse(buf) as JudgmentChain);
    } catch {}
  }
  return out;
}

// yaml 字符串转义: 包单引号, 单引号变两个
function yamlEscape(s: string): string {
  if (!s) return "''";
  // 单行无特殊字符 → 直接包单引号
  if (!/['"\\:#\n]/.test(s) && s.length < 200) return `'${s.replace(/'/g, "''")}'`;
  // 多行 → block scalar
  return `|\n    ${s.replace(/\n/g, '\n    ')}`;
}

// ============================================================================
// 顶层导出 (CLI / Web 调)
// ============================================================================

export const judgmentProtocol = {
  init: initJudgmentProtocol,
  sendAsk,
  sendDissent,
  sendAlign,
  reflect,
  distillDissent,
  getChain,
  listChains,
};
