/**
 * Bolloon 24h Heartbeat Module
 * 24 小时稳定运行心跳闭环
 */

export * from './types.js';
export * from './HealthMonitor.js';
export * from './Watchdog.js';
export * from './DaemonManager.js';
export * from './StartupVerifier.js';
export * from './self-improve-bus.js';

import { createHealthMonitor, getHealthMonitor } from './HealthMonitor.js';
import { createWatchdog, getWatchdog } from './Watchdog.js';
import { createDaemonManager, getDaemonManager } from './DaemonManager.js';
import { StartupVerifier, runStartupVerification, getStartupVerifier } from './StartupVerifier.js';
import type { HealthStatus } from './types.js';

/**
 * 初始化完整的 24h 心跳系统
 */
export async function initialize24hHeartbeat(): Promise<{
  healthMonitor: ReturnType<typeof createHealthMonitor>;
  watchdog: ReturnType<typeof createWatchdog>;
  daemonManager: ReturnType<typeof createDaemonManager>;
  startupVerifier: StartupVerifier;
}> {
  // 1. 启动自检
  const startupReport = await runStartupVerification();
  if (!startupReport.success) {
    console.warn('[24h] Startup verification failed, continuing anyway...');
  }

  // 2. 初始化健康监控
  const healthMonitor = createHealthMonitor({
    onStatusChange: (status: HealthStatus) => {
      if (status.status !== 'healthy') {
        console.warn(`[24h] Health status: ${status.status}`);
        for (const rec of status.recommendations || []) {
          console.warn(`[24h]   → ${rec}`);
        }
      }
    }
  });

  // 3. 初始化看门狗
  const watchdog = createWatchdog(
    { silentThresholdMs: 300000, maxConsecutiveFailures: 3, checkIntervalMs: 30000 },
    {
      onLog: (msg) => console.log(`[24h-Watchdog] ${msg}`),
      onHealthCheckFailed: (failures) => console.warn(`[24h] Health check failures: ${failures}`),
      onRestart: (level, reason) => {
        console.error(`[24h] Restart triggered (level ${level}): ${reason}`);
      }
    }
  );

  // 4. 连接健康监控和看门狗
  healthMonitor.startPeriodicCheck(60000, (status) => {
    const hasError = Object.values(status.checks).some(c => c.status === 'error');
    watchdog.reportHealthCheck(!hasError, status.status);
  });

  // 5. 初始化守护进程管理器
  const daemonManager = createDaemonManager({
    maxRestarts: 5,
    restartDelayMs: 5000
  });

  // 6. 注册看门狗重启策略
  watchdog.registerRestartStrategy(1 as const, () => {
    console.log('[24h] Level 1 restart: Graceful restart...');
    // 可以添加进程重启逻辑
  });

  watchdog.registerRestartStrategy(2 as const, () => {
    console.log('[24h] Level 2 restart: Process restart...');
    // 可以添加进程重启逻辑
  });

  watchdog.registerRestartStrategy(3 as const, () => {
    console.log('[24h] Level 3 restart: System notification...');
    // 可以发送通知
  });

  // 7. 启动看门狗
  watchdog.start();

  console.log('[24h] 24h heartbeat system initialized');
  console.log(`[24h] Health checks: every 60s`);
  console.log(`[24h] Watchdog checks: every 30s`);
  console.log(`[24h] Max restarts: 5`);

  return { healthMonitor, watchdog, daemonManager, startupVerifier: getStartupVerifier() };
}

/**
 * 获取健康状态 JSON
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const healthMonitor = getHealthMonitor();
  return healthMonitor.check();
}

// Re-export singleton getters for convenience
export { getHealthMonitor, createHealthMonitor };
export { getWatchdog, createWatchdog };
export { getDaemonManager, createDaemonManager };
export { getStartupVerifier };