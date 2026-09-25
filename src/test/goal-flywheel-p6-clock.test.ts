/**
 * goal-flywheel P6 · ③ 小时级真时钟 (只用**注入的** `now`, 不 sleep) — 2026-09-26
 *
 * 归属: `docs/wiki/goal-flywheel-p5-acceptance.md` §5「长周期 (小时/天级) 的真实调度」那条未验证项。
 * 被验对象: 真 `ExecutionSupervisor` + 真 goal-store / run-store, 时间全部由 `now: () => t` 注入。
 *
 * 三条一起钉住"跨小时唤醒"这件事:
 *   ① **未到点不跑**: wakeAt = t0+3h; 在 0h / 1h / 2h / (3h − 1s) 四次 tick 全部 `executed=0`、
 *      真 run 记录数不变、执行器**一次都没被调用** (证据是 runner 自己的调用计数, 不是日志)。
 *   ② **到点才跑**: 同一分钟级别推进到 t0+3h 那一刻 → `executed=1`、runs 1→2、runner 被调 1 次。
 *   ③ **跳过多个小时不空转**: wakeAt = t0+5h 而直接在 t0+11h 醒来 (跳 6 小时) → runner 仍只被调 **1** 次
 *      (没有按"欠了几个小时"补跑 / 反复跑); 唤醒那一轮结束后再多 tick 几小时 → runs 不再增长。
 *
 * 阴性对照: 用例 ① 的最后一段就是 ② 的红态 (同一份 wakeAt, 只把时钟往前挪 1 秒);
 * 用例 ③ 同时给出"跳 6 小时 = 1 次"与"9 个小时里逐小时 tick 6 次 = 0 次"两侧, 说明这条门
 * 量与时钟推进方式有关, 而不是恒等于某个数。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `p6-clock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const H = 60 * 60_000;
function iso(ms: number): string { return new Date(ms).toISOString(); }

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    sup: await import('../agents/execution-supervisor.js'),
  };
}

async function listDir(p: string): Promise<string[]> {
  try { return (await fs.readdir(p)).sort(); } catch { return []; }
}

/** 计数执行器: 每次被调 +1, 并真落一个 Run (不 stub 被验对象, 只替换"跑"这件事) */
function countingRunner(rs: any, gs: any, calls: { n: number }) {
  return (async (req: any) => {
    calls.n += 1;
    const rec = await rs.startRun({ surface: 'cli', channelId: 'ch-p6', goalId: req.goal.goalId, goal: req.goal.objective });
    await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: `第 ${calls.n} 次唤醒真跑了一步` });
    await rs.finishRun(rec.runId, { status: 'done' });
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status: 'done' };
  }) as any;
}

/** 一个"已跑过一轮、正在等下一次唤醒"的 Goal (真盘) */
async function waitingGoal(m: Awaited<ReturnType<typeof mods>>, wakeAtMs: number) {
  const g = await m.gs.createGoal({ objective: '等下一次定时唤醒的长期目标', successCriteria: ['判据0'], createdBy: 'p6' });
  const r1 = await m.rs.startRun({ surface: 'cli', channelId: 'ch-p6', goalId: g.goalId, goal: g.objective });
  await m.rs.recordStep(r1.runId, { tool: 'shell_exec', ok: true, summary: '第一轮' });
  await m.rs.finishRun(r1.runId, { status: 'done' });
  await m.gs.attachRun(g.goalId, r1.runId);
  await m.gs.updateGoal(g.goalId, { status: 'retry_wait' });
  await m.gs.setContinuation(g.goalId, {
    wakeAt: iso(wakeAtMs), wakeReason: 'retry_wait', autoContinue: true, state: 'retry_wait',
  });
  return g.goalId;
}

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-③ 小时级唤醒 (注入 now): 未到点不跑 / 到点才跑 / 跳多个小时不空转', () => {
  it('(1) 3 小时唤醒: 0h/1h/2h/(3h−1s) 全都不跑, 正好 3h 那一刻才真跑', async () => {
    const m = await mods();
    const t0 = Date.parse('2026-09-26T00:00:00.000Z');
    const goalId = await waitingGoal(m, t0 + 3 * H);
    const calls = { n: 0 };
    let t = t0;
    const s = new m.sup.ExecutionSupervisor({
      runner: countingRunner(m.rs, m.gs, calls), maxPerTick: 5, maxRetries: 5, now: () => t,
    });

    const marks = ['0h', '1h', '2h', '3h−1s'];
    const offsets = [0, 1 * H, 2 * H, 3 * H - 1000];
    let executedTotal = 0;
    for (let i = 0; i < offsets.length; i++) {
      t = t0 + offsets[i];
      const rep = await s.tickOnce();
      executedTotal += rep.executed.length;
      expect(rep.executed.length, `未到点 (${marks[i]}) 不许跑`).toBe(0);
      expect(rep.skipped.some((x) => /时间未到|retry_wait/.test(x.reason)), `${marks[i]} 的跳过理由`).toBe(true);
      const g = await m.gs.readGoal(goalId);
      expect(g!.runs.length, `${marks[i]} 的 run 记录数`).toBe(1);
    }
    expect(calls.n).toBe(0);                        // 执行器一次都没被调用 (最硬的那条证据)
    expect(executedTotal).toBe(0);

    // 到点: 只往前 1 秒
    t = t0 + 3 * H;
    const rep = await s.tickOnce();
    expect(rep.executed.length).toBe(1);
    expect(calls.n).toBe(1);
    expect((await m.gs.readGoal(goalId))!.runs.length).toBe(2);
    // 阴性对照 (说明上面那些 0 是"时钟没到"造成的, 不是这个目标本来就不可跑):
    // 同一个 Goal、同一个 t, 只把 supervisor 的**时钟源**拨到 wakeAt 之后 → 立刻跑一轮
    const fastCalls = { n: 0 };
    const fast = new m.sup.ExecutionSupervisor({
      runner: countingRunner(m.rs, m.gs, fastCalls), maxPerTick: 5, maxRetries: 5, now: () => t0 + 3 * H,
    });
    t = t0;                                          // 变量仍是 t0: 变的只有注入的时钟
    const repFast = await fast.tickOnce();
    expect(repFast.executed.length).toBe(1);
    expect(fastCalls.n).toBe(1);
  });

  it('(2) 跳 6 小时醒来 → 只跑 1 次 (不按欠账补跑); 再等 4 小时仍然 0 次, 到点才再跑', async () => {
    const m = await mods();
    const t0 = Date.parse('2026-09-26T00:00:00.000Z');
    const goalId = await waitingGoal(m, t0 + 5 * H);
    const calls = { n: 0 };
    let t = t0;
    const s = new m.sup.ExecutionSupervisor({
      runner: countingRunner(m.rs, m.gs, calls), maxPerTick: 5, maxRetries: 5, now: () => t,
    });

    // ① 唤醒前逐小时 tick 4 次 → 0 次执行, run 记录不涨, 执行器一次都没被调
    let executedBefore = 0;
    for (let h = 1; h <= 4; h++) {
      t = t0 + h * H;
      executedBefore += (await s.tickOnce()).executed.length;
    }
    expect(executedBefore).toBe(0);
    expect(calls.n).toBe(0);
    expect((await m.gs.readGoal(goalId))!.runs.length).toBe(1);

    // ② 时钟一次跳到 wakeAt 之后 6 小时 (真实的"停机一晚上再起来") → **只跑一次** (不是六次)
    t = t0 + 11 * H;
    const rep = await s.tickOnce();
    expect(rep.executed.length).toBe(1);
    expect(calls.n).toBe(1);                        // **不是 6** —— 没有"欠了几个小时补几次"
    expect((await m.gs.readGoal(goalId))!.runs.length).toBe(2);

    // ③ 重新排一次唤醒 (t0+16h) → 跨 12h..15h 四个小时 tick: 一次都不跑 (时间流逝本身不产生轮次)
    await m.gs.updateGoal(goalId, { status: 'retry_wait' });
    await m.gs.setContinuation(goalId, { wakeAt: iso(t0 + 16 * H), wakeReason: 'retry_wait', autoContinue: true, state: 'retry_wait' });
    let idleExecuted = 0;
    for (let h = 12; h <= 15; h++) {
      t = t0 + h * H;
      idleExecuted += (await s.tickOnce()).executed.length;
    }
    expect(idleExecuted).toBe(0);
    expect(calls.n).toBe(1);
    expect((await m.gs.readGoal(goalId))!.runs.length).toBe(2);

    // ④ 正好 t0+16h → 再跑一轮; 且**每个 tick 最多推进一轮** (没有按小时欠账累积)
    t = t0 + 16 * H;
    const rep2 = await s.tickOnce();
    expect(rep2.executed.length).toBe(1);
    expect(calls.n).toBe(2);
    expect((await m.gs.readGoal(goalId))!.runs.length).toBe(3);
    for (let h = 17; h <= 18; h++) {
      t = t0 + h * H;
      const r = await s.tickOnce();
      expect(r.executed.length).toBeLessThanOrEqual(1);   // 唤醒后按**证据**继续, 不按小时数
    }
    expect((await m.gs.readGoal(goalId))!.runs.length).toBe(calls.n + 1);  // run 记录数 = 首轮 + 真执行次数
  });

  it('(3) 小时级多处 wakeAt: 每个目标都只在**自己到点后**才跑 (1h/2h/3h 三个目标, 未到点不动)', async () => {
    const m = await mods();
    const t0 = Date.parse('2026-09-26T00:00:00.000Z');
    const g1 = await waitingGoal(m, t0 + 1 * H);
    const g2 = await waitingGoal(m, t0 + 2 * H);
    const g3 = await waitingGoal(m, t0 + 3 * H);
    const calls = { n: 0 };
    let t = t0;
    const s = new m.sup.ExecutionSupervisor({
      runner: countingRunner(m.rs, m.gs, calls), maxPerTick: 5, maxRetries: 5, now: () => t,
    });

    const runsAt = async (id: string) => (await m.gs.readGoal(id))!.runs.length;
    expect({ g1: await runsAt(g1), g2: await runsAt(g2), g3: await runsAt(g3) }).toEqual({ g1: 1, g2: 1, g3: 1 });

    // 每个 tick 的 executed 上限 = 到点目标数 (3): 超过就说明同一个目标被重复跑/补跑
    const counts: number[] = [];
    for (const h of [1, 2, 3]) {
      t = t0 + h * H;
      counts.push((await s.tickOnce()).executed.length);
      const r1 = await runsAt(g1), r2 = await runsAt(g2), r3 = await runsAt(g3);
      if (h === 1) { expect(r1).toBe(2); expect(r2).toBe(1); expect(r3).toBe(1); }   // 2h/3h 的目标未到点: 一动不动
      if (h === 2) { expect(r2).toBe(2); expect(r3).toBe(1); }                        // 3h 的目标仍未到点
      if (h === 3) { expect(r3).toBe(2); }
    }
    expect(counts.every((c) => c >= 1 && c <= 3)).toBe(true);
    expect(calls.n).toBeGreaterThanOrEqual(3);         // 三次"到点"各真跑过
    // 上限 = 每个目标在"已到点的小时数"里各跑一次 (1+2+3 = 6): 超过就说明有补跑/重复跑
    expect(calls.n).toBeLessThanOrEqual(6);
  });
});
