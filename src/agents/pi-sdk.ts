/**
 * Pi-SDK - Agent Session for Document Processing
 * Part of OpenClaw dual-layer architecture
 */

import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../llm/minimax.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer, WorkflowContext } from './constraint-layer.js';
import { WorkflowEngine, WorkflowStep, StepResult, Workflow } from './workflow-engine.js';

export interface AgentSessionConfig {
  cwd: string;
  peerId?: string;
  identityDoc?: IdentityDoc;
}

export interface IdentityDoc {
  did: string;
  name: string;
  publicKey: string;
  createdAt: number;
}

export interface ImprovementRequest {
  originalPath: string;
  requirements: string;
  context?: string;
}

// Re-export types from constraint-layer and workflow-engine for convenience
export type { WorkflowStep, StepResult, Workflow } from './workflow-engine.js';

export interface AgentSession {
  prompt(input: string): Promise<string>;
  readDocument(filePath: string): Promise<string>;
  summarizeDocument(filePath: string, context?: string): Promise<{
    summary: string;
    qualityScore: number;
  }>;
  improveDocument(request: ImprovementRequest): Promise<{
    improved: boolean;
    newContent?: string;
    qualityScore: number;
    shouldAutoSend: boolean;
  }>;
  runWorkflow(workflow: WorkflowStep[]): Promise<Workflow>;
  getPeers(): string[];
  sendMessage(peerId: string, message: string): Promise<void>;
  broadcast(message: string): Promise<void>;
  getIdentity(): IdentityDoc;
  updateIdentity(updates: Partial<IdentityDoc>): void;
}

class PiAgentSession implements AgentSession {
  private cwd: string;
  private peerId: string;
  private identity: IdentityDoc;
  private minimaxAvailable = false;
  private workflows: Map<string, Workflow> = new Map();
  private constraintLayer: ConstraintLayer;
  private workflowEngine: WorkflowEngine;

  constructor(config: AgentSessionConfig) {
    this.cwd = config.cwd;
    this.peerId = config.peerId || 'local';
    this.identity = config.identityDoc || this.createDefaultIdentity();
    this.minimaxAvailable = this.checkMinimax();
    this.constraintLayer = new ConstraintLayer();
    this.workflowEngine = new WorkflowEngine(this.constraintLayer);
  }

  private createDefaultIdentity(): IdentityDoc {
    return {
      did: `did:pi:${this.peerId.substring(0, 16)}`,
      name: `Agent-${this.peerId.substring(0, 8)}`,
      publicKey: this.peerId,
      createdAt: Date.now()
    };
  }

  private checkMinimax(): boolean {
    try {
      getMinimax();
      return true;
    } catch {
      return false;
    }
  }

  async prompt(input: string): Promise<string> {
    this.minimaxAvailable = this.checkMinimax();
    const lowerInput = input.toLowerCase();
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    if (cmd.includes('读取') || cmd === 'read') {
      if (args) {
        const result = await this.summarizeDocument(args);
        return `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
      }
    }

    if (cmd.includes('改进') || cmd === 'improve') {
      const match = input.match(/改进[^\w]+(.+)/i) || input.match(/improve\s+(.+)/i);
      if (match) {
        const result = await this.improveDocument({
          originalPath: match[1],
          requirements: '根据人类要求改进文档'
        });
        return `改进结果: ${result.improved ? '成功' : '失败'}\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
      }
    }

    if (cmd.includes('总结') || cmd === 'summary') {
      if (args) {
        return await this.summarizeText(args);
      }
    }

    if (cmd.includes('节点') || cmd === 'peers') {
      return this.listPeers();
    }

    if (this.minimaxAvailable) {
      return this.handleAIRequest(input);
    }

    return this.getDefaultResponse(input);
  }

  private async handleAIRequest(input: string): Promise<string> {
    const llm = getMinimax();
    const result = await llm.chat(input, `Current working directory: ${this.cwd}`);
    return result.reply;
  }

  private async summarizeText(text: string): Promise<string> {
    if (!this.minimaxAvailable) {
      return '⚠️ LLM未初始化，请设置 MINIMAX_API_KEY 环境变量';
    }
    const llm = getMinimax();
    const result = await llm.summarize(text);
    return `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
  }

  async readDocument(filePath: string): Promise<string> {
    const content = await documentReader.read(filePath);
    return `📄 ${content.metadata.filename}\n大小: ${content.metadata.size} 字节\n\n${content.text.substring(0, 500)}...`;
  }

  async summarizeDocument(filePath: string, context?: string): Promise<{
    summary: string;
    qualityScore: number;
  }> {
    if (!this.minimaxAvailable) {
      return {
        summary: '⚠️ LLM未初始化，请设置 MINIMAX_API_KEY 环境变量',
        qualityScore: 0
      };
    }

    const content = await documentReader.read(filePath);
    const llm = getMinimax();
    const chunks = documentReader.chunk(content.text);
    const summaries: string[] = [];
    let totalQuality = 0;

    for (const chunk of chunks) {
      const result = await llm.summarize(chunk, context);
      summaries.push(result.summary);
      totalQuality += result.qualityScore;
    }

    const avgQuality = totalQuality / chunks.length;
    return {
      summary: summaries.join('\n\n'),
      qualityScore: avgQuality
    };
  }

  async improveDocument(request: ImprovementRequest): Promise<{
    improved: boolean;
    newContent?: string;
    qualityScore: number;
    shouldAutoSend: boolean;
  }> {
    if (!this.minimaxAvailable) {
      return {
        improved: false,
        qualityScore: 0,
        shouldAutoSend: false
      };
    }

    const content = await documentReader.read(request.originalPath);
    const llm = getMinimax();
    const improvedResult = await llm.summarize(content.text + '\n\n改进要求: ' + request.requirements, request.context);
    const shouldAutoSend = await llm.shouldAutoSend(improvedResult.qualityScore, 0.7);

    return {
      improved: true,
      newContent: improvedResult.summary,
      qualityScore: improvedResult.qualityScore,
      shouldAutoSend
    };
  }

  async runWorkflow(steps: WorkflowStep[]): Promise<Workflow> {
    const context: WorkflowContext = {
      peers: this.getPeers(),
      logs: []
    };

    // Pre-check with constraint layer
    const checkResult = await this.constraintLayer.checkGuardrails(context);
    if (!checkResult.passed && checkResult.blocked) {
      console.warn(`Guardrail blocked: ${checkResult.blocked.name}`);
    }

    // Use workflow engine for execution
    return this.workflowEngine.executeWorkflow(steps, context);
  }

  /**
   * Convenience method for summarizing a document and optionally sending to peer
   */
  async summarizeDocumentWorkflow(filePath: string, targetPeer?: string): Promise<Workflow> {
    const steps: WorkflowStep[] = [
      {
        id: 'read',
        type: 'read',
        config: { path: filePath },
        retry: { max: 3, current: 0, backoffMs: 1000 },
        onFail: 'abort'
      },
      {
        id: 'summarize',
        type: 'summarize',
        config: { context: `File: ${filePath}` },
        retry: { max: 3, current: 0, backoffMs: 1000 },
        onFail: 'skip',
        guardrail: (ctx) => Promise.resolve(ctx.qualityScore !== undefined && ctx.qualityScore >= 0.5)
      }
    ];

    if (targetPeer) {
      steps.push({
        id: 'send',
        type: 'send',
        config: { peerId: targetPeer },
        retry: { max: 2, current: 0, backoffMs: 2000 },
        onFail: 'skip'
      });
    }

    return this.runWorkflow(steps);
  }

  /**
   * Convenience method for improving a document and sending to peer
   */
  async improveAndSendWorkflow(filePath: string, requirements: string, targetPeer: string): Promise<Workflow> {
    const steps: WorkflowStep[] = [
      {
        id: 'read',
        type: 'read',
        config: { path: filePath },
        retry: { max: 3, current: 0, backoffMs: 1000 },
        onFail: 'abort'
      },
      {
        id: 'improve',
        type: 'improve',
        config: { requirements, context: `File: ${filePath}` },
        retry: { max: 2, current: 0, backoffMs: 1500 },
        onFail: 'skip'
      },
      {
        id: 'send',
        type: 'send',
        config: { peerId: targetPeer, message: '改进后的文档' },
        retry: { max: 2, current: 0, backoffMs: 2000 },
        onFail: 'skip'
      }
    ];

    return this.runWorkflow(steps);
  }

  /**
   * Get operation logs from constraint layer
   */
  getOperationLogs(): { timestamp: number; action: string; details: Record<string, unknown>; status: string }[] {
    return this.constraintLayer.getLogs();
  }

  private listPeers(): string {
    const peers = p2pNetwork.getPeers();
    if (peers.length === 0) {
      return '当前无连接的对等节点';
    }
    return `已连接节点 (${peers.length}):\n${peers.map(p => `  - ${p}`).join('\n')}`;
  }

  getPeers(): string[] {
    return p2pNetwork.getPeers();
  }

  async sendMessage(peerId: string, message: string): Promise<void> {
    await p2pNetwork.sendMessage(peerId, 'message', message);
  }

  async broadcast(message: string): Promise<void> {
    await p2pNetwork.broadcast('message', message);
  }

  getIdentity(): IdentityDoc {
    return { ...this.identity };
  }

  updateIdentity(updates: Partial<IdentityDoc>): void {
    this.identity = { ...this.identity, ...updates };
  }

  private getDefaultResponse(input: string): string {
    return `收到了: "${input}"

可用命令:
  - 读取 <文件> - 读取并总结文档
  - 总结 <文本> - 总结指定文本
  - 改进 <文件> - 根据要求改进文档
  - 工作流 <步骤> - 执行工作流
  - 节点 - 查看已连接的对等节点
  - 帮助 - 显示所有可用命令`;
  }
}

let sessionInstance: AgentSession | null = null;

export async function createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
  if (sessionInstance) {
    return sessionInstance;
  }

  sessionInstance = new PiAgentSession(config);
  return sessionInstance;
}

export function getAgentSession(): AgentSession | null {
  return sessionInstance;
}