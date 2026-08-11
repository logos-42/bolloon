/**
 * error-lessons.ts — LLM API 错误分类 + 会话级教训学习 (借鉴 Hermes agent/error_classifier.py:
 *   "record the (provider, model) so we don't waste another call learning the same lesson, retry")
 *
 * Hermes 模式:
 *   - 模式库分类错误 (context overflow / multimodal / 400 / 402 / 429 / 5xx)
 *   - 同类错误会话内只学一次 (lesson memory), 之后的调用直接走已学恢复动作, 不重复分析
 *   - 恢复动作: context overflow → 压缩上下文重试; 429/5xx → 退避重试; auth → 不重试
 *
 * 纯函数 + 有状态 store 分离, 可单测。
 */

export type ErrorCategory =
  | 'rate-limit'        // 429 / rate limit — 退避重试
  | 'context-overflow'  // context length / token limit — 压缩上下文后重试
  | 'auth'              // 401/403/402 — 不重试 (报错给用户)
  | 'network'           // ECONNRESET/timeout/undici — 重试 1 次
  | 'server'            // 5xx — 退避重试
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  /** 命中的模式摘要 (诊断用) */
  pattern: string;
  /** 是否值得自动恢复 (rate-limit/context-overflow/network/server 为 true; auth 为 false) */
  recoverable: boolean;
  /** 建议恢复动作 */
  recovery: 'backoff-retry' | 'compact-retry' | 'retry-once' | 'no-retry';
}

const PATTERNS: Array<{ category: ErrorCategory; recovery: ClassifiedError['recovery']; re: RegExp }> = [
  { category: 'rate-limit', recovery: 'backoff-retry', re: /(rate.?limit|too many requests|429|quota|限流|频率)/i },
  { category: 'context-overflow', recovery: 'compact-retry', re: /(context|token|prompt).*(length|limit|size|exceed|too (long|large|many|small|big))|maximum context|reduce.*length|(token|上下文).*(上限|超长|过长|超出)|请求过长/i },
  { category: 'auth', recovery: 'no-retry', re: /(401|403|402|unauthori[sz]ed|invalid api key|permission denied|鉴权|api.?key)/i },
  { category: 'network', recovery: 'retry-once', re: /(ECONNRESET|ETIMEDOUT|ENOTFOUND|socket|network|undici|fetch failed|other side closed|timeout)/i },
  { category: 'server', recovery: 'backoff-retry', re: /(50[0-9]|internal server|bad gateway|service unavailable|overloaded|server error)/i },
];

/** 分类错误 (Hermes classify_api_error 的轻量版) */
export function classifyApiError(err: unknown): ClassifiedError {
  const msg = String((err as any)?.message || err || '').slice(0, 500);
  for (const p of PATTERNS) {
    if (p.re.test(msg)) {
      return { category: p.category, pattern: p.re.source, recoverable: p.recovery !== 'no-retry', recovery: p.recovery };
    }
  }
  return { category: 'unknown', pattern: '(无匹配)', recoverable: false, recovery: 'no-retry' };
}

/** 会话级教训记忆: 同类错误只学一次 (Hermes "don't waste another call learning the same lesson") */
export class ErrorLessonStore {
  private lessons = new Map<ErrorCategory, { learnedAt: number; recovery: ClassifiedError['recovery'] }>();

  /** 记录一次错误; 返回 true = 本次是新教训 (同类第一次), false = 已学过 (去重) */
  learn(err: unknown): { classified: ClassifiedError; isNewLesson: boolean } {
    const classified = classifyApiError(err);
    if (this.lessons.has(classified.category)) {
      return { classified, isNewLesson: false };
    }
    this.lessons.set(classified.category, { learnedAt: Date.now(), recovery: classified.recovery });
    return { classified, isNewLesson: true };
  }

  /** 查询已学恢复动作 (未学过返回 undefined) */
  recoveryFor(category: ErrorCategory): ClassifiedError['recovery'] | undefined {
    return this.lessons.get(category)?.recovery;
  }

  /** 已学教训数 */
  get size(): number {
    return this.lessons.size;
  }

  /** 清空 (新会话/新 provider 时) */
  reset(): void {
    this.lessons.clear();
  }
}

// ============================================================================
// 错误恢复执行器 (借鉴 Hermes error_classifier recovery hints:
//   classify → 查 recovery 提示 → 退避重试 / 压缩重试 / 重试一次 / 不重试)
// ============================================================================

/** 一次可执行的重试计划 (纯函数, 供上层调用方在出错后决定是否/如何重试) */
export interface RecoveryPlan {
  /** 是否值得重试 (backoff-retry / retry-once 为 true; compact-retry 交由上层压缩; no-retry 为 false) */
  shouldRetry: boolean;
  /** 重试前退避毫秒 (backoff-retry / retry-once 有值; 其它 0) */
  backoffMs: number;
  /** 命中的恢复动作 (透传, 供上层区分: 'compact-retry' 需先压缩上下文再重试) */
  recovery: ClassifiedError['recovery'];
}

/** 分类结果 → 可执行重试计划. attempt 从 0 起, 越往后退避越大 (指数). */
export function planRecovery(classified: ClassifiedError, attempt = 0): RecoveryPlan {
  switch (classified.recovery) {
    case 'backoff-retry':
      return { shouldRetry: true, backoffMs: 1000 * (2 ** attempt), recovery: 'backoff-retry' };
    case 'retry-once':
      return { shouldRetry: attempt < 1, backoffMs: attempt < 1 ? 1500 : 0, recovery: 'retry-once' };
    case 'compact-retry':
      // 需先压缩上下文 — 重试动作交给上层 (调用方负责 autoCompact), 这里只标注
      return { shouldRetry: false, backoffMs: 0, recovery: 'compact-retry' };
    default:
      return { shouldRetry: false, backoffMs: 0, recovery: classified.recovery };
  }
}

/** 最大自动恢复重试次数 (Hermes 心智: 退避重试有上限, 不无限循环浪费) */
export const MAX_RECOVERY_ATTEMPTS = 3;
