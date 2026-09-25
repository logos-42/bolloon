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
 * 钉法: 派活与收回报**都只经过父侧** (`issueWork` / `acceptReport`), 且接缝自己
 * 做两件事: ① 拒绝 `caller='child_agent'` 的派活 (子不许派生无限子任务);
 * ② 回报一律先过 `validateChildReport` + `acceptsAsComplete` —— **漂亮但没有逐条证据的
 * 回报不算完成** (P5 强负例 7)。子 Agent 侧因此没有任何写 Goal 的路径。
 */

import type { AgentWorkReport, IsoTimestamp, WorkBudget } from '../types.js';
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

export interface ContractSeamDeps {
  issue: (input: ContractIssueInput) => Promise<unknown>;
  accept: (input: { goalId: string; workId: string; report: AgentWorkReport; now?: IsoTimestamp }) => Promise<ReportVerdict>;
}

export interface ContractSeam {
  readonly id: typeof CONTRACT_SEAM_ID;
  readonly stage: 'M3';
  /** 派遣必签合同; 子侧不许自己派活 (子不许派生无限子任务) */
  issueWork(input: ContractIssueInput & { caller: WiringCaller }): Promise<unknown | SeamRefusal>;
  /** 收回报: 核验 + 是否接受为完成 (**不接受就不算完成**) */
  acceptReport(input: { goalId: string; workId: string; report: AgentWorkReport; caller: WiringCaller; now?: IsoTimestamp }): Promise<ReportVerdict | SeamRefusal>;
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
  };
}
