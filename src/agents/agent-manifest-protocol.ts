/**
 * agent-manifest-protocol - 节点握手后立刻互换"我有哪些 agent + capabilities"
 *
 * 核心目的：实现 "建联一次，访问对方所有智能体"。
 *   - 节点连上 (Hyperswarm 主题 / iroh) 后立刻发 'manifest_request'
 *   - 对端回 'manifest_payload'，写入本地 agentRegistry
 *   - 之后任何指令可以 pickAgent(capability, ownerDid) → 直接委派
 *
 * 协议消息 (Hyperswarm 字符串帧):
 *   manifest_request: { }
 *   manifest_payload: { ownerName, ownerPublicKey, agents:[{id,name,capabilities,status}], publishedAt }
 *
 * 本文件不绑定 transport — 只提供 build/parse/dispatch 帮助函数。
 * 调用方在自己 transport 上挂 onMessage('manifest_request', ...) 和 onMessage('manifest_payload', ...)。
 */

export interface AgentManifestEntry {
  id: string;
  name: string;
  capabilities: string[];
  status: 'active' | 'idle' | 'busy' | 'creating' | 'terminated';
  // 可选 — 若对方把这个 agent 关联到具体子 P2P 端点
  peerId?: string;
  irohNodeId?: string;
  sessionId?: string;
  cid?: string;
  ipnsName?: string;
}

export interface AgentManifest {
  ownerName: string;
  ownerPublicKey: string;
  agents: AgentManifestEntry[];
  publishedAt: number;
}

// ============== 帧构造 ==============
export function buildManifestRequest(): string {
  return JSON.stringify({ type: 'manifest_request', payload: {}, ts: Date.now(), fromDid: '' });
}

export function buildManifestPayload(manifest: AgentManifest): string {
  return JSON.stringify({ type: 'manifest_payload', payload: manifest, ts: Date.now(), fromDid: '' });
}

export function buildAgentDelegateRequest(opts: {
  capability: string;
  docPath?: string;
  docContent?: string;
  instruction: string;
  fromAgentId: string;
}): string {
  return JSON.stringify({ type: 'agent_delegate', payload: opts, ts: Date.now(), fromDid: '' });
}

export function buildAgentResponse(opts: {
  ok: boolean;
  delegatedTo: string;
  resultCid?: string;
  summary: string;
  error?: string;
}): string {
  return JSON.stringify({ type: 'agent_response', payload: opts, ts: Date.now(), fromDid: '' });
}

// ============== 帧解析 ==============
export function parseFrame(text: string): { type: string; payload: any; ts: number; fromDid: string } | null {
  try { return JSON.parse(text); } catch { return null; }
}

// ============== 本地 manifest registry ==============
const localManifest: AgentManifest = {
  ownerName: '',
  ownerPublicKey: '',
  agents: [],
  publishedAt: 0,
};

export function setLocalManifest(m: Partial<AgentManifest>) {
  Object.assign(localManifest, m, { publishedAt: Date.now() });
  return localManifest;
}

export function getLocalManifest(): AgentManifest {
  return localManifest;
}

export function addLocalAgent(agent: AgentManifestEntry) {
  const idx = localManifest.agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) localManifest.agents[idx] = agent;
  else localManifest.agents.push(agent);
  localManifest.publishedAt = Date.now();
  return localManifest;
}

// ============== 远端 manifest 缓存 ==============
const remoteManifests: Map<string, AgentManifest> = new Map();  // key = ownerPublicKey

export function cacheRemoteManifest(m: AgentManifest) {
  if (m.ownerPublicKey) remoteManifests.set(m.ownerPublicKey, m);
  return m;
}

export function getRemoteManifests(): AgentManifest[] {
  return Array.from(remoteManifests.values());
}

export function pickAgent(capability: string, ownerPublicKey?: string): { agent: AgentManifestEntry; owner: AgentManifest } | null {
  const owners = ownerPublicKey
    ? [remoteManifests.get(ownerPublicKey)].filter(Boolean) as AgentManifest[]
    : getRemoteManifests();
  for (const owner of owners) {
    const a = owner.agents.find((x) => x.capabilities.includes(capability) && x.status === 'active');
    if (a) return { agent: a, owner };
  }
  return null;
}
