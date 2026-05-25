/**
 * Human Value Store 测试
 *
 * 测试内容：
 * 1. 存储人类判断
 * 2. 从反馈中学习
 * 3. 从修正中学习
 * 4. 获取相关价值观
 * 5. 价值观注入到 Prompt
 *
 * 运行: npx tsx src/test/human-value-store.test.ts
 */

import { config } from 'dotenv';
import {
  storeHumanJudgment,
  learnFromFeedback,
  learnFromCorrection,
  getRelevantValues,
  getValueProfile,
  getValueStats,
  type HumanJudgment
} from '../pi-ecosystem-judgment/human-value-store.js';
import {
  generateValueInjection,
  generateJudgmentPromptWithValues,
  generateValueSummary,
  detectValueConflicts,
  suggestBasedOnValues
} from '../pi-ecosystem-judgment/value-injection.js';

config();

// ============================================================
// 测试数据
// ============================================================

const SAMPLE_JUDGMENTS: Array<Omit<HumanJudgment, 'id' | 'timestamp'>> = [
  {
    decision: '添加单元测试覆盖认证模块',
    decision_type: 'approve',
    reasons: ['测试是代码质量的基本保障', '认证模块是高风险区域'],
    values_derived: [
      { category: 'quality', value: 'test-coverage', weight: 0.9 },
      { category: 'safety', value: 'security-first', weight: 0.8 }
    ],
    context: {
      domain: 'code',
      complexity: 'moderate',
      stakes: 'high',
      time_pressure: 'medium'
    },
    outcome: { approved: true },
    metadata: { source: 'explicit', confidence: 0.9, revisable: false }
  },
  {
    decision: '使用简单的实现方案，不要过度设计',
    decision_type: 'approve',
    reasons: ['简单优于复杂', '过度设计浪费资源'],
    values_derived: [
      { category: 'efficiency', value: 'simplicity', weight: 0.9 },
      { category: 'efficiency', value: 'pragmatism', weight: 0.8 }
    ],
    context: {
      domain: 'architecture',
      complexity: 'moderate',
      stakes: 'medium',
      time_pressure: 'low'
    },
    outcome: { approved: true },
    metadata: { source: 'explicit', confidence: 0.85, revisable: true }
  },
  {
    decision: '提交前必须通过所有测试',
    decision_type: 'approve',
    reasons: ['保持 CI 流程的健康', '避免破坏性提交'],
    values_derived: [
      { category: 'quality', value: 'ci- discipline', weight: 0.9 },
      { category: 'collaboration', value: 'team-trust', weight: 0.7 }
    ],
    context: {
      domain: 'process',
      complexity: 'simple',
      stakes: 'medium',
      time_pressure: 'medium'
    },
    outcome: { approved: true },
    metadata: { source: 'trajectory', confidence: 0.9, revisable: false }
  },
  {
    decision: '代码审查发现安全漏洞，需要修复后才能合并',
    decision_type: 'approve',
    reasons: ['安全问题是阻塞性的', '不能为了速度牺牲安全'],
    values_derived: [
      { category: 'safety', value: 'security-blocker', weight: 1.0 },
      { category: 'quality', value: 'review-discipline', weight: 0.8 }
    ],
    context: {
      domain: 'security',
      complexity: 'moderate',
      stakes: 'critical',
      time_pressure: 'low'
    },
    outcome: { approved: true },
    metadata: { source: 'explicit', confidence: 1.0, revisable: false }
  }
];

// ============================================================
// 测试函数
// ============================================================

async function testStoreJudgments() {
  console.log('\n━━━ 测试: 存储人类判断 ━━━\n');

  for (const judgment of SAMPLE_JUDGMENTS) {
    const stored = await storeHumanJudgment(judgment);
    console.log(`✓ 存储判断: ${stored.id}`);
    console.log(`  决策: ${stored.decision}`);
    console.log(`  价值观: ${stored.values_derived.map(v => v.value).join(', ')}`);
  }
}

async function testLearnFromFeedback() {
  console.log('\n━━━ 测试: 从反馈中学习 ━━━\n');

  // 批准一个行动
  const approved = await learnFromFeedback(
    '添加输入验证',
    true,
    '输入验证很重要，防止注入攻击'
  );
  console.log(`✓ 从批准中学习: ${approved.id}`);

  // 拒绝一个行动
  const rejected = await learnFromFeedback(
    '跳过测试直接提交',
    false,
    '测试是质量保障，必须执行'
  );
  console.log(`✓ 从拒绝中学习: ${rejected.id}`);
}

async function testLearnFromCorrection() {
  console.log('\n━━━ 测试: 从修正中学习 ━━━\n');

  const corrected = await learnFromCorrection(
    '使用全局变量存储用户状态',
    '使用 Context 存储用户状态',
    '全局变量难以追踪和测试，Context 更清晰'
  );
  console.log(`✓ 从修正中学习: ${corrected.id}`);
  console.log(`  修正前: 使用全局变量存储用户状态`);
  console.log(`  修正后: 使用 Context 存储用户状态`);
  console.log(`  理由: ${corrected.reasons[0]}`);
}

async function testGetRelevantValues() {
  console.log('\n━━━ 测试: 获取相关价值观 ━━━\n');

  const securityValues = await getRelevantValues('安全 认证');
  console.log('安全/认证相关的价值观:');
  for (const v of securityValues) {
    console.log(`  - ${v.value} (权重: ${(v.weight * 100).toFixed(0)}%)`);
  }

  const qualityValues = await getRelevantValues('测试 代码质量');
  console.log('\n测试/代码质量相关的价值观:');
  for (const v of qualityValues) {
    console.log(`  - ${v.value} (权重: ${(v.weight * 100).toFixed(0)}%)`);
  }
}

async function testGetValueProfile() {
  console.log('\n━━━ 测试: 获取价值画像 ━━━\n');

  const profile = await getValueProfile('current');
  console.log(`决策者画像 (${profile.agent_id}):`);
  console.log(`  - 决策总数: ${profile.decision_count}`);
  console.log(`  - 质量关注度: ${(profile.quality_focus * 100).toFixed(0)}%`);
  console.log(`  - 效率关注度: ${(profile.efficiency_focus * 100).toFixed(0)}%`);
  console.log(`  - 安全关注度: ${(profile.safety_focus * 100).toFixed(0)}%`);
  console.log(`  - 协作关注度: ${(profile.collaboration_focus * 100).toFixed(0)}%`);

  if (profile.decision_patterns.length > 0) {
    console.log(`  - 决策模式:`);
    for (const p of profile.decision_patterns) {
      console.log(`    * ${p.pattern} (频率: ${p.frequency}, 成功率: ${(p.success_rate * 100).toFixed(0)}%)`);
    }
  }

  if (profile.priority_rules.length > 0) {
    console.log(`  - 优先级规则:`);
    for (const r of profile.priority_rules.slice(0, 3)) {
      console.log(`    * ${r.when} → ${r.prefer}`);
    }
  }
}

async function testValueInjection() {
  console.log('\n━━━ 测试: 价值观注入到 Prompt ━━━\n');

  const injection = await generateValueInjection('代码安全问题', {
    mode: 'standard',
    maxTokens: 600,
    includeExamples: true,
    includeRules: true,
    includeBoundaries: true
  });

  console.log('生成的价值观注入内容:');
  console.log('─'.repeat(50));
  console.log(injection);
  console.log('─'.repeat(50));
}

async function testJudgmentPromptWithValues() {
  console.log('\n━━━ 测试: 带价值观的判断 Prompt ━━━\n');

  const prompt = await generateJudgmentPromptWithValues(
    '帮我检查这段代码有没有安全漏洞',
    '代码安全问题',
    ['用户询问了登录功能', '用户提到了密码存储']
  );

  console.log('生成的判断 Prompt:');
  console.log('─'.repeat(50));
  console.log(prompt.substring(0, 800) + '...');
  console.log('─'.repeat(50));
}

async function testValueSummary() {
  console.log('\n━━━ 测试: 价值观摘要 ━━━\n');

  const summary = await generateValueSummary();
  console.log(summary);
}

async function testDetectValueConflicts() {
  console.log('\n━━━ 测试: 价值观冲突检测 ━━━\n');

  const result = await detectValueConflicts(
    '添加更多测试来保证质量',
    '跳过测试加快交付速度'
  );

  console.log(`发现冲突: ${result.hasConflict ? '是' : '否'}`);
  if (result.conflicts.length > 0) {
    console.log('冲突点:');
    for (const c of result.conflicts) {
      console.log(`  - ${c}`);
    }
  }
}

async function testSuggestBasedOnValues() {
  console.log('\n━━━ 测试: 基于价值观建议 ━━━\n');

  const situation = '需要选择测试框架';

  const result = await suggestBasedOnValues(situation, [
    'Jest - 简单易用，社区大',
    'Vitest - 现代化，性能好',
    'Mocha - 灵活但配置复杂'
  ]);

  console.log(`情况: ${situation}`);
  console.log(`建议: ${result.recommended}`);
  console.log(`理由: ${result.reasoning}`);
}

async function testGetValueStats() {
  console.log('\n━━━ 测试: 价值观统计 ━━━\n');

  const stats = await getValueStats();
  console.log(`总判断数: ${stats.total_judgments}`);
  console.log(`按类型分布:`, stats.by_type);
  console.log(`按来源分布:`, stats.by_source);
  console.log('Top 价值观:');
  for (const v of stats.top_values) {
    console.log(`  - ${v.category}: ${v.value} (${(v.weight * 100).toFixed(0)}%)`);
  }
}

// ============================================================
// 主测试
// ============================================================

async function main() {
  console.log('========================================');
  console.log('  Human Value Store & Value Injection 测试');
  console.log('========================================');

  try {
    await testStoreJudgments();
    await testLearnFromFeedback();
    await testLearnFromCorrection();
    await testGetRelevantValues();
    await testGetValueProfile();
    await testValueInjection();
    await testJudgmentPromptWithValues();
    await testValueSummary();
    await testDetectValueConflicts();
    await testSuggestBasedOnValues();
    await testGetValueStats();

    console.log('\n========================================');
    console.log('  所有测试通过 ✓');
    console.log('========================================\n');
  } catch (err) {
    console.error('\n测试失败:', err);
    process.exit(1);
  }
}

main();