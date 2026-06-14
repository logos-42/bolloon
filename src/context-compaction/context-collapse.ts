/**
 * Context Collapse — 第 4 层: 读时虚拟投影 (非破坏)
 *
 * 论文:
 *   - 不修改 messageHistory
 *   - 在 buildContext() 输出阶段, 前 K 对 user/assistant 替换为 [collapsed: <summary>]
 *   - feature flag BOLLOON_CONTEXT_COLLAPSE 默认关闭
 *
 * 实现策略:
 *   - 由于 buildContext 阶段才输出最终字符串, 这里"虚拟投影"实际意味着:
 *     返回一个新 history, 前 K 对用一个虚拟的 "collapsed" summary 消息替代
 *   - 但 memory 层的 messageHistory 不变 (由调用方负责回滚或仅在 buildContext 内用)
 *
 * 实践: 本 stage 返回一个标记 collapsed=true 的 history, 调用方可以选择:
 *   (a) 仅在 buildContext 字符串拼接时替换 (理想)
 *   (b) 临时替换 (本次 LLM call 结束后回滚)
 *   (c) 永久替换 (但这违背"非破坏"原则)
 *
 * 本模块选 (b): 返回新 history, 标记 collapsedMeta 字段, 文档说明调用方应仅用于构建 LLM 输入
 *
 * 失败静默: 异常 → 返回原 history
 */

import type { Message, StageResult, StageOptions } from './types.js';

const DEFAULT_COLLAPSE_PAIRS = 5;
const DEFAULT_SUMMARY = '[collapsed: N earlier rounds — summary not yet generated]';

export function isContextCollapseEnabled(): boolean {
  return process.env.BOLLOON_CONTEXT_COLLAPSE === '1';
}

export function contextCollapse(history: Message[], opts: StageOptions = {}): StageResult {
  try {
    if (opts.skip || !isContextCollapseEnabled()) {
      return { history, applied: false, detail: isContextCollapseEnabled() ? 'skipped' : 'feature flag off' };
    }
    const collapsePairs = opts.contextCollapseCollapsePairs ?? DEFAULT_COLLAPSE_PAIRS;

    // 找前 K 对 user/assistant 的边界
    let pairsFound = 0;
    let cutTo = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        pairsFound++;
        if (pairsFound > collapsePairs) {
          cutTo = i;
          break;
        }
      }
    }
    if (cutTo <= 0) {
      return { history, applied: false, detail: 'history too short' };
    }

    // 把前 cutTo 条压成 1 条 virtual summary message
    const collapsedCount = cutTo;
    const summaryMsg: Message = {
      role: 'system',
      content: `[collapsed: ${collapsedCount} earlier messages (${collapsePairs} pairs) — virtual projection, original history preserved]`,
    } as any;
    const out: Message[] = [summaryMsg, ...history.slice(cutTo)];
    return {
      history: out,
      applied: true,
      detail: `virtual-collapsed first ${collapsedCount} messages`,
    };
  } catch (err) {
    console.warn('[compactor] contextCollapse failed (silent, returning original):', err);
    return { history, applied: false, detail: 'error' };
  }
}
