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
};
