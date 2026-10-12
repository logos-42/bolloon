/**
 * pi-harness.ts — 唯一 PiAgentHarness 门面 (2026-09-16 Milestone 1-B)
 *
 * 背景 (leo 2026-09-16): 约束层是**散落的多层** —— react-harness / deny-pipeline /
 * pre-tool-validator(human-value-pipeline) / hooks-engine / tool-gate / loop-review 各自被
 * pi-sdk 在不同位置分别调用, 于是出现"某条路径走 deny-pipeline、另一条绕过它", 且各自出错时
 * 的处置不一致 (多数是 fail-open = 出错就放行)。
 *
 * 这一层不删旧模块, 只**收敛入口**: pi-sdk 只认识 PiAgentHarness, 由 Harness 决定约束流程与顺序。
 * 旧模块成为 Harness 的内部实现 (通过构造参数注入, 行为保持不变)。
 *
 * 生命周期 (与计划书一致):
 *   sessionStart → beforeModelCall → afterModelCall → beforeToolCall → afterToolCall
 *                → checkpoint → recover → pause → sessionEnd
 *
 * 失败分级 (leo 2026-09-16 第 6 条):
 *   core_constraint  核心约束自身失效 (e.g. 策略层异常) → **阻止执行** (默认 fail-closed)
 *   policy_denied    工具被策略拒绝 → 返回 agent 可处理的拒绝结果 (不崩, 不静默放行)
 *   observational    观测/记录失败 → 记降级, 不中断 (决策不因记账失败而改变)
 *   goal_review      目标审查未通过 → 不许进 done (由调用方按决策续跑)
 *
 * 设计取舍 (如实记): 
 *   - 旧行为里 "harness 抛错 → 放行" 是 fail-open; 现在默认 fail-closed (`failClosed: true`)。
 *     这是 Phase 1 的**明确要求** (不允许 harness 出错后默认放行高风险工具), 不是顺带改动。
 *   - Harness 事件写 Run 用"观测级"写入: 记账失败绝不改变已做出的决策 (记录是账, 不是闸)。
 */

import type { ReactHarness } from '../security/react-harness.js';
import type { DenyPipeline, DenyContext } from './deny-pipeline.js';
import type { HooksEngine } from '../hooks/hooks-engine.js';
import { decideAfterReview, DEFAULT_MAX_REVIEWS, type ReviewState, type ReviewDecision } from './loop-review.js';

/** 失败分级 (协议 §3 的 errorClass 是"错误分类", 这里是"约束层失败分级", 两者互补) */
export type HarnessFailureKind = 'core_constraint' | 'policy_denied' | 'observational' | 'goal_review';

/** 每个生命周期事件都带上的运行身份 (Milestone 1-B 第 4 条: runId/goalId/agentId 贯穿) */
export interface HarnessRunContext {
  runId?: string;
  goalId?: string;
  agentId?: string;
  channelId?: string;
  surface?: string;
}

/** 写 Run 的事件 (由调用方注入 run-store 的写入实现) */
export interface HarnessEvent {
  ts: string;
  /** 生命周期位置 */
  event: 'sessionStart' | 'beforeModelCall' | 'afterModelCall' | 'beforeToolCall' | 'afterToolCall'
       | 'checkpoint' | 'recover' | 'pause' | 'sessionEnd' | 'review';
  /** 结果性质 */
  kind: 'allow' | 'deny' | 'degrade' | 'error' | 'note';
  failureKind?: HarnessFailureKind;
  tool?: string;
  reason?: string;
  source?: string;
  ms?: number;
  runId?: string;
  goalId?: string;
}

export interface ToolDecision {
  allow: boolean;
  /** 拒绝原因 (给 agent 看的) */
  reason?: string;
  /** 谁拒的 */
  source?: 'deny-pipeline' | 'pre-tool-validator' | 'react-harness' | 'hooks' | 'harness-error';
  /** react-harness 的 gate 名 (rejectedBy) */
  rejectedBy?: string;
  /** 放行时仍要注入 system prompt 的补充 */
  systemAddition?: string;
  /** 失败分级 */
  kind?: HarnessFailureKind;
  /** 是否处于降级状态 (约束层自身出过问题, 但仍给出了结论) */
  degraded?: boolean;
}

export interface AfterToolResult {
  /** 输出被 gate 拦下 → 调用方要把 result.output 换掉 */
  outputBlocked?: { reason: string };
  /** 需要注入的 router hint */
  routeHint?: { reason: string; systemAddition: string };
  degraded?: boolean;
}

export interface PiAgentHarnessDeps {
  reactHarness: ReactHarness;
  denyPipeline: DenyPipeline;
  hooks: HooksEngine;
  /**
   * 参数/危险命令校验链 (pre-tool-validator 4 步: modeGate / blacklist / shell-guard / schema,
   * 经 human-value-pipeline 的 onPreToolUse 包装)。不传 = 这一环不参与 (与旧行为一致)。
   */
  preToolUse?: (opts: { tool: string; args: Record<string, unknown>; permissionMode?: string }) => Promise<{ allowed: boolean; reason?: string }>;
  /** 事件写 Run 的出口 (通常是 run-store.recordHarnessEvent) */
  events?: (e: HarnessEvent) => void | Promise<void>;
  /** 约束层自身失效时是否阻止执行。默认 true (Phase 1 要求: 不许 fail-open) */
  failClosed?: boolean;
}

export class PiAgentHarness {
  private deps: PiAgentHarnessDeps;
  private failClosed: boolean;
  private modelCalls = 0;
  private degradedOnce = new Set<string>();

  constructor(deps: PiAgentHarnessDeps) {
    this.deps = deps;
    this.failClosed = deps.failClosed !== false;
  }

  /** 事件出口: 记账失败**永不**抛出 (记录是账, 不是闸) */
  private emit(e: Omit<HarnessEvent, 'ts'>): void {
    try {
      const full: HarnessEvent = { ts: new Date().toISOString(), ...e };
      const out = this.deps.events?.(full);
      if (out && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((err) => console.warn('[PiAgentHarness] 事件写入失败 (非致命):', (err as Error)?.message));
      }
    } catch (err) {
      console.warn('[PiAgentHarness] 事件构造/写入失败 (非致命):', (err as Error)?.message);
    }
  }

  /** 约束层自身失效的统一处置: 记降级 + 决定是否放行 (failClosed → 不放行) */
  private onLayerError(layer: string, err: unknown, ctx: HarnessRunContext, tool?: string): ToolDecision | null {
    const message = `${layer} 失效: ${String((err as Error)?.message || err).slice(0, 200)}`;
    console.warn(`[PiAgentHarness] ${message}`);
    this.emit({ event: 'beforeToolCall', kind: 'error', failureKind: 'core_constraint', tool, reason: message, source: layer, runId: ctx.runId, goalId: ctx.goalId });
    if (!this.failClosed) return null;   // 旧语义 (fail-open) — 仅显式配置时
    return {
      allow: false,
      reason: `核心约束层 ${layer} 失效, 已阻止该工具调用 (fail-closed): ${message}`,
      source: 'harness-error',
      kind: 'core_constraint',
      degraded: true,
    };
  }

  // ───────────────────────── session ─────────────────────────

  async sessionStart(ctx: HarnessRunContext): Promise<void> {
    const t0 = Date.now();
    // ① react-harness 会话开启 (8-gate 状态复位)
    try {
      await this.deps.reactHarness.onSessionStart(ctx.channelId);
    } catch (err) {
      this.emit({ event: 'sessionStart', kind: 'degrade', failureKind: 'observational', reason: `reactHarness.onSessionStart 失败: ${(err as Error)?.message}`, runId: ctx.runId, goalId: ctx.goalId });
    }
    // ② hooks: onLoopStart (一次运行一次; 与旧行为一致)
    let hookDeny: string | null = null;
    try {
      const results = await this.deps.hooks.fire('onLoopStart', { event: 'onLoopStart', channelId: ctx.channelId, agentId: ctx.agentId });
      for (const r of results || []) if (r?.deny) hookDeny = r.reason || 'hook 拒绝';
    } catch { /* hook 失败静默 (与旧行为一致: hooks-engine 自身已兜底) */ }
    this.emit({ event: 'sessionStart', kind: hookDeny ? 'deny' : 'allow', reason: hookDeny || undefined, source: 'hooks', ms: Date.now() - t0, runId: ctx.runId, goalId: ctx.goalId });
  }

  async sessionEnd(ctx: HarnessRunContext): Promise<void> {
    try {
      await this.deps.reactHarness.onSessionEnd();
      this.emit({ event: 'sessionEnd', kind: 'note', runId: ctx.runId, goalId: ctx.goalId });
    } catch (err) {
      this.emit({ event: 'sessionEnd', kind: 'degrade', failureKind: 'observational', reason: `reactHarness.onSessionEnd 失败: ${(err as Error)?.message}`, runId: ctx.runId, goalId: ctx.goalId });
    }
  }

  // ───────────────────────── model call ─────────────────────────

  /**
   * 模型调用前 (扩展点)。默认只计数 + 留事件。
   * 刻意**不**在此 fire 新的 hook 事件: 旧行为里模型调用前没有任何 hook, 加了会改变现有
   * hooks.yaml 用户的实际触发次数 (属于行为变更, 需要单独决策, 见 wiki 记录)。
   */
  beforeModelCall(ctx: HarnessRunContext): { hints: string[] } {
    this.modelCalls++;
    this.emit({ event: 'beforeModelCall', kind: 'note', runId: ctx.runId, goalId: ctx.goalId });
    return { hints: [] };
  }

  afterModelCall(ctx: HarnessRunContext, info: { error?: unknown; ms?: number } = {}): void {
    if (info.error) {
      this.emit({ event: 'afterModelCall', kind: 'error', failureKind: 'core_constraint', reason: String((info.error as Error)?.message || info.error).slice(0, 200), ms: info.ms, runId: ctx.runId, goalId: ctx.goalId });
      return;
    }
    this.emit({ event: 'afterModelCall', kind: 'note', ms: info.ms, runId: ctx.runId, goalId: ctx.goalId });
  }

  get modelCallCount(): number {
    return this.modelCalls;
  }

  // ───────────────────────── tool call ─────────────────────────

  /**
   * 工具调用前的**唯一**决策入口。
   * 顺序严格保持旧实现: deny-pipeline → pre-tool-validator(4 步链) → react-harness(8-gate)。
   * 任一层拒绝即返回 (第一层拒绝后不再检查后续), 与旧行为一致。
   */
  async beforeToolCall(input: { tool: string; args: Record<string, unknown>; ctx: HarnessRunContext; permissionMode?: string }): Promise<ToolDecision> {
    const { tool, args, ctx } = input;
    const t0 = Date.now();

    // ① deny-pipeline (黑名单 / 权限 / hooks 策略)
    let denyResult: Awaited<ReturnType<DenyPipeline['check']>> | null = null;
    try {
      denyResult = await this.deps.denyPipeline.check({
        toolName: tool,
        toolArgs: args || {},
        permissionMode: input.permissionMode,
        channelId: ctx.channelId,
        agentId: ctx.agentId,
      } as DenyContext);
    } catch (err) {
      const fail = this.onLayerError('deny-pipeline', err, ctx, tool);
      if (fail) return fail;
    }
    if (denyResult?.denied) {
      const decision: ToolDecision = {
        allow: false,
        reason: denyResult.reason,
        source: 'deny-pipeline',
        rejectedBy: denyResult.source,
        kind: 'policy_denied',
      };
      this.emit({ event: 'beforeToolCall', kind: 'deny', failureKind: 'policy_denied', tool, reason: denyResult.reason, source: `deny-pipeline:${denyResult.source}`, ms: Date.now() - t0, runId: ctx.runId, goalId: ctx.goalId });
      return decision;
    }

    // ② 参数/危险命令校验 (pre-tool-validator 4 步链)
    if (this.deps.preToolUse) {
      let pre: { allowed: boolean; reason?: string } | null = null;
      try {
        pre = await this.deps.preToolUse({ tool, args: args || {}, permissionMode: input.permissionMode });
      } catch (err) {
        const fail = this.onLayerError('pre-tool-validator', err, ctx, tool);
        if (fail) return fail;
      }
      if (pre && !pre.allowed) {
        this.emit({ event: 'beforeToolCall', kind: 'deny', failureKind: 'policy_denied', tool, reason: pre.reason, source: 'pre-tool-validator', ms: Date.now() - t0, runId: ctx.runId, goalId: ctx.goalId });
        return {
          allow: false,
          reason: pre.reason || '未通过安全校验',
          source: 'pre-tool-validator',
          rejectedBy: 'pre-tool-validator',
          kind: 'policy_denied',
        };
      }
    }

    // ③ react-harness (8-gate + builtin-guards, 含路由 hint)
    let preCall: Awaited<ReturnType<ReactHarness['preToolCall']>> | null = null;
    try {
      preCall = await this.deps.reactHarness.preToolCall(tool, args || {}, ctx.channelId);
    } catch (err) {
      const fail = this.onLayerError('react-harness', err, ctx, tool);
      if (fail) return fail;
    }
    if (preCall && !preCall.allowed) {
      this.emit({ event: 'beforeToolCall', kind: 'deny', failureKind: 'policy_denied', tool, reason: preCall.reason, source: `react-harness:${preCall.details?.rejectedBy}`, ms: Date.now() - t0, runId: ctx.runId, goalId: ctx.goalId });
      return {
        allow: false,
        reason: preCall.reason || '未通过安全校验',
        source: 'react-harness',
        rejectedBy: preCall.details?.rejectedBy,
        kind: 'policy_denied',
      };
    }

    this.emit({ event: 'beforeToolCall', kind: 'allow', tool, source: 'harness', ms: Date.now() - t0, runId: ctx.runId, goalId: ctx.goalId });
    return { allow: true, systemAddition: denyResult?.systemAddition };
  }

  /** 工具调用后: 路由 hint + 输出 gate (顺序与旧实现一致: hint 先, output gate 后) */
  async afterToolCall(input: { tool: string; output: string; ctx: HarnessRunContext; ok?: boolean }): Promise<AfterToolResult> {
    const { tool, ctx } = input;
    const out: AfterToolResult = {};

    try {
      const routeHint = this.deps.reactHarness.getLastRouteHint();
      if (routeHint && routeHint.systemAddition) {
        out.routeHint = { reason: routeHint.reason, systemAddition: routeHint.systemAddition };
        this.deps.reactHarness.clearRouteHint();
      }
    } catch { /* hint 读失败不影响执行 */ }

    try {
      const post = await this.deps.reactHarness.postToolCall(tool, String(input.output || ''), ctx.channelId);
      if (!post.allowed) {
        out.outputBlocked = { reason: post.reason || '输出含敏感信息' };
        this.emit({ event: 'afterToolCall', kind: 'deny', failureKind: 'policy_denied', tool, reason: out.outputBlocked.reason, source: 'react-harness:output', runId: ctx.runId, goalId: ctx.goalId });
        return out;
      }
    } catch (err) {
      // 旧行为: output gate 失败 → 放行原输出 (fail-open)。这里保持放行 (输出已产生, 拦不住源头),
      // 但**必须留痕**: 不把"gate 没跑成"说成"gate 通过了"。
      out.degraded = true;
      this.emit({ event: 'afterToolCall', kind: 'degrade', failureKind: 'observational', tool, reason: `output gate 失效 (输出已按原样放行): ${(err as Error)?.message}`, source: 'react-harness:output', runId: ctx.runId, goalId: ctx.goalId });
      return out;
    }

    this.emit({ event: 'afterToolCall', kind: 'allow', tool, source: 'harness', runId: ctx.runId, goalId: ctx.goalId });
    return out;
  }

  // ───────────────────────── run 生命周期 ─────────────────────────

  /** checkpoint: 由 Harness 统一触发 (调用方给实现, 通常是 run-store.saveCheckpoint) */
  async checkpoint(ctx: HarnessRunContext, cp: { completedActions: number; pendingAction?: string; nextAction?: string; contextRef?: string }): Promise<void> {
    try {
      await this.deps.events?.({ ts: new Date().toISOString(), event: 'checkpoint', kind: 'note', ms: undefined, runId: ctx.runId, goalId: ctx.goalId, reason: cp.nextAction });
    } catch { /* 记账失败不影响 */ }
  }

  /** recover / pause: 接口先立 (Milestone 2/3 接线), 此处只留事件 */
  recover(ctx: HarnessRunContext, info: { errorClass?: string; action?: string }): void {
    this.emit({ event: 'recover', kind: 'note', failureKind: 'observational', reason: `${info.errorClass || 'unknown'} → ${info.action || 'none'}`, runId: ctx.runId, goalId: ctx.goalId });
  }

  pause(ctx: HarnessRunContext, reason?: string): void {
    this.emit({ event: 'pause', kind: 'note', reason, runId: ctx.runId, goalId: ctx.goalId });
  }

  // ───────────────────────── 目标审查 ─────────────────────────

  /**
   * final 前目标对齐审查 (loop-review 的唯一入口)。
   * 审查本身失效时: 记为 goal_review 失败并**按"继续审查"处理**? 不 —— 按协议
   * "目标审查失败: 禁止进入 done", 这里返回 `continue-review` 的等价结果 (不放过收尾),
   * 避免"审查没跑成 → 直接算完成"。
   */
  reviewFinal(state: ReviewState, maxReviews: number = DEFAULT_MAX_REVIEWS): ReviewDecision {
    try {
      const decision = decideAfterReview(state, maxReviews);
      this.emit({ event: 'review', kind: decision.kind === 'continue-review' ? 'note' : 'allow', failureKind: 'goal_review', reason: decision.kind, runId: state.runId, goalId: state.goalId });
      return decision;
    } catch (err) {
      this.emit({ event: 'review', kind: 'error', failureKind: 'goal_review', reason: `审查器失效: ${(err as Error)?.message}`, runId: state.runId, goalId: state.goalId });
      return {
        kind: 'continue-review',
        hint: `[目标审查降级] 审查器执行失败 (${String((err as Error)?.message || err).slice(0, 120)}), 按"未确认完成"处理: 请再次核对用户需求是否真的全部满足, 并列出证据。确认完成后再给出最终回答。`,
      } as ReviewDecision;
    }
  }
}
