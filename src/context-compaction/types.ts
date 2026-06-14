/**
 * Context Compaction — 类型定义
 *
 * 严格对齐 Claude Code 论文 5 层压缩流水线:
 *   1. Budget Reduction   (单条消息大小限制)
 *   2. Snip               (裁掉老历史, feature flag 关闭)
 *   3. Microcompact       (cache-aware 细粒度压缩, 老 tool_result 折叠)
 *   4. Context Collapse   (读时虚拟投影, 非破坏)
 *   5. Auto-Compact       (LLM 摘要, 兜底)
 *
 * 关键不变量:
 *   - 第 1-3 层不破坏 messageHistory 内存结构, 只改 buildContext 输出
 *   - 第 4 层读时投影, 绝不改 messageHistory
 *   - 第 5 层破坏 messageHistory, 把 N 对折叠成 1 条 summary
 *
 * 类型设计: Message 在本模块内独立定义, 靠 structural typing 与 pi-sdk.ts 的 Message 兼容.
 * 不 import pi-sdk 避免循环依赖.
 */

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface Message {
  role: Role;
  content: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  toolResult?: unknown;
  toolName?: string;
  [key: string]: unknown;
}

// ============================================================
// 5 层 stage 共享的输入输出
// ============================================================

export interface StageOptions {
  /** Token 预算 (默认 8000) */
  maxTokens?: number;
  /** 跳过本层 (per-stage 开关) */
  skip?: boolean;
  /** Snip 专用: 保留最近多少对 (默认 20) */
  snipKeepPairs?: number;
  /** Budget Reduction 专用: 单条消息上限 (默认 4000 字符) */
  budgetReduceMaxChars?: number;
  /** Microcompact 专用: 保留最近多少条完整 tool_result (默认 3) */
  microcompactKeepRecent?: number;
  /** Context Collapse 专用: 折叠前多少对 (默认 5) */
  contextCollapseCollapsePairs?: number;
  /** Auto-Compact 专用: 摘要前多少对 (默认 5) */
  autoCompactCollapsePairs?: number;
  /** Auto-Compact 专用: 注入 LLM 调用 (用于生成摘要) */
  llmChat?: (systemPrompt: string, userPrompt: string, signal?: AbortSignal) => Promise<string>;
  /** Auto-Compact 专用: 缓存 key 后缀 (通常 = channelId) */
  cacheScope?: string;
  /** Context Collapse 专用: 注入 LLM (虚拟投影需要 summary 文本) */
  collapseLlmChat?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface CompactionContext {
  /** 输入: 原始 history */
  inputHistory: Message[];
  /** 当前已压缩的 history (经过前面 stage) */
  history: Message[];
  /** 估算的 token 数 */
  estimatedTokens: number;
  /** 选项 */
  opts: StageOptions;
  /** Pipeline 元数据, 记录每层做了什么 */
  stages: Array<{ stage: string; applied: boolean; before: number; after: number; detail?: string }>;
}

export interface StageResult {
  /** 压缩后的 history */
  history: Message[];
  /** 该 stage 是否做了改动 */
  applied: boolean;
  /** 详情 (供 audit / debug) */
  detail?: string;
}

// ============================================================
// Budget Gate
// ============================================================

export interface BudgetReport {
  fit: boolean;
  estimatedTokens: number;
  /** 占用比例 0-1 */
  ratio: number;
  /** 触发了哪一层 (>=0.8 = next layer, >1 = all layers) */
  triggerNextLayer: boolean;
}

export interface PipelineResult {
  history: Message[];
  estimatedTokens: number;
  stages: CompactionContext['stages'];
  /** 是否至少跑了一层 */
  compacted: boolean;
}
