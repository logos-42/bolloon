/**
 * plan-store.ts — 轻量 plan / todo / review 原语 (2026-08-02)
 *
 * 补齐 agent 执行闭环里的显式环节:
 *   - plan:    执行前显式列出步骤 (LLM 写计划)
 *   - todo:    步骤级状态 (pending / done / blocked), 执行中勾选
 *   - review:  执行后审查 (对照计划看完成度, 产出结论)
 *
 * 设计原则 (减法):
 *   - 不建数据库. 落盘 = ~/.bolloon/plans/<planId>.json (单文件, append 不适用, 直接重写)
 *   - 不引入新调度. 工具入口在 pi-sdk-tools.ts 注册, 复用现有 LLM 调度.
 *   - 任何 IO 失败静默返回 error 对象, 不阻塞主对话.
 *   - plan 上下文注入: create_plan 后会把计划摘要写回 messageHistory (由工具返回, LLM 自己看到),
 *     同时 planId 存 session, 后续 update_plan / review_plan 按 planId 操作.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================
// 数据结构
// ============================================================

export type PlanStepStatus = 'pending' | 'done' | 'blocked';

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  /** 完成/阻塞时的备注 (可选) */
  note?: string;
  updatedAt?: string;
}

export interface Plan {
  planId: string;
  /** 一句话目标 (用户原话或 LLM 提炼) */
  goal: string;
  /** 创建者: user / agent / peer */
  createdBy: 'user' | 'agent' | 'peer';
  createdAt: string;
  /** 来源 channel (审计) */
  originChannel: string;
  steps: PlanStep[];
  /** review 结论 (review_plan 写入) */
  review?: {
    completedSteps: number;
    totalSteps: number;
    summary: string;
    reviewedAt: string;
  };
  /** plan 状态: active / done / abandoned */
  status: 'active' | 'done' | 'abandoned';
  updatedAt: string;
  /**
   * 2026-10-01 (落实④): **单调递增版本号** —— 每次写入 +1。
   * 作用: 并发写入方可以带 `expectedRev` 提交, 版本对不上就**拒收**(而不是默默覆盖别人的更新)。
   * 也供 UI 侧丢弃过期快照。
   */
  rev: number;
}

// ============================================================
// 落盘路径
// ============================================================

export function getPlansDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'plans');
}

export function getPlanPath(planId: string, home: string = os.homedir()): string {
  return path.join(getPlansDir(home), `${planId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function sanitizePlanId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ============================================================
// CRUD
// ============================================================

export interface CreatePlanInput {
  goal: string;
  steps: string[];
  createdBy?: 'user' | 'agent' | 'peer';
  originChannel?: string;
}

export async function createPlan(input: CreatePlanInput, home?: string): Promise<{ ok: boolean; plan?: Plan; error?: string }> {
  const goal = String(input.goal || '').trim();
  const steps = Array.isArray(input.steps) ? input.steps.map(s => String(s).trim()).filter(Boolean) : [];
  if (!goal) return { ok: false, error: 'goal 必填' };
  if (steps.length === 0) return { ok: false, error: 'steps 至少 1 步' };

  const now = new Date().toISOString();
  const planId = `plan_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const plan: Plan = {
    // 初始版本 (落实④: 单调递增版本号, 供乐观并发)
    rev: 1,
    planId,
    goal,
    createdBy: input.createdBy || 'agent',
    createdAt: now,
    originChannel: input.originChannel || '',
    steps: steps.map((s, i) => ({
      id: `step_${i + 1}`,
      description: s,
      status: 'pending',
    })),
    status: 'active',
    updatedAt: now,
  };

  try {
    const dir = getPlansDir(home);
    await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getPlanPath(planId, home), JSON.stringify(plan, null, 2), 'utf-8');
    return { ok: true, plan };
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e?.message || String(e)}` };
  }
}

export async function loadPlan(planId: string, home?: string): Promise<Plan | null> {
  try {
    const raw = await fs.readFile(getPlanPath(planId, home), 'utf-8');
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

async function savePlan(plan: Plan, home?: string): Promise<void> {
  plan.updatedAt = new Date().toISOString();
  await fs.writeFile(getPlanPath(plan.planId, home), JSON.stringify(plan, null, 2), 'utf-8');
}

export interface UpdatePlanInput {
  /** 勾选完成 / 标记阻塞 */
  stepId?: string;
  status?: PlanStepStatus;
  note?: string;
  /** 追加新步骤 (数组, 可选) */
  appendSteps?: string[];
  /** 结束计划 */
  finish?: boolean;
  /**
   * 2026-10-01: 乐观并发 —— 传了就要求与当前 rev 一致, 不一致 ⇒ 拒绝并报"已被他人更新"。
   * 不传 = 保持旧行为(无条件写), 兼容既有调用方。
   */
  expectedRev?: number;
}

export async function updatePlan(planId: string, input: UpdatePlanInput, home?: string): Promise<{ ok: boolean; plan?: Plan; error?: string }> {
  const plan = await loadPlan(planId, home);
  if (!plan) return { ok: false, error: `plan '${planId}' 不存在` };

  // 2026-10-01 (落实④): 乐观并发校验 —— 带 expectedRev 且对不上 ⇒ **拒收**, 绝不默默覆盖
  if (typeof input.expectedRev === 'number' && Number.isFinite(input.expectedRev)) {
    const cur = Number((plan as any).rev ?? 1);
    if (input.expectedRev !== cur) {
      return { ok: false, error: `plan '${planId}' 已被更新 (期望 rev=${input.expectedRev}, 实际 rev=${cur}) —— 请重新读取后再改` };
    }
  }

  if (input.stepId && input.status) {
    const step = plan.steps.find(s => s.id === input.stepId);
    if (!step) return { ok: false, error: `步骤 '${input.stepId}' 不存在` };
    step.status = input.status;
    if (input.note) step.note = input.note;
    step.updatedAt = new Date().toISOString();
  }

  if (Array.isArray(input.appendSteps) && input.appendSteps.length > 0) {
    for (const s of input.appendSteps) {
      const desc = String(s).trim();
      if (!desc) continue;
      plan.steps.push({ id: `step_${plan.steps.length + 1}`, description: desc, status: 'pending' });
    }
  }

  if (input.finish) {
    plan.status = 'done';
    // 未完成的步骤标 blocked (收尾语义)
    for (const s of plan.steps) {
      if (s.status === 'pending') s.status = 'blocked';
    }
  }

  // 2026-10-01 (落实④): 每次成功更新 ⇒ rev **单调递增** (乐观并发的基础; 也供 UI 丢弃过期快照)
  plan.rev = Number((plan as any).rev ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();

  try {
    await savePlan(plan, home);
    return { ok: true, plan };
  } catch (e: any) {
    return { ok: false, error: `保存失败: ${e?.message || String(e)}` };
  }
}

export async function reviewPlan(planId: string, summary: string, home?: string): Promise<{ ok: boolean; plan?: Plan; error?: string }> {
  const plan = await loadPlan(planId, home);
  if (!plan) return { ok: false, error: `plan '${planId}' 不存在` };

  const completedSteps = plan.steps.filter(s => s.status === 'done').length;
  plan.review = {
    completedSteps,
    totalSteps: plan.steps.length,
    summary: String(summary || '').trim() || `完成 ${completedSteps}/${plan.steps.length} 步`,
    reviewedAt: new Date().toISOString(),
  };
  plan.status = 'done';

  try {
    await savePlan(plan, home);
    return { ok: true, plan };
  } catch (e: any) {
    return { ok: false, error: `保存失败: ${e?.message || String(e)}` };
  }
}

export async function listActivePlans(home?: string): Promise<Plan[]> {
  const dir = getPlansDir(home);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Plan[] = [];
  for (const f of entries.filter(f => f.endsWith('.json')).sort().slice(-50)) {
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const p = JSON.parse(raw) as Plan;
      if (p.status === 'active') out.push(p);
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 把 plan 渲染成注入 context 的文本 (LLM 看到计划 + 进度) */
export function planToContext(plan: Plan): string {
  const lines = [`📋 当前计划: ${plan.goal} (${plan.planId})`];
  for (const s of plan.steps) {
    const mark = s.status === 'done' ? '✅' : s.status === 'blocked' ? '⛔' : '⬜';
    lines.push(`  ${mark} ${s.id}: ${s.description}${s.note ? ` — ${s.note}` : ''}`);
  }
  if (plan.review) {
    lines.push(`  📝 审查: ${plan.review.summary} (${plan.review.completedSteps}/${plan.review.totalSteps} 步)`);
  }
  return lines.join('\n');
}


/**
 * 待办/计划重注入 (2026-10-01 落实④)。
 *
 * 为什么必须**每轮**注入: 上下文压缩会把早先注入的计划文本丢掉 —— 一旦丢了, 智能体就"忘了自己在做什么"。
 * 所以注入不是一次性动作, 而是每轮带上**当前**计划(有界: 条数与字符都封顶, 免得计划本身吃爆上下文)。
 * 与既有 `planToContext` 的分工: 那个给单条 plan 用; 这个给"当前活跃计划一览"用。
 */
export function formatPlansForPrompt(plans: Plan[], opts: { maxChars?: number; maxItems?: number } = {}): string {
  const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars as number) > 0 ? Math.floor(opts.maxChars as number) : 1200;
  const maxItems = Number.isFinite(opts.maxItems) && (opts.maxItems as number) > 0 ? Math.floor(opts.maxItems as number) : 3;
  const active = (plans || []).filter((p) => p && p.status === 'active').slice(0, maxItems);
  if (!active.length) return '';
  const lines: string[] = ['## 我在做的 (每轮重注入, 压缩后也不会丢)'];
  for (const p of active) {
    const done = p.steps.filter((x) => x.status === 'done').length;
    lines.push(`- [${done}/${p.steps.length}] ${p.goal}  (rev ${Number((p as any).rev ?? 1)})`);
    for (const st of p.steps.filter((x) => x.status !== 'done').slice(0, 5)) {
      lines.push(`    · (${st.status}) ${st.description}`);
    }
  }
  const out = lines.join('\n');
  return out.length <= maxChars ? out : out.slice(0, maxChars) + '\n…[计划列表已截断]';
}
