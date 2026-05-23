/**
 * LLM API Configuration Store
 * 支持多供应商 API 配置管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'gemini' | 'minimax' | 'local';

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
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  anthropic: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  openrouter: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet',
    temperature: 0.7,
    maxTokens: 4096,
    requiresApiKey: true
  },
  gemini: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
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
    model: 'MiniMax-M2',
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

export const PROVIDER_INFO: Record<ModelProvider, { name: string; description: string; requiresApiKey: boolean }> = {
  openai: { name: 'OpenAI', description: 'GPT-4, GPT-3.5 等模型', requiresApiKey: true },
  anthropic: { name: 'Anthropic', description: 'Claude 3.5 系列模型', requiresApiKey: true },
  openrouter: { name: 'OpenRouter', description: '聚合多个 AI 供应商', requiresApiKey: true },
  gemini: { name: 'Google Gemini', description: 'Gemini 系列模型', requiresApiKey: true },
  ollama: { name: 'Ollama', description: '本地 LLM 运行框架', requiresApiKey: false },
  minimax: { name: 'MiniMax', description: '国产大模型服务', requiresApiKey: true },
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
  if (process.env.OLLAMA_BASE_URL) {
    envConfigs.ollama = { ...DEFAULT_PROVIDER_CONFIGS.ollama, enabled: true, baseUrl: process.env.OLLAMA_BASE_URL };
  }

  let activeProvider: ModelProvider = 'ollama';
  if (process.env.OPENAI_API_KEY) activeProvider = 'openai';
  else if (process.env.ANTHROPIC_API_KEY) activeProvider = 'anthropic';
  else if (process.env.OPENROUTER_API_KEY) activeProvider = 'openrouter';
  else if (process.env.GEMINI_API_KEY) activeProvider = 'gemini';
  else if (process.env.MINIMAX_API_KEY) activeProvider = 'minimax';
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
      this.config = JSON.parse(data);
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
        return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 100)}`, latency };
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

  const activeConfig = config.providers[config.activeProvider];
  return {
    provider: config.activeProvider,
    apiKey: activeConfig.apiKey || undefined,
    baseUrl: activeConfig.baseUrl !== DEFAULT_PROVIDER_CONFIGS[config.activeProvider].baseUrl ? activeConfig.baseUrl : undefined,
    model: activeConfig.model !== DEFAULT_PROVIDER_CONFIGS[config.activeProvider].model ? activeConfig.model : undefined
  };
}