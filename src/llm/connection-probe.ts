/**
 * connection-probe.ts — API URL 完整切换链路的**独立探测原语** (P4, 2026-09-26)
 *
 * ## 修的是什么
 *
 * 换供应商 / 换 API URL 时, 失败一直只有两种说法: 一句"切换成功", 或一句笼统的"连接失败"。
 * 用户分不清到底是
 *
 *   URL 写错了 · key 不对 · 服务没起来 · 模型名不存在 · 端点其实是另一个协议 ·
 *   模型不支持工具调用 · 还是网络干脆挂住了
 *
 * 更糟的是有的路径在连不上时**静默退回默认 URL** —— 于是出现"我明明填了内网地址, 请求却打到
 * 了公网"这种**隐藏 URL**。
 *
 * 本模块把整条链路做成**一个可判定、失败必分 7 类的原语**:
 *
 * ```
 * 解析 URL(显式 --base-url > 配置里的 provider baseUrl > provider 默认 URL > 环境变量覆盖)
 *   → 规范化 + 合并重复 /v1 → 协议形状校验 → 轻量连接探测
 *   → 模型接口可用 → 工具调用能力 → 全通过才判 ok
 * ```
 *
 * 三条硬规则 (写在实现里, 不是文档里):
 *
 *   ① **失败绝不静默退回旧/默认**。选中哪一层来源会被显式记进 `baseUrlSource`; 选中的那一层
 *      若是畸形 URL, 直接 `invalid_url` —— **不会**"悄悄地试下一层"。四层全空也是 `invalid_url`,
 *      不编一个默认出来 (只有"真的没给"(缺失/纯空白)才轮到下一层, 这与"给了但写错了"是两件事)。
 *   ② **失败绝不当作成功**。任何一步没过 ⇒ `ok === false` 且 `failureClass` 必非空。
 *   ③ **凭证只进请求头, 永不进返回值**。只回凭证**引用名** (`authRef`, 如 `env:DEEPSEEK_API_KEY`),
 *      返回值与错误信息里都没有任何 key 值。
 *
 * ## 为什么是"独立原语"
 *
 * 本文件**不 import** 切换入口 (`model-selection.ts`) 的任何运行时符号 (只用 `import type` 拿
 * 协议类型, 编译期即擦除), 也不碰配置存储 —— 加载它零副作用, 任何一层都能按需调用。
 * URL 规范化与入口里的 `normalizeBaseUrl()` **语义刻意保持一致**, 并有一条单测逐例比对两者:
 * 一旦分叉立刻判红, 这样原语被接进入口时不会出现"两处真相"。
 */

import type { ModelProtocol } from './model-selection.js';

// ============================================================
// 失败分类 (7 类, 冻结)
// ============================================================

/**
 * 探测失败的 7 个类别。**只准这 7 个** —— 多一个少一个都算接口变了。
 * 顺序不代表优先级, 只是给门/报告一个稳定的枚举次序。
 */
export const PROBE_FAILURE_CLASSES = [
  'invalid_url',
  'auth_failed',
  'provider_unreachable',
  'model_not_found',
  'protocol_mismatch',
  'tool_call_unsupported',
  'timeout',
] as const;

export type ProbeFailureClass = (typeof PROBE_FAILURE_CLASSES)[number];

/** 每类失败的**人话理由** (界面直接显示; 不改写事实, 只翻译类别) */
export const PROBE_FAILURE_ZH: Record<ProbeFailureClass, string> = {
  invalid_url: 'URL 写错了, 或这个地址上根本没有服务端点',
  auth_failed: '凭证被拒 (401/403), 或本地取不到这个凭证引用指向的密钥',
  provider_unreachable: '连不上供应商 (拒绝连接/网络不可达/上游 5xx/被限流)',
  model_not_found: '端点可达, 但它不认识这个模型名',
  protocol_mismatch: '这个地址上的服务不是该协议 (端点上没有本协议的端点, 或回的是另一种协议的形状)',
  tool_call_unsupported: '模型/端点不接受工具调用声明',
  timeout: '探测超时 (在超时时间内没有任何响应)',
};

/** 工具调用能力的三态结论。没有真证据必须是 `unknown` —— 不许用 `no` 冒充"不支持" */
export type ProbeCapability = 'yes' | 'no' | 'unknown';

// ============================================================
// URL 解析 (四层优先级, 冻结顺序)
// ============================================================

/** base URL 来自哪一层 */
export type BaseUrlSource = 'explicit' | 'configured' | 'provider' | 'env';

/** 四层来源的固定优先级 (与计划一致: 显式 > 配置 > 供应商默认 > 环境变量) */
export const BASE_URL_PRIORITY = ['explicit', 'configured', 'provider', 'env'] as const;

export interface ChainUrlSources {
  /** 显式 `--base-url` */
  explicit?: string;
  /** 配置里该 provider 的 baseUrl */
  configured?: string;
  /** provider 注册表里的默认 URL */
  providerDefault?: string;
  /** 环境变量覆盖: 变量名 (值从 `process.env` 读) */
  envVar?: string;
  /** 环境变量覆盖: 直接给值 (给了就不读环境; 测试与宿主注入用) */
  envValue?: string;
}

/** 「给了但写错了」与「没给」是两件事 —— 只有后者才算"这一层没意见" */
function isGiven(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 归一化 + **合并重复 `/v1`**。
 *
 * 与切换入口的 `normalizeBaseUrl()` 逐例一致 (单测比对)。重复 `/v1` 只处理**结尾**叠加
 * (`/v1/v1` → `/v1`), 因为 `…/v1/gateway/v1` 这种中间重复可能是服务端真实路径, 合并它就是
 * 改用户的地址。`schema://host` 里的 `//` 不动。
 */
export function normalizeChainUrl(raw: string): string {
  let u = String(raw ?? '').trim();
  if (!u) return '';
  u = u.replace(/([^:])\/{2,}/g, '$1/'); // 折叠重复斜杠 (保留协议后的 ://)
  u = u.replace(/\/+$/g, ''); // 去尾部斜杠
  u = u.replace(/(\/v\d+)(\/v\d+)+$/i, '$1'); // 合并结尾重复的 /vN
  return u;
}

/** URL 形状校验 (只查形状, 不查可达性)。`ok:false` 时 reason 是人话。 */
export function validateChainUrlShape(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const url = normalizeChainUrl(raw);
  if (!url) return { ok: false, reason: 'URL 为空' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `不是合法 URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `只支持 http/https, 收到 ${parsed.protocol}` };
  }
  if (!parsed.hostname) return { ok: false, reason: '缺少主机名' };
  return { ok: true, url };
}

export interface ChainUrlResolution {
  /** 最终会用的 URL (规范化 + 合并重复 /v1 之后); 四层全空时是 `''` */
  baseUrl: string;
  /** 它来自哪一层 (`null` = 没有任何一层给过) */
  source: BaseUrlSource | null;
  /** 选中的那一层的**原始**串 (排障用; 不想让人猜"规范化改了什么") */
  raw: string;
}

/**
 * 四层优先级解析 —— **纯函数**, 不读盘 (环境那一层的值由调用方给, 或在此从传入的 env 取)。
 *
 * 关键语义: 一旦某一层**真的给了值**, 就它的 (哪怕写错了) —— 不继续往下找。
 * 只有"没给 / 纯空白"才轮到下一层。这样"填错 URL"永远不会被一个默认值悄悄盖掉。
 */
export function resolveChainBaseUrl(s: ChainUrlSources, env: NodeJS.ProcessEnv = process.env): ChainUrlResolution {
  const envFromName = isGiven(s.envVar) ? env[String(s.envVar).trim()] : undefined;
  const layers: Array<{ source: BaseUrlSource; value: unknown }> = [
    { source: 'explicit', value: s.explicit },
    { source: 'configured', value: s.configured },
    { source: 'provider', value: s.providerDefault },
    { source: 'env', value: isGiven(s.envValue) ? s.envValue : envFromName },
  ];
  for (const { source, value } of layers) {
    if (!isGiven(value)) continue;
    const raw = String(value).trim();
    return { baseUrl: normalizeChainUrl(raw), source, raw };
  }
  return { baseUrl: '', source: null, raw: '' };
}

// ============================================================
// 凭证引用 (只解析, 永不回显)
// ============================================================

/** 拆解凭证引用名。**只拆名字, 不取值** */
export function parseAuthRef(ref: string | undefined): { kind: 'none' | 'env' | 'provider'; name: string } {
  const r = String(ref ?? '').trim();
  if (!r || r === 'none') return { kind: 'none', name: '' };
  const i = r.indexOf(':');
  if (i < 0) return { kind: 'provider', name: r };
  const kind = r.slice(0, i);
  const name = r.slice(i + 1);
  if (kind === 'env') return { kind: 'env', name };
  return { kind: 'provider', name };
}

/** 默认凭证解析: 只认 `env:<VAR>`; `provider:<id>` 的值在配置存储里, 由宿主注入 */
export async function defaultResolveSecret(ref: string): Promise<string | undefined> {
  const { kind, name } = parseAuthRef(ref);
  if (kind === 'env') {
    const v = process.env[name];
    return isGiven(v) ? String(v).trim() : undefined;
  }
  return undefined;
}

// ============================================================
// 协议形状 (每种协议: 目录端点 / 请求头 / 模型调用 / 工具调用)
// ============================================================

type Json = any;

interface ProtocolShape {
  protocol: ModelProtocol;
  label: string;
  /** 目录/连通端点 (相对 base 的路径) */
  catalogPath: string;
  headers: (apiKey: string | undefined) => Record<string, string>;
  parseCatalog: (body: Json) => string[] | null;
  modelRequest: (base: string, model: string, apiKey: string | undefined) => { url: string; init: RequestInit };
  toolRequest: (base: string, model: string, apiKey: string | undefined) => { url: string; init: RequestInit };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PROBE_TOOL = {
  name: 'probe_tool',
  description: '连接探测用, 不需要真正执行',
  parameters: { type: 'object', properties: {} },
};

function listIds(ids: unknown[], pick: (x: Json) => unknown): string[] {
  const out: string[] = [];
  for (const x of ids) {
    const v = pick(x);
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

const OPENAI_COMPATIBLE: ProtocolShape = {
  protocol: 'openai-compatible',
  label: 'OpenAI 兼容',
  catalogPath: '/models',
  headers: (k) => (k ? { ...JSON_HEADERS, Authorization: `Bearer ${k}` } : { ...JSON_HEADERS }),
  parseCatalog: (b) => {
    if (!Array.isArray(b?.data)) return null;
    const ids = listIds(b.data, (x) => (typeof x === 'string' ? x : x?.id ?? x?.name));
    return ids.length ? ids : null;
  },
  modelRequest: (base, model, k) => ({
    url: `${base}/chat/completions`,
    init: {
      method: 'POST',
      headers: OPENAI_COMPATIBLE.headers(k),
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'probe' }] }),
    },
  }),
  toolRequest: (base, model, k) => ({
    url: `${base}/chat/completions`,
    init: {
      method: 'POST',
      headers: OPENAI_COMPATIBLE.headers(k),
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'probe' }],
        tools: [{ type: 'function', function: PROBE_TOOL }],
        tool_choice: 'auto',
      }),
    },
  }),
};

const ANTHROPIC: ProtocolShape = {
  protocol: 'anthropic',
  label: 'Anthropic',
  catalogPath: '/models',
  headers: (k) => {
    const h: Record<string, string> = { ...JSON_HEADERS, 'anthropic-version': '2023-06-01' };
    if (k) h['x-api-key'] = k;
    return h;
  },
  parseCatalog: (b) => {
    if (!Array.isArray(b?.data)) return null;
    const ids = listIds(b.data, (x) => (typeof x === 'string' ? x : x?.id ?? x?.name));
    return ids.length ? ids : null;
  },
  modelRequest: (base, model, k) => ({
    url: `${base}/messages`,
    init: {
      method: 'POST',
      headers: ANTHROPIC.headers(k),
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'probe' }] }),
    },
  }),
  toolRequest: (base, model, k) => ({
    url: `${base}/messages`,
    init: {
      method: 'POST',
      headers: ANTHROPIC.headers(k),
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'probe' }],
        tools: [{ name: PROBE_TOOL.name, description: PROBE_TOOL.description, input_schema: PROBE_TOOL.parameters }],
      }),
    },
  }),
};

const GEMINI: ProtocolShape = {
  protocol: 'gemini',
  label: 'Gemini',
  catalogPath: '/models',
  headers: (k) => (k ? { ...JSON_HEADERS, 'x-goog-api-key': k } : { ...JSON_HEADERS }),
  parseCatalog: (b) => {
    if (!Array.isArray(b?.models)) return null;
    const ids = listIds(b.models, (x) => {
      const n = typeof x === 'string' ? x : x?.name ?? x?.id;
      return typeof n === 'string' ? n.replace(/^models\//, '') : n;
    });
    return ids.length ? ids : null;
  },
  modelRequest: (base, model, k) => ({
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: 'POST',
      headers: GEMINI.headers(k),
      body: JSON.stringify({ contents: [{ parts: [{ text: 'probe' }] }] }),
    },
  }),
  toolRequest: (base, model, k) => ({
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: 'POST',
      headers: GEMINI.headers(k),
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'probe' }] }],
        tools: [{
          functionDeclarations: [{
            name: PROBE_TOOL.name,
            description: PROBE_TOOL.description,
            parameters: { type: 'OBJECT', properties: {} },
          }],
        }],
      }),
    },
  }),
};

const OLLAMA: ProtocolShape = {
  protocol: 'ollama',
  label: 'Ollama / 本地',
  catalogPath: '/api/tags',
  headers: (k) => (k ? { ...JSON_HEADERS, Authorization: `Bearer ${k}` } : { ...JSON_HEADERS }),
  parseCatalog: (b) => {
    if (!Array.isArray(b?.models)) return null;
    const ids = listIds(b.models, (x) => (typeof x === 'string' ? x : x?.name ?? x?.model));
    return ids.length ? ids : null;
  },
  modelRequest: (base, model, k) => ({
    url: `${base}/api/chat`,
    init: {
      method: 'POST',
      headers: OLLAMA.headers(k),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'probe' }], stream: false }),
    },
  }),
  toolRequest: (base, model, k) => ({
    url: `${base}/api/chat`,
    init: {
      method: 'POST',
      headers: OLLAMA.headers(k),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'probe' }],
        stream: false,
        tools: [{ type: 'function', function: PROBE_TOOL }],
      }),
    },
  }),
};

const PROTOCOL_SHAPES: Record<string, ProtocolShape> = {
  'openai-compatible': OPENAI_COMPATIBLE,
  anthropic: ANTHROPIC,
  gemini: GEMINI,
  ollama: OLLAMA,
};

/** 支持的协议名 (报告/错误信息用) */
export function supportedProtocols(): string[] {
  return Object.keys(PROTOCOL_SHAPES);
}

// ============================================================
// 响应信封识别 (判断"这个端点回的是哪种协议的形状")
// ============================================================

/** 从一段目录响应体里认出它是**哪种协议**的形状; 认不出 → `null` */
export function envelopeProtocolOf(body: Json): ModelProtocol | null {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.models)) {
    const m0 = body.models[0];
    if (!m0 || typeof m0 !== 'object') return null;
    const name = String(m0.name ?? m0.model ?? '');
    if (name.startsWith('models/')) return 'gemini';
    if (m0.digest !== undefined || m0.size !== undefined || m0.modified_at !== undefined) return 'ollama';
    if (name) return 'ollama';
    return null;
  }
  if (Array.isArray(body.data)) {
    const d0 = body.data[0];
    if (d0 && typeof d0 === 'object') {
      if (d0.type === 'model' || d0.display_name !== undefined || body.has_more !== undefined) return 'anthropic';
      if (typeof d0.object === 'string' || body.object === 'list') return 'openai-compatible';
    }
    if (body.object === 'list') return 'openai-compatible';
    return null;
  }
  return null;
}

// ============================================================
// 单个请求: 超时 + 网络错误分类
// ============================================================

export const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** 超时标记 —— 由调用方持有, 抛错后依然可读 (不靠猜错误文本) */
export interface TimeoutFlag { timedOut: boolean }

/**
 * 带超时的 fetch。超时会 `abort()`, 并把调用方给的 `flag.timedOut` 置真 ——
 * 于是**即便这次 fetch 抛错** (abort 会抛), 分类也能确定地判成 `timeout`。
 */
export async function fetchWithProbeTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  flag: TimeoutFlag = { timedOut: false },
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { flag.timedOut = true; ctrl.abort(); }, Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 网络层错误 → 类别 + 人话 (超时/主机名解析失败/拒绝连接/不可达) */
export function classifyNetworkError(err: unknown, flag: TimeoutFlag, timeoutMs: number): { failureClass: ProbeFailureClass; detail: string } {
  const msg = String((err as any)?.message ?? err ?? '未知错误');
  const code = String((err as any)?.code ?? (err as any)?.cause?.code ?? '');
  const name = String((err as any)?.name ?? '');
  if (flag.timedOut || name === 'AbortError' || /abort/i.test(msg)) {
    return { failureClass: 'timeout', detail: `超时: ${timeoutMs}ms 内没有任何响应` };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_INVALID_URL/i.test(`${code} ${msg}`)) {
    return { failureClass: 'invalid_url', detail: `主机名解析失败 — 检查 URL 主机名 (${code || msg})` };
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ECONNABORTED|UND_ERR/i.test(`${code} ${name} ${msg}`)) {
    return { failureClass: 'provider_unreachable', detail: `拒绝连接/网络不可达 (${code || msg})` };
  }
  return { failureClass: 'provider_unreachable', detail: `连接失败: ${msg}` };
}

/** 响应体读成 JSON; 不是 JSON 就给 `null` (不抛) */
async function readJson(res: Response): Promise<Json | null> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 响应片段 (最多 200 字) —— 只用于人话理由; 不含请求头, 因此不会带出凭证 */
export function snippetOf(body: Json | null, res: Response): string {
  if (body && typeof body === 'object') {
    const m = body?.error?.message ?? body?.message ?? body?.error ?? body?.detail;
    if (typeof m === 'string' && m) return m.slice(0, 200);
  }
  return `HTTP ${res.status}`;
}

/**
 * 非 2xx 状态码 → 类别 (目录/模型调用/工具调用共用的那一半)。
 * 2xx → `null` (交给上层继续解析响应体)。
 */
export function classifyStatus(
  res: Response,
  body: Json | null,
  url: string,
  context: 'catalog' | 'model' | 'tool',
): { failureClass: ProbeFailureClass; detail: string } | null {
  const s = res.status;
  if (s >= 200 && s < 300) return null;
  const text = JSON.stringify(body ?? '').slice(0, 400);
  if (s === 401 || s === 403) return { failureClass: 'auth_failed', detail: `凭证被拒 (HTTP ${s}) — ${snippetOf(body, res)}` };
  if (s === 404 || s === 405) {
    if (context !== 'catalog' && /model/i.test(`${url} ${text}`)) {
      return { failureClass: 'model_not_found', detail: `模型接口不存在 (HTTP ${s}) — ${snippetOf(body, res)}` };
    }
    return { failureClass: 'invalid_url', detail: `端点不存在 (HTTP ${s}) @ ${url} — ${snippetOf(body, res)}` };
  }
  if (s === 429) return { failureClass: 'provider_unreachable', detail: `被限流 (HTTP 429) — ${snippetOf(body, res)}` };
  if (s >= 500) return { failureClass: 'provider_unreachable', detail: `上游错误 (HTTP ${s}) — ${snippetOf(body, res)}` };
  // 其余 4xx: 端点收到了请求但拒绝了这个形状
  if (context === 'tool' && /tool|function/i.test(text)) {
    return { failureClass: 'tool_call_unsupported', detail: `不接受工具调用声明 (HTTP ${s}) — ${snippetOf(body, res)}` };
  }
  return { failureClass: 'protocol_mismatch', detail: `端点拒绝了本协议的请求 (HTTP ${s}) — ${snippetOf(body, res)}` };
}

// ============================================================
// 交叉判定: "这个地址上的服务其实是另一个协议"
// ============================================================

/**
 * 在**服务根**上试几种协议的知名目录端点, 认出端点真实是哪种协议。
 *
 * 只在主目录端点没给出本协议形状时调用 —— 用它把三件事分开:
 *   · 协议不对 (另一个协议在这台服务上有端点)         → `protocol_mismatch`
 *   · 同协议但路径不对 (同协议的端点出现在另一个路径) → `invalid_url` + 线索
 *   · 什么都没有                                      → 按状态码给类别, 不硬说协议不符
 * 认不出 → `null`。
 */
export async function detectForeignProtocol(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ protocol: ModelProtocol; url: string } | null> {
  const candidates = [`${origin}/api/tags`, `${origin}/v1beta/models`, `${origin}/v1/models`];
  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await fetchWithProbeTimeout(url, { method: 'GET' }, Math.min(timeoutMs, 3000), fetchImpl);
      if (!res.ok) continue;
      const body = await readJson(res);
      const kind = envelopeProtocolOf(body);
      if (kind) return { protocol: kind, url };
    } catch { /* 这条试不通 → 试下一条 */ }
  }
  return null;
}

// ============================================================
// 探测结果
// ============================================================

export type ProbeStep = 'url' | 'protocol' | 'credential' | 'connect' | 'model' | 'tool_call';

export interface ProbeCheck {
  step: ProbeStep;
  ok: boolean;
  /** 本步的**事实** (不是结论性形容词) */
  detail: string;
}

export interface ProbeRequest {
  providerId: string;
  /** 显式 `--base-url` (最高优先级) */
  baseUrl?: string;
  /** 配置里该 provider 的 baseUrl (第二优先) */
  configuredBaseUrl?: string;
  /** provider 注册表里的默认 URL (第三优先) */
  providerDefaultUrl?: string;
  /** 环境变量覆盖的**变量名** (最低优先); 值从 `process.env` 读, 或用 `envBaseUrlValue` 直接给 */
  envBaseUrlVar?: string;
  envBaseUrlValue?: string;
  protocol: ModelProtocol;
  model: string;
  /** 凭证**引用名** (`provider:<id>` / `env:<VAR>` / `none`) —— 不是 key 本身 */
  apiKeyRef?: string;
  /** 解析凭证引用 → 密钥值。默认只认 `env:<VAR>`; `provider:*` 需宿主注入。返回值永不进结果。 */
  resolveSecret?: (ref: string) => string | undefined | Promise<string | undefined>;
  /** 单请求超时 (ms), 默认 8000 */
  timeoutMs?: number;
  /** 是否确认工具调用能力 (默认 true) */
  checkToolCalling?: boolean;
  /** 注入 fetch (测试/宿主用; 默认全局 fetch) */
  fetchImpl?: typeof fetch;
}

export interface ProbeResult {
  ok: boolean;
  /** `ok === false` 时必有; `ok === true` 时必无 */
  failureClass?: ProbeFailureClass;
  /** 人话理由 (可直接展示; 绝不含凭证值) */
  message: string;
  /** 规范化 + 合并重复 /v1 之后**真正会用的** URL (`''` = 没有任何一层给过) */
  baseUrl: string;
  /** 这个 URL 来自哪一层 (`null` = 四层全空) */
  baseUrlSource: BaseUrlSource | null;
  protocol: ModelProtocol;
  model: string;
  providerId: string;
  /** 凭证引用名 (永不等于 key 值) */
  authRef: string;
  /** 工具调用能力三态 (`unknown` = 端点接受了工具声明但本次未触发工具调用) */
  toolCalling: ProbeCapability;
  /** 逐步事实 */
  checks: ProbeCheck[];
  /** 服务端可解析的模型目录 (拿得到才给) */
  catalog?: string[];
  elapsedMs: number;
}

// ============================================================
// 主原语
// ============================================================

function clampTimeout(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.max(200, Math.min(60_000, Math.floor(n)));
}

/**
 * 探测一条候选模型配置。**全通过才 `ok:true`**; 任何一步失败都带类别 + 人话理由返回,
 * 且绝不改写调用方给的东西、也绝不偷偷换一个 URL 再试。
 *
 * 步骤 (与计划一致): URL 解析 → 规范化/合并 /v1 → 协议形状 → 凭证 → 轻量连接探测 →
 * 模型接口可用 → 工具调用能力。
 */
export async function probe(req: ProbeRequest): Promise<ProbeResult> {
  const started = Date.now();
  const checks: ProbeCheck[] = [];
  const fetchImpl: typeof fetch = req.fetchImpl ?? fetch;
  const timeoutMs = clampTimeout(req.timeoutMs);
  const providerId = String(req.providerId ?? '');
  const model = String(req.model ?? '').trim();
  const authRef = String(req.apiKeyRef ?? 'none');
  const resolveSecret = req.resolveSecret ?? defaultResolveSecret;
  let baseUrl = '';
  let baseUrlSource: BaseUrlSource | null = null;
  let toolCalling: ProbeCapability = 'unknown';

  const finish = (r: Partial<ProbeResult> & { ok: boolean; message: string }): ProbeResult => ({
    providerId,
    model,
    authRef,
    protocol: req.protocol,
    baseUrl,
    baseUrlSource,
    toolCalling,
    checks,
    elapsedMs: Date.now() - started,
    ...r,
  });
  const fail = (failureClass: ProbeFailureClass, message: string, extra?: Partial<ProbeResult>): ProbeResult =>
    finish({ ok: false, failureClass, message, ...(extra ?? {}) });

  // ── 1) URL 解析 + 规范化 (合并重复 /v1) ──────────────────────
  const chosen = resolveChainBaseUrl({
    explicit: req.baseUrl,
    configured: req.configuredBaseUrl,
    providerDefault: req.providerDefaultUrl,
    envVar: req.envBaseUrlVar,
    envValue: req.envBaseUrlValue,
  });
  if (!chosen.source) {
    checks.push({ step: 'url', ok: false, detail: '四层来源 (显式/配置/供应商默认/环境变量) 全空' });
    return fail('invalid_url', '没有任何一层给出 base URL (显式 --base-url / 配置 / 供应商默认 / 环境变量都为空) — 不退回默认地址');
  }
  baseUrlSource = chosen.source;
  baseUrl = chosen.baseUrl;
  const shapeOk = validateChainUrlShape(chosen.baseUrl);
  if (!shapeOk.ok) {
    checks.push({ step: 'url', ok: false, detail: `来源 ${chosen.source} 给了 '${chosen.raw}', 规范化后 '${chosen.baseUrl}': ${shapeOk.reason}` });
    return fail('invalid_url', `base URL 非法 (来源 ${chosen.source}) — ${shapeOk.reason}`);
  }
  baseUrl = shapeOk.url;
  const changed = shapeOk.url !== chosen.raw;
  checks.push({
    step: 'url',
    ok: true,
    detail: `${shapeOk.url} (来源 ${chosen.source}${changed ? `, 已规范化自 '${chosen.raw}'` : ''})`,
  });

  // ── 2) 协议形状校验 ────────────────────────────────────────
  const proto = PROTOCOL_SHAPES[req.protocol];
  if (!proto) {
    checks.push({ step: 'protocol', ok: false, detail: `不认识的协议 '${String(req.protocol)}'` });
    return fail('protocol_mismatch', `不认识的协议类型 '${String(req.protocol)}' (支持: ${supportedProtocols().join(', ')})`);
  }
  if (!model) {
    checks.push({ step: 'protocol', ok: false, detail: '模型名为空' });
    return fail('protocol_mismatch', '模型名为空 — 无法确认模型接口可用');
  }
  checks.push({ step: 'protocol', ok: true, detail: `${proto.label} (${req.protocol}) @ 目录端点 ${proto.catalogPath}` });

  // ── 3) 凭证 ────────────────────────────────────────────────
  let apiKey: string | undefined;
  if (authRef !== 'none') {
    const ref = parseAuthRef(authRef);
    const value = await Promise.resolve(resolveSecret(authRef)).catch(() => undefined);
    if (!isGiven(value)) {
      checks.push({ step: 'credential', ok: false, detail: `引用 ${authRef} 解析不到密钥${ref.kind === 'provider' ? ' (provider:* 需宿主注入 resolveSecret)' : ''}` });
      return fail('auth_failed', `取不到凭证 — 引用 '${authRef}' 解析为空${ref.kind === 'provider' ? ' (本原语不读配置存储, 需宿主注入解析器)' : ` (环境变量 ${ref.name} 未设置)`}`);
    }
    apiKey = String(value).trim();
    checks.push({ step: 'credential', ok: true, detail: `已解析引用 ${authRef} (值不记录)` });
  } else {
    checks.push({ step: 'credential', ok: true, detail: '无凭证 (authRef=none)' });
  }

  // ── 4) 轻量连接探测 (目录端点) ──────────────────────────────
  const origin = new URL(baseUrl).origin;
  const catalogUrl = `${baseUrl}${proto.catalogPath}`;
  let catalog: string[] | undefined;
  {
    const flag: TimeoutFlag = { timedOut: false };
    let res: Response;
    try {
      res = await fetchWithProbeTimeout(catalogUrl, { method: 'GET', headers: proto.headers(apiKey) }, timeoutMs, fetchImpl, flag);
    } catch (e) {
      const cls = classifyNetworkError(e, flag, timeoutMs);
      checks.push({ step: 'connect', ok: false, detail: `${catalogUrl} → ${cls.detail}` });
      return fail(cls.failureClass, `${catalogUrl} 连不上 — ${cls.detail}`);
    }
    const body = await readJson(res);
    const statusClass = classifyStatus(res, body, catalogUrl, 'catalog');
    const parsed = statusClass || body === null ? null : proto.parseCatalog(body);
    if (parsed) {
      catalog = parsed;
      checks.push({ step: 'connect', ok: true, detail: `${catalogUrl} 可达, 目录 ${catalog.length} 个模型` });
    } else if (statusClass?.failureClass === 'auth_failed' || statusClass?.failureClass === 'provider_unreachable') {
      // 这两类无歧义, 不必再交叉试别的协议
      checks.push({ step: 'connect', ok: false, detail: `${catalogUrl} → ${statusClass.detail}` });
      return fail(statusClass.failureClass, `${catalogUrl} 探测失败 — ${statusClass.detail}`);
    } else {
      // 剩下的都可能是"地址/协议不对" → 到服务根上交叉判定一次
      const foreign = await detectForeignProtocol(origin, fetchImpl, timeoutMs);
      if (foreign && foreign.protocol !== req.protocol) {
        checks.push({ step: 'connect', ok: false, detail: `${catalogUrl} 探测失败; 但 ${foreign.url} 回 200 且是 ${foreign.protocol} 形状` });
        return fail('protocol_mismatch', `这地址上的服务是 ${foreign.protocol} 协议, 不是 ${req.protocol} (证据: ${foreign.url} 回 200)`);
      }
      const hint = foreign ? `; 同一协议在 ${foreign.url} 上有端点 — 检查 base URL 路径是否少了/多了` : '';
      if (statusClass) {
        const detail = `${statusClass.detail}${hint}`;
        checks.push({ step: 'connect', ok: false, detail: `${catalogUrl} → ${detail}` });
        const failureClass: ProbeFailureClass =
          foreign && (res.status === 404 || res.status === 405) ? 'invalid_url' : statusClass.failureClass;
        return fail(failureClass, `${catalogUrl} 探测失败 — ${detail}`);
      }
      if (body === null) {
        const ct = res.headers?.get?.('content-type') ?? '未知';
        checks.push({ step: 'connect', ok: false, detail: `${catalogUrl} 回 HTTP ${res.status} 但不是 JSON (Content-Type: ${ct})${hint}` });
        return fail('protocol_mismatch', `${catalogUrl} 回的不是 JSON (Content-Type: ${ct}) — 这个地址不像 ${proto.label} 端点${hint}`);
      }
      const kind = envelopeProtocolOf(body);
      const detail = kind
        ? `回的是 ${kind} 形状的目录, 不是 ${req.protocol}${hint}`
        : `回了无法识别为 ${proto.label} 的目录结构${hint}`;
      checks.push({ step: 'connect', ok: false, detail: `${catalogUrl} → ${detail}` });
      return fail('protocol_mismatch', `${catalogUrl} — ${detail}`);
    }
  }

  // ── 5) 模型接口可用 ────────────────────────────────────────
  if (!catalog.includes(model)) {
    const sample = catalog.slice(0, 5).join(', ');
    checks.push({ step: 'model', ok: false, detail: `目录里没有 '${model}' (共 ${catalog.length} 个, 例: ${sample})` });
    return fail('model_not_found', `端点可达但不认识模型 '${model}' (目录里 ${catalog.length} 个, 例: ${sample})`, { catalog });
  }
  const ping = proto.modelRequest(baseUrl, model, apiKey);
  {
    const flag: TimeoutFlag = { timedOut: false };
    try {
      const res = await fetchWithProbeTimeout(ping.url, ping.init, timeoutMs, fetchImpl, flag);
      const body = await readJson(res);
      const cls = classifyStatus(res, body, ping.url, 'model');
      if (cls) {
        checks.push({ step: 'model', ok: false, detail: `${ping.url} → ${cls.detail}` });
        return fail(cls.failureClass, `模型接口不可用 — ${cls.detail}`, { catalog });
      }
      checks.push({ step: 'model', ok: true, detail: `${ping.url} 回 HTTP ${res.status} (模型 '${model}' 可寻址)` });
    } catch (e) {
      const cls = classifyNetworkError(e, flag, timeoutMs);
      checks.push({ step: 'model', ok: false, detail: `${ping.url} → ${cls.detail}` });
      return fail(cls.failureClass, `模型接口探测失败 — ${cls.detail}`, { catalog });
    }
  }

  // ── 6) 工具调用能力 ───────────────────────────────────────
  if (req.checkToolCalling === false) {
    checks.push({ step: 'tool_call', ok: true, detail: '已跳过 (checkToolCalling=false) — 能力未确认' });
    return finish({ ok: true, message: `探测通过: ${proto.label} @ ${baseUrl}, 模型 '${model}' 可用; 工具调用能力未确认`, catalog });
  }
  const toolReq = proto.toolRequest(baseUrl, model, apiKey);
  {
    const flag: TimeoutFlag = { timedOut: false };
    try {
      const res = await fetchWithProbeTimeout(toolReq.url, toolReq.init, timeoutMs, fetchImpl, flag);
      const body = await readJson(res);
      const cls = classifyStatus(res, body, toolReq.url, 'tool');
      if (cls) {
        checks.push({ step: 'tool_call', ok: false, detail: `${toolReq.url} → ${cls.detail}` });
        return fail(cls.failureClass, `工具调用能力确认失败 — ${cls.detail}`, { catalog });
      }
      toolCalling = hasToolCallEvidence(body) ? 'yes' : 'unknown';
      checks.push({
        step: 'tool_call',
        ok: true,
        detail: toolCalling === 'yes'
          ? `${toolReq.url} 回 HTTP ${res.status} 且响应里带工具调用`
          : `${toolReq.url} 回 HTTP ${res.status} (接受了工具声明; 本次未触发工具调用 ⇒ 能力记 unknown)`,
      });
    } catch (e) {
      const cls = classifyNetworkError(e, flag, timeoutMs);
      checks.push({ step: 'tool_call', ok: false, detail: `${toolReq.url} → ${cls.detail}` });
      return fail(cls.failureClass, `工具调用能力探测失败 — ${cls.detail}`, { catalog });
    }
  }

  return finish({
    ok: true,
    message: `探测通过: ${proto.label} @ ${baseUrl}, 模型 '${model}' 可寻址, 工具调用=${toolCalling === 'yes' ? '已证支持' : '未证 (端点接受工具声明)'}`,
    catalog,
  });
}

/** 响应里有没有**工具调用**的真证据 (不同协议各查各的字段) */
export function hasToolCallEvidence(body: Json): boolean {
  if (!body || typeof body !== 'object') return false;
  const msg = body?.choices?.[0]?.message;
  // OpenAI 兼容 / Ollama
  if (msg && (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 || msg.function_call)) return true;
  if (body?.choices?.[0]?.finish_reason === 'tool_calls') return true;
  // Anthropic
  if (Array.isArray(body?.content) && body.content.some((c: Json) => c?.type === 'tool_use')) return true;
  if (body?.stop_reason === 'tool_use') return true;
  // Gemini
  const parts = body?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some((p: Json) => p?.functionCall || p?.function_call)) return true;
  return false;
}

// ============================================================
// 展示
// ============================================================

/** 一行事实: `✓ 探测通过 · …` 或 `✗ <类别> (人话) · …` */
export function formatProbeResult(r: ProbeResult): string {
  const head = `${r.providerId}/${r.model} @ ${r.baseUrl || '(无 URL)'} [来源=${r.baseUrlSource ?? '无'}]`;
  if (r.ok) return `✓ 探测通过 · ${head} · 工具调用=${r.toolCalling}`;
  const cls = r.failureClass as ProbeFailureClass;
  return `✗ ${cls} (${PROBE_FAILURE_ZH[cls] ?? '未分类'}) · ${head} · ${r.message}`;
}

/** 门用: 结果序列化里有没有把凭证值漏出去 (拿真 key 探完后不许出现它) */
export function resultLeaksSecret(r: ProbeResult, secret: string): boolean {
  if (!secret) return false;
  try {
    return JSON.stringify(r).includes(secret);
  } catch {
    return false;
  }
}
