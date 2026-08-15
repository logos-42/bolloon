/**
 * mobile-core.ts — 手机端内核协调层 (2026-08-15 重构)
 *
 * 目标: 手机是"独立逻辑", 数据同步 ≠ agent 功能, 两块独立子系统:
 *   1. mobile-data.ts  — 数据同步层 (IndexedDB 副本, data.* 协议, 与远端双向同步)
 *   2. mobile-agent.ts — Agent 功能层 (独立 DID, Kotlin AgentRuntime, agent.chat.* 协议)
 *
 * 本文件只做两件事:
 *   a) 对外暴露与 mobile.js 对接的 API 面 (resolve/resolvePost/events, 同 server.ts 语义)
 *   b) P2P 入站消息路由: 按 type 前缀分发给 data / agent 层
 *
 * 不在这里混数据与智能: 落库走 data 层, 执行走 agent 层.
 */

// ============ 事件总线 (替代 SSE) ============

type BusHandler = (msg: any) => void;
const busHandlers = new Set<BusHandler>();

function busBroadcast(msg: any) {
  for (const h of busHandlers) h(msg);
}
function busSubscribe(fn: BusHandler): () => void {
  busHandlers.add(fn);
  return () => busHandlers.delete(fn);
}

// ============ P2P 消息路由: 数据同步 (data.*) vs Agent 功能 (agent.*) ============

/** 统一发送封装 (mobile-p2p), 供 data/agent 层注入 */
async function sendViaP2P(type: string, payload: string, peerId?: string): Promise<boolean> {
  try {
    const { sendMobileP2PMessage } = await import('./mobile-p2p.js');
    const agent = await import('./mobile-agent.js');
    const id = await agent.ensureIdentity();
    return await sendMobileP2PMessage(peerId || '*', type, payload, id.did);
  } catch {
    return false;
  }
}

/** 入站 P2P 消息路由 (由 network.start 的 onMobileP2PMessage 调用) */
async function routeIncomingMessage(payload: string, fromPeer: string): Promise<void> {
  try {
    const colonIdx = payload.indexOf(':');
    const type = colonIdx > 0 ? payload.substring(0, colonIdx) : payload;
    const body = colonIdx > 0 ? payload.substring(colonIdx + 1) : '';

    // data.* → 数据同步层
    if (type.startsWith('data.')) {
      const dataLayer = await import('./mobile-data.js');
      await dataLayer.handleIncomingDataMessage(type, body, fromPeer);
      return;
    }
    // agent.* → Agent 功能层
    if (type.startsWith('agent.')) {
      const agentLayer = await import('./mobile-agent.js');
      await agentLayer.handleIncomingAgentMessage(type, body, fromPeer);
      return;
    }
  } catch { /* 路由失败静默 */ }
}

// ============ 内核 API (mobile.js 对接面, 路由到 data/agent 层) ============

export const core = {
  /** 路径 → 内核函数 (mobile.js api.get fallback 链) */
  resolve(path: string): (() => Promise<any>) | null {
    const p = path || '';
    if (p === '/channels') return () => core.channels.get();
    if (p === '/api/peers') return () => core.peers.list();
    if (p === '/api/mcp/tools') return () => core.mcp.tools();
    if (p === '/api/auth/status') return () => core.identity.status();
    if (p === '/api/payments/pending') return () => core.payments.pending();
    if (p.startsWith('/sessions/')) {
      const cid = decodeURIComponent(p.slice('/sessions/'.length));
      return () => core.session.get(cid);
    }
    return null;
  },

  /** POST 路径 → 内核函数 */
  resolvePost(path: string, body: any): (() => Promise<any>) | null {
    const p = path || '';
    if (p === '/message') {
      const b = body || {};
      return () => core.message.send({ text: b.text, channelId: b.channelId });
    }
    if (p === '/api/auth/logout') return () => core.identity.logout();
    if (p.startsWith('/api/payments/') && p.endsWith('/approve')) {
      const id = p.slice('/api/payments/'.length, -'/approve'.length);
      return () => core.payments.approve(id);
    }
    if (p.startsWith('/api/payments/') && p.endsWith('/reject')) {
      const id = p.slice('/api/payments/'.length, -'/reject'.length);
      return () => core.payments.reject(id);
    }
    return null;
  },

  /** P2P 网络 — 启动浏览器 libp2p 节点, 并注入 data/agent 两层传输 */
  network: {
    async start(seedAddrs?: string[]): Promise<any> {
      try {
        const { startMobileP2P, getMobileP2PState, onMobileP2PMessage } = await import('./mobile-p2p.js');
        const agentLayer = await import('./mobile-agent.js');
        const dataLayer = await import('./mobile-data.js');

        const id = await agentLayer.ensureIdentity();
        const st = await startMobileP2P({ seedAddrs, ownDid: id.did });

        // 注入传输: data/agent 两层用同一发送通道
        dataLayer.setDataTransport((type, payload, peerId) => sendViaP2P(type, payload, peerId));
        agentLayer.setAgentTransport((type, payload, peerId) => sendViaP2P(type, payload, peerId), id.did);

        // 入站对端 chat → 数据层写入对端消息 + 事件广播 (对端 on-device 消息同步)
        agentLayer.onInboundChat((text, channelId, fromPeer) => {
          dataLayer.appendMessage(channelId, { role: 'ai', content: text, ts: Date.now(), from: fromPeer })
            .then(() => {
              busBroadcast({ type: 'ai', channelId, content: text, role: 'ai', from: fromPeer });
              busBroadcast({ type: 'done', channelId });
            })
            .catch(() => {});
        });

        // P2P 入站消息 → 路由 (data.* / agent.* 分开处理)
        onMobileP2PMessage((payload, fromPeer) => {
          routeIncomingMessage(payload, fromPeer).catch(() => {});
        });

        // 连上种子后尝试同步一次 (data 层)
        st.peerIds?.slice(0, 1).forEach((pid: string) => {
          dataLayer.syncFromPeer(pid).then((s) => {
            if (s.mode === 'online') {
              busBroadcast({ type: 'data-synced', mergedChannels: s.mergedChannels, mergedSessions: s.mergedSessions });
            }
          }).catch(() => {});
        });

        return getMobileP2PState();
      } catch (e: any) {
        return { connected: false, peerCount: 0, peerIds: [], error: String(e?.message || e).slice(0, 100) };
      }
    },
    status(): any {
      try {
        const m = (globalThis as any).__mobileP2PStateSync;
        if (m) return m();
        return { connected: false, peerCount: 0, peerIds: [], hint: 'P2P 未启动 (network.start 启动)' };
      } catch { return { connected: false, peerCount: 0, peerIds: [] }; }
    },
  },

  events: {
    subscribe: busSubscribe,
  },

  /** 数据同步层 (独立子系统 #1): 存储 + 同步 */
  data: {
    async getChannels() { const d = await import('./mobile-data.js'); return d.getChannels(); },
    async getSession(channelId: string) { const d = await import('./mobile-data.js'); const s = await d.getSession(channelId); return { messages: s.messages }; },
    async appendMessage(channelId: string, msg: any) { const d = await import('./mobile-data.js'); await d.appendMessage(channelId, msg); },
    async snapshot() { const d = await import('./mobile-data.js'); return d.snapshot(); },
    async syncFromPeer(peerId: string) { const d = await import('./mobile-data.js'); return d.syncFromPeer(peerId); },
    async pushLocal() { const d = await import('./mobile-data.js'); return d.pushLocal(); },
    status() { const d = Promise.resolve(import('./mobile-data.js')); return d; },
  },

  channels: {
    async get(): Promise<any[]> {
      const d = await import('./mobile-data.js');
      return d.getChannels();
    },
    async save(channels: any[]): Promise<void> {
      const d = await import('./mobile-data.js');
      await d.saveChannels(channels);
      busBroadcast({ type: 'channels-updated', count: channels.length });
    },
  },

  session: {
    async get(channelId: string): Promise<{ messages: any[] } | null> {
      const d = await import('./mobile-data.js');
      const s = await d.getSession(channelId);
      return { messages: s.messages };
    },
    async save(channelId: string, session: any): Promise<void> {
      const d = await import('./mobile-data.js');
      await d.saveSession({ channelId, messages: session.messages || [], updatedAt: session.updatedAt || Date.now() });
    },
  },

  identity: {
    async status(): Promise<any> {
      const a = await import('./mobile-agent.js');
      const id = await a.ensureIdentity();
      return { ...id, didShort: id.did?.slice(0, 12) };
    },
    async logout(): Promise<void> {
      // 手机端身份本地化, logout 只清 accounts 语义 (无 accounts 时 no-op)
    },
  },

  peers: {
    async list(): Promise<any[]> {
      const local = await (await import('./mobile-data.js')).getChannels();
      try {
        const { getMobileP2PState } = await import('./mobile-p2p.js');
        const st = getMobileP2PState();
        const connected = (st.peerIds || []).map((pid: string) => ({
          id: pid,
          publicKey: pid,
          name: 'P2P-' + pid.slice(0, 8),
          online: true,
        }));
        return connected;
      } catch {
        return [];
      }
    },
    async save(peers: any[]): Promise<void> {
      // 通讯录暂存 (可选持久化)
    },
  },

  mcp: {
    async tools(): Promise<any[]> {
      return [
        { name: 'gateway_status', description: '查看 Agent 网络状态 (已注册服务 + 信誉)' },
        { name: 'gateway_register', description: '把本 Agent 注册为服务提供者' },
        { name: 'gateway_call', description: '通过 Agent Gateway 调用服务 (自动闭环)' },
        { name: 'gateway_join', description: '通过链接加入共享 Agent 网络' },
      ];
    },
  },

  message: {
    async send({ text, channelId }: { text: string; channelId: string }): Promise<{ ok: boolean; error?: string }> {
      if (!text || !channelId) return { ok: false, error: 'text 和 channelId 必填' };
      const dataLayer = await import('./mobile-data.js');
      const agentLayer = await import('./mobile-agent.js');

      // 1. 数据层: 记录用户消息 (独立副本)
      await dataLayer.appendMessage(channelId, { role: 'user', content: text, ts: Date.now() });
      busBroadcast({ type: 'user', channelId, content: text });
      busBroadcast({ type: 'done', channelId });

      // 2. 通知其他节点 (各自 on-device 处理, 不等回复; 失败静默单机)
      try {
        const { sendMobileP2PMessage } = await import('./mobile-p2p.js');
        const id = await agentLayer.ensureIdentity();
        sendMobileP2PMessage('*', 'agent.chat.send', JSON.stringify({ text, channelId, fromPublicKey: id.did }), id.did).catch(() => {});
      } catch { /* P2P 未就绪则单机 */ }

      // 3. Agent 层: 手机 on-device 执行 (Kotlin AgentRuntime, 离线内置规则) — 执行主体是手机本身
      try {
        const reply = await agentLayer.runLocalAgent(text);
        await dataLayer.appendMessage(channelId, { role: 'ai', content: reply, ts: Date.now() });
        busBroadcast({ type: 'ai', channelId, content: reply, role: 'ai' });
        busBroadcast({ type: 'done', channelId });
      } catch (e: any) {
        busBroadcast({ type: 'ai', channelId, content: '（本地 Agent 未就绪: ' + String(e?.message || e).slice(0, 80) + '）', role: 'ai' });
        busBroadcast({ type: 'done', channelId });
      }
      return { ok: true };
    },
  },

  payments: {
    async pending(): Promise<{ approvals: any[] }> {
      // 支付审批: 手机本地 (与数据同步/agent 功能并列的独立能力)
      const { loadApprovals } = await import('./mobile-payments.js');
      const all = await loadApprovals();
      return { approvals: all.filter((a: any) => !a.resolved).map(({ retryPayload, ...rest }: any) => rest) };
    },
    async approve(id: string): Promise<void> {
      const { approveApproval } = await import('./mobile-payments.js');
      await approveApproval(id, true);
      busBroadcast({ type: 'payment-approved', id });
    },
    async reject(id: string): Promise<void> {
      const { approveApproval } = await import('./mobile-payments.js');
      await approveApproval(id, false);
      busBroadcast({ type: 'payment-rejected', id });
    },
  },
};

// 全局暴露给 mobile.js
if (typeof window !== 'undefined') {
  (window as any).BolloonCore = core;
}

export default core;