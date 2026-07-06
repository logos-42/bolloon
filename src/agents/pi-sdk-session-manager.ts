import * as fs from 'fs/promises';
import * as path from 'path';
import type { PersonaDoc } from '../social/heartbeat.js';
import type { SessionChannel, SessionMessage, SocialSessionProvider } from '../social/heartbeat.js';
import type {
  GlobalSharedContextManager,
  CooperationType,
  CooperationTask,
  AgentInfo,
  GlobalSharedContext
} from '../social/global-shared-context.js';
import { getGlobalSharedContext } from '../social/global-shared-context.js';
import { Session, saveSession, loadSession, type StoredSession } from '@bolloon/constraint-runtime';
import type { PiSessionState, PiMemory } from './pi-sdk-types.js';

const SHARED_SESSION_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');
const PERSONA_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');

/**
 * PiSessionManager — 负责:
 *   - 加载 / 持久化 persona
 *   - 加载 / 持久化 channels (含 P2P 远端 channel)
 *   - 维护 working memory + summarized memory + file context
 *   - token 用量累加
 *   - shared context (addUserAction / addSharedKnowledge / createCooperation)
 *
 * 从 pi-sdk.ts 抽出 (2026-07-06) — 业务逻辑独立, 不依赖 PiAgentSession 的 LLM 循环.
 */
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

  async updateAgentStatusInRegistry(status: 'active' | 'idle' | 'busy'): Promise<void> {
    await this.sharedContext.updateAgentStatus(this.agentId, status);
  }
}
