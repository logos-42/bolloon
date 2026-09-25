/**
 * mobile-flywheel-view.test.ts — 手机「飞轮进度」投影 (只读消费冻结类型) (2026-09-25)
 *
 * 这一层最容易变成"第二套状态", 所以用两条硬不变量把它钉住:
 *   ① **状态必须等于冻结函数的输出**: view.visibleState === toUserVisibleState(continuation, blocks, decision)
 *      (手机侧不许自己再判一次"现在算不算卡住")
 *   ② **汇报面只许出现 USER_REPORT_FIELDS 里的字段名**, 且内部字段名一个都不许出现
 *      (lease / reducer / retry counter 这类词露出来就是漏)
 */
import { describe, it, expect } from 'vitest';
import { buildMobileFlywheelView, findInternalFieldLeaks, BLOCK_ACTION_LABELS, BLOCK_KIND_LABELS, BLOCK_OWNER_LABELS } from '../agents/mobile-flywheel-view.js';
import { toUserVisibleState } from '../agents/goal-flywheel/work-monitor.js';
import { USER_VISIBLE_STATES, USER_VISIBLE_STATE_LABELS, USER_REPORT_FIELDS, BLOCK_KINDS, BLOCK_OWNERS, BLOCK_RESOLUTION_ACTIONS, GOAL_TERMINAL_STATES, type BlockRecord, type ContinuationDecision, type GoalContinuationRecord } from '../agents/goal-flywheel/types.js';

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function cont(patch: Partial<GoalContinuationRecord> = {}): GoalContinuationRecord {
  return {
    nextAction: '把判据 #2 的样本补齐', wakeAt: iso(NOW + 90 * 60_000), wakeReason: '到点继续',
    autoContinue: true, requiredAgent: null, pendingReports: [], unresolvedItems: ['判据 #2 还没验'],
    lastDecisionId: null, state: 'active', updatedAt: iso(NOW - 60_000),
    ...patch,
  };
}

function block(patch: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockId: 'blk-1', kind: 'buyer_no_reply', goalId: 'goal-1', runId: 'run-1', workId: null, childAgentId: null,
    blockedAt: iso(NOW - 2 * 3_600_000), lastProgressAt: iso(NOW - 3 * 3_600_000), owner: 'buyer',
    dependency: '对方回复', suggestedAction: 'notify', escalationAt: iso(NOW + 3_600_000), resolvedAt: null,
    resolution: null, note: '群消息发了 2 小时没人接',
    ...patch,
  };
}

function decision(patch: Partial<ContinuationDecision> = {}): ContinuationDecision {
  return {
    decisionId: 'dec-1', goalId: 'goal-1', runId: 'run-1', decision: 'continue', state: 'active',
    reason: '本轮补了 2 条证据, 继续跑', nextAction: '跑第三轮筛选', expectedOutcome: '判据 #3 有结论',
    confidence: 0.7, progressDelta: { newEvidence: ['run-1:step-2 产出 3 条流水'], newlyCompletedCriteria: [1], stepsAdvanced: 2, unresolvedDelta: -1 },
    unresolvedItems: ['判据 #3'], wakeAt: iso(NOW + 30 * 60_000), requiredCapability: null, riskLevel: 'low',
    ...patch,
  } as ContinuationDecision;
}

describe('① 状态 = 冻结函数的输出 (手机侧不自己造第二套)', () => {
  const cases: Array<{ name: string; c: GoalContinuationRecord | null; blocks: BlockRecord[]; d: ContinuationDecision | null; terminal?: boolean }> = [
    { name: '正常继续', c: cont(), blocks: [], d: null },
    { name: '子 Agent 被阻塞', c: cont({ state: 'stalled' }), blocks: [block({ kind: 'no_heartbeat', owner: 'parent', suggestedAction: 'escalate_parent' })], d: null },
    { name: '需要人决定 (block 建议转人工)', c: cont(), blocks: [block({ suggestedAction: 'needs_human' })], d: null },
    { name: '需要人决定 (决策问人)', c: cont(), blocks: [], d: decision({ decision: 'ask_human', state: 'needs_decision' }) },
    { name: '等外部回复', c: cont({ state: 'awaiting_external', pendingReports: [{ workId: 'w1', agentId: null, askedAt: iso(NOW - 3600_000), deadlineAt: iso(NOW + 3600_000), summary: '等初筛结果' }] as any }), blocks: [], d: null },
    { name: '终态目标 (store 里没有 continuation, 由 goal 真实状态判)', c: null, blocks: [], d: null },
    { name: '终态目标 (状态装进 continuation 形状)', c: cont({ state: 'completed', autoContinue: false, nextAction: '', unresolvedItems: [] }), blocks: [], d: null },
    { name: '已解决阻塞不算阻塞', c: cont(), blocks: [block({ resolvedAt: iso(NOW - 60_000), resolution: 'notify' })], d: null },
  ];

  for (const c of cases) {
    it(`${c.name}: view.visibleState ≡ toUserVisibleState(冻结函数)`, () => {
      const view = buildMobileFlywheelView({ continuation: c.c, blocks: c.blocks, decision: c.d, now: NOW });
      expect(view.visibleState).toBe(toUserVisibleState(c.c, c.blocks, c.d));
      expect(USER_VISIBLE_STATES).toContain(view.visibleState);
      expect(view.stateLabel).toEqual(USER_VISIBLE_STATE_LABELS[view.visibleState]);
      expect(view.stateLabel.zh).toBeTruthy();
      expect(view.stateLabel.en).toBeTruthy();
    });
  }

  it('终态目标 → ended (不说成"正在执行"): 下一步与结论都如实', () => {
    const v = buildMobileFlywheelView({ continuation: cont({ state: 'abandoned', nextAction: '', autoContinue: false }), blocks: [], decision: null, now: NOW });
    expect(v.visibleState).toBe('ended');
    expect(v.report.nextStep).toContain('已经结束');
    expect(v.report.conclusion).toBe('这个目标已经结束');
    expect(v.report.willContinue).toBe(false);
    expect(v.resumeInMs).toBe(null);
  });

  it('终态由 continuation.state 决定, 调用方撒不了谎 (不传 flag)', () => {
    // 非终态却想装成"已结束"? 冻结函数说了不算: 状态仍按 state 判
    const v = buildMobileFlywheelView({ continuation: cont({ state: 'active' }), blocks: [], decision: null, now: NOW });
    expect(v.visibleState).toBe('executing');
    expect(GOAL_TERMINAL_STATES).not.toContain('active');
  });

  it('没有 continuation (终态没留 continuation / 数据缺失) → 由冻结函数给状态 + "要人看一眼"', () => {
    const v = buildMobileFlywheelView({ continuation: null, blocks: [], decision: null, now: NOW });
    expect(USER_VISIBLE_STATES).toContain(v.visibleState);
    expect(v.report.nextStep).toContain('没有写下下一步');
  });
});

describe('② 汇报面: 只许 USER_REPORT_FIELDS 里的字段', () => {
  it('report 的键 ⊆ USER_REPORT_FIELDS + exposedFields/generatedAt', () => {
    const v = buildMobileFlywheelView({ continuation: cont(), blocks: [block()], decision: decision(), now: NOW });
    for (const k of Object.keys(v.report)) {
      if (k === 'exposedFields' || k === 'generatedAt') continue;
      expect(USER_REPORT_FIELDS).toContain(k);
    }
    for (const f of v.report.exposedFields) expect(USER_REPORT_FIELDS).toContain(f);
  });

  it('汇报内容来自冻结事实: 判据/证据/剩余/下一步/是否继续', () => {
    const v = buildMobileFlywheelView({ continuation: cont(), blocks: [], decision: decision(), now: NOW });
    expect(v.report.completed).toEqual(['判据 #1']);
    expect(v.report.evidence[0]).toContain('run-1');
    expect(v.report.remaining).toEqual(['判据 #2 还没验']);   // 当前计划 (continuation) 说的才算
    expect(v.report.nextStep).toBe('把判据 #2 的样本补齐');
    expect(v.report.conclusion).toBe('本轮补了 2 条证据, 继续跑');
    expect(v.report.willContinue).toBe(true);
    expect(v.report.visibleState).toBe(v.visibleState);
  });

  it('没有决策记录时用 continuation 的事实 (不编造结论)', () => {
    const v = buildMobileFlywheelView({ continuation: cont(), blocks: [], decision: null, now: NOW });
    expect(v.report.conclusion).toBe('到点继续');          // wakeReason
    expect(v.report.nextStep).toBe('把判据 #2 的样本补齐');
    expect(v.report.remaining).toEqual(['判据 #2 还没验']);
    expect(v.report.completed).toEqual([]);
    expect(v.report.evidence).toEqual([]);
  });
});

describe('③ 阻塞清单: 只列未解决, 文案齐备, 时长按 now 算', () => {
  it('未解决的才有, 且带处理方/建议动作/卡了多久', () => {
    const v = buildMobileFlywheelView({
      continuation: cont(), now: NOW,
      blocks: [block(), block({ blockId: 'blk-2', kind: 'buyer_no_reply', resolvedAt: iso(NOW - 1), resolution: 'notify' })],
      decision: null,
    });
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0].kind).toBe('buyer_no_reply');
    expect(v.blocks[0].blockedForMs).toBe(2 * 3_600_000);
    expect(v.blocks[0].dependency).toBe('对方回复');
    expect(v.blocks[0].note).toBe('群消息发了 2 小时没人接');
    expect(v.blocks[0].kindLabel.zh).toBeTruthy();
    expect(v.blocks[0].ownerLabel.en).toBeTruthy();
    expect(v.blocks[0].actionLabel.zh).toBeTruthy();
    expect(v.blocks[0].suggestedAction).toBeTruthy();
  });

  it('卡住原因串进汇报 (人话, 不含内部词)', () => {
    const v = buildMobileFlywheelView({ continuation: cont(), blocks: [block()], decision: null, now: NOW });
    expect(v.report.blockReasons.length).toBe(1);
    expect(v.report.blockReasons[0]).toContain(v.blocks[0].kindLabel.zh);
    expect(findInternalFieldLeaks(JSON.stringify(v))).toEqual([]);
  });

  it('坏阻塞 (未知 kind / 缺字段) 不许把页面打崩, 也不要假装知道怎么处理', () => {
    const v = buildMobileFlywheelView({
      continuation: cont(), now: NOW,
      blocks: [block({ kind: 'kind-that-does-not-exist' as any, owner: undefined as any, suggestedAction: 'nonsense' as any, dependency: null, note: undefined as any })],
      decision: null,
    });
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0].kindLabel.zh).toBe('未知阻塞');
    expect(v.blocks[0].ownerLabel.zh).toBe('未知处理方');
    expect(v.blocks[0].actionLabel.zh).toBe('转人工');   // 说不清 → 转人工, 不猜
    expect(v.blocks[0].note).toBe('');
    expect(v.blocks[0].dependency).toBe(null);
    expect(USER_VISIBLE_STATES).toContain(v.visibleState);
  });

  it('冻结枚举的每个值都有双语文案 (新枚举值忘配文案会被这里拦下)', () => {
    for (const k of BLOCK_KINDS) expect(BLOCK_KIND_LABELS[k]?.zh && BLOCK_KIND_LABELS[k]?.en, k).toBeTruthy();
    for (const o of BLOCK_OWNERS) expect(BLOCK_OWNER_LABELS[o]?.zh && BLOCK_OWNER_LABELS[o]?.en, o).toBeTruthy();
    for (const a of BLOCK_RESOLUTION_ACTIONS) expect(BLOCK_ACTION_LABELS[a]?.zh && BLOCK_ACTION_LABELS[a]?.en, a).toBeTruthy();
  });
});

describe('④ 下一次醒来 / 执行者 / 风险: 只给相对毫秒与人话', () => {
  it('resumeInMs = wakeAt - now; 没有 wakeAt → null', () => {
    const v = buildMobileFlywheelView({ continuation: cont({ wakeAt: iso(NOW + 45 * 60_000) }), blocks: [], decision: null, now: NOW });
    expect(v.resumeInMs).toBe(45 * 60_000);
    const none = buildMobileFlywheelView({ continuation: cont({ wakeAt: null }), blocks: [], decision: null, now: NOW });
    expect(none.resumeInMs).toBe(null);
  });

  it('指定执行者给的是描述不是内部 id 原文; 风险级别透传决策', () => {
    const v = buildMobileFlywheelView({
      continuation: cont({ requiredAgent: 'agent-2d86796f-very-long-internal-id-abcdef' }),
      blocks: [], decision: decision({ riskLevel: 'high' }), now: NOW,
    });
    expect(v.requiredAgent).toContain('指定执行者');
    expect(String(v.requiredAgent).length).toBeLessThanOrEqual(24 + '指定执行者: '.length);
    expect(v.riskLevel).toBe('high');
  });
});

describe('⑤ 内部字段自检 (漏了就发现)', () => {
  it('干净视图 → 0 命中; 掺进 lease → 立刻命中', () => {
    const v = buildMobileFlywheelView({ continuation: cont(), blocks: [block()], decision: decision(), now: NOW });
    expect(findInternalFieldLeaks(JSON.stringify(v))).toEqual([]);
    expect(findInternalFieldLeaks(JSON.stringify({ ...v, lease: 'worker-1' }))).toContain('lease');
  });

  it('状态文案里不许出现内部词 (lease/reducer/retry counter/worker owner)', () => {
    for (const s of USER_VISIBLE_STATES) {
      const label = JSON.stringify(USER_VISIBLE_STATE_LABELS[s]);
      expect(findInternalFieldLeaks(label)).toEqual([]);
      expect(label).not.toMatch(/lease|reducer|retry counter|worker owner/i);
    }
  });
});
