/**
 * **K2 台账: RunContext 状态外置** —— Pi 实例上的可变运行状态, 要搬进显式 RunContext。
 *
 * 现状 (2026-10-02 真读, 剥注释后计数): `agents/pi-sdk.ts` **4099 行**里 **8 个字段 / 185 处 `this.` 访问**, 且
 * `runReActLoop(onStream?, signal?)` 只收 2 个参数却隐式依赖这 8 个字段 ⇒ 并发 Run 之间靠实例字段互相污染。
 *
 * 门的口径 (`src/test/kernel-runcontext.test.ts`):
 *   · 逐字段计数必须与冻结值**双向相等** (多一处 = 新增泄漏; 少一处 = 改了代码没改账, 要显式 rebase);
 *   · 标了 `migrated` 的字段 `this.` 访问必须为 **0** (假完成判红);
 *   · 8 个字段必须都能在 RunContext 目标清单里找到位置 (不然外置到哪里去)。
 */

export interface RunStateField {
  name: string;
  /** 声明处 (文件:行, 便于人工核对) */
  declaredAt: string;
  /** 冻结的 `this.` 访问次数 (棘轮: 迁移一格就往下调一格, 只许减) */
  accesses: number;
  /** 该字段搬到 RunContext 的哪个位置 */
  into: string;
  /** 是否已完成外置 (true ⇒ 访问必须为 0) */
  migrated: boolean;
  payDownIn: string;
}

export const RUN_CONTEXT_FILES = ['agents/pi-sdk.ts'] as const;
export const RUN_CONTEXT_FROZEN_AT = '2026-10-02';
export const RUN_CONTEXT_ENTRY = 'agents/pi-sdk.ts:1923 runReActLoop(onStream?, signal?) —— 目标签名: runReActLoop(ctx: RunContext)'

export const RUN_CONTEXT_FIELDS: readonly RunStateField[] = [
  { name: 'messageHistory', declaredAt: 'agents/pi-sdk.ts:272', accesses: 53, into: 'history', migrated: false, payDownIn: 'K2' },
  { name: 'currentOnStream', declaredAt: 'agents/pi-sdk.ts:442', accesses: 0, into: 'eventSink', migrated: true, payDownIn: 'K2' },
  { name: 'currentSignal', declaredAt: 'agents/pi-sdk.ts:443', accesses: 0, into: 'abortSignal', migrated: true, payDownIn: 'K2' },
  { name: 'currentChannelId', declaredAt: 'agents/pi-sdk.ts:458', accesses: 21, into: 'channelId', migrated: false, payDownIn: 'K2' },
  { name: 'currentRunId', declaredAt: 'agents/pi-sdk.ts:471', accesses: 36, into: 'runId', migrated: false, payDownIn: 'K2' },
  { name: 'currentIntent', declaredAt: 'agents/pi-sdk.ts:463', accesses: 10, into: 'intent', migrated: false, payDownIn: 'K2' },
  { name: 'currentGoalId', declaredAt: 'agents/pi-sdk.ts:1725', accesses: 19, into: 'goalId', migrated: false, payDownIn: 'K2' },
  { name: 'currentAgentId', declaredAt: 'agents/pi-sdk.ts:460', accesses: 20, into: 'agentId', migrated: false, payDownIn: 'K2' },
];

/** RunContext 必须带的字段 (leo 的 K2 清单) */
export const RUN_CONTEXT_TARGET: readonly string[] = ["requestId", "channelId", "agentId", "goalId", "runId", "intent", "modelSnapshot", "history", "abortSignal", "budget", "eventSink", "harnessContext"];

/** 冻结总量 (棘轮只许减) */
export const RUN_CONTEXT_ACCESS_TOTAL = 159;

/** 已外置字段数 (棘轮: 只许增)。改动这里 = 明确宣告"又搬完一个字段" */
export const RUN_CONTEXT_MIGRATED_FROZEN = 2;

/**
 * 已迁移字段的落地位置 (便于人工复核"搬去哪了"):
 *   · currentOnStream → `src/agents/run-context.ts` 的 `RunContext.eventSink`
 *     (入口 `createRunContext({ eventSink })` 快照; 清空 = 换一个空 Context; 15 处访问归零)
 */
export const RUN_CONTEXT_DONE: readonly string[] = ['currentOnStream', 'currentSignal'];
