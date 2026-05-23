/**
 * AdaptiveHeartbeat - 动态心跳策略
 *
 * 基于活跃度、信息素密度等因子动态调整心跳间隔
 */

import {
  HeartbeatDecision,
  AdaptiveHeartbeatConfig,
  DEFAULT_ADAPTIVE_CONFIG,
} from './types.js';

export class AdaptiveHeartbeat {
  private config: AdaptiveHeartbeatConfig;
  private lastActivityTime: number = Date.now();
  private activityHistory: number[] = [];
  private recentDiscoveries: number = 0;
  private pheromoneDensity: number = 0;
  private discoveryBoost: number = 0;
  private activityTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<AdaptiveHeartbeatConfig>) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.startActivityTracking();
  }

  /**
   * 获取下一次心跳的决策
   */
  decide(): HeartbeatDecision {
    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivityTime;

    const activityRate = this.calculateActivityRate();
    const pheromoneFactor = this.pheromoneDensity;
    const discoveryFactor = this.calculateDiscoveryFactor();

    const combinedFactor =
      activityRate * 0.2 +
      pheromoneFactor * this.config.pheromoneBoostFactor +
      discoveryFactor * this.config.discoveryBoostFactor;

    const interval = Math.max(
      this.config.minInterval,
      Math.min(
        this.config.maxInterval,
        this.config.baseInterval * (1 - combinedFactor * 0.7)
      )
    );

    let priority: HeartbeatDecision['priorityLevel'] = 'normal';
    if (discoveryFactor > 0.5 || this.discoveryBoost > 0.6) {
      priority = 'high';
    } else if (this.discoveryBoost > 0.8) {
      priority = 'urgent';
    } else if (activityRate < this.config.lowActivityThreshold) {
      priority = 'low';
    }

    return {
      interval: Math.round(interval),
      shouldExplore: discoveryFactor > 0.3 || pheromoneFactor > 0.5,
      shouldBroadcast: priority !== 'low' || timeSinceLastActivity > this.config.baseInterval,
      priorityLevel: priority,
    };
  }

  /**
   * 记录活跃事件
   */
  recordActivity(type: 'message' | 'discovery' | 'channel'): void {
    const now = Date.now();
    this.lastActivityTime = now;
    this.activityHistory.push(now);

    if (type === 'discovery') {
      this.recentDiscoveries++;
      this.discoveryBoost = Math.min(1, this.discoveryBoost + 0.2);
    }

    this.discoveryBoost = Math.max(0, this.discoveryBoost - 0.05);
  }

  /**
   * 设置信息素密度
   */
  setPheromoneDensity(density: number): void {
    this.pheromoneDensity = Math.max(0, Math.min(1, density));
  }

  /**
   * 获取当前配置
   */
  getConfig(): AdaptiveHeartbeatConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<AdaptiveHeartbeatConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  private calculateActivityRate(): number {
    const now = Date.now();
    const recentActivity = this.activityHistory.filter(
      (t) => now - t < 60000
    ).length;
    return recentActivity / 60;
  }

  private calculateDiscoveryFactor(): number {
    return Math.min(1, this.recentDiscoveries / 5);
  }

  private startActivityTracking(): void {
    this.activityTimer = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      this.activityHistory = this.activityHistory.filter((t) => t > cutoff);
      this.recentDiscoveries = Math.max(0, this.recentDiscoveries - 1);
      this.discoveryBoost = Math.max(0, this.discoveryBoost - 0.1);
    }, 60000);
  }

  shutdown(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
    }
  }
}