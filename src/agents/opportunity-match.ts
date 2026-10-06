/**
 * opportunity-match.ts — 意图 ↔ 机会 匹配引擎 (2026-10-05, leo Intent Network P0)
 *
 * ★ 设计原则 (leo 2026-10-05 三次纠偏): **自动校准, 不是「输入→扫描→结果」**。
 *   · 默认就是匹配状态: 没有 intent 也流入**世界变化流** (最近的 open 公告, 按新鲜度),
 *     不是「等待意图声明」的空态 —— 打开即有内容。
 *   · 匹配随交互越来越准: ignore/accept 写 `world/memory/feedback.json` (负/正证据),
 *     已忽略的同源公告不再流入; 是持续的校准环, 不依赖任何按钮。
 *   · 机会源 v1: task board (listBoard, 本地 + 注册表)。后续: 群 announce / x402 商品。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { listIntents, worldDir, type IntentRecord } from './intent-store.js';
import { listBoard, type BoardEntry } from './task-board.js';
import { readProfile } from './world-profile.js';
import type { TaskBudget } from './task-contract.js';

export interface OpportunityCandidate {
  id: string;
  intentId: string | null;
  source: string;
  sourceId: string;
  score: number;
  /** 为什么推给你: 'match' = 意图匹配 · 'world' = 世界变化 · 'inbox' = 外部 agent 投递 (信箱) */
  reason: 'match' | 'world' | 'inbox';
  title: string;
  summary: string;
  budget: string | null;
  matchTags: string[];
  createdAt: number;
  /** 信箱机会的来源可验信息 (provider DID + 验签状态) — 别人主动投来的, 不是本机自产 */
  inbox?: { providerDid: string; providerName?: string; verification: string; refs: string[] };
}

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
  if (o <= i) return 1;
  return Math.max(0, 1 - (o - i) / i);
}

// ── Memory 反馈 (校准环) ─────────────────────────────────────────────────────
// 落 world/memory/feedback.json: { ignored: [sourceId...], accepted: [sourceId...] }
interface FeedbackFile { version: 1; ignored: string[]; accepted: string[] }

const feedback = (): string => path.join(worldDir(), 'memory', 'feedback.json');

// ── 世界观察日志 (2026-10-05, leo: 机会进入 AI 视野是主动性行为) ──────────────
// 每次扫描 = AI 睁眼观察世界; 看到高分机会就记一条观察 (world/memory/events.jsonl)。
// 这是「AI 自动观察」的落点: 不是人看了记, 是扫描这个动作自己留下视野记录。
const eventsFile = (): string => path.join(worldDir(), 'memory', 'events.jsonl');

export interface WorldObservation {
  ts: number;
  kind: 'opportunity-seen' | 'world-change';
  sourceId: string;
  title: string;
  score: number;
  reason: 'match' | 'world' | 'inbox';
}

/** 追加一条观察 (尽力而为, 失败不阻断扫描) */
export async function noteObservation(obs: WorldObservation): Promise<void> {
  try {
    await fs.mkdir(path.dirname(eventsFile()), { recursive: true });
    await fs.appendFile(eventsFile(), JSON.stringify(obs) + '\n', { mode: 0o600 });
  } catch { /* 观察记录失败不阻断 */ }
}

/** 读观察日志 (最近 N 条, 倒序) */
export async function readObservations(limit = 50): Promise<WorldObservation[]> {
  try {
    const raw = await fs.readFile(eventsFile(), 'utf-8');
    const lines = raw.split('\n').filter(Boolean).slice(-limit * 2);
    const out: WorldObservation[] = [];
    for (const l of lines) {
      try {
        const p = JSON.parse(l) as WorldObservation;
        if (p && typeof p === 'object' && typeof p.sourceId === 'string') out.push(p);
      } catch { /* 坏行跳过 */ }
    }
    return out.slice(-limit).reverse();
  } catch { return []; }
}

async function readFeedback(): Promise<FeedbackFile> {
  try {
    const raw = await fs.readFile(feedback(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FeedbackFile>;
    return { version: 1, ignored: Array.isArray(parsed.ignored) ? parsed.ignored : [], accepted: Array.isArray(parsed.accepted) ? parsed.accepted : [] };
  } catch {
    return { version: 1, ignored: [], accepted: [] };
  }
}

async function writeFeedback(fb: FeedbackFile): Promise<void> {
  try {
    await fs.mkdir(path.dirname(feedback()), { recursive: true });
    await fs.writeFile(feedback(), JSON.stringify(fb, null, 2) + '\n', { mode: 0o600 });
  } catch { /* 反馈写失败不阻断 (尽力而为) */ }
}

/** 记录交互反馈 (校准环): ignore → 负证据 (同源不再流入), accept → 正证据 */
export async function recordFeedback(action: 'ignore' | 'accept', sourceId: string): Promise<{ ok: boolean; error?: string }> {
  const sid = String(sourceId || '').trim();
  if (!sid) return { ok: false, error: '缺 sourceId' };
  const fb = await readFeedback();
  if (action === 'ignore') {
    if (!fb.ignored.includes(sid)) fb.ignored.push(sid);
    fb.accepted = fb.accepted.filter((s) => s !== sid);
  } else {
    if (!fb.accepted.includes(sid)) fb.accepted.push(sid);
    fb.ignored = fb.ignored.filter((s) => s !== sid);
  }
  await writeFeedback(fb);
  return { ok: true };
}

export interface MatchOptions {
  minScore?: number;
  limit?: number;
}

function candidateOf(entry: BoardEntry, intentId: string | null, score: number, reason: 'match' | 'world', matchTags: string[]): OpportunityCandidate {
  return {
    id: `opp_${entry.announcementId.slice(0, 12)}`,
    intentId,
    source: entry.source || 'board',
    sourceId: entry.announcementId,
    score,
    reason,
    title: entry.capability || entry.announcementId,
    summary: entry.instructionPreview || '(无预览)',
    budget: entry.budget ? `${entry.budget.maxAmount} ${entry.budget.currency}` : null,
    matchTags,
    createdAt: entry.createdAt ?? Date.now(),
  };
}

/**
 * 扫描 = **默认世界流 + 意图校准** (leo: 默认匹配状态, 不用先声明)。
 *   · 无意图: 流入最近 open 公告 (新鲜度优先) —— 打开即有内容
 *   · 有意图: 匹配(`match`)优先浮上来, 其余世界变化按新鲜度垫底 (世界不停)
 *   · 已忽略的同源公告不流入 (随交互越来越准)
 *   · 机会信箱 (外部 agent 投递, 验签通过) 恒优先 —— 真实可信来源
 */
async function mergeInboxOnTop(all: OpportunityCandidate[]): Promise<OpportunityCandidate[]> {
  const { listInboxOpportunities } = await import('./opportunity-inbox.js');
  const inboxOpps = await listInboxOpportunities();
  const inboxCards: OpportunityCandidate[] = inboxOpps
    .filter((o) => o.verification === 'verified') // 只放行验签通过的
    .map((o) => ({
      id: o.id,
      intentId: null,
      source: 'inbox',
      sourceId: o.id,
      score: 0.9,
      reason: 'inbox',
      title: o.title,
      summary: o.summary,
      budget: null,
      matchTags: [],
      createdAt: o.receivedAt,
      inbox: { providerDid: o.provider.did, providerName: o.provider.name, verification: o.verification, refs: o.refs },
    }));
  for (const c of inboxCards.slice(0, 10)) {
    void noteObservation({ ts: Date.now(), kind: 'opportunity-seen', sourceId: c.sourceId, title: c.title, score: c.score, reason: 'inbox' });
  }
  return [...inboxCards, ...all]; // 信箱在最前 (外部主动投递 = 最该看)
}

export async function scanOpportunities(opts: MatchOptions = {}): Promise<{ ok: boolean; results: OpportunityCandidate[]; error?: string }> {
  const limit = opts.limit ?? 50;
  const minScore = opts.minScore ?? 0.2;
  const intents = await listIntents();
  if (!intents.ok) return { ok: false, results: [], error: intents.error };
  const active = intents.intents.filter((i) => i.status === 'active');
  const fb = await readFeedback();

  const board = await listBoard({ openOnly: true });
  const openEntries = board.entries
    .filter((e) => e.claimable && e.status === 'open')
    .filter((e) => !fb.ignored.includes(e.announcementId)); // 校准: 忽略过的不再来
  const now = Date.now();

  if (!active.length) {
    // 画像流: 有用户画像 → 画像标签当常驻意图 (reason=match, 初始化阶段的推送)
    // 无画像 → 默认世界流 (新鲜度优先, 打开即有内容)
    const profile = await readProfile();
    const profileTags = profile?.tags?.filter((t) => t && t.length >= 2) ?? [];
    if (profileTags.length) {
      const matched: OpportunityCandidate[] = [];
      for (const entry of openEntries) {
        const oppText = `${entry.capability} ${entry.instructionPreview || ''}`;
        const oppTags = tagsOf(oppText);
        const to = tagOverlap(profileTags, oppTags);
        const kh = keywordHit(profile?.about ?? '', oppText);
        const bf = 0.5; // 画像无预算信息 → 中性
        const score = 0.5 * to + 0.3 * kh + 0.2 * bf;
        if (score < 0.15) continue;
        matched.push(candidateOf(entry, null, Math.round(score * 100) / 100, 'match', profileTags.filter((t) => oppTags.includes(t))));
      }
      const matchedIds = new Set(matched.map((m) => m.sourceId));
      const unmatched = openEntries
        .filter((e) => !matchedIds.has(e.announcementId))
        .map((e) => {
          const ageDays = e.createdAt ? (now - e.createdAt) / 86400000 : 1;
          const freshness = Math.max(0.3, Math.min(0.7, 1 - ageDays / 30));
          return candidateOf(e, null, Math.round(freshness * 100) / 100, 'world', []);
        });
      const all = [...matched, ...unmatched].sort((a, b) => {
        const rank = (r: string): number => (r === 'match' ? 0 : 1);
        if (rank(a.reason) !== rank(b.reason)) return rank(a.reason) - rank(b.reason);
        return b.score - a.score;
      });
      // 世界观察: 画像流看到的机会也记 memory
      for (const c of all.filter((x) => x.reason === 'match').slice(0, 10)) {
        void noteObservation({ ts: Date.now(), kind: 'opportunity-seen', sourceId: c.sourceId, title: c.title, score: c.score, reason: 'match' });
      }
      return { ok: true, results: (await mergeInboxOnTop(all)).slice(0, limit) };
    }
    // 默认世界流: 新鲜度优先
    const sorted = [...openEntries].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const out = sorted.slice(0, limit).map((e) => {
      const ageDays = e.createdAt ? (now - e.createdAt) / 86400000 : 1;
      const freshness = Math.max(0.5, Math.min(0.95, 1 - ageDays / 30));
      return candidateOf(e, null, Math.round(freshness * 100) / 100, 'world', []);
    });
    out.sort((a, b) => b.createdAt - a.createdAt || b.score - a.score);
    // 世界观察: AI 睁眼看到的变化, 记进 memory (自动, 不是人触发)
    for (const c of out.slice(0, 10)) {
      void noteObservation({ ts: Date.now(), kind: 'world-change', sourceId: c.sourceId, title: c.title, score: c.score, reason: 'world' });
    }
    return { ok: true, results: (await mergeInboxOnTop(out)).slice(0, limit) };
  }

  // 有意图: 匹配打分, match 优先; 世界变化不消失
  const matches: OpportunityCandidate[] = [];
  for (const intent of active) {
    for (const entry of openEntries) {
      const oppText = `${entry.capability} ${entry.instructionPreview || ''}`;
      const oppTags = tagsOf(oppText);
      const to = tagOverlap(intent.tags, oppTags);
      const kh = keywordHit(intent.text, oppText);
      const bf = budgetFit(intent.budget, entry.budget ?? null);
      const score = 0.5 * to + 0.3 * kh + 0.2 * bf;
      if (score < minScore) continue;
      matches.push(candidateOf(entry, intent.id, Math.round(score * 100) / 100, 'match', intent.tags.filter((t) => oppTags.includes(t))));
    }
  }
  const matchedIds = new Set(matches.map((m) => m.sourceId));
  const unmatched = openEntries
    .filter((e) => !matchedIds.has(e.announcementId))
    .map((e) => {
      const ageDays = e.createdAt ? (now - e.createdAt) / 86400000 : 1;
      const freshness = Math.max(0.3, Math.min(0.7, 1 - ageDays / 30));
      return candidateOf(e, null, Math.round(freshness * 100) / 100, 'world', []);
    });
  const all = [...matches, ...unmatched].sort((a, b) => {
    const rank = (r: string): number => (r === 'match' ? 0 : 1);
    if (rank(a.reason) !== rank(b.reason)) return rank(a.reason) - rank(b.reason);
    return b.score - a.score;
  });
  return { ok: true, results: (await mergeInboxOnTop(all)).slice(0, limit) };
}

/** 对单个意图即时匹配 (list --intent 用; 不走反馈过滤) */
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
    if (score < (opts.minScore ?? 0.2)) continue;
    out.push(candidateOf(entry, intent.id, Math.round(score * 100) / 100, 'match', intent.tags.filter((t) => oppTags.includes(t))));
  }
  out.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  return out.slice(0, opts.limit ?? 20);
}