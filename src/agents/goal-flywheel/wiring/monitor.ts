/**
 * wiring/monitor.ts — 接缝 ④「有谁卡住了, 该谁动手?」  (**M3 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'monitor'`, `stage: 'M3'`。
 * M3 只准改本文件 + `wiring/contract.ts` + 声明的 `wiringPoints` (`goal-flywheel/work-monitor.ts`)。
 *
 * ## 这条接缝钉住的冻结规则
 *
 * **规则 ④ 的"子 Agent 被阻塞"那一类终止路径必须经过收尾漏斗**。
 * Watchdog 只看进程存活; 这条接缝看的是"任务卡住了没有"。它只做三件事:
 *   ① **统一巡检** (`sweepAll` / `sweep`): 一次把**所有**待回报 Goal 的阻塞查清楚 (有界, 不静默);
 *   ② **按计划处理** (`handle`): 处置动作交给宿主执行 —— 接缝自己**永不自动绕过 Harness**;
 *   ③ **用户可见态** (`visibleState` / `createVisibleStateProbe`): 只暴露冻结层的闭集, 内部词不外泄。
 *
 * 阻塞升级到人 → Goal 的状态变更**不在这里直接写**, 而是交给 Goal reducer
 * (规则 ②), 由接线层在 `handle` 之后调用。本文件因此没有任何 Goal 写入面。
 *
 * ## M3 的两处深化 (为什么不是"又一个透传壳")
 *
 *   1. **统一监控**: 真实 tick 里"逐个 Goal 巡检"是散在各处的循环 (`execution-supervisor.ts` 那段
 *      `listGoalsWithPendingWork` → `collectWorkBlocks` → `applyBlockHandling`)。`sweepAll` 把这条循环
 *      收成**一次调用**: 有界扫描 + 每个 Goal 一份结论 + **失败必须留痕** (`errors[]`),
 *      不许"某个 Goal 巡检抛错 → 这一轮当它不存在"。
 *   2. **用户只看到闭集**: `createVisibleStateProbe` 以前是**裸透传** (`return deps.visible(input)`),
 *      端口给什么就往外说什么 —— 于是"用户视野只有这几类"只是端口自觉。现在它**逐值校验闭集**
 *      (`USER_VISIBLE_STATES`), 闭集外的值 / 端口抛错一律**拒绝**并说清原因, 而不是把内部词
 *      顺手暴露给用户。
 *
 * ### 五类还是六类 (如实说明, 不改冻结层)
 *
 * 设计稿 §8 写的是"用户可见只暴露**五类**": 正在执行 / 等待外部回复 / 子 Agent 被阻塞 /
 * 暂时没有进展 / 需要你决定。冻结层 (`types.ts`) 在 2026-09-25 接线时**追加了第 6 类** `ended`
 * (理由: 前五类里没有"已结束", 已结束的目标只能借用 `executing` 或 `needs_your_decision`,
 * 那正是 P3/P4 要防的假象)。改冻结层要单独一个提交 + 更新类型计数门, **不归 M3**。
 * 所以本接缝按**冻结闭集** (五类 + `ended`) 钉住: 断言"返回值只能是闭集里的值"是硬的,
 * 断言"闭集有几个值"留给冻结层 (`goal-flywheel-types.test.ts` 的计数门)。
 */

import {
  USER_VISIBLE_STATES,
  USER_VISIBLE_STATE_LABELS,
} from '../types.js';
import type {
  BlockRecord,
  BlockResolutionAction,
  ContinuationDecision,
  GoalContinuationRecord,
  IsoTimestamp,
  UserVisibleState,
} from '../types.js';
// 自己那个阶段的实现模块 (P3, 纯函数): "用户该看到哪一类"的判定只有一份
import { toUserVisibleState } from '../work-monitor.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const MONITOR_SEAM_ID = 'monitor' as const;

export interface BlockHandlingView {
  actions: { workId: string; kind: string; action: BlockResolutionAction; note: string }[];
  escalated: string[];
  takeovers: string[];
  requests: string[];
}

/** 统一巡检里**单个 Goal** 的结论 (巡检失败也占一格 —— 不许静默消失) */
export interface MonitoredGoal {
  goalId: string;
  blocks: BlockRecord[];
  handling: BlockHandlingView | null;
  /** 该 Goal 的用户可见态 (没有可见面端口时为 null) */
  visibleState: UserVisibleState | null;
  /** 巡检这个 Goal 时的错误原文 (成功时为 null) */
  error: string | null;
}

/** 一次统一巡检的全部结论 */
export interface MonitorTickView {
  goals: MonitoredGoal[];
  /** 本条 tick 里收到的阻塞条数 (跨 Goal 求和) */
  blockCount: number;
  /** 需要人 / 上游动手的项 (交人 + 接管, 与 `handle` 的口径一致) */
  escalated: string[];
  takeovers: string[];
  requests: string[];
  /** 各用户可见态命中几回 (只含闭集里的键) */
  visibleCounts: Partial<Record<UserVisibleState, number>>;
  /** 巡检失败的 Goal (原文; 空数组 = 这一轮没有失败) */
  errors: string[];
  /**
   * 自检位: 有 Goal 待巡检, 但**一个都没查成**且**一条错误都没记** ⇒ 静默 (维护者必须知道)。
   * 正常实现下这是 false; 它为 true 说明本函数有 bug。
   */
  silentRisk: boolean;
}

export interface VisibleStateView {
  state: UserVisibleState;
  /** 用户看到的中文 (来自冻结层的文案表) */
  zh: string;
  /** 用户看到的英文 */
  en: string;
}

export interface MonitorSeamDeps {
  collect: (input: { goalId: string; now?: IsoTimestamp; runnerAvailable?: boolean }) => Promise<BlockRecord[]>;
  handle: (input: { goalId: string; blocks: BlockRecord[]; now?: IsoTimestamp }) => Promise<BlockHandlingView>;
  /** 这些 Goal 上还有子 Agent 工作没回报 (有界扫描的输入) */
  goalsWithPendingWork: (limit?: number) => Promise<{ goalId: string }[]>;
  /** 用户可见面 (可选; 缺了 `visibleState` 会如实拒绝, 不编一个状态出来) */
  visible?: (input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown; now?: IsoTimestamp }) => Promise<UserVisibleState>;
  /**
   * 该 Goal 的**权威 continuation** (可选; 与 `visible` 二选一)。
   *
   * 给了它, 接缝就用真 P3 的 `toUserVisibleState` 自己算用户可见态 —— 宿主不必再实现一遍,
   * 也就不会出现"界面自己拼一套状态"的第二份事实。没给且没有 `visible` ⇒ 可见态如实拒绝。
   */
  continuationOf?: (goalId: string) => Promise<GoalContinuationRecord | null>;
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
  /** **统一监控** (M3): 一次巡检所有待回报 Goal (有界 + 失败留痕) */
  sweepAll(input: { caller: WiringCaller; now?: IsoTimestamp; runnerAvailable?: boolean; limit?: number }): Promise<MonitorTickView | SeamRefusal>;
  /** 用户可见态 (**闭集校验后的值**; 内部词不外泄) */
  visibleState(input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown; now?: IsoTimestamp }): Promise<UserVisibleState | SeamRefusal>;
}

/** 统一巡检的默认/上限 (有界: 不许在 tick 里无界扫盘) */
export const MONITOR_SWEEP_DEFAULT_LIMIT = 20;
export const MONITOR_SWEEP_MAX_LIMIT = 200;

function errText(e: unknown): string {
  return String((e as Error)?.message || e).slice(0, 300);
}

// ============================================================================
// §1. 用户可见面: 闭集校验 + 内部词扫描 (纯函数, 可被门/变异验证复用)
// ============================================================================

/**
 * 一个 continuation 决策是否长得像 `ContinuationDecision` (只做形状检查, 不猜内容)。
 * 用它把 `decision?: unknown` 安全地喂给真 P3 判定: 不像就传 null (宁可少一层精化, 不许瞎 cast)。
 */
function isDecisionLike(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const d = x as { decision?: unknown; state?: unknown };
  return typeof d.decision === 'string' || typeof d.state === 'string';
}

/** 用户可见态的**闭集** (冻结层唯一事实来源; 本文件不另立一份) */
export const USER_FACING_STATES: readonly UserVisibleState[] = USER_VISIBLE_STATES;

export function isUserVisibleState(x: unknown): x is UserVisibleState {
  return typeof x === 'string' && (USER_FACING_STATES as readonly string[]).includes(x);
}

/**
 * **不该出现在用户视野里**的内部词 (设计 §8 的名单 + 同义写法)。
 *
 * 为什么连 `retry_count` / `leaseOwner` 这种代码标识也扫: 界面拼字符串时最常干的事就是
 * 把内部字段名顺手带出去 (`lease owner=worker-3`), 只扫中文词会漏掉这一类。
 */
export const INTERNAL_VISIBLE_WORDS: readonly string[] = [
  'lease',
  'leaseOwner',
  'lease_until',
  'reducer',
  'internal status',
  'retry counter',
  'retryCounter',
  'retry_count',
  'worker owner',
  'workerOwner',
  'attempts',
  '抢租约',
  '租约',
  '内部状态',
  '重试计数',
] as const;

/** 扫出文本里出现的内部词 (空数组 = 干净)。大小写不敏感; 只报词, 不改文本。 */
export function scanInternalLeak(text: string): string[] {
  const s = String(text ?? '');
  if (!s) return [];
  const lower = s.toLowerCase();
  const hits: string[] = [];
  for (const w of INTERNAL_VISIBLE_WORDS) {
    if (lower.includes(w.toLowerCase())) hits.push(w);
  }
  return hits;
}

/** 闭集里的一个状态 → 用户看到的**全部**内容 (只有这三样, 没有内部字段) */
export function userFacingState(state: unknown): VisibleStateView | SeamRefusal {
  if (!isUserVisibleState(state)) {
    return refuse(
      'only_supervisor_decides_continuation',
      `拒绝: 用户可见态 ${JSON.stringify(state) ?? String(state)} 不在冻结闭集里 `
      + `(${USER_FACING_STATES.join(' / ')}) —— 用户可见态是 continuation 的投影, 不许第三方编一个状态出来`,
    );
  }
  const labels = USER_VISIBLE_STATE_LABELS[state];
  return { state, zh: labels.zh, en: labels.en };
}

// ============================================================================
// §2. 接缝本体
// ============================================================================

export function createMonitorSeam(deps: MonitorSeamDeps): MonitorSeam {
  // 可见面来源: 宿主注入的 `visible` 优先; 否则用**真 P3** 的判定 (注入的 continuation 是它的输入)。
  // 两条路都不通 ⇒ 探针会如实拒绝 (不编一个"正在执行")。
  const visiblePort = deps.visible ?? (deps.continuationOf
    ? async (input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown }): Promise<UserVisibleState> => {
      const raw = await deps.continuationOf!(input.goalId);
      // 盘上的 continuation 允许缺字段 (goal-store 的 `pendingReports?` 是 optional) ——
      // 探针不许因为"少一个字段"就崩, 缺的按"没有"补 (与 goal-store 的 continuationView 同一口径)。
      const continuation: GoalContinuationRecord | null = raw
        ? { ...raw, pendingReports: raw.pendingReports ?? [], unresolvedItems: raw.unresolvedItems ?? [] }
        : null;
      const decision = isDecisionLike(input.decision) ? input.decision as ContinuationDecision : null;
      return toUserVisibleState(continuation, input.blocks ?? [], decision);
    }
    : undefined);
  const visibleOrRefuse = createVisibleStateProbe({ visible: visiblePort });

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

    /**
     * 统一监控 (M3): 一次调用 = 所有待回报 Goal 的阻塞结论。
     *
     * 纪律:
     *   · **子 Agent 不许巡检别人的阻塞**: `caller='child_agent'` → 拒 (规则 ⑤, 一条都不查);
     *   · **有界**: `limit` 夹在 [1, 200] (默认 20) —— tick 里扫盘不许无界;
     *   · **不静默**: 单个 Goal 巡检/处置抛错 → 该 Goal 的 `error` 与顶层 `errors[]` 都留痕,
     *     而不是"这一轮它不存在"。全失败时 `silentRisk=true` 并要求交人;
     *   · 没有阻塞的 Goal **也占一格** (它有待回报工作 → 用户看到的是"等待外部回复", 不是"没人管")。
     */
    async sweepAll(input) {
      if (input.caller === 'child_agent') {
        return refuse(
          'child_cannot_mutate_goal',
          '拒绝: 子 Agent 不许巡检/处置其它执行者的阻塞 —— 巡检与处置是父/调度器的责任面',
        );
      }
      const limit = Math.min(Math.max(Math.floor(input.limit ?? MONITOR_SWEEP_DEFAULT_LIMIT) || 1, 1), MONITOR_SWEEP_MAX_LIMIT);
      const view: MonitorTickView = {
        goals: [], blockCount: 0, escalated: [], takeovers: [], requests: [],
        visibleCounts: {}, errors: [], silentRisk: false,
      };

      let pending: { goalId: string }[] = [];
      try {
        const raw = await deps.goalsWithPendingWork(limit);
        pending = Array.isArray(raw) ? raw.filter((g) => !!g?.goalId).slice(0, limit) : [];
        if (!Array.isArray(raw)) view.errors.push('待回报 Goal 清单不是数组 (宿主 bug) —— 无法巡检, 不许当成"没有阻塞"');
      } catch (e) {
        view.errors.push(`取待回报 Goal 清单失败: ${errText(e)}`);
        view.silentRisk = true;
        return view; // 拿不到事实就如实报 (不是"巡检过了, 没问题")
      }

      for (const g of pending) {
        const cell: MonitoredGoal = { goalId: g.goalId, blocks: [], handling: null, visibleState: null, error: null };
        try {
          const blocks = await deps.collect({ goalId: g.goalId, now: input.now, runnerAvailable: input.runnerAvailable });
          cell.blocks = Array.isArray(blocks) ? blocks : [];
          if (cell.blocks.length > 0) {
            cell.handling = await deps.handle({ goalId: g.goalId, blocks: cell.blocks, now: input.now });
            view.escalated.push(...(cell.handling?.escalated ?? []));
            view.takeovers.push(...(cell.handling?.takeovers ?? []));
            view.requests.push(...(cell.handling?.requests ?? []));
          }
          const vis = await visibleOrRefuse({ goalId: g.goalId, blocks: cell.blocks, now: input.now });
          if (vis && typeof vis === 'object' && (vis as SeamRefusal).ok === false) {
            // 可见面拒绝 → 这一格如实留痕 (不是静默给个"正在执行")
            cell.error = (vis as SeamRefusal).reason;
            view.errors.push(`goal=${g.goalId} 可见态: ${(vis as SeamRefusal).reason}`);
          } else if (vis) {
            cell.visibleState = vis as UserVisibleState;
            view.visibleCounts[cell.visibleState] = (view.visibleCounts[cell.visibleState] ?? 0) + 1;
          }
          view.blockCount += cell.blocks.length;
        } catch (e) {
          cell.error = errText(e);
          view.errors.push(`goal=${g.goalId} 巡检失败: ${cell.error}`);
        }
        view.goals.push(cell);
      }

      const inspected = view.goals.filter((c) => c.error === null).length;
      if (pending.length > 0 && inspected === 0) {
        view.silentRisk = true;
        view.escalated.push(...pending.map((g) => `巡检未完成: ${g.goalId}`));
      }
      return view;
    },

    async visibleState(input) {
      return visibleOrRefuse({ goalId: input.goalId, blocks: input.blocks, decision: input.decision, now: input.now });
    },
  };
}

// ============================================================================
// §3. 用户可见面探针 (M3 硬化: 逐值校验闭集, 不再裸透传)
// ============================================================================

export interface VisibleStateSeamDeps {
  visible?: (input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown; now?: IsoTimestamp }) => Promise<UserVisibleState>;
}

/**
 * 用户可见态探针: 只回答"用户该看到哪一类", 且**只**能是冻结闭集里的值。
 *
 * 硬化的三件事 (旧版是 `return deps.visible(input)` 的裸透传):
 *   ① **闭集校验**: 端口给出闭集外的值 (或 undefined / null / 对象) → 拒绝 + 说清收到了什么 ——
 *      用户视野的假象比"什么都不显示"更贵;
 *   ② **端口抛错不吞**: 原文进拒绝理由 (不静默降级成 `executing`);
 *   ③ **缺端口 = 拒**: 没有可见面来源就不编一个状态 (旧版会直接 `TypeError`)。
 *
 * 返回值用冻结类型 + `userFacingState` 的文案; 调用方拿到的就是用户看到的东西。
 */
export function createVisibleStateProbe(deps: VisibleStateSeamDeps) {
  return async (input: { goalId: string; blocks?: BlockRecord[]; decision?: unknown; now?: IsoTimestamp }): Promise<UserVisibleState | SeamRefusal> => {
    if (typeof deps.visible !== 'function') {
      return refuse(
        'only_supervisor_decides_continuation',
        '拒绝: 没有注入用户可见面 (拿不到权威 continuation 的投影) —— 不许编一个状态给用户',
      );
    }
    let raw: unknown;
    try {
      raw = await deps.visible(input);
    } catch (e) {
      return refuse(
        'only_supervisor_decides_continuation',
        `拒绝: 用户可见面抛错 (${errText(e)}) —— 不静默降级成"正在执行"`,
      );
    }
    const view = userFacingState(raw);
    if ((view as SeamRefusal).ok === false) return view as SeamRefusal;
    return (view as VisibleStateView).state;
  };
}

/**
 * 给界面用的**唯一**文案出口: 状态 → `{state, zh, en}` (闭集外的值直接拒绝)。
 * 界面不许自己拼状态名, 也不许把内部字段带出去 (见 `scanInternalLeak`)。
 */
export function describeVisibleState(state: unknown): VisibleStateView | SeamRefusal {
  return userFacingState(state);
}
