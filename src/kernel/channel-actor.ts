/**
 * **Channel Actor** (K5 第 2 步: 容器)
 *
 * 为什么需要它: `messageHistory` / `currentChannelId` / `currentAgentId` / `currentGoalId` 四个字段
 * 在 Pi 实例上被**所有入口共享** —— 这正是"多通道串台 / 同 Channel 并发改 history"的根。
 * K2 已按 leo 口径判定它们**不是 Run 状态**, 该由 Channel Actor 承载 (见 `plan-channel-actor.ts`)。
 *
 * 本文件是**纯新增的容器**: 不改任何现有行为 (Pi 仍按原样跑)。它提供三件事:
 *   ① `ActorState` —— Actor 状态容器 (9 项, 与台账逐条对应);
 *   ② `SerialMailbox` —— 同 Channel **串行**执行队列 (1 个 channel 同时只有 1 个任务在跑);
 *   ③ `ChannelActor` —— 把两者绑起来: `submit()` 入队并串行执行 · `abort()` 取消当前任务。
 *
 * 纪律: 串行语义**真跑验证** (`src/test/kernel-channel-actor.test.ts` 的串行用例), 不靠"看起来对"。
 */

/** Actor 状态容器 —— 与 `ACTOR_STATE_ITEMS` 的 9 项一一对应 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * **当前正在哪个 Actor 的 mailbox 任务里跑** (K5 第 5 步的前置安全网)。
 *
 * 为什么必须有: `SerialMailbox` 是**无重入**的 —— 一个已在 mailbox 里跑的任务若再往同一个 mailbox
 * 投递并 await, 就是**自锁** (新任务排在"自己"后面)。入口投递 (步骤④) 一旦覆盖到"运行中会被调用"
 * 的执行点 (LLM 回调 / judge / 工具内再问一次), 就会踩到这条。
 * ⇒ 用 ALS 记住"我在谁的上下文里", 同 actor 重入时**直跑**, 不同 actor 照常排队。
 */
const actorCtx = new AsyncLocalStorage<ChannelActor>();

/** 当前是否正跑在某个 Actor 的 mailbox 任务内 (诊断用) */
export function currentActorContext(): ChannelActor | undefined {
  return actorCtx.getStore();
}

export interface ActorState {
  /** 会话绑定的通道 */
  channelId: string;
  /** 会话身份 */
  agentId: string;
  /**
   * 会话的 Goal **默认绑定**。
   * 注意 (leo 口径): 这只是默认值; **每次执行开始必须把最终绑定写进 RunContext / Run 记录**,
   * 运行中重新绑定 Goal 必须走显式 Goal Binding 操作, 不许靠裸字段隐式生效。
   */
  goalBinding: string;
  /** **Channel 的连续记忆** (不是 Run 历史): 同 Channel 串行访问, 跨 Channel 必须隔离 */
  messageHistory: unknown[];
  /** 入站消息队列 (本对象由 SerialMailbox 内部维护, 这里只放可见计数) */
  mailbox: { pending: number; processed: number };
  /** 当前活跃 Run (取代 Pi 上的 currentRunId 播种) */
  activeRun: string;
  /** 取消位 (取代 Pi 上的 currentSignal) */
  cancellation: AbortController | null;
  /** 出站流 (取代 Pi 上的 currentOnStream) */
  outboundStream: ((event: unknown) => void) | null;
}

export function createActorState(init: Partial<ActorState> = {}): ActorState {
  return {
    channelId: init.channelId ?? '',
    agentId: init.agentId ?? '',
    goalBinding: init.goalBinding ?? '',
    messageHistory: init.messageHistory ?? [],
    mailbox: init.mailbox ?? { pending: 0, processed: 0 },
    activeRun: init.activeRun ?? '',
    cancellation: init.cancellation ?? null,
    outboundStream: init.outboundStream ?? null,
  };
}

/**
 * 同 Channel **串行**邮箱。
 *
 * 契约 (K5 验收标准 ①):
 *   · `submit()` 立即返回 promise, 任务**排队**执行;
 *   · 同一个 mailbox 内**永不并发** —— 后一个任务在前一个 settle 之后才开始;
 *   · 一个任务抛错**不阻塞**队列 (错误交给该任务自己的 promise, 队列继续);
 *   · `pending` 是"已入队未完成"的数量, 用于观测 (不是背压实现)。
 */
export class SerialMailbox {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private processedCount = 0;

  get pending(): number { return this.pendingCount; }
  get processed(): number { return this.processedCount; }

  submit<T>(task: () => Promise<T> | T): Promise<T> {
    this.pendingCount += 1;
    const run = this.tail.then(async () => {
      try {
        return await task();
      } finally {
        this.pendingCount -= 1;
        this.processedCount += 1;
      }
    });
    // 队列尾巴吞掉错误, 避免一个失败任务毒化后续任务 (错误仍由返回的 promise 抛给调用方)
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 等队列跑空 (测试与收尾用) */
  async drain(): Promise<void> {
    await this.tail;
  }
}

/** 一次执行请求 —— K5 第 7 步的目标形态: Pi 只接收一次性的 ExecutionRequest */
export interface ExecutionRequest {
  input: string;
  channelId: string;
  agentId?: string;
  goalId?: string;
  /** 从 checkpoint 恢复时的 runId (取代 Pi 上的 "currentRunId 播种") */
  resumeRunId?: string;
  signal?: AbortSignal;
  /** 流式回调 (给了就走 promptStream, 不给就走 prompt) —— **K5 步骤⑦**: 一次性请求的唯一入口。
   *  事件类型用 `any`: 内核不该知道上层的事件联合类型 (形参放宽避免调用点的变体不兼容)。*/
  onStream?: (event: any) => void;
}

/**
 * 把一个 Channel 的状态与串行队列绑在一起。
 *
 * 现在**只是容器**: 还没有任何入口往里投递 (K5 第 4 步才接)。
 * 因此它不改变现有行为 —— 现有链路仍走 Pi 实例字段。
 */
export class ChannelActor {
  readonly state: ActorState;
  readonly mailbox = new SerialMailbox();

  constructor(init: Partial<ActorState> = {}) {
    this.state = createActorState(init);
  }

  /** 投递一次执行 (串行执行)。执行期间 `state.activeRun` 由调用方/后续步骤写入 */
  submit<T>(fn: (state: ActorState) => Promise<T> | T): Promise<T> {
    // 任务体内建立 ALS 上下文 ⇒ 任务内部的异步续体也能认出"自己在谁的上下文里"
    return this.mailbox.submit(() => actorCtx.run(this, () => fn(this.state)));
  }

  /**
   * **K5 第 4 步 — hydrate**: 实现体 (load → filter → 截断 → 替换) 住在 Actor, 业务侧只给纯变换。
   * 走邮箱 ⇒ 与 append / persist 串行, 不会再出现"读-改-写"三拍被并发踩掉。
   * 返回灌入条数 (0 = 没历史 / 空 / 加载失败由调用方处理)。
   */
  hydrateHistory<T>(spec: HydrateSpec<T>): Promise<number> {
    return this.mailbox.submit(async () => {
      const loaded = await spec.load();
      if (!loaded) return 0;
      const next = spec.filter(loaded).slice(-spec.maxMessages);
      if (next.length === 0) return 0;
      const arr = this.state.messageHistory as T[];
      arr.length = 0;
      arr.push(...next);
      return next.length;
    });
  }

  /**
   * **K5 第 4 步 — persist 的取数拍**: 取一份快照 (浅拷贝)。
   * 走邮箱 ⇒ 拿到的是一致的 history, 不会与正在进行的 append 交错 (原来的 `this.messageHistory.map(...)`
   * 是"边写边读", 压缩/工具回灌并发时可能落盘到半截状态)。
   */
  historySnapshot<T>(): Promise<T[]> {
    return this.mailbox.submit(() => [...(this.state.messageHistory as T[])]);
  }

  /** **K5 第 4 步 — append (排队版)**: 串行追加 (同 Channel 内排队) */
  appendMessage<T>(msg: T): Promise<void> {
    return this.mailbox.submit(() => { (this.state.messageHistory as T[]).push(msg); });
  }

  /**
   * **K5 第 4 步 — append (同步漏斗版)**: 给"写完立刻要读到"的调用面用 (Pi 的 ReAct 循环里大量
   * `push` 后马上读 `length`/索引) —— 不能改成 await, 否则会改变同拍可见性。
   *
   * 它提供的是**归属与可数性** (所有 history 写入收敛到唯一漏斗, 门可以断言"零处直写"),
   * **不是并发安全** —— 并发安全由"入口投递进 mailbox"负责 (K5 第 5 步 / entriesWired)。
   */
  appendMessageSync<T>(msg: T): void {
    (this.state.messageHistory as T[]).push(msg);
  }

  /** **K5 第 4 步 — pop 漏斗** (与 appendMessageSync 同性质: 归属可数, 不负责并发) */
  popMessageSync<T>(): T | undefined {
    return (this.state.messageHistory as T[]).pop() as T | undefined;
  }

  /**
   * **K5 第 4 步 — compact 的落地拍 (rebase)**: 用压缩结果替换 history, 但**保住**变换期间新追加的尾部。
   *
   * 为什么必须有这一拍: 压缩流水线是 **async** —— 从"取快照"(`snapshotLen`) 到"落地"之间是 await 窗口,
   * 期间 append 进来的消息会被整块替换**丢掉** (lost update)。这里把尾部原样接回去。
   * (同步压缩路径不受影响: 取快照与替换在同一拍相邻两行, 没有窗口 —— 见 pi-sdk 的注释。)
   */
  rebaseHistory<T>(compacted: T[], snapshotLen: number): Promise<{ keptTail: number }> {
    return this.mailbox.submit(() => {
      const arr = this.state.messageHistory as T[];
      const at = Math.max(0, Math.min(snapshotLen, arr.length));
      const tail = arr.slice(at);
      arr.length = 0;
      arr.push(...compacted, ...tail);
      return { keptTail: tail.length };
    });
  }

  /** **K5 第 4 步 — 整体替换漏斗** (hydrate 回灌 / 压缩后的整体赋值都走这里) */
  replaceHistory<T>(next: T[]): void {
    const arr = this.state.messageHistory as T[];
    arr.length = 0;
    arr.push(...next);
  }

  /** 取消当前任务: 中断 signal, 队列继续 (后续任务看到的是新的 controller) */
  abort(reason = 'aborted'): void {
    this.state.cancellation?.abort(reason);
    this.state.cancellation = null;
  }

  /** 开一个新的取消位 (进入一次执行时用) */
  beginCancellation(): AbortSignal {
    const ac = new AbortController();
    this.state.cancellation = ac;
    return ac.signal;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actor 注册表 (K5 第 3 步): 一个 channel 一个 actor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 进程内注册表: **会话身份 → ChannelActor**。
 *
 * ⚠️ 键是**会话身份** (SessionStore key / 整条 peerId), **不是** channel 前缀 —— 这条是被全量回归打出来的:
 *   第一版取 `peerId` 的 `:` 前段当键 ⇒ 同一 channel 下不同会话落进同一个桶 ⇒ 新 session 一构造
 *   就看到别人的 history (4742 测试里 5 红, 症状统一 `expected 2/5/6 to be 0`)。
 *   隔离粒度必须与被迁移状态原有的粒度一致: history 属于**会话**, 不属于 channel 前缀。
 *
 * ⚠️ **没有身份就不归属** (没有 'default' 兜底桶) —— 宁可不共享, 不许串台。这里先把"落点"建起来。
 *
 * ⚠️ 现在的定位 (不许夸大):
 *   · 只做**归属**: 同一 channelId 永远拿到同一个 actor 实例, 不同 channelId 互不相干;
 *   · **还没有任何入口把执行投递进来** (`submit()` 尚未被业务调用) ⇒ K5 进度里
 *     `entriesWired` 仍是 **0/4**, 行为与迁移前一致;
 *   · 进程内 (非持久): 重启后 actor 表为空 —— 持久化是后续步骤 (history/Goal/Run 的恢复)。
 */
const actors = new Map<string, ChannelActor>();

/**
 * 取(或建)某 channel 的 actor。
 * `init` **只在新建时生效** (既有 actor 不会被 init 覆盖 —— 避免"后到的调用把先建的会话状态冲掉")。
 */
export function getOrCreateActor(actorKey: string, init: Partial<ActorState> = {}): ChannelActor {
  const key = actorKey;
  const existing = actors.get(key);
  if (existing) return existing;
  // ⚠️ **不拿身份键当 channel 绑定**: `state.channelId` 的语义 = 会话当前绑定的 channel
  //    (与 Pi 的 currentChannelId 一致, 由 prompt/入口设置)。工厂若预置成 peerId 前缀,
  //    会让会话在入口设置之前就读到非空值 (snapshot / compaction cacheScope 都会跟着变) —— 静默行为变化。
  const created = new ChannelActor({ ...init });
  actors.set(key, created);
  return created;
}

/** 只读探查 (不建) —— 测试与诊断用 */
export function peekActor(actorKey: string): ChannelActor | undefined {
  return actors.get(actorKey);
}

/** 当前 actor 数 (诊断用) */
export function actorCount(): number {
  return actors.size;
}

/** 清空注册表 —— **仅测试用** (避免测试之间互相污染) */
export function resetActors(): void {
  actors.clear();
  channelQueues.clear();
  privateActorsCreated = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// history 操作 (K5 第 4 步): 实现体住在 Actor 里, 业务侧只提供"纯变换"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次 hydrate: `load → filter → 截断 → 替换 history`。
 *
 * 为什么要住在这里 (而不是留在业务侧): 这三步之前是"读-改-写"三拍, 与 append/persist
 * **并发时会互相踩**。放进邮箱 ⇒ 同一 Channel 内天然串行。
 * 业务侧只提供两个**纯**回调 (`load` / `filter`), 内核不 import 业务模块 (边界门).
 */
export interface HydrateSpec<T> {
  /** 从存储读 (通常是 SessionStore.loadMessages) */
  load: () => Promise<unknown[] | null>;
  /** 把存储形状映射成消息数组 (业务侧的知识: roles / toolCall 等) */
  filter: (loaded: unknown[]) => T[];
  /** 只保留最后 N 条 */
  maxMessages: number;
}


// ─────────────────────────────────────────────────────────────────────────────
// 入口投递 (K5 步骤④)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **把一次入口执行投进 Actor 的 mailbox**。
 *
 * 语义 (K5 验收①): 同一会话身份的**输入排队**执行 —— 第二个请求等第一个跑完, 不会并发改 history。
 * 没有 actor (无身份的会话) 就直接跑 ⇒ 行为与迁移前一致。
 *
 * 为什么做成内核里的独立函数: 它是"入口 → 内核"的唯一接缝, 放在这里就能**不起 server 直接单测**
 * (测真语义: 排队 / 隔离 / 兜底), 而不是靠读源码断言。
 */
export interface DeliveryOptions {
  /**
   * **K5 步骤⑤**: 是否按 **channel** 串行 (而不是按会话身份)。
   * 默认 `false` —— 证据表明"活跃会话"上身份级串行已等价于 channel 级 (见 `K5_CHANNEL_LOCK`)。
   * 打开后: 同 channel 的**所有**身份 (含切换后的旧会话 / P2P 多 agent) 会互相排队。
   */
  serializeByChannel?: boolean;
}

export async function deliverThroughActor<T>(
  // 形参故意放宽成 `unknown`: 调用点的 receiver 类型五花八门 (AgentSession / 结构子集 / any),
  //   写成 `{ actor?: ChannelActor }` 会触发 TS 的弱类型检查 ("no properties in common") 而误报。
  //   实际用法由下面这行运行时取值保证 (取不到 actor 就直跑)。
  holder: unknown,
  run: () => Promise<T> | T,
  opts: DeliveryOptions = {},
): Promise<T> {
  const actor = (holder as { actor?: ChannelActor } | null | undefined)?.actor;
  if (!actor || typeof actor.submit !== 'function') return run();
  // **重入保护**: 已经跑在同一个 actor 的 mailbox 任务里 ⇒ 直跑。
  //   否则"运行中被调用的执行点"(LLM 回调 / judge / 工具内再问) 会往自己的队列尾投递 ⇒ **自锁**。
  if (actorCtx.getStore() === actor) return run();
  // channel 级串行 (opt-in): 走 channel 队列; 同样要防重入 (已在同一 channel 队列任务里 ⇒ 直跑)
  if (opts.serializeByChannel) {
    const ch = actor.state.channelId;
    if (ch) {
      const q = getChannelQueue(ch);
      if (channelCtx.getStore() === q) return run();
      return q.submit(() => channelCtx.run(q, () => actor.submit(() => actorCtx.run(actor, () => run()))));
    }
  }
  return actor.submit(run);
}

// ─────────────────────────────────────────────────────────────────────────────
// channel 级串行锁 (K5 步骤⑤) —— **能力先落地, 默认不启用**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * channel 级队列注册表: `channelId → 串行队列`。
 *
 * 为什么要它 / 为什么默认不启用 (证据在 `plan-channel-actor.ts` 的 `K5_CHANNEL_LOCK`):
 *   · **证据**: web 的 channel 只有一个 `currentSessionId` ⇒ 用户消息都投到**同一个会话身份**
 *     ⇒ 身份级串行 (mailbox) **已经把该 channel 的输入串起来了** —— 验收①在活跃会话上已成立。
 *   · **能力**: 会话切换 (`[新会话] 已切换`) 后旧会话仍在内存, 此时两个身份可能并行 —— 若要"跨会话切换也串行",
 *     需要 channel 级锁。
 *   · **代价**: 同 channel 的**多个 agent** (P2P 多智能体) 也会被串起来 ⇒ 吞吐下降。
 *     ⇒ 是否全局启用是**意图层**的决定 (leo), 这里只把能力与证据备好, 由台账的 `enabled` 开关控制。
 */
const channelQueues = new Map<string, SerialMailbox>();

/** 取(或建)某 channel 的串行队列 */
export function getChannelQueue(channelId: string): SerialMailbox {
  const key = channelId || 'default';
  let q = channelQueues.get(key);
  if (!q) { q = new SerialMailbox(); channelQueues.set(key, q); }
  return q;
}

/** 当前 channel 队列数 (诊断用) */
export function channelQueueCount(): number {
  return channelQueues.size;
}

/** channel 队列上下文 (重入判定用; 与 actorCtx 同理 —— 不许自锁) */
const channelCtx = new AsyncLocalStorage<SerialMailbox>();

// ─────────────────────────────────────────────────────────────────────────────
// 私有 actor (K5 步骤⑧): 给"没有会话身份"的 session 用
// ─────────────────────────────────────────────────────────────────────────────

let privateActorsCreated = 0;

/**
 * 造一个**私有** actor: **不注册**进 `actors`, 所以别人拿不到它 ⇒ 不可能串台。
 *
 * 为什么需要它 (K5 步骤⑧ 的前提): 要删掉 Pi 实例侧的"绑定前暂存"字段, 就必须保证**任何 session 都有 actor**。
 * 没有身份时不许猜键 (猜就会共享) —— 那就给它一个**谁也拿不到**的私有 actor:
 * 隔离性比"共享"更保守, 语义与"暂存字段"完全等价 (每个 session 自己一份)。
 */
export function createPrivateActor(): ChannelActor {
  privateActorsCreated += 1;
  return new ChannelActor();
}

/** 已创建的私有 actor 数 (诊断/测试用: 证明"每个无身份 session 各拿一份") */
export function privateActorCount(): number {
  return privateActorsCreated;
}
