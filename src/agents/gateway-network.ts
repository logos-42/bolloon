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
  let joined = 0;
  for (const svc of remote) {
    if (!svc?.agentId || !svc?.service?.name) continue;
    const exists = local.some((l) => l.agentId === svc.agentId && l.service?.name === svc.service?.name);
    if (!exists) {
      await registry.register(svc as AgentService).catch(() => {});
      joined++;
    }
  }

  // 记录成员身份 (持久化 → 重启后自动恢复)
  await saveNetworks([
    ...existing,
    {
      link: norm,
      linkKey: identityKey,
      kind: parsed.kind,
      name: parsed.networkName,
      joinedAt: new Date().toISOString(),
      serviceCount: remote.length,
      lastSyncAt: new Date().toISOString(),
    },
  ]);
  return { ok: true, joined, total: remote.length, linkKind: parsed.kind, networkName: parsed.networkName };
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

// ============ 分享链接 ============

/**
 * 生成本机可分享的网络链接: orbitdb://<registry storeAddress>?name=<网络名>.
 * 对方收到链接 → 自动 joinNetwork → 拉取本机注册的服务.
 * opts.registry 可注入 (测试用), 默认单例.
 */
export async function shareNetworkLink(opts?: { name?: string; registry?: AgentRegistry }): Promise<{ ok: boolean; link?: string; error?: string }> {
  try {
    let registry = opts?.registry;
    if (!registry) {
      await warmAgentRegistry();
      registry = getAgentRegistry();
    }
    if (!registry.ready || !registry.storeAddress) {
      return { ok: false, error: 'OrbitDB registry 未就绪 (离线模式). 备选: 把 registry 列表发布成 https://.../registry 端点分享' };
    }
    const name = encodeURIComponent(String(opts?.name || registry.storeName || 'bolloon-network'));
    return { ok: true, link: `orbitdb://${registry.storeAddress}?name=${name}` };
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
export async function maybeAutoJoinGateway(text: string, deps?: { registry?: AgentRegistry }): Promise<string | null> {
  const link = detectGatewayLink(text);
  if (!link) return null;
  try {
    const r = await joinNetwork(link, deps);
    if (r.ok && r.already) return null; // 已在网络, 静默
    if (r.ok) {
      const netName = r.networkName ? `「${r.networkName}」` : ''; // URLSearchParams 已 decode
      return `🆕 已自动加入 Agent 网络${netName} (${r.linkKind}): 拉取 ${r.total} 个服务, 新增 ${r.joined} 个。用 gateway_status 查看, gateway_call 调用网络里的服务。`;
    }
    return `⚠️ 检测到 Agent 网络链接 (${r.linkKind || 'unknown'}) 但加入失败: ${r.error}`;
  } catch (e: any) {
    return `⚠️ 自动加入 Agent 网络失败: ${String(e?.message || e).slice(0, 160)}`;
  }
}
