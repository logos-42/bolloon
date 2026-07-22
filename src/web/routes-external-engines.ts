/**
 * routes-external-engines.ts — 外部编码智能体 配置/委派 路由
 *
 * 三个能力:
 *   GET  /api/external-engines          发现本机已装的引擎 (脱敏)
 *   POST /api/external-engines/import   把发现的引擎 API 写进 Bolloon provider 体系 (当供应商)
 *   POST /api/external-engines/run      委派编码任务给引擎 CLI (子智能体)
 *
 * 复用 routes-llm-config.ts 的 llmConfigStore + initMinimax 做激活.
 */

import type { Express } from 'express';
import { discoverEngines, mapEngineToProviderConfig, resolveProvider } from '../external-engines/index.js';
import type { ModelProvider } from '../llm/config-store.js';
import { llmConfigStore } from '../llm/config-store.js';
import { initMinimax } from '../constraints/index.js';

function maskKey(key?: string): string {
  if (!key) return '';
  if (key.length <= 4) return '***';
  return '***' + key.slice(-4);
}

export function registerExternalEngineRoutes(app: Express): void {
  // ==================== 发现 ====================
  app.get('/api/external-engines', async (_req, res) => {
    try {
      const engines = await discoverEngines();
      const safe = engines.map((e) => ({
        ...e,
        apiKey: maskKey(e.apiKey),
      }));
      res.json({ engines: safe });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ==================== 导入为供应商 ====================
  app.post('/api/external-engines/import', async (req, res) => {
    try {
      const { id, model, provider: providerOverride } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id 必填' });

      const engines = await discoverEngines();
      const engine = engines.find((e) => e.id === id);
      if (!engine) return res.status(404).json({ error: `未发现的引擎: ${id}` });
      if (!engine.configured) {
        return res.status(400).json({ error: `引擎 ${id} 未配置 API key / baseUrl, 无法导入为供应商` });
      }

      // 允许前端在导入时覆盖 model / provider (API 配置 UI 里用户筛选模型后传来)
      if (model && typeof model === 'string' && model.trim()) {
        engine.model = model.trim();
      }
      if (providerOverride && typeof providerOverride === 'string' && providerOverride.trim()) {
        const resolved = resolveProvider(providerOverride.trim(), engine.provider || 'openai');
        engine.provider = resolved;
      }

      let importPatch;
      try {
        importPatch = mapEngineToProviderConfig(engine);
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }

      const { provider, patch } = importPatch;
      await llmConfigStore.updateProvider(provider as ModelProvider, patch);

      // 导入即激活 (若提供了有效 key, 或不需要 key 的 provider)
      const shouldActivate = !!patch.apiKey || !engine.apiKey;
      let autoActivated = false;
      if (shouldActivate) {
        try {
          await llmConfigStore.setActiveProvider(provider as ModelProvider);
          initMinimax({
            provider: provider as ModelProvider,
            apiKey: patch.apiKey || undefined,
            baseUrl: patch.baseUrl || undefined,
            model: patch.model || undefined,
          });
          autoActivated = true;
        } catch (e: any) {
          // 激活失败不阻断导入 (可能该 provider 仍需别的字段)
          console.warn('[external-engines] 激活失败:', e?.message);
        }
      }

      res.json({ ok: true, provider, autoActivated, imported: { ...patch, apiKey: maskKey(patch.apiKey) } });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ==================== 委派执行 ====================
  app.post('/api/external-engines/run', async (req, res) => {
    try {
      const { id, prompt, cwd, model } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id 必填' });
      if (!prompt) return res.status(400).json({ error: 'prompt 必填' });

      // 动态 import 避免顶层循环依赖 (delegate -> discovery, 这里反向)
      const { delegateToEngine } = await import('../external-engines/delegate.js');
      const result = await delegateToEngine(id, prompt, {
        cwd,
        ...(model ? { model: String(model) } : {}),
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
