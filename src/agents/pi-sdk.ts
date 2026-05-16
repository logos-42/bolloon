/**
 * Pi-SDK - Agent Session for Document Processing
 * Part of OpenClaw dual-layer architecture
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../runtime/context/sys-prompt.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer, WorkflowContext } from './constraint-layer.js';
import { WorkflowEngine, WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
import {
  DiscoveredAgentsManager,
  SocialHeartbeat,
  createSocialHeartbeat,
  getSocialHeartbeat,
  type PersonaDoc,
  type DiscoveredAgent,
  type SessionChannel,
  type SessionMessage
} from '../social/heartbeat.js';

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

export type { WorkflowStep, StepResult, Workflow } from './workflow-engine.js';

export interface PiSessionState {
  id: string;
  agentId: string;
  cwd: string;
  startedAt: string;
  lastActive: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface PiMemory {
  workingMemory: string[];
  summarizedMemory: string[];
  fileContext: Map<string, string>;
}

const SHARED_SESSION_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');
const PERSONA_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');

export class PiSessionManager {
  private state: PiSessionState;
  private memory: PiMemory;
  private persona: PersonaDoc | null = null;
  private channels: Map<string, SessionChannel> = new Map();
  private channelsPath: string;
  private initialized: boolean = false;

  constructor(agentId: string, cwd: string) {
    this.state = {
      id: `pi-session-${Date.now()}`,
      agentId,
      cwd,
      startedAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    };
    this.memory = {
      workingMemory: [],
      summarizedMemory: [],
      fileContext: new Map()
    };
    this.channelsPath = path.join(SHARED_SESSION_PATH, 'pi-channels.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(SHARED_SESSION_PATH, { recursive: true });
    this.persona = await this.loadPersona();
    await this.loadChannels();
    this.initialized = true;
  }

  private async loadPersona(): Promise<PersonaDoc | null> {
    try {
      const data = await fs.readFile(PERSONA_PATH, 'utf-8');
      return JSON.parse(data) as PersonaDoc;
    } catch {
      return null;
    }
  }

  private async loadChannels(): Promise<void> {
    try {
      const data = await fs.readFile(this.channelsPath, 'utf-8');
      const channelsArray: SessionChannel[] = JSON.parse(data);
      this.channels.clear();
      for (const channel of channelsArray) {
        this.channels.set(channel.id, channel);
      }
    } catch {
      this.channels.clear();
    }
  }

  private async saveChannels(): Promise<void> {
    const channelsArray = Array.from(this.channels.values());
    await fs.writeFile(this.channelsPath, JSON.stringify(channelsArray, null, 2));
  }

  async savePersona(persona: PersonaDoc): Promise<void> {
    await fs.writeFile(PERSONA_PATH, JSON.stringify(persona, null, 2));
    this.persona = persona;
  }

  getPersona(): PersonaDoc | null {
    return this.persona;
  }

  getState(): PiSessionState {
    return { ...this.state, lastActive: new Date().toISOString() };
  }

  getMemory(): PiMemory {
    return this.memory;
  }

  addToWorkingMemory(content: string): void {
    this.memory.workingMemory.push(content);
    if (this.memory.workingMemory.length > 100) {
      this.memory.workingMemory = this.memory.workingMemory.slice(-100);
    }
    this.state.lastActive = new Date().toISOString();
  }

  addSummarizedMemory(content: string): void {
    this.memory.summarizedMemory.push(content);
    if (this.memory.summarizedMemory.length > 50) {
      this.memory.summarizedMemory = this.memory.summarizedMemory.slice(-50);
    }
  }

  addFileContext(filePath: string, content: string): void {
    this.memory.fileContext.set(filePath, content);
    if (this.memory.fileContext.size > 20) {
      const entries = Array.from(this.memory.fileContext.entries());
      this.memory.fileContext = new Map(entries.slice(-20));
    }
  }

  updateTokenUsage(promptTokens: number, completionTokens: number): void {
    this.state.tokenUsage = {
      promptTokens: (this.state.tokenUsage?.promptTokens || 0) + promptTokens,
      completionTokens: (this.state.tokenUsage?.completionTokens || 0) + completionTokens,
      totalTokens: (this.state.tokenUsage?.totalTokens || 0) + promptTokens + completionTokens
    };
  }

  async addMessage(channelId: string, message: SessionMessage): Promise<void> {
    await this.initialize();

    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, {
        id: channelId,
        name: channelId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    const channel = this.channels.get(channelId)!;
    channel.messages.push(message);
    channel.updatedAt = new Date().toISOString();
    await this.saveChannels();
  }

  async getChannelMessages(channelId: string): Promise<SessionMessage[]> {
    await this.initialize();
    return this.channels.get(channelId)?.messages || [];
  }

  async createChannel(name: string, peerInfo?: { peerId?: string; peerDid?: string; peerName?: string }): Promise<SessionChannel> {
    await this.initialize();

    const channelId = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const channel: SessionChannel = {
      id: channelId,
      name,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...peerInfo
    };

    this.channels.set(channelId, channel);
    await this.saveChannels();
    return channel;
  }

  async getOrCreatePeerChannel(peerDid: string, peerName: string): Promise<SessionChannel> {
    await this.initialize();

    for (const channel of this.channels.values()) {
      if (channel.peerDid === peerDid) {
        return channel;
      }
    }

    return this.createChannel(`与 ${peerName} 的对话`, {
      peerDid,
      peerName
    });
  }

  async setChannelInfo(channelId: string, info: Partial<SessionChannel>): Promise<void> {
    await this.initialize();
    const channel = this.channels.get(channelId);
    if (channel) {
      Object.assign(channel, info, { updatedAt: new Date().toISOString() });
      await this.saveChannels();
    }
  }

  getAllChannels(): SessionChannel[] {
    return Array.from(this.channels.values());
  }
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, string>;
  execute: (args: Record<string, string>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCall?: {
    name: string;
    args: Record<string, string>;
  };
  toolResult?: ToolResult;
}

export interface StreamCallback {
  (event: StreamEvent): void;
}

export interface StreamEvent {
  type: 'status' | 'thinking' | 'tool' | 'token' | 'done' | 'error';
  content: string;
  tool?: string;
  data?: unknown;
}

const TOOL_DEFINITIONS = `
可用工具:
1. read_document(path) - 读取文档内容，支持 .txt, .md, .pdf, .docx
2. summarize_document(path, context?) - 总结文档内容，可选提供上下文
3. improve_document(path, requirements) - 改进文档，需提供文件路径和改进要求
4. list_peers() - 列出已连接的对等节点
5. send_message(peer_id, message) - 向指定对等节点发送消息
6. broadcast_message(message) - 向所有对等节点广播消息
7. get_identity() - 获取当前智能体身份信息
8. run_workflow(steps) - 执行预定义工作流
9. get_operation_logs() - 获取操作日志
`;

export interface HeartbeatConfig {
  intervalMs: number;
  peerDiscoveryEnabled: boolean;
  ipnsResolveEnabled: boolean;
  autoSocialEnabled: boolean;
  greetingMessage?: string;
}

export interface AgentSession {
  prompt(input: string): Promise<string>;
  promptStream(input: string, onStream: StreamCallback): Promise<string>;
  suggestRename(messages: { type: string; content: string }[]): Promise<string | null>;
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
  getSessionState(): PiSessionState;
  getMemory(): PiMemory;
  getPersona(): PersonaDoc | null;
  setPersona(persona: PersonaDoc): Promise<void>;
  getDiscoveredAgents(): DiscoveredAgent[];
  getSocialChannels(): SessionChannel[];
  sendSocialMessage(channelId: string, content: string): Promise<void>;
  startSocialHeartbeat(config?: Partial<HeartbeatConfig>): Promise<void>;
  stopSocialHeartbeat(): void;
}

class PiAgentSession implements AgentSession {
  private cwd: string;
  private peerId: string;
  private identity: IdentityDoc;
  private minimaxAvailable = false;
  private workflows: Map<string, Workflow> = new Map();
  private constraintLayer: ConstraintLayer;
  private workflowEngine: WorkflowEngine;
  private sessionManager: PiSessionManager;
  private agentsManager: DiscoveredAgentsManager;
  private socialHeartbeat: SocialHeartbeat | null = null;
  private messageHistory: Message[] = [];
  private tools: Map<string, Tool> = new Map();
  private readonly MAX_REACT_ITERATIONS = 10;

  constructor(config: AgentSessionConfig) {
    this.cwd = config.cwd;
    this.peerId = config.peerId || 'local';
    this.identity = config.identityDoc || this.createDefaultIdentity();
    this.minimaxAvailable = this.checkMinimax();
    this.constraintLayer = new ConstraintLayer();
    this.workflowEngine = new WorkflowEngine(this.constraintLayer);
    this.sessionManager = new PiSessionManager(this.identity.did, this.cwd);
    this.agentsManager = new DiscoveredAgentsManager();
    this.initSession();
    this.registerTools();
  }

  private registerTools(): void {
    this.tools.set('read_document', {
      name: 'read_document',
      description: '读取文档内容，支持 .txt, .md, .pdf, .docx 格式',
      parameters: { path: '文件路径' },
      execute: async (args) => {
        try {
          const content = await documentReader.read(args.path);
          return {
            success: true,
            output: `📄 ${content.metadata.filename}\n大小: ${content.metadata.size} 字节\n\n${content.text.substring(0, 1000)}${content.text.length > 1000 ? '...' : ''}`
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    });

    this.tools.set('summarize_document', {
      name: 'summarize_document',
      description: '总结文档内容，分析并生成摘要',
      parameters: { path: '文件路径', context: '可选上下文信息' },
      execute: async (args) => {
        try {
          if (!this.minimaxAvailable) {
            return { success: false, error: 'LLM未初始化，请设置 MINIMAX_API_KEY' };
          }
          const result = await this.summarizeDocument(args.path, args.context);
          return {
            success: true,
            output: `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    });

    this.tools.set('improve_document', {
      name: 'improve_document',
      description: '根据要求改进文档内容',
      parameters: { path: '文件路径', requirements: '改进要求' },
      execute: async (args) => {
        try {
          if (!this.minimaxAvailable) {
            return { success: false, error: 'LLM未初始化，请设置 MINIMAX_API_KEY' };
          }
          const result = await this.improveDocument({
            originalPath: args.path,
            requirements: args.requirements
          });
          return {
            success: true,
            output: `✅ 改进${result.improved ? '成功' : '失败'}\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10\n${result.newContent ? '\n改进内容:\n' + result.newContent.substring(0, 500) + '...' : ''}`
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    });

    this.tools.set('list_peers', {
      name: 'list_peers',
      description: '列出已连接的对等节点',
      parameters: {},
      execute: async () => {
        const peers = p2pNetwork.getPeers();
        if (peers.length === 0) {
          return { success: true, output: '当前无连接的对等节点' };
        }
        return { success: true, output: `已连接节点 (${peers.length}):\n${peers.map(p => `  - ${p}`).join('\n')}` };
      }
    });

    this.tools.set('send_message', {
      name: 'send_message',
      description: '向指定对等节点发送消息',
      parameters: { peer_id: '对等节点ID', message: '消息内容' },
      execute: async (args) => {
        try {
          await p2pNetwork.sendMessage(args.peer_id, 'message', args.message);
          return { success: true, output: `消息已发送到 ${args.peer_id}` };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    });

    this.tools.set('broadcast_message', {
      name: 'broadcast_message',
      description: '向所有对等节点广播消息',
      parameters: { message: '消息内容' },
      execute: async (args) => {
        try {
          await p2pNetwork.broadcast('message', args.message);
          return { success: true, output: '消息已广播到所有节点' };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    });

    this.tools.set('get_identity', {
      name: 'get_identity',
      description: '获取当前智能体身份信息',
      parameters: {},
      execute: async () => {
        const id = this.getIdentity();
        return {
          success: true,
          output: `DID: ${id.did}\n名称: ${id.name}\n公钥: ${id.publicKey}\n创建时间: ${new Date(id.createdAt).toISOString()}`
        };
      }
    });

    this.tools.set('get_operation_logs', {
      name: 'get_operation_logs',
      description: '获取约束层的操作日志',
      parameters: {},
      execute: async () => {
        const logs = this.constraintLayer.getLogs();
        if (logs.length === 0) {
          return { success: true, output: '暂无操作日志' };
        }
        return {
          success: true,
          output: `操作日志 (${logs.length} 条):\n${logs.slice(-10).map(l => `[${new Date(l.timestamp).toISOString()}] ${l.action} - ${l.status}`).join('\n')}`
        };
      }
    });
  }

  private getToolDefinitions(): string {
    const defs: string[] = ['可用工具:'];
    for (const tool of this.tools.values()) {
      const params = Object.entries(tool.parameters).map(([k, v]) => `${k}: ${v}`).join(', ');
      defs.push(`- ${tool.name}(${params}) - ${tool.description}`);
    }
    return defs.join('\n');
  }

  private async initSession(): Promise<void> {
    await this.sessionManager.initialize();
    await this.agentsManager.initialize();
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

    this.messageHistory.push({
      role: 'user',
      content: input
    });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(input);
      this.messageHistory.push({ role: 'assistant', content: response });
      return response;
    }

    return this.runReActLoop();
  }

  async promptStream(input: string, onStream: StreamCallback): Promise<string> {
    this.minimaxAvailable = this.checkMinimax();

    this.messageHistory.push({
      role: 'user',
      content: input
    });

    onStream({ type: 'thinking', content: '🤔 思考中...' });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(input);
      this.messageHistory.push({ role: 'assistant', content: response });
      onStream({ type: 'done', content: '' });
      return response;
    }

    const result = await this.runReActLoop();
    onStream({ type: 'done', content: '' });
    return result;
  }

  private async runReActLoop(): Promise<string> {
    const llm = getMinimax();
    let iteration = 0;
    let finalResponse = '';

    while (iteration < this.MAX_REACT_ITERATIONS) {
      iteration++;

      const context = this.buildContext();
      const toolDefs = this.getToolDefinitions();

      const systemPrompt = `你是OpenClaw文档智能体，基于ReAct (Reasoning + Acting)模式工作。

当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})

${toolDefs}

工作模式:
1. 理解用户自然语言请求
2. 分析需要哪些工具来完成
3. 按顺序调用工具并观察结果
4. 根据观察结果决定下一步
5. 最终给出完整回答

重要:
- 每次只调用一个工具
- 仔细分析工具返回结果
- 如果任务完成，返回完整回答
- 如果需要更多信息，继续调用工具`;

      const response = await llm.chat(context, systemPrompt);
      const reply = response.reply.trim();

      if (this.isFinalResponse(reply)) {
        finalResponse = this.extractFinalAnswer(reply);
        break;
      }

      const toolCall = this.parseToolCall(reply);
      if (toolCall) {
        this.messageHistory.push({
          role: 'assistant',
          content: reply,
          toolCall
        });

        const tool = this.tools.get(toolCall.name);
        if (!tool) {
          const errorResult: ToolResult = { success: false, error: `未知工具: ${toolCall.name}` };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          continue;
        }

        const result = await tool.execute(toolCall.args);
        this.messageHistory.push({ role: 'tool', content: JSON.stringify(result), toolResult: result });

        if (!result.success && result.error) {
          console.warn(`Tool ${toolCall.name} error: ${result.error}`);
        }
      } else {
        this.messageHistory.push({ role: 'assistant', content: reply });
        finalResponse = reply;
        break;
      }
    }

    if (!finalResponse) {
      finalResponse = '任务处理超时，请尝试更具体的请求。';
    }

    this.messageHistory.push({ role: 'assistant', content: finalResponse });
    return finalResponse;
  }

  private buildContext(): string {
    const recentMessages = this.messageHistory.slice(-10);
    return recentMessages.map(m => {
      if (m.role === 'user') return `用户: ${m.content}`;
      if (m.role === 'assistant') return `助手: ${m.content}`;
      if (m.role === 'tool') {
        const result = m.toolResult ? JSON.stringify(m.toolResult) : m.content;
        return `工具结果: ${result}`;
      }
      return m.content;
    }).join('\n');
  }

  private isFinalResponse(content: string): boolean {
    const finalMarkers = ['最终回答', '完成', '答案如下', '结果是', 'final', 'answer:', '结果:'];
    const lower = content.toLowerCase();
    return finalMarkers.some(m => lower.includes(m)) || (content.includes('✅') && content.length < 500);
  }

  private extractFinalAnswer(content: string): string {
    const lines = content.split('\n');
    const answerStart = lines.findIndex(l =>
      ['最终回答', '完成', '答案如下', '结果是', 'final', 'answer:'].some(m => l.toLowerCase().includes(m))
    );
    if (answerStart >= 0) {
      return lines.slice(answerStart + 1).join('\n').trim();
    }
    return content;
  }

  private parseToolCall(content: string): { name: string; args: Record<string, string> } | null {
    const patterns = [
      /调用工具[：:]\s*(\w+)\s*\(([^)]*)\)/,
      /使用工具[：:]\s*(\w+)\s*\(([^)]*)\)/,
      /tool[_\w]*[：:]\s*(\w+)\s*\(([^)]*)\)/i,
      /(\w+)\s*\(\s*([^)]*)\s*\)/
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const name = match[1];
        const argsStr = match[2] || '';
        const args: Record<string, string> = {};

        const argPairs = argsStr.split(',').map(s => s.trim()).filter(Boolean);
        for (const pair of argPairs) {
          const [key, ...valueParts] = pair.split(':').map(s => s.trim().replace(/['"]/g, ''));
          if (key) {
            args[key] = valueParts.join(':') || '';
          }
        }

        if (this.tools.has(name) || this.tools.has(name.replace(/_/g, '_'))) {
          return { name, args };
        }
      }
    }
    return null;
  }

  private async handleFallback(input: string): Promise<string> {
    const lowerInput = input.toLowerCase();
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    if (cmd.includes('读取') || cmd === 'read' || cmd === 'read_document') {
      if (args) return await this.readDocument(args);
    }

    if (cmd.includes('总结') || cmd === 'summary' || cmd === 'summarize') {
      if (args) return await this.summarizeText(args);
    }

    if (cmd.includes('改进') || cmd === 'improve' || cmd === 'improve_document') {
      const match = input.match(/改进[^\w]+(.+)/i) || input.match(/improve\s+(.+)/i);
      if (match) {
        return `改进需要LLM支持，请设置 MINIMAX_API_KEY 环境变量。\n文件: ${match[1]}`;
      }
    }

    if (cmd.includes('节点') || cmd === 'peers' || cmd === 'list_peers') {
      return this.listPeers();
    }

    if (cmd.includes('身份') || cmd === 'identity' || cmd === 'get_identity') {
      return JSON.stringify(this.getIdentity(), null, 2);
    }

    if (cmd.includes('日志') || cmd === 'logs') {
      const logs = this.constraintLayer.getLogs();
      if (logs.length === 0) return '暂无操作日志';
      return logs.slice(-5).map(l => `[${new Date(l.timestamp).toISOString()}] ${l.action}`).join('\n');
    }

    return this.getDefaultResponse(input);
  }

  private getDefaultResponse(input: string): string {
    return `收到了: "${input}"

我是一个文档处理智能体，支持自然语言交互。

可用操作（直接说出即可）:
  - "读取 README.md" - 读取并分析文档
  - "总结文档" - 总结文档内容
  - "改进文档，按照X要求" - 改进文档
  - "查看节点" - 查看已连接的对等节点
  - "向X发送消息Y" - 向对等节点发送消息
  - "广播消息X" - 广播消息到所有节点
  - "查看身份" - 查看当前智能体身份
  - "查看日志" - 查看最近操作日志

示例请求:
  - "读取 src/index.ts 文件"
  - "总结一下 README.md"
  - "查看当前连接了哪些节点"
  - "向 QmABC... 发送测试消息"`;
  }

  async suggestRename(messages: { type: string; content: string }[]): Promise<string | null> {
    if (!this.minimaxAvailable || messages.length < 2) {
      return null;
    }

    const conversation = messages.map(m => `${m.type === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n');
    const llm = getMinimax();

    try {
      const response = await llm.chat(
        `根据以下对话内容，为这个对话生成一个简短的名称（不超过20个字）：\n\n${conversation}\n\n直接输出名称，不要其他解释。`,
        '命名建议'
      );

      const name = response.reply.trim();
      if (name && name.length <= 20 && name !== '智能体') {
        return `Agent | ${name}`;
      }
    } catch {
      // ignore
    }
    return null;
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
    this.sessionManager.addFileContext(filePath, content.text.substring(0, 1000));
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
    this.sessionManager.addFileContext(filePath, content.text.substring(0, 1000));
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

    const checkResult = await this.constraintLayer.checkGuardrails(context);
    if (!checkResult.passed && checkResult.blocked) {
      console.warn(`Guardrail blocked: ${checkResult.blocked.name}`);
    }

    return this.workflowEngine.executeWorkflow(steps, context);
  }

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

  getSessionState(): PiSessionState {
    return this.sessionManager.getState();
  }

  getMemory(): PiMemory {
    return this.sessionManager.getMemory();
  }

  getPersona(): PersonaDoc | null {
    return this.sessionManager.getPersona();
  }

  async setPersona(persona: PersonaDoc): Promise<void> {
    await this.sessionManager.savePersona(persona);
  }

  getDiscoveredAgents(): DiscoveredAgent[] {
    return this.agentsManager.getAllAgents();
  }

  getSocialChannels(): SessionChannel[] {
    return this.sessionManager.getAllChannels();
  }

  async sendSocialMessage(channelId: string, content: string): Promise<void> {
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      type: 'ai',
      content,
      sender: 'self',
      timestamp: new Date().toISOString(),
      agentId: this.identity.did
    };

    await this.sessionManager.addMessage(channelId, message);

    const channels = this.sessionManager.getAllChannels();
    const channel = channels.find(c => c.id === channelId);
    if (channel?.peerDid) {
      const agent = this.agentsManager.getAgent(channel.peerDid);
      if (agent) {
        const comm = (global as any).hyperswarmComm;
        if (comm) {
          const connections = comm.getConnections?.() || [];
          for (const conn of connections) {
            if (conn.publicKey === agent.peerId) {
              const data = new TextEncoder().encode(`social|${JSON.stringify({ from: this.identity.did, message: content })}`);
              comm.sendToConnection?.(conn, data);
              break;
            }
          }
        }
      }
    }
  }

  async startSocialHeartbeat(config?: Partial<HeartbeatConfig>): Promise<void> {
    if (this.socialHeartbeat) {
      return;
    }
    this.socialHeartbeat = await createSocialHeartbeat(this.sessionManager, this.agentsManager, config);
    this.socialHeartbeat.setOnAgentDiscovered((agent) => {
      console.log(`[Agent] 发现新智能体: ${agent.name}`);
    });
    this.socialHeartbeat.setOnSocialMessage((fromDid, message, channelId) => {
      console.log(`[Agent] 收到来自 ${fromDid} 的社交消息: ${message.substring(0, 50)}...`);
    });
  }

  stopSocialHeartbeat(): void {
    if (this.socialHeartbeat) {
      this.socialHeartbeat.stop();
      this.socialHeartbeat = null;
    }
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

export function resetAgentSession(): void {
  sessionInstance = null;
}
