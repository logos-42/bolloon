/**
 * skill-supervisor-link.ts — 技能状态与长期执行的联动 (批次 2-G.4, 2026-09-16)
 *
 * 规则 (与 leo 的规格一致):
 *   · 技能导入成功 / 又能用了 → 被它拦住的 Goal 重新冻结快照并回到 active (等 Supervisor 继续调度);
 *   · 技能被禁用 / 隔离 / 内容漂移 → **不打断正在跑的 Run**, 但下一次 Run 之前 readiness 必然失败 (2-G.2 门禁) → needs_human;
 *   · 漂移**不允许隐式切换版本**: 继续固定旧快照, 或等人工 approve 升级 (approveSkillUpgrade)。
 *
 * 这里只改"该不该继续"的事实, 不直接启动执行 —— 执行权始终在 Supervisor。
 */

import { listGoals } from './goal-store.js';
import { ensureGoalSkillsReady, blockGoalOnSkills, approveSkillUpgrade, parseSkillSpecs } from './skill-readiness.js';
import { SkillsManager } from './skills-manager.js';
import { recordDegradation } from './run-store.js';

export interface ReconsiderResult { rechecked: number; resumed: string[]; stillBlocked: string[] }

/**
 * 重评所有"因技能被拦"的 Goal。
 * @param opts.action 触发原因 (import / enable / disable / quarantine / drift) —— 只用于事实记录
 */
export async function reconsiderSkillBlockedGoals(opts: { home?: string; action?: string; name?: string } = {}): Promise<ReconsiderResult> {
  const out: ReconsiderResult = { rechecked: 0, resumed: [], stillBlocked: [] };
  const home = opts.home;
  const goals = await listGoals({ limit: 200 });
  const interesting = goals.filter((g) => {
    const r = g.continuation?.skillReadiness;
    const specs = parseSkillSpecs(g.requiredSkills || []);
    return (r && r.ok === false) || specs.required.length > 0;
  });

  for (const g of interesting) {
    // 只处理"被技能拦住"的 Goal: 其它原因等人的不要乱动
    const blockedBySkill = g.continuation?.skillReadiness?.ok === false;
    if (!blockedBySkill) continue;
    // 若是被人工标记 needs_human 且与技能无关, 跳过
    out.rechecked++;
    const res = await ensureGoalSkillsReady(g, { home });
    if (res.ok) {
      // 技能恢复了 → 重新冻结快照 + 回 active (Supervisor 下一轮继续)
      const approved = await approveSkillUpgrade(g.goalId, { home });
      if (approved.ok) {
        out.resumed.push(g.goalId);
        console.log(`[skill-link] ${g.goalId} 技能已恢复 (${opts.action || 'unknown'}${opts.name ? `:${opts.name}` : ''}) → 重新冻结快照并回到 active`);
      } else {
        out.stillBlocked.push(g.goalId);
      }
    } else {
      await blockGoalOnSkills(g.goalId, res);
      out.stillBlocked.push(g.goalId);
    }
  }
  return out;
}

/** 技能被禁用/隔离/漂移时, 把依赖它的活跃 Goal 标清事实 (不打断当前 Run) */
export async function markDependentsOfSkill(name: string, opts: { home?: string; reason: string } = { reason: '技能不可用' }): Promise<string[]> {
  const sm = new SkillsManager({ home: opts.home, cwd: process.cwd() });
  const health = await sm.health({ home: opts.home } as any).catch(() => null);
  const goals = await listGoals({ limit: 200 });
  const affected: string[] = [];
  for (const g of goals) {
    const { required } = parseSkillSpecs(g.requiredSkills || []);
    if (!required.includes(name)) continue;
    if (['completed', 'failed', 'abandoned'].includes(g.status)) continue;
    affected.push(g.goalId);
    await recordDegradation({ kind: 'observational', op: 'skill-link', message: `Goal ${g.goalId} 依赖的技能 ${name} 状态: ${JSON.stringify(health?.byStatus || {})} (${opts.reason}) — 下一次 Run 前会重新门禁` }).catch(() => {});
  }
  return affected;
}
