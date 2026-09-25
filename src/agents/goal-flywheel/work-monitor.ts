/**
 * goal-flywheel/work-monitor.ts — P3 阻塞监控 (WorkMonitor, 2026-09-25)
 *
 * 存在的理由: 现有 Watchdog **只看进程存活**, 不等于看**任务是否卡住**。
 * 本层只回答三件事:
 *   ① 现在卡在哪        → `detectBlocks` → `BlockRecord[]`
 *   ② 该怎么处理         → `planBlockHandling` → `BlockResolutionAction`
 *   ③ 用户该看到什么     → `toUserVisibleState` → 五类之一
 *
 * 纪律 (与设计稿 `docs/wiki/goal-continuation-flywheel.md` §8 / §13 / §14 对齐):
 *   - **纯函数**: 时间一律 `now` 注入 (不读真实钟) · 不做 I/O (不 import fs) · 不 import 其它阶段的实现文件,
 *     与 P0/P1/P2/P4 只通过 `types.ts` 的类型耦合 (依赖靠参数注入)。
 *   - **不自动绕过 Harness**: 工具/权限/预算被阻只产出「父改计划 / 转人工」, 永不产出 `takeover`/`replace_child`。
 *   - **用户视野只有五类**: `UserVisibleState` 是闭集; 内部词 (lease · reducer · retry counter · worker owner)
 *     既不进返回值, 也不进 `BlockRecord.note`。
 *   - **只给动作不做动作**: 接管 / 替换 / 上报这些**副作用由接线层执行** —— 本文件不动任何状态。
 *   - **宁可漏报, 不假报**: 时间戳读不出 / 输入不足以证明时**不**判定阻塞 (判不出来就说判不出来)。
 *
 * 刻意**不做** (如实声明的边界):
 *   - `maxSteps` / `maxAmount` 的用量不在本函数输入里 (没有用量计数器) → 只能由子自报 `budget_blocked` 透传;
 *     只有**时长型**硬底线 (`budget.maxDurationMs`, 以 `contract.issuedAt` 起算) 父侧能独立算出。
 *   - 单次 `report.status === 'failed'` **不**判 `repeated_failure` —— "反复"需要跨轮历史, 本函数只有单次快照;
 *     该 kind 只经子自报透传。
 *   - 逐判据 checks / 越权工具 / 私改判据这些**报告合规判定**属 P2 `validateChildReport`; 本层只守一条硬底线:
 *     **无证据或缺必备证据的报告, 绝不接受为完成**。
 */
import { BLOCK_RESOLUTION_ACTIONS } from './types.js';
import type {
  AgentWorkContract,
  AgentWorkReport,
  BlockKind,
  BlockOwner,
  BlockRecord,
  BlockResolutionAction,
  ContinuationDecision,
  GoalContinuationRecord,
  GoalLifecycleState,
  IsoTimestamp,
  UserVisibleState,
} from './types.js';

// ============================================================================
// 阈值 —— 全部导出: 测试与接线层都不许自己编魔法数
// ============================================================================

/** 心跳超过 `heartbeatIntervalMs × 本倍率` 未到 → `no_heartbeat` */
export const HEARTBEAT_MISS_MULTIPLE = 2;
/** 无进展窗口 = `heartbeatIntervalMs × 本倍率` */
export const NO_PROGRESS_HEARTBEAT_MULTIPLE = 6;
/** 合同不要求心跳 (`heartbeatIntervalMs ≤ 0`) 时的无进展窗口 */
export const NO_PROGRESS_FALLBACK_MS = 30 * 60 * 1000;
/** 无进展已超过 `窗口 × 本倍率` = 调整指令已给过一轮 → 停 / 替换 */
export const ADJUSTMENT_ALREADY_GIVEN_MULTIPLE = 2;
/** 回报宽限 = `heartbeatIntervalMs × 本倍率` */
export const REPORT_GRACE_HEARTBEAT_MULTIPLE = 2;
/** 没有心跳周期可依据时的回报宽限 */
export const DEFAULT_REPORT_GRACE_MS = 60 * 1000;
/** 默认升级时限 (design: 不许无限等) */
export const DEFAULT_ESCALATION_MS = 10 * 60 * 1000;

/** 只有这几个目标状态是「已结束」 */
export const TERMINAL_GOAL_STATES: readonly GoalLifecycleState[] = ['completed', 'failed', 'abandoned'];

// ============================================================================
// 规则表 (按 kind 的默认处理) —— 上下文可细化, 但绝不越过 Harness
// ============================================================================

/**
 * 每种阻塞的**默认** owner / 动作。上下文细化 (lease 空闲可接管 · 无进展二档换人 · 报告超时转人工)
 * 由 `detectBlocks` 覆盖; `planBlockHandling` 在记录缺建议动作时回落到这张表。
 *
 * 三条硬规则 (与 §8 的「处理规则」表逐条对应):
 *   - 子无心跳 → 先查执行权: 空闲且合同允许才能 `takeover`, 否则 `escalate_parent`
 *   - 子无进展 → **先发一次调整指令** (`send_adjustment`), 仍无进展才 `replace_child`
 *   - 报告不完整 → **不接受为完成** → `request_report`, 超时 `needs_human`
 *   - 工具/资源被阻 → `change_plan` / `needs_human`, **永不** 接管/替换/绕过 Harness
 */
export const BLOCK_HANDLING_DEFAULTS: Record<BlockKind, { owner: BlockOwner; action: BlockResolutionAction }> = {
  no_heartbeat: { owner: 'parent', action: 'escalate_parent' },
  waiting_dependency: { owner: 'external', action: 'wait_dependency' },
  repeated_failure: { owner: 'parent', action: 'escalate_parent' },
  no_progress: { owner: 'child', action: 'send_adjustment' },
  tool_blocked: { owner: 'parent', action: 'change_plan' },
  budget_blocked: { owner: 'user', action: 'needs_human' },
  permission_blocked: { owner: 'user', action: 'needs_human' },
  runner_unavailable: { owner: 'parent', action: 'escalate_parent' },
  external_timeout: { owner: 'parent', action: 'escalate_parent' },
  report_missing: { owner: 'child', action: 'request_report' },
};

/**
 * 每种阻塞映射到的**用户可见**状态。
 * 语义: 子/执行者侧卡死 → `child_blocked`; 没有新东西 → `no_progress`; 在等别人 → `waiting_external_reply`。
 * 注意 `report_missing` 属「子侧卡住」(子该报没报), 不是"等外部"。
 */
export const USER_VISIBLE_STATE_FOR_BLOCK_KIND: Record<BlockKind, UserVisibleState> = {
  no_heartbeat: 'child_blocked',
  waiting_dependency: 'waiting_external_reply',
  repeated_failure: 'child_blocked',
  no_progress: 'no_progress',
  tool_blocked: 'child_blocked',
  budget_blocked: 'child_blocked',
  permission_blocked: 'child_blocked',
  runner_unavailable: 'child_blocked',
  external_timeout: 'waiting_external_reply',
  report_missing: 'child_blocked',
};

/** 未解决阻塞的「信息量」顺序: 子被阻塞 > 无进展 > 等外部 (用户态按这个顺序取第一个命中的) */
export const USER_VISIBLE_BLOCK_PRIORITY: readonly UserVisibleState[] = [
  'child_blocked',
  'no_progress',
  'waiting_external_reply',
];

// ============================================================================
// 输入
// ============================================================================

/** `detectBlocks` 的输入 (设计稿 §14 冻结签名的具名化; 字段一字不多一字不少) */
export interface DetectBlocksInput {
  contract: AgentWorkContract;
  /** 子还没回报时 null */
  report: AgentWorkReport | null;
  /** 最后一次心跳 (从未有过则 null) */
  lastHeartbeatAt: IsoTimestamp | null;
  /** 最后一次有进展 */
  lastProgressAt: IsoTimestamp;
  now: IsoTimestamp;
  /** 当前持有互斥执行权的执行者 (空闲则 null) —— **只用于判断能否接管, 不进任何输出** */
  leaseOwner: string | null;
  runnerAvailable: boolean;
}

// ============================================================================
// 时间与阈值工具
// ============================================================================

/** 解析时间戳; 读不出 → null (调用方据此"不判定", 而不是当成 0) */
function toMs(iso: IsoTimestamp): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}

/** 心跳窗口 (null = 该合同不要求心跳) */
export function heartbeatWindowMs(contract: AgentWorkContract): number | null {
  const hb = contract.heartbeatIntervalMs;
  return Number.isFinite(hb) && hb > 0 ? hb * HEARTBEAT_MISS_MULTIPLE : null;
}

/** 无进展窗口 */
export function noProgressWindowMs(contract: AgentWorkContract): number {
  const hb = contract.heartbeatIntervalMs;
  return Number.isFinite(hb) && hb > 0 ? hb * NO_PROGRESS_HEARTBEAT_MULTIPLE : NO_PROGRESS_FALLBACK_MS;
}

/** 回报宽限 (deadline 过后多久内还只是"要求补齐") */
export function reportGraceMs(contract: AgentWorkContract): number {
  const hb = contract.heartbeatIntervalMs;
  return Number.isFinite(hb) && hb > 0 ? hb * REPORT_GRACE_HEARTBEAT_MULTIPLE : DEFAULT_REPORT_GRACE_MS;
}

// ============================================================================
// ① detectBlocks
// ============================================================================

/** 记录构造用的中间草稿 (带毫秒, 最后统一 materialize 成 BlockRecord) */
interface BlockDraft {
  kind: BlockKind;
  owner: BlockOwner;
  action: BlockResolutionAction;
  blockedAtMs: number;
  lastProgressMs: number | null;
  dependency: string | null;
  escalationMs: number | null;
  note: string;
}

/**
 * 把草稿变成冻结的 `BlockRecord`。
 *
 * `blockId` 刻意**确定性** (`blk:<workId>:<kind>`): 同一 (工作, 阻塞类型) 反复检测得到同一个 id,
 * 接线层据此幂等去重, 而不是制造一堆"新阻塞"。
 */
function materialize(contract: AgentWorkContract, draft: BlockDraft): BlockRecord {
  return {
    blockId: `blk:${contract.workId}:${draft.kind}`,
    kind: draft.kind,
    goalId: contract.goalId,
    runId: contract.parentRunId,
    workId: contract.workId,
    childAgentId: contract.childAgentId,
    blockedAt: toIso(draft.blockedAtMs),
    lastProgressAt: toIso(draft.lastProgressMs ?? draft.blockedAtMs),
    owner: draft.owner,
    dependency: draft.dependency,
    suggestedAction: draft.action,
    escalationAt: draft.escalationMs === null ? null : toIso(draft.escalationMs),
    resolvedAt: null,
    resolution: null,
    note: draft.note,
  };
}

/**
 * 报告的**不完整项** (空数组 = 报告完整)。
 *
 * 只做「能不能接受为完成」的硬底线, 不做 P2 的完整合规判定:
 *   ① 报告张冠李戴 (workId 与合同不符)
 *   ② `evidence` 为空 —— 漂亮但无证据
 *   ③ `contract.requiredEvidence` 没被证据的 `ref` / `kind` **精确**覆盖
 *   ④ 自称 `blocked` 却没带 `blockReason`
 */
export function missingReportParts(contract: AgentWorkContract, report: AgentWorkReport): string[] {
  const missing: string[] = [];
  if (report.workId !== contract.workId) {
    missing.push(`报告 workId (${report.workId}) 与合同 (${contract.workId}) 不符`);
  }
  if (report.evidence.length === 0) {
    missing.push('evidence 为空 —— 漂亮但无证据的报告不接受为完成');
  }
  const covered = new Set<string>();
  for (const e of report.evidence) {
    covered.add(e.ref);
    covered.add(e.kind);
  }
  const uncovered = contract.requiredEvidence.filter((r) => !covered.has(r));
  if (uncovered.length > 0) {
    missing.push(`必备证据未覆盖: ${uncovered.join(', ')}`);
  }
  if (report.status === 'blocked' && report.blockReason === null) {
    missing.push('status=blocked 但 blockReason 为空');
  }
  return missing;
}

/**
 * 一次检测, 产出全部阻塞 (无阻塞 = 空数组)。
 *
 * 判定顺序固定 (便于对表与复现): 执行器不可用 → 时长硬底线 → 无心跳 → 无进展 → 报告(缺失/不完整) → 子自报透传。
 * 同一 `kind` 只留**第一条** (父侧观测优先于子自报)。
 */
export function detectBlocks(input: DetectBlocksInput): BlockRecord[] {
  const { contract, report, lastHeartbeatAt, lastProgressAt, now, leaseOwner, runnerAvailable } = input;

  const nowMs = toMs(now);
  // `now` 读不出 → 无法证明任何阻塞: 宁可漏报, 不假报
  if (nowMs === null) return [];

  const progressMs = toMs(lastProgressAt);
  const issuedMs = toMs(contract.issuedAt);

  const out: BlockRecord[] = [];
  const seen = new Set<BlockKind>();
  const push = (draft: BlockDraft): void => {
    if (seen.has(draft.kind)) return;
    seen.add(draft.kind);
    out.push(materialize(contract, draft));
  };

  // ---- 1. 执行器不可用 (只诊断, 不假装跑过) --------------------------------
  if (runnerAvailable === false) {
    push({
      kind: 'runner_unavailable',
      owner: 'parent',
      action: 'escalate_parent',
      blockedAtMs: nowMs,
      lastProgressMs: progressMs,
      dependency: `runner:${contract.capability}`,
      escalationMs: nowMs + DEFAULT_ESCALATION_MS,
      note: `没有可用的执行器来跑能力「${contract.capability}」—— 只诊断, 不假装跑过; 需要父换执行器或改计划`,
    });
  }

  // ---- 2. 时长型硬底线 (父侧可独立算出; 用量型只能靠子自报) ----------------
  const maxDurationMs = contract.budget.maxDurationMs;
  if (maxDurationMs !== null && Number.isFinite(maxDurationMs) && maxDurationMs >= 0 && issuedMs !== null) {
    const deadlineBudgetMs = issuedMs + maxDurationMs;
    if (nowMs > deadlineBudgetMs) {
      const hasReport = report !== null;
      push({
        kind: 'budget_blocked',
        owner: hasReport ? 'user' : 'child',
        action: hasReport ? 'needs_human' : 'request_report',
        blockedAtMs: deadlineBudgetMs,
        lastProgressMs: progressMs,
        dependency: null,
        escalationMs: deadlineBudgetMs + DEFAULT_ESCALATION_MS,
        note: hasReport
          ? `本轮时长预算已用尽 (${maxDurationMs}ms) —— 加预算不许 Agent 自动批, 需人决定`
          : `本轮时长预算已用尽 (${maxDurationMs}ms) 且子还没回报 —— 先要一份收尾报告`,
      });
    }
  }

  // ---- 3. 子无心跳 → 先查执行权: 可接管则接管 / 不可则上报父 ---------------
  const hbWindow = heartbeatWindowMs(contract);
  if (hbWindow !== null) {
    const baseMs = lastHeartbeatAt === null ? issuedMs : toMs(lastHeartbeatAt);
    if (baseMs !== null && nowMs - baseMs > hbWindow) {
      const overdueAtMs = baseMs + hbWindow;
      // 执行权空闲 **且** 合同明确允许接管, 才判定可接管;
      // 是否"持有者已死 / 执行权过期可回收"属执行权层, 本层不猜。
      const canTakeover = contract.failurePolicy.onHeartbeatMiss === 'takeover' && leaseOwner === null;
      push({
        kind: 'no_heartbeat',
        owner: 'parent',
        action: canTakeover ? 'takeover' : 'escalate_parent',
        blockedAtMs: overdueAtMs,
        lastProgressMs: progressMs,
        dependency: leaseOwner === null ? null : '互斥执行权正在被占用',
        escalationMs: overdueAtMs + hbWindow,
        note: canTakeover
          ? `子 Agent 心跳超时 (合同间隔 ${contract.heartbeatIntervalMs}ms) 且执行权空闲 → 父可接管`
          : `子 Agent 心跳超时 (合同间隔 ${contract.heartbeatIntervalMs}ms) 但不可抢占 → 上报父处理`,
      });
    }
  }

  // ---- 4. 子无进展 (活着但没动) → 先发一次调整指令, 二档才换人 -------------
  const npWindow = noProgressWindowMs(contract);
  if (progressMs !== null && nowMs - progressMs > npWindow) {
    const overdueAtMs = progressMs + npWindow;
    const adjusted = nowMs - progressMs > npWindow * ADJUSTMENT_ALREADY_GIVEN_MULTIPLE;
    push({
      kind: 'no_progress',
      owner: adjusted ? 'parent' : 'child',
      action: adjusted ? 'replace_child' : 'send_adjustment',
      blockedAtMs: overdueAtMs,
      lastProgressMs: progressMs,
      dependency: null,
      escalationMs: overdueAtMs + npWindow,
      note: adjusted
        ? `已无进展 ${nowMs - progressMs}ms (窗口 ${npWindow}ms) —— 调整指令已给过一轮, 仍无进展 → 停或替换执行者`
        : `已无进展 ${nowMs - progressMs}ms (窗口 ${npWindow}ms) —— 先发一次调整指令, 不是立刻换人`,
    });
  }

  // ---- 5. 报告: 根本没回 / 不完整 → 不接受为完成 ---------------------------
  if (report === null) {
    const dlMs = contract.deadline === null ? null : toMs(contract.deadline);
    if (dlMs !== null && nowMs > dlMs) {
      const overdueMs = nowMs - dlMs;
      const grace = reportGraceMs(contract);
      if (overdueMs > grace) {
        push({
          kind: 'report_missing',
          owner: 'user',
          action: 'needs_human',
          blockedAtMs: dlMs,
          lastProgressMs: progressMs,
          dependency: `report:${contract.reportSchema}`,
          escalationMs: dlMs + grace,
          note: `子已超期 ${overdueMs}ms (宽限 ${grace}ms) 仍未补齐报告 → 转人工`,
        });
      } else {
        push({
          kind: 'report_missing',
          owner: 'child',
          action: 'request_report',
          blockedAtMs: dlMs,
          lastProgressMs: progressMs,
          dependency: `report:${contract.reportSchema}`,
          escalationMs: dlMs + grace,
          note: `子到期未回报 (超期 ${overdueMs}ms, 宽限 ${grace}ms) → 要求补齐, 不接受为完成`,
        });
      }
    }
  } else {
    const missingParts = missingReportParts(contract, report);
    if (missingParts.length > 0) {
      const reportedMs = toMs(report.reportedAt);
      const blockedAtMs = reportedMs ?? nowMs;
      const grace = reportGraceMs(contract);
      push({
        kind: 'report_missing',
        owner: 'child',
        action: 'request_report',
        blockedAtMs,
        lastProgressMs: progressMs,
        dependency: `report:${contract.reportSchema}`,
        escalationMs: blockedAtMs + grace,
        note: `报告不完整 (${missingParts.join('; ')}) → 不接受为完成, 要求补充; ${grace}ms 内不补则转人工`,
      });
    }
    // ---- 6. 子自报阻塞: 透传 kind, 但 owner/动作按**父的**规则表定 ----------
    const childBlock = report.blockReason;
    if (childBlock !== null) {
      const childBlockedMs = toMs(childBlock.blockedAt) ?? nowMs;
      const childProgressMs = toMs(childBlock.lastProgressAt);
      const childEscalationMs = toIsoMsOrNull(childBlock.escalationAt) ?? childBlockedMs + DEFAULT_ESCALATION_MS;
      const defaults = BLOCK_HANDLING_DEFAULTS[childBlock.kind];
      push({
        kind: childBlock.kind,
        // 子自报的 owner/建议只当线索: 由父的规则表定 owner 与动作 (子不许私改处置)
        owner: defaults.owner,
        action: defaults.action,
        blockedAtMs: childBlockedMs,
        lastProgressMs: childProgressMs,
        dependency: childBlock.dependency,
        escalationMs: childEscalationMs,
        note: `子 Agent 自报阻塞「${childBlock.kind}」${
          childBlock.note === '' ? ' (子未写说明)' : ` (子自报原文: ${childBlock.note})`
        }`,
      });
    }
  }

  return out;
}

function toIsoMsOrNull(iso: IsoTimestamp | null): number | null {
  return iso === null ? null : toMs(iso);
}

// ============================================================================
// ② planBlockHandling
// ============================================================================

function isKnownAction(value: string): value is BlockResolutionAction {
  return (BLOCK_RESOLUTION_ACTIONS as readonly string[]).includes(value);
}

/**
 * 该拿这条阻塞怎么办 (只给动作, 不动状态; 副作用由接线层执行)。
 *
 * 优先级:
 *   ① 已处理的记录 → 以**实际**动作为准 (记录既是事实也是结论)
 *   ② 记录自带的 `suggestedAction` (detectBlocks 已按执行权/二段/超时上下文细化过) → 采用
 *   ③ 外部构造 (磁盘/JSON) 的记录可能带着非法动作 → 回落按 kind 的默认处理表
 *
 * 硬约束: 工具/权限/预算被阻**永不**返回 `takeover` / `replace_child` (不自动绕过 Harness)。
 */
export function planBlockHandling(b: BlockRecord): BlockResolutionAction {
  if (b.resolvedAt !== null && b.resolution !== null) return b.resolution;
  if (isKnownAction(b.suggestedAction)) return b.suggestedAction;
  return BLOCK_HANDLING_DEFAULTS[b.kind].action;
}

// ============================================================================
// ③ toUserVisibleState
// ============================================================================

function isTerminalGoalState(state: GoalLifecycleState): boolean {
  return TERMINAL_GOAL_STATES.includes(state);
}

/**
 * 盘上的 continuation → 判定层能安全读的记录 (**唯一**归一化点, 2026-09-25 跨阶段修复)。
 *
 * 为什么要有它 (真问题, 不是防御性编程):
 *   `goal-store.setContinuation()` 是**部分覆盖** —— 一次只写几个字段 (例如唤醒时只写
 *   `{wakeReason:'active', wakeAt:undefined}`), 所以 `goal.continuation` 上
 *   `pendingReports` / `unresolvedItems` 这类**列表字段在运行期确实可能缺席** (类型上也是 optional)。
 *   而调用方直传 `{...goal.continuation}` 是**合法**的写法 (`goalVisibleState` / `/api/goals` 都在用),
 *   于是判定层里那句 `c.pendingReports.length` 会直接抛 TypeError —— 表现为"界面拿不到状态",
 *   而不是"少了一个字段"。
 *
 * 两条纪律:
 *   · **缺的按"没有"补** (空数组), 与 `goal-store.continuationView` 同一口径 —— 不是编一个状态,
 *     只是把"没记过"读成"没有";
 *   · **不发明字段值**: `state` 缺就保持缺席, 由判定层当"没有终态声明"读 (绝不默认成某个终态/进行态)。
 *     `isTerminalGoalState(undefined)` 天然为 false, 所以缺席不会被读成 `ended` 或 `executing`。
 */
export function normalizeContinuationRecord(
  c: GoalContinuationRecord | Partial<GoalContinuationRecord> | null | undefined,
): GoalContinuationRecord | null {
  if (!c || typeof c !== 'object') return null;
  return {
    ...(c as GoalContinuationRecord),
    pendingReports: Array.isArray(c.pendingReports) ? [...c.pendingReports] : [],
    unresolvedItems: Array.isArray(c.unresolvedItems) ? [...c.unresolvedItems] : [],
  };
}

/**
 * 内部状态 → 用户可见**六类** (其余内部状态一律不外露: lease · reducer · internal status · retry counter · worker owner)。
 *
 * 优先级 (确定性, 不随 blocks 数组顺序变化):
 *   ① 未解决阻塞的处置就是 `needs_human` (或决策/继续记录显式要人) → `needs_your_decision`
 *   ② 目标**终态** → `ended` (2026-09-25 补的第 6 类):
 *      此前五类里没有"已结束", 只能借用 `needs_your_decision`, 且**绝不能**返回 `executing` ——
 *      把一个已经结束的目标显示成"正在执行", 正是 P3 要防的假象 ("看着在跑其实没在跑")。
 *      汇报层仍应用 `conclusion` 表达"已完成/已失败", 不得把本返回值当"还在跑"的依据。
 *   ③ 未解决阻塞 → 子被阻塞 > 无进展 > 等外部
 *   ④ 决策/继续记录描述的等待或无进展
 *   ⑤ 还有子任务没回报 → 等回复
 *   ⑥ 默认 `executing` (没有已知阻塞/等待/无进展)
 */
export function toUserVisibleState(
  raw: GoalContinuationRecord | Partial<GoalContinuationRecord> | null,
  blocks: BlockRecord[],
  decision: ContinuationDecision | null,
): UserVisibleState {
  // 归一化在这里做 (唯一入口) —— 见 normalizeContinuationRecord 的注释:
  // 盘上的 continuation 允许缺字段, 判定函数不该把"少一个字段"变成抛错。
  const c = normalizeContinuationRecord(raw);
  const unresolved = blocks.filter((b) => b.resolvedAt === null);

  // ① 需要人
  if (unresolved.some((b) => b.suggestedAction === 'needs_human')) return 'needs_your_decision';
  if (
    decision !== null &&
    (decision.decision === 'ask_human' || decision.decision === 'pause' || decision.state === 'needs_decision')
  ) {
    return 'needs_your_decision';
  }
  if (c !== null && (c.state === 'needs_human' || c.state === 'paused')) return 'needs_your_decision';

  // ② 终态 (第 6 类 `ended`: 已结束绝不说成"正在执行", 也不再冒充"需要你决定")
  if (c !== null && isTerminalGoalState(c.state)) return 'ended';
  if (decision !== null && (decision.state === 'completed' || decision.state === 'failed')) {
    return 'ended';
  }

  // ③ 未解决阻塞 (子被阻塞 > 无进展 > 等外部)
  for (const state of USER_VISIBLE_BLOCK_PRIORITY) {
    if (unresolved.some((b) => USER_VISIBLE_STATE_FOR_BLOCK_KIND[b.kind] === state)) return state;
  }

  // ④ 决策描述的状态
  if (decision !== null) {
    if (decision.state === 'no_progress') return 'no_progress';
    if (decision.state === 'waiting_external' || decision.state === 'waiting_agent') {
      return 'waiting_external_reply';
    }
  }

  // ⑤ 继续记录描述的等待 / 无进展
  if (c !== null) {
    if (c.state === 'stalled') return 'no_progress';
    if (c.state === 'awaiting_external' || c.state === 'retry_wait') return 'waiting_external_reply';
  }

  // ⑥ 还有子任务没回报 → 等回复 (比"正在执行"更具体)
  if (c !== null && c.pendingReports.length > 0) return 'waiting_external_reply';

  // ⑦ 默认: 没有已知阻塞/等待/无进展
  return 'executing';
}
