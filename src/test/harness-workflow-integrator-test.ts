/**
 * Harness Workflow Integrator Test
 *
 * 测试 Channel Agent 与 Bollharness 配置系统的集成
 *
 * 运行: npx tsx src/test/harness-workflow-integrator-test.ts
 */

import { config } from 'dotenv';
import {
  createHarnessWorkflowIntegrator,
  HarnessWorkflowIntegrator
} from '../social/channels/harness-workflow-integrator.js';
import {
  createChannelAgent,
  ChannelAgent
} from '../social/channels/channel-agent-session.js';
import { createChannelJudgmentEngine } from '../bollharness-integration/channel-judgment-engine.js';

config();

async function testWorkflowIntegrator() {
  console.log('\n========================================');
  console.log('  Harness Workflow Integrator 测试');
  console.log('========================================\n');

  const integrator = createHarnessWorkflowIntegrator();
  await integrator.initialize();

  console.log('━━━ Gate 状态测试 ━━━\n');

  // 测试 Gate 状态
  let status = integrator.getWorkflowStatus();
  console.log(`当前 Gate: ${status.gateName} (${status.progress})`);
  console.log(`Blockers: ${status.blockers.length > 0 ? status.blockers.join(', ') : '无'}`);

  // 提交产物
  console.log('\n提交产物到 Gate 0...');
  integrator.submitArtifact('user_request', '设计一个用户认证系统');
  integrator.submitArtifact('change_classification', 'implementation');

  // 测试 Gate 转移
  console.log('\n尝试转移到 Gate 1...');
  let result = await integrator.transitionGate();
  console.log(`转移结果: ${result.message}`);
  console.log(`Success: ${result.success}`);

  status = integrator.getWorkflowStatus();
  console.log(`\n当前 Gate: ${status.gateName} (${status.progress})`);

  // 测试 Skill 路由
  console.log('\n━━━ Skill 路由测试 ━━━\n');

  const testMessages = [
    '帮我设计一个微服务架构',
    'review 一下这段代码',
    '我们需要实现用户登录功能',
    '帮我分解这个任务',
    '测试一下代码覆盖率',
    '分析一下系统的安全性'
  ];

  for (const msg of testMessages) {
    const skills = integrator.routeSkillsByKeyword(msg);
    console.log(`"${msg}"`);
    console.log(`  → Skills: ${skills.join(', ')}`);
    console.log('');
  }

  // 测试 Gate Pack
  console.log('━━━ Gate Pack 测试 ━━━\n');

  const gatePack = integrator.getGatePack();
  console.log('当前 Gate Pack:');
  console.log(JSON.stringify(gatePack, null, 2));

  console.log('\n========================================\n');
}

async function testAgentWithHarness() {
  console.log('\n========================================');
  console.log('  Channel Agent + Harness 集成测试');
  console.log('========================================\n');

  // 创建 Agent
  const alice = createChannelAgent({
    name: 'Alice',
    port: 9101,
    domain: '架构',
    capabilities: ['架构设计', '代码审查', '任务分解']
  });

  const integrator = createHarnessWorkflowIntegrator();
  await integrator.initialize();

  await alice.start();

  console.log('━━━ 多轮对话 + Harness + Gate 测试 ━━━\n');

  const script = [
    {
      from: 'Alice',
      content: 'Bob，我们需要设计一个新的微服务架构。',
      expectedGate: 1
    },
    {
      from: 'Bob',
      content: '好的，我来帮你分析架构设计。',
      expectedGate: 1
    },
    {
      from: 'Alice',
      content: '帮我 review 一下代码实现。',
      expectedGate: 2
    },
    {
      from: 'Bob',
      content: '代码审查完成，需要优化错误处理。',
      expectedGate: 0
    },
    {
      from: 'Alice',
      content: '好的，现在分解任务，制定开发计划。',
      expectedGate: 5
    },
    {
      from: 'Bob',
      content: '任务已分解为 4 个子任务。',
      expectedGate: 5
    }
  ];

  let harnessCallCount = 0;
  const gateStats = new Map<number, number>();

  for (let i = 0; i < script.length; i++) {
    const { from, content, expectedGate } = script[i];
    const to = from === 'Alice' ? 'Bob' : 'Alice';

    console.log(`[${from}] >>> ${content}`);

    // 通过 Agent 处理
    const result = await alice.receiveMessage(from, content);

    // 路由 Skill
    const skills = integrator.routeSkillsByKeyword(content);

    console.log(`[${to}] 处理结果:`);
    console.log(`  🧠 Harness调用: ${result.harnessCalled ? '是' : '否'}`);
    if (result.harnessCalled) {
      console.log(`  Gate ${result.gate}`);
      console.log(`  Skills: ${skills.join(', ')}`);
      harnessCallCount++;
      gateStats.set(result.gate!, (gateStats.get(result.gate!) || 0) + 1);

      if (result.gate !== expectedGate) {
        console.log(`  ⚠️ 期望 Gate ${expectedGate}`);
      }
    }
    console.log(`  回复: ${result.response.substring(0, 60)}...`);
    console.log('');

    await new Promise(r => setTimeout(r, 200));
  }

  console.log('━━━ 结果汇总 ━━━\n');
  console.log(`Harness 调用次数: ${harnessCallCount}`);
  console.log('\nGate 统计:');

  const gateNames: Record<number, string> = {
    1: '架构设计',
    2: '代码审查',
    4: '安全检查',
    5: '任务分解',
    7: '代码实现',
    8: '测试验证'
  };

  for (const [gate, count] of Array.from(gateStats.entries()).sort((a, b) => a[0] - b[0])) {
    console.log(`  Gate ${gate} (${gateNames[gate] || '未知'}): ${count} 次`);
  }

  console.log('\n当前工作流状态:');
  const status = integrator.getWorkflowStatus();
  console.log(`  ${status.gateName} (${status.progress})`);

  const success = harnessCallCount >= 3;
  console.log(`\n${success ? '✅' : '⚠️'} ${success ? '测试成功' : '测试失败'}`);

  alice.shutdown();

  console.log('\n========================================\n');

  return success;
}

async function testSkillRouting() {
  console.log('\n========================================');
  console.log('  Skill 路由测试');
  console.log('========================================\n');

  const integrator = createHarnessWorkflowIntegrator();
  await integrator.initialize();

  const judgmentEngine = createChannelJudgmentEngine();

  const testCases = [
    {
      message: '帮我设计一个三层架构方案',
      expectedKeywords: ['架构', '设计'],
      expectedSkills: ['arch', 'lead']
    },
    {
      message: 'review 一下登录模块的实现',
      expectedKeywords: ['review'],
      expectedSkills: ['guardian-fixer', 'arch']
    },
    {
      message: '系统需要支持 OAuth2 认证',
      expectedKeywords: ['认证'],
      expectedSkills: ['guardian-fixer', 'arch']
    },
    {
      message: '把这个任务分解成可执行的子任务',
      expectedKeywords: ['任务', '分解'],
      expectedSkills: ['task-arch', 'harness-eng']
    },
    {
      message: '帮我写用户注册模块的代码',
      expectedKeywords: ['写代码', '实现'],
      expectedSkills: ['harness-dev', 'harness-eng']
    },
    {
      message: '运行单元测试验证功能',
      expectedKeywords: ['测试', '验证'],
      expectedSkills: ['harness-eng-test', 'guardian-fixer']
    }
  ];

  console.log('━━━ 测试用例 ━━━\n');

  let passed = 0;
  for (const tc of testCases) {
    // 通过 JudgmentEngine 判断
    const context = {
      conversationHistory: [],
      currentMessage: tc.message
    };
    const judgment = judgmentEngine.decide(context);

    // 通过 Integrator 路由 Skill
    const skills = integrator.routeSkillsByKeyword(tc.message);

    const judgmentGateMatch = judgment.shouldCall;
    const skillMatch = skills.some(s => tc.expectedSkills.includes(s));

    const status = judgmentGateMatch && skillMatch ? '✅' : '⚠️';

    console.log(`${status} "${tc.message}"`);
    console.log(`   Judgment: ${judgment.shouldCall ? `Gate ${judgment.gate}` : '无需 Harness'}`);
    console.log(`   Skills: ${skills.join(', ') || '无'}`);

    if (judgment.shouldCall && skillMatch) passed++;

    console.log('');
  }

  console.log(`通过率: ${passed}/${testCases.length}`);

  console.log('\n========================================\n');
}

async function main() {
  try {
    await testWorkflowIntegrator();
    await testSkillRouting();
    await testAgentWithHarness();
    process.exit(0);
  } catch (err) {
    console.error('测试失败:', err);
    process.exit(1);
  }
}

main();