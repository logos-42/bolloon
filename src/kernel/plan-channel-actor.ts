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
 */

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
export const K5_DELETION_PRECONDITIONS: readonly string[] = [
  'PiAgentSession 不再拥有 session 状态',
  '所有入口都经过 Channel Actor',
  '同 Channel 串行、跨 Channel 并发**真跑通过**',
  '重启后 history / Goal / Run 仍能正确恢复',
  'currentRunId 不再由 Pi 负责播种',
  'Pi 的字段访问只剩推理所需的临时变量',
  '旧字段零引用门禁通过',
];

/** 从 K2 移交的 4 个 session 字段 (现仍是 Pi 实例字段, match 口径冻结值) */
export const K5_INHERITED_FIELDS: readonly { name: string; into: string; accesses: number }[] = [
  { name: 'messageHistory', into: 'actor.messageHistory', accesses: 56 },
  { name: 'currentChannelId', into: 'actor.channelId', accesses: 24 },
  { name: 'currentAgentId', into: 'actor.agentId', accesses: 21 },
  { name: 'currentGoalId', into: 'actor.goalBinding', accesses: 22 },
];

/** 进度位 —— 门强制与盘上事实同步 (进度只许增; 未建的不许标已建) */
export const K5_PROGRESS = {
  stage: 'registry-built' as K5Stage,
  /** Actor 容器文件路径 (存在性由门真读盘核对) */
  containerPath: 'kernel/channel-actor.ts',
  fieldsMigrated: 1,
  /** 已迁字段名单 —— 门强制 `length === fieldsMigrated` 且每个名字都在 K5_INHERITED_FIELDS 里 */
  migratedFieldNames: ['messageHistory'],
  fieldsTotal: 4,
  entriesWired: 0,
  entriesTotal: 4,
} as const;

/** 四个入口 (leo 点名的) —— 全部要进同一 mailbox */
export const K5_ENTRIES: readonly string[] = ['web/server.ts', 'src/cli', 'P2P 入站', 'Supervisor'];

/** Goal 绑定必须是**显式操作**, 不许靠裸字段隐式生效 (leo 口径) */
export const K5_GOAL_BINDING_RULE = '运行中重新绑定 Goal 必须经过显式 Goal Binding 操作 (写 RunContext/Run 记录), 不许靠裸字段隐式生效';
