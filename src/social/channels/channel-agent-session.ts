/**
 * Channel Agent Session - 整合 Channel、Judgment Engine 和 Persona 的智能会话
 *
 * 提供完整的 Channel 智能体功能：
 * 1. P2P 多轮对话
 * 2. Harness 判断力决策
 * 3. 动态 Persona 设计
 */

import crypto from 'crypto';
import express from 'express';
import { createServer, type Server } from 'http';
import { ChannelJudgmentEngine, createChannelJudgmentEngine, type JudgmentContext, type JudgmentResult } from '../../bollharness-integration/channel-judgment-engine.js';
import { PersonaDesignEngine, createPersonaDesignEngine, type PersonaDesignRequest } from '../persona/enhanced-persona.js';
import type { PersonaDoc } from '../heartbeat.js';

export interface ChannelAgentConfig {
  name: string;
  port: number;
  domain?: string;
  capabilities?: string[];
  persona?: PersonaDoc;
}

export interface DialogEntry {
  id: string;
  speaker: string;
  message: string;
  timestamp: number;
  harnessCalled: boolean;
  gate?: number;
  skills?: string[];
}

export interface ChannelAgentSession {
  id: string;
  name: string;
  port: number;
  domain: string;
  capabilities: string[];

  getDid(): string;
  getPersona(): PersonaDoc | null;
  getDialogHistory(): DialogEntry[];
  getLastGate(): number;

  receiveMessage(fromName: string, content: string): Promise<{
    response: string;
    harnessCalled: boolean;
    gate?: number;
    skills?: string[];
  }>;

  sendToAgent(targetDid: string, content: string): Promise<boolean>;
  broadcastMessage(content: string): Promise<number>;

  designPersona(request: PersonaDesignRequest): PersonaDoc;
  updatePersona(updates: Partial<PersonaDoc>): void;

  shutdown(): void;
}

export class ChannelAgent implements ChannelAgentSession {
  readonly id: string;
  name: string;
  port: number;
  domain: string;
  capabilities: string[];

  private server: Server | null = null;
  private judgmentEngine: ChannelJudgmentEngine;
  private personaEngine: PersonaDesignEngine;
  private dialogHistory: DialogEntry[] = [];
  private responseIndex: number = 0;
  private ownDid: string;

  // Gate responses by gate number
  private readonly gateResponses: Record<number, string[]> = {
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

  constructor(config: ChannelAgentConfig) {
    this.id = crypto.randomUUID();
    this.name = config.name;
    this.port = config.port;
    this.domain = config.domain || '通用';
    this.capabilities = config.capabilities || ['对话', '分析'];
    this.ownDid = `did:local:${this.id.substring(0, 8)}`;

    // Initialize judgment engine
    this.judgmentEngine = createChannelJudgmentEngine();

    // Initialize persona engine
    this.personaEngine = createPersonaDesignEngine(config.persona);
  }

  /**
   * Start the agent server
   */
  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    // Health check
    app.get('/health', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        domain: this.domain,
        capabilities: this.capabilities,
        dialogCount: this.dialogHistory.length,
        lastGate: this.getLastGate(),
        persona: this.personaEngine.getPersona()
      });
    });

    // Discovery endpoint
    app.get('/discovery', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        did: this.ownDid,
        port: this.port,
        domain: this.domain,
        capabilities: this.capabilities
      });
    });

    // Dialog history
    app.get('/history', (req, res) => {
      res.json(this.dialogHistory);
    });

    // Persona info
    app.get('/persona', (req, res) => {
      res.json(this.personaEngine.getPersona());
    });

    // Receive message
    app.post('/receive', async (req, res) => {
      const { fromName, content } = req.body;
      const result = await this.receiveMessage(fromName, content);
      res.json(result);
    });

    // Send to agent (HTTP fallback for testing)
    app.post('/send', async (req, res) => {
      const { targetDid, targetPort, content } = req.body;
      try {
        const resp = await fetch(`http://localhost:${targetPort}/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromName: this.name, content })
        });
        const result = await resp.json();
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    });

    // Design persona
    app.post('/design-persona', (req, res) => {
      try {
        const request: PersonaDesignRequest = req.body;
        const persona = this.designPersona(request);
        res.json({ ok: true, persona });
      } catch (err) {
        res.status(400).json({ ok: false, error: String(err) });
      }
    });

    return new Promise((resolve, reject) => {
      this.server = createServer(app);
      this.server.listen(this.port, () => {
        console.log(`✓ [${this.name}] Channel Agent listening on port ${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  /**
   * Receive and process a message
   */
  async receiveMessage(fromName: string, content: string): Promise<{
    response: string;
    harnessCalled: boolean;
    gate?: number;
    skills?: string[];
  }> {
    console.log(`\n📨 [${this.name}] 收到 [${fromName}]: "${content.substring(0, 50)}..."`);

    // Build judgment context
    const context: JudgmentContext = {
      conversationHistory: this.dialogHistory.slice(-10).map(d => d.message),
      currentMessage: content,
      senderName: fromName
    };

    // Decide whether to call Harness
    const decision = this.judgmentEngine.decide(context);

    let response: string;

    if (decision.shouldCall) {
      console.log(`🧠 [${this.name}] 调用 Harness: Gate ${decision.gate}`);
      console.log(`   Skills: ${decision.skills.join(', ')}`);
      console.log(`   ${decision.result}`);

      response = this.generateHarnessResponse(decision, fromName);

      // Record with Harness call
      this.dialogHistory.push({
        id: crypto.randomUUID(),
        speaker: fromName,
        message: content,
        timestamp: Date.now(),
        harnessCalled: true,
        gate: decision.gate,
        skills: decision.skills
      });

      this.dialogHistory.push({
        id: crypto.randomUUID(),
        speaker: this.name,
        message: response,
        timestamp: Date.now(),
        harnessCalled: true,
        gate: decision.gate,
        skills: decision.skills
      });
    } else {
      console.log(`🧠 [${this.name}] 普通回复 (无需 Harness)`);
      response = this.generateNaturalResponse();

      // Record without Harness
      this.dialogHistory.push({
        id: crypto.randomUUID(),
        speaker: fromName,
        message: content,
        timestamp: Date.now(),
        harnessCalled: false
      });

      this.dialogHistory.push({
        id: crypto.randomUUID(),
        speaker: this.name,
        message: response,
        timestamp: Date.now(),
        harnessCalled: false
      });
    }

    console.log(`📤 [${this.name}] 回复: "${response.substring(0, 50)}..."`);

    return {
      response,
      harnessCalled: decision.shouldCall,
      gate: decision.shouldCall ? decision.gate : undefined,
      skills: decision.shouldCall ? decision.skills : undefined
    };
  }

  /**
   * Generate response for Harness call
   */
  private generateHarnessResponse(decision: JudgmentResult, fromName: string): string {
    const gateResponses = this.gateResponses[decision.gate] || [decision.result];
    return gateResponses[this.responseIndex++ % gateResponses.length];
  }

  /**
   * Generate natural response for non-Harness messages
   */
  private generateNaturalResponse(): string {
    const responses = this.judgmentEngine.generateNaturalResponse();
    return responses[this.responseIndex++ % responses.length];
  }

  // ==================== Interface Implementation ====================

  getDid(): string {
    return this.ownDid;
  }

  getPersona(): PersonaDoc | null {
    return this.personaEngine.getPersona();
  }

  getDialogHistory(): DialogEntry[] {
    return [...this.dialogHistory];
  }

  getLastGate(): number {
    return this.judgmentEngine.getLastGate();
  }

  async sendToAgent(targetDid: string, content: string): Promise<boolean> {
    // For now, this is a placeholder for P2P integration
    // In production, this would use DiapChannelBridge
    console.log(`[${this.name}] Would send to ${targetDid}: ${content}`);
    return false;
  }

  async broadcastMessage(content: string): Promise<number> {
    console.log(`[${this.name}] Broadcasting: ${content}`);
    return 0;
  }

  designPersona(request: PersonaDesignRequest): PersonaDoc {
    return this.personaEngine.designPersona(request);
  }

  updatePersona(updates: Partial<PersonaDoc>): void {
    this.personaEngine.updatePersona(updates);
  }

  shutdown(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.dialogHistory = [];
    this.judgmentEngine.reset();
    console.log(`[${this.name}] Channel Agent shutdown`);
  }
}

// Factory function
export function createChannelAgent(config: ChannelAgentConfig): ChannelAgent {
  return new ChannelAgent(config);
}

// Channel Agent Registry for managing multiple agents
export class ChannelAgentRegistry {
  private agents: Map<string, ChannelAgent> = new Map();

  register(agent: ChannelAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.shutdown();
      this.agents.delete(agentId);
    }
  }

  get(agentId: string): ChannelAgent | undefined {
    return this.agents.get(agentId);
  }

  getByName(name: string): ChannelAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.name === name) {
        return agent;
      }
    }
    return undefined;
  }

  getByDid(did: string): ChannelAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.getDid() === did) {
        return agent;
      }
    }
    return undefined;
  }

  list(): ChannelAgent[] {
    return Array.from(this.agents.values());
  }

  clear(): void {
    for (const agent of this.agents.values()) {
      agent.shutdown();
    }
    this.agents.clear();
  }
}