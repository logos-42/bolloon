/**
 * Value Injection - 人类价值观注入到 LLM Prompt
 *
 * 核心思想：
 * - 不只给 LLM 规则，而是给 LLM "做决定的人"的价值观
 * - 价值观通过具体的决策例子体现，而非抽象原则
 * - 让 LLM 理解"为什么会这样决定"而非"应该怎么做"
 *
 * 注入方式：
 * 1. 价值观标签 - 告诉 LLM 这个人重视什么
 * 2. 决策例子 - 具体的人类判断样本
 * 3. 优先级规则 - 冲突时的决策倾向
 * 4. 边界条件 - 在什么情况下会改变决定
 */

import {
  getRelevantValues,
  getValueProfile,
  getPriorityRules,
  type ValueTag,
  type ValueProfile,
  type PriorityRule,
  type HumanJudgment
} from './human-value-store.js';

export interface ValueInjectionConfig {
  // 注入模式
  mode: 'concise' | 'standard' | 'detailed';

  // 最大注入内容长度
  maxTokens: number;

  // 是否包含决策例子
  includeExamples: boolean;

  // 是否包含优先级规则
  includeRules: boolean;

  // 是否包含边界条件
  includeBoundaries: boolean;

  // 价值观来源
  source: 'current-user' | 'team' | 'project' | 'all';
}

export const DEFAULT_INJECTION_CONFIG: ValueInjectionConfig = {
  mode: 'standard',
  maxTokens: 800,
  includeExamples: true,
  includeRules: true,
  includeBoundaries: true,
  source: 'current-user'
};

// ============================================================
// 价值观注入生成
// ============================================================

/**
 * 生成价值观注入内容
 */
export async function generateValueInjection(
  context: string,
  config: Partial<ValueInjectionConfig> = {}
): Promise<string> {
  const cfg = { ...DEFAULT_INJECTION_CONFIG, ...config };

  const parts: string[] = [];

  // 1. 获取相关价值观
  const values = await getRelevantValues(context);
  if (values.length > 0) {
    parts.push(generateValuesSection(values, cfg.mode));
  }

  // 2. 获取优先级规则
  if (cfg.includeRules) {
    const rules = await getPriorityRules();
    if (rules.length > 0) {
      parts.push(generateRulesSection(rules, cfg.mode));
    }
  }

  // 3. 获取决策例子
  if (cfg.includeExamples) {
    const examples = await getDecisionExamples(context, 3);
    if (examples.length > 0) {
      parts.push(generateExamplesSection(examples, cfg.mode));
    }
  }

  // 组合并截断到最大长度
  let injection = parts.join('\n\n');

  // 简单截断（实际应该用 token 计数）
  const maxChars = cfg.maxTokens * 4; // 粗略估计
  if (injection.length > maxChars) {
    injection = injection.substring(0, maxChars) + '\n... (价值观注入已截断)';
  }

  return injection;
}

/**
 * 生成价值观部分
 */
function generateValuesSection(values: ValueTag[], mode: ValueInjectionConfig['mode']): string {
  if (mode === 'concise') {
    const topValues = values.slice(0, 3);
    return `## 决策者价值观
${topValues.map(v => `- 重视 ${v.value} (${(v.weight * 100).toFixed(0)}% 权重)`).join('\n')}`;
  }

  if (mode === 'detailed') {
    return `## 决策者的价值观体系

这个人的决策反映了以下价值观优先级：

${values.map(v => {
  const stars = '★'.repeat(Math.ceil(v.weight * 5));
  return `### ${v.category}: ${v.value}
权重: ${stars} (${(v.weight * 100).toFixed(0)}%)
- 决策时会优先考虑这个价值
`;
}).join('\n')}`;
  }

  // standard mode
  return `## 决策者重视的价值观

优先级排序：
${values.slice(0, 5).map((v, i) => `${i + 1}. ${v.value} (${(v.weight * 100).toFixed(0)}% 权重)`).join('\n')}

这些价值观将影响判断结果。`;
}

/**
 * 生成优先级规则部分
 */
function generateRulesSection(rules: PriorityRule[], mode: ValueInjectionConfig['mode']): string {
  if (mode === 'concise') {
    return `## 决策倾向
${rules.slice(0, 3).map(r => `- ${r.when} → 偏好 ${r.prefer}`).join('\n')}`;
  }

  if (mode === 'detailed') {
    return `## 决策优先级规则

当遇到以下情况时，决策者会这样选择：

${rules.slice(0, 5).map((r, i) => `### 规则 ${i + 1}: ${r.when}
- 偏好: ${r.prefer}
- 理由: ${r.reason}
- 置信度: ${(r.weight * 100).toFixed(0)}%
`).join('\n')}`;
  }

  // standard mode
  return `## 决策优先级

在价值冲突时，以下优先级生效：

${rules.slice(0, 4).map(r => `- **${r.when}**: ${r.prefer}（因为 ${r.reason}）`).join('\n')}`;
}

/**
 * 生成决策例子部分
 */
function generateExamplesSection(judgments: HumanJudgment[], mode: ValueInjectionConfig['mode']): string {
  if (mode === 'concise') {
    return `## 历史决策
${judgments.slice(0, 2).map(j => `- "${j.decision.substring(0, 40)}..." → ${j.decision_type}（理由: ${j.reasons[0] || '无'})`).join('\n')}`;
  }

  if (mode === 'detailed') {
    return `## 历史决策样本（学习自真实判断）

以下是决策者过去做出的具体判断，每个都反映了其价值观：

${judgments.map((j, i) => `### 决策 ${i + 1}
**情境**: ${j.decision}
**决定**: ${j.decision_type}
**理由**: ${j.reasons.join('; ') || '未说明'}
**价值观**: ${j.values_derived.map(v => v.value).join(', ') || '未提取'}
**结果**: ${j.outcome?.approved ? '✅ 成功' : '❌ 未成功'}
`).join('\n\n')}`;
  }

  // standard mode
  return `## 类似情况的历史决策

决策者在以下情况做过类似判断：

${judgments.slice(0, 3).map(j => `- **情况**: "${j.decision.substring(0, 50)}..."
  **决定**: ${j.decision_type}
  **理由**: ${j.reasons[0] || '未说明'}
`).join('\n\n')}`;
}

/**
 * 获取决策例子
 */
async function getDecisionExamples(context: string, limit: number): Promise<HumanJudgment[]> {
  const { loadAllJudgments } = await import('./human-value-store.js');
  const judgments = await loadAllJudgments();

  const keywords = context.split(/[\s,，、]+/).filter(k => k.length >= 2);
  const contextLower = context.toLowerCase();

  const scored = judgments.map(j => {
    let score = 0;
    const decisionLower = j.decision.toLowerCase();
    const reasonsLower = j.reasons.map(r => r.toLowerCase());

    if (keywords.length === 0) {
      if (decisionLower.includes(contextLower)) score += 2;
      if (reasonsLower.some(r => r.includes(contextLower))) score += 1;
    } else {
      if (keywords.some(kw => decisionLower.includes(kw.toLowerCase()))) score += 2;
      if (keywords.some(kw => reasonsLower.some(r => r.includes(kw.toLowerCase())))) score += 1;
    }

    if (j.values_derived.some(v => contextLower.includes(v.value.toLowerCase()))) score += 1;
    score *= j.metadata.confidence;

    return { judgment: j, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.judgment);
}

// ============================================================
// Prompt 注入
// ============================================================

/**
 * 生成完整的系统 Prompt（包含价值观注入）
 */
export async function generateSystemPromptWithValues(
  basePrompt: string,
  context: string,
  config: Partial<ValueInjectionConfig> = {}
): Promise<string> {
  const injection = await generateValueInjection(context, config);

  return `${basePrompt}

---

## 决策参考（来自真实人类判断）

以下信息来自对人类决策的学习，在判断时应该参考这些价值观和决策模式：

${injection}

---

请在做出判断时，结合上述价值观和决策模式进行思考。`;
}

/**
 * 生成判断用的 Prompt（包含价值观）
 */
export async function generateJudgmentPromptWithValues(
  userInput: string,
  context: string,
  history: string[],
  config: Partial<ValueInjectionConfig> = {}
): Promise<string> {
  const cfg = { ...DEFAULT_INJECTION_CONFIG, ...config };
  const valueInjection = await generateValueInjection(context, cfg);

  const historyStr = history.length > 0
    ? history.slice(-5).map((m, i) => `[${i + 1}] ${m}`).join('\n')
    : '无';

  return `${valueInjection}

---

【当前输入】
${userInput}

【对话历史】
${historyStr}

---

请基于以上价值观和历史对话，分析当前输入并给出判断。`;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 生成价值摘要
 */
export async function generateValueSummary(): Promise<string> {
  const { getValueStats } = await import('./human-value-store.js');
  const stats = await getValueStats();

  if (stats.total_judgments === 0) {
    return '暂无价值观数据，请先通过决策学习积累判断样本。';
  }

  const topValuesStr = stats.top_values
    .slice(0, 5)
    .map(v => `${v.value}(${(v.weight * 100).toFixed(0)}%)`)
    .join(', ');

  return `已学习 ${stats.total_judgments} 个判断样本。` +
    `核心价值观: ${topValuesStr}。` +
    `判断类型分布: ${Object.entries(stats.by_type).map(([k, v]) => `${k}:${v}`).join(', ')}。`;
}

/**
 * 检测价值观冲突
 */
export async function detectValueConflicts(
  decision1: string,
  decision2: string
): Promise<{ hasConflict: boolean; conflicts: string[] }> {
  const values1 = await getRelevantValues(decision1);
  const values2 = await getRelevantValues(decision2);

  const conflicts: string[] = [];

  for (const v1 of values1) {
    for (const v2 of values2) {
      if (v1.category === v2.category && v1.value !== v2.value) {
        if (Math.abs(v1.weight - v2.weight) > 0.3) {
          conflicts.push(`${v1.category}: ${v1.value} vs ${v2.value}`);
        }
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts
  };
}

/**
 * 根据价值观建议决策方向
 */
export async function suggestBasedOnValues(
  situation: string,
  options: string[]
): Promise<{ recommended: string; reasoning: string }> {
  const profile = await getValueProfile('current');
  const values = await getRelevantValues(situation);

  // 简单评分
  const scores = options.map(option => {
    let score = 0;
    const optionLower = option.toLowerCase();

    // 匹配价值观
    for (const v of values) {
      if (optionLower.includes(v.value)) {
        score += v.weight;
      }
      // 匹配优先规则
      if (optionLower.includes('quality') || optionLower.includes('安全')) {
        score += profile.quality_focus * 0.3;
      }
      if (optionLower.includes('fast') || optionLower.includes('快速')) {
        score += profile.efficiency_focus * 0.3;
      }
    }

    return score;
  });

  const bestIndex = scores.indexOf(Math.max(...scores));
  const recommended = options[bestIndex];

  const reasoning = `基于你的价值观（优先: ${values.slice(0, 3).map(v => v.value).join(', ')}），` +
    `建议选择"${recommended}"。`;

  return { recommended, reasoning };
}