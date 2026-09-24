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
 *   · **冻结形状 `confirmed_activity`** (2026-09-22; 2026-09-23 加链上可核验字段): 公开页面要能列出
 *     「哪个任务 · 什么状态 · 哪个块 · 多少确认」, 而不是只有数字 —— 数据源优先 P5 链上索引, 不可用时
 *     退回脉冲事件并用 `confirmed_activity_source` 标注; 任务标识一律 sha256 短写 (前 8 位), 绝不落
 *     taskKey / taskId 原文; 不够确认门槛的行只报 observed, 不冒充 confirmed。
 *     2026-09-23 隐私决定**变更一处** (只放开公开链上事实, 别的一律不变): 交易哈希 (`tx_hash`) 与
 *     escrow **合约**地址 (`contract`, 只给索引/诊断) 允许出现; 页面可点的只有**交易**链接 `explorer_tx`
 *     (仅当该链有已知公网浏览器)。EOA / 钱包地址 (买方·卖方)、taskKey 原文、taskId、args 里的地址、
 *     DID、peer IP/multiaddr、私钥 —— 仍然一个都不许出现; 老字段 `tx` (sha256 短写) 保留不删。
 *   · **冻结形状 `open_tasks[]`** (2026-09-23): 公开页要能列「本节点公告板上哪些任务还没被接单」。
 *     数据源 = `~/.bolloon/tasks/board/*.json` 里**未认领且未过期**的公告, 每行只含白名单 7 个字段:
 *     `capability` / `budget`(原子单位) / `currency` / `network` / `deadline` / `claimed`(恒 false) /
 *     `announcementId`(前 8 位)。**任务正文与它的摘要/预览、买方 DID 与公钥、认领者、公告签名
 *     一律不进公开投影** —— 行由 `buildOpenTaskRow` 逐字段拷贝构造, 不做对象展平。
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
// 区块浏览器映射 (chainId → 公网浏览器); 认不出的链没有链接 —— 宁缺勿错, 不编死链
import { ADDRESS_RE, EXPLORER_URL_RE, TX_HASH_RE, explorerTxUrl } from './chain/explorer.js';
// 「待接单任务」的数据源 = 本机公告板目录 (~/.bolloon/tasks/board)。只借**路径常量**,
// 公告的解析/发布/接单一律留在 task-board.ts (这里不做第二套实现)。
import { boardDir, REMOTE_CLAIMS_FILE } from './task-board.js';

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
  // 2026-09-23 (C1): 任务对外发布 (公告板 publish) —— 只记"有节点公告了一个待接单任务", 正文/ID 原文不落盘
  'task_announced',
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

/**
 * ★ 顶部聚合计数 (2026-09-24 逐字段定源)。
 *
 * **为什么要逐字段定源**: 真快照里出现过「页面顶部写 0 个任务, 而同屏的链上活动表有 15 行任务」
 * 这种并排矛盾 —— 根因是 `totals` 只数**本节点 24h 脉冲事件流**(那个流里可能一条经济事件都没有),
 * 而表格来自**链上索引全量**。同一个概念两个数字并排出现而没人解释 = 读者只能读成"在撒谎"。
 *
 * 现在每个数的来源都写在 `totals_scope.fields[<字段>]` 里 (页面就地在数字旁标出):
 *   · `nodes/agents/active_agents/seen_last_24h` = 本节点 24h 观察窗口内的脉冲事件;
 *   · `tasks/tasks_completed/tasks_settled`      = **链上索引的同源计数** (`activity_totals`,
 *     与下方活动表同源, 同源即恒等) —— 索引不可用才降级为脉冲口径并如实标出;
 *   · `signatures`                               = 本机签名审计账 (`wallet-signatures.jsonl`) 窗口内条数。
 *
 * `null` 一律表示**没有可用源**(未接入): 页面必须写「未接入」, **绝不许拿 0 冒充「没发生过」**。
 */
export interface NetworkPulseTotals {
  nodes: number;
  agents: number;
  active_agents: number;
  seen_last_24h: number;
  /** 有链上活动的不同任务数 (链上索引权威源); 索引不可用时降级为 24h 脉冲口径; 无源 → null */
  tasks: number | null;
  /** 交付完成 (链上 `ProofSubmittedV2` → `task_completed`) 的不同任务数 */
  tasks_completed: number | null;
  /**
   * 「验真」口径: 链上索引里**没有**对应事件 (`CHAIN_EVENT_ACTIVITY` 里没有验真类事件) ——
   * 链上索引口径下这里恒为 `null` (= 未接入), 不拿结算数冒充「已验证」。
   */
  tasks_verified: number | null;
  /** 钱包签名 = 本机签名审计账窗口内条数 (真实条数, 只计数不给内容); 无源 → null */
  signatures: number | null;
  /** 托管结算口径 (released/refunded/expired/disputed) 的不同任务数 —— 链上索引权威值 */
  tasks_settled: number | null;
}

export interface NetworkPulseSnapshot {
  status: 'live' | 'stale' | 'unavailable';
  generated_at: number;
  fresh_until: number;
  /** observed = 当前节点观察到的; verified = 多签名来源汇总观察快照 (都不是"全网精确总量") */
  scope: 'observed' | 'verified';
  scope_label: { zh: string; en: string };
  /**
   * ★ 聚合计数 —— **口径逐字段写在 `totals_scope.fields` 里** (2026-09-24; 老字段名全部保留,
   * 只是来源被钉死: 任务类计数改取链上索引的同源值, 与下方活动表**同一个概念同一个数**)。
   * 与活动行同源的计数见 `activity_totals`; 每个数的来源/窗口见 `totals_scope.fields`。
   * `null` = 没有可用源 (页面写「未接入」), 不是「没发生过」。
   */
  totals: NetworkPulseTotals;
  /** ★ totals.* 的逐字段口径 (含「未接入」语义) —— 页面就地在每个数旁标出, 不许只靠 notes 辩解 */
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
  /**
   * ★ 本节点公告板上**未认领且未过期**的任务 (公开「待接单任务」)。
   * 每行只有白名单 7 个字段 (capability/budget/currency/network/deadline/claimed/announcementId 前 8 位)
   * —— **任务正文、正文摘要/预览、买方 DID/公钥、认领者、签名一律不在这里** (见 `OpenTaskRow`)。
   * 空数组 = 本节点此刻没有待接单任务 (不是「没接入」—— 那个语义不写在这里)。
   */
  open_tasks: OpenTaskRow[];
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

/**
 * 本机**签名审计账** (`<home>/.bolloon/wallet-signatures.jsonl`, 由 `task-contract.recordSignatureAudit`
 * 落盘) 的窗口内计数 —— 这是「钱包签名」这个数的**真实来源** (2026-09-24 接真源)。
 *
 * 为什么不用脉冲事件当唯一源: `recordSignatureAudit` 顺手发的 `wallet_signed` 脉冲事件是
 * fire-and-forget (动态 import 失败 / 事件文件被重写都会丢) —— 实测真快照里 `wallet_signed`
 * 事件 0 条而同一台机器的审计账里有 11 条真实签名 ⇒ 拿脉冲流当源会在页面上留下
 * 「0 个钱包签名」这种**假零** (本机明明签过)。
 *
 * 只数条数, 不读内容 (不返回 kind / requestId / taskId / 金额 / 指纹), 快照里也不出现文件路径。
 * 文件不存在 → `available: false` (调用方据此标「未接入」, **不许当成 0 条**)。
 */
export interface SignatureAuditTally {
  available: boolean;
  count: number;
  window_ms: number;
}

export function tallySignatureAudit(h?: string, opts: { now?: number; windowMs?: number } = {}): SignatureAuditTally {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? PULSE_LIMITS.windowMs;
  const file = path.join(home(h), '.bolloon', 'wallet-signatures.jsonl');
  if (!fs.existsSync(file)) return { available: false, count: 0, window_ms: windowMs };
  let count = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: any = null;
      try { row = JSON.parse(line); } catch { continue; }        // 坏行跳过, 不让一行坏数据毁掉整个计数
      const at = Number(row?.at);
      if (Number.isFinite(at) && at >= now - windowMs) count += 1;
    }
  } catch {
    return { available: false, count: 0, window_ms: windowMs };
  }
  return { available: true, count, window_ms: windowMs };
}

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
    case 'task_announced': return { zh: '有节点公告了一个待接单任务', en: 'A node announced an open task' };
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

// ── 待接单任务 (公开投影) ───────────────────────────────────────────────────
/**
 * 公开「待接单任务」的一行 —— **白名单字段**, 只有这 7 个键, 别的键一个都不带出来。
 *
 * 数据源 = 本机公告板 `~/.bolloon/tasks/board/<announcementId>.json` (只读未认领且未过期的)。
 * 绝不导出 (与任务正文/身份同级的私密事实):
 *   · 任务正文 `instruction` · `instructionDigest` · `instructionPreview` (正文与它的摘要/预览)
 *   · 买方 `buyerDid` · `buyerPublicKeyHex` · 任何钱包地址 / DID / peerId / IP / multiaddr
 *   · 认领者 DID / 声明的价格 / 公告签名原文
 * 这条白名单由 `buildOpenTaskRow` 手工逐个字段拷贝实现 (不做 `{...a}` 展平 —— 展平一次就把正文
 * 带出去了), 并由 `snapshotConsistencyIssues` + 导出脚本的 `assertNoPrivateFields` 双重兜底。
 */
export interface OpenTaskRow {
  /** 能力公开名 (与买方公告给注册表的那个同名 —— 它本来就是公开的发现键) */
  capability: string;
  /** 预算 (原子单位字符串; 公告没给预算 → null, 不替它猜) */
  budget: string | null;
  currency: string | null;
  network: string | null;
  /** 截止时间 (ms epoch; 已过期的公告根本不上这一行) */
  deadline: number;
  /**
   * 是否已被认领 —— 本函数只导出**未认领**的公告, 所以恒为 false。
   * 这个布尔不是装饰: 它把「筛选真的生效」当着读者/验收脚本的面写出来 (不需要信任筛选代码),
   * 且由 `snapshotConsistencyIssues` 反向守着 (出现 true 就是筛选坏了 → 拒绝导出)。
   */
  claimed: boolean;
  /** `announcementId` 的**前 8 位** (短引用; 原 id 不上公开页) */
  announcementId: string;
}

/** 上限: 公开页最多列几条待接单任务 (超出按最近截止排序取前 N) */
export const MAX_OPEN_TASKS = 25;

/** 公开页只列这条公告的这 7 个字段; 其余(正文/买方/摘要/签名)一律不出这个函数 */
function buildOpenTaskRow(a: any): OpenTaskRow | null {
  const capability = String(a?.capability ?? '').trim();
  const id = String(a?.announcementId ?? '').trim();
  const deadline = Number(a?.deadline);
  if (!capability || !id || !Number.isFinite(deadline) || deadline <= 0) return null;
  const b = a?.budget && typeof a.budget === 'object' ? a.budget : null;
  const maxAmount = b ? String(b.maxAmount ?? '').trim() : '';
  const currency = b ? String(b.currency ?? '').trim() : '';
  const network = b ? String(b.network ?? '').trim() : '';
  return {
    capability,
    budget: maxAmount || null,
    currency: currency || null,
    network: network || null,
    deadline,
    claimed: (Array.isArray(a?.claims) ? a.claims.length : 0) > 0,
    announcementId: id.slice(0, 8),      // 前 8 位 (按字面, 不重新格式化)
  };
}

/**
 * 读本节点公告板上**未认领且未过期**的公告, 投影成公开「待接单任务」行。
 *
 * 三条筛选 (缺一个都会把不该上的东西露出来):
 *   · `protocol= bolloon-task/1` + `kind= task_announcement` (同目录还有 `remote-claims.json`,
 *     它是个数组 —— 不按 kind 判会把认领台账当公告解析)
 *   · `status === 'open'` (已认领 / 已取消 → 不是「待接单」)
 *   · `deadline > now` (过期只是不能再接单, 文件不删 → 必须在这里判掉)
 *
 * 读不到目录 / 坏 JSON / 缺字段 → 该条跳过 (一条都不编); 整个目录不可读 → 空数组 + 不抛。
 */
export function readOpenTasks(h?: string, now = Date.now()): OpenTaskRow[] {
  const out: OpenTaskRow[] = [];
  try {
    const dir = boardDir(h);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return []; }
    for (const name of names.slice().sort()) {
      if (!name.endsWith('.json') || name === `${REMOTE_CLAIMS_FILE}`) continue;
      let raw: any;
      try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch { continue; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;      // 认领台账是数组 → 这里就出局
      if (raw.protocol !== 'bolloon-task/1' || raw.kind !== 'task_announcement') continue;
      if (String(raw.status) !== 'open') continue;
      const deadline = Number(raw.deadline);
      if (!Number.isFinite(deadline) || deadline <= now) continue;
      const row = buildOpenTaskRow(raw);
      if (row) out.push(row);
    }
  } catch { return []; }
  // 稳定排序: 快到期在前 (读者最需要知道的先看); 同截止按短 id 定序 (排序必须确定, 否则快照每次都"变")
  out.sort((x, y) => (x.deadline - y.deadline) || (x.announcementId < y.announcementId ? -1 : x.announcementId > y.announcementId ? 1 : 0));
  return out.slice(0, MAX_OPEN_TASKS);
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
// 形状**冻结** (老字段名与取值域不许改), 内容按用途分两类:
//   · **匿名短写** (老口径, 保留不删): task = `sha256:` + sha256(域标签|taskKey) 的前 8 位;
//     tx = `sha256:` + sha256(域标签|txHash) 的前 8 位 —— 绝不落 taskKey / taskId 原文
//   · **公开链上事实** (2026-09-23 新增; 同日按 leo 拍板收窄): tx_hash (真交易哈希) /
//     explorer_tx (交易浏览器链接, 仅当该链有已知公网浏览器) —— 网页上的行因此**可核验地**跳回区块
//     浏览器; contract (escrow 合约地址) 仍保留在行里**供索引/诊断**, 但**不上页面、不生成合约链接**
// 隐私红线 (违反即失败, **只放开上面那两种 0x 字符串**):
//   · 允许: 交易哈希 (0x+64 hex) 与 escrow 合约地址 (0x+40 hex), 且只出现在 `tx_hash`/`contract`/`explorer_tx` 这 3 个键下
//   · 禁止: EOA / 钱包地址 (买方/卖方/payTo)、taskKey 原文、taskId、args 里的地址、DID、peerId /
//     IP / multiaddr、私钥 —— `assertNoPrivateFields`(键名) + `auditPublicHexLeaks`(越界 0x) 兜底
//   · 拿不到链配置里的 escrow 地址, 或这条索引记录的 address 不是它 → **不填** contract
//     (宁缺勿错: 宁可少一个字段, 也不把可能是别人的地址写成合约)
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

/** 冻结形状的一行 (老 9 个字段名/顺序逐字固定; 2026-09-23 起链上索引行**追加** 4 个可核验字段) */
export interface ConfirmedActivityRow {
  /** 任务摘要: `sha256:<前 8 位十六进制>` (taskKey / taskId 的 sha256 短写, 不可逆) */
  task: string;
  kind: ConfirmedActivityKind;
  state: ConfirmedActivityState;
  /** 链 id (脉冲降级行没有链上事实 → 0) */
  chain_id: number;
  /** 区块号 (脉冲降级行 → 0) */
  block: number;
  /** 交易摘要: `sha256:<前 8 位十六进制>` (txHash 的 sha256 短写, 不可逆; **保留**给老消费方) */
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
  // ── 2026-09-23 追加 (均为**可选**: 脉冲降级行没有链上事实 → 这些键整个不出现, 不是 null) ──
  /** 真交易哈希 (小写 0x + 64 位十六进制) —— 公开链上事实, 可核验 */
  tx_hash?: string;
  /**
   * escrow **合约**地址 (小写 0x + 40 位十六进制); 只在能确认它就是链配置里的 escrow 合约时才有。
   * **只给索引/诊断用 —— 页面不渲染合约地址、也不生成合约链接** (2026-09-23 leo 拍板收窄;
   * 行内唯一可点的东西是交易标签 → `explorer_tx`)。
   */
  contract?: string;
  /** 区块浏览器**交易**链接; 该链**没有**已知公网浏览器 (如本机 31337) → 这个键整个不存在 */
  explorer_tx?: string;
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
  /**
   * 该条日志的**合约地址** (索引条目里就有)。只有它 === 链配置里的 escrow 合约地址时才用来填
   * `contract`; 拿不到链配置 / 对不上 → 不填 (宁缺勿错)。
   */
  address?: string;
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
 *   · 新增: `tx_hash` (真交易哈希) 恒给; `contract` 仅当 opts.escrowAddress 合法且 === 本条 address;
 *     `explorer_tx` 仅当该 chainId 有**已知公网浏览器** (否则键整个不存在, 不填 null)
 *   · 最新在前 (blockNumber desc, logIndex desc), 上限 25 行
 */
export function buildConfirmedActivityFromIndex(
  entries: ChainActivitySourceEntry[],
  opts: {
    gates?: Partial<ConfirmedActivityGates> | null;
    headBlock?: number | null;
    chainId?: number;
    limit?: number;
    /** 链配置里的 escrow **合约**地址 (索引文件顶层字段); 缺/非法 → 不给合约链接 (宁缺勿错) */
    escrowAddress?: string | null;
  } = {},
): ConfirmedActivityRow[] {
  const gates = normalizeActivityGates(opts.gates);
  const limit = activityLimit(opts.limit);
  const chainId = Number.isInteger(Number(opts.chainId)) && Number(opts.chainId) >= 0 ? Number(opts.chainId) : 0;
  const head = Number.isInteger(Number(opts.headBlock)) && Number(opts.headBlock) >= 0 ? Number(opts.headBlock) : null;
  // escrow 合约地址白名单 (唯一权威): 只有索引文件自己记的这个地址算数, 别的地址一律不当合约
  const escrow = typeof opts.escrowAddress === 'string' ? opts.escrowAddress.toLowerCase() : '';
  const escrowOk = ADDRESS_RE.test(escrow) ? escrow : '';
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
    // 合约地址: 只有「本条记录的 address 就是链配置里的 escrow 地址」才填 (宁缺勿错)
    const entryAddr = String((e as any).address || '').toLowerCase();
    const contract = escrowOk && entryAddr === escrowOk ? escrowOk : '';
    // 浏览器链接: 该链没有已知公网浏览器 → 返回 null → 键整个不出现 (不编 href="#")
    // 只有**交易**链接 (explorer_tx); 合约地址只在数据里 (contract), 不生成链接 (2026-09-23 收窄)
    const explorerTx = explorerTxUrl(chainId, txHash);
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
        // 公开链上事实 (白名单键; 老字段 tx 已在上方保留)
        tx_hash: txHash,
        ...(contract ? { contract } : {}),
        ...(explorerTx ? { explorer_tx: explorerTx } : {}),
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
        escrowAddress: file?.escrowAddress,        // 合约地址白名单 = 索引文件自己的部署身份
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

/** 公网主网 (Base) chainId —— 同上, 只做归属说明 */
export const PUBLIC_MAINNET_CHAIN_ID = 8453;

/**
 * chainId → 展示用网络名 (只回答"这一屏的行属于哪条链")。
 * 认不出的 chain id **不编名字** (chainLabelOf → null), 也不许算成公网。
 */
export const CHAIN_LABELS: Record<number, { zh: string; en: string; publicNetwork: boolean }> = {
  [LOCAL_DEV_CHAIN_ID]: { zh: '本机隔离开发链', en: 'local isolated dev chain', publicNetwork: false },
  [PUBLIC_TESTNET_CHAIN_ID]: { zh: 'Base Sepolia 测试网', en: 'Base Sepolia testnet', publicNetwork: true },
  [PUBLIC_MAINNET_CHAIN_ID]: { zh: 'Base 主网', en: 'Base mainnet', publicNetwork: true },
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

/** totals.* 的**逐字段**口径 (唯一实现: 每个数各自说清自己来自哪) */
export type TotalsFieldSource = 'pulse-events' | 'chain-index' | 'signature-audit' | 'none';
export type TotalsFieldWindow = 'window-24h' | 'full' | 'unknown';
export type TotalsFieldKey =
  | 'nodes' | 'agents' | 'active_agents' | 'seen_last_24h'
  | 'tasks' | 'tasks_completed' | 'tasks_verified' | 'tasks_settled' | 'signatures';

/**
 * 某个顶部计数的口径 (2026-09-24)。
 * 为什么需要: 原来一个 `totals_scope.label` 一句话统管 8 个数, 而实际上「节点数」与「任务数」
 * 来自两套完全不同的源 —— 页面把两套口径的数字并排放在一行, 只靠一句总口径是**解释不了**的
 * (真事: 顶部 0 个任务 vs 表格 15 行任务)。现在每个数自己带 `source`/`window`/`short`/`label`。
 */
export interface TotalsFieldScope {
  source: TotalsFieldSource;
  window: TotalsFieldWindow;
  /** 页面上的**极短标记** (贴在该数字旁就地显示; 不写整句) */
  short: { zh: string; en: string };
  /** 完整口径 (门禁用 / notes / 诊断; 页面不必整句显示) */
  label: { zh: string; en: string };
  /** true = 这个数**没有可用源** (值必须是 null; 页面必须写「未接入」而不是 0) */
  unavailable?: boolean;
}

export interface TotalsScope {
  /** 总口径: 纯脉冲事件 / 纯链上索引 / 混合 (节点类走脉冲、任务类走链上索引) */
  source: 'pulse-events' | 'chain-index' | 'mixed';
  window_ms: number;
  label: { zh: string; en: string };
  /** totals 与 activity_totals 的数字是否不同 (不同就必须有口径说明 —— 不许"打架"而不解释) */
  differs_from_activity: boolean;
  /** ★ 逐字段口径 (2026-09-24): 顶部每个数都能就地说明来自哪; 缺这块 = 只能靠 notes 辩解 */
  fields: Record<TotalsFieldKey, TotalsFieldScope>;
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
  const publicIds = chain_ids.filter(isPublicChainId);
  const publicRows = publicIds.reduce((n, id) => n + (counts.get(id) || 0), 0);
  const pub = CHAIN_LABELS[PUBLIC_TESTNET_CHAIN_ID];
  // 点名口径: 提示里写出的公网链必须是**行里真出现过的**; 一条都没有才退回对照链
  // (否则会出现「上表 3 行来自 chainId 8453(Base 主网)」却说「公网链(Base Sepolia 84532) 3 行」的自相矛盾)
  const pubZh = publicIds.length
    ? publicIds.map((id) => `${CHAIN_LABELS[id].zh} ${id}`).join('、')
    : `${pub.zh} ${PUBLIC_TESTNET_CHAIN_ID}`;
  const pubEn = publicIds.length
    ? publicIds.map((id) => `${CHAIN_LABELS[id].en} ${id}`).join(', ')
    : `${pub.en} ${PUBLIC_TESTNET_CHAIN_ID}`;
  const rows_ = list.length;
  const multi = chain_ids.length > 1 ? `（上表共 ${chain_ids.length} 条链）` : '';
  const note = rows_ === 0
    ? {
        zh: 'chain_id 归属: 本快照没有链上活动行 —— 不是"链上没事件", 而是这一轮没有可列出的行',
        en: 'chain_id scope: no on-chain activity row in this snapshot — not "nothing happened on chain", just no listable row this round',
      }
    : {
        zh: `chain_id 归属: 上表 ${rows_} 行来自 chainId ${primary}${label ? `（${label.zh}）` : ''}${multi} · ` +
            `公网链（${pubZh}）${publicRows} 行` +
            `${publicRows === 0 ? ' —— 这不是公网活动' : ''}`,
        en: `chain_id scope: all ${rows_} rows above come from chainId ${primary}${label ? ` (${label.en})` : ''}${chain_ids.length > 1 ? ` (${chain_ids.length} chains in total)` : ''} · ` +
            `public network (${pubEn}) rows: ${publicRows}` +
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
 *   ⑥ 0x 长 hex 越界 (2026-09-23): 只许出现在 tx_hash/contract/explorer_* 四个白名单键下 ——
 *      EOA 地址跑到别的键 (或白名单键形状不对) 就拒绝导出
 *   ⑧ ★ **同一概念不许并排两个数** (2026-09-24, 见 `totalsScopeIssues`): 顶部计数与表格行数/
 *      同源计数矛盾, 或者某个数没有来源却不标「未接入」→ 拒绝导出 (这道门在 UI 侧还有一份镜像)
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
  issues.push(...auditPublicHexLeaks(snap));      // ⑥ 0x 长 hex 越界 → 拒绝导出 (不静默放行)
  issues.push(...openTasksIssues(snap));          // ⑦ 待接单任务的字段白名单与「只含未认领」不变式
  issues.push(...totalsScopeIssues(snap));        // ⑧ ★ 同一概念不得并排两个数 (顶部 vs 表格)
  return issues;
}

/** 顶部逐字段口径的键 (与 `TotalsFieldKey` 逐字一致; 少一个 = 那个数没有来源说明) */
export const TOTALS_FIELD_KEYS: readonly TotalsFieldKey[] = [
  'nodes', 'agents', 'active_agents', 'seen_last_24h',
  'tasks', 'tasks_completed', 'tasks_verified', 'tasks_settled', 'signatures',
];
const TOTALS_FIELD_SOURCES: readonly TotalsFieldSource[] = ['pulse-events', 'chain-index', 'signature-audit', 'none'];
const TOTALS_FIELD_WINDOWS: readonly TotalsFieldWindow[] = ['window-24h', 'full', 'unknown'];
/** 「未接入」类措辞 (无源时必须出现, 否则等于没说清为什么没有数) */
const UNAVAILABLE_WORDS = /未接入|not connected|无可用源|no available source/;

/**
 * ★ 新不变量门 (2026-09-24 leo:「数量怎么对不上」): **同一概念不许并排两个数**。
 *
 * 检查的是「页面会把它们放在同一屏里」的那几个数 —— 它们的口径必须各自挂得住:
 *   ① 逐字段口径 `totals_scope.fields` 九个键必须齐 (source/window/short/label 双语都在) ——
 *      缺了就只能靠 notes 辩解, 而那正是当初「顶部 0 个任务 vs 表格 25 行」能上线的路径;
 *   ② 值 `null` ⇔ 口径标 `none` + 明说「未接入」; **有源却不给数** 或 **无源却拿 0 冒充** 都算矛盾;
 *   ③ 同一概念对账 (表里有 5 个任务而顶部写 0 任务 → 判红):
 *        · 链上索引可用时, 顶部 tasks/tasks_completed/tasks_settled **必须逐字等于** activity_totals
 *          的同名字段 (同源即恒等, 任何解释都救不了);
 *        · 表格行数/同源计数非零而顶部为 0 或缺值 → 必须有口径说明 (note 里写清) 才放行;
 *        · 顶部说有 N 个任务而表格一行都没有 (反向矛盾) → 同样判红。
 *   `status === 'unavailable'` 的整份快照不发布任何计数 (页面整块显示「快照读不到」), 故只查形状。
 */
export function totalsScopeIssues(snap: NetworkPulseSnapshot): string[] {
  const out: string[] = [];
  const t: any = (snap as any)?.totals || {};
  const ts: any = (snap as any)?.totals_scope;
  const at: any = (snap as any)?.activity_totals || {};
  const rows = Array.isArray(snap?.confirmed_activity) ? snap.confirmed_activity : [];
  const unavailableSnap = String((snap as any)?.status || '') === 'unavailable';

  if (!ts || typeof ts !== 'object') return ['totals_scope 缺失 (顶部计数的口径必须随快照一起给)'];
  if (!ts.fields || typeof ts.fields !== 'object') {
    return ['totals_scope.fields 缺失 (顶部每个数都要能就地说明来自哪 —— 不许只靠 notes 辩解)'];
  }

  // ① 形状: 九个键齐 + 每个键的 source/window/short/label 都合法
  for (const k of TOTALS_FIELD_KEYS) {
    const f: any = ts.fields[k];
    if (!f || typeof f !== 'object') { out.push(`totals_scope.fields.${k} 缺失`); continue; }
    if (!TOTALS_FIELD_SOURCES.includes(f.source)) out.push(`totals_scope.fields.${k}.source=${JSON.stringify(f.source)} 不在白名单`);
    if (!TOTALS_FIELD_WINDOWS.includes(f.window)) out.push(`totals_scope.fields.${k}.window=${JSON.stringify(f.window)} 不在白名单`);
    if (!f.label?.zh || !f.label?.en) out.push(`totals_scope.fields.${k}.label 必须双语都给`);
    if (!f.short?.zh || !f.short?.en) out.push(`totals_scope.fields.${k}.short 必须双语都给 (页面要就地贴在数字旁)`);
  }
  if (out.length) return out;     // 形状都不对就不往下算数

  if (!unavailableSnap) {
    // ② 值 ⇔ 口径 (null = 未接入; 有源必须有数; 无源不许给 0)
    for (const k of TOTALS_FIELD_KEYS) {
      const f: any = ts.fields[k];
      const v = t[k];
      const isNull = v === null || v === undefined;
      if (isNull) {
        if (f.source !== 'none') {
          out.push(`totals.${k} 没有值 (未接入) 却标了源 ${f.source} —— 有源就必须给真值, 没源就标 none`);
        }
        if (!UNAVAILABLE_WORDS.test(`${f.short?.zh}${f.short?.en}${f.label?.zh}${f.label?.en}`)) {
          out.push(`totals.${k} 没有值却没有一句「未接入」说明 (读者会把空白读成 0)`);
        }
      } else {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          out.push(`totals.${k}=${JSON.stringify(v)} 不是非负有限数`);
        } else if (f.source === 'none') {
          out.push(`totals.${k}=${v} 却标「无源」 —— 不许拿裸 0 冒充「没有接入」(那会被读成"没发生过")`);
        }
      }
    }

    // ③ 同一概念对账 (顶部计数 vs 表格行数/同源计数)
    const notes = Array.isArray(snap.notes) ? snap.notes.join(' ') : '';
    const pairs: Array<[TotalsFieldKey, any, any]> = [
      ['tasks', t.tasks, at.tasks],
      ['tasks_completed', t.tasks_completed, at.tasks_completed],
      ['tasks_settled', t.tasks_settled, at.tasks_settled],
    ];
    const tableRows = Number(at.rows) || rows.length;
    const sameSourceChain = String(at.source) === 'chain-index';
    // ⑨ 声明与能力不符: 某字段自称「链上索引」口径, 而这一份快照的链上索引根本不可用 ——
    //    那就是替一个不存在的源背书 (页面会写「链上索引·全量」, 而索引这一份没读出来)。
    //    注: 本块必须放在 pairs / sameSourceChain 之后 (先声明后使用, 否则 TDZ 崩)。
    if (!sameSourceChain) {
      for (const [k] of pairs) {
        const f: any = ts.fields[k];
        if (f.source === 'chain-index') {
          out.push(`totals_scope.fields.${k}.source='chain-index' 而这一份快照的链上索引不可用 ` +
            `(activity_totals.source=${JSON.stringify(at.source)}) —— 声明与能力不符`);
        }
      }
    }
    for (const [k, top, src] of pairs) {
      const n = Number(src) || 0;
      const topN = (top === null || top === undefined) ? null : Number(top);
      const topScope: any = ts.fields[k];
      if (sameSourceChain && topScope.source === 'chain-index') {
        // 同源: 必须逐字相等, 不需要任何"解释"
        if (topN !== n) {
          out.push(`同一概念两个数: 顶部 totals.${k}=${topN === null ? '未接入' : topN} ≠ 链上索引同源计数 activity_totals.${k}=${n}` +
            ` (表格 ${tableRows} 行) —— 同源即恒等, 页面并排出现两个数就是矛盾`);
        }
        continue;
      }
      if (n > 0 && (topN === null || topN === 0)) {
        const explained = notes.includes('口径') && notes.includes(String(tableRows)) && notes.includes('脉冲事件');
        if (!explained) {
          out.push(`顶部 totals.${k}=${topN === null ? '未接入' : 0} 与表格里的 ${n} 个同类 (${tableRows} 行) 矛盾, 且没有任何口径说明`);
        }
      }
      if (topN !== null && n === 0 && tableRows === 0 && topN > 0) {
        out.push(`顶部 totals.${k}=${topN} 而表格一行都没有 (${tableRows} 行) —— 反向矛盾: 数不出行却报了数`);
      }
    }
  }

  // ④ 明说"数字不一样"时必须有解释 (老规矩保留; 不许只靠一句 label)
  if (ts.differs_from_activity === true) {
    const notes = Array.isArray(snap.notes) ? snap.notes.join(' ') : '';
    if (!notes.includes('口径')) out.push('totals_scope.differs_from_activity=true 但 notes 里没有任何口径说明');
  }
  return out;
}

/** open_tasks 行的字段白名单 (与 `OpenTaskRow` 逐字一致; 多一个键 = 可能把正文/身份带出去了) */
export const OPEN_TASK_KEYS = ['capability', 'budget', 'currency', 'network', 'deadline', 'claimed', 'announcementId'] as const;

/**
 * 待接单任务行的自检 (空 = 通过)。这不是格式洁癖, 每条都对着一个真泄漏路径:
 *   · 键集 ≠ 白名单 → 有人把 instruction / buyerDid / claims 之类**展平**进公开投影了;
 *   · `claimed !== false` → 「只导出未认领」这个筛选坏了 (页面会把已接单的当待接单);
 *   · `announcementId` 长于 8 位 → 短写丢了, 原始公告 id 上公开页 (页面上的 id 会被读者当完整 id 用);
 *   · capability 空 / deadline 非正 → 页面上会出现一条说不出是什么、也不知道何时截止的行。
 */
export function openTasksIssues(snap: NetworkPulseSnapshot): string[] {
  const out: string[] = [];
  const rows = (snap as any)?.open_tasks;
  if (!Array.isArray(rows)) return ['open_tasks 缺失 (公开「待接单任务」必须是数组, 没有就给空数组)'];
  const allow = OPEN_TASK_KEYS as readonly string[];
  rows.forEach((r: any, i: number) => {
    const at = `open_tasks[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { out.push(`${at} 不是对象`); return; }
    const extra = Object.keys(r).filter((k) => !allow.includes(k));
    if (extra.length) out.push(`${at} 出现白名单外的键: ${extra.join(', ')} (公开投影只许 ${allow.join('/')})`);
    if (typeof r.capability !== 'string' || !r.capability.trim()) out.push(`${at}.capability 缺失/为空`);
    if (r.claimed !== false) out.push(`${at}.claimed=${JSON.stringify(r.claimed)} —— 公开页只许列**未认领**的公告`);
    if (typeof r.announcementId !== 'string' || r.announcementId.length === 0 || r.announcementId.length > 8) {
      out.push(`${at}.announcementId 必须是 announcementId 的**前 8 位**(1..8 字符), 实得 ${JSON.stringify(r.announcementId)}`);
    }
    if (!Number.isFinite(r.deadline) || r.deadline <= 0) out.push(`${at}.deadline 必须是正的 ms 时间戳`);
    for (const k of ['budget', 'currency', 'network']) {
      if (r[k] !== null && typeof r[k] !== 'string') out.push(`${at}.${k} 只许字符串或 null (不替公告猜值)`);
    }
  });
  return out;
}

// ── 顶部计数的逐字段口径 (2026-09-24) ────────────────────────────────────────
// 页面把 8~9 个数字并排放在**一行**里, 一行一个总口径是解释不了它们的 —— 每个数必须自带来源。

const WINDOW_HOURS = Math.round(PULSE_LIMITS.windowMs / 3600000);

/** 「本节点 N h 脉冲事件」口径 (节点/智能体类计数, 以及链上索引不可用时的降级口径) */
function pulseField(what: { zh: string; en: string }): TotalsFieldScope {
  return {
    source: 'pulse-events',
    window: 'window-24h',
    short: { zh: `${WINDOW_HOURS}h 脉冲`, en: `${WINDOW_HOURS}h pulse` },
    label: {
      zh: `本节点 ${WINDOW_HOURS}h 观察窗口内收到的脉冲事件 · ${what.zh}`,
      en: `pulse events received by this node within the ${WINDOW_HOURS}h window · ${what.en}`,
    },
  };
}

/** 「链上索引 · 全量」口径 (与下方活动表**同源**: 同源即恒等, 页面不许并排两个数) */
function chainField(what: { zh: string; en: string }): TotalsFieldScope {
  return {
    source: 'chain-index',
    window: 'full',
    short: { zh: '链上索引·全量', en: 'chain index · whole' },
    label: {
      zh: `链上索引全量 (与下方活动表同源) · ${what.zh}`,
      en: `chain index, whole (same source as the activity table below) · ${what.en}`,
    },
  };
}

/** 「本机签名审计账」口径 (真源: `<home>/.bolloon/wallet-signatures.jsonl` 窗口内条数) */
function signatureAuditField(): TotalsFieldScope {
  return {
    source: 'signature-audit',
    window: 'window-24h',
    short: { zh: `${WINDOW_HOURS}h 签名审计`, en: `${WINDOW_HOURS}h signature audit` },
    label: {
      zh: `本机签名审计账 (wallet-signatures.jsonl) ${WINDOW_HOURS}h 内条数 —— 只数条数, 不含签名内容`,
      en: `rows in this node's signature audit log (wallet-signatures.jsonl) within ${WINDOW_HOURS}h — count only, no content`,
    },
  };
}

/** 「没有可用源」= 未接入 (值必须是 null; 页面必须写「未接入」, 不许拿 0 冒充「没发生过」) */
function noneField(why: { zh: string; en: string }): TotalsFieldScope {
  return {
    source: 'none',
    window: 'unknown',
    short: { zh: '未接入', en: 'not connected' },
    label: { zh: `没有可用源 → 报「未接入」而不是 0 · ${why.zh}`, en: `no available source → reported as "not connected", not 0 · ${why.en}` },
    unavailable: true,
  };
}

export function computeSnapshot(
  events: NetworkPulseEvent[],
  opts: {
    now: number;
    unavailable?: boolean;
    signedNodes?: number;
    /** 已解析好的活动行 (getNetworkPulse 注入真实链上索引结果); 不给 = 纯函数自己从事件降级算 */
    confirmedActivity?: ConfirmedActivityResult;
    /** 已解析好的公开「待接单任务」行 (getNetworkPulse 注入读盘结果); 不给 = 空数组 (不猜) */
    openTasks?: OpenTaskRow[];
    /**
     * 本机**签名审计账**的窗口内计数 (getNetworkPulse 注入; 真源 = `wallet-signatures.jsonl`)。
     * 不给 = 没有源 → `totals.signatures` 记 `null` (未接入), **不拿 0 冒充「没发生过」**。
     */
    signatureAudit?: SignatureAuditTally | null;
  },
): NetworkPulseSnapshot {
  const now = opts.now;
  const fresh_until = now + PULSE_LIMITS.snapshotTtlMs;
  if (opts.unavailable) {
    const emptyRows: ConfirmedActivityRow[] = [];
    const gates = normalizeActivityGates(DEFAULT_CONFIRMATIONS);
    // 观察层不可用 = **没有数** (不是 0): 计数一律 null/0 占位由页面整块隐藏, 口径逐字段标「未接入」。
    const downField = noneField({ zh: '观察层不可用', en: 'observation layer unavailable' });
    return {
      status: 'unavailable',
      generated_at: now,
      fresh_until,
      scope: 'observed',
      scope_label: { zh: '当前节点观察到', en: 'Observed by this node' },
      totals: {
        nodes: 0, agents: 0, active_agents: 0, seen_last_24h: 0,
        tasks: null, tasks_completed: null, tasks_verified: null, signatures: null, tasks_settled: null,
      },
      totals_scope: {
        source: 'pulse-events', window_ms: PULSE_LIMITS.windowMs,
        label: {
          zh: `本节点 ${WINDOW_HOURS}h 观察窗口的脉冲事件层不可用 → 没有数 (不是 0)`,
          en: `This node's ${WINDOW_HOURS}h pulse layer is unavailable → no counts (not zero)`,
        },
        differs_from_activity: false,
        fields: {
          nodes: downField, agents: downField, active_agents: downField, seen_last_24h: downField,
          tasks: downField, tasks_completed: downField, tasks_verified: downField,
          tasks_settled: downField, signatures: downField,
        },
      },
      capabilities: [],
      recent_activity: [],
      confirmed_activity: emptyRows,
      confirmed_activity_source: 'none',
      activity_totals: summarizeActivityRows(emptyRows, { source: 'none', gates }),
      chain_id_scope: buildChainIdScope(emptyRows),
      // 观察层不可用 ≠ 公告板读不到: 这一支只说明「脉冲事件层」挂了, 待接单任务照实带出来
      // (调用方没给就空数组 —— 不拿空数组冒充「板上没有」: 页面空态说的是「暂未观察到」)
      open_tasks: Array.isArray(opts.openTasks) ? opts.openTasks : [],
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

  // 经济计数 (**脉冲口径**) —— 注意: 顶部「任务/已完成/已结算」的**权威源是链上索引**
  // (见下面 chainAuthoritative 那一段), 脉冲口径只在索引不可用时才顶上去。
  // 按**不同任务**去重 (同一任务重复事件不虚增), 且只给聚合数不给内容
  const tasks = new Set<string>();
  const tasksCompleted = new Set<string>();
  const tasksVerified = new Set<string>();
  const tasksSettledPulse = new Set<string>();
  for (const e of window) {
    const t = (e as any).taskProof as string | undefined;
    if (!t) continue;
    if (e.type === 'task_posted' || e.type === 'task_accepted') tasks.add(t);
    if (e.type === 'task_completed' || e.type === 'trade_settled') tasksCompleted.add(t);
    if (e.type === 'trade_settled') tasksSettledPulse.add(t);
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

  // ★ 2026-09-24 (leo: 「数量怎么对不上, 尤其是后面的任务和钱包」):
  //   顶部任务类计数的**权威源改成链上索引** —— 它与下面那张表**同源**, 同源即恒等,
  //   从根上消灭「顶部 0 个任务 / 表格 15 行任务」这种并排矛盾 (不再靠 notes 辩解)。
  //   链上索引不可用 (降级 pulse-events) 时才退回旧的脉冲口径, 并在 fields 里如实标出降级。
  const chainAuthoritative = activity.source === 'chain-index';
  const totalsTasks = chainAuthoritative ? activity_totals.tasks : tasks.size;
  const totalsCompleted = chainAuthoritative ? activity_totals.tasks_completed : tasksCompleted.size;
  const totalsSettled = chainAuthoritative ? activity_totals.tasks_settled : tasksSettledPulse.size;
  // 「验真」在链上索引里**没有**对应事件 → 链上口径下这个数没有源 (null + 未接入), 不拿结算数冒充已验证
  const totalsVerified: number | null = chainAuthoritative ? null : tasksVerified.size;

  // 钱包签名: 真源 = 本机签名审计账 (窗口内条数, 只计数); 没有审计账 → 退回脉冲事件上报数;
  // 两个都没有 → null (未接入)。**绝不**在没有源的时候报 0 (那是「没发生过」, 是另一句话)。
  const sigTally = opts.signatureAudit ?? null;
  const auditWired = !!sigTally && sigTally.available === true;
  const totalsSignatures: number | null = auditWired
    ? Number(sigTally!.count)
    : (signatureKeys.size > 0 ? signatureKeys.size : null);

  const fields: Record<TotalsFieldKey, TotalsFieldScope> = {
    nodes: pulseField({ zh: '不同节点数', en: 'distinct nodes' }),
    agents: pulseField({ zh: '不同 Agent 数', en: 'distinct agents' }),
    active_agents: pulseField({ zh: '活跃 Agent 数', en: 'active agents' }),
    seen_last_24h: pulseField({ zh: '24h 内出现过的不同 Agent', en: 'distinct agents seen within 24h' }),
    tasks: chainAuthoritative
      ? chainField({ zh: '有链上活动的不同任务', en: 'distinct tasks with on-chain activity' })
      : pulseField({ zh: '观察到发起的任务', en: 'tasks observed as created' }),
    tasks_completed: chainAuthoritative
      ? chainField({ zh: '交付完成 (ProofSubmittedV2) 的不同任务', en: 'distinct tasks with ProofSubmittedV2' })
      : pulseField({ zh: '交付完成的任务', en: 'tasks observed as completed' }),
    tasks_settled: chainAuthoritative
      ? chainField({ zh: '托管结算 (Released/Refunded/Expired/Disputed) 的不同任务', en: 'distinct tasks with an on-chain escrow settlement' })
      : pulseField({ zh: '链上口径结算的任务', en: 'tasks with on-chain settlement' }),
    tasks_verified: chainAuthoritative
      ? noneField({ zh: '链上索引没有「验真」事件', en: 'the chain index has no verification event' })
      : pulseField({ zh: '真验真 (trade_verified) 的任务', en: 'tasks truly verified (trade_verified)' }),
    signatures: auditWired
      ? signatureAuditField()
      : (signatureKeys.size > 0
        ? pulseField({ zh: '上报过的钱包签名 (按来源+时刻去重)', en: 'reported wallet signatures (deduped by source+time)' })
        : noneField({ zh: '本节点既没有签名审计账, 也没有签名脉冲事件', en: 'this node has neither a signature audit log nor signature pulse events' })),
  };

  const totals_scope: TotalsScope = {
    source: chainAuthoritative ? 'mixed' : 'pulse-events',
    window_ms: PULSE_LIMITS.windowMs,
    label: {
      zh: chainAuthoritative
        ? `节点/智能体 = 本节点 ${WINDOW_HOURS}h 脉冲事件; 任务/已完成/已结算 = 链上索引全量 (与下表同源); 钱包签名 = 本机签名审计`
        : `只统计本节点 ${WINDOW_HOURS}h 观察窗口内收到的脉冲事件 (本节点自己上报的)`,
      en: chainAuthoritative
        ? `nodes/agents = this node's ${WINDOW_HOURS}h pulse events; tasks/completed/settled = chain index, whole (same source as the table below); wallet signatures = this node's signature audit log`
        : `Only pulse events received by this node within the ${WINDOW_HOURS}h observation window (reported by this node itself)`,
    },
    differs_from_activity: activity_totals.rows > 0 &&
      (totalsTasks !== activity_totals.tasks ||
        totalsCompleted !== activity_totals.tasks_completed ||
        totalsSettled !== activity_totals.tasks_settled),
    fields,
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
      `口径不同, 不是数据丢失: 链上索引不可用 → 顶部任务类计数**降级为脉冲口径** (本快照 tasks=${tasks.size} · ` +
      `tasks_completed=${tasksCompleted.size} · tasks_verified=${tasksVerified.size} · tasks_settled=${tasksSettledPulse.size} · ` +
      `signatures=${signatureKeys.size}); 上表 ${activity_totals.rows} 行来自脉冲事件 (同源计数见 activity_totals, ` +
      `不是链上索引全量) —— 每个数的来源见 totals_scope.fields`,
    );
  }
  if (chainAuthoritative) {
    notes.push(
      `顶部「任务/已完成/已结算」= 链上索引的**同源计数** (= activity_totals, 与下表同源, 同源即恒等): ` +
      `tasks=${totalsTasks} · tasks_completed=${totalsCompleted} · tasks_settled=${totalsSettled}; ` +
      `「节点/智能体」= 本节点 ${WINDOW_HOURS}h 脉冲事件; 「已验证」在链上索引里没有对应事件 → 不报 ` +
      `(未接入, 不是 0); 「钱包签名」= ${auditWired
        ? `本机签名审计账 ${totalsSignatures} 条 (${WINDOW_HOURS}h 窗口, 只计数)`
        : (totalsSignatures === null ? '未接入 (本节点无可用源)' : `脉冲事件上报 ${totalsSignatures} 条`)} — ` +
      `每个数的来源见 totals_scope.fields`,
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
      // ★ 任务类计数 = 链上索引同源值 (与下表恒等); 索引不可用才退回脉冲口径 (见 fields.tasks)
      tasks: totalsTasks,
      tasks_completed: totalsCompleted,
      tasks_verified: totalsVerified,        // 链上口径下 = null (未接入), 不冒充 0
      signatures: totalsSignatures,          // 真源 = 本机签名审计账; 无源 = null (未接入)
      tasks_settled: totalsSettled,          // 新增字段一律排最后 (老 8 个字段顺序逐字不变)
    },
    totals_scope,
    capabilities,
    recent_activity: recent,
    confirmed_activity: activity.rows,
    confirmed_activity_source: activity.source,
    activity_totals,
    chain_id_scope,
    open_tasks: Array.isArray(opts.openTasks) ? opts.openTasks : [],
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
        && !!(cached as any)?.totals_scope?.fields          // 老缓存没有逐字段口径 → 过期形状, 重算
        && !!(cached as any)?.activity_totals
        && !!(cached as any)?.chain_id_scope
        && Array.isArray((cached as any)?.open_tasks);        // 老缓存没有待接单任务 → 过期形状, 重算
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
  // 钱包签名的**真源**: 本机签名审计账 (窗口内条数)。没有账 → 注入 available:false → 快照标「未接入」
  // (不拿 0 冒充「没发生过」: 本机明明签过而脉冲事件丢了的那次真事故就是这么来的)
  const signatureAudit = tallySignatureAudit(opts.home, { now, windowMs: PULSE_LIMITS.windowMs });
  // 待接单任务: 只读本机公告板目录 (未认领且未过期), 投影成白名单 7 字段 —— 与脉冲事件层无关
  const snap = computeSnapshot(events, { now, confirmedActivity, openTasks: readOpenTasks(opts.home, now), signatureAudit });
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

/**
 * 允许出现 0x 长 hex 的键 (**唯一白名单**, 2026-09-23 leo 拍板; 同日收窄): 交易哈希 / escrow 合约地址 /
 * 交易浏览器链接 —— 都是公开链上事实。除了这 3 个键, 别处出现 0x 长 hex (尤其 EOA 钱包地址) 一律算泄露。
 * 注意 `contract` **只在数据里**(供索引/诊断), 页面不渲染合约地址也不给合约链接 ⇒ 没有 `explorer_contract` 这个键。
 */
export const PUBLIC_HEX_KEYS = ['tx_hash', 'contract', 'explorer_tx'] as const;

/**
 * 0x 长 hex 越界审计 (**粒度比 `assertNoPrivateFields` 更细**: 那个只看键名, 这个看值形态)。
 *   · 白名单键下: 形状必须精确 —— `tx_hash` = 0x+64 hex; `contract` = 0x+40 hex;
 *     `explorer_tx` = 我们造的**交易**浏览器链接形状 (`EXPLORER_URL_RE`)
 *   · **其他任何键**的值里出现 `0x` + 40/64 位 hex → 报出来 (买方·卖方 EOA、taskKey 原文、
 *     args 里的地址都属这一类); `explorer_contract` 之类不在白名单的键**同样**按泄露处理
 * 返回越界说明列表 (空 = 干净)。这条尺子**只收紧不放松**: 老口径下「任何 0x 长 hex 都不许」
 * 现在等价于「除了这 3 个白名单键, 任何 0x 长 hex 都不许」。
 */
export function auditPublicHexLeaks(value: unknown, at = '$'): string[] {
  const issues: string[] = [];
  const allow = PUBLIC_HEX_KEYS as readonly string[];
  const walk = (v: any, p: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) walk(val, `${p}.${k}`);
      return;
    }
    if (typeof v !== 'string') return;
    const s = v;
    const key = p.slice(p.lastIndexOf('.') + 1);
    // 白名单键: 形状必须精确 —— 不管值长短都查 (拿短串/怪串冒充同样拒绝)
    if (allow.includes(key)) {
      const ok = (key === 'tx_hash' && TX_HASH_RE.test(s))
        || (key === 'contract' && ADDRESS_RE.test(s))
        || (key === 'explorer_tx' && EXPLORER_URL_RE.test(s));
      if (!ok) issues.push(`${p} = 白名单键 ${key} 下的形状不对 (只认精确形状, 不认"含 0x 就算")`);
      return;
    }
    if (/0x[0-9a-fA-F]{40}/.test(s)) issues.push(`${p} = 0x 长 hex (只许出现在 ${allow.join('/')} 下) → 按泄露处理`);
  };
  walk(value, at);
  return issues;
}
