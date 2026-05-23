/**
 * P2P Agent with Harness Full Flow Test
 * 测试两个智能体通过 P2P 进行有意义对话，并基于判断力调用 Harness
 *
 * 运行: npx tsx src/test/p2p-agent-harness-flow.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

config();

const PORT_ALICE = 4001;
const PORT_BOB = 4002;

// ============================================================================
// Harness 模块 (模拟 Bollharness)
// ============================================================================

interface HarnessDecision {
  shouldCall: boolean;
  gate: number;
  reason: string;
  action?: string;
}

interface HarnessResponse {
  success: boolean;
  gate: number;
  skills: string[];
  result?: string;
  message: string;
}

class HarnessCore {
  private gateHistory: Map<string, number> = new Map();

  // 判断是否需要调用 Harness
  decide(context: string, agentId: string): HarnessDecision {
    const lowerContext = context.toLowerCase();

    // 检查是否涉及需要 Harness 的关键词
    const decisionKeywords = [
      '分析', '检查', '审核', '验证', '确认', '评估',
      '决定', '选择', '计划', '架构', '设计',
      '修复', '改进', '优化', '重构',
      '测试', '部署', '发布',
      '安全', '性能', '质量',
      'git', 'commit', 'review', 'merge'
    ];

    const matchedKeywords = decisionKeywords.filter(k => lowerContext.includes(k));

    if (matchedKeywords.length > 0) {
      const gate = this.determineGate(matchedKeywords);

      return {
        shouldCall: true,
        gate,
        reason: `检测到关键词: ${matchedKeywords.join(', ')}`,
        action: this.getGateAction(gate)
      };
    }

    return {
      shouldCall: false,
      gate: 0,
      reason: '上下文无需 Harness 处理'
    };
  }

  private determineGate(keywords: string[]): number {
    const gateMap: Record<string, number> = {
      '架构': 1, '设计': 1,
      '审核': 2, 'review': 2, '检查': 2,
      '计划': 3, '决定': 3, '选择': 3,
      '任务': 5, '分解': 5,
      '执行': 7, '修复': 7, '改进': 7, '优化': 7,
      '测试': 8, '部署': 8, '发布': 8,
      '安全': 4, '验证': 4,
      'git': 2, 'commit': 2, 'merge': 2
    };

    let maxGate = 0;
    for (const kw of keywords) {
      const gate = gateMap[kw] || 0;
      if (gate > maxGate) maxGate = gate;
    }

    return maxGate || 1; // 默认 Gate 1
  }

  private getGateAction(gate: number): string {
    const actions: Record<number, string> = {
      0: '无需操作',
      1: '执行架构检查',
      2: '执行代码审查',
      3: '执行计划冻结',
      4: '执行安全验证',
      5: '执行任务分解',
      6: '执行 Guard 检查',
      7: '执行代码修改',
      8: '执行测试部署'
    };
    return actions[gate] || '执行通用检查';
  }

  // 执行 Harness 流程
  execute(gate: number, context: string): HarnessResponse {
    const skills = this.getGateSkills(gate);

    console.log(`\n🔧 [Harness] 执行 Gate ${gate}:`);
    console.log(`   Context: ${context.substring(0, 50)}...`);
    console.log(`   Skills: ${skills.join(', ')}`);

    // 模拟不同 Gate 的处理
    let result = '';
    switch (gate) {
      case 1:
        result = this.executeArchitectureCheck(context);
        break;
      case 2:
        result = this.executeCodeReview(context);
        break;
      case 3:
        result = this.executePlanFreeze(context);
        break;
      case 5:
        result = this.executeTaskArch(context);
        break;
      case 7:
        result = this.executeCodeModify(context);
        break;
      case 8:
        result = this.executeTestDeploy(context);
        break;
      default:
        result = this.executeGenericCheck(context);
    }

    return {
      success: true,
      gate,
      skills,
      result,
      message: `Gate ${gate} 处理完成`
    };
  }

  private getGateSkills(gate: number): string[] {
    const skillsMap: Record<number, string[]> = {
      0: [],
      1: ['arch', 'lead'],
      2: ['arch', 'guardian-fixer'],
      3: ['harness-eng', 'plan-lock'],
      4: ['arch', 'guardian-fixer'],
      5: ['task-arch', 'crystal-learn'],
      6: ['guardian-fixer'],
      7: ['harness-eng', 'crystal-learn'],
      8: ['harness-eng', 'harness-eng-test']
    };
    return skillsMap[gate] || ['arch', 'lead'];
  }

  private executeArchitectureCheck(ctx: string): string {
    return `[架构检查] 分析完成\n建议: 分离关注点，使用接口隔离依赖`;
  }

  private executeCodeReview(ctx: string): string {
    return `[代码审查] 检查完成\n建议: 添加错误处理，优化命名规范`;
  }

  private executePlanFreeze(ctx: string): string {
    return `[计划冻结] 确认完成\n计划已锁定，等待执行`;
  }

  private executeTaskArch(ctx: string): string {
    return `[任务分解] 完成\n分解为 3 个子任务，已分配优先级`;
  }

  private executeCodeModify(ctx: string): string {
    return `[代码修改] 完成\n已应用修改，代码质量提升`;
  }

  private executeTestDeploy(ctx: string): string {
    return `[测试部署] 完成\n测试通过，部署就绪`;
  }

  private executeGenericCheck(ctx: string): string {
    return `[通用检查] 完成\n建议: 保持代码一致性`;
  }

  recordGate(agentId: string, gate: number): void {
    this.gateHistory.set(agentId, gate);
  }

  getGateHistory(agentId: string): number {
    return this.gateHistory.get(agentId) || 0;
  }
}

// ============================================================================
// 智能体
// ============================================================================

interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  isReply: boolean;
  requiresHarness: boolean;
  harnessResult?: HarnessResponse;
}

class Agent {
  id: string;
  name: string;
  port: number;
  harness: HarnessCore;
  private peers: Map<string, number> = new Map();
  private messageHistory: Message[] = [];
  private httpServer: any = null;
  private processingReply: Set<string> = new Set(); // 防止重复处理同一条消息

  constructor(name: string, port: number) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.port = port;
    this.harness = new HarnessCore();
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    // 健康检查
    app.get('/health', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        peers: Array.from(this.peers.keys()),
        messageCount: this.messageHistory.length
      });
    });

    // 发现端点
    app.get('/discovery', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        topic: 'bolloon-agent-harness'
      });
    });

    // 接收消息
    app.post('/message', async (req, res) => {
      const { fromName, content, messageId } = req.body;

      // 使用 messageId 或 content hash 来去重，避免处理自己的回复
      const msgKey = messageId || `${fromName}:${content.substring(0, 30)}`;
      if (this.processingReply.has(msgKey)) {
        return res.json({ ok: true, skipped: true });
      }
      this.processingReply.add(msgKey);
      setTimeout(() => this.processingReply.delete(msgKey), 3000);

      console.log(`\n📨 [${this.name}] 收到来自 ${fromName} 的消息:`);
      console.log(`   "${content.substring(0, 60)}..."`);

      // 分析消息，决定是否调用 Harness
      const decision = this.harness.decide(content, this.id);

      let response = '';
      let harnessResult: HarnessResponse | undefined;

      if (decision.shouldCall) {
        console.log(`\n🧠 [${this.name}] 判断力决策: 需要调用 Harness`);
        console.log(`   原因: ${decision.reason}`);
        console.log(`   行动: ${decision.action}`);

        // 调用 Harness
        harnessResult = this.harness.execute(decision.gate, content);
        this.harness.recordGate(this.id, decision.gate);

        // 生成基于 Harness 结果的回复
        response = this.generateResponseFromHarness(content, harnessResult);
      } else {
        console.log(`\n🧠 [${this.name}] 判断力决策: 无需 Harness`);
        console.log(`   原因: ${decision.reason}`);
        response = this.generateNaturalResponse(content);
      }

      // 保存消息（标记为非回复）
      const msg: Message = {
        id: crypto.randomUUID(),
        from: fromName,
        to: this.name,
        content,
        timestamp: Date.now(),
        isReply: false,
        requiresHarness: decision.shouldCall,
        harnessResult
      };
      this.messageHistory.push(msg);

      // 发送回复（添加唯一 messageId 防止循环）
      const peerPort = Array.from(this.peers.entries())[0]?.[1];
      if (peerPort) {
        const replyMsgId = crypto.randomUUID();
        await this.sendMessage(peerPort, fromName, response, replyMsgId);
      }

      res.json({ ok: true, response, messageId: replyMsgId });
    });

    // 发现邻居
    app.get('/nodes', (req, res) => {
      const nodes = Array.from(this.peers.entries()).map(([id, port]) => ({
        id,
        name: this.peers.get(id) === port ? id : 'unknown',
        port
      }));
      nodes.push({ id: this.id, name: this.name, port: this.port });
      res.json(nodes);
    });

    this.httpServer = createServer(app);

    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.port, () => {
        console.log(`\n✓ [${this.name}] 启动成功 on port ${this.port}`);
        resolve();
      });
      this.httpServer.on('error', reject);
    });
  }

  private generateResponseFromHarness(content: string, result: HarnessResponse): string {
    const responses = [
      `根据 Harness Gate ${result.gate} 的分析：\n${result.result}\n\n建议: ${result.message}`,
      `Harness 处理完成 (Gate ${result.gate}, Skills: ${result.skills.join(', ')})\n\n${result.result}`,
      `经过 ${result.gate} 阶段审查：\n${result.result}\n\n状态: ${result.message}`
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }

  private generateNaturalResponse(content: string): string {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('你好') || lowerContent.includes('hi') || lowerContent.includes('hello')) {
      return `你好！我是 ${this.name}，有什么我可以帮助的吗？`;
    }

    if (lowerContent.includes('?') || lowerContent.includes('？') || lowerContent.includes('怎么') || lowerContent.includes('如何')) {
      return `好问题！让我帮你分析一下...（但这个问题不需要调用 Harness 进行深度分析）`;
    }

    return `收到！这个问题比较简单，我可以直接回答。`;
  }

  async sendMessage(toPort: number, toName: string, content: string, messageId?: string): Promise<void> {
    try {
      await fetch(`http://localhost:${toPort}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromName: this.name,
          content,
          messageId
        })
      });
    } catch (err) {
      console.log(`[${this.name}] 发送失败:`, err);
    }
  }

  async discoverPeers(): Promise<void> {
    const ports = [4001, 4002, 4003, 4004, 4005];

    for (const port of ports) {
      if (port === this.port) continue;

      try {
        const resp = await fetch(`http://localhost:${port}/discovery`, {
          signal: AbortSignal.timeout(1000)
        });

        if (resp.ok) {
          const info = await resp.json();
          if (info.id !== this.id && !this.peers.has(info.id)) {
            console.log(`\n🔍 [${this.name}] 发现邻居: ${info.name} on port ${info.port}`);
            this.peers.set(info.id, info.port);
          }
        }
      } catch {}
    }
  }

  getMessageHistory(): Message[] {
    return [...this.messageHistory];
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve));
    }
  }
}

// ============================================================================
// 测试场景
// ============================================================================

async function runFullFlowTest() {
  console.log('\n========================================');
  console.log('  P2P Agent + Harness Full Flow Test');
  console.log('========================================\n');

  // 创建两个智能体
  const alice = new Agent('Alice', PORT_ALICE);
  const bob = new Agent('Bob', PORT_BOB);

  console.log('━━━ 步骤 1: 启动智能体 ━━━\n');
  await alice.start();
  await bob.start();

  // 等待节点发现
  console.log('\n━━━ 步骤 2: 节点发现 ━━━\n');
  await new Promise(resolve => setTimeout(resolve, 2000));
  await alice.discoverPeers();
  await bob.discoverPeers();

  console.log(`[Alice] 发现 ${alice.peers.size} 个邻居`);
  console.log(`[Bob] 发现 ${bob.peers.size} 个邻居`);

  if (alice.peers.size === 0 || bob.peers.size === 0) {
    console.log('\n⚠️ 邻居未发现，尝试手动连接...');
    const alicePort = PORT_BOB; // Alice 连接到 Bob
    const bobPort = PORT_ALICE; // Bob 连接到 Alice

    const alicePeerId = Array.from((bob as any).peers?.keys?.() || [])[0];
    const bobPeerId = Array.from((alice as any).peers?.keys?.() || [])[0];

    // 手动设置邻居关系
    (alice as any).peers.set('bob-manual', PORT_BOB);
    (bob as any).peers.set('alice-manual', PORT_ALICE);
  }

  console.log('\n━━━ 步骤 3: 开始对话 ━━━\n');

  // 对话场景 1: 需要 Harness 的架构问题
  console.log('━━━ 对话 1: 架构分析 (需要 Harness) ━━━\n');
  const msg1 = 'Bob，我需要分析一下我们项目的架构设计，看看有没有需要改进的地方？';

  console.log(`[Alice] >>> ${msg1}`);
  await alice.sendMessage(PORT_BOB, 'Bob', msg1);

  // 等待 Bob 处理
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 对话场景 2: 简单的问候 (不需要 Harness)
  console.log('\n━━━ 对话 2: 简单问候 (不需要 Harness) ━━━\n');
  const msg2 = 'Bob，最近怎么样？';

  console.log(`[Alice] >>> ${msg2}`);
  await alice.sendMessage(PORT_BOB, 'Bob', msg2);

  // 等待 Bob 处理
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 对话场景 3: 代码审查请求 (需要 Harness)
  console.log('\n━━━ 对话 3: 代码审查 (需要 Harness) ━━━\n');
  const msg3 = 'Bob，我写了一段代码，帮我 review 一下，特别是错误处理部分。';

  console.log(`[Alice] >>> ${msg3}`);
  await alice.sendMessage(PORT_BOB, 'Bob', msg3);

  // 等待 Bob 处理
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 对话场景 4: 任务分解 (需要 Harness)
  console.log('\n━━━ 对话 4: 任务分解 (需要 Harness) ━━━\n');
  const msg4 = 'Bob，我们需要完成一个功能：用户登录系统。请帮我分解一下任务。';

  console.log(`[Alice] >>> ${msg4}`);
  await alice.sendMessage(PORT_BOB, 'Bob', msg4);

  // 等待 Bob 处理
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 对话场景 5: 闲聊 (不需要 Harness)
  console.log('\n━━━ 对话 5: 闲聊 (不需要 Harness) ━━━\n');
  const msg5 = 'Bob，今天天气不错！';

  console.log(`[Alice] >>> ${msg5}`);
  await alice.sendMessage(PORT_BOB, 'Bob', msg5);

  // 等待 Bob 处理
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 汇总结果
  console.log('\n━━━ 步骤 4: 结果汇总 ━━━\n');

  const aliceHistory = alice.getMessageHistory();
  const bobHistory = bob.getMessageHistory();

  console.log(`[Alice] 收到消息: ${aliceHistory.length} 条`);
  console.log(`[Bob] 收到消息: ${bobHistory.length} 条`);

  const harnessCalls = [...aliceHistory, ...bobHistory].filter(m => m.requiresHarness);

  console.log(`\nHarness 调用次数: ${harnessCalls.length}`);
  console.log('\n调用详情:');
  for (const call of harnessCalls) {
    console.log(`  - [${call.from}] Gate: ${call.harnessResult?.gate}, Skills: ${call.harnessResult?.skills?.join(', ')}`);
  }

  console.log('\n━━━ 步骤 5: 健康检查 ━━━\n');

  try {
    const aliceHealth = await fetch(`http://localhost:${PORT_ALICE}/health`).then(r => r.json());
    const bobHealth = await fetch(`http://localhost:${PORT_BOB}/health`).then(r => r.json());

    console.log(`[Alice] ${aliceHealth.name} (${aliceHealth.id.substring(0, 8)}...)`);
    console.log(`  - 消息数: ${aliceHealth.messageCount}`);
    console.log(`  - 邻居: ${aliceHealth.peers.length}`);

    console.log(`[Bob] ${bobHealth.name} (${bobHealth.id.substring(0, 8)}...)`);
    console.log(`  - 消息数: ${bobHealth.messageCount}`);
    console.log(`  - 邻居: ${bobHealth.peers.length}`);
  } catch (err) {
    console.log('健康检查失败:', err);
  }

  // 清理
  console.log('\n━━━ 清理资源 ━━━\n');
  await alice.stop();
  await bob.stop();

  console.log('✓ 测试完成\n');
  console.log('========================================\n');

  // 判断测试是否成功
  const success = harnessCalls.length >= 3;
  if (success) {
    console.log('✅ 测试成功: 智能体成功调用 Harness 进行判断');
  } else {
    console.log('⚠️ 测试部分成功: 部分对话触发了 Harness');
  }
}

runFullFlowTest().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});