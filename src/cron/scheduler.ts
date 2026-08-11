/**
 * scheduler.ts — 定时任务调度器
 *
 * 借鉴 Hermes agent cron/scheduler.py 心智:
 *   - 一个 tick() 扫描全部 enabled jobs, 用 parseSchedule 判断是否 due (下次时间 <= now)
 *   - due → 执行 exec(job), 完成后 markRun 更新 lastRunAt
 *   - 并发保护: 正在运行的 jobId 集合, 避免同一 job 并行重复触发
 *   - exec 可注入: bolloon CLI 里把 job.prompt 投给 agent 调度闭环, 测试里可注入 fake
 *   - 不建数据库, 不引入外部调度 —— 由调用方 (CLI 主循环) 定期调 tick()
 */

import * as os from 'os';
import type { CronJob } from './jobs-store.js';
import { listJobs, markRun } from './jobs-store.js';
import { parseSchedule, nextAfter } from './cron-parser.js';

export interface SchedulerOptions {
  /** 执行一个 job. 返回 true 代表成功 (成功才 markRun). */
  exec: (job: CronJob) => Promise<void>;
  /** 可选: 提供"当前时间", 便于测试 */
  now?: () => Date;
  /** 可选: 数据目录 (默认 os.homedir(), 测试可传临时目录) */
  home?: string;
}

export class Scheduler {
  private exec: (job: CronJob) => Promise<void>;
  private now: () => Date;
  private home: string;
  /** 正在运行的 job id, 防止并行重复触发 */
  private running = new Set<string>();
  /** 已触发但执行失败, 待下次重试 (避免死循环 + 可观测) */
  private failed = new Map<string, number>();

  constructor(opts: SchedulerOptions) {
    this.exec = opts.exec;
    this.now = opts.now ?? (() => new Date());
    this.home = opts.home ?? os.homedir();
  }

  /** 是否正在运行某 job (供外部查询并发状态) */
  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  /**
   * 一次调度心跳. 找出所有 due 的 enabled job 并执行 (串行), 成功者 markRun.
   * @returns 本次执行数量
   */
  async tick(): Promise<number> {
    const now = this.now();
    const jobs = await listJobs(this.home);
    let ran = 0;
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.running.has(job.id)) continue; // 正在跑, 跳过防重入
      const parsed = parseSchedule(job.schedule, now);
      if (!parsed) continue; // 解析不了的调度, 跳过 (可另做告警)
      const lastRunAt = job.lastRunAt ? new Date(job.lastRunAt) : undefined;
      const due = nextAfter(job.schedule, lastRunAt, now);
      if (due && due.getTime() > now.getTime()) continue; // 还不到时间 (含首次: 立即触发)
      this.running.add(job.id);
      try {
        await this.exec(job);
        await markRun(job.id, now.toISOString(), this.home);
        this.failed.delete(job.id);
        ran += 1;
      } catch (e) {
        this.failed.set(job.id, (this.failed.get(job.id) ?? 0) + 1);
        console.error(`[scheduler] job 执行失败 (${job.name}):`, (e as Error)?.message ?? e);
      } finally {
        this.running.delete(job.id);
      }
    }
    return ran;
  }

  /** 最近失败统计 (供诊断) */
  failureCounts(): ReadonlyMap<string, number> {
    return this.failed;
  }
}