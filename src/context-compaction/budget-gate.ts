/**
 * Budget Gate — 预算判定 (不修改消息)
 *
 * 论文: 这是判定阶段, 不是压缩阶段. 触发条件:
 *   - ratio < 0.8   → fit, 不压缩
 *   - 0.8 ≤ ratio ≤ 1.0 → triggerNextLayer (跑下一层)
 *   - ratio > 1.0   → triggerNextLayer, 全部层都跑
 *
 * 失败静默: 任何异常 → 视为 fit (与现状一致, 不冒险压缩)
 */

import type { Message } from './types.js';
import { estimateTokens } from './token-estimator.js';
import type { BudgetReport } from './types.js';

const FIT_THRESHOLD = 0.8;

export function budgetGate(history: Message[], maxTokens: number = 8000): BudgetReport {
  try {
    const estimatedTokens = estimateTokens(history as any);
    const ratio = maxTokens > 0 ? estimatedTokens / maxTokens : 0;
    return {
      fit: ratio < FIT_THRESHOLD,
      estimatedTokens,
      ratio,
      triggerNextLayer: ratio >= FIT_THRESHOLD,
    };
  } catch (err) {
    console.warn('[compactor] budgetGate failed (silent, treating as fit):', err);
    return { fit: true, estimatedTokens: 0, ratio: 0, triggerNextLayer: false };
  }
}
