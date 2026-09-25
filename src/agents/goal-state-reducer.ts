/**
 * goal-state-reducer.ts — **改动 Goal 状态的唯一漏斗** (M0 接线冻结, 2026-09-25)
 *
 * ## 为什么必须只有这一个漏斗
 *
 * 接线前, 全仓有 6 个模块各拿 `updateGoal(goalId, { status: ... })` 直接改 Goal 状态
 * (Supervisor / 技能门禁 / 外部事件 / 联系方式链 / 判据提议 / Web 唤醒)。同一个 Goal 的终态
 * 于是有两个以上的写入者 —— 谁最后写谁赢, 且没有任何一处能看到"这个状态是怎么来的"。
 *
 * 这个模块把**所有** Goal 状态变更收敛成一个两步:
 *
 *   ① `planGoalStateChange(intent)` —— **纯函数**: 吃一个声明式的**意图** (intent), 吐出计划
 *      (`status` / `continuation` 补丁 / 证据 / 未解决项 / 结构化原因)。不碰盘、不读钟、不 import fs。
 *      纯函数的意义: 状态判决可以被单测穷举, 也可以被门断言, 而不必先造一个真 Goal。
 *   ② `applyGoalStatePlan(plan)` —— **唯一**的落盘出口 (调 goal-store 的 `updateGoal` / `setContinuation`
 *      / `addEvidence`)。源码级门钉住: 除 `goal-store.ts` 本体外, 只有本文件允许出现
 *      `updateGoal(..., { status: ... })` (见 `wiring/seams.ts` 的规则 ②)。
 *
 * ## 边界 (刻意不做)
 *
 * - **不新增状态机**: intent 的名字就是既有的调用点语义, 一个不多。
 * - **不新增存储**: 全部落进既有的 Goal / continuation 字段。
 * - **不决定"是否继续"**: 那是 Supervisor + continuation 接缝的事 (规则 ①)。本模块只负责
 *   "把已经作出的决定**如实**写成 Goal 的状态", 并对完成门**不放松** (completed 仍必须过
 *   `completeGoalIfEligible`; 门拒绝就退回 active, 不许装作完成)。
 * - **不碰 Run**: 关闭 Run 只有 closeRun 一条路 (规则 ③), 与本模块无关。
 */

import {
  addEvidence,
  completeGoalIfEligible,
  readGoal,
  setContinuation,
  setUnresolved,
  updateGoal,
  type GoalContinuation,
  type GoalRecord,
  type GoalStatus,
} from './goal-store.js';

// ============================================================================
// §1. 意图 (intent) —— 声明式, 一个意图 = 一个既有调用点的语义
// ============================================================================

export const GOAL_STATE_INTENTS = [
  'closure_outcome',        // Run 收尾后的合并结论 (Supervisor / Runner 独立收尾)
  'flywheel_stop',          // 飞轮明确判停 (fail / pause / 无进展熔断 / 硬底线)
  'user_revoked_goal',      // 用户明确撤销 → abandoned (规则 1: 用户撤销优先级最高)
  'skill_gate_block',       // 技能门禁拦下 → 交人 (不启动 Run)
  'skill_gate_record',      // 只记技能就绪事实, 不改状态
  'skill_upgrade_approved', // 人工批准技能升级 → 回到可继续
  'external_wait_enter',    // 进入"等外部回话"
  'external_wait_expired',  // 外部等待超时 → 交人
  'external_event_arrived', // 外部事件到达 → 拉回 active
  'contact_revoked_human',  // 联系方式授权被撤销 → 交人
  'criteria_needs_human',   // 判据提不出来 → 交人
  'block_escalated_human',  // 子 Agent 被阻塞且已升级 → 交人 (规则 ④ 的一条终止路径)
  'manual_wake',            // 人明确说"外部条件我已满足"
] as const;
export type GoalStateIntent = (typeof GOAL_STATE_INTENTS)[number];

/** 收尾结论 (与 Supervisor 的 MergedGoalOutcome / Runner 的 CloseRunResult 同口径的最小面) */
export interface GoalOutcomeInput {
  goalStatus: GoalStatus;
  continuation: Partial<GoalContinuation>;
  reason: string;
}

export interface GoalStateChangeInput {
  goalId: string;
  intent: GoalStateIntent;
  now: string;
  /** 谁提的意图 (写进证据, 让状态变更可追溯) */
  by?: string;
  /** intent=closure_outcome */
  outcome?: GoalOutcomeInput;
  /** 本轮 Run (证据同步用) */
  runId?: string | null;
  /** 成功步骤的事实摘要 (证据同步) */
  runEvidence?: string[];
  /** intent=flywheel_stop */
  stopStatus?: 'failed' | 'paused' | 'needs_human';
  decisionId?: string | null;
  nextAction?: string;
  unresolvedItems?: string[];
  /** intent=skill_gate_block / skill_gate_record / criteria_needs_human / external_wait_* */
  reason?: string;
  skillReadiness?: Record<string, unknown>;
  /** intent=external_wait_enter */
  externalWait?: string;
  /** intent=contact_revoked_human */
  revokeNote?: string;
  /** intent=block_escalated_human: 写进 continuation.needsExternal 的阻塞摘要 */
  needsExternalText?: string;
  /** intent=manual_wake */
  wakeReason?: string;
  needsExternalCleared?: boolean;
}

// ============================================================================
// §2. 计划 (纯函数输出)
// ============================================================================

export interface GoalStatePlan {
  goalId: string;
  intent: GoalStateIntent;
  /** 要不要写 Goal.status (null = 这次意图不改状态) */
  status: GoalStatus | null;
  /** 终态才带的 resolution */
  resolution?: { reason: string; at: string };
  /** continuation 补丁 (整片覆盖语义由 applyGoalStatePlan 决定) */
  continuation?: Partial<GoalContinuation>;
  /** continuation 里要**显式清空**的字段 (整片覆盖时不能只是不写) */
  clearContinuationFields?: (keyof GoalContinuation)[];
  /** 要追加的证据 */
  evidence: string[];
  /** 要覆盖的未解决项 (null = 不动) */
  unresolvedItems: string[] | null;
  /** 需不需要过完成门 (status='completed' 时必须) */
  completionGate: boolean;
  /** 结构化原因 (人可读; 也是 skipped/errors 的原样出口) */
  reason: string;
}

function planBase(goalId: string, intent: GoalStateIntent, reason: string): GoalStatePlan {
  return {
    goalId,
    intent,
    status: null,
    evidence: [],
    unresolvedItems: null,
    completionGate: false,
    reason,
  };
}

/**
 * 意图 → 计划。**纯函数**: 不读盘、不读钟 (`now`/`reason` 全部由调用方注入)。
 *
 * 阴性对照 (门里真跑): 把 `closure_outcome` 的 `completionGate` 从 true 改成 false →
 * 完成门就被绕过了, `goal-state-reducer.test.ts` 的"完成门拒绝 → 退回 active"立刻判红。
 */
export function planGoalStateChange(input: GoalStateChangeInput): GoalStatePlan {
  const { goalId, now } = input;
  const by = input.by ?? 'system';
  const runRef = input.runId ? `run=${input.runId}` : 'run=-';

  switch (input.intent) {
    case 'closure_outcome': {
      const o = input.outcome;
      if (!o) {
        // 没有结论就不许改状态 (不许"顺手"写一个)
        return planBase(goalId, input.intent, '缺 outcome: 收尾结论未给出 → 不改 Goal 状态');
      }
      const p = planBase(goalId, input.intent, o.reason);
      p.status = o.goalStatus;
      p.completionGate = o.goalStatus === 'completed';
      p.continuation = o.continuation;
      if (o.goalStatus === 'failed' || o.goalStatus === 'abandoned') {
        p.resolution = { reason: o.reason, at: now };
      }
      if (input.runEvidence?.length) {
        p.evidence = input.runEvidence.slice(-5).map((s) => `${runRef}: ${String(s).slice(0, 200)}`);
      }
      return p;
    }

    case 'flywheel_stop': {
      const status = input.stopStatus ?? 'needs_human';
      const p = planBase(goalId, input.intent, `飞轮判停 (${status}): ${input.reason ?? ''}`.trim());
      p.status = status;
      if (status === 'failed') p.resolution = { reason: `飞轮判不可达: ${input.reason ?? ''}`, at: now };
      p.continuation = {
        state: status,
        autoContinue: false,
        wakeAt: undefined,
        wakeReason: status === 'failed' ? 'failed' : status === 'paused' ? 'paused' : 'needs_human',
        lastDecisionId: input.decisionId ?? undefined,
        unresolvedItems: [...(input.unresolvedItems ?? [])],
        nextAction: input.nextAction || undefined,
        updatedAt: now,
      };
      p.unresolvedItems = [...(input.unresolvedItems ?? [])].slice(0, 30);
      return p;
    }

    case 'user_revoked_goal': {
      const reason = input.reason || '用户明确撤销 → 目标终止 (不许继续跑)';
      const p = planBase(goalId, input.intent, reason);
      p.status = 'abandoned';
      p.resolution = { reason, at: now };
      p.continuation = {
        autoContinue: false,
        wakeAt: undefined,
        wakeReason: 'active',
        state: 'abandoned',
        updatedAt: now,
      };
      p.evidence = [`用户撤销 (by ${by}): ${reason}`];
      return p;
    }

    case 'skill_gate_block': {
      const reason = input.reason || '技能未就绪';
      const p = planBase(goalId, input.intent, `技能门禁拦截: ${reason}`);
      p.status = 'needs_human';
      p.continuation = {
        wakeReason: 'needs_human',
        autoContinue: false,
        needsExternal: undefined,
        skillReadiness: input.skillReadiness ?? { ok: false, at: now, reason },
        updatedAt: now,
      } as Partial<GoalContinuation>;
      p.clearContinuationFields = ['needsExternal'];
      p.evidence = [`技能门禁拦截 (by ${by}): ${reason}`];
      return p;
    }

    case 'skill_gate_record': {
      const p = planBase(goalId, input.intent, '技能就绪检查结论已记事实 (不改状态)');
      p.continuation = { skillReadiness: input.skillReadiness ?? {}, updatedAt: now } as Partial<GoalContinuation>;
      return p;
    }

    case 'skill_upgrade_approved': {
      const p = planBase(goalId, input.intent, '人工批准技能升级 → 回到可继续');
      p.status = 'active';
      p.continuation = {
        skillReadiness: input.skillReadiness ?? { ok: true, at: now, reason: '人工批准技能升级' },
        wakeReason: 'active',
        autoContinue: true,
        updatedAt: now,
      } as Partial<GoalContinuation>;
      p.evidence = [input.reason ?? `技能升级已被人工批准 (by ${by})`];
      return p;
    }

    case 'external_wait_enter': {
      const p = planBase(goalId, input.intent, `进入等外部回话: ${input.externalWait ?? ''}`.trim());
      p.status = 'awaiting_external';
      return p;
    }

    case 'external_wait_expired': {
      const reason = input.reason || '外部等待超时 → 转人工';
      const p = planBase(goalId, input.intent, reason);
      p.status = 'needs_human';
      p.continuation = {
        wakeReason: 'needs_human',
        needsExternal: undefined,
        autoContinue: false,
        lastExternalTimeout: reason,
        updatedAt: now,
      } as Partial<GoalContinuation>;
      p.clearContinuationFields = ['needsExternal', 'external'];
      p.evidence = [`外部事件超时 (by ${by}): ${reason}`];
      return p;
    }

    case 'external_event_arrived': {
      const p = planBase(goalId, input.intent, '外部事件到达 → 拉回 active (下一 tick 真执行)');
      p.status = 'active';
      p.continuation = {
        wakeReason: 'active',
        needsExternal: undefined,
        autoContinue: true,
        wakeAt: undefined,
        updatedAt: now,
      } as Partial<GoalContinuation>;
      p.clearContinuationFields = ['needsExternal', 'external'];
      return p;
    }

    case 'contact_revoked_human': {
      const reason = input.revokeNote || '联系方式授权被撤销 → 该联系不可自动重试';
      const p = planBase(goalId, input.intent, `转人工: ${reason}`);
      p.status = 'needs_human';
      p.continuation = {
        wakeReason: 'needs_human',
        needsExternal: undefined,
        autoContinue: false,
        updatedAt: now,
      } as Partial<GoalContinuation>;
      p.clearContinuationFields = ['needsExternal'];
      p.evidence = [`联系方式授权撤销 (by ${by}): ${reason}`];
      return p;
    }

    case 'criteria_needs_human': {
      const reason = input.reason || '判据提不出来 (目标太模糊) → 交人';
      const p = planBase(goalId, input.intent, reason);
      p.status = 'needs_human';
      p.evidence = [`判据生成失败 (by ${by}): ${reason}`];
      return p;
    }

    /**
     * 规则 ④ 的一条终止路径: 子 Agent 被阻塞且升级到父 → 交人。
     * 旧写法在接线层直接 setContinuation + updateGoal(status) —— 那是绕过 Goal reducer 的状态写入。
     */
    case 'block_escalated_human': {
      const reason = input.reason || '子 Agent 被阻塞且已升级 → 交人';
      const p = planBase(goalId, input.intent, `阻塞升级转人工: ${reason}`);
      p.status = 'needs_human';
      p.continuation = {
        state: 'needs_human',
        autoContinue: false,
        wakeReason: 'needs_human',
        needsExternal: (input.needsExternalText ?? reason).slice(0, 300),
        // 旧写法把未解决项写在 continuation 上 (Supervisor 下一轮读的就是这里) —— 语义不变, 两个落点都写
        unresolvedItems: input.unresolvedItems ?? [],
        updatedAt: now,
      } as Partial<GoalContinuation>;
      if (input.unresolvedItems) p.unresolvedItems = input.unresolvedItems;
      p.evidence = [`阻塞升级转人工 (by ${by}): ${reason}`];
      return p;
    }

    case 'manual_wake': {
      const p = planBase(goalId, input.intent, `人工唤醒: ${input.reason ?? '外部条件已满足'}`);
      p.status = 'active';
      p.continuation = {
        wakeReason: 'active',
        needsExternal: undefined,
        autoContinue: true,
        wakeAt: undefined,
        updatedAt: now,
      } as Partial<GoalContinuation>;
      p.clearContinuationFields = ['needsExternal'];
      return p;
    }

    default: {
      // 穷举不完 = 有人加了 intent 忘了写计划 → 宁可拒绝也不静默
      const never: never = input.intent;
      return planBase(goalId, never as GoalStateIntent, `未登记的意图: ${String(never)} → 拒绝改状态`);
    }
  }
}

// ============================================================================
// §3. 唯一落盘出口
// ============================================================================

export interface GoalStateApplyResult {
  ok: boolean;
  goalId: string;
  intent: GoalStateIntent;
  /** 落盘后的 Goal.status (读不到时 null) */
  status: GoalStatus | null;
  /** 实际做了哪些写 (可核验) */
  applied: string[];
  reason: string;
  /** 完成门拒绝时的原因 (只有 intent=closure_outcome + status=completed 才可能非空) */
  gateRejected?: string;
}

/** 终态: 已终的 Goal 不许被非终态意图改回来 (历史不可改写) */
const GOAL_TERMINAL: GoalStatus[] = ['completed', 'failed', 'abandoned'];

/**
 * 把计划落盘。**全仓唯一的 Goal 状态写入出口**。
 *
 * 三条纪律:
 *   ① 终态不可被非终态意图改回 (除了显式的人工意图); 已终的 Goal 不改写历史;
 *   ② `completed` 必须过完成门 —— 门拒绝就退回 active 并**如实**记原因 (不许装作完成);
 *   ③ 写失败不静默: 返回 ok=false + 原因, 由调用方原样记进 report/errors。
 */
export async function applyGoalStatePlan(plan: GoalStatePlan): Promise<GoalStateApplyResult> {
  const res: GoalStateApplyResult = {
    ok: true, goalId: plan.goalId, intent: plan.intent, status: null, applied: [], reason: plan.reason,
  };
  const applied = res.applied;

  const goal = await readGoal(plan.goalId).catch(() => null);
  if (!goal) {
    res.ok = false; res.reason = `${plan.reason} (goal 不存在: ${plan.goalId})`;
    return res;
  }

  // ① 终态保护: 已经完成的/失败的/放弃的目标不许被别的意图拉回来
  const HUMAN_INTENTS: GoalStateIntent[] = ['skill_upgrade_approved', 'manual_wake', 'user_revoked_goal'];
  if (GOAL_TERMINAL.includes(goal.status) && plan.status && plan.status !== goal.status && !HUMAN_INTENTS.includes(plan.intent)) {
    res.ok = false;
    res.status = goal.status;
    res.reason = `已终态 (${goal.status}) 不许被 ${plan.intent} 改写 → 拒绝 (历史不可改写)`;
    return res;
  }

  // ② 完成门: completed 只有一条路
  let effectiveStatus = plan.status;
  if (plan.completionGate && plan.status === 'completed') {
    const gate = await completeGoalIfEligible(plan.goalId).catch((err) => ({
      ok: false, reason: `完成门自身失败: ${String((err as Error)?.message || err).slice(0, 160)}`, goal: null,
    }));
    if (!gate.ok) {
      // 门拒绝 → 如实退回 active (保留原因), 不许装作完成
      res.gateRejected = gate.reason;
      effectiveStatus = 'active';
      res.reason = `完成门拒绝 (${gate.reason}) → 退回 active`;
      await setContinuation(plan.goalId, {
        ...(plan.continuation ?? {}),
        wakeReason: 'active',
        autoContinue: true,
        updatedAt: plan.continuation?.updatedAt ?? new Date().toISOString(),
      } as Partial<GoalContinuation>).then(() => applied.push('continuation:reject_rollback')).catch(() => null);
      // 未解决项照旧记下来 (完成门说缺什么, 就写什么 —— 这是下一轮继续的依据, 不许丢)
      const gateMissing = 'missing' in gate ? gate.missing : undefined;
      if (gateMissing?.length) {
        await setUnresolved(plan.goalId, gateMissing).then(() => applied.push('unresolved')).catch(() => null);
      }
      await updateGoal(plan.goalId, { status: 'active' }).then(() => applied.push('status:active')).catch(() => null);
      res.status = (await readGoal(plan.goalId).catch(() => null))?.status ?? null;
      return res;
    }
    applied.push('completion_gate:passed');
    res.status = (await readGoal(plan.goalId).catch(() => null))?.status ?? null;
    if (plan.continuation && plan.continuation.wakeReason !== 'completed') {
      await setContinuation(plan.goalId, plan.continuation).then(() => applied.push('continuation')).catch(() => null);
    }
    return res;
  }

  // ③ continuation (整片覆盖: 先清需要清的, 再写)
  if (plan.continuation) {
    const patch: Partial<GoalContinuation> = { ...plan.continuation };
    for (const f of plan.clearContinuationFields ?? []) {
      if (!(f in patch)) (patch as Record<string, unknown>)[f] = undefined;
    }
    await setContinuation(plan.goalId, patch).then(() => applied.push('continuation')).catch(() => null);
  }

  // ④ 证据 / 未解决项
  if (plan.evidence.length) {
    await addEvidence(plan.goalId, plan.evidence).then(() => applied.push('evidence')).catch(() => null);
  }
  if (plan.unresolvedItems) {
    await setUnresolved(plan.goalId, plan.unresolvedItems).then(() => applied.push('unresolved')).catch(() => null);
  }

  // ⑤ 状态本身
  if (effectiveStatus && effectiveStatus !== goal.status) {
    const patch: Partial<GoalRecord> = { status: effectiveStatus };
    if (plan.resolution && effectiveStatus !== 'active') patch.resolution = plan.resolution;
    const next = await updateGoal(plan.goalId, patch).catch(() => null);
    if (!next) {
      res.ok = false;
      res.reason = `${plan.reason} (状态写入失败: status=${effectiveStatus})`;
    } else {
      applied.push(`status:${effectiveStatus}`);
    }
  } else if (effectiveStatus) {
    applied.push(`status:${effectiveStatus}(unchanged)`);
  }

  res.status = (await readGoal(plan.goalId).catch(() => null))?.status ?? effectiveStatus;
  return res;
}

/** 意图 → 计划 → 落盘 (调用方只用这一个入口) */
export async function reduceGoalState(input: GoalStateChangeInput): Promise<GoalStateApplyResult> {
  return applyGoalStatePlan(planGoalStateChange(input));
}

// ============================================================================
// §4. 给上层的只读辅助 (不写盘)
// ============================================================================

/**
 * 这个 Goal 现在**允许**被哪个状态吗? (终态/等人态的边界查询)
 *
 * 存在的意义: 接线前的调用点各自手写 `!['completed','failed','abandoned'].includes(status)`,
 * 六处写法不一致 (有的漏 abandoned)。收敛到一处, 由门断言只有这一处。
 */
export function goalAcceptsStatusChange(current: GoalStatus, next: GoalStatus, intent: GoalStateIntent): { ok: boolean; reason: string } {
  if (current === next) return { ok: true, reason: '状态未变' };
  if (GOAL_TERMINAL.includes(current)) {
    const allowedByHuman: GoalStateIntent[] = ['skill_upgrade_approved', 'manual_wake', 'user_revoked_goal'];
    if (!allowedByHuman.includes(intent)) {
      return { ok: false, reason: `已终态 (${current}): ${intent} 不许改写` };
    }
  }
  return { ok: true, reason: `${current} → ${next} (${intent})` };
}
