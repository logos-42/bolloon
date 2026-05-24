/**
 * Channel Agent Multi-Turn Dialogue Test
 *
 * 测试场景：
 * 1. 两个 Channel Agent (Alice/Bob) 之间的多轮对话
 * 2. 基于判断力的 Harness 调用 (Gate 1-8)
 * 3. 上下文感知的 Gate 选择
 * 4. Persona 设计能力
 *
 * 运行: npx tsx src/test/channel-agent-multi-dialogue.ts
 */

import { config } from 'dotenv';
import { ChannelAgent, createChannelAgent, ChannelAgentRegistry } from '../social/channels/channel-agent-session.js';
import type { PersonaDesignRequest } from '../social/persona/enhanced-persona.js';

config();

const PORT_ALICE = 8001;
const PORT_BOB = 8002;

interface DialogScript {
  from: string;
  to: string;
  content: string;
  expectHarness: boolean;
  expectGate?: number;
}

async function testMultiTurnDialogue() {
  console.log('\n========================================');
  console.log('  Channel Agent 多轮对话测试');
  console.log('  场景: 完成一个用户认证系统的需求讨论');
  console.log('========================================\n');

  // 创建 Agent 注册表
  const registry = new ChannelAgentRegistry();

  // 创建 Alice
  const alice = createChannelAgent({
    name: 'Alice',
    port: PORT_ALICE,
    domain: '架构',
    capabilities: ['架构设计', '代码审查', '任务分解']
  });

  // 创建 Bob
  const bob = createChannelAgent({
    name: 'Bob',
    port: PORT_BOB,
    domain: '开发',
    capabilities: ['代码编写', '调试', '测试']
  });

  // 注册
  registry.register(alice);
  registry.register(bob);

  // 设计 persona
  alice.designPersona({
    name: 'Alice',
    type: 'developer',
    domain: '架构',
    tone: 'professional'
  });

  bob.designPersona({
    name: 'Bob',
    type: 'developer',
    domain: '开发',
    tone: 'technical'
  });

  // 启动
  await alice.start();
  await bob.start();

  // 对话脚本
  const script: DialogScript[] = [
    // 第1轮 - 架构讨论
    { from: 'Alice', to: 'Bob', content: 'Bob，我们需要设计一个新的用户认证系统。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '好的，具体需要哪些功能？', expectHarness: false },

    // 第2轮 - 需求讨论
    { from: 'Alice', to: 'Bob', content: '需要登录、注册、找回密码，还要支持社交登录。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '明白了。这个系统需要什么级别的安全性？', expectHarness: false },

    // 第3轮 - 安全讨论 → Gate 4
    { from: 'Alice', to: 'Bob', content: '需要处理金融数据，所以安全性很重要。请检查一下架构设计。', expectHarness: true, expectGate: 4 },
    { from: 'Bob', to: 'Alice', content: '好的，我来分析一下架构设计，看看有没有安全风险。', expectHarness: true, expectGate: 1 },

    // 第4轮 - 代码审查 → Gate 2
    { from: 'Alice', to: 'Bob', content: '架构看起来不错。帮我 review 一下登录模块的实现。', expectHarness: true, expectGate: 2 },
    { from: 'Bob', to: 'Alice', content: '好的，让我检查登录模块的代码实现。', expectHarness: true, expectGate: 2 },

    // 第5轮 - 优化讨论
    { from: 'Alice', to: 'Bob', content: '代码审查发现了一些问题，需要优化错误处理。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '同意，错误处理需要改进。', expectHarness: false },

    // 第6轮 - 任务分解 → Gate 5
    { from: 'Alice', to: 'Bob', content: '好的，现在我们来分解任务，制定开发计划。', expectHarness: true, expectGate: 5 },
    { from: 'Bob', to: 'Alice', content: '我来帮你把任务分解成可执行的小块。', expectHarness: true, expectGate: 5 },

    // 第7轮 - 开始实现
    { from: 'Alice', to: 'Bob', content: '任务分解得很好。我们开始实现第一个任务吧。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '好的，开始实现登录模块。', expectHarness: false },

    // 第8轮 - 代码实现 → Gate 7
    { from: 'Alice', to: 'Bob', content: '实现完成，帮我优化一下代码质量。', expectHarness: true, expectGate: 7 },
    { from: 'Bob', to: 'Alice', content: '好的，我来进行代码优化。', expectHarness: true, expectGate: 7 },

    // 第9轮 - 测试验证 → Gate 8
    { from: 'Alice', to: 'Bob', content: '代码优化完成，帮我验证一下质量。', expectHarness: true, expectGate: 8 },
    { from: 'Bob', to: 'Alice', content: '好的，我来运行测试验证。', expectHarness: true, expectGate: 8 },

    // 第10轮 - 完成
    { from: 'Alice', to: 'Bob', content: '测试通过了！继续下一个任务。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '太好了！继续加油。', expectHarness: false },
  ];

  console.log('━━━ 开始多轮对话 ━━━\n');

  let harnessCallCount = 0;
  const gateStats = new Map<number, number>();

  for (let i = 0; i < script.length; i++) {
    const { from, to, content, expectHarness, expectGate } = script[i];
    const targetPort = from === 'Alice' ? PORT_BOB : PORT_ALICE;

    console.log(`━━━ 第 ${Math.floor(i / 2) + 1} 轮 ━━━`);
    console.log(`[${from}] >>> ${content}`);

    try {
      const resp = await fetch(`http://localhost:${targetPort}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromName: from, content })
      });

      const result = await resp.json();

      console.log(`\n[${to}] 处理结果:`);
      if (result.harnessCalled) {
        console.log(`   🧠 调用 Harness: Gate ${result.gate}`);
        console.log(`   📋 Skills: ${result.skills?.join(', ') || '无'}`);
        harnessCallCount++;
        gateStats.set(result.gate, (gateStats.get(result.gate) || 0) + 1);

        if (expectHarness && result.gate !== expectGate) {
          console.log(`   ⚠️ 期望 Gate ${expectGate}，实际 ${result.gate}`);
        }
      } else {
        console.log(`   🧠 普通对话 (无需 Harness)`);
      }

      console.log(`   📤 回复: ${result.response?.substring(0, 80)}...`);

      // 等待一下再继续
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.log(`   ❌ 发送失败:`, err);
    }

    console.log('');
  }

  // 结果汇总
  console.log('━━━ 结果汇总 ━━━\n');

  console.log(`[Alice] 对话数: ${alice.getDialogHistory().length}`);
  console.log(`[Bob] 对话数: ${bob.getDialogHistory().length}`);

  console.log(`\nHarness 调用次数: ${harnessCallCount}`);

  console.log('\nGate 统计:');
  for (const [gate, count] of Array.from(gateStats.entries()).sort((a, b) => a[0] - b[0])) {
    const gateNames: Record<number, string> = {
      1: '架构设计',
      2: '代码审查',
      4: '安全检查',
      5: '任务分解',
      7: '代码实现',
      8: '测试验证'
    };
    console.log(`  Gate ${gate} (${gateNames[gate] || '未知'}): ${count} 次`);
  }

  // 健康检查
  console.log('\n━━━ 最终状态 ━━━\n');
  const aliceHealth = await fetch(`http://localhost:${PORT_ALICE}/health`).then(r => r.json());
  const bobHealth = await fetch(`http://localhost:${PORT_BOB}/health`).then(r => r.json());

  console.log(`[Alice] DID: ${aliceHealth.id.substring(0, 16)}...`);
  console.log(`[Bob]   DID: ${bobHealth.id.substring(0, 16)}...`);
  console.log(`\n对话总数: ${aliceHealth.dialogCount + bobHealth.dialogCount}`);
  console.log(`Harness 调用: ${harnessCallCount} 次`);

  const success = harnessCallCount >= 6;
  console.log(`\n${success ? '✅' : '⚠️'} ${success ? '测试成功' : '测试部分成功'}`);

  // 清理
  registry.clear();

  console.log('\n========================================\n');

  return success;
}

async function testPersonaDesign() {
  console.log('\n========================================');
  console.log('  Persona 设计测试');
  console.log('========================================\n');

  const agent = createChannelAgent({
    name: 'TestAgent',
    port: 8010,
    domain: '通用'
  });

  await agent.start();

  // 设计不同类型的 persona
  const personaTypes: PersonaDesignRequest[] = [
    { name: 'ArchMaster', type: 'developer', domain: '架构', tone: 'professional' },
    { name: 'CodeReviewer', type: 'reviewer', domain: '安全', tone: 'formal' },
    { name: 'TaskManager', type: 'manager', domain: '项目管理', tone: 'professional' },
    { name: 'CreativeDesigner', type: 'designer', domain: '设计', tone: 'casual' }
  ];

  console.log('━━━ 设计 Persona ━━━\n');

  for (const request of personaTypes) {
    const persona = agent.designPersona(request);
    console.log(`设计 ${request.type} persona:`);
    console.log(`  名称: ${persona.name}`);
    console.log(`  描述: ${persona.description}`);
    console.log(`  性格: ${persona.personality}`);
    console.log(`  能力: ${persona.capabilities.join(', ')}`);
    console.log(`  兴趣: ${persona.interests.join(', ')}`);
    console.log('');
  }

  // 获取当前 persona
  const currentPersona = agent.getPersona();
  console.log('当前 Persona:');
  console.log(JSON.stringify(currentPersona, null, 2));

  agent.shutdown();

  console.log('\n========================================\n');
}

async function main() {
  try {
    await testMultiTurnDialogue();
    await testPersonaDesign();
    process.exit(0);
  } catch (err) {
    console.error('测试失败:', err);
    process.exit(1);
  }
}

main();