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

// ============ 身份 (DIAP KeyManager — @diap/sdk/browser, 与桌面同一套) ============
// 2026-10-07: 手机端身份改用 @diap/sdk 原生实现 (KeyManager 生成 Ed25519 密钥对 → did:key),
//   与桌面 agent-identity / x402 签名完全同构: privateKey 32B 种子 + publicKey + did:key:z...
//   签名走 @noble/ed25519 signAsync (与桌面 ed25519Sign 同结果)。

const IDENTITY_DB = 'bolloon-mobile';

export interface MobileIdentity {
  /** did:key:z... (与桌面 DIAP 同格式) */
  did: string;
  /** 32 字节 Ed25519 公钥 hex */
  publicKey: string;
  /** 32 字节 Ed25519 私钥 hex — 只存本机 IndexedDB, 永不上传 */
  privateKey: string;
  /** 昵称 */
  name: string;
  /** 创建时间 */
  createdAt: number;
  /** 附带身份条件: 邮箱 / 手机号 / 备注 (用户自填, 仅本机) */
  email?: string;
  phone?: string;
  note?: string;
}

let _identity: MobileIdentity | null = null;

// #2 手机自动入网 (browser-safe gateway, 与桌面同一协议): 检测到链接自动 join
import { mobileAutoJoinGateway } from './mobile-gateway.js';

// @diap/sdk/browser — KeyManager (密钥生成/DID 派生), @noble/ed25519 — signAsync (签名)
// 两个都是纯 JS 无 Node 依赖, 浏览器可用。动态 import 避免拖慢首屏。
let _keyMgr: any = null;
let _ed25519: any = null;
async function loadDiap(): Promise<{ KeyManager: any; ed25519: any }> {
  if (_keyMgr && _ed25519) return { KeyManager: _keyMgr, ed25519: _ed25519 };
  const km = await import('@diap/sdk/browser');
  const ed = await import('@noble/ed25519');
  _keyMgr = km.KeyManager;
  _ed25519 = ed;
  return { KeyManager: km.KeyManager, ed25519: ed };
}

function bytesOf(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}
function bufToHex(buf: Uint8Array): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytesOf(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i]);
  return btoa(out);
}
function b64ToBytes(b64s: string): Uint8Array {
  const bin = atob(b64s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 用身份私钥 (32B hex) 签名任意文本 → base64 签名 + 公钥 + DID (与桌面 ed25519Sign 同语义) */
export async function signWithIdentity(payload: string): Promise<{ did: string; publicKey: string; signature: string; alg: 'ed25519' }> {
  const id = await ensureIdentity();
  if (!id.privateKey) throw new Error('identity_signing_unavailable: 本机身份无私钥');
  const { ed25519 } = await loadDiap();
  const priv = Uint8Array.from(id.privateKey.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const sig = await ed25519.signAsync(bytesOf(String(payload ?? '')), priv);
  return { did: id.did, publicKey: id.publicKey, signature: b64(new Uint8Array(sig)), alg: 'ed25519' };
}

/** 验证身份签名 (用身份公钥验) — 与桌面 ed25519Verify 同语义 */
export async function verifyIdentitySignature(payload: string, signatureB64: string, publicKeyHex: string): Promise<boolean> {
  try {
    const { ed25519 } = await loadDiap();
    const pub = Uint8Array.from(publicKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    return ed25519.verifyAsync(b64ToBytes(signatureB64), bytesOf(String(payload ?? '')), pub);
  } catch { return false; }
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDENTITY_DB, 2);
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

async function _kvGet(key: string): Promise<any> {
  try {
    const db = _identityDb || (await openIdentityDb()); _identityDb = db;
    return await new Promise((res) => { const t = db.transaction('kv', 'readonly'); const r = t.objectStore('kv').get(key); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); });
  } catch { return null; }
}
async function _kvPut(key: string, val: any): Promise<void> {
  try {
    const db = _identityDb || (await openIdentityDb()); _identityDb = db;
    await new Promise<void>((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = () => res(); t.onerror = () => res(); });
  } catch { /* IDB 不可用则仅内存态 */ }
}

/** 登录: 设置本机身份昵称 (无身份则新建) + 标记已登录 */
export async function loginIdentity(name: string): Promise<MobileIdentity & { loggedIn: boolean }> {
  const id = await ensureIdentity();
  const nm = String(name || '').trim() || 'blln-mobile';
  const next = { ...id, name: nm };
  await _kvPut('identity', next);
  await _kvPut('loggedIn', true);
  _identity = next;
  return { ...next, loggedIn: true };
}

/** 更新身份附带条件 (邮箱/手机号/备注) — 只存本机 */
export async function updateIdentityProfile(partial: { name?: string; email?: string; phone?: string; note?: string }): Promise<MobileIdentity> {
  const id = await ensureIdentity();
  const next: MobileIdentity = {
    ...id,
    name: typeof partial.name === 'string' && partial.name.trim() ? partial.name.trim() : id.name,
    email: typeof partial.email === 'string' ? partial.email.trim() : id.email,
    phone: typeof partial.phone === 'string' ? partial.phone.trim() : id.phone,
    note: typeof partial.note === 'string' ? partial.note.trim() : id.note,
  };
  await _kvPut('identity', next);
  _identity = next;
  return next;
}

/** 注销: 清除登录态 (保留设备 DID, 不影响 P2P/频道) */
export async function logoutIdentity(): Promise<{ ok: boolean }> {
  await _kvPut('loggedIn', false);
  return { ok: true };
}

/** 身份状态 (含登录态 + 附带条件; 未登录时 name 置空) */
export async function identityStatus(): Promise<any> {
  const id = await ensureIdentity();
  const loggedIn = (await _kvGet('loggedIn')) === true;
  return {
    did: id.did, didShort: id.did ? id.did.slice(0, 12) : '',
    name: loggedIn ? id.name : '', createdAt: id.createdAt, loggedIn,
    publicKey: id.publicKey || '',
    email: id.email || '', phone: id.phone || '', note: id.note || '',
  };
}

/** 获取本机身份 (首次用 DIAP KeyManager 生成 Ed25519 → did:key; 持久化) */
export async function ensureIdentity(): Promise<MobileIdentity> {
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
    // 2026-10-07: 用 @diap/sdk KeyManager 生成 (与桌面同一套) — DID 即公钥指纹, 可签名
    let kp: { did: string; publicKey: Uint8Array; privateKey: Uint8Array };
    try {
      const { KeyManager } = await loadDiap();
      kp = KeyManager.generate();
    } catch (err: any) {
      // 老 WebView 加载不了 @diap → 退化为哈希 DID (只读, 无签名)
      const digest = await sha256Hex(String(Date.now()) + Math.random());
      const legacy = { did: 'did:blln:' + digest.slice(0, 32), publicKey: '', privateKey: '', name: 'blln-mobile', createdAt: Date.now() };
      await _kvPut('identity', legacy);
      _identity = legacy;
      return legacy;
    }
    const fresh: MobileIdentity = {
      did: kp.did,
      publicKey: bufToHex(kp.publicKey),
      privateKey: bufToHex(kp.privateKey),
      name: 'blln-mobile',
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(fresh, 'identity');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    _identity = fresh;
    return fresh;
  } catch {
    const digest = await sha256Hex(String(Date.now()) + Math.random());
    const fallback = { did: 'did:blln:' + digest.slice(0, 32), publicKey: '', privateKey: '', name: 'blln-mobile', createdAt: Date.now() };
    _identity = fallback;
    return fallback;
  }
}

// ============ LLM 配置 (桌面同步注入 / 手机默认) ============

// 2026-10-07: 开箱即用 — 手机独立运行时无需任何 API 配置。
//   内置公共网关 (Cloudflare Worker: api.bolloon.cn) 转发到 GLM 上游;
//   公共通道每天 ≤500 次/人; 桌面同步注入自己的 key 后自动覆盖。
const BUILTIN_LLM = Object.freeze({
  baseUrl: 'https://api.bolloon.cn/v1',
  apiKey: 'bolloon-free',
  model: 'glm-5.3',
  maxTokens: 16384,
});

let _llmConfig: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } | null = null;

/** 最近一次 runLocalAgent 的执行过程摘要 (每步 onStep 文本), 由 message.send 广播给工作记录 UI */
let _lastWorklog: string[] = [];
export function getLastWorklog(): string[] { return _lastWorklog; }

/** 注入 LLM 配置 (由 mobile-core 在 data.llm-config.reply 同步后调用); null = 用内置免费网关 */
export function setLlmConfig(cfg: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } | null): void {
  _llmConfig = cfg;
  // 立即注入 native bridge (agentConfigure), 让 AgentRuntime 马上可用, 不必等下次 runLocalAgent
  applyLlmConfigToBridge().catch(() => {});
}

/** 当前 LLM 配置 (未同步则返回内置免费网关 → 手机开箱即用) */
export function getLlmConfig(): { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } | null {
  return _llmConfig || BUILTIN_LLM;
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

// ============ 手机端「读入网说明 → 入网」(2026-09-15) ============
//
// 背景: 手机端「一键入网」发出的口令是 `read https://bolloon.cn/bolloon-gateway-join.md`
// (mobile.js DEFAULT_JOIN_PROMPT), 但手机侧此前只会走到「已收到: "…"」的兜底回复 ——
// 也就是说这句话在手机上是**空转**的: 既不读文档, 也不入网。
// 现在手机自己就能走完: 读说明(校验 frontmatter) → 本机 DID → 服务登记
// (桌面可达则登记进桌面的网络 registry, 否则本机登记并如实说明) → P2P 公告(尽力) → 落盘入网态。
// 桌面不可达不是失败: 手机是自治节点; 但每一步都如实报 ok/note, 不假装入网。

/** 入网口令识别 (与 mobile.js 的默认 prompt 同源) */
export const MOBILE_JOIN_DOC_RE = /read\s+(https?:\/\/\S*bolloon-gateway-join\.md)/i;
const MOBILE_JOIN_STATE_KEY = 'bolloon_gateway_join';

export function detectJoinDocUrl(text: string): string | null {
  const m = MOBILE_JOIN_DOC_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

export interface MobileJoinStep { step: string; ok: boolean; note: string }
export interface MobileJoinResult {
  ok: boolean;
  docUrl: string;
  docVersion?: string;
  did?: string;
  steps: MobileJoinStep[];
  error?: string;
}

/** 极简 SKILL.md frontmatter 解析 (只认 name/version) */
function parseFm(text: string): { name?: string; version?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return {};
  const out: { name?: string; version?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    if (k === 'name') out.name = kv[2].trim().replace(/^["']|["']$/g, '');
    if (k === 'version') out.version = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export async function getMobileJoinState(): Promise<any | null> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MOBILE_JOIN_STATE_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveMobileJoinState(s: any): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(MOBILE_JOIN_STATE_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}

/**
 * 按入网说明文档入网 (手机端自足执行)。
 * opts.desktopBaseUrl 可注入 (测试用); 默认读 mobile-gateway 持久化的桌面基址。
 */
export async function joinGatewayFromDoc(docUrl: string, opts: { fetchImpl?: typeof fetch; desktopBaseUrl?: string; name?: string; timeoutMs?: number; did?: string } = {}): Promise<MobileJoinResult> {
  const f = opts.fetchImpl || fetch;
  const steps: MobileJoinStep[] = [];
  const url = String(docUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, docUrl: url, steps, error: `入网说明地址必须是 http(s) URL (收到: ${url.slice(0, 60)})` };
  }

  // ① 读入网说明 + 校验
  let docVersion: string | undefined;
  try {
    const r = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) } as any);
    if (!r.ok) {
      steps.push({ step: '读入网说明', ok: false, note: `文档不可达 (HTTP ${r.status})` });
      return { ok: false, docUrl: url, steps, error: `入网说明不可达 (HTTP ${r.status})` };
    }
    const text = await r.text();
    const fm = parseFm(text);
    if (fm.name !== 'bolloon-gateway-join' && !/加入网关|bolloon-gateway-join/.test(text)) {
      steps.push({ step: '读入网说明', ok: false, note: `不是 Bolloon 入网说明 (name=${fm.name || '无'})` });
      return { ok: false, docUrl: url, steps, error: '该文档不是 Bolloon 网关入网说明, 拒绝据此入网' };
    }
    docVersion = fm.version;
    steps.push({ step: '读入网说明', ok: true, note: `${fm.name || 'bolloon-gateway-join'} v${fm.version || '?'} (${text.length} 字符)` });
  } catch (e: any) {
    steps.push({ step: '读入网说明', ok: false, note: `读取失败: ${String(e?.message || e).slice(0, 120)}` });
    return { ok: false, docUrl: url, steps, error: `入网说明读取失败: ${String(e?.message || e).slice(0, 120)}` };
  }

  // ② 本机 DID (手机端身份层; 可注入, 便于测试/无 IndexedDB 环境)
  let did = String(opts.did || '');
  if (did) {
    steps.push({ step: 'DID 身份', ok: true, note: `${did} (注入身份)` });
  } else {
    try {
      const id = await ensureIdentity();
      did = id.did;
      steps.push({ step: 'DID 身份', ok: true, note: `${did} (手机端本机生成)` });
    } catch (e: any) {
      steps.push({ step: 'DID 身份', ok: false, note: String(e?.message || e).slice(0, 120) });
      return { ok: false, docUrl: url, docVersion, steps, error: '手机端 DID 生成失败' };
    }
  }

  const name = String(opts.name || 'phone-agent');
  const capabilities = ['chat', 'gateway-join'];

  // ③ 服务登记: 桌面可达 → 登记进桌面(网络) registry; 否则本机登记并如实说明
  let desktopBase = String(opts.desktopBaseUrl ?? '');
  if (opts.desktopBaseUrl === undefined) {
    try {
      const g: any = await import('./mobile-gateway.js');
      desktopBase = String(g.getDesktopBaseUrl() || '');
    } catch { desktopBase = ''; }
  }
  desktopBase = desktopBase.replace(/\/+$/, '');
  let registeredOn: 'desktop' | 'local' = 'local';
  if (desktopBase) {
    try {
      const r = await f(`${desktopBase}/api/registry/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: did, name, wallet: '',
          service: { name: 'chat', description: '手机端智能体 (自足节点)', price: { amount: '0', currency: 'USDC', per: 'task' }, endpoint: '' },
          capabilities,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      } as any);
      if (r.ok) {
        registeredOn = 'desktop';
        steps.push({ step: '服务登记', ok: true, note: `已登记进电脑端网络 registry (${desktopBase}) —— 网络内其他智能体可按能力发现我` });
      } else {
        steps.push({ step: '服务登记', ok: false, note: `电脑端 registry 拒绝 (HTTP ${r.status}); 已改为本机登记` });
      }
    } catch (e: any) {
      steps.push({ step: '服务登记', ok: false, note: `电脑端不可达 (${String(e?.message || e).slice(0, 80)}); 已改为本机登记` });
    }
  } else {
    steps.push({ step: '服务登记', ok: true, note: '未配置电脑端基址 → 只在本机登记 (手机是自治节点; 设置里填电脑端地址可登记进网络 registry)' });
  }

  // ④ P2P 公告 (尽力): 让已连接的对端知道本机服务; 没连上不是入网失败
  try {
    const p2p: any = await import('./mobile-p2p.js');
    let peers = 0;
    try { peers = (p2p.getConnectedPeers?.() || []).length; } catch { peers = 0; }
    if (peers > 0 && typeof p2p.sendMobileP2PMessage === 'function') {
      const okAnnounce = await p2p.sendMobileP2PMessage('*', 'registry.register', JSON.stringify({ agent_id: did, name, capabilities }), did);
      steps.push({ step: 'P2P 公告', ok: !!okAnnounce, note: okAnnounce ? `已向 ${peers} 个对端广播本机声明` : `广播失败 (对端 ${peers} 个)` });
    } else {
      steps.push({ step: 'P2P 公告', ok: false, note: '当前无已连接对端 (浏览器/未连电脑端时正常) — 本机声明已就绪, 连上即生效' });
    }
  } catch (e: any) {
    steps.push({ step: 'P2P 公告', ok: false, note: `P2P 层不可用: ${String(e?.message || e).slice(0, 80)}` });
  }

  // ⑤ 落盘入网态 (幂等: 同 url 再次入网覆盖时间戳)
  saveMobileJoinState({ url, did, name, capabilities, docVersion, registeredOn, desktopBaseUrl: desktopBase || undefined, joinedAt: new Date().toISOString() });
  const state = await getMobileJoinState();
  steps.push({ step: '落盘入网态', ok: !!state?.did, note: `localStorage:${MOBILE_JOIN_STATE_KEY}` });

  return { ok: true, docUrl: url, docVersion, did, steps };
}

/** 把入网结果渲染成给用户看的回复 (与桌面工具的 steps 汇报风格一致) */
export function formatMobileJoinResult(r: MobileJoinResult): string {
  if (!r.ok) {
    return `❌ 入网失败: ${r.error || '未知原因'}\n\n${r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.note}`).join('\n')}`;
  }
  const s = r.steps.find((x) => x.step === '服务登记');
  return [
    '✅ 已加入全球智能体网络 (手机端自足执行)',
    '',
    `DID: ${r.did}`,
    `入网说明: v${r.docVersion || '?'} (${r.docUrl})`,
    s ? `登记: ${s.note}` : '',
    '',
    ...r.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.step}: ${x.note}`),
    '',
    '用「网络 → Agent 网络」可查看成员; 设置里填电脑端地址可把本机登记进网络 registry。',
  ].filter((l) => l !== '').join('\n');
}

// ============ 本地执行 (Kotlin AgentRuntime / 离线兜底) ============


/** 手机端本地 agent 执行 (优先 Kotlin, 离线内置规则) */
export async function runLocalAgent(goal: string): Promise<string> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const cap = win?.Capacitor;

  // 2026-09-15: 「读入网说明 → 入网」在手机端本地自足执行 (先于 Kotlin 桥: 原生工具集里没有入网能力,
  //   交给它只会得到空转回复)。这样浏览器 / WebView / 真机三种环境行为一致。
  const joinDocUrl = detectJoinDocUrl(goal);
  if (joinDocUrl) {
    _lastWorklog = [`🧩 识别为入网口令: ${joinDocUrl}`];
    const r = await joinGatewayFromDoc(joinDocUrl).catch((e: any) => ({
      ok: false, docUrl: joinDocUrl, steps: [{ step: '入网', ok: false, note: String(e?.message || e).slice(0, 120) }], error: String(e?.message || e),
    } as MobileJoinResult));
    _lastWorklog = [..._lastWorklog, ...r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.note}`)];
    return formatMobileJoinResult(r);
  }

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
    // 2026-10-07: 手机自治 — 先用 LLM 循环 (经内置公共网关), 失败再降级纯规则
    try {
      const llm = getLlmConfig();
      if (llm && llm.baseUrl) {
        const reply = await runWebAgentLoop(goal, { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, maxTokens: llm.maxTokens });
        if (reply) return reply;
      }
    } catch { /* 网络/网关不可达 → 降级内置规则 */ }
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

// ============ 手机自治 agent 循环 (2026-10-07) ============
// 桌面端 WorkflowPivotLoop 的浏览器移植: LLM 多轮迭代 + 手机端可用工具集。
// 能力范围: 手机 WebView 能做的 (身份/钱包/入网/P2P/信息查询), 不假装能做 fs/shell。
// 保护: maxSteps=5 防死循环; 每轮把工具结果拼回对话; LLM 说完成或没有下一步即停。
// 2026-10-07: persona 注入 — 性格/价值观/兴趣/说话方式来自 mobile-persona (设置 → 性格)。
import { loadPersona, buildPersonaPrompt } from './mobile-persona.js';

function buildAgentSystem(): string {
  const persona = loadPersona();
  const personaBlock = buildPersonaPrompt(persona);
  return [
    '你是手机端 Bolloon 智能体 (自治节点), 用中文简洁回复。',
    personaBlock,
    '你有以下工具, 按需调用 (JSON: {"tool":"名字","args":{...}}), 不需要工具就直接回答:',
    '- get_status: 查本机身份/入网/钱包/P2P 状态 (args: 无)',
    '- get_wallet: 查钱包余额 (args: 无)',
    '- get_identity: 查本机 DID (args: 无)',
    '- get_contacts: 查联系方式授权状态 (args: 无)',
    '每轮只能用一个工具; 拿到结果后继续思考, 直到任务完成给出最终回答。',
  ].join('\n');
}

interface WebAgentToolResult { name: string; ok: boolean; output: string }
const WEB_AGENT_TOOLS: Record<string, () => Promise<string>> = {
  get_status: async () => {
    try { const id = await ensureIdentity(); return `DID: ${id.did.slice(0, 16)}... 名字: ${id.name}`; } catch (e: any) { return '身份读取失败: ' + String(e?.message || e).slice(0, 60); }
  },
  get_wallet: async () => {
    try {
      const id = await ensureIdentity();
      const w = await import('./mobile-wallet.js');
      const info = await w.walletForAgent(id.did);
      if (!info.exists) return '本机没有授权给当前智能体的钱包 (我 → 设置 → 钱包 可创建/授权)。';
      const w0 = info.wallets[0];
      let s = `钱包: ${w0.name || w0.id} (${w0.address.slice(0, 12)}...)`;
      if (w0.unlocked) { try { s += ` 余额: ${await w.walletBalance(w0.id)}`; } catch { s += ' 余额: 查询失败'; } }
      else s += ' (未解锁)';
      return s;
    } catch (e: any) { return '钱包查询失败: ' + String(e?.message || e).slice(0, 60); }
  },
  get_identity: async () => {
    const id = await ensureIdentity();
    return `DID: ${id.did} 名字: ${id.name}`;
  },
  get_contacts: async () => {
    try { return '联系方式与授权模块可用 (详见「我 → 联系方式与授权」)。'; } catch { return '联系人模块暂不可用'; }
  },
};

/** 单轮 LLM 调用 (OpenAI 兼容, 经内置公共网关) */
async function webAgentLlmCall(messages: Array<{ role: string; content: string }>, llm: { baseUrl: string; apiKey?: string; model?: string; maxTokens?: number }): Promise<string> {
  const resp = await fetch(llm.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (llm.apiKey || '') },
    body: JSON.stringify({
      model: llm.model || 'glm-5.3',
      messages,
      max_tokens: llm.maxTokens || 2048,
      temperature: 0.4,
    }),
  });
  if (!resp.ok) throw new Error('LLM HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 120));
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 空回复');
  return String(content).trim();
}

/**
 * 宽容提取 LLM 回复里的工具调用 JSON。
 * 匹配模式: {"tool":"...","args":{...}} — 容忍前置文本、代码块围栏、尾部文本。
 * 用花括号平衡计数提取完整对象 (非贪婪正则会被内层嵌套 {} 截断 — 模拟器验证踩到)。
 * 找不到合法 tool 字段返回 null (当作普通回答)。
 */
function extractToolCall(raw: string): { tool: string; args: Record<string, unknown> } | null {
  if (!raw) return null;
  // 1) 直接找第一个 '{"' 开头、括号平衡的完整 JSON 对象
  const start = raw.indexOf('{"');
  if (start >= 0) {
    try {
      const obj = parseBalancedJson(raw, start) as { tool?: unknown; args?: unknown } | null;
            if (obj && typeof obj.tool === 'string') {
              return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object' ? obj.args : {}) as Record<string, unknown> };
            }
    } catch { /* 不是 JSON, 继续 */ }
  }
  // 2) 代码块围栏内的 JSON (```json ... ```)
  const fm = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fm) {
    try {
      const obj = JSON.parse(fm[1]);
      if (obj && typeof obj.tool === 'string') {
        return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object' ? obj.args : {}) as Record<string, unknown> };
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 从 start 位置解析一个括号平衡的 JSON 对象 (容忍内部嵌套字符串/大括号) */
function parseBalancedJson(raw: string, start: number): unknown {
  if (raw[start] !== '{') throw new Error('not object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced');
}

/**
 * 手机端 agent 循环: goal → LLM 思考 → (工具调用 → 结果回填 → 再思考) → 最终回答。
 * 与桌面 pivot loop 同构但浏览器安全边界内; 任何一步失败即降级。
 */
export async function runWebAgentLoop(goal: string, llm: { baseUrl: string; apiKey?: string; model?: string; maxTokens?: number }): Promise<string | null> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: buildAgentSystem() },
    { role: 'user', content: goal },
  ];
  const MAX_STEPS = 5;
  const steps: string[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
      const raw = await webAgentLlmCall(messages, llm);
      // 2026-10-07 (模拟器验证发现): LLM 常输出前置文本+JSON ("好的，我先查询...\n{\"tool\":...}")
      //   旧正则要求整段是 JSON → 工具调用被当普通回答, 闭环断。宽容提取第一个 JSON 对象。
      const toolJson = extractToolCall(raw);
      if (toolJson && typeof toolJson.tool === 'string' && WEB_AGENT_TOOLS[toolJson.tool]) {
        const out = await WEB_AGENT_TOOLS[toolJson.tool]();
        steps.push(`🔧 ${toolJson.tool} → ${out.slice(0, 80)}`);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `工具结果: ${out}` });
        continue;
      }
    // 无工具调用 = 最终回答
    _lastWorklog = steps.length ? [...steps, `💬 ${raw.slice(0, 60)}`] : [`💬 ${raw.slice(0, 60)}`];
    if (steps.length) return `[手机自治执行 ${steps.length} 步]\n` + raw;
    return raw;
  }
  // 循环保护: 没收敛就给最后一条
  const last = messages[messages.length - 1]?.content || '';
  _lastWorklog = [...steps, '⚠ 达到步数上限, 已停止'];
  return `[手机自治执行, 达到 ${MAX_STEPS} 步上限]\n${last.slice(0, 200)}`;
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
        // #2 手机自动入网: 消息里带 network 链接 → 自动 join (browser-safe, 不阻塞回复)
        if (text && /orbitdb:\/\/|ipns:\/\/|https?:\/\/[^\s]*\/registry/.test(text)) {
          void mobileAutoJoinGateway(text).catch(() => {});
        }
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
  /** 人话说明: 为什么是这种执行方式 / 下一步该做什么 (避免用户看到技术词) */
  hint?: string;
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
    // 离线 fallback: 内置规则 (不依赖 LLM/原生执行能力, 手机仍自治可用)
    const reply = await runLocalAgent(goal);
    return {
      ok: true, goal, result: reply, did: id.did, mode: 'fallback',
      hint: '当前是「手机本地规则」模式：这台手机上还没接原生执行能力，所以只能用内置规则回复。连上电脑端后，任务可以交给电脑端 Agent 真正执行。',
    };
  } catch (e: any) {
    return {
      ok: false, goal, error: String(e?.message || e).slice(0, 100), did: id.did, mode: native ? 'native' : 'fallback',
      hint: '任务没跑起来。常见原因：① 电脑端没在运行或不同网段 (设置 → 电脑端同步 里配置/测试) ② 没配 LLM API (设置 → API 配置) ③ 这台手机没接原生执行能力。',
    };
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

export default { ensureIdentity, loginIdentity, logoutIdentity, identityStatus, runLocalAgent, setAgentTransport, onAgentReply, callRemoteAgent, handleIncomingAgentMessage, notifyAgentReply, onInboundChat, setLlmConfig, getLlmConfig, runPhoneAgent, phoneStatus, cancelPhoneAgent, handleIncomingPhoneMessage, runWebAgentLoop };