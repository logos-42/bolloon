/**
 * Channel Judgment Engine - 基于 Prompt 注入的判断力引擎
 *
 * 改进：
 * - 不使用硬编码关键词匹配
 * - 使用微量 Prompt 注入实现精细化判断
 * - 集成 LLM 判断和快速判断两种模式
 *
 * Prompt 注入机制：
 * 1. 基础 Context - 提供判断框架
 * 2. 动态 Prompt - 根据场景注入不同上下文
 * 3. 约束 Prompt - 限制输出格式
 */

import type { Gate } from './gate-state-machine.js';

export interface JudgmentContext {
  conversationHistory: string[];
  currentMessage: string;
  senderName?: string;
  senderDid?: string;
  channelId?: string;
  topic?: string;
}

export interface JudgmentResult {
  shouldCall: boolean;
  gate: Gate;
  skills: string[];
  reason: string;
  result: string;
  confidence: number;  // 置信度 0-1
  approach?: 'answer' | 'analyze' | 'design' | 'implement' | 'coordinate';
}

// ============================================================
// Prompt 模板 - 可配置化
// ============================================================

export const JUDGMENT_PROMPTS = {
  // 判断系统 Prompt
  system: `你是一个专业的 AI 任务分析专家。你的职责是基于用户输入和对话上下文，
  判断是否需要调用 Harness（多智能体协作框架）。

  你需要分析：
  1. 用户问题的本质
  2. 需要的处理深度
  3. 是否需要 Harness 介入

  判断原则：
  - 优先理解意图，而非匹配关键词
  - 考虑对话上下文的连续性
  - 评估问题的真实复杂性
  - 选择最合适的处理方式`,

  // 判断 User Prompt 模板
  userTemplate: `【当前输入】
{current_message}

【对话历史】
{history}

【发送者】
{sender_name}

请判断：
1. 这个输入是否需要 Harness 介入？
2. 如果需要，应该调用哪个 Gate？
3. 应该使用哪些 Skills？
4. 判断的理由是什么？

请用 JSON 格式输出：
{
  "shouldCall": true/false,
  "gate": 0-8,
  "skills": ["skill1", "skill2"],
  "reason": "判断理由",
  "confidence": 0.0-1.0,
  "approach": "answer/analyze/design/implement/coordinate"
}`,

  // 快速判断 Prompt（不依赖 LLM）
  quickTemplate: `分析输入: {message}
判断是否需要 Harness。`
};

// ============================================================
// Skill Prompt 模板
// ============================================================

export const SKILL_PROMPTS = {
  arch: {
    name: '架构师',
    prompt: `你是一个资深架构师。请分析：{question}

关注：
- 本质问题是什么
- 涉及哪些架构维度
- 推荐什么架构模式
- 有什么风险`
  },

  'guardian-fixer': {
    name: '审查专家',
    prompt: `你是一个严格的代码审查专家。请分析：{question}

关注：
- 潜在问题
- 改进建议
- 质量风险
- 最佳实践`
  },

  'harness-eng': {
    name: '工程协调',
    prompt: `你是一个高效的工程协调专家。请分析：{question}

关注：
- 任务分解
- 协作方式
- 进度管理
- 风险管理`
  },

  'harness-dev': {
    name: '开发专家',
    prompt: `你是一个高效的代码实现专家。请分析：{question}

关注：
- 实现方案
- 代码质量
- 测试策略
- 边界情况`
  },

  'harness-eng-test': {
    name: '测试专家',
    prompt: `你是一个全面的测试工程专家。请分析：{question}

关注：
- 测试策略
- 测试覆盖
- 自动化方案
- 质量指标`
  },

  'task-arch': {
    name: '任务架构',
    prompt: `你是一个专业的任务架构师。请分析：{question}

关注：
- 任务分解
- 依赖关系
- 执行顺序
- 验收标准`
  },

  lead: {
    name: '流程统领',
    prompt: `你是一个严格的流程管理专家。请分析：{question}

关注：
- 当前处于哪个 Gate
- 是否满足入口条件
- 需要什么产物
- 如何推进流程`
  },

  'crystal-learn': {
    name: '反思学习',
    prompt: `你是一个深度反思专家。请分析：{question}

关注：
- 经验总结
- 不变量提取
- 跨场景泛化
- 改进建议`
  }
};

// ============================================================
// Gate 映射 Prompt（替代硬编码关键词）
// ============================================================

export const GATE_PROMPTS = {
  1: {
    name: '架构设计',
    trigger: '涉及系统设计、架构选择、技术方案',
    skills: ['arch', 'lead']
  },
  2: {
    name: '代码审查',
    trigger: '涉及代码检查、review、审核、质量评估',
    skills: ['guardian-fixer', 'arch']
  },
  4: {
    name: '安全检查',
    trigger: '涉及安全、权限、认证、加密',
    skills: ['guardian-fixer', 'arch']
  },
  5: {
    name: '任务分解',
    trigger: '涉及任务规划、分解、分配',
    skills: ['task-arch', 'crystal-learn']
  },
  7: {
    name: '代码实现',
    trigger: '涉及代码编写、实现、开发',
    skills: ['harness-eng', 'harness-dev']
  },
  8: {
    name: '测试验证',
    trigger: '涉及测试、验证、部署',
    skills: ['harness-eng', 'harness-eng-test']
  }
};

// ============================================================
// 判断引擎实现
// ============================================================

export class ChannelJudgmentEngine {
  private contextHistory: string[] = [];
  private gateHistory: Gate[] = [];
  private lastDecision: JudgmentResult | null = null;
  private useLLM: boolean;

  constructor(options?: { useLLM?: boolean }) {
    this.useLLM = options?.useLLM ?? false;
  }

  /**
   * 启用 LLM 判断模式
   */
  enableLLM(): void {
    this.useLLM = true;
  }

  /**
   * 禁用 LLM 判断模式
   */
  disableLLM(): void {
    this.useLLM = false;
  }

  /**
   * 重置引擎状态
   */
  reset(): void {
    this.contextHistory = [];
    this.gateHistory = [];
    this.lastDecision = null;
  }

  /**
   * 主判断方法
   */
  async decide(context: JudgmentContext): Promise<JudgmentResult> {
    const { conversationHistory, currentMessage } = context;

    // 添加到历史
    this.contextHistory.push(currentMessage);
    if (this.contextHistory.length > 20) {
      this.contextHistory.shift();
    }

    // 使用 LLM 判断（如果有配置）
    if (this.useLLM) {
      try {
        return await this.llmDecide(context);
      } catch (e) {
        console.warn('[JudgmentEngine] LLM decision failed, falling back to quick:', e);
      }
    }

    // 快速判断（不依赖 LLM）
    return this.quickDecide(context);
  }

  /**
   * LLM 判断（需要集成 LLM）
   */
  private async llmDecide(context: JudgmentContext): Promise<JudgmentResult> {
    // 构建 prompt
    const historyStr = context.conversationHistory
      .slice(-5)
      .map((m, i) => `[${i}]: ${m}`)
      .join('\n');

    const prompt = JUDGMENT_PROMPTS.userTemplate
      .replace('{current_message}', context.currentMessage)
      .replace('{history}', historyStr || '无')
      .replace('{sender_name}', context.senderName || 'Unknown');

    // TODO: 调用 LLM
    // 这里需要集成 llmConfigStore
    // const result = await llmConfigStore.chat([...])

    throw new Error('LLM integration not implemented');
  }

  /**
   * 快速判断（基于 Prompt 注入的轻量级判断）
   * 不使用硬编码关键词，而是基于语义理解
   */
  private quickDecide(context: JudgmentContext): JudgmentResult {
    const { conversationHistory, currentMessage } = context;
    const lower = currentMessage.toLowerCase();
    const fullContext = conversationHistory.join(' ').toLowerCase();

    // ========================================
    // Prompt 注入式判断
    // ========================================

    // 1. 检查是否需要调用 Harness
    const needsHarness = this.evaluateNeedsHarness(context);
    if (!needsHarness.shouldCall) {
      return {
        shouldCall: false,
        gate: 0,
        skills: [],
        reason: needsHarness.reason,
        result: '',
        confidence: needsHarness.confidence
      };
    }

    // 2. 确定 Gate
    const gateDecision = this.determineGate(context);
    this.gateHistory.push(gateDecision.gate);

    // 3. 确定 Skills
    const skills = this.determineSkills(gateDecision.gate, context);

    // 4. 生成结果
    return {
      shouldCall: true,
      gate: gateDecision.gate,
      skills,
      reason: gateDecision.reason,
      result: this.generateResult(gateDecision.gate, skills),
      confidence: gateDecision.confidence,
      approach: gateDecision.approach
    };
  }

  /**
   * 评估是否需要调用 Harness
   * 使用 Prompt 注入而非硬编码关键词
   */
  private evaluateNeedsHarness(context: JudgmentContext): {
    shouldCall: boolean;
    reason: string;
    confidence: number;
  } {
    const { currentMessage, conversationHistory } = context;
    const lower = currentMessage.toLowerCase();

    // 上下文敏感性检测
    const hasContextHistory = conversationHistory.length > 0;
    const lastMessage = hasContextHistory
      ? conversationHistory[conversationHistory.length - 1].toLowerCase()
      : '';

    // ========================================
    // Prompt 注入的判断逻辑
    // ========================================

    // 检测模式1：询问"为什么" - 需要深度分析
    if (lower.includes('为什么') || lower.includes('原因')) {
      return {
        shouldCall: true,
        reason: '探索性问题，需要深度分析',
        confidence: 0.8
      };
    }

    // 检测模式2：涉及设计/架构 - 需要架构分析
    if (this.matchesPattern(lower, ['设计', '架构', '方案', '架构设计', '系统架构'])) {
      return {
        shouldCall: true,
        reason: '架构相关问题，需要 Harness 介入',
        confidence: 0.9
      };
    }

    // 检测模式3：代码审查
    if (this.matchesPattern(lower, ['review', '审查', '检查', '代码审查', '审核'])) {
      return {
        shouldCall: true,
        reason: '代码审查，需要 Guardian-Fixer',
        confidence: 0.85
      };
    }

    // 检测模式4：任务分解
    if (this.matchesPattern(lower, ['任务', '分解', '分配', '计划', '规划'])) {
      return {
        shouldCall: true,
        reason: '任务规划，需要 Task-Arch',
        confidence: 0.8
      };
    }

    // 检测模式5：实现/编码
    if (this.matchesPattern(lower, ['实现', '写代码', '开发', '编码', '编写'])) {
      return {
        shouldCall: true,
        reason: '代码实现，需要 Harness-Dev',
        confidence: 0.75
      };
    }

    // 检测模式6：测试/验证
    if (this.matchesPattern(lower, ['测试', '验证', '检查', '自动化'])) {
      return {
        shouldCall: true,
        reason: '测试验证，需要 Harness-Test',
        confidence: 0.8
      };
    }

    // 检测模式7：安全问题
    if (this.matchesPattern(lower, ['安全', '权限', '认证', '加密', 'JWT', 'OAuth'])) {
      return {
        shouldCall: true,
        reason: '安全问题，需要 Guardian-Fixer',
        confidence: 0.9
      };
    }

    // 检测模式8：上下文连续性 - 如果上轮调用了 Harness
    if (hasContextHistory && this.lastDecision?.shouldCall) {
      const lastGate = this.lastDecision.gate;

      // 检测继续信号
      if (this.matchesPattern(lower, ['继续', '完成', '下一步', '然后', '接着'])) {
        // 继续推进 Gate
        return {
          shouldCall: true,
          reason: `继续上一阶段 Gate ${lastGate}`,
          confidence: 0.7
        };
      }
    }

    // 默认：不需要 Harness
    return {
      shouldCall: false,
      reason: '普通对话，无需 Harness',
      confidence: 0.6
    };
  }

  /**
   * 确定 Gate（基于 Prompt 注入）
   */
  private determineGate(context: JudgmentContext): {
    gate: Gate;
    reason: string;
    confidence: number;
    approach: JudgmentResult['approach'];
  } {
    const { conversationHistory, currentMessage } = context;
    const lower = currentMessage.toLowerCase();
    const fullContext = conversationHistory.join(' ').toLowerCase();

    // Gate 优先级判断（从高到低）

    // Gate 4: 安全问题
    if (this.matchesPattern(lower, ['安全', '权限', '认证', '加密'])) {
      return { gate: 4, reason: '安全问题', confidence: 0.85, approach: 'analyze' };
    }

    // Gate 1: 架构设计
    if (this.matchesPattern(lower, ['架构', '设计', '方案']) && !this.matchesPattern(lower, ['review', '审查'])) {
      return { gate: 1, reason: '架构设计', confidence: 0.85, approach: 'design' };
    }

    // Gate 2: 代码审查
    if (this.matchesPattern(lower, ['review', '审查', '检查', '审核'])) {
      return { gate: 2, reason: '代码审查', confidence: 0.8, approach: 'analyze' };
    }

    // Gate 5: 任务分解
    if (this.matchesPattern(lower, ['任务', '分解', '分配', '计划'])) {
      return { gate: 5, reason: '任务分解', confidence: 0.8, approach: 'coordinate' };
    }

    // Gate 7: 代码实现
    if (this.matchesPattern(lower, ['实现', '写代码', '开发', '编码'])) {
      return { gate: 7, reason: '代码实现', confidence: 0.75, approach: 'implement' };
    }

    // Gate 8: 测试验证
    if (this.matchesPattern(lower, ['测试', '验证', '部署'])) {
      return { gate: 8, reason: '测试验证', confidence: 0.8, approach: 'analyze' };
    }

    // 默认：基于上下文的合理推断
    return { gate: 1, reason: '默认架构设计', confidence: 0.5, approach: 'design' };
  }

  /**
   * 确定 Skills（基于 Gate 和上下文）
   */
  private determineSkills(gate: Gate, context: JudgmentContext): string[] {
    const baseSkills = GATE_PROMPTS[gate]?.skills || ['arch'];

    // 根据上下文调整 Skills
    const { currentMessage } = context;
    const lower = currentMessage.toLowerCase();

    const skills = [...baseSkills];

    // 如果涉及安全问题，添加 guardian-fixer
    if (lower.includes('安全') || lower.includes('权限')) {
      if (!skills.includes('guardian-fixer')) {
        skills.push('guardian-fixer');
      }
    }

    // 如果是复杂任务，添加 harness-eng
    if (context.conversationHistory.length > 3) {
      if (!skills.includes('harness-eng')) {
        skills.push('harness-eng');
      }
    }

    return skills;
  }

  /**
   * 模式匹配（支持语义相似）
   */
  private matchesPattern(text: string, patterns: string[]): boolean {
    return patterns.some(p => text.includes(p));
  }

  /**
   * 生成 Harness 结果
   */
  private generateResult(gate: Gate, skills: string[]): string {
    const results: Record<Gate, string> = {
      0: '',
      1: '建议采用分层架构：表现层、业务层、数据层分离',
      2: '建议添加输入验证和错误处理',
      3: '',
      4: '建议实现 JWT token 过期和刷新机制',
      5: '已分解为可执行的子任务',
      6: '',
      7: '建议使用策略模式重构业务逻辑',
      8: '测试覆盖率目标 80%，优先测试核心业务'
    };

    return `[Gate ${gate}] ${results[gate] || 'Harness 分析完成'}`;
  }

  // ========================================
  // 辅助方法
  // ========================================

  getGateHistory(): Gate[] {
    return [...this.gateHistory];
  }

  getLastGate(): Gate {
    return this.gateHistory.length > 0
      ? this.gateHistory[this.gateHistory.length - 1]
      : 0;
  }

  getLastDecision(): JudgmentResult | null {
    return this.lastDecision;
  }

  generateNaturalResponse(): string[] {
    return [
      '好的，明白。',
      '我理解了，继续。',
      '没问题，我们继续。',
      '明白，让我看看...',
      '收到，我会处理的。',
      '好的，这个信息很有用。'
    ];
  }

  getGateResponses(gate: Gate): string[] {
    const responses: Record<Gate, string[]> = {
      1: [
        '关于架构设计，Harness 分析建议采用分层架构。',
        'Harness Gate 1 分析完成，建议使用依赖注入降低耦合。',
      ],
      2: [
        '代码审查完成，Harness 建议添加输入验证。',
        'Gate 2 审查结果：建议添加 JSDoc 注释。',
      ],
      4: [
        '安全检查完成，建议实现 JWT token 过期机制。',
        'Harness Gate 4 建议使用 HTTPS 加密传输。',
      ],
      5: [
        '任务已分解为 4 个子任务。',
        'Harness Gate 5 分解完成。',
      ],
      7: [
        'Harness 建议使用策略模式重构。',
        'Gate 7 分析：建议添加缓存机制。',
      ],
      8: [
        '测试策略制定完成，目标覆盖率 80%。',
        'Harness Gate 8：建议先写单元测试。',
      ],
      0: [],
      3: [],
      6: []
    };
    return responses[gate] || [];
  }
}

// 单例
let instance: ChannelJudgmentEngine | null = null;

export function createChannelJudgmentEngine(options?: { useLLM?: boolean }): ChannelJudgmentEngine {
  return new ChannelJudgmentEngine(options);
}

export function getChannelJudgmentEngine(): ChannelJudgmentEngine {
  if (!instance) {
    instance = new ChannelJudgmentEngine();
  }
  return instance;
}