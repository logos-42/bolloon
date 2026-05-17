/**
 * ConstraintLayer - Guardrails for safe autonomous document processing
 * Part of OpenClaw dual-layer architecture (Constraint Layer + Execution Layer)
 */

import { ToolPermissionContext } from '../constraint-runtime/src/constraint/permission.js';
import { BudgetTracker } from '../constraint-runtime/src/constraint/budget.js';
import type { UsageSummary } from '../constraint-runtime/src/models.js';

export interface Guardrail {
  name: string;
  check: (context: WorkflowContext, step?: WorkflowStep) => Promise<boolean>;
  onFail?: 'block' | 'warn' | 'retry';
}

export interface ConstraintRule {
  id: string;
  description: string;
  guardrails: Guardrail[];
}

export interface WorkflowContext {
  document?: DocumentContent;
  summary?: string;
  improved?: string;
  qualityScore?: number;
  peers: string[];
  logs: OperationLog[];
  metadata?: Record<string, unknown>;
}

export interface DocumentContent {
  text: string;
  metadata: {
    filename: string;
    size: number;
    type: string;
  };
}

export interface OperationLog {
  timestamp: number;
  action: string;
  details: Record<string, unknown>;
  status: 'success' | 'failed' | 'blocked' | 'warn';
}

export interface WorkflowStep {
  id: string;
  type: 'read' | 'chunk' | 'summarize' | 'improve' | 'review' | 'send' | 'report';
  config?: WorkflowStepConfig;
  retry: {
    max: number;
    current: number;
    backoffMs: number;
  };
  onFail: 'skip' | 'abort' | 'retry';
  guardrail?: (context: WorkflowContext) => Promise<boolean>;
  guardrailOnRetry?: boolean;
}

export interface WorkflowStepConfig {
  path?: string;
  requirements?: string;
  context?: string;
  peerId?: string;
  message?: string;
  content?: string;
  maxChunkSize?: number;
}

/**
 * System prompt for constraint layer
 * Defines boundaries and autonomous permissions
 */
export const SYSTEM_PROMPT = `
你是一个文档处理Agent，在以下规则下运行：

【边界规则】
1. 只处理：txt, md, pdf, docx 格式文档
2. 不修改原始文件，只输出改进版本
3. 发送前必须记录操作日志

【自主权限】
- ✅ 自主决定：摘要详细程度、chunk分块策略
- ✅ 自主决定：重试次数（最多3次）
- ✅ 自主决定：是否需要补充信息
- ❌ 必须确认：首次向新对等节点发送文档
- ❌ 必须确认：删除操作

【敏感操作拦截】
if (操作 === '发送文档' && 对等节点不在已知列表) {
  拦截 → 记录 → 等待确认
}
`;

/**
 * Actions that can be executed autonomously without confirmation
 */
export const AUTONOMOUS_ACTIONS = ['summarize', 'chunk', 'improve'];

/**
 * Actions that require explicit confirmation before execution
 */
export const CONFIRM_REQUIRED_ACTIONS = ['send', 'delete'];

/**
 * ConstraintLayer provides guardrails for safe document processing
 * Implements the constraint layer of the OpenClaw dual-layer architecture
 */
export class ConstraintLayer {
  private rules: Map<string, ConstraintRule> = new Map();
  private logs: OperationLog[] = [];
  private permission: ToolPermissionContext;
  private budget: BudgetTracker;

  constructor(
    denyTools: string[] = [],
    denyPrefixes: string[] = [],
    maxBudgetTokens: number = 2000,
    maxTurns: number = 8
  ) {
    this.permission = ToolPermissionContext.fromIterables(denyTools, denyPrefixes);
    this.budget = new BudgetTracker(maxBudgetTokens, maxTurns);
    this.registerDefaultRules();
  }

  /**
   * Register default guardrail rules
   */
  private registerDefaultRules(): void {
    // Rule: Block sending to unknown peers
    this.registerRule({
      id: 'unknown-peer-send',
      description: '阻止向未知对等节点发送文档',
      guardrails: [{
        name: 'validateSendTarget',
        check: async (ctx, step) => {
          const targetPeer = step?.config?.peerId as string;
          if (!targetPeer) return true;
          
          const isKnown = ctx.peers.includes(targetPeer);
          if (!isKnown) {
            this.log('BLOCKED: Unknown peer', { targetPeer }, 'blocked');
          }
          return isKnown;
        },
        onFail: 'block'
      }]
    });

    // Rule: Validate summary quality
    this.registerRule({
      id: 'summary-quality',
      description: '确保摘要质量达标',
      guardrails: [{
        name: 'validateSummaryQuality',
        check: async (ctx) => {
          if (ctx.qualityScore !== undefined && ctx.qualityScore < 0.5) {
            this.log('WARN: Low quality summary', { score: ctx.qualityScore }, 'warn');
            return false;
          }
          return true;
        },
        onFail: 'retry'
      }]
    });

    // Rule: File format validation
    this.registerRule({
      id: 'file-format',
      description: '验证文件格式是否支持',
      guardrails: [{
        name: 'validateFileFormat',
        check: async (ctx) => {
          const supportedFormats = ['.txt', '.md', '.pdf', '.docx'];
          const docType = ctx.document?.metadata?.type;
          
          if (docType && !supportedFormats.includes(docType)) {
            this.log('BLOCKED: Unsupported file format', { type: docType }, 'blocked');
            return false;
          }
          return true;
        },
        onFail: 'block'
      }]
    });
  }

  /**
   * Register a new constraint rule
   */
  registerRule(rule: ConstraintRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * Unregister a constraint rule
   */
  unregisterRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * Check if a tool is permitted to run
   */
  checkToolPermission(toolName: string): boolean {
    return !this.permission.blocks(toolName);
  }

  /**
   * Check if budget or turn limits are exceeded
   */
  checkBudget(usage: UsageSummary, turnCount: number): boolean {
    const budgetExceeded = this.budget.isBudgetExceeded(usage);
    const turnLimitExceeded = this.budget.isTurnLimitExceeded(turnCount);
    return !budgetExceeded && !turnLimitExceeded;
  }

  /**
   * Check all guardrails against the current context
   */
  async checkGuardrails(
    context: WorkflowContext,
    step?: WorkflowStep,
    toolName?: string,
    usage?: UsageSummary,
    turnCount?: number
  ): Promise<{
    passed: boolean;
    blocked?: Guardrail;
  }> {
    if (toolName !== undefined && !this.checkToolPermission(toolName)) {
      this.log('BLOCKED: Tool permission denied', { toolName }, 'blocked');
      return { passed: false };
    }

    if (usage !== undefined && turnCount !== undefined && !this.checkBudget(usage, turnCount)) {
      this.log('BLOCKED: Budget or turn limit exceeded', { usage, turnCount }, 'blocked');
      return { passed: false };
    }

    for (const rule of this.rules.values()) {
      for (const guardrail of rule.guardrails) {
        try {
          const passed = await guardrail.check(context, step);
          if (!passed) {
            return { passed: false, blocked: guardrail };
          }
        } catch (error) {
          this.log(
            `Guardrail error: ${guardrail.name}`,
            { error: String(error) },
            'failed'
          );
          return { passed: false, blocked: guardrail };
        }
      }
    }
    return { passed: true };
  }

  /**
   * Log an operation with timestamp and status
   */
  log(action: string, details: Record<string, unknown>, status: OperationLog['status']): void {
    this.logs.push({
      timestamp: Date.now(),
      action,
      details,
      status
    });
  }

  /**
   * Get all operation logs
   */
  getLogs(): OperationLog[] {
    return [...this.logs];
  }

  /**
   * Clear operation logs
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Check if an action is autonomous (no confirmation required)
   */
  isAutonomousAction(action: string): boolean {
    return AUTONOMOUS_ACTIONS.includes(action);
  }

  /**
   * Check if an action requires confirmation
   */
  requiresConfirmation(action: string): boolean {
    return CONFIRM_REQUIRED_ACTIONS.includes(action);
  }

  /**
   * Get all registered rule IDs
   */
  getRuleIds(): string[] {
    return Array.from(this.rules.keys());
  }
}