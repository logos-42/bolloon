/**
 * opportunity-match.ts — 意图 ↔ 机会 匹配引擎 (2026-10-05, leo 四端 Intent Network 设计 P0)
 *
 * 机会源 (v1): task board (listBoard) —— 本机唯一现成的「别人发布的、可接的机会」。
 * 后续可加: 群 announce 公告 (C7)、x402 商品。
 *
 * 打分透明 (诚实原则, 不假装 ML):
 *   score = 0.5 × tagOverlap(intent.tags, opp.tags)
 *         + 0.3 × keywordHit(intent 正文 ↔ opp 文本)
 *         + 0.2 × budgetFit
 * 每个 score 都输出构成, 不许只给黑盒数字。
 */
import { listIntents, type IntentRecord } from './intent-store.js';
import { listBoard, type BoardEntry } from './task-board.js';
import type { TaskBudget } from './task-contract.js';

export interface OpportunityCandidate {
  id: string;
  intentId: string;
  source: string;
  sourceId: string;
  score: number;
  /** score 构成 (透明) */
  breakdown: { tagOverlap: number; keywordHit: number; budgetFit: number };
  title: string;
  summary: string;
  budget: string | null;
  matchTags: string[];
}

/** 从文本提取标签 (与 intent-store 同规则, 保持可对比) */
function tagsOf(text: string): string[] {
  const src = String(text || '').toLowerCase();
  const words = src.match(/[a-z][a-z0-9_-]{1,}/g) || [];
  const cjk = src.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return Array.from(new Set([...words, ...cjk]));
}

function tagOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const hit = a.filter((t) => setB.has(t));
  return hit.length / Math.max(a.length, 1);
}

function keywordHit(intentText: string, oppText: string): number {
  const words = tagsOf(intentText).filter((t) => t.length >= 3);
  if (!words.length) return 0;
  const lower = String(oppText || '').toLowerCase();
  const hit = words.filter((w) => lower.includes(w));
  return hit.length / Math.max(words.length, 1);
}

function budgetFit(intentBudget: string | null, oppBudget: TaskBudget | null): number {
  if (intentBudget === null || oppBudget === null) return 0.5; // 缺失 = 中性
  const i = Number(intentBudget) || 0;
  const o = Number(oppBudget.maxAmount) || 0;
  if (i <= 0 || o <= 0) return 0.5;
  if (o <= i) return 1; // 机会预算 ≤ 意图预算 = 付得起
  return Math.max(0, 1 - (o - i) / i); // 超出则线性衰减
}

export interface MatchOptions {
  minScore?: number;
  limit?: number;
}

/** 对全部 active 意图跑匹配 (scan 入口; 无意图 → 无匹配, 不是错误) */
export async function scanOpportunities(opts: MatchOptions = {}): Promise<{ ok: boolean; results: OpportunityCandidate[]; error?: string }> {
  const minScore = opts.minScore ?? 0.4;
  const limit = opts.limit ?? 50;
  const intents = await listIntents();
  if (!intents.ok) return { ok: false, results: [], error: intents.error };
  const active = intents.intents.filter((i) => i.status === 'active');
  if (!active.length) return { ok: true, results: [], error: undefined };

  const board = await listBoard({ openOnly: true });
  const openEntries = board.entries.filter((e) => e.claimable && e.status === 'open');

  const all: OpportunityCandidate[] = [];
  for (const intent of active) {
    for (const entry of openEntries) {
      const oppText = `${entry.capability} ${entry.instructionPreview || ''}`;
      const oppTags = tagsOf(oppText);
      const to = tagOverlap(intent.tags, oppTags);
      const kh = keywordHit(intent.text, oppText);
      const bf = budgetFit(intent.budget, entry.budget ?? null);
      const score = 0.5 * to + 0.3 * kh + 0.2 * bf;
      if (score < minScore) continue;
      all.push({
        id: `opp_${entry.announcementId.slice(0, 12)}`,
        intentId: intent.id,
        source: entry.source || 'board',
        sourceId: entry.announcementId,
        score: Math.round(score * 100) / 100,
        breakdown: {
          tagOverlap: Math.round(to * 100) / 100,
          keywordHit: Math.round(kh * 100) / 100,
          budgetFit: Math.round(bf * 100) / 100,
        },
        title: entry.capability || entry.announcementId,
        summary: entry.instructionPreview || '(无预览)',
        budget: entry.budget ? `${entry.budget.maxAmount} ${entry.budget.currency}` : null,
        matchTags: intent.tags.filter((t) => oppTags.includes(t)),
      });
    }
  }

  all.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  return { ok: true, results: all.slice(0, limit) };
}

/** 对单个意图跑匹配 (list --intent 用) */
export async function matchOneIntentText(
  text: string,
  tags: string[],
  budget: string | null,
  opts: MatchOptions = {},
): Promise<OpportunityCandidate[]> {
  const intent: IntentRecord = {
    id: 'int_adhoc', text, tags, priority: 3, budget,
    deadline: null, status: 'active', createdAt: Date.now(), updatedAt: Date.now(), matchedCount: 0,
  };
  const board = await listBoard({ openOnly: true });
  const openEntries = board.entries.filter((e) => e.claimable && e.status === 'open');
  const out: OpportunityCandidate[] = [];
  for (const entry of openEntries) {
    const oppText = `${entry.capability} ${entry.instructionPreview || ''}`;
    const oppTags = tagsOf(oppText);
    const to = tagOverlap(intent.tags, oppTags);
    const kh = keywordHit(intent.text, oppText);
    const bf = budgetFit(intent.budget, entry.budget ?? null);
    const score = 0.5 * to + 0.3 * kh + 0.2 * bf;
    if (score < (opts.minScore ?? 0.4)) continue;
    out.push({
      id: `opp_${entry.announcementId.slice(0, 12)}`,
      intentId: intent.id,
      source: entry.source || 'board',
      sourceId: entry.announcementId,
      score: Math.round(score * 100) / 100,
      breakdown: {
        tagOverlap: Math.round(to * 100) / 100,
        keywordHit: Math.round(kh * 100) / 100,
        budgetFit: Math.round(bf * 100) / 100,
      },
      title: entry.capability || entry.announcementId,
      summary: entry.instructionPreview || '(无预览)',
      budget: entry.budget ? `${entry.budget.maxAmount} ${entry.budget.currency}` : null,
      matchTags: intent.tags.filter((t) => oppTags.includes(t)),
    });
  }
  out.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  return out.slice(0, opts.limit ?? 20);
}