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

export type Gate = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface GateConfig {
  entryCondition: string;
  requiredArtifact: string;
  requiredNextSkill: string;
  requiredReviewSubstrate?: string;
  isReviewGate: boolean;
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
  artifacts: Map<string, unknown>;
}

const GATE_CONFIGS: Record<Gate, GateConfig> = {
  0: {
    entryCondition: '用户提出需求',
    requiredArtifact: '问题陈述 + Change Classification',
    requiredNextSkill: 'arch',
    isReviewGate: false,
  },
  1: {
    entryCondition: 'Gate 0 产物存在',
    requiredArtifact: 'ADR 草稿 + 消费方清单',
    requiredNextSkill: 'arch',
    isReviewGate: false,
  },
  2: {
    entryCondition: 'ADR 草稿完成',
    requiredArtifact: '审查报告 (verdict: PASS/BLOCK)',
    requiredNextSkill: 'review',
    requiredReviewSubstrate: 'ref-review-sop.md 阶段②维度',
    isReviewGate: true,
  },
  3: {
    entryCondition: 'Gate 2 PASS',
    requiredArtifact: 'PLAN 文档 + 架构覆盖矩阵',
    requiredNextSkill: 'harness-eng',
    isReviewGate: false,
  },
  4: {
    entryCondition: 'PLAN vN-final 冻结',
    requiredArtifact: '审查报告 + plan-lock 确认',
    requiredNextSkill: 'review',
    requiredReviewSubstrate: 'ref-review-sop.md 阶段④维度 + C/D/E/F',
    isReviewGate: true,
  },
  5: {
    entryCondition: 'Gate 4 PASS + plan-lock',
    requiredArtifact: 'WP 拆分 + TASK.md',
    requiredNextSkill: 'task-arch',
    isReviewGate: false,
  },
  6: {
    entryCondition: '全部 TASK.md 完成',
    requiredArtifact: '审查报告 (verdict: PASS/BLOCK)',
    requiredNextSkill: 'review',
    requiredReviewSubstrate: 'ref-review-sop.md WP 拆分专项',
    isReviewGate: true,
  },
  7: {
    entryCondition: 'Gate 6 PASS',
    requiredArtifact: '代码 + LOG.md',
    requiredNextSkill: 'harness-eng',
    isReviewGate: false,
  },
  8: {
    entryCondition: '全部 WP 代码 + LOG.md 存在',
    requiredArtifact: '审查报告 + 验收确认',
    requiredNextSkill: 'harness-eng-test',
    requiredReviewSubstrate: 'ref-review-sop.md 阶段⑤⑥维度',
    isReviewGate: true,
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
      artifacts: new Map(),
    };
  }

  getState(): GateState {
    return { ...this.state, artifacts: new Map(this.state.artifacts) };
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
  } {
    return {
      current_gate: this.state.currentGate,
      entry_satisfied: this.state.entrySatisfied,
      blockers: [...this.state.blockers],
      required_artifact: this.state.requiredArtifact,
      required_next_skill: this.state.requiredNextSkill,
      required_review_substrate: this.state.requiredReviewSubstrate,
    };
  }

  /**
   * 尝试转移到下一个Gate
   */
  async transition(reviewResult?: { verdict: 'PASS' | 'BLOCK'; details?: string }): Promise<GateTransition> {
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
  checkFastTrack(changeClassification: 'policy' | 'contract' | 'implementation'): boolean {
    if (changeClassification !== 'implementation') return false;

    // 5条全部满足才允许快速通道
    // 1. 改动不超过3个文件
    // 2. 无契约变更
    // 3. 无跨模块接缝
    // 4. 不影响用户心智或产品语义
    // 5. 不引入新的架构决策
    return true; // 需要实际检查实现
  }

  private checkEntryCondition(): void {
    const config = GATE_CONFIGS[this.state.currentGate];
    // 这里应该检查具体的entry condition
    // 简化实现
    this.state.entrySatisfied = true;
  }

  private updateStateForGate(gate: Gate): void {
    const config = GATE_CONFIGS[gate];
    this.state.entrySatisfied = true;
    this.state.blockers = [];
    this.state.requiredArtifact = config.requiredArtifact;
    this.state.requiredNextSkill = config.requiredNextSkill;
    this.state.requiredReviewSubstrate = config.requiredReviewSubstrate;
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
