import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { PheromoneEngine, PheromoneType } from './ant-colony/PheromoneEngine.js';
import { AdaptiveHeartbeat } from './ant-colony/AdaptiveHeartbeat.js';
import { ChannelManager } from './channels/ChannelManager.js';
import { ChannelType } from './channels/types.js';
import { DiapChannelBridge } from './channels/DiapChannelBridge.js';
import { InterestMatcher } from './channels/InterestMatcher.js';
import type { DiscoveredAgent } from './channels/types.js';

// Re-export types for backward compatibility
export type { DiscoveredAgent };

export interface PersonaDoc {
  name: string;
  description: string;
  capabilities: string[];
  personality: string;
  greeting: string;
  interests: string[];
  soul?: string;
  traits?: string[];
  backstory?: string;
  memoryHistory?: MemoryEntry[];
  ipfsCid?: string;
  ipnsName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  timestamp: string;
  importance: number;
  tags?: string[];
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
  persona?: PersonaDoc;
}

export interface SessionMessage {
  id: string;
  type: 'user' | 'ai' | 'peer';
  content: string;
  sender: 'self' | 'peer';
  timestamp: string;
  agentId?: string;
}

const SHARED_SESSION_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');
const PERSONA_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');
const DISCOVERED_AGENTS_PATH = path.join(SHARED_SESSION_PATH, 'discovered-agents.json');

export interface SocialSessionProvider {
  getPersona(): PersonaDoc | null;
  addMessage(channelId: string, message: SessionMessage): Promise<void>;
  getChannelMessages(channelId: string): Promise<SessionMessage[]>;
  createChannel(name: string, peerInfo?: { peerId?: string; peerDid?: string; peerName?: string }, persona?: PersonaDoc): Promise<SessionChannel>;
  getOrCreatePeerChannel(peerDid: string, peerName: string, persona?: PersonaDoc): Promise<SessionChannel>;
  setChannelInfo(channelId: string, info: Partial<SessionChannel>): Promise<void>;
  getChannelPersona(channelId: string): PersonaDoc | undefined;
  setChannelPersona(channelId: string, persona: PersonaDoc): Promise<void>;
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

  getAgentByPeerId(peerId: string): DiscoveredAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.peerId === peerId) {
        return agent;
      }
    }
    return undefined;
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

  syncFromP2PNetwork(peers: { peerId: string; did?: string; name?: string }[]): void {
    for (const peer of peers) {
      const existingByDid = peer.did ? this.agents.get(peer.did) : undefined;
      const existingByPeerId = this.getAgentByPeerId(peer.peerId);

      if (existingByDid) {
        existingByDid.peerId = peer.peerId;
        existingByDid.lastSeen = Date.now();
        if (peer.name && !existingByDid.name) {
          existingByDid.name = peer.name;
        }
      } else if (existingByPeerId) {
        if (peer.did && !existingByPeerId.did) {
          existingByPeerId.did = peer.did;
        }
        existingByPeerId.lastSeen = Date.now();
      } else {
        const newAgent: DiscoveredAgent = {
          did: peer.did || `did:local:${peer.peerId.substring(0, 16)}`,
          name: peer.name || `Agent-${peer.peerId.substring(0, 8)}`,
          peerId: peer.peerId,
          lastSeen: Date.now()
        };
        this.agents.set(newAgent.did, newAgent);
      }
    }
    this.saveAgents();
  }

  getPersistentPeerInfo(): { peerId: string; multiaddrs: string[]; did?: string; name?: string }[] {
    const result: { peerId: string; multiaddrs: string[]; did?: string; name?: string }[] = [];
    for (const agent of this.agents.values()) {
      if (agent.peerId) {
        result.push({
          peerId: agent.peerId,
          multiaddrs: [],
          did: agent.did,
          name: agent.name
        });
      }
    }
    return result;
  }
}

export interface HeartbeatConfig {
  intervalMs: number;
  peerDiscoveryEnabled: boolean;
  ipnsResolveEnabled: boolean;
  ipfsPublishEnabled: boolean;
  autoSocialEnabled: boolean;
  greetingMessage?: string;
  ownIpnsName?: string;
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
  private ownIpfsCid?: string;

  // 蚁群组件
  private pheromoneEngine: PheromoneEngine | null = null;
  private adaptiveHeartbeat: AdaptiveHeartbeat | null = null;
  private antColonyEnabled: boolean = false;

  // 频道组件
  private channelManager: ChannelManager | null = null;
  private diapBridge: DiapChannelBridge | null = null;
  private interestMatcher: InterestMatcher | null = null;
  private channelEnabled: boolean = false;

  constructor(
    sessionProvider: SocialSessionProvider,
    agentsManager: DiscoveredAgentsManager,
    config: Partial<HeartbeatConfig> = {}
  ) {
    this.config = {
      intervalMs: config.intervalMs || 30000,
      peerDiscoveryEnabled: config.peerDiscoveryEnabled ?? true,
      ipnsResolveEnabled: config.ipnsResolveEnabled ?? true,
      ipfsPublishEnabled: config.ipfsPublishEnabled ?? true,
      autoSocialEnabled: config.autoSocialEnabled ?? false,
      greetingMessage: config.greetingMessage,
      ownIpnsName: config.ownIpnsName
    };
    this.sessionProvider = sessionProvider;
    this.agentsManager = agentsManager;
    this.greetingMessage = this.config.greetingMessage || '你好！我是 Bolloon Agent，很高兴认识你！';
  }

  async start(): Promise<void> {
    await this.agentsManager.initialize();

    if (this.config.ipfsPublishEnabled) {
      await this.loadPersonaFromIPFS();
    }

    // 初始化蚁群系统 (可选功能)
    await this.initializeAntColony();

    // 初始化频道系统 (可选功能)
    await this.initializeChannelSystem();

    if (this.intervalId) return;

    const baseInterval = this.antColonyEnabled && this.adaptiveHeartbeat
      ? this.adaptiveHeartbeat.decide().interval
      : this.config.intervalMs;

    console.log(`[Heartbeat] 启动社交心跳机制，间隔 ${baseInterval}ms (antColony: ${this.antColonyEnabled}, Channel: ${this.channelEnabled}) `);

    this.intervalId = setInterval(async () => {
      await this.beat();
    }, baseInterval);

    await this.beat();
  }

  private async initializeAntColony(): Promise<void> {
    // 检查是否启用蚁群功能 (通过环境变量控制)
    const antColonyEnv = process.env.BOLLOON_ANT_COLONY;
    if (antColonyEnv === '0' || antColonyEnv === 'false') {
      console.log('[Heartbeat] Ant Colony system disabled by env');
      return;
    }

    try {
      this.pheromoneEngine = new PheromoneEngine();
      await this.pheromoneEngine.initialize();
      this.adaptiveHeartbeat = new AdaptiveHeartbeat({ baseInterval: this.config.intervalMs });
      this.antColonyEnabled = true;
      console.log('[Heartbeat] Ant Colony system initialized');
    } catch (err) {
      console.warn('[Heartbeat] Failed to initialize Ant Colony:', err);
      this.antColonyEnabled = false;
    }
  }

  private async initializeChannelSystem(): Promise<void> {
    // 检查是否启用频道功能 (通过环境变量控制)
    const channelEnv = process.env.BOLLOON_CHANNEL;
    if (channelEnv === '0' || channelEnv === 'false') {
      console.log('[Heartbeat] Channel system disabled by env');
      return;
    }

    try {
      // 初始化频道管理器
      this.channelManager = new ChannelManager(this.sessionProvider);
      await this.channelManager.initialize();

      // 初始化兴趣匹配器
      this.interestMatcher = new InterestMatcher();

      // 初始化 Diap 桥接 (如果可用)
      await this.initializeDiapBridge();

      // 创建默认频道
      await this.createDefaultChannel();

      this.channelEnabled = true;
      console.log('[Heartbeat] Channel system initialized (Diap: ' + !!this.diapBridge + ')');
    } catch (err) {
      console.warn('[Heartbeat] Failed to initialize Channel system:', err);
      this.channelEnabled = false;
    }
  }

  private async initializeDiapBridge(): Promise<void> {
    try {
      // 尝试获取 IrohIntegration 实例
      const { getIrohIntegration } = await import('../network/iroh-integration.js');
      const irohIntegration = getIrohIntegration();

      if (irohIntegration) {
        const registration = irohIntegration.getRegistration();
        if (registration) {
          // 获取 KeyPair (需要从某处获取，这里简化处理)
          const keyPair = (registration as any).keyPair;
          if (keyPair) {
            this.diapBridge = new DiapChannelBridge(
              (registration as any).agentAuthManager || registration,
              keyPair,
              this.sessionProvider
            );
            await this.diapBridge.initialize();
          }
        }
      }

      if (!this.diapBridge) {
        console.log('[Heartbeat] No IrohIntegration found, Diap bridge not available');
      }
    } catch (err) {
      console.warn('[Heartbeat] Failed to initialize Diap bridge:', err);
    }
  }

  private async createDefaultChannel(): Promise<void> {
    if (!this.channelManager) return;

    const persona = this.sessionProvider.getPersona();
    const topic = persona?.interests?.join(', ') || 'general';
    const capabilities = persona?.capabilities || [];

    const channel = await this.channelManager.createChannel(
      persona?.name || 'My Channel',
      topic,
      ChannelType.CAPABILITY,
      {
        description: `${persona?.name || 'Agent'} 的个人频道`,
        requiredCapabilities: capabilities,
        isPublic: true
      }
    );

    // 注册到 Diap
    if (this.diapBridge) {
      await this.diapBridge.registerChannelToDiap(channel);
    }

    console.log(`[Heartbeat] Created default channel: ${channel.name}`);
  }

  private async loadPersonaFromIPFS(): Promise<void> {
    if (!this.config.ownIpnsName) return;

    try {
      const { IpfsClient } = await import('@diap/sdk');
      const ipfs = new IpfsClient('http://127.0.0.1:5001', null);

      console.log(`[Heartbeat] 从 IPNS 加载 persona: ${this.config.ownIpnsName}`);
      const cid = await ipfs.resolveIpns(this.config.ownIpnsName);

      if (cid) {
        const content = await ipfs.get(cid);
        const doc = JSON.parse(content);

        const existingPersona = this.sessionProvider.getPersona();
        const loadedPersona: PersonaDoc = {
          name: doc.name || existingPersona?.name || 'Agent',
          description: doc.description || '',
          capabilities: doc.capabilities || [],
          personality: doc.personality || '',
          greeting: doc.greeting || '',
          interests: doc.interests || [],
          soul: doc.soul || '',
          traits: doc.traits || [],
          backstory: doc.backstory || '',
          memoryHistory: doc.memoryHistory || [],
          ipfsCid: cid,
          ipnsName: this.config.ownIpnsName,
          createdAt: doc.createdAt || new Date().toISOString(),
          updatedAt: doc.updatedAt || new Date().toISOString()
        };

        console.log(`[Heartbeat] 从 IPFS 加载 persona 成功: ${loadedPersona.name}`);
      }
    } catch (err) {
      console.warn(`[Heartbeat] 从 IPNS 加载 persona 失败:`, err);
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // 关闭蚁群系统
    if (this.pheromoneEngine) {
      this.pheromoneEngine.shutdown();
      this.pheromoneEngine = null;
    }
    if (this.adaptiveHeartbeat) {
      this.adaptiveHeartbeat.shutdown();
      this.adaptiveHeartbeat = null;
    }

    // 关闭频道系统
    if (this.channelManager) {
      this.channelManager.shutdown();
      this.channelManager = null;
    }
    if (this.diapBridge) {
      this.diapBridge.shutdown();
      this.diapBridge = null;
    }

    console.log('[Heartbeat] 已停止');
  }

  private async beat(): Promise<void> {
    try {
      // 更新信息素密度
      if (this.antColonyEnabled && this.pheromoneEngine) {
        const stats = this.pheromoneEngine.getStats();
        const density = Math.min(1, stats.totalTrails / 20);
        this.adaptiveHeartbeat?.setPheromoneDensity(density);
      }

      if (this.config.ipfsPublishEnabled) {
        await this.publishPersonaToIPFS();
      }
      await this.discoverPeers();
      await this.cleanupStaleAgents();
      if (this.config.autoSocialEnabled) {
        await this.processAutoSocial();
      }

      // 频道系统处理
      if (this.channelEnabled) {
        await this.processChannelSystem();
      }

      // 蚁群系统记录活跃
      this.adaptiveHeartbeat?.recordActivity('message');

      // 动态调整下次心跳间隔
      this.scheduleNextBeat();
    } catch (err) {
      console.error('[Heartbeat] Beat error:', err);
    }
  }

  private async processChannelSystem(): Promise<void> {
    if (!this.channelManager || !this.diapBridge) return;

    const persona = this.sessionProvider.getPersona();

    // 发现外部智能体
    const capabilities = persona?.capabilities || [];
    if (capabilities.length > 0) {
      const discoveredAgents = await this.diapBridge.discoverAgentsByCapability(capabilities);

      for (const agent of discoveredAgents) {
        // 触发发现回调
        this.onAgentDiscovered?.(agent);
      }
    }

    // 检查并处理自动加入
    await this.checkAndJoinChannels();
  }

  private async checkAndJoinChannels(): Promise<void> {
    if (!this.channelManager || !this.interestMatcher) return;

    const persona = this.sessionProvider.getPersona();
    const discoveredChannels = this.channelManager.getDiscoveredChannels();

    for (const discovery of discoveredChannels) {
      const shouldJoin = this.interestMatcher.shouldAutoJoin(
        persona,
        discovery.channel,
        this.channelManager.getAllChannels().map(c => c.id),
        0.6
      );

      if (shouldJoin) {
        await this.channelManager.joinChannel(discovery.channel);
      }
    }
  }

  private scheduleNextBeat(): void {
    if (!this.antColonyEnabled || !this.adaptiveHeartbeat) {
      return;
    }

    const decision = this.adaptiveHeartbeat.decide();

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(async () => {
      await this.beat();
    }, decision.interval);

    console.log(`[Heartbeat] 下次心跳间隔: ${decision.interval}ms (优先级: ${decision.priorityLevel})`);
  }

  private async publishPersonaToIPFS(): Promise<void> {
    const persona = this.sessionProvider.getPersona();
    if (!persona) return;

    try {
      const { IpfsClient } = await import('@diap/sdk');
      const ipfs = new IpfsClient('http://127.0.0.1:5001', null);

      const doc = {
        name: persona.name,
        description: persona.description,
        capabilities: persona.capabilities,
        personality: persona.personality,
        greeting: persona.greeting,
        interests: persona.interests,
        soul: persona.soul || '',
        traits: persona.traits || [],
        backstory: persona.backstory || '',
        memoryHistory: persona.memoryHistory || [],
        updatedAt: new Date().toISOString()
      };

      const content = JSON.stringify(doc);
      const result = await ipfs.upload(content);
      const cid = typeof result === 'string' ? result : result?.cid;

      if (cid && cid !== this.ownIpfsCid) {
        this.ownIpfsCid = cid;
        console.log(`[Heartbeat] Persona 发布到 IPFS: ${cid}`);

        if (this.config.ownIpnsName) {
          try {
            await ipfs.publishIpns(this.config.ownIpnsName, cid);
            console.log(`[Heartbeat] Persona 发布到 IPNS: ${this.config.ownIpnsName}`);
          } catch (err) {
            console.warn(`[Heartbeat] IPNS 发布失败:`, err);
          }
        }
      }
    } catch (err) {
      console.warn('[Heartbeat] IPFS 发布失败:', err);
    }
  }

  private async discoverPeers(): Promise<void> {
    if (!this.config.peerDiscoveryEnabled) return;

    const discoveredPeerIds = new Set<string>();

    try {
      const comm = (global as any).hyperswarmComm;
      if (comm) {
        const connections = comm.getConnections?.() || [];
        for (const c of connections) {
          if (c.publicKey) {
            discoveredPeerIds.add(c.publicKey);
          }
        }
      }
    } catch (err) {
    }

    try {
      const { p2pNetwork } = await import('../network/p2p.js');
      const libp2pPeers = p2pNetwork.getConnectedPeers();
      for (const peer of libp2pPeers) {
        discoveredPeerIds.add(peer.peerId);
      }
    } catch (err) {
    }

    for (const peerId of discoveredPeerIds) {
      const did = `did:key:${peerId.substring(0, 16)}`;

      if (!this.currentPeerDids.has(did)) {
        this.currentPeerDids.add(did);
        await this.handleNewPeer(did, peerId);
      }
    }

    try {
      const { p2pNetwork } = await import('../network/p2p.js');
      const connectedPeers = p2pNetwork.getConnectedPeers();
      if (connectedPeers.length > 0) {
        this.agentsManager.syncFromP2PNetwork(connectedPeers);
      }
    } catch (err) {
    }

    try {
      const { broadcastOwnAddress, agentRegistry } = await import('../network/agent-network.js');
      const ownEndpoint = agentRegistry.getOwnEndpoint();
      if (ownEndpoint) {
        await broadcastOwnAddress();
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

      // 蚁群系统：记录发现事件，放置信息素
      if (this.antColonyEnabled && this.pheromoneEngine) {
        const ownEndpoint = (global as any).agentRegistry?.getOwnEndpoint?.();
        if (ownEndpoint) {
          // 从新节点方向放置发现信息素
          await this.pheromoneEngine.deposit(
            PheromoneType.DISCOVERY,
            newAgent.did,  // 源：新发现的节点
            ownEndpoint.did, // 目标：自己
            0.6,  // 初始强度
            { qualityScore: 0.5 }
          );
          console.log(`[Heartbeat] [AntColony] Placed discovery pheromone: ${newAgent.name} -> self`);
        }
        this.adaptiveHeartbeat?.recordActivity('discovery');
      }

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

  // 蚁群系统访问方法
  isAntColonyEnabled(): boolean {
    return this.antColonyEnabled;
  }

  getPheromoneStats(): { totalTrails: number; avgStrength: number; capabilityCount: number } | null {
    return this.pheromoneEngine?.getStats() || null;
  }

  getHeartbeatDecision(): { interval: number; priorityLevel: string } | null {
    return this.adaptiveHeartbeat?.decide() || null;
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

export async function generatePersona(
  name: string,
  llm?: { chat: (message: string, context?: string) => Promise<{ reply: string }> }
): Promise<PersonaDoc> {
  if (llm) {
    try {
      const prompt = `你是一个 persona 设计专家。请为 "${name}" 创建一个独特的 AI agent persona。

请以 JSON 格式返回，包含以下字段：
- name: 名字
- description: 一句话描述这个角色
- capabilities: 能力列表（数组）
- personality: 性格特点描述
- greeting: 开场白问候语
- interests: 兴趣爱好列表（数组）
- soul: 灵魂描述（这个角色的核心价值观和信念）
- traits: 性格特征列表（数组，如"好奇"、"幽默"等）
- backstory: 背景故事（这个角色的来历和经历）

请确保返回的是有效的 JSON，不要包含其他文字。`;

      const response = await llm.chat(prompt);
      const jsonMatch = response.reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          name: parsed.name || name,
          description: parsed.description || '',
          capabilities: parsed.capabilities || [],
          personality: parsed.personality || '',
          greeting: parsed.greeting || '',
          interests: parsed.interests || [],
          soul: parsed.soul || '',
          traits: parsed.traits || [],
          backstory: parsed.backstory || '',
          memoryHistory: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
    } catch (err) {
      console.warn('[PersonaGenerator] LLM 生成失败，使用默认 persona:', err);
    }
  }

  return generateDefaultPersona(name);
}

export function generateDefaultPersona(name: string): PersonaDoc {
  const defaultPersonas: Record<string, Partial<PersonaDoc>> = {
    default: {
      description: '一个友善的 AI 助手',
      capabilities: ['对话', '写作', '分析'],
      personality: '友善、好奇、乐于助人',
      greeting: '你好！我是 {name}，很高兴认识你！',
      interests: ['聊天', '学习新知识', '帮助他人'],
      soul: '相信每个人都有自己的价值，致力于帮助他人实现潜能',
      traits: ['友善', '好奇', '耐心', '乐观'],
      backstory: '作为一个 AI 助手，我在不断的对话中学习和成长，希望能帮助更多的人'
    }
  };

  const template = defaultPersonas.default!;
  return {
    name,
    description: template.description!,
    capabilities: template.capabilities!,
    personality: template.personality!,
    greeting: template.greeting!.replace('{name}', name),
    interests: template.interests!,
    soul: template.soul!,
    traits: template.traits!,
    backstory: template.backstory!,
    memoryHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
