import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../llm/minimax.js';
import { p2pNetwork } from '../network/p2p.js';

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

export interface WorkflowStepConfig {
  path?: string;
  requirements?: string;
  context?: string;
  peerId?: string;
  message?: string;
  content?: string;
  maxChunkSize?: number;
}

export interface WorkflowStep {
  id: string;
  type: 'read' | 'chunk' | 'summarize' | 'improve' | 'review' | 'send' | 'report';
  config?: WorkflowStepConfig;
  retry: {
    max: number;
    current: number;
    backoffMs: number;
  };
  onFail: 'skip' | 'abort' | 'retry';
  guardrail?: (context: WorkflowContext) => Promise<boolean>;
  guardrailOnRetry?: boolean;
}

export interface WorkflowContext {
  document?: {
    text: string;
    metadata: {
      filename: string;
      size: number;
      type: string;
    };
  };
  summary?: string;
  improved?: string;
  qualityScore?: number;
  peers: string[];
  logs: { timestamp: number; action: string; details: Record<string, unknown>; status: string }[];
  metadata?: Record<string, unknown>;
}

export interface StepResult {
  status: 'success' | 'failed' | 'skipped' | 'blocked';
  result?: unknown;
  error?: string;
  guardrailFailed?: string;
}

export interface Workflow {
  id: string;
  steps: WorkflowStep[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  results: Map<string, StepResult>;
}

export interface ImprovementRequest {
  originalPath: string;
  requirements: string;
  context?: string;
}

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

  constructor(config: AgentSessionConfig) {
    this.cwd = config.cwd;
    this.peerId = config.peerId || 'local';
    this.identity = config.identityDoc || this.createDefaultIdentity();
    this.minimaxAvailable = this.checkMinimax();
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

    if (lowerInput.includes('读取') || lowerInput.includes('read')) {
      const fileMatch = input.match(/(?:读取|read)[^\w]+([^\s]+)/);
      if (fileMatch) {
        const result = await this.summarizeDocument(fileMatch[1]);
        return `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
      }
    }

    if (lowerInput.includes('改进') || lowerInput.includes('improve')) {
      const reqMatch = input.match(/(?:改进|improve)[^\w]+(.+)/);
      if (reqMatch) {
        const result = await this.improveDocument({
          originalPath: reqMatch[1],
          requirements: '根据人类要求改进文档'
        });
        return `改进结果: ${result.improved ? '成功' : '失败'}\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
      }
    }

    if (lowerInput.includes('总结') || lowerInput.includes('summary')) {
      const textMatch = input.match(/(?:总结|summary)[^\w]+(.+)/);
      if (textMatch) {
        return await this.summarizeText(textMatch[1]);
      }
    }

    if (lowerInput.includes('节点') || lowerInput.includes('peers')) {
      return this.listPeers();
    }

    if (this.minimaxAvailable) {
      return this.handleAIRequest(input);
    }

    return this.getDefaultResponse(input);
  }

  private async handleAIRequest(input: string): Promise<string> {
    const llm = getMinimax();
    const result = await llm.summarize(input, `Current working directory: ${this.cwd}`);
    return `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
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
    const workflow: Workflow = {
      id: `wf-${Date.now()}`,
      steps,
      status: 'running',
      results: new Map()
    };

    this.workflows.set(workflow.id, workflow);

    for (const step of steps) {
      try {
        const result = await this.executeWorkflowStep(step);
        workflow.results.set(step.id, result);
      } catch (error) {
        workflow.status = 'failed';
        return workflow;
      }
    }

    workflow.status = 'completed';
    return workflow;
  }

  private async executeWorkflowStep(step: WorkflowStep): Promise<unknown> {
    switch (step.type) {
      case 'read':
        return documentReader.read(step.config?.path as string);
      case 'summarize':
        return { summary: 'Workflow step executed', qualityScore: 0.5 };
      case 'improve':
        const improveReq: ImprovementRequest = {
          originalPath: step.config?.path as string,
          requirements: step.config?.requirements as string,
          context: step.config?.context as string
        };
        return this.improveDocument(improveReq);
      case 'send':
        const peerId = step.config?.peerId as string;
        const message = step.config?.message as string;
        await this.sendMessage(peerId, message);
        return { sent: true, peerId };
      case 'report':
        const reportContent = step.config?.content as string;
        await this.broadcast(reportContent);
        return { broadcasted: true };
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
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
