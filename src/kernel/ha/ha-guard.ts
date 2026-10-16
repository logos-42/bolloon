/**
 * ha-guard.ts — Kernel 双活守护循环 (2026-10-16, leo: 双内核冗余 — 独立 kernel 守护进程)
 *
 * 职责: 心跳循环 + 对等探测 + 接管 orphan run。
 *
 * 边界 (K1 目录边界: kernel 只做机制, 不碰业务):
 *   - 本文件**不 import** 任何业务模块 (run-store / supervisor 等);
 *   - reconcileOrphans / prepareResume / collectActiveRunIds 全部**端口注入**,
 *     由调用方 (主进程) 把业务实现传进来 —— 守护循环只负责「什么时候探测/什么时候接管/接管几步」。
 *
 * 循环语义:
 *   - 每 BEAT_MS 写自己的心跳 (含当前活跃 runIds, 由注入的 collectActiveRunIds 提供)
 *   - 每 BEAT_MS 读对端 (primary) 心跳 → decideTakeover
 *   - 判定接管 → acquirePrimaryLock (防双主) → 接管步骤 (注入的 takeoverRuns):
 *       ① reconcileOrphans() 找主进程留下的 orphan run
 *       ② 逐个 prepareResume(runId) 确认可恢复
 *       ③ 记入自己的心跳 runIds
 *       ④ 自己的心跳 role 切 primary
 *   - 一次接管只做一轮; 下轮心跳若 primary 复活 (心跳新鲜) → 备进程让位 (不主动降级, 由仲裁决定)
 *
 * 退出: stop() 幂等; 进程退出时 best-effort 清心跳 (防止陈旧心跳误导对端判接管)。
 */
import {
  BEAT_MS, STALE_MS,
  type HaRole, type HeartbeatRecord,
  writeHeartbeat, readPrimaryHeartbeat, decideTakeover,
  acquirePrimaryLock, collectActiveRunIds, fsSync,
} from './ha-arbiter.js';
import * as os from 'os';
import * as path from 'path';

export interface HaGuardPorts {
  /** 本进程业务侧实现: 把主进程留下的 orphan run 标记为 interrupted, 返回 runIds */
  reconcileOrphans: () => Promise<{ interrupted: string[]; stillRunning: string[]; failed: string[] }>;
  /** 本进程业务侧实现: 校验可恢复 + 落 recovering + 记 recovery attempt */
  prepareResume: (runId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 本进程业务侧实现: 当前活跃 runIds (running/recovering/interrupted) */
  collectActiveRunIds?: () => Promise<string[]>;
  /** 日志出口 (守护循环不碰 stdout) */
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void;
}

export interface HaGuardOptions {
  role: HaRole;
  home?: string;
  kernelVersion?: string;
  beatMs?: number;
  staleMs?: number;
  /** 日志出口 (守护循环不碰 stdout) */
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void;
  /** 接管回调 (业务侧收到通知, 用于 UI/日志; 不阻塞循环) */
  onTakeover?: (info: { adoptedRunIds: string[]; reason: string }) => void;
  /** 每次心跳后的回调 (测试/监控用) */
  onBeat?: (rec: HeartbeatRecord) => void;
}

export interface HaGuardState {
  running: boolean;
  role: HaRole;
  beats: number;
  takeovers: number;
  lastBeatAt: string | null;
  adoptedRunIds: string[];
}

const noop = () => {};

/** 构造一条心跳记录 */
export function makeHeartbeat(role: HaRole, runIds: string[], kernelVersion = ''): HeartbeatRecord {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    host: os.hostname(),
    role,
    startedAt: now,
    lastBeat: now,
    runIds: runIds || [],
    kernelVersion: String(kernelVersion || '').slice(0, 40),
  };
}

/**
 * 一次探测+可能的接管 (纯编排, 可单测)。
 * 返回 { action: 'beat' | 'takeover' | 'noop' } — noop = 本进程是 primary, 只写心跳。
 */
export async function guardTick(
  ports: HaGuardPorts,
  opts: HaGuardOptions,
  state: HaGuardState,
): Promise<{ action: 'beat' | 'takeover' | 'noop'; adoptedRunIds?: string[]; reason?: string }> {
  const log = opts.log || ((_l: any, _m: string) => {});
  const home = opts.home || os.homedir();
  const beatMs = opts.beatMs ?? BEAT_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const collect = ports.collectActiveRunIds || (async () => []);

  // ① 收集当前活跃 runIds (本机)
  const runIds = await collect();

  if (opts.role === 'primary') {
    // 主进程: 写心跳, 什么都不用探测 (备进程会探测我)
    const rec = makeHeartbeat('primary', runIds, opts.kernelVersion);
    await writeHeartbeat(rec, home);
    state.lastBeatAt = rec.lastBeat;
    state.beats++;
    if (opts.onBeat) opts.onBeat(rec);
    return { action: 'noop' };
  }

  // ② 备进程: 探测主进程心跳
  const primaryBeat = await readPrimaryHeartbeat(home);
  const decision = decideTakeover(primaryBeat, Date.now(), staleMs);
  if (!decision.takeover) {
    // 主还活着 → 备待命 (写自己的 standby 心跳, 供观察; 不接管)
    const rec = makeHeartbeat('standby', runIds, opts.kernelVersion);
    await writeHeartbeat(rec, home);
    state.lastBeatAt = rec.lastBeat;
    state.beats++;
    if (opts.onBeat) opts.onBeat(rec);
    // 2026-10-16: 待命 tick 打一条 (verify/诊断用; 生产可忽略)
    if (process.env.BOLLOON_HA_DEBUG === '1') log('info', `standby 待命 beat#${state.beats} (primary alive)`);
    return { action: 'beat' };
  }

  // ③ 判定接管: 抢主锁 (防双主), 抢到才接
  const lock = await acquirePrimaryLock(process.pid, os.hostname(), home);
  if (!lock.acquired) {
    log('warn', `接管被拒: ${lock.reason} (另一进程已抢到主锁)`);
    return { action: 'noop' };
  }

  // ④ 接管步骤: reconcileOrphans → prepareResume 逐个 → 记入心跳 runIds
  let adopted: string[] = [];
  try {
    const orphan = await ports.reconcileOrphans();
    adopted = [...orphan.interrupted];
    const resumed: string[] = [];
    for (const runId of orphan.interrupted) {
      const r = await ports.prepareResume(runId);
      if (r.ok) resumed.push(runId);
      else log('warn', `接管 ${runId} 未恢复: ${r.reason || ''}`);
    }
    adopted = resumed;
    // 接管后本机心跳提升为 primary (包含接管的 run)
    const rec = makeHeartbeat('primary', [...runIds, ...resumed], opts.kernelVersion);
    await writeHeartbeat(rec, home);
    state.lastBeatAt = rec.lastBeat;
    state.adoptedRunIds = resumed;
    state.role = 'primary';
    state.takeovers++;
    if (opts.onTakeover) opts.onTakeover({ adoptedRunIds: resumed, reason: decision.reason });
    return { action: 'takeover', adoptedRunIds: resumed, reason: decision.reason };
  } catch (e: any) {
    log('error', `接管失败: ${String(e?.message || e).slice(0, 200)}`);
    return { action: 'noop' };
  }
}

/** 持续守护循环 (每 beatMs 一次 guardTick); stop() 幂等停止 */
export function startHaGuard(ports: HaGuardPorts, opts: HaGuardOptions): { stop(): void; state(): HaGuardState } {
  const state: HaGuardState = { running: true, role: opts.role, beats: 0, takeovers: 0, lastBeatAt: null, adoptedRunIds: [] };
  const beatMs = opts.beatMs ?? BEAT_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (!state.running) return;
    try {
      await guardTick(ports, opts, state);
    } catch (e: any) {
      (opts.log || noop)('error', `guardTick 异常: ${String(e?.message || e).slice(0, 160)}`);
    }
  };

  // 首跳立即执行 (不等一个 beatMs)
  void tick();
  timer = setInterval(() => { void tick(); }, beatMs);
  // 2026-10-16 修复: **不 unref** — daemon 是 spawn 出来的独立守护进程, 必须持续跑。
  //   旧代码 unref() 导致事件循环只剩 interval 时 (stdio pipe 不算活跃句柄),
  //   daemon 首跳写完心跳后进程直接退出 → 永远等不到接管 (真跑验证撞出的硬坑)。
  //   只有「不拖住宿主退出」的场景才该 unref (如 CLI 内嵌的心跳), daemon 不属于那种。

  const stop = () => {
    state.running = false;
    if (timer) { clearInterval(timer); timer = null; }
    // best-effort 清自己的心跳 (防陈旧误导对端判接管) — 静态 fsSync (打包面禁 require)
    try {
      const f = path.join(opts.home || os.homedir(), '.bolloon', 'kernel-ha', `${opts.role}.heartbeat`);
      fsSync.unlinkSync(f);
    } catch { /* 清理失败不影响退出 */ }
  };

  return { stop, state: () => ({ ...state }) };
}

export { BEAT_MS, STALE_MS };
