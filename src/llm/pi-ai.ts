import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { request, Agent } from 'undici';
import { sanitizeToolsForApi } from './tool-name.js';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'gemini' | 'minimax' | 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'mimo' | 'grok' | 'local';

/**
 * 2026-09-28 (前缀 KV 可命中): pi-ai 侧能接受的**声明 provider** = 内置那 13 家 + `llamacpp`.
 *
 * `llamacpp` = 本地 llama.cpp / llama-server 的 OpenAI 兼容端点 (`http://localhost:8080/v1`),
 * 它**不在**内置表与 P3 注册表里 —— 那两张表是「内置 13 家」的冻结面 (源码级门逐项钉着,
 * 见 `src/test/provider-registry.test.ts`: 路由表里收得到原生 tools 的分支集合必须与注册表声明双向相等)。
 * 所以它按本仓既有的「**声明 id ≠ 协议分支**」架构接: 声明 id `llamacpp` → 跑 `openai` 协议分支
 * (与 `provider-registry.runtimeProviderIdOf` 对自定义供应商做的事一模一样), baseUrl/model/key
 * 各有自己的默认与 env。工具调用因此走的是 openai 那条已经验证过的路, 不需要第 14 条分支。
 */
export type PiAIProvider = ModelProvider | 'llamacpp';

/** 本地 llama.cpp 的声明 id / 默认端点 / 默认模型名 (都能被 env 或显式 config 覆盖) */
export const LLAMACPP_PROVIDER_ID = 'llamacpp';
export const LLAMACPP_DEFAULT_BASE_URL = 'http://localhost:8080/v1';
export const LLAMACPP_DEFAULT_MODEL = 'local';

/**
 * 2026-09-28: 请求用途 —— 决定「走完整前缀还是轻量前缀」「要不要带 cache_prompt」。
 *
 * 为什么需要这个维度 (leo 的原话: "里边的 P2P 的请求, 携带了 system prompt, 可以换成轻量的请求"):
 *   - 本地 llama.cpp 常见是 `-np 1` (单 slot): 同时只有一条 prompt 的 KV 能留在 slot 里。
 *     summarize / auto-compact / improve / health 探针 / 社交心跳 / 判断力评估这些**非主对话**请求
 *     若也带完整 system 前缀 (十几 K) + 工具全集, 会把 slot 0 顶掉 → 主对话下一轮整段重算
 *     (这就是"缓存无法命中"的第二层根因)。
 *   - 处置: **只有 `main-agent` 走完整前缀 + 工具全集 + CURRENT TURN 动态区**; 其余一律轻量
 *     (短 system、不带工具全集、不带 CURRENT TURN), 既不为一次性探针付大前缀, 也不抢 slot。
 */
export type ChatPurpose =
  | 'main-agent'    // 主 agent 推理 (ReAct / pivot loop) —— 唯一的重路径
  | 'summarize'
  | 'improve'
  | 'auto-compact'
  | 'social'        // 社交心跳决策
  | 'health'        // 健康探针
  | 'p2p'           // P2P 协作请求
  | 'cron'          // 定时任务的一次性调用
  | 'judgment'      // 判断力评估/审计
  | 'probe'         // 能力探测
  | 'chat';         // 其他一次性调用 (缺省)

/** 唯一的重路径用途 */
export const MAIN_AGENT_PURPOSE: ChatPurpose = 'main-agent';

/** 轻量前缀的 system 上限 (字符). 只对**自动装配部分 + 调用方自带短提示**做兜底截断, 正常调用远低于它 */
export const LIGHTWEIGHT_SYSTEM_MAX_CHARS = 2000;

/**
 * 这条请求走不走轻量前缀. **只有 `main-agent` 是重路径** —— 其余 (含没写 purpose 的老调用方)
 * 一律轻量: 未知用途名按轻量处理 (宁可少给前缀, 也不让探针抢掉主对话的 KV slot).
 */
export function isLightweightPurpose(purpose?: string): boolean {
  return (purpose || 'chat') !== MAIN_AGENT_PURPOSE;
}

/**
 * 要不要在请求体里带 `cache_prompt` (llama.cpp 的前缀 KV 复用开关).
 *
 * **仅 `main-agent` 为 true**; `BOLLOON_DISABLE_CACHE_PROMPT=1` 彻底关 (含主对话).
 * 纯函数: 门可以逐 purpose 断言, 不需要发请求.
 */
export function shouldUseCachePrompt(purpose?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BOLLOON_DISABLE_CACHE_PROMPT === '1') return false;
  return (purpose || 'chat') === MAIN_AGENT_PURPOSE;
}

/** 本机 endpoint 判定 (`cache_prompt` 是自建服务的扩展字段, 云端不认 —— 只在本机才带) */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

/**
 * CURRENT TURN 动态区的标记 —— 注入幂等的唯一判据 (已含标记 → 跳过, 不重复注入、不追加多余 user 消息).
 * 名字里的 runtime/git/p2p 就是这一区的三类内容: 运行时状态 / git 状态 / P2P reserve.
 */
export const CURRENT_TURN_MARKER = '<!-- current-turn: runtime/git/p2p -->';

/** CURRENT TURN 区块自身的预算 (字符) —— 防止动态区反过来把用户原话挤出上层的历史窗口 */
export const CURRENT_TURN_BUDGET_CHARS = 2400;

/**
 * 按预算组装 CURRENT TURN 区块 (**从后往前**填: 越靠后的段越优先保住).
 *
 * 为什么是"从后往前": 段落顺序是 `registry 动态层 → P2P reserve → 调用方易变段(循环进度/改进提示)`,
 *   最后那段是**最可操作**的指令 (循环进度丢了 LLM 会重复劳动); 而 registry 动态层与 system 里的
 *   项目上下文高度重复, 被截掉损失最小. 所以超预算时先压前面的段.
 */
export function assembleCurrentTurn(parts: string[], budget: number = CURRENT_TURN_BUDGET_CHARS): string {
  const kept: string[] = [];
  let used = 0;
  let dropped = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = String(parts[i] ?? '').trim();
    if (!p) continue;
    const remain = budget - used;
    if (remain < 50) { dropped = true; continue; }
    if (p.length <= remain) { kept.unshift(p); used += p.length; }
    else { kept.unshift(`${p.slice(0, remain)}\n[… CURRENT TURN 超预算截断]`); used = budget; }
  }
  if (dropped) kept.unshift('[… CURRENT TURN 区块超预算: 靠前的段被丢弃]');
  return kept.join('\n\n');
}

/** 系统提示词装配缓存的 TTL (10 分钟) */
export const SYSTEM_PROMPT_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 2026-09-28: `canonicalizeJson` — 递归对**对象 key 排序**, **数组保序**.
 *
 * 为什么: 工具 schema (`parameters.properties` / 嵌套对象) 的 key 顺序若由调用方动态生成,
 * 每轮可能不同; 语义相同但 JSON.stringify 出的字节不同 → chat template 渲染出的 token 前缀
 * 不同 → 服务端前缀 KV 命中失败. 规范化后同一份 schema 永远序列化成同一个字符串.
 */
export function canonicalizeJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalizeJson);   // 数组有序语义, 保序
  if (value && typeof value === 'object') {
    const sorted: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalizeJson(value[k]);
    return sorted;
  }
  return value;
}

/**
 * 2026-09-28: 工具定义规范化 —— 递归 key 排序 + **按 `function.name` 排序**.
 *
 * 跨轮前缀稳定前提: 工具集合相同, 但顺序不同 (`read,write,grep` vs `read,grep,write`) 或
 * schema 内 key 顺序不同, 都会让 token 前缀断裂. 这里把两种抖动都消掉.
 */
export function canonicalizeTools<T = any>(tools: T[]): T[] {
  if (!Array.isArray(tools)) return tools;
  return tools
    .map((t) => canonicalizeJson(t) as T)
    .sort((a: any, b: any) =>
      String(a?.function?.name || '').localeCompare(String(b?.function?.name || ''))
    );
}

/** 运行前缀哈希序列 (逐消息累积, sha256[:12]) —— 诊断用, 只出 hash 不出内容 */
export function prefixHashes(wire: Array<{ role: string; content?: string }>): string[] {
  const out: string[] = [];
  let acc = '';
  for (const m of wire) {
    acc += JSON.stringify({ role: m?.role, content: m?.content ?? '' });
    out.push(createHash('sha256').update(acc).digest('hex').slice(0, 12));
  }
  return out;
}

/** 工具面的 hash (诊断用, 只出 hash) */
export function toolsHashOf(tools: any[] | undefined): string {
  if (!tools || tools.length === 0) return '-';
  // 先规范化再 hash: 这个数字回答的是"**上到线上的那份** tools 段变了吗", 而不是"调用方这次传的顺序变了吗"
  return createHash('sha256').update(JSON.stringify(canonicalizeTools(tools))).digest('hex').slice(0, 12);
}

export interface ChatUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/**
 * 从响应里取用量 (只取数字, 出处逐条可指认):
 *   - OpenAI/DeepSeek: `usage.prompt_tokens_details.cached_tokens` / `usage.prompt_tokens`;
 *   - llama.cpp: `timings.cache_n` (复用的 token 数) / `timings.prompt_n`.
 */
export function extractUsage(data: any): ChatUsage {
  const t = data?.timings || {};
  return {
    promptTokens: Number(data?.usage?.prompt_tokens ?? t.prompt_n ?? 0) || 0,
    cachedTokens: Number(data?.usage?.prompt_tokens_details?.cached_tokens ?? data?.usage?.prompt_cache_hit_tokens ?? t.cache_n ?? 0) || 0,
    completionTokens: Number(data?.usage?.completion_tokens ?? t.predicted_n ?? 0) || 0,
  };
}

/** `[kv-server]` 诊断行 (纯函数: 只拼数字与百分比, 门可以断言形状) */
export function formatKvServerLine(purpose: string, usage: ChatUsage, opts: { stream?: boolean } = {}): string {
  const hit = usage.promptTokens > 0 ? `${((usage.cachedTokens / usage.promptTokens) * 100).toFixed(1)}%` : '?';
  return `[kv-server] purpose=${purpose}${opts.stream ? ' stream' : ''} cached=${usage.cachedTokens} prompt=${usage.promptTokens} hit=${hit}`;
}

/**
 * 把动态区注入「最后一条 user 消息」前部 (CURRENT TURN 区), **原地改**.
 *
 * 幂等: 目标消息已含 `CURRENT_TURN_MARKER` → 跳过 (多 iteration / 重试 / 重复调用都不重复注入).
 * 位置: 只找最后一条 user (= 当前轮), 不碰 assistant/tool —— 往那些注入会污染历史;
 *   整段没有 user → 返回 `no-user-message` 交给调用方决定 (chat() 会明确追加一条, 绝不写回 system).
 */
export function injectCurrentTurn(
  messages: Array<{ role: string; content: string }>,
  dynamicText: string
): { injected: boolean; index: number; reason: 'injected' | 'already' | 'no-dynamic-text' | 'no-user-message' } {
  if (!dynamicText || !dynamicText.trim()) return { injected: false, index: -1, reason: 'no-dynamic-text' };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string' && m.content.includes(CURRENT_TURN_MARKER)) {
      return { injected: false, index: i, reason: 'already' };
    }
    const body = dynamicText.length > CURRENT_TURN_BUDGET_CHARS + 400
      ? `${dynamicText.slice(0, CURRENT_TURN_BUDGET_CHARS + 400)}\n[… CURRENT TURN 区块超预算截断]`
      : dynamicText;
    m.content = `${CURRENT_TURN_MARKER}\n${body}\n\n---\n\n${m.content ?? ''}`;
    return { injected: true, index: i, reason: 'injected' };
  }
  return { injected: false, index: -1, reason: 'no-user-message' };
}

/** 用途 → 中文名 (轻量前缀里给人看的那一行, 也是日志口径) */
const PURPOSE_ZH: Record<string, string> = {
  'main-agent': '主对话',
  summarize: '摘要',
  improve: '文档改进',
  'auto-compact': '上下文压缩',
  social: '社交心跳',
  health: '健康探针',
  p2p: 'P2P 协作',
  cron: '定时任务',
  judgment: '判断力评估',
  probe: '能力探测',
  chat: '一次性调用',
};

/**
 * 轻量 system —— 非主对话请求用. 结构:
 *   `<一行身份/用途说明>` + (调用方自带的短提示原样保留)
 * **不带**完整 IMMUTABLE PREFIX (layer 装配) / 工具全集 / CURRENT TURN 动态区.
 * 调用方自带提示超上限时截断 (并写明截断), 避免一次性探针把大前缀带出去.
 */
export function buildLightweightSystem(purpose: string, source?: string, callerSystem?: string): string {
  const head = `你是 Bolloon Agent 的轻量调用助手 (用途: ${PURPOSE_ZH[purpose] || purpose}${source ? ` · 来源: ${source}` : ''})。只完成下面这一件事, 直接输出结果; 不要调用工具。`;
  const caller = String(callerSystem || '').trim();
  if (!caller) return head;
  const capped = caller.length > LIGHTWEIGHT_SYSTEM_MAX_CHARS
    ? `${caller.slice(0, LIGHTWEIGHT_SYSTEM_MAX_CHARS)}\n[… 轻量请求 system 超上限截断]`
    : caller;
  return `${head}\n\n${capped}`;
}

/**
 * 2026-09-28: 把装配好的系统提示词按 layer 标记拆成「稳定段」与「动态段」.
 *
 * 动态段 = registry 里 `source === 'function'` 的那几层 (本仓目前只有 `dynamic.project-context`:
 *   它会随 cwd / git 状态变化). 这几层从 system 里移出 → system 逐字节稳定 → 服务端前缀 KV 能复用.
 *
 * 拆法: 装配器给每层写了 `<!-- id@version -->` 头 (见 system-prompt/registry.ts),
 *   按这些标记切块; 标记之间的内容归它前面那个 id. 找不到任何标记 → 整段算稳定段 (不抛错).
 */
export function splitLayerBlocks(
  text: string,
  dynamicIds: ReadonlySet<string>
): { stableText: string; dynamicText: string } {
  const re = /<!--\s*([A-Za-z0-9_.\-]+)@([A-Za-z0-9_.\-]+)\s*-->/g;
  const marks: Array<{ id: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) marks.push({ id: m[1], start: m.index, end: m.index + m[0].length });
  if (marks.length === 0) return { stableText: text.trim(), dynamicText: '' };

  const stable: string[] = [];
  const dynamic: string[] = [];
  const head = text.slice(0, marks[0].start).trim();
  if (head) stable.push(head);
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const content = text.slice(from, to).trim();
    (dynamicIds.has(marks[i].id) ? dynamic : stable).push(content);
  }
  return {
    stableText: stable.filter(Boolean).join('\n\n').trim(),
    dynamicText: dynamic.filter(Boolean).join('\n\n').trim(),
  };
}


export interface ModelConfig {
  provider: ModelProvider;
  /**
   * **声明的 provider id** (P3 注册表里的那个 id)。内置供应商 == `provider`; 自定义供应商则是它自己的
   * 名字 (`stub-gw`), 而 `provider` 是它在运行期接上的**协议分支** (`openai`/`anthropic`/…)。
   *
   * 为什么两个都要: 协议分支决定走哪条出网代码, 而**鉴权头**只有按声明 id 查注册表才拿得到
   * (自定义供应商可以声明自己的 `authHeader`)。缺省 = 用 `provider`, 于是老调用方行为一字不变。
   */
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /**
   * 2026-09-28: 这个分支**允许空 apiKey** (本地自建服务: llama.cpp / ollama 一类)。
   *   true 时 `callOpenAI` 不再因缺 key 抛错, 且无 key 就不带 `Authorization` 头
   *   (之前空 key 会发出 `Bearer ` —— 本地服务虽然多半不看, 但那是脏请求头)。
   *   缺省 false → 云端分支的老行为一字不变。
   */
  allowEmptyKey?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 2026-09-15: 思考模式 provider (deepseek) 要求 assistant 消息回带 reasoning_content, 见 prepareWireMessages */
  reasoningContent?: string;
}

export interface ChatResult {
  reply: string;
  /** 2026-09-15: 思考模型返回的思维链原文 (deepseek 等). 上层存进 history, 下一轮原样回带. */
  reasoningContent?: string;
  /** 2026-06-30: OpenAI 协议 native tool_calls 数组 (minimax/M3 返回)
   *  每个 tool_call 包含 id/type/function.name/function.arguments
   *  bolloon 用来给后续 tool result 提供 tool_call_id 引用 */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string; // JSON string
    };
  }>;
  /**
   * 2026-09-28 (前缀 KV 可命中): 回带**最终 wire messages** (含注入到当前轮 user 消息前部的
   * CURRENT TURN 动态区)。
   *
   * 根因: 动态区 (project-context / P2P reserve) 只活在 chat() 内部那一份 messages 里,
   *   调用方自己那份 history (如 pi-sdk 的 `messageHistory`, 每轮由 buildMessages() 重建全新对象)
   *   若不同步, 下一轮前缀从那条 user 消息起就失配:
   *     第 1 次: S H [D1 U1]          第 2 次: S H U1 U2      ← U1 丢了 D1
   *   正确应当是: 第 2 次 = S H [D1 U1] U2 (D1 成为 U1 的一部分, 成为后续轮的稳定前缀)。
   * 处置: chat() 既原地写回调用方传进来的数组, 也在这里回带最终 wire messages ——
   *   持独立历史存储的调用方 (pi-sdk) 必须据此把最后一条 user 的 content 写回自身 history。
   */
  messages?: ChatMessage[];
  /** 2026-09-28: 服务端回传的用量 (诊断 KV 命中率用; 只有数字) */
  usage?: ChatUsage;
}

export interface SummarizeResult {
  summary: string;
  qualityScore: number;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 工具 id 列表 — 代码侧 (src/llm/tool-manifest/) 查 schema, prompt 里只嵌 oneLine + callExample */
  tools?: string[] | any[];
  /** 2026-09-28: 流式输出回调 — 传入时走 SSE (`stream: true` + `stream_options.include_usage`),
   *  每收到一段 content delta 调一次。非 OpenAI 兼容分支忽略它 (退化为整段返回)。 */
  onToken?: (delta: string) => void;
  /** 2026-09-28: 调用用途 — 决定轻量/完整前缀与 cache_prompt (见 ChatPurpose) */
  purpose?: string;
  /** 2026-09-28: 调用来源粗分类 (health/social/p2p/cron/cli/web), 只进日志与轻量 system 的一行说明 */
  source?: string;
}

/**
 * 外部 system 注入钩子.
 * 调用方 (e.g. auto-evolve-loop) 用 setSystemPrependProvider() 注册一个返回字符串的函数,
 * chat() 在拼好 messages 后, 把返回的字符串作为 **CURRENT TURN 动态区**的一部分, 注入到最后一条
 * user 消息前部 (位于 IMMUTABLE PREFIX + CONVERSATION HISTORY 之后)。
 *
 * 用途: P2P 协作时把"行级 reserve 状态"实时塞给 LLM,
 *       让 LLM 主动避开对方正在改的代码行.
 *
 * ⚠️ 2026-09-28: 只在 chat() 路径生效 (只注入主对话的当前轮), 不进 system ——
 *   这份 reserve 状态每轮都在变, 写回 system 就等于把 IMMUTABLE PREFIX 打碎, 前缀 KV 永远 miss。
 *   summarize/improve 这类一次性请求也不再注入它 (不污染探针的 prompt 前缀)。
 *
 * 返回 '' / null / undefined → 不注入.
 */
let _prependProvider: (() => string | null | undefined | Promise<string | null | undefined>) | null = null;
export function setSystemPrependProvider(
  p: (() => string | null | undefined | Promise<string | null | undefined>) | null
): void {
  _prependProvider = p;
}
export function getSystemPrependProvider(): typeof _prependProvider {
  return _prependProvider;
}

/**
 * 2026-09-28 (前缀 KV 可命中): 系统提示词装配缓存 (进程内)。
 *
 * 背景: 旧实现每轮 chat 都跑一遍 `assembleSystemPrompt` (25 次 fs.readFile + 装配),
 *   这就是用户看到的"发对话都要再加载提示词"。更关键的是要给服务端前缀 KV 留出**逐字节一致**的前缀 ——
 *   每轮重新装配且内容有微差 (动态层 git 状态 / 时间), 前缀就失配, KV 永远用不上。
 *
 * 处置: 最终装配结果按 working dir 缓存 (TTL 10 分钟) + 拆成 `stableText` / `dynamicText`:
 *   - `stableText` 进 system (逐字节稳定, 命中前缀 KV);
 *   - `dynamicText` (registry 里 source==='function' 的层) 由 chat() 注入 CURRENT TURN 区。
 * 配置/provider 真变化 (initPiAI 指纹变了) 时清空, 避免拿到陈旧提示词。
 *
 * ⚠️ 这是**应用层缓存**, 与 llama.cpp 的 KV cache 是两层完全不同的东西: 它只省掉重复装配,
 *   真正的 KV 复用还要求 wire messages + tools 渲染出的 token 前缀与 slot 里已有 KV 一致。
 */
interface SystemPromptCacheEntry {
  key: string;
  stableText: string;
  dynamicText: string;
  layerIds: string[];
  at: number;
}
let _systemPromptCache: SystemPromptCacheEntry | null = null;

/** 清空系统提示词缓存 (配置/provider 变更、layer 文件热更时调用) */
export function clearSystemPromptCache(): void {
  _systemPromptCache = null;
}

/** 诊断/门用: 缓存条目的 key 与写入时间 (**只给数字与键名, 不给内容**) */
export function systemPromptCacheStamp(): { key: string; at: number } | null {
  return _systemPromptCache ? { key: _systemPromptCache.key, at: _systemPromptCache.at } : null;
}

/** 诊断/门用: 稳定段的 sha256[:12] (不是内容) —— 门用它断言 system 段跨轮逐字节稳定 */
export function systemPromptStableHash(): string | null {
  if (!_systemPromptCache) return null;
  return createHash('sha256').update(_systemPromptCache.stableText).digest('hex').slice(0, 12);
}

/** DEBUG_PROMPT_PREFIX=1 时逐消息打前缀哈希用; 记上一轮, 好报"第几条开始分叉" */
let _lastPrefixHashes: string[] = [];

/**
 * 2026-09-28 诊断 (只打数字与 hash, 不打内容也不打 key):
 *   `[kv-debug] msg=i role=… prefixHash=… chars=…` 逐消息的**累积前缀**哈希
 *   `[kv-debug] tools count=… hash=…`
 *   `[kv-debug] 对比: 与上一次请求在第 N 条分叉 / 前缀逐条一致`
 * ⚠️ 这是 HTTP JSON 层的前缀哈希, 不是 chat template 渲染后的 token 前缀哈希;
 *   用途是快速定位"应用层 messages 前缀在哪一条断裂", 缩小排查范围。
 */
function debugDumpPromptPrefix(wire: Array<{ role: string; content?: string }>, tools: any[] | undefined): void {
  const hashes = prefixHashes(wire);
  let chars = 0;
  for (let i = 0; i < wire.length; i++) {
    chars += JSON.stringify({ role: wire[i]?.role, content: wire[i]?.content ?? '' }).length;
    console.log(`[kv-debug] msg=${i} role=${wire[i]?.role} prefixHash=${hashes[i]} chars=${chars}`);
  }
  console.log(`[kv-debug] tools count=${tools?.length ?? 0} hash=${toolsHashOf(tools)}`);
  if (_lastPrefixHashes.length > 0) {
    let diverged = -1;
    const n = Math.max(hashes.length, _lastPrefixHashes.length);
    for (let i = 0; i < n; i++) {
      if (hashes[i] !== _lastPrefixHashes[i]) { diverged = i; break; }
    }
    if (diverged < 0) console.log(`[kv-debug] 对比上一次请求: 前缀逐条一致 (共 ${hashes.length} 条)`);
    else console.log(`[kv-debug] 对比上一次请求: 第 ${diverged} 条起分叉 (上一次 ${_lastPrefixHashes.length} 条 → 本次 ${hashes.length} 条)`);
  }
  _lastPrefixHashes = hashes;
}

/**
 * BOLLOON_PROMPT_PROFILE=1 时每次调用打一行 prompt 分部体积 (**只打数字与 hash**),
 * 用来回答"这次请求到底是哪一段在膨胀 / 哪一段在抖动"。
 */
function logPromptProfile(info: {
  purpose: string; source?: string; profile: 'full' | 'light';
  stableChars: number; dynamicChars: number; historyChars: number;
  messageCount: number; toolsCount: number; toolsHash: string; cached: boolean;
}): void {
  if (process.env.BOLLOON_PROMPT_PROFILE !== '1') return;
  console.log(
    `[prompt-profile] purpose=${info.purpose} source=${info.source || '-'} profile=${info.profile}` +
    ` systemCache=${info.cached ? 'hit' : 'miss'} stable=${info.stableChars} dynamic=${info.dynamicChars}` +
    ` history=${info.historyChars} msgs=${info.messageCount} tools=${info.toolsCount} toolsHash=${info.toolsHash}`
  );
}


export class PiAIModel {
  private config: ModelConfig;
  private provider: ModelProvider;
  /** 单次 LLM HTTP 请求硬上限 (ms), 防止上游卡住挂死整个 loop. 可通过 BOLLOON_LLM_TIMEOUT 覆盖. */
  private requestTimeoutMs: number;

  constructor(config: ModelConfig) {
    this.config = config;
    this.provider = config.provider;
    const envTimeout = Number(process.env.BOLLOON_LLM_TIMEOUT);
    this.requestTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000;
  }

  /**
   * 把外部 signal 和内部 timeout 合并: 任一触发都 abort.
   * - 外部 signal 优先 (用户主动 abort)
   * - 否则套 120s timeout
   * - 任一不合法 (非 AbortSignal 实例) 时退到无 signal
   */
  private combinedSignal(external?: AbortSignal): AbortSignal | undefined {
    const valid = external instanceof AbortSignal ? external : undefined;
    // Node 18+ 支持 AbortSignal.timeout, 旧版本兜底用 setTimeout 构造
    if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
      const timeoutSignal = (AbortSignal as any).timeout(this.requestTimeoutMs);
      if (!valid) return timeoutSignal;
      // 合并两个 signal
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      valid.addEventListener('abort', onAbort, { once: true });
      timeoutSignal.addEventListener('abort', onAbort, { once: true });
      if (valid.aborted || timeoutSignal.aborted) ctrl.abort();
      return ctrl.signal;
    }
    return valid;
  }

  /**
   * 按**注册表**取这条 provider 的认证头与 query (P3 注册表是唯一出处)。
   *
   * `providerId` (声明 id) 优先于运行期分支 id —— 自定义供应商的 `authHeader` 只有按声明 id 才查得到。
   * 拿不到 (模块不可用 / 这个 id 不在注册表里) → 返回 `null`, 各分支**退回自己的旧内置常量**,
   * 于是内置供应商的请求头一字不变 (门禁 `scripts/verify-model-wiring.ts` 逐分支比对真收到的头)。
   */
  private async registryAuth(): Promise<{
    headers: Record<string, string>;
    query: Record<string, string>;
    authKind: string;
    entryKind: string;
  } | null> {
    const declared = String(this.config.providerId || this.provider || '').trim();
    if (!declared) return null;
    try {
      const reg: any = await import('./provider-registry.js');
      const entry = reg.getProviderRegistryEntry(declared);
      if (!entry) return null;
      const auth = reg.authHeadersFor(entry, this.getApiKey());
      return {
        headers: (auth && auth.headers) || {},
        query: (auth && auth.query) || {},
        authKind: String(entry.auth && entry.auth.kind || 'none'),
        entryKind: String(entry.kind || ''),
      };
    } catch { return null; }
  }

  /**
   * 与 LLM 对话.
   *
   * 支持三种调用形式:
   *   - 旧: chat(message: string, context?: string, signal?)
   *       单一 user message + 附加 system context. 简单场景用.
   *   - 新: chat(messages: ChatMessage[], context?: string, signal?)
   *       完整 messages 数组, 含 user/assistant/tool/system role.
   *       工具调用场景必用 — 否则 LLM 看不到工具结果.
   *   - pivot loop 兼容: chat(context: string, systemPrompt: string, signal?)
   *       第二参超过 2K 时视为 system prompt 覆盖, 避免把 46K context 当 user message 发送.
   *
   * 2026-06-17 (M3.5 调试): buildContext() 之前把所有 history 序列化成单字符串,
   *   LLM 看不到 tool 调用的真实结果,导致 CLI loop 卡死.
   *   现在 messages 数组版本保留 role 语义, LLM 能正确看到工具返回.
   */
  /**
   * ⚠️ 参数顺序 (2026-09-28 起): `(messages, system, signal?, tools?, purpose?, source?, onToken?, currentTurnContext?)`
   *   - `purpose` 决定重/轻前缀与 cache_prompt (只有 'main-agent' 是重路径);
   *   - `currentTurnContext` = 调用方自己的**当前轮易变段** (如 pi-sdk 的循环进度/改进提示):
   *     它进 CURRENT TURN 动态区, **绝不进 system** —— 每轮都在变的东西放 system 会把
   *     IMMUTABLE PREFIX 打碎, 服务端前缀 KV 就永远命不中 (文本一字未改, 只换位置).
   */
  async chat(
    messageOrMessages: string | ChatMessage[],
    contextOrSystemPrompt?: string,
    signal?: AbortSignal,
    tools?: string[] | any[],
    purpose?: ChatPurpose,
    source?: string,
    onToken?: (delta: string) => void,
    currentTurnContext?: string
  ): Promise<ChatResult> {
    const _purpose = purpose || 'chat';
    const light = isLightweightPurpose(_purpose);
    const callerArr = Array.isArray(messageOrMessages) ? messageOrMessages : null;

    let messages: ChatMessage[];
    /** CURRENT TURN 动态区内容 (registry 的 function 层 + P2P reserve); 轻量请求不带 */
    const currentTurnParts: string[] = [];
    let stableChars = 0;
    let systemCacheHit = false;

    if (light) {
      // ── 轻量路径 (2026-09-28): 非主对话请求不带完整 IMMUTABLE PREFIX / 工具全集 / CURRENT TURN ──
      // 目的 (leo): 本地单 slot 服务上, 探针/摘要/心跳不该把主对话的 KV 顶掉, 也不该为一次性调用付大前缀.
      const lightSystem = buildLightweightSystem(_purpose, source, contextOrSystemPrompt);
      stableChars = lightSystem.length;
      messages = callerArr
        ? [{ role: 'system', content: lightSystem }, ...callerArr]
        : [{ role: 'system', content: lightSystem }, { role: 'user', content: messageOrMessages as string }];
      if (tools && tools.length > 0) {
        // 不静默丢: 打一行数字, 让"为什么工具没被调用"可诊断
        console.warn(`[pi-ai] 轻量请求丢弃工具集 (purpose=${_purpose}, tools=${tools.length}) —— 需要工具请用 purpose='main-agent'`);
        tools = undefined;
      }
    } else if (Array.isArray(messageOrMessages)) {
      if (contextOrSystemPrompt && contextOrSystemPrompt.length > 2000) {
        // pivot loop 兼容: 第二参 >2K = system prompt 覆盖 → 接在稳定段之后 (**仍在 system 里, 位置与旧版一致**:
        //   旧版 = 装配文本 + '\n\n' + 覆盖文本). 只有 registry 的动态层被移出 system.
        const parts = await this.buildSystemPromptParts(undefined);
        systemCacheHit = parts.cached;
        stableChars = parts.stableText.length + contextOrSystemPrompt.length;
        if (parts.dynamicText) currentTurnParts.push(parts.dynamicText);
        messages = [
          { role: 'system', content: `${parts.stableText}\n\n${contextOrSystemPrompt}` },
          ...messageOrMessages
        ];
      } else {
        const parts = await this.buildSystemPromptParts(contextOrSystemPrompt);
        systemCacheHit = parts.cached;
        stableChars = parts.stableText.length;
        if (parts.dynamicText) currentTurnParts.push(parts.dynamicText);
        messages = [{ role: 'system', content: parts.stableText }, ...messageOrMessages];
      }
    } else if (contextOrSystemPrompt && contextOrSystemPrompt.length > 2000) {
      const parts = await this.buildSystemPromptParts(undefined);
      systemCacheHit = parts.cached;
      stableChars = parts.stableText.length + contextOrSystemPrompt.length;
      if (parts.dynamicText) currentTurnParts.push(parts.dynamicText);
      messages = [
        { role: 'system', content: `${parts.stableText}\n\n${contextOrSystemPrompt}` },
        { role: 'user', content: messageOrMessages }
      ];
    } else {
      const parts = await this.buildSystemPromptParts(contextOrSystemPrompt);
      systemCacheHit = parts.cached;
      stableChars = parts.stableText.length;
      if (parts.dynamicText) currentTurnParts.push(parts.dynamicText);
      messages = [
        { role: 'system', content: parts.stableText },
        { role: 'user', content: messageOrMessages }
      ];
    }

    // 2) 外部 prepend (P2P 行级 reserve 状态) —— 与动态层一起进 CURRENT TURN 区, 不进 system
    if (!light && _prependProvider) {
      try {
        const pre = await _prependProvider();
        if (pre && typeof pre === 'string' && pre.trim()) currentTurnParts.push(pre);
      } catch (err: any) {
        console.warn('[pi-ai] systemPrepend 失败:', err?.message?.slice(0, 100));
      }
    }

    // 3) 调用方自己的"当前轮易变段" (pi-sdk 的循环进度 / 改进提示 / 错误提示) —— 同样进 CURRENT TURN 区.
    //    它们每 iteration 都在变; 留在 system 里 = 把 IMMUTABLE PREFIX 打碎 = 前缀 KV 永远 miss.
    if (!light && currentTurnContext && currentTurnContext.trim()) currentTurnParts.push(currentTurnContext);

    // 4) 注入 CURRENT TURN 区到最后一条 user 消息前部 (幂等: 已含标记则跳过)
    const dynamicText = assembleCurrentTurn(currentTurnParts);
    if (!light && dynamicText.trim()) {
      const inj = injectCurrentTurn(messages as Array<{ role: string; content: string }>, dynamicText);
      if (inj.reason === 'no-user-message') {
        // 一条 user 都没有 (纯 assistant 历史) → 明确追加一条, **绝不写回 system**
        const extra: ChatMessage = { role: 'user', content: '' };
        injectCurrentTurn([extra as any], dynamicText);
        messages.push(extra);
        if (callerArr) callerArr.push(extra);   // 回写调用方数组, 保证下一轮不重复追加
        console.log('[pi-ai] CURRENT TURN 追加独立 user 消息 (历史里没有 user)');
      } else if (inj.reason === 'injected') {
        console.log(`[pi-ai] CURRENT TURN 注入 msg=${inj.index} dynamic=${dynamicText.length}chars`);
      }
    }

    const historyChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) - stableChars;
    logPromptProfile({
      purpose: _purpose, source, profile: light ? 'light' : 'full',
      stableChars, dynamicChars: dynamicText.length, historyChars: Math.max(0, historyChars),
      messageCount: messages.length, toolsCount: tools?.length ?? 0,
      toolsHash: toolsHashOf(tools as any[] | undefined), cached: systemCacheHit,
    });

    try {
      const response = await this.generateText({
        messages,
        temperature: 0.8,
        maxTokens: 16384, // 2026-06-17: 提到 16384 — agent 注入 16K+ system prompt + 8K tool defs 时, 8K 撞上限返回空 content (见 memory: bolloon-llm-empty-large-prompt)
        signal,
        tools,  // pass through for native tool calling
        onToken,
        purpose: _purpose,
        source,
      });
      return {
        reply: response.reply,
        reasoningContent: response.reasoningContent,
        toolCalls: response.toolCalls,
        messages,                       // 回带最终 wire messages: 调用方据此把当前轮写回自己的 history
        usage: response.usage,
      };
    } catch (error: any) {
      // abort 不当作错误, 透传一个 sentinel 让上层能识别
      if (signal?.aborted || error?.name === 'AbortError') {
        throw error; // 上层 try/catch 处理
      }
      const { ErrorLessonStore, planRecovery, MAX_RECOVERY_ATTEMPTS, classifyApiError } = await import('./error-lessons.js');
      const store = (chatErrorLessons ??= new ErrorLessonStore());
      const baseLesson = store.learn(error);
      if (baseLesson.isNewLesson) {
        console.warn(`[llm-lesson] 新错误教训: ${baseLesson.classified.category} (${baseLesson.classified.pattern}) → ${baseLesson.classified.recovery}`);
      }

      // 2026-08-11 (Hermes error_classifier + recovery hints): 分类后真正执行恢复动作 —
      //   429/5xx → 退避重试; network → 重试 1 次; context overflow → 上层 compact (标注);
      //   auth → 不重试 (报错给用户). 之前只学习教训不重试, HTTP 429/5xx 直接失败返回.
      for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
        const classified = classifyApiError(error);
        const plan = planRecovery(classified, attempt);
        if (!plan.shouldRetry) break; // 不可恢复 / 已到 retry-once 上限
        const backoffMs = plan.backoffMs;
        console.warn(`[llm-recovery] ${classified.category} attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS}, 退避 ${backoffMs}ms 重试`);
        await new Promise<void>((r) => setTimeout(r, backoffMs));
        try {
          // 重试带着**同一份已注入的 messages** (幂等标记保证不会二次注入)
          const response = await this.generateText({
            messages,
            temperature: 0.8,
            maxTokens: 16384,
            signal,
            tools,
            onToken,
            purpose: _purpose,
            source,
          });
          return {
            reply: response.reply,
            reasoningContent: response.reasoningContent,
            toolCalls: response.toolCalls,
            messages,
            usage: response.usage,
          };
        } catch (retryErr: any) {
          if (signal?.aborted || retryErr?.name === 'AbortError') throw retryErr;
          error = retryErr; // 记录最后一次错误, 循环继续重试 (backoff 递增)
        }
      }
      console.error('PiAI chat error:', error);
      // 2026-06-15: 真实 error 信息 + 明确告诉 LLM "这是 API 错, 不要 retry"
      // 旧版: "抱歉，AI服务暂时不可用。" → LLM 看到 isTooShort=false(< 50 但 > 0),
      //       needsMoreWork 不会触发, 但 hasError 模式 (含 "error" / "失败") 会判定要继续修
      // 新版: 让 LLM 立即停止循环, 直接展示给用户
      // 2026-08-04: 带上 error.cause (undici 网络错误根因如 "other side closed" 在 cause 里)
      const causeMsg = error?.cause?.message ? ` (cause: ${String(error.cause.message).slice(0, 150)})` : '';
      const errMsg = ((error?.message || '') + causeMsg).slice(0, 300);
      return {
        reply: `[AI 服务调用失败] ${errMsg}\n\n这是一个**底层 API 错误**（401 / 鉴权失败 / 网络中断 / 配额耗尽等），不是你的任务有问题。**请直接把这个错误消息回复给用户，不要再循环尝试。**`,
      };
    }
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    const prompt = this.buildSummarizePrompt(text, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document summarizer.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        purpose: 'summarize',
        source: 'pi-ai',
      });

      const qualityScore = this.estimateQuality(text, response.reply);
      return { summary: response.reply, qualityScore };
    } catch (error) {
      console.error('PiAI summarize error:', error);
      return {
        summary: text.substring(0, 500) + '...',
        qualityScore: 0.5
      };
    }
  }

  async improveContent(content: string, requirements: string, context?: string): Promise<string> {
    const prompt = this.buildImprovePrompt(content, requirements, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document editor and improver.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        purpose: 'improve',
        source: 'pi-ai',
      });
      return response.reply;
    } catch (error) {
      console.error('PiAI improve error:', error);
      return content;
    }
  }

  private async generateText(options: GenerateOptions): Promise<ChatResult> {
    const { messages, temperature = 0.7, maxTokens = 4096, signal, tools, onToken, purpose, source } = options;

    // 工具清单: 代码侧 schema → 进 system prompt (作为额外 system message)
    let finalMessages = messages;

    // 注 (2026-09-28): 外部 prepend (_prependProvider) 已上移到 chat() —— 它进 CURRENT TURN 动态区,
    //   不再作为最前面的 system message (那份 reserve 状态每轮都在变, 放 system 会打碎 IMMUTABLE PREFIX).

    let openaiTools: any[] | undefined;
    if (tools && tools.length > 0) {
      // 预格式化的 tools (含参数 schema) → 直接使用
      if (typeof tools[0] === 'object' && (tools[0] as any)?.type === 'function') {
        // 2026-09-26: **工具名出网的唯一净化边界**.
        //   全仓只有这里产出 wire 形状的 tools 数组 (所有入口: CLI/Web/MCP/技能/子 Agent/长期任务
        //   都经 chat() → generateText() 到这里). 非法字符 (如 contact.list_authorized 里的 '.')
        //   会让整个请求 400: Invalid 'tools[120].function.name': string does not match pattern.
        //   净化同时把「原名 ↔ API 名」登记进 globalToolNameRoutes, 回程派发靠它还原成真名.
        //   撞名/无名 → 抛错点名, 不许静默.
        // 2026-09-28: 净化之后再做 `canonicalizeTools` (按 function.name 排序 + 递归 key 排序) ——
        //   顺序与嵌套 key 顺序都不再抖动, 同一份工具集的 token 前缀跨轮逐字节一致.
        openaiTools = canonicalizeTools(sanitizeToolsForApi(tools as any[]));
        const toolDescriptions = (openaiTools as any[]).map(t =>
          `- ${t.function.name}: ${t.function.description || ''} ${Object.keys(t.function.parameters?.properties || {}).length > 0 ? `(${Object.keys(t.function.parameters.properties).join(', ')})` : ''}`
        ).join('\n');
        finalMessages = [{ role: 'system', content: `可用工具:\n${toolDescriptions}` }, ...messages];
      }
    }

    switch (this.provider) {
      case 'openai':
      case 'minimax':
      case 'deepseek':
      case 'kimi':
      case 'glm':
      case 'qwen':
      case 'mimo':
      case 'grok':
        return this.callOpenAI(finalMessages, temperature, maxTokens, signal, openaiTools, onToken, purpose, source);
      case 'anthropic':
        return this.callAnthropic(finalMessages, temperature, maxTokens, signal);
      case 'ollama':
        return this.callOllama(finalMessages, temperature, signal);
      case 'openrouter':
        return this.callOpenRouter(finalMessages, temperature, maxTokens, signal);
      case 'gemini':
        return this.callGemini(finalMessages, temperature, maxTokens, signal);
      case 'local':
        return this.callLocal(finalMessages, temperature, signal);
      default:
        throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  private getApiKey(): string {
    // 2026-09-28: llama.cpp (本地 OpenAI 兼容服务) —— 声明 id 单独接 key, key 可空
    //   (llama-server 默认不校验 Authorization; 也支持 `--api-key` → 用 LLAMACPP_API_KEY 传)
    if (this.config.providerId === LLAMACPP_PROVIDER_ID) {
      return this.config.apiKey || process.env.LLAMACPP_API_KEY || '';
    }
    return this.config.apiKey || this.getEnvApiKey();
  }

  private getEnvApiKey(): string {
    const envVars: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_API_KEY || '',
      anthropic: process.env.ANTHROPIC_API_KEY || '',
      ollama: '',
      openrouter: process.env.OPENROUTER_API_KEY || '',
      gemini: process.env.GEMINI_API_KEY || '',
      minimax: process.env.MINIMAX_API_KEY || '',
      deepseek: process.env.DEEPSEEK_API_KEY || '',
      kimi: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
      glm: process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '',
      qwen: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
      mimo: process.env.MIMO_API_KEY || '',
      grok: process.env.XAI_API_KEY || '',
      local: ''
    };
    return envVars[this.provider] || '';
  }

  private getBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }

    // 2026-09-28: llama.cpp (本地 OpenAI 兼容服务) 的默认端点 —— 它按声明 id 单独接,
    //   不混进下面那张「内置 13 家」的表 (那张表被源码级门钉着, 见 provider-registry.test.ts)。
    if (this.config.providerId === LLAMACPP_PROVIDER_ID) {
      return process.env.LLAMACPP_BASE_URL || LLAMACPP_DEFAULT_BASE_URL;
    }

    // 允许通过 OPENAI_BASE_URL 等环境变量覆盖默认 base URL
    const baseUrls: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      kimi: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
      glm: process.env.GLM_BASE_URL || process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      qwen: process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      // 小米 MiMo: 走 OpenAI 兼容 API, 官方 endpoint
      mimo: process.env.MIMO_BASE_URL || 'https://api.xiaomi.com/v1',
      grok: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
      local: 'http://localhost:11434'
    };

    return baseUrls[this.provider];
  }

  private mapModel(): string {
    // 2026-09-28: llama.cpp 的模型名 = 服务端加载的那份 (名字随 `-m` 走, 客户端不自造):
    //   显式 config.model > LLAMACPP_MODEL > 'local' (占位, 服务端通常忽略未知 model 名)
    if (this.config.providerId === LLAMACPP_PROVIDER_ID) {
      return this.config.model || process.env.LLAMACPP_MODEL || LLAMACPP_DEFAULT_MODEL;
    }
    // 2026-08-04: 型号全面更新 (官方文档确认):
    //   OpenAI gpt-5.6 (alias→Sol) / Anthropic claude-sonnet-5 / Gemini gemini-3.5-flash (pro 线最新, 3.5 仅 flash)
    //   Grok grok-4.5 / Kimi kimi-k3 / GLM glm-5.2 / Qwen qwen3-max
    const modelMap: Record<ModelProvider, string> = {
      openai: this.config.model || process.env.OPENAI_MODEL || 'gpt-5.6',
      anthropic: this.config.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      ollama: this.config.model || 'llama4',
      openrouter: this.config.model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5',
      gemini: this.config.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      minimax: this.config.model || process.env.MINIMAX_MODEL || 'MiniMax-M3',
      // 2026-07-17: deepseek-chat (V3) 官方已下线, 迁 deepseek-v4-flash
      deepseek: this.config.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      kimi: this.config.model || process.env.KIMI_MODEL || process.env.MOONSHOT_MODEL || 'kimi-k3',
      glm: this.config.model || process.env.GLM_MODEL || process.env.ZHIPU_MODEL || 'glm-5.2',
      qwen: this.config.model || process.env.QWEN_MODEL || process.env.DASHSCOPE_MODEL || 'qwen3-max',
      // 小米 MiMo (openai 兼容) — env override 优先, 默认 mimo-v2.5-pro
      mimo: this.config.model || process.env.MIMO_MODEL || 'mimo-v2.5-pro',
      grok: this.config.model || process.env.XAI_MODEL || 'grok-4.5',
      local: this.config.model || 'llama4'
    };
    return modelMap[this.provider];
  }

  /**
   * 2026-09-15: 出网前把 messages 规整成 wire 形状.
   *
   * 背景 (真跑复现 + 逐项对照, 见 wiki log 2026-09-15): DeepSeek 思考模式 (deepseek-v4-*)
   * 在**请求带 tools** 时, 任何 assistant 消息缺 `reasoning_content` 字段 →
   * HTTP 400 "The `reasoning_content` in the thinking mode must be passed back to the API".
   * 复现: 同一个 17 条消息的真实请求体, 不带 tools → 200; 带上 tools → 400;
   *       给每条 assistant 补 `reasoning_content:""` → 带 tools 也 200。
   * 表现: 多轮工具循环 (第 2 轮起) 直接断, 用户看到 "AI 服务调用失败"。
   *
   * 处置: 只对 deepseek 生效 (唯一实测过的 provider); 有原文用原文, 没有就补空串 —
   *   空串已被官方接受, 且不改变语义 (思维链不是给模型看的历史内容)。
   * 其他 provider 原样透传 (OpenAI 系对未知字段更敏感, 不做无证据的改动)。
   */
  private prepareWireMessages(messages: ChatMessage[]): any[] {
    const echoReasoning = this.provider === 'deepseek';
    if (!echoReasoning) return messages as any[];
    return messages.map((m) =>
      m.role === 'assistant'
        ? { role: 'assistant', content: m.content ?? '', reasoning_content: m.reasoningContent ?? '' }
        : m,
    ) as any[];
  }

  private async callOpenAI(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal, tools?: any[], onToken?: (delta: string) => void, purpose?: string, source?: string): Promise<ChatResult> {
    const _purpose = purpose || 'chat';
    const apiKey = this.getApiKey();
    // 2026-09-28: 本地自建服务 (llama.cpp) 允许空 key —— `allowEmptyKey` 由 initPiAI 按声明 id 置位.
    //   云端分支缺 key 仍然抛错 (老行为一字不变).
    if (!apiKey && !this.config.allowEmptyKey) {
      throw new Error('OPENAI_API_KEY not set');
    }

    const requestBody: any = {
      model: this.mapModel(),
      messages: this.prepareWireMessages(messages),
      temperature,
      max_tokens: maxTokens
    };

    // 2026-09-28: 前缀 KV 复用开关 `cache_prompt`. 两处都卡住:
    //   (1) 只对本机 endpoint 带这个字段 —— 它是自建服务 (llama.cpp) 的扩展, 云端不认,
    //       白带一个未知字段有 400 风险; 换句话说云端分支的请求体与旧版逐字节相同.
    //   (2) **只有 purpose='main-agent' 为 true**. 单 slot 的本地服务上, 探针/摘要/心跳
    //       若也带 true, 会去抢 slot 0 驱逐主对话的 KV —— 那正是"主对话缓存无法命中"的一层根因.
    //   `BOLLOON_DISABLE_CACHE_PROMPT=1` 彻底关 (见 shouldUseCachePrompt).
    const localEndpoint = isLocalEndpoint(this.getBaseUrl());
    if (localEndpoint) {
      requestBody.cache_prompt = shouldUseCachePrompt(_purpose);
    }

    // 2026-09-28: 流式必须显式要 usage —— 否则 SSE 末帧不带 usage, 命中率测不到.
    if (onToken) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }

    // Bug 3: 传入原生 tools 参数 + tool_choice auto, LLM 返回结构化 tool_calls
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = 'auto';
    }

    // 2026-09-28: 出网前一行"这次请求长什么样" (**只打数字与 hash, 不打内容**)
    const _promptChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    console.log(`[pi-ai] ▶ purpose=${_purpose} source=${source || '-'} model=${this.mapModel()} messages=${requestBody.messages.length} promptChars=${_promptChars} tools=${tools?.length ?? 0} toolsHash=${toolsHashOf(tools)} cache_prompt=${localEndpoint ? requestBody.cache_prompt : '-'}${onToken ? ' stream' : ''}`);
    if (process.env.DEBUG_PROMPT_PREFIX === '1') {
      debugDumpPromptPrefix(requestBody.messages as any[], tools);
    }

    let lastFinishReason = '';
    const _t0 = Date.now();
    // 2026-08-04 (二修): 弃用全局 fetch — node 内置 fetch 的 keep-alive 连接池会积累"僵尸连接"
    //   (被对端关闭后仍留在池里), 后续请求复用即 "other side closed"; 且 node 内置 fetch
    //   会静默忽略 npm undici Agent 的 dispatcher (实测 localPort 不变), 导致重试仍在复用坏连接.
    //   改用 npm undici 的 request(): 独立连接池 + 重试传 dispatcher 真正生效 (新 TCP 连接).
    let retryAgent: Agent | null = null;
    // 认证头走注册表 (拿不到注册表 → 退回本分支原来的 Bearer 头)
    const regAuth = await this.registryAuth();
    const authHeaders: Record<string, string> = regAuth
      ? regAuth.headers
      : (apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {});   // 空 key (本地服务) → 不带鉴权头
    for (let attempt = 0; attempt < 4; attempt++) {
      const _tFetch = Date.now();
      let statusCode = 0;
      let body: any;
      let _ctype = '';
      try {
        const reqInit: any = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify(requestBody),
          signal: this.combinedSignal(signal),
        };
        if (retryAgent) reqInit.dispatcher = retryAgent;
        const res = await request(`${this.getBaseUrl()}/chat/completions`, reqInit);
        statusCode = res.statusCode;
        _ctype = String((res.headers?.['content-type'] as string) || '');   // 流式判定用 (SSE)
        body = res.body;
      } catch (err: any) {
        // 网络层瞬时错误 (undici "terminated" / "other side closed" / ECONNRESET / socket hang up / fetch failed 等)
        //   退避重试最多 3 次 (1s/2s/4s), 每次用全新 Agent 新连接 — 之前直接抛给 chat()
        //   变成 "[AI 服务调用失败] terminated" 打断 agent 流程.
        //   abort (用户主动 / 120s 超时) 不重试, 原样抛出.
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        const netMsg = String(err?.message || err?.cause?.message || '');
        const isNetworkErr = /terminated|other side closed|ECONNRESET|socket hang up|fetch failed|network|ETIMEDOUT|ECONNREFUSED|UND_ERR/i.test(netMsg);
        if (attempt < 3 && isNetworkErr) {
          const backoff = 1000 * (2 ** attempt);
          console.warn(`[pi-ai] 网络错误 attempt ${attempt + 1}/4: ${netMsg.slice(0, 120)}, 退避 ${backoff}ms 重试 (新连接)`);
          retryAgent?.destroy().catch(() => {});
          retryAgent = new Agent({ connect: { timeout: 30_000 } });
          await new Promise<void>(resolve => setTimeout(resolve, backoff));
          continue;
        }
        throw err;
      }
      const _tResp = Date.now();
      if (statusCode < 200 || statusCode >= 300) {
        const errBody = await body.text().catch(() => '(no body)');
        console.log(`[pi-ai DEBUG] OpenAI 错误 ${statusCode}: ${String(errBody).slice(0, 500)}`);
        console.log(`[pi-ai DEBUG] 请求体: model=${requestBody.model}, messages=${requestBody.messages?.length}, max_tokens=${requestBody.max_tokens}, baseUrl=${this.getBaseUrl()}`);
        if (process.env.BOLLOON_DUMP_BODY === '1') {
          try {
            const fsx = await import('fs');
            const p = `/tmp/bolloon-req-${Date.now()}.json`;
            fsx.writeFileSync(p, JSON.stringify(requestBody, null, 2));
            console.log(`[pi-ai DEBUG] 失败请求体已落盘: ${p}`);
          } catch { /* 调试用, 失败忽略 */ }
        }
        retryAgent?.destroy().catch(() => {});
        throw new Error(`OpenAI API error: ${statusCode} ${String(errBody).slice(0, 300)}`);
      }

      // 2026-09-28: 流式 (SSE) 分支 —— 只有调用方要 onToken 且服务端真回了 event-stream 才走;
      //   末帧 usage 由 `stream_options.include_usage: true` 保证 (见请求体那一段).
      if (onToken && _ctype.includes('text/event-stream')) {
        const streamed = await this.consumeStream(body, onToken, _purpose, _t0);
        retryAgent?.destroy().catch(() => {});
        return streamed;
      }

      const data = await body.json() as {
        choices?: { message?: { content?: string; tool_calls?: any[]; reasoning_content?: string }; finish_reason?: string; index?: number }[];
        usage?: any;
        timings?: any;
      };
      const _tParse = Date.now();
      // 2026-09-28: KV 命中率诊断 (**只打数字与百分比**): 取自
      //   usage.prompt_tokens_details.cached_tokens (OpenAI/DeepSeek) 或 timings.cache_n (llama.cpp)
      const usage = extractUsage(data);
      console.log(formatKvServerLine(_purpose, usage));
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      const toolCalls = choice?.message?.tool_calls;
      // 2026-09-15: 思考模式思维链 — 原样存回 history, 下一轮必须回带 (见 prepareWireMessages)
      const reasoningContent = choice?.message?.reasoning_content || undefined;
      lastFinishReason = choice?.finish_reason || '';
      // Bug 7: tool_calls 存在时不走重试 — LLM 选工具时 content 空是合法的
      if (content || (toolCalls && toolCalls.length > 0)) {
        if (lastFinishReason === 'length') {
          console.warn(`[pi-ai] hit max_tokens ceiling (model=${this.mapModel()}, max_tokens=${maxTokens}) — caller should trim prompt or raise cap`);
        }
        const _tAfter = Date.now();
        const promptBytes = JSON.stringify(messages).length;
        console.log(`[pi-ai timing] total=${_tAfter - _t0}ms attempt=${attempt + 1} fetch=${_tResp - _tFetch}ms parse=${_tParse - _tResp}ms reply=${content.length}B toolCalls=${toolCalls?.length ?? 0} model=${this.mapModel()} prompt=${promptBytes}B`);
        retryAgent?.destroy().catch(() => {});
        return { reply: content, toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined, reasoningContent, usage };
      }
      console.warn(`[pi-ai] attempt ${attempt + 1}/3: 空 content (finish_reason=${lastFinishReason}), 退避 1.5s 重试`);
      const _tSleep = Date.now();
      await new Promise<void>(resolve => setTimeout(resolve, 1500));
      console.log(`[pi-ai timing] attempt=${attempt + 1} empty; backoff=${Date.now() - _tSleep}ms; total=${Date.now() - _t0}ms so far`);
    }
    console.warn(`[pi-ai] 3 次重试都返回空 content (finish_reason=${lastFinishReason})`);
    retryAgent?.destroy().catch(() => {});
    return { reply: '' };
  }

  /**
   * 2026-09-28: 消费 SSE 流 (`stream: true`).
   *
   * 逐条 `data: {…}` 累积 delta → content / reasoning_content / tool_calls;
   * `usage` 只在**末帧**出现 (且只有带 `stream_options.include_usage: true` 才给) ——
   * 少了它就没法算 KV 命中率, 所以请求体那边是强制带上的。
   *
   * 注: 这里不做逐 token 的回调节奏保证 (Node 侧一次性读完 body 再切片) —— onToken 的语义是
   *   "把增量交给调用方", 不是"背压感知的实时流"。真要逐 token 背压, 得换 fetch 的 ReadableStream
   *   并按 chunk 解析 (本仓当前没有这个需求)。
   */
  private async consumeStream(
    body: any,
    onToken: (delta: string) => void,
    purpose: string,
    t0: number
  ): Promise<ChatResult> {
    const raw = await body.text().catch(() => '');
    let reply = '';
    let reasoning = '';
    const acc: any[] = [];
    let usage: ChatUsage | undefined;
    for (const line of String(raw).split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let frame: any;
      try { frame = JSON.parse(payload); } catch { continue; }
      if (frame?.usage || frame?.timings) usage = extractUsage(frame);
      const delta = frame?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        reply += delta.content;
        try { onToken(delta.content); } catch (err: any) {
          console.warn('[pi-ai] onToken 抛错, 已忽略:', err?.message?.slice(0, 80));
        }
      }
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      for (const tc of delta.tool_calls || []) {
        const idx = Number(tc?.index ?? acc.length);
        acc[idx] = acc[idx] || { id: tc?.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc?.id) acc[idx].id = tc.id;
        if (tc?.function?.name) acc[idx].function.name += tc.function.name;
        if (tc?.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
      }
    }
    if (usage) console.log(formatKvServerLine(purpose, usage, { stream: true }));
    const toolCalls = acc.filter(Boolean);
    console.log(`[pi-ai timing] total=${Date.now() - t0}ms stream reply=${reply.length}B toolCalls=${toolCalls.length}`);
    return {
      reply,
      reasoningContent: reasoning || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  private async callAnthropic(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system');

    // 认证头走注册表 (拿不到 → 退回原来的 x-api-key + anthropic-version);
    // `anthropic-dangerous-direct-browser-access` 是本分支历史行为, 无论注册表说什么都保留。
    const regAuthA = await this.registryAuth();
    const response = await fetch(`${this.getBaseUrl()}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(regAuthA ? regAuthA.headers : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages: userMessages,
        system: systemMessage,
        temperature,
        max_tokens: maxTokens
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { content?: { text?: string }[] };
    return { reply: data.content?.[0]?.text || '' };
  }

  private async callOllama(messages: ChatMessage[], temperature: number, signal?: AbortSignal): Promise<ChatResult> {
    // ollama 协议在注册表里是 `auth.kind='none'` → 内置行为仍是"只带 Content-Type" (一字不变);
    // 自定义的 ollama 协议供应商若声明了鉴权头, 这里就能真的带上。
    const regAuthO = await this.registryAuth();
    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(regAuthO ? regAuthO.headers : {})
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        stream: false
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    return { reply: data.message?.content || '' };
  }

  private async callOpenRouter(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }

    const regAuthR = await this.registryAuth();
    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(regAuthR ? regAuthR.headers : { 'Authorization': `Bearer ${apiKey}` }),
        'HTTP-Referer': 'https://openclaw.ai',
        'X-Title': 'OpenClaw'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return { reply: data.choices?.[0]?.message?.content || '' };
  }

  private async callGemini(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = messages.find(m => m.role === 'system')?.content;

    // gemini 的凭据在 **query** (`?key=`) 里 —— 出处就是注册表那一格 (`auth.kind='query-key'`)。
    // 内置 gemini 走注册表得到的仍是 `?key=<原样 key>`, 且**不加任何头** (历史行为一字不变);
    // 只有用户**声明了自定义 authHeader** 的自定义供应商才额外带一个头。
    const regAuthG = await this.registryAuth();
    const keyQuery = regAuthG && typeof regAuthG.query.key === 'string'
      ? `?key=${encodeURIComponent(regAuthG.query.key)}`
      : (regAuthG && Object.keys(regAuthG.query).length
        ? `?${new URLSearchParams(regAuthG.query).toString()}`
        : `?key=${encodeURIComponent(apiKey)}`);
    const geminiHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (regAuthG && regAuthG.entryKind === 'custom' && Object.keys(regAuthG.headers).length) {
      Object.assign(geminiHeaders, regAuthG.headers);
    }
    const response = await fetch(
      `${this.getBaseUrl()}/models/${this.mapModel()}:generateContent${keyQuery}`,
      {
        method: 'POST',
        headers: geminiHeaders,
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        }),
        signal: this.combinedSignal(signal),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return { reply: data.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  }

  private async callLocal(messages: ChatMessage[], temperature: number, signal?: AbortSignal): Promise<ChatResult> {
    return this.callOllama(messages, temperature, signal);
  }
  // 注: callLocal 直接代理 ollama. 工具清单由 generateText 在外层拼到 messages, 这里 messages 已是 finalMessages.

  /**
   * 2026-09-28: 装配系统提示词并拆成「稳定段 / 动态段」, 按 working dir 缓存 (TTL 10 分钟)。
   *
   * 返回: `{ stableText, dynamicText, cached }`
   *   - `stableText` 进 system (逐字节稳定 → 服务端前缀 KV 可复用);
   *   - `dynamicText` 由 chat() 注入 CURRENT TURN 区 (最后一轮 user 消息前部)。
   *
   * 为什么缓存: 旧版每轮都跑 25 次 fs.readFile + 装配; 缓存后同一次会话内只装一次,
   *   且装配结果逐字节相同 (缓存本身也是"前缀稳定"的必要条件 —— 每次重装都可能因动态层
   *   内容变化而抖动)。
   */
  private async buildSystemPromptParts(context?: string): Promise<{ stableText: string; dynamicText: string; cached: boolean }> {
    const key = context || process.cwd();
    const now = Date.now();
    if (_systemPromptCache && _systemPromptCache.key === key && now - _systemPromptCache.at < SYSTEM_PROMPT_CACHE_TTL_MS) {
      return { stableText: _systemPromptCache.stableText, dynamicText: _systemPromptCache.dynamicText, cached: true };
    }
    const parts = await this.assembleSystemPromptPartsText(key);
    _systemPromptCache = { key, at: now, ...parts };
    return { ...parts, cached: false };
  }

  /**
   * 真正跑一遍 layer registry 装配 + 拆段 (不含缓存逻辑)。
   *
   * 拆段依据: 装配器给每层写的 `<!-- id@version -->` 头 + registry 里 `source === 'function'` 的层集合
   * (本仓目前只有 `dynamic.project-context`: 它随 cwd/git 状态变 → 必须逐轮新鲜, 但不能待在 system 里)。
   */
  private async assembleSystemPromptPartsText(workingDir: string): Promise<{ stableText: string; dynamicText: string; layerIds: string[] }> {
    // 走 layer registry: 装配所有相关 layer (身份/行为/工具/角色/渠道)
    try {
      const { assembleSystemPrompt, SYSTEM_PROMPT_VERSION } = await import(
        './system-prompt/registry.js' as any
      ).catch(() => import('./system-prompt/registry.js'));
      // channel = 本机 (PI SDK 直接调就是 local)
      // role = 由 prompt context 决定 (默认 expert)
      const ctx = { channel: 'local' as const, role: 'expert' as const };
      const result = await assembleSystemPrompt(ctx);
      // 动态层 = registry 里 source==='function' 的那几层 (resolver 动态求值)
      const dynamicIds = new Set<string>(
        (result.layers as Array<{ id: string; source?: string }>)
          .filter((l) => l.source === 'function')
          .map((l) => l.id)
      );
      const { stableText, dynamicText } = splitLayerBlocks(result.text, dynamicIds);
      const suffix = `\n\n## User Working Directory\n${workingDir}\n\n## bolloon-runtime\n${SYSTEM_PROMPT_VERSION} · layers: ${result.layerIds.join(',')}`;
      return { stableText: `${stableText}${suffix}`, dynamicText, layerIds: result.layerIds };
    } catch (err: any) {
      // 降级: 旧硬编码 (layer registry 不可用时不挂) —— 注意**不写缓存**: 故障态别钉 10 分钟
      console.warn('[pi-ai] layer registry 不可用, 降级:', err.message?.slice(0, 100));
      const envDetails = this.getEnvironmentDetails();
      return {
        stableText: `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${workingDir}

## Environment
${envDetails}`,
        dynamicText: '',
        layerIds: [],
      };
    }
  }

  // 同步版: 旧调用点 (buildSystemPrompt 是同步)
  // 保留但内部用 sync fallback; 后续可改成 async
  private buildSystemPrompt(context?: string): string {
    const envDetails = this.getEnvironmentDetails();
    return `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${context || process.cwd()}

## Environment
${envDetails}`;
  }

  private getEnvironmentDetails(): string {
    return `
## Available Workflows
- read - Read documents
- summarize - Summarize documents  
- improve - Improve documents
- collaborate - Multi-agent collaboration
- query - Query status
- report - Generate reports

## System Capabilities
- Document processing (Markdown, Text, PDF, DOCX)
- Multi-agent collaboration (P2P network)
- Workflow engine (constraint layer)
- Quality assessment and auto-send

## Current Time
${new Date().toISOString()}`;
  }

  private buildSummarizePrompt(text: string, context?: string): string {
    const maxLength = 8000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

    let prompt = `Please generate a concise and accurate summary for the following document:

${truncatedText}

Please output in the following format:
## Summary
[Write summary here]

## Quality Self-Assessment
[Score 1-10, with reasoning]`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  private buildImprovePrompt(content: string, requirements: string, context?: string): string {
    const maxLength = 8000;
    const truncatedContent = content.length > maxLength ? content.substring(0, maxLength) + '...' : content;

    let prompt = `Please improve the document according to the following requirements:

Requirements: ${requirements}

Original Document:
${truncatedContent}

Please output only the improved document without additional explanation.`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  estimateQuality(original: string, summary: string): number {
    const coverageRatio = summary.length / Math.max(original.length, 1);
    const hasKeyPoints = /\d+\s*[.。]/.test(summary);
    const decentLength = summary.length > 100 && summary.length < original.length * 0.5;

    let score = 0.5;
    if (coverageRatio > 0.1 && coverageRatio < 0.5) score += 0.2;
    if (hasKeyPoints) score += 0.15;
    if (decentLength) score += 0.15;

    return Math.min(1, score);
  }

  async shouldAutoSend(qualityScore: number, threshold: number = 0.7): Promise<boolean> {
    return qualityScore >= threshold;
  }
}

let modelInstance: PiAIModel | null = null;
/** 建这个实例时用的指纹 (provider/providerId/model/baseUrl/apiKey 的 sha256[:8]) —— 指纹一致就复用, 不重建 */
let _instanceFingerprint = '';

export interface PiAIConfig {
  /** 声明 provider: 内置 13 家 + `llamacpp` (本地 OpenAI 兼容服务) */
  provider?: PiAIProvider;
  /** 声明的 provider id (自定义供应商的真名); 缺省 = `provider` (内置行为不变) */
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * 2026-09-28: provider/model/baseUrl/apiKey 的**指纹**.
 *
 * apiKey 只进 sha256 的前 8 位 —— **绝不打印 key**, 也绝不落盘/入报告.
 * 用途: `initPiAI` 幂等 —— 同一份配置重复 init (CLI 每轮、web 每次请求、脚本里多次调用)
 *   不再新建实例、不再清系统提示词缓存 (清缓存 = 下轮重装 = 前缀抖动 = KV 白丢)。
 */
export function modelFingerprint(cfg: {
  provider?: string; providerId?: string; model?: string; baseUrl?: string; apiKey?: string;
}): string {
  const keyHash = cfg.apiKey ? createHash('sha256').update(String(cfg.apiKey)).digest('hex').slice(0, 8) : '';
  return createHash('sha256')
    .update(JSON.stringify({ p: cfg.provider || '', pid: cfg.providerId || '', m: cfg.model || '', u: cfg.baseUrl || '', k: keyHash }))
    .digest('hex')
    .slice(0, 16);
}

/** 当前实例的指纹 (诊断/门用: 只出 hex, 不含任何配置值) */
export function currentModelFingerprint(): string {
  return _instanceFingerprint;
}

/** 2026-09-28: 本地 llama.cpp 的探测提示 —— 显式设了 LLAMACPP_* 就把声明 provider 定为 llamacpp */
function detectLlamacppHint(): PiAIProvider | null {
  if (process.env.LLAMACPP_BASE_URL || process.env.LLAMACPP_MODEL || process.env.LLAMACPP_API_KEY) return LLAMACPP_PROVIDER_ID;
  return null;
}

/** 2026-08-07: bolloon-config.json 优先, 旧 llm-config.json 兜底 (迁移期兼容) */
function resolveConfigPath(): string | null {
  const home = process.env.HOME || '/tmp';
  const base = path.join(home, '.bolloon');
  for (const name of ['bolloon-config.json', 'llm-config.json']) {
    const p = path.join(base, name);
    try { if (fs.existsSync(p)) return p; } catch { /* continue */ }
  }
  return null;
}

function detectProvider(): ModelProvider {
  // 首先检查配置文件（优先级最高）
  try {
    const configPath = resolveConfigPath();
    if (configPath) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (configData.activeProvider && configData.providers[configData.activeProvider]) {
        console.log('[PiAIModel] Detected provider from config:', configData.activeProvider);
        return configData.activeProvider;
      }
    }
  } catch {}

  // 然后检查环境变量
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  if (process.env.MINIMAX_API_KEY) return 'minimax';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) return 'kimi';
  if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY) return 'glm';
  if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) return 'qwen';
  if (process.env.MIMO_API_KEY) return 'mimo';
  if (process.env.XAI_API_KEY) return 'grok';

  return 'openai';
}

function detectModel(provider: ModelProvider): string {
  const defaults: Record<ModelProvider, string> = {
    openai: 'gpt-5.6',
    anthropic: 'claude-sonnet-5',
    ollama: 'llama4',
    openrouter: 'anthropic/claude-sonnet-5',
    gemini: 'gemini-3.5-flash',
    minimax: 'MiniMax-M3',
    // 2026-07-17: V3 官方下线, 迁 V4
    deepseek: 'deepseek-v4-flash',
    kimi: 'kimi-k3',
    glm: 'glm-5.2',
    qwen: 'qwen3-max',
    // 小米 MiMo 默认走最新旗舰版 (v2.5-Pro); 2026-06 当前公开版
    mimo: 'mimo-v2.5-pro',
    grok: 'grok-4.5',
    local: 'llama4'
  };
  return defaults[provider];
}

export function initPiAI(config: PiAIConfig = {}): PiAIModel {
  // 2026-09-28: llama.cpp = 声明 id `llamacpp` + `openai` 协议分支 (与本仓 providerId/provider 两分法一致)
  const declared: PiAIProvider = config.provider || detectLlamacppHint() || detectProvider();
  const isLlamacpp = declared === LLAMACPP_PROVIDER_ID;
  const provider: ModelProvider = isLlamacpp ? 'openai' : declared;
  const providerId = config.providerId || (isLlamacpp ? LLAMACPP_PROVIDER_ID : undefined);
  const model = config.model
    || (isLlamacpp ? (process.env.LLAMACPP_MODEL || LLAMACPP_DEFAULT_MODEL) : detectModel(provider));
  let baseUrl = config.baseUrl || (isLlamacpp ? (process.env.LLAMACPP_BASE_URL || LLAMACPP_DEFAULT_BASE_URL) : undefined);

  console.log('[PiAIModel] Initializing with provider:', provider, 'model:', model);

  // 如果没有提供 apiKey，从配置文件读取
  let apiKey = config.apiKey;
  // 2026-09-28: llama.cpp 的 key 从 env 兜底取一次 (getApiKey 本来也会读 env, 但指纹需要它 ——
  //   否则"换 key"这种真变化不会重建实例, 指纹就失去意义)
  if (!apiKey && isLlamacpp) apiKey = process.env.LLAMACPP_API_KEY || undefined;
  if (!apiKey) {
    try {
      const configPath = resolveConfigPath();
      if (configPath) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const providerConfig = configData.providers[declared];
        if (providerConfig?.apiKey) {
          apiKey = providerConfig.apiKey;
          console.log('[PiAIModel] Loaded apiKey from config for', declared);
        }
        // 2026-09-28: 本地服务 (llamacpp) 的 baseUrl 常写在配置里 → 只对这一家多读一个字段
        //   (别人保持"只读 apiKey"的老行为: 让 model/baseUrl 的优先级变动会牵连 llm-config 那条线)
        if (isLlamacpp && !baseUrl && providerConfig?.baseUrl) baseUrl = providerConfig.baseUrl;
      }
    } catch (e) {
      console.log('[PiAIModel] Error reading apiKey from config:', e);
    }
  }

  // ── 2026-09-28: 按指纹幂等 ──────────────────────────────────────────────
  //   同一份配置重复 init (CLI 每轮 / web 每次请求 / 脚本多入口) **不再重建实例、不再清装配缓存**.
  //   之前每次 init 都清缓存 → 每轮重装 system → 前缀抖动 → 服务端前缀 KV 永远用不上.
  //   真变化 (provider/model/baseUrl/key) → 清缓存 + 重建 (旧行为).
  const fingerprint = modelFingerprint({ provider, providerId, model, baseUrl, apiKey });
  if (modelInstance && _instanceFingerprint === fingerprint) {
    console.log('[PiAIModel] 指纹一致, 复用现有实例 (不重建, 不清装配缓存):', fingerprint.slice(0, 8));
    return modelInstance;
  }

  clearSystemPromptCache();
  modelInstance = new PiAIModel({
    provider,
    providerId,
    apiKey,
    baseUrl,
    model,
    // 本地自建服务: 允许空 key + 无 key 不带鉴权头
    allowEmptyKey: isLlamacpp,
  });
  _instanceFingerprint = fingerprint;

  console.log('[PiAIModel] Model instance created, provider:', provider, 'fingerprint:', fingerprint.slice(0, 8));
  return modelInstance;
}

export function getModel(): PiAIModel {
  if (!modelInstance) {
    throw new Error('PiAI not initialized. Call initPiAI first.');
  }
  return modelInstance;
}

export function isModelAvailable(): boolean {
  return modelInstance !== null;
}

export function getMinimax(): PiAIModel {
  return getModel();
}

export function initMinimax(config: PiAIConfig = {}): PiAIModel {
  return initPiAI(config);
}

/** 2026-08-11: 会话级 LLM 错误教训存储 (Hermes error_classifier 模式) — 同类错误只学一次 */
let chatErrorLessons: import('./error-lessons.js').ErrorLessonStore | null = null;

export function getChatErrorLessons(): import('./error-lessons.js').ErrorLessonStore | null {
  return chatErrorLessons;
}

export { PiAIModel as MinimaxLLM };
