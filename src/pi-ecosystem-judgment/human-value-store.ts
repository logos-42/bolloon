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
import { createHash } from 'crypto';

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

  // 演化状态 (可选, 旧数据无此字段视为 active)
  status?: 'active' | 'pending' | 'superseded' | 'rejected';
  supersededBy?: string;
  evolutionReason?: 'merged' | 'contradicted';
  evolvedAt?: string;

  // ============================================================
  // Causal-judge 字段 (阶段 2 升级, 旧数据 migration 时补默认值)
  // ============================================================

  /** 1. TTL: 90 天全局默认, 显式设可覆盖. 到期后 status 自动转 'pending'. */
  expiresAt?: string;

  /** 2. 适用范围: 留空 = 全部适用; 填了 = 只在那些 tool 类别注入. */
  appliesTo?: string[];  // ['shell', 'file', 'network', 'memory', 'social']

  /** 3. 冲突: 自动检测填入, 表示该 judgment 与哪些 judgment 语义冲突. */
  conflictWith?: string[];  // ['hv-xxx', 'hv-yyy']

  /** 4. 因果链: 优先级 + 替代关系 + LLM 推断的原因. */
  causalChain?: {
    /** 语义上 '优先于' (更基础) 的 judgment id 列表 */
    precedes?: string[];
    /** 链式替代关系 (跟 status=superseded 区别: 链式, 不是简单二选一) */
    supersededBy?: string[];
    /** 为什么 A 优先于 B (LLM 推断) */
    reason?: string;
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

// ============================================================
// 阶段 2: Causal-judge 4 字段 migration
// ============================================================

/** TTL 默认 90 天 (用户可在 createUI 显式覆盖) */
export const DEFAULT_TTL_DAYS = 90;

/** 已 migration 标记 (避免每次 loadAllJudgments 都重写盘) */
let migratedOnce = false;

/**
 * 给老数据补 4 字段默认值 (in-place).
 * - expiresAt: createdAt + 90 天
 * - appliesTo: undefined (适用所有)
 * - conflictWith: []
 * - causalChain: undefined
 *
 * 返回 true 表示这次实际有 migration (写盘时持久化), false 表示无变化
 */
export function migrateJudgmentInPlace(j: HumanJudgment): boolean {
  let changed = false;
  if (j.expiresAt === undefined) {
    const base = new Date(j.timestamp || Date.now());
    base.setDate(base.getDate() + DEFAULT_TTL_DAYS);
    j.expiresAt = base.toISOString();
    changed = true;
  }
  if (j.conflictWith === undefined) {
    j.conflictWith = [];
    changed = true;
  }
  // appliesTo / causalChain 留空不补 (语义性, 由 causal-judge 自动填)
  return changed;
}

/**
 * 不可变版本: 返回新对象, 不 mutate 原 j. 供测试/谨慎场景用.
 */
export function migrateJudgmentImmutable(j: HumanJudgment): HumanJudgment {
  const next: HumanJudgment = { ...j };
  migrateJudgmentInPlace(next);
  return next;
}

/**
 * 存储人类判断
 */
export async function storeHumanJudgment(judgment: Omit<HumanJudgment, 'id' | 'timestamp'>): Promise<HumanJudgment> {
  const now = new Date().toISOString();
  // 阶段 2: 4 字段默认值补全 (新 judgment)
  if (!judgment.expiresAt) {
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + DEFAULT_TTL_DAYS);
    (judgment as any).expiresAt = expireDate.toISOString();
  }
  if (!Array.isArray(judgment.conflictWith)) {
    (judgment as any).conflictWith = [];
  }
  // 留空: appliesTo / causalChain 由后续 causal-judge 自动填

  const fullJudgment: HumanJudgment = {
    ...judgment,
    id: generateId(),
    timestamp: now
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
  patch: Partial<Pick<HumanJudgment, 'decision' | 'decision_type' | 'reasons' | 'values_derived' | 'context' | 'outcome' | 'status' | 'supersededBy' | 'evolutionReason' | 'evolvedAt'>>
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
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.supersededBy !== undefined ? { supersededBy: patch.supersededBy } : {}),
    ...(patch.evolutionReason !== undefined ? { evolutionReason: patch.evolutionReason } : {}),
    ...(patch.evolvedAt !== undefined ? { evolvedAt: patch.evolvedAt } : {}),
  };
  judgments[idx] = next;
  await saveJudgments(judgments);
  // 价值画像缓存失效 (内容变了画像也得重算)
  valueProfileCache.clear();
  return next;
}

/**
 * 按 status 过滤查询 (用于判断力库的 active/superseded tab)
 * status='all' 或不传 → 返回所有
 */
export async function listJudgmentsByStatus(
  status?: 'active' | 'pending' | 'superseded' | 'rejected' | 'all'
): Promise<HumanJudgment[]> {
  const judgments = await loadAllJudgments();
  if (!status || status === 'all') return judgments;
  return judgments.filter((j) => (j.status ?? 'active') === status);
}

/**
 * 内容 hash 用于去重窗口 (24h 滑窗内撞 hash 视为重复)
 * 归一化: 去标点 + 折叠空白 + lowercase
 * 64-bit 截断: 1 万条库碰撞率 < 1e-13, 够用
 */
export function hashDecision(decision: string): string {
  const normalized = decision
    .toLowerCase()
    .replace(/[\s,.，。、！？!?""''()（）:：;；\-—_]/g, '')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export interface RecentSimilar {
  id: string;
  decision: string;
  timestamp: string;
  /** 1.0 表示 hash 精确相等; 当前实现只做精确去重 */
  similarity: number;
}

/**
 * 在 withinMs 时间内查找与 decision hash 相同的判断力
 * - 默认扫全库 (100 条库 < 1ms, 不建索引)
 * - 可按 channelId 隔离 (判断力的 context.domain 是 'channel:xxx' 格式)
 * - 当前实现只做精确 hash 匹配, 不做相似度评分; 撞 hash 即视为重复
 */
export async function findRecentSimilarDecisions(
  decision: string,
  withinMs: number,
  options?: { status?: 'active' | 'superseded' | 'rejected' | 'all'; channelId?: string }
): Promise<RecentSimilar[]> {
  const judgments = await loadAllJudgments();
  const targetHash = hashDecision(decision);
  const cutoff = Date.now() - withinMs;
  const statusFilter = options?.status ?? 'all';
  const wantChannel = options?.channelId ? `channel:${options.channelId}` : null;

  const out: RecentSimilar[] = [];
  for (const j of judgments) {
    if (statusFilter !== 'all' && (j.status ?? 'active') !== statusFilter) continue;
    if (new Date(j.timestamp).getTime() < cutoff) continue;
    if (wantChannel) {
      const jChannel = (j.context as { domain?: string } | undefined)?.domain;
      if (jChannel !== wantChannel) continue;
    }
    if (hashDecision(j.decision) === targetHash) {
      out.push({ id: j.id, decision: j.decision, timestamp: j.timestamp, similarity: 1.0 });
    }
  }
  return out;
}

/**
 * 批量更新 (用于演化对齐后批量标 superseded)
 * 写完文件 + 清缓存
 * 返回成功更新的条数
 */
export async function batchUpdateJudgments(
  updates: Array<{ id: string; patch: Partial<HumanJudgment> }>
): Promise<{ updated: number; notFound: string[] }> {
  const judgments = await loadAllJudgments();
  const notFound: string[] = [];
  let updated = 0;

  const next = judgments.map((cur) => {
    const u = updates.find((x) => x.id === cur.id);
    if (!u) return cur;
    updated++;
    return { ...cur, ...u.patch };
  });

  for (const u of updates) {
    if (!judgments.some((j) => j.id === u.id)) notFound.push(u.id);
  }

  if (updated > 0) {
    await saveJudgments(next);
    valueProfileCache.clear();
  }
  return { updated, notFound };
}

/**
 * 更新单条 judgment (给"标记 rejected"等用)
 * id 不变; 不能改 id, timestamp
 * 允许改的字段: decision, decision_type, reasons, values_derived, context, outcome, status, supersededBy, evolutionReason, evolvedAt
 */
export async function updateJudgmentStatus(
  id: string,
  status: 'active' | 'pending' | 'superseded' | 'rejected',
  extra?: { supersededBy?: string; evolutionReason?: 'merged' | 'contradicted' }
): Promise<HumanJudgment | null> {
  return updateJudgment(id, {
    status,
    ...(extra?.supersededBy !== undefined ? { supersededBy: extra.supersededBy } : {}),
    ...(extra?.evolutionReason !== undefined ? { evolutionReason: extra.evolutionReason } : {}),
    ...(extra ? { evolvedAt: new Date().toISOString() } : {}),
  });
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
    // 早返回路径也要确保每条都有 status (防御性, 防止 saveJudgments 路径异常)
    const needs = judgmentCache.some((j) => j.status === undefined);
    if (needs) {
      judgmentCache = judgmentCache.map((j) =>
        j.status === undefined ? { ...j, status: 'active' } : j
      );
    }
    // 阶段 2: 4 字段 migration (in-place, 仅一次)
    if (!migratedOnce) {
      let anyChanged = false;
      judgmentCache.forEach((j) => {
        if (migrateJudgmentInPlace(j)) anyChanged = true;
      });
      if (anyChanged) {
        await saveJudgments(judgmentCache).catch(() => { /* 静默 */ });
      }
      migratedOnce = true;
    }
    return [...judgmentCache];
  }

  try {
    const content = await fs.readFile(JUDGMENTS_FILE, 'utf-8');
    const parsed: HumanJudgment[] = JSON.parse(content);
    judgmentCache = parsed.map((j) => (j.status === undefined ? { ...j, status: 'active' } : j));
    // 阶段 2: 4 字段 migration (in-place, 仅一次)
    if (!migratedOnce) {
      let anyChanged = false;
      judgmentCache.forEach((j) => {
        if (migrateJudgmentInPlace(j)) anyChanged = true;
      });
      if (anyChanged) {
        await saveJudgments(judgmentCache).catch(() => { /* 静默 */ });
      }
      migratedOnce = true;
    }
    return [...judgmentCache];
  } catch {
    judgmentCache = [];
    return [];
  }
}

/**
 * 获取相关价值观
 * 两路召回 (P2 升级):
 * 1. 关键词匹配 (精确, 高权重)
 * 2. bigram 软相似度 (措辞改写也能命中, 低权重)
 * - 关键词完全匹配 → weight 不衰减
 * - 软相似 > 0.4 → weight * 0.7 (留作辅助, 不冲掉精确命中)
 */
export async function getRelevantValues(
  context: string,
  domain?: string,
  currentTool?: string
): Promise<ValueTag[]> {
  const judgments = await loadAllJudgments();

  const keywords = context.split(/[\s,，、]+/).filter(k => k.length >= 2);
  const contextLower = context.toLowerCase();

  const relevant: Array<{ j: HumanJudgment; softWeight: number }> = [];
  for (const j of judgments) {
    if (domain && j.context.domain !== domain) continue;

    // 阶段 2: appliesTo 路由 — 不匹配当前 tool 类别的 judgment 直接跳过
    // appliesTo 为空 / undefined = 适用所有 (默认)
    if (currentTool && Array.isArray(j.appliesTo) && j.appliesTo.length > 0) {
      if (!j.appliesTo.includes(currentTool)) continue;
    }

    let matched = false;
    let soft = 0;

    if (keywords.length === 0) {
      if (j.decision.toLowerCase().includes(contextLower) ||
          j.reasons.some(r => r.toLowerCase().includes(contextLower)) ||
          j.values_derived.some(v => v.value.toLowerCase().includes(contextLower))) {
        matched = true;
      }
    } else {
      const decisionLower = j.decision.toLowerCase();
      const reasonsLower = j.reasons.map(r => r.toLowerCase());
      // values_derived[i].value 也是索引一部分 (如 'security-first', 'privacy-first')
      const valueTokens = j.values_derived.map(v => v.value.toLowerCase());

      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (
          decisionLower.includes(kwLower) ||
          reasonsLower.some(r => r.includes(kwLower)) ||
          valueTokens.some(vt => vt.includes(kwLower))
        ) {
          matched = true;
        } else {
          // P2: 软相似度召回 — 关键词没命中, 但 bigram 相似度阈值
          // - 长句 (>8 字符): 阈值 0.4 (合理召回, 不易误触)
          // - 短句 (≤8 字符): 阈值 0.15 (bigram 模式天然偏低, 放宽避免漏召)
          const threshold = kw.length > 8 ? 0.4 : 0.15;
          const simA = softBigramSimilarity(kw, j.decision);
          const simReason = Math.max(0, ...j.reasons.map(r => softBigramSimilarity(kw, r)));
          const simValue = Math.max(0, ...valueTokens.map(vt => softBigramSimilarity(kw, vt)));
          const best = Math.max(simA, simReason, simValue);
          if (best > threshold) soft = Math.max(soft, best);
        }
      }
    }

    if (matched) relevant.push({ j, softWeight: 1.0 });
    else if (soft > 0) relevant.push({ j, softWeight: soft });
  }

  const valueMap: Map<string, { tag: ValueTag; count: number; softFactor: number }> = new Map();

  for (const { j, softWeight } of relevant) {
    for (const v of j.values_derived) {
      const key = `${v.category}:${v.value}`;
      const existing = valueMap.get(key);
      if (existing) {
        existing.count++;
        existing.tag.weight = Math.min(1, existing.tag.weight + 0.1);
        existing.softFactor = Math.max(existing.softFactor, softWeight);
      } else {
        valueMap.set(key, {
          tag: { ...v },
          count: 1,
          softFactor: softWeight,
        });
      }
    }
  }

  return Array.from(valueMap.values())
    .map(({ tag, count, softFactor }) => ({
      ...tag,
      // 软命中: 额外乘 0.7 衰减, 避免冲掉精确命中的排序
      weight: tag.weight * Math.min(1, count / 3) * (softFactor >= 0.999 ? 1.0 : 0.7),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);
}

/**
 * P2 软相似度: 用于"关键词未命中但措辞相近"的兜底召回
 * - 与 evolve-judgment.ts 的 jaccardSimilarity 算法一致 (避免循环依赖, inline 一份)
 * - 短句 (<8 字符) 走 bigram, 长句走单字 set
 */
function softBigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[\s,.，。、！？!?""''()（）:：;；\-—_]/g, '').trim();
  const textA = normalize(a);
  const textB = normalize(b);
  if (textA.length === 0 || textB.length === 0) return 0;

  const grams = (s: string): Set<string> => {
    if (s.length < 8) {
      const out = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
      for (const c of s) out.add(c);
      return out;
    }
    return new Set(s);
  };
  const setA = grams(textA);
  const setB = grams(textB);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
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
  // 同时在写盘时也补 status 默认值, 防止 loadAllJudgments 走早返回路径时绕过迁移
  // 关键: 用浅拷贝 + spread 避免 mutate 入参 (storeHumanJudgment 返回的 fullJudgment 也会被改)
  judgmentCache = judgments.map((j) => {
    const next: HumanJudgment = { ...j };
    if (next.status === undefined) next.status = 'active';
    migrateJudgmentInPlace(next);
    return next;
  });
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