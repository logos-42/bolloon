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
import { getBranchPrefix, getCooldownMs, checkWritePath } from './shell-guard.js';
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
// Bootstrap 生命周期 hook (SessionStart / Stop / PreToolUse)
import { onSessionStart, onStop, onPreToolUse } from '../pi-ecosystem-judgment/human-value-pipeline.js';
import { onPostToolUse, onJudgmentInjected, onMonitorViolation } from '../bootstrap/lifecycle-hooks.js';
import { budgetReduce, snip, microcompact } from '../context-compaction/index.js';
// React Harness: 8-gate + 4-guard (防越权 / 防 prompt 注入)
import { ReactHarness } from '../security/react-harness.js';

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
  /** M2.3 (2026-06-17): 指定时构造时从 ~/.bolloon/sessions/cache/<channel>:<sessionId>.json 加载历史到 messageHistory */
  loadSessionKey?: string;
  /** M2.3: 历史回灌最多取 N 条 (默认 30, 防止 context 爆) */
  loadSessionMaxMessages?: number;
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
  type: 'status' | 'thinking' | 'tool' | 'token' | 'done' | 'error'
      | 'step_start' | 'step_done' | 'step_error';
  content: string;
  tool?: string;
  data?: unknown;
  // step_* 专用: success / output / error
  success?: boolean;
  output?: string;
  error?: string;
  args?: Record<string, unknown>;
  // step_* 可选: 步骤耗时 (server 端用来展示 in 状态条 + 性能分析)
  durationMs?: number;
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
  prompt(input: string, options?: { onStream?: StreamCallback; signal?: AbortSignal; channelId?: string }): Promise<string>;
  promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal, channelId?: string): Promise<string>;
  promptWithPivotLoop(input: string, config?: PivotLoopConfig, channelId?: string): Promise<LoopResult>;
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
  setCurrentChannelId(channelId: string): void;
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
  /** M2.4: 缓存 tool 列表, registerTools() 之后不变, runReActLoop 多次循环复用 */
  private cachedToolDefinitions: string = '';
  /** M2.4: 缓存 persona section */
  private cachedPersonaSection: string = '';
  // 2026-06-16 修: 父要求把 ReAct loop 上限放大到 "几乎无限", 靠自动压缩上下文 + fail-safe 兜底
  // 默认 10000 — 正常任务永远跑不到, 但作为防 LLM 死循环 / 防 OOM 的最后一道闸
  // 旧默认 100 写死导致中等复杂度任务 (10-50 个 tool call + 多步反思) 会被误杀
  private readonly MAX_REACT_ITERATIONS = 10_000;
  private readonly MAX_REFINE_ATTEMPTS = 3;
  private readonly QUALITY_THRESHOLD = 0.6;
  /** P1: 上下文溢出阈值 (单轮估算 token 数, 超过则强制终止防止 prompt-too-long) */
  private readonly MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD = 60_000;  // 60K tokens 上限
  /** 2026-06-16 新增: 累计错误总数兜底 (不管是否同工具, 累计 N 次就强制退出)
   *  防 LLM 轮换工具名绕开 MAX_SAME_TOOL_FAILURES 的死循环攻击 */
  private readonly MAX_TOTAL_ERRORS = 20;
  /** 2026-06-16 新增: loop 内自动压缩触发阈值 (相对 60K 阈值的比例) */
  private readonly LOOP_COMPACT_RATIO = 0.8;
  /** P1: max output token 升级重试 (LLM 截断时重试, 最多 3 次) */
  private readonly MAX_OUTPUT_TOKEN_ESCALATION_RETRIES = 3;
  private thinkingEngine = new DeepThinkingEngine(3);
  private coordinator = new AgentCoordinator(3);
  private harness: any = null;
  private harnessEnabled = false;
  /** 8-gate + 4-guard 集中调度 (防越权 / 防 prompt 注入) */
  private reactHarness: ReactHarness = new ReactHarness();
  private usePivotLoop: boolean = false;
  private pivotLoopConfig?: PivotLoopConfig;
  /** P2: 当前会话的 permission mode (每次 promptStream 入口解析) */
  private currentPermissionMode: import('./permission-mode.js').PermissionMode = 'default';
  /** P1.2: Context Collapse 读时投影结果 (feature flag 开启时由 maybeAutoCompact 写入, buildContext 优先用) */
  private projectedHistory: Message[] | null = null;

  /**
   * Judgment 注入门临时结果: 在 prompt / promptStream / promptWithPivotLoop 入口算一次, 拼到本轮 systemPrompt 末尾
   * 每次调用都会重置 (避免上一轮遗留)
   */
  private judgmentGateAddition: string = '';
  private judgmentGateUsedIds: string[] = [];
  // 2026-06-18: 来自 web server markedPrompt 外的 contextHint (channel/judgment/distill/remote channels),
  //   拼到 systemPrompt 末尾, 别再混进 user message
  private contextHintAddition: string = '';

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
  /** 当前 channel id (由 getAgentForChannel / prompt 4 参注入, 供 hook / log 使用) */
  private currentChannelId: string = '';

  /** M2.2 (2026-06-17): 当前轮的用户请求 intent, runReActLoop 拼 systemPrompt 时会读这个 */
  private currentIntent: 'question' | 'code_edit' | 'multi_step' | 'chitchat' | 'document' = 'chitchat';
  private currentIntentHint: string = '';

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
      // P-Action 4 (2026-06-15) 路径 1 整合: 透传 maxChars=1500 (≈ 375 tokens 硬上限)
      // 路径 2/3 检测由 injection-gate 内部 alreadyInjectedSources 处理 (目前 assembleSystemPrompt 还没注入 value-store 标记, 所以这里不传)
      const gate = await injectJudgmentGate(input, {}, { maxChars: 1500 });
      this.judgmentGateAddition = gate.systemAddition;
      this.judgmentGateUsedIds = gate.usedIds;
      if (gate.usedIds.length > 0) {
        safePhase('gate_done', { usedCount: gate.usedIds.length, didInject: gate.didInject, skipReason: gate.skipReason });
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
    // M2.3 (2026-06-17): 重启后 LLM 恢复记忆 — 从 session JSON 加载历史到 messageHistory
    //   之前 messageHistory 是空的, 服务重启后 LLM 看到的是新对话
    //   现在 loadSessionKey 形如 "channel-xxx:default" 走 ~/.bolloon/sessions/cache/<key>.json
    if (config.loadSessionKey) {
      this.hydrateMessageHistory(config.loadSessionKey, config.loadSessionMaxMessages ?? 30);
    }
  }

  /**
   * M2.3: 从 session JSON 加载历史, 转成 messageHistory 格式
   * - 失败静默 (历史加载失败不应该阻塞 agent 启动)
   * - 限制 max 条数, 防止 context 爆
   * - user 消息 role=user, ai 消息 role=assistant
   * - 跳过 metadata 中含 error 的 (错误消息会污染 LLM)
   */
  private async hydrateMessageHistory(sessionKey: string, maxMessages: number): Promise<void> {
    try {
      const sessionPath = path.join(os.homedir(), '.bolloon', 'sessions', 'cache', `${sessionKey}.json`);
      const content = await fs.readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content);
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      // 保留最后 N 条, 转换 role 字段
      const tail = messages.slice(-maxMessages);
      const hydrated: Message[] = [];
      for (const m of tail) {
        // 跳过错误的 AI 消息 (M1.2 之后, AI 错误时 reply 是 [AI 服务调用失败] 字符串, 不该进 history)
        if (m?.type === 'ai' && typeof m.content === 'string' && m.content.startsWith('[AI 服务调用失败]')) continue;
        if (m?.type === 'ai' && typeof m.content === 'string' && m.content.startsWith('[错误:')) continue;
        if (!m?.content) continue;
        const role = m.type === 'user' ? 'user' : m.type === 'ai' ? 'assistant' : null;
        if (!role) continue;
        hydrated.push({ role, content: String(m.content) });
      }
      if (hydrated.length > 0) {
        this.messageHistory = hydrated;
        console.log(`[PiAgent] 从 ${sessionKey} 回灌 ${hydrated.length} 条历史`);
      }
    } catch (err) {
      console.warn(`[PiAgent] hydrateMessageHistory 失败 (non-fatal): ${(err as Error).message?.slice(0, 100)}`);
    }
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
      // ReactHarness 已用 bollharness, 这里也记一份以供 archive 调用
      this.reactHarness = new ReactHarness({ harnessEnabled: true, gateEnabled: true });
    } catch (e) {
      console.warn('[PiAgentSession] Harness initialization failed:', e);
      this.harnessEnabled = false;
      // 失败 fallback: 走纯 8-gate (不带 bollharness 的 8-gate 工作流)
      this.reactHarness = new ReactHarness({ harnessEnabled: false, gateEnabled: true });
    }
  }

  private registerTools(): void {
    this.tools.set('read_document', {
      name: 'read_document',
      description: '读取文档内容，支持 .txt, .md, .pdf, .docx 格式',
      parameters: { path: 'string' },
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
      parameters: { path: 'string', context: 'string' },
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
      parameters: { path: 'string', requirements: 'string' },
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
      description: '在 cwd (process.cwd(), 即 bolloon 当前工作目录) 跑 shell 命令. 仅支持白名单内命令: git, npm, npx, tsx, tsc, vitest, cat, head, tail, ls, wc, echo, pwd, date, mkdir, touch. 禁止管道/重定向/rm -rf/sudo. 命中护栏黑名单会被拒. 注意: cwd 是真正的 git repo 工作目录, git add/commit/push 等命令会作用于本仓库, 不是 sandbox.',
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

    // M2.1 (2026-06-17): 注册 4 个长期缺失的工具 — 让 agent 真正能"修改 + 提交"代码
    // 路径限制走 shell-guard 同款 allowlist (复用 checkWritePath / checkCommand)
    // 这些工具之前在 tool-gate 白名单 + tool-manifest 中存在, 但 pi-sdk 未注册 — 修复孤儿

    this.tools.set('write_file', {
      name: 'write_file',
      description: '写入一个文件. 路径必须在白名单 (src/web/*, src/agents/workflow-*, *.md, docs/**, src/test/**, src/agents/pi-sdk.ts 等). 大文件 (> 100KB) 会被拒. 命中护栏黑名单 (shell-guard.ts, package.json, .env, .git, .bolloon, dist) 会拒.',
      parameters: { path: '相对路径 (必填, 相对 cwd)', content: '文件内容 (必填)' },
      execute: async (args) => {
        const relPath = String(args.path || '').trim();
        const content = String(args.content ?? '');
        if (!relPath) return { success: false, error: 'path 必填' };
        if (content.length > 100_000) return { success: false, error: `内容过大 (${content.length} > 100000 字节), 请分块写` };
        // 路径检查: 复用 shell-guard 的 checkWritePath
        const pathResult = checkWritePath(relPath);
        if (!pathResult.allowed) {
          return { success: false, error: `路径被护栏拒: ${pathResult.reason}` };
        }
        try {
          const absPath = path.resolve(this.cwd, relPath);
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, content, 'utf-8');
          return { success: true, output: `✅ wrote ${relPath} (${content.length} bytes)` };
        } catch (e) {
          return { success: false, error: `写文件失败: ${String(e)}` };
        }
      }
    });

    this.tools.set('edit_file', {
      name: 'edit_file',
      description: '编辑一个文件: 在 path 处查找 old_text, 替换为 new_text. 找不到 old_text 会失败 (避免静默不替换). 路径同样受护栏限制.',
      parameters: { path: '相对路径 (必填)', old_text: '要替换的文本 (必填, 全文匹配)', new_text: '新文本 (必填)' },
      execute: async (args) => {
        const relPath = String(args.path || '').trim();
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        if (!relPath) return { success: false, error: 'path 必填' };
        if (!oldText) return { success: false, error: 'old_text 必填' };
        const pathResult = checkWritePath(relPath);
        if (!pathResult.allowed) {
          return { success: false, error: `路径被护栏拒: ${pathResult.reason}` };
        }
        try {
          const absPath = path.resolve(this.cwd, relPath);
          const original = await fs.readFile(absPath, 'utf-8');
          if (!original.includes(oldText)) {
            return { success: false, error: `old_text 在 ${relPath} 中未找到, 拒绝静默写入. 请先用 read_document 读最新内容.` };
          }
          const updated = original.replace(oldText, newText);
          await fs.writeFile(absPath, updated, 'utf-8');
          return { success: true, output: `✅ edited ${relPath} (${oldText.length} → ${newText.length} 字节)` };
        } catch (e) {
          return { success: false, error: `编辑文件失败: ${String(e)}` };
        }
      }
    });

    this.tools.set('git_diff', {
      name: 'git_diff',
      description: '查看 git diff. 默认显示未提交改动 (staged + unstaged), 可指定 ref1..ref2 看两个 commit/分支之间的 diff. 输出会截到 8000 字符避免超长.',
      parameters: { range: '可选. e.g. "HEAD~3..HEAD" 或 "master..agent/feat-x". 省略则看未提交改动.' },
      execute: async (args) => {
        const range = String(args.range || '').trim();
        const argv = range ? ['diff', range] : ['diff'];
        const result = await shellExec('git', argv, { timeoutMs: 10_000 });
        if (result.deniedByGuard) return { success: false, error: result.error };
        if (!result.success) return { success: false, error: result.error, output: result.output };
        const out = (result.output || '').slice(0, 8000);
        return { success: true, output: out || '(空 diff — 没有未提交改动)' };
      }
    });

    this.tools.set('git_commit', {
      name: 'git_commit',
      description: 'git add -A + git commit. 提交信息由 LLM 提供. 不会 push — push 是 agent 显式调 git_commit_and_push 触发. 命中护栏 (push to master/main, force-push) 仍会被拒. 内部自动设 BOLLOON_AUTO_EVOLVE=1 让 pre-commit hook 跳过 vitest/tsc (auto-evolve 模式, CI 兜底).',
      parameters: { message: 'commit message (必填, 用 HEREDOC 多行)' },
      execute: async (args) => {
        const message = String(args.message || '').trim();
        if (!message) return { success: false, error: 'message 必填' };
        // M3.4 (2026-06-17): agent git_commit 自动设 BOLLOON_AUTO_EVOLVE=1, 让 lefthook pre-commit 跳过 vitest/tsc
        //   这样频繁 commit 不会被 30s+ 的 pre-commit 阻塞. CI 会兜底 (push 后 GitHub Actions 跑测试)
        // 先 add
        const addResult = await shellExec('git', ['add', '-A'], { timeoutMs: 10_000 });
        if (addResult.deniedByGuard) return { success: false, error: addResult.error };
        if (!addResult.success) return { success: false, error: `git add 失败: ${addResult.error}` };
        // 再 commit (message 用 -m, 避免 HEREDOC 注入)
        // Windows shell 不支持 inline env var, 改用 child_process 直接 spawn
        // 简单方案: 用 spawn + 临时设 env
        try {
          const { spawn: spawnFn } = await import('child_process');
          const env = { ...process.env, BOLLOON_AUTO_EVOLVE: '1' };
          const output = await new Promise<string>((resolve, reject) => {
            const proc = spawnFn('git', ['commit', '-m', message], {
              cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = ''; let stderr = '';
            proc.stdout.on('data', (d: any) => stdout += d.toString());
            proc.stderr.on('data', (d: any) => stderr += d.toString());
            proc.on('close', (code: number) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `git commit exited ${code}`)));
            proc.on('error', reject);
          });
          return { success: true, output: `✅ committed: ${message.split('\n')[0]}\n${output}` };
        } catch (e) {
          return { success: false, error: `git commit 失败: ${String((e as Error).message || e).slice(0, 500)}` };
        }
      }
    });

    // M3.4: git_push — 改完直接 push (Q3-B 决策, 修改了 pre-push hook 让它别卡)
    // 命中护栏 (push to master/main, force-push) 仍会被拒 — 这两条底线不变
    this.tools.set('git_push', {
      name: 'git_push',
      description: 'git push 当前分支到 origin. 命中护栏 (push to master/main, --force) 仍会被拒. 用于长期项目自动 commit + push 循环.',
      parameters: { remote: '可选, 默认 origin', branch: '可选, 默认当前分支' },
      execute: async (args) => {
        const remote = String(args.remote || 'origin').trim();
        const branch = String(args.branch || '').trim();
        const argv = branch ? ['push', remote, branch] : ['push', remote];
        const result = await shellExec('git', argv, { timeoutMs: 60_000 });
        if (result.deniedByGuard) return { success: false, error: result.error };
        if (!result.success) return { success: false, error: result.error, output: result.output };
        return { success: true, output: `✅ pushed to ${remote}${branch ? `/${branch}` : ''}\n${result.output || ''}` };
      }
    });

    // M3.4: git_branch — 创建/切换分支 (用于多任务并行隔离)
    this.tools.set('git_branch', {
      name: 'git_branch',
      description: 'git checkout -b <name> 或 git checkout <name>. 用于多任务并行隔离 — 改前先 checkout 到 agent/<task-id> 分支.',
      parameters: { name: '分支名 (必填, e.g. "agent/task-123")', create: '可选, "true" 表示创建新分支 (默认 false = 切到已有)' },
      execute: async (args) => {
        const name = String(args.name || '').trim();
        const create = String(args.create || 'false') === 'true';
        if (!name) return { success: false, error: 'name 必填' };
        const argv = create ? ['checkout', '-b', name] : ['checkout', name];
        const result = await shellExec('git', argv, { timeoutMs: 10_000 });
        if (result.deniedByGuard) return { success: false, error: result.error };
        if (!result.success) return { success: false, error: result.error, output: result.output };
        return { success: true, output: `✅ ${create ? 'created + checked out' : 'checked out'} ${name}\n${result.output || ''}` };
      }
    });

    // M3.2: 任务状态机工具 — 让 agent 自己维护 multi_step 任务的状态
    this.tools.set('create_task', {
      name: 'create_task',
      description: '创建一个新多步任务, 初始 steps 列表由 LLM 给出. 返回 task-id, 后续用 update_task / get_task 跟踪进度. 任务状态写 ~/.bolloon/tasks/<id>.yaml 持久化.',
      parameters: {
        goal: '任务目标 (1 句话, 必填)',
        steps: '步骤列表 (数组, 必填, 至少 1 步)',
        sessionKey: '可选, 关联的 session key (channel:sessionId)',
        branch: '可选, 关联的 git 分支名',
      },
      execute: async (args) => {
        const goal = String(args.goal || '').trim();
        const stepsRaw = args.steps;
        if (!goal) return { success: false, error: 'goal 必填' };
        let steps: string[] = [];
        if (Array.isArray(stepsRaw)) {
          steps = stepsRaw.map((s: any) => String(s).trim()).filter(Boolean);
        } else if (typeof stepsRaw === 'string') {
          // 支持 "step1\nstep2\nstep3" 或 "step1,step2,step3"
          steps = stepsRaw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
        }
        if (steps.length === 0) return { success: false, error: 'steps 必填且至少 1 步' };
        const sessionKey = String(args.sessionKey || '').trim() || undefined;
        const branch = String(args.branch || '').trim() || undefined;
        try {
          const { createTask } = await import('./task-state.js');
          const task = await createTask({ goal, steps, sessionKey, branch });
          return { success: true, output: `✅ task created: ${task.id}\nbranch: ${branch || '(未指定)'}\nsteps:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` };
        } catch (e) {
          return { success: false, error: `create_task 失败: ${String(e)}` };
        }
      }
    });

    this.tools.set('update_task', {
      name: 'update_task',
      description: '更新任务的某一步状态 (pending → running → done/failed/skipped). 系统会自动推进下一步 pending → running (当当前步 done 时).',
      parameters: {
        task_id: '任务 id (必填)',
        step_id: '步骤 id (必填, e.g. "step-1")',
        status: '新状态 (running | done | failed | skipped)',
        result_summary: '可选, 结果摘要',
        error: '可选, 失败原因 (status=failed 时填)',
      },
      execute: async (args) => {
        const taskId = String(args.task_id || '').trim();
        const stepId = String(args.step_id || '').trim();
        const status = String(args.status || '').trim() as any;
        if (!taskId || !stepId) return { success: false, error: 'task_id + step_id 必填' };
        if (!['running', 'done', 'failed', 'skipped'].includes(status)) {
          return { success: false, error: `status 必须是 running|done|failed|skipped` };
        }
        try {
          const { updateStep } = await import('./task-state.js');
          const patch: any = { status };
          if (args.result_summary) patch.resultSummary = String(args.result_summary);
          if (args.error) patch.error = String(args.error);
          const updated = await updateStep(taskId, stepId, patch);
          if (!updated) return { success: false, error: `任务 ${taskId} 未找到` };
          const nextRunning = updated.steps.find((s) => s.status === 'running');
          return {
            success: true,
            output: `✅ step ${stepId} → ${status}\ntask 状态: ${updated.status}${nextRunning ? `\n下一步: ${nextRunning.id} — ${nextRunning.description}` : ''}`,
          };
        } catch (e) {
          return { success: false, error: `update_task 失败: ${String(e)}` };
        }
      }
    });

    this.tools.set('get_task', {
      name: 'get_task',
      description: '查任务的当前状态和步骤进度. 用于跨 loop / 跨 session 恢复.',
      parameters: { task_id: '任务 id (必填)' },
      execute: async (args) => {
        const taskId = String(args.task_id || '').trim();
        if (!taskId) return { success: false, error: 'task_id 必填' };
        try {
          const { getTask } = await import('./task-state.js');
          const t = await getTask(taskId);
          if (!t) return { success: false, error: `任务 ${taskId} 未找到` };
          const lines = [
            `任务: ${t.id}`,
            `目标: ${t.goal}`,
            `状态: ${t.status}`,
            `branch: ${t.branch || '(未指定)'}`,
            `sessionKey: ${t.sessionKey || '(未指定)'}`,
            `创建: ${t.createdAt}`,
            `更新: ${t.updatedAt}`,
            ``,
            `步骤:`,
            ...t.steps.map((s) => `  ${s.status === 'done' ? '✅' : s.status === 'running' ? '🔄' : s.status === 'failed' ? '❌' : s.status === 'skipped' ? '⏭️' : '⏳'} ${s.id} — ${s.description}${s.resultSummary ? `\n     结果: ${s.resultSummary}` : ''}${s.error ? `\n     错误: ${s.error}` : ''}`),
          ];
          return { success: true, output: lines.join('\n') };
        } catch (e) {
          return { success: false, error: `get_task 失败: ${String(e)}` };
        }
      }
    });

    this.tools.set('list_tasks', {
      name: 'list_tasks',
      description: '列出最近 N 个任务 (默认 10). 用于多任务并行管理.',
      parameters: { limit: '可选, 默认 10' },
      execute: async (args) => {
        const limit = Number(args.limit) || 10;
        try {
          const { listTasks } = await import('./task-state.js');
          const tasks = await listTasks(limit);
          if (tasks.length === 0) {
            return { success: true, output: '当前没有任务. 用 create_task 创建一个.' };
          }
          const lines = tasks.map((t) => {
            const done = t.steps.filter((s) => s.status === 'done').length;
            const total = t.steps.length;
            return `${t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄'} ${t.id} — ${t.goal} (${done}/${total} steps, branch: ${t.branch || '-'})`;
          });
          return { success: true, output: `最近 ${tasks.length} 个任务:\n${lines.join('\n')}` };
        } catch (e) {
          return { success: false, error: `list_tasks 失败: ${String(e)}` };
        }
      }
    });

    // M3.3 (2026-06-17): 工具幂等性 — 显式 cache 防止重试时副作用执行两次
    // 设计: 在 registerTools 末尾 wrap 所有 this.tools, 每个调用走 cache:
    //   - 算 (toolName + JSON.stringify(args)) 的 hash
    //   - 命中 cache → 返缓存结果 (不重跑副作用, 关键对 write_file / edit_file / shell_exec)
    //   - 失败结果不缓存 (避免缓存 transient 错误)
    //   - 缓存容量 200 条, 超过就清空
    this.wrapToolsWithIdempotency();
  }

  /** M3.3: 工具结果缓存 — 防止 loop 重试时副作用 (写文件 / 改代码) 执行多次 */
  private idempotencyCache: Map<string, { result: any; ts: number }> = new Map();
  private readonly IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 分钟内同 (tool, args) 走 cache
  private readonly IDEMPOTENCY_MAX = 200;

  private wrapToolsWithIdempotency(): void {
    // 只 wrap 会产生副作用的工具 — 读类工具 (list_files, read_document, get_task) 不 wrap
    //   (让 LLM 拿到最新数据, 不会因为缓存读到旧 task 状态)
    const SIDE_EFFECT_TOOLS = new Set([
      'write_file', 'edit_file', 'shell_exec', 'git_commit', 'git_push', 'git_branch',
      'create_task', 'update_task',
    ]);
    for (const [name, tool] of this.tools.entries()) {
      if (!SIDE_EFFECT_TOOLS.has(name)) continue;
      const original = tool.execute;
      tool.execute = async (args: any) => {
        const key = `${name}|${JSON.stringify(args)}`;
        const cached = this.idempotencyCache.get(key);
        if (cached && Date.now() - cached.ts < this.IDEMPOTENCY_TTL_MS) {
          // 命中 — 加标记让 LLM 知道这是 cache (不会真执行副作用)
          return { ...cached.result, output: (cached.result.output || '') + '\n[↻ idempotency cache hit]' };
        }
        const result = await original(args);
        // 只缓存成功结果, 避免缓存 transient 错误
        if (result && result.success) {
          if (this.idempotencyCache.size >= this.IDEMPOTENCY_MAX) {
            this.idempotencyCache.clear();
          }
          this.idempotencyCache.set(key, { result, ts: Date.now() });
        }
        return result;
      };
    }
  }

  /** 清幂等性缓存 — 强制下次调用真正执行 (用于 agent 显式需要重新跑的场景) */
  clearIdempotencyCache(): void {
    this.idempotencyCache.clear();
  }

  private async registerP2PDocumentReceiver(): Promise<void> {
    await initDocumentReceiver();
  }

  private getToolDefinitions(): string {
    // M2.4 (2026-06-17): 缓存 tool 定义 — registerTools() 在构造时调一次, 此后不变
    if (this.cachedToolDefinitions) return this.cachedToolDefinitions;
    const defs: string[] = ['可用工具:'];
    for (const tool of this.tools.values()) {
      const params = Object.entries(tool.parameters).map(([k, v]) => `${k}: ${v}`).join(', ');
      defs.push(`- ${tool.name}(${params}) - ${tool.description}`);
    }
    this.cachedToolDefinitions = defs.join('\n');
    return this.cachedToolDefinitions;
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

  async prompt(input: string, options?: { onStream?: StreamCallback; signal?: AbortSignal; channelId?: string }): Promise<string> {
    this.minimaxAvailable = this.checkMinimax();
    this.currentChannelId = options?.channelId ?? this.currentChannelId;

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

    // M2.2 (2026-06-17): intent 分类 — prompt() 路径也跑 (跟 promptStream 对齐)
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.currentIntent = classifyIntent(input);
      this.currentIntentHint = intentHint(this.currentIntent);
    } catch (err) {
      console.warn('[PiAgent] classifyIntent in prompt() failed:', err);
      this.currentIntent = 'chitchat';
      this.currentIntentHint = '';
    }

    // P2: 解析当前 permission mode
    try {
      const { resolvePermissionMode } = await import('./permission-mode.js');
      this.currentPermissionMode = resolvePermissionMode();
    } catch (err) {
      console.warn('[PiAgent] resolvePermissionMode failed (non-fatal):', err);
      this.currentPermissionMode = 'default';
    }

    // M3.1 (2026-06-17): 跟 promptStream 一样, usePivotLoop 时走 pivotLoop 路径
    //   之前 prompt() 永远跑老 runReActLoop, CLI/web 行为不一致
    if (this.usePivotLoop) {
      try {
        const lr = await this.promptWithPivotLoop(input, undefined, options?.channelId);
        return lr.response || '';
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

    try {
      // 2026-06-16: runReActLoop 现在返回 { reply, aiFailed, aiFailureReason } — 这里只需 reply 字符串
      const loopResult = await this.runReActLoop(undefined, options?.signal);
      return loopResult.reply;
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

  async promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal, channelId?: string): Promise<string> {
    console.log(`[PiAgent.promptStream] ENTRY, channelId=${channelId}, input chars=${input.length}`);
    this.minimaxAvailable = this.checkMinimax();
    console.log(`[PiAgent.promptStream] minimaxAvailable=${this.minimaxAvailable}`);
    this.currentChannelId = channelId ?? this.currentChannelId;

    // 2026-06-18 (supervisor): web server 把 46K markedPrompt 喂过来
    //   (【本轮用户请求】\n<text>\n【请求结束】\n\n<contextHint>).
    //   整个 input 走下游, pivot loop 之前拿 47K buildContext 当 user message 发出去,
    //   模型撞 context window. 提取 userText 替代 input, contextHint 拼到 systemPrompt 末尾.
    const markerMatch = input.match(/【本轮用户请求】\s*([\s\S]*?)\s*【请求结束】/);
    const userText = markerMatch ? markerMatch[1].trim() : input;
    const contextHint = markerMatch ? input.replace(markerMatch[0], '').trim() : '';
    console.log(`[PiAgent.promptStream] marker matched=${!!markerMatch}, userText chars=${userText.length}, contextHint chars=${contextHint.length}`);

    this.messageHistory.push({
      role: 'user',
      content: userText
    });
    // 2026-06-18: web server 喂的 markedPrompt 外的 contextHint 拼到 system 末尾 (而不是当 user message)
    this.contextHintAddition = contextHint;

    onStream({ type: 'thinking', content: '🤔 开始思考...' });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(userText);
      this.messageHistory.push({ role: 'assistant', content: response });
      onStream({ type: 'done', content: '' });
      return response;
    }

    // P0 注入门: 缓存 onStream + signal, computeJudgmentGate 用 currentOnStream 广播 phase
    this.currentOnStream = onStream;
    this.currentSignal = signal ?? null;
    await this.computeJudgmentGate(userText);

    // M2.2 (2026-06-17): intent 分类 — 0 LLM 成本, 5 行 keyword 匹配
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.currentIntent = classifyIntent(userText);
      this.currentIntentHint = intentHint(this.currentIntent);
      if (this.currentIntent !== 'chitchat') {
        onStream({ type: 'phase', phase: 'intent_classified', detail: this.currentIntent, content: '' } as any);
      }
    } catch (err) {
      console.warn('[PiAgent] classifyIntent failed (non-fatal):', err);
      this.currentIntent = 'chitchat';
      this.currentIntentHint = '';
    }

    // P1.1: 异步跑 Auto-Compact (LLM 摘要, 仅在 budget 超限时触发, 失败静默)
    // 复用 computeJudgmentGate 的 onStream 广播 phase, 跟 judgment 注入门风格一致
    try {
      await this.maybeAutoCompact(onStream, signal);
    } catch (err) {
      console.warn('[PiAgent] maybeAutoCompact failed (non-fatal):', err);
    }

    // Bootstrap SessionStart: 收集项目 Context, 拼到 systemAddition 头部
    // (失败静默, 5s 限流防止循环)
    let bootstrapAddition = '';
    try {
      const ss = await onSessionStart({ channelId: this.currentChannelId || undefined });
      bootstrapAddition = ss.systemAddition || '';
    } catch (err) {
      console.warn('[PiAgent] onSessionStart failed (non-fatal):', err);
    }
    this.bootstrapAddition = bootstrapAddition;

    // P2: 解析当前 permission mode (BootstrapOptions > env BOLLOON_PERM_MODE > default)
    try {
      const { resolvePermissionMode } = await import('./permission-mode.js');
      this.currentPermissionMode = resolvePermissionMode();
    } catch (err) {
      console.warn('[PiAgent] resolvePermissionMode failed (non-fatal, using default):', err);
      this.currentPermissionMode = 'default';
    }

    this.promptStartTime = Date.now();

    // M3.1 (2026-06-17): 走 WorkflowPivotLoop (usePivotLoop: true)
    //   pivot loop 自带 quality scoring / 30 iter cap / complexity analysis — 比老 runReActLoop 鲁棒
    if (this.usePivotLoop) {
      let pivotResult = '';
      try {
        const lr = await this.promptWithPivotLoop(userText, undefined, channelId);
        pivotResult = lr.response || '';
        onStream({ type: 'done', content: '' });
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError') {
          console.log(`[chat] pivot aborted channel=${channelId}`);
        } else {
          console.error(`[chat] pivot 失败 channel=${channelId}:`, err);
          pivotResult = `[错误: pivot loop 失败] ${String(err?.message || err).slice(0, 300)}`;
          try { onStream({ type: 'error', content: pivotResult, tool: 'system' }); } catch {}
        }
      } finally {
        if (this.judgmentGateUsedIds.length > 0) {
          try { onStream({ type: 'used_judgments', usedIds: this.judgmentGateUsedIds, content: '' } as any); } catch {}
        }
        monitorAfterReply(userText, pivotResult);
        const stopStartTime = this.promptStartTime || Date.now();
        onStop({
          channelId: this.currentChannelId || 'unknown',
          durationMs: Date.now() - stopStartTime,
          usedJudgmentIds: [...this.judgmentGateUsedIds],
        }).catch((err) => console.warn('[PiAgent] onStop failed:', err));
        this.clearJudgmentGate();
        this.currentOnStream = null;
        this.currentSignal = null;
        this.bootstrapAddition = '';
        this.contextHintAddition = '';
        this.promptStartTime = 0;
      }
      return pivotResult;
    }

    // 2026-06-16: loop 自动重试 — runReActLoop 内部遇到 [AI 服务调用失败] sentinel 时,
    //   会设 aiFailed=true 并提前 break. 这里在外层重跑整个 loop (不是单次 LLM 调用),
    //   临时网络抖动 / 配额瞬时超限可自愈. 最多 3 次, 指数退避 1s/2s/4s.
    //   用户看到 status bar 显示 "自动重试中 X/N" — 不暴露按钮.
    const MAX_LOOP_RETRIES = 3;
    let attempt = 0;
    let result: string = '';
    let lastAiFailureReason = '';
    while (attempt <= MAX_LOOP_RETRIES) {
      try {
        const loopResult = await this.runReActLoop(onStream, signal);
        result = loopResult.reply;
        if (!loopResult.aiFailed) break; // 正常完成, 退出 retry 循环
        lastAiFailureReason = loopResult.aiFailureReason || 'AI 调用失败';
      } catch (err: any) {
        // abort 失败: 视作"已中断", 抛错让上层用 partial 兜底
        this.currentOnStream = null;
        this.currentSignal = null;
        throw err;
      }
      attempt++;
      if (attempt > MAX_LOOP_RETRIES) {
        console.warn(`[PiAgent] loop 自动重试 ${MAX_LOOP_RETRIES} 次后仍失败, 终止`);
        if (onStream) {
          onStream({ type: 'status', content: `⛔ loop 自动重试 ${MAX_LOOP_RETRIES} 次后仍失败: ${lastAiFailureReason}`, tool: 'system' });
        }
        result = lastAiFailureReason || 'AI 服务调用失败, 自动重试后仍不可用';
        break;
      }
      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.log(`[PiAgent] loop 自动重试 ${attempt}/${MAX_LOOP_RETRIES}, 等待 ${backoffMs}ms`);
      if (onStream) {
        onStream({ type: 'status', content: `↻ 自动重试 loop ${attempt}/${MAX_LOOP_RETRIES} (${(backoffMs / 1000).toFixed(0)}s 后)`, tool: 'system' });
      }
      // 中途 abort 也要响应
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        }, backoffMs);
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error('aborted during retry backoff'));
        };
        if (signal?.aborted) {
          clearTimeout(t);
          reject(new Error('aborted during retry backoff'));
          return;
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
      // 重试时要把这条 user message 从 history 里移除 (避免下一次 runReActLoop 又重复加入),
      // 因为 messageHistory.push({role:'user'}) 在 promptStream 顶部已经做过, 重跑 runReActLoop 不会重复 push,
      // 但 assistant 失败那条也别留 (留了会污染下一轮 LLM context).
      // 简化: 重试前 pop 一次 assistant (如果最后一条是 assistant)
      if (this.messageHistory.length > 0 && this.messageHistory[this.messageHistory.length - 1].role === 'assistant') {
        this.messageHistory.pop();
      }
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
      channelId: this.currentChannelId || 'unknown',
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

  async promptWithPivotLoop(input: string, config?: PivotLoopConfig, channelId?: string): Promise<LoopResult> {
    this.currentChannelId = channelId ?? this.currentChannelId;
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

    // M2.2 (2026-06-17): intent 分类 — pivot loop 也要拿到 hint
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.currentIntent = classifyIntent(input);
      this.currentIntentHint = intentHint(this.currentIntent);
    } catch (err) {
      console.warn('[PiAgent] classifyIntent in pivot failed:', err);
    }

    // M2.4: persona 缓存
    if (!this.cachedPersonaSection && this.persona) {
      this.cachedPersonaSection = `
角色描述: ${this.persona.description || '无'}
性格特点: ${this.persona.personality || '无'}
问候语: ${this.persona.greeting || '无'}
`;
    }

    const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${this.cachedPersonaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})
${this.currentIntentHint}

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
- 如果需要更多信息，继续调用工具${this.judgmentGateAddition}${this.contextHintAddition}`;

    // 2026-06-15: 把 currentOnStream 传给 loop, 让 step-timeline 在 pivot 循环里也能 emit step_start/done
    //   之前 loop.execute() 不接 streamCallback, 导致 step-timeline 只能看到老 runReActLoop 路径
    //   promptWithPivotLoop 路径 0 step events — UI 显示 timeline 但永远是空
    // 2026-06-17: 透传 signal 让 abort 工作 — loop.execute() 当前不接 signal 参数,
    //   所以 abort 行为通过 this.currentSignal 共享给 loop 内部读 (后续 M3.2 接 task plan 时一起加)
    const result = await loop.execute(input, llm, systemPrompt, this.currentOnStream ?? undefined);

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

  private async runReActLoop(onStream?: StreamCallback, signal?: AbortSignal): Promise<{ reply: string; aiFailed: boolean; aiFailureReason?: string }> {
    const llm = getMinimax();
    let iteration = 0;
    let finalResponse = '';
    let lastQualityScore = 0;
    let refineAttempts = 0;
    let consecutiveErrors = 0;
    // 2026-06-16 新增: 累计错误数 (跨工具, 兜底防 LLM 轮换工具名死循环)
    let totalErrors = 0;
    let lastFailedTool = ''; // 跟踪最近一次失败的 tool name
    let lastFailedToolCount = 0; // 最近失败工具的连续失败次数
    // 2026-06-16: AI sentinel 标志 — runReActLoop 返回 aiFailed=true,
    //   promptStream 据此自动重跑整个 loop 最多 N 次 (不是单次 LLM 重试)
    let aiFailed = false;
    let aiFailureReason = '';
    const MAX_CONSECUTIVE_ERRORS = 3;
    const MAX_SAME_TOOL_FAILURES = 3; // 同一工具连续失败 3 次, 强制让 LLM 给出最终答案

    // 发送循环开始的事件
    if (onStream) {
      onStream({ type: 'status', content: '🔄 开始 ReAct 循环...', tool: 'system' });
    }

    // React Harness: 循环开始 (重置 turn 计数 + 触发 harness sessionStart)
    // 失败静默 (fail-open), 不阻塞主循环
    try {
      await this.reactHarness.onSessionStart(this.currentChannelId || undefined);
    } catch (err) {
      console.warn('[PiAgent] reactHarness.onSessionStart failed (non-fatal):', err);
    }

    while (iteration < this.MAX_REACT_ITERATIONS) {
      iteration++;

      // 停止条件 1: max turns (fail-safe 10000, 正常任务永远跑不到)
      if (iteration >= this.MAX_REACT_ITERATIONS) {
        console.warn(`[PiAgent] 达到最大循环数 ${this.MAX_REACT_ITERATIONS}, 强制终止 (fail-safe)`);
        onStream?.({ type: 'error', content: `⏹️ 达到最大循环数 (${this.MAX_REACT_ITERATIONS}, fail-safe)`, tool: 'loop' });
        finalResponse = finalResponse || '(本轮 ReAct 循环达到最大步数, 强制结束)';
        break;
      }

      // 停止条件 2: signal.aborted (显式 abort / 用户中断)
      if (signal?.aborted) {
        console.warn('[PiAgent] runReActLoop aborted by signal');
        onStream?.({ type: 'error', content: '⏹️ 用户中断', tool: 'loop' });
        finalResponse = finalResponse || '(用户中断)';
        break;
      }

      // 2026-06-16 新增: 累计错误兜底 — 跨工具, 防 LLM 轮换工具名绕过 MAX_SAME_TOOL_FAILURES
      if (totalErrors >= this.MAX_TOTAL_ERRORS) {
        console.warn(`[PiAgent] 累计错误 ${totalErrors} >= ${this.MAX_TOTAL_ERRORS}, 强制终止 (防死循环)`);
        onStream?.({ type: 'error', content: `⛔ 累计 ${totalErrors} 次错误, 强制终止 (防止 LLM 死循环)`, tool: 'loop' });
        finalResponse = finalResponse || `(本轮 ReAct 循环累计 ${totalErrors} 次错误, 强制结束。请换个思路或简化任务重试。)`;
        break;
      }

      // 2026-06-16 新增: loop 内自动压缩 — token 超 80% 阈值时跑一次
      // compact 失败走 C 路径: 不强行 break, 让现有 60K 阈值兜底 (后面有检查)
      const compactThreshold = this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD * this.LOOP_COMPACT_RATIO;
      const estimatedTokensBefore = this.estimateHistoryTokens();
      if (estimatedTokensBefore > compactThreshold) {
        const tokensBeforeCompact = estimatedTokensBefore;
        console.log(`[PiAgent] loop 入口 token ${tokensBeforeCompact} > ${compactThreshold}, 触发自动压缩`);
        onStream?.({ type: 'status', content: `🗜️ loop 自动压缩 (token ${tokensBeforeCompact} > ${compactThreshold})`, tool: 'compactor' });
        try {
          await this.maybeAutoCompact(onStream, signal);
        } catch (compactErr) {
          // C 路径: compact 失败不 break, 让 token 阈值检查兜底
          console.warn(`[PiAgent] loop 内 maybeAutoCompact 失败 (non-fatal, 继续走 token 阈值):`, compactErr);
        }
      }

      // 停止条件 3: context overflow (compact 后还超, 强制终止)
      const estimatedTokens = this.estimateHistoryTokens();
      if (estimatedTokens > this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD) {
        console.warn(`[PiAgent] context overflow (${estimatedTokens} tokens > ${this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD})`);
        onStream?.({ type: 'error', content: `⏹️ 上下文溢出 (${estimatedTokens} tokens, 阈值 ${this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD})`, tool: 'loop' });
        finalResponse = finalResponse || '(本轮 ReAct 循环因上下文溢出终止)';
        break;
      }

      // 调试日志：显示每次循环开始
      console.log(`[PiAgent] 循环 ${iteration}/${this.MAX_REACT_ITERATIONS} 开始`);
      if (onStream) {
        onStream({ type: 'status', content: `🔄 循环 ${iteration}/${this.MAX_REACT_ITERATIONS}`, tool: 'loop' });
      }

      const context = this.buildContext();
      // M3.5 (2026-06-17): 也构造 messages 数组版本, 让 LLM 看到结构化 tool 角色
      //   buildContext() 把 history 序列化成字符串 — LLM 看不到 tool 调用的真实结果
      //   新版用 messages 数组直接喂给 LLM, 保留 role 语义 (user/assistant/tool/system)
      const messages = this.buildMessages();
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

      // M2.4: persona section 缓存 — persona 在 loadPersona() 时一次设定, 此后不变
      if (!this.cachedPersonaSection && this.persona) {
        this.cachedPersonaSection = `
角色描述: ${this.persona.description || '无'}
性格特点: ${this.persona.personality || '无'}
问候语: ${this.persona.greeting || '无'}
`;
      }
      const personaSection = this.cachedPersonaSection;

      const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${personaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})
${refineContext}
${this.currentIntentHint}

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
- 如果需要更多信息，继续调用工具${this.judgmentGateAddition}${this.contextHintAddition}`;

      // 3 个恢复机制 (Claude Code 论文 9-step pipeline 内部):
      //   1. max output token 升级 (最多 3 次, 每次 maxOutputTokens 翻倍)
      //   2. reactive compaction (prompt 估算超阈值, 跑压缩)
      //   3. prompt-too-long (LLM 报错 4xxx token 错误, 跑 reactive compaction 再试 1 次)
      // 失败静默: 全部重试失败 → 空 reply (上层用 no tool_use 终止)
      const response = await this.callLlmWithRecovery(llm, messages, systemPrompt, signal, onStream);
      const reply = (response.reply || '').trim();

      // 2026-06-16: 看到 [AI 服务调用失败] sentinel → 不再立即 break,
      // 而是设 aiFailed=true, 让外层 promptStream 自动重跑整个 loop 最多 N 次
      // (LLM API 401 / 网络错 / 配额满时, pi-ai 返回这个 prefix;
      //  自动 retry 兜底: 临时网络抖动可自愈, 真挂 N 次后才报失败)
      if (reply.startsWith('[AI 服务调用失败]')) {
        console.log(`[PiAgent] 收到 AI 错误 sentinel, 标记 aiFailed, 外层会自动重试整个 loop`);
        aiFailed = true;
        aiFailureReason = reply.length > 200 ? reply.substring(0, 200) : reply;
        if (onStream) {
          onStream({ type: 'status', content: `⚠️ AI 调用失败, 将自动重试整个 loop`, tool: 'system' });
        }
        break;
      }

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
          // 2026-06-15: step-timeline 状态机 — 开新节点
          onStream({
            type: 'step_start',
            content: `调用 ${toolCall.name}`,
            tool: toolCall.name,
            args: toolCall.args || {},
          });
        }

        const tool = this.tools.get(toolCall.name);
        if (!tool) {
          consecutiveErrors++;
          // 2026-06-16 新增: 未知工具也要累计 (LLM 幻觉高频场景)
          totalErrors++;
          const errorResult: ToolResult = { success: false, error: `未知工具: ${toolCall.name}` };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          console.warn(`[PiAgent] 未知工具: ${toolCall.name} (累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS})，跳过并继续`);
          continue;
        }

        // Bootstrap PreToolUse hook: 调工具前校验 (危险命令拦截)
        // 失败静默 — hook 自身挂掉 = 放行
        // P2: 透传 permissionMode (从 BootstrapOptions / env BOLLOON_PERM_MODE 解析)
        let toolToExecute = tool;
        try {
          const pre = await onPreToolUse({
            tool: toolCall.name,
            args: toolCall.args || {},
            permissionMode: this.currentPermissionMode,
          });
          if (!pre.allowed) {
            const deniedResult: ToolResult = {
              success: false,
              error: `PreToolUse 拒绝: ${pre.reason || '未通过安全校验'}`,
            };
            this.messageHistory.push({
              role: 'tool',
              content: JSON.stringify(deniedResult),
              toolResult: deniedResult,
            });
            this.logToHarness(toolCall.name, toolCall.args, deniedResult);
            if (onStream) {
              onStream({
                type: 'error',
                content: `🛡️ PreToolUse 拒绝 ${toolCall.name}: ${pre.reason || '安全校验失败'}`,
                tool: toolCall.name,
              });
              // 2026-06-15: step-timeline — 拦在 PreToolUse, 标 step_error
              onStream({
                type: 'step_error',
                content: `PreToolUse 拒绝 ${toolCall.name}`,
                tool: toolCall.name,
                error: pre.reason || '安全校验失败',
              });
            }
            console.warn(`[PiAgent] PreToolUse denied ${toolCall.name}: ${pre.reason}`);
            // 不调 tool.execute, 也不计 consecutiveErrors (这是用户级拒绝, 不是工具错)
            continue;
          }
        } catch (err) {
          console.warn('[PiAgent] onPreToolUse failed (non-fatal, allowing):', err);
        }

        // React Harness: 8-gate + builtin-guards 校验 (在 PreToolUse 之后, 串接双层)
        // 失败静默, 拒绝时不调 tool.execute
        try {
          const pre = await this.reactHarness.preToolCall(
            toolCall.name,
            toolCall.args || {},
            this.currentChannelId || undefined
          );
          if (!pre.allowed) {
            const deniedResult: ToolResult = {
              success: false,
              error: `Harness gate 拒绝 (${pre.details.rejectedBy}): ${pre.reason || '未通过安全校验'}`,
            };
            this.messageHistory.push({
              role: 'tool',
              content: JSON.stringify(deniedResult),
              toolResult: deniedResult,
            });
            this.logToHarness(toolCall.name, toolCall.args, deniedResult);
            if (onStream) {
              onStream({
                type: 'error',
                content: `🛡️ Harness ${pre.details.rejectedBy} 拒绝 ${toolCall.name}: ${pre.reason || '安全校验失败'}`,
                tool: toolCall.name,
              });
              // 2026-06-15: step-timeline — Harness gate 拒绝, 标 step_error
              onStream({
                type: 'step_error',
                content: `Harness 拒绝 ${toolCall.name}`,
                tool: toolCall.name,
                error: pre.reason || '安全校验失败',
              });
            }
            console.warn(`[PiAgent] Harness denied ${toolCall.name} (${pre.details.rejectedBy}): ${pre.reason}`);
            continue;
          }
        } catch (err) {
          console.warn('[PiAgent] reactHarness.preToolCall failed (non-fatal, allowing):', err);
        }

        try {
          const toolStart = Date.now();
          let result = await tool.execute(toolCall.args);
          const toolDurationMs = Date.now() - toolStart;
          console.log(`[PiAgent] 工具 ${toolCall.name} 执行完成: success=${result.success} (${toolDurationMs}ms)`);

          // PostToolUse 审计 hook: 写 audit log, 默认 continue
          try {
            await onPostToolUse({
              tool: toolCall.name,
              args: toolCall.args || {},
              result: {
                success: result.success,
                output: result.output?.substring(0, 500),
                error: result.error,
              },
              durationMs: toolDurationMs,
            });
          } catch (postErr) {
            console.warn('[PiAgent] onPostToolUse failed (non-fatal):', postErr);
          }

          // Context router: 拿最近一次 preToolCall 算的 hint, 拼到 tool result messageHistory
          // (LLM 下次看到 tool result 时, 能"记得"这次调用的安全约束)
          const routeHint = this.reactHarness.getLastRouteHint();
          if (routeHint && routeHint.systemAddition) {
            this.messageHistory.push({
              role: 'system',
              content: `[Harness Router Hint: ${routeHint.reason}]\n${routeHint.systemAddition}`,
            });
            this.reactHarness.clearRouteHint();
          }

          // React Harness: post-tool call (output 审计: secret leak 等)
          // 拒绝时 result.output 含敏感 → 替换为 generic message, 不污染 messageHistory
          try {
            const post = await this.reactHarness.postToolCall(
              toolCall.name,
              String(result.output || ''),
              this.currentChannelId || undefined
            );
            if (!post.allowed) {
              if (onStream) {
                onStream({
                  type: 'error',
                  content: `🛡️ Harness output 拒绝 ${toolCall.name}: ${post.reason || '输出含敏感信息'}`,
                  tool: toolCall.name,
                });
              }
              console.warn(`[PiAgent] Harness output denied ${toolCall.name}: ${post.reason}`);
              // 替换 result: success 仍保留 (tool 本身没错), 但 output 改成 generic
              // 这样 LLM 下轮看 output 不会拿到秘密, 但 success 标志让它知道 "工具执行了"
              result = {
                ...result,
                output: `[harness output gate: output 含敏感内容, 已屏蔽. 原因: ${post.reason || 'unknown'}]`,
                _harnessDenied: true,
              } as typeof result;
            }
          } catch (err) {
            console.warn('[PiAgent] reactHarness.postToolCall failed (non-fatal, allowing):', err);
          }

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
              // 2026-06-15: step-timeline 状态机 — 关闭当前节点 (成功)
              onStream({
                type: 'step_done',
                content: `${toolCall.name} 执行成功`,
                tool: toolCall.name,
                success: true,
                output: result.output,
              });
            } else {
              onStream({ type: 'error', content: `❌ ${toolCall.name} 执行失败: ${result.error}`, tool: toolCall.name });
              // 2026-06-15: step-timeline 状态机 — 关闭当前节点 (失败)
              onStream({
                type: 'step_error',
                content: `${toolCall.name} 执行失败`,
                tool: toolCall.name,
                error: result.error,
              });
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
            // 2026-06-16 新增: 累计错误 (跨工具, 兜底防 LLM 轮换工具名死循环)
            totalErrors++;
            // 跟踪同一工具连续失败次数
            if (toolCall.name === lastFailedTool) {
              lastFailedToolCount++;
            } else {
              lastFailedTool = toolCall.name;
              lastFailedToolCount = 1;
            }
            console.warn(`[PiAgent] 工具 ${toolCall.name} 执行失败 (${lastFailedToolCount}/${MAX_SAME_TOOL_FAILURES}, 累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS}): ${result.error}`);

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
          // 2026-06-16 新增: 异常分支也要累计
          totalErrors++;
          const errorResult: ToolResult = { success: false, error: String(execError) };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          console.error(`[PiAgent] 工具执行异常 (累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS}): ${execError}`);
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
          reply.includes('tool =>') || reply.includes('[TOOL_CALL]') ||
          // 2026-06-15 修: 兼容 LLM 用 XML 标签输出 tool call (<shell_exec>...</shell_exec>)
          //   这时 parseToolCall 失败, 至少要让 loop 继续
          /<\w+>[\s\S]*?<\/\w+>/.test(reply);
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

    // React Harness: 循环结束
    try {
      await this.reactHarness.onSessionEnd();
    } catch (err) {
      console.warn('[PiAgent] reactHarness.onSessionEnd failed (non-fatal):', err);
    }

    // 2026-06-16: 暴露 aiFailed 标志 — promptStream 据此决定是否自动重试整个 loop
    return { reply: finalResponse, aiFailed, aiFailureReason: aiFailureReason || undefined };
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
    // P1 接入: 同步跑前 3 层压缩 (Budget Reduction / Snip / Microcompact)
    // 异步层 (Context Collapse / Auto-Compact) 在 promptStream 入口处单独跑 (用 LLM)
    // 失败静默: 任何 stage 抛错 → 走老 slice(-10) 逻辑
    //
    // P1.2: 如果 maybeAutoCompact 算过 Context Collapse 投影, 用 this.projectedHistory (读时投影, 非破坏)
    const source = this.projectedHistory ?? this.messageHistory;
    const recentMessages = this.compressHistorySync(source).slice(-10);
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

  /**
   * M3.5 (2026-06-17): 把 history 转成 messages 数组, 给 llm.chat() 用.
   *   不再用 buildContext() 把所有 role 压成字符串 — LLM 看不到 tool 调用结果.
   *   messages 数组保留 role 语义, tool role 单独传递, LLM 能看到完整 tool 结果.
   *
   * 取最近 N 条, 同步压缩前 3 层 (跟 buildContext 同步).
   * 跳过 projectedHistory 路径 — messages 数组必须真实, 不能用投影.
   */
  private buildMessages(): Array<{ role: string; content: string }> {
    try {
      const recentMessages = this.compressHistorySync(this.messageHistory).slice(-15);
      const out: Array<{ role: string; content: string }> = [];
      for (const m of recentMessages) {
        const role = m.role;
        let content = m.content;
        // tool role: 用 toolResult 序列化 (跟 buildContext 一样)
        if (role === 'tool') {
          const result = (m as any).toolResult ? JSON.stringify((m as any).toolResult) : content;
          content = `[工具结果] ${result}`;
        }
        // system role (router hint 等) 直接保留
        if (role === 'system') {
          out.push({ role: 'system', content });
          continue;
        }
        // assistant / user / tool 直接转
        if (role === 'user' || role === 'assistant' || role === 'tool') {
          out.push({ role, content });
        }
      }
      return out;
    } catch (err) {
      console.warn('[PiAgent] buildMessages failed (silent, falling back to text):', err);
      // 退化: 用 buildContext 字符串包装成单 user message
      return [{ role: 'user', content: this.buildContext() }];
    }
  }

  /**
   * 估算 messageHistory 的 token 数 (4 字符 ≈ 1 token, 与 context-compaction 同步).
   * 失败静默: 任何异常 → 0 (不阻塞)
   */
  private estimateHistoryTokens(): number {
    try {
      const { estimateTokens } = require('../context-compaction/index.js') as typeof import('../context-compaction/index.js');
      return estimateTokens(this.messageHistory as any);
    } catch {
      return 0;
    }
  }

  /**
   * 3 个恢复机制合一:
   *   1. max output token 升级: 最多 3 次, 每次 maxOutputTokens 翻倍 (如果 llm.chat 支持)
   *   2. reactive compaction: 估算 > 80% 阈值, 跑 sync compressHistorySync + 必要时 maybeAutoCompact
   *   3. prompt-too-long: LLM 报错 4xxx token 错误, 跑 reactive compaction 再试 1 次
   *
   * 失败静默: 全部失败 → 返回空 reply, 让上层 no-tool_use 终止
   */
  private async callLlmWithRecovery(
    llm: any,
    contextOrMessages: string | Array<{ role: string; content: string }>,
    systemPrompt: string,
    signal: AbortSignal | undefined,
    onStream?: (chunk: any) => void
  ): Promise<{ reply: string }> {
    // Reactive compaction 预检: 估算 token 超 80% 阈值, 跑一次
    const estimated = this.estimateHistoryTokens();
    if (estimated > this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD * 0.8) {
      console.warn(`[PiAgent] reactive compaction pre-check (${estimated} tokens > 80% threshold)`);
      onStream?.({ type: 'status', content: '⚠️ reactive compaction 预检触发', tool: 'recovery' });
      try {
        const compacted = this.compressHistorySync(this.messageHistory);
        this.messageHistory = compacted;
        if (this.estimateHistoryTokens() > this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD * 0.8) {
          await this.maybeAutoCompact(onStream, signal);
        }
      } catch (err) {
        console.warn('[PiAgent] reactive compaction pre-check failed:', err);
      }
    }

    // 错误分级 (M1.3, 2026-06-17):
    //   - 401/403/400 (认证/请求错误): 不重试, 直接 fail-fast
    //   - 429 (rate limit): 重试 2 次, 指数退避
    //   - 5xx (上游错误): 重试 2 次, 指数退避
    //   - network (ECONNRESET / fetch failed / abort/timeout): 重试 2 次
    //   - 4xx prompt-too-long: 走 reactive compaction
    // 这样以前所有错误都触发整个 runReActLoop 重跑(浪费 token),现在 4xx 直接失败
    //   让上层把失败原因广播给用户,而不是闷在 loop 里 retry 3 次后给空回复
    const classifyError = (err: any): 'auth' | 'rate_limit' | 'server' | 'network' | 'prompt_too_long' | 'other' => {
      const msg = String(err?.message || err || '');
      // 401/403: 认证失败
      if (/401|unauthor|invalid api key|api_key|forbidden|403/i.test(msg)) return 'auth';
      // 400 prompt-too-long
      if (/token|too long|exceed|length|context|4000|413/i.test(msg)) return 'prompt_too_long';
      // 429 rate limit
      if (/429|rate.?limit|too many requests/i.test(msg)) return 'rate_limit';
      // 5xx
      if (/5\d\d|internal server|bad gateway|service unavailable|gateway timeout|cloudflare|502|503|504/i.test(msg)) return 'server';
      // network
      if (/econnreset|econnrefused|enotfound|etimedout|fetch failed|network|aborted|timeout/i.test(msg)) return 'network';
      return 'other';
    };

    const isRetryable = (cls: ReturnType<typeof classifyError>) =>
      cls === 'rate_limit' || cls === 'server' || cls === 'network' || cls === 'prompt_too_long';
    const maxAttempts = (cls: ReturnType<typeof classifyError>) => isRetryable(cls) ? 3 : 1;
    const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000); // 1s, 2s, 4s, 8s cap

    let lastErr: any = null;
    let lastClass: ReturnType<typeof classifyError> = 'other';
    for (let attempt = 0; attempt < 4; attempt++) {  // 最多 4 次尝试
      try {
        // M3.5 (2026-06-17): 传 messages 数组 (如果 contextOrMessages 是数组) 或字符串
        //   数组版让 LLM 看到结构化的 user/assistant/tool role, 而不是把 history 拼成单字符串
        const response = await llm.chat(contextOrMessages, systemPrompt, signal);
        return { reply: response.reply || '' };
      } catch (err: any) {
        // 用户主动 abort: 不重试, 立即抛
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        lastErr = err;
        lastClass = classifyError(err);
        const errMsg = String(err?.message || err || '').slice(0, 200);
        const attempts = maxAttempts(lastClass);
        if (attempt + 1 >= attempts) {
          console.warn(`[PiAgent] LLM 调用失败, 不再重试 (class=${lastClass}, attempt=${attempt + 1}/${attempts}): ${errMsg}`);
          break;
        }
        console.warn(`[PiAgent] LLM 调用失败 (class=${lastClass}, attempt=${attempt + 1}/${attempts}), ${backoffMs(attempt)}ms 后重试: ${errMsg}`);
        onStream?.({ type: 'status', content: `⚠️ LLM 调用失败 (${lastClass}), 重试 ${attempt + 2}/${attempts}...`, tool: 'recovery' });
        if (lastClass === 'prompt_too_long') {
          try {
            await this.maybeAutoCompact(onStream, signal);
          } catch (compactionErr) {
            console.warn('[PiAgent] reactive compaction on prompt-too-long failed:', compactionErr);
          }
          // 重新生成 context (重试 prompt_too_long 时重建 messages — 包含压缩后的 history)
          if (Array.isArray(contextOrMessages)) {
            contextOrMessages = this.buildMessages();
          } else {
            contextOrMessages = this.buildContext();
          }
        } else {
          // 指数退避
          await new Promise<void>((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
    }
    // 失败: 返回结构化错误 reply (而不是空字符串), 上层可识别 + UI 可显示
    const errMsg = String(lastErr?.message || lastErr || '').slice(0, 300);
    const userMsg = lastClass === 'auth'
      ? `[AI 服务调用失败] 认证错误: ${errMsg}\n请检查 API key 配置 (env: OPENAI_API_KEY / ANTHROPIC_API_KEY 等)`
      : lastClass === 'rate_limit'
      ? `[AI 服务调用失败] 上游限流 (429): ${errMsg}\n请稍后重试`
      : lastClass === 'server'
      ? `[AI 服务调用失败] 上游错误: ${errMsg}\n已重试 2 次仍失败, 可稍后重试`
      : lastClass === 'network'
      ? `[AI 服务调用失败] 网络错误: ${errMsg}\n请检查网络连接`
      : `[AI 服务调用失败] ${errMsg}`;
    console.warn(`[PiAgent] callLlmWithRecovery 全部失败 (class=${lastClass}): ${errMsg}`);
    return { reply: userMsg };
  }

  /**
   * 同步压缩: 跑前 3 层 (Budget Reduction / Snip / Microcompact).
   * Context Collapse / Auto-Compact 是 async, 不在 buildContext 同步链里跑.
   * 失败静默: 任何 stage 抛错 → 返回原 history.
   */
  private compressHistorySync(history: Message[]): Message[] {
    try {
      // context-compaction 的 Message 与 pi-sdk 的 Message 字段兼容
      // 这里用 any cast 跳过 structural type 严格校验 (避免双向 import)
      let h: any = history;
      const r1 = budgetReduce(h);
      h = r1.history;
      const r2 = snip(h);
      h = r2.history;
      const r3 = microcompact(h);
      h = r3.history;
      return h as Message[];
    } catch (err) {
      console.warn('[PiAgent] compressHistorySync failed (silent, using original):', err);
      return history;
    }
  }

  /**
   * P1.1: 异步跑 Auto-Compact (LLM 摘要).
   * 入口: promptStream 入口, 在 computeJudgmentGate 之后, onSessionStart 之前.
   *
   * 逻辑:
   *   1. 跑完整 compactPipeline (5 层, 异步)
   *   2. 第 5 层 (Auto-Compact) 需要 LLM, 通过 getMinimax().chat 注入
   *   3. 如果 budgetGate 不超限, 5 层短路在前 3 层, 不会调 LLM → 零开销
   *   4. 失败静默: 任何异常 → console.warn + 保留原 messageHistory
   *
   * onStream 广播: 跟 computeJudgmentGate 风格一致 (phase 事件供 UI timeline 显示)
   */
  private async maybeAutoCompact(
    onStream?: (chunk: any) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.messageHistory.length < 10) return;  // 历史太短, 不值得压

    onStream?.({ type: 'status', content: '🗜️ 评估是否需要压缩上下文...', tool: 'compactor' });

    // 注入 LLM (用 getMinimax().chat, 与 judgment 注入门 / ReAct 循环同一来源)
    // 给 Context Collapse (虚拟投影) 和 Auto-Compact (摘要) 共用
    const llm = getMinimax();
    const llmChat = async (systemPrompt: string, userPrompt: string): Promise<string> => {
      const r = await llm.chat(userPrompt, systemPrompt, signal);
      return r.reply;
    };

    const { compactPipeline, isContextCollapseEnabled } = await import('../context-compaction/index.js');
    const result = await compactPipeline(this.messageHistory as any, {
      maxTokens: 8000,
      llmChat,
      collapseLlmChat: llmChat,  // P1.2: Context Collapse 投影也用同一 LLM
      cacheScope: this.currentChannelId || 'default',
    });

    if (result.compacted && result.history.length < this.messageHistory.length) {
      const saved = this.messageHistory.length - result.history.length;
      const stagesApplied = result.stages.filter((s) => s.applied).map((s) => s.stage).join(' → ');
      onStream?.({
        type: 'status',
        content: `🗜️ 上下文压缩: ${stagesApplied || 'no-op'} | 节省 ${saved} 条 (剩余 ${result.history.length}, collapse=${isContextCollapseEnabled() ? 'on' : 'off'})`,
        tool: 'compactor',
      });
      // 关键: 第 4 层 (Context Collapse) 是读时投影 (非破坏)
      //       第 5 层 (Auto-Compact) 是破坏性折叠
      //       这里用 if-else 区分: collapse on → 仅 buildContext 用; collapse off → 真更新
      if (isContextCollapseEnabled()) {
        this.projectedHistory = result.history as Message[];  // buildContext 用
        // messageHistory 不变 (非破坏)
      } else {
        this.messageHistory = result.history as Message[];  // 真破坏性更新
        this.projectedHistory = null;
      }
    }
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
      // 2026-06-15 修: 兼容 LLM 输出的 XML 格式 <tool_name>...<arg>value</arg>...</tool_name>
      //   实际 LLM 习惯: <shell_exec>\n<command>ls</command>\n<args>["-la", "..."]</args>\n</shell_exec>
      /<(\w+)>([\s\S]*?)<\/\1>/,
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
        } else if (rawArgs && /<\w+>[\s\S]*<\/\w+>/.test(rawArgs)) {
          // 2026-06-15 修: XML 格式, 解析内嵌子标签 <argname>value</argname>
          //   例: <command>ls</command>\n<args>["-la","~/.bolloon/skills"]</args>
          const xmlArgPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
          let xmlMatch: RegExpExecArray | null;
          while ((xmlMatch = xmlArgPattern.exec(rawArgs)) !== null) {
            const argName = xmlMatch[1];
            const argValue = xmlMatch[2].trim();
            if (argName && argValue) {
              args[argName] = argValue;
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

  setCurrentChannelId(channelId: string): void {
    this.currentChannelId = channelId;
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
