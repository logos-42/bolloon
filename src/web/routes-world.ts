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
import { scanOpportunities, recordFeedback, readObservations } from '../agents/opportunity-match.js';
import { readProfile, setProfile } from '../agents/world-profile.js';
import { worldWatcherStatus } from '../agents/world-watcher.js';
import { deliverOpportunity, listInboxOpportunities, INBOX_PROTOCOL } from '../agents/opportunity-inbox.js';
import { deliverWorldCard, listWorldCards, CARD_PROTOCOL, canonicalCardPayload, type CardMedia } from '../agents/world-cards.js';
import { searchOpportunitiesForTopic, listSearchOpportunities } from '../agents/opportunity-web-search.js';
import { ed25519Sign } from '../agents/x402/paid-info-protocol.js';

function json(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function bodyOf(req: Request): any {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/** 限制输入形状: 只收明确字段, 不整个吞前端对象 */
function intentInputFromBody(body: any): any {
  // 2026-10-06 修 bug: 之前调 bodyOf(body) —— bodyOf 期望 Request 访问 .body,
  //   传 body 对象本身时 req.body = body.body = undefined ⇒ 永远返回 {} ⇒ 所有字段都丢。
  //   body 此刻已是 express.json 解析后的对象, 直接校验即可。
  const b = body && typeof body === 'object' ? body : {};
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
    // 2026-10-16: 通讯录卡片 — dids=<did1>,<did2> 只返回这些 provider 投递的机会 (手机号通讯录联系人)
    const providerDids = typeof req.query.dids === 'string'
      ? req.query.dids.split(',').map((d) => d.trim()).filter(Boolean)
      : [];
    const r = await scanOpportunities({
      minScore: Number.isFinite(minScore) ? minScore : 0.4,
      limit,
      providerDids: providerDids.length ? providerDids : undefined,
    });
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

  // ── 用户画像 (leo 三条分发规划③: 初始化收集 → 常驻意图推送) ─────────────────
  app.get('/api/world/profile', async (_req, res) => {
    const profile = await readProfile();
    json(res, 200, { ok: true, profile });
  });

  app.put('/api/world/profile', async (req, res) => {
    const b = bodyOf(req);
    const r = await setProfile({
      name: typeof b.name === 'string' ? b.name : undefined,
      about: typeof b.about === 'string' ? b.about : undefined,
      tags: Array.isArray(b.tags) ? b.tags.filter((t: unknown): t is string => typeof t === 'string') : undefined,
    });
    json(res, r.ok ? 200 : 400, { ok: r.ok, profile: r.profile, error: r.error });
  });

  // ── 世界观察器状态 (自动触发机制可见性) ─────────────────────────────────────
  app.get('/api/world/watch', async (_req, res) => {
    const status = worldWatcherStatus();
    const observations = await readObservations(20);
    json(res, 200, { ok: true, watcher: status, recentObservations: observations });
  });

  // ── 机会信箱 (2026-10-05, leo: 别人主动投来的机会 — 真实可信来源) ───────────
  // 外部 agent 用 DIAP Ed25519 身份签名投递机会声明; 验签通过才入库并进世界流。
  // 协议: POST { protocol, title, summary, refs[], provider:{did}, issuedAt } + header X-Signature
  //   signature = ed25519Sign(provider 私钥, canonicalize(上述 payload)) — 与 x402 同源 canonicalize
  app.get('/api/world/inbox', async (_req, res) => {
    const list = await listInboxOpportunities();
    json(res, 200, { ok: true, count: list.length, opportunities: list });
  });

  app.post('/api/world/inbox', async (req, res) => {
    const b = bodyOf(req);
    const sig = typeof req.headers['x-signature'] === 'string' ? req.headers['x-signature'] : '';
    const payload = {
      protocol: typeof b.protocol === 'string' ? b.protocol : '',
      title: typeof b.title === 'string' ? b.title : '',
      summary: typeof b.summary === 'string' ? b.summary : '',
      refs: Array.isArray(b.refs) ? b.refs.filter((r: unknown): r is string => typeof r === 'string') : [],
      provider: {
        did: typeof b.provider?.did === 'string' ? b.provider.did : '',
        name: typeof b.provider?.name === 'string' ? b.provider.name : undefined,
      },
      issuedAt: typeof b.issuedAt === 'string' ? b.issuedAt : new Date().toISOString(),
    };
    const r = await deliverOpportunity(payload, sig);
    json(res, r.ok ? 200 : 400, { ok: r.ok, opportunity: r.opportunity, error: r.error });
  });

  // 协议说明 (外部 agent 对接用 — 怎么构造 payload / 怎么签名)
  app.get('/api/world/inbox/protocol', async (_req, res) => {
    json(res, 200, {
      ok: true,
      protocol: INBOX_PROTOCOL,
      description: '外部 agent 主动投递机会到信箱: POST /api/world/inbox, header X-Signature = Ed25519(provider 私钥, canonicalize(payload))',
      payloadFields: ['protocol', 'title', 'summary', 'refs[]', 'provider.did', 'provider.name?', 'issuedAt'],
      signature: 'ed25519Sign(providerPrivateKey, canonicalize({protocol,title,summary,refs,provider,issuedAt}))',
      verification: '本机解析 provider.did → Ed25519 公钥 → 验签; 通过才入库 (verified) 并进世界流, 否则拒绝',
    });
  });

  // ── AI 主动搜索 (2026-10-05, leo: 系统要主动上网搜机会, 非只被动响应) ─────────
  // POST /api/world/search [{topic}] → 按 topic 搜机会落 world/search/ 并进世界流
  app.post('/api/world/search', async (req, res) => {
    const b = bodyOf(req);
    const topic = typeof b.topic === 'string' && b.topic.trim() ? b.topic.trim()
      : (typeof b.text === 'string' && b.text.trim() ? b.text.trim() : '');
    if (!topic) return json(res, 400, { ok: false, error: '缺 topic (要搜什么机会)' });
    const r = await searchOpportunitiesForTopic(topic, { limit: 6 });
    json(res, r.ok ? 200 : 400, { ok: r.ok, topic, added: r.added, total: r.total, opportunities: r.results, error: r.error });
  });

  // GET /api/world/search → 已搜到的机会 (最近在前)
  app.get('/api/world/search', async (_req, res) => {
    const list = await listSearchOpportunities();
    json(res, 200, { ok: true, count: list.length, opportunities: list });
  });

  // ── 世界卡片投递 (2026-10-19: 别人/对方智能体往我世界模式传多媒体卡片) ───────
  // 外部 agent 用 DIAP Ed25519 身份签名投递世界卡片; 验签通过才入库 (~/.bolloon/world/cards/<id>.json)
  //   并进入世界流 (scanOpportunities, reason='card', 优先级最高)。
  // 卡片内容格式不限: media[] 每一项可是 text / audio / image / video (url + mime + name)。
  // 协议: bolloon-world-card/1
  //   POST payload = { id?, title, summary, media[], provider:{did}, issuedAt }
  //   signature = ed25519Sign(privateKey, canonicalCardPayload(payload))
  app.post('/api/world/cards/push', async (req, res) => {
    const b = bodyOf(req);
    const sig = typeof req.headers['x-signature'] === 'string' ? req.headers['x-signature'] : '';
    const payload: any = {
      protocol: typeof b.protocol === 'string' ? b.protocol : CARD_PROTOCOL,
      id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : undefined,
      title: typeof b.title === 'string' ? b.title : '',
      summary: typeof b.summary === 'string' ? b.summary : '',
      media: Array.isArray(b.media) ? b.media : [],
      scope: (typeof b.scope === 'string' && (b.scope === 'public' || b.scope === 'private')) ? b.scope : 'private',
      provider: {
        did: typeof b.provider?.did === 'string' ? b.provider.did : '',
        name: typeof b.provider?.name === 'string' ? b.provider.name : undefined,
      },
      issuedAt: typeof b.issuedAt === 'string' ? b.issuedAt : new Date().toISOString(),
    };
    const r = await deliverWorldCard(payload, sig);
    json(res, r.ok ? 200 : 400, { ok: r.ok, card: r.card, error: r.error });
  });

  app.get('/api/world/cards', async (_req, res) => {
    const list = await listWorldCards();
    json(res, 200, { ok: true, count: list.length, cards: list });
  });

  // 协议说明 (外部 agent 对接用 — 怎么构造 payload / 怎么签名 / 多媒体格式)
  app.get('/api/world/cards/protocol', async (_req, res) => {
    const kp = await (async () => {
      const { generateKeyPairSync } = await import('node:crypto');
      return generateKeyPairSync('ed25519');
    })();
    const samplePriv = Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));
    const samplePub = Buffer.from(kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const body = Buffer.concat([Buffer.from([0xed, 0x01]), samplePub]);
    let num = BigInt(0);
    for (const by of body) num = num * 256n + BigInt(by);
    let out = '';
    while (num > 0n) { out = ALPHABET[Number(num % 58n)] + out; num /= 58n; }
    for (const by of body) { if (by === 0) out = '1' + out; else break; }
    const sampleDid = `did:key:z${out}`;
    const samplePayload = {
      protocol: CARD_PROTOCOL,
      title: '对方制作的设计稿卡片',
      summary: '请查收本周 UI 设计稿，含原文与视频预览。',
      media: [
        { type: 'text', url: 'https://example.com/design.md', mime: 'text/markdown', name: 'design.md' },
        { type: 'image', url: 'https://example.com/preview.png', mime: 'image/png', name: 'preview.png' },
        { type: 'video', url: 'https://example.com/demo.mp4', mime: 'video/mp4', name: 'demo.mp4' },
      ] as CardMedia[],
      scope: 'public' as const,
      provider: { did: sampleDid, name: '对方智能体' },
      issuedAt: new Date().toISOString(),
    };
    const sampleSig = await ed25519Sign(samplePriv, canonicalCardPayload(samplePayload));
    json(res, 200, {
      ok: true,
      protocol: CARD_PROTOCOL,
      description: '外部/对方智能体主动投递世界卡片到本机世界模式: POST /api/world/cards/push, header X-Signature = Ed25519(provider 私钥, canonicalCardPayload(payload))',
      payloadFields: ['protocol', 'id?', 'title', 'summary', 'media[]', 'scope?', 'provider.did', 'provider.name?', 'issuedAt'],
      mediaTypes: ['text', 'audio', 'image', 'video'],
      scopes: ['public (公域广播, 任何节点可收)', 'private (缺省, 好友定向)'],
      signature: 'ed25519Sign(providerPrivateKey, canonicalCardPayload({protocol,id,title,summary,media,scope,provider,issuedAt}))',
      verification: '本机解析 provider.did → Ed25519 公钥 → 验签; 通过才入库 (verified) 并进世界流(优先级最高), 否则拒绝',
      sample: { payload: samplePayload, signature: sampleSig, did: sampleDid },
    });
  });
}