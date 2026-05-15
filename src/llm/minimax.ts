interface MinimaxConfig {
  apiKey: string;
  model?: string;
}

interface SummarizeResult {
  summary: string;
  qualityScore: number;
}

export class MinimaxLLM {
  private apiKey: string;
  private model: string;

  constructor(config: MinimaxConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'abab6-chat';
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    const prompt = this.buildSummarizePrompt(text, context);

    try {
      const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_pro', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a professional document summarizer.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        throw new Error(`Minimax API error: ${response.status}`);
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content || '';

      const qualityScore = this.estimateQuality(text, content);

      return {
        summary: content,
        qualityScore
      };
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
      const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_pro', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a professional document editor and improver.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.8
        })
      });

      if (!response.ok) {
        throw new Error(`Minimax API error: ${response.status}`);
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
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
  minimaxInstance = new MinimaxLLM(config);
  return minimaxInstance;
}

export function getMinimax(): MinimaxLLM {
  if (!minimaxInstance) {
    throw new Error('Minimax not initialized. Call initMinimax first.');
  }
  return minimaxInstance;
}