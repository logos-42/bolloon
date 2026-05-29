/**
 * Bolloon 24h Heartbeat Types
 * 健康检查、看门狗、守护进程的类型定义
 */

export interface HealthCheckResult {
  status: 'ok' | 'error';
  message?: string;
  details?: Record<string, unknown>;
  latency_ms?: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime_seconds: number;
  checks: {
    p2p: HealthCheckResult;
    iroh: HealthCheckResult;
    llm: HealthCheckResult;
    memory: HealthCheckResult;
    heartbeat: HealthCheckResult;
  };
  recommendations?: string[];
}

export interface WatchdogConfig {
  /** 无日志时间阈值 (ms) */
  silentThresholdMs: number;
  /** 健康检查失败阈值 */
  maxConsecutiveFailures: number;
  /** 检查间隔 (ms) */
  checkIntervalMs: number;
}

export interface WatchdogState {
  lastActivityTime: number;
  consecutiveFailures: number;
  isTriggered: boolean;
  triggerReason?: string;
}

export interface DaemonConfig {
  /** 最大重启次数 */
  maxRestarts: number;
  /** 重启延迟 (ms) */
  restartDelayMs: number;
  /** 日志文件路径 */
  logFile?: string;
  /** PID 文件路径 */
  pidFile?: string;
}

export interface StartupCheck {
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  message?: string;
  duration_ms?: number;
  startTime?: number;
}

export interface StartupReport {
  success: boolean;
  checks: StartupCheck[];
  total_duration_ms: number;
  critical_failures: string[];
}

export type RestartLevel = 1 | 2 | 3;

export interface RestartStrategy {
  level: RestartLevel;
  action: () => void | Promise<void>;
  reason: string;
}

export interface HealthCheckProvider {
  checkP2P(): Promise<HealthCheckResult>;
  checkIroh(): Promise<HealthCheckResult>;
  checkLLM(): Promise<HealthCheckResult>;
  checkMemory(): Promise<HealthCheckResult>;
}