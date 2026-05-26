/**
 * P2P 消息管理
 */

import type { P2PMessage } from './types.js';
import { MessageStatus } from './types.js';
import { p2pStore } from './p2p-store-memory.js';

interface PendingMessage {
  status: MessageStatus;
  retries: number;
  createdAt: number;
  content: string;
  targetNodeId: string;
}

export class P2PMessagesManager {
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private messageHandlers: Array<(msg: P2PMessage) => void> = [];
  private sseConnected: boolean = false;
  private eventSource: EventSource | null = null;
  private maxRetries: number = 3;

  // 发送消息
  async send(content: string, targetNodeId: string): Promise<{ success: boolean; messageId: string; queued?: boolean }> {
    const messageId = crypto.randomUUID();

    this.pendingMessages.set(messageId, {
      status: MessageStatus.SENDING,
      retries: 0,
      createdAt: Date.now(),
      content,
      targetNodeId
    });

    try {
      const res = await fetch('/api/message-p2p', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: messageId,
          type: 'chat',
          content,
          target: targetNodeId || 'broadcast',
          requireReceipt: true
        })
      });

      if (res.ok) {
        this.updateStatus(messageId, MessageStatus.SENT);
        return { success: true, messageId };
      } else {
        await this.queueMessage(content, targetNodeId);
        this.updateStatus(messageId, MessageStatus.QUEUED);
        return { success: false, messageId, queued: true };
      }
    } catch (e) {
      await this.queueMessage(content, targetNodeId);
      this.updateStatus(messageId, MessageStatus.QUEUED);
      return { success: false, messageId, queued: true };
    }
  }

  private async queueMessage(content: string, targetNodeId: string): Promise<void> {
    await p2pStore.addToQueue({
      targetDid: targetNodeId,
      targetNodeId: targetNodeId,
      type: 'chat',
      content
    });
  }

  // 重试失败的消息
  async retry(messageId: string): Promise<{ success: boolean; error?: string }> {
    const msg = this.pendingMessages.get(messageId);
    if (!msg) return { success: false, error: '消息不存在' };

    if (msg.retries >= this.maxRetries) {
      this.updateStatus(messageId, MessageStatus.FAILED);
      return { success: false, error: '超过最大重试次数' };
    }

    const result = await this.send(msg.content, msg.targetNodeId);
    return { success: result.success };
  }

  // 获取消息状态
  getStatus(messageId: string): PendingMessage | undefined {
    return this.pendingMessages.get(messageId);
  }

  private updateStatus(messageId: string, status: MessageStatus): void {
    const msg = this.pendingMessages.get(messageId);
    if (msg) {
      msg.status = status;
      if (status === MessageStatus.SENT || status === MessageStatus.QUEUED) {
        msg.retries++;
      }
    }
  }

  // 监听消息
  onMessage(handler: (msg: P2PMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  // 移除监听
  offMessage(handler: (msg: P2PMessage) => void): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index > -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  // 启动 SSE 监听
  startListening(): void {
    if (this.sseConnected) return;

    this.eventSource = new EventSource('/events?channelId=p2p-global');
    this.sseConnected = true;

    this.eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === 'p2p_message') {
          const content = typeof data.content === 'string'
            ? data.content
            : JSON.stringify(data.content);

          const msg: P2PMessage = {
            id: crypto.randomUUID(),
            fromDid: data.from,
            fromName: data.fromName || 'Unknown',
            content: content,
            type: data.messageType || 'chat',
            timestamp: data.timestamp || Date.now(),
            status: MessageStatus.DELIVERED,
            isRead: false
          };

          // 保存到存储
          p2pStore.addMessage({
            fromDid: msg.fromDid,
            fromName: msg.fromName,
            content: msg.content,
            type: msg.type,
            timestamp: msg.timestamp,
            status: msg.status
          });

          // 更新连接历史
          p2pStore.getHistory().then(history => {
            const entry = history.find(h => h.did === msg.fromDid);
            if (entry) {
              p2pStore.updateHistory(entry.id, {
                lastMessageAt: msg.timestamp,
                totalMessages: (entry.totalMessages || 0) + 1
              });
            }
          });

          // 通知所有处理器
          this.messageHandlers.forEach(handler => {
            try {
              handler(msg);
            } catch (e) {
              console.error('[P2P Messages] 处理错误:', e);
            }
          });
        }
      } catch {}
    };

    this.eventSource.onerror = () => {
      console.log('[P2P Messages] SSE 断开，5秒后重连...');
      this.sseConnected = false;
      setTimeout(() => this.startListening(), 5000);
    };
  }

  // 获取收到的消息
  async getReceivedMessages(): Promise<P2PMessage[]> {
    return p2pStore.getMessages();
  }

  // 获取未读数
  getUnreadCount(): number {
    return p2pStore.getUnreadCount();
  }

  // 标记消息已读
  async markRead(id: string): Promise<void> {
    await p2pStore.markRead(id);
  }

  // 标记全部已读
  async markAllRead(): Promise<void> {
    await p2pStore.markAllRead();
  }

  // 获取离线队列
  async getOfflineQueue() {
    return p2pStore.getQueue();
  }

  // 销毁
  destroy(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.sseConnected = false;
    this.pendingMessages.clear();
    this.messageHandlers = [];
  }
}

export const p2pMessages = new P2PMessagesManager();