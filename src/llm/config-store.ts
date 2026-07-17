/**
 * LLM API Configuration Store
 * 支持多供应商 API 配置管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'gemini' | 'minimax' | 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'mimo' | 'local';

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  requiresApiKey?: boolean;
}

export interface LLMConfig {
  activeProvider: ModelProvider;
  providers: Record<ModelProvider, ProviderConfig>;
  updatedAt: string;
}

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.bolloon');
const CONFIG_PATH = path.join(CONFIG_DIR, 'llm-config.json');

export const DEFAULT_PROVIDER_CONFIGS: Record<ModelProvider, ProviderConfig> = {
  openai: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  anthropic: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5-20250929',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  openrouter: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  gemini: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-pro',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  ollama: {
    enabled: true,
    apiKey: '',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: false
  },
  minimax: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  deepseek: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    // 2026-07-17: deepseek-chat (V3) 已不在官方 model list, 迁到 V4 系列 — deepseek-v4-flash
    //   1M context, 支持 tool calls, 默认 thinking mode (官方 https://api-docs.deepseek.com/quick_start/pricing)
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  kimi: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  glm: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  qwen: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  // 小米 MiMo (openai 兼容) — 默认 base URL https://api.xiaomi.com/v1
  mimo: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.xiaomi.com/v1',
    model: 'mimo-v2.5-pro',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  local: {
    enabled: false,
    apiKey: '',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: false
  }
};

export const PROVIDER_INFO: Record<ModelProvider, { name: string; description: string; requiresApiKey: boolean; models?: string[] }> = {
  openai: { name: 'OpenAI', description: 'GPT-4, GPT-3.5 等模型', requiresApiKey: true, models: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  anthropic: { name: 'Anthropic', description: 'Claude 3.5+ 系列模型', requiresApiKey: true, models: ['claude-sonnet-4-5-20250929', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'] },
  openrouter: { name: 'OpenRouter', description: '聚合多个 AI 供应商', requiresApiKey: true, models: ['anthropic/claude-sonnet-4.5', 'anthropic/claude-3.5-sonnet'] },
  gemini: { name: 'Google Gemini', description: 'Gemini 系列模型', requiresApiKey: true, models: [
    'gemini-3.5-flash',     // 2026-06 官方推荐 stable 旗舰 (https://ai.google.dev/gemini-api/docs/models)
    'gemini-2.5-pro',       // 高级推理, 仍为 GA
    'gemini-3.1-flash-lite',// 成本敏感场景
    'gemini-flash-latest',  // 滚动 alias → 当前 stable Flash
  ] },
  ollama: { name: 'Ollama', description: '本地 LLM 运行框架', requiresApiKey: false },
  minimax: {
    name: 'MiniMax',
    description: '国产大模型服务',
    requiresApiKey: true,
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2', 'MiniMax-M2.1-highspeed', 'MiniMax-M2.7-highspeed']
  },
  // 2026-07-17: V3 系列 (deepseek-chat / deepseek-reasoner) 官方已下线, 改 V4
  deepseek: { name: 'DeepSeek', description: '深度求索大模型 (V4)', requiresApiKey: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  kimi: { name: 'Kimi (月之暗面)', description: 'Moonshot 长上下文模型', requiresApiKey: true, models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  glm: { name: 'GLM (智谱)', description: '智谱 ChatGLM 系列模型', requiresApiKey: true, models: ['glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4-air', 'glm-4-airx'] },
  qwen: { name: 'Qwen (通义千问)', description: '阿里云通义千问系列', requiresApiKey: true, models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'] },
  mimo: { name: 'MiMo (小米)', description: '小米 MiMo V2 系列 (openai 兼容)', requiresApiKey: true, models: ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash', 'mimo-v2.5-pro-ultraspeed'] },
  local: { name: '本地模型', description: '本地部署的模型服务', requiresApiKey: false }
};

function getDefaultConfig(): LLMConfig {
  const envConfigs: Partial<Record<ModelProvider, ProviderConfig>> = {};

  if (process.env.OPENAI_API_KEY) {
    envConfigs.openai = { ...DEFAULT_PROVIDER_CONFIGS.openai, enabled: true, apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    envConfigs.anthropic = { ...DEFAULT_PROVIDER_CONFIGS.anthropic, enabled: true, apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENROUTER_API_KEY) {
    envConfigs.openrouter = { ...DEFAULT_PROVIDER_CONFIGS.openrouter, enabled: true, apiKey: process.env.OPENROUTER_API_KEY };
  }
  if (process.env.GEMINI_API_KEY) {
    envConfigs.gemini = { ...DEFAULT_PROVIDER_CONFIGS.gemini, enabled: true, apiKey: process.env.GEMINI_API_KEY };
  }
  if (process.env.MINIMAX_API_KEY) {
    envConfigs.minimax = { ...DEFAULT_PROVIDER_CONFIGS.minimax, enabled: true, apiKey: process.env.MINIMAX_API_KEY };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    envConfigs.deepseek = { ...DEFAULT_PROVIDER_CONFIGS.deepseek, enabled: true, apiKey: process.env.DEEPSEEK_API_KEY };
  }
  if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) {
    envConfigs.kimi = { ...DEFAULT_PROVIDER_CONFIGS.kimi, enabled: true, apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '' };
  }
  if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY) {
    envConfigs.glm = { ...DEFAULT_PROVIDER_CONFIGS.glm, enabled: true, apiKey: process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '' };
  }
  if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) {
    envConfigs.qwen = { ...DEFAULT_PROVIDER_CONFIGS.qwen, enabled: true, apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '' };
  }
  if (process.env.MIMO_API_KEY) {
    envConfigs.mimo = { ...DEFAULT_PROVIDER_CONFIGS.mimo, enabled: true, apiKey: process.env.MIMO_API_KEY };
  }
  if (process.env.OLLAMA_BASE_URL) {
    envConfigs.ollama = { ...DEFAULT_PROVIDER_CONFIGS.ollama, enabled: true, baseUrl: process.env.OLLAMA_BASE_URL };
  }

  let activeProvider: ModelProvider = 'ollama';
  if (process.env.OPENAI_API_KEY) activeProvider = 'openai';
  else if (process.env.ANTHROPIC_API_KEY) activeProvider = 'anthropic';
  else if (process.env.OPENROUTER_API_KEY) activeProvider = 'openrouter';
  else if (process.env.GEMINI_API_KEY) activeProvider = 'gemini';
  else if (process.env.MINIMAX_API_KEY) activeProvider = 'minimax';
  else if (process.env.DEEPSEEK_API_KEY) activeProvider = 'deepseek';
  else if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) activeProvider = 'kimi';
  else if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY) activeProvider = 'glm';
  else if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) activeProvider = 'qwen';
  else if (process.env.MIMO_API_KEY) activeProvider = 'mimo';
  else if (process.env.OLLAMA_BASE_URL) activeProvider = 'ollama';

  const providers = { ...DEFAULT_PROVIDER_CONFIGS };
  for (const [provider, config] of Object.entries(envConfigs)) {
    if (config) {
      providers[provider as ModelProvider] = config;
    }
  }

  return {
    activeProvider,
    providers,
    updatedAt: new Date().toISOString()
  };
}

class LLMConfigStore {
  private config: LLMConfig | null = null;
  private initialized: boolean = false;
  // v0.2.15: single-flight lock around read-modify-write of `~/.bolloon/llm-config.json`.
  // Prevents concurrent save() calls from clobbering each other when the user
  // configures two providers back-to-back (e.g. saving gemini, then anthropic, in
  // quick succession). One operation at a time, in call order.
  private writeChain: Promise<void> = Promise.resolve();

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain the new op after the previous one; swallow the previous op's
    // rejection so a single failed save does not poison subsequent writes.
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const data = await fs.readFile(CONFIG_PATH, 'utf-8');
      const loadedConfig = JSON.parse(data);

      // 确保加载的配置包含所有默认供应商，缺失的用默认值补充
      const defaultProviders = Object.keys(DEFAULT_PROVIDER_CONFIGS) as ModelProvider[];
      for (const provider of defaultProviders) {
        if (!loadedConfig.providers[provider]) {
          loadedConfig.providers[provider] = { ...DEFAULT_PROVIDER_CONFIGS[provider] };
        }
      }

      // 确保有 activeProvider
      const activeProvider = loadedConfig.activeProvider as ModelProvider;
      if (!activeProvider || !DEFAULT_PROVIDER_CONFIGS[activeProvider]) {
        loadedConfig.activeProvider = 'ollama';
      }

      this.config = loadedConfig;
    } catch {
      this.config = getDefaultConfig();
      await this.save();
    }

    this.initialized = true;
  }

  private async save(): Promise<void> {
    if (!this.config) return;
    this.config.updatedAt = new Date().toISOString();
    await fs.writeFile(CONFIG_PATH, JSON.stringify(this.config, null, 2));
  }

  async getConfig(): Promise<LLMConfig> {
    await this.initialize();
    return { ...this.config! };
  }

  async getProvider(provider: ModelProvider): Promise<ProviderConfig | null> {
    await this.initialize();
    return this.config?.providers[provider] || null;
  }

  async getActiveProvider(): Promise<ModelProvider> {
    await this.initialize();
    return this.config?.activeProvider || 'ollama';
  }

  async getActiveProviderConfig(): Promise<ProviderConfig | null> {
    await this.initialize();
    const provider = this.config?.activeProvider;
    if (!provider) return null;
    return this.config?.providers[provider] || null;
  }

  async setActiveProvider(provider: ModelProvider): Promise<void> {
    await this.initialize();

    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const providerConfig = this.config.providers[provider];
    if (providerConfig.requiresApiKey && !providerConfig.apiKey) {
      throw new Error(`${provider} requires an API key but none is configured`);
    }

    await this.withWriteLock(async () => {
      this.config!.activeProvider = provider;
      await this.save();
    });
  }

  async updateProvider(provider: ModelProvider, updates: Partial<ProviderConfig>): Promise<void> {
    await this.initialize();

    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    await this.withWriteLock(async () => {
      this.config!.providers[provider] = {
        ...this.config!.providers[provider],
        ...updates
      };
      await this.save();
    });
  }

  async testProvider(provider: ModelProvider): Promise<{ success: boolean; error?: string; latency?: number }> {
    await this.initialize();

    const config = this.config?.providers[provider];
    if (!config) {
      return { success: false, error: 'Provider not configured' };
    }

    if (!config.enabled) {
      return { success: false, error: 'Provider is not enabled' };
    }

    const startTime = Date.now();

    try {
      // v0.2.15: per-provider test endpoint. The old unified `GET baseUrl/models`
      // is wrong on at least two providers:
      //   - Anthropic has no GET /v1/models endpoint -> always 404.
      //   - Google's GET /v1beta/models returns the public model catalog
      //     without auth -> always 200, even with a wrong/expired key, so
      //     the user saw "connected" while chat requests still failed.
      // The per-provider branch below uses an endpoint that actually
      // gates on the key.
      const { url, init } = this.buildTestRequest(provider, config);
      const response = await fetch(url, init);

      const latency = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latency };
      } else {
        const errorText = await response.text().catch(() => 'Unknown error');
        const hint = response.status === 401
          ? '（API Key 无效或不匹配该供应商 — 请检查是否复制完整、有无多余空格）'
          : response.status === 403
          ? '（API Key 没有调用此端点的权限 — 请检查 key scope 或供应商 endpoint）'
          : response.status === 404
          ? '（端点不存在 — 请检查 baseUrl）'
          : response.status === 429
          ? '（供应商限流中 — 稍候再试）'
          : '';
        return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 500)}${hint ? ' ' + hint : ''}`, latency };
      }
    } catch (error: any) {
      return { success: false, error: error.message || 'Connection failed', latency: Date.now() - startTime };
    }
  }

  /**
   * Build the lightest "is the key + baseUrl healthy?" probe for the given
   * provider. Each branch targets an endpoint that *actually* validates the
   * credentials (as opposed to a public catalog or non-existent route).
   */
  private buildTestRequest(provider: ModelProvider, config: ProviderConfig): { url: string; init: RequestInit } {
    switch (provider) {
      case 'anthropic':
        // No GET /v1/models. Use a minimal /messages ping that fails fast
        // on bad keys (401) and rate-limits (429) without burning quota.
        return {
          url: `${config.baseUrl}/messages`,
          init: {
            method: 'POST',
            headers: this.buildHeaders(provider, config),
            body: JSON.stringify({
              model: config.model || 'claude-sonnet-4-5-20250929',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
          },
        };
      case 'gemini':
        // listModels with the key in the query string returns 400 for
        // an invalid key, 200 for a valid one. This is the only "light"
        // Gemini endpoint that gates on auth (generateContent would
        // burn quota on a real prompt).
        return {
          url: `${config.baseUrl}/models?key=${encodeURIComponent(config.apiKey)}`,
          init: { method: 'GET' },
        };
      case 'ollama':
        return { url: `${config.baseUrl}/api/tags`, init: { method: 'GET' } };
      case 'openai':
      case 'openrouter':
      case 'deepseek':
      case 'kimi':
      case 'glm':
      case 'qwen':
      case 'mimo':
      case 'minimax':
      case 'local':
        return {
          url: `${config.baseUrl}/models`,
          init: { method: 'GET', headers: this.buildHeaders(provider, config) },
        };
      default:
        return {
          url: `${config.baseUrl}/models`,
          init: { method: 'GET', headers: this.buildHeaders(provider, config) },
        };
    }
  }

  private buildHeaders(provider: ModelProvider, config: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    switch (provider) {
      case 'openai':
      case 'openrouter':
      case 'minimax':
      case 'deepseek':
      case 'kimi':
      case 'glm':
      case 'qwen':
        if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
        break;
      case 'anthropic':
        if (config.apiKey) headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        break;
      case 'gemini':
        if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
        break;
    }

    return headers;
  }

  getProviderInfo(provider: ModelProvider) {
    return PROVIDER_INFO[provider];
  }

  getAllProviderInfo() {
    return PROVIDER_INFO;
  }
}

export const llmConfigStore = new LLMConfigStore();

export function getPiSDKConfig(): {
  provider: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} {
  const config = (llmConfigStore as any).config;
  if (!config) {
    return { provider: 'ollama' };
  }

  const activeProvider = config.activeProvider as ModelProvider;
  const activeConfig = config.providers[activeProvider] || {};
  const defaultConfig = DEFAULT_PROVIDER_CONFIGS[activeProvider] || { baseUrl: '', model: '' };
  return {
    provider: activeProvider,
    apiKey: activeConfig.apiKey || undefined,
    baseUrl: activeConfig.baseUrl !== defaultConfig.baseUrl ? activeConfig.baseUrl : undefined,
    model: activeConfig.model !== defaultConfig.model ? activeConfig.model : undefined
  };
}