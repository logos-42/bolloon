/**
 * P2P Agent + Harness Single Flow Test
 * 测试单轮对话流程，验证判断力和 Harness 调用
 *
 * 运行: npx tsx src/test/p2p-agent-harness-single.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

config();

const PORT_ALICE = 5001;
const PORT_BOB = 5002;

// ============================================================================
// Harness 模块
// ============================================================================

class HarnessCore {
  execute(gate: number, context: string): { result: string; skills: string[] } {
    const skills = ['arch', 'lead', 'harness-eng'];
    let result = '';

    switch (gate) {
      case 1: result = '[架构检查] 分析完成，建议分离关注点'; break;
      case 2: result = '[代码审查] 检查完成，建议添加错误处理'; break;
      case 5: result = '[任务分解] 分解为3个子任务'; break;
      default: result = `[Gate ${gate}] 处理完成`;
    }

    console.log(`   🔧 Harness 执行: Gate ${gate}, Skills: ${skills.join(', ')}`);
    console.log(`   📋 结果: ${result}`);

    return { result, skills };
  }
}

// ============================================================================
// 智能体
// ============================================================================

class Agent {
  id = crypto.randomUUID();
  name: string;
  port: number;
  harness = new HarnessCore();
  messages: string[] = [];

  constructor(name: string, port: number) {
    this.name = name;
    this.port = port;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get('/health', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port });
    });

    app.get('/discovery', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port });
    });

    // 消息处理 - 每个消息只处理一次，不回复
    app.post('/message', async (req, res) => {
      const { fromName, content } = req.body;

      console.log(`\n📨 [${this.name}] 收到来自 ${fromName}: "${content.substring(0, 50)}..."`);

      // 判断是否需要 Harness
      const keywords = ['分析', '架构', '检查', '审核', 'review', '分解', '设计'];
      const needsHarness = keywords.some(k => content.toLowerCase().includes(k));

      if (needsHarness) {
        console.log(`🧠 [${this.name}] 需要调用 Harness`);
        const result = this.harness.execute(1, content);
        console.log(`📤 [${this.name}] 回复: ${result.result}`);
      } else {
        console.log(`🧠 [${this.name}] 不需要 Harness`);
        console.log(`📤 [${this.name}] 回复: 收到！`);
      }

      this.messages.push(`[${fromName}]: ${content}`);
      this.messages.push(`[${this.name}]: ${needsHarness ? '已调用Harness' : '简单回复'}`);

      res.json({ ok: true, reply: needsHarness ? '已调用Harness处理' : '收到！' });
    });

    const server = createServer(app);
    return new Promise(resolve => {
      server.listen(this.port, () => {
        console.log(`✓ [${this.name}] 启动 on port ${this.port}`);
        resolve();
      });
    });
  }
}

// ============================================================================
// 测试
// ============================================================================

async function runTest() {
  console.log('\n========================================');
  console.log('  P2P Agent + Harness 单轮流程测试');
  console.log('========================================\n');

  const alice = new Agent('Alice', PORT_ALICE);
  const bob = new Agent('Bob', PORT_BOB);

  console.log('━━━ 启动智能体 ━━━\n');
  await alice.start();
  await bob.start();

  console.log('\n━━━ 对话测试 ━━━\n');

  // 对话 1: 需要 Harness
  console.log('【对话 1】Alice -> Bob: 分析架构');
  await fetch(`http://localhost:${PORT_BOB}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromName: 'Alice', content: 'Bob，帮我分析一下代码架构' })
  });

  await new Promise(r => setTimeout(r, 1000));

  // 对话 2: 不需要 Harness
  console.log('\n【对话 2】Alice -> Bob: 简单问候');
  await fetch(`http://localhost:${PORT_BOB}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromName: 'Alice', content: 'Bob，你好吗？' })
  });

  await new Promise(r => setTimeout(r, 1000));

  // 对话 3: 需要 Harness
  console.log('\n【对话 3】Bob -> Alice: 代码审查');
  await fetch(`http://localhost:${PORT_ALICE}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromName: 'Bob', content: 'Alice，帮我 review 这段代码' })
  });

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n━━━ 结果汇总 ━━━\n');
  console.log(`Alice 消息数: ${alice.messages.length}`);
  console.log(`Bob 消息数: ${bob.messages.length}`);

  console.log('\n[Alice] 历史:');
  alice.messages.forEach(m => console.log(`  ${m}`));

  console.log('\n[Bob] 历史:');
  bob.messages.forEach(m => console.log(`  ${m}`));

  // 健康检查
  const aliceHealth = await fetch(`http://localhost:${PORT_ALICE}/health`).then(r => r.json());
  const bobHealth = await fetch(`http://localhost:${PORT_BOB}/health`).then(r => r.json());

  console.log('\n━━━ 健康状态 ━━━');
  console.log(`Alice: ${aliceHealth.name} (ID: ${aliceHealth.id.substring(0, 8)}...)`);
  console.log(`Bob: ${bobHealth.name} (ID: ${bobHealth.id.substring(0, 8)}...)`);

  console.log('\n========================================');
  console.log('  测试完成');
  console.log('========================================\n');
}

runTest().catch(console.error);