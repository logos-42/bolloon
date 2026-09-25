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
  completeGoalIfEligible,
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
import {
  applyBlockHandling,
  closeGoalRun,
  collectWorkBlocks,
  decideGoalStep,
  dispatchChildWork,
  flywheelTickNote,
  lifecycleOf,
  listGoalsWithPendingWork,
  markChangesConsumed,
  mergeGoalOutcome,
  nextRunChangeDirective,
  pendingContractDigest,
  type FlywheelTickNote,
  type GoalStepDecision,
  type MergedGoalOutcome,
} from './goal-flywheel-wiring.js';

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
  /** 2026-09-25 (飞轮接线 P1): 每个 Run 的收尾流水线结论 (9 步 + 产物路径) */
  closures: {
    goalId: string; runId: string; steps: number; decision: string;
    memories: number; candidates: number; reportPath: string; decisionRecordPath: string;
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

      // 2.5 (2026-09-25, 飞轮接线 P3): 阻塞巡检 —— **不看进程存活, 看任务是否卡住**
      //   只对"还有子 Agent 工作没回报"的 Goal 做 (有界), 由 detectBlocks + planBlockHandling 给结论;
      //   接管 / 升级 / 要求补齐这些副作用在这里执行 (设计 §8)。
      try {
        for (const g of await listGoalsWithPendingWork()) {
          const blocks = await collectWorkBlocks({ goalId: g.goalId, now: nowIso, runnerAvailable: this.canExecute });
          if (blocks.length === 0) continue;
          const handling = await applyBlockHandling({ goalId: g.goalId, blocks, now: nowIso });
          for (const a of handling.actions) {
            report.blocks.push({ goalId: g.goalId, workId: a.workId, kind: a.kind, action: a.action, note: a.note });
          }
          if (handling.actions.length) {
            this.log(`[supervisor] goal=${g.goalId} 阻塞巡检: ${handling.actions.map((a) => `${a.kind}→${a.action}`).join(', ')}`);
          }
          if (handling.escalated.length) this.emit({ kind: 'needs_human', goalId: g.goalId, message: `子 Agent 工作升级到人: ${handling.escalated.join(', ')}` });
          if (handling.takeovers.length) this.log(`[supervisor] goal=${g.goalId} 父接管子工作 (无心跳 + 执行权空闲 + 合同允许): ${handling.takeovers.join(', ')}`);
        }
      } catch (err) {
        report.errors.push(`阻塞巡检: ${(err as Error)?.message || err}`);
      }

      // 3. 逐个推进 (每个 Goal: 节奏判定 → 抢 lease → 执行 → 收尾 → 决策 → 释放 lease)
      for (const goal of runnable.slice(0, this.maxPerTick)) {
        // 3.1 (P0) 节奏由进展决定: 读权威 continuation + 最近 Run 进展 → decideContinuation
        //     + applyHardLimits + isRunnable。没进展就不开新轮 (硬底线只能收紧)。
        let step: GoalStepDecision | null = null;
        try {
          step = await decideGoalStep({ goalId: goal.goalId, now: nowIso, maxRetries: this.maxRetries, writeRecord: true });
        } catch (err) {
          report.errors.push(`${goal.goalId}: 节奏判定失败 ${(err as Error)?.message || err}`);
        }
        if (step) {
          report.flywheel.push(await flywheelTickNote({ goalId: goal.goalId, step, now: nowIso }).catch(() => ({
            goalId: goal.goalId,
            decision: step!.decision?.decision ?? 'first_run',
            state: step!.decision?.state ?? 'progressing',
            runnable: step!.runnable,
            reason: step!.reason,
            noProgressStreak: step!.noProgressStreak,
            visibleState: 'executing' as const,
            nextAction: step!.decision?.nextAction ?? '(首个 Run)',
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
          const res = await this.runGoal(goal, leaseId, report);
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
      flywheel: [], blocks: [], closures: [], workContracts: [],
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
    const { updateGoal } = await import('./goal-store.js');
    const hardLine = /硬底线/.test(step.reason);
    const stop = d.decision === 'fail'
      || d.decision === 'pause'
      || (d.decision === 'ask_human' && (d.state === 'no_progress' || d.state === 'blocked'))
      || hardLine;
    if (!stop) return;

    const status: GoalStatus = d.decision === 'fail' ? 'failed' : d.decision === 'pause' ? 'paused' : 'needs_human';
    const goal = await readGoal(goalId);
    if (!goal) return;
    if (goal.status !== status && !['completed', 'failed', 'abandoned'].includes(goal.status)) {
      await updateGoal(goalId, status === 'failed'
        ? { status, resolution: { reason: `飞轮判不可达: ${d.reason}`, at: now } }
        : { status });
    }
    await setContinuation(goalId, {
      state: lifecycleOf(status),
      autoContinue: false,
      wakeAt: undefined,
      wakeReason: status === 'failed' ? 'failed' : status === 'paused' ? 'paused' : 'needs_human',
      lastDecisionId: d.decisionId,
      unresolvedItems: [...d.unresolvedItems],
      nextAction: d.nextAction,
      updatedAt: now,
    });
    this.emit({ kind: status === 'needs_human' ? 'needs_human' : status, goalId, message: d.reason });
    this.log(`[supervisor] goal=${goalId} 飞轮判停 → ${status}: ${d.reason}`);
  }

  /** 认领后执行一个 Goal: 决定 resume 还是开新 Run → 跑 → 决策 Goal 状态 */
  private async runGoal(goal: GoalRecord, leaseId: string, report: TickReport): Promise<{ goalId: string; runId?: string; status?: string; error?: string }> {
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
    try {
      const { decideGoalStep } = await import('./goal-flywheel-wiring.js');
      const step = await decideGoalStep({
        goalId: goal.goalId, now: new Date(this.now()).toISOString(), maxRetries: this.maxRetries, writeRecord: false,
      });
      flywheelDelegates = step?.decision?.decision === 'delegate';
      flywheelCapability = step?.decision?.requiredCapability || '';
    } catch { /* 决策层不可用 → 不改变门禁行为 (fail-closed, 照旧拦) */ }
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
        const closure = await closeGoalRun({
          goalId: goal.goalId,
          runId: finalRun.runId,
          now: new Date(this.now()).toISOString(),
          finalReview: this.finalReviewText(finalRun, result),
          maxRetries: this.maxRetries,
        });
        if (closure) {
          closureDecision = closure.result.decision;
          merged = mergeGoalOutcome({
            legacy,
            flywheel: closure.result,
            run: finalRun,
            pendingReports: goalForDecision.continuation?.pendingReports ?? [],
            now: new Date(this.now()).toISOString(),
          });
          report.closures.push({
            goalId: goal.goalId,
            runId: finalRun.runId,
            steps: closure.result.steps.length,
            decision: closure.result.decision.decision,
            memories: closure.written.length,
            candidates: closure.result.candidates.length,
            reportPath: closure.reportPath,
            decisionRecordPath: closure.decisionRecordPath,
          });
          this.emit({
            kind: 'run_closure',
            goalId: goal.goalId,
            runId: finalRun.runId,
            message: `收尾 ${closure.result.steps.length} 步 → ${closure.result.decision.decision}`
              +` (memory ${closure.written.length} · skill 候选 ${closure.result.candidates.length} · 用户汇报 ${closure.result.userReport.visibleState})`,
          });
        }
      } catch (err) {
        // 收尾失败**不掩盖**: 如实记进 errors, 但仍按运输层决策收口 (不许因为收尾炸了就不写状态)
        report.errors.push(`${goal.goalId}: Run 收尾失败: ${(err as Error)?.message || err}`);
        this.emit({ kind: 'run_closure_failed', goalId: goal.goalId, runId: finalRun.runId, message: String((err as Error)?.message || err) });
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
    const { updateGoal } = await import('./goal-store.js');

    // 证据同步: Run 的成功步骤 → Goal 证据 (长期执行的判据要有据可依)
    if (run) {
      const ev = run.steps.filter((s) => s.ok).slice(-5).map((s) => `${run.runId}/${s.tool}: ${String(s.summary || '(完成)').slice(0, 120)}`);
      if (ev.length) await addEvidence(goal.goalId, ev).catch(() => null);
    }

    // 唯一完成出口: 只有经 completeGoalIfEligible 才能把 Goal 判成 completed
    if (decision.goalStatus === 'completed') {
      // 完成门 (判据存在 + 已确认 + 全满足 + 有证据 + 无未解决项 + 最近 Run 健康)
      const r = await completeGoalIfEligible(goal.goalId);
      if (!r.ok) {
        // 完成门拒绝 → 如实退回 active, 并保留原因 (不许装作完成)
        await setContinuation(goal.goalId, { ...decision.continuation, wakeReason: 'active', autoContinue: true });
        await updateGoal(goal.goalId, { status: 'active' });
        this.log(`[supervisor] goal=${goal.goalId} 完成门拒绝: ${r.reason}`);
        return;
      }
      if (decision.continuation.wakeReason !== 'completed') await setContinuation(goal.goalId, decision.continuation);
      this.emit({ kind: 'goal_completed', goalId: goal.goalId, runId: run?.runId, message: decision.reason });
      return;
    }

    if (decision.goalStatus !== goal.status) await updateGoal(goal.goalId, { status: decision.goalStatus });
    await setContinuation(goal.goalId, decision.continuation);

    if (decision.continuation.wakeReason === 'needs_human') {
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
      const { updateGoal } = await import('./goal-store.js');
      await updateGoal(goalId, { status: 'active' } as any).catch(() => { /* 状态写失败不影响把等待清掉 */ });
    }
    await bumpContinuationAttempts(goalId); // 记一次唤醒 (可观测)
    return true;
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
