/**
 * update-state.ts — 更新系统的**落盘事实** (Phase 0/5/7, 2026-09-19)
 *
 * 三个文件, 三个职责 (不混):
 *   `~/.bolloon/update-state.json`    当前状态 (最近一次检查 / 最近一次更新 / 开关 / 锁)
 *   `~/.bolloon/update-history.jsonl` append-only 历史 (每次更新一行, 供 `update --history`)
 *   `~/.bolloon/update.lock`          更新锁 (含 pid + 时间; 陈旧锁可自动回收)
 *
 * 硬约束:
 *   - **绝不** 触碰除上面三个文件之外的任何 `~/.bolloon` 内容 (config / goals / runs /
 *     transactions / skills 一律只读或不动)。
 *   - 原子写 (tmp + rename): 半份状态文件比没有状态文件更危险。
 *   - 旧的 `~/.bolloon/.update-check.json` **只读一次**做迁移, 不再写 (单一事实)。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { resolveBolloonHome } from '../setup/setup-store.js';
import { CHECK_STATUSES, type CheckStatus, type UpdatePrefs } from './version-identity.js';

// ── 枚举 (冻结: 出口/状态都不许临时造词) ────────────────────────────────────
//
// 2026-09-26: 结论枚举与 UpdatePrefs 的结构定义抽到 `version-identity.ts` (纯模块, 无 node:)。
// **只有一个原因**: 手机端 WebView 里没有 `fs`/`os`, 但手机端必须用**同一份**结论语义
// (9 个结论 + REFUSED_STATUSES 的拒绝口径)。这里原样再导出, 既有 import 路径不变。
export { CHECK_STATUSES };
export type { CheckStatus, UpdatePrefs };

/** 一次"更新执行"的流水线状态。 */
export const UPDATE_RUN_STATUSES = [
  'planned', 'downloading', 'staged', 'switching', 'verifying',
  'succeeded', 'failed', 'rolled_back', 'blocked',
] as const;
export type UpdateRunStatus = typeof UPDATE_RUN_STATUSES[number];

/** 处于"进行中"的状态 —— 落盘时看到它说明上次更新被中断 (doctor 会报)。 */
export const IN_FLIGHT_RUN_STATUSES: UpdateRunStatus[] = ['planned', 'downloading', 'staged', 'switching', 'verifying'];

export const UPDATE_STATE_SCHEMA = 'bolloon-update/1';

// ── 路径 ────────────────────────────────────────────────────────────────────

export function updateStatePath(home: string = resolveBolloonHome()): string {
  return path.join(home, 'update-state.json');
}
export function updateHistoryPath(home: string = resolveBolloonHome()): string {
  return path.join(home, 'update-history.jsonl');
}
export function updateLockPath(home: string = resolveBolloonHome()): string {
  return path.join(home, 'update.lock');
}
/** 迁移输入: 旧版节流缓存 (只读)。 */
export function legacyCheckCachePath(home: string = resolveBolloonHome()): string {
  return path.join(home, '.update-check.json');
}

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface UpdateRecord {
  at: string;
  from: string;
  to: string;
  status: UpdateRunStatus;
  durationMs?: number;
  reason?: string;
}

export interface UpdateLockInfo {
  pid: number;
  at: string;
  by: string;
  reason?: string;
}

export interface UpdateState {
  schema: typeof UPDATE_STATE_SCHEMA;
  /** 最近一次写盘时看到的当前版本 */
  currentVersion: string;
  latestVersion: string | null;
  channel: string;
  installMethod: string;
  installDir: string;
  entryPath: string;
  gitCommit: string | null;
  nodeVersion: string;
  platform: string;
  arch: string;
  lastCheckAt: string | null;
  lastCheckStatus: CheckStatus | null;
  lastCheckReason?: string;
  /** 上次检查时 registry 报的 gitHead (npm 安装没有 .git, 靠这个回答"上游提交") */
  registryGitHead?: string | null;
  lastUpdate: UpdateRecord | null;
  lastFailure: { at: string; stage: string; reason: string } | null;
  checkUpdates: boolean;
  autoInstall: boolean;
  autoRestart: boolean;
  needsRestart: boolean;
  updatedAt: string;

  // ── 双源 (§12, 2026-09-25) ──────────────────────────────────────────────
  /** **当前装的是哪个源**: stable = npm registry 权威; dev = GitHub master 快照 */
  installedChannel?: InstalledChannel | null;
  /** 磁盘身份里的 dev commit sha (`0.4.33+dev.a1b2c3d` → `a1b2c3d`); 非 dev 安装 = null */
  installedDevSha?: string | null;
  /** 最近一次装成 dev 用的 sha (切回 stable 后仍保留 —— 回答"上次那个 dev 快照是哪个") */
  devSha?: string | null;
  devRef?: string | null;
  devCheckedAt?: string | null;
  /** 上次检查时两个源各自的事实 (§12.5: 谁答的 / 交叉校验结果都要看得到) */
  sourceFacts?: SourceFacts | null;
  /** 与当前安装通道不同的那个源 (一键能切回去的目标) */
  switchableTo?: SwitchTarget | null;
}

/** 当前安装来源的通道 (§12.1) */
export type InstalledChannel = 'stable' | 'dev';

/** 一键切回另一个源的目标 (§12.4 硬约束 3) */
export interface SwitchTarget { channel: InstalledChannel; source: string; target: string | null }

/** 两个源各自的事实 (只留能回答问题的字段, 不把整份 facts 塞进状态文件) */
export interface SourceFacts {
  npm?: { reachable: boolean; latest: string | null; detail?: string } | null;
  github?: {
    reachable: boolean; reason?: string; detail?: string; retryAt?: string | null;
    ref?: string; headSha?: string | null; newestVersion?: string | null;
    releases?: number; tags?: number;
  } | null;
  /** stable 的交叉校验结论 / 没有就是没查 */
  crossCheck?: { kind: string; blocking: boolean; detail: string } | null;
}

export function emptyUpdateState(now = new Date()): UpdateState {
  return {
    schema: UPDATE_STATE_SCHEMA,
    currentVersion: 'unknown',
    latestVersion: null,
    channel: 'stable',
    installMethod: 'unknown',
    installDir: '',
    entryPath: '',
    gitCommit: null,
    nodeVersion: process.version.replace(/^v/, ''),
    platform: os.platform(),
    arch: os.arch(),
    lastCheckAt: null,
    lastCheckStatus: null,
    lastUpdate: null,
    lastFailure: null,
    checkUpdates: true,
    autoInstall: false,
    autoRestart: false,
    needsRestart: false,
    updatedAt: now.toISOString(),
    installedChannel: null,
    installedDevSha: null,
    devSha: null,
    devRef: null,
    devCheckedAt: null,
    sourceFacts: null,
    switchableTo: null,
  };
}

// ── 读写 (原子) ─────────────────────────────────────────────────────────────

export async function readUpdateState(home: string = resolveBolloonHome()): Promise<UpdateState> {
  const base = emptyUpdateState();
  let raw: any = null;
  try {
    raw = JSON.parse(await fsp.readFile(updateStatePath(home), 'utf8'));
  } catch {
    raw = null;
  }
  if (!raw || raw.schema !== UPDATE_STATE_SCHEMA) {
    // 迁移: 旧 `.update-check.json` 只有 lastCheck (epoch ms), 取来做"上次检查"时间。
    try {
      const legacy = JSON.parse(await fsp.readFile(legacyCheckCachePath(home), 'utf8'));
      if (typeof legacy?.lastCheck === 'number' && legacy.lastCheck > 0) {
        return { ...base, lastCheckAt: new Date(legacy.lastCheck).toISOString(), lastCheckStatus: null };
      }
    } catch {
      // 没有旧文件
    }
    return base;
  }
  return {
    ...base, ...raw,
    lastUpdate: raw.lastUpdate ?? null,
    lastFailure: raw.lastFailure ?? null,
  };
}

/**
 * 进程内写队列: 状态文件是 **read-modify-write**, 两个并发的写会互相丢字段
 * (真被测试抓到过: 未 await 的阶段留痕在成功/失败记录之后落地, 把 lastFailure 抹掉)。
 * 同一个 home 的写串成一条链, 读到的 cur 永远是最新已落盘版本。
 */
const writeChains = new Map<string, Promise<unknown>>();

/** 原子合并写 (只覆盖显式传入的字段; 同一 home 的写串行化)。 */
export async function writeUpdateState(patch: Partial<UpdateState>, home: string = resolveBolloonHome()): Promise<UpdateState> {
  const key = path.resolve(home);
  const prev = writeChains.get(key) || Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const cur = await readUpdateState(home);
    const next: UpdateState = { ...cur, ...patch, schema: UPDATE_STATE_SCHEMA, updatedAt: new Date().toISOString() };
    await fsp.mkdir(home, { recursive: true });
    const p = updateStatePath(home);
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, p);
    return next;
  });
  writeChains.set(key, run);
  try {
    return await run;
  } finally {
    if (writeChains.get(key) === run) writeChains.delete(key);
  }
}

// ── 历史 (append-only) ──────────────────────────────────────────────────────

export async function appendUpdateHistory(entry: UpdateRecord, home: string = resolveBolloonHome()): Promise<void> {
  try {
    await fsp.mkdir(home, { recursive: true });
    await fsp.appendFile(updateHistoryPath(home), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // 历史写失败不能影响更新本身
  }
}

export async function readUpdateHistory(limit = 10, home: string = resolveBolloonHome()): Promise<UpdateRecord[]> {
  let text = '';
  try {
    text = await fsp.readFile(updateHistoryPath(home), 'utf8');
  } catch {
    return [];
  }
  const out: UpdateRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as UpdateRecord;
      if (rec && rec.at) out.push(rec);
    } catch {
      // 半行 (被 kill) 直接跳过
    }
  }
  return out.slice(-Math.max(1, limit)).reverse();
}

// ── 锁 ──────────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 30 * 60 * 1000;

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = 存在但没权限 → 活着
    return e?.code === 'EPERM';
  }
}

export function readUpdateLock(home: string = resolveBolloonHome()): UpdateLockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(updateLockPath(home), 'utf8')) as UpdateLockInfo;
    if (!raw || typeof raw.pid !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

export function lockIsStale(lock: UpdateLockInfo, now = Date.now()): boolean {
  const at = Date.parse(lock.at || '');
  if (!Number.isFinite(at)) return true;
  if (now - at > LOCK_STALE_MS) return true;
  return !pidAlive(lock.pid);
}

export interface AcquireResult { ok: boolean; lock?: UpdateLockInfo; heldBy?: UpdateLockInfo; staleReclaimed?: boolean }

export async function acquireUpdateLock(opts: { reason?: string; by?: string; home?: string; now?: number } = {}): Promise<AcquireResult> {
  const home = opts.home ?? resolveBolloonHome();
  const existing = readUpdateLock(home);
  let staleReclaimed = false;
  if (existing) {
    if (!lockIsStale(existing, opts.now)) {
      return { ok: false, heldBy: existing };
    }
    staleReclaimed = true;
  }
  const lock: UpdateLockInfo = {
    pid: process.pid,
    at: new Date(opts.now ?? Date.now()).toISOString(),
    by: opts.by || 'bolloon update',
    reason: opts.reason,
  };
  await fsp.mkdir(home, { recursive: true });
  const p = updateLockPath(home);
  // 独占创建: 抢锁失败只能说明另一进程刚抢到
  try {
    const fh = await fsp.open(p, 'wx');
    await fh.writeFile(JSON.stringify(lock, null, 2), 'utf8');
    await fh.close();
  } catch {
    if (!staleReclaimed) return { ok: false, heldBy: readUpdateLock(home) || undefined };
    await fsp.writeFile(p, JSON.stringify(lock, null, 2), 'utf8');
  }
  return { ok: true, lock, staleReclaimed };
}

export async function releaseUpdateLock(home: string = resolveBolloonHome()): Promise<void> {
  const cur = readUpdateLock(home);
  // 只释放自己的锁 (别人的锁不许删)
  if (cur && cur.pid !== process.pid) return;
  try {
    await fsp.unlink(updateLockPath(home));
  } catch {
    // 已经没了
  }
}

/** doctor 用: 清掉陈旧锁 (有活性就不动)。 */
export async function reclaimStaleLockIfAny(home: string = resolveBolloonHome()): Promise<{ reclaimed: boolean; lock: UpdateLockInfo | null }> {
  const lock = readUpdateLock(home);
  if (!lock || !lockIsStale(lock)) return { reclaimed: false, lock };
  try {
    await fsp.unlink(updateLockPath(home));
    return { reclaimed: true, lock };
  } catch {
    return { reclaimed: false, lock };
  }
}

// ── 开关 (默认: 检查开 / 自动装关 / 自动重启关) ─────────────────────────────

/**
 * 读取更新开关。
 * 优先级: 环境变量 (临时覆盖) > `~/.bolloon/config.json` > 默认。
 *
 * **行为变更 (2026-09-19, 刻意)**: 旧默认是 `autoUpdate: true` + `autoRestart: true`
 *   (检测到新版就自动装 + 自动重启)。新默认是 `checkUpdates: true` / `autoInstall: false`
 *   / `autoRestart: false` —— 只通知, 装上要用户显式 `bolloon update --now`.
 *   旧字段 `autoUpdate` 仍被读取, 但**只映射到 checkUpdates** (`autoUpdate: false` = 不要检查),
 *   绝不映射成 autoInstall —— 否则一次升级就把"自动替换运行时"当成用户意愿。
 */
export async function readUpdatePrefs(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<UpdatePrefs> {
  const home = opts.home ?? resolveBolloonHome();
  const env = opts.env ?? process.env;
  const prefs: UpdatePrefs = {
    checkUpdates: true, autoInstall: false, autoRestart: false, channel: 'stable', checkIntervalHours: 24,
    sources: { checkUpdates: 'default', autoInstall: 'default', autoRestart: 'default', channel: 'default' },
  };

  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(home, 'config.json'), 'utf8'));
    if (typeof cfg?.autoUpdate === 'boolean') {
      prefs.checkUpdates = cfg.autoUpdate;
      prefs.sources.checkUpdates = 'config';
    }
    for (const key of ['checkUpdates', 'autoInstall', 'autoRestart'] as const) {
      if (typeof cfg?.[key] === 'boolean') {
        prefs[key] = cfg[key];
        prefs.sources[key] = 'config';
      }
    }
    if (typeof cfg?.updateChannel === 'string') {
      const ch = cfg.updateChannel.trim().toLowerCase();
      if (ch === 'stable' || ch === 'beta' || ch === 'dev') { prefs.channel = ch; prefs.sources.channel = 'config'; }
    }
    if (typeof cfg?.checkIntervalHours === 'number' && cfg.checkIntervalHours > 0) {
      prefs.checkIntervalHours = cfg.checkIntervalHours;
    }
  } catch {
    // 没有 config.json 就用默认
  }

  // 环境变量: 只作**本次进程的临时覆盖**, 不落盘
  const skip = env.BOLLOON_SKIP_UPDATE;
  if (skip === '1' || skip === 'true') { prefs.checkUpdates = false; prefs.sources.checkUpdates = 'env'; }
  const auto = env.BOLLOON_AUTO_UPDATE;
  if (auto === '1' || auto === 'true') { prefs.autoInstall = true; prefs.sources.autoInstall = 'env'; }
  const ch = (env.BOLLOON_UPDATE_CHANNEL || '').trim().toLowerCase();
  if (ch === 'stable' || ch === 'beta' || ch === 'dev') { prefs.channel = ch; prefs.sources.channel = 'env'; }

  return prefs;
}

/** 把新的默认开关写进 config.json —— 只在文件存在且缺字段时补, 绝不覆盖用户已有值。 */
export async function ensureUpdatePrefsInConfig(home: string = resolveBolloonHome()): Promise<{ changed: boolean; config: any }> {
  const p = path.join(home, 'config.json');
  let cfg: any;
  try {
    cfg = JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return { changed: false, config: null };
  }
  let changed = false;
  if (typeof cfg.checkUpdates !== 'boolean') { cfg.checkUpdates = true; changed = true; }
  if (typeof cfg.autoInstall !== 'boolean') { cfg.autoInstall = false; changed = true; }
  if (typeof cfg.autoRestart !== 'boolean') { cfg.autoRestart = false; changed = true; }
  if (typeof cfg.updateChannel !== 'string') { cfg.updateChannel = 'stable'; changed = true; }
  if (changed) {
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    await fsp.rename(tmp, p);
  }
  return { changed, config: cfg };
}
