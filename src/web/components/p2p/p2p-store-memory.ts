/**
 * P2P 内存存储 - 简化版，无 IndexedDB 依赖
 */

import type {
  ConnectionHistoryEntry,
  OfflineMessage,
  P2PMessage,
  P2PPreferences
} from './types.js';

export class P2PStoreMemory {
  private history: ConnectionHistoryEntry[] = [];
  private messages: P2PMessage[] = [];
  private offlineQueue: OfflineMessage[] = [];
  private unreadCount: number = 0;
  private preferences: P2PPreferences = {
    autoReconnect: true,
    autoConnectOnStartup: true,
    maxRetries: 3,
    notifications: {
      newMessage: true,
      connectionEstablished: true
    }
  };

  // ==================== 连接历史 ====================

  async addToHistory(entry: Omit<ConnectionHistoryEntry, 'id'>): Promise<string> {
    const existingIndex = this.history.findIndex(h => h.did === entry.did);

    if (existingIndex >= 0) {
      this.history[existingIndex] = {
        ...this.history[existingIndex],
        ...entry,
        lastConnectedAt: Date.now()
      };
      return this.history[existingIndex].id;
    }

    const id = crypto.randomUUID();
    this.history.push({
      ...entry,
      id,
      lastConnectedAt: Date.now()
    });
    return id;
  }

  async getHistory(): Promise<ConnectionHistoryEntry[]> {
    return [...this.history].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.lastMessageAt - a.lastMessageAt;
    });
  }

  async updateHistory(id: string, updates: Partial<ConnectionHistoryEntry>): Promise<void> {
    const index = this.history.findIndex(h => h.id === id);
    if (index >= 0) {
      this.history[index] = { ...this.history[index], ...updates };
    }
  }

  async deleteHistory(id: string): Promise<void> {
    this.history = this.history.filter(h => h.id !== id);
  }

  // ==================== 消息 ====================

  async addMessage(msg: Omit<P2PMessage, 'id' | 'isRead'>): Promise<void> {
    this.messages.push({
      ...msg,
      id: crypto.randomUUID(),
      isRead: false
    });
    if (!msg.isRead) this.unreadCount++;
  }

  async getMessages(): Promise<P2PMessage[]> {
    return [...this.messages].sort((a, b) => b.timestamp - a.timestamp);
  }

  async markRead(id: string): Promise<void> {
    const msg = this.messages.find(m => m.id === id);
    if (msg && !msg.isRead) {
      msg.isRead = true;
      this.unreadCount = Math.max(0, this.unreadCount - 1);
    }
  }

  async markAllRead(): Promise<void> {
    this.messages.forEach(m => m.isRead = true);
    this.unreadCount = 0;
  }

  getUnreadCount(): number {
    return this.unreadCount;
  }

  // ==================== 离线队列 ====================

  async addToQueue(msg: Omit<OfflineMessage, 'id' | 'createdAt' | 'retryCount' | 'status'>): Promise<string> {
    const id = crypto.randomUUID();
    this.offlineQueue.push({
      ...msg,
      id,
      createdAt: Date.now(),
      retryCount: 0,
      status: 'pending'
    });
    return id;
  }

  async getQueue(): Promise<OfflineMessage[]> {
    return [...this.offlineQueue];
  }

  async updateQueueMessage(id: string, updates: Partial<OfflineMessage>): Promise<void> {
    const msg = this.offlineQueue.find(m => m.id === id);
    if (msg) {
      Object.assign(msg, updates);
    }
  }

  async removeFromQueue(id: string): Promise<void> {
    this.offlineQueue = this.offlineQueue.filter(m => m.id !== id);
  }

  async getQueueCount(): Promise<number> {
    return this.offlineQueue.length;
  }

  // ==================== 偏好设置 ====================

  getPreferences(): P2PPreferences {
    return { ...this.preferences };
  }

  setPreferences(prefs: Partial<P2PPreferences>): void {
    this.preferences = { ...this.preferences, ...prefs };
  }

  // ==================== 导出/清除 ====================

  exportData(): string {
    return JSON.stringify({
      history: this.history,
      messages: this.messages,
      preferences: this.preferences
    }, null, 2);
  }

  clear(): void {
    this.history = [];
    this.messages = [];
    this.offlineQueue = [];
    this.unreadCount = 0;
  }
}

// 全局单例
export const p2pStore = new P2PStoreMemory();