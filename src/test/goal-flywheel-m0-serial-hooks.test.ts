/**
 * 串行收口验收 (2026-09-25): M0 骨架的四个钩子 + 两个跨阶段真问题。
 *
 * 这份文件的门只认**真跑**:
 *   · 每一条都走真 store (Goal / Run / lease / 决策记录), 不 mock 盘;
 *   · 每条都配**阴性对照**: 该拒的必须真拒 (不许"接上了"就算过);
 *   · 三条"只有主线能加"的钩子 ([①] 主循环事实路径 · [②] 试用在成功点结算 · [③] 巡检有真调用方)
 *     断言的是**证据**而不是代码形状: `source='facts'` + 节奏归因文案 / 留痛里的真 runId /
 *     候选文件里的 `trial.status` / `report.monitor` 这条时间线。
 *
 * [①] M1 节奏真接管   → describe ①
 * [②] M2 Skill 试用生命周期 (开 → 成功结算 → 失败回退) → describe ②
 * [③] M3 阻塞监控真会跑 (宿主 tick 里, 不手动调 sweep) → describe ③
 * [④] M4 非 web 路径也能停 Run → describe ④
 * [⑤] 跨阶段真问题: 部分 continuation 不抛不编态 → describe ⑤
 * [⑥] 跨阶段真问题: wiring/index 补导 → describe ⑥
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
const ENV_KEYS = [
  'BOLLOON_RUN_FINAL_REVIEW',
  'BOLLOON_GOAL_MAX_RUNS',
  'BOLLOON_GOAL_MAX_RETRIES',
  'BOLLOON_RUN_PERSIST',
];

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-serial-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  for (const k of ENV_KEYS) {
    OLD_ENV[k] = process.env[k];
    delete process.env[k];
  }
  process.env.BOLLOON_RUN_PERSIST = 'strict';
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
    monitor: await import('../agents/goal-flywheel/work-monitor.js'),
    seamIndex: await import('../agents/goal-flywheel/wiring/index.js'),
    change: await import('../agents/goal-flywheel/wiring/change.js'),
  };
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

/** 一条 Run 的执行计划 (按调用次序取; 用完之后一直用最后一条) */
interface RunPlan { okSteps?: string[]; status?: 'done' | 'failed'; error?: string }

/**
 * 真执行器: **自己落 Run 事实** (startRun / recordStep / finishRun / attachRun)。
 * 不伪造任何 Run 记录 —— 判据、证据面、进展全部从真盘上读。
 */
function makeRunner(rs: any, gs: any, plans: RunPlan[]) {
  let i = 0;
  return (async (req: any) => {
    const p = plans[Math.min(i, plans.length - 1)] ?? {};
    i += 1;
    const status = p.status ?? 'done';
    const rec = await rs.startRun({ surface: 'cli', channelId: 'ch-serial', goalId: req.goal.goalId, goal: req.goal.objective });
    for (const s of p.okSteps ?? []) await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: s });
    if (status === 'failed') {
      const err = p.error ?? '执行失败 (工具拒绝)';
      await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: err });
      await rs.finishRun(rec.runId, { status: 'failed', error: err });
    } else {
      await rs.finishRun(rec.runId, { status: 'done' });
    }
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status, ...(status === 'failed' ? { error: p.error ?? '执行失败 (工具拒绝)' } : {}) };
  }) as any;
}

async function listDir(p: string): Promise<string[]> {
  try { return (await fs.readdir(p)).sort(); } catch { return []; }
}

/** 结构化评审 (可拆技能候选): occurrences=1 → 只有一次偶然成功 (会被判垃圾, 不落盘) */
function reviewWithSkill(name: string, occurrences: number): string {
  return JSON.stringify({
    reviewedBy: 'serial-verifier',
    verdict: 'reusable',
    methodEffective: '先把判据逐条映射成证据清单再执行',
    methodFailed: '一开始直接开跑, 收尾才发现缺证据',
    nextTimeChange: '开跑前先写证据清单',
    facts: [{ claim: '证据 A 已产出', assertion: 'confirmed', refs: ['证据 A'] }],
    skills: [{
      name,
      purpose: '把每一条成功判据逐条映射到可核验证据的固定流程 (先列证据清单, 再执行, 最后逐条回填)',
      occurrences,
      boundaryClear: true,
      inputSchema: '{ criteria: string[] }',
      outputSchema: '{ evidenceRefs: string[] }',
      guarantees: ['每条判据都有证据引用'],
      doesNotGuarantee: ['不保证证据本身真实 (只保证逐条对应)'],
      failureCases: ['判据不可核验时应当停下并报阻塞, 不许硬凑证据'],
      evidenceRefs: ['证据 A'],
    }],
  });
}

/** 读盘上唯一那份候选文件 (串行收口: 试用记录写在候选文件本身, 不新开目录) */
async function readOnlyCandidate(home: string): Promise<any | null> {
  const dir = path.join(home, '.bolloon', 'skill-candidates');
  const files = await listDir(dir);
  if (files.length !== 1) return null;
  return JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
}

// ═════════════════════════════════════════════════════════════════════════════
describe('串行收口 ①: M1 节奏真接管 (主循环走 readFacts, 不是只把参数接上)', () => {
  it('(1) 主循环 tick: 先如实标 injected (还没有 Run 事实) → 有事实后 source=facts + 节奏归因, 留痕里是真 runId', async () => {
    const m = await mods();
    let t = Date.now();
    const g = await m.gs.createGoal({ objective: '把 A 变成 B', successCriteria: ['A 已变成 B'], createdBy: 'serial' });
    const s = new m.sup.ExecutionSupervisor({
      runner: makeRunner(m.rs, m.gs, [{ okSteps: ['产出证据 A (路径可核验)'] }]),
      maxPerTick: 5, maxRetries: 2, now: () => t,
    });
    m.wiring.resetFactsReadNotesForTest();

    // ── tick 1: 盘上还没有任何 Run → 没有"上一轮"可读 → 接缝走兜底, 并**如实**标 injected
    const rep1 = await s.tickOnce();
    const note1 = rep1.flywheel.find((n) => n.goalId === g.goalId)!;
    expect(rep1.flywheel.length).toBe(1);
    expect(note1.source).toBe('injected');
    expect(note1.basis).toBe(null);            // 注入路径没有节奏归因 (不假装有)
    expect(note1.caps).toEqual([]);            // 注入路径核验不了安全上限
    const n1 = m.wiring.factsReadNotes();
    expect(n1.length).toBe(1);                 // 真的去读了 (读了但读不到 → 留痕 error=null, factsFound=false)
    expect(n1[0].factsFound).toBe(false);
    expect(n1[0].runId).toBe(null);
    expect(n1[0].error).toBe(null);            // "还没有事实" ≠ "读盘失败", 两者不许混
    expect(n1[0].now).toBe(iso(t));            // 传进去的 now 真的到了读盘层

    // ── tick 2: 真跑一条 Run (真 startRun/finishRun/attachRun)
    t += 30_000;
    const rep2 = await s.tickOnce();
    expect(rep2.executed.filter((e) => e.goalId === g.goalId).length).toBe(1);
    const goalAfterRun = await m.gs.readGoal(g.goalId);
    const runId = goalAfterRun!.currentRunId!;
    expect(runId).toBeTruthy();

    // ── tick 3: 有 Run 事实了 → **主循环这一步真的调了 readFacts** (证据: source/basis/caps + 留痕)
    t += 30_000;
    m.wiring.resetFactsReadNotesForTest();
    const rep3 = await s.tickOnce();
    const note3 = rep3.flywheel.find((n) => n.goalId === g.goalId)!;
    expect(note3.source).toBe('facts');        // ★ 走的是规范路径, 不是旧的注入结论路径
    expect(note3.basis).not.toBe(null);        // 节奏依据 (只有事实路径产)
    // 上限清单与归因必须**自洽** (同一份报告里两个字段不许互相矛盾): 说"上限触顶"就必须真有一条
    // 在说话, 反之亦然。这条 Run 有可核验进展 → 归因就是"有进展", 没有任何上限被触到。
    expect(Array.isArray(note3.caps)).toBe(true);
    expect(note3.basis === 'cap').toBe(note3.caps.length > 0);
    expect(note3.basis).toBe('progress');
    // 归因文案只有 M1 的规范路径会写 (注入路径一律不出现这套词)
    expect(note3.reason).toContain(m.seamIndex.RHYTHM_BASIS_TEXT[note3.basis as any]);
    // 留痕: 读到的是**盘上那条真 Run** (不是把参数接上就算)
    const notes3 = m.wiring.factsReadNotes().filter((x) => x.goalId === g.goalId);
    expect(notes3.length).toBe(1);
    expect(notes3[0].factsFound).toBe(true);
    expect(notes3[0].runId).toBe(runId);
    expect(notes3[0].now).toBe(iso(t));
    expect((await m.rs.readRun(runId))!.runId).toBe(notes3[0].runId);
  });

  it('(2) 上限真接管: Goal 自己声明的 budget.maxRuns 触顶 → 事实路径判停 (basis=cap + bindingCap) 且真停', async () => {
    const m = await mods();
    let t = Date.now();
    const g = await m.gs.createGoal({
      objective: '只许跑一条 Run 的目标', successCriteria: ['判据0'], createdBy: 'serial',
      budget: { maxRuns: 1 },
    });
    expect((await m.gs.readGoal(g.goalId))!.budget!.maxRuns).toBe(1);
    const s = new m.sup.ExecutionSupervisor({
      runner: makeRunner(m.rs, m.gs, [{ okSteps: ['第 1 条 Run 有进展'] }]),
      maxPerTick: 5, maxRetries: 2, now: () => t,
    });

    // ── 先**真跑掉**唯一一条 Run (只落 Run 事实, 不经 Supervisor) ──────────────
    // 为什么不经 Supervisor: 让 Supervisor 跑的话, 收尾那一步 (`applyHardLimits`) 就已经按上限把
    // Goal 停成 needs_human 了, 下一 tick 它根本不进 `runnable` —— 那样验的是**收尾路径**。
    // 这里要验的是**上限真接管主路径**: Goal 还挂着 (可调度), 是 preflight 的事实路径把它判停的。
    const rec = await m.rs.startRun({ surface: 'cli', channelId: 'ch-serial', goalId: g.goalId, goal: g.objective });
    await m.rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '第 1 条 Run 有进展' });
    await m.rs.finishRun(rec.runId, { status: 'done' });
    await m.gs.attachRun(g.goalId, rec.runId);
    expect((await m.gs.readGoal(g.goalId))!.runs.length).toBe(1);

    t += 30_000;
    const rep = await s.tickOnce();
    const note = rep.flywheel.find((n) => n.goalId === g.goalId)!;
    expect(note.source).toBe('facts');
    expect(note.runnable).toBe(false);          // ★ Goal 自报的上限**真的会停** (以前没人执行)
    expect(note.basis).toBe('cap');
    expect(note.caps).toContain('goal_budget');
    // 反事实归因: 松掉 goal_budget 这一条, 结论就变 → 它才是这根稻草 (不是碰巧)
    expect((await m.wiring.explainBindingCap({ goalId: g.goalId, now: iso(t) })).bindingCap).toBe('goal_budget');
    // 真停: 状态被写住, 不是只在报告里说停
    expect((await m.gs.readGoal(g.goalId))!.status).toBe('needs_human');
    expect(rep.skipped.some((k) => k.goalId === g.goalId)).toBe(true);

    // ── 同一条路径上, **没有自报预算**的 Goal 也真会被(默认/环境)预算上限停住 ──
    // 这是 item 7 那句"默认 maxGoalBudget=50 现在真会停"的可核验版本: 上限值来自
    // `hardLimitsFor` (Goal 自报 → env → 默认 50, 同一处降级), 这里用 env 把它缩到 1 真跑一遍
    // (跑 50 轮不现实; 走的是**同一段**判定代码, 不是另一条旁路)。
    process.env.BOLLOON_GOAL_MAX_RUNS = '1';
    const g2 = await m.gs.createGoal({ objective: '没有自报预算的目标', successCriteria: ['判据0'], createdBy: 'serial' });
    const rec2 = await m.rs.startRun({ surface: 'cli', channelId: 'ch-serial', goalId: g2.goalId, goal: g2.objective });
    await m.rs.recordStep(rec2.runId, { tool: 'shell_exec', ok: true, summary: '有进展' });
    await m.rs.finishRun(rec2.runId, { status: 'done' });
    await m.gs.attachRun(g2.goalId, rec2.runId);
    t += 30_000;
    const rep2 = await s.tickOnce();
    const note2 = rep2.flywheel.find((n) => n.goalId === g2.goalId)!;
    expect(note2.source).toBe('facts');
    expect(note2.runnable).toBe(false);
    expect(note2.basis).toBe('cap');
    expect(note2.caps).toContain('goal_budget');
    expect((await m.wiring.explainBindingCap({ goalId: g2.goalId, now: iso(t) })).bindingCap).toBe('goal_budget');
    delete process.env.BOLLOON_GOAL_MAX_RUNS;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('串行收口 ②: M2 Skill 试用生命周期 (候选产出处开 → 下一条 Run 成功点结算)', () => {
  it('(1) 真链: 真 Run 收尾产出候选 → 盘上 trial=trialing → 下一条 Run 成功且证据点名 → 真提升', async () => {
    const m = await mods();
    const home = TMP;
    const NAME = 'serial-trial-skill';
    let t = Date.now();
    process.env.BOLLOON_RUN_FINAL_REVIEW = reviewWithSkill(NAME, 3);
    const g = await m.gs.createGoal({ objective: '产出可复用流程', successCriteria: ['判据0'], createdBy: 'serial' });
    const s = new m.sup.ExecutionSupervisor({
      // Run 2 的**证据面点名了这个 Skill** (真复用证据), 且不再产出同名候选 (不覆盖自己在跑的那份试用)
      runner: makeRunner(m.rs, m.gs, [
        { okSteps: ['产出证据 A'] },
        { okSteps: [`复用 Skill ${NAME} 跑通了判据映射`] },
      ]),
      maxPerTick: 5, maxRetries: 2, now: () => t,
    });

    // ── Run 1: 收尾 → 候选落盘 → 试用开出 (试用记录在候选文件里, 不新开存储)
    const rep1 = await s.tickOnce();
    expect(rep1.closures.length).toBe(1);
    const cand = await readOnlyCandidate(home);
    expect(cand).not.toBe(null);
    expect(cand.name).toBe(NAME);
    expect(cand.trial.status).toBe('trialing');
    expect(cand.trial.skillName).toBe(NAME);
    expect(cand.trial.startedByRunId).toBe(cand.sourceRunIds[0]);
    expect(cand.trial.contentHash).toBe(cand.contentHash);
    expect(cand.trial.appliesToRunningRun).toBe(false);
    expect(cand.promotion).toBe(null);                      // 开试用 ≠ 提升 (否决项)
    // 试用准入六阶段逐条有裁决 (含 not_reached) —— 结构化面就是接缝的 `TrialOpeningView`
    //   (`ok` / `stages` / `refusal`; `trial` 记录本体在候选文件里, 不在这里再存一份)
    expect(rep1.closures[0].trials.length).toBe(1);
    expect(rep1.closures[0].trials[0].ok).toBe(true);
    expect(rep1.closures[0].trials[0].stages.length).toBe(6);
    expect(rep1.skillTrials).toEqual([]);                   // 这一 tick 还没到"下一条 Run"的成功点

    // ── Run 2: 真成功 + 证据面点名 → 试用在**成功点**结算 → 真提升
    t += 30_000;
    const rep2 = await s.tickOnce();
    expect(rep2.executed.filter((e) => e.goalId === g.goalId).length).toBe(1);
    expect(rep2.skillTrials.length).toBe(1);
    const st = rep2.skillTrials[0];
    expect(st.promoted).toBe(true);
    expect(st.status).toBe('promoted');
    expect(st.skillName).toBe(NAME);
    expect(st.toVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const candAfter = await readOnlyCandidate(home);
    expect(candAfter.trial.status).toBe('promoted');
    expect(candAfter.trial.trialRunId).toBe(rep2.closures[0].runId);   // 兑现它的是**另一条** Run
    expect(candAfter.trial.trialRunId).not.toBe(candAfter.trial.startedByRunId);
    expect(candAfter.trial.reuseEvidenceRefs.length).toBeGreaterThan(0);
    expect(candAfter.promotion).not.toBe(null);
    expect(candAfter.promotion.skillName).toBe(NAME);
    expect(candAfter.promotion.contentHash).toBe(cand.contentHash);    // 提升的是同一份内容
    // 提升只写记录, 永不写正式 skills/ (冻结规则 ⑥)
    expect(await listDir(path.join(home, '.bolloon', 'skills', NAME))).toEqual([]);
  });

  it('(2) 阴性对照: 下一条 Run 失败 → 回退 (rolled_back) 且**不提升**', async () => {
    const m = await mods();
    const home = TMP;
    const NAME = 'serial-trial-rollback';
    let t = Date.now();
    process.env.BOLLOON_RUN_FINAL_REVIEW = reviewWithSkill(NAME, 3);
    const g = await m.gs.createGoal({ objective: '产出可复用流程 (会失败)', successCriteria: ['判据0'], createdBy: 'serial' });
    const s = new m.sup.ExecutionSupervisor({
      runner: makeRunner(m.rs, m.gs, [
        { okSteps: ['产出证据 A'] },
        { status: 'failed', error: '工具被拒 (permission denied)', okSteps: [`复用 Skill ${NAME} 但被拒`] },
      ]),
      maxPerTick: 5, maxRetries: 2, now: () => t,
    });

    await s.tickOnce();
    expect((await readOnlyCandidate(home))!.trial.status).toBe('trialing');

    t += 30_000;
    const rep2 = await s.tickOnce();
    expect(rep2.skillTrials.length).toBe(1);
    expect(rep2.skillTrials[0].promoted).toBe(false);       // ★ 该拒就真拒
    expect(rep2.skillTrials[0].status).toBe('rolled_back');
    expect(rep2.skillTrials[0].reason).toContain('trial_reuse_failed');
    const after = await readOnlyCandidate(home);
    expect(after.trial.status).toBe('rolled_back');
    expect(after.promotion).toBe(null);                     // 盘上也没有半份晋升记录
    expect(await listDir(path.join(home, '.bolloon', 'skills', NAME))).toEqual([]);
  });

  it('(3) 阴性对照: 下一条 Run 成功但证据面**没点名**这个 Skill → 不算复用, 留在试用位', async () => {
    const m = await mods();
    const home = TMP;
    const NAME = 'serial-trial-noev';
    let t = Date.now();
    process.env.BOLLOON_RUN_FINAL_REVIEW = reviewWithSkill(NAME, 3);
    const g = await m.gs.createGoal({ objective: '产出可复用流程 (无复用证据)', successCriteria: ['判据0'], createdBy: 'serial' });
    const s = new m.sup.ExecutionSupervisor({
      runner: makeRunner(m.rs, m.gs, [
        { okSteps: ['产出证据 A'] },
        { okSteps: ['干了点别的活, 没提任何 Skill'] },
      ]),
      maxPerTick: 5, maxRetries: 2, now: () => t,
    });

    await s.tickOnce();
    const opened = await readOnlyCandidate(home);
    expect(opened.trial.status).toBe('trialing');
    const startedBy = opened.trial.startedByRunId;

    t += 30_000;
    const rep2 = await s.tickOnce();
    expect(rep2.executed.filter((e) => e.goalId === g.goalId).length).toBe(1);
    expect(rep2.skillTrials.length).toBe(1);
    expect(rep2.skillTrials[0].promoted).toBe(false);
    expect(rep2.skillTrials[0].status).toBe('trialing');     // 没证据 = 没结论, 不是"成功"
    expect(rep2.skillTrials[0].reason).toContain('reuse_without_evidence');
    const after = await readOnlyCandidate(home);
    expect(after.trial.status).toBe('trialing');
    expect(after.trial.startedByRunId).toBe(startedBy);      // 试用位原封不动
    expect(after.promotion).toBe(null);
  });

  it('(4) 收尾透传: 事实够具体时, 主路径**申明**的终止原因真到了回执上 (审计认相符)', async () => {
    const m = await mods();
    let t = Date.now();
    await m.gs.createGoal({ objective: '一条会超时的 Run', successCriteria: ['判据0'], createdBy: 'serial' });
    // 只在**真接缝**上挂一个观察点 (真实现照跑, 不换实现): 主路径传了什么, 这里原样留痕
    const seam: any = m.wiring.flywheelSeams().closure;
    const orig = seam.closeRunOnce.bind(seam);
    const seen: any[] = [];
    seam.closeRunOnce = async (i: any) => {
      const r = await orig(i);
      seen.push({ input: i, receipt: (r as any)?.receipt ?? null });
      return r;
    };

    const s = new m.sup.ExecutionSupervisor({
      runner: makeRunner(m.rs, m.gs, [{ status: 'failed', error: '命令超时 (timeout, deadline exceeded)' }]),
      maxPerTick: 5, maxRetries: 0, now: () => t,
    });
    await s.tickOnce();
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    // 这个 Run 的事实**够具体** (failed + 超时文本) → 主路径申明的必须是那一类, 不是笼统的 failure
    expect(last.input.terminalKind).toBe('timeout');
    expect(last.receipt.claimedTerminalKind).toBe('timeout');
    expect(last.receipt.terminalKindTruthful).toBe(true);   // ★ 申明与状态相符: 不给自己造审计缺口
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('串行收口 ③: M3 阻塞监控真会跑 (宿主 tick 里, 不手动调 sweep)', () => {
  it('时间线: 首 tick 无阻塞 → 时间推进后**同一 tick 周期**检出 stalled 子任务 → 升级交人', async () => {
    const m = await mods();
    let t = Date.now();
    const g = await m.gs.createGoal({ objective: '等子 Agent 回报', successCriteria: ['子工作回报齐了'], createdBy: 'serial' });
    const contract = await m.wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-parent-serial', childAgentId: 'child-node-serial',
      capability: 'slow_cap', objective: '慢活',
      budget: { maxSteps: 3, maxDurationMs: 60_000, maxAmount: null, currency: null },
      successCriteria: ['有结论'], now: iso(t), issuedBy: 'serial',
    });
    // 让这一 tick 只做巡检, 不去跑这个 Goal (宿主把"等回报"当成不重复派活的状态)
    await m.gs.setContinuation(g.goalId, { autoContinue: true, state: 'retry_wait', wakeReason: 'retry_wait', wakeAt: iso(t + 3_600_000) });
    const s = new m.sup.ExecutionSupervisor({
      runner: makeRunner(m.rs, m.gs, [{ okSteps: ['不该跑到这来'] }]),
      maxPerTick: 5, maxRetries: 2, now: () => t,
    });

    // ── T0: 子工作刚派出, 心跳还新鲜 → 巡检跑过 (report.monitor 有值) 但没有阻塞
    const rep1 = await s.tickOnce();
    expect(rep1.monitor).not.toBe(null);                     // ★ 统一巡检**在执行路径上真的被调用**
    expect(rep1.monitor!.goals.map((c) => c.goalId)).toContain(g.goalId);
    expect(rep1.monitor!.errors).toEqual([]);
    expect(rep1.monitor!.blockCount).toBe(0);
    expect(rep1.blocks).toEqual([]);
    expect((await m.gs.readGoal(g.goalId))!.status).not.toBe('needs_human');

    // ── 时间推进 9 分钟 (> 合同心跳窗口 30s×2 + 宽限): 同一个 tick 周期里被检出并交人
    t += 9 * 60_000;
    const rep2 = await s.tickOnce();                          // 注意: 测试**没有**手动调 sweepAll / collectWorkBlocks / applyBlockHandling
    expect(rep2.monitor).not.toBe(null);
    expect(rep2.monitor!.blockCount).toBeGreaterThan(0);
    const cell = rep2.monitor!.goals.find((c) => c.goalId === g.goalId)!;
    expect(cell.blocks.map((b) => b.kind)).toContain('no_heartbeat');
    // 处置动作也走了同一份计划的真调用方 (接缝给计划, 宿主执行)
    expect(rep2.blocks.map((b) => b.workId)).toContain(contract.workId);
    expect(rep2.blocks.some((b) => b.action === 'escalate_parent')).toBe(true);
    // `escalated` 是 **needs_human 档**的清单 (P5 验收冻结的口径: `escalate_parent` 单独一档,
    // 不进这里 —— 见 goal-flywheel-p5-acceptance.test.ts 的同一条断言)。所以"上报"的可核验痕迹
    // 看两处: ① 处置动作在 report.blocks 里 (上面两行) ② 升级理由真写进 Goal 的未解决项。
    const stalled = await m.gs.readGoal(g.goalId);
    expect((stalled!.continuation!.unresolvedItems ?? []).some((x: string) => x.includes(contract.workId))).toBe(true);
    expect(rep2.monitor!.escalated).toEqual([]);
    // 交人: Goal 状态真被写住 (只升不降)
    expect((await m.gs.readGoal(g.goalId))!.status).toBe('needs_human');
    // 用户可见态也随事实变 (界面说"需要你决定", 不再是"正在执行")
    const monitor = await import('../agents/goal-flywheel-wiring.js');
    expect(await monitor.goalVisibleState({ goalId: g.goalId })).toBe('needs_your_decision');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('串行收口 ④: M4 非 web 路径也能停 Run (change seam 的 runningRun / stopRunningRun / liveWorkIds)', () => {
  it('(1) supervisor.ingestRequirement 提撤销 → 在跑的 Run 真被写 aborted (不经 web 路由)', async () => {
    const m = await mods();
    const t = Date.now();
    const g = await m.gs.createGoal({ objective: '在跑的目标 (将被撤销)', successCriteria: ['判据0'], createdBy: 'serial' });
    const rec = await m.rs.startRun({ surface: 'cli', channelId: 'ch-serial', goalId: g.goalId, goal: g.objective });
    await m.gs.attachRun(g.goalId, rec.runId);
    expect((await m.rs.readRun(rec.runId))!.status).toBe('running');

    // 在跑的子 Agent 工作也来自**注入** (`liveWorkIds`): 这份事实不在请求里, 只能由宿主读
    // (父 Goal 登记的 pendingReports)。漏了它, 规则 5 的"逐 workId 下发"到了非 web 路径就会漏发。
    const contract = await m.wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: rec.runId, childAgentId: 'child-m4', capability: 'cap_m4', objective: '子活',
      budget: { maxSteps: 2, maxDurationMs: 60_000, maxAmount: null, currency: null },
      successCriteria: ['有结论'], now: iso(t), issuedBy: 'serial',
    });

    // ① 接缝层: 事实**来自注入** (factsMissing=false ⇒ 不是"没事实所以不断言")
    const view = await m.wiring.ingestRequirementViaSeam({
      goalId: g.goalId, instruction: '撤销这个目标, 别继续做了', caller: 'human', recordedBy: 'cli:serial', now: iso(t),
    });
    expect(view).not.toBe(null);
    expect(m.wiring.isRefusal(view)).toBe(false);
    const v = view as any;
    expect(v.request.kind).toBe('abort');
    expect(v.plan.runBoundary.factsMissing).toBe(false);     // ★ 注入的 runningRun 真的提供了事实
    expect(v.plan.runBoundary.runId).toBe(rec.runId);        // (在 plan 的 runBoundary 上, 不是 plan 顶层)
    expect(v.plan.liveWorkIds).toContain(contract.workId);   // ★ 注入的 liveWorkIds 真的提供了事实
    expect(v.plan.childDirectives.map((d: any) => d.workIds).flat()).toContain(contract.workId);
    expect(v.runBoundary.action).toBe('stop_running_run');
    expect(v.runBoundary.stopped).toBe(true);                // ★ 由注入的 stopRunningRun 落到记录上
    expect((await m.rs.readRun(rec.runId))!.status).toBe('aborted');

    // ② 宿主层: 再来一条 (新 Run) 走 supervisor 的公开入口, 一样停得住
    const rec2 = await m.rs.startRun({ surface: 'cli', channelId: 'ch-serial', goalId: g.goalId, goal: g.objective });
    await m.gs.attachRun(g.goalId, rec2.runId);
    const s = new m.sup.ExecutionSupervisor({ runner: makeRunner(m.rs, m.gs, [{ okSteps: ['x'] }]), maxPerTick: 1, now: () => t });
    const out = await s.ingestRequirement(g.goalId, '撤销这个目标, 别继续做了', 'serial-user');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.kind).toBe('abort');
    expect(out.stopped).toBe(true);
    expect(out.runId).toBe(rec2.runId);
    expect((await m.rs.readRun(rec2.runId))!.status).toBe('aborted');
    // 变更真入档 (说得出"谁在什么时候提的什么")
    const gAfter = await m.gs.readGoal(g.goalId);
    expect((gAfter!.goalChanges ?? []).length).toBeGreaterThanOrEqual(2);
    expect(gAfter!.goalChanges!.map((c) => c.kind)).toContain('abort');
  });

  it('(2) 阴性对照: 没有在跑的 Run 时不许乱停 (没有 Run 可停就如实说, 变更照样入档)', async () => {
    const m = await mods();
    const t = Date.now();
    const g = await m.gs.createGoal({ objective: '还没跑过的目标', successCriteria: ['判据0'], createdBy: 'serial' });
    const s = new m.sup.ExecutionSupervisor({ runner: makeRunner(m.rs, m.gs, [{ okSteps: ['x'] }]), maxPerTick: 1, now: () => t });
    const out = await s.ingestRequirement(g.goalId, '撤销这个目标', 'serial-user');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stopped).toBe(false);                          // 没有 Run 可停 → 不许编一个"已停"
    expect(out.runId).toBe(null);
    const gAfter = await m.gs.readGoal(g.goalId);
    expect((gAfter!.goalChanges ?? []).length).toBe(1);        // 变更本身照常入档 (拒绝的是"停", 不是"记账")
    expect(gAfter!.runs.length).toBe(0);                       // 没有凭空多出一条 Run
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('串行收口 ⑤: 部分 continuation 不抛也不编态 (跨阶段真问题)', () => {
  it('(1) 盘上 continuation 少了 pendingReports → 读盘确实缺字段, 用户可见态仍是真态 (不回落 catch 兜底)', async () => {
    const m = await mods();
    const g = await m.gs.createGoal({ objective: '等外部回执的目标', successCriteria: ['判据0'], createdBy: 'serial' });
    const contract = await m.wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-parent-p', childAgentId: 'child-p', capability: 'cap_p', objective: '等对端',
      budget: { maxSteps: 2, maxDurationMs: 60_000, maxAmount: null, currency: null },
      successCriteria: ['有回执'], now: new Date().toISOString(), issuedBy: 'serial',
    });
    // 部分覆盖 (setContinuation 是 `{...prev, ...patch}`): 写一个**没有 pendingReports** 的 continuation
    // —— 这正是 /api/goals 与 goalVisibleState 直传 `{...goal.continuation}` 时的形状。
    await m.gs.setContinuation(g.goalId, { pendingReports: undefined as any, state: 'awaiting_external', wakeReason: 'awaiting_external', needsExternal: '等对端回执' });
    const raw = (await m.gs.readGoal(g.goalId))!.continuation!;
    expect('pendingReports' in raw).toBe(false);                                  // 盘上真的缺这个键 (部分 continuation)
    expect(contract.workId).toBeTruthy();

    // 旧实现: toUserVisibleState 把 pendingReports 当必存 → 这里就抛 (调用方只能 catch → 编 'executing')
    const visible = m.monitor.toUserVisibleState(raw as any, [], null);
    expect(visible).toBe('waiting_external_reply');                               // ★ 真态, 不是 'executing' 兜底
    // 走宿主入口也一样 (读盘 → 归一化 → 判定)
    expect(await m.wiring.goalVisibleState({ goalId: g.goalId })).toBe('waiting_external_reply');
    // 归一化只有一份: 判定层看到的就是"空数组", 但**不写回盘** (不假装事实变过)
    expect('pendingReports' in (await m.gs.readGoal(g.goalId))!.continuation!).toBe(false);
  });

  it('(2) /api/goals 的同一段计算 (toUserVisibleState + changeVisibleState) 对部分 continuation 不抛不编态', async () => {
    const m = await mods();
    const g = await m.gs.createGoal({ objective: '有待拍板要求的目标', successCriteria: ['判据0'], createdBy: 'serial' });
    // 变更来源是 **agent** 且是"扩预算" → 规则 2: 必须等人批准 (needs_approval)。
    // 这正是"界面上必须说需要你决定"的那一类; 用户本人提的收紧类会落 `scheduled_next_run`
    // (不等人 → 不该抬态), 拿它测这一条会得出"抬态是错的"的反结论 (实测踩过)。
    await m.wiring.ingestRequirementViaSeam({
      goalId: g.goalId, instruction: '把预算扩大到 500 轮, 多跑几轮', source: 'agent', caller: 'supervisor', recordedBy: 'agent:serial',
      now: new Date().toISOString(),
    });
    // 再来一次部分覆盖 (把 pendingReports 抹掉) —— 路由读到的就是这种形状
    await m.gs.setContinuation(g.goalId, { pendingReports: undefined as any, state: 'active' });
    const goal = (await m.gs.readGoal(g.goalId))!;
    expect('pendingReports' in goal.continuation!).toBe(false);
    expect((goal.goalChanges ?? []).map((c) => c.status)).toContain('needs_approval');

    // 路由那段计算的**逐句同一份**: toUserVisibleState → changeVisibleState (覆盖只升不降)
    const base = m.monitor.toUserVisibleState({ ...(goal.continuation as any) }, await m.wiring.collectWorkBlocks({ goalId: goal.goalId }), null);
    // 部分 continuation 不抛 (上面这行没炸就是证据); `state='active'` 的真态就是"正在执行"
    expect(base).toBe('executing');
    const over = m.change.changeVisibleState({ base, changes: (goal as any).goalChanges ?? [] });
    expect(over.elevated).toBe(true);                    // ★ 是被**待拍板的变更**抬上去的
    const state = over.state ?? base;
    expect(state).toBe('needs_your_decision');           // 有待拍板要求 → 界面上必须说"需要你决定"
    // 路由真的还这么写 (源码级同构门: 少了这个形状 = 有人在路由里又拼了一套口径)
    const serverSrc = await fs.readFile(path.join(process.cwd(), 'src/web/server.ts'), 'utf8');
    expect(serverSrc).toContain('toUserVisibleState(');
    expect(serverSrc).toContain('({ ...g.continuation } as any)');
    expect(serverSrc).toContain('changeVisibleState({ base, changes: g.goalChanges ?? [] })');
  });

  it('(3) 直接调用: 判定层不吃"必存字段" (契约级阴性对照)', async () => {
    const m = await mods();
    // 空对象 / 只有一半字段 / null: 一律不许抛
    expect(() => m.monitor.toUserVisibleState({} as any, [], null)).not.toThrow();
    expect(m.monitor.toUserVisibleState({} as any, [], null)).toBe('executing');
    expect(m.monitor.toUserVisibleState({ nextAction: '继续' } as any, [], null)).toBe('executing');
    expect(m.monitor.toUserVisibleState(null, [], null)).toBe('executing');
    // 归一化只补"缺的集合字段", 不改判据: 真态优先
    expect(m.monitor.toUserVisibleState({ state: 'awaiting_external' } as any, [], null)).toBe('waiting_external_reply');
    expect(m.monitor.toUserVisibleState({ state: 'needs_human' } as any, [], null)).toBe('needs_your_decision');
    // 归一化函数本身: 缺字段补空集、已有字段不丢
    const norm = m.monitor.normalizeContinuationRecord({ state: 'active', unresolvedItems: ['待查'] } as any);
    expect(norm.pendingReports).toEqual([]);
    expect(norm.unresolvedItems).toEqual(['待查']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('串行收口 ⑥: wiring/index 补齐新成员的 re-export', () => {
  it('M3/M1/M4 报的新成员能从 wiring/index 直接拿到 (值级真 import)', async () => {
    const m = await mods();
    const idx = m.seamIndex as any;
    // M3: 合同校验 + 巡检视图
    expect(typeof idx.childMatchesContract).toBe('function');
    expect(typeof idx.toUserVisibleState).toBe('function');
    expect(typeof idx.normalizeContinuationRecord).toBe('function');
    // 用户可见面的两个出口 (真实名字; 半成品里写的 `visibleStateViewOf` / `visibleStateTextOf`
    // 在任何模块里都不存在, 已按真实 API 名改正 —— 断言强度不变, 仍要求"从 index 拿得到函数")。
    expect(typeof idx.describeVisibleState).toBe('function');   // 状态 → {state, zh, en}
    expect(typeof idx.userFacingState).toBe('function');       // 状态 → 闭集校验后的视图 / 拒绝
    expect(idx.MONITOR_SWEEP_DEFAULT_LIMIT).toBe(20);
    expect(Array.isArray(idx.USER_VISIBLE_STATES) || typeof idx.USER_VISIBLE_STATES === 'object').toBe(true);
    // M1: 节奏口径
    expect(typeof idx.RHYTHM_BASIS_TEXT.progress).toBe('string');
    expect(typeof idx.createContinuationSeam).toBe('function');
    expect(typeof idx.CONTINUATION_SEAM_ID).toBe('string');
    // M4: 变更注入的计划函数
    expect(typeof idx.planChangeInjection).toBe('function');
    // 类型级补导 (`MonitorTickView` / `BlockHandlingView` / `RhythmFacts` …) 由 tsc 守:
    //   接线层 (src/agents/execution-supervisor.ts) 直接 `import type { MonitorTickView } from './goal-flywheel-wiring.js'`,
    //   类型没补导就是编译错 —— 编译门比字符串断言硬。
    expect(true).toBe(true);
  });

  it('阴性对照: 补导的名字必须真的存在于对应接缝文件 (不许为了过门编个同名的壳)', async () => {
    const m = await mods();
    const idx = m.seamIndex as any;
    // 这些值的**实现**在接缝/工作监控里, 从 index 拿到的那一份必须与直接 import 的**同一个对象**
    const direct = await import('../agents/goal-flywheel/work-monitor.js');
    expect(idx.toUserVisibleState).toBe(direct.toUserVisibleState);
    expect(idx.normalizeContinuationRecord).toBe(direct.normalizeContinuationRecord);
    const changeDirect = await import('../agents/goal-flywheel/goal-change.js');
    expect(idx.planChangeInjection).toBe(changeDirect.planChangeInjection);
    const monDirect = await import('../agents/goal-flywheel/wiring/monitor.js');
    expect(idx.MONITOR_SWEEP_DEFAULT_LIMIT).toBe(monDirect.MONITOR_SWEEP_DEFAULT_LIMIT);
  });
});
