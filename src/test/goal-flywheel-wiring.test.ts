/**
 * goal-flywheel **接线**验收 (2026-09-25)
 *
 * 这一份不做单元级验收 (那已有 7 个 `goal-flywheel-*.test.ts`), 只回答一个问题:
 * **P0–P4 是否真的长在真实执行路径上**。
 *
 * 手法全部是"真跑": 真 `ExecutionSupervisor` + 真 Goal/Run Store (隔离 HOME) +
 * 真落盘的 continuation / 决策记录 / Memory / 用户汇报 / 工作合同。
 *
 * 覆盖 (对应用户验收清单):
 *   ① 选 Goal → 节奏判定 → Run → **收尾飞轮** → 写回 (正常 / 失败 / 中断恢复都走同一条)
 *   ② 轮次不再是主停止条件 (有进展就不停; 没进展才停)
 *   ③ 无进展熔断 (人工造无进展 → 熔断, 不是无限转)
 *   ④ 三类硬底线只能收紧 (单 Goal 预算上限真拦住下一轮)
 *   ⑤ 子 Agent: 漂亮但没有逐条证据的回报 → **不接受为完成**
 *   ⑥ 阻塞监控看的是"任务卡住"而不是"进程活着" (心跳缺失 → 被发现)
 *   ⑦ 新要求注入: 下一 Run 真读到, 已发生的 Run 记录不被改写
 *   ⑧ 用户可见态 (六类) 是界面唯一映射 (`toUserVisibleState`)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { AgentWorkReport } from '../agents/goal-flywheel/types.js';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const OLD_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'BOLLOON_RUN_FINAL_REVIEW',
  'BOLLOON_GOAL_NO_PROGRESS_BREAKER',
  'BOLLOON_GOAL_MAX_RUNS',
  'BOLLOON_GOAL_MAX_RETRIES',
  'BOLLOON_RUN_PERSIST',
];

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-fw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  for (const k of ENV_KEYS) {
    OLD_ENV[k] = process.env[k];
    if (k !== 'BOLLOON_RUN_PERSIST' && k !== 'BOLLOON_RUN_FINAL_REVIEW') delete process.env[k];
  }
  delete process.env.BOLLOON_RUN_FINAL_REVIEW;
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
    fly: await import('../agents/goal-flywheel/index.js'),
  };
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

interface RunnerOpts {
  status?: 'done' | 'failed';
  okSteps?: string[];
  failError?: string;
  capture?: (req: any) => void;
}

/**
 * 真执行器: **自己落 Run 事实** (startRun / recordStep / finishRun / attachRun),
 * 不伪造任何 Run 记录 —— Goal 与 Run 的关联由真实 attachRun 完成。
 */
function makeRunner(rs: any, gs: any, opts: RunnerOpts = {}) {
  const status = opts.status || 'done';
  return (async (req: any) => {
    opts.capture?.(req);
    if (req.kind === 'resume' && req.prevRunId) {
      // 中断恢复: 先把 run 状态机推回可写状态, 再收尾 (真 API, 不手改文件)
      await rs.prepareResume(req.prevRunId).catch(() => null);
      await rs.finishRun(req.prevRunId, {
        status: status === 'failed' ? 'failed' : 'done',
        ...(status === 'failed' ? { error: opts.failError || '网络抖动 (ECONNRESET)' } : {}),
      });
      return { runId: req.prevRunId, status };
    }
    const rec = await rs.startRun({ channelId: 'ch-fw', goalId: req.goal.goalId, goal: req.goal.objective });
    for (const s of opts.okSteps || []) await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: s });
    if (status === 'failed') {
      const err = opts.failError || '网络抖动 (ECONNRESET)';
      await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: err });
      await rs.finishRun(rec.runId, { status: 'failed', error: err });
    } else {
      await rs.finishRun(rec.runId, { status: 'done' });
    }
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status, ...(status === 'failed' ? { error: opts.failError || '网络抖动 (ECONNRESET)' } : {}) };
  }) as any;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('飞轮接线 ①: Run 结束必过 closeRun (收尾 9 步 + 产物落盘 + 写回 continuation)', () => {
  it('正常 Run: 9 步都走过, Memory/候选/用户汇报/决策记录真落盘, Goal 上有权威 continuation', async () => {
    const { gs, sup, wiring, monitor, fly } = await mods();
    process.env.BOLLOON_RUN_FINAL_REVIEW =
      '## 最终评审\n评审: 验收通过, 判据 1 已满足\n事实: 用 shell_exec 产出了 X 的路径\n教训: 下次先确认路径存在\n候选: 加一条"路径必须存在"的检查';
    const g = await gs.createGoal({ objective: '把 A 变成 B', successCriteria: ['A 已变成 B'] });
    const rs = await import('../agents/run-store.js');
    let seen = '';
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['写好了 /tmp/x'], capture: (r) => { seen = r.instruction; } }),
      maxPerTick: 5,
      maxRetries: 2,
    });
    const rep = await s.tickOnce();

    // ① 收尾真的跑了, 且是完整的 9 步流水线
    expect(rep.closures.length).toBe(1);
    expect(rep.closures[0].goalId).toBe(g.goalId);
    expect(rep.closures[0].steps).toBe(9);
    // ② 决策是飞轮给的 (不是只有 reducer)
    //    flywheel 摘要 = **跑之前**的节奏判定 (首个 Run 之前没有 Run 事实 → first_run);
    //    收尾的权威决策在 closures[0] (本轮有 ok 步骤 = 有可核验进展 → continue)
    expect(rep.flywheel.length).toBe(1);
    expect(rep.flywheel[0].decision).toBe('first_run');
    expect(rep.flywheel[0].runnable).toBe(true);
    expect(rep.flywheel[0].visibleState).toBe('executing');
    expect(rep.closures[0].decision).toBe('continue');

    // ③ Goal JSON 里出现权威 continuation / nextAction
    const after = await gs.readGoal(g.goalId);
    expect(after!.continuation!.nextAction).toBeTruthy();
    expect(after!.continuation!.lastDecisionId).toBeTruthy();
    expect(after!.continuation!.state).toBe('active');
    expect(after!.continuation!.unresolvedItems).toEqual([]);

    // ④ 产物真在盘上: 用户汇报 + 决策记录 (可回放) + Memory
    expect(await exists(rep.closures[0].reportPath)).toBe(true);
    expect(await exists(rep.closures[0].decisionRecordPath)).toBe(true);
    const records = await wiring.readDecisionRecords(g.goalId);
    expect(records.map((r) => r.phase).sort()).toEqual(['closure', 'preflight']);
    const memoryDir = path.join(TMP, fly.MEMORY_LAYERS_ROOT, 'run_fact');
    const memFiles = await fs.readdir(memoryDir).catch(() => [] as string[]);
    expect(memFiles.length).toBeGreaterThan(0);

    // ⑤ 执行指令里带上了飞轮下一步 (下一次 Run 真的读到)
    expect(seen).toContain('开始执行这个目标');

    // ⑥ 用户可见态只走 toUserVisibleState
    const visible = await wiring.goalVisibleState({ goalId: g.goalId });
    expect(fly.USER_VISIBLE_STATES).toContain(visible);
    expect(fly.USER_VISIBLE_STATE_LABELS[visible].zh).toBeTruthy();
  });

  it('失败 Run 与"中断后恢复"的 Run 同样过收尾 (不是只在成功时执行)', async () => {
    const { gs, rs, sup } = await mods();
    let t = Date.now();
    const clock = () => t;
    const g = await gs.createGoal({ objective: '三种结尾都要收尾', successCriteria: ['有 3 次收尾'] });

    // 第 1 次: 失败 (无进展)
    const failSup = new sup.ExecutionSupervisor({ runner: makeRunner(rs, gs, { status: 'failed' }), maxPerTick: 5, maxRetries: 5, now: clock });
    const r1 = await failSup.tickOnce();
    expect(r1.closures.length).toBe(1);
    expect(r1.closures[0].decision).toBe('ask_human');    // 没证据 → 没有继续的资格

    // 第 2 次: 人工把 Run 置成 interrupted (真状态机) → supervisor 走 **resume** 分支
    t += 60_000;
    const runId = (await gs.readGoal(g.goalId))!.currentRunId!;
    const rawRun = await rs.readRun(runId);
    expect(rawRun!.status).toBe('failed');
    // 造一个真 interrupted 的 Run (从 running 迁到 interrupted 是合法迁移)
    const rec2 = await rs.startRun({ channelId: 'ch-fw2', goalId: g.goalId, goal: '中断恢复' });
    await rs.recordStep(rec2.runId, { tool: 'shell_exec', ok: true, summary: '做到一半' });
    await gs.attachRun(g.goalId, rec2.runId);
    await rs.finishRun(rec2.runId, { status: 'interrupted', error: '进程被杀' });
    expect((await rs.readRun(rec2.runId))!.status).toBe('interrupted');

    const s2 = new sup.ExecutionSupervisor({ runner: makeRunner(rs, gs, { status: 'done', okSteps: ['恢复后补完'] }), maxPerTick: 5, maxRetries: 5, now: clock });
    const rep2 = await s2.tickOnce();
    // resume 分支真的被走到, 且**照样过收尾**
    expect(rep2.closures.length).toBe(1);
    expect(rep2.closures[0].runId).toBe(rec2.runId);
    expect(rep2.closures[0].steps).toBe(9);
    const records = await (await import('../agents/goal-flywheel-wiring.js')).readDecisionRecords(g.goalId);
    expect(records.filter((r) => r.phase === 'closure').map((r) => r.runId)).toContain(rec2.runId);
  });
});

describe('飞轮接线 ②: 节奏由进展决定 (轮次不再是主停止条件)', () => {
  it('maxRetries 用尽但本轮有可核验进展 → 飞轮覆盖"轮次用尽", 继续跑第 3 轮', async () => {
    const { gs, rs, sup } = await mods();
    let t = Date.now();
    const g = await gs.createGoal({ objective: '有进展就不许停', successCriteria: ['判据未满足'] });
    // 每次都是"失败但产出了可核验证据"的 Run → 旧 reducer 会在 maxRetries=1 时停下
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { status: 'failed', okSteps: ['推进了一步 (有路径引用)'] }),
      maxPerTick: 5, maxRetries: 1, now: () => t,
    });
    await s.tickOnce();
    t += 30_000;
    await s.tickOnce();
    t += 120_000;
    const rep3 = await s.tickOnce();

    const after = await gs.readGoal(g.goalId);
    // 旧 reducer 到第 2 次失败就该 needs_human 并 autoContinue=false; 飞轮看到进展 → 继续
    //   (第 3 个 Run 真的跑了 = "轮次不是主停止条件" 的可核验证据)
    expect(after!.runs.length).toBe(3);
    expect(rep3.executed.length).toBe(1);
    // 不是因为"轮次/次数"被跳过的 (真正的证据: runs.length=3 且这一轮真的执行了)
    expect(rep3.skipped.filter((x) => /轮次|自动继续次数|needs_human/.test(x.reason))).toEqual([]);
    expect(after!.status).toBe('retry_wait');           // 失败但没判死
    expect(after!.continuation!.autoContinue).toBe(true);
  });
});

describe('飞轮接线 ③: 无进展熔断 (人工造无进展 → 停, 不是无限转)', () => {
  it('把熔断阈值收紧到 1 (maxRetries=5) → 一次无证据的 Run 就交人, 且之后不再跑', async () => {
    const { gs, rs, sup, wiring } = await mods();
    process.env.BOLLOON_GOAL_NO_PROGRESS_BREAKER = '1';
    let t = Date.now();
    const g = await gs.createGoal({ objective: '造一个永远没进展的目标', successCriteria: ['永远不满足'] });
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { status: 'failed' }),   // 无 ok 步骤 = 无新证据
      maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    const rep1 = await s.tickOnce();
    const after1 = await gs.readGoal(g.goalId);

    // 熔断: 硬底线只能收紧 → 1 轮无进展就停 (旧 reducer 会允许 6 轮)
    expect(after1!.runs.length).toBe(1);
    expect(after1!.status).toBe('needs_human');
    expect(after1!.continuation!.autoContinue).toBe(false);
    expect(after1!.continuation!.state).toBe('needs_human');
    expect(rep1.closures[0].decision).toBe('ask_human');
    const records = await wiring.readDecisionRecords(g.goalId);
    const closure = records.find((r) => r.phase === 'closure')!;
    expect(closure.decision.state).toBe('no_progress');
    expect(closure.decision.reason).toContain('熔断');

    // 而不是无限转: 再 tick 两次也不开新 Run
    t += 600_000;
    const rep2 = await s.tickOnce();
    t += 600_000;
    await s.tickOnce();
    const after2 = await gs.readGoal(g.goalId);
    expect(after2!.runs.length).toBe(1);
    expect(rep2.executed.length).toBe(0);
    expect(rep2.skipped.some((x) => x.reason.includes('等人') || x.reason.includes('飞轮'))).toBe(true);
  });
});

describe('飞轮接线 ④: 三类硬底线只能收紧', () => {
  it('单 Goal 预算上限 (BOLLOON_GOAL_MAX_RUNS=1) 真的拦住下一轮, 且理由是硬底线', async () => {
    const { gs, rs, sup, wiring } = await mods();
    process.env.BOLLOON_GOAL_MAX_RUNS = '1';
    let t = Date.now();
    const g = await gs.createGoal({ objective: '预算只够一轮', successCriteria: ['判据永远不满足'] });
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['第一轮有进展'] }),
      maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    await s.tickOnce();
    t += 60_000;

    // 节奏判定: 有进展但预算用尽 → 不许再开
    const step = await wiring.decideGoalStep({ goalId: g.goalId, now: new Date(t).toISOString(), maxRetries: 5 });
    expect(step!.runnable).toBe(false);
    expect(step!.reason).toContain('硬底线');
    expect(step!.hardLimits.maxGoalBudget).toBe(1);

    const rep2 = await s.tickOnce();
    expect(rep2.executed.length).toBe(0);
    const after = await gs.readGoal(g.goalId);
    expect(after!.runs.length).toBe(1);
  });

  it('单 Run 时间上限与无进展阈值只能收紧 (applyHardLimits 不会放宽飞轮决策)', async () => {
    const { gs, rs, wiring } = await mods();
    const g = await gs.createGoal({ objective: '硬底线形状', successCriteria: ['x'] });
    const rec = await rs.startRun({ channelId: 'ch-hl', goalId: g.goalId, goal: 'x' });
    await rs.finishRun(rec.runId, { status: 'failed', error: '网络抖动' });
    await gs.attachRun(g.goalId, rec.runId);
    const goal = (await gs.readGoal(g.goalId))!;
    const run = (await rs.readRun(rec.runId))!;
    const limits = wiring.hardLimitsFor({ goal, run, maxRetries: 2 });
    expect(limits.maxGoalBudget).toBeGreaterThan(0);
    expect(limits.maxRunDurationMs).toBeGreaterThan(0);
    expect(limits.noProgressCircuitBreaker).toBe(3);   // = maxRetries + 1 (与旧行为一致, 但依据是"有没有证据")
  });
});

describe('飞轮接线 ⑤: 子 Agent 走工作合同 (漂亮但没有证据 → 不接受为完成)', () => {
  it('报"全部完成"但证据为空 → 不接受; 补上逐条证据后才接受, 父 Goal 才有证据', async () => {
    const { gs, wiring } = await mods();
    const g = await gs.createGoal({ objective: '父目标: 需要子 Agent 收数据', successCriteria: ['有 3 条数据'] });
    const contract = await wiring.dispatchChildWork({
      goalId: g.goalId,
      parentRunId: 'run-parent-1',
      childAgentId: 'child-node-1',
      capability: 'collect_data',
      objective: '收集 3 条数据',
      budget: { maxSteps: 5, maxDurationMs: 60_000, maxAmount: null, currency: null },
      successCriteria: ['有 3 条数据 (路径可核验)'],
      issuedBy: 'test',
    });
    expect(await exists(wiring.contractPathFor(g.goalId, contract.workId))).toBe(true);
    // 派遣已经把"等回报"写进 continuation (父知道自己在等谁)
    const afterDispatch = await gs.readGoal(g.goalId);
    expect(afterDispatch!.continuation!.pendingReports!.map((p) => p.workId)).toContain(contract.workId);

    const base = {
      workId: contract.workId,
      childAgentId: contract.childAgentId,
      summary: '一切顺利, 数据都收齐了, 可以直接用',
      artifacts: [] as any[],
      checks: [{ name: '自检', verdict: 'pass' as const, detail: '看着没问题' }],
      unresolvedItems: [] as string[],
      blockReason: null,
      nextRecommendation: '直接合并',
      durationMs: 1234,
      reportedAt: new Date().toISOString(),
    };
    // ① 漂亮但没有逐条证据
    const beautiful: AgentWorkReport = { ...base, status: 'completed', evidence: [] };
    const r1 = await wiring.handleChildReport({ goalId: g.goalId, workId: contract.workId, report: beautiful });
    expect(r1.accepted).toBe(false);
    expect(r1.outcome).toBe('incomplete');
    expect(r1.missingEvidence.length).toBeGreaterThan(0);   // 缺的正是合同要求的证据
    const after1 = await gs.readGoal(g.goalId);
    expect(after1!.status).not.toBe('completed');
    expect(after1!.continuation!.pendingReports!.map((p) => p.workId)).toContain(contract.workId);

    // ② 按协议补齐: 每条判据既要有证据 (kind=criterion:<判据>) 也有检查 (name=criterion:<判据>, pass)
    const good: AgentWorkReport = {
      ...base,
      status: 'completed',
      summary: '产出 /tmp/data.json, 逐条自检通过 (3 条记录)',
      evidence: contract.requiredEvidence.map((req) => ({ kind: req, ref: '/tmp/data.json#L1-L3', note: '来自真实产物' })),
      checks: contract.successCriteria.map((c) => ({
        name: `criterion:${c}`, verdict: 'pass' as const, detail: `读到 3 条记录 (${c})`,
      })),
      nextRecommendation: '交给父做汇总',
    };
    const r2 = await wiring.handleChildReport({ goalId: g.goalId, workId: contract.workId, report: good });
    expect(r2.accepted).toBe(true);
    expect(r2.outcome).toBe('accepted');
    const after2 = await gs.readGoal(g.goalId);
    expect(after2!.continuation!.pendingReports!.map((p) => p.workId)).not.toContain(contract.workId);
    expect(after2!.evidence.some((e) => e.includes(contract.workId))).toBe(true);
  });
});

describe('飞轮接线 ⑤b: 真实"派任务"路径 (SubAgentManager) 也走合同', () => {
  it('有 goalId 的派遣必签合同; 纯文本漂亮回报不算完成, 逐条证据的 JSON 报告才接受', async () => {
    const { gs, wiring } = await mods();
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const g = await gs.createGoal({ objective: '父目标: 收数据', successCriteria: ['有 3 条数据'] });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as any);
      const { task, workContract } = await mgr.delegateTask(
        'parent-agent', '收集 3 条数据', ['collect_data'], 'normal', undefined,
        { goalId: g.goalId, successCriteria: ['有 3 条数据'], allowedTools: ['read_file'] },
      );
      expect(workContract).toBeTruthy();
      expect(task.workId).toBe(workContract!.workId);
      expect(task.goalId).toBe(g.goalId);
      expect(await exists(wiring.contractPathFor(g.goalId, task.workId!))).toBe(true);

      // ① 子回一段漂亮话 → 不接受为完成 (任务留在 in_progress, 父仍在等)
      await mgr.updateTaskStatus(task.id, 'completed', '全部做完了, 一切顺利, 可以直接合并');
      const t2 = await mgr.getTask(task.id);
      expect(t2!.status).not.toBe('completed');
      expect(String(t2!.error)).toContain('不接受为完成');
      const goal2 = await gs.readGoal(g.goalId);
      expect(goal2!.continuation!.pendingReports!.map((p) => p.workId)).toContain(task.workId);
      expect(goal2!.status).not.toBe('completed');

      // ② 结构化 JSON 报告 (逐条证据 + 逐条检查) → 接受
      const report = {
        workId: task.workId,
        childAgentId: workContract!.childAgentId,
        status: 'completed',
        summary: '产出 /tmp/data.json (3 条记录)',
        evidence: workContract!.requiredEvidence.map((r) => ({ kind: r, ref: '/tmp/data.json', note: '真实产物' })),
        artifacts: [{ name: 'data.json', path: '/tmp/data.json', hash: null, cid: null, bytes: 64 }],
        checks: workContract!.successCriteria.map((c) => ({ name: `criterion:${c}`, verdict: 'pass', detail: '读到 3 条记录' })),
        unresolvedItems: [],
        blockReason: null,
        nextRecommendation: '交给父汇总',
        durationMs: 1000,
        reportedAt: new Date().toISOString(),
      };
      await mgr.updateTaskStatus(task.id, 'completed', JSON.stringify(report));
      const t3 = await mgr.getTask(task.id);
      expect(t3!.status).toBe('completed');
      const goal3 = await gs.readGoal(g.goalId);
      expect(goal3!.continuation!.pendingReports!.map((p) => p.workId)).not.toContain(task.workId);
    } finally {
      await mgr.destroy();
    }
  });
});

describe('飞轮接线 ⑥: 阻塞监控 (看任务是否卡住, 不是看进程是否活着)', () => {
  it('心跳缺失 → detectBlocks 发现, planBlockHandling 给出处置, 界面态 = 子 Agent 被阻塞', async () => {
    const { gs, wiring, monitor } = await mods();
    const g = await gs.createGoal({ objective: '父目标: 等子 Agent', successCriteria: ['子回报'] });
    const issuedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const contract = await wiring.dispatchChildWork({
      goalId: g.goalId,
      parentRunId: 'run-parent-2',
      childAgentId: 'child-node-2',
      capability: 'slow_cap',
      objective: '慢活',
      budget: { maxSteps: 3, maxDurationMs: 60_000, maxAmount: null, currency: null },
      successCriteria: ['有结论'],
      now: issuedAt,
      issuedBy: 'test',
    });
    // 心跳在 9 分钟前 (合同心跳间隔 30s → 早该跳了)
    await wiring.recordWorkHeartbeat(g.goalId, contract.workId, new Date(Date.now() - 9 * 60_000).toISOString());

    const blocks = await wiring.collectWorkBlocks({ goalId: g.goalId, now: new Date().toISOString(), runnerAvailable: true });
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.kind === 'no_heartbeat' || b.kind === 'no_progress' || b.kind === 'report_missing')).toBe(true);

    // 处置**之前**: 界面说"子 Agent 被阻塞"
    expect(await wiring.goalVisibleState({ goalId: g.goalId, blocks })).toBe('child_blocked');

    const handling = await wiring.applyBlockHandling({ goalId: g.goalId, blocks, now: new Date().toISOString() });
    expect(handling.actions.length).toBeGreaterThan(0);
    expect(handling.actions.map((a) => a.workId)).toContain(contract.workId);
    // 处置**之后**: 升级到人 → 界面态随事实变成"需要你决定" (优先级见 toUserVisibleState)
    expect(await wiring.goalVisibleState({ goalId: g.goalId, blocks })).toBe('needs_your_decision');
    expect(monitor.USER_VISIBLE_STATE_FOR_BLOCK_KIND.no_heartbeat).toBe('child_blocked');
  });

  it('supervisor tick 会做阻塞巡检 (报告里出现 blocks), 而不只看进程存活', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const g = await gs.createGoal({ objective: '巡检目标', successCriteria: ['有结论'] });
    const contract = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-x', childAgentId: 'child-x', capability: 'slow_cap',
      objective: '慢活', budget: { maxSteps: 3, maxDurationMs: 60_000, maxAmount: null, currency: null },
      successCriteria: ['有结论'], now: new Date(Date.now() - 30 * 60_000).toISOString(), issuedBy: 'test',
    });
    await gs.setContinuation(g.goalId, { autoContinue: false, wakeReason: 'needs_human', state: 'needs_human' });
    const s = new sup.ExecutionSupervisor({ runner: makeRunner(rs, gs, {}), maxPerTick: 5, maxRetries: 2 });
    const rep = await s.tickOnce();
    expect(rep.blocks.length).toBeGreaterThan(0);
    expect(rep.blocks.map((b) => b.workId)).toContain(contract.workId);
  });
});

describe('飞轮接线 ⑦: 新要求注入 (只影响后续 Run, 不改写已发生的历史)', () => {
  it('注入原话 → 下一 Run 的指令真的读到; 已发生 Run 的记录一字不改', async () => {
    const { gs, rs, sup, wiring } = await mods();
    let t = Date.now();
    const seen: string[] = [];
    const g = await gs.createGoal({ objective: '先跑一轮, 再改要求', successCriteria: ['判据永远不满足'] });
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['第一轮推进'], capture: (r) => seen.push(r.instruction) }),
      maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    await s.tickOnce();
    const run1Id = (await gs.readGoal(g.goalId))!.runs[0];
    const run1Before = JSON.stringify(await rs.readRun(run1Id));

    // 用户注入新要求 (原话逐字)
    const text = '另外必须支持离线模式, 不许依赖网络';
    const out = await wiring.ingestGoalChange({ goalId: g.goalId, instruction: text, source: 'user', recordedBy: 'test' });
    expect(out).not.toBeNull();
    expect(out!.request.instruction).toBe(text);                  // 逐字入档
    expect(out!.application.outcome).not.toBe('rejected');
    expect(await exists(out!.persistedPath)).toBe(true);
    const persisted = JSON.parse(await fs.readFile(out!.persistedPath, 'utf8'));
    expect(persisted.changes[0].instruction).toBe(text);

    // 下一 Run 真的读到
    const directive = await wiring.nextRunChangeDirective(g.goalId);
    expect(directive).toContain(text);
    t += 60_000;
    await s.tickOnce();
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain(text);
    expect(seen[1]).toContain('只影响后续 Run');       // 明确告诉执行器: 不许改写历史

    // 已发生的 Run 记录不被改写
    const run1After = JSON.stringify(await rs.readRun(run1Id));
    expect(run1After).toBe(run1Before);

    // 版本下发可核验: 被第 2 个 Run 读到过
    const goalAfter = await gs.readGoal(g.goalId);
    const chg: any = (goalAfter!.goalChanges ?? [])[0];
    expect(chg.instruction).toBe(text);
    expect(['scheduled_next_run', 'applied']).toContain(chg.status);
  });
});

describe('飞轮接线 ⑧: 用户可见态六类 (第 6 类终态 = 已结束)', () => {
  it('终态映射到 ended (不再冒充 executing / needs_your_decision), 且六类都在标签表里', async () => {
    const { monitor, fly } = await mods();
    expect(fly.USER_VISIBLE_STATES.length).toBe(6);
    expect(fly.USER_VISIBLE_STATES).toContain('ended');
    const mk = (state: any) => ({
      nextAction: 'x', wakeAt: null, wakeReason: 'active', autoContinue: false,
      requiredAgent: null, pendingReports: [], unresolvedItems: [], lastDecisionId: null,
      state, updatedAt: new Date().toISOString(),
    });
    for (const state of ['completed', 'failed'] as const) {
      const v = monitor.toUserVisibleState(mk(state) as any, [], null);
      expect(v).toBe('ended');
      expect(fly.USER_VISIBLE_STATE_LABELS[v].zh).toBe('已结束');
    }
    // 内部状态词绝不出现在用户可见态里
    for (const s of fly.USER_VISIBLE_STATES) {
      expect(['retry_wait', 'stalled', 'recovering', 'open', 'awaiting_external']).not.toContain(s);
    }
  });
});
