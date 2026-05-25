/**
 * Harness Workflow Integrator
 *
 * 将 Channel Agent 与 Bollharness 配置系统集成：
 * 1. 加载 YAML 工作流配置
 * 2. 实现 Gate 状态机
 * 3. Skill 路由调度
 * 4. 多智能体协作协调
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface GateConfig {
  name: string;
  entry_condition: string;
  required_artifact: string;
  required_skills: string[];
  next_gate: number | null;
  is_review_gate?: boolean;
  reviewer_type?: string;
}

export interface AgentRole {
  name: string;
  description: string;
  capabilities: string[];
  default_skills: string[];
  triggers: string[];
}

export interface WorkflowConfig {
  version: string;
  workflows: {
    default: {
      name: string;
      description: string;
      initial_gate: number;
      gates: Record<number, GateConfig>;
    };
  };
  agent_roles: Record<string, AgentRole>;
  skill_routing: {
    keyword_to_skill: Record<string, string[]>;
    gate_to_skills: Record<number, string[]>;
  };
  fast_track: {
    enabled: boolean;
    conditions: string[];
    required_steps: string[];
  };
  parallel_execution: {
    enabled: boolean;
    contract: {
      required_fields: string[];
      seam_validation: {
        enabled: boolean;
        blocking: boolean;
        message: string;
      };
    };
  };
  collaboration_protocol: {
    message_format: {
      type: string;
      fields: string[];
    };
    state_sync: {
      enabled: boolean;
      interval_ms: number;
      sync_on_gate_change: boolean;
    };
    conflict_resolution: {
      strategy: string;
      escalation_gates: number[];
    };
  };
}

export interface GateState {
  current_gate: number;
  entry_satisfied: boolean;
  blockers: string[];
  artifacts: Record<string, unknown>;
}

export interface SkillResult {
  skill: string;
  success: boolean;
  output: string;
  gate: number;
}

/**
 * Harness Workflow Integrator 类
 */
export class HarnessWorkflowIntegrator {
  private config: WorkflowConfig | null = null;
  private currentGate: number = 0;
  private artifacts: Map<string, unknown> = new Map();
  private gateHistory: number[] = [];
  private initialized: boolean = false;

  constructor() {}

  /**
   * 初始化，加载配置
   */
  async initialize(configPath?: string): Promise<void> {
    if (this.initialized) return;

    const defaultPath = path.join(
      process.env.HOME || '/tmp',
      '.bolloon',
      'channels',
      'agent-workflow-config.yaml'
    );

    const filePath = configPath || defaultPath;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.config = JSON.parse(content) as WorkflowConfig;
      this.initialized = true;
      console.log(`[HarnessIntegrator] Loaded workflow config from ${filePath}`);
    } catch (e) {
      // 使用内置默认配置
      this.config = this.getDefaultConfig();
      this.initialized = true;
      console.log('[HarnessIntegrator] Using default workflow config');
    }
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): WorkflowConfig {
    return {
      version: '1.0',
      workflows: {
        default: {
          name: '默认协作工作流',
          description: '基于 Harness Gate 的多智能体协作工作流',
          initial_gate: 0,
          gates: {
            0: {
              name: '问题锁定',
              entry_condition: '用户提出需求',
              required_artifact: '问题陈述 + Change Classification',
              required_skills: ['arch'],
              next_gate: 1
            },
            1: {
              name: '架构设计',
              entry_condition: 'Gate 0 产物存在',
              required_artifact: 'ADR草稿 + 消费方清单',
              required_skills: ['arch', 'lead'],
              next_gate: 2
            },
            2: {
              name: '架构审查',
              entry_condition: 'ADR草稿完成',
              required_artifact: '审查报告 (PASS/BLOCK)',
              required_skills: ['arch', 'guardian-fixer'],
              is_review_gate: true,
              reviewer_type: 'independent',
              next_gate: 3
            },
            3: {
              name: '计划制定',
              entry_condition: 'Gate 2 PASS',
              required_artifact: 'PLAN文档 + 架构覆盖矩阵',
              required_skills: ['harness-eng', 'plan-lock'],
              next_gate: 4
            },
            4: {
              name: '计划审查',
              entry_condition: 'PLAN vN-final 冻结',
              required_artifact: '审查报告 + plan-lock确认',
              required_skills: ['arch', 'guardian-fixer'],
              is_review_gate: true,
              reviewer_type: 'independent',
              next_gate: 5
            },
            5: {
              name: '任务分解',
              entry_condition: 'Gate 4 PASS + plan-lock',
              required_artifact: 'WP拆分 + TASK.md',
              required_skills: ['task-arch', 'crystal-learn'],
              next_gate: 6
            },
            6: {
              name: '任务审查',
              entry_condition: '全部TASK.md完成',
              required_artifact: '审查报告 (PASS/BLOCK)',
              required_skills: ['task-arch', 'guardian-fixer'],
              is_review_gate: true,
              reviewer_type: 'independent',
              next_gate: 7
            },
            7: {
              name: '代码实现',
              entry_condition: 'Gate 6 PASS',
              required_artifact: '代码 + LOG.md',
              required_skills: ['harness-eng', 'harness-dev'],
              next_gate: 8
            },
            8: {
              name: '测试验证',
              entry_condition: '全部WP代码 + LOG.md存在',
              required_artifact: '审查报告 + 验收确认',
              required_skills: ['harness-eng', 'harness-eng-test'],
              is_review_gate: true,
              reviewer_type: 'independent',
              next_gate: null
            }
          }
        }
      },
      agent_roles: {
        architect: {
          name: '架构师',
          description: '负责架构决策、方案比较',
          capabilities: ['架构设计', '方案比较', '边界冻结'],
          default_skills: ['arch', 'lead'],
          triggers: ['架构设计', '方案比较']
        },
        developer: {
          name: '开发工程师',
          description: '负责代码实现和优化',
          capabilities: ['代码编写', '调试', '重构'],
          default_skills: ['harness-dev', 'harness-eng'],
          triggers: ['实现', '写代码', '开发']
        },
        reviewer: {
          name: '代码审查员',
          description: '独立审查代码质量和架构',
          capabilities: ['代码审查', '质量评估', '问题发现'],
          default_skills: ['guardian-fixer', 'arch'],
          triggers: ['代码审查', 'review', '审核']
        }
      },
      skill_routing: {
        keyword_to_skill: {
          '架构': ['arch', 'lead'],
          '设计': ['arch'],
          'review': ['guardian-fixer', 'arch'],
          '代码': ['guardian-fixer', 'harness-dev'],
          '安全': ['guardian-fixer', 'arch'],
          '任务': ['task-arch', 'harness-eng'],
          '分解': ['task-arch'],
          '实现': ['harness-dev', 'harness-eng'],
          '测试': ['harness-eng-test', 'guardian-fixer'],
          '验证': ['harness-eng-test']
        },
        gate_to_skills: {
          0: ['arch', 'lead'],
          1: ['arch', 'lead'],
          2: ['guardian-fixer', 'arch'],
          3: ['harness-eng', 'plan-lock'],
          4: ['guardian-fixer', 'arch'],
          5: ['task-arch', 'crystal-learn'],
          6: ['task-arch', 'guardian-fixer'],
          7: ['harness-eng', 'harness-dev'],
          8: ['harness-eng', 'harness-eng-test']
        }
      },
      fast_track: {
        enabled: true,
        conditions: [
          '改动不超过 3 个文件',
          'Change Classification = implementation',
          '无跨模块接缝',
          '不影响用户心智或产品语义',
          '不引入新的架构决策'
        ],
        required_steps: ['执行 skill', '单人审查']
      },
      parallel_execution: {
        enabled: true,
        contract: {
          required_fields: ['write_set', 'parallel_tracks', 'depends_on', 'integration_owner', 'seam_owner', 'golden_journeys'],
          seam_validation: {
            enabled: true,
            blocking: true,
            message: '任何跨 WP 共享接口必须有 seam_owner'
          }
        }
      },
      collaboration_protocol: {
        message_format: {
          type: 'structured',
          fields: ['type', 'from', 'to', 'content', 'gate', 'skill', 'timestamp', 'artifact']
        },
        state_sync: {
          enabled: true,
          interval_ms: 5000,
          sync_on_gate_change: true
        },
        conflict_resolution: {
          strategy: 'gate_based',
          escalation_gates: [2, 4, 6, 8]
        }
      }
    };
  }

  /**
   * 获取当前 Gate 配置
   */
  getGateConfig(gate: number): GateConfig | null {
    if (!this.config) return null;
    return this.config.workflows.default.gates[gate] || null;
  }

  /**
   * 获取当前 Gate
   */
  getCurrentGate(): number {
    return this.currentGate;
  }

  /**
   * 获取 Gate Pack (用于 Skill 输出)
   */
  getGatePack(): {
    current_gate: number;
    entry_satisfied: boolean;
    blockers: string[];
    required_artifact: string;
    required_skills: string[];
    required_review_substrate?: string;
  } {
    const gateConfig = this.getGateConfig(this.currentGate);
    return {
      current_gate: this.currentGate,
      entry_satisfied: this.checkEntryCondition(),
      blockers: this.getBlockers(),
      required_artifact: gateConfig?.required_artifact || '',
      required_skills: gateConfig?.required_skills || [],
      required_review_substrate: gateConfig?.is_review_gate ? '独立审查' : undefined
    };
  }

  /**
   * 检查入口条件是否满足
   */
  checkEntryCondition(): boolean {
    if (this.currentGate === 0) return true;
    return this.artifacts.size > 0;
  }

  /**
   * 获取阻塞条件
   */
  getBlockers(): string[] {
    const blockers: string[] = [];
    const gateConfig = this.getGateConfig(this.currentGate);

    if (!gateConfig) return blockers;

    if (!this.checkEntryCondition()) {
      blockers.push(`Gate ${this.currentGate} 入口条件未满足: ${gateConfig.entry_condition}`);
    }

    return blockers;
  }

  /**
   * 提交产物到当前 Gate
   */
  submitArtifact(name: string, artifact: unknown): void {
    this.artifacts.set(name, artifact);
  }

  /**
   * 获取产物
   */
  getArtifact(name: string): unknown {
    return this.artifacts.get(name);
  }

  /**
   * 尝试转移 Gate
   */
  async transitionGate(reviewResult?: { verdict: 'PASS' | 'BLOCK'; details?: string }): Promise<{
    success: boolean;
    from: number;
    to: number | null;
    blockers: string[];
    message: string;
  }> {
    const gateConfig = this.getGateConfig(this.currentGate);

    if (!gateConfig) {
      return {
        success: false,
        from: this.currentGate,
        to: null,
        blockers: ['无效的 Gate 配置'],
        message: 'Gate 转移失败'
      };
    }

    const blockers: string[] = [];

    // 审查门需要审查结果
    if (gateConfig.is_review_gate) {
      if (!reviewResult) {
        return {
          success: false,
          from: this.currentGate,
          to: null,
          blockers: ['审查门需要审查结果'],
          message: `Gate ${this.currentGate} 是审查门，需要独立审查`
        };
      }

      if (reviewResult.verdict === 'BLOCK') {
        blockers.push(reviewResult.details || '审查未通过');
      }
    }

    // 检查入口条件
    if (!this.checkEntryCondition()) {
      blockers.push(`入口条件未满足: ${gateConfig.entry_condition}`);
    }

    if (blockers.length > 0) {
      return {
        success: false,
        from: this.currentGate,
        to: this.currentGate,
        blockers,
        message: `Gate ${this.currentGate} BLOCKED`
      };
    }

    // 执行转移
    const nextGate = gateConfig.next_gate;
    this.gateHistory.push(this.currentGate);
    this.currentGate = nextGate ?? this.currentGate;

    return {
      success: true,
      from: this.gateHistory[this.gateHistory.length - 1],
      to: this.currentGate,
      blockers: [],
      message: nextGate === null ? '工作流完成' : `Gate ${this.gateHistory[this.gateHistory.length - 1]} → Gate ${this.currentGate}`
    };
  }

  /**
   * 基于关键词路由 Skill
   */
  routeSkillsByKeyword(message: string): string[] {
    if (!this.config) return [];

    const lowerMessage = message.toLowerCase();
    const skills: Set<string> = new Set();

    for (const [keyword, skillList] of Object.entries(this.config.skill_routing.keyword_to_skill)) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        skillList.forEach(s => skills.add(s));
      }
    }

    // 如果没有匹配，返回当前 Gate 的默认 skills
    if (skills.size === 0) {
      const gateSkills = this.config.skill_routing.gate_to_skills[this.currentGate];
      return gateSkills || [];
    }

    return Array.from(skills);
  }

  /**
   * 基于当前 Gate 获取 Skills
   */
  getSkillsForCurrentGate(): string[] {
    if (!this.config) return [];
    return this.config.skill_routing.gate_to_skills[this.currentGate] || [];
  }

  /**
   * 获取智能体角色
   */
  getAgentRole(roleId: string): AgentRole | null {
    if (!this.config) return null;
    return this.config.agent_roles[roleId] || null;
  }

  /**
   * 根据能力匹配智能体角色
   */
  matchAgentRole(capabilities: string[]): AgentRole | null {
    if (!this.config) return null;

    for (const role of Object.values(this.config.agent_roles)) {
      const hasMatch = capabilities.some(cap =>
        role.capabilities.some(rc => rc.includes(cap) || cap.includes(rc))
      );
      if (hasMatch) return role;
    }

    return this.config.agent_roles['architect'];
  }

  /**
   * 检查是否可以使用快速通道
   */
  canUseFastTrack(changeDescription: string): {
    canUse: boolean;
    blockers: string[];
  } {
    if (!this.config?.fast_track.enabled) {
      return { canUse: false, blockers: ['快速通道未启用'] };
    }

    const blockers: string[] = [];
    const conditions = this.config.fast_track.conditions;

    // 简化检查：实际应用中需要更复杂的分析
    if (changeDescription.length > 500) {
      blockers.push('改动可能超过 3 个文件');
    }

    if (changeDescription.includes('API') || changeDescription.includes('契约')) {
      blockers.push('涉及契约变更');
    }

    if (changeDescription.includes('模块') || changeDescription.includes('跨模块')) {
      blockers.push('涉及跨模块接缝');
    }

    return {
      canUse: blockers.length === 0,
      blockers
    };
  }

  /**
   * 获取工作流状态摘要
   */
  getWorkflowStatus(): {
    currentGate: number;
    gateName: string;
    progress: string;
    blockers: string[];
    history: number[];
  } {
    const gateConfig = this.getGateConfig(this.currentGate);
    const totalGates = 9;

    return {
      currentGate: this.currentGate,
      gateName: gateConfig?.name || '未知',
      progress: `${this.currentGate}/${totalGates} Gates`,
      blockers: this.getBlockers(),
      history: [...this.gateHistory]
    };
  }

  /**
   * 重置工作流
   */
  reset(): void {
    this.currentGate = 0;
    this.artifacts.clear();
    this.gateHistory = [];
  }

  /**
   * 导出配置为 JSON
   */
  exportConfig(): string {
    if (!this.config) return '';
    return JSON.stringify(this.config, null, 2);
  }
}

// 单例实例
let integratorInstance: HarnessWorkflowIntegrator | null = null;

export function createHarnessWorkflowIntegrator(): HarnessWorkflowIntegrator {
  return new HarnessWorkflowIntegrator();
}

export function getHarnessWorkflowIntegrator(): HarnessWorkflowIntegrator {
  if (!integratorInstance) {
    integratorInstance = new HarnessWorkflowIntegrator();
  }
  return integratorInstance;
}