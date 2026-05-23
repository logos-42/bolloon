/**
 * Channel Types - 频道智能体社交系统类型定义
 */

import type { PersonaDoc } from '../heartbeat.js';

export enum ChannelType {
  INTEREST = 'interest',
  CAPABILITY = 'capability',
  REGION = 'region',
  AD_HOC = 'ad_hoc'
}

export interface ChannelMember {
  did: string;
  name: string;
  peerId?: string;
  role: 'leader' | 'member';
  joinTime: number;
  lastActive: number;
  capabilities: string[];
  interests: string[];
}

export interface SocialChannel {
  id: string;
  type: ChannelType;
  name: string;
  description?: string;
  topic: string;
  requiredCapabilities: string[];
  members: Map<string, ChannelMember>;
  leaderDid: string;
  createdAt: number;
  lastActivity: number;
  isPublic: boolean;
}

export interface ChannelPresence {
  channelId: string;
  channelName: string;
  topic: string;
  memberCount: number;
  capabilities: string[];
  leaderDid: string;
  isPublic: boolean;
  timestamp: number;
  signature?: string;
}

export interface ChannelAnnouncement {
  type: 'channel_announce';
  channelId: string;
  channelName: string;
  topic: string;
  capabilities: string[];
  memberCount: number;
  leaderDid: string;
  isPublic: boolean;
  timestamp: number;
  signature?: string;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  fromDid: string;
  fromName: string;
  type: string;
  payload: string;
  timestamp: number;
  signature?: string;
}

export interface DiscoveredAgent {
  did: string;
  name: string;
  capabilities?: string[];
  interests?: string[];
  lastSeen: number;
  peerId?: string;
  channelId?: string;
  persona?: PersonaDoc;
  // Legacy properties for backward compatibility
  cid?: string;
  ipnsName?: string;
  lastMessage?: string;
}

export interface ChannelDiscoveryResult {
  channel: ChannelPresence;
  matchScore: number;
  discoveredAt: number;
}

export interface ServiceRegistration {
  serviceType: string;
  endpoint: string;
  metadata: {
    topic: string;
    capabilities: string[];
    memberCount: number;
    channelType: string;
    name: string;
  };
  registeredAt: number;
}

export const DEFAULT_CHANNEL_CONFIG = {
  broadcastInterval: 60 * 1000,
  matchThreshold: 0.5,
  maxChannels: 10,
  maxMembersPerChannel: 50,
  memberTimeout: 30 * 60 * 1000,
};
