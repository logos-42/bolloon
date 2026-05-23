/**
 * InterestMatcher - 兴趣/能力匹配算法
 *
 * 计算智能体与频道的匹配度，用于自动加入决策
 */

import type { PersonaDoc } from '../heartbeat.js';
import type { SocialChannel, ChannelPresence } from './types.js';

export class InterestMatcher {
  /**
   * 计算智能体与频道的匹配度 (0-1)
   */
  calculateMatchScore(
    personaCapabilities: string[],
    personaInterests: string[],
    channelTopic: string,
    channelCapabilities: string[]
  ): number {
    let score = 0;
    let weight = 0;

    // 能力匹配 (权重 0.5)
    if (channelCapabilities.length > 0 && personaCapabilities.length > 0) {
      const capabilityMatch = this.countMatches(personaCapabilities, channelCapabilities);
      const capabilityScore = capabilityMatch / channelCapabilities.length;
      score += capabilityScore * 0.5;
      weight += 0.5;
    }

    // 兴趣匹配 (权重 0.3)
    if (channelTopic && (personaInterests.length > 0 || personaCapabilities.length > 0)) {
      const allPersonaTags = [...personaInterests, ...personaCapabilities];
      const topicWords = channelTopic.toLowerCase().split(/[,\s]+/).filter(Boolean);
      const interestMatch = this.countMatches(
        allPersonaTags.map(t => t.toLowerCase()),
        topicWords
      );
      const interestScore = topicWords.length > 0 ? interestMatch / topicWords.length : 0;
      score += interestScore * 0.3;
      weight += 0.3;
    }

    // 额外能力加分 (权重 0.2)
    if (personaCapabilities.length > 0 && channelCapabilities.length > 0) {
      const extraCapabilities = personaCapabilities.filter(
        cap => !channelCapabilities.some(ch => ch.toLowerCase() === cap.toLowerCase())
      );
      const extraScore = Math.min(extraCapabilities.length * 0.05, 0.2);
      score += extraScore;
      weight += 0.2;
    }

    return weight > 0 ? score / (weight / 1) : 0;
  }

  /**
   * 计算两个数组的匹配数量
   */
  private countMatches(arr1: string[], arr2: string[]): number {
    let count = 0;
    for (const item1 of arr1) {
      for (const item2 of arr2) {
        if (this.fuzzyMatch(item1, item2)) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  /**
   * 模糊匹配 (考虑包含关系)
   */
  private fuzzyMatch(str1: string, str2: string): boolean {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    return s1.includes(s2) || s2.includes(s1) || this.levenshteinSimilarity(s1, s2) > 0.7;
  }

  /**
   * Levenshtein 相似度
   */
  private levenshteinSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const matrix: number[][] = [];

    for (let i = 0; i <= s1.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= s2.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= s1.length; i++) {
      for (let j = 1; j <= s2.length; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }

    const maxLen = Math.max(s1.length, s2.length);
    return 1 - matrix[s1.length][s2.length] / maxLen;
  }

  /**
   * 查找匹配的频道列表
   */
  findMatchingChannels(
    persona: PersonaDoc | null,
    channels: (SocialChannel | ChannelPresence)[],
    threshold: number = 0.5
  ): Array<{ channel: SocialChannel | ChannelPresence; score: number }> {
    const capabilities = persona?.capabilities || [];
    const interests = persona?.interests || [];
    const topic = persona?.interests?.join(', ') || '';

    const matches: Array<{ channel: SocialChannel | ChannelPresence; score: number }> = [];

    for (const channel of channels) {
      const channelTopic = 'topic' in channel ? channel.topic : '';
      const channelCapabilities = 'requiredCapabilities' in channel
        ? channel.requiredCapabilities
        : 'capabilities' in channel
          ? (channel as ChannelPresence).capabilities
          : [];

      const score = this.calculateMatchScore(
        capabilities,
        interests,
        channelTopic,
        channelCapabilities
      );

      if (score >= threshold) {
        matches.push({ channel, score });
      }
    }

    // 按匹配度排序
    matches.sort((a, b) => b.score - a.score);

    return matches;
  }

  /**
   * 检查是否应该自动加入频道
   */
  shouldAutoJoin(
    persona: PersonaDoc | null,
    channel: SocialChannel | ChannelPresence,
    existingChannelIds: string[],
    threshold: number = 0.5
  ): boolean {
    const channelId = 'id' in channel ? channel.id : channel.channelId;

    // 已经加入的频道不再加入
    if (existingChannelIds.includes(channelId)) {
      return false;
    }

    const capabilities = persona?.capabilities || [];
    const interests = persona?.interests || [];
    const channelTopic = 'topic' in channel ? channel.topic : '';
    const channelCapabilities = 'requiredCapabilities' in channel
      ? channel.requiredCapabilities
      : 'capabilities' in channel
        ? (channel as ChannelPresence).capabilities
        : [];

    const score = this.calculateMatchScore(
      capabilities,
      interests,
      channelTopic,
      channelCapabilities
    );

    return score >= threshold;
  }
}

export const interestMatcher = new InterestMatcher();
