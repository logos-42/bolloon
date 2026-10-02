/**
 * **K6 —— ModelRuntime 台账 + 门的数据面**。
 *
 * K6 的目标 (路线图原文, 不许跳): 以 `ModelRuntime.acquire(modelSnapshot)` 为**只读**入手的多供应商运行时
 * (并发 · 连接池 · timeout · cancellation · 429 退避 · circuit breaker · capability 检查 · provider fallback · usage 记录),
 * **已有的 `selectModel` / registry / catalog / Run snapshot 继续保留, 不重做**。
 *
 * 通用判据 (K2 实操中拦回过一次 assistant 的实现): **新层出现后, 旧写口的调用点数只许不变或减少。**
 *   —— 所以 K6 的第一件事不是写运行时, 而是把"旧写口"**数清楚并冻结**, 让"只读"这件事可判、可回退检测。
 */

/** 旧写口 (改动 model/provider 状态的导出函数) + 它们在主仓的调用点数 (口径见 gate-scan 的同名函数) */
export interface ModelWritePort {
  name: string;
  /** 定义所在模块 (相对 src/) */
  module: string;
  callSites: number;
  note?: string;
}

/**
 * **旧写口名册 (冻结)** —— 口径: 全仓 (排除 `test/` 与 `kernel/`) 里 `name(` 的匹配次数, **去掉含 `function name` 的声明行**。
 *   判据用同一口径从盘上重算 ⇒ 增 = 新层在偷偷改旧状态 (回退) · 减 = 改了盘没改账。
 */
export const MODEL_WRITE_PORTS: readonly ModelWritePort[] = [
  { name: 'setCustomProviderSnapshot', module: 'llm/provider-registry.ts', callSites: 5 },
  { name: 'addCustomProvider', module: 'llm/custom-provider-store.ts', callSites: 0, note: '主仓零调用 (仅测试/未来向导用) —— 只许不变或减' },
  { name: 'updateCustomProvider', module: 'llm/custom-provider-store.ts', callSites: 0, note: '主仓零调用' },
  { name: 'removeCustomProvider', module: 'llm/custom-provider-store.ts', callSites: 0, note: '主仓零调用' },
  { name: 'writeSessionSelection', module: 'llm/model-selection.ts', callSites: 1 },
  { name: 'clearSessionSelection', module: 'llm/model-selection.ts', callSites: 2 },
  { name: 'resetModelSelection', module: 'llm/model-selection.ts', callSites: 1 },
  { name: 'setSystemPrependProvider', module: 'llm/pi-ai.ts', callSites: 1 },
  { name: 'clearSystemPromptCache', module: 'llm/pi-ai.ts', callSites: 1 },
];

/** 合计冻结值 (棘轮: 只许不变或减少; 要加必须同时改这里 ⇒ diff 里一次显式动作) */
export const MODEL_WRITE_PORTS_FROZEN_AT = 11;

/** `acquire` 的**只读**要求 (写成数据, 判据与实现共用) */
export const MODEL_RUNTIME_ACQUIRE_RULE = {
  readOnly: true,
  rule: '`acquire(modelSnapshot)` 只读: 不许改 provider 配置 / API key / 默认 URL / Global model / Run snapshot',
  ratchet: '新层出现后, 旧写口的调用点数只许不变或减少 (增 = 回退)',
} as const;

/** 运行时能力清单 (K6 的实现范围; status 由实现推进 —— 判据核"每项都有状态") */
export interface ModelRuntimeCapability { key: string; why: string; status: 'not-started' | 'in-progress' | 'done' }
export const MODEL_RUNTIME_CAPABILITIES: readonly ModelRuntimeCapability[] = [
  { key: 'multi-provider-concurrency', why: '多供应商并发调用 (各 provider 各自限流)', status: 'done' },
  { key: 'connection-pool', why: '连接复用 (keep-alive), 不每次新建', status: 'done' },
  { key: 'timeout', why: '单次调用超时 (按 snapshot 的预算)', status: 'done' },
  { key: 'cancellation', why: '取消传播 (AbortSignal 透传)', status: 'done' },
  { key: 'rate-limit-backoff', why: '429 退避 (指数 + 抖动, 不许重试风暴)', status: 'done' },
  { key: 'circuit-breaker', why: '连续失败熔断 (半开探测)', status: 'done' },
  { key: 'capability-check', why: '能力检查 (该 provider 是否支持所需能力: 工具/vision/长上下文)', status: 'done' },
  { key: 'provider-fallback', why: '失败回退到备用 provider (按 Run snapshot, 不改全局)', status: 'done' },
  { key: 'usage-recording', why: 'usage 记录 (token/成本按 Run 记账)', status: 'done' },
];

/** **明确不做** (路线图红线; 判据核这几条名字都在, 防止实现时越界) */
export const MODEL_RUNTIME_OUT_OF_SCOPE: readonly string[] = [
  '不自行改 provider 配置',
  '不自行改 API key',
  '不自行改默认 URL',
  '不自行改 Global model',
  '不自行改 Run snapshot',
];

/** K6 进度 (与 K5 的 stage/container 同款: 声明未实现 ⇒ 运行时文件**必须不存在**) */
export const K6_PROGRESS = {
  stage: 'capabilities-done' as 'not-started' | 'runtime-built' | 'capabilities-done',
  runtimePath: 'kernel/model-runtime.ts',
  /** 必须等于 `MODEL_RUNTIME_CAPABILITIES` 里 status==='done' 的条数 (判据机械核, 不许自报) */
  capabilitiesDone: 9,
  capabilitiesTotal: MODEL_RUNTIME_CAPABILITIES.length,
} as const;
