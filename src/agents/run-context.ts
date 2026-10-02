/**
 * RunContext —— 一次 Run 的显式状态载体 (K2)
 *
 * 为什么要有它: Pi 实例上原来挂着 8 个可变运行状态字段 (`messageHistory` / `currentRunId` /
 * `currentChannelId` / `currentAgentId` / `currentGoalId` / `currentOnStream` / `currentIntent` /
 * `currentSignal`), 共 182 处 `this.` 访问。两个 Run 只要共用实例就必然互相覆盖。
 *
 * 迁移策略 (逐字段, 一格一格走):
 *   1. 字段先搬进 RunContext ⇒ 访问点从 `this.<field>` 变 `this.runCtx.<slot>` (**行为不变**, 只是收口);
 *   2. 再把 RunContext 从"实例上的一个对象"改成"每次 Run 新建、随调用显式传递";
 *   3. 循环函数最终只接受 `ctx: RunContext` —— 这就是 K2 的完成形态。
 *
 * 台账与判据: `src/kernel/plan-runcontext.ts` + `src/test/kernel-runcontext.test.ts`
 * (逐字段访问计数与冻结值双向相等; 标了 migrated 的字段访问必须为 0)。
 */
import type { StreamCallback } from './pi-sdk-types.js';

/** 本轮用户意图 (与旧实例字段 `currentIntent` 的字面量集合一致) */
export type RunIntent = 'question' | 'code_edit' | 'multi_step' | 'chitchat' | 'document';

export interface RunContext {
  /** 一次请求的唯一 id (入口生成) */
  requestId: string;
  /** 通道 (K2 迁移中: 入口从实例字段快照) */
  channelId: string;
  agentId: string;
  goalId: string;
  /** 当前 Run id (K2 迁移中: 入口从实例字段快照) */
  runId: string;
  /** 本轮用户意图 —— 已外置 (原 `currentIntent`); 由入口 `classifyIntent()` 定 */
  intent: RunIntent;
  /** 本轮模型快照 (K5 ModelRuntime 填; 现在为 null) */
  modelSnapshot: unknown | null;
  /** 会话历史 (迁移中: 仍以 Pi 实例的 messageHistory 为准) */
  history: unknown[] | null;
  /** 取消信号 */
  abortSignal: AbortSignal | null;
  /** 预算 (K5 填) */
  budget: unknown | null;
  /** 事件出口 —— 已迁移: 不再走实例字段 */
  eventSink: StreamCallback | null;
  /** Harness 上下文 (K6 填) */
  harnessContext: unknown | null;
}

let seq = 0;

/** 建一个 RunContext; 未给的字段一律显式置空 (不继承上一个 Run 的残留) */
export function createRunContext(partial: Partial<RunContext> = {}): RunContext {
  seq += 1;
  return {
    requestId: partial.requestId ?? `rc-${Date.now().toString(36)}-${seq}`,
    channelId: partial.channelId ?? '',
    agentId: partial.agentId ?? '',
    goalId: partial.goalId ?? '',
    runId: partial.runId ?? '',
    // 'chitchat' 是中性默认, 与旧实例字段初值一致 (不是继承上一个 Run 的残留)
    intent: partial.intent ?? 'chitchat',
    modelSnapshot: partial.modelSnapshot ?? null,
    history: partial.history ?? null,
    abortSignal: partial.abortSignal ?? null,
    budget: partial.budget ?? null,
    eventSink: partial.eventSink ?? null,
    harnessContext: partial.harnessContext ?? null,
  };
}
