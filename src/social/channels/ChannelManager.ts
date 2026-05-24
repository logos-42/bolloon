/**
 * ChannelManager - 频道管理器
 *
 * 管理本地频道，与 Diap 桥接协同工作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SocialSessionProvider } from '../heartbeat.js';
import {
  ChannelType,
  type SocialChannel,
  type ChannelMember,
  type ChannelPresence,
  type ChannelAnnouncement,
  type ChannelMessage,
  type ChannelDiscoveryResult
} from './types.js';
import { DEFAULT_CHANNEL_CONFIG } from './types.js';

const CHANNELS_PATH = path.join(
  process.env.HOME || '/tmp',
  '.bolloon',
  'channels',
  'my-channels.json'
);

const DISCOVERED_PATH = path.join(
  process.env.HOME || '/tmp',
  '.bolloon',
  'channels',
  'discovered.json'
);

export class ChannelManager {
  private channels: Map<string, SocialChannel> = new Map();
  private discoveredChannels: Map<string, ChannelDiscoveryResult> = new Map();
  private ownChannelId: string | null = null;
  private sessionProvider: SocialSessionProvider;
  private initialized: boolean = false;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandlers: Map<string, (msg: ChannelMessage) => void> = new Map();
  private agentDid: string | null = null;

  constructor(sessionProvider: SocialSessionProvider) {
    this.sessionProvider = sessionProvider;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(path.dirname(CHANNELS_PATH), { recursive: true });
    await this.load();
    this.startBroadcastTimer();

    this.initialized = true;
    console.log(`[ChannelManager] Initialized with ${this.channels.size} channels`);
  }

  private async load(): Promise<void> {
    // 加载自己的频道
    try {
      const data = await fs.readFile(CHANNELS_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      this.channels.clear();
      for (const ch of parsed) {
        const channel = this.deserializeChannel(ch);
        this.channels.set(channel.id, channel);
        if (!this.ownChannelId) {
          this.ownChannelId = channel.id;
        }
      }
    } catch {
      // 无历史数据
    }

    // 加载发现的频道
    try {
      const data = await fs.readFile(DISCOVERED_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      this.discoveredChannels.clear();
      for (const ch of parsed) {
        this.discoveredChannels.set(ch.channel.channelId, ch);
      }
    } catch {
      // 无历史数据
    }
  }

  private async save(): Promise<void> {
    const channelsData = Array.from(this.channels.values()).map(ch => this.serializeChannel(ch));
    await fs.writeFile(CHANNELS_PATH, JSON.stringify(channelsData, null, 2));

    const discoveredData = Array.from(this.discoveredChannels.values());
    await fs.writeFile(DISCOVERED_PATH, JSON.stringify(discoveredData, null, 2));
  }

  private serializeChannel(channel: SocialChannel): object {
    return {
      ...channel,
      members: Array.from(channel.members.entries())
    };
  }

  private deserializeChannel(data: any): SocialChannel {
    return {
      ...data,
      members: new Map(data.members)
    };
  }

  private startBroadcastTimer(): void {
    this.broadcastTimer = setInterval(() => {
      const ownChannel = this.getOwnChannel();
      if (ownChannel) {
        this.broadcastChannel(ownChannel).catch(console.error);
      }
    }, DEFAULT_CHANNEL_CONFIG.broadcastInterval);
  }

  /**
   * 创建新频道
   */
  async createChannel(
    name: string,
    topic: string,
    type: ChannelType,
    options?: {
      description?: string;
      requiredCapabilities?: string[];
      isPublic?: boolean;
    }
  ): Promise<SocialChannel> {
    const persona = this.sessionProvider.getPersona();
    const channelId = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const selfMember: ChannelMember = {
      did: persona?.name || 'self',
      name: persona?.name || 'Self',
      role: 'leader',
      joinTime: Date.now(),
      lastActive: Date.now(),
      capabilities: persona?.capabilities || [],
      interests: persona?.interests || []
    };

    const channel: SocialChannel = {
      id: channelId,
      type,
      name,
      description: options?.description,
      topic,
      requiredCapabilities: options?.requiredCapabilities || [],
      members: new Map([[selfMember.did, selfMember]]),
      leaderDid: selfMember.did,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isPublic: options?.isPublic ?? true
    };

    this.channels.set(channelId, channel);
    this.ownChannelId = channelId;

    await this.save();
    console.log(`[ChannelManager] Created channel: ${name} (${channelId})`);

    return channel;
  }

  /**
   * 加入频道
   */
  async joinChannel(channel: ChannelPresence | SocialChannel): Promise<void> {
    const persona = this.sessionProvider.getPersona();
    const channelId = 'id' in channel ? channel.id : (channel as ChannelPresence).channelId;
    const channelName = 'name' in channel ? channel.name : (channel as ChannelPresence).channelName;
    const channelTopic = channel.topic;
    const channelCapabilities = 'requiredCapabilities' in channel
      ? channel.requiredCapabilities
      : (channel as ChannelPresence).capabilities;
    const channelLeaderDid = channel.leaderDid;
    const channelIsPublic = channel.isPublic;

    const selfMember: ChannelMember = {
      did: persona?.name || 'self',
      name: persona?.name || 'Self',
      role: 'member',
      joinTime: Date.now(),
      lastActive: Date.now(),
      capabilities: persona?.capabilities || [],
      interests: persona?.interests || []
    };

    // 如果是本地频道
    const localChannel = this.channels.get(channelId);
    if (localChannel) {
      localChannel.members.set(selfMember.did, selfMember);
      localChannel.lastActivity = Date.now();
    } else {
      // 创建本地记录（不包含成员详情）
      const discoveredChannel: SocialChannel = {
        id: channelId,
        type: ChannelType.CAPABILITY,
        name: channelName,
        topic: channelTopic,
        requiredCapabilities: channelCapabilities,
        members: new Map([[selfMember.did, selfMember]]),
        leaderDid: channelLeaderDid,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        isPublic: channelIsPublic
      };
      this.channels.set(channelId, discoveredChannel);
    }

    await this.save();
    console.log(`[ChannelManager] Joined channel: ${channelName}`);
  }

  /**
   * 离开频道
   */
  async leaveChannel(channelId: string): Promise<void> {
    const persona = this.sessionProvider.getPersona();
    const did = persona?.name || 'self';

    const channel = this.channels.get(channelId);
    if (channel) {
      channel.members.delete(did);
      channel.lastActivity = Date.now();

      // 如果没有成员了，删除频道
      if (channel.members.size === 0) {
        this.channels.delete(channelId);
      }

      if (this.ownChannelId === channelId) {
        this.ownChannelId = null;
      }
    }

    await this.save();
    console.log(`[ChannelManager] Left channel: ${channelId}`);
  }

  /**
   * 发送消息到频道
   */
  async sendToChannel(channelId: string, type: string, payload: string): Promise<void> {
    const persona = this.sessionProvider.getPersona();
    const channel = this.channels.get(channelId);

    if (!channel) {
      console.warn(`[ChannelManager] Channel not found: ${channelId}`);
      return;
    }

    const message: ChannelMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      channelId,
      fromDid: persona?.name || 'self',
      fromName: persona?.name || 'Self',
      type,
      payload,
      timestamp: Date.now()
    };

    // 触发消息处理器
    const handler = this.messageHandlers.get(channelId);
    if (handler) {
      handler(message);
    }

    // 存储消息
    await this.sessionProvider.addMessage(channelId, {
      id: message.id,
      type: 'ai',
      content: payload,
      sender: 'self',
      timestamp: new Date(message.timestamp).toISOString()
    });

    channel.lastActivity = Date.now();
    await this.save();
  }

  /**
   * 处理收到的频道消息
   */
  handleChannelMessage(msg: ChannelMessage): void {
    const handler = this.messageHandlers.get(msg.channelId);
    if (handler) {
      handler(msg);
    }
  }

  /**
   * 注册消息处理器
   */
  onChannelMessage(channelId: string, handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.set(channelId, handler);
  }

  /**
   * 处理频道公告
   */
  async handleChannelAnnouncement(announcement: ChannelAnnouncement): Promise<boolean> {
    // 检查是否已发现
    const existing = this.discoveredChannels.get(announcement.channelId);
    if (existing) {
      existing.discoveredAt = Date.now();
      await this.save();
      return false;
    }

    // 检查签名（如果实现）
    if (announcement.signature) {
      const isValid = await this.verifySignature(announcement);
      if (!isValid) {
        console.warn(`[ChannelManager] Invalid signature for channel: ${announcement.channelId}`);
        return false;
      }
    }

    // 记录发现的频道
    this.discoveredChannels.set(announcement.channelId, {
      channel: {
        channelId: announcement.channelId,
        channelName: announcement.channelName,
        topic: announcement.topic,
        memberCount: announcement.memberCount,
        capabilities: announcement.capabilities,
        leaderDid: announcement.leaderDid,
        isPublic: announcement.isPublic,
        timestamp: announcement.timestamp,
        signature: announcement.signature
      },
      matchScore: 0.5, // 待计算
      discoveredAt: Date.now()
    });

    await this.save();
    console.log(`[ChannelManager] Discovered channel: ${announcement.channelName}`);
    return true;
  }

  private async verifySignature(announcement: ChannelAnnouncement): Promise<boolean> {
    // TODO: 实现签名验证
    return true;
  }

  /**
   * 广播频道存在
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
      leaderDid: channel.leaderDid,
      isPublic: channel.isPublic,
      timestamp: Date.now()
    };

    try {
      await p2pNetwork.broadcast('channel_announce', JSON.stringify(announcement));
    } catch (e) {
      console.warn(`[ChannelManager] Failed to broadcast channel:`, e);
    }
  }

  /**
   * 获取自己的频道
   */
  getOwnChannel(): SocialChannel | null {
    if (!this.ownChannelId) return null;
    return this.channels.get(this.ownChannelId) || null;
  }

  /**
   * 获取所有频道
   */
  getAllChannels(): SocialChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * 获取发现的频道
   */
  getDiscoveredChannels(): ChannelDiscoveryResult[] {
    return Array.from(this.discoveredChannels.values());
  }

  /**
   * 获取频道成员
   */
  getChannelMembers(channelId: string): ChannelMember[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    return Array.from(channel.members.values());
  }

  /**
   * 获取频道
   */
  getChannel(channelId: string): SocialChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * 关闭
   */
  shutdown(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }
    this.messageHandlers.clear();
    console.log('[ChannelManager] Shutdown');
  }

  /**
   * 设置智能体的 DID
   * 将 DID 与频道 leaderDid 关联
   */
  setAgentDid(did: string): void {
    this.agentDid = did;

    // 更新自己频道的 leaderDid
    const ownChannel = this.getOwnChannel();
    if (ownChannel) {
      const oldLeaderDid = ownChannel.leaderDid;
      const oldMember = ownChannel.members.get(oldLeaderDid);

      if (oldMember) {
        // 删除旧的 leader 记录
        ownChannel.members.delete(oldLeaderDid);
        // 更新为新的 DID
        oldMember.did = did;
        oldMember.name = this.sessionProvider.getPersona()?.name || did;
        ownChannel.members.set(did, oldMember);
        ownChannel.leaderDid = did;
      }
    }
  }

  /**
   * 获取当前智能体的 DID
   */
  getAgentDid(): string | null {
    return this.agentDid;
  }

  /**
   * 获取频道 leader 的 DID
   */
  getLeaderDid(): string | null {
    return this.getOwnChannel()?.leaderDid || null;
  }

  /**
   * 根据 DID 获取智能体名称
   */
  getAgentNameByDid(did: string): string {
    const ownChannel = this.getOwnChannel();
    if (ownChannel) {
      const member = ownChannel.members.get(did);
      if (member) {
        return member.name;
      }
    }
    // 搜索所有频道
    for (const channel of this.channels.values()) {
      const member = channel.members.get(did);
      if (member) {
        return member.name;
      }
    }
    return did;
  }
}
