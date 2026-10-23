/**
 * directory-rpc.ts — 跨机手机号目录查询 (P2P op: agent.directory.lookup / .reply)
 *
 * 背景: human-directory.ts 的 lookupPhone 用**本机 pepper** 重算 hash 比对 ——
 * 条目是发布者用**自己的 pepper** 算的, 因此「同步过来的别人的条目」永远查不到
 * (实测: 隔离 HOME 发布 → 条目复制进本机目录 → lookup 仍 found:false)。
 * 设计稿 (phone-account-lookup-design §3.2 方案 A) 的意图是 **pepper 在目录服务端**:
 * 查询者把手机号发给持有目录的节点, 该节点**用自己的 pepper** 在自己的条目里逐个试。
 *
 * 本模块实现这个跨机查询协yi:
 *   A 端 (查询者): 本地 lookupPhone miss → 对每个在线 peer 发 agent.directory.lookup
 *                   (payload: { rpcId, phone, fromPublicKey }) → 等 reply (超时) →
 *                   首个命中返回 DID/公钥。
 *   B 端 (目录持有者): 收到后在本机目录用**自己的 pepper** lookupPhone(phone) →
 *                   回 agent.directory.lookup.reply (payload: { rpcId, found, did, ... })。
 *
 * 纯函数/协议部分放这里 (可单测); P2P 收发由 server.ts 接线 (注: 这里是**语义真实**的
 * 跨机查询 —— 手机号在 P2P 帧里明文传输, 与 friend-request 同级隐私, 只在已互联 peer 间)。
 */
import { blindHash, normalizePhone } from './human-directory.js';

export const DIRECTORY_LOOKUP_OP = 'agent.directory.lookup';
export const DIRECTORY_LOOKUP_REPLY_OP = 'agent.directory.lookup.reply';
export const DIRECTORY_LOOKUP_TIMEOUT_MS = 4000;

export interface DirectoryLookupRpc {
  v: number;
  op: string;
  payload: {
    rpcId: string;
    phone: string;
    fromPublicKey?: string;
  };
}

export interface DirectoryLookupReply {
  v: number;
  op: string;
  payload: {
    rpcId: string;
    found: boolean;
    did?: string;
    publicKeyHex?: string;
    displayName?: string;
    error?: string;
  };
}

/** 构造查询帧 (供发送侧用) */
export function buildLookupRpc(rpcId: string, phone: string, fromPublicKey?: string): DirectoryLookupRpc {
  return { v: 3, op: DIRECTORY_LOOKUP_OP, payload: { rpcId, phone, fromPublicKey } };
}

/** 构造回复帧 (供接收侧用) */
export function buildLookupReply(
  rpcId: string,
  r: { found: boolean; did?: string; publicKeyHex?: string; displayName?: string },
): DirectoryLookupReply {
  return { v: 3, op: DIRECTORY_LOOKUP_REPLY_OP, payload: { rpcId, ...r } };
}

/**
 * 接收侧: 用本机 pepper 在本机目录里查 (与 lookupPhone 同口径, 但入口是「别人给我的手机号」)。
 * 返回与 lookupPhone 同形状的结果 (found/did/publicKeyHex/displayName)。
 * 注入 homeDir 供测试。
 */
export async function foreignLookupPhone(
  phone: string,
  lookupImpl: (p: string) => Promise<{ found: boolean; did?: string; publicKeyHex?: string; displayName?: string }>,
): Promise<{ found: boolean; did?: string; publicKeyHex?: string; displayName?: string }> {
  const norm = normalizePhone(phone);
  if (!/^\+?\d{8,15}$/.test(norm)) return { found: false };
  return lookupImpl(norm);
}

/** 校验收到的 reply 是否匹配我们发出的查询 (rpcId + 协议 op) —— 供发送侧过滤 */
export function isLookupReplyFor(payload: any, rpcId: string): boolean {
  return payload?.rpcId === rpcId;
}

/** 纯工具: 从多个对端 reply 里选第一个命中的 (全部 miss → {found:false}) */
export function pickFirstHit(replies: Array<{ found: boolean; did?: string; publicKeyHex?: string; displayName?: string }>) {
  return replies.find((r) => r.found) || { found: false };
}

export { blindHash }; // re-export for tests