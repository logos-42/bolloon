/**
 * model-discovery.ts — 模型发现与缓存 (P5, 2026-09-26)
 *
 * ## 这一层解决什么
 *
 * P3 给了"供应商是谁、它的目录端点在哪、怎么认证"; P4 给了"探测原语与失败七类"。
 * 但**没人真的去问过** `/models`, 也没有缓存 —— 于是选择器里永远是那几张内置清单,
 * 一断网就什么都没有, 而"这家到底有哪些模型"完全是猜的。
 *
 * 本层就干四件事:
 *
 *   ① **发现**: 供应商**已认证**时优先取目录端点 (`openai-models` → `GET <base>/models`,
 *      `ollama-tags` → `GET <base>/api/tags`, `gemini-models` → `GET <base>/models` 的 Google 形状)。
 *      没认证 / 没有可用端点 → **不发请求**, 如实记下"为什么没问"。
 *   ② **缓存**: 发现结果按 **provider + baseUrl + 凭证身份** 三要素分组, 带有效期 (默认 30 分钟)。
 *      凭证身份**只存指纹不存明文** (`fp:<sha256 前 16 位>`; 没凭据 = `anonymous`) ⇒
 *      **两个不同的 key 各自一份缓存, 互不可见/互不串收**。
 *   ③ **回退链**: 网络不可用 → 用**上一次成功缓存** (标记 `cached`); 从未成功 → 用**内置目录**
 *      (`curated`); 自定义模型**允许手动输入** (`admitManualModel`, 标记 `custom`)。
 *   ④ **不静默删**: 发现失败**绝不**把 provider 从列表里删掉 —— 保留它, 标 `unavailable` + 原因
 *      (`failure.failureClass` + 人话理由)。列表长度恒等于注册表长度, 有门钉住。
 *
 * ## 五种标记 (计划逐字) 与"两个字段"的划分
 *
 * | 标记 | 含义 | 落在哪个字段 |
 * | --- | --- | --- |
 * | `live` | **本轮**真取到目录 (HTTP 2xx 且解析出 ≥1 个模型) | `origin` + `discoveryState` |
 * | `cached` | 用的缓存 (新鲜期内直接命中, 或网络不可用时的上次成功缓存) | `origin` + `discoveryState` |
 * | `curated` | 清单来自**内置目录** (没端点 / 没凭据 / 从未发现成功) | `origin` + `discoveryState` |
 * | `custom` | 清单来自**用户声明或手工输入**的模型 ID | 逐条在 `modelOrigins` |
 * | `unavailable` | **本轮发现失败**, 且回退链上**什么都没有** | `origin`; 只要失败就 `discoveryState='unavailable'` |
 *
 * 为什么要有两个字段 (而不是一个): 一个事实, 两种问法。
 *   - "这份清单是从哪来的?" → `origin` (live/cached/curated/custom);
 *   - "这一家现在能不能发现?" → `discoveryState`, **只要本轮尝试失败就是 `unavailable` + `failure.reason`**
 *     —— 哪怕回退到了 `cached` 清单, 也必须让界面看得见"这次没问通"。
 * 于是"发现失败不许静默"与"断网还能用缓存"两句话同时成立, 不需要挑一个装作不知道。
 *
 * ## 缓存落在哪 / 里面有什么
 *
 * `~/.bolloon/model-discovery-cache.json` (mode 0600, 目录跟随 `BOLLOON_HOME`, **调用时**解析)。
 * 缓存是**运行时数据**, 不是配置: 所以不挤进 `bolloon-config.json` (那是有写锁的配置文件, 塞缓存
 * 会让"配置变了"和"缓存变了"混成一件事)。单条记录只存**指纹**:
 *
 * ```json
 * { "version": 1, "entries": { "<cacheKey>": {
 *     "provider": "deepseek", "baseUrl": "https://api.deepseek.com/v1",
 *     "credentialIdentity": "fp:1a2b…", "endpoint": "…/models",
 *     "models": ["deepseek-chat"], "facts": {}, "manualModels": [],
 *     "lastSuccessAt": "…", "fetchedAt": "…", "expiresAt": "…" } } }
 * ```
 *
 * `cacheKey = sha256(provider \u0000 baseUrl \u0000 credentialIdentity)` —— 三要素任何一项不同
 * 就是**另一条缓存**。明文 key 一个字节都不落盘 (有门比对: 文件里既没有 key, 也没有 key 的任何切片)。
 *
 * 凭证身份刻意用**截断指纹**: 它只是"分组桶", 不是凭据。**同一把 key 的指纹稳定** ⇒ 缓存能命中;
 * **不同 key 的指纹几乎不可能相同** ⇒ 不会互相串收。
 *
 * ## 空目录 ≠ 失败
 *
 * - HTTP 401/403 → `auth_failed`; 5xx/429 → `provider_unreachable`; 无响应 → `timeout` (全部来自 P4)
 *   —— **一律不当"这家没有模型"**;
 * - HTTP 200 但形状不是目录 (`{data:[…]}`/`{models:[…]}` 都没有) → `protocol_mismatch`;
 * - HTTP 200 且形状对但**0 个模型** → `model_not_found` + 理由说明"不当成空目录缓存";
 * 三种情形都**不覆盖**上次成功缓存 (缓存只由"真的取到 ≥1 个模型"的成功写)。
 *
 * ## 有真值才填 (P2 冻结的元数据填充点)
 *
 * 本层向 `registerModelMetadataSource()` 注册一个填充点 (`id = 'live-discovery'`):
 *   - `origin`: 只有当这个模型**真在**本轮的目录/手输清单里才填 (逐条 `modelOrigins`);
 *   - `toolCalling` / `reasoning` / `contextLength` / `displayName`: **只填响应体里字面写着的那几个字段**
 *     (见 `FACT_KEYS`), 其余一律不出现 (= 保持 `unknown`, 由 P2 显示"未知原因")。
 *     内置清单 (`curatedModelIds`) 只有 ID, 所以没跑发现时这些字段照旧是 `unknown` —— 不许编。
 * 填充点**纯同步**: 数据来自进程内快照 (`currentDiscoveryCatalog`), 不在填充点里发请求、读盘。
 *
 * ## 命令面 (能力做成可调用函数, 命令面接线归 P0/P6 那条线)
 *
 * ```
 * /model refresh            → refreshModelDiscovery()                 (强制真取一次)
 * /model list               → listModelCatalog()                      (全体, 一家都不删)
 * /model list <provider>    → listModelCatalog(providerId)
 * 手工输入自定义模型        → admitManualModel(providerId, modelId) / forgetManualModel()
 * 清缓存                    → clearDiscoveryCache(providerId?)
 * ```
 *
 * ## 凭据纪律
 *
 * `apiKey` 只在 `DiscoveryTarget.apiKey` 里为了**当次请求构造**而存在 (与 P4 的 `authHeadersFor` 同一约定):
 * 不进日志、不进缓存、不进 catalog、不进报告 (`[REDACTED]`)。所有会把文本交出去的路径
 * (失败理由 = 上游响应片段) 都过一遍 `redactSecretIn()`。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

import { llmConfigStore } from './config-store.js';
import { envApiKeyOf } from './model-selection.js';
import {
  getProviderRegistryEntry,
  listProviderRegistry,
  customProviderSnapshot,
  authHeadersFor,
  modelsEndpointOf,
  customProviderSpecOf,
  type ProviderRegistryEntry,
} from './provider-registry.js';
import {
  curatedModelIds,
  registerModelMetadataSource,
  listModelMetadataSources,
  type CatalogOrigin,
  type Capability,
  type ModelCapabilityFacts,
  type ModelMetadataSource,
} from './model-catalog.js';
import {
  fetchWithProbeTimeout,
  classifyNetworkError,
  classifyStatus,
  snippetOf,
  resolveChainBaseUrl,
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_FAILURE_ZH,
  type ProbeFailureClass,
  type TimeoutFlag,
} from './connection-probe.js';

// ============================================================
// 常量
// ============================================================

/** 缓存文件名 (落在配置目录 0600) */
export const DISCOVERY_CACHE_FILE = 'model-discovery-cache.json';

/** 缓存文件格式版本 */
export const DISCOVERY_CACHE_VERSION = 1;

/** 缓存有效期 (默认 30 分钟) */
export const DEFAULT_DISCOVERY_TTL_MS = 30 * 60 * 1000;

/** 发现请求的超时 (复用 P4 的探测超时) */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;

/** 没有凭据时的凭证身份 (不是"没有这一格", 是"这一格明确是匿名") */
export const ANONYMOUS_IDENTITY = 'anonymous';

/** 指纹前缀 —— 一眼看出"这是指纹, 不是明文" */
export const FINGERPRINT_PREFIX = 'fp:';

/** 手工输入的模型 ID 长度上限 (超了说明不是模型名) */
const MANUAL_MODEL_MAX_LEN = 200;

/**
 * 从响应体里**字面读到**才算的能力字段 (键名 → 取法)。
 * 只认字面 `boolean` / `number`: 字符串、对象、缺省一律不当结论 (那就是 `unknown`)。
 */
const FACT_KEYS = {
  contextLength: ['contextLength', 'context_length', 'context_window', 'contextWindow', 'inputTokenLimit', 'max_input_tokens', 'max_context_tokens'],
  toolCalling: [['capabilities', 'toolCalling'], ['capabilities', 'tool_calling'], ['capabilities', 'tools'], ['tool_calling'], ['supports_tools']],
  reasoning: [['capabilities', 'reasoning'], ['capabilities', 'thinking'], ['reasoning'], ['supports_reasoning']],
  displayName: ['displayName', 'display_name'],
} as const;

type Json = any;

// ============================================================
// 类型
// ============================================================

/** 凭据从哪来 (只记来源, 不记值) */
export type CredentialSource = 'explicit' | 'config' | 'env' | 'none';

/** 一次发现失败 (类别 + 人话理由 + 时间) */
export interface DiscoveryFailure {
  failureClass: ProbeFailureClass;
  /** 人话理由 (上游响应片段已过脱敏) */
  reason: string;
  at: string;
}

/** 从响应体里真读到的事实 (没读到就不出现) */
export interface DiscoveredModelFacts {
  displayName?: string;
  toolCalling?: Capability;
  reasoning?: Capability;
  contextLength?: number;
}

/** 发现目标 (含凭据 —— 只许用于当次请求构造, 不进日志/快照/报告) */
export interface DiscoveryTarget {
  provider: string;
  /** 注册表条目 (`null` = 不在册) */
  entry: ProviderRegistryEntry | null;
  baseUrl: string;
  baseUrlSource: string | null;
  baseUrlRaw: string;
  endpoint: string;
  requiresApiKey: boolean;
  /** 现在手上真的有可用凭证, 或这家本来不需要 key (= "已认证") */
  credentialReady: boolean;
  credentialSource: CredentialSource;
  /** 凭证身份: `anonymous` 或 `fp:<16 hex>` —— **只有指纹, 没有明文** */
  credentialIdentity: string;
  /** **仅用于当次请求构造**; 不在任何返回值/日志/报告里 */
  apiKey?: string;
  cacheKey: string;
  /** 能不能真的去问目录端点 */
  canDiscover: boolean;
  /** 不能问的原因 (人话) */
  skipReason?: string;
  notes: string[];
}

/** 一家供应商的目录结论 (列表里**一家都不删**) */
export interface DiscoveredCatalog {
  provider: string;
  baseUrl: string;
  baseUrlSource: string | null;
  endpoint: string;
  /** 注册表说这家要不要 key (展示"未配置凭据"用; 真出处 = 注册表) */
  requiresApiKey: boolean;
  /** 只有指纹 */
  credentialIdentity: string;
  credentialSource: CredentialSource;
  credentialReady: boolean;
  cacheKey: string;
  /** 这份清单的来源: live | cached | curated | custom | unavailable */
  origin: CatalogOrigin;
  /** 本轮发现结论: 失败 = `unavailable` (+ `failure`) */
  discoveryState: CatalogOrigin;
  models: string[];
  /** 逐条模型 ID 的来源 */
  modelOrigins: Record<string, CatalogOrigin>;
  facts: Record<string, DiscoveredModelFacts>;
  manualModels: string[];
  declaredModels: string[];
  fetchedAt: string | null;
  expiresAt: string | null;
  /** 用的是缓存 (新鲜命中或失败回退) */
  fromCache: boolean;
  /** 用的是**过期**缓存 (网络不可用时的回退 —— 仍比"什么都没有"强) */
  stale: boolean;
  discoveryFailed: boolean;
  failure?: DiscoveryFailure;
  /** = `failure.reason` (列表直接显示用) */
  failureReason?: string;
  /** 发现失败但 provider **被保留** (本层的不静默删承诺) */
  keptDespiteFailure: boolean;
  notes: string[];
}

/** 缓存里的一条 (只存指纹) */
export interface DiscoveryCacheEntry {
  provider: string;
  baseUrl: string;
  credentialIdentity: string;
  endpoint: string;
  models: string[];
  facts: Record<string, DiscoveredModelFacts>;
  manualModels: string[];
  /** **最后一次成功**发现的时间; `null` = 从没成功过 (手输模型也能建条目) */
  lastSuccessAt: string | null;
  /** 本条记录的时间 (手输会刷新它, 但不会伪造 `lastSuccessAt`) */
  fetchedAt: string | null;
  expiresAt: string | null;
}

export interface DiscoveryCacheFile {
  version: number;
  entries: Record<string, DiscoveryCacheEntry>;
  /** 读盘时的问题 (文件坏了/版本不认识) —— 不静默 */
  warnings?: string[];
}

export interface DiscoverOptions {
  /** 显式 base URL (最高优先) */
  baseUrl?: string;
  /** 显式凭据 (最高优先; 调用方已解析好) */
  apiKey?: string;
  /** 忽略新鲜期, 强制真取一次 */
  force?: boolean;
  /** 覆盖有效期 */
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 额外的手工模型 (并入 `custom`) */
  manualModels?: string[];
  /** 时钟注入 (测试用) */
  now?: () => number;
}

/** 一家供应商的列表行 (命令面直接用) */
export interface CatalogListing {
  generatedAt: string;
  cachePath: string;
  entries: DiscoveredCatalog[];
  /** 本轮发现失败的 provider + 原因 (保留在 `entries` 里, 这里只是索引) */
  unavailable: Array<{ provider: string; failureClass?: ProbeFailureClass; reason: string }>;
  notes: string[];
}

/** `/model refresh` 的返回 */
export interface DiscoveryRefreshReport {
  refreshedAt: string;
  force: boolean;
  cachePath: string;
  results: DiscoveredCatalog[];
  counts: Record<CatalogOrigin, number>;
  failures: Array<{ provider: string; failureClass: ProbeFailureClass; reason: string }>;
  notes: string[];
}

// ============================================================
// 凭证身份 / 缓存键 (纯函数)
// ============================================================

/**
 * 凭证身份: **只产指纹, 不产明文**。
 *
 * 没凭据 → `anonymous`; 有凭据 → `fp:<sha256 前 16 位>` (先加一个固定命名空间前缀再哈希,
 * 免得"某处一把 key 的裸 sha"能拿来对表)。
 *
 * 它只是**缓存分组桶**: 同一把 key 稳定命中, 不同 key 分成两份。
 */
export function credentialIdentityOf(apiKey?: string): string {
  const k = String(apiKey ?? '');
  if (!k.trim()) return ANONYMOUS_IDENTITY;
  const h = crypto.createHash('sha256').update(`bolloon-model-discovery\u0000${k}`).digest('hex');
  return `${FINGERPRINT_PREFIX}${h.slice(0, 16)}`;
}

/** 这个身份是不是指纹 (不是 `anonymous`) */
export function isFingerprintIdentity(identity: string): boolean {
  return String(identity || '').startsWith(FINGERPRINT_PREFIX);
}

/**
 * 缓存键 = `sha256(provider \u0000 baseUrl \u0000 credentialIdentity)`。
 *
 * 三要素**任缺一不可**: 少了凭证身份就会"两个 key 共用一份缓存"(有变异门钉住),
 * 少了 baseUrl 就会把"同一个 provider 换到自建网关上"的两份目录混起来。
 */
export function discoveryCacheKey(provider: string, baseUrl: string, credentialIdentity: string): string {
  const parts = [String(provider || ''), String(baseUrl || ''), String(credentialIdentity || '')];
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

/** 把文本里的凭据抹掉 (失败理由 = 上游响应片段时要过这一道) */
export function redactSecretIn(text: string, secret?: string): string {
  const s = String(text ?? '');
  const k = String(secret ?? '');
  if (!k || k.length < 4) return s;
  return s.split(k).join('[REDACTED]');
}

/** 缓存文件里有没有凭据明文 (门用; 逐条切片也比) */
export function discoveryCacheLeaks(cache: DiscoveryCacheFile | string, secret: string): boolean {
  const text = typeof cache === 'string' ? cache : JSON.stringify(cache ?? {});
  const k = String(secret ?? '');
  if (!k || k.length < 4) return false;
  if (text.includes(k)) return true;
  // 连"大段切片"也不许出现 (防止只存了 key 的一部分还以为没事)
  const slice = k.slice(0, 8);
  return slice.length >= 8 && text.includes(slice);
}

// ============================================================
// 缓存文件 (只在配置目录里, 0600)
// ============================================================

/** 缓存文件绝对路径 (`BOLLOON_HOME` **调用时**解析, 与配置文件同一个目录) */
export function discoveryCachePath(): string {
  return path.join(llmConfigStore.configDirPath(), DISCOVERY_CACHE_FILE);
}

/** 读缓存 (文件不在/坏了 → 空表 + `warnings`, **不抛**) */
export async function readDiscoveryCache(): Promise<DiscoveryCacheFile> {
  const empty: DiscoveryCacheFile = { version: DISCOVERY_CACHE_VERSION, entries: {} };
  let text: string;
  try {
    text = await fs.readFile(discoveryCachePath(), 'utf-8');
  } catch {
    return empty;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...empty, warnings: ['缓存文件不是合法 JSON → 当空表 (下次成功发现会覆盖它)'] };
  }
  if (!parsed || typeof parsed !== 'object') return { ...empty, warnings: ['缓存文件形状不对 → 当空表'] };
  if (parsed.version !== DISCOVERY_CACHE_VERSION) {
    return { ...empty, warnings: [`缓存文件版本 ${String(parsed.version)} ≠ ${DISCOVERY_CACHE_VERSION} → 当空表`] };
  }
  const out: DiscoveryCacheFile = { version: DISCOVERY_CACHE_VERSION, entries: {} };
  for (const [key, raw] of Object.entries(parsed.entries || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as any;
    out.entries[key] = {
      provider: String(r.provider || ''),
      baseUrl: String(r.baseUrl || ''),
      credentialIdentity: String(r.credentialIdentity || ANONYMOUS_IDENTITY),
      endpoint: String(r.endpoint || ''),
      models: Array.isArray(r.models) ? r.models.filter((m: any) => typeof m === 'string' && m) : [],
      facts: r.facts && typeof r.facts === 'object' ? r.facts : {},
      manualModels: Array.isArray(r.manualModels) ? r.manualModels.filter((m: any) => typeof m === 'string' && m) : [],
      lastSuccessAt: typeof r.lastSuccessAt === 'string' ? r.lastSuccessAt : null,
      fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : null,
      expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
    };
  }
  return out;
}

/** 写缓存 (临时文件 + rename, mode 0600; 目录不在就建) */
export async function writeDiscoveryCache(file: DiscoveryCacheFile): Promise<void> {
  const target = discoveryCachePath();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const payload: DiscoveryCacheFile = { version: DISCOVERY_CACHE_VERSION, entries: file.entries || {} };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => { /* 尽力而为 */ });
  await fs.rename(tmp, target);
  await fs.chmod(target, 0o600).catch(() => { /* 尽力而为 */ });
}

/** 清缓存 (给了 provider 就只清这一家; 返回清了几条) */
export async function clearDiscoveryCache(provider?: string): Promise<number> {
  const file = await readDiscoveryCache();
  const id = String(provider || '').trim();
  if (!id) {
    const n = Object.keys(file.entries).length;
    await writeDiscoveryCache({ version: DISCOVERY_CACHE_VERSION, entries: {} });
    return n;
  }
  const keys = Object.keys(file.entries).filter((k) => file.entries[k].provider === id);
  for (const k of keys) delete file.entries[k];
  await writeDiscoveryCache(file);
  return keys.length;
}

// ============================================================
// 响应体解析 (只服务本层: P4 的协议表是模块私有的, 且只回 ID 不回能力)
// ============================================================

export type CatalogParse =
  | { kind: 'ok'; ids: string[]; facts: Record<string, DiscoveredModelFacts> }
  | { kind: 'shape_error'; detail: string };

function pickString(obj: Json, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function pickBool(obj: Json, keyPaths: readonly (string | readonly string[])[]): Capability | undefined {
  for (const kp of keyPaths) {
    const path = Array.isArray(kp) ? (kp as string[]) : [kp as string];
    let cur: any = obj;
    for (const seg of path) {
      if (cur === null || typeof cur !== 'object') { cur = undefined; break; }
      cur = cur[seg];
    }
    if (typeof cur === 'boolean') return cur ? 'yes' : 'no';
  }
  return undefined;
}

function pickNumber(obj: Json, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

/** 一家一个条目 → 事实 (只认字面字段) */
function factsOfItem(item: Json): DiscoveredModelFacts {
  const facts: DiscoveredModelFacts = {};
  if (!item || typeof item !== 'object') return facts;
  const tool = pickBool(item, FACT_KEYS.toolCalling as any);
  if (tool) facts.toolCalling = tool;
  const reasoning = pickBool(item, FACT_KEYS.reasoning as any);
  if (reasoning) facts.reasoning = reasoning;
  const ctx = pickNumber(item, FACT_KEYS.contextLength);
  if (ctx) facts.contextLength = ctx;
  const name = pickString(item, FACT_KEYS.displayName[0]) ?? pickString(item, FACT_KEYS.displayName[1]);
  if (name) facts.displayName = name;
  return facts;
}

/** 去掉 gemini 形状的 `models/` 前缀 (其余**逐字保留**) */
function stripModelsPrefix(id: string): string {
  return id.replace(/^models\//, '');
}

/**
 * 解析目录响应体。**不编** —— 认不出形状就 `shape_error` (上层判 `protocol_mismatch`),
 * 形状对但空列表就是空列表 (上层判 `model_not_found`, 不当"成功"缓存)。
 */
export function parseCatalogBody(body: Json, protocol: string): CatalogParse {
  if (body === null || typeof body !== 'object') {
    return { kind: 'shape_error', detail: '响应体不是 JSON 对象' };
  }
  // 通用: 一个数组字段 → 逐个取 ID
  let arr: any[] | null = null;
  if (Array.isArray(body.data)) arr = body.data;
  else if (Array.isArray(body.models)) arr = body.models;
  else if (Array.isArray(body.tags)) arr = body.tags;
  else if (Array.isArray(body)) arr = body;

  if (arr) {
    const ids: string[] = [];
    const facts: Record<string, DiscoveredModelFacts> = {};
    for (const item of arr) {
      let id: string | undefined;
      if (typeof item === 'string') id = item;
      else if (item && typeof item === 'object') {
        id = pickString(item, 'id') ?? pickString(item, 'name') ?? pickString(item, 'model');
        // gemini / ollama 的 name 是唯一真名字段, 这里再兜一次 model_id
        if (!id) id = pickString(item, 'model_id');
      }
      if (!id) continue;
      const finalId = protocol === 'gemini' ? stripModelsPrefix(id) : id;
      if (!finalId) continue;
      const f = factsOfItem(item);
      if (Object.keys(f).length) facts[finalId] = { ...(facts[finalId] || {}), ...f };
      ids.push(finalId);
    }
    return { kind: 'ok', ids, facts };
  }

  // ollama `/api/tags` 的另一种形状: { models: [...] } 已覆盖; 其余一律算形状不对
  return {
    kind: 'shape_error',
    detail: '响应体里没有模型数组 (data/models/tags 都不是数组)',
  };
}

// ============================================================
// 目标解析: baseUrl + 凭据 + 端点 (四层 URL 优先级复用 P4)
// ============================================================

async function resolveCredential(
  providerId: string,
  entry: ProviderRegistryEntry | null,
  opts: DiscoverOptions,
): Promise<{ apiKey?: string; source: CredentialSource }> {
  const explicit = String(opts.apiKey ?? '').trim();
  if (explicit) return { apiKey: explicit, source: 'explicit' };
  if (!entry) return { source: 'none' };
  if (entry.kind === 'custom') {
    const spec = customProviderSpecOf(providerId);
    const own = String(spec?.apiKey ?? '').trim();
    if (own) return { apiKey: own, source: 'config' };
    const envName = String(spec?.apiKeyEnvVar ?? '').trim();
    const fromEnv = envName ? String(process.env[envName] ?? '').trim() : '';
    if (fromEnv) return { apiKey: fromEnv, source: 'env' };
    return { source: 'none' };
  }
  await llmConfigStore.initialize();
  const cfg: any = await llmConfigStore.getConfig();
  const own = String(cfg?.providers?.[providerId]?.apiKey ?? '').trim();
  if (own) return { apiKey: own, source: 'config' };
  const env = envApiKeyOf(providerId);
  if (env?.value) return { apiKey: env.value, source: 'env' };
  return { source: 'none' };
}

/**
 * 解析"去哪问、用什么认证"。
 *
 * base URL 四层优先级与切换链路**同一张表** (`resolveChainBaseUrl`): 显式 > 配置 > 供应商默认 > 环境变量。
 * 不在册的供应商也能拿到一个 target (`entry: null` + `canDiscover: false`), 由上层标 `unavailable`,
 * 而不是"看不见这一家"。
 */
export async function resolveDiscoveryTarget(providerId: string, opts: DiscoverOptions = {}): Promise<DiscoveryTarget> {
  ensureDiscoveryMetadataSource();
  const id = String(providerId || '').trim();
  const entry = getProviderRegistryEntry(id) || null;
  const notes: string[] = [];

  if (!entry) {
    return {
      provider: id,
      entry: null,
      baseUrl: '',
      baseUrlSource: null,
      baseUrlRaw: '',
      endpoint: '',
      requiresApiKey: true,
      credentialReady: false,
      credentialSource: 'none',
      credentialIdentity: ANONYMOUS_IDENTITY,
      cacheKey: discoveryCacheKey(id, '', ANONYMOUS_IDENTITY),
      canDiscover: false,
      skipReason: `不在册的供应商: ${id} (注册表里没有这条) → 保留在列表里并标 unavailable, 但没法问它有哪些模型`,
      notes,
    };
  }

  let configured = '';
  if (entry.kind === 'custom') {
    configured = customProviderSpecOf(id)?.baseUrl || '';
  } else {
    await llmConfigStore.initialize();
    const cfg: any = await llmConfigStore.getConfig();
    configured = String(cfg?.providers?.[id]?.baseUrl || '');
  }

  const resolved = resolveChainBaseUrl({
    explicit: opts.baseUrl,
    configured,
    providerDefault: entry.defaultBaseUrl,
    envVar: entry.baseUrlEnvVars[0],
  }, process.env);
  const baseUrl = resolved.baseUrl;

  const cred = await resolveCredential(id, entry, opts);
  const credentialIdentity = credentialIdentityOf(cred.apiKey);
  const credentialReady = !!cred.apiKey || entry.requiresApiKey === false;

  const declaredEndpoint = entry.kind === 'custom' ? (customProviderSpecOf(id)?.modelsEndpoint || '') : '';
  const endpoint = baseUrl ? modelsEndpointOf({ ...entry, defaultBaseUrl: baseUrl }, declaredEndpoint) : '';

  const target: DiscoveryTarget = {
    provider: id,
    entry,
    baseUrl,
    baseUrlSource: resolved.source,
    baseUrlRaw: resolved.raw,
    endpoint,
    requiresApiKey: entry.requiresApiKey,
    credentialReady,
    credentialSource: cred.source,
    credentialIdentity,
    cacheKey: discoveryCacheKey(id, baseUrl, credentialIdentity),
    canDiscover: false,
    notes,
  };
  if (cred.apiKey) target.apiKey = cred.apiKey;

  if (!baseUrl) {
    target.skipReason = '没有任何一层给出 base URL (显式/配置/供应商默认/环境变量都空) → 没有发现可做';
    return target;
  }
  if (!endpoint) {
    target.skipReason = `这家没有可用的模型目录端点 (发现方式=${entry.discovery}) → 只能手工填 model ID`;
    return target;
  }
  if (!credentialReady) {
    target.skipReason = `未配置凭据 → 本轮没有做发现 (注册表说这家需要 API key${entry.apiKeyEnvVars.length ? `: ${entry.apiKeyEnvVars.join('/')}` : ''})`;
    return target;
  }
  target.canDiscover = true;
  return target;
}

// ============================================================
// 目录清单合并 (live > cached > custom > curated)
// ============================================================

interface MergedModels {
  models: string[];
  origins: Record<string, CatalogOrigin>;
}

/**
 * 合并清单。顺序 = **优先级降序**: `live` → `cached` → `custom` → `curated`。
 * 同一模型出现多次时按**更高优先级的来源**记 (但首次出现的位置保留 —— 列表顺序稳定)。
 */
function mergeModels(layers: Array<{ origin: CatalogOrigin; ids: string[] }>): MergedModels {
  const origins: Record<string, CatalogOrigin> = {};
  const rank: Record<string, number> = { live: 4, cached: 3, custom: 2, curated: 1, unavailable: 0 };
  const order: string[] = [];
  for (const layer of layers) {
    for (const raw of layer.ids) {
      const id = String(raw || '').trim();
      if (!id) continue;
      if (!(id in origins)) {
        origins[id] = layer.origin;
        order.push(id);
        continue;
      }
      if ((rank[layer.origin] ?? 0) > (rank[origins[id]] ?? 0)) origins[id] = layer.origin;
    }
  }
  return { models: order, origins };
}

// ============================================================
// 进程内快照 (元数据填充点必须是纯同步的)
// ============================================================

const discoverySnapshot = new Map<string, DiscoveredCatalog>();

/** 最近一次发现的结论 (同步; 填充点与展示用) */
export function currentDiscoveryCatalog(provider: string): DiscoveredCatalog | undefined {
  return discoverySnapshot.get(String(provider || '').trim());
}

/** 当前快照里的全部 provider */
export function currentDiscoveryProviders(): string[] {
  return [...discoverySnapshot.keys()];
}

/** 推一批结论进快照 (本层自己调; 也可由调用方在别处拿到结果后推进来) */
export function setDiscoverySnapshot(catalogs: DiscoveredCatalog[]): void {
  for (const c of catalogs) {
    if (!c || !c.provider) continue;
    discoverySnapshot.set(c.provider, c);
  }
}

/** 清空快照 (测试用; 生产路径不调用) */
export function resetDiscoverySnapshot(): void {
  discoverySnapshot.clear();
}

// ============================================================
// 发现一次
// ============================================================

function trimNotes(notes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    const v = String(n || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 把缓存条目降级成"回退清单" (只有 `lastSuccessAt` 非空才算"上次成功") */
function fallbackFromCache(entry: DiscoveryCacheEntry | undefined): { ids: string[]; facts: Record<string, DiscoveredModelFacts>; ok: boolean } {
  if (!entry || !entry.lastSuccessAt) return { ids: [], facts: {}, ok: false };
  return { ids: entry.models || [], facts: entry.facts || {}, ok: (entry.models || []).length > 0 };
}

/**
 * 发现一家的模型目录。
 *
 * 决策顺序 (逐条都有门):
 *   0. 新鲜缓存命中 (未 `force`) → `cached` —— **一个网络请求都不打**;
 *   1. 不能问 (没端点/没凭据/不在册) → `curated`/`custom`/`unavailable` + "为什么没问";
 *   2. 真问 → 2xx 且 ≥1 个模型 → `live` 并**写缓存**;
 *   3. 问失败 (401/403/5xx/超时/空目录/形状不对) → **保留 provider**, 标 `discoveryState='unavailable'` +
 *      原因; 清单退回**上次成功缓存** (`cached`) → 手输/声明 (`custom`) → 内置目录 (`curated`);
 *      回退链全空 → `origin='unavailable'`。
 */
export async function discoverProviderModels(providerId: string, opts: DiscoverOptions = {}): Promise<DiscoveredCatalog> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  const ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_DISCOVERY_TTL_MS);
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const target = await resolveDiscoveryTarget(providerId, opts);
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const notes = [...target.notes];

  const cacheFile = await readDiscoveryCache();
  for (const w of cacheFile.warnings || []) notes.push(w);
  const cached = cacheFile.entries[target.cacheKey];

  const declaredModels: string[] = target.entry
    ? (target.entry.kind === 'custom' ? target.entry.declaredModelIds : [])
    : [];
  const manualModels = trimNotes([...(opts.manualModels || []), ...((cached?.manualModels) || [])]);
  const curated = target.entry && target.entry.kind === 'builtin' ? curatedModelIds(target.provider) : [];

  const base: Omit<DiscoveredCatalog, 'origin' | 'discoveryState' | 'models' | 'modelOrigins' | 'facts'
    | 'fromCache' | 'stale' | 'discoveryFailed' | 'keptDespiteFailure'> = {
    provider: target.provider,
    baseUrl: target.baseUrl,
    baseUrlSource: target.baseUrlSource,
    endpoint: target.endpoint,
    requiresApiKey: target.entry ? target.entry.requiresApiKey : true,
    credentialIdentity: target.credentialIdentity,
    credentialSource: target.credentialSource,
    credentialReady: target.credentialReady,
    cacheKey: target.cacheKey,
    manualModels,
    declaredModels,
    fetchedAt: cached?.fetchedAt ?? null,
    expiresAt: cached?.expiresAt ?? null,
    notes: [],
  };

  const finish = (parts: {
    origin: CatalogOrigin;
    discoveryState: CatalogOrigin;
    layers: Array<{ origin: CatalogOrigin; ids: string[] }>;
    facts?: Record<string, DiscoveredModelFacts>;
    fromCache: boolean;
    stale: boolean;
    failure?: DiscoveryFailure;
  }): DiscoveredCatalog => {
    const merged = mergeModels(parts.layers);
    const failureReason = parts.failure ? redactSecretIn(parts.failure.reason, target.apiKey) : undefined;
    const cat: DiscoveredCatalog = {
      ...base,
      origin: parts.origin,
      discoveryState: parts.discoveryState,
      models: merged.models,
      modelOrigins: merged.origins,
      facts: parts.facts || {},
      fromCache: parts.fromCache,
      stale: parts.stale,
      discoveryFailed: parts.discoveryState === 'unavailable',
      keptDespiteFailure: parts.discoveryState === 'unavailable',
      // 理由 / 备注也要过脱敏: 上游可能在错误体里把收到的凭据回显出来
      notes: trimNotes(notes).map((n) => redactSecretIn(n, target.apiKey)),
      ...(parts.failure ? { failure: { ...parts.failure, reason: failureReason || parts.failure.reason } } : {}),
      ...(failureReason ? { failureReason } : {}),
    };
    discoverySnapshot.set(cat.provider, cat);
    return cat;
  };

  /**
   * 回退链的两层 (真目录之外的两层; 空层会被 mergeModels 忽略)。
   *
   * **有真目录 (live/cached) 时不再混入内置目录** —— 内置目录只有 ID, 混进去会让清单里出现
   * "这台端点上根本不存在的模型"。内置目录只在**没有真目录**时兜底 (`curated`)。
   * 用户显式声明/手输的模型 (`custom`) 则**总是**并入 (那是用户自己说的, 可撤)。
   */
  const fallbackLayers = (): Array<{ origin: CatalogOrigin; ids: string[] }> => [
    { origin: 'custom', ids: [...manualModels, ...declaredModels] },
    { origin: 'curated', ids: curated },
  ];

  /** 真目录已有 → 只再并入"用户说的那一层" (不混内置目录) */
  const customLayers = (): Array<{ origin: CatalogOrigin; ids: string[] }> => [
    { origin: 'custom', ids: [...manualModels, ...declaredModels] },
  ];

  // 1) 新鲜缓存命中
  const fresh = !opts.force && !!cached?.lastSuccessAt && !!cached.expiresAt
    && Date.parse(cached!.expiresAt!) > nowMs && (cached!.models || []).length > 0;
  if (fresh) {
    notes.push(`缓存命中 (有效期到 ${cached!.expiresAt}) → 本轮没有发发现请求`);
    notes.push(`供应商已认证 (凭据来源=${target.credentialSource}), 想强制刷新就 refresh`);
    return finish({
      origin: 'cached',
      discoveryState: 'cached',
      layers: [{ origin: 'cached', ids: cached!.models }, ...customLayers()],
      facts: cached!.facts,
      fromCache: true,
      stale: false,
    });
  }

  // 2) 没法问 (先说清为什么)
  if (!target.canDiscover) {
    notes.push(String(target.skipReason || '没有可做的发现'));
    const cachedOk = fallbackFromCache(cached);
    if (cachedOk.ok) {
      notes.push('有上次成功缓存 → 用它 (虽然本轮没有做发现)');
      return finish({
        origin: 'cached',
        discoveryState: 'cached',
        layers: [{ origin: 'cached', ids: cachedOk.ids }, ...customLayers()],
        facts: cachedOk.facts,
        fromCache: true,
        stale: false,
      });
    }
    const hasCustom = manualModels.length > 0 || declaredModels.length > 0;
    const origin: CatalogOrigin = hasCustom ? 'custom' : (curated.length ? 'curated' : 'unavailable');
    return finish({
      origin,
      discoveryState: origin,
      layers: fallbackLayers(),
      fromCache: false,
      stale: false,
    });
  }

  // 3) 真问
  const cred = target.entry ? authHeadersFor(target.entry, target.apiKey) : { headers: {}, query: {} };
  let url = target.endpoint;
  if (Object.keys(cred.query).length) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}${new URLSearchParams(cred.query).toString()}`;
  }
  const flag: TimeoutFlag = { timedOut: false };
  let res: Response | null = null;
  let failure: DiscoveryFailure | null = null;
  let parsed: CatalogParse | null = null;

  try {
    res = await fetchWithProbeTimeout(url, { method: 'GET', headers: cred.headers }, timeoutMs, fetchImpl, flag);
  } catch (e) {
    const c = classifyNetworkError(e, flag, timeoutMs);
    failure = { failureClass: c.failureClass, reason: c.detail, at: nowIso };
  }

  if (res) {
    let body: Json = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch { body = null; }
    const statusFail = classifyStatus(res, body, url, 'catalog');
    if (statusFail) {
      failure = { failureClass: statusFail.failureClass, reason: statusFail.detail, at: nowIso };
    } else {
      parsed = parseCatalogBody(body, target.entry?.protocol || 'openai-compatible');
      if (parsed.kind === 'shape_error') {
        failure = {
          failureClass: 'protocol_mismatch',
          reason: `端点回了 200 但不是模型目录形状 — ${parsed.detail} (${snippetOf(body, res)})`,
          at: nowIso,
        };
      } else if (parsed.ids.length === 0) {
        failure = {
          failureClass: 'model_not_found',
          reason: '目录端点返回了 0 个模型 (HTTP 200) — **不当作空目录**, 也不覆盖上次成功缓存',
          at: nowIso,
        };
      }
    }
  }

  // 4) 成功: 写缓存 + 快照
  if (parsed && parsed.kind === 'ok' && parsed.ids.length > 0) {
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const entry: DiscoveryCacheEntry = {
      provider: target.provider,
      baseUrl: target.baseUrl,
      credentialIdentity: target.credentialIdentity,
      // **不带认证 query**: gemini/query-key 那种把凭据放在 URL 上的协议,
      // 存进来的必须是没有凭据的那一份端点 (凭据一个字节都不落盘)
      endpoint: target.endpoint,
      models: parsed.ids,
      facts: parsed.facts,
      manualModels,
      lastSuccessAt: nowIso,
      fetchedAt: nowIso,
      expiresAt,
    };
    const next: DiscoveryCacheFile = { version: DISCOVERY_CACHE_VERSION, entries: { ...cacheFile.entries, [target.cacheKey]: entry } };
    await writeDiscoveryCache(next);
    notes.push(`真取到 ${parsed.ids.length} 个模型 → 已写缓存 (有效期到 ${expiresAt}, 键 = provider+baseUrl+凭证指纹)`);
    return finish({
      origin: 'live',
      discoveryState: 'live',
      layers: [
        { origin: 'live', ids: parsed.ids },
        ...customLayers(),
      ],
      facts: parsed.facts,
      fromCache: false,
      stale: false,
    });
  }

  // 5) 失败: 保留 provider + 标 unavailable + 原因, 清单走回退链
  const fail: DiscoveryFailure = failure || { failureClass: 'provider_unreachable', reason: '发现失败但没拿到原因 (内部错误)', at: nowIso };
  notes.push(`发现失败 (${fail.failureClass}): ${fail.reason}`);
  notes.push('provider **没有被删除** —— 保留在列表里并标 unavailable, 原因如上');
  const cachedOk = fallbackFromCache(cached);
  const useManualLayers = fallbackLayers();
  if (cachedOk.ok) {
    notes.push(`回退到上次成功缓存 (${cachedOk.ids.length} 个模型, 取自 ${cached!.lastSuccessAt})`);
    return finish({
      origin: 'cached',
      discoveryState: 'unavailable',
      layers: [{ origin: 'cached', ids: cachedOk.ids }, ...customLayers()],
      facts: cachedOk.facts,
      fromCache: true,
      stale: !(cached!.expiresAt && Date.parse(cached!.expiresAt) > nowMs),
      failure: fail,
    });
  }
  const hasCustomFallback = useManualLayers.some((l) => l.ids.length > 0 && l.origin === 'custom');
  const hasFallback = useManualLayers.some((l) => l.ids.length > 0);
  if (hasFallback) {
    notes.push('没有上次成功缓存 → 回退到' + (hasCustomFallback ? '用户声明/手输的模型' : '内置目录'));
  } else {
    notes.push('没有上次成功缓存, 也没有内置目录/手输模型 → 这一家只保留名字, 清单为空 (不编)');
  }
  return finish({
    origin: hasCustomFallback ? 'custom' : (curated.length ? 'curated' : 'unavailable'),
    discoveryState: 'unavailable',
    layers: useManualLayers,
    facts: {},
    fromCache: false,
    stale: false,
    failure: fail,
  });
}

// ============================================================
// 命令面能力 (做成可调用函数; 命令面接线不归本层)
// ============================================================

/**
 * 在册的 provider id 清单 (顺序 = 注册表自己的展示顺序: 优先清单 → 其余内置 → 自定义)。
 *
 * **不在本层另排一份**: 直接读 `provider-registry` 的那张表, 于是"注册表加了新家、列表里看不到"
 * 这种两处真相不会发生。
 */
function registryProviderIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of listProviderRegistry()) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    ids.push(entry.id);
  }
  // 注册表快照是同步读口; 快照还没刷过时补上盘上的自定义供应商 (仍然一家不删)
  for (const spec of Object.values(customProviderSnapshot())) {
    const id = String((spec as any)?.providerId || '');
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

/**
 * 全部在册供应商的目录结论 (**一家都不删**)。
 *
 * `providerId` 给了就只看这一家; 没给就看全册 (命令面 `/model list`)。
 */
export async function listModelCatalog(
  providerId?: string,
  opts: DiscoverOptions & { concurrency?: number } = {},
): Promise<CatalogListing> {
  const single = String(providerId || '').trim();
  const ids = single ? [single] : registryProviderIds();
  const entries = await Promise.all(ids.map((id) => discoverProviderModels(id, opts).catch((e) => {
    // 连发现本身崩了也不许把这家删掉: 保留 + 标 unavailable + 原因
    return crashCatalog(id, String((e as any)?.message ?? e));
  })));
  const unavailable = entries
    .filter((c) => c.discoveryState === 'unavailable')
    .map((c) => ({
      provider: c.provider,
      ...(c.failure ? { failureClass: c.failure.failureClass } : {}),
      reason: c.failureReason || c.notes[c.notes.length - 1] || '发现失败',
    }));
  const notes: string[] = [];
  if (!single) {
    const absent = registryProviderIds().filter((id) => !entries.some((e) => e.provider === id));
    if (absent.length) notes.push(`内部错误: ${absent.join(', ')} 没出现在结果里 (门会判红)`);
  }
  return {
    generatedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    cachePath: discoveryCachePath(),
    entries,
    unavailable,
    notes,
  };
}

/** 发现过程中自己崩了 → 也要有一条"保留 + 原因"的记录 */
function crashCatalog(provider: string, reason: string): DiscoveredCatalog {
  const cat: DiscoveredCatalog = {
    provider,
    baseUrl: '',
    baseUrlSource: null,
    endpoint: '',
    requiresApiKey: true,
    credentialIdentity: ANONYMOUS_IDENTITY,
    credentialSource: 'none',
    credentialReady: false,
    cacheKey: discoveryCacheKey(provider, '', ANONYMOUS_IDENTITY),
    origin: 'unavailable',
    discoveryState: 'unavailable',
    models: [],
    modelOrigins: {},
    facts: {},
    manualModels: [],
    declaredModels: [],
    fetchedAt: null,
    expiresAt: null,
    fromCache: false,
    stale: false,
    discoveryFailed: true,
    failure: { failureClass: 'provider_unreachable', reason: `发现过程中出错: ${reason}`, at: new Date().toISOString() },
    failureReason: `发现过程中出错: ${reason}`,
    keptDespiteFailure: true,
    notes: ['发现过程中抛错 → provider 仍保留 (不静默删)'],
  };
  discoverySnapshot.set(provider, cat);
  return cat;
}

/**
 * `/model refresh` 的能力: **强制**真取一次 (忽略新鲜缓存), 返回逐家结论 + 失误清单。
 *
 * `providerIds` 省略 = 全册。
 */
export async function refreshModelDiscovery(
  providerIds?: string | string[],
  opts: DiscoverOptions = {},
): Promise<DiscoveryRefreshReport> {
  const ids = providerIds === undefined
    ? registryProviderIds()
    : (Array.isArray(providerIds) ? providerIds : [providerIds]).map((s) => String(s || '').trim()).filter(Boolean);
  const results = await Promise.all(ids.map((id) => discoverProviderModels(id, { ...opts, force: opts.force !== false })
    .catch((e) => crashCatalog(id, String((e as any)?.message ?? e)))));
  const counts: Record<CatalogOrigin, number> = { live: 0, cached: 0, curated: 0, custom: 0, unavailable: 0 };
  for (const c of results) counts[c.discoveryState] = (counts[c.discoveryState] || 0) + 1;
  const failures = results
    .filter((c) => c.discoveryFailed && c.failure)
    .map((c) => ({ provider: c.provider, failureClass: c.failure!.failureClass, reason: c.failureReason || c.failure!.reason }));
  const notes: string[] = [];
  if (counts.unavailable) notes.push(`${counts.unavailable} 家本轮发现失败 —— 全部保留在列表里并带原因, 一家都没删`);
  return {
    refreshedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    force: true,
    cachePath: discoveryCachePath(),
    results,
    counts,
    failures,
    notes,
  };
}

/**
 * 手工输入一个自定义模型 ID (自定义模型允许手动输入)。
 *
 * 落在**该 provider + baseUrl + 凭证身份**那条缓存记录的 `manualModels` 上:
 * 于是它在断网、端点没目录、凭证被拒时**依然在清单里**, 标记 `custom`。
 */
export async function admitManualModel(
  providerId: string,
  modelId: string,
  opts: DiscoverOptions = {},
): Promise<{ ok: true; catalog: DiscoveredCatalog } | { ok: false; reason: string }> {
  const id = String(providerId || '').trim();
  const model = String(modelId || '').trim();
  if (!model) return { ok: false, reason: '模型 ID 为空' };
  if (model.length > MANUAL_MODEL_MAX_LEN) return { ok: false, reason: `模型 ID 太长 (${model.length} > ${MANUAL_MODEL_MAX_LEN})` };
  if (/\s/.test(model)) return { ok: false, reason: '模型 ID 里不许有空白字符' };
  if (/[\u0000-\u001f]/.test(model)) return { ok: false, reason: '模型 ID 里有控制字符' };
  const target = await resolveDiscoveryTarget(id, opts);
  const file = await readDiscoveryCache();
  const prev = file.entries[target.cacheKey];
  const manualModels = trimNotes([...(prev?.manualModels || []), model]);
  const entry: DiscoveryCacheEntry = {
    provider: target.provider,
    baseUrl: target.baseUrl,
    credentialIdentity: target.credentialIdentity,
    endpoint: target.endpoint,
    models: prev?.models || [],
    facts: prev?.facts || {},
    manualModels,
    lastSuccessAt: prev?.lastSuccessAt ?? null,
    fetchedAt: prev?.fetchedAt ?? null,
    expiresAt: prev?.expiresAt ?? null,
  };
  await writeDiscoveryCache({ version: DISCOVERY_CACHE_VERSION, entries: { ...file.entries, [target.cacheKey]: entry } });
  const catalog = await discoverProviderModels(id, { ...opts, manualModels });
  return { ok: true, catalog };
}

/** 撤掉一个手工输入的模型 ID (`true` = 真有这一条被撤掉) */
export async function forgetManualModel(providerId: string, modelId: string, opts: DiscoverOptions = {}): Promise<boolean> {
  const id = String(providerId || '').trim();
  const model = String(modelId || '').trim();
  const target = await resolveDiscoveryTarget(id, opts);
  const file = await readDiscoveryCache();
  const prev = file.entries[target.cacheKey];
  if (!prev) return false;
  const manualModels = (prev.manualModels || []).filter((m) => m !== model);
  if (manualModels.length === (prev.manualModels || []).length) return false;
  await writeDiscoveryCache({
    version: DISCOVERY_CACHE_VERSION,
    entries: { ...file.entries, [target.cacheKey]: { ...prev, manualModels } },
  });
  return true;
}

// ============================================================
// 展示 (凭据**不进**这里)
// ============================================================

/** 来源标记 → 中文 (渲染层只翻译, 不产生值) */
export function catalogOriginZh(o: CatalogOrigin): string {
  switch (o) {
    case 'live': return '实时目录';
    case 'cached': return '上次成功缓存';
    case 'curated': return '内置目录';
    case 'custom': return '用户声明/手输';
    case 'unavailable': return '发现不可用';
    default: return String(o);
  }
}

/** 一家一行 (命令面 `/model list` 直接用) */
export function formatCatalogLine(c: DiscoveredCatalog): string {
  const bits: string[] = [
    `${catalogOriginZh(c.origin)}(${c.origin})`,
    `${c.models.length} models`,
  ];
  if (c.fromCache) bits.push(c.stale ? '缓存已过期' : '缓存命中');
  const cred = c.credentialIdentity === ANONYMOUS_IDENTITY
    ? (c.requiresApiKey ? '未配置凭据' : '免 key')
    : `凭据指纹 ${c.credentialIdentity}`;
  bits.push(cred);
  if (c.discoveryFailed) bits.push(`⚠ 本轮发现失败: ${String(c.failureReason || '原因未明').slice(0, 100)}`);
  return `· ${c.provider} · ${bits.join(' · ')}`;
}

/** 整个列表的摘要行 (命令面直接打) */
export function formatListingSummary(l: CatalogListing): string[] {
  const out: string[] = [`模型目录 · ${l.entries.length} 家 (含本轮发现失败的, 一家都没删) · 缓存: ${l.cachePath}`];
  for (const u of l.unavailable) out.push(`  ⚠ ${u.provider} · unavailable${u.failureClass ? `(${u.failureClass})` : ''}: ${String(u.reason).slice(0, 120)}`);
  for (const n of l.notes) out.push(`  ${n}`);
  return out;
}

// ============================================================
// 元数据填充点 (P2 冻结接口; 只填自己有真值的项)
// ============================================================

export const DISCOVERY_SOURCE_ID = 'live-discovery';

/**
 * 目录缓存/发现结果的元数据填充点。
 *
 * - `origin`: 只在这个模型**真在**本层某一份清单里时填 (逐条来源);
 * - 能力字段: **只填响应体里字面读到的** (见 `FACT_KEYS`), 其余不出现 → 保持 `unknown`;
 * - 纯同步: 只读进程内快照 (`currentDiscoveryCatalog`), 不发请求、不读盘。
 */
export function modelDiscoveryMetadataSource(): ModelMetadataSource {
  return {
    id: DISCOVERY_SOURCE_ID,
    metadataOf: ({ provider, model }: { provider: string; model: string }): ModelCapabilityFacts | undefined => {
      const cat = discoverySnapshot.get(String(provider || ''));
      if (!cat) return undefined;
      const id = String(model || '');
      const facts = cat.facts[id] || {};
      const out: ModelCapabilityFacts = {};
      const origin = cat.modelOrigins[id];
      // 只填**本层真有结论**的来源: `curated` 是 P2 自己的默认口径 (`curatedOriginOf`),
      // 本层不认领它 —— 否则"没跑过发现"的 provider 也会被填成一个非本层的答案。
      if (origin && origin !== 'curated') out.origin = origin;
      if (facts.displayName) out.displayName = facts.displayName;
      if (facts.toolCalling) out.toolCalling = facts.toolCalling;
      if (facts.reasoning) out.reasoning = facts.reasoning;
      if (typeof facts.contextLength === 'number') out.contextLength = facts.contextLength;
      return Object.keys(out).length ? out : undefined;
    },
  };
}

let discoverySourceWired = false;

/** 显式接线 (测试里 `resetModelMetadataSources()` 之后靠它接回去) */
export function registerDiscoveryMetadataSource(): void {
  registerModelMetadataSource(modelDiscoveryMetadataSource());
  discoverySourceWired = true;
}

/**
 * 调用时自动接线 (幂等, 只做一次) —— 与 P3 的填充点同一套做法:
 * 不放在模块体里 (避免 import 顺序造成的 TDZ), 但**任何一次**本层公开调用都会接上。
 */
export function ensureDiscoveryMetadataSource(): void {
  if (discoverySourceWired) return;
  registerDiscoveryMetadataSource();
}

/** 本层的填充点现在有没有接上 (排障/门用) */
export function isDiscoveryMetadataSourceWired(): boolean {
  return listModelMetadataSources().includes(DISCOVERY_SOURCE_ID);
}
