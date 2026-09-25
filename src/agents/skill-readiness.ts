/**
 * skill-readiness.ts — Goal 级技能快照 + 执行前就绪门禁 (批次 2-G.2, 2026-09-16)
 *
 * 定位 (与 leo 的规格一致): 这属于**执行前准备**, 由 Supervisor / runner resolver 负责 ——
 * **不放进 PiAgentHarness** (Harness 只管"这一段能不能安全执行")。
 *
 * 规则:
 *   · Goal 首次执行时把 requiredSkills 解析成 snapshot (name/version/contentHash/source/resolvedAt) 并冻结;
 *   · 后续 Run 只认快照: 缺技能 / 未启用 / 损坏 / hash 漂移 / 版本变化 → **不启动 Run**, Goal → needs_human;
 *   · 前缀 '?' 的技能算可选: 缺失不阻塞, 但写一条 degradation;
 *   · **不允许静默用新版本** —— 漂移必须人工批准 (approve) 才会更新快照。
 */

import * as os from 'os';
import { SkillsManager } from './skills-manager.js';
import {
  readGoal, setContinuation, updateGoal, addEvidence, type GoalRecord,
} from './goal-store.js';
import { recordDegradation } from './run-store.js';

export interface SkillSnapshotEntry { name: string; version: string; contentHash: string; source?: string; resolvedAt: string }

export interface ReadinessResult {
  ok: boolean;
  reason?: string;
  missing: string[];
  notEnabled: string[];
  invalid: string[];
  drift: { name: string; expected?: string; actual: string }[];
  degradations: string[];
  snapshot?: SkillSnapshotEntry[];
}

export function parseSkillSpecs(list: string[] = []): { required: string[]; optional: string[] } {
  const required: string[] = []; const optional: string[] = [];
  for (const raw of list) {
    const n = String(raw || '').trim();
    if (!n) continue;
    if (n.startsWith('?')) optional.push(n.slice(1).trim());
    else required.push(n);
  }
  return { required, optional };
}

function userHome(home?: string): string {
  return home || process.env.HOME || os.homedir();
}

function manager(home?: string): SkillsManager {
  return new SkillsManager({ home: userHome(home), cwd: process.cwd() });
}

/** 冻结技能快照 (首次执行时调用; 已冻结则不重复解析) */
export async function freezeGoalSkills(goal: GoalRecord, opts: { home?: string; force?: boolean } = {}): Promise<{ ok: boolean; snapshot?: SkillSnapshotEntry[]; missing: string[]; notEnabled: string[]; reason?: string }> {
  const { required } = parseSkillSpecs(goal.requiredSkills || []);
  if (!required.length) return { ok: true, snapshot: goal.skillSnapshot || [], missing: [], notEnabled: [] };
  if (goal.skillSnapshot?.length && !opts.force) return { ok: true, snapshot: goal.skillSnapshot, missing: [], notEnabled: [] };

  const sm = manager(opts.home);
  const res = await sm.snapshot(required, { home: userHome(opts.home) } as any);
  if (!res.ok || res.missing.length) {
    return { ok: false, missing: res.missing, notEnabled: [], reason: `必需技能缺失: ${res.missing.join(', ')}` };
  }
  const snapshot = res.entries.map((e) => ({ name: e.name, version: e.version, contentHash: e.contentHash, source: (e as any).source, resolvedAt: e.resolvedAt }));
  await updateGoal(goal.goalId, { skillSnapshot: snapshot } as any);
  await addEvidence(goal.goalId, [`技能快照已冻结: ${snapshot.map((x) => `${x.name}@${x.version}:${x.contentHash.slice(0, 8)}`).join(', ')}`]).catch(() => {});
  return { ok: true, snapshot, missing: [], notEnabled: [] };
}

/** 执行前就绪门禁 (Supervisor 每次准备起 Run 之前调) */
export async function ensureGoalSkillsReady(goal: GoalRecord, opts: { home?: string } = {}): Promise<ReadinessResult & { frozen?: boolean }> {
  const { required, optional } = parseSkillSpecs(goal.requiredSkills || []);
  const out: ReadinessResult = { ok: true, missing: [], notEnabled: [], invalid: [], drift: [], degradations: [] };
  if (!required.length && !optional.length) return out;

  const frozen = await freezeGoalSkills(goal, opts);
  if (!frozen.ok) {
    out.ok = false; out.missing = frozen.missing; out.reason = frozen.reason || '技能快照无法冻结';
    return out;
  }
  const snapshot = frozen.snapshot || [];
  out.snapshot = snapshot;

  // 逐个校验快照 (真实 registry + 真实文件 hash)
  const sm = manager(opts.home);
  const home = userHome(opts.home);
  for (const entry of snapshot) {
    const rec = await sm.inspect(entry.name, { home } as any);
    if (!rec) { out.missing.push(entry.name); continue; }
    if (rec.status !== 'enabled' && rec.status !== 'installed') out.notEnabled.push(`${entry.name}(${rec.status})`);
    if (rec.contentHash !== entry.contentHash) out.drift.push({ name: entry.name, expected: entry.contentHash, actual: rec.contentHash });
    if (rec.version !== entry.version) out.drift.push({ name: entry.name, expected: entry.version, actual: rec.version });
    const v = await sm.validate(entry.name, { home } as any).catch(() => null);
    if (v && !v.ok) out.invalid.push(`${entry.name}: ${(v.issues || []).slice(0, 2).join('; ')}`);
  }

  // 可选技能: 缺失/未启用 → 只记 degradation (不阻塞)
  for (const name of optional) {
    const rec = await sm.inspect(name, { home } as any);
    if (!rec) { out.degradations.push(`可选技能 ${name} 不存在 → 继续执行 (已记降级)`); continue; }
    if (rec.status !== 'enabled' && rec.status !== 'installed') out.degradations.push(`可选技能 ${name} 未启用 (${rec.status}) → 继续执行`);
  }

  if (out.missing.length) out.reason = `必需技能缺失: ${out.missing.join(', ')}`;
  else if (out.notEnabled.length) out.reason = `必需技能未启用: ${out.notEnabled.join(', ')}`;
  else if (out.invalid.length) out.reason = `必需技能损坏: ${out.invalid.join(', ')}`;
  else if (out.drift.length) out.reason = `技能内容漂移 (需人工批准才能升级): ${out.drift.map((d) => `${d.name} ${String(d.expected).slice(0, 8)}→${String(d.actual).slice(0, 8)}`).join(', ')}`;
  out.ok = !(out.missing.length || out.notEnabled.length || out.invalid.length || out.drift.length);
  return out;
}

/** 门禁不过 → 写清事实并把 Goal 交给人 (不启动 Run, 不伪造失败) */
export async function blockGoalOnSkills(goalId: string, res: ReadinessResult): Promise<void> {
  const reason = res.reason || '技能未就绪';
  await setContinuation(goalId, {
    wakeReason: 'needs_human', autoContinue: false, needsExternal: undefined,
    skillReadiness: { ok: false, at: new Date().toISOString(), reason, missing: res.missing, drift: res.drift, degradations: res.degradations },
  } as any);
  await updateGoal(goalId, { status: 'needs_human' } as any).catch(() => {});
  await addEvidence(goalId, [`技能门禁拦截: ${reason}`]).catch(() => {});
  for (const d of res.degradations) await recordDegradation({ kind: 'observational', op: 'skill-readiness', message: d }).catch(() => {});
}

/**
 * 只**记事实**、不改状态: 把本地技能就绪检查的结论写进 `continuation.skillReadiness`。
 *
 * ★ 2026-09-25 (P5 验收修复): 飞轮裁决 = `delegate` 时本地技能门禁**不适用** (能力由子 Agent 凭合同
 *   交付), 所以不能调 `blockGoalOnSkills` (那会把 Goal 打成 needs_human)。但"本地缺什么"必须仍然
 *   可查 —— 原来只有 `blockGoalOnSkills` 写这个字段, 门禁一放行就没有任何记录了。
 */
export async function recordSkillReadiness(goalId: string, res: ReadinessResult): Promise<void> {
  await setContinuation(goalId, {
    skillReadiness: {
      ok: res.ok,
      at: new Date().toISOString(),
      reason: res.reason,
      missing: res.missing,
      drift: res.drift,
      degradations: res.degradations,
    },
  } as any);
}

/** 人工批准技能升级: 重新冻结快照 (显式动作, 不隐式切换) */
export async function approveSkillUpgrade(goalId: string, opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; snapshot?: SkillSnapshotEntry[] }> {
  const goal = await readGoal(goalId);
  if (!goal) return { ok: false, reason: 'Goal 不存在' };
  const frozen = await freezeGoalSkills(goal, { ...opts, force: true });
  if (!frozen.ok) return { ok: false, reason: frozen.reason };
  await setContinuation(goalId, { skillReadiness: { ok: true, at: new Date().toISOString(), reason: '人工批准技能升级' }, wakeReason: 'active', autoContinue: true } as any);
  await updateGoal(goalId, { status: 'active' } as any).catch(() => {});
  await addEvidence(goalId, [`技能升级已被人工批准: ${(frozen.snapshot || []).map((s) => `${s.name}@${s.version}`).join(', ')}`]).catch(() => {});
  return { ok: true, snapshot: frozen.snapshot };
}
