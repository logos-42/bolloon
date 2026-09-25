/**
 * wiring/change.ts — 接缝 ⑤「人中途改了什么要求, 用户该看到哪一类状态?」  (**M4 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'change'`, `stage: 'M4'`。
 * M4 只准改本文件 + 声明的 `wiringPoints` (`goal-flywheel/goal-change.ts` · `web/server.ts`)。
 *
 * ## 这条接缝钉住的两条纪律
 *
 * **规则 ⑤ 子 Agent 不能直接改 Goal** (在变更域里的投影): 只有 `user` 能提**撤销**类变更。
 * `instrumentChange()` 对 `changeKind: 'abort' | 'scope_reduction'` 要求 `source === 'user'`,
 * 否则拒绝 —— Agent 不许因为"执行起来方便"就替人撤销意图 (设计稿「意图的落位」纪律 2)。
 *
 * **规则 ④ 的"人中途注入新要求 → 下一 Run 生效"**: 变更记录里必须能回答
 * "它被第几个 Run 读到了" (`consumedByRunIndex`), 且**当前 Run 的历史不被改写**。
 *
 * 这条接缝**不写 Goal 状态**: 用户可见态是**读**出来的 (`UserVisibleState` 六类),
 * 变更生效引出的状态变化交给 Goal reducer (规则 ②)。
 */

import type { ChangeSource, GoalChangeRequest, IsoTimestamp, UserVisibleState } from '../types.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const CHANGE_SEAM_ID = 'change' as const;

/** 只有人能做"撤销/缩范围"这类动作 */
export const USER_ONLY_CHANGE_KINDS = ['abort', 'scope_reduction'] as const;

export interface ChangeIngestInput {
  goalId: string;
  instruction: string;
  source: ChangeSource;
  recordedBy: string;
  now: IsoTimestamp;
  /** 子 Agent 提的变更只影响它自己的范围 (设计稿规则 5: 子必须收到新版本) */
  workId?: string | null;
}

export interface ChangeIngestView {
  request: GoalChangeRequest;
  /** 变更分类结论 (是否影响判据/预算/权限) */
  classification: unknown;
  /** 应用结论: next_run / pending_approval / rejected */
  application: unknown;
  /** 原话逐字留痕 (mustNotRewriteUserWords: 返回的 instruction 必须与输入一字不差) */
  instructionVerbatim: string;
}

export interface ChangeSeamDeps {
  ingest: (input: ChangeIngestInput) => Promise<{ request: GoalChangeRequest; classification: unknown; application: unknown }>;
  /** 下一个 Run 要带上的变更指令 (没有生效变更时 null, 不编) */
  nextRunDirective: (goalId: string) => Promise<string | null>;
  /** 记账: 变更被第几个 Run 读到 */
  markConsumed: (goalId: string, runIndex: number, now: IsoTimestamp) => Promise<void>;
  visibleState: (input: { goalId: string; now?: IsoTimestamp }) => Promise<UserVisibleState>;
  /** 待批准/待生效的变更 (界面要能说清"你在等什么") */
  pending: (goalId: string) => Promise<GoalChangeRequest[]>;
}

export interface ChangeSeam {
  readonly id: typeof CHANGE_SEAM_ID;
  readonly stage: 'M4';
  ingestChange(input: ChangeIngestInput & { caller: WiringCaller }): Promise<ChangeIngestView | SeamRefusal>;
  nextRunDirective(goalId: string): Promise<string | null>;
  markConsumed(goalId: string, runIndex: number, now: IsoTimestamp): Promise<void>;
  visibleState(input: { goalId: string; caller?: WiringCaller; now?: IsoTimestamp }): Promise<UserVisibleState>;
  pendingChanges(goalId: string): Promise<GoalChangeRequest[]>;
}

export function createChangeSeam(deps: ChangeSeamDeps): ChangeSeam {
  return {
    id: CHANGE_SEAM_ID,
    stage: 'M4',
    async ingestChange(input) {
      const raw = String(input.instruction ?? '');
      if (!raw.trim()) {
        return refuse('child_cannot_mutate_goal', '拒绝: 变更没有原文 —— 不许用一句"理解"代替人说过的话');
      }
      const isUserOnly = USER_ONLY_CHANGE_KINDS.some((k) => raw.includes(k === 'abort' ? '撤销' : '缩小范围') || raw.includes(k));
      if (isUserOnly && input.source !== 'user') {
        return refuse(
          'only_goal_reducer_changes_goal_state',
          `拒绝: ${input.source} 想提"撤销/缩范围"类变更 —— 只有人能撤销意图 (设计稿「意图的落位」纪律 2)`,
        );
      }
      const out = await deps.ingest({ ...input, instruction: raw });
      if (out.request.instruction !== raw) {
        // 原话必须逐字入档: 被改写过的"原话"不是证据
        return refuse('child_cannot_mutate_goal', '拒绝: 变更记录里的 instruction 与用户原话不一致 (原话必须逐字入档)');
      }
      return { request: out.request, classification: out.classification, application: out.application, instructionVerbatim: raw };
    },
    nextRunDirective(goalId) {
      return deps.nextRunDirective(goalId);
    },
    markConsumed(goalId, runIndex, now) {
      return deps.markConsumed(goalId, runIndex, now);
    },
    visibleState(input) {
      return deps.visibleState({ goalId: input.goalId, now: input.now });
    },
    pendingChanges(goalId) {
      return deps.pending(goalId);
    },
  };
}
