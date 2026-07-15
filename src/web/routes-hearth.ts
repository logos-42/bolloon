/**
 * routes-hearth.ts — judgeness 主路由 (2026-07-15)
 *
 * 12 路由 (前缀 `/api/hearth`):
 *   GET    /api/hearth                       健康 + 我自己的公开摘要
 *   GET    /api/hearth/discover              伙伴搜索
 *   GET    /api/hearth/cards/:id             单卡片读
 *   POST   /api/hearth/cards                 创建 (human-only)
 *   PATCH  /api/hearth/cards/:id             修改 (human override)
 *   GET    /api/hearth/visibility            隐私策略
 *   PUT    /api/hearth/visibility            改隐私
 *   GET    /api/hearth/allowlist             白名单
 *   POST   /api/hearth/allowlist             加 / 减
 *   GET    /api/hearth/peers                 peer 节点列表
 *   POST   /api/hearth/channel-autoadd       频道触发 auto-add
 *   GET    /api/hearth/{dual-mode}           Accept 协商出口 (entrance)
 *
 * Peer 4 类资源写 API (与 manifest 协议打通):
 *   POST   /api/peer-resources/groups
 *   POST   /api/peer-resources/functions
 *   POST   /api/peer-resources/exportments
 *   POST   /api/peer-resources/sciences
 *
 * 设计要点:
 *   - 防御期 (现在 → 6 月) 只挂 GET /api/hearth 一个健康端点;
 *     写 API 在相持期打开 (返回 403 if locked = 'defense' 标记).
 *   - 路由不依赖 createWebServer 闭包状态 — 与 routes-judgments.ts 一致风格.
 */

import type { Express, Request, Response } from 'express';
import type {
  JudgenessDescription,
  JudgenessPubkeyContext,
  JudgenessVisibility,
  JudgenessOpenState,
} from '../judgeness/types.js';
import {
  JUDGENESS_ROOT,
  ensureJudgenessDirs,
  listDescriptions,
  loadDescription,
  saveDescription,
  loadVisibility,
  saveVisibility,
  loadAllowlist,
  saveAllowlist,
  addAllowlistPeer,
  removeAllowlistPeer,
  newDescriptionId,
} from '../judgeness/store.js';
import {
  scrubListForAudience,
  scrubForAudience,
  resolveGate2,
  resolveGate3,
} from '../judgeness/visibility.js';
import {
  negotiateAudience,
  descriptionToJsonLd,
  descriptionToHumanHtml,
  dualRender,
} from './util/dual-mode.js';

// 防御期闸: 控制写 API 是否打开. 反攻期改为 'public'.
const DEFENSE_MODE = true;

/** 读调用方身份. 真实身份端点是 GET /api/p2p-publickey;
 *  此处取鉴权 session (human/agent + pubkey).
 *  防御期: 假定默认 human, pubkey='__self__'. */
function extractCaller(req: Request): JudgenessPubkeyContext {
  // 防御期 stub: 由 server.ts 接入鉴权后替换
  const hdr = arrToStr(req.headers['x-bolloon-pubkey']) || '__self__';
  const roleRaw = arrToStr(req.headers['x-bolloon-role']) || 'human';
  return { pubkey: hdr, role: roleRaw as 'human' | 'agent' };
}

/** express query / headers 都是 string | string[]; 取字符串 */
function arrToStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

// ---------------------------------------------------------------------------
// 主注册函数
// ---------------------------------------------------------------------------

export function registerHearthRoutes(app: Express): void {
  // 1. 健康
  app.get('/api/hearth', async (req, res) => {
    try {
      await ensureJudgenessDirs();
      const descs = await listDescriptions();
      const vis = await loadVisibility();
      const allow = await loadAllowlist();
      res.json({
        ok: true,
        service: 'judgeness-hearth',
        version: '0.3.x-jd-1',
        rootPath: JUDGENESS_ROOT(),
        descriptionCount: descs.length,
        visibilityChannels: vis.channels.length,
        allowlistCount: allow.peers.length,
        defenseMode: DEFENSE_MODE,
        ts: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. discover — 接受 q / tag / capability
  app.get('/api/hearth/discover', async (req, res) => {
    try {
      const ctx = extractCaller(req);
      const q = arrToStr(req.query['q']).toLowerCase();
      const tag = arrToStr(req.query['tag']).toLowerCase();
      const cap = arrToStr(req.query['capability']).toLowerCase();
      const all = await listDescriptions();
      const matched = all.filter((d) => {
        if (q && !(d.judgmentRef.toLowerCase().includes(q) || d.descriptionId.toLowerCase().includes(q))) return false;
        if (tag && !(d.scope.topics ?? []).some((t) => t.toLowerCase().includes(tag)) &&
            !(d.scope.domains ?? []).some((t) => t.toLowerCase().includes(tag))) return false;
        if (cap) return true; // cap 是 peer 资源维度, 防御期不连
        return true;
      });
      const scrubbed = await scrubListForAudience(matched, ctx);
      const jsonLd = scrubbed.map((s) => descriptionToJsonLd(s));
      const capInfo = { accept: arrToStr(req.headers.accept), query: req.query as Record<string, string | string[] | undefined>, userAgent: arrToStr(req.headers['user-agent']) };
      const result = dualRender(
        capInfo,
        () => {
          const cards = scrubbed.map((s) => `<li>${s.descriptionId} · ${s.visibility} · ${s.openState}</li>`).join('');
          return `<!DOCTYPE html><html><body><h1>Discover</h1><ul>${cards}</ul></body></html>`;
        },
        () => jsonLd
      );
      res.status(result.status).setHeader('Content-Type', result.contentType).send(result.body);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3. 单卡片读
  app.get('/api/hearth/cards/:id', async (req, res) => {
    try {
      const id = req.params['id'];
      const ctx = extractCaller(req);
      const d = await loadDescription(id);
      if (!d) return res.status(404).json({ error: 'description not found' });
      const scrubbed = await scrubForAudience(d, ctx);
      const result = dualRender(
        { accept: arrToStr(req.headers.accept), query: req.query as Record<string, string | string[] | undefined>, userAgent: arrToStr(req.headers['user-agent']) },
        () => descriptionToHumanHtml(scrubbed),
        () => descriptionToJsonLd(scrubbed)
      );
      res.status(result.status).setHeader('Content-Type', result.contentType).send(result.body);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. 创建卡片 (human-only, 防御期 405)
  app.post('/api/hearth/cards', gateWrite, async (req, res) => {
    try {
      const ctx = extractCaller(req);
      if (DEFENSE_MODE) return res.status(405).json({ error: 'POST /api/hearth/cards disabled in defense mode' });
      if (ctx.role !== 'human') return res.status(403).json({ error: 'human-only' });

      const body = req.body as Partial<JudgenessDescription>;
      if (!body.judgmentRef) return res.status(400).json({ error: 'judgmentRef required' });
      const vis = await loadVisibility();
      // 闸 3 校验 — 取占位 desc 用于校验
      const placeholder: JudgenessDescription = {
        descriptionId: newDescriptionId(),
        judgmentRef: body.judgmentRef,
        description_version: 1,
        facets: body.facets ?? {},
        basis: body.basis ?? {},
        scope: body.scope ?? { topics: [], domains: [] },
        visibility: body.visibility ?? vis.defaults.visibility,
        openState: body.openState ?? vis.defaults.openState,
        by: ctx.role,
        byAgentId: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const g3 = resolveGate3(placeholder, ctx, vis);
      if (!g3.allow) return res.status(403).json({ error: g3.reason });

      await saveDescription(placeholder);
      res.json({ ok: true, descriptionId: placeholder.descriptionId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. 修改卡片
  app.patch('/api/hearth/cards/:id', gateWrite, async (req, res) => {
    try {
      const ctx = extractCaller(req);
      if (DEFENSE_MODE) return res.status(405).json({ error: 'PATCH disabled in defense mode' });
      if (ctx.role !== 'human') return res.status(403).json({ error: 'human override required' });
      const id = arrToStr(req.params['id']);
      const d = await loadDescription(id);
      if (!d) return res.status(404).json({ error: 'description not found' });
      const vis = await loadVisibility();
      const g3 = resolveGate3(d, ctx, vis);
      if (!g3.allow) return res.status(403).json({ error: g3.reason });

      const body = req.body as Partial<JudgenessDescription>;
      const merged: JudgenessDescription = {
        ...d,
        facets: { ...d.facets, ...(body.facets ?? {}) },
        basis: { ...d.basis, ...(body.basis ?? {}) },
        scope: {
          domains: body.scope?.domains ?? d.scope.domains,
          topics: body.scope?.topics ?? d.scope.topics,
        },
        visibility: body.visibility ?? d.visibility,
        openState: body.openState ?? d.openState,
        updatedAt: new Date().toISOString(),
      };
      await saveDescription(merged);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. 读 visibility
  app.get('/api/hearth/visibility', async (req, res) => {
    try {
      const f = await loadVisibility();
      res.json(f);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. 写 visibility (PUT)
  app.put('/api/hearth/visibility', gateWrite, async (req, res) => {
    try {
      if (DEFENSE_MODE) return res.status(405).json({ error: 'PUT visibility disabled in defense mode' });
      const ctx = extractCaller(req);
      if (ctx.role !== 'human') return res.status(403).json({ error: 'human override required' });
      const body = req.body as any;
      if (!body || !body.version) return res.status(400).json({ error: 'invalid body' });
      await saveVisibility(body);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. 读 allowlist
  app.get('/api/hearth/allowlist', async (req, res) => {
    try {
      const f = await loadAllowlist();
      res.json(f);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 9. 改 allowlist (POST 加 / 减)
  app.post('/api/hearth/allowlist', gateWrite, async (req, res) => {
    try {
      if (DEFENSE_MODE) return res.status(405).json({ error: 'POST allowlist disabled in defense mode' });
      const ctx = extractCaller(req);
      if (ctx.role !== 'human') return res.status(403).json({ error: 'human override required' });
      const body = req.body as { action: 'add' | 'remove'; pubkey: string; alias?: string; note?: string };
      if (!body.action || !body.pubkey) return res.status(400).json({ error: 'action + pubkey required' });
      if (body.action === 'add') {
        await addAllowlistPeer({ pubkey: body.pubkey, alias: body.alias, note: body.note, addedAt: new Date().toISOString() });
      } else if (body.action === 'remove') {
        await removeAllowlistPeer(body.pubkey);
      } else {
        return res.status(400).json({ error: 'unknown action' });
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 10. 我的 peers 列表
  app.get('/api/hearth/peers', async (_req, res) => {
    try {
      const allow = await loadAllowlist();
      res.json({ peers: allow.peers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 11. channel-autoadd
  app.post('/api/hearth/channel-autoadd', gateWrite, async (req, res) => {
    try {
      if (DEFENSE_MODE) return res.status(405).json({ error: 'autoadd disabled in defense mode' });
      const body = req.body as { channelTopic: string; sourceChannelOwnerPk?: string };
      if (!body.channelTopic) return res.status(400).json({ error: 'channelTopic required' });
      const ctx = extractCaller(req);
      const g2 = await resolveGate2(body.sourceChannelOwnerPk ?? '__self__', body.channelTopic);
      if (!g2.allow) return res.status(403).json({ error: g2.reason });
      void ctx;

      // 反攻期主路径 — 防御期 stub: 仅打印 audit log
      const auditLine = JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'autoadd_request',
        channelTopic: body.channelTopic,
        sourceChannelOwnerPk: body.sourceChannelOwnerPk ?? null,
        by: ctx.role,
      }) + '\n';
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const auditPath = path.join(os.homedir(), '.bolloon', 'human-values', 'counterfactual-audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, auditLine, 'utf-8');
      res.json({ ok: true, mode: 'audit-only', reason: '反攻期 O3 才实现全自动 joinTopic' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. dual-mode entrance — GET /api/hearth/{anything}
  //     (放在所有精确路由之后; 由 Express 路由匹配先到精确路由)
  app.get(/^\/api\/hearth\/(.+)$/, async (req, res) => {
    // 只剩未匹配的子路径
    res.status(404).json({ error: 'not found', hint: 'see /api/hearth for service index' });
  });

  // ---------- Peer 4 类资源写 API (C5) ----------
  registerPeerResourceRoutes(app);
}

// ---------------------------------------------------------------------------
// 中间件: 写 API 闸
// ---------------------------------------------------------------------------

function gateWrite(_req: Request, res: Response, next: () => void): void {
  if (DEFENSE_MODE) return; // 在 handler 里直接 405
  next();
}

// ---------------------------------------------------------------------------
// Peer 4 类资源写 API
// ---------------------------------------------------------------------------

function registerPeerResourceRoutes(app: Express): void {
  // 用动态 import 避免循环依赖
  const handlers: Record<string, (app: Express) => void> = {
    groups: (a) => a.post('/api/peer-resources/groups', writePeerResource('groups')),
    functions: (a) => a.post('/api/peer-resources/functions', writePeerResource('functions')),
    exportments: (a) => a.post('/api/peer-resources/exportments', writePeerResource('exportments')),
    sciences: (a) => a.post('/api/peer-resources/sciences', writePeerResource('sciences')),
  };
  for (const k of Object.keys(handlers)) {
    try { handlers[k]!(app); } catch { /* ignore */ }
  }
}

function writePeerResource(kind: 'groups' | 'functions' | 'exportments' | 'sciences') {
  return async (req: Request, res: Response) => {
    if (DEFENSE_MODE) return res.status(405).json({ error: `POST /api/peer-resources/${kind} disabled in defense mode` });
    const ctx = extractCaller(req);
    if (ctx.role !== 'human') return res.status(403).json({ error: 'human override required' });
    try {
      // 实际写盘走 src/network/peer-fs.ts 的 addLocalGroup/Function/Exportment/Science
      // 防御期 stub: 仅 echo 入参 + 写 audit log
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const auditPath = path.join(os.homedir(), '.bolloon', 'human-values', 'counterfactual-audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      const auditLine = JSON.stringify({
        ts: new Date().toISOString(),
        kind: `peer_resource_${kind}_write`,
        body: req.body,
        by: ctx.role,
      }) + '\n';
      await fs.appendFile(auditPath, auditLine, 'utf-8');
      res.json({ ok: true, mode: 'audit-only', kind, body: req.body });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
}

// 关 lint
void ((): JudgenessVisibility => 'public');
void ((): JudgenessOpenState => 'open');
