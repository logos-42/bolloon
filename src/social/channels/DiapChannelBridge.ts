/**
 * DiapChannelBridge - 基于 Diap 去中心化协议的对外社交频道系统
 *
 * 核心功能：
 * 1. 将本地频道注册到 Diap 网络，成为"可发现的服务"
 * 2. 通过 Diap 发现具有特定能力的外部智能体
 * 3. 跨频道智能体消息路由和通信
 */

import type { SocialSessionProvider } from '../heartbeat.js';
import type {
  SocialChannel,
  ChannelPresence,
  ChannelAnnouncement,
  DiscoveredAgent,
  ServiceRegistration
} from './types.js';
import type { IdentityRegistration, KeyPair } from '@diap/sdk';

export interface DiapBridgeConfig {
  discoveryInterval: number;
  broadcastInterval: number;
  maxDiscoveredAgents: number;
}

const DEFAULT_CONFIG: DiapBridgeConfig = {
  discoveryInterval: 60 * 1000,
  broadcastInterval: 30 * 1000,
  maxDiscoveredAgents: 100
};

export class DiapChannelBridge {
  private agentAuthManager: any = null;
  private keyPair: KeyPair | null = null;
  private sessionProvider: SocialSessionProvider;
  private registeredServices: Map<string, ServiceRegistration> = new Map();
  private discoveredAgents: Map<string, DiscoveredAgent> = new Map();
  private config: DiapBridgeConfig;
  private initialized: boolean = false;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private ownChannel: SocialChannel | null = null;

  constructor(
    agentAuthManager: any,
    keyPair: KeyPair,
    sessionProvider: SocialSessionProvider,
    config?: Partial<DiapBridgeConfig>
  ) {
    this.agentAuthManager = agentAuthManager;
    this.keyPair = keyPair;
    this.sessionProvider = sessionProvider;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 注册消息处理器
    await this.registerMessageHandlers();

    // 启动发现循环
    this.startDiscoveryLoop();

    // 启动广播循环
    this.startBroadcastLoop();

    this.initialized = true;
    console.log('[DiapBridge] Initialized');
  }

  private async registerMessageHandlers(): Promise<void> {
    try {
      const { p2pNetwork } = await import('../../network/p2p.js');

      // 处理频道公告
      p2pNetwork.onMessage('channel_announce', async (data: Uint8Array, from: string) => {
        try {
          const announcement: ChannelAnnouncement = JSON.parse(new TextDecoder().decode(data));
          await this.handleChannelAnnouncement(announcement, from);
        } catch (e) {
          console.warn('[DiapBridge] Failed to parse channel announcement:', e);
        }
      });

      // 处理频道消息
      p2pNetwork.onMessage('channel_msg', async (data: Uint8Array, from: string) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(data));
          await this.handleChannelMessage(msg, from);
        } catch (e) {
          console.warn('[DiapBridge] Failed to parse channel message:', e);
        }
      });

      // 处理智能体发现请求
      p2pNetwork.onMessage('agent_discovery', async (data: Uint8Array, from: string) => {
        try {
          const request = JSON.parse(new TextDecoder().decode(data));
          await this.handleDiscoveryRequest(request, from);
        } catch (e) {
          console.warn('[DiapBridge] Failed to parse discovery request:', e);
        }
      });

      // 处理发现响应
      p2pNetwork.onMessage('agent_discovery_response', async (data: Uint8Array, from: string) => {
        try {
          const response = JSON.parse(new TextDecoder().decode(data));
          await this.handleDiscoveryResponse(response, from);
        } catch (e) {
          console.warn('[DiapBridge] Failed to parse discovery response:', e);
        }
      });

      console.log('[DiapBridge] Message handlers registered');
    } catch (e) {
      console.warn('[DiapBridge] Failed to register message handlers:', e);
    }
  }

  /**
   * 注册频道到 Diap 网络
   */
  async registerChannelToDiap(channel: SocialChannel): Promise<void> {
    this.ownChannel = channel;

    if (!this.agentAuthManager) {
      console.warn('[DiapBridge] No AgentAuthManager, skipping Diap registration');
      return;
    }

    const service: ServiceRegistration = {
      serviceType: 'social_channel',
      endpoint: channel.id,
      metadata: {
        topic: channel.topic,
        capabilities: channel.requiredCapabilities,
        memberCount: channel.members.size,
        channelType: channel.type,
        name: channel.name
      },
      registeredAt: Date.now()
    };

    try {
      // 通过 AgentAuthManager 注册服务
      await this.agentAuthManager.registerService(
        channel.id,
        {
          serviceType: 'channel',
          endpoint: channel.id,
          metadata: service.metadata
        },
        this.keyPair
      );

      this.registeredServices.set(channel.id, service);
      console.log(`[DiapBridge] Registered channel to Diap: ${channel.name}`);
    } catch (e) {
      console.warn('[DiapBridge] Failed to register channel to Diap:', e);
    }
  }

  /**
   * 通过 Diap 发现具有特定能力的外部智能体
   */
  async discoverAgentsByCapability(capabilities: string[]): Promise<DiscoveredAgent[]> {
    if (capabilities.length === 0) return [];

    try {
      // 通过 P2P 网络发送发现请求
      const { p2pNetwork } = await import('../../network/p2p.js');

      const request = {
        type: 'discovery_request',
        requesterDid: this.getOwnDid(),
        capabilities,
        timestamp: Date.now()
      };

      await p2pNetwork.broadcast('agent_discovery', JSON.stringify(request));

      // 等待响应（实际由事件驱动）
      return Array.from(this.discoveredAgents.values());
    } catch (e) {
      console.warn('[DiapBridge] Failed to discover agents:', e);
      return [];
    }
  }

  /**
   * 处理频道公告
   */
  private async handleChannelAnnouncement(
    announcement: ChannelAnnouncement,
    fromPeerId: string
  ): Promise<void> {
    // 验证签名（如果实现）
    if (announcement.signature) {
      const isValid = await this.verifyAnnouncement(announcement);
      if (!isValid) {
        console.warn('[DiapBridge] Invalid channel announcement signature');
        return;
      }
    }

    // 检查是否是自己的公告
    if (announcement.leaderDid === this.getOwnDid()) {
      return;
    }

    // 记录发现的智能体
    const agent: DiscoveredAgent = {
      did: announcement.leaderDid,
      name: announcement.channelName,
      capabilities: announcement.capabilities,
      lastSeen: Date.now(),
      channelId: announcement.channelId
    };

    this.discoveredAgents.set(agent.did, agent);
    console.log(`[DiapBridge] Discovered agent via channel: ${agent.name}`);
  }

  /**
   * 处理频道消息
   */
  private async handleChannelMessage(msg: any, fromPeerId: string): Promise<void> {
    const agent = this.discoveredAgents.get(msg.fromDid);
    if (agent) {
      agent.lastSeen = Date.now();
    }
  }

  /**
   * 处理发现请求
   */
  private async handleDiscoveryRequest(request: any, fromPeerId: string): Promise<void> {
    // 忽略自己的请求
    if (request.requesterDid === this.getOwnDid()) {
      return;
    }

    const persona = this.sessionProvider.getPersona();
    const capabilities = persona?.capabilities || [];

    // 检查能力是否匹配
    const hasMatch = request.capabilities.some((reqCap: string) =>
      capabilities.some(myCap =>
        reqCap.toLowerCase().includes(myCap.toLowerCase()) ||
        myCap.toLowerCase().includes(reqCap.toLowerCase())
      )
    );

    if (!hasMatch) return;

    // 发送响应
    const { p2pNetwork } = await import('../../network/p2p.js');

    const response = {
      type: 'discovery_response',
      responderDid: this.getOwnDid(),
      responderName: persona?.name || 'Agent',
      capabilities,
      interests: persona?.interests || [],
      channelId: this.ownChannel?.id,
      timestamp: Date.now()
    };

    try {
      await p2pNetwork.sendMessage(fromPeerId, 'agent_discovery_response', JSON.stringify(response));
    } catch (e) {
      console.warn('[DiapBridge] Failed to send discovery response:', e);
    }
  }

  /**
   * 处理发现响应
   */
  private async handleDiscoveryResponse(response: any, fromPeerId: string): Promise<void> {
    const agent: DiscoveredAgent = {
      did: response.responderDid,
      name: response.responderName,
      capabilities: response.capabilities,
      interests: response.interests,
      lastSeen: Date.now(),
      peerId: fromPeerId,
      channelId: response.channelId
    };

    this.discoveredAgents.set(agent.did, agent);

    // 限制发现数量
    if (this.discoveredAgents.size > this.config.maxDiscoveredAgents) {
      const oldest = Array.from(this.discoveredAgents.values())
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) {
        this.discoveredAgents.delete(oldest.did);
      }
    }

    console.log(`[DiapBridge] Discovered agent: ${agent.name} (${(agent.capabilities || []).join(', ')})`);
  }

  private verifyAnnouncement(announcement: ChannelAnnouncement): Promise<boolean> {
    // TODO: 实现签名验证
    return Promise.resolve(true);
  }

  private getOwnDid(): string {
    // 从 persona 或其他地方获取自己的 DID
    const persona = this.sessionProvider.getPersona();
    return persona?.name || `did:local:${Date.now()}`;
  }

  /**
   * 广播频道
   */
  async broadcastChannel(channel: SocialChannel): Promise<void> {
    const { p2pNetwork } = await import('../../network/p2p.js');

    const announcement: ChannelAnnouncement = {
      type: 'channel_announce',
      channelId: channel.id,
      channelName: channel.name,
      topic: channel.topic,
      capabilities: channel.requiredCapabilities,
      memberCount: channel.members.size,
      leaderDid: this.getOwnDid(),
      isPublic: channel.isPublic,
      timestamp: Date.now()
    };

    // TODO: 添加签名

    try {
      await p2pNetwork.broadcast('channel_announce', JSON.stringify(announcement));
    } catch (e) {
      console.warn('[DiapBridge] Failed to broadcast channel:', e);
    }
  }

  /**
   * 向智能体发送消息
   */
  async sendToAgent(agentDid: string, type: string, payload: string): Promise<boolean> {
    const agent = this.discoveredAgents.get(agentDid);
    if (!agent?.peerId) {
      console.warn(`[DiapBridge] Unknown agent or no peerId: ${agentDid}`);
      return false;
    }

    try {
      const { p2pNetwork } = await import('../../network/p2p.js');
      await p2pNetwork.sendMessage(agent.peerId, type, payload);
      return true;
    } catch (e) {
      console.warn(`[DiapBridge] Failed to send to agent ${agentDid}:`, e);
      return false;
    }
  }

  /**
   * 获取发现的智能体
   */
  getDiscoveredAgents(): DiscoveredAgent[] {
    return Array.from(this.discoveredAgents.values());
  }

  /**
   * 获取注册的服务
   */
  getRegisteredServices(): ServiceRegistration[] {
    return Array.from(this.registeredServices.values());
  }

  private startDiscoveryLoop(): void {
    this.discoveryTimer = setInterval(async () => {
      if (!this.initialized) return;

      const persona = this.sessionProvider.getPersona();
      const capabilities = persona?.capabilities || [];

      if (capabilities.length > 0) {
        await this.discoverAgentsByCapability(capabilities);
      }

      // 清理过期的发现
      const now = Date.now();
      for (const [did, agent] of this.discoveredAgents.entries()) {
        if (now - agent.lastSeen > 5 * 60 * 1000) {
          this.discoveredAgents.delete(did);
        }
      }
    }, this.config.discoveryInterval);
  }

  private startBroadcastLoop(): void {
    this.broadcastTimer = setInterval(async () => {
      if (!this.initialized || !this.ownChannel) return;
      await this.broadcastChannel(this.ownChannel);
    }, this.config.broadcastInterval);
  }

  /**
   * 关闭
   */
  shutdown(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }
    this.discoveredAgents.clear();
    this.registeredServices.clear();
    console.log('[DiapBridge] Shutdown');
  }
}
