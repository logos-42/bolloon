/**
 * 门: P4 「新要求注入」(`src/agents/goal-flywheel/goal-change.ts`) 的规则与不变式。
 *
 * 五条冻结规则 (`GOAL_CHANGE_RULES`) 逐条钉:
 *   1 user_revocation_wins          → 用户撤销压过同批其余意图, 且**不**增判据版本
 *   2 agent_cannot_approve_budget   → 非用户来源的"放宽"永不 `next_run` (可证明的**收紧**才放行)
 *   3 criteria_change_bumps_version → 只有"用户 + 改判据"才 +1; 不改判据不许 +1; 已排入不许二次 +1
 *   4 history_not_rewritten         → 每条指令都带"只影响后续 Run"; 深冻结的输入不被改写
 *   5 children_receive_new_version  → 受影响子 Agent 必须先确认收到变更版本 (取不到影响面就要显式说明)
 *
 * 阴性对照 (怎么知道这道门不是空转):
 *   · 未分诊 (`status=received` / `interpreted=null`) → `applyChange` **必须** reject
 *   · 多重意图 ("判据改成 X 且预算提到 50") → 必须退回人拆, 不许挑一个执行
 *   · 已 `scheduled_next_run` / `applied` / `superseded` → 必须 reject (防二次 +1 判据版本)
 *   · 空白原话 / 非法 source → `ingestChange` **必须**抛错
 *   · 源级: 本模块只许 import `./types.js`; 不许读钟/读盘/引其它阶段实现
 *
 * 变异验证 (故意改坏主不变量 → 必须判红; 本文件 51 条为分母, 实测):
 *   M1 `isWidening('budget_change')` 恒 false (Agent 可自批扩预算) → 6 红 / 45 绿
 *   M2 `const next = base + 1` → `base` (改判据不增版本)           → 4 红 / 47 绿
 *   M3 `compose` 去掉 historyClause (指令不带"只影响后续")          → 3 红 / 48 绿
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ingestChange,
  classifyChange,
  applyChange,
  detectChangeIntents,
  detectBudgetDirection,
  isWidening,
  scopeChangeToWork,
  childChangeDirective,
  nextStatusFor,
  shouldSupersedePending,
  approvalAsUserChange,
} from '../agents/goal-flywheel/goal-change.js';

import {
  CHANGE_KINDS,
  GOAL_CHANGE_RULES,
  type ChangeKind,
  type ChangeSource,
  type GoalChangeRequest,
} from '../agents/goal-flywheel/types.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW = '2026-09-25T10:00:00.000Z';
const GOAL = { successCriteria: ['跑通全部测试', '产出报告'], budget: { maxRuns: 10 } };

function ingest(instruction: string, opts: { source?: ChangeSource; by?: string; now?: string } = {}) {
  return ingestChange({
    goalId: 'goal-1',
    source: opts.source ?? 'user',
    instruction,
    recordedBy: opts.by ?? 'leo',
    now: opts.now ?? NOW,
  });
}

/** 记录 + 分类 (分类用带判据/预算的 Goal) */
function triaged(instruction: string, opts: { source?: ChangeSource; goal?: typeof GOAL } = {}) {
  const raw = ingest(instruction, opts);
  const cls = classifyChange(raw, opts.goal ?? GOAL);
  return { raw, cls };
}

function run(instruction: string, opts: { source?: ChangeSource; v?: number; goal?: typeof GOAL } = {}) {
  const { raw, cls } = triaged(instruction, opts);
  return { raw, cls, res: applyChange(cls, { criteriaVersion: opts.v ?? 1 }) };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** 八类各一句真实口吻的原话 (用于完备性) */
const KIND_PHRASES: Record<ChangeKind, string> = {
  clarification: '补充说明: 报告存到 docs/ 下就行',
  priority_change: '先做报告, 测试后面再做',
  success_criteria_change: '完成标准改成: 跑通 90% 测试',
  budget_change: '把预算提高到 50 步',
  permission_change: '给你加上写 release 目录的权限',
  scope_expansion: '顺便把文档站也更新一下',
  scope_reduction: '只做 A 部分, 其余先不做',
  abort: '撤销这个目标',
};

/** 必须由 principal 决定才能放宽的六种请求 (来源不是 user 时一律待批准) */
const WIDENING_PHRASES = [
  KIND_PHRASES.abort,
  KIND_PHRASES.success_criteria_change,
  KIND_PHRASES.budget_change,
  '预算改成 50',
  KIND_PHRASES.permission_change,
  KIND_PHRASES.scope_expansion,
];

// ===========================================================================
// A. 记录 —— 原话逐字 (不解析/不改写/不读钟)
// ===========================================================================

describe('P4 §A ingestChange: 逐字记录原文与来源', () => {
  it('原话逐字保留 (不 trim), 未分诊时字段齐全且保守', () => {
    const r = ingest('  把报告存到 docs/x.md 就行  ');
    expect(r.instruction).toBe('  把报告存到 docs/x.md 就行  '); // 一个字都不许改
    expect(r.instruction.trim()).not.toBe(r.instruction); // 证明真的没 trim
    expect(r.status).toBe('received');
    expect(r.interpreted).toBeNull();
    expect(r.kind).toBe('clarification'); // 未分诊前按最保守分类 (不改判据/不扩预算)
    expect(r.priority).toBe('high');
    expect(r.requiresReplan).toBe(false);
    expect(r.effectiveAt).toBe(NOW);
    expect(r.recordedAt).toBe(NOW);
    expect(r.recordedBy).toBe('leo');
    expect(r.appliesToFutureRunsOnly).toBe(true);
    expect(r.scope).toEqual({ kind: 'goal', targetIds: ['goal-1'] });
    expect(r.impact).toEqual({
      affectsObjective: false,
      affectsCriteria: false,
      affectsBudget: false,
      affectsPermission: false,
      affectedWorkIds: [],
    });
  });

  it('同一 (原文+来源+人+时间) → 同一 changeId (可去重); 时间不同 → 不同 id', () => {
    const a = ingest('把预算提高到 50 步');
    const b = ingest('把预算提高到 50 步');
    const c = ingest('把预算提高到 50 步', { now: '2026-09-25T10:00:01.000Z' });
    expect(a.changeId).toBe(b.changeId);
    expect(a.changeId).not.toBe(c.changeId);
    expect(a.changeId).toMatch(/^chg_[0-9a-f]{8}$/);
  });

  it('阴性对照: 空白原话 / 空 goalId / 空 recordedBy / 空 now 一律抛错', () => {
    expect(() => ingest('')).toThrow(/instruction 不能为空/);
    expect(() => ingest('   ')).toThrow(/instruction 不能为空/);
    expect(() => ingestChange({ goalId: '', source: 'user', instruction: 'x', recordedBy: 'leo', now: NOW })).toThrow(/goalId 不能为空/);
    expect(() => ingestChange({ goalId: 'goal-1', source: 'user', instruction: 'x', recordedBy: '  ', now: NOW })).toThrow(/recordedBy 不能为空/);
    expect(() => ingestChange({ goalId: 'goal-1', source: 'user', instruction: 'x', recordedBy: 'leo', now: '' })).toThrow(/now 必须由调用方注入/);
  });

  it('阴性对照: 非法 source 抛错 (不许把未知来源当用户)', () => {
    expect(() =>
      ingestChange({ goalId: 'goal-1', source: 'robot' as unknown as ChangeSource, instruction: 'x', recordedBy: 'leo', now: NOW }),
    ).toThrow(/非法 source/);
  });
});

// ===========================================================================
// B. 八种分类
// ===========================================================================

describe('P4 §B classifyChange: 八种变更分类', () => {
  for (const kind of CHANGE_KINDS) {
    it(`把「${KIND_PHRASES[kind]}」分到 ${kind}`, () => {
      const { cls } = triaged(KIND_PHRASES[kind], { source: kind === 'abort' ? 'user' : 'agent' });
      expect(cls.kind).toBe(kind);
      expect(cls.status).toBe('triaged');
      expect(cls.interpreted).toBeTruthy(); // 有摘要才可能生效
      expect(cls.appliesToFutureRunsOnly).toBe(true);
    });
  }

  it('八类被测试表**全覆盖** (少一类就判红)', () => {
    const produced = new Set(CHANGE_KINDS.map((k) => triaged(KIND_PHRASES[k], { source: 'agent' }).cls.kind));
    expect([...produced].sort()).toEqual([...CHANGE_KINDS].sort());
  });

  it('影响面按类别填写 (判据/预算/权限/目标各归各的)', () => {
    const criteria = triaged(KIND_PHRASES.success_criteria_change).cls.impact;
    expect(criteria.affectsCriteria).toBe(true);
    expect(criteria.affectsBudget).toBe(false);

    const budget = triaged(KIND_PHRASES.budget_change).cls.impact;
    expect(budget.affectsBudget).toBe(true);
    expect(budget.affectsCriteria).toBe(false);

    const perm = triaged(KIND_PHRASES.permission_change).cls.impact;
    expect(perm.affectsPermission).toBe(true);

    const scope = triaged(KIND_PHRASES.scope_expansion).cls.impact;
    expect(scope.affectsObjective).toBe(true);

    const clar = triaged(KIND_PHRASES.clarification).cls.impact;
    expect(Object.values(clar).every((v) => v === false || (Array.isArray(v) && v.length === 0))).toBe(true);
    expect(triaged(KIND_PHRASES.clarification).cls.requiresReplan).toBe(false);
    expect(triaged(KIND_PHRASES.abort, { source: 'user' }).cls.requiresReplan).toBe(false); // 终止不重规划
  });

  it('预算方向: 有基准就比数值, 没基准看用词, 判不出就说判不出', () => {
    expect(detectBudgetDirection('把预算提高到 50 步', { maxRuns: 10 }).direction).toBe('increase');
    expect(detectBudgetDirection('预算改成 5 步', { maxRuns: 10 }).direction).toBe('decrease');
    expect(detectBudgetDirection('预算改成 50', { maxRuns: 10 }).direction).toBe('increase'); // 只有基准+新值
    expect(detectBudgetDirection('预算改成 50').direction).toBe('unspecified'); // 无基准无数值可比
    expect(detectBudgetDirection('预算提高但也要减少一些').direction).toBe('unspecified'); // 自相矛盾不猜
    expect(detectBudgetDirection('预算按原计划', { maxRuns: 10 }).from).toBe(10);
  });

  it('isWidening: 放宽只能由 principal 决定 (收紧不算放宽)', () => {
    expect(isWidening('abort')).toBe(true);
    expect(isWidening('success_criteria_change')).toBe(true);
    expect(isWidening('permission_change')).toBe(true);
    expect(isWidening('scope_expansion')).toBe(true);
    expect(isWidening('budget_change', 'increase')).toBe(true);
    expect(isWidening('budget_change', 'unspecified')).toBe(true); // 判不出 → 保守按放宽
    expect(isWidening('budget_change', 'decrease')).toBe(false);
    expect(isWidening('scope_reduction')).toBe(false);
    expect(isWidening('clarification')).toBe(false);
    expect(isWidening('priority_change')).toBe(false);
  });
});

// ===========================================================================
// C. 规则 1 —— 用户明确撤销优先
// ===========================================================================

describe('P4 规则1 user_revocation_wins: 用户撤销压过一切', () => {
  it('用户一句话里既有扩预算又有撤销 → 撤销赢, 同批其余作废', () => {
    const { cls, res } = run('把预算提到 100 然后取消这个目标', { source: 'user' });
    expect(cls.kind).toBe('abort');
    expect(cls.priority).toBe('user_revocation');
    expect(cls.status).toBe('triaged');
    expect(cls.interpreted).toContain('budget_change');
    expect(cls.interpreted).toContain('作废');
    expect(res.outcome).toBe('next_run');
    expect(res.requiresReplan).toBe(false);
    expect(res.reason).toContain('user_revocation_wins');
    expect(res.nextRunDirective).toContain('终止该目标');
    expect(shouldSupersedePending(cls)).toBe(true);
  });

  it('用户撤销 + 改判据 → 撤销赢, 判据版本**不** +1 (规则 3 让位于规则 1)', () => {
    const { cls, res } = run('撤销这个目标, 判据也不用管了', { source: 'user', v: 3 });
    expect(cls.kind).toBe('abort');
    expect(cls.interpreted).toContain('success_criteria_change');
    expect(res.outcome).toBe('next_run');
    expect(res.criteriaVersion).toBe(3); // 没有 +1
  });

  it('撤销**只有用户能发起**: 非用户来源的 abort 待批准, 不许自动生效', () => {
    const { cls, res } = run('撤销这个目标', { source: 'agent', v: 5 });
    expect(cls.status).toBe('triaged');
    expect(res.outcome).toBe('pending_approval');
    expect(res.reason).toContain('user_revocation_wins');
    expect(res.criteriaVersion).toBe(5);
  });

  it('shouldSupersedePending: 只有"用户 + 撤销 + priority=user_revocation"为真', () => {
    expect(shouldSupersedePending(triaged('撤销这个目标', { source: 'user' }).cls)).toBe(true);
    expect(shouldSupersedePending(triaged('撤销这个目标', { source: 'agent' }).cls)).toBe(false);
    expect(shouldSupersedePending(triaged(KIND_PHRASES.budget_change, { source: 'user' }).cls)).toBe(false);
  });
});

// ===========================================================================
// D. 规则 2 —— 扩预算不得由 Agent 自动批准
// ===========================================================================

describe('P4 规则2 agent_cannot_approve_budget: 非用户来源不得放宽', () => {
  it('agent 提"扩大预算" → 待批准 (永不 next_run), 判据版本不动', () => {
    const { cls, res } = run('把预算提高到 80 步', { source: 'agent', v: 2 });
    expect(cls.kind).toBe('budget_change');
    expect(res.outcome).toBe('pending_approval');
    expect(res.reason).toContain('agent_cannot_approve_budget');
    expect(res.criteriaVersion).toBe(2);
    expect(res.nextRunDirective).toContain('批准前不动任何东西');
    expect(nextStatusFor(res.outcome)).toBe('needs_approval');
  });

  it('agent 提"预算改成 50"(方向判不出) → 保守待批准, 不给"没写扩大就算收紧"的口子', () => {
    const { res } = run('预算改成 50', { source: 'agent' });
    expect(res.outcome).toBe('pending_approval');
    expect(res.reason).toContain('agent_cannot_approve_budget');
    expect(res.reason).toContain('unspecified');
  });

  it('agent 只**收紧**预算 → 允许排入下一 Run (收紧不扩大风险面)', () => {
    const { res } = run('预算压缩到 5 步', { source: 'agent', v: 4 });
    expect(res.outcome).toBe('next_run');
    expect(res.requiresReplan).toBe(true);
    expect(res.criteriaVersion).toBe(4);
    expect(res.reason).toContain('agent_cannot_approve_budget');
    expect(res.reason).toContain('收紧');
  });

  it('对照: 同样一句"扩大预算"由用户提出 → 排入下一 Run (出资方本人 = 已批准)', () => {
    const { res } = run('把预算提高到 80 步', { source: 'user' });
    expect(res.outcome).toBe('next_run');
    expect(res.reason).toContain('出资方本人');
  });

  it('全枚举: 非用户来源 × 六种"放宽"请求 **永不** next_run (性质测试)', () => {
    const sources: ChangeSource[] = ['agent', 'external', 'system'];
    const seen: string[] = [];
    for (const source of sources) {
      for (const phrase of WIDENING_PHRASES) {
        const { cls, res } = run(phrase, { source });
        expect(cls.status, `${source}: ${phrase}`).toBe('triaged');
        expect(res.outcome, `${source}: ${phrase}`).toBe('pending_approval');
        seen.push(`${source}:${cls.kind}`);
      }
    }
    expect(seen.length).toBe(sources.length * WIDENING_PHRASES.length); // 没空转
    expect(new Set(seen).size).toBeGreaterThanOrEqual(6); // 真的覆盖了多类
  });

  it('全枚举: 收紧/中立类 (补充说明/优先级/范围缩小/收紧预算) 非用户来源也照常放行', () => {
    for (const source of ['agent', 'external', 'system'] as ChangeSource[]) {
      for (const phrase of [KIND_PHRASES.clarification, KIND_PHRASES.priority_change, KIND_PHRASES.scope_reduction, '预算减少到 3 步']) {
        const { res } = run(phrase, { source });
        expect(res.outcome, `${source}: ${phrase}`).toBe('next_run');
      }
    }
  });

  it('批准路径: 人工批准 = 由人以 user 来源重新记录同一句原话 (Agent 自己批不了)', () => {
    const { cls } = triaged('把预算提高到 80 步', { source: 'agent' });
    const agentTry = applyChange(cls, { criteriaVersion: 1 });
    expect(agentTry.outcome).toBe('pending_approval'); // 第一步: Agent 永远批不了

    const asUser = approvalAsUserChange(cls, 'leo', '2026-09-25T11:00:00.000Z');
    expect(asUser.source).toBe('user');
    expect(asUser.instruction).toBe(cls.instruction); // 原话逐字
    expect(asUser.appliesToFutureRunsOnly).toBe(true);
    expect(asUser.interpreted).toContain(`采纳来源 agent 的变更 ${cls.changeId}`); // 可追溯
    const approved = applyChange(asUser, { criteriaVersion: 1 });
    expect(approved.outcome).toBe('next_run'); // 第二步: 人批了才放行
  });
});

// ===========================================================================
// E. 规则 3 —— 改完成判据必须增版本号
// ===========================================================================

describe('P4 规则3 criteria_change_bumps_version: 只有改判据才 +1', () => {
  it('用户改判据 → criteriaVersion +1, 且指令里点名新版本', () => {
    const { cls, res } = run(KIND_PHRASES.success_criteria_change, { source: 'user', v: 3 });
    expect(cls.kind).toBe('success_criteria_change');
    expect(cls.impact.affectsCriteria).toBe(true);
    expect(res.outcome).toBe('next_run');
    expect(res.criteriaVersion).toBe(4);
    expect(res.reason).toContain('criteria_change_bumps_version');
    expect(res.nextRunDirective).toContain('v4');
  });

  it('agent 改判据 → 待批准, 版本**不** +1 (批准前不许动版本)', () => {
    const { res } = run(KIND_PHRASES.success_criteria_change, { source: 'agent', v: 3 });
    expect(res.outcome).toBe('pending_approval');
    expect(res.criteriaVersion).toBe(3);
    expect(res.reason).toContain('criteria_change_bumps_version');
    expect(res.nextRunDirective).toContain('v3');
  });

  it('不改判据的变更一律**不许**动版本 (枚举: 补充/优先级/价格收紧/权限/范围)', () => {
    const cases: Array<[string, ChangeSource]> = [
      [KIND_PHRASES.clarification, 'user'],
      [KIND_PHRASES.priority_change, 'user'],
      ['预算减少到 3 步', 'user'],
      [KIND_PHRASES.permission_change, 'user'],
      [KIND_PHRASES.scope_expansion, 'user'],
      [KIND_PHRASES.scope_reduction, 'user'],
    ];
    for (const [phrase, source] of cases) {
      const { res } = run(phrase, { source, v: 7 });
      expect(res.criteriaVersion, phrase).toBe(7);
    }
  });

  it('判据"重申"不算改判据 → 不 +1 (照旧 / 原句重复)', () => {
    const restated = triaged('判据照旧, 只是再确认一下', { source: 'user' });
    expect(restated.cls.kind).toBe('clarification');
    expect(applyChange(restated.cls, { criteriaVersion: 2 }).criteriaVersion).toBe(2);

    const quoted = triaged('判据是「跑通全部测试」', { source: 'user' });
    expect(quoted.cls.kind).toBe('clarification');
    expect(applyChange(quoted.cls, { criteriaVersion: 2 }).criteriaVersion).toBe(2);
  });

  it('负控制: 已排入下一 Run 的改判据请求再次 apply → reject, 版本不被二次 +1', () => {
    const { cls } = triaged(KIND_PHRASES.success_criteria_change, { source: 'user' });
    const first = applyChange(cls, { criteriaVersion: 3 });
    expect(first.outcome).toBe('next_run');
    expect(first.criteriaVersion).toBe(4);

    // 接线层落库: 按判定结果推进状态
    const recorded: GoalChangeRequest = { ...cls, status: nextStatusFor(first.outcome) };
    const second = applyChange(recorded, { criteriaVersion: first.criteriaVersion });
    expect(second.outcome).toBe('rejected');
    expect(second.reason).toContain('幂等');
    expect(second.criteriaVersion).toBe(4); // 没有 5
  });

  it('负控制: 不是从 1 起算也算得对 (v10 → v11), 非法版本归一为 1', () => {
    const { cls } = triaged(KIND_PHRASES.success_criteria_change, { source: 'user' });
    expect(applyChange(cls, { criteriaVersion: 10 }).criteriaVersion).toBe(11);
    expect(applyChange(cls, { criteriaVersion: Number.NaN }).criteriaVersion).toBe(2);
  });
});

// ===========================================================================
// F. 规则 4 —— 当前 Run 历史不可被新要求改写
// ===========================================================================

describe('P4 规则4 history_not_rewritten: 只影响后续 Run', () => {
  it('所有产出的记录都标着 appliesToFutureRunsOnly', () => {
    const { raw, cls } = triaged(KIND_PHRASES.budget_change, { source: 'user' });
    const scoped = scopeChangeToWork(cls, ['w1']);
    const approved = approvalAsUserChange(triaged(KIND_PHRASES.budget_change, { source: 'agent' }).cls, 'leo', NOW);
    for (const r of [raw, cls, scoped, approved]) expect(r.appliesToFutureRunsOnly).toBe(true);
  });

  it('每条会生效/待批准的指令都自带"只影响后续 Run + 不改写历史"条款', () => {
    const cases: Array<[string, ChangeSource]> = [
      [KIND_PHRASES.success_criteria_change, 'user'], // next_run
      [KIND_PHRASES.budget_change, 'agent'], // pending_approval
      [KIND_PHRASES.abort, 'user'], // next_run (撤销)
      [KIND_PHRASES.abort, 'agent'], // pending_approval
      [KIND_PHRASES.clarification, 'user'],
    ];
    for (const [phrase, source] of cases) {
      const { res } = run(phrase, { source });
      expect(res.outcome, phrase).not.toBe('rejected');
      expect(res.nextRunDirective, phrase).toContain('只影响后续 Run');
      expect(res.nextRunDirective, phrase).toContain('不改写');
      expect(res.nextRunDirective, phrase).toContain(`criteriaVersion=v${res.criteriaVersion}`);
    }
  });

  it('纯函数: 深冻结的输入不被改写 (改写历史在这里会直接抛错)', () => {
    const { cls } = triaged(KIND_PHRASES.success_criteria_change, { source: 'user' });
    const scoped = deepFreeze(scopeChangeToWork(cls, ['w1']));
    const goal = deepFreeze({ criteriaVersion: 2 });
    const snapshot = JSON.stringify({ scoped, goal });

    const res = applyChange(scoped, goal);
    expect(res.outcome).toBe('next_run');
    expect(JSON.stringify({ scoped, goal })).toBe(snapshot); // 一个字节都没动
  });

  it('reject 的判定不产生任何"下一 Run 指令", 也不动版本', () => {
    const raw = ingest(KIND_PHRASES.success_criteria_change);
    const res = applyChange(raw, { criteriaVersion: 6 });
    expect(res.outcome).toBe('rejected');
    expect(res.requiresReplan).toBe(false);
    expect(res.criteriaVersion).toBe(6);
    expect(res.nextRunDirective).toContain('不做任何变更');
  });
});

// ===========================================================================
// G. 规则 5 —— 子 Agent 必须拿到变更版本
// ===========================================================================

describe('P4 规则5 children_receive_new_version: 子 Agent 必须收到变更版本', () => {
  it('受影响子任务: 指令点名 workIds 且要求先确认收到, 才允许继续', () => {
    const { cls } = triaged(KIND_PHRASES.success_criteria_change, { source: 'user' });
    const scoped = scopeChangeToWork(cls, ['work-7', 'work-9', 'work-7']);
    expect(scoped.scope).toEqual({ kind: 'child_work', targetIds: ['work-7', 'work-9'] }); // 去重
    expect(scoped.impact.affectedWorkIds).toEqual(['work-7', 'work-9']);

    const res = applyChange(scoped, { criteriaVersion: 1 });
    expect(res.outcome).toBe('next_run');
    expect(res.nextRunDirective).toContain('children_receive_new_version');
    expect(res.nextRunDirective).toContain('work-7');
    expect(res.nextRunDirective).toContain('work-9');
    expect(res.nextRunDirective).toContain('先确认收到');

    const cd = childChangeDirective(scoped, { criteriaVersion: res.criteriaVersion });
    expect(cd.workIds).toEqual(['work-7', 'work-9']);
    expect(cd.criteriaVersion).toBe(2);
    expect(cd.mustAckBeforeNextStep).toBe(true);
    expect(cd.rewritesHistory).toBe(false); // 只发新版本, 不改写已有产出
    expect(cd.directive).toContain('v2');

    // 重新分类也不丢影响面 (scope 是唯一事实源)
    const recls = classifyChange(scoped, GOAL);
    expect(recls.impact.affectedWorkIds).toEqual(['work-7', 'work-9']);
    expect(recls.scope.kind).toBe('child_work');
  });

  it('撤销类变更: 子 Agent 收到的是"终止 + 按 cancelPolicy 收尾"', () => {
    const scoped = scopeChangeToWork(triaged(KIND_PHRASES.abort, { source: 'user' }).cls, ['work-1']);
    const res = applyChange(scoped, { criteriaVersion: 1 });
    expect(res.outcome).toBe('next_run');
    const cd = childChangeDirective(scoped, { criteriaVersion: res.criteriaVersion });
    expect(cd.directive).toContain('cancelPolicy');
    expect(cd.directive).toContain('work-1');
  });

  it('拿不到影响面时**必须显式说明为空**, 不许沉默跳过', () => {
    const { cls, res } = run(KIND_PHRASES.budget_change, { source: 'user' });
    expect(cls.impact.affectedWorkIds).toEqual([]);
    expect(res.nextRunDirective).toContain('无受影响子 Agent');
    const cd = childChangeDirective(cls, { criteriaVersion: res.criteriaVersion });
    expect(cd.workIds).toEqual([]);
    expect(cd.directive).toContain('没有受影响子 Agent');
  });

  it('scopeChangeToWork 清空 workIds 时回落到 goal 范围', () => {
    const { cls } = triaged(KIND_PHRASES.scope_reduction, { source: 'user' });
    const cleared = scopeChangeToWork(scopeChangeToWork(cls, ['w1', 'w2']), []);
    expect(cleared.scope).toEqual({ kind: 'goal', targetIds: ['goal-1'] });
    expect(cleared.impact.affectedWorkIds).toEqual([]);
  });
});

// ===========================================================================
// H. 负控制与结构
// ===========================================================================

describe('P4 §H 负控制: 该被拒的必须真的被拒', () => {
  it('未分诊 (status=received / interpreted=null) → reject', () => {
    const raw = ingest('把预算提高到 80 步');
    const res = applyChange(raw, { criteriaVersion: 3 });
    expect(res.outcome).toBe('rejected');
    expect(res.reason).toContain('未分诊');
    expect(res.criteriaVersion).toBe(3);
  });

  it('多重意图 ("判据改成 X 且预算提到 50") → 退回人拆, 不许挑一个执行', () => {
    const { cls, res } = run('判据改成「跑通 90% 测试」且预算提到 50', { source: 'user' });
    expect(detectChangeIntents('判据改成「跑通 90% 测试」且预算提到 50').length).toBeGreaterThan(1);
    expect(cls.kind).toBe('clarification'); // 退回保守占位, 不代表真分类
    expect(cls.status).toBe('received');
    expect(cls.interpreted).toBeNull();
    expect(res.outcome).toBe('rejected');
    expect(res.reason).toContain('需拆成多条');
    expect(res.criteriaVersion).toBe(1); // 判据版本没被偷偷推高
  });

  it('终态 (scheduled_next_run / applied / superseded) → 一律 reject', () => {
    const { cls } = triaged(KIND_PHRASES.budget_change, { source: 'user' });
    for (const status of ['scheduled_next_run', 'applied', 'superseded'] as const) {
      const res = applyChange({ ...cls, status }, { criteriaVersion: 4 });
      expect(res.outcome, status).toBe('rejected');
      expect(res.criteriaVersion, status).toBe(4);
    }
  });

  it('已 applied 的记录不许被重新分类回可生效状态', () => {
    const { cls } = triaged(KIND_PHRASES.success_criteria_change, { source: 'user' });
    const applied = { ...cls, status: 'applied' as const, interpreted: `${cls.interpreted} (已生效)` };
    const re = classifyChange(applied, GOAL);
    expect(re.status).toBe('applied'); // 不许被拉回 triaged
    expect(re.interpreted).toBe(applied.interpreted);
    expect(applyChange(re, { criteriaVersion: 9 }).outcome).toBe('rejected');
  });

  it('待批准状态反复判定是幂等的: 不静默放行, 也不重复上报', () => {
    const { cls } = triaged(KIND_PHRASES.budget_change, { source: 'agent' });
    const first = applyChange(cls, { criteriaVersion: 2 });
    const recorded = { ...cls, status: nextStatusFor(first.outcome) };
    const second = applyChange(recorded, { criteriaVersion: 2 });
    expect(second.outcome).toBe('pending_approval');
    expect(second.criteriaVersion).toBe(2);
    expect(nextStatusFor(second.outcome)).toBe(recorded.status);
    expect(nextStatusFor('rejected')).toBe('rejected');
  });

  it('规则 id 与冻结面的 GOAL_CHANGE_RULES 对齐 (reason 里点名的必须是冻结取值)', () => {
    const reasons = [
      run(KIND_PHRASES.abort, { source: 'user' }).res.reason,
      run(KIND_PHRASES.budget_change, { source: 'agent' }).res.reason,
      run(KIND_PHRASES.success_criteria_change, { source: 'user' }).res.reason,
    ].join('\n');
    const frozen = GOAL_CHANGE_RULES as readonly string[];
    expect(reasons).toContain('user_revocation_wins');
    expect(reasons).toContain('agent_cannot_approve_budget');
    expect(reasons).toContain('criteria_change_bumps_version');
    expect(frozen.includes('user_revocation_wins')).toBe(true); // 冻结面确实有这个名字
  });
});

describe('P4 §H 结构门: 独立性 (不写别的阶段, 不引别的阶段)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/goal-flywheel/goal-change.ts'), 'utf8');

  it('只 import 冻结面的类型/常量, 不 import 任何其它阶段的实现文件', () => {
    const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect([...new Set(specs)]).toEqual(['./types.js']);
    for (const other of ['continuation-decision', 'run-closure', 'memory-layers', 'skill-candidate', 'work-contract', 'work-monitor']) {
      expect(src, `不许引 ${other}`).not.toContain(other);
    }
  });

  it('不读钟 / 不读盘 / 不随机 (时间一律 now 注入)', () => {
    for (const banned of ['Date.now', 'new Date(', 'Math.random', 'node:fs', "from 'fs'", 'require(']) {
      expect(src, `不许出现 ${banned}`).not.toContain(banned);
    }
  });

  it('冻结签名仍在 (§14): ingestChange / classifyChange / applyChange', () => {
    for (const fn of ['ingestChange', 'classifyChange', 'applyChange']) {
      expect(src).toContain(`export function ${fn}(`);
    }
    // 冻结面只读: 本文件不许出现对冻结文件的写入迹象
    expect(src).not.toContain('types.ts');
  });

  it('不碰现有调用方 (execution-supervisor / goal-store / pi-sdk / skills-manager)', () => {
    for (const caller of ['execution-supervisor', 'goal-store', 'pi-sdk', 'skills-manager', 'watchdog']) {
      expect(src).not.toContain(caller);
    }
  });
});
