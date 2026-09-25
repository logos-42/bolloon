/**
 * 门: P0「节奏由进展决定」判定器 (`src/agents/goal-flywheel/continuation-decision.ts`) 的不变式。
 *
 * 这道门要钉住的**不是实现细节**, 而是 `types.ts` §1 与 `goal-continuation-flywheel.md`
 * §4 里那几句硬规则"真的在跑":
 *   ① 判定表**逐条**命中 (每条规则一个用例), 且表覆盖全部 7 种 decision / 8 种 state
 *      —— 不接受"零条目通过"
 *   ② 负控制**成对出现**: 该被拒的用例必须真的被拒, 并且把**同一个字段**换成合规值之后
 *      立刻被判可继续 (对照组证明这些断言不是同义反复)
 *   ③ 主不变量: 有进展才有"继续"的资格 / 完成必须有证据且判据被确认 / 决策与状态自洽 /
 *      硬底线只能收紧 (变异验证就是打这一组)
 *   ④ 完成判定与 `goal-store.ts` 的完成门 `evaluateGoalCompletion` **逐例等价**
 *      (口说"同一口径"不算, 用矩阵跑出来)
 *   ⑤ 源码级: 纯函数 · 无 I/O · 可回放 (零运行期 import / 不读钟 / 不随机 / 无 async)
 *
 * 已声明**不做**的 (如实留白, 不假装覆盖):
 *   - 不测 `Document`/文件落盘/接线: P0 是纯函数, 接线是 P1 单一所有者的事;
 *   - `src/test` 不在 tsconfig 的 include 里, 所以**类型级**约束在这里不会编译报错,
 *     本文件因此只用运行期断言 (与 `goal-flywheel-types.test.ts` 一样靠源级 + 运行期)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  decideContinuation,
  applyHardLimits,
  isRunnable,
  type DecideContinuationInput,
} from '../agents/goal-flywheel/continuation-decision.js';
import {
  CONTINUATION_DECISIONS,
  CONTINUATION_STATES,
  RISK_LEVELS,
  STOP_REASONS,
  type ContinuationDecision,
  type ContinuationDecisionKind,
  type ContinuationState,
  type HardLimits,
  type ProgressDelta,
} from '../agents/goal-flywheel/types.js';
import { evaluateGoalCompletion, type GoalRecord } from '../agents/goal-store.js';
import type { RunRecord, RunStatus } from '../agents/run-store.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW = '2026-09-25T12:00:00.000Z';

function mkGoal(over: Partial<GoalRecord> = {}): GoalRecord {
  return {
    goalId: 'g1',
    objective: '把 bolloon landing 页上线并拿到 3 条真实回执',
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

function mkRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'r1',
    goalId: 'g1',
    surface: 'cli',
    goal: '把 bolloon landing 页上线并拿到 3 条真实回执',
    pid: 4242,
    host: 'test-host',
    // 5 分钟前开始: 刻意**不**触发"单 Run 时间上限"那条硬底线, 让每条用例只命中一条规则
    startedAt: '2026-09-25T11:55:00.000Z',
    updatedAt: NOW,
    status: 'done',
    steps: [{ n: 1, ts: NOW, tool: 'shell', ok: true }],
    budget: { maxSteps: 60, deadlineMs: 1_800_000 },
    recovery: [],
    ...over,
  };
}

function mkProgress(over: Partial<ProgressDelta> = {}): ProgressDelta {
  return { newEvidence: [], newlyCompletedCriteria: [], stepsAdvanced: 0, unresolvedDelta: 0, ...over };
}

const LIMITS: HardLimits = { maxRunDurationMs: 1_800_000, maxGoalBudget: 100, noProgressCircuitBreaker: 3 };

interface Extra {
  now?: string;
  noProgressStreak?: number;
  hardLimits?: HardLimits;
}

function makeInput(
  goalOver: Partial<GoalRecord> = {},
  runOver: Partial<RunRecord> = {},
  progressOver: Partial<ProgressDelta> = {},
  extra: Extra = {},
): DecideContinuationInput {
  return {
    goal: mkGoal(goalOver),
    run: mkRun(runOver),
    now: extra.now ?? NOW,
    progress: mkProgress(progressOver),
    noProgressStreak: extra.noProgressStreak ?? 0,
    hardLimits: extra.hardLimits ?? LIMITS,
  };
}

const decide = (...args: Parameters<typeof makeInput>): ContinuationDecision => decideContinuation(makeInput(...args));

// ---------------------------------------------------------------------------
// 判定表 (每条规则一行; 表本身覆盖全部 decision / state)
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  expect: [ContinuationDecisionKind, ContinuationState];
  input: DecideContinuationInput;
}

const TABLE: Case[] = [
  // ① Goal 已是终态 → 幂等 mirror
  {
    name: '⓪ now 不可解析 → 时间不可信, 交人',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({}, {}, {}, { now: 'yesterday-ish' }),
  },
  {
    name: '① goal 已 completed → complete (幂等 mirror)',
    expect: ['complete', 'completed'],
    input: makeInput({ status: 'completed', completedCriteria: [0, 1], evidence: ['页面 200', '3 条回执'] }),
  },
  {
    name: '① goal 已 failed → fail(objective_unreachable)',
    expect: ['fail', 'failed'],
    input: makeInput({ status: 'failed', resolution: { reason: '域名被占用', at: NOW } }),
  },
  {
    name: '① goal 已 abandoned → fail(out_of_scope)',
    expect: ['fail', 'failed'],
    input: makeInput({ status: 'abandoned' }),
  },

  // ② 判据全满足: 过完成门才 complete
  {
    name: '② 判据全满足 + 证据 + 无未解决项 + Run 干净 → complete',
    expect: ['complete', 'completed'],
    input: makeInput({ completedCriteria: [0, 1], evidence: ['页面 200', '3 条回执'] }),
  },
  {
    name: '② 判据全满足但判据是 agent 提的候选、未经人确认 → 交人 (不许完成)',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({ completedCriteria: [0, 1], evidence: ['x'], criteriaSource: 'agent_proposed', criteriaVersion: 2 }),
  },
  {
    name: '② 判据全满足但一条证据都没有 → 交人 (漂亮但无证据不算完成)',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({ completedCriteria: [0, 1] }),
  },
  {
    name: '② 判据全满足但最近 Run 没跑干净 (failed) → 不完成, 也不自动继续',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({ completedCriteria: [0, 1], evidence: ['x'] }, { status: 'failed' }),
  },
  {
    name: '② 判据全满足但还有未解决项 + 本轮有新证据 → continue (先清未解决项)',
    expect: ['continue', 'progressing'],
    input: makeInput(
      { completedCriteria: [0, 1], evidence: ['x'], unresolvedItems: ['回执还没核验'] },
      {},
      { newEvidence: ['3 条回执已入库待核验'] },
    ),
  },

  // ③ 三类硬底线 (安全线: 命中即必须停)
  {
    name: '③ 本轮超出单 Run 时间上限 → 交人 (压过"有进展")',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({}, {}, { newEvidence: ['x'] }, { hardLimits: { ...LIMITS, maxRunDurationMs: 60_000 } }),
  },
  {
    name: '③ 单 Goal 预算用尽 (budget.maxRuns) → 交人 (blocked)',
    expect: ['ask_human', 'blocked'],
    input: makeInput({ budget: { maxRuns: 1 }, runs: ['r1'] }),
  },
  {
    name: '③ 单 Goal 预算用尽 (budget.deadlineMs) → 交人 (blocked)',
    expect: ['ask_human', 'blocked'],
    input: makeInput({ budget: { deadlineMs: 60_000 } }),
  },
  {
    name: '③ 无进展熔断阈值达到 → 交人 (no_progress)',
    expect: ['ask_human', 'no_progress'],
    input: makeInput({}, {}, {}, { noProgressStreak: 3 }),
  },
  {
    name: '③ 无进展未达熔断阈值 → 交人 (needs_decision, 与熔断的 state 不同)',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({}, {}, {}, { noProgressStreak: 2 }),
  },
  {
    name: '③ 未设熔断阈值 (非法值) 按最严处理: 一轮无进展即熔断',
    expect: ['ask_human', 'no_progress'],
    input: makeInput({}, {}, {}, { noProgressStreak: 1, hardLimits: { ...LIMITS, noProgressCircuitBreaker: 0 } }),
  },

  // ④ Supervisor 已判失速
  {
    name: '④ goal.status=stalled → 交人 (no_progress)',
    expect: ['ask_human', 'no_progress'],
    input: makeInput({ status: 'stalled' }, {}, {}, { noProgressStreak: 1 }),
  },

  // ⑤ 不可恢复的 Run 失败
  {
    name: '⑤ Run 因 auth 失败 → 交人 (blocked: 缺权限)',
    expect: ['ask_human', 'blocked'],
    input: makeInput({}, { status: 'failed', errorClass: 'auth' }),
  },
  {
    name: '⑤ Run 因 policy_denied 失败 → 交人 (blocked)',
    expect: ['ask_human', 'blocked'],
    input: makeInput({}, { status: 'failed', errorClass: 'policy_denied' }),
  },
  {
    name: '⑤ Run 因 repeat_failure 失败 → 交人 (再重试只是重复消耗)',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({}, { status: 'failed', errorClass: 'repeat_failure' }),
  },
  {
    name: '⑤ Run 因 persist_failed 失败 → fail (这次运行在事实层不存在)',
    expect: ['fail', 'failed'],
    input: makeInput({}, { status: 'failed', errorClass: 'persist_failed' }),
  },

  // ⑥ 等外部 / 等时间 / 等子 Agent
  {
    name: '⑥ Run 在等外部 → wait (waiting_external)',
    expect: ['wait', 'waiting_external'],
    input: makeInput({}, { status: 'awaiting_external' }),
  },
  {
    name: '⑥ goal 在 retry_wait (有 wakeAt) → wait (waiting_external)',
    expect: ['wait', 'waiting_external'],
    input: makeInput({
      status: 'retry_wait',
      continuation: { autoContinue: true, wakeReason: 'retry_wait', wakeAt: '2026-09-25T13:00:00.000Z' },
    }),
  },
  {
    name: '⑥ 在等子 Agent 回报 (expectedSource=delegate) → wait (waiting_agent)',
    expect: ['wait', 'waiting_agent'],
    input: makeInput({
      status: 'awaiting_external',
      continuation: {
        autoContinue: true,
        wakeReason: 'awaiting_external',
        external: {
          requestId: 'q1',
          continuationId: 'c1',
          expectedSource: 'delegate',
          createdAt: NOW,
          expiresAt: '2026-09-25T13:00:00.000Z',
        },
      },
    }),
  },

  // ⑦ 人主动暂停
  {
    name: '⑦ goal.status=paused → pause (等人 resume, 不自动决策)',
    expect: ['pause', 'waiting_external'],
    input: makeInput({ status: 'paused' }),
  },

  // ⑧ 目标等人
  {
    name: '⑧ goal.status=needs_human → 交人 (needs_decision)',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({ status: 'needs_human', continuation: { autoContinue: false, needsExternal: '要人确认判据' } }),
  },

  // ⑨ 有可核验进展 → 继续
  {
    name: '⑨ 新增可核验证据 → continue',
    expect: ['continue', 'progressing'],
    input: makeInput({}, {}, { newEvidence: ['run r1 step 1: GET / → 200'], stepsAdvanced: 3 }),
  },
  {
    name: '⑨ 新满足判据 → continue',
    expect: ['continue', 'progressing'],
    input: makeInput({}, {}, { newlyCompletedCriteria: [0] }),
  },

  // ⑩ 缺必需能力 → delegate
  {
    name: '⑩ 无进展 + 目标声明的必需能力未就绪 → delegate',
    expect: ['delegate', 'waiting_agent'],
    input: makeInput({ requiredSkills: ['deploy-landing'] }),
  },
  {
    name: '⑩ 可选技能 (? 前缀) 不算必需能力 → 不许拿它当派遣理由',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({ requiredSkills: ['?optional-nice-to-have'] }),
  },
  {
    name: '⑩ 必需能力已在冻结快照里 → 不是缺能力, 不许 delegate',
    expect: ['ask_human', 'needs_decision'],
    input: makeInput({
      requiredSkills: ['deploy-landing'],
      skillSnapshot: [{ name: 'deploy-landing', version: '1.0.0', contentHash: 'h1', resolvedAt: NOW }],
    }),
  },
];

const RUNS = TABLE.map((c) => ({ name: c.name, input: c.input, d: decideContinuation(c.input) }));

// ---------------------------------------------------------------------------
// ① 判定表逐条命中 + 表覆盖全部 decision / state
// ---------------------------------------------------------------------------

describe('① 判定表: 每条规则都真的在跑 (表本身不许空转)', () => {
  it.each(TABLE.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const d = decideContinuation(c.input);
    expect([d.decision, d.state]).toEqual(c.expect);
  });

  it('表覆盖全部 7 种 decision 与 8 种 state (少一个就是"零条目通过")', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(25);
    const decisions = new Set<string>(TABLE.map((c) => c.expect[0]));
    const states = new Set<string>(TABLE.map((c) => c.expect[1]));
    expect([...decisions].sort()).toEqual([...CONTINUATION_DECISIONS].sort());
    expect([...states].sort()).toEqual([...CONTINUATION_STATES].sort());
    // 表里的用例名不许重复 (重复 = 漏了别的规则)
    expect(new Set(TABLE.map((c) => c.name)).size).toBe(TABLE.length);
  });
});

// ---------------------------------------------------------------------------
// ② 负控制 (成对对照: 同一个字段换成合规值, 判定必须翻转)
// ---------------------------------------------------------------------------

describe('② 负控制: 该被拒的必须真的被拒 (成对对照, 证明不是同义反复)', () => {
  it('"漂亮但无证据": 跑了 5 步、报告很完整, 一条可核验证据也没有 → 不许 continue', () => {
    const steps = [
      { n: 1, ts: NOW, tool: 'shell', ok: true },
      { n: 2, ts: NOW, tool: 'shell', ok: true },
    ];
    const bad = decide({}, { steps }, { stepsAdvanced: 5 });
    expect(bad.decision).toBe('ask_human');
    expect(bad.state).toBe('needs_decision');
    expect(bad.reason).toContain('stepsAdvanced=5');

    // 对照: 只加一条证据, 同一个 Run 立刻拿到"继续"的资格
    const good = decide({}, { steps }, { stepsAdvanced: 5, newEvidence: ['run r1 step 2: HTTP 200'] });
    expect(good.decision).toBe('continue');
    expect(good.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('判据全满足但没有证据 → 不许判完成 (对照: 加一条证据立刻完成)', () => {
    const bad = decide({ completedCriteria: [0, 1] });
    expect(bad.decision).toBe('ask_human');
    expect(bad.decision).not.toBe('complete');
    const good = decide({ completedCriteria: [0, 1], evidence: ['页面 200'] });
    expect(good.decision).toBe('complete');
  });

  it('判据是候选且未确认 → 不许判完成 (对照: 人确认后立刻完成)', () => {
    const over: Partial<GoalRecord> = {
      successCriteria: ['a', 'b', 'c'],
      completedCriteria: [0, 1, 2],
      evidence: ['x'],
      criteriaSource: 'agent_proposed',
    };
    const bad = decide(over);
    expect(bad.decision).toBe('ask_human');
    expect(bad.reason).toContain('未经人确认');
    const good = decide({ ...over, criteriaConfirmed: true });
    expect(good.decision).toBe('complete');
  });

  it('无进展熔断是硬边界: 第 2 轮不熔断, 第 3 轮必须熔断 (且 state 必须不同)', () => {
    const under = decide({}, {}, {}, { noProgressStreak: 2 });
    const at = decide({}, {}, {}, { noProgressStreak: 3 });
    expect(under.decision).toBe('ask_human');
    expect(at.decision).toBe('ask_human');
    expect(under.state).toBe('needs_decision');
    expect(at.state).toBe('no_progress');
  });

  it('硬底线压过进展: 有进展但本轮超时 → 不许自动开下一轮', () => {
    const d = decide({}, {}, { newEvidence: ['x'] }, { hardLimits: { ...LIMITS, maxRunDurationMs: 60_000 } });
    expect(d.decision).toBe('ask_human');
    expect(d.riskLevel).toBe('high');
  });

  it('未设单 Goal 预算上限 → 必须由人显式确认, applyHardLimits 真的会拦', () => {
    const ok = decide({}, {}, { newEvidence: ['x'] });
    expect(ok.decision).toBe('continue');
    expect(isRunnable(ok, NOW).runnable).toBe(true);

    const tight = applyHardLimits(ok, { ...LIMITS, maxGoalBudget: null });
    expect(tight.decision).toBe('ask_human');
    expect(tight.requiredCapability).toBe(null);
    expect(tight.wakeAt).toBe(null);
    expect(isRunnable(tight, NOW).runnable).toBe(false);
  });

  it('伪造一条"没有任何证据的 continue" 必须被 applyHardLimits 拦下', () => {
    const bad: ContinuationDecision = { ...decide({}, {}, { newEvidence: ['x'] }), progressDelta: mkProgress() };
    expect(bad.decision).toBe('continue');
    const tightened = applyHardLimits(bad, LIMITS);
    expect(tightened.decision).toBe('ask_human');
    expect(tightened.reason).toContain('没有新证据/新判据');
  });

  it('delegate 缺 requiredCapability → 不许派遣 (决策不完整)', () => {
    const d = decide({ requiredSkills: ['deploy-landing'] });
    expect(d.decision).toBe('delegate');
    expect(isRunnable(d, NOW).runnable).toBe(true);
    const broken: ContinuationDecision = { ...d, requiredCapability: null };
    const v = isRunnable(broken, NOW);
    expect(v.runnable).toBe(false);
    expect(v.reason).toContain('缺 requiredCapability');
  });

  it('decision 与 state 不自洽 → 不许自动继续', () => {
    const d = decide({}, {}, { newEvidence: ['x'] });
    expect(d.state).toBe('progressing');
    const broken: ContinuationDecision = { ...d, state: 'blocked' };
    const v = isRunnable(broken, NOW);
    expect(v.runnable).toBe(false);
    expect(v.reason).toContain('不自洽');
  });

  it('低信心不是"可以忽略", 是"该问人": 伪造 continue 信心 0.3 → 不自动继续', () => {
    const d: ContinuationDecision = { ...decide({}, {}, { newEvidence: ['x'] }), confidence: 0.3 };
    expect(isRunnable(d, NOW).runnable).toBe(false);
  });

  it('confidence 越界 / now 不可解析 → 决策不可信, 一律不放行', () => {
    const d = decide({}, {}, { newEvidence: ['x'] });
    expect(isRunnable({ ...d, confidence: 1.5 }, NOW).runnable).toBe(false);
    expect(isRunnable({ ...d, confidence: Number.NaN }, NOW).runnable).toBe(false);
    expect(isRunnable(d, 'yesterday-ish').runnable).toBe(false);
  });

  it('wait 的时间闸门: 到点才跑, 未到点 / 只等事件一律不跑', () => {
    const cont = (wakeAt?: string): Partial<GoalRecord> => ({
      status: 'retry_wait',
      continuation: { autoContinue: true, wakeReason: 'retry_wait', ...(wakeAt ? { wakeAt } : {}) },
    });
    const due = decide(cont('2026-09-25T11:30:00.000Z'));
    expect(due.decision).toBe('wait');
    expect(isRunnable(due, NOW)).toEqual({ runnable: true, reason: expect.stringContaining('唤醒时间已到') });

    const notYet = decide(cont('2026-09-25T13:00:00.000Z'));
    expect(isRunnable(notYet, NOW).runnable).toBe(false);

    const event = decide({}, { status: 'awaiting_external' });
    expect(event.wakeAt).toBe(null);
    expect(isRunnable(event, NOW).runnable).toBe(false);
  });

  it('终态 / 等人一律不放行: complete / fail / pause / ask_human 都 runnable=false', () => {
    for (const { name, d } of RUNS) {
      if (['complete', 'fail', 'pause', 'ask_human'].includes(d.decision)) {
        const v = isRunnable(d, NOW);
        expect(v.runnable, `${name} 不该被放行`).toBe(false);
        expect(v.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ③ 主不变量 (变异验证就是打这一组)
// ---------------------------------------------------------------------------

describe('③ 主不变量 (故意改坏实现, 这组必须判红)', () => {
  /** 契约对: decision ↔ 允许自洽出现的 state (测试**独立复述**一遍, 不是读实现里的表) */
  const CONTRACT: Record<string, ContinuationState[]> = {
    continue: ['progressing'],
    wait: ['waiting_external', 'waiting_agent'],
    delegate: ['waiting_agent'],
    ask_human: ['needs_decision', 'no_progress', 'blocked'],
    complete: ['completed'],
    fail: ['failed'],
    pause: ['waiting_external'],
  };

  it('每条决策的 (decision, state) 都在契约对内', () => {
    for (const { name, d } of RUNS) {
      expect(CONTRACT[d.decision], name).toContain(d.state);
    }
  });

  it('continue ⇒ 本轮真有可核验进展 (没有任何证据的决策不许叫 continue)', () => {
    const cont = RUNS.filter((r) => r.d.decision === 'continue');
    expect(cont.length).toBeGreaterThan(0);
    for (const { name, d } of cont) {
      const has = d.progressDelta.newEvidence.length > 0 || d.progressDelta.newlyCompletedCriteria.length > 0;
      expect(has, name).toBe(true);
    }
  });

  it('complete ⇒ 有证据 + 无未解决项 (镜像已完成的 Goal 除外, 它只是复述事实)', () => {
    const done = RUNS.filter((r) => r.d.decision === 'complete');
    expect(done.length).toBeGreaterThan(1);
    for (const { name, d, input } of done) {
      if (input.goal.status === 'completed') continue; // 幂等 mirror: 只复述已经成立的终态
      expect(d.evidenceRefs.length, name).toBeGreaterThan(0);
      expect(d.unresolvedItems, name).toEqual([]);
    }
  });

  it('fail ⇒ 必须交出 stopReason, 且必须是冻结的 STOP_REASONS 之一', () => {
    const fails = RUNS.filter((r) => r.d.decision === 'fail');
    expect(fails.length).toBeGreaterThan(0);
    for (const { name, d } of fails) {
      expect(d.stopReason, name).not.toBe(null);
      expect(STOP_REASONS as readonly string[]).toContain(String(d.stopReason));
    }
  });

  it('stopReason 只在 fail 时出现 (其余决策必须 null)', () => {
    for (const { name, d } of RUNS) {
      if (d.decision !== 'fail') expect(d.stopReason, name).toBe(null);
    }
  });

  it('confidence ∈ [0,1]; continue / delegate 必须 ≥ 0.5 (低信心该问人, 不该自动跑)', () => {
    for (const { name, d } of RUNS) {
      expect(d.confidence, name).toBeGreaterThanOrEqual(0);
      expect(d.confidence, name).toBeLessThanOrEqual(1);
      if (d.decision === 'continue' || d.decision === 'delegate') {
        expect(d.confidence, name).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('riskLevel 只在冻结的 RISK_LEVELS 里', () => {
    for (const { name, d } of RUNS) expect(RISK_LEVELS as readonly string[], name).toContain(d.riskLevel);
  });

  it('未解决项变多 (unresolvedDelta>0) 抬一级风险', () => {
    const flat = decide({}, {}, { newEvidence: ['x'], unresolvedDelta: 0 });
    const worse = decide({}, {}, { newEvidence: ['x'], unresolvedDelta: 2 });
    expect(worse.riskLevel).toBe('high');
    expect(RISK_LEVELS.indexOf(worse.riskLevel)).toBeGreaterThan(RISK_LEVELS.indexOf(flat.riskLevel));
  });

  it('文案不许糊弄: nextAction / expectedOutcome / reason 都非空, 且不许写"继续推进"', () => {
    for (const { name, d } of RUNS) {
      expect(d.nextAction.trim().length, name).toBeGreaterThan(0);
      expect(d.expectedOutcome.trim().length, name).toBeGreaterThan(0);
      expect(d.reason.trim().length, name).toBeGreaterThan(0);
      expect(d.expectedOutcome, name).not.toContain('继续推进');
    }
  });

  it('可回放: 同一输入两次 → 逐字节相同; decisionId 由 (goalId, runId) 派生', () => {
    for (const { name, input, d } of RUNS) {
      expect(JSON.stringify(decideContinuation(input)), name).toBe(JSON.stringify(d));
      expect(d.decisionId).toBe(`decision:${d.goalId}:${d.runId}`);
      expect(d.decidedAt).toBe(input.now);
      expect(d.goalId).toBe(input.goal.goalId);
      expect(d.runId).toBe(input.run.runId);
    }
  });

  it('applyHardLimits 只收紧: 非自治原样返回; 自治只会被降级为 ask_human; 风险只升不降', () => {
    const variants: HardLimits[] = [
      LIMITS,
      { ...LIMITS, maxGoalBudget: null },
      { ...LIMITS, maxGoalBudget: -1 },
      { ...LIMITS, maxRunDurationMs: 0 },
      { ...LIMITS, noProgressCircuitBreaker: 0 },
      { ...LIMITS, noProgressCircuitBreaker: 2.5 },
    ];
    let checked = 0;
    for (const { name, d } of RUNS) {
      for (const limits of variants) {
        const out = applyHardLimits(d, limits);
        if (d.decision === 'continue' || d.decision === 'delegate') {
          expect(['ask_human', d.decision], name).toContain(out.decision);
        } else {
          expect(out, name).toBe(d); // 非自治决策: 同一引用, 一个字段都不许动
        }
        expect(RISK_LEVELS.indexOf(out.riskLevel), name).toBeGreaterThanOrEqual(RISK_LEVELS.indexOf(d.riskLevel));
        checked++;
      }
    }
    expect(checked).toBe(RUNS.length * variants.length); // 断言数不为零
  });

  it('硬底线合法时 applyHardLimits 是恒等 (不偷偷改决策)', () => {
    for (const { name, d } of RUNS) expect(applyHardLimits(d, LIMITS), name).toBe(d);
  });
});

// ---------------------------------------------------------------------------
// ④ 与 goal-store 完成门逐例等价
// ---------------------------------------------------------------------------

describe('④ 与 goal-store 的完成门逐例等价 (口说"同一口径"不算)', () => {
  it('progress 为空时: decision=complete ⟺ evaluateGoalCompletion().complete', () => {
    const goals: Partial<GoalRecord>[] = [
      {},
      { successCriteria: ['a'], completedCriteria: [0], evidence: ['e'] },
      { successCriteria: ['a'], completedCriteria: [0] },
      { successCriteria: ['a'], completedCriteria: [0], evidence: ['e'], unresolvedItems: ['x'] },
      { successCriteria: ['a', 'b'], completedCriteria: [0], evidence: ['e'] },
      { successCriteria: ['a'], completedCriteria: [0], evidence: ['e'], criteriaConfirmed: false },
      { successCriteria: ['a'], completedCriteria: [0], evidence: ['e'], criteriaSource: 'agent_proposed' },
      { successCriteria: ['a'], completedCriteria: [0], evidence: ['e'], criteriaSource: 'agent_proposed', criteriaConfirmed: true },
      { successCriteria: ['a', 'b', 'c'], completedCriteria: [0, 1, 2], evidence: ['e1', 'e2'] },
    ];
    const runStatuses: RunStatus[] = ['done', 'failed', 'interrupted', 'stalled', 'running'];
    let agreed = 0;
    let completeCount = 0;
    for (const g of goals) {
      for (const status of runStatuses) {
        const input = makeInput(g, { status });
        const d = decideContinuation(input);
        const gate = evaluateGoalCompletion(input.goal, { lastRunStatus: status }).complete;
        expect(d.decision === 'complete', `${JSON.stringify(g)} / ${status}`).toBe(gate);
        if (gate) completeCount++;
        agreed++;
      }
    }
    expect(agreed).toBe(goals.length * runStatuses.length);
    // 矩阵里必须**两种答案都有** (否则"等价"是拿 0 命中混过去的)
    expect(completeCount).toBeGreaterThan(0);
    expect(completeCount).toBeLessThan(agreed);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 源码级: 纯函数 / 无 I/O / 可回放
// ---------------------------------------------------------------------------

const SRC_REL = 'src/agents/goal-flywheel/continuation-decision.ts';
const src = fs.readFileSync(path.join(process.cwd(), SRC_REL), 'utf8');

/** 去掉注释后再查: 注释里提到 `Date.now` 是**文档**, 不是用法 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('⑤ 纯函数 / 无 I/O / 可回放 (源码级)', () => {
  const code = stripComments(src);

  it('零运行期 import: 全是 `import type` (阶段间只通过类型耦合, 运行期零依赖)', () => {
    const imports = src.split('\n').filter((l) => /^import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/^import type /);
    expect(code).not.toMatch(/require\(/);
  });

  it('只从 goal-store / run-store / types 取类型 (不 import 任何别的阶段的实现文件)', () => {
    const froms = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(froms).toEqual(['../goal-store.js', '../run-store.js', './types.js'].sort());
  });

  it('不读钟 / 不随机 / 不做 I/O / 无 async (否则就不可回放)', () => {
    const forbidden: [string, RegExp][] = [
      ['Date.now', /\bDate\.now\b/],
      ['new Date', /\bnew Date\b/],
      ['Math.random', /\bMath\.random\b/],
      ['randomUUID', /randomUUID/],
      ['node:fs', /\bnode:fs\b/],
      ["from 'fs", /\bfrom '(node:)?fs/],
      ['process.env', /\bprocess\.env\b/],
      ['await', /\bawait\b/],
      ['async', /\basync\b/],
    ];
    for (const [label, re] of forbidden) expect(code, `实现里不许出现 ${label}`).not.toMatch(re);
  });

  it('源级检查器自己有阴性对照 (代码里写 Date.now 必须抓得住; 只在注释里出现不算)', () => {
    expect(stripComments('const t = Date.now();')).toMatch(/\bDate\.now\b/);
    expect(stripComments('/* Date.now 只出现在注释里 */\nexport function f() { return 1; }')).not.toMatch(/\bDate\.now\b/);
    // 真实源码里这几个名字**确实**出现过 (在文档注释里) → 证明"去注释"这一步不是空转
    expect(src).toMatch(/\bDate\.now\b/);
    expect(src).toMatch(/\bMath\.random\b/);
    expect(code).not.toMatch(/\bMath\.random\b/);
  });

  it('只导出 §14 冻结的三个函数 (+ 一个入参 interface)', () => {
    const exports = [...src.matchAll(/^export (function|const|type|interface) ([A-Za-z0-9_]+)/gm)].map((m) => m[2]);
    expect(exports.sort()).toEqual(['DecideContinuationInput', 'applyHardLimits', 'decideContinuation', 'isRunnable'].sort());
  });

  it('三个函数签名与 §14 逐字一致', () => {
    expect(src).toMatch(/export function decideContinuation\(input: DecideContinuationInput\): ContinuationDecision/);
    expect(src).toMatch(/export function applyHardLimits\(d: ContinuationDecision, limits: HardLimits\): ContinuationDecision/);
    expect(src).toMatch(
      /export function isRunnable\(d: ContinuationDecision, now: IsoTimestamp\): \{ runnable: boolean; reason: string \}/,
    );
  });
});
