/**
 * wiring/continuation.ts — 接缝 ①「这个 Goal 现在该不该开下一轮, 为什么?」  (**M1 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'continuation'`, `stage: 'M1'`。
 * M1 只准改本文件 + 本接缝声明的 `wiringPoints` (`goal-flywheel/continuation-decision.ts`)。
 *
 * ## 这条接缝钉住的冻结规则
 *
 * **只有 Supervisor 能决定是否继续** (规则 ①)。
 * 钉法不是文档, 是**调用方必须显式声明身份**: 接缝的入口 `preflight()` 要一个
 * `caller` 字段, 非 `supervisor` 一律拒绝。于是"Runner 自己觉得还能再跑一轮"这种
 * 绕过在类型上就写不出来, 在运行时会拿到一条结构化拒绝。
 *
 * ## 依赖 (全部按参数注入, 不 import 别的阶段的实现)
 *
 * `deps.decide` = 判定本体 (§14 冻结签名 `decideContinuation` 的适配), 由 M0 的接线层注入。
 * 本文件**不读盘、不读钟**: `now` 由调用方注入。
 */

import type { ContinuationDecisionKind, ContinuationState, IsoTimestamp } from '../types.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const CONTINUATION_SEAM_ID = 'continuation' as const;

/** 判定结论的最小面 (与 GoalStepDecision 同口径, 但**不 import** 接线层, 避免耦合) */
export interface GoalStepOutcome {
  goalId: string;
  runnable: boolean;
  reason: string;
  noProgressStreak: number;
  decision: {
    decision: ContinuationDecisionKind;
    state: ContinuationState;
    nextAction: string;
    requiredCapability: string | null;
    decisionId: string;
  } | null;
}

export interface ContinuationSeamDeps {
  decide: (input: {
    goalId: string;
    now: IsoTimestamp;
    maxRetries?: number;
    writeRecord?: boolean;
  }) => Promise<GoalStepOutcome | null>;
}

export interface ContinuationSeam {
  readonly id: typeof CONTINUATION_SEAM_ID;
  readonly stage: 'M1';
  /**
   * 跑之前的节奏判定。
   *
   * `caller !== 'supervisor'` → 拒绝 (规则 ①)。拒绝是**结构化**的:
   * 上层能原样把它记进 `report.skipped` / `report.errors`, 而不是"静默不跑"。
   */
  preflight(input: {
    goalId: string;
    caller: WiringCaller;
    now: IsoTimestamp;
    maxRetries?: number;
    writeRecord?: boolean;
  }): Promise<GoalStepOutcome | SeamRefusal | null>;
}

export function createContinuationSeam(deps: ContinuationSeamDeps): ContinuationSeam {
  return {
    id: CONTINUATION_SEAM_ID,
    stage: 'M1',
    async preflight(input) {
      if (input.caller !== 'supervisor') {
        return refuse(
          'only_supervisor_decides_continuation',
          `拒绝: caller=${input.caller} 想决定"是否继续 (goal=${input.goalId})" —— `
          + '只有 Supervisor 能决定是否继续 (Runner/子 Agent 只能上报事实与建议)',
        );
      }
      if (!input.goalId) {
        return refuse('only_supervisor_decides_continuation', '拒绝: 没有 goalId 的节奏判定等于给不存在的目标排队');
      }
      return deps.decide({
        goalId: input.goalId,
        now: input.now,
        maxRetries: input.maxRetries,
        writeRecord: input.writeRecord,
      });
    },
  };
}
