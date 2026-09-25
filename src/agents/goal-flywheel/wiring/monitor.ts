/**
 * wiring/monitor.ts — 接缝 ④「有谁卡住了, 该谁动手?」  (**M3 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'monitor'`, `stage: 'M3'`。
 * M3 只准改本文件 + `wiring/contract.ts` + 声明的 `wiringPoints` (`goal-flywheel/work-monitor.ts`)。
 *
 * ## 这条接缝钉住的冻结规则
 *
 * **规则 ④ 的"子 Agent 被阻塞"那一类终止路径必须经过收尾漏斗**。
 * Watchdog 只看进程存活; 这条接缝看的是"任务卡住了没有"。它**只诊断** (`sweep`) 与
 * **按计划处理** (`handle`) 两件事, 且**永不自动绕过 Harness** ——
 * 工具/权限/预算被阻时 `planBlockHandling` 本身就不会给出 takeover。
 *
 * 阻塞升级到人 → Goal 的状态变更**不在这里直接写**, 而是交给 Goal reducer
 * (规则 ②), 由接线层在 `handle` 之后调用。本文件因此没有任何 Goal 写入面。
 */

import type { BlockRecord, BlockResolutionAction, IsoTimestamp, UserVisibleState } from '../types.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const MONITOR_SEAM_ID = 'monitor' as const;

export interface BlockHandlingView {
  actions: { workId: string; kind: string; action: BlockResolutionAction; note: string }[];
  escalated: string[];
  takeovers: string[];
  requests: string[];
}

export interface MonitorSeamDeps {
  collect: (input: { goalId: string; now?: IsoTimestamp; runnerAvailable?: boolean }) => Promise<BlockRecord[]>;
  handle: (input: { goalId: string; blocks: BlockRecord[]; now?: IsoTimestamp }) => Promise<BlockHandlingView>;
  /** 这些 Goal 上还有子 Agent 工作没回报 (有界扫描的输入) */
  goalsWithPendingWork: (limit?: number) => Promise<{ goalId: string }[]>;
}

export interface MonitorSeam {
  readonly id: typeof MONITOR_SEAM_ID;
  readonly stage: 'M3';
  /** 只诊断: 读盘上的待回报工作 → BlockRecord[] (不改任何状态) */
  sweep(input: { goalId: string; caller: WiringCaller; now?: IsoTimestamp; runnerAvailable?: boolean }): Promise<BlockRecord[] | SeamRefusal>;
  /** 按计划处理 (接管 / 升级 / 要求补齐) —— 副作用由接线层执行 */
  handle(input: { goalId: string; blocks: BlockRecord[]; caller: WiringCaller; now?: IsoTimestamp }): Promise<BlockHandlingView | SeamRefusal>;
  /** 哪些 Goal 上有子 Agent 工作待回报 */
  pendingGoals(limit?: number): Promise<{ goalId: string }[]>;
}

export function createMonitorSeam(deps: MonitorSeamDeps): MonitorSeam {
  return {
    id: MONITOR_SEAM_ID,
    stage: 'M3',
    async sweep(input) {
      if (!input.goalId) {
        return refuse('all_terminal_paths_pass_close_run', '拒绝: 阻塞巡检没有 goalId → 拿到的是"谁都不卡"的假结论');
      }
      return deps.collect({ goalId: input.goalId, now: input.now, runnerAvailable: input.runnerAvailable });
    },
    async handle(input) {
      if (!input.blocks?.length) return { actions: [], escalated: [], takeovers: [], requests: [] };
      return deps.handle({ goalId: input.goalId, blocks: input.blocks, now: input.now });
    },
    pendingGoals(limit) {
      return deps.goalsWithPendingWork(limit);
    },
  };
}

/** 用户可见态只走这里 (内部词 lease/reducer/retry counter/worker owner 永不出现) */
export interface VisibleStateSeamDeps {
  visible: (input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown; now?: IsoTimestamp }) => Promise<UserVisibleState>;
}

export function createVisibleStateProbe(deps: VisibleStateSeamDeps) {
  return async (input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown; now?: IsoTimestamp }): Promise<UserVisibleState> => {
    return deps.visible(input);
  };
}
