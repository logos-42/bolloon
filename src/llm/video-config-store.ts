/**
 * Video Generation API Configuration Store
 *
 * 视频生成模型配置（与 LLM 完全独立）。当前内置 Seedance（火山引擎 ARK）。
 * Seedance 任务流: POST /contents/generations/tasks → 轮询 GET /contents/generations/tasks/{id}
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type VideoProvider = 'seedance' | 'minimax-video';

export interface VideoProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 默认分辨率，如 720p / 1080p */
  resolution?: string;
  /** 默认时长（秒） */
  duration?: number;
  /** 默认宽高比，如 16:9 / 9:16 / 1:1 */
  ratio?: string;
  /** 是否需要 API Key（火山方舟需要） */
  requiresApiKey?: boolean;
}

export interface VideoConfig {
  activeProvider: VideoProvider;
  providers: Record<VideoProvider, VideoProviderConfig>;
  updatedAt: string;
}

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.bolloon');
const CONFIG_PATH = path.join(CONFIG_DIR, 'video-config.json');

export const DEFAULT_VIDEO_PROVIDER_CONFIGS: Record<VideoProvider, VideoProviderConfig> = {
  seedance: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // 文生视频 lite 版（也支持图生视频，加 --resolution 等参数）
    model: 'doubao-seedance-1-0-lite-t2v-250428',
    resolution: '720p',
    duration: 5,
    ratio: '16:9',
    requiresApiKey: true
  },
  'minimax-video': {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-video-01',
    resolution: '720p',
    duration: 6,
    ratio: '16:9',
    requiresApiKey: true
  }
};

export const VIDEO_PROVIDER_INFO: Record<VideoProvider, { name: string; description: string; requiresApiKey: boolean; docs?: string }> = {
  seedance: {
    name: 'Seedance (火山方舟)',
    description: '字节跳动文生视频 / 图生视频模型',
    requiresApiKey: true,
    docs: 'https://www.volcengine.com/docs/82379'
  },
  'minimax-video': {
    name: 'MiniMax Video',
    description: 'MiniMax 文生视频 (Video-01)',
    requiresApiKey: true,
    docs: 'https://platform.minimaxi.com/document/Video%20Generation'
  }
};

function getDefaultConfig(): VideoConfig {
  const envConfigs: Partial<Record<VideoProvider, VideoProviderConfig>> = {};

  if (process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY) {
    envConfigs.seedance = {
      ...DEFAULT_VIDEO_PROVIDER_CONFIGS.seedance,
      enabled: true,
      apiKey: process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY || ''
    };
  }

  const sharedKey = process.env.MINIMAX_API_KEY || '';
  if (sharedKey) {
    envConfigs['minimax-video'] = {
      ...DEFAULT_VIDEO_PROVIDER_CONFIGS['minimax-video'],
      enabled: true,
      apiKey: sharedKey
    };
  }

  const activeProvider: VideoProvider = 'seedance';

  const providers = { ...DEFAULT_VIDEO_PROVIDER_CONFIGS };
  for (const [provider, config] of Object.entries(envConfigs)) {
    if (config) {
      providers[provider as VideoProvider] = config;
    }
  }

  return {
    activeProvider,
    providers,
    updatedAt: new Date().toISOString()
  };
}

class VideoConfigStore {
  private config: VideoConfig | null = null;
  private initialized: boolean = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const data = await fs.readFile(CONFIG_PATH, 'utf-8');
      const loadedConfig = JSON.parse(data);

      // 确保加载的配置包含所有默认供应商
      const defaultProviders = Object.keys(DEFAULT_VIDEO_PROVIDER_CONFIGS) as VideoProvider[];
      for (const provider of defaultProviders) {
        if (!loadedConfig.providers[provider]) {
          loadedConfig.providers[provider] = { ...DEFAULT_VIDEO_PROVIDER_CONFIGS[provider] };
        }
      }

      const activeProvider = loadedConfig.activeProvider as VideoProvider;
      if (!activeProvider || !DEFAULT_VIDEO_PROVIDER_CONFIGS[activeProvider]) {
        loadedConfig.activeProvider = 'seedance';
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

  async getConfig(): Promise<VideoConfig> {
    await this.initialize();
    return { ...this.config! };
  }

  async getProvider(provider: VideoProvider): Promise<VideoProviderConfig | null> {
    await this.initialize();
    return this.config?.providers[provider] || null;
  }

  async getActiveProvider(): Promise<VideoProvider> {
    await this.initialize();
    return this.config?.activeProvider || 'seedance';
  }

  async getActiveProviderConfig(): Promise<VideoProviderConfig | null> {
    await this.initialize();
    const provider = this.config?.activeProvider;
    if (!provider) return null;
    return this.config?.providers[provider] || null;
  }

  async setActiveProvider(provider: VideoProvider): Promise<void> {
    await this.initialize();

    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown video provider: ${provider}`);
    }

    this.config.activeProvider = provider;
    await this.save();
  }

  async updateProvider(provider: VideoProvider, updates: Partial<VideoProviderConfig>): Promise<void> {
    await this.initialize();

    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown video provider: ${provider}`);
    }

    this.config.providers[provider] = {
      ...this.config.providers[provider],
      ...updates
    };

    await this.save();
  }

  /**
   * 测试连接：只校验 API key 是否能被 ARK 接受（创建任务失败不算连接失败，
   * 返回 401/403 才算失败）。
   */
  async testProvider(provider: VideoProvider): Promise<{ success: boolean; error?: string; latency?: number }> {
    await this.initialize();

    const config = this.config?.providers[provider];
    if (!config) {
      return { success: false, error: 'Provider not configured' };
    }

    if (!config.enabled) {
      return { success: false, error: 'Provider is not enabled' };
    }

    if (config.requiresApiKey && !config.apiKey) {
      return { success: false, error: 'API key is required' };
    }

    const startTime = Date.now();

    try {
      // 列出可用模型（轻量级健康检查）。ARK 端点：GET /models
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` }
      });

      const latency = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latency };
      } else {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
          latency
        };
      }
    } catch (error: any) {
      return { success: false, error: error.message || 'Connection failed', latency: Date.now() - startTime };
    }
  }

  getAllProviderInfo() {
    return VIDEO_PROVIDER_INFO;
  }
}

export const videoConfigStore = new VideoConfigStore();
