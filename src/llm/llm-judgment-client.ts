/**
 * LLM-as-Judge Client
 *
 * 集成 LLMConfigStore + PiAIModel + Prompt 配置
 * 实现真正的 LLM 原生判断力
 */

import { llmConfigStore, type ModelProvider } from './config-store.js';
import { PiAIModel, type ChatMessage } from './pi-ai.js';

export interface JudgmentPromptConfig {
  // 系统 Prompt
  systemPrompt: string;

  // 用户 Prompt 模板
  userPromptTemplate: string;

  // 输出格式
  outputFormat: 'json' | 'structured' | 'free';

  // 示例（few-shot）
  examples?: Array<{
    input: string;
    output: string;
  }>;
}

// 预定义的判断 Prompt 配置
export const JUDGMENT_PROMPTS: Record<string, JudgmentPromptConfig> = {
  // 默认判断 Prompt
  default: {
    systemPrompt: `你是一个专业的 AI 任务分析专家。你的职责是深入理解用户的问题，并给出精准的判断。

核心原则：
1. 第一性原理：追问问题的本质，而非表面现象
2. 多角度思考：考虑不同视角和影响因素
3. 上下文感知：理解对话历史和隐含意图
4. 动态评估：根据实际情况判断复杂性

你的判断会影响后续的智能体协作方式，请认真分析。`,

    userPromptTemplate: `【当前输入】
{user_input}

【对话历史】
{history}

【发送者】
{sender_name}

请分析以上输入，判断：

## 理解
1. 问题本质是什么？（how-to / why / what / should / feasibility）
2. 核心需求是什么？
3. 有哪些隐含信息需要注意？

## 评估
1. 复杂性等级（simple / moderate / complex / profound）
2. 为什么是这个等级？
3. 需要多深的理解？（surface / deeper / fundamental）

## 决策
1. 推荐处理方式（answer / analyze / design / implement / coordinate）
2. 为什么这样处理？

## 路由
1. 应该调用哪些 Skills？（arch / guardian-fixer / harness-eng / harness-dev / task-arch / crystal-learn）
2. 需要什么协作模式？（solo / pair / team）

请用 JSON 格式输出，格式如下：
{
  "understanding": {
    "essence": "问题本质",
    "coreNeed": "核心需求",
    "implicit": ["隐含信息1", "隐含信息2"]
  },
  "assessment": {
    "complexity": "complex",
    "complexityReason": "评估理由",
    "depth": "deeper"
  },
  "decision": {
    "approach": "design",
    "reasoning": "决策理由"
  },
  "routing": {
    "skills": ["arch", "guardian-fixer"],
    "collaboration": "pair"
  }
}`,

    outputFormat: 'json'
  },

  // 架构相关问题
  architecture: {
    systemPrompt: `你是一个经验丰富的系统架构师。你擅长：
- 从需求中提取本质问题
- 设计可扩展的系统架构
- 权衡技术方案
- 识别架构风险

你相信：
- 本质和实现必须分离
- 好的架构从简单规则中生长
- 复杂性应该被控制而非消除`,

    userPromptTemplate: `【架构设计问题】
{user_input}

【上下文】
{context}

请进行架构分析，判断是否需要 Harness 介入。

分析维度：
1. 涉及哪些架构维度？（分层、微服务、事件驱动等）
2. 需要什么级别的架构设计？（概念性、逻辑性、物理性）
3. 有什么架构风险需要考虑？

输出 JSON：
{
  "needsHarness": true/false,
  "gate": 0-8,
  "skills": ["arch", "harness-eng"],
  "architectureType": "microservices/layered/event-driven/etc",
  "concerns": ["concern1", "concern2"]
}`,

    outputFormat: 'json'
  },

  // 代码相关问题
  code: {
    systemPrompt: `你是一个高效的代码实现专家。你擅长：
- 快速理解和实现需求
- 编写清晰、可维护的代码
- 遵循最佳实践
- 处理边界情况`,

    userPromptTemplate: `【代码问题】
{user_input}

请判断这个问题：

1. 是新功能实现还是修复问题？
2. 涉及哪些代码层面？（业务逻辑、数据访问、接口设计）
3. 需要什么测试覆盖？

输出 JSON：
{
  "needsHarness": true/false,
  "gate": 0-8,
  "skills": ["harness-dev", "guardian-fixer"],
  "codeType": "feature/fix/refactor",
  "testCoverage": "unit/integration/e2e"
}`,

    outputFormat: 'json'
  },

  // 安全相关问题
  security: {
    systemPrompt: `你是一个严格的安全专家。你擅长：
- 识别安全风险
- 评估威胁模型
- 设计安全方案
- 遵循安全最佳实践`,

    userPromptTemplate: `【安全问题】
{user_input}

请分析安全问题：

1. 涉及哪些安全维度？（认证、授权、数据保护、传输安全）
2. 风险等级？（低/中/高/严重）
3. 需要什么安全措施？

输出 JSON：
{
  "needsHarness": true,
  "gate": 4,
  "skills": ["guardian-fixer", "arch"],
  "securityDimensions": ["authentication", "authorization"],
  "riskLevel": "high",
  "recommendations": ["rec1", "rec2"]
}`,

    outputFormat: 'json'
  }
};

export interface LLMJudgmentResult {
  // 理解
  understanding: {
    essence: string;
    coreNeed: string;
    implicit: string[];
  };

  // 评估
  assessment: {
    complexity: 'simple' | 'moderate' | 'complex' | 'profound';
    complexityReason: string;
    depth: 'surface' | 'deeper' | 'fundamental';
  };

  // 决策
  decision: {
    approach: 'answer' | 'analyze' | 'design' | 'implement' | 'coordinate';
    reasoning: string;
  };

  // 路由
  routing: {
    skills: string[];
    collaboration: 'solo' | 'pair' | 'team';
  };

  // 原始输出
  raw?: string;
}

/**
 * LLM-as-Judge 客户端
 */
export class LLMJudgmentClient {
  private model: PiAIModel | null = null;
  private useLLM: boolean = false;
  private promptConfig: JudgmentPromptConfig = JUDGMENT_PROMPTS.default;

  constructor(options?: {
    provider?: ModelProvider;
    useLLM?: boolean;
    promptConfig?: string; // 配置名称
  }) {
    if (options?.promptConfig && JUDGMENT_PROMPTS[options.promptConfig]) {
      this.promptConfig = JUDGMENT_PROMPTS[options.promptConfig];
    }
    this.useLLM = options?.useLLM ?? false;
  }

  /**
   * 初始化 LLM 模型
   */
  async initialize(): Promise<void> {
    if (this.useLLM) {
      const config = await llmConfigStore.getActiveProviderConfig();
      if (config && config.enabled) {
        this.model = new PiAIModel({
          provider: await llmConfigStore.getActiveProvider(),
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model
        });
        console.log('[LLM-as-Judge] Initialized with LLM');
      } else {
        console.warn('[LLM-as-Judge] No LLM provider configured, using quick judgment');
        this.useLLM = false;
      }
    }
  }

  /**
   * 设置 Prompt 配置
   */
  setPromptConfig(configName: string): void {
    if (JUDGMENT_PROMPTS[configName]) {
      this.promptConfig = JUDGMENT_PROMPTS[configName];
    }
  }

  /**
   * 执行 LLM 判断
   */
  async judge(
    userInput: string,
    options?: {
      history?: string[];
      senderName?: string;
      context?: string;
    }
  ): Promise<LLMJudgmentResult> {
    // 构建 prompt
    const historyStr = options?.history
      ? options.history.slice(-5).map((m, i) => `[${i + 1}] ${m}`).join('\n')
      : '无';

    const userPrompt = this.promptConfig.userPromptTemplate
      .replace('{user_input}', userInput)
      .replace('{history}', historyStr)
      .replace('{sender_name}', options?.senderName || 'Unknown')
      .replace('{context}', options?.context || '无');

    // 如果不使用 LLM 或模型未初始化，返回默认结果
    if (!this.useLLM || !this.model) {
      return this.quickJudgment(userInput);
    }

    try {
      // 调用 LLM
      const messages: ChatMessage[] = [
        { role: 'system', content: this.promptConfig.systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      const response = await this.model.chat(userPrompt);

      // 解析 JSON 输出
      return this.parseResponse(response.reply);
    } catch (error) {
      console.error('[LLM-as-Judge] LLM call failed:', error);
      return this.quickJudgment(userInput);
    }
  }

  /**
   * 解析 LLM 输出
   */
  private parseResponse(response: string): LLMJudgmentResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          understanding: {
            essence: parsed.understanding?.essence || parsed.essence || 'unknown',
            coreNeed: parsed.understanding?.coreNeed || parsed.coreNeed || 'unknown',
            implicit: parsed.understanding?.implicit || parsed.implicit || []
          },
          assessment: {
            complexity: this.normalizeComplexity(parsed.assessment?.complexity || parsed.complexity),
            complexityReason: parsed.assessment?.complexityReason || parsed.complexityReason || '',
            depth: this.normalizeDepth(parsed.assessment?.depth || parsed.depth)
          },
          decision: {
            approach: this.normalizeApproach(parsed.decision?.approach || parsed.approach),
            reasoning: parsed.decision?.reasoning || parsed.reasoning || ''
          },
          routing: {
            skills: parsed.routing?.skills || parsed.skills || [],
            collaboration: this.normalizeCollaboration(parsed.routing?.collaboration || parsed.collaboration)
          },
          raw: response
        };
      }
    } catch (e) {
      console.warn('[LLM-as-Judge] JSON parse failed, using fallback');
    }

    // 解析失败，返回默认结果
    return this.quickJudgment(response);
  }

  /**
   * 快速判断（fallback）
   */
  private quickJudgment(input: string): LLMJudgmentResult {
    const lower = input.toLowerCase();

    // 简化判断逻辑
    let complexity: LLMJudgmentResult['assessment']['complexity'] = 'moderate';
    let skills: string[] = [];
    let collaboration: LLMJudgmentResult['routing']['collaboration'] = 'solo';

    if (lower.includes('架构') || lower.includes('设计')) {
      skills = ['arch'];
      complexity = 'complex';
      collaboration = 'pair';
    }
    if (lower.includes('review') || lower.includes('审查')) {
      skills = ['guardian-fixer'];
    }
    if (lower.includes('安全') || lower.includes('权限')) {
      skills = ['guardian-fixer', 'arch'];
      complexity = 'complex';
    }
    if (lower.includes('任务') || lower.includes('分解')) {
      skills = ['task-arch'];
    }

    return {
      understanding: {
        essence: this.extractEssence(lower),
        coreNeed: this.extractCoreNeed(lower),
        implicit: []
      },
      assessment: {
        complexity,
        complexityReason: '基于快速模式判断',
        depth: 'surface'
      },
      decision: {
        approach: skills.length > 0 ? 'analyze' : 'answer',
        reasoning: '快速判断'
      },
      routing: {
        skills,
        collaboration
      }
    };
  }

  private extractEssence(input: string): string {
    if (input.includes('为什么')) return 'why';
    if (input.includes('怎么') || input.includes('如何')) return 'how-to';
    if (input.includes('应该')) return 'should';
    return 'general';
  }

  private extractCoreNeed(input: string): string {
    if (input.includes('设计') || input.includes('架构')) return '设计方案';
    if (input.includes('实现') || input.includes('写')) return '实现代码';
    if (input.includes('review') || input.includes('审查')) return '审查代码';
    return '获得帮助';
  }

  private normalizeComplexity(c: string): LLMJudgmentResult['assessment']['complexity'] {
    const lower = c.toLowerCase();
    if (lower.includes('simple')) return 'simple';
    if (lower.includes('moderate')) return 'moderate';
    if (lower.includes('complex')) return 'complex';
    return 'profound';
  }

  private normalizeDepth(d: string): LLMJudgmentResult['assessment']['depth'] {
    const lower = d.toLowerCase();
    if (lower.includes('surface')) return 'surface';
    if (lower.includes('deeper')) return 'deeper';
    return 'fundamental';
  }

  private normalizeApproach(a: string): LLMJudgmentResult['decision']['approach'] {
    const lower = a.toLowerCase();
    if (lower.includes('answer')) return 'answer';
    if (lower.includes('analyze')) return 'analyze';
    if (lower.includes('design')) return 'design';
    if (lower.includes('implement')) return 'implement';
    return 'coordinate';
  }

  private normalizeCollaboration(c: string): LLMJudgmentResult['routing']['collaboration'] {
    const lower = c.toLowerCase();
    if (lower.includes('solo')) return 'solo';
    if (lower.includes('pair')) return 'pair';
    return 'team';
  }
}

// 工厂函数
export function createLLMJudgmentClient(options?: {
  provider?: ModelProvider;
  useLLM?: boolean;
  promptConfig?: string;
}): LLMJudgmentClient {
  return new LLMJudgmentClient(options);
}

// 默认实例
let defaultClient: LLMJudgmentClient | null = null;

export async function getDefaultJudgmentClient(): Promise<LLMJudgmentClient> {
  if (!defaultClient) {
    defaultClient = createLLMJudgmentClient({ useLLM: true });
    await defaultClient.initialize();
  }
  return defaultClient;
}