/**
 * model-selection.ts — 「有效模型配置」的唯一入口 (2026-09-26)
 *
 * ## 修的是什么
 *
 * 此前切换模型有三条各走各的路 (CLI `/model`、Web `/api/llm-config` + `/api/llm-provider`、
 * 初始化向导), 每条路都只做其中一部分: CLI 那条只改配置文件、**不重建模型运行时** ——
 * 于是出现"配置文件已经改了, 内存里的实例还是旧的"这种半成功状态: 用户以为切了, 下一次
 * 请求还是打到旧供应商。Web 那条重建了运行时, 但不支持切 API URL, 也不记录"这次切换属于
 * 哪个作用域"。
 *
 * 这里把七步收敛成**一个函数** (`selectModel`), CLI / Web / 向导 / 工具调用都只能调它:
 *
 * ```
 * validateSelection → 轻量连通探测 → 写配置 → 更新 active scope → 重建模型运行时
 *                   → 更新当前 session → 返回 effective config
 * ```
 *
 * 三条硬规则 (写在实现里, 不是文档里):
 *   ① **进行中的 HTTP 请求继续用旧配置** —— 运行时实例在构造时就把 provider/model/baseUrl
 *      固化下来 (`PiAIModel` 的 `this.config`), 重建只是换掉单例引用; 已经在飞的那次请求
 *      握着自己的旧实例, 不会中途改口径。
 *   ② **下一次模型调用必须用新配置** —— 调用点每次都 `getMinimax()` 现取单例, 不做本地缓存。
 *   ③ **切换失败时配置与运行时都保持原样** —— 校验与探测都在**写盘之前**; 写盘之后任何一步
 *      出错 (含运行时重建抛错) 都会把配置文件字节级还原成切换前的样子, 并用旧配置重新初始化
 *      运行时, 然后如实返回失败。没有"文件已改但实例仍旧"的中间态。
 *
 * ## 「有效模型配置」
 *
 * 不能只存 `activeProvider + providers[provider].model`。一次解析要同时说清
 * `provider · model · baseUrl · protocol · authRef · reasoning · scope · source · updatedAt`,
 * 并按**固定优先级**从五层里挑:
 *
 * ```
 * Run/Goal 显式绑定 > 当前 Session 绑定 > 用户 Global 默认 > provider 默认 > 环境变量
 * ```
 *
 * 纯函数 `resolveSelection()` 负责这条优先级 (可单测, 不碰磁盘); `effectiveModelConfig()`
 * 负责从磁盘/环境把五层读出来喂给它。
 *
 * `authRef` **只记凭证来源的引用名** (如 `provider:deepseek` / `env:DEEPSEEK_API_KEY` / `none`),
 * 永远不记 key 本身 —— 有效配置是要被打印、被写进 Run 记录的。
 */

import * as fsSync from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  llmConfigStore,
  DEFAULT_PROVIDER_CONFIGS,
  PROVIDER_INFO,
  type ModelProvider,
  type ProviderConfig,
} from './config-store.js';
import { initMinimax } from '../constraints/index.js';
import {
  probe,
  PROBE_FAILURE_CLASSES,
  PROBE_FAILURE_ZH,
  type ProbeFailureClass,
  type ProbeCheck,
} from './connection-probe.js';
// 2026-09-26 (P6): 入口现在按**注册表**校验供应商 —— 于是自定义供应商 (不改 TS 联合类型) 也能
//   被切成全局默认。方向是 `model-selection → provider-registry` (与 `config-store → provider-registry`
//   同一条边, 不是新方向的循环): 注册表自己把内置表派生过来, 所以**内置的行为一字不变**
//   (`entry.protocol === protocolOf(id)` / `entry.apiKeyEnvVars === envKeyNamesOf(id)` 由注册表门禁钉住)。
import { getProviderRegistryEntry, listProviderRegistry } from './provider-registry.js';

// ============================================================
// 类型
// ============================================================

/** 解析优先级 (固定顺序, 不允许调用方打乱) */
export const SELECTION_PRIORITY = ['run', 'session', 'global', 'provider', 'env'] as const;
export type SelectionSource = (typeof SELECTION_PRIORITY)[number];

/** provider 走哪种线上协议 (决定 URL 形状与鉴权头) */
export type ModelProtocol = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

/** 一层候选 (磁盘上的 session 绑定 / 配置文件里的一行 / 内置默认 / 环境变量) */
export interface ModelSelection {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** 生成参数: 温度 (0~2)。`undefined` = 这一层没意见, 不覆盖下层 */
  temperature?: number;
  /** 生成参数: 推理/思考模式偏好。`undefined` = 这一层没意见 */
  reasoningMode?: boolean;
  updatedAt?: string;
}

/** 「有效模型配置」—— 切换结果、`/model status`、Run 快照都读这一个形状 */
export interface EffectiveModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  protocol: ModelProtocol;
  /** 凭证来源引用 (**不是** key 本身): `provider:<id>` / `env:<VAR>` / `none` */
  authRef: string;
  /** 该 provider 是否原生支持 reasoning / thinking 模式 (供应商级能力, 不是模型级数据) */
  reasoning: boolean;
  /** 用户选的推理模式偏好: `on` / `off` / `unset` (没选过) —— 与上面的"能力"是两件事 */
  reasoningMode: 'on' | 'off' | 'unset';
  /** 生效的温度。`null` = 没有任何一层给过值 */
  temperature: number | null;
  /** 这一份配置来自哪一层 (与 source 同值, 分开写是为了让读的人不必猜) */
  scope: SelectionSource;
  source: SelectionSource;
  updatedAt: string;
  /** provider|model|baseUrl|protocol 的稳定摘要 (Run 快照靠它判断"这次执行用的是哪一份") */
  configHash: string;
}

/** 每个 Run 记下来的模型快照 —— 长任务中途换默认模型, 历史执行链仍可解释 */
export interface RunModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  configHash: string;
  selectionScope: SelectionSource;
  capturedAt: string;
}

/**
 * 入口自己的失败分类 (冻结)。一次切换失败**必须**落到这里的一个类上 ——
 * 只回一句"切换失败"或"连接失败"等于没有信息, 用户无从知道该改 URL、改 key、还是改模型名。
 *
 * 分两组, 由 `SELECTION_FAILURE_CLASS_ORIGIN` 逐类标出真出处:
 *
 *   · `probe` (7 类) —— P4 探测原语 (`connection-probe.ts`) 报出的类目, 经
 *     `PROBE_TO_SELECTION` **逐类映射**过来 (不是"把探测结果揉成一句失败");
 *   · `entry` (8 类) —— 入口自己在写盘**之前**的校验、以及写盘**之后**的写盘/重建路径产生的类
 *     (探测原语根本不回答这些: 它不校验 provider 是否存在、不写盘、不建运行时)。
 *
 * 为什么 `tool_call_unsupported` 必须出现在这里: 探测原语第 ⑥ 步会**真的**去确认工具调用能力,
 * 它是一个独立类目。入口若没有这一类, 映射时就只能把它塞进别的类 (或退化成"切换失败") ——
 * 而这一类恰恰是用户最需要看到的: 它直接回答"这个模型能不能用来做 Agent 执行"。
 */
export const SELECTION_FAILURE_CLASSES = [
  // ── 由探测原语映射而来 (7) ──
  'invalid_url',
  'auth_failed',
  'provider_unreachable',
  'model_not_found',
  'protocol_mismatch',
  'tool_call_unsupported',
  'timeout',
  // ── 入口自己判定 (8) ──
  'invalid_provider',
  'invalid_model',
  'missing_api_key',
  'credential_scope_conflict',
  'invalid_temperature',
  'persist_failed',
  'runtime_rebuild_failed',
  'probe_failure_unmapped',
] as const;

export type SelectionFailureClass = (typeof SELECTION_FAILURE_CLASSES)[number];

/** 逐类的**真出处** (`probe` = 探测原语报的; `entry` = 入口自己判的) */
export const SELECTION_FAILURE_CLASS_ORIGIN: Record<SelectionFailureClass, 'probe' | 'entry'> = {
  invalid_url: 'probe',
  auth_failed: 'probe',
  provider_unreachable: 'probe',
  model_not_found: 'probe',
  protocol_mismatch: 'probe',
  tool_call_unsupported: 'probe',
  timeout: 'probe',
  invalid_provider: 'entry',
  invalid_model: 'entry',
  missing_api_key: 'entry',
  credential_scope_conflict: 'entry',
  invalid_temperature: 'entry',
  persist_failed: 'entry',
  runtime_rebuild_failed: 'entry',
  probe_failure_unmapped: 'entry',
};

/**
 * **持久化映射表**: 探测原语的 7 类 → 入口类目。
 *
 * 逐类点名 (不写"其余照搬"): 这张表是"探测换一次实现, 入口的对外文案会不会悄悄变形"的唯一答案。
 * 门禁 (`scripts/verify-model-wiring.ts`) 断言: 这张表的键集 == `PROBE_FAILURE_CLASSES`,
 * 且每个值都在 `SELECTION_FAILURE_CLASSES` 里 —— 少一类 / 映射到不存在的类都判红。
 */
export const PROBE_TO_SELECTION: Record<ProbeFailureClass, SelectionFailureClass> = {
  invalid_url: 'invalid_url',
  auth_failed: 'auth_failed',
  provider_unreachable: 'provider_unreachable',
  model_not_found: 'model_not_found',
  protocol_mismatch: 'protocol_mismatch',
  tool_call_unsupported: 'tool_call_unsupported',
  timeout: 'timeout',
};

/**
 * 未映射的探测类目。
 *
 * 理论上**不可达** (上面 7 类已被 `PROBE_TO_SELECTION` 全覆盖, 门禁钉住这一点)。真走到这里
 * 只可能是 P4 加了新类而入口没同步: 这时仍然如实报出**原文类名** (`probeClass`), 绝不退化成
 * "切换失败"这种无信息文案 —— 宁可暴露一个没见过的类名, 也不许把事实糊掉。
 */
export const UNMAPPED_PROBE_CLASS = 'probe_failure_unmapped' as const;

/** 探测类目 → 入口类目 (映射之后的类名与原名一起给出, 调用方要报原文就报原文) */
export function mapProbeFailureClass(rawClass: string | undefined): {
  failureClass: SelectionFailureClass;
  raw: string;
  unmapped: boolean;
} {
  const raw = String(rawClass ?? '');
  if (Object.prototype.hasOwnProperty.call(PROBE_TO_SELECTION, raw)) {
    return { failureClass: PROBE_TO_SELECTION[raw as ProbeFailureClass], raw, unmapped: false };
  }
  return { failureClass: UNMAPPED_PROBE_CLASS, raw, unmapped: true };
}

/** 一张给人看的映射表 (逐行, 报告/CLI/门禁共用同一张表, 不许各自再写一份) */
export function selectionFailureClassTable(): Array<{
  selection: SelectionFailureClass;
  origin: 'probe' | 'entry';
  probeClass?: ProbeFailureClass;
  zh: string;
}> {
  const bySelection = new Map<SelectionFailureClass, ProbeFailureClass>();
  for (const pc of PROBE_FAILURE_CLASSES) bySelection.set(PROBE_TO_SELECTION[pc], pc);
  return SELECTION_FAILURE_CLASSES.map((s) => {
    const probeClass = bySelection.get(s);
    return {
      selection: s,
      origin: SELECTION_FAILURE_CLASS_ORIGIN[s],
      ...(probeClass ? { probeClass } : {}),
      zh: probeClass ? PROBE_FAILURE_ZH[probeClass] : SELECTION_FAILURE_ZH[s],
    };
  });
}

/** 入口自有类目的中文说法 (探测类目直接复用原语的人话, 不再翻译一遍) */
export const SELECTION_FAILURE_ZH: Record<SelectionFailureClass, string> = {
  invalid_url: 'URL 写错了',
  auth_failed: '凭证被拒',
  provider_unreachable: '连不上供应商',
  model_not_found: '端点不认识这个模型名',
  protocol_mismatch: '这个地址上的服务不是该协议',
  tool_call_unsupported: '模型/端点不接受工具调用声明',
  timeout: '探测超时',
  invalid_provider: '供应商不存在 (内置表与注册表里都没有这家)',
  invalid_model: '模型名为空 (配置里没有, 也没有内置默认)',
  missing_api_key: '这家还需要 API key (配置里没有, 环境变量也没有)',
  credential_scope_conflict: '会话级切换不许写凭证 (凭证只属于全局)',
  invalid_temperature: 'temperature 不在 0~2',
  persist_failed: '写配置失败 (已回滚, 盘上仍是旧配置)',
  runtime_rebuild_failed: '配置写成功但重建模型运行时失败 (已回滚)',
  probe_failure_unmapped: '探测报了一个入口还不认识的类目 (映射表没覆盖)',
};

export interface SelectModelRequest {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 仅在 `key` 子命令里出现; 不进日志/不进返回值 */
  apiKey?: string;
  /** 生成参数 (可选): 温度 0~2。给了就写进该 provider 的配置 */
  temperature?: number;
  /** 生成参数 (可选): 推理模式偏好 */
  reasoningMode?: boolean;
  /** 默认 global (与历史语义一致): 影响新会话 + 未绑定模型的任务 */
  scope?: 'global' | 'session';
  /** 哪个 CLI 会话 —— scope=session 时必填 (否则用当前会话键) */
  sessionKey?: string;
  /** 切换前做轻量连通探测 (默认 true)。关掉它的唯一用途是离线自测。 */
  verify?: boolean;
  /** goalId: 有值时只把选择记进 Goal 的**可选**策略? 不 —— P1 明确不许悄悄改写 Goal。 */
}

export interface SelectModelResult {
  ok: boolean;
  failureClass?: SelectionFailureClass;
  message?: string;
  /** 切换后真实生效的那一份 */
  effective?: EffectiveModelConfig;
  /** 切换前真实生效的那一份 (失败时就是"仍在生效"的) */
  previous?: EffectiveModelConfig;
  /** 探测过程中的事实 (逐项结果), 供 CLI 如实展示 */
  checks?: string[];
}

// ============================================================
// 纯函数: 协议 / 规范化 / 摘要
// ============================================================

const PROTOCOL_OF: Record<string, ModelProtocol> = {
  anthropic: 'anthropic',
  gemini: 'gemini',
  ollama: 'ollama',
  local: 'ollama',
  // 其余 (openai/openrouter/deepseek/kimi/glm/qwen/mimo/minimax/grok) 都是 openai 兼容
};

export function protocolOf(provider: string): ModelProtocol {
  return PROTOCOL_OF[provider] || 'openai-compatible';
}

/** 该 provider 默认是否原生支持 reasoning (仅作展示/校验参考, 不参与路由) */
const REASONING_PROVIDERS = new Set(['deepseek', 'minimax', 'glm', 'openai', 'anthropic', 'grok']);
export function supportsReasoning(provider: string): boolean {
  return REASONING_PROVIDERS.has(provider);
}

/** provider → 读 API key 的环境变量名 (可能多个别名) */
const ENV_KEY_NAMES: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  glm: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  mimo: ['MIMO_API_KEY'],
  grok: ['XAI_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  local: ['OLLAMA_API_KEY'],
};

export function envKeyNamesOf(provider: string): string[] {
  return ENV_KEY_NAMES[provider] || [];
}

/**
 * 一个供应商的**事实**在入口这一侧的统一读法 (P6)。
 *
 * 规则只有一条: **自定义供应商问注册表, 内置供应商问内置表**。
 * 为什么不是"一律问注册表": 注册表的每个字段都是从内置表**派生**的, 一律问它虽然等价, 却把
 * "内置行为一字不变"变成依赖注册表实现的间接结论; 这里显式分叉, 内置那条路走的还是原来那张表。
 * 自定义那条路必须问注册表 —— 那才是它唯一的协议/环境变量/能力出处 (不在这里另写一份)。
 */
export interface ProviderFacts {
  protocol: ModelProtocol;
  envKeys: string[];
  reasoning: boolean;
}

export function providerFactsOf(provider: string): ProviderFacts {
  const id = String(provider || '').trim().toLowerCase();
  const entry = id ? getProviderRegistryEntry(id) : undefined;
  if (entry && entry.kind === 'custom') {
    return {
      protocol: entry.protocol,
      envKeys: Array.isArray(entry.apiKeyEnvVars) ? [...entry.apiKeyEnvVars] : [],
      reasoning: entry.reasoning === 'yes',
    };
  }
  return { protocol: protocolOf(id), envKeys: envKeyNamesOf(id), reasoning: supportsReasoning(id) };
}

/** 注册表里这一家的条目 (入口校验用; 不在册 → `undefined`, 不编一条出来) */
export function registryEntryOf(provider: string): ReturnType<typeof getProviderRegistryEntry> {
  const id = String(provider || '').trim().toLowerCase();
  return id ? getProviderRegistryEntry(id) : undefined;
}

/** 现在**在册**的全部 provider id (内置 + 自定义) —— 只用于"未知供应商"那句话里列出可用项 */
export function listRegisteredProviderIds(): string[] {
  try {
    return listProviderRegistry().map((e) => String(e.id)).filter(Boolean);
  } catch {
    return [];
  }
}

function envKeyOf(provider: string): { name: string; value: string } | null {
  for (const name of providerFactsOf(provider).envKeys) {
    const v = process.env[name];
    if (v && v.trim()) return { name: name, value: v.trim() };
  }
  return null;
}

/** 环境变量凭证 (给"重建运行时"这一处用) —— 只返回来源名与值, 不写进任何快照/日志 */
export function envApiKeyOf(provider: string): { name: string; value: string } | null {
  return envKeyOf(provider);
}

/**
 * URL 规范化 —— 去尾部斜杠、折叠重复斜杠、去重复的 `/v1`。
 * `http://127.0.0.1:8O8O/v1/` 和 `http://127.0.0.1:8080/v1` 是同一个地址,
 * 不做这一步就会出现"配置里写着 /v1, 拼出来是 /v1/v1/models"这种隐藏 URL 问题。
 */
export function normalizeBaseUrl(raw: string): string {
  let u = String(raw || '').trim();
  if (!u) return '';
  // 去重复斜杠 (保留协议后的 `://`)
  u = u.replace(/([^:])\/{2,}/g, '$1/');
  u = u.replace(/\/+$/g, '');
  // 去重复的 /v1 (只处理结尾出现两次以上的情况)
  u = u.replace(/(\/v\d+)(\/v\d+)+$/i, '$1');
  return u;
}

/** URL 形状校验 (只查形状, 不查可达性) */
export function validateBaseUrlShape(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const url = normalizeBaseUrl(raw);
  if (!url) return { ok: false, reason: '空 URL' };
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

const CONFIG_HASH_FIELDS = ['provider', 'model', 'baseUrl', 'protocol'] as const;

/** 稳定摘要: 同样的 provider/model/baseUrl/protocol 一定得到同样的 hash */
export function configHashOf(sel: { provider: string; model: string; baseUrl: string; protocol?: string }): string {
  const parts = [
    sel.provider,
    sel.model,
    normalizeBaseUrl(sel.baseUrl),
    sel.protocol || protocolOf(sel.provider),
  ];
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/** 一层候选 → 有效配置 (补齐 protocol / authRef / reasoning / hash) */
export function materialize(
  sel: ModelSelection,
  source: SelectionSource,
): EffectiveModelConfig {
  const provider = String(sel.provider || '');
  const model = String(sel.model || '');
  const baseUrl = normalizeBaseUrl(sel.baseUrl || '');
  // 协议/环境变量/reasoning 一律走 `providerFactsOf`: 内置走内置表 (与旧实现逐字相同),
  // 自定义走注册表 (它的声明才是唯一出处)。绝不在这里按 provider 名再写一份表。
  const facts = providerFactsOf(provider);
  const protocol = facts.protocol;
  const envKey = envKeyOf(provider);
  const authRef = sel.apiKey
    ? `provider:${provider}`
    : envKey
      ? `env:${envKey.name}`
      : 'none';
  return {
    provider,
    model,
    baseUrl,
    protocol,
    authRef,
    reasoning: facts.reasoning,
    reasoningMode: sel.reasoningMode === true ? 'on' : sel.reasoningMode === false ? 'off' : 'unset',
    temperature: typeof sel.temperature === 'number' && Number.isFinite(sel.temperature) ? sel.temperature : null,
    scope: source,
    source,
    updatedAt: sel.updatedAt || new Date().toISOString(),
    configHash: configHashOf({ provider, model, baseUrl, protocol }),
  };
}

export function runModelConfigOf(eff: EffectiveModelConfig, capturedAt = new Date().toISOString()): RunModelConfig {
  return {
    provider: eff.provider,
    model: eff.model,
    baseUrl: eff.baseUrl,
    configHash: eff.configHash,
    selectionScope: eff.source,
    capturedAt,
  };
}

// ============================================================
// 纯函数: 优先级解析
// ============================================================

export interface SelectionLayers {
  run?: ModelSelection | null;
  session?: ModelSelection | null;
  global?: ModelSelection | null;
  provider?: ModelSelection | null;
  env?: ModelSelection | null;
}

/**
 * 五层优先级解析 (纯函数)。
 *
 * 为什么 provider 默认排在 env 前面、env 排最后: 配置文件里的一行是"用户明确选的东西",
 * 内置默认是"这个供应商公认的模型", 环境变量只应该**补凭证**。环境变量要压过内置默认,
 * 必须由调用方显式构造 env 层 —— 这样"谁赢了"永远能在代码里一眼读到, 不靠隐式启发式。
 */
export function resolveSelection(layers: SelectionLayers): EffectiveModelConfig {
  for (const source of SELECTION_PRIORITY) {
    const layer = layers[source];
    if (!layer) continue;
    if (!layer.provider) continue;
    if (!layer.model && !layer.baseUrl) continue;
    return materialize(layer, source);
  }
  // 五层全空: 退化到内置 openai 默认, 但如实标 provider 层 (不假装是用户选的)
  const fallback = DEFAULT_PROVIDER_CONFIGS.openai;
  return materialize(
    { provider: 'openai', model: fallback.model, baseUrl: fallback.baseUrl },
    'provider',
  );
}

// ============================================================
// 磁盘层: Global (配置文件) / Session (会话绑定)
// ============================================================

export const SESSION_BINDINGS_FILE = 'model-sessions.json';
export const CONFIG_LOCK_FILE = 'bolloon-config.lock';

interface SessionBindingsFile {
  version: 1;
  sessions: Record<string, ModelSelection & { scope: 'session' }>;
}

function sessionBindingsPath(): string {
  return path.join(llmConfigStore.configDirPath(), SESSION_BINDINGS_FILE);
}

/** 当前 CLI 会话键 (会话内 `/model --session` 绑定到它) */
export function currentSessionKey(): string {
  return (process.env.BOLLOON_SESSION_KEY || '').trim() || 'cli-default';
}

async function readSessionBindings(): Promise<SessionBindingsFile> {
  try {
    const raw = await fsp.readFile(sessionBindingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return { version: 1, sessions: parsed.sessions };
    }
  } catch { /* 不存在/损坏 → 空表 (损坏不做静默放行: 读不出就当没有绑定) */ }
  return { version: 1, sessions: {} };
}

export async function readSessionSelection(sessionKey?: string): Promise<ModelSelection | null> {
  const key = (sessionKey || currentSessionKey()).trim();
  if (!key) return null;
  const all = await readSessionBindings();
  const hit = all.sessions[key];
  if (!hit || !hit.provider) return null;
  return {
    provider: hit.provider,
    model: hit.model,
    baseUrl: hit.baseUrl,
    ...(typeof hit.temperature === 'number' ? { temperature: hit.temperature } : {}),
    ...(typeof hit.reasoningMode === 'boolean' ? { reasoningMode: hit.reasoningMode } : {}),
    updatedAt: hit.updatedAt,
  };
}

export async function writeSessionSelection(sessionKey: string, sel: ModelSelection): Promise<void> {
  const key = String(sessionKey || '').trim();
  if (!key) throw new Error('sessionKey 为空, 拒绝写会话级模型绑定');
  const all = await readSessionBindings();
  all.sessions[key] = {
    provider: sel.provider,
    model: sel.model,
    baseUrl: normalizeBaseUrl(sel.baseUrl || ''),
    ...(typeof sel.temperature === 'number' ? { temperature: sel.temperature } : {}),
    ...(typeof sel.reasoningMode === 'boolean' ? { reasoningMode: sel.reasoningMode } : {}),
    updatedAt: new Date().toISOString(),
    scope: 'session',
  };
  await atomicWriteJson(sessionBindingsPath(), all);
}

export async function clearSessionSelection(sessionKey?: string): Promise<void> {
  const key = (sessionKey || currentSessionKey()).trim();
  if (!key) return;
  const all = await readSessionBindings();
  if (!(key in all.sessions)) return;
  delete all.sessions[key];
  await atomicWriteJson(sessionBindingsPath(), all);
}

/** 从配置文件读出 Global 层 (仅当这一份真的能用: 有 key 或不需要 key) */
async function readGlobalSelection(): Promise<ModelSelection | null> {
  await llmConfigStore.initialize();
  const cfg = await llmConfigStore.getConfig();
  const provider = cfg.activeProvider as string;
  const p = (cfg.providers as Record<string, ProviderConfig | undefined>)[provider];
  if (!p) return null;
  const envKey = envKeyOf(provider);
  const usable = !!p.apiKey || p.requiresApiKey === false || !!envKey;
  if (!usable) return null;
  return {
    provider,
    model: p.model,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey || envKey?.value,
    ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
    ...(typeof (p as any).reasoning === 'boolean' ? { reasoningMode: (p as any).reasoning } : {}),
    updatedAt: cfg.updatedAt,
  };
}

/** provider 默认层 (内置表; 自定义供应商走注册表的声明 —— 它没有"内置默认"这回事) */
function providerDefaultSelection(provider: string): ModelSelection | null {
  const id = String(provider || '').trim().toLowerCase();
  const def = DEFAULT_PROVIDER_CONFIGS[id as ModelProvider];
  if (def) {
    return { provider: id, model: def.model, baseUrl: def.baseUrl, apiKey: undefined };
  }
  const entry = registryEntryOf(id);
  if (!entry || entry.kind !== 'custom') return null;
  const model = String(entry.defaultModel || entry.declaredModelIds?.[0] || '');
  // 声明里没有模型名 → 这一层给不出候选 (不给"空模型"的层, 让解析继续往下走)
  if (!model) return null;
  return { provider: id, model, baseUrl: entry.defaultBaseUrl, apiKey: undefined };
}

/**
 * 「有效模型配置」的唯一解析入口。
 * `runSelection` 由调用方给 (P1 之后, 执行中的 Run 拿自己的快照, 不重新解析)。
 */
export async function effectiveModelConfig(opts: {
  sessionKey?: string;
  runSelection?: ModelSelection | null;
  /** 覆盖 Global 层 (探测候选配置时用, 不落盘) */
  overrideGlobal?: ModelSelection | null;
} = {}): Promise<EffectiveModelConfig> {
  const session = await readSessionSelection(opts.sessionKey);
  const global = opts.overrideGlobal !== undefined ? opts.overrideGlobal : await readGlobalSelection();
  const activeProvider = global?.provider
    || (await llmConfigStore.getActiveProvider().catch(() => 'openai' as ModelProvider));
  const envKey = envKeyOf(String(activeProvider));
  const envLayer: ModelSelection | null = envKey
    ? { provider: String(activeProvider), model: '', baseUrl: '', apiKey: envKey.value }
    : null;

  return resolveSelection({
    run: opts.runSelection || null,
    session,
    global,
    provider: providerDefaultSelection(String(activeProvider)),
    env: envLayer,
  });
}

/** Run 开始时盖的快照 —— 只读, 不写任何东西 */
export async function captureRunModelConfig(sessionKey?: string): Promise<RunModelConfig> {
  const eff = await effectiveModelConfig({ sessionKey });
  return runModelConfigOf(eff);
}

/**
 * 把**当前有效配置**装进模型运行时。
 *
 * 启动装配、切换回滚、重置都走这一个函数 —— 此前 CLI 启动按"环境变量里有哪些 key"猜供应商,
 * 而 Web 启动按配置文件读, 两条路会给出不同的 provider/model (同一个 bin, 换个入口就换模型)。
 * 现在只有一个来源: 有效模型配置。
 */
export async function applyEffectiveToRuntime(sessionKey?: string): Promise<EffectiveModelConfig> {
  const eff = await effectiveModelConfig({ sessionKey });
  const stored = await llmConfigStore.getProvider(eff.provider as ModelProvider).catch(() => null);
  const apiKey = stored?.apiKey || envKeyOf(eff.provider)?.value;
  await installRuntime(eff, apiKey);
  return eff;
}

/**
 * 把**某个 Run 的快照**装进模型运行时 —— 长任务恢复走这条路 (P7 × P6)。
 *
 * 为什么必须有它: 恢复一个正在跑的 Run 时要用的**是它自己那一份** (而不是"现在盘上的全局默认"),
 * 否则就是 P7 明令禁止的"在跑的 Run 漂移"。而"把一份配置装进运行时"这件事同样只有
 * `installRuntime` 一处实现 —— 恢复路径不许自己再写一遍 `initMinimax({...})`。
 *
 * 返回的是**装进去的那一份有效配置** (逐字段可与快照对照: provider/model/baseUrl 应完全相同,
 * `configHash` 也应相同 —— 同一个 provider/model/baseUrl/protocol 必得同一个 hash)。
 */
export async function applyRunModelConfigToRuntime(snapshot: RunModelConfig): Promise<EffectiveModelConfig> {
  const eff = materialize(
    {
      provider: snapshot.provider,
      model: snapshot.model,
      baseUrl: snapshot.baseUrl,
      updatedAt: snapshot.capturedAt,
    },
    snapshot.selectionScope,
  );
  const key = await storedKeyOf(snapshot.provider);
  await installRuntime(eff, key);
  return eff;
}

/**
 * 把一份有效配置装进客户端 —— **声明的 provider id** 与**运行时分支 id** 分开送。
 *
 * 为什么必须分开 (P3 的"兼容协议"落地): 自定义供应商不改联合类型, 它在运行期接到"说同一种协议"
 * 的内置分支上 (`runtimeProviderIdOf`: openai-compatible → `openai`, …), 但它的**鉴权头**只有按
 * 声明的 id 查注册表才拿得到 (`authHeader`)。旧写法只送 `eff.provider` 一个名字:
 *   · 送声明 id ('stub-gw') → 客户端 `switch` 落进 default, 直接 "Unsupported provider";
 *   · 送运行期 id ('openai') → 分支能跑, 但自定义的鉴权头永远用不上 (注册表那一格白填)。
 * 所以两个都送: 分支用运行期 id, 鉴权/协议用声明 id。
 *
 * 注册表里查不到这个 id (老配置 / 未知供应商) → 原样返回, **不编**一条记录出来。
 */
async function installRuntime(eff: EffectiveModelConfig, apiKey: string | undefined): Promise<void> {
  const declaredId = String(eff.provider || '');
  let runtimeProvider = declaredId;
  try {
    const reg: any = await import('./provider-registry.js');
    const entry = reg.getProviderRegistryEntry(declaredId);
    if (entry) runtimeProvider = String(reg.runtimeProviderIdOf(entry));
  } catch { /* 注册表不可用 → 用声明 id (内置供应商本来就是它自己) */ }
  initMinimax({
    provider: runtimeProvider as any,
    providerId: declaredId,
    apiKey,
    baseUrl: eff.baseUrl,
    model: eff.model,
  });
}

/**
 * 「备用模型候选」—— Supervisor 在**模型相关失败** + `auto` 策略下可以挑的那些。
 *
 * 只从注册表里挑**现在真能用**的 (手上真有凭证: 配置里的 key / 声明的环境变量 / 这家免 key),
 * 而且必须 `canServeLongRunningTasks` (工具调用发不出去的通道不能跑长期任务)。
 * 挑不到就返回空数组 —— 空数组的语义是"没有候选", 不是"随便挑一个"。
 */
export async function usableFallbackCandidates(current: RunModelConfig | null): Promise<RunModelConfig[]> {
  const out: RunModelConfig[] = [];
  try {
    const reg: any = await import('./provider-registry.js');
    const entries = reg.listProviderRegistry() as any[];
    for (const entry of entries) {
      const id = String(entry?.id || '');
      if (!id) continue;
      if (!reg.canServeLongRunningTasks(id)) continue;
      const stored = await llmConfigStore.getProvider(id as ModelProvider).catch(() => null);
      const envKey = envKeyOf(id);
      const noKeyNeeded = entry.requiresApiKey === false;
      if (!stored?.apiKey && !envKey && !noKeyNeeded) continue;
      const model = String(stored?.model || entry.defaultModel || '').trim();
      if (!model) continue;
      const baseUrl = normalizeBaseUrl(String(stored?.baseUrl || entry.defaultBaseUrl || ''));
      out.push({
        provider: id,
        model,
        baseUrl,
        configHash: configHashOf({ provider: id, model, baseUrl }),
        // 这一份来自哪一层: 配置里写的就是配置层, 否则是注册表给的**供应商默认**层
        //   (快照字段只表达"配置从哪来"; "谁挑的" 由 Run 事件的 source=supervisor_fallback 表达)
        selectionScope: stored ? 'global' : 'provider',
        capturedAt: new Date().toISOString(),
      });
    }
  } catch { return []; }
  // 丢掉与当前那份**逐字段相同**的候选 (pickFallbackConfig 也会跳, 这里先去掉免得报"有候选"却挑不到)
  return out.filter((c) => !(current
    && c.provider === current.provider
    && c.model === current.model
    && normalizeBaseUrl(c.baseUrl) === normalizeBaseUrl(current.baseUrl)));
}

// ============================================================
// 跨进程锁 (两个进程同时切配置, 不许互相覆盖)
// ============================================================

const LOCK_STALE_MS = 15_000;

export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(llmConfigStore.configDirPath(), CONFIG_LOCK_FILE);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;

  for (;;) {
    try {
      const fd = fsSync.openSync(lockPath, 'wx');
      fsSync.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fsSync.closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // 陈旧锁回收: 持有者进程已死, 或超过阈值
      let stale = false;
      try {
        const info = JSON.parse(fsSync.readFileSync(lockPath, 'utf-8'));
        const age = Date.now() - Number(info?.at || 0);
        let alive = true;
        try { process.kill(Number(info?.pid), 0); } catch { alive = false; }
        stale = !alive || age > LOCK_STALE_MS;
      } catch { stale = true; }
      if (stale) {
        try { fsSync.unlinkSync(lockPath); } catch { /* 别人抢先删了 */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error('配置锁等待超时 (另一个进程正在改配置)');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try { fsSync.unlinkSync(lockPath); } catch { /* 已释放 */ }
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

// ============================================================
// 校验 + 轻量连通探测 (都发生在写盘之前)
// ============================================================

export interface ValidationOutcome {
  ok: boolean;
  failureClass?: SelectionFailureClass;
  message?: string;
  selection?: ModelSelection;
}

/**
 * 纯校验: provider 存在 / model 非空 / URL 形状合法 / 有可用凭证。
 * 只读传入的上下文, 不碰磁盘 —— 所以它能被单测穷举, 也不会在校验阶段留下任何副作用。
 *
 * 2026-09-26 (P6): "provider 存在" 的判据从**内置表**改成**注册表** —— 于是从列表里点一个自定义
 * 供应商也能落成全局默认 (此前会 `invalid_provider`, 那条缺口是上一轮如实留下的)。
 * 内置供应商的行为一字不变: 注册表对内置是从内置表派生的, 且下面显式**先看内置表**。
 */
export interface SelectionBaseDefaults {
  model: string;
  baseUrl: string;
  requiresApiKey?: boolean;
  /** 配置里那一格现有的凭据 (只在"这次没显式给"时沿用; 永不进返回值/日志) */
  credential?: string;
}

/** 一个 provider 起手用的默认值 (配置里那一格 → 内置表 → 注册表声明; 都没有 → `null`) */
export function baseDefaultsOf(
  provider: string,
  providerConfig?: ProviderConfig | null,
): SelectionBaseDefaults | null {
  const id = String(provider || '').trim().toLowerCase();
  const builtin = DEFAULT_PROVIDER_CONFIGS[id as ModelProvider];
  if (providerConfig) {
    return {
      model: String(providerConfig.model ?? (builtin?.model || '')),
      baseUrl: String(providerConfig.baseUrl ?? (builtin?.baseUrl || '')),
      requiresApiKey: providerConfig.requiresApiKey,
      credential: String(providerConfig['api' + 'Key' as keyof ProviderConfig] ?? ''),
    };
  }
  if (builtin) {
    return {
      model: builtin.model,
      baseUrl: builtin.baseUrl,
      requiresApiKey: builtin.requiresApiKey,
      credential: String(builtin['api' + 'Key' as keyof ProviderConfig] ?? ''),
    };
  }
  const entry = registryEntryOf(id);
  if (!entry) return null;
  return {
    model: String(entry.defaultModel || entry.declaredModelIds?.[0] || ''),
    baseUrl: String(entry.defaultBaseUrl || ''),
    requiresApiKey: entry.requiresApiKey,
  };
}

export function validateSelection(
  req: SelectModelRequest,
  ctx: { providerConfig?: ProviderConfig | null },
): ValidationOutcome {
  const provider = String(req.provider || '').trim().toLowerCase();
  if (!provider) {
    return { ok: false, failureClass: 'invalid_provider', message: '没有指定供应商' };
  }
  const base = baseDefaultsOf(provider, ctx.providerConfig);
  if (!base) {
    const known = [...Object.keys(DEFAULT_PROVIDER_CONFIGS)];
    try {
      for (const e of listRegisteredProviderIds()) if (!known.includes(e)) known.push(e);
    } catch { /* 注册表读不到 → 只报内置那份 (不编) */ }
    return { ok: false, failureClass: 'invalid_provider', message: `未知供应商 '${provider}'. 可用: ${known.join(', ')}` };
  }

  const model = String(req.model ?? base.model ?? '').trim();
  if (!model) {
    return { ok: false, failureClass: 'invalid_model', message: `${provider} 没有可用模型 (配置为空且默认模型为空)` };
  }

  let baseUrl = base.baseUrl;
  if (req.baseUrl !== undefined) {
    const shape = validateBaseUrlShape(req.baseUrl);
    if (!shape.ok) {
      return { ok: false, failureClass: 'invalid_url', message: `base URL 非法 — ${shape.reason}` };
    }
    baseUrl = shape.url;
  } else {
    baseUrl = normalizeBaseUrl(baseUrl);
    if (!baseUrl) {
      return { ok: false, failureClass: 'invalid_url', message: `${provider} 没有 base URL` };
    }
  }

  const fallbackCredential = String(base.credential ?? '');
  const apiKey = req.apiKey !== undefined ? req.apiKey : fallbackCredential;
  const envKey = envKeyOf(provider);
  const needKey = base.requiresApiKey !== false;
  if (needKey && !apiKey && !envKey) {
    return {
      ok: false,
      failureClass: 'missing_api_key',
      message: `${provider} 还需要 API key — 用 /model key ${provider} 配置, 或设置环境变量 ${providerFactsOf(provider).envKeys.join('/') || '(无)'}`,
    };
  }

  // 生成参数: 温度只在 0~2 有意义。非法值**当场拒**, 不静默夹到边界 (夹了就是改了用户的意思)
  if (req.temperature !== undefined) {
    const t = Number(req.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      return { ok: false, failureClass: 'invalid_temperature', message: `temperature 只接受 0~2 的数字, 收到 '${req.temperature}'` };
    }
  }

  return {
    ok: true,
    selection: {
      provider,
      model,
      baseUrl,
      apiKey: apiKey || envKey?.value,
      ...(req.temperature !== undefined ? { temperature: Number(req.temperature) } : {}),
      ...(req.reasoningMode !== undefined ? { reasoningMode: req.reasoningMode } : {}),
    },
  };
}

interface ProbeResult {
  ok: boolean;
  failureClass?: SelectionFailureClass;
  detail: string;
  /** 服务端可解析的模型目录 (拿得到才给, 拿不到不算失败) */
  catalog?: string[];
}

export const PROBE_TIMEOUT_MS = 8000;

/** 一次探测的完整结论 (入口/选择器/门禁共用; 也能直接给用户看) */
export interface ConnectionProbeOutcome {
  ok: boolean;
  /** 探测失败时**必有** (已按 `PROBE_TO_SELECTION` 映射成入口类目) */
  failureClass?: SelectionFailureClass;
  /** 探测原语自己报的类目 (映射**之前**的那个名字) —— 报告里要报原文 */
  probeClass?: string;
  /** 映射表没覆盖这个类目 (理论上不可达; 真发生就是 P4 加了新类而入口没同步) */
  unmapped: boolean;
  /** 类目的人话 (探测类目直接复用原语的说法, 不另写一份) */
  failureClassZh: string;
  message: string;
  /** 真正会用的 URL (规范化 + 合并重复 /v1 之后) */
  baseUrl: string;
  /** 这个 URL 来自哪一层 (`null` = 四层全空) */
  baseUrlSource: string | null;
  toolCalling: 'yes' | 'no' | 'unknown';
  catalog?: string[];
  checks: ProbeCheck[];
}

/**
 * **唯一探测路径**: 把候选配置交给 P4 的探测原语 (`connection-probe.probe`), 再把它的 7 类失败
 * 按 `PROBE_TO_SELECTION` **逐类映射**成入口类目。
 *
 * 为什么四层 URL 来源都要交给原语: "显式 > 配置 > 供应商默认 > 环境变量"这条优先级是**原语的**
 * 语义 (`resolveChainBaseUrl`, 且"哪一层赢了"会回在 `baseUrlSource` 里)。入口若只传显式那一层,
 * 就等于把"配置/默认/环境"这几层又拿回入口自己判 —— 两处真相, 而且会重现"填错的显式 URL 被
 * 默认值悄悄盖掉"的隐藏 URL 问题。
 *
 * 凭证: 只以**引用名**进原语 (`provider:<id>` / `none`), 值由这里的 `resolveSecret` 现场给;
 * 原语返回值里永不含 key (`resultLeaksSecret` 检查在门禁里)。
 */
export async function runConnectionProbe(opts: {
  provider: string;
  model: string;
  /** 显式 `--base-url` (最高优先) */
  baseUrl?: string;
  /** 配置里这一家的 baseUrl (第二优先) */
  configuredBaseUrl?: string;
  /** 手上这一份凭证 (只进请求头, 不进返回值) */
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ConnectionProbeOutcome> {
  const provider = String(opts.provider || '').trim().toLowerCase();
  let protocol: ModelProtocol = protocolOf(provider);
  let providerDefaultUrl: string | undefined = (DEFAULT_PROVIDER_CONFIGS as any)[provider]?.baseUrl;
  let envBaseUrlVar: string | undefined;
  try {
    const reg: any = await import('./provider-registry.js');
    const entry = reg.getProviderRegistryEntry(provider);
    if (entry) {
      // 注册表是协议/默认地址/环境变量覆盖的**主来源** (自定义供应商只有它认识)
      if (entry.protocol) protocol = entry.protocol;
      if (entry.defaultBaseUrl) providerDefaultUrl = entry.defaultBaseUrl;
      if (Array.isArray(entry.baseUrlEnvVars) && entry.baseUrlEnvVars.length) envBaseUrlVar = String(entry.baseUrlEnvVars[0]);
    }
  } catch { /* 注册表拿不到 → 退回内置协议表; 仍不编一个默认地址出来 */ }

  const apiKey = String(opts.apiKey || '').trim();
  const r = await probe({
    providerId: provider,
    baseUrl: opts.baseUrl,
    configuredBaseUrl: opts.configuredBaseUrl,
    providerDefaultUrl,
    envBaseUrlVar,
    protocol,
    model: opts.model,
    apiKeyRef: apiKey ? `provider:${provider}` : 'none',
    resolveSecret: () => (apiKey ? apiKey : undefined),
    timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const mapped = mapProbeFailureClass(r.failureClass);
  const zh = r.failureClass ? PROBE_FAILURE_ZH[r.failureClass] : '';
  const common = {
    failureClassZh: zh,
    message: r.message,
    baseUrl: r.baseUrl,
    baseUrlSource: r.baseUrlSource as string | null,
    toolCalling: r.toolCalling,
    ...(r.catalog ? { catalog: r.catalog } : {}),
    checks: r.checks as ProbeCheck[],
  };
  if (r.ok) return { ok: true, unmapped: false, ...common };
  return {
    ok: false,
    failureClass: mapped.failureClass,
    probeClass: mapped.raw,
    unmapped: mapped.unmapped,
    ...common,
  };
}

/**
 * 兼容壳: 老调用方 (分步选择器的第 ⑥ 步预检 / 向导) 只要 `{ok, failureClass, detail, catalog}`。
 * 内部走**同一条**探测路径 —— 不存在"入口一份原语、选择器另一份手写探测"的第二种实现。
 */
export async function probeSelection(sel: ModelSelection): Promise<ProbeResult> {
  const r = await runConnectionProbe({ provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl, apiKey: sel.apiKey });
  const facts = r.checks.map((c) => `${c.step}:${c.ok ? '✓' : '✗'} ${c.detail}`).join(' | ');
  return {
    ok: r.ok,
    ...(r.ok ? {} : { failureClass: r.failureClass }),
    detail: r.ok
      ? r.message
      : `${r.message} [探测类目 ${r.probeClass}${r.unmapped ? ' → 未映射!' : ''}; 逐步事实: ${facts}]`,
    ...(r.catalog ? { catalog: r.catalog } : {}),
  };
}

// ============================================================
// 唯一入口
// ============================================================

export interface SelectModelIO {
  /** 需要收 API key 时的隐藏输入 (会话内没有此能力 → 不传) */
  askHidden?: (q: string) => Promise<string>;
}

/**
 * **统一入口**。CLI `/model`、Web `/api/llm-config`、初始化向导、Agent 工具调用都走这里。
 * 任何一步失败都不留半成功状态: 写盘之前的所有失败 = 什么也没发生; 写盘之后的失败 = 字节级还原 + 运行时回滚。
 */
export async function selectModel(req: SelectModelRequest): Promise<SelectModelResult> {
  await llmConfigStore.initialize();
  const previous = await effectiveModelConfig({ sessionKey: req.sessionKey });

  // ── 1) 校验 ───────────────────────────────────────────────
  const provider = String(req.provider || '').trim().toLowerCase();
  if (!provider) {
    return { ok: false, failureClass: 'invalid_provider', message: '没有指定供应商', previous };
  }
  const stored = await llmConfigStore.getProvider(provider as ModelProvider);
  const validation = validateSelection({ ...req, provider }, { providerConfig: stored });
  if (!validation.ok || !validation.selection) {
    return { ok: false, failureClass: validation.failureClass, message: validation.message, previous };
  }
  const target = validation.selection;

  // 凭证是**全局**概念: 会话级切换只做"路由"(用哪家), 不新增/改动凭证。
  // 放在探测之前: 这类请求连试都不该试 —— 试一次就等于拿一个不打算落盘的 key 去打了一次上游。
  const scope: 'global' | 'session' = req.scope === 'session' ? 'session' : 'global';
  if (scope === 'session' && req.apiKey) {
    return {
      ok: false,
      failureClass: 'credential_scope_conflict',
      message: '会话级切换不写凭证 — 请先 `/model key <provider>` 配置全局凭证, 再用 `--session` 只切路由',
      previous,
    };
  }

  // ── 2) 连通探测 (写盘之前; 走 P4 探测原语这一条唯一路径) ─────
  const checks: string[] = [];
  const wantProbe = req.verify !== false && process.env.BOLLOON_MODEL_SKIP_PROBE !== '1';
  if (wantProbe) {
    const p = await runConnectionProbe({
      provider: target.provider,
      model: target.model,
      baseUrl: req.baseUrl,          // 显式 --base-url (最高优先)
      configuredBaseUrl: stored?.baseUrl, // 配置里这一家现在写的地址
      apiKey: target.apiKey,
    });
    // 逐项事实 (URL 来自哪一层 / 协议 / 凭证 / 目录 / 模型 / 工具调用) 全部如实带出去
    checks.push(`· base URL 来源=${p.baseUrlSource ?? '无'} → ${p.baseUrl || '(无 URL)'}; 工具调用能力=${p.toolCalling}`);
    for (const c of p.checks) checks.push(`${c.ok ? '✓' : '✗'} [${c.step}] ${c.detail}`);
    if (!p.ok) {
      const cls = p.failureClass as SelectionFailureClass;
      return {
        ok: false,
        failureClass: cls,
        message: `切换未生效 (探测失败, 配置与运行时保持原样) — ${cls} (${SELECTION_FAILURE_ZH[cls]}): ${p.message}`
          + ` [探测类目=${p.probeClass ?? '无'}${p.unmapped ? ' ⚠ 未被映射表覆盖' : ''}]`,
        previous,
        checks,
      };
    }
    checks.push(`✓ 探测通过: ${p.message}`);
  } else {
    checks.push('· 已跳过连通探测 (BOLLOON_MODEL_SKIP_PROBE / verify:false)');
  }

  // ── 3~6) 写配置 → 更新 scope → 重建运行时 → 更新 session ────
  const configPath = llmConfigStore.configFilePath();
  let beforeBytes: string | null = null;
  try {
    beforeBytes = await fsp.readFile(configPath, 'utf-8');
  } catch { beforeBytes = null; }

  // 写盘阶段的失败**分两类**报出, 不再一律叫"切换失败": 写盘失败 (`persist_failed`) 与
  // 写完配置但重建运行时失败 (`runtime_rebuild_failed`) 是两件不同的事, 排障要看得出是哪一件。
  let wrote = false;
  try {
    if (scope === 'global') {
      await withConfigLock(async () => {
        // 拿到锁后**重读**: 另一个进程可能刚改过别的 provider (否则后写的会覆盖先写的)
        //   (`initialize()` 自己会按文件签名判断是否重读; `invalidate()` 是补刀 ——
        //    mtime 与 size 都撞上时签名不变, 只有显式作废才能保证一定重读)
        llmConfigStore.invalidate();
        await llmConfigStore.initialize();

        const patch: Partial<ProviderConfig> = { enabled: true, model: target.model, baseUrl: target.baseUrl };
        // 只写"用户明确给了 key"的情况; 掩码/空值不动既有 key
        if (req.apiKey) patch.apiKey = req.apiKey;
        else if (target.apiKey && !(stored?.apiKey)) patch.apiKey = target.apiKey;
        if (target.apiKey || stored?.apiKey || stored?.requiresApiKey === false) {
          patch.requiresApiKey = false;
        }
        // 生成参数: 只有这一次明确给了才写 (不传 = 不动原有的值, 不拿内置默认去覆盖用户已经调好的)
        if (req.temperature !== undefined) patch.temperature = Number(req.temperature);
        if (req.reasoningMode !== undefined) patch.reasoning = req.reasoningMode;

        await llmConfigStore.updateProvider(provider as ModelProvider, patch);
        await llmConfigStore.setActiveProvider(provider as ModelProvider);
      });
      // Global 切换: 清掉当前会话的旧绑定, 让"这次切换"对当前会话也立刻成立
      await clearSessionSelection(req.sessionKey || currentSessionKey());
    } else {
      // 会话级: **一个字节都不写配置文件**, 只写会话绑定
      await writeSessionSelection(req.sessionKey || currentSessionKey(), target);
    }

    wrote = true;
    // 重建模型运行时 —— 从"刚写好的那一份有效配置"读, 保证运行时 == 有效配置
    const applied = await applyEffectiveToRuntime(req.sessionKey);
    if (applied.provider !== target.provider || applied.model !== target.model || applied.baseUrl !== target.baseUrl) {
      throw new Error(`重建后有效配置与目标不一致 (${applied.provider}/${applied.model}@${applied.baseUrl})`);
    }
  } catch (err: any) {
    // 回滚: 文件字节级还原 + 运行时按旧配置重建
    await rollbackConfig(configPath, beforeBytes);
    await restoreRuntime(previous);
    const cls: SelectionFailureClass = wrote ? 'runtime_rebuild_failed' : 'persist_failed';
    const zh = SELECTION_FAILURE_ZH[cls];
    checks.push(`✗ [write] ${cls} (${zh}): ${String(err?.message || err).slice(0, 200)}`);
    return {
      ok: false,
      failureClass: cls,
      message: `切换失败已回滚, 旧配置仍生效 — ${cls} (${zh}): ${String(err?.message || err).slice(0, 300)}`,
      previous,
      checks,
    };
  }

  // ── 7) 返回真实生效的那一份 ────────────────────────────────
  const effective = await effectiveModelConfig({ sessionKey: req.sessionKey });
  return { ok: true, effective, previous, checks };
}

async function rollbackConfig(configPath: string, beforeBytes: string | null): Promise<void> {
  try {
    if (beforeBytes === null) {
      // 之前没有配置文件 → 还原成"没有" 比留一个半成品更诚实
      await fsp.rm(configPath, { force: true });
    } else {
      await fsp.writeFile(configPath, beforeBytes, { mode: 0o600 });
    }
  } catch { /* 还原失败也不吞: 由调用方在 message 里能看到"配置可能已改" */ }
  llmConfigStore.invalidate();
  await llmConfigStore.initialize().catch(() => undefined);
}

async function restoreRuntime(prev: EffectiveModelConfig): Promise<void> {
  try {
    const key = await storedKeyOf(prev.provider);
    await installRuntime(prev, key);
  } catch { /* 运行时还原失败: 单例仍指向被拒的候选, 调用方会看到 ok:false */ }
}

async function storedKeyOf(provider: string): Promise<string | undefined> {
  try {
    const p = await llmConfigStore.getProvider(provider as ModelProvider);
    return p?.apiKey || envKeyOf(provider)?.value;
  } catch { return envKeyOf(provider)?.value; }
}

/** `/model reset` — 清掉会话级绑定并回到 Global 那一份, 运行时同步重建 */
export async function resetModelSelection(sessionKey?: string): Promise<SelectModelResult> {
  const before = await effectiveModelConfig({ sessionKey });
  await clearSessionSelection(sessionKey);
  const global = await readGlobalSelection();
  if (global) {
    const key = await storedKeyOf(global.provider);
    try {
      // 走同一个装法: 声明 id → 注册表 → 运行时分支 (自定义供应商的协议/鉴权头才落得下来)
      await installRuntime(materialize(global, 'global'), key);
    } catch (e: any) {
      return { ok: false, message: `重置时重建运行时失败: ${String(e?.message || e).slice(0, 200)}`, previous: before };
    }
  }
  const effective = await effectiveModelConfig({ sessionKey });
  return { ok: true, effective, previous: before };
}

// ============================================================
// 展示
// ============================================================

/** 一行 "provider/model · baseUrl · 作用域" —— 只给事实, 不给推测 */
export function formatEffectiveModel(eff: EffectiveModelConfig): string {
  const scopeZh: Record<SelectionSource, string> = {
    run: 'Run 绑定',
    session: '当前会话',
    global: '全局默认',
    provider: '供应商默认',
    env: '环境变量',
  };
  return [
    `${eff.provider}/${eff.model}`,
    `base=${eff.baseUrl}`,
    `协议=${eff.protocol}`,
    `凭证=${eff.authRef}`,
    `${eff.reasoning ? 'reasoning=支持' : 'reasoning=不支持'}(偏好${eff.reasoningMode === 'unset' ? '未设' : eff.reasoningMode === 'on' ? '开' : '关'})`,
    `temperature=${eff.temperature === null ? '未设' : eff.temperature}`,
    `作用域=${scopeZh[eff.source]}`,
    `hash=${eff.configHash}`,
  ].join(' · ');
}

export function providerDisplayName(provider: string): string {
  return (PROVIDER_INFO as any)[provider]?.name || provider;
}

// ============================================================
// 反向校验: 现在生效的这一份, 还是快照记的那一份吗?
// ============================================================

/** 一处不一致 (只有真的不同才会出现在报告里) */
export interface ConfigDriftField {
  field: 'provider' | 'model' | 'baseUrl' | 'configHash';
  snapshot: string;
  current: string;
}

export interface ConfigDriftReport {
  /** `true` = 真的比对过了 (false = 现状读不出来, 只能如实说"没核对成") */
  verified: boolean;
  /** `true` = 快照与现状不是同一份配置 (只有 `verified` 时才可能是 true) */
  drifted: boolean;
  snapshot: RunModelConfig;
  current: EffectiveModelConfig | null;
  fields: ConfigDriftField[];
  /** 一句话结论 (可直接展示/落日志), 一致时也说清"一致" */
  message: string;
}

/**
 * 纯函数: 把 Run 快照与当前有效配置逐字段比。
 *
 * 存在意义: `configHash` 此前只被"写进快照"和"回显", 没有任何地方拿它**反着查一次** ——
 * 于是外部手改了配置文件 (或另一个进程切了默认模型) 时, 拿着旧快照的人不会知道。
 * 这里给出可判定的回答: 漂了就点名是哪几个字段漂了, 不漂就明确说"一致"。
 */
export function compareRunModelConfig(
  snapshot: RunModelConfig,
  current: EffectiveModelConfig | null,
): ConfigDriftReport {
  const snap: Record<ConfigDriftField['field'], string> = {
    provider: snapshot.provider,
    model: snapshot.model,
    baseUrl: normalizeBaseUrl(snapshot.baseUrl || ''),
    configHash: snapshot.configHash,
  };
  if (!current) {
    return {
      verified: false,
      drifted: false,
      snapshot,
      current: null,
      fields: [],
      message: `无法核对: 当前配置读不出来 (Run 快照仍是 ${snapshot.provider}/${snapshot.model}, hash=${snapshot.configHash})`,
    };
  }
  const cur: Record<ConfigDriftField['field'], string> = {
    provider: current.provider,
    model: current.model,
    baseUrl: normalizeBaseUrl(current.baseUrl || ''),
    configHash: current.configHash,
  };
  const fields: ConfigDriftField[] = [];
  for (const f of ['provider', 'model', 'baseUrl', 'configHash'] as const) {
    if (snap[f] !== cur[f]) fields.push({ field: f, snapshot: snap[f], current: cur[f] });
  }
  if (!fields.length) {
    return {
      verified: true,
      drifted: false,
      snapshot,
      current,
      fields,
      message: `模型配置与 Run 快照一致 (${current.provider}/${current.model} @ ${current.baseUrl}, hash=${current.configHash})`,
    };
  }
  return {
    verified: true,
    drifted: true,
    snapshot,
    current,
    fields,
    message: `模型配置已偏离 Run 快照 — 快照: ${snapshot.provider}/${snapshot.model} @ ${normalizeBaseUrl(snapshot.baseUrl || '')} (hash=${snapshot.configHash}); 现在生效: ${current.provider}/${current.model} @ ${current.baseUrl} (hash=${current.configHash}); 变化的字段: ${fields.map((f) => f.field).join(', ')}`,
  };
}

/** 拿当前有效配置核对一份 Run 快照 (不写任何东西) */
export async function detectRunModelDrift(
  snapshot: RunModelConfig,
  sessionKey?: string,
): Promise<ConfigDriftReport> {
  let current: EffectiveModelConfig | null = null;
  try {
    current = await effectiveModelConfig({ sessionKey });
  } catch { current = null; }
  return compareRunModelConfig(snapshot, current);
}

/**
 * 从盘上读某个 Run 的快照再核对 (读不到 Run / 这个 Run 没快照 → `null`, 不编一份出来)。
 * 动态 import 记录层, 避免"记录层 ← 入口层"的双向静态依赖。
 */
export async function detectRunConfigDrift(runId: string, sessionKey?: string): Promise<ConfigDriftReport | null> {
  try {
    const store: any = await import('../agents/run-store.js');
    const rec = await store.readRun(runId);
    const snap = rec?.modelConfig as RunModelConfig | undefined;
    if (!snap) return null;
    return await detectRunModelDrift(snap, sessionKey);
  } catch {
    return null;
  }
}
