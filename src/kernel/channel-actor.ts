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
