/**
 * Channel Judgment Engine
 *
 * Provides judgment capability for Channel agents to decide when to call Harness
 * based on keywords and conversation context.
 *
 * Keywords → Gate mapping:
 * - 架构/设计/方案 → Gate 1
 * - review/代码/检查/审核 → Gate 2
 * - 安全/权限/认证 → Gate 4
 * - 任务/分解/计划 → Gate 5
 * - 实现/写代码/开发 → Gate 7
 * - 测试/验证/部署 → Gate 8
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
}

interface GateKeywordConfig {
  gate: Gate;
  skills: string[];
  keywords: string[];
  resultTemplate: string;
}

const GATE_KEYWORD_CONFIGS: GateKeywordConfig[] = [
  {
    gate: 1,
    skills: ['arch', 'lead'],
    keywords: ['架构', '设计', '方案', '结构'],
    resultTemplate: '建议采用分层架构：表现层、业务层、数据层分离'
  },
  {
    gate: 2,
    skills: ['arch', 'guardian-fixer'],
    keywords: ['review', '检查', '审核', '代码', '审查'],
    resultTemplate: '建议添加输入验证和错误处理'
  },
  {
    gate: 4,
    skills: ['arch', 'guardian-fixer'],
    keywords: ['安全', '权限', '认证', '加密', 'JWT'],
    resultTemplate: '建议实现 JWT token 过期和刷新机制'
  },
  {
    gate: 5,
    skills: ['task-arch', 'crystal-learn'],
    keywords: ['任务', '分解', '计划', '分配', '安排'],
    resultTemplate: '已分解为可执行的子任务'
  },
  {
    gate: 7,
    skills: ['harness-eng', 'crystal-learn'],
    keywords: ['实现', '写代码', '开发', '编码', '优化', '重构'],
    resultTemplate: '建议使用策略模式重构业务逻辑'
  },
  {
    gate: 8,
    skills: ['harness-eng', 'harness-eng-test'],
    keywords: ['测试', '验证', '部署', '上线', '检查'],
    resultTemplate: '测试覆盖率目标 80%，优先测试核心业务'
  },
];

export class ChannelJudgmentEngine {
  private contextHistory: string[] = [];
  private gateHistory: Gate[] = [];
  private lastDecision: JudgmentResult | null = null;

  constructor() {}

  /**
   * Reset engine state
   */
  reset(): void {
    this.contextHistory = [];
    this.gateHistory = [];
    this.lastDecision = null;
  }

  /**
   * Decide whether to call Harness based on context
   */
  decide(context: JudgmentContext): JudgmentResult {
    const { conversationHistory, currentMessage } = context;
    const lowerMessage = currentMessage.toLowerCase();

    // Add to history
    this.contextHistory.push(currentMessage);
    if (this.contextHistory.length > 20) {
      this.contextHistory.shift();
    }

    // 1. Stage-based contextual judgment
    const stageResult = this.checkStageContext(conversationHistory, currentMessage);
    if (stageResult) {
      this.gateHistory.push(stageResult.gate);
      this.lastDecision = stageResult;
      return stageResult;
    }

    // 2. Keyword-based direct judgment
    const keywordResult = this.checkKeywords(lowerMessage, currentMessage);
    if (keywordResult) {
      this.gateHistory.push(keywordResult.gate);
      this.lastDecision = keywordResult;
      return keywordResult;
    }

    // 3. Check for continuation signals
    const continueResult = this.checkContinuation(lowerMessage);
    if (continueResult && this.lastDecision) {
      // Continue from last gate
      const nextGate = Math.min(this.lastDecision.gate + 1, 8) as Gate;
      return {
        shouldCall: true,
        gate: nextGate,
        skills: this.lastDecision.skills,
        reason: '继续上一阶段任务',
        result: `[Gate ${nextGate}] 继续执行...`
      };
    }

    // No harness call needed
    return {
      shouldCall: false,
      gate: 0,
      skills: [],
      reason: '普通对话无需 Harness',
      result: ''
    };
  }

  /**
   * Check if conversation context suggests a specific gate
   */
  private checkStageContext(history: string[], currentMessage: string): JudgmentResult | null {
    const fullContext = history.join(' ').toLowerCase();
    const current = currentMessage.toLowerCase();

    // Stage 1: Architecture discussion
    if (fullContext.includes('架构') || fullContext.includes('设计')) {
      if (/检查|审核|review|分析/.test(current)) {
        return {
          shouldCall: true,
          gate: 2,
          skills: ['arch', 'guardian-fixer'],
          reason: '架构讨论阶段触发代码审查',
          result: '[Gate 2 - 代码审查] 建议检查接口设计是否符合单一职责原则'
        };
      }
    }

    // Stage 2: Task planning
    if (fullContext.includes('任务') || fullContext.includes('计划')) {
      if (/分配|开始|执行/.test(current)) {
        return {
          shouldCall: true,
          gate: 5,
          skills: ['task-arch', 'crystal-learn'],
          reason: '任务规划阶段触发任务分解',
          result: '[Gate 5 - 任务分解] 已分解为可执行的子任务'
        };
      }
    }

    // Stage 3: Implementation
    if (fullContext.includes('实现') || fullContext.includes('代码')) {
      if (/优化|改进|重构/.test(current)) {
        return {
          shouldCall: true,
          gate: 7,
          skills: ['harness-eng', 'crystal-learn'],
          reason: '实现阶段触发代码优化',
          result: '[Gate 7 - 代码实现] 建议使用策略模式重构'
        };
      }
    }

    return null;
  }

  /**
   * Check for keyword matches
   */
  private checkKeywords(message: string, original: string): JudgmentResult | null {
    for (const config of GATE_KEYWORD_CONFIGS) {
      if (config.keywords.some(k => message.includes(k))) {
        return {
          shouldCall: true,
          gate: config.gate,
          skills: config.skills,
          reason: `关键词触发 Gate ${config.gate}`,
          result: this.formatGateResult(config.gate, config.resultTemplate)
        };
      }
    }
    return null;
  }

  /**
   * Check for continuation signals
   */
  private checkContinuation(message: string): boolean {
    const continueSignals = ['继续', '完成', '结束', 'next', 'continue', 'proceed'];
    return continueSignals.some(s => message.includes(s));
  }

  /**
   * Format gate result with prefix
   */
  private formatGateResult(gate: Gate, template: string): string {
    const gateNames: Record<Gate, string> = {
      0: '',
      1: '架构设计',
      2: '代码审查',
      3: '计划冻结',
      4: '安全检查',
      5: '任务分解',
      6: '任务审查',
      7: '代码实现',
      8: '测试验证'
    };
    return `[Gate ${gate} - ${gateNames[gate]}] ${template}`;
  }

  /**
   * Get current gate history
   */
  getGateHistory(): Gate[] {
    return [...this.gateHistory];
  }

  /**
   * Get last gate
   */
  getLastGate(): Gate {
    return this.gateHistory.length > 0 ? this.gateHistory[this.gateHistory.length - 1] : 0;
  }

  /**
   * Get last decision
   */
  getLastDecision(): JudgmentResult | null {
    return this.lastDecision;
  }

  /**
   * Generate natural response for non-harness messages
   */
  generateNaturalResponse(): string[] {
    return [
      '好的，明白。',
      '我理解了，继续。',
      '没问题，我们继续。',
      '明白，让我看看...',
      '收到，我会处理的。',
      '好的，这个信息很有用。',
      '明白了，还有其他需要讨论的吗？',
      '有道理，我们继续。',
      '好的，听起来不错。'
    ];
  }

  /**
   * Get responses for specific gate
   */
  getGateResponses(gate: Gate): string[] {
    const responses: Record<Gate, string[]> = {
      1: [
        '关于架构设计，Harness 分析建议采用分层架构，将表现层、业务逻辑和数据访问层分离。这样可以提高代码的可维护性和可测试性。',
        'Harness Gate 1 分析完成。建议使用依赖注入来降低模块间的耦合，这样更利于单元测试。',
        '架构设计已完成。建议采用微服务架构，便于独立扩展和部署。'
      ],
      2: [
        '代码审查完成，Harness 建议添加输入验证和错误边界处理。特别是 API 接口，需要统一错误响应格式。',
        'Gate 2 审查结果：建议为每个函数添加 JSDoc 注释，并使用 ESLint 统一代码风格。',
        '代码检查发现几个命名规范问题，建议统一使用驼峰命名法。'
      ],
      4: [
        '安全检查完成。建议实现 JWT token 的过期机制和刷新策略，同时添加 IP 白名单功能。',
        'Harness Gate 4 建议：使用 HTTPS 加密传输，对敏感操作添加二次验证。',
        '安全评估通过。建议增加防 SQL 注入和 XSS 攻击的措施。'
      ],
      5: [
        '任务已分解为 4 个子任务：\n1. 用户登录模块 (优先级：高)\n2. 用户注册模块 (优先级：高)\n3. 权限管理 (优先级：中)\n4. 集成测试 (优先级：中)\n建议按顺序执行。',
        'Harness Gate 5 分解完成。每个子任务都有明确的完成标准和验收条件。',
        '任务分解完成。建议按依赖关系排序：登录 → 注册 → 权限 → 测试。'
      ],
      7: [
        '代码实现中，Harness 建议使用策略模式重构条件判断逻辑，这样更容易扩展新的验证规则。',
        'Gate 7 分析：建议在服务层添加缓存机制，提高响应速度。',
        '实现完成。建议添加单元测试覆盖新功能。'
      ],
      8: [
        '测试策略制定完成。目标覆盖率 80%，优先测试核心业务逻辑和边界情况。',
        'Harness Gate 8：建议先写单元测试，再写集成测试，最后进行 E2E 测试。',
        '测试通过。建议进行性能测试以确保高并发场景下的稳定性。'
      ],
      0: [],
      3: [],
      6: []
    };
    return responses[gate] || [];
  }
}

// Singleton instance for reuse
let instance: ChannelJudgmentEngine | null = null;

export function createChannelJudgmentEngine(): ChannelJudgmentEngine {
  return new ChannelJudgmentEngine();
}

export function getChannelJudgmentEngine(): ChannelJudgmentEngine {
  if (!instance) {
    instance = new ChannelJudgmentEngine();
  }
  return instance;
}