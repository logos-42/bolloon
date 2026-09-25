/**
 * wiring/contract.ts — 接缝 ③「这一步该派给谁, 回报算不算完成?」  (**M3 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'contract'`, `stage: 'M3'`。
 * M3 只准改本文件 + `wiring/monitor.ts` + 声明的 `wiringPoints`
 * (`goal-flywheel/work-contract.ts` · `subagent-manager.ts`)。
 *
 * ## 这条接缝钉住的冻结规则
 *
 * **规则 ⑤ 子 Agent 不能直接改 Goal**。
 * 钉法: 派活与收回报**都只经过父侧** (`issueWork` / `acceptReport` / `dispatchWorker`), 且接缝自己做三件事:
 *   ① 拒绝 `caller='child_agent'` 的派活 (子不许派生无限子任务);
 *   ② 回报一律先过 `validateChildReport` + `acceptsAsComplete` —— **漂亮但没有逐条证据的
 *      回报不算完成** (P5 强负例 7); 子 Agent 侧因此没有任何写 Goal 的路径;
 *   ③ **派前必须有工作合同** (M3 新增): `dispatchWorker` 是"签合同 + 交给派遣器"的**唯一**入口 ——
 *      合同签不出来 (缺判据 / 缺目标 / deadline 早于 now / 金额没币种 / 没注入签发面) 就**不派**,
 *      而且派遣端口**一次都不调**。今天 `SubAgentManager` 的旧形状是"签合同失败 → 记个 error 照样派出去",
 *      那正是"派前必须有合同"被绕过的地方 (本文件 + `subagent-manager.ts` 一起堵)。
 *
 * ## 为什么接缝自己带 P2 的核验口径 (`realReportVerdict` / `createContractSeamFromLogic`)
 *
 * 接缝只依赖三样东西: 本目录 `seams.ts` 的接口 · `../types.js` 的冻结类型 · **自己那个阶段**的实现模块。
 * P2 的实现模块就是 `../work-contract.js` (纯函数, 零 I/O)。把它接进来意味着:
 *   · 判定口径**全仓一份** —— 接缝不重新实现"算不算完成", 而是直接调真 P2 的那两个函数;
 *   · 接缝可以**独立于 M0 组合层**使用 (测试与其它宿主只需注入落盘/读盘这两个端口),
 *     而不是"必须有 `goal-flywheel-wiring.ts` 才能用"。
 * 落盘/读盘仍按参数注入 (接缝不做 I/O, 与 `../work-contract.js` 的边界一致)。
 */

import type { AgentWorkContract, AgentWorkReport, IsoTimestamp, WorkBudget } from '../types.js';
import {
  acceptsAsComplete,
  issueWorkContract,
  validateChildReport,
} from '../work-contract.js';
import { refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const CONTRACT_SEAM_ID = 'contract' as const;

export interface ContractIssueInput {
  goalId: string;
  parentRunId: string;
  childAgentId: string;
  capability: string;
  objective: string;
  inputs?: Record<string, unknown>;
  allowedTools?: string[];
  budget: WorkBudget;
  deadline?: IsoTimestamp | null;
  successCriteria: string[];
  now: IsoTimestamp;
  issuedBy?: string;
}

export interface ReportVerdict {
  outcome: 'accepted' | 'incomplete' | 'no_contract';
  accepted: boolean;
  reason: string;
  missingFields: string[];
  missingEvidence: string[];
  violation: string | null;
}

/** 真把合同交给派遣器 (subagent-manager / agent-delegate): "派出去"这件事的唯一出口 */
export interface ChildDispatchPort {
  (input: { contract: AgentWorkContract; caller: WiringCaller; now: IsoTimestamp }): Promise<DispatchReceipt>;
}

/** 派遣端口的回执 —— "派出去了吗 / 受理号是什么", 不许用 boolean 糊 */
export interface DispatchReceipt {
  dispatched: boolean;
  detail: string;
  receipt?: string | null;
}

/**
 * 派活的拒绝码 (接缝自己的闭集)。
 *
 * 刻意**不**复用 `FrozenRule`: 六条冻结规则说的是"责任人是谁", 而这里是"这一步做不成的原因"。
 * 把 `contract_invalid` 硬说成某条冻结规则 = 编一个规则号, 那会让日志与门都开始说谎。
 * 只有真的越界 (`caller_not_allowed`) 才附 `refusal` (它确实违反规则 ⑤)。
 */
export const CONTRACT_REFUSAL_CODES = [
  'caller_not_allowed',
  'no_criteria',
  'contract_invalid',
  'no_dispatch_port',
  'dispatch_failed',
] as const;
export type ContractRefusalCode = (typeof CONTRACT_REFUSAL_CODES)[number];

export type DispatchOutcome =
  | {
    ok: true;
    contract: AgentWorkContract;
    dispatched: true;
    detail: string;
    receipt: string | null;
  }
  | {
    ok: false;
    code: ContractRefusalCode;
    reason: string;
    /** 只有真的违反冻结规则时才非 null (不许编规则号) */
    refusal: SeamRefusal | null;
    detail: string;
    /** 签出来了但没派出去时带上 (便于父决定重派 / 复用), 没签出来就是 null */
    contract: AgentWorkContract | null;
  };

export interface ContractSeamDeps {
  /** 签发 (+ 该宿主负责的落盘 / 写 pendingReports) */
  issue: (input: ContractIssueInput) => Promise<AgentWorkContract>;
  accept: (input: { goalId: string; workId: string; report: AgentWorkReport; now?: IsoTimestamp }) => Promise<ReportVerdict>;
  /** 真派遣面 (可选: 缺了 `dispatchWorker` 会如实拒绝, **不假装派过**) */
  dispatch?: ChildDispatchPort;
}

export interface ContractSeam {
  readonly id: typeof CONTRACT_SEAM_ID;
  readonly stage: 'M3';
  /** 派遣必签合同; 子侧不许自己派活 (子不许派生无限子任务) */
  issueWork(input: ContractIssueInput & { caller: WiringCaller }): Promise<unknown | SeamRefusal>;
  /** 收回报: 核验 + 是否接受为完成 (**不接受就不算完成**) */
  acceptReport(input: { goalId: string; workId: string; report: AgentWorkReport; caller: WiringCaller; now?: IsoTimestamp }): Promise<ReportVerdict | SeamRefusal>;
  /** **唯一派遣入口** (M3): 签合同 → 真派出; 签不出 / 派不出都如实拒绝, 且不吞原因 */
  dispatchWorker(input: ContractIssueInput & { caller: WiringCaller }): Promise<DispatchOutcome>;
}

// ============================================================================
// §0. 与真 P2 模块的唯一耦合点 (判定口径全仓一份)
// ============================================================================

/** 用真 `issueWorkContract` 签发 —— 合同不合法时抛带 `issues` 的 `WorkContractError` (接缝抓它转成结构化拒绝) */
export function realIssueContract(input: ContractIssueInput): AgentWorkContract {
  return issueWorkContract({
    goalId: input.goalId,
    parentRunId: input.parentRunId,
    childAgentId: input.childAgentId,
    capability: input.capability,
    objective: input.objective,
    inputs: input.inputs ?? {},
    allowedTools: input.allowedTools ?? [],
    budget: input.budget,
    deadline: input.deadline ?? null,
    successCriteria: input.successCriteria,
    now: input.now,
    issuedBy: input.issuedBy ?? 'supervisor',
  });
}

/** 用真 `validateChildReport` + `acceptsAsComplete` 核验 —— 接缝不另写一套"算不算完成" */
export function realReportVerdict(contract: AgentWorkContract, report: AgentWorkReport): ReportVerdict {
  const validation = validateChildReport(contract, report);
  const verdict = acceptsAsComplete(contract, report);
  return {
    outcome: verdict.accepted ? 'accepted' : 'incomplete',
    accepted: verdict.accepted,
    reason: verdict.reason,
    missingFields: validation.missingFields,
    missingEvidence: validation.missingEvidence,
    violation: validation.violation,
  };
}

/**
 * 从**真 P2 逻辑** + 两个存储端口拼一条接缝 (M3 的自带适配器)。
 *
 * 为什么需要它: `createContractSeam` 要求宿主自己注入 `issue`/`accept` (M0 组合层注入的是
 * `dispatchChildWork` / `handleChildReport`)。这条工厂让**其它宿主** (测试 / CLI / Web)
 * 也能用同一条接缝, 而判定口径仍是 `../work-contract.js` 那一份 —— 不会出现"第二份判定"。
 *
 * 注意 `persistContract`: 合同**必须先落盘再派出** —— 子拿到合同的依据是盘上那份,
 * 而不是父内存里那句口头约定 (否则子回报时核心验的是"合同存不存在"就永远对不上)。
 */
export function createContractSeamFromLogic(ports: {
  persistContract: (contract: AgentWorkContract) => Promise<void>;
  loadContract: (input: { goalId: string; workId: string }) => Promise<AgentWorkContract | null>;
  dispatch?: ChildDispatchPort;
}): ContractSeam {
  return createContractSeam({
    issue: async (input) => {
      const contract = realIssueContract(input);
      await ports.persistContract(contract);
      return contract;
    },
    accept: async (input) => {
      const contract = await ports.loadContract({ goalId: input.goalId, workId: input.workId });
      if (!contract) {
        return {
          outcome: 'no_contract', accepted: false,
          reason: `没有找到合同 ${input.workId} → 没有合同的回报不核验也不接受`,
          missingFields: [], missingEvidence: [], violation: null,
        };
      }
      return realReportVerdict(contract, input.report);
    },
    dispatch: ports.dispatch,
  });
}

// ============================================================================
// §1. 合同与派遣的边界判定 (纯函数 —— 接线层 / SubAgentManager 直接复用, 不重写一套)
// ============================================================================

/**
 * 换人必须重签合同 (M3)。
 *
 * 合同把 `childAgentId` 钉死了 (`validateChildReport` 要求 `report.childAgentId === contract.childAgentId`),
 * 所以"把同一份合同指给另一个子 Agent"不是改个字段: 新子回报必然对不上合同 → 旧的合规判定直接失效
 * (要么假红, 要么被人放宽判据 —— 两条都是两套事实)。
 * 结论: **换人 = 换合同**。本函数是那条规则的唯一判据。
 */
export function childMatchesContract(
  contract: Pick<AgentWorkContract, 'workId' | 'childAgentId'>,
  childAgentId: string,
): { ok: boolean; reason: string } {
  const next = String(childAgentId ?? '').trim();
  if (!next) return { ok: false, reason: '新执行者没有 id —— 合同无法绑定到具体执行者 (换人必须重签)' };
  if (next === contract.childAgentId) {
    return { ok: true, reason: `执行者未变 (${next}), 合同 ${contract.workId} 仍然有效` };
  }
  return {
    ok: false,
    reason: `合同 ${contract.workId} 绑定的执行者是 ${contract.childAgentId}, 不是 ${next} `
      + '—— 换人必须重签合同 (否则新子 Agent 的回报与合同对不上, 合规判定失效)',
  };
}

// ============================================================================
// §2. 接缝本体
// ============================================================================

function errText(e: unknown): string {
  return String((e as Error)?.message || e).slice(0, 400);
}

/** 抓签发失败的结构化原因 (WorkContractError 带 issues; 其它错误只带 message) */
function issueFailure(input: ContractIssueInput, e: unknown): { code: ContractRefusalCode; reason: string } {
  const issues = (e as { issues?: unknown })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return {
      code: 'contract_invalid',
      reason: `合同不合法, 拒签也拒派 (${input.capability} → ${input.childAgentId}): ${issues.join('; ')}`,
    };
  }
  return { code: 'contract_invalid', reason: `合同签发失败, 拒派: ${errText(e)}` };
}

export function createContractSeam(deps: ContractSeamDeps): ContractSeam {
  return {
    id: CONTRACT_SEAM_ID,
    stage: 'M3',
    async issueWork(input) {
      if (input.caller === 'child_agent') {
        return refuse(
          'child_cannot_mutate_goal',
          `拒绝: 子 Agent (${input.childAgentId}) 想给「${input.capability}」派活 —— `
          + '子 Agent 不许派生无限子任务, 也不许改父 Goal 的派遣面 (CHILD_PROHIBITIONS.spawn_unbounded_subtasks)',
        );
      }
      if (!input.successCriteria?.length) {
        return refuse('child_cannot_mutate_goal', '拒绝: 合同没有成功判据 —— 子 Agent 会自己定义"算完成"');
      }
      return deps.issue(input);
    },
    async acceptReport(input) {
      if (!input.workId) {
        return refuse('child_cannot_mutate_goal', '拒绝: 没有 workId 的回报无法对合同核验 → 不接受为完成');
      }
      const verdict = await deps.accept({ goalId: input.goalId, workId: input.workId, report: input.report, now: input.now });
      // 无证据的漂亮回报: 显式拒绝, 并说清缺什么 (不许静默降级成"完成")
      if (verdict.outcome === 'incomplete' && !verdict.reason) {
        return { ...verdict, reason: '报告不完整 → 不接受为完成 (缺字段/缺证据)' };
      }
      return verdict;
    },

    /**
     * 派前必须有工作合同 (M3 唯一派遣入口)。
     *
     * 顺序固定 (便于复现与断言):
     *   ① 权限: 子 Agent 不许派活 → 拒 (附冻结规则 ⑤, 端口零调用);
     *   ② 判据: 没有成功判据 → 拒 (没有"完成"的定义, 派出去只能扯皮);
     *   ③ 派遣面: 没注入 `dispatch` → 拒 (**不假装派过**);
     *   ④ 签合同: 真签 (`deps.issue`)。签不出 → 拒, 派遣端口**零调用** (这是"派前必须有合同"的硬点);
     *   ⑤ 真派: 调 `dispatch`。端口抛错 / 回 `dispatched:false` → 如实拒绝 + 把人叫上 (不静默降级成"派出去了")。
     *
     * 合同**先落盘再派出**由 `deps.issue` 的宿主保证 (M0: `dispatchChildWork` 先写 goal-works/ 再写 pendingReports)。
     */
    async dispatchWorker(input) {
      if (input.caller === 'child_agent') {
        return {
          ok: false,
          code: 'caller_not_allowed',
          reason: `拒绝派遣: 调用者是子 Agent (${input.childAgentId} → 「${input.capability}」) —— `
            + '子 Agent 不许派生无限子任务 (CHILD_PROHIBITIONS.spawn_unbounded_subtasks)',
          refusal: refuse('child_cannot_mutate_goal', '子 Agent 不许派生无限子任务 / 不许改父 Goal 的派遣面'),
          detail: 'no_dispatch: 未签发合同, 派遣端口零调用',
          contract: null,
        };
      }
      if (!input.successCriteria?.length) {
        return {
          ok: false,
          code: 'no_criteria',
          reason: `拒绝派遣「${input.capability}」: 合同没有成功判据 —— 没有"完成"的定义就不许派 `
            + '(子 Agent 会自己定义"算完成")',
          refusal: null,
          detail: 'no_dispatch: 未签发合同, 派遣端口零调用',
          contract: null,
        };
      }
      const dispatch = deps.dispatch;
      if (typeof dispatch !== 'function') {
        return {
          ok: false,
          code: 'no_dispatch_port',
          reason: `拒绝派遣「${input.capability}」: 宿主没有注入派遣面 (端口缺失) —— 拿不到"真派出去了"的事实, `
            + '不许把签发当成已派遣',
          refusal: null,
          detail: 'no_dispatch: 未签发合同, 派遣端口零调用',
          contract: null,
        };
      }

      let contract: AgentWorkContract;
      try {
        contract = await deps.issue(input);
      } catch (e) {
        const fail = issueFailure(input, e);
        return {
          ok: false,
          code: fail.code,
          reason: fail.reason,
          refusal: null,
          detail: 'no_dispatch: 合同没签成, 派遣端口零调用',
          contract: null,
        };
      }

      try {
        const receipt = await dispatch({ contract, caller: input.caller, now: input.now });
        if (receipt?.dispatched !== true) {
          return {
            ok: false,
            code: 'dispatch_failed',
            reason: `合同 ${contract.workId} 已签发, 但派遣端口回"没派出去": ${receipt?.detail ?? '(端口没给原因)'}`,
            refusal: null,
            detail: `dispatched=false (workId=${contract.workId})`,
            contract,
          };
        }
        return {
          ok: true,
          contract,
          dispatched: true,
          detail: receipt.detail,
          receipt: receipt.receipt ?? null,
        };
      } catch (e) {
        return {
          ok: false,
          code: 'dispatch_failed',
          reason: `合同 ${contract.workId} 已签发, 但派遣端口抛错: ${errText(e)}`,
          refusal: null,
          detail: `dispatch 抛错: ${errText(e)}`,
          contract,
        };
      }
    },
  };
}
