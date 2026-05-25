/**
 * LLM-native Judgment Engine
 *
 * 核心理念：
 * - 不使用关键词匹配，而是让 LLM 理解用户意图
 * - 价值观注入：学习人类判断价值观，注入到 Prompt 中
 * - Skills 可以被动态调用
 *
 * 架构：
 * 1. LLM-as-Judge: 使用 LLM 执行真正的理解
 * 2. Value Injection: 从 human-value-store 获取价值观注入
 * 3. Dynamic-Skill-Routing: 根据判断结果动态调用 Skills
 */

import { createBollharnessIntegration } from './integration.js';
import {
  generateJudgmentPromptWithValues,
  type ValueInjectionConfig
} from '../pi-ecosystem-judgment/value-injection.js';
import {
  learnFromFeedback,
  learnFromCorrection
} from '../pi-ecosystem-judgment/human-value-store.js';
import { initPiAI, getModel, isModelAvailable } from '../llm/pi-ai.js';
import { getPiSDKConfig } from '../llm/config-store.js';

export interface LLMJudgmentResult {
  // 理解结果
  understanding: {
    essence: string;           // 问题本质
    coreNeed: string;          // 核心需求
    implicit: string[];        // 隐含信息
  };

  // 评估结果
  assessment: {
    complexity: 'simple' | 'moderate' | 'complex' | 'profound';
    complexityReason: string;   // 为什么是这个复杂性
    depth: 'surface' | 'deeper' | 'fundamental';
    urgency: 'low' | 'medium' | 'high' | 'critical';
  };

  // 决策
  decision: {
    approach: 'answer' | 'analyze' | 'design' | 'implement' | 'coordinate';
    reasoning: string;          // 决策理由
  };

  // 路由
  routing: {
    skills: string[];          // 应该调用的 Skills
    agents: string[];          // 应该参与的智能体
    collaboration: 'solo' | 'pair' | 'team';
  };

  // 产物
  artifacts: {
    required: string[];        // 需要什么产物
    gate?: number;            // 如果需要 gate
  };

  // 原始 LLM 输出
  raw?: string;
}

/**
 * 判断用的 Prompt 模板（可以从 YAML 加载）
 */
export const JUDGMENT_PROMPT_TEMPLATE = `你是一个专业的 AI 任务分析专家。你的职责是深入理解用户的问题，并给出精准的判断。

【输入】
{user_input}

【历史上下文】
{history_context}

请分析以上输入，回答以下问题：

## 1. 问题理解

**问题本质**：用户真正想要什么？这是什么类型的问题？
- how-to: 寻求操作指导
- why: 寻求解释
- what: 寻求定义
- should: 寻求建议
- feasibility: 寻求可行性评估

**核心需求**：用户最想要的结果是什么？

**隐含信息**：有什么用户没有明确说但需要考虑的因素？
- 时间压力？
- 质量要求？
- 风险限制？
- 团队协作？

## 2. 复杂性评估

**复杂性等级**：这个问题有多复杂？
- simple: 简单任务，直接可答
- moderate: 中等复杂，需要一定思考
- complex: 复杂问题，需要深入分析
- profound: 深刻问题，需要本质性思考

**评估理由**：为什么认为这是这个复杂性等级？

**深度**：需要多深的理解？
- surface: 表面理解即可
- deeper: 需要分析
- fundamental: 需要本质性思考

## 3. 处理决策

**推荐方式**：
- answer: 直接回答
- analyze: 深入分析
- design: 设计方案
- implement: 实现代码
- coordinate: 协调多智能体

**决策理由**：为什么推荐这个处理方式？

## 4. 路由决策

**应该调用的 Skills**（可选多个）：
- arch: 架构设计
- harness-dev: 开发实现
- guardian-fixer: 代码审查
- harness-eng: 工程协调
- harness-eng-test: 测试工程
- task-arch: 任务分解
- crystal-learn: 反思学习

**参与智能体**（可选）：
- architect: 架构师
- developer: 开发者
- reviewer: 审查员
- coordinator: 协调者

**协作模式**：
- solo: 单独处理
- pair: 配对协作
- team: 团队协作

## 5. 产出要求

**需要的产物**：
- 问题分析
- 方案设计
- 代码实现
- 测试用例
- 其他

**Gate 建议**（如果有）：
- Gate 0: 问题锁定
- Gate 1: 架构设计
- Gate 2: 架构审查
- Gate 3: 计划制定
- Gate 4: 计划审查
- Gate 5: 任务分解
- Gate 6: 任务审查
- Gate 7: 代码实现
- Gate 8: 测试验证

请用 JSON 格式输出分析结果。`;

/**
 * 简化的判断结果（用于快速场景）
 */
export interface QuickJudgment {
  complexity: 'simple' | 'moderate' | 'complex' | 'profound';
  approach: 'answer' | 'analyze' | 'design' | 'implement' | 'coordinate';
  skills: string[];
  collaboration: 'solo' | 'pair' | 'team';
}

/**
 * LLM-native Judgment Engine
 */
export class LLMJudgmentEngine {
  private harness: ReturnType<typeof createBollharnessIntegration>;
  private promptTemplate: string;
  private useLLM: boolean;
  private valueInjectionConfig: Partial<ValueInjectionConfig>;
  private recentJudgments: Array<{
    input: string;
    result: LLMJudgmentResult;
    timestamp: number;
  }> = [];

  constructor(options?: {
    useLLM?: boolean;
    promptTemplate?: string;
    valueInjectionConfig?: Partial<ValueInjectionConfig>;
  }) {
    this.harness = createBollharnessIntegration();
    this.promptTemplate = options?.promptTemplate || JUDGMENT_PROMPT_TEMPLATE;
    this.useLLM = options?.useLLM ?? true;
    this.valueInjectionConfig = options?.valueInjectionConfig || {};
  }

  /**
   * 设置判断用的 Prompt 模板
   */
  setPromptTemplate(template: string): void {
    this.promptTemplate = template;
  }

  /**
   * 设置价值观注入配置
   */
  setValueInjectionConfig(config: Partial<ValueInjectionConfig>): void {
    this.valueInjectionConfig = config;
  }

  /**
   * 从配置文件加载 Prompt
   */
  async loadPromptFromConfig(configPath: string): Promise<void> {
    // TODO: 从 YAML/JSON 加载 prompt 模板
    // 这个配置可以包含更复杂的 prompt 变体
  }

  /**
   * 执行 LLM 判断（集成价值观注入）
   */
  async judge(
    userInput: string,
    options?: {
      history?: string[];
      forceLLM?: boolean;
      context?: string;
    }
  ): Promise<LLMJudgmentResult> {
    // 如果强制不使用 LLM 或未配置，使用简化判断
    if (!this.useLLM && !options?.forceLLM) {
      return this.quickJudge(userInput);
    }

    // 构建 prompt（带价值观注入）
    const historyContext = options?.history
      ? options.history.slice(-5).join('\n')
      : '无历史上下文';

    const context = options?.context || userInput;

    // 生成带价值观的 prompt
    let prompt: string;
    try {
      prompt = await generateJudgmentPromptWithValues(
        userInput,
        context,
        options?.history || [],
        this.valueInjectionConfig
      );
    } catch (error) {
      // 价值观注入失败，使用基础 prompt
      console.warn('[LLMJudgment] Value injection failed, using base prompt:', error);
      prompt = this.promptTemplate
        .replace('{user_input}', userInput)
        .replace('{history_context}', historyContext);
    }

    try {
      // 调用 LLM（这里需要集成 LLMConfigStore）
      const result = await this.callLLM(prompt);

      // 解析 LLM 输出
      const judgmentResult = this.parseLLMOutput(result, userInput);

      // 记录判断结果（用于学习）
      this.recordJudgment(userInput, judgmentResult);

      return judgmentResult;
    } catch (error) {
      console.warn('[LLMJudgment] LLM call failed, falling back to quick judgment:', error);
      return this.quickJudge(userInput);
    }
  }

  /**
   * 记录判断结果（支持后续学习）
   */
  private recordJudgment(input: string, result: LLMJudgmentResult): void {
    this.recentJudgments.push({
      input,
      result,
      timestamp: Date.now()
    });

    // 保留最近 50 条判断
    if (this.recentJudgments.length > 50) {
      this.recentJudgments.shift();
    }
  }

  /**
   * 学习人类反馈（集成到判断引擎）
   */
  async learnFromHumanFeedback(
    originalInput: string,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    // 从反馈中学习
    await learnFromFeedback(originalInput, approved, reason);

    // 重新评估相关判断的置信度
    const relatedJudgment = this.recentJudgments.find(
      j => j.input.includes(originalInput.substring(0, 20))
    );

    if (relatedJudgment && !approved) {
      // 如果被拒绝，降低置信度
      console.log('[LLMJudgment] Learning from rejection, will adjust future judgments');
    }
  }

  /**
   * 学习修正（从错误中学习）
   */
  async learnFromCorrection(original: string, corrected: string, reason: string): Promise<void> {
    await learnFromCorrection(original, corrected, reason);
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string): Promise<string> {
    if (!isModelAvailable()) {
      const config = getPiSDKConfig();
      initPiAI(config);
    }

    const model = getModel();
    const result = await model.chat(prompt, process.cwd());
    return result.reply;
  }

  /**
   * 解析 LLM 输出
   */
  private parseLLMOutput(output: string, originalInput: string): LLMJudgmentResult {
    try {
      // 尝试解析 JSON
      const parsed = JSON.parse(output);

      return {
        understanding: {
          essence: parsed.essence || parsed.问题本质 || 'unknown',
          coreNeed: parsed.coreNeed || parsed.核心需求 || 'unknown',
          implicit: parsed.implicit || parsed.隐含信息 || []
        },
        assessment: {
          complexity: this.normalizeComplexity(parsed.complexity || parsed.复杂性等级),
          complexityReason: parsed.complexityReason || parsed.评估理由 || '',
          depth: this.normalizeDepth(parsed.depth || parsed.深度),
          urgency: this.normalizeUrgency(parsed.urgency || 'medium')
        },
        decision: {
          approach: this.normalizeApproach(parsed.approach || parsed.推荐方式),
          reasoning: parsed.reasoning || parsed.决策理由 || ''
        },
        routing: {
          skills: parsed.skills || parsed.应该调用的Skills || [],
          agents: parsed.agents || parsed.参与智能体 || [],
          collaboration: this.normalizeCollaboration(parsed.collaboration || parsed.协作模式)
        },
        artifacts: {
          required: parsed.artifacts || parsed.需要的产物 || [],
          gate: parsed.gate || parsed.Gate建议
        },
        raw: output
      };
    } catch {
      // JSON 解析失败，返回默认结果
      return this.quickJudge(originalInput);
    }
  }

  /**
   * 快速判断（不调用 LLM）
   */
  private quickJudge(userInput: string): LLMJudgmentResult {
    const input = userInput.toLowerCase();
    const words = userInput.length;

    // 复杂性评估
    let complexity: 'simple' | 'moderate' | 'complex' | 'profound' = 'moderate';
    let complexityReason = '';

    const hasDesignKeywords = input.includes('设计') || input.includes('架构');
    const hasReviewKeywords = input.includes('review') || input.includes('审查');
    const hasMultiSystem = input.includes('和') || input.includes('以及');
    const hasFundamental = input.includes('为什么') || input.includes('本质') || input.includes('根本');

    if (hasDesignKeywords || hasMultiSystem || words > 200) {
      complexity = 'complex';
      complexityReason = '涉及设计或多系统';
    }
    if (hasFundamental || (words > 500 && hasDesignKeywords)) {
      complexity = 'profound';
      complexityReason = '需要本质性思考';
    }
    if (words < 50 && !hasDesignKeywords) {
      complexity = 'simple';
      complexityReason = '简短输入，意图明确';
    }

    // 处理方式
    let approach: LLMJudgmentResult['decision']['approach'] = 'answer';
    if (hasDesignKeywords) approach = 'design';
    else if (hasReviewKeywords || input.includes('分析')) approach = 'analyze';
    else if (input.includes('实现') || input.includes('写')) approach = 'implement';

    // Skills
    const skills: string[] = [];
    if (hasDesignKeywords) skills.push('arch');
    if (hasReviewKeywords) skills.push('guardian-fixer');
    if (approach === 'implement') skills.push('harness-dev');
    if (complexity === 'complex' || complexity === 'profound') {
      skills.push('harness-eng');
    }

    // 协作模式
    const collaboration: LLMJudgmentResult['routing']['collaboration'] =
      complexity === 'profound' ? 'team' :
      complexity === 'complex' ? 'pair' : 'solo';

    return {
      understanding: {
        essence: this.extractEssence(input),
        coreNeed: this.extractCoreNeed(input),
        implicit: []
      },
      assessment: {
        complexity,
        complexityReason,
        depth: hasFundamental ? 'fundamental' : 'surface',
        urgency: input.includes('紧急') ? 'high' : 'medium'
      },
      decision: {
        approach,
        reasoning: '基于快速模式判断'
      },
      routing: {
        skills,
        agents: [],
        collaboration
      },
      artifacts: {
        required: approach === 'design' ? ['架构文档'] : ['回答']
      }
    };
  }

  private normalizeComplexity(c: string): LLMJudgmentResult['assessment']['complexity'] {
    const lower = c.toLowerCase();
    if (lower.includes('simple') || lower.includes('简单')) return 'simple';
    if (lower.includes('moderate') || lower.includes('中等')) return 'moderate';
    if (lower.includes('complex') || lower.includes('复杂')) return 'complex';
    return 'profound';
  }

  private normalizeDepth(d: string): LLMJudgmentResult['assessment']['depth'] {
    const lower = d.toLowerCase();
    if (lower.includes('surface') || lower.includes('表面')) return 'surface';
    if (lower.includes('deeper') || lower.includes('深入')) return 'deeper';
    return 'fundamental';
  }

  private normalizeUrgency(u: string): LLMJudgmentResult['assessment']['urgency'] {
    const lower = u.toLowerCase();
    if (lower.includes('low') || lower.includes('低')) return 'low';
    if (lower.includes('high') || lower.includes('高') || lower.includes('紧急')) return 'high';
    if (lower.includes('critical') || lower.includes('关键')) return 'critical';
    return 'medium';
  }

  private normalizeApproach(a: string): LLMJudgmentResult['decision']['approach'] {
    const lower = a.toLowerCase();
    if (lower.includes('answer') || lower.includes('回答')) return 'answer';
    if (lower.includes('analyze') || lower.includes('分析')) return 'analyze';
    if (lower.includes('design') || lower.includes('设计')) return 'design';
    if (lower.includes('implement') || lower.includes('实现')) return 'implement';
    return 'coordinate';
  }

  private normalizeCollaboration(c: string): LLMJudgmentResult['routing']['collaboration'] {
    const lower = c.toLowerCase();
    if (lower.includes('solo') || lower.includes('单独')) return 'solo';
    if (lower.includes('pair') || lower.includes('配对')) return 'pair';
    return 'team';
  }

  private extractEssence(input: string): string {
    if (input.includes('为什么')) return 'why: 寻求解释';
    if (input.includes('怎么') || input.includes('如何')) return 'how-to: 寻求指导';
    if (input.includes('应该')) return 'should: 寻求建议';
    return 'general: 一般性讨论';
  }

  private extractCoreNeed(input: string): string {
    const lower = input.toLowerCase();
    if (lower.includes('设计') || lower.includes('架构')) return '设计方案';
    if (lower.includes('实现') || lower.includes('写')) return '实现代码';
    if (lower.includes('修复') || lower.includes('解决')) return '修复问题';
    if (lower.includes('review') || lower.includes('审查')) return '审查代码';
    return '获得帮助';
  }
}

// 单例
let engineInstance: LLMJudgmentEngine | null = null;

export function createLLMJudgmentEngine(options?: {
  useLLM?: boolean;
  promptTemplate?: string;
}): LLMJudgmentEngine {
  return new LLMJudgmentEngine(options);
}

export function getLLMJudgmentEngine(): LLMJudgmentEngine {
  if (!engineInstance) {
    engineInstance = new LLMJudgmentEngine();
  }
  return engineInstance;
}

/**
 * Skill Prompt 配置（可以从 YAML 加载）
 */
export interface SkillPromptConfig {
  name: string;
  description: string;
  systemPrompt: string;        // 系统级 prompt
  userPromptTemplate: string;  // 用户输入的 prompt 模板
  examples?: Array<{
    input: string;
    output: string;
  }>;
  constraints?: string[];
  outputFormat?: string;
}

/**
 * Skills 的 Prompt 配置
 */
export const SKILL_PROMPTS: Record<string, SkillPromptConfig> = {
  arch: {
    name: 'arch',
    description: '架构设计专家',
    systemPrompt: `你是一个经验丰富的系统架构师。你擅长：
- 从需求中提取本质问题
- 设计可扩展的系统架构
- 权衡技术方案
- 识别架构风险

你相信：
- 本质和实现必须分离
- 好的架构从简单规则中生长
- 复杂性应该被控制而非消除`,
    userPromptTemplate: `用户需求：{user_input}

{context}

请进行架构分析：`,
    examples: [
      {
        input: '设计一个电商系统',
        output: '我将首先分析电商系统的核心本质：交易撮合...'
      }
    ],
    outputFormat: 'markdown'
  },

  'harness-dev': {
    name: 'harness-dev',
    description: '开发实现专家',
    systemPrompt: `你是一个高效的代码实现专家。你擅长：
- 快速理解和实现需求
- 编写清晰、可维护的代码
- 遵循最佳实践
- 处理边界情况

你相信：
- 代码即文档
- 测试是代码的一部分
- 简单优于复杂`,
    userPromptTemplate: `任务：{user_input}

技术栈：{tech_stack}

请实现代码：`,
    outputFormat: 'code'
  },

  'guardian-fixer': {
    name: 'guardian-fixer',
    description: '代码审查专家',
    systemPrompt: `你是一个严格的代码审查专家。你擅长：
- 发现潜在问题
- 提出改进建议
- 确保代码质量
- 平衡效率和安全性

你相信：
- 细节决定成败
- 代码审查是质量保障的最后防线
- 建设性批评比否定更有价值`,
    userPromptTemplate: `代码：\n{code}

审查范围：{scope}

请进行审查：`,
    outputFormat: 'structured'
  }
};

/**
 * 动态 Skill 调用器
 */
export class DynamicSkillRouter {
  private skillPrompts: Record<string, SkillPromptConfig>;
  private judgmentEngine: LLMJudgmentEngine;

  constructor(options?: { useLLM?: boolean }) {
    this.skillPrompts = SKILL_PROMPTS;
    this.judgmentEngine = createLLMJudgmentEngine({ useLLM: options?.useLLM ?? true });
  }

  /**
   * 根据判断结果动态调用 Skills
   */
  async routeAndExecute(
    userInput: string,
    judgment: LLMJudgmentResult,
    context?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    // 并行执行多个 Skills
    const skillPromises = judgment.routing.skills.map(async (skillName) => {
      const skillConfig = this.skillPrompts[skillName];
      if (!skillConfig) {
        console.warn(`[SkillRouter] Unknown skill: ${skillName}`);
        return { skill: skillName, result: null };
      }

      try {
        const result = await this.executeSkill(
          skillConfig,
          userInput,
          context
        );
        return { skill: skillName, result };
      } catch (error) {
        console.error(`[SkillRouter] Skill ${skillName} failed:`, error);
        return { skill: skillName, result: null, error };
      }
    });

    const skillResults = await Promise.all(skillPromises);

    for (const { skill, result, error } of skillResults) {
      results[skill] = result || { error: String(error) };
    }

    return results;
  }

  /**
   * 执行单个 Skill
   */
  private async executeSkill(
    skillConfig: SkillPromptConfig,
    userInput: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    // 构建 prompt
    let prompt = skillConfig.userPromptTemplate.replace('{user_input}', userInput);

    if (context) {
      for (const [key, value] of Object.entries(context)) {
        prompt = prompt.replace(`{${key}}`, String(value));
      }
    }

    // TODO: 调用 LLM 执行 Skill
    // 这里需要集成实际的 LLM 调用

    return `Skill ${skillConfig.name} executed with prompt:\n${prompt}`;
  }

  /**
   * 添加自定义 Skill
   */
  registerSkill(name: string, config: SkillPromptConfig): void {
    this.skillPrompts[name] = config;
  }

  /**
   * 获取可用的 Skills
   */
  listSkills(): string[] {
    return Object.keys(this.skillPrompts);
  }
}

// 导出工厂函数
export function createDynamicSkillRouter(options?: { useLLM?: boolean }): DynamicSkillRouter {
  return new DynamicSkillRouter(options);
}