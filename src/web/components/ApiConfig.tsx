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
      <div className="flex flex-col items-center justify-center py-20 gap-6">
        <div className="relative">
          <div className="w-12 h-12 border-2 border-accent/20 border-t-accent rounded-full animate-spin" />
          <div className="absolute inset-0 w-12 h-12 border-2 border-accent/5 border-b-accent/5 rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
        </div>
        <div className="text-center">
          <p className="text-text font-medium mb-1">加载中...</p>
          <p className="text-text-muted text-sm">正在获取配置信息</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-6">
        <div className="relative">
          <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
        </div>
        <div className="text-center">
          <p className="text-text font-medium mb-1">加载失败</p>
          <p className="text-text-muted text-sm mb-4">{error}</p>
        </div>
        <button
          onClick={loadConfig}
          className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-medium cursor-pointer transition-all duration-200 bg-gradient-to-r from-accent/10 to-accent/5 border border-accent/30 text-accent hover:border-accent/50 hover:from-accent/20"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          重试
        </button>
      </div>
    );
  }

  if (!config) return null;

  return <ProviderGrid config={config} onConfigSaved={handleConfigSaved} />;
}
