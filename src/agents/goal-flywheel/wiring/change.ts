/**
 * wiring/change.ts — 接缝 ⑤「人中途改了什么要求, 用户该看到哪一类状态?」  (**M4 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'change'`, `stage: 'M4'`。
 * M4 只准改本文件 + 声明的 `wiringPoints` (`goal-flywheel/goal-change.ts` · `web/server.ts`)。
 *
 * ## 这条接缝要回答的四件事 (以前只回答第四件)
 *
 * ```
 * 用户/外部在目标**跑着的时候**提要求
 *   ① 原话逐字入档了吗?          → 没原文 / 被改写过 → 拒绝 (原话就是证据)
 *   ② 在跑的这一轮怎么办?        → 撤销 = 停; 其余 = 让这一轮跑完, 只影响后续 Run (规则 4)
 *   ③ 在跑的子 Agent 怎么办?     → 规则 5: 逐 workId 一份下发内容, 必须先 ack 再继续
 *   ④ 用户该看到哪一类状态?      → 有待决定的变更 → `needs_your_decision` (只升不降)
 * ```
 *
 * ## 为什么"在跑的 Run 要停"这件事归这条接缝
 *
 * 用户撤销的语义是"别再继续了"。撤销落到 Goal 上 (`abandoned`) 之后, **在飞的 Run 并不会自己
 * 发现** —— 执行器只在每一轮循环开头读一次自己 Run 记录的状态 (`paused` / `aborted` 就自行停下,
 * 轮内不打断)。所以"停"必须由**注入变更的那一方**写进 Run 记录: 除了这条接缝, 没有第二个人
 * 知道"用户刚刚撤销了"。写状态用的是**既有的外部控制面原语**(与 `POST /api/runs/:id/abort`
 * 同一条路), 不是新造一条停止通道 —— 否则就是第二套事实。
 *
 * ## 两条边界 (接缝的自律)
 *
 * · **判定在 `goal-change.ts` (纯函数), 副作用在接线层** —— 接缝自己不读盘/不写盘/不读钟:
 *   "在跑的 Run 是谁"由宿主注入 (`runningRun`), "怎么停"由宿主注入 (`stopRunningRun`)。
 *   宿主没注入 → 接缝返回 `stopped: false` + 结构化原因, **绝不假装停过** (也不偷偷放行)。
 * · **只升不降**: 变更对用户可见态的影响只有"抬成 `needs_your_decision`"这一种, 绝不把
 *   `ended` / `child_blocked` / `no_progress` 降级成"正在执行"。已结束的目标上, 待批的变更
 *   已经没有生效对象 → 不许把 `ended` 抬成"需要你决定"。
 */

import { nextStatusFor, planChangeInjection, userOnlyChangeKind } from '../goal-change.js';
import type {
  ChangeApplication,
  ChangeInjectionPlan,
  ChildChangeDirective,
} from '../goal-change.js';
import type { ChangeKind, ChangeSource, GoalChangeRequest, IsoTimestamp, UserVisibleState } from '../types.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const CHANGE_SEAM_ID = 'change' as const;

/** 只有人能做"撤销/缩范围"这类动作 */
export const USER_ONLY_CHANGE_KINDS = ['abort', 'scope_reduction'] as const;

/** `applyChange` 的三个 outcome (宿主返回别的值 = 接线坏了, 抛错而不是当没看见) */
export const CHANGE_OUTCOMES = ['next_run', 'pending_approval', 'rejected'] as const;

/** 变更记录状态里"还在等一个人拍板"的那些 → 用户可见态必须说"需要你决定" */
export const DECISION_PENDING_STATUSES = ['needs_approval', 'triaged'] as const;

// ────────────────────────────────────────────────────────────────────────────
// 正在运行的 Goal: 事实 / 判定 / 执行结果
// ────────────────────────────────────────────────────────────────────────────

export interface RunningRunFact {
  runId: string;
  /** Run 记录里的状态原文 (接缝不猜; `queued`/`running`/`recovering` 才算在跑) */
  status: string;
}

export type StopRunStatus = 'paused' | 'aborted';

/** 让 Run 停下来的请求 (写进 Run 记录 = 既有外部控制面语义) */
export interface RunStopRequest {
  goalId: string;
  runId: string;
  runStatus: StopRunStatus;
  reason: string;
  now: IsoTimestamp;
}

/** 宿主注入的"停 Run"执行器 (真实现 = 既有的 `setRunStatus` 原语) */
export type StopRunningRun = (i: RunStopRequest) => Promise<{ ok: boolean; reason: string }>;

export interface RunBoundaryOutcome {
  action: 'let_finish' | 'stop_running_run';
  /** "停"是否**真的**落到了 Run 记录上 (未接线 / 迁移被拒 / 计划本来不需要 → false + 原因) */
  stopped: boolean;
  runId: string | null;
  runStatus: StopRunStatus | null;
  reason: string;
}

/** 规则 5 的下发事实 (逐 workId 一份; 要不要先补全影响面) */
export interface ChildEditionDelivery {
  directives: ChildChangeDirective[];
  workIds: string[];
  /** 有在跑的子 Agent, 但变更记录没点明影响面 → 下发前必须先补全 (`scopeChangeToWork`) */
  scopeMissing: boolean;
  /** 影响面没补全 → 下发被卡住 (不许把"不知道该发给谁"当成"没有要发的") */
  blocked: boolean;
  mustAck: true;
  note: string;
}

export interface ChangeIngestInput {
  goalId: string;
  instruction: string;
  source: ChangeSource;
  recordedBy: string;
  now: IsoTimestamp;
  /** 子 Agent 提的变更只影响它自己的范围 (设计稿规则 5: 子必须收到新版本) */
  workId?: string | null;
  /** 宿主已读到的"在跑 Run"事实; `undefined` = 宿主不知道 (会如实标 factsMissing, 不猜) */
  runningRun?: RunningRunFact | null;
  /** 在跑的子 Agent (已签合同还没回报的 workId) */
  liveWorkIds?: readonly string[];
}

export interface ChangeIngestView {
  request: GoalChangeRequest;
  /**
   * 生效判定。M0 的接线里 `classification` 与 `application` 是同一份判定 (入档模块把
   * `applyChange` 的结论一起返回), 这里两个字段都保留 —— 老读者不改, 新读者用 `plan`。
   */
  classification: ChangeApplication;
  application: ChangeApplication;
  /** 原话逐字留痕 (mustNotRewriteUserWords: 返回的 instruction 必须与输入一字不差) */
  instructionVerbatim: string;
  /** ★ M4 的核心产出: 变更对**正在跑的这一轮**意味着什么 */
  plan: ChangeInjectionPlan;
  /** "停 Run"的实际结果 (未接线 → stopped:false + 原因, 不假装) */
  runBoundary: RunBoundaryOutcome;
  /** 规则 5: 逐 workId 的下发内容 */
  childDelivery: ChildEditionDelivery;
  /**
   * 用户该看到的态 (已含"待决定的变更 → 需要你决定"的覆盖)。
   * `null` = **基础态读不到** —— 不编一个态出来 ("读不到" != "正在执行"; 见 `visibleReason`)。
   */
  visibleState: UserVisibleState | null;
  visibleReason: string;
  /** 一个 `kind` 装不下多个意图 → 已入档但不生效, 需人拆开重提 */
  needsDisambiguation: boolean;
}

export interface ChangeSeamDeps {
  ingest: (input: ChangeIngestInput) => Promise<{
    request: GoalChangeRequest;
    classification: ChangeApplication;
    application: ChangeApplication;
  }>;
  /** 下一个 Run 要带上的变更指令 (没有生效变更时 null, 不编) */
  nextRunDirective: (goalId: string) => Promise<string | null>;
  /** 记账: 变更被第几个 Run 读到 */
  markConsumed: (goalId: string, runIndex: number, now: IsoTimestamp) => Promise<void>;
  visibleState: (input: { goalId: string; now?: IsoTimestamp }) => Promise<UserVisibleState>;
  /** 待批准/待生效的变更 (界面要能说清"你在等什么") */
  pending: (goalId: string) => Promise<GoalChangeRequest[]>;
  /**
   * 在跑的 Run 的事实 (宿主注入)。没注入 → 接缝拿不到 → `plan.runBoundary.factsMissing = true`。
   * 2026-09-25 (串行收口): **M0 已注入** (`flywheelSeams()` 读 Goal 上当前在跑的 Run)。
   * `src/web/server.ts` 的 requirement 路由仍按参数传入 (当场读到的事实优先, 见 `resolveRunningRun`)。
   */
  runningRun?: (goalId: string) => Promise<RunningRunFact | null>;
  /** 把"停"落到 Run 记录上的执行器 (没注入 → 接缝返回 stopped:false, 不假装停过) */
  stopRunningRun?: StopRunningRun;
  /**
   * 在跑的子 Agent 工作 (规则 5 的下发对象)。
   *
   * 没注入且调用方也没传 → `liveWorkIds` 为空 → 计划会说"没有在跑的子 Agent 需要下发"。
   * **那是假结论**: 父 Goal 上明明登记着待回报的 workId。所以 M0 注入了这份事实
   * (`goal.continuation.pendingReports`), 非 web 宿主 (CLI / supervisor / 恢复脚本) 不必自己记得传。
   * 调用方当场传入的值优先 (与 `runningRun` 同一优先级规则)。
   */
  liveWorkIds?: (goalId: string) => Promise<readonly string[]>;
}

export interface ChangeSeam {
  readonly id: typeof CHANGE_SEAM_ID;
  readonly stage: 'M4';
  ingestChange(input: ChangeIngestInput & { caller: WiringCaller }): Promise<ChangeIngestView | SeamRefusal>;
  /** 按计划把边界动作落到在跑的 Run 上 (计划来自 `ingestChange` 的 `plan`; 执行器可当场注入) */
  applyRunBoundary(input: { plan: ChangeInjectionPlan; now: IsoTimestamp; stop?: StopRunningRun }): Promise<RunBoundaryOutcome>;
  nextRunDirective(goalId: string): Promise<string | null>;
  markConsumed(goalId: string, runIndex: number, now: IsoTimestamp): Promise<void>;
  visibleState(input: { goalId: string; caller?: WiringCaller; now?: IsoTimestamp }): Promise<UserVisibleState | null>;
  pendingChanges(goalId: string): Promise<GoalChangeRequest[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// 纯函数: 变更驱动的用户可见态 (界面与接缝共用同一份判据)
// ────────────────────────────────────────────────────────────────────────────

export interface ChangeVisibleOverride {
  /** `null` = 基础态读不到且没有待拍板的变更 → 不断言 (绝不把"读不到"说成"正在执行") */
  state: UserVisibleState | null;
  /** 是否被变更抬成了"需要你决定" (false = 原样返回) */
  elevated: boolean;
  reason: string;
}

/**
 * 变更驱动的用户可见态覆盖 —— **只升不降**。
 *
 * 为什么必须有这一条: 目标在跑 (`executing`) 时用户提了一条"要加权限"的要求, 它被正确判成
 * `needs_approval` 等待人批准 —— 但界面上仍然是"正在执行", 于是没有人知道这里有东西卡在
 * 等人。设计稿 §8 的第五类状态 (`needs_your_decision`) 正是为这一刻存在的。
 *
 * 不覆盖的情形也有理由: `ended` (目标已结束, 待批的变更已经没有生效对象)。
 * `base === null` = 基础态**读不到**: 有待拍板的变更时仍抬成"需要你决定" (有人必须看一眼这件事
 * 与基础态无关); 没有待拍板的变更时返回 `null` —— 不编一个态出来。
 */
export function changeVisibleState(input: {
  base: UserVisibleState | null;
  changes: readonly { changeId: string; kind: ChangeKind | string; status: string }[];
}): ChangeVisibleOverride {
  const waiting = input.changes.filter((c) => (DECISION_PENDING_STATUSES as readonly string[]).includes(String(c.status)));
  if (waiting.length === 0) {
    return {
      state: input.base,
      elevated: false,
      reason: input.base === null
        ? '基础可见态读不到, 且没有等拍板的变更 → 不断言 (不把"读不到"说成"正在执行")'
        : '没有等拍板的变更 → 用户可见态不变',
    };
  }
  const ids = waiting.map((c) => c.changeId).slice(0, 3).join(', ');
  if (input.base === 'ended') {
    return {
      state: 'ended',
      elevated: false,
      reason: `目标已结束 → 不把 ${waiting.length} 条变更 (${ids}) 抬成"需要你决定" (已结束的目标上没有生效对象)`,
    };
  }
  if (input.base === 'needs_your_decision') {
    return {
      state: 'needs_your_decision',
      elevated: false,
      reason: `本来就是"需要你决定", 另等 ${waiting.length} 条变更拍板 (${ids})`,
    };
  }
  return {
    state: 'needs_your_decision',
    elevated: true,
    reason: `${waiting.length} 条变更等你决定 (${ids}) → 覆盖 "${input.base ?? '读不到的基础态'}" `
      + '(否则界面会一直显示"正在执行", 没人知道有东西在等人)',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 接缝实例
// ────────────────────────────────────────────────────────────────────────────

/** 在跑的 Run 的事实: 宿主当场传入 > 依赖注入 > 不知道 (undefined) */
async function resolveRunningRun(
  deps: ChangeSeamDeps,
  input: Pick<ChangeIngestInput, 'goalId' | 'runningRun'>,
): Promise<RunningRunFact | null | undefined> {
  if (input.runningRun !== undefined) return input.runningRun;
  if (!deps.runningRun) return undefined;
  try {
    return await deps.runningRun(input.goalId);
  } catch {
    // 探测失败 = 事实缺失 (不是"没有在跑的 Run"): 上层拿到 factsMissing 后不做任何断言
    return undefined;
  }
}

/**
 * 在跑的子 Agent 工作的事实: 调用方当场传入 > 依赖注入 > 没给 (`undefined`)。
 *
 * `undefined` 的语义与"宿主没传这份事实"**完全一致** —— 接缝不在这里另立一套
 * "事实缺失"标记 (`ChangeInjectionPlan` 没有这个字段, 那是 M4 纯函数的既定口径);
 * 探针抛错 (读盘失败) 也按"没给"处理并返回 undefined, 绝不编出几个 workId 来。
 */
async function resolveLiveWorkIds(
  deps: ChangeSeamDeps,
  input: Pick<ChangeIngestInput, 'goalId' | 'liveWorkIds'>,
): Promise<readonly string[] | undefined> {
  if (input.liveWorkIds !== undefined) return input.liveWorkIds;
  if (!deps.liveWorkIds) return undefined;
  try {
    const ids = await deps.liveWorkIds(input.goalId);
    return Array.isArray(ids) ? ids : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 基础用户可见态 (读不到就返回 null + 原因)。
 *
 * 为什么必须容错: 入档本身**已经成功**了 (原话落档 + 判定 + 下一 Run 指令)。这时如果读可见态
 * 抛错, 整个人口会 500 —— 人会以为"没提上去"而重提一遍 (重复变更)。所以读不到就读不到:
 * 如实返回 null, 让视图说"读不到", 而不是把已经生效的变更报成失败。
 */
async function resolveBaseVisible(
  deps: ChangeSeamDeps,
  input: { goalId: string; now?: IsoTimestamp },
): Promise<{ base: UserVisibleState | null; reason: string | null }> {
  try {
    return { base: await deps.visibleState(input), reason: null };
  } catch (err) {
    return { base: null, reason: `用户可见态读不到 (${String((err as Error)?.message || err).slice(0, 120)})` };
  }
}

function dedupeChanges(
  list: readonly { changeId: string; kind: ChangeKind | string; status: string }[],
): { changeId: string; kind: ChangeKind | string; status: string }[] {
  const byId = new Map<string, { changeId: string; kind: ChangeKind | string; status: string }>();
  for (const c of list) byId.set(String(c.changeId), c);
  return [...byId.values()];
}

export function createChangeSeam(deps: ChangeSeamDeps): ChangeSeam {
  async function applyRunBoundary(input: {
    plan: ChangeInjectionPlan;
    now: IsoTimestamp;
    stop?: StopRunningRun;
  }): Promise<RunBoundaryOutcome> {
    const b = input.plan.runBoundary;
    if (b.action === 'let_finish') {
      return {
        action: 'let_finish',
        stopped: false,
        runId: b.runId,
        runStatus: null,
        reason: `不需要停动作 (在跑的 Run 继续跑完): ${b.reason}`,
      };
    }
    const runStatus: StopRunStatus = b.runStatus === 'paused' || b.runStatus === 'aborted' ? b.runStatus : 'paused';
    if (!b.runId) {
      return {
        action: 'stop_running_run',
        stopped: false,
        runId: null,
        runStatus,
        reason: '计划要求停 Run, 但没有 runId → 拒绝凭空停一个 Run (拿不到对象就不动手)',
      };
    }
    const stop = input.stop ?? deps.stopRunningRun;
    if (!stop) {
      return {
        action: 'stop_running_run',
        stopped: false,
        runId: b.runId,
        runStatus,
        reason: `计划要求停 Run ${b.runId} (→${runStatus}), 但宿主没有注入停 Run 的执行器 → **没有停**`
          + ' (需要主线在 M0 的 createChangeSeam 注入 stopRunningRun, 或由入口按参数传入; 本接缝不做 I/O, 也不假装停过)',
      };
    }
    const res = await stop({ goalId: input.plan.goalId, runId: b.runId, runStatus, reason: b.reason, now: input.now });
    return {
      action: 'stop_running_run',
      stopped: !!res?.ok,
      runId: b.runId,
      runStatus,
      reason: res?.ok
        ? `已把 Run ${b.runId} 置为 ${runStatus}: 执行器下一轮循环读到后自行停下 (轮内不打断, 已发生的步骤不改写)`
        : `停 Run ${b.runId} 被拒绝: ${res?.reason || '执行器没给原因 (不静默当成功)'}`,
    };
  }

  return {
    id: CHANGE_SEAM_ID,
    stage: 'M4',

    async ingestChange(input) {
      const raw = String(input.instruction ?? '');
      // ① 原话是证据: 没有原文就不许往下走 (一句"理解"不能代替人说过的话)
      if (!raw.trim()) {
        return refuse('child_cannot_mutate_goal', '拒绝: 变更没有原文 —— 不许用一句"理解"代替人说过的话');
      }
      // ② 只有人能撤销 / 缩小意图 (设计稿「意图的落位」纪律 2)。
      //    判据 = 真实分诊 (`userOnlyChangeKind`), 不再只认字面关键词:
      //    "别继续做了 / abort this / 只做第一条" 这些说法现在也认得出来。
      const userOnly = userOnlyChangeKind(raw);
      if (userOnly && input.source !== 'user') {
        return refuse(
          'only_goal_reducer_changes_goal_state',
          `拒绝: ${input.source} 想提「${userOnly}」类变更 —— 只有人能撤销/缩小意图 `
            + '(Agent 不得因为"执行起来方便"就替人改意图)',
        );
      }

      const out = await deps.ingest({ ...input, instruction: raw });
      if (!out?.request || !out?.application) {
        throw new Error('[change 接缝] 宿主没有返回变更记录/生效判定 (接缝不替它编一份)');
      }
      if (!(CHANGE_OUTCOMES as readonly string[]).includes(String(out.application.outcome))) {
        throw new Error(`[change 接缝] 宿主返回的 outcome 非法: "${String(out.application.outcome)}" (合法: ${CHANGE_OUTCOMES.join('/')})`);
      }
      // ③ 规则 4 是**宿主契约**: 记录必须标着"只影响后续 Run"。违反 = 接线坏了 → 抛错, 不假绿。
      if (out.request.appliesToFutureRunsOnly !== true) {
        throw new Error('[change 接缝] 宿主返回的变更记录没标 appliesToFutureRunsOnly —— 规则 4: 已发生的 Run 历史不可被新要求改写');
      }
      // ④ 原话必须逐字入档: 被改写过的"原话"不是证据
      if (out.request.instruction !== raw) {
        return refuse('child_cannot_mutate_goal', '拒绝: 变更记录里的 instruction 与用户原话不一致 (原话必须逐字入档)');
      }

      // ⑤ 正在运行的 Goal: 拿事实 → 判定 (纯函数) → 按判定执行 (宿主注入的执行器)
      const runningRun = await resolveRunningRun(deps, input);
      const liveWorkIds = await resolveLiveWorkIds(deps, input);
      const plan = planChangeInjection({
        request: out.request,
        application: out.application,
        runningRun,
        liveWorkIds,
      });
      const runBoundary = await applyRunBoundary({ plan, now: input.now });

      // ⑥ 规则 5: 逐 workId 一份下发内容 (计划里已经算好; 这里只补"要不要先补全影响面")
      const childDelivery: ChildEditionDelivery = {
        directives: plan.childDirectives,
        workIds: plan.liveWorkIds,
        scopeMissing: plan.childScopeMissing,
        blocked: plan.childScopeMissing,
        mustAck: true,
        note: plan.childScopeMissing
          ? `在跑的 ${plan.liveWorkIds.length} 个子 Agent 必须收到变更版本, 但这条变更没点明影响面 → 下发前先用 scopeChangeToWork 补全 (不许静默漏发)`
          : plan.childDirectives.length
            ? `已为 ${plan.childDirectives.length} 个在跑的子 Agent 各生成一份下发内容 (每个都必须先 ack 再继续)`
            : '没有在跑的子 Agent 需要下发 (子 Agent 条款仍在下一 Run 指令里)',
      };

      // ⑦ 用户可见态: 有待拍板的变更 → "需要你决定" (只升不降; 基础态读不到也不编一个态出来)
      const observed = await resolveBaseVisible(deps, { goalId: input.goalId, now: input.now });
      const recorded = await deps.pending(input.goalId).catch(() => [] as GoalChangeRequest[]);
      const visible = changeVisibleState({
        base: observed.base,
        // 新入档这条用它自己的真实结论 (宿主回传的 request.status 停在分诊那一刻, 不是终态)
        changes: dedupeChanges([
          ...recorded,
          { changeId: out.request.changeId, kind: out.request.kind, status: nextStatusFor(out.application.outcome) },
        ]),
      });

      return {
        request: out.request,
        classification: out.application,
        application: out.application,
        instructionVerbatim: raw,
        plan,
        runBoundary,
        childDelivery,
        visibleState: visible.state,
        visibleReason: observed.reason ? `${visible.reason}; ${observed.reason}` : visible.reason,
        needsDisambiguation: out.request.status === 'received' || !out.request.interpreted,
      };
    },

    applyRunBoundary,

    nextRunDirective(goalId) {
      return deps.nextRunDirective(goalId);
    },

    async markConsumed(goalId, runIndex, now) {
      if (!Number.isInteger(runIndex) || runIndex < 0) {
        throw new Error(`[change 接缝] markConsumed 的 runIndex 必须是 >=0 的整数 (收到 ${String(runIndex)}) —— 版本下发的记账不许记在一个不存在的 Run 序号上`);
      }
      await deps.markConsumed(goalId, runIndex, now);
    },

    async visibleState(input) {
      const observed = await resolveBaseVisible(deps, { goalId: input.goalId, now: input.now });
      const recorded = await deps.pending(input.goalId).catch(() => [] as GoalChangeRequest[]);
      // 基础态读不到且没有待拍板的变更 → null (不编一个态出来)
      return changeVisibleState({ base: observed.base, changes: recorded }).state;
    },

    pendingChanges(goalId) {
      return deps.pending(goalId);
    },
  };
}
