/**
 * Context Compaction — 公共导出 (barrel)
 *
 * 设计: 严格对齐 Claude Code 论文 5 层压缩流水线
 *   1. Budget Reduction   (单条消息大小限制)
 *   2. Snip               (裁掉老历史, feature flag 关闭)
 *   3. Microcompact       (cache-aware 细粒度压缩)
 *   4. Context Collapse   (读时虚拟投影, feature flag 关闭)
 *   5. Auto-Compact       (LLM 摘要, 兜底)
 *
 * 主要入口: `compactPipeline(history, opts)`
 * 失败静默: 任何 stage 抛错 → pipeline 返回原 history
 */

export type { Message, StageResult, StageOptions, PipelineResult, BudgetReport, CompactionContext } from './types.js';

export { compactPipeline, _resetPipelineForTest } from './pipeline.js';
export { budgetGate } from './budget-gate.js';
export { budgetReduce } from './budget-reduce.js';
export { snip, isSnipEnabled } from './snip.js';
export { microcompact } from './microcompact.js';
export { contextCollapse, isContextCollapseEnabled } from './context-collapse.js';
export { autoCompact, _resetAutoCompactCacheForTest } from './auto-compact.js';
export { estimateTokens, estimateStringTokens } from './token-estimator.js';
