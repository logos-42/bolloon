/**
 * goal-flywheel P5 · 统一长周期验收 (2026-09-25)
 *
 * 归属: `docs/wiki/goal-continuation-flywheel.md` §10 (P5 用例清单) + §11 (不做清单)。
 * 角色: **验证者**的测试 —— 每条用例都真跑 (真 Goal/Run Store + 真 ExecutionSupervisor +
 * 真 closeGoalRun + 真落盘), 不 stub 被验对象。所有 HOME 隔离在临时目录。
 *
 * 覆盖 (逐个可单独重跑; `-t` 过滤即可):
 *   ① 不设最大轮次, 按证据进展自结束 (同时把轮次上限调大/调小 → 结论必须不变)
 *   ② 无进展自动熔断 (熔断后不再空转; reason 指向"无进展", 不是"第 N 轮")
 *   ③ 子 Agent 阻塞三情形 (心跳停 / 无进展 / 报告缺失) 被抓到 + 处置;
 *      执行权不在自己手上时**不得**误接管
 *   ④ 用户中途注入新要求 → 下一 Run 真读到; 当前 Run 历史逐字节不变; 放宽类不自动生效
 *   ⑤ Run 结束自动写 Memory + Skill 候选 (成功 / 失败 / 中断恢复三条路径都走);
 *      候选带齐必填字段; **不覆盖正在执行的 Skill snapshot**
 *   ⑥ 汇报后按 wakeAt / 事件自动继续 (未到点不跑; 外部事件型不空转)
 *   ⑦ 强负例: 子 Agent 回报漂亮但无证据 → 父 Goal 不完成 (两条独立路径)
 *   ⑧ 强负例: 只有一次偶然成功的 Skill 候选不得转正
 *   ★ 额外必查: 真实运行里到底哪条路径会走到"合同签发 / 回报核验"(还是空转)
 *
 * ★ 2026-09-25 (P5 收口线): 原先钉住缺口的用例 (缺口 1 / 2 / 3 / 5 + 原话条款) 已**翻成断言修复后行为**
 *   (缺口 1/2/3/5 的生产代码在同一轮修掉, 见 docs/wiki/goal-flywheel-p5-acceptance.md §2A):
 *   · ① 飞轮要 delegate → 技能门禁不适用: 照跑 + **真签发合同** + 父 Goal 记下"等回报";
 *   · ② 普通目标 (飞轮没说 delegate) 仍然没有合同来源 → 巡检无输入 (对照 ①, 不是"永远为空");
 *   · ③ CLI `--delegate` 传 `goalId` ⇒ 合同门生效: 无证据的漂亮报告被拒;
 *   · ⑤ 收尾候选带 `contentHash` ⇒ 真落 `skill-candidates/`;
 *   · ④ 原话逐字进 `nextRunDirective` 与 `continuation.nextAction` (界面看得见);
 *   · ⑥ 手动 /wake 真把 `awaiting_external` 拉回 `active`; 长等待 (>30min) 的判龄用本段 Run 时长。
 *   每处都做了变异验证 (把修复改坏 → 对应用例必红, 见 §2A 表格)。
 *
 * 阴性对照 (怎么知道这些门不是空转):
 *   - 把 ① 的 `advanceCriteria: false` 打开 (不产证据) → 同一份用例立刻停 (② 就是它的红态);
 *   - 把 ③ 的 lease 拿掉 → `applyBlockHandling` 才可能给 takeover (本文件同时钉住"执行权被占 → 不接管");
 *   - 把 ⑦ 报告里的 `evidence` 补满且逐条 pass → `accepted` 翻成 true (同文件里有正控);
 *   - 把 ⑧ 的 `occurrences` 从 1 改成 2 且补齐 schema → `assessCandidate` 才可能 promotable;
 *   - ★ ⑥ 的"长等待"用例自带阴性对照: 真的**还在跑**的 Run 超时 → 照样交人 (硬底线没被拆);
 *   - ★ ④ 的"待批准"分支自带阴性对照: `pending_approval` 的变更**不带**原话条款
 *     (否则未批要求会被当成已生效指令执行);
 *   - ★ ① 的"普通目标"分支 (用例 ②) 与 ⑤ 的"垃圾候选"分支 (用例 ⑧) 分别是它们各自的红态对照。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { AgentWorkContract, AgentWorkReport, SkillImprovementCandidate } from '../agents/goal-flywheel/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 隔离 HOME + 环境变量
// ─────────────────────────────────────────────────────────────────────────────

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const ENV_KEYS = [
  'BOLLOON_RUN_FINAL_REVIEW',
  'BOLLOON_GOAL_NO_PROGRESS_BREAKER',
  'BOLLOON_GOAL_MAX_RUNS',
  'BOLLOON_GOAL_MAX_RUN_MS',
  'BOLLOON_RUN_PERSIST',
];
let OLD_ENV: Record<string, string | undefined> = {};

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `p5-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  OLD_ENV = {};
  for (const k of ENV_KEYS) {
    OLD_ENV[k] = process.env[k];
    if (k !== 'BOLLOON_RUN_PERSIST') delete process.env[k];
  }
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
    contract: await import('../agents/goal-flywheel/work-contract.js'),
    candidate: await import('../agents/goal-flywheel/skill-candidate.js'),
    fly: await import('../agents/goal-flywheel/index.js'),
  };
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function listDir(p: string): Promise<string[]> {
  try { return await fs.readdir(p); } catch { return []; }
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

/** 每个用例一个独立子 HOME (同一条用例里要跑多个变体时用) */
async function useHome(name: string): Promise<string> {
  const h = path.join(TMP, name);
  await fs.mkdir(h, { recursive: true });
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  return h;
}

interface RunOpts {
  /** 这一次 Run 的结束状态 */
  status?: 'done' | 'failed' | 'awaiting_external';
  okSteps?: string[];
  failError?: string;
  failWithoutStep?: boolean;
  /** 真进展: 满足"下一个未满足的判据" + 写一条 Run 级证据 */
  advanceCriteria?: boolean;
  evidence?: string[];
  capture?: (req: any) => void;
  onRun?: (run: any) => Promise<void>;
}

/**
 * 真执行器: **自己落 Run 事实** (startRun / recordStep / finishRun / attachRun),
 * 需要进展时用真 API `markCriterion` 满足判据 —— 不手改文件, 不伪造 Run 记录。
 */
function makeRunner(rs: any, gs: any, opts: RunOpts = {}) {
  const status = opts.status ?? 'done';
  return (async (req: any) => {
    opts.capture?.(req);
    if (req.kind === 'resume' && req.prevRunId) {
      await rs.prepareResume(req.prevRunId).catch(() => null);
      await rs.finishRun(req.prevRunId, { status: 'done' });
      return { runId: req.prevRunId, status: 'done' };
    }
    const rec = await rs.startRun({
      surface: 'cli', channelId: 'ch-p5', goalId: req.goal.goalId, goal: req.goal.objective,
    });
    for (const s of opts.okSteps ?? []) {
      await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: s });
    }
    if (opts.advanceCriteria) {
      const g = await gs.readGoal(req.goal.goalId);
      const next = (g?.successCriteria ?? []).findIndex((_: string, i: number) => !g!.completedCriteria.includes(i));
      if (next >= 0) {
        await gs.markCriterion(req.goal.goalId, next, true, `evidence-${next}.txt: 判据 ${next} 的可核验产物 (run ${rec.runId})`);
        await rs.addRunEvidence(rec.runId, [`evidence-${next}.txt: 判据 ${next} 的可核验产物`]);
      }
    }
    if (opts.evidence) await rs.addRunEvidence(rec.runId, opts.evidence);
    await opts.onRun?.(rec);
    if (status === 'failed') {
      const err = opts.failError ?? '网络抖动 (ECONNRESET)';
      if (!opts.failWithoutStep) await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: err });
      await rs.finishRun(rec.runId, { status: 'failed', error: err });
    } else if (status === 'awaiting_external') {
      await rs.finishRun(rec.runId, { status: 'awaiting_external', error: '等对端回执' });
    } else {
      await rs.finishRun(rec.runId, { status: 'done' });
    }
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status: status === 'awaiting_external' ? 'done' : status };
  }) as any;
}

const SKILL_REVIEW = (name: string, occurrences = 2) => JSON.stringify({
  reviewedBy: 'p5-verifier',
  verdict: 'reusable',
  methodEffective: '先解析判据再执行',
  methodFailed: '一开始直接开跑',
  nextTimeChange: '先写证据清单',
  facts: [{ claim: '判据 0 已满足', assertion: 'confirmed', refs: ['evidence-0.txt'] }],
  skills: [{
    name,
    purpose: '把判据逐条映射到可核验证据的固定流程',
    occurrences,
    boundaryClear: true,
    inputSchema: '{ criteria: string[] }',
    outputSchema: '{ evidenceRefs: string[] }',
    guarantees: ['每条判据都有证据引用'],
    doesNotGuarantee: ['不保证证据本身真实'],
    failureCases: ['判据不可核验时应当停下'],
    evidenceRefs: ['evidence-0.txt'],
  }],
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-① 不设最大轮次: 按证据进展自结束 (轮次上限调大/调小结论不变)', () => {
  it('真进展 → 靠证据走完 3 个 Run 并自己结束; 轮次上限 0/1/5 三种取值结论完全一致', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const observed: any[] = [];

    for (const roundLimit of [0, 1, 5]) {
      const home = await useHome(`rounds-${roundLimit}`);
      delete process.env.BOLLOON_GOAL_NO_PROGRESS_BREAKER;
      const g = await gs.createGoal({
        objective: '把 A 变成 B (每轮产出一条证据, 直到判据全满足)',
        successCriteria: ['判据0: 有 A→B 的路径证据', '判据1: 有回执', '判据2: 复验通过'],
        createdBy: 'p5',
      });
      let t = Date.now();
      const s = new sup.ExecutionSupervisor({
        runner: makeRunner(rs, gs, { advanceCriteria: true, okSteps: ['推进了一步 (产物路径已记)'] }),
        maxPerTick: 5, maxRetries: roundLimit, now: () => t,
      });
      let ticks = 0;
      while (ticks < 8) {
        await s.tickOnce();
        ticks++;
        t += 10 * 60_000;
        if ((await gs.readGoal(g.goalId))!.status === 'completed') break;
      }
      const after = await gs.readGoal(g.goalId);
      const records = await wiring.readDecisionRecords(g.goalId, home);
      const closures = records.filter((r) => r.phase === 'closure');
      observed.push({
        roundLimit, ticks, runs: after!.runs.length, status: after!.status,
        closureDecisions: closures.map((r) => r.decision.decision),
        continueReasons: closures.filter((r) => r.decision.decision === 'continue').map((r) => r.decision.reason),
        completeReason: closures.find((r) => r.decision.decision === 'complete')?.decision.reason ?? '',
      });
    }

    // 三种轮次上限 → 同一个结论: 3 个 Run 靠进展走完, 自己判完成
    for (const o of observed) {
      expect(o.status).toBe('completed');
      expect(o.runs).toBe(3);
      expect(o.closureDecisions).toEqual(['continue', 'continue', 'complete']);
    }
    // 继续的依据是"新的可核验证据", 不是"第几轮"
    for (const r of observed[2].continueReasons) expect(r).toMatch(/可核验进展|新增证据/);
    expect(observed[2].completeReason).toMatch(/完成门通过|全满足/);
    // 三条 run 全部由进展驱动: 没有一条是因为轮次上限被跳过
    expect(observed.map((o) => o.runs)).toEqual([3, 3, 3]);
  });

  it('反证: 同一份目标, 执行器**不产证据**时任何轮次上限都救不回来 (结论随证据变, 不随轮次变)', async () => {
    const { gs, rs, sup } = await mods();
    const observed: any[] = [];
    // 轮次上限给到 50 也不会"靠轮次撞到结束"; 上限 = 1 时更是早早判停
    for (const roundLimit of [1, 50]) {
      await useHome(`rounds-noprogress-${roundLimit}`);
      process.env.BOLLOON_GOAL_MAX_RUNS = String(roundLimit);
      delete process.env.BOLLOON_GOAL_NO_PROGRESS_BREAKER;
      let t = Date.now();
      const g = await gs.createGoal({
        objective: '没有证据的目标', successCriteria: ['判据0', '判据1', '判据2'], createdBy: 'p5',
      });
      const s = new sup.ExecutionSupervisor({
        runner: makeRunner(rs, gs, { status: 'failed' }),   // 无 ok 步骤 = 无证据
        maxPerTick: 5, maxRetries: roundLimit, now: () => t,
      });
      for (let i = 0; i < 10; i++) { await s.tickOnce(); t += 30 * 60_000; }
      const after = await gs.readGoal(g.goalId);
      observed.push({ roundLimit, status: after!.status, runs: after!.runs.length, completed: after!.completedCriteria.length });
    }
    for (const o of observed) {
      expect(o.status).not.toBe('completed');       // 轮次上限再大也不顶用
      expect(o.completed).toBe(0);                  // 一条判据都不会自己变成满足
      expect(o.runs).toBeLessThanOrEqual(10);       // 也不会无限开 Run
    }
    // 对照上一条用例: 有证据 → 三种轮次上限都在 3 个 Run 内结束; 没证据 → 上限 50 也完不成。
    // 结论只随"有没有新证据"变 —— 这才是进展驱动。
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-② 无进展自动熔断 (不无限循环; reason 指向无进展而非第 N 轮)', () => {
  it('真的没有新证据 → 熔断到 needs_human; 再 tick 也不动', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const home = await useHome('breaker');
    let t = Date.now();
    const g = await gs.createGoal({ objective: '造一个永远没有新证据的目标', successCriteria: ['永远不满足'], createdBy: 'p5' });
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { status: 'failed' }),   // 失败且无 ok 步骤 → 零证据
      maxPerTick: 5, maxRetries: 2, now: () => t,         // 熔断阈值 = maxRetries + 1 = 3
    });
    let ticks = 0;
    while (ticks < 6) {
      await s.tickOnce();
      ticks++;
      t += 10 * 60_000;
      if ((await gs.readGoal(g.goalId))!.status === 'needs_human') break;
    }
    const stopped = await gs.readGoal(g.goalId);
    expect(stopped!.status).toBe('needs_human');
    expect(stopped!.continuation!.autoContinue).toBe(false);
    expect(stopped!.continuation!.state).toBe('needs_human');

    // 决策依据: 无进展/熔断 (不是"第 N 轮")
    const records = await wiring.readDecisionRecords(g.goalId, home);
    const stoppedDecision = records.filter((r) => r.decision && r.decision.state === 'no_progress').pop();
    expect(stoppedDecision).toBeTruthy();
    expect(stoppedDecision!.decision.reason).toMatch(/熔断/);
    expect(stoppedDecision!.decision.reason).toMatch(/无进展/);
    expect(stoppedDecision!.decision.reason).toMatch(/第几轮/);          // 明说"轮次不是依据"
    expect(stoppedDecision!.noProgressStreak).toBeGreaterThanOrEqual(2);

    // 不无限循环: 熔断后再 tick 三次, 一个 Run 都不再开
    const runsAtStop = stopped!.runs.length;
    let executedAfter = 0;
    for (let i = 0; i < 3; i++) {
      t += 60 * 60_000;
      const rep = await s.tickOnce();
      executedAfter += rep.executed.length;
    }
    const after = await gs.readGoal(g.goalId);
    expect(after!.runs.length).toBe(runsAtStop);
    expect(executedAfter).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-③ 子 Agent 阻塞: 被发现 / 给出处置 / 不越权接管', () => {
  const budget = (maxDurationMs: number | null) => ({ maxSteps: 5, maxDurationMs, maxAmount: null, currency: null });

  it('心跳停 + 执行权**不在自己手上** → 上报父/人, 绝不误接管', async () => {
    const { gs, wiring, monitor } = await mods();
    const home = await useHome('block-hb-lease');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '等一个慢子 Agent', successCriteria: ['子回报'], createdBy: 'p5' });
    const c = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-parent-1', childAgentId: 'child-1', capability: 'slow_cap',
      objective: '慢活', budget: budget(600_000), successCriteria: ['有结论'], now: iso(t0), issuedBy: 'p5',
    });
    // 执行权被别的 worker 持有 (未过期)
    const claimed = await gs.claimGoal(g.goalId, { owner: 'other-worker', ttlMs: 3_600_000, now: t0 });
    expect(claimed.ok).toBe(true);
    // 心跳从没来过 (issuedAt 起算) → 早已超时
    const now = iso(t0 + 10 * 60_000);
    const blocks = await wiring.collectWorkBlocks({ goalId: g.goalId, now, runnerAvailable: true, home });
    const hb = blocks.find((b) => b.kind === 'no_heartbeat');
    expect(hb).toBeTruthy();
    expect(String(hb!.dependency)).toMatch(/执行权/);
    expect(monitor.planBlockHandling(hb!)).not.toBe('takeover');
    expect(monitor.planBlockHandling(hb!)).toBe('escalate_parent');
    // 处置: 升级给人 (Goal → needs_human), 且不产生任何"接管"记录
    const handling = await wiring.applyBlockHandling({ goalId: g.goalId, blocks, now, home });
    expect(handling.takeovers).toEqual([]);
    expect(handling.actions.map((a) => a.action)).toContain('escalate_parent');
    // 只有 needs_human 级动作才进 escalated 清单; "上报父"是 escalate_parent 那一档
    expect(handling.escalated).toEqual([]);
    const after = await gs.readGoal(g.goalId);
    expect(after!.status).toBe('needs_human');
    expect(after!.continuation!.autoContinue).toBe(false);
    expect(after!.continuation!.unresolvedItems!.join(' ')).toMatch(/no_heartbeat/);
  });

  it('心跳停 + 执行权空闲 → 真合同(策略=stall)仍只上报; 接管分支要用策略=takeover 的合同才走到 (如实标出可达性)', async () => {
    const { gs, wiring, monitor, contract } = await mods();
    const home = await useHome('block-hb-free');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '等一个没心跳的子 Agent', successCriteria: ['子回报'], createdBy: 'p5' });
    const c = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-parent-2', childAgentId: 'child-2', capability: 'slow_cap',
      objective: '慢活', budget: budget(600_000), successCriteria: ['有结论'], now: iso(t0), issuedBy: 'p5',
    });
    // 真合同: 失败策略由 issueWorkContract 固定 (onHeartbeatMiss='stall')
    expect(c.failurePolicy.onHeartbeatMiss).toBe('stall');
    const now = iso(t0 + 10 * 60_000);
    const blocks = await wiring.collectWorkBlocks({ goalId: g.goalId, now, runnerAvailable: true, home });
    const hb = blocks.find((b) => b.kind === 'no_heartbeat')!;
    expect(hb).toBeTruthy();
    expect(monitor.planBlockHandling(hb)).toBe('escalate_parent');   // 空闲也不接管 (策略不是 takeover)

    // 逻辑本身没坏: 把合同的策略设成 takeover (真实签发路径产不出这种合同) → 才会给 takeover
    const takeoverContract: AgentWorkContract = { ...c, failurePolicy: { ...c.failurePolicy, onHeartbeatMiss: 'takeover' } };
    const b2 = monitor.detectBlocks({
      contract: takeoverContract, report: null, lastHeartbeatAt: null,
      lastProgressAt: iso(t0), now, leaseOwner: null, runnerAvailable: true,
    });
    const hb2 = b2.find((b) => b.kind === 'no_heartbeat')!;
    expect(hb2.suggestedAction).toBe('takeover');
    expect(monitor.planBlockHandling(hb2)).toBe('takeover');
  });

  it('子还活着但无进展 → 先发一次调整指令; 窗口两倍后才是停/换人', async () => {
    const { gs, wiring, monitor } = await mods();
    const home = await useHome('block-noprog');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '盯着一个不动的子 Agent', successCriteria: ['子回报'], createdBy: 'p5' });
    // heartbeatIntervalMs = min(30s, maxDurationMs/6, ...) → maxDurationMs=1_800_000 → 30s → 无进展窗口 = 180s
    const w1 = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-p', childAgentId: 'child-slow', capability: 'slow_cap',
      objective: '慢活 (第一档)', budget: budget(1_800_000), successCriteria: ['有结论'], now: iso(t0), issuedBy: 'p5',
    });
    expect(w1.heartbeatIntervalMs).toBe(30_000);
    await wiring.recordWorkHeartbeat(g.goalId, w1.workId, iso(t0 + 199_000), home);   // 心跳还在 (199s 前), 但没进展

    const b1 = await wiring.collectWorkBlocks({ goalId: g.goalId, now: iso(t0 + 200_000), runnerAvailable: true, home });
    const np1 = b1.find((b) => b.kind === 'no_progress');
    expect(np1).toBeTruthy();
    expect(monitor.planBlockHandling(np1!)).toBe('send_adjustment');   // 第一档: 先给一次调整指令

    // 同一个工作, 时间推到窗口两倍以上 → 第二档: 停或换人
    const b2 = await wiring.collectWorkBlocks({ goalId: g.goalId, now: iso(t0 + 400_000), runnerAvailable: true, home });
    const np2 = b2.find((b) => b.kind === 'no_progress');
    expect(np2).toBeTruthy();
    expect(monitor.planBlockHandling(np2!)).toBe('replace_child');

    // 处置动作落地的范围 (如实钉住): 第二档"换人"只被记进 requests,
    // **没有**真的换人/重派, Goal 状态也不动 —— 换人得由父 Agent 或人去做。
    const before = await gs.readGoal(g.goalId);
    // 只喂 no_progress 这一块 (同一个时刻还会命中"心跳停": 心跳 199s 前, 窗口 60s) —— 隔离看处置动作本身
    const npBlocks = b2.filter((b) => b.kind === 'no_progress');
    const workDir = path.dirname(wiring.contractPathFor(g.goalId, w1.workId, home));
    const filesBefore = (await listDir(workDir)).sort();
    const h2 = await wiring.applyBlockHandling({ goalId: g.goalId, blocks: npBlocks, now: iso(t0 + 400_000), home });
    expect(h2.actions.map((a) => a.action)).toContain('replace_child');
    expect(h2.escalated).toEqual([]);
    expect(h2.takeovers).toEqual([]);
    expect(h2.requests.some((r) => /replace_child/.test(r))).toBe(true);
    const after2 = await gs.readGoal(g.goalId);
    expect(after2!.status).toBe(before!.status);                 // 换人档不改 Goal 状态
    expect(after2!.continuation!.pendingReports!.length).toBe(before!.continuation!.pendingReports!.length);
    expect(await exists(wiring.contractPathFor(g.goalId, w1.workId, home))).toBe(true);
    expect((await listDir(workDir)).sort()).toEqual(filesBefore);   // 没派新合同 / 没有新文件
  });

  it('报告缺失 (到期没回 / 回来了但不完整) → 不接受为完成, 要求补齐; 超宽限转人工', async () => {
    const { gs, wiring, monitor } = await mods();
    const home = await useHome('block-report');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '等一份报告', successCriteria: ['有报告'], createdBy: 'p5' });
    // 预算/期限都离得远 → 心跳间隔 = 默认 30s (窗口/宽限由合同自己算, 测试读合同, 不硬编)
    const c = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-r', childAgentId: 'child-r', capability: 'report_cap',
      objective: '交报告', budget: budget(1_800_000), deadline: iso(t0 + 600_000),
      successCriteria: ['报告里有 3 条记录'], now: iso(t0), issuedBy: 'p5',
    });
    expect(c.heartbeatIntervalMs).toBe(30_000);
    const graceMs = monitor.reportGraceMs(c);
    const deadlineMs = Date.parse(String(c.deadline));
    expect(graceMs).toBe(60_000);

    // ① 到期没回, 还在宽限内 → 只"要求补齐"
    const withinGrace = await wiring.collectWorkBlocks({ goalId: g.goalId, now: iso(deadlineMs + Math.floor(graceMs / 2)), runnerAvailable: true, home });
    const rm1 = withinGrace.find((b) => b.kind === 'report_missing');
    expect(rm1).toBeTruthy();
    expect(monitor.planBlockHandling(rm1!)).toBe('request_report');

    // ② 超宽限 → 转人工
    const now2 = iso(deadlineMs + graceMs * 3);
    const bLate = await wiring.collectWorkBlocks({ goalId: g.goalId, now: now2, runnerAvailable: true, home });
    const rm2 = bLate.find((b) => b.kind === 'report_missing');
    expect(rm2).toBeTruthy();
    expect(monitor.planBlockHandling(rm2!)).toBe('needs_human');
    const handling = await wiring.applyBlockHandling({ goalId: g.goalId, blocks: bLate, now: now2, home });
    expect(handling.escalated.length).toBeGreaterThan(0);
    expect((await gs.readGoal(g.goalId))!.status).toBe('needs_human');

    // ③ 报告回来了但**不完整** (自称完成却没有逐条证据) → 仍然 report_missing, 不接受为完成
    const bad: AgentWorkReport = {
      workId: c.workId, childAgentId: c.childAgentId, status: 'completed',
      summary: '一切顺利, 报告已交', evidence: [], artifacts: [],
      checks: [{ name: '自检', verdict: 'pass', detail: '看着没问题' }],
      unresolvedItems: [], blockReason: null, nextRecommendation: '直接合并', durationMs: 1000, reportedAt: now2,
    };
    await fs.mkdir(path.dirname(wiring.reportPathFor(g.goalId, c.workId, home)), { recursive: true });
    await fs.writeFile(
      wiring.reportPathFor(g.goalId, c.workId, home),
      JSON.stringify({ report: bad, recordedAt: now2 }), 'utf8',
    );
    const b3 = await wiring.collectWorkBlocks({ goalId: g.goalId, now: now2, runnerAvailable: true, home });
    expect(b3.some((b) => b.kind === 'report_missing')).toBe(true);
    expect(b3.find((b) => b.kind === 'report_missing')!.note).toMatch(/不接受为完成|不完整/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-④ 用户中途注入新要求: 下一 Run 真采用, 当前 Run 历史逐字节不变', () => {
  it('原话逐字入档 → 下一个 Run 的指令真含原话; 已发生 Run 的记录一字不改; 放宽类不自动生效', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const home = await useHome('inject');
    let t = Date.now();
    const seen: string[] = [];
    const g = await gs.createGoal({ objective: '先跑一轮, 再改要求', successCriteria: ['判据永远不满足'], createdBy: 'p5' });
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['第一轮推进'], capture: (r) => seen.push(r.instruction) }),
      maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    await s.tickOnce();
    const run1Id = (await gs.readGoal(g.goalId))!.runs[0];
    const run1Bytes = JSON.stringify(await rs.readRun(run1Id));
    const goalBytesBefore = JSON.stringify(await gs.readGoal(g.goalId));

    // ① 用户注入新要求 (原话逐字)
    const text = '另外必须支持离线模式, 不许依赖网络';
    const out = await wiring.ingestGoalChange({ goalId: g.goalId, instruction: text, source: 'user', recordedBy: 'p5', home });
    expect(out).not.toBeNull();
    expect(out!.request.instruction).toBe(text);
    const persisted = JSON.parse(await fs.readFile(out!.persistedPath, 'utf8'));
    expect(persisted.changes[0].instruction).toBe(text);

    // ★ 修复后 (原缺口: 界面上看不见自己提的要求): 注入当场, "下一 Run 的指令"里**逐字**含用户原话 ——
    //   接口回话 (网页把它直接打给人看) 与落盘的 continuation.nextAction 都必须是它。
    expect(out!.application.nextRunDirective).toContain(text);
    expect(out!.nextRunDirective).toContain(text);
    expect(String((await gs.readGoal(g.goalId))!.continuation!.nextAction ?? '')).toContain(text);
    expect(out!.application.nextRunDirective).toMatch(/只影响后续 Run/);   // 老条款没被挤掉
    expect(out!.application.nextRunDirective).toMatch(/原话/);

    // ② 下一个 Run 真的读到 (原话出现在指令里)
    t += 10 * 60_000;
    await s.tickOnce();
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain(text);
    expect(seen[1]).toMatch(/只影响后续 Run/);

    // 说明 (如实): 跑完这一轮后 `continuation.nextAction` 会被飞轮收尾的"下一步"覆盖 —— 这是
    // 运输层的正常行为 (终态仍由飞轮写)。原话**不靠** nextAction 存活: 它另有两条通道
    // (变更档案 + nextRunChangeDirective → 下一 Run 的指令), 见上一条与下一条断言。

    // ③ 当前 Run 历史逐字节不变
    expect(JSON.stringify(await rs.readRun(run1Id))).toBe(run1Bytes);
    expect(await fs.readFile(out!.persistedPath, 'utf8')).toContain(text);

    // ④ 放宽类 (扩预算) 由 **agent** 提出 → 必须走人工确认, 不自动生效
    const budgetBefore = JSON.stringify((await gs.readGoal(g.goalId))!.budget);
    const wide = await wiring.ingestGoalChange({
      goalId: g.goalId, instruction: '把预算上限提高到 999 个 Run', source: 'agent', recordedBy: 'agent', home,
    });
    expect(wide!.application.outcome).toBe('pending_approval');
    expect(wide!.request.status).toMatch(/triaged|received/);      // 真实值 = triaged (待批)
    expect(wide!.application.requiresReplan).toBe(true);           // 批准后必须重规划
    expect(wide!.application.reason).toMatch(/需人批准|待批准/);
    expect(wide!.application.criteriaVersion).toBe(1);             // 判据版本不动
    // 待批准时, 那条"下一 Run 指令"其实是一段**拒绝说明** —— 不含任何生效条款
    expect(String(wide!.application.nextRunDirective)).toMatch(/批准前不动任何东西|不排入下一 Run/);
    // ★ 阴性对照 (原话条款只发给"真排入下一 Run"的变更): 待批准的要求**不带**原话 ——
    //   否则执行器会把"还没批的要求"当成已生效的指令去执行。
    expect(String(wide!.application.nextRunDirective)).not.toContain('999');
    expect(String(wide!.application.nextRunDirective)).not.toMatch(/原话 \(逐字/);
    const afterWide = await gs.readGoal(g.goalId);
    expect(JSON.stringify(afterWide!.budget)).toBe(budgetBefore);  // 预算一个字节没动
    expect(afterWide!.criteriaVersion ?? 1).toBe(1);
    expect(afterWide!.continuation!.nextAction ?? '').not.toContain('999');
    expect((await wiring.nextRunChangeDirective(g.goalId)) ?? '').not.toContain('999');

    // ⑤ 用户明确撤销 → 目标不许继续跑 (abandoned + autoContinue=false)
    const abort = await wiring.ingestGoalChange({ goalId: g.goalId, instruction: '撤销这个目标, 不要继续做了', source: 'user', recordedBy: 'p5', home });
    expect(abort!.application.outcome).toBe('next_run');
    // 撤销类也带原话 (同样只影响后续 Run)
    expect(abort!.application.nextRunDirective).toContain('撤销这个目标, 不要继续做了');
    const abandoned = await gs.readGoal(g.goalId);
    expect(abandoned!.status).toBe('abandoned');
    expect(abandoned!.continuation!.autoContinue).toBe(false);
    // 撤销之后 tick 也不再开新 Run (已发生的 Run 数不变)
    const runsNow = abandoned!.runs.length;
    t += 60 * 60_000;
    const rep = await s.tickOnce();
    expect(rep.executed.length).toBe(0);
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(runsNow);
    // Goal 记录只增不改: 注入过程没改写历史 Run 记录
    expect(JSON.stringify(await rs.readRun(run1Id))).toBe(run1Bytes);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-⑤ Run 结束自动写 Memory + Skill 候选 (成功/失败/中断恢复三条路径)', () => {
  it('成功路径: 9 步流水线全走; Memory / 用户汇报 / 决策记录真落盘; 候选带齐必填字段', async () => {
    const { gs, rs, wiring, fly } = await mods();
    const home = await useHome('closure-ok');
    // 注意: `BOLLOON_RUN_FINAL_REVIEW` 这个 env 通道**只被 Supervisor 读**(execution-supervisor.ts:785),
    // 直调 closeGoalRun 必须显式传 finalReview —— 本用例两条都钉住。
    process.env.BOLLOON_RUN_FINAL_REVIEW = SKILL_REVIEW('p5-skill');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '收尾成功路径', successCriteria: ['判据0'], createdBy: 'p5' });
    const rec = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '产出了 evidence-0.txt' });
    await rs.recordStep(rec.runId, { tool: 'http_get', ok: false, error: '对端 504' });
    await rs.addRunEvidence(rec.runId, ['evidence-0.txt (sha256 前缀可核验)']);
    await rs.finishRun(rec.runId, { status: 'done' });
    await gs.attachRun(g.goalId, rec.runId);
    await gs.markCriterion(g.goalId, 0, true);

    const out = await wiring.closeGoalRun({ goalId: g.goalId, runId: rec.runId, now: iso(t0 + 60_000), maxRetries: 2, home, finalReview: SKILL_REVIEW('p5-skill') });
    expect(out).not.toBeNull();
    const r = out!.result;

    // ① 固定 9 步顺序
    expect(r.steps).toEqual([...fly.RUN_CLOSURE_STEPS]);
    expect(r.steps.length).toBe(9);
    // ② 四类产物: 事实 / 教训 / 候选 / 下一步
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.lessons.length).toBe(1);
    expect(r.candidates.length).toBe(1);
    expect(r.nextStep.length).toBeGreaterThan(0);
    // ③ Memory 真落盘 (run_fact / lesson / skill_signal 三个层都有文件)
    expect((await listDir(path.join(home, fly.MEMORY_LAYERS_ROOT, 'run_fact'))).length).toBeGreaterThan(0);
    expect((await listDir(path.join(home, fly.MEMORY_LAYERS_ROOT, 'lesson'))).length).toBe(1);
    expect((await listDir(path.join(home, fly.MEMORY_LAYERS_ROOT, 'skill_signal'))).length).toBe(1);
    // ④ 用户汇报 + 决策记录落盘, 且**不暴露**内部字段
    expect(await exists(out!.reportPath)).toBe(true);
    expect(await exists(out!.decisionRecordPath)).toBe(true);
    const report = JSON.parse(await fs.readFile(out!.reportPath, 'utf8'));
    expect(fly.USER_VISIBLE_STATES).toContain(report.visibleState);
    for (const f of fly.MUST_NOT_EXPOSE_FIELDS) expect(Object.keys(report)).not.toContain(f);
    // ⑤ Skill 候选必填字段齐全 (冻结契约)
    const cand = r.candidates[0];
    for (const f of ['sourceRunIds', 'evidenceRefs', 'failureCases', 'inputSchema', 'outputSchema', 'guarantees', 'doesNotGuarantee', 'contentHash', 'approval']) {
      expect(Object.prototype.hasOwnProperty.call(cand, f)).toBe(true);
    }
    expect(cand.sourceRunIds).toEqual([rec.runId]);
    expect(cand.evidenceRefs.length).toBeGreaterThan(0);
    expect(cand.approval.state).toBe('not_requested');
    // ⑥ 候选**没有**直接变成正式 Skill: 落盘只进 skill-candidates, 绝不进 skills/
    expect(await listDir(path.join(home, '.bolloon', 'skills'))).toEqual([]);
    expect(out!.candidatePaths.every((p) => p.includes('skill-candidates'))).toBe(true);
    // ⑦ 修复后行为 (原缺口 5): 收尾候选**带 contentHash** → 第二道门放行 → 真的落盘到 skill-candidates/
    expect(r.candidates[0].status).toBe('draft');
    expect(r.candidates[0].contentHash).toBeTruthy();
    // 哈希是**内容哈希**: 与接线层公开的同一套算法一致, 且不含 Run/candidateId 等"每次都变"的字段
    expect(r.candidates[0].contentHash).toBe(wiring.candidateContentHash(r.candidates[0]));
    const sameContentOtherRun: SkillImprovementCandidate = {
      ...r.candidates[0], candidateId: 'cand:other-run:0', sourceRunIds: ['run-别的'], proposedAt: iso(t0 + 999), proposedByRunId: 'run-别的',
    };
    expect(wiring.candidateContentHash({ ...sameContentOtherRun, contentHash: null })).toBe(r.candidates[0].contentHash);
    // 阴性对照: 内容真变了 → 哈希必须变 (不是个常量)
    expect(wiring.candidateContentHash({ ...r.candidates[0], purpose: `${r.candidates[0].purpose} (改一点)` })).not.toBe(r.candidates[0].contentHash);
    expect(out!.candidatePaths.length).toBe(1);
    expect(out!.candidatePaths.every((p) => p.includes('skill-candidates'))).toBe(true);
    expect(await exists(out!.candidatePaths[0])).toBe(true);
    expect(r.skipped.some((s) => /candidate_not_written/.test(s.reason))).toBe(false);
    const onDisk = JSON.parse(await fs.readFile(out!.candidatePaths[0], 'utf8'));
    expect(onDisk.contentHash).toBe(r.candidates[0].contentHash);
    expect(onDisk.appliesToRunningRun).toBe(false);
    expect(onDisk.snapshotScope).toBe('next_run_only');
  });

  it('失败路径与中断恢复路径同样过收尾 (不是只在成功时写 Memory)', async () => {
    const { gs, rs, wiring, fly } = await mods();
    const home = await useHome('closure-fail-interrupted');
    delete process.env.BOLLOON_RUN_FINAL_REVIEW;   // 散文评审也能收尾
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '收尾失败/中断路径', successCriteria: ['判据0'], createdBy: 'p5' });

    // ① 失败 Run
    const r1 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r1.runId, { tool: 'shell_exec', ok: true, summary: '做了一半' });
    await rs.recordStep(r1.runId, { tool: 'shell_exec', ok: false, error: '对端 504' });
    await rs.finishRun(r1.runId, { status: 'failed', error: '对端 504' });
    await gs.attachRun(g.goalId, r1.runId);
    const out1 = await wiring.closeGoalRun({ goalId: g.goalId, runId: r1.runId, now: iso(t0), finalReview: '这轮挂了, 下次先探活', maxRetries: 2, home });
    expect(out1!.result.steps.length).toBe(9);
    expect(out1!.written.length).toBeGreaterThan(0);
    expect(out1!.result.facts.some((f) => /失败/.test(f.content))).toBe(true);
    const runFactFiles1 = (await listDir(path.join(home, fly.MEMORY_LAYERS_ROOT, 'run_fact'))).length;
    expect(runFactFiles1).toBeGreaterThan(0);

    // ② 中断恢复 Run (真状态机: interrupted + 一条 recovery 记录)
    const r2 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r2.runId, { tool: 'shell_exec', ok: true, summary: '做到一半' });
    await rs.recordRecovery(r2.runId, { errorClass: 'crash', action: 'resume_from_checkpoint', recovered: true, reason: '进程被杀' } as any);
    await rs.finishRun(r2.runId, { status: 'interrupted', error: '进程 1234 已不在 (crash)' });
    await gs.attachRun(g.goalId, r2.runId);
    const out2 = await wiring.closeGoalRun({ goalId: g.goalId, runId: r2.runId, now: iso(t0 + 60_000), finalReview: '', maxRetries: 2, home });
    expect(out2!.result.steps.length).toBe(9);
    expect(out2!.result.steps[0]).toBe('run_ended');
    // 中断也是事实: 恢复记录进 Memory
    expect(out2!.result.facts.some((f) => /恢复尝试/.test(f.content))).toBe(true);
    expect((await listDir(path.join(home, fly.MEMORY_LAYERS_ROOT, 'run_fact'))).length).toBeGreaterThan(runFactFiles1);
    // 散文评审 → 明确记为"非结构化", 不假装产出了教训
    expect(out2!.result.lessons).toEqual([]);
    expect(out2!.result.skipped.some((s) => /final_review_unstructured/.test(s.reason))).toBe(true);
  });

  it('Skill 候选**不覆盖正在执行的 snapshot**: 运行中版本哈希可核验, skills/ 一个字节都不动', async () => {
    const { wiring, candidate } = await mods();
    const home = await useHome('closure-snapshot');
    const skillDir = path.join(home, '.bolloon', 'skills', 'p5-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const skillBody = '# p5-skill\n\n正在执行中的版本 (Run 还没结束)。\n';
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillBody, 'utf8');
    const before = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    const expectedHash = crypto.createHash('sha256').update(before).digest('hex').slice(0, 16);

    const cand: SkillImprovementCandidate = {
      candidateId: 'cand:p5-snapshot', name: 'p5-skill',
      purpose: '把判据逐条映射到可核验证据的固定流程',
      sourceRunIds: ['run-a'], evidenceRefs: ['evidence-0.txt'],
      failureCases: ['判据不可核验时应当停下'],
      inputSchema: '{ criteria: string[] }', outputSchema: '{ evidenceRefs: string[] }',
      guarantees: ['每条判据都有证据引用'], doesNotGuarantee: ['不保证证据本身真实'],
      contentHash: 'deadbeefdeadbeef', occurrences: 3, boundaryClear: true,
      approval: { state: 'not_requested', approvedBy: null, approvedAt: null, changeReason: null },
      status: 'draft', junkReasons: [], proposedAt: iso(Date.now()), proposedByRunId: 'run-a',
    };
    // 垃圾门先过一遍 (候选本身是干净的: 3 次出现 + 有边界 + 有 IO)
    expect(candidate.assessCandidate(cand, []).promotable).toBe(true);

    const file = await wiring.writeSkillCandidate(cand, { home, existing: [], now: iso(Date.now()) });
    expect(file).toBeTruthy();
    const payload = JSON.parse(await fs.readFile(file!, 'utf8'));
    expect(payload.snapshotScope).toBe('next_run_only');
    expect(payload.appliesToRunningRun).toBe(false);
    expect(payload.runningSnapshotHash).toBe(expectedHash);   // 运行中版本被如实记录
    // 正在执行的版本一个字节都没被改
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(before);
    expect((await listDir(skillDir)).sort()).toEqual(['SKILL.md']);
    expect((await listDir(path.join(home, '.bolloon', 'skill-candidates'))).length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-⑥ 汇报后按 wakeAt / 事件自动继续 (未到点不跑; 外部事件型不空转)', () => {
  it('时间型: 未到 wakeAt 不跑, 到点才跑 (同一个 Goal 的两次 tick 对照)', async () => {
    const { gs, rs, sup, wiring } = await mods();
    await useHome('wakeAt');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '到点才继续的目标', successCriteria: ['判据0'], createdBy: 'p5' });
    const r1 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r1.runId, { tool: 'shell_exec', ok: true, summary: '第一轮' });
    await rs.finishRun(r1.runId, { status: 'done' });
    await gs.attachRun(g.goalId, r1.runId);
    const wakeAt = iso(t0 + 10 * 60_000);
    await gs.updateGoal(g.goalId, { status: 'retry_wait' });
    await gs.setContinuation(g.goalId, { wakeAt, wakeReason: 'retry_wait', autoContinue: true, state: 'retry_wait' });

    let t = t0;
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['到点后继续'] }), maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    const rep1 = await s.tickOnce();     // 未到点
    expect(rep1.executed.length).toBe(0);
    expect(rep1.skipped.some((x) => /未到唤醒时间|时间未到|retry_wait/.test(x.reason))).toBe(true);
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(1);

    t = t0 + 11 * 60_000;                // 到点
    const rep2 = await s.tickOnce();
    expect(rep2.executed.length).toBe(1);
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(2);
    void wiring;
  });

  it('事件型: 等外部事件时多次 tick 也不空转 (不烧轮次); 真事件投递后下一 tick 就推进', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const ev = await import('../agents/external-events.js');
    const home = await useHome('wake-event');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '等外部事件的目标', successCriteria: ['判据0'], createdBy: 'p5' });
    const r1 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r1.runId, { tool: 'shell_exec', ok: true, summary: '第一轮' });
    await rs.finishRun(r1.runId, { status: 'done' });
    await gs.attachRun(g.goalId, r1.runId);
    await gs.updateGoal(g.goalId, { status: 'awaiting_external' });
    // 真等待绑定 (协议要求 requestId/continuationId/expectedSource/createdAt/expiresAt 齐)
    // 过期时间给足 (6h): tick 开头会做过期化, 太短会在我们验证"不空转"的过程中把等待判超时
    await ev.bindExternalWait(g.goalId, {
      requestId: 'req-p5-1', continuationId: `c-${g.goalId}`, expectedSource: 'p2p',
      createdAt: iso(t0), expiresAt: ev.defaultWaitExpiry(t0, 6 * 3600_000), note: '等对端回执',
    });
    await gs.setContinuation(g.goalId, { wakeReason: 'awaiting_external', autoContinue: true, state: 'awaiting_external' });

    // 飞轮对"没有 wakeAt 的等待"就是拒绝: 只能由事件唤醒 (不按时间跑)
    const step = await wiring.decideGoalStep({ goalId: g.goalId, now: iso(t0 + 30 * 60_000), maxRetries: 5, home });
    expect(step!.decision!.decision).toBe('wait');
    expect(step!.runnable).toBe(false);
    expect(step!.reason).toMatch(/事件唤醒/);

    // 空转检查: 时钟推 3 次也不开新 Run (轮次没有被浪费)。
    // 步长取 5 分钟: 既够证明"多次 tick 不空转", 又不会把"最后一条 Run 的年龄"推过单 Run 上限 (见缺口 2 用例)
    let t = t0;
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['被事件唤醒后继续'] }), maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    for (let i = 0; i < 3; i++) {
      t += 5 * 60_000;
      const rep = await s.tickOnce();
      expect(rep.executed.filter((e) => e.goalId === g.goalId).length).toBe(0);
    }
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(1);

    // 真事件到达 (走外部事件协议: 校验来源/关联/过期/去重 → 写证据 → 唤醒)
    const delivered = await ev.deliverExternalEvent(
      { source: 'p2p', eventId: 'evt-p5-1', requestId: 'req-p5-1', goalId: g.goalId, eventName: 'reply', payload: { ok: true } },
      { wake: (id) => s.notifyExternal(id), now: () => t },
    );
    expect(delivered.ok).toBe(true);
    expect(delivered.reason).toBe('delivered');
    const afterEv = await gs.readGoal(g.goalId);
    expect(afterEv!.status).toBe('active');                       // 事件投递把状态拉回 active
    expect(afterEv!.continuation!.wakeReason).toBe('active');
    expect(afterEv!.evidence.join('\n')).toMatch(/外部事件/);      // 事件写成 Goal 证据

    t += 60_000;
    const rep = await s.tickOnce();
    expect(rep.executed.filter((e) => e.goalId === g.goalId).length).toBe(1);
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(2);
    // 同一个事件重复投递 → 不会再唤醒一次 (不重复跑)
    const dup = await ev.deliverExternalEvent(
      { source: 'p2p', eventId: 'evt-p5-1', requestId: 'req-p5-1', goalId: g.goalId, eventName: 'reply' },
      { wake: (id) => s.notifyExternal(id), now: () => t },
    );
    expect(dup.ok).toBe(false);
    expect(dup.reason).toBe('no_match');                          // 等待已清 → 没有 Goal 在等这个事件

    // 也顺手钉住"等太久不许无限等": 等待过期 → tick 开头把它转成 needs_human
    await useHome('wake-expiry');
    const gShort = await gs.createGoal({ objective: '等待会过期的目标', successCriteria: ['判据0'], createdBy: 'p5' });
    await gs.updateGoal(gShort.goalId, { status: 'awaiting_external' });
    await ev.bindExternalWait(gShort.goalId, {
      requestId: 'req-p5-exp', continuationId: `c-${gShort.goalId}`, expectedSource: 'p2p',
      createdAt: iso(t0), expiresAt: ev.defaultWaitExpiry(t0, 60_000), note: '等超时会转人工',
    });
    let tShort = t0 + 61_000;
    const s2 = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['不该跑到这里'] }), maxPerTick: 5, maxRetries: 5, now: () => tShort,
    });
    await s2.tickOnce();
    const expired = await gs.readGoal(gShort.goalId);
    expect(expired!.status).toBe('needs_human');
    expect(expired!.continuation!.autoContinue).toBe(false);
    expect(expired!.evidence.join('\n')).toMatch(/外部事件超时/);
    void tShort;
  });

  it('超过单 Run 上限 (30min) 的长等待也能被事件唤醒: 判龄用**这一段 Run 自己的时长**, 不用 now-startedAt', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const ev = await import('../agents/external-events.js');
    const home = await useHome('wake-long-gap');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '等很久的目标 (30min 以上的等待)', successCriteria: ['判据0'], createdBy: 'p5' });
    const r1 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r1.runId, { tool: 'shell_exec', ok: true, summary: '第一轮' });
    await rs.finishRun(r1.runId, { status: 'done' });
    await gs.attachRun(g.goalId, r1.runId);
    await gs.updateGoal(g.goalId, { status: 'awaiting_external' });
    await ev.bindExternalWait(g.goalId, {
      requestId: 'req-p5-long', continuationId: `c-${g.goalId}`, expectedSource: 'p2p',
      createdAt: iso(t0), expiresAt: ev.defaultWaitExpiry(t0, 6 * 3600_000), note: '等一个慢对端',
    });
    await gs.setContinuation(g.goalId, { wakeReason: 'awaiting_external', autoContinue: true, state: 'awaiting_external' });

    // 这条 Run 只跑了 1 分钟 (结束时刻 = finishedAt/updatedAt), 但**等待**已经 40 分钟
    expect(Date.parse(String((await rs.readRun(r1.runId))!.startedAt))).toBeLessThan(t0 + 60_000);
    let t = t0 + 40 * 60_000;   // 等待已 40 分钟 (> 单 Run 上限 30min)
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['事件到了该继续'] }), maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    // 事件按时到达 (协议校验全过) → 状态拉回 active
    const delivered = await ev.deliverExternalEvent(
      { source: 'p2p', eventId: 'evt-p5-long', requestId: 'req-p5-long', goalId: g.goalId, eventName: 'reply' },
      { wake: (id) => s.notifyExternal(id), now: () => t },
    );
    expect(delivered.ok).toBe(true);
    expect((await gs.readGoal(g.goalId))!.status).toBe('active');

    // ★ 修复后: 事件到了就真开下一轮 —— 单 Run 时间上限只看**这一段 Run 的时长** (已结束的 Run 用结束时刻),
    //   等待多久都不算"本轮超时" (等待由 wakeAt/事件负责)。
    const rep = await s.tickOnce();
    expect(rep.executed.filter((e) => e.goalId === g.goalId).length).toBe(1);
    expect(rep.skipped.some((x) => x.goalId === g.goalId && /超出单 Run 时间上限/.test(String(x.reason)))).toBe(false);
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(2);
    // 决策记录里也没有"本轮已超出单 Run 时间上限"
    const recs = await wiring.readDecisionRecords(g.goalId, home);
    expect(recs.filter((r) => /超出单 Run 时间上限/.test(r.decision.reason))).toEqual([]);

    // ★ 阴性对照 (硬底线本身没被拆掉): 真的**还在跑**的 Run 超时 → 照样交人。
    //   同一个 Goal 形状, 唯一差别 = 最后一条 Run 处于 running (未结束): 它的 startedAt 在 45 分钟前。
    const home2 = await useHome('wake-long-gap-running');
    const g2 = await gs.createGoal({ objective: '一条跑了很久还没结束的 Run', successCriteria: ['判据0'], createdBy: 'p5' });
    const r2 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g2.goalId, goal: g2.objective });
    await gs.attachRun(g2.goalId, r2.runId);
    await gs.updateGoal(g2.goalId, { status: 'active' });
    expect(String((await rs.readRun(r2.runId))!.status)).toBe('running');
    let t2 = t0 + 45 * 60_000;
    const s2 = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['不该跑到这里'] }), maxPerTick: 5, maxRetries: 5, now: () => t2,
    });
    const rep2 = await s2.tickOnce();
    expect(rep2.executed.filter((e) => e.goalId === g2.goalId).length).toBe(0);
    // skip 理由是飞轮包装语 (细节在决策记录 / flywheel note 里), 所以两处都钉
    expect(rep2.skipped.some((x) => x.goalId === g2.goalId && /需要人决定/.test(String(x.reason)))).toBe(true);
    expect(rep2.flywheel.find((f) => f.goalId === g2.goalId)!.nextAction).toMatch(/放宽单 Run 时间上限/);
    const recs2 = await wiring.readDecisionRecords(g2.goalId, home2);
    const last2 = recs2.filter((r) => r.phase === 'preflight').pop()!;
    expect(last2.decision.reason).toMatch(/超出单 Run 时间上限/);
    expect(last2.decision.reason).toMatch(/仍在跑/);
    expect(last2.runnable).toBe(false);
  });

  it('手动 /wake 把等待类状态拉回 active 后真能继续 (与事件投递同一条收敛路径)', async () => {
    const { gs, rs, sup, monitor } = await mods();
    await useHome('wake-manual-gap');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '手动 /wake 唤醒的目标', successCriteria: ['判据0'], createdBy: 'p5' });
    const r1 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r1.runId, { tool: 'shell_exec', ok: true, summary: '第一轮' });
    await rs.finishRun(r1.runId, { status: 'done' });
    await gs.attachRun(g.goalId, r1.runId);
    await gs.updateGoal(g.goalId, { status: 'awaiting_external' });
    await gs.setContinuation(g.goalId, { wakeReason: 'awaiting_external', autoContinue: true, state: 'awaiting_external', needsExternal: '等对端回执' });

    let t = t0;
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['醒了'] }), maxPerTick: 5, maxRetries: 5, now: () => t,
    });
    expect(await s.notifyExternal(g.goalId)).toBe(true);          // CLI /wake 与 POST /api/goals/:id/wake 走这里
    const afterWake = await gs.readGoal(g.goalId);
    expect(afterWake!.continuation!.wakeReason).toBe('active');   // 等待事实被清了
    expect(afterWake!.continuation!.needsExternal).toBeUndefined();
    // ★ 修复后: 状态也拉回 active (原来只清等待事实 ⇒ 唤醒成了空操作)
    expect(afterWake!.status).toBe('active');
    // ★ 界面口径也一致: continuation.state 同步成 active ⇒ 页面显示"正在执行",
    //   不再是"等待外部回复" (真 DOM 段读的就是这个字段)
    expect(afterWake!.continuation!.state).toBe('active');
    expect(monitor.toUserVisibleState({ ...(afterWake!.continuation as any), pendingReports: [] }, [], null)).toBe('executing');
    t += 60_000;
    const rep = await s.tickOnce();
    expect(rep.executed.filter((e) => e.goalId === g.goalId).length).toBe(1);   // 醒了就真跑
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(2);
    // ★ 阴性对照 (唤醒不是"绕过人的决定"): 等人 / 终态的目标**不许**被 /wake 改成 active
    for (const frozen of ['needs_human', 'completed', 'abandoned', 'paused'] as const) {
      const gf = await gs.createGoal({ objective: `状态=${frozen} 的目标`, successCriteria: ['判据0'], createdBy: 'p5' });
      await gs.updateGoal(gf.goalId, { status: frozen });
      await gs.setContinuation(gf.goalId, { wakeReason: 'awaiting_external', autoContinue: true, state: 'awaiting_external', needsExternal: '等对端回执' });
      expect(await s.notifyExternal(gf.goalId)).toBe(true);       // 等待事实照样被清
      expect((await gs.readGoal(gf.goalId))!.status).toBe(frozen); // 但状态一个字节不动
    }
  });

  it('汇报里真的写出"何时继续" (机器继续记录 wakeAt + 用户汇报 expectedResumeAt), 两个输出自洽', async () => {
    const { gs, rs, wiring } = await mods();
    const home = await useHome('wake-report');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '等外部回复后汇报', successCriteria: ['判据0'], createdBy: 'p5' });
    const r = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.finishRun(r.runId, { status: 'awaiting_external', error: '等对端回执' });
    await gs.attachRun(g.goalId, r.runId);
    const wakeAt = iso(t0 + 20 * 60_000);
    await gs.updateGoal(g.goalId, { status: 'awaiting_external' });
    await gs.setContinuation(g.goalId, { wakeReason: 'awaiting_external', autoContinue: true, state: 'awaiting_external', wakeAt });

    const out = await wiring.closeGoalRun({ goalId: g.goalId, runId: r.runId, now: iso(t0), maxRetries: 2, home });
    const d = out!.result.decision;
    expect(d.decision).toBe('wait');
    expect(d.wakeAt).toBe(wakeAt);
    expect(out!.result.continuation.wakeAt).toBe(wakeAt);
    expect(out!.result.continuation.autoContinue).toBe(true);
    expect(out!.result.userReport.expectedResumeAt).toBe(wakeAt);
    expect(out!.result.userReport.willContinue).toBe(true);
    // 用户汇报不许出现内部词
    const report = JSON.parse(await fs.readFile(out!.reportPath, 'utf8'));
    for (const f of ['lease', 'reducer', 'retry counter', 'worker owner', 'attempts']) {
      expect(Object.keys(report)).not.toContain(f);
    }
    expect(report.conclusion).toMatch(/等待外部/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-⑦ 强负例: 子 Agent 回报漂亮但无证据 → 父 Goal 不完成 (两条独立路径)', () => {
  it('路径 A (直调合同门): 文本漂亮但没有逐条证据 → 不接受为完成, 也不判越权完成', async () => {
    const { gs, wiring, contract } = await mods();
    const home = await useHome('neg-a');
    const g = await gs.createGoal({ objective: '父目标: 需要子交 3 条数据', successCriteria: ['有 3 条数据'], createdBy: 'p5' });
    const c = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-parent-7a', childAgentId: 'child-7a', capability: 'collect_data',
      objective: '收 3 条数据', budget: { maxSteps: 5, maxDurationMs: 600_000, maxAmount: null, currency: null },
      successCriteria: ['有 3 条数据 (路径可核验)'], now: iso(Date.now()), issuedBy: 'p5', home,
    });
    const pretty: AgentWorkReport = {
      workId: c.workId, childAgentId: c.childAgentId, status: 'completed',
      summary: '已全部收齐, 数据质量很高, 可以放心使用', evidence: [], artifacts: [],
      checks: [{ name: '自检', verdict: 'pass', detail: '看着没问题' }],
      unresolvedItems: [], blockReason: null, nextRecommendation: '直接合并', durationMs: 900, reportedAt: iso(Date.now()),
    };
    const validation = contract.validateChildReport(c, pretty);
    expect(validation.ok).toBe(false);
    expect(validation.violation).toBe('mark_unverified_as_complete');
    const verdict = contract.acceptsAsComplete(c, pretty);
    expect(verdict.accepted).toBe(false);

    const out = await wiring.handleChildReport({ goalId: g.goalId, workId: c.workId, report: pretty, home });
    expect(out.outcome).toBe('incomplete');
    expect(out.accepted).toBe(false);
    // 父 Goal 状态未被当完成记账, 也没被判完成
    const after = await gs.readGoal(g.goalId);
    expect(after!.status).not.toBe('completed');
    expect(after!.continuation!.pendingReports!.map((p) => p.workId)).toContain(c.workId);
    expect((await gs.completeGoalIfEligible(g.goalId)).ok).toBe(false);

    // 正控 (证明这条门不是永远判红): 按协议补齐逐条证据 + 逐条 pass → 接受
    const good: AgentWorkReport = {
      ...pretty,
      summary: '产出 data.json (3 条记录)',
      evidence: c.requiredEvidence.map((req) => ({ kind: req, ref: 'data.json#L1-L3', note: '真实产物' })),
      checks: c.successCriteria.map((s) => ({ name: `criterion:${s}`, verdict: 'pass' as const, detail: '读到 3 条记录' })),
    };
    expect(contract.acceptsAsComplete(c, good).accepted).toBe(true);
    const out2 = await wiring.handleChildReport({ goalId: g.goalId, workId: c.workId, report: good, home });
    expect(out2.accepted).toBe(true);
  });

  it('路径 B (SubAgentManager 真路径): 回一段漂亮话不算完成; 逐条证据的 JSON 报告才算', async () => {
    const { gs, wiring } = await mods();
    await useHome('neg-b');
    const { SubAgentManager } = await import('../agents/subagent-manager.js');
    const g = await gs.createGoal({ objective: '父目标: 收数据', successCriteria: ['有 3 条数据'], createdBy: 'p5' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as any);
      const { task, workContract } = await mgr.delegateTask(
        'parent-agent', '收集 3 条数据', ['collect_data'], 'normal', undefined,
        { goalId: g.goalId, successCriteria: ['有 3 条数据'], allowedTools: ['read_file'] },
      );
      expect(workContract).toBeTruthy();
      // ① 一段漂亮话 → 不算完成: 任务留在 in_progress, 父仍在等
      await mgr.updateTaskStatus(task.id, 'completed', '全部做完了, 一切顺利, 质量很好, 可以直接合并');
      const t2 = await mgr.getTask(task.id);
      expect(t2!.status).not.toBe('completed');
      expect(String(t2!.error)).toMatch(/不接受为完成/);
      const goal2 = await gs.readGoal(g.goalId);
      expect(goal2!.status).not.toBe('completed');
      expect(goal2!.continuation!.pendingReports!.map((p) => p.workId)).toContain(task.workId);
      // ② 逐条证据的 JSON 报告 → 接受
      const report = {
        workId: task.workId, childAgentId: workContract!.childAgentId, status: 'completed',
        summary: '产出 data.json (3 条记录)',
        evidence: workContract!.requiredEvidence.map((r) => ({ kind: r, ref: 'data.json', note: '真实产物' })),
        artifacts: [{ name: 'data.json', path: 'data.json', hash: null, cid: null, bytes: 64 }],
        checks: workContract!.successCriteria.map((s) => ({ name: `criterion:${s}`, verdict: 'pass', detail: '读到 3 条记录' })),
        unresolvedItems: [], blockReason: null, nextRecommendation: '交给父汇总',
        durationMs: 1000, reportedAt: iso(Date.now()),
      };
      await mgr.updateTaskStatus(task.id, 'completed', JSON.stringify(report));
      expect((await mgr.getTask(task.id))!.status).toBe('completed');
      expect((await gs.readGoal(g.goalId))!.continuation!.pendingReports!.map((p) => p.workId)).not.toContain(task.workId);
      void wiring;
    } finally {
      await mgr.destroy();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-⑧ 强负例: 只有一次偶然成功的 Skill 候选不得转正', () => {
  it('一次成功 / 无失败边界 / 无明确 IO → 拒收 (写不进盘) 且 draftPromotion 抛错', async () => {
    const { wiring, candidate, fly } = await mods();
    const home = await useHome('neg-skill');
    const junk: SkillImprovementCandidate = {
      candidateId: 'cand:p5-junk', name: '偶然成功一次的做法',
      purpose: '一句话经验: 这样写好像能跑通',
      sourceRunIds: ['run-once'], evidenceRefs: [],
      failureCases: [], inputSchema: '', outputSchema: '',
      guarantees: [], doesNotGuarantee: [],
      contentHash: null, occurrences: 1, boundaryClear: false,
      approval: { state: 'not_requested', approvedBy: null, approvedAt: null, changeReason: null },
      status: 'draft', junkReasons: [], proposedAt: iso(Date.now()), proposedByRunId: 'run-once',
    };
    const a = candidate.assessCandidate(junk, []);
    expect(a.promotable).toBe(false);
    expect(a.junkReasons).toContain('single_success');
    expect(a.junkReasons).toContain('no_io_schema');
    expect(a.junkReasons).toContain('no_failure_boundary');

    // 写候选也被第二道门拦下: 盘上不留任何东西
    const file = await wiring.writeSkillCandidate(junk, { home, existing: [], now: iso(Date.now()) });
    expect(file).toBeNull();
    expect(await listDir(path.join(home, '.bolloon', 'skill-candidates'))).toEqual([]);
    expect(await listDir(path.join(home, '.bolloon', 'skills'))).toEqual([]);

    // 正式变更记录也做不出来 (批准人 / 变更原因 / contentHash 都给了也照样抛: 因为候选本身是垃圾)
    expect(() => candidate.draftPromotion({ ...junk, contentHash: 'abc' }, null, '想转正', 'leo', iso(Date.now())))
      .toThrow(/不得晋升|垃圾理由/);

    // 收尾流水线也拦: occurrences=1 的评审候选标 rejected, 且不落盘
    const { gs, rs } = await mods();
    process.env.BOLLOON_RUN_FINAL_REVIEW = SKILL_REVIEW('p5-junk', 1);
    const g = await gs.createGoal({ objective: '一次成功不算 Skill', successCriteria: ['判据0'], createdBy: 'p5' });
    const r = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.recordStep(r.runId, { tool: 'shell_exec', ok: true, summary: '偶然跑通一次' });
    await rs.finishRun(r.runId, { status: 'done' });
    await gs.attachRun(g.goalId, r.runId);
    const out = await wiring.closeGoalRun({ goalId: g.goalId, runId: r.runId, now: iso(Date.now()), maxRetries: 2, home, finalReview: SKILL_REVIEW('p5-junk', 1) });
    expect(out!.result.candidates.length).toBe(1);
    const c = out!.result.candidates[0];
    expect(c.status).toBe('rejected');
    expect(c.junkReasons).toContain('single_success');
    expect(out!.candidatePaths).toEqual([]);
    expect(out!.result.skipped.some((s) => /no_promotable_candidate/.test(s.reason))).toBe(true);
    expect(fly.SKILL_JUNK_REASONS).toContain('single_success');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P5-★额外必查: 真实运行里"合同签发 / 回报核验"到底通不通 (还是空转)', () => {
  it('① 飞轮要 delegate (缺本地能力) 时真 tick **不再被技能门禁拦死**: 照跑 + 真签发工作合同', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const home = await useHome('reach-delegate');
    const t0 = Date.now();
    // 目标声明了一个本节点没有的能力 (非 '?' = 必需) → 飞轮第 ⑩ 条要 delegate
    const g = await gs.createGoal({
      objective: '需要一个本节点没有的能力才能继续', successCriteria: ['能力交付'],
      requiredSkills: ['no-such-capability-xyz'], createdBy: 'p5',
    });
    // 先有一条 Run 事实 (否则只会有 first_run 捷径, 轮不到节奏判定)。
    // 这条 Run 失败且**零进度** → 飞轮才会走到第 ⑩ 条"缺能力 → 派遣"。
    const r0 = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: g.goalId, goal: g.objective });
    await rs.finishRun(r0.runId, { status: 'failed', error: 'ENOTFOUND no-such-capability-xyz 无法解析' });
    await gs.attachRun(g.goalId, r0.runId);

    const step = await wiring.decideGoalStep({ goalId: g.goalId, now: iso(t0), maxRetries: 2, home });
    // 飞轮确实要派遣 (决策层没问题): delegate + 指明缺的能力 + 闸门放行
    expect(step!.decision!.decision).toBe('delegate');
    expect(step!.decision!.requiredCapability).toBe('no-such-capability-xyz');
    expect(step!.runnable).toBe(true);

    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['这一步由子 Agent 交付'] }), maxPerTick: 5, maxRetries: 2, now: () => t0,
    });
    const rep = await s.tickOnce();
    const after = await gs.readGoal(g.goalId);
    const myRuns = rep.executed.filter((e) => e.goalId === g.goalId);
    // ★ 修复前: myRuns[0].status === 'blocked_by_skills' (技能门禁把它拦死, 合同一份都签不出去)
    //   现在: 本地技能门禁对 delegate 放行 —— 照跑, 能力由子 Agent 凭合同交付。
    expect(myRuns.length).toBe(1);
    expect(myRuns[0].status).not.toBe('blocked_by_skills');
    // 注意 `report.executed` 的语义: 它记的是"认领后尝试过的 Goal" (所以"跑没跑"还要看 runs).
    expect(after!.runs.length).toBeGreaterThanOrEqual(2);
    // 门禁**没有放松**: 本地缺什么照样如实写进 continuation (不静默)
    expect(after!.continuation!.skillReadiness!.ok).toBe(false);
    expect(after!.continuation!.skillReadiness!.missing).toContain('no-such-capability-xyz');
    // ★ 工作合同真签发了 (修复前: report.workContracts 恒空、`.bolloon/goal-works/` 连目录都不建)
    expect(rep.workContracts.length).toBeGreaterThanOrEqual(1);
    expect(rep.workContracts[0].capability).toBe('no-such-capability-xyz');
    expect(await exists(path.join(home, wiring.GOAL_WORKS_ROOT))).toBe(true);
    const contractPath = wiring.contractPathFor(g.goalId, rep.workContracts[0].workId, home);
    expect(await exists(contractPath)).toBe(true);
    const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
    expect(contract.capability).toBe('no-such-capability-xyz');
    expect(contract.goalId).toBe(g.goalId);
    expect(contract.requiredEvidence.length).toBeGreaterThan(0);
    expect(contract.successCriteria.length).toBeGreaterThan(0);
    // 父 Goal 上记着"等这份回报" (阻塞巡检从此有了输入面)
    expect((after!.continuation!.pendingReports ?? []).map((p) => p.workId)).toContain(rep.workContracts[0].workId);
    // ★ 阴性对照 (技能门禁本身没被拆掉): **非 delegate** 裁决下, 缺技能仍然不启动 Run。
    //   同一个 Goal 形状, 唯一差别 = 执行器/决策层不要求 delegate 时 (这里用 first_run 形状的 Goal:
    //   没有 Run 事实 ⇒ 裁决不是 delegate) 照样被拦成 blocked_by_skills。
    const g2 = await gs.createGoal({
      objective: '同一个缺能力的目标, 但没有"派遣"这一步', successCriteria: ['能力交付'],
      requiredSkills: ['no-such-capability-xyz'], createdBy: 'p5',
    });
    const s2 = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['不该跑到这里'] }), maxPerTick: 5, maxRetries: 2, now: () => t0,
    });
    const repNoDelegate = await s2.tickOnce();
    const ran2 = repNoDelegate.executed.filter((e) => e.goalId === g2.goalId);
    expect(ran2.length).toBe(1);
    expect(ran2[0].status).toBe('blocked_by_skills');
    expect(repNoDelegate.workContracts.filter((c) => c.goalId === g2.goalId)).toEqual([]);
    expect((await gs.readGoal(g2.goalId))!.status).toBe('needs_human');
  });

  it('② 普通目标 (飞轮没说 delegate) 真 tick 后阻塞巡检没有输入: pendingReports/works 都空 (对照 ①)', async () => {
    const { gs, rs, sup, wiring } = await mods();
    const home = await useHome('reach-monitor');
    const t0 = Date.now();
    const g = await gs.createGoal({ objective: '普通目标 (没人给它派子工作)', successCriteria: ['判据0'], createdBy: 'p5' });
    const s = new sup.ExecutionSupervisor({
      runner: makeRunner(rs, gs, { okSteps: ['正常推进'] }), maxPerTick: 5, maxRetries: 2, now: () => t0,
    });
    const rep = await s.tickOnce();
    expect(rep.executed.length).toBe(1);
    // 跑了真 Run, 但没有任何 pendingReports → 阻塞巡检没有输入 (rep.blocks 空)
    expect(rep.blocks).toEqual([]);
    const after = await gs.readGoal(g.goalId);
    expect(after!.continuation!.pendingReports ?? []).toEqual([]);
    // 全仓唯一会写 pendingReports 的地方是 dispatchChildWork —— 也就是说这条巡检链
    // 只有在"有子工作合同"时才可能有输入 (见本用例 ①②③ 的合并结论)。
    expect(typeof wiring.dispatchChildWork).toBe('function');
    expect(await exists(path.join(home, wiring.GOAL_WORKS_ROOT))).toBe(false);
  });

  it('③ CLI --delegate 真带 goalId: 合同门不再空转 (运行时复现"无证据的漂亮报告被拒" + 源码级事实)', async () => {
    const { gs } = await mods();
    await useHome('reach-cli');
    const { SubAgentManager } = await import('../agents/subagent-manager.js');

    // 运行时: 按 CLI **修复后**的调用形状 (6 参 + contractOptions.goalId) 派遣
    const g = await gs.createGoal({ objective: '父目标', successCriteria: ['判据0'], createdBy: 'p5' });
    const mgr = new SubAgentManager({ storagePath: path.join(TMP, '.bolloon', 'agents') });
    await mgr.initialize();
    try {
      await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as any);
      const { task, workContract } = await mgr.delegateTask(
        'cli-user', '收集数据', ['collect_data'], 'normal', undefined,
        { goalId: g.goalId, successCriteria: ['收集数据'] },
      );
      expect(workContract).toBeTruthy();
      expect(task.workId).toBe(workContract!.workId);
      expect(task.goalId).toBe(g.goalId);
      // ★ 修复后: 一句"全部做完了"**不再**能把任务标成完成 (合同门真生效)
      await mgr.updateTaskStatus(task.id, 'completed', '全部做完了');
      const t2 = await mgr.getTask(task.id);
      expect(t2!.status).toBe('in_progress');
      expect(String(t2!.error)).toMatch(/不接受为完成/);
      // 父 Goal 上留下"等回报"的痕迹 (阻塞巡检的输入面)
      expect((await gs.readGoal(g.goalId))!.continuation!.pendingReports!.map((p) => p.workId)).toContain(task.workId);
      // 阴性对照 (门不是永远判红): 逐条证据的 JSON 报告 → 真完成, pendingReports 清掉
      const report = {
        workId: task.workId, childAgentId: workContract!.childAgentId, status: 'completed',
        summary: '产出 data.json', evidence: workContract!.requiredEvidence.map((r) => ({ kind: r, ref: 'data.json', note: '真实产物' })),
        artifacts: [], checks: workContract!.successCriteria.map((s) => ({ name: `criterion:${s}`, verdict: 'pass', detail: '读到数据' })),
        unresolvedItems: [], blockReason: null, nextRecommendation: '交给父汇总', durationMs: 10, reportedAt: iso(Date.now()),
      };
      await mgr.updateTaskStatus(task.id, 'completed', JSON.stringify(report));
      expect((await mgr.getTask(task.id))!.status).toBe('completed');
      expect((await gs.readGoal(g.goalId))!.continuation!.pendingReports!.map((p) => p.workId)).not.toContain(task.workId);

      // 阴性对照 (边界如实钉住): **不**给 goalId (旧调用形状) → 没有合同 → 没有回报核验
      const legacy = await mgr.delegateTask('cli-user', '收集数据2', ['collect_data']);
      expect(legacy.workContract).toBeUndefined();
      await mgr.updateTaskStatus(legacy.task.id, 'completed', '全部做完了');
      expect((await mgr.getTask(legacy.task.id))!.status).toBe('completed');   // 旧形状: 说完成就完成
    } finally {
      await mgr.destroy();
    }

    // 源码级事实 (可重跑): CLI 的派遣调用**真的**把 goalId 传下去了, 而且没给 --goal 时会建目标
    const indexSrc = await fs.readFile(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');
    const call = /manager\.delegateTask\(([\s\S]{0,400}?)\);/.exec(indexSrc);
    expect(call).toBeTruthy();
    expect(call![1]).toContain('goalId');
    expect(call![1]).toContain('successCriteria');
    expect(indexSrc).toContain('async function ensureDelegateGoal');
    expect(indexSrc).toMatch(/case '--goal'/);
    // 目标上下文的两种入口都在: 显式 --goal / 没给就建一个 (createdBy='cli:delegate')
    expect(indexSrc).toContain("createdBy: 'cli:delegate'");
  });
});
