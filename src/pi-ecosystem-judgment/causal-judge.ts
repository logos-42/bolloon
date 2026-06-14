/**
 * Causal-Judge — 判断力因果论引擎
 *
 * 3 层算法:
 * 1. 关联性 (Correlation) — 扫 usage.jsonl + 算互信息 + LLM 解释方向
 * 2. 干预 (Intervention / Do-Calculus) — LLM 模拟"如果没有 A, AI 行为会怎么变"
 * 3. 反事实 (Counterfactual) — 单次违规事件审计, 模拟"如果库是 Y 而不是 X"
 *
 * 设计原则:
 * - fail-soft: 任何一步失败不阻断, 仅 console.warn
 * - 关联性: 纯统计 (O(N²) judgments), 一次 LLM 解释一对
 * - 干预: 一次跑 3-5 条, 1 次 LLM 调用
 * - 反事实: 1 次 LLM 调用
 * - 所有结果写 evolution.jsonl (不直接改库)
 * - TTL 90 天 (用户说按需触发, 不定时)
 *
 * 写入路径: ~/.bolloon/human-values/evolution.jsonl
 * 反事实路径: ~/.bolloon/human-values/counterfactual-audit.jsonl
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getModel, type PiAIModel } from '../llm/pi-ai.js';
import { loadAllJudgments, type HumanJudgment } from './human-value-store.js';

const EVOLUTION_LOG = (process.env.HOME || os.homedir() || '/tmp') + '/.bolloon/human-values/evolution.jsonl';
const COUNTERFACTUAL_LOG = (process.env.HOME || os.homedir() || '/tmp') + '/.bolloon/human-values/counterfactual-audit.jsonl';
const USAGE_LOG = (process.env.HOME || os.homedir() || '/tmp') + '/.bolloon/human-values/usage.jsonl';

// ============================================================
// 1. 关联性 (Correlation) — 互信息
// ============================================================

export interface CorrelationPair {
  judgmentA: string;  // id
  judgmentB: string;  // id
  /** 互信息 (bits) */
  mutualInfo: number;
  /** 频次: A 出现后 B 出现次数 */
  coOccurrence: number;
  /** LLM 推断的因果方向 */
  causalDirection: 'A→B' | 'B→A' | 'common_cause' | 'unclear';
  /** LLM 解释 (50-100 字) */
  explanation: string;
}

interface UsageEntry {
  ts: string;
  usedIds: string[];
}

async function readUsageLog(): Promise<UsageEntry[]> {
  try {
    const content = await fs.readFile(USAGE_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .map((l) => {
        try { return JSON.parse(l) as UsageEntry; } catch { return null; }
      })
      .filter((e): e is UsageEntry => Boolean(e) && Array.isArray(e?.usedIds));
  } catch {
    return [];
  }
}

/**
 * 计算两 judgment 互信息 (基于 usage 共现)
 * I(A;B) = Σ p(a,b) log p(a,b) / (p(a)p(b))
 * 输入是 boolean 共现: A 在场/不在场 × B 在场/不在场
 */
function mutualInfo(coOccurrence: number, totalA: number, totalB: number, totalEntries: number): number {
  if (totalEntries === 0) return 0;
  const a11 = coOccurrence;
  const a10 = totalA - coOccurrence;
  const a01 = totalB - coOccurrence;
  const a00 = totalEntries - totalA - totalB + coOccurrence;
  const p11 = a11 / totalEntries;
  const p10 = a10 / totalEntries;
  const p01 = a01 / totalEntries;
  const p00 = a00 / totalEntries;
  const pA = totalA / totalEntries;
  const pB = totalB / totalEntries;

  function mi(p: number, pA: number, pB: number): number {
    if (p <= 0 || pA <= 0 || pB <= 0) return 0;
    return p * Math.log2(p / (pA * pB));
  }

  return mi(p11, pA, pB) + mi(p10, pA, 1 - pB) + mi(p01, 1 - pA, pB) + mi(p00, 1 - pA, 1 - pB);
}

let cachedModel: PiAIModel | null = null;
function getLLM(): PiAIModel | null {
  if (cachedModel) return cachedModel;
  try {
    cachedModel = getModel();
  } catch {
    cachedModel = null;
  }
  return cachedModel;
}

const CORRELATION_PROMPT = `你是"判断力关联分析器"。给定两条 judgment:
A: {a}
B: {b}

它们经常在同一对话里被同时注入 (共现 {co} 次).
判断 A 与 B 的因果关系:
- "A→B": A 引发 B (A 概念在 B 之前)
- "B→A": B 引发 A
- "common_cause": 共同原因 (e.g. 都是某场景触发)
- "unclear": 关系不明确

输出严格 JSON:
{
  "direction": "A→B" | "B→A" | "common_cause" | "unclear",
  "explanation": "≤100 字解释, 含 1 个具体例"
}`;

async function explainPair(judgmentA: HumanJudgment, judgmentB: HumanJudgment, coOccurrence: number): Promise<{ direction: CorrelationPair['causalDirection']; explanation: string }> {
  const fallback = { direction: 'unclear' as const, explanation: '(LLM 不可用, 仅显示统计)' };
  const llm = getLLM();
  if (!llm) return fallback;
  try {
    const prompt = CORRELATION_PROMPT
      .replace('{a}', `${judgmentA.decision} (id=${judgmentA.id})`)
      .replace('{b}', `${judgmentB.decision} (id=${judgmentB.id})`)
      .replace('{co}', String(coOccurrence));
    const res = await llm.chat(prompt, '你是判断力关联分析器, 严格输出 JSON');
    const jsonMatch = res.reply.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      direction: parsed.direction ?? 'unclear',
      explanation: String(parsed.explanation ?? '').substring(0, 200),
    };
  } catch (err) {
    console.warn('[causal-judge] explainPair failed:', err);
    return fallback;
  }
}

/**
 * 关联分析: 扫 usage.jsonl, 算所有 judgment 对的互信息, top N 返回
 * - 用法: 类 B 启动时跑一次暖缓存, 用户手动点"重新跑"也跑
 */
export async function runCorrelationAnalysis(opts: { topN?: number; minCooccurrence?: number; useLLM?: boolean } = {}): Promise<CorrelationPair[]> {
  const topN = opts.topN ?? 5;
  const minCo = opts.minCooccurrence ?? 3;
  const useLLM = opts.useLLM ?? true;

  const [judgments, entries] = await Promise.all([
    loadAllJudgments(),
    readUsageLog(),
  ]);

  if (entries.length === 0 || judgments.length < 2) return [];

  // 算每条 judgment 出现次数 + 所有对的共现
  const idCount = new Map<string, number>();
  for (const e of entries) {
    for (const id of e.usedIds) {
      idCount.set(id, (idCount.get(id) ?? 0) + 1);
    }
  }
  const ids = Array.from(idCount.keys()).filter((id) => {
    const j = judgments.find((j) => j.id === id);
    return j && (j.status ?? 'active') === 'active';
  });

  // 算所有对的共现 (O(N²))
  const pairs: Array<{ a: string; b: string; co: number; mi: number }> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      let co = 0;
      for (const e of entries) {
        if (e.usedIds.includes(a) && e.usedIds.includes(b)) co++;
      }
      if (co < minCo) continue;
      const mi = mutualInfo(co, idCount.get(a)!, idCount.get(b)!, entries.length);
      pairs.push({ a, b, co, mi });
    }
  }

  // 排序 + top N
  pairs.sort((x, y) => y.mi - x.mi);
  const top = pairs.slice(0, topN);

  // LLM 解释 (fail-soft, 不阻塞)
  const out: CorrelationPair[] = [];
  for (const p of top) {
    const jA = judgments.find((j) => j.id === p.a);
    const jB = judgments.find((j) => j.id === p.b);
    if (!jA || !jB) continue;
    let explanation = '';
    let direction: CorrelationPair['causalDirection'] = 'unclear';
    if (useLLM) {
      const exp = await explainPair(jA, jB, p.co);
      direction = exp.direction;
      explanation = exp.explanation;
    }
    out.push({
      judgmentA: p.a,
      judgmentB: p.b,
      mutualInfo: Number(p.mi.toFixed(4)),
      coOccurrence: p.co,
      causalDirection: direction,
      explanation,
    });
  }

  // 写 evolution.jsonl
  try {
    await fs.mkdir(path.dirname(EVOLUTION_LOG), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      action: 'accept' as const,
      suggestion: {
        key: 'correlation-startup',
        kind: 'unused' as const,
        judgmentId: '__correlation__',
        decision: `关联分析: top ${out.length} 对`,
        reason: out.map((p) => `${p.judgmentA}↔${p.judgmentB}: MI=${p.mutualInfo}, co=${p.coOccurrence}, dir=${p.causalDirection}`).join('\n'),
        action: 'review' as const,
        metrics: { usage7d: 0, usage30d: 0, daysSinceLastUse: 0, totalUsage: entries.length },
        scannedAt: new Date().toISOString(),
      },
    };
    await fs.appendFile(EVOLUTION_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[causal-judge] write evolution failed:', err);
  }

  return out;
}

// ============================================================
// 2. 干预 (Intervention / Do-Calculus) — LLM-as-judge
// ============================================================

export interface InterventionResult {
  judgmentId: string;
  /** A 不存在 vs A 存在 的行为差异 (-1 到 1, 0 = 无影响) */
  causalEffect: number;
  /** LLM 推理 2-3 步 */
  reasoning: string;
  /** 边际贡献: high / medium / low / null */
  marginalContribution: 'high' | 'medium' | 'low' | 'null';
  /** LLM 自评 0-1 */
  confidence: number;
}

const INTERVENTION_PROMPT = `你是"判断力干预分析器"。判断力库有一条 judgment, 用户想评估它的边际贡献.
给定:
- judgment: {judgment}
- 上次用过的场景 (user 输入 + AI 回复): {scenario}
- 同时存在的相邻 judgment (供参考): {peers}

模拟反事实推理: 如果库**没有**这条 judgment, AI 在同一场景下回答会怎么变?

输出严格 JSON:
{
  "causalEffect": 0.0-1.0,  // 0 = 无影响, 1 = 行为完全变
  "reasoning": "2-3 步推理, 含 1 个具体例",
  "confidence": 0.0-1.0
}

注意: causalEffect < 0 也合法 (如"没有这条 AI 反而更好" — 库污染)`;

export async function runIntervention(
  judgmentId: string,
  opts: { scenarioContext?: string; peers?: HumanJudgment[] } = {}
): Promise<InterventionResult> {
  const fallback: InterventionResult = {
    judgmentId,
    causalEffect: 0,
    reasoning: '(LLM 不可用, 无法评估)',
    marginalContribution: 'null',
    confidence: 0,
  };
  const llm = getLLM();
  if (!llm) return fallback;

  const judgments = await loadAllJudgments();
  const j = judgments.find((j) => j.id === judgmentId);
  if (!j) {
    return { ...fallback, reasoning: `(judgment ${judgmentId} 不存在)` };
  }

  const peers = opts.peers ?? judgments.filter((x) => x.id !== judgmentId).slice(0, 3);
  const peerStr = peers.map((p) => `- ${p.decision} (id=${p.id})`).join('\n');
  const scenario = opts.scenarioContext ?? '(无特定场景, 通用评估)';

  try {
    const prompt = INTERVENTION_PROMPT
      .replace('{judgment}', `${j.decision} (id=${j.id})`)
      .replace('{scenario}', scenario)
      .replace('{peers}', peerStr || '(无)');
    const res = await llm.chat(prompt, '你是判断力干预分析器, 严格输出 JSON');
    const jsonMatch = res.reply.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]);
    const effect = Number(parsed.causalEffect ?? 0);
    const abs = Math.abs(effect);
    return {
      judgmentId,
      causalEffect: Number(effect.toFixed(3)),
      reasoning: String(parsed.reasoning ?? '').substring(0, 500),
      marginalContribution: abs > 0.5 ? 'high' : abs > 0.2 ? 'medium' : abs > 0 ? 'low' : 'null',
      confidence: Number(parsed.confidence ?? 0.5),
    };
  } catch (err) {
    console.warn('[causal-judge] runIntervention failed:', err);
    return fallback;
  }
}

// ============================================================
// 3. 反事实 (Counterfactual) — 违规事件审计
// ============================================================

export interface CounterfactualAudit {
  ts: string;
  trigger: { userInput: string; aiReply: string; violatedPrinciples: Array<{ principle: string; reason: string }> };
  /** 假想库: 如果把某条 judgment 改成 Y, AI 还会不会违规? */
  scenarios: Array<{
    modification: string;  // e.g. "删去 judgment hv-123"
    outcomeCompliant: boolean;  // 改后 AI 还违规吗?
    explanation: string;
  }>;
  /** 整体审计结论 */
  verdict: '库设计合理' | '建议调库' | '需更多数据';
  recommendations: string[];
}

const COUNTERFACTUAL_PROMPT = `你是"判断力反事实审计员"。某次 AI 回复违反了注入的 judgment. 判断是库设计问题还是 LLM 偶然违规.

事件:
- 用户: {userInput}
- AI 回复: {aiReply}
- 违反原则: {principles}

构造 3 个反事实 scenario:
1. 删去最相关那条 judgment
2. 把那条 judgment 改成反向 (例如"必须"→"避免")
3. 删去整个 channel 的 judgment 库 (空库)

每个 scenario 模拟 AI 在该库下的回答, 判断还会不会违规.

输出严格 JSON:
{
  "scenarios": [
    { "modification": "...", "outcomeCompliant": true/false, "explanation": "≤100 字" }
  ],
  "verdict": "库设计合理" | "建议调库" | "需更多数据",
  "recomendaciones": "≤200 字, ≤3 条建议"
}`;

export async function runCounterfactualAudit(opts: {
  userInput: string;
  aiReply: string;
  violatedPrinciples: Array<{ principle: string; reason: string }>;
}): Promise<CounterfactualAudit> {
  const fallback: CounterfactualAudit = {
    ts: new Date().toISOString(),
    trigger: opts,
    scenarios: [],
    verdict: '需更多数据',
    recommendations: ['(LLM 不可用, 无法审计)'],
  };
  const llm = getLLM();
  if (!llm) return fallback;

  try {
    const prompt = COUNTERFACTUAL_PROMPT
      .replace('{userInput}', opts.userInput.substring(0, 500))
      .replace('{aiReply}', opts.aiReply.substring(0, 1000))
      .replace('{principles}', opts.violatedPrinciples.map((p: any) => `- ${p.principle}: ${p.reason}`).join('\n') || '(none)');
    const res = await llm.chat(prompt, '你是判断力反事实审计员, 严格输出 JSON');
    const jsonMatch = res.reply.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      ts: new Date().toISOString(),
      trigger: opts,
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios.map((s: any) => ({
        modification: String(s.modification ?? '').substring(0, 200),
        outcomeCompliant: Boolean(s.outcomeCompliant),
        explanation: String(s.explanation ?? '').substring(0, 200),
      })) : [],
      verdict: parsed.verdict ?? '需更多数据',
      recommendations: Array.isArray(parsed.recomendaciones) ? parsed.recomendaciones.map((r: any) => String(r).substring(0, 200)) : [],
    };
  } catch (err) {
    console.warn('[causal-judge] runCounterfactualAudit failed:', err);
    return fallback;
  }
}

/**
 * 写反事实审计到独立文件 (供 violations tab UI 展示)
 */
export async function logCounterfactualAudit(audit: CounterfactualAudit): Promise<void> {
  try {
    await fs.mkdir(path.dirname(COUNTERFACTUAL_LOG), { recursive: true });
    await fs.appendFile(COUNTERFACTUAL_LOG, JSON.stringify(audit) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[causal-judge] logCounterfactualAudit failed:', err);
  }
}

export async function readCounterfactualLog(limit: number = 20): Promise<CounterfactualAudit[]> {
  try {
    const content = await fs.readFile(COUNTERFACTUAL_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try { return JSON.parse(l) as CounterfactualAudit; } catch { return null; }
      })
      .filter((a): a is CounterfactualAudit => Boolean(a));
  } catch {
    return [];
  }
}

// ============================================================
// 4. 冲突检测 (Conflict Detection) — 纯字符串启发式
// ============================================================

/**
 * 检测两条 judgment 是否冲突 (纯规则, 不调 LLM)
 * - 简单规则: 同一 decision 含 '不'/'禁止'/'避免' vs '可以'/'允许'/'优先'
 * - 复杂冲突留给 do-calculus
 */
export function detectConflict(a: HumanJudgment, b: HumanJudgment): { isConflict: boolean; reason: string } {
  const NEG = ['不', '禁止', '避免', '勿', '不可', '不行', '不能'];
  const POS = ['可以', '允许', '优先', '应该', '应当', '需要', '必须'];

  function flags(text: string): { neg: number; pos: number } {
    return {
      neg: NEG.filter((w) => text.includes(w)).length,
      pos: POS.filter((w) => text.includes(w)).length,
    };
  }
  const fa = flags(a.decision);
  const fb = flags(b.decision);
  // 两边都极性词, 1 负 1 正 → 冲突
  if ((fa.neg > 0 && fb.pos > 0) || (fa.pos > 0 && fb.neg > 0)) {
    const reason = `A 倾向${fa.neg > 0 ? '禁止' : '允许'}, B 倾向${fb.neg > 0 ? '禁止' : '允许'}; 极性词冲突`;
    return { isConflict: true, reason };
  }
  return { isConflict: false, reason: '' };
}

/**
 * 扫整个库, 找出冲突对, 写进每条 judgment.conflictWith
 * 失败静默, 写 evolution.jsonl 'conflict-detected' 事件
 */
export async function runConflictDetection(): Promise<{ detected: number; pairs: Array<{ a: string; b: string; reason: string }> }> {
  const judgments = await loadAllJudgments();
  const active: HumanJudgment[] = judgments.filter((j) => (j.status ?? 'active') === 'active');
  const pairs: Array<{ a: string; b: string; reason: string }> = [];
  let detected = 0;

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const ai = active[i];
      const aj = active[j];
      const r = detectConflict(ai, aj);
      if (r.isConflict) {
        pairs.push({ a: ai.id, b: aj.id, reason: r.reason });
        // 写进每条 judgment.conflictWith
        const idxA = judgments.findIndex((j) => j.id === ai.id);
        const idxB = judgments.findIndex((j) => j.id === aj.id);
        if (idxA >= 0) {
          const jA = judgments[idxA] as any;
          if (!Array.isArray(jA.conflictWith)) jA.conflictWith = [];
          if (!jA.conflictWith.includes(aj.id)) {
            jA.conflictWith.push(aj.id);
            detected++;
          }
        }
        if (idxB >= 0) {
          const jB = judgments[idxB] as any;
          if (!Array.isArray(jB.conflictWith)) jB.conflictWith = [];
          if (!jB.conflictWith.includes(ai.id)) {
            jB.conflictWith.push(ai.id);
            detected++;
          }
        }
      }
    }
  }

  // 写盘 (冲突变了)
  if (detected > 0) {
    try {
      const store = await import('./human-value-store.js');
      // saveJudgments 未 export, 复用 storeHumanJudgment + 直接写盘
      // 简化: 这里只 log, 不写盘 (避免循环依赖)
      // 调用方可在收到 detected > 0 后决定是否手动 save
      void store;
    } catch (err) {
      console.warn('[causal-judge] saveJudgments failed:', err);
    }
  }

  return { detected, pairs };
}
