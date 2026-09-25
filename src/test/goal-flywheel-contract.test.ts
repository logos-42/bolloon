/**
 * 门: P2 「子 Agent 工作合同」(`src/agents/goal-flywheel/work-contract.ts`) 的**行为**不变式。
 *
 * 与 `goal-flywheel-types.test.ts` (纯类型冻结门) 分工: 那份钉接口形状, 这份钉**判定是不是真的对**。
 * 本文件只碰 P2 自己的文件 (所有权划分见 `docs/wiki/goal-continuation-flywheel.md` §13),
 * 不 import 任何其它阶段的实现, 也不碰冻结面 (`types.ts` / `index.ts`)。
 *
 * 强负例 (设计 §10 第 7 条): 子 Agent 返回**漂亮但无证据**的结果 → 父 **不**接受为完成。
 *
 * 阴性对照 (怎么知道这道门不是空转的):
 *   ① 把 `detectViolation` 里的 `evidenceEmpty` 删掉 → 「无证据报完成」不再判 `mark_unverified_as_complete` (本品判红);
 *   ② 把 `validateChildReport` 里的 `missingEvidence` 恒置 `[]` → 「判据缺证据」三条用例立刻判红;
 *   ③ 把 `issueWorkContract` 里的 `successCriteria` 校验删掉 → 负控制组里「空判据必须拒签」判红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  WorkContractError,
  acceptsAsComplete,
  criterionRef,
  DEFAULT_CANCEL_POLICY,
  DEFAULT_FAILURE_POLICY,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_INTERVAL_MS,
  NOT_CHECKABLE_FROM_REPORT,
  REPORT_CHECKABLE_PROHIBITIONS,
  validateChildReport,
  WORK_REPORT_SCHEMA,
  issueWorkContract,
} from '../agents/goal-flywheel/work-contract.js';

import { CHILD_PROHIBITIONS } from '../agents/goal-flywheel/types.js';
import type {
  AgentWorkContract,
  AgentWorkReport,
  BlockRecord,
  ChildProhibition,
  WorkBudget,
  WorkCheck,
  WorkEvidence,
} from '../agents/goal-flywheel/types.js';

// ---------------------------------------------------------------------------
// 夹具 (全部时间/预算显式注入 —— 本模块不读真实钟)
// ---------------------------------------------------------------------------

const NOW = '2026-09-25T10:00:00.000Z';
const DEADLINE = '2026-09-25T11:00:00.000Z';

function budget(over: Partial<WorkBudget> = {}): WorkBudget {
  return { maxSteps: 20, maxDurationMs: 600_000, maxAmount: null, currency: null, ...over };
}

type IssueInput = Parameters<typeof issueWorkContract>[0];

function issueInput(over: Partial<IssueInput> = {}): IssueInput {
  return {
    goalId: 'goal-1',
    parentRunId: 'run-1',
    childAgentId: 'child-a',
    capability: 'code_edit',
    objective: '把 src/x.ts 的返回值改成 Y',
    inputs: { file: 'src/x.ts', nested: { depth: 1 } },
    allowedTools: ['read_file', 'edit_file'],
    budget: budget(),
    deadline: DEADLINE,
    successCriteria: ['改动已落盘', '测试通过'],
    now: NOW,
    issuedBy: 'parent-run-1',
    ...over,
  };
}

function makeContract(over: Partial<IssueInput> = {}): AgentWorkContract {
  return issueWorkContract(issueInput(over));
}

/** 拒签探针: 返回 null = 居然签成了 (负控制里这就是失败) */
function issueOrFail(over: Partial<IssueInput> = {}): WorkContractError | null {
  try {
    issueWorkContract(issueInput(over));
    return null;
  } catch (e) {
    return e as WorkContractError;
  }
}

function evidenceFor(c: AgentWorkContract): WorkEvidence[] {
  return c.successCriteria.map((x) => ({ kind: criterionRef(x), ref: `evidence:${x}`, note: null }));
}

function checksAllPass(c: AgentWorkContract): WorkCheck[] {
  return c.successCriteria.map((x) => ({ name: criterionRef(x), verdict: 'pass', detail: '已核验' }));
}

function blockRecord(c: AgentWorkContract): BlockRecord {
  return {
    blockId: 'block-1',
    kind: 'permission_blocked',
    goalId: c.goalId,
    runId: c.parentRunId,
    workId: c.workId,
    childAgentId: c.childAgentId,
    blockedAt: '2026-09-25T10:05:00.000Z',
    lastProgressAt: '2026-09-25T10:04:00.000Z',
    owner: 'parent',
    dependency: '需要写权限',
    suggestedAction: 'escalate_parent',
    escalationAt: '2026-09-25T10:15:00.000Z',
    resolvedAt: null,
    resolution: null,
    note: '写 .env 需要用户批准',
  };
}

function report(c: AgentWorkContract, over: Partial<AgentWorkReport> = {}): AgentWorkReport {
  return {
    workId: c.workId,
    childAgentId: c.childAgentId,
    status: 'completed',
    summary: '按合同做完了',
    evidence: evidenceFor(c),
    artifacts: [{ name: 'patch', path: 'src/x.ts', hash: 'deadbeef', cid: null, bytes: 120 }],
    checks: checksAllPass(c),
    unresolvedItems: [],
    blockReason: null,
    nextRecommendation: '可以直接并入',
    durationMs: 1_000,
    reportedAt: '2026-09-25T10:10:00.000Z',
    ...over,
  };
}

/** 测试自己用的深冻结 (用来钉"核验不改输入") */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v as Record<string, unknown>)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ---------------------------------------------------------------------------
// ① 签发合同
// ---------------------------------------------------------------------------

describe('① 签发合同: 字段完备 / 可复现 / 不可改', () => {
  it('字段集与设计 §7 的合同清单一致 (不多不少)', () => {
    const c = makeContract();
    expect(Object.keys(c).sort()).toEqual([
      'allowedTools', 'budget', 'cancelPolicy', 'capability', 'childAgentId', 'deadline', 'failurePolicy',
      'goalId', 'heartbeatIntervalMs', 'inputs', 'issuedAt', 'issuedBy', 'objective', 'parentRunId',
      'reportSchema', 'requiredEvidence', 'successCriteria', 'workId',
    ]);
    expect(c.reportSchema).toBe(WORK_REPORT_SCHEMA);
    expect(c.issuedAt).toBe(NOW);
    expect(c.goalId).toBe('goal-1');
    expect(c.parentRunId).toBe('run-1');
    expect(c.capability).toBe('code_edit');
    expect(c.deadline).toBe(DEADLINE);
  });

  it('目标逐字保留, 判据去重但保序', () => {
    const c = makeContract({
      objective: '  只把 src/x.ts 的返回值改成 Y (别的都不要动)  ',
      successCriteria: ['改动已落盘', '测试通过', '改动已落盘'],
    });
    expect(c.objective).toBe('  只把 src/x.ts 的返回值改成 Y (别的都不要动)  ');
    expect(c.successCriteria).toEqual(['改动已落盘', '测试通过']);
  });

  it('每条判据一条证据要求 (写进合同, 子不用猜要交什么)', () => {
    const c = makeContract();
    expect(c.requiredEvidence).toEqual([criterionRef('改动已落盘'), criterionRef('测试通过')]);
    expect(c.requiredEvidence.every((r) => r.startsWith('criterion:'))).toBe(true);
  });

  it('workId 可复现 (同输入同 id), 且随目标/执行者变化', () => {
    const a = makeContract();
    const b = makeContract();
    expect(a.workId).toBe(b.workId);
    expect(a.workId).toMatch(/^work-[0-9a-f]{16}$/);
    expect(makeContract({ objective: '换个目标' }).workId).not.toBe(a.workId);
    expect(makeContract({ childAgentId: 'child-b' }).workId).not.toBe(a.workId);
    expect(makeContract({ now: '2026-09-25T10:00:01.000Z' }).workId).not.toBe(a.workId);
  });

  it('inputs 是独立副本: 冻结的是合同里的那份, 不动调用方的对象', () => {
    const inputs = { file: 'src/x.ts', nested: { depth: 1 } };
    const c = makeContract({ inputs });
    expect(c.inputs).not.toBe(inputs);
    expect(c.inputs).toEqual(inputs);
    expect(Object.isFrozen(inputs)).toBe(false); // 调用方的对象不受影响
    expect(Object.isFrozen((inputs as { nested: unknown }).nested)).toBe(false);
    expect(Object.isFrozen(c.inputs)).toBe(true);
    expect(Object.isFrozen((c.inputs as { nested: unknown }).nested)).toBe(true); // 深冻结
  });

  it('合同整体深冻结: 子改不了判据 / 预算 / 策略 / 工具白名单', () => {
    const c = makeContract();
    for (const v of [c, c.successCriteria, c.allowedTools, c.requiredEvidence, c.budget, c.failurePolicy, c.cancelPolicy, c.inputs]) {
      expect(Object.isFrozen(v)).toBe(true);
    }
    expect(() => { (c as unknown as { objective: string }).objective = '偷改目标'; }).toThrow();
    expect(() => { (c.successCriteria as string[]).push('偷加判据'); }).toThrow();
    expect(() => { (c.budget as WorkBudget).maxSteps = 999; }).toThrow();
    expect(() => { (c.failurePolicy as { onToolDenied: string }).onToolDenied = 'replan_within_contract'; }).toThrow();
  });

  it('默认失败/取消策略与设计一致 (工具被拒只许报告, 不许自动绕过 Harness)', () => {
    const c = makeContract();
    expect(c.failurePolicy).toEqual({
      onHeartbeatMiss: 'stall',
      onBudgetExhausted: 'stop_and_report',
      onToolDenied: 'report',
      onRepeatedFailure: 'escalate',
    });
    expect(c.failurePolicy).toEqual({ ...DEFAULT_FAILURE_POLICY });
    expect(c.cancelPolicy).toEqual({ ...DEFAULT_CANCEL_POLICY });
    expect(c.cancelPolicy.preserveArtifacts).toBe(true); // 取消不销毁工件
  });

  it('预算原样进合同 (null = 未设上限, 不许被悄悄填成 0)', () => {
    const c = makeContract({ budget: budget({ maxSteps: null, maxDurationMs: null }) });
    expect(c.budget.maxSteps).toBeNull();
    expect(c.budget.maxDurationMs).toBeNull();
    expect(c.budget.maxAmount).toBeNull();
    expect(c.budget.currency).toBeNull();
  });

  it.each([
    { name: '没期限没预算约束 → 默认 30s', b: budget({ maxDurationMs: null }), dl: null, want: DEFAULT_HEARTBEAT_INTERVAL_MS },
    { name: '预算只有 12s → 收紧到下限 5s', b: budget({ maxDurationMs: 12_000 }), dl: null, want: MIN_HEARTBEAT_INTERVAL_MS },
    { name: '预算 120s → 120s/6 = 20s', b: budget({ maxDurationMs: 120_000 }), dl: null, want: 20_000 },
    { name: '预算 1 小时 → 不超过默认 30s', b: budget({ maxDurationMs: 3_600_000 }), dl: null, want: DEFAULT_HEARTBEAT_INTERVAL_MS },
    { name: 'deadline 只剩 9s → 收紧到下限 5s', b: budget({ maxDurationMs: null }), dl: '2026-09-25T10:00:09.000Z', want: MIN_HEARTBEAT_INTERVAL_MS },
    { name: 'deadline 还有 2 分钟 → 仍是默认 30s', b: budget({ maxDurationMs: null }), dl: '2026-09-25T10:02:00.000Z', want: DEFAULT_HEARTBEAT_INTERVAL_MS },
  ])('心跳间隔: $name', ({ b, dl, want }) => {
    const c = makeContract({ budget: b, deadline: dl });
    expect(c.heartbeatIntervalMs).toBe(want);
    expect(c.heartbeatIntervalMs).toBeGreaterThanOrEqual(MIN_HEARTBEAT_INTERVAL_MS);
    expect(c.heartbeatIntervalMs).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_MS);
  });

  it('门自身非空转: 合法输入必须签得成', () => {
    expect(issueOrFail()).toBeNull();
    expect(makeContract().workId.length).toBeGreaterThan(0);
  });
});

describe('① 签发合同 — 负控制: 不合法的合同必须**拒签**', () => {
  it.each([
    { name: '目标为空', over: { objective: '   ' }, point: 'objective' },
    { name: '能力为空', over: { capability: '' }, point: 'capability' },
    { name: '子执行者为空', over: { childAgentId: '' }, point: 'childAgentId' },
    { name: '没有成功判据', over: { successCriteria: [] }, point: 'successCriteria' },
    { name: '判据里有空条目', over: { successCriteria: ['改动已落盘', ' '] }, point: 'successCriteria' },
    { name: 'deadline 早于签发时间', over: { deadline: '2026-09-25T09:00:00.000Z' }, point: 'deadline' },
    { name: 'deadline 不是时间戳', over: { deadline: '明天' }, point: 'deadline' },
    { name: '金额有值但没币种', over: { budget: budget({ maxAmount: 100 }) }, point: 'currency' },
    { name: '预算上限是 0 / 负数', over: { budget: budget({ maxSteps: 0 }) }, point: 'maxSteps' },
    { name: 'maxSteps 不是整数', over: { budget: budget({ maxSteps: 2.5 }) }, point: 'maxSteps' },
    { name: 'inputs 不是对象', over: { inputs: undefined as unknown as Record<string, unknown> }, point: 'inputs' },
    { name: 'now 不是时间戳', over: { now: 'now' }, point: 'now' },
  ])('$name → 抛 WorkContractError 并点名 $point', ({ over, point }) => {
    const err = issueOrFail(over);
    expect(err).toBeInstanceOf(WorkContractError);
    expect(err).not.toBeNull();
    expect((err as WorkContractError).issues.length).toBeGreaterThan(0);
    expect((err as WorkContractError).issues.join(' | ')).toContain(point);
    expect((err as WorkContractError).name).toBe('WorkContractError');
  });

  it('拒签错误是结构化原因清单, 不是一句人话', () => {
    const err = issueOrFail({ objective: '', successCriteria: [] });
    expect(err!.issues).toEqual([
      'objective 为空/缺失 (合同必须有明确的 objective)',
      'successCriteria 为空 (没有成功判据 = 没有"完成"的定义, 这种合同一定会扯皮)',
    ]);
  });

  it('空 allowedTools 是合法的 (无工具授权), 但不许出现空字符串脏数据', () => {
    expect(makeContract({ allowedTools: [] }).allowedTools).toEqual([]);
    expect(issueOrFail({ allowedTools: ['read_file', ' '] })!.issues.join(' ')).toContain('allowedTools');
  });
});

// ---------------------------------------------------------------------------
// ② 核验回报
// ---------------------------------------------------------------------------

describe('② 核验回报: 合格报告全绿', () => {
  it('合格完成报告 → ok=true, 三个桶全空', () => {
    const c = makeContract();
    const v = validateChildReport(c, report(c));
    expect(v).toEqual({ ok: true, missingFields: [], missingEvidence: [], violation: null });
  });

  it('非完成状态 (blocked) 允许判据未满足, 但要有结构化阻塞记录与至少一条证据', () => {
    const c = makeContract();
    const blocked = report(c, {
      status: 'blocked',
      evidence: [{ kind: 'log', ref: 'run-log#42', note: '写权限被拒' }],
      checks: [{ name: criterionRef(c.successCriteria[0]), verdict: 'pass', detail: '第一条已验' }],
      blockReason: blockRecord(c),
      unresolvedItems: [c.successCriteria[1]],
    });
    const v = validateChildReport(c, blocked);
    expect(v.ok).toBe(true);
    expect(v.missingEvidence).toEqual([]); // 被卡住不逼自证 (假证据比没证据更坏)
    expect(acceptsAsComplete(c, blocked).accepted).toBe(false); // 但仍不算完成
    // 只有"一条证据都没有"才叫不完整
    expect(validateChildReport(c, { ...blocked, evidence: [] }).missingFields).toEqual(['evidence']);
  });
});

describe('② 核验回报 — 负控制: 不完整的报告必须被判不完整', () => {
  it('漂亮但无证据 → 缺 evidence/checks 且判越界 mark_unverified_as_complete', () => {
    const c = makeContract();
    const pretty = report(c, {
      evidence: [],
      checks: [],
      summary: '全流程已经跑通, 结果非常好, 请放心采用。',
    });
    const v = validateChildReport(c, pretty);
    expect(v.ok).toBe(false);
    expect(v.missingFields).toEqual(['evidence', 'checks']);
    expect(v.violation).toBe('mark_unverified_as_complete');
    expect(acceptsAsComplete(c, pretty).accepted).toBe(false);
  });

  it('回报的 workId / childAgentId 与合同不一致 → 点名这两个字段', () => {
    const c = makeContract();
    const v = validateChildReport(c, report(c, { workId: 'work-0000000000000000', childAgentId: 'child-z' }));
    expect(v.ok).toBe(false);
    expect(v.missingFields).toEqual(['workId', 'childAgentId']);
  });

  it('只回一段文本 (string) → 结构全缺, 不崩', () => {
    const c = makeContract();
    const v = validateChildReport(c, '我干完了, 很顺利' as unknown as AgentWorkReport);
    expect(v.ok).toBe(false);
    expect(v.missingFields).toEqual([
      'workId', 'childAgentId', 'status', 'summary', 'evidence', 'artifacts', 'checks',
      'unresolvedItems', 'nextRecommendation', 'durationMs', 'reportedAt',
    ]);
    expect(v.missingEvidence).toEqual([]); // 连 status 都没有 → 不按"自称完成"算
  });

  it('被阻塞但阻塞记录是 null / 是空壳 → 点名 blockReason (不许写成一句"有问题")', () => {
    const c = makeContract();
    const nullBlock = report(c, { status: 'blocked', blockReason: null });
    expect(validateChildReport(c, nullBlock).missingFields).toContain('blockReason');
    const vague = report(c, { status: 'blocked', blockReason: { note: '有问题' } as unknown as BlockRecord });
    expect(validateChildReport(c, vague).missingFields).toEqual(['blockReason']);
    const emptyNote = report(c, { status: 'blocked', blockReason: { ...blockRecord(c), note: '' } });
    expect(validateChildReport(c, emptyNote).ok).toBe(false);
  });

  it('形容词不是证据: 证据没写到判据名下 → 逐条点名 missingEvidence', () => {
    const c = makeContract();
    const vague = report(c, {
      evidence: [{ kind: 'note', ref: '看起来没问题', note: '我很有信心' }],
      checks: checksAllPass(c),
    });
    const v = validateChildReport(c, vague);
    expect(v.ok).toBe(false);
    expect(v.missingEvidence).toEqual([criterionRef('改动已落盘'), criterionRef('测试通过')]);
    expect(v.violation).toBe('mark_unverified_as_complete');
    expect(acceptsAsComplete(c, vague).accepted).toBe(false);
  });

  it('只交了第一条判据的证据 → missingEvidence 点名第二条', () => {
    const c = makeContract();
    const partialEvidence = report(c, {
      evidence: [{ kind: criterionRef('改动已落盘'), ref: 'diff#1', note: null }],
    });
    const v = validateChildReport(c, partialEvidence);
    expect(v.missingEvidence).toEqual([criterionRef('测试通过')]);
    expect(v.violation).toBe('mark_unverified_as_complete');
  });

  it('判据检查是 fail / unknown → 不许当完成', () => {
    const c = makeContract();
    const failing = report(c, {
      checks: [
        { name: criterionRef('改动已落盘'), verdict: 'pass', detail: 'ok' },
        { name: criterionRef('测试通过'), verdict: 'fail', detail: '3 个用例红了' },
      ],
    });
    expect(validateChildReport(c, failing).violation).toBe('mark_unverified_as_complete');
    expect(acceptsAsComplete(c, failing).accepted).toBe(false);
    const unknown = report(c, {
      checks: [
        { name: criterionRef('改动已落盘'), verdict: 'pass', detail: 'ok' },
        { name: criterionRef('测试通过'), verdict: 'unknown', detail: '没跑成' },
      ],
    });
    expect(validateChildReport(c, unknown).violation).toBe('mark_unverified_as_complete');
  });

  it('自称完成但还留着未解决项 → 越界 mark_unverified_as_complete', () => {
    const c = makeContract();
    const v = validateChildReport(c, report(c, { unresolvedItems: ['还有一个边界没处理'] }));
    expect(v.ok).toBe(false);
    expect(v.violation).toBe('mark_unverified_as_complete');
  });
});

describe('② 核验回报 — 越界判定', () => {
  it('耗时超合同预算 → expand_own_budget', () => {
    const c = makeContract({ budget: budget({ maxDurationMs: 60_000 }) });
    const over = report(c, { durationMs: 61_000 });
    const v = validateChildReport(c, over);
    expect(v.violation).toBe('expand_own_budget');
    expect(v.ok).toBe(false);
    expect(acceptsAsComplete(c, over).reason).toContain('expand_own_budget');
    // 刚好卡在上限不算越界
    expect(validateChildReport(c, report(c, { durationMs: 60_000 })).violation).toBeNull();
  });

  it('给合同里没有的判据打勾 → rewrite_success_criteria (私改成功判据)', () => {
    const c = makeContract();
    const privateCriteria = report(c, {
      checks: [...checksAllPass(c), { name: criterionRef('我自己加的判据'), verdict: 'pass', detail: '我自己验的' }],
    });
    const v = validateChildReport(c, privateCriteria);
    expect(v.violation).toBe('rewrite_success_criteria');
    // 非 criterion: 前缀的检查名不算私改判据 (那只是普通检查)
    const extraCheck = report(c, {
      checks: [...checksAllPass(c), { name: 'lint 通过', verdict: 'pass', detail: 'ok' }],
    });
    expect(validateChildReport(c, extraCheck).violation).toBeNull();
  });

  it('多条命中时按 CHILD_PROHIBITIONS 声明顺序取第一条 (可复现)', () => {
    const c = makeContract({ budget: budget({ maxDurationMs: 60_000 }) });
    const both = report(c, {
      durationMs: 999_999,
      checks: [...checksAllPass(c), { name: criterionRef('我自己加的判据'), verdict: 'pass', detail: 'x' }],
    });
    expect(validateChildReport(c, both).violation).toBe('expand_own_budget');
  });

  it('报告里没有字段可查的两条禁则, 本模块不假装能查 (声明完备)', () => {
    const union = [...REPORT_CHECKABLE_PROHIBITIONS, ...NOT_CHECKABLE_FROM_REPORT];
    expect(new Set(union).size).toBe(union.length); // 两组不重叠
    expect([...union].sort()).toEqual([...CHILD_PROHIBITIONS].sort()); // 不多不少地覆盖全部禁则
    expect(REPORT_CHECKABLE_PROHIBITIONS as readonly ChildProhibition[]).toContain('mark_unverified_as_complete');
    expect(NOT_CHECKABLE_FROM_REPORT as readonly ChildProhibition[]).toEqual(['mutate_parent_goal_state', 'spawn_unbounded_subtasks']);
  });

  it('核验是只读的: 深冻结的合同与报告传进去不抛, 内容一字不改', () => {
    const c = deepFreeze(makeContract());
    const r = deepFreeze(report(c));
    const before = JSON.stringify([c, r]);
    expect(() => validateChildReport(c, r)).not.toThrow();
    expect(() => acceptsAsComplete(c, r)).not.toThrow();
    expect(JSON.stringify([c, r])).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ③ 接受为完成
// ---------------------------------------------------------------------------

describe('③ 接受为完成 (acceptsAsComplete)', () => {
  it('合格回报 → 接受, 且理由说清判据数与证据条数', () => {
    const c = makeContract();
    const res = acceptsAsComplete(c, report(c));
    expect(res.accepted).toBe(true);
    expect(res.reason).toContain('2 条判据');
    expect(res.reason).toContain(c.workId);
  });

  it('强负例 7: 漂亮但无证据 → 不接受为完成', () => {
    const c = makeContract();
    const pretty = report(c, { evidence: [], checks: [], summary: '一切顺利, 已完美完成。' });
    const res = acceptsAsComplete(c, pretty);
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain('报告不完整');
    expect(res.reason).toContain('evidence');
  });

  it('partial / failed / cancelled 一律不接受为完成 (理由点名状态)', () => {
    const c = makeContract();
    for (const status of ['partial', 'failed', 'cancelled', 'blocked'] as const) {
      const res = acceptsAsComplete(c, report(c, { status, blockReason: status === 'blocked' ? blockRecord(c) : null }));
      expect(res.accepted).toBe(false);
      expect(res.reason).toContain(status);
    }
  });

  it('判据缺证据 → 不接受, 理由点名缺哪条', () => {
    const c = makeContract();
    const res = acceptsAsComplete(c, report(c, { evidence: [{ kind: criterionRef('改动已落盘'), ref: 'diff#1', note: null }] }));
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain('判据缺证据');
    expect(res.reason).toContain(criterionRef('测试通过'));
  });

  it('超期交付: 不接受, 但报告本身仍算合格 (两件事分开说)', () => {
    const c = makeContract({ deadline: '2026-09-25T10:05:00.000Z' });
    const late = report(c, { reportedAt: '2026-09-25T10:09:00.000Z' });
    expect(validateChildReport(c, late).ok).toBe(true); // 报告内容没问题
    const res = acceptsAsComplete(c, late);
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain('deadline');
    expect(res.reason).toContain('超期');
    // 卡在 deadline 上不算超期
    expect(acceptsAsComplete(c, report(c, { reportedAt: '2026-09-25T10:05:00.000Z' })).accepted).toBe(true);
  });

  it('不设 deadline 的合同不受超期影响', () => {
    const c = makeContract({ deadline: null });
    expect(c.deadline).toBeNull();
    expect(acceptsAsComplete(c, report(c, { reportedAt: '2030-01-01T00:00:00.000Z' })).accepted).toBe(true);
  });

  it('越界报告一律不接受 (reason 带上越界类型)', () => {
    const c = makeContract({ budget: budget({ maxDurationMs: 60_000 }) });
    const res = acceptsAsComplete(c, report(c, { durationMs: 120_000 }));
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain('expand_own_budget');
  });
});

// ---------------------------------------------------------------------------
// ④ 所有权与纯函数纪律 (源级)
// ---------------------------------------------------------------------------

describe('④ 纯函数纪律与所有权 (源级)', () => {
  const root = process.cwd();
  const srcRel = 'src/agents/goal-flywheel/work-contract.ts';
  const src = fs.readFileSync(path.join(root, srcRel), 'utf8');

  it('只 import ./types.js —— 不引入别的阶段实现 / 不读真实钟 / 不做 I/O', () => {
    const specifiers = [...src.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0); // 门自身非空转
    expect([...new Set(specifiers)]).toEqual(['./types.js']);
    expect(src).not.toMatch(/\bDate\.now\(/);
    expect(src).not.toMatch(/\bnew Date\(/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/from '(node:|fs|path|os|crypto)/);
    expect(src).not.toMatch(/\bfetch\(/);
  });

  it('没碰冻结面 (types.ts / index.ts 不被本阶段改动)', () => {
    const typesSrc = fs.readFileSync(path.join(root, 'src/agents/goal-flywheel/types.ts'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(root, 'src/agents/goal-flywheel/index.ts'), 'utf8');
    expect(typesSrc).not.toMatch(/^import /m); // 冻结层仍是纯类型
    expect(typesSrc).not.toMatch(/^export function /m);
    // 入口仍然只转发冻结类型 —— 没有把 P2 实现挂上去 (接线是单一所有者后续的事)
    expect(indexSrc.split('\n').filter((l) => /^export /.test(l))).toEqual(["export * from './types.js';"]);
  });
});
