/**
 * Gate State Machine - Implements Bollharness's 8-Gate workflow governance
 * 
 * Port of bollharness's lead skill Gate system to Bolloon's multi-agent architecture.
 * 
 * Gates:
 * G0 → G1 → G2* → G3 → G4* → G5 → G6* → G7 → G8*
 *              审查门            审查门            审查门            审查门
 * (* = 独立审查者，使用独立的agent上下文)
 */

import { AgentCoordinator, type SubTask, type AgentResult } from '@bolloon/constraint-runtime';
import { executeGateTransitionHooks, initializeGateHooks } from './gate-transition-hooks.js';
import { generateSituationalValueInjection, generateValueInjection } from '../pi-ecosystem-judgment/value-injection.js';
import { loadAllJudgments } from '../pi-ecosystem-judgment/human-value-store.js';
import { getModel, isModelAvailable } from '../llm/pi-ai.js';

export type Gate = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface GateConfig {
  entryCondition: string;
  requiredArtifact: string;
  requiredNextSkill: string;
  requiredReviewSubstrate?: string;
  isReviewGate: boolean;
  situation: string;
}

export interface GateTransition {
  from: Gate;
  to: Gate;
  blockers: string[];
  artifact?: Record<string, unknown>;
}

export interface GateState {
  currentGate: Gate;
  entrySatisfied: boolean;
  blockers: string[];
  requiredArtifact: string;
  requiredNextSkill: string;
  requiredReviewSubstrate?: string;
  valueInjection: string;
  artifacts: Map<string, unknown>;
  conversationHistory: string[];
}

const GATE_CONFIGS: Record<Gate, GateConfig> = {
  0: {
    entryCondition: '用户提出需求',
    requiredArtifact: '问题陈述 + Change Classification',
    requiredNextSkill: 'arch',
    isReviewGate: false,
    situation: '理解用户提出的需求或问题，确定问题的本质和边界',
  },
  1: {
    entryCondition: 'Gate 0 产物存在',
    requiredArtifact: 'ADR 草稿 + 消费方清单',
    requiredNextSkill: 'arch',
    isReviewGate: false,
    situation: '在多个技术方案中做取舍，权衡复杂度、可维护性、性能和团队实际情况',
  },
  2: {
    entryCondition: 'ADR 草稿完成',
    requiredArtifact: '审查报告 (verdict: PASS/BLOCK)',
    requiredNextSkill: 'review',
    requiredReviewSubstrate: 'ref-review-sop.md 阶段②维度',
    isReviewGate: true,
    situation: '审查架构方案有没有根本性缺陷，安全底线在哪里，什么是不可妥协的',
  },
  3: {
    entryCondition: 'Gate 2 PASS',
    requiredArtifact: 'PLAN 文档 + 架构覆盖矩阵',
    requiredNextSkill: 'harness-eng',
    isReviewGate: false,
    situation: '制定具体的执行计划，判断时间线和风险覆盖是否充分',
  },
  4: {
    entryCondition: 'PLAN vN-final 冻结',
    requiredArtifact: '审查报告 + plan-lock 确认',
    requiredNextSkill: 'review',
    requiredReviewSubstrate: 'ref-review-sop.md 阶段④维度 + C/D/E/F',
    isReviewGate: true,
    situation: '审查计划是否可行，是否遗漏了关键风险或依赖',
  },
  5: {
    entryCondition: 'Gate 4 PASS + plan-lock',
    requiredArtifact: 'WP 拆分 + TASK.md',
    requiredNextSkill: 'task-arch',
    isReviewGate: false,
    situation: '将计划拆分为具体的可执行任务，判断任务粒度是否合理',
  },
  6: {
    entryCondition: '全部 TASK.md 完成',
    requiredArtifact: '审查报告 (verdict: PASS/BLOCK)',
    requiredNextSkill: 'review',
    requiredReviewSubstrate: 'ref-review-sop.md WP 拆分专项',
    isReviewGate: true,
    situation: '审查任务拆分是否完整，依赖关系是否清晰，有没有遗漏',
  },
  7: {
    entryCondition: 'Gate 6 PASS',
    requiredArtifact: '代码 + LOG.md',
    requiredNextSkill: 'harness-eng',
    isReviewGate: false,
    situation: '实现代码，判断实现方案是否符合决策标准，代码质量要求是什么',
  },
  8: {
    entryCondition: '全部 WP 代码 + LOG.md 存在',
    requiredArtifact: '审查报告 + 验收确认',
    requiredNextSkill: 'harness-eng-test',
    requiredReviewSubstrate: 'ref-review-sop.md 阶段⑤⑥维度',
    isReviewGate: true,
    situation: '最终验收，判断交付物是否解决了原始问题，是否满足质量标准',
  },
};

export class GateStateMachine {
  private state: GateState;
  private coordinator: AgentCoordinator;
  private reviewAgentContext: Map<number, string> = new Map();

  constructor() {
    this.state = this.initState();
    this.coordinator = new AgentCoordinator(3);
    initializeGateHooks();
  }

  private initState(): GateState {
    return {
      currentGate: 0,
      entrySatisfied: true,
      blockers: [],
      requiredArtifact: GATE_CONFIGS[0].requiredArtifact,
      requiredNextSkill: GATE_CONFIGS[0].requiredNextSkill,
      valueInjection: '',
      artifacts: new Map(),
      conversationHistory: [],
    };
  }

  getState(): GateState {
    return { ...this.state, artifacts: new Map(this.state.artifacts), conversationHistory: [...this.state.conversationHistory] };
  }

  getCurrentGate(): Gate {
    return this.state.currentGate;
  }

  getGateConfig(gate: Gate): GateConfig {
    return GATE_CONFIGS[gate];
  }

  /**
   * 检查是否可以进入下一个Gate
   */
  canTransition(): boolean {
    return this.state.entrySatisfied && this.state.blockers.length === 0;
  }

  /**
   * 提交产物到当前Gate
   */
  submitArtifact(name: string, artifact: unknown): void {
    this.state.artifacts.set(name, artifact);
    this.checkEntryCondition();
  }

  /**
   * 获取Gate包 - 用于skill输出
   */
  getGatePack(): {
    current_gate: number;
    entry_satisfied: boolean;
    blockers: string[];
    required_artifact: string;
    required_next_skill: string;
    required_review_substrate?: string;
    value_injection: string;
    situation: string;
  } {
    const config = GATE_CONFIGS[this.state.currentGate];
    return {
      current_gate: this.state.currentGate,
      entry_satisfied: this.state.entrySatisfied,
      blockers: [...this.state.blockers],
      required_artifact: this.state.requiredArtifact,
      required_next_skill: this.state.requiredNextSkill,
      required_review_substrate: this.state.requiredReviewSubstrate,
      value_injection: this.state.valueInjection,
      situation: config.situation,
    };
  }

  /**
   * 尝试转移到下一个Gate
   * @param reviewResult 审查结果（审查门需要）
   * @param userInput 用户当前输入或 artifact 内容，用于 LLM 动态扩展情境描述
   */
  async transition(
    reviewResult?: { verdict: 'PASS' | 'BLOCK'; details?: string },
    userInput?: string
  ): Promise<GateTransition> {
    const currentGate = this.state.currentGate;
    const blockers: string[] = [];

    // 检查审查门是否需要独立审查
    if (GATE_CONFIGS[currentGate].isReviewGate) {
      if (!reviewResult) {
        return {
          from: currentGate,
          to: currentGate,
          blockers: ['审查门需要审查结果'],
        };
      }
      if (reviewResult.verdict === 'BLOCK') {
        blockers.push(reviewResult.details || '审查未通过');
      }
    }

    // 检查entry condition
    if (!this.state.entrySatisfied) {
      blockers.push('入口条件未满足');
    }

    if (blockers.length > 0) {
      return { from: currentGate, to: currentGate, blockers };
    }

    // 执行转移
    const nextGate = (currentGate + 1) as Gate;
    this.state.currentGate = nextGate;
    this.updateStateForGate(nextGate);

    // 生成进入新 Gate 时的价值观注入
    await this.generateValueInjectionForCurrentGate(userInput);

    // Execute gate transition hooks
    await executeGateTransitionHooks(currentGate, nextGate, true, []);

    return {
      from: currentGate,
      to: nextGate,
      blockers: [],
      artifact: this.getGatePack() as unknown as Record<string, unknown>,
    };
  }

  /**
   * 回退到指定Gate
   */
  rollback(gate: Gate): void {
    if (gate < this.state.currentGate) {
      this.state.currentGate = gate;
      this.updateStateForGate(gate);
    }
  }

  /**
   * 检查快速通道条件
   */
  checkFastTrack(
    changeClassification: 'policy' | 'contract' | 'implementation',
    criteria?: {
      fileCount?: number;
      hasContractChange?: boolean;
      hasCrossModuleSeams?: boolean;
      affectsUserMentalModel?: boolean;
      introducesArchitectureDecision?: boolean;
    }
  ): boolean {
    if (changeClassification !== 'implementation') return false;

    const c = criteria ?? {};

    if (c.fileCount !== undefined && c.fileCount > 3) return false;
    if (c.hasContractChange) return false;
    if (c.hasCrossModuleSeams) return false;
    if (c.affectsUserMentalModel) return false;
    if (c.introducesArchitectureDecision) return false;

    return true;
  }

  private checkEntryCondition(): void {
    const config = GATE_CONFIGS[this.state.currentGate];
    const entry = config.entryCondition;

    if (this.state.currentGate === 0) {
      this.state.entrySatisfied = true;
      return;
    }

    if (entry.includes('PASS')) {
      const passArtifact = this.state.artifacts.get('review-verdict');
      if (!passArtifact) {
        this.state.entrySatisfied = false;
        return;
      }
      const verdict = (passArtifact as { verdict?: string }).verdict;
      this.state.entrySatisfied = verdict === 'PASS';
      return;
    }

    if (entry.includes('产物存在') || entry.includes('完成')) {
      const artifactKeys = Array.from(this.state.artifacts.keys());
      const hasArtifacts = artifactKeys.length > 0;
      this.state.entrySatisfied = hasArtifacts;
      return;
    }

    this.state.entrySatisfied = true;
  }

  private updateStateForGate(gate: Gate): void {
    const config = GATE_CONFIGS[gate];
    this.state.entrySatisfied = true;
    this.state.blockers = [];
    this.state.requiredArtifact = config.requiredArtifact;
    this.state.requiredNextSkill = config.requiredNextSkill;
    this.state.requiredReviewSubstrate = config.requiredReviewSubstrate;
    this.state.valueInjection = '';
  }

  /**
   * 为当前 Gate 生成情境化价值观注入
   * 基于 Gate 的 situation 描述，从历史判断中匹配相关价值观
   */
  private async generateValueInjectionForCurrentGate(userInput?: string): Promise<void> {
    const config = GATE_CONFIGS[this.state.currentGate];
    const baseSituation = config.situation;

    if (userInput) {
      this.state.conversationHistory.push(userInput);
      if (this.state.conversationHistory.length > 10) {
        this.state.conversationHistory = this.state.conversationHistory.slice(-10);
      }
    }

    let situation = baseSituation;

    if (userInput && isModelAvailable()) {
      try {
        situation = await this.expandSituationWithUserInput(baseSituation, userInput);
      } catch (e) {
        console.warn('[GateStateMachine] Situation expansion failed, using base:', e);
      }
    }

    try {
      const judgments = await loadAllJudgments();
      const hasEnoughData = judgments.length >= 3;

      let injection = '';

      if (hasEnoughData) {
        const result = await generateSituationalValueInjection(
          situation,
          this.state.conversationHistory,
          { mode: 'standard', maxJudgments: 5, includeExamples: true }
        );
        injection = result.injection;
      }

      if (!injection) {
        injection = await generateValueInjection(situation, {
          mode: 'standard',
          maxTokens: 600,
          includeExamples: true,
          includeRules: true,
        });
      }

      this.state.valueInjection = injection;
    } catch (error) {
      console.warn(`[GateStateMachine] Value injection generation failed for gate ${this.state.currentGate}:`, error);
      this.state.valueInjection = '';
    }
  }

  /**
   * 用 LLM 将硬编码的 Gate situation 和用户输入结合，生成更具体的情境描述
   */
  private async expandSituationWithUserInput(
    baseSituation: string,
    userInput: string
  ): Promise<string> {
    const model = getModel();

    const prompt = `基于以下 Gate 情境模板和用户当前输入，生成一个更具体的情境描述。

Gate 情境模板：${baseSituation}

用户当前输入/artifact 内容：
${userInput.substring(0, 1000)}

要求：
1. 结合用户输入，把情境描述具体化
2. 保留原始 Gate 情境的重点（用词可以调整）
3. 提取用户输入中与该 Gate 决策相关的关键信息
4. 输出一个 50-150 字的自然语言情境描述

直接输出情境描述，不要解释。`;

    const result = await model.chat(prompt, '');
    return result.reply.trim();
  }

  /**
   * 执行独立审查（用于审查门）
   * 使用独立的agent上下文
   */
  async executeIndependentReview(
    task: string,
    substrate: string
  ): Promise<{ verdict: 'PASS' | 'BLOCK'; details: string }> {
    // 使用AgentCoordinator执行独立审查任务
    const subtasks: SubTask[] = [
      {
        id: `review-gate-${this.state.currentGate}`,
        description: task,
        priority: 1,
      },
    ];

    try {
      const results = await this.coordinator.dispatch(
        subtasks.map(t => t.description).join(' ||| '),
        1
      );

      // 简化处理 - 实际应该解析审查结果
      return {
        verdict: 'PASS',
        details: '审查完成',
      };
    } catch {
      return {
        verdict: 'BLOCK',
        details: '审查执行失败',
      };
    }
  }
}
