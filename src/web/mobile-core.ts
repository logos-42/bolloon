/**
 * mobile-core.ts — 手机端内化内核 (2026-08-14)
 *
 * 目标: 把桌面 server 的核心能力完全内化到手机端, 不依赖桌面版.
 * 替换 fs → IndexedDB, node crypto → WebCrypto, 桌面 LLM → Kotlin AgentRuntime (Capacitor bridge).
 *
 * 提供与 mobile.js 对接的 API 面 (同 server.ts 语义):
 *   core.channels.get() / save()
 *   core.session.get(channelId)
 *   core.identity.status() / logout()
 *   core.peers.list()
 *   core.mcp.tools()
 *   core.message.send({text, channelId})
 *   core.payments.pending() / approve(id) / reject(id)
 *   core.events.subscribe(fn) — 内核事件总线 (替代 SSE)
 *
 * P2P 内化 (libp2p websockets) 在 gateway-network.ts 已有 joinNetwork; 浏览器传输在 Phase 2.
 * 本模块先落地单机全能力 (数据/身份/支付/会话/Agent).
 */

// ============ IndexedDB 存储层 (替代 fs JSON) ============

const DB_NAME = 'bolloon-mobile';
const DB_VERSION = 1;
let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv'); // key-value: channels / session / identity / peers / approvals
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<any> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSet(key: string, val: any): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

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

// ============ 身份 (WebCrypto Ed25519 → 无法直接; 用 RSASSA-PSS 或随机 + SHA-256 生成 DID) ============

async function generateDID(): Promise<string> {
  // DID: did:blln:<32 hex> — 用 WebCrypto 生成随机密钥对 (RSASSA-PSS 不产生公钥指纹),
  // 简化: crypto.getRandomValues → sha256 → hex (移动端匿名身份, 无链上绑定)
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'did:blln:' + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ============ 支付审批存储 ============

export interface Approval {
  id: string;
  service: string;
  amount: number;
  recipient: string;
  reason: string;
  retryPayload?: any;
  createdAt: number;
  resolved?: boolean;
  resolvedAt?: number;
  approved?: boolean;
}

async function loadApprovals(): Promise<Approval[]> {
  return (await idbGet('approvals')) || [];
}
async function saveApprovals(list: Approval[]): Promise<void> {
  await idbSet('approvals', list);
}

// ============ 内核 API (mobile.js 对接面) ============

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

  events: {
    subscribe: busSubscribe,
  },

  channels: {
    async get(): Promise<any[]> {
      return (await idbGet('channels')) || [];
    },
    async save(channels: any[]): Promise<void> {
      await idbSet('channels', channels);
      busBroadcast({ type: 'channels-updated', count: channels.length });
    },
  },

  session: {
    async get(channelId: string): Promise<{ messages: any[] } | null> {
      const key = 'session:' + channelId;
      const s = await idbGet(key);
      if (s) return s;
      // fallback: 空会话
      return { messages: [] };
    },
    async save(channelId: string, session: any): Promise<void> {
      await idbSet('session:' + channelId, session);
    },
  },

  identity: {
    async status(): Promise<any> {
      let id = await idbGet('identity');
      if (!id) {
        id = { did: await generateDID(), name: 'blln-mobile', accounts: [], createdAt: Date.now() };
        await idbSet('identity', id);
      }
      return { ...id, didShort: id.did?.slice(0, 12) };
    },
    async logout(): Promise<void> {
      await idbDel('accounts');
    },
  },

  peers: {
    async list(): Promise<any[]> {
      return (await idbGet('peers')) || [];
    },
    async save(peers: any[]): Promise<void> {
      await idbSet('peers', peers);
    },
  },

  mcp: {
    async tools(): Promise<any[]> {
      // 手机端内置工具 (MCP 列表)
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
      // 1. 记录用户消息
      const session = (await core.session.get(channelId)) || { messages: [] };
      session.messages.push({ role: 'user', content: text, ts: Date.now() });
      await core.session.save(channelId, session);
      busBroadcast({ type: 'user', channelId, content: text });

      // 2. 通知已发送
      setTimeout(() => busBroadcast({ type: 'done', channelId }), 0);

      // 3. AI 回复: 优先走 Kotlin AgentRuntime (Capacitor), 否则内核提示
      try {
        const reply = await runLocalAgent(text, channelId);
        session.messages.push({ role: 'ai', content: reply, ts: Date.now() });
        await core.session.save(channelId, session);
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
    async pending(): Promise<{ approvals: Approval[] }> {
      const all = await loadApprovals();
      const pending = all.filter((a) => !a.resolved);
      return { approvals: pending.map(({ retryPayload, ...rest }) => rest) };
    },
    async approve(id: string): Promise<void> {
      const all = await loadApprovals();
      const a = all.find((x) => x.id === id);
      if (a) { a.resolved = true; a.resolvedAt = Date.now(); a.approved = true; await saveApprovals(all); }
      busBroadcast({ type: 'payment-approved', id });
    },
    async reject(id: string): Promise<void> {
      const all = await loadApprovals();
      const a = all.find((x) => x.id === id);
      if (a) { a.resolved = true; a.resolvedAt = Date.now(); a.approved = false; await saveApprovals(all); }
      busBroadcast({ type: 'payment-rejected', id });
    },
  },
};

/** 本地 Agent: 优先 Kotlin AgentRuntime (Capacitor RokidBridge.runAgent), 否则内置规则回复 */
async function runLocalAgent(text: string, channelId: string): Promise<string> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  if (bridge && cap.isNativePlatform?.()) {
    try {
      const r = await bridge.runAgent({ goal: text });
      return r?.result || '（无返回）';
    } catch (e: any) {
      throw new Error('AgentRuntime: ' + String(e?.message || e).slice(0, 60));
    }
  }
  // 内置极简回复 (桌面版不在线时可用)
  const t = text.trim();
  if (t.includes('你好') || t === 'hi' || t === 'hello') return '你好! 我是炁球 (Bolloon), 已在本机独立运行 (Agent Gateway + 本地身份 + 支付审批)。';
  if (t.includes('身份') || t.includes('did')) {
    const s = await core.identity.status();
    return `我的本地 DID: ${s.didShort}... (匿名身份, 手机端独立生成)`;
  }
  return `已收到: "${text.slice(0, 40)}"。我是本地运行的内核 Agent (Phase 1: 数据/身份/支付已内化, P2P 浏览器传输在 Phase 2)。`;
}

// 全局暴露给 mobile.js
if (typeof window !== 'undefined') {
  (window as any).BolloonCore = core;
}

export default core;
