/**
 * task-board.ts — 任务对外发布 + 接单 (C1/C2, 2026-09-23)
 *
 * 补的是 M1 一个真实断点: 买方要委托任务时, 如果对方不在自己的注册表里, **根本发不出去** ——
 * 没有任何地方能"把一个待接单的任务公告出去让别人发现", 所以 M1 只能"自己买自己的技能"。
 * 本模块给出最小可用的对外通道:
 *
 *   publish  → 公告落盘 `~/.bolloon/tasks/board/<announcementId>.json` + 向 agent-registry 公告
 *              (`service.name = 'task.announce'`) + 记一条脉冲事件 `task_announced`
 *   board    → 本地公告 + **注册表发现的远端公告**, 按 announcementId 去重
 *   claim    → 一个 provider 接单: 记认领者 DID / 时间 / 声明价格; 重复认领/已取消/不存在一律拒
 *
 * 三条纪律 (与 task-inbox / task-contract 同源):
 *   · **任务正文只在本地**: instruction 只进本地公告文件; 注册表/公开投影里只有 sha256 摘要 + 60 字预览。
 *   · **公告必须签名**: 签名覆盖"公开载荷"(不含正文、不含可变 status); 验签或摘要对不上 → 接单被拒
 *     (拿不到事实就不许往下走, 绝不静默放行)。
 *   · **本模块一分钱都不动**: 认领只记账; 释放/验真是**纯裁决函数** `decideAnnouncementRelease`,
 *     未交付不得释放, 未链上结算不得标 verified, local-dev 永远不是链上结算。
 *
 * 未做 (如实标注, 不假装):
 *   · 远端公告的认领**只落本机台账**, 本版没有"向远端投递认领"的通道 (真交接仍走
 *     `bolloon task send` → 对方 `task accept`); 远端 claim 的返回值里明写 `deliveredToBuyer:false`。
 *   · 释放裁决只出结论,**不发链上交易** (真发交易属 chain 命令组/另一条并行线)。
 *   · 公告没有任何到期自动下架之外的清理 (过期只是不再可接单, 文件不删)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AgentService } from './agent-registry.js';
import type { TaskBudget, PaymentMode } from './task-contract.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

export const BOARD_PROTOCOL = 'bolloon-task/1';
export const BOARD_KIND = 'task_announcement';
/** 注册表里可发现的公告服务名 (远端靠它 + `announce:<id>` capability 找到公告) */
export const ANNOUNCE_SERVICE_NAME = 'task.announce';
/** 注册表 description 里的载荷前缀 (结构化 JSON 跟在这个标记后) */
export const ANNOUNCE_DESC_PREFIX = 'bolloon-task-announce/1 ';
export const ANNOUNCE_CAPABILITY = 'task.announce';
/** 远端认领落盘文件 (本机台账, 未投递) */
export const REMOTE_CLAIMS_FILE = 'remote-claims.json';
export const PREVIEW_MAX = 60;

export type AnnouncementStatus = 'open' | 'claimed' | 'cancelled';

// ── 路径 (全部在 ~/.bolloon/tasks/ 下, 与 inbox/local/results/bodies 同级) ────

const homeOf = (home?: string): string => home || process.env.HOME || os.homedir();
export const boardDir = (home?: string): string => path.join(homeOf(home), '.bolloon', 'tasks', 'board');

/** 只允许 announcementId 当文件名 (防路径穿越); 非法 → null */
function safeId(id: string): string | null {
  const s = String(id || '').trim();
  return /^ann-[A-Za-z0-9._-]{4,96}$/.test(s) ? s : null;
}

export function announcementFile(announcementId: string, home?: string): string | null {
  const id = safeId(announcementId);
  return id ? path.join(boardDir(home), `${id}.json`) : null;
}

function ensure(dir: string): boolean {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

function writeJson(file: string, value: unknown): { ok: boolean; error?: string } {
  try {
    ensure(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch { return null; }
}

const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 签名覆盖的**公开载荷** —— 不含任务正文, 不含可变 status (状态是本地可变事实, 不签名) */
export interface AnnouncementPublicPayload {
  protocol: typeof BOARD_PROTOCOL;
  kind: typeof BOARD_KIND;
  announcementId: string;
  capability: string;
  /** sha256(instruction) hex —— 正文只在本地, 远端只能拿摘要 */
  instructionDigest: string;
  /** 60 字以内预览 (本机 CLI 可读; 公开投影里只有它) */
  instructionPreview: string;
  buyerDid: string;
  buyerPublicKeyHex: string;
  budget: TaskBudget | null;
  deadline: number;
  paymentMode: PaymentMode;
  createdAt: number;
}

export interface TaskClaim {
  announcementId: string;
  providerDid: string;
  providerPublicKeyHex?: string | null;
  /** 认领时间 (ms) */
  claimedAt: number;
  /** 声明价格 (正整数原子单位串; 没声明 → null, 不替它猜) */
  priceAmountAtomic: string | null;
  currency: string;
  network: string;
  signature?: string | null;
  /** 远端公告的认领只在本机记账 (未投递) —— 如实标, 不假装送达 */
  deliveredToBuyer?: boolean;
}

export interface TaskAnnouncement extends AnnouncementPublicPayload {
  /** 任务正文 —— **只在本地文件**; 绝不进注册表/公开投影/stdout */
  instruction: string;
  status: AnnouncementStatus;
  updatedAt: number;
  claims: TaskClaim[];
  cancelledAt?: number;
  cancelReason?: string;
  replyTo?: string | null;
  signature: string;
}

/** 从注册表解析出来的远端公告 (payload 里没有正文) */
export interface RemoteAnnouncement {
  announcementId: string;
  capability: string;
  instructionDigest: string | null;
  instructionPreview: string | null;
  buyerDid: string;
  buyerPublicKeyHex: string | null;
  budget: TaskBudget | null;
  deadline: number | null;
  paymentMode: string | null;
  status: AnnouncementStatus | 'unknown';
  createdAt: number | null;
  signature: string | null;
  /** 注册表里的来源 agentId (可能不是真 DID) */
  registryAgentId: string;
  remote: true;
}

/** 板上一行 (本地/远端统一形状; 不含正文) */
export interface BoardEntry {
  announcementId: string;
  capability: string;
  buyerDid: string;
  buyerShort: string;
  status: AnnouncementStatus | 'unknown';
  budget: TaskBudget | null;
  deadline: number | null;
  deadlineInMs: number | null;
  createdAt: number | null;
  claimCount: number;
  claimedBy: string | null;
  claimedAt: number | null;
  instructionDigest: string | null;
  instructionPreview: string | null;
  /** true = 来自注册表 (本机没有这条公告文件) */
  remote: boolean;
  source: 'local' | 'registry';
  /** 公告签名验签结果; null = 没验 (绝不假装验过) */
  signatureVerified: boolean | null;
  /** 远端公告的认领只在本机记账 */
  claimable: boolean;
}

export interface BoardView {
  entries: BoardEntry[];
  localCount: number;
  remoteCount: number;
  /** 同时在本地与注册表出现的 id (去重后只算一次) */
  duplicates: string[];
  registryReady: boolean;
  registryError: string | null;
  notes: string[];
}

// ── id 派生 ─────────────────────────────────────────────────────────────────

export function budgetKey(budget?: TaskBudget | null): string {
  return budget ? `${budget.maxAmount}:${budget.currency}:${budget.network}` : 'none';
}

/**
 * **稳定** announcementId: 由 (capability, 正文, 买方, 预算) 确定性派生。
 * 同一买方对同一个能力 + 同一段正文 + 同一预算重复 publish → 同一个 id (幂等, 不产生第二条公告)。
 * deadline **不参与** id (它是时限而不是身份): 重发只会在既有公告上留一句说明, 不覆盖既有认领。
 */
export function deriveAnnouncementId(input: { capability: string; instruction: string; buyerDid: string; budget?: TaskBudget | null }): string {
  const h = sha256Hex(`${String(input.capability).trim()}|${String(input.instruction).trim()}|${input.buyerDid}|${budgetKey(input.budget)}`);
  return `ann-${h.slice(0, 16)}`;
}

export function previewOf(instruction: string): string {
  const s = String(instruction || '').replace(/\s+/g, ' ').trim();
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

export function publicPayloadOf(a: TaskAnnouncement | RemoteAnnouncement): AnnouncementPublicPayload {
  return {
    protocol: BOARD_PROTOCOL,
    kind: BOARD_KIND,
    announcementId: a.announcementId,
    capability: a.capability,
    instructionDigest: String(a.instructionDigest || ''),
    instructionPreview: String(a.instructionPreview || ''),
    buyerDid: a.buyerDid,
    buyerPublicKeyHex: String(a.buyerPublicKeyHex || ''),
    budget: a.budget ?? null,
    deadline: Number(a.deadline || 0),
    paymentMode: (a.paymentMode as PaymentMode) || 'policy',
    createdAt: Number(a.createdAt || 0),
  };
}

// ── 读 / 写 ─────────────────────────────────────────────────────────────────

export function readAnnouncement(announcementId: string, home?: string): TaskAnnouncement | null {
  const f = announcementFile(announcementId, home);
  if (!f) return null;
  const a = readJson<TaskAnnouncement>(f);
  return a && a.announcementId ? a : null;
}

export function listAnnouncements(home?: string): TaskAnnouncement[] {
  try {
    const dir = boardDir(home);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f.startsWith('ann-') && f !== REMOTE_CLAIMS_FILE)
      .map((f) => readJson<TaskAnnouncement>(path.join(dir, f)))
      .filter((x): x is TaskAnnouncement => !!x?.announcementId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch { return []; }
}

export function saveAnnouncement(a: TaskAnnouncement, home?: string): { ok: boolean; error?: string } {
  const f = announcementFile(a.announcementId, home);
  if (!f) return { ok: false, error: `announcementId 非法 (不能当文件名): ${a.announcementId}` };
  return writeJson(f, a);
}

/** 公告签名验签 (真验, 不是硬编 true); 缺签名/公钥非法/验不过 → false */
export async function verifyAnnouncementSignature(a: { signature?: string | null } & Partial<AnnouncementPublicPayload>): Promise<boolean> {
  try {
    const { verifyTaskEnvelope } = await import('./task-contract.js');
    const { verifierFor } = await import('./local-signer.js');
    const sig = String(a?.signature || '');
    const pub = String((a as any)?.buyerPublicKeyHex || '');
    if (!sig || !pub) return false;
    const vf = verifierFor(pub);
    if (!vf) return false;
    const payload = { ...publicPayloadOf(a as any), signature: sig };
    return await verifyTaskEnvelope(payload as any, vf as any);
  } catch { return false; }
}

// ── publish ─────────────────────────────────────────────────────────────────

export interface PublishInput {
  capability: string;
  instruction: string;
  buyerDid: string;
  buyerPublicKeyHex: string;
  budget?: TaskBudget | null;
  deadline: number;
  paymentMode: PaymentMode;
  replyTo?: string | null;
  /** 有 keypair 就签名 (本机身份); 没有 → 公告不带签名 (接单时会被拒) */
  signerKeypair?: unknown;
}

export interface PublishDeps {
  home?: string;
  now?: number;
  /** 注入注册表 (真实现 = getAgentRegistry()); 不传 → 动态 import 真注册表 */
  registry?: RegistryLike | null;
  /** 注入脉冲记录器 (测试用); 不传 → 用 network-pulse 真写 */
  recordEvent?: ((ev: { type: string; capability?: string; did?: string; taskId?: string; at?: number }) => Promise<{ ok: boolean; reason?: string }>) | null;
  /** 不碰网络/注册表/脉冲 (纯落盘; 离线验收用) */
  offline?: boolean;
}

export interface RegistryLike {
  ready?: boolean;
  list(): Promise<AgentService[]>;
  register(s: AgentService): Promise<{ ok: boolean; error?: string }>;
}

export interface PublishResult {
  ok: boolean;
  dup: boolean;
  announcement?: TaskAnnouncement;
  /** 落盘结果 */
  file?: string;
  /** 签名是否真加上了 (没有身份 → false, 不假装) */
  signed: boolean;
  registry: { attempted: boolean; announced: boolean; ready: boolean; error: string | null; entries: number };
  pulse: { attempted: boolean; ok: boolean; reason: string | null };
  error?: string;
}

async function defaultRegistry(): Promise<RegistryLike | null> {
  try {
    const { getAgentRegistry } = await import('./agent-registry.js');
    return getAgentRegistry() as unknown as RegistryLike;
  } catch { return null; }
}

/**
 * 发布一条待接单任务公告。
 * **幂等**: 同一 (capability, 正文, 买方, 预算) → 同一个 announcementId; 已存在 → 返回既有公告 (dup:true),
 * 不覆盖已有认领、不重复向注册表写第二份。
 */
export async function publishAnnouncement(input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  const now = deps.now ?? Date.now();
  const capability = String(input.capability || '').trim();
  const instruction = String(input.instruction || '').trim();
  if (!capability) return { ok: false, dup: false, signed: false, registry: { attempted: false, announced: false, ready: false, error: null, entries: 0 }, pulse: { attempted: false, ok: false, reason: null }, error: 'capability 必填' };
  if (!instruction) return { ok: false, dup: false, signed: false, registry: { attempted: false, announced: false, ready: false, error: null, entries: 0 }, pulse: { attempted: false, ok: false, reason: null }, error: 'instruction 必填 (任务正文不能是空的)' };
  if (!Number.isFinite(input.deadline) || input.deadline <= 0) return { ok: false, dup: false, signed: false, registry: { attempted: false, announced: false, ready: false, error: null, entries: 0 }, pulse: { attempted: false, ok: false, reason: null }, error: 'deadline 必须是未来毫秒时间戳' };
  if (!String(input.buyerDid || '').trim()) return { ok: false, dup: false, signed: false, registry: { attempted: false, announced: false, ready: false, error: null, entries: 0 }, pulse: { attempted: false, ok: false, reason: null }, error: 'buyerDid 必填 (公告必须有可追责的买方身份)' };

  const announcementId = deriveAnnouncementId({ capability, instruction, buyerDid: input.buyerDid, budget: input.budget ?? null });
  const existing = readAnnouncement(announcementId, deps.home);
  if (existing) {
    return {
      ok: true, dup: true, announcement: existing,
      file: `~/.bolloon/tasks/board/${announcementId}.json`,
      signed: !!existing.signature,
      registry: { attempted: false, announced: false, ready: false, error: null, entries: 0 },
      pulse: { attempted: false, ok: false, reason: '已存在的公告不重复记事件' },
    };
  }

  const base: TaskAnnouncement = {
    protocol: BOARD_PROTOCOL,
    kind: BOARD_KIND,
    announcementId,
    capability,
    instruction,
    instructionDigest: sha256Hex(instruction),
    instructionPreview: previewOf(instruction),
    buyerDid: input.buyerDid,
    buyerPublicKeyHex: String(input.buyerPublicKeyHex || ''),
    budget: input.budget ?? null,
    deadline: input.deadline,
    paymentMode: input.paymentMode,
    createdAt: now,
    status: 'open',
    updatedAt: now,
    claims: [],
    replyTo: input.replyTo ?? null,
    signature: '',
  };

  // 签名 (覆盖公开载荷); 没有 keypair → 不签 (接单时会被拒 —— 如实, 不糊)
  let signed = false;
  if (input.signerKeypair) {
    try {
      const { signTaskEnvelope } = await import('./task-contract.js');
      const s = await signTaskEnvelope(publicPayloadOf(base) as any, input.signerKeypair);
      base.signature = String((s as any).signature || '');
      signed = !!base.signature;
    } catch { signed = false; }
  }

  const w = saveAnnouncement(base, deps.home);
  if (!w.ok) {
    return { ok: false, dup: false, signed, registry: { attempted: false, announced: false, ready: false, error: null, entries: 0 }, pulse: { attempted: false, ok: false, reason: null }, error: `公告落盘失败: ${w.error}` };
  }

  // 向注册表公告 (把该买方的全部 open 公告一起写进同一个 AgentService 条目 —— 注册表按 agentId upsert)
  const registryResult: PublishResult['registry'] = deps.offline
    ? { attempted: false, announced: false, ready: false, error: null, entries: 0 }
    : await refreshRegistryAnnouncements(input.buyerDid, { home: deps.home, registry: deps.registry });

  // 脉冲事件 (匿名): 复用经济事件族, 新增 task_announced
  const pulse: PublishResult['pulse'] = { attempted: false, ok: false, reason: null };
  if (!deps.offline) {
    pulse.attempted = true;
    try {
      const rec = deps.recordEvent || (async (ev) => {
        const { recordNetworkEvent } = await import('./network-pulse.js');
        return await recordNetworkEvent(ev as any, deps.home);
      });
      const r = await rec({ type: 'task_announced', capability, did: input.buyerDid, taskId: announcementId, at: now });
      pulse.ok = r.ok === true;
      pulse.reason = r.reason ?? null;
    } catch (e: any) {
      pulse.reason = String(e?.message || e).slice(0, 160);
    }
  }

  return {
    ok: true, dup: false, announcement: base,
    file: `~/.bolloon/tasks/board/${announcementId}.json`,
    signed, registry: registryResult, pulse,
  };
}

/**
 * 把一个买方的 open 公告打包成注册表可发现的 AgentService (正文绝不进去)。
 * `capabilities` 里带 `announce:<id>` 便于 discover; 结构化字段在 description 的
 * `bolloon-task-announce/1 <JSON>` 载荷里 (远端要用的都在这里: 能力/预算/截止/摘要/签名)。
 */
export function buildAnnouncementService(buyerDid: string, open: TaskAnnouncement[]): AgentService {
  const payloads = open.map((a) => ({
    announcementId: a.announcementId,
    capability: a.capability,
    instructionDigest: a.instructionDigest,
    instructionPreview: a.instructionPreview,
    buyerDid: a.buyerDid,
    buyerPublicKeyHex: a.buyerPublicKeyHex,
    budget: a.budget ?? null,
    deadline: a.deadline,
    paymentMode: a.paymentMode,
    status: a.status,
    createdAt: a.createdAt,
    signature: a.signature,
    replyTo: a.replyTo ?? null,
  }));
  const first = open[0];
  return {
    agentId: buyerDid,
    name: `任务公告 (${open.length})`,
    wallet: '0x0',
    service: {
      name: ANNOUNCE_SERVICE_NAME,
      description: `${ANNOUNCE_DESC_PREFIX}${JSON.stringify(payloads)}`,
      price: first?.budget
        ? { amount: String(first.budget.maxAmount), currency: String(first.budget.currency), per: 'task' }
        : { amount: '0', currency: 'USDC', per: 'task' },
    },
    capabilities: [ANNOUNCE_CAPABILITY, ...open.map((a) => `announce:${a.announcementId}`)],
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export interface RegistryOutcome { attempted: boolean; announced: boolean; ready: boolean; error: string | null; entries: number }

/**
 * 把某买方**当前 open** 的公告集合同步到注册表 (注册表按 agentId upsert, 所以一个买方一条条目)。
 * 幂等; 失败如实回 `announced:false + error` (不假装公告出去了)。publish 与 cancel 都用它 ——
 * 取消后也能立刻把条目刷成新事实 (否则远端会短暂看到已撤销的公告)。
 */
export async function refreshRegistryAnnouncements(
  buyerDid: string,
  deps: { home?: string; registry?: RegistryLike | null } = {},
): Promise<RegistryOutcome> {
  const out: RegistryOutcome = { attempted: true, announced: false, ready: false, error: null, entries: 0 };
  const reg = deps.registry !== undefined ? deps.registry : await defaultRegistry();
  if (!reg) { out.error = '注册表不可用 (拿不到 registry 实例)'; return out; }
  out.ready = reg.ready === true;
  try {
    const open = listAnnouncements(deps.home).filter((a) => a.buyerDid === buyerDid && a.status === 'open');
    const svc = buildAnnouncementService(buyerDid, open);
    out.entries = svc.capabilities?.length ?? 0;
    const r = await reg.register(svc);
    out.announced = r.ok === true;
    out.error = r.ok ? null : String(r.error || '注册表拒绝');
  } catch (e: any) {
    out.error = String(e?.message || e).slice(0, 160);
  }
  return out;
}

/** 从注册表条目里解析远端公告 (坏 JSON/坏字段 → 跳过, 不猜) */
export function parseRegistryAnnouncements(services: AgentService[]): RemoteAnnouncement[] {
  const out: RemoteAnnouncement[] = [];
  for (const s of services || []) {
    const caps: string[] = Array.isArray(s?.capabilities) ? (s.capabilities as string[]) : [];
    const desc = String(s?.service?.description || '');
    if (!caps.includes(ANNOUNCE_CAPABILITY) && !desc.startsWith(ANNOUNCE_DESC_PREFIX)) continue;
    if (!desc.startsWith(ANNOUNCE_DESC_PREFIX)) continue;
    let arr: any[] = [];
    try { arr = JSON.parse(desc.slice(ANNOUNCE_DESC_PREFIX.length)); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const id = String(p?.announcementId || '');
      if (!safeId(id) || !p?.capability) continue;
      out.push({
        announcementId: id,
        capability: String(p.capability),
        instructionDigest: p.instructionDigest ? String(p.instructionDigest) : null,
        instructionPreview: p.instructionPreview ? String(p.instructionPreview) : null,
        buyerDid: String(p.buyerDid || s.agentId || ''),
        buyerPublicKeyHex: p.buyerPublicKeyHex ? String(p.buyerPublicKeyHex) : null,
        budget: p.budget && typeof p.budget === 'object' ? { maxAmount: String(p.budget.maxAmount), currency: p.budget.currency, network: String(p.budget.network) } : null,
        deadline: Number.isFinite(Number(p.deadline)) ? Number(p.deadline) : null,
        paymentMode: p.paymentMode ? String(p.paymentMode) : null,
        status: ['open', 'claimed', 'cancelled'].includes(String(p.status)) ? (String(p.status) as AnnouncementStatus) : 'unknown',
        createdAt: Number.isFinite(Number(p.createdAt)) ? Number(p.createdAt) : null,
        signature: p.signature ? String(p.signature) : null,
        registryAgentId: String(s.agentId || ''),
        remote: true,
      });
    }
  }
  return out;
}

// ── board ───────────────────────────────────────────────────────────────────

export function boardEntryOf(a: TaskAnnouncement, now: number, verified: boolean | null): BoardEntry {
  const last = a.claims[a.claims.length - 1] ?? null;
  return {
    announcementId: a.announcementId,
    capability: a.capability,
    buyerDid: a.buyerDid,
    buyerShort: String(a.buyerDid).slice(0, 28),
    status: a.status,
    budget: a.budget ?? null,
    deadline: a.deadline ?? null,
    deadlineInMs: a.deadline ? a.deadline - now : null,
    createdAt: a.createdAt ?? null,
    claimCount: a.claims.length,
    claimedBy: last?.providerDid ?? null,
    claimedAt: last?.claimedAt ?? null,
    instructionDigest: a.instructionDigest,
    instructionPreview: a.instructionPreview,
    remote: false,
    source: 'local',
    signatureVerified: verified,
    claimable: a.status === 'open' && (a.deadline ?? 0) > now,
  };
}

export function remoteBoardEntryOf(r: RemoteAnnouncement, now: number, verified: boolean | null): BoardEntry {
  return {
    announcementId: r.announcementId,
    capability: r.capability,
    buyerDid: r.buyerDid,
    buyerShort: String(r.buyerDid).slice(0, 28),
    status: r.status,
    budget: r.budget,
    deadline: r.deadline,
    deadlineInMs: r.deadline ? r.deadline - now : null,
    createdAt: r.createdAt,
    claimCount: 0,             // 远端的认领数本机看不到 —— 不编
    claimedBy: null,
    claimedAt: null,
    instructionDigest: r.instructionDigest,
    instructionPreview: r.instructionPreview,
    remote: true,
    source: 'registry',
    signatureVerified: verified,
    claimable: r.status === 'open' && (r.deadline ?? 0) > now,
  };
}

export interface ListBoardOpts {
  home?: string;
  now?: number;
  registry?: RegistryLike | null;
  /** 只看还能接单的 (status=open 且未过期) */
  openOnly?: boolean;
  /** 不读注册表 (只本地) */
  localOnly?: boolean;
}

/**
 * 板: 本地公告 + 注册表发现的远端公告, **按 announcementId 去重** (本地胜出)。
 * 注册表读不到 → `registryError` 如实带出 (不是静默空板)。
 */
export async function listBoard(opts: ListBoardOpts = {}): Promise<BoardView> {
  const now = opts.now ?? Date.now();
  const local = listAnnouncements(opts.home);
  const entries: BoardEntry[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const a of local) {
    const v = await verifyAnnouncementSignature(a);
    entries.push(boardEntryOf(a, now, v));
    seen.add(a.announcementId);
  }
  let remoteCount = 0;
  let registryReady = false;
  let registryError: string | null = null;
  const duplicates: string[] = [];
  if (!opts.localOnly) {
    const reg = opts.registry !== undefined ? opts.registry : await defaultRegistry();
    if (!reg) {
      registryError = '注册表不可用 (拿不到 registry 实例)';
    } else {
      registryReady = reg.ready === true;
      try {
        const services = await reg.list();
        const remotes = parseRegistryAnnouncements(services || []);
        for (const r of remotes) {
          if (seen.has(r.announcementId)) { if (!duplicates.includes(r.announcementId)) duplicates.push(r.announcementId); continue; }
          seen.add(r.announcementId);
          const v = await verifyAnnouncementSignature(r as any);
          entries.push(remoteBoardEntryOf(r, now, v));
          remoteCount++;
        }
      } catch (e: any) {
        registryError = String(e?.message || e).slice(0, 160);
      }
    }
  }
  if (!registryReady && !registryError) notes.push('注册表未就绪 (OrbitDB 离线): 本地公告仍在, 远端公告可能看不全');
  notes.push('instruction 正文只在本地公告文件里; 板上只有 sha256 摘要 + 预览');
  const filtered = opts.openOnly ? entries.filter((e) => e.claimable) : entries;
  return { entries: filtered, localCount: local.length, remoteCount, duplicates, registryReady, registryError, notes };
}

/** 有匹配的**可接单**公告 (给 `task send` 的"没 provider"提示用; 拿不到事实 → 空数组) */
export async function findOpenAnnouncementsForCapability(capability: string, opts: ListBoardOpts = {}): Promise<BoardEntry[]> {
  const cap = String(capability || '').trim().toLowerCase();
  if (!cap) return [];
  try {
    const view = await listBoard(opts);
    return view.entries.filter((e) => e.claimable && String(e.capability).trim().toLowerCase() === cap);
  } catch { return []; }
}

/**
 * 认领的价格声明 (只陈述事实): 声明了就说声明了多少, 没声明就说没声明 ——
 * 绝不替 provider 编一个价格出来。
 */
function claimPriceNote(c: { priceAmountAtomic?: string | null; currency?: string }): string {
  return c.priceAmountAtomic
    ? `声明价格 ${c.priceAmountAtomic} ${String(c.currency || 'USDC').toUpperCase()} (原子单位)`
    : '未声明价格 (按公告预算执行; 不编价)';
}

// ── claim ───────────────────────────────────────────────────────────────────
export type ClaimReason =
  | 'claimed' | 'invalid_id' | 'not_found' | 'already_claimed' | 'cancelled'
  | 'signature_invalid' | 'instruction_digest_mismatch' | 'deadline_expired' | 'not_announcement';

export interface ClaimInput {
  providerDid: string;
  providerPublicKeyHex?: string | null;
  priceAmountAtomic?: string | null;
  currency?: string;
  network?: string;
  signerKeypair?: unknown;
}

export interface ClaimResult {
  ok: boolean;
  reason: ClaimReason;
  announcementId: string;
  claim?: TaskClaim;
  /** 已有的认领 (重复认领时带出来) */
  existingClaim?: TaskClaim | null;
  status?: AnnouncementStatus | 'unknown';
  /** 远端公告: 认领只落本机台账, 未投递给买方 (如实标) */
  deliveredToBuyer: boolean;
  remote: boolean;
  /** 本模块**永不**动钱 */
  fundsMoved: false;
  paid: false;
  verified: false;
  message: string;
  /** 价格声明的人话版: 声明了就写多少, 没声明就写"未声明" (不编价) */
  priceNote?: string;
  file?: string;
}

function refuse(announcementId: string, reason: ClaimReason, message: string, extra: Partial<ClaimResult> = {}): ClaimResult {
  return {
    ok: false, reason, announcementId, deliveredToBuyer: false, remote: false,
    fundsMoved: false, paid: false, verified: false, message, ...extra,
  };
}

/** 远端认领台账 (~/.bolloon/tasks/board/remote-claims.json) */
export function readRemoteClaims(home?: string): TaskClaim[] {
  const list = readJson<TaskClaim[]>(path.join(boardDir(home), REMOTE_CLAIMS_FILE));
  return Array.isArray(list) ? list : [];
}

function saveRemoteClaim(claim: TaskClaim, home?: string): { ok: boolean; error?: string } {
  const f = path.join(boardDir(home), REMOTE_CLAIMS_FILE);
  const list = readRemoteClaims(home);
  list.push(claim);
  return writeJson(f, list);
}

export interface ClaimOpts {
  home?: string;
  now?: number;
  registry?: RegistryLike | null;
  recordEvent?: ((ev: { type: string; capability?: string; did?: string; taskId?: string; at?: number }) => Promise<{ ok: boolean; reason?: string }>) | null;
}

/**
 * 一个 provider 接单。记录: 认领者 DID + 时间 + 声明价格。
 * **一律拒绝并给原因**的情形: 重复认领 (已被认领 / 同一 provider 再claim) · 已取消 · 不存在 ·
 * 签名验不过 / 正文摘要对不上 · 已过期。
 */
export async function claimAnnouncement(announcementId: string, input: ClaimInput, opts: ClaimOpts = {}): Promise<ClaimResult> {
  const now = opts.now ?? Date.now();
  const id = String(announcementId || '').trim();
  if (!safeId(id)) return refuse(id, 'invalid_id', `announcementId 不合法: ${id || '(空)'} (形如 ann-xxxxxxxxxxxxxxxx)`);
  const providerDid = String(input.providerDid || '').trim();
  if (!providerDid) return refuse(id, 'invalid_id', '接单必须有认领者 DID (没有身份 → 不接单, 不假装)');

  // ① 本地公告
  const local = readAnnouncement(id, opts.home);
  if (local) {
    if (local.status === 'claimed') {
      const first = local.claims[0] ?? null;
      return refuse(id, 'already_claimed',
        `这条公告已经被认领了 (认领者 ${first?.providerDid || '未知'}, ${first ? new Date(first.claimedAt).toISOString() : ''}); 同一 id 不重复认领`,
        { existingClaim: first, status: local.status, claim: first ?? undefined });
    }
    if (local.status === 'cancelled') {
      return refuse(id, 'cancelled', `这条公告已取消 (${local.cancelReason || '未给原因'}) → 不接单`, { status: local.status });
    }
    if (!local.instruction || sha256Hex(local.instruction) !== local.instructionDigest) {
      return refuse(id, 'instruction_digest_mismatch',
        '公告正文与签名时的摘要对不上 (文件被改过) → 拒 (不拿不一致的事实往下走)', { status: local.status });
    }
    const sigOk = await verifyAnnouncementSignature(local);
    if (!sigOk) {
      return refuse(id, 'signature_invalid',
        '公告签名验不过 (缺签名/公钥非法/被改过) → 拒 (不接没签名的单)', { status: local.status });
    }
    if (Number(local.deadline) <= now) {
      return refuse(id, 'deadline_expired', `公告已过期 (截止 ${new Date(Number(local.deadline)).toISOString()}) → 不接单`, { status: local.status });
    }
    if (local.claims.some((c) => c.providerDid === providerDid)) {
      const mine = local.claims.find((c) => c.providerDid === providerDid)!;
      return refuse(id, 'already_claimed', `你已经认领过这条公告 (${new Date(mine.claimedAt).toISOString()}) → 幂等: 不重复认领`, { existingClaim: mine, status: local.status });
    }

    const claim: TaskClaim = {
      announcementId: id,
      providerDid,
      providerPublicKeyHex: input.providerPublicKeyHex ?? null,
      claimedAt: now,
      priceAmountAtomic: input.priceAmountAtomic ? String(input.priceAmountAtomic) : null,
      currency: String(input.currency || local.budget?.currency || 'USDC').toUpperCase(),
      network: String(input.network || local.budget?.network || ''),
      deliveredToBuyer: false,
    };
    if (input.signerKeypair) {
      try {
        const { signTaskEnvelope } = await import('./task-contract.js');
        const s = await signTaskEnvelope({ ...claim, signature: undefined } as any, input.signerKeypair);
        claim.signature = String((s as any).signature || '') || null;
      } catch { claim.signature = null; }
    }
    const next: TaskAnnouncement = { ...local, status: 'claimed', updatedAt: now, claims: [...local.claims, claim] };
    const w = saveAnnouncement(next, opts.home);
    if (!w.ok) return refuse(id, 'not_announcement', `认领落盘失败: ${w.error}`, { status: local.status });

    // 脉冲: 复用既有经济事件 task_accepted (匿名)
    try {
      const rec = opts.recordEvent || (async (ev) => {
        const { recordNetworkEvent } = await import('./network-pulse.js');
        return await recordNetworkEvent(ev as any, opts.home);
      });
      await rec({ type: 'task_accepted', capability: local.capability, did: providerDid, taskId: id, at: now });
    } catch { /* 脉冲失败不影响认领事实 */ }

    return {
      ok: true, reason: 'claimed', announcementId: id, claim, existingClaim: null,
      status: 'claimed', deliveredToBuyer: false, remote: false,
      fundsMoved: false, paid: false, verified: false,
      message: `已认领 ${id} (${local.capability}); ${claimPriceNote(claim)}; 只记认领事实: 不执行、不付款、不标 verified`,
      priceNote: claimPriceNote(claim),
      file: `~/.bolloon/tasks/board/${id}.json`,
    };
  }

  // ② 远端公告 (注册表里发现的) —— 认领只落本机台账 (本版没有投递通道)
  const reg = opts.registry !== undefined ? opts.registry : await defaultRegistry();
  let remote: RemoteAnnouncement | null = null;
  let registryError: string | null = null;
  if (reg) {
    try {
      const services = await reg.list();
      remote = parseRegistryAnnouncements(services || []).find((r) => r.announcementId === id) ?? null;
    } catch (e: any) { registryError = String(e?.message || e).slice(0, 160); }
  } else registryError = '注册表不可用';
  if (!remote) {
    return refuse(id, 'not_found',
      `板上没有这个公告: ${id} (本地 + 注册表都查过)${registryError ? ` — 注册表读取失败: ${registryError}` : ''}`);
  }
  if (remote.status === 'claimed') return refuse(id, 'already_claimed', `远端公告显示已被认领 (status=claimed) → 不重复认领`, { remote: true, status: remote.status });
  if (remote.status === 'cancelled') return refuse(id, 'cancelled', '远端公告已取消 → 不接单', { remote: true, status: remote.status });
  if (remote.status !== 'open') return refuse(id, 'not_found', `远端公告状态未知 (${remote.status}) → 拒 (不拿不确定的事实接单)`, { remote: true, status: remote.status });
  if (remote.deadline !== null && remote.deadline <= now) return refuse(id, 'deadline_expired', `远端公告已过期 (截止 ${new Date(remote.deadline).toISOString()}) → 不接单`, { remote: true, status: remote.status });
  const remoteSigOk = await verifyAnnouncementSignature(remote as any);
  if (!remoteSigOk) return refuse(id, 'signature_invalid', '远端公告签名验不过 → 拒 (不接没签名的单)', { remote: true, status: remote.status });
  const already = readRemoteClaims(opts.home).find((c) => c.announcementId === id && c.providerDid === providerDid);
  if (already) return refuse(id, 'already_claimed', `你已经认领过这条远端公告 (${new Date(already.claimedAt).toISOString()}) → 幂等: 不重复认领`, { remote: true, existingClaim: already, status: remote.status });

  const claim: TaskClaim = {
    announcementId: id,
    providerDid,
    providerPublicKeyHex: input.providerPublicKeyHex ?? null,
    claimedAt: now,
    priceAmountAtomic: input.priceAmountAtomic ? String(input.priceAmountAtomic) : null,
    currency: String(input.currency || remote.budget?.currency || 'USDC').toUpperCase(),
    network: String(input.network || remote.budget?.network || ''),
    deliveredToBuyer: false,
  };
  const w = saveRemoteClaim(claim, opts.home);
  if (!w.ok) return refuse(id, 'not_announcement', `远端认领台账落盘失败: ${w.error}`, { remote: true });
  return {
    ok: true, reason: 'claimed', announcementId: id, claim, existingClaim: null, status: remote.status,
    deliveredToBuyer: false, remote: true,
    fundsMoved: false, paid: false, verified: false,
    message: `已认领远端公告 ${id} (${claimPriceNote(claim)}; 只落本机台账: **没有投递给买方**; 真交接走 bolloon task send → 对方 accept)`,
    priceNote: claimPriceNote(claim),
    file: `~/.bolloon/tasks/board/${REMOTE_CLAIMS_FILE}`,
  };
}

// ── cancel (本地事实; 没有 CLI 入口, 由买方在本地调用) ──────────────────────

/**
 * 买方撤下自己的公告 (本地事实) + 立刻把注册表条目刷成新事实 (否则远端会短暂看到已撤销的公告)。
 * **已认领的公告不许取消** —— 认领是别人已经在走的事实, 静默取消会让对方白干 (拒, 并给原因)。
 * 没有 CLI 入口 (任务书只点名 publish/board/claim); 这里导出是为了让"已取消的公告被拒接单"这条
 * 负控制走**真代码**, 而不是手工改文件。
 */
export async function cancelAnnouncement(
  announcementId: string,
  reason: string,
  opts: { home?: string; now?: number; registry?: RegistryLike | null } = {},
): Promise<{ ok: boolean; error?: string; announcement?: TaskAnnouncement; registry?: RegistryOutcome }> {
  const now = opts.now ?? Date.now();
  const cur = readAnnouncement(announcementId, opts.home);
  if (!cur) return { ok: false, error: `板上没有这条公告: ${announcementId}` };
  if (cur.status === 'claimed') return { ok: false, error: `已认领的公告不许取消 (认领者 ${cur.claims[0]?.providerDid || '未知'} 已在执行; 静默取消 = 让人白干)` };
  if (cur.status === 'cancelled') return { ok: true, announcement: cur };
  const next: TaskAnnouncement = { ...cur, status: 'cancelled', updatedAt: now, cancelledAt: now, cancelReason: String(reason || '').slice(0, 200) };
  const w = saveAnnouncement(next, opts.home);
  if (!w.ok) return { ok: false, error: w.error };
  const registry = await refreshRegistryAnnouncements(cur.buyerDid, { home: opts.home, registry: opts.registry });
  return { ok: true, announcement: next, registry };
}

// ── 释放 / 验真裁决 (纯函数; 不动钱, 只出结论) ──────────────────────────────

export type ReleaseCode =
  | 'RELEASE_OK' | 'ALREADY_RELEASED' | 'NOT_CLAIMED' | 'DISPUTE_OPEN'
  | 'NOT_DELIVERED' | 'LOCAL_DEV_NOT_CHAIN' | 'NOT_CHAIN_SETTLED';

export interface ReleaseDecision {
  announcementId: string;
  action: 'release' | 'refuse';
  code: ReleaseCode;
  reason: string;
  /** 未链上结算 / local-dev → 永远 false (红线) */
  canMarkVerified: boolean;
  /** 已有支付/释放事实 → 任何拒绝路径都不许再付 */
  mustNotRepay: boolean;
  evidence: string[];
  fundsMoved: false;
}

export interface ReleaseInput {
  announcementId: string;
  status: AnnouncementStatus | 'unknown';
  delivery?: { delivered?: boolean; contentHash?: string | null; resultVerified?: boolean | null } | null;
  disputeOpen?: boolean;
  paymentMode: PaymentMode | string;
  chainSettled?: boolean;
  txHash?: string | null;
  alreadyReleased?: boolean;
}

/**
 * 释放裁决 (冻结顺序, 每条拒绝都给机器可读原因):
 *   已释放 → 未认领 → 争议中 → **未交付不得释放** → local-dev 永远不是链上结算 →
 *   **未链上结算 (chainSettled!==true 或缺 txHash) 不得标 verified** → 才 RELEASE_OK。
 */
export function decideAnnouncementRelease(input: ReleaseInput): ReleaseDecision {
  const ev = (s: string) => `证据: ${s}`;
  const id = String(input.announcementId || '');
  const chainSettled = input.chainSettled === true;
  const txHash = String(input.txHash || '');
  const evidence: string[] = [
    ev(`status=${input.status}`),
    ev(`delivered=${input.delivery?.delivered === true}`),
    ev(`contentHash=${input.delivery?.contentHash ? String(input.delivery.contentHash).slice(0, 16) : '(无)'}`),
    ev(`paymentMode=${input.paymentMode}`),
    ev(`chainSettled=${chainSettled}`),
    ev(`txHash=${txHash ? `${txHash.slice(0, 18)}…` : '(无)'}`),
  ];
  const mustNotRepay = input.alreadyReleased === true || chainSettled;
  const no = (code: ReleaseCode, reason: string): ReleaseDecision => ({ announcementId: id, action: 'refuse', code, reason, canMarkVerified: false, mustNotRepay, evidence, fundsMoved: false });

  if (input.alreadyReleased === true) return no('ALREADY_RELEASED', '这条已经释放过 (幂等: 不重复释放/不重复付款)');
  if (input.status !== 'claimed') return no('NOT_CLAIMED', `还没人认领 (status=${input.status}) → 没有可释放的对象`);
  if (input.disputeOpen === true) return no('DISPUTE_OPEN', '争议中: 不自动重付、不标 verified、不静默关闭 (先 resolveDispute 带证据)');
  if (input.delivery?.delivered !== true) return no('NOT_DELIVERED', '未交付不得释放 (没有交付事实 → 钱不动)');
  if (String(input.paymentMode) === 'local-dev') return no('LOCAL_DEV_NOT_CHAIN', 'local-dev 结算**永远不是**链上结算 → 不释放、不标 verified');
  if (!chainSettled || !txHash) return no('NOT_CHAIN_SETTLED', '未链上结算 (chainSettled!==true 或缺 txHash) → 不释放、不标 verified');
  return {
    announcementId: id, action: 'release', code: 'RELEASE_OK',
    reason: '已认领 + 已交付 + 链上结算事实齐 (txHash 在手) → 可释放; 验真可标 verified',
    canMarkVerified: true, mustNotRepay, evidence, fundsMoved: false,
  };
}
