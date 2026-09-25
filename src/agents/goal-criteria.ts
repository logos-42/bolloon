/**
 * goal-criteria.ts — 判据生成 / 确认 / 跨 Run 证据汇总 (批次 2-F, 2026-09-16)
 *
 * 规则 (与 leo 的规格一致):
 *   · 用户明确给出完成条件 → 直接使用 (criteriaSource = 'user', 已确认);
 *   · 用户没给 → **agent 提候选判据** (criteriaSource = 'agent_proposed', 未确认);
 *     候选判据**不能**直接成为最终完成条件 —— 未确认就永不自动完成;
 *   · 目标过于模糊 / 候选生成失败 → **不自动完成**, 交人 (needs_human);
 *   · 证据跨 Run 汇总 (Run 证据 → Goal 证据, 去重), unresolvedItems 跨 Run 保留。
 */

import {
  readGoal, setCriteria, addEvidence, setUnresolved, updateGoal, type GoalRecord,
} from './goal-store.js';
// 2026-09-25 (M0 接线冻结, 规则 ②): Goal 状态变更只有一个漏斗
import { reduceGoalState } from './goal-state-reducer.js';
import { readRun, type RunRecord } from './run-store.js';

export interface CriteriaProposal {
  ok: boolean;
  criteria: string[];
  /** 生成失败/过于模糊 → 交人 */
  needsHuman?: boolean;
  reason?: string;
}

/** 太模糊的目标: 判据无从谈起 (短且没有可核验的动作词) */
export function looksVague(objective: string): { vague: boolean; reason?: string } {
  const o = String(objective || '').trim();
  if (!o) return { vague: true, reason: '目标为空' };
  const hasVerb = /(写|改|建|加|删|修|跑|测|验证|发布|提交|导出|生成|读|查|部署|完成|实现|接入|更新|安装|配置|整理|对比|汇总)/.test(o);
  if (o.length <= 4 && !hasVerb) return { vague: true, reason: `目标太短且没有可核验动作: "${o}"` };
  if (/^(优化|改进|提升|完善|处理|搞|弄|看看|研究一下)/.test(o) && o.length < 12) {
    return { vague: true, reason: `目标过于笼统: "${o}" (缺可核验的产出)` };
  }
  return { vague: false };
}

/**
 * 从目标推导候选判据 (确定性启发式, 不依赖 LLM —— 生成失败也不会伪造成功)。
 * 候选**必须**经人确认才能用作完成条件。
 */
export function proposeCriteria(objective: string): CriteriaProposal {
  const v = looksVague(objective);
  if (v.vague) return { ok: false, criteria: [], needsHuman: true, reason: `无法生成可核验判据: ${v.reason} → 请补一句"做完的样子"` };

  const o = String(objective).trim();
  const out: string[] = [];
  // 动作拆解: 目标里出现的"动作 + 对象"直接成为候选
  const actions = ['写出', '创建', '修改', '删除', '跑通', '验证', '发布', '提交', '导出', '生成', '读入', '部署', '安装', '配置', '整理', '汇总', '对比'];
  const hits = actions.filter((a) => o.includes(a));
  for (const h of hits.slice(0, 3)) out.push(`完成"${h}"这一步并留下可核验产物`);
  if (!out.length) out.push(`产出与目标一致的结果: ${o.slice(0, 60)}`);
  out.push('有证据可复现 (命令/文件/输出留痕)');
  out.push('没有遗留未解决项');
  return { ok: true, criteria: out.slice(0, 5) };
}

/** 给 Goal 提候选判据 (不确认; 留痕) */
export async function proposeForGoal(goalId: string): Promise<CriteriaProposal> {
  const goal = await readGoal(goalId);
  if (!goal) return { ok: false, criteria: [], needsHuman: true, reason: 'Goal 不存在' };
  if (goal.successCriteria.length && goal.criteriaSource === 'user') {
    return { ok: true, criteria: goal.successCriteria, reason: '用户已给出判据 (不改)' };
  }
  const p = proposeCriteria(goal.objective);
  if (!p.ok) {
    // 太模糊 → 明确交人, 不写假判据 (规则 ②: 状态经 Goal reducer 写; 它同时留一条可追溯证据)
    await reduceGoalState({
      goalId,
      intent: 'criteria_needs_human',
      now: new Date().toISOString(),
      by: 'goal-criteria',
      reason: p.reason,
    }).catch(() => null);
    return p;
  }
  await setCriteria(goalId, { criteria: p.criteria, source: 'agent_proposed', confirm: false });
  await addEvidence(goalId, [`agent 提出候选判据 (待确认): ${p.criteria.join(' / ')}`]).catch(() => {});
  return p;
}

/** 人确认判据 (可同时改内容) */
export async function confirmCriteria(goalId: string, opts: { criteria?: string[]; by?: string } = {}): Promise<{ ok: boolean; reason?: string; goal?: GoalRecord | null }> {
  const goal = await readGoal(goalId);
  if (!goal) return { ok: false, reason: 'Goal 不存在' };
  const criteria = opts.criteria?.length ? opts.criteria : goal.successCriteria;
  if (!criteria.length) return { ok: false, reason: '没有可确认的判据 (先给判据或让 agent 提候选)' };
  const next = await setCriteria(goalId, { criteria, source: opts.criteria?.length ? 'user' : (goal.criteriaSource || 'user'), confirm: true, by: opts.by || 'human' });
  await addEvidence(goalId, [`判据已确认 (v${next?.criteriaVersion}): ${criteria.join(' / ')}`]).catch(() => {});
  return { ok: true, goal: next };
}

// ── 证据汇总 (跨 Run) ───────────────────────────────────────────────────────

export interface EvidenceSummary {
  runs: number;
  runEvidence: string[];
  goalEvidence: string[];
  unresolved: string[];
  lastRunStatus?: string;
}

/** 把 Goal 名下所有 Run 的证据汇总进 Goal.evidence (去重, 保留跨 Run 历史) */
export async function aggregateEvidence(goalId: string): Promise<EvidenceSummary> {
  const goal = await readGoal(goalId);
  if (!goal) return { runs: 0, runEvidence: [], goalEvidence: [], unresolved: [] };
  const runEvidence: string[] = [];
  let lastRunStatus: string | undefined;
  for (const rid of goal.runs || []) {
    const run: RunRecord | null = await readRun(rid).catch(() => null);
    if (!run) continue;
    lastRunStatus = run.status;
    for (const ev of (run.evidence || [])) runEvidence.push(`[${rid.slice(0, 8)} ${run.status}] ${String(ev).slice(0, 200)}`);
  }
  const merged = [...new Set([...(goal.evidence || []), ...runEvidence])].slice(-50);
  if (merged.length !== (goal.evidence || []).length) {
    await updateGoal(goalId, { evidence: merged } as any).catch(() => {});
  }
  return { runs: (goal.runs || []).length, runEvidence, goalEvidence: merged, unresolved: goal.unresolvedItems || [], lastRunStatus };
}

/** 长期完成的整体判据 (给 CLI/Web/Supervisor 一个统一解释) */
export async function longTermStatus(goalId: string): Promise<{ canComplete: boolean; reason: string; checks: Record<string, boolean> }> {
  const goal = await readGoal(goalId);
  if (!goal) return { canComplete: false, reason: 'Goal 不存在', checks: {} };
  const sum = await aggregateEvidence(goalId);
  const checks = {
    hasCriteria: goal.successCriteria.length > 0,
    criteriaConfirmed: goal.criteriaConfirmed === true && goal.criteriaSource !== undefined,
    allSatisfied: goal.successCriteria.length > 0 && goal.successCriteria.every((_, i) => goal.completedCriteria.includes(i)),
    hasEvidence: (sum.goalEvidence || []).length > 0,
    noUnresolved: (goal.unresolvedItems || []).length === 0,
    lastRunHealthy: !sum.lastRunStatus || !['failed', 'interrupted', 'stalled'].includes(String(sum.lastRunStatus)),
  };
  const canComplete = Object.values(checks).every(Boolean);
  const firstFail = Object.entries(checks).find(([, v]) => !v)?.[0];
  const reasonMap: Record<string, string> = {
    hasCriteria: '没有完成判据',
    criteriaConfirmed: '判据未经人确认 (候选判据不算数)',
    allSatisfied: '还有判据没满足',
    hasEvidence: '没有证据',
    noUnresolved: '还有未解决项',
    lastRunHealthy: `最近一条 Run 状态异常 (${sum.lastRunStatus})`,
  };
  return { canComplete, reason: canComplete ? '判据全满足 + 已确认 + 有证据 + 无未解决项' : (reasonMap[firstFail!] || '未满足完成条件'), checks };
}
