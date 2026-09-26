/**
 * routes-llm-config.ts — LLM/Video/Audio 配置路由 (2026-07-06 抽出)
 *
 * 从 src/web/server.ts 抽出 (~230 行).
 * 包含 /api/llm-config/* /api/video-config/* /api/audio-config/* /api/ai-parse
 */

import type { Express, Response } from 'express';
import { llmConfigStore, type ModelProvider } from '../llm/config-store.js';
import { videoConfigStore, type VideoProvider } from '../llm/video-config-store.js';
import { audioConfigStore, type AudioProvider } from '../llm/audio-config-store.js';
import { getMinimax } from '../constraints/index.js';

/**
 * ============================================================================
 * Web 侧的模型选择: **五个端点, 一个实现**
 * ============================================================================
 *
 * 规矩 (P6):
 *   1. 下面三个写口 (`/api/models/select` · 旧 `/api/llm-provider` · 旧 `/api/llm-config` 的激活分支)
 *      **共用 `runModelSelect` 这一个函数** —— 旧接口叫"兼容转发"指的就是这件事: 转发到**同一个函数**,
 *      而不是各自再写一遍"校验 + 写配置 + 重建运行时"。
 *   2. 校验 / 探测 / 落盘 / 重建运行时全部在 `selectModel` (唯一入口) 里发生; Web 这一层只做
 *      "把 HTTP 请求体翻译成入口入参"和"把结果翻译成 HTTP 状态码"。
 *   3. **凭据永不出现在响应里**: 只回 `effective.authRef` (`provider:<id>` / `env:<VAR>` / `none`)。
 *      掩码 key (`***abcd`) 会被当作"没给 key" —— 入口会用配置里现有那一把 (与旧行为同一效果)。
 *   4. `provider` 由入口按**注册表**校验 (内置 + 已注册的自定义供应商), 所以从列表点一个自定义
 *      供应商也能落成全局默认。
 */

/** 请求体 → 统一入口的入参 (白名单: 不把前端对象整个灌进入口) */
function selectRequestFromBody(body: any): any {
  const b = body && typeof body === 'object' ? body : {};
  const raw = typeof b.apiKey === 'string' ? b.apiKey : undefined;
  return {
    provider: typeof b.provider === 'string' ? b.provider : '',
    model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined,
    baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : undefined,
    // 掩码不是凭据: 当"没给"处理, 由入口沿用配置里那一把
    apiKey: raw && !raw.startsWith('***') ? raw : undefined,
    temperature: typeof b.temperature === 'number' && Number.isFinite(b.temperature) ? b.temperature : undefined,
    reasoningMode: typeof b.reasoningMode === 'boolean' ? b.reasoningMode : undefined,
    scope: b.scope === 'session' ? 'session' : 'global',
    sessionKey: typeof b.sessionKey === 'string' && b.sessionKey.trim() ? b.sessionKey.trim() : undefined,
    verify: b.verify !== false,
  };
}

/** 唯一的写口实现: 校验+探测过才落盘, 然后重建运行时, 返回**真正生效**的那一份配置 */
async function runModelSelect(
  body: any,
  res: Response,
  opts: { legacy?: string; beforeOk?: (out: any) => Promise<Record<string, any>> | Record<string, any> } = {},
): Promise<void> {
  try {
    const { selectModel } = await import('../llm/model-selection.js');
    const r = await selectModel(selectRequestFromBody(body));
    if (!r.ok) {
      res.status(409).json({
        ok: false,
        failureClass: r.failureClass,
        message: r.message,
        effective: r.previous, // 失败时生效配置**没变** —— 如实回旧的那一份
        checks: r.checks,
        ...(opts.legacy ? { legacy: opts.legacy } : {}),
      });
      return;
    }
    const out: any = {
      ok: true,
      effective: r.effective,
      previous: r.previous,
      checks: r.checks,
      ...(opts.legacy ? { legacy: opts.legacy } : {}),
    };
    if (opts.beforeOk) Object.assign(out, await opts.beforeOk(out));
    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

/** 旧 `/api/llm-config` 的两种请求形状 (老 UI 发 `{provider,config}`; 移动端发整份配置) */
function legacyLlmConfigPayload(body: any): { provider: string; config: any } | null {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.provider === 'string' && b.provider && b.config && typeof b.config === 'object') {
    return { provider: b.provider, config: b.config };
  }
  const active = typeof b.activeProvider === 'string' ? b.activeProvider : '';
  const rows = b.providers && typeof b.providers === 'object' ? b.providers : null;
  if (active && rows && rows[active] && typeof rows[active] === 'object') {
    return { provider: active, config: rows[active] };
  }
  return null;
}

/** 旧接口能改、而**切换入口不管**的字段 (照旧保存; 掩码凭据不写回) */
function legacyExtraFields(config: any): Record<string, any> {
  const out: Record<string, any> = {};
  const c = config && typeof config === 'object' ? config : {};
  if (typeof c.maxTokens === 'number') out.maxTokens = c.maxTokens;
  if (typeof c.reasoning === 'boolean') out.reasoning = c.reasoning;
  return out;
}

/** 旧接口在"没凭据、只保存"那条路上能写的字段 (不含选择那四个) */
function legacyEditableFields(config: any): Record<string, any> {
  const c = config && typeof config === 'object' ? config : {};
  const out: Record<string, any> = { enabled: c.enabled !== false, ...legacyExtraFields(c) };
  if (typeof c.model === 'string' && c.model.trim()) out.model = c.model.trim();
  if (typeof c.baseUrl === 'string' && c.baseUrl.trim()) out.baseUrl = c.baseUrl.trim();
  if (typeof c.temperature === 'number') out.temperature = c.temperature;
  const raw = typeof c.apiKey === 'string' ? c.apiKey : '';
  if (raw && !raw.startsWith('***')) out.apiKey = raw;
  return out;
}

/** 唯一的探测实现 (旧 /api/llm-test 与新 /api/models/test 共用) */
async function runModelTest(body: any, res: Response, legacy?: string): Promise<void> {
  try {
    const b = body && typeof body === 'object' ? body : {};
    const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
    if (!provider) {
      res.status(400).json({ error: 'provider required' });
      return;
    }
    const raw = typeof b.apiKey === 'string' ? b.apiKey : undefined;
    const sel: any = await import('../llm/model-selection.js');
    const stored = await llmConfigStore.getProvider(provider as ModelProvider).catch(() => null);
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : (stored?.model || '');
    const r = await sel.runConnectionProbe({
      provider,
      model,
      baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : undefined,
      configuredBaseUrl: stored?.baseUrl || undefined,
      apiKey: raw && !raw.startsWith('***') ? raw : (stored?.apiKey || undefined),
      timeoutMs: typeof b.timeoutMs === 'number' && b.timeoutMs > 0 ? b.timeoutMs : undefined,
    });
    const entry = sel.registryEntryOf(provider);
    res.json({
      ok: r.ok,
      success: r.ok, // 旧字段名, 前端仍在读
      provider,
      model,
      baseUrl: r.baseUrl,
      baseUrlSource: r.baseUrlSource,
      protocol: entry ? entry.protocol : null,
      toolCalling: r.toolCalling,
      failureClass: r.failureClass,
      probeClass: r.probeClass,
      unmapped: r.unmapped,
      failureClassZh: r.failureClassZh,
      message: r.message,
      error: r.ok ? undefined : r.message,
      checks: r.checks,
      ...(r.catalog ? { catalog: r.catalog } : {}),
      ...(legacy ? { legacy } : {}),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export function registerLlmConfigRoutes(app: Express): void {
  // ==================== LLM 配置 API (旧接口, 保留兼容) ====================

  // 获取所有 LLM 配置
  app.get('/api/llm-config', async (req, res) => {
    try {
      const config = await llmConfigStore.getConfig();
      const providerInfo = llmConfigStore.getAllProviderInfo();

      // 隐藏 API Key
      const safeConfig = {
        ...config,
        providers: Object.fromEntries(
          Object.entries(config.providers).map(([key, val]: [string, any]) => [
            key,
            { ...val, apiKey: val.apiKey ? '***' + val.apiKey.slice(-4) : '' }
          ])
        ),
        providerInfo
      };

      res.json(safeConfig);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新 LLM 配置 (旧接口, 兼容保留)
  //
  //   旧语义: 存字段 → 若 enabled 且有凭证 → 立即激活。
  //   新语义: 有凭证 ⇒ **整件事转发给统一入口** (与 /api/models/select 同一个函数);
  //           没凭证 ⇒ 只保存字段 (这本来就不是"切换", 是一次配置编辑);
  //           enabled=false ⇒ 只关这个开关 (入口不接管"关掉"这件事)。
  app.post('/api/llm-config', async (req, res) => {
    try {
      const payload = legacyLlmConfigPayload(req.body);
      if (!payload) {
        return res.status(400).json({ error: 'provider and config required' });
      }
      const { provider, config } = payload;

      if (config.enabled === false) {
        await llmConfigStore.updateProvider(provider as ModelProvider, { enabled: false });
        return res.json({ ok: true, autoActivated: false, disabled: true, legacy: 'llm-config' });
      }

      const raw = typeof config.apiKey === 'string' ? config.apiKey : '';
      const fresh = raw && !raw.startsWith('***') ? raw : '';
      const stored = await llmConfigStore.getProvider(provider as ModelProvider).catch(() => null);
      const canActivate = !!fresh || !!(stored && (stored.apiKey || stored.requiresApiKey === false));

      if (!canActivate) {
        // 还没凭据: 存下来, 不激活 (且**不**假装成功切换)
        await llmConfigStore.updateProvider(provider as ModelProvider, legacyEditableFields(config));
        return res.json({
          ok: true,
          autoActivated: false,
          saved: true,
          note: '缺凭据 — 字段已保存, 未激活 (激活走 /api/models/select)',
          legacy: 'llm-config',
        });
      }

      // 有凭据 ⇒ 转发到同一个写口。选择那四个字段 (model/baseUrl/key/temperature) 由入口写,
      // 入口不管的字段 (如 maxTokens) 在入口成功后照旧保存 —— 但"切换"这件事只有入口一处实现。
      const extras = legacyExtraFields(config);
      return runModelSelect(
        { provider, model: config.model, baseUrl: config.baseUrl, apiKey: fresh || undefined, temperature: config.temperature },
        res,
        {
          legacy: 'llm-config',
          beforeOk: async () => {
            try {
              if (Object.keys(extras).length) await llmConfigStore.updateProvider(provider as ModelProvider, extras);
            } catch { /* extras 是次要字段, 不影响"切换成功"这个结论 */ }
            return { autoActivated: true };
          },
        },
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 设置活跃供应商 (旧接口 → 转发到统一入口的同一个函数)
  app.post('/api/llm-provider', async (req, res) => {
    const provider = req.body && typeof req.body.provider === 'string' ? req.body.provider : '';
    if (!provider) {
      return res.status(400).json({ error: 'provider required' });
    }
    // 旧字段名也照收 (老 UI 可能只带 provider + 可选 model/baseUrl)
    return runModelSelect({ ...req.body, provider }, res, { legacy: 'llm-provider' });
  });

  // 测试供应商连接 (旧接口 → 转发到同一个探测函数)
  app.post('/api/llm-test', async (req, res) => {
    return runModelTest(req.body, res, 'llm-test');
  });

  // ==================== 模型选择 API (新端点) ====================
  //
  // 五个端点: providers / options / test / select / discover —— 都只是**薄翻译层**,
  //   真正的事实与写入分别在 provider-registry / model-catalog / connection-probe /
  //   model-selection / model-discovery 里, 这里不复制任何一份。

  // 供应商清单 (脱敏): 谁能选、当前生效的是哪一家、协议与能力、发现方式
  app.get('/api/models/providers', async (req, res) => {
    try {
      const sessionKey = typeof req.query.sessionKey === 'string' && req.query.sessionKey ? req.query.sessionKey : undefined;
      const { buildProviderSummaries } = await import('../llm/model-catalog.js');
      const { listProviderRegistry } = await import('../llm/provider-registry.js');
      const { effectiveModelConfig } = await import('../llm/model-selection.js');
      const [providers, effective] = await Promise.all([
        buildProviderSummaries({ sessionKey }),
        effectiveModelConfig({ sessionKey }).catch(() => null),
      ]);
      const registry = listProviderRegistry().map((e: any) => ({
        id: e.id,
        kind: e.kind,
        protocol: e.protocol,
        discovery: e.discovery,
        toolCalling: e.toolCalling,
        reasoning: e.reasoning,
        requiresApiKey: e.requiresApiKey,
        isLocal: e.isLocal,
        allowsLongRunningExecutor: e.allowsLongRunningExecutor,
        longRunningReason: e.longRunningReason,
        defaultModel: e.defaultModel,
        declaredModelCount: Array.isArray(e.declaredModelIds) ? e.declaredModelIds.length : 0,
      }));
      res.json({ ok: true, effective, count: providers.length, providers, registry });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 可选模型清单 (某一家; 不带 provider 就只回供应商清单与当前生效配置)
  //   `refresh=1` 才真去打上游 /models (默认只吃缓存, 不因为一次页面加载就把上游打爆)
  app.get('/api/models/options', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
      const sessionKey = typeof req.query.sessionKey === 'string' && req.query.sessionKey ? req.query.sessionKey : undefined;
      const { effectiveModelConfig, registryEntryOf } = await import('../llm/model-selection.js');
      const effective = await effectiveModelConfig({ sessionKey }).catch(() => null);
      if (!provider) {
        const { buildProviderSummaries } = await import('../llm/model-catalog.js');
        return res.json({ ok: true, effective, providers: await buildProviderSummaries({ sessionKey }) });
      }
      if (!registryEntryOf(provider)) {
        return res.status(404).json({ ok: false, failureClass: 'invalid_provider', message: `未知供应商 '${provider}'`, effective });
      }
      const { listModelsFor, searchModelEntries } = await import('../llm/model-catalog.js');
      const { currentDiscoveryCatalog, discoverProviderModels } = await import('../llm/model-discovery.js');
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      let catalog: any = currentDiscoveryCatalog(provider);
      if (refresh) {
        // 只有显式 refresh 才真打上游 (默认吃缓存, 免得一次页面加载就把上游打爆)
        const d = await discoverProviderModels(provider, { force: true });
        catalog = d || catalog;
      }
      const discovered: string[] = catalog && Array.isArray(catalog.models) ? catalog.models : [];
      const models = searchModelEntries(await listModelsFor(provider, {
        sessionKey,
        extra: discovered,
      }), q);
      // 目录里没有凭据 (只有指纹); 这里显式白名单一份, 免得把内部字段漏出去
      const catalogOut = catalog
        ? {
            provider: catalog.provider,
            baseUrl: catalog.baseUrl,
            baseUrlSource: catalog.baseUrlSource,
            origin: catalog.origin,
            discoveryState: catalog.discoveryState,
            fetchedAt: catalog.fetchedAt,
            expiresAt: catalog.expiresAt,
            stale: catalog.stale === true,
            fromCache: catalog.fromCache === true,
            discoveryFailed: catalog.discoveryFailed === true,
            failure: catalog.failure || null,
            count: discovered.length,
            models: discovered,
            notes: catalog.notes || [],
          }
        : null;
      res.json({ ok: true, provider, effective, q, count: models.length, models, catalog: catalogOut });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 连通探测 (不写任何配置)
  app.post('/api/models/test', async (req, res) => {
    return runModelTest(req.body, res);
  });

  // 切换模型选择 (唯一写口)
  app.post('/api/models/select', async (req, res) => {
    return runModelSelect(req.body, res);
  });

  // 模型发现 (P5 的能力面): refresh / list / admit / clear, 一个入口
  //   body: { provider?, action?: 'refresh'|'list'|'admit'|'clear', model?, force?, timeoutMs? }
  app.post('/api/models/discover', async (req, res) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const action = typeof b.action === 'string' && b.action ? b.action : (b.provider ? 'refresh' : 'list');
      const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
      const model = typeof b.model === 'string' ? b.model.trim() : '';
      const d = await import('../llm/model-discovery.js');
      const { registryEntryOf } = await import('../llm/model-selection.js');

      if (action === 'clear') {
        const cleared = await d.clearDiscoveryCache(provider || undefined);
        return res.json({ ok: true, action, provider: provider || null, cleared });
      }
      if (action === 'admit') {
        if (!provider || !model) return res.status(400).json({ error: 'provider and model required' });
        if (!registryEntryOf(provider)) {
          return res.status(404).json({ ok: false, failureClass: 'invalid_provider', message: `未知供应商 '${provider}'` });
        }
        const admitted = await d.admitManualModel(provider, model);
        return res.json({ ok: true, action, provider, model, admitted });
      }
      if (action === 'list') {
        if (provider) {
          if (!registryEntryOf(provider)) {
            return res.status(404).json({ ok: false, failureClass: 'invalid_provider', message: `未知供应商 '${provider}'` });
          }
          const listing = await d.listModelCatalog(provider);
          return res.json({ ok: true, action, provider, listing });
        }
        const listing = await d.listModelCatalog();
        return res.json({ ok: true, action, listing });
      }
      // refresh: 真去上游 /models 取一次目录 (结果进缓存; 失败如实报类目)
      if (!provider) return res.status(400).json({ error: 'provider required' });
      if (!registryEntryOf(provider)) {
        return res.status(404).json({ ok: false, failureClass: 'invalid_provider', message: `未知供应商 '${provider}'` });
      }
      const r = await d.refreshModelDiscovery(provider, {
        force: b.force !== false,
        timeoutMs: typeof b.timeoutMs === 'number' && b.timeoutMs > 0 ? b.timeoutMs : undefined,
      });
      const entry = r.results.find((c: any) => c.provider === provider);
      const failure = r.failures.find((f: any) => f.provider === provider);
      return res.json({
        ok: !!entry && !failure,
        action,
        provider,
        catalog: entry || null,
        failure: failure || null,
        notes: r.notes,
        counts: r.counts,
        refreshedAt: r.refreshedAt,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== 视频生成配置 (Seedance 等) ====================

  // 获取视频生成配置
  app.get('/api/video-config', async (req, res) => {
    try {
      const config = await videoConfigStore.getConfig();
      const providerInfo = videoConfigStore.getAllProviderInfo();

      // 脱敏：不返回 apiKey 明文
      const masked = Object.fromEntries(
        Object.entries(config.providers).map(([key, val]: [string, any]) => [
          key,
          { ...val, apiKey: val.apiKey ? '***' + val.apiKey.slice(-4) : '' }
        ])
      );

      res.json({
        activeProvider: config.activeProvider,
        providers: masked,
        providerInfo
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新视频供应商配置
  app.post('/api/video-config', async (req, res) => {
    try {
      const { provider, config } = req.body;

      if (!provider || !config) {
        return res.status(400).json({ error: 'provider and config required' });
      }

      // 如果前端发的是掩码（***xxx），从当前配置里取真实 key
      const currentConfig = await videoConfigStore.getProvider(provider as VideoProvider);
      if (currentConfig && config.apiKey && config.apiKey.startsWith('***')) {
        config.apiKey = currentConfig.apiKey;
      }

      await videoConfigStore.updateProvider(provider as VideoProvider, config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 测试视频供应商连接
  app.post('/api/video-test', async (req, res) => {
    try {
      const { provider } = req.body;

      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      const result = await videoConfigStore.testProvider(provider as VideoProvider);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== 音频生成配置 (TTS / Music) ====================

  // 获取音频配置
  app.get('/api/audio-config', async (req, res) => {
    try {
      const config = await audioConfigStore.getConfig();
      const providerInfo = audioConfigStore.getAllProviderInfo();

      const masked = Object.fromEntries(
        Object.entries(config.providers).map(([key, val]: [string, any]) => [
          key,
          { ...val, apiKey: val.apiKey ? '***' + val.apiKey.slice(-4) : '' }
        ])
      );

      res.json({
        activeProvider: config.activeProvider,
        providers: masked,
        providerInfo
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新音频供应商配置
  app.post('/api/audio-config', async (req, res) => {
    try {
      const { provider, config } = req.body;
      if (!provider || !config) {
        return res.status(400).json({ error: 'provider and config required' });
      }

      // 掩码回写真实 key
      const currentConfig = await audioConfigStore.getProvider(provider as AudioProvider);
      if (currentConfig && config.apiKey && config.apiKey.startsWith('***')) {
        config.apiKey = currentConfig.apiKey;
      }

      await audioConfigStore.updateProvider(provider as AudioProvider, config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 测试音频供应商连接
  app.post('/api/audio-test', async (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }
      const result = await audioConfigStore.testProvider(provider as AudioProvider);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 统一 AI 解析入口：CLI / 接收方节点 调这里完成 LLM + judgment + harness
  // 入参: { text, mimeType, fileName, fromNodeId, source }
  // 出参: { summary, qualityScore, judgmentId?, gateArtifact? }
  app.post('/api/ai-parse', async (req, res) => {
    try {
      const { text, mimeType, fileName, fromNodeId, source } = req.body || {};
      if (!text || !fileName) {
        return res.status(400).json({ error: 'text and fileName required' });
      }

      const truncated = text.length > 6000 ? text.substring(0, 6000) + '...[截断]' : text;
      const prompt = `请分析以下 ${mimeType || 'text'} 文档，并给出 (1) 一句话中文摘要 (2) 三个关键要点 (3) 质量评分(0-1)。\n\n文件名: ${fileName}\n\n内容:\n${truncated}`;

      // 1. LLM 解析
      const llm = getMinimax();
      const t0 = Date.now();
      const llmResult = await llm.summarize(prompt);
      const dt = Date.now() - t0;

      const out: any = {
        ok: true,
        summary: llmResult.summary,
        qualityScore: llmResult.qualityScore,
        latencyMs: dt,
        mimeType: mimeType || 'text/plain',
        fileName,
      };

      // 2. 蒸馏为 judgment (异步,失败不影响主返回)
      try {
        const judgmentMod = await import('../pi-ecosystem-judgment/index.js');
        await judgmentMod.initializeJudgmentStore();
        const j = await judgmentMod.createJudgment({
          type: 'trajectory',
          content: `AI 解析 ${fileName}: ${llmResult.summary.slice(0, 200)}`,
          source: 'agent',
          confidence: Math.min(1, llmResult.qualityScore),
          context: `ai-parse:${mimeType || 'text'}:${source || 'p2p'}`,
          evidence: {
            trajectory: [{
              timestamp: new Date().toISOString(),
              action: `parse:${fileName}`,
              outcome: `score=${llmResult.qualityScore.toFixed(2)}`,
              approved: true,
            }],
          },
        });
        out.judgmentId = j.id;
      } catch (e) {
        out.judgmentError = (e as Error).message;
      }

      // 3. 在 harness 落产物 (异步,失败不影响)
      try {
        const harnessMod = await import('../bollharness-integration/index.js');
        const gate = new harnessMod.GateStateMachine();
        gate.submitArtifact(`ai-parse:${fileName}`, {
          summary: llmResult.summary,
          score: llmResult.qualityScore,
          fromNodeId: fromNodeId || null,
          parsedAt: Date.now(),
        });
        out.gateArtifact = `ai-parse:${fileName}`;
      } catch (e) {
        out.gateError = (e as Error).message;
      }

      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}