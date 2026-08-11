/**
 * jobs-store.ts — 定时任务 (schedule jobs) 持久化
 *
 * 借鉴 Hermes agent cron/scheduler.py 心智:
 *   - 每条 job 有: id / name / schedule (cron 或 every N) / prompt (执行体) / enabled
 *   - 记录 lastRunAt / runCount, 调度器 tick 时找出 due 的 job 执行
 *   - 落盘 ~/.bolloon/cron-jobs.json, 进程内互斥链序列化 + 临时文件原子写
 *   - 不建数据库, 不引入外部调度系统 —— 单文件 + 内存互斥
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface CronJob {
  id: string;
  name: string;
  /** e.g. "0 8 * * *" / "every 30m" / "1h" */
  schedule: string;
  /** 要投给 agent 的执行指令 (LLM prompt) */
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
}

interface JobsFile {
  version: 1;
  jobs: CronJob[];
}

function getJobsPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'cron-jobs.json');
}

let jobsLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = jobsLock.then(fn);
  jobsLock = run.then(() => undefined, () => undefined);
  return run;
}

async function readAll(home: string): Promise<JobsFile> {
  try {
    const raw = await fs.readFile(getJobsPath(home), 'utf-8');
    const p = JSON.parse(raw) as JobsFile;
    if (p?.version === 1 && Array.isArray(p.jobs)) return p;
    return { version: 1, jobs: [] };
  } catch {
    return { version: 1, jobs: [] };
  }
}

async function writeAll(file: JobsFile, home: string): Promise<void> {
  const p = getJobsPath(home);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}

export interface NewJobInput {
  name: string;
  schedule: string;
  prompt: string;
}

export async function addJob(input: NewJobInput, home: string = os.homedir()): Promise<CronJob> {
  return withLock(async () => {
    const file = await readAll(home);
    const job: CronJob = {
      id: crypto.randomUUID(),
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    file.jobs.push(job);
    await writeAll(file, home);
    return job;
  });
}

export async function listJobs(home: string = os.homedir()): Promise<CronJob[]> {
  return withLock(async () => (await readAll(home)).jobs);
}

export async function removeJob(id: string, home: string = os.homedir()): Promise<boolean> {
  return withLock(async () => {
    const file = await readAll(home);
    const before = file.jobs.length;
    file.jobs = file.jobs.filter((j) => j.id !== id);
    if (file.jobs.length === before) return false;
    await writeAll(file, home);
    return true;
  });
}

export async function setEnabled(id: string, enabled: boolean, home: string = os.homedir()): Promise<CronJob | null> {
  return withLock(async () => {
    const file = await readAll(home);
    const job = file.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.enabled = enabled;
    await writeAll(file, home);
    return job;
  });
}

/** 标记已运行: 更新 lastRunAt + runCount (runId 用于并行保护, 由 scheduler 提供) */
export async function markRun(id: string, at: string, home: string = os.homedir()): Promise<CronJob | null> {
  return withLock(async () => {
    const file = await readAll(home);
    const job = file.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.lastRunAt = at;
    job.runCount += 1;
    await writeAll(file, home);
    return job;
  });
}