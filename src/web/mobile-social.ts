/**
 * mobile-social.ts — 手机端自动社交 (2026-09-11)
 *
 * 目标: 让手机节点自动完成 Agent Economic Loop 的 DISCOVERY 段
 *   (IDENTITY → **DISCOVERY** → NEGOTIATION → …), 即
 *   "自己注册服务 + 发现别人的服务 + 连接后自动打招呼 + 周期性心跳".
 *
 * 协议依据 (本文件所有命名均对齐下列规范, 无规范处已注明推导):
 *   - docs/wiki/agent-economic-protocol.md
 *       §二 7 协议: IDENTITY→DISCOVERY→NEGOTIATION→EXECUTION→PROOF→PAYMENT→REPUTATION
 *       §四 E1 Agent 服务 Registry 声明结构:
 *         { agent_id, wallet, service{name,description,price{amount,currency,per},endpoint},
 *           capabilities[], reputation{tasks,success,score} }
 *       §七 里程碑 M1: 桌面端注册/发现工具名 registry_register / registry_discover
 *         → 本层 P2P 消息类型沿用 'registry.register' / 'registry.discover' 命名; 回复加 '.reply' 后缀
 *           (与仓库既有 mobile-agent.ts 的 'agent.info' → 'agent.info.reply' 约定一致)
 *   - docs/agent-communication.md
 *       签名消息 { type, from, … } + 地址广播"每 5 分钟" → agent.hello 握手 + 5min 心跳节流
 *   - @diap/sdk (DIAP 身份层) 的 DID (did:blln:* / did:diap:* / did:key:*) 即 agent_id
 *     本模块不直接依赖 @diap/sdk: DID 由调用方 (mobile-agent.ensureIdentity) 传入.
 *
 * 设计约束:
 *   - 纯函数 + 依赖注入 (fetch / P2P send / 存储), 不 import 任何其它 web 模块
 *     → 浏览器可用 + vitest 可单测 (注入 mem store / fake fetch / spy send).
 *   - 网络/传输失败一律"返回 { ok:false, error }", 绝不抛出.
 *   - 不修改任何既有文件; 接线由 mobile-core.ts / mobile.js 侧完成 (见文件尾 §接线).
 */

// ============================================================================
// 协议常量
// ============================================================================

/** P2P 消息类型 (依据 docs/wiki/agent-economic-protocol.md §四 E1 + §七 M1 推导, 见文件头). */
export const SOCIAL_MESSAGE_TYPES = {
  /** 注册: 我方 → 电脑端 registry (携带服务声明) */
  REGISTER: 'registry.register',
  /** 注册回执: 电脑端 → 我方 */
  REGISTER_REPLY: 'registry.register.reply',
  /** 发现: 请求对端可用服务 */
  DISCOVER: 'registry.discover',
  /** 发现回执: 对端 → 我方 (携带服务列表) */
  DISCOVER_REPLY: 'registry.discover.reply',
  /** 握手: 连上 peer 后的自动问候 (绑定 docs/agent-communication.md 的签名消息) */
  HELLO: 'agent.hello',
} as const;

/** 心跳间隔: docs/agent-communication.md 「地址广播…每 5 分钟」 */
export const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;

/** 默认本地存储 key (接线的 localStorage store 用) */
export const SOCIAL_STORE_KEY = 'bolloon_mobile_social';

// ============================================================================
// 类型: E1 服务声明 (严格对齐 docs/wiki/agent-economic-protocol.md §四 E1)
// ============================================================================

export interface ServicePrice {
  amount: string;
  currency: string;
  per: string;
}

export interface ServiceDeclaration {
  /** did:diap:xxx / did:blln:xxx / did:key:xxx (DIAP 身份) */
  agent_id: string;
  /** 智能体显示名 (E1 示例外补充, 供 UI 展示; 桌面 AgentService.name 同义) */
  name?: string;
  /** 收款钱包地址 */
  wallet: string;
  service: {
    name: string;
    description: string;
    price: ServicePrice;
    endpoint: string;
  };
  capabilities: string[];
  reputation: {
    tasks: number;
    success: number;
    score: number;
  };
  /** ISO 时间戳 */
  updatedAt: string;
}

/** 桌面端 registry (src/agents/agent-registry.ts AgentService, 里程碑 M1) 兼容结构 */
export interface RegistryServiceEntry {
  agentId: string;
  name: string;
  wallet: string;
  service: { name: string; description: string; price: ServicePrice };
  capabilities: string[];
  endpoint: string;
  reputation: { tasks: number; success: number; failed: number; disputed: number; score: number };
  registeredAt: string;
  updatedAt: string;
}

// ============================================================================
// 类型: 共享状态 (幂等 / 心跳节流 / 发现缓存)
// ============================================================================

export interface SocialState {
  /** 已欢迎过的 peer: peerId → 首次欢迎时间戳 (同一 peer 只欢迎一次) */
  welcomedPeers: Record<string, number>;
  /** 上次心跳时间戳 (节流用) */
  lastHeartbeatTs: number;
  /** 已成功注册目标: `${agent_id}|${target}` → 时间戳 (announce 幂等) */
  announced: Record<string, number>;
  /** 最近一次发现结果缓存 (去重后) */
  discovered: any[];
}

export interface SocialStateStore {
  get(): SocialState;
  set(s: SocialState): void;
}

export function emptySocialState(): SocialState {
  return { welcomedPeers: {}, lastHeartbeatTs: 0, announced: {}, discovered: [] };
}

/** 内存 store (测试 + 无持久化环境默认) */
export function createMemoryStore(initial: Partial<SocialState> = {}): SocialStateStore {
  let state: SocialState = { ...emptySocialState(), ...initial };
  return {
    get: () => state,
    set: (s: SocialState) => { state = s; },
  };
}

/** localStorage store (浏览器/WebView 持久化; 无 localStorage 时自动退化为内存) */
export function createLocalStorageStore(key = SOCIAL_STORE_KEY, storage?: Storage): SocialStateStore {
  const ls = storage ?? safeLocalStorage();
  if (!ls) return createMemoryStore();
  const read = (): SocialState => {
    try {
      const raw = ls.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return { ...emptySocialState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return emptySocialState();
    }
  };
  return {
    get: read,
    set: (s: SocialState) => { try { ls.setItem(key, JSON.stringify(s)); } catch { /* 存储满/不可用 → 忽略 */ } },
  };
}

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** 模块级默认 store (未注入 store 时使用; 生产接线建议注入 createLocalStorageStore()) */
let _defaultStore: SocialStateStore = createMemoryStore();
export function getDefaultSocialStore(): SocialStateStore { return _defaultStore; }
/** 测试用: 重置默认 store */
export function resetDefaultSocialStore(): void { _defaultStore = createMemoryStore(); }

// ============================================================================
// 类型: 依赖注入
// ============================================================================

/** P2P 发送函数 (与 mobile-agent.setAgentTransport / mobile-p2p.sendMobileP2PMessage 同签名) */
export type SocialSendFn = (type: string, payload: string, peerId?: string) => Promise<boolean>;

export interface SocialDeps {
  /** 本机 DID (mobile-agent.ensureIdentity().did) */
  ownDid: string;
  ownName?: string;
  /** 收款钱包地址 */
  wallet?: string;
  capabilities?: string[];
  serviceName?: string;
  description?: string;
  price?: Partial<ServicePrice>;
  endpoint?: string;
  /** 已构建好的声明 (优先于上述字段) */
  declaration?: ServiceDeclaration;
  /** P2P 传输 (未注入则跳过 P2P 通道) */
  send?: SocialSendFn;
  /** P2P 目标 peerId (默认 '*' 广播) */
  peerId?: string;
  /** 电脑端 HTTP 地址 (mobile-sync.getDesktopUrl()) */
  desktopUrl?: string;
  fetchImpl?: typeof fetch;
  store?: SocialStateStore;
  now?: () => number;
}

function nowOf(deps: { now?: () => number }): number {
  return deps.now ? deps.now() : Date.now();
}

function storeOf(deps: { store?: SocialStateStore }): SocialStateStore {
  return deps.store ?? _defaultStore;
}

// ============================================================================
// buildServiceDeclaration — 生成 E1 服务声明
// ============================================================================

export interface BuildServiceOptions {
  did: string;
  name?: string;
  wallet?: string;
  serviceName?: string;
  description?: string;
  price?: Partial<ServicePrice>;
  endpoint?: string;
  capabilities?: string[];
  reputation?: Partial<ServiceDeclaration['reputation']>;
  now?: () => number;
}

/**
 * 生成 Agent 服务声明 (docs/wiki/agent-economic-protocol.md §四 E1).
 * 字段: agent_id / wallet / service{name,description,price{amount,currency,per},endpoint}
 *       / capabilities / reputation{tasks,success,score}
 */
export function buildServiceDeclaration(opts: BuildServiceOptions): ServiceDeclaration {
  const did = String(opts.did || '').trim();
  if (!did) throw new Error('buildServiceDeclaration: did 必填 (agent_id)');
  const serviceName = String(opts.serviceName || 'local-agent').trim() || 'local-agent';
  const caps = Array.isArray(opts.capabilities) && opts.capabilities.length
    ? opts.capabilities.map((c) => String(c))
    : ['chat', 'local-agent'];
  const rep = opts.reputation || {};
  return {
    agent_id: did,
    name: String(opts.name || '').trim() || undefined,
    wallet: String(opts.wallet || '').trim(),
    service: {
      name: serviceName,
      description: String(opts.description || '手机端本地 Agent 执行 (离线可用)'),
      price: {
        amount: String(opts.price?.amount ?? '0'),
        currency: String(opts.price?.currency ?? 'USDC'),
        per: String(opts.price?.per ?? 'query'),
      },
      endpoint: String(opts.endpoint || `agent://${serviceName}/query`),
    },
    capabilities: caps,
    reputation: {
      tasks: Number(rep.tasks ?? 0),
      success: Number(rep.success ?? 0),
      score: Number(rep.score ?? 0),
    },
    updatedAt: new Date(nowOf(opts)).toISOString(),
  };
}

/** 声明 → 桌面端 registry 条目 (src/agents/agent-registry.ts AgentService, 里程碑 M1) */
export function toRegistryEntry(decl: ServiceDeclaration): RegistryServiceEntry {
  const ts = decl.updatedAt || new Date().toISOString();
  const rep = decl.reputation || { tasks: 0, success: 0, score: 0 };
  return {
    agentId: decl.agent_id,
    name: decl.name || decl.agent_id,
    wallet: decl.wallet || '',
    service: {
      name: decl.service?.name || '',
      description: decl.service?.description || '',
      price: {
        amount: String(decl.service?.price?.amount ?? '0'),
        currency: String(decl.service?.price?.currency ?? 'USDC'),
        per: String(decl.service?.price?.per ?? 'query'),
      },
    },
    capabilities: Array.isArray(decl.capabilities) ? [...decl.capabilities] : [],
    endpoint: decl.service?.endpoint || '',
    reputation: {
      tasks: Number(rep.tasks || 0),
      success: Number(rep.success || 0),
      failed: 0,
      disputed: 0,
      score: Number(rep.score || 0),
    },
    registeredAt: ts,
    updatedAt: ts,
  };
}

/** deps → 声明 (已有 declaration 则直接用) */
function declarationFor(deps: SocialDeps): ServiceDeclaration {
  if (deps.declaration) return deps.declaration;
  return buildServiceDeclaration({
    did: deps.ownDid,
    name: deps.ownName,
    wallet: deps.wallet,
    serviceName: deps.serviceName,
    description: deps.description,
    price: deps.price,
    endpoint: deps.endpoint,
    capabilities: deps.capabilities,
    now: deps.now,
  });
}

// ============================================================================
// 合并 / 去重 (发现结果)
// ============================================================================

/** 服务的唯一键: 优先 agent_id/agentId, 兼容仅有 service.name 的情形 */
export function serviceKey(s: any): string {
  if (!s || typeof s !== 'object') return '';
  return String(s.agent_id || s.agentId || s.service?.name || s.name || '').trim();
}

/**
 * 合并两组服务列表并去重 (键 = serviceKey, 后出现者覆盖前者 = 更新优先).
 * "发现结果合并去重" 的纯逻辑, 供 discoverAgents / 入站 registry.*.reply 复用.
 */
export function mergeServiceLists(base: any[], incoming: any[]): any[] {
  const map = new Map<string, any>();
  const order: string[] = [];
  for (const s of [...(base || []), ...(incoming || [])]) {
    if (!s || typeof s !== 'object') continue;
    const k = serviceKey(s);
    if (!k) continue;
    if (!map.has(k)) order.push(k);
    map.set(k, s);
  }
  return order.map((k) => map.get(k)!);
}

// ============================================================================
// announceSelf — 注册自己到电脑端 registry (P2P + HTTP 双通道)
// ============================================================================

export interface AnnounceResult {
  ok: boolean;
  declaration: ServiceDeclaration;
  via: { p2p: boolean; http: boolean };
  skipped?: boolean;
  reason?: string;
  error?: string;
}

function normalizeBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 向电脑端 registry 注册自己 (Agent Economic Loop 的 DISCOVERY 写侧).
 *   通道 1: P2P 'registry.register' (send 注入时)
 *   通道 2: HTTP POST `${desktopUrl}/api/registry/register` (桌面端 server.ts 已有该端点)
 * 同一目标重复调用幂等 (store.announced); 失败或传 force=true 时重试.
 * 网络失败 → 返回 { ok:false, error }, 不抛出.
 */
export async function announceSelf(deps: SocialDeps & { force?: boolean }): Promise<AnnounceResult> {
  let decl: ServiceDeclaration;
  try {
    decl = declarationFor(deps);
  } catch (e: any) {
    return { ok: false, declaration: buildSafeDecl(deps), via: { p2p: false, http: false }, error: String(e?.message || e) };
  }
  const target = String(deps.peerId || normalizeBase(deps.desktopUrl || '') || '');
  const annKey = `${decl.agent_id}|${target}`;
  const store = storeOf(deps);
  const st = store.get();
  const canP2P = typeof deps.send === 'function';
  const canHttp = typeof deps.fetchImpl === 'function' && !!normalizeBase(deps.desktopUrl || '');
  if (!canP2P && !canHttp) {
    return { ok: false, declaration: decl, via: { p2p: false, http: false }, error: '无可用的注册通道 (需注入 send 或 desktopUrl+fetchImpl)' };
  }
  if (!deps.force && st.announced?.[annKey]) {
    return { ok: true, declaration: decl, via: { p2p: false, http: false }, skipped: true, reason: 'already-announced' };
  }

  const via = { p2p: false, http: false };
  const errors: string[] = [];

  // 通道 1: P2P (发送 E1 声明, 由对端 handler 落库)
  if (canP2P) {
    try {
      const payload = JSON.stringify({ declaration: decl, fromPublicKey: deps.ownDid, ts: nowOf(deps) });
      via.p2p = !!(await deps.send!(SOCIAL_MESSAGE_TYPES.REGISTER, payload, deps.peerId || '*'));
      if (!via.p2p) errors.push('P2P 发送返回 false');
    } catch (e: any) {
      errors.push('P2P: ' + String(e?.message || e).slice(0, 80));
    }
  }

  // 通道 2: HTTP (转换到桌面端 AgentService 结构)
  if (canHttp) {
    const base = normalizeBase(deps.desktopUrl || '');
    try {
      const r = await deps.fetchImpl!(`${base}/api/registry/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toRegistryEntry(decl)),
      });
      via.http = !!r.ok;
      if (!r.ok) errors.push(`电脑端返回 ${r.status}`);
    } catch (e: any) {
      errors.push('HTTP: ' + String(e?.message || e).slice(0, 80));
    }
  }

  const ok = via.p2p || via.http;
  if (ok) {
    store.set({ ...store.get(), announced: { ...(store.get().announced || {}), [annKey]: nowOf(deps) } });
    return { ok: true, declaration: decl, via };
  }
  return { ok: false, declaration: decl, via, error: errors.join('; ') || '注册失败' };
}

function buildSafeDecl(deps: SocialDeps): ServiceDeclaration {
  return {
    agent_id: String(deps.ownDid || ''),
    wallet: String(deps.wallet || ''),
    service: { name: 'local-agent', description: '', price: { amount: '0', currency: 'USDC', per: 'query' }, endpoint: '' },
    capabilities: [],
    reputation: { tasks: 0, success: 0, score: 0 },
    updatedAt: new Date(0).toISOString(),
  };
}

// ============================================================================
// discoverAgents — 发现其它智能体 + 我方可用服务 (合并去重)
// ============================================================================

export interface DiscoverResult {
  ok: boolean;
  services: any[];
  added: number;
  total: number;
  sources: string[];
  error?: string;
}

/**
 * 发现智能体 (DISCOVERY 读侧):
 *   源 1: HTTP GET `${desktopUrl}/api/registry[?q=]` (桌面端已有)
 *   源 2: 本地缓存 (store.discovered, 含 P2P registry.discover.reply 累积)
 *   源 3: 我方声明 (deps.declaration, 便于 UI 展示"我提供的服务")
 *   另: 若注入 send && peerId && p2pDiscover !== false → 发 'registry.discover' (异步, 回执经 handleSocialMessage 累积)
 * 结果按 serviceKey 合并去重后写回 store.
 * 网络失败 → 返回 { ok:false, error }, 不抛出.
 */
export async function discoverAgents(
  deps: SocialDeps & { query?: string; known?: any[]; p2pDiscover?: boolean },
): Promise<DiscoverResult> {
  const store = storeOf(deps);
  const before = store.get().discovered || [];
  const sources: string[] = [];
  const errors: string[] = [];
  const incoming: any[] = [];

  // 源 1: HTTP registry
  const base = normalizeBase(deps.desktopUrl || '');
  if (typeof deps.fetchImpl === 'function' && base) {
    try {
      const q = String(deps.query || '').trim();
      const url = `${base}/api/registry${q ? `?q=${encodeURIComponent(q)}` : ''}`;
      const r = await deps.fetchImpl(url, { method: 'GET' });
      if (r.ok) {
        const j: any = await r.json();
        const list = Array.isArray(j?.services) ? j.services : [];
        incoming.push(...list);
        sources.push('http');
      } else {
        errors.push(`电脑端返回 ${r.status}`);
      }
    } catch (e: any) {
      errors.push('HTTP: ' + String(e?.message || e).slice(0, 80));
    }
  }

  // 源 2: 调用方显式传入的已知列表 (例如 P2P 回执 / 外部缓存)
  if (Array.isArray(deps.known) && deps.known.length) {
    incoming.push(...deps.known);
    sources.push('known');
  }

  // 源 3: 我方声明 (deps.declaration; 只读展示, 不算 added)
  let own: any = null;
  if (deps.declaration) {
    own = deps.declaration;
  } else if (deps.ownDid) {
    try { own = declarationFor(deps); } catch { own = null; }
  }

  const merged = mergeServiceLists(mergeServiceLists(before, incoming), own ? [own] : []);
  store.set({ ...store.get(), discovered: merged });

  // 异步 P2P 发现 (回执稍后到达 → handleSocialMessage 累积)
  if (typeof deps.send === 'function' && deps.peerId && deps.p2pDiscover !== false) {
    try {
      const payload = JSON.stringify({ query: deps.query || '', fromPublicKey: deps.ownDid, ts: nowOf(deps) });
      const ok = await deps.send(SOCIAL_MESSAGE_TYPES.DISCOVER, payload, deps.peerId);
      if (ok) sources.push('p2p');
      else errors.push('P2P 发送返回 false');
    } catch (e: any) {
      errors.push('P2P: ' + String(e?.message || e).slice(0, 80));
    }
  }

  const ok = sources.length > 0 || merged.length > 0;
  return {
    ok,
    services: merged,
    added: Math.max(0, merged.length - before.length),
    total: merged.length,
    sources,
    error: ok ? undefined : (errors.join('; ') || '所有发现通道均失败'),
  };
}

// ============================================================================
// 心跳 (节流 + 状态存取)
// ============================================================================

/** 是否到了该心跳的时间 (纯函数). lastTs<=0 → 立即; 间隔<=0 → 永不. */
export function shouldHeartbeat(lastTs: number, nowMs: number, intervalMs: number): boolean {
  const last = Number(lastTs) || 0;
  const now = Number(nowMs) || 0;
  const iv = Number(intervalMs) || 0;
  if (iv <= 0) return false;
  if (last <= 0) return true;
  return now - last >= iv;
}

/** 读心跳状态 (默认 store 或注入 store) */
export function getHeartbeatState(store?: SocialStateStore): { lastTs: number } {
  return { lastTs: storeOf({ store }).get().lastHeartbeatTs || 0 };
}

/** 写心跳状态 — 记录上次发送时间戳 */
export function setHeartbeatState(ts: number, store?: SocialStateStore): void {
  const s = storeOf({ store });
  s.set({ ...s.get(), lastHeartbeatTs: Number(ts) || 0 });
}

export interface HeartbeatResult {
  sent: boolean;
  reason: 'interval-elapsed' | 'throttled' | 'no-channel';
  ts: number;
  via?: { p2p: boolean; http: boolean };
  error?: string;
}

/**
 * 周期性心跳: 到点就重发 registry.register (维持 registry 里的在线声明).
 *   未到间隔 → { sent:false, reason:'throttled' }, 不调用传输.
 *   到点 → 发送并把 lastTs 更新为 now (无论成功与否都不重复轰炸).
 * 网络失败 → 仍返回结果对象 (含 error), 不抛出.
 */
export async function heartbeat(
  deps: SocialDeps & { intervalMs?: number; force?: boolean },
): Promise<HeartbeatResult> {
  const interval = deps.intervalMs ?? DEFAULT_HEARTBEAT_MS;
  const now = nowOf(deps);
  const store = storeOf(deps);
  const last = store.get().lastHeartbeatTs || 0;
  if (!deps.force && !shouldHeartbeat(last, now, interval)) {
    return { sent: false, reason: 'throttled', ts: last };
  }
  const canP2P = typeof deps.send === 'function';
  const canHttp = typeof deps.fetchImpl === 'function' && !!normalizeBase(deps.desktopUrl || '');
  if (!canP2P && !canHttp) {
    return { sent: false, reason: 'no-channel', ts: last, error: '无可用的心跳通道 (需注入 send 或 desktopUrl+fetchImpl)' };
  }

  let decl: ServiceDeclaration;
  try { decl = declarationFor(deps); } catch (e: any) {
    return { sent: false, reason: 'no-channel', ts: last, error: String(e?.message || e) };
  }
  const via = { p2p: false, http: false };
  const errors: string[] = [];

  if (canP2P) {
    try {
      const payload = JSON.stringify({ declaration: decl, heartbeat: true, fromPublicKey: deps.ownDid, ts: now });
      via.p2p = !!(await deps.send!(SOCIAL_MESSAGE_TYPES.REGISTER, payload, deps.peerId || '*'));
    } catch (e: any) { errors.push('P2P: ' + String(e?.message || e).slice(0, 80)); }
  }
  if (canHttp) {
    const base = normalizeBase(deps.desktopUrl || '');
    try {
      const r = await deps.fetchImpl!(`${base}/api/registry/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toRegistryEntry(decl)),
      });
      via.http = !!r.ok;
      if (!r.ok) errors.push(`电脑端返回 ${r.status}`);
    } catch (e: any) { errors.push('HTTP: ' + String(e?.message || e).slice(0, 80)); }
  }
  // 记录本次心跳 (节流), 即使发送失败也不立刻重试
  setHeartbeatState(now, store);
  return { sent: true, reason: 'interval-elapsed', ts: now, via, error: errors.length ? errors.join('; ') : undefined };
}

// ============================================================================
// onPeerConnected — 连上 peer 的自动欢迎 (幂等, 同一 peer 只欢迎一次)
// ============================================================================

export interface WelcomeResult {
  welcomed: boolean;
  duplicate?: boolean;
  type?: string;
  sent?: boolean;
  error?: string;
}

/**
 * 新 peer 连上时的钩子 (接线: core.network.start 成功后对每个 peerId 调用).
 *   幂等: store.welcomedPeers 记录已欢迎 peer → 同一 peer 第二次直接返回 duplicate.
 *   发送失败 → 回滚记录 (允许后续重试), 返回 { welcomed:false, error }, 不抛出.
 */
export async function onPeerConnected(peerId: string, deps: SocialDeps): Promise<WelcomeResult> {
  const key = String(peerId || '').trim();
  if (!key) return { welcomed: false, error: 'peerId 为空' };
  const store = storeOf(deps);
  const welcomed = { ...(store.get().welcomedPeers || {}) };
  if (welcomed[key]) return { welcomed: false, duplicate: true, type: SOCIAL_MESSAGE_TYPES.HELLO };

  // 先落记录 (避免并发重复欢迎), 失败再回滚
  welcomed[key] = nowOf(deps);
  store.set({ ...store.get(), welcomedPeers: welcomed });

  if (typeof deps.send !== 'function') {
    return { welcomed: true, sent: false, type: SOCIAL_MESSAGE_TYPES.HELLO };
  }
  try {
    const payload = JSON.stringify({
      type: SOCIAL_MESSAGE_TYPES.HELLO,
      did: deps.ownDid,
      name: deps.ownName || '',
      capabilities: Array.isArray(deps.capabilities) ? deps.capabilities : [],
      fromPublicKey: deps.ownDid,
      ts: nowOf(deps),
    });
    const sent = !!(await deps.send(SOCIAL_MESSAGE_TYPES.HELLO, payload, key));
    if (!sent) {
      const rollback = { ...(store.get().welcomedPeers || {}) };
      delete rollback[key];
      store.set({ ...store.get(), welcomedPeers: rollback });
      return { welcomed: false, error: 'P2P 发送返回 false' };
    }
    return { welcomed: true, sent: true, type: SOCIAL_MESSAGE_TYPES.HELLO };
  } catch (e: any) {
    const rollback = { ...(store.get().welcomedPeers || {}) };
    delete rollback[key];
    store.set({ ...store.get(), welcomedPeers: rollback });
    return { welcomed: false, error: String(e?.message || e).slice(0, 120) };
  }
}

// ============================================================================
// handleSocialMessage — 入站 registry.* / agent.hello 路由 (接线: mobile-core P2P 路由)
// ============================================================================

export interface SocialHandleResult {
  handled: boolean;
  replied?: string;
}

function parseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 处理入站社交消息 (mobile-core 的 P2P 路由分发).
 *   registry.register      → 合并对方声明 + 回 registry.register.reply
 *   registry.register.reply→ 记录注册回执 (合并声明)
 *   registry.discover      → 回 registry.discover.reply (我方 + 缓存服务, 支持 query 过滤)
 *   registry.discover.reply→ 合并服务列表到 store.discovered (发现结果去重)
 *   agent.hello            → 标记该 peer 已知 (避免回环问候)
 * 全程不抛出 (返回 { handled:false }).
 */
export async function handleSocialMessage(
  type: string,
  payload: string,
  fromPeer: string,
  deps: SocialDeps,
): Promise<SocialHandleResult> {
  const store = storeOf(deps);
  const msg = parseJson(payload) || {};
  try {
    switch (type) {
      case SOCIAL_MESSAGE_TYPES.REGISTER: {
        if (msg.declaration) {
          store.set({ ...store.get(), discovered: mergeServiceLists(store.get().discovered || [], [msg.declaration]) });
        }
        let replied: string | undefined;
        if (typeof deps.send === 'function') {
          const ok = await deps.send(
            SOCIAL_MESSAGE_TYPES.REGISTER_REPLY,
            JSON.stringify({ ok: true, registered: msg?.declaration?.agent_id || '', fromPublicKey: deps.ownDid, ts: nowOf(deps) }),
            fromPeer,
          );
          if (ok) replied = SOCIAL_MESSAGE_TYPES.REGISTER_REPLY;
        }
        return { handled: true, replied };
      }
      case SOCIAL_MESSAGE_TYPES.REGISTER_REPLY: {
        // 桌面端确认注册 → 记录 (announced 已在 announceSelf 落, 这里仅合并声明)
        if (msg.declaration) {
          store.set({ ...store.get(), discovered: mergeServiceLists(store.get().discovered || [], [msg.declaration]) });
        }
        return { handled: true };
      }
      case SOCIAL_MESSAGE_TYPES.DISCOVER: {
        const q = String(msg.query || '').trim().toLowerCase();
        const own: any[] = [];
        if (deps.declaration) own.push(deps.declaration);
        else if (deps.ownDid) { try { own.push(declarationFor(deps)); } catch { /* 无声明 */ } }
        let services = mergeServiceLists(store.get().discovered || [], own);
        if (q) {
          services = services.filter((s) => {
            const hay = [s?.service?.name, s?.service?.description, s?.name, ...(Array.isArray(s?.capabilities) ? s.capabilities : [])]
              .map((x) => String(x || '').toLowerCase()).join(' ');
            return hay.includes(q);
          });
        }
        let replied: string | undefined;
        if (typeof deps.send === 'function') {
          const ok = await deps.send(
            SOCIAL_MESSAGE_TYPES.DISCOVER_REPLY,
            JSON.stringify({ services, fromPublicKey: deps.ownDid, ts: nowOf(deps) }),
            fromPeer,
          );
          if (ok) replied = SOCIAL_MESSAGE_TYPES.DISCOVER_REPLY;
        }
        return { handled: true, replied };
      }
      case SOCIAL_MESSAGE_TYPES.DISCOVER_REPLY: {
        const list = Array.isArray(msg.services) ? msg.services : [];
        store.set({ ...store.get(), discovered: mergeServiceLists(store.get().discovered || [], list) });
        return { handled: true };
      }
      case SOCIAL_MESSAGE_TYPES.HELLO: {
        const key = String(fromPeer || '').trim();
        if (key) {
          const welcomed = { ...(store.get().welcomedPeers || {}) };
          if (!welcomed[key]) welcomed[key] = nowOf(deps);
          store.set({ ...store.get(), welcomedPeers: welcomed });
        }
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch {
    return { handled: false };
  }
}

// ============================================================================
// §接线 (由 mobile-core.ts / mobile.js 完成, 本模块不改任何既有文件)
// ============================================================================
// 1) 身份/传输就绪后注册自己:
//      const social = await import('./mobile-social.js');
//      const store = social.createLocalStorageStore();
//      await social.announceSelf({
//        ownDid: id.did, ownName: id.name,
//        send,                                  // mobile-core 的 sendViaP2P
//        peerId: desktopPeer || '*',
//        desktopUrl: sync.getDesktopUrl(),      // mobile-sync
//        fetchImpl: fetch,
//        store,
//      });
// 2) 连上 peer 后欢迎 (幂等): social.onPeerConnected(peerId, { ownDid, send, store })
// 3) 心跳: setInterval(() => social.heartbeat({ ownDid, send, peerId, desktopUrl, fetchImpl: fetch, store }), 60000)
// 4) 入站路由: routeIncomingMessage 里把 type 命中 registry.* / agent.hello 时
//      委派 social.handleSocialMessage(type, payload, fromPeer, { ownDid, send, store })
// 5) 网络页渲染: const r = await social.discoverAgents({ ownDid, desktopUrl, fetchImpl: fetch, store, peerId, send });
//      用 r.services (含我方声明) 渲染服务/智能体列表

export default {
  SOCIAL_MESSAGE_TYPES,
  DEFAULT_HEARTBEAT_MS,
  buildServiceDeclaration,
  toRegistryEntry,
  mergeServiceLists,
  serviceKey,
  announceSelf,
  discoverAgents,
  shouldHeartbeat,
  getHeartbeatState,
  setHeartbeatState,
  heartbeat,
  onPeerConnected,
  handleSocialMessage,
  createMemoryStore,
  createLocalStorageStore,
  getDefaultSocialStore,
  emptySocialState,
};
