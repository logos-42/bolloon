/**
 * Human Value Store - 存储人类判断价值观的机制
 *
 * 核心概念：
 * - 人类判断不是规则，而是价值观表达
 * - 价值观通过具体决策体现，而非抽象陈述
 * - 存储结构化的人类决策，用于价值注入
 *
 * 存储格式：
 * - decision: 具体决策内容
 * - reason: 决策理由（价值观体现）
 * - context: 决策场景
 * - outcome: 决策结果
 * - values: 提取的价值观标签
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ValueTag {
  category: 'quality' | 'efficiency' | 'safety' | 'collaboration' | 'learning' | 'priorities';
  value: string;
  weight: number;  // 0-1, 这个价值观的重要性
}

export interface HumanJudgment {
  id: string;
  timestamp: string;

  // 决策内容
  decision: string;
  decision_type: 'approve' | 'reject' | 'modify' | 'escalate';

  // 决策理由（核心）
  reasons: string[];
  values_derived: ValueTag[];

  // 上下文
  context: {
    domain: string;        // 代码/架构/安全/测试等
    complexity: 'simple' | 'moderate' | 'complex' | 'profound';
    stakes: 'low' | 'medium' | 'high' | 'critical';
    time_pressure: 'low' | 'medium' | 'high';
  };

  // 结果
  outcome?: {
    approved: boolean;
    feedback?: string;
    revised?: boolean;
  };

  // 元数据
  metadata: {
    source: 'explicit' | 'implicit' | 'trajectory';
    confidence: number;
    revisable: boolean;
  };
}

export interface ValueProfile {
  agent_id: string;
  decision_count: number;

  // 价值观分布
  quality_focus: number;        // 对质量的重视程度
  efficiency_focus: number;     // 对效率的重视程度
  safety_focus: number;         // 对安全的重视程度
  collaboration_focus: number;  // 对协作的重视程度
  learning_focus: number;       // 对学习的重视程度

  // 优先级模式
  priority_rules: PriorityRule[];

  // 典型决策模式
  decision_patterns: DecisionPattern[];

  // 偏好
  preferences: ValuePreference[];

  last_updated: string;
}

export interface PriorityRule {
  when: string;           // 条件描述
  prefer: string;        // 偏好选择
  reason: string;        // 理由
  weight: number;        // 优先级权重
}

export interface DecisionPattern {
  pattern: string;       // 模式描述
  description: string;
  frequency: number;
  success_rate: number;
}

export interface ValuePreference {
  dimension: string;
  preference: string;
  evidence_count: number;
}

const VALUE_STORE_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'human-values');
const JUDGMENTS_FILE = path.join(VALUE_STORE_DIR, 'judgments.json');

// In-memory cache
let judgmentCache: HumanJudgment[] = [];
let valueProfileCache: Map<string, ValueProfile> = new Map();
let initialized = false;

function generateId(): string {
  return `hv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// ============================================================
// 存储操作
// ============================================================

/**
 * 初始化存储（创建目录和空文件）
 */
export async function initializeValueStore(): Promise<void> {
  if (initialized) return;

  try {
    await fs.mkdir(VALUE_STORE_DIR, { recursive: true });

    try {
      await fs.access(JUDGMENTS_FILE);
    } catch {
      await fs.writeFile(JUDGMENTS_FILE, JSON.stringify([], null, 2), 'utf-8');
    }

    initialized = true;
    console.log('[HumanValueStore] Initialized at', VALUE_STORE_DIR);
  } catch (error) {
    console.error('[HumanValueStore] Initialization failed:', error);
    throw error;
  }
}

/**
 * 存储人类判断
 */
export async function storeHumanJudgment(judgment: Omit<HumanJudgment, 'id' | 'timestamp'>): Promise<HumanJudgment> {
  const fullJudgment: HumanJudgment = {
    ...judgment,
    id: generateId(),
    timestamp: new Date().toISOString()
  };

  // 加载现有判断
  const judgments = await loadAllJudgments();
  judgments.push(fullJudgment);

  // 保存
  await saveJudgments(judgments);

  // 更新价值画像
  await updateValueProfile(fullJudgment);

  console.log(`[HumanValueStore] Stored judgment ${fullJudgment.id}: ${fullJudgment.decision.substring(0, 50)}...`);
  return fullJudgment;
}

/**
 * 从决策结果学习（轨迹学习）
 */
export async function learnFromTrajectory(trajectory: {
  situation: string;
  chosen_action: string;
  rejected_alternatives?: string[];
  outcome: string;
  approved: boolean;
}): Promise<HumanJudgment> {
  // 提取价值观
  const values = extractValuesFromTrajectory(trajectory);

  return storeHumanJudgment({
    decision: trajectory.chosen_action,
    decision_type: trajectory.approved ? 'approve' : 'reject',
    reasons: [trajectory.outcome],
    values_derived: values,
    context: inferContext(trajectory.situation),
    outcome: {
      approved: trajectory.approved,
      feedback: trajectory.outcome
    },
    metadata: {
      source: 'trajectory',
      confidence: trajectory.approved ? 0.9 : 0.7,
      revisable: true
    }
  });
}

/**
 * 从批准/拒绝学习
 */
export async function learnFromFeedback(
  action: string,
  approved: boolean,
  reason?: string
): Promise<HumanJudgment> {
  return storeHumanJudgment({
    decision: action,
    decision_type: approved ? 'approve' : 'reject',
    reasons: reason ? [reason] : [],
    values_derived: approved ? inferPositiveValues(action) : inferNegativeValues(action),
    context: inferContext(action),
    outcome: { approved },
    metadata: {
      source: 'explicit',
      confidence: 0.8,
      revisable: true
    }
  });
}

/**
 * 从建议修正学习
 */
export async function learnFromCorrection(
  original: string,
  corrected: string,
  reason: string
): Promise<HumanJudgment> {
  return storeHumanJudgment({
    decision: corrected,
    decision_type: 'modify',
    reasons: [reason],
    values_derived: extractValuesFromCorrection(original, corrected),
    context: inferContext(original),
    outcome: { approved: true, revised: true },
    metadata: {
      source: 'trajectory',
      confidence: 0.85,
      revisable: false
    }
  });
}

// ============================================================
// 读取操作
// ============================================================

/**
 * 修改一个判断 (手动编辑). 允许改: decision, reasons, context, values_derived, decision_type, confidence.
 * 不能改 id, timestamp (id 不暴露, 靠 id 查).
 */
export async function updateJudgment(
  id: string,
  patch: Partial<Pick<HumanJudgment, 'decision' | 'decision_type' | 'reasons' | 'values_derived' | 'context' | 'outcome'>>
): Promise<HumanJudgment | null> {
  const judgments = await loadAllJudgments();
  const idx = judgments.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  const cur = judgments[idx];
  const next: HumanJudgment = {
    ...cur,
    ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
    ...(patch.decision_type !== undefined ? { decision_type: patch.decision_type } : {}),
    ...(patch.reasons !== undefined ? { reasons: patch.reasons } : {}),
    ...(patch.values_derived !== undefined ? { values_derived: patch.values_derived } : {}),
    ...(patch.context !== undefined ? { context: { ...cur.context, ...patch.context } } : {}),
    ...(patch.outcome !== undefined ? { outcome: { ...cur.outcome, ...patch.outcome } } : {}),
  };
  judgments[idx] = next;
  await saveJudgments(judgments);
  // 价值画像缓存失效 (内容变了画像也得重算)
  valueProfileCache.clear();
  return next;
}

/**
 * 删除一个判断.
 */
export async function deleteJudgment(id: string): Promise<boolean> {
  const judgments = await loadAllJudgments();
  const idx = judgments.findIndex((j) => j.id === id);
  if (idx < 0) return false;
  judgments.splice(idx, 1);
  await saveJudgments(judgments);
  valueProfileCache.clear();
  return true;
}

/**
 * 加载所有人类判断
 */
export async function loadAllJudgments(): Promise<HumanJudgment[]> {
  if (!initialized) {
    await initializeValueStore();
  }

  if (judgmentCache.length > 0) {
    return [...judgmentCache];
  }

  try {
    const content = await fs.readFile(JUDGMENTS_FILE, 'utf-8');
    judgmentCache = JSON.parse(content);
    return judgmentCache;
  } catch {
    judgmentCache = [];
    return [];
  }
}

/**
 * 获取相关价值观
 * 将 context 拆分为关键词，任意一个匹配即可
 */
export async function getRelevantValues(context: string, domain?: string): Promise<ValueTag[]> {
  const judgments = await loadAllJudgments();

  const keywords = context.split(/[\s,，、]+/).filter(k => k.length >= 2);
  const contextLower = context.toLowerCase();

  const relevant = judgments.filter(j => {
    if (domain && j.context.domain !== domain) return false;

    if (keywords.length === 0) {
      return j.decision.toLowerCase().includes(contextLower) ||
             j.reasons.some(r => r.toLowerCase().includes(contextLower));
    }

    const decisionLower = j.decision.toLowerCase();
    const reasonsLower = j.reasons.map(r => r.toLowerCase());

    return keywords.some(kw => {
      const kwLower = kw.toLowerCase();
      return decisionLower.includes(kwLower) ||
             reasonsLower.some(r => r.includes(kwLower));
    });
  });

  const valueMap: Map<string, { tag: ValueTag; count: number }> = new Map();

  for (const j of relevant) {
    for (const v of j.values_derived) {
      const key = `${v.category}:${v.value}`;
      const existing = valueMap.get(key);
      if (existing) {
        existing.count++;
        existing.tag.weight = Math.min(1, existing.tag.weight + 0.1);
      } else {
        valueMap.set(key, { tag: { ...v }, count: 1 });
      }
    }
  }

  return Array.from(valueMap.values())
    .map(({ tag, count }) => ({
      ...tag,
      weight: tag.weight * Math.min(1, count / 3)
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);
}

/**
 * 获取价值画像
 */
export async function getValueProfile(agentId: string): Promise<ValueProfile> {
  if (valueProfileCache.has(agentId)) {
    return valueProfileCache.get(agentId)!;
  }

  const judgments = await loadAllJudgments();
  const agentJudgments = judgments.filter(j =>
    j.metadata.source !== 'trajectory' || j.id.includes(agentId)
  );

  const profile = buildValueProfile(agentId, agentJudgments);
  valueProfileCache.set(agentId, profile);
  return profile;
}

/**
 * 获取优先级规则
 */
export async function getPriorityRules(): Promise<PriorityRule[]> {
  const judgments = await loadAllJudgments();

  const seen = new Set<string>();
  return judgments
    .filter(j => {
      if (j.metadata.confidence <= 0.7) return false;
      const key = `${j.context.domain}:${j.decision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(j => ({
      when: j.context.domain,
      prefer: j.decision,
      reason: j.reasons[0] || 'No reason provided',
      weight: j.metadata.confidence
    }))
    .slice(0, 20);
}

// ============================================================
// 私有函数
// ============================================================

async function saveJudgments(judgments: HumanJudgment[]): Promise<void> {
  await fs.mkdir(VALUE_STORE_DIR, { recursive: true });
  await fs.writeFile(JUDGMENTS_FILE, JSON.stringify(judgments, null, 2), 'utf-8');
  // 让 loadAllJudgments 下次重新读盘, 避免缓存与磁盘脱节
  judgmentCache = judgments;
}

function buildValueProfile(agentId: string, judgments: HumanJudgment[]): ValueProfile {
  const profile: ValueProfile = {
    agent_id: agentId,
    decision_count: judgments.length,
    quality_focus: 0.5,
    efficiency_focus: 0.5,
    safety_focus: 0.5,
    collaboration_focus: 0.5,
    learning_focus: 0.5,
    priority_rules: [],
    decision_patterns: [],
    preferences: [],
    last_updated: new Date().toISOString()
  };

  // 计算各维度权重
  const dimensionCounts: Record<string, number> = {};

  for (const j of judgments) {
    for (const v of j.values_derived) {
      dimensionCounts[`${v.category}_${v.value}`] =
        (dimensionCounts[`${v.category}_${v.value}`] || 0) + v.weight;
    }
  }

  // 更新各维度分数
  for (const [key, weight] of Object.entries(dimensionCounts)) {
    const [category] = key.split('_');
    const dimensionKey = `${category}_focus` as keyof ValueProfile;
    if (dimensionKey in profile) {
      (profile as unknown as Record<string, unknown>)[dimensionKey] = Math.min(1, weight / judgments.length);
    }
  }

  // 提取决策模式
  const patternMap: Map<string, number> = new Map();
  for (const j of judgments) {
    const pattern = j.decision_type;
    patternMap.set(pattern, (patternMap.get(pattern) || 0) + 1);
  }

  for (const [pattern, count] of patternMap) {
    profile.decision_patterns.push({
      pattern,
      description: `Tendency to ${pattern}`,
      frequency: count,
      success_rate: judgments.filter(j => j.decision_type === pattern && j.outcome?.approved).length / count
    });
  }

  // 提取优先级规则
  profile.priority_rules = judgments
    .filter(j => j.metadata.confidence > 0.8)
    .map(j => ({
      when: j.context.domain,
      prefer: j.decision,
      reason: j.reasons[0] || '',
      weight: j.metadata.confidence
    }));

  return profile;
}

async function updateValueProfile(judgment: HumanJudgment): Promise<void> {
  // 简单更新：标记缓存需要刷新
  valueProfileCache.clear();
}

function extractValuesFromTrajectory(trajectory: {
  situation: string;
  chosen_action: string;
  outcome: string;
  approved: boolean;
}): ValueTag[] {
  const values: ValueTag[] = [];
  const action = trajectory.chosen_action.toLowerCase();
  const outcome = trajectory.outcome.toLowerCase();

  // 从行动推断价值观
  if (action.includes('review') || action.includes('检查') || action.includes('验证')) {
    values.push({ category: 'quality', value: 'code-review', weight: 0.8 });
  }
  if (action.includes('test') || action.includes('测试')) {
    values.push({ category: 'quality', value: 'testing', weight: 0.8 });
  }
  if (action.includes('security') || action.includes('安全')) {
    values.push({ category: 'safety', value: 'security-first', weight: 0.9 });
  }
  if (action.includes('refactor') || action.includes('重构')) {
    values.push({ category: 'quality', value: 'maintainability', weight: 0.7 });
  }
  if (action.includes('simple') || action.includes('简单')) {
    values.push({ category: 'efficiency', value: 'simplicity', weight: 0.8 });
  }

  // 从结果推断价值观
  if (outcome.includes('success') || outcome.includes('成功')) {
    values.push({ category: 'learning', value: 'success-validation', weight: 0.6 });
  }
  if (outcome.includes('fail') || outcome.includes('失败')) {
    values.push({ category: 'learning', value: 'failure-learning', weight: 0.7 });
  }

  return values.length > 0 ? values : [{ category: 'quality', value: 'general', weight: 0.5 }];
}

function inferContext(action: string): HumanJudgment['context'] {
  const actionLower = action.toLowerCase();

  let domain = 'general';
  if (actionLower.includes('code') || actionLower.includes('代码')) domain = 'code';
  else if (actionLower.includes('arch') || actionLower.includes('架构')) domain = 'architecture';
  else if (actionLower.includes('security') || actionLower.includes('安全')) domain = 'security';
  else if (actionLower.includes('test') || actionLower.includes('测试')) domain = 'testing';

  let complexity: HumanJudgment['context']['complexity'] = 'moderate';
  if (actionLower.includes('simple') || action.length < 50) complexity = 'simple';
  if (actionLower.includes('complex') || action.length > 200) complexity = 'complex';

  return {
    domain,
    complexity,
    stakes: 'medium',
    time_pressure: 'low'
  };
}

function inferPositiveValues(action: string): ValueTag[] {
  return extractValuesFromTrajectory({
    situation: action,
    chosen_action: action,
    outcome: 'approved',
    approved: true
  });
}

function inferNegativeValues(action: string): ValueTag[] {
  return extractValuesFromTrajectory({
    situation: action,
    chosen_action: action,
    outcome: 'rejected',
    approved: false
  }).map(v => ({ ...v, weight: v.weight * 0.5 }));
}

function extractValuesFromCorrection(original: string, corrected: string): ValueTag[] {
  const values: ValueTag[] = [];

  // 检测修正类型
  if (corrected.includes('security') || corrected.includes('安全')) {
    values.push({ category: 'safety', value: 'security-fix', weight: 0.9 });
  }
  if (corrected.includes('test') && !original.includes('test')) {
    values.push({ category: 'quality', value: 'add-testing', weight: 0.8 });
  }
  if (corrected.length < original.length) {
    values.push({ category: 'efficiency', value: 'simplification', weight: 0.7 });
  }

  return values.length > 0 ? values : [{ category: 'quality', value: 'general-fix', weight: 0.6 }];
}

// ============================================================
// 统计
// ============================================================

export async function getValueStats(): Promise<{
  total_judgments: number;
  by_type: Record<string, number>;
  by_source: Record<string, number>;
  top_values: ValueTag[];
}> {
  const judgments = await loadAllJudgments();

  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const valueCounts: Map<string, number> = new Map();

  for (const j of judgments) {
    byType[j.decision_type] = (byType[j.decision_type] || 0) + 1;
    bySource[j.metadata.source] = (bySource[j.metadata.source] || 0) + 1;

    for (const v of j.values_derived) {
      const key = `${v.category}:${v.value}`;
      valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
    }
  }

  const topValues: ValueTag[] = Array.from(valueCounts.entries())
    .map(([key, count]) => {
      const [category, value] = key.split(':');
      return { category: category as ValueTag['category'], value, weight: count };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);

  return {
    total_judgments: judgments.length,
    by_type: byType,
    by_source: bySource,
    top_values: topValues
  };
}

export function clearCache(): void {
  judgmentCache = [];
  valueProfileCache.clear();
}