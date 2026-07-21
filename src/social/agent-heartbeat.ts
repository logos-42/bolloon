/**
 * agent-heartbeat.ts — 智能体社交心跳 + 生命周期 (2026-07-21, 重构于 2026-07-21)
 *
 * 目的: 让本地智能体拥有"心跳", 周期性宣告存活/能力, 并自主决定跟哪个远端智能体发起对话,
 *       形成本地↔远端智能体的顺畅自动交流.
 *
 * ⚠️ 设计核心: 智能体生命周期 (避免"一直社交却毫无效果")
 *   社交不是目的, 而是达成"目标"的手段. 因此本模块以一个 **目标驱动的状态机** 管理智能体:
 *
 *     BOOTSTRAP ──start()──▶ DISCOVERING ──有存活 peer──▶ ENGAGING
 *        ▲                        │                            │
 *        │                        │ 无目标/无存活 peer         │ 目标达成 / 配额耗尽 / 无效果退避
 *        │                        ▼                            ▼
 *        └───────────────────── RESTING ◀─────────────────────┘
 *                                     │ (goalReevalMs 后重新评估, 重置配额再试一轮)
 *                                     ▼
 *                                  ENGAGING (新一轮)
 *
 *   - 每个目标有配额 (maxInitiations) 与效果阈值 (effectThreshold): 达成即 RESTING, 不再闲聊.
 *   - 若连续多次发起却"毫无效果" (noEffectWindowMs 内无有效回复), 进入退避 RESTING (noEffectBackoffMs),
 *     防止无限互 ping / 烧 LLM.
 *   - RESTING 不是消失: beacon 仍在发, 对端依旧能看到本智能体在线; 只是停止主动社交.
 *   - goalReevalMs 之后会重新评估目标 (重置配额) 再给一轮机会, 让智能体"活着"但不失控.
 *   - pause()/resume()/stop() 提供运行期控制; stop() 会清理全部定时器 (供全局 runtime 优雅关闭).
 *
 * 设计原则 (compile-first / 可测):
 *   - transport / decide / getPeers / self / getGoal / assessEffect 全部可注入, 不依赖真实网络或 LLM.
 *   - 生产环境: transport = p2p-outbox.sendOrQueue, decide = 本地 LLM 决策, getPeers = known_peers + remoteChannelCache.
 *   - 测试环境: 全部用 mock, 验证"beacon → 自主发起 → 远端回复(效果) → 目标达成 → RESTING".
 *
 * 协议 (复用 v3 P2P 的 {v:3, op, payload} 信封):
 *   - agent.heartbeat : 轻量 beacon, payload = {fromPublicKey, agentId, name, channels, ts}
 *   - agent.chat.send  : 本地 agent 自主发起 (已有远端唤醒链路, server.ts:529 处理)
 *   - agent.chat.reply : 远端回复发回 (已有 SSE 链路, server.ts:1494 处理)
 *
 * 与全局 runtime 生命周期的集成:
 *   - stop() 清理定时器, 供 server.ts 的 cleanupAndExit (SIGTERM/SIGINT) 调用.
 *   - onActivity 回调喂给 Watchdog.recordActivity, 避免 24h 看门狗误判卡死.
 *   - 实例注册到 global.socialHeartbeat / global.agentHeartbeat, 供 HealthMonitor.checkHeartbeat 观测.
 *   - 暴露 getDiscoveredAgents() / isAntColonyEnabled() 兼容 HealthMonitor 契约.
 */

export type SendOutcome = 'SENT' | 'QUEUED' | 'FAILED';

export type LifecyclePhase = 'BOOTSTRAP' | 'DISCOVERING' | 'ENGAGING' | 'RESTING' | 'PAUSED';

export interface HeartbeatPeerChannel {
  id: string;
  name: string;
}

export interface PeerInfo {
  publicKey: string;
  name?: string;
  agentId?: string;
  channels: HeartbeatPeerChannel[];
  /** 已知最后活跃时间 (ms epoch), 可选 */
  lastSeen?: number;
}

export interface SelfInfo {
  publicKey: string;
  agentId?: string;
  name?: string;
  channels: HeartbeatPeerChannel[];
}

/** 智能体当前要达成的目标 — 社交行为都服务于它 */
export interface AgentGoal {
  id: string;
  description: string;
  /** 本目标最多主动发起几次 (配额, 防止一直社交) */
  maxInitiations: number;
  /** 收到多少条"有效回复"算目标达成 */
  effectThreshold: number;
  /** 目标有效期 (ms), 过期后重新评估; 不填则不过期 */
  ttlMs?: number;
  createdAt?: number;
}

export interface SocialDecision {
  initiate: boolean;
  targetPeerPublicKey?: string;
  targetChannelId?: string;
  message?: string;
  reason?: string;
  /** 决策时即可声明目标已达成 (如 LLM 判断无需再聊) */
  goalAchieved?: boolean;
}

/** 发往单个 peer 的 RPC 抽象 (生产 = sendOrQueue) */
export interface HeartbeatTransport {
  send(publicKey: string, op: string, payload: any): Promise<SendOutcome>;
}

/** 目标运行期状态 (内部) */
interface GoalRuntime {
  goal: AgentGoal;
  initiationsUsed: number;
  effectfulReplies: number;
  lastEffectAt?: number;
  lastInitiateAt?: number;
  achieved: boolean;
  startedAt: number;
}

export interface LifecycleSnapshot {
  phase: LifecyclePhase;
  started: boolean;
  livePeers: number;
  backoffLevel: number;
  socialIntervalMs: number;
  noEffectBackoffUntil: number;
  goal?: {
    id: string;
    description: string;
    initiationsUsed: number;
    maxInitiations: number;
    effectfulReplies: number;
    effectThreshold: number;
    achieved: boolean;
  };
}

export interface AgentHeartbeatOptions {
  /** 本地身份 + 渠道 (生产: 从 channels 读) */
  self: () => SelfInfo | Promise<SelfInfo>;
  /** 已知 peer 列表 (生产: known_peers + remoteChannelCache) */
  getPeers: () => PeerInfo[] | Promise<PeerInfo[]>;
  /** 发 RPC 的传输层 */
  transport: HeartbeatTransport;
  /** 社交决策: 给定 self + 存活 peers + 当前目标, 返回是否发起 + 发给谁 + 说什么. 不提供则只发 beacon */
  decide?: (ctx: { self: SelfInfo; peers: PeerInfo[]; goal?: AgentGoal }) => Promise<SocialDecision>;
  /** 当前要追求的目标 (生产: 由 owner 设定 / 从 persona 派生). 不提供则用内置 discovery 目标 (有配额, 不会一直社交) */
  getGoal?: () => AgentGoal | Promise<AgentGoal | null> | null;
  /** 评估一条远端回复是否"有效/推进了目标". 不提供则默认: 非空回复即有效 */
  assessEffect?: (ctx: { goal: AgentGoal; fromPublicKey: string; replyText: string }) => { advanced: boolean; achievedGoal?: boolean };
  /** 收到远端 chat.reply 时回调 (生产: 已由 server.ts SSE 处理, 这里用于测试/落盘) */
  onReply?: (info: { fromPublicKey: string; channelId: string; text: string }) => void;
  /** 收到远端 heartbeat 时回调 (生产: 可用于 SSE 推前端显示 peer 在线) */
  onPeerAlive?: (peer: PeerInfo) => void;
  /** 每次社交 tick 时回调 (生产: 喂给 Watchdog.recordActivity, 防止 24h 看门狗误重启) */
  onActivity?: () => void;
  /** 生命周期阶段变化时回调 (生产: 推 SSE `agent-lifecycle` 给前端) */
  onLifecycleChange?: (phase: LifecyclePhase, snapshot: LifecycleSnapshot) => void;
  beaconIntervalMs?: number;
  socialIntervalMs?: number;
  /** 同一 peer 两次主动发起之间的最小间隔 */
  cooldownMs?: number;
  /** 超过该时长没收到 beacon 视为不在线, 不参与决策 */
  liveWindowMs?: number;
  /** 总开关 (beacon 会跑) */
  enabled?: boolean;
  /** 社交决策循环开关 (默认跟 enabled) */
  socialEnabled?: boolean;
  /** 连续多少次发起仍无效果后进入退避 (默认 3) */
  minAttemptsBeforeBackoff?: number;
  /** 无效果判定的时间窗 (默认 10min): 距上次有效回复超过该值且已达 minAttempts → 退避 */
  noEffectWindowMs?: number;
  /** 退避后保持 RESTING 的时长 (默认 30min) */
  noEffectBackoffMs?: number;
  /** 退避倍率 (默认 2): social 间隔按 backoffFactor^level 增长 */
  backoffFactor?: number;
  /** 退避后 social 间隔上限 (默认 30min) */
  maxSocialIntervalMs?: number;
  /** RESTING 后多久重新评估目标并重置配额再试一轮 (默认 60min) */
  goalReevalMs?: number;
}

const DEFAULTS = {
  beaconIntervalMs: 30_000,
  socialIntervalMs: 120_000,
  cooldownMs: 10 * 60_000,
  liveWindowMs: 3 * 30_000,
  minAttemptsBeforeBackoff: 3,
  noEffectWindowMs: 10 * 60_000,
  noEffectBackoffMs: 30 * 60_000,
  backoffFactor: 2,
  maxSocialIntervalMs: 30 * 60_000,
  goalReevalMs: 60 * 60_000,
};

const MAX_BACKOFF_LEVEL = 6;

export class AgentHeartbeat {
  private readonly opts: {
    self: () => SelfInfo | Promise<SelfInfo>;
    getPeers: () => PeerInfo[] | Promise<PeerInfo[]>;
    transport: HeartbeatTransport;
    decide?: (ctx: { self: SelfInfo; peers: PeerInfo[]; goal?: AgentGoal }) => Promise<SocialDecision>;
    getGoal?: () => AgentGoal | Promise<AgentGoal | null> | null;
    assessEffect?: (ctx: { goal: AgentGoal; fromPublicKey: string; replyText: string }) => { advanced: boolean; achievedGoal?: boolean };
    onReply?: (info: { fromPublicKey: string; channelId: string; text: string }) => void;
    onPeerAlive?: (peer: PeerInfo) => void;
    onActivity?: () => void;
    onLifecycleChange?: (phase: LifecyclePhase, snapshot: LifecycleSnapshot) => void;
    beaconIntervalMs: number;
    socialIntervalMs: number;
    cooldownMs: number;
    liveWindowMs: number;
    minAttemptsBeforeBackoff: number;
    noEffectWindowMs: number;
    noEffectBackoffMs: number;
    backoffFactor: number;
    maxSocialIntervalMs: number;
    goalReevalMs: number;
    enabled: boolean;
    socialEnabled: boolean;
  };

  private peerLiveness = new Map<string, number>();
  private lastInitiated = new Map<string, number>();
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private socialTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  // === 生命周期状态 ===
  private phase: LifecyclePhase = 'BOOTSTRAP';
  private goalRT: GoalRuntime | null = null;
  /** 内置兜底目标 (无 getGoal 时使用, 带配额, 保证不会一直社交) */
  private builtinGoalRT: GoalRuntime | null = null;
  private backoffLevel = 0;
  private noEffectBackoffUntil = 0;

  constructor(options: AgentHeartbeatOptions) {
    this.opts = {
      self: options.self,
      getPeers: options.getPeers,
      transport: options.transport,
      decide: options.decide,
      getGoal: options.getGoal,
      assessEffect: options.assessEffect,
      onReply: options.onReply,
      onPeerAlive: options.onPeerAlive,
      onActivity: options.onActivity,
      onLifecycleChange: options.onLifecycleChange,
      beaconIntervalMs: options.beaconIntervalMs ?? DEFAULTS.beaconIntervalMs,
      socialIntervalMs: options.socialIntervalMs ?? DEFAULTS.socialIntervalMs,
      cooldownMs: options.cooldownMs ?? DEFAULTS.cooldownMs,
      liveWindowMs: options.liveWindowMs ?? DEFAULTS.liveWindowMs,
      minAttemptsBeforeBackoff: options.minAttemptsBeforeBackoff ?? DEFAULTS.minAttemptsBeforeBackoff,
      noEffectWindowMs: options.noEffectWindowMs ?? DEFAULTS.noEffectWindowMs,
      noEffectBackoffMs: options.noEffectBackoffMs ?? DEFAULTS.noEffectBackoffMs,
      backoffFactor: options.backoffFactor ?? DEFAULTS.backoffFactor,
      maxSocialIntervalMs: options.maxSocialIntervalMs ?? DEFAULTS.maxSocialIntervalMs,
      goalReevalMs: options.goalReevalMs ?? DEFAULTS.goalReevalMs,
      enabled: options.enabled ?? true,
      socialEnabled: options.socialEnabled ?? (options.enabled ?? true),
    };
  }

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  isSocialEnabled(): boolean {
    return this.opts.enabled && this.opts.socialEnabled;
  }

  // ===================== 启动 / 停止 / 暂停 =====================

  start(): void {
    if (this.started || !this.opts.enabled) return;
    this.started = true;
    this.setPhase('DISCOVERING');
    this.beaconTimer = setInterval(() => {
      this.tickBeacon().catch((e) => console.warn('[heartbeat] beacon tick 失败:', (e as Error)?.message));
    }, this.opts.beaconIntervalMs);
    if (this.isSocialEnabled()) {
      this.scheduleSocial();
    }
    // 立即发一次 beacon, 让对端尽快看到自己
    this.tickBeacon().catch(() => {});
    console.log(
      `[heartbeat] 社交心跳已启动 (beacon=${this.opts.beaconIntervalMs}ms` +
      `${this.isSocialEnabled() ? `, social=${this.opts.socialIntervalMs}ms, cooldown=${this.opts.cooldownMs}ms` : ', social=关闭'} )`
    );
  }

  /** 优雅停止: 清理全部定时器 (供全局 runtime 的 SIGTERM/SIGINT 清理调用) */
  stop(): void {
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    if (this.socialTimer) clearTimeout(this.socialTimer);
    this.beaconTimer = null;
    this.socialTimer = null;
    this.started = false;
    this.setPhase('PAUSED');
    console.log('[heartbeat] 社交心跳已停止 (定时器已清理)');
  }

  /** 暂停社交循环 (beacon 仍发, 智能体依旧在线可见, 只是停止主动聊天) */
  pause(): void {
    if (!this.started) return;
    if (this.socialTimer) clearTimeout(this.socialTimer);
    this.socialTimer = null;
    this.setPhase('PAUSED');
    console.log('[heartbeat] 社交循环已暂停 (仅保留 beacon)');
  }

  /** 从 PAUSED 恢复社交循环 */
  resume(): void {
    if (!this.started) {
      this.start();
      return;
    }
    if (this.phase !== 'PAUSED') return;
    this.setPhase('DISCOVERING');
    if (this.isSocialEnabled()) this.scheduleSocial();
    console.log('[heartbeat] 社交循环已恢复');
  }

  // ===================== beacon =====================

  /** 周期性 beacon: 向每个已知 peer 宣告存活 + 自身渠道/能力 */
  async tickBeacon(): Promise<void> {
    const self = await this.opts.self();
    const peers = await this.opts.getPeers();
    const payload = {
      fromPublicKey: self.publicKey,
      agentId: self.agentId,
      name: self.name,
      channels: self.channels,
      ts: Date.now(),
    };
    for (const p of peers) {
      if (p.publicKey === self.publicKey) continue;
      const r = await this.opts.transport
        .send(p.publicKey, 'agent.heartbeat', payload)
        .catch(() => 'FAILED' as SendOutcome);
      if (r !== 'FAILED') this.peerLiveness.set(p.publicKey, Date.now());
    }
  }

  // ===================== 社交决策 tick (生命周期感知) =====================

  /** 自适应 social 间隔 (退避时指数增长, 有上限) */
  private currentSocialInterval(): number {
    const mult = Math.pow(this.opts.backoffFactor, this.backoffLevel);
    return Math.min(this.opts.socialIntervalMs * mult, this.opts.maxSocialIntervalMs);
  }

  private scheduleSocial(): void {
    if (!this.started || !this.isSocialEnabled() || this.phase === 'PAUSED') {
      this.socialTimer = null;
      return;
    }
    this.socialTimer = setTimeout(() => {
      this.tickSocial()
        .catch((e) => console.warn('[heartbeat] social tick 失败:', (e as Error)?.message))
        .finally(() => {
          if (this.started && this.phase !== 'PAUSED') this.scheduleSocial();
        });
    }, this.currentSocialInterval());
  }

  /** 社交决策 tick: 先评估生命周期, 再决定是否对存活 peer 发起对话 */
  async tickSocial(): Promise<void> {
    this.opts.onActivity?.();

    const self = await this.opts.self();
    const allPeers = (await this.opts.getPeers()).filter((p) => p.publicKey !== self.publicKey);
    const now = Date.now();
    const livePeers = allPeers.filter((p) => {
      const seen = this.peerLiveness.get(p.publicKey) ?? p.lastSeen ?? 0;
      return now - seen <= this.opts.liveWindowMs;
    });

    const goalRT = await this.resolveGoal();

    // —— 生命周期评估: 决定本 tick 进入哪个阶段 ——
    const evalResult = this.evaluateLifecycle(goalRT, livePeers.length, now);
    if (evalResult.backoff) {
      this.backoffLevel = Math.min(this.backoffLevel + 1, MAX_BACKOFF_LEVEL);
      this.noEffectBackoffUntil = now + this.opts.noEffectBackoffMs;
    }
    if (evalResult.resetBackoff) {
      this.backoffLevel = 0;
      this.noEffectBackoffUntil = 0;
    }
    this.setPhase(evalResult.nextPhase);

    if (this.phase === 'RESTING' || this.phase === 'PAUSED') {
      console.log(
        `[heartbeat] 生命周期=${this.phase}, 跳过本次社交` +
        `${this.noEffectBackoffUntil > now ? ` (无效果退避至 ${new Date(this.noEffectBackoffUntil).toLocaleTimeString()})` : ''}` +
        ` (goal=${goalRT?.goal.description ?? '无'})`
      );
      this.emitLifecycle();
      return;
    }

    if (!this.opts.decide) {
      this.setPhase('DISCOVERING');
      this.emitLifecycle();
      return;
    }
    if (livePeers.length === 0) {
      this.setPhase('DISCOVERING');
      console.log('[heartbeat] social tick: 没有存活 peer, 仅保持发现');
      this.emitLifecycle();
      return;
    }

    this.setPhase('ENGAGING');
    const decision = await this.opts.decide({ self, peers: livePeers, goal: goalRT?.goal }).catch(
      () => ({ initiate: false }) as SocialDecision
    );

    // 决策时即可声明目标达成
    if (decision?.goalAchieved && goalRT) {
      goalRT.achieved = true;
      this.setPhase('RESTING');
      console.log(`[heartbeat] 决策判定目标已达成 → RESTING: ${goalRT.goal.description}`);
      this.emitLifecycle();
      return;
    }
    if (!decision?.initiate) {
      this.emitLifecycle();
      return;
    }
    const { targetPeerPublicKey, targetChannelId, message } = decision;
    if (!targetPeerPublicKey || !targetChannelId || !message) {
      this.emitLifecycle();
      return;
    }

    // 冷却: 避免对同一 peer 刷屏 / 无限互 ping
    const last = this.lastInitiated.get(targetPeerPublicKey) ?? 0;
    if (now - last < this.opts.cooldownMs) {
      this.emitLifecycle();
      return;
    }

    // 目标配额: 本目标已发起够多次则进入 RESTING
    if (goalRT && goalRT.initiationsUsed >= goalRT.goal.maxInitiations) {
      this.setPhase('RESTING');
      console.log(`[heartbeat] 目标配额用尽 (${goalRT.initiationsUsed}/${goalRT.goal.maxInitiations}) → RESTING`);
      this.emitLifecycle();
      return;
    }

    const r = await this.opts.transport
      .send(targetPeerPublicKey, 'agent.chat.send', {
        channelId: targetChannelId,
        text: message,
        fromPublicKey: self.publicKey,
      })
      .catch(() => 'FAILED' as SendOutcome);
    if (r !== 'FAILED') {
      this.lastInitiated.set(targetPeerPublicKey, now);
      if (goalRT) {
        goalRT.initiationsUsed++;
        goalRT.lastInitiateAt = now;
      }
      console.log(
        `[heartbeat] 主动发起对话 → ${targetPeerPublicKey.slice(0, 8)}… (channel=${targetChannelId}): "${message.slice(0, 40)}..."` +
        `${goalRT ? ` [目标 ${goalRT.initiationsUsed}/${goalRT.goal.maxInitiations}]` : ''}`
      );
    } else {
      console.warn(`[heartbeat] 主动发起失败 (peer ${targetPeerPublicKey.slice(0, 8)}… 不在线?)`);
    }
    this.emitLifecycle();
  }

  // ===================== 生命周期评估 =====================

  private makeGoalRuntime(g: AgentGoal): GoalRuntime {
    return {
      goal: { ...g, createdAt: g.createdAt ?? Date.now() },
      initiationsUsed: 0,
      effectfulReplies: 0,
      achieved: false,
      startedAt: Date.now(),
    };
  }

  /** 解析当前目标: 复用未达成/未过期的目标; 否则尝试 getGoal(); 再否则用内置 discovery 目标 (带配额) */
  private async resolveGoal(): Promise<GoalRuntime | null> {
    if (this.goalRT && !this.goalRT.achieved) {
      const ttl = this.goalRT.goal.ttlMs ?? Infinity;
      if (Date.now() - this.goalRT.startedAt < ttl) return this.goalRT;
    }
    const g = await this.opts.getGoal?.();
    if (g) {
      this.goalRT = this.makeGoalRuntime(g);
      return this.goalRT;
    }
    // 兜底: 内置 discovery 目标, 保证不会"一直社交" (有配额)
    if (!this.builtinGoalRT || this.builtinGoalRT.achieved) {
      this.builtinGoalRT = this.makeGoalRuntime({
        id: 'builtin-discovery',
        description: '与已知 peer 建立并维持协作关系',
        maxInitiations: 5,
        effectThreshold: 2,
      });
    }
    this.goalRT = this.builtinGoalRT;
    return this.goalRT;
  }

  /**
   * 生命周期转移决策.
   * 返回下一个阶段 + 是否触发退避 + 是否重置退避.
   */
  private evaluateLifecycle(
    goalRT: GoalRuntime | null,
    liveCount: number,
    now: number
  ): { nextPhase: LifecyclePhase; backoff: boolean; resetBackoff: boolean } {
    // 无目标 → 用内置 discovery 兜底; 这里 goalRT 总有值
    if (!goalRT) return { nextPhase: 'RESTING', backoff: false, resetBackoff: false };
    // 目标已达成 → 休息
    if (goalRT.achieved) return { nextPhase: 'RESTING', backoff: false, resetBackoff: true };
    // 配额耗尽 → 休息
    if (goalRT.initiationsUsed >= goalRT.goal.maxInitiations) {
      return { nextPhase: 'RESTING', backoff: false, resetBackoff: false };
    }
    // 无效果退避中 → 保持休息
    if (now < this.noEffectBackoffUntil) {
      return { nextPhase: 'RESTING', backoff: false, resetBackoff: false };
    }
    // 连续多次发起却长时间无效果 → 进入退避
    const sinceEffect = goalRT.lastEffectAt ? now - goalRT.lastEffectAt : now - goalRT.startedAt;
    if (goalRT.initiationsUsed >= this.opts.minAttemptsBeforeBackoff && sinceEffect > this.opts.noEffectWindowMs) {
      return { nextPhase: 'RESTING', backoff: true, resetBackoff: false };
    }
    // RESTING 重新评估: 超过 goalReevalMs 且有存活 peer → 重置配额, 给新一轮机会
    if (this.phase === 'RESTING' && liveCount > 0) {
      const sinceLast = goalRT.lastInitiateAt ? now - goalRT.lastInitiateAt : now - goalRT.startedAt;
      if (sinceLast > this.opts.goalReevalMs) {
        goalRT.initiationsUsed = 0;
        return { nextPhase: 'ENGAGING', backoff: false, resetBackoff: true };
      }
    }
    return { nextPhase: liveCount > 0 ? 'ENGAGING' : 'DISCOVERING', backoff: false, resetBackoff: false };
  }

  // ===================== 入站处理 =====================

  /** 入站处理: 由 server.ts 的 data 事件处理器在收到 agent.heartbeat / agent.chat.reply 时调用 */
  handleIncoming(op: string, payload: any, fromPublicKey: string): void {
    if (op === 'agent.heartbeat') {
      this.peerLiveness.set(fromPublicKey, Date.now());
      const info: PeerInfo = {
        publicKey: fromPublicKey,
        name: payload?.name,
        agentId: payload?.agentId,
        channels: Array.isArray(payload?.channels) ? (payload.channels as HeartbeatPeerChannel[]) : [],
        lastSeen: Date.now(),
      };
      this.opts.onPeerAlive?.(info);
      return;
    }
    if (op === 'agent.chat.reply') {
      this.opts.onReply?.({
        fromPublicKey,
        channelId: payload?.channelId || '',
        text: payload?.text || '',
      });
      // 效果度量: 一条有效回复推进目标 → 累计效果, 解除退避; 达阈值则目标达成 → RESTING
      const goalRT = this.goalRT;
      if (goalRT && !goalRT.achieved) {
        const assessment = this.opts.assessEffect
          ? this.opts.assessEffect({ goal: goalRT.goal, fromPublicKey, replyText: payload?.text || '' })
          : { advanced: !!(payload?.text && String(payload.text).trim().length > 0), achievedGoal: false };
        if (assessment.advanced) {
          goalRT.effectfulReplies++;
          goalRT.lastEffectAt = Date.now();
          this.backoffLevel = 0;
          this.noEffectBackoffUntil = 0;
          if (assessment.achievedGoal || goalRT.effectfulReplies >= goalRT.goal.effectThreshold) {
            goalRT.achieved = true;
            console.log(
              `[heartbeat] 目标达成 (效果 ${goalRT.effectfulReplies}/${goalRT.goal.effectThreshold}) → RESTING: ${goalRT.goal.description}`
            );
            this.setPhase('RESTING');
          }
        }
      }
      return;
    }
  }

  // ===================== 运行期控制 / 观测 =====================

  /** 设定新目标 (owner 可通过 RPC 注入). 会重置运行期状态 */
  setGoal(goal: AgentGoal): void {
    this.goalRT = this.makeGoalRuntime(goal);
    this.backoffLevel = 0;
    this.noEffectBackoffUntil = 0;
    if (this.started && this.phase === 'RESTING') this.setPhase('DISCOVERING');
    console.log(`[heartbeat] 设定新目标: ${goal.description} (配额 ${goal.maxInitiations}, 效果阈值 ${goal.effectThreshold})`);
    this.emitLifecycle();
  }

  private setPhase(p: LifecyclePhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.emitLifecycle();
  }

  private emitLifecycle(): void {
    this.opts.onLifecycleChange?.(this.phase, this.getLifecycle());
  }

  /** 当前生命周期快照 */
  getLifecycle(): LifecycleSnapshot {
    return {
      phase: this.phase,
      started: this.started,
      livePeers: this.peerLiveness.size,
      backoffLevel: this.backoffLevel,
      socialIntervalMs: this.currentSocialInterval(),
      noEffectBackoffUntil: this.noEffectBackoffUntil,
      goal: this.goalRT
        ? {
            id: this.goalRT.goal.id,
            description: this.goalRT.goal.description,
            initiationsUsed: this.goalRT.initiationsUsed,
            maxInitiations: this.goalRT.goal.maxInitiations,
            effectfulReplies: this.goalRT.effectfulReplies,
            effectThreshold: this.goalRT.goal.effectThreshold,
            achieved: this.goalRT.achieved,
          }
        : undefined,
    };
  }

  /** 调试: 当前 peer 存活表 */
  getLiveness(): Array<{ publicKey: string; lastSeen: number }> {
    return Array.from(this.peerLiveness.entries()).map(([publicKey, lastSeen]) => ({ publicKey, lastSeen }));
  }

  /** 调试: 上次主动发起时间 */
  getLastInitiated(publicKey: string): number | undefined {
    return this.lastInitiated.get(publicKey);
  }

  // ===================== 兼容 HealthMonitor 契约 =====================

  /** 供 HealthMonitor.checkHeartbeat 观测已发现的智能体 */
  getDiscoveredAgents(): PeerInfo[] {
    return this.getLiveness().map((l) => ({ publicKey: l.publicKey, lastSeen: l.lastSeen, channels: [] }));
  }

  /** 供 HealthMonitor.checkHeartbeat 观测社交是否开启 */
  isAntColonyEnabled(): boolean {
    return this.isSocialEnabled();
  }
}
