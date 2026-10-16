/**
 * ha-supervisor.ts — 主进程侧 HA 守护管理器 (2026-10-16, leo: 双内核冗余 — 独立 kernel 守护进程)
 *
 * 主进程 (createWebServer / CLI) 侧:
 *   ① 自己以 **primary** 角色写心跳 (含当前活跃 runIds)
 *   ② spawn 独立 kernel 守护进程 (src/agents/ha-daemon.ts, 以 standby 角色跑)
 *   ③ 监控 daemon 存活: 心跳过期 / 进程退出 → **自动重启 + 接管** (重启后它自己会 reconcileOrphans + prepareResume)
 *   ④ daemon 启动即探测主进程: 主死 → daemon 接管 (反向故障转移)
 *
 * 依赖注入 (业务侧端口):
 *   - primary 心跳的 runIds 来源: collectActiveRunIds (runs 目录扫描)
 *   - 全端口注入 → 可单测 (注入假 DAEMON_TS 路径 / 假 child_process)
 */
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startHaGuard, makeHeartbeat, type HaGuardPorts } from '../kernel/ha/ha-guard.js';
import { writeHeartbeat, collectActiveRunIds, STALE_MS, BEAT_MS } from '../kernel/ha/ha-arbiter.js';
import * as fs from 'fs';

export interface HaSupervisorOptions {
  home?: string;
  /** 守护进程入口 (测试注入假脚本) */
  daemonEntry?: string;
  /** 守护进程的 node 可执行 (测试注入) */
  nodeBin?: string;
  beatMs?: number;
  staleMs?: number;
  /** 守护进程异常退出后自动重启 (默认 true) */
  autoRestart?: boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 测试注入: 替代 spawn (便于验证重启逻辑而不真起进程) */
  spawnImpl?: (cmd: string, args: string[], opts: any) => any;
}

export interface HaSupervisorState {
  primaryStarted: boolean;
  daemonPid: number | null;
  daemonAlive: boolean;
  restarts: number;
  daemonExitCode: number | null;
}

const noop = () => {};

function defaultSpawn(cmd: string, args: string[], opts: any): ChildProcess {
  return spawn(cmd, args, opts) as ChildProcess;
}

export class HaSupervisor {
  private opts: HaSupervisorOptions;
  private guard: ReturnType<typeof startHaGuard> | null = null;
  private daemon: ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private state: HaSupervisorState = {
    primaryStarted: false,
    daemonPid: null,
    daemonAlive: false,
    restarts: 0,
    daemonExitCode: null,
  };
  private stopped = false;

  constructor(opts: HaSupervisorOptions = {}) {
    this.opts = opts;
  }

  getState(): HaSupervisorState { return { ...this.state }; }

  /** 启动: primary 心跳 + spawn daemon + 监控重启 */
  async start(): Promise<void> {
    const home = this.opts.home || os.homedir();
    const beatMs = this.opts.beatMs ?? BEAT_MS;
    const staleMs = this.opts.staleMs ?? STALE_MS;
    const log = this.opts.log || noop;

    // ① primary 心跳 (主进程自己; runIds 从 runs 目录收集)
    const ports: HaGuardPorts = {
      reconcileOrphans: async () => ({ interrupted: [], stillRunning: [], failed: [] }),
      prepareResume: async () => ({ ok: false, reason: 'primary 不接管 (它是主)' }),
      collectActiveRunIds: async () => collectActiveRunIds(path.join(home, '.bolloon', 'runs')),
      log: (l, m) => log(l as any, `[ha:primary] ${m}`),
    };
    this.guard = startHaGuard(ports, {
      role: 'primary',
      home,
      kernelVersion: process.env.npm_package_version || '',
      beatMs,
      staleMs,
    });
    this.state.primaryStarted = true;
    log('info', `[ha] primary 心跳已启动 (home=${home}, beat=${beatMs}ms, stale=${staleMs}ms)`);

    // ② spawn 独立 kernel 守护进程 (standby)
    this.spawnDaemon();

    // ③ 监控 daemon: 退出 → 自动重启 (kernel 死则重启 + 它接管)
    //    监控交给 child 'exit' 事件 (已在 spawnDaemon 里挂), 无需额外轮询。
  }

  private spawnDaemon(): void {
    if (this.stopped) return;
    const log = this.opts.log || noop;
    const home = this.opts.home || os.homedir();
    const nodeBin = this.opts.nodeBin || process.execPath;
    const entry = this.opts.daemonEntry || path.join(__dirname, 'ha-daemon.js');
    const spawnImpl = this.opts.spawnImpl || defaultSpawn;

    log('info', `[ha] spawn kernel 守护进程: ${nodeBin} ${entry} (role=standby)`);
    try {
      const child = spawnImpl(nodeBin, [entry], {
        env: {
          ...process.env,
          BOLLOON_HOME: home,
          BOLLOON_HA_BEAT_MS: String(this.opts.beatMs ?? BEAT_MS),
          BOLLOON_HA_STALE_MS: String(this.opts.staleMs ?? STALE_MS),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      this.daemon = child;
      this.state.daemonPid = child.pid ?? null;
      this.state.daemonAlive = true;

      child.stdout?.on('data', (d: Buffer) => {
        const s = String(d).trim();
        if (s) log('info', `[ha:daemon] ${s}`);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = String(d).trim();
        if (s) log('warn', `[ha:daemon:err] ${s}`);
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        this.state.daemonAlive = false;
        this.state.daemonExitCode = code;
        log('warn', `[ha] kernel 守护进程退出 code=${code} signal=${signal || ''}`);
        if (!this.stopped && this.opts.autoRestart !== false) {
          log('info', `[ha] 守护进程退出, 自动重启 (第 ${this.state.restarts + 1} 次)`);
          this.restartTimer = setTimeout(() => {
            if (!this.stopped) { this.state.restarts++; this.spawnDaemon(); }
          }, 1000);
        }
      });
    } catch (e: any) {
      log('error', `[ha] spawn 守护进程失败: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  /** 停止: 停 primary 心跳 + 杀 daemon (幂等) */
  stop(): void {
    this.stopped = true;
    this.guard?.stop();
    this.guard = null;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.daemon && !this.daemon.killed) {
      try { this.daemon.kill('SIGTERM'); } catch { /* 忽略 */ }
    }
    // best-effort 清 primary 心跳
    try {
      const f = path.join(this.opts.home || os.homedir(), '.bolloon', 'kernel-ha', 'primary.heartbeat');
      fs.unlinkSync(f);
    } catch { /* 忽略 */ }
  }
}

/** 便捷工厂 */
export function createHaSupervisor(opts: HaSupervisorOptions = {}): HaSupervisor {
  return new HaSupervisor(opts);
}

export { makeHeartbeat, writeHeartbeat, STALE_MS, BEAT_MS };