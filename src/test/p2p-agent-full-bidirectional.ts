/**
 * P2P Agent Full Bidirectional HTTP Response Test
 * 测试完整双向对话流：HTTP 请求-响应模式
 *
 * 运行: npx tsx src/test/p2p-agent-full-bidirectional.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

config();

const PORT_ALICE = 8401;
const PORT_BOB = 8402;
const REQUEST_TIMEOUT_MS = 10000;

// ============================================================================
// HTTP 响应类型定义
// ============================================================================

interface HTTPResponse {
  requestId: string;
  type: string;
  payload: string;
  from: string;
  timestamp: number;
  requiresHarness: boolean;
  harnessResult?: {
    gate: number;
    skills: string[];
    result: string;
  };
  followUpRequired: boolean;
  followUpContext?: string;
}

// ============================================================================
// Harness 模块
// ============================================================================

interface HarnessDecision {
  shouldCall: boolean;
  gate: number;
  reason: string;
  skills: string[];
  result: string;
}

interface HarnessResult {
  success: boolean;
  gate: number;
  skills: string[];
  result: string;
  message: string;
  followUpRequired: boolean;
  followUpSuggestion?: string;
}

class HarnessCore {
  private executionLog: Array<{ gate: number; timestamp: number; input: string }> = [];

  decide(content: string): HarnessDecision {
    const lower = content.toLowerCase();

    // Gate 1: 架构设计
    if (lower.includes('架构') || lower.includes('设计') || lower.includes('方案')) {
      return {
        shouldCall: true,
        gate: 1,
        reason: '检测到架构设计相关请求',
        skills: ['arch', 'lead'],
        result: '[Gate 1] 建议采用分层架构：表现层、业务层、数据层分离'
      };
    }

    // Gate 2: 代码审查
    if (lower.includes('review') || lower.includes('检查') || lower.includes('审核') || lower.includes('代码')) {
      return {
        shouldCall: true,
        gate: 2,
        reason: '检测到代码审查请求',
        skills: ['arch', 'guardian-fixer'],
        result: '[Gate 2] 建议添加输入验证和错误处理机制'
      };
    }

    // Gate 4: 安全检查
    if (lower.includes('安全') || lower.includes('权限') || lower.includes('认证')) {
      return {
        shouldCall: true,
        gate: 4,
        reason: '检测到安全相关请求',
        skills: ['arch', 'guardian-fixer'],
        result: '[Gate 4] 建议实现 JWT token 过期和刷新机制'
      };
    }

    // Gate 5: 任务分解
    if (lower.includes('任务') || lower.includes('分解') || lower.includes('计划')) {
      return {
        shouldCall: true,
        gate: 5,
        reason: '检测到任务规划请求',
        skills: ['task-arch', 'crystal-learn'],
        result: '[Gate 5] 已分解为 4 个子任务，按优先级排序'
      };
    }

    // Gate 7: 代码实现
    if (lower.includes('实现') || lower.includes('写代码') || lower.includes('开发')) {
      return {
        shouldCall: true,
        gate: 7,
        reason: '检测到代码实现请求',
        skills: ['harness-eng', 'crystal-learn'],
        result: '[Gate 7] 建议使用策略模式重构业务逻辑'
      };
    }

    // Gate 8: 测试验证
    if (lower.includes('测试') || lower.includes('验证')) {
      return {
        shouldCall: true,
        gate: 8,
        reason: '检测到测试验证请求',
        skills: ['harness-eng', 'harness-eng-test'],
        result: '[Gate 8] 建议优先测试核心业务逻辑'
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

  execute(gate: number, content: string): HarnessResult {
    const decision = this.decide(content);

    if (!decision.shouldCall) {
      return {
        success: true,
        gate: 0,
        skills: [],
        result: '',
        message: '无需 Harness 处理',
        followUpRequired: false
      };
    }

    this.executionLog.push({ gate: decision.gate, timestamp: Date.now(), input: content });

    // 根据 Gate 生成更详细的响应
    let detailedResult = '';
    let followUpRequired = false;
    let followUpSuggestion: string | undefined;

    switch (gate) {
      case 1:
        detailedResult = `${decision.result}\n\n详细建议:\n1. 使用依赖注入降低耦合\n2. 引入接口隔离原则\n3. 考虑使用策略模式处理变化点`;
        followUpRequired = true;
        followUpSuggestion = '需要我进一步分析具体的模块设计吗？';
        break;
      case 2:
        detailedResult = `${decision.result}\n\n审查要点:\n1. 检查边界条件处理\n2. 验证错误处理路径\n3. 确保资源正确释放`;
        followUpRequired = true;
        followUpSuggestion = '需要我帮你 review 具体的代码段吗？';
        break;
      case 4:
        detailedResult = `${decision.result}\n\n安全建议:\n1. 使用 HTTPS 加密传输\n2. 实现 token 过期机制\n3. 添加二次验证层`;
        followUpRequired = true;
        followUpSuggestion = '需要我生成安全检查清单吗？';
        break;
      case 5:
        detailedResult = `${decision.result}\n\n任务分解:\n1. 登录模块 (高优先级)\n2. 注册模块 (高优先级)\n3. 权限管理 (中优先级)\n4. 测试集成 (中优先级)`;
        followUpRequired = false;
        break;
      case 7:
        detailedResult = `${decision.result}\n\n实现计划:\n1. 定义接口契约\n2. 实现核心逻辑\n3. 添加单元测试`;
        followUpRequired = true;
        followUpSuggestion = '需要我帮你实现哪个部分？';
        break;
      case 8:
        detailedResult = `${decision.result}\n\n测试策略:\n1. 单元测试 (覆盖率 80%)\n2. 集成测试\n3. E2E 测试`;
        followUpRequired = true;
        followUpSuggestion = '需要我生成测试用例吗？';
        break;
      default:
        detailedResult = decision.result;
    }

    return {
      success: true,
      gate: decision.gate,
      skills: decision.skills,
      result: detailedResult,
      message: `Gate ${decision.gate} 处理完成`,
      followUpRequired,
      followUpSuggestion
    };
  }

  getExecutionLog() {
    return [...this.executionLog];
  }
}

// ============================================================================
// HTTP 会话管理器
// ============================================================================

interface PendingRequest {
  requestId: string;
  type: string;
  payload: string;
  fromPort: number;
  timestamp: number;
  timeout: ReturnType<typeof setTimeout>;
}

class HTTPSessionManager {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private responseHandlers: Map<string, (response: HTTPResponse) => void> = new Map();
  private agentPort: number;

  constructor(agentPort: number) {
    this.agentPort = agentPort;
  }

  createRequest(type: string, payload: string, fromPort: number): string {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      this.failRequest(requestId, new Error('Request timeout'));
    }, REQUEST_TIMEOUT_MS);

    this.pendingRequests.set(requestId, {
      requestId,
      type,
      payload,
      fromPort,
      timestamp: Date.now(),
      timeout
    });

    return requestId;
  }

  completeRequest(requestId: string, response: HTTPResponse): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);

      const handler = this.responseHandlers.get(requestId);
      if (handler) {
        handler(response);
        this.responseHandlers.delete(requestId);
      }
    }
  }

  failRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);

      const handler = this.responseHandlers.get(requestId);
      if (handler) {
        handler({
          requestId,
          type: 'error',
          payload: error.message,
          from: '',
          timestamp: Date.now(),
          requiresHarness: false,
          followUpRequired: false
        });
        this.responseHandlers.delete(requestId);
      }
    }
  }

  onResponse(requestId: string, handler: (response: HTTPResponse) => void): void {
    this.responseHandlers.set(requestId, handler);
  }

  getPendingRequests(): PendingRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  clear(): void {
    for (const req of this.pendingRequests.values()) {
      clearTimeout(req.timeout);
    }
    this.pendingRequests.clear();
    this.responseHandlers.clear();
  }
}

// ============================================================================
// 智能体
// ============================================================================

interface AgentMessage {
  id: string;
  requestId?: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  response?: HTTPResponse;
  processed: boolean;
}

class Agent {
  id = crypto.randomUUID();
  name: string;
  port: number;
  harness = new HarnessCore();
  sessionManager: HTTPSessionManager;
  messages: AgentMessage[] = [];
  peerPort: number | null = null;

  constructor(name: string, port: number) {
    this.name = name;
    this.port = port;
    this.sessionManager = new HTTPSessionManager(port);
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
        messageCount: this.messages.length,
        pendingRequests: this.sessionManager.getPendingRequests().length
      });
    });

    // 发现端点
    app.get('/discovery', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        capabilities: ['http-response', 'harness']
      });
    });

    // 接收请求并发送响应
    app.post('/request', async (req, res) => {
      const { requestId, fromName, type, content, context } = req.body;

      console.log(`\n📨 [${this.name}] 收到请求 from ${fromName}:`);
      console.log(`   Type: ${type}`);
      console.log(`   Content: "${content.substring(0, 50)}..."`);

      // 处理请求
      const decision = this.harness.decide(content);

      let response: HTTPResponse;
      if (decision.shouldCall) {
        console.log(`🧠 [${this.name}] 调用 Harness: Gate ${decision.gate}`);

        const harnessResult = this.harness.execute(decision.gate, content);

        response = {
          requestId: requestId || crypto.randomUUID(),
          type: 'harness-response',
          payload: harnessResult.result,
          from: this.name,
          timestamp: Date.now(),
          requiresHarness: true,
          harnessResult: {
            gate: harnessResult.gate,
            skills: harnessResult.skills,
            result: harnessResult.result
          },
          followUpRequired: harnessResult.followUpRequired,
          followUpContext: harnessResult.followUpSuggestion
        };

        console.log(`   📋 Skills: ${harnessResult.skills.join(', ')}`);
        console.log(`   📤 响应: ${harnessResult.result.substring(0, 50)}...`);
      } else {
        console.log(`🧠 [${this.name}] 普通响应 (无需 Harness)`);

        const naturalResponse = this.generateNaturalResponse(content);

        response = {
          requestId: requestId || crypto.randomUUID(),
          type: 'natural-response',
          payload: naturalResponse,
          from: this.name,
          timestamp: Date.now(),
          requiresHarness: false,
          followUpRequired: false
        };

        console.log(`   📤 响应: ${naturalResponse.substring(0, 50)}...`);
      }

      // 记录消息
      this.messages.push({
        id: crypto.randomUUID(),
        requestId,
        from: fromName,
        to: this.name,
        content,
        timestamp: Date.now(),
        response,
        processed: true
      });

      // 发送响应
      res.json(response);
    });

    // 接收响应 (处理来自其他智能体的响应)
    app.post('/response', async (req, res) => {
      const response: HTTPResponse = req.body;

      console.log(`\n📥 [${this.name}] 收到响应 from ${response.from}:`);
      console.log(`   Type: ${response.type}`);
      console.log(`   Payload: "${response.payload.substring(0, 50)}..."`);

      if (response.requiresHarness && response.harnessResult) {
        console.log(`🧠 [${this.name}] 响应包含 Harness 结果: Gate ${response.harnessResult.gate}`);
        console.log(`   Skills: ${response.harnessResult.skills.join(', ')}`);
      }

      // 完成挂起的请求
      if (response.requestId) {
        this.sessionManager.completeRequest(response.requestId, response);
      }

      res.json({ ok: true });
    });

    const server = createServer(app);
    return new Promise(resolve => {
      server.listen(this.port, () => {
        console.log(`✓ [${this.name}] 启动 on port ${this.port}`);
        resolve();
      });
    });
  }

  private generateNaturalResponse(content: string): string {
    const lower = content.toLowerCase();

    if (lower.includes('你好') || lower.includes('hi') || lower.includes('hello')) {
      return `你好！我是 ${this.name}，有什么可以帮你的吗？`;
    }

    if (lower.includes('谢谢') || lower.includes('感谢')) {
      return `不客气！还有其他需要帮助的吗？`;
    }

    if (lower.includes('？') || lower.includes('?')) {
      return `这是个有趣的问题。让我想想...`;
    }

    const responses = [
      '明白了！',
      '好的，我理解。',
      '收到，让我处理一下。',
      '没问题！',
      '好的，继续。'
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }

  setPeer(port: number): void {
    this.peerPort = port;
  }

  async sendRequest(targetPort: number, type: string, content: string, relatedRequestId?: string): Promise<HTTPResponse | null> {
    const requestId = crypto.randomUUID();

    console.log(`\n📤 [${this.name}] 发送请求 to port ${targetPort}:`);
    console.log(`   RequestId: ${requestId}`);
    console.log(`   Type: ${type}`);
    console.log(`   Content: "${content.substring(0, 50)}..."`);

    try {
      const res = await fetch(`http://localhost:${targetPort}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          fromName: this.name,
          type,
          content,
          context: relatedRequestId
        })
      });

      const response: HTTPResponse = await res.json();

      console.log(`\n✅ [${this.name}] 收到响应`);

      // 记录消息
      this.messages.push({
        id: crypto.randomUUID(),
        requestId,
        from: this.name,
        to: `port:${targetPort}`,
        content,
        timestamp: Date.now(),
        response,
        processed: true
      });

      return response;
    } catch (err) {
      console.error(`❌ [${this.name}] 请求失败:`, err);
      return null;
    }
  }

  getMessages(): AgentMessage[] {
    return [...this.messages];
  }

  async stop(): Promise<void> {
    this.sessionManager.clear();
  }
}

// ============================================================================
// 测试场景
// ============================================================================

async function runFullBidirectionalTest() {
  console.log('\n========================================');
  console.log('  P2P Agent Full Bidirectional HTTP Test');
  console.log('  场景: 完整双向对话流 + Harness 调用');
  console.log('========================================\n');

  const alice = new Agent('Alice', PORT_ALICE);
  const bob = new Agent('Bob', PORT_BOB);

  // 设置邻居关系
  alice.setPeer(PORT_BOB);
  bob.setPeer(PORT_ALICE);

  console.log('━━━ 启动智能体 ━━━\n');
  await alice.start();
  await bob.start();

  console.log('\n━━━ 对话 1: 架构分析 (需要 Harness + 跟进) ━━━\n');

  const response1 = await alice.sendRequest(PORT_BOB, 'analysis', 'Bob，我们需要设计一个用户认证系统，请帮我分析一下架构。');

  if (response1) {
    console.log(`\n✅ [Alice] 收到 Bob 的响应:`);
    console.log(`   类型: ${response1.type}`);
    console.log(`   需要 Harness: ${response1.requiresHarness}`);
    if (response1.harnessResult) {
      console.log(`   Gate: ${response1.harnessResult.gate}`);
      console.log(`   Skills: ${response1.harnessResult.skills.join(', ')}`);
    }
  }

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n━━━ 对话 2: 代码审查 (需要 Harness + 跟进) ━━━\n');

  const response2 = await bob.sendRequest(PORT_ALICE, 'review', 'Alice，帮我 review 一下登录模块的代码实现。');

  if (response2) {
    console.log(`\n✅ [Bob] 收到 Alice 的响应:`);
    console.log(`   类型: ${response2.type}`);
    console.log(`   需要 Harness: ${response2.requiresHarness}`);
    if (response2.harnessResult) {
      console.log(`   Gate: ${response2.harnessResult.gate}`);
      console.log(`   Skills: ${response2.harnessResult.skills.join(', ')}`);
    }
  }

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n━━━ 对话 3: 简单问候 (无需 Harness) ━━━\n');

  const response3 = await alice.sendRequest(PORT_BOB, 'greeting', 'Bob，你好吗？最近项目进展如何？');

  if (response3) {
    console.log(`\n✅ [Alice] 收到 Bob 的响应:`);
    console.log(`   类型: ${response3.type}`);
    console.log(`   需要 Harness: ${response3.requiresHarness}`);
    console.log(`   内容: ${response3.payload}`);
  }

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n━━━ 对话 4: 任务分解 (需要 Harness) ━━━\n');

  const response4 = await bob.sendRequest(PORT_ALICE, 'planning', 'Alice，我们需要完成用户管理功能，请帮我分解一下任务。');

  if (response4) {
    console.log(`\n✅ [Bob] 收到 Alice 的响应:`);
    console.log(`   类型: ${response4.type}`);
    console.log(`   需要 Harness: ${response4.requiresHarness}`);
    if (response4.harnessResult) {
      console.log(`   Gate: ${response4.harnessResult.gate}`);
      console.log(`   内容: ${response4.harnessResult.result.substring(0, 80)}...`);
    }
  }

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n━━━ 结果汇总 ━━━\n');

  const aliceMessages = alice.getMessages();
  const bobMessages = bob.getMessages();

  console.log(`[Alice] 消息数: ${aliceMessages.length}`);
  console.log(`[Bob] 消息数: ${bobMessages.length}`);

  // 统计 Harness 调用
  const harnessCalls = [...aliceMessages, ...bobMessages].filter(m =>
    m.response?.requiresHarness
  );

  console.log(`\nHarness 调用次数: ${harnessCalls.length}`);

  console.log('\nHarness 调用详情:');
  harnessCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. [${call.from}] -> [${call.to}]`);
    if (call.response?.harnessResult) {
      console.log(`     Gate: ${call.response.harnessResult.gate}`);
      console.log(`     Skills: ${call.response.harnessResult.skills.join(', ')}`);
    }
  });

  // 展示完整对话流
  console.log('\n━━━ 完整对话流 ━━━\n');

  const allMessages = [...aliceMessages, ...bobMessages]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 20);

  for (const msg of allMessages) {
    const harnessIcon = msg.response?.requiresHarness ? '🧠' : '  ';
    const gateInfo = msg.response?.harnessResult ? ` [Gate ${msg.response.harnessResult.gate}]` : '';
    console.log(`${harnessIcon} [${msg.from}]${gateInfo}: ${msg.content.substring(0, 40)}...`);
  }

  // 健康检查
  console.log('\n━━━ 最终状态 ━━━\n');
  const aliceHealth = await fetch(`http://localhost:${PORT_ALICE}/health`).then(r => r.json());
  const bobHealth = await fetch(`http://localhost:${PORT_BOB}/health`).then(r => r.json());

  console.log(`[Alice] ID: ${aliceHealth.id.substring(0, 16)}...`);
  console.log(`[Bob]   ID: ${bobHealth.id.substring(0, 16)}...`);
  console.log(`\n总消息数: ${aliceMessages.length + bobMessages.length}`);
  console.log(`Harness 调用: ${harnessCalls.length} 次`);

  // 判断测试成功
  const success = harnessCalls.length >= 3;
  console.log(`\n${success ? '✅' : '⚠️'} ${success ? '测试成功' : '测试部分成功'}`);

  console.log('\n========================================\n');

  // 清理
  await alice.stop();
  await bob.stop();
}

runFullBidirectionalTest().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});