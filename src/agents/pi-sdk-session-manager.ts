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
import { SHARED_SESSION_PATH } from '../web/server-types.js';
const PERSONA_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');

/** agentId 的安全化 (与 persona-loader 同口径) */
function safePersonaScope(id: string): string {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** 某个 agent 自己的 persona.json 路径 (persona/<agentId>/persona.json) */
export function personaPathFor(scopeId?: string): string {
  const root = process.env.HOME || '/tmp';
  if (!scopeId) return PERSONA_PATH;
  return path.join(root, '.bolloon', 'persona', safePersonaScope(scopeId), 'persona.json');
}

/** 该 agent 名下有没有身份文档目录 (persona/<agentId>/*.md) */
export async function hasAgentIdentityDocs(scopeId?: string): Promise<boolean> {
  if (!scopeId) return false;
  const dir = path.dirname(personaPathFor(scopeId));
  try {
    const files = await fs.readdir(dir);
    return files.some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * persona 到底该从哪来 (2026-10-01, 用户报「所有回复都是一个智能体人格」)。
 *
 * 真因: 原先每个 session 都读**全局** `~/.bolloon/persona.json` (你那份是 2026-08-10 的老
 * `set persona` 留下的 `{name: 小宝}`) ⇒ 不管切到哪个 agent, 身份名都是「小宝」✗,
 * 把按 agent 的 6 份身份文档盖住了。
 *
 * 现在的口径 (三条, 优先级从上到下):
 *   1) 该 agent 自己的 `persona/<agentId>/persona.json` ⇒ 用它 (想给某个 agent 单独设 persona 走这里);
 *   2) 该 agent 有身份文档目录 (persona/<agentId>/*.md) ⇒ **返回 null** —— 身份由那些文档承担,
 *      不再套用全局那份 (这正是用户的情况);
 *   3) 没有 scope, 或该 agent 什么文档都没有 ⇒ 回落全局 persona.json (老的默认 agent 路径保持兼容)。
 */
export async function resolvePersonaSource(scopeId?: string): Promise<
  { kind: 'scoped' | 'docs' | 'global'; path: string } | { kind: 'none'; path: string }
> {
  if (scopeId) {
    const scoped = personaPathFor(scopeId);
    try {
      await fs.access(scoped);
      return { kind: 'scoped', path: scoped };
    } catch { /* 没有该 agent 自己的 persona.json */ }
    if (await hasAgentIdentityDocs(scopeId)) return { kind: 'docs', path: scoped };
  }
  try {
    await fs.access(PERSONA_PATH);
    return { kind: 'global', path: PERSONA_PATH };
  } catch {
    return { kind: 'none', path: PERSONA_PATH };
  }
}

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
  /** 2026-10-01: persona 归属的 agent (channel 的 agentId); 空 = 老行为 (全局 persona.json) */
  private personaScopeId?: string;

  constructor(agentId: string, cwd: string, personaScopeId?: string) {
    this.cwd = cwd;
    this.sessionDir = path.join(cwd, '.port_sessions');
    this.agentId = agentId;
    this.personaScopeId = personaScopeId ? String(personaScopeId) : undefined;

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

  /** 让调用方在拿到 channel 的 agentId 后再定 persona 归属 (幂等) */
  setPersonaScope(scopeId?: string): void {
    this.personaScopeId = scopeId ? String(scopeId) : undefined;
  }

  private async loadPersona(): Promise<PersonaDoc | null> {
    try {
      const src = await resolvePersonaSource(this.personaScopeId);
      // kind='docs' ⇒ 该 agent 有身份文档, 身份不由 persona.json 承担 ⇒ 返回 null (不套全局那份)
      if (src.kind === 'docs' || src.kind === 'none') return null;
      const data = await fs.readFile(src.path, 'utf-8');
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
    // 2026-10-01: 按 agent 写回 —— 有 scope 就写 persona/<agentId>/persona.json,
    // 否则写全局 (不再让某个 agent 的 set_persona 把全局那份改掉)
    await fs.writeFile(personaPathFor(this.personaScopeId), JSON.stringify(persona, null, 2));
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
