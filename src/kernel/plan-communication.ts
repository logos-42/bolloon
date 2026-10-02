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
  { file: 'src/web/server.ts', count: 7, kind: 'via-actor', faces: ['web-message', 'web-stream', 'web-regen', 'cron', 'supervisor', 'external-wake'], status: 'open', why: 'web 通道 (消息/流式/重生成/cron/Supervisor/外部唤醒)' },
  { file: 'src/web/routes-tasks.ts', count: 0, kind: 'via-actor', status: 'migrated', evidence: '改经 runExecution({input}) —— 行为等价 (applyExecutionRequest 只覆盖显式给出的字段)', faces: ['contacts-reply'], why: 'task 路由' },
  { file: 'src/agents/runner-resolver.ts', count: 0, kind: 'via-actor', status: 'migrated', evidence: '同上; **待真跑核验**: routes-tasks 那处由隐式绑定改为显式传 channelId (ExecutionRequest 要求)', faces: ['external-wake'], why: '独立宿主 runner' },
  { file: 'src/cli-entry.ts', count: 0, kind: 'direct-prompt', status: 'open', faces: ['cli'], why: 'CLI 通道' },
  { file: 'src/web/mobile-core.ts', count: 0, kind: 'direct-prompt', status: 'open', faces: ['mobile'], why: '手机端通道' }
];

/** 各通道自带的出站/重试/恢复状态 (K8 验收: "无各通道自己的重试/任务恢复/outbound 状态") */
export interface K8PerChannelState {
  file: string;
  kind: 'outbox' | 'retry' | 'resume' | 'delivery-ledger';
  why: string;
}

export const K8_PER_CHANNEL_STATE: readonly K8PerChannelState[] = [
  { file: 'src/network/p2p-outbox.ts', kind: 'outbox', why: 'P2P 出站队列 (通道自己的 outbound 状态)' },
  { file: 'src/web/delivery-ledger.ts', kind: 'delivery-ledger', why: '投递台账 (通道自己的投递状态)' },
  { file: 'src/web/server-v3-p2p.ts', kind: 'retry', why: 'P2P 侧重试/恢复路径' },
  { file: 'src/web/server.ts', kind: 'retry', why: 'web 通道内联的重试/恢复 (与上面两处并非同一套)' },
  { file: 'src/cli-entry.ts', kind: 'resume', why: 'CLI 侧会话恢复' },
  { file: 'src/network/peer-fs.ts', kind: 'outbox', why: '文件传输侧出站' },
  { file: 'src/agents/contacts/store.ts', kind: 'outbox', why: '联系人出站/待发' },
  { file: 'src/agents/contacts/providers.ts', kind: 'retry', why: '联系人通道重试' },
  { file: 'src/agents/p2p-chat-tools.ts', kind: 'outbox', why: 'P2P 聊天工具侧出站' },
  { file: 'src/agents/task/task-runner.ts', kind: 'resume', why: '任务运行器自带恢复' },
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
}

export const K8_PROGRESS: K8Progress = {
  stage: 'ledger-landed',
  directSites: 7,   // 12 → 10 (K8 第二步) → 7 (第三步: server.ts 3 处零差量迁移) (2026-10-02: routes-tasks / runner-resolver 两处已走唯一入口; 棘轮只许减)
  perChannelStateFiles: 10,
};
