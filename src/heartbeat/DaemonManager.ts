/**
 * DaemonManager - 守护进程管理器
 * 支持自动重启、日志轮转、PID 管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { DaemonConfig } from './types.js';

export interface DaemonState {
  pid: number;
  startedAt: number;
  restartCount: number;
  lastRestartAt?: number;
  lastError?: string;
}

export class DaemonManager {
  private config: Required<DaemonConfig>;
  private state: DaemonState | null = null;
  private stopRequested: boolean = false;
  private isChildProcess: boolean = false;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = {
      maxRestarts: config.maxRestarts || 5,
      restartDelayMs: config.restartDelayMs || 5000,
      logFile: config.logFile || path.join(process.env.HOME || '/tmp', '.bolloon', 'daemon.log'),
      pidFile: config.pidFile || path.join(process.env.HOME || '/tmp', '.bolloon', 'daemon.pid')
    };
    this.isChildProcess = process.env.BOLLOON_DAEMON_CHILD === '1';
  }

  /**
   * 获取当前守护进程状态
   */
  async getState(): Promise<DaemonState | null> {
    try {
      const pidData = await fs.readFile(this.config.pidFile, 'utf-8');
      const pid = parseInt(pidData.trim(), 10);

      if (isNaN(pid)) return null;

      // 检查进程是否仍在运行
      try {
        process.kill(pid, 0); // Signal 0 只是检查进程是否存在
        return { ...this.state!, pid };
      } catch {
        // 进程不存在
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * 检查是否已有守护进程在运行
   */
  async isRunning(): Promise<boolean> {
    const state = await this.getState();
    return state !== null;
  }

  /**
   * 保存 PID 文件
   */
  private async savePid(): Promise<void> {
    await fs.mkdir(path.dirname(this.config.pidFile), { recursive: true });
    await fs.writeFile(this.config.pidFile, String(process.pid));
    console.log(`[Daemon] PID saved: ${process.pid}`);
  }

  /**
   * 删除 PID 文件
   */
  async clearPid(): Promise<void> {
    try {
      await fs.unlink(this.config.pidFile);
    } catch {
      // 忽略删除失败
    }
  }

  /**
   * 写入日志
   */
  private async writeLog(message: string): Promise<void> {
    if (!this.config.logFile) return;

    try {
      await fs.mkdir(path.dirname(this.config.logFile), { recursive: true });
      const timestamp = new Date().toISOString();
      await fs.appendFile(this.config.logFile, `[${timestamp}] ${message}\n`);
    } catch {
      // 忽略日志写入失败
    }
  }

  /**
   * 启动主进程（父进程调用）
   */
  async spawn(processArgv: string[] = process.argv): Promise<void> {
    // 检查是否已在运行
    if (await this.isRunning()) {
      console.log('[Daemon] Already running, pid:', (await this.getState())?.pid);
      return;
    }

    this.state = {
      pid: process.pid,
      startedAt: Date.now(),
      restartCount: 0
    };

    await this.savePid();
    await this.writeLog('Daemon started');

    // 设置优雅退出
    this.setupGracefulShutdown();

    // 注册信号处理
    this.setupSignalHandlers();

    console.log('[Daemon] Manager initialized');
  }

  /**
   * 启动子进程并管理其生命周期
   */
  async runWithAutoRestart(childArgs: string[]): Promise<void> {
    if (!this.isChildProcess) {
      // 父进程：启动子进程
      await this.runChildProcess(childArgs);
      return;
    }

    // 子进程：正常运行主程序
    console.log('[Daemon] Running as child process');
  }

  /**
   * 启动子进程
   */
  private async runChildProcess(childArgs: string[]): Promise<void> {
    const { spawn } = await import('child_process');
    let consecutiveFailures = 0;

    while (!this.stopRequested && consecutiveFailures < this.config.maxRestarts) {
      console.log(`[Daemon] Spawning child process (attempt ${consecutiveFailures + 1}/${this.config.maxRestarts})`);

      const child = spawn(process.execPath, childArgs, {
        stdio: 'inherit',
        env: { ...process.env, BOLLOON_DAEMON_CHILD: '1' }
      });

      child.on('exit', async (code, signal) => {
        const reason = signal || `exit code ${code}`;
        console.log(`[Daemon] Child exited: ${reason}`);

        if (this.stopRequested) {
          console.log('[Daemon] Stop requested, not restarting');
          await this.clearPid();
          process.exit(0);
        }

        consecutiveFailures++;
        this.state = {
          ...this.state!,
          restartCount: consecutiveFailures,
          lastRestartAt: Date.now(),
          lastError: reason
        };

        if (consecutiveFailures < this.config.maxRestarts) {
          console.log(`[Daemon] Restarting in ${this.config.restartDelayMs}ms...`);
          await this.writeLog(`Child exited ${reason}, restarting (${consecutiveFailures}/${this.config.maxRestarts})`);

          await new Promise(resolve => setTimeout(resolve, this.config.restartDelayMs));
          // 继续 while 循环，重启子进程
        } else {
          console.error('[Daemon] Max restarts reached, giving up');
          await this.writeLog(`Max restarts reached (${this.config.maxRestarts})`);
          await this.clearPid();
          process.exit(1);
        }
      });

      child.on('error', async (err) => {
        console.error('[Daemon] Child process error:', err.message);
        await this.writeLog(`Child error: ${err.message}`);
      });

      // 等待子进程退出
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });
    }
  }

  /**
   * 设置优雅退出
   */
  private setupGracefulShutdown(): void {
    let isShuttingDown = false;

    const shutdown = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      console.log('[Daemon] Graceful shutdown...');
      await this.writeLog('Graceful shutdown');
      this.stopRequested = true;

      await this.clearPid();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('uncaughtException', async (err) => {
      console.error('[Daemon] Uncaught exception:', err);
      await this.writeLog(`Uncaught exception: ${err.message}`);
      await shutdown();
    });
  }

  /**
   * 设置信号处理
   */
  private setupSignalHandlers(): void {
    process.on('SIGHUP', () => {
      console.log('[Daemon] Received SIGHUP, reloading...');
      // 可以实现配置重载逻辑
    });
  }

  /**
   * 请求停止守护进程
   */
  async stop(): Promise<void> {
    const state = await this.getState();
    if (state) {
      console.log(`[Daemon] Sending SIGTERM to pid ${state.pid}`);
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        console.log('[Daemon] Process not found, clearing PID');
      }
    }
    await this.clearPid();
    this.stopRequested = true;
  }

  /**
   * 获取重启次数
   */
  async getRestartCount(): Promise<number> {
    return this.state?.restartCount || 0;
  }

  /**
   * 检查是否可以继续重启
   */
  canRestart(): boolean {
    return (this.state?.restartCount || 0) < this.config.maxRestarts;
  }
}

// 全局实例
let daemonManagerInstance: DaemonManager | null = null;

export function getDaemonManager(): DaemonManager {
  if (!daemonManagerInstance) {
    daemonManagerInstance = new DaemonManager();
  }
  return daemonManagerInstance;
}

export function createDaemonManager(config?: Partial<DaemonConfig>): DaemonManager {
  daemonManagerInstance = new DaemonManager(config);
  return daemonManagerInstance;
}