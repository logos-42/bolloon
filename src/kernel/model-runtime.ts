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
  /** 默认预算 (ms) */
  defaultTimeoutMs: number;
}

export class ModelRuntime {
  private pool = new Map<string, PooledConnection>();
  private stats = { reused: 0, opened: 0, timeouts: 0, aborts: 0 };

  constructor(
    private readonly ports: ModelRuntimePorts,
    private readonly defaultTimeoutMs = 30_000,
  ) {
    if (typeof ports?.openConnection !== 'function') throw new Error('ModelRuntime 需要 openConnection 端口');
  }

  /** **只读入口**: 取一个租约 (可能需要先开连接; 同一 pool key 复用) */
  async acquire(snapshot: ModelSnapshot): Promise<ModelLease> {
    if (!snapshot?.provider || !snapshot?.model) throw new Error('acquire 需要 provider + model (缺了不许猜)');
    // **只读**: 只读这些字段, 一个都不写回 (snapshot 常被上层冻结; 写它会当场抛)
    const frozen: Readonly<ModelSnapshot> = snapshot;
    const key = modelPoolKey(frozen);
    let slot = this.pool.get(key);
    if (slot) this.stats.reused += 1;
    if (!slot) {
      const controller = new AbortController();   // 连接级取消 (租约级用各自的 signal)
      const opening = this.ports.openConnection(frozen, controller.signal);
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
    const conn = slot.conn;
    slot.leases += 1;
    const snapshotReadonly = frozen;
    let released = false;
    return {
      snapshot: snapshotReadonly,
      release: () => {
        if (released) return;
        released = true;
        const cur = this.pool.get(key);
        if (cur) cur.leases = Math.max(0, cur.leases - 1);
      },
      call: async (req, opts) => {
        if (released) return { ok: false, error: '租约已归还' };
        const budget = snapshotReadonly.timeoutMs ?? this.defaultTimeoutMs;
        const external = opts?.signal;
        if (external?.aborted) { this.stats.aborts += 1; throw new ModelAbortError(); }
        // 每次调用一个受控 AbortController: 超时与外部取消都走它 (底层调用只认一个 signal)
        const ctl = new AbortController();
        const onExternalAbort = () => ctl.abort();
        external?.addEventListener?.('abort', onExternalAbort, { once: true });
        const started = (this.ports.now ?? Date.now)();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { this.stats.timeouts += 1; ctl.abort(); reject(new ModelTimeoutError(budget)); }, budget);
        });
        try {
          const res = await Promise.race([conn.call(req, ctl.signal), timeoutPromise]);
          const out = (res ?? { ok: true }) as ModelCallResult;
          return { ...out, reused: slot!.leases > 1, ms: (this.ports.now ?? Date.now)() - started };
        } catch (err) {
          if (err instanceof ModelTimeoutError) throw err;
          if (ctl.signal.aborted && !(err instanceof ModelTimeoutError)) { this.stats.aborts += 1; throw new ModelAbortError(); }
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
          external?.removeEventListener?.('abort', onExternalAbort);
        }
      },
    };
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
