/**
 * server-v3-p2p.ts — server.ts 拆出的 v3 P2P 层
 *
 * 包含:
 *   - sanitizeChannelForPeer / isSharedWith
 *   - routeMentionsInReply (LLM 回复 @-mention 路由)
 *   - loadRemoteChannelCacheFromDisk / persistRemoteChannelCache
 *   - loadLocalSubAgents (跳过 subagent-manager 懒加载, 直接读 agents.json)
 *   - v3P2PRef (P2PDirect 引用, 让闭包外能拿到)
 *
 * 从 src/web/server.ts 抽出 (2026-07-06).
 */

import type { Channel } from './server-types.js';
import { REMOTE_CACHE_FILE } from './server-types.js';
import { loadChannels, saveSession, loadSession } from './server-storage.js';
import type { Session } from './server-types.js';
import { broadcast } from './server-sse.js';
import type { P2PDirect } from '../network/p2p-direct.js';

// v3: 远端 channel UI 元数据缓存 — key: peerId, value: sanitize 过的 channel 列表
// in-memory only, 进程重启清空 (judgment 内容永远不在这里)
const remoteChannelCache: Map<string, Array<Record<string, unknown>>> = new Map();

export function getRemoteChannelCache(): Map<string, Array<Record<string, unknown>>> {
  return remoteChannelCache;
}

// v3: P2PDirect 引用 (Hyperswarm 薄包装) - 模块级, 因为 web server 闭包里不可用
let v3P2PRef: P2PDirect | null = null;
export function getV3P2PRef(): P2PDirect | null {
  return v3P2PRef;
}
export function setV3P2PRef(ref: P2PDirect | null): void {
  v3P2PRef = ref;
}

// 2026-07-05: 一次性 prompt 附加块 — key: channelId, value: 下一次 LLM prompt 时 prepend 的内容
const nextPromptHints: Map<string, string> = new Map();
export function getNextPromptHints(): Map<string, string> {
  return nextPromptHints;
}

// 2026-07-05: 等待中的 history RPC (B 端 chat-history endpoint 用) — rpcId → { resolve, reject }
const v3PendingHistoryGets: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }> = new Map();
export function getV3PendingHistoryGets(): Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }> {
  return v3PendingHistoryGets;
}

/**
 * v3: 过滤 channel 元数据, 只返回对远端 peer 安全的字段.
 * 关键: bound_judgment_ids / walletBinding / autoInvokeTools 内部状态不外传.
 */
export function sanitizeChannelForPeer(
  ch: Channel,
  peerPublicKey?: string
): Record<string, unknown> | null {
  if (peerPublicKey) {
    const shared = Array.isArray(ch.shared_with_peers) ? ch.shared_with_peers : [];
    if (!shared.includes(peerPublicKey)) {
      return null;
    }
  }
  return {
    id: ch.id,
    name: ch.name,
    did: ch.did,
    publicKey: ch.publicKey,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
    hasWallet: !!ch.walletAddress,
    share_id: ch.share_id,
  };
}

/** v3 新增: 判断 channel 是否分享给 peerPublicKey */
export function isSharedWith(ch: Channel, peerPublicKey: string): boolean {
  const shared = Array.isArray(ch.shared_with_peers) ? ch.shared_with_peers : [];
  return shared.includes(peerPublicKey);
}

/**
 * v3 新增: 解析 LLM 回复里的 @-mentions, 把消息发到目标 channel.
 *
 * 语法: "@渠道名 消息内容" — 渠道名匹配 local channels by name, 或 remote channels by name.
 */
export async function routeMentionsInReply(
  originChannelId: string,
  replyText: string,
  localChannels: any[],
  remoteChannels: any[]
): Promise<Array<{ targetName: string; targetId: string; source: 'local' | 'remote'; text: string; status: 'sent' | 'failed' }>> {
  const results: any[] = [];
  const regex = /@([一-龥A-Za-z0-9_\-]{1,30})\s+([^\n@]+?)(?=(?:\s*@[一-龥A-Za-z0-9_\-]{1,30}\s)|$)/g;
  const matches = [...replyText.matchAll(regex)];

  if (matches.length === 0) return results;

  let originChannelName = originChannelId;
  try {
    const chs = await loadChannels();
    const oc = chs.find(c => c.id === originChannelId);
    if (oc) originChannelName = oc.name;
  } catch {}

  console.log(`[v3-cross] (${originChannelName}) 解析到 ${matches.length} 个 @-mention`);

  for (const m of matches) {
    const targetName = m[1].trim();
    const text = m[2].trim();
    if (!text) continue;

    const localTarget = localChannels.find(c => c.name === targetName);
    const remoteTarget = !localTarget ? remoteChannels.find(c => c.name === targetName) : null;

    if (localTarget) {
      try {
        const existing = await loadSession(localTarget.id, 'default');
        const session: Session = existing || {
          channelId: localTarget.id, sessionId: 'default', messages: [], lastUpdated: new Date().toISOString()
        };
        session.messages.push({
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'ai' as const,
          content: text,
          timestamp: new Date().toISOString(),
          source: 'ai-mention' as any,
          originChannelId,
          originChannelName
        });
        session.lastUpdated = new Date().toISOString();
        await saveSession(session);
        console.log(`[v3-cross] (${originChannelName}) @${targetName} → 本地 channel ${localTarget.id}, 存了 ${text.length} chars`);
        broadcast({
          type: 'cross-mention-received',
          originChannelId, originChannelName,
          targetChannelId: localTarget.id, targetChannelName: localTarget.name,
          text, source: 'ai-mention'
        }, 'broadcast');
        results.push({ targetName, targetId: localTarget.id, source: 'local', text, status: 'sent' });
      } catch (err) {
        console.error(`[v3-cross] @${targetName} 本地存失败:`, (err as Error).message);
        results.push({ targetName, targetId: localTarget.id, source: 'local', text, status: 'failed' });
      }
    } else if (remoteTarget) {
      const ownerPk = remoteTarget._ownerPublicKey;
      if (!v3P2PRef) {
        console.warn(`[v3-cross] P2PDirect 未启动, 跳过远端 @${targetName}`);
        results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'failed' });
        continue;
      }
      try {
        const rpcPayload = {
          targetChannelId: remoteTarget.id,
          targetChannelName: remoteTarget.name,
          originChannelId,
          originChannelName,
          text,
          fromPublicKey: v3P2PRef.getPublicKey()
        };
        const { sendOrQueue } = await import('../network/p2p-outbox.js');
        const r = await sendOrQueue(ownerPk, 'agent.cross.post', rpcPayload, v3P2PRef);
        if (r === 'SENT') {
          console.log(`[v3-cross] (${originChannelName}) @${targetName} → 远端 peer ${ownerPk.substring(0,12)}... (channelId=${remoteTarget.id})`);
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'sent' });
        } else if (r === 'QUEUED') {
          console.log(`[v3-cross] (${originChannelName}) @${targetName} → 远端 peer ${ownerPk.substring(0,12)}... 已入队 (对方不在线)`);
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'queued' });
        } else {
          results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'failed' });
        }
      } catch (err) {
        console.error(`[v3-cross] @${targetName} 远端 RPC 失败:`, (err as Error).message);
        results.push({ targetName, targetId: remoteTarget.id, source: 'remote', text, status: 'failed' });
      }
    } else {
      console.warn(`[v3-cross] @${targetName} 找不到匹配 channel (本地 ${localChannels.length} 个, 远端 ${remoteChannels.length} 个)`);
    }
  }

  return results;
}

// 2026-06-10: 持久化 remote channel cache 到 ~/.bolloon/remote-channels-cache.json
export async function loadRemoteChannelCacheFromDisk(): Promise<void> {
  try {
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (!existsSync(REMOTE_CACHE_FILE)) return;
    const raw = await readFile(REMOTE_CACHE_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [pk, list] of Object.entries(obj)) {
        if (Array.isArray(list)) {
          remoteChannelCache.set(pk, list as Array<Record<string, unknown>>);
        }
      }
      console.log(`[v3-meta] 从磁盘恢复 ${remoteChannelCache.size} 个 peer 的 channel cache`);
    }
  } catch (err) {
    console.warn('[v3-meta] 恢复 remote channel cache 失败 (非致命):', (err as Error).message);
  }
}

export async function persistRemoteChannelCache(): Promise<void> {
  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (!existsSync(`${process.env.HOME || '/tmp'}/.bolloon`)) {
      await mkdir(`${process.env.HOME || '/tmp'}/.bolloon`, { recursive: true });
    }
    const obj: Record<string, unknown> = {};
    for (const [pk, list] of remoteChannelCache.entries()) {
      obj[pk] = list;
    }
    await writeFile(REMOTE_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[v3-meta] 持久化 remote channel cache 失败 (非致命):', (err as Error).message);
  }
}

// 2026-07-05: 直接读 ~/.bolloon/agents/agents.json, 跳过 subagent-manager 的 lazy init
export async function loadLocalSubAgents(): Promise<any[]> {
  try {
    const fsPromises = await import('fs/promises');
    const path = await import('path');
    const home = process.env.BOLLOON_HOME || process.env.HOME || '/tmp';
    const file = path.join(home, '.bolloon', 'agents', 'agents.json');
    const raw = await fsPromises.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    process.stderr.write(`[LOADED] ${arr.length} agents from ${file}\n`);
    return arr;
  } catch (e: any) {
    process.stderr.write(`[LOAD FAIL] ${e?.message}\n`);
    return [];
  }
}

// 启动时立即同步读一次 (异步, 不阻塞)
loadRemoteChannelCacheFromDisk();
