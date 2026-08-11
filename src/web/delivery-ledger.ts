/**
 * delivery-ledger.ts — SSE 客户端投递账本 (借鉴 Hermes gateway/delivery_ledger.py)
 *
 * Hermes outbox 模式 (WAL + 三态 checkpoint + 崩溃语义):
 *   pending    — 发送从未开始: 直接重发, 无重复风险
 *   attempting — 发送中途崩溃: 平台可能已收到 → 带可见标记重发 (诚实的 at-least-once, 不静默重复)
 *   delivered  — 仅 SendResult.success
 *   failed     — 明确拒绝一次; 重启是天然重试边界
 *
 * Bolloon 版 (轻量, 内存): 追踪每个 SSE 客户端的投递状态 + 失败统计 + 同类错误节流
 * (channel_directory 模式: 同一 (类别, 错误) 窗口内只 warn 一次, 防日志刷屏).
 */

export type DeliveryState = 'pending' | 'attempting' | 'delivered' | 'failed' | 'dead';

export interface DeliveryRecord {
  clientId: string;
  state: DeliveryState;
  /** 连续失败数 */
  consecutiveFailures: number;
  /** 最后成功时间 (ms) */
  lastDeliveredAt?: number;
  /** 最后失败时间 + 错误摘要 */
  lastFailedAt?: number;
  lastError?: string;
  /** 标记为 dead 的时间 */
  deadAt?: number;
  createdAt: number;
}

export interface LedgerStats {
  total: number;
  delivered: number;
  failed: number;
  dead: number;
  attempting: number;
}

/** 同类错误节流窗口 (ms): 窗口内同 (类别, 错误前缀) 只 warn 一次 */
export const WARN_THROTTLE_WINDOW_MS = 5 * 60 * 1000;

export class DeliveryLedger {
  private records = new Map<string, DeliveryRecord>();
  private lastWarn = new Map<string, number>();

  /** 注册客户端 (obligation) — 初始 pending (Hermes record_obligation) */
  register(clientId: string): DeliveryRecord {
    const existing = this.records.get(clientId);
    if (existing) return existing;
    const rec: DeliveryRecord = { clientId, state: 'pending', consecutiveFailures: 0, createdAt: Date.now() };
    this.records.set(clientId, rec);
    return rec;
  }

  /** 发送前标记 attempting (Hermes mark_attempting) */
  markAttempting(clientId: string): void {
    const rec = this.register(clientId);
    rec.state = 'attempting';
  }

  /** 发送成功 (Hermes mark_delivered) */
  markDelivered(clientId: string): void {
    const rec = this.register(clientId);
    rec.state = 'delivered';
    rec.consecutiveFailures = 0;
    rec.lastDeliveredAt = Date.now();
  }

  /**
   * 发送失败 (Hermes mark_failed). 同类错误节流: 窗口内同 (state, errorPrefix) 返回 false 表示
   * 该 warn 已被节流 — 调用方只对 true 输出日志.
   * @returns 是否应输出警告 (true = 新教训, 值得 warn)
   */
  markFailed(clientId: string, error: unknown): boolean {
    const rec = this.register(clientId);
    rec.state = 'failed';
    rec.consecutiveFailures++;
    rec.lastFailedAt = Date.now();
    rec.lastError = String((error as any)?.message || error || '').slice(0, 120);
    return this.shouldWarn('delivery-fail', rec.lastError);
  }

  /** 同类错误节流 (Hermes channel_directory warn-once-per-window) */
  shouldWarn(category: string, detail: string): boolean {
    const key = `${category}:${detail.slice(0, 60)}`;
    const now = Date.now();
    const last = this.lastWarn.get(key) ?? 0;
    if (now - last < WARN_THROTTLE_WINDOW_MS) return false;
    this.lastWarn.set(key, now);
    return true;
  }

  /** 客户端判定死亡 (最后一次活动超时) — 标记 dead, 可回收 (Hermes sweep_recoverable 语义) */
  sweepDead(idleTimeoutMs: number): string[] {
    const now = Date.now();
    const dead: string[] = [];
    for (const [id, rec] of this.records) {
      if (rec.state === 'dead') continue;
      const lastActivity = Math.max(rec.lastDeliveredAt ?? 0, rec.lastFailedAt ?? 0, rec.createdAt);
      if (now - lastActivity > idleTimeoutMs) {
        rec.state = 'dead';
        rec.deadAt = now;
        dead.push(id);
      }
    }
    return dead;
  }

  /** 移除记录 (客户端断开) */
  remove(clientId: string): void {
    this.records.delete(clientId);
  }

  stats(): LedgerStats {
    let delivered = 0, failed = 0, dead = 0, attempting = 0;
    for (const r of this.records.values()) {
      if (r.state === 'delivered') delivered++;
      else if (r.state === 'failed') failed++;
      else if (r.state === 'dead') dead++;
      else if (r.state === 'attempting') attempting++;
    }
    return { total: this.records.size, delivered, failed, dead, attempting };
  }

  get(clientId: string): DeliveryRecord | undefined {
    return this.records.get(clientId);
  }

  clear(): void {
    this.records.clear();
    this.lastWarn.clear();
  }
}
