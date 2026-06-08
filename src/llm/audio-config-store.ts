/**
 * Audio Generation API Configuration Store
 *
 * 音频模型配置：MiniMax 提供的 Speech（TTS+ASR）与 Music（文生音乐）。
 * 与 LLM / 视频配置完全独立，持久化到 ~/.bolloon/audio-config.json。
 *
 * 复用 LLM 那一套 MINIMAX_API_KEY 即可（同源）。
 * - TTS:  POST /audio/speech  （OpenAI 兼容，body 含 model/voice/input）
 * - ASR:  POST /audio/transcriptions
 * - Music: POST /music_generation  （MiniMax 自有端点）
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type AudioProvider = 'minimax-speech' | 'minimax-music';

export interface AudioProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** TTS 音色：male / female / ... */
  voice?: string;
  /** TTS 语速：0.5-2.0 */
  speed?: number;
  /** TTS 输出格式：mp3 / pcm / wav */
  format?: string;
  /** 音乐生成：instrumental / lyrics */
  mode?: string;
  /** 默认时长（秒） */
  duration?: number;
  requiresApiKey?: boolean;
}

export interface AudioConfig {
  activeProvider: AudioProvider;
  providers: Record<AudioProvider, AudioProviderConfig>;
  updatedAt: string;
}

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.bolloon');
const CONFIG_PATH = path.join(CONFIG_DIR, 'audio-config.json');

export const DEFAULT_AUDIO_PROVIDER_CONFIGS: Record<AudioProvider, AudioProviderConfig> = {
  'minimax-speech': {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'speech-01',
    voice: 'male-qn-jingying',
    speed: 1.0,
    format: 'mp3',
    requiresApiKey: true
  },
  'minimax-music': {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'music-01',
    mode: 'instrumental',
    duration: 30,
    requiresApiKey: true
  }
};

export const AUDIO_PROVIDER_INFO: Record<AudioProvider, { name: string; description: string; requiresApiKey: boolean; docs?: string; kind: 'speech' | 'music' }> = {
  'minimax-speech': {
    name: 'MiniMax Speech',
    description: 'TTS 文生语音 / ASR 语音转写',
    requiresApiKey: true,
    docs: 'https://platform.minimaxi.com/document/T2A%20V2',
    kind: 'speech'
  },
  'minimax-music': {
    name: 'MiniMax Music',
    description: '文生音乐 (纯音乐 / 带歌词)',
    requiresApiKey: true,
    docs: 'https://platform.minimaxi.com/document/Music%20Generation',
    kind: 'music'
  }
};

function getDefaultConfig(): AudioConfig {
  const envConfigs: Partial<Record<AudioProvider, AudioProviderConfig>> = {};

  const sharedKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || '';
  if (sharedKey) {
    envConfigs['minimax-speech'] = {
      ...DEFAULT_AUDIO_PROVIDER_CONFIGS['minimax-speech'],
      enabled: true,
      apiKey: sharedKey
    };
    envConfigs['minimax-music'] = {
      ...DEFAULT_AUDIO_PROVIDER_CONFIGS['minimax-music'],
      enabled: true,
      apiKey: sharedKey
    };
  }

  const activeProvider: AudioProvider = 'minimax-speech';

  const providers = { ...DEFAULT_AUDIO_PROVIDER_CONFIGS };
  for (const [provider, config] of Object.entries(envConfigs)) {
    if (config) {
      providers[provider as AudioProvider] = config;
    }
  }

  return {
    activeProvider,
    providers,
    updatedAt: new Date().toISOString()
  };
}

class AudioConfigStore {
  private config: AudioConfig | null = null;
  private initialized: boolean = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const data = await fs.readFile(CONFIG_PATH, 'utf-8');
      const loadedConfig = JSON.parse(data);

      // 补齐缺失的供应商
      const defaultProviders = Object.keys(DEFAULT_AUDIO_PROVIDER_CONFIGS) as AudioProvider[];
      for (const provider of defaultProviders) {
        if (!loadedConfig.providers[provider]) {
          loadedConfig.providers[provider] = { ...DEFAULT_AUDIO_PROVIDER_CONFIGS[provider] };
        }
      }

      const activeProvider = loadedConfig.activeProvider as AudioProvider;
      if (!activeProvider || !DEFAULT_AUDIO_PROVIDER_CONFIGS[activeProvider]) {
        loadedConfig.activeProvider = 'minimax-speech';
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

  async getConfig(): Promise<AudioConfig> {
    await this.initialize();
    return { ...this.config! };
  }

  async getProvider(provider: AudioProvider): Promise<AudioProviderConfig | null> {
    await this.initialize();
    return this.config?.providers[provider] || null;
  }

  async getActiveProvider(): Promise<AudioProvider> {
    await this.initialize();
    return this.config?.activeProvider || 'minimax-speech';
  }

  async getActiveProviderConfig(): Promise<AudioProviderConfig | null> {
    await this.initialize();
    const provider = this.config?.activeProvider;
    if (!provider) return null;
    return this.config?.providers[provider] || null;
  }

  async setActiveProvider(provider: AudioProvider): Promise<void> {
    await this.initialize();
    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown audio provider: ${provider}`);
    }
    this.config.activeProvider = provider;
    await this.save();
  }

  async updateProvider(provider: AudioProvider, updates: Partial<AudioProviderConfig>): Promise<void> {
    await this.initialize();
    if (!this.config?.providers[provider]) {
      throw new Error(`Unknown audio provider: ${provider}`);
    }
    this.config.providers[provider] = {
      ...this.config.providers[provider],
      ...updates
    };
    await this.save();
  }

  /**
   * 测试连接：探测 /models 端点。
   */
  async testProvider(provider: AudioProvider): Promise<{ success: boolean; error?: string; latency?: number }> {
    await this.initialize();

    const config = this.config?.providers[provider];
    if (!config) return { success: false, error: 'Provider not configured' };
    if (!config.enabled) return { success: false, error: 'Provider is not enabled' };
    if (config.requiresApiKey && !config.apiKey) {
      return { success: false, error: 'API key is required' };
    }

    const startTime = Date.now();
    try {
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
    return AUDIO_PROVIDER_INFO;
  }
}

export const audioConfigStore = new AudioConfigStore();
