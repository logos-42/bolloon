/**
 * iroh-delegate-transport — 把 irohTransport 适配成 DelegateTransport 抽象
 *
 * 目的: 让 agent-delegate-server 可以挂到 iroh transport 上, 而不是只在 Hyperswarm 测试里跑.
 *
 * 注意命名坑:
 *   - DelegateTransport.sendToNode 用的是 "publicKey" (Hyperswarm 测试用 Hyperswarm 公钥)
 *   - iroh 路径里我们没有 "publicKey", 只有 nodeId (string)
 *   - 这里我们把 iroh nodeId 直接当作 publicKey 字段传入. 调用方 (/api/agent/delegate) 的
 *     toPublicKey 参数实际上对应的就是 iroh 目标 nodeId.
 *   - DIAP 真实 did:key 与 iroh nodeId 的映射关系另由 agent-manifest 协议承担
 *     (manifest_payload.ownerPublicKey 字段), 后续在 manifest cache 里维护.
 */

import { irohTransport } from '../network/iroh-transport.js';
import { parseFrame, type AgentManifest } from '../agents/agent-manifest-protocol.js';
import type { DelegateTransport } from './agent-delegate-server.js';

export interface IrohDelegateTransportOptions {
  /** 超时 (毫秒), 默认 30000 */
  timeoutMs?: number;
  /** 调试日志开关 */
  verbose?: boolean;
}

/**
 * 构造一个基于 irohTransport 的 DelegateTransport 实现.
 *
 * sendToNode: 用 irohTransport.sendMessage 发送 frame, 然后用 requestResponse 等待
 *             对端 via onIncomingFrame 注册的 handler 写回.
 *             由于 iroh 1-shot 消息没有 req/resp 关联, 这里用 'agent_request' 类型
 *             包一层, 在 onMessage('agent_request') 内部复用现有 handler, 拿到 reply
 *             再用 'agent_response' 单播回原 node.
 *
 * onIncomingFrame: 把对方发的 manifest_request / manifest_payload / agent_delegate
 *             类型消息路由到 agent-delegate-server 注册的 handler.
 */
export function createIrohDelegateTransport(opts: IrohDelegateTransportOptions = {}): DelegateTransport {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const verbose = opts.verbose ?? false;

  let incomingHandler: ((fromPublicKey: string, frame: string) => Promise<string | null>) | null = null;

  // 单播回包映射: requestId -> resolver
  const pendingReplies: Map<string, { resolve: (v: string | null) => void; timer: any }> = new Map();

  // 启动时挂一次 onMessage 监听 (重复挂也只会换 handler, 不重复触发)
  irohTransport.onMessage('agent_request', async (msg) => {
    if (!incomingHandler) return;
    const f = parseFrame(new TextDecoder().decode(msg.payload));
    if (!f) return;
    const fromKey = msg.from;
    const reply = await incomingHandler(fromKey, new TextDecoder().decode(msg.payload));
    if (reply) {
      try {
        // 把 reply 也用 agent_response 类型发回去, requestId 透传
        const replyFrame = JSON.parse(reply);
        const reqId = (f as any)._reqId || replyFrame._reqId;
        const tagged = reqId ? JSON.stringify({ ...replyFrame, _reqId: reqId }) : reply;
        await irohTransport.sendMessage(fromKey, 'agent_response', new TextEncoder().encode(tagged));
        if (verbose) console.log(`[iroh-delegate] 已回包给 ${fromKey.substring(0, 12)}... (${replyFrame.type})`);
      } catch (e) {
        if (verbose) console.warn('[iroh-delegate] 回包失败:', e);
      }
    }
  });

  irohTransport.onMessage('agent_response', (msg) => {
    const f = parseFrame(new TextDecoder().decode(msg.payload));
    if (!f) return;
    const reqId = (f as any)._reqId;
    if (!reqId) return;
    const pending = pendingReplies.get(reqId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingReplies.delete(reqId);
      pending.resolve(JSON.stringify(f));
    }
  });

  return {
    sendToNode: async (publicKey, frame, timeoutOverrideMs) => {
      const t = timeoutOverrideMs ?? timeoutMs;
      const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tagged = JSON.stringify({ ...JSON.parse(frame), _reqId: reqId });
      const payload = new TextEncoder().encode(tagged);
      return new Promise(async (resolve) => {
        const timer = setTimeout(() => {
          pendingReplies.delete(reqId);
          resolve(null);
        }, t);
        pendingReplies.set(reqId, { resolve, timer });
        try {
          const ok = await irohTransport.sendMessage(publicKey, 'agent_request', payload);
          if (!ok) {
            clearTimeout(timer);
            pendingReplies.delete(reqId);
            resolve(null);
          }
        } catch (e) {
          if (verbose) console.warn('[iroh-delegate] 发送失败:', e);
          clearTimeout(timer);
          pendingReplies.delete(reqId);
          resolve(null);
        }
      });
    },

    onIncomingFrame: (handler) => {
      incomingHandler = handler;
    },
  };
}

/**
 * 把本地节点 manifest 注册到 agent-manifest 协议, 并写入本地缓存.
 * 在 iroh 初始化完成时调用一次.
 */
export function registerLocalAgents(
  ownerName: string,
  ownerPublicKey: string,
  agents: Array<{ id: string; name: string; capabilities: string[]; status?: 'active' | 'idle' | 'busy' }>
): void {
  // 动态导入避免循环引用
  import('../agents/agent-manifest-protocol.js').then((mod) => {
    mod.setLocalManifest({
      ownerName,
      ownerPublicKey,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        capabilities: a.capabilities,
        status: a.status || 'active',
      })),
    });
  });
}

export type { AgentManifest };
