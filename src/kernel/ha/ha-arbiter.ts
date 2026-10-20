/**
 * ha-arbiter.ts — Kernel 双活仲裁器 (2026-10-16, leo: 双内核冗余第一刀)
 *
 * 职责: 同机两个 bolloon 进程各自加载 kernel, 通过**心跳文件**互相探测,
 *      主进程死亡时备进程接管其 orphan run (复用 reconcileOrphans + prepareResume)。
 *
 * 设计 (对齐 tick-lock 跨进程先例):
 *   - 心跳文件 `~/.bolloon/kernel-ha/<role>.heartbeat` = JSON {pid, host, role, startedAt, lastBeat, runIds[], kernelVersion}
 *   - 主进程每 BEAT_MS (10s) 写自己的心跳 (含当前 runIds); 备进程每 BEAT_MS 探测主心跳
 *   - 角色仲裁: 抢 `~/.bolloon/kernel-ha/.primary.lock` (O_EXCL 原子创建) — 防双主
 *   - 主心跳过期 (lastBeat 超过 STALE_MS=30s 或 pid 已死) → 备**接管**:
 *       ① 标记本机 role=primary (抢锁)
 *       ② reconcileOrphans() 找主进程留下的 orphan run
 *       ③ 逐个 prepareResume(runId) 确认可恢复 → 记入本机心跳 runIds
 *       ④ 心跳文件切 role=primary
 *   - 纯函数可单测: parseHeartbeat / isHeartbeatStale / decideTakeover / serializeHeartbeat
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const BEAT_MS = 10_000;       // 心跳间隔
export const STALE_MS = 30_000;      // 心跳过期阈值 (3 倍间隔)
export const PRIMARY_LOCK_STALE_MS = 60_000;

export type HaRole = 'primary' | 'standby';

export interface HeartbeatRecord {
  pid: number;
  host: string;
  role: HaRole;
  startedAt: string;
  lastBeat: string;
  runIds: string[];
  kernelVersion: string;
}

export interface HeartbeatParseResult {
  ok: boolean;
  record?: HeartbeatRecord;
  error?: string;
}

/** HA 数据目录 ~/.bolloon/kernel-ha */
export function haDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'kernel-ha');
}

export function heartbeatPath(role: HaRole, home: string = os.homedir()): string {
  return path.join(haDir(home), `${role}.heartbeat`);
}

export function primaryLockPath(home: string = os.homedir()): string {
  return path.join(haDir(home), '.primary.lock');
}

// ---------------------------------------------------------------- 纯函数

/** 序列化心跳 (原子写用) */
export function serializeHeartbeat(rec: HeartbeatRecord): string {
  return JSON.stringify(rec, null, 2);
}

/** 解析心跳文件内容 — 坏行/畸形一律 ok:false (fail-closed) */
export function parseHeartbeat(raw: string): HeartbeatParseResult {
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return { ok: false, error: 'not-object' };
    if (typeof p.pid !== 'number' || typeof p.host !== 'string' || typeof p.role !== 'string') {
      return { ok: false, error: 'missing-fields' };
    }
    if (p.role !== 'primary' && p.role !== 'standby') return { ok: false, error: 'bad-role' };
    const record: HeartbeatRecord = {
      pid: p.pid,
      host: p.host,
      role: p.role,
      startedAt: typeof p.startedAt === 'string' ? p.startedAt : new Date().toISOString(),
      lastBeat: typeof p.lastBeat === 'string' ? p.lastBeat : new Date().toISOString(),
      runIds: Array.isArray(p.runIds) ? p.runIds.filter((x: any) => typeof x === 'string') : [],
      kernelVersion: typeof p.kernelVersion === 'string' ? p.kernelVersion : '',
    };
    return { ok: true, record };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

/** 心跳是否过期: lastBeat 距今 > staleMs, 或 pid 已不存在 */
export function isHeartbeatStale(rec: HeartbeatRecord, now = Date.now(), staleMs = STALE_MS): boolean {
  const last = Date.parse(rec.lastBeat);
  if (!Number.isFinite(last)) return true; // 坏时间 → 判过期 (fail-closed)
  if (now - last > staleMs) return true;
  // pid 不存在 = 进程已死 → 判过期
  try { process.kill(rec.pid, 0); return false; }
  catch { return true; }
}

/**
 * 是否接管: 主心跳缺失 / 解析失败 / 过期 → true。
 * 纯函数 (不含抢锁副作用), 调用方拿到 true 再走 acquirePrimaryLock。
 */
export function decideTakeover(primaryBeat: HeartbeatParseResult | null, now = Date.now(), staleMs = STALE_MS): { takeover: boolean; reason: string } {
  if (!primaryBeat || !primaryBeat.ok) return { takeover: true, reason: 'primary-heartbeat-missing' };
  const rec = primaryBeat.record!;
  if (isHeartbeatStale(rec, now, staleMs)) return { takeover: true, reason: 'primary-heartbeat-stale' };
  return { takeover: false, reason: 'primary-alive' };
}

// ---------------------------------------------------------------- 副作用 (原子写 / 锁)

/** 原子写心跳文件 (tmp + rename) */
export async function writeHeartbeat(rec: HeartbeatRecord, home: string = os.homedir()): Promise<void> {
  await fs.mkdir(haDir(home), { recursive: true });
  const target = heartbeatPath(rec.role, home);
  const tmp = target + '.tmp';
  await fs.writeFile(tmp, serializeHeartbeat(rec), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/** 抢主锁 (O_EXCL 原子创建; 已存在且持锁者存活 → 未抢到; 陈旧 → 回收重试一次) */
export async function acquirePrimaryLock(
  pid: number,
  host: string,
  home: string = os.homedir(),
  staleMs = PRIMARY_LOCK_STALE_MS,
): Promise<{ acquired: boolean; reason: string }> {
  const lockPath = primaryLockPath(home);
  await fs.mkdir(haDir(home), { recursive: true });
  const content = JSON.stringify({ pid, host, at: new Date().toISOString() });
  try {
    await fs.writeFile(lockPath, content, { flag: 'wx', mode: 0o600 });
    return { acquired: true, reason: 'created' };
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return { acquired: false, reason: String(e?.message || e).slice(0, 80) };
    // 已存在 → 判陈旧
    let holder: { pid?: number } = {};
    try { holder = JSON.parse(await fs.readFile(lockPath, 'utf-8')); } catch { /* 坏锁文件 → 视为陈旧 */ }
    const holderAlive = holder && typeof holder.pid === 'number' && (() => { try { process.kill(holder.pid!, 0); return true; } catch { return false; } })();
    const fresh = holderAlive;
    if (fresh) return { acquired: false, reason: 'held-by-alive-primary' };
    // 陈旧 → 回收重试一次
    try { await fs.unlink(lockPath); } catch { /* 忽略 */ }
    try {
      await fs.writeFile(lockPath, content, { flag: 'wx', mode: 0o600 });
      return { acquired: true, reason: 'reclaimed-stale' };
    } catch {
      return { acquired: false, reason: 'reclaim-race-lost' };
    }
  }
}

/** 读主心跳 (不存在 → null; 坏内容 → ok:false) */
export async function readPrimaryHeartbeat(home: string = os.homedir()): Promise<HeartbeatParseResult | null> {
  try {
    const raw = await fs.readFile(heartbeatPath('primary', home), 'utf-8');
    return parseHeartbeat(raw);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null; // 主心跳还没写过 = 缺失
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

/** 当前活跃 runIds: 扫 runs 目录里 status ∈ running/recovering/interrupted 的 run */
export async function collectActiveRunIds(runsDir: string, now = Date.now()): Promise<string[]> {
  try {
    const names = await fs.readdir(runsDir);
    const out: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.endsWith('.bak')) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(runsDir, n), 'utf-8'));
        if (rec && typeof rec.status === 'string' && ['running', 'recovering', 'interrupted'].includes(rec.status)) {
          out.push(n.replace(/\.json$/, ''));
        }
      } catch { /* 坏 run 文件跳过 */ }
    }
    return out;
  } catch { return []; }
}

