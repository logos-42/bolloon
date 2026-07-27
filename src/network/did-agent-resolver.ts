/**
 * did-agent-resolver.ts — 从 DIAP DID 文档解析并落盘远端智能体
 *
 * 流程:
 *   1. 收到 peer manifest → 有 agents[i].cid 或 agents[i].ipnsName
 *   2. 通过 IPFS 公共网关读取 DID 文档（纯只读，不需要上传能力）
 *   3. 解析 DID 文档 → 提取 agent 身份信息（DID、公钥、服务端点）
 *   4. 把解析后的 agent 写入本地 peers/<pk>/agents/<agentId>.md
 *   5. 把 DID 身份信息用于更丰富的好友添加（用 DID 名而不是 generated name）
 */
import { IpfsClient } from '@diap/sdk';

// ============================================================================
// 接口
// ============================================================================

/** 从 DID 文档解析出的 agent 信息 */
export interface ResolvedDIDAgent {
  /** DID 文档中的 id (如 did:key:z6Mk...) */
  did: string;
  /** 从 DID 提取的友好名称（取 did:key: 后的短 hash 前 8 位） */
  name: string;
  /** DID 文档 verificationMethod[0].publicKeyMultibase */
  publicKeyMultibase?: string;
  /** DID 文档中的 services */
  services: Array<{ type: string; endpoint: string }>;
  /** 来源 CID */
  cid: string;
  /** 来源 IPNS（如有） */
  ipnsName?: string;
}

// ============================================================================
// 读取 DID 文档
// ============================================================================

/**
 * 通过 IPFS 公共网关读取 DID 文档
 * 使用 @diap/sdk 的 IpfsClient（public-only 只读模式）
 */
async function fetchDIDDocument(cid: string): Promise<any | null> {
  const ipfs = await IpfsClient.newPublicOnly(15);
  try {
    const content = await ipfs.get(cid);
    const doc = JSON.parse(content);
    // 基本校验：是合法的 DID 文档
    if (!doc || !doc.id || !doc['@context']) {
      console.warn(`[did-resolver] CID ${cid} 不是有效的 DID 文档（缺 id 或 @context）`);
      return null;
    }
    return doc;
  } catch (e: any) {
    console.warn(`[did-resolver] 从 CID ${cid} 获取 DID 文档失败: ${e.message?.substring(0, 100) || e}`);
    return null;
  }
}

/**
 * 通过公共网关解析 IPNS 名称 → CID
 * 大多数公共网关不支持 IPNS 解析，这是尽力而为
 * 真实环境建议用本地 Kubo 节点
 */
async function resolveIPNSToCid(ipnsName: string): Promise<string | null> {
  const gateways = [
    `https://ipfs.io/ipns/${ipnsName}`,
    `https://dweb.link/ipns/${ipnsName}`,
  ];
  for (const url of gateways) {
    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      // IPFS 网关会在响应头中返回 x-ipfs-path 或 x-ipfs-roots
      const ipfsPath = resp.headers.get('x-ipfs-path') || resp.headers.get('x-ipfs-roots');
      if (ipfsPath) {
        const cid = ipfsPath.replace('/ipfs/', '').trim();
        if (cid) return cid;
      }
      // 也可以直接 GET
      if (resp.ok) {
        const body = await resp.text();
        try {
          const doc = JSON.parse(body);
          if (doc.id && doc['@context']) return ipnsName; // 已经拿到内容，用原始 IPNS 名当 key
        } catch { /* not JSON, ignore */ }
      }
    } catch { /* timeout or network error, try next */ }
  }
  return null;
}

// ============================================================================
// 解析 DID 文档 → ResolvedDIDAgent
// ============================================================================

/**
 * 从 DID 文档解析 agent 身份信息
 */
function parseDIDDocument(doc: any, cid: string, ipnsName?: string): ResolvedDIDAgent {
  const did = doc.id || '';
  // 从 DID 提取友好名：did:key:z6Mk... → 取后 8 位
  const shortDid = did.includes(':') ? did.split(':').pop() || did : did;
  const name = shortDid.substring(0, 8);

  // 提取公钥
  const vm = doc.verificationMethod?.[0];
  const publicKeyMultibase = vm?.publicKeyMultibase;

  // 提取服务端点
  const services: Array<{ type: string; endpoint: string }> = [];
  if (Array.isArray(doc.service)) {
    for (const s of doc.service) {
      const ep = typeof s.serviceEndpoint === 'string'
        ? s.serviceEndpoint
        : JSON.stringify(s.serviceEndpoint);
      services.push({ type: s.type || 'unknown', endpoint: ep });
    }
  }

  return { did, name, publicKeyMultibase, services, cid, ipnsName };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 从 CID 读取并解析 agent 的 DID 文档
 *
 * @param cid IPFS CID
 * @returns 解析结果或 null
 */
export async function resolveAgentFromCID(cid: string): Promise<ResolvedDIDAgent | null> {
  const doc = await fetchDIDDocument(cid);
  if (!doc) return null;
  return parseDIDDocument(doc, cid);
}

/**
 * 通过 IPNS 名称解析 agent 的 DID 文档
 * 先尝试 IPNS → CID 解析，再用 CID 获取文档
 *
 * @param ipnsName IPNS 名称
 * @returns 解析结果或 null
 */
export async function resolveAgentFromIPNS(ipnsName: string): Promise<ResolvedDIDAgent | null> {
  // 先直接尝试用 IPNS 名当 CID 读取（部分场景 IPNS 名 = CIDv1 字符串）
  const directDoc = await fetchDIDDocument(ipnsName);
  if (directDoc) return parseDIDDocument(directDoc, ipnsName, ipnsName);

  // 再尝试 IPNS 解析
  const cid = await resolveIPNSToCid(ipnsName);
  if (cid) {
    const doc = await fetchDIDDocument(cid);
    if (doc) return parseDIDDocument(doc, cid, ipnsName);
  }

  return null;
}

/**
 * 从单个 AgentManifestEntry 解析 agent
 * 优先用 CID，回退 IPNS
 */
export async function resolveAgentFromEntry(entry: {
  id: string;
  name: string;
  cid?: string;
  ipnsName?: string;
}): Promise<ResolvedDIDAgent | null> {
  if (entry.cid) {
    const r = await resolveAgentFromCID(entry.cid);
    if (r) return r;
  }
  if (entry.ipnsName) {
    const r = await resolveAgentFromIPNS(entry.ipnsName);
    if (r) return r;
  }
  return null;
}

/**
 * 批量解析 peer manifest 中的 agents
 * 对每个有 cid/ipnsName 的 agent 尝试解析 DID 文档
 * 返回成功解析的列表
 */
export async function resolveAgentsFromManifest(agents: Array<{
  id: string;
  name: string;
  cid?: string;
  ipnsName?: string;
}>): Promise<ResolvedDIDAgent[]> {
  const results: ResolvedDIDAgent[] = [];
  for (const agent of agents) {
    if (!agent.cid && !agent.ipnsName) continue;
    const r = await resolveAgentFromEntry(agent);
    if (r) {
      results.push(r);
      console.log(`[did-resolver] ✅ 解析 agent ${agent.name || agent.id}: DID=${r.did ? r.did.substring(0, 20) + '...' : 'N/A'}`);
    } else {
      console.log(`[did-resolver] ⚠️ agent ${agent.name || agent.id} 没有可用的 cid/ipnsName，跳过 DID 解析`);
    }
  }
  return results;
}

/**
 * 把解析后的 DID agent 写入本地 peer-fs 目录
 * 同时更新 known_peers 中的 name 为 DID 文档中的名字
 */
export async function persistResolvedAgent(
  peerPublicKey: string,
  resolved: ResolvedDIDAgent,
): Promise<void> {
  try {
    const { writeAgentDescription } = await import('../network/peer-fs.js');
    const { addOrUpdatePeer } = await import('../network/known-peers.js');

    // 1. 写入 agent 详细描述到 peers/<pk>/agents/<id>.md
    const agentEntry = {
      id: resolved.did,
      name: resolved.name,
      capabilities: resolved.services.map(s => s.type),
      status: 'active' as const,
      cid: resolved.cid,
      ipnsName: resolved.ipnsName,
    };
    await writeAgentDescription(peerPublicKey, agentEntry);
    console.log(`[did-resolver] 📝 agent 已落盘: ${resolved.name} (${resolved.did?.substring(0, 20)}... → peers/${peerPublicKey.substring(0, 8)}.../agents/)`);

    // 2. 如果 peer 是 auto-discovered 的，用 DID 名更新好友名称
    const { findNameByPublicKey, removePeer } = await import('../network/known-peers.js');
    const existingName = await findNameByPublicKey(peerPublicKey);
    if (existingName && existingName.startsWith('discovered-')) {
      const newName = `did-${resolved.name}`;
      await removePeer(existingName);
      await addOrUpdatePeer(newName, peerPublicKey, `DID: ${resolved.did}`);
      console.log(`[did-resolver] 📛 更新 peer 名称: ${existingName} → ${newName}`);
    }
  } catch (e: any) {
    console.warn(`[did-resolver] 持久化 agent 失败:`, e.message?.substring(0, 100) || e);
  }
}
