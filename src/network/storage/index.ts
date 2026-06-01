/**
 * Storage Layer Entry Point
 * 导出消息存储工厂函数和类型
 */

import type {
  MessageStore,
  StoredMessage,
  OfflineMessage,
  PendingResponse,
  LocalPendingRequest,
  MessageQueryOptions,
  StorageConfig,
  MessageDirection,
  MessageStatus,
  TransportType,
  IrohPeer,
  IrohMessage,
  IrohMessageHandler,
} from './types.js';
import { DEFAULT_STORAGE_CONFIG } from './types.js';

export type {
  MessageStore,
  StoredMessage,
  OfflineMessage,
  PendingResponse,
  LocalPendingRequest,
  MessageQueryOptions,
  StorageConfig,
  MessageDirection,
  MessageStatus,
  TransportType,
  IrohPeer,
  IrohMessage,
  IrohMessageHandler,
};

export { DEFAULT_STORAGE_CONFIG };

import { JsonMessageStore } from './adapters/json-adapter.js';
import * as path from 'path';

// 默认存储配置
const DEFAULT_BASE_DIR = path.join(
  process.env.HOME || '/tmp',
  '.bolloon',
  'messages'
);

/**
 * 创建消息存储实例
 * @param transport 传输类型 ('iroh' | 'libp2p')
 * @param config 存储配置
 * @returns MessageStore 实例
 */
export async function createMessageStore(
  transport: 'iroh' | 'libp2p' = 'libp2p',
  config?: Partial<StorageConfig>
): Promise<MessageStore> {
  const fullConfig: StorageConfig = {
    baseDir: config?.baseDir || DEFAULT_BASE_DIR,
    maxFileSize: config?.maxFileSize || 10 * 1024 * 1024,
    maxMessagesPerFile: config?.maxMessagesPerFile || 1000,
    fileNamingStrategy: config?.fileNamingStrategy || 'daily',
    maxAge: config?.maxAge || 30 * 24 * 60 * 60 * 1000,
  };

  const store = new JsonMessageStore(fullConfig);
  await store.initialize();

  console.log(`[Storage] Created ${transport} message store at ${fullConfig.baseDir}`);
  return store;
}

/**
 * 创建离线消息存储（无持久化，仅内存）
 * 用于不需要消息历史的轻量级场景
 */
export function createInMemoryStore(): MessageStore {
  const messages: Map<string, StoredMessage> = new Map();
  const offlineQueues: Map<string, OfflineMessage[]> = new Map();
  const pendingResponses: Map<string, PendingResponse> = new Map();

  return {
    async saveMessage(msg) {
      const id = crypto.randomUUID();
      const stored = { ...msg, id };
      messages.set(id, stored);
      return stored;
    },

    async getMessage(id) {
      return messages.get(id) || null;
    },

    async updateMessageStatus(id, status) {
      const msg = messages.get(id);
      if (msg) {
        msg.status = status;
        messages.set(id, msg);
      }
    },

    async getMessages(options) {
      let result = Array.from(messages.values());
      if (options?.direction) result = result.filter(m => m.direction === options.direction);
      if (options?.type) result = result.filter(m => m.type === options.type);
      if (options?.from) result = result.filter(m => m.from === options.from);
      if (options?.to) result = result.filter(m => m.to === options.to);
      if (options?.startTime) result = result.filter(m => m.timestamp >= options.startTime!);
      if (options?.endTime) result = result.filter(m => m.timestamp <= options.endTime!);
      if (options?.status) result = result.filter(m => m.status === options.status);
      result.sort((a, b) => b.timestamp - a.timestamp);
      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);
      return result;
    },

    async deleteMessage(id) {
      messages.delete(id);
    },

    async enqueueOfflineMessage(msg) {
      const id = crypto.randomUUID();
      const offline = { ...msg, id };
      const queue = offlineQueues.get(msg.targetNodeId) || [];
      queue.push(offline);
      offlineQueues.set(msg.targetNodeId, queue);
      return offline;
    },

    async getOfflineMessages(targetNodeId) {
      return offlineQueues.get(targetNodeId) || [];
    },

    async dequeueOfflineMessage(id) {
      for (const [nodeId, queue] of offlineQueues.entries()) {
        const idx = queue.findIndex(m => m.id === id);
        if (idx >= 0) {
          queue.splice(idx, 1);
          offlineQueues.set(nodeId, queue);
          return;
        }
      }
    },

    async incrementOfflineRetry(id) {
      for (const queue of offlineQueues.values()) {
        const msg = queue.find(m => m.id === id);
        if (msg) {
          msg.retryCount++;
          return;
        }
      }
    },

    async getPendingOfflineCount() {
      let count = 0;
      for (const queue of offlineQueues.values()) {
        count += queue.length;
      }
      return count;
    },

    async savePendingResponse(req) {
      const id = crypto.randomUUID();
      const pending = { ...req, id };
      pendingResponses.set(req.requestId, pending);
      return pending;
    },

    async getPendingResponse(requestId) {
      return pendingResponses.get(requestId) || null;
    },

    async removePendingResponse(requestId) {
      pendingResponses.delete(requestId);
    },

    async getMessageCount() {
      return messages.size;
    },

    async getOfflineMessageCount() {
      return this.getPendingOfflineCount();
    },

    async pruneOldMessages() {
      return 0;
    },

    async initialize() {},
    async shutdown() {
      messages.clear();
      offlineQueues.clear();
      pendingResponses.clear();
    },
  };
}

// 导入 crypto 用于内存存储的 ID 生成
import * as crypto from 'crypto';