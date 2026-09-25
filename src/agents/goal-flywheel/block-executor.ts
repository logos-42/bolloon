/**
 * block-executor.ts — P3b: 把 `planBlockHandling` 算出的**处置动作真执行** (2026-09-26)
 *
 * 存在的理由 (P5 验收 §2 缺口 4, 原话): 「`applyBlockHandling` 只对 `needs_human` / `escalate_parent` /
 * `change_plan` 真的改 Goal 状态 (→ needs_human) 或清 `pendingReports` (takeover); 而
 * `send_adjustment` / `request_report` / **`replace_child`** 只被塞进 `requests` 字符串列表 ——
 * 没有真的下发调整指令、没有真的换人、没有重派新合同」。
 * 本模块补上"**真执行**"这一半: 动作 → 具体一次调用 (带正确的对象与参数), 并把
 * 「做不了」的原因**显式**交人, 而不是静默塞进一个列表。
 *
 * ## 纪律 (与 `work-monitor.ts` 同一套, 不许松)
 *
 *   - **纯逻辑**: 零 I/O —— 不 import `fs` / 不 import 其它阶段的实现, 只与 `types.ts` +
 *     `work-monitor.ts` 的**纯函数** (`planBlockHandling`) 耦合。所有副作用走**注入的端口**。
 *   - **时间注入**: `now` 由调用方给, 本模块不读真实钟。
 *   - **不越权**: ① 执行权不在手上 (`authority.leaseHeld !== true`) → `takeover` **拒绝执行,
 *     端口一次都不调**; ② 调用者是子 Agent (`caller === 'child'`) → 一切改别人状态的动作全拒;
 *     ③ 工具/权限/预算被阻 → 即使记录里写着 `takeover`/`replace_child` 也**硬拒** (纵深防御,
 *     不靠上游自觉)。
 *   - **不静默**: 每一项"本该做却做不了"的事 (端口缺失 / 端口抛错 / 越权被拒 / 没有动作可做)
 *     都必须出现在 `needsHuman[]` 里, 并带人可读原因。`silentRisk` 是这份保证的自检位。
 *   - **只给结论不动手**: 本模块自己**不写** Goal / Run / 磁盘 —— 那是注入端口 (`record`) 与
 *     接线层的事; 因此它不会绕过「只有 Goal reducer 能改 Goal 状态」这条冻结规则 (规则 ②)。
 *
 * ## 接入点 (接线 = 别人的文件, 本模块只写清"差哪一行")
 *
 * 真实 tick 里的接入点是 `src/agents/execution-supervisor.ts` 的 `tick()` 内、
 * 阻塞巡检那一段 (**当前 L423–L439**「2.5 阻塞巡检」, `applyBlockHandling` 在 **L429**): 现在那里只调
 * `collectWorkBlocks` + `applyBlockHandling`, 拿到 `handling.actions` 后仅写进 `report.blocks` 与 log
 * (`handling.takeovers` 也只打了一行"父接管子工作"的日志)。**差的就是一行**:
 *
 * ```ts
 * // execution-supervisor.ts, applyBlockHandling(...) 之后 (同一段 try 内)
 * const execution = await executeBlockHandling({
 *   goalId: g.goalId,
 *   blocks,
 *   now: nowIso,
 *   // 执行权: 本 tick 内该 Goal 的 lease **尚未**被本 worker 持有 (认领发生在第 3 步) →
 *   //   这里如实传 false; 真正的父侧接管应由"已持有 lease 的那条路径"调 (见下)
 *   authority: { leaseHeld: false, caller: 'supervisor', leaseOwner: null },
 *   ports: blockExecutorPorts({ home }),   // ← 这个 helper **还没写**: 属接线层的活 (本模块是纯逻辑)
 * });
 * for (const a of execution.needsHuman) {
 *   this.emit({ kind: 'needs_human', goalId: g.goalId, message: `${a.blockId}: ${a.reason}` });
 * }
 * ```
 *
 * 端口实现落在**接线层** (`goal-flywheel-wiring.ts`, 本模块不 import 它):
 *   `claimLease` → `goal-store.claimGoal` (抢到再 `heartbeatGoal` 续) ·
 *   `replaceChild` → `subagent-manager` 停旧 + `dispatchChildWork` 重派新合同 ·
 *   `sendAdjustment` / `requestReport` → `sendChildInstruction` 一类的下发面 ·
 *   `changePlan` → 父改计划 (写 Goal 的计划字段, 经 reducer) ·
 *   `escalate` → Goal reducer 的 `block_escalated_human` (to='parent' 在 Goal 层同样收敛到人) ·
 *   `record` → `addEvidence` + `recordWorkHeartbeat` 一类的事实记录。
 * **本模块刻意不做这些事** —— 端口没注入时它只会如实报 `needs_human` (端口缺失), 不会假装做过。
 *
 * 阴性对照 (怎么知道这道门不是装饰; 见 `src/test/goal-flywheel-p6-block-executor.test.ts`):
 *   ① 把手上的 `leaseHeld` 传成 false → `takeover` 必须变成 `refused` 且 `claimLease` **零调用**;
 *   ② 把 `tool_blocked` 记录的 `suggestedAction` 改成 `replace_child` → 必须被硬拒 (不自动绕过 Harness);
 *   ③ 把所有端口拿掉 → 每一项都必须是 `needsHuman` (不是空数组、不是静默跳过);
 *   ④ 把 `escalate` 端口改成抛错 → 那一项必须是 `failed` + 原因里含错误原文 (不吞)。
 */

import type {
  BlockKind,
  BlockRecord,
  BlockResolutionAction,
  IsoTimestamp,
} from './types.js';
import { planBlockHandling } from './work-monitor.js';

// ============================================================================
// 硬规则常量 (导出: 测试与接线层都不许自己编)
// ============================================================================

/**
 * **永不**自动绕过 Harness 的阻塞类型。
 *
 * `planBlockHandling` 本身就不会给这些类型 `takeover`/`replace_child`; 本表是**纵深防御** ——
 * 磁盘/JSON 造出来的记录 (`suggestedAction` 可以被外部写成任意值) 也挡得住。
 */
export const NO_AUTO_BYPASS_KINDS: readonly BlockKind[] = [
  'tool_blocked',
  'permission_blocked',
  'budget_blocked',
] as const;

/** 这些动作要动别人的执行状态, 子 Agent 侧一律不许做 (只允许父/调度器/人) */
export const PARENT_ONLY_ACTIONS: readonly BlockResolutionAction[] = [
  'takeover',
  'replace_child',
  'send_adjustment',
  'request_report',
  'change_plan',
  'escalate_parent',
] as const;

/** 没有任何副作用、只表示"继续等"的动作 (执行后记 `deferred`, 不算失败) */
export const DEFERRED_ACTIONS: readonly BlockResolutionAction[] = ['wait_dependency'] as const;

/** 动作 → 它需要的端口名 (缺端口 = 做不了 = 必须如实报人) */
export const PORT_FOR_ACTION: Record<BlockResolutionAction, keyof BlockExecutionPorts | null> = {
  send_adjustment: 'sendAdjustment',
  replace_child: 'replaceChild',
  takeover: 'claimLease',
  request_report: 'requestReport',
  escalate_parent: 'escalate',
  change_plan: 'changePlan',
  wait_dependency: null,        // 无副作用: 不需要端口
  needs_human: 'escalate',      // 有 escalate 就真的上报; 没有也必须在 needsHuman 里留下
};

// ============================================================================
// 注入的端口 (所有副作用都在这里; 本模块自己不碰磁盘)
// ============================================================================

/** 抢/接管执行权 (takeover 的前置; 抢不到 = 返回 false, 不是抛错) */
export interface TakeoverRequest {
  goalId: string;
  workId: string | null;
  childAgentId: string | null;
  blockId: string;
  kind: BlockKind;
  now: IsoTimestamp;
  reason: string;
}
/** 停掉并换一个执行者 (返回新派下去的 workId; null = 只停不换) */
export interface ReplaceChildRequest extends TakeoverRequest {}
export interface ReplacementResult { replaced: boolean; newWorkId?: string | null }
/** 下发一次调整指令 (不是立刻换人; 第一档处置) */
export interface AdjustmentRequest extends TakeoverRequest { directive: string }
/** 要求补齐报告 */
export interface RequestReportRequest extends TakeoverRequest { what: string }
/** 允许/执行父改计划 */
export interface ChangePlanRequest extends TakeoverRequest { why: string }
/** 上报 (to='parent' 在 Goal 层同样收敛到人; to='human' 是明确的转人工) */
export interface EscalationRequest extends TakeoverRequest { to: 'parent' | 'human'; detail: string }
/** 记一条事实 (可选端口; 不注入会在结果里如实标注 `recorded: false`) */
export interface RecordRequest {
  goalId: string;
  blockId: string;
  workId: string | null;
  action: BlockResolutionAction;
  outcome: BlockExecutionOutcomeKind;
  now: IsoTimestamp;
  detail: string;
}

export interface BlockExecutionPorts {
  /** 抢/接管执行权 */
  readonly claimLease?: (req: TakeoverRequest) => Promise<boolean> | boolean;
  /** 停掉并替换子执行者 */
  readonly replaceChild?: (req: ReplaceChildRequest) => Promise<ReplacementResult> | ReplacementResult;
  /** 下发调整指令 */
  readonly sendAdjustment?: (req: AdjustmentRequest) => Promise<boolean> | boolean;
  /** 要求补齐报告 */
  readonly requestReport?: (req: RequestReportRequest) => Promise<boolean> | boolean;
  /** 改计划 */
  readonly changePlan?: (req: ChangePlanRequest) => Promise<boolean> | boolean;
  /** 上报 (父 / 人) */
  readonly escalate?: (req: EscalationRequest) => Promise<boolean> | boolean;
  /** 记事实 (可选) */
  readonly record?: (req: RecordRequest) => Promise<void> | void;
}

// ============================================================================
// 输入 / 输出
// ============================================================================

/**
 * 执行者的权限处境 —— **这是"不越权"的输入**, 不是可以猜的东西。
 *
 * `leaseHeld` 的语义严格限定为「**此刻**本执行者持有该 Goal 的互斥执行权」。
 * 拿不到这个事实时传 `false` (宁可拒一个能做的接管, 不许做一个越权的接管)。
 */
export interface BlockExecutionAuthority {
  /** 本执行者当前持有该 Goal 的执行权 */
  leaseHeld: boolean;
  /** 谁在调 (子 Agent 侧一律不许动别人的执行状态) */
  caller: 'supervisor' | 'parent' | 'child' | 'user';
  /** 诊断用 (可空) */
  leaseOwner?: string | null;
}

export type BlockExecutionOutcomeKind = 'executed' | 'refused' | 'deferred' | 'failed';

export interface BlockExecutionAttempt {
  blockId: string;
  workId: string | null;
  childAgentId: string | null;
  kind: BlockKind;
  action: BlockResolutionAction;
  outcome: BlockExecutionOutcomeKind;
  /** 真的被调到的端口名 (空 = 一个都没调 —— 越权被拒时必须是空) */
  called: (keyof BlockExecutionPorts)[];
  /** 端口返回的结果 (人可读; 不编) */
  detail: string;
  /** 这一项有没有被记成事实 */
  recorded: boolean;
}

export interface BlockExecutionOutcome {
  executed: BlockExecutionAttempt[];
  refused: BlockExecutionAttempt[];
  deferred: BlockExecutionAttempt[];
  failed: BlockExecutionAttempt[];
  /** **必须交人**的理由 (空数组 = 没有需要人的项; 与 `executed` 一起构成"不静默"的自证) */
  needsHuman: { blockId: string; workId: string | null; action: BlockResolutionAction; reason: string }[];
  /**
   * 自检位: 有未解决阻塞, 却**一条都没落地** (executed 为空) 且**一条都没交人** (needsHuman 为空)
   * ⇒ 调用方拿到 `true` 时必须报人。正常实现下这**永远**是 false; 它为 true 就说明本模块有 bug
   * (等于"静默"又回来了) —— 测试里当作断言钉死。
   */
  silentRisk: boolean;
  /** 全部尝试 (按输入顺序, 已按 blockId 去重) */
  attempts: BlockExecutionAttempt[];
}

export interface ExecuteBlockHandlingInput {
  goalId: string;
  /** 未解决阻塞 (已解决的会被忽略 —— 记录既是事实也是结论) */
  blocks: BlockRecord[] | null | undefined;
  now: IsoTimestamp;
  authority: BlockExecutionAuthority;
  ports: BlockExecutionPorts;
  /** 只处理这些动作 (默认全部); 测试与灰度用 */
  onlyActions?: readonly BlockResolutionAction[];
}

// ============================================================================
// 纯判定 (导出给接线层/测试复用: "这个动作在我这个处境下能不能做")
// ============================================================================

/** 该动作在给定处境下能不能做 (不能做时给出**人可读**的原因; 能做时 reason=null) */
export function mayExecuteAction(
  action: BlockResolutionAction,
  kind: BlockKind,
  authority: BlockExecutionAuthority,
): { allowed: boolean; reason: string | null } {
  if (NO_AUTO_BYPASS_KINDS.includes(kind) && (action === 'takeover' || action === 'replace_child')) {
    return {
      allowed: false,
      reason: `不自动绕过 Harness: 阻塞类型「${kind}」只允许 改计划/等依赖/转人工, 不得 ${action}`,
    };
  }
  if (authority.caller === 'child' && PARENT_ONLY_ACTIONS.includes(action)) {
    return { allowed: false, reason: `子 Agent 不得执行「${action}」—— 处置权只在父/调度器/人手上` };
  }
  if (action === 'takeover' && authority.leaseHeld !== true) {
    return {
      allowed: false,
      reason: `执行权不在手上 (拿不到互斥执行权${authority.leaseOwner ? `, 现持有者=${authority.leaseOwner}` : ''}) → 拒绝接管, 交人`,
    };
  }
  return { allowed: true, reason: null };
}

/** 调整指令原文 (纯函数; 不含时间戳, 同一阻塞得到同一句话 —— 便于幂等比对) */
export function buildAdjustmentDirective(b: BlockRecord): string {
  return `调整指令 (${b.kind}): ${b.note} —— 这是第一档处置 (先给一次调整, 不是立刻换人); `
    + `请就当前目标给出一次可核验的进展或明确的阻塞回报, 报告须带逐条证据。`;
}

/** 催报原文 (纯函数) */
export function buildReportRequestWhat(b: BlockRecord): string {
  return `请补齐报告 (${b.kind}): ${b.note}${b.dependency ? ` [依赖=${b.dependency}]` : ''} —— `
    + `漂亮但没有逐条证据的回报不接受为完成。`;
}

// ============================================================================
// 执行 (唯一入口)
// ============================================================================

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function errText(e: unknown): string {
  return String((e as Error)?.message || e).slice(0, 200);
}

/**
 * 执行一次阻塞处置。
 *
 * 顺序**固定** (便于复现): 逐条 (按输入顺序, 同 blockId 只做一次) →
 *   `planBlockHandling` 得动作 → `mayExecuteAction` 判权 → 端口存在性 → 真调用。
 *
 * 每一步失败都**显式**落进结果 (`refused` / `failed` + `needsHuman`), 绝不静默 ——
 * 这是本模块存在的全部理由 (P5 缺口 4)。
 */
export async function executeBlockHandling(input: ExecuteBlockHandlingInput): Promise<BlockExecutionOutcome> {
  const out: BlockExecutionOutcome = {
    executed: [], refused: [], deferred: [], failed: [], needsHuman: [], silentRisk: false, attempts: [],
  };

  if (!Array.isArray(input.blocks)) {
    // 调用方 bug 不许静默: 说清"阻塞清单不是数组", 直接交人
    out.needsHuman.push({
      blockId: '(input)', workId: null, action: 'needs_human',
      reason: '阻塞清单不是数组 (调用方 bug) —— 无法巡检, 不许当成"没有阻塞"',
    });
    out.silentRisk = true;
    return out;
  }

  const unresolved = input.blocks.filter((b) => b && b.resolvedAt === null);
  const seenBlocks = new Set<string>();
  const now = input.now;
  const authority = input.authority;

  for (const b of unresolved) {
    if (seenBlocks.has(b.blockId)) continue;
    seenBlocks.add(b.blockId);
    if (input.onlyActions && !input.onlyActions.includes(planBlockHandling(b))) continue;

    const action = planBlockHandling(b);
    const attempt: BlockExecutionAttempt = {
      blockId: b.blockId, workId: b.workId ?? null, childAgentId: b.childAgentId ?? null,
      kind: b.kind, action, outcome: 'refused', called: [], detail: '', recorded: false,
    };
    const base: TakeoverRequest = {
      goalId: input.goalId, workId: b.workId ?? null, childAgentId: b.childAgentId ?? null,
      blockId: b.blockId, kind: b.kind, now, reason: b.note,
    };
    // 1. 权限 (越权一律不调端口)
    const verdict = mayExecuteAction(action, b.kind, authority);
    if (!verdict.allowed) {
      attempt.outcome = 'refused';
      attempt.detail = `拒绝执行 (未调任何执行器): ${verdict.reason}`;
      out.refused.push(attempt);
      out.attempts.push(attempt);
      out.needsHuman.push({ blockId: b.blockId, workId: b.workId ?? null, action, reason: attempt.detail });
      continue;
    }

    // 2. 端口存在性 (缺端口 = 做不了 = 交人, 不许静默跳过)
    const portName = PORT_FOR_ACTION[action];
    const port = portName ? input.ports[portName] : null;
    if (portName && typeof port !== 'function') {
      attempt.outcome = 'refused';
      attempt.detail = `没有注入执行「${action}」的执行器 (端口 ${portName} 缺失) → 处置无法落地, 交人`;
      out.refused.push(attempt);
      out.attempts.push(attempt);
      out.needsHuman.push({ blockId: b.blockId, workId: b.workId ?? null, action, reason: attempt.detail });
      continue;
    }

    // 3. 真调用 (端口抛错 = failed + 原因原文, 不吞)
    try {
      await dispatchAction(action, attempt, b, base, input.ports, authority);
    } catch (e) {
      attempt.outcome = 'failed';
      attempt.detail = `执行器抛错: ${errText(e)}`;
      out.failed.push(attempt);
      out.attempts.push(attempt);
      out.needsHuman.push({ blockId: b.blockId, workId: b.workId ?? null, action, reason: attempt.detail });
      continue;
    }

    if (attempt.outcome === 'executed') out.executed.push(attempt);
    else if (attempt.outcome === 'deferred') out.deferred.push(attempt);
    else out.refused.push(attempt);
    out.attempts.push(attempt);

    // 4. 显式交人: 动作本身就是转人工, 或端口如实回"没做成"
    if (action === 'needs_human') {
      out.needsHuman.push({
        blockId: b.blockId, workId: b.workId ?? null, action,
        reason: `${b.note} → 需要人决定 (加预算 / 改权限 / 换目标都属于人)` ,
      });
    } else if (attempt.outcome === 'refused') {
      out.needsHuman.push({ blockId: b.blockId, workId: b.workId ?? null, action, reason: attempt.detail });
    }

    // 5. 记事实 (可选端口; 不注入会在 attempt.recorded 里如实标 false)
    if (input.ports.record) {
      try {
        await input.ports.record({
          goalId: input.goalId, blockId: b.blockId, workId: b.workId ?? null,
          action, outcome: attempt.outcome, now, detail: attempt.detail,
        });
        attempt.recorded = true;
      } catch (e) {
        attempt.recorded = false;
        attempt.detail = `${attempt.detail} [记事实失败: ${errText(e)}]`;
      }
    }
  }

  // 自检: 有未解决阻塞却什么都没落地、也没交人 ⇒ 静默 (维护者必须知道)。
  // 「继续等」(`deferred`) 算**落地过** —— 它是规则表里合法的无副作用处置, 不该被误报成需要人。
  if (unresolved.length > 0 && out.executed.length === 0 && out.deferred.length === 0 && out.needsHuman.length === 0) {
    out.silentRisk = true;
    out.needsHuman.push({
      blockId: '(self-check)', workId: null, action: 'needs_human',
      reason: `有 ${unresolved.length} 条未解决阻塞, 但一条处置都没落地、也没有交人理由 —— 静默, 交人`,
    });
  }
  return out;
}

/** 按动作把调用派到对应端口, 并把端口返回如实翻成 attempt */
async function dispatchAction(
  action: BlockResolutionAction,
  attempt: BlockExecutionAttempt,
  b: BlockRecord,
  base: TakeoverRequest,
  ports: BlockExecutionPorts,
  authority: BlockExecutionAuthority,
): Promise<void> {
  switch (action) {
    case 'takeover': {
      const lease = await ports.claimLease!(base);
      attempt.called.push('claimLease');
      if (lease === true) {
        attempt.outcome = 'executed';
        attempt.detail = `真抢到执行权 (此前 leaseHeld=${authority.leaseHeld}) → 接管 ${base.workId ?? '-'}`;
      } else {
        attempt.outcome = 'refused';
        attempt.detail = `抢执行权没成功 (claimLease=false) → 不接管, 交人`;
      }
      return;
    }
    case 'replace_child': {
      const res = await ports.replaceChild!(base);
      attempt.called.push('replaceChild');
      if (res && res.replaced) {
        attempt.outcome = 'executed';
        attempt.detail = `真换人: 停掉 ${base.workId ?? '-'}, 新工作=${res.newWorkId ?? '(未重派合同)'}`;
      } else {
        attempt.outcome = 'refused';
        attempt.detail = `换人没做成 (replaceChild.replaced=false) → 交人`;
      }
      return;
    }
    case 'send_adjustment': {
      const ok = await ports.sendAdjustment!({ ...base, directive: buildAdjustmentDirective(b) });
      attempt.called.push('sendAdjustment');
      attempt.outcome = ok === true ? 'executed' : 'refused';
      attempt.detail = ok === true ? `真下发调整指令给 ${base.childAgentId ?? '(子 Agent)'}` : '调整指令下发失败 → 交人';
      return;
    }
    case 'request_report': {
      const ok = await ports.requestReport!({ ...base, what: buildReportRequestWhat(b) });
      attempt.called.push('requestReport');
      attempt.outcome = ok === true ? 'executed' : 'refused';
      attempt.detail = ok === true ? `真要求补齐报告 (${base.workId ?? '-'})` : '催报下发失败 → 交人';
      return;
    }
    case 'change_plan': {
      const ok = await ports.changePlan!({ ...base, why: base.reason });
      attempt.called.push('changePlan');
      attempt.outcome = ok === true ? 'executed' : 'refused';
      attempt.detail = ok === true ? '真改了计划 (父侧)' : '改计划没做成 → 交人';
      return;
    }
    case 'escalate_parent':
    case 'needs_human': {
      const to: 'parent' | 'human' = action === 'needs_human' ? 'human' : 'parent';
      const ok = await ports.escalate!({ ...base, to, detail: base.reason });
      attempt.called.push('escalate');
      attempt.outcome = ok === true ? 'executed' : 'refused';
      attempt.detail = ok === true
        ? `真上报给${to === 'human' ? '人' : '父'} (${base.kind})`
        : `上报给${to === 'human' ? '人' : '父'}没做成 → 仍在 needsHuman 里留痕`;
      return;
    }
    case 'wait_dependency': {
      attempt.outcome = 'deferred';
      attempt.detail = `继续等 (无副作用): ${base.reason}`;
      return;
    }
    default: {
      // 动作集是闭集; 走到这里说明 types.ts 加了新动作而这里没跟上 —— 不静默
      attempt.outcome = 'refused';
      attempt.detail = `未知动作「${String(action)}」: 执行器没跟上动作集, 交人`;
      return;
    }
  }
}

/** 把结果压成一行摘要 (接线层 log / 界面用; 不含内部词) */
export function summarizeBlockExecution(out: BlockExecutionOutcome): string {
  return [
    `已落地 ${out.executed.length}`,
    `被拒 ${out.refused.length}`,
    `等依赖 ${out.deferred.length}`,
    `失败 ${out.failed.length}`,
    `需人 ${out.needsHuman.length}`,
    `去重后阻塞 ${out.attempts.length}`,
  ].join(' · ');
}

/** 动作集是否被本执行器完全覆盖 (types.ts 加了动作而这里没跟上 → false, 门来钉) */
export function coveredActions(): BlockResolutionAction[] {
  return uniq(Object.keys(PORT_FOR_ACTION)) as BlockResolutionAction[];
}
