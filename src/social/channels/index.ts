/**
 * Channel Agent Social Module - 频道智能体社交系统
 *
 * 基于 Diap 去中心化协议的对外社交频道系统
 */

export {
  ChannelType,
  type SocialChannel,
  type ChannelMember,
  type ChannelPresence,
  type ChannelAnnouncement,
  type ChannelMessage,
  type DiscoveredAgent,
  type ChannelDiscoveryResult,
  type ServiceRegistration,
  DEFAULT_CHANNEL_CONFIG
} from './types.js';

export { InterestMatcher, interestMatcher } from './InterestMatcher.js';
export { ChannelManager } from './ChannelManager.js';
export { DiapChannelBridge, type DiapBridgeConfig } from './DiapChannelBridge.js';
