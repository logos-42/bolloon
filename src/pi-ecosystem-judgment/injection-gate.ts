/**
 * Judgment Injection Gate — LLM 调用前的"门"
 *
 * 作用: 在每次主对话 LLM chat() 调起前, 自动从判断力库检索 Top N
 *       相关原则, 拼到 system prompt 尾部.
 *
 * 不做的事 (留作下个迭代):
 * - 不拦 channel rename / 其他旁路 LLM 调用
 * - 不在 AI 回复后做"违反检测" (那是 P3 持续监控门)
 * - 不做 embedding 检索 (P2 替换 getRelevantValues 即可)
 *
 * 性能: 单次调用 < 5ms (关键词匹配 + 全表扫 100 条库)
 * 失败: 静默 fallback (空字符串), 主对话不阻塞
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import {
  getRelevantValues,
  loadAllJudgments,
  type HumanJudgment,
} from './human-value-store.js';
import { findRecentSimilarDecisions } from './human-value-store.js';

export interface InjectionGateOptions {
  /** Top N 原则, 默认 3 (防 prompt 膨胀) */
  topN?: number;
  /** 注入模式: concise = 一行一条, standard = 带 category */
  mode?: 'concise' | 'standard';
  /** 跳过注入 (测试用) */
  skip?: boolean;
  /**
   * 单次注入字符硬上限 (P-Action 4 + 路径 1 整合, 2026-06-15).
   * 默认 1500 字符 (≈ 375 tokens), 超限硬截断 + 加 "已截断" 标记.
   * 0 = 不限 (仅测试用).
   */
  maxChars?: number;
  /**
   * 调用方已注入的 source 标记集合 (P-Action 4 路径整合).
   * 如果传了已含 'value-store' 或 'situational', 路径 1 自动跳过避免重复注入.
   * 来源: assembleSystemPrompt 输出, pi-sdk 透传.
   */
  alreadyInjectedSources?: string[];
}

export interface InjectionGateResult {
  systemAddition: string;
  usedIds: string[];
  matchedCount: number;
  /** P-Action 4: 实际是否执行注入 (供调用方记录 / 调试) */
  didInject: boolean;
  /** P-Action 4: 跳过的原因 ('already-injected-by-xxx' | 'empty-values' | 'skip' | 'no-input') */
  skipReason: string | null;
}

export const DEFAULT_INJECTION_CONFIG = {
  topN: 3,
  mode: 'standard' as 'concise' | 'standard',
  skip: false,
  maxChars: 1500,
};

/**
 * 注入门主函数: 给定用户输入, 返回要追加到 system prompt 的文本 + 用到的判断力 id
 *
 * 静默: 任意步骤失败返回空字符串, 不 throw (主对话不阻塞)
 *
 * P-Action 4 (2026-06-15) 路径 1 整合:
 * - maxChars 默认 1500 (≈ 375 tokens), 硬上限
 * - alreadyInjectedSources 检测: 路径 2/3 已注则跳过, 避免重复
 * - 返回 didInject + skipReason 供调用方记录
 */
export async function injectJudgmentGate(
  userInput: string,
  ctx: { channelId?: string; domain?: string } = {},
  options: InjectionGateOptions = {}
): Promise<InjectionGateResult> {
  const cfg = { ...DEFAULT_INJECTION_CONFIG, ...options };

  // 0a. 路径整合: 调用方已通过路径 2/3 注入, 跳过
  if (cfg.alreadyInjectedSources && cfg.alreadyInjectedSources.length > 0) {
    const conflict = cfg.alreadyInjectedSources.find((s) =>
      s === 'value-store' || s === 'situational' || s === 'injection-gate'
    );
    if (conflict) {
      return {
        systemAddition: '',
        usedIds: [],
        matchedCount: 0,
        didInject: false,
        skipReason: `already-injected-by-${conflict}`,
      };
    }
  }

  // 0b. 跳过 / 空输入
  if (cfg.skip) {
    return { systemAddition: '', usedIds: [], matchedCount: 0, didInject: false, skipReason: 'skip' };
  }
  if (!userInput || userInput.trim().length === 0) {
    return { systemAddition: '', usedIds: [], matchedCount: 0, didInject: false, skipReason: 'no-input' };
  }

  try {
    // 1. 拉相关价值观 (已带 weight 排序, Top 10)
    const values = await getRelevantValues(userInput, ctx.domain);
    if (values.length === 0) {
      return { systemAddition: '', usedIds: [], matchedCount: 0, didInject: false, skipReason: 'empty-values' };
    }

    // 2. 选 Top N (按 weight desc)
    const top = values.slice(0, cfg.topN);

    // 3. 从顶层权重出发, 反查对应的 judgment id (供回溯记录)
    //    同一 category+value 可能来自多条 judgment, 取最近一条 active
    const usedIds = await resolveJudgmentIds(top);

    // 4. 拼注入文本 (P-Action 4: 加 maxChars 硬上限 + source 标记)
    const systemAddition = formatInjection(top, cfg.mode, usedIds.length, cfg.maxChars);

    return {
      systemAddition,
      usedIds,
      matchedCount: values.length,
      didInject: true,
      skipReason: null,
    };
  } catch (err) {
    console.warn('[injection-gate] failed (silent fallback):', err);
    return { systemAddition: '', usedIds: [], matchedCount: 0, didInject: false, skipReason: 'exception' };
  }
}

/**
 * 反查 judgment id: 给定 [category, value], 在 active 库中找最近一条
 * decision 包含该 value 描述的
 */
async function resolveJudgmentIds(
  values: Array<{ category: string; value: string; weight: number }>
): Promise<string[]> {
  if (values.length === 0) return [];
  try {
    const all = await loadAllJudgments();
    const active = all.filter((j) => (j.status ?? 'active') === 'active');
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const v of values) {
      // 找拥有 [category=v.category, value=v.value] 的最近一条 active judgment
      // 不依赖 decision 文本包含 v.value (那是弱约束)
      const hit = active.find(
        (j) =>
          j.values_derived.some(
            (vd) => vd.category === v.category && vd.value === v.value
          )
      );
      if (hit && !seen.has(hit.id)) {
        ids.push(hit.id);
        seen.add(hit.id);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function formatInjection(
  values: Array<{ category: string; value: string; weight: number }>,
  mode: 'concise' | 'standard',
  resolvedCount: number,
  maxChars: number = 1500
): string {
  if (values.length === 0) return '';

  // P-Action 4 (2026-06-15) 路径 1 整合: 加 source 标记, 让下游/调试可识别
  const SOURCE_TAG = '<!-- source: injection-gate -->';
  const header =
    mode === 'concise'
      ? `\n${SOURCE_TAG}\n# 用户判断力原则 (自动注入, 按相关度)\n`
      : `\n${SOURCE_TAG}\n# 用户的判断力原则 (自动注入, 按相关度排序)\n- 适用时主动遵守; 冲突时在回复中说明\n`;

  const lines = values.map((v, i) => {
    if (mode === 'concise') {
      return `${i + 1}. [${v.category}] ${v.value}`;
    }
    return `${i + 1}. [${v.category} · weight=${v.weight.toFixed(2)}] ${v.value}`;
  });

  const footer =
    resolvedCount > 0
      ? `\n# (本轮注入了 ${resolvedCount} 条具体判断力, 已记录以便回溯)\n`
      : '\n';

  let result = header + lines.join('\n') + footer;

  // P-Action 4: maxChars 硬上限 (默认 1500 ≈ 375 tokens)
  // 2026-06-15 修: 截断标记从字面量 "...(注入已截断)" 改为 LLM 友好的结构化注释,
  //   防止 LLM 把局部截断误判为"整个用户输入被截断"产生幻觉 (典型症状: 0 tool calls)
  if (maxChars > 0 && result.length > maxChars) {
    result =
      result.substring(0, maxChars) +
      '\n\n[System Note: The above judgment candidates list was truncated due to length limits. This is expected background context, not a sign that the user\'s request was truncated. Continue normally with the user\'s actual request, which is provided elsewhere in the prompt.]';
  }
  return result;
}

// ============================================================
// 使用记录 (回溯): AI 实际"用了"哪些判断力
// ============================================================

const USAGE_LOG = (os.homedir() || '/tmp') + '/.bolloon/human-values/usage.jsonl';

export async function recordJudgmentUsage(
  usedIds: string[],
  meta: { channelId?: string; userInput?: string }
): Promise<void> {
  if (usedIds.length === 0) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      channelId: meta.channelId ?? null,
      userInputPreview: (meta.userInput ?? '').substring(0, 80),
      usedIds,
    };
    await fs.appendFile(USAGE_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[injection-gate] recordJudgmentUsage failed:', err);
  }
}

/**
 * 给定 channelId, 取最近 N 条 usage 记录 (UI 显示用)
 */
export async function getRecentUsage(
  channelId?: string,
  limit: number = 20
): Promise<Array<{ ts: string; channelId: string | null; userInputPreview: string; usedIds: string[] }>> {
  try {
    const content = await fs.readFile(USAGE_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const parsed = lines
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean) as Array<{ ts: string; channelId: string | null; userInputPreview: string; usedIds: string[] }>;

    const filtered = channelId
      ? parsed.filter((p) => p.channelId === channelId)
      : parsed;
    return filtered.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// ============================================================
// 便捷包装: 调 LLM + 注入门 + 记录回溯 (调用方接入用)
// ============================================================

/**
 * 一步完成: 注入门 → 调 LLM → 记录 usage
 * 调用方传入 LLM 实例 (duck-typed: { chat(message, systemPrompt) })
 *
 * - 默认 topN=3, mode='standard' (P1 防 prompt 膨胀已内置)
 * - 任意步骤失败静默, 返回原 systemPrompt + 原始 chat 结果
 */
export async function chatWithJudgmentGate(
  llm: { chat: (message: string, systemPrompt: string) => Promise<{ reply: string }> },
  userInput: string,
  baseSystemPrompt: string,
  ctx: { channelId?: string; domain?: string } = {},
  options: InjectionGateOptions = {}
): Promise<{ reply: string; usedIds: string[]; matchedCount: number; didInject: boolean; skipReason: string | null }> {
  const gate = await injectJudgmentGate(userInput, ctx, options);
  const systemPrompt = baseSystemPrompt + gate.systemAddition;

  const reply = await llm.chat(userInput, systemPrompt);

  // 异步记录使用 (不等, 仅在确实注入了时)
  if (gate.usedIds.length > 0) {
    recordJudgmentUsage(gate.usedIds, { channelId: ctx.channelId, userInput }).catch(
      (err) => console.warn('[injection-gate] recordJudgmentUsage async failed:', err)
    );
  }

  return {
    reply: reply.reply,
    usedIds: gate.usedIds,
    matchedCount: gate.matchedCount,
    didInject: gate.didInject,
    skipReason: gate.skipReason,
  };
}
