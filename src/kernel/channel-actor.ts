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
    return this.mailbox.submit(() => fn(this.state));
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
  const created = new ChannelActor({ ...init, channelId: init.channelId ?? key });
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

