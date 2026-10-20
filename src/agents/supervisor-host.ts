/**
 * supervisor-host.ts — Supervisor 的「宿主分离」层 (2026-09-16, 批次 2-C.1)
 *
 * 之前的问题: Supervisor 的**启动点**长在 web server 里, 执行器也直接引用 web 的 channel agent
 * → 长期执行能力事实上依附于「web 进程还活着」。
 *
 * 这一层把两件事彻底分开:
 *   执行器 (runner)   ← 由 RunnerResolver 在**每次执行前**解析 (web agent / CLI agent / 独立 agent / fake)
 *   启动宿主 (host)   ← web server / CLI `/supervise` / 独立 `bolloon supervise` / 测试进程, 都只是 host
 *
 * 冻结的接口:
 *   Supervisor { scheduler · lease · reducer · wake } + runnerResolver
 *   resolver 解析不出来 → **只诊断不执行, 且不写任何 Goal 状态** (绝不假装跑过, 也绝不误判完成)
 *
 * 宿主身份与状态落盘 (~/.bolloon/supervisor.json): owner / workerId / pid / host / 启动时间 /
 * 最近 tick / tick 次数 / runner 种类 / 优雅停止时间 —— 让"谁在跑、跑到哪、为什么停"可查。
 */

import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { acquireTickLock } from '../cron/tick-lock.js';
import type { RunnerKind, RunnerResolver, RunnerResolution } from './execution-supervisor.js';

// runner 解析接口定义在 execution-supervisor.ts (避免循环依赖), 这里只做再导出
export type { GoalRunner, RunnerKind, RunnerResolver, RunnerResolution } from './execution-supervisor.js';

export function supervisorDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'supervisor');
}

export function supervisorStatePath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'supervisor.json');
}

/** Supervisor tick 的跨进程锁 (与 cron 的 tick 锁同语义, 但不共用文件) */
export function supervisorTickLockPath(home: string = os.homedir()): string {
  return path.join(supervisorDir(home), '.tick.lock');
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主状态持久化
// ─────────────────────────────────────────────────────────────────────────────

export interface SupervisorState {
  /** worker 身份 (host:pid) */
  owner: string;
  /** 稳定的 worker id (进程每次启动不同, 用来区分"谁在什么时候跑过") */
  workerId: string;
  pid: number;
  host: string;
  startedAt: string;
  /** 最近一次 tick 结束时间 */
  lastTickAt?: string;
  /** 累计 tick 次数 (本次进程内) */
  ticks?: number;
  runnerKind: RunnerKind | 'mixed';
  dryRun: boolean;
  tickIntervalMs: number;
  leaseTtlMs: number;
  /** 最近一次 tick 的执行/跳过摘要 (上限截断, 供 UI/诊断) */
  lastSummary?: string;
  /**
   * 最近一次执行器解析的分阶段报告 (2-C.2):
   * 回答"这个 Goal 为什么没被执行、卡在哪一阶段、耗时多少、失败分类是什么"。
   */
  lastResolution?: {
    goalId: string;
    at: string;
    ok: boolean;
    failedStage?: string;
    reason?: string;
    stages: string;
    /** 每阶段明细 (stage/ok/ms/note/error/errorClass) */
    detail: { stage: string; ok: boolean; ms: number; note?: string; error?: string; errorClass?: string }[];
  };
  /** 优雅停止时间 (非正常退出时不会有这个字段 —— 这本身就是"上次没好好停"的证据) */
  stoppedAt?: string;
  stopReason?: string;
  /** 版本, 便于以后迁移 */
  v: 1;
}

export async function readSupervisorState(home: string = os.homedir()): Promise<SupervisorState | null> {
  try {
    return JSON.parse(await fsp.readFile(supervisorStatePath(home), 'utf8')) as SupervisorState;
  } catch {
    return null;
  }
}

export async function writeSupervisorState(state: SupervisorState, home: string = os.homedir()): Promise<void> {
  const p = supervisorStatePath(home);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, p);          // 原子替换, 避免读到半截状态
}

export function newWorkerId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 独立宿主: tick 锁 + 优雅停止 + 状态心跳
// ─────────────────────────────────────────────────────────────────────────────

export interface HostHandle {
  /** 停止循环并等待当前 tick 结束 (优雅停止) */
  stop: (reason?: string) => Promise<void>;
  state: SupervisorState;
}

export interface RunHostOptions {
  /** 已构造好的 supervisor (runner/resolver 已注入) */
  supervisor: {
    owner: string;
    tickOnce: () => Promise<{
      at: string; tick: number; claimed: string[]; skipped: { goalId: string; reason: string }[];
      executed: { goalId: string; runId?: string; status?: string; error?: string }[]; errors: string[];
    }>;
    start: () => void;
    stop: () => void;
    status: () => Record<string, unknown>;
  };
  /** 缺省 'interval' = 常驻循环 (默认); 'once' = 只跑一个周期后返回 */
  mode?: 'interval' | 'once';
  /** 常驻循环时是否让进程保持存活 (独立宿主需要 true; web/测试里应让 event loop 自由退出) */
  keepAlive?: boolean;
  tickIntervalMs?: number;
  leaseTtlMs?: number;
  runnerKind?: RunnerKind | 'mixed';
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** 单个 tick 的跨进程互斥 (默认开) */
  crossProcessLock?: boolean;
  home?: string;
  /** 注入: 单测可换成假的 tick 锁 */
  acquireLock?: typeof acquireTickLock;
  /** 每次写宿主状态时合并的额外字段 (例如最近一次解析阶段报告) */
  extraState?: () => Record<string, unknown>;
  /** 宿主创建后把"立刻落盘"的函数交出去 (解析结果不等 tick 结束就能查) */
  onStateReady?: (write: () => Promise<void>) => void;
}

/**
 * 启动一个 Supervisor 宿主。
 * 语义要点:
 *   - **跨进程单 tick 互斥**: 拿不到 tick 锁的宿主本轮直接让路 (不阻塞不排队), 并如实记原因;
 *   - **优雅停止**: stop() 会等当前 tick 跑完再退出 (不半路丢状态), 并落 stoppedAt/stopReason;
 *   - 宿主身份与心跳落 `~/.bolloon/supervisor.json`, 谁在跑/跑到哪可查。
 */
export async function runSupervisorHost(opts: RunHostOptions): Promise<HostHandle> {
  const home = opts.home ?? os.homedir();
  const log = opts.log ?? (() => {});
  const workerId = newWorkerId();
  const state: SupervisorState = {
    owner: opts.supervisor.owner,
    workerId,
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    runnerKind: opts.runnerKind ?? 'injected',
    dryRun: !!opts.dryRun,
    tickIntervalMs: opts.tickIntervalMs ?? 30_000,
    leaseTtlMs: opts.leaseTtlMs ?? 90_000,
    ticks: 0,
    v: 1,
  };
  await writeSupervisorState(state, home);

  const persist = async (): Promise<void> => {
    if (opts.extraState) Object.assign(state as any, opts.extraState());
    await writeSupervisorState(state, home);
  };
  // 让调用方随时能把状态写下去 (解析阶段报告一确定就可查, 不必等 tick 结束)
  opts.onStateReady?.(persist);
  const acquire = opts.acquireLock ?? acquireTickLock;
  const useLock = opts.crossProcessLock !== false;
  let stopping = false;
  let ticking = false;
  let timer: NodeJS.Timeout | null = null;

  const tickWithLock = async (): Promise<void> => {
    if (stopping || ticking) return;          // 进程内互斥
    ticking = true;
    const tickNo = (state.ticks ?? 0) + 1;
    const startedMs = Date.now();
    // 卡住的 tick 必须可观测 (长期运行时"没日志"和"卡死"必须能区分)
    const watchdog = setInterval(() => {
      log(`[supervisor-host] ⚠ tick #${tickNo} 已运行 ${Math.round((Date.now() - startedMs) / 1000)}s 仍未结束 (可能卡在 runner/session 创建)`);
    }, 30_000);
    watchdog.unref?.();
    let lockPath: string | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      if (useLock) {
        const r = await acquire({ lockPath: supervisorTickLockPath(home), staleMs: 300_000, log: () => {} });
        if (!r.acquired) {
          // 别的宿主在 tick → 本轮让路 (不阻塞), 原因写进状态, 可观测
          state.lastTickAt = new Date().toISOString();
          state.lastSummary = `本轮让路: tick 锁被 ${r.holder?.pid ?? '?'}@${r.holder?.host ?? '?'} 持有`;
          await persist();
          log(`[supervisor-host] ${state.lastSummary}`);
          return;
        }
        release = r.release;
        lockPath = supervisorTickLockPath(home);
      }
      const rep = await opts.supervisor.tickOnce();
      state.ticks = (state.ticks ?? 0) + 1;
      state.lastTickAt = rep.at;
      state.lastSummary = `#${rep.tick} 认领 ${rep.claimed.length} · 执行 ${rep.executed.length} · 跳过 ${rep.skipped.length}${rep.errors.length ? ` · 错误 ${rep.errors.length}` : ''}`;
      await persist();
      log(`[supervisor-host] ${state.lastSummary}`);
    } catch (err) {
      state.lastTickAt = new Date().toISOString();
      state.lastSummary = `tick 异常: ${String((err as Error)?.message || err).slice(0, 160)}`;
      await persist().catch(() => {});
      log(`[supervisor-host] ${state.lastSummary}`);
    } finally {
      clearInterval(watchdog);
      try { await release?.(); } catch { /* 锁释放失败: 陈旧回收兜底 */ }
      void lockPath;
      ticking = false;
    }
  };

  if ((opts.mode ?? 'interval') === 'once') {
    await tickWithLock();
    state.stoppedAt = new Date().toISOString();
    state.stopReason = 'once';
    await writeSupervisorState(state, home);
    return { stop: async () => {}, state };
  }

  // 宿主驱动 tick (不用 supervisor 自己的 interval, 避免两条 tick 循环重复推进同一个 Goal)
  timer = setInterval(() => { void tickWithLock(); }, state.tickIntervalMs);
  if (!opts.keepAlive) timer.unref?.();
  log(`[supervisor-host] 启动 owner=${state.owner} worker=${workerId} tick=${state.tickIntervalMs}ms`);
  // 启动后**立刻**跑一轮: 重启/接管时不该白等一个 tick 间隔才开始推进 (ticking 标志同步置位, stop() 会等它收尾)
  void tickWithLock();

  const stop = async (reason = 'requested'): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) { clearInterval(timer); timer = null; }
    opts.supervisor.stop();
    // 等当前 tick 收尾 (最多 30s), 保证不半路丢状态
    for (let i = 0; i < 300 && ticking; i++) await new Promise((r) => setTimeout(r, 100));
    state.stoppedAt = new Date().toISOString();
    state.stopReason = reason;
    await persist().catch(() => {});
    log(`[supervisor-host] 已优雅停止 (${reason})`);
  };

  return { stop, state };
}

/**
 * 给独立宿主用的解析器: 按 Goal 的 channelId 建/复用**专用 agent session** 执行。
 * 解析不出来 (没有 channelId / agent 不可用 / 显式关闭) → { ok:false }, Goal 只被诊断不被执行。
 */
/**
 * 给独立宿主用的解析器: 委托给**分阶段** resolver (`runner-resolver.ts`)。
 * 阶段报告通过 `onResolution` 交给宿主落盘 (lastResolution), 让 wakeReport/API/CLI 能回答
 * "这个 Goal 为什么没被执行、卡在哪一阶段、耗时多少"。
 */
export function createLocalAgentResolver(opts: {
  /** 允许自动建 agent session 的开关 (默认开; 关掉则只诊断) */
  allow?: boolean;
  createTimeoutMs?: number;
  stageTimeoutMs?: number;
  home?: string;
  cwd?: string;
  log?: (msg: string) => void;
  /** 注入 (测试): 自定义建 agent / LLM 探测 */
  createAgent?: (channelId: string, goalId: string) => Promise<any> | any;
  probeLlm?: () => Promise<{ ok: boolean; provider?: string; model?: string; hasKey?: boolean; reason?: string }>;
  /** 每次解析后回调 (宿主用它落盘阶段报告) */
  onResolution?: (goalId: string, res: any) => void;
}): RunnerResolver {
  const cache = new Map<string, RunnerResolution>();
  return async (req) => {
    const { resolveGoalRunner } = await import('./runner-resolver.js');
    const res = await resolveGoalRunner(req, opts as any);
    opts.onResolution?.(req.goal.goalId, res);
    if (res.ok && res.runner) cache.set(req.goal.goalId, res);
    return res;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 独立宿主入口: `bolloon --supervise` (不依附 web 进程; 也能被测试进程当普通宿主用)
// ─────────────────────────────────────────────────────────────────────────────

export interface StandaloneHostOptions {
  /** 只跑一个调度周期后退出 */
  once?: boolean;
  /** 只诊断, 不执行 (解析器恒为 ok:false) */
  dryRun?: boolean;
  tickIntervalMs?: number;
  leaseTtlMs?: number;
  maxPerTick?: number;
  home?: string;
  log?: (msg: string) => void;
}

export interface StandaloneHostResult {
  ticks: number;
  state: SupervisorState;
  /** 最近一次 tick 报告 (once 模式下用它断言) */
  lastReport: unknown;
}

/**
 * 起一个**独立**的 Supervisor 宿主。
 * - 执行器由 `createLocalAgentResolver` 按 Goal 的 channelId 解析专用 agent session (懒建 + 复用);
 * - `BOLLOON_SUPERVISE_AGENT=0` 或 dryRun → 解析器恒 ok:false → 只诊断不执行 (Goal 状态不动);
 * - 常驻模式下进程保持存活, 收到 SIGINT/SIGTERM 优雅停止并落 stoppedAt。
 */
export async function runStandaloneSupervisorHost(opts: StandaloneHostOptions = {}): Promise<StandaloneHostResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { ExecutionSupervisor } = await import('./execution-supervisor.js');

  let lastResolution: any = null;
  let persistNow: () => Promise<void> = async () => {};
  const resolver = opts.dryRun
    ? async (req: any): Promise<any> => ({ ok: false, kind: 'none', reason: `dry-run: 不执行 (goal=${req.goal.goalId})` })
    : createLocalAgentResolver({
      allow: process.env.BOLLOON_SUPERVISE_AGENT !== '0',
      log,
      home: opts.home,
      onResolution: (goalId: string, res: any) => {
        lastResolution = {
          goalId, at: new Date().toISOString(), ok: !!res.ok,
          failedStage: res.failedStage, reason: res.reason,
          stages: (res.stages || []).map((x: any) => `${x.stage}${x.ok ? '✓' : '✗'}${x.ms}ms`).join(' → '),
          detail: (res.stages || []).map((x: any) => ({ stage: x.stage, ok: x.ok, ms: x.ms, note: x.note, error: x.error, errorClass: x.errorClass })),
        };
        log(`[supervisor-host] 解析 ${res.ok ? '✅ 可执行' : `⛔ 卡在 ${res.failedStage}`} — ${res.reason || ''}`);
        void persistNow().catch(() => {});          // 阶段报告立刻落盘
      },
    });

  const sup = new ExecutionSupervisor({
    resolver: resolver as any,
    maxPerTick: opts.maxPerTick ?? (Number(process.env.BOLLOON_SUPERVISOR_MAX_PER_TICK) || 1),
    tickIntervalMs: opts.tickIntervalMs ?? (Number(process.env.BOLLOON_SUPERVISOR_TICK_MS) || 30_000),
    leaseTtlMs: opts.leaseTtlMs ?? (Number(process.env.BOLLOON_SUPERVISOR_LEASE_MS) || 90_000),
    log,
  });

  const host = await runSupervisorHost({
    supervisor: sup as any,
    mode: opts.once ? 'once' : 'interval',
    keepAlive: !opts.once,
    tickIntervalMs: sup.status().tickIntervalMs,
    leaseTtlMs: sup.status().leaseTtlMs,
    runnerKind: opts.dryRun ? 'none' : 'standalone',
    dryRun: !!opts.dryRun,
    home: opts.home,
    log,
    extraState: () => (lastResolution ? { lastResolution } : {}),
    onStateReady: (write) => { persistNow = write; },
  });

  if (opts.once) {
    log(`[supervisor-host] once 完成: ${host.state.lastSummary || '(空)'}`);
    return { ticks: host.state.ticks ?? 0, state: host.state, lastReport: sup.status().lastReport };
  }

  const onSignal = (sig: string): void => {
    void host.stop(`signal:${sig}`).then(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  return { ticks: host.state.ticks ?? 0, state: host.state, lastReport: null };
}
