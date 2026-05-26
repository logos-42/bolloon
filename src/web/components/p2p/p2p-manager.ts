/**
 * P2P 核心管理器
 */

import { p2pStore } from './p2p-store-memory.js';
import { p2pIdentity } from './p2p-identity.js';
import { p2pConnection } from './p2p-connection.js';
import { p2pMessages } from './p2p-messages.js';
import type {
  P2PIdentity,
  ConnectResult,
  ConnectProgress,
  P2PMessage,
  ConnectionHistoryEntry
} from './types.js';

export class P2PManager {
  readonly identity = p2pIdentity;
  readonly connection = p2pConnection;
  readonly messages = p2pMessages;

  // 初始化
  async init(): Promise<P2PIdentity> {
    const identity = await this.identity.init();
    this.messages.startListening();
    return identity;
  }

  // 连接到节点
  async connect(input: string, onProgress?: (progress: ConnectProgress) => void): Promise<ConnectResult> {
    return this.connection.connect(input, onProgress);
  }

  // 断开连接
  async disconnect(nodeId: string): Promise<void> {
    return this.connection.disconnect(nodeId);
  }

  // 发送消息
  async sendMessage(content: string, targetNodeId: string) {
    return this.messages.send(content, targetNodeId);
  }

  // 获取连接历史
  async getHistory(): Promise<ConnectionHistoryEntry[]> {
    return p2pStore.getHistory();
  }

  // 更新历史条目
  async updateHistory(id: string, updates: Partial<ConnectionHistoryEntry>): Promise<void> {
    return p2pStore.updateHistory(id, updates);
  }

  // 删除历史条目
  async deleteHistory(id: string): Promise<void> {
    return p2pStore.deleteHistory(id);
  }

  // 获取收到的消息
  async getMessages(): Promise<P2PMessage[]> {
    return this.messages.getReceivedMessages();
  }

  // 监听消息
  onMessage(handler: (msg: P2PMessage) => void): void {
    this.messages.onMessage(handler);
  }

  // 获取未读数
  getUnreadCount(): number {
    return this.messages.getUnreadCount();
  }

  // 获取已连接节点
  getConnectedPeers() {
    return this.connection.getConnectedPeers();
  }

  // 获取节点数量
  getPeerCount(): number {
    return this.connection.getPeerCount();
  }

  // 获取离线队列
  async getOfflineQueue() {
    return this.messages.getOfflineQueue();
  }

  // 获取离线消息数量
  async getOfflineQueueCount(): Promise<number> {
    return p2pStore.getQueueCount();
  }

  // 销毁
  destroy(): void {
    this.connection.destroy();
    this.messages.destroy();
  }
}

// 全局单例
export const p2pManager = new P2PManager();

// 挂载到全局
if (typeof window !== 'undefined') {
  (window as any).p2pManager = p2pManager;
}

console.log('[P2P Manager] 已初始化');