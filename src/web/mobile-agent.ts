/**
 * mobile-agent.ts — 手机端 Agent 功能层 (2026-08-15)
 *
 * 独立子系统 #2: 手机是一个"独立 agent 节点", 与数据同步无关.
 *   - 自有身份: DID (WebCrypto 生成, 持久化 IndexedDB)
 *   - 自有执行: Kotlin AgentRuntime (Capacitor RokidBridge.runAgent), 离线可用内置规则
 *   - 协议 (复用桌面 agent.chat.* 语义):
 *       agent.chat.send : 主动调用远端 agent (A 节点对 channelId 跑 LLM → 回 agent.chat.reply)
 *       agent.chat.reply: 收到远端 agent 的执行结果
 *       agent.info      : 请求/响应 对端 DID 与能力
 *   - 本层只负责"agent 智能", 不碰存储; session 落库由 mobile-core 协调 data 层做.
 */

// ============ 身份 (WebCrypto) ============

const IDENTITY_DB = 'bolloon-mobile';
let _identity: { did: string; name: string; createdAt: number } | null = null;

async function generateDID(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'did:blln:' + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDENTITY_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _identityDb: IDBDatabase | null = null;

/** 测试用: 关闭并清空身份库 */
export async function resetAgentDb(): Promise<void> {
  _identity = null;
  if (_identityDb) {
    _identityDb.close();
    _identityDb = null;
  }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(IDENTITY_DB);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 获取本机 DID (首次生成并持久化) */
export async function ensureIdentity(): Promise<{ did: string; name: string; createdAt: number }> {
  if (_identity) return _identity;
  try {
    const db = _identityDb || (await openIdentityDb());
    _identityDb = db;
    const id = await new Promise<any>((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get('identity');
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    });
    if (id && id.did) {
      _identity = id;
      return id;
    }
    const fresh = { did: await generateDID(), name: 'blln-mobile', createdAt: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(fresh, 'identity');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    _identity = fresh;
    return fresh;
  } catch {
    const fallback = { did: await generateDID(), name: 'blln-mobile', createdAt: Date.now() };
    _identity = fallback;
    return fallback;
  }
}

// ============ 本地执行 (Kotlin AgentRuntime / 内置规则) ============

/** 手机端本地 agent 执行 (优先 Kotlin, 离线内置规则) */
export async function runLocalAgent(goal: string): Promise<string> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  if (bridge && cap.isNativePlatform?.()) {
    try {
      const r = await bridge.runAgent({ goal });
      return r?.result || '（无返回）';
    } catch (e: any) {
      throw new Error('AgentRuntime: ' + String(e?.message || e).slice(0, 60));
    }
  }
  // 内置极简回复 (纯离线可用)
  const t = (goal || '').trim();
  if (t.includes('你好') || t === 'hi' || t === 'hello') return '你好! 我是炁球 (Bolloon), 已在手机本地独立运行 (Agent 功能层 + 数据同步层分离)。';
  if (t.includes('身份') || t.includes('did')) {
    const id = await ensureIdentity();
    return `我的本地 DID: ${id.did.slice(0, 12)}... (手机端独立生成)`;
  }
  return `已收到: "${(goal || '').slice(0, 40)}"。这是手机端 Agent 功能层的本地执行 (数据同步与 agent 功能已分离)。`;
}

// ============ P2P 传输 (懒注入, 避免循环依赖) ============

type SendFn = (type: string, payload: string, peerId?: string) => Promise<boolean>;
type OnReplyFn = (replyPayload: string, fromPeer: string) => void;

let _send: SendFn | null = null;
let _ownDid: string = '';
const replyHandlers = new Set<OnReplyFn>();

/** 注入传输函数 + 本机 DID (由 mobile-core 在 network.start 时调用) */
export function setAgentTransport(fn: SendFn, did: string): void {
  _send = fn;
  _ownDid = did;
}

/** 订阅对端 agent.chat.reply 回复 (mobile-core 收到 reply 时分发) */
export function onAgentReply(fn: OnReplyFn): void {
  replyHandlers.add(fn);
}

/** 收到对端 agent.chat.reply 时的内部通知 (mobile-core 调用) */
export function notifyAgentReply(replyPayload: string, fromPeer: string): void {
  for (const h of replyHandlers) { try { h(replyPayload, fromPeer); } catch { /* 忽略 */ } }
}

/** 主动调用远端 agent: 发 agent.chat.send, 等待 agent.chat.reply */
export async function callRemoteAgent(peerId: string, text: string, channelId: string, timeoutMs = 30000): Promise<{ ok: boolean; reply?: string; error?: string }> {
  if (!_send) return { ok: false, error: 'P2P 未就绪' };
  const did = _ownDid || (await ensureIdentity()).did;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; replyHandlers.delete(onReply); resolve({ ok: false, error: 'timeout' }); }
    }, timeoutMs);
    const onReply = (payload: string, fromPeer: string) => {
      if (settled) return;
      try {
        const m = JSON.parse(payload);
        if (m?.channelId === channelId || !m?.channelId) {
          settled = true;
          clearTimeout(timer);
          replyHandlers.delete(onReply);
          resolve({ ok: true, reply: m?.text || m?.content || payload });
        }
      } catch {
        // 非 JSON 回复也接受
        if (!settled) { settled = true; clearTimeout(timer); replyHandlers.delete(onReply); resolve({ ok: true, reply: payload }); }
      }
    };
    replyHandlers.add(onReply);
    const s = _send;
    if (!s) {
      settled = true;
      replyHandlers.delete(onReply);
      return resolve({ ok: false, error: 'P2P 未就绪' });
    }
    s('agent.chat.send', JSON.stringify({ text, channelId, fromPublicKey: did }), peerId).then((ok) => {
      if (!ok && !settled) {
        settled = true;
        clearTimeout(timer);
        replyHandlers.delete(onReply);
        resolve({ ok: false, error: 'send failed' });
      }
    });
  });
}

/** 处理入站 agent.* 消息 (mobile-core 的 P2P 路由调用) */
export async function handleIncomingAgentMessage(type: string, payload: string, fromPeer: string): Promise<void> {
  switch (type) {
    case 'agent.chat.send': {
      // 对端调用本机: 本地执行 → 回 agent.chat.reply
      if (!_send) return;
      try {
        const { text, channelId } = JSON.parse(payload);
        const reply = await runLocalAgent(text || '');
        await _send('agent.chat.reply', JSON.stringify({ channelId, text: reply, fromPublicKey: _ownDid }), fromPeer);
      } catch { /* 解析/执行失败则不回 */ }
      break;
    }
    case 'agent.chat.reply':
      notifyAgentReply(payload, fromPeer);
      break;
    case 'agent.info':
      // 响应: 返回 DID + 能力
      if (_send) {
        const id = await ensureIdentity();
        await _send('agent.info.reply', JSON.stringify({ did: id.did, name: id.name, capabilities: ['chat', 'local-agent'] }), fromPeer);
      }
      break;
    default:
      break;
  }
}

export default { ensureIdentity, runLocalAgent, setAgentTransport, onAgentReply, callRemoteAgent, handleIncomingAgentMessage, notifyAgentReply };