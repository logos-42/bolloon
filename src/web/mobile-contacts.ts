/**
 * mobile-contacts.ts — 手机端「联系方式与授权」能力 (2026-09-19, Phase 5/10)
 *
 * 手机端负责 (leo 冻结的分工): 输入手机号/邮箱 · OTP 确认 · 生物识别/系统授权 · 展示待发内容 ·
 *   批准高风险联系 · **用设备私钥签名长期授权** · 保存本地能力副本 (只 capability, 不含明文)。
 * 桌面端负责: 长期 Goal/Run · Supervisor · 执行与恢复 · 持久化 · 证据。
 *
 * 实现要点 (为什么这样写):
 *   - **浏览器安全**: 本文件不 import 任何 node: 模块, 只用 WebCrypto / fetch / storage。
 *   - **签名规范共用**: 载荷用 `contacts/grant-payload.ts` 的规范函数 (与桌面 Node 侧同一份 → 签名一定对得上)。
 *   - **不支持 Ed25519 就明说**: 老 WebView 没 Ed25519 时返回 device_signing_unavailable,
 *     **绝不用"不签名"糊过去** (桌面本来就拒收未签名授权)。
 *   - **桌面离线不假装成功**: 授权存本地队列, capability 副本落手机, 明确告知"待桌面在线时同步"。
 */

import {
  canonicalGrantPayload, canonicalRevocationPayload, presetForChoice,
  type SignableGrant, type SignableRevocation, type GrantLevel, type GrantChannels,
} from '../agents/contacts/grant-payload.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface DeviceKeyMaterial { deviceId: string; publicKeyPem: string; privateKeyJwk: JsonWebKey }

export interface GrantSignature { deviceId: string; alg: 'ed25519'; payloadHash: string; sig: string }

export interface MobileContactsResult<T = unknown> { ok: boolean; error?: string; data?: T; queued?: boolean; note?: string }

const K_DEVICE = 'bolloon.contacts.device.v1';
const K_QUEUE = 'bolloon.contacts.queue.v1';
const K_CAPS = 'bolloon.contacts.capabilities.v1';

const cryptoOf = (c?: Crypto): Crypto | null => (c || (globalThis as any).crypto || null);

/** WebCrypto Ed25519 是否可用 (老 WebView 可能没有 —— 要如实告知, 不能糊过去) */
export function ed25519Available(c?: Crypto): boolean {
  const cobj = cryptoOf(c);
  if (!cobj?.subtle) return false;
  try {
    const alg: any = { name: 'Ed25519' };
    return typeof (cobj.subtle as any).importKey === 'function' && !!alg;
  } catch {
    return false;
  }
}

/**
 * UTF-8 字节 —— 显式拷进 ArrayBuffer: 新版 lib.dom 的 BufferSource 不接受 ArrayBufferLike,
 * 而 WebCrypto (sign/digest) 在浏览器与 Node 都要求真正的 ArrayBuffer。
 */
function bytesOf(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}
function b64(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += String.fromCharCode(arr[i]);
  return btoa(out);
}
function pemFromSpki(spki: ArrayBuffer): string {
  const b = b64(spki).replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${b}\n-----END PUBLIC KEY-----\n`;
}
async function sha256Hex(c: Crypto, text: string): Promise<string> {
  const d = await c.subtle.digest('SHA-256', bytesOf(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 取/建设备密钥 (私钥只以 JWK 存在本机 storage; 永不上传) */
export async function loadOrCreateDeviceKey(storage: StorageLike, c?: Crypto): Promise<DeviceKeyMaterial> {
  const cobj = cryptoOf(c);
  if (!cobj?.subtle) throw new Error('device_signing_unavailable: 本机没有 WebCrypto');
  const raw = storage.getItem(K_DEVICE);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DeviceKeyMaterial;
      if (parsed?.privateKeyJwk && parsed?.publicKeyPem && parsed?.deviceId) return parsed;
    } catch { /* 坏了就重建 (旧私钥丢失 → 之前签的授权在桌面仍有效, 只是不能再签新的) */ }
  }
  let pair: CryptoKeyPair;
  try {
    pair = (await cobj.subtle.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify'])) as CryptoKeyPair;
  } catch (err: any) {
    throw new Error(`device_signing_unavailable: ${String(err?.message || err)}`);
  }
  const publicKeyPem = pemFromSpki(await cobj.subtle.exportKey('spki', pair.publicKey));
  const privateKeyJwk = (await cobj.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const deviceId = `dev-${(await sha256Hex(cobj, publicKeyPem)).slice(0, 12)}`;
  const material: DeviceKeyMaterial = { deviceId, publicKeyPem, privateKeyJwk };
  storage.setItem(K_DEVICE, JSON.stringify(material));
  return material;
}

async function importPrivate(storage: StorageLike, c: Crypto): Promise<CryptoKey> {
  const k = await loadOrCreateDeviceKey(storage, c);
  return c.subtle.importKey('jwk', k.privateKeyJwk, { name: 'Ed25519' } as any, false, ['sign']);
}

/** 用设备私钥签一条 Grant (核心: 手机确认 → 桌面才认) */
export async function signGrantOnDevice(grant: SignableGrant, storage: StorageLike, c?: Crypto): Promise<GrantSignature> {
  return signPayloadOnDevice(canonicalGrantPayload(grant), storage, c);
}

/** 撤销也要签名 (桌面拒收未登记设备的撤销) */
export async function signRevocationOnDevice(rev: SignableRevocation, storage: StorageLike, c?: Crypto): Promise<GrantSignature> {
  return signPayloadOnDevice(canonicalRevocationPayload(rev), storage, c);
}

/**
 * 通用: 用**同一把设备私钥**签任意规范载荷 (2026-09-25)。
 *
 * 抽出来的原因: 手机上所有"要桌面认账"的动作 (长期授权 · 撤销 · 高风险任务动作
 * 入群/发公告/过程留痕) 必须是**同一把设备密钥 + 同一套验签纪律** ——
 * 各写一份签名实现迟早出现"某条路径没签名也能过"的缝。
 * 载荷的规范化由调用方提供 (grant-payload / mobile-task-actions), 本函数只管签。
 */
export async function signPayloadOnDevice(payload: string, storage: StorageLike, c?: Crypto): Promise<GrantSignature> {
  const cobj = cryptoOf(c);
  if (!cobj?.subtle) throw new Error('device_signing_unavailable: 本机没有 WebCrypto');
  // 只加载一次设备材料: deviceId 与签名必须来自**同一份**密钥
  // (2026-09-25 修: 之前在这里二次 loadOrCreateDeviceKey, storage 不持久化时会生成另一把密钥
  //  → 桌面 device_mismatch 403。真机 localStorage 下看不出来, 但那是运气不是设计。)
  const material = await loadOrCreateDeviceKey(storage, cobj);
  const key = await cobj.subtle.importKey('jwk', material.privateKeyJwk, { name: 'Ed25519' } as any, false, ['sign']);
  const bytes = bytesOf(String(payload ?? ''));
  const sig = await cobj.subtle.sign({ name: 'Ed25519' } as any, key, bytes as any);
  return { deviceId: material.deviceId, alg: 'ed25519', payloadHash: await sha256Hex(cobj, String(payload ?? '')), sig: b64(sig) };
}

/** sha256 hex (手机侧与桌面 Node 同值) —— 任务动作的内容摘要用它算 */
export async function sha256HexOf(text: string, c?: Crypto): Promise<string> {
  const cobj = cryptoOf(c);
  if (!cobj?.subtle) throw new Error('device_signing_unavailable: 本机没有 WebCrypto');
  return sha256Hex(cobj, String(text ?? ''));
}

/**
 * 用**已经加载好的**设备材料签名 (调用方自己拿 deviceId)。
 *
 * 为什么留这个口: 高风险任务动作的载荷里含 deviceId, 签名必须与那个 deviceId 同源。
 * 若"取 deviceId"与"签名"各调一次 loadOrCreateDeviceKey, 在 storage 不持久化的环境
 * (隐私模式 / storage 被禁) 会拿到两把不同密钥 → 桌面 device_mismatch 403。
 */
export async function signPayloadWithMaterial(payload: string, material: DeviceKeyMaterial, c?: Crypto): Promise<GrantSignature> {
  const cobj = cryptoOf(c);
  if (!cobj?.subtle) throw new Error('device_signing_unavailable: 本机没有 WebCrypto');
  const key = await cobj.subtle.importKey('jwk', material.privateKeyJwk, { name: 'Ed25519' } as any, false, ['sign']);
  const sig = await cobj.subtle.sign({ name: 'Ed25519' } as any, key, bytesOf(String(payload ?? '')) as any);
  return { deviceId: material.deviceId, alg: 'ed25519', payloadHash: await sha256Hex(cobj, String(payload ?? '')), sig: b64(sig) };
}

// ── 与桌面的 HTTP 交互 ──────────────────────────────────────────────────────

type FetchLike = (input: string, init?: any) => Promise<any>;

async function post(base: string, path: string, body: unknown, f: FetchLike): Promise<{ status: number; json: any }> {
  const res = await f(`${String(base).replace(/\/+$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, json };
}
async function get(base: string, path: string, f: FetchLike): Promise<{ status: number; json: any }> {
  const res = await f(`${String(base).replace(/\/+$/, '')}${path}`);
  let json: any = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, json };
}

/** 桌面登记手机公钥 (配对阶段; 之后桌面只接受这台设备签的授权) */
export async function registerDeviceOnDesktop(base: string, storage: StorageLike, opts: { label?: string; fetchImpl?: FetchLike; cryptoObj?: Crypto } = {}): Promise<MobileContactsResult<DeviceKeyMaterial>> {
  const f = opts.fetchImpl || (fetch as unknown as FetchLike);
  const dev = await loadOrCreateDeviceKey(storage, opts.cryptoObj);
  const r = await post(base, '/api/contacts/devices', { deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, label: opts.label || '手机' }, f);
  if (r.status !== 200 || !r.json?.ok) return { ok: false, error: `桌面未接受设备登记: ${r.json?.error || r.status}`, data: dev };
  return { ok: true, data: dev };
}

/** 本地能力副本 (只 capability, 绝不含明文/密钥) */
export interface CapabilityCopy {
  contactId: string; kind: 'phone' | 'email'; displayValue: string; verificationStatus: string;
  capabilities: string[]; provider?: string; state?: string;
}
export function saveCapabilityCopy(storage: StorageLike, items: CapabilityCopy[]): void {
  const clean = (items || []).map((c) => ({
    contactId: String(c.contactId || ''), kind: c.kind, displayValue: String(c.displayValue || ''),
    verificationStatus: String(c.verificationStatus || ''), capabilities: [...(c.capabilities || [])],
    provider: c.provider ? String(c.provider) : undefined, state: c.state ? String(c.state) : undefined,
  }));
  storage.setItem(K_CAPS, JSON.stringify(clean));
}
export function loadCapabilityCopy(storage: StorageLike): CapabilityCopy[] {
  try { const v = JSON.parse(storage.getItem(K_CAPS) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ── 离线队列 (桌面不在线时不假装成功) ────────────────────────────────────────

export interface QueuedGrant { grant: SignableGrant; signature: GrantSignature; queuedAt: string }
export function pendingQueue(storage: StorageLike): QueuedGrant[] {
  try { const v = JSON.parse(storage.getItem(K_QUEUE) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function setQueue(storage: StorageLike, q: QueuedGrant[]): void { storage.setItem(K_QUEUE, JSON.stringify(q.slice(-20))); }

/** 桌面在线时把排队中的授权补同步上去 */
export async function flushQueuedGrants(base: string, storage: StorageLike, opts: { fetchImpl?: FetchLike } = {}): Promise<{ sent: number; failed: number; results: any[] }> {
  const f = opts.fetchImpl || (fetch as unknown as FetchLike);
  const q = pendingQueue(storage);
  const keep: QueuedGrant[] = [];
  const results: any[] = [];
  let sent = 0, failed = 0;
  for (const item of q) {
    try {
      const r = await post(base, '/api/contacts/grants/sync', { grant: { ...item.grant, signature: item.signature } }, f);
      if (r.status === 200 && r.json?.ok) { sent++; results.push({ grantId: item.grant.grantId, ok: true }); continue; }
      failed++; keep.push(item);
      results.push({ grantId: item.grant.grantId, ok: false, error: r.json?.code || r.status });
    } catch { failed++; keep.push(item); results.push({ grantId: item.grant.grantId, ok: false, error: 'network' }); }
  }
  setQueue(storage, keep);
  return { sent, failed, results };
}

// ── 用户动作: 授权 / 撤销 / 批准 ────────────────────────────────────────────

export interface AuthorizeInput {
  base: string;
  choice: 'task_once' | 'persistent' | 'full_contact_access';
  ownerDid: string;
  identityId?: string;
  storage: StorageLike;
  fetchImpl?: FetchLike;
  cryptoObj?: Crypto;
  grantedBy?: string;
}

/**
 * 手机确认授权 → 设备签名 → 送桌面验签。
 * 桌面离线时: 授权进本地队列 + 返回 queued=true (明确告诉用户"等桌面在线时同步", 不假装已生效)。
 */
export async function authorizeFromPhone(input: AuthorizeInput): Promise<MobileContactsResult<{ grantId: string; level: GrantLevel; signature: GrantSignature }>> {
  const c = cryptoOf(input.cryptoObj);
  if (!ed25519Available(c || undefined)) {
    return { ok: false, error: 'device_signing_unavailable: 本机 WebView 不支持 Ed25519 设备签名 —— 请在桌面端授权 (或升级系统 WebView)' };
  }
  const dev = await loadOrCreateDeviceKey(input.storage, c!);
  const preset = presetForChoice(input.choice);
  const grant: SignableGrant = {
    grantId: `gr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    identityId: input.identityId || `sid-phone-${dev.deviceId.slice(-6)}`,
    ownerDid: input.ownerDid,
    ...preset,
    grantedAt: new Date().toISOString(),
    grantedBy: input.grantedBy || 'leo',
    grantedVia: 'mobile',
    deviceIds: [dev.deviceId],
    status: 'active',
    grantVersion: 1,
  };
  const signature = await signGrantOnDevice(grant, input.storage, c!);

  const f = input.fetchImpl || (fetch as unknown as FetchLike);
  // 先登记设备 (幂等), 再送授权
  const reg = await registerDeviceOnDesktop(input.base, input.storage, { fetchImpl: f, cryptoObj: c! }).catch(() => ({ ok: false } as any));
  if (!reg.ok) {
    const q = pendingQueue(input.storage);
    q.push({ grant, signature, queuedAt: new Date().toISOString() });
    setQueue(input.storage, q);
    return { ok: false, queued: true, error: `桌面暂不可达 → 授权已存在手机, 待桌面在线时自动同步 (${(reg as any).error || 'offline'})`,
      data: { grantId: grant.grantId, level: grant.level, signature },
      note: '桌面不在线时不假装已生效: 授权在本地队列里, 桌面一上线就补同步' };
  }
  const r = await post(input.base, '/api/contacts/grants/sync', { grant: { ...grant, signature } }, f);
  if (r.status === 200 && r.json?.ok) {
    return { ok: true, data: { grantId: grant.grantId, level: grant.level, signature }, note: '桌面已验签接受' };
  }
  const q = pendingQueue(input.storage);
  q.push({ grant, signature, queuedAt: new Date().toISOString() });
  setQueue(input.storage, q);
  return { ok: false, queued: true, error: `桌面拒绝/未接受: ${r.json?.code || r.json?.reason || r.status}`,
    data: { grantId: grant.grantId, level: grant.level, signature },
    note: '已保存在手机本地队列 (不会因为失败就当成已授权)' };
}

export async function revokeFromPhone(opts: { base: string; grantId: string; storage: StorageLike; reason?: string; version?: number; fetchImpl?: FetchLike; cryptoObj?: Crypto }): Promise<MobileContactsResult<{ grantId: string }>> {
  const c = cryptoOf(opts.cryptoObj);
  if (!ed25519Available(c || undefined)) return { ok: false, error: 'device_signing_unavailable: 本机不支持设备签名, 撤销需在桌面端进行' };
  const revokedAt = new Date().toISOString();
  const payload: SignableRevocation = { grantId: opts.grantId, grantVersion: opts.version || 1, revokedAt, by: 'mobile' };
  const signature = await signRevocationOnDevice(payload, opts.storage, c!);
  const f = opts.fetchImpl || (fetch as unknown as FetchLike);
  const r = await post(opts.base, '/api/contacts/grants/revoke-sync', { grantId: opts.grantId, by: 'mobile', reason: opts.reason, version: payload.grantVersion, revokedAt, signature }, f);
  if (r.status === 200 && r.json?.ok) return { ok: true, data: { grantId: opts.grantId }, note: '桌面已验签并立即失效' };
  return { ok: false, error: `撤销未送达: ${r.json?.code || r.json?.error || r.status}`, note: '桌面不在线时撤销**不会**被当作已完成 —— 请在桌面在线后重试 (或桌面端撤销)' };
}

export interface DesktopContactsView {
  contacts: any[];
  grants: any[];
  effective: string;
  approvals: any[];
  waiting: any[];
}

/** 从桌面读联系方式/授权/待批准 (桌面离线 → 退回手机本地 capability 副本, 明确标注) */
export async function loadFromDesktop(base: string | null, storage: StorageLike, opts: { fetchImpl?: FetchLike } = {}): Promise<MobileContactsResult<DesktopContactsView>> {
  const f = opts.fetchImpl || (fetch as unknown as FetchLike);
  if (!base) {
    const caps = loadCapabilityCopy(storage);
    return { ok: false, error: 'desktop_offline', data: { contacts: caps, grants: [], effective: '桌面不在线 (显示手机本地副本)', approvals: [], waiting: [] },
      note: '以下是你手机上保存的能力副本 (不是桌面实时状态)' };
  }
  try {
    const a = await get(base, '/api/contacts', f);
    const b = await get(base, '/api/contacts/grants', f);
    if (a.status !== 200 && b.status !== 200) return { ok: false, error: `desktop_http_${a.status || b.status}` };
    const view: DesktopContactsView = {
      contacts: a.json?.contacts || [], grants: b.json?.grants || [], effective: b.json?.effective || '',
      approvals: a.json?.approvals || [], waiting: a.json?.waiting || [],
    };
    saveCapabilityCopy(storage, (view.contacts || []).filter((c: any) => c.capabilities?.includes('send')).map((c: any) => ({
      contactId: c.contactId, kind: c.kind, displayValue: c.displayValue, verificationStatus: c.status,
      capabilities: c.capabilities, provider: c.provider, state: c.status,
    })));
    return { ok: true, data: view };
  } catch (err: any) {
    const caps = loadCapabilityCopy(storage);
    return { ok: false, error: 'desktop_offline', data: { contacts: caps, grants: [], effective: '桌面不在线 (显示手机本地副本)', approvals: [], waiting: [] },
      note: `连不上桌面 (${String(err?.message || err).slice(0, 60)}) —— 显示本地副本` };
  }
}

/** 绑定/验证 (手机上输入, 桌面执行 —— 明文只走这一条 HTTPS/局域网请求, 不落手机存储) */
export async function bindFromPhone(base: string | null, opts: { kind: 'phone' | 'email'; value: string; region?: string }, storage: StorageLike, f?: FetchLike): Promise<MobileContactsResult<any>> {
  const impl = f || (fetch as unknown as FetchLike);
  if (!base) return { ok: false, error: 'desktop_offline: 绑定需要桌面端在线 (桌面负责落盘与验证码通道)' };
  const r = await post(base, '/api/contacts/bind', { kind: opts.kind, value: opts.value, region: opts.region }, impl);
  if (r.status === 200 && r.json?.ok) return { ok: true, data: r.json };
  return { ok: false, error: r.json?.error || `HTTP ${r.status}` };
}

export async function verifyFromPhone(base: string | null, opts: { contactId: string; challengeId: string; code: string }, storage: StorageLike, f?: FetchLike): Promise<MobileContactsResult<any>> {
  const impl = f || (fetch as unknown as FetchLike);
  if (!base) return { ok: false, error: 'desktop_offline: 验证需要桌面端在线' };
  const r = await post(base, '/api/contacts/verify', { contactId: opts.contactId, challengeId: opts.challengeId, code: opts.code }, impl);
  if (r.status === 200 && r.json?.ok) return { ok: true, data: r.json };
  return { ok: false, error: r.json?.error || `HTTP ${r.status}` };
}

/** 手机上批准高风险联系 (展示待发内容 → 批准/拒绝) */
export async function decideApprovalFromPhone(base: string | null, opts: { consentId: string; action: 'approve' | 'reject'; body?: string; reason?: string }, f?: FetchLike): Promise<MobileContactsResult<any>> {
  const impl = f || (fetch as unknown as FetchLike);
  if (!base) return { ok: false, error: 'desktop_offline: 批准需要桌面端在线 (手机不在线时不会假装已批准)' };
  const r = await post(base, `/api/contacts/approvals/${encodeURIComponent(opts.consentId)}/${opts.action}`, { by: 'leo', via: 'mobile', body: opts.body, reason: opts.reason }, impl);
  if (r.status === 200 && r.json?.ok) return { ok: true, data: r.json };
  return { ok: false, error: r.json?.error || `HTTP ${r.status}` };
}

/** 手机端摘要卡数据 (给 mobile.js 直接渲染) */
export interface PhoneCardView {
  title: string;
  effective: string;
  contacts: Array<{ displayValue: string; kind: string; state: string; label: string }>;
  approvals: Array<{ consentId: string; contactName: string; channel: string; subject?: string; bodyPreview: string; reason: string; reallySent: boolean }>;
  choices: Array<{ id: string; label: string }>;
  willNotGet: string[];
  deviceSigning: boolean;
}

export function buildPhoneCard(view: DesktopContactsView | null, opts: { deviceSigning: boolean; offline?: string }): PhoneCardView {
  return {
    title: '让 Bolloon 代表你联系外部的人',
    effective: view?.effective || opts.offline || '未知',
    contacts: (view?.contacts || []).map((c: any) => ({
      displayValue: c.displayValue || '', kind: c.kind || '', state: c.status || c.verificationStatus || '',
      label: c.capabilities?.includes('send') ? '可联系' : '不可联系',
    })),
    approvals: (view?.approvals || []).map((a: any) => ({
      consentId: a.consentId, contactName: a.contactName, channel: a.channel, subject: a.subject,
      bodyPreview: a.bodyPreview || '', reason: a.reason, reallySent: !!a.reallySent,
    })),
    choices: [
      { id: 'task_once', label: '仅本次任务' },
      { id: 'persistent', label: '长期使用 (推荐)' },
      { id: 'full_contact_access', label: '完全授权联系方式能力' },
    ],
    willNotGet: ['读取全部邮箱', '读取通讯录', '群发消息', '自动支付/转账', '代表你签署合同', '拿到手机号/邮箱明文'],
    deviceSigning: opts.deviceSigning,
  };
}
