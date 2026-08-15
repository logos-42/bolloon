/**
 * mobile-data.ts — 手机端数据同步层 (2026-08-15)
 *
 * 独立子系统 #1: 手机是"独立存储副本", 不是桌面的缓存.
 *   - IndexedDB 是手机的本地方言数据 (channels / sessions / messages)
 *   - 与远端 (桌面/其他节点) 通过 P2P 协议双向同步
 *   - 协议类型 (复用桌面消息协议格式 DID:<did>|type:payload):
 *       data.sync      : 请求全量 (channels + 所有 session)   → 响应 data.snapshot
 *       data.snapshot  : 全量快照 (channels + sessions)
 *       data.channels  : channels 列表 (增量更新)
 *       data.session   : 单个 session (增量更新, 合并去重)
 *       data.pull      : 拉取指定 channelId 的 session → 响应 data.session
 *       data.llm-config      : 请求 LLM 配置 (桌面 llm-config.json 同步) → 响应 data.llm-config.reply
 *       data.llm-config.reply: 收到远端 LLM 配置 → 保存 + 通知 agent 层注入
 *   - 与 agent 功能无关: 本层只做数据一致, 不跑 LLM. LLM 配置同步是"数据"不是"智能".
 *
 * 离线: 读写本地 IndexedDB, 静默.
 * 在线: 通过 mobile-p2p 与 peer 同步, 冲突按 ts 最新合并.
 */

// ============ IndexedDB 存储 (独立于 agent 层) ============

const DB_NAME = 'bolloon-mobile-data';
const DB_VERSION = 1;
let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror = () => reject(req.error);
  });
}

/** 测试用: 关闭并清空当前库 (避免 deleteDatabase 阻塞) */
export async function resetDataDb(): Promise<void> {
  if (_db) {
    _db.close();
    _db = null;
  }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
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

// ============ 数据类型 (与桌面 loadChannels/loadSession 语义对齐) ============

export interface DataChannel {
  id: string;
  name?: string;
  persona?: { name?: string };
  agentId?: string;
  preview?: string;
  ts?: number;
}

export interface DataMessage {
  role: 'user' | 'ai';
  content: string;
  ts: number;
  from?: string;
}

export interface DataSession {
  channelId: string;
  messages: DataMessage[];
  updatedAt: number;
}

export interface DataSnapshot {
  channels: DataChannel[];
  sessions: DataSession[];
  syncedAt: number;
}

/** LLM 配置快照 (桌面 llm-config.json 同步到手机, 供 agent 层 bridge agentConfigure 注入) */
export interface LlmConfigSnapshot {
  activeProvider: string;
  providers: Record<string, {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    requiresApiKey?: boolean;
  }>;
  updatedAt?: number;
}

/** 手机端默认 LLM 配置 (未同步时用, 对应 Kotlin AgentLlmConfig 默认 deepseek) */
export function defaultLlmConfig(): LlmConfigSnapshot {
  return {
    activeProvider: 'deepseek',
    providers: {
      deepseek: { enabled: true, apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
    },
  };
}

/** 从 LlmConfigSnapshot 提取对 agent 层最有用的单 provider 配置 (activeProvider 优先) */
export function activeProviderConfig(cfg: LlmConfigSnapshot | null): { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } {
  if (!cfg) return {};
  const name = cfg.activeProvider || 'deepseek';
  const p = cfg.providers?.[name] || cfg.providers?.deepseek;
  return { baseUrl: p?.baseUrl, apiKey: p?.apiKey, model: p?.model, maxTokens: p?.maxTokens };
}

// ============ 本地存储 API (手机独立副本) ============

/** 读取 channels (本地) */
export async function getChannels(): Promise<DataChannel[]> {
  return (await idbGet('channels')) || [];
}

/** 保存 channels (本地) */
export async function saveChannels(channels: DataChannel[]): Promise<void> {
  await idbSet('channels', channels);
}

/** 读取单个 session (本地), 不存在返回空 */
export async function getSession(channelId: string): Promise<DataSession> {
  const s = await idbGet('session:' + channelId);
  if (s) return s;
  return { channelId, messages: [], updatedAt: 0 };
}

/** 保存单个 session (本地, 按 ts 去重合并) */
export async function saveSession(session: DataSession): Promise<void> {
  const prev = await getSession(session.channelId);
  const merged: DataMessage[] = [];
  const seen = new Set<string>();
  for (const m of [...(prev.messages || []), ...(session.messages || [])]) {
    const k = m.role + ':' + m.content + ':' + (m.ts || 0);
    if (!seen.has(k)) { seen.add(k); merged.push(m); }
  }
  merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  await idbSet('session:' + session.channelId, {
    channelId: session.channelId,
    messages: merged,
    updatedAt: Math.max(prev.updatedAt || 0, session.updatedAt || 0, Date.now()),
  });
}

/** 追加消息到 session (本地) */
export async function appendMessage(channelId: string, msg: DataMessage): Promise<void> {
  const s = await getSession(channelId);
  s.messages.push(msg);
  await saveSession(s);
}

/** 全量快照 (本地当前状态, 用于响应 data.sync / data.pull) */
export async function snapshot(): Promise<DataSnapshot> {
  return {
    channels: await getChannels(),
    sessions: await listSessions(),
    syncedAt: Date.now(),
  };
}

// ============ LLM 配置存储 (桌面同步 / 手机默认) ============

/** 读取本地 LLM 配置, 无则返回默认 (手机端) */
export async function getLlmConfig(): Promise<LlmConfigSnapshot> {
  const c = await idbGet('llm-config');
  return c || defaultLlmConfig();
}

/** 保存本地 LLM 配置 */
export async function saveLlmConfig(cfg: LlmConfigSnapshot): Promise<void> {
  const merged = { ...defaultLlmConfig(), ...cfg, updatedAt: cfg.updatedAt || Date.now() };
  await idbSet('llm-config', merged);
}

/** 是否有过桌面同步的 LLM 配置 (未同步时 mobile-agent 用手机默认) */
export async function hasSyncedLlmConfig(): Promise<boolean> {
  const c = await idbGet('llm-config');
  return !!(c && (c.updatedAt || c.providers));
}

/** 配置变更通知 (mobile-core 注册 → 转发给 agent 层注入 bridge) */
type LlmConfigListener = (cfg: LlmConfigSnapshot) => void;
const llmConfigListeners = new Set<LlmConfigListener>();

/** 注册 LLM 配置变更回调 */
export function onLlmConfig(fn: LlmConfigListener): void {
  llmConfigListeners.add(fn);
}

function notifyLlmConfig(cfg: LlmConfigSnapshot): void {
  for (const fn of llmConfigListeners) { try { fn(cfg); } catch { /* 忽略 */ } }
}

/** 向 peer 请求 LLM 配置 (data.llm-config → data.llm-config.reply) */
export async function requestLlmConfigFromPeer(peerId: string): Promise<boolean> {
  const send = getSend();
  if (!send) return false;
  return await send('data.llm-config', JSON.stringify({}), peerId);
}

/** 列出所有 session (遍历 kv) */
export async function listSessions(): Promise<DataSession[]> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').openCursor();
    const out: DataSession[] = [];
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        if (typeof c.key === 'string' && c.key.startsWith('session:')) {
          out.push(c.value);
        }
        c.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => resolve(out);
  });
}

// ============ 合并远端数据 (增量同步核心) ============

/** 合并远端快照: channels 以 ts 新者优先; sessions 逐条合并去重 */
export async function mergeSnapshot(remote: DataSnapshot): Promise<{ mergedChannels: number; mergedSessions: number }> {
  const localCh = await getChannels();
  const chMap = new Map<string, DataChannel>();
  for (const c of localCh) chMap.set(c.id, c);
  for (const c of remote.channels || []) {
    const prev = chMap.get(c.id);
    if (!prev || (c.ts || 0) >= (prev.ts || 0)) chMap.set(c.id, c);
  }
  const mergedChannels = chMap.size - localCh.length;
  await saveChannels(Array.from(chMap.values()));

  let mergedSessions = 0;
  for (const s of remote.sessions || []) {
    const prev = await getSession(s.channelId);
    if ((s.updatedAt || 0) >= (prev.updatedAt || 0)) {
      await saveSession(s);
      mergedSessions++;
    }
  }
  return { mergedChannels, mergedSessions };
}

/** 合并单个远端 session */
export async function mergeRemoteSession(s: DataSession): Promise<boolean> {
  const prev = await getSession(s.channelId);
  if ((s.updatedAt || 0) >= (prev.updatedAt || 0)) {
    await saveSession(s);
    return true;
  }
  return false;
}

// ============ 同步传输 (依赖 mobile-p2p, 运行时懒加载避免循环) ============

type SendFn = (type: string, payload: string, peerId?: string) => Promise<boolean>;

let _send: SendFn | null = null;
/** 由 mobile-core 注入发送函数 (对 mobile-p2p 的封装) */
export function setDataTransport(fn: SendFn): void {
  _send = fn;
}

function getSend(): SendFn | null {
  return _send;
}

/** 同步状态: 最近一次同步时间 + 合并数 */
export interface SyncStatus {
  lastSyncAt: number;
  mergedChannels: number;
  mergedSessions: number;
  mode: 'online' | 'offline';
}

let _syncStatus: SyncStatus = { lastSyncAt: 0, mergedChannels: 0, mergedSessions: 0, mode: 'offline' };

export function syncStatus(): SyncStatus {
  return { ..._syncStatus };
}

/** 向 peer 请求全量同步 (data.sync → data.snapshot), 成功则合并 */
export async function syncFromPeer(peerId: string, timeoutMs = 8000): Promise<SyncStatus> {
  const send = getSend();
  if (!send) return { ..._syncStatus, mode: 'offline' };
  const ok = await send('data.sync', JSON.stringify({ since: _syncStatus.lastSyncAt }), peerId);
  if (!ok) return { ..._syncStatus, mode: 'offline' };
  // 响应 data.snapshot 由 mobile-core 的 onMessage 分发到 mergeRemoteSnapshot
  return { ..._syncStatus, mode: 'online', lastSyncAt: Date.now() };
}

/** 处理入站 data.* 消息 (由 mobile-core 的 P2P 消息路由调用) */
export async function handleIncomingDataMessage(type: string, payload: string, fromPeer: string): Promise<void> {
  const send = getSend();
  switch (type) {
    case 'data.sync': {
      // 远端请求全量 → 回 data.snapshot
      if (send) {
        const snap = await snapshot();
        await send('data.snapshot', JSON.stringify(snap), fromPeer);
      }
      break;
    }
    case 'data.snapshot': {
      // 远端快照 → 合并本地
      try {
        const snap: DataSnapshot = JSON.parse(payload);
        const r = await mergeSnapshot(snap);
        _syncStatus = { lastSyncAt: Date.now(), mergedChannels: r.mergedChannels, mergedSessions: r.mergedSessions, mode: 'online' };
      } catch { /* 解析失败忽略 */ }
      break;
    }
    case 'data.channels': {
      try {
        const chs: DataChannel[] = JSON.parse(payload);
        await saveChannels(chs);
        _syncStatus = { ..._syncStatus, mergedChannels: chs.length, mode: 'online' };
      } catch { /* 忽略 */ }
      break;
    }
    case 'data.session': {
      try {
        const s: DataSession = JSON.parse(payload);
        const merged = await mergeRemoteSession(s);
        _syncStatus = { ..._syncStatus, mergedSessions: merged ? 1 : 0, mode: 'online' };
      } catch { /* 忽略 */ }
      break;
    }
    case 'data.pull': {
      // 远端拉取指定 session → 回 data.session
      if (send) {
        try {
          const { channelId } = JSON.parse(payload);
          const s = await getSession(channelId);
          await send('data.session', JSON.stringify(s), fromPeer);
        } catch { /* 忽略 */ }
      }
      break;
    }
    case 'data.llm-config': {
      // 远端请求本机 LLM 配置 → 回 data.llm-config.reply
      if (send) {
        try {
          const cfg = await getLlmConfig();
          await send('data.llm-config.reply', JSON.stringify(cfg), fromPeer);
        } catch { /* 忽略 */ }
      }
      break;
    }
    case 'data.llm-config.reply': {
      // 收到远端 LLM 配置 → 保存 + 通知 agent 层注入 bridge
      try {
        const cfg: LlmConfigSnapshot = JSON.parse(payload);
        if (cfg && (cfg.providers || cfg.activeProvider)) {
          await saveLlmConfig(cfg);
          notifyLlmConfig(await getLlmConfig());
        }
      } catch { /* 解析失败忽略 */ }
      break;
    }
    default:
      break;
  }
}

/** 广播本地最新状态给所有已连接 peer (主动推送) */
export async function pushLocal(toPeer?: string): Promise<void> {
  const send = getSend();
  if (!send) return;
  const chs = await getChannels();
  await send('data.channels', JSON.stringify(chs), toPeer);
  const sessions = await listSessions();
  for (const s of sessions) {
    await send('data.session', JSON.stringify(s), toPeer);
  }
}

export default { getChannels, saveChannels, getSession, saveSession, appendMessage, snapshot, mergeSnapshot, syncFromPeer, pushLocal, syncStatus, handleIncomingDataMessage, setDataTransport, getLlmConfig, saveLlmConfig, hasSyncedLlmConfig, onLlmConfig, requestLlmConfigFromPeer, defaultLlmConfig, activeProviderConfig };