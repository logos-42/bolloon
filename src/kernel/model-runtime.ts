/**
 * **K6: ModelRuntime 骨架** —— `acquire(modelSnapshot)` **只读**入手。
 *
 * 本步只做三件事 (其余能力在 `plan-modelruntime.ts` 里仍是 `not-started`):
 *   ① **连接复用** (按 snapshot 派生 key 池化, 同一 key 只开一次连接)
 *   ② **timeout** (按 snapshot 的预算; 超时即中止底层调用, 不是"放弃等待")
 *   ③ **cancellation** (外部 AbortSignal 透传到连接, 取消真发生)
 *
 * 边界 (K6 红线):
 *   · **只读**: 绝不改 provider 配置 / API key / 默认 URL / Global model / Run snapshot;
 *   · 不重做既有 `selectModel` / registry / catalog / Run snapshot —— 真正的 provider 调用由 **ports 注入**
 *     (内核不许 import 业务模块: `KERNEL_ALLOWED_IMPORT_PREFIXES = ['kernel/']`)。
 *
 * 通用判据 (K2 实证): **本文件出现后, 旧写口的调用点数不许增加** —— 由 `scanModelRuntimeFile` 机械核对。
 */

/** 只读的模型快照 (调用方给什么就用什么; 运行时不补默认值、不回写) */
export interface ModelSnapshot {
  provider: string;
  model: string;
  /** 可选: 同一 provider 的不同端点 (只读使用, 不改) */
  baseUrl?: string;
  /** 单次调用预算 (ms); 缺省用 runtime 默认值 */
  timeoutMs?: number;
  /** 该 provider 支持的能力 (只读; 能力检查用) */
  capabilities?: readonly string[];
  /**
   * 备用 provider 列表 (**只读**; 来自 Run snapshot) —— 主 provider 失败后按顺序试。
   *   红线: 运行时**只**从这份列表派生候选, 绝不改全局 provider 配置。
   */
  fallbackProviders?: readonly string[];
}

/** 注入的底层能力 (端口; 内核只认形状) */
export interface ModelRuntimePorts {
  /**
   * 开一条到 provider 的连接 (可复用)。`signal` 用于取消。
   *   注意: 端口**不许**接收"要不要改配置"这类意图 —— 它只负责连。
   */
  openConnection(snapshot: Readonly<ModelSnapshot>, signal: AbortSignal): Promise<ModelConnection>;
  /** 时钟注入 (测试可控; 缺省 Date.now) */
  now?(): number;
  /** 睡眠注入 (退避可确定性测试: 真跑用例不必真等) */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  /** 随机注入 (抖动可确定性测试; 缺省 Math.random) */
  random?(): number;
  /**
   * usage 记录端口 (**注入**; 内核不 import RunStore —— 记账属 K4 控制面那边的事)。
   *   端口抛错**不许**影响调用结果 (只记 `usageDropped`)。
   */
  recordUsage?(entry: ModelUsageEntry): Promise<void> | void;
}

/** 一次调用的用量 (真实 provider / 是否回退 / 耗时 / 重试次数; usage 由结果透传) */
export interface ModelUsageEntry {
  provider: string;
  model: string;
  ms: number;
  attempts: number;
  fallback: boolean;
  usage?: unknown;
}

export interface ModelConnection {
  /** 连接标识 (测试用来断言"复用同一连接") */
  id: string;
  /** 发一次请求; 运行时负责超时与取消 */
  call(req: ModelCallRequest, signal: AbortSignal): Promise<ModelCallResult>;
  close(): Promise<void>;
}

export interface ModelCallRequest {
  /** 提示词/消息等 (运行时**不看内容**, 只透传) */
  [k: string]: unknown;
}

export interface ModelCallResult {
  ok: boolean;
  /** 实际使用的 provider (回退后与请求的不同) */
  provider?: string;
  /** 是否用了回退 */
  fallback?: boolean;
  /** 供应商原始响应 (透传) */
  raw?: unknown;
  error?: string;
  /** 是否命中连接复用 (诊断用) */
  reused?: boolean;
  ms?: number;
}

/** 一次"租用": 同一 snapshot 的多次调用共用一个连接 */
export interface ModelLease {
  readonly snapshot: Readonly<ModelSnapshot>;
  call(req: ModelCallRequest, opts?: { signal?: AbortSignal }): Promise<ModelCallResult>;
  /** 归还 (不关连接; 连接由池管理) */
  release(): void;
}

/** 429 识别 (端口可以把限流表达成返回值 status=429, 或抛一个带 status 的错) */
/**
 * K10 ②: 把"有效选择"投影成内核的 `ModelSnapshot` —— **只读投影 + 校验**。
 *   缺 provider/model ⇒ **返回 null** (调用方自己决定降级): 不许编一个假的填进去。
 *   `acquire()` 自己也会拒, 但这里先拒能省掉一次"猜配置"的机会 (而且这个函数是纯的, 好判)。
 */
export function snapshotFromSelection(
  sel: Partial<ModelSnapshot> | null | undefined,
): ModelSnapshot | null {
  const provider = String(sel?.provider ?? '').trim();
  const model = String(sel?.model ?? '').trim();
  if (!provider || !model) return null;
  const out: ModelSnapshot = { provider, model };
  const baseUrl = String(sel?.baseUrl ?? '').trim();
  if (baseUrl) out.baseUrl = baseUrl;
  if (typeof sel?.timeoutMs === 'number') out.timeoutMs = sel.timeoutMs;
  if (sel?.capabilities) out.capabilities = sel.capabilities;
  if (sel?.fallbackProviders) out.fallbackProviders = sel.fallbackProviders;
  return out;
}

export function isRateLimited(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as { status?: unknown; error?: unknown; name?: unknown };
  if (o.status === 429 || o.status === '429') return true;
  if (typeof o.error === 'string' && /\b429\b|rate ?limit/i.test(o.error)) return true;
  return false;
}

/** 退避参数 (写成数据; 实现与测试共用) */
export const BACKOFF_POLICY = {
  baseMs: 200,
  factor: 2,
  maxMs: 5_000,
  /** 抖动比例 (±) —— 防止多个调用方同拍重试 */
  jitter: 0.25,
  maxRetries: 3,
} as const;

/**
 * 计算第 n 次重试的等待时长 (n 从 0 起): `min(base * factor^n, max)` 再乘 ±jitter。
 * `retryAfterMs` (供应商给的 Retry-After) 存在时**取最大值** —— 尊重上游而不只是听自己的退避曲线。
 */
export function backoffDelayMs(n: number, opts?: { retryAfterMs?: number; random?: () => number }): number {
  const exp = Math.min(BACKOFF_POLICY.baseMs * BACKOFF_POLICY.factor ** n, BACKOFF_POLICY.maxMs);
  const r = opts?.random ?? Math.random;
  const jittered = exp * (1 + BACKOFF_POLICY.jitter * (2 * r() - 1));
  return Math.max(0, Math.round(Math.max(jittered, opts?.retryAfterMs ?? 0)));
}

/**
 * **熔断策略** (数据; 实现与测试共用)。按 pool key 记连续失败 ⇒ 开路 ⇒ 冷却后半开探测。
 *   **什么算失败**: 网络/供应商故障类; **不算**: 取消 (调用方的选择) 与 429 (那是退避的活), 见 `countsTowardBreaker`。
 */
export const BREAKER_POLICY = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  /** 半开时允许几个探测 */
  halfOpenProbes: 1,
  why: '连续失败 ⇒ 开路 (fail fast, 不把故障放大) · 冷却后放一个探测 ⇒ 成功闭合, 失败重新开路',
} as const;

/** 这次失败该不该计入熔断 */
export function countsTowardBreaker(err: unknown): boolean {
  if (err instanceof ModelAbortError) return false;      // 调用方取消 ⇒ 不是供应商的错
  if (err instanceof ModelTimeoutError) return true;     // 超时是供应商侧症状
  if (isRateLimited(err)) return false;                  // 限流交给退避, 不熔断
  return true;
}

export class ModelCircuitOpenError extends Error {
  constructor(public readonly retryAtMs: number) { super(`熔断中 (冷却至 ${retryAtMs})`); this.name = 'ModelCircuitOpenError'; }
}
export class ModelCapabilityError extends Error {
  constructor(public readonly missing: readonly string[], public readonly unknown = false) {
    super(unknown ? `未知能力 (snapshot 未声明 capabilities, 无法确认 ${missing.join(', ')})` : `缺能力: ${missing.join(', ')}`);
    this.name = 'ModelCapabilityError';
  }
}

export class ModelTimeoutError extends Error {
  constructor(public readonly budgetMs: number) { super(`模型调用超时 (${budgetMs}ms)`); this.name = 'ModelTimeoutError'; }
}
export class ModelAbortError extends Error {
  constructor() { super('模型调用被取消'); this.name = 'ModelAbortError'; }
}

interface PooledConnection {
  conn: ModelConnection;
  opening: Promise<ModelConnection>;
  leases: number;
}

/** snapshot → 池键 (只用**只读**字段; 与 provider/model/端点相关, 与调用内容无关) */
export function modelPoolKey(s: Readonly<ModelSnapshot>): string {
  return `${s.provider}::${s.model}::${s.baseUrl ?? ''}`;
}

export interface ModelRuntimeStats {
  /** 池里现有连接数 */
  connections: number;
  /** 累计"复用命中"次数 (第二次起算) */
  reused: number;
  /** 累计打开连接数 */
  opened: number;
  /** 累计超时 / 取消次数 */
  timeouts: number;
  aborts: number;
  /** 累计"因并发上限而排队"次数 + 观测到的最大并发 */
  concurrencyWaits: number;
  maxObservedConcurrency: number;
  /** 累计限流命中 / 重试次数 + 最近一次退避时长 */
  rateLimited: number;
  retries: number;
  lastBackoffMs: number;
  /** 熔断: 开路次数 / 因开路而"快速失败"的次数 */
  circuitOpened: number;
  failFast: number;
  /** 能力检查拒收次数 (拒在开连接之前, 不浪费一次连接) */
  capabilityRejects: number;
  /** 半开探测次数 / 探测成功 (闭合) 次数 */
  halfOpenProbes: number;
  breakerClosed: number;
  /** 回退: 因主 provider 失败而切换到备用 provider 的次数 */
  fallbacks: number;
  /** usage 记录: 成功写入 / 写入失败被丢弃 */
  usageRecorded: number;
  usageDropped: number;
  /** 默认预算 (ms) */
  defaultTimeoutMs: number;
}

export class ModelRuntime {
  private pool = new Map<string, PooledConnection>();
  private stats = { reused: 0, opened: 0, timeouts: 0, aborts: 0, concurrencyWaits: 0, maxObservedConcurrency: 0, rateLimited: 0, retries: 0, lastBackoffMs: 0, circuitOpened: 0, failFast: 0, capabilityRejects: 0, halfOpenProbes: 0, breakerClosed: 0, fallbacks: 0, usageRecorded: 0, usageDropped: 0 };
  /** 逐 key 熔断状态 */
  private breakers = new Map<string, { failures: number; state: 'closed' | 'open' | 'half-open'; openUntil: number; probes: number }>();
  /** 每 key 当前在飞的调用数 + 等待队列 (多供应商并发: 各 key 各自算) */
  private active = new Map<string, number>();
  /** 等待者 → 它的 granted 标记 (转让路径用; 见 acquireSlot) */
  private grantedProbe = new WeakMap<object, { value: boolean }>();
  private waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; granted?: boolean }[]>();

  constructor(
    private readonly ports: ModelRuntimePorts,
    private readonly defaultTimeoutMs = 30_000,
    /** 每个 key 的最大并发 (多供应商并发: 逐 key 计数, 互不阻塞) */
    private readonly maxConcurrency = 4,
  ) {
    if (typeof ports?.openConnection !== 'function') throw new Error('ModelRuntime 需要 openConnection 端口');
  }

  /** **只读入口**: 取一个租约 (可能需要先开连接; 同一 pool key 复用) */
  async acquire(snapshot: ModelSnapshot, opts?: { require?: readonly string[] }): Promise<ModelLease> {
    if (!snapshot?.provider || !snapshot?.model) throw new Error('acquire 需要 provider + model (缺了不许猜)');
    // **只读**: 只读这些字段, 一个都不写回 (snapshot 常被上层冻结; 写它会当场抛)
    const frozen: Readonly<ModelSnapshot> = snapshot;
    // ① 能力检查 (**拒在开连接之前** ⇒ 不浪费一次连接; 只读 snapshot.capabilities, 不改任何东西)
    const need = opts?.require ?? [];
    if (need.length > 0) {
      if (!frozen.capabilities) { this.stats.capabilityRejects += 1; throw new ModelCapabilityError(need, true); }
      const have = new Set(frozen.capabilities);
      const missing = need.filter((c) => !have.has(c));
      if (missing.length > 0) { this.stats.capabilityRejects += 1; throw new ModelCapabilityError(missing); }
    }
    const key = modelPoolKey(frozen);
    const { conn } = await this.ensureConnection(frozen);
    const snapshotReadonly = frozen;
    let released = false;
    const self = this;
    return {
      snapshot: snapshotReadonly,
      release: () => {
        if (released) return;
        released = true;
        const cur = self.pool.get(key);
        if (cur) cur.leases = Math.max(0, cur.leases - 1);
      },
      call: async (req, opts) => {
        if (released) return { ok: false, error: '租约已归还' };
        const budget = snapshotReadonly.timeoutMs ?? this.defaultTimeoutMs;
        const external = opts?.signal;
        if (external?.aborted) { self.stats.aborts += 1; throw new ModelAbortError(); }
        const started = (self.ports.now ?? Date.now)();
        // **候选清单 = 主 provider + 备用 (来自 snapshot, 只读)** —— 运行时绝不改全局配置
        const candidates: Readonly<ModelSnapshot>[] = [snapshotReadonly];
        for (const p of snapshotReadonly.fallbackProviders ?? []) {
          if (p && p !== snapshotReadonly.provider) candidates.push({ ...snapshotReadonly, provider: p });
        }
        let last: ModelCallResult = { ok: false, error: '没有可用的 provider' };
        let totalAttempts = 0;
        for (let ci = 0; ci < candidates.length; ci += 1) {
          const snapI = candidates[ci];
          const keyI = modelPoolKey(snapI);
          const isFallback = ci > 0;
          if (isFallback) self.stats.fallbacks += 1;
          try {
            const gate = self.breakerGate(keyI);
            if (gate) {
              self.stats.failFast += 1;
              // 熔断开路: **有下一个候选才回退**; 否则保持"抛出"的契约 (调用方能按类型区分快速失败)
              if (ci + 1 < candidates.length) { last = { ok: false, provider: snapI.provider, fallback: isFallback, error: `熔断中 (冷却至 ${gate})` }; continue; }
              throw new ModelCircuitOpenError(gate);
            }
            const connI = keyI === key ? conn : (await self.ensureConnection(snapI)).conn;
            await self.acquireSlot(keyI, external);
            try {
              for (let attempt = 0; ; attempt += 1) {
                totalAttempts += 1;
                let result: ModelCallResult;
                try {
                  result = await self.callOnce(connI, req, external, budget);
                } catch (err) {
                  if (countsTowardBreaker(err)) self.onFailure(keyI); else self.onSuccess(keyI);
                  throw err;                     // 取消/超时: 取消要立刻冒出去 (不回退), 超时由外层 catch 处理
                }
                if (result.ok) {
                  self.onSuccess(keyI);
                  const ms = (self.ports.now ?? Date.now)() - started;
                  const out: ModelCallResult = { ...result, provider: snapI.provider, fallback: isFallback, reused: (self.pool.get(keyI)?.leases ?? 0) > 1, ms };
                  await self.recordUsage(snapI, { provider: snapI.provider, model: snapI.model, ms, attempts: totalAttempts, fallback: isFallback, usage: (result as { usage?: unknown }).usage });
                  return out;
                }
                if (!isRateLimited(result)) {
                  if (countsTowardBreaker(result)) self.onFailure(keyI); else self.onSuccess(keyI);
                  last = { ...result, provider: snapI.provider, fallback: isFallback, reused: (self.pool.get(keyI)?.leases ?? 0) > 1, ms: (self.ports.now ?? Date.now)() - started };
                  break;                          // 非限流失败 ⇒ 交给下一个候选
                }
                self.stats.rateLimited += 1;
                if (attempt >= BACKOFF_POLICY.maxRetries) {
                  last = { ...result, provider: snapI.provider, fallback: isFallback, ms: (self.ports.now ?? Date.now)() - started, error: `限流重试用尽 (${attempt + 1} 次): ${String(result.error ?? '')}` };
                  break;                          // 限流用尽 ⇒ 也可回退 (容量问题不是 bug)
                }
                const wait = backoffDelayMs(attempt, { retryAfterMs: Number((result as { retryAfterMs?: unknown }).retryAfterMs ?? 0) || undefined, random: self.ports.random });
                self.stats.retries += 1;
                self.stats.lastBackoffMs = wait;
                await self.sleepOrAbort(wait, external);   // 退避期间取消 ⇒ 立刻抛
              }
            } finally {
              self.releaseSlot(keyI);
            }
          } catch (err) {
            if (err instanceof ModelAbortError) throw err;                 // 调用方取消 ⇒ 不回退, 直接冒出去
            if (err instanceof ModelTimeoutError) {
              // 超时: **有下一个候选才回退**; 最后一个候选的超时保持原有契约 (抛出, 调用方才能区分"超时"与"软失败")
              if (ci + 1 < candidates.length) { last = { ok: false, provider: snapI.provider, fallback: isFallback, error: err.message }; continue; }
              throw err;
            }
            throw err;
          }
        }
        const tried = candidates.map((c) => c.provider).join(' → ');
        last = { ...last, ms: (self.ports.now ?? Date.now)() - started, error: `全部候选失败 (${tried}): ${String(last.error ?? '')}` };
        await self.recordUsage(candidates[candidates.length - 1], { provider: last.provider ?? '', model: candidates[candidates.length - 1].model, ms: last.ms ?? 0, attempts: totalAttempts, fallback: candidates.length > 1, usage: undefined });
        return last;
      },
    };
  }

  /** 连接池: 同一 pool key 复用; 开不起来不留脏槽 */
  private async ensureConnection(snapshot: Readonly<ModelSnapshot>): Promise<{ conn: ModelConnection; key: string }> {
    const key = modelPoolKey(snapshot);
    let slot = this.pool.get(key);
    if (slot) this.stats.reused += 1;
    if (!slot) {
      const controller = new AbortController();   // 连接级取消 (租约级用各自的 signal)
      const opening = this.ports.openConnection(snapshot, controller.signal);
      this.stats.opened += 1;
      slot = { conn: undefined as unknown as ModelConnection, opening, leases: 0 };
      this.pool.set(key, slot);
      try {
        slot.conn = await opening;
      } catch (err) {
        this.pool.delete(key);   // 开不起来就不留脏槽 (否则后续全被判"复用")
        throw err;
      }
    } else if (!slot.conn) {
      slot.conn = await slot.opening;
    }
    return { conn: slot.conn, key };
  }

  /** usage 记录: 端口抛错**不许**影响调用结果 (只记 usageDropped) */
  private async recordUsage(snapshot: Readonly<ModelSnapshot>, entry: ModelUsageEntry): Promise<void> {
    if (typeof this.ports.recordUsage !== 'function') return;
    try {
      await this.ports.recordUsage(entry);
      this.stats.usageRecorded += 1;
    } catch {
      this.stats.usageDropped += 1;
    }
  }

  /** 一次尝试 (超时与取消都走受控 controller; 底层只认一个 signal) */
  private async callOnce(conn: ModelConnection, req: ModelCallRequest, external: AbortSignal | undefined, budget: number): Promise<ModelCallResult> {
    const ctl = new AbortController();
    const onExternalAbort = () => ctl.abort();
    external?.addEventListener?.('abort', onExternalAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.stats.timeouts += 1; ctl.abort(); reject(new ModelTimeoutError(budget)); }, budget);
    });
    try {
      const res = await Promise.race([conn.call(req, ctl.signal), timeoutPromise]);
      return (res ?? { ok: true }) as ModelCallResult;
    } catch (err) {
      if (err instanceof ModelTimeoutError) throw err;
      if (ctl.signal.aborted) { this.stats.aborts += 1; throw new ModelAbortError(); }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener?.('abort', onExternalAbort);
    }
  }

  /** 退避睡眠 (可取消; 不真等领域: 端口注入 sleep) */
  private async sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) { this.stats.aborts += 1; throw new ModelAbortError(); }
    const sleep = this.ports.sleep ?? ((d: number) => new Promise<void>((r) => setTimeout(r, d)));
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = () => { this.stats.aborts += 1; reject(new ModelAbortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms, signal), aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** 熔断门: 开路且未到冷却 ⇒ 返回"何时可再试" (调用方快速失败); 冷却已过 ⇒ 转半开并放行探测 */
  private breakerGate(key: string): number | null {
    const b = this.breakers.get(key);
    if (!b || b.state === 'closed') return null;
    const nowMs = (this.ports.now ?? Date.now)();
    if (b.state === 'open' && nowMs >= b.openUntil) {
      b.state = 'half-open'; b.probes = 0;
    }
    if (b.state === 'open') return b.openUntil;
    if (b.probes >= BREAKER_POLICY.halfOpenProbes) return b.openUntil;   // 半开探测名额用完 ⇒ 仍然快速失败
    b.probes += 1;
    this.stats.halfOpenProbes += 1;
    return null;
  }

  /** 成功: 半开 ⇒ 闭合 (清零); 闭合态失败计数清零 */
  private onSuccess(key: string): void {
    const b = this.breakers.get(key);
    if (!b) return;
    if (b.state === 'half-open') { b.state = 'closed'; b.failures = 0; b.probes = 0; this.stats.breakerClosed += 1; return; }
    b.failures = 0;
  }

  /** 失败: 累计; 达阈值 ⇒ 开路; 半开里失败 ⇒ 立刻重新开路 (冷却重新计时) */
  private onFailure(key: string): void {
    const b = this.breakers.get(key) ?? { failures: 0, state: 'closed' as const, openUntil: 0, probes: 0 };
    b.failures += 1;
    const halfOpenFail = b.state === 'half-open';
    if (halfOpenFail || b.failures >= BREAKER_POLICY.failureThreshold) {
      b.state = 'open';
      b.openUntil = (this.ports.now ?? Date.now)() + BREAKER_POLICY.cooldownMs;
      b.probes = 0;
      this.stats.circuitOpened += 1;
    }
    this.breakers.set(key, b);
  }

  /** 只读: 逐 key 熔断状态 (诊断/测试) */
  breakerStates(): Record<string, { failures: number; state: string; openUntil: number }> {
    const out: Record<string, { failures: number; state: string; openUntil: number }> = {};
    for (const [k, v] of this.breakers) out[k] = { failures: v.failures, state: v.state, openUntil: v.openUntil };
    return out;
  }

  /** 取并发槽 (逐 key; 排队可取消) */
  private async acquireSlot(key: string, signal?: AbortSignal): Promise<void> {
    const cur = this.active.get(key) ?? 0;
    if (cur < this.maxConcurrency) {
      this.active.set(key, cur + 1);
      this.stats.maxObservedConcurrency = Math.max(this.stats.maxObservedConcurrency, cur + 1);
      return;
    }
    if (signal?.aborted) { this.stats.aborts += 1; throw new ModelAbortError(); }
    this.stats.concurrencyWaits += 1;
    const granted: { value: boolean } = { value: false };
    await new Promise<void>((resolve, reject) => {
      const list = this.waiters.get(key) ?? [];
      const entry: { resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; granted?: boolean } = { resolve, reject, signal };
      const onAbort = () => {
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        this.stats.aborts += 1;
        reject(new ModelAbortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      list.push(entry);
      this.waiters.set(key, list);
      const wrappedResolve = () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); };
      entry.resolve = wrappedResolve;
      // 槽是**转让**来的 (releaseSlot 直接 resolve 并置 granted) ⇒ 不再自增, 否则并发账虚高 (实测踩到)
      this.grantedProbe.set(entry, granted);
    });
    if (!granted.value) {
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      this.stats.maxObservedConcurrency = Math.max(this.stats.maxObservedConcurrency, this.active.get(key)!);
    }
  }

  /** 还槽: 有排队者就交给它 (不释放额度, 直接转让) */
  private releaseSlot(key: string): void {
    const list = this.waiters.get(key) ?? [];
    const next = list.shift();
    if (next) {
      if (!this.waiters.get(key)?.length) this.waiters.delete(key);
      const probe = this.grantedProbe.get(next);
      if (probe) probe.value = true;
      next.resolve();
      return;
    }
    const cur = this.active.get(key) ?? 0;
    if (cur <= 1) this.active.delete(key); else this.active.set(key, cur - 1);
  }

  /** 只读统计 (诊断/门用) */
  snapshotStats(): ModelRuntimeStats {
    return { connections: this.pool.size, defaultTimeoutMs: this.defaultTimeoutMs, ...this.stats };
  }

  /** 关闭全部连接 (进程收尾用) */
  async closeAll(): Promise<void> {
    const all = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(all.map(async (s) => {
      try { const c = s.conn ?? (await s.opening); await c.close(); } catch { /* 关不掉的连接不阻塞收尾 */ }
    }));
  }
}
