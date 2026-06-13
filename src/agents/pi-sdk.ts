/**
 * Pi-SDK - Agent Session for Document Processing
 * Part of OpenClaw dual-layer architecture
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../constraints/index.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer, WorkflowContext } from './constraint-layer.js';
import { WorkflowEngine, WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
import { DeepThinkingEngine, AgentCoordinator, type ThinkResult, type AgentResult } from '@bolloon/constraint-runtime';
import { WorkflowPivotLoop, createDefaultPivotConfig, type PivotLoopConfig, type LoopResult } from './workflow-pivot-loop.js';
import { p2pDocumentTools, initDocumentReceiver } from './p2p-document-tools.js';
import { shellExec } from './shell-tool.js';
import { getBranchPrefix, getCooldownMs } from './shell-guard.js';
import {
  DiscoveredAgentsManager,
  SocialHeartbeat,
  createSocialHeartbeat,
  getSocialHeartbeat,
  type PersonaDoc,
  type DiscoveredAgent,
  type SessionChannel,
  type SessionMessage,
  type SocialSessionProvider
} from '../social/heartbeat.js';
import {
  GlobalSharedContextManager,
  createGlobalSharedContext,
  getGlobalSharedContext,
  type ActionSummary,
  type AgentInfo,
  type CooperationTask,
  type CooperationType,
  type GlobalSharedContext
} from '../social/global-shared-context.js';
import { Session, SkillRegistry, saveSession, loadSession, type Skill, type StoredSession } from '@bolloon/constraint-runtime';
import { loadSkillsFromPaths, defaultSkillPaths, describeSkill } from './skill-loader.js';

// Judgment 注入门 (P0): 在主对话 LLM 调起前自动拼入 Top 3 判断力
// 失败静默, 不阻塞主对话
import { injectJudgmentGate, recordJudgmentUsage } from '../pi-ecosystem-judgment/injection-gate.js';
// 持续监控门 (P3): AI 回复后审计是否违反原则
import { monitorAfterReply } from '../pi-ecosystem-judgment/monitor-gate.js';
// Bootstrap 生命周期 hook (SessionStart / Stop)
import { onSessionStart, onStop } from '../pi-ecosystem-judgment/human-value-pipeline.js';

// Pi Ecosystem Integration (lazy imports - initialized on demand)
// Functions from: createGoal, getCurrentGoal, completeCurrentGoal, failCurrentGoal, getGoalStats, getQueueSummary

export interface AgentSessionConfig {
  cwd: string;
  peerId?: string;
  identityDoc?: IdentityDoc;
  usePivotLoop?: boolean;
  pivotLoopConfig?: PivotLoopConfig;
  /**
   * Skills 加载目录列表, 后者覆盖前者同名 skill.
   * 留空时使用 defaultSkillPaths() 推断的默认路径
   * ( ~/.bolloon/skills/ → <cwd>/.bolloon/skills/ → ~/.boll/skills/ )
   */
  skillsPaths?: string[];
}

export interface IdentityDoc {
  did: string;
  name: string;
  publicKey: string;
  createdAt: number;
  peerId?: string;
  p2pChannel?: string;
  cid?: string;
  ipnsName?: string;
  walletAddress?: string;
}

export interface ImprovementRequest {
  originalPath: string;
  requirements: string;
  context?: string;
}

export type { WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
export type { ActionSummary, AgentInfo, CooperationTask, CooperationType } from '../social/global-shared-context.js';

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

export class PiSessionManager implements SocialSessionProvider {
  private session: Session;
  private state: PiSessionState;
  private memory: PiMemory;
  private persona: PersonaDoc | null = null;
  private channels: Map<string, SessionChannel> = new Map();
  private channelsPath: string;
  private initialized: boolean = false;
  private sessionDir: string;
  private cwd: string;
  private sharedContext: GlobalSharedContextManager;
  private agentId: string;

  constructor(agentId: string, cwd: string) {
    this.cwd = cwd;
    this.sessionDir = path.join(cwd, '.port_sessions');
    this.agentId = agentId;

    const sessionId = `pi-session-${Date.now()}`;
    this.session = new Session(sessionId);

    this.state = {
      id: sessionId,
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
    this.sharedContext = getGlobalSharedContext();
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get turnCount(): number {
    return this.session.turnCount;
  }

  addSessionMessage(msg: string): void {
    this.session.addMessage(msg);
    this.persistSession();
  }

  getSessionHistory(): string[] {
    return this.session.history;
  }

  setSessionContext(key: string, value: unknown): void {
    this.session.setContext(key, value);
    this.persistSession();
  }

  getSessionContext(key: string): unknown {
    return this.session.getContext(key);
  }

  private persistSession(): void {
    try {
      const stored: StoredSession = {
        sessionId: this.session.sessionId,
        messages: this.session.history,
        inputTokens: 0,
        outputTokens: 0
      };
      saveSession(stored);
    } catch (e) {
      console.warn('Failed to persist session:', e);
    }
  }

  private loadPersistedSession(): void {
    try {
      const sessionId = this.state.id;
      const stored = loadSession(sessionId);
      for (const msg of stored.messages) {
        this.session.addMessage(msg);
      }
    } catch {
      // No persisted session found, start fresh
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(SHARED_SESSION_PATH, { recursive: true });
    await fs.mkdir(this.sessionDir, { recursive: true });
    this.persona = await this.loadPersona();
    await this.loadChannels();
    this.loadPersistedSession();
    await this.sharedContext.initialize();

    await this.sharedContext.registerAgent({
      agentId: this.agentId,
      sessionId: this.sessionId,
      channelId: 'system',
      capabilities: this.persona?.capabilities || [],
      status: 'active',
      name: this.persona?.name,
      persona: this.persona ? {
        name: this.persona.name,
        description: this.persona.description,
        capabilities: this.persona.capabilities
      } : undefined
    });

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

  async createChannel(name: string, peerInfo?: { peerId?: string; peerDid?: string; peerName?: string }, persona?: PersonaDoc): Promise<SessionChannel> {
    await this.initialize();

    const channelId = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const channel: SessionChannel = {
      id: channelId,
      name,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...peerInfo,
      persona: persona || undefined
    };

    this.channels.set(channelId, channel);
    await this.saveChannels();
    return channel;
  }

  async getOrCreatePeerChannel(peerDid: string, peerName: string, persona?: PersonaDoc): Promise<SessionChannel> {
    await this.initialize();

    for (const channel of this.channels.values()) {
      if (channel.peerDid === peerDid) {
        return channel;
      }
    }

    return this.createChannel(`与 ${peerName} 的对话`, {
      peerDid,
      peerName
    }, persona);
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

  getChannelPersona(channelId: string): PersonaDoc | undefined {
    return this.channels.get(channelId)?.persona;
  }

  async setChannelPersona(channelId: string, persona: PersonaDoc): Promise<void> {
    await this.initialize();
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.persona = persona;
      channel.updatedAt = new Date().toISOString();
      await this.saveChannels();
    }
  }

  async addUserActionToSharedContext(content: string, importance?: number): Promise<void> {
    await this.initialize();
    await this.sharedContext.addUserAction(content, this.agentId, undefined, importance);
    await this.sharedContext.updateAgentStatus(this.agentId, 'active');
  }

  async addSharedKnowledge(knowledge: string): Promise<void> {
    await this.initialize();
    await this.sharedContext.addSharedKnowledge(knowledge);
  }

  async getRecentActionsSummary(count?: number): Promise<string> {
    return this.sharedContext.getRecentActionsSummary(count);
  }

  async getSharedKnowledge(): Promise<string[]> {
    return this.sharedContext.getSharedKnowledge();
  }

  async getGlobalContext(): Promise<GlobalSharedContext> {
    return this.sharedContext.getFullContext();
  }

  async getGlobalContextSummary(): Promise<string> {
    return this.sharedContext.getContextSummary();
  }

  async createCooperation(
    type: CooperationType,
    task: string,
    toAgentId?: string,
    context?: string
  ): Promise<CooperationTask> {
    await this.initialize();
    return this.sharedContext.createCooperation(type, this.agentId, task, toAgentId, context);
  }

  async getPendingCooperations(): Promise<CooperationTask[]> {
    return this.sharedContext.getPendingCooperations(this.agentId);
  }

  async updateCooperationStatus(
    cooperationId: string,
    status: 'pending' | 'in_progress' | 'done' | 'failed',
    result?: string
  ): Promise<void> {
    await this.sharedContext.updateCooperationStatus(cooperationId, status, result);
  }

  async getAllRegisteredAgents(): Promise<AgentInfo[]> {
    return this.sharedContext.getAllAgents();
  }

  async findAgentByCapability(capability: string): Promise<AgentInfo[]> {
    return this.sharedContext.findAgentByCapability(capability);
  }

  async getCooperation(cooperationId: string): Promise<CooperationTask | undefined> {
    return this.sharedContext.getCooperation(cooperationId);
  }

  async updateAgentStatusInRegistry(status: 'active' | 'idle' | 'busy'): Promise<void> {
    await this.sharedContext.updateAgentStatus(this.agentId, status);
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
8. set_persona(persona_json) - 更新智能体 persona，包含 name、description、personality、greeting 等
9. run_workflow(steps) - 执行预定义工作流
10. get_operation_logs() - 获取操作日志
`;

export interface HeartbeatConfig {
  intervalMs: number;
  peerDiscoveryEnabled: boolean;
  ipnsResolveEnabled: boolean;
  autoSocialEnabled: boolean;
  greetingMessage?: string;
}

export interface AgentSession {
  prompt(input: string, options?: { onStream?: StreamCallback; signal?: AbortSignal }): Promise<string>;
  promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal): Promise<string>;
  promptWithPivotLoop(input: string, config?: PivotLoopConfig): Promise<LoopResult>;
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
  addUserAction(content: string, importance?: number): Promise<void>;
  addSharedKnowledge(knowledge: string): Promise<void>;
  getRecentActionsSummary(count?: number): Promise<string>;
  getSharedKnowledge(): Promise<string[]>;
  getGlobalContextSummary(): Promise<string>;
  createCooperation(type: CooperationType, task: string, toAgentId?: string, context?: string): Promise<CooperationTask>;
  getPendingCooperations(): Promise<CooperationTask[]>;
  updateCooperationStatus(cooperationId: string, status: 'pending' | 'in_progress' | 'done' | 'failed', result?: string): Promise<void>;
  getAllRegisteredAgents(): Promise<AgentInfo[]>;
  findAgentByCapability(capability: string): Promise<AgentInfo[]>;
  archiveToHarness(): void;
  getHarnessContext(): string;
  isHarnessEnabled(): boolean;
  getHarness(): any;
  getOperationLog(): Array<{ timestamp: number; action: string; args: any; result: any; status: string }>;
}

class PiAgentSession implements AgentSession {
  private cwd: string;
  private peerId: string;
  private identity: IdentityDoc;
  private persona: PersonaDoc | null = null;
  private minimaxAvailable = false;
  private workflows: Map<string, Workflow> = new Map();
  private constraintLayer: ConstraintLayer;
  private workflowEngine: WorkflowEngine;
  private sessionManager: PiSessionManager;
  private agentsManager: DiscoveredAgentsManager;
  private socialHeartbeat: SocialHeartbeat | null = null;
  private messageHistory: Message[] = [];
  private tools: Map<string, Tool> = new Map();
  private skillRegistry: SkillRegistry = new SkillRegistry();
  private readonly MAX_REACT_ITERATIONS = 100;
  private readonly MAX_REFINE_ATTEMPTS = 3;
  private readonly QUALITY_THRESHOLD = 0.6;
  private thinkingEngine = new DeepThinkingEngine(3);
  private coordinator = new AgentCoordinator(3);
  private harness: any = null;
  private harnessEnabled = false;
  private usePivotLoop: boolean = false;
  private pivotLoopConfig?: PivotLoopConfig;

  /**
   * Judgment 注入门临时结果: 在 prompt / promptStream / promptWithPivotLoop 入口算一次, 拼到本轮 systemPrompt 末尾
   * 每次调用都会重置 (避免上一轮遗留)
   */
  private judgmentGateAddition: string = '';
  private judgmentGateUsedIds: string[] = [];

  /**
   * 当前 onStream 引用 + abort signal (computeJudgmentGate 需要 onStream 广播 phase)
   * 每次 prompt / promptStream / promptWithPivotLoop 入口设置, 用完即清
   */
  private currentOnStream: StreamCallback | null = null;
  private currentSignal: AbortSignal | null = null;
  /** Bootstrap SessionStart 拼的 system prompt 片段 (用完即清) */
  private bootstrapAddition: string = '';
  /** 当前 prompt 开始时间 (供 Stop hook 计算 durationMs) */
  private promptStartTime: number = 0;

  /**
   * 算 judgment 注入门: 失败静默, 不阻塞主对话
   * 期间通过 currentOnStream 广播 phase 事件, 前端可显示 "正在检索判断力..." 状态
   * 调用方负责用完即清 (judgmentGateAddition='')
   */
  private async computeJudgmentGate(input: string): Promise<void> {
    const safePhase = (phase: string, extra: Record<string, unknown> = {}) => {
      try {
        if (this.currentOnStream) {
          this.currentOnStream({ type: 'phase', phase, ...extra, content: '' } as any);
        }
      } catch { /* 静默 */ }
    };

    safePhase('gate_compute', { detail: '正在检索相关判断力...' });
    try {
      const gate = await injectJudgmentGate(input);
      this.judgmentGateAddition = gate.systemAddition;
      this.judgmentGateUsedIds = gate.usedIds;
      if (gate.usedIds.length > 0) {
        safePhase('gate_done', { usedCount: gate.usedIds.length });
      }
    } catch (err) {
      console.warn('[PiAgent] judgment gate failed (non-fatal):', err);
      this.judgmentGateAddition = '';
      this.judgmentGateUsedIds = [];
    }
  }

  private clearJudgmentGate(): void {
    this.judgmentGateAddition = '';
    this.judgmentGateUsedIds = [];
  }

  constructor(config: AgentSessionConfig) {
    this.cwd = config.cwd;
    this.peerId = config.peerId || 'local';
    this.identity = config.identityDoc || this.createDefaultIdentity();
    this.minimaxAvailable = this.checkMinimax();
    this.constraintLayer = new ConstraintLayer();
    this.workflowEngine = new WorkflowEngine(this.constraintLayer);
    this.sessionManager = new PiSessionManager(this.identity.did, this.cwd);
    this.agentsManager = new DiscoveredAgentsManager();
    this.usePivotLoop = config.usePivotLoop ?? false;
    this.pivotLoopConfig = config.pivotLoopConfig;
    this.initSession();
    initDocumentReceiver();
    this.registerTools();
    this.loadSkills(config.skillsPaths);
    this.initHarness();
  }

  /**
   * 从 SKILL.md 目录加载 skills 进 skillRegistry.
   *
   * 路径解析优先级 (后者覆盖前者同名 skill):
   *   1. 显式传入的 skillsPaths
   *   2. ~/.bolloon/skills/         全局用户级
   *   3. <cwd>/.bolloon/skills/     项目级
   *   4. ~/.boll/skills/            全局 (兼容 bollharness 旧用户)
   *   5. <bolloon-repo>/src/bollharness/.boll/skills/  bolloon 仓库内置 skill
   *      (bolloon 项目本身用 pi-sdk 写核心, 这 19 个 skill 视为项目级 builtin)
   *
   * 静默忽略不存在的目录.
   */
  private loadSkills(paths?: string[]): void {
    let resolved: string[];
    if (paths && paths.length > 0) {
      resolved = paths;
    } else {
      resolved = [
        ...defaultSkillPaths(os.homedir(), this.cwd),
        // bolloon 仓库内置 skill (相对本 npm 包的位置)
        this.findBolloonBuiltinSkillsPath(),
      ].filter((p): p is string => Boolean(p));
    }
    loadSkillsFromPaths(resolved)
      .then((skills) => {
        for (const s of skills) {
          if (this.skillRegistry.has(s.name)) {
            this.skillRegistry.unregister(s.name);
          }
          this.skillRegistry.register(s);
        }
        console.log(`[loadSkills] 已加载 ${skills.length} 个 skill: ${skills.map(describeSkill).join(' | ')}`);
      })
      .catch((err) => {
        console.error('[loadSkills] 加载失败:', err);
      });
  }

  /**
   * 定位 bolloon 仓库内置的 bollharness skill 目录.
   * 向上回溯 cwd, 找第一个包含 src/bollharness/.boll/skills 的祖先.
   * 找不到时返回 null (例如把 bolloon-agent 作为外部依赖安装时).
   */
  private findBolloonBuiltinSkillsPath(): string | null {
    let dir = this.cwd;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'src', 'bollharness', '.boll', 'skills');
      try {
        if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // 忽略 stat 异常, 继续向上
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private async initHarness(): Promise<void> {
    try {
      const { createBollharnessIntegration } = await import('../bollharness-integration/index.js');
      this.harness = createBollharnessIntegration();
      this.harnessEnabled = true;
    } catch (e) {
      console.warn('[PiAgentSession] Harness initialization failed:', e);
      this.harnessEnabled = false;
    }
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
        const extraInfo = id.cid ? `\nCID: ${id.cid}` : '';
        const ipnsInfo = id.ipnsName ? `\nIPNS: ${id.ipnsName}` : '';
        return {
          success: true,
          output: `DID: ${id.did}\n名称: ${id.name}\n公钥: ${id.publicKey}${extraInfo}${ipnsInfo}\n创建时间: ${new Date(id.createdAt).toISOString()}`
        };
      }
    });

    this.tools.set('set_persona', {
      name: 'set_persona',
      description: '更新智能体的 persona 信息，包括名字、描述、性格等',
      parameters: { persona_json: 'Persona JSON 对象，包含 name、description、personality、greeting 等字段' },
      execute: async (args) => {
        try {
          const personaData = typeof args.persona_json === 'string' ? JSON.parse(args.persona_json) : args.persona_json;
          const now = new Date().toISOString();
          const newPersona: PersonaDoc = {
            name: personaData.name || this.identity.name,
            description: personaData.description || '',
            capabilities: personaData.capabilities || [],
            personality: personaData.personality || '',
            greeting: personaData.greeting || '',
            interests: personaData.interests || [],
            createdAt: this.persona?.createdAt || now,
            updatedAt: now
          };
          await this.setPersona(newPersona);
          this.persona = newPersona;
          if (newPersona.name) {
            this.identity.name = newPersona.name;
          }
          return { success: true, output: `Persona 已更新:\n名称: ${newPersona.name}\n描述: ${newPersona.description}\n性格: ${newPersona.personality}` };
        } catch (e) {
          return { success: false, error: `更新 persona 失败: ${String(e)}` };
        }
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

    // 添加文件列表工具
    this.tools.set('list_files', {
      name: 'list_files',
      description: '列出目录中的文件',
      parameters: { path: '目录路径（可选，默认为当前目录）' },
      execute: async (args) => {
        try {
          const fs = await import('fs');
          const path = args.path || this.cwd;
          const files = fs.readdirSync(path);
          return {
            success: true,
            output: `📁 目录 ${path} 中的文件 (${files.length} 个):\n${files.slice(0, 20).map(f => `  - ${f}`).join('\n')}${files.length > 20 ? '\n  ...' : ''}`
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    });

    // 添加目录读取工具（更完整的实现）
    this.tools.set('read_directory', {
      name: 'read_directory',
      description: '读取目录内容，返回文件列表和目录结构',
      parameters: { path: '目录路径（可选，默认为当前目录）' },
      execute: async (args) => {
        try {
          const fs = await import('fs');
          const pathModule = await import('path');
          const targetPath = args.path || this.cwd;
          const items = fs.readdirSync(targetPath);
          const result: string[] = [];
          for (const item of items.slice(0, 30)) {
            const fullPath = pathModule.join(targetPath, item);
            try {
              const stat = fs.statSync(fullPath);
              const type = stat.isDirectory() ? '📁' : '📄';
              result.push(`${type} ${item}${stat.isDirectory() ? '/' : ''}`);
            } catch {
              result.push(`📄 ${item}`);
            }
          }
          return {
            success: true,
            output: `📂 ${targetPath} (${items.length} 项):\n${result.join('\n')}${items.length > 30 ? '\n... 还有更多文件' : ''}`
          };
        } catch (e) {
          return { success: false, error: `无法读取目录: ${String(e)}` };
        }
      }
    });

    // P2P Document Tools
    for (const tool of p2pDocumentTools) {
      this.tools.set(tool.name, tool);
    }

    // Shell Exec 工具: 给 AI 跑受限的 shell 命令
    // **只能** 跑白名单内的命令 (git/npm/tsc/vitest/cat/...)
    // **不能** 改禁区路径 (见 shell-guard.ts 的 FORBIDDEN_PATH_PATTERNS)
    // 沙箱 cwd: .bolloon-shell-sandbox/
    this.tools.set('shell_exec', {
      name: 'shell_exec',
      description: '在沙箱里跑 shell 命令. 仅支持白名单内命令: git, npm, npx, tsx, tsc, vitest, cat, head, tail, ls, wc, echo, pwd, date, mkdir, touch. 禁止管道/重定向/rm -rf/sudo. 命中护栏黑名单会被拒.',
      parameters: { command: '可执行文件 (必填, 必须在白名单)', args: '参数数组, 逗号分隔', timeoutMs: '超时毫秒, 默认 30000' },
      execute: async (args) => {
        const cmd = String(args.command || '').trim();
        if (!cmd) return { success: false, error: 'command 必填' };
        const argList = String(args.args || '').split(',').map(s => s.trim()).filter(Boolean);
        const timeoutMs = Number(args.timeoutMs) || 30000;

        const result = await shellExec(cmd, argList, { timeoutMs });
        if (result.deniedByGuard) {
          return { success: false, error: result.error };
        }
        if (!result.success) {
          return { success: false, error: result.error, output: result.output };
        }
        return { success: true, output: result.output };
      }
    });

    // self_improve 工具: AI 触发自我改进循环
    // **必须** 在 branchPrefix 命名的分支上工作
    // 心跳事件会自动调用; 用户对话里也能手动调
    this.tools.set('self_improve', {
      name: 'self_improve',
      description: `触发自我改进循环. AI 会在分支 ${getBranchPrefix()}<timestamp> 上工作, 跑 tsc + vitest 验证, 通过后输出分支名给用户审. 冷却期由策略文件决定. 命中护栏禁区的改动会被拒.`,
      parameters: { goal: '本轮改进目标 (1 句话)' },
      execute: async (args) => {
        const goal = String(args.goal || '').trim();
        if (!goal) return { success: false, error: 'goal 必填' };
        return await runSelfImproveLoop(goal);
      }
    });

    // list_skills 工具: 列出当前 session 已加载的 skills
    // 加载源: ~/.bolloon/skills/ → <cwd>/.bolloon/skills/ → ~/.boll/skills/
    this.tools.set('list_skills', {
      name: 'list_skills',
      description: '列出当前 session 已加载的 skills 及其描述. Skills 是从 SKILL.md 文件加载的, 兼容 Anthropic Agent Skills 标准 frontmatter 和 bollharness 现有 frontmatter.',
      parameters: {},
      execute: async () => {
        const skills = this.skillRegistry.list();
        if (skills.length === 0) {
          return {
            success: true,
            output: '当前 session 没有加载任何 skill. 检查 ~/.bolloon/skills/ 或项目 .bolloon/skills/ 目录.',
          };
        }
        const lines = skills.map((s, i) => `${i + 1}. ${s.name} — ${s.description}`);
        return { success: true, output: `已加载 ${skills.length} 个 skill:\n${lines.join('\n')}` };
      }
    });

    // use_skill 工具: 加载指定 skill 的 body 进 LLM context
    // Skills 协议核心: 把 SKILL.md body 作为 Markdown 指南返回, LLM 下一轮按它执行
    this.tools.set('use_skill', {
      name: 'use_skill',
      description: '按名称加载一个 skill, 把它的 SKILL.md body 作为 Markdown 文档返回. 调用后 LLM 会在下一轮按 skill 指南执行. 与 shell_exec / read_document 这些 "能力工具" 不同, use_skill 是 "知识注入".',
      parameters: { name: 'skill 名称 (用 list_skills 查可用的)' },
      execute: async (args) => {
        const name = String(args.name || '').trim();
        if (!name) return { success: false, error: 'name 必填' };
        if (!this.skillRegistry.has(name)) {
          const available = this.skillRegistry.list().map((s) => s.name).join(', ');
          return { success: false, error: `skill "${name}" 未找到. 已加载: ${available || '(无)'}` };
        }
        try {
          const body = await this.skillRegistry.execute(name, {});
          return { success: true, output: body };
        } catch (e) {
          return { success: false, error: `执行 skill 失败: ${String(e)}` };
        }
      }
    });
  }

  private async registerP2PDocumentReceiver(): Promise<void> {
    await initDocumentReceiver();
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

    this.persona = this.sessionManager.getPersona();
    if (this.persona?.name) {
      this.identity.name = this.persona.name;
    }
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

  async prompt(input: string, options?: { onStream?: StreamCallback; signal?: AbortSignal }): Promise<string> {
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

    // P0 注入门
    this.currentSignal = options?.signal ?? null;
    this.currentOnStream = options?.onStream ?? null;
    await this.computeJudgmentGate(input);
    try {
      return await this.runReActLoop(undefined, options?.signal);
    } finally {
      if (this.judgmentGateUsedIds.length > 0) {
        recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
          console.warn('[PiAgent] recordJudgmentUsage failed:', err)
        );
      }
      this.clearJudgmentGate();
      this.currentSignal = null;
      this.currentOnStream = null;
    }
  }

  async promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal): Promise<string> {
    this.minimaxAvailable = this.checkMinimax();

    this.messageHistory.push({
      role: 'user',
      content: input
    });

    onStream({ type: 'thinking', content: '🤔 开始思考...' });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(input);
      this.messageHistory.push({ role: 'assistant', content: response });
      onStream({ type: 'done', content: '' });
      return response;
    }

    // P0 注入门: 缓存 onStream + signal, computeJudgmentGate 用 currentOnStream 广播 phase
    this.currentOnStream = onStream;
    this.currentSignal = signal ?? null;
    await this.computeJudgmentGate(input);

    // Bootstrap SessionStart: 收集项目 Context, 拼到 systemAddition 头部
    // (失败静默, 5s 限流防止循环)
    let bootstrapAddition = '';
    try {
      const ss = await onSessionStart({});
      bootstrapAddition = ss.systemAddition || '';
    } catch (err) {
      console.warn('[PiAgent] onSessionStart failed (non-fatal):', err);
    }
    this.bootstrapAddition = bootstrapAddition;
    this.promptStartTime = Date.now();

    let result: string;
    try {
      result = await this.runReActLoop(onStream, signal);
    } catch (err: any) {
      // abort 失败: 视作"已中断", 抛错让上层用 partial 兜底
      this.currentOnStream = null;
      this.currentSignal = null;
      throw err;
    }
    onStream({ type: 'done', content: '' });

    // 回溯: 异步记录 usage (不等)
    if (this.judgmentGateUsedIds.length > 0) {
      recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
        console.warn('[PiAgent] recordJudgmentUsage failed:', err)
      );
      // P0.5: 把 usedIds 通过 stream 事件回传给调用方 (server.ts 写到 session message)
      try { onStream({ type: 'used_judgments', usedIds: this.judgmentGateUsedIds, content: '' } as any); } catch {}
    }

    // P3 监控门: fire-and-forget 审计 AI 回复是否违反原则
    monitorAfterReply(input, result);

    // Bootstrap Stop hook: fire-and-forget 写本次 session 摘要
    const stopStartTime = this.promptStartTime || Date.now();
    onStop({
      channelId: 'unknown',  // channelId 当前未传到 PiAgent 层 (留作下个迭代)
      durationMs: Date.now() - stopStartTime,
      usedJudgmentIds: [...this.judgmentGateUsedIds],
    }).catch((err) => console.warn('[PiAgent] onStop failed:', err));

    // 用完即清, 避免污染下一轮
    this.clearJudgmentGate();
    this.currentOnStream = null;
    this.currentSignal = null;
    this.bootstrapAddition = '';
    this.promptStartTime = 0;

    return result;
  }

  async promptWithPivotLoop(input: string, config?: PivotLoopConfig): Promise<LoopResult> {
    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(input);
      return {
        success: false,
        response,
        iterations: 0,
        toolCalls: 0,
        qualityScore: 0,
        exitReason: 'error',
        state: {
          iteration: 0,
          totalTokens: 0,
          toolCallsCount: 0,
          consecutiveNoProgress: 0,
          qualityScores: [],
          pendingToolUses: [],
          lastMeaningfulWork: 0
        }
      };
    }

    const llm = getMinimax();
    const loopConfig = config || this.pivotLoopConfig || createDefaultPivotConfig();
    const loop = new WorkflowPivotLoop(loopConfig);

    for (const tool of this.tools.values()) {
      loop.registerTool(tool);
    }

    // P0 注入门: 在构造 systemPrompt 之前算一次, 拼到末尾
    await this.computeJudgmentGate(input);

    const personaSection = this.persona ? `
角色描述: ${this.persona.description || '无'}
性格特点: ${this.persona.personality || '无'}
问候语: ${this.persona.greeting || '无'}
` : '';

    const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${personaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})

${this.getToolDefinitions()}

工作模式:
1. 理解用户自然语言请求
2. 分析需要哪些工具来完成
3. 按顺序调用工具并观察结果
4. 根据观察结果决定下一步
5. 最终给出完整回答

重要:
- 每次只调用一个工具
- 仔细分析工具返回结果
- 当任务完成时，必须在回答末尾添加 <final gen> 标记表示结束
- 如果需要更多信息，继续调用工具${this.judgmentGateAddition}`;

    const result = await loop.execute(input, llm, systemPrompt);

    this.messageHistory.push({ role: 'user', content: input });
    if (result.response) {
      this.messageHistory.push({ role: 'assistant', content: result.response });
    }

    // 回溯 + 清场
    if (this.judgmentGateUsedIds.length > 0) {
      recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
        console.warn('[PiAgent] recordJudgmentUsage failed:', err)
      );
    }
    this.clearJudgmentGate();

    return result;
  }

  private async runReActLoop(onStream?: StreamCallback, signal?: AbortSignal): Promise<string> {
    const llm = getMinimax();
    let iteration = 0;
    let finalResponse = '';
    let lastQualityScore = 0;
    let refineAttempts = 0;
    let consecutiveErrors = 0;
    let lastFailedTool = ''; // 跟踪最近一次失败的 tool name
    let lastFailedToolCount = 0; // 最近失败工具的连续失败次数
    const MAX_CONSECUTIVE_ERRORS = 3;
    const MAX_SAME_TOOL_FAILURES = 3; // 同一工具连续失败 3 次, 强制让 LLM 给出最终答案

    // 发送循环开始的事件
    if (onStream) {
      onStream({ type: 'status', content: '🔄 开始 ReAct 循环...', tool: 'system' });
    }

    while (iteration < this.MAX_REACT_ITERATIONS) {
      iteration++;

      // 调试日志：显示每次循环开始
      console.log(`[PiAgent] 循环 ${iteration}/${this.MAX_REACT_ITERATIONS} 开始`);
      if (onStream) {
        onStream({ type: 'status', content: `🔄 循环 ${iteration}/${this.MAX_REACT_ITERATIONS}`, tool: 'loop' });
      }

      const context = this.buildContext();
      const toolDefs = this.getToolDefinitions();

      // 动态构建 refine 上下文
      let refineContext = '';
      if (refineAttempts > 0 && lastQualityScore < this.QUALITY_THRESHOLD) {
        refineContext = `\n【改进提示】上轮结果质量分 ${(lastQualityScore * 10).toFixed(1)}/10，请改进回答。`;
      }

      // 连续错误时的额外提示
      if (consecutiveErrors > 0) {
        refineContext += `\n【错误提示】上轮发生 ${consecutiveErrors} 次错误，请重新分析问题或换一种方式处理。`;
      }

      const personaSection = this.persona ? `
角色描述: ${this.persona.description || '无'}
性格特点: ${this.persona.personality || '无'}
问候语: ${this.persona.greeting || '无'}
` : '';

      const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${personaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})
${refineContext}

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
- 当任务完成时，必须在回答末尾添加 <final gen> 标记表示结束
- 如果需要更多信息，继续调用工具${this.judgmentGateAddition}`;

      const response = await llm.chat(context, systemPrompt, signal);
      const reply = response.reply.trim();

      console.log(`[PiAgent] LLM 回复长度: ${reply.length}, 内容预览: "${reply.substring(0, 80)}..."`);
      console.log(`[PiAgent] LLM 完整回复:\n${reply}`);

      // 通知前端：收到 LLM 回复
      if (onStream) {
        onStream({ type: 'token', content: reply.substring(0, 100) });
      }

      if (this.isFinalResponse(reply)) {
        // 检查质量分数
        lastQualityScore = this.estimateResponseQuality(reply);

        // 如果质量太低且还有改进机会，进入改进循环
        if (lastQualityScore < this.QUALITY_THRESHOLD && refineAttempts < this.MAX_REFINE_ATTEMPTS) {
          refineAttempts++;
          console.log(`[PiAgent] 质量评分 ${(lastQualityScore * 10).toFixed(1)}/10 < ${(this.QUALITY_THRESHOLD * 10).toFixed(1)}/10，自动改进中 (${refineAttempts}/${this.MAX_REFINE_ATTEMPTS})`);
          continue;
        }

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

        // 通知前端：检测到工具调用
        if (onStream) {
          onStream({ type: 'tool', content: `🔧 调用工具: ${toolCall.name}`, tool: toolCall.name });
          if (toolCall.args && Object.keys(toolCall.args).length > 0) {
            onStream({ type: 'status', content: `📋 参数: ${JSON.stringify(toolCall.args)}`, tool: toolCall.name });
          }
        }

        const tool = this.tools.get(toolCall.name);
        if (!tool) {
          consecutiveErrors++;
          const errorResult: ToolResult = { success: false, error: `未知工具: ${toolCall.name}` };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          console.warn(`[PiAgent] 未知工具: ${toolCall.name}，跳过并继续`);
          continue;
        }

        try {
          const result = await tool.execute(toolCall.args);
          console.log(`[PiAgent] 工具 ${toolCall.name} 执行完成: success=${result.success}`);
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(result), toolResult: result });
          this.logToHarness(toolCall.name, toolCall.args, result);

          // 通知前端工具执行结果
          if (onStream) {
            if (result.success) {
              onStream({ type: 'status', content: `✅ ${toolCall.name} 执行成功`, tool: toolCall.name });
              if (result.output) {
                const outputPreview = result.output.substring(0, 200);
                onStream({ type: 'tool', content: `📤 结果: ${outputPreview}${result.output.length > 200 ? '...' : ''}`, tool: toolCall.name });
              }
            } else {
              onStream({ type: 'error', content: `❌ ${toolCall.name} 执行失败: ${result.error}`, tool: toolCall.name });
            }
          }

          if (result.success) {
            consecutiveErrors = 0; // 重置连续错误计数

            // 检查工具执行质量
            lastQualityScore = this.estimateToolResultQuality(result);
            if (lastQualityScore < this.QUALITY_THRESHOLD && refineAttempts < this.MAX_REFINE_ATTEMPTS) {
              refineAttempts++;
              console.log(`[PiAgent] 工具结果质量低，自动重试 (${refineAttempts}/${this.MAX_REFINE_ATTEMPTS})`);
            } else {
              console.log(`[PiAgent] 工具执行成功，质量评分: ${(lastQualityScore * 10).toFixed(1)}/10`);
            }

            // 工具执行成功后，继续循环获取下一个 LLM 响应
            if (onStream) {
              onStream({ type: 'status', content: `🔄 工具执行完成，继续循环...`, tool: 'loop' });
            }
            // 不 break，继续下一次循环
          } else {
            consecutiveErrors++;
            // 跟踪同一工具连续失败次数
            if (toolCall.name === lastFailedTool) {
              lastFailedToolCount++;
            } else {
              lastFailedTool = toolCall.name;
              lastFailedToolCount = 1;
            }
            console.warn(`[PiAgent] 工具 ${toolCall.name} 执行失败 (${lastFailedToolCount}/${MAX_SAME_TOOL_FAILURES}): ${result.error}`);

            // 同一工具连续失败达到上限, 不再重试, 强制 LLM 给出最终答案
            if (lastFailedToolCount >= MAX_SAME_TOOL_FAILURES) {
              console.log(`[PiAgent] 工具 ${toolCall.name} 连续 ${MAX_SAME_TOOL_FAILURES} 次失败, 放弃并要求直接回答`);
              this.messageHistory.push({
                role: 'system',
                content: `[注意] 工具 ${toolCall.name} 在这个上下文中不可用 (连续 ${MAX_SAME_TOOL_FAILURES} 次失败: ${result.error}). 请不要再次调用它, 直接用你已知的信息回答用户, 并在回答开头标记 <final gen>.`
              });
              lastFailedTool = '';
              lastFailedToolCount = 0;
              consecutiveErrors = 0;
              continue; // 让 LLM 看到系统提示后再决定
            }

            // 连续错误达到上限(混合不同工具), 尝试换一种方式
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.log(`[PiAgent] 连续 ${MAX_CONSECUTIVE_ERRORS} 次错误，尝试换一种方式处理`);
              this.messageHistory.push({
                role: 'system',
                content: `[注意] 前面的工具调用连续失败。请尝试其他工具或换一种方式完成用户请求, 或用 <final gen> 给出最终回答.`
              });
              consecutiveErrors = 0;
            }
          }
        } catch (execError) {
          consecutiveErrors++;
          const errorResult: ToolResult = { success: false, error: String(execError) };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          console.error(`[PiAgent] 工具执行异常: ${execError}`);
        }
      } else {
        // LLM 返回的不是 tool call 格式
        this.messageHistory.push({
          role: 'assistant',
          content: reply
        });

        // 通知前端收到非工具调用回复
        if (onStream) {
          onStream({ type: 'token', content: reply.substring(0, 150) });
        }

        // 检查是否需要继续循环处理
        // 更严格的判断：只有当回复明确表示需要更多信息时才继续
        const containsToolCallIntent = reply.includes('调用工具') || reply.includes('tool(') ||
          reply.includes('使用工具') || reply.includes('需要获取') || reply.includes('需要查看') ||
          // 兼容 LLM 用对象字面量输出 tool call (上轮没解析成功时, 至少要继续)
          reply.includes('tool =>') || reply.includes('[TOOL_CALL]');
        const hasError = ['不存在', '找不到', '无法找到', 'not found', 'does not exist',
          '错误', 'error', '失败', 'failed'].some(k => reply.includes(k));
        const isTooShort = reply.length < 50 && reply.length > 0;
        const hasQuestion = reply.includes('?') && (reply.includes('怎么') || reply.includes('如何') || reply.includes('什么'));

        const needsMoreWork = hasError || containsToolCallIntent || isTooShort || hasQuestion;

        if (needsMoreWork && iteration < this.MAX_REACT_ITERATIONS) {
          console.log(`[PiAgent] 继续循环处理 (${iteration}/${this.MAX_REACT_ITERATIONS}): needsMoreWork=${needsMoreWork}, hasError=${hasError}, containsToolCallIntent=${containsToolCallIntent}`);
          if (onStream) {
            onStream({ type: 'status', content: `🔄 继续处理，循环 ${iteration}...`, tool: 'loop' });
          }
          continue;
        }

        // 否则把这个当作可能的最终回答
        finalResponse = reply;
        if (onStream) {
          onStream({ type: 'status', content: `📝 提取最终回答，长度 ${reply.length}`, tool: 'system' });
        }
        break;
      }
    }

    if (!finalResponse) {
      // 走到这里通常是 LLM 一直在调同一个不存在的工具, 没输出 <final gen>
      // 把已知的失败信息也带回去, 让用户知道发生了什么
      const reason = lastFailedTool
        ? `(工具 ${lastFailedTool} 连续 ${MAX_SAME_TOOL_FAILURES} 次失败, 已放弃)`
        : `(共 ${iteration - 1} 轮无最终输出)`;
      finalResponse = `抱歉，任务未能完成 ${reason}。请换个方式提问，或明确告诉 agent 不要调用工具。`;
      if (onStream) {
        onStream({ type: 'error', content: `⚠️ 任务未完成: ${reason}`, tool: 'system' });
      }
    }

    // 通知前端循环完成
    if (onStream) {
      onStream({ type: 'status', content: `✅ 处理完成，共 ${iteration - 1} 次循环`, tool: 'system' });
    }

    const now = new Date().toISOString();
    const identityPrefix = `${this.identity.name} ｜ bolloon 智能体
<environment_details>
Current time: ${now}
Working directory: ${this.cwd}
Workspace root folder: ${this.cwd}
</environment_details>
`;
    finalResponse = identityPrefix + finalResponse;

    this.messageHistory.push({ role: 'assistant', content: finalResponse });
    return finalResponse;
  }

  async deepThink(prompt: string): Promise<{ result: ThinkResult; response: string }> {
    const result = await this.thinkingEngine.think(prompt);
    let response = `深度思考完成（${result.depth}层）:\n\n`;
    for (const step of result.steps) {
      response += `第${step.step}步: ${step.thought}\n`;
      if (step.reflection) {
        response += `  反思: ${step.reflection}\n`;
      }
      if (step.improvement) {
        response += `  改进: ${step.improvement}\n`;
      }
      response += '\n';
    }
    response += `最终输出: ${result.finalOutput}`;
    return { result, response };
  }

  async processDocumentsInParallel(
    paths: string[],
    operation: 'summarize' | 'improve',
    requirements?: string
  ): Promise<{ outputs: string[]; success: boolean }> {
    if (paths.length === 0) {
      return { outputs: [], success: true };
    }

    const subtasks = paths.map((filePath, index) => ({
      id: `doc-${index}`,
      description: `${operation}:${filePath}${requirements ? `:${requirements}` : ''}`,
      priority: index
    }));

    const dispatchPrompts = subtasks.map(t => t.description);
    const results = await this.coordinator.dispatch(dispatchPrompts.join(' ||| '), paths.length);

    const outputs: string[] = [];
    let allSuccess = true;

    for (let i = 0; i < paths.length; i++) {
      const result = results.find((r: AgentResult) => r.taskId === `task-${i}`);
      if (result) {
        outputs.push(result.output);
        if (!result.success) allSuccess = false;
      } else {
        outputs.push(`No result for ${paths[i]}`);
        allSuccess = false;
      }
    }

    return { outputs, success: allSuccess };
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
    // 只有明确输出 <final gen> 才认为是最终回答
    return content.includes('<final gen>');
  }

  private extractFinalAnswer(content: string): string {
    // 提取 <final gen> 后的内容作为最终回答
    const marker = '<final gen>';
    const markerIndex = content.indexOf(marker);
    if (markerIndex !== -1) {
      const after = content.substring(markerIndex + marker.length).trim();
      // v3 修复: 如果 <final gen> 之后是空, fallback 用 marker 之前的内容 (去掉 marker)
      // 否则 LLM 写了 <final gen> 在末尾时, 用户看到空回复 + error
      if (after) {
        content = after;
      } else {
        content = content.substring(0, markerIndex).trim();
      }
    }
    // 移除任何 tool call 标记
    let cleaned = content
      .replace(/调用工具[：:]\s*\w+\s*\([^)]*\)/g, '')
      .replace(/使用工具[：:]\s*\w+\s*\([^)]*\)/g, '')
      .replace(/tool[_\w]*[：:]\s*\w+\s*\([^)]*\)/gi, '')
      .trim();
    return cleaned;
  }

  private parseToolCall(content: string): { name: string; args: Record<string, string> } | null {
    const patterns = [
      /调用工具[：:]\s*(\w+)\s*\(([^)]*)\)/,
      /使用工具[：:]\s*(\w+)\s*\(([^)]*)\)/,
      /tool[_\w]*[：:]\s*(\w+)\s*\(([^)]*)\)/i,
      /(\w+)\s*\(\s*([^)]*)\s*\)/,
      // 兼容 LLM 输出的对象字面量格式: {tool => "get_identity", args => {...}}
      /\{\s*tool\s*=>\s*["'](\w+)["']\s*(?:,\s*args\s*=>\s*(\{[\s\S]*?\}))?\s*\}/,
      // 兼容: tool => "get_identity"  (无 args 包裹)
      /\btool\s*=>\s*["'](\w+)["']/,
      // 兼容: [TOOL_CALL] 块内 JSON 形式 {"name": "x", "args": {...}}
      /\[TOOL_CALL\][\s\S]*?\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const name = match[1];
        let args: Record<string, string> = {};
        const rawArgs = match[2] || '';

        if (rawArgs && rawArgs.trim().startsWith('{')) {
          // JSON 形式, 尝试解析
          try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object') {
              args = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
            }
          } catch {
            // 解析失败就当字符串处理
            const argPairs = rawArgs.split(',').map(s => s.trim()).filter(Boolean);
            for (const pair of argPairs) {
              const [key, ...valueParts] = pair.split(':').map(s => s.trim().replace(/['"]/g, ''));
              if (key) args[key] = valueParts.join(':') || '';
            }
          }
        } else if (rawArgs) {
          // 形参串, 形如 key: value, key2: value2
          const argPairs = rawArgs.split(',').map(s => s.trim()).filter(Boolean);
          for (const pair of argPairs) {
            const [key, ...valueParts] = pair.split(':').map(s => s.trim().replace(/['"]/g, ''));
            if (key) args[key] = valueParts.join(':') || '';
          }
        }

        if (this.tools.has(name) || this.tools.has(name.replace(/_/g, '_'))) {
          return { name, args };
        }
      }
    }
    return null;
  }

  private estimateResponseQuality(response: string): number {
    let score = 0.5;
    if (response.length > 50) score += 0.1;
    if (response.length > 200) score += 0.1;
    if (response.length < 20) score -= 0.3;
    if (response.includes('\n')) score += 0.1;
    if (response.includes('-') || response.includes('•')) score += 0.05;
    if (response.includes('```')) score += 0.1;
    const conclusionWords = ['完成', '结果', '总结', '所以', '因此', '答案', '推荐'];
    if (conclusionWords.some(w => response.includes(w))) score += 0.1;
    if (response.includes('调用工具') || response.includes('tool(')) score -= 0.2;
    return Math.max(0, Math.min(1, score));
  }

  private estimateToolResultQuality(result: ToolResult): number {
    let score = 0.5;
    if (!result.success) return 0.2;
    if (result.output) {
      score += 0.2;
      if (result.output.length > 50) score += 0.1;
      if (result.output.length < 10) score -= 0.1;
      if (result.output.includes('❌') || result.output.includes('error')) score -= 0.2;
      if (result.output.includes('✅') || result.output.includes('success')) score += 0.1;
    }
    if (result.error) score -= 0.3;
    return Math.max(0, Math.min(1, score));
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

  private static OPERATIONS_REFERENCE: string | null = null;

  private static getOperationsReference(): string {
    if (this.OPERATIONS_REFERENCE === null) {
      try {
        const refPath = path.join(process.cwd(), 'src', 'bollharness', 'scripts', 'context-fragments', 'pi-agent-operations.md');
        this.OPERATIONS_REFERENCE = fsSync.readFileSync(refPath, 'utf-8');
      } catch {
        this.OPERATIONS_REFERENCE = '';
      }
    }
    return this.OPERATIONS_REFERENCE;
  }

  private getDefaultResponse(input: string): string {
    const operationsRef = PiAgentSession.getOperationsReference();

    if (operationsRef) {
      return `收到了: "${input}"

我是一个判断力处理智能体，支持自然语言交互。

可用操作（直接说出即可）:
${this.extractOperationsFromRef(operationsRef)}

示例请求:
  - "读取 src/index.ts 文件"
  - "总结一下 README.md"
  - "查看当前连接了哪些节点"
  - "向 QmABC... 发送测试消息"`;
    }

    return `收到了: "${input}"

我是一个判断力处理智能体，支持自然语言交互。

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

  private extractOperationsFromRef(ref: string): string {
    const lines = ref.split('\n');
    const inOperationsSection = false;
    const operationLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## 可用操作')) {
        for (let j = i + 1; j < lines.length; j++) {
          const opLine = lines[j];
          if (opLine.startsWith('## ') || opLine.startsWith('#')) break;
          if (opLine.includes('|') && !opLine.startsWith('|')) {
            const parts = opLine.split('|').map(p => p.trim());
            if (parts.length >= 3 && parts[1] && parts[2]) {
              operationLines.push(`  - "${parts[1]}" - ${parts[2]}`);
            }
          }
        }
        break;
      }
    }

    return operationLines.length > 0 ? operationLines.join('\n') :
        `  - "读取 README.md" - 读取并分析文档
  - "总结文档" - 总结文档内容
  - "改进文档，按照X要求" - 改进文档
  - "查看节点" - 查看已连接的对等节点
  - "向X发送消息Y" - 向对等节点发送消息
  - "广播消息X" - 广播消息到所有节点
  - "查看身份" - 查看当前智能体身份
  - "查看日志" - 查看最近操作日志`;
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
      // 拒绝错误回退串 (LLM 不可用时返回的占位文本)
      if (!name) return null;
      if (/^(抱歉|对不起|sorry|error|错误|失败|暂不可用|服务不可用)/i.test(name)) {
        console.log(`[suggestRename] 拒绝错误回退: "${name}"`);
        return null;
      }
      if (name.length > 20) return null;
      if (name === '智能体') return null;
      // 拒绝纯符号/标点
      if (!/[一-鿿\w]/.test(name)) return null;
      return `Agent | ${name}`;
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
    this.persona = persona;
    if (persona.name) {
      this.identity.name = persona.name;
    }
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

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  registerSkill(skill: Skill): void {
    this.skillRegistry.register(skill);
  }

  async executeSkill(name: string, params: Record<string, unknown>): Promise<string> {
    return this.skillRegistry.execute(name, params);
  }

  async addUserAction(content: string, importance?: number): Promise<void> {
    await this.sessionManager.addUserActionToSharedContext(content, importance);
  }

  async addSharedKnowledge(knowledge: string): Promise<void> {
    await this.sessionManager.addSharedKnowledge(knowledge);
  }

  async getRecentActionsSummary(count?: number): Promise<string> {
    return this.sessionManager.getRecentActionsSummary(count);
  }

  async getSharedKnowledge(): Promise<string[]> {
    return this.sessionManager.getSharedKnowledge();
  }

  async getGlobalContextSummary(): Promise<string> {
    return this.sessionManager.getGlobalContextSummary();
  }

  async createCooperation(
    type: CooperationType,
    task: string,
    toAgentId?: string,
    context?: string
  ): Promise<CooperationTask> {
    return this.sessionManager.createCooperation(type, task, toAgentId, context);
  }

  async getPendingCooperations(): Promise<CooperationTask[]> {
    return this.sessionManager.getPendingCooperations();
  }

  async updateCooperationStatus(
    cooperationId: string,
    status: 'pending' | 'in_progress' | 'done' | 'failed',
    result?: string
  ): Promise<void> {
    return this.sessionManager.updateCooperationStatus(cooperationId, status, result);
  }

  async getAllRegisteredAgents(): Promise<AgentInfo[]> {
    return this.sessionManager.getAllRegisteredAgents();
  }

  async findAgentByCapability(capability: string): Promise<AgentInfo[]> {
    return this.sessionManager.findAgentByCapability(capability);
  }

  // ==================== Harness Integration ====================

  private operationLog: Array<{ timestamp: number; action: string; args: any; result: any; status: string }> = [];

  private logToHarness(action: string, args: any, result: any): void {
    if (!this.harnessEnabled || !this.harness) return;

    this.operationLog.push({
      timestamp: Date.now(),
      action,
      args,
      result,
      status: result.success ? 'ok' : 'error'
    });

    if (this.operationLog.length >= 10) {
      this.archiveToHarness();
    }
  }

  archiveToHarness(): void {
    if (!this.harnessEnabled || !this.harness || this.operationLog.length === 0) return;

    this.harness.archiveSession(this.operationLog);
    this.operationLog = [];
  }

  getHarnessContext(): string {
    if (!this.harnessEnabled || !this.harness) {
      return 'Harness not available';
    }
    return this.harness.getSessionContext();
  }

  isHarnessEnabled(): boolean {
    return this.harnessEnabled;
  }

  getHarness(): any {
    return this.harness;
  }

  getOperationLog(): Array<{ timestamp: number; action: string; args: any; result: any; status: string }> {
    return [...this.operationLog];
  }
}

let sessionInstance: AgentSession | null = null;
let lastIdentityDid: string | null = null;

// 独立的 session 实例缓存（用于多 session 支持）
const independentSessions: Map<string, AgentSession> = new Map();

export async function createAgentSession(config: AgentSessionConfig, forceNew?: boolean): Promise<AgentSession> {
  const incomingDid = config.identityDoc?.did;

  // 如果有独立的 peerId (包含 :)，使用它作为 key
  if (config.peerId && config.peerId.includes(':')) {
    const key = config.peerId;
    if (!forceNew && independentSessions.has(key)) {
      console.log(`[createAgentSession] 找到现有独立 session, key=${key}`);
      return independentSessions.get(key)!;
    }
    const session = new PiAgentSession(config);
    independentSessions.set(key, session);
    console.log(`[createAgentSession] 创建独立 session, key=${key}, DID=${incomingDid}`);
    return session;
  }

  // 如果指定了 forceNew 但没有 peerId，生成带时间戳的 key
  if (forceNew) {
    const key = `force:${Date.now()}`;
    const session = new PiAgentSession(config);
    independentSessions.set(key, session);
    console.log(`[createAgentSession] 创建强制新 session, key=${key}`);
    return session;
  }

  // 如果有新的 DID，强制重建 session
  if (sessionInstance && lastIdentityDid && incomingDid && lastIdentityDid !== incomingDid) {
    console.log(`[createAgentSession] DID 变化 ${lastIdentityDid} -> ${incomingDid}，重建 session`);
    sessionInstance = null;
  }

  if (sessionInstance) {
    // 检查是否需要更新 identity
    const currentDid = sessionInstance.getIdentity().did;
    if (incomingDid && currentDid !== incomingDid) {
      console.log(`[createAgentSession] 更新 identity: ${currentDid} -> ${incomingDid}`);
      sessionInstance.updateIdentity({
        did: incomingDid,
        name: config.identityDoc?.name || sessionInstance.getIdentity().name,
        publicKey: config.identityDoc?.publicKey || '',
        createdAt: Date.now()
      });
    }
    return sessionInstance;
  }

  sessionInstance = new PiAgentSession(config);
  lastIdentityDid = config.identityDoc?.did || null;
  console.log(`[createAgentSession] 新建 session, DID=${lastIdentityDid}`);
  return sessionInstance;
}

export function getAgentSession(): AgentSession | null {
  return sessionInstance;
}

export function resetAgentSession(): void {
  sessionInstance = null;
  lastIdentityDid = null;
}

/**
 * 自我改进循环: 在沙箱分支上工作, 输出结果给用户审.
 *
 * 不在 PiAgent 实例上的原因: 心跳回调可能没有 agent 实例, 单独函数更易复用.
 *
 * **关键不变量**:
 *   1. AI 不能 push 到 master (shell-guard 黑名单 + git 受保护分支)
 *   2. 改动必须走沙箱分支 (SELF_IMPROVE_BRANCH_PREFIX)
 *   3. 6 小时冷却期 (SELF_IMPROVE_COOLDOWN_MS)
 *   4. 写文件必须经过 shell_exec + 护栏检查
 */
let lastSelfImproveAt: number | null = null;

export async function runSelfImproveLoop(goal: string): Promise<{ success: boolean; output?: string; error?: string }> {
  const cooldownMs = getCooldownMs();
  // 1. 冷却期检查
  if (lastSelfImproveAt && Date.now() - lastSelfImproveAt < cooldownMs) {
    const waitHrs = Math.ceil((cooldownMs - (Date.now() - lastSelfImproveAt)) / 3600000);
    return { success: false, error: `自改冷却中, 还需要约 ${waitHrs} 小时` };
  }

  // 2. 选源分支 + 新分支名
  const sourceBranch = 'master';
  const newBranch = `${getBranchPrefix()}${Date.now()}`;

  console.log(`[self-improve] 启动自改循环, 目标: ${goal}, 新分支: ${newBranch}`);

  // 3. 创建分支
  const r1 = await shellExec('git', ['checkout', sourceBranch]);
  if (!r1.success) return { success: false, error: `切换到 ${sourceBranch} 失败: ${r1.error}` };

  const r2 = await shellExec('git', ['checkout', '-b', newBranch]);
  if (!r2.success) return { success: false, error: `创建分支失败: ${r2.error}` };

  // 4. 走 task queue: 把"自改"作为一个 task 抛回去, AI 拿到后会用 shell_exec 改
  //    护栏已经阻止所有禁区改动, 这里只负责登记
  lastSelfImproveAt = Date.now();
  return {
    success: true,
    output: `✅ 自改分支已创建: ${newBranch}\n目标: ${goal}\n\n**护栏已激活**:\n  - 仅允许白名单命令 (git/npm/tsc/vitest/cat/ls/...)\n  - 禁止改 src/agents/pi-sdk.ts, shell-guard.ts, src/heartbeat/, src/network/, src/pi-ecosystem-judgment/, package.json, .env 等\n  - 6 小时冷却期\n\nAI 接下来会用 shell_exec 工具改源码. 完成后你会在对话里看到 diff 摘要, 手动 git diff master..${newBranch} 审, 满意再 merge.`
  };
}
