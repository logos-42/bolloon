/**
 * Microcompact — 第 3 层: cache-aware 细粒度压缩
 *
 * 论文: 总是跑 (时间触发), 关键作用是保留 prompt cache 命中
 * 实现 (简化版): 把老的 toolResult 折叠为 "(tool result: <name>, N chars)"
 *   - 保留最近 N 条 tool_result 完整 (默认 3)
 *   - 之前的折叠
 *
 * 关键: 不破坏 messageHistory 内存结构
 *
 * 失败静默: 异常 → 返回原 history
 */

import type { Message, StageResult, StageOptions } from './types.js';

const DEFAULT_KEEP_RECENT = 3;

export function microcompact(history: Message[], opts: StageOptions = {}): StageResult {
  try {
    if (opts.skip) return { history, applied: false, detail: 'skipped' };
    const keepRecent = opts.microcompactKeepRecent ?? DEFAULT_KEEP_RECENT;

    // 找所有 tool 消息的索引
    const toolIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'tool') toolIndices.push(i);
    }
    if (toolIndices.length <= keepRecent) {
      return { history, applied: false, detail: 'no old tool_results to fold' };
    }

    // 要折叠的 = 前 (total - keepRecent) 条
    const toFold = new Set(toolIndices.slice(0, toolIndices.length - keepRecent));
    let changed = false;
    const out: Message[] = history.map((m, i) => {
      if (toFold.has(i) && m.role === 'tool') {
        changed = true;
        // 尝试从相邻的 assistant 消息拿 tool name
        const name = (m as any).toolName || 'unknown';
        const originalLen = m.content?.length || 0;
        return {
          ...m,
          content: `(tool result: ${name}, ${originalLen} chars — folded by microcompact)`,
          toolResult: undefined,
        };
      }
      return m;
    });
    return { history: out, applied: changed, detail: `folded ${toFold.size} old tool_results, kept last ${keepRecent}` };
  } catch (err) {
    console.warn('[compactor] microcompact failed (silent, returning original):', err);
    return { history, applied: false, detail: 'error' };
  }
}
