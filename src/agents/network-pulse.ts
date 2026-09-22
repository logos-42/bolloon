/**
 * network-pulse.ts — 网络脉冲 (Network Pulse): 把已有 P2P 生命周期投影成
 * **匿名、可验证、可降级**的公开统计, 供 bolloon-UI 网关页动态展示。
 *
 * 设计约束 (leo 2026-09-18 计划):
 *   · 只对**公开统计**有用的事实留档: 不存任务正文、不存私有 payload
 *   · 浏览器**永远不接触原始事件** —— 对外只有聚合快照
 *   · 不暴露 DID / peerId / IP / 钱包地址 / Agent 私有内容
 *   · 单节点看到的数据**不许说成全网精确总量**: scope=observed / verified 明确写在快照里
 *   · 快照过期 → `stale` (不许伪装实时); 观察层不可用 → `unavailable`
 *   · 类别小于隐私阈值 → 合并进 other
 *   · 事件数 / 时间窗 / capability 数都有上限
 *   · **冻结形状 `confirmed_activity`** (2026-09-22): 公开页面要能列出「哪个任务 · 什么状态 ·
 *     哪个块 · 多少确认」, 而不是只有数字 —— 数据源优先 P5 链上索引, 不可用时退回脉冲事件并
 *     用 `confirmed_activity_source` 标注; 标识一律 sha256 短写 (前 8 位), 绝不落 taskKey /
 *     taskId / txHash 原文; 不够确认门槛的行只报 observed, 不冒充 confirmed。
 *
 * 借鉴 (只借产品与工程思想, 不借 Go/Postgres/API 项目):
 *   EigenFlux 的 "注册总量 / 当前活跃 / 最近出现" 时间窗统计、服务端生成匿名活动文本、
 *   live/stale/unavailable 状态、短缓存与时间边界、隐私阈值、白名单投影。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
// 确认数门槛来自 chain-config (单一实现; 默认 confirmed=1 / finalized=12) —— 只借常量, 不借 RPC
import { DEFAULT_CONFIRMATIONS, LOCAL_DEV_CHAIN_ID } from './chain/chain-config.js';

// ── 常量 (上限 + 时间边界) ─────────────────────────────────────────────────

export const PULSE_LIMITS = {
  /** 最多留多少条事件 (超出丢最旧) */
  maxEvents: 5000,
  /** 统计窗口 */
  windowMs: 24 * 60 * 60 * 1000,
  /** "活跃"的定义: 最近 5 分钟出现过 */
  activeWindowMs: 5 * 60 * 1000,
  /** 时间桶 (小时) */
  bucketMs: 60 * 60 * 1000,
  /** 对外最多列多少个 capability 类别 */
  maxCapabilities: 12,
  /** 隐私阈值: 少于这个数的类别合并进 other */
  privacyThreshold: 3,
  /** 快照新鲜期 (秒) → 之后 stale */
  snapshotTtlMs: 30 * 1000,
  /** 活动流最多几条 */
  maxActivity: 8,
  /** confirmed_activity (冻结形状的真实活动行) 上限 */
  maxConfirmedActivity: 25,
} as const;

/** 事件类型白名单 —— 只允许这些进统计 (其余一律丢弃) */
export const NETWORK_EVENT_TYPES = [
  'node_joined',
  'manifest_published',
  'capability_announced',
  'peer_connected',
  'delegation_completed',
  // 经济事件 (P6 扩展; 原五类保持兼容, 老节点发来的事件仍被接受)
  'task_posted', 'task_accepted', 'task_completed', 'trade_settled', 'trade_verified',
  'wallet_signed',
] as const;
export type NetworkEventType = (typeof NETWORK_EVENT_TYPES)[number];

export interface NetworkPulseEvent {
  type: NetworkEventType;
  /** 时间桶 (epoch 小时) —— 便于按桶聚合 */
  bucket: string;
  /** 粗粒度能力类别 (不外泄原始能力名) */
  capabilityGroup?: string;
  occurredAt: number;
  /** 匿名节点摘要 (sha256(did) 前 16 位), 绝不落原始 DID */
  sourceProof: string;
  /** 可选: Agent 摘要 (sha256(did:agentId) 前 16 位) */
  agentProof?: string;
  /** 任务摘要 (sha256 前 16 位; 只用于按任务去重, 绝不存 taskId 原文) */
  taskProof?: string;
  /** 这条事件是否来自一个签名来源 (决定 scope 能否升到 verified) */
  signed?: boolean;
  /** 签名覆盖 (可选): hmac(secret, payload) 前 32 位, 用于本地完整性校验 */
  integrity?: string;
}

export interface NetworkPulseSnapshot {
  status: 'live' | 'stale' | 'unavailable';
  generated_at: number;
  fresh_until: number;
  /** observed = 当前节点观察到的; verified = 多签名来源汇总观察快照 (都不是"全网精确总量") */
  scope: 'observed' | 'verified';
  scope_label: { zh: string; en: string };
  /**
   * ★ 聚合计数 —— 口径 = **本节点 24h 观察窗口内的脉冲事件** (不是链上索引, 不是全网精确总量)。
   * 老客户端一直读这块, 字段一个都没动; 与活动行同源的计数见 `activity_totals`,
   * 口径差异写在 `totals_scope` + `notes` (两套数字同屏出现时**必须**有口径说明)。
   */
  totals: {
    nodes: number;
    agents: number;
    active_agents: number;
    seen_last_24h: number;
    /** 观察到发起的任务数 (聚合计数, 无任务内容) */
    tasks: number;
    tasks_completed: number;
    tasks_verified: number;
    /** 钱包签名次数 (本机/网络里真实发生的签名, 只计数不给内容) */
    signatures: number;
  };
  /** ★ totals.* 的口径说明 (24h 脉冲事件窗口) —— 与 activity_totals 口径不同, 不许"打架"不许不解释 */
  totals_scope: TotalsScope;
  capabilities: { key: string; count: number }[];
  recent_activity: { kind: NetworkEventType; at: number; text: { zh: string; en: string } }[];
  /**
   * ★ 冻结形状的真实活动行 (智能体任务 / 链上活动): 最新在前, 上限 25 行。
   * 公开网页靠它列出「哪个任务 · 什么状态 · 哪个块 · 多少确认」, 而不是只有数字。
   * 只有匿名短写 (sha256 前 8 位), 没有 taskKey / taskId / txHash 原文。
   */
  confirmed_activity: ConfirmedActivityRow[];
  /** ★ 活动行来源: chain-index (真链上事实) · pulse-events (索引不可用时的降级, 非链上确认) · none */
  confirmed_activity_source: ConfirmedActivitySource;
  /**
   * ★ 与 `confirmed_activity` **完全同源**的计数 (同一批行、同一时刻算出来的)。
   * `rows` 恒等于 `confirmed_activity.length`; 公开页同时展示两套计数时靠它对齐口径。
   */
  activity_totals: ActivityTotals;
  /** ★ 上表各行属于哪条链 (公开页不许把本机开发链的行读成公网活动) */
  chain_id_scope: ChainIdScope;
  /** 快照签名 (可选, 供公开观察入口校验) */
  signature?: string;
  signer_fingerprint?: string;
  notes: string[];
}

// ── 存储 ────────────────────────────────────────────────────────────────────

const home = (h?: string): string => h || process.env.HOME || os.homedir() || '/tmp';
export const pulseDir = (h?: string): string => path.join(home(h), '.bolloon', 'network-pulse');
const eventsFile = (h?: string): string => path.join(pulseDir(h), 'events.json');
const snapshotFile = (h?: string): string => path.join(pulseDir(h), 'snapshot.json');

/** 是否是一条结构合法的事件 (坏数据一律丢弃, 不让快照崩) */
function isValidEvent(e: any): e is NetworkPulseEvent {
  return !!e && typeof e === 'object'
    && NETWORK_EVENT_TYPES.includes(e.type)
    && typeof e.sourceProof === 'string' && e.sourceProof.length > 0
    && Number.isFinite(e.occurredAt);
}

function readEvents(h?: string): NetworkPulseEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(eventsFile(h), 'utf-8'));
    return Array.isArray(raw) ? raw.filter(isValidEvent) : [];
  } catch {
    return [];
  }
}

function writeEvents(list: NetworkPulseEvent[], h?: string): void {
  try {
    fs.mkdirSync(pulseDir(h), { recursive: true });
    fs.writeFileSync(eventsFile(h), JSON.stringify(list.slice(-PULSE_LIMITS.maxEvents)), 'utf8');
  } catch {
    /* 统计失败绝不影响主路径 */
  }
}

// ── 匿名化 ──────────────────────────────────────────────────────────────────

/** 节点摘要: sha256(值) 前 16 位。不可逆, 不暴露原值。 */
export function nodeDigest(value: string): string {
  return crypto.createHash('sha256').update(`bolloon-pulse|${String(value)}`).digest('hex').slice(0, 16);
}

const CAPABILITY_GROUPS: Array<[RegExp, string]> = [
  [/research|market|调研|分析|survey|search/i, 'research'],
  [/code|review|refactor|debug|编程|代码/i, 'coding'],
  [/data|dataset|etl|metric|数据/i, 'data'],
  [/write|content|doc|translat|写作|文档|翻译/i, 'writing'],
  [/automation|workflow|deploy|ops|自动化/i, 'automation'],
  [/vision|image|audio|speech|视觉|图像|语音/i, 'multimodal'],
];

/** 把原始能力名归并成粗类别 (不外泄原始能力名) */
export function capabilityGroup(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return 'other';
  for (const [re, g] of CAPABILITY_GROUPS) if (re.test(s)) return g;
  return 'other';
}

export function bucketOf(at: number): string {
  return String(Math.floor(at / PULSE_LIMITS.bucketMs));
}

// ── 写事件 ──────────────────────────────────────────────────────────────────

export interface RecordEventInput {
  type: string;
  /** 原始能力名 (会被归并成粗类别) */
  capability?: string;
  /** 原始 DID / peerId (只用于算摘要, 绝不落盘) */
  did?: string;
  /** Agent 标识 (只用于算摘要) */
  agentId?: string;
  /** 任务标识 (只用于算摘要) —— 任务正文/任务 ID 绝不落盘 */
  taskId?: string;
  at?: number;
  signed?: boolean;
}

/** 完整性标记 (本地校验用; 不含任何可逆信息) */
function integrityOf(ev: Pick<NetworkPulseEvent, 'type' | 'bucket' | 'sourceProof' | 'occurredAt'>): string {
  return nodeDigest(`${ev.type}|${ev.bucket}|${ev.sourceProof}|${ev.occurredAt}`);
}

/**
 * 记一条网络事件。**永不影响主路径**: 非法类型/写失败/异常一律静默丢弃。
 * 幂等: 同一节点同一桶内的 `node_joined` 只记一次 (重复 join 不虚增节点数)。
 */
export async function recordNetworkEvent(input: RecordEventInput, h?: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const type = String(input?.type || '') as NetworkEventType;
    if (!NETWORK_EVENT_TYPES.includes(type)) return { ok: false, reason: `非白名单事件类型: ${type}` };
    const at = Number(input.at ?? Date.now());
    if (!Number.isFinite(at) || at <= 0) return { ok: false, reason: 'occurredAt 非法' };
    const sourceProof = nodeDigest(String(input.did || 'unknown-node'));
    const bucket = bucketOf(at);
    const agentProof = input.agentId ? nodeDigest(`${String(input.did || 'unknown-node')}:${String(input.agentId)}`) : undefined;
    const taskProof = input.taskId ? nodeDigest(`task:${String(input.taskId)}`) : undefined;

    const list = readEvents(h);
    if (type === 'node_joined' && list.some((e) => e.type === 'node_joined' && e.sourceProof === sourceProof && e.bucket === bucket)) {
      return { ok: true, reason: 'already' };   // 同桶重复入网不虚增
    }
    const ev: NetworkPulseEvent = {
      type,
      bucket,
      occurredAt: at,
      sourceProof,
      ...(input.capability ? { capabilityGroup: capabilityGroup(input.capability) } : {}),
      ...(agentProof ? { agentProof } : {}),
      ...(taskProof ? { taskProof } : {}),
      ...(input.signed ? { signed: true } : {}),
    };
    ev.integrity = integrityOf(ev);
    list.push(ev);
    // 只保留窗口内 + 上限
    const cutoff = at - PULSE_LIMITS.windowMs;
    writeEvents(list.filter((e) => e.occurredAt >= cutoff), h);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// ── 快照 ────────────────────────────────────────────────────────────────────

/** 服务端固定模板生成匿名活动文本 (不让前端拼字符串) */
export function renderActivityText(kind: NetworkEventType): { zh: string; en: string } {
  switch (kind) {
    case 'node_joined': return { zh: '有新节点加入网络', en: 'A node joined the network' };
    case 'manifest_published': return { zh: '有节点发布/更新了能力声明', en: 'A node published or updated its manifest' };
    case 'capability_announced': return { zh: '有节点公开声明了新能力', en: 'A node announced a capability' };
    case 'peer_connected': return { zh: '两个节点建立了连接', en: 'Two nodes connected' };
    case 'delegation_completed': return { zh: '一次能力委派完成', en: 'A delegation completed' };
    default: return { zh: '网络有活动', en: 'Network activity' };
  }
}

export interface SnapshotOptions {
  home?: string;
  now?: number;
  /** 强制重算 (忽略缓存) */
  force?: boolean;
  /** 观察层不可用时置 true → 返回 unavailable */
  unavailable?: boolean;
}

/** 纯函数: 从事件列表算出快照 (便于单测; 不做 IO) */
/** 本节点显式发布的智能体私有站 (IPNS) —— 公开指针, 由站长自己决定放什么 */
export interface AgentSite {
  label: string;
  ipns: string;
  added_at: number;
}

export const MAX_AGENT_SITES = 5;

/** 归一化 IPNS 标识: 只接受裸 k51…/12D3… · ipns://… · /ipns/… —— 其它一律拒绝 (不猜、不放行) */
export function normalizeIpns(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let v = s;
  if (/^ipns:\/\//i.test(v)) v = v.replace(/^ipns:\/\//i, '');
  else if (/^\/ipns\//i.test(v)) v = v.replace(/^\/ipns\//i, '');
  else if (/https?:\/\//i.test(v)) return null;          // 不接受 http(s) 直链
  v = v.split(/[/?#]/)[0].trim();
  if (/^(k51|12D3)[a-zA-Z0-9]{20,}$/.test(v) || /^[a-zA-Z0-9]{46,}$/.test(v)) return v;
  return null;
}

/** 读本节点显式发布的私有站清单 (~/.bolloon/agent-sites.json); 不存在/坏数据 → 空数组 */
export function readAgentSites(h?: string): AgentSite[] {
  try {
    const file = path.join(home(h), '.bolloon', 'agent-sites.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    const out: AgentSite[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const ipns = normalizeIpns(item?.ipns);
      if (!ipns || seen.has(ipns)) continue;
      seen.add(ipns);
      out.push({
        label: String(item?.label || 'agent').slice(0, 40),
        ipns,
        added_at: Number(item?.added_at) || 0,
      });
      if (out.length >= MAX_AGENT_SITES) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 把**真实交易活动**投影成脉冲事件 (由交易写路径调用, fire-and-forget)。
 * 只按事实发: 交付 → task_completed · 真验真 → trade_verified · **链上口径**结算 → trade_settled。
 * local-dev 上限是 payment_submitted, 永远进不了 trade_settled 那一支 —— 不冒充链上。
 */
export async function emitTradePulse(before: any, after: any, h?: string): Promise<void> {
  try {
    if (!after) return;
    const taskId = String(after.requestId || after.transactionId || '');
    if (!taskId) return;
    const did = String(after.buyerDid || after.providerDid || after.payTo || after.paymentMode || 'unknown-node');
    const agentId = String(after.agentId || after.runId || after.goalId || '') || undefined;
    const base = { did, agentId, taskId, signed: true } as any;
    if (after.status === 'delivered' && before?.status !== 'delivered') {
      await recordNetworkEvent({ type: 'task_completed', ...base }, h);
    }
    if (after.status === 'verified' && before?.status !== 'verified') {
      await recordNetworkEvent({ type: 'trade_verified', ...base }, h);
    }
    if (after.settlementFact === 'fully_settled' && before?.settlementFact !== 'fully_settled') {
      await recordNetworkEvent({ type: 'trade_settled', ...base }, h);
    }
  } catch {
    /* 统计失败绝不影响交易主路径 */
  }
}

// ── 冻结形状: confirmed_activity (真实智能体任务 / 链上活动行) ────────────────
//
// 公开网页要能列出「哪个任务 · 什么状态 · 哪个块 · 多少确认」, 而不是只有数字。这块就是那批行。
// 形状**冻结** (字段名与取值域不许改), 内容一律**匿名短写**:
//   · task = `sha256:` + sha256(域标签|taskKey) 的前 8 位十六进制 —— 绝不落 taskKey / taskId 原文
//   · tx   = `sha256:` + sha256(域标签|txHash)  的前 8 位十六进制 —— 绝不落 txHash 原文
//   · 不出现 DID / peerId / IP / 完整钱包地址 / 任务正文 —— `assertNoPrivateFields` 兜底
// 数据源优先级: ① P5 链上索引 (真链上事实) → ② 索引不可用 → 退回脉冲事件, 并在快照里用
//   `confirmed_activity_source` 如实标注 (chain-index / pulse-events / none)。
// 确认数口径走 chain-config 门槛 (默认 confirmed=1 / finalized=12): 够不着门槛的行只报
//   `observed`, **绝不冒充** confirmed/finalized。

/** 冻结形状: 活动行上限 */
export const CONFIRMED_ACTIVITY_LIMIT = PULSE_LIMITS.maxConfirmedActivity;

export type ConfirmedActivityKind = 'task_created' | 'task_accepted' | 'task_completed' | 'trade_settled' | 'trade_verified';
export type ConfirmedActivityState = 'active' | 'released' | 'refunded' | 'expired' | 'disputed' | 'unknown';
export type ConfirmedActivityFinality = 'observed' | 'confirmed' | 'finalized';
export type ConfirmedActivitySource = 'chain-index' | 'pulse-events' | 'none';

/** 冻结形状的一行 (字段名/顺序逐字固定 —— 老客户端不受影响, 新页面按它渲染) */
export interface ConfirmedActivityRow {
  /** 任务摘要: `sha256:<前 8 位十六进制>` (taskKey / taskId 的 sha256 短写, 不可逆) */
  task: string;
  kind: ConfirmedActivityKind;
  state: ConfirmedActivityState;
  /** 链 id (脉冲降级行没有链上事实 → 0) */
  chain_id: number;
  /** 区块号 (脉冲降级行 → 0) */
  block: number;
  /** 交易摘要: `sha256:<前 8 位十六进制>` (txHash 的 sha256 短写, 不可逆) */
  tx: string;
  /** 确认数 (脉冲降级行 → 0) */
  confirmations: number;
  finality: ConfirmedActivityFinality;
  /**
   * 时间 (ISO8601 UTC, 秒级, 如 `2026-09-22T05:31:00Z`)。
   * 链上索引行 = 本节点**首次观察到该条链上事件**的时间 (索引不存区块时间戳 —— 不臆造);
   * 脉冲降级行 = 事件发生时间。字段名冻结, 故不为"区块时间"另开字段。
   */
  at: string;
}

export interface ConfirmedActivityGates { confirmed: number; finalized: number }

/**
 * 链上 escrow 事件名 → (kind, state) 的**唯一**映射表 (改这里才对, 别在别处写 switch)。
 *
 * kind 只能取冻结枚举的 5 个值, 链上有 6 类事件 → 按「任务生命周期 / 托管资金路径」归并:
 *   · EscrowCreatedV2  委托创建 + 资金入托管              → task_created   / active
 *   · ProofSubmittedV2 交付物验真摘要落链 (= 该笔交付完成) → task_completed / active (托管仍 ACTIVE, 等结算)
 *   · ReleasedV2       结算出金                            → trade_settled  / released
 *   · RefundedV2       托管退款                            → trade_settled  / refunded
 *   · ExpiredV2        托管到期                            → trade_settled  / expired
 *   · DisputedV2       资金冻结进入争议 (托管资金路径)      → trade_settled  / disputed
 * 真信号在 `state` (kind 只是粗桶); 事件名不在表里 → 该条**不成行** (不猜)。
 */
export const CHAIN_EVENT_ACTIVITY: Record<string, { kind: ConfirmedActivityKind; state: ConfirmedActivityState }> = {
  EscrowCreatedV2: { kind: 'task_created', state: 'active' },
  ProofSubmittedV2: { kind: 'task_completed', state: 'active' },
  ReleasedV2: { kind: 'trade_settled', state: 'released' },
  RefundedV2: { kind: 'trade_settled', state: 'refunded' },
  ExpiredV2: { kind: 'trade_settled', state: 'expired' },
  DisputedV2: { kind: 'trade_settled', state: 'disputed' },
};

/** 脉冲事件 → 冻结 kind 的映射 (索引不可用时的降级路径; 没有 taskProof 的事件不成行) */
export const PULSE_EVENT_ACTIVITY: Partial<Record<NetworkEventType, ConfirmedActivityKind>> = {
  task_posted: 'task_created',
  task_accepted: 'task_accepted',
  task_completed: 'task_completed',
  trade_settled: 'trade_settled',
  trade_verified: 'trade_verified',
};

/** 标识 → `sha256:<前 8 位十六进制>`。域标签隔离用途: 同一原值稳定 (可 join), 不同用途不串, 不可逆。 */
export function anonShortRef(value: string, domain = 'id'): string {
  return `sha256:${nodeDigest(`${domain}|${String(value)}`).slice(0, 8)}`;
}

/** ISO8601 UTC 秒级 (`2026-09-22T05:31:00Z`) —— 冻结形状里 `at` 的格式。非法时间 → null */
export function isoSeconds(at: number): string | null {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return null;
  try { return new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch { return null; }
}

/** 确认门槛归一化: 缺/非法 → chain-config 默认 (1/12); finalized 不许低于 confirmed */
export function normalizeActivityGates(g?: Partial<ConfirmedActivityGates> | null): ConfirmedActivityGates {
  const c = Number(g?.confirmed);
  const f = Number(g?.finalized);
  const confirmed = Number.isInteger(c) && c > 0 ? c : DEFAULT_CONFIRMATIONS.confirmed;
  const finalized = Number.isInteger(f) && f >= confirmed ? f : Math.max(confirmed, DEFAULT_CONFIRMATIONS.finalized);
  return { confirmed, finalized };
}

/**
 * finality **只按确认数复算** (单一实现): 够 finalized → finalized; 够 confirmed → confirmed;
 * 不够 / 非法 / 被回退过 → observed。行里原本自报的 finality 一律不复用 —— 不满足就是 observed。
 */
export function finalityFromConfirmations(
  confirmations: number,
  gates?: Partial<ConfirmedActivityGates> | null,
  opts: { suspect?: boolean } = {},
): ConfirmedActivityFinality {
  if (opts.suspect) return 'observed';
  const g = normalizeActivityGates(gates);
  const c = Number(confirmations);
  if (!Number.isFinite(c) || c < g.confirmed) return 'observed';
  return c >= g.finalized ? 'finalized' : 'confirmed';
}

function activityLimit(limit?: number): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return CONFIRMED_ACTIVITY_LIMIT;
  return Math.max(0, Math.min(CONFIRMED_ACTIVITY_LIMIT, n));
}

/** 我们只用到链上索引条目的这几个字段 (结构类型 → 单测可直接喂夹具, 不必构造整个 indexer) */
export interface ChainActivitySourceEntry {
  blockNumber: number;
  logIndex: number;
  eventName: string;
  taskKey: string;
  txHash: string;
  /** 同步当时的确认数 (给了 headBlock 时以 headBlock 复算为准) */
  confirmations?: number;
  /** 被回退 / 链上已消失 → 不成行 */
  suspect?: boolean;
  /** 本节点首次观察到该事件的时间 */
  firstSeenAt?: number | null;
}

/**
 * 链上索引条目 → 冻结活动行 (**纯函数**, 不读盘不发 RPC, 便于单测)。
 *   · suspect (被回退 / 链上已消失) 的记录**不成行** —— 它已经不在规范链上, 不该当活动列出
 *   · 不认识的事件名 / 非法 taskKey·txHash / 缺观察时间 → 跳过 (不猜、不臆造)
 *   · confirmations: 有 headBlock → head - block + 1 复算 (无 RPC, 用索引快照里的 head); 否则用记录值
 *   · finality: 按 chain-config 门槛复算 (不够 → observed)
 *   · 最新在前 (blockNumber desc, logIndex desc), 上限 25 行
 */
export function buildConfirmedActivityFromIndex(
  entries: ChainActivitySourceEntry[],
  opts: { gates?: Partial<ConfirmedActivityGates> | null; headBlock?: number | null; chainId?: number; limit?: number } = {},
): ConfirmedActivityRow[] {
  const gates = normalizeActivityGates(opts.gates);
  const limit = activityLimit(opts.limit);
  const chainId = Number.isInteger(Number(opts.chainId)) && Number(opts.chainId) >= 0 ? Number(opts.chainId) : 0;
  const head = Number.isInteger(Number(opts.headBlock)) && Number(opts.headBlock) >= 0 ? Number(opts.headBlock) : null;
  const out: Array<{ row: ConfirmedActivityRow; block: number; logIndex: number }> = [];

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.suspect === true) continue;                       // 回退过的记录不在规范链上 → 不成行
    const map = CHAIN_EVENT_ACTIVITY[String(e.eventName || '')];
    if (!map) continue;                                          // 不认识的事件 → 跳过 (不猜)
    const taskKey = String(e.taskKey || '').toLowerCase();
    const txHash = String(e.txHash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(taskKey) || !/^0x[0-9a-f]{64}$/.test(txHash)) continue;
    const block = Number(e.blockNumber);
    const logIndex = Number(e.logIndex);
    if (!Number.isInteger(block) || block < 0 || !Number.isInteger(logIndex) || logIndex < 0) continue;
    const atMs = Number(e.firstSeenAt);
    const at = isoSeconds(atMs);
    if (!at) continue;                                           // 没观察时间 → 不臆造时间, 不成行
    const confirmations = head == null ? Math.max(0, Number(e.confirmations) || 0) : Math.max(0, head - block + 1);
    out.push({
      block, logIndex,
      row: {
        task: anonShortRef(taskKey, 'task'),
        kind: map.kind,
        state: map.state,
        chain_id: chainId,
        block,
        tx: anonShortRef(txHash, 'tx'),
        confirmations,
        finality: finalityFromConfirmations(confirmations, gates),
        at,
      },
    });
  }

  out.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
  return out.slice(0, limit).map((x) => x.row);
}

/**
 * 脉冲事件 → 冻结活动行 (**纯函数**, 索引不可用时的降级路径)。
 *   · 只有带 taskProof 的经济事件成行; state 一律 `unknown` —— 脉冲事件不带 escrow 结局, 不推
 *   · 没有链上事实: chain_id / block / confirmations = 0, finality = observed (绝不冒充已确认)
 *   · tx = 事件摘要短写 (不是交易哈希 —— 降级行没有 txHash, 字段名冻结只能这样填)
 *   · 同一 (task, kind) 只留最新一条; 最新在前, 上限 25 行
 */
export function buildConfirmedActivityFromEvents(
  events: NetworkPulseEvent[],
  opts: { limit?: number } = {},
): ConfirmedActivityRow[] {
  const limit = activityLimit(opts.limit);
  if (limit <= 0) return [];
  const all: Array<{ at: number; row: ConfirmedActivityRow }> = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!isValidEvent(e)) continue;
    const kind = PULSE_EVENT_ACTIVITY[e.type];
    if (!kind) continue;                                          // 非经济事件 (入网/能力/连接…) → 不成行
    const proof = String((e as any).taskProof || '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(proof)) continue;                  // 没有任务摘要 → 不成行
    const at = isoSeconds(e.occurredAt);
    if (!at) continue;
    all.push({
      at: e.occurredAt,
      row: {
        task: `sha256:${proof.slice(0, 8)}`,
        kind,
        state: 'unknown',
        chain_id: 0,
        block: 0,
        tx: anonShortRef(`pulse|${e.sourceProof}|${e.occurredAt}|${e.type}`, 'tx'),
        confirmations: 0,
        finality: 'observed',
        at,
      },
    });
  }
  all.sort((a, b) => b.at - a.at);                                // 最新在前
  const seen = new Set<string>();
  const rows: ConfirmedActivityRow[] = [];
  for (const x of all) {
    const key = `${x.row.task}|${x.row.kind}`;
    if (seen.has(key)) continue;                                  // 同一任务同一动作只留最新一条
    seen.add(key);
    rows.push(x.row);
    if (rows.length >= limit) break;
  }
  return rows;
}

export interface ConfirmedActivityResult {
  source: ConfirmedActivitySource;
  rows: ConfirmedActivityRow[];
  gates: ConfirmedActivityGates;
}

/** 纯函数降级: 直接从脉冲事件算活动行 (没有索引时用, source 如实写 pulse-events / none) */
export function confirmedActivityFromEvents(events: NetworkPulseEvent[], limit?: number): ConfirmedActivityResult {
  const rows = buildConfirmedActivityFromEvents(events, { limit });
  return { source: rows.length ? 'pulse-events' : 'none', rows, gates: normalizeActivityGates(DEFAULT_CONFIRMATIONS) };
}

/** 惰性加载链上索引只读查询模块 (只读索引文件, 不发 RPC; 加载/读取失败 → 降级) */
let chainQueryModule: { readIndexFile: (opts?: { home?: string }) => unknown } | null = null;
async function readChainIndex(home?: string): Promise<unknown | null> {
  try {
    if (!chainQueryModule) chainQueryModule = (await import('./chain/chain-index-query.js')) as any;
    return chainQueryModule!.readIndexFile({ home });
  } catch {
    return null;
  }
}

export interface ConfirmedActivityQuery {
  home?: string;
  /** 脉冲事件 (降级路径用; 会在内部按 24h 窗口过滤) */
  events: NetworkPulseEvent[];
  now?: number;
  limit?: number;
  /** 单测注入: 读链上索引 (抛错 / 返回空 = 索引不可用 → 降级到脉冲事件) */
  readIndex?: (home?: string) => unknown | Promise<unknown>;
}

/**
 * 解析活动行 (唯一入口): **先链上索引, 再脉冲降级**, 并如实报出来源。
 * 索引文件不存在/读不出/没有任何可用行 → 退回脉冲事件; 两边都没有 → none (不编行)。
 */
export async function resolveConfirmedActivity(q: ConfirmedActivityQuery): Promise<ConfirmedActivityResult> {
  const now = Number(q.now ?? Date.now());
  const limit = activityLimit(q.limit);
  const windowed = (Array.isArray(q.events) ? q.events : [])
    .filter((e) => isValidEvent(e) && e.occurredAt >= now - PULSE_LIMITS.windowMs);

  // ① 链上索引优先 (真链上事实)
  const reader = q.readIndex ?? readChainIndex;
  try {
    const file: any = await reader(q.home);
    const entries: ChainActivitySourceEntry[] = Array.isArray(file?.entries) ? file.entries : [];
    if (entries.length > 0) {
      const gates = normalizeActivityGates(file?.confirmations);
      const rows = buildConfirmedActivityFromIndex(entries, {
        gates,
        headBlock: file?.headBlock,
        chainId: file?.chainId,
        limit,
      });
      if (rows.length > 0) return { source: 'chain-index', rows, gates };
    }
  } catch { /* 索引不可用 → 降级 (来源会在快照里标明) */ }

  // ② 降级: 脉冲事件
  return confirmedActivityFromEvents(windowed, limit);
}

// ── 同源计数 · 口径说明 · 链归属 (2026-09-22: 公开页数字不许自相矛盾) ──────────
//
// 起因: 真快照里 `totals.tasks=0` 而 `confirmed_activity` 有 25 行真实任务 —— 两块数据来自
// **两套口径** (totals = 24h 脉冲事件窗口; confirmed_activity = 链上索引全量), 但页面上它们同屏,
// 读者只会读成"自相矛盾/在撒谎"。修法不是把数字改漂亮, 而是:
//   ① `activity_totals` = 与 confirmed_activity **同源**的计数 (rows 恒等于该数组长度);
//   ② `totals_scope`   = totals 的口径说明 + `differs_from_activity` 标记;
//   ③ `chain_id_scope` = 上表各行属于哪条链 (本机 31337 ≠ 真网 Base Sepolia 84532);
//   ④ `snapshotConsistencyIssues` = 导出前的自检 (两个数字打架就拒绝导出)。

/** 公网测试网 (Base Sepolia) chainId —— 只做**归属说明**, 不代表快照观察到了公网事件 */
export const PUBLIC_TESTNET_CHAIN_ID = 84532;

/**
 * chainId → 展示用网络名 (只回答"这一屏的行属于哪条链")。
 * 认不出的 chain id **不编名字** (chainLabelOf → null), 也不许算成公网。
 */
export const CHAIN_LABELS: Record<number, { zh: string; en: string; publicNetwork: boolean }> = {
  [LOCAL_DEV_CHAIN_ID]: { zh: '本机隔离开发链', en: 'local isolated dev chain', publicNetwork: false },
  [PUBLIC_TESTNET_CHAIN_ID]: { zh: 'Base Sepolia 测试网', en: 'Base Sepolia testnet', publicNetwork: true },
};

/** chainId 的展示名; 认不出的 chain id → null (不编名字) */
export function chainLabelOf(chainId: number): { zh: string; en: string; publicNetwork: boolean } | null {
  const id = Number(chainId);
  return Number.isInteger(id) ? CHAIN_LABELS[id] ?? null : null;
}

/** 是不是公网链 id (白名单; 认不出的一律**不算**公网 —— 不替读者认领归属) */
export function isPublicChainId(chainId: number): boolean {
  return chainLabelOf(chainId)?.publicNetwork === true;
}

/** totals.* 的口径说明 (唯一实现: 24h 观察窗口内的脉冲事件) */
export interface TotalsScope {
  source: 'pulse-events';
  window_ms: number;
  label: { zh: string; en: string };
  /** totals 与 activity_totals 的数字是否不同 (不同就必须有口径说明 —— 不许"打架"而不解释) */
  differs_from_activity: boolean;
}

/** 与 confirmed_activity **同源**的计数 (rows 恒等于该数组长度) */
export interface ActivityTotals {
  source: ConfirmedActivitySource;
  rows: number;
  /** 行里出现过的不同任务数 (按 `task` 短写去重 —— 同一任务的多个动作算一个任务) */
  tasks: number;
  /** 交付完成口径: kind = task_completed 的不同任务数 */
  tasks_completed: number;
  /** 托管结算口径: kind = trade_settled 的不同任务数 (released/refunded/expired/disputed) */
  tasks_settled: number;
  /** finality 三档分布 (三档之和 === rows, 没有第四条腿) */
  by_finality: { observed: number; confirmed: number; finalized: number };
  /** 与行里 finality 同一口径的确认门槛 */
  gates: ConfirmedActivityGates;
}

/** 上表各行属于哪条链 (公开页不许把本机开发链的行读成公网活动) */
export interface ChainIdScope {
  /** 上表出现过的 chain id (升序去重); 空数组 = 这一屏没有链上事实 */
  chain_ids: number[];
  /** 行数最多的那条链 (并列取小); 没有行 → 0 */
  activity_chain_id: number;
  /** 上述链的展示名; 认不出的 chain id → null (不编名字) */
  activity_chain_label: { zh: string; en: string } | null;
  /** 是不是公网链 (本机隔离开发链 = false) */
  is_public_network: boolean;
  /** 上表里属于公网链的行数 —— 0 = 这一屏没有公网活动 */
  public_network_rows: number;
  /** 本快照拿来做归属对照的公网链 (只作提示, 不是说观察到了它的事件) */
  public_network: { chain_id: number; label: { zh: string; en: string } };
  note: { zh: string; en: string };
}

/**
 * 活动行 → 同源计数 (**纯函数**; 输入就是 `confirmed_activity` 本身)。
 * 存在的唯一理由: 公开页同时显示 totals 与本表行数, 两个数字肉眼可能"打架" ——
 * 那就让它们同源可核: `activity_totals.rows` 恒等于 `confirmed_activity.length`。
 */
export function summarizeActivityRows(
  rows: ConfirmedActivityRow[],
  opts: { source: ConfirmedActivitySource; gates: ConfirmedActivityGates },
): ActivityTotals {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => !!r);
  const tasks = new Set<string>();
  const completed = new Set<string>();
  const settled = new Set<string>();
  const by_finality = { observed: 0, confirmed: 0, finalized: 0 };
  for (const r of list) {
    const t = String(r.task || '');
    if (t) tasks.add(t);
    if (t && r.kind === 'task_completed') completed.add(t);
    if (t && r.kind === 'trade_settled') settled.add(t);
    if (r.finality === 'observed' || r.finality === 'confirmed' || r.finality === 'finalized') {
      by_finality[r.finality] += 1;
    }
  }
  return {
    source: opts.source,
    rows: list.length,
    tasks: tasks.size,
    tasks_completed: completed.size,
    tasks_settled: settled.size,
    by_finality,
    gates: normalizeActivityGates(opts.gates),
  };
}

/** 活动行 → 链归属 (**纯函数**)。所有结论都从行本身推, 不引用外部状态 → 不可能与行数打架。 */
export function buildChainIdScope(rows: ConfirmedActivityRow[]): ChainIdScope {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => !!r);
  const counts = new Map<number, number>();
  for (const r of list) {
    const id = Number(r.chain_id);
    if (!Number.isInteger(id) || id < 0) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const chain_ids = Array.from(counts.keys()).sort((a, b) => a - b);
  let primary = 0;
  let best = 0;
  for (const id of chain_ids) {                       // 升序遍历 + 严格大于 → 并列取小
    const c = counts.get(id)!;
    if (c > best) { best = c; primary = id; }
  }
  const label = chain_ids.length ? chainLabelOf(primary) : null;
  const publicRows = chain_ids.reduce((n, id) => n + (isPublicChainId(id) ? (counts.get(id) || 0) : 0), 0);
  const pub = CHAIN_LABELS[PUBLIC_TESTNET_CHAIN_ID];
  const rows_ = list.length;
  const multi = chain_ids.length > 1 ? `（上表共 ${chain_ids.length} 条链）` : '';
  const note = rows_ === 0
    ? {
        zh: 'chain_id 归属: 本快照没有链上活动行 —— 不是"链上没事件", 而是这一轮没有可列出的行',
        en: 'chain_id scope: no on-chain activity row in this snapshot — not "nothing happened on chain", just no listable row this round',
      }
    : {
        zh: `chain_id 归属: 上表 ${rows_} 行来自 chainId ${primary}${label ? `（${label.zh}）` : ''}${multi} · ` +
            `公网链（${pub.zh} ${PUBLIC_TESTNET_CHAIN_ID}）${publicRows} 行` +
            `${publicRows === 0 ? ' —— 这不是公网活动' : ''}`,
        en: `chain_id scope: all ${rows_} rows above come from chainId ${primary}${label ? ` (${label.en})` : ''}${chain_ids.length > 1 ? ` (${chain_ids.length} chains in total)` : ''} · ` +
            `public network (${pub.en} ${PUBLIC_TESTNET_CHAIN_ID}) rows: ${publicRows}` +
            `${publicRows === 0 ? ' — this is not public-network activity' : ''}`,
      };
  return {
    chain_ids,
    activity_chain_id: primary,
    activity_chain_label: label ? { zh: label.zh, en: label.en } : null,
    is_public_network: chain_ids.length > 0 ? isPublicChainId(primary) : false,
    public_network_rows: publicRows,
    public_network: { chain_id: PUBLIC_TESTNET_CHAIN_ID, label: { zh: pub.zh, en: pub.en } },
    note,
  };
}

/**
 * 快照自检: 公开页会**同屏展示**的数字之间不许自相矛盾。返回问题清单 (空 = 通过)。
 *   ① `activity_totals` 必须在 (与行同源的计数不能缺)
 *   ② `activity_totals.rows` === `confirmed_activity.length`
 *   ③ `by_finality` 三档之和 === 行数 (没有第四条腿)
 *   ④ `activity_totals.source` === `confirmed_activity_source` (两块来源标注必须一致)
 *   ⑤ 行里有任务 而 `totals.tasks === 0` 时, 必须有口径说明 note
 *      (页面不许出现「0 个任务」与「N 行任务」并存而**不解释**)
 */
export function snapshotConsistencyIssues(snap: NetworkPulseSnapshot): string[] {
  const issues: string[] = [];
  const rows = Array.isArray(snap?.confirmed_activity) ? snap.confirmed_activity : [];
  const at: any = (snap as any)?.activity_totals;
  if (!at || typeof at !== 'object') {
    return ['activity_totals 缺失 (与 confirmed_activity 同源的计数必须一起给)'];
  }
  if (Number(at.rows) !== rows.length) issues.push(`activity_totals.rows=${at.rows} ≠ confirmed_activity.length=${rows.length}`);
  const bf = at.by_finality || {};
  const sum = ['observed', 'confirmed', 'finalized'].reduce((n, k) => n + (Number(bf[k]) || 0), 0);
  if (sum !== rows.length) issues.push(`by_finality 三档之和=${sum} ≠ 行数=${rows.length}`);
  if (String(at.source || '') !== String((snap as any)?.confirmed_activity_source || '')) {
    issues.push(`activity_totals.source=${at.source} ≠ confirmed_activity_source=${(snap as any)?.confirmed_activity_source}`);
  }
  const tasks = Number(at.tasks) || 0;
  const pulseTasks = Number((snap as any)?.totals?.tasks) || 0;
  if (rows.length > 0 && tasks > 0 && pulseTasks === 0) {
    const notes = Array.isArray(snap.notes) ? snap.notes.join(' ') : '';
    const explained = notes.includes('脉冲事件') && notes.includes(String(rows.length)) &&
      (notes.includes('链上索引') || notes.includes('chain-index'));
    if (!explained) issues.push(`totals.tasks=0 与 ${rows.length} 行任务并存, 却没有口径说明 note`);
  }
  return issues;
}

export function computeSnapshot(
  events: NetworkPulseEvent[],
  opts: {
    now: number;
    unavailable?: boolean;
    signedNodes?: number;
    /** 已解析好的活动行 (getNetworkPulse 注入真实链上索引结果); 不给 = 纯函数自己从事件降级算 */
    confirmedActivity?: ConfirmedActivityResult;
  },
): NetworkPulseSnapshot {
  const now = opts.now;
  const fresh_until = now + PULSE_LIMITS.snapshotTtlMs;
  if (opts.unavailable) {
    const emptyRows: ConfirmedActivityRow[] = [];
    const gates = normalizeActivityGates(DEFAULT_CONFIRMATIONS);
    return {
      status: 'unavailable',
      generated_at: now,
      fresh_until,
      scope: 'observed',
      scope_label: { zh: '当前节点观察到', en: 'Observed by this node' },
      totals: { nodes: 0, agents: 0, active_agents: 0, seen_last_24h: 0, tasks: 0, tasks_completed: 0, tasks_verified: 0, signatures: 0 },
      totals_scope: {
        source: 'pulse-events', window_ms: PULSE_LIMITS.windowMs,
        label: {
          zh: `只统计本节点 ${PULSE_LIMITS.windowMs / 3600000}h 观察窗口内收到的脉冲事件 (本节点自己上报的)`,
          en: `Only pulse events received by this node within the ${PULSE_LIMITS.windowMs / 3600000}h observation window (reported by this node itself)`,
        },
        differs_from_activity: false,
      },
      capabilities: [],
      recent_activity: [],
      confirmed_activity: emptyRows,
      confirmed_activity_source: 'none',
      activity_totals: summarizeActivityRows(emptyRows, { source: 'none', gates }),
      chain_id_scope: buildChainIdScope(emptyRows),
      notes: ['观察层暂不可用 — 这不是"网络为空"'],
    };
  }
  const window = (Array.isArray(events) ? events : []).filter((e) => isValidEvent(e) && e.occurredAt >= now - PULSE_LIMITS.windowMs);
  const nodes = new Set(window.map((e) => e.sourceProof).filter(Boolean));
  const agents = new Set(window.map((e) => e.agentProof).filter(Boolean) as string[]);
  const active = new Set(window.filter((e) => e.occurredAt >= now - PULSE_LIMITS.activeWindowMs).map((e) => e.agentProof).filter(Boolean) as string[]);

  // capability 分布 (按粗类别计数, 每个类别按**不同的 agent**去重, 避免单节点刷高)
  const capMap = new Map<string, Set<string>>();
  for (const e of window) {
    if (e.type !== 'capability_announced' || !e.capabilityGroup) continue;
    const key = e.capabilityGroup;
    if (!capMap.has(key)) capMap.set(key, new Set());
    capMap.get(key)!.add(e.agentProof || e.sourceProof);
  }
  let capabilities = Array.from(capMap.entries())
    .map(([key, set]) => ({ key, count: set.size }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
    .slice(0, PULSE_LIMITS.maxCapabilities);

  // 隐私阈值: 少于阈值的类别合并进 other (other 本身也按阈值判断是否保留)
  const small = capabilities.filter((c) => c.count < PULSE_LIMITS.privacyThreshold && c.key !== 'other');
  if (small.length > 0) {
    capabilities = capabilities.filter((c) => !small.includes(c));
    const otherCount = new Set<string>();
    for (const c of small) otherCount.add(c.key);
    capabilities.push({ key: 'other', count: otherCount.size });
    capabilities.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  }

  // 经济计数: 按**不同任务**去重 (同一任务重复事件不虚增), 且只给聚合数不给内容
  const tasks = new Set<string>();
  const tasksCompleted = new Set<string>();
  const tasksVerified = new Set<string>();
  for (const e of window) {
    const t = (e as any).taskProof as string | undefined;
    if (!t) continue;
    if (e.type === 'task_posted' || e.type === 'task_accepted') tasks.add(t);
    if (e.type === 'task_completed' || e.type === 'trade_settled') tasksCompleted.add(t);
    if (e.type === 'trade_verified') tasksVerified.add(t);
  }

  // 钱包签名计数: 按 (来源, 时刻) 去重 —— 同一次签名重复上报不虚增
  const signatureKeys = new Set<string>();
  for (const e of window) if (e.type === 'wallet_signed') signatureKeys.add(`${e.sourceProof}|${e.occurredAt}`);

  const recent = [...window]
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, PULSE_LIMITS.maxActivity)
    .map((e) => ({ kind: e.type, at: e.occurredAt, text: renderActivityText(e.type) }));

  const signedNodes = opts.signedNodes ?? new Set(window.filter((e) => e.signed).map((e) => e.sourceProof)).size;
  const scope: NetworkPulseSnapshot['scope'] = signedNodes >= 2 ? 'verified' : 'observed';

  const notes: string[] = [];
  if (scope === 'observed') notes.push('单节点观察: 这是本节点能看到的部分网络, 不是全网精确总量');
  else notes.push(`多签名来源汇总 (${signedNodes} 个签名节点)`);

  // 活动行来源如实标注 (chain-index = 真链上事实; pulse-events = 降级, 非链上确认)
  const activity = opts.confirmedActivity ?? confirmedActivityFromEvents(window);
  // 同源计数 + 链归属: **输入就是上表那批行**, 所以不可能与行数/链 id 打架
  const activity_totals = summarizeActivityRows(activity.rows, { source: activity.source, gates: activity.gates });
  const chain_id_scope = buildChainIdScope(activity.rows);
  const totals_scope: TotalsScope = {
    source: 'pulse-events',
    window_ms: PULSE_LIMITS.windowMs,
    label: {
      zh: `只统计本节点 ${PULSE_LIMITS.windowMs / 3600000}h 观察窗口内收到的脉冲事件 (本节点自己上报的)`,
      en: `Only pulse events received by this node within the ${PULSE_LIMITS.windowMs / 3600000}h observation window (reported by this node itself)`,
    },
    differs_from_activity: activity_totals.rows > 0 &&
      (tasks.size !== activity_totals.tasks || tasksCompleted.size !== activity_totals.tasks_completed),
  };
  if (activity.source === 'chain-index') {
    notes.push(
      `confirmed_activity 来自链上索引 (chain-index): ${activity_totals.rows} 行 · ${activity_totals.tasks} 个不同任务 · ` +
      `finality 分布 observed=${activity_totals.by_finality.observed} / confirmed=${activity_totals.by_finality.confirmed} / ` +
      `finalized=${activity_totals.by_finality.finalized} (三档之和 = 行数); 最新在前, 上限 ${CONFIRMED_ACTIVITY_LIMIT} 行; ` +
      `确认门槛 confirmed=${activity.gates.confirmed} · finalized=${activity.gates.finalized}`,
    );
  } else if (activity.source === 'pulse-events') {
    notes.push(
      'confirmed_activity 降级为脉冲事件 (pulse-events): 非链上确认 —— chain_id/block/confirmations=0 且 finality=observed',
    );
  }
  // 两套计数口径不同时**必须**解释 —— 页面不许出现「0 个任务」与「N 行任务」并存而不解释
  if (totals_scope.differs_from_activity) {
    notes.push(
      `口径不同, 不是数据丢失: totals.tasks/tasks_completed/tasks_verified/signatures 只数本节点 ` +
      `${PULSE_LIMITS.windowMs / 3600000}h 窗口内的脉冲事件 (本快照 tasks=${tasks.size} · tasks_completed=${tasksCompleted.size} · ` +
      `tasks_verified=${tasksVerified.size} · signatures=${signatureKeys.size}); 上表 ${activity_totals.rows} 行来自链上索引 ` +
      `(全量, 不是 ${PULSE_LIMITS.windowMs / 3600000}h 窗口) —— 同源计数见 activity_totals`,
    );
  }
  if (activity_totals.rows > 0) notes.push(chain_id_scope.note.zh);

  return {
    status: 'live',
    generated_at: now,
    fresh_until,
    scope,
    scope_label: scope === 'verified'
      ? { zh: '网络观察快照 (多签名来源)', en: 'Verified network snapshot' }
      : { zh: '当前节点观察到', en: 'Observed by this node' },
    totals: {
      nodes: nodes.size,
      agents: agents.size,
      active_agents: active.size,
      seen_last_24h: agents.size,     // 24h 窗口内的不同 Agent
      tasks: tasks.size,              // 观察到发起的任务数 (聚合, 无内容)
      tasks_completed: tasksCompleted.size,
      tasks_verified: tasksVerified.size,
      signatures: signatureKeys.size,  // 真实签名次数 (只计数)
    },
    totals_scope,
    capabilities,
    recent_activity: recent,
    confirmed_activity: activity.rows,
    confirmed_activity_source: activity.source,
    activity_totals,
    chain_id_scope,
    notes,
  };
}

/** 读快照 (带 30s 短缓存; 过期 → 重算; 重算失败 → unavailable) */
export async function getNetworkPulse(opts: SnapshotOptions = {}): Promise<NetworkPulseSnapshot> {
  const now = opts.now ?? Date.now();
  if (opts.unavailable) return computeSnapshot([], { now, unavailable: true });
  if (!opts.force) {
    try {
      const cached = JSON.parse(fs.readFileSync(snapshotFile(opts.home), 'utf-8')) as NetworkPulseSnapshot;
      // 老版本写的缓存缺冻结字段 `confirmed_activity` (或后来的 totals_scope / activity_totals /
      // chain_id_scope) → 视为**过期形状**, 重算 (不能把缺字段的快照发出去 ——
      // 缺 activity_totals 就会在页面上重新变成"两个数字打架"
      const shapeOk = Array.isArray((cached as any)?.confirmed_activity)
        && typeof (cached as any)?.confirmed_activity_source === 'string'
        && !!(cached as any)?.totals_scope
        && !!(cached as any)?.activity_totals
        && !!(cached as any)?.chain_id_scope;
      if (shapeOk && cached && Number.isFinite(cached.generated_at) && cached.generated_at + PULSE_LIMITS.snapshotTtlMs > now) return cached;
    } catch { /* 无缓存 */ }
  }
  let events: NetworkPulseEvent[] = [];
  try {
    events = readEvents(opts.home);
  } catch (e: any) {
    return computeSnapshot([], { now, unavailable: true });
  }
  // 活动行优先取 P5 链上索引 (真链上事实); 索引不可用 → 退回脉冲事件, 并在快照里标出来源
  const confirmedActivity = await resolveConfirmedActivity({ home: opts.home, events, now });
  const snap = computeSnapshot(events, { now, confirmedActivity });
  try {
    fs.mkdirSync(pulseDir(opts.home), { recursive: true });
    fs.writeFileSync(snapshotFile(opts.home), JSON.stringify(snap), 'utf8');
  } catch { /* 写不进就算了, 返回值仍然有效 */ }
  return snap;
}

/** 快照是否仍是 live (给前端/观察入口判断; 过期即 stale) */
export function snapshotStatus(snap: NetworkPulseSnapshot, now = Date.now()): 'live' | 'stale' | 'unavailable' {
  if (snap.status === 'unavailable') return 'unavailable';
  return now <= snap.fresh_until ? 'live' : 'stale';
}

// ── 签名 (可验证快照) ───────────────────────────────────────────────────────

/** 规范化 JSON (键排序), 用于签名覆盖 */
export function canonicalize(value: unknown): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export interface SignedSnapshot { snapshot: NetworkPulseSnapshot }

/** 用本机 DID 身份给快照签名 (公开入口可校验; 只暴露签名与指纹, 不暴露 DID) */
/** 上一次快照签名失败的原因 (给调用方诊断用; 绝不出现在公开输出里) */
let lastSignErr: string | null = null;
export function lastSnapshotSignError(): string | null { return lastSignErr; }

/** 快照签名输入是 Uint8Array (ed25519), 存 base64 —— 不能直接把字符串喂给 KeyManager.sign */
function snapBytes(snap: NetworkPulseSnapshot): Uint8Array {
  const payload = { ...snap, signature: undefined, signer_fingerprint: undefined };
  return new TextEncoder().encode(canonicalize(payload));
}
function decodeSnapSig(sig: string): Uint8Array {
  if (/^[0-9a-f]{128}$/i.test(sig)) return new Uint8Array(Buffer.from(sig, 'hex'));
  return new Uint8Array(Buffer.from(sig, 'base64'));
}

export async function signSnapshot(snap: NetworkPulseSnapshot, h?: string): Promise<NetworkPulseSnapshot> {
  lastSignErr = null;
  try {
    const { KeyManager } = await import('@diap/sdk');
    const file = path.join(home(h), '.bolloon', 'identity.json');
    const kp: any = await (KeyManager as any).fromFile(file);
    if (!kp?.privateKey) { lastSignErr = `没有可用身份 (${file}) → 未签名`; return snap; }
    const sig: any = await (KeyManager as any).sign(kp, snapBytes(snap));
    const sigStr = typeof sig === 'string' ? sig : Buffer.from(sig as Uint8Array).toString('base64');
    return { ...snap, signature: sigStr, signer_fingerprint: nodeDigest(String(kp.did || '')) };
  } catch (e: any) {
    lastSignErr = String(e?.message || e);
    return snap;   // 没身份/签名失败 → 就返回未签名快照 (绝不假装签过)
  }
}

/** 校验快照签名 (需要显式传入公钥方; 内部/测试用) */
export async function verifySnapshotSignature(snap: NetworkPulseSnapshot, publicKey: any): Promise<boolean> {
  try {
    if (!snap.signature) return false;
    const { KeyManager } = await import('@diap/sdk');
    return await (KeyManager as any).verify(publicKey, snapBytes(snap), decodeSnapSig(snap.signature));
  } catch {
    return false;
  }
}

/** 公开投影的"禁止出现"字段检查 (测试与调用方共用) */
export const FORBIDDEN_PUBLIC_KEYS = ['did', 'peerId', 'peer_id', 'multiaddrs', 'ip', 'wallet', 'address', 'privateKey', 'content', 'instruction', 'payload'];

export function assertNoPrivateFields(value: unknown, at = '$'): string[] {
  const issues: string[] = [];
  const walk = (v: any, p: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (FORBIDDEN_PUBLIC_KEYS.includes(k)) issues.push(`${p}.${k} 不该出现在公开投影里`);
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(value, at);
  return issues;
}
