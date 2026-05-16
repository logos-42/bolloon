import { getMinimaxProvider, initMinimaxProvider, type MiniMaxProvider } from './minimax-provider.js';

interface MinimaxConfig {
  apiKey: string;
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
  private provider: MiniMaxProvider;
  private model: string;

  constructor(config: MinimaxConfig, provider: MiniMaxProvider) {
    this.provider = provider;
    this.model = config.model || 'MiniMax-M2.6';
  }

  async chat(message: string, context?: string): Promise<ChatResult> {
    const systemPrompt = '你是一个友好的AI助手，正在与用户对话。用户的工作目录是: ' + (context || process.cwd());

    try {
      const data = await this.provider.chat({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message, sender_name: 'user', sender_type: 'USER' }
        ],
        temperature: 0.8
      });

      if (data.base_resp?.status_msg) {
        console.error('Minimax API error:', data.base_resp.status_msg);
        return { reply: `AI服务暂时不可用: ${data.base_resp.status_msg}` };
      }

      const reply = data.choices?.[0]?.message?.content || '抱歉，我没有收到回复。';
      return { reply };
    } catch (error) {
      console.error('Minimax chat error:', error);
      return { reply: '抱歉，AI服务暂时不可用。' };
    }
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    const prompt = this.buildSummarizePrompt(text, context);

    try {
      const data = await this.provider.chat({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a professional document summarizer.' },
          { role: 'user', content: prompt, sender_name: 'user', sender_type: 'USER' }
        ],
        temperature: 0.7
      });

      if (data.base_resp?.status_msg) {
        console.error('Minimax API error:', data.base_resp.status_msg);
        return { summary: `API错误: ${data.base_resp.status_msg}`, qualityScore: 0 };
      }

      const content = data.choices?.[0]?.message?.content || '';
      const qualityScore = this.estimateQuality(text, content);

      return { summary: content, qualityScore };
    } catch (error) {
      console.error('Minimax API error:', error);
      return {
        summary: text.substring(0, 500) + '...',
        qualityScore: 0.5
      };
    }
  }

  private buildSummarizePrompt(text: string, context?: string): string {
    const maxLength = 8000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

    let prompt = `请为以下文档生成简洁准确的摘要：

${truncatedText}

请按以下格式输出：
## 摘要
[在此处撰写摘要]

## 质量自评
[评分 1-10，说明理由]`;

    if (context) {
      prompt = `背景信息：${context}

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

  async improveContent(content: string, requirements: string, context?: string): Promise<string> {
    const prompt = this.buildImprovePrompt(content, requirements, context);

    try {
      const data = await this.provider.chatPro({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a professional document editor and improver.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8
      });

      return data.choices?.[0]?.message?.content || content;
    } catch (error) {
      console.error('Minimax improve error:', error);
      return content;
    }
  }

  private buildImprovePrompt(content: string, requirements: string, context?: string): string {
    const maxLength = 8000;
    const truncatedContent = content.length > maxLength ? content.substring(0, maxLength) + '...' : content;

    let prompt = `请根据以下要求改进文档：

要求：${requirements}

原始文档：
${truncatedContent}

请直接输出改进后的文档，不要添加额外说明。`;

    if (context) {
      prompt = `背景信息：${context}

${prompt}`;
    }

    return prompt;
  }

  async shouldAutoSend(qualityScore: number, threshold: number = 0.7): Promise<boolean> {
    return qualityScore >= threshold;
  }
}

let minimaxInstance: MinimaxLLM | null = null;

export function initMinimax(config: MinimaxConfig): MinimaxLLM {
  const provider = initMinimaxProvider(config.apiKey);
  minimaxInstance = new MinimaxLLM(config, provider);
  return minimaxInstance;
}

export function getMinimax(): MinimaxLLM {
  if (!minimaxInstance) {
    throw new Error('Minimax not initialized. Call initMinimax first.');
  }
  return minimaxInstance;
}