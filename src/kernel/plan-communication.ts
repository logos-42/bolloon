/**
 * K8 台账 (2026-10-02 建) —— **Communication Runtime 收口**
 *
 * 目标形态: `transport → router → channel mailbox`
 * **绝不**: `transport → agent.promptStream()` (通道各自直呼 Agent = 通信层长出 N 条执行路径,
 *   每条的流式/错误/重试/恢复语义都不一样, 没人能一眼看清"一条消息到底怎么被处理")。
 *
 * 本文件是 K8 的**第一步 (台账)**; 判据在 `gate-scan.ts` 的 `countTransportAgentSites` +
 * `scanCommunicationLedger` 里重算比对 —— **台账与盘上事实必须逐字一致**。
 */

/** K8 要统一的 8 个事件面 (设计页 §7 原文口径) */
export const K8_EVENT_FACES = [
  'web-message',      // Web 普通消息
  'web-stream',       // Web 流式回复
  'web-regen',        // Web 重生成
  'cli',              // CLI 通道
  'p2p',              // P2P 对等消息
  'mobile',           // 手机端
  'contacts-reply',   // 联系人自动回复
  'external-wake',    // 外部唤醒
  'cron',             // 定时任务
  'supervisor',       // Supervisor 事件
] as const;

export type K8EventFace = (typeof K8_EVENT_FACES)[number];

/**
 * transport→agent 直连普查 (口径 = **剥掉块注释与行注释后**数 `\.promptStream\s*\(|\.prompt\s*\(`)。
 * kind 分类:
 *   · `direct-prompt` —— 通道自己拼 prompt 并直呼 agent (K8 要收口的形态)
 *   · `via-actor`    —— 至少经 `deliverThroughActor` 串行化 (K5 已做, 但仍是**通道直呼 agent**, 缺 router 层)
 */
export type K8SiteKind = 'direct-prompt' | 'via-actor';

/** 收敛状态: `migrated` = 已改走唯一入口 `runExecution` (K5 步骤⑦) */
export type K8SiteStatus = 'open' | 'migrated';

export interface K8Site {
  file: string;
  count: number;
  kind: K8SiteKind;
  /** 2026-10-02 起: 已迁移的条目 count=0 但**留在台账当记录** (收敛历史不许随进度条消失) */
  status: K8SiteStatus;
  evidence?: string;
  faces: readonly K8EventFace[];
  why: string;
}

/**
 * 迁移记录 (每题一处, 都要有"为什么这次是零差量/有差量"的判断):
 *   · 2026-10-02 第二步: `routes-tasks.ts` / `runner-resolver.ts` 改走 `runExecution`
 *     —— routes-tasks 那处**有差量** (隐式绑定 → 显式 `channelId`), 记为待真跑核验。
 *   · 2026-10-02 第三步: `web/server.ts` **10 → 7** —— 三处 `promptStream(p, cb, undefined, channelId)`
 *     改走 `runExecution({ input, onStream, channelId })`: 参数与派发**完全一致** ⇒ **按构造零差量** (不新增任何绑定)。
 */
export const K8_TRANSPORT_AGENT_SITES: readonly K8Site[] = [
  // K8 第五步: 10 → 7 → 3 → 0 (★ server.ts 已零直连)
  { file: 'src/web/server.ts', count: 0, kind: 'via-actor', faces: ['web-message', 'web-stream', 'web-regen', 'cron', 'supervisor', 'external-wake'], status: 'open', why: 'web 通道 (消息/流式/重生成/cron/Supervisor/外部唤醒)' },
  { file: 'src/web/routes-tasks.ts', count: 0, kind: 'via-actor', status: 'migrated', evidence: '改经 runExecution({input}) —— 行为等价 (applyExecutionRequest 只覆盖显式给出的字段)', faces: ['contacts-reply'], why: 'task 路由' },
  { file: 'src/agents/runner-resolver.ts', count: 0, kind: 'via-actor', status: 'migrated', evidence: 'routes-tasks 那处由隐式绑定改为**显式**传 channelId —— **2026-10-02 真跑核验通过** (src/test/k8-routes-tasks-execution.test.ts: 两半 id 一致的自检不变量 + agent 无 prompt 也跑通 + 真变异判红)', faces: ['external-wake'], why: '独立宿主 runner' },
  { file: 'src/cli-entry.ts', count: 0, kind: 'direct-prompt', status: 'open', faces: ['cli'], why: 'CLI 通道' },
  { file: 'src/web/mobile-core.ts', count: 0, kind: 'direct-prompt', status: 'open', faces: ['mobile'], why: '手机端通道' }
];

/** 各通道自带的出站/重试/恢复状态 (K8 验收: "无各通道自己的重试/任务恢复/outbound 状态")
 *
 * 纪律: **按符号记, 不按行号** —— 行号会漂 (K7 已发生过一次), 门的核法 = "该符号真在该文件里"。
 * 口径 (2026-10-02 逐符号定性, 修正过一次): 每个符号必须带 **scope** —— 因为"文件里出现的状态"
 * 不等于"通道自己的 outbound/重试/恢复"。把 UI 展示状态当收口对象是**伪收口**。
 */
export const K8_STATE_SCOPES = ['k8-target', 'ui-state', 'domain-pending', 'infra-retry'] as const;
export type K8StateScope = (typeof K8_STATE_SCOPES)[number];

export interface K8StateSymbol {
  name: string;
  scope: K8StateScope;
  /** scope ≠ k8-target 时**必须**写清为什么不算 (不许静默豁免) */
  note?: string;
}

export interface K8PerChannelState {
  file: string;
  kind: 'outbox' | 'retry' | 'resume' | 'delivery-ledger' | 'none';
  /** 该文件里真正承载状态/重试/恢复的符号 (盘上实有) + 各自定性 */
  symbols: readonly K8StateSymbol[];
  why: string;
}

const T = (name: string): K8StateSymbol => ({ name, scope: 'k8-target' });

export const K8_PER_CHANNEL_STATE: readonly K8PerChannelState[] = [
  { file: 'src/network/p2p-outbox.ts', kind: 'outbox',
    symbols: ['outbox', 'outboxFile', 'outboxStats', 'totalQueued', 'sendOrQueue', 'queueOnly', 'flushAllOutboxes'].map(T),
    why: 'P2P 出站队列 (通道自己的 outbound 状态 + 自己的 flush 时机)' },
  { file: 'src/web/delivery-ledger.ts', kind: 'delivery-ledger',
    symbols: ['DeliveryLedger', 'DeliveryRecord', 'DeliveryState', 'LedgerStats'].map(T),
    why: '投递台账 (通道自己的投递状态机)' },
  { file: 'src/web/server-v3-p2p.ts', kind: 'retry',
    symbols: ['v3PendingHistoryGets', 'getV3PendingHistoryGets'].map(T),
    why: 'P2P 侧挂起的 history 取回 (通道自己的待办 + 恢复路径)' },
  { file: 'src/web/server.ts', kind: 'retry',
    symbols: [
      T('didFixQueue'),
      T('deliveryLedger'),   // SSE ping 用的 per-client 连败计数 ⇒ 真出站状态
      { name: 'didFixTimer', scope: 'k8-target', note: '2s 节流定时器 —— 保留为**调度策略** (执行已交内核邮箱); 它本身仍是通道自己的调度状态' },
      { name: 'channelRunState', scope: 'k8-target', note: '**下一个(大)目标**: 模块级 `Map<channelId, {running, queue, abortController}>` (24 处用法) —— 通道自己的消息队列 + 串行 flag + abort, 与内核邮箱**功能重复**' },
      { name: 'messageQueue', scope: 'ui-state', note: '`(global as any)` 上的 **Web UI 通知列表** (pending/已读) ⇒ 展示状态, 不是 outbound/重试/恢复' },
      { name: 'pendingFriendRequests', scope: 'domain-pending', note: '**好友申请待办** (业务审批数据, 落盘恢复) ⇒ 业务状态, 不是投递状态' },
      { name: 'PENDING_FRIEND_REQ_FILE', scope: 'domain-pending', note: '同上: 好友申请待办的落盘文件' },
      { name: 'maxAttempts', scope: 'infra-retry', note: 'HTTP `listen` 的 **EADDRINUSE 重试上限** ⇒ 进程启动基础设施, 不是通道出站' },
    ],
    why: 'web 通道内联的真状态: 待修复 channelId 队列(执行已交内核邮箱) + SSE 投递连败计数 + 通道自己的消息队列 channelRunState; 三个符号经定性**不属** K8 收口范围, 逐条写明原因' },
  { file: 'src/cli-entry.ts', kind: 'resume',
    symbols: [T('resumeId')],
    why: 'CLI 侧会话恢复' },
  { file: 'src/network/peer-fs.ts', kind: 'outbox',
    symbols: ['OutboxEntry', 'enqueueOutbox', 'readOutbox', 'countOutbox', 'clearOutbox', 'getPeerOutboxPath'].map(T),
    why: '文件传输侧出站 (落盘 outbox, 与 p2p-outbox 又一套)' },
  { file: 'src/agents/contacts/store.ts', kind: 'none', symbols: [],
    why: '纯存储: **无**自带出站/重试/恢复状态 (显式记 none, 不是"忘了填")' },
  { file: 'src/agents/contacts/providers.ts', kind: 'retry',
    symbols: ['DeliverResult', 'OTP_MAX_ATTEMPTS', 'smtpDeliver'].map(T),
    why: '联系人通道自己的投递结果与重试上限' },
  { file: 'src/agents/p2p-chat-tools.ts', kind: 'outbox',
    symbols: ['outboxPath', 'processPendingInbox'].map(T),
    why: 'P2P 聊天工具侧出站 + 待办处理' },
  { file: 'src/agents/task/task-runner.ts', kind: 'resume',
    symbols: ['ResumeResult', 'resumeTask', 'redelivered', 'refetchDeliveredContent'].map(T),
    why: '任务运行器自带恢复 (含 x402 内容重取/重投递语义)' },
];

export const K8_ACCEPTANCE: readonly string[] = [
  '通信层**无直接 Agent 调用** (一律 transport → router → channel mailbox)',
  '**无各通道自己的** 重试 / 任务恢复 / outbound 状态 (统一到 router + mailbox)',
  '8 个事件面全部经同一条路由 (Web/CLI/P2P/手机/联系人回复/外部唤醒/cron/Supervisor)',
  '收口后**直连数只许减** (棘轮), 且每减一处都要有"改走 router"的可回滚提交点',
  '失败语义统一: 通道不再各自决定重试/放弃 (避免"有的通道静默丢、有的无限重试")',
];

export interface K8Progress {
  stage: 'not-started' | 'ledger-landed' | 'router-landed' | 'consolidated';
  /** 台账落地时盘上的 transport→agent 直连数 (棘轮基线) */
  directSites: number;
  /** 台账落地时"各通道自带状态"的文件数 (棘轮基线) */
  perChannelStateFiles: number;
  /** 台账落地时"通道自带状态"的**符号数** (含范围外符号) */
  perChannelStateSymbols: number;
  /** 只算 **k8-target**: 这才是 K8 要收口的对象 (棘轮: 只许减) */
  k8TargetSymbols: number;
  /** `channelRunState` 迁移工作面基线 (剥注释后的用法数; 棘轮只许减) */
  runStateSites: number;
}

export const K8_PROGRESS: K8Progress = {
  stage: 'ledger-landed',
  directSites: 0,   // 12 → 10 (K8 第二步) → 7 (第三步: server.ts 3 处零差量迁移) (2026-10-02: routes-tasks / runner-resolver 两处已走唯一入口; 棘轮只许减)
  perChannelStateFiles: 10,
  // ⚠️ 2026-10-02 **补登**: 上一版漏了两个真状态符号 (`channelRunState` / `didFixTimer`) ⇒ 35 → 37。
  //    这是**纠正漏登**不是范围扩张 (棘轮拦的是"通道自己状态变多", 不是"把已存在的登记上来")。
  //    同一次提交里 `didFixRunning` (通道自己的全局单飞) 被**真删掉** —— 收口本身是减项, 只是它先前没被登记。
  perChannelStateSymbols: 37,   // 10 文件 / 37 个状态符号 (含 4 个范围外)
  k8TargetSymbols: 33,          // 其中 **33** 个属 K8 收口对象 (棘轮: 只许减)
  runStateSites: 21,            // 下一大目标的迁移工作面 (棘轮: 只许减)
};

// ════════════════════════════════════════════════════════════════════════════════
// K8 下一个大目标: `web/server.ts` 的 `channelRunState` (通道自己的消息队列 + 串行 flag + abort)
//
// 为什么它是"最大的一刀": 它与内核邮箱**功能重复** —— 通道自己存队列、自己管 running、自己管 abort。
// 为什么先落台账不直接改: 21 处用法 (剥注释后, 2026-10-02 量) + 三种语义混在一个对象里
//   (调度 / 观测 / 协作续看), 直接改必然把观测与业务语义一起搅进去。
// ════════════════════════════════════════════════════════════════════════════════

export const K8_RUNSTATE_ROLES = ['k8-target', 'observational', 'domain-collab'] as const;
export type K8RunStateRole = (typeof K8_RUNSTATE_ROLES)[number];

export interface K8RunStateField {
  name: string;
  role: K8RunStateRole;
  /** role = k8-target 时**必须**写替代机制 (收口方案) */
  replacedBy?: string;
  /** role ≠ k8-target 时**必须**写为什么不算 (不许静默豁免) */
  note?: string;
  /** 收口**前置**: 必须先满足什么才能删/搬这个字段 (没有它就等于埋雷) */
  prerequisite?: string;
}

/**
 * `channelRunState` 收口的**总前置** (2026-10-02 量出, 必须写在代码旁边而不是只写在提交里)。
 *
 * 为什么: `running` 同时是**主路径内联跑**与**排队路径**的串行权威。内核邮箱只认识"投给它的任务" ——
 * 若只把排队项投进邮箱而主路径仍内联跑, 邮箱会在内联跑还没结束时**立刻起跑**排队项
 * ⇒ 同一 channel **两条 run 并行** ⇒ 串行性被破坏 (K5 的"同通道串行"承诺失效)。
 * 所以删 `queue`/`running` 的**前置**是: 主路径内联跑自己也进邮箱 (`await getChannelQueue(id).submit(...)`)。
 *
 * **2026-10-02 自纠: 下面这段早些时候写的"实测缺陷"是错的, 按盘上事实改正 (留着错的说法比没有更危险)。**
 * 旧说法 = "主路径 check-then-set 夹在多个 `await` 之间 ⇒ 并发 `/message` 会都通过检查 ⇒ 同通道双开"。
 * **盘上事实不成立**: `if (runState.running)` (server.ts 4839) 与 `running = true` (4853) 之间只有
 * `queue.push` / `broadcastQueueUpdate` / `console.log` / `return` —— **没有 await**; 排空路径那对
 * (`if (runState.running) return;` / `running = true`, 5657/5658) 更是**相邻两行**
 * ⇒ 两处在 Node 单线程模型下都**是原子的**。
 *
 * 真正存在的洞是**同族的另一条** (`handoff 不是授权`): `finishChannelRun` 先**同步**置 `running = false`,
 * 再把下一条**异步**交给邮箱 (`getChannelQueue(channelId).submit`) —— 而该邮箱**与 didFix 等任务共用**
 * (`server.ts` 5790 用同一个 `getChannelQueue(id)`) ⇒ 邮箱里排着前序任务时 handoff 会延后, 这期间新到的
 * `/message` 看到 `running === false` 就**内联起跑**; 等那条排队消息终于被跑到时, 它的防重入守卫
 * `if (runState.running) return;` 直接返回 ⇒ **那条排队消息被静默丢掉** (不是双开, 是丢消息 —— 更糟),
 * 且顺序也被打乱 (后到的先跑)。修法仍是同一个前置: **每条消息 (含主路径) 都投邮箱**, `running`/`queue` 降为观测。
 */
export const K8_RUNSTATE_PREREQUISITE =
  '主路径内联跑必须先进内核邮箱 (`await getChannelQueue(channelId).submit(...)`) 才能删 `queue`/`running`: ' +
  '否则邮箱会与内联跑并行起跑排队项, 同通道双开 (K5 串行承诺失效)。' +
  '**已核实的现网缺陷 (2026-10-02 自纠后)**: handoff 不是授权 —— `finishChannelRun` 同步置 running=false 后异步投邮箱, ' +
  '邮箱与 didFix 共用 ⇒ 前序任务排队时 handoff 延后, 新 `/message` 见 running=false 就内联跑; ' +
  '那条排队消息随后撞上 `if (runState.running) return;` ⇒ **被静默丢掉** (并打乱 FIFO)。' +
  '(旧说法"check-then-set 夹 await ⇒ 并发双开"**不成立**, 已按盘上事实改正。)';

export interface K8RunStateLedger {
  file: string;
  symbol: string;
  /** 盘上(剥注释)该符号出现次数 = 迁移工作面; 必须**等于**盘上事实, 迁移后同步下调 */
  sites: number;
  fields: readonly K8RunStateField[];
  plan: string;
  /** 收口的**总前置** (缺失 ⇔ 有人会裸删字段把串行性搞坏) */
  prerequisite?: string;
}

export const K8_CHANNEL_RUNSTATE: K8RunStateLedger = {
  file: 'src/web/server.ts',
  symbol: 'channelRunState',
  sites: 21,   // 2026-10-02 量: 剥注释后 21 处 (总出现 25, 含 4 处注释)
  fields: [
    { name: 'running', role: 'observational',
      note: '**2026-10-02 正刀后已降为观测口径**: 串行权威归内核邮箱 (`getChannelQueue(channelId).submit`), `running` 只剩"这一轮是否在飞"的展示/判定用途 (UI 的 `queue_update` · `remoteFollowup` 的 `!matchedRs.running` · `/api/loop/inspect` 文案), 不再参与任何"能不能起跑"的判断' },
    // `queue` 字段 **已删除** (2026-10-02 正刀): 每条消息自己 `getChannelQueue(channelId).submit(...)`,
    //   通道不再持有队列 (随之删掉 `PendingMessage` 接口与 `runMessageFromQueue` 那条简化路径)。
    { name: 'abortController', role: 'k8-target',
      replacedBy: '`ExecutionRequest.signal` (K5 步骤⑦ 的请求面已有 `signal`) —— ⚠️ **abort 语义要单独定**, 不随队列一起顺手合并' },
    { name: 'lastSteps', role: 'observational', note: '供 `/api/loop/inspect` 的步骤累积 ⇒ 观测数据, 不是调度状态' },
    { name: 'lastSummary', role: 'observational', note: '同上: 最近一轮摘要 (检查接口用)' },
    { name: 'lastFinalReply', role: 'observational', note: '同上: 最近一次最终回复 (检查接口用)' },
    { name: 'lastTokens', role: 'observational', note: '同上: token 计数 (用量展示)' },
    { name: 'remoteFollowup', role: 'domain-collab', note: '远端协作续看 (`rounds`/`maxRounds`/`remoteChannelId`) ⇒ **业务协作语义**, 不是通道调度' },
  ],
  plan: '按语义分三批, 每批独立提交: ① 队列+单飞 (`queue`/`running`) → 内核邮箱; ② `abort` → `ExecutionRequest.signal` (先定语义); ③ `last*` 观测数据搬出通道对象 (或显式标注"非调度")。',
  prerequisite: K8_RUNSTATE_PREREQUISITE,
};
