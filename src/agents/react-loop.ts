/**
 * ReAct Loop 决策层 (decideNext + runStep)
 *
 * 2026-06-30 抽出:
 *   - 原 PiAgentSession.runReActLoop 是 1100+ 行的 private 巨石函数, 既管 LLM IO 又管状态机.
 *   - 现在抽出"决策下一步"为纯函数, claude code / 外部 harness 可独立消融验证.
 *
 * 决策表 (apply 到 LLM 回复 + 当前 state):
 *   1. reply 是 AI failure sentinel        → continue (push error 进 history, 让 LLM 反思)
 *   2. reply 可 parse 出 tool call         → execute-tool (调 tool, push result 进 history)
 *   3. reply 含 <final gen> 且无 tool_call → final (LLM 显式终止)
 *   4. reply 无 <final gen>, 无 tool_call  → continue (LLM 可能再想想, 让下一轮重新生成)
 *
 * 这个模块不调 LLM, 只接受 reply/state 返回下一步决策. LLM 调用 + 真正状态变更
 *   仍由 PiAgentSession 协调. 这样 claude code 可以独立 unit-test 决策边界.
 */

import { parseToolCall, isFinalResponse } from './parse-tool-call.js';

/** 单步决策输出 */
export type NextAction =
  | { kind: 'continue'; reason: string }
  | { kind: 'execute-tool'; name: string; args: Record<string, string>; reason: string }
  | { kind: 'final'; answer: string; reason: string }
  | { kind: 'parse-error'; reason: string };

/** 决策输入 */
export interface StepContext {
  /** LLM 本轮回复 */
  reply: string;
  /** 已注册 tools 主名集合 — 用来看 unknown tool 时怎么算错误 */
  knownToolNames: Set<string>;
  /** 是否 abort */
  signalAborted?: boolean;
  /** 当前是否已经到达 max 迭代, 外部检查 */
  atMaxIterations?: boolean;
}

/** 把 LLM 回复归到一种 next action — 纯函数. */
export function decideNext(ctx: StepContext): NextAction {
  if (ctx.signalAborted) {
    return { kind: 'continue', reason: 'signal-aborted-upstream' };
  }
  if (ctx.atMaxIterations) {
    return { kind: 'final', answer: '(max iterations reached, fail-safe)', reason: 'max-iterations' };
  }

  // AI failure sentinel 优先 (matches pi-sdk.ts 现有顺序 L2558)
  //   LLM 偶尔在 retry 中夹杂 sentinel + 工具块, sentinel 是必须先看的"停止信号"
  if (isAiFailureSentinel(ctx.reply)) {
    return { kind: 'continue', reason: 'ai-failure-sentinel' };
  }

  // 工具调用优先 (per 2026-06-19 fix) — 在 sentinel 之后
  const tc = parseToolCall(ctx.reply, { tools: ctx.knownToolNames });
  if (tc) {
    if (!ctx.knownToolNames.has(tc.name)) {
      // 名字解析出来但不在已知集合 — LLM 幻觉高频场景
      return { kind: 'parse-error', reason: `unknown-tool:${tc.name}` };
    }
    return {
      kind: 'execute-tool',
      name: tc.name,
      args: tc.args,
      reason: 'parse-tool-call',
    };
  }

  // final gen 终止
  if (isFinalResponse(ctx.reply)) {
    return { kind: 'final', answer: ctx.reply, reason: 'final-gen-marker' };
  }

  // 默认 — 普通 text, 让 LLM 继续想
  return { kind: 'continue', reason: 'no-tool-no-final' };
}

/**
 * isAiFailureSentinel — 检测 LLM 上游失败哨兵.
 * bolloon 用 [AI 服务调用失败] 前缀作为哨兵 — runReActLoop 收到时
 *   把错误当 tool result push 进 history, 让 LLM 下轮能反思.
 */
export function isAiFailureSentinel(reply: string): boolean {
  if (!reply) return false;
  const trimmed = reply.trim();
  return trimmed.startsWith('[AI 服务调用失败]') ||
         trimmed.startsWith('[AI 调用失败]') ||
         trimmed.startsWith('[错误:');
}

/** extractFinalText — 抽 LLM 输出里能呈现给用户的最终文字 (已是 Message 状态). */
export function extractFinalText(reply: string, marker: string = '<final gen>'): string {
  const idx = reply.indexOf(marker);
  if (idx !== -1) {
    const after = reply.substring(idx + marker.length).trim();
    return after || reply.substring(0, idx).trim();
  }
  return reply;
}

/**
 * 错误累计判定 — 当 totalErrors 达阈值时, 给 final 答案 + 汇总.
 * 这是独立的小函数, 因为 runReActLoop 用它决定是否继续.
 */
export function shouldForceExit(totalErrors: number, maxTotalErrors: number): boolean {
  return totalErrors >= maxTotalErrors;
}

/**
 * 2026-07-01 (v0.2.4 子任务 1): 迭代上限判定 — 纯函数.
 * 之前 runReActLoop 在循环顶部硬编码 `if (iteration >= MAX_REACT_ITERATIONS)`,
 * 抽出后 claude code 可独立单测 + 替代.
 */
export function decideMaxIterations(iteration: number, maxIterations: number): {
  shouldExit: boolean;
  finalAnswer: string;
} {
  return {
    shouldExit: iteration >= maxIterations,
    finalAnswer: iteration >= maxIterations
      ? '(本轮 ReAct 循环达到最大步数, 强制结束)'
      : '',
  };
}

/**
 * 2026-07-01 (v0.2.4 子任务 1): context overflow 判定 — 纯函数.
 * 之前 runReActLoop 紧接 decideMaxIterations 之后硬编码 token 阈值检查.
 * 抽出后行为一致 + 可测.
 */
export function decideContextOverflow(
  estimatedTokens: number,
  threshold: number,
): { shouldExit: boolean; finalAnswer: string } {
  return {
    shouldExit: estimatedTokens > threshold,
    finalAnswer: estimatedTokens > threshold
      ? `(本轮 ReAct 循环因上下文溢出终止)`
      : '',
  };
}

/**
 * 2026-07-01 (v0.2.4 子任务 1): compact 触发判定 — 纯函数.
 * 之前 runReActLoop 入口处: estimatedTokens > compactThreshold → 跑 maybeAutoCompact.
 * 抽出纯函数后, claude code 能 dry-run "token X 时该 compact 吗".
 */
export function shouldCompactBeforeIteration(
  estimatedTokens: number,
  compactThreshold: number,
): boolean {
  return estimatedTokens > compactThreshold;
}

/**
 * 同一工具连续失败 N 次, 提示 LLM 不要再用同一个工具 (force final).
 */
export function shouldHintToStopSameTool(consecutiveFails: number, threshold: number): boolean {
  return consecutiveFails >= threshold;
}
