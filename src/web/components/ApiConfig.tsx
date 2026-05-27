import React, { useState, useEffect, useCallback } from 'react';
import { ProviderGrid } from './ProviderGrid';

export interface Provider {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requiresApiKey: boolean;
}

export interface ProviderInfo {
  name: string;
  description: string;
  requiresApiKey: boolean;
}

export interface LLMConfig {
  activeProvider: string;
  providers: Record<string, Provider>;
  providerInfo: Record<string, ProviderInfo>;
  updatedAt: string;
}

export async function fetchLLMConfig(): Promise<LLMConfig> {
  const resp = await fetch('/api/llm-config');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function saveProviderConfig(
  provider: string,
  config: Partial<Provider>
): Promise<void> {
  const resp = await fetch('/api/llm-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, config }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}

export async function testProviderConnection(provider: string): Promise<{
  success: boolean;
  latency?: number;
  error?: string;
}> {
  const resp = await fetch('/api/llm-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  return resp.json();
}

export function ApiConfig() {
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLLMConfig();
      setConfig(data);
    } catch (err) {
      console.error('loadConfig failed:', err);
      setError(err instanceof Error ? err.message : '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleConfigSaved = useCallback(() => {
    loadConfig();
  }, [loadConfig]);

  if (loading) {
    return (
      <div className="loading-state">
        <div className="loading-spinner"></div>
        <p>加载中...</p>
        <p className="loading-hint">正在获取配置信息</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-state">
        <div className="error-icon">⚠️</div>
        <p className="error-message">加载失败: {error}</p>
        <button type="button" onClick={loadConfig} className="retry-btn">
          重试
        </button>
      </div>
    );
  }

  if (!config) return null;

  return <ProviderGrid config={config} onConfigSaved={handleConfigSaved} />;
}
