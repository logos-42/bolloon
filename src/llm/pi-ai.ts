import * as path from 'path';
import * as fs from 'fs';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'gemini' | 'minimax' | 'local';

export interface ModelConfig {
  provider: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  reply: string;
}

export interface SummarizeResult {
  summary: string;
  qualityScore: number;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export class PiAIModel {
  private config: ModelConfig;
  private provider: ModelProvider;

  constructor(config: ModelConfig) {
    this.config = config;
    this.provider = config.provider;
  }

  async chat(message: string, context?: string): Promise<ChatResult> {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ];

    try {
      const response = await this.generateText({
        messages,
        temperature: 0.8
      });
      return { reply: response };
    } catch (error) {
      console.error('PiAI chat error:', error);
      return { reply: '抱歉，AI服务暂时不可用。' };
    }
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    const prompt = this.buildSummarizePrompt(text, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document summarizer.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      });

      const qualityScore = this.estimateQuality(text, response);
      return { summary: response, qualityScore };
    } catch (error) {
      console.error('PiAI summarize error:', error);
      return {
        summary: text.substring(0, 500) + '...',
        qualityScore: 0.5
      };
    }
  }

  async improveContent(content: string, requirements: string, context?: string): Promise<string> {
    const prompt = this.buildImprovePrompt(content, requirements, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document editor and improver.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8
      });
      return response;
    } catch (error) {
      console.error('PiAI improve error:', error);
      return content;
    }
  }

  private async generateText(options: GenerateOptions): Promise<string> {
    const { messages, temperature = 0.7, maxTokens = 4096 } = options;

    switch (this.provider) {
      case 'openai':
      case 'minimax':
        return this.callOpenAI(messages, temperature, maxTokens);
      case 'anthropic':
        return this.callAnthropic(messages, temperature, maxTokens);
      case 'ollama':
        return this.callOllama(messages, temperature);
      case 'openrouter':
        return this.callOpenRouter(messages, temperature, maxTokens);
      case 'gemini':
        return this.callGemini(messages, temperature, maxTokens);
      case 'local':
        return this.callLocal(messages, temperature);
      default:
        throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  private getApiKey(): string {
    return this.config.apiKey || this.getEnvApiKey();
  }

  private getEnvApiKey(): string {
    const envVars: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_API_KEY || '',
      anthropic: process.env.ANTHROPIC_API_KEY || '',
      ollama: '',
      openrouter: process.env.OPENROUTER_API_KEY || '',
      gemini: process.env.GEMINI_API_KEY || '',
      minimax: process.env.MINIMAX_API_KEY || '',
      local: ''
    };
    return envVars[this.provider] || '';
  }

  private getBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }

    // 允许通过 OPENAI_BASE_URL 等环境变量覆盖默认 base URL
    const baseUrls: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      local: 'http://localhost:11434'
    };

    return baseUrls[this.provider];
  }

  private mapModel(): string {
    const modelMap: Record<ModelProvider, string> = {
      openai: this.config.model || process.env.OPENAI_MODEL || 'gpt-4',
      anthropic: this.config.model || 'claude-3-5-sonnet-20241022',
      ollama: this.config.model || 'llama3.2',
      openrouter: this.config.model || 'anthropic/claude-3.5-sonnet',
      gemini: this.config.model || 'gemini-2.0-flash',
      minimax: this.config.model || process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
      local: this.config.model || 'llama3.2'
    };
    return modelMap[this.provider];
  }

  private async callOpenAI(messages: ChatMessage[], temperature: number, maxTokens: number): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }

    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || '';
  }

  private async callAnthropic(messages: ChatMessage[], temperature: number, maxTokens: number): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.getBaseUrl()}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages: userMessages,
        system: systemMessage,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { content?: { text?: string }[] };
    return data.content?.[0]?.text || '';
  }

  private async callOllama(messages: ChatMessage[], temperature: number): Promise<string> {
    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content || '';
  }

  private async callOpenRouter(messages: ChatMessage[], temperature: number, maxTokens: number): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }

    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://openclaw.ai',
        'X-Title': 'OpenClaw'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || '';
  }

  private async callGemini(messages: ChatMessage[], temperature: number, maxTokens: number): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = messages.find(m => m.role === 'system')?.content;

    const response = await fetch(
      `${this.getBaseUrl()}/models/${this.mapModel()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  private async callLocal(messages: ChatMessage[], temperature: number): Promise<string> {
    return this.callOllama(messages, temperature);
  }

  private buildSystemPrompt(context?: string): string {
    const envDetails = this.getEnvironmentDetails();
    return `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${context || process.cwd()}

## Environment
${envDetails}`;
  }

  private getEnvironmentDetails(): string {
    return `
## Available Workflows
- read - Read documents
- summarize - Summarize documents  
- improve - Improve documents
- collaborate - Multi-agent collaboration
- query - Query status
- report - Generate reports

## System Capabilities
- Document processing (Markdown, Text, PDF, DOCX)
- Multi-agent collaboration (P2P network)
- Workflow engine (constraint layer)
- Quality assessment and auto-send

## Current Time
${new Date().toISOString()}`;
  }

  private buildSummarizePrompt(text: string, context?: string): string {
    const maxLength = 8000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

    let prompt = `Please generate a concise and accurate summary for the following document:

${truncatedText}

Please output in the following format:
## Summary
[Write summary here]

## Quality Self-Assessment
[Score 1-10, with reasoning]`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  private buildImprovePrompt(content: string, requirements: string, context?: string): string {
    const maxLength = 8000;
    const truncatedContent = content.length > maxLength ? content.substring(0, maxLength) + '...' : content;

    let prompt = `Please improve the document according to the following requirements:

Requirements: ${requirements}

Original Document:
${truncatedContent}

Please output only the improved document without additional explanation.`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  estimateQuality(original: string, summary: string): number {
    const coverageRatio = summary.length / Math.max(original.length, 1);
    const hasKeyPoints = /\d+\s*[.。]/.test(summary);
    const decentLength = summary.length > 100 && summary.length < original.length * 0.5;

    let score = 0.5;
    if (coverageRatio > 0.1 && coverageRatio < 0.5) score += 0.2;
    if (hasKeyPoints) score += 0.15;
    if (decentLength) score += 0.15;

    return Math.min(1, score);
  }

  async shouldAutoSend(qualityScore: number, threshold: number = 0.7): Promise<boolean> {
    return qualityScore >= threshold;
  }
}

let modelInstance: PiAIModel | null = null;

export interface PiAIConfig {
  provider?: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function detectProvider(): ModelProvider {
  // 首先检查配置文件（优先级最高）
  try {
    const configPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'llm-config.json');
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (configData.activeProvider && configData.providers[configData.activeProvider]) {
      console.log('[PiAIModel] Detected provider from config:', configData.activeProvider);
      return configData.activeProvider;
    }
  } catch {}

  // 然后检查环境变量
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  if (process.env.MINIMAX_API_KEY) return 'minimax';

  return 'openai';
}

function detectModel(provider: ModelProvider): string {
  const defaults: Record<ModelProvider, string> = {
    openai: 'gpt-4',
    anthropic: 'claude-3-5-sonnet-20241022',
    ollama: 'llama3.2',
    openrouter: 'anthropic/claude-3.5-sonnet',
    gemini: 'gemini-2.0-flash',
    minimax: 'MiniMax-M2.7',
    local: 'llama3.2'
  };
  return defaults[provider];
}

export function initPiAI(config: PiAIConfig = {}): PiAIModel {
  const provider = config.provider || detectProvider();
  const model = config.model || detectModel(provider);

  console.log('[PiAIModel] Initializing with provider:', provider, 'model:', model);

  // 如果没有提供 apiKey，从配置文件读取
  let apiKey = config.apiKey;
  if (!apiKey) {
    try {
      const configPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'llm-config.json');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const providerConfig = configData.providers[provider];
      if (providerConfig?.apiKey) {
        apiKey = providerConfig.apiKey;
        console.log('[PiAIModel] Loaded apiKey from config for', provider);
      }
    } catch (e) {
      console.log('[PiAIModel] Error reading apiKey from config:', e);
    }
  }

  modelInstance = new PiAIModel({
    provider,
    apiKey,
    baseUrl: config.baseUrl,
    model
  });

  console.log('[PiAIModel] Model instance created, provider:', provider);
  return modelInstance;
}

export function getModel(): PiAIModel {
  if (!modelInstance) {
    throw new Error('PiAI not initialized. Call initPiAI first.');
  }
  return modelInstance;
}

export function isModelAvailable(): boolean {
  return modelInstance !== null;
}

export function getMinimax(): PiAIModel {
  return getModel();
}

export function initMinimax(config: PiAIConfig = {}): PiAIModel {
  return initPiAI(config);
}

export { PiAIModel as MinimaxLLM };
