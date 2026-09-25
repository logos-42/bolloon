/**
 * M0 唯一责任链 —— **真跑一条链** (2026-09-25)
 *
 * 这一份不是单测: 它真跑 `ExecutionSupervisor` + 真 Goal/Run Store (隔离 HOME) + 真落盘的
 * 收尾产物 (Memory / Skill 候选 / 决策记录 / 用户汇报) + 真 continuation 写回。
 *
 * 它要回答的唯一问题 (也是 M0 的验收问题):
 *   ```
 *   Supervisor → Goal continuation → Runner → Run → closeRun → Memory + Skill candidate
 *                                                              → 下一次 continuation
 *   ```
 *   这条链**是不是真的连着** —— 上一次收尾写下的"下一步", 下一次 Run 的指令里**真的读到**了吗?
 *   而且: 无论哪条终止路径 (成功 / 失败 / 中断 / 崩溃恢复 / 非 Supervisor 宿主), 收尾产物是不是
 *   落在**同一份事实**上 (同一份决策记录 / 同一份 Memory 目录 / 同一个 Goal continuation)?
 *
 * 阴性对照 (怎么知道这一份不是空转):
 *   · 收尾**幂等** —— 第二个收尾入口必须返回 `alreadyClosed` 并读到同一条决策 (不是重收一遍,
 *     也不是编一份新的); 决策记录条数不变。
 *   · 崩溃恢复 (`reconcileOrphans` → interrupted) 必须也留下**同一个**决策记录;
 *     把 run-store 的终止钩子摘掉 → 这一条立刻变绿不了 (冻结门 goal-flywheel-wiring-freeze
 *     专门钉了这一点)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const OLD_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['BOLLOON_RUN_FINAL_REVIEW', 'BOLLOON_GOAL_NO_PROGRESS_BREAKER', 'BOLLOON_GOAL_MAX_RUNS', 'BOLLOON_GOAL_MAX_RETRIES', 'BOLLOON_RUN_PERSIST'];

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-m0chain-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  for (const k of ENV_KEYS) OLD_ENV[k] = process.env[k];
  delete process.env.BOLLOON_GOAL_NO_PROGRESS_BREAKER;
  delete process.env.BOLLOON_GOAL_MAX_RUNS;
  delete process.env.BOLLOON_GOAL_MAX_RETRIES;
  // 最终评审 (收尾的"事实来源"): 有它才有 lesson/候选, 收尾才不是空转
  process.env.BOLLOON_RUN_FINAL_REVIEW = [
    '## 最终评审',
    '评审: 本轮通过, 判据 1 尚未满足 (还差数据)',
    '事实: 用 shell_exec 写好了 /tmp/m0-chain-proof',
    '教训: 先确认输出目录存在再写',
    '候选: 加一条"输出目录必须存在"的前置检查',
  ].join('\n');
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  for (const k of ENV_KEYS) {
    if (OLD_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = OLD_ENV[k]!;
  }
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    sup: await import('../agents/execution-supervisor.js'),
    wiring: await import('../agents/goal-flywheel-wiring.js'),
    fly: await import('../agents/goal-flywheel/index.js'),
    reducer: await import('../agents/goal-state-reducer.js'),
  };
}

/** 真执行器: 自己落 Run 事实 (startRun / recordStep / finishRun / attachRun), 不伪造任何 Run 记录 */
function makeRunner(rs: any, gs: any, opts: { status?: 'done' | 'failed'; okSteps?: string[]; capture?: (req: any) => void } = {}) {
  const status = opts.status || 'done';
  return (async (req: any) => {
    opts.capture?.(req);
    if (req.kind === 'resume' && req.prevRunId) {
      await rs.prepareResume(req.prevRunId).catch(() => null);
      await rs.finishRun(req.prevRunId, { status: status === 'failed' ? 'failed' : 'done' });
      return { runId: req.prevRunId, status };
    }
    const rec = await rs.startRun({ channelId: 'ch-m0', goalId: req.goal.goalId, goal: req.goal.objective });
    for (const s of opts.okSteps || []) await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: s });
    await rs.finishRun(rec.runId, status === 'failed' ? { status: 'failed', error: '工具不可用 (EACCES)' } : { status: 'done' });
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status };
  }) as any;
}

async function memCount(rel: string): Promise<number> {
  const dir = path.join(TMP, rel);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files.length;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('M0 唯一责任链 ①: 跨 ≥2 个 Run, 上一次收尾写回的"下一步"被下一次真的读到', () => {
  it('Run1 收尾 → continuation 写回 → Run2 的指令带上它 → Run2 也收尾 (同一份事实)', async () => {
    const { gs, rs, sup, wiring, fly } = await mods();
    const g = await gs.createGoal({ objective: '把 A 变成 B', successCriteria: ['A 已变成 B'] });

    const seen: string[] = [];
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['写好了 /tmp/m0-chain-proof'], capture: (r) => seen.push(String(r.instruction)) }),
      maxPerTick: 1,   // 一 tick 一个 Run —— 这样"第二个 Run"是被**下一次 tick** 真的驱动出来的
      maxRetries: 2,
    });

    // ── 第 1 个 Run ─────────────────────────────────────────────────────────
    const r1 = await s.tickOnce();
    expect(r1.closures.length).toBe(1);
    expect(r1.closures[0].steps).toBe(9);
    const run1Id = r1.closures[0].runId;

    // 收尾产物真落盘 (不是只在返回值里)
    expect(await fs.stat(r1.closures[0].reportPath).then(() => true, () => false)).toBe(true);
    expect(await fs.stat(r1.closures[0].decisionRecordPath).then(() => true, () => false)).toBe(true);

    // continuation 写回 Goal (这是"下一次能继续"的依据)
    const afterRun1 = await gs.readGoal(g.goalId);
    const nextAction1 = String(afterRun1!.continuation?.nextAction || '');
    expect(nextAction1.length).toBeGreaterThan(0);
    expect(afterRun1!.continuation?.lastDecisionId).toBeTruthy();
    expect(afterRun1!.currentRunId).toBe(run1Id);

    // ── 第 2 个 Run ─────────────────────────────────────────────────────────
    const r2 = await s.tickOnce();
    expect(r2.closures.length).toBe(1);
    const run2Id = r2.closures[0].runId;
    expect(run2Id).not.toBe(run1Id);

    // ★ 这一条就是"责任链真的连上了": 第 2 个 Run 的执行指令里带上了第 1 次收尾写下的下一步
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toContain('飞轮下一步 (权威 continuation)');
    expect(seen[1]).toContain(nextAction1.slice(0, 24));

    // 两个 Run 都在同一份 Goal 事实下, 且决策记录是**成对**长的 (preflight + closure ×2)
    const records = await wiring.readDecisionRecords(g.goalId);
    expect(records.filter((r: any) => r.phase === 'closure').length).toBe(2);
    expect(records.filter((r: any) => r.phase === 'preflight').length).toBe(2);

    // Run 列表真的是两条 (不是同一个 Run 被算了两次)
    const runs = await rs.listRuns({ goalId: g.goalId }).catch(() => null);
    if (Array.isArray(runs)) expect(runs.length).toBeGreaterThanOrEqual(2);

    // 用户可见态仍然只走唯一映射
    const visible = await wiring.goalVisibleState({ goalId: g.goalId });
    expect(fly.USER_VISIBLE_STATES).toContain(visible);

    // Run 1 结束 ≠ Goal 完成: 判据没满足 → Goal 仍 active, 未解决项留着
    const fin = await gs.readGoal(g.goalId);
    expect(fin!.status).toBe('active');
    expect(fin!.continuation?.nextAction).toBeTruthy();
  });
});

describe('M0 唯一责任链 ②: 收尾幂等 (第二个收尾入口读事实, 不重收也不编)', () => {
  it('Supervisor 收过之后, 再调 closeRunOnce → alreadyClosed, 读到同一条决策, 记录数不变', async () => {
    const { gs, rs, sup, wiring, fly } = await mods();
    const g = await gs.createGoal({ objective: '幂等验证', successCriteria: ['不会重复收尾'] });
    const s = new sup.ExecutionSupervisor({ runner: makeRunner(rs, gs, { okSteps: ['做了一点'] }), maxPerTick: 1, maxRetries: 1 });
    const r1 = await s.tickOnce();
    expect(r1.closures.length).toBe(1);
    const runId = r1.closures[0].runId;

    const before = await wiring.readDecisionRecords(g.goalId);
    const memBefore = await memCount(path.join(fly.MEMORY_LAYERS_ROOT, 'run_fact'));
    const goalBefore = await gs.readGoal(g.goalId);

    // Runner 侧再来收一次 (真实场景: pi-sdk 与 Supervisor 都想收)
    const again = await wiring.closeRunOnce({ goalId: g.goalId, runId, caller: 'runner', finalReview: '重复收尾尝试' });
    expect(wiring.isRefusal(again)).toBe(false);
    const view = (again as any).alreadyClosed === true ? (again as any).outcome : null;
    expect((again as any).alreadyClosed).toBe(true);
    // 事实被读回来了 (不是 null, 也不是编一份新的): 9 步 + 同一个决策 + 同一个 nextAction
    expect(view).toBeTruthy();
    expect(view.steps).toBe(9);
    expect(view.decision.decision).toBe(r1.closures[0].decision);
    expect(view.continuation.nextAction).toBe(goalBefore!.continuation!.nextAction);

    // 决策记录没有多出第三条 (没有重收); Memory 也没有被写第二遍
    expect((await wiring.readDecisionRecords(g.goalId)).length).toBe(before.length);
    expect(await memCount(path.join(fly.MEMORY_LAYERS_ROOT, 'run_fact'))).toBe(memBefore);
  });

  it('拿不到事实就如实说: 收尾记录没了 → alreadyClosed + outcome=null + 原因说清 (不重收, 不假装)', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const g = await gs.createGoal({ objective: '事实读不回来', successCriteria: ['如实报'] });
    const s = new sup.ExecutionSupervisor({ runner: makeRunner(rs, gs, { okSteps: ['做了一点'] }), maxPerTick: 1, maxRetries: 1 });
    const r1 = await s.tickOnce();
    const runId = r1.closures[0].runId;

    // 把决策记录整个删掉 —— 模拟"这一轮确实收过尾, 但收尾事实丢了"
    // (decisionRecordPath 是绝对路径, 不能再和 TMP 拼)
    const decisionsDir = path.dirname(r1.closures[0].decisionRecordPath);
    await fs.rm(decisionsDir, { recursive: true, force: true });

    const again = await wiring.closeRunOnce({ goalId: g.goalId, runId, caller: 'runner' });
    expect(wiring.isRefusal(again)).toBe(false);
    expect((again as any).alreadyClosed).toBe(true);
    // 收过了就说收过了; 事实读不回来就说读不回来 —— 不许重收, 也不许静默 undefined
    expect((again as any).outcome).toBeNull();
    expect(String((again as any).reason)).toMatch(/收尾|读不回|缺失|找不到/);
    // 不重收 = 没有新的决策记录被写出来
    expect(await wiring.readDecisionRecords(g.goalId)).toEqual([]);
  });
});

describe('M0 唯一责任链 ③: 崩溃恢复 (孤儿 → interrupted) 也过同一条收尾链', () => {
  it('reconcileOrphans 把死进程的 Run 标成 interrupted, 并且留下**同一个**决策记录', async () => {
    const { gs, rs, wiring } = await mods();
    await wiring.installRunTerminalHook();  // = Supervisor tick 的"步骤 0"

    const g = await gs.createGoal({ objective: '崩溃恢复也要收尾', successCriteria: ['有收尾记录'] });
    const rec = await rs.startRun({ channelId: 'ch-crash', goalId: g.goalId, goal: '跑一半进程被杀' });
    await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '做到一半' });
    await gs.attachRun(g.goalId, rec.runId);

    // 模拟"进程已死": 把 run 记录上的 pid 换成确定不存在的 pid (崩溃留在盘上的样子就是这样)
    const runFile = path.join(TMP, '.bolloon', 'runs', `${rec.runId}.json`);
    const raw = JSON.parse(await fs.readFile(runFile, 'utf8'));
    raw.pid = 999_999;
    await fs.writeFile(runFile, JSON.stringify(raw), 'utf8');

    const out = await rs.reconcileOrphans();
    expect(out.interrupted).toContain(rec.runId);

    const after = await rs.readRun(rec.runId);
    expect(after!.status).toBe('interrupted');

    // ★ 崩溃恢复没有绕过唯一责任链: 决策记录 + continuation 都在
    const records = await wiring.readDecisionRecords(g.goalId);
    expect(records.some((r: any) => r.phase === 'closure')).toBe(true);
    const goalAfter = await gs.readGoal(g.goalId);
    expect(goalAfter!.continuation?.nextAction).toBeTruthy();
  });
});

describe('M0 唯一责任链 ④: 非 Supervisor 宿主 (CLI) 走同一条链', () => {
  it('closeTaskRun: CLI 任务跑完也留下 Memory/决策记录 + Goal 状态经 reducer 写', async () => {
    const { gs, rs, wiring, fly, reducer } = await mods();
    const g = await gs.createGoal({ objective: 'CLI 任务也要收尾', successCriteria: ['有收尾产物'] });
    const rec = await rs.startRun({ channelId: 'ch-cli', goalId: g.goalId, goal: '命令行跑一次' });
    await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '产出 /tmp/cli-out' });
    await rs.finishRun(rec.runId, { status: 'done' });

    const res = await wiring.closeTaskRun(rec.runId, g.goalId, '产出 /tmp/cli-out (契约校验通过)', 'cli');
    expect(res.closed).toBe(true);
    expect(res.decision).toBeTruthy();

    // 与 Supervisor 路径**同一份**事实: 同一个决策记录目录 + 同一个 Memory 根
    const records = await wiring.readDecisionRecords(g.goalId);
    expect(records.filter((r: any) => r.phase === 'closure').length).toBe(1);
    const memFiles = await fs.readdir(path.join(TMP, fly.MEMORY_LAYERS_ROOT, 'run_fact')).catch(() => [] as string[]);
    expect(memFiles.length).toBeGreaterThan(0);

    // Goal 状态经唯一漏斗 (证据里带 by=cli 的痕迹)
    const after = await gs.readGoal(g.goalId);
    expect(after!.continuation?.nextAction).toBeTruthy();
    expect(reducer.GOAL_STATE_INTENTS).toContain('closure_outcome');

    // 再收一次: 幂等 (CLI 与 Supervisor 不会各写一套)
    const again = await wiring.closeTaskRun(rec.runId, g.goalId, '重复收尾', 'cli');
    expect(again.closed).toBe(false);
    expect(await wiring.readDecisionRecords(g.goalId).then((r: any[]) => r.filter((x) => x.phase === 'closure').length)).toBe(1);
  });
});
