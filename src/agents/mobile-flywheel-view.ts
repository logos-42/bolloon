/**
 * mobile-flywheel-view.ts — 「飞轮进度」的手机视图投影 (2026-09-25)
 *
 * 手机上新加的「飞轮进度」页**只读消费** `src/agents/goal-flywheel/*` 的冻结类型, 不造第二套状态:
 *   · 用户可见状态 = `toUserVisibleState(continuation, blocks, decision)` (P3, 闭集五类)
 *   · 五类的中英文案 = `USER_VISIBLE_STATE_LABELS` (冻结表)
 *   · 阻塞建议动作 = `planBlockHandling` (P3, 不自动绕过 Harness)
 *   · 汇报字段面 = `USER_REPORT_FIELDS` (P4b 的九字段) —— 视图里的 `report` 只允许出现这九个
 *   · 内部字段 (lease / reducer / internal_status / retry_counter / worker_owner) **一律不出现**
 *
 * 本文件是纯函数 (不读钟、不做 I/O、不 import 任何 P4 之前的实现文件), 所以**桌面路由与手机 UI 可以共用一份**,
 * 也就能被单测直接钉住"五类映射 + 不泄漏内部词"这两条。
 *
 * 刻意不做 (如实): 不读 lease / 不判"谁在跑" / 不显示 goalId·runId·workId·childAgentId (那是内部标识);
 * 风险级别只透传 decision.riskLevel (高/中/低) 供 UI 提示"这一步需要你留意", 不据此自动做什么。
 */

import { toUserVisibleState, planBlockHandling } from './goal-flywheel/work-monitor.js';
import {
  USER_VISIBLE_STATE_LABELS, USER_REPORT_FIELDS, MUST_NOT_EXPOSE_FIELDS,
  GOAL_TERMINAL_STATES, BLOCK_RESOLUTION_ACTIONS,
  type BlockRecord, type BlockResolutionAction, type BlockKind, type BlockOwner,
  type ContinuationDecision, type GoalContinuationRecord,
  type UserReport, type UserReportField, type UserVisibleState,
} from './goal-flywheel/types.js';

/** 已冻结: 汇报字段面 + 内部字段面 (这里再导出一次, 供视图/测试直接引用) */
export { USER_REPORT_FIELDS, MUST_NOT_EXPOSE_FIELDS };

// ── 呈现用文案 (只翻译冻结枚举值, 不新增状态) ────────────────────────────────

export const BLOCK_OWNER_LABELS: Record<BlockOwner, { zh: string; en: string }> = {
  parent: { zh: '由主任务处理', en: 'Handled by the main task' },
  child: { zh: '由子任务处理', en: 'Handled by the sub-task' },
  external: { zh: '等外部处理', en: 'Waiting on an external party' },
  system: { zh: '由系统处理', en: 'Handled by the system' },
  user: { zh: '要你来处理', en: 'Needs you' },
};

export const BLOCK_ACTION_LABELS: Record<string, { zh: string; en: string }> = {
  send_adjustment: { zh: '先发一次调整指令', en: 'Send an adjustment first' },
  replace_child: { zh: '替换执行者', en: 'Replace the runner' },
  takeover: { zh: '主任务接管', en: 'Main task takes over' },
  request_report: { zh: '要求补齐报告', en: 'Request a complete report' },
  escalate_parent: { zh: '上报主任务', en: 'Escalate to the main task' },
  change_plan: { zh: '改计划', en: 'Change the plan' },
  wait_dependency: { zh: '继续等', en: 'Keep waiting' },
  needs_human: { zh: '转人工', en: 'Hand to a human' },
};

/** 阻塞类型 → 极短的人话 (只说"卡在哪一类", 不暴露内部字段名) */
export const BLOCK_KIND_LABELS: Record<BlockKind, { zh: string; en: string }> = {
  no_heartbeat: { zh: '子任务没有心跳了', en: 'Sub-task stopped reporting' },
  waiting_dependency: { zh: '在等依赖', en: 'Waiting on a dependency' },
  repeated_failure: { zh: '反复失败', en: 'Repeated failures' },
  no_progress: { zh: '活着但没进展', en: 'Alive but no progress' },
  tool_blocked: { zh: '工具或资源被阻', en: 'Tool or resource blocked' },
  budget_blocked: { zh: '预算用尽', en: 'Budget exhausted' },
  permission_blocked: { zh: '权限不足', en: 'Permission missing' },
  runner_unavailable: { zh: '没有可用执行器', en: 'No runner available' },
  external_timeout: { zh: '等外部超时', en: 'External wait timed out' },
  report_missing: { zh: '报告不完整或没回', en: 'Report missing or incomplete' },
};

// ── 视图类型 ────────────────────────────────────────────────────────────────

export interface MobileFlywheelBlockItem {
  kind: BlockKind;
  kindLabel: { zh: string; en: string };
  /** 谁该处理 (冻结枚举的中英文案) */
  ownerLabel: { zh: string; en: string };
  /** 建议动作 (planBlockHandling 的结果; 描述用, 手机不执行它) */
  suggestedAction: string;
  actionLabel: { zh: string; en: string };
  /** 卡了多久 (毫秒; now - blockedAt) */
  blockedForMs: number;
  /** 在等什么 (人可读; 没有就 null) */
  dependency: string | null;
  /** 说明 (人可读) */
  note: string;
  /** 什么时候必须升级 (ISO; 没有就 null) */
  escalationAt: string | null;
  /** 最后有进展是什么时候 (ISO) */
  lastProgressAt: string;
}

export interface MobileFlywheelView {
  /** 五类用户可见状态之一 */
  visibleState: UserVisibleState;
  stateLabel: { zh: string; en: string };
  /** 用户汇报 (只含 USER_REPORT_FIELDS 里的字段名) */
  report: UserReport;
  /** 未解决阻塞 (只列未解决的) */
  blocks: MobileFlywheelBlockItem[];
  /** 供 UI 做相对时间: 距离下次醒来还有多久 (毫秒; 无 wakeAt → null) */
  resumeInMs: number | null;
  /** 由谁执行下一步 (人可读描述, 不是内部 id; null = 本节点即可) */
  requiredAgent: string | null;
  /** 风险级别 (透传 decision.riskLevel; null = 没有决策记录) */
  riskLevel: 'low' | 'medium' | 'high' | null;
  generatedAt: string;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}
function msSince(iso: string | null, now: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/**
 * 飞轮进度 → 手机视图。
 * `continuation` 为 null 时 (终态目标没有 continuation) 仍如实给出五类之一 + 结论,
 * **不编造"正在执行"** (那正是 P3 要防的假象)。
 */
export function buildMobileFlywheelView(input: {
  continuation: GoalContinuationRecord | null;
  blocks: BlockRecord[];
  decision: ContinuationDecision | null;
  now: number;
}): MobileFlywheelView {
  const now = Number.isFinite(input?.now) ? input.now : 0;
  const continuation = input?.continuation ?? null;
  // 终态**不由调用方口述**: 直接读冻结的 GOAL_TERMINAL_STATES, 与 toUserVisibleState 第 ② 步同一判据
  const terminal = continuation !== null
    && (GOAL_TERMINAL_STATES as readonly string[]).includes(continuation.state);
  const allBlocks = Array.isArray(input?.blocks) ? input.blocks : [];
  const decision = input?.decision ?? null;

  // 冻结的映射: 用户可见状态只有一个来源
  const visibleState = toUserVisibleState(continuation, allBlocks, decision);
  const unresolved = allBlocks.filter((b) => (b as BlockRecord)?.resolvedAt === null);

  const blocks: MobileFlywheelBlockItem[] = unresolved.map((b) => {
    // 冻结表里没有这个 kind / 调用抛错时, 页面也不能打崩 —— 退回线索里的建议动作, 再不行按"转人工"
    let action: BlockResolutionAction;
    try {
      action = planBlockHandling(b);
    } catch {
      action = (BLOCK_RESOLUTION_ACTIONS as readonly string[]).includes(String(b.suggestedAction))
        ? (b.suggestedAction as BlockResolutionAction)
        : 'needs_human';
    }
    return {
      kind: b.kind,
      kindLabel: BLOCK_KIND_LABELS[b.kind] || { zh: '未知阻塞', en: 'Unknown block' },
      ownerLabel: BLOCK_OWNER_LABELS[b.owner] || { zh: '未知处理方', en: 'Unknown owner' },
      suggestedAction: action,
      actionLabel: BLOCK_ACTION_LABELS[action] || { zh: '转人工', en: 'Hand to a human' },
      blockedForMs: msSince(b.blockedAt, now),
      dependency: b.dependency ? String(b.dependency) : null,
      note: String(b.note || ''),
      escalationAt: isoOrNull(b.escalationAt),
      lastProgressAt: typeof b.lastProgressAt === 'string' ? b.lastProgressAt : '',
    };
  });

  const wakeAt = isoOrNull(continuation?.wakeAt);
  // 终态目标不承诺"下次醒来" (即使记录里还留着旧的 wakeAt, 也不该让人以为还会醒)
  const resumeInMs = terminal || !wakeAt ? null : Date.parse(wakeAt) - now;
  const completed = (decision?.progressDelta?.newlyCompletedCriteria || []) as number[];
  const evidence = (decision?.progressDelta?.newEvidence || []).map((e) => String(e)).slice(0, 10);
  // 口径: continuation = **当前计划** (下一步/还剩什么/何时醒来); decision = **最近一次自述** (为什么/证据/已满足判据)。
  // 所以还剩什么以继续记录为准, 没有才退回最近的决策记录。
  const remaining = (continuation ? continuation.unresolvedItems : decision?.unresolvedItems || []).map((s) => String(s)).slice(0, 10);
  const blockReasons = blocks.map((b) => `${b.kindLabel.zh} (${b.ownerLabel.zh}: ${b.actionLabel.zh})`);
  const nextStep = String(continuation?.nextAction || decision?.nextAction || '').trim()
    || (terminal ? '已经结束了 —— 看看结论, 决定要不要立新目标' : '（还没有写下下一步 —— 这本身就是要人看一眼的信号）');

  const conclusion = decision?.reason
    ? String(decision.reason)
    : (terminal ? '这个目标已经结束' : String(continuation?.wakeReason || ''));

  const exposed: UserReportField[] = ['conclusion', 'completed', 'evidence', 'remaining', 'blockReasons', 'nextStep', 'willContinue', 'expectedResumeAt', 'visibleState'];
  const report: UserReport = {
    conclusion,
    completed: completed.map((i) => `判据 #${i}`),
    evidence,
    remaining,
    blockReasons,
    nextStep,
    willContinue: continuation?.autoContinue === true,
    expectedResumeAt: wakeAt,
    visibleState,
    exposedFields: exposed,
    generatedAt: new Date(now).toISOString(),
  };

  return {
    visibleState,
    stateLabel: USER_VISIBLE_STATE_LABELS[visibleState],
    report,
    blocks,
    resumeInMs,
    requiredAgent: continuation?.requiredAgent ? `指定执行者: ${String(continuation.requiredAgent).slice(0, 24)}` : null,
    riskLevel: decision?.riskLevel ?? null,
    generatedAt: new Date(now).toISOString(),
  };
}

/** 视图里是否含内部字段名 (单测/门: 必须为空) */
export function findInternalFieldLeaks(text: string): string[] {
  const t = String(text ?? '');
  return MUST_NOT_EXPOSE_FIELDS.filter((f) => t.includes(f));
}
