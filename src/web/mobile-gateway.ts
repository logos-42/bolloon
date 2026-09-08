// ─── 手机端 Gateway (browser-safe, 与桌面同一协议) ────────────────────────
//   手机 WebView 跑不了 OrbitDB/Helia → 入网走 browser-safe 路径:
//     ① https://.../registry → 直接 fetch JSON+meta (与桌面 fetchRemoteRegistry 同构)
//     ② orbitdb:// | ipns://  → 需桌面节点 → 若有 desktopBaseUrl 则转发 /api/gateway/join, 否则明确提示
//   成员 schema 与桌面一致 (AgentService: agentId=did / service{name,price} / capabilities)。
import { parseNetworkLink, detectGatewayLink } from '../agents/network-link.js';

/** 手机端成员声明 (桌面 AgentService 的 browser 子集) */
export interface MobileMember {
  agentId: string;
  name: string;
  service?: { name: string; description?: string; price?: { amount: string; currency: string; per: string } };
  capabilities?: string[];
  reputation?: { tasks: number; success: number; failed: number; disputed: number; score: number };
}

export interface MobileGatewayOpts {
  fetch?: typeof fetch;
  storage?: { get(): MobileMember[]; set(m: MobileMember[]): void };
  /** 桌面节点 API 基址 (orbitdb/ipns 链接转发用), 如 http://192.168.1.5:54188 */
  desktopBaseUrl?: string;
  /** ipfs 网关 (拉共享 context), 默认 https://ipfs.io */
  ipfsGateway?: string;
}

const MEMBERS_KEY = 'bolloon_mobile_net_members';
const DESKTOP_URL_KEY = 'bolloon_desktop_base_url';

/** 手机侧持久化的桌面节点 API 基址 (设置页填; localStorage) */
export function getDesktopBaseUrl(): string {
  try { return typeof localStorage !== 'undefined' ? (localStorage.getItem(DESKTOP_URL_KEY) || '') : ''; }
  catch { return ''; }
}
export function setDesktopBaseUrl(url: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(DESKTOP_URL_KEY, String(url || '')); } catch { /* 忽略 */ }
}

function defaultStorage(): { get(): MobileMember[]; set(m: MobileMember[]): void } {
  let mem: MobileMember[] = [];
  return {
    get: () => {
      try { const s = typeof localStorage !== 'undefined' ? localStorage.getItem(MEMBERS_KEY) : null; return s ? (JSON.parse(s) as MobileMember[]) : []; }
      catch { return []; }
    },
    set: (m) => {
      mem = m;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(MEMBERS_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
    },
  };
}

function afetch(opts: MobileGatewayOpts): typeof fetch {
  return opts.fetch || ((globalThis as any).fetch as typeof fetch);
}

/** 从 HTTP registry 端点拉 {services, meta} (browser-safe) */
async function fetchHttpRegistry(url: string, opts: MobileGatewayOpts): Promise<{ services: MobileMember[]; meta?: any } | null> {
  try {
    const f = afetch(opts);
    const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function' ? (AbortSignal as any).timeout(15000) : undefined;
    const r = await f(url, signal ? { signal } : undefined);
    if (!r.ok) return null;
    const d: any = await r.json();
    const services = Array.isArray(d) ? d : d?.services;
    if (!Array.isArray(services)) return null;
    return { services: services as MobileMember[], meta: d?.meta };
  } catch {
    return null;
  }
}

function mergeMembers(remote: MobileMember[], local: MobileMember[]): { merged: MobileMember[]; joined: number } {
  const out = local.slice();
  let joined = 0;
  for (const m of remote) {
    if (!m?.agentId) continue;
    const exists = out.some((l) => l.agentId === m.agentId && (l.service?.name || '') === (m.service?.name || ''));
    if (!exists) { out.push(m); joined++; }
  }
  return { merged: out, joined };
}

export interface MobileJoinResult {
  ok: boolean;
  joined?: number;
  total?: number;
  networkName?: string;
  meta?: any;
  error?: string;
  viaDesktop?: boolean;
}

/** 手机入网: https registry 直接拉; orbitdb/ipns 转发桌面 (或提示) */
export async function mobileJoinNetwork(link: string, opts: MobileGatewayOpts = {}): Promise<MobileJoinResult> {
  const parsed = parseNetworkLink(link);
  if (!parsed) return { ok: false, error: '无法解析链接' };
  if (parsed.kind === 'http') {
    const r = await fetchHttpRegistry(parsed.url || parsed.value, opts);
    if (!r) return { ok: false, error: '远端 registry 不可达' };
    const st = opts.storage || defaultStorage();
    const { merged, joined } = mergeMembers(r.services, st.get());
    st.set(merged);
    return { ok: true, joined, total: r.services.length, networkName: parsed.networkName, meta: r.meta };
  }
  // orbitdb/ipns → 桌面转发 (默认用设置页持久化的 desktopBaseUrl)
  const desktopBaseUrl = opts.desktopBaseUrl || getDesktopBaseUrl();
  if (desktopBaseUrl) {
    try {
      const f = afetch(opts);
      const r = await f(`${String(desktopBaseUrl).replace(/\/$/, '')}/api/gateway/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }),
      });
      const j: any = r.ok ? await r.json() : null;
      if (r.ok && j?.ok) return { ok: true, joined: j.joined ?? 0, total: j.total ?? 0, viaDesktop: true };
      return { ok: false, error: j?.error || '桌面加入失败', viaDesktop: true };
    } catch (e: any) {
      return { ok: false, error: `桌面转发失败: ${String(e?.message || e).slice(0, 120)}`, viaDesktop: true };
    }
  }
  return { ok: false, error: 'orbitdb/ipns 链接需桌面节点: 请用 https://.../registry 链接, 或配置 desktopBaseUrl' };
}

/** 手机注册本机声明 (写入本地成员表, 供网络画像展示) */
export function mobileRegister(self: MobileMember, opts: MobileGatewayOpts = {}): void {
  const st = opts.storage || defaultStorage();
  const cur = st.get();
  const i = cur.findIndex((m) => m.agentId === self.agentId && (m.service?.name || '') === (self.service?.name || ''));
  if (i >= 0) cur[i] = self; else cur.push(self);
  st.set(cur);
}

/** 手机网络状态 (本地成员表) */
export function mobileNetworkStatus(opts: MobileGatewayOpts = {}): MobileMember[] {
  return (opts.storage || defaultStorage()).get();
}

/** 拉共享 context (browser-safe: HTTP IPFS 网关) */
export async function mobilePullSharedContext(cid: string, opts: MobileGatewayOpts = {}): Promise<string | null> {
  try {
    const gw = String(opts.ipfsGateway || 'https://ipfs.io').replace(/\/$/, '');
    const f = afetch(opts);
    const r = await f(`${gw}/ipfs/${cid}`, { signal: (AbortSignal as any).timeout?.(15000) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** 自动加入入口: 文本检测到 gateway 链接 → join (幂等). 返回通知或 null */
export async function mobileAutoJoinGateway(text: string, opts: MobileGatewayOpts = {}): Promise<string | null> {
  const link = detectGatewayLink(text);
  if (!link) return null;
  const r = await mobileJoinNetwork(link, opts);
  if (r.ok) {
    return `🆕 已加入 Agent 网络${r.networkName ? `「${r.networkName}」` : ''}${r.viaDesktop ? '(经桌面)' : ''}: 拉取 ${r.total ?? 0} 个成员, 新增 ${r.joined ?? 0} 个。`;
  }
  return `⚠️ 检测到网络链接但加入失败: ${r.error}`;
}

/**
 * 手机端 gateway 工具统一分派 (供 Kotlin AgentRuntime 或 JS 路由调用):
 *   gateway_join(link) / gateway_status() / gateway_register(self) / gateway_context(cid)
 * 返回 {ok, output} 给 agent 作为工具结果文本.
 */
export async function mobileGatewayTool(name: string, args: any, opts: MobileGatewayOpts = {}): Promise<{ ok: boolean; output: string }> {
  const n = String(name || '').trim();
  if (n === 'gateway_join') {
    const link = String(args?.link || args?.url || args?.value || '');
    if (!link) return { ok: false, output: 'gateway_join 需要 link 参数 (orbitdb:// / ipns:// / https://.../registry)' };
    const r = await mobileJoinNetwork(link, opts);
    return r.ok
      ? { ok: true, output: `已加入 Agent 网络${r.networkName ? `「${r.networkName}」` : ''}: ${r.total ?? 0} 成员, 新增 ${r.joined ?? 0}` }
      : { ok: false, output: `加入失败: ${r.error}` };
  }
  if (n === 'gateway_status') {
    const m = mobileNetworkStatus(opts);
    return m.length
      ? { ok: true, output: m.map((x) => `${x.name} (${String(x.agentId).slice(0, 12)}…) ${x.service?.name || ''}`).join('\n') }
      : { ok: true, output: '（网络为空: 先 gateway_join 或设置 desktopBaseUrl）' };
  }
  if (n === 'gateway_register') {
    const self = args?.self || args;
    if (self?.agentId) { mobileRegister(self as MobileMember, opts); return { ok: true, output: '已注册本机声明' }; }
    return { ok: false, output: 'gateway_register 需要 self{agentId,name,service?}' };
  }
  if (n === 'gateway_context') {
    const cid = String(args?.cid || '');
    if (!cid) return { ok: false, output: 'gateway_context 需要 cid' };
    const t = await mobilePullSharedContext(cid, opts);
    return t ? { ok: true, output: t.slice(0, 400) } : { ok: false, output: '共享 context 拉取失败' };
  }
  return { ok: false, output: `未知 gateway 工具: ${n}` };
}
