/**
 * provider-registry.ts — 供应商注册表 + 兼容协议 (P3, 2026-09-26)
 *
 * ## 这一层解决什么
 *
 * 此前「供应商」只是一串写死的名字 (`config-store.ModelProvider` 联合类型 + 几处各自的 switch),
 * 于是每加一家就要改类型、改 switch、改白名单, 而且**谁也不知道某一家到底支不支持工具调用 /
 * reasoning / 能不能当长期任务执行器** —— 这些判定此前散落在各处的 `if` 里, 甚至根本不存在。
 *
 * 本文件把它们收成两层:
 *
 *   ① **注册表 (registry)**: 每个供应商一条**逐项有出处**的记录 —— 默认 URL · API key 环境变量 ·
 *      默认模型 · 模型发现方式 · 认证方式 · 是否要 key · 工具调用 · reasoning · 是否本地 ·
 *      是否允许作为长期任务执行器。字段值**不在这里编**, 能从既有真表派生的就派生
 *      (`config-store` 的默认表 / `model-selection` 的协议与鉴权表 / `model-catalog` 的本地判定),
 *      派生不到的才允许是新事实, 且必须写明证据 (`toolCallingEvidence`)。
 *   ② **兼容协议 (protocol)**: `openai-compatible|anthropic|gemini|ollama` 四条线上协议。
 *      自定义供应商**只声明协议**, 不上改 TS 联合类型 —— 运行时把它接到说同一种协议的内置分支上
 *      (`runtimeProviderIdOf`)。
 *
 * ## 与既有表的关系 (不许两处真相)
 *
 * | 字段 | 真出处 |
 * | --- | --- |
 * | `defaultBaseUrl` / `defaultModel` | `config-store.DEFAULT_PROVIDER_CONFIGS` (调用时读) |
 * | `apiKeyEnvVars` | `model-selection.envKeyNamesOf` |
 * | `protocol` | `model-selection.protocolOf` |
 * | `reasoning` | `model-selection.supportsReasoning` (不在集合里 → `unknown`, **不写 `no`**) |
 * | `requiresApiKey` | `config-store.PROVIDER_INFO` (P2 已冻结"注册表是这家的主来源") |
 * | `isLocal` | `model-catalog.isLocalBaseUrl` (base URL 主机名真判定) |
 * | `baseUrlEnvVars` | 客户端取 base URL 的那张表 (`pi-ai.ts`) |
 * | `toolCalling` / `discovery` / `auth` | **本文件的新事实**, 证据写在 `toolCallingEvidence` / 表注释 |
 *
 * 逐项相等由门禁钉住 (`src/test/provider-registry.test.ts` 的源码级门 + `scripts/verify-provider-registry.ts`,
 * 漂移即判红), 所以"派生"不是口头承诺。
 *
 * ## 元数据填充点
 *
 * 本文件向 P2 冻结的元数据接口注册一个填充点 (`id = 'provider-registry'`), **只回答自己有真值的项**:
 *
 *   - `requiresApiKey`: 注册表维度的事实 → 填;
 *   - `origin`: 只有**自定义供应商**填 `'custom'` (它的模型清单来自用户声明)。内置供应商不填 ——
 *     `model-catalog.curatedOriginOf` 已经在回答, 这里覆盖它等于在没有新证据的情况下改别人那层的结论;
 *   - `toolCalling` / `reasoning` / `contextLength`: **只有**自定义供应商**显式声明**过的才填。
 *     内置供应商一个都不填 —— 内置注册表只有**供应商级**能力, 模型级能力只有真目录 (P5) 能给,
 *     拿供应商级数据装成模型级就是 P2 明令禁止的"编一个看起来像真的值"。
 *
 * 填充点必须**纯同步** (P2 冻结约定): 所以自定义供应商在进程内只以**已读到的快照**存在
 * (`setCustomProviderSnapshot`)。快照由 `config-store.initialize()` (读配置后) 与
 * `custom-provider-store` (每次读写后) 推入; 本文件**不**在这里读盘、不发请求。
 */

import { DEFAULT_PROVIDER_CONFIGS, PROVIDER_INFO, type ModelProvider } from './config-store.js';
import {
  protocolOf, supportsReasoning, envKeyNamesOf, normalizeBaseUrl,
  type ModelProtocol,
} from './model-selection.js';
import {
  registerModelMetadataSource,
  isLocalBaseUrl,
  type Capability,
  type ModelCapabilityFacts,
  type ModelMetadataSource,
} from './model-catalog.js';

// ============================================================
// 类型
// ============================================================

/** 线上协议 (与 P1 冻结的 `ModelProtocol` **同一个**联合类型, 不另起一个) */
export type ProviderProtocol = ModelProtocol;

export type ProviderKind = 'builtin' | 'custom';

/** 模型发现方式 (怎么问出"这家有哪些模型") */
export type ProviderDiscovery =
  | 'openai-models'   // GET <base>/models
  | 'gemini-models'   // GET <base>/models (Google 形状)
  | 'ollama-tags'     // GET <base>/api/tags
  | 'manual';         // 没有可用的目录端点 → 只能手工填 model ID

/** 认证方式 */
export type ProviderAuthKind = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'query-key' | 'none' | 'custom';

/** 认证怎么摆 (头名 / 前缀 / query 参数) */
export interface ProviderAuthSpec {
  kind: ProviderAuthKind;
  /** 放哪个请求头 (kind='none' 时无) */
  header?: string;
  /** 前缀, 例如 `Bearer` */
  scheme?: string;
  /** 放哪个 query 参数 (kind='query-key') */
  query?: string;
}

/** 自定义供应商里声明的能力 (真来源: **用户声明**) */
export interface CustomProviderCapabilities {
  toolCalling?: Capability;
  reasoning?: Capability;
  contextLength?: number;
}

/**
 * 自定义供应商 (落盘形状)。
 *
 * 关键字段就是**兼容协议**: 用户只说"这是什么协议 + 地址是什么", 其余由注册表推。
 */
export interface CustomProviderConfig {
  providerId: string;
  displayName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** 凭据 —— 与内置供应商同等待遇 (config 文件 mode 0600, 永不打印/永不进快照) */
  apiKey?: string;
  /** 默认模型 */
  model?: string;
  /**
   * 模型发现端点。相对路径 (例如 `/models`) 会拼在 `baseUrl` 后面; 绝对 URL 原样用。
   * 不给 = 按协议默认 (`authOfProtocol` 同一张表)。
   */
  modelsEndpoint?: string;
  /** 自定义认证头名 (例如 `Authorization` / `x-api-key`) —— 不给 = 按协议默认 */
  authHeader?: string;
  /** 读 key 的环境变量名 (可省; 给了就参与校验/回填) */
  apiKeyEnvVar?: string;
  /** 已知的模型 ID 清单 (可省; 给了就是这家唯一的目录来源 → `origin='custom'`) */
  models?: string[];
  /** 声明的能力 (可省; **不声明 = unknown**, 不许由本层补默认值) */
  capabilities?: CustomProviderCapabilities;
  updatedAt?: string;
}

/** 注册表的一条记录 (内置与自定义**同一形状**, 调用方不必分叉) */
export interface ProviderRegistryEntry {
  id: string;
  displayName: string;
  kind: ProviderKind;
  protocol: ProviderProtocol;
  /** 内置默认 URL (不含用户配置里的覆盖) */
  defaultBaseUrl: string;
  /** 默认模型 */
  defaultModel: string;
  /** 读 API key 的环境变量名 (按优先级; 可能为空) */
  apiKeyEnvVars: string[];
  /** 覆盖 base URL 的环境变量名 (按优先级; 真出处: 客户端取 base URL 的表) */
  baseUrlEnvVars: string[];
  discovery: ProviderDiscovery;
  /** 模型目录端点的完整 URL (`discovery='manual'` 时是空串, 表示没有端`) */
  modelsEndpoint: string;
  auth: ProviderAuthSpec;
  /** 这家要不要 key (真出处: `PROVIDER_INFO`) */
  requiresApiKey: boolean;
  /** 工具调用能力 —— **运行时口径**: "这家现在能不能用于工具调用" (原生 tools 真的发得出去吗) */
  toolCalling: Capability;
  /** reasoning 能力 (真出处: `supportsReasoning`) */
  reasoning: Capability;
  /** 在册的模型 ID 清单 (内置 = 内置目录, 自定义 = 用户声明; 没有清单 → 空数组) */
  declaredModelIds: string[];
  isLocal: boolean;
  /** 是否允许作为长期任务执行器 (后台 Run/Goal) */
  allowsLongRunningExecutor: boolean;
  /** 上面那一格的**理由** (不许只给答案不给理由) */
  longRunningReason: string;
  /** `toolCalling` 这个值从哪来 (证据句) */
  toolCallingEvidence: string;
  /** 逐字段出处 (字段名 → 真出处); 门禁要求九项能力字段项项有出处 */
  provenance: Record<string, string>;
}

/**
 * 注册表**必须提供**的能力字段 (P3 验收逐项对上这里; 少一项就算没做完)。
 * 顺序 = 计划里的顺序。名字与 `ProviderRegistryEntry` 的键一致。
 */
export const REQUIRED_REGISTRY_FIELDS = [
  'defaultBaseUrl',        // 默认 URL
  'apiKeyEnvVars',         // API key 环境变量
  'defaultModel',          // 默认模型
  'discovery',             // 模型发现方式
  'auth',                  // 认证方式
  'toolCalling',           // 是否支持工具调用
  'reasoning',             // 是否支持 reasoning
  'isLocal',               // 是否本地
  'allowsLongRunningExecutor', // 是否允许作为长期任务执行器
] as const;
export type RequiredRegistryField = (typeof REQUIRED_REGISTRY_FIELDS)[number];

// ============================================================
// 新事实 (1): 谁能发原生工具调用
// ============================================================

/**
 * 本运行时会**真的把原生 tools 发出去**的供应商。
 *
 * 真出处: 客户端的路由表 —— `generateText()` 的 switch 里, 只有指向
 * `callOpenAI(..., openaiTools)` 的那条分支收得到工具数组; 其余分支这条签名里根本没有 tools。
 * 所以这个集合不是"猜哪些厂商支持工具", 而是**这条运行路径上工具调用真的能通吗**。
 *
 * 门禁 (`src/test/provider-registry.test.ts`) 会去 parse 那张路由表, 双向断言集合相等:
 * 客户端加了新分支 / 撤了旧分支, 而没同步这里 → **判红**。
 */
export const NATIVE_TOOL_CALLING_IDS: readonly string[] = [
  'openai', 'minimax', 'deepseek', 'kimi', 'glm', 'qwen', 'mimo', 'grok',
];

const NATIVE_TOOL_EVIDENCE =
  '本运行时把原生 tools 交给 callOpenAI 分支 (客户端 generateText 路由表), 工具调用真能通';

const NO_NATIVE_TOOL_EVIDENCE =
  '本运行时的这条协议分支不接收原生 tools (客户端 generateText 路由表) → 工具调用发不出去; '
  + '这是**运行时口径**, 不等于供应商 API 本身不支持工具';

// ============================================================
// 新事实 (2): 协议 → 发现方式 / 认证方式
// ============================================================

/**
 * 协议 → 默认发现方式。
 *
 * 出处: 探活/取目录用的是 `config-store.buildTestRequest` 那张表 —— openai 兼容与 openrouter 走
 * `GET <base>/models`, gemini 走 `<base>/models?key=`, ollama/local 走 `GET <base>/api/tags`。
 */
export function discoveryOfProtocol(protocol: ProviderProtocol): ProviderDiscovery {
  switch (protocol) {
    case 'gemini': return 'gemini-models';
    case 'ollama': return 'ollama-tags';
    // anthropic 没有可用的 GET /v1/models (见下方覆盖表的理由) → 只能手工填 model ID
    case 'anthropic': return 'manual';
    case 'openai-compatible':
    default: return 'openai-models';
  }
}

/**
 * 逐家覆盖 (只在"协议默认说法不成立"时才允许出现一条, 且必须写理由)。
 *
 * - `anthropic`: 仓库里已有的实测结论是 **没有可用的 `GET /v1/models`** (v0.2.15 的探活注释:
 *   "Anthropic has no GET /v1/models endpoint -> always 404"), 所以这家只能走**手工 model ID**。
 *   这不是"懒得接", 是已知端点的真结论。
 */
const DISCOVERY_OVERRIDES: Record<string, { discovery: ProviderDiscovery; reason: string }> = {
  anthropic: {
    discovery: 'manual',
    reason: '本仓实测: 没有可用的 GET /v1/models (探活表注释 v0.2.15) → 只能手工填 model ID',
  },
};

/** 协议 → 默认认证方式 (出处: 取 base URL/鉴权头的那两张真表: config-store.buildHeaders + 客户端分支) */
export function authOfProtocol(protocol: ProviderProtocol): ProviderAuthSpec {
  switch (protocol) {
    case 'anthropic':
      return { kind: 'x-api-key', header: 'x-api-key' };
    case 'gemini':
      // 客户端 chat 分支用 `?key=`; 探活分支用 `x-goog-api-key` 头 —— 两个都写出来, 由调用方选
      return { kind: 'query-key', header: 'x-goog-api-key', query: 'key' };
    case 'ollama':
      return { kind: 'none' };
    case 'openai-compatible':
    default:
      return { kind: 'bearer', header: 'Authorization', scheme: 'Bearer' };
  }
}

// ============================================================
// 内置优先保障清单
// ============================================================

/** 计划里点名要优先保障的那些 (只影响展示顺序, 不参与任何判定) */
export const PRIORITY_BUILTIN_IDS: readonly string[] = [
  'openai', 'anthropic', 'gemini', 'deepseek', 'minimax', 'kimi', 'qwen', 'glm', 'openrouter', 'ollama', 'grok',
];

/** 除优先清单外还在册的内置供应商 (`local` = 本地端点的另一个 id, `mimo` = 小米 MiMo) */
export const EXTRA_BUILTIN_IDS: readonly string[] = ['mimo', 'local'];

/**
 * 覆盖 base URL 的环境变量名 (真出处: 客户端取 base URL 的表)。
 * 只列真有环境变量覆盖的那几家; 其余家只能靠显式 `--base-url` 或配置里的 baseUrl。
 */
const BASE_URL_ENV_VARS: Record<string, string[]> = {
  openai: ['OPENAI_BASE_URL'],
  openrouter: ['OPENROUTER_BASE_URL'],
  minimax: ['MINIMAX_BASE_URL'],
  deepseek: ['DEEPSEEK_BASE_URL'],
  kimi: ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
  glm: ['GLM_BASE_URL', 'ZHIPU_BASE_URL'],
  qwen: ['QWEN_BASE_URL', 'DASHSCOPE_BASE_URL'],
  mimo: ['MIMO_BASE_URL'],
  grok: ['XAI_BASE_URL'],
  ollama: ['OLLAMA_BASE_URL'],
};

/** 在册的内置供应商 id (顺序 = 既有内置表顺序; 不参与判定) */
export function listBuiltinProviderIds(): string[] {
  return Object.keys(DEFAULT_PROVIDER_CONFIGS);
}

/** 这个 id 是不是内置供应商 */
export function isBuiltinProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEFAULT_PROVIDER_CONFIGS, id);
}

// ============================================================
// 条目构造 (内置: 除 toolCalling/discovery/auth 外全部派生)
// ============================================================

const PROVENANCE = {
  defaultBaseUrl: 'config-store.DEFAULT_PROVIDER_CONFIGS.baseUrl (内置默认表)',
  defaultModel: 'config-store.DEFAULT_PROVIDER_CONFIGS.model (内置默认表)',
  apiKeyEnvVars: 'model-selection.envKeyNamesOf (环境变量凭据表)',
  protocol: 'model-selection.protocolOf (协议表)',
  requiresApiKey: 'config-store.PROVIDER_INFO.requiresApiKey (P2 冻结: 注册表是主来源)',
  reasoning: 'model-selection.supportsReasoning (不在集合里 → unknown, 不写 no)',
  isLocal: 'model-catalog.isLocalBaseUrl (base URL 主机名真判定)',
  baseUrlEnvVars: '客户端取 base URL 的表 (pi-ai.ts getBaseUrl)',
  discovery: 'config-store.buildTestRequest 的端点表 + 逐家覆盖表',
  auth: 'config-store.buildHeaders / 客户端取 base URL 与鉴权分支',
  toolCalling: '本文件 NATIVE_TOOL_CALLING_IDS (客户端 generateText 路由表)',
  allowsLongRunningExecutor: '本文件判定: 需要 toolCalling=yes (工具调用发不出去的通道不能跑长期任务)',
} as const;

function longRunningVerdict(toolCalling: Capability, evidence: string, extraReason?: string): { ok: boolean; reason: string } {
  if (toolCalling === 'yes') {
    return { ok: true, reason: '允许: 该分支会发出原生工具调用 (工具调用=支持)' };
  }
  const why = toolCalling === 'no'
    ? '工具调用=不支持 (这条协议分支发不出原生 tools)'
    : '工具调用=未知 (没有真来源 → 不拿未知当可用)';
  return { ok: false, reason: `不允许: ${why}${extraReason ? `; ${extraReason}` : ''} (证据: ${evidence})` };
}

/** 内置供应商的一条注册表记录 (`id` 不在内置表里 → `undefined`, 不编一条出来) */
export function builtinProviderEntry(id: string): ProviderRegistryEntry | undefined {
  const def = (DEFAULT_PROVIDER_CONFIGS as Record<string, { baseUrl: string; model: string }>)[id];
  if (!def) return undefined;
  const info = (PROVIDER_INFO as Record<string, { name?: string; requiresApiKey?: boolean }>)[id];
  const protocol = protocolOf(id);
  const baseUrl = normalizeBaseUrl(def.baseUrl);
  const discovery = DISCOVERY_OVERRIDES[id]?.discovery ?? discoveryOfProtocol(protocol);
  const toolCalling: Capability = NATIVE_TOOL_CALLING_IDS.includes(id) ? 'yes' : 'no';
  const evidence = toolCalling === 'yes' ? NATIVE_TOOL_EVIDENCE : NO_NATIVE_TOOL_EVIDENCE;
  const verdict = longRunningVerdict(toolCalling, evidence);
  const entry: ProviderRegistryEntry = {
    id,
    displayName: String(info?.name || id),
    kind: 'builtin',
    protocol,
    defaultBaseUrl: baseUrl,
    defaultModel: String(def.model || ''),
    apiKeyEnvVars: envKeyNamesOf(id),
    baseUrlEnvVars: BASE_URL_ENV_VARS[id] || [],
    discovery,
    modelsEndpoint: '',
    auth: authOfProtocol(protocol),
    requiresApiKey: info?.requiresApiKey !== false,
    toolCalling,
    reasoning: supportsReasoning(id) ? 'yes' : 'unknown',
    declaredModelIds: declaredModelIdsOf(id),
    isLocal: isLocalBaseUrl(baseUrl),
    allowsLongRunningExecutor: verdict.ok,
    longRunningReason: verdict.reason,
    toolCallingEvidence: evidence,
    provenance: { ...PROVENANCE },
  };
  entry.modelsEndpoint = modelsEndpointOf(entry);
  return entry;
}

// ============================================================
// 自定义供应商 → 条目
// ============================================================

/** 自定义供应商的能力一栏永远来自声明; 没声明就是 `unknown` (不补默认值) */
function customEntry(id: string, spec: CustomProviderConfig): ProviderRegistryEntry {
  const protocol = spec.protocol;
  const baseUrl = normalizeBaseUrl(spec.baseUrl);
  const declared = Array.isArray(spec.models) ? spec.models.filter((m) => typeof m === 'string' && m.trim()) : [];
  const cap = spec.capabilities || {};
  const toolCalling: Capability = cap.toolCalling ?? 'unknown';
  const reasoning: Capability = cap.reasoning ?? 'unknown';
  const localOnly = protocol === 'ollama' || isLocalBaseUrl(baseUrl);
  const auth: ProviderAuthSpec = spec.authHeader
    ? {
      kind: 'custom',
      header: spec.authHeader.trim(),
      // Authorization 是唯一有通用约定的头 (`Bearer <key>`); 其余自定义头按原值放
      scheme: /^authorization$/i.test(spec.authHeader.trim()) ? 'Bearer' : undefined,
    }
    : authOfProtocol(protocol);
  const evidence = toolCalling === 'yes'
    ? '自定义供应商显式声明了 capabilities.toolCalling=yes'
    : toolCalling === 'no'
      ? '自定义供应商显式声明了 capabilities.toolCalling=no'
      : '自定义供应商没有声明 capabilities.toolCalling → 未知 (不拿未知当可用)';
  // 长期任务: 既要"声明支持工具调用", 也要协议本身是本运行时会发原生 tools 的那条
  const openaiCompatible = protocol === 'openai-compatible';
  let verdict: { ok: boolean; reason: string };
  if (toolCalling === 'yes' && openaiCompatible) {
    verdict = { ok: true, reason: '允许: 声明 capabilities.toolCalling=yes 且协议是 openai-compatible (本运行时该分支发原生 tools)' };
  } else if (toolCalling === 'yes' && !openaiCompatible) {
    verdict = { ok: false, reason: `不允许: 声明了工具调用能力, 但协议 ${protocol} 的分支不发原生 tools (证据: ${evidence})` };
  } else if (toolCalling === 'no') {
    verdict = { ok: false, reason: `不允许: 工具调用=不支持 (自定义供应商显式声明); 证据: ${evidence}` };
  } else {
    verdict = { ok: false, reason: `不允许: 工具调用=未知 (自定义供应商没有声明 capabilities.toolCalling, 不拿未知当可用)` };
  }
  const entry: ProviderRegistryEntry = {
    id,
    displayName: spec.displayName || id,
    kind: 'custom',
    protocol,
    defaultBaseUrl: baseUrl,
    defaultModel: String(spec.model || ''),
    apiKeyEnvVars: spec.apiKeyEnvVar ? [spec.apiKeyEnvVar.trim()] : [],
    baseUrlEnvVars: [],
    discovery: discoveryOfProtocol(protocol),
    modelsEndpoint: '',
    auth,
    requiresApiKey: !localOnly,
    toolCalling,
    reasoning,
    declaredModelIds: [...declared],
    isLocal: isLocalBaseUrl(baseUrl),
    allowsLongRunningExecutor: verdict.ok,
    longRunningReason: verdict.reason,
    toolCallingEvidence: evidence,
    provenance: {
      defaultBaseUrl: '自定义供应商声明 (baseUrl)',
      defaultModel: '自定义供应商声明 (model)',
      apiKeyEnvVars: spec.apiKeyEnvVar ? '自定义供应商声明 (apiKeyEnvVar)' : '未声明 → 空 (只认配置/环境变量回退)',
      protocol: '自定义供应商声明 (protocol)',
      requiresApiKey: localOnly ? '本地端点或 ollama 协议 → 免 key (base URL 主机名真判定)' : '声明了远端地址 → 要 key',
      reasoning: cap.reasoning ? '自定义供应商声明 (capabilities.reasoning)' : '未声明 → unknown',
      isLocal: 'model-catalog.isLocalBaseUrl (base URL 主机名真判定)',
      baseUrlEnvVars: '未声明 → 空 (自定义供应商不走内置环境变量覆盖)',
      discovery: '按声明的协议取默认发现方式 (discoveryOfProtocol)',
      auth: spec.authHeader ? '自定义供应商声明 (authHeader)' : '按声明的协议取默认认证方式 (authOfProtocol)',
      toolCalling: '自定义供应商声明 (capabilities.toolCalling)',
      allowsLongRunningExecutor: '本文件判定: 需要声明 toolCalling=yes 且协议是 openai-compatible',
    },
  };
  entry.modelsEndpoint = modelsEndpointOf(entry, spec.modelsEndpoint);
  return entry;
}

// ============================================================
// 自定义供应商快照 (纯同步填充点的唯一数据源)
// ============================================================

let customSnapshot: Record<string, CustomProviderConfig> = {};

/**
 * 覆盖进程内的自定义供应商快照。
 *
 * 只允许两处推: `config-store.initialize()` (读配置之后) 与 `custom-provider-store` (每次读写之后)。
 * 这样元数据填充点永远是纯同步的 (P2 冻结约定), 又不会出现"注册表里还是上一版"的陈旧结论。
 */
export function setCustomProviderSnapshot(map: Record<string, CustomProviderConfig> | null | undefined): void {
  customSnapshot = map && typeof map === 'object' ? map : {};
}

/** 当前快照 (排障/展示用; 不含任何网络或磁盘读) */
export function customProviderSnapshot(): Record<string, CustomProviderConfig> {
  return customSnapshot;
}

/** 单条自定义供应商的**声明** (拿不到 → undefined; 不编) */
export function customProviderSpecOf(id: string): CustomProviderConfig | undefined {
  return customSnapshot[id];
}

// ============================================================
// 注册表读口
// ============================================================

/** 自定义供应商的一条记录 (`spec` 不在快照里也要能构造 —— 由调用方给声明) */
export function customProviderEntryOf(spec: CustomProviderConfig): ProviderRegistryEntry {
  return customEntry(spec.providerId, spec);
}

/** 全部在册供应商 (内置优先清单在前, 其余内置居中, 自定义在后; 顺序不参与判定) */
export function listProviderRegistry(): ProviderRegistryEntry[] {
  const order = [...PRIORITY_BUILTIN_IDS, ...EXTRA_BUILTIN_IDS];
  const builtins = listBuiltinProviderIds();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...order, ...builtins]) {
    if (!seen.has(id) && isBuiltinProvider(id)) { seen.add(id); ids.push(id); }
  }
  const out = ids.map((id) => builtinProviderEntry(id)!).filter(Boolean);
  for (const spec of Object.values(customSnapshot)) out.push(customEntry(spec.providerId, spec));
  return out;
}

/** 一个 id 的记录 (内置或自定义快照里有; 都没有 → `undefined`) */
export function getProviderRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  const bid = builtinProviderEntry(id);
  if (bid) return bid;
  const spec = customSnapshot[id];
  return spec ? customEntry(id, spec) : undefined;
}

/** 这个 id 现在**在册**吗 (内置 or 自定义快照) */
export function isRegisteredProvider(id: string): boolean {
  return getProviderRegistryEntry(id) !== undefined;
}

/** 协议 (注册表口径; 内置走冻结协议表, 自定义走声明) */
export function registryProtocolOf(id: string): ProviderProtocol | null {
  return getProviderRegistryEntry(id)?.protocol ?? null;
}

/**
 * 运行期 provider id —— **兼容协议的落点**。
 *
 * 自定义供应商不上改联合类型: 它在运行期接到"说同一种协议"的内置分支上 (openai-compatible → openai
 * 那条分支), 于是 `initMinimax({provider: runtimeProviderIdOf(entry), baseUrl, model})` 就能真出网。
 * 内置供应商返回自己 (客户端每条内置 id 都有自己的分支)。
 */
export function runtimeProviderIdOf(entry: ProviderRegistryEntry): string {
  if (entry.kind === 'builtin') return entry.id;
  switch (entry.protocol) {
    case 'anthropic': return 'anthropic';
    case 'gemini': return 'gemini';
    case 'ollama': return 'ollama';
    case 'openai-compatible':
    default: return 'openai';
  }
}

// ============================================================
// 端点与鉴权 (调用方拼请求用; **不是**打印用)
// ============================================================

/**
 * 模型目录端点 URL。
 *
 * `declaredEndpoint` (自定义供应商声明的 `modelsEndpoint`) 优先: 绝对 URL 原样用, 相对路径拼在
 * `defaultBaseUrl` 后。没有端点可用的 (`discovery='manual'`) 返回空串 —— 不编一个端点出来。
 */
export function modelsEndpointOf(entry: ProviderRegistryEntry, declaredEndpoint?: string): string {
  const base = normalizeBaseUrl(entry.defaultBaseUrl);
  const declared = String(declaredEndpoint || '').trim();
  if (declared) {
    if (/^https?:\/\//i.test(declared)) return declared;
    if (!base) return declared;
    return `${base}/${declared.replace(/^\/+/, '')}`;
  }
  if (!base) return '';
  switch (entry.discovery) {
    case 'ollama-tags': return `${base}/api/tags`;
    case 'manual': return '';
    case 'gemini-models':
    case 'openai-models':
    default: return `${base}/models`;
  }
}

/**
 * 认证头 / query 参数。
 *
 * 返回值**含凭据**, 只许用于当次请求构造: 不进日志、不进快照、不进报告 (`[REDACTED]`)。
 * `apiKey` 为空 → 返回空 (`kind='none'` 的本地端点本来也不需要)。
 */
export function authHeadersFor(entry: ProviderRegistryEntry, apiKey?: string): { headers: Record<string, string>; query: Record<string, string> } {
  const key = String(apiKey || '').trim();
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  if (entry.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (!key) return { headers, query };
  const auth = entry.auth;
  switch (auth.kind) {
    case 'bearer':
      headers[auth.header || 'Authorization'] = `${auth.scheme || 'Bearer'} ${key}`;
      break;
    case 'x-api-key':
      headers[auth.header || 'x-api-key'] = key;
      break;
    case 'x-goog-api-key':
      headers[auth.header || 'x-goog-api-key'] = key;
      break;
    case 'query-key':
      query[auth.query || 'key'] = key;
      if (auth.header) headers[auth.header] = key;
      break;
    case 'custom':
      if (auth.header) headers[auth.header] = auth.scheme ? `${auth.scheme} ${key}` : key;
      break;
    case 'none':
    default:
      break;
  }
  return { headers, query };
}

// ============================================================
// 长期任务执行器门
// ============================================================

/** 这家现在能不能当长期任务执行器 (后台 Run/Goal 需要真工具调用) */
export function canServeLongRunningTasks(id: string): boolean {
  return getProviderRegistryEntry(id)?.allowsLongRunningExecutor === true;
}

/** 不能当长期任务执行器的**理由** (可以的时候返回 `null`) */
export function longRunningRefusalReason(id: string): string | null {
  const entry = getProviderRegistryEntry(id);
  if (!entry) return `不在册的供应商: ${id} (注册表里没有这条)`;
  return entry.allowsLongRunningExecutor ? null : entry.longRunningReason;
}

// ============================================================
// 自定义供应商: 规范化 / 迁移 (纯函数, 不读盘)
// ============================================================

const VALID_PROTOCOLS: ProviderProtocol[] = ['openai-compatible', 'anthropic', 'gemini', 'ollama'];

/**
 * 从 base URL 的**主机名**推协议 (真判定, 不是白名单)。
 *
 * 用途只有一个: 迁移**旧配置**里那种"只有 baseUrl + model, 没说协议"的自定义端。
 * 判不出来时退到 `openai-compatible` —— 这是绝大多数自建/兼容网关的协议, 且调用方能在
 * `notes` 里看到"协议是推出来的", 不是用户声明的。
 */
export function inferProtocolFromBaseUrl(raw: string): ProviderProtocol {
  const url = normalizeBaseUrl(raw);
  if (!url) return 'openai-compatible';
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return 'openai-compatible';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local')) {
    // 本地端点: 11434 是 ollama 的招牌端口, 其余按兼容网关算
    return /:11434$/.test(url) ? 'ollama' : 'openai-compatible';
  }
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (path.includes('/api/paas/')) return 'openai-compatible';   // 智谱那种 path 后缀不改协议
  return 'openai-compatible';
}

/** 是不是合法的自定义供应商 id (不许与内置撞名, 不许空/带斜杠) */
export function isValidCustomProviderId(id: string): boolean {
  const v = String(id || '').trim();
  if (!v) return false;
  if (isBuiltinProvider(v)) return false;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(v);
}

/**
 * 规范化**一条**自定义供应商声明 (纯函数)。
 *
 * 老形状 (`providerId` / `name` / `url` / `api_key` 之类的别名) 一律在这里收成规范形, 缺必填项
 * 就**明确拒绝**并把缺哪一项说出来 —— 不静默补默认值。
 */
export function normalizeCustomProvider(raw: unknown): { ok: true; value: CustomProviderConfig } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是对象' };
  const r = raw as Record<string, any>;
  const id = String(r.providerId ?? r.id ?? '').trim();
  if (!id) return { ok: false, reason: '缺 providerId' };
  if (!isValidCustomProviderId(id)) {
    return { ok: false, reason: isBuiltinProvider(id) ? `providerId 与内置供应商撞名: ${id}` : `providerId 形状非法: ${id}` };
  }
  const rawUrl = String(r.baseUrl ?? r.base_url ?? r.url ?? '').trim();
  if (!rawUrl) return { ok: false, reason: '缺 baseUrl' };
  const baseUrl = normalizeBaseUrl(rawUrl);
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `baseUrl 只支持 http/https, 收到 ${u.protocol}` };
    if (!u.hostname) return { ok: false, reason: 'baseUrl 缺主机名' };
  } catch {
    return { ok: false, reason: `baseUrl 不是合法 URL: ${rawUrl}` };
  }
  const declaredProtocol = String(r.protocol ?? '').trim() as ProviderProtocol;
  const protocol: ProviderProtocol = (VALID_PROTOCOLS as string[]).includes(declaredProtocol)
    ? declaredProtocol
    // 迁移路径: 老配置没说协议 → 按 base URL 主机名推 (调用方能看到这属于"推出来的")
    : r.protocol ? ('openai-compatible' as ProviderProtocol) : inferProtocolFromBaseUrl(baseUrl);
  if (r.protocol && !(VALID_PROTOCOLS as string[]).includes(declaredProtocol)) {
    return { ok: false, reason: `protocol 不合法: ${String(r.protocol)} (只能是 ${VALID_PROTOCOLS.join('/')})` };
  }
  const value: CustomProviderConfig = {
    providerId: id,
    displayName: String(r.displayName ?? r.name ?? id).trim() || id,
    baseUrl,
    protocol,
  };
  const apiKey = r.apiKey ?? r.api_key;
  if (typeof apiKey === 'string' && apiKey.trim()) value.apiKey = apiKey.trim();
  const model = String(r.model ?? '').trim();
  if (model) value.model = model;
  const modelsEndpoint = String(r.modelsEndpoint ?? r.models_endpoint ?? '').trim();
  if (modelsEndpoint) value.modelsEndpoint = modelsEndpoint;
  const authHeader = String(r.authHeader ?? r.auth_header ?? '').trim();
  if (authHeader) value.authHeader = authHeader;
  const apiKeyEnvVar = String(r.apiKeyEnvVar ?? r.api_key_env ?? '').trim();
  if (apiKeyEnvVar) value.apiKeyEnvVar = apiKeyEnvVar;
  const models = Array.isArray(r.models) ? r.models.filter((m: any) => typeof m === 'string' && m.trim()) : [];
  if (models.length) value.models = [...models];
  const cap = r.capabilities;
  if (cap && typeof cap === 'object') {
    const out: CustomProviderCapabilities = {};
    if (cap.toolCalling === 'yes' || cap.toolCalling === 'no' || cap.toolCalling === 'unknown') out.toolCalling = cap.toolCalling;
    if (cap.reasoning === 'yes' || cap.reasoning === 'no' || cap.reasoning === 'unknown') out.reasoning = cap.reasoning;
    if (typeof cap.contextLength === 'number' && Number.isFinite(cap.contextLength) && cap.contextLength > 0) out.contextLength = cap.contextLength;
    if (Object.keys(out).length) value.capabilities = out;
  }
  if (typeof r.updatedAt === 'string' && r.updatedAt.trim()) value.updatedAt = r.updatedAt.trim();
  return { ok: true, value };
}

/**
 * 规范化 `config.customProviders` 这一格 (纯函数, **不写盘**)。
 *
 * 支持三种形态, 都是"用户现在真可能有的":
 *   1. 缺省 / `null` → `{}` (旧配置一个字都没写 —— 这是绝大多数旧配置);
 *   2. **map 形** `{ my-gw: {...} }` → 逐条规范化, 坏的**留名**不静默丢;
 *   3. **数组形** `[ {...} ]` (早期形态) → 按 `providerId` 收成 map。
 *
 * 返回值带 `rejected`: 被拒绝的条目与原因 (调用方要如实报出来, 不许"读一读就少了两家")。
 */
export function normalizeCustomProviders(raw: unknown): {
  providers: Record<string, CustomProviderConfig>;
  rejected: Array<{ key: string; reason: string }>;
} {
  const providers: Record<string, CustomProviderConfig> = {};
  const rejected: Array<{ key: string; reason: string }> = [];
  if (raw === undefined || raw === null) return { providers, rejected };
  if (typeof raw !== 'object') {
    // 形状本身就不对 → 留名 + 理由 (不静默当空表: 用户会看到"我写的那一格没生效")
    rejected.push({ key: 'customProviders', reason: `形状不是对象/数组 (收到 ${typeof raw}) → 这一格被忽略` });
    return { providers, rejected };
  }
  const items: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((item, i) => [String((item as any)?.providerId ?? (item as any)?.id ?? `#${i}`), item])
    : Object.entries(raw as Record<string, unknown>);
  for (const [key, item] of items) {
    const r = normalizeCustomProvider(item);
    if (r.ok) providers[r.value.providerId] = r.value;
    else rejected.push({ key, reason: r.reason });
  }
  return { providers, rejected };
}

/** 从 `providers.<未知 id>` 吸收来的条目 (旧版本写法) */
export interface AbsorbedLegacyProvider {
  providerId: string;
  /** 协议是**推**出来的 (base URL 主机名), 不是用户声明的 */
  protocol: ProviderProtocol;
  inferredProtocol: boolean;
}

/**
 * 旧版本把自定义端点直接写进 `providers.<id>` (那一格没有 `customProviders`) → **吸收**成自定义供应商。
 *
 * 规矩:
 *   - 只吸收**不在内置表**、且 `baseUrl` 非空的键 (没有地址的键不是一个能用的端点, 不猜);
 *   - 协议按 base URL 主机名推 (`inferProtocolFromBaseUrl`), 并**如实标** `inferredProtocol=true`;
 *   - `known` 里已有的**不覆盖** (显式声明优先于推出来的)。
 *
 * 纯函数: `config-store.initialize()` 与 `custom-provider-store` 共用同一个实现 (不许两处各写一份)。
 */
export function absorbLegacyProviderEntries(
  providerMap: Record<string, unknown> | undefined | null,
  known: Record<string, CustomProviderConfig>,
): { providers: Record<string, CustomProviderConfig>; absorbed: AbsorbedLegacyProvider[] } {
  const providers: Record<string, CustomProviderConfig> = { ...known };
  const absorbed: AbsorbedLegacyProvider[] = [];
  for (const [id, rawCfg] of Object.entries(providerMap || {})) {
    if (!rawCfg || typeof rawCfg !== 'object') continue;
    if (isBuiltinProvider(id) || providers[id]) continue;
    if (!isValidCustomProviderId(id)) continue;
    const cfg = rawCfg as Record<string, unknown>;
    const baseUrl = String(cfg.baseUrl || '').trim();
    if (!baseUrl) continue;
    const protocol = inferProtocolFromBaseUrl(baseUrl);
    const value: CustomProviderConfig = {
      providerId: id,
      displayName: String(cfg.displayName || id),
      baseUrl,
      protocol,
    };
    const model = String(cfg.model || '').trim();
    if (model) value.model = model;
    const apiKey = String(cfg.apiKey || '').trim();
    if (apiKey) value.apiKey = apiKey;
    providers[id] = value;
    absorbed.push({ providerId: id, protocol, inferredProtocol: true });
  }
  return { providers, absorbed };
}

// ============================================================
// 元数据填充点 (P2 冻结接口的**唯一填充方式**)
// ============================================================

export const PROVIDER_REGISTRY_SOURCE_ID = 'provider-registry';

/** 一家登记在册的模型 ID 清单 (自定义=声明, 内置=内置目录; 都没有 → 空数组) */
function declaredModelIdsOf(provider: string): string[] {
  const spec = customSnapshot[provider];
  if (spec) return Array.isArray(spec.models) ? spec.models.filter((m) => typeof m === 'string' && m) : [];
  const info = (PROVIDER_INFO as Record<string, { models?: string[] }>)[provider];
  return Array.isArray(info?.models) ? info.models.filter((m) => typeof m === 'string' && m) : [];
}

/**
 * 注册表的元数据填充点。
 *
 * 只回答自己有真值的项; 其余项**不出现**在该键上 (= 保持 `unknown`)。逐条理由见文件头。
 */
export function providerRegistryMetadataSource(): ModelMetadataSource {
  return {
    id: PROVIDER_REGISTRY_SOURCE_ID,
    metadataOf: ({ provider, model }: { provider: string; model: string }): ModelCapabilityFacts | undefined => {
      const entry = getProviderRegistryEntry(provider);
      if (!entry) return undefined;
      const facts: ModelCapabilityFacts = { requiresApiKey: entry.requiresApiKey };
      if (entry.kind === 'custom') {
        const spec = customSnapshot[provider];
        const ids = declaredModelIdsOf(provider);
        if (ids.length) facts.origin = 'custom';
        const isDeclared = ids.includes(model);
        const cap = spec?.capabilities || {};
        // 只有**用户在声明里写过的**能力才填; 没写就是不出现 (保持 unknown)
        if (isDeclared || !ids.length) {
          if (cap.toolCalling) facts.toolCalling = cap.toolCalling;
          if (cap.reasoning) facts.reasoning = cap.reasoning;
          if (typeof cap.contextLength === 'number') facts.contextLength = cap.contextLength;
        }
      }
      return facts;
    },
  };
}

/**
 * 把注册表的填充点接上 (幂等; 同 id 再注册 = 原地替换, 优先级不变)。
 *
 * 显式版: 无条件注册 (测试里 `resetModelMetadataSources()` 之后要靠它接回去)。
 */
export function registerProviderRegistryMetadataSource(): void {
  registerModelMetadataSource(providerRegistryMetadataSource());
  metadataSourceWired = true;
}

/**
 * 自动接线 (幂等, 只做一次)。
 *
 * **为什么不放在模块体里**: 本模块与 `config-store` / `model-catalog` 之间是**循环 import**,
 * 而模块体的执行时机取决于"谁是入口"—— 实测 `model-catalog` 先被别的入口拉起来时, 模块体里
 * 调 `registerModelMetadataSource()` 会撞上对方模块还没初始化完 (`metadataSources` 的 TDZ) →
 * 整个进程起不来。所以改在**调用时**接线: 任何一次注册表读、任何一次配置读 (`config-store.initialize()`)
 * 都会顺手接上, 于是"真的接线了"依然是可核事实, 但不依赖 import 顺序。
 *
 * 只接一次也意味着: 测试里显式 `resetModelMetadataSources()` 之后它**不会**被偷偷加回来。
 */
export function ensureProviderRegistryMetadataSource(): void {
  if (metadataSourceWired) return;
  registerProviderRegistryMetadataSource();
}

let metadataSourceWired = false;
