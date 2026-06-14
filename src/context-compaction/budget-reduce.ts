/**
 * Budget Reduction — 第 1 层: 单条消息大小限制
 *
 * 论文: 总是跑. 截断 > 阈值的单条消息, 加 ... [truncated, original=N chars]
 *
 * 关键: 不破坏 messageHistory 内存结构, 只改 buildContext 输出
 * 但因为 buildContext 需要最终字符串, 这里实际返回新 history
 * (内容相同的引用 = 内存未真正变更)
 *
 * 失败静默: 异常 → 返回原 history
 */

import type { Message, StageResult, StageOptions } from './types.js';

const DEFAULT_MAX_CHARS = 4000;

export function budgetReduce(history: Message[], opts: StageOptions = {}): StageResult {
  try {
    if (opts.skip) return { history, applied: false, detail: 'skipped' };
    const maxChars = opts.budgetReduceMaxChars ?? DEFAULT_MAX_CHARS;
    let changed = false;
    const out: Message[] = history.map((m) => {
      if (m.content && m.content.length > maxChars) {
        changed = true;
        return {
          ...m,
          content: m.content.substring(0, maxChars) + `\n... [truncated, original=${m.content.length} chars]`,
        };
      }
      return m;
    });
    return { history: out, applied: changed, detail: changed ? `truncated >${maxChars} chars` : 'no oversized messages' };
  } catch (err) {
    console.warn('[compactor] budgetReduce failed (silent, returning original):', err);
    return { history, applied: false, detail: 'error' };
  }
}
