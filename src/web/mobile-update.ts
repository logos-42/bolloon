/**
 * mobile-update.ts — 手机端 **web 资源层** 的双源 (npm + GitHub) OTA 更新 (2026-09-26, update-protocol §13)
 *
 * ── 为什么只做"web 资源层" ──────────────────────────────────────────────────
 * 手机 App 是 Capacitor 壳 (原生二进制) + web 资源 (界面与逻辑) 两层。两层的**天花板不同**,
 * 这里如实写清, 不承诺做不到的:
 *   · **iOS**: 原生壳层**不能自更** (App Store 规则) —— 二进制只能走商店 / TestFlight。
 *     web 资源层**可以** OTA 自更。所以"iOS 整体自动更新"这句话是做不到的, 本轮不承诺。
 *   · **Android**: 侧载 APK 自更**技术上可行**, 但需要用户允许"未知来源" ⇒ 必须**显式告知 +
 *     用户在环**, 不得静默安装。本轮**不做** APK 自装 (那是一条独立的、需要用户在环的通道)。
 *   ⇒ 本轮锁定的自更范围 = **web 资源层** (那四项能力: 入群 / 发任务公告 / 看飞轮进度 / 授权签名
 *     全都活在这一层); 原生层一律如实标注"需商店 / 侧载"。
 *
 * ── 语义复用 (不新造第二套) ────────────────────────────────────────────────
 * 版本 / 身份比较、错误分类、交叉校验、拒绝口径**全部**来自桌面的纯模块:
 *   `version-identity.ts` (版本比较 / 结论枚举 / REFUSED_STATUSES / dev 身份)
 *   `dual-source-facts.ts` (classifyGithubError / crossCheckStable / compareDevSnapshots)
 * 因此同一件事在电脑上和手机上说的是同一句话:
 *   stable = npm `dist-tags.latest` 是权威 + GitHub Tag 同名交叉校验 (semver)
 *   dev    = GitHub master `git ref` + commit sha 是唯一源, 身份 `<版本>+dev.<sha7>` (不用 semver)
 *   源不可达 / 版本不存在 / 交叉校验不一致 ⇒ **拒绝并说清** (REFUSED), 绝不静默装回旧版、绝不假装成功。
 *
 * ── 浏览器安全 ──────────────────────────────────────────────────────────────
 * 本文件**不许** import 任何 `node:` 模块 (它会被 esbuild 打进 mobile-core.js 在 WebView 里跑),
 * 也不许在顶层读 `process.env`。解压用平台自带的 `DecompressionStream('gzip')` + 手写 tar 解析。
 */

import {
  PKG_NAME, NPM_REGISTRY_BASE, GITHUB_API_BASE, UPSTREAM_REPO,
  GITHUB_UPSTREAM_SLUG, DEV_BRANCH, DEV_REF, DEV_IDENTITY_SEP,
  DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT_MOBILE,
  CHECK_STATUSES, REFUSED_STATUSES,
  resolveUpdateChannel, distTagForChannel, channelKindOf, devIdentity, baseVersionOf,
  isDevIdentity, devShaFromIdentity, compareVersions, isKnownVersion, describeSourceIdentity,
  envValue,
  type CheckStatus, type ChannelKind, type UpdateChannel,
} from '../utils/version-identity.js';
import {
  classifyGithubError, classifyRegistryError, crossCheckStable, compareDevSnapshots,
  newestGithubVersion, toGithubReport, renderGithubReportLine,
  type GithubReport, type GithubResult, type GithubFacts, type CrossCheck, type DevCheck,
} from '../utils/dual-source-facts.js';

// ── 电话端的结论枚举 (只增不改: 桌面的 9 个逐字保留) ────────────────────────

/**
 * 手机端"检查"的结论。**桌面的 9 个逐字保留** (同名同义), 只增手机特有的几个 ——
 * 每个新增都对应一种"手机上真的会撞上、桌面上不会"的处境, 且都必须**拒绝并说清**:
 *
 *   dev_bundle_unavailable  dev 通道: GitHub master 的**源码快照里没有 dist/web** (dist 是构建产物,
 *                           不在 git 里) ⇒ 手机端无法现场构建。需桌面导出 web 包, 或改走 stable。
 *   dev_sha_mismatch        dev: 包里的 `.bolloon-dev-snapshot.json` 的 commit sha ≠ GitHub master HEAD
 *                           ⇒ 拒绝安装一个"身份对不上"的快照。
 *   target_unpublished      目标版本在源上**不存在** (桌面把它放在风险项 `target_published` 里;
 *                           手机上"拒绝"必须是一个**结论**, 不能只是一条风险提示)。
 *   digest_mismatch         下载物的摘要 (npm shasum / 自带 bundleSha256) 与声明不一致 ⇒ 拒绝。
 *   web_bundle_malformed    包里找不到 web 资源 (dist/web) ⇒ 拒绝。
 *   decompress_unavailable  本机 WebView 没有 `DecompressionStream('gzip')` ⇒ 拒绝, 不装半个。
 *   payload_too_large       下载物超过上限 (默认 80 MiB) ⇒ 拒绝, 不拿内存去赌。
 *   native_shell_not_wired  资源已备好且验证过, 但**原生壳还没指向可写目录** ⇒ 不切换
 *                           (切了等于把"能用的旧版本"换成"壳层加载不到的新资源")。见 §13.4。
 */
export const MOBILE_WEB_STATUSES = [
  ...CHECK_STATUSES,
  'dev_bundle_unavailable',
  'dev_sha_mismatch',
  'target_unpublished',
  'digest_mismatch',
  'web_bundle_malformed',
  'decompress_unavailable',
  'payload_too_large',
  'native_shell_not_wired',
] as const;
export type MobileWebStatus = typeof MOBILE_WEB_STATUSES[number];

/** 手机端必须**拒绝并说清**的结论 = 桌面那 5 个 + 手机特有的 8 个 (逐个都在上面写了为什么)。 */
export const MOBILE_REFUSED_STATUSES: MobileWebStatus[] = [
  ...REFUSED_STATUSES,
  'target_unpublished', 'dev_bundle_unavailable', 'dev_sha_mismatch', 'digest_mismatch',
  'web_bundle_malformed', 'decompress_unavailable', 'payload_too_large', 'native_shell_not_wired',
];

/** web 资源层里必须有、且必须非空的文件 (缺一个就不算一个能启动的 web 层)。 */
export const MOBILE_WEB_REQUIRED_FILES = ['mobile.html', 'mobile.js', 'mobile-core.js', 'mobile.css'] as const;
/** 有则一起换、但缺了不算坏的文件。 */
export const MOBILE_WEB_OPTIONAL_FILES = ['a2ui-client.js', 'sw.js', 'manifest.json', 'index.html'] as const;
/** 需要语法自检的 JS (浏览器里 `new Function(src)` = 真编译一次)。 */
export const MOBILE_WEB_JS_FILES = ['mobile.js', 'mobile-core.js', 'a2ui-client.js'] as const;

/** 默认下载上限 (超过就拒绝, 不赌内存)。 */
export const MOBILE_MAX_PAYLOAD_BYTES = 80 * 1024 * 1024;

/** web 资源层的目录布局 (相对 store root)。 */
export const WEB_LAYOUT = {
  current: 'current',
  staging: 'staging',
  previous: 'previous',
  state: 'state.json',
} as const;

// ── store: web 资源存放处 (可写目录) ────────────────────────────────────────

/**
 * web 资源的存放处抽象。**为什么要有这一层**: 手机 App 里"放资源的地方"是原生能力
 * (Capacitor Filesystem / 自定义 scheme), 而验收与单测里是一个真目录或内存 map。
 * 上层流水线 (下载→校验→原子替换→验证→回滚) 只跟这个接口说话, 因此同一条流水线
 * 在真机与验收里跑的是**同一份代码**。
 */
export interface WebResourceStore {
  /** 实现名 ('memory' / 'capacitor-fs' / 'http-dir'), 出现在报告里 —— 让人知道这次是在哪跑的 */
  readonly kind: string;
  /** 人能读的位置描述 (真机上写实际路径) */
  readonly rootLabel: string;
  list(rel: string): Promise<string[]>;
  exists(rel: string): Promise<boolean>;
  readBytes(rel: string): Promise<Uint8Array | null>;
  readText(rel: string): Promise<string | null>;
  writeBytes(rel: string, data: Uint8Array): Promise<void>;
  remove(rel: string): Promise<void>;
  /** 目录级改名 = **原子替换**的落点 (同一文件系统内的 rename) */
  rename(from: string, to: string): Promise<void>;
  /** 能把这些资源当 URL 加载时的前缀 (用于真"能不能启动"探测); 拿不到 → null, 并如实降级 */
  baseUrl(): string | null;
}

function joinRel(...parts: string[]): string {
  return parts.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

/** 内存 store (单测 / 验收 / 无原生能力的兜底): 就是一个 Map。 */
export function createMemoryWebStore(opts: { kind?: string; rootLabel?: string; baseUrl?: string | null } = {}): WebResourceStore {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['']);
  const norm = (rel: string) => joinRel(rel);
  const isDir = (rel: string) => dirs.has(norm(rel));
  return {
    kind: opts.kind || 'memory',
    rootLabel: opts.rootLabel || 'memory://bolloon-web',
    async list(rel) {
      const d = norm(rel);
      const out: string[] = [];
      for (const k of files.keys()) {
        if (d === '') { if (!k.includes('/')) out.push(k); continue; }
        if (k.startsWith(d + '/')) { const rest = k.slice(d.length + 1); if (!rest.includes('/')) out.push(rest); }
      }
      return out.sort();
    },
    async exists(rel) {
      const k = norm(rel);
      return files.has(k) || isDir(k);
    },
    async readBytes(rel) { const v = files.get(norm(rel)); return v ? v.slice() : null; },
    async readText(rel) { const v = files.get(norm(rel)); return v ? new TextDecoder().decode(v) : null; },
    async writeBytes(rel, data) {
      const k = norm(rel);
      const parts = k.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      files.set(k, data.slice ? data.slice() : data);
    },
    async remove(rel) {
      const k = norm(rel);
      for (const key of Array.from(files.keys())) if (key === k || key.startsWith(k + '/')) files.delete(key);
      for (const d of Array.from(dirs)) if (d === k || d.startsWith(k + '/')) dirs.delete(d);
    },
    async rename(from, to) {
      const f = norm(from); const t = norm(to);
      const moves: { from: string; to: string }[] = [];
      for (const key of Array.from(files.keys())) {
        if (key === f) moves.push({ from: key, to: t });
        else if (key.startsWith(f + '/')) moves.push({ from: key, to: t + key.slice(f.length) });
      }
      // 先删目标 (替换语义), 再搬 — 与真文件系统的 rename 同形状
      await this.remove(t);
      for (const m of moves) {
        const v = files.get(m.from)!;
        files.delete(m.from);
        const parts = m.to.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        files.set(m.to, v);
      }
      dirs.delete(f); dirs.add(t);
    },
    baseUrl() { return opts.baseUrl ?? null; },
  };
}

/** Capacitor Filesystem 插件的最小面 (只声明用到的 3 个方法, 便于注入假实现)。 */
export interface CapacitorFilesystemLike {
  readdir(o: any): Promise<{ files: { name: string; type?: string }[] }>;
  stat(o: any): Promise<{ type?: string }>;
  readFile(o: any): Promise<{ data: string }>;
  writeFile(o: any): Promise<unknown>;
  mkdir(o: any): Promise<unknown>;
  rmdir(o: any): Promise<unknown>;
  rename(o: any): Promise<unknown>;
}

/**
 * 真机 store: 把 web 资源放到 App 的**可写数据目录** (Capacitor `Directory.Data`)。
 * 原生壳要能加载它才算"接上" —— 见 `nativeWritable` 与 §13.4。
 */
export function createCapacitorWebStore(plugin: CapacitorFilesystemLike, opts: { basePath?: string; directory?: any; baseUrl?: string | null } = {}): WebResourceStore {
  const directory = opts.directory ?? 'DATA';
  const basePath = (opts.basePath || 'bolloon-web').replace(/^\/+|\/+$/g, '');
  const full = (rel: string) => joinRel(basePath, rel);
  const b64ToBytes = (b64: string): Uint8Array => {
    if (typeof atob === 'function') { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  };
  const bytesToB64 = (data: Uint8Array): string => {
    let bin = '';
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(data).toString('base64');
  };
  return {
    kind: 'capacitor-fs',
    rootLabel: `${String(directory)}:${basePath}`,
    async list(rel) {
      try {
        const r: any = await plugin.readdir({ path: full(rel), directory });
        return (r?.files || []).filter((f: any) => f?.type !== 'directory').map((f: any) => String(f.name)).sort();
      } catch { return []; }
    },
    async exists(rel) {
      try { await plugin.stat({ path: full(rel), directory }); return true; } catch { return false; }
    },
    async readBytes(rel) {
      try {
        const r: any = await plugin.readFile({ path: full(rel), directory });
        const data = String(r?.data || '');
        return data ? b64ToBytes(data) : null;
      } catch { return null; }
    },
    async readText(rel) {
      try {
        const r: any = await plugin.readFile({ path: full(rel), directory, encoding: 'utf8' });
        return r?.data === undefined ? null : String(r.data);
      } catch { return null; }
    },
    async writeBytes(rel, data) {
      const path = full(rel);
      const parts = full(rel).split('/');
      for (let i = 1; i < parts.length; i++) {
        try { await plugin.mkdir({ path: parts.slice(0, i).join('/'), directory, recursive: true }); } catch { /* 已存在 */ }
      }
      await plugin.writeFile({ path, data: bytesToB64(data), directory });
    },
    async remove(rel) {
      try { await plugin.rmdir({ path: full(rel), directory, recursive: true }); return; } catch { /* 不是目录 */ }
      try { await plugin.rmdir({ path: full(rel), directory }); } catch { /* 忽略 */ }
    },
    async rename(from, to) {
      try { await plugin.rmdir({ path: full(to), directory, recursive: true }); } catch { /* 目标不存在 */ }
      await plugin.rename({ from: full(from), to: full(to), directory, toDirectory: directory });
    },
    baseUrl() { return opts.baseUrl ?? null; },
  };
}

// ── 解压 (浏览器自带 gzip + 手写 tar) ───────────────────────────────────────

export interface TarEntry { path: string; data: Uint8Array }

/**
 * gzip 解压 —— 用平台自带的 `DecompressionStream` (Chrome 80+ / Safari 16.4+ / WKWebView iOS 16.4+ / Node 18+)。
 * 拿不到就返回 null: 上层据此判 `decompress_unavailable` 并**拒绝**, 不假装成功。
 */
export async function gunzipBytes(data: Uint8Array): Promise<Uint8Array | null> {
  const DS: any = (globalThis as any).DecompressionStream;
  if (typeof DS !== 'function') return null;
  try {
    const stream = new (globalThis as any).Blob([data]).stream().pipeThrough(new DS('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * 极简 tar 解析 (ustar + GNU 长名 + PAX `path=`)。只做我们真需要的事:
 * 把每个 regular file 的 (路径, 内容) 拿出来。目录 / 符号链接一律跳过 (不假装支持)。
 */
export function untarBytes(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const td = new TextDecoder();
  const readStr = (off: number, len: number) => {
    let end = off;
    while (end < off + len && buf[end] !== 0) end++;
    return td.decode(buf.subarray(off, end));
  };
  const readOctal = (off: number, len: number) => {
    const s = readStr(off, len).trim().replace(/\0/g, '');
    const v = parseInt(s, 8);
    return Number.isFinite(v) ? v : 0;
  };
  let p = 0;
  let paxPath: string | null = null;
  while (p + 512 <= buf.length) {
    const name0 = readStr(p, 100);
    if (!name0) break;                       // 两个连续零块 = 结束
    const size = readOctal(p + 124, 12);
    const typeflag = String.fromCharCode(buf[p + 156] || 0x30);
    const prefix = readStr(p + 345, 155);
    const dataStart = p + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) break;         // 半截文件: 停, 不编造
    let name = (prefix ? `${prefix}/${name0}` : name0);
    if (typeflag === 'x' || typeflag === 'g') {
      // PAX 扩展头: 下一个条目的路径可能在这里 (长路径真会用到)
      const text = td.decode(buf.subarray(dataStart, dataEnd));
      const m = text.match(/\d+ path=([^\n]+)\n/);
      if (m) paxPath = m[1];
    } else if (typeflag === 'L') {
      paxPath = td.decode(buf.subarray(dataStart, dataEnd)).replace(/\0+$/, '').trim();
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '' || typeflag === '0') {
      if (paxPath) { name = paxPath; paxPath = null; }
      out.push({ path: name.replace(/^\.\//, ''), data: buf.slice(dataStart, dataEnd) });
    } else {
      paxPath = null;
    }
    p = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ── 从 tarball 里取 web 资源 ────────────────────────────────────────────────

/** 两个源包里的 web 资源前缀 (npm 包外面套着一层 `package/`; 桌面导出的 web 包直接是 `dist/web/`)。 */
export const WEB_PATH_PREFIXES = ['package/dist/web/', 'dist/web/', './dist/web/'] as const;

export function isWebResourcePath(path: string): { hit: boolean; rel: string } {
  const p = String(path).replace(/^\.\//, '');
  for (const pre of WEB_PATH_PREFIXES) {
    if (p.startsWith(pre)) return { hit: true, rel: p.slice(pre.length) };
  }
  return { hit: false, rel: '' };
}

/** 从解压后的条目里挑出 web 资源 (相对 web 根), 以及包内的 dev 快照标记 (若有)。 */
export function pickWebLayer(entries: TarEntry[]): { files: { rel: string; data: Uint8Array }[]; snapshot: any | null } {
  const files: { rel: string; data: Uint8Array }[] = [];
  let snapshot: any | null = null;
  const td = new TextDecoder();
  for (const e of entries) {
    const p = String(e.path).replace(/^\.\//, '');
    if (/(^|\/)\.bolloon-dev-snapshot\.json$/.test(p)) {
      try { snapshot = JSON.parse(td.decode(e.data)); } catch { snapshot = null; }
      continue;
    }
    const w = isWebResourcePath(p);
    if (w.hit && w.rel && !w.rel.endsWith('/')) files.push({ rel: w.rel, data: e.data });
  }
  return { files, snapshot };
}

// ── 摘要 ────────────────────────────────────────────────────────────────────

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * 摘要算法名归一化 —— **必须**做这一步:
 * npm 给的是 `sha1` / SRI 给的是 `sha512`, 而 WebCrypto 只认 `SHA-1` / `SHA-256` / `SHA-512`。
 * 直接把 `'sha1'.toUpperCase()` 丢进去 → `subtle.digest('SHA1')` 抛错 → 摘要算不出来 →
 * **每一个包都会被判成 digest_mismatch** (真跑抓到过)。
 */
function normalizeAlgo(a: string): 'SHA-1' | 'SHA-256' | 'SHA-512' | null {
  const k = String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'sha1') return 'SHA-1';
  if (k === 'sha256') return 'SHA-256';
  if (k === 'sha512') return 'SHA-512';
  return null;
}

async function digestHex(data: Uint8Array, algo: string): Promise<string | null> {
  const c: any = (globalThis as any).crypto?.subtle;
  if (!c) return null;                       // 老 WebView 没有 subtle → 调用方按"算不出摘要"处理
  const name = normalizeAlgo(algo);
  if (!name) return null;
  try { return toHex(await c.digest(name, data)); } catch { return null; }
}

/** SRI (`sha512-<base64>`) → 归一化成 base64 摘要, 用于和本地算出来的比。 */
export function parseSri(integrity: string | null | undefined): { algo: 'sha512' | 'sha256' | 'sha1'; b64: string } | null {
  const s = String(integrity || '').trim();
  const m = s.match(/^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  return { algo: m[1] as any, b64: m[2] };
}

function b64Of(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}

// ── 落盘状态 (装在哪个源 / 哪个 sha / 能切回哪) ─────────────────────────────

export const MOBILE_UPDATE_STATE_SCHEMA = 'bolloon-mobile-web/1';

export interface MobileUpdateState {
  schema: typeof MOBILE_UPDATE_STATE_SCHEMA;
  /** 当前 web 层的身份 (`0.5.0` 或 `0.5.0+dev.fb60ccf`) */
  currentVersion: string | null;
  installedChannel: 'stable' | 'dev' | null;
  installedDevSha: string | null;
  /** 当前 web 层的来源 URL / 摘要 (回答"这份资源到底是从哪来的") */
  installedFrom: { channel: 'stable' | 'dev'; source: string; url: string | null; digest: string | null; digestAlgo: string | null; at: string } | null;
  /** 一键能切回的另一个源 */
  switchableTo: { channel: 'stable' | 'dev'; source: string; target: string | null } | null;
  /** 通道偏好 (用户选的 stable/dev; 只影响"检查谁", 不等于装了什么) */
  channelPref: UpdateChannel | null;
  /** 上次装成 dev 用的 sha (切回 stable 后仍保留 —— 和桌面同一套字段语义) */
  lastDevSha: string | null;
  devRef: string | null;
  devCheckedAt: string | null;
  lastCheck: { at: string; status: MobileWebStatus; reason?: string; channel: UpdateChannel; latestVersion: string | null } | null;
  lastUpdate: { at: string; from: string; to: string; stage: string; reason?: string } | null;
  lastFailure: { at: string; stage: string; reason: string } | null;
  /** 最近一次"智能体自动准备"的结果 (为自动更新铺路: 它只到 verify 为止) */
  autoPrepared: { identity: string; digest: string | null; verifiedAt: string; steps: string[] } | null;
  /** 历史 (倒序, 最多 20 条) */
  history: { at: string; from: string; to: string; stage: string; reason?: string }[];
  needsReload: boolean;
}

export function emptyMobileUpdateState(): MobileUpdateState {
  return {
    schema: MOBILE_UPDATE_STATE_SCHEMA,
    currentVersion: null, installedChannel: null, installedDevSha: null, channelPref: null,
    installedFrom: null, switchableTo: null, lastDevSha: null, devRef: null, devCheckedAt: null,
    lastCheck: null, lastUpdate: null, lastFailure: null, autoPrepared: null,
    history: [], needsReload: false,
  };
}

export async function readMobileUpdateState(store: WebResourceStore): Promise<MobileUpdateState> {
  const base = emptyMobileUpdateState();
  const text = await store.readText(WEB_LAYOUT.state);
  if (!text) return base;
  try {
    const raw = JSON.parse(text);
    if (!raw || raw.schema !== MOBILE_UPDATE_STATE_SCHEMA) return base;
    return { ...base, ...raw, history: Array.isArray(raw.history) ? raw.history.slice(0, 20) : [] };
  } catch {
    return base;
  }
}

export async function writeMobileUpdateState(patch: Partial<MobileUpdateState>, store: WebResourceStore): Promise<MobileUpdateState> {
  const cur = await readMobileUpdateState(store);
  const next: MobileUpdateState = { ...cur, ...patch, schema: MOBILE_UPDATE_STATE_SCHEMA };
  await store.writeBytes(WEB_LAYOUT.state, new TextEncoder().encode(JSON.stringify(next, null, 2)));
  return next;
}

// ── 依赖与源查询 ────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init?: any) => Promise<any>;

export interface MobileUpdateDeps {
  store: WebResourceStore;
  fetchImpl?: FetchLike;
  registryBase?: string;
  apiBase?: string;
  pkgName?: string;
  /** 覆盖通道 (不落盘, 与桌面 `--channel` 同语义) */
  channel?: string;
  /**
   * dev 通道的 web 包地址模板 (支持 `{sha}`)。**没有配就没有 dev 源**:
   * GitHub master 的源码快照里没有 `dist/web` (构建产物不在 git 里), 手机端无法现场构建 ⇒
   * 判 `dev_bundle_unavailable` 并说清"需桌面导出 web 包"。生产上默认读 `BOLLOON_MOBILE_DEV_BUNDLE_URL`。
   */
  devBundleUrl?: string | null;
  /**
   * dev 通道的 web 包**载荷摘要 pin** (sha256 hex; 一般取同名 `.sha256` 清单里的值, 读 `BOLLOON_MOBILE_DEV_BUNDLE_SHA256`)。
   *
   * 为什么要手填: dev 是 `git-ref` 通道, 身份的锚是 GitHub master HEAD, 但**载荷摘要没有可预知的锚点**
   * (手机端事先不知道桌面打出来的 tar.gz 的 sha256)。不 pin 的话: 身份仍被 GitHub 锚定 (包内 sha 必须是
   * master HEAD, 否则拒), 但**同一 host 换字节是防不住的** —— 这与桌面 dev 通道是同一种性质, 不许说成
   * "和 stable 一样安全"。stable 有 npm registry 的 `dist.shasum` 做锚, dev 只有你 pin 了才有强校验。
   */
  devBundleSha256?: string | null;
  /** 本地身份 (原生壳注入 / 构建戳): 读不到就判 local_version_unknown, **绝不猜** */
  localIdentity?: { version: string; channel?: 'stable' | 'dev' } | null;
  /** 本地身份戳文件的 URL (默认同目录 `./bolloon-web.json`) */
  localIdentityUrl?: string | null;
  /** 受控注入 (单测 / 验收): registry packument 与 GitHub facts (注入 = 不打真网) */
  npmDoc?: any | null;
  githubFacts?: GithubResult | null;
  /** 原生壳是否已经指向可写目录 (决定最后一步能不能切) */
  nativeWritable?: boolean | null;
  maxPayloadBytes?: number;
  bootTimeoutMs?: number;
  now?: () => number;
  onStage?: (stage: string, detail: string) => void;
}

export interface NpmFacts {
  reachable: boolean;
  detail?: string;
  /** 不可达时的分类 (唯一一份分类器在 dual-source-facts.ts) —— 调用方**不许**从 detail 里猜 */
  kind?: 'offline' | 'registry_unavailable' | null;
  latest: string | null;
  distTags: Record<string, string>;
  versions: string[];
  /** 目标版本的下载信息 */
  dist?: { tarball: string; shasum: string | null; integrity: string | null } | null;
}

async function fetchJson(url: string, fetchImpl: FetchLike, timeoutMs = 15000): Promise<{ ok: boolean; status: number; json: any; text: string; err?: any }> {
  try {
    const ac: any = (globalThis as any).AbortController ? new AbortController() : null;
    const timer = ac ? setTimeout(() => { try { ac.abort(); } catch { /* noop */ } }, timeoutMs) : null;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ac?.signal });
    const status = Number(res?.status || 0);
    const text = await res.text();
    if (timer) clearTimeout(timer);
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: status >= 200 && status < 300, status, json, text };
  } catch (e: any) {
    return { ok: false, status: 0, json: null, text: '', err: e };
  }
}

/** 查 npm packument (与桌面同一份 registry 语义; 注入则不打网) */
export async function queryMobileNpmFacts(deps: MobileUpdateDeps, pkg: string): Promise<NpmFacts> {
  if (deps.npmDoc !== undefined && deps.npmDoc !== null) return normalizeNpmDoc(deps.npmDoc, null);
  if (deps.npmDoc === null && deps.githubFacts !== undefined) {
    // 显式注入 null = 受控"registry 不可达"
    return { reachable: false, kind: 'offline', detail: '注入的 registry 事实为 null (受控不可达: offline)', latest: null, distTags: {}, versions: [], dist: null };
  }
  const base = (deps.registryBase || NPM_REGISTRY_BASE).replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(pkg).replace('%40', '@')}`;
  const fetchImpl = deps.fetchImpl || ((globalThis as any).fetch?.bind(globalThis));
  if (!fetchImpl) return { reachable: false, kind: 'offline', detail: '本机没有 fetch (offline)', latest: null, distTags: {}, versions: [], dist: null };
  const r = await fetchJson(url, fetchImpl);
  if (!r.ok) {
    const cls = classifyRegistryError(r.err || null, r.status || undefined);
    return { reachable: false, kind: cls.kind, detail: cls.kind === 'offline' ? `offline: ${cls.detail}` : `registry_unavailable: ${cls.detail}`, latest: null, distTags: {}, versions: [], dist: null };
  }
  if (!r.json) return { reachable: false, kind: 'registry_unavailable', detail: 'registry_unavailable: registry 返回了无法解析的内容', latest: null, distTags: {}, versions: [], dist: null };
  return normalizeNpmDoc(r.json, null);
}

function normalizeNpmDoc(doc: any, detail: string | null): NpmFacts {
  const distTags = (doc?.['dist-tags'] || {}) as Record<string, string>;
  const versions = Object.keys(doc?.versions || {});
  if (!distTags.latest && versions.length === 0) {
    return { reachable: false, detail: detail || 'registry 上没有可用版本', latest: null, distTags: {}, versions: [], dist: null };
  }
  const latest = distTags.latest || versions[versions.length - 1] || null;
  const v = latest ? doc?.versions?.[latest] : null;
  return {
    reachable: true,
    latest,
    distTags, versions,
    dist: v?.dist ? { tarball: String(v.dist.tarball || ''), shasum: v.dist.shasum ? String(v.dist.shasum) : null, integrity: v.dist.integrity ? String(v.dist.integrity) : null } : null,
  };
}

/** 查 GitHub 三个事实 (注入则不打网) */
export async function queryMobileGithubFacts(deps: MobileUpdateDeps): Promise<GithubResult | null> {
  if (deps.githubFacts !== undefined && deps.githubFacts !== null) return deps.githubFacts;
  if (deps.githubFacts === null) return null;
  const fetchImpl = deps.fetchImpl || ((globalThis as any).fetch?.bind(globalThis));
  if (!fetchImpl) return null;
  const base = (deps.apiBase || GITHUB_API_BASE).replace(/\/+$/, '');
  const missing: string[] = [];
  let releases: string[] = [];
  let tags: { name: string; sha: string | null }[] = [];
  let headSha: string | null = null;
  const failures: { reason: any; detail: string; retryAt: string | null }[] = [];
  const note = (e: { reason: any; detail: string; retryAt: string | null }, what: string) => {
    missing.push(what); failures.push({ reason: e.reason, detail: `${what}: ${e.detail}`, retryAt: e.retryAt });
  };
  const rel = await fetchJson(`${base}/repos/${GITHUB_UPSTREAM_SLUG}/releases?per_page=100`, fetchImpl);
  if (rel.ok && Array.isArray(rel.json)) releases = rel.json.map((x: any) => String(x?.tag_name || '')).filter(Boolean);
  else note(classifyGithubError(rel.err || null, rel.status || undefined), 'releases');

  const tg = await fetchJson(`${base}/repos/${GITHUB_UPSTREAM_SLUG}/tags?per_page=100`, fetchImpl);
  if (tg.ok && Array.isArray(tg.json)) tags = tg.json.map((x: any) => ({ name: String(x?.name || ''), sha: x?.commit?.sha ? String(x.commit.sha) : null })).filter((t: any) => t.name);
  else note(classifyGithubError(tg.err || null, tg.status || undefined), 'tags');

  const hd = await fetchJson(`${base}/repos/${GITHUB_UPSTREAM_SLUG}/commits/${DEV_BRANCH}`, fetchImpl);
  if (hd.ok && hd.json?.sha) headSha = String(hd.json.sha);
  else if (hd.ok) note({ reason: 'parse_error', detail: 'commits/master 没有 sha 字段', retryAt: null }, 'head');
  else note(classifyGithubError(hd.err || null, hd.status || undefined), 'head');

  const facts: GithubFacts = { slug: GITHUB_UPSTREAM_SLUG, ref: DEV_REF, headSha, releases, tags, fetchedAt: new Date().toISOString(), partial: missing.length > 0, missing };
  if (failures.length) {
    const f = failures[0];
    return { ok: false, kind: 'github_unavailable', reason: f.reason, detail: f.detail, retryAt: f.retryAt, facts };
  }
  return { ok: true, facts };
}

// ── 本地身份 ────────────────────────────────────────────────────────────────

export interface LocalWebIdentity { version: string; channel: 'stable' | 'dev'; source: string }

/**
 * 本地 web 层的身份, 三个来源按可信度排序 (**读不到就说读不到, 绝不猜**):
 *   ① 原生壳注入的 `deps.localIdentity`
 *   ② store 里上一次 OTA 落下的 `state.json` (含身份与来源)
 *   ③ 同目录的构建戳 `bolloon-web.json` (build:web / web 包产出时写)
 */
export async function resolveLocalWebIdentity(deps: MobileUpdateDeps): Promise<LocalWebIdentity | null> {
  if (deps.localIdentity && isKnownVersion(deps.localIdentity.version)) {
    const devSha = devShaFromIdentity(deps.localIdentity.version);
    return { version: String(deps.localIdentity.version), channel: devSha ? 'dev' : (deps.localIdentity.channel || 'stable'), source: 'shell-injected' };
  }
  const st = await readMobileUpdateState(deps.store);
  if (st.currentVersion && isKnownVersion(st.currentVersion)) {
    const devSha = devShaFromIdentity(st.currentVersion);
    return { version: st.currentVersion, channel: devSha ? 'dev' : (st.installedChannel || 'stable'), source: 'ota-state' };
  }
  const url = deps.localIdentityUrl === null ? null : (deps.localIdentityUrl || './bolloon-web.json');
  const fetchImpl = deps.fetchImpl || ((globalThis as any).fetch?.bind(globalThis));
  if (url && fetchImpl) {
    const r = await fetchJson(url, fetchImpl, 8000).catch(() => null);
    const v = r?.json?.version;
    if (r?.ok && isKnownVersion(v)) {
      const devSha = devShaFromIdentity(v);
      return { version: String(v), channel: devSha ? 'dev' : (r.json.channel === 'dev' ? 'dev' : 'stable'), source: 'build-stamp' };
    }
  }
  return null;
}

// ── 检查 ────────────────────────────────────────────────────────────────────

export interface MobileSourceFacts {
  npm?: { reachable: boolean; latest: string | null; detail?: string } | null;
  github?: { reachable: boolean; reason?: string; detail?: string; retryAt?: string | null; ref?: string; headSha?: string | null; newestVersion?: string | null; releases?: number; tags?: number } | null;
  crossCheck?: { kind: string; blocking: boolean; detail: string } | null;
}

/** 一份可执行的下载计划 (程序可读 —— 智能体自动更新只需要它 + apply 的确认位)。 */
export interface MobileArtifactPlan {
  channel: 'stable' | 'dev';
  /** 身份就是它 (stable= semver, dev= `<版本>+dev.<sha7>`) */
  identity: string;
  source: string;
  url: string;
  /** 期望的摘要 (校验不过就拒绝) */
  digest: { algo: 'sha1' | 'sha256' | 'sha512'; hex?: string | null; b64?: string | null } | null;
  /** dev: 包里 `.bolloon-dev-snapshot.json` 必须自报这个 sha */
  expectedDevSha?: string | null;
  /** dev: 包自带的 bundleSha256 (桌面导出 web 包时算的) */
  expectedBundleSha256?: string | null;
  sizeHint?: number | null;
}

export interface MobileCheckResult {
  status: MobileWebStatus;
  channel: UpdateChannel;
  channelKind: ChannelKind;
  currentVersion: string;
  installedChannel: 'stable' | 'dev' | null;
  installedDevSha: string | null;
  latestVersion: string | null;
  targetIdentity: string | null;
  switchableTo: { channel: 'stable' | 'dev'; source: string; target: string | null } | null;
  crossCheck: CrossCheck | null;
  github: GithubReport | null;
  dev: DevCheck | null;
  sourceFacts: MobileSourceFacts | null;
  targetPublished: boolean | null;
  /** 可执行的下载计划 (status=update_available 时才有) */
  artifact: MobileArtifactPlan | null;
  /** 必须原样打印给用户的提醒 (dev 警告等) */
  warnings: string[];
  reason?: string;
  checkedAt: string;
  /** 身份那一行 (与桌面同措辞) —— UI 直接显示它 */
  identityLine: string;
  localIdentitySource: string | null;
  storeKind: string;
  /**
   * 原生壳是否已指向可写目录。**这是"装了会不会生效"的事实**:
   * false/未知 ⇒ 资源能准备也能验证, 但**不切换** (切了只会把"能用的旧版本"换成"壳层加载不到的新资源"),
   * 结论 `native_shell_not_wired` 只在**切换**那一步出现, 检查阶段只是把它当事实报出来。
   */
  nativeWritable: boolean;
  /** 会不会生效 (＝ nativeWritable)。给 UI/智能体一句话判断 */
  effectiveAfterReload: boolean;
}

function refused(s: MobileWebStatus): boolean {
  return MOBILE_REFUSED_STATUSES.includes(s);
}
export { refused as isMobileRefusedStatus };

/**
 * 原生壳接上了吗 —— 决定"装了会不会生效"。
 *   显式 true/false 优先; 没说的时候: 内存 store (单测/验收) 当"接上了", **真机 store (capacitor-fs)
 *   默认当"没接上"** —— 不知道就按不能生效算, 不拿用户的可用版本去赌。
 */
export function nativeWired(deps: Pick<MobileUpdateDeps, 'nativeWritable' | 'store'>): boolean {
  if (deps.nativeWritable === true) return true;
  if (deps.nativeWritable === false) return false;
  return deps.store.kind === 'memory';
}

function warnFor(channel: UpdateChannel, wired: boolean = true): string[] {
  const w = channelKindOf(channel) === 'git-ref' ? [DEV_CHANNEL_WARNING, DEV_BACK_TO_STABLE_HINT_MOBILE] : [];
  if (!wired) w.push(NATIVE_CEILING_LINE);
  return w;
}

/**
 * 手机端检查更新。**结论优先级与桌面 §12.3 逐条对齐** (手机特有的三条插在对应位置):
 *   1. 读不到本地 web 身份            → local_version_unknown (绝不默认 0.0.0)
 *   2. (原生壳没接可写目录 **不是**检查结论 —— 它是一条事实 `nativeWritable` + 一条警告;
 *       真正拒绝发生在**切换**那一步: `native_shell_not_wired`. 理由: 壳层没接上时用户
 *       仍需要看到"有新版本可用"，只是不能装。)
 *   3. npm 不可达                    → offline / registry_unavailable
 *   4. dev 通道 GitHub 不可达        → github_unavailable (dev 只有这一个源, 拒绝)
 *   5. dev 通道缺 web 包地址         → dev_bundle_unavailable (源码快照里没有 dist/web)
 *   6. stable 两源指向不同版本       → cross_check_mismatch (拒绝)
 *   7. 目标版本在源上不存在          → target_unpublished (拒绝)
 *   8. 有新版 / 已是最新             → update_available / up_to_date
 */
export async function checkMobileUpdate(deps: MobileUpdateDeps): Promise<MobileCheckResult> {
  const store = deps.store;
  const now = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const local = await resolveLocalWebIdentity(deps);
  const channel = resolveUpdateChannel(deps.channel);
  const channelKind = channelKindOf(channel);
  const base: Omit<MobileCheckResult, 'status' | 'reason'> = {
    channel, channelKind,
    currentVersion: local?.version || 'unknown',
    installedChannel: local ? (devShaFromIdentity(local.version) ? 'dev' : 'stable') : null,
    installedDevSha: local ? devShaFromIdentity(local.version) : null,
    latestVersion: null, targetIdentity: null, switchableTo: null,
    crossCheck: null, github: null, dev: null, sourceFacts: null, targetPublished: null,
    artifact: null, warnings: warnFor(channel, nativeWired(deps)), checkedAt: now,
    identityLine: describeSourceIdentity({
      packageVersion: local?.version || 'unknown',
      installedDevSha: local ? devShaFromIdentity(local.version) : null,
      switchableTo: null,
      channelKind,
    }),
    localIdentitySource: local?.source || null,
    storeKind: store.kind,
    nativeWritable: nativeWired(deps),
    effectiveAfterReload: nativeWired(deps),
  };

  // 1. 本地身份读不到 —— 不猜
  if (!local || !isKnownVersion(local.version)) {
    return { ...base, status: 'local_version_unknown', reason: `读不到本机 web 层的版本身份 (壳层注入 / OTA state / 构建戳 bolloon-web.json 都没有) — 不判断有没有更新` };
  }

  const npm = await queryMobileNpmFacts(deps, deps.pkgName || PKG_NAME);
  const githubRes = await queryMobileGithubFacts(deps);
  const github = githubRes ? toGithubReport(githubRes) : null;
  const npmLatest = npm.reachable ? (npm.distTags[distTagForChannel(channel)] || npm.latest) : null;
  const sourceFacts: MobileSourceFacts = {
    npm: npm.reachable ? { reachable: true, latest: npmLatest } : { reachable: false, latest: null, detail: npm.detail },
    github: github ? {
      reachable: github.reachable, reason: github.reason, detail: github.detail, retryAt: github.retryAt ?? null,
      ref: github.ref, headSha: github.headSha, newestVersion: github.newestVersion,
      releases: github.releases, tags: github.tags,
    } : null,
    crossCheck: null,
  };
  const switchableTo = base.installedDevSha
    ? { channel: 'stable' as const, source: 'npm', target: npmLatest }
    : { channel: 'dev' as const, source: 'github', target: github?.headSha ? github.headSha.slice(0, 7) : null };
  const identityLine = describeSourceIdentity({
    packageVersion: local.version,
    installedDevSha: base.installedDevSha,
    switchableTo,
    channelKind,
  });
  const withSources = { ...base, github, sourceFacts, switchableTo, identityLine };

  // ── dev 通道: GitHub master 是唯一源, sha 是身份 ────────────────────────
  if (channelKind === 'git-ref') {
    if (!github || !github.reachable) {
      const reason = github?.reason || 'offline';
      const detail = github?.detail || (githubRes === null ? '本次未查询 GitHub 源' : 'GitHub 源不可达');
      return {
        ...withSources, status: 'github_unavailable', latestVersion: null,
        reason: `github_unavailable(${reason}): ${detail} — dev 通道只有 GitHub 一个源, 拒绝安装 (不回落到 stable 装一个 npm 版本)`,
      };
    }
    if (!github.headSha) {
      return { ...withSources, status: 'github_unavailable', latestVersion: null, reason: `github_unavailable(not_found): GitHub 上没有 ${DEV_REF} 或读不到 HEAD — 拒绝安装一个身份不明的快照` };
    }
    const dev = compareDevSnapshots(base.installedDevSha, github.headSha, DEV_REF);
    const targetIdentity = devIdentity(baseVersionOf(local.version), github.headSha);
    const devBundleUrl = deps.devBundleUrl !== undefined ? deps.devBundleUrl : envValue('BOLLOON_MOBILE_DEV_BUNDLE_URL');
    const devBundleSha256 = deps.devBundleSha256 !== undefined ? deps.devBundleSha256 : envValue('BOLLOON_MOBILE_DEV_BUNDLE_SHA256');
    const common = { ...withSources, dev, targetIdentity, latestVersion: targetIdentity, sourceFacts: { ...sourceFacts, github: sourceFacts.github } };

    /**
     * dev 的 web 包只能由**有构建能力的一端**产出: GitHub master 的源码快照里**没有** dist/web
     * (dist 是构建产物, 不进 git)。手机端无法现场 tsc 构建 ⇒ 没有配 bundle 地址就**如实拒绝**,
     * 而不是"悄悄退回 stable 装一个 npm 版本"(那正是 §12.5 要禁掉的行为)。
     */
    if (dev.same) {
      return { ...common, status: 'up_to_date', reason: dev.detail };
    }
    if (!devBundleUrl || !/\{sha\}/.test(devBundleUrl)) {
      return {
        ...common, status: 'dev_bundle_unavailable',
        reason: `dev_bundle_unavailable: dev 通道的 web 包要由有构建能力的一端产出 —— GitHub master 的源码快照里没有 dist/web (dist 是构建产物, 不在 git 里), 手机端无法现场构建。`
          + `请用桌面导出: npx tsx scripts/build-mobile-web-bundle.ts --channel dev (产出 dist/web + .bolloon-dev-snapshot.json 的 tar.gz 与同名 .sha256), 并把地址配到手机端 BOLLOON_MOBILE_DEV_BUNDLE_URL (模板需含 {sha}, {sha} 会被替换成 master HEAD 的完整 40 位 sha)。`
          + `${devBundleUrl ? ` 当前配置的模板不含 {sha}: ${devBundleUrl}` : ' 当前没有配置 dev web 包地址。'}`
          + ` stable 通道不受影响 (npm tarball 自带 dist/web)。`,
      };
    }
    const pinned = devBundleSha256 ? String(devBundleSha256).trim().toLowerCase() : null;
    const url = String(devBundleUrl).replace('{sha}', github.headSha);
    return {
      ...common, status: 'update_available', targetPublished: true,
      artifact: {
        channel: 'dev', identity: targetIdentity, source: `github master @ ${github.headSha.slice(0, 7)}`,
        url,
        // pin 了才校验载荷摘要; 没 pin 就如实标"没有载荷锚点"(不给虚假的安全感)
        digest: pinned ? { algo: 'sha256', hex: pinned } : null,
        expectedDevSha: github.headSha, expectedBundleSha256: pinned,
      },
      reason: `${dev.detail} · web 包来自 ${url} (包内 sha 必须等于 master HEAD, 否则拒绝)`
        + (pinned ? ` · 载荷摘要已 pin (sha256:${pinned.slice(0, 12)}…)` : ' · 载荷摘要未 pin (dev 通道固有: 只有身份被 GitHub 锚定)'),
      warnings: common.warnings.concat(pinned ? [] : [
        'dev 载荷摘要未 pin ⇒ 只保证"身份是 master HEAD 的那个 commit", 不保证"字节就是桌面打的那一份" (要强校验就把 .sha256 清单的值配到 BOLLOON_MOBILE_DEV_BUNDLE_SHA256)',
      ]),
    };
  }

  // ── stable 通道: npm 是权威, GitHub Tag 只做交叉校验 ─────────────────────
  if (!npm.reachable) {
    const detail = npm.detail || 'registry 不可达';
    // 分类来自唯一那份分类器 (dual-source-facts), **不**从 detail 文本里正则猜
    const offline = npm.kind === 'offline';
    return {
      ...withSources, status: offline ? 'offline' : 'registry_unavailable', latestVersion: null,
      reason: `${detail}${github ? ` · ${renderGithubReportLine(github)}` : ''} — 不能判定为最新`,
    };
  }
  const latest = npmLatest;
  const facts = githubRes && githubRes.ok ? githubRes.facts : null;
  const crossCheck = facts ? crossCheckStable(latest, facts) : null;
  const withCross = {
    ...withSources, crossCheck, latestVersion: latest,
    sourceFacts: { ...sourceFacts, crossCheck: crossCheck ? { kind: crossCheck.kind, blocking: crossCheck.blocking, detail: crossCheck.detail } : null },
  };

  // 6. 两个源指向不同版本 → 拒绝 (不许按 GitHub 的记录去装)
  if (crossCheck?.kind === 'mismatch') {
    return {
      ...withCross, status: 'cross_check_mismatch',
      reason: `cross_check_mismatch: ${crossCheck.detail} (npm latest=${latest} / GitHub ${crossCheck.githubVersion || '无记录'})`,
    };
  }

  // 当前装的是 dev 快照 → 显式判"切回 stable" (不拿 semver 硬比)
  if (isDevIdentity(local.version)) {
    const target = latest;
    if (!target || !npm.versions.includes(baseVersionOf(target))) {
      return { ...withCross, status: 'target_unpublished', reason: `target_unpublished: registry 上没有 ${target || '目标版本'} 这个版本 — 拒绝切回 (当前 dev 快照 ${local.version} 原样保留)` };
    }
    if (!npm.dist?.tarball) {
      return { ...withCross, status: 'target_unpublished', reason: `target_unpublished: registry 没给出 ${target} 的下载地址 (dist.tarball 缺失) — 拒绝切回` };
    }
    return {
      ...withCross, status: 'update_available', targetPublished: true,
      artifact: {
        channel: 'stable', identity: String(target), source: 'npm registry (dist-tags.latest)',
        url: npm.dist.tarball,
        digest: npm.dist.shasum ? { algo: 'sha1', hex: npm.dist.shasum } : (npm.dist.integrity ? { algo: 'sha512', b64: parseSri(npm.dist.integrity)?.b64 ?? null } : null),
      },
      reason: `当前装的是 dev 快照 ${local.version} → 切回 stable 的 ${target} (${DEV_BACK_TO_STABLE_HINT_MOBILE})`,
    };
  }

  // 7/8/9. 目标存在性 → 比较
  if (latest && !npm.versions.includes(latest)) {
    return { ...withCross, status: 'target_unpublished', targetPublished: false, reason: `target_unpublished: registry 的 dist-tags 指到 ${latest}, 但 versions 里没有这个版本 — 拒绝更新 (0 字节下载)` };
  }
  if (latest && compareVersions(baseVersionOf(local.version), latest) < 0) {
    if (!npm.dist?.tarball) {
      return { ...withCross, status: 'target_unpublished', targetPublished: true, reason: `target_unpublished: registry 没给出 ${latest} 的下载地址 (dist.tarball 缺失) — 拒绝更新` };
    }
    return {
      ...withCross, status: 'update_available', targetPublished: true,
      artifact: {
        channel: 'stable', identity: latest, source: 'npm registry (dist-tags.latest)',
        url: npm.dist.tarball,
        digest: npm.dist.shasum ? { algo: 'sha1', hex: npm.dist.shasum } : (npm.dist.integrity ? { algo: 'sha512', b64: parseSri(npm.dist.integrity)?.b64 ?? null } : null),
      },
      reason: `当前 ${local.version} → 目标 ${latest}${crossCheck ? ` · 交叉校验: ${crossCheck.kind}` : ''}`,
    };
  }
  return { ...withCross, status: 'up_to_date', targetPublished: latest ? npm.versions.includes(latest) : null };
}

// ── 下载 ────────────────────────────────────────────────────────────────────

export interface DownloadResult {
  ok: boolean;
  status?: MobileWebStatus;
  detail: string;
  bytes?: Uint8Array;
  digest: { algo: string; hex?: string | null; b64?: string | null; matched: boolean | null };
}

/** 下载 + **按声明摘要校验** (对不上 → digest_mismatch, 绝不"先装上再说")。 */
export async function downloadArtifact(artifact: MobileArtifactPlan, deps: MobileUpdateDeps): Promise<DownloadResult> {
  const fetchImpl = deps.fetchImpl || ((globalThis as any).fetch?.bind(globalThis));
  const maxBytes = deps.maxPayloadBytes ?? MOBILE_MAX_PAYLOAD_BYTES;
  if (!fetchImpl) return { ok: false, status: 'offline', detail: '本机没有 fetch, 无法下载', digest: { algo: '', matched: null } };
  let bytes: Uint8Array;
  try {
    const res = await fetchImpl(artifact.url, { headers: { Accept: 'application/octet-stream, application/gzip, */*' } });
    const status = Number(res?.status || 0);
    if (!(status >= 200 && status < 300)) {
      const cls = classifyGithubError(null, status || undefined);
      const bucket: MobileWebStatus = cls.reason === 'not_found' ? 'target_unpublished' : (cls.reason === 'offline' ? 'offline' : 'registry_unavailable');
      return { ok: false, status: bucket, detail: `下载 ${artifact.url} 失败: HTTP ${status || '无响应'} (${cls.reason})`, digest: { algo: '', matched: null } };
    }
    const lenHint = Number(res?.headers?.get?.('content-length') || 0);
    if (lenHint && lenHint > maxBytes) {
      return { ok: false, status: 'payload_too_large', detail: `下载物 ${(lenHint / 1048576).toFixed(1)} MiB 超过上限 ${(maxBytes / 1048576).toFixed(0)} MiB — 拒绝`, digest: { algo: '', matched: null } };
    }
    const buf = await res.arrayBuffer();
    bytes = new Uint8Array(buf);
    if (bytes.length > maxBytes) {
      return { ok: false, status: 'payload_too_large', detail: `下载物 ${(bytes.length / 1048576).toFixed(1)} MiB 超过上限 ${(maxBytes / 1048576).toFixed(0)} MiB — 拒绝`, digest: { algo: '', matched: null } };
    }
  } catch (e: any) {
    const cls = classifyGithubError(e);
    return { ok: false, status: cls.reason === 'offline' ? 'offline' : 'registry_unavailable', detail: `下载 ${artifact.url} 失败: ${cls.detail}`, digest: { algo: '', matched: null } };
  }

  // 摘要校验
  if (!artifact.digest) {
    return { ok: true, detail: '该源没有提供摘要 (dev web 包以包内 sha 作为身份校验, 见 dev_sha_mismatch)', bytes, digest: { algo: '', matched: null } };
  }
  const algo = artifact.digest.algo;
  const want = artifact.digest.hex || artifact.digest.b64;
  if (!want) return { ok: true, detail: '声明的摘要为空 (跳过)', bytes, digest: { algo, matched: null } };
  let got: string | null = null;
  if (artifact.digest.hex) got = await digestHex(bytes, algo);
  else {
    const bytesDigest = await digestHex(bytes, algo);
    // 本地 digestHex 给的是 hex; 声明是 base64 → 归一化成 hex 比
    if (bytesDigest) got = null;
    const h = bytesDigest;
    if (h) {
      // 把 hex 还原成字节再 base64, 与 SRI 的 base64 逐字比
      const pairs = h.match(/.{2}/g) || [];
      const arr = new Uint8Array(pairs.map((x) => parseInt(x, 16)));
      got = b64Of(arr) === artifact.digest.b64 ? artifact.digest.b64 : b64Of(arr);
    }
  }
  const matched = got !== null && got.toLowerCase() === want.toLowerCase();
  if (!matched) {
    return {
      ok: false, status: 'digest_mismatch',
      detail: `digest_mismatch: 摘要对不上 (${algo}) — 声明 ${String(want).slice(0, 24)}…, 实际 ${String(got).slice(0, 24)}…, 拒绝安装`,
      bytes, digest: { algo, hex: artifact.digest.hex ? got : null, b64: artifact.digest.b64 ? got : null, matched: false },
    };
  }
  return { ok: true, detail: `摘要已核对 (${algo})`, bytes, digest: { algo, hex: artifact.digest.hex ? got : null, b64: artifact.digest.b64 ? got : null, matched: true } };
}

// ── 验证 (能不能启动) ───────────────────────────────────────────────────────

export interface BootProbeResult {
  ok: boolean;
  /** iframe = 真加载了一次; static-only = 只做静态与语法级检查 (并如实标注) */
  mode: 'iframe' | 'static-only';
  detail: string;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** `mobile.html` 里引用的脚本都要在资源里存在 (否则"能启动"是假的)。 */
export function scriptRefsOf(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/**
 * 验证一个 web 资源层"能不能启动"。两道门, 两道都真跑:
 *   ① 结构 + 语法: 必需文件在且非空; `mobile.html` 引用的脚本存在; 每个 JS `new Function(src)` 编译一次
 *   ② 真启动探测: 有可加载 URL 时, 真用一个隐藏 iframe 加载 staged 的 mobile.html, 等它
 *      readyState=complete 且 `BolloonCore` 就位。拿不到 URL 就**如实降级**为 static-only, 并标注。
 */
export async function verifyWebLayer(store: WebResourceStore, prefix: string, opts: { bootTimeoutMs?: number } = {}): Promise<BootProbeResult> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const present: Record<string, string> = {};
  for (const f of MOBILE_WEB_REQUIRED_FILES) {
    const text = await store.readText(joinRel(prefix, f));
    const bytes = text === null ? await store.readBytes(joinRel(prefix, f)) : null;
    const size = text !== null ? text.length : (bytes?.length ?? 0);
    present[f] = String(text ?? '');
    checks.push({ name: `必需文件 ${f}`, ok: size > 0, detail: size > 0 ? `${size} 字节` : '缺失或为空' });
  }
  const html = present['mobile.html'] || '';
  const refs = scriptRefsOf(html);
  const refMiss: string[] = [];
  for (const r of refs) {
    if (/^https?:|^\/\//i.test(r)) continue;                 // 外链不算 (本项目无外链脚本)
    const rel = r.replace(/^\.\//, '').split('?')[0];
    if (!(await store.exists(joinRel(prefix, rel)))) refMiss.push(r);
  }
  checks.push({ name: 'mobile.html 引用的脚本都在', ok: refMiss.length === 0, detail: refMiss.length ? `缺失: ${refMiss.join(', ')}` : `${refs.length} 个引用都命中` });

  const syntaxBad: string[] = [];
  for (const f of MOBILE_WEB_JS_FILES) {
    const src = await store.readText(joinRel(prefix, f));
    if (src === null || src === '') continue;               // 可选文件缺失时不判错 (required 那一步已管必需件)
    try {
      // 真编译一次 (不执行): 语法错在这里就暴露, 而不是等用户打开发现白屏
      // eslint-disable-next-line no-new-func
      new Function(src);
    } catch (e: any) {
      syntaxBad.push(`${f}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  checks.push({ name: 'JS 语法自检 (真编译一次)', ok: syntaxBad.length === 0, detail: syntaxBad.length ? syntaxBad.join(' | ') : `${MOBILE_WEB_JS_FILES.length} 个文件可编译` });

  const structural = checks.every((c) => c.ok);
  if (!structural) {
    return { ok: false, mode: 'static-only', detail: `结构与语法检查未通过: ${checks.filter((c) => !c.ok).map((c) => `${c.name}(${c.detail})`).join('; ')}`, checks };
  }

  const base = store.baseUrl();
  if (!base) {
    return { ok: true, mode: 'static-only', detail: '结构 + 语法通过; 本 store 没有可加载 URL ⇒ 未做真启动探测 (如实标注, 不当成"已验证能启动")', checks };
  }
  // 有 URL 但**没有 DOM** (Node 验收 / 无窗口环境): 做不了真加载。这时必须**如实降级**成 static-only,
  // 不能把"探测不了"报成"起不来" —— 那会把所有 Node 侧安装误判成验证失败 (真跑抓到过)。
  if (!hasDom()) {
    return {
      ok: true, mode: 'static-only',
      detail: '结构 + 语法通过; 有可加载 URL 但本环境没有 DOM (非浏览器) ⇒ 未做真启动探测 (如实标注; 真探测见 scripts/verify-mobile-update-ui.ts)',
      checks,
    };
  }
  const url = `${String(base).replace(/\/+$/, '')}/${joinRel(prefix, 'mobile.html')}`;
  const probe = await iframeBootProbe(url, opts.bootTimeoutMs ?? 12000);
  checks.push({ name: '真启动探测 (iframe 加载 staged 资源)', ok: probe.ok, detail: probe.detail });
  return { ok: probe.ok, mode: 'iframe', detail: probe.ok ? `真启动探测通过: ${probe.detail}` : `真启动探测失败: ${probe.detail}`, checks };
}

/** 有没有可用的 DOM (决定能不能做 iframe 真启动探测) */
export function hasDom(): boolean {
  const d: any = (globalThis as any).document;
  return !!(d && typeof d.createElement === 'function');
}

/** 真加载一次 (隐藏 iframe, 同源)。等 readyState=complete 且 `BolloonCore` 就位。 */
export async function iframeBootProbe(url: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const doc: any = (globalThis as any).document;
  if (!doc || typeof doc.createElement !== 'function') return { ok: false, detail: '没有 DOM, 无法做启动探测' };
  return await new Promise((resolve) => {
    let done = false;
    const frame = doc.createElement('iframe');
    frame.style.cssText = 'position:absolute;left:-9999px;width:430px;height:932px;border:0;';
    frame.setAttribute('aria-hidden', 'true');
    frame.src = url;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      try { frame.remove(); } catch { /* noop */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => {
      const w: any = (() => { try { return frame.contentWindow; } catch { return null; } })();
      finish(false, `等 ${timeoutMs}ms 未见 staged 资源启动 (readyState=${w?.document?.readyState || '未知'}, BolloonCore=${typeof w?.BolloonCore})`);
    }, timeoutMs);
    frame.onload = () => {
      let tries = 0;
      const tick = () => {
        tries++;
        let w: any = null;
        try { w = frame.contentWindow; } catch { /* 跨域 */ }
        const d = w?.document;
        if (d && d.readyState === 'complete' && d.querySelector && d.querySelector('.tabbar') && w.BolloonCore && typeof w.BolloonCore === 'object') {
          clearTimeout(timer);
          finish(true, `staged 资源真起来了 (tabbar + BolloonCore, ${tries} 次探测)`);
          return;
        }
        if (tries > 60) {
          clearTimeout(timer);
          finish(false, `staged 资源加载完但没起来 (readyState=${d?.readyState || '未知'}, tabbar=${!!d?.querySelector?.('.tabbar')}, BolloonCore=${typeof w?.BolloonCore})`);
          return;
        }
        setTimeout(tick, 150);
      };
      tick();
    };
    frame.onerror = () => { clearTimeout(timer); finish(false, 'iframe 加载失败'); };
    try { doc.body.appendChild(frame); } catch (e: any) { clearTimeout(timer); finish(false, `挂载 iframe 失败: ${e?.message || e}`); }
  });
}

// ── 准备 (下载 → 校验 → 落到 staging → 验证) ────────────────────────────────

export type MobileUpdateStage =
  | 'planned' | 'downloading' | 'downloaded' | 'extracting' | 'staged' | 'verifying'
  | 'awaiting_human' | 'switching' | 'succeeded' | 'failed' | 'rolled_back' | 'blocked';

export interface PrepareOutcome {
  ok: boolean;
  stage: MobileUpdateStage;
  /** 失败在哪一步 (stage 是最终结果) */
  failedAt?: MobileUpdateStage;
  status: MobileWebStatus;
  from: string;
  to: string;
  reason: string;
  steps: string[];
  fileCount: number;
  digest: string | null;
  probe: BootProbeResult | null;
  skippedDownload: boolean;
}

/**
 * 把目标版本**准备到 `staging/`** 并验证 —— **一个字节都不切换 current**。
 * 这是"智能体可以自动跑到的那一步" (见 MOBILE_UPDATE_AGENT_CONTRACT), 也是人工 apply 的前半段。
 */
export async function prepareMobileUpdate(deps: MobileUpdateDeps, check?: MobileCheckResult): Promise<PrepareOutcome> {
  const store = deps.store;
  const now = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const stage = (s: MobileUpdateStage, detail: string) => { try { deps.onStage?.(s, detail); } catch { /* 回调不许影响流程 */ } };
  const steps: string[] = [];
  const mark = (s: string) => { steps.push(s); };
  const r = check || await checkMobileUpdate(deps);
  const from = r.currentVersion;
  const to = r.artifact?.identity || r.targetIdentity || from;
  const fail = async (stageName: MobileUpdateStage, status: MobileWebStatus, reason: string, extra: Partial<PrepareOutcome> = {}): Promise<PrepareOutcome> => {
    mark(`${stageName}: ${reason}`);
    await store.remove(WEB_LAYOUT.staging);
    await writeMobileUpdateState({
      lastCheck: { at: now, status: r.status, reason: r.reason, channel: r.channel, latestVersion: r.latestVersion },
      lastFailure: { at: now, stage: stageName, reason },
      autoPrepared: null,
    }, store);
    // `stage` 报"最终停在哪"而不是"哪个子步骤红了": 失败一律是 'failed', 具体位置看 failedAt。
    // (真跑抓到过: 下载失败时 stage='downloading' 会让调用方把"没装成"读成"正在下载"。)
    return { ok: false, stage: 'failed', failedAt: stageName, status, from, to, reason, steps, fileCount: 0, digest: null, probe: null, skippedDownload: false, ...extra };
  };

  if (refused(r.status)) {
    return fail('blocked', r.status, `拒绝更新 (${r.status}): ${r.reason || '源不可达 / 版本不存在'}`, { stage: 'blocked' });
  }
  if (r.status === 'up_to_date') {
    mark(`up_to_date: ${r.reason || '已是最新'}`);
    return { ok: false, stage: 'blocked', status: 'up_to_date', from, to, reason: `已是最新 (${from}), 无需更新`, steps, fileCount: 0, digest: null, probe: null, skippedDownload: true };
  }
  if (!r.artifact) return fail('planned', 'target_unpublished', '没有可执行的下载计划 (artifact 缺失)');

  // 已经有同样身份的 staging 且自报验证过 → 复用 (智能体先自动准备好, 人再确认切换)
  const prevState = await readMobileUpdateState(store);
  if (prevState.autoPrepared?.identity === to && (await store.exists(joinRel(WEB_LAYOUT.staging, 'mobile.html')))) {
    mark(`reuse-staging: 复用已准备并验证过的 ${to}`);
    const probe = await verifyWebLayer(store, WEB_LAYOUT.staging, { bootTimeoutMs: deps.bootTimeoutMs });
    if (probe.ok) {
      return { ok: true, stage: 'awaiting_human', status: 'update_available', from, to, reason: `staging 里已有验证过的 ${to} (digest ${prevState.autoPrepared.digest || '无'}) — 等人工确认切换`, steps, fileCount: 0, digest: prevState.autoPrepared.digest, probe, skippedDownload: true };
    }
    mark('reuse-staging: 复用的 staging 没通过验证 → 重新下载');
  }

  // 1. 下载
  stage('downloading', `${r.artifact.channel} · ${r.artifact.identity} ← ${r.artifact.url}`);
  mark(`downloading: ${r.artifact.url}`);
  const dl = await downloadArtifact(r.artifact, deps);
  if (!dl.ok || !dl.bytes) {
    return fail('downloading', dl.status || 'registry_unavailable', dl.detail);
  }
  stage('downloaded', `已下载 ${(dl.bytes.length / 1048576).toFixed(2)} MiB · ${dl.detail}`);
  mark(`downloaded: ${(dl.bytes.length / 1048576).toFixed(2)} MiB · ${dl.detail}`);

  // 2. 解压 (gzip + tar 都在本文件里, 不依赖 node:)
  stage('extracting', '解压 tar.gz 并挑出 web 资源 (dist/web)');
  const tarBytes = await gunzipBytes(dl.bytes);
  if (!tarBytes) {
    return fail('extracting', 'decompress_unavailable',
      'decompress_unavailable: 本机 WebView 没有 DecompressionStream(\'gzip\') ⇒ 无法解开 tar.gz — 拒绝 (不装半个)。'
      + ' iOS 16.4+ / Chrome 80+ 才有; 旧 WebView 请升级系统或走商店更新整个 App。');
  }
  const entries = untarBytes(tarBytes);
  const { files, snapshot } = pickWebLayer(entries);
  if (files.length === 0) {
    return fail('extracting', 'web_bundle_malformed', `web_bundle_malformed: 包里没有 dist/web/** 资源 (tar 条目 ${entries.length} 个) — 拒绝`);
  }
  mark(`extracting: ${files.length} 个 web 文件, 包内 snapshot 标记 = ${snapshot ? `有 (sha ${String(snapshot.sha || '').slice(0, 7)})` : '无'}`);

  // 3. dev 身份核对 (包必须自报 GitHub master 的那个 commit)
  if (r.artifact.channel === 'dev') {
    const want = (r.artifact.expectedDevSha || '').slice(0, 7);
    const got = snapshot?.sha ? String(snapshot.sha).slice(0, 7) : null;
    if (!snapshot) {
      return fail('extracting', 'dev_sha_mismatch', `dev_sha_mismatch: dev web 包里没有 .bolloon-dev-snapshot.json ⇒ 无法证明它是 ${want} 的快照 — 拒绝`);
    }
    if (snapshot.channel !== 'dev') {
      return fail('extracting', 'dev_sha_mismatch', `dev_sha_mismatch: 包内 snapshot 标的是 channel=${snapshot.channel} (不是 dev) — 拒绝`);
    }
    if (!got || got !== want) {
      return fail('extracting', 'dev_sha_mismatch', `dev_sha_mismatch: 包内 sha=${got || '空'} ≠ GitHub master HEAD ${want} — 拒绝安装身份对不上的快照`);
    }
    if (snapshot.identity && to && String(snapshot.identity) !== to) {
      return fail('extracting', 'dev_sha_mismatch', `dev_sha_mismatch: 包内 identity=${snapshot.identity} 与目标身份 ${to} 不一致 — 拒绝`);
    }
  }

  // 4. 落 staging (先清空, 半份 staging 比没有更危险)
  await store.remove(WEB_LAYOUT.staging);
  for (const f of files) await store.writeBytes(joinRel(WEB_LAYOUT.staging, f.rel), f.data);
  stage('staged', `${files.length} 个文件已写入 ${store.rootLabel}/${WEB_LAYOUT.staging}`);
  mark(`staged: ${files.length} 个文件 → ${WEB_LAYOUT.staging}`);

  // 5. 验证 (结构 + 语法 + 真启动探测)
  stage('verifying', '验证 staging 能不能启动 (结构 + 语法 + iframe 真加载)');
  const probe = await verifyWebLayer(store, WEB_LAYOUT.staging, { bootTimeoutMs: deps.bootTimeoutMs });
  mark(`verifying: ${probe.mode} — ${probe.detail}`);
  if (!probe.ok) {
    return fail('verifying', 'web_bundle_malformed', `切换前验证失败 (staged 资源起不来): ${probe.detail}`, { probe });
  }
  const digest = dl.digest.matched === true ? `${dl.digest.algo}:${dl.digest.hex || dl.digest.b64}` : null;
  await writeMobileUpdateState({
    lastCheck: { at: now, status: r.status, reason: r.reason, channel: r.channel, latestVersion: r.latestVersion },
    autoPrepared: { identity: to, digest, verifiedAt: now, steps: steps.slice() },
  }, store);
  return { ok: true, stage: 'awaiting_human', status: 'update_available', from, to, reason: `已准备并验证 ${to} (等人工确认切换)`, steps, fileCount: files.length, digest, probe, skippedDownload: false };
}

// ── 切换 / 回滚 ─────────────────────────────────────────────────────────────

export interface ApplyOutcome {
  ok: boolean;
  stage: MobileUpdateStage;
  failedAt?: MobileUpdateStage;
  status: MobileWebStatus;
  from: string;
  to: string;
  reason: string;
  digest: string | null;
  probe: BootProbeResult | null;
  steps: string[];
  needsReload: boolean;
  durationMs: number;
}

export interface ApplyOptions extends MobileUpdateDeps {
  /**
   * **人工确认位**。智能体**不得**自己传 true (见 MOBILE_UPDATE_AGENT_CONTRACT):
   * 切换会换掉正在跑的界面与逻辑, 必须有人在环。
   */
  confirm?: boolean;
  /** 复用 staging 里已准备并验证过的资源 (智能体先自动 prepare, 人再点确认的场景) */
  reuseStaging?: boolean;
  /** 测试注入: 让切换那一步失败 (用来真跑回滚) */
  /** 注入切换失败 (验收用): true/'before_backup' = 备份前失败; 'after_backup' = 备份后失败 (这才验到真回滚) */
  failSwitch?: boolean | 'before_backup' | 'after_backup';
}

/** 切换 (原子替换) + 换完再验一次 + 失败回滚。**只有这一步会动 current**。 */
export async function applyMobileUpdate(opts: ApplyOptions): Promise<ApplyOutcome> {
  const started = Date.now();
  const store = opts.store;
  const now = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const stage = (s: MobileUpdateStage, detail: string) => { try { opts.onStage?.(s, detail); } catch { /* 回调不许影响流程 */ } };
  const r = await checkMobileUpdate(opts);
  const from = r.currentVersion;
  const to = r.artifact?.identity || r.targetIdentity || from;
  const steps: string[] = [];
  const finish = async (o: Omit<ApplyOutcome, 'durationMs' | 'steps'>): Promise<ApplyOutcome> => {
    const out: ApplyOutcome = { ...o, durationMs: Date.now() - started, steps };
    const hist = [{ at: now, from: out.from, to: out.to, stage: out.stage, reason: out.reason }];
    const st = await readMobileUpdateState(store);
    await writeMobileUpdateState({
      lastUpdate: hist[0],
      history: [...hist, ...(st.history || [])].slice(0, 20),
      lastFailure: out.ok ? null : { at: now, stage: out.failedAt || out.stage, reason: out.reason },
      needsReload: out.ok ? true : st.needsReload,
      ...(out.ok ? {
        currentVersion: out.to,
        installedChannel: (r.artifact?.channel || 'stable') as 'stable' | 'dev',
        installedDevSha: devShaFromIdentity(out.to),
        installedFrom: {
          channel: (r.artifact?.channel || 'stable') as 'stable' | 'dev',
          source: r.artifact?.source || 'unknown',
          url: r.artifact?.url || null,
          digest: out.digest,
          digestAlgo: out.digest ? out.digest.split(':')[0] : null,
          at: now,
        },
        switchableTo: (r.artifact?.channel === 'dev')
          ? { channel: 'stable' as const, source: 'npm', target: r.sourceFacts?.npm?.latest ?? null }
          : { channel: 'dev' as const, source: 'github', target: r.github?.headSha ? r.github.headSha.slice(0, 7) : null },
        // 从 dev 切回 stable 时, **保留**刚离开的那个 dev 快照 sha: 用户回头想回 dev 时知道上次是哪个
        ...(r.artifact?.channel === 'dev'
          ? { lastDevSha: devShaFromIdentity(out.to), devRef: DEV_REF, devCheckedAt: now }
          : { lastDevSha: r.installedDevSha || null }),
        autoPrepared: null,
      } : {}),
    }, store);
    return out;
  };

  if (refused(r.status)) {
    stage('blocked', `拒绝更新 (${r.status})`);
    return finish({ ok: false, stage: 'blocked', status: r.status, from, to, reason: `拒绝更新 (${r.status}): ${r.reason || '源不可达 / 版本不存在'} — 一个字节都没下载, 也没动 current`, digest: null, probe: null, needsReload: false });
  }
  if (!r.artifact) {
    stage('blocked', '没有可执行的更新');
    return finish({ ok: false, stage: 'blocked', status: r.status, from, to, reason: r.status === 'up_to_date' ? `已是最新 (${from})` : `没有可执行的更新 (${r.status})`, digest: null, probe: null, needsReload: false });
  }
  if (!opts.confirm) {
    stage('blocked', '需要人工确认');
    return finish({
      ok: false, stage: 'blocked', status: 'update_available', from, to,
      reason: 'human_confirm_required: 切换 web 资源层会换掉正在跑的界面与逻辑 — 必须有人在环 (智能体只能自动跑到 prepare/verify)',
      digest: null, probe: null, needsReload: false,
    });
  }

  // 准备 (复用或重新做一遍)
  let prep: PrepareOutcome | null = null;
  if (opts.reuseStaging) {
    stage('verifying', '复用 staging 里已准备并验证过的资源');
    const probe = await verifyWebLayer(store, WEB_LAYOUT.staging, { bootTimeoutMs: opts.bootTimeoutMs });
    if (probe.ok) {
      const st = await readMobileUpdateState(store);
      const identity = st.autoPrepared?.identity || to;
      if (identity !== to) {
        stage('blocked', `staging 的身份 ${identity} ≠ 目标 ${to}`);
        return finish({ ok: false, stage: 'blocked', status: 'web_bundle_malformed', from, to, reason: `staging 里准备的是 ${identity}, 与本次目标 ${to} 不一致 — 拒绝切换 (宁可不装, 不装错的)`, digest: null, probe, needsReload: false });
      }
      prep = { ok: true, stage: 'awaiting_human', status: 'update_available', from, to, reason: '复用 staging', steps: st.autoPrepared?.steps || [], fileCount: 0, digest: st.autoPrepared?.digest ?? null, probe, skippedDownload: true };
      steps.push(...(prep.steps || []).map((s) => `auto: ${s}`));
    }
  }
  if (!prep) {
    const p = await prepareMobileUpdate(opts, r);
    if (!p.ok) {
      return finish({ ok: false, stage: p.stage, failedAt: p.failedAt, status: p.status, from, to, reason: p.reason, digest: p.digest, probe: p.probe, needsReload: false });
    }
    prep = p;
    steps.push(...p.steps);
  }

  // ── 原生壳天花板: 接不上就不切 (装了也不会生效 ⇒ 就是假的成功) ──────────────
  if (!nativeWired(opts)) {
    stage('blocked', '原生壳还没指向可写目录 → 不切换');
    steps.push(`native_shell_not_wired: 资源已准备并验证过 (${WEB_LAYOUT.staging}), 但当前原生壳不会加载可写目录里的资源 ⇒ 切换只会把"能用的旧版本"换成"壳层加载不到的新版本" — 拒绝切换`);
    return finish({
      ok: false, stage: 'blocked', status: 'native_shell_not_wired', from, to,
      reason: 'native_shell_not_wired: 手机 App 的原生壳还指向包内资源 (没有指向可写目录), '
        + `所以这次装到 ${to} 不会生效 — 已在 ${WEB_LAYOUT.staging} 准备好并通过启动验证, 但没有切换 current。`
        + '修法 (二选一, 见 update-protocol §13.4): ① 把壳层 server.url 指向本机 http 服务的可写目录; '
        + '② 等原生层改造随商店/侧载发一次。' + NATIVE_CEILING_LINE,
      digest: prep.digest, probe: prep.probe, needsReload: false,
    });
  }

  // ── 切换: previous 备份 → staging 上位; 任何一步失败都必须回到能启动的旧资源 ──
  stage('switching', `原子替换: ${WEB_LAYOUT.current} → ${WEB_LAYOUT.previous}, ${WEB_LAYOUT.staging} → ${WEB_LAYOUT.current}`);
  const hadCurrent = await store.exists(joinRel(WEB_LAYOUT.current, 'mobile.html'));
  let backupMade = false;
  try {
    // `failSwitch` 是一个**注入点** (验收用): 'before_backup' 验"没动 current 就报 failed",
    // 'after_backup' 才验**真回滚** (previous 已存在 → 必须搬回 current)。`true` 等价于 before_backup。
    const injectAt = opts.failSwitch === true ? 'before_backup' : opts.failSwitch;
    if (injectAt === 'before_backup') throw Object.assign(new Error('注入的切换失败 (在动 current 之前)'), { injected: true });
    await store.remove(WEB_LAYOUT.previous);
    if (hadCurrent) {
      await store.rename(WEB_LAYOUT.current, WEB_LAYOUT.previous);
      backupMade = true;
    }
    if (injectAt === 'after_backup') throw Object.assign(new Error('注入的切换失败 (备份已做, staging 未上位)'), { injected: true });
    await store.rename(WEB_LAYOUT.staging, WEB_LAYOUT.current);
    steps.push(`switching: ${WEB_LAYOUT.current} 已替换 (旧资源保留在 ${WEB_LAYOUT.previous})`);
  } catch (e: any) {
    const reason = String(e?.message || e);
    // 回滚: staging 的残留清掉, previous 里那份**能启动的旧资源**搬回 current
    let rolled = false;
    try {
      await store.remove(WEB_LAYOUT.staging);
      if (backupMade) {
        await store.remove(WEB_LAYOUT.current);
        await store.rename(WEB_LAYOUT.previous, WEB_LAYOUT.current);
        rolled = true;
      } else if (hadCurrent) {
        rolled = false;                       // current 没被动过
      }
      const probeAfter = rolled || hadCurrent ? await verifyWebLayer(store, WEB_LAYOUT.current, { bootTimeoutMs: opts.bootTimeoutMs }) : null;
      steps.push(`rolled_back: ${rolled ? '已把 previous 搬回 current' : 'current 未被改动'} · 启动验证 ${probeAfter ? (probeAfter.ok ? '通过' : '未通过') : '跳过'}`);
      stage(rolled ? 'rolled_back' : 'failed', `${reason}; ${rolled ? '已回滚到旧资源' : '旧资源未被改动'}`);
      return finish({
        ok: false, stage: rolled ? 'rolled_back' : 'failed', failedAt: 'switching', status: 'update_available', from, to,
        reason: `${reason}; ${rolled ? `已回滚到 ${from} (旧资源回到 current 且验证${probeAfter?.ok ? '通过' : '未通过'})` : 'current 未被改动, 旧资源仍在'}`,
        digest: prep.digest, probe: probeAfter, needsReload: false,
      });
    } catch (e2: any) {
      stage('failed', `${reason}; 回滚过程出错: ${e2?.message || e2}`);
      return finish({
        ok: false, stage: 'failed', failedAt: 'switching', status: 'update_available', from, to,
        reason: `${reason}; 回滚过程出错: ${e2?.message || e2}`,
        digest: prep.digest, probe: null, needsReload: false,
      });
    }
  }

  // 换完再验一次 (切换本身也可能出错): 不通过就回滚
  stage('verifying', '切换后再验一次 (能不能启动)');
  const after = await verifyWebLayer(store, WEB_LAYOUT.current, { bootTimeoutMs: opts.bootTimeoutMs });
  steps.push(`post-switch verify: ${after.mode} — ${after.detail}`);
  if (!after.ok) {
    let rolled = false;
    try {
      await store.remove(WEB_LAYOUT.current);
      if (backupMade) { await store.rename(WEB_LAYOUT.previous, WEB_LAYOUT.current); rolled = true; }
      stage('rolled_back', `切换后验证失败, ${rolled ? '已回滚' : '没有可回滚的旧资源'}`);
    } catch { /* 下面按失败记 */ }
    return finish({
      ok: false, stage: rolled ? 'rolled_back' : 'failed', failedAt: 'verifying', status: 'update_available', from, to,
      reason: `切换后验证失败: ${after.detail}; ${rolled ? `已回滚到 ${from}` : '回滚失败 — 需要重装 App'}`,
      digest: prep.digest, probe: after, needsReload: false,
    });
  }

  stage('succeeded', `已切到 ${to}`);
  return finish({ ok: true, stage: 'succeeded', status: 'update_available', from, to, reason: `已更新到 ${to} (重启/重载 webview 后生效)`, digest: prep.digest, probe: after, needsReload: true });
}

/** 一键回滚到上一个能启动的资源 (人手动兜底; 智能体不得自动调, 见契约)。 */
export async function rollbackMobileUpdate(opts: MobileUpdateDeps & { confirm?: boolean }): Promise<ApplyOutcome> {
  const store = opts.store;
  const started = Date.now();
  const now = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const st = await readMobileUpdateState(store);
  const from = st.currentVersion || 'unknown';
  const steps: string[] = [];
  const finish = async (o: Omit<ApplyOutcome, 'durationMs' | 'steps'>): Promise<ApplyOutcome> => {
    const out: ApplyOutcome = { ...o, durationMs: Date.now() - started, steps };
    await writeMobileUpdateState({
      lastUpdate: { at: now, from: out.from, to: out.to, stage: out.stage, reason: out.reason },
      history: [{ at: now, from: out.from, to: out.to, stage: out.stage, reason: out.reason }, ...(st.history || [])].slice(0, 20),
    }, store);
    return out;
  };
  if (!opts.confirm) {
    return finish({ ok: false, stage: 'blocked', status: 'update_available', from, to: from, reason: 'human_confirm_required: 回滚会换掉正在跑的 web 资源 — 必须有人在环', digest: null, probe: null, needsReload: false });
  }
  if (!(await store.exists(joinRel(WEB_LAYOUT.previous, 'mobile.html')))) {
    return finish({ ok: false, stage: 'blocked', status: 'web_bundle_malformed', from, to: from, reason: `没有可回滚的旧资源 (${WEB_LAYOUT.previous} 空) — 不假装回滚过`, digest: null, probe: null, needsReload: false });
  }
  const probeBefore = await verifyWebLayer(store, WEB_LAYOUT.previous, { bootTimeoutMs: opts.bootTimeoutMs });
  steps.push(`previous 探测: ${probeBefore.detail}`);
  if (!probeBefore.ok) {
    return finish({ ok: false, stage: 'blocked', status: 'web_bundle_malformed', from, to: from, reason: `previous 里的旧资源起不来 (${probeBefore.detail}) — 回滚它只会更糟, 拒绝`, digest: null, probe: probeBefore, needsReload: false });
  }
  try {
    await store.remove(joinRel(WEB_LAYOUT.current, ''));
    await store.rename(WEB_LAYOUT.previous, WEB_LAYOUT.current);
  } catch (e: any) {
    return finish({ ok: false, stage: 'failed', failedAt: 'switching', status: 'update_available', from, to: from, reason: `回滚失败: ${e?.message || e}`, digest: null, probe: null, needsReload: false });
  }
  const after = await verifyWebLayer(store, WEB_LAYOUT.current, { bootTimeoutMs: opts.bootTimeoutMs });
  steps.push(`回滚后探测: ${after.detail}`);
  return finish({
    ok: after.ok, stage: after.ok ? 'rolled_back' : 'failed', status: 'update_available', from, to: from,
    reason: after.ok ? `已回滚到上一个资源层 (需要重载 webview 生效)` : `回滚后资源起不来: ${after.detail}`,
    digest: null, probe: after, needsReload: after.ok,
  });
}

// ── 给"未来智能体在手机自动更新"用的契约 (前置条件 + 风险边界) ─────────────

/**
 * **智能体自主更新的边界** —— 这一段是代码里的口径, wiki `update-protocol.md` §13.5 是同一份。
 *
 * 一句话: 智能体可以自动跑到"**准备并验证**", **不许**自己动 current (切换/重载/回滚),
 * 也**不许**自己切通道。理由不是"技术做不到", 而是这三件事的**代价不对称**:
 * 准备失败 = 白费流量; 切换失败 = 用户手里的 App 可能白屏 (而那时用户正需要它)。
 */
export const MOBILE_UPDATE_AGENT_CONTRACT = {
  schema: 'bolloon-mobile-agent-update/1',
  /** 可以自动做 (只读 + 只在 staging 里写, 不影响正在跑的资源) */
  autoAllowedSteps: ['check', 'prepare', 'download', 'digest-verify', 'extract', 'stage', 'verify'],
  /** 必须人在环 (会换掉正在跑的界面与逻辑 ⇒ 代价不对称) */
  humanRequiredSteps: ['switch', 'reload', 'rollback', 'channel-switch'],
  preconditions: [
    '本机 web 层的身份可读 (壳层注入 / OTA state / 构建戳 bolloon-web.json 三者之一) —— 读不到就 local_version_unknown, 不猜',
    '原生壳已指向可写目录 (native_writable) —— 否则资源准备好了也不会生效, 一律 native_shell_not_wired 并说清修法',
    '设备存储余量够 (下载物 ≤ 上限, 默认 80 MiB) —— 超了判 payload_too_large, 不赌内存',
    '本机 WebView 有 DecompressionStream(\'gzip\') (iOS 16.4+ / Chrome 80+) —— 没有就 decompress_unavailable',
    '稳定网络: 源不可达一律 offline / registry_unavailable / github_unavailable(reason) 拒绝, 不静默重试到"看起来成功"',
    '摘要可校验: npm 侧用 dist.shasum/dist.integrity; dev 侧用包内 .bolloon-dev-snapshot.json 的 sha + bundleSha256',
  ],
  riskBoundaries: [
    'iOS 原生壳层**不能自更** (App Store 规则) ⇒ 不承诺"iOS 整体自动更新"; web 层能更, 二进制走商店/TestFlight',
    'Android 侧载 APK 自更**需用户允许未知来源** ⇒ 必须显式告知 + 用户在环, 本轮不做静默装包',
    '切换前必须真跑一次"能不能启动"探测 (结构+语法+iframe), 探测不通过不许切进 current',
    '切换必须原子 (rename) 且保留 previous; 任何一步失败都要回到"能启动的旧资源"',
    'dev 通道不保证可回滚到上一个 dev 版 (与桌面同一句警告); 一键回 stable 始终可用',
    '源不可达/版本不存在/交叉校验不一致/摘要不符 ⇒ 拒绝并分类说清, 绝不静默装回旧版、绝不假装成功',
  ],
} as const;

/** 智能体入口: **只**跑到"准备好并验证过"就停, 返回 awaiting_human。 */
export async function autoPrepareMobileUpdate(deps: MobileUpdateDeps): Promise<PrepareOutcome> {
  return prepareMobileUpdate(deps);
}

// ── 报告 (与桌面同措辞的可见性) ─────────────────────────────────────────────

/** 一行"当前源身份"(与桌面 `update status` 同措辞) + 手机端特有的两行 (层 / 自更能力)。 */
export function renderMobileUpdateReport(r: MobileCheckResult, st?: MobileUpdateState | null): string[] {
  const L: string[] = [];
  L.push(r.identityLine);
  L.push(`更新层:     web 资源层 (界面与逻辑: 入群 / 发任务公告 / 看飞轮进度 / 授权签名) · store=${r.storeKind}`);
  L.push(`能切回:     ${r.switchableTo ? `${r.switchableTo.channel} (${r.switchableTo.source}${r.switchableTo.target ? ` @ ${r.switchableTo.target}` : ''})` : '无 (未知来源)'}`);
  L.push(`目标版本:   ${r.targetIdentity || r.latestVersion || '未知'}`);
  L.push(`更新通道:   ${r.channel} (比较语义: ${r.channelKind})`);
  L.push(renderGithubReportLine(r.github));
  if (r.crossCheck) L.push(`交叉校验:   ${r.crossCheck.kind}${r.crossCheck.blocking ? ' (阻塞)' : ''} — ${r.crossCheck.detail}`);
  if (r.dev) L.push(`dev 判定:   ${r.dev.detail}`);
  if (r.sourceFacts?.npm) L.push(`npm 源:     ${r.sourceFacts.npm.reachable ? `可达 (latest=${r.sourceFacts.npm.latest || '未知'})` : `不可达 (${r.sourceFacts.npm.detail || '未知'})`}`);
  if (st?.installedFrom) L.push(`当前来源:   ${st.installedFrom.channel} · ${st.installedFrom.source}${st.installedFrom.digest ? ` · 摘要 ${st.installedFrom.digest}` : ''}${st.installedFrom.at ? ` · ${st.installedFrom.at}` : ''}`);
  if (st?.lastDevSha && r.installedChannel !== 'dev') L.push(`上次 dev:   commit ${st.lastDevSha} (已切回 stable)`);
  L.push(`结论:       ${r.status}${refused(r.status) ? ' — 拒绝 (没有安装任何东西)' : ''}`);
  if (r.reason) L.push(`说明:       ${r.reason}`);
  for (const w of r.warnings) L.push(w);
  return L;
}

/** 手机端(和所有人)必须知道的原生层天花板 —— UI 直接显示这一句。 */
export const NATIVE_CEILING_LINE =
  '原生壳层不能在这里自更: iOS 受 App Store 规则限制 (二进制走商店/TestFlight), Android 侧载 APK 自更需要你允许"未知来源" —— 这里能自动更新的是 web 资源层 (界面与逻辑)。';

export { UPSTREAM_REPO, DEV_IDENTITY_SEP };

// ── 真机 store 自动选 / 通道偏好 / 重载 ─────────────────────────────────────

/** 通道偏好的本机键 (localStorage; 拿不到就退回 state.json) */
export const MOBILE_CHANNEL_KEY = 'bolloon.update.channel';

/** 真机: 有 Capacitor Filesystem 就用可写数据目录; 没有 (浏览器/验收) 就用内存 store。 */
export function createAutoWebStore(): WebResourceStore {
  // 壳层可以塞自己的 store (例如用原生文件系统插件实现同一套接口) —— 验收 harness 也走这个口子,
  // 这样"真浏览器里跑真流水线"用的是同一条代码路径, 不另开一条后门。
  const injected = (globalThis as any).__bolloonWebStore;
  if (injected && typeof injected.writeBytes === 'function' && typeof injected.rename === 'function') return injected;
  const cap: any = (globalThis as any).Capacitor;
  const fs = cap?.Plugins?.Filesystem;
  if (fs && typeof fs.writeFile === 'function') {
    const base = (globalThis as any).__bolloonWebBaseUrl || null;
    return createCapacitorWebStore(fs, { basePath: 'bolloon-web', directory: 'DATA', baseUrl: base });
  }
  return createMemoryWebStore({ kind: 'memory', rootLabel: 'memory://webview', baseUrl: (globalThis as any).__bolloonWebBaseUrl || null });
}

export function storedMobileChannel(): string | null {
  try {
    const v = (globalThis as any).localStorage?.getItem?.(MOBILE_CHANNEL_KEY);
    return v ? String(v) : null;
  } catch { return null; }
}

/**
 * 切通道 —— **只写偏好, 不装东西** (装是 apply 的事)。非法值 → 不猜, 保持原通道并如实返回。
 */
export async function setMobileUpdateChannel(channel: string, store?: WebResourceStore): Promise<{ ok: boolean; channel: UpdateChannel; detail: string }> {
  const want = String(channel || '').toLowerCase();
  if (want !== 'stable' && want !== 'dev') {
    const cur = (storedMobileChannel() as UpdateChannel) || 'stable';
    return { ok: false, channel: cur, detail: `未知通道 "${channel}" (只有 stable / dev) — 保持 ${cur}` };
  }
  const prev = storedMobileChannel();
  try { (globalThis as any).localStorage?.setItem?.(MOBILE_CHANNEL_KEY, want); } catch { /* 存不上就只对本次会话有效 */ }
  if (store) await writeMobileUpdateState({ channelPref: want as UpdateChannel }, store);
  return { ok: true, channel: want as UpdateChannel, detail: `通道 ${prev || 'stable'} → ${want} (只改偏好, 还没有安装任何东西; 点「检查更新」再决定装不装)` };
}

/**
 * 让新装的 web 资源生效 —— **人在环**的最后一步。
 * Capacitor 壳层能重载就重载 WebView; 否则退回 `location.reload()`。
 * 非浏览器环境 (单测/Node 验收) 如实返回 `none`, **不假装重载过**。
 */
export async function reloadMobileWeb(): Promise<{ ok: boolean; how: string; detail: string }> {
  const cap: any = (globalThis as any).Capacitor;
  try {
    if (cap?.Plugins?.WebView?.reload) {
      await cap.Plugins.WebView.reload();
      return { ok: true, how: 'capacitor-webview', detail: '已请求 WebView 重载 (新 web 资源生效)' };
    }
  } catch (e: any) {
    return { ok: false, how: 'capacitor-webview', detail: `WebView 重载失败: ${String(e?.message || e)} — 请手动重启 App` };
  }
  const loc: any = (globalThis as any).location;
  if (loc && typeof loc.reload === 'function') {
    loc.reload();
    return { ok: true, how: 'location.reload', detail: '已重载页面' };
  }
  return { ok: false, how: 'none', detail: '本环境没有可重载的 WebView (验收/Node) — 未假装重载' };
}

