/**
 * 门: P3 阻塞监控 (`src/agents/goal-flywheel/work-monitor.ts`) 的**行为**不变式。
 *
 * 与 `goal-flywheel-types.test.ts`(纯类型冻结门) 的分工: 那份钉接口形状, 这份钉**判定是否真的对**:
 *   ① 健康的子 Agent **不产生**任何阻塞 (不误报) —— 负控制
 *   ② 心跳超时的**接管前提**: 只有「执行权空闲 + 合同明确允许」才可接管, 否则上报父
 *   ③ 无进展的**两段规则**: 先发一次调整指令, 二档才停/换人 (不是一上来就换)
 *   ④ 报告缺失/不完整 **不接受为完成**: 无证据 · 缺必备证据 · 自称 blocked 无 blockReason · 张冠李戴
 *   ⑤ 工具/资源被阻只允许「父改计划 / 转人工」, **永不** 接管/替换/绕过 Harness
 *   ⑥ 用户可见只有六类 (2026-09-25 补终态 `ended`), 且**终态目标是 `ended`, 绝不说成"正在执行"**; 已解决的阻塞不进用户态
 *   ⑦ 确定性: 判定顺序固定 · 同输入幂等 (blockId 稳定) · 时间读不出就不判定 (宁可漏报)
 *
 * 阴性对照 (怎么知道这道门不是空转): 见文件末尾 `describe('变异验证')` 的说明 ——
 * 改坏「无进展二档」或「终态不许 executing」任一条, 本文件必须判红 (实测见交付报告)。
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ESCALATION_MS,
  DEFAULT_REPORT_GRACE_MS,
  HEARTBEAT_MISS_MULTIPLE,
  NO_PROGRESS_FALLBACK_MS,
  NO_PROGRESS_HEARTBEAT_MULTIPLE,
  REPORT_GRACE_HEARTBEAT_MULTIPLE,
  ADJUSTMENT_ALREADY_GIVEN_MULTIPLE,
  BLOCK_HANDLING_DEFAULTS,
  USER_VISIBLE_STATE_FOR_BLOCK_KIND,
  detectBlocks,
  planBlockHandling,
  toUserVisibleState,
} from '../agents/goal-flywheel/work-monitor.js';
import type { DetectBlocksInput } from '../agents/goal-flywheel/work-monitor.js';
import {
  BLOCK_KINDS,
  BLOCK_RESOLUTION_ACTIONS,
  MUST_NOT_EXPOSE_FIELDS,
  USER_VISIBLE_STATES,
} from '../agents/goal-flywheel/types.js';
import type {
  AgentWorkContract,
  AgentWorkReport,
  BlockKind,
  BlockRecord,
  BlockResolutionAction,
  ContinuationDecision,
  GoalContinuationRecord,
} from '../agents/goal-flywheel/types.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW = '2026-09-25T12:00:00.000Z';
/** 合同是 10 分钟前签的 */
const ISSUED = '2026-09-25T11:50:00.000Z';
const HB = 30_000;
const HEARTBEAT_WINDOW = HB * HEARTBEAT_MISS_MULTIPLE; // 60s
const NP_WINDOW = HB * NO_PROGRESS_HEARTBEAT_MULTIPLE; // 180s
const GRACE = HB * REPORT_GRACE_HEARTBEAT_MULTIPLE; // 60s

/** `NOW + offsetMs` 的 ISO 时间戳 */
function at(offsetMs: number, base: string = NOW): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function mkContract(over: Partial<AgentWorkContract> = {}): AgentWorkContract {
  return {
    workId: 'work-1',
    goalId: 'goal-1',
    parentRunId: 'run-1',
    childAgentId: 'child-a',
    capability: 'code-inspection',
    objective: '检查 P3 阻塞监控的判定是否成立',
    inputs: { scope: 'src/agents/goal-flywheel' },
    allowedTools: ['read_file', 'search_files'],
    budget: { maxSteps: null, maxDurationMs: null, maxAmount: null, currency: null },
    deadline: null,
    successCriteria: ['给出判定与反例'],
    reportSchema: 'bolloon-work-report/1',
    heartbeatIntervalMs: HB,
    failurePolicy: {
      onHeartbeatMiss: 'escalate',
      onBudgetExhausted: 'stop_and_report',
      onToolDenied: 'report',
      onRepeatedFailure: 'escalate',
    },
    cancelPolicy: {
      onParentCancel: 'graceful',
      graceMs: 5_000,
      preserveArtifacts: true,
      onParentGoalClosed: 'stop',
    },
    requiredEvidence: ['evidence:test-run'],
    issuedAt: ISSUED,
    issuedBy: 'parent-run-1',
    ...over,
  };
}

function mkReport(over: Partial<AgentWorkReport> = {}): AgentWorkReport {
  return {
    workId: 'work-1',
    childAgentId: 'child-a',
    status: 'completed',
    summary: '判定写完, 单测通过',
    evidence: [{ kind: 'evidence:test-run', ref: 'evidence:test-run', note: 'vitest 输出' }],
    artifacts: [{ name: 'work-monitor.ts', path: 'src/agents/goal-flywheel/work-monitor.ts', hash: null, cid: null, bytes: 123 }],
    checks: [{ name: 'tsc', verdict: 'pass', detail: '0 错' }],
    unresolvedItems: [],
    blockReason: null,
    nextRecommendation: '接线时把 blocks 交给父决策',
    durationMs: 42_000,
    reportedAt: at(-5_000),
    ...over,
  };
}

function mkBlock(over: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockId: 'blk:work-1:no_heartbeat',
    kind: 'no_heartbeat',
    goalId: 'goal-1',
    runId: 'run-1',
    workId: 'work-1',
    childAgentId: 'child-a',
    blockedAt: at(-60_000),
    lastProgressAt: at(-120_000),
    owner: 'parent',
    dependency: null,
    suggestedAction: 'escalate_parent',
    escalationAt: at(0),
    resolvedAt: null,
    resolution: null,
    note: '夹具',
    ...over,
  };
}

/** 子自报的阻塞记录 (子填的形状与父一样, 但父不照抄它的 owner/动作) */
function mkChildBlock(over: Partial<BlockRecord> = {}): BlockRecord {
  return mkBlock({
    blockId: 'child-said-so',
    kind: 'tool_blocked',
    childAgentId: 'child-a',
    blockedAt: at(-30_000),
    lastProgressAt: at(-90_000),
    owner: 'child',
    dependency: '外部 CDN 返回 429',
    suggestedAction: 'takeover',
    escalationAt: null,
    note: '拿不到依赖',
    ...over,
  });
}

function mkContinuation(over: Partial<GoalContinuationRecord> = {}): GoalContinuationRecord {
  return {
    nextAction: '继续核对剩余判据',
    wakeAt: null,
    wakeReason: '仍有未满足判据',
    autoContinue: true,
    requiredAgent: null,
    pendingReports: [],
    unresolvedItems: ['判据 2 未核'],
    lastDecisionId: 'dec-1',
    state: 'active',
    updatedAt: NOW,
    ...over,
  };
}

function mkDecision(over: Partial<ContinuationDecision> = {}): ContinuationDecision {
  return {
    decisionId: 'dec-1',
    goalId: 'goal-1',
    runId: 'run-1',
    decision: 'continue',
    state: 'progressing',
    reason: '本轮新增了可核验证据',
    nextAction: '继续跑下一轮',
    expectedOutcome: '判据 2 有结论',
    confidence: 0.8,
    progressDelta: { newEvidence: ['e1'], newlyCompletedCriteria: [], stepsAdvanced: 1, unresolvedDelta: -1 },
    unresolvedItems: [],
    wakeAt: null,
    requiredCapability: null,
    riskLevel: 'low',
    stopReason: null,
    evidenceRefs: ['e1'],
    decidedAt: NOW,
    ...over,
  };
}

/** 健康基线: 心跳新鲜 · 有进展 · 无 deadline · 无报告要求 · 执行器在 */
function mkInput(over: Partial<DetectBlocksInput> = {}): DetectBlocksInput {
  return {
    contract: mkContract(),
    report: null,
    lastHeartbeatAt: at(-10_000),
    lastProgressAt: at(-20_000),
    now: NOW,
    leaseOwner: null,
    runnerAvailable: true,
    ...over,
  };
}

function kindsOf(blocks: BlockRecord[]): BlockKind[] {
  return blocks.map((b) => b.kind);
}

function findAll(blocks: BlockRecord[], kind: BlockKind): BlockRecord[] {
  return blocks.filter((b) => b.kind === kind);
}

function findOne(blocks: BlockRecord[], kind: BlockKind): BlockRecord {
  const hits = findAll(blocks, kind);
  expect(hits, `期望恰好一条 ${kind}, 实际 ${JSON.stringify(kindsOf(blocks))}`).toHaveLength(1);
  return hits[0];
}

// ---------------------------------------------------------------------------
// ① 不误报: 健康的子 Agent 不产生任何阻塞
// ---------------------------------------------------------------------------

describe('detectBlocks — 健康基线 (负控制: 不该报的必须不报)', () => {
  it('心跳新鲜 + 有进展 + 无 deadline + 执行器在 → 零阻塞', () => {
    expect(detectBlocks(mkInput())).toEqual([]);
  });

  it('边界: 恰好等于心跳窗口 / 无进展窗口都不算超时 (不许提前报)', () => {
    expect(detectBlocks(mkInput({ lastHeartbeatAt: at(-HEARTBEAT_WINDOW) }))).toEqual([]);
    expect(detectBlocks(mkInput({ lastProgressAt: at(-NP_WINDOW) }))).toEqual([]);
  });

  it('报告已回报且完整 → 不产生 report_missing', () => {
    expect(detectBlocks(mkInput({ report: mkReport() }))).toEqual([]);
  });

  it('deadline 未到 / 执行权被别人持有 / 合同给了 5 分钟预算 → 都还不是阻塞', () => {
    const input = mkInput({
      contract: mkContract({
        deadline: at(60_000),
        budget: { maxSteps: null, maxDurationMs: 10 * 60_000, maxAmount: null, currency: null },
      }),
      leaseOwner: 'other-worker',
    });
    expect(detectBlocks(input)).toEqual([]);
  });

  it('用量型上限 (maxSteps / maxAmount) 父侧没有计数器 → 不凭空判阻塞 (如实边界)', () => {
    const input = mkInput({
      contract: mkContract({
        budget: { maxSteps: 1, maxDurationMs: null, maxAmount: 1, currency: 'USDC' },
      }),
    });
    expect(detectBlocks(input)).toEqual([]);
  });

  it('单次 failed 报告不判 repeated_failure (「反复」需要跨轮历史, 单次快照判不出来)', () => {
    expect(detectBlocks(mkInput({ report: mkReport({ status: 'failed' }) }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ② 心跳超时: 先查执行权, 可接管则接管, 不可则上报父
// ---------------------------------------------------------------------------

describe('detectBlocks — 心跳超时', () => {
  it('超时 → no_heartbeat, blockedAt = 最后心跳 + 窗口, 带升级时限', () => {
    const blocks = detectBlocks(mkInput({ lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)) }));
    const b = findOne(blocks, 'no_heartbeat');
    expect(b.blockedAt).toBe(at(-(HEARTBEAT_WINDOW + 1) + HEARTBEAT_WINDOW));
    expect(b.lastProgressAt).toBe(at(-20_000));
    expect(b.owner).toBe('parent');
    expect(b.suggestedAction).toBe('escalate_parent');
    expect(b.escalationAt).toBe(at(-(HEARTBEAT_WINDOW + 1) + HEARTBEAT_WINDOW + HEARTBEAT_WINDOW));
    expect(b.resolvedAt).toBeNull();
    expect(b.resolution).toBeNull();
    expect(b.workId).toBe('work-1');
    expect(b.goalId).toBe('goal-1');
    expect(b.runId).toBe('run-1');
  });

  it('从未有过心跳 → 从合同签订时间起算 (不是无限等待)', () => {
    const blocks = detectBlocks(mkInput({ lastHeartbeatAt: null }));
    const b = findOne(blocks, 'no_heartbeat');
    expect(b.blockedAt).toBe(at(HEARTBEAT_WINDOW, ISSUED));
  });

  it('执行权空闲 + 合同允许 takeover → 父可接管', () => {
    const blocks = detectBlocks(
      mkInput({
        contract: mkContract({ failurePolicy: { ...mkContract().failurePolicy, onHeartbeatMiss: 'takeover' } }),
        lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)),
        leaseOwner: null,
      }),
    );
    expect(findOne(blocks, 'no_heartbeat').suggestedAction).toBe('takeover');
  });

  it('负控制: 执行权空闲但合同只让 escalate → 不许自行接管', () => {
    const blocks = detectBlocks(mkInput({ lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)) }));
    const action = findOne(blocks, 'no_heartbeat').suggestedAction;
    expect(action).toBe('escalate_parent');
    expect(action).not.toBe('takeover');
  });

  it('负控制: 执行权被别的执行者占用 → 不可抢占, 只上报父', () => {
    const blocks = detectBlocks(
      mkInput({
        contract: mkContract({ failurePolicy: { ...mkContract().failurePolicy, onHeartbeatMiss: 'takeover' } }),
        lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)),
        leaseOwner: 'other-worker',
      }),
    );
    const b = findOne(blocks, 'no_heartbeat');
    expect(b.suggestedAction).toBe('escalate_parent');
    expect(b.dependency).not.toBeNull();
  });

  it('负控制: 执行权被子自己攥着 (合同允许 takeover) → 同样不可抢占', () => {
    const blocks = detectBlocks(
      mkInput({
        contract: mkContract({ failurePolicy: { ...mkContract().failurePolicy, onHeartbeatMiss: 'takeover' } }),
        lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)),
        leaseOwner: 'child-a',
      }),
    );
    expect(findOne(blocks, 'no_heartbeat').suggestedAction).toBe('escalate_parent');
  });

  it('合同不要求心跳 (heartbeatIntervalMs = 0) → 不判 no_heartbeat', () => {
    const blocks = detectBlocks(
      mkInput({ contract: mkContract({ heartbeatIntervalMs: 0 }), lastHeartbeatAt: null }),
    );
    expect(findAll(blocks, 'no_heartbeat')).toHaveLength(0);
  });

  it('阻塞记录里不出现执行者身份串 (内部执行权信息不外泄)', () => {
    const blocks = detectBlocks(mkInput({ lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)), leaseOwner: 'worker-secret-x' }));
    expect(JSON.stringify(blocks)).not.toContain('worker-secret-x');
    expect(findOne(blocks, 'no_heartbeat').dependency).toBe('互斥执行权正在被占用');
  });
});

// ---------------------------------------------------------------------------
// ③ 无进展: 先发一次调整指令, 二档才停/换人
// ---------------------------------------------------------------------------

describe('detectBlocks — 无进展 (两段规则)', () => {
  it('刚过窗口 → send_adjustment, 由子自己调整 (不是立刻换人)', () => {
    const blocks = detectBlocks(mkInput({ lastProgressAt: at(-(NP_WINDOW + 1)) }));
    const b = findOne(blocks, 'no_progress');
    expect(b.suggestedAction).toBe('send_adjustment');
    expect(b.owner).toBe('child');
    expect(b.blockedAt).toBe(at(-(NP_WINDOW + 1) + NP_WINDOW));
  });

  it('超过两倍窗口 (调整指令已给过一轮) 仍无进展 → replace_child, 由父处理', () => {
    const blocks = detectBlocks(
      mkInput({ lastProgressAt: at(-(NP_WINDOW * ADJUSTMENT_ALREADY_GIVEN_MULTIPLE + 1)) }),
    );
    const b = findOne(blocks, 'no_progress');
    expect(b.suggestedAction).toBe('replace_child');
    expect(b.owner).toBe('parent');
  });

  it('合同不要求心跳时用 NO_PROGRESS_FALLBACK_MS: 29 分钟不报, 31 分钟报', () => {
    const contract = mkContract({ heartbeatIntervalMs: 0 });
    expect(
      detectBlocks(
        mkInput({ contract, lastProgressAt: at(-(NO_PROGRESS_FALLBACK_MS - 60_000)), lastHeartbeatAt: null }),
      ),
    ).toEqual([]);
    const blocks = detectBlocks(
      mkInput({ contract, lastProgressAt: at(-(NO_PROGRESS_FALLBACK_MS + 60_000)), lastHeartbeatAt: null }),
    );
    expect(findOne(blocks, 'no_progress').suggestedAction).toBe('send_adjustment');
  });
});

// ---------------------------------------------------------------------------
// ④ 报告缺失 / 不完整: 不接受为完成
// ---------------------------------------------------------------------------

describe('detectBlocks — 报告缺失与不完整', () => {
  it('负控制: deadline 还没到且没报告 → 不算阻塞 (先等一下)', () => {
    expect(detectBlocks(mkInput({ contract: mkContract({ deadline: at(30_000) }) }))).toEqual([]);
  });

  it('超过 deadline 但在宽限内 → report_missing / request_report (blockedAt 指向 deadline)', () => {
    const blocks = detectBlocks(mkInput({ contract: mkContract({ deadline: at(-30_000) }) }));
    const b = findOne(blocks, 'report_missing');
    expect(b.blockedAt).toBe(at(-30_000));
    expect(b.owner).toBe('child');
    expect(b.suggestedAction).toBe('request_report');
    expect(b.dependency).toBe('report:bolloon-work-report/1');
  });

  it('超过 deadline 且超出宽限 → 转人工 (needs_human), 不许无限等', () => {
    const blocks = detectBlocks(mkInput({ contract: mkContract({ deadline: at(-(GRACE + 1)) }) }));
    const b = findOne(blocks, 'report_missing');
    expect(b.owner).toBe('user');
    expect(b.suggestedAction).toBe('needs_human');
  });

  it('合同不要求心跳时宽限用 DEFAULT_REPORT_GRACE_MS', () => {
    const contract = mkContract({ heartbeatIntervalMs: 0, deadline: at(-(DEFAULT_REPORT_GRACE_MS + 1)) });
    expect(findOne(detectBlocks(mkInput({ contract, lastHeartbeatAt: null })), 'report_missing').suggestedAction).toBe(
      'needs_human',
    );
  });

  it('强负例: 报告漂亮但 evidence 为空 → 不接受为完成 (即使 status=completed)', () => {
    const blocks = detectBlocks(mkInput({ report: mkReport({ evidence: [] }) }));
    const b = findOne(blocks, 'report_missing');
    expect(b.suggestedAction).toBe('request_report');
    expect(b.note).toContain('无证据');
  });

  it('必备证据未覆盖 → report_missing, note 点名缺哪一项', () => {
    const report = mkReport({ evidence: [{ kind: 'log', ref: '/tmp/other.log', note: null }] });
    const b = findOne(detectBlocks(mkInput({ report })), 'report_missing');
    expect(b.note).toContain('必备证据未覆盖');
    expect(b.note).toContain('evidence:test-run');
  });

  it('自称 blocked 却没带 blockReason → 报告不完整 (说不出卡在哪)', () => {
    const b = findOne(detectBlocks(mkInput({ report: mkReport({ status: 'blocked' }) })), 'report_missing');
    expect(b.note).toContain('blockReason 为空');
  });

  it('报告张冠李戴 (workId 与本合同不符) → 不接受为完成', () => {
    const b = findOne(detectBlocks(mkInput({ report: mkReport({ workId: 'work-other' }) })), 'report_missing');
    expect(b.note).toContain('work-other');
    expect(b.note).toContain('不符');
  });

  it('子自报阻塞时, owner 与动作由父的规则表定 (子的建议只是线索)', () => {
    const report = mkReport({ blockReason: mkChildBlock({ kind: 'tool_blocked', suggestedAction: 'takeover' }) });
    const b = findOne(detectBlocks(mkInput({ report })), 'tool_blocked');
    expect(b.suggestedAction).toBe('change_plan');
    expect(b.owner).toBe('parent');
    expect(b.blockedAt).toBe(at(-30_000));
    expect(b.dependency).toBe('外部 CDN 返回 429');
    expect(b.note).toContain('子自报原文: 拿不到依赖');
  });

  it('子自报的 escalationAt 为空 → 父补上默认升级时限 (不许无限等)', () => {
    const report = mkReport({ blockReason: mkChildBlock({ escalationAt: null }) });
    const b = findOne(detectBlocks(mkInput({ report })), 'tool_blocked');
    expect(b.escalationAt).toBe(at(-30_000 + DEFAULT_ESCALATION_MS));
  });
});

// ---------------------------------------------------------------------------
// ⑤ 工具 / 资源 / 权限 / 预算被阻: 不自动绕过 Harness
// ---------------------------------------------------------------------------

describe('detectBlocks — 工具/资源/预算被阻', () => {
  const FORBIDDEN_FOR_RESOURCE_BLOCKS: BlockResolutionAction[] = ['takeover', 'replace_child'];

  it('工具被阻 → change_plan (允许父改计划), 永不 接管/替换/绕过 Harness', () => {
    for (const onToolDenied of ['report', 'replan_within_contract'] as const) {
      const contract = mkContract({
        failurePolicy: { ...mkContract().failurePolicy, onToolDenied },
      });
      const report = mkReport({ blockReason: mkChildBlock({ kind: 'tool_blocked' }) });
      const blocks = detectBlocks(mkInput({ contract, report }));
      const b = findOne(blocks, 'tool_blocked');
      expect(b.suggestedAction).toBe('change_plan');
      expect(FORBIDDEN_FOR_RESOURCE_BLOCKS).not.toContain(planBlockHandling(b));
    }
  });

  it('权限被阻 → needs_human (权限变更不许 Agent 自动批)', () => {
    const report = mkReport({ blockReason: mkChildBlock({ kind: 'permission_blocked' }) });
    const b = findOne(detectBlocks(mkInput({ report })), 'permission_blocked');
    expect(b.owner).toBe('user');
    expect(b.suggestedAction).toBe('needs_human');
  });

  it('子自报预算耗尽 → needs_human', () => {
    const report = mkReport({ blockReason: mkChildBlock({ kind: 'budget_blocked' }) });
    expect(findOne(detectBlocks(mkInput({ report })), 'budget_blocked').suggestedAction).toBe('needs_human');
  });

  it('父侧能独立算出的时长硬底线: 超 maxDurationMs 且子没回报 → 先要一份收尾报告', () => {
    const contract = mkContract({
      budget: { maxSteps: null, maxDurationMs: 5 * 60_000, maxAmount: null, currency: null },
    });
    const b = findOne(detectBlocks(mkInput({ contract })), 'budget_blocked');
    expect(b.suggestedAction).toBe('request_report');
    expect(b.owner).toBe('child');
    expect(b.blockedAt).toBe(at(5 * 60_000, ISSUED));
    expect(b.note).toContain('先要一份收尾报告');
  });

  it('时长硬底线已破且报告已回 → 加预算要人决定 (needs_human)', () => {
    const contract = mkContract({
      budget: { maxSteps: null, maxDurationMs: 5 * 60_000, maxAmount: null, currency: null },
    });
    const b = findOne(detectBlocks(mkInput({ contract, report: mkReport() })), 'budget_blocked');
    expect(b.suggestedAction).toBe('needs_human');
    expect(b.owner).toBe('user');
  });

  it('执行器不可用 → runner_unavailable, 只诊断不假装跑过', () => {
    const b = findOne(detectBlocks(mkInput({ runnerAvailable: false })), 'runner_unavailable');
    expect(b.owner).toBe('parent');
    expect(b.suggestedAction).toBe('escalate_parent');
    expect(b.dependency).toBe('runner:code-inspection');
    expect(b.blockedAt).toBe(NOW);
    expect(b.note).toContain('只诊断');
  });
});

// ---------------------------------------------------------------------------
// ⑥ 确定性与幂等
// ---------------------------------------------------------------------------

describe('detectBlocks — 确定性 / 幂等 / 时间不可读', () => {
  it('多种阻塞并存 → 顺序固定 (执行器 → 时长底线 → 心跳 → 无进展 → 报告)', () => {
    const contract = mkContract({
      budget: { maxSteps: null, maxDurationMs: 5 * 60_000, maxAmount: null, currency: null },
      deadline: at(-(GRACE + 1)),
    });
    const blocks = detectBlocks(
      mkInput({ contract, lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)), lastProgressAt: at(-(NP_WINDOW + 1)), runnerAvailable: false }),
    );
    expect(kindsOf(blocks)).toEqual([
      'runner_unavailable',
      'budget_blocked',
      'no_heartbeat',
      'no_progress',
      'report_missing',
    ]);
  });

  it('同一 kind 只留一条: 父侧观测优先于子自报', () => {
    const report = mkReport({ blockReason: mkChildBlock({ kind: 'no_progress', note: '子说它卡了' }) });
    const blocks = detectBlocks(mkInput({ report, lastProgressAt: at(-(NP_WINDOW + 1)) }));
    const b = findOne(blocks, 'no_progress');
    expect(b.lastProgressAt).toBe(at(-(NP_WINDOW + 1)));
    expect(b.note).toContain('已无进展');
    expect(b.note).not.toContain('子自报原文');
  });

  it('幂等: 同输入调两次结果完全一致 (blockId 稳定, 接线层据此去重)', () => {
    const input = mkInput({
      contract: mkContract({
        budget: { maxSteps: null, maxDurationMs: 5 * 60_000, maxAmount: null, currency: null },
        deadline: at(-(GRACE + 1)),
      }),
      lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)),
      lastProgressAt: at(-(NP_WINDOW + 1)),
    });
    const first = detectBlocks(input);
    const second = detectBlocks(input);
    expect(first).toEqual(second);
    expect(kindsOf(first).map((k) => `blk:work-1:${k}`)).toEqual(first.map((b) => b.blockId));
  });

  it('时间读不出 → 不判定任何阻塞, 也不假装有阻塞 (宁可漏报)', () => {
    expect(detectBlocks(mkInput({ now: '不是时间' }))).toEqual([]);
    // lastProgressAt 读不出 → 不判 no_progress (心跳仍按真实心跳判, 不互相污染)
    const withBadProgress = detectBlocks(
      mkInput({ lastProgressAt: 'X', lastHeartbeatAt: at(-(HEARTBEAT_WINDOW + 1)) }),
    );
    expect(kindsOf(withBadProgress)).toEqual(['no_heartbeat']);
    expect(
      detectBlocks(mkInput({ contract: mkContract({ issuedAt: 'X' }), lastHeartbeatAt: null })),
    ).toEqual([]);
  });

  it('报告 reportedAt 不可读时仍判「不完整」, 但 blockedAt 回落到 now (不编时间)', () => {
    const report = mkReport({ reportedAt: 'X', evidence: [] });
    const b = findOne(detectBlocks(mkInput({ report })), 'report_missing');
    expect(b.blockedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// ⑦ planBlockHandling
// ---------------------------------------------------------------------------

describe('planBlockHandling — 处理规则', () => {
  it('默认处理表覆盖全部 BLOCK_KINDS, 且 §8 四条与设计稿逐条一致', () => {
    expect(Object.keys(BLOCK_HANDLING_DEFAULTS).sort()).toEqual([...BLOCK_KINDS].sort());
    for (const kind of BLOCK_KINDS) {
      const record = mkBlock({ kind, suggestedAction: BLOCK_HANDLING_DEFAULTS[kind].action });
      expect(planBlockHandling(record)).toBe(BLOCK_HANDLING_DEFAULTS[kind].action);
    }
    expect(BLOCK_HANDLING_DEFAULTS.no_heartbeat.action).toBe('escalate_parent');
    expect(BLOCK_HANDLING_DEFAULTS.no_progress.action).toBe('send_adjustment');
    expect(BLOCK_HANDLING_DEFAULTS.report_missing.action).toBe('request_report');
    expect(BLOCK_HANDLING_DEFAULTS.tool_blocked.action).toBe('change_plan');
  });

  it('已处理的记录 → 以实际动作为准 (不重新发明结论)', () => {
    expect(
      planBlockHandling(mkBlock({ resolvedAt: at(-1_000), resolution: 'replace_child' })),
    ).toBe('replace_child');
  });

  it('外部构造 (磁盘/JSON) 的记录带着非法建议动作 → 回落按 kind 的默认处理', () => {
    const bogus = mkBlock({ kind: 'tool_blocked', suggestedAction: 'reboot_everything' as BlockResolutionAction });
    expect(planBlockHandling(bogus)).toBe('change_plan');
  });

  it('不自动绕过 Harness: 工具/权限被阻的动作永不落入 takeover / replace_child', () => {
    for (const kind of ['tool_blocked', 'permission_blocked', 'budget_blocked'] as const) {
      const action = planBlockHandling(mkBlock({ kind, suggestedAction: BLOCK_HANDLING_DEFAULTS[kind].action }));
      expect(action).not.toBe('takeover');
      expect(action).not.toBe('replace_child');
      expect(BLOCK_RESOLUTION_ACTIONS).toContain(action);
    }
  });

  it('决策产生的动作全部是合法动作 (不产出枚举外的字符串)', () => {
    for (const kind of BLOCK_KINDS) {
      const action = planBlockHandling(mkBlock({ kind, suggestedAction: BLOCK_HANDLING_DEFAULTS[kind].action }));
      expect(BLOCK_RESOLUTION_ACTIONS).toContain(action);
    }
  });
});

// ---------------------------------------------------------------------------
// ⑧ toUserVisibleState
// ---------------------------------------------------------------------------

describe('toUserVisibleState — 五类映射', () => {
  it('五类都能产出 (逐一给出具体输入)', () => {
    expect(toUserVisibleState(mkContinuation(), [], null)).toBe('executing');
    expect(toUserVisibleState(mkContinuation({ state: 'awaiting_external' }), [], null)).toBe(
      'waiting_external_reply',
    );
    expect(
      toUserVisibleState(mkContinuation(), [mkBlock({ kind: 'tool_blocked', suggestedAction: 'change_plan' })], null),
    ).toBe('child_blocked');
    expect(
      toUserVisibleState(mkContinuation(), [mkBlock({ kind: 'no_progress', suggestedAction: 'send_adjustment' })], null),
    ).toBe('no_progress');
    expect(toUserVisibleState(mkContinuation(), [], mkDecision({ decision: 'ask_human', state: 'needs_decision' }))).toBe(
      'needs_your_decision',
    );
  });

  // 2026-09-25: 五类没有"已结束"时终态只能借用 needs_your_decision; 第 6 类补上后终态映射成 'ended'。
  // 负控制不变: 终态绝不说成「正在执行」。
  it('负控制: 目标终态绝不说成「正在执行」', () => {
    for (const state of ['completed', 'failed', 'abandoned'] as const) {
      const visible = toUserVisibleState(mkContinuation({ state }), [], null);
      expect(visible).toBe('ended');
      expect(visible).not.toBe('executing');
    }
    for (const state of ['completed', 'failed'] as const) {
      expect(toUserVisibleState(mkContinuation(), [], mkDecision({ state }))).not.toBe('executing');
    }
  });

  it('已解决的阻塞不进用户态', () => {
    const resolved = mkBlock({ kind: 'no_heartbeat', resolvedAt: at(-1_000), resolution: 'takeover' });
    expect(toUserVisibleState(mkContinuation(), [resolved], null)).toBe('executing');
  });

  it('优先级: needs_human 阻塞 > 子被阻塞 > 无进展 > 等外部', () => {
    const childBlocked = mkBlock({ kind: 'no_heartbeat', suggestedAction: 'escalate_parent' });
    const noProgress = mkBlock({ kind: 'no_progress', suggestedAction: 'send_adjustment' });
    const waiting = mkBlock({ kind: 'waiting_dependency', suggestedAction: 'wait_dependency' });
    const needsHuman = mkBlock({ kind: 'report_missing', suggestedAction: 'needs_human' });

    expect(toUserVisibleState(mkContinuation(), [childBlocked, needsHuman], null)).toBe('needs_your_decision');
    expect(toUserVisibleState(mkContinuation(), [noProgress, childBlocked], null)).toBe('child_blocked');
    expect(toUserVisibleState(mkContinuation(), [waiting, noProgress], null)).toBe('no_progress');
    expect(toUserVisibleState(mkContinuation(), [waiting], null)).toBe('waiting_external_reply');
    // 顺序不影响结论
    expect(toUserVisibleState(mkContinuation(), [needsHuman, childBlocked], null)).toBe('needs_your_decision');
  });

  it('需要人做取舍的决策/状态压过子被阻塞 (人的事最优先)', () => {
    const childBlocked = mkBlock({ kind: 'no_heartbeat', suggestedAction: 'takeover' });
    expect(
      toUserVisibleState(mkContinuation(), [childBlocked], mkDecision({ decision: 'ask_human', state: 'needs_decision' })),
    ).toBe('needs_your_decision');
    expect(toUserVisibleState(mkContinuation({ state: 'needs_human' }), [childBlocked], null)).toBe(
      'needs_your_decision',
    );
    expect(toUserVisibleState(mkContinuation({ state: 'paused' }), [], null)).toBe('needs_your_decision');
  });

  it('等子回报 (pendingReports) 比「正在执行」更具体', () => {
    const c = mkContinuation({
      pendingReports: [
        {
          workId: 'work-2',
          childAgentId: 'child-b',
          capability: 'code-inspection',
          requestedAt: at(-60_000),
          deadlineAt: at(60_000),
          lastHeartbeatAt: at(-5_000),
        },
      ],
    });
    expect(toUserVisibleState(c, [], null)).toBe('waiting_external_reply');
  });

  it('子被阻塞比「暂时没有进展」更严重 (先报阻塞)', () => {
    const noProgress = mkBlock({ kind: 'no_progress', suggestedAction: 'send_adjustment' });
    expect(toUserVisibleState(mkContinuation({ state: 'stalled' }), [noProgress], null)).toBe('no_progress');
    expect(
      toUserVisibleState(
        mkContinuation({ state: 'stalled' }),
        [noProgress, mkBlock({ kind: 'tool_blocked', suggestedAction: 'change_plan' })],
        null,
      ),
    ).toBe('child_blocked');
  });

  it('决策说的等待 / 无进展也映射到用户态', () => {
    expect(toUserVisibleState(null, [], mkDecision({ decision: 'wait', state: 'waiting_external' }))).toBe(
      'waiting_external_reply',
    );
    expect(toUserVisibleState(null, [], mkDecision({ decision: 'continue', state: 'no_progress' }))).toBe('no_progress');
    expect(toUserVisibleState(mkContinuation({ state: 'stalled' }), [], null)).toBe('no_progress');
    expect(toUserVisibleState(mkContinuation({ state: 'retry_wait' }), [], null)).toBe('waiting_external_reply');
  });

  it('什么都没有 → 默认「正在执行」', () => {
    expect(toUserVisibleState(null, [], null)).toBe('executing');
  });

  it('返回值恒在六类闭集内, 且不含任何内部字段名 (lease / reducer / worker owner …)', () => {
    const battery: Array<[GoalContinuationRecord | null, BlockRecord[], ContinuationDecision | null]> = [
      [mkContinuation(), [], null],
      [mkContinuation({ state: 'stalled' }), [], null],
      [mkContinuation({ state: 'recovering' }), [], null],
      [mkContinuation({ state: 'needs_human' }), [], null],
      [mkContinuation({ state: 'paused' }), [], null],
      [mkContinuation({ state: 'completed' }), [], null],
      [mkContinuation({ state: 'abandoned' }), [], null],
      [null, BLOCK_KINDS.map((kind) => mkBlock({ kind, suggestedAction: BLOCK_HANDLING_DEFAULTS[kind].action })), null],
      [null, [], mkDecision({ decision: 'ask_human', state: 'needs_decision' })],
      [null, [], mkDecision({ decision: 'fail', state: 'failed' })],
      [mkContinuation(), [mkBlock({ kind: 'runner_unavailable', suggestedAction: 'escalate_parent' })], null],
    ];
    for (const [c, blocks, decision] of battery) {
      const visible = toUserVisibleState(c, blocks, decision);
      expect(USER_VISIBLE_STATES).toContain(visible);
      for (const forbidden of MUST_NOT_EXPOSE_FIELDS) {
        expect(visible).not.toContain(forbidden);
      }
    }
  });

  it('用户可见映射表覆盖全部 BLOCK_KINDS 且取值都在六类内', () => {
    expect(Object.keys(USER_VISIBLE_STATE_FOR_BLOCK_KIND).sort()).toEqual([...BLOCK_KINDS].sort());
    for (const kind of BLOCK_KINDS) {
      expect(USER_VISIBLE_STATES).toContain(USER_VISIBLE_STATE_FOR_BLOCK_KIND[kind]);
    }
  });
});

// ---------------------------------------------------------------------------
// 变异验证 (手工执行, 见交付报告; 这里说明该改什么)
// ---------------------------------------------------------------------------

describe('变异验证 — 门不是空转 (说明)', () => {
  it('文件说明: 把「无进展二档」或「终态不许 executing」改坏, 本文件必须判红', () => {
    // 本用例不自己做变异 (会改源码), 只钉住两个关键不变量在当前代码里成立,
    // 变异实操记录在交付报告里 (改坏 → 跑 → 恢复)。
    const secondStage = findOne(
      detectBlocks(mkInput({ lastProgressAt: at(-(NP_WINDOW * ADJUSTMENT_ALREADY_GIVEN_MULTIPLE + 1)) })),
      'no_progress',
    );
    expect(secondStage.suggestedAction).toBe('replace_child');
    expect(toUserVisibleState(mkContinuation({ state: 'completed' }), [], null)).not.toBe('executing');
    // 第 6 类补上后: 终态 = 'ended' (而不是借用 needs_your_decision)
    expect(toUserVisibleState(mkContinuation({ state: 'completed' }), [], null)).toBe('ended');
    expect(toUserVisibleState(mkContinuation({ state: 'abandoned' }), [], null)).toBe('ended');
  });
});
