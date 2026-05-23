/**
 * JSON File Adapter for MessageStore
 * 基于 JSON 文件的消息存储实现
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as fsSync from 'fs';
import * as crypto from 'crypto';

import type {
  MessageStore,
  StoredMessage,
  OfflineMessage,
  PendingResponse,
  MessageQueryOptions,
  StorageConfig,
  MessageStatus,
} from './types.js';

const DEFAULT_CONFIG: Required<StorageConfig> = {
  baseDir: '',
  maxFileSize: 10 * 1024 * 1024,  // 10MB
  maxMessagesPerFile: 1000,
  fileNamingStrategy: 'daily',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

interface FileLock {
  release: () => void;
}

export class JsonMessageStore implements MessageStore {
  private config: Required<StorageConfig>;
  private initialized: boolean = false;
  private offlineMessages: Map<string, OfflineMessage[]> = new Map();
  private pendingResponses: Map<string, PendingResponse> = new Map();
  private locks: Map<string, Promise<FileLock>> = new Map();

  constructor(config: StorageConfig) {
    // 设置默认基础路径
    const baseDir = config.baseDir || path.join(process.env.HOME || '/tmp', '.bolloon', 'messages');
    this.config = { ...DEFAULT_CONFIG, ...config, baseDir };
  }

  async initialize(): Promise<void> {
    // 创建必要的目录
    await fs.mkdir(this.config.baseDir, { recursive: true });
    await fs.mkdir(path.join(this.config.baseDir, 'offline'), { recursive: true });
    await fs.mkdir(path.join(this.config.baseDir, 'pending'), { recursive: true });

    // 加载离线消息
    await this.loadOfflineMessages();

    // 加载待响应请求
    await this.loadPendingResponses();

    this.initialized = true;
    console.log(`[JsonMessageStore] Initialized at ${this.config.baseDir}`);
  }

  // ============================================================================
  // 消息持久化
  // ============================================================================

  async saveMessage(msg: Omit<StoredMessage, 'id'>): Promise<StoredMessage> {
    const id = crypto.randomUUID();
    const stored: StoredMessage = { ...msg, id };
    const filePath = this.getMessageFilePath(new Date(msg.timestamp));

    await this.withLock(filePath, async () => {
      const messages = await this.readJsonFile<StoredMessage[]>(filePath) || [];
      messages.push(stored);

      // 如果文件过大，拆分
      if (messages.length > this.config.maxMessagesPerFile) {
        const newFile = this.getMessageFilePath(new Date(), true);
        await this.writeJsonFile(newFile, messages.slice(this.config.maxMessagesPerFile / 2));
        messages = messages.slice(0, this.config.maxMessagesPerFile / 2);
      }

      await this.writeJsonFile(filePath, messages);
    });

    return stored;
  }

  async getMessage(id: string): Promise<StoredMessage | null> {
    const allMessages = await this.getAllMessageFiles();
    for (const file of allMessages) {
      const messages = await this.readJsonFile<StoredMessage[]>(file) || [];
      const found = messages.find(m => m.id === id);
      if (found) return found;
    }
    return null;
  }

  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    const allFiles = await this.getAllMessageFiles();
    for (const file of allFiles) {
      const messages = await this.readJsonFile<StoredMessage[]>(file);
      if (!messages) continue;

      const idx = messages.findIndex(m => m.id === id);
      if (idx >= 0) {
        messages[idx].status = status;
        await this.writeJsonFile(file, messages);
        return;
      }
    }
  }

  async getMessages(options?: MessageQueryOptions): Promise<StoredMessage[]> {
    const allMessages: StoredMessage[] = [];
    const files = await this.getAllMessageFiles();

    for (const file of files) {
      const messages = await this.readJsonFile<StoredMessage[]>(file) || [];
      allMessages.push(...messages);
    }

    // 过滤
    let filtered = allMessages;

    if (options?.direction) {
      filtered = filtered.filter(m => m.direction === options.direction);
    }
    if (options?.type) {
      filtered = filtered.filter(m => m.type === options.type);
    }
    if (options?.from) {
      filtered = filtered.filter(m => m.from === options.from);
    }
    if (options?.to) {
      filtered = filtered.filter(m => m.to === options.to);
    }
    if (options?.startTime) {
      filtered = filtered.filter(m => m.timestamp >= options.startTime!);
    }
    if (options?.endTime) {
      filtered = filtered.filter(m => m.timestamp <= options.endTime!);
    }
    if (options?.status) {
      filtered = filtered.filter(m => m.status === options.status);
    }

    // 排序和分页
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    if (options?.offset) {
      filtered = filtered.slice(options.offset);
    }
    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  async deleteMessage(id: string): Promise<void> {
    const allFiles = await this.getAllMessageFiles();
    for (const file of allFiles) {
      const messages = await this.readJsonFile<StoredMessage[]>(file);
      if (!messages) continue;

      const idx = messages.findIndex(m => m.id === id);
      if (idx >= 0) {
        messages.splice(idx, 1);
        await this.writeJsonFile(file, messages);
        return;
      }
    }
  }

  // ============================================================================
  // 离线消息队列
  // ============================================================================

  async enqueueOfflineMessage(msg: Omit<OfflineMessage, 'id'>): Promise<OfflineMessage> {
    const id = crypto.randomUUID();
    const offline: OfflineMessage = { ...msg, id };

    // 更新内存缓存
    const queue = this.offlineMessages.get(msg.targetNodeId) || [];
    queue.push(offline);
    this.offlineMessages.set(msg.targetNodeId, queue);

    // 持久化到文件
    const filePath = this.getOfflineFilePath(msg.targetNodeId);
    await this.writeJsonFile(filePath, queue);

    console.log(`[JsonMessageStore] Enqueued offline message for ${msg.targetNodeId}`);
    return offline;
  }

  async getOfflineMessages(targetNodeId: string): Promise<OfflineMessage[]> {
    // 优先从内存返回
    if (this.offlineMessages.has(targetNodeId)) {
      return this.offlineMessages.get(targetNodeId)!;
    }

    // 从文件加载
    const filePath = this.getOfflineFilePath(targetNodeId);
    const messages = await this.readJsonFile<OfflineMessage[]>(filePath) || [];
    this.offlineMessages.set(targetNodeId, messages);
    return messages;
  }

  async dequeueOfflineMessage(id: string): Promise<void> {
    for (const [targetId, queue] of this.offlineMessages.entries()) {
      const idx = queue.findIndex(m => m.id === id);
      if (idx >= 0) {
        queue.splice(idx, 1);
        this.offlineMessages.set(targetId, queue);
        await this.writeJsonFile(this.getOfflineFilePath(targetId), queue);
        return;
      }
    }
  }

  async incrementOfflineRetry(id: string): Promise<void> {
    for (const [targetId, queue] of this.offlineMessages.entries()) {
      const idx = queue.findIndex(m => m.id === id);
      if (idx >= 0) {
        queue[idx].retryCount++;
        this.offlineMessages.set(targetId, queue);
        await this.writeJsonFile(this.getOfflineFilePath(targetId), queue);
        return;
      }
    }
  }

  async getPendingOfflineCount(): Promise<number> {
    let count = 0;
    for (const queue of this.offlineMessages.values()) {
      count += queue.length;
    }
    return count;
  }

  // ============================================================================
  // 待响应请求
  // ============================================================================

  async savePendingResponse(req: Omit<PendingResponse, 'id'>): Promise<PendingResponse> {
    const id = crypto.randomUUID();
    const pending: PendingResponse = { ...req, id };

    this.pendingResponses.set(req.requestId, pending);
    await this.savePendingResponsesToFile();

    console.log(`[JsonMessageStore] Saved pending response ${req.requestId}`);
    return pending;
  }

  async getPendingResponse(requestId: string): Promise<PendingResponse | null> {
    // 优先从内存返回
    if (this.pendingResponses.has(requestId)) {
      return this.pendingResponses.get(requestId)!;
    }

    // 尝试从文件恢复
    await this.loadPendingResponses();
    return this.pendingResponses.get(requestId) || null;
  }

  async removePendingResponse(requestId: string): Promise<void> {
    this.pendingResponses.delete(requestId);
    await this.savePendingResponsesToFile();
  }

  // ============================================================================
  // 统计与清理
  // ============================================================================

  async getMessageCount(): Promise<number> {
    const files = await this.getAllMessageFiles();
    let count = 0;
    for (const file of files) {
      const messages = await this.readJsonFile<StoredMessage[]>(file);
      if (messages) count += messages.length;
    }
    return count;
  }

  async getOfflineMessageCount(): Promise<number> {
    return this.getPendingOfflineCount();
  }

  async pruneOldMessages(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    const files = await this.getAllMessageFiles();

    for (const file of files) {
      const messages = await this.readJsonFile<StoredMessage[]>(file);
      if (!messages) continue;

      const originalLen = messages.length;
      const filtered = messages.filter(m => m.timestamp >= cutoff || m.status === 'pending');

      if (filtered.length < originalLen) {
        pruned += originalLen - filtered.length;
        await this.writeJsonFile(file, filtered);
      }
    }

    console.log(`[JsonMessageStore] Pruned ${pruned} old messages`);
    return pruned;
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  async shutdown(): Promise<void> {
    // 保存所有待处理数据
    await this.savePendingResponsesToFile();

    for (const [targetId, queue] of this.offlineMessages.entries()) {
      if (queue.length > 0) {
        await this.writeJsonFile(this.getOfflineFilePath(targetId), queue);
      }
    }

    this.initialized = false;
    console.log('[JsonMessageStore] Shutdown complete');
  }

  // ============================================================================
  // 私有辅助方法
  // ============================================================================

  private getMessageFilePath(date: Date, useNewFile = false): string {
    const dateStr = this.config.fileNamingStrategy === 'daily'
      ? date.toISOString().split('T')[0]
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    const filename = useNewFile
      ? `messages-${dateStr}-${Date.now()}.json`
      : `messages-${dateStr}.json`;

    return path.join(this.config.baseDir, filename);
  }

  private getOfflineFilePath(nodeId: string): string {
    // 清理 nodeId 中的非法字符
    const safeId = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.config.baseDir, 'offline', `${safeId}.json`);
  }

  private getPendingFilePath(): string {
    return path.join(this.config.baseDir, 'pending', 'responses.json');
  }

  private async getAllMessageFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.config.baseDir);
      return files
        .filter(f => f.startsWith('messages-') && f.endsWith('.json'))
        .map(f => path.join(this.config.baseDir, f));
    } catch {
      return [];
    }
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonFile(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async loadOfflineMessages(): Promise<void> {
    const offlineDir = path.join(this.config.baseDir, 'offline');
    try {
      const files = await fs.readdir(offlineDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const nodeId = file.replace('.json', '');
        const messages = await this.readJsonFile<OfflineMessage[]>(path.join(offlineDir, file));
        if (messages) {
          this.offlineMessages.set(nodeId, messages);
        }
      }
    } catch {
      // 目录不存在或为空
    }
  }

  private async loadPendingResponses(): Promise<void> {
    const filePath = this.getPendingFilePath();
    const data = await this.readJsonFile<PendingResponse[]>(filePath);
    if (data) {
      for (const req of data) {
        this.pendingResponses.set(req.requestId, req);
      }
    }
  }

  private async savePendingResponsesToFile(): Promise<void> {
    const data = Array.from(this.pendingResponses.values());
    await this.writeJsonFile(this.getPendingFilePath(), data);
  }

  private async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    // 简化的文件锁实现
    const lockKey = filePath;

    // 等待现有锁
    while (this.locks.has(lockKey)) {
      await this.locks.get(lockKey);
    }

    // 获取新锁
    let releaseLock: () => void;
    const lockPromise = new Promise<FileLock>((resolve) => {
      releaseLock = () => {
        this.locks.delete(lockKey);
        resolve({ release: () => {} });
      };
    });
    this.locks.set(lockKey, lockPromise);

    try {
      return await fn();
    } finally {
      releaseLock!();
    }
  }
}