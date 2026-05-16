import { PiAIModel, initPiAI, getModel, isModelAvailable, type PiAIConfig, type ModelProvider } from './pi-ai.js';

export interface MinimaxConfig extends PiAIConfig {
  apiKey?: string;
  model?: string;
}

export interface SummarizeResult {
  summary: string;
  qualityScore: number;
}

export interface ChatResult {
  reply: string;
}

export class MinimaxLLM {
  private model: PiAIModel;

  constructor(config: MinimaxConfig) {
    this.model = initPiAI({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model
    });
  }

  async chat(message: string, context?: string): Promise<ChatResult> {
    return this.model.chat(message, context);
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    return this.model.summarize(text, context);
  }

  async improveContent(content: string, requirements: string, context?: string): Promise<string> {
    return this.model.improveContent(content, requirements, context);
  }

  estimateQuality(original: string, summary: string): number {
    return this.model.estimateQuality(original, summary);
  }

  async shouldAutoSend(qualityScore: number, threshold: number = 0.7): Promise<boolean> {
    return this.model.shouldAutoSend(qualityScore, threshold);
  }
}

export type { ModelProvider };

export { initPiAI, getModel, isModelAvailable } from './pi-ai.js';

let minimaxInstance: MinimaxLLM | null = null;

export function initMinimax(config: MinimaxConfig): MinimaxLLM {
  minimaxInstance = new MinimaxLLM(config);
  return minimaxInstance;
}

export function getMinimax(): MinimaxLLM {
  if (!minimaxInstance) {
    if (isModelAvailable()) {
      const piModel = getModel();
      minimaxInstance = new MinimaxLLM({});
      (minimaxInstance as any).model = piModel;
      return minimaxInstance;
    }
    throw new Error('Minimax not initialized. Call initMinimax first.');
  }
  return minimaxInstance;
}
