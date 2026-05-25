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
