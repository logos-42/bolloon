/**
 * routes-world.ts — World API (2026-10-05, leo 四端 Intent Network P1)
 *
 * Web PC 与 Mobile 共用的一套端点, 挂在同一数据层 (intent-store + opportunity-match):
 *   GET  /api/intents                → 意图列表 (active 在前)
 *   POST /api/intents                → 声明意图 { text, tags?, priority?, budget?, deadline? }
 *   GET  /api/intents/:id            → 单条意图
 *   DELETE /api/intents/:id          → 删意图 (?done=1 归档)
 *   GET  /api/opportunities          → 扫描匹配 → 机会卡片 (score 带构成, 透明)
 *   POST /api/opportunities/:id/ignore → 忽略 (v1: 记录)
 *
 * 设计原则: 四端共享同一份 Intent/Opportunity 数据, 端只是渲染/输入形态。
 */
import type { Express, Request, Response } from 'express';
import { setIntent, listIntents, getIntent, removeIntent } from '../agents/intent-store.js';
import { scanOpportunities, recordFeedback } from '../agents/opportunity-match.js';

function json(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function bodyOf(req: Request): any {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/** 限制输入形状: 只收明确字段, 不整个吞前端对象 */
function intentInputFromBody(body: any): any {
  const b = bodyOf(body as any);
  const out: any = {};
  if (typeof b.text === 'string' && b.text.trim()) out.text = b.text.trim();
  if (Array.isArray(b.tags)) out.tags = b.tags.filter((t: unknown) => typeof t === 'string').map(String).slice(0, 24);
  if (b.priority !== undefined) out.priority = Number(b.priority);
  if (typeof b.budget === 'string') out.budget = b.budget.trim();
  if (b.deadline !== undefined) {
    const d = typeof b.deadline === 'number' ? b.deadline : Date.parse(String(b.deadline));
    if (!Number.isNaN(d)) out.deadline = d;
  }
  return out;
}

export function registerWorldRoutes(app: Express): void {
  // ── intents ──────────────────────────────────────────────────────────────
  app.get('/api/intents', async (_req, res) => {
    const r = await listIntents();
    if (!r.ok) return json(res, 500, { error: r.error });
    const order = { active: 0, paused: 1, done: 2 } as const;
    const rows = [...r.intents].sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
    json(res, 200, { ok: true, count: rows.length, intents: rows });
  });

  app.post('/api/intents', async (req, res) => {
    const input = intentInputFromBody(req.body);
    if (!input.text) return json(res, 400, { ok: false, error: 'text 必填 (声明你现在在做什么)' });
    const r = await setIntent(input);
    if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    json(res, r.created ? 201 : 200, { ok: true, created: r.created, intent: r.intent });
  });

  app.get('/api/intents/:id', async (req, res) => {
    const r = await getIntent(req.params.id);
    if (!r.ok) return json(res, 500, { error: r.error });
    if (!r.intent) return json(res, 404, { ok: false, error: `没有意图 ${req.params.id}` });
    json(res, 200, { ok: true, intent: r.intent });
  });

  app.delete('/api/intents/:id', async (req, res) => {
    const done = req.query.done === '1' || req.query.done === 'true';
    const r = await removeIntent(req.params.id, done);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error });
    json(res, 200, { ok: true, removed: r.removed, archived: done });
  });

  // ── opportunities ────────────────────────────────────────────────────────
  app.get('/api/opportunities', async (req, res) => {
    const minScoreRaw = typeof req.query['min-score'] === 'string' ? req.query['min-score'] : '0.4';
    const minScore = Number(minScoreRaw);
    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : '50';
    const limit = Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50));
    const r = await scanOpportunities({ minScore: Number.isFinite(minScore) ? minScore : 0.4, limit });
    if (!r.ok) return json(res, 500, { ok: false, error: r.error });
    json(res, 200, { ok: true, count: r.results.length, minScore, opportunities: r.results });
  });

  app.post('/api/opportunities/:id/ignore', async (req, res) => {
    const sourceId = String(req.params.id).replace(/^opp_/, 'ann-');
    const r = await recordFeedback('ignore', sourceId);
    json(res, r.ok ? 200 : 400, { ok: r.ok, opportunityId: req.params.id, ignored: r.ok, error: r.error });
  });

  app.post('/api/opportunities/:id/accept', async (req, res) => {
    const sourceId = String(req.params.id).replace(/^opp_/, 'ann-');
    const r = await recordFeedback('accept', sourceId);
    json(res, r.ok ? 200 : 400, { ok: r.ok, opportunityId: req.params.id, accepted: r.ok, error: r.error });
  });
}