/**
 * M1 自适应节奏接缝 (`wiring/continuation.ts`) —— 门 (2026-09-25)
 *
 * 这道门要回答的不是"函数返回了什么", 而是任务书里那一句**是不是真的成立**:
 *
 * ```
 * 固定轮次降级为**安全上限** (单 Run 时间 · 单 Goal 预算 · 无进展阈值), 主节奏由进展决定。
 * ```
 *
 * 于是它按四层钉:
 *   ① **纯函数层**: `safetyCapsFrom` (旧轮次 → 上限) 与 `planRhythm` (进展 → 节奏) 的每条规则一个用例,
 *      期望值全部**从真状态算** (时长、Run 数、判据下标), 不抄实现里的常量;
 *   ② **负控成对**: 每个"该停"的用例都配一个"同一个字段换成合规值 → 立刻不该停"的对照,
 *      并且证明**归因会跟着变** (上限在说话 / 与上限无关, 不许一律记成"被上限拦住");
 *   ③ **真跑**: 真 Goal Store + 真 Run Store (隔离 HOME) 造出的真事实 → 接缝自己的 `preflight`;
 *   ④ **变异验证**: 把主不变量改坏 → 同一份判据必须判红 (源码级 + 运行期各一组)。
 *
 * 已声明**不做**的 (如实留白): 不改 M0 骨架 (接线层怎么把 `readFacts` 注进 `flywheelSeams()`
 * 是主线的事, 见报告里的钩子请求); `src/test` 不在 tsconfig include 里, 所以这里只用运行期断言。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  RHYTHM_BASIS_TEXT,
  SAFETY_CAPS,
  SAFETY_CAP_TEXT,
  SEAM_RHYTHM_REQUIRED,
  SEAM_ROUNDS_AS_RHYTHM,
  bindingCaps,
  createContinuationSeam,
  judgeInjectedOutcome,
  judgeLegacyStop,
  planRhythm,
  rhythmicDecision,
  safetyCapsFrom,
  scanContinuationSeamRhythm,
} from '../agents/goal-flywheel/wiring/continuation.js';
import { isRefusal } from '../agents/goal-flywheel/wiring/seams.js';
import { decideContinuation } from '../agents/goal-flywheel/continuation-decision.js';

// ---------------------------------------------------------------------------
// 夹具 (纯函数层): 真状态写成字面量, 期望值由它们**算**出来
// ---------------------------------------------------------------------------

const NOW = '2026-09-25T12:00:00.000Z';
const MIN = 60_000;
const HOUR = 3_600_000;

/** 默认 Run: 11:55 开始 (5 分钟前), 已结束 → 不触发任何上限, 每条用例只命中一条规则 */
function mkRun(over: Record<string, unknown> = {}): any {
  return {
    runId: 'r1',
    goalId: 'g-m1',
    surface: 'cli',
    goal: '跑一轮',
    pid: 4242,
    host: 'test-host',
    startedAt: '2026-09-25T11:55:00.000Z',
    updatedAt: NOW,
    status: 'done',
    steps: [{ n: 1, ts: NOW, tool: 'shell_exec', ok: true, summary: '产出 /tmp/x' }],
    budget: { maxSteps: 60, deadlineMs: 1_800_000 },
    recovery: [],
    ...over,
  };
}

function mkGoal(over: Record<string, unknown> = {}): any {
  return {
    goalId: 'g-m1',
    objective: '把 landing 页上线并拿到 3 条真实回执',
    successCriteria: ['页面可访问', '有 3 条回执'],
    constraints: [],
    status: 'active',
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: NOW,
    runs: ['r1'],
    completedCriteria: [],
    unresolvedItems: [],
    evidence: [],
    ...over,
  };
}

function mkProgress(over: Record<string, unknown> = {}): any {
  return { newEvidence: [], newlyCompletedCriteria: [], stepsAdvanced: 0, unresolvedDelta: 0, ...over };
}

function mkFacts(
  goalOver: Record<string, unknown> = {},
  runOver: Record<string, unknown> = {},
  progressOver: Record<string, unknown> = {},
  noProgressStreak = 0,
): any {
  return {
    goal: mkGoal(goalOver),
    run: mkRun(runOver),
    now: NOW,
    progress: mkProgress(progressOver),
    noProgressStreak,
  };
}

const EV = ['run1/shell_exec: 产出 /tmp/x'];

// ---------------------------------------------------------------------------
// 隔离 HOME (真跑用)
// ---------------------------------------------------------------------------

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const OLD_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['BOLLOON_GOAL_NO_PROGRESS_BREAKER', 'BOLLOON_GOAL_MAX_RUNS', 'BOLLOON_GOAL_MAX_RUN_MS', 'BOLLOON_RUN_PERSIST'];

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-m1-cont-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fsp.mkdir(TMP, { recursive: true });
  for (const k of ENV_KEYS) OLD_ENV[k] = process.env[k];
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  // 真实 Store 的 env 兜底一律清掉: 期望值只准来自本文件写下的真状态
  delete process.env.BOLLOON_GOAL_NO_PROGRESS_BREAKER;
  delete process.env.BOLLOON_GOAL_MAX_RUNS;
  delete process.env.BOLLOON_GOAL_MAX_RUN_MS;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  for (const k of ENV_KEYS) {
    if (OLD_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = OLD_ENV[k]!;
  }
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function realMods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    wiring: await import('../agents/goal-flywheel-wiring.js'),
  };
}

/** 从**盘上的真事实**推出接缝要的那些输入 (不手写 facts) */
async function factsFromStore(goalId: string, nowIso: string) {
  const { gs, rs, wiring } = await realMods();
  const goal = (await gs.readGoal(goalId))!;
  const lastRunId = goal.currentRunId || goal.runs[goal.runs.length - 1];
  const run = (await rs.readRun(lastRunId))!;
  const records = await wiring.readDecisionRecords(goalId);
  const prev = [...records].reverse().find((r: any) => r.phase === 'closure')?.goalSnapshot ?? null;
  const progress = wiring.computeRunProgress(goal, run, prev);
  const noProgressStreak = await wiring.deriveNoProgressStreak(goal, run.runId, progress, records);
  return { goal, run, now: nowIso, progress, noProgressStreak };
}

/** 跑一轮真 Run 并挂到 Goal 上 (有步骤 = 有可核验证据; 无步骤 = 无进展) */
async function realRun(goalId: string, steps: string[] = []) {
  const { gs, rs } = await realMods();
  const rec = await rs.startRun({ channelId: 'ch-m1', goalId, goal: 'M1 真跑' });
  for (const s of steps) await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: s });
  await rs.finishRun(rec.runId, { status: 'done' });
  await gs.attachRun(goalId, rec.runId);
  return rec.runId;
}

/** 接缝结论的读取器 (被拒/为 null 时立刻炸, 免得后面的断言在"空对象"上假绿) */
function preflightOf(x: unknown): any {
  expect(isRefusal(x), `不该被拒: ${JSON.stringify(x)}`).toBe(false);
  expect(x, '接缝返回了 null (既没结论也没拒绝)').toBeTruthy();
  return x as any;
}

// ===========================================================================
// §0. 门自身不空转
// ===========================================================================

const SEAM_REL = 'src/agents/goal-flywheel/wiring/continuation.ts';
const SEAM_SRC = fsSync.readFileSync(path.join(process.cwd(), SEAM_REL), 'utf8');

describe('§0 源码级判据自身不空转 (真读盘 + 变异必须判红)', () => {
  it('真读到了接缝源码 (不是拿空串糊过去)', () => {
    expect(SEAM_SRC.length).toBeGreaterThan(2000);
    expect(SEAM_SRC).toContain('safetyCapsFrom');
  });

  it('干净树上源码判据全绿, 且登记的判据条数只加不减', () => {
    const r = scanContinuationSeamRhythm(SEAM_SRC);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(SAFETY_CAPS.length).toBe(3);
    expect(Object.keys(SAFETY_CAP_TEXT).sort()).toEqual([...SAFETY_CAPS].sort());
    expect(Object.keys(RHYTHM_BASIS_TEXT).sort()).toEqual(['cap', 'delegate', 'human', 'progress', 'terminal', 'wait']);
    // 判据自己的条数只加不减 (少一条 = 有一段接线没人看)
    expect(SEAM_RHYTHM_REQUIRED.length).toBe(4);
    expect(SEAM_ROUNDS_AS_RHYTHM.length).toBeGreaterThanOrEqual(4);
  });

  it('★ 变异: 把收紧上限那一步摘掉 (改名) → 判红', () => {
    const broken = SEAM_SRC.replace(/(?<![A-Za-z0-9_])applyHardLimits\s*\(/g, 'skipHardLimits(');
    expect(broken).not.toBe(SEAM_SRC); // 变异本身生效 (没生效 = 阴性对照失效)
    const r = scanContinuationSeamRhythm(broken);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('applyHardLimits');
  });

  it('★ 变异: 把上限登记函数摘掉 (改名) → 判红', () => {
    const broken = SEAM_SRC.replace(/(?<![A-Za-z0-9_])safetyCapsFrom\s*\(/g, 'skipCapsFrom(');
    expect(broken).not.toBe(SEAM_SRC);
    const r = scanContinuationSeamRhythm(broken);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('safetyCapsFrom');
  });

  it('★ 变异: 塞回"按轮次停" (拿 Run 数自己判) → 判红', () => {
    const broken = `${SEAM_SRC}\nexport function legacyStop(goal: { runs: string[] }): boolean {\n  const runsUsed = goal.runs.length;\n  return runsUsed >= 3;\n}\n`;
    const r = scanContinuationSeamRhythm(broken);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('按轮次停');
  });
});

// ===========================================================================
// §1. 固定轮次 → 安全上限 (降级的唯一实现处)
// ===========================================================================

describe('§1 旧固定轮次降级为安全上限', () => {
  it('默认三类上限; maxRounds →「单 Goal 预算」, maxRetries →「无进展熔断阈值」', () => {
    expect(safetyCapsFrom()).toEqual({ maxRunDurationMs: 30 * MIN, maxGoalBudget: 50, noProgressCircuitBreaker: 3 });
    expect(safetyCapsFrom({ maxRounds: 7 }).maxGoalBudget).toBe(7);
    // 与 M0 `hardLimitsFor` 同口径: 阈值 = maxRetries + 1
    expect(safetyCapsFrom({ maxRetries: 4 }).noProgressCircuitBreaker).toBe(5);
    expect(safetyCapsFrom({ maxRunDurationMs: 90_000 }).maxRunDurationMs).toBe(90_000);
    expect(safetyCapsFrom({ maxRetries: 0 }).noProgressCircuitBreaker).toBe(1);
  });

  it('显式上限优先; maxGoalBudget=null 是显式语义 (未设上限 ≠ 拿默认值盖掉)', () => {
    expect(safetyCapsFrom({ maxRounds: 7, limits: { maxGoalBudget: 2 } }).maxGoalBudget).toBe(2);
    expect(safetyCapsFrom({ maxRounds: 7, limits: { maxGoalBudget: null } }).maxGoalBudget).toBeNull();
    expect(safetyCapsFrom({ maxRunDurationMs: 1000, limits: { maxRunDurationMs: 5000 } }).maxRunDurationMs).toBe(5000);
  });

  it('负控制: 乱值不许被当成上限 (0/负数/小数/NaN 一律退回默认)', () => {
    expect(safetyCapsFrom({ maxRounds: 0 }).maxGoalBudget).toBe(50);
    expect(safetyCapsFrom({ maxRounds: 0.5 }).maxGoalBudget).toBe(50);
    expect(safetyCapsFrom({ maxRetries: -1 }).noProgressCircuitBreaker).toBe(3);
    expect(safetyCapsFrom({ maxRunDurationMs: Number.NaN }).maxRunDurationMs).toBe(30 * MIN);
    expect(safetyCapsFrom({ maxRunDurationMs: -1 }).maxRunDurationMs).toBe(30 * MIN);
  });
});

// ===========================================================================
// §2. 主节奏由进展决定
// ===========================================================================

describe('§2 主节奏 = 进展 (轮次/步数不算)', () => {
  const CFG = { maxRounds: 50, maxRetries: 2 };

  it('有可核验证据 → continue; 上限一条都不算数, 但被登记成了可审计的上限', () => {
    const plan = planRhythm(mkFacts({}, {}, { newEvidence: EV, stepsAdvanced: 3 }), CFG);
    expect(plan.basis).toBe('progress');
    expect(plan.runnable).toBe(true);
    expect(plan.caps).toEqual([]);
    expect(plan.bindingCap).toBeNull();
    expect(plan.decision.decision).toBe('continue');
    // 旧配置降级成了上限 (50 → 预算, 2 → 阈值 3), 而不是被当成节奏
    expect(plan.capsInEffect).toEqual({ maxRunDurationMs: 30 * MIN, maxGoalBudget: 50, noProgressCircuitBreaker: 3 });
  });

  it('负控制: 同一条事实只拿掉"新证据" → 立刻不许继续 (stepsAdvanced=3 不算进展)', () => {
    const withEv = planRhythm(mkFacts({}, {}, { newEvidence: EV, stepsAdvanced: 3 }), CFG);
    const noEv = planRhythm(mkFacts({}, {}, { newEvidence: [], stepsAdvanced: 3 }), CFG);
    expect(withEv.runnable).toBe(true);
    expect(noEv.runnable).toBe(false);
    expect(noEv.decision.decision).toBe('ask_human');
    expect(noEv.basis).toBe('human');
    // ★ 归因反面对照: 这个停**不是**上限造成的 —— 上限全放到天上仍然停得住
    const capsSky = safetyCapsFrom({
      limits: {
        maxRunDurationMs: Number.MAX_SAFE_INTEGER,
        maxGoalBudget: Number.MAX_SAFE_INTEGER,
        noProgressCircuitBreaker: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(bindingCaps(mkFacts({}, {}, { newEvidence: [], stepsAdvanced: 3 }), capsSky)).toEqual([]);
    expect(planRhythm(mkFacts({}, {}, { newEvidence: [] }), {
      limits: {
        maxRunDurationMs: Number.MAX_SAFE_INTEGER,
        maxGoalBudget: Number.MAX_SAFE_INTEGER,
        noProgressCircuitBreaker: Number.MAX_SAFE_INTEGER,
      },
    }).runnable).toBe(false);
    expect(noEv.caps).toEqual([]);
  });

  it('新满足的判据也算进展', () => {
    const plan = planRhythm(
      mkFacts({ successCriteria: ['a', 'b', 'c'], completedCriteria: [0] }, {}, { newlyCompletedCriteria: [1] }),
      CFG,
    );
    expect(plan.basis).toBe('progress');
    expect(plan.runnable).toBe(true);
    expect(plan.decision.decision).toBe('continue');
  });

  it('判据全满足且收干净 → 终态 complete (不再起新 Run), 且不归因到上限', () => {
    const plan = planRhythm(
      mkFacts({ status: 'completed', successCriteria: ['a'], completedCriteria: [0], evidence: ['e0'] }),
      CFG,
    );
    expect(plan.basis).toBe('terminal');
    expect(plan.runnable).toBe(false);
    expect(plan.caps).toEqual([]);
    expect(plan.decision.decision).toBe('complete');
  });
});

// ===========================================================================
// §3. 三类安全上限 (期望值从真状态算 + 成对负控)
// ===========================================================================

describe('§3 安全上限①「单 Run 时间」', () => {
  // 真状态: 10:00 开始, 11:00 结束 (已结束的 Run 按 updatedAt 计龄) → 3_600_000ms
  const OLD_RUN = { status: 'done', startedAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T11:00:00.000Z' };
  const F = mkFacts({}, OLD_RUN);

  it('1h 的 Run + 30min 上限 → 停, 且归因到 max_run_duration', () => {
    const plan = planRhythm(F, { maxRunDurationMs: 30 * MIN });
    expect(plan.caps).toEqual(['max_run_duration']);
    expect(plan.bindingCap).toBe('max_run_duration');
    expect(plan.basis).toBe('cap');
    expect(plan.runnable).toBe(false);
    expect(plan.decision.decision).toBe('ask_human');
    expect(plan.decisionReason).toContain('单 Run 时间上限');
  });

  it('负控制: 同一条事实只把上限放宽到 2h → 这条上限不再算数 (归因跟着变)', () => {
    const plan = planRhythm(F, { maxRunDurationMs: 2 * HOUR });
    expect(plan.caps).toEqual([]);
    expect(plan.basis).toBe('human'); // 变成"没有继续的资格", 不是"被上限拦住"
  });

  it('同一条事实, 两个上限值 → 结论不同 (不是同义反复)', () => {
    const tight = planRhythm(F, { maxRunDurationMs: 30 * MIN });
    const loose = planRhythm(F, { maxRunDurationMs: 2 * HOUR });
    expect(tight.runnable).toBe(false);
    expect(loose.decisionReason).not.toBe(tight.decisionReason);
    expect(loose.caps).not.toEqual(tight.caps);
  });
});

describe('§3 安全上限②「单 Goal 预算」', () => {
  const PROG = { newEvidence: EV };

  it('来源 a: 旧 maxRounds 降级成的上限真的能停 (总 Run 数到顶, 有进展也停)', () => {
    // 真状态: 已有 3 个 Run, 旧配置写着"第 3 轮就停" → 降级成"单 Goal 预算 = 3"
    const plan = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, PROG), { maxRounds: 3 });
    expect(plan.capsInEffect.maxGoalBudget).toBe(3);
    expect(plan.caps).toEqual(['goal_budget']);
    expect(plan.bindingCap).toBe('goal_budget');
    expect(plan.basis).toBe('cap');
    expect(plan.runnable).toBe(false);
    expect(plan.decisionReason).toContain('单 Goal 预算用尽');
    expect(plan.decisionReason).toContain('budget.maxRuns=3');  // 3 就是从 maxRounds=3 降级来的真值
    // 上限缺席时的对照: 同一批事实 + 上限放到第 4 轮 → 这一条不再算数
    const noCap = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, PROG), { maxRounds: 4 });
    expect(noCap.decisionReason).not.toContain('单 Goal 预算用尽');
    // 负控制: 同一个 Goal (第 3 轮已到) 把上限放到第 4 轮 → 有进展就继续
    const looser = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, PROG), { maxRounds: 4 });
    expect(looser.caps).toEqual([]);
    expect(looser.runnable).toBe(true);
    expect(looser.basis).toBe('progress');
  });

  it('来源 b: Goal 自带 budget.maxRuns 也归到同一条上限 (与旧配置无关)', () => {
    const plan = planRhythm(mkFacts({ budget: { maxRuns: 1 }, runs: ['r1'] }, {}, PROG), {});
    expect(plan.caps).toEqual(['goal_budget']);
    expect(plan.runnable).toBe(false);
    // 期望值从真状态推导: 理由里指的就是那个真值 1
    expect(plan.decisionReason).toContain('budget.maxRuns=1');
  });

  it('负控制: 同一个 Goal 的预算放宽后 → 有进展就继续 (预算不再拦)', () => {
    const tight = mkFacts({ budget: { maxRuns: 1 }, runs: ['r1'] }, {}, PROG);
    const loose = mkFacts({ budget: { maxRuns: 99 }, runs: ['r1'] }, {}, PROG);
    expect(planRhythm(tight, {}).runnable).toBe(false);
    expect(planRhythm(tight, {}).caps).toEqual(['goal_budget']);
    expect(planRhythm(loose, {}).runnable).toBe(true);
    expect(planRhythm(loose, {}).caps).toEqual([]);
    expect(planRhythm(loose, {}).basis).toBe('progress');
  });

  it('未设上限 (maxGoalBudget=null) 也算上限在说话: 必须由人确认才能继续', () => {
    const plan = planRhythm(mkFacts({}, {}, PROG), { limits: { maxGoalBudget: null } });
    expect(plan.caps).toEqual(['goal_budget']);
    expect(plan.basis).toBe('cap');
    expect(plan.runnable).toBe(false);
    expect(plan.decisionReason).toContain('未设单 Goal 预算上限');
  });
});

describe('§3 安全上限③「无进展熔断阈值」', () => {
  it('连续无新证据达到阈值 → 停, 归因 no_progress_breaker (阈值 = maxRetries+1)', () => {
    // 真状态: 已跑 3 个 Run, 连续 3 轮无新证据
    const plan = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, {}, 3), { maxRetries: 2 });
    expect(plan.capsInEffect.noProgressCircuitBreaker).toBe(3);
    expect(plan.noProgressStreak).toBe(3);
    expect(plan.caps).toEqual(['no_progress_breaker']);
    expect(plan.basis).toBe('cap');
    expect(plan.runnable).toBe(false);
    expect(plan.decision.decision).toBe('ask_human');
    expect(plan.decision.state).toBe('no_progress');
  });

  it('负控制: streak 差一轮 (2 < 3) → 不归因到熔断 (是"没有继续的资格")', () => {
    const plan = planRhythm(mkFacts({ runs: ['r1', 'r2'] }, {}, {}, 2), { maxRetries: 2 });
    expect(plan.caps).toEqual([]);
    expect(plan.basis).toBe('human');
    expect(plan.runnable).toBe(false);
    expect(plan.decision.state).toBe('needs_decision');
  });

  it('负控制: streak 到阈值但**有**新证据 → 不算触顶 (熔断只吃无进展)', () => {
    const plan = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, { newEvidence: EV }, 3), { maxRetries: 2 });
    expect(plan.caps).toEqual([]);
    expect(plan.basis).toBe('progress');
    expect(plan.runnable).toBe(true);
  });

  it('归因只认"起决定作用"的那条: 两条同时触顶 → P0 顺序里预算先说话', () => {
    // 真状态: 已跑 3 个 Run (预算 3 到顶) + 连续 3 轮无证据 (熔断 3 到顶)
    const both = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, {}, 3), { maxRounds: 3, maxRetries: 2 });
    expect(both.caps).toEqual(['goal_budget']);
    expect(both.bindingCap).toBe('goal_budget');
    expect(both.basis).toBe('cap');
    // 对照: 只把预算放到第 4 轮 → 熔断这条才浮出来 (证明它也确实触顶了, 只是被先命的规则盖住)
    const breakerOnly = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, {}, 3), { maxRounds: 4, maxRetries: 2 });
    expect(breakerOnly.caps).toEqual(['no_progress_breaker']);
    expect(breakerOnly.bindingCap).toBe('no_progress_breaker');
    // 对照: 两条都放到够宽 → 谁都不算数 (这时是"没有继续的资格")
    const neither = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, {}, 3), { maxRounds: 4, maxRetries: 3 });
    expect(neither.caps).toEqual([]);
    expect(neither.basis).toBe('human');
  });
});

// ===========================================================================
// §4. 「轮次不许当节奏」的裁决 (旧结论 vs 事实算出的节奏)
// ===========================================================================

describe('§4 judgeLegacyStop: 旧结论的"停"什么时候站得住', () => {
  const legacyStop = { runnable: false, reason: '运输层: 已达到最大轮次 3 → needs_human' };
  const CFG = { maxRetries: 2 };

  it('★ 有进展 + 上限没触顶 → 旧结论被推翻 (继续)', () => {
    const plan = planRhythm(mkFacts({}, {}, { newEvidence: EV }), CFG);
    const v = judgeLegacyStop(legacyStop, plan);
    expect(v.stop).toBe(false);
    expect(v.overridden).toBe(true);
    expect(v.reason).toContain('被推翻');
  });

  it('上限真的触顶 → 停得住 (旧结论照旧, 而且是上限在停)', () => {
    const plan = planRhythm(mkFacts({ runs: ['r1', 'r2', 'r3'] }, {}, {}, 3), CFG);
    const v = judgeLegacyStop(legacyStop, plan);
    expect(v.stop).toBe(true);
    expect(v.overridden).toBe(false);
    expect(v.reason).toContain('无进展熔断阈值');
  });

  it('负控制: 同样无进展但上限没触顶 → 停得住 (理由是"没证据", 不是"第几轮")', () => {
    const plan = planRhythm(mkFacts({}, {}, {}), CFG);
    const v = judgeLegacyStop(legacyStop, plan);
    expect(v.stop).toBe(true);
    expect(v.overridden).toBe(false);
    expect(v.reason).toContain(RHYTHM_BASIS_TEXT.human);
    expect(v.reason).not.toContain('安全上限触顶');
  });

  it('终态 / 等外部 → 停得住 (旧结论不被推翻)', () => {
    const done = planRhythm(mkFacts({ status: 'completed', successCriteria: ['a'], completedCriteria: [0], evidence: ['e0'] }), CFG);
    expect(judgeLegacyStop(legacyStop, done)).toMatchObject({ stop: true, overridden: false });
    const waiting = planRhythm(mkFacts({ status: 'awaiting_external' }, {}, { newEvidence: EV }), CFG);
    expect(waiting.basis).toBe('wait');
    expect(judgeLegacyStop(legacyStop, waiting)).toMatchObject({ stop: true, overridden: false });
  });

  it('旧结论自己说"能跑" → 不拦 (裁决只推翻停, 不制造停)', () => {
    const plan = planRhythm(mkFacts({}, {}, { newEvidence: EV }), CFG);
    const v = judgeLegacyStop({ runnable: true, reason: '有进展' }, plan);
    expect(v.stop).toBe(false);
    expect(v.overridden).toBe(false);
  });
});

// ===========================================================================
// §5. 接缝本体: 谁有权决定 + 拒绝必须是真的
// ===========================================================================

describe('§5 只有 Supervisor 能决定是否继续 (规则 ①)', () => {
  const deps = { decide: async () => ({ goalId: 'g1', runnable: true, reason: 'ok', noProgressStreak: 0, decision: null }) };

  it('非 supervisor 的身份一律真拒 (结构化, 带规则号)', async () => {
    const seam = createContinuationSeam(deps);
    for (const caller of ['runner', 'child_agent', 'human', 'system'] as const) {
      const out = await seam.preflight({ goalId: 'g1', caller, now: NOW });
      expect(isRefusal(out), `caller=${caller} 应当被拒`).toBe(true);
      expect((out as any).rule).toBe('only_supervisor_decides_continuation');
      expect((out as any).reason).toContain('只有 Supervisor');
    }
  });

  it('负控制: 同一个 seam, 身份换成 supervisor → 立刻放行 (证明拒绝不是"永远拒")', async () => {
    const seam = createContinuationSeam(deps);
    const out = await seam.preflight({ goalId: 'g1', caller: 'supervisor', now: NOW });
    expect(isRefusal(out)).toBe(false);
    expect((out as any).runnable).toBe(true);
  });

  it('没有 goalId → 真拒; 没有任何判定依赖 → 真拒 (不许静默 undefined)', async () => {
    const seam = createContinuationSeam(deps);
    const noGoal = await seam.preflight({ goalId: '', caller: 'supervisor', now: NOW });
    expect(isRefusal(noGoal)).toBe(true);
    const bare = createContinuationSeam({});
    const out = await bare.preflight({ goalId: 'g1', caller: 'supervisor', now: NOW });
    expect(isRefusal(out)).toBe(true);
    expect((out as any).reason).toContain('没有事实就没有节奏判定');
  });

  it('事实读不到 + 没有兜底 → null (如实说, 不编一条决策)', async () => {
    const seam = createContinuationSeam({ readFacts: async () => null });
    expect(await seam.preflight({ goalId: 'g1', caller: 'supervisor', now: NOW })).toBeNull();
  });
});

describe('§5 注入路径 (旧口径): 只能核验"无进展熔断", 其余如实标注', () => {
  const CAPS = safetyCapsFrom({ maxRetries: 2 }); // 阈值 3
  const mkOut = (over: Record<string, unknown> = {}): any => ({
    goalId: 'g1',
    runnable: false,
    reason: '旧口径的停',
    noProgressStreak: 0,
    decision: { decision: 'ask_human', state: 'needs_decision', nextAction: '问人', requiredCapability: null, decisionId: 'd1' },
    ...over,
  });

  it('自称熔断但数与阈值对不上 → 真拒 (用轮次冒充安全上限)', () => {
    const out = judgeInjectedOutcome(
      mkOut({ noProgressStreak: 1, caps: ['no_progress_breaker'], decision: { decision: 'ask_human', state: 'no_progress', nextAction: 'x', requiredCapability: null, decisionId: 'd1' } }),
      CAPS,
    );
    expect(isRefusal(out)).toBe(true);
    expect((out as any).reason).toContain('noProgressStreak=1 < 阈值 3');
    expect((out as any).reason).toContain('冒充');
  });

  it('负控制: 同一个自称, 数到了阈值 → 认可, 并且归因 cap', () => {
    const out = judgeInjectedOutcome(
      mkOut({ noProgressStreak: 3, caps: ['no_progress_breaker'], decision: { decision: 'ask_human', state: 'no_progress', nextAction: 'x', requiredCapability: null, decisionId: 'd1' } }),
      CAPS,
    );
    expect(isRefusal(out)).toBe(false);
    expect((out as any).basis).toBe('cap');
    expect((out as any).caps).toEqual(['no_progress_breaker']);
    expect((out as any).unattributableStop).toBe(false);
  });

  it('不自称也能从事实核验: state=no_progress 且 streak 到阈值 → cap', () => {
    const out = judgeInjectedOutcome(
      mkOut({ noProgressStreak: 3, decision: { decision: 'ask_human', state: 'no_progress', nextAction: 'x', requiredCapability: null, decisionId: 'd1' } }),
      CAPS,
    );
    expect(isRefusal(out)).toBe(false);
    expect((out as any).basis).toBe('cap');
  });

  it('自称时间/预算上限 (缺事实不可核验) → 不认, 但如实标注; 不假装验过', () => {
    const out = judgeInjectedOutcome(mkOut({ caps: ['goal_budget', 'max_run_duration'] }), CAPS);
    expect(isRefusal(out)).toBe(false);
    expect((out as any).caps).toEqual([]);
    expect((out as any).bindingCap).toBeNull();
    expect((out as any).unattributableStop).toBe(true);
    expect((out as any).reason).toContain('不可核验');
  });

  it('没有任何归因的停 → 标 unattributableStop (不假装是"被上限拦住")', () => {
    const out = judgeInjectedOutcome(mkOut(), CAPS);
    expect((out as any).basis).toBe('human');
    expect((out as any).caps).toEqual([]);
    expect((out as any).unattributableStop).toBe(true);
    expect((out as any).reason).toContain('缺事实');
  });

  it('注入路径说"能跑" → 归因到进展/派遣, 不标不可归因', () => {
    const cont = judgeInjectedOutcome(mkOut({ runnable: true, decision: { decision: 'continue', state: 'progressing', nextAction: 'x', requiredCapability: null, decisionId: 'd1' } }), CAPS);
    expect((cont as any).basis).toBe('progress');
    expect((cont as any).unattributableStop).toBe(false);
    const del = judgeInjectedOutcome(mkOut({ runnable: true, decision: { decision: 'delegate', state: 'waiting_agent', nextAction: 'x', requiredCapability: 'cap', decisionId: 'd1' } }), CAPS);
    expect((del as any).basis).toBe('delegate');
  });

  it('接缝把旧配置降级成上限后再交给注入路径核验 (maxRetries → 阈值)', async () => {
    const stopped = mkOut({
      noProgressStreak: 3,
      caps: ['no_progress_breaker'],
      decision: { decision: 'ask_human', state: 'no_progress', nextAction: '问人', requiredCapability: null, decisionId: 'd1' },
    });
    const seam = createContinuationSeam({ decide: async () => stopped });
    const out = preflightOf(await seam.preflight({ goalId: 'g1', caller: 'supervisor', now: NOW, maxRetries: 2 }));
    expect(out.capsInEffect.noProgressCircuitBreaker).toBe(3);
    expect(out.caps).toEqual(['no_progress_breaker']);
    // 对照: 阈值放到 5 → 同一个 streak=3 就算没到顶 → 真拒 (降级后的上限真的在核验)
    const strict = createContinuationSeam({ decide: async () => stopped });
    const refused = await strict.preflight({ goalId: 'g1', caller: 'supervisor', now: NOW, maxRetries: 4 });
    expect(isRefusal(refused)).toBe(true);
  });
});

// ===========================================================================
// §6. 真跑: 真 Store + 隔离 HOME → 接缝自己 preflight
// ===========================================================================

describe('§6 真跑 (真 Goal/Run Store, 隔离 HOME)', () => {
  it('真事实: 有步骤的 Run → 进展驱动 (basis=progress), 上限不拦; 旧轮次停被推翻', async () => {
    const { gs } = await realMods();
    const g = await gs.createGoal({ objective: '把 A 变成 B', successCriteria: ['A 已变成 B', '有回执'] });
    const runId = await realRun(g.goalId, ['写好了 /tmp/m1-proof']);

    const facts = await factsFromStore(g.goalId, NOW);
    // 期望值从真状态推导: 事实面就是盘上那份
    const onDisk = JSON.parse(await fsp.readFile(path.join(TMP, '.bolloon', 'goals', `${g.goalId}.json`), 'utf8'));
    expect(facts.goal.runs).toEqual(onDisk.runs);
    expect(facts.run.runId).toBe(runId);
    expect(facts.progress.newEvidence.length).toBe(1);   // = 那 1 个成功步骤
    expect(facts.noProgressStreak).toBe(0);              // 有证据 → 不算无进展

    const seam = createContinuationSeam({ readFacts: async () => facts });
    const out = preflightOf(await seam.preflight({ goalId: g.goalId, caller: 'supervisor', now: NOW, maxRounds: 3, maxRetries: 2 }));
    expect(out.source).toBe('facts');
    expect(out.basis).toBe('progress');
    expect(out.runnable).toBe(true);
    expect(out.caps).toEqual([]);
    expect(out.fullDecision.decision).toBe('continue');
    expect(out.capsInEffect.maxGoalBudget).toBe(3);      // 旧 maxRounds=3 被登记成预算上限
    expect(String(out.reason)).toContain(RHYTHM_BASIS_TEXT.progress);
    expect(String(out.reason)).toContain('有可核验进展');

    // ★ 固定轮次降级: 旧口径说"到最大轮次了要停" → 有进展且上限没触顶 → 被推翻
    const plan = planRhythm(facts, { maxRounds: 3, maxRetries: 2 });
    const verdict = judgeLegacyStop({ runnable: false, reason: '已达到最大轮次 3 → needs_human' }, plan);
    expect(verdict.overridden).toBe(true);
    expect(verdict.stop).toBe(false);
  });

  it('真事实: 3 个无证据的 Run → 无进展熔断触顶, 接缝判停且归因正确', async () => {
    const { gs } = await realMods();
    const g = await gs.createGoal({ objective: '没有产出的一串 Run', successCriteria: ['产出证据'] });
    await realRun(g.goalId, []);
    await realRun(g.goalId, []);
    await realRun(g.goalId, []);

    const facts = await factsFromStore(g.goalId, NOW);
    expect(facts.progress.newEvidence).toEqual([]);
    expect(facts.progress.newlyCompletedCriteria).toEqual([]);
    expect(facts.goal.runs.length).toBe(3);
    expect(facts.noProgressStreak).toBe(3);   // = 本轮 + 2 个历史无证据 Run

    const seam = createContinuationSeam({ readFacts: async () => facts });
    const out = preflightOf(await seam.preflight({ goalId: g.goalId, caller: 'supervisor', now: NOW, maxRetries: 2 }));
    expect(out.basis).toBe('cap');
    expect(out.caps).toEqual(['no_progress_breaker']);
    expect(out.bindingCap).toBe('no_progress_breaker');
    expect(out.runnable).toBe(false);
    expect(out.fullDecision.state).toBe('no_progress');

    // 同一条真事实: 阈值放到 4 就不该再停 (归因跟着真值走)
    const looser = preflightOf(await seam.preflight({ goalId: g.goalId, caller: 'supervisor', now: NOW, maxRetries: 3 }));
    expect(looser.caps).toEqual([]);
    expect(looser.basis).toBe('human');
    expect(looser.runnable).toBe(false);
  });

  it('真事实: Goal 自带 budget.maxRuns 到顶 → 预算上限触顶 (与旧配置无关)', async () => {
    const { gs } = await realMods();
    const g = await gs.createGoal({ objective: '预算只有 1 个 Run', successCriteria: ['产出'], budget: { maxRuns: 1 } });
    await realRun(g.goalId, ['第一轮有产出']);

    const facts = await factsFromStore(g.goalId, NOW);
    expect(facts.goal.budget?.maxRuns).toBe(1);
    expect(facts.goal.runs.length).toBe(1);

    const seam = createContinuationSeam({ readFacts: async () => facts });
    const out = preflightOf(await seam.preflight({ goalId: g.goalId, caller: 'supervisor', now: NOW }));
    expect(out.caps).toEqual(['goal_budget']);
    expect(out.basis).toBe('cap');
    expect(out.runnable).toBe(false);
    expect(String(out.reason)).toContain('budget.maxRuns=1');
    expect(String(out.reason)).toContain(SAFETY_CAP_TEXT.goal_budget);
  });

  it('真跑对照: 反复判定同一批真事实 → 结论逐字节相同 (可回放, 不是随机/读钟)', async () => {
    const { gs } = await realMods();
    const g = await gs.createGoal({ objective: '可回放', successCriteria: ['x'] });
    await realRun(g.goalId, ['产出 1']);
    const facts = await factsFromStore(g.goalId, NOW);
    const a = planRhythm(facts, { maxRetries: 2 });
    const b = planRhythm(facts, { maxRetries: 2 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // 并交叉验证: 接缝的判定出口就是 P0 本身 (不是另写一条链)
    expect(a.decision).toEqual(rhythmicDecision(facts, safetyCapsFrom({ maxRetries: 2 })));
    expect(a.decision.decisionId).toBe(decideContinuation({ ...facts, hardLimits: safetyCapsFrom({ maxRetries: 2 }) }).decisionId);
  });

  it('真事实: 无进展且没到阈值 → 不归因上限 (如实说"没有继续的资格")', async () => {
    const { gs } = await realMods();
    const g = await gs.createGoal({ objective: '只跑了一轮没产出', successCriteria: ['产出'] });
    await realRun(g.goalId, []);
    const facts = await factsFromStore(g.goalId, NOW);
    expect(facts.noProgressStreak).toBe(1);

    const seam = createContinuationSeam({ readFacts: async () => facts });
    const out = preflightOf(await seam.preflight({ goalId: g.goalId, caller: 'supervisor', now: NOW, maxRetries: 2 }));
    expect(out.basis).toBe('human');
    expect(out.caps).toEqual([]);
    expect(out.unattributableStop).toBe(false); // 事实路径: 归因是确定的 (确定"不是上限")
    expect(out.runnable).toBe(false);
  });
});
