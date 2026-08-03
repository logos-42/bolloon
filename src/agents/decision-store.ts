/**
 * decision-store.ts — 决策协议 (Context OS §7, 2026-08-03)
 *
 * Context OS 原则: 重要决策不允许只写结论, 至少要留下可回滚的推理链.
 * 9 要素:
 *   1. 问题到底是什么            → problem
 *   2. 有哪些选项, 包括"不做"     → options[].label (includeDoNothing)
 *   3. 每个选项的时间/金钱/精力/机会成本 → options[].costs
 *   4. 每个选项的短期/长期收益和战略价值 → options[].benefits
 *   5. 风险、概率、影响、是否可恢复       → options[].risks
 *   6. 当前的信息缺口             → infoGaps
 *   7. 推荐方案                  → recommendation
 *   8. 为什么是现在               → timing
 *   9. 失败时的触发条件和回滚动作   → rollback
 *
 * 防止三类错误: 把一时情绪当判断 / 因一条新信息推翻整个项目 / 把不能回滚的重投入当"勇敢".
 * 原则: 新信息只修改它真正证伪的那个假设; 其他部分默认不动.
 *
 * 设计 (减法, 同 plan-store):
 *   - 不建数据库. 落盘 = ~/.bolloon/decisions/<decisionId>.json
 *   - 工具入口在 pi-sdk-tools.ts 注册, 复用现有 LLM 调度.
 *   - 任何 IO 失败静默返回 error 对象, 不阻塞主对话.
 *   - 决策确认 (decideDecision) 后自动 reflect 到 judgeness:
 *     HumanJudgment (storeHumanJudgment, source=trajectory) + JudgenessDescription
 *     (reflectAfterJudgment, openState=locked → Context OS 阶段0 临时价值点).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================
// 数据结构 (9 要素 + 状态机)
// ============================================================

export type DecisionStatus = 'draft' | 'decided' | 'implemented' | 'abandoned' | 'rolled-back';

export interface DecisionOption {
  label: string;
  /** 是否为"不做"选项 */
  includeDoNothing?: boolean;
  /** 时间/金钱/精力/机会成本 */
  costs: string;
  /** 短期/长期收益和战略价值 */
  benefits: string;
  /** 风险、概率、影响、是否可恢复 */
  risks: string;
}

export interface Decision {
  decisionId: string;
  /** 1. 问题到底是什么 */
  problem: string;
  /** 2. 有哪些选项 (含不做) */
  options: DecisionOption[];
  /** 6. 当前的信息缺口 */
  infoGaps: string;
  /** 7. 推荐方案 */
  recommendation: string;
  /** 8. 为什么是现在 */
  timing: string;
  /** 9. 失败时的触发条件和回滚动作 */
  rollback: string;

  context: {
    domain: string;
    stakes: 'low' | 'medium' | 'high' | 'critical';
    by: 'user' | 'agent' | 'peer';
    originChannel: string;
  };

  status: DecisionStatus;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;

  /** 已 reflect 到 judgeness 的记录 (防重复入库) */
  reflection?: {
    hvId: string;
    jdId?: string;
    at: string;
  };
}

// ============================================================
// 落盘路径
// ============================================================

export function getDecisionsDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'decisions');
}

export function getDecisionPath(decisionId: string, home: string = os.homedir()): string {
  return path.join(getDecisionsDir(home), `${decisionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function sanitizeDecisionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ============================================================
// CRUD
// ============================================================

export interface CreateDecisionInput {
  problem: string;
  options: Array<{
    label: string;
    includeDoNothing?: boolean;
    costs?: string;
    benefits?: string;
    risks?: string;
  }>;
  infoGaps?: string;
  recommendation?: string;
  timing?: string;
  rollback?: string;
  domain?: string;
  stakes?: 'low' | 'medium' | 'high' | 'critical';
  by?: 'user' | 'agent' | 'peer';
  originChannel?: string;
}

export async function createDecision(
  input: CreateDecisionInput,
  home?: string
): Promise<{ ok: boolean; decision?: Decision; error?: string }> {
  const problem = String(input.problem || '').trim();
  if (!problem) return { ok: false, error: 'problem 必填 (问题到底是什么)' };
  const options = Array.isArray(input.options)
    ? input.options
        .map((o) => ({
          label: String(o.label || '').trim(),
          includeDoNothing: !!o.includeDoNothing,
          costs: String(o.costs || ''),
          benefits: String(o.benefits || ''),
          risks: String(o.risks || ''),
        }))
        .filter((o) => o.label)
    : [];
  if (options.length === 0) return { ok: false, error: 'options 至少 1 个选项 (含"不做")' };

  const now = new Date().toISOString();
  const decisionId = `dec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const decision: Decision = {
    decisionId,
    problem,
    options,
    infoGaps: String(input.infoGaps || ''),
    recommendation: String(input.recommendation || ''),
    timing: String(input.timing || ''),
    rollback: String(input.rollback || ''),
    context: {
      domain: String(input.domain || '通用'),
      stakes: input.stakes || 'medium',
      by: input.by || 'agent',
      originChannel: String(input.originChannel || ''),
    },
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  try {
    const dir = getDecisionsDir(home);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(getDecisionPath(decisionId, home), JSON.stringify(decision, null, 2), 'utf-8');
    return { ok: true, decision };
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e?.message || String(e)}` };
  }
}

export async function loadDecision(decisionId: string, home?: string): Promise<Decision | null> {
  try {
    const raw = await fs.readFile(getDecisionPath(decisionId, home), 'utf-8');
    return JSON.parse(raw) as Decision;
  } catch {
    return null;
  }
}

async function saveDecision(decision: Decision, home?: string): Promise<void> {
  decision.updatedAt = new Date().toISOString();
  await fs.writeFile(getDecisionPath(decision.decisionId, home), JSON.stringify(decision, null, 2), 'utf-8');
}

export interface UpdateDecisionStatusInput {
  /** 确认决策: 填 recommendation 后状态 → decided (并 reflect 到 judgeness) */
  decide?: boolean;
  /** 标记已执行 */
  implemented?: boolean;
  /** 放弃 / 回滚 (回滚时记录教训) */
  abandon?: boolean;
  rollback?: boolean;
  reason?: string;
  /** 确认时补充推荐方案 (若创建时未填) */
  recommendation?: string;
}

export async function updateDecisionStatus(
  decisionId: string,
  input: UpdateDecisionStatusInput,
  opts: { home?: string; byAgentId?: string } = {}
): Promise<{ ok: boolean; decision?: Decision; error?: string }> {
  const decision = await loadDecision(decisionId, opts.home);
  if (!decision) return { ok: false, error: `decision '${decisionId}' 不存在` };

  const now = new Date().toISOString();
  if (input.decide) {
    if (input.recommendation && input.recommendation.trim()) {
      decision.recommendation = String(input.recommendation).trim();
    }
    if (!decision.recommendation) return { ok: false, error: 'recommendation 必填 (推荐方案)' };
    decision.status = 'decided';
    decision.decidedAt = now;
    // 决策确认 → 自动 reflect 到 judgeness (Context OS 阶段0 入账)
    const refl = await reflectDecisionToJudgeness(decision, opts.byAgentId);
    if (!refl.ok) {
      return { ok: false, error: `决策确认失败 (judgeness 入库): ${refl.error}` };
    }
    decision.reflection = refl.reflection;
  } else if (input.implemented) {
    if (decision.status !== 'decided' && decision.status !== 'implemented') {
      return { ok: false, error: '只能把 decided 的决策标记为 implemented' };
    }
    decision.status = 'implemented';
  } else if (input.rollback || input.abandon) {
    decision.status = input.rollback ? 'rolled-back' : 'abandoned';
    // 回滚/放弃 → 教训入库 (reject 语义, 防重复踩坑)
    const reason = String(input.reason || '');
    if (reason && input.rollback) {
      await reflectRollbackLesson(decision, reason, opts.byAgentId).catch(() => { /* 静默 */ });
    }
  } else {
    return { ok: false, error: '必须指定 decide / implemented / rollback / abandon 之一' };
  }

  await saveDecision(decision, opts.home);
  return { ok: true, decision };
}

export async function listDecisions(status?: DecisionStatus, home?: string): Promise<Decision[]> {
  try {
    const dir = getDecisionsDir(home);
    const files = await fs.readdir(dir);
    const out: Decision[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        const d = JSON.parse(raw) as Decision;
        if (status && d.status !== status) continue;
        out.push(d);
      } catch { /* 单文件损坏跳过 */ }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  } catch {
    return [];
  }
}

/** 决策摘要 → 上下文注入 (9 要素完整可追溯, 上下文只给精简版) */
export function decisionToContext(d: Decision): string {
  const lines: string[] = [`📌 ${d.problem} [${d.status}] (id=${d.decisionId})`];
  for (const o of d.options) {
    const tag = o.includeDoNothing ? ' [不做]' : '';
    lines.push(`  - 选项${tag}: ${o.label}`);
  }
  if (d.recommendation) lines.push(`  推荐: ${d.recommendation}`);
  if (d.infoGaps) lines.push(`  信息缺口: ${d.infoGaps}`);
  if (d.rollback) lines.push(`  回滚条件: ${d.rollback}`);
  if (d.reflection) lines.push(`  ✅ 已入库 judgeness: hv=${d.reflection.hvId}${d.reflection.jdId ? ` jd=${d.reflection.jdId}` : ''}`);
  return lines.join('\n');
}

// ============================================================
// judgeness 反射 (Context OS 阶段0 临时价值点 → HumanJudgment + JudgenessDescription)
// ============================================================

export interface ReflectionResult {
  ok: boolean;
  reflection?: Decision['reflection'];
  error?: string;
}

/** 决策确认后入库: HumanJudgment (source=trajectory) + reflectAfterJudgment (openState=locked) */
export async function reflectDecisionToJudgeness(
  decision: Decision,
  byAgentId?: string
): Promise<ReflectionResult> {
  try {
    const { storeHumanJudgment } = await import('../pi-ecosystem-judgment/human-value-store.js');
    const { reflectAfterJudgment } = await import('../judgeness/reflect.js');

    const decisionText = `${decision.recommendation} (问题: ${decision.problem})`;
    const judgment = await storeHumanJudgment({
      decision: decisionText.slice(0, 300),
      decision_type: 'approve',
      reasons: [
        `选项: ${decision.options.map((o) => o.label).join(' / ')}`,
        `风险: ${decision.options.map((o) => o.risks || '无').join('; ')}`,
        `回滚: ${decision.rollback || '无'}`,
      ].filter(Boolean),
      values_derived: [],
      context: {
        domain: decision.context.domain,
        complexity: decision.context.stakes === 'critical' ? 'profound' : decision.context.stakes === 'high' ? 'complex' : decision.context.stakes === 'medium' ? 'moderate' : 'simple',
        stakes: decision.context.stakes,
        time_pressure: 'medium',
      },
      outcome: { approved: true },
      metadata: { source: 'trajectory', confidence: 0.8, revisable: true },
      status: 'active',
      appliesTo: [],
    });

    const jd = await reflectAfterJudgment(judgment, 'agent', byAgentId).catch(() => null);
    return {
      ok: true,
      reflection: { hvId: judgment.id, jdId: jd?.descriptionId, at: new Date().toISOString() },
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 回滚教训入库: HumanJudgment (reject 语义) — Context OS "失败时的触发条件和回滚动作" */
async function reflectRollbackLesson(
  decision: Decision,
  reason: string,
  byAgentId?: string
): Promise<ReflectionResult> {
  try {
    const { storeHumanJudgment } = await import('../pi-ecosystem-judgment/human-value-store.js');
    const { reflectAfterJudgment } = await import('../judgeness/reflect.js');

    const judgment = await storeHumanJudgment({
      decision: `回滚决策: ${decision.problem} — 失败原因: ${reason.slice(0, 200)}`,
      decision_type: 'reject',
      reasons: [decision.rollback || '', reason].filter(Boolean),
      values_derived: [],
      context: {
        domain: decision.context.domain,
        complexity: 'moderate',
        stakes: decision.context.stakes,
        time_pressure: 'medium',
      },
      outcome: { approved: false, feedback: reason.slice(0, 200) },
      metadata: { source: 'trajectory', confidence: 0.7, revisable: false },
      status: 'active',
      appliesTo: [],
    });

    const jd = await reflectAfterJudgment(judgment, 'agent', byAgentId).catch(() => null);
    return { ok: true, reflection: { hvId: judgment.id, jdId: jd?.descriptionId, at: new Date().toISOString() } };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
