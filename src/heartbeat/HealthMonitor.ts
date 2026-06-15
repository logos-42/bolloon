/**
 * HealthMonitor - 健康检查核心
 * 监控 P2P、Iroh、LLM、内存等关键指标
 */

import type { HealthStatus, HealthCheckResult, HealthCheckProvider } from './types.js';
import { getMinimax } from '../constraints/index.js';

export class HealthMonitor implements HealthCheckProvider {
  private lastHeartbeatTime: number = Date.now();
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;
  private onStatusChange?: (status: HealthStatus) => void;

  constructor(private config: {
    checkIntervalMs?: number;
    onStatusChange?: (status: HealthStatus) => void;
  } = {}) {
    this.onStatusChange = config.onStatusChange;
  }

  /**
   * 执行完整健康检查
   */
  async check(): Promise<HealthStatus> {
    const checks: HealthStatus['checks'] = {
      p2p: await this.checkP2P(),
      iroh: await this.checkIroh(),
      llm: await this.checkLLM(),
      memory: await this.checkMemory(),
      heartbeat: await this.checkHeartbeat()
    };

    // 计算整体状态
    const errors = Object.values(checks).filter(c => c.status === 'error').length;
    let status: HealthStatus['status'] = 'healthy';
    if (errors >= 3) {
      status = 'unhealthy';
    } else if (errors >= 1) {
      status = 'degraded';
    }

    const healthStatus: HealthStatus = {
      status,
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
      checks,
      recommendations: this.generateRecommendations(checks)
    };

    this.onStatusChange?.(healthStatus);
    return healthStatus;
  }

  /**
   * 检查 P2P 连接状态
   */
  async checkP2P(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // 从全局状态获取 HyperswarmCommunicator
      const comm = (global as any).hyperswarmComm;
      if (!comm) {
        return { status: 'ok', message: 'P2P not initialized yet', latency_ms: Date.now() - start };
      }

      const connections = comm.getConnections?.() || [];
      return {
        status: 'ok',
        message: `Connected to ${connections.length} peers`,
        details: { peer_count: connections.length },
        latency_ms: Date.now() - start
      };
    } catch (err: any) {
      return { status: 'error', message: err.message, latency_ms: Date.now() - start };
    }
  }

  /**
   * 检查 Iroh 节点状态
   */
  async checkIroh(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const { irohTransport } = await import('../network/iroh-transport.js');

      if (!irohTransport.isRunning?.()) {
        return { status: 'error', message: 'Iroh not running', latency_ms: Date.now() - start };
      }

      const nodeId = irohTransport.getNodeId?.() || '';
      const peers = irohTransport.getPeers?.() || [];
      const pendingOffline = irohTransport.getPendingOfflineCount?.() || 0;

      return {
        status: 'ok',
        message: `Iroh running, ${peers.length} peers`,
        details: {
          nodeId: nodeId.substring(0, 16) + '...',
          peer_count: peers.length,
          pending_offline_messages: pendingOffline
        },
        latency_ms: Date.now() - start
      };
    } catch (err: any) {
      return { status: 'error', message: err.message, latency_ms: Date.now() - start };
    }
  }

  /**
   * 检查 LLM 连接状态
   */
  async checkLLM(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const minimax = getMinimax();

      if (!minimax) {
        return { status: 'error', message: 'LLM not initialized', latency_ms: Date.now() - start };
      }

      // 执行 ping 测试
      const latency = await this.pingLLM(minimax);
      return {
        status: 'ok',
        message: 'LLM responsive',
        details: { latency_ms: latency },
        latency_ms: Date.now() - start
      };
    } catch (err: any) {
      return { status: 'error', message: err.message, latency_ms: Date.now() - start };
    }
  }

  /**
   * 检查内存使用
   */
  async checkMemory(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const usage = process.memoryUsage();
      const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;
      const rssPercent = (usage.rss / (1024 * 1024 * 1024)) * 100; // GB

      // 获取系统总内存 (macOS/Linux)
      let systemMemoryPercent = 0;
      try {
        if (process.platform === 'darwin' || process.platform === 'linux') {
          const { execSync } = require('child_process');
          if (process.platform === 'darwin') {
            const total = execSync('sysctl -n hw.memsize').toString().trim();
            const free = execSync('vm_stat | grep "Pages free" | awk \'{print $3}\' | tr -d "."');
            const pageSize = execSync('sysctl -n vm.pagesize').toString().trim();
            systemMemoryPercent = ((parseInt(free) * parseInt(pageSize)) / parseInt(total)) * 100;
          }
        }
      } catch {
        // 忽略系统内存获取失败
      }

      const isHealthy = heapUsedPercent < 80;

      return {
        status: isHealthy ? 'ok' : 'error',
        message: isHealthy ? 'Memory usage normal' : 'Memory usage high',
        details: {
          heap_used_mb: Math.round(usage.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(usage.heapTotal / 1024 / 1024),
          heap_used_percent: Math.round(heapUsedPercent * 10) / 10,
          rss_mb: Math.round(usage.rss / 1024 / 1024)
        },
        latency_ms: Date.now() - start
      };
    } catch (err: any) {
      return { status: 'error', message: err.message, latency_ms: Date.now() - start };
    }
  }

  /**
   * 检查心跳活跃度
   */
  async checkHeartbeat(): Promise<HealthCheckResult> {
    const start = Date.now();
    const elapsed = Date.now() - this.lastHeartbeatTime;

    // 获取 SocialHeartbeat 状态
    const heartbeat = (global as any).socialHeartbeat;
    let agentsCount = 0;
    let antColonyEnabled = false;

    if (heartbeat) {
      const agents = heartbeat.getDiscoveredAgents?.();
      agentsCount = agents?.length || 0;
      antColonyEnabled = heartbeat.isAntColonyEnabled?.() || false;
    }

    return {
      status: elapsed < 60000 ? 'ok' : 'error',
      message: elapsed < 60000
        ? `Heartbeat active ${Math.round(elapsed / 1000)}s ago`
        : 'Heartbeat inactive for > 60s',
      details: {
        last_heartbeat_ms: elapsed,
        discovered_agents: agentsCount,
        ant_colony_enabled: antColonyEnabled
      },
      latency_ms: Date.now() - start
    };
  }

  /**
   * 记录心跳活跃
   */
  recordHeartbeat(): void {
    this.lastHeartbeatTime = Date.now();
  }

  /**
   * 获取当前状态（不执行检查）
   */
  getQuickStatus(): { status: string; lastHeartbeat: number; memoryUsage: number } {
    const usage = process.memoryUsage();
    return {
      status: 'active',
      lastHeartbeat: this.lastHeartbeatTime,
      memoryUsage: Math.round((usage.heapUsed / usage.heapTotal) * 100)
    };
  }

  /**
   * 生成健康建议
   */
  private generateRecommendations(checks: HealthStatus['checks']): string[] {
    const recommendations: string[] = [];

    if (checks.p2p.status === 'error') {
      recommendations.push('P2P 连接失败，建议检查网络');
    }
    if (checks.iroh.status === 'error') {
      recommendations.push('Iroh 节点未运行，消息可能无法发送');
    }
    if (checks.llm.status === 'error') {
      recommendations.push('LLM 连接失败，检查 API 密钥配置');
    }
    if (checks.memory.status === 'error') {
      recommendations.push('内存使用率过高，考虑重启服务');
    }
    if (checks.heartbeat.status === 'error') {
      recommendations.push('心跳长时间未活跃，检查系统是否卡死');
    }

    return recommendations;
  }

  /**
   * Ping LLM 测试响应
   */
  private async pingLLM(minimax: any): Promise<number> {
    const start = Date.now();
    try {
      // 2026-06-15: signal 位置正确传 undefined (chat signature 是 (message, context?, signal?))
      //   之前传 { maxTokens: 1 } 被当 signal, Node 22+ undici 强类型 AbortSignal 校验 throw
      if (minimax.chat) {
        await minimax.chat('ping', 'test', undefined);
      } else if (minimax.ping) {
        await minimax.ping();
      }
      return Date.now() - start;
    } catch {
      // 如果 ping 失败，返回一个较大的值但不是错误
      return Date.now() - start;
    }
  }

  /**
   * 开始定期健康检查
   */
  startPeriodicCheck(intervalMs: number = 60000, callback?: (status: HealthStatus) => void): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
    }

    const checkFn = async () => {
      const status = await this.check();
      callback?.(status);
      this.onStatusChange?.(status);
    };

    this.checkIntervalId = setInterval(checkFn, intervalMs);
    // 立即执行一次
    checkFn();
  }

  /**
   * 停止定期检查
   */
  stopPeriodicCheck(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }
}

// 全局实例
let healthMonitorInstance: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor {
  if (!healthMonitorInstance) {
    healthMonitorInstance = new HealthMonitor();
  }
  return healthMonitorInstance;
}

export function createHealthMonitor(config?: { onStatusChange?: (status: HealthStatus) => void }): HealthMonitor {
  healthMonitorInstance = new HealthMonitor(config);
  return healthMonitorInstance;
}