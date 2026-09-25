/**
 * goal-flywheel P6 · ④ 多 worker 租约竞争 (两个 Supervisor 真抢同一个 Goal 的 lease) — 2026-09-26
 *
 * 归属: `docs/wiki/goal-flywheel-p5-acceptance.md` §5「多进程/多 worker 竞争下的租约与让路」那条未验证项。
 * 被验对象: 真 `ExecutionSupervisor` ×2 (同一份真 store / 各自不同的 `owner` 身份) + 真
 * `goal-store.claimGoal` (真 `fs.open(..., 'wx')` 互斥) —— 没有改 `execution-supervisor.ts` 一行。
 *
 * 四层证据, 每一层都问"另一个 worker 到底动没动这个 Goal":
 *   ① **并发真抢** (最强): worker A 的 tick 在**执行器里被卡住**(租约已持有)时, worker B 真 tick
 *      → B 的 `executed` / `claimed` 都是空、`runs` 不变、B 的执行器一次都没被调;
 *   ② **让路理由**: B 的 `skipped` 里写明是 lease 被谁持有到什么时候 (不是"没原因地跳过");
 *   ③ **认领点本身**: 持租期间第二个 owner 直接调真 `claimGoal` → `ok:false` + reason 含"lease 被占用"
 *      + 如实回 `holder.owner`;
 *   ④ **认领失败发生在 tick 内部**: 给 B 一个"快进 2 小时"的注入时钟 (它扫盘时以为租约已过期 →
 *      走到认领那一步) → 真 `claimGoal` (它用真实时钟判过期) 仍然拒绝它 ⇒ `skipped` 记认领失败。
 * 正控 (说明"让路"不是"永远不动"): A 释放租约后 B 再 tick → 真跑一轮。
 *
 * 未做 / 做不到的: 两个**进程**之间的竞争没有验 (本线只起两个实例) —— 同一进程内 pid 相同,
 * 因此这里的排他性完全来自 lease 文件 (真 `fs.open('wx')`), 不来自"进程还活着"。
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
  TMP = path.join(os.tmpdir(), `p6-lease-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
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

function iso(ms: number): string { return new Date(ms).toISOString(); }

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    sup: await import('../agents/execution-supervisor.js'),
  };
}

/**
 * 假执行器。
 *  `entered` 是**事件驱动**的同步点 (不用 sleep / 不用轮询预算): supervisor 是
 *  **先 `claimGoal` 成功 (L473) 再调 runner (L700)** 的, 所以执行器一进来就说明
 *  "这个 worker 已经把 lease 抢到手了"。测试可以据此确定性地断言, 不必猜"等多久算够"。
 *  `gate` 再把执行器卡住 = 租约被持有的那段时间。
 */
function realRunner(
  rs: any, gs: any, calls: { n: number },
  opts: { gate?: Promise<void>; entered?: () => void } = {},
) {
  return (async (req: any) => {
    calls.n += 1;
    opts.entered?.();                          // 报"我已进执行器" (此时租约已在我手上)
    if (opts.gate) await opts.gate;            // 卡住 = 租约被持有的那段时间
    const rec = await rs.startRun({ surface: 'cli', channelId: 'ch-p6', goalId: req.goal.goalId, goal: req.goal.objective });
    await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: 'worker 真跑了一步' });
    await rs.finishRun(rec.runId, { status: 'done' });
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status: 'done' };
  }) as any;
}

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-④ 两个 worker 抢同一个 Goal 的 lease: 只有一个认领成功, 另一个不得重复跑', () => {
  it('(1) 并发真抢: A 持租执行中, B 的 tick 认领不到也不跑 (同一份真 store, 两个 owner)', async () => {
    const m = await mods();
    const g = await m.gs.createGoal({ objective: '两个 worker 抢这个目标', successCriteria: ['判据0'], createdBy: 'p6' });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r as any; });
    let enteredA!: () => void;
    const aEnteredRunner = new Promise<void>((r) => { enteredA = r as any; });
    const callsA = { n: 0 };
    const callsB = { n: 0 };
    const supA = new m.sup.ExecutionSupervisor({
      owner: 'worker-A',
      runner: realRunner(m.rs, m.gs, callsA, { gate, entered: enteredA }),
      maxPerTick: 5, maxRetries: 5, now: () => Date.now(),
    });
    const supB = new m.sup.ExecutionSupervisor({
      owner: 'worker-B', runner: realRunner(m.rs, m.gs, callsB), maxPerTick: 5, maxRetries: 5, now: () => Date.now(),
    });

    // A 开始 tick (不 await): 它认领 lease 并进入执行器 (阻塞在 gate)
    const pA = supA.tickOnce();
    // ★ 确定性同步点 (2026-09-26 修间歇竞态):
    //   原来这里是**有 2s 预算的轮询** —— `while (callsA.n === 0 && guard < 200) await sleep(10)`。
    //   但 `callsA.n` 只在执行器**被调用**时才涨, 而 supervisor 在 `claimGoal` 成功之后还要走
    //   readGoal / 续跑计划 / 变更注入 / 工作合同摘要 / 技能就绪门禁 / 若干动态 import 才调到 runner ——
    //   这一段时延**无上界且与机器负载相关**。负载一高就超预算, 于是断言在"租约其实早抢到手"的情况下
    //   报 `expected +0 to be 1` (实测: 空载 10/10 绿, 4 并发同文件 8/8 红, 红时 5460–5678ms, 全部落在本行)。
    //   现在改成**事件驱动**: 执行器被调用时自报 (`enteredA`), 而它必然发生在 `claimGoal` 之后 →
    //   等待无预算、无 sleep、断言一条都没放宽。
    //   若 A 的 tick 在进执行器之前就返回 (认领失败/让路/判停 —— 那是**真**回归), `pA` 先 settle,
    //   下面那行立刻断言失败并说明原因, 不会退化成 20s 超时。
    let aTickEndedEarly = false;
    await Promise.race([
      aEnteredRunner,
      pA.then(() => { aTickEndedEarly = true; }, () => {}),
    ]);
    if (aTickEndedEarly) {
      // 这条分支只有在 A 的 tick **没进执行器就结束**时才走到 (认领失败/让路/判停)。
      // 那不是时序问题, 是真回归 —— 直接报清楚 + 附上 A 的 tick 报告, 不做任何"等一等再说"。
      const rep = await pA;
      throw new Error('A 的 tick 在进入执行器之前就结束了 (认领/让路/判停) → 真回归, 不是时序问题; '
        + `claimed=${JSON.stringify(rep.claimed)} executed=${JSON.stringify(rep.executed)} `
        + `skipped=${JSON.stringify(rep.skipped)} errors=${JSON.stringify(rep.errors)}`);
    }
    expect(callsA.n).toBe(1);                                   // A 真的跑起来了 = 租约已被它持有
    const leaseWhileHeld = await m.gs.readLease(g.goalId);
    expect(leaseWhileHeld?.owner).toBe('worker-A');
    const runsWhileHeld = (await m.gs.readGoal(g.goalId))!.runs.length;

    // B 并发 tick: 必须认领失败 + 什么都不跑
    const repB = await supB.tickOnce();
    expect(repB.claimed).toEqual([]);
    expect(repB.executed).toEqual([]);
    expect(callsB.n).toBe(0);                                   // B 的执行器一次都没被调
    expect(repB.skipped.some((x) => /lease/.test(x.reason) && /worker-A/.test(x.reason))).toBe(true);
    expect((await m.gs.readGoal(g.goalId))!.runs.length).toBe(runsWhileHeld);

    // ③ 认领点本身: 持租期间第二个 owner 直接调真 claimGoal → 拒
    const direct = await m.gs.claimGoal(g.goalId, { owner: 'worker-B', ttlMs: 90_000 });
    expect(direct.ok).toBe(false);
    expect(String(direct.reason)).toMatch(/lease 被占用/);
    expect((direct as any).holder?.owner).toBe('worker-A');

    // 放行 A, 让它收尾并释放租约
    release();
    const repA = await pA;
    expect(repA.executed.length).toBe(1);
    expect(callsA.n).toBe(1);
    expect(await m.gs.readLease(g.goalId)).toBeFalsy();          // A 真放掉了

    // 正控: 租约放开后 B 真能跑一轮 (让路 ≠ 永远不动)
    const repB2 = await supB.tickOnce();
    expect(repB2.executed.length).toBe(1);
    expect(callsB.n).toBe(1);
    const finalRuns = (await m.gs.readGoal(g.goalId))!.runs.length;
    expect(finalRuns).toBe(runsWhileHeld + 2);                   // A 一轮 + B 一轮 = 两轮, 没有重复
  });

  it('(2) 认领失败发生在 tick 内部: B 以为租约过期 (快进 2h 的注入时钟) 仍被真 claimGoal 挡住', async () => {
    const m = await mods();
    const g = await m.gs.createGoal({ objective: '租约被别的 worker 占着', successCriteria: ['判据0'], createdBy: 'p6' });
    // worker-A 用**真时钟**认领 1 小时 (真 API, 真 lease 文件)
    const claimed = await m.gs.claimGoal(g.goalId, { owner: 'worker-A', ttlMs: 3_600_000 });
    expect(claimed.ok).toBe(true);

    // B 的时钟快进 2 小时 → 扫盘时以为租约已过期 (真要走一遍"扫到 → 认领"这条链)
    const calls = { n: 0 };
    const supB = new m.sup.ExecutionSupervisor({
      owner: 'worker-B', runner: realRunner(m.rs, m.gs, calls), maxPerTick: 5, maxRetries: 5,
      now: () => Date.now() + 2 * 3_600_000,
    });
    const rep = await supB.tickOnce();
    expect(rep.claimed).toEqual([]);
    expect(rep.executed).toEqual([]);
    expect(calls.n).toBe(0);
    expect(rep.skipped.some((x) => /lease 被占用/.test(x.reason) && /worker-A/.test(x.reason))).toBe(true);
    expect((await m.gs.readGoal(g.goalId))!.runs.length).toBe(0);      // 一个 Run 都没开

    // 对照 (说明这条 skip 不是"没扫到"): 同样快进的时钟, 但租约**真过期**后 B 立刻能跑
    const g2 = await m.gs.createGoal({ objective: '租约已过期', successCriteria: ['判据0'], createdBy: 'p6' });
    const stale = await m.gs.claimGoal(g2.goalId, { owner: 'worker-A', ttlMs: -1000 });
    expect(stale.ok).toBe(true);
    const rep2 = await supB.tickOnce();
    expect(rep2.executed.length).toBe(1);                              // 过期租约被真回收 → 真跑
    expect(calls.n).toBe(1);
    expect((await m.gs.readGoal(g2.goalId))!.runs.length).toBe(1);
  });
});
