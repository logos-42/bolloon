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
}

export interface InjectionGateResult {
  systemAddition: string;
  usedIds: string[];
  matchedCount: number;
}

export const DEFAULT_INJECTION_CONFIG = {
  topN: 3,
  mode: 'standard' as 'concise' | 'standard',
  skip: false,
};

/**
 * 注入门主函数: 给定用户输入, 返回要追加到 system prompt 的文本 + 用到的判断力 id
 *
 * 静默: 任意步骤失败返回空字符串, 不 throw (主对话不阻塞)
 */
export async function injectJudgmentGate(
  userInput: string,
  ctx: { channelId?: string; domain?: string } = {},
  options: InjectionGateOptions = {}
): Promise<InjectionGateResult> {
  const cfg = { ...DEFAULT_INJECTION_CONFIG, ...options };
  if (cfg.skip || !userInput || userInput.trim().length === 0) {
    return { systemAddition: '', usedIds: [], matchedCount: 0 };
  }

  try {
    // 1. 拉相关价值观 (已带 weight 排序, Top 10)
    const values = await getRelevantValues(userInput, ctx.domain);
    if (values.length === 0) {
      return { systemAddition: '', usedIds: [], matchedCount: 0 };
    }

    // 2. 选 Top N (按 weight desc)
    const top = values.slice(0, cfg.topN);

    // 3. 从顶层权重出发, 反查对应的 judgment id (供回溯记录)
    //    同一 category+value 可能来自多条 judgment, 取最近一条 active
    const usedIds = await resolveJudgmentIds(top);

    // 4. 拼注入文本
    const systemAddition = formatInjection(top, cfg.mode, usedIds.length);

    return {
      systemAddition,
      usedIds,
      matchedCount: values.length,
    };
  } catch (err) {
    console.warn('[injection-gate] failed (silent fallback):', err);
    return { systemAddition: '', usedIds: [], matchedCount: 0 };
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
  resolvedCount: number
): string {
  if (values.length === 0) return '';

  const header =
    mode === 'concise'
      ? '\n# 用户判断力原则 (自动注入, 按相关度)\n'
      : '\n# 用户的判断力原则 (自动注入, 按相关度排序)\n- 适用时主动遵守; 冲突时在回复中说明\n';

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

  return header + lines.join('\n') + footer;
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
): Promise<{ reply: string; usedIds: string[]; matchedCount: number }> {
  const gate = await injectJudgmentGate(userInput, ctx, options);
  const systemPrompt = baseSystemPrompt + gate.systemAddition;

  const reply = await llm.chat(userInput, systemPrompt);

  // 异步记录使用 (不等)
  if (gate.usedIds.length > 0) {
    recordJudgmentUsage(gate.usedIds, { channelId: ctx.channelId, userInput }).catch(
      (err) => console.warn('[injection-gate] recordJudgmentUsage async failed:', err)
    );
  }

  return { reply: reply.reply, usedIds: gate.usedIds, matchedCount: gate.matchedCount };
}
