/**
 * goal-flywheel-wiring-closure.test.ts — M2「强制收尾飞轮」接缝验收 (2026-09-26)
 *
 * 归属: `seams.ts` 名册里 closure 接缝 (`owns` 含本文件)。接缝在
 * `src/agents/goal-flywheel/wiring/closure.ts`; 被测的是**行为**, 不是"函数被调用过"。
 *
 * 这一份回答三个问题 (M2 的验收问题):
 *   ① **所有终止路径**是不是必经收尾 —— 八类终止 + run-store 的其余终止状态 (含实测的
 *      `recovering`), 每条都真跑一次: 真 Goal/Run Store (隔离 HOME) → 真收尾 → 真产物落盘。
 *   ② 收尾产物**落在哪里**是不是可核验 —— 真读盘 (用户汇报 / closure 决策记录 / 分层 Memory /
 *      候选文件), 而不是复述返回值。收尾缺任何一项 → `artifactsComplete:false` + 结构化清单。
 *   ③ Skill 升级通道的六阶段梯子: 结构化 → schema 校验 → 去重 → 安全权限 →
 *      `next_run_only` 快照试用 → 下次成功复用后才提升 (**准入不是晋升**)。
 *
 * 阴性对照 (怎么知道这份不是空转):
 *   · 该拒必须**真拒**: 子 Agent 收尾 / 未知终止路径 / 说不清哪条 Run / 未知调用方 —— 四个都真拒,
 *     且**一个字节都没写** (决策记录条数不变)。
 *   · 名册自检: 把 `escalated_to_human` 从名册里拿掉 → `needs_human` 立刻"无人认领"判红;
 *     把 seams.ts 的某条路径改名 → 同时报"引用不存在的路径"+"有条路径没人认领"。
 *   · 产物变异: 往真 HOME 里**种**一条落错层的记忆 / 一份范围不安全的候选 → 审计必须判红;
 *     删掉种的东西 → 必须回到绿 (证明这条检查真的在查盘, 不是恒绿)。
 *   · 协议陷阱 (实测踩过): 收尾**真做完了**但产物有缺口时, 结果**不许**长得像"被拒" ——
 *     `seams.ts` 的 `isRefusal` 判据 (ok===false && reason 是字符串) 会把假拒当真拒,
 *     调用方于是把一条真收尾的 Run 从 report 里丢掉。所以这里钉死 `isRefusal(out)===false`。
 *
 * 变异验证 (报告里给数字): 见文件末尾 `// 变异验证` 注释块。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  CLOSURE_ARTIFACT_KINDS,
  CLOSURE_TERMINAL_KINDS,
  CLOSURE_TERMINAL_PATHS,
  RUN_IN_FLIGHT_STATUSES,
  RUN_TERMINAL_STATUSES,
  SKILL_CANDIDATES_ROOT,
  auditClosureOutcome,
  auditTerminalCoverage,
  closureTerminalKindFor,
  homeFromArtifactPath,
  probeClosureArtifacts,
  terminalKindAccepts,
  terminalRegistryCoverage,
  type ClosureOutcomeView,
} from '../agents/goal-flywheel/wiring/closure.js';
import { TERMINAL_PATHS, WIRING_CALLERS, isRefusal } from '../agents/goal-flywheel/wiring/seams.js';
import { CLOSURE_STEP_ORDER, GOAL_STATE_FOR_DECISION } from '../agents/goal-flywheel/run-closure.js';
import {
  MEMORY_LAYERS,
  MUST_NOT_EXPOSE_FIELDS,
  USER_REPORT_FIELDS,
  USER_VISIBLE_STATES,
} from '../agents/goal-flywheel/types.js';
import type { SkillImprovementCandidate, IsoTimestamp } from '../agents/goal-flywheel/types.js';
import {
  SKILL_CHANNEL_STAGES,
  openSkillTrial,
  settleSkillTrial,
} from '../agents/goal-flywheel/skill-candidate.js';

// ---------------------------------------------------------------------------
// 隔离 HOME (真 Store, 不碰真实配置)
// ---------------------------------------------------------------------------

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const ENV_KEYS = ['BOLLOON_RUN_FINAL_REVIEW', 'BOLLOON_GOAL_NO_PROGRESS_BREAKER', 'BOLLOON_GOAL_MAX_RUNS', 'BOLLOON_GOAL_MAX_RETRIES', 'BOLLOON_RUN_PERSIST'];
const OLD_ENV: Record<string, string | undefined> = {};

/** 收尾的事实来源: 有它才有教训/候选, 收尾才不是空转 */
const FINAL_REVIEW = [
  '## 最终评审',
  '评审: 本轮通过, 判据 1 尚未满足 (还差数据)',
  '事实: 用 shell_exec 写好了报告目录',
  '教训: 先确认输出目录存在再写',
  '候选: 加一条"输出目录必须存在"的前置检查',
].join('\n');

const NOW: IsoTimestamp = '2026-09-26T10:00:00.000Z';

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-m2closure-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  for (const k of ENV_KEYS) OLD_ENV[k] = process.env[k];
  delete process.env.BOLLOON_GOAL_NO_PROGRESS_BREAKER;
  delete process.env.BOLLOON_GOAL_MAX_RUNS;
  delete process.env.BOLLOON_GOAL_MAX_RETRIES;
  process.env.BOLLOON_RUN_FINAL_REVIEW = FINAL_REVIEW;
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
    wiring: await import('../agents/goal-flywheel-wiring.js'),
  };
}

/** 造一条**真 Run 事实** (startRun → recordStep → finishRun → attachRun), 不伪造 Run 记录 */
async function seedRun(
  rs: any,
  gs: any,
  goalId: string,
  finish: { status: string; error?: string },
  steps: string[] = ['写好了报告目录'],
): Promise<string> {
  const rec = await rs.startRun({ channelId: 'ch-m2', goalId, goal: 'M2 收尾' });
  for (const s of steps) await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: s });
  await rs.finishRun(rec.runId, finish as any);
  await gs.attachRun(goalId, rec.runId);
  return rec.runId;
}

/** 经**真接线** (M0 注入的真依赖) 调本接缝 */
async function realSeam() {
  const wiring = await import('../agents/goal-flywheel-wiring.js');
  wiring.resetFlywheelSeamsForTest();
  return { wiring, seam: wiring.flywheelSeams().closure };
}

// ---------------------------------------------------------------------------
// §1 终止路径名册: 每条终止路径都有归属 (规则 ④ 的第一半)
// ---------------------------------------------------------------------------

describe('§1 终止路径名册: 终止状态 ↔ 终止路径 互相覆盖', () => {
  it('真名册自检全绿: 没有无人认领的状态 / 没有认领不存在的路径', () => {
    const cov = terminalRegistryCoverage();
    expect(cov.unmappedStatuses).toEqual([]);
    expect(cov.unknownSeamLabels).toEqual([]);
    // seams.ts 名册上的**每条**终止路径都必须被本接缝认领 (漏一条 = 有路径绕过收尾)
    expect(cov.unclaimedSeamLabels).toEqual([]);
    expect(cov.kindCount).toBe(CLOSURE_TERMINAL_KINDS.length);
    expect(cov.seamPathCount).toBe(TERMINAL_PATHS.length);
    expect(cov.seamPathCount).toBeGreaterThan(0);
  });

  it('设计里的八类终止 + 三条 run-store 终止状态都在名册上', () => {
    const designEight = [
      'success',
      'failure',
      'interrupted',
      'timeout',
      'manual_stop',
      'crash_recovery',
      'permission_or_payment_or_tool_failure',
      'child_agent_blocked',
    ];
    for (const k of designEight) expect(CLOSURE_TERMINAL_KINDS).toContain(k);
    // 名册**高于**最低要求: needs_human / awaiting_external 也是 Run 的结束, 也必须收尾
    expect(closureTerminalKindFor('needs_human')).toBe('escalated_to_human');
    expect(closureTerminalKindFor('awaiting_external')).toBe('awaiting_external');
  });

  it('终止状态清单 = RunStatus 全集 (不重不漏), 且不含"还在飞"的状态', () => {
    const ALL_RUN_STATUSES = [
      'queued', 'running', 'recovering', 'paused', 'awaiting_external',
      'done', 'failed', 'aborted', 'interrupted', 'stalled', 'needs_human',
    ];
    const union = [...RUN_TERMINAL_STATUSES, ...RUN_IN_FLIGHT_STATUSES];
    expect([...union].sort()).toEqual([...ALL_RUN_STATUSES].sort());
    for (const s of RUN_TERMINAL_STATUSES) expect(RUN_IN_FLIGHT_STATUSES as readonly string[]).not.toContain(s);
    // 每个**终止**状态都有主归属; 还在飞的两个没有 (它们在飞, 谈不上终止路径)
    for (const s of RUN_TERMINAL_STATUSES) expect(closureTerminalKindFor(s)).not.toBeNull();
    for (const s of RUN_IN_FLIGHT_STATUSES) expect(closureTerminalKindFor(s)).toBeNull();
  });

  it('实测回归: recovering 必须被登记 (中断恢复路径收尾时 Run 就是 recovering)', () => {
    expect(closureTerminalKindFor('recovering')).toBe('interrupted');
    expect(terminalKindAccepts('interrupted', 'recovering').ok).toBe(true);
    expect(terminalKindAccepts('crash_recovery', 'recovering').ok).toBe(true);
  });

  it('阴性对照 ①: 拿掉 escalated_to_human → needs_human 立刻无人认领', () => {
    const pruned = CLOSURE_TERMINAL_PATHS.filter((p) => p.kind !== 'escalated_to_human');
    const cov = terminalRegistryCoverage(pruned);
    expect(cov.unmappedStatuses).toContain('needs_human');
    expect(cov.unmappedStatuses).not.toContain('stalled');
  });

  it('阴性对照 ②: 把 seams.ts 上的某条路径改名 → 引用不存在 + 无人认领 同时出现', () => {
    const DEAD = '失败 / 中断恢复 (Runner 内 finishRun)';
    // 这条路径被多条终止路径共用 → 必须**全部**改名, 否则它仍被别的条目认领 (这本身也是自检该有的行为)
    const renamed = CLOSURE_TERMINAL_PATHS.map((p) =>
      p.seamLabels.includes(DEAD) ? { ...p, seamLabels: p.seamLabels.map((l) => (l === DEAD ? '改名后的路径 (不存在)' : l)) } : p,
    );
    const cov = terminalRegistryCoverage(renamed);
    expect(cov.unknownSeamLabels).toContain('改名后的路径 (不存在)');
    expect(cov.unclaimedSeamLabels).toContain(DEAD);
    // 只改一条 (别的条目还认领着它) → 不该出现"无人认领"的假信号
    const partial = CLOSURE_TERMINAL_PATHS.map((p) => (p.kind === 'failure' ? { ...p, seamLabels: ['只改了 failure 这一条'] } : p));
    const partialCov = terminalRegistryCoverage(partial);
    expect(partialCov.unknownSeamLabels).toContain('只改了 failure 这一条');
    expect(partialCov.unclaimedSeamLabels).toEqual([]);
  });

  it('申报的终止路径必须与 Run 事实一致 (不许把失败报成成功)', () => {
    expect(terminalKindAccepts('success', 'done').ok).toBe(true);
    const bad = terminalKindAccepts('success', 'failed');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('申报与 Run 事实不符');
    // 同一个出口的三类失败: 申报时各写各的 (failed 状态下都合法, 但语义不同)
    for (const k of ['timeout', 'permission_or_payment_or_tool_failure', 'failure', 'escalated_to_human'] as const) {
      expect(terminalKindAccepts(k, 'failed').ok).toBe(k !== 'escalated_to_human');
    }
  });

  it('候选落盘根与 M0 接线层逐字相同 (漂移就判红, 不靠人记得改两处)', async () => {
    const wiring = await import('../agents/goal-flywheel-wiring.js');
    expect(SKILL_CANDIDATES_ROOT).toBe(wiring.SKILL_CANDIDATES_ROOT);
  });
});

// ---------------------------------------------------------------------------
// §2 收尾产物审计 (纯): 缺什么就点名什么
// ---------------------------------------------------------------------------

function goodView(over: Partial<ClosureOutcomeView> = {}): ClosureOutcomeView {
  const decision = 'continue';
  const state = (GOAL_STATE_FOR_DECISION as any)[decision];
  return {
    runId: 'run-x',
    goalId: 'g-x',
    steps: CLOSURE_STEP_ORDER.length,
    decision: { decisionId: 'decision:g-x:run-x', decision } as any,
    continuation: { state, nextAction: '接着写数据', updatedAt: NOW } as any,
    userReport: {
      conclusion: '本轮通过',
      completed: ['写好报告目录'],
      evidence: ['step:1'],
      remaining: ['判据 1'],
      blockReasons: [],
      nextStep: '接着写数据',
      willContinue: true,
      expectedResumeAt: null,
      visibleState: USER_VISIBLE_STATES[0],
      exposedFields: [...USER_REPORT_FIELDS],
      generatedAt: NOW,
    } as any,
    runStatus: 'done',
    memories: 2,
    candidates: 1,
    reportPath: '/h/.bolloon/goal-reports/g-x--run-x.json',
    decisionRecordPath: '/h/.bolloon/goal-decisions/g-x--run-x--closure.json',
    ...over,
  } as ClosureOutcomeView;
}

describe('§2 收尾产物审计: 完整 → 绿; 缺一项 → 点名判红', () => {
  it('产物齐 + 申报成功路径 → complete, 缺项清单为空', () => {
    const audit = auditClosureOutcome(goodView(), { now: NOW, claimedKind: 'success' });
    expect(audit.missing).toEqual([]);
    expect(audit.complete).toBe(true);
    expect(audit.terminalKind.derived).toBe('success');
    expect(audit.terminalKind.truthful).toBe(true);
  });

  const DEFECTS: { name: string; view: Partial<ClosureOutcomeView>; expect: string; needle: string }[] = [
    { name: '步数只有 8 → steps', view: { steps: CLOSURE_STEP_ORDER.length - 1 }, expect: 'steps', needle: '只走了' },
    { name: '缺决策 → decision', view: { decision: undefined as any }, expect: 'decision', needle: '继续决策缺失' },
    { name: '决策取值不合法 → decision', view: { decision: { decisionId: 'd', decision: '自我宣称完成' } as any }, expect: 'decision', needle: '不合法' },
    {
      name: 'continuation.state 与决策不自洽 → continuation_state',
      view: { continuation: { state: 'ended', nextAction: 'x', updatedAt: NOW } as any },
      expect: 'continuation_state',
      needle: '与决策',
    },
    {
      name: 'continuation 是上一轮的 (时间戳不对) → continuation_time',
      view: { continuation: { state: (GOAL_STATE_FOR_DECISION as any).continue, nextAction: 'x', updatedAt: '2026-01-01T00:00:00.000Z' } as any },
      expect: 'continuation_time',
      needle: '不是这一轮的时间',
    },
    {
      name: '没有下一步 (悬空态) → next_action',
      view: { continuation: { state: (GOAL_STATE_FOR_DECISION as any).continue, nextAction: '   ', updatedAt: NOW } as any },
      expect: 'next_action',
      needle: '悬空态',
    },
    { name: '用户可见态不在六类里 → user_report', view: { userReport: { ...goodView().userReport, visibleState: 'debug_internal' } as any }, expect: 'user_report', needle: '不在六类里' },
    {
      name: '汇报面比 USER_REPORT_FIELDS 多一项 → user_report',
      view: { userReport: { ...goodView().userReport, exposedFields: [...USER_REPORT_FIELDS, 'lease'] } as any },
      expect: 'user_report',
      needle: '暴露面与 USER_REPORT_FIELDS',
    },
    {
      name: '汇报里出现内部字段 → user_report',
      view: { userReport: { ...goodView().userReport, [MUST_NOT_EXPOSE_FIELDS[0]]: 'x' } as any },
      expect: 'user_report',
      needle: '内部字段',
    },
    { name: '没有产物路径 → artifact_paths', view: { reportPath: '' }, expect: 'artifact_paths', needle: '产物路径' },
  ];

  it.each(DEFECTS)('缺陷: $name', ({ view, expect: kind, needle }) => {
    const audit = auditClosureOutcome(goodView(view), { now: NOW, claimedKind: 'success' });
    expect(audit.complete).toBe(false);
    expect(audit.missing).toContain(kind);
    // 缺口必须**说得出为什么** (结构化原因, 不是 boolean)
    expect(audit.reasons.join(' | ')).toContain(needle);
  });

  it('申报路径与事实不符 → terminal_kind 判红 (承诺了什么也是事实的一部分)', () => {
    const audit = auditClosureOutcome(goodView({ runStatus: 'failed' }), { now: NOW, claimedKind: 'success' });
    expect(audit.missing).toContain('terminal_kind');
    expect(audit.terminalKind.truthful).toBe(false);
    expect(audit.terminalKind.reason).toContain('申报与 Run 事实不符');
  });

  it('没有登记的状态 → terminal_kind 判红 (新状态必须跟着进名册)', () => {
    const audit = auditClosureOutcome(goodView({ runStatus: 'quantum_state' }), { now: NOW });
    expect(audit.missing).toContain('terminal_kind');
    expect(audit.terminalKind.reason).toContain('名册必须跟着补');
  });

  it('还在飞的状态收尾 → 不判缺口 (如实记 note, 不是"收好了")', () => {
    const audit = auditClosureOutcome(goodView({ runStatus: 'running' }), { now: NOW });
    expect(audit.missing).toEqual([]);
    expect(audit.notes.join(' | ')).toContain('run_status_in_flight');
  });

  it('值里的自由文本提到内部词 → 只记 note, 不判红 (本接缝不改写值)', () => {
    const audit = auditClosureOutcome(
      goodView({ userReport: { ...goodView().userReport, conclusion: `已重试 (${MUST_NOT_EXPOSE_FIELDS[3]}=3)` } as any }),
      { now: NOW, claimedKind: 'success' },
    );
    expect(audit.complete).toBe(true);
    expect(audit.notes.join(' | ')).toContain('report_text_mentions_internal_words');
  });

  it('拿不到收尾产物 → 判红, 且不编造 (missing 结构化)', () => {
    const audit = auditClosureOutcome(null, { now: NOW });
    expect(audit.complete).toBe(false);
    expect(audit.missing).toContain('artifact_paths');
    expect(audit.reasons.join(' ')).toContain('no_outcome');
  });

  it('盘上那一半: 文件不在 / 记忆不在分层目录 / 落错层 / 候选范围不安全 → 各自判红', () => {
    const base = { scanned: true, home: '/h', reportFile: true, decisionRecordFile: true, memoryFiles: 2, layerMismatches: [], candidateFiles: 1, trialScopeViolations: [], notes: [] };
    const cases: { probe: any; kind: string }[] = [
      { probe: { ...base, reportFile: false }, kind: 'artifact_files' },
      { probe: { ...base, decisionRecordFile: false }, kind: 'artifact_files' },
      { probe: { ...base, memoryFiles: 0 }, kind: 'memory_layers' },
      { probe: { ...base, layerMismatches: ['facts/x.json: 记录里的 layer=lessons (落错层)'] }, kind: 'memory_layers' },
      { probe: { ...base, trialScopeViolations: ['c.json: snapshotScope=all_runs'] }, kind: 'candidate_trial_scope' },
    ];
    for (const { probe, kind } of cases) {
      const audit = auditClosureOutcome(goodView(), { now: NOW, claimedKind: 'success', probe });
      expect(audit.complete).toBe(false);
      expect(audit.missing).toContain(kind);
    }
    // 读盘没成功 → 如实说"这项没验", 但**不**判红 (不假装收好, 也不假装没收)
    const unscanned = auditClosureOutcome(goodView(), { now: NOW, claimedKind: 'success', probe: { ...base, scanned: false, notes: [] } });
    expect(unscanned.complete).toBe(true);
    expect(unscanned.notes.join(' | ')).toContain('artifact_disk_check_skipped');
  });

  it('收尾报告说写了 N 条事实、盘上没有 → 判红 (报告与盘不许各说各话)', () => {
    const audit = auditClosureOutcome(goodView({ memories: 3 }), {
      now: NOW, claimedKind: 'success',
      probe: { scanned: true, home: '/h', reportFile: true, decisionRecordFile: true, memoryFiles: 0, layerMismatches: [], candidateFiles: 0, trialScopeViolations: [], notes: [] },
    });
    expect(audit.missing).toContain('memory_layers');
  });

  it('缺失面清单本身不许缩水 (断言只加不减)', () => {
    // 未扫盘时, 缺项只可能来自"结果面"; 扫盘后才有产物面 —— 两者都必须是 CLOSURE_ARTIFACT_KINDS 的子集
    const audit = auditClosureOutcome(goodView(), { now: NOW, claimedKind: 'success' });
    for (const k of audit.missing) expect(CLOSURE_ARTIFACT_KINDS).toContain(k);
    // 结果面的四类关键缺口必须存在 (步/决策/下一步/用户汇报/终止路径/产物路径)
    expect(CLOSURE_ARTIFACT_KINDS).toEqual(expect.arrayContaining(['steps', 'decision', 'next_action', 'continuation_state', 'user_report', 'terminal_kind', 'artifact_paths', 'memory_layers', 'candidate_trial_scope']));
  });
});

// ---------------------------------------------------------------------------
// §3 真跑: 所有终止路径必经收尾 (真 Store + 隔离 HOME + 真落盘)
// ---------------------------------------------------------------------------

const TERMINAL_CASES: { status: string; kind: string | null }[] = [
  { status: 'done', kind: 'success' },
  { status: 'failed', kind: 'failure' },
  { status: 'interrupted', kind: 'interrupted' },
  { status: 'recovering', kind: 'interrupted' },
  { status: 'stalled', kind: 'stall' },
  { status: 'paused', kind: 'manual_stop' },
  { status: 'aborted', kind: 'manual_stop' },
  { status: 'needs_human', kind: 'escalated_to_human' },
  { status: 'awaiting_external', kind: 'awaiting_external' },
];

describe('§3 真跑: 每条终止路径都过收尾, 产物真落盘', () => {
  it.each(TERMINAL_CASES)('终止状态 $status → 收尾生成完整产物 (推导路径=$kind)', async ({ status, kind }) => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: `以 ${status} 结束的 Run 也要收尾`, successCriteria: ['有收尾记录'] });
    const runId = await seedRun(rs, gs, g.goalId, { status, error: status === 'done' ? undefined : `${status}: 由测试造的事实` });

    const out: any = await wiring.flywheelSeams().closure.closeRunOnce({
      goalId: g.goalId,
      runId,
      caller: 'supervisor',
      now: NOW,
      finalReview: FINAL_REVIEW,
    });

    expect(isRefusal(out)).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.receipt.audit.missing).toEqual([]);
    expect(out.artifactsComplete).toBe(true);
    expect(out.receipt.steps).toBe(CLOSURE_STEP_ORDER.length);
    expect(out.receipt.runId).toBe(runId);
    expect(out.receipt.derivedTerminalKind).toBe(kind);
    expect(out.receipt.terminalKindTruthful).toBe(true);
    expect(out.receipt.decision).toBeTruthy();

    // 产物**真落盘** (不是只在返回值里)
    expect(out.receipt.artifacts.reportOnDisk).toBe(true);
    expect(out.receipt.artifacts.decisionRecordOnDisk).toBe(true);
    expect(await fs.stat(out.receipt.artifacts.reportPath).then(() => true, () => false)).toBe(true);
    expect(await fs.stat(out.receipt.artifacts.decisionRecordPath).then(() => true, () => false)).toBe(true);
    expect(await wiring.hasClosureRecord(g.goalId, runId)).toBe(true);

    // 真读盘: 分层 Memory 里真的有属于这条 Run 的记录 (收尾不是空转)
    const probe = await probeClosureArtifacts(out.outcome);
    expect(probe.scanned).toBe(true);
    expect(probe.reportFile).toBe(true);
    expect(probe.decisionRecordFile).toBe(true);
    expect(probe.layerMismatches).toEqual([]);
    if (out.receipt.memories > 0) expect(probe.memoryFiles).toBeGreaterThan(0);
  });

  it('幂等: 同一条 Run 第二次收尾 → alreadyClosed 且**一个字节都没写**', async () => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: '幂等', successCriteria: ['只收一次'] });
    const runId = await seedRun(rs, gs, g.goalId, { status: 'done' });
    const seam = wiring.flywheelSeams().closure;

    const first: any = await seam.closeRunOnce({ goalId: g.goalId, runId, caller: 'runner', now: NOW, finalReview: FINAL_REVIEW });
    expect(first.ok).toBe(true);
    expect(first.alreadyClosed).toBe(false);
    const recordsAfterFirst = await wiring.readDecisionRecords(g.goalId);
    const reportsAfterFirst = await fs.readdir(path.join(TMP, wiring.GOAL_REPORTS_ROOT)).catch(() => [] as string[]);

    const second: any = await wiring.closeRunOnce({ goalId: g.goalId, runId, caller: 'supervisor', now: NOW, finalReview: FINAL_REVIEW });
    expect(isRefusal(second)).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.alreadyClosed).toBe(true);
    expect(second.receipt).toBeNull();          // 幂等短路不产出新收据
    expect(second.outcome).not.toBeNull();      // 但**不丢事实**: 把那次收尾读回来
    expect(second.reason).toContain('已收尾');
    expect((await wiring.readDecisionRecords(g.goalId)).length).toBe(recordsAfterFirst.length);
    expect((await fs.readdir(path.join(TMP, wiring.GOAL_REPORTS_ROOT)).catch(() => [] as string[])).length).toBe(reportsAfterFirst.length);
  });

  it('负控制: 四个说不清的收尾全部**真拒**, 且不写任何东西', async () => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: '拒绝的收尾不许写', successCriteria: ['没有产物'] });
    const runId = await seedRun(rs, gs, g.goalId, { status: 'done' });
    const seam = wiring.flywheelSeams().closure;

    const cases: { name: string; input: any; rule?: string; expect: string }[] = [
      { name: '子 Agent 收尾', input: { goalId: g.goalId, runId, caller: 'child_agent', now: NOW }, rule: 'child_cannot_mutate_goal', expect: '子 Agent 不能收尾' },
      { name: '未知调用方', input: { goalId: g.goalId, runId, caller: 'some_new_loop', now: NOW }, expect: '不是已知身份' },
      { name: '未知终止路径', input: { goalId: g.goalId, runId, caller: 'supervisor', now: NOW, terminalKind: 'made_up_path' }, expect: '不是名册上的终止路径' },
      { name: '没有时间戳', input: { goalId: g.goalId, runId, caller: 'supervisor', now: undefined }, expect: '没有时间戳' },
      { name: '说不清哪条 Run', input: { goalId: g.goalId, runId: '', caller: 'supervisor', now: NOW }, expect: '缺少 runId' },
    ];
    for (const c of cases) {
      const out: any = await seam.closeRunOnce(c.input);
      expect(isRefusal(out), `${c.name} 必须真拒`).toBe(true);
      expect(out.reason).toContain(c.expect);
      if (c.rule) expect(out.rule).toBe(c.rule);
    }
    // 真拒 = 一个字节都没写
    expect(await wiring.hasClosureRecord(g.goalId, runId)).toBe(false);
    expect((await wiring.readDecisionRecords(g.goalId)).filter((r: any) => r.phase === 'closure').length).toBe(0);
    expect((await fs.readdir(path.join(TMP, wiring.GOAL_REPORTS_ROOT)).catch(() => [] as string[])).length).toBe(0);
    expect(WIRING_CALLERS).toContain('supervisor');
  });

  it('产物有缺口**不许**长得像"被拒" (协议陷阱: isRefusal 会把假拒当真拒)', async () => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: '假拒不许出现', successCriteria: ['拒与缺口分得清'] });
    const runId = await seedRun(rs, gs, g.goalId, { status: 'failed', error: 'EACCES' });

    // 申报成功路径 + Run 事实是 failed → 事实不符, 产物审计必有一点缺口
    const out: any = await wiring.flywheelSeams().closure.closeRunOnce({
      goalId: g.goalId, runId, caller: 'supervisor', now: NOW, finalReview: FINAL_REVIEW, terminalKind: 'success',
    });

    expect(isRefusal(out)).toBe(false);            // ★ 关键: 收尾真做了, 不许像"被拒"
    expect(out.ok).toBe(true);
    expect(out.artifactsComplete).toBe(false);
    expect(out.receipt.audit.missing).toContain('terminal_kind');
    expect(out.receipt.terminalKindTruthful).toBe(false);
    expect(String(out.reason)).toContain('收尾完成但产物有缺口');
    // 收尾照做 → 产物在盘上 (缺口只影响"产物完整性"这一个信号, 不回收尾事实)
    expect(await wiring.hasClosureRecord(g.goalId, runId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 真读盘 + 变异: 审计真的在查盘 (种进去的缺陷必须判红)
// ---------------------------------------------------------------------------

describe('§4 收尾产物真读盘 + 变异验证', () => {
  it('从真产物路径反推 home; 不是本仓布局就如实返回 null (不猜)', async () => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: '路径反推', successCriteria: ['反推对'] });
    const runId = await seedRun(rs, gs, g.goalId, { status: 'done' });
    const out: any = await wiring.flywheelSeams().closure.closeRunOnce({ goalId: g.goalId, runId, caller: 'system', now: NOW, finalReview: FINAL_REVIEW });

    expect(homeFromArtifactPath(out.receipt.artifacts.reportPath)).toBe(TMP);
    expect(homeFromArtifactPath(out.receipt.artifacts.decisionRecordPath)).toBe(TMP);
    expect(homeFromArtifactPath('/etc/passwd')).toBeNull();
    expect(homeFromArtifactPath('/a/b/c/x.json')).toBeNull();               // 三层但不是 .bolloon 布局
    expect(homeFromArtifactPath('relative/.bolloon/goal-reports/x.json')).toBeNull();
    expect(homeFromArtifactPath(undefined)).toBeNull();
  });

  it('变异: 往真 HOME 种"落错层的记忆"与"范围不安全的候选" → 审计判红; 清掉 → 回绿', async () => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: '审计变异', successCriteria: ['种进去必须红'] });
    const runId = await seedRun(rs, gs, g.goalId, { status: 'done' });
    const out: any = await wiring.flywheelSeams().closure.closeRunOnce({ goalId: g.goalId, runId, caller: 'system', now: NOW, finalReview: FINAL_REVIEW });
    expect(out.artifactsComplete).toBe(true);

    // ── 种 ①: 一条落错层的记忆 (目录是 run_fact, 记录里写 lesson) ────────────
    const layerDir = MEMORY_LAYERS[0];               // 真的分层目录名 (从冻结面取, 不猜)
    const otherLayer = MEMORY_LAYERS[1];
    const mislaid = path.join(TMP, '.bolloon/memory-layers', layerDir, 'm2-mislaid.json');
    await fs.mkdir(path.dirname(mislaid), { recursive: true });
    await fs.writeFile(mislaid, JSON.stringify({ memoryId: 'm2-mislaid', layer: otherLayer, runId, text: '落错层' }), 'utf8');
    // ── 种 ②: 一份"作用于运行中的 Run"的候选 (范围不安全) ───────────────────
    const unsafe = path.join(TMP, '.bolloon/skill-candidates', 'm2-unsafe.json');
    await fs.mkdir(path.dirname(unsafe), { recursive: true });
    await fs.writeFile(unsafe, JSON.stringify({ candidateId: 'm2-unsafe', proposedByRunId: runId, snapshotScope: 'all_runs', appliesToRunningRun: true }), 'utf8');

    const dirty = await probeClosureArtifacts(out.outcome);
    expect(dirty.scanned).toBe(true);
    expect(dirty.layerMismatches.join(' ')).toContain('m2-mislaid');
    expect(dirty.trialScopeViolations.join(' ')).toContain('m2-unsafe');
    const dirtyAudit = auditClosureOutcome(out.outcome, { now: NOW, claimedKind: 'success', probe: dirty });
    expect(dirtyAudit.complete).toBe(false);
    expect(dirtyAudit.missing).toContain('memory_layers');
    expect(dirtyAudit.missing).toContain('candidate_trial_scope');

    // ── 清掉 → 回绿 (证明它查的是盘, 不是恒红/恒绿) ─────────────────────────
    await fs.rm(mislaid, { force: true });
    await fs.rm(unsafe, { force: true });
    const clean = await probeClosureArtifacts(out.outcome);
    expect(clean.layerMismatches).toEqual([]);
    expect(clean.trialScopeViolations).toEqual([]);
    expect(auditClosureOutcome(out.outcome, { now: NOW, claimedKind: 'success', probe: clean }).complete).toBe(true);
  });

  it('终止覆盖审计: 真终止过却没收尾的 Run → 缺口点名; 未知路径 → 缺口', async () => {
    const { gs, rs, wiring } = await mods();
    wiring.resetFlywheelSeamsForTest();
    const g = await gs.createGoal({ objective: '终止覆盖', successCriteria: ['缺口可见'] });

    const closed = await seedRun(rs, gs, g.goalId, { status: 'done' });
    await wiring.flywheelSeams().closure.closeRunOnce({ goalId: g.goalId, runId: closed, caller: 'supervisor', now: NOW, finalReview: FINAL_REVIEW });
    const neverClosed = await seedRun(rs, gs, g.goalId, { status: 'failed', error: '没收尾就没了' });

    const report = await auditTerminalCoverage({
      terminations: [
        { goalId: g.goalId, runId: closed, kind: 'success', terminatedAt: NOW },
        { goalId: g.goalId, runId: neverClosed, kind: 'failure', terminatedAt: NOW },
        { goalId: g.goalId, runId: 'run-不存在', kind: 'made_up' as any, terminatedAt: NOW },
      ],
      hasClosure: (goalId: string, runId: string) => wiring.hasClosureRecord(goalId, runId),
    });

    expect(report.checked).toBe(3);
    expect(report.covered).toEqual([closed]);
    expect(report.gaps.length).toBe(2);
    const gapDirs = report.gaps.map((x) => x.runId);
    expect(gapDirs).toContain(neverClosed);
    expect(gapDirs).toContain('run-不存在');
    expect(report.gaps.find((x) => x.runId === neverClosed)!.reason).toContain('绕过了唯一责任链');
    expect(report.gaps.find((x) => x.runId === 'run-不存在')!.kind).toBe('unknown_kind');
  });
});

// ---------------------------------------------------------------------------
// §5 Skill 升级通道: 六阶段梯子 (准入不是晋升)
// ---------------------------------------------------------------------------

/** 健康候选 (过 ①–⑤ 全部判据) */
function healthyCandidate(over: Partial<SkillImprovementCandidate> = {}): SkillImprovementCandidate {
  return {
    candidateId: 'cand-m2-1',
    name: 'probe-before-config-change',
    purpose: '改配置前先打一次只读探针, 确认当前行为再动手',
    sourceRunIds: ['run-12', 'run-13'],
    evidenceRefs: ['step:3', 'sha256:cafe0001', 'run-13/step:5'],
    failureCases: ['目标进程不提供只读探针端点时无法使用'],
    inputSchema: 'bolloon-probe-input/1',
    outputSchema: 'bolloon-probe-output/1',
    guarantees: ['在改动前拿到当前行为基线'],
    doesNotGuarantee: ['不保证覆盖全部配置项'],
    contentHash: 'sha256:cafe0001',
    approval: { state: 'pending', approvedBy: null, approvedAt: null, changeReason: null } as any,
    status: 'pending_review' as any,
    occurrences: 3,
    boundaryClear: true,
    junkReasons: [],
    proposedAt: NOW,
    proposedByRunId: 'run-12',
    ...over,
  } as SkillImprovementCandidate;
}

describe('§5 Skill 升级通道: 结构化 → schema → 去重 → 权限 → next_run_only 试用 → 复用后才提升', () => {
  it('阶梯顺序就是冻结顺序 (改顺序 = 换通道)', () => {
    expect(SKILL_CHANNEL_STAGES).toEqual(['structure', 'schema_validation', 'dedup', 'permission', 'trial_snapshot', 'reuse_confirmation']);
  });

  it('健康候选: 六阶段逐条给裁决, 准入**不是**晋升 (promotion 恒 null, ⑥ 是 pending)', () => {
    const adm = openSkillTrial({ candidate: healthyCandidate(), existing: [], requestedBy: 'closure', now: NOW });
    expect(adm.ok).toBe(true);
    expect(adm.promotion).toBeNull();
    expect(adm.stages.length).toBe(SKILL_CHANNEL_STAGES.length);
    expect(adm.stages.map((s) => s.stage)).toEqual([...SKILL_CHANNEL_STAGES]);
    expect(adm.stages.filter((s) => s.status === 'pass').map((s) => s.stage)).toEqual(['structure', 'schema_validation', 'dedup', 'permission', 'trial_snapshot']);
    expect(adm.stages.find((s) => s.stage === 'reuse_confirmation')!.status).toBe('pending');
    // 试用范围恒为 next_run_only —— 不覆盖正在执行的 snapshot (类型级陈述的运行时证据)
    expect(adm.trial!.snapshotScope).toBe('next_run_only');
    expect(adm.trial!.appliesToRunningRun).toBe(false);
    expect(adm.trial!.status).toBe('trialing');
    expect(adm.trial!.startedByRunId).toBe('run-12');
  });

  const REFUSALS: { name: string; candidate?: Partial<SkillImprovementCandidate>; requestedBy?: string; existing?: any[]; stage: string; expect: string }[] = [
    { name: '只成功过一次 → 结构化就拦住', candidate: { occurrences: 1 }, stage: 'structure', expect: 'occurrences' },
    { name: '没有失败边界 → 结构化拦住', candidate: { failureCases: [] }, stage: 'structure', expect: 'failureCases' },
    { name: '契约是占位符 → schema 拦住', candidate: { inputSchema: 'TBD' }, stage: 'schema_validation', expect: 'placeholder' },
    { name: '契约括号残缺 → schema 拦住', candidate: { outputSchema: '{ criteria: string[]' }, stage: 'schema_validation', expect: 'unbalanced' },
    // 完全重复 (同名 + 同 contentHash) 在 ① 就被垃圾门拦下 (`duplicate_of_existing` 是冻结面判据),
    // 到不了 ③ —— ③ 处理的是"同名不同内容"与"批内重名"。这里如实记这一点。
    { name: '与已有 Skill 内容完全相同 → ①结构 就用垃圾门拦住', existing: [{ name: 'probe-before-config-change', contentHash: 'sha256:cafe0001', version: '1.2.3' }], stage: 'structure', expect: 'duplicate_of_existing' },
    { name: '同批重名 → ③去重拦住', candidate: { name: 'dup-in-batch' }, existing: [], stage: 'dedup', expect: '' },
    { name: '请求者是子 Agent → 权限拦住', requestedBy: 'child_agent', stage: 'permission', expect: 'child_cannot_open_trial' },
    { name: '请求者身份不明 → 权限拦住', requestedBy: 'unknown_loop', stage: 'permission', expect: 'unknown_actor' },
    { name: '草案指向正式 skills 目录 → 权限拦住', candidate: { purpose: '把结果写进 .bolloon/skills 下的正式目录' }, stage: 'permission', expect: 'writes_formal_skill_dir' },
    { name: '草案带提权动作 → 权限拦住', candidate: { guarantees: ['用 sudo 写好配置'] }, stage: 'permission', expect: 'privilege_escalation' },
    { name: '说不清是哪条 Run 提的 → 试用阶段拦住', candidate: { proposedByRunId: '' }, stage: 'trial_snapshot', expect: 'trial_without_run_id' },
  ];

  it.each(REFUSALS)('负控制: $name', ({ candidate, requestedBy, existing, stage, expect: needle }) => {
    const c = healthyCandidate(candidate ?? {});
    const siblings = (candidate ?? {}).name === 'dup-in-batch' ? [healthyCandidate({ name: 'dup-in-batch' })] : [];
    const adm = openSkillTrial({
      candidate: c,
      existing: existing ?? [],
      siblings,
      requestedBy: requestedBy ?? 'closure',
      now: NOW,
    });
    expect(adm.ok).toBe(false);
    expect(adm.refusal!.stage).toBe(stage);
    expect(adm.trial).toBeNull();                    // 被拦就不许有试用位
    expect(adm.promotion).toBeNull();
    if (needle) expect(adm.refusal!.reason).toContain(needle);
    // 被拒之后的下游阶段是 not_reached (不是"省略"): 事实要看得见
    const idx = SKILL_CHANNEL_STAGES.indexOf(stage as any);
    for (const s of adm.stages.slice(idx + 1)) expect(s.status).toBe('not_reached');
  });

  it('时间必须注入 (不许读真实钟): 非法 now → 拦住', () => {
    const adm = openSkillTrial({ candidate: healthyCandidate(), existing: [], requestedBy: 'closure', now: 'not-a-time' as any });
    expect(adm.ok).toBe(false);
    expect(adm.refusal!.reason).toContain('invalid_now');
  });

  const trial = () => openSkillTrial({ candidate: healthyCandidate(), existing: [], requestedBy: 'closure', now: NOW }).trial!;

  it('⑥ 提升的唯一出口: 复用成功 + 带证据 + 另一条 Run + 批准人/变更原因 才提升', () => {
    const t = trial();
    const settled = settleSkillTrial({
      trial: t,
      candidate: healthyCandidate(),
      reuse: { runId: 'run-13', succeeded: true, evidenceRefs: ['step:7', 'sha256:beef'], approvedBy: 'leo', changeReason: '下一条 Run 复用成功, 收敛为正式 Skill', now: '2026-09-26T11:00:00.000Z' },
    });
    expect(settled.ok).toBe(true);
    expect(settled.status).toBe('promoted');
    expect(settled.trial.status).toBe('promoted');
    expect(settled.trial.trialRunId).toBe('run-13');
    expect(settled.promotion).not.toBeNull();
    expect(settled.promotion!.contentHash).toBe('sha256:cafe0001');
    expect((settled.promotion as any).snapshotScope).toBe('next_run_only');
    expect(settled.promotion!.toVersion).toBe('1.0.0');
  });

  const NO_PROMOTION: { name: string; reuse: any; status: string; expect: string }[] = [
    { name: '同一条 Run 自己说自己成功 → 不提升', reuse: { runId: 'run-12', succeeded: true, evidenceRefs: ['step:9'], approvedBy: 'leo', changeReason: 'x', now: NOW }, status: 'trialing', expect: 'same_run_cannot_promote' },
    { name: '下一条 Run 复用失败 → 回退不提升', reuse: { runId: 'run-13', succeeded: false, evidenceRefs: ['step:9'], approvedBy: 'leo', changeReason: 'x', now: NOW }, status: 'rolled_back', expect: 'trial_reuse_failed' },
    { name: '复用成功但**无证据** → 留在试用位', reuse: { runId: 'run-13', succeeded: true, evidenceRefs: [], approvedBy: 'leo', changeReason: 'x', now: NOW }, status: 'trialing', expect: 'reuse_without_evidence' },
    { name: '没有批准人/变更原因 → 不提升 (draftPromotion 抛错被接住)', reuse: { runId: 'run-13', succeeded: true, evidenceRefs: ['step:7'], approvedBy: '', changeReason: '', now: NOW }, status: 'trialing', expect: 'promotion_refused' },
  ];

  it.each(NO_PROMOTION)('⑥ 负控制: $name', ({ reuse, status, expect: needle }) => {
    const settled = settleSkillTrial({ trial: trial(), candidate: healthyCandidate(), reuse });
    expect(settled.ok).toBe(false);
    expect(settled.promotion).toBeNull();
    expect(settled.status).toBe(status);
    expect(settled.reason).toContain(needle);
  });

  it('⑥ 负控制: 拿另一份内容冒充 (contentHash 不一致) → 不提升', () => {
    const settled = settleSkillTrial({
      trial: trial(),
      candidate: healthyCandidate({ contentHash: 'sha256:换了内容' }),
      reuse: { runId: 'run-13', succeeded: true, evidenceRefs: ['step:7'], approvedBy: 'leo', changeReason: 'x', now: NOW },
    });
    expect(settled.ok).toBe(false);
    expect(settled.reason).toContain('candidate_content_hash_mismatch');
  });

  it('⑥ 负控制: 已结算过的试用不许重复结算 (幂等由状态保证)', () => {
    const promoted = settleSkillTrial({
      trial: trial(),
      candidate: healthyCandidate(),
      reuse: { runId: 'run-13', succeeded: true, evidenceRefs: ['step:7'], approvedBy: 'leo', changeReason: 'x', now: NOW },
    });
    const again = settleSkillTrial({ trial: promoted.trial, candidate: healthyCandidate(), reuse: { runId: 'run-14', succeeded: true, evidenceRefs: ['step:8'], approvedBy: 'leo', changeReason: 'y', now: NOW } });
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('not_trialing');
    expect(again.promotion).toBeNull();
  });
});

// 变异验证 (2026-09-26 实跑; 手改主不变量 → 判红 → 按原样改回 → 63/63 全绿):
//   ① `closure.ts` 的 RUN_TERMINAL_STATUSES 里删掉整行 `'recovering',`
//      → **1 条**判红 (§1「终止状态清单 = RunStatus 全集」: 少了它就说不清全集)
//      (注: §3 recovering 用例仍绿 —— 因为 interrupted 路径的 runStatuses 里也列了 recovering;
//       这条细绳是故意的: 名册的"状态全集"与"路径归属"是两个不同判据)
//   ② `closure.ts` 的 `closureTerminalKindFor` 里把 `p.primary === true` 改成 `=== false`
//      → **14 条**判红 (§1 三条 + §2 一条 + §3 九条 + §4 一条): 推导不出终止路径 = 每条路径都收不清
//   ③ `closure.ts` 的候选范围检查里把 `scope !== 'next_run_only' || applies !== false`
//      改成 `scope === '__never__' || applies === false`
//      → **1 条**判红 (§4「种进去的不安全候选」: candidate_trial_scope 缺口消失)
//   ④ `skill-candidate.ts` 的 `openSkillTrial` ⑥ 里把 `status: 'pending'` 改成 `status: 'pass'`
//      → **1 条**判红 (§5「准入不是晋升」: ⑥ 被假装成已通过)
// (四处改动均已按原样恢复; 恢复后 tsc 0 错 + 本文件 63/63 绿)
