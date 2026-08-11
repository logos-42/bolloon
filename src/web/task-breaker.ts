/**
 * task-breaker.ts — 任务连续失败熔断器 (借鉴 Hermes kanban `consecutive_failures`:
 *   失败递增, 成功清零, 超过 failure_limit 熔断 — 防无限重试循环)
 *
 * 纯函数, 可单测。
 */

/** 默认熔断阈值: 连续 3 次失败 (BOLLOON_FAILURE_LIMIT 可调) */
export const DEFAULT_FAILURE_LIMIT = 3;

export interface FailureState {
  consecutiveFailures: number;
  /** 是否达到熔断阈值 (应置 failed 终态, 不再自动重试) */
  tripped: boolean;
}

/** 记录一次失败: 计数 +1, 判断是否熔断. 优先级: per-task failureLimit → env → DEFAULT. */
export function recordTaskFailure(
  task: { consecutiveFailures?: number; failureLimit?: number },
  envLimit?: number
): FailureState {
  const limit = task.failureLimit ?? (envLimit && envLimit > 0 ? envLimit : DEFAULT_FAILURE_LIMIT);
  const next = (task.consecutiveFailures ?? 0) + 1;
  return { consecutiveFailures: next, tripped: next >= limit };
}

/** 成功完成: 计数清零 */
export function resetTaskFailures(): { consecutiveFailures: 0 } {
  return { consecutiveFailures: 0 };
}
