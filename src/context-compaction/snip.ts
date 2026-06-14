/**
 * Snip — 第 2 层: 裁掉老 history
 *
 * 论文: feature flag 关闭 (默认), 用户开启后才生效
 * 开启环境变量: BOLLOON_SNIP_ENABLED=1
 *
 * 行为: 只保留最近 N 对 user/assistant (默认 20 对)
 * 工具结果消息按其所属 round 一起保留
 *
 * 失败静默: 异常 → 返回原 history
 */

import type { Message, StageResult, StageOptions } from './types.js';

const DEFAULT_KEEP_PAIRS = 20;

export function isSnipEnabled(): boolean {
  return process.env.BOLLOON_SNIP_ENABLED === '1';
}

export function snip(history: Message[], opts: StageOptions = {}): StageResult {
  try {
    if (opts.skip || !isSnipEnabled()) {
      return { history, applied: false, detail: isSnipEnabled() ? 'skipped' : 'feature flag off' };
    }
    const keepPairs = opts.snipKeepPairs ?? DEFAULT_KEEP_PAIRS;

    // 从后往前数 N 对 user/assistant 边界
    let pairsFound = 0;
    let cutFrom = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === 'user') {
        pairsFound++;
        if (pairsFound >= keepPairs) {
          cutFrom = i;
          break;
        }
      }
    }

    if (cutFrom <= 0) {
      return { history, applied: false, detail: 'history too short' };
    }
    const out = history.slice(cutFrom);
    return { history: out, applied: true, detail: `kept last ${keepPairs} pairs, dropped ${cutFrom} older messages` };
  } catch (err) {
    console.warn('[compactor] snip failed (silent, returning original):', err);
    return { history, applied: false, detail: 'error' };
  }
}
