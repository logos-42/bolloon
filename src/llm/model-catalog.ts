/**
 * model-catalog.ts — 模型目录与「模型元数据」的读写口 (2026-09-26)
 *
 * ## 这一层解决什么
 *
 * 选择器要显示模型的**能力**, 用户才知道为什么某个模型不能用来做工具调用。但在当前的
 * 内置数据里, 每个供应商只有一张**模型 ID 清单** (`PROVIDER_INFO[provider].models`),
 * 没有任何能力数据: 没有 tool_calls、没有 reasoning、没有上下文长度。真实的能力数据
 * 只能来自两处, 而这两处**现在都还没接**:
 *
 *   ① 供应商注册表 (每个供应商的协议/鉴权/默认 URL/是否本地/是否允许当长期执行器)
 *   ② 模型发现 (`GET /models` 实时目录 + 缓存 + 手工自定义)
 *
 * 所以本层的纪律是: **有真来源的字段给真值, 没有真来源的字段一律 `'unknown'` (或 `null`),
 * 并把"为什么不知道"记在 `ModelEntry.unknowns` 里由界面直接显示** —— 绝不允许在下游渲染层
 * 写一个"看起来像真的"的常量。渲染层只做三态到人话的翻译 (`capabilityZh` / `contextZh`),
 * 一个能力值都不许在那里产生。
 *
 * ## 元数据填充点 (唯一)
 *
 * 外部数据一律通过 `ModelMetadataSource` 注入 (`registerModelMetadataSource`), 不通过
 * 改本文件的常量、也不通过改渲染层。填充者只回答"这一项你知道什么":
 * 返回 `undefined` 表示**这一项没有数据**, 该字段就保持 `unknown`。
 * 这样 P3/P5 填真数据时不会出现"两处真相"。
 *
 * `requiresApiKey` / `credentialReady` / `isLocal` **不走填充点**, 它们是本层能**当场算出真值**的字段:
 * 前者来自内置注册表 (`PROVIDER_INFO`), 中间那个来自"配置里的 key / 环境变量现在有没有",
 * 后者来自 base URL 的主机名判定。
 * 配置里那格 `ProviderConfig.requiresApiKey` 是**另一个事实** (= "别再问我了"), 单独放在
 * `ProviderSummary.configRequiresKey`, 与注册表说法不一致时用 `requiresKeyConflict` 如实标出 ——
 * 不许在渲染层挑一个装作不知道 (那就是两处真相里随机的一半)。
 */

import {
  llmConfigStore,
  DEFAULT_PROVIDER_CONFIGS,
  PROVIDER_INFO,
  type ModelProvider,
  type ProviderConfig,
} from './config-store.js';
import {
  protocolOf, supportsReasoning, envKeyNamesOf, envApiKeyOf,
  effectiveModelConfig, normalizeBaseUrl,
  type ModelProtocol,
} from './model-selection.js';

// ============================================================
// 类型 —— 冻结形状 (P3 供应商注册表 / P5 模型发现 只准填, 不准改)
// ============================================================

/** 能力三态。**没有真来源必须是 `unknown`** —— 不许用 `false` 冒充"不支持" */
export type Capability = 'yes' | 'no' | 'unknown';

/** 目录里这一条的来源标记 */
export type CatalogOrigin = 'curated' | 'live' | 'cached' | 'custom' | 'unavailable';

/** 连接状态 (`unknown` = 本轮没有探测过, 不许写 `ok`) */
export type Reachability = 'ok' | 'failed' | 'unknown';

/** 允许为 `unknown` 的字段 (其余字段一律有真值) */
export const UNKNOWN_TOLERANT_FIELDS = ['toolCalling', 'reasoning', 'contextLength'] as const;
export type UnknownTolerantField = (typeof UNKNOWN_TOLERANT_FIELDS)[number];

/** 逐字段的"为什么不知道" —— 界面直接显示, 不再是注释里的一句 */
export interface UnknownNote {
  field: UnknownTolerantField;
  reason: string;
}

/** 一个模型条目 (选择器与 `/model list` 都读这一个形状) */
export interface ModelEntry {
  /** provider 原始 model ID, **逐字保留**: 不改大小写、不截断、不加前缀 */
  id: string;
  provider: string;
  /** 展示名。没有单独来源时 == id (不编一个好听的名字) */
  displayName: string;
  toolCalling: Capability;
  reasoning: Capability;
  /** 上下文窗口 (token)。`null` = 未知 */
  contextLength: number | null;
  /**
   * **注册表**说这个供应商是否需要 key (真来源: 内置注册表)。
   * 注意它与"配置里那一格"不是一回事: 切换路径会在配好凭证后把配置里的 `requiresApiKey` 写成
   * false (= 别再问我了), 那是"问过了", 不是"这家不用 key"。
   */
  requiresApiKey: boolean;
  /** 现在**手上真的有**可用凭证 (配置里的 key / 环境变量), 或这家本来就不需要 key */
  credentialReady: boolean;
  /** 是否本地端点 (真来源: base URL 主机名) */
  isLocal: boolean;
  origin: CatalogOrigin;
  reachability: Reachability;
  /** `reachability === 'failed'` 时必有: 连接失败原因 */
  failureReason?: string;
  /** 能力未知的原因 (逐字段), 空数组 = 这一条的能力都有真数据 */
  unknowns: UnknownNote[];
  /** 这一条就是当前生效的 provider+model */
  current: boolean;
}

/** 供应商级汇总 (选择器第一步与 `/model status` 的列表行) */
export interface ProviderSummary {
  id: string;
  name: string;
  protocol: ModelProtocol;
  /** ● 可用 (有凭证或注册表说不需要 key) / ○ 未配置 */
  configured: boolean;
  /** 注册表说这家需不需要 key (列表与选择器用它判"未配置 key") */
  requiresApiKey: boolean;
  /** 配置里那一格的值 (切换路径写过一次 false = 别再问我了) */
  configRequiresKey: boolean;
  /**
   * 两处对"是否需要 key"的说法不一致 —— 这是**真事实**, 如实标出来由界面提示,
   * 不挑一个装作不知道 (否则用户看到的列表就是"两处真相"里随机的一半)。
   */
  requiresKeyConflict: boolean;
  isLocal: boolean;
  /** 目录里这一家有几种模型 */
  modelCount: number;
  /** 这个数字从哪来 (`unavailable` = 没有目录, 所以 0 不是"真的没有模型") */
  modelCountOrigin: CatalogOrigin;
  /** 配置里**这一家**当前写的 model (不是"有效配置") */
  configuredModel: string;
  baseUrl: string;
  /** 凭证状态 */
  keyState: 'configured' | 'env' | 'missing' | 'not_required';
  /** 该供应商的 model 就是当前生效的那个 */
  current: boolean;
  /** 该供应商就是当前生效的那家 */
  active: boolean;
  /**
   * **供应商级** reasoning 能力 (来源: 内置供应商表)。
   * 注意它**不是**模型级数据 —— 模型级的 `ModelEntry.reasoning` 只有真目录能给。
   */
  providerReasoning: Capability;
  reachability: Reachability;
  failureReason?: string;
}

/**
 * 元数据填充点的输入: 填充者按能力项返回它**知道**的东西。
 * 未出现的键 = 这一项没数据 (保持 `unknown` / `null`)。
 */
export interface ModelCapabilityFacts {
  displayName?: string;
  toolCalling?: Capability;
  reasoning?: Capability;
  contextLength?: number;
  origin?: CatalogOrigin;
  requiresApiKey?: boolean;
}

/**
 * **元数据填充点接口 (冻结)**。P3(供应商注册表)/P5(模型发现) 各实现一个并
 * `registerModelMetadataSource()` 注册; 不许在渲染层或本文件的静态表里塞临时常量。
 *
 * 约定:
 *   - `metadataOf()` 返回 `undefined` 或缺少某键 → 该字段保持 `unknown` (不许由填充者
 *     顺手填一个默认值, 也不许由本层补默认值);
 *   - `providers` 省略 = 对所有供应商生效; 多个填充点对同一字段都给值 → **先注册的赢**;
 *   - 填充点必须是**纯同步**的: 数据要么已经在手 (目录/缓存), 要么就没有 (`undefined`),
 *     不许在这里发网络请求拖慢选择器。
 */
export interface ModelMetadataSource {
  /** 填充点自身的名字 (排障用, 例如 'provider-registry' / 'live-discovery' / 'catalog-cache') */
  id: string;
  /** 只对哪些 provider 生效 (省略 = 全部) */
  providers?: string[];
  metadataOf(ctx: { provider: string; model: string }): ModelCapabilityFacts | undefined;
}

// ============================================================
// 填充点注册表
// ============================================================

const metadataSources: ModelMetadataSource[] = [];

/**
 * 注册一个元数据填充点。
 *
 * 优先级 = **注册顺序** (先注册的赢); 同一个 `id` 再注册 = **原地替换, 优先级不变**
 * (不是挪到队尾 —— 否则"后注册的就悄悄抢走了优先级", 与本文档说法矛盾)。
 */
export function registerModelMetadataSource(src: ModelMetadataSource): void {
  const i = metadataSources.findIndex((s) => s.id === src.id);
  if (i >= 0) metadataSources.splice(i, 1, src);
  else metadataSources.push(src);
}

/** 已注册的填充点名 (顺序 = 生效优先级) */
export function listModelMetadataSources(): string[] {
  return metadataSources.map((s) => s.id);
}

/** 清空填充点 (测试用; 生产路径不调用) */
export function resetModelMetadataSources(): void {
  metadataSources.length = 0;
}

function factsOf(provider: string, model: string): ModelCapabilityFacts {
  const out: ModelCapabilityFacts = {};
  for (const src of metadataSources) {
    if (src.providers && !src.providers.includes(provider)) continue;
    let facts: ModelCapabilityFacts | undefined;
    try { facts = src.metadataOf({ provider, model }); } catch { facts = undefined; }
    if (!facts) continue;
    for (const k of Object.keys(facts) as (keyof ModelCapabilityFacts)[]) {
      if (out[k] === undefined && facts[k] !== undefined) (out as any)[k] = facts[k];
    }
  }
  return out;
}

// ============================================================
// 判定真值的小工具 (这些字段不需要填充点)
// ============================================================

/** 本地端点 = 主机名是环回地址 (真判定, 不是供应商白名单) */
export function isLocalBaseUrl(raw: string): boolean {
  const url = normalizeBaseUrl(raw);
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local');
  } catch {
    return false;
  }
}

/** 该供应商登记在册的模型 ID 清单 (内置目录; 没有清单 → 空数组) */
export function curatedModelIds(provider: string): string[] {
  const info = (PROVIDER_INFO as any)[provider];
  const list = Array.isArray(info?.models) ? info.models : [];
  return list.filter((m: any) => typeof m === 'string' && m);
}

/** 内置目录给不给得出这一家的清单 —— 拿不到时界面必须说"无内置目录", 不是"0 个模型" */
export function curatedOriginOf(provider: string): CatalogOrigin {
  return curatedModelIds(provider).length ? 'curated' : 'unavailable';
}

/** 三态 → 中文 (渲染层只翻译, 不产生值) */
export function capabilityZh(c: Capability): string {
  return c === 'yes' ? '支持' : c === 'no' ? '不支持' : '未知';
}

/** 上下文长度 → 人话 (`null` = 未知) */
export function contextZh(n: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '未知';
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// ============================================================
// 条目构造
// ============================================================

/** 内置目录为什么给不出能力数据 —— 逐字段一句人话 (真出处: 目录里只有 ID) */
export const CURATED_ONLY_REASON =
  '内置目录只有模型 ID, 没有能力字段 (供应商目录/注册表未接)';

export interface BuildEntryContext {
  provider: string;
  /** 该 provider 是否需要 key (真来源: 内置注册表) */
  requiresApiKey: boolean;
  /** 现在手上真的有可用凭证 (配置里的 key / 环境变量) */
  credentialReady: boolean;
  /** 该 provider 的 base URL (真来源, 用于本地判定) */
  baseUrl: string;
  /** 当前生效的 provider + model */
  currentProvider?: string;
  currentModel?: string;
  reachability?: Reachability;
  failureReason?: string;
}

export function buildModelEntry(model: string, ctx: BuildEntryContext): ModelEntry {
  const facts = factsOf(ctx.provider, model);
  const origin = facts.origin || curatedOriginOf(ctx.provider);
  const unknowns: UnknownNote[] = [];
  const toolCalling = facts.toolCalling ?? 'unknown';
  const reasoning = facts.reasoning ?? 'unknown';
  const contextLength = typeof facts.contextLength === 'number' ? facts.contextLength : null;
  if (toolCalling === 'unknown') unknowns.push({ field: 'toolCalling', reason: CURATED_ONLY_REASON });
  if (reasoning === 'unknown') unknowns.push({ field: 'reasoning', reason: CURATED_ONLY_REASON });
  if (contextLength === null) unknowns.push({ field: 'contextLength', reason: CURATED_ONLY_REASON });
  // 注册表是"这家要不要 key"的主来源; 填充点只在**知道得更准**时覆盖它
  const requiresApiKey = facts.requiresApiKey ?? ctx.requiresApiKey;

  return {
    id: model,
    provider: ctx.provider,
    displayName: facts.displayName || model,
    toolCalling,
    reasoning,
    contextLength,
    requiresApiKey,
    credentialReady: !requiresApiKey || ctx.credentialReady,
    isLocal: isLocalBaseUrl(ctx.baseUrl),
    origin,
    reachability: ctx.reachability || 'unknown',
    ...(ctx.failureReason ? { failureReason: ctx.failureReason } : {}),
    unknowns,
    current: ctx.currentProvider === ctx.provider && ctx.currentModel === model,
  };
}

// ============================================================
// 目录读取
// ============================================================

async function providerConfigMap(): Promise<Record<string, ProviderConfig>> {
  await llmConfigStore.initialize();
  const cfg = await llmConfigStore.getConfig();
  return (cfg.providers || {}) as unknown as Record<string, ProviderConfig>;
}

function keyStateOf(cfg: ProviderConfig | undefined, provider: string): ProviderSummary['keyState'] {
  if (cfg?.apiKey) return 'configured';
  if (envApiKeyOf(provider)) return 'env';
  if (cfg?.requiresApiKey === false) return 'not_required';
  return 'missing';
}

/**
 * 该供应商**现在能用**的凭证 (真来源: 配置里的 key → 环境变量)。
 *
 * 用途: 选择器第 6 步的预检必须用**和真正落盘时同一份凭证**去探, 否则"已经配好 key 的供应商"
 * 在预检里会被上游按未鉴权打回 (401), 用户看到一句假的"探测失败"。
 * 返回值只用于当次请求头, 不进任何打印/快照 (渲染层只回显尾 4 位)。
 */
export async function resolvedApiKeyOf(provider: string): Promise<string | undefined> {
  const providers = await providerConfigMap();
  const own = providers[provider]?.apiKey;
  if (own) return own;
  return envApiKeyOf(provider)?.value;
}

/** 供应商列表 (按内置推荐顺序给出; 顺序不参与任何判定) */
export async function buildProviderSummaries(opts: {
  /** 已探过的连通性结论 (provider → 结论); 没探过就是 unknown */
  probes?: Record<string, { ok: boolean; detail?: string }>;
  sessionKey?: string;
} = {}): Promise<ProviderSummary[]> {
  const providers = await providerConfigMap();
  const eff = await effectiveModelConfig({ sessionKey: opts.sessionKey }).catch(() => null);
  const out: ProviderSummary[] = [];

  for (const id of Object.keys(DEFAULT_PROVIDER_CONFIGS)) {
    const def = DEFAULT_PROVIDER_CONFIGS[id as ModelProvider];
    const cfg = providers[id];
    const baseUrl = normalizeBaseUrl(cfg?.baseUrl || def.baseUrl);
    // 注册表 (PROVIDER_INFO) 是"这家要不要 key"的主来源; config 里那格是"问过没有"
    const registryRequires = ((PROVIDER_INFO as any)[id]?.requiresApiKey ?? def.requiresApiKey) !== false;
    const configRequires = cfg?.requiresApiKey !== false;
    const requiresApiKey = registryRequires;
    const keyState = keyStateOf(cfg, id);
    const credentialReady = keyState === 'configured' || keyState === 'env' || !registryRequires;
    const ids = curatedModelIds(id);
    const probe = opts.probes?.[id];
    out.push({
      id,
      name: (PROVIDER_INFO as any)[id]?.name || id,
      protocol: protocolOf(id),
      configured: credentialReady,
      requiresApiKey,
      configRequiresKey: configRequires,
      requiresKeyConflict: configRequires !== registryRequires,
      isLocal: isLocalBaseUrl(baseUrl),
      modelCount: ids.length,
      modelCountOrigin: curatedOriginOf(id),
      configuredModel: String(cfg?.model || ''),
      baseUrl,
      keyState,
      current: !!eff && eff.provider === id,
      active: !!eff && eff.provider === id,
      providerReasoning: supportsReasoning(id) ? 'yes' : 'unknown',
      reachability: probe ? (probe.ok ? 'ok' : 'failed') : 'unknown',
      ...(probe && !probe.ok && probe.detail ? { failureReason: probe.detail } : {}),
    });
  }
  return out;
}

/**
 * 一家供应商的模型条目。
 * 当前生效的那一条**置顶** (不在内置清单里也要出现 —— 用户配了自定义 model 时必须看得到它)。
 */
export async function listModelsFor(providerId: string, opts: {
  sessionKey?: string;
  /** 额外候选 (手工自定义 model), 追加在内置清单之后并去重 */
  extra?: string[];
  probe?: { ok: boolean; detail?: string };
} = {}): Promise<ModelEntry[]> {
  const providers = await providerConfigMap();
  const def = DEFAULT_PROVIDER_CONFIGS[providerId as ModelProvider];
  if (!def) return [];
  const cfg = providers[providerId];
  const eff = await effectiveModelConfig({ sessionKey: opts.sessionKey }).catch(() => null);
  const registryRequires = ((PROVIDER_INFO as any)[providerId]?.requiresApiKey ?? def.requiresApiKey) !== false;
  const ctx: BuildEntryContext = {
    provider: providerId,
    requiresApiKey: registryRequires,
    credentialReady: keyStateOf(cfg, providerId) === 'configured' || keyStateOf(cfg, providerId) === 'env',
    baseUrl: normalizeBaseUrl(cfg?.baseUrl || def.baseUrl),
    currentProvider: eff?.provider,
    currentModel: eff?.model,
    reachability: opts.probe ? (opts.probe.ok ? 'ok' : 'failed') : 'unknown',
    failureReason: opts.probe && !opts.probe.ok ? opts.probe.detail : undefined,
  };

  const seen = new Set<string>();
  const order: string[] = [];
  // 配置里写着的 model 与当前生效的 model 都必须出现在清单里 (可能不在内置目录中)
  for (const extra of [eff?.provider === providerId ? eff.model : '', cfg?.model || '', ...(opts.extra || [])]) {
    const m = String(extra || '').trim();
    if (m && !seen.has(m)) { seen.add(m); order.push(m); }
  }
  for (const m of curatedModelIds(providerId)) {
    if (!seen.has(m)) { seen.add(m); order.push(m); }
  }

  const entries = order.map((m) => buildModelEntry(m, ctx));
  // 当前生效的置顶 (稳定: 其余保持原顺序)
  const cur = entries.filter((e) => e.current);
  const rest = entries.filter((e) => !e.current);
  return [...cur, ...rest];
}

// ============================================================
// 模糊搜索 (纯函数)
// ============================================================

/**
 * 模糊匹配打分 (纯函数)。`null` = 不匹配。
 *
 * 规则刻意简单可解释: 全部字符按顺序出现在目标里就算匹配 (子序列),
 * 连续命中给更高分; 完整子串命中直接给高权重。大小写不敏感, 空格与 `-`/`_`/`.` 视为同级分隔符。
 */
export function fuzzyScore(haystack: string, needle: string): number | null {
  const h = String(haystack || '').toLowerCase();
  const raw = String(needle || '').trim().toLowerCase();
  if (!raw) return 0;
  if (h.includes(raw)) return 1000 - h.indexOf(raw);
  const n = raw.replace(/[\s]+/g, '');
  const target = h.replace(/[\s]+/g, '');
  let i = 0, score = 0, streak = 0;
  for (const ch of target) {
    if (ch === n[i]) { i++; streak++; score += 1 + streak; }
    else streak = 0;
    if (i >= n.length) break;
  }
  return i >= n.length ? score : null;
}

/** 按模糊分排序 (平分保持原顺序); `query` 为空 = 原样返回 */
export function searchModelEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const q = String(query || '').trim();
  if (!q) return entries;
  const scored: Array<{ e: ModelEntry; s: number; i: number }> = [];
  entries.forEach((e, i) => {
    const a = fuzzyScore(e.id, q);
    const b = fuzzyScore(e.displayName, q);
    const s = a === null && b === null ? null : Math.max(a ?? -1, b ?? -1);
    if (s !== null) scored.push({ e, s, i });
  });
  scored.sort((x, y) => (y.s - x.s) || (x.i - y.i));
  return scored.map((x) => x.e);
}

// ============================================================
// 展示
// ============================================================

/** 供应商列表行: `● <供应商> · N models` / `○ <供应商> · N models · 未配置 key` / `● <供应商> · 本地` */
export function formatProviderLine(s: ProviderSummary): string {
  const mark = s.configured ? '●' : '○';
  const bits: string[] = [];
  if (s.isLocal) bits.push('本地');
  bits.push(s.modelCountOrigin === 'unavailable' ? '无内置目录' : `${s.modelCount} models`);
  if (!s.configured && s.requiresApiKey) bits.push(`未配置 key (${envKeyNamesOf(s.id).join('/') || '环境变量'})`);
  if (s.current) bits.push('← 当前');
  // 两处说法不一致就如实标 (不挑一个装作不知道)
  if (s.requiresKeyConflict) bits.push(`⚠ key 要求不一致 (注册表说${s.requiresApiKey ? '要' : '不要'} / 配置里说${s.configRequiresKey ? '要' : '不要'})`);
  return `${mark} ${s.id} · ${bits.join(' · ')}`;
}

/** 模型条目行: 当前置顶标记 + 原始 ID + 能力三态 + 凭证状态 + 本地/远端 + 失败原因 */
export function formatModelLine(e: ModelEntry): string {
  // 凭证一栏由两个**真事实**合成: 注册表(这家要不要 key) + 手上现在有没有
  const cred = !e.requiresApiKey ? '免 key' : (e.credentialReady ? 'key 已配' : '缺 key');
  const bits = [
    `工具调用=${capabilityZh(e.toolCalling)}`,
    `reasoning=${capabilityZh(e.reasoning)}`,
    `上下文=${contextZh(e.contextLength)}`,
    cred,
    e.isLocal ? '本地端点' : '远端端点',
  ];
  let line = `${e.current ? '▸' : ' '} ${e.id.padEnd(36)} ${bits.join(' · ')}`;
  if (e.reachability === 'failed') line += ` · ⚠ 连接失败: ${String(e.failureReason || '原因未明').slice(0, 80)}`;
  return line;
}

/** 能力未知的说明 (列表脚注, 只打不重复的原因) */
export function unknownFootnote(entries: ModelEntry[]): string[] {
  const reasons = new Set<string>();
  for (const e of entries) for (const u of e.unknowns) reasons.add(u.reason);
  if (!reasons.size) return [];
  return [...reasons].map((r) => `未知原因: ${r}`);
}
