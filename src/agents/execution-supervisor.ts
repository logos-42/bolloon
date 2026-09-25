/**
 * ExecutionSupervisor — 长期执行层 (2026-09-16, M2-B / 计划 §13 2-A+2-B)
 *
 * 职责边界 (刻意与 Harness 分开):
 *   Harness 只管「这一段能不能安全执行」
 *   Supervisor 才管「这个目标还要不要继续执行」
 *
 * 它是一个常驻 worker: 扫描可执行的 Goal → 抢 lease → 开新 Run 或恢复旧 Run → 执行 →
 * 按结果决策 Goal 状态 → 写下一次唤醒信息 → 释放 lease → 换下一个 Goal。
 *
 * 它不塞进 Web request, 也不依赖浏览器是否打开。触发器可以复用 cron/heartbeat 的 tick,
 * 但**事实来源永远是持久化记录** (GoalStore / RunStore / lease 文件), 不是内存状态。
 */

import * as os from 'os';
import {
  listRunnableGoals,
  claimGoal,
  heartbeatGoal,
  releaseGoal,
  readGoal,
  setContinuation,
  bumpContinuationAttempts,
  evaluateGoalCompletion,
  addEvidence,
  type GoalRecord,
  type GoalContinuation,
  type GoalStatus,
} from './goal-store.js';
import type { ContinuationDecision } from './goal-flywheel/types.js';
import {
  readRun,
  reconcileOrphans,
  superviseRuns,
  buildContinuationPlan,
  RESUMABLE_STATUSES,
  type RunRecord,
} from './run-store.js';
// 2026-09-25 (飞轮接线): P0–P4 的七个模块经**唯一**适配层接进真实执行路径
//   (节奏由进展决定 · Run 收尾必过 closeRun · 子 Agent 走工作合同 · 阻塞监控 · 变更注入 · 用户可见态)
// 2026-09-25 (串行收口): 四条线各自报"只有主线能加"的钩子在这里补齐 ——
//   ① 节奏判定走 **M1 接缝的事实路径** (`preflightGoalStep`, 不再直连 `decideGoalStep`);
//   ② Skill 试用在**候选产出处**开 (`closeGoalRun` 内部) / 在**下一条 Run 成功点**结算;
//   ③ 阻塞巡检走 **M3 的统一巡检** (`flywheelSeams().monitor.sweepAll`, 不再自己拼一条循环);
//   ④ 撤销走 **M4 的 change 接缝** (`ingestRequirement`, 非 web 宿主也能真停住在跑的 Run)。
import {
  claimedTerminalKindForRun,
  closeRunOnce,
  dispatchChildWork,
  flywheelSeams,
  flywheelTickNote,
  ingestRequirementViaSeam,
  installRunTerminalHook,
  isRefusal,
  markChangesConsumed,
  mergeGoalOutcome,
  nextRunChangeDirective,
  pendingContractDigest,
  preflightGoalStep,
  settleSkillTrialsForRun,
  type FlywheelTickNote,
  type GoalStepDecision,
  type MergedGoalOutcome,
  type MonitorTickView,
  type TrialOpeningView,
  type SkillTrialSettlementView,
  type SupervisorStepDecision,
} from './goal-flywheel-wiring.js';
// 2026-09-25 (M0 接线冻结, 规则 ②): Goal 状态只有一个写入出口
import { reduceGoalState } from './goal-state-reducer.js';

// ─────────────────────────────────────────────────────────────────────────────
// 2-D: Run 结束 → Goal 状态决策 (确定性 reducer, 纯函数, 可单测)
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalDecision {
  goalStatus: GoalStatus;
  continuation: Partial<GoalContinuation>;
  reason: string;
}

/** 自动继续的退避 (attempts → 等待毫秒)。0 次 = 立刻。 */
export function continuationBackoffMs(attempts: number): number {
  const steps = [0, 15_000, 60_000, 5 * 60_000, 15 * 60_000];
  return steps[Math.min(Math.max(attempts, 0), steps.length - 1)];
}

/**
 * Run 结果 → Goal 下一步。**Run done ≠ Goal completed** 是这里的核心不变式:
 * Run 结束从来不自动等于目标完成, 必须过 evaluateGoalCompletion。
 */
export function decideGoalOutcome(
  goal: GoalRecord,
  run: RunRecord | null,
  opts: { now?: number; maxAttempts?: number; lastRunStatus?: string } = {},
): GoalDecision {
  const now = opts.now ?? Date.now();
  // maxAttempts = 允许的自动继续次数 (默认 2) → 第 3 次失败进 needs_human
  const maxAttempts = opts.maxAttempts ?? 2;
  const attempts = (goal.continuation?.attempts || 0);
  const nextAction = run?.checkpoint?.nextAction;
  // 这一轮没有失败/没有等待 → 自动继续计数清零 (连续失败才累加)
  const base = { autoContinue: true, lastRunId: run?.runId, nextAction };

  if (!run) {
    return { goalStatus: 'active', continuation: { ...base, wakeReason: 'new_goal' }, reason: '还没有 Run' };
  }

  // 人定的状态优先, 不覆盖 (外部 pause/abort 是人的决定)
  if (run.status === 'paused') {
    return { goalStatus: 'paused', continuation: { ...base, autoContinue: false, wakeReason: 'paused' }, reason: '运行被人工暂停: 等 resume' };
  }

  switch (run.status) {
    case 'interrupted':
      return {
        goalStatus: 'recovering',
        continuation: { ...base, wakeReason: 'recovering' },
        reason: '进程中断 (crash): 从 checkpoint 恢复, 不重头开始',
      };

    case 'stalled':
      return {
        goalStatus: 'stalled',
        continuation: { ...base, wakeReason: 'stalled' },
        reason: '运行失速 (心跳过期): 交 Supervisor 决策恢复或转人工',
      };

    case 'awaiting_external':
      return {
        goalStatus: 'awaiting_external',
        continuation: {
          ...base,
          wakeReason: 'awaiting_external',
          needsExternal: String(run.error || '外部节点回复'),
        },
        reason: '在等外部事件: 不重发请求, 由事件唤醒',
      };

    case 'aborted':
      return {
        goalStatus: 'active',
        continuation: { ...base, wakeReason: 'active', wakeAt: undefined },
        reason: `运行被中止 (${run.errorClass || run.error || '预算/人工'}): 目标仍 active, 交给下一个 Run 继续`,
      };

    case 'done': {
      const verdict = evaluateGoalCompletion(goal, { lastRunStatus: opts.lastRunStatus || run.status });
      if (verdict.complete) {
        return {
          goalStatus: 'completed',
          continuation: { ...base, autoContinue: false, wakeReason: 'completed' },
          reason: `判据全部满足: ${verdict.reason}`,
        };
      }
      // Run 说完成, 但 Goal 的判据/证据不足 → 不许装作完成 (这一轮没失败, 自动继续计数清零)
      return {
        goalStatus: 'active',
        continuation: { ...base, wakeReason: 'active', wakeAt: undefined, attempts: 0 },
        reason: `Run 已 done 但目标未达成 (${verdict.reason}) → 继续下一个 Run`,
      };
    }

    case 'failed':
    case 'needs_human': {
      const cls = run.errorClass || 'unknown';
      const needsHuman = ['auth', 'persist_failed', 'corrupt_state', 'policy_denied', 'repeat_failure', 'bad_args', 'no_such_tool'].includes(cls)
        || attempts >= maxAttempts;
      if (needsHuman) {
        return {
          goalStatus: 'needs_human',
          continuation: { ...base, autoContinue: false, wakeReason: 'needs_human', attempts },
          reason: `${cls} 需要人工介入${attempts >= maxAttempts ? ` (自动继续已试 ${attempts} 次)` : ''}`,
        };
      }
      const wait = continuationBackoffMs(attempts);
      return {
        goalStatus: 'retry_wait',
        continuation: {
          ...base,
          wakeReason: 'retry_wait',
          wakeAt: new Date(now + wait).toISOString(),
          attempts: attempts + 1,
        },
        reason: `可恢复错误 ${cls}: 第 ${attempts + 1} 次自动继续, ${Math.round(wait / 1000)}s 后唤醒`,
      };
    }

    case 'recovering':
      return { goalStatus: 'recovering', continuation: { ...base, wakeReason: 'recovering' }, reason: '正在恢复' };

    default: { // queued / running
      return { goalStatus: 'active', continuation: { ...base, wakeReason: 'active' }, reason: `运行中 (${run.status})` };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行请求 / 执行器注入
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalExecutionRequest {
  goal: GoalRecord;
  /** resume = 同一条 Run 继续; continue_new_run = 开新 Run 继续同一 Goal; first_run = 首次执行 */
  kind: 'resume' | 'continue_new_run' | 'first_run';
  prevRunId?: string;
  instruction: string;
  /** 上一个 Run 已成功的非幂等动作 (新 Run 也要守住, 不许重做) */
  guards: { tool: string; argsDigest?: string; summary: string }[];
}

export interface GoalExecutionResult {
  runId?: string;
  status?: string;
  reply?: string;
  error?: string;
}

/** 执行器由调用方注入 (Web 用 channel agent, CLI 用当前 agent, 测试用假的) —— 不提供默认实现, 避免暗中复制 agent loop */
export type GoalRunner = (req: GoalExecutionRequest) => Promise<GoalExecutionResult>;

// ── 宿主分离 (2-C.1): 执行器不再写死, 每次执行前由 resolver 解析 ──
export type RunnerKind = 'web' | 'cli' | 'standalone' | 'injected' | 'fake' | 'none';

export interface RunnerResolution {
  ok: boolean;
  runner?: GoalRunner;
  kind: RunnerKind;
  /** ok=false 时的人类可读原因 (进 skipped/诊断, 不静默) */
  reason?: string;
}

/**
 * 解析"这个 Goal 谁来执行"。可以是 web 的 channel agent / CLI 的会话 agent / 独立 agent / 测试假的;
 * 解析不出来必须是 `{ok:false}` —— Supervisor 会**只诊断不执行, 且不写任何 Goal 状态**
 * (绝不把"没人能执行"当成"执行失败"或"执行完成")。
 */
export type RunnerResolver = (req: GoalExecutionRequest) => Promise<RunnerResolution> | RunnerResolution;

export interface SupervisorOptions {
  owner?: string;
  tickIntervalMs?: number;
  leaseTtlMs?: number;
  /** 每个 tick 最多推进几个 Goal (默认 1, 长期执行要克制) */
  maxPerTick?: number;
  /** 固定执行器 (简单宿主/测试用) */
  runner?: GoalRunner;
  /**
   * 可注入时钟 (2026-09-16, 2-C.3): 生产用真实时间, 测试/验收可用假时钟推进
   * (唤醒判定、退避、wakeReport 都走它, 保证"到点"这件事只有一个事实来源)。
   */
  now?: () => number;
  /**
   * 自动继续的最大次数 (默认 2, env BOLLOON_GOAL_MAX_RETRIES):
   * 第 1、2 次失败 → retry_wait 自动续跑; **第 3 次失败 → needs_human**。
   */
  maxRetries?: number;
  /** 动态执行器解析 (生产宿主用: web / CLI / 独立进程 各自解析) */
  resolver?: RunnerResolver;
  onEvent?: (e: { kind: string; goalId?: string; runId?: string; message: string }) => void;
  log?: (msg: string) => void;
}

export interface TickReport {
  at: string;
  owner: string;
  tick: number;
  reconciled: { interrupted: string[]; stillRunning: string[]; failed: string[] };
  /** 2026-09-18 (Phase 3): 支付事实对账 (只对账, 绝不代替付款方花钱) */
  payments: import('./x402/payment-recovery.js').PaymentReconcileReport;
  supervised: { stalled: string[]; failed: string[] };
  claimed: string[];
  executed: { goalId: string; runId?: string; status?: string; error?: string }[];
  skipped: { goalId: string; reason: string }[];
  errors: string[];
  dryRun: boolean;
  /** 2026-09-25 (飞轮接线 P0): 每个候选 Goal 的节奏判定 + 用户可见态 */
  flywheel: FlywheelTickNote[];
  /** 2026-09-25 (飞轮接线 P3): 阻塞巡检结论 (不看进程存活, 看任务是否卡住) */
  blocks: { goalId: string; workId: string; kind: string; action: string; note: string }[];
  /**
   * ★ 2026-09-25 (串行收口): 这一 tick 的**统一巡检视图** (M3 `sweepAll` 的原样返回)。
   *
   * `null` = 这一轮没跑成统一巡检 (接缝拒绝 / 抛错, 原因在 `errors` 里) ——
   * 绝不是"巡检过了, 没有问题"。`goals[]` 里每一格都带 block 数 / 处置 / 用户可见态 / 该格的错误,
   * 所以"某个 Goal 巡检失败"不会静默消失。
   */
  monitor: MonitorTickView | null;
  /** ★ 2026-09-25 (串行收口): 这一轮 Run 成功点上 Skill 试用的结算结论 (提升/回退/仍未兑现) */
  skillTrials: (SkillTrialSettlementView & { runId: string })[];
  /**
   * ★ 2026-09-25 (串行收口): 本轮**候选产出处**开出的 Skill 试用 (通道入口证据)。
   * 与 `skillTrials` 一进一出: 这里是"开出", 那里是"结算"。
   */
  skillTrialOpenings: (TrialOpeningView & { goalId: string; runId: string })[];
  /** 2026-09-25 (飞轮接线 P1): 每个 Run 的收尾流水线结论 (9 步 + 产物路径) */
  closures: {
    goalId: string; runId: string; steps: number; decision: string;
    memories: number; candidates: number;
    /** ★ 串行收口: 这次收尾开出的 Skill 试用 (结构化面; 空数组 = 这次收尾没有候选开成试用) */
    trials: (TrialOpeningView & { goalId: string; runId: string })[];
    reportPath: string; decisionRecordPath: string;
  }[];
  /** 2026-09-25 (飞轮接线 P2): 本轮签发的工作合同 (子 Agent 不是"派个任务", 是"管理一份合同") */
  workContracts: { goalId: string; workId: string; capability: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────

/** 调度上下文的时间戳 (不含 lease 镜像: 认领本身会写 lease, 不应把快照判成过期) */
function stampOf(g: GoalRecord): string {
  return [g.status, g.currentRunId || '', String(g.runs.length), g.continuation?.updatedAt || '', g.goalId].join('|');
}

export class ExecutionSupervisor {
  readonly owner: string;
  private readonly tickIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxPerTick: number;
  private readonly runner?: GoalRunner;
  private readonly resolver?: RunnerResolver;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly onEvent?: SupervisorOptions['onEvent'];
  private readonly logFn?: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickCount = 0;
  private reconciledOnce = false;
  private lastReport: TickReport | null = null;

  constructor(opts: SupervisorOptions = {}) {
    this.owner = opts.owner || `${os.hostname()}:${process.pid}`;
    this.tickIntervalMs = opts.tickIntervalMs ?? 30_000;
    this.leaseTtlMs = opts.leaseTtlMs ?? 90_000;
    this.maxPerTick = opts.maxPerTick ?? 1;
    this.runner = opts.runner;
    this.resolver = opts.resolver;
    this.now = opts.now ?? (() => Date.now());
    this.maxRetries = opts.maxRetries ?? (Number(process.env.BOLLOON_GOAL_MAX_RETRIES) >= 0 ? Number(process.env.BOLLOON_GOAL_MAX_RETRIES) : 2);
    this.onEvent = opts.onEvent;
    this.logFn = opts.log;
  }

  /** 有固定执行器或解析器 → 可以真执行; 都没有 → 只诊断 (dry-run) */
  get canExecute(): boolean { return !!(this.runner || this.resolver); }

  private log(msg: string): void {
    this.logFn?.(msg);
  }

  private emit(e: { kind: string; goalId?: string; runId?: string; message: string }): void {
    try { this.onEvent?.(e); } catch { /* 观测失败不影响调度 */ }
  }

  get running(): boolean { return this.timer !== null; }

  status() {
    return {
      owner: this.owner,
      running: this.running,
      tickIntervalMs: this.tickIntervalMs,
      leaseTtlMs: this.leaseTtlMs,
      maxPerTick: this.maxPerTick,
      ticks: this.tickCount,
      dryRun: !this.canExecute,
      hasResolver: !!this.resolver,
      lastReport: this.lastReport,
    };
  }

  start(): void {
    if (this.timer) return;
    if (!this.canExecute) this.log('[supervisor] 未注入 runner/resolver → 只诊断不执行 (dry-run)');
    this.timer = setInterval(() => { void this.tickOnce().catch((err) => this.log(`[supervisor] tick 失败: ${(err as Error)?.message}`)); }, this.tickIntervalMs);
    this.timer.unref?.();
    this.log(`[supervisor] 启动 owner=${this.owner} tick=${this.tickIntervalMs}ms leaseTtl=${this.leaseTtlMs}ms`);
    void this.tickOnce().catch(() => { /* 首次 tick 失败不抛 */ });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; this.log('[supervisor] 停止'); }
  }

  /** 一个调度周期 (可单测/可手动触发)。所有决策基于持久化记录。 */
  async tickOnce(): Promise<TickReport> {
    if (this.ticking) return this.lastReport || this.emptyReport();
    this.ticking = true;
    this.tickCount++;
    const report: TickReport = { ...this.emptyReport(), tick: this.tickCount };

    try {
      // 0. (2026-09-25, M0 接线冻结) 把"Run 终止 → 唯一责任链"的钩子装上:
      //    崩溃恢复 / 失速这两条终止路径由 run-store 判出, 由接线层收尾 (规则 ④)。
      await installRunTerminalHook().catch((err) => {
        report.errors.push(`Run 终止钩子安装失败: ${(err as Error)?.message || err}`);
      });

      // 1. 对账孤儿 (进程死了的 run) —— 只在启动后第一次做, 之后靠 tick 的常规巡检
      if (!this.reconciledOnce) {
        report.reconciled = await reconcileOrphans();
        this.reconciledOnce = true;
        if (report.reconciled.interrupted.length) this.log(`[supervisor] 对账: ${report.reconciled.interrupted.length} 条僵尸 run → interrupted`);

        // 1.1 (2026-09-18, Phase 3): 支付中断对账 —— 只把结算事实钉死, **绝不代替付款方花钱**
        try {
          const { reconcileInterruptedPayments } = await import('./x402/payment-recovery.js');
          const home = process.env.HOME || os.homedir();
          report.payments = await reconcileInterruptedPayments({
            home,
            reconcile: async (rec) => {
              // 对账依据: 记录里既有的链上证据。查真链上历史属 Phase 1 (需 RPC/facilitator), 这里不猜。
              if (rec.chainSettled === true && rec.txHash) return { fact: 'payment_verified', txHash: rec.txHash, note: '对账: 记录自带 txHash 与链上结算事实' };
              if (rec.txHash) return { fact: 'payment_verified', txHash: rec.txHash, note: '对账: 发现 txHash → 结算事实升级' };
              if (rec.paymentReceipt) return { fact: 'unknown', note: '有支付凭据但无 txHash → 维持 unknown, 需 facilitator 澄清 (不重付)' };
              return { fact: 'unpaid', note: '没有任何支付凭据 → 确认没付过 (可安全重试)' };
            },
            persist: async (transactionId, patch, event) => {
              const { updateTransaction } = await import('./x402/transaction-store.js');
              await updateTransaction(transactionId, { ...patch, event } as any, home);
            },
          });
          if (report.payments.reconciled.length || report.payments.mustNotRepay.length || report.payments.goalsWoken.length) {
            this.log(`[supervisor] 支付对账: ${report.payments.reconciled.length} 条已钉结算事实 · ${report.payments.mustNotRepay.length} 条绝不重付 · `
              + `${report.payments.awaitingPayment.length} 条等付款 · **唤醒 ${report.payments.goalsWoken.length} 个 Goal** · ${report.payments.goalsFlagged.length} 个转人工`);
          }
        } catch (err: any) {
          report.payments.errors.push(String(err?.message || err).slice(0, 120));
        }
      }
      report.supervised = await superviseRuns();

      // 1.5 (2026-09-16, 2-C.4): 外部等待超时 → 明确转人工 (不允许无限等待)
      try {
        const { expireExternalWaits } = await import('./external-events.js');
        const expired = await expireExternalWaits({ now: this.now() });
        for (const e of expired) {
          this.log(`[supervisor] 外部等待超时 → needs_human: ${e.goalId} (${e.wait.expectedSource})`);
          this.emit({ kind: 'needs_human', goalId: e.goalId, message: e.reason });
        }
      } catch (err) {
        this.log(`[supervisor] 外部等待超时检查失败: ${(err as Error)?.message}`);
      }

      // 2. 扫描可执行 Goal
      const { runnable, skipped } = await listRunnableGoals({ now: this.now(), owner: this.owner });
      report.skipped = skipped;
      const nowIso = new Date(this.now()).toISOString();

      // 2.5 (2026-09-25, 飞轮接线 P3 + 串行收口): 阻塞巡检 —— **不看进程存活, 看任务是否卡住**
      //   走 M3 的**统一巡检** (`flywheelSeams().monitor.sweepAll`): 一次调用 = 所有待回报 Goal 的
      //   结论 (有界 + 失败留痕 + 每格带用户可见态)。之前 supervisor 自己拼了一条
      //   `listGoalsWithPendingWork → collectWorkBlocks → applyBlockHandling` 的循环 —— 那是
      //   第二套巡检实现 (`sweepAll` 才是 M3 的门面), 于是 M3 的"统一巡检"在真路径上从来没有调用方。
      let monitorView: MonitorTickView | null = null;
      try {
        const view = await flywheelSeams().monitor.sweepAll({
          caller: 'supervisor',
          now: nowIso,
          runnerAvailable: this.canExecute,
        });
        if (isRefusal(view)) {
          // 拒绝不是"没有阻塞": 如实记进 errors, 不许静默当成巡检通过
          report.errors.push(`阻塞巡检被拒: ${view.reason}`);
        } else {
          monitorView = view;
          report.monitor = view;
          for (const cell of view.goals) {
            for (const a of cell.handling?.actions ?? []) {
              report.blocks.push({ goalId: cell.goalId, workId: a.workId, kind: a.kind, action: a.action, note: a.note });
            }
            if (cell.error) report.errors.push(`阻塞巡检 goal=${cell.goalId}: ${cell.error}`);
          }
          const acted = view.goals.filter((c) => (c.handling?.actions.length ?? 0) > 0);
          for (const c of acted) {
            this.log(`[supervisor] goal=${c.goalId} 阻塞巡检: ${(c.handling?.actions ?? []).map((a) => `${a.kind}→${a.action}`).join(', ')}`);
          }
          const escalated = [...new Set(view.escalated)];
          if (escalated.length) {
            // 巡检未完成 (silentRisk) 与"交人"是两回事: 前者是巡检自身没查成, 后者是任务真的卡住
            const why = view.silentRisk
              ? `巡检未完成 (silentRisk=true, 一个 Goal 都没查成): ${escalated.join(', ')}`
              : `子 Agent 工作升级到人: ${escalated.join(', ')}`;
            this.emit({ kind: 'needs_human', goalId: view.goals[0]?.goalId, message: why });
            this.log(`[supervisor] 阻塞巡检 → 交人: ${why}`);
          }
          if (view.takeovers.length) this.log(`[supervisor] 父接管子工作 (无心跳 + 执行权空闲 + 合同允许): ${view.takeovers.join(', ')}`);
          if (view.requests.length) this.log(`[supervisor] 阻塞巡检要求补齐: ${view.requests.join(', ')}`);
          if (view.errors.length && !escalated.length) report.errors.push(`阻塞巡检 (接缝自检): ${view.errors.join(' | ')}`);
        }
      } catch (err) {
        report.errors.push(`阻塞巡检: ${(err as Error)?.message || err}`);
      }

      // 3. 逐个推进 (每个 Goal: 节奏判定 → 抢 lease → 执行 → 收尾 → 决策 → 释放 lease)
      for (const goal of runnable.slice(0, this.maxPerTick)) {
        // 3.1 (P0 + M1 串行收口) 节奏由进展决定: 走 **M1 接缝的事实路径**
        //     (`readFacts` 读 Goal/Run/进展/无进展连击 → 接缝用 P0 自己判 + 上限归因)。
        //     事实拿不到时接缝内部才回落到旧注入口径, 并在 `step.source` 上如实标出来。
        let step: SupervisorStepDecision | null = null;
        try {
          const pre = await preflightGoalStep({
            goalId: goal.goalId, now: nowIso, maxRetries: this.maxRetries, writeRecord: true,
          });
          if (pre && isRefusal(pre)) {
            // 接缝真拒 (caller 不是 supervisor / 没有 goalId) → 如实记, 不静默跳过
            report.errors.push(`${goal.goalId}: 节奏判定被拒: ${pre.reason}`);
          } else {
            step = pre;
          }
        } catch (err) {
          report.errors.push(`${goal.goalId}: 节奏判定失败 ${(err as Error)?.message || err}`);
        }
        if (step) {
          // 阻塞结论复用**同一 tick 的统一巡检**结果 (没有那一格才自己读): 一条 tick 里不查第二遍
          const swept = monitorView?.goals.find((c) => c.goalId === goal.goalId)?.blocks ?? null;
          report.flywheel.push(await flywheelTickNote({ goalId: goal.goalId, step, now: nowIso, blocks: swept }).catch(() => ({
            goalId: goal.goalId,
            decision: step!.decision?.decision ?? 'first_run',
            state: step!.decision?.state ?? 'progressing',
            runnable: step!.runnable,
            reason: step!.reason,
            noProgressStreak: step!.noProgressStreak,
            visibleState: 'executing' as const,
            nextAction: step!.decision?.nextAction ?? '(首个 Run)',
            source: step!.source,
            basis: step!.basis,
            caps: step!.caps,
          })));
          if (!step.runnable) {
            report.skipped.push({ goalId: goal.goalId, reason: `飞轮: ${step.reason}` });
            await this.applyFlywheelStop(goal.goalId, step, nowIso).catch((err) => {
              report.errors.push(`${goal.goalId}: 飞轮停写失败 ${(err as Error)?.message || err}`);
            });
            continue;
          }
        }

        const claimed = await claimGoal(goal.goalId, { owner: this.owner, ttlMs: this.leaseTtlMs });
        if (!claimed.ok) {
          report.skipped.push({ goalId: goal.goalId, reason: claimed.reason || 'claim 失败' });
          continue;
        }
        report.claimed.push(goal.goalId);
        const leaseId = claimed.lease!.leaseId;
        try {
          const res = await this.runGoal(goal, leaseId, report, step);
          report.executed.push(res);
        } catch (err) {
          report.errors.push(`${goal.goalId}: ${(err as Error)?.message || err}`);
        } finally {
          const rel = await releaseGoal(goal.goalId, leaseId);
          if (!rel.ok) report.skipped.push({ goalId: goal.goalId, reason: rel.reason || 'release 失败' });
        }
      }
    } catch (err) {
      report.errors.push(`tick: ${(err as Error)?.message || err}`);
    } finally {
      this.ticking = false;
      this.lastReport = report;
    }
    return report;
  }

  private emptyReport(): TickReport {
    return {
      at: new Date().toISOString(), owner: this.owner, tick: this.tickCount,
      reconciled: { interrupted: [], stillRunning: [], failed: [] },
    payments: { scanned: 0, reconciled: [], awaitingPayment: [], mustNotRepay: [], closed: [], goalsWoken: [], goalsFlagged: [], errors: [] },
      supervised: { stalled: [], failed: [] },
      claimed: [], executed: [], skipped: [], errors: [], dryRun: !this.runner,
      flywheel: [], blocks: [], monitor: null, skillTrials: [], skillTrialOpenings: [], closures: [], workContracts: [],
    };
  }

  /**
   * 飞轮说"不该跑"时, 该不该把"停"写进 Goal?
   *
   * 只有**明确要求停**的决策才写 (fail / pause / 无进展熔断 / 硬底线 / 阻塞):
   * 这些是"停就是停"的判断, 不写下去的话下一个 tick 还会来问一遍 (且用户看不到原因)。
   * 其余 `ask_human` (例如"本轮没有新证据, 未到熔断阈值 → 需要人定夺") 只**跳过本轮**、
   * 不动状态: 那属于"没有继续的资格", 由运输层(退避/等外部)与人决定 ——
   * 这样既不会用轮次冒充节奏, 也不会把一次没证据的 Run 直接判死。
   */
  private async applyFlywheelStop(goalId: string, step: GoalStepDecision, now: string): Promise<void> {
    const d = step.decision;
    if (!d) return;
    const hardLine = /硬底线/.test(step.reason);
    const stop = d.decision === 'fail'
      || d.decision === 'pause'
      || (d.decision === 'ask_human' && (d.state === 'no_progress' || d.state === 'blocked'))
      || hardLine;
    if (!stop) return;

    const status: GoalStatus = d.decision === 'fail' ? 'failed' : d.decision === 'pause' ? 'paused' : 'needs_human';
    // 规则 ②: 状态与 continuation 都经 Goal reducer 写 (终态保护 / 完成门也在这里, 不全仓各写一遍)
    const applied = await reduceGoalState({
      goalId,
      intent: 'flywheel_stop',
      now,
      by: this.owner,
      stopStatus: status,
      reason: d.reason,
      decisionId: d.decisionId,
      nextAction: d.nextAction,
      unresolvedItems: d.unresolvedItems,
    });
    if (!applied.ok) {
      this.log(`[supervisor] goal=${goalId} 飞轮判停写不进 Goal (不掩盖): ${applied.reason}`);
    }
    this.emit({ kind: status === 'needs_human' ? 'needs_human' : status, goalId, message: d.reason });
    this.log(`[supervisor] goal=${goalId} 飞轮判停 → ${status}: ${d.reason}`
      + `${applied.applied.length ? ` [${applied.applied.join(', ')}]` : ''}`);
  }

  /** 认领后执行一个 Goal: 决定 resume 还是开新 Run → 跑 → 决策 Goal 状态 */
  private async runGoal(
    goal: GoalRecord,
    leaseId: string,
    report: TickReport,
    /**
     * ★ 2026-09-25 (串行收口): 主循环**这一刻**已经落定的节奏判定 (3.1 的结果)。
     * 传下来的理由: 「同一条 tick 里事实只读一次」。以前门禁自己又 `preflightGoalStep()` 了一遍,
     * 于是同一次事实读留痕翻倍、而且门禁看到的是**另一个时刻**的事实 —— 与
     * `flywheelTickNote` 复用统一巡检结论 (`blocks`) 是同一条纪律。
     */
    tickStep: SupervisorStepDecision | null = null,
  ): Promise<{ goalId: string; runId?: string; status?: string; error?: string }> {
    // 乐观并发检查: 认领后重新读一次 —— 若这个 Goal 在我扫描之后已被别的 worker 推进
    //   (状态/当前 run/run 列表/continuation 变了), 就让路。否则同一个状态版本会被两个 worker 各跑一次。
    const freshGoal = await readGoal(goal.goalId);
    if (!freshGoal || stampOf(freshGoal) !== stampOf(goal)) {
      this.log(`[supervisor] goal=${goal.goalId} 扫描后状态已变 (别的 worker 推进过) → 让路`);
      report.skipped.push({ goalId: goal.goalId, reason: '状态在扫描后被其它 worker 推进 (乐观并发检查) → 本周期不重复执行' });
      return { goalId: goal.goalId, status: 'stale_skip' };
    }

    // 到点唤醒 (2-C.3): 这条 Goal 之前是 retry_wait —— 现在唤醒它, 旧的 wakeAt/wakeReason 必须清掉,
    //   否则下一轮 tick 还会把它当"等时间"重复跳过 (或留下过期的等待事实)。
    if (goal.continuation?.wakeReason === 'retry_wait' || goal.status === 'retry_wait') {
      await setContinuation(goal.goalId, { wakeReason: 'active', wakeAt: undefined });
      report.skipped.push({ goalId: goal.goalId, reason: `到点唤醒: 已清 wakeAt (第 ${(goal.continuation?.attempts || 0) + 1} 次自动继续)` });
      this.emit({ kind: 'retry_woke', goalId: goal.goalId, message: `到点唤醒, 第 ${(goal.continuation?.attempts || 0) + 1} 次自动继续` });
      this.log(`[supervisor] goal=${goal.goalId} retry_wait 到点 → 唤醒并清 wakeAt`);
    }

    // ★ 2026-09-18 (M2 收口): `bolloon task` 建的目标走**同一个恢复决策函数**
    //   (`decideTaskRecovery`) —— CLI `task --resume` 与 Supervisor 不再各判一次。
    //   决策说"不能动钱/已经执行过"就跳过 (不重复付款、不重复执行非幂等操作)。
    if ((goal as any).createdBy === 'cli:task' && process.env.BOLLOON_SUPERVISOR_TASK_RESUME !== '0') {
      try {
        const { decideTaskRecovery, resumeTask } = await import('./task/task-runner.js');
        const decision = await decideTaskRecovery({ goalId: goal.goalId });
        const actionable = ['retry_payment', 'deliver', 'verify'].includes(decision.action);
        if (!actionable) {
          report.skipped.push({ goalId: goal.goalId, reason: `任务恢复决策=${decision.action} (${decision.reason}) → 本周期不动` });
          return { goalId: goal.goalId, status: 'task_no_action' };
        }
        const res = await resumeTask({ goalId: goal.goalId });
        this.log(`[supervisor] task 目标接回: goal=${goal.goalId} decision=${decision.action} → 状态 ${res.card.status}`);
        this.emit({ kind: res.ok ? 'goal_done' : 'needs_human', goalId: goal.goalId, message: `任务接回: ${decision.action} → ${res.card.status}` } as any);
        return { goalId: goal.goalId, runId: res.runId, status: res.card.status, error: res.ok ? undefined : res.reason };
      } catch (err: any) {
        return { goalId: goal.goalId, status: 'task_resume_failed', error: String(err?.message || err).slice(0, 160) };
      }
    }

    const prevRunId = goal.currentRunId;
    const prevRun = prevRunId ? await readRun(prevRunId) : null;
    const plan = prevRunId ? await buildContinuationPlan(prevRunId).catch(() => null) : null;
    const guards = plan?.replayGuards || [];

    // 2026-09-25 (飞轮接线 P4 / P2): 下一个 Run 必须真的读到**同一份**事实 ——
    //   ① 权威 continuation 的 nextAction (飞轮收尾写下的"下一步是什么");
    //   ② 已生效的新要求 (变更注入: 只影响后续 Run, 不改写历史);
    //   ③ 还在等回报的子 Agent 工作合同 (规则 5: 子必须拿到同一份合同)。
    const continuationHint = goal.continuation?.nextAction ? `\n飞轮下一步 (权威 continuation): ${goal.continuation.nextAction}` : '';
    const changeHint = await nextRunChangeDirective(goal.goalId).catch(() => null);
    const contractHint = await pendingContractDigest(goal.goalId).catch(() => null);

    const instruction = (plan
      ? `继续这个目标 (不要重头开始):\n目标: ${plan.objective || goal.objective}\n已完成 ${plan.completedSteps.length} 步; 下一步: ${plan.nextAction}`
      : `开始执行这个目标:\n目标: ${goal.objective}${goal.successCriteria.length ? `\n完成判据: ${goal.successCriteria.join('; ')}` : ''}`)
      + continuationHint
      + (changeHint ? `\n${changeHint}` : '')
      + (contractHint ? `\n${contractHint}` : '');

    const kind: GoalExecutionRequest['kind'] =
      !prevRun ? 'first_run'
        : RESUMABLE_STATUSES.includes(prevRun.status) ? 'resume'
          : 'continue_new_run';

    if (!this.canExecute) {
      this.log(`[supervisor] (dry-run) 会执行 goal=${goal.goalId} kind=${kind} prevRun=${prevRunId || '-'}`);
      return { goalId: goal.goalId, runId: prevRunId, status: 'dry_run' };
    }

    // 执行器解析 (2-C.1): 解析不出来 → **只诊断, 不执行, 不写任何 Goal 状态**
    let runner = this.runner;
    if (!runner && this.resolver) {
      let res: RunnerResolution;
      try {
        res = await this.resolver({ goal, kind, prevRunId, instruction, guards });
      } catch (err) {
        res = { ok: false, kind: 'none', reason: `resolver 抛错: ${String((err as Error)?.message || err).slice(0, 140)}` };
      }
      if (!res.ok || !res.runner) {
        const why = res.reason || '解析不到执行器';
        report.skipped.push({ goalId: goal.goalId, reason: `无执行器: ${why} (Goal 状态未改动)` });
        this.emit({ kind: 'no_runner', goalId: goal.goalId, message: why });
        this.log(`[supervisor] goal=${goal.goalId} 无执行器 → 只诊断, 不执行也不改状态: ${why}`);
        return { goalId: goal.goalId, runId: prevRunId, status: 'unresolved', error: why };
      }
      runner = res.runner;
    }
    if (!runner) {
      report.skipped.push({ goalId: goal.goalId, reason: '无执行器 (Goal 状态未改动)' });
      return { goalId: goal.goalId, status: 'unresolved' };
    }

    // 2026-09-16 (2-G.2): 执行前技能就绪门禁 —— 缺/未启用/损坏/漂移 → 不启动 Run, Goal → needs_human
    //
    // ★ 2026-09-25 (P5 验收修复): 飞轮这一步的裁决是 **delegate** (缺能力 → 派给子 Agent 并签工作合同)
    //   时, **本地技能门禁不适用** —— 这一步本来就不由本节点执行, 能力由子 Agent 凭合同交付。
    //   原来一律拦成 `blocked_by_skills`, 于是"缺能力 → 派活"这条链在真路径上永远走不到,
    //   `dispatchIfDelegate` 成了死代码 (P5 ★①②③ 实测: 合同一份都没签发)。
    //   其余裁决 (continue/first_run/...) 照旧: 技能不就绪照样不启动 Run (门禁没有放松)。
    let flywheelDelegates = false;
    let flywheelCapability = '';
    // 与 3.1 **同一份**判定 (而且是**同一次**事实读): 主循环算好的 `tickStep` 直接沿用 ——
    // 旧写法在这里又 `preflightGoalStep()` 了一遍 (判定口径同, 但事实读了两遍、时刻也不同)。
    // `tickStep === null` (主循环没判成 / 门禁被单独调用) → 按"没有裁决"处理 (fail-closed, 照旧拦)。
    {
      flywheelDelegates = tickStep?.decision?.decision === 'delegate';
      flywheelCapability = tickStep?.decision?.requiredCapability || '';
    }
    try {
      const { ensureGoalSkillsReady, blockGoalOnSkills, recordSkillReadiness } = await import('./skill-readiness.js');
      const ready = await ensureGoalSkillsReady(goal);
      for (const d of ready.degradations) this.log(`[supervisor] goal=${goal.goalId} 技能降级: ${d}`);
      if (!ready.ok && flywheelDelegates) {
        // 本地缺的能力由子 Agent 提供: 记清楚"放过门禁的原因", 不静默。
        // 这里**不进** report.skipped —— 门禁放过 = 本轮**真跑**了 (Run + 之后的合同签发),
        // 记成 skipped 会与事实相反。
        await recordSkillReadiness(goal.goalId, ready).catch(() => { /* 记事实失败不影响本轮 */ });
        const why = `飞轮裁决=delegate (缺能力「${flywheelCapability || '-'}」) → 本地技能门禁不适用, `
          + `本轮照跑(不拦)并改为签发工作合同交给子 Agent; 本地缺: ${ready.reason || ''}`;
        this.log(`[supervisor] goal=${goal.goalId} 技能门禁对 delegate 放行: ${why}`);
        this.emit({ kind: 'skill_gate_waived_for_delegate', goalId: goal.goalId, message: why });
      } else if (!ready.ok) {
        await blockGoalOnSkills(goal.goalId, ready);
        report.skipped.push({ goalId: goal.goalId, reason: `技能未就绪: ${ready.reason}` });
        this.emit({ kind: 'needs_human', goalId: goal.goalId, message: ready.reason || '技能未就绪' });
        this.log(`[supervisor] goal=${goal.goalId} 技能门禁拦截 → needs_human (未启动 Run): ${ready.reason}`);
        return { goalId: goal.goalId, runId: prevRunId, status: 'blocked_by_skills', error: ready.reason };
      }
    } catch (err) {
      // 门禁自身失败 → fail-closed: 不执行 (宁可停, 不用未校验的技能跑)
      const why = `技能门禁自身失败 (fail-closed, 未执行): ${String((err as Error)?.message || err).slice(0, 140)}`;
      report.skipped.push({ goalId: goal.goalId, reason: why });
      this.log(`[supervisor] ${why}`);
      return { goalId: goal.goalId, runId: prevRunId, status: 'blocked_by_skills', error: why };
    }

    // 执行期间持续续租: 续租失败 = 已被别人接管 → 记录 (不掩盖)
    const hb = setInterval(() => {
      void heartbeatGoal(goal.goalId, leaseId, this.leaseTtlMs).then((r) => {
        if (!r.ok) this.emit({ kind: 'lease_lost', goalId: goal.goalId, message: r.reason || '续租失败' });
      });
    }, Math.max(5_000, Math.floor(this.leaseTtlMs / 3)));
    hb.unref?.();

    let result: GoalExecutionResult;
    const t0 = Date.now();
    try {
      result = await runner({ goal, kind, prevRunId, instruction, guards });
    } catch (err) {
      result = { error: (err as Error)?.message || String(err) };
    } finally {
      clearInterval(hb);
    }

    // Run 结束 → Goal 决策 (确定性 reducer, 落盘)
    const finalRunId = result.runId || prevRunId;
    const finalRun = finalRunId ? await readRun(finalRunId) : null;
    if (kind !== 'resume' && finalRun && finalRun.goalId !== goal.goalId) {
      // 新 Run 必须挂在同一 Goal 下; 没挂上就是执行器没接住 goalId → 如实记, 不掩盖
      report.errors.push(`${goal.goalId}: 新 Run ${finalRunId} 未绑定本 Goal (goalId=${finalRun.goalId || '空'})`);
    }
    // 2026-09-16 (2-F): 决策前先做两件事 —— ① 跨 Run 汇总证据; ② 没判据就提候选 (未确认 → 不许完成)。
    //   放在决策之前, 因为"有没有判据/判据是否被满足"正是决策的输入 (之前放在 completed 分支里 = 永远轮不到)。
    try {
      const { aggregateEvidence, proposeForGoal } = await import('./goal-criteria.js');
      await aggregateEvidence(goal.goalId);
      const refreshedBefore = await readGoal(goal.goalId);
      // 只在"这一轮正常跑完"时提候选判据 —— 失败/中断要留给 retry 退避逻辑, 不能把重试变成"交人"
      const ranClean = String(finalRun?.status || '') === 'done';
      if (ranClean && refreshedBefore && !refreshedBefore.successCriteria.length && !['completed', 'failed', 'abandoned'].includes(refreshedBefore.status)) {
        const p = await proposeForGoal(goal.goalId);
        if (p.ok) this.log(`[supervisor] goal=${goal.goalId} 已提候选判据 (待确认, 未确认前不会判完成)`);
        else this.log(`[supervisor] goal=${goal.goalId} 判据生成失败 → 交人: ${p.reason}`);
      }
    } catch (err) {
      this.log(`[supervisor] 证据/判据处理失败: ${(err as Error)?.message}`);
    }

    // 重新读一次 Goal: Run 期间判据可能已被满足 (否则会拿旧快照判决)
    const goalForDecision = (await readGoal(goal.goalId)) || goal;
    const legacy = decideGoalOutcome(goalForDecision, finalRun, { now: this.now(), maxAttempts: this.maxRetries, lastRunStatus: finalRun?.status });

    // ★ 2026-09-25 (飞轮接线 P1): Run 结束**必过收尾飞轮** —— 正常 / 失败 / 中断恢复都走同一条
    //   9 步流水线 (写 Memory · 生成 Skill 候选 · 更新 continuation · 生成用户汇报)。
    //   飞轮决策是权威 (是否继续), 既有 reducer 退化为运输层 (退避/wakeAt/attempts) —— 见 mergeGoalOutcome。
    let closureDecision: ContinuationDecision | null = null;
    let merged: MergedGoalOutcome = {
      goalStatus: legacy.goalStatus,
      continuation: legacy.continuation,
      reason: legacy.reason,
      flywheelStop: false,
      roundsOverridden: false,
    };
    /** 本轮收尾要派遣的能力 (定状态之后才签合同 —— 顺序见下方注释) */
    let capabilityWanted: string | null = null;
    if (finalRun) {
      try {
        const closureRes = await closeRunOnce({
          goalId: goal.goalId,
          runId: finalRun.runId,
          caller: 'supervisor',
          now: new Date(this.now()).toISOString(),
          finalReview: this.finalReviewText(finalRun, result),
          maxRetries: this.maxRetries,
          // ★ 串行收口: 把**申明**的终止原因透传下去 (超时 / 权限·支付·工具失败 / 子阻塞 / 人工停)
          //   —— 只由 Run 事实推导的话回执里只剩笼统的 failure。这里给的就是从该 Run 事实推出来的那一个
          //   (`claimedTerminalKindForRun` 只在事实足够具体时给更细的类别, 且必须与该状态相容)。
          terminalKind: claimedTerminalKindForRun(finalRun),
        });
        if (isRefusal(closureRes)) {
          // 说不清是哪条 Run 的收尾 → 如实记, 不当收过 (也不编一份产物)
          report.errors.push(`${goal.goalId}: 收尾被拒: ${closureRes.reason}`);
          this.emit({ kind: 'run_closure_refused', goalId: goal.goalId, runId: finalRun.runId, message: closureRes.reason });
        } else if (!closureRes.outcome) {
          report.errors.push(`${goal.goalId}: ${closureRes.reason}`);
          this.emit({ kind: 'run_closure_facts_missing', goalId: goal.goalId, runId: finalRun.runId, message: closureRes.reason });
        } else {
          const view = closureRes.outcome;
          closureDecision = view.decision;
          merged = mergeGoalOutcome({
            legacy,
            flywheel: { decision: view.decision, continuation: view.continuation },
            run: finalRun,
            pendingReports: goalForDecision.continuation?.pendingReports ?? [],
            now: new Date(this.now()).toISOString(),
          });
          report.closures.push({
            goalId: goal.goalId,
            runId: finalRun.runId,
            steps: view.steps,
            decision: view.decision.decision,
            memories: view.memories,
            candidates: view.candidates,
            // ★ 串行收口 ②(入口): 这次收尾**开出**的 Skill 试用逐条登记 (结构化面, 与
            //   `skillTrialOpenings` 同一份事实) —— 候选写出来了但没开试用, 这里就短一截, 一眼可见
            trials: [...(view.trials ?? [])].map((t) => ({ ...t, goalId: goal.goalId, runId: finalRun.runId })),
            reportPath: view.reportPath,
            decisionRecordPath: view.decisionRecordPath,
          });
          // ★ 串行收口 ②(入口): 候选产出处开出的试用 —— 逐个登记 (候选写了但没开试用 = 数组短了, 一眼可见)
          for (const t of view.trials ?? []) {
            report.skillTrialOpenings.push({ ...t, goalId: goal.goalId, runId: finalRun.runId });
            if (t.ok) this.log(`[supervisor] goal=${goal.goalId} Skill 试用开出: ${t.skillName} (候选 ${t.candidateId})`);
            else this.log(`[supervisor] goal=${goal.goalId} Skill 试用未开 (卡在 ${t.refusal?.stage ?? '?'}): ${t.skillName} — ${t.refusal?.reason ?? ''}`);
          }
          this.emit({
            kind: 'run_closure',
            goalId: goal.goalId,
            runId: finalRun.runId,
            message: `收尾 ${view.steps} 步 → ${view.decision.decision}`
              + `${closureRes.alreadyClosed ? ' [幂等: 这次收尾由 Runner 先做, 事实读回]' : ''}`
              + ` (memory ${view.memories} · skill 候选 ${view.candidates} · 用户汇报 ${view.userReport.visibleState})`,
          });
        }
      } catch (err) {
        // 收尾失败**不掩盖**: 如实记进 errors, 但仍按运输层决策收口 (不许因为收尾炸了就不写状态)
        report.errors.push(`${goal.goalId}: Run 收尾失败: ${(err as Error)?.message || err}`);
        this.emit({ kind: 'run_closure_failed', goalId: goal.goalId, runId: finalRun.runId, message: String((err as Error)?.message || err) });
      }
      // ★ 串行收口 ②: **下一条 Run 的成功点**结算 Skill 试用 (通道 ⑥ 的真调用方)。
      //   顺序在这里的理由: 试用的兑现证据 = "另一条 Run 成功 + 它的证据面点名了这个 Skill",
      //   所以必须在这条 Run 的结局**已知**之后 (收尾写下的证据面正好是它的输入)。
      //   不成功 → 回退 (rolled_back) 且**不提升**; 成功但证据面没点名 → 留在试用位 (无证据不算复用)。
      //   只写记录 (校验+快照+可回退), 永不写 skills/ —— 见 settleSkillTrialsForRun 的纪律。
      try {
        const settled = await settleSkillTrialsForRun({
          goalId: goal.goalId,
          runId: finalRun.runId,
          runStatus: String(finalRun.status ?? ''),
          now: new Date(this.now()).toISOString(),
          approvedBy: 'supervisor',
        });
        for (const s of settled) {
          report.skillTrials.push({ ...s, runId: finalRun.runId });
          if (s.promoted) {
            this.log(`[supervisor] goal=${goal.goalId} Skill 试用提升: ${s.skillName} → ${s.toVersion} (候选 ${s.candidateId})`);
            this.emit({ kind: 'skill_trial_promoted', goalId: goal.goalId, runId: finalRun.runId, message: s.reason });
          } else if (s.status !== 'trialing') {
            this.log(`[supervisor] goal=${goal.goalId} Skill 试用回退 (不提升): ${s.skillName} — ${s.reason}`);
            this.emit({ kind: 'skill_trial_rolled_back', goalId: goal.goalId, runId: finalRun.runId, message: s.reason });
          }
        }
      } catch (err) {
        // 结算失败不掩盖 (也不影响 Run 的收口): 如实记进 errors
        report.errors.push(`${goal.goalId}: Skill 试用结算失败: ${(err as Error)?.message || err}`);
      }

      // P2: 飞轮说"这一步该派活" → **必发工作合同** (不是发一句话)
      //   能力来源 (权威顺序): ① 这次收尾决策点名的能力 ② continuation 上记的 requiredAgent
      //   ③ **本轮跑之前**飞轮裁决=delegate 时点名的能力 (且本地**仍然**缺它) ——
      //      收尾决策只拿得到 Run 的结果, 拿不到"目标声明的能力本地有没有"这条输入,
      //      所以"缺能力 → 派活"必须能回落到 preflight 的结论; 否则它永远只在判定层成立、
      //      在动作层消失 (P5 ★① 实测: 技能门禁放行之后, 合同还是一份都签不出来)。
      const stillMissing = (await readGoal(goal.goalId))?.continuation?.skillReadiness;
      const stillMissingCap = !!flywheelCapability && stillMissing?.ok === false
        && (stillMissing.missing ?? []).includes(flywheelCapability);
      capabilityWanted = closureDecision?.requiredCapability
        || merged.continuation.requiredAgent
        || (stillMissingCap ? flywheelCapability : null);
      // 变更注入的"版本已下发"记账 (新要求只影响后续 Run; 记下它被第几个 Run 读到)
      await markChangesConsumed(goal.goalId, goalForDecision.runs.length).catch(() => null);
    }

    await this.applyDecision(goal, merged, finalRun);

    // ★ 合同必须在**状态写完之后**签发 (P5 ★① 实测的顺序缺陷):
    //   `applyDecision` 是整份 continuation 的覆盖写 (`setContinuation(decision.continuation)`),
    //   而 `dispatchChildWork` 会把"等这份回报"写进 `continuation.pendingReports` ——
    //   先签发再写状态 ⇒ 刚登记的 pendingReports 立刻被覆盖成空, 父 Goal 上不留痕,
    //   阻塞巡检再次没有输入 (与修复前一样"空转")。顺序: 定状态 → 签合同。
    if (finalRun && capabilityWanted && merged.goalStatus !== 'completed' && !merged.flywheelStop) {
      await this.dispatchIfDelegate(goal.goalId, finalRun, report, capabilityWanted).catch((err) => {
        report.errors.push(`${goal.goalId}: 派遣合同失败: ${(err as Error)?.message || err}`);
      });
    }
    this.emit({ kind: 'goal_decision', goalId: goal.goalId, runId: finalRunId, message: `${finalRun?.status || result.status || '?'} → ${merged.goalStatus}: ${merged.reason}` });
    this.log(`[supervisor] goal=${goal.goalId} run=${finalRunId || '-'} ${finalRun?.status || result.status || '?'} → goal=${merged.goalStatus} (${merged.reason})`
      + `${merged.roundsOverridden ? ' [飞轮覆盖轮次上限]' : ''} ${Date.now() - t0}ms`);

    return { goalId: goal.goalId, runId: finalRunId, status: finalRun?.status || result.status, error: result.error };
  }

  /**
   * Run 收尾用的 Final Review 文本 (P1 的输入契约, 见 run-closure.ts 文件头):
   *   ① 宿主/验收可用 `BOLLOON_RUN_FINAL_REVIEW` 注入结构化评审 (评审人 + 事实 + 教训 + 候选);
   *   ② 否则用执行器这次给的回执文本 —— 散文**也能收尾** (评论非结构化只影响"是否产出教训/候选",
   *      不会让收尾整条跳过)。
   */
  private finalReviewText(run: RunRecord, result: GoalExecutionResult): string {
    const injected = process.env.BOLLOON_RUN_FINAL_REVIEW;
    if (injected && injected.trim()) return injected;
    const parts = [
      result.reply,
      run.summary,
      run.error,
    ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    return parts.join('\n');
  }

  /** 飞轮要求派遣 (decision=delegate) → 签发工作合同并把"等回报"写进 continuation */
  private async dispatchIfDelegate(goalId: string, run: RunRecord, report: TickReport, capability = ''): Promise<void> {
    if (!capability) return;
    const goal = await readGoal(goalId);
    if (!goal) return;
    const nextAction = goal.continuation?.nextAction || `把需要「${capability}」的子目标派出去`;
    const contract = await dispatchChildWork({
      goalId,
      parentRunId: run.runId,
      // 合同只锁"能力", 具体派给谁由执行器解析 (这里如实写能力名, 不假装知道某个 agent 的 id)
      childAgentId: capability,
      capability,
      objective: nextAction,
      inputs: { goalObjective: goal.objective, successCriteria: goal.successCriteria },
      allowedTools: [],
      budget: { maxSteps: null, maxDurationMs: run.budget?.deadlineMs ?? null, maxAmount: null, currency: null },
      deadline: null,
      successCriteria: goal.successCriteria.length ? goal.successCriteria : [nextAction],
      issuedBy: this.owner,
    });
    this.log(`[supervisor] goal=${goalId} 已签发工作合同 workId=${contract.workId} (能力「${capability}」, ${contract.successCriteria.length} 条判据, 必带证据 ${contract.requiredEvidence.length} 条)`);
    this.emit({ kind: 'work_contract_issued', goalId, runId: run.runId, message: `workId=${contract.workId} 能力=${capability}` });
    report.workContracts.push({ goalId, workId: contract.workId, capability });
  }

  /** 把决策写进 Goal (+ 证据同步 + 完成出口), 并写下一次唤醒信息 */
  private async applyDecision(goal: GoalRecord, decision: GoalDecision | MergedGoalOutcome, run: RunRecord | null): Promise<void> {
    // 证据同步: Run 的成功步骤 → Goal 证据 (长期执行的判据要有据可依)
    if (run) {
      const ev = run.steps.filter((s) => s.ok).slice(-5).map((s) => `${run.runId}/${s.tool}: ${String(s.summary || '(完成)').slice(0, 120)}`);
      if (ev.length) await addEvidence(goal.goalId, ev).catch(() => null);
    }

    // 规则 ②: 唯一落盘出口。完成门 (completed 必须过 completeGoalIfEligible) 也在 reducer 里,
    //   门拒绝 → 退回 active 并保留原因 (不许装作完成)。
    const applied = await reduceGoalState({
      goalId: goal.goalId,
      intent: 'closure_outcome',
      now: new Date(this.now()).toISOString(),
      by: this.owner,
      outcome: {
        goalStatus: decision.goalStatus,
        continuation: decision.continuation,
        reason: decision.reason,
      },
      runId: run?.runId ?? null,
    });

    if (applied.gateRejected) {
      this.log(`[supervisor] goal=${goal.goalId} 完成门拒绝: ${applied.gateRejected}`);
    }
    if (!applied.ok) {
      this.log(`[supervisor] goal=${goal.goalId} 决策写不进 Goal (不掩盖): ${applied.reason}`);
      return;
    }
    if (applied.status === 'completed') {
      this.emit({ kind: 'goal_completed', goalId: goal.goalId, runId: run?.runId, message: applied.reason });
      return;
    }
    if (decision.continuation.wakeReason === 'needs_human' || applied.status === 'needs_human') {
      this.emit({ kind: 'needs_human', goalId: goal.goalId, message: decision.reason });
    }
  }

  /**
   * 外部事件到达 → 给对应 Goal 清除等待并加速唤醒 (2-E 第 4 类的入口)
   * 手动唤醒 (CLI `/wake` / `POST /api/goals/:id/wake`): 人明确说"外部条件我已经满足了"。
   *
   * ★ 2026-09-25 (P5 验收修复): 原来只清等待事实、**不改 goal.status** —— `listRunnableGoals`
   *   又按 `status === 'awaiting_external'` 直接跳过, 于是"唤醒"成了空操作:
   *   接口回话 `woke:true`, 目标却仍然醒不过来 (真 tick executed=0)。
   *   真事件路径 (`deliverExternalEvent`) 本来就把状态拉回 `active` —— 两条唤醒路径必须一致。
   *
   * 只拉**等待类**状态: 终态与人已判定的状态 (completed/failed/abandoned/paused/needs_human)
   * 不动 —— 唤醒是"外部条件到了", 不是绕过人的决定。
   */
  async notifyExternal(goalId: string): Promise<boolean> {
    const g = await readGoal(goalId);
    if (!g) return false;
    if (g.continuation?.wakeReason !== 'awaiting_external' && !g.continuation?.needsExternal) return false;
    // 等待类的 continuation.state 也要拉回 `active` (与 goal.status 同步): 界面只读 continuation
    //   (`toUserVisibleState`), 留着 `awaiting_external` 的话页面仍显示"等待外部回复" ——
    //   与"已唤醒、下一次 tick 会推进它"自相矛盾 (真 DOM 就是这么读到的)。
    const wasWaiting = ['awaiting_external', 'retry_wait'].includes(String(g.continuation?.state));
    await setContinuation(goalId, {
      wakeReason: 'active', needsExternal: undefined, autoContinue: true, wakeAt: undefined,
      ...(wasWaiting ? { state: 'active' as const } : {}),
    });
    if (g.status === 'awaiting_external') {
      // 规则 ②: 唤醒也是一种 Goal 状态变更 → 走 Goal reducer, 不在调用方手写 updateGoal
      await reduceGoalState({
        goalId,
        intent: 'manual_wake',
        now: new Date().toISOString(),
        by: 'human',
        reason: '人工唤醒 (外部条件已满足)',
      }).catch(() => null);
    }
    await bumpContinuationAttempts(goalId); // 记一次唤醒 (可观测)
    return true;
  }

  /**
   * ★ 2026-09-25 (串行收口 ④): **非 web 路径**提一条新要求/撤销 —— CLI 与宿主进程都走它。
   *
   * 为什么要挂在 Supervisor 上: 撤销 (用户说"别继续做了") 的语义是"停住在跑的 Run + 只影响后续 Run",
   * 而这件事**只有一个正确做法** (M4 的 change 接缝: 判定 + 事实注入 + 停止原语)。以前只有
   * `/api/goals/:id/requirement` 那条 HTTP 路由会走到它 —— 于是 CLI / 宿主直接调 `ingestGoalChange`
   * 时, 在跑的 Run **停不下来** (接缝拿到的是 `factsMissing=true`, 只能如实说"不知道"）。
   *
   * 这里就是那个入口: 读事实 (`runningRun` / 在跑的子 Agent) → 接缝判定 → 真停 Run (`setRunStatus`)。
   * 返回值原样透出接缝视图 (含 `runBoundary.stopped` 与逐 workId 的下发内容), 拒绝也原样透出。
   */
  async ingestRequirement(goalId: string, instruction: string, by = 'human'): Promise<
    | { ok: true; kind: string; outcome: string; stopped: boolean; runId: string | null; visibleState: string | null; note: string }
    | { ok: false; reason: string }
  > {
    const now = new Date(this.now()).toISOString();
    const view = await ingestRequirementViaSeam({
      goalId,
      instruction,
      source: 'user',
      recordedBy: `cli:${by}`,
      caller: 'human',      // 人提的变更: 只有人能提撤销/缩范围
      now,
    });
    if (view === null) return { ok: false, reason: `变更无法入档 (goal=${goalId})` };
    if (isRefusal(view)) return { ok: false, reason: view.reason };

    const b = view.runBoundary;
    const note = b.action === 'stop_running_run'
      ? (b.stopped
        ? `在跑的 Run ${b.runId} 已写 ${b.runStatus} (执行器下一轮自行停下)`
        : `判定要停 Run ${b.runId}, 但停止动作没落到记录上: ${b.reason}`)
      : b.reason;
    this.emit({ kind: 'requirement_ingested', goalId, message: `${view.request.kind} (${view.plan.outcome}) — ${note}` });
    this.log(`[supervisor] goal=${goalId} 变更入档: ${view.request.kind} → ${view.plan.outcome}; ${note}`);
    return {
      ok: true,
      kind: view.request.kind,
      outcome: view.plan.outcome,
      stopped: b.stopped,
      runId: b.runId,
      visibleState: view.visibleState,
      note,
    };
  }
}

/** 单例 (Web/CLI 共享同一个进程内调度器; 跨进程靠 lease 排他) */
let singleton: ExecutionSupervisor | null = null;

export function getSupervisor(opts?: SupervisorOptions): ExecutionSupervisor {
  if (!singleton) singleton = new ExecutionSupervisor(opts);
  return singleton;
}

export function resetSupervisorForTest(): void {
  singleton?.stop();
  singleton = null;
}
