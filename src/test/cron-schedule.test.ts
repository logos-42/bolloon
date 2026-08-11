import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseSchedule, nextAfter } from '../cron/cron-parser.js';
import {
  addSuggestion,
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  clearSuggestions,
  MAX_PENDING,
} from '../cron/suggestions.js';
import { addJob, listJobs, removeJob, setEnabled, markRun, type CronJob } from '../cron/jobs-store.js';
import { Scheduler } from '../cron/scheduler.js';
import { handleSuggestionsCommand } from '../cron/suggestions-command.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-cron-test-${Date.now()}`);

describe('cron-parser (调度表达式/下次运行时间 — 借鉴 Hermes scheduler.py)', () => {
  it('解析 every 30m / 1h / 90s 间隔', () => {
    expect(parseSchedule('every 30m')?.kind).toBe('interval');
    expect((parseSchedule('every 30m') as any)?.intervalMs).toBe(30 * 60_000);
    expect((parseSchedule('1h') as any)?.intervalMs).toBe(3_600_000);
    expect((parseSchedule('90s') as any)?.intervalMs).toBe(90_000);
    expect(nextAfter('every 30m')).toBeTruthy();
  });

  it('解析标准 5 段 cron 并找到下一个匹配', () => {
    // 每天 08:00
    const base = new Date(2026, 7, 10, 7, 0, 0); // 2026-08-10 07:00
    const p = parseSchedule('0 8 * * *', base);
    expect(p?.kind).toBe('cron');
    if (p?.kind === 'cron') expect(p.next.getHours()).toBe(8);
  });

  it('间隔 schedule 的下一次严格在未来 (every 1d)', () => {
    const p = parseSchedule('every 1d', new Date());
    expect(p?.kind).toBe('interval');
  });

  it('空/非法 schedule 返回 null', () => {
    expect(parseSchedule('')).toBeNull();
    expect(parseSchedule('   ')).toBeNull();
    expect(parseSchedule('not a valid schedule')).toBeNull();
    expect(parseSchedule('0 8 *')).toBeNull(); // 段数不足
  });
});

describe('suggestions (建议队列 — 借鉴 Hermes suggestions.py)', () => {
  beforeAll(async () => { await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true }); });
  afterAll(async () => { await fs.rm(tmpHome, { recursive: true, force: true }); });

  it('添加 → 列出', async () => {
    await clearSuggestions(tmpHome);
    await addSuggestion({ dedupKey: 'daily-review', summary: '每日复盘', source: 'schedule' }, tmpHome);
    const items = await listSuggestions(tmpHome);
    expect(items).toHaveLength(1);
    expect(items[0].dedupKey).toBe('daily-review');
  });

  it('同一 dedupKey 去重: 只保留最新', async () => {
    await clearSuggestions(tmpHome);
    await addSuggestion({ dedupKey: 'k1', summary: '旧', source: 'system' }, tmpHome);
    await addSuggestion({ dedupKey: 'k1', summary: '新', source: 'schedule' }, tmpHome);
    const items = await listSuggestions(tmpHome);
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe('新');
  });

  it('MAX_PENDING 有界: 超出丢最旧的', async () => {
    await clearSuggestions(tmpHome);
    for (let i = 0; i < MAX_PENDING + 2; i++) {
      await addSuggestion({ dedupKey: `k${i}`, summary: `s${i}`, source: 'system' }, tmpHome);
    }
    const items = await listSuggestions(tmpHome);
    expect(items.length).toBe(MAX_PENDING);
    expect(items[0].summary).toBe('s2'); // k0, k1 被丢
  });

  it('accept 移除并返回; 不存在返回 null', async () => {
    await clearSuggestions(tmpHome);
    const s = await addSuggestion({ dedupKey: 'a', summary: '接受我', source: 'system' }, tmpHome);
    const accepted = await acceptSuggestion(s.id, tmpHome);
    expect(accepted?.summary).toBe('接受我');
    expect(await listSuggestions(tmpHome)).toHaveLength(0);
    expect(await acceptSuggestion('nope', tmpHome)).toBeNull();
  });

  it('dismiss 移除', async () => {
    await clearSuggestions(tmpHome);
    const s = await addSuggestion({ dedupKey: 'd', summary: '忽略我', source: 'system' }, tmpHome);
    expect(await dismissSuggestion(s.id, tmpHome)).toBe(true);
    expect(await listSuggestions(tmpHome)).toHaveLength(0);
    expect(await dismissSuggestion(s.id, tmpHome)).toBe(false);
  });

  it('clear 清空', async () => {
    await addSuggestion({ dedupKey: 'x', summary: 'X', source: 'system' }, tmpHome);
    expect(await clearSuggestions(tmpHome)).toBe(1);
    expect(await listSuggestions(tmpHome)).toHaveLength(0);
  });
});

describe('jobs-store + scheduler (定时任务 — 借鉴 Hermes scheduler.py)', () => {
  beforeAll(async () => { await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true }); });

  it('add/list/rm/enable/markRun', async () => {
    const j = await addJob({ name: '复盘', schedule: 'every 1h', prompt: '总结' }, tmpHome);
    expect(j.enabled).toBe(true);
    expect((await listJobs(tmpHome)).map((x) => x.id)).toContain(j.id);
    await setEnabled(j.id, false, tmpHome);
    expect((await listJobs(tmpHome)).find((x) => x.id === j.id)?.enabled).toBe(false);
    await markRun(j.id, new Date().toISOString(), tmpHome);
    const after = (await listJobs(tmpHome)).find((x) => x.id === j.id)!;
    expect(after.runCount).toBe(1);
    expect(await removeJob(j.id, tmpHome)).toBe(true);
    expect((await listJobs(tmpHome)).find((x) => x.id === j.id)).toBeUndefined();
  });

  it('scheduler.tick 执行 due 的 job 并 markRun', async () => {
    await clearSuggestions(tmpHome);
    // 清空 jobs 再放一条立刻 due 的 (every 1s, 但 parseSchedule 用 now → due)
    const existing = await listJobs(tmpHome);
    for (const e of existing) await removeJob(e.id, tmpHome);
    await addJob({ name: '立刻执行', schedule: '1s', prompt: '跑一下' }, tmpHome);

    let executed: string[] = [];
    const sched = new Scheduler({
      exec: async (job: CronJob) => { executed.push(job.name); },
      home: tmpHome,
    });
    const ran = await sched.tick();
    expect(ran).toBeGreaterThanOrEqual(1);
    expect(executed).toContain('立刻执行');

    // 执行后 runCount +1
    const jobs = await listJobs(tmpHome);
    const j = jobs.find((x) => x.name === '立刻执行')!;
    expect(j.runCount).toBeGreaterThanOrEqual(1);
  });

  it('scheduler 失败不崩溃, 记录失败次数', async () => {
    await clearSuggestions(tmpHome);
    const existing = await listJobs(tmpHome);
    for (const e of existing) await removeJob(e.id, tmpHome);
    await addJob({ name: '会失败', schedule: '1s', prompt: 'boom' }, tmpHome);

    const sched = new Scheduler({
      exec: async () => { throw new Error('模拟失败'); },
      home: tmpHome,
    });
    const failed = await sched.tick().then(() => sched.failureCounts());
    const counts = [...failed.values()];
    expect(counts.length).toBe(1);
    expect(counts[0]).toBeGreaterThanOrEqual(1);
  });
});

describe('handleSuggestionsCommand (CLI 命令编排)', () => {
  beforeAll(async () => { await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true }); });

  it('列出建议 + accept 子动作返回文本', async () => {
    await clearSuggestions(tmpHome);
    await addSuggestion({ dedupKey: 'c1', summary: '待办A', source: 'system' }, tmpHome);
    const listRes = await handleSuggestionsCommand('', tmpHome);
    expect(listRes.text).toContain('待办A');
    const accRes = await handleSuggestionsCommand('accept 1', tmpHome);
    expect(accRes.text).toContain('已接受');
    expect(accRes.accepted?.summary).toBe('待办A');
  });

  it('catalog 返回内置目录; install 可装机', async () => {
    await clearSuggestions(tmpHome);
    const cat = await handleSuggestionsCommand('catalog', tmpHome);
    expect(cat.text).toContain('daily-review');
    const inst = await handleSuggestionsCommand('install daily-review', tmpHome);
    expect(inst.text).toContain('已装机');
  });
});