/**
 * 演化对齐 (Evolution Alignment)
 *
 * 算法流程:
 * 1. 取所有 status='active' 的判断力
 * 2. 算 Jaccard 字符级相似度:
 *    - > 0.85: 直接 merge (不调 LLM)
 *    - < 0.3: 视为 unrelated (不调 LLM)
 *    - 0.3-0.85: 收集进 LLM 候选,按相似度 Top 10 送 LLM
 * 3. LLM 判定 merge/contradict/unrelated
 * 4. 应用结果: 旧条 status='superseded', supersededBy=newJudgment.id, evolutionReason, evolvedAt
 *
 * 防抖: 同 channel 1 分钟内重复调用直接 return
 */

import {
  HumanJudgment,
  batchUpdateJudgments,
  listJudgmentsByStatus,
} from './human-value-store.js';
import { evolveWithLLM } from './distill-prompt.js';
import { logEvolution } from './adaptive-scan.js';

export interface EvolveOptions {
  maxLLMCompare?: number;
  jaccardHighThreshold?: number;
  jaccardLowThreshold?: number;
  skipDebounce?: boolean;
}

export interface EvolveOutcome {
  newJudgment: HumanJudgment;
  merged: HumanJudgment[];
  contradicted: HumanJudgment[];
  unrelated: number;
  llmCompared: number;
}

const debounceMap: Map<string, number> = new Map();
const DEBOUNCE_MS = 60_000;

/**
 * 节流 key 归一化 (2026-10-19 修, leo: 「继续深挖并且补缺口」):
 * detect-hook 存的 judgment 是 `context.domain = 'channel:<id>'`, **没有** `context.channelId` 字段
 * ⇒ 旧代码只读 `context.channelId` ⇒ D 路径每次都拿到 undefined ⇒ **debounce 永不生效**,
 * 每次 D 存储都全量 jaccard 扫库 + 可能调 LLM。现在两种形状都认。
 */
export function channelKeyOf(j: Pick<HumanJudgment, 'context'>): string | undefined {
  const ctx = (j?.context ?? {}) as unknown as Record<string, unknown>;
  const direct = typeof ctx.channelId === 'string' && ctx.channelId ? ctx.channelId : undefined;
  if (direct) return direct;
  const domain = typeof ctx.domain === 'string' ? ctx.domain : '';
  return domain.startsWith('channel:') ? domain.slice('channel:'.length) : undefined;
}

export async function evolveNewJudgment(
  newJudgment: HumanJudgment,
  options: EvolveOptions = {}
): Promise<EvolveOutcome> {
  const maxLLMCompare = options.maxLLMCompare ?? 10;
  const highTh = options.jaccardHighThreshold ?? 0.85;
  const lowTh = options.jaccardLowThreshold ?? 0.3;

  const channelId = channelKeyOf(newJudgment);
  if (!options.skipDebounce && channelId) {
    const last = debounceMap.get(channelId) || 0;
    if (Date.now() - last < DEBOUNCE_MS) {
      return {
        newJudgment,
        merged: [],
        contradicted: [],
        unrelated: 0,
        llmCompared: 0,
      };
    }
    debounceMap.set(channelId, Date.now());
  }

  const allActive = await listJudgmentsByStatus('active');
  const candidates = allActive.filter((j) => j.id !== newJudgment.id);

  const newValue = newJudgment.decision;
  const merged: HumanJudgment[] = [];
  const llmCandidates: Array<{ id: string; value: string; jaccard: number }> = [];
  let unrelatedCount = 0;

  for (const old of candidates) {
    const j = jaccardSimilarity(newValue, old.decision);
    if (j > highTh) {
      merged.push(old);
    } else if (j >= lowTh) {
      llmCandidates.push({ id: old.id, value: old.decision, jaccard: j });
    } else {
      unrelatedCount++;
    }
  }

  llmCandidates.sort((a, b) => b.jaccard - a.jaccard);
  const llmBatch = llmCandidates.slice(0, maxLLMCompare);

  let contradicted: HumanJudgment[] = [];
  if (llmBatch.length > 0) {
    try {
      const llmResult = await evolveWithLLM(
        newValue,
        llmBatch.map((c) => ({ id: c.id, value: c.value }))
      );

      const contradictedIds = new Set<string>();

      for (const rel of llmResult.relations) {
        if (rel.relation === 'contradict') {
          contradictedIds.add(rel.id);
        }
        if (rel.relation === 'merge' || rel.relation === 'contradict') {
          const old = candidates.find((c) => c.id === rel.id);
          if (old && !merged.find((m) => m.id === rel.id)) {
            merged.push(old);
          }
        }
      }

      const now = new Date().toISOString();
      const toSupersede: HumanJudgment[] = [];

      for (const old of merged) {
        const reason: 'merged' | 'contradicted' = contradictedIds.has(old.id) ? 'contradicted' : 'merged';
        toSupersede.push({
          ...old,
          status: 'superseded',
          supersededBy: newJudgment.id,
          evolutionReason: reason,
          evolvedAt: now,
        });
      }

      contradicted = candidates.filter((c) => contradictedIds.has(c.id));

      if (toSupersede.length > 0) {
        await batchUpdateJudgments(
          toSupersede.map((j) => ({
            id: j.id,
            patch: {
              status: 'superseded',
              supersededBy: newJudgment.id,
              evolutionReason: j.evolutionReason,
              evolvedAt: j.evolvedAt,
            },
          }))
        );
      }
    } catch (err) {
      console.warn('[evolve-judgment] LLM evolve failed, keep high-jaccard merges only:', err);
      const now = new Date().toISOString();
      if (merged.length > 0) {
        await batchUpdateJudgments(
          merged.map((j) => ({
            id: j.id,
            patch: {
              status: 'superseded' as const,
              supersededBy: newJudgment.id,
              evolutionReason: 'merged' as const,
              evolvedAt: now,
            },
          }))
        );
      }
    }
  } else if (merged.length > 0) {
    const now = new Date().toISOString();
    await batchUpdateJudgments(
      merged.map((j) => ({
        id: j.id,
        patch: {
          status: 'superseded' as const,
          supersededBy: newJudgment.id,
          evolutionReason: 'merged' as const,
          evolvedAt: now,
        },
      }))
    );
  }

  // 2026-10-19 (leo: 「继续深挖并且补缺口」): merge/supersede/contradict 动作**写 evolution.jsonl 留痕** ——
  //   evolution.jsonl 是设计中的 audit/回滚源, 但旧实现只有 adaptive-scan 的启动扫描记录, 演化动作
  //   只 return 给调用方 (detect-hook 收到后仅 console.log) ⇒ "演化到底跑没跑"只能翻 judgments.json 翻 status。
  //   形状沿用 bootstrap/adaptive-apply 的**合成 suggestion** 惯例 (kind 占位 + `evolve:` key 前缀可检索),
  //   不改 EvolutionEntry 类型; logEvolution 自带注入扫描与 try/catch, 留痕失败绝不影响演化本身。
  try {
    if (merged.length > 0 || contradicted.length > 0 || llmBatch.length > 0) {
      await logEvolution({
        ts: new Date().toISOString(),
        action: 'accept',   // 系统自动执行的演化, 用 accept 与 bootstrap 扫描记录同语义
        suggestion: {
          key: `evolve:${newJudgment.id}`,
          kind: 'unused',   // 占位 (SuggestionKind 枚举无 evolve 族; 靠 key 前缀区分)
          judgmentId: newJudgment.id,
          decision: newJudgment.decision.slice(0, 80),
          reason: [
            `evolve: merged=${merged.length}`,
            `contradicted=${contradicted.length}`,
            `unrelated=${unrelatedCount}`,
            `llmCompared=${llmBatch.length}`,
            merged.length ? `supersededIds=${merged.map((m) => m.id).join(',')}` : '',
          ].filter(Boolean).join(' '),
          action: 'review',
          hint: '判断力演化留痕 (自动): 新条目入库后与库内 active 条比对, merge/contradict 的旧条已置 superseded; 详情见本条 judgment 的 supersededBy 反查。',
          metrics: { usage7d: 0, usage30d: 0, daysSinceLastUse: 0, totalUsage: 0 },
          scannedAt: new Date().toISOString(),
        },
      });
    }
  } catch { /* 留痕失败不影响演化 */ }

  return {
    newJudgment,
    merged,
    contradicted,
    unrelated: unrelatedCount,
    llmCompared: llmBatch.length,
  };
}

export function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\s,.，。、！？!?""''()（）:：;；\-—_]/g, '')
      .trim();

  const textA = normalize(a);
  const textB = normalize(b);

  if (textA.length === 0 || textB.length === 0) return 0;

  // 短句 (< 8 字符): 字符级 bigram, 防止"先校验再写"vs"写入前先校验"全 0
  // 长句: 单字 set, 避免 bigram 集合爆炸
  const grams = (s: string): Set<string> => {
    if (s.length < 8) {
      const out = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
      for (const c of s) out.add(c);
      return out;
    }
    return new Set(s);
  };

  const setA = grams(textA);
  const setB = grams(textB);

  let inter = 0;
  for (const c of setA) {
    if (setB.has(c)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function clearEvolveDebounce(): void {
  debounceMap.clear();
}
