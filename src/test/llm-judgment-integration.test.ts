/**
 * LLM-as-Judge 集成测试
 *
 * 测试内容：
 * 1. LLMJudgmentClient 的 LLM 调用
 * 2. Prompt 变体 (concise/standard/deep) 的选择
 * 3. Skill Prompt 配置化
 * 4. ChannelJudgmentEngine 的 LLM 集成
 *
 * 运行: npx tsx src/test/llm-judgment-integration.test.ts
 */

import { config } from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createLLMJudgmentClient, type LLMJudgmentResult, JUDGMENT_PROMPTS } from '../llm/llm-judgment-client.js';
import { createChannelJudgmentEngine } from '../bollharness-integration/channel-judgment-engine.js';
import { createLLMJudgmentEngine, SKILL_PROMPTS, type LLMJudgmentResult as EngineResult } from '../bollharness-integration/llm-judgment-engine.js';
import * as fs from 'fs';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试用例
const TEST_CASES = [
  {
    input: '我们需要设计一个用户认证系统，包含登录、注册和OAuth社交登录。',
    description: '架构设计问题',
    expected: { approach: 'design', complexity: 'complex' }
  },
  {
    input: '帮我 review 一下这段代码有没有安全问题',
    description: '代码审查问题',
    expected: { approach: 'analyze', skills: ['guardian-fixer'] }
  },
  {
    input: '如何实现JWT token的刷新机制？',
    description: '实现问题',
    expected: { approach: 'implement' }
  },
  {
    input: '这个任务比较复杂，帮我分解一下',
    description: '任务分解问题',
    expected: { approach: 'coordinate', skills: ['task-arch'] }
  }
];

// 测试 Prompt 变体
async function testPromptVariants() {
  console.log('\n━━━ Prompt 变体测试 ━━━\n');

  const client = await createLLMJudgmentClient({ useLLM: true });

  for (const promptName of ['default', 'architecture', 'code', 'security']) {
    const config = JUDGMENT_PROMPTS[promptName];
    console.log(`[${promptName}]`);
    console.log(`  System prompt 长度: ${config.systemPrompt.length} 字符`);
    console.log(`  Output format: ${config.outputFormat}`);
  }
}

// 测试 LLMJudgmentClient
async function testLLMJudgmentClient() {
  console.log('\n━━━ LLMJudgmentClient 测试 ━━━\n');

  const client = await createLLMJudgmentClient({ useLLM: false }); // 快速模式

  for (const tc of TEST_CASES) {
    console.log(`测试: ${tc.description}`);
    console.log(`输入: "${tc.input.substring(0, 40)}..."`);

    const result = await client.judge(tc.input, {
      senderName: 'TestUser',
      history: ['之前的对话']
    });

    console.log(`  Approach: ${result.decision.approach}`);
    console.log(`  Complexity: ${result.assessment.complexity}`);
    console.log(`  Skills: ${result.routing.skills.join(', ')}`);
    console.log();
  }
}

// 测试 Skill Prompts 配置
function testSkillPromptsConfig() {
  console.log('\n━━━ Skill Prompts 配置化测试 ━━━\n');

  const skillNames = Object.keys(SKILL_PROMPTS);
  console.log(`已配置的 Skills: ${skillNames.join(', ')}\n`);

  for (const [name, skill] of Object.entries(SKILL_PROMPTS)) {
    console.log(`[${name}]`);
    console.log(`  名称: ${skill.name}`);
    console.log(`  描述: ${skill.description}`);
    console.log(`  System prompt 长度: ${skill.systemPrompt.length} 字符`);
    console.log(`  Output format: ${skill.outputFormat}`);
    console.log();
  }
}

// 测试 YAML 配置加载
async function testYAMLConfig() {
  console.log('\n━━━ YAML 配置文件测试 ━━━\n');

  const yamlPath = path.join(__dirname, '../bollharness-integration/judgment-prompts.yaml');

  try {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    console.log(`✓ YAML 配置文件存在`);
    console.log(`  路径: ${yamlPath}`);
    console.log(`  大小: ${content.length} 字节`);

    // 简单解析检查
    const hasPromptVariants = content.includes('prompt_variants');
    const hasSkills = content.includes('skills:');
    const hasOutputFormats = content.includes('output_formats');

    console.log(`  包含 Prompt 变体: ${hasPromptVariants ? '✓' : '✗'}`);
    console.log(`  包含 Skills 配置: ${hasSkills ? '✓' : '✗'}`);
    console.log(`  包含输出格式: ${hasOutputFormats ? '✓' : '✗'}`);

    // 解析行数统计
    const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    console.log(`  非注释行数: ${lines.length}`);
  } catch (err) {
    console.error(`✗ YAML 配置文件读取失败:`, err);
  }
}

// 测试 ChannelJudgmentEngine
async function testChannelJudgmentEngine() {
  console.log('\n━━━ ChannelJudgmentEngine 测试 ━━━\n');

  const engine = createChannelJudgmentEngine({ useLLM: false });

  const testInputs = [
    '我们需要设计一个微服务架构',
    '帮我 review 这段代码',
    '这个功能需要安全检查',
    '任务分解一下',
    '实现登录功能'
  ];

  for (const input of testInputs) {
    const result = await engine.decide({
      conversationHistory: [],
      currentMessage: input,
      senderName: 'TestUser'
    });

    console.log(`输入: "${input}"`);
    console.log(`  调用 Harness: ${result.shouldCall}`);
    if (result.shouldCall) {
      console.log(`  Gate: ${result.gate}`);
      console.log(`  Skills: ${result.skills.join(', ')}`);
      console.log(`  置信度: ${(result.confidence * 100).toFixed(0)}%`);
    }
    console.log();
  }
}

// 测试 LLMJudgmentEngine
async function testLLMJudgmentEngine() {
  console.log('\n━━━ LLMJudgmentEngine 测试 ━━━\n');

  const engine = createLLMJudgmentEngine({ useLLM: false });

  for (const tc of TEST_CASES) {
    console.log(`测试: ${tc.description}`);
    const result = await engine.judge(tc.input, { history: ['之前的对话'] });

    console.log(`  Understanding:`);
    console.log(`    - Essence: ${result.understanding.essence}`);
    console.log(`    - Core Need: ${result.understanding.coreNeed}`);
    console.log(`  Assessment:`);
    console.log(`    - Complexity: ${result.assessment.complexity}`);
    console.log(`    - Depth: ${result.assessment.depth}`);
    console.log(`  Decision:`);
    console.log(`    - Approach: ${result.decision.approach}`);
    console.log(`  Routing:`);
    console.log(`    - Skills: ${result.routing.skills.join(', ')}`);
    console.log(`    - Collaboration: ${result.routing.collaboration}`);
    console.log();
  }
}

// 测试 DynamicSkillRouter
async function testDynamicSkillRouter() {
  console.log('\n━━━ DynamicSkillRouter 测试 ━━━\n');

  const { createDynamicSkillRouter } = await import('../bollharness-integration/llm-judgment-engine.js');
  const router = createDynamicSkillRouter({ useLLM: false });

  const availableSkills = router.listSkills();
  console.log(`可用的 Skills: ${availableSkills.join(', ')}`);

  // 测试单个 Skill 调用
  const judgment: EngineResult = {
    understanding: {
      essence: 'how-to',
      coreNeed: '设计方案',
      implicit: []
    },
    assessment: {
      complexity: 'complex',
      complexityReason: '涉及架构设计',
      depth: 'deeper',
      urgency: 'medium'
    },
    decision: {
      approach: 'design',
      reasoning: '需要架构设计'
    },
    routing: {
      skills: ['arch'],
      agents: [],
      collaboration: 'pair'
    },
    artifacts: {
      required: ['架构文档']
    }
  };

  const results = await router.routeAndExecute('设计一个电商系统', judgment);
  console.log(`\nSkill 执行结果:`);
  for (const [skill, result] of Object.entries(results)) {
    console.log(`  ${skill}: ${String(result).substring(0, 100)}...`);
  }
}

// 主测试函数
async function main() {
  console.log('========================================');
  console.log('  LLM-as-Judge 集成测试');
  console.log('========================================');

  try {
    await testPromptVariants();
    await testLLMJudgmentClient();
    testSkillPromptsConfig();
    await testYAMLConfig();
    await testChannelJudgmentEngine();
    await testLLMJudgmentEngine();
    await testDynamicSkillRouter();

    console.log('\n========================================');
    console.log('  测试完成 ✓');
    console.log('========================================\n');
  } catch (err) {
    console.error('\n测试失败:', err);
    process.exit(1);
  }
}

main();