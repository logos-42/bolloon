/**
 * P2P Agent Multi-Turn Dialogue (单向发送模式)
 * 模拟真实场景：Alice 发送消息，Bob 处理并回复
 *
 * 运行: npx tsx src/test/p2p-agent-dialogue.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

config();

const PORT_ALICE = 7001;
const PORT_BOB = 7002;

// ============================================================================
// Harness 判断引擎
// ============================================================================

interface HarnessResult {
  called: boolean;
  gate: number;
  skills: string[];
  result: string;
}

class JudgmentEngine {
  private context: string[] = [];
  private gateHistory: number[] = [];

  decide(message: string): HarnessResult {
    this.context.push(message);

    // 根据消息内容和历史上下文判断
    const history = this.context.join(' ').toLowerCase();
    const current = message.toLowerCase();

    // 上下文敏感的判断
    if (current.includes('架构') || current.includes('设计') || current.includes('方案')) {
      this.gateHistory.push(1);
      return {
        called: true,
        gate: 1,
        skills: ['arch', 'lead'],
        result: '[Gate 1 - 架构设计] 建议采用三层架构：表现层、业务层、数据层分离'
      };
    }

    if (current.includes('review') || current.includes('检查') || current.includes('审核')) {
      this.gateHistory.push(2);
      return {
        called: true,
        gate: 2,
        skills: ['arch', 'guardian-fixer'],
        result: '[Gate 2 - 代码审查] 建议添加输入验证和错误处理'
      };
    }

    if (current.includes('安全') || current.includes('权限') || current.includes('认证')) {
      this.gateHistory.push(4);
      return {
        called: true,
        gate: 4,
        skills: ['arch', 'guardian-fixer'],
        result: '[Gate 4 - 安全检查] 建议实现 JWT token 过期和刷新机制'
      };
    }

    if (current.includes('任务') || current.includes('分解') || current.includes('计划')) {
      this.gateHistory.push(5);
      return {
        called: true,
        gate: 5,
        skills: ['task-arch', 'crystal-learn'],
        result: '[Gate 5 - 任务分解] 已分解为 4 个子任务：1)登录 2)注册 3)权限 4)测试'
      };
    }

    if (current.includes('实现') || current.includes('写代码') || current.includes('优化')) {
      this.gateHistory.push(7);
      return {
        called: true,
        gate: 7,
        skills: ['harness-eng', 'crystal-learn'],
        result: '[Gate 7 - 代码实现] 建议使用策略模式重构业务逻辑'
      };
    }

    if (current.includes('测试') || current.includes('验证')) {
      this.gateHistory.push(8);
      return {
        called: true,
        gate: 8,
        skills: ['harness-eng', 'harness-eng-test'],
        result: '[Gate 8 - 测试验证] 测试覆盖率目标 80%，优先测试核心业务'
      };
    }

    return { called: false, gate: 0, skills: [], result: '' };
  }

  getLastGate(): number {
    return this.gateHistory.length > 0 ? this.gateHistory[this.gateHistory.length - 1] : 0;
  }

  clear(): void {
    this.context = [];
    this.gateHistory = [];
  }
}

// ============================================================================
// 智能体 (只响应，不主动发送)
// ============================================================================

interface DialogEntry {
  id: string;
  speaker: string;
  message: string;
  timestamp: number;
  harnessCalled: boolean;
  gate?: number;
}

class Agent {
  id = crypto.randomUUID();
  name: string;
  port: number;
  judgment = new JudgmentEngine();
  history: DialogEntry[] = [];

  constructor(name: string, port: number) {
    this.name = name;
    this.port = port;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get('/health', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port, historyCount: this.history.length });
    });

    app.get('/discovery', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port });
    });

    app.get('/history', (req, res) => {
      res.json(this.history);
    });

    // 接收消息并生成回复
    app.post('/receive', async (req, res) => {
      const { fromName, content } = req.body;

      console.log(`\n📨 [${this.name}] 收到 [${fromName}]: "${content.substring(0, 50)}..."`);

      // 判断是否需要 Harness
      const decision = this.judgment.decide(content);

      let response: string;
      if (decision.called) {
        console.log(`🧠 [${this.name}] 调用 Harness: Gate ${decision.gate}`);
        console.log(`   Skills: ${decision.skills.join(', ')}`);
        console.log(`   ${decision.result}`);

        // 根据 Gate 生成回复
        response = this.generateResponse(decision, fromName);
      } else {
        console.log(`🧠 [${this.name}] 普通回复 (无需 Harness)`);
        response = this.generateNaturalResponse(content, fromName);
      }

      // 记录对话
      this.history.push({
        id: crypto.randomUUID(),
        speaker: fromName,
        message: content,
        timestamp: Date.now(),
        harnessCalled: decision.called,
        gate: decision.gate || undefined
      });

      this.history.push({
        id: crypto.randomUUID(),
        speaker: this.name,
        message: response,
        timestamp: Date.now(),
        harnessCalled: decision.called,
        gate: decision.gate || undefined
      });

      console.log(`📤 [${this.name}] 回复: "${response.substring(0, 50)}..."`);

      res.json({
        ok: true,
        response,
        harnessCalled: decision.called,
        gate: decision.gate
      });
    });

    const server = createServer(app);
    return new Promise(resolve => {
      server.listen(this.port, () => {
        console.log(`✓ [${this.name}] 监听 port ${this.port}`);
        resolve();
      });
    });
  }
}

// ============================================================================
// 响应生成
// ============================================================================

const responses: Record<number, string[]> = {
  1: [
    '关于架构设计，Harness 分析建议采用分层架构，将表现层、业务逻辑和数据访问层分离。这样可以提高代码的可维护性和可测试性。',
    'Harness Gate 1 分析完成。建议使用依赖注入来降低模块间的耦合，这样更利于单元测试。',
  ],
  2: [
    '代码审查完成，Harness 建议添加输入验证和错误边界处理。特别是 API 接口，需要统一错误响应格式。',
    'Gate 2 审查结果：建议为每个函数添加 JSDoc 注释，并使用 ESLint 统一代码风格。',
  ],
  4: [
    '安全检查完成。建议实现 JWT token 的过期机制和刷新策略，同时添加 IP 白名单功能。',
    'Harness Gate 4 建议：使用 HTTPS 加密传输，对敏感操作添加二次验证。',
  ],
  5: [
    '任务已分解为 4 个子任务：\n1. 用户登录模块 (优先级：高)\n2. 用户注册模块 (优先级：高)\n3. 权限管理 (优先级：中)\n4. 集成测试 (优先级：中)\n建议按顺序执行。',
    'Harness Gate 5 分解完成。每个子任务都有明确的完成标准和验收条件。',
  ],
  7: [
    '代码实现中，Harness 建议使用策略模式重构条件判断逻辑，这样更容易扩展新的验证规则。',
    'Gate 7 分析：建议在服务层添加缓存机制，提高响应速度。',
  ],
  8: [
    '测试策略制定完成。目标覆盖率 80%，优先测试核心业务逻辑和边界情况。',
    'Harness Gate 8：建议先写单元测试，再写集成测试，最后进行 E2E 测试。',
  ],
};

function generateNaturalResponses(): string[] {
  return [
    '好的，明白。',
    '我理解了，继续。',
    '没问题，我们继续。',
    '明白，让我看看...',
    '收到，我会处理的。',
    '好的，这个信息很有用。',
    '明白了，还有其他需要讨论的吗？',
  ];
}

class ResponseGenerator {
  private responseIndex = 0;

  generate(decision: HarnessResult, fromName: string): string {
    if (!decision.called) {
      const responses = generateNaturalResponses();
      return responses[this.responseIndex++ % responses.length];
    }

    const gateResponses = responses[decision.gate] || ['已记录你的请求。'];
    return gateResponses[this.responseIndex++ % gateResponses.length];
  }
}

// ============================================================================
// 测试场景
// ============================================================================

async function runDialogue() {
  console.log('\n========================================');
  console.log('  P2P Agent 多轮对话测试');
  console.log('  场景: 完成一个用户认证系统的需求讨论');
  console.log('========================================\n');

  const alice = new Agent('Alice', PORT_ALICE);
  const bob = new Agent('Bob', PORT_BOB);

  await alice.start();
  await bob.start();

  // 对话脚本 (Alice 发送，Bob 接收并回复)
  const script = [
    'Bob，我们需要设计一个用户认证系统。',
    '好的，具体需要哪些功能？',
    '需要登录、注册、找回密码，还要支持社交登录。',
    '明白了。这个系统需要什么级别的安全性？',
    '需要处理金融数据，所以安全性很重要。帮我分析一下架构。',
    '我来分析架构设计。',
    '架构看起来不错。帮我 review 一下登录模块的实现。',
    '好的，检查登录代码...',
    'Review 完成，发现了一些命名规范问题。',
    '好的，我们需要优化错误处理。',
    '同意，现在分解任务吧。',
    '我来把任务分解成可执行的小块。',
    '任务分解得很好。我们开始实现第一个任务。',
    '好的，开始实现登录模块。',
    '实现完成，帮我验证一下代码质量。',
    '运行测试中...',
    '测试通过了！继续下一个任务。',
    '好的，继续实现注册模块。',
    '注册模块也完成了。',
    '测试通过，项目进展顺利！',
  ];

  const responseGen = new ResponseGenerator();

  console.log('━━━ 开始对话 ━━━\n');

  for (let i = 0; i < script.length; i++) {
    const isAliceSending = i % 2 === 0;
    const speaker = isAliceSending ? 'Alice' : 'Bob';
    const content = script[i];

    // Alice 发送消息给 Bob
    console.log(`[${speaker}] >>> ${content}`);

    if (isAliceSending) {
      // Alice -> Bob
      try {
        const resp = await fetch(`http://localhost:${PORT_BOB}/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromName: 'Alice', content })
        });

        const result = await resp.json();

        if (result.harnessCalled) {
          console.log(`🧠 [Bob] Harness: Gate ${result.gate}`);
        } else {
          console.log(`🧠 [Bob] 普通回复`);
        }
        console.log(`📤 [Bob] >>> ${result.response?.substring(0, 60)}...`);
      } catch (err) {
        console.log(`❌ 发送失败:`, err);
      }
    } else {
      // Bob -> Alice
      try {
        const resp = await fetch(`http://localhost:${PORT_ALICE}/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromName: 'Bob', content })
        });

        const result = await resp.json();

        if (result.harnessCalled) {
          console.log(`🧠 [Alice] Harness: Gate ${result.gate}`);
        } else {
          console.log(`🧠 [Alice] 普通回复`);
        }
        console.log(`📤 [Alice] >>> ${result.response?.substring(0, 60)}...`);
      } catch (err) {
        console.log(`❌ 发送失败:`, err);
      }
    }

    await new Promise(r => setTimeout(r, 400));
  }

  // 结果汇总
  console.log('\n━━━ 结果汇总 ━━━\n');

  const aliceHistory = alice.history;
  const bobHistory = bob.history;

  console.log(`[Alice] 对话记录: ${aliceHistory.length} 条`);
  console.log(`[Bob] 对话记录: ${bobHistory.length} 条`);

  const harnessCalls = [...aliceHistory, ...bobHistory].filter(e => e.harnessCalled);
  console.log(`\nHarness 调用次数: ${harnessCalls.length}`);

  // Gate 统计
  const gateStats = new Map<number, number>();
  for (const call of harnessCalls) {
    if (call.gate) {
      gateStats.set(call.gate, (gateStats.get(call.gate) || 0) + 1);
    }
  }

  console.log('\nGate 统计:');
  for (const [gate, count] of gateStats) {
    console.log(`  Gate ${gate}: ${count} 次`);
  }

  // 对话流程
  console.log('\n━━━ 对话流程 ━━━\n');
  for (let i = 0; i < aliceHistory.length; i++) {
    const entry = aliceHistory[i];
    const icon = entry.harnessCalled ? '🧠' : '  ';
    const gateInfo = entry.harnessCalled ? ` [Gate ${entry.gate}]` : '';
    console.log(`${icon} [${entry.speaker}]${gateInfo}: ${entry.message.substring(0, 50)}...`);
  }

  // 健康检查
  console.log('\n━━━ 最终状态 ━━━\n');
  const aliceHealth = await fetch(`http://localhost:${PORT_ALICE}/health`).then(r => r.json());
  const bobHealth = await fetch(`http://localhost:${PORT_BOB}/health`).then(r => r.json());

  console.log(`[Alice] ID: ${aliceHealth.id.substring(0, 16)}...`);
  console.log(`[Bob]   ID: ${bobHealth.id.substring(0, 16)}...`);
  console.log(`\n对话总数: ${aliceHistory.length + bobHistory.length}`);
  console.log(`Harness 调用: ${harnessCalls.length} 次`);

  const success = harnessCalls.length >= 5;
  console.log(`\n${success ? '✅' : '⚠️'} ${success ? '测试成功' : '测试部分成功'}`);

  console.log('\n========================================\n');
}

runDialogue().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});