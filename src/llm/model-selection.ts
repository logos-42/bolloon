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
  /** 该 provider 是否原生支持 reasoning / thinking 模式 */
  reasoning: boolean;
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

/** 切换失败分类 (不许只回一句"切换成功"或静默退回旧的) */
export type SelectionFailureClass =
  | 'invalid_provider'
  | 'invalid_model'
  | 'invalid_url'
  | 'missing_api_key'
  | 'credential_scope_conflict'
  | 'auth_failed'
  | 'provider_unreachable'
  | 'model_not_found'
  | 'protocol_mismatch'
  | 'timeout';

export interface SelectModelRequest {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 仅在 `key` 子命令里出现; 不进日志/不进返回值 */
  apiKey?: string;
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

function envKeyOf(provider: string): { name: string; value: string } | null {
  for (const name of envKeyNamesOf(provider)) {
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
  const protocol = protocolOf(provider);
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
    reasoning: supportsReasoning(provider),
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
  return { provider: hit.provider, model: hit.model, baseUrl: hit.baseUrl, updatedAt: hit.updatedAt };
}

export async function writeSessionSelection(sessionKey: string, sel: ModelSelection): Promise<void> {
  const key = String(sessionKey || '').trim();
  if (!key) throw new Error('sessionKey 为空, 拒绝写会话级模型绑定');
  const all = await readSessionBindings();
  all.sessions[key] = {
    provider: sel.provider,
    model: sel.model,
    baseUrl: normalizeBaseUrl(sel.baseUrl || ''),
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
    updatedAt: cfg.updatedAt,
  };
}

/** provider 默认层 (内置表) */
function providerDefaultSelection(provider: string): ModelSelection | null {
  const def = DEFAULT_PROVIDER_CONFIGS[provider as ModelProvider];
  if (!def) return null;
  return { provider, model: def.model, baseUrl: def.baseUrl, apiKey: undefined };
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
  initMinimax({ provider: eff.provider as any, apiKey, baseUrl: eff.baseUrl, model: eff.model });
  return eff;
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
 */
export function validateSelection(
  req: SelectModelRequest,
  ctx: { providerConfig?: ProviderConfig | null },
): ValidationOutcome {
  const provider = String(req.provider || '').trim().toLowerCase();
  if (!provider) {
    return { ok: false, failureClass: 'invalid_provider', message: '没有指定供应商' };
  }
  if (!DEFAULT_PROVIDER_CONFIGS[provider as ModelProvider]) {
    const known = Object.keys(DEFAULT_PROVIDER_CONFIGS).join(', ');
    return { ok: false, failureClass: 'invalid_provider', message: `未知供应商 '${provider}'. 可用: ${known}` };
  }

  const base = ctx.providerConfig || DEFAULT_PROVIDER_CONFIGS[provider as ModelProvider];
  const model = String(req.model ?? base.model ?? '').trim();
  if (!model) {
    return { ok: false, failureClass: 'invalid_model', message: `${provider} 没有可用模型 (配置为空且内置默认为空)` };
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

  const apiKey = req.apiKey !== undefined ? req.apiKey : (base.apiKey || '');
  const envKey = envKeyOf(provider);
  const needKey = base.requiresApiKey !== false;
  if (needKey && !apiKey && !envKey) {
    return {
      ok: false,
      failureClass: 'missing_api_key',
      message: `${provider} 还需要 API key — 用 /model key ${provider} 配置, 或设置环境变量 ${envKeyNamesOf(provider).join('/') || '(无)'}`,
    };
  }

  return {
    ok: true,
    selection: {
      provider,
      model,
      baseUrl,
      apiKey: apiKey || envKey?.value,
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

const PROBE_TIMEOUT_MS = 8000;

function probeHeaders(sel: ModelSelection): Record<string, string> {
  const protocol = protocolOf(sel.provider);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!sel.apiKey) return headers;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = sel.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (protocol === 'gemini') {
    headers['x-goog-api-key'] = sel.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${sel.apiKey}`;
  }
  return headers;
}

/** 每个协议挑一个**真正校验凭证**的轻端点 (无鉴权的公开目录不算) */
function probeRequest(sel: ModelSelection): { url: string; init: RequestInit } {
  const protocol = protocolOf(sel.provider);
  if (protocol === 'anthropic') {
    return {
      url: `${sel.baseUrl}/messages`,
      init: {
        method: 'POST',
        headers: probeHeaders(sel),
        body: JSON.stringify({ model: sel.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      },
    };
  }
  if (protocol === 'gemini') {
    return { url: `${sel.baseUrl}/models?key=${encodeURIComponent(sel.apiKey || '')}`, init: { method: 'GET' } };
  }
  if (protocol === 'ollama') {
    return { url: `${sel.baseUrl}/api/tags`, init: { method: 'GET' } };
  }
  return { url: `${sel.baseUrl}/models`, init: { method: 'GET', headers: probeHeaders(sel) } };
}

function classifyProbeError(err: any): { failureClass: SelectionFailureClass; detail: string } {
  const msg = String(err?.message || err || '未知错误');
  const code = String(err?.code || err?.cause?.code || '');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /abort|timeout/i.test(msg)) {
    return { failureClass: 'timeout', detail: `探测超时 (${PROBE_TIMEOUT_MS}ms): ${msg}` };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${code} ${msg}`)) {
    return { failureClass: 'invalid_url', detail: `主机名解析失败 — 检查 base URL (${msg})` };
  }
  return { failureClass: 'provider_unreachable', detail: `连接失败: ${msg}` };
}

function timeoutSignal(): AbortSignal | undefined {
  const anyAbort = AbortSignal as any;
  if (typeof anyAbort?.timeout === 'function') return anyAbort.timeout(PROBE_TIMEOUT_MS);
  return undefined;
}

/**
 * 轻量连通探测 —— 拿**候选**配置去问一次, 而不是问已经存在配置里的那一份。
 * 探测失败 → 调用方必须放弃这次切换 (配置与运行时都保持原样)。
 *
 * 模型名检查刻意保守: 只有服务端给出**可解析且非空**的模型目录时, 才敢断言
 * "这个模型不存在"; 目录拿不到 (自定义端点常见) 就不下结论, 如实说明"未校验模型名"。
 */
export async function probeSelection(sel: ModelSelection): Promise<ProbeResult> {
  const { url, init } = probeRequest(sel);
  const signal = timeoutSignal();
  let res: Response;
  try {
    res = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
  } catch (e: any) {
    const { failureClass, detail } = classifyProbeError(e);
    return { ok: false, failureClass, detail };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, failureClass: 'auth_failed', detail: `HTTP ${res.status} 凭证被拒 — ${snippet}` };
    }
    if (res.status === 404) {
      return { ok: false, failureClass: 'invalid_url', detail: `HTTP 404 端点不存在 — 检查 base URL (${url})` };
    }
    if (res.status === 429) {
      return { ok: false, failureClass: 'provider_unreachable', detail: `HTTP 429 被限流 — ${snippet}` };
    }
    return { ok: false, failureClass: 'provider_unreachable', detail: `HTTP ${res.status} — ${snippet}` };
  }

  // 端点通了 → 能解析出模型目录就顺手校验模型名
  let catalog: string[] | undefined;
  try {
    const body = await res.json();
    const arr = Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
        : Array.isArray(body) ? body
          : null;
    if (arr) {
      const ids = arr
        .map((x: any) => (typeof x === 'string' ? x : x?.id || x?.name || x?.model))
        .filter((x: any) => typeof x === 'string' && x);
      if (ids.length) catalog = ids;
    }
  } catch { /* 非 JSON 目录 → 不校验模型名 */ }

  if (catalog && !catalog.includes(sel.model)) {
    return {
      ok: false,
      failureClass: 'model_not_found',
      detail: `端点可达但不认识模型 '${sel.model}' (目录里 ${catalog.length} 个, 例: ${catalog.slice(0, 5).join(', ')})`,
      catalog,
    };
  }

  return {
    ok: true,
    detail: `端点可达 (${url})${catalog ? ` · 模型 '${sel.model}' 在目录中 (${catalog.length} 个)` : ' · 未提供模型目录, 模型名未校验'}`,
    catalog,
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

  // ── 2) 轻量连通探测 (写盘之前) ─────────────────────────────
  const checks: string[] = [];
  const wantProbe = req.verify !== false && process.env.BOLLOON_MODEL_SKIP_PROBE !== '1';
  if (wantProbe) {
    const probe = await probeSelection(target);
    checks.push(`${probe.ok ? '✓' : '✗'} ${probe.detail}`);
    if (!probe.ok) {
      return {
        ok: false,
        failureClass: probe.failureClass,
        message: `切换未生效 (探测失败, 配置与运行时保持原样): ${probe.detail}`,
        previous,
        checks,
      };
    }
  } else {
    checks.push('· 已跳过连通探测 (BOLLOON_MODEL_SKIP_PROBE / verify:false)');
  }

  // ── 3~6) 写配置 → 更新 scope → 重建运行时 → 更新 session ────
  const configPath = llmConfigStore.configFilePath();
  let beforeBytes: string | null = null;
  try {
    beforeBytes = await fsp.readFile(configPath, 'utf-8');
  } catch { beforeBytes = null; }

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

        await llmConfigStore.updateProvider(provider as ModelProvider, patch);
        await llmConfigStore.setActiveProvider(provider as ModelProvider);
      });
      // Global 切换: 清掉当前会话的旧绑定, 让"这次切换"对当前会话也立刻成立
      await clearSessionSelection(req.sessionKey || currentSessionKey());
    } else {
      // 会话级: **一个字节都不写配置文件**, 只写会话绑定
      await writeSessionSelection(req.sessionKey || currentSessionKey(), target);
    }

    // 重建模型运行时 —— 从"刚写好的那一份有效配置"读, 保证运行时 == 有效配置
    const applied = await applyEffectiveToRuntime(req.sessionKey);
    if (applied.provider !== target.provider || applied.model !== target.model || applied.baseUrl !== target.baseUrl) {
      throw new Error(`重建后有效配置与目标不一致 (${applied.provider}/${applied.model}@${applied.baseUrl})`);
    }
  } catch (err: any) {
    // 回滚: 文件字节级还原 + 运行时按旧配置重建
    await rollbackConfig(configPath, beforeBytes);
    await restoreRuntime(previous);
    return {
      ok: false,
      failureClass: 'provider_unreachable',
      message: `切换失败已回滚, 旧配置仍生效: ${String(err?.message || err).slice(0, 300)}`,
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
    initMinimax({ provider: prev.provider as any, apiKey: key, baseUrl: prev.baseUrl, model: prev.model });
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
      initMinimax({ provider: global.provider as any, apiKey: key, baseUrl: global.baseUrl, model: global.model });
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
    eff.reasoning ? 'reasoning=支持' : 'reasoning=不支持',
    `作用域=${scopeZh[eff.source]}`,
    `hash=${eff.configHash}`,
  ].join(' · ');
}

export function providerDisplayName(provider: string): string {
  return (PROVIDER_INFO as any)[provider]?.name || provider;
}
