/**
 * gateway-network.ts — Agent 网络加入 (2026-08-14 v2)
 *
 * joinNetwork(link): 通过链接自动加入共享 Agent 网络.
 * 链接形式 (三选一):
 *   - orbitdb://<storeAddress>   共享 registry store (主链路, OrbitDB 复制)
 *   - ipns://<name>              IPNS 标识 (registry 静态快照)
 *   - https://.../registry       HTTP 端点 (远程 registry JSON)
 *
 * v2 新增:
 *   - orbitdb:// 真实可开 (CIDDatabase.openStoreByAddress, replica 只读)
 *   - 成员身份持久化 ~/.bolloon/gateway-networks.json (重启后仍是家庭成员)
 *   - detectGatewayLink / maybeAutoJoinGateway — 消息里收到链接自动加入 (入口要小)
 *   - shareNetworkLink — 生成本机可分享的网络链接 (把 registry 发出去)
 */

import * as os from 'os';
import * as path from 'path';
import { getAgentRegistry, warmAgentRegistry, type AgentRegistry, type AgentService } from './agent-registry.js';

// ============ 链接解析 ============

export type NetworkLink =
  | { kind: 'ipns'; name: string; url?: string }
  | { kind: 'orbitdb'; address: string; url?: string }
  | { kind: 'http'; url: string };

export type ParsedLink = NetworkLink & {
  /** 网络名 (从 ?name= 或链接文本推断, 可选) */
  networkName?: string;
};

/** 解析链接字符串 → ParsedLink (剥离 ?name= query) */
export function parseNetworkLink(link: string): ParsedLink | null {
  const l = String(link || '').trim();
  if (!l) return null;
  const [base, query] = l.split('?');
  let networkName: string | undefined;
  try {
    networkName = query ? (new URLSearchParams(query).get('name') || undefined) : undefined;
  } catch { /* 忽略坏 query */ }
  if (base.startsWith('ipns://')) return { kind: 'ipns', name: base.slice('ipns://'.length), networkName };
  if (base.startsWith('orbitdb://')) {
    // orbitdb:///orbitdb/<addr> 或 orbitdb://orbitdb/<addr> → /orbitdb/<addr>
    let address = base.slice('orbitdb://'.length);
    if (!address.startsWith('/')) address = `/${address}`;
    return { kind: 'orbitdb', address, networkName };
  }
  if (base.startsWith('http://') || base.startsWith('https://')) return { kind: 'http', url: base, networkName };
  return null;
}

/** 从消息文本里检测 gateway 链接 (自动加入触发器用) */
export function detectGatewayLink(text: string): string | null {
  const t = String(text || '');
  // orbitdb:// 地址含 '/' 必须贪婪匹配到空白/引号; https 允许 /registry 后带 ?query
  const re = /(orbitdb:\/\/\/?orbitdb\/[^\s)'"<>，。；]+|ipns:\/\/[^\s)'"<>，。；]+|https?:\/\/[^\s)'"<>，。；]*\/registry(?:\?[^\s)'"<>，。；]*)?)/;
  const m = re.exec(t);
  return m ? m[1].trim() : null;
}

// ============ 远端拉取 ============

/** 从 HTTP 端点拉取远端 registry */
async function fetchRemoteRegistry(url: string): Promise<any[] | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const data: any = await r.json();
    // 兼容: {services:[...]} 或 [...]
    const services = Array.isArray(data) ? data : (data.services ?? null);
    return Array.isArray(services) ? services : null;
  } catch {
    return null;
  }
}

/** 从 IPNS 拉取 registry (需本地 Kubo + 8080 gateway) */
async function fetchIpnsRegistry(name: string): Promise<any[] | null> {
  try {
    const r = await fetch(`http://127.0.0.1:8080/ipns/${name}/registry.json`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const data: any = await r.json();
    return Array.isArray(data) ? data : (data.services ?? null);
  } catch {
    return null;
  }
}

/** 从 OrbitDB 打开共享 registry store (replica 只读) */
async function fetchOrbitdbRegistry(address: string): Promise<any[] | null> {
  try {
    const { getCIDDatabase } = await import('../orbitdb/cid-database.js');
    const db = getCIDDatabase();
    const store = await db.openStoreByAddress(address, 'keyvalue');
    if (!store) return null;
    // 先立即读 (同节点 store 已有数据); 没有再等复制 (owner 在线时 pubsub 复制通常 <1s)
    const first = await store.get('services').catch(() => null);
    if (Array.isArray(first)) return first as any[];
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; try { off(); } catch {} resolve(); } };
      const off = store.onChange(finish);
      setTimeout(finish, 4000);
    });
    // 单键 'services' (registry 的 OrbitDB 布局: 整个列表存单键)
    const v = await store.get('services').catch(() => null);
    if (Array.isArray(v)) return v as any[];
    // 兼容: 遍历 entries 找数组值
    const all = await store.all().catch(() => null);
    if (Array.isArray(all)) {
      for (const entry of all) {
        if (Array.isArray(entry.value)) return entry.value as any[];
        const val = entry.value as any;
        if (val?.services && Array.isArray(val.services)) return val.services;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============ 成员身份持久化 ============

export interface JoinedNetwork {
  link: string;           // 规范化链接 (restore 用)
  linkKey?: string;       // 幂等身份 key (kind + 地址, 忽略 ?name 差异)
  kind: 'ipns' | 'orbitdb' | 'http';
  name?: string;          // 网络名
  joinedAt: string;
  serviceCount: number;   // 上次同步时的服务数
  lastSyncAt?: string;
  // ① 网络启动包 (meta) — 加入时拉取的网络声明 (2026-09-08)
  networkId?: string;
  version?: string;
  capacityOfMembers?: number;
  sharedContextCid?: string;
}

const networksFile = (): string => path.join(os.homedir() || '/tmp', '.bolloon', 'gateway-networks.json');

async function loadNetworks(): Promise<JoinedNetwork[]> {
  try {
    const { readFile } = await import('fs/promises');
    const parsed = JSON.parse(await readFile(networksFile(), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveNetworks(list: JoinedNetwork[]): Promise<void> {
  try {
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(path.dirname(networksFile()), { recursive: true });
    await writeFile(networksFile(), JSON.stringify(list, null, 2), 'utf-8');
  } catch { /* 持久化失败静默 */ }
}

/** 列出已加入的网络 */
export async function listJoinedNetworks(): Promise<JoinedNetwork[]> {
  return loadNetworks();
}

// ============ 加入网络 ============

export interface JoinNetworkResult {
  ok: boolean;
  joined: number;
  total: number;
  already?: boolean;
  error?: string;
  linkKind?: string;
  networkName?: string;
  networkId?: string;
  sharedContextCid?: string;
}

/**
 * 通过链接加入共享网络: 拉取远端服务列表 → 合并到本地 registry (按 agentId+service 去重).
 * 幂等: 已加入的网络直接返回 already=true.
 * deps.registry 可注入 (测试用), 默认单例.
 */
export async function joinNetwork(link: string, deps?: { registry?: AgentRegistry }): Promise<JoinNetworkResult> {
  const parsed = parseNetworkLink(link);
  if (!parsed) {
    return { ok: false, joined: 0, total: 0, error: '无法解析链接 (支持 orbitdb:// / ipns:// / https://)' };
  }

  // 幂等: 已加入 (按解析后的网络身份 key 去重, 忽略 ?name 差异)
  const existing = await loadNetworks();
  const norm = String(link).trim();
  const identityKey =
    parsed.kind === 'orbitdb' ? `orbitdb:${parsed.address}`
    : parsed.kind === 'ipns' ? `ipns:${parsed.name}`
    : `http:${parsed.url}`;
  if (existing.some((n) => n.linkKey === identityKey || n.link === norm)) {
    return { ok: true, joined: 0, total: 0, already: true, linkKind: parsed.kind, networkName: parsed.networkName };
  }

  // 拉取远端服务
  let remote: any[] | null = null;
  if (parsed.kind === 'http') {
    remote = await fetchRemoteRegistry(parsed.url);
  } else if (parsed.kind === 'ipns') {
    remote = await fetchIpnsRegistry(parsed.name);
  } else if (parsed.kind === 'orbitdb') {
    remote = await fetchOrbitdbRegistry(parsed.address);
  }
  if (!remote || remote.length === 0) {
    return { ok: false, joined: 0, total: 0, error: '远端网络无服务或不可达 (store owner 需在线)', linkKind: parsed.kind };
  }

  // 合并到本地 registry (按 agentId + service.name 去重)
  const registry = deps?.registry ?? getAgentRegistry();
  const local = await registry.list();
  const remoteServices: AgentService[] = Array.isArray(remote) ? (remote as AgentService[]) : [];
  const { merged, joined } = mergeRemoteServices(remoteServices, local);
  for (const svc of merged) {
    if (!local.some((l) => l.agentId === svc.agentId && l.service?.name === svc.service?.name)) {
      await registry.register(svc).catch(() => {});
    }
  }

  // ① 网络启动包 (meta): 拉网络声明 (networkId/名称/版本/容量/共享context CID), 尽力而为
  const meta = await fetchNetworkMeta(parsed).catch(() => null);
  const bootstrap = buildNetworkBootstrap(meta);

  // 记录成员身份 (持久化 → 重启后自动恢复) + 网络启动包信息
  await saveNetworks([
    ...existing,
    {
      link: norm,
      linkKey: identityKey,
      kind: parsed.kind,
      name: bootstrap.name || parsed.networkName,
      joinedAt: new Date().toISOString(),
      serviceCount: remoteServices.length,
      lastSyncAt: new Date().toISOString(),
      networkId: bootstrap.networkId,
      version: bootstrap.version,
      capacityOfMembers: bootstrap.capacityOfMembers,
      sharedContextCid: bootstrap.sharedContextCid,
    },
  ]);
  return { ok: true, joined, total: remoteServices.length, linkKind: parsed.kind, networkName: bootstrap.name || parsed.networkName, networkId: bootstrap.networkId, sharedContextCid: bootstrap.sharedContextCid };
}

/** 启动恢复: 重拉所有已加入网络 (失败静默, 保留记录). 返回恢复统计. */
export async function restoreJoinedNetworks(): Promise<{ restored: number; failed: number; total: number }> {
  const nets = await loadNetworks();
  if (nets.length === 0) return { restored: 0, failed: 0, total: 0 };
  let restored = 0;
  let failed = 0;
  for (const n of nets) {
    const r = await joinNetwork(n.link).catch(() => null);
    if (r?.ok) restored++;
    else failed++;
    // 更新 lastSyncAt
    if (r?.ok) {
      const updated = (await loadNetworks()).map((m) =>
        m.link === n.link ? { ...m, lastSyncAt: new Date().toISOString(), serviceCount: r.total || m.serviceCount } : m
      );
      await saveNetworks(updated);
    }
  }
  return { restored, failed, total: nets.length };
}

// ============ 网络启动包 / 画像 / 自广播 (2026-09-08: 连接即全量引导) ============

/** ① 网络启动包: 网络级声明 (从 registry 文档 / OrbitDB store 的 meta 键 / network.json 读取) */
export interface NetworkBootstrap {
  networkId?: string;
  name?: string;
  version?: string;
  capacityOfMembers?: number;
  sharedContextCid?: string;
}

/** 把任意 meta 对象规整成 NetworkBootstrap (纯函数, 容错) */
export function buildNetworkBootstrap(meta?: any): NetworkBootstrap {
  const m = meta && typeof meta === 'object' ? meta : {};
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    networkId: str(m.networkId),
    name: str(m.name),
    version: str(m.version),
    capacityOfMembers: typeof m.capacityOfMembers === 'number' ? m.capacityOfMembers : undefined,
    sharedContextCid: str(m.sharedContextCid),
  };
}

/** 拉取网络 meta (尽力而为, 失败返回 null): orbitdb('meta' 键) / ipns(network.json) / http(doc.meta) */
async function fetchNetworkMeta(parsed: ParsedLink): Promise<any | null> {
  try {
    if (parsed.kind === 'http') {
      const r = await fetch(parsed.url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d: any = await r.json();
      return d?.meta ?? null;
    }
    if (parsed.kind === 'ipns') {
      const r = await fetch(`http://127.0.0.1:8080/ipns/${parsed.name}/network.json`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d: any = await r.json();
      return d?.meta ?? d;
    }
    if (parsed.kind === 'orbitdb') {
      const { getCIDDatabase } = await import('../orbitdb/cid-database.js');
      const db = getCIDDatabase();
      const store = await db.openStoreByAddress(parsed.address, 'keyvalue');
      if (!store) return null;
      const v = await store.get('meta').catch(() => null);
      return v ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 纯函数: 远端服务并入本地 (按 agentId + service.name 去重), 返回合并结果 + 新增数 */
export function mergeRemoteServices(remote: any[], local: AgentService[]): { merged: AgentService[]; joined: number } {
  const out: AgentService[] = local.slice();
  let joined = 0;
  for (const svc of remote) {
    if (!svc?.agentId || !svc?.service?.name) continue;
    const exists = out.some((l) => l.agentId === svc.agentId && l.service?.name === svc.service?.name);
    if (!exists) { out.push(svc as AgentService); joined++; }
  }
  return { merged: out, joined };
}

/** 网络画像: 启动包 + 当前成员列表 (谁在、会什么、报价多少) */
export interface NetworkProfile {
  bootstrap: NetworkBootstrap;
  members: AgentService[];
}

/** ② 拉取网络画像 (只读, 不落盘): 供 on-join 告知 agent "网络里有什么" */
export async function pullNetworkProfile(link: string): Promise<NetworkProfile | null> {
  const parsed = parseNetworkLink(link);
  if (!parsed) return null;
  let services: any[] | null = null;
  if (parsed.kind === 'http') services = await fetchRemoteRegistry(parsed.url);
  else if (parsed.kind === 'ipns') services = await fetchIpnsRegistry(parsed.name);
  else if (parsed.kind === 'orbitdb') services = await fetchOrbitdbRegistry(parsed.address);
  const meta = await fetchNetworkMeta(parsed).catch(() => null);
  if (!services || services.length === 0) return null;
  return { bootstrap: buildNetworkBootstrap(meta), members: services as AgentService[] };
}

/**
 * ③ 成员自描述广播: 把本机服务声明(list .agentId 匹配 self)写回共享网络 store ('services' 合并 self).
 *   ① ipns/http 无回写 → 只本地登记 (返回 note); ② orbitdb replica 只读时写穿失败 → 非致命 (返回 note).
 *   opts.members: 本机要广播的成员声明 (通常 = 自己注册的 AgentService 列表).
 */
export async function networkShareSelf(
  link: string,
  members: AgentService[],
  opts?: { registry?: AgentRegistry },
): Promise<{ ok: boolean; error?: string; note?: string }> {
  if (!members || members.length === 0) return { ok: true, note: '无本机成员声明可广播' };
  const parsed = parseNetworkLink(link);
  if (!parsed) return { ok: false, error: '链接无法解析' };
  if (parsed.kind !== 'orbitdb') {
    return { ok: true, note: `${parsed.kind} 无回写能力, 已本地登记 (发起方自托管 registry 应含本机)` };
  }
  try {
    const { getCIDDatabase } = await import('../orbitdb/cid-database.js');
    const db = getCIDDatabase();
    const store = await db.openStoreByAddress(parsed.address, 'keyvalue');
    if (!store) return { ok: false, error: '网络 store 不可达' };
    const cur = (await store.get('services').catch(() => null)) as AgentService[] | null;
    const arr = Array.isArray(cur) ? cur.slice() : [];
    for (const m of members) {
      const i = arr.findIndex((s) => s.agentId === m.agentId && s.service?.name === m.service?.name);
      const entry: AgentService = { ...m, updatedAt: new Date().toISOString(), registeredAt: m.registeredAt || new Date().toISOString() };
      if (i >= 0) arr[i] = entry; else arr.push(entry);
    }
    await store.put('services', arr);
    return { ok: true, note: `已广播 ${members.length} 条本机声明到网络` };
  } catch (e: any) {
    return { ok: false, error: `写穿失败(疑似只读 replica): ${String(e?.message || e).slice(0, 120)}`, note: '已在本地登记, 可在你的分享链接中带上本机' };
  }
}

/**
 * ① 拉取共享 context (由启动包 sharedContextCid 指向): 从本地 IPFS 网关读文本返回,
 *   调用方负责注入本地 context (了解"所有信息"的最后一段).
 */
export async function pullNetworkSharedContext(cid: string): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:8080/ipfs/${cid}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/**
 * ① 发布共享 context 到 OrbitDB (内容寻址), 返回 CID — 供 shareNetworkLink 的 sharedContextCid,
 *   手机/PC 入网后拉取即"近期上下文同步". opts.share=true 时把块放入 helia blockstore 供网络拉取.
 */
export async function publishNetworkSharedContext(text: string, opts?: { agentId?: string; share?: boolean }): Promise<{ ok: boolean; cid?: string; error?: string }> {
  try {
    const { getCIDDatabase } = await import('../orbitdb/cid-database.js');
    const db = getCIDDatabase();
    const rec = await db.save({ agentId: opts?.agentId || 'bolloon-network', type: 'context', content: text });
    let cid = rec.id;
    if (opts?.share !== false) { try { cid = await db.share(cid); } catch { /* 分享失败仍可用 CID 读 */ } }
    return { ok: true, cid };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 140) };
  }
}

// ============ 分享链接 ============

/**
 * 生成本机可分享的网络链接: orbitdb://<registry storeAddress>?name=<网络名>.
 * 对方收到链接 → 自动 joinNetwork → 拉取本机注册的服务.
 * opts.registry 可注入 (测试用), 默认单例.
 */
export async function shareNetworkLink(opts?: { name?: string; meta?: NetworkBootstrap; registry?: AgentRegistry }): Promise<{ ok: boolean; link?: string; error?: string; note?: string }> {
  try {
    let registry = opts?.registry;
    if (!registry) {
      await warmAgentRegistry();
      registry = getAgentRegistry();
    }
    if (!registry.ready || !registry.storeAddress) {
      return { ok: false, error: 'OrbitDB registry 未就绪 (离线模式). 备选: 把 registry 列表发布成 https://.../registry 端点分享' };
    }
    // ① 全量启动包: 把 networkId/名称/版本/容量/共享context CID 写进共享 store (尽力而为, 失败仍分享)
    const networkId = opts?.meta?.networkId || registry.storeName;
    const name = String(opts?.name || opts?.meta?.name || registry.storeName || 'bolloon-network');
    const metaObj: NetworkBootstrap = {
      networkId,
      name,
      version: opts?.meta?.version,
      capacityOfMembers: opts?.meta?.capacityOfMembers,
      sharedContextCid: opts?.meta?.sharedContextCid,
    };
    let note: string | undefined;
    if (registry.writeMeta) {
      const w = await registry.writeMeta(metaObj as Record<string, unknown>).catch(() => ({ ok: false, error: 'writeMeta 异常' }));
      if (!w.ok) note = `meta 写共享库失败 (${w.error || '未知'}) — 读方仍可拉到服务, 但拿不到启动包`;
    }
    const encodedName = encodeURIComponent(name);
    return { ok: true, link: `orbitdb://${registry.storeAddress}?name=${encodedName}`, note };
  } catch (e: any) {
    return { ok: false, error: `生成分享链接失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

// ============ 自动加入 (消息触发) ============

/**
 * 自动加入入口: 文本里检测到 gateway 链接 → 幂等 joinNetwork.
 * 返回给 agent 的通知字符串 (无链接 / 已在网络 → null, 静默).
 * 设计: 加入是自由的 (只拉服务列表, 不花钱), 支付仍走 payment-gate 安全链.
 * deps.registry 可注入 (测试用), 默认单例.
 */
export async function maybeAutoJoinGateway(text: string, deps?: { registry?: AgentRegistry; self?: AgentService[] }): Promise<string | null> {
  const link = detectGatewayLink(text);
  if (!link) return null;
  try {
    const r = await joinNetwork(link, deps);
    if (r.ok && r.already) return null; // 已在网络, 静默
    if (r.ok) {
      const netName = r.networkName ? `「${r.networkName}」` : ''; // URLSearchParams 已 decode
      // ② on-join 广播: 写入自己的服务声明 (orbitdb 可回写时), 非致命
      let selfNote = '';
      if (deps?.self && deps.self.length > 0) {
        const s = await networkShareSelf(link, deps.self, deps).catch(() => null);
        selfNote = s?.ok ? ' · 已广播本机声明' : (s?.note ? ` · ${s.note}` : ' · 本机声明广播失败');
      }
      const bootPart = r.networkId ? ` (net=${String(r.networkId).slice(0, 16)})` : '';
      const ctxPart = r.sharedContextCid ? ` · 共享ctx:${String(r.sharedContextCid).slice(0, 12)}` : '';
      return `🆕 已自动加入 Agent 网络${netName}${bootPart} (${r.linkKind}): 拉取 ${r.total} 个服务, 新增 ${r.joined} 个${ctxPart}${selfNote}。用 gateway_status 查看, gateway_call 调用网络里的服务。`;
    }
    return `⚠️ 检测到 Agent 网络链接 (${r.linkKind || 'unknown'}) 但加入失败: ${r.error}`;
  } catch (e: any) {
    return `⚠️ 自动加入 Agent 网络失败: ${String(e?.message || e).slice(0, 160)}`;
  }
}
