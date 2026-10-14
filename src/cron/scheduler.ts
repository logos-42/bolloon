/**
 * scheduler.ts — 调度器 (心跳循环 + 跨进程锁 + 执行记录 + 超时 + 熔断 + misfire)
 *
 * 结构:
 *   start()/stop()   定时器 (unref, 不拖住进程)
 *   tickOnce()       一次心跳: 先拿跨进程 tick 锁 → 查勿扰 (DND) → 扫 due job
 *   tick()           兼容旧调用: 等价于 tickOnce() 并返回"成功执行数"
 *
 * 一次心跳的完整语义:
 *   1. tick 锁 (进程间文件锁): 拿不到 → 本轮直接跳过 (不阻塞、不排队)
 *   2. 勿扰闸门: 主任务在跑 / 命中静默时段 / 配置关闭 → 不执行任何 job,
 *      只给 due 但被压住的 job 记一条 status:'deferred' 的事件 (不累计失败)
 *   3. 逐个 due job: 幂等检查 (同一触发点只跑一次) → misfire 判定 → 开 running 记录
 *      → 带超时执行 → 落 ok/failed/timeout → 更新 job 状态
 *   4. 熔断: 连续失败达 failureLimit → pausedReason='continuous-failure', 不再自动执行
 *
 * 并发保护:
 *   - 跨进程: tick 锁
 *   - 进程内: running 集合 (同一 job 不并行重复触发)
 *   - 幂等: 同一 (jobId + 触发点) 已有 running/ok 记录 → 跳过
 *
 * 安静性: 本模块不写 stdout/stderr; 事件只经 monitor 的日志出口 (默认落文件).
 */

import * as os from 'os';
import * as crypto from 'crypto';
import type { CronJob } from './jobs-store.js';
import { listJobs, markRun, updateJob, DEFAULT_JOB_TIMEOUT_MS, DEFAULT_FAILURE_LIMIT } from './jobs-store.js';
import { parseSchedule, nextAfter } from './cron-parser.js';
import { acquireTickLock, DEFAULT_STALE_MS, type TickLockInfo, type TickLockLogger } from './tick-lock.js';
import {
  listExecutions,
  markFinished,
  markStarted,
  recordNote,
  findBlockingRun,
  type ExecutionRecord,
} from './executions-store.js';
import { cronLog } from './monitor.js';
import { resolveDnd, type DndReason } from './dnd.js';

export interface SchedulerOptions {
  /** 执行一个 job. 抛异常 = 失败; 返回值忽略 (可只做副作用) */
  exec: (job: CronJob) => Promise<void>;
  /** 可选: 提供"当前时间", 便于测试 */
  now?: () => Date;
  /** 可选: 数据目录 (默认 os.homedir(), 测试可传临时目录) */
  home?: string;
  /** 可选: tick 锁陈旧阈值 (ms) */
  lockStaleMs?: number;
}

export interface JobRunSummary {
  jobId: string;
  jobName: string;
  scheduledFor: string;
  status: 'ok' | 'failed' | 'timeout' | 'skipped' | 'missed' | 'deferred';
  durationMs?: number;
  error?: string;
  /** skipped 的原因: already-ran / paused / running */
  reason?: string;
  /** misfire: 本次补齐跳过了几个触发点 */
  missedOccurrences?: number;
}

export interface TickResult {
  tickId: string;
  /** ISO 时间 */
  startedAt: string;
  durationMs: number;
  ran: number;
  skipped: number;
  failed: number;
  lock: { acquired: boolean; tickId?: string; holder?: TickLockInfo | null };
  /** 本轮为何没执行任何 job */
  reason?: 'locked' | 'dnd';
  /** reason='locked' 时的持锁者 */
  holder?: TickLockInfo | null;
  /** reason='dnd' 时的勿扰来源 */
  dndReason?: DndReason;
  /** 本轮整体被跳过 (锁被占用 / 勿扰模式), 未扫描任何 job */
  skippedRound?: boolean;
  jobs: JobRunSummary[];
}

export interface StartOptions {
  intervalMs?: number;
  tickTimeoutMs?: number;
}

/** job 执行超时 (与普通 Error 区分, 便于记 timeout 而非 failed) */
export class JobTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`job 执行超时 (>${timeoutMs}ms)`);
    this.name = 'JobTimeoutError';
  }
}

/** 带超时执行: 超时抛 JobTimeoutError; 超时后原 promise 的 rejection 被吞掉, 不触发 unhandledRejection */
export async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  const p = run();
  void p.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(ms)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 严格晚于 after 的下一个触发点 (interval 型 = after + period; cron 型 = 下一分钟匹配) */
export function nextStrictlyAfter(schedule: string, after: Date): Date | null {
  const p = parseSchedule(schedule, after);
  return p ? p.next : null;
}

/**
 * misfire 统计: due 之后还有几个触发点已经错过 (>= 1 即视为 misfire).
 * 有上限保护, 不因超长间隔/异常表达式死循环.
 */
export function countMissedOccurrences(schedule: string, due: Date, now: Date, max = 500): number {
  let cursor = nextStrictlyAfter(schedule, due);
  let missed = 0;
  while (cursor && cursor.getTime() <= now.getTime() && missed < max) {
    missed += 1;
    const nxt = nextStrictlyAfter(schedule, cursor);
    if (!nxt || nxt.getTime() <= cursor.getTime()) break;
    cursor = nxt;
  }
  return missed;
}

// ---------------------------------------------------------------- Scheduler

export class Scheduler {
  private exec: (job: CronJob) => Promise<void>;
  private now: () => Date;
  private home: string;
  private lockStaleMs: number;
  /** 正在运行的 job id, 防止并行重复触发 */
  private running = new Set<string>();
  /** 进程内连续失败计数 (供诊断) */
  private failed = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = 60_000;
  private tickTimeoutMs = 300_000;

  constructor(opts: SchedulerOptions) {
    this.exec = opts.exec;
    this.now = opts.now ?? (() => new Date());
    this.home = opts.home ?? os.homedir();
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_STALE_MS;
  }

  /** 是否正在运行某 job (供外部查询并发状态) */
  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  /** 最近失败统计 (供诊断) */
  failureCounts(): ReadonlyMap<string, number> {
    return this.failed;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  getTickTimeoutMs(): number {
    return this.tickTimeoutMs;
  }

  /**
   * 启动定时心跳. 定时器 unref() —— 绝不拖住进程退出. 重复调用幂等.
   */
  start(opts: StartOptions = {}): void {
    if (opts.intervalMs != null) this.intervalMs = Math.max(1, opts.intervalMs);
    if (opts.tickTimeoutMs != null) this.tickTimeoutMs = Math.max(1, opts.tickTimeoutMs);
    if (this.timer) return; // 已启动
    this.timer = setInterval(() => {
      void this.tickOnce().catch(() => {
        /* 单轮心跳异常不得打死定时器; 细节已落 monitor.log */
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 停止心跳并清理定时器 (幂等) */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 兼容旧调用: 一次心跳, 返回成功执行的数量 */
  async tick(): Promise<number> {
    const res = await this.tickOnce();
    return res.ran;
  }

  /** 一次完整心跳 (带锁 + 勿扰闸门 + 幂等 + 超时 + 熔断) */
  async tickOnce(): Promise<TickResult> {
    const now = this.now();
    const startedAt = now.toISOString();
    const t0 = Date.now();
    const tickId = crypto.randomUUID();

    const lock = await acquireTickLock({
      home: this.home,
      now: this.now,
      staleMs: this.lockStaleMs,
      log: this.lockLogger(),
    });

    if (!lock.acquired) {
      // 不阻塞、不排队: 本轮直接跳过, 由持锁者负责这一轮
      cronLog('info', 'tick', 'tick 跳过 (锁被其他进程占用)', { tickId, holder: lock.holder }, this.home);
      return {
        tickId,
        startedAt,
        durationMs: Date.now() - t0,
        ran: 0,
        skipped: 1,
        failed: 0,
        lock: { acquired: false, holder: lock.holder },
        reason: 'locked',
        holder: lock.holder,
        skippedRound: true,
        jobs: [],
      };
    }

    try {
      const records = await listExecutions({ home: this.home });
      const dnd = await resolveDnd(this.home, { now });

      if (dnd.dnd) {
        // 勿扰: 一个 job 都不跑, 也不累计失败; due 的 job 记 deferred, 下次非 DND 心跳补跑
        const deferred = await this.deferDue(now, dnd.reason, records);
        cronLog('info', 'tick', 'tick 因勿扰跳过', { tickId, dndReason: dnd.reason, deferred: deferred.length }, this.home);
        return {
          tickId,
          startedAt,
          durationMs: Date.now() - t0,
          ran: 0,
          skipped: deferred.length || 1,
          failed: 0,
          lock: { acquired: true, tickId },
          reason: 'dnd',
          dndReason: dnd.reason,
          skippedRound: true,
          jobs: deferred,
        };
      }

      const jobs = await this.runDue(now, tickId, records);
      const ran = jobs.filter((j) => j.status === 'ok').length;
      const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'timeout').length;
      const skipped = jobs.filter((j) => j.status !== 'ok' && j.status !== 'failed' && j.status !== 'timeout').length;
      const durationMs = Date.now() - t0;
      cronLog(
        'info',
        'tick',
        `tick 完成: 跑 ${ran}, 跳过 ${skipped}, 失败 ${failed}`,
        { tickId, ran, skipped, failed, durationMs },
        this.home,
      );
      return {
        tickId,
        startedAt,
        durationMs,
        ran,
        skipped,
        failed,
        lock: { acquired: true, tickId },
        jobs,
      };
    } finally {
      await lock.release();
    }
  }

  /** tick 锁的日志出口 → monitor 事件 (不写 stdout/stderr) */
  private lockLogger(): TickLockLogger {
    return (level, message, detail) => {
      cronLog(level, 'tick-lock', message, detail as Record<string, unknown>, this.home);
    };
  }

  /** 扫出所有 enabled 且已到点的 job (paused 的也返回, 由调用方决定如何记) */
  private async collectDue(now: Date): Promise<Array<{ job: CronJob; due: Date }>> {
    const jobs = await listJobs(this.home);
    const out: Array<{ job: CronJob; due: Date }> = [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      const parsed = parseSchedule(job.schedule, now);
      if (!parsed) continue; // 解析不了的调度: 跳过 (由 monitor/健康摘要暴露)
      const lastRunAt = job.lastRunAt ? new Date(job.lastRunAt) : undefined;
      const due = nextAfter(job.schedule, lastRunAt, now);
      if (!due || due.getTime() > now.getTime()) continue; // 还不到点
      out.push({ job, due });
    }
    return out;
  }

  /** 勿扰期间: 给 due 但被压住的 job 记一条 deferred, 不执行、不累计失败 */
  private async deferDue(now: Date, dndReason: DndReason, records: ExecutionRecord[]): Promise<JobRunSummary[]> {
    const out: JobRunSummary[] = [];
    for (const { job, due } of await this.collectDue(now)) {
      if (job.pausedReason) continue; // 已熔断的 job 与勿扰无关, 不记 deferred
      const scheduledFor = due.toISOString();
      if (findBlockingRun(records, job.id, scheduledFor)) continue; // 这个触发点已经跑过
      // 一轮勿扰 episode (自上次真正运行以来) 每个 job 只记一条 deferred, 不逐心跳刷屏
      const sinceRun = job.lastRunAt ? Date.parse(job.lastRunAt) : Number.NEGATIVE_INFINITY;
      const alreadyDeferred = records.some(
        (r) => r.jobId === job.id && r.status === 'deferred' && (Date.parse(r.scheduledFor) || 0) > sinceRun,
      );
      if (alreadyDeferred) continue;
      const note = await recordNote(
        {
          runId: `deferred:${job.id}:${scheduledFor}`,
          jobId: job.id,
          jobName: job.name,
          scheduledFor,
          status: 'deferred',
          at: now.toISOString(),
          outputSummary: `勿扰模式 (${dndReason}) 压住, 待恢复后补跑 1 次`,
        },
        this.home,
      );
      records.push(note);
      out.push({ jobId: job.id, jobName: job.name, scheduledFor, status: 'deferred', reason: dndReason });
    }
    return out;
  }

  // __APPEND2__

  /** 执行全部 due job (串行). 单点事件 (missed) 先记, 再补跑 1 次. */
  private async runDue(now: Date, tickId: string, records: ExecutionRecord[]): Promise<JobRunSummary[]> {
    const out: JobRunSummary[] = [];
    for (const { job, due } of await this.collectDue(now)) {
      const scheduledFor = due.toISOString();

      if (job.pausedReason) {
        out.push({ jobId: job.id, jobName: job.name, scheduledFor, status: 'skipped', reason: 'paused' });
        continue;
      }
      if (this.running.has(job.id)) {
        out.push({ jobId: job.id, jobName: job.name, scheduledFor, status: 'skipped', reason: 'running' });
        continue;
      }
      // 幂等: 同一 (jobId + 触发点) 已有 running/ok → 不再重复执行
      if (findBlockingRun(records, job.id, scheduledFor)) {
        out.push({ jobId: job.id, jobName: job.name, scheduledFor, status: 'skipped', reason: 'already-ran' });
        continue;
      }

      // misfire: 错过多个周期只补跑 1 次, 先记一条 missed 说明跳过了几个触发点
      const missed = countMissedOccurrences(job.schedule, due, now);
      if (missed > 0) {
        const missedRunId = `missed:${job.id}:${scheduledFor}`;
        if (!records.some((r) => r.runId === missedRunId)) {
          const note = await recordNote(
            {
              runId: missedRunId,
              jobId: job.id,
              jobName: job.name,
              scheduledFor,
              status: 'missed',
              at: now.toISOString(),
              outputSummary: `misfire: 错过 ${missed} 个触发点, 仅补跑 1 次`,
            },
            this.home,
          );
          records.push(note);
          out.push({
            jobId: job.id,
            jobName: job.name,
            scheduledFor,
            status: 'missed',
            missedOccurrences: missed,
          });
        }
      }

      out.push(await this.executeJob(job, due, now, tickId, records));
    }
    return out;
  }

  /** 执行单个 job: running 记录 → 带超时执行 → 落终态 → 更新 job (熔断/清零) */
  private async executeJob(
    job: CronJob,
    due: Date,
    now: Date,
    tickId: string,
    records: ExecutionRecord[],
  ): Promise<JobRunSummary> {
    const scheduledFor = due.toISOString();
    const runId = `${tickId}:${job.id}`; // runId 带 tickId + jobId
    const attempt = (job.continuousFailures ?? 0) + 1;
    const timeoutMs = job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const limit = job.failureLimit ?? DEFAULT_FAILURE_LIMIT;
    const startedAt = now.toISOString();
    const t0 = Date.now();

    this.running.add(job.id);
    try {
      await markStarted({ runId, jobId: job.id, jobName: job.name, scheduledFor, startedAt, attempt }, this.home);

      await withTimeout(() => this.exec(job), timeoutMs);
      const durationMs = Date.now() - t0;
      const finishedAt = this.now().toISOString();
      await markFinished(
        runId,
        { status: 'ok', durationMs, finishedAt, jobId: job.id, jobName: job.name, scheduledFor },
        this.home,
      );
      await markRun(job.id, finishedAt, this.home, { status: 'ok', durationMs, nextRunAt: scheduledFor });
      if ((job.continuousFailures ?? 0) !== 0) await updateJob(job.id, { continuousFailures: 0 }, this.home);
      this.failed.delete(job.id);
      records.push({
        runId,
        jobId: job.id,
        jobName: job.name,
        scheduledFor,
        startedAt,
        finishedAt,
        status: 'ok',
        attempt,
        durationMs,
      });
      return { jobId: job.id, jobName: job.name, scheduledFor, status: 'ok', durationMs };
    } catch (e) {
      const durationMs = Date.now() - t0;
      const timedOut = e instanceof JobTimeoutError;
      const status: 'failed' | 'timeout' = timedOut ? 'timeout' : 'failed';
      const error = ((e as Error)?.message ?? String(e)).slice(0, 500);
      const finishedAt = this.now().toISOString();
      await markFinished(
        runId,
        { status, durationMs, error, finishedAt, jobId: job.id, jobName: job.name, scheduledFor },
        this.home,
      );
      const streak = (job.continuousFailures ?? 0) + 1;
      await markRun(job.id, finishedAt, this.home, { status, durationMs, error, nextRunAt: scheduledFor });
      const patch: Partial<CronJob> = { continuousFailures: streak, lastError: error };
      if (streak >= limit) patch.pausedReason = 'continuous-failure'; // 熔断: 需人工 resume
      await updateJob(job.id, patch, this.home);
      this.failed.set(job.id, (this.failed.get(job.id) ?? 0) + 1);
      cronLog(
        'warn',
        'job',
        `job ${status}: ${job.name}`,
        { jobId: job.id, runId, error, streak, limit, paused: streak >= limit },
        this.home,
      );
      records.push({
        runId,
        jobId: job.id,
        jobName: job.name,
        scheduledFor,
        startedAt,
        finishedAt,
        status,
        attempt,
        error,
        durationMs,
      });
      return { jobId: job.id, jobName: job.name, scheduledFor, status, error, durationMs };
    } finally {
      this.running.delete(job.id);
    }
  }
}

