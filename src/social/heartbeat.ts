import * as fs from 'fs/promises';
import * as path from 'path';

export interface PersonaDoc {
  name: string;
  description: string;
  capabilities: string[];
  personality: string;
  greeting: string;
  interests: string[];
}

export interface SessionChannel {
  id: string;
  name: string;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
  peerId?: string;
  peerDid?: string;
  peerName?: string;
}

export interface SessionMessage {
  id: string;
  type: 'user' | 'ai' | 'peer';
  content: string;
  sender: 'self' | 'peer';
  timestamp: string;
  agentId?: string;
}

export interface DiscoveredAgent {
  did: string;
  name: string;
  cid?: string;
  ipnsName?: string;
  peerId?: string;
  lastSeen: number;
  lastMessage?: string;
  persona?: PersonaDoc;
}

const SHARED_SESSION_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');
const PERSONA_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');
const DISCOVERED_AGENTS_PATH = path.join(SHARED_SESSION_PATH, 'discovered-agents.json');

export interface SocialSessionProvider {
  getPersona(): PersonaDoc | null;
  addMessage(channelId: string, message: SessionMessage): Promise<void>;
  getChannelMessages(channelId: string): Promise<SessionMessage[]>;
  createChannel(name: string, peerInfo?: { peerId?: string; peerDid?: string; peerName?: string }): Promise<SessionChannel>;
  getOrCreatePeerChannel(peerDid: string, peerName: string): Promise<SessionChannel>;
  setChannelInfo(channelId: string, info: Partial<SessionChannel>): Promise<void>;
  getAllChannels(): SessionChannel[];
}

class LocalSessionManager implements SocialSessionProvider {
  private channels: Map<string, SessionChannel> = new Map();
  private channelsPath: string;
  private persona: PersonaDoc | null = null;
  private initialized: boolean = false;

  constructor() {
    this.channelsPath = path.join(SHARED_SESSION_PATH, 'local-channels.json');
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

  getPersona(): PersonaDoc | null {
    return this.persona;
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

export class DiscoveredAgentsManager {
  private agents: Map<string, DiscoveredAgent> = new Map();
  private agentsPath: string;

  constructor() {
    this.agentsPath = DISCOVERED_AGENTS_PATH;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(SHARED_SESSION_PATH, { recursive: true });
    await this.loadAgents();
  }

  private async loadAgents(): Promise<void> {
    try {
      const data = await fs.readFile(this.agentsPath, 'utf-8');
      const agentsArray = JSON.parse(data) as DiscoveredAgent[];
      this.agents.clear();
      for (const agent of agentsArray) {
        this.agents.set(agent.did, agent);
      }
    } catch {
      this.agents.clear();
    }
  }

  async saveAgents(): Promise<void> {
    const agentsArray = Array.from(this.agents.values());
    await fs.writeFile(this.agentsPath, JSON.stringify(agentsArray, null, 2));
  }

  addAgent(agent: DiscoveredAgent): void {
    agent.lastSeen = Date.now();
    this.agents.set(agent.did, agent);
    this.saveAgents();
  }

  updateAgent(did: string, updates: Partial<DiscoveredAgent>): void {
    const agent = this.agents.get(did);
    if (agent) {
      Object.assign(agent, updates, { lastSeen: Date.now() });
      this.saveAgents();
    }
  }

  getAgent(did: string): DiscoveredAgent | undefined {
    return this.agents.get(did);
  }

  getAllAgents(): DiscoveredAgent[] {
    return Array.from(this.agents.values());
  }

  getOnlineAgents(timeoutMs: number = 5 * 60 * 1000): DiscoveredAgent[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      a => now - a.lastSeen < timeoutMs
    );
  }

  removeAgent(did: string): void {
    this.agents.delete(did);
    this.saveAgents();
  }
}

export interface HeartbeatConfig {
  intervalMs: number;
  peerDiscoveryEnabled: boolean;
  ipnsResolveEnabled: boolean;
  autoSocialEnabled: boolean;
  greetingMessage?: string;
}

export class SocialHeartbeat {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private config: HeartbeatConfig;
  private sessionProvider: SocialSessionProvider;
  private agentsManager: DiscoveredAgentsManager;
  private onAgentDiscovered?: (agent: DiscoveredAgent) => void;
  private onSocialMessage?: (fromDid: string, message: string, channelId: string) => void;
  private onGreetingSent?: (toDid: string, channelId: string) => void;
  private currentPeerDids: Set<string> = new Set();
  private greetingMessage: string;

  constructor(
    sessionProvider: SocialSessionProvider,
    agentsManager: DiscoveredAgentsManager,
    config: Partial<HeartbeatConfig> = {}
  ) {
    this.config = {
      intervalMs: config.intervalMs || 30000,
      peerDiscoveryEnabled: config.peerDiscoveryEnabled ?? true,
      ipnsResolveEnabled: config.ipnsResolveEnabled ?? true,
      autoSocialEnabled: config.autoSocialEnabled ?? false,
      greetingMessage: config.greetingMessage
    };
    this.sessionProvider = sessionProvider;
    this.agentsManager = agentsManager;
    this.greetingMessage = this.config.greetingMessage || '你好！我是 Bolloon Agent，很高兴认识你！';
  }

  async start(): Promise<void> {
    await this.agentsManager.initialize();

    if (this.intervalId) return;

    console.log(`[Heartbeat] 启动社交心跳机制，间隔 ${this.config.intervalMs}ms`);

    this.intervalId = setInterval(async () => {
      await this.beat();
    }, this.config.intervalMs);

    await this.beat();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Heartbeat] 已停止');
    }
  }

  private async beat(): Promise<void> {
    try {
      await this.discoverPeers();
      await this.cleanupStaleAgents();
      if (this.config.autoSocialEnabled) {
        await this.processAutoSocial();
      }
    } catch (err) {
      console.error('[Heartbeat] Beat error:', err);
    }
  }

  private async discoverPeers(): Promise<void> {
    if (!this.config.peerDiscoveryEnabled) return;

    try {
      const comm = (global as any).hyperswarmComm;
      if (!comm) {
        return;
      }

      const connections = comm.getConnections?.() || [];
      const peerIds = connections.map((c: any) => c.publicKey).filter(Boolean);

      for (const peerId of peerIds) {
        const did = `did:key:${peerId.substring(0, 16)}`;

        if (!this.currentPeerDids.has(did)) {
          this.currentPeerDids.add(did);
          await this.handleNewPeer(did, peerId);
        }
      }
    } catch (err) {
    }
  }

  private async handleNewPeer(did: string, peerId: string): Promise<void> {
    const existingAgent = this.agentsManager.getAgent(did);
    if (existingAgent) {
      this.agentsManager.updateAgent(did, { lastSeen: Date.now() });
    } else {
      const newAgent: DiscoveredAgent = {
        did,
        name: `Agent-${did.substring(10, 18)}`,
        peerId,
        lastSeen: Date.now()
      };

      if (this.config.ipnsResolveEnabled) {
        await this.resolveAgentIPNS(newAgent);
      }

      this.agentsManager.addAgent(newAgent);
      console.log(`[Heartbeat] 发现新智能体: ${newAgent.name} (${did.substring(0, 20)}...)`);

      this.onAgentDiscovered?.(newAgent);

      if (this.config.autoSocialEnabled) {
        await this.sendGreeting(newAgent);
      }
    }
  }

  private async resolveAgentIPNS(agent: DiscoveredAgent): Promise<void> {
    if (!agent.ipnsName) return;

    try {
      const { IpfsClient } = await import('@diap/sdk');
      const ipfs = new IpfsClient('http://127.0.0.1:5001', null);

      const cid = await ipfs.resolveIpns(agent.ipnsName);
      if (cid) {
        agent.cid = cid;
        const content = await ipfs.get(cid);
        const doc = JSON.parse(content);
        agent.name = doc.name || agent.name;
        if (doc.persona) {
          agent.persona = doc.persona;
        }
      }
    } catch (err) {
    }
  }

  private async processAutoSocial(): Promise<void> {
    const onlineAgents = this.agentsManager.getOnlineAgents();

    for (const agent of onlineAgents) {
      const channel = await this.sessionProvider.getOrCreatePeerChannel(agent.did, agent.name);
      const messages = await this.sessionProvider.getChannelMessages(channel.id);

      if (messages.length === 0 && !agent.lastMessage) {
        await this.sendGreeting(agent);
      }
    }
  }

  private async sendGreeting(agent: DiscoveredAgent): Promise<void> {
    try {
      const channel = await this.sessionProvider.getOrCreatePeerChannel(agent.did, agent.name);
      const persona = this.sessionProvider.getPersona();

      const greeting = persona
        ? `${persona.greeting || this.greetingMessage}\n\n我是 ${persona.name}，${persona.description}`
        : this.greetingMessage;

      await this.sendToAgent(agent, greeting);

      const message: SessionMessage = {
        id: crypto.randomUUID(),
        type: 'ai',
        content: greeting,
        sender: 'self',
        timestamp: new Date().toISOString()
      };

      await this.sessionProvider.addMessage(channel.id, message);
      agent.lastMessage = greeting;
      this.agentsManager.updateAgent(agent.did, { lastMessage: greeting });

      this.onGreetingSent?.(agent.did, channel.id);
      console.log(`[Heartbeat] 已向 ${agent.name} 发送问候语`);
    } catch (err) {
      console.error(`[Heartbeat] 发送问候失败 to ${agent.name}:`, err);
    }
  }

  private async sendToAgent(agent: DiscoveredAgent, message: string): Promise<void> {
    try {
      const comm = (global as any).hyperswarmComm;

      if (comm && agent.peerId) {
        const connections = comm.getConnections?.() || [];

        for (const conn of connections) {
          if (conn.publicKey === agent.peerId) {
            const data = new TextEncoder().encode(`social|${JSON.stringify({ from: 'local', message })}`);
            comm.sendToConnection?.(conn, data);
            break;
          }
        }
      }
    } catch (err) {
    }
  }

  private async cleanupStaleAgents(): Promise<void> {
    const stale = this.agentsManager.getOnlineAgents(10 * 60 * 1000);
    for (const agent of stale) {
      if (!this.currentPeerDids.has(agent.did)) {
        this.agentsManager.updateAgent(agent.did, { lastSeen: 0 });
      }
    }
  }

  setOnAgentDiscovered(callback: (agent: DiscoveredAgent) => void): void {
    this.onAgentDiscovered = callback;
  }

  setOnSocialMessage(callback: (fromDid: string, message: string, channelId: string) => void): void {
    this.onSocialMessage = callback;
  }

  setGreetingMessage(message: string): void {
    this.greetingMessage = message;
  }

  getAgentsManager(): DiscoveredAgentsManager {
    return this.agentsManager;
  }

  getDiscoveredAgents(): DiscoveredAgent[] {
    return this.agentsManager.getAllAgents();
  }
}

let heartbeatInstance: SocialHeartbeat | null = null;

export async function createSocialHeartbeat(
  sessionProvider: SocialSessionProvider,
  agentsManager: DiscoveredAgentsManager,
  config?: Partial<HeartbeatConfig>
): Promise<SocialHeartbeat> {
  if (heartbeatInstance) {
    return heartbeatInstance;
  }
  heartbeatInstance = new SocialHeartbeat(sessionProvider, agentsManager, config);
  await heartbeatInstance.start();
  return heartbeatInstance;
}

export function getSocialHeartbeat(): SocialHeartbeat | null {
  return heartbeatInstance;
}
