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

export type RunStateScope =
  | 'run'          // 每轮 Run 状态 ⇒ 归 RunContext (K2 的外置面)
  | 'run-boundary' // 语义属 Run, 但值在入口**之前**就设好 (resume 等) ⇒ 必须由入口显式播种进 Context, 不能直搬
  | 'session';     // 跨 Run 存活的会话级绑定 ⇒ 该归会话/通道级持有者 (K5 actor), 不进 RunContext

export interface RunStateField {
  name: string;
  /**
   * **作用域** —— 这一栏是 K2 第 4 格逼出来的:
   *   `run`     = 每轮 Run 的状态, 归 RunContext (逐格外置);
   *   `session` = **跨 Run 存活**的会话级绑定, **不进 RunContext**。
   * 判错的代价: 会话级字段被搬进"每次入口新建"的 Context ⇒ run 内的写落进 per-run ctx ⇒
   * 会话字段不被更新 ⇒ 下一个 run 走"未绑定 ⇒ 重新 findActiveGoal"分支 ⇒ **行为改变**。
   */
  scope: RunStateScope;
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
  { name: 'messageHistory', declaredAt: 'agents/pi-sdk.ts:272', scope: 'session', accesses: 56, into: 'history', migrated: false, payDownIn: 'K2' },
  { name: 'currentOnStream', declaredAt: 'agents/pi-sdk.ts:442', scope: 'run', accesses: 0, into: 'eventSink', migrated: true, payDownIn: 'K2' },
  { name: 'currentSignal', declaredAt: 'agents/pi-sdk.ts:443', scope: 'run', accesses: 0, into: 'abortSignal', migrated: true, payDownIn: 'K2' },
  { name: 'currentChannelId', declaredAt: 'agents/pi-sdk.ts:458', scope: 'session', accesses: 24, into: 'channelId', migrated: false, payDownIn: 'K2' },
  { name: 'currentRunId', declaredAt: 'agents/pi-sdk.ts:471', scope: 'run-boundary', accesses: 38, into: 'runId', migrated: false, payDownIn: 'K2' },
  { name: 'currentIntent', declaredAt: 'agents/pi-sdk.ts:463', scope: 'run', accesses: 0, into: 'intent', migrated: true, payDownIn: 'K2' },
  { name: 'currentGoalId', declaredAt: 'agents/pi-sdk.ts:1725', scope: 'session', accesses: 22, into: 'goalId', migrated: false, payDownIn: 'K2' },
  { name: 'currentAgentId', declaredAt: 'agents/pi-sdk.ts:460', scope: 'session', accesses: 21, into: 'agentId', migrated: false, payDownIn: 'K2' },
];

/** RunContext 必须带的字段 (leo 的 K2 清单) */
export const RUN_CONTEXT_TARGET: readonly string[] = ["requestId", "channelId", "agentId", "goalId", "runId", "intent", "modelSnapshot", "history", "abortSignal", "budget", "eventSink", "harnessContext"];

/** 冻结总量 (棘轮只许减) */
export const RUN_CONTEXT_ACCESS_TOTAL = 161;

/** 已外置字段数 (棘轮: 只许增)。改动这里 = 明确宣告"又搬完一个字段" */
export const RUN_CONTEXT_MIGRATED_FROZEN = 3;

/**
 * 已迁移字段的落地位置 (便于人工复核"搬去哪了"):
 *   · currentOnStream → `src/agents/run-context.ts` 的 `RunContext.eventSink`
 *     (入口 `createRunContext({ eventSink })` 快照; 清空 = 换一个空 Context; 15 处访问归零)
 */
export const RUN_CONTEXT_DONE: readonly string[] = ['currentOnStream', 'currentSignal', 'currentIntent'];

/** K2 的 per-run 外置面 = scope:'run' 的字段数 (session 级的不算) */
export const RUN_CONTEXT_RUN_SCOPED = 3;

/**
 * **K2 第 4 格改判记录: `currentGoalId` 是 session 级, 不搬进 RunContext。**
 *
 * 证据 (2026-10-02 真读 `pi-sdk.ts`):
 *   · 写入口① `setGoalId(goalId)` (行 1747) —— **公开 API**, CLI/Web/runner 在 run **之前**注入
 *     ("有 goalId 就在该 Goal 下执行" ⇒ 这是会话绑定, 不是本轮状态);
 *   · 写入口② run 内部 (行 2024 / 1091): 未绑定时 `findActiveGoal` 或 `createGoal` 再 `startRun({ goalId })`
 *     —— **run 会写它, 且必须活到下一个 run**;
 *   · 读出口: harness 上下文 (行 1914) · 轨迹/报告 (行 2866/2995/3006/3023) · `bindExternalWait` (1804-1806);
 *   · 行 1081/1091 · 2003/2024 有 "暂存-重绑-还原" 模式 (跨块共享)。
 *
 * 为什么不能"入口 copy 一份进 Context": run 内的写会落进 per-run ctx ⇒ 会话字段不被更新 ⇒
 * 下一个 run 走"未绑定 ⇒ 重新 findActiveGoal"分支 ⇒ **行为改变** (旧行为是复用同一绑定)。
 *
 * 结论: 它该收进的是**会话/通道级持有者** (K5 Channel Actor 的 actor 状态), 不是 RunContext。K2 不碰它。
 */
export const RUN_CONTEXT_SESSION_SCOPED_NOTE = 'currentGoalId: 会话级绑定 (setGoalId 外部注入 + run 内可能重绑), 归 K5 actor 状态, 不进 RunContext';

/**
 * **K2 第 5~8 格改判记录 (2026-10-02, 一次把剩下 4 个字段全定性)**
 *
 * 逐字段证据 (真读 `pi-sdk.ts` 的**写入点**, 不是看名字):
 *
 * | 字段 | 写入点 | 判定 |
 * | --- | --- | --- |
 * | `currentAgentId` (20) | **只有 1 个**: 构造函数 547 行 `= config.agentId` (createAgentSession 注入) | **session 级** —— 会话创建时定 |
 * | `currentChannelId` (21) | 4 个, 全是 `= channelId ?? this.currentChannelId` (显式**保留**上一轮的值) / 3895 直设 | **session 级** —— 设计上就跨 Run 存活 |
 * | `messageHistory` (53) | 3 个, 全是整体替换 (hydrate 680 / compact 3243 / 真破坏性更新 3445) | **session 级** —— 它就是"会话记忆"本身, 跨 Run 累积 |
 * | `currentRunId` (36) | 1989 行在 resume 里 `= this.resumeRunId` **然后才调 prompt**; 2036 在 run 内; 3034/3038 清空 | **run-boundary** —— 属 Run, 但值在入口之前就设好 ⇒ 必须由入口**显式播种** |
 *
 * ⇒ **K2 的 per-run 外置面只有 3 个字段** (`eventSink` / `abortSignal` / `intent`), **且已 100% 完成**
 *    (`RUN_CONTEXT_RUN_SCOPED = 3` == `RUN_CONTEXT_DONE.length`)。
 *
 * ⇒ 剩下 5 个不属于"每轮状态": 4 个 session 级该收进**会话/通道级持有者** (K5 Channel Actor 的 actor 状态);
 *    1 个 run-boundary 需要一个**入口播种**动作 (在 `createRunContext(...)` 里显式带上 runId) ——
 *    播种会新增对旧实例字段的读, 所以它必须作为**独立一格**记账并说明理由, 不能混在"纯减"里。
 *
 * ⇒ **连带结论 (对 K2 验收标准的影响)**: leo 写的「两个并发 Run 的 history 不互相污染」**不是 K2 能靠搬字段达成的**
 *    —— `messageHistory` 是会话记忆, 共享是它的本质; 要"不互相污染"必须让**每个 channel 有自己的会话/history**
 *    (K5 Channel Actor), 或让每个 Run 在不可变基准上各写各自的分支。**这条验收标准的落点应改判到 K5。**
 */
export const RUN_CONTEXT_REMAINING_NOTE = 'remaining 4: agentId/channelId/messageHistory = session 级 (K5 actor); runId = 入口播种 (独立一格)';

/**
 * **K2 收尾 (leo 2026-10-02 口径) —— 播种读取单独记账**
 *
 * `currentRunId` 属 **run-boundary**: 它对 Run 是真状态, 但值在**入口之前**就设好 (resume 路径
 * `this.currentRunId = this.resumeRunId` 然后才调 prompt) ⇒ 循环内部不该再去读实例字段。
 *
 * 允许**一次**显式播种 (只在 `PiAgentSession.seedRunContext()` 里):
 *     createRunContext({ runId: this.currentRunId, ...extra })
 *
 * 记账规则 (三条, 由门强制):
 *   · `CURRENT_RUN_ID_SEED_READS = 1` —— 播种读取**恰好一处**, 且必须在 `seedRunContext` 体内;
 *   · `CURRENT_RUN_ID_SEED_SITES = 2` —— 调用播种的入口恰好两个 (`prompt` / `promptStream`), 且都在循环之外;
 *   · `currentRunId.accesses = 38 = 37(历史匹配) + 1(播种)` —— **不计进"必须下降"的纯迁移统计**, 也**不算 K2 未完成**。
 *
 * 性质: 只在进入一次 Run 时发生; 只把已有恢复身份播种给 RunContext; 不是循环内部重新读旧实例状态;
 *       不得成为新的写入口。**K5 完成后**改为 `createRunContext({ runId: request.resumeRunId })`, 届时删除该字段本体。
 */
export const CURRENT_RUN_ID_SEED_READS = 1;
export const CURRENT_RUN_ID_SEED_SITES = 2;
export const CURRENT_RUN_ID_SEED_NOTE = 'run-boundary 播种 (口径=判据同款/匹配次数): 37 历史 + 1 播种 = 38; 播种只在 seedRunContext 内, 循环内不得新增读取点';

/**
 * **K2 验收标准 (leo 2026-10-02 修订 —— 把 history 并发隔离移出)**
 *   ① 三个 run 级字段 (eventSink / abortSignal / intent) 全部迁移;
 *   ② `RunContext` 接线完整 (入口建 Context · 循环从 Context 取值);
 *   ③ 循环使用**显式** Context, 不再隐式读已迁移的 run 级实例字段;
 *   ④ 已迁移字段零 `this.` 残留;
 *   ⑤ 新 Run **不继承**上一 Run 的 event / signal / intent (未给字段显式置空);
 *   ⑥ `currentRunId` 的播种读取**只有一个冻结入口** (`seedRunContext`);
 *   ⑦ **不要求** K2 解决 session history 并发隔离 (那条移给 K5)。
 */
export const K2_ACCEPTANCE: readonly string[] = [
  '① run 级 3 字段全迁移',
  '② RunContext 接线完整 (入口建 · 循环从 Context 取)',
  '③ 循环只吃显式 Context',
  '④ 已迁移字段零 this. 残留',
  '⑤ 新 Run 不继承上一 Run 的 event/signal/intent',
  '⑥ currentRunId 播种只有一个冻结入口',
  '⑦ 不含 history 并发隔离 (→ K5)',
];

/**
 * **K5 验收标准 (leo 2026-10-02 增加 —— 承接从 K2 移出的部分)**
 *   ① 同 Channel 消息串行 (输入只能排队, 不能并发改 history);
 *   ② 不同 Channel history 不交叉 (完全隔离);
 *   ③ 同一 Channel 的多个 Run 不互相污染 (靠 Actor 串行调度 + Run 边界隔离);
 *   ④ 页面 / CLI / P2P / Supervisor 都进入同一 Actor mailbox;
 *   ⑤ Actor 崩溃后可由 Supervisor 恢复;
 *   ⑥ `messageHistory` 不再由 Pi 直接拥有。
 */
export const K5_ACCEPTANCE: readonly string[] = [
  '① 同 Channel 串行 (排队, 不并发改 history)',
  '② 不同 Channel history 完全隔离',
  '③ 同 Channel 多 Run 不互相污染',
  '④ 页面/CLI/P2P/Supervisor 进同一 mailbox',
  '⑤ Actor 崩溃可由 Supervisor 恢复',
  '⑥ messageHistory 不再由 Pi 拥有',
];

/** 两个百分比**不能合并** (leo 口径: 合并会产生误导) */
export const K2_PROGRESS = {
  runContextExternalized: '100%',
  sessionActorization: '未开始',
} as const;

/**
 * **口径统一说明 (2026-10-02, 必读, 否则会误读数字)**
 *
 * 判据原先按**行数**计 (`if (rx.test(line)) actual += 1`), 而 K2 收尾新加的播种判据按**匹配次数**计
 * ⇒ 同一条台账在 1916 行那种"一行含两处"的地方给出 37 / 38 两个答案。**已统一为匹配次数**。
 *
 * 因此逐字段冻结值被整体重算过, session 级那几个"变大"**不是新增泄漏, 是口径变化**:
 *
 * | 字段 | 行数口径(旧) | 匹配口径(现) |
 * | --- | --- | --- |
 * | messageHistory | 53 | **56** |
 * | currentChannelId | 21 | **24** |
 * | currentGoalId | 19 | **22** |
 * | currentAgentId | 20 | **21** |
 * | currentRunId | 36(+1播种) | **38** |
 *
 * **同口径的迁移前/后对比** (用匹配口径回算提交 `04f64fb` = K2 第一次迁移之前):
 *   迁移前 **193** → 现在 **161** (净 **-32**)。拆解: 三个 run 级字段 **-33** (15 + 8 + 10)
 *   + run-boundary 播种 **+1** (记账例外: 不计入"必须下降"的纯迁移统计, 也不算 K2 未完成)。
 *   三个 run 级字段: currentOnStream 15→0 · currentSignal 8→0 · currentIntent 10→0。
 *   其余 5 个 session/run-boundary 字段在**同口径**下逐字未变 (变大纯属换口径)。
 */
export const RUN_CONTEXT_COUNT_METHOD = 'match-count (不是行数; 一行含两处记 2)';
