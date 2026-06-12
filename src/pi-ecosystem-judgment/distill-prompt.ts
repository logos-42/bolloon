/**
 * Distill & Evolve Prompts
 * - 蒸馏: 从对话片段提取 1 条 30-80 字的判断力
 * - 演化对齐: 判定新判断力与已有判断力的关系 (merge/contradict/unrelated)
 */

import { getModel, type PiAIModel } from '../llm/pi-ai.js';

export interface DistillTurn {
  role: 'human' | 'agent';
  content: string;
}

export interface DistillResult {
  value: string | null;
  category: 'rule' | 'preference' | 'trajectory' | 'reward';
  confidence: number;
  evidence: string | null;
}

export interface EvolveRelation {
  id: string;
  relation: 'merge' | 'contradict' | 'unrelated';
  reason: string;
}

export interface EvolveResult {
  relations: EvolveRelation[];
}

const DISTILL_SYSTEM_PROMPT = `你是一个"判断力蒸馏器"。从给定的对话片段中,提取出**一条**可以长期复用的判断力原则。

要求:
- 长度 30-80 字(中文字符),软目标 50 字
- 用陈述句,不要"我觉得/我想要"这种主观前缀
- 要有可操作性,能被未来的自己/AI 引用
- 如果对话里没有值得提炼的判断力,返回 {"value": null}

输出格式(严格 JSON,无其他文字):
{
  "value": "<30-80 字的判断力>" | null,
  "category": "rule" | "preference" | "trajectory" | "reward",
  "confidence": 0.0-1.0,
  "evidence": "<原文中支持这句话的关键句,不超过 30 字>"
}`;

const EVOLVE_SYSTEM_PROMPT = `你是"判断力演化对齐器"。对比一条新判断力与已有判断力,判定关系。

新判断力:
{new_value}

已有判断力列表(最多 10 条):
{existing_list}

对每条已有判断力,判定:
- "merge": 新判断力是这条的更新版/具体版/纠正版 → 旧条应被 superseded
- "contradict": 新判断力与这条方向相反(例如"保守"vs"激进") → 旧条应被 superseded
- "unrelated": 两者主题不同,各自保留

输出严格 JSON:
{
  "relations": [
    {"id": "...", "relation": "merge" | "contradict" | "unrelated", "reason": "≤20 字"}
  ]
}`;

let cachedModel: PiAIModel | null = null;

function getDistillModel(): PiAIModel | null {
  if (cachedModel) return cachedModel;
  try {
    cachedModel = getModel();
  } catch {
    cachedModel = null;
  }
  return cachedModel;
}

export async function detectIfWorthStoring(
  turns: DistillTurn[]
): Promise<{ worth: boolean; reason: string }> {
  const fallback = { worth: false, reason: 'llm-unavailable' };
  const model = getDistillModel();
  if (!model) return fallback;

  const conversation = formatTurns(turns);
  const prompt = `请判断以下对话是否包含"值得长期保留的判断力"(用户的偏好/规则/原则/价值观)。
如果包含,返回 {"worth": true, "reason": "≤20 字理由"}
如果不包含,返回 {"worth": false, "reason": "≤20 字理由"}

对话:
${conversation}

输出严格 JSON:`;

  try {
    const res = await withRetry(() => model.chat(prompt, '判断力检测专家'));
    return parseDetectResponse(res.reply, fallback);
  } catch (err) {
    console.warn('[distill-prompt] detectIfWorthStoring failed:', err);
    return fallback;
  }
}

export async function distillFromConversation(
  turns: DistillTurn[]
): Promise<DistillResult> {
  const fallback: DistillResult = {
    value: null,
    category: 'preference',
    confidence: 0,
    evidence: null,
  };
  const model = getDistillModel();
  if (!model) return fallback;

  const conversation = formatTurns(turns);

  const userPrompt = `对话上下文(最多 10 轮):
${conversation}

输出:`;

  try {
    const res = await withRetry(() => model.chat(userPrompt, DISTILL_SYSTEM_PROMPT));
    return parseDistillResponse(res.reply, fallback);
  } catch (err) {
    console.warn('[distill-prompt] distillFromConversation failed:', err);
    return fallback;
  }
}

export async function evolveWithLLM(
  newValue: string,
  existing: Array<{ id: string; value: string }>
): Promise<EvolveResult> {
  const fallback: EvolveResult = { relations: [] };
  const model = getDistillModel();
  if (!model) return fallback;
  if (existing.length === 0) return fallback;

  const existingList = existing
    .map((e, i) => `${i + 1}. [id="${e.id}"] ${e.value}`)
    .join('\n');

  const systemPrompt = EVOLVE_SYSTEM_PROMPT
    .replace('{new_value}', newValue)
    .replace('{existing_list}', existingList);

  const userPrompt = '请输出 JSON:';

  try {
    const res = await withRetry(() => model.chat(userPrompt, systemPrompt));
    return parseEvolveResponse(res.reply, existing, fallback);
  } catch (err) {
    console.warn('[distill-prompt] evolveWithLLM failed:', err);
    return fallback;
  }
}

function formatTurns(turns: DistillTurn[]): string {
  return turns
    .slice(-10)
    .map((t) => {
      const role = t.role === 'human' ? '用户' : 'AI';
      return `${role}: ${t.content}`;
    })
    .join('\n');
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

function extractJson(text: string): unknown | null {
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch { /* fall through */ }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.substring(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

function parseDistillResponse(reply: string, fallback: DistillResult): DistillResult {
  const json = extractJson(reply);
  if (!json || typeof json !== 'object') return fallback;

  const obj = json as Record<string, unknown>;
  let value = typeof obj.value === 'string' ? obj.value.trim() : null;

  if (value === null || value === '') return { ...fallback, value: null };

  if (value.length > 80) value = value.substring(0, 80);
  // < 20 字直接拒 (5 个中文字以下基本是噪声)
  if (value.length < 20) return { ...fallback, value: null };
  // 20-30 字区间: 尝试补句号, 仍 < 20 才拒
  if (value.length < 30 && !/[。.!！?？]$/.test(value)) {
    value = value + '。';
    if (value.length < 20) return { ...fallback, value: null };
  }

  const category = ['rule', 'preference', 'trajectory', 'reward'].includes(String(obj.category))
    ? (obj.category as DistillResult['category'])
    : 'preference';

  const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0.7));

  const evidence = typeof obj.evidence === 'string' && obj.evidence.trim()
    ? obj.evidence.trim().substring(0, 30)
    : null;

  return { value, category, confidence, evidence };
}

function parseDetectResponse(
  reply: string,
  fallback: { worth: boolean; reason: string }
): { worth: boolean; reason: string } {
  const json = extractJson(reply);
  if (!json || typeof json !== 'object') return fallback;

  const obj = json as Record<string, unknown>;
  const worth = Boolean(obj.worth);
  const reason = typeof obj.reason === 'string' ? obj.reason.substring(0, 20) : '';

  return { worth, reason };
}

function parseEvolveResponse(
  reply: string,
  existing: Array<{ id: string; value: string }>,
  fallback: EvolveResult
): EvolveResult {
  const json = extractJson(reply);
  if (!json || typeof json !== 'object') return fallback;

  const obj = json as Record<string, unknown>;
  const relations = obj.relations;
  if (!Array.isArray(relations)) return fallback;

  const existingIds = new Set(existing.map((e) => e.id));
  const validRelations: EvolveRelation[] = [];

  for (const r of relations) {
    if (!r || typeof r !== 'object') continue;
    const item = r as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!existingIds.has(id)) continue;
    const relation = item.relation;
    if (relation !== 'merge' && relation !== 'contradict' && relation !== 'unrelated') continue;
    const reason = typeof item.reason === 'string' ? item.reason.substring(0, 20) : '';
    validRelations.push({ id, relation, reason });
  }

  return { relations: validRelations };
}
