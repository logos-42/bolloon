/**
 * Watchdog - 看门狗机制
 * 检测进程卡死、无响应等情况
 */

import type { WatchdogConfig, WatchdogState, RestartStrategy, RestartLevel } from './types.js';

export interface WatchdogCallbacks {
  onRestart?: (level: RestartLevel, reason: string) => void;
  onLog?: (message: string) => void;
  onHealthCheckFailed?: (failures: number) => void;
}

export class Watchdog {
  private config: Required<WatchdogConfig>;
  private state: WatchdogState;
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;
  private restartStrategies: Map<RestartLevel, () => void | Promise<void>> = new Map();
  private restartCount: number = 0;
  private callbacks: WatchdogCallbacks;

  constructor(config: Partial<WatchdogConfig> = {}, callbacks: WatchdogCallbacks = {}) {
    this.config = {
      silentThresholdMs: config.silentThresholdMs || 300000, // 5 分钟无日志
      maxConsecutiveFailures: config.maxConsecutiveFailures || 3,
      checkIntervalMs: config.checkIntervalMs || 30000 // 30 秒检查一次
    };
    this.state = {
      lastActivityTime: Date.now(),
      consecutiveFailures: 0,
      isTriggered: false
    };
    this.callbacks = callbacks;
  }

  /**
   * 注册重启策略
   */
  registerRestartStrategy(level: RestartLevel, action: () => void | Promise<void>): void {
    this.restartStrategies.set(level, action);
  }

  /**
   * 记录活动（调用后更新 lastActivityTime）
   */
  recordActivity(component?: string): void {
    this.state.lastActivityTime = Date.now();
    if (component) {
      this.callbacks.onLog?.(`[Watchdog] Activity from ${component}`);
    }
  }

  /**
   * 记录日志（同时触发活动检测）
   */
  log(message: string): void {
    this.recordActivity();
    console.log(`[Watchdog] ${message}`);
    this.callbacks.onLog?.(message);
  }

  /**
   * 开始看门狗监控
   */
  start(): void {
    if (this.checkIntervalId) return;

    console.log(`[Watchdog] Started - silent threshold: ${this.config.silentThresholdMs}ms, check interval: ${this.config.checkIntervalMs}ms`);

    this.checkIntervalId = setInterval(() => {
      this.check();
    }, this.config.checkIntervalMs);
  }

  /**
   * 停止看门狗
   */
  stop(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    console.log('[Watchdog] Stopped');
  }

  /**
   * 报告健康检查结果
   */
  reportHealthCheck(success: boolean, details?: string): void {
    if (success) {
      this.state.consecutiveFailures = 0;
      this.recordActivity('health_check');
    } else {
      this.state.consecutiveFailures++;
      console.log(`[Watchdog] Health check failed (${this.state.consecutiveFailures}/${this.config.maxConsecutiveFailures}): ${details || 'unknown'}`);
      this.callbacks.onHealthCheckFailed?.(this.state.consecutiveFailures);

      if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        this.triggerRestart(1, `Health check failed ${this.state.consecutiveFailures} times`);
      }
    }
  }

  /**
   * 获取当前状态
   */
  getState(): WatchdogState & { uptime_ms: number; restartCount: number } {
    return {
      ...this.state,
      uptime_ms: Date.now() - this.state.lastActivityTime,
      restartCount: this.restartCount
    };
  }

  /**
   * 执行检查
   */
  private check(): void {
    const now = Date.now();
    const silentTime = now - this.state.lastActivityTime;

    // 检查是否沉默太久
    if (silentTime > this.config.silentThresholdMs) {
      console.warn(`[Watchdog] No activity for ${Math.round(silentTime / 1000)}s`);
      this.triggerRestart(1, `No activity for ${Math.round(silentTime / 1000)}s`);
      return;
    }

    // 检查内存使用
    const usage = process.memoryUsage();
    const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;
    if (heapUsedPercent > 90) {
      console.warn(`[Watchdog] Memory usage critical: ${heapUsedPercent.toFixed(1)}%`);
      this.triggerRestart(1, `Memory usage ${heapUsedPercent.toFixed(1)}%`);
    }
  }

  /**
   * 触发重启
   */
  private triggerRestart(level: RestartLevel, reason: string): void {
    if (this.state.isTriggered) {
      console.log(`[Watchdog] Already triggered, ignoring restart request: ${reason}`);
      return;
    }

    this.state.isTriggered = true;
    this.state.triggerReason = reason;
    this.restartCount++;

    console.error(`[Watchdog] 🔴 TRIGGERED: ${reason} (restart #${this.restartCount})`);

    const strategy = this.restartStrategies.get(level);
    if (strategy) {
      try {
        this.callbacks.onRestart?.(level, reason);
        const result = strategy();
        if (result instanceof Promise) {
          result.catch(err => {
            console.error('[Watchdog] Restart action failed:', err);
          });
        }
      } catch (err) {
        console.error('[Watchdog] Failed to execute restart strategy:', err);
      }
    } else {
      console.warn(`[Watchdog] No restart strategy registered for level ${level}`);
      this.callbacks.onRestart?.(level, reason);
    }
  }

  /**
   * 重置触发状态（允许再次触发）
   */
  reset(): void {
    this.state.isTriggered = false;
    this.state.triggerReason = undefined;
    this.state.lastActivityTime = Date.now();
  }
}

// 全局实例
let watchdogInstance: Watchdog | null = null;

export function getWatchdog(): Watchdog {
  if (!watchdogInstance) {
    watchdogInstance = new Watchdog();
  }
  return watchdogInstance;
}

export function createWatchdog(
  config?: Partial<WatchdogConfig>,
  callbacks?: WatchdogCallbacks
): Watchdog {
  watchdogInstance = new Watchdog(config, callbacks);
  return watchdogInstance;
}