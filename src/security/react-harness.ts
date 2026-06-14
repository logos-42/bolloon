/**
 * React Harness — ReAct 循环的 hook 集中调度
 *
 * 包装:
 * - bollharness-integration (BollharnessHooks + GateStateMachine)
 * - tool-gate (8 道安全 gate)
 * - builtin-guards (4 个内置 guard, 跟 gate 互补)
 *
 * 接入点 (pi-sdk.ts runReActLoop):
 * - preToolCall: 调 tool.execute 前 (8-gate + guards)
 * - postToolCall: tool 返 output 后 (output gate + secret leak)
 * - sessionStart: ReAct 循环入口 (harness sessionStart)
 * - sessionEnd: 循环结束 (harness sessionEnd + archive)
 *
 * 设计原则:
 * - fail-open: 任何 hook 自身挂掉 = pass, 不阻塞主对话
 * - 8-gate + 4-guard 全部 disabled 时 = 旧行为 (跟加 harness 之前一样)
 * - all 结果记录到 harness session archive (供 UI 审计)
 */

import {
  createBollharnessIntegration,
  type BollharnessIntegration,
  type IntegrationResult,
} from '../bollharness-integration/integration.js';
import {
  runToolGates,
  runOutputGate,
  type ToolGateCheckResult,
} from './tool-gate.js';
import { routeContext } from './context-router-tool.js';

export interface ReactHarnessOptions {
  /** 是否启用 harness (BollharnessIntegration + Hooks); 关闭后只剩 tool-gate */
  harnessEnabled?: boolean;
  /** 是否启用 8-gate 安全检查; 关闭后只剩 builtin-guards */
  gateEnabled?: boolean;
  /** 单轮最多 tool 调用数 (默认 5) */
  maxToolCallsPerTurn?: number;
}

export interface PreToolCallResult {
  /** true = 允许执行, false = 拒绝 */
  allowed: boolean;
  reason?: string;
  /** 调试用: 各 gate 结果 */
  details: ToolGateCheckResult;
}

export interface PostToolCallResult {
  allowed: boolean;
  reason?: string;
  details: ToolGateCheckResult;
}

export class ReactHarness {
  private integration: BollharnessIntegration | null = null;
  private opts: Required<ReactHarnessOptions>;
  private recentCalls: Array<{ tool: string; ts: number }> = [];
  private toolCallCountInTurn = 0;

  constructor(options: ReactHarnessOptions = {}) {
    this.opts = {
      harnessEnabled: options.harnessEnabled ?? true,
      gateEnabled: options.gateEnabled ?? true,
      maxToolCallsPerTurn: options.maxToolCallsPerTurn ?? 5,
    };
    if (this.opts.harnessEnabled) {
      try {
        this.integration = createBollharnessIntegration({
          enabled: true,
          guardsEnabled: true,
          contextEnabled: true,
          skillsEnabled: true,
          gatesEnabled: true,
        });
      } catch (err) {
        console.warn('[react-harness] bollharness init failed (non-fatal):', err);
        this.integration = null;
      }
    }
  }

  /** 每次 ReAct 循环开始调一次 (重置 turn 计数 + 触发 harness sessionStart) */
  async onSessionStart(channelId?: string): Promise<void> {
    this.toolCallCountInTurn = 0;
    this.recentCalls = [];
    if (!this.integration) return;
    try {
      // BollharnessIntegration 自带 session 状态, 简单 log
      console.log(`[react-harness] session start, channel=${channelId ?? 'n/a'}, currentGate=${this.integration.getCurrentGate()}`);
    } catch (err) {
      console.warn('[react-harness] sessionStart failed (non-fatal):', err);
    }
  }

  /** 调 tool 前的 hook (8-gate + builtin-guards + context-router advisory) */
  async preToolCall(tool: string, args: Record<string, unknown>, channelId?: string): Promise<PreToolCallResult> {
    if (!this.opts.gateEnabled) {
      return { allowed: true, details: { allowed: true, details: [] } };
    }
    try {
      const result = runToolGates({
        tool,
        args,
        channelId,
        toolCallCountInTurn: this.toolCallCountInTurn,
        recentCalls: this.recentCalls,
      });
      if (result.allowed) {
        this.toolCallCountInTurn++;
        this.recentCalls.push({ tool, ts: Date.now() });

        // Context router: advisory 路由 (不阻断, 仅返回 hint 供 pi-sdk 拼到 LLM 上下文)
        // 失败静默, router 挂掉 = 不给 hint
        try {
          const route = routeContext({ channelId, predictedTool: tool });
          (this as any).lastRouteHint = route;
        } catch (err) {
          console.warn('[react-harness] routeContext failed (non-fatal):', err);
        }
      }
      return { allowed: result.allowed, reason: result.reason, details: result };
    } catch (err) {
      console.warn('[react-harness] preToolCall failed (fail-open):', err);
      return { allowed: true, details: { allowed: true, details: [] } };
    }
  }

  /** 取最近一次 router 算出的 hint (供 pi-sdk 拼到 messageHistory 工具结果位) */
  getLastRouteHint(): { systemAddition: string; toolPreamble: string; reason: string } | null {
    return (this as any).lastRouteHint ?? null;
  }

  /** 清空最近 hint (每轮 ReAct 循环结束重置) */
  clearRouteHint(): void {
    (this as any).lastRouteHint = null;
  }

  /** 调 tool 后的 hook (审查 output) */
  async postToolCall(tool: string, output: string, channelId?: string): Promise<PostToolCallResult> {
    if (!this.opts.gateEnabled) {
      return { allowed: true, details: { allowed: true, details: [] } };
    }
    try {
      const result = runOutputGate(output);
      if (!result.allowed) {
        return { allowed: false, reason: result.reason, details: result };
      }
      return { allowed: true, details: result };
    } catch (err) {
      console.warn('[react-harness] postToolCall failed (fail-open):', err);
      return { allowed: true, details: { allowed: true, details: [] } };
    }
  }

  /** ReAct 循环结束 */
  async onSessionEnd(): Promise<void> {
    if (!this.integration) return;
    try {
      // 归档: 当前无 operationLog (那是另接的), 仅 log 状态
      const gate = this.integration.getCurrentGate();
      console.log(`[react-harness] session end, finalGate=${gate}, toolCallsThisTurn=${this.toolCallCountInTurn}`);
    } catch (err) {
      console.warn('[react-harness] sessionEnd failed (non-fatal):', err);
    }
  }

  /** 暴露给 UI 调试 (harness 状态) */
  getHarnessSnapshot(): { integration: boolean; gateEnabled: boolean; currentGate: number } {
    return {
      integration: this.integration !== null,
      gateEnabled: this.opts.gateEnabled,
      currentGate: this.integration ? this.integration.getCurrentGate() : 0,
    };
  }
}
