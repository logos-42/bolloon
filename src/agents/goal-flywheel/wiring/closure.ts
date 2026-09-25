/**
 * wiring/closure.ts — 接缝 ②「这一条 Run 收尾了吗, 收尾产物落在哪里?」  (**M2 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'closure'`, `stage: 'M2'`。
 * M2 只准改本文件 + 本接缝声明的 `wiringPoints`
 * (`goal-flywheel/{run-closure,memory-layers,skill-candidate}.ts`)。
 *
 * ## 这条接缝钉住的两条冻结规则
 *
 * **规则 ③ 只有 closeRun 能关闭 Run**: 全仓只有 `goal-flywheel/run-closure.ts` 定义
 * `closeRun`, 只有 M0 接线层 (`goal-flywheel-wiring.ts`) 与**本文件**能碰它。
 *
 * **规则 ④ 所有终止路径必须经过 closeRun**: 成功 / 失败 / 中断 / 超时 / 人工暂停 /
 * 崩溃恢复 / 权限·支付·工具失败 / 子 Agent 被阻塞 —— 八类终止**都**走 `closeRunOnce`。
 *
 * ## 为什么是 `Once` (幂等)
 *
 * 真实链路上同一条 Run 会被两处看见:
 *   · Runner (pi-sdk / CLI) 自己在 Run 结束时就收尾 (它知道最细的上下文);
 *   · Supervisor 在 Runner 返回后又收一遍 (它负责 Goal 层决策)。
 * 若两边都真收, 就会写出两份 Memory / 两份候选 / 两条 closure 决策记录 —— 又是两套事实。
 * 所以收尾入口是 `closeRunOnce`: **同一条 runId 只允许收一次**, 第二次返回
 * `alreadyClosed: true` 且**不写任何东西**。幂等判据用的是既有的 closure 决策记录
 * (`.bolloon/goal-decisions/<goalId>--<runId>--closure.json`) —— **不新增存储**。
 */

import type { ContinuationDecision, GoalContinuationRecord, IsoTimestamp, UserReport, WorkReportStatus } from '../types.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const CLOSURE_SEAM_ID = 'closure' as const;

/**
 * 收尾结果的最小面。
 *
 * 刻意只带**冻结层类型** (`../types.js` 的 `ContinuationDecision` / `GoalContinuationRecord` /
 * `UserReport`): 于是接缝不必 import 接线层的 `CloseRunResult`, 也不会有循环依赖,
 * 而调用方 (Supervisor) 依然拿得到"下一步是什么"的全量决策 —— 不做有损投影。
 */
export interface ClosureOutcomeView {
  runId: string;
  goalId: string;
  /** 走过几步 (冻结面 RUN_CLOSURE_STEPS 有 9 步; 少一步 = 收尾没做完) */
  steps: number;
  /** 权威继续决策 (全量, 不是摘要) */
  decision: ContinuationDecision;
  /** 飞轮权威 continuation (写回 Goal 前的那一份) */
  continuation: GoalContinuationRecord;
  /** 用户汇报 (P4b 第一份输出) */
  userReport: UserReport;
  /** 本轮 Run 的状态 (收尾时读到的事实) */
  runStatus: WorkReportStatus | string;
  memories: number;
  candidates: number;
  reportPath: string;
  decisionRecordPath: string;
}

export interface ClosureSeamDeps {
  /** 幂等判据: 这条 Run 已经有 closure 决策记录了吗 */
  hasClosure: (goalId: string, runId: string) => Promise<boolean>;
  /** 收尾本体 (M0 接线层注入的真实现: closeRun + Memory 落盘 + 候选 + 用户汇报) */
  closeGoalRun: (input: {
    goalId: string;
    runId: string;
    now: IsoTimestamp;
    finalReview: string;
    maxRetries?: number;
  }) => Promise<ClosureOutcomeView | null>;
  /** 任务结束 → 归档过期临时记忆 (P1b: temporary 层自动过期) */
  purgeTemporary?: () => Promise<number>;
  /** 记一条审计事实 (谁在什么时候因为什么收了尾) */
  note?: (line: string) => void;
}

export interface CloseRunOnceResult {
  ok: boolean;
  /** 这次调用**没有**做事 (同一条 Run 已经收过尾) */
  alreadyClosed: boolean;
  goalId: string;
  runId: string;
  outcome: ClosureOutcomeView | null;
  reason: string;
}

export interface ClosureSeam {
  readonly id: typeof CLOSURE_SEAM_ID;
  readonly stage: 'M2';
  closeRunOnce(input: {
    goalId: string;
    runId: string;
    caller: WiringCaller;
    now: IsoTimestamp;
    finalReview?: string;
    maxRetries?: number;
  }): Promise<CloseRunOnceResult | SeamRefusal>;
}

/** 幂等标记 + 审计行 (落进既有的 closure 决策记录, 不新增存储) */
export const CLOSURE_IDEMPOTENCY_NOTE =
  '同一条 runId 只允许收一次尾: 第二次调用返回 alreadyClosed=true 且不写任何东西 '
  + '(判据 = 既有的 .bolloon/goal-decisions/<goalId>--<runId>--closure.json 是否存在)';

export function createClosureSeam(deps: ClosureSeamDeps): ClosureSeam {
  return {
    id: CLOSURE_SEAM_ID,
    stage: 'M2',
    async closeRunOnce(input) {
      if (!input.goalId || !input.runId) {
        return refuse(
          'all_terminal_paths_pass_close_run',
          `拒绝: 收尾缺少 ${!input.goalId ? 'goalId' : 'runId'} —— 说不清是哪条 Run 的收尾等于没收`,
        );
      }
      if (!input.now) {
        return refuse('all_terminal_paths_pass_close_run', '拒绝: 收尾没有时间戳 (now 必须注入, 不许读真实钟)');
      }
      if (await deps.hasClosure(input.goalId, input.runId)) {
        deps.note?.(`[closure] run=${input.runId} 已经收过尾 → 幂等短路 (caller=${input.caller})`);
        return {
          ok: true,
          alreadyClosed: true,
          goalId: input.goalId,
          runId: input.runId,
          outcome: null,
          reason: `同一条 Run 已收尾 (${input.runId}) → 不重复写: ${CLOSURE_IDEMPOTENCY_NOTE}`,
        };
      }
      const outcome = await deps.closeGoalRun({
        goalId: input.goalId,
        runId: input.runId,
        now: input.now,
        finalReview: input.finalReview ?? '',
        maxRetries: input.maxRetries,
      });
      if (!outcome) {
        return {
          ok: false,
          alreadyClosed: false,
          goalId: input.goalId,
          runId: input.runId,
          outcome: null,
          reason: `收尾做不到: 拿不到 Run 或 Goal 事实 (goal=${input.goalId} run=${input.runId}) → 不编造收尾产物`,
        };
      }
      if (deps.purgeTemporary) {
        await deps.purgeTemporary().catch(() => 0);
      }
      deps.note?.(`[closure] run=${input.runId} 收尾 ${outcome.steps} 步 → ${outcome.decision} (caller=${input.caller})`);
      return {
        ok: true,
        alreadyClosed: false,
        goalId: input.goalId,
        runId: input.runId,
        outcome,
        reason: `收尾 ${outcome.steps} 步 → ${outcome.decision}`,
      };
    },
  };
}
