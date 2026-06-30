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
    model: 'gemini-3.5-pro',
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
    model: 'deepseek-chat',
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
    model: 'mimo-7b',
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
  gemini: { name: 'Google Gemini', description: 'Gemini 系列模型', requiresApiKey: true, models: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
  ollama: { name: 'Ollama', description: '本地 LLM 运行框架', requiresApiKey: false },
  minimax: {
    name: 'MiniMax',
    description: '国产大模型服务',
    requiresApiKey: true,
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2', 'MiniMax-M2.1-highspeed', 'MiniMax-M2.7-highspeed']
  },
  deepseek: { name: 'DeepSeek', description: '深度求索大模型', requiresApiKey: true, models: ['deepseek-chat', 'deepseek-reasoner'] },
  kimi: { name: 'Kimi (月之暗面)', description: 'Moonshot 长上下文模型', requiresApiKey: true, models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  glm: { name: 'GLM (智谱)', description: '智谱 ChatGLM 系列模型', requiresApiKey: true, models: ['glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4-air', 'glm-4-airx'] },
  qwen: { name: 'Qwen (通义千问)', description: '阿里云通义千问系列', requiresApiKey: true, models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'] },
  mimo: { name: 'MiMo (小米)', description: '小米 MiMo 系列 (openai 兼容)', requiresApiKey: true, models: ['mimo-7b', 'mimo-32b'] },
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

    this.config.activeProvider = provider;
    await this.save();
  }

  async updateProvider(provider: ModelProvider, updates: Partial<ProviderConfig>): Promise<void> {
    await this.initialize();

    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    this.config.providers[provider] = {
      ...this.config.providers[provider],
      ...updates
    };

    await this.save();
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
      const response = await fetch(`${config.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(provider, config)
      });

      const latency = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latency };
      } else {
        const errorText = await response.text().catch(() => 'Unknown error');
        const hint = response.status === 401
          ? '（API Key 无效或不匹配该供应商 — 请检查是否复制完整、有无多余空格）'
          : response.status === 404
          ? '（端点不存在 — 请检查 baseUrl）'
          : '';
        return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 500)}${hint ? ' ' + hint : ''}`, latency };
      }
    } catch (error: any) {
      return { success: false, error: error.message || 'Connection failed', latency: Date.now() - startTime };
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