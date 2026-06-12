/**
 * D 触发钩子: AI 自动捕获判断力
 *
 * 流程: detectIfWorthStoring → distillFromConversation → storeHumanJudgment → evolveNewJudgment
 * 错误处理: 任意步骤失败只 console.error, 不 throw (D 触发不能阻塞主对话流)
 */

import {
  storeHumanJudgment,
  findRecentSimilarDecisions,
  type HumanJudgment,
  initializeValueStore,
} from './human-value-store.js';
import { distillFromConversation, detectIfWorthStoring, type DistillTurn } from './distill-prompt.js';
import { evolveNewJudgment } from './evolve-judgment.js';

export interface DetectHookOptions {
  channelId?: string;
  source?: 'explicit' | 'implicit' | 'trajectory';
  minConfidence?: number;
  /** 跳过 24h 去重窗口 (测试用) */
  skipDedup?: boolean;
}

export interface DetectHookResult {
  triggered: boolean;
  reason: string;
  judgment?: HumanJudgment;
  evolved?: {
    merged: number;
    superseded: number;
  };
  /** 当 triggered=false 且 reason 含 "duplicate" 时, 旧判断力的 id */
  duplicateOfId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * D 路径节流: channel 维度 5min 节流, 防 LLM 反复触发
 * 返回 true = 可以触发; false = 在节流窗口内
 */
const dThrottleMap: Map<string, number> = new Map();

export function throttleDHook(channelId: string, minMs: number = 5 * 60_000): boolean {
  const last = dThrottleMap.get(channelId) || 0;
  if (Date.now() - last < minMs) return false;
  dThrottleMap.set(channelId, Date.now());
  return true;
}

export function clearDHookThrottle(channelId?: string): void {
  if (channelId) dThrottleMap.delete(channelId);
  else dThrottleMap.clear();
}

export async function detectAndDistillFromChannel(
  turns: DistillTurn[],
  options: DetectHookOptions = {}
): Promise<DetectHookResult> {
  // D 路径默认 confidence 0.75 (B 路径保持 0, 因为人已经点了按钮 = 显式信任)
  const minConfidence = options.minConfidence ?? 0.75;

  try {
    await initializeValueStore();

    const detection = await detectIfWorthStoring(turns);
    if (!detection.worth) {
      return { triggered: false, reason: `D1 skipped: ${detection.reason}` };
    }

    const distillResult = await distillFromConversation(turns);
    if (!distillResult.value) {
      return { triggered: false, reason: 'D2 distilled to null' };
    }

    if (distillResult.confidence < minConfidence) {
      return {
        triggered: false,
        reason: `D2 confidence too low: ${distillResult.confidence}`,
      };
    }

    // 24h 滑窗去重: 同 channel 撞 hash 直接 skip
    if (!options.skipDedup) {
      const dups = await findRecentSimilarDecisions(distillResult.value, DAY_MS, {
        status: 'all',
        channelId: options.channelId,
      });
      if (dups.length > 0) {
        return {
          triggered: false,
          reason: 'duplicate within 24h',
          duplicateOfId: dups[0].id,
        };
      }
    }

    const judgment = await storeHumanJudgment({
      decision: distillResult.value,
      decision_type: 'approve',
      reasons: distillResult.evidence ? [distillResult.evidence] : [],
      values_derived: [],
      context: {
        domain: options.channelId ? `channel:${options.channelId}` : 'general',
        complexity: 'moderate',
        stakes: 'medium',
        time_pressure: 'low',
      },
      metadata: {
        source: options.source ?? 'implicit',
        confidence: distillResult.confidence,
        revisable: true,
      },
    });

    let evolved = { merged: 0, superseded: 0 };
    try {
      const outcome = await evolveNewJudgment(judgment);
      evolved = {
        merged: outcome.merged.length,
        superseded: outcome.contradicted.length,
      };
    } catch (err) {
      console.warn('[detect-hook] evolve failed (non-fatal):', err);
    }

    return {
      triggered: true,
      reason: `D stored: ${distillResult.value.substring(0, 30)}...`,
      judgment,
      evolved,
    };
  } catch (err) {
    console.error('[detect-hook] failed:', err);
    return { triggered: false, reason: `error: ${(err as Error).message}` };
  }
}

export async function distillAndStoreFromChannel(
  turns: DistillTurn[],
  options: DetectHookOptions = {}
): Promise<DetectHookResult> {
  const minConfidence = options.minConfidence ?? 0;

  try {
    await initializeValueStore();

    const distillResult = await distillFromConversation(turns);
    if (!distillResult.value) {
      return { triggered: false, reason: 'distilled to null' };
    }

    if (distillResult.confidence < minConfidence) {
      return {
        triggered: false,
        reason: `confidence too low: ${distillResult.confidence}`,
      };
    }

    // 24h 滑窗去重 (全库扫, 不按 channel 隔离 — 同一原则跨 channel 重复属于污染)
    if (!options.skipDedup) {
      const dups = await findRecentSimilarDecisions(distillResult.value, DAY_MS, {
        status: 'all',
      });
      if (dups.length > 0) {
        return {
          triggered: false,
          reason: 'duplicate within 24h',
          duplicateOfId: dups[0].id,
        };
      }
    }

    const judgment = await storeHumanJudgment({
      decision: distillResult.value,
      decision_type: 'approve',
      reasons: distillResult.evidence ? [distillResult.evidence] : [],
      values_derived: [],
      context: {
        domain: options.channelId ? `channel:${options.channelId}` : 'general',
        complexity: 'moderate',
        stakes: 'medium',
        time_pressure: 'low',
      },
      metadata: {
        source: 'explicit',
        confidence: distillResult.confidence,
        revisable: true,
      },
    });

    let evolved = { merged: 0, superseded: 0 };
    try {
      const outcome = await evolveNewJudgment(judgment);
      evolved = {
        merged: outcome.merged.length,
        superseded: outcome.contradicted.length,
      };
    } catch (err) {
      console.warn('[detect-hook] B-evolve failed (non-fatal):', err);
    }

    return {
      triggered: true,
      reason: `B stored: ${distillResult.value.substring(0, 30)}...`,
      judgment,
      evolved,
    };
  } catch (err) {
    console.error('[detect-hook] B failed:', err);
    return { triggered: false, reason: `error: ${(err as Error).message}` };
  }
}
