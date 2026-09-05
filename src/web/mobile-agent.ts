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

// ============ LLM 配置 (桌面同步注入 / 手机默认) ============

let _llmConfig: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } | null = null;

/** 最近一次 runLocalAgent 的执行过程摘要 (每步 onStep 文本), 由 message.send 广播给工作记录 UI */
let _lastWorklog: string[] = [];
export function getLastWorklog(): string[] { return _lastWorklog; }

/** 注入 LLM 配置 (由 mobile-core 在 data.llm-config.reply 同步后调用) */
export function setLlmConfig(cfg: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } | null): void {
  _llmConfig = cfg;
  // 立即注入 native bridge (agentConfigure), 让 AgentRuntime 马上可用, 不必等下次 runLocalAgent
  applyLlmConfigToBridge().catch(() => {});
}

/** 当前 LLM 配置 (未同步则为 null → 手机默认) */
export function getLlmConfig(): { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } | null {
  return _llmConfig;
}

/** 把配置注入 Capacitor RokidBridge (agentConfigure), 让 Kotlin AgentRuntime 用同步来的 LLM */
async function applyLlmConfigToBridge(): Promise<void> {
  if (!_llmConfig) return;
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  if (!bridge || !cap.isNativePlatform?.()) return;
  const payload: any = {};
  if (_llmConfig.baseUrl) payload.baseUrl = _llmConfig.baseUrl;
  if (_llmConfig.apiKey) payload.apiKey = _llmConfig.apiKey;
  if (_llmConfig.model) payload.model = _llmConfig.model;
  try {
    await bridge.agentConfigure?.(payload);
  } catch { /* 注入失败不阻塞本地执行 */ }
}

// ============ 本地执行 (Kotlin AgentRuntime / 内置规则) ============

/** 手机端本地 agent 执行 (优先 Kotlin, 离线内置规则) */
export async function runLocalAgent(goal: string): Promise<string> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  if (bridge && cap.isNativePlatform?.()) {
    try {
      await applyLlmConfigToBridge();
      const r = await bridge.runAgent({ goal });
      _lastWorklog = (r && Array.isArray(r.worklog)) ? r.worklog.map((x: any) => String(x)) : [];
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
  if (t.includes('余额') || t.includes('钱包') || /balance/i.test(t)) {
    try {
      const id = await ensureIdentity();
      const w = await import('./mobile-wallet.js');
      const info = await w.walletForAgent(id.did);
      if (!info.exists) return '本机没有授权给当前智能体的钱包 (我 → 设置 → 钱包 可创建/授权)。';
      const w0 = info.wallets[0];
      let s = `钱包: ${w0.name || w0.id}`;
      s += `\n地址: ${w0.address}${w0.unlocked ? ' (已解锁)' : ' (未解锁)'}`;
      if (w0.unlocked) { try { s += `\n余额: ${await w.walletBalance(w0.id)}`; } catch { s += '\n余额: 查询失败'; } }
      else s += '\n解锁后可见余额。';
      return s;
    } catch (e: any) {
      return '钱包查询失败: ' + String(e?.message || e).slice(0, 80);
    }
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

/** 入站 chat 通知: 对端 agent.chat.send 到达时回调 (mobile-core 用于写入数据层同步会话) */
type OnInboundChatFn = (text: string, channelId: string, fromPeer: string) => void;
const inboundChatHandlers = new Set<OnInboundChatFn>();

export function onInboundChat(fn: OnInboundChatFn): void {
  inboundChatHandlers.add(fn);
}

function notifyInboundChat(text: string, channelId: string, fromPeer: string): void {
  for (const h of inboundChatHandlers) { try { h(text, channelId, fromPeer); } catch { /* 忽略 */ } }
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
      // 对端调用本机: 手机 on-device 本地执行 → 回 agent.chat.reply
      // 并通知协调层把对端消息写入数据层 (同步会话)
      if (!_send) return;
      try {
        const { text, channelId } = JSON.parse(payload);
        notifyInboundChat(text || '', channelId || '', fromPeer);
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

// ============ P2P 控制面 (phone.* 协议, 2026-08-15) ============
// 手机是自治节点: 桌面/其他节点经 P2P 发指令, 手机端独立 AgentLoop 执行, 不需要电脑同意.

export interface PhoneControlResult {
  ok: boolean;
  goal?: string;
  result?: string;
  error?: string;
  agentId?: string;
  stepCount?: number;
  did?: string;
  mode: 'native' | 'fallback';
}

/** 手机端执行控制指令 (phone.agent.run) — 手机自治执行, 不经电脑 */
export async function runPhoneAgent(goal: string): Promise<PhoneControlResult> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  const native = !!(bridge && cap.isNativePlatform?.());
  const id = await ensureIdentity();
  try {
    if (native) {
      await applyLlmConfigToBridge();
      const r = await bridge.runAgent({ goal });
      const result = r?.result || '（无返回）';
      const isDone = /^DONE:/.test(result) || /^CANCELLED/.test(result) || !/^(MAX_STEPS|STOPPED|\[Agent 异常)/.test(result);
      return {
        ok: !/^\[Agent 异常|^STOPPED|^MAX_STEPS/.test(result),
        goal,
        result,
        did: id.did,
        mode: 'native',
        agentId: r?.agentId,
        stepCount: r?.stepCount,
      };
    }
    // 离线 fallback: 内置规则 (不依赖 LLM/无障碍, 手机仍自治可用)
    const reply = await runLocalAgent(goal);
    return { ok: true, goal, result: reply, did: id.did, mode: 'fallback' };
  } catch (e: any) {
    return { ok: false, goal, error: String(e?.message || e).slice(0, 100), did: id.did, mode: native ? 'native' : 'fallback' };
  }
}

/** 手机端 Agent 状态 (phone.agent.status) */
export async function phoneStatus(): Promise<{ ok: boolean; did: string; mode: 'native' | 'fallback'; llm?: { baseUrl?: string; model?: string }; capabilities: string[] }> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  const native = !!(bridge && cap.isNativePlatform?.());
  const id = await ensureIdentity();
  let accReady = false;
  let llm: { baseUrl?: string; model?: string } | undefined;
  if (native && bridge) {
    try {
      const st = await bridge.agentStatus?.();
      accReady = !!st?.accessibilityReady;
      if (st?.baseUrl || st?.model) llm = { baseUrl: st.baseUrl, model: st.model };
    } catch { /* 忽略 */ }
  }
  return {
    ok: true,
    did: id.did,
    mode: native ? 'native' : 'fallback',
    llm,
    capabilities: ['chat', 'local-agent', 'phone-control'],
  };
}

/** 取消当前手机 Agent 任务 (phone.agent.cancel) */
export async function cancelPhoneAgent(reason = '远端取消'): Promise<{ ok: boolean; cancelRequested?: boolean }> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;
  const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
  if (bridge && cap.isNativePlatform?.()) {
    try {
      const r = await bridge.cancelAgent?.({ reason });
      return { ok: true, cancelRequested: !!r?.cancelRequested };
    } catch (e: any) {
      return { ok: false };
    }
  }
  return { ok: false };
}

/** 处理入站 phone.* 控制消息 (mobile-core 的 P2P 路由调用) */
export async function handleIncomingPhoneMessage(type: string, payload: string, fromPeer: string): Promise<void> {
  if (!_send) return;
  try {
    switch (type) {
      case 'phone.agent.run': {
        // 桌面/其他节点指令 → 手机自治执行 → 回 phone.agent.result
        const req = JSON.parse(payload);
        const goal = (req.goal || '').toString();
        const reqId = req.requestId || '';
        const result = await runPhoneAgent(goal);
        await _send('phone.agent.result', JSON.stringify({ ...result, requestId: reqId, fromPublicKey: _ownDid }), fromPeer);
        break;
      }
      case 'phone.agent.status': {
        const st = await phoneStatus();
        await _send('phone.agent.status.reply', JSON.stringify({ ...st, fromPublicKey: _ownDid }), fromPeer);
        break;
      }
      case 'phone.agent.cancel': {
        const req = JSON.parse(payload);
        const r = await cancelPhoneAgent(req.reason || '远端取消');
        await _send('phone.agent.cancel.reply', JSON.stringify({ ...r, fromPublicKey: _ownDid }), fromPeer);
        break;
      }
      default:
        break;
    }
  } catch { /* 控制消息处理失败静默 */ }
}

export default { ensureIdentity, runLocalAgent, setAgentTransport, onAgentReply, callRemoteAgent, handleIncomingAgentMessage, notifyAgentReply, onInboundChat, setLlmConfig, getLlmConfig, runPhoneAgent, phoneStatus, cancelPhoneAgent, handleIncomingPhoneMessage };