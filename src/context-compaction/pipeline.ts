/**
 * Context Compaction Pipeline — 5 层编排
 *
 * 严格对齐 Claude Code 论文: 每次 LLM call 前顺序执行 5 个 shaper, 由便宜到重, 任一层 fit 就短路.
 *
 *   1. Budget Reduction   (总是, 截断 > 阈值的单条消息)
 *   2. Snip               (feature flag BOLLOON_SNIP_ENABLED)
 *   3. Microcompact       (总是, 折叠老 tool_result)
 *   4. Context Collapse   (feature flag BOLLOON_CONTEXT_COLLAPSE, 读时虚拟投影)
 *   5. Auto-Compact       (LLM 摘要, 兜底)
 *
 * 短路: 任一层后 budget fit (< 0.8) → 返回该层结果, 不跑后续.
 *
 * 关键不变量:
 *   - 任何异常 → 整 pipeline 返回原 history (与现状一致)
 *   - 第 1-3 层不破坏 messageHistory 内存引用 (内容可改)
 *   - 第 4 层读时投影, memory 不变
 *   - 第 5 层破坏性, 折叠 N 对成 1 条
 *
 * 失败静默: 整 pipeline 用 try/catch 包, 任何 stage 失败不影响整体
 */

import type { Message, StageResult, StageOptions, PipelineResult, CompactionContext } from './types.js';
import { budgetGate } from './budget-gate.js';
import { budgetReduce } from './budget-reduce.js';
import { snip, isSnipEnabled } from './snip.js';
import { microcompact } from './microcompact.js';
import { contextCollapse, isContextCollapseEnabled } from './context-collapse.js';
import { autoCompact } from './auto-compact.js';

const DEFAULT_MAX_TOKENS = 8000;

export async function compactPipeline(
  history: Message[],
  opts: StageOptions = {}
): Promise<PipelineResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const ctx: CompactionContext = {
    inputHistory: history,
    history,
    estimatedTokens: 0,
    opts,
    stages: [],
  };

  try {
    // Stage 1: Budget Reduction
    let result = budgetReduce(history, opts);
    ctx.history = result.history;
    ctx.stages.push(stageRecord('budgetReduce', result, history));
    let gate = budgetGate(ctx.history, maxTokens);
    ctx.estimatedTokens = gate.estimatedTokens;
    if (gate.fit) return finalize(ctx, result.applied);  // 短路但可能 budgetReduce 实际改了内容

    // Stage 2: Snip (feature flag)
    if (isSnipEnabled()) {
      const before = ctx.history;
      result = snip(ctx.history, opts);
      ctx.history = result.history;
      ctx.stages.push(stageRecord('snip', result, before));
      gate = budgetGate(ctx.history, maxTokens);
      ctx.estimatedTokens = gate.estimatedTokens;
      if (gate.fit) return finalize(ctx, true);
    } else {
      ctx.stages.push({ stage: 'snip', applied: false, before: ctx.history.length, after: ctx.history.length, detail: 'feature flag off' });
    }

    // Stage 3: Microcompact
    const before3 = ctx.history;
    result = microcompact(ctx.history, opts);
    ctx.history = result.history;
    ctx.stages.push(stageRecord('microcompact', result, before3));
    gate = budgetGate(ctx.history, maxTokens);
    ctx.estimatedTokens = gate.estimatedTokens;
    if (gate.fit) return finalize(ctx, result.applied || true);

    // Stage 4: Context Collapse (feature flag)
    if (isContextCollapseEnabled()) {
      const before4 = ctx.history;
      result = contextCollapse(ctx.history, opts);
      ctx.history = result.history;
      ctx.stages.push(stageRecord('contextCollapse', result, before4));
      gate = budgetGate(ctx.history, maxTokens);
      ctx.estimatedTokens = gate.estimatedTokens;
      if (gate.fit) return finalize(ctx, true);
    } else {
      ctx.stages.push({ stage: 'contextCollapse', applied: false, before: ctx.history.length, after: ctx.history.length, detail: 'feature flag off' });
    }

    // Stage 5: Auto-Compact (兜底)
    const before5 = ctx.history;
    result = await autoCompact(ctx.history, opts);
    ctx.history = result.history;
    ctx.stages.push(stageRecord('autoCompact', result, before5));

    return finalize(ctx, true);
  } catch (err) {
    console.warn('[compactor] pipeline failed (silent, returning original):', err);
    return {
      history,
      estimatedTokens: 0,
      stages: ctx.stages,
      compacted: false,
    };
  }
}

function stageRecord(name: string, result: StageResult, before: Message[]) {
  return {
    stage: name,
    applied: result.applied,
    before: before.length,
    after: result.history.length,
    detail: result.detail,
  };
}

function finalize(ctx: CompactionContext, compacted: boolean): PipelineResult {
  return {
    history: ctx.history,
    estimatedTokens: ctx.estimatedTokens,
    stages: ctx.stages,
    compacted,
  };
}

// ============================================================
// 测试钩子
// ============================================================

export function _resetPipelineForTest(): void {
  // pipeline 是 stateless, 但保留 API 一致性
}
