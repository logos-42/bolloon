/**
 * **K5 台账: Channel Actor** (leo 2026-10-02 定口径)
 *
 * 从 K2 移交过来的背景: `messageHistory` / `currentChannelId` / `currentAgentId` / `currentGoalId`
 * 四个字段**不是 Run 状态, 是会话状态** —— 它们不属于 RunContext, 该由 Channel Actor 统一承载。
 * K2 已把它们标 `scope: 'session'` 并逐字保留在 Pi 实例上 (零搬迁), 这里记的是**最终归属与迁移步骤**。
 *
 * 判据: `src/test/kernel-channel-actor.test.ts` —— 台账必须与**盘上事实同步**:
 *   标了"容器未建"就必须真的不存在 `src/kernel/channel-actor.ts`; 进度只许增; 未建/未迁的不许标成已完成。
 */

export type K5Stage = 'not-started' | 'container-built' | 'registry-built' | 'fields-migrated' | 'entries-wired' | 'done';

/**
 * 进度历史 (台账只许前进, 每次前进都要留下日期与"这一步交付了什么"):
 *   · 2026-10-02 not-started → **container-built**: `src/kernel/channel-actor.ts` 落地
 *     (ActorState 9 项 · SerialMailbox 串行队列 · ChannelActor.submit/abort/beginCancellation);
 *     串行语义由 `kernel-channel-actor.test.ts` **真跑**验证; **尚未接任何入口** ⇒ 行为零改变。
 *   · 2026-10-02 container-built → **registry-built**: 注册表 `getOrCreateActor(peekActor/actorCount/resetActors)`
 *     落地, 并由 **session factory** 在会话创建时按 channel 绑定 (`attachActor`) ⇒ 一个 channel 一个 actor 成立;
 *     `fieldsMigrated` 仍 0/4 · `entriesWired` 仍 0/4 (只做归属, 没有把执行投递进 mailbox, 状态仍在 Pi 实例上)。
 *   · 2026-10-02 **第 4 步第一版被全量回归否掉, 已回退** (证据留在 §28):
 *     曾把 history 本体搬进 `actor.state.messageHistory` (Pi 侧改成访问器 + `attachActor` 收养)。
 *     全量 **4742 测试 ⇒ 6 红**, 两类根因:
 *       ① **会话隔离被打破** (5 红): actor 的注册键是 `peerId` 的 `:` 前段 (或 `default`), 而
 *          **会话身份 (SessionStore key) 在 hydrate 时才出现** ⇒ 两个独立 session 共用同一个 actor,
 *          新 session 一构造就看到别人的 history (测试实测 `expected 2 to be 0`)。
 *       ② **K2 门拦下** (1 红): 「session 级字段必须**仍是实例字段**」—— 第 4 步落地前不许留半搬状态。
 *     ⇒ **结论 (写进 K5 约束)**: history 归属**不能按 channel 前缀**, 必须按**会话身份**。
 *   · 2026-10-02 **第二版 (按约束重做, 成功)**: 注册键改成**会话身份** (`loadSessionKey` 优先, 否则整条 `peerId`),
 *     **不做前缀归并, 也没有 default 兜底桶** (没有身份 ⇒ 不归属: 宁可不共享, 不许串台);
 *     `messageHistory` 本体搬进 `actor.state.messageHistory` (Pi 侧访问器 + `attachActor` 收养当地历史)。
 *     同时把 K2 门那条「session 级字段必须仍是实例字段」改成**读 K5 台账**的交接契约 (声明了才放行)。
 *     `fieldsMigrated` 0 → **1/4** (messageHistory); `entriesWired` 仍 0/4。
 *   · 2026-10-02 同一格继续: **history 的 hydrate / persist 实现体搬进 Actor**
 *     (`hydrateHistory` = load→filter→截断→替换, `historySnapshot` = persist 的取数拍, `appendMessage` 备用),
 *     业务侧只交**纯回调** (内核不 import 业务模块) —— 三个操作**走邮箱** ⇒ 同 Channel 内与 append 串行,
 *     不再有"读-改-写三拍被并发踩掉"和"边写边读抓到半截状态"。
 *     `historyOpsMigrated 2/4` (hydrate · persist)。
 *   · 2026-10-02 同格继续: **append 收敛** —— `pi-sdk.ts` 里 history 的写入面 (实测 push 31 · pop 1 · 整体赋值 3)
 *     全部收敛到唯一漏斗 `pushHistory` / `popHistory` / `replaceHistory` ⇒ 每个直写模式只剩漏斗自身 1 处,
 *     判据 `scanHistoryWriteSites` 断言这一点。**漏斗有意做成同步**: 调用点写完立刻要读 (length/索引/slice),
 *     改成 await 会改变同拍可见性 —— 它交付的是**归属与可数性**, 并发安全由入口投递负责 (K5 第 5 步)。
 *     `historyOpsMigrated 3/4` (hydrate · append · persist)。
 *   · 2026-10-02 同格收官: **compact 落地拍** —— 压缩是 async, 从取快照到落地之间有 await 窗口,
 *     期间 append 的消息原先会被整块替换**丢掉** (lost update) ⇒ 新增 `actor.rebaseHistory(compacted, snapshotLen)`
 *     (走邮箱 + 把快照之后的尾部原样接回); 同步压缩路径经核实是"同一拍相邻两行"(无窗口), 只留注释警戒。
 *     `historyOpsMigrated **4/4**` (hydrate · append · compact · persist)。
 *   · 2026-10-02 **步骤③ (三个会话绑定迁入 Actor)**: `currentChannelId` / `currentAgentId` / `currentGoalId`
 *     的本体住进 `actor.state.channelId` / `.agentId` / `.goalBinding` (Pi 侧改成访问器 + `attachActor` 收养
 *     构造期已设的值)。**这三个字段的访问数不变** (24 / 21 / 22) —— 迁的是**所有权**而非删访问,
 *     所以本次**不动** K2 台账的冻结值 (判据的"少一处才红"在这里不适用, 因为一处也没少)。
 *     `fieldsMigrated **4/4**`。
 *   · 2026-10-02 **步骤④ 起手 (入口投递)**: `deliverThroughActor(holder, run)` 落进内核 —— 有 actor 就投进
 *     它的 mailbox (同一会话身份的输入**排队**), 无 actor 直接跑 (行为不变)。**web 用户路径已接 3 处**
 *     (用户消息 / 第二条路径 / 重新生成), `web/server.ts` 里共 8 处入口执行点 ⇒ `entrySites { total: 8, wired: 3 }`,
 *     两个数字都由判据 `scanEntryDelivery` **从盘上重算**, 自报无效。
 *     四个**粗粒度**入口 (web / CLI / P2P / Supervisor) 的 `entriesWired` 仍 **0/4** —— 一条入口要全部执行点接完才算。
 *   · 2026-10-02 **步骤④ 完成**: web (server.ts 11/11 + routes-tasks 1/1) · CLI (index.ts) · P2P 入站 · Supervisor/子Agent
 *     (runner-resolver.ts 1/1) ⇒ `entriesWired **4/4**`。
 *     **关键发现 (口径漏了一整类入口)**: P2P 入站调的是 `a.summarizeDocument(...)` / `a.improveDocument(...)` ——
 *     不叫 `prompt`, 只数 prompt/promptStream 会让这条入口**永远数不到** (实测 index.ts 漏 4 处)。
 *     ⇒ 口径的方法名单 `AGENT_ENTRY_METHODS` 也做成台账数据 (冻结), 并配判别力用例。
 */

/** K5 第 4 步: 四个 history 操作 (唯一来源; 台账 `historyOpsNames` 必须 ⊆ 这里, 且数量与进度位一致) */
export const HISTORY_OPS: readonly string[] = ['hydrate', 'append', 'compact', 'persist'];

export interface ActorStateItem { name: string; why: string; owner: string }

/** Actor 状态容器必须承载的 9 项 (leo 定的清单) */
export const ACTOR_STATE_ITEMS: readonly ActorStateItem[] = [
  { name: 'channelId', why: "会话绑定的通道 —— 迁移前是 Pi 实例字段 (match 计数 24)", owner: 'actor' },
  { name: 'agentId', why: "会话身份 —— 迁移前 21 处", owner: 'actor' },
  { name: 'goalBinding', why: "会话的 Goal 默认绑定 —— **保留为 Actor 级默认**, 但每次执行开始必须把最终绑定写进 RunContext/Run 记录", owner: 'actor' },
  { name: 'messageHistory', why: "**Channel 的连续记忆** (不是 Run 历史): 同 Channel 串行访问, 跨 Channel 必须隔离", owner: 'actor' },
  { name: 'mailbox', why: "入站消息队列 —— 同 Channel 内只能排队, 不能并发改 history", owner: 'actor' },
  { name: 'activeRun', why: "当前活跃 Run (取代 Pi 上的 currentRunId 播种)", owner: 'actor' },
  { name: 'cancellation', why: "取消位 (取代 Pi 上的 currentSignal)", owner: 'actor' },
  { name: 'outboundStream', why: "出站流 (取代 Pi 上的 currentOnStream)", owner: 'actor' },
  { name: 'serialLock', why: "**同 Channel 串行执行锁** (1 个 channel 同时只有 1 个 Run 在改状态)", owner: 'actor' },
];

/** K5 验收标准 (leo 2026-10-02; 其中「并发 Run 的 history 不互相污染」是从 K2 移过来的) */
export const K5_ACCEPTANCE: readonly string[] = [
  '① 同 Channel 消息串行 (输入只能排队, 不能并发改 history)',
  '② 不同 Channel history 完全隔离 (不交叉)',
  '③ 同一 Channel 的多个 Run 不互相污染 (Actor 串行调度 + Run 边界隔离)',
  '④ 页面 / CLI / P2P / Supervisor 都进入同一 Actor mailbox',
  '⑤ Actor 崩溃后可由 Supervisor 恢复',
  '⑥ messageHistory 不再由 Pi 直接拥有',
];

/** 8 步迁移步骤 (leo 定的顺序) —— 每步都要带真跑 */
export const K5_STEPS: readonly string[] = [
  '① 创建 Actor 状态容器 (9 项)',
  '② messageHistory 的 hydrate / compact / append / persist 迁入 Actor',
  '③ currentChannelId / currentAgentId / currentGoalId 迁入 Actor',
  '④ 所有入口改为投递消息 (submit → mailbox)',
  '⑤ 每个 Channel 内加串行执行锁',
  '⑥ currentRunId 改成 Actor 的 activeRun / ExecutionFrame',
  '⑦ Pi 只接收一次性的 ExecutionRequest',
  '⑧ 删除 Pi 中对应字段',
];

/** 删除旧字段的 7 条前置条件 (全满足才许删 —— 对应 §7.3 删除条件的 K5 细化) */
/**
 * K5 的 7 条删除前置。每条**必须点名"谁证明它"** (`backedBy`) —— 说"已验证"却没点名, 或点了一个盘上不存在的文件/判据,
 * 都由 `scanPreconditionBacking` 判红 (不谎称可验证性: 判据只核"背书存在", 不代替真跑)。
 */
export const K5_DELETION_PRECONDITIONS: readonly { text: string; backedBy: readonly string[] }[] = [
  {
    text: 'PiAgentSession 不再拥有 session 状态',
    backedBy: ['src/test/kernel-channel-actor.test.ts', 'K5_FIELD_DELETION'],
  },
  {
    text: '所有入口都经过 Channel Actor',
    backedBy: ['src/test/kernel-channel-actor.test.ts'],   // scanEntryDelivery: wiredTotal === total
  },
  {
    text: '同 Channel 串行、跨 Channel 并发**真跑通过**',
    backedBy: ['src/test/kernel-channel-actor.test.ts'],   // 串行语义 + ALS 防重入自锁
  },
  {
    text: '重启后 history / Goal / Run 仍能正确恢复',
    backedBy: ['src/test/session-resume-e2e.test.ts', 'src/test/persistence-e2e-flow.test.ts'],
  },
  {
    text: 'currentRunId 不再由 Pi 负责播种',
    backedBy: ['scanRunIdSeed'],                           // CURRENT_RUN_ID_SEED_READS/_SEED_SITES
  },
  {
    text: 'Pi 的字段访问只剩推理所需的临时变量',
    backedBy: ['K5_ACCESSOR_SURFACE'],
  },
  {
    text: '旧字段零引用门禁通过',
    backedBy: ['K5_FIELD_DELETION'],                       // scanStagingFieldDeletion 双向
  },
];

/**
 * **K5 步骤⑧ 的棘轮**: "本体已进 actor"之后, pi-sdk 里对这批**访问器**的引用数只许减、不许再增。
 *   删访问器本身要改 ~129 处 + 10 个文件 (跨 web/CLI/agents), 属大范围改名 ⇒ 立棘轮而不是硬改。
 *   计数变化 ⇒ 台账必须在**同一次提交**里跟上 (台账与盘上事实必须同步)。
 */
export const K5_ACCESSOR_SURFACE = {
  accessorFields: ['messageHistory', 'currentChannelId', 'currentAgentId', 'currentGoalId', 'currentRunId'],
  frozenInPiSdk: { messageHistory: 0, currentChannelId: 0, currentAgentId: 0, currentGoalId: 0, currentRunId: 0 },   // 批次5: 5 个访问器全部归零
  where: 'src/agents/pi-sdk.ts',
  why: '字段本体已删 (K5_FIELD_DELETION); 这些访问器只剩"读门面"作用 ⇒ 只许减',
} as const;

/** 从 K2 移交的 4 个 session 字段 (现仍是 Pi 实例字段, match 口径冻结值) */
export const K5_INHERITED_FIELDS: readonly { name: string; into: string; accesses: number }[] = [
  { name: 'messageHistory', into: 'actor.messageHistory', accesses: 0 },   // 步骤⑧ 批次 1: pi-sdk 侧 0 引用
  // K5 步骤⑦ 起 +1: `applyExecutionRequest` 把请求里的绑定写进这三个字段 (各一处写)
  { name: 'currentChannelId', into: 'actor.channelId', accesses: 0 },   // 步骤⑧ 批次4: pi-sdk 侧 0 引用
  { name: 'currentAgentId', into: 'actor.agentId', accesses: 0 },   // 步骤⑧ 批次2: pi-sdk 侧 0 引用
  { name: 'currentGoalId', into: 'actor.goalBinding', accesses: 0 },   // 步骤⑧ 批次3: pi-sdk 侧 0 引用
];

/**
 * 从 K2 移交的四个 session 字段的**当前**访问数 (match 口径, 与 K2 台账逐字相等 —— 跨台账判据强制)。
 * ⚠️ `messageHistory` 由 56 降到 **22**: K5 第 4 步把 35 处写入 (push 31 · pop 1 · 整体赋值 3)
 *    收敛进唯一漏斗 (`pushHistory`/`popHistory`/`replaceHistory`) 后这些点不再直接访问实例字段;
 *    随后 compact 落地又**加了 1 处** (`snapshotLen = this.messageHistory.length`, 压缩的取快照拍)。
 *    这不是"泄漏消失", 是**迁移动作的可见痕迹** —— 数字对不上就必须回去核 (门已两次拦下这类不同步)。
 */

/**
 * **启动一次执行的 AgentSession 方法名单** (判据口径的数据来源, 冻结)。
 * 为什么必须列全: 只数 `prompt/promptStream` 会让"走文档摘要/改写进来的入口"(P2P 入站)
 * **永远数不到** —— 实测 `index.ts` 因此漏了 4 处 (`summarizeDocument` ×2 · `improveDocument` ×2)。
 * 故意不计的: `readDocument` (纯 IO) · `suggestRename` (单次小调用, 不写会话历史) ·
 *   `runWorkflow` (内部会再调 prompt ⇒ 计入会双算)。
 */
export const AGENT_ENTRY_METHODS: readonly string[] = [
  'prompt', 'promptStream', 'promptWithPivotLoop', 'summarizeDocument', 'improveDocument',
  // K5 步骤⑦ 新增的唯一入口: 请求式投递 (`runExecution`) 也是**启动一次执行** ——
  //   不列进来会让"改写成请求式"的站点从执行点计数里**消失** (实测: 一改成请求式, 该文件 total 就从 11 掉到 10)。
  'runExecution',
];

/**
 * **K5 步骤⑤ channel 级串行锁的状态** (数据; 判据要求 `enabled` 与盘上调用点数一致):
 *   · 证据 (为什么默认不启用): web 的 channel 只有一个 `currentSessionId` ⇒ 用户消息都投到**同一个会话身份**
 *     ⇒ 身份级串行 (mailbox) **已经把这个 channel 的活跃会话串起来了** (验收①在活跃会话上已成立);
 *   · 什么时候才需要它: 会话切换后旧会话仍在内存 ⇒ 两个身份可能并行 (**各写自己的 history, 无污染**);
 *     若要"跨会话切换也串行", 才需要 channel 级锁;
 *   · 代价: 同 channel 的**多个 agent** (P2P 多智能体) 也会被串起来 ⇒ 吞吐下降。
 *   ⇒ 是否全局启用 = **意图层决定** (leo); 能力 (`deliverThroughActor(..., {serializeByChannel:true})`) 已备好。
 */
export const K5_CHANNEL_LOCK = {
  available: true,
  enabled: false,
  /** 盘上真正传了 `serializeByChannel: true` 的调用点数量 (判据从盘上重算, 不许自报) */
  callSites: 0,
  /** 证据出处 (一 channel 一活跃会话身份) */
  evidence: 'web/server.ts:1566-1567 — channel.currentSessionId ⇒ sessionKey = <channelId>:<currentSessionId>',
} as const;

/**
 * **K5 步骤⑥**: Run 身份的归属 (run-boundary 作用域, 从 K2 的"唯一播种读取"收口过来)。
 *   `currentRunId` 的本体从 Pi 实例字段搬进 `actor.state.activeRun` —— 判据 `scanRunBoundaryResidence`
 *   会核对盘上源码里**是否还有** `private currentRunId` 声明 (双向: 声明了却没标未迁 · 没声明却标未迁, 都红)。
 */
export const K5_RUN_BOUNDARY = {
  field: 'currentRunId',
  into: 'actor.activeRun',
  migrated: true,
  /** K2 留下的唯一播种读取 (不因本步而增加; 由 K2 的门强制) */
  seedReads: 1,
} as const;

/**
 /**
  * **K5 步骤⑧ — 实例侧"绑定前暂存"字段已删除** (data; 判据核对盘上是否真的没有它们)。
  *   Pi 出生就带一个**私有 actor** (未注册 ⇒ 谁也拿不到), 工厂知道会话身份时再升级成身份键 actor 并**收养**状态
  *   ⇒ 实例侧不再需要暂存字段。删掉它们同时消灭了两类隐患: "两份真相" 与 "兜底分支写错成自递归"。
  */
 export const K5_FIELD_DELETION = {
   /** 本源里曾经有过的暂存字段全清单 (双向判据的另一半: 少登记一个 ⇒ 红) */
   sourceFields: ['_history', '_channelId', '_agentId', '_goalId', '_runId'],
   deletedStagingFields: ['_history', '_channelId', '_agentId', '_goalId', '_runId'],
   why: 'actor 从出生就在 (私有无身份 / 身份键有身份), 暂存那份多余; 删掉即"删字段"这一步的可见痕迹',
 } as const;

 /** K5 步骤⑦: 一次性 `ExecutionRequest` 的收敛进度。
 *   Pi 侧已加唯一入口 (`applyExecutionRequest` 落绑定 · `runExecution` 派发);
 *   入口面 **converted = 1** (web 用户消息路径)。
 *   `remaining` 是**派生值** (已投递点数 − converted) —— 位置式形态太多, 行级正则数不准,
 *   与其编一个假精确的门, 不如把"请求式"这半钉死, 剩下用算术表示。
 */
export const K5_EXECUTION_REQUEST = {
  methodAdded: true,
  converted: 1,
  wiredTotal: 24,
  remaining: 23,
} as const;

/** 入口 → 文件分组 (判据做**双向**校验: 说完成 ⇒ 其文件必须全接完; 说没完成 ⇒ 必须真有文件没接完) */
export const K5_ENTRY_GROUPS: readonly { entry: string; files: readonly string[]; wired: boolean }[] = [
  { entry: 'web', files: ['web/server.ts', 'web/routes-tasks.ts'], wired: true },
  { entry: 'CLI', files: ['index.ts', 'cli/interface.ts'], wired: true },
  { entry: 'P2P 入站', files: ['index.ts'], wired: true },
  { entry: 'Supervisor/子 Agent', files: ['agents/runner-resolver.ts'], wired: true },
];

/** 进度位 —— 门强制与盘上事实同步 (进度只许增; 未建的不许标已建) */
export const K5_PROGRESS = {
  stage: 'registry-built' as K5Stage,
  /** Actor 容器文件路径 (存在性由门真读盘核对) */
  containerPath: 'kernel/channel-actor.ts',
  fieldsMigrated: 4,
  /** 已迁字段名单 —— 门强制 `length === fieldsMigrated` 且每个名字都在 K5_INHERITED_FIELDS 里 */
  migratedFieldNames: ['messageHistory', 'currentChannelId', 'currentAgentId', 'currentGoalId'],
  fieldsTotal: 4,
  entriesWired: 4,
  entriesTotal: 4,
  /** 判据口径用的方法名单 (数据; 见 AGENT_ENTRY_METHODS 的说明) */
  entryMethods: AGENT_ENTRY_METHODS,
  /** 入口分组 (判据做双向校验: 说完成 ⇒ 文件必须全接完) */
  entryGroups: K5_ENTRY_GROUPS,
  /**
   * K5 步骤④ 的细粒度进度: **全部入口面的执行点清单**。
   * 两个数字都由判据 `scanEntryDelivery` 用同一口径**从盘上重算** (剥注释 / 排除 `this.prompt` / 非流式也算), 自报无效。
   */
  entrySites: [
    // `excludeReceivers` 是**已核实的非执行点 receiver** (台账数据, 冻结; 改动会出现在 diff 里):
    //   `this` = CLI readline 提示 (`this.prompt('> ')`);  `s` = index.ts 里的 UI 打印助手 (`s.prompt('📩 …')`)
    { file: 'web/server.ts', total: 11, wired: 11, excludeReceivers: ['this'] },            // web 用户/中继/任务/心跳
    { file: 'web/routes-tasks.ts', total: 1, wired: 1, excludeReceivers: ['this'] },        // web 任务路由
    { file: 'index.ts', total: 11, wired: 11, excludeReceivers: ['this', 's'] },            // CLI 主入口 + P2P 入站 (含文档摘要/改写)
    { file: 'cli/interface.ts', total: 0, wired: 0, excludeReceivers: ['this'] },           // readline ⇒ 无执行点
    { file: 'agents/runner-resolver.ts', total: 1, wired: 1, excludeReceivers: ['this'] },  // 子 Agent / Supervisor 面
  ],
  /** K5 第 4 步里的 history **操作**搬迁 (4 个: hydrate/append/compact/persist) */
  historyOpsMigrated: 4,
  historyOpsTotal: 4,
  /** 已搬操作名单 —— 门强制 `length === historyOpsMigrated` 且每个名字都在 HISTORY_OPS 里 */
  historyOpsNames: ['hydrate', 'append', 'compact', 'persist'],
} as const;

/** 四个入口 (leo 点名的) —— 全部要进同一 mailbox */
/**
 * history 写入面的**迁移前实测值** (2026-10-02 grep 计数, 见 `scanHistoryWriteSites`):
 * 判据是"每个模式最多剩 1 处直写 (漏斗自身)" —— 若哪天这两个数字对不上盘上事实, 说明有人绕过漏斗。
 */
export const HISTORY_WRITE_SITES = { push: 31, pop: 1, assign: 3 } as const;

/** history 写入的**唯一漏斗** (三个方法名; 判据要求它们真的存在) */
/**
 * history 写入的三个唯一漏斗。**可见性也是台账的一部分** —— 判据的语义是"漏斗存在且形态与账一致",
 * 所以把 `replaceHistory` 升成公开 (步骤⑧: 它是唯一的"种历史"入口, 上层/测试必须能调) 也必须现形于此。
 */
export const HISTORY_WRITE_FUNNEL: readonly { name: string; vis: 'private' | 'public'; why?: string }[] = [
  { name: 'pushHistory', vis: 'private' },
  { name: 'popHistory', vis: 'private' },
  { name: 'replaceHistory', vis: 'public', why: '步骤⑧: 唯一的"种历史"入口 (直接赋数组会换掉数组身份 ⇒ 静默丢数据)' },
];

export const K5_ENTRIES: readonly string[] = ['web/server.ts', 'src/cli', 'P2P 入站', 'Supervisor'];

/** Goal 绑定必须是**显式操作**, 不许靠裸字段隐式生效 (leo 口径) */
export const K5_GOAL_BINDING_RULE = '运行中重新绑定 Goal 必须经过显式 Goal Binding 操作 (写 RunContext/Run 记录), 不许靠裸字段隐式生效';
