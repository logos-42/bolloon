/**
 * mobile-ipfs.ts — 手机端 (WebView / Capacitor) 独立 IPFS 模块 (2026-09-11)
 *
 * 目标: 手机端不依赖电脑端就能用 IPFS ——
 *   1) 本地确定性算 CID / 验 CID   → 协议 PROOF 阶段 (结果哈希进交易记录 / agent registry)
 *   2) 读写远端 IPFS               → 协议 资源存储阶段 (agent 结果 / 附件 / 产物外存)
 *   3) 公共网关回退 (多网关逐个尝试) → 资源读取阶段的可用性兜底
 *   4) 本地缓存 (网关首次拉取后落本地) → 二次读取零网络, 离线可读
 *
 * ─────────────────── 为什么没有直接 import @diap/sdk 的 IpfsClient ───────────────────
 * 任务要求优先用用户自己的协议 SDK。实测 (2026-09-11, esbuild --platform=browser):
 *   - `import { IpfsClient } from '@diap/sdk'` → 6/34 errors:
 *       dist/key-manager.js import 'fs' / 'path'
 *       dist/config-manager.js import 'fs'
 *       dist/libp2p/encrypted-peer-id.js import 'node:crypto'
 *       dist/ipfs-setup.js 动态 import('fs') / ('path')
 *     → barrel 整条链都是 node-only, 浏览器 bundle 直接报 "Could not resolve \"fs\""。
 *   - 退一步只 import 子路径 `@diap/sdk/dist/ipfs-client.js` **同样失败**:
 *       ipfs-client.js → ./utils/logger.js → winston
 *       而 winston 的 browser 字段 (./dist/winston) 里 dist/winston/transports/console.js 仍
 *       require('os'), winston-transport 仍 require('util') → 4 个 "Could not resolve" 错误。
 * 结论: 在手机端 bundle 里 import IpfsClient 必然拖进 node 内置模块。
 * 因此本模块 **自实现等价 HTTP 调用** (IPFS HTTP API POST /api/v0/add 上传 + 网关 GET /ipfs/<cid> 读取),
 * 并把类签名 **与 SDK 的 IpfsClient 对齐**: newPublicOnly / newWithRemoteNode / newWithPinata /
 * upload / get / getApiUrl / getGatewayUrl —— 便于在能加载 SDK 的环境 (Node / Electron / 服务端)
 * 一键换回真 SDK: ipfsUpload / ipfsFetch 的可选 `client` 参数直接传 `new IpfsClient(...)` 实例
 * (此时 provider / from 记为 'diap-sdk'), 本模块代码零改动。
 *
 * 浏览器安全: 不 import 任何 node 内置模块 (fs/path/os/crypto/stream 全无)。
 *   网络走可注入 fetchImpl (默认 globalThis.fetch);
 *   存储走可注入 storage (默认 localStorage, 取不到时内存兜底);
 *   CID 计算用 multiformats + @ipld/dag-cbor (纯 JS, 与桌面端 src/orbitdb/cid-database.ts
 *   contentToCid() 语义完全一致: dag-cbor encode + sha2-256 + CID v1 codec 0x71)。
 * 全部导出函数失败一律返回 `{ ok:false, error }`, 永不抛。
 */

import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';

// ─────────────────────────── 通用类型 / 工具 ───────────────────────────

/** 可注入的最小 fetch 形状 (只用到我们需要的字段) */
export interface FetchResponseLike {
  ok: boolean;
  status?: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** 可注入网络实现; 默认 globalThis.fetch */
export type FetchLike = (url: string, init?: unknown) => Promise<FetchResponseLike>;

/** 可注入存储; localStorage / Storage / 内存实现都满足 */
export interface IpfsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

const errMsg = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/** CID 规范化: 去掉 ipfs:// / /ipfs/ 前缀、尾斜杠与首尾空白 (容错链上 / 网关 / URL 回传的写法) */
export function normalizeCid(cid: string): string {
  if (typeof cid !== 'string') return '';
  let s = cid.trim();
  if (s.startsWith('ipfs://')) s = s.slice('ipfs://'.length);
  s = s.replace(/^\/?ipfs\//, '');
  return s.replace(/\/+$/, '').trim();
}

/** 内存存储 (测试 / 无 localStorage 环境兜底) */
export function createMemoryStorage(): IpfsStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

let _memStorage: IpfsStorage | null = null;

/** 默认存储: localStorage (可用时) → 内存兜底 (Safari 隐私模式 / SSR / 测试) */
export function defaultStorage(): IpfsStorage {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const probe = '__bolloon_ipfs_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* localStorage 被禁用 (抛异常) → 内存兜底 */
  }
  if (!_memStorage) _memStorage = createMemoryStorage();
  return _memStorage;
}

/** 按 UTF-8 计字节数 (缓存上限用) */
function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

/**
 * JSON 语义清洗 — 与桌面端 cid-database.ts `JSON.parse(JSON.stringify(obj))` 保持一致:
 * 丢 undefined / 函数 / symbol, Date → ISO 字符串, NaN/Infinity → null, -0 → 0,
 * Uint8Array → 索引 map (与桌面端同构, 保证手机端与电脑端同内容同 CID)。
 * 差异: 本函数对循环引用替换为 '[Circular]' 且永不抛 (桌面端会抛)。
 */
export function jsonClean(value: unknown): unknown {
  try {
    const s = JSON.stringify(value, circularReplacer());
    if (typeof s === 'undefined') return null; // 与桌面端兜底: undefined 顶层值
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

function circularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      const obj = value as object;
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);
    }
    return value;
  };
}

// ─────────────────────────── CID 计算 / 校验 (PROOF 阶段) ───────────────────────────

/**
 * 内容 → 确定性 CID。dag-cbor 会按规范对 map 键排序, 所以 **键序无关**、同内容同 CID。
 * 返回 Promises<string>。永不抛: 极端输入由 jsonClean 兜底为 null。
 */
export async function computeCid(obj: unknown): Promise<string> {
  const cleaned = jsonClean(obj);
  const bytes = dagCbor.encode(cleaned as Record<string, unknown>);
  const hash = await sha256.digest(bytes);
  return CID.createV1(0x71, hash).toString();
}

/** 文本 → 确定性 CID (纯文本场景, 例如协议里的 content/摘要字段) */
export async function cidFromText(text: string): Promise<string> {
  return computeCid(String(text));
}

export interface VerifyResult {
  /** 校验流程是否成功执行 (算得出来) */
  ok: boolean;
  /** 重算 CID 与给定 CID 是否一致 */
  match: boolean;
  /** 规范化后的期望 CID */
  expected?: string;
  /** 重算得到的 CID */
  actual?: string;
  error?: string;
}

/**
 * 验 CID: 重算并比对 (PROOF 阶段用 —— 拿交易记录/registry 里的 resultCid 与重算值对账)。
 * objOrText 为 string → 按文本算; 否则按对象算。永不抛。
 */
export async function verifyContent(cid: string, objOrText: unknown): Promise<VerifyResult> {
  const expected = normalizeCid(cid);
  if (!expected) return { ok: false, match: false, error: 'cid 不能为空' };
  try {
    const actual = typeof objOrText === 'string' ? await cidFromText(objOrText) : await computeCid(objOrText);
    return { ok: true, match: actual === expected, expected, actual };
  } catch (err) {
    return { ok: false, match: false, expected, error: errMsg(err) };
  }
}

/**
 * Agent 执行结果 → CID (PROOF 阶段: 结果 CID 进交易记录 / agent registry)。
 * 规范化 = jsonClean (丢 undefined、键序无关), 保证同一结果在同一设备/跨设备算得同一 CID。
 * 注意: 结果里若含 wall-clock 时间戳 / 随机数等易变字段, 请调用方先剔除 —— 它们会让 CID 每次不同。
 * 永不抛 (极端情况退化为错误描述对象的 CID)。
 */
export async function resultCid(result: unknown): Promise<string> {
  try {
    return await computeCid(result);
  } catch (err) {
    try {
      return await computeCid({ __unhashedResult: errMsg(err) });
    } catch {
      // 最后兜底: 连错误描述都算不出来时返回空串 (不抛)
      return '';
    }
  }
}

// ─────────────────────────── 配置 (可注入存储) ───────────────────────────

export type IpfsMode = 'public' | 'remote' | 'pinata';

export interface IpfsConfig {
  /** public: 只用公共网关 (读为主); remote: 自建/远端 IPFS HTTP API; pinata: Pinata 托管上传 */
  mode: IpfsMode;
  /** mode=remote 时的 IPFS HTTP API 地址, 如 http://127.0.0.1:5001 */
  apiUrl?: string;
  /** mode=remote 时的读网关地址 */
  gatewayUrl?: string;
  /** mode=pinata 的 Pinata API Key */
  pinataKey?: string;
  /** mode=pinata 的 Pinata API Secret */
  pinataSecret?: string;
  /** 读网关列表 (按顺序回退); 不设则用 DEFAULT_GATEWAYS */
  gateways?: string[];
}

export const IPFS_CONFIG_KEY = 'bolloon_ipfs_config';

export const DEFAULT_GATEWAYS: readonly string[] = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://cloudflare-ipfs.com',
];

export const DEFAULT_IPFS_CONFIG: IpfsConfig = {
  mode: 'public',
  gateways: [...DEFAULT_GATEWAYS],
};

const VALID_MODES: readonly IpfsMode[] = ['public', 'remote', 'pinata'];

/**
 * 读配置 (默认 mode='public' + 三个公共网关)。存储损坏 / 缺字段一律回落到默认值, 永不抛。
 */
export function getIpfsConfig(storage: IpfsStorage = defaultStorage()): IpfsConfig {
  const base: IpfsConfig = { mode: 'public', gateways: [...DEFAULT_GATEWAYS] };
  try {
    const raw = storage.getItem(IPFS_CONFIG_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<IpfsConfig> | null;
    if (!parsed || typeof parsed !== 'object') return base;
    const mode = VALID_MODES.includes(parsed.mode as IpfsMode) ? (parsed.mode as IpfsMode) : 'public';
    const gateways =
      Array.isArray(parsed.gateways) && parsed.gateways.filter((g) => typeof g === 'string' && g).length > 0
        ? (parsed.gateways.filter((g) => typeof g === 'string' && g) as string[])
        : [...DEFAULT_GATEWAYS];
    const cfg: IpfsConfig = { mode, gateways };
    if (typeof parsed.apiUrl === 'string') cfg.apiUrl = parsed.apiUrl;
    if (typeof parsed.gatewayUrl === 'string') cfg.gatewayUrl = parsed.gatewayUrl;
    if (typeof parsed.pinataKey === 'string') cfg.pinataKey = parsed.pinataKey;
    if (typeof parsed.pinataSecret === 'string') cfg.pinataSecret = parsed.pinataSecret;
    return cfg;
  } catch {
    return base;
  }
}

export interface SetConfigResult extends OpResult {
  config?: IpfsConfig;
}

/**
 * 写配置 (与现有配置合并, 支持只改 mode)。返回 { ok, config } 或 { ok:false, error }。永不抛。
 */
export function setIpfsConfig(cfg: Partial<IpfsConfig>, storage: IpfsStorage = defaultStorage()): SetConfigResult {
  try {
    if (cfg.mode !== undefined && !VALID_MODES.includes(cfg.mode)) {
      return { ok: false, error: `非法 mode: ${String(cfg.mode)} (应为 public|remote|pinata)` };
    }
    const merged: IpfsConfig = { ...getIpfsConfig(storage), ...cfg };
    if (cfg.gateways !== undefined) {
      const gs = (cfg.gateways || []).filter((g) => typeof g === 'string' && g);
      merged.gateways = gs.length > 0 ? gs : [...DEFAULT_GATEWAYS];
    }
    // 只存有效字段 (undefined 不入 JSON)
    const clean: IpfsConfig = { mode: merged.mode, gateways: merged.gateways };
    if (merged.apiUrl) clean.apiUrl = merged.apiUrl;
    if (merged.gatewayUrl) clean.gatewayUrl = merged.gatewayUrl;
    if (merged.pinataKey) clean.pinataKey = merged.pinataKey;
    if (merged.pinataSecret) clean.pinataSecret = merged.pinataSecret;
    storage.setItem(IPFS_CONFIG_KEY, JSON.stringify(clean));
    return { ok: true, config: clean };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ─────────────────────────── 本地缓存 (资源存储阶段 · 离线读) ───────────────────────────

export const IPFS_CACHE_INDEX_KEY = 'bolloon_ipfs_cache_index';
export const IPFS_CACHE_PREFIX = 'bolloon_ipfs_cache:';
/** 最多缓存条数 */
export const IPFS_CACHE_MAX_ENTRIES = 50;
/** 缓存总字节上限 (2MB) */
export const IPFS_CACHE_MAX_BYTES = 2 * 1024 * 1024;

interface CacheIndexEntry {
  c: string; // cid
  s: number; // 字节数
}

function readIndex(storage: IpfsStorage): CacheIndexEntry[] {
  try {
    const raw = storage.getItem(IPFS_CACHE_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is CacheIndexEntry => !!e && typeof (e as CacheIndexEntry).c === 'string')
      .map((e) => ({ c: e.c, s: typeof e.s === 'number' ? e.s : 0 }));
  } catch {
    return [];
  }
}

function writeIndex(storage: IpfsStorage, list: CacheIndexEntry[]): void {
  storage.setItem(IPFS_CACHE_INDEX_KEY, JSON.stringify(list));
}

/** LRU 淘汰: 超条数或超总字节 → 从最旧 (数组头部) 开始删 */
function evictIndex(storage: IpfsStorage, list: CacheIndexEntry[]): CacheIndexEntry[] {
  const kept = [...list];
  const total = (): number => kept.reduce((n, e) => n + e.s, 0);
  while (kept.length > IPFS_CACHE_MAX_ENTRIES || total() > IPFS_CACHE_MAX_BYTES) {
    const oldest = kept.shift();
    if (!oldest) break;
    try {
      storage.removeItem?.(IPFS_CACHE_PREFIX + oldest.c);
    } catch {
      /* 忽略单条删除失败 */
    }
  }
  return kept;
}

/** 读缓存; 未命中返回 null。永不抛。命中会刷新 LRU 顺序。 */
export function ipfsCacheGet(cid: string, storage: IpfsStorage = defaultStorage()): string | null {
  try {
    const key = normalizeCid(cid);
    if (!key) return null;
    const raw = storage.getItem(IPFS_CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { text?: unknown } | null;
    if (!entry || typeof entry.text !== 'string') return null;
    // LRU 刷新: 命中项移到末尾 (最新)
    const idx = readIndex(storage);
    const pos = idx.findIndex((e) => e.c === key);
    if (pos >= 0 && pos !== idx.length - 1) {
      const [hit] = idx.splice(pos, 1);
      idx.push(hit);
      writeIndex(storage, idx);
    }
    return entry.text;
  } catch {
    return null;
  }
}

export interface CacheSetResult extends OpResult {
  size?: number;
}

/**
 * 写缓存 (含上限保护: 最多 50 条 / 总计 2MB, 超出按 LRU 淘汰)。
 * 单条超过总上限 → 拒绝缓存并返回原因。永不抛。
 */
export function ipfsCacheSet(cid: string, text: string, storage: IpfsStorage = defaultStorage()): CacheSetResult {
  try {
    const key = normalizeCid(cid);
    if (!key) return { ok: false, error: 'cid 不能为空' };
    if (typeof text !== 'string') return { ok: false, error: 'text 必须是字符串' };
    const size = byteLength(text);
    if (size > IPFS_CACHE_MAX_BYTES) {
      return { ok: false, error: `内容过大 (${size} 字节 > 上限 ${IPFS_CACHE_MAX_BYTES}), 不缓存` };
    }
    storage.setItem(IPFS_CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), s: size, text }));
    const idx = readIndex(storage).filter((e) => e.c !== key);
    idx.push({ c: key, s: size });
    writeIndex(storage, evictIndex(storage, idx));
    return { ok: true, size };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ─────────────────────────── IPFS 客户端 (SDK IpfsClient 的浏览器安全等价物) ───────────────────────────

/** 与 @diap/sdk 的 IpfsUploadResult 同形 */
export interface IpfsUploadResult {
  cid: string;
  size: number;
  uploadedAt: string;
  provider: string;
}

/** @diap/sdk IpfsClient 中本模块用到的方法子集 (真 SDK 实例可直接注入, 见 ipfsUpload/ipfsFetch 的 client 参数) */
export interface IpfsClientLike {
  upload(content: string, name?: string): Promise<IpfsUploadResult>;
  get(cid: string): Promise<string>;
}

export const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

const timeoutSignal = (ms: number, outer?: unknown): { signal: AbortSignal | undefined; done: () => void } => {
  const ABORT: typeof AbortController | undefined =
    typeof AbortController !== 'undefined' ? AbortController : undefined;
  if (!ABORT || typeof setTimeout === 'undefined') return { signal: undefined, done: () => undefined };
  const ctrl = new ABORT();
  const timer = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      /* 忽略 */
    }
  }, ms);
  return {
    signal: (outer as AbortSignal | undefined) ?? ctrl.signal,
    done: () => clearTimeout(timer),
  };
};

/**
 * 浏览器安全的 IPFS HTTP 客户端 —— 签名对齐 @diap/sdk 的 IpfsClient:
 *   IpfsClient.newPublicOnly(timeoutSec)                     / newWithRemoteNode(apiUrl, gatewayUrl, timeoutSec)
 *   IpfsClient.newWithPinata(apiKey, apiSecret, timeoutSec)  / upload(content, name) / get(cid)
 * 与 SDK 的差异: 多一个可选 fetchImpl (网络可注入, 测试/代理需要), 且不打印 winston 日志。
 * 上传: POST {apiUrl}/api/v0/add?pin=true (multipart) 或 Pinata pinJSONToIPFS。
 * 读取: GET {gateway}/ipfs/{cid}, 配置网关失败后依次试公共网关。
 * 该类的方法会 throw (与 SDK 一致), 公开导出函数 (ipfsUpload/ipfsFetch) 会捕获它, 对外永不抛。
 */
export class BolloonIpfsClient implements IpfsClientLike {
  private readonly apiUrl: string | null;
  private readonly gatewayUrl: string | null;
  private readonly pinataKey: string | null;
  private readonly pinataSecret: string | null;
  private readonly timeout: number;
  private readonly publicGateways: string[];
  private readonly fetchImpl: FetchLike | null;

  constructor(
    apiUrl?: string | null,
    gatewayUrl?: string | null,
    pinataApiKey?: string | null,
    pinataApiSecret?: string | null,
    timeoutSeconds = 30,
    fetchImpl?: FetchLike,
    publicGateways: string[] = [...DEFAULT_GATEWAYS],
  ) {
    this.apiUrl = apiUrl || null;
    this.gatewayUrl = gatewayUrl || null;
    this.pinataKey = pinataApiKey || null;
    this.pinataSecret = pinataApiSecret || null;
    this.timeout = Math.max(1, timeoutSeconds) * 1000;
    this.publicGateways = publicGateways.length > 0 ? publicGateways : [...DEFAULT_GATEWAYS];
    this.fetchImpl = fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : null);
  }

  /** 只用公共网关 (读为主) — 与 SDK 同名同参 */
  static async newPublicOnly(timeoutSeconds = 30, fetchImpl?: FetchLike): Promise<BolloonIpfsClient> {
    return new BolloonIpfsClient(null, null, null, null, timeoutSeconds, fetchImpl);
  }

  /** 用远端 IPFS HTTP API — 与 SDK 同名同参 */
  static async newWithRemoteNode(
    apiUrl: string,
    gatewayUrl: string,
    timeoutSeconds = 30,
    fetchImpl?: FetchLike,
  ): Promise<BolloonIpfsClient> {
    return new BolloonIpfsClient(apiUrl, gatewayUrl, null, null, timeoutSeconds, fetchImpl);
  }

  /** 用 Pinata 托管 — 与 SDK 同名同参 */
  static async newWithPinata(
    apiKey: string,
    apiSecret: string,
    timeoutSeconds = 30,
    fetchImpl?: FetchLike,
  ): Promise<BolloonIpfsClient> {
    return new BolloonIpfsClient(null, null, apiKey, apiSecret, timeoutSeconds, fetchImpl);
  }

  getApiUrl(): string | null {
    return this.apiUrl;
  }

  getGatewayUrl(): string | null {
    return this.gatewayUrl;
  }

  /** 上传内容 (资源存储阶段)。无可用通道时 throw (由上层包装成 {ok:false})。 */
  async upload(content: string, name = 'data'): Promise<IpfsUploadResult> {
    if (this.apiUrl) return this.uploadToRemoteApi(content, name);
    if (this.pinataKey && this.pinataSecret) return this.uploadToPinata(content, name);
    throw new Error('未配置任何 IPFS 上传方式: 缺少远程 API 地址或 Pinata 凭据');
  }

  private async uploadToRemoteApi(content: string, name: string): Promise<IpfsUploadResult> {
    if (!this.fetchImpl) throw new Error('当前环境没有 fetch, 无法上传 (请注入 fetchImpl)');
    const url = `${this.apiUrl}/api/v0/add?pin=true`;
    const { signal, done } = timeoutSignal(this.timeout);
    try {
      // 优先 multipart (与 SDK 一致); 环境无 FormData/Blob 时退化为原始 body
      let body: unknown = content;
      const headers: Record<string, string> = { 'User-Agent': 'bolloon-mobile-ipfs/1.0' };
      if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
        const form = new FormData();
        form.append('file', new Blob([content], { type: 'application/json' }), name);
        body = form;
      } else {
        headers['Content-Type'] = 'application/json';
      }
      const res = await this.fetchImpl(url, { method: 'POST', body, headers, signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`上传失败: ${res.status ?? '?'} - ${String(errText).slice(0, 200)}`);
      }
      const result = (await res.json()) as { Hash?: string; Size?: string | number } | null;
      const cid = result?.Hash;
      if (!cid) throw new Error('IPFS 响应中缺少 Hash 字段');
      const size = result?.Size !== undefined ? Number(result.Size) : byteLength(content);
      return { cid, size: Number.isFinite(size) ? size : byteLength(content), uploadedAt: new Date().toISOString(), provider: 'remote_api' };
    } catch (err) {
      // 网络层异常也要带上"上传"语义, 便于 UI 直接展示
      const m = errMsg(err);
      throw new Error(/上传请求失败|上传失败/.test(m) ? m : `上传请求失败: ${url} (${m})`);
    } finally {
      done();
    }
  }

  private async uploadToPinata(content: string, name: string): Promise<IpfsUploadResult> {
    if (!this.fetchImpl) throw new Error('当前环境没有 fetch, 无法上传 (请注入 fetchImpl)');
    let jsonContent: unknown;
    try {
      jsonContent = JSON.parse(content);
    } catch {
      jsonContent = { data: content };
    }
    const body = JSON.stringify({
      pinataContent: jsonContent,
      pinataMetadata: { name, keyvalues: { type: 'bolloon-agent-result', uploaded_by: 'bolloon-mobile-ipfs' } },
    });
    const { signal, done } = timeoutSignal(this.timeout);
    try {
      const res = await this.fetchImpl(PINATA_PIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: this.pinataKey as string,
          pinata_secret_api_key: this.pinataSecret as string,
        },
        body,
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Pinata 返回错误 ${res.status ?? '?'}: ${String(errText).slice(0, 200)}`);
      }
      const out = (await res.json()) as { IpfsHash?: string; PinSize?: number } | null;
      if (!out?.IpfsHash) throw new Error('Pinata 响应中缺少 IpfsHash 字段');
      return {
        cid: out.IpfsHash,
        size: typeof out.PinSize === 'number' ? out.PinSize : byteLength(content),
        uploadedAt: new Date().toISOString(),
        provider: 'Pinata',
      };
    } catch (err) {
      const m = errMsg(err);
      throw new Error(/Pinata 上传请求失败|Pinata 返回错误/.test(m) ? m : `Pinata 上传请求失败 (${m})`);
    } finally {
      done();
    }
  }

  /** 读取内容 (资源读取阶段): 配置网关 → 公共网关依次回退, 全失败 throw。 */
  async get(cid: string): Promise<string> {
    const key = normalizeCid(cid);
    if (!key) throw new Error('cid 不能为空');
    const tried: string[] = [];
    const candidates = [...(this.gatewayUrl ? [this.gatewayUrl] : []), ...this.publicGateways];
    for (const gw of candidates) {
      try {
        return await this.getFromGateway(gw, key);
      } catch (err) {
        tried.push(`${gw}: ${errMsg(err)}`);
      }
    }
    throw new Error(`无法从任何网关获取内容 (${tried.join(' | ')})`);
  }

  private async getFromGateway(gatewayUrl: string, cid: string): Promise<string> {
    if (!this.fetchImpl) throw new Error('当前环境没有 fetch, 无法读取 (请注入 fetchImpl)');
    const url = `${gatewayUrl.replace(/\/+$/, '')}/ipfs/${cid}`;
    const { signal, done } = timeoutSignal(this.timeout);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: { 'User-Agent': 'bolloon-mobile-ipfs/1.0' }, signal });
      if (!res.ok) throw new Error(`网关返回错误: ${res.status ?? '?'}`);
      return await res.text();
    } finally {
      done();
    }
  }
}

/** 按配置造一个等价客户端; 配置不足返回 null (不抛) */
export function createIpfsClient(
  config: IpfsConfig,
  opts: { fetchImpl?: FetchLike; timeoutSec?: number } = {},
): BolloonIpfsClient | null {
  try {
    const t = opts.timeoutSec ?? 30;
    const gateways = config.gateways && config.gateways.length > 0 ? config.gateways : [...DEFAULT_GATEWAYS];
    if (config.mode === 'remote' && config.apiUrl) {
      return new BolloonIpfsClient(config.apiUrl, config.gatewayUrl ?? gateways[0], null, null, t, opts.fetchImpl, gateways);
    }
    if (config.mode === 'pinata' && config.pinataKey && config.pinataSecret) {
      return new BolloonIpfsClient(null, null, config.pinataKey, config.pinataSecret, t, opts.fetchImpl, gateways);
    }
    if (config.mode === 'public') {
      // public 只读为主; 若同时配了 Pinata 凭据, 允许走 Pinata 上传 (见 ipfsUpload)
      return new BolloonIpfsClient(null, config.gatewayUrl ?? null, null, null, t, opts.fetchImpl, gateways);
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────── 对外 API: 上传 / 读取 ───────────────────────────

export interface IpfsUploadOpts {
  config?: IpfsConfig;
  fetchImpl?: FetchLike;
  storage?: IpfsStorage;
  /** 注入真 SDK 的 IpfsClient 实例 (或任何同形对象) → 优先使用, provider 记为 'diap-sdk' */
  client?: IpfsClientLike;
  timeoutSec?: number;
}

export type IpfsUploadRes =
  | { ok: true; cid: string; provider?: string; size?: number }
  | { ok: false; cid?: undefined; error: string };

/**
 * 上传内容到远端 IPFS (协议 资源存储阶段)。按 config.mode 选通道:
 *   remote → 远端 IPFS HTTP API; pinata → Pinata; public → 无托管上传通道, 明确失败 (但配了 Pinata 凭据则走 Pinata)。
 * 失败一律返回 { ok:false, error }, 永不抛。
 */
export async function ipfsUpload(
  content: unknown,
  name = 'data',
  opts: IpfsUploadOpts = {},
): Promise<IpfsUploadRes> {
  try {
    const cfg = opts.config ?? getIpfsConfig(opts.storage);
    const text = typeof content === 'string' ? content : JSON.stringify(jsonClean(content));

    // 1) 注入的 SDK 客户端优先 (用户自己的协议 SDK)
    if (opts.client) {
      try {
        const r = await opts.client.upload(text, name);
        if (!r || !r.cid) return { ok: false, error: 'SDK client.upload 未返回 cid' };
        return { ok: true, cid: r.cid, provider: r.provider || 'diap-sdk', size: r.size };
      } catch (err) {
        return { ok: false, error: `diap-sdk 上传失败: ${errMsg(err)}` };
      }
    }

    // 2) mode=public: 公共网关只读, 没有托管上传通道
    if (cfg.mode === 'public') {
      if (cfg.pinataKey && cfg.pinataSecret) {
        const pinata = await BolloonIpfsClient.newWithPinata(cfg.pinataKey, cfg.pinataSecret, opts.timeoutSec ?? 30, opts.fetchImpl);
        const r = await pinata.upload(text, name);
        return { ok: true, cid: r.cid, provider: r.provider, size: r.size };
      }
      return {
        ok: false,
        error:
          "mode='public' 的公共网关只支持读取, 无法上传。请 setIpfsConfig 切到 mode='remote' (填 apiUrl) 或 mode='pinata' (填 pinataKey/pinataSecret), 或给 ipfsUpload 传 client。",
      };
    }

    // 3) mode=remote: 需要 apiUrl
    if (cfg.mode === 'remote') {
      if (!cfg.apiUrl) return { ok: false, error: "mode='remote' 缺少 apiUrl" };
      const client = await BolloonIpfsClient.newWithRemoteNode(
        cfg.apiUrl,
        cfg.gatewayUrl ?? (cfg.gateways?.[0] ?? DEFAULT_GATEWAYS[0]),
        opts.timeoutSec ?? 30,
        opts.fetchImpl,
      );
      const r = await client.upload(text, name);
      return { ok: true, cid: r.cid, provider: r.provider, size: r.size };
    }

    // 4) mode=pinata: 需要 pinataKey + pinataSecret
    if (!cfg.pinataKey || !cfg.pinataSecret) {
      return { ok: false, error: "mode='pinata' 缺少 pinataKey / pinataSecret" };
    }
    const pinata = await BolloonIpfsClient.newWithPinata(cfg.pinataKey, cfg.pinataSecret, opts.timeoutSec ?? 30, opts.fetchImpl);
    const r = await pinata.upload(text, name);
    return { ok: true, cid: r.cid, provider: r.provider, size: r.size };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export interface IpfsFetchOpts {
  /** 指定网关顺序 (默认取 config.gateways, 再默认 DEFAULT_GATEWAYS) */
  gateways?: string[];
  fetchImpl?: FetchLike;
  storage?: IpfsStorage;
  /** 注入真 SDK 的 IpfsClient 实例 (或任何同形对象); 它失败时仍会继续试网关 */
  client?: IpfsClientLike;
  timeoutSec?: number;
  /** 是否先查本地缓存 (默认 true) */
  useCache?: boolean;
}

export type IpfsFetchRes =
  | { ok: true; text: string; from: string }
  | { ok: false; text?: undefined; from?: undefined; error: string };

/**
 * 读取内容 (协议 资源读取阶段): 本地缓存 → (可选) SDK 客户端 → 网关逐个回退 → 命中即写缓存。
 * 失败返回 { ok:false, error }, 永不抛。
 */
export async function ipfsFetch(cid: string, opts: IpfsFetchOpts = {}): Promise<IpfsFetchRes> {
  const key = normalizeCid(cid);
  if (!key) return { ok: false, error: 'cid 不能为空' };
  const storage = opts.storage ?? defaultStorage();
  const useCache = opts.useCache !== false;

  // 1) 本地缓存优先 (命中则零网络)
  if (useCache) {
    const cached = ipfsCacheGet(key, storage);
    if (cached !== null) return { ok: true, text: cached, from: 'cache' };
  }

  const errors: string[] = [];

  // 2) 注入的 SDK 客户端 (用户自己的协议 SDK)
  if (opts.client) {
    try {
      const text = await opts.client.get(key);
      if (typeof text === 'string') {
        if (useCache) ipfsCacheSet(key, text, storage);
        return { ok: true, text, from: 'diap-sdk' };
      }
      errors.push('diap-sdk: 返回非字符串');
    } catch (err) {
      errors.push(`diap-sdk: ${errMsg(err)}`);
    }
  }

  // 3) 网关逐个回退
  const cfg = getIpfsConfig(storage);
  const gateways =
    opts.gateways && opts.gateways.length > 0
      ? opts.gateways
      : cfg.gateways && cfg.gateways.length > 0
        ? cfg.gateways
        : [...DEFAULT_GATEWAYS];
  const doFetch: FetchLike | null =
    opts.fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : null);
  if (!doFetch) return { ok: false, error: '当前环境没有 fetch (请注入 fetchImpl)' };

  for (const gw of gateways) {
    const base = String(gw).replace(/\/+$/, '');
    const url = `${base}/ipfs/${key}`;
    const { signal, done } = timeoutSignal((opts.timeoutSec ?? 30) * 1000);
    try {
      const res = await doFetch(url, { method: 'GET', headers: { 'User-Agent': 'bolloon-mobile-ipfs/1.0' }, signal });
      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status ?? '?'}`);
        continue;
      }
      const text = await res.text();
      if (typeof text !== 'string') {
        errors.push(`${base}: 响应非文本`);
        continue;
      }
      if (useCache) ipfsCacheSet(key, text, storage);
      return { ok: true, text, from: base };
    } catch (err) {
      errors.push(`${base}: ${errMsg(err)}`);
    } finally {
      done();
    }
  }

  return { ok: false, error: `所有网关都失败 (${errors.join(' | ')})` };
}
