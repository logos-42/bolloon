/**
 * routes-judgments.ts — judgments / self-improve / permission-mode 路由 (2026-07-06 抽出)
 *
 * 从 src/web/server.ts 抽出 (~750 行).
 * 不依赖 createWebServer 闭包状态 — 所有依赖从外部注入 (currentChannelId 走 query / body).
 *
 * 注册路由:
 *   POST   /api/judgments
 *   GET    /api/judgments
 *   POST   /api/judgments/distill-from-conversation
 *   POST   /api/judgments/detect-and-distill
 *   POST   /api/judgments/resolve-usage
 *   GET    /api/judgments/violations
 *   GET    /api/judgments/adaptive-suggestions
 *   POST   /api/judgments/adaptive-apply
 *   GET    /api/judgments/evolution-log
 *   GET    /api/judgments/causal/correlation
 *   GET    /api/judgments/causal/intervention
 *   POST   /api/judgments/causal/counterfactual
 *   GET    /api/judgments/causal/audit-log
 *   POST   /api/judgments/import
 *   PATCH  /api/judgments/:id
 *   DELETE /api/judgments/:id
 *   POST   /api/judgments/batch-delete
 *   POST   /api/judgments/auto-delegate
 */

import type { Express, Request, Response } from 'express';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { loadChannels, loadSession } from './server-storage.js';

export function registerJudgmentsRoutes(app: Express): void {
  // ==================== Judgments (v1 核心: 让我能记录判断) ====================
  // POST /api/judgments       — 记录一个判断
  // GET  /api/judgments       — 列出所有判断 (新→旧)
  // 存储: ~/.bolloon/human-values/judgments.json (human-value-store)
  //      极简版: 只记录 decision + reason; 其它字段可选
  app.post('/api/judgments', async (req, res) => {
    try {
      const { decision, reason, context } = req.body as {
        decision?: string; reason?: string; context?: { domain?: string; stakes?: string };
      };
      if (!decision || typeof decision !== 'string' || !decision.trim()) {
        return res.status(400).json({ error: 'decision required' });
      }
      const { storeHumanJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const j = await storeHumanJudgment({
        decision: decision.trim(),
        decision_type: 'approve',
        reasons: reason ? [reason.trim()] : [],
        values_derived: [],
        context: {
          domain: context?.domain || 'general',
          complexity: 'moderate',
          stakes: (context?.stakes as 'low' | 'medium' | 'high' | 'critical') || 'medium',
          time_pressure: 'low',
        },
        metadata: {
          source: 'explicit',
          confidence: 0.8,
          revisable: true,
        },
      });
      res.json({ ok: true, judgment: j });
    } catch (err: any) {
      console.error('[judgments] POST failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/judgments', async (req, res) => {
    try {
      const { listJudgmentsByStatus, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const status = (typeof req.query.status === 'string' ? req.query.status : 'all') as
        | 'active'
        | 'pending'
        | 'superseded'
        | 'rejected'
        | 'all';
      const all = await listJudgmentsByStatus(status);
      all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      res.json({ count: all.length, status, judgments: all });
    } catch (err: any) {
      console.error('[judgments] GET failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 2026-07-06: 清测试灌水数据 — dry (报告) + run (实际写盘) 两端点
  app.get('/api/judgments/cleanup-dry', async (_req, res) => {
    try {
      const { dryCleanup } = await import('../pi-ecosystem-judgment/cleanup.js');
      const r = await dryCleanup();
      res.json({ ok: true, ...r });
    } catch (err: any) {
      console.error('[judgments] cleanup-dry failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/judgments/cleanup', async (_req, res) => {
    try {
      const { runCleanup } = await import('../pi-ecosystem-judgment/cleanup.js');
      const r = await runCleanup();
      res.json({ ok: true, ...r });
    } catch (err: any) {
      console.error('[judgments] cleanup failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 蒸馏 B 触发 (人类点按钮) — 同步执行演化对齐
  app.post('/api/judgments/distill-from-conversation', async (req, res) => {
    try {
      const { channelId, messageId, recentTurns } = req.body as {
        channelId?: string;
        messageId?: string;
        recentTurns?: number;
      };
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }

      // 取 channel 最近的对话
      const channels = await loadChannels();
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) return res.status(404).json({ error: 'channel not found' });

      const currentSessionId = channel.currentSessionId;
      if (!currentSessionId) {
        return res.status(400).json({ error: 'no active session in channel' });
      }
      const session = await loadSession(channelId, currentSessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      // 取最近 N 轮 (默认 10), 转成 DistillTurn 格式
      const limit = Math.min(Math.max(recentTurns ?? 10, 2), 30);
      const turns = session.messages.slice(-limit).map((m) => ({
        role: (m.type === 'user' ? 'human' : 'agent') as 'human' | 'agent',
        content: m.content,
      }));

      const { distillAndStoreFromChannel } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const result = await distillAndStoreFromChannel(turns, { channelId });

      res.json({
        ok: true,
        triggered: result.triggered,
        reason: result.reason,
        judgment: result.judgment,
        evolved: result.evolved,
      });
    } catch (err: any) {
      console.error('[judgments] distill-from-conversation failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 蒸馏 D 触发 (AI 被动) — 后台异步,不阻塞 HTTP 响应
  app.post('/api/judgments/detect-and-distill', async (req, res) => {
    try {
      const { channelId, turns } = req.body as {
        channelId?: string;
        turns?: Array<{ role: 'human' | 'agent'; content: string }>;
      };

      // 先立即返回 202, 不等 LLM
      res.status(202).json({ ok: true, queued: true });

      if (!channelId || !Array.isArray(turns) || turns.length === 0) {
        return;
      }

      // 异步处理 (不 await, 不阻塞响应)
      setImmediate(async () => {
        try {
          const { detectAndDistillFromChannel } = await import(
            '../pi-ecosystem-judgment/human-value-pipeline.js'
          );
          const result = await detectAndDistillFromChannel(turns, { channelId });
          if (result.triggered) {
            console.log(`[D-hook] ${channelId}: ${result.reason}`, result.evolved);
          }
        } catch (err) {
          console.warn('[D-hook] background failed:', err);
        }
      });
    } catch (err: any) {
      console.error('[judgments] detect-and-distill failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 判断力使用回溯 (P0.5): 给定 judgmentIds, 反查对应的 decision 文本
  // 用途: UI 上"这条 AI 回复引用了哪些原则"
  app.post('/api/judgments/resolve-usage', async (req, res) => {
    try {
      const { ids } = req.body as { ids?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.json({ items: [] });
      }
      const { loadAllJudgments } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      const all = await loadAllJudgments();
      const byId = new Map(all.map((j) => [j.id, j]));
      const items = ids
        .map((id) => byId.get(id))
        .filter((j): j is NonNullable<typeof j> => Boolean(j))
        .map((j) => ({
          id: j.id,
          decision: j.decision,
          status: j.status ?? 'active',
          timestamp: j.timestamp,
        }));
      res.json({ items });
    } catch (err: any) {
      console.error('[judgments] resolve-usage failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 判断力违规日志 (P3 UI): 读 violations.jsonl
  app.get('/api/judgments/violations', async (req, res) => {
    try {
      const { getRecentViolations } = await import(
        '../pi-ecosystem-judgment/monitor-gate.js'
      );
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 200);
      const items = await getRecentViolations(limit);
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[judgments] violations failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 类 B 自适应扫描: 读 judgments.json + usage.jsonl, 给出 stale/rising/unused 建议
  // ?force=1 跳过 24h 缓存
  app.get('/api/judgments/adaptive-suggestions', async (req, res) => {
    try {
      const { getCachedScan } = await import(
        '../pi-ecosystem-judgment/adaptive-scan.js'
      );
      const force = String(req.query.force ?? '') === '1';
      const result = await getCachedScan(force);
      res.json(result);
    } catch (err: any) {
      console.error('[judgments] adaptive-scan failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Bootstrap Context 调试视图: 返出完整 BolloonContext
  app.get('/api/bolloon/context', async (req, res) => {
    try {
      const { getCachedBolloonContext } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const force = String(req.query.force ?? '') === '1';
      const ctx = await getCachedBolloonContext({ cwd: process.cwd() }, force);
      res.json(ctx);
    } catch (err: any) {
      console.error('[bolloon] context failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 阶段 B: 周报 (weekly-report.ts 产物) — 仅 API 读取, 不做 UI tab
  // GET /api/reports           → { files: ['2026-W24.md', ...] }
  // GET /api/reports/2026-W24  → { week, content }
  app.get('/api/reports', async (_req, res) => {
    try {
      const dir = path.join(os.homedir(), '.bolloon', 'reports');
      try {
        const entries = await fs.readdir(dir);
        const files = entries
          .filter((f) => f.endsWith('.md'))
          .sort()
          .reverse(); // 新的在前
        res.json({ dir, files });
      } catch {
        res.json({ dir, files: [] });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/:week', async (req, res) => {
    try {
      const week = req.params.week;
      // 严格校验, 防路径穿越
      if (!/^\d{4}-W\d{1,2}$/.test(week)) {
        return res.status(400).json({ error: 'week must match YYYY-Www' });
      }
      const file = path.join(os.homedir(), '.bolloon', 'reports', `${week}.md`);
      try {
        const content = await fs.readFile(file, 'utf-8');
        res.json({ week, content, length: content.length });
      } catch {
        res.status(404).json({ error: 'not found', week });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 阶段 C 护栏 5: auto-evolve baseline 管理 (无 UI, 仅 API)
  // GET    /api/auto-evolve/baselines             → 列出所有 baseline tag
  // GET    /api/auto-evolve/baselines/:tag/diff  → 看某 baseline 的 diff 摘要
  // POST   /api/auto-evolve/rollback {tag}       → 回滚到指定 baseline
  app.get('/api/auto-evolve/baselines', async (_req, res) => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const pExec = promisify(execFile);
      const { stdout } = await pExec('git', [
        'tag', '-l', 'auto-evolve-baseline-*', '--format=%(refname:short)|%(contents)|%(objectname:short)|%(taggerdate:iso)',
      ], { cwd: process.cwd() });
      const tags = stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [tag, msg, sha, date] = line.split('|');
        return { tag, message: msg || '', sha, date };
      });
      res.json({ tags, count: tags.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/auto-evolve/baselines/:tag/diff', async (req, res) => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const pExec = promisify(execFile);
      const tag = req.params.tag;
      if (!/^auto-evolve-baseline-[\w-]+$/.test(tag)) {
        return res.status(400).json({ error: 'tag must match auto-evolve-baseline-*' });
      }
      const { stdout } = await pExec('git', ['show', '--stat', '--no-color', tag], { cwd: process.cwd() });
      res.json({ tag, diff: stdout.slice(0, 5000) }); // 限长 5KB
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bootstrap Context → 拼好的 system prompt 片段 (供调试看注入效果)
  app.get('/api/bolloon/context/system-prompt', async (req, res) => {
    try {
      const { getCachedBolloonContext } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const { formatContextForSystemPrompt } = await import(
        '../bootstrap/project-context.js'
      );
      const ctx = await getCachedBolloonContext({ cwd: process.cwd() });
      const systemAddition = formatContextForSystemPrompt(ctx, {
        maxChars: parseInt(String(req.query.max ?? '4000'), 10) || 4000,
      });
      res.json({ systemAddition, length: systemAddition.length, truncated: systemAddition.includes('截断模式') });
    } catch (err: any) {
      console.error('[bolloon] context/system-prompt failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // system-prompt health (P-Action 2 — Harness Gardening)
  // 返回每层 lifecycle 状态: ok | stale | overdue-review | missing-frontmatter | dynamic
  // query: ?activeOnly=1 → 只返回当前 context 激活的层
  // ============================================================
  app.get('/api/prompt/health', async (req, res) => {
    try {
      const { listLayers } = await import('../llm/system-prompt/registry.js');
      const { evaluateLayers, markActive } = await import('../llm/system-prompt/health.js');
      const all = listLayers() as Array<any>;
      const baseReport = evaluateLayers(all);

      // 如果 query 里有 activeOnly, 跑一次 assembleSystemPrompt 拿激活列表
      if (String(req.query.activeOnly ?? '') === '1') {
        const { assembleSystemPrompt } = await import('../llm/system-prompt/registry.js');
        const channel = String(req.query.channel ?? 'local') as 'local' | 'p2p-visitor' | 'p2p-agent';
        const role = req.query.role as any;
        const tool = req.query.tool as any;
        try {
          const r = await assembleSystemPrompt({ channel, role, tool });
          const activeIds = new Set(r.layerIds);
          res.json(markActive(baseReport, activeIds));
        } catch (err: any) {
          console.warn('[prompt-health] assembleSystemPrompt failed (silent, returning base report):', err);
          res.json(baseReport);
        }
      } else {
        res.json(baseReport);
      }
    } catch (err: any) {
      console.error('[prompt-health] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 自适应接受/拒绝: 写 evolution.jsonl 留痕, 接受时同时 patch judgments.json
  // body: { action: 'accept'|'reject'|'revert', suggestion, appliedPatch? }
  // query: ?auto=1  → 类 B 自动路径, 受 auto-evolve-policy 网关保护
  //         缺省    → 用户在 UI 手动触发, 不查开关 (避免阻塞用户)
  app.post('/api/judgments/adaptive-apply', async (req, res) => {
    try {
      const isAuto = req.query.auto === '1' || req.query.auto === 'true';
      const { action, suggestion, appliedPatch } = req.body as {
        action: 'accept' | 'reject' | 'revert';
        suggestion: { judgmentId: string; kind: string; decision: string; reason: string; action: string; metrics: unknown; scannedAt: string; key: string };
        appliedPatch?: Record<string, unknown>;
      };
      if (!action || !suggestion?.judgmentId) {
        return res.status(400).json({ error: 'action and suggestion.judgmentId required' });
      }
      const { updateJudgmentStatus } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      const { logEvolution } = await import(
        '../pi-ecosystem-judgment/adaptive-scan.js'
      );
      // accept 时: 真正改库
      if (action === 'accept') {
        // 阶段 A: 自动路径需先过 auto-evolve-policy 网关
        if (isAuto) {
          const { requireDataLayerAutoEvolve } = await import(
            '../utils/auto-evolve-policy.js'
          );
          try {
            await requireDataLayerAutoEvolve('adaptive-apply.auto.deprecate');
          } catch (err: any) {
            return res.status(423).json({
              error: 'data-layer-auto-evolve-disabled',
              message: err.message,
              hint: '设 BOLLOON_AUTO_EVOLVE_DATA=1 或在 self-improve-policy.json 加 dataLayerAutoEvolve: true',
            });
          }
        }
        if (suggestion.action === 'deprecate') {
          // 标记 superseded (语义: 不再用, 但保留可回滚)
          await updateJudgmentStatus(suggestion.judgmentId, 'superseded', {
            evolutionReason: 'merged', // 借 merged 字段表达"被自适应废弃"
          });
        } else if (suggestion.action === 'boost') {
          // boost: 用户手动接受后, 不改库本身 (weight 在 getRelevantValues 里动态算),
          // 但写 evolution 留痕, 未来可以基于此调整算法
          // 当前不直接改库, 仅留痕
        }
        // 'review' 类不需要自动改库, 仅 log 接受
      }
      await logEvolution({
        ts: new Date().toISOString(),
        action,
        suggestion: suggestion as any,
        appliedPatch,
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[judgments] adaptive-apply failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 演化日志 (audit / 一键回滚源)
  app.get('/api/judgments/evolution-log', async (req, res) => {
    try {
      const { readEvolutionLog } = await import(
        '../pi-ecosystem-judgment/adaptive-scan.js'
      );
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
      const items = await readEvolutionLog(limit);
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[judgments] evolution-log failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 阶段 2: Causal-judge 4 个 endpoint
  app.get('/api/judgments/causal/correlation', async (req, res) => {
    try {
      const { runCorrelationAnalysis } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const topN = Math.min(Math.max(parseInt(String(req.query.topN ?? '5'), 10) || 5, 1), 50);
      const useLLM = String(req.query.useLLM ?? '1') !== '0';
      const items = await runCorrelationAnalysis({ topN, useLLM });
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[causal] correlation failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/judgments/causal/intervention', async (req, res) => {
    try {
      const { runIntervention } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const { judgmentId, scenario } = req.query as { judgmentId?: string; scenario?: string };
      if (!judgmentId) return res.status(400).json({ error: 'judgmentId required' });
      const result = await runIntervention(judgmentId, { scenarioContext: scenario });
      res.json(result);
    } catch (err: any) {
      console.error('[causal] intervention failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/judgments/causal/counterfactual', async (req, res) => {
    try {
      const { runCounterfactualAudit } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const { userInput, aiReply, violatedPrinciples } = req.body as {
        userInput?: string;
        aiReply?: string;
        violatedPrinciples?: Array<{ principle: string; reason: string }>;
      };
      if (!userInput || !aiReply) {
        return res.status(400).json({ error: 'userInput and aiReply required' });
      }
      const audit = await runCounterfactualAudit({
        userInput,
        aiReply,
        violatedPrinciples: violatedPrinciples ?? [],
      });
      res.json(audit);
    } catch (err: any) {
      console.error('[causal] counterfactual failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/judgments/causal/audit-log', async (req, res) => {
    try {
      const { readCounterfactualLog } = await import(
        '../pi-ecosystem-judgment/human-value-pipeline.js'
      );
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 200);
      const items = await readCounterfactualLog(limit);
      res.json({ count: items.length, items });
    } catch (err: any) {
      console.error('[causal] audit-log failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 导入判断: 接受 { filename, content (base64), context }.
  // 支持 .json / .yaml / .yml / .md / .txt / .html. 完全离线解析, 不调 LLM.
  // 解析规则:
  //   - .json: 顶层数组 [{decision, reason?, context?}, ...] 或 {judgments: [...]} 或 {items: [...]}
  //   - .yaml/.yml: 期望顶层数组 (用 js-yaml); 不支持复杂结构
  //   - .md/.txt/.html: 每一段 (按空行分隔) 算一条判断, 首行非空 = decision, 整段 = content
  //                     如果首行是 markdown 标题 (# ...) 则去掉 #, 整段去掉首行后作 reason
  app.post('/api/judgments/import', async (req, res) => {
    try {
      const { filename, content, context } = req.body as {
        filename?: string; content?: string; context?: { domain?: string; stakes?: string };
      };
      if (!filename || !content) {
        return res.status(400).json({ error: 'filename and content (base64) required' });
      }
      let raw: string;
      try { raw = Buffer.from(content, 'base64').toString('utf-8'); }
      catch { return res.status(400).json({ error: 'content is not valid base64' }); }

      const lower = filename.toLowerCase();
      let items: Array<{ decision: string; reason?: string; context?: any }> = [];
      if (lower.endsWith('.json')) {
        try {
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed) ? parsed
            : Array.isArray(parsed?.judgments) ? parsed.judgments
            : Array.isArray(parsed?.items) ? parsed.items
            : null;
          if (!arr) return res.status(400).json({ error: 'JSON must be an array, or {judgments:[]}/{items:[]}' });
          for (const it of arr) {
            if (it && typeof it.decision === 'string' && it.decision.trim()) {
              items.push({ decision: it.decision.trim(), reason: it.reason, context: it.context });
            }
          }
        } catch (e: any) {
          return res.status(400).json({ error: 'JSON parse failed: ' + e.message });
        }
      } else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        try {
          const yaml = (await import('js-yaml')).default;
          const parsed = yaml.load(raw);
          if (!Array.isArray(parsed)) return res.status(400).json({ error: 'YAML must be a top-level array' });
          for (const it of parsed) {
            if (it && typeof it.decision === 'string' && it.decision.trim()) {
              items.push({ decision: it.decision.trim(), reason: it.reason, context: it.context });
            }
          }
        } catch (e: any) {
          return res.status(400).json({ error: 'YAML parse failed: ' + e.message });
        }
      } else if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.html') || lower.endsWith('.htm')) {
        // 通用纯文本: 按空行分段, 每段是一条判断
        // 对 .html 先剥掉标签, 但保留段落分隔
        let text = raw;
        if (lower.endsWith('.html') || lower.endsWith('.htm')) {
          text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     // 块级标签 -> 双换行 (保留段落分隔)
                     .replace(/<\/?(p|div|h[1-6]|li|tr|br)[^>]*>/gi, '\n\n')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        }
        const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0);
        for (const block of blocks) {
          const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          if (lines.length === 0) continue;
          let decision = lines[0];
          // 如果首行是 markdown 标题, 去掉 # 前缀
          decision = decision.replace(/^#+\s*/, '');
          // 如果整段就是一个短句 (没有换行), 直接当 decision
          const reason = lines.length > 1 ? lines.slice(1).join(' ').trim() || undefined : undefined;
          if (decision) items.push({ decision, reason });
        }
      } else {
        return res.status(400).json({ error: 'unsupported file type (use .json .yaml .yml .md .txt .html)' });
      }

      if (items.length === 0) {
        return res.status(400).json({ error: 'no parseable judgments found in file' });
      }

      const { storeHumanJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();

      const imported: any[] = [];
      const errors: string[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const it = items[i];
          const j = await storeHumanJudgment({
            decision: it.decision,
            decision_type: 'approve',
            reasons: it.reason ? [String(it.reason)] : [],
            values_derived: [],
            context: {
              domain: it.context?.domain || context?.domain || 'general',
              complexity: 'moderate',
              stakes: (it.context?.stakes as any) || context?.stakes || 'medium',
              time_pressure: 'low',
            },
            metadata: {
              source: 'explicit',
              confidence: 0.8,
              revisable: true,
            },
          });
          imported.push(j);
        } catch (e: any) {
          errors.push(`#${i + 1} (${items[i].decision.substring(0, 30)}): ${e.message}`);
        }
      }

      res.json({ ok: true, imported: imported.length, failed: errors.length, errors: errors.slice(0, 5), judgments: imported });
    } catch (err: any) {
      console.error('[judgments] import failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 修改判断 (手动编辑 decision / reasons / context / values_derived)
  app.patch('/api/judgments/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { updateJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const updated = await updateJudgment(id, req.body || {});
      if (!updated) return res.status(404).json({ error: 'judgment not found' });
      res.json({ ok: true, judgment: updated });
    } catch (err: any) {
      console.error('[judgments] PATCH failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 删除判断
  app.delete('/api/judgments/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { deleteJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const ok = await deleteJudgment(id);
      if (!ok) return res.status(404).json({ error: 'judgment not found' });
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[judgments] DELETE failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 批量删除: { ids: ['hv-xxx', ...] } → { ok, deleted, notFound }
  app.post('/api/judgments/batch-delete', async (req, res) => {
    try {
      const ids = (req.body && Array.isArray(req.body.ids)) ? (req.body.ids as unknown[]) : null;
      if (!ids) return res.status(400).json({ error: 'ids array required' });
      const { deleteJudgment, initializeValueStore } = await import(
        '../pi-ecosystem-judgment/human-value-store.js'
      );
      await initializeValueStore();
      const idStrs = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
      let deleted = 0;
      const notFound: string[] = [];
      for (const id of idStrs) {
        const ok = await deleteJudgment(id);
        if (ok) deleted++; else notFound.push(id);
      }
      res.json({ ok: true, deleted, notFound });
    } catch (err: any) {
      console.error('[judgments] batch-delete failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // AI 自动委派: 根据新判断的 capability / context 找最匹配的远端 agent, 委派任务
  // 由前端在 POST /api/judgments 成功后调用 (fire-and-forget)
  // 出参: { matched, targetAgent, response | skipped, reason }
  app.post('/api/judgments/auto-delegate', async (req, res) => {
    try {
      const { judgmentId, capability, instruction } = req.body as {
        judgmentId?: string; capability?: string; instruction?: string;
      };
      if (!judgmentId && !capability) {
        return res.status(400).json({ error: 'judgmentId or capability required' });
      }
      const cap = capability || 'general';
      // 用 agent-manifest-protocol 里的 pickAgent (内存) — 走本节点已经缓存的远端 manifest
      const manifestMod = await import('../agents/agent-manifest-protocol.js');
      const picked = manifestMod.pickAgent(cap);
      if (!picked) {
        return res.json({ ok: true, matched: false, reason: 'no remote agent matches capability' });
      }
      // 命中后, 用 iroh delegate transport 真正发过去
      // 注: irohDelegateTransport.sendToNode 走的是 sendToNode(publicKey, frame, timeoutMs)
      // irohTransport 的 sendMessage 不等回包, 所以委托是 fire-and-forget
      // 想等回包需要新接口. 这里先把 "找得到目标 + 发送成功" 作为成功.
      // TODO: 接入 requestResponse 等待远端 agent_response
      try {
        const idMod = await import('../network/iroh-integration.js');
        const integ = idMod.getIrohIntegration();
        if (!integ || !integ.getNodeId()) {
          return res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: false, reason: 'iroh not initialized' });
        }
        // 用 pickAgent 选出来的 agent 关联的 irohNodeId (有的话), 没有就跳到本地自处理
        const targetIrohNodeId = picked.agent.irohNodeId;
        if (!targetIrohNodeId) {
          return res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: false, reason: 'target agent has no irohNodeId (peer identity not bound)' });
        }
        const ok = await integ.sendTo(targetIrohNodeId, 'agent_delegate', new TextEncoder().encode(JSON.stringify({
          type: 'agent_delegate',
          payload: {
            capability: cap,
            instruction: instruction || `请执行我的判断: ${judgmentId}`,
            fromAgentId: 'local-judgment',
          },
          ts: Date.now(),
          fromDid: '',
        })));
        res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: ok });
      } catch (e: any) {
        res.json({ ok: true, matched: true, targetAgent: picked.agent, sent: false, error: e.message });
      }
    } catch (err: any) {
      console.error('[judgments] auto-delegate failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // (判断的 UI 已合并到主页面 header 的盾牌按钮 + modal, 不再走独立路由)

  // (启动 watchdog + health monitor 在主 server.ts createWebServer 末尾, 不在这里)
}