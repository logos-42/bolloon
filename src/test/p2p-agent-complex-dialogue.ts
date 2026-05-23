/**
 * P2P Agent Complex Multi-Turn Dialogue Test
 * 复杂的智能体多轮对话，基于判断力动态调用 Harness
 *
 * 运行: npx tsx src/test/p2p-agent-complex-dialogue.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

config();

const PORT_ALICE = 6001;
const PORT_BOB = 6002;

// ============================================================================
// Harness 模块 - 完整版
// ============================================================================

interface HarnessDecision {
  shouldCall: boolean;
  gate: number;
  reason: string;
  skills: string[];
  result: string;
}

class HarnessCore {
  private conversationHistory: Array<{ agent: string; content: string; gate?: number }> = [];

  // 基于对话上下文做判断
  decide(content: string, conversationSoFar: string[]): HarnessDecision {
    const context = conversationSoFar.join(' ').toLowerCase();

    // 检查对话历史中的关键阶段
    const hasArchitectureDiscussion = context.includes('架构') || context.includes('设计');
    const hasCodeReview = context.includes('代码') || context.includes('review');
    const hasTaskPlanning = context.includes('任务') || context.includes('分解') || context.includes('计划');
    const hasImplementation = context.includes('实现') || context.includes('写代码') || context.includes('开发');
    const hasTesting = context.includes('测试') || context.includes('验证');

    // 当前消息的关键词
    const currentKeywords = this.extractKeywords(content);

    // 根据对话阶段和当前消息决定
    if (hasArchitectureDiscussion && currentKeywords.some(k => ['检查', '审核', 'review', '分析'].includes(k))) {
      return {
        shouldCall: true,
        gate: 2, // 代码审查 Gate
        reason: '当前处于架构讨论阶段，需要代码审查',
        skills: ['arch', 'guardian-fixer'],
        result: '[Gate 2 - 代码审查] 建议检查接口设计是否符合单一职责原则'
      };
    }

    if (hasTaskPlanning && currentKeywords.some(k => ['分配', '开始', '执行', '完成'].includes(k))) {
      return {
        shouldCall: true,
        gate: 5, // 任务分解 Gate
        reason: '任务规划阶段，需要任务分解',
        skills: ['task-arch', 'crystal-learn'],
        result: '[Gate 5 - 任务分解] 已分解为 4 个子任务，按优先级排序'
      };
    }

    if (hasImplementation && currentKeywords.some(k => ['检查', 'review', '优化', '改进'].includes(k))) {
      return {
        shouldCall: true,
        gate: 7, // 执行 Gate
        reason: '实现阶段，需要代码修改和优化',
        skills: ['harness-eng', 'crystal-learn'],
        result: '[Gate 7 - 代码修改] 建议使用策略模式重构条件判断'
      };
    }

    if (hasTesting || currentKeywords.some(k => ['测试', '验证', '检查'].includes(k))) {
      return {
        shouldCall: true,
        gate: 8, // 测试部署 Gate
        reason: '需要执行测试验证',
        skills: ['harness-eng', 'harness-eng-test'],
        result: '[Gate 8 - 测试] 建议添加单元测试覆盖边界情况'
      };
    }

    if (currentKeywords.some(k => ['架构', '设计', '方案', '结构'].includes(k))) {
      return {
        shouldCall: true,
        gate: 1, // 架构设计 Gate
        reason: '涉及架构设计，需要架构检查',
        skills: ['arch', 'lead'],
        result: '[Gate 1 - 架构设计] 建议采用分层架构，核心业务与基础设施分离'
      };
    }

    if (currentKeywords.some(k => ['安全', '权限', '认证'].includes(k))) {
      return {
        shouldCall: true,
        gate: 4, // 安全验证 Gate
        reason: '涉及安全需求，需要安全检查',
        skills: ['arch', 'guardian-fixer'],
        result: '[Gate 4 - 安全检查] 建议实现 JWT token 过期机制和刷新策略'
      };
    }

    return {
      shouldCall: false,
      gate: 0,
      reason: '普通对话，无需 Harness',
      skills: [],
      result: ''
    };
  }

  private extractKeywords(content: string): string[] {
    const keywords = [
      '分析', '架构', '设计', '检查', '审核', 'review', '分解',
      '任务', '计划', '分配', '实现', '写代码', '开发',
      '测试', '验证', '优化', '改进', '安全', '权限', '认证',
      '开始', '执行', '完成', '方案', '结构'
    ];
    return keywords.filter(k => content.includes(k));
  }

  record(agent: string, content: string, gate?: number): void {
    this.conversationHistory.push({ agent, content, gate });
  }

  getHistory(): Array<{ agent: string; content: string; gate?: number }> {
    return [...this.conversationHistory];
  }
}

// ============================================================================
// 智能体
// ============================================================================

interface DialogLine {
  speaker: string;
  content: string;
  requiresHarness: boolean;
  harnessDecision?: HarnessDecision;
  timestamp: number;
}

class Agent {
  id = crypto.randomUUID();
  name: string;
  port: number;
  harness = new HarnessCore();
  dialogHistory: DialogLine[] = [];
  private peerPort: number | null = null;

  constructor(name: string, port: number) {
    this.name = name;
    this.port = port;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get('/health', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        dialogCount: this.dialogHistory.length
      });
    });

    app.get('/discovery', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port });
    });

    app.get('/dialog', (req, res) => {
      res.json(this.dialogHistory);
    });

    app.post('/message', async (req, res) => {
      const { fromName, content, context } = req.body;

      console.log(`\n📨 [${this.name}] 收到 [${fromName}]: "${content}"`);

      // 构建对话上下文
      const conversationContext = this.dialogHistory
        .slice(-5)
        .map(d => `[${d.speaker}]: ${d.content}`)
        .join(' | ');

      // 做判断
      const decision = this.harness.decide(content, this.dialogHistory.map(d => d.content));

      let response = '';
      let harnessCalled = false;

      if (decision.shouldCall) {
        console.log(`\n🧠 [${this.name}] 判断: 需要调用 Harness`);
        console.log(`   原因: ${decision.reason}`);
        console.log(`   Gate: ${decision.gate}, Skills: ${decision.skills.join(', ')}`);

        harnessCalled = true;
        response = this.generateHarnessResponse(decision, fromName);

        // 记录到 Harness 历史
        this.harness.record(this.name, content, decision.gate);
      } else {
        console.log(`\n🧠 [${this.name}] 判断: 无需 Harness (${decision.reason})`);
        response = this.generateNaturalResponse(content, fromName);
      }

      // 记录对话
      this.dialogHistory.push({
        speaker: fromName,
        content,
        requiresHarness: harnessCalled,
        harnessDecision: harnessCalled ? decision : undefined,
        timestamp: Date.now()
      });

      this.dialogHistory.push({
        speaker: this.name,
        content: response,
        requiresHarness: harnessCalled,
        harnessDecision: harnessCalled ? decision : undefined,
        timestamp: Date.now()
      });

      // 发送回复
      if (this.peerPort) {
        await this.sendToPeer(this.peerPort, this.name, response, this.dialogHistory.map(d => d.content));
      }

      res.json({
        ok: true,
        response,
        requiresHarness: harnessCalled,
        gate: decision.gate,
        skills: decision.skills
      });
    });

    const server = createServer(app);
    return new Promise(resolve => {
      server.listen(this.port, () => {
        console.log(`✓ [${this.name}] 启动 on port ${this.port}`);
        resolve();
      });
    });
  }

  private generateHarnessResponse(decision: HarnessDecision, fromName: string): string {
    const responses: Record<number, string[]> = {
      1: [
        `关于架构设计，我调用了 Harness 进行分析。\n${decision.result}\n\n建议我们采用分层架构，将业务逻辑、数据访问和接口层分离。`,
        `Harness Gate 1 分析完成：\n${decision.result}\n\n我们可以使用依赖注入来降低耦合度。`
      ],
      2: [
        `正在进行代码审查，调用 Harness...\n${decision.result}\n\n建议添加错误边界处理。`,
        `Harness Gate 2 代码审查：\n${decision.result}\n\n需要优化命名规范和添加注释。`
      ],
      4: [
        `安全检查启动，Harness 分析中...\n${decision.result}\n\n建议实现双因素认证。`,
        `Harness Gate 4 安全评估：\n${decision.result}\n\n需要加强输入验证。`
      ],
      5: [
        `任务分解中，Harness 分析...\n${decision.result}\n\n子任务 1: 登录页面\n子任务 2: 认证服务\n子任务 3: 数据库设计\n子任务 4: API 集成`,
        `Harness Gate 5 任务规划：\n${decision.result}\n\n优先级已分配。`
      ],
      7: [
        `代码优化建议来自 Harness：\n${decision.result}\n\n我现在开始重构代码。`,
        `Harness Gate 7 执行建议：\n${decision.result}\n\n正在应用这些改进...`
      ],
      8: [
        `测试策略由 Harness 制定：\n${decision.result}\n\n建议先写单元测试再写集成测试。`,
        `Harness Gate 8 测试计划：\n${decision.result}\n\n测试覆盖率目标 80%。`
      ]
    };

    const responsesForGate = responses[decision.gate] || [decision.result];
    return responsesForGate[Math.floor(Math.random() * responsesForGate.length)];
  }

  private generateNaturalResponse(content: string, fromName: string): string {
    const lower = content.toLowerCase();

    if (lower.includes('你好') || lower.includes('hi') || lower.includes('hello')) {
      return `你好 ${fromName}！我是 ${this.name}，有什么我可以帮你的吗？`;
    }

    if (lower.includes('好的') || lower.includes('同意') || lower.includes('可以')) {
      return `好的，我明白了。继续吧！`;
    }

    if (lower.includes('？') || lower.includes('?')) {
      return `这是个有趣的问题。让我想想...目前我还没有足够的信息来回答，但我们可以继续讨论。`;
    }

    const casualResponses = [
      `嗯，我理解你的意思。`,
      `好的，继续说说你的想法。`,
      `明白了，还有什么要补充的吗？`,
      `有道理，我们继续。`,
      `好的，听起来不错。`
    ];

    return casualResponses[Math.floor(Math.random() * casualResponses.length)];
  }

  async sendToPeer(port: number, fromName: string, content: string, context: string[]): Promise<void> {
    try {
      await fetch(`http://localhost:${port}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromName, content, context })
      });
    } catch (err) {
      console.log(`[${this.name}] 发送失败`);
    }
  }

  setPeer(port: number): void {
    this.peerPort = port;
  }

  getDialogHistory(): DialogLine[] {
    return [...this.dialogHistory];
  }
}

// ============================================================================
// 复杂对话场景
// ============================================================================

async function runComplexDialogue() {
  console.log('\n========================================');
  console.log('  P2P Agent 复杂多轮对话测试');
  console.log('  场景: 智能体协作完成项目需求分析');
  console.log('========================================\n');

  const alice = new Agent('Alice', PORT_ALICE);
  const bob = new Agent('Bob', PORT_BOB);

  // 设置邻居关系
  alice.setPeer(PORT_BOB);
  bob.setPeer(PORT_ALICE);

  console.log('━━━ 启动智能体 ━━━\n');
  await alice.start();
  await bob.start();

  // 定义对话脚本
  const dialogueScript = [
    { from: 'Alice', to: 'Bob', content: 'Bob，我们需要为新项目设计一个用户认证系统。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '好的，让我们先分析需求。包含哪些功能？', expectHarness: false },

    { from: 'Alice', to: 'Bob', content: '需要登录、注册、找回密码，还有权限管理。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '明白了，这些功能需要什么级别的安全性？', expectHarness: false },

    { from: 'Alice', to: 'Bob', content: '需要处理敏感数据，所以安全性很重要。帮我检查一下架构设计。', expectHarness: true },
    { from: 'Bob', to: 'Alice', content: '我来分析一下架构设计，看看有没有安全风险。', expectHarness: true },

    { from: 'Alice', to: 'Bob', content: '架构看起来不错。现在帮我 review 一下登录模块的代码。', expectHarness: true },
    { from: 'Bob', to: 'Alice', content: '好的，让我检查登录模块的代码实现。', expectHarness: true },

    { from: 'Alice', to: 'Bob', content: '代码审查发现了一些问题，需要优化错误处理。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '同意，错误处理需要改进。', expectHarness: false },

    { from: 'Alice', to: 'Bob', content: '好的，现在我们来分解任务，制定开发计划。', expectHarness: true },
    { from: 'Bob', to: 'Alice', content: '我来帮你把任务分解成可执行的小块。', expectHarness: true },

    { from: 'Alice', to: 'Bob', content: '任务分解得很好。我们开始实现第一个任务吧。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '好的，开始实现。完成后记得写测试。', expectHarness: false },

    { from: 'Alice', to: 'Bob', content: '实现完成。帮我验证一下代码质量。', expectHarness: true },
    { from: 'Bob', to: 'Alice', content: '我来执行测试验证代码质量。', expectHarness: true },

    { from: 'Alice', to: 'Bob', content: '测试通过了！项目进展顺利。', expectHarness: false },
    { from: 'Bob', to: 'Alice', content: '太好了！继续加油。', expectHarness: false },
  ];

  console.log('━━━ 开始多轮对话 ━━━\n');

  for (let i = 0; i < dialogueScript.length; i++) {
    const { from, to, content, expectHarness } = dialogueScript[i];

    // 判断当前消息由哪个智能体处理
    const targetPort = from === 'Alice' ? PORT_BOB : PORT_ALICE;

    console.log(`━━━ 第 ${Math.floor(i / 2) + 1} 轮 ━━━`);
    console.log(`[${from}] >>> ${content}`);

    try {
      const resp = await fetch(`http://localhost:${targetPort}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromName: from,
          content,
          context: []
        })
      });

      const result = await resp.json();

      console.log(`\n[${to}] 处理结果:`);
      if (result.requiresHarness) {
        console.log(`   🧠 调用 Harness: Gate ${result.gate}`);
        console.log(`   📋 Skills: ${result.skills?.join(', ') || '无'}`);
      } else {
        console.log(`   🧠 普通对话`);
      }

      console.log(`   📤 回复: ${result.response?.substring(0, 80)}...`);

      // 如果是 Harness 调用，等待一下再继续
      if (result.requiresHarness) {
        await new Promise(r => setTimeout(r, 500));
      }

    } catch (err) {
      console.log(`   ❌ 发送失败:`, err);
    }

    // 轮次之间稍作停顿
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n━━━ 对话汇总 ━━━\n');

  const aliceHistory = alice.getDialogHistory();
  const bobHistory = bob.getDialogHistory();

  console.log(`[Alice] 对话数: ${aliceHistory.length}`);
  console.log(`[Bob] 对话数: ${bobHistory.length}`);

  // 统计 Harness 调用
  const harnessCalls = [...aliceHistory, ...bobHistory].filter(d => d.requiresHarness);
  console.log(`\nHarness 调用次数: ${harnessCalls.length}`);

  console.log('\nHarness 调用详情:');
  harnessCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. [${call.speaker}] Gate ${call.harnessDecision?.gate}`);
    console.log(`     原因: ${call.harnessDecision?.reason}`);
    console.log(`     Skills: ${call.harnessDecision?.skills?.join(', ')}`);
  });

  // 显示对话流程图
  console.log('\n━━━ 对话流程图 ━━━\n');

  const uniqueTurns = Math.floor(dialogueScript.length / 2);
  for (let i = 0; i < uniqueTurns; i++) {
    const userMsg = aliceHistory.find((d, idx) => idx === i * 2);
    const botMsg = bobHistory.find((d, idx) => idx === i * 2 + 1);

    if (userMsg) {
      const harnessIcon = userMsg.requiresHarness ? '🧠' : '  ';
      console.log(`${harnessIcon} [Alice]: ${userMsg.content.substring(0, 40)}...`);
    }
    if (botMsg) {
      const harnessIcon = botMsg.requiresHarness ? '🧠' : '  ';
      console.log(`${harnessIcon} [Bob]:   ${botMsg.content.substring(0, 40)}...`);
    }
    console.log('');
  }

  // 健康检查
  console.log('━━━ 最终状态 ━━━\n');
  const aliceHealth = await fetch(`http://localhost:${PORT_ALICE}/health`).then(r => r.json());
  const bobHealth = await fetch(`http://localhost:${PORT_BOB}/health`).then(r => r.json());

  console.log(`[Alice] 对话数: ${aliceHealth.dialogCount}`);
  console.log(`[Bob] 对话数: ${bobHealth.dialogCount}`);

  // 判断测试成功
  const expectedHarnessCalls = 6; // 期望至少 6 次 Harness 调用
  const success = harnessCalls.length >= expectedHarnessCalls;

  console.log('\n========================================');
  console.log(`  ${success ? '✅ 测试成功' : '⚠️ 测试部分成功'}`);
  console.log(`  Harness 调用: ${harnessCalls.length} / ${expectedHarnessCalls} (期望值)`);
  console.log('========================================\n');
}

runComplexDialogue().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});