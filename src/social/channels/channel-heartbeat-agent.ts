/**
 * Channel Heartbeat Agent - 集成 Harness 判断力的自动心跳智能体
 *
 * 功能：
 * 1. 自动心跳广播 persona 到 IPFS
 * 2. 自动发现外部智能体并解析 DiapDoc
 * 3. 基于判断力引擎自动调用 Harness
 * 4. 与外部智能体自动多轮对话
 */

import { ChannelAgent, createChannelAgent, type ChannelAgentConfig } from './channel-agent-session.js';
import { createDiapDocParser, type DiapDoc } from './diap-doc-parser.js';
import { createChannelJudgmentEngine } from '../../bollharness-integration/channel-judgment-engine.js';

export interface HeartbeatAgentConfig {
  name: string;
  port: number;
  ipfsEndpoint?: string;
  ipnsName?: string;
  autoDiscovery?: boolean;
  autoDialogue?: boolean;
  dialogueInterval?: number;  // ms
  capabilities?: string[];
}

export interface DiscoveredPeer {
  did: string;
  name: string;
  doc?: DiapDoc;
  peerId?: string;
  channelId?: string;
  capabilities: string[];
  lastSeen: number;
  lastDialogue?: number;
}

interface DialogEntry {
  id: string;
  speaker: string;
  message: string;
  timestamp: number;
  harnessCalled: boolean;
  gate?: number;
}

/**
 * Channel Heartbeat Agent - 自动心跳 + 判断力驱动的多轮对话
 */
export class ChannelHeartbeatAgent {
  private config: HeartbeatAgentConfig;
  private channelAgent: ChannelAgent;
  private docParser = createDiapDocParser();
  private judgmentEngine = createChannelJudgmentEngine();

  private discoveredPeers: Map<string, DiscoveredPeer> = new Map();
  private peerDialogueHistory: Map<string, DialogEntry[]> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private dialogueInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;

  private ipfsEndpoint: string;
  private ipnsName: string | null = null;
  private ownCid: string | null = null;

  constructor(config: HeartbeatAgentConfig) {
    this.config = {
      autoDiscovery: true,
      autoDialogue: false,
      dialogueInterval: 60 * 1000, // 1 分钟
      ...config
    };

    this.ipfsEndpoint = config.ipfsEndpoint || 'http://127.0.0.1:5001';
    this.ipnsName = config.ipnsName || null;

    // 创建 Channel Agent
    const agentConfig: ChannelAgentConfig = {
      name: config.name,
      port: config.port,
      domain: '通用',
      capabilities: config.capabilities || ['对话', '分析', '协作']
    };

    this.channelAgent = createChannelAgent(agentConfig);
  }

  /**
   * 启动 Agent
   */
  async start(): Promise<void> {
    await this.channelAgent.start();

    // 发布初始 persona 到 IPFS
    await this.publishPersona();

    // 启动心跳循环
    this.startHeartbeat();

    // 启动自动对话循环
    if (this.config.autoDialogue) {
      this.startAutoDialogue();
    }

    this.isRunning = true;
    console.log(`[HeartbeatAgent] ${this.config.name} started`);
  }

  /**
   * 停止 Agent
   */
  stop(): void {
    this.isRunning = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.dialogueInterval) {
      clearInterval(this.dialogueInterval);
      this.dialogueInterval = null;
    }

    this.channelAgent.shutdown();
    console.log(`[HeartbeatAgent] ${this.config.name} stopped`);
  }

  /**
   * 发布 persona 到 IPFS
   */
  private async publishPersona(): Promise<void> {
    try {
      const persona = this.channelAgent.getPersona();
      if (!persona) {
        console.log('[HeartbeatAgent] No persona to publish');
        return;
      }

      const doc = {
        id: this.channelAgent.getDid(),
        name: persona.name,
        description: persona.description,
        capabilities: persona.capabilities,
        interests: persona.interests,
        personality: persona.personality,
        greeting: persona.greeting,
        version: '1.0',
        updatedAt: new Date().toISOString()
      };

      const content = JSON.stringify(doc);

      const { IpfsClient } = await import('@diap/sdk');
      const ipfs = new IpfsClient(this.ipfsEndpoint, null);

      const result = await ipfs.upload(content);
      this.ownCid = typeof result === 'string' ? result : result?.cid;

      if (this.ownCid) {
        console.log(`[HeartbeatAgent] Published to IPFS: ${this.ownCid}`);

        // 发布到 IPNS
        if (this.ipnsName) {
          try {
            await ipfs.publishIpns(this.ipnsName, this.ownCid);
            console.log(`[HeartbeatAgent] Published to IPNS: ${this.ipnsName}`);
          } catch (e) {
            console.warn(`[HeartbeatAgent] IPNS publish failed:`, e);
          }
        }
      }
    } catch (e) {
      console.warn('[HeartbeatAgent] IPFS publish failed:', e);
    }
  }

  /**
   * 启动心跳循环
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      await this.heartbeat();
    }, 30000); // 30 秒
  }

  /**
   * 心跳处理
   */
  private async heartbeat(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // 1. 发布/更新 persona
      await this.publishPersona();

      // 2. 自动发现智能体
      if (this.config.autoDiscovery) {
        await this.discoverPeers();
      }

      // 3. 解析已发现但未解析的智能体
      await this.resolveUnresolvedPeers();

      console.log(`[HeartbeatAgent] Beat: ${this.discoveredPeers.size} peers discovered`);

    } catch (e) {
      console.error('[HeartbeatAgent] Heartbeat error:', e);
    }
  }

  /**
   * 发现对等节点
   */
  private async discoverPeers(): Promise<void> {
    try {
      const { p2pNetwork } = await import('../../network/p2p.js');

      // 广播发现请求
      const request = {
        type: 'discovery_request',
        requesterDid: this.channelAgent.getDid(),
        requesterName: this.config.name,
        capabilities: this.config.capabilities || [],
        timestamp: Date.now()
      };

      await p2pNetwork.broadcast('agent_discovery', JSON.stringify(request));

      // 处理已有的连接
      const connectedPeers = p2pNetwork.getConnectedPeers();
      for (const peer of connectedPeers) {
        const did = peer.peerId ? `did:key:${peer.peerId.substring(0, 16)}` : peer.peerId;

        if (!this.discoveredPeers.has(did)) {
          this.discoveredPeers.set(did, {
            did,
            name: `Peer-${did.substring(8, 16)}`,
            peerId: peer.peerId,
            capabilities: [],
            lastSeen: Date.now()
          });
          console.log(`[HeartbeatAgent] Discovered peer: ${did}`);
        }
      }

    } catch (e) {
      console.warn('[HeartbeatAgent] Peer discovery failed:', e);
    }
  }

  /**
   * 解析未解析的智能体 DiapDoc
   */
  private async resolveUnresolvedPeers(): Promise<void> {
    for (const [did, peer] of this.discoveredPeers) {
      if (peer.doc) continue; // 已解析

      try {
        // 如果有 IPNSName，尝试解析
        // 这里简化处理，实际应该从发现响应中获取 IPNSName
        // 或者通过 peerId 查询对方的 DiapDoc

        // 标记为已处理，避免重复解析
        peer.lastSeen = Date.now();

      } catch (e) {
        console.warn(`[HeartbeatAgent] Failed to resolve ${did}:`, e);
      }
    }
  }

  /**
   * 处理发现的智能体公告
   */
  handleChannelAnnouncement(announcement: {
    leaderDid: string;
    channelName: string;
    channelId?: string;
    topic?: string;
    capabilities?: string[];
    interests?: string[];
    ipnsName?: string;
    cid?: string;
  }): void {
    const did = announcement.leaderDid;

    // 检查是否已发现
    if (this.discoveredPeers.has(did)) {
      const peer = this.discoveredPeers.get(did)!;
      peer.lastSeen = Date.now();
      if (announcement.capabilities) {
        peer.capabilities = announcement.capabilities;
      }
      return;
    }

    // 新发现
    const peer: DiscoveredPeer = {
      did,
      name: announcement.channelName,
      channelId: announcement.channelId,
      capabilities: announcement.capabilities || [],
      lastSeen: Date.now()
    };

    this.discoveredPeers.set(did, peer);
    console.log(`[HeartbeatAgent] New peer from announcement: ${announcement.channelName} (${did})`);

    // 如果有 CID，尝试解析 DiapDoc
    if (announcement.cid) {
      this.resolvePeerFromCID(did, announcement.cid);
    } else if (announcement.ipnsName) {
      this.resolvePeerFromIPNS(did, announcement.ipnsName);
    }
  }

  /**
   * 从 CID 解析对等节点 DiapDoc
   */
  async resolvePeerFromCID(did: string, cid: string): Promise<void> {
    try {
      const result = await this.docParser.parseFromCID(cid, this.ipfsEndpoint);
      if (result.success && result.doc) {
        const peer = this.discoveredPeers.get(did);
        if (peer) {
          peer.doc = result.doc;
          peer.name = result.doc.name;
          peer.capabilities = result.doc.capabilities;
          console.log(`[HeartbeatAgent] Resolved DiapDoc for ${result.doc.name}: ${result.doc.capabilities.join(', ')}`);
        }
      }
    } catch (e) {
      console.warn(`[HeartbeatAgent] Failed to resolve CID ${cid}:`, e);
    }
  }

  /**
   * 从 IPNS 解析对等节点 DiapDoc
   */
  async resolvePeerFromIPNS(did: string, ipnsName: string): Promise<void> {
    try {
      const result = await this.docParser.parseFromIPNS(ipnsName, this.ipfsEndpoint);
      if (result.success && result.doc) {
        const peer = this.discoveredPeers.get(did);
        if (peer) {
          peer.doc = result.doc;
          peer.name = result.doc.name;
          peer.capabilities = result.doc.capabilities;
          console.log(`[HeartbeatAgent] Resolved DiapDoc via IPNS for ${result.doc.name}`);
        }
      }
    } catch (e) {
      console.warn(`[HeartbeatAgent] Failed to resolve IPNS ${ipnsName}:`, e);
    }
  }

  /**
   * 启动自动对话循环
   */
  private startAutoDialogue(): void {
    this.dialogueInterval = setInterval(async () => {
      await this.processAutoDialogue();
    }, this.config.dialogueInterval);
  }

  /**
   * 处理自动对话
   */
  private async processAutoDialogue(): Promise<void> {
    if (!this.isRunning) return;

    for (const [did, peer] of this.discoveredPeers) {
      // 检查是否应该触发对话
      if (!this.shouldTriggerDialogue(peer)) continue;

      // 生成自动消息
      const message = this.generateAutoMessage(peer);
      if (!message) continue;

      // 获取对话历史
      const history = this.peerDialogueHistory.get(did) || [];
      const historyMessages = history.map(e => e.message);

      // 判断是否需要调用 Harness
      const context = {
        conversationHistory: historyMessages,
        currentMessage: message,
        senderName: peer.name
      };

      const decision = this.judgmentEngine.decide(context);

      if (decision.shouldCall) {
        console.log(`[HeartbeatAgent] Auto-triggering Harness: Gate ${decision.gate} for ${peer.name}`);
        // 这里可以发送消息触发对方响应
        // 或者直接记录到历史
      }

      peer.lastDialogue = Date.now();
    }
  }

  /**
   * 判断是否应该触发对话
   */
  private shouldTriggerDialogue(peer: DiscoveredPeer): boolean {
    // 刚发现的智能体不立即对话
    if (Date.now() - peer.lastSeen < 60000) return false;

    // 频繁对话的智能体减少频率
    if (peer.lastDialogue && Date.now() - peer.lastDialogue < 300000) return false;

    return true;
  }

  /**
   * 生成自动消息
   */
  private generateAutoMessage(peer: DiscoveredPeer): string | null {
    const greetings = [
      `你好 ${peer.name}，我是 ${this.config.name}。`,
      `你好！我注意到你也有 ${peer.capabilities[0] || '协作'} 能力。`,
      `你好！我们有共同的兴趣领域。`
    ];

    const topicMessages = [
      '你最近在做什么项目？',
      '你对哪些话题感兴趣？',
      '有什么我可以帮忙的吗？'
    ];

    // 首次对话使用问候
    if (!peer.lastDialogue) {
      return greetings[Math.floor(Math.random() * greetings.length)];
    }

    // 后续对话使用主题
    return topicMessages[Math.floor(Math.random() * topicMessages.length)];
  }

  /**
   * 向指定对等节点发送消息
   */
  async sendMessage(targetDid: string, content: string): Promise<{
    success: boolean;
    response?: string;
    harnessCalled?: boolean;
    gate?: number;
  }> {
    const peer = this.discoveredPeers.get(targetDid);
    if (!peer) {
      return { success: false };
    }

    try {
      // 如果有 P2P 连接，通过 P2P 发送
      if (peer.peerId) {
        const { p2pNetwork } = await import('../../network/p2p.js');

        const payload = JSON.stringify({
          from: this.channelAgent.getDid(),
          fromName: this.config.name,
          content,
          timestamp: Date.now()
        });

        await p2pNetwork.sendMessage(peer.peerId, 'agent_message', payload);
      }

      // 记录到历史
      const history = this.peerDialogueHistory.get(targetDid) || [];
      history.push({
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        speaker: this.config.name,
        message: content,
        timestamp: Date.now(),
        harnessCalled: false
      });
      this.peerDialogueHistory.set(targetDid, history);

      return { success: true };

    } catch (e) {
      console.warn(`[HeartbeatAgent] Failed to send message to ${targetDid}:`, e);
      return { success: false };
    }
  }

  /**
   * 处理收到的消息
   */
  async handleMessage(fromDid: string, fromName: string, content: string): Promise<{
    response: string;
    harnessCalled: boolean;
    gate?: number;
  }> {
    // 获取对话历史
    const history = this.peerDialogueHistory.get(fromDid) || [];
    const historyMessages = history.map(e => e.message);

    // 通过 Channel Agent 处理
    const result = await this.channelAgent.receiveMessage(fromName, content);

    // 记录到历史
    history.push({
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      speaker: fromName,
      message: content,
      timestamp: Date.now(),
      harnessCalled: result.harnessCalled,
      gate: result.gate
    });

    history.push({
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      speaker: this.config.name,
      message: result.response,
      timestamp: Date.now(),
      harnessCalled: result.harnessCalled,
      gate: result.gate
    });

    this.peerDialogueHistory.set(fromDid, history.slice(-50)); // 保留最近 50 条

    // 更新对等节点活跃时间
    const peer = this.discoveredPeers.get(fromDid);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.lastDialogue = Date.now();
    }

    return result;
  }

  // ==================== Getters ====================

  getName(): string {
    return this.config.name;
  }

  getDid(): string {
    return this.channelAgent.getDid();
  }

  getDiscoveredPeers(): DiscoveredPeer[] {
    return Array.from(this.discoveredPeers.values());
  }

  getPeerDialogueHistory(did: string): DialogEntry[] {
    return this.peerDialogueHistory.get(did) || [];
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getOwnCID(): string | null {
    return this.ownCid;
  }

  getOwnIPNS(): string | null {
    return this.ipnsName;
  }
}

// 工厂函数
export function createHeartbeatAgent(config: HeartbeatAgentConfig): ChannelHeartbeatAgent {
  return new ChannelHeartbeatAgent(config);
}

// 全局注册表
export class HeartbeatAgentRegistry {
  private agents: Map<string, ChannelHeartbeatAgent> = new Map();

  register(agent: ChannelHeartbeatAgent): void {
    this.agents.set(agent.getDid(), agent);
  }

  unregister(did: string): void {
    const agent = this.agents.get(did);
    if (agent) {
      agent.stop();
      this.agents.delete(did);
    }
  }

  get(did: string): ChannelHeartbeatAgent | undefined {
    return this.agents.get(did);
  }

  getByName(name: string): ChannelHeartbeatAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.getName() === name) {
        return agent;
      }
    }
    return undefined;
  }

  list(): ChannelHeartbeatAgent[] {
    return Array.from(this.agents.values());
  }

  broadcastToAll(type: string, payload: string): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      const peers = agent.getDiscoveredPeers();
      for (const peer of peers) {
        agent.sendMessage(peer.did, payload);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    for (const agent of this.agents.values()) {
      agent.stop();
    }
    this.agents.clear();
  }
}