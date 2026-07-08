/**
 * routes-llm-config.ts — LLM/Video/Audio 配置路由 (2026-07-06 抽出)
 *
 * 从 src/web/server.ts 抽出 (~230 行).
 * 包含 /api/llm-config/* /api/video-config/* /api/audio-config/* /api/ai-parse
 */

import type { Express } from 'express';
import { llmConfigStore, type ModelProvider } from '../llm/config-store.js';
import { videoConfigStore, type VideoProvider } from '../llm/video-config-store.js';
import { audioConfigStore, type AudioProvider } from '../llm/audio-config-store.js';
import { initMinimax, getMinimax } from '../constraints/index.js';

export function registerLlmConfigRoutes(app: Express): void {
  // ==================== LLM 配置 API ====================

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

  // 更新 LLM 配置
  app.post('/api/llm-config', async (req, res) => {
    try {
      const { provider, config } = req.body;

      if (!provider || !config) {
        return res.status(400).json({ error: 'provider and config required' });
      }

      // 如果前端发的是掩码（***xxx），从当前配置里取真实 key
      const currentConfig = await llmConfigStore.getProvider(provider as ModelProvider);
      if (currentConfig && config.apiKey && config.apiKey.startsWith('***')) {
        config.apiKey = currentConfig.apiKey;
      }

      await llmConfigStore.updateProvider(provider, config);

      // v0.2.15: 当用户保存一个 LLM 配置为 enabled + 有 key 时，自动把它切为
      // activeProvider 并 rebind runtime singleton。修原来的两个真问题：
      //   1) frontend Save 从不调 /api/llm-provider，于是 activeProvider 一直
      //      卡在 process 启动时的第一个值，新配置的 provider 永远不接管 chat
      //   2) 即使用户手动 active，updateProvider 不替换 modelInstance（只有
      //      当前 active 命中才 rebind），所以保存非 active 那个 provider 之后
      //      runtime 还是指向旧 provider + 旧 key
      // 现在：用户每保存一个 enabled 的 LLM 配置，bolloon 立即把这个 provider
      // 设成 active + 重新 init MinLLM/Pi SDK，让"配置 + 立刻能跑"成立。
      // 用户想保持旧 active，可以显式调 /api/llm-provider 改回去。
      const newConfig = await llmConfigStore.getProvider(provider as ModelProvider);
      const shouldAutoActivate =
        newConfig?.enabled === true &&
        // 如果 provider 不需要 key (如 ollama) 或者已经给了真 key，才激活
        (newConfig.apiKey || !newConfig.requiresApiKey);
      if (shouldAutoActivate) {
        await llmConfigStore.setActiveProvider(provider as ModelProvider);
        initMinimax({
          provider: provider as ModelProvider,
          apiKey: newConfig.apiKey || undefined,
          baseUrl: newConfig.baseUrl || undefined,
          model: newConfig.model || undefined
        });
      }

      res.json({ ok: true, autoActivated: shouldAutoActivate });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 设置活跃供应商
  app.post('/api/llm-provider', async (req, res) => {
    try {
      const { provider } = req.body;

      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      await llmConfigStore.setActiveProvider(provider as ModelProvider);

      // 重新初始化 Pi SDK
      const config = await llmConfigStore.getActiveProviderConfig();
      if (config) {
        initMinimax({
          provider: provider as ModelProvider,
          apiKey: config.apiKey || undefined,
          baseUrl: config.baseUrl || undefined,
          model: config.model || undefined
        });
      }

      res.json({ ok: true, provider });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 测试供应商连接
  app.post('/api/llm-test', async (req, res) => {
    try {
      const { provider } = req.body;

      if (!provider) {
        return res.status(400).json({ error: 'provider required' });
      }

      const result = await llmConfigStore.testProvider(provider as ModelProvider);
      res.json(result);
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