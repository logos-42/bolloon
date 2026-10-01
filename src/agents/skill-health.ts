/**
 * 技能用量遥测 + 生命周期 (2026-10-01)。
 * 形态要点: 遥测放**旁挂文件** ✓ —— 绝不写进用户自己写的 SKILL.md ✗(那是用户的文件 ✓)。
 * 生命周期: active → stale(久未用) → archived; `pinned` 可退出自动流转 ✓。
 * 边界(如实): 本模块只**计算状态并给建议** ✓, **不自动移动/删除任何技能文件** ✗(那是破坏性动作, 交人决定 ✓)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function usagePath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills', '.usage.json');
}
export interface SkillUsage { count: number; lastUsedAt: number; createdBy?: 'foreground' | 'review'; pinned?: boolean }

function load(home?: string): Record<string, SkillUsage> {
  try {
    const o = JSON.parse(fs.readFileSync(usagePath(home), 'utf-8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}
function save(m: Record<string, SkillUsage>, home?: string): void {
  try {
    const p = usagePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(m), { mode: 0o600 });
  } catch { /* 遥测失败不影响工具调用 */ }
}

/** 用了一次(读技能时调 ✓); 失败只吞 ✓ */
export function bumpUsage(skill: string, home?: string, now = Date.now()): void {
  try {
    const m = load(home);
    const cur = m[skill] || { count: 0, lastUsedAt: 0 };
    m[skill] = { ...cur, count: cur.count + 1, lastUsedAt: now };
    save(m, home);
  } catch { /* best-effort */ }
}

/** 记下创建者(自审 / 用户点名) */
export function markCreatedBy(skill: string, by: 'foreground' | 'review', home?: string, now = Date.now()): void {
  try {
    const m = load(home);
    const cur = m[skill] || { count: 0, lastUsedAt: 0 };
    m[skill] = { ...cur, createdBy: by, lastUsedAt: cur.lastUsedAt || now };
    save(m, home);
  } catch { /* best-effort */ }
}

/** 钉住(退出自动流转) */
export function setPinned(skill: string, pinned: boolean, home?: string): void {
  try {
    const m = load(home);
    const cur = m[skill] || { count: 0, lastUsedAt: 0 };
    m[skill] = { ...cur, pinned };
    save(m, home);
  } catch { /* best-effort */ }
}

export const STALE_AFTER_MS = 45 * 24 * 3600 * 1000;    // 45 天没用 ⇒ stale

/** 生命周期(只算不给动作 ✓): active / stale / archived-eligible */
export function lifecycleOf(skill: string, home?: string, now = Date.now()):
  { state: 'active' | 'stale' | 'unknown'; reason: string; count: number; pinned: boolean } {
  const u = load(home)[skill];
  if (!u) return { state: 'unknown', reason: '旁挂遥测里没有它(可能是导入/内置技能)', count: 0, pinned: false };
  if (u.pinned) return { state: 'active', reason: '已 pinned(退出自动流转)', count: u.count, pinned: true };
  const idle = now - (u.lastUsedAt || 0);
  return {
    state: idle > STALE_AFTER_MS ? 'stale' : 'active',
    reason: idle > STALE_AFTER_MS ? `已 ${Math.round(idle / 86400000)} 天未用(仅状态, 不会自动删 ✓)` : `近用过(${u.count} 次)`,
    count: u.count,
    pinned: false,
  };
}

/** 汇总(给面板/工具用 ✓) */
export function usageSummary(home?: string, now = Date.now()): { total: number; active: number; stale: number; pinned: number } {
  const m = load(home);
  let active = 0, stale = 0, pinned = 0;
  for (const k of Object.keys(m)) {
    const l = lifecycleOf(k, home, now);
    if (l.pinned) pinned++;
    if (l.state === 'active') active++;
    else if (l.state === 'stale') stale++;
  }
  return { total: Object.keys(m).length, active, stale, pinned };
}
