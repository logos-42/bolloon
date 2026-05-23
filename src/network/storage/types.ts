/**
 * Storage Layer Type Definitions
 * 消息持久化和离线消息队列的类型定义
 */

import type { Connection } from '@rayhanadev/iroh';

// ============================================================================
// 消息方向和状态
// ============================================================================

export type MessageDirection = 'sent' | 'received';
export type MessageStatus = 'pending' | 'delivered' | 'failed';
export type TransportType = 'iroh' | 'libp2p';

// ============================================================================
// 存储的消息结构
// ============================================================================

export interface StoredMessage {
  id: string;
  direction: MessageDirection;
  type: string;
  payload: string;  // Base64 编码
  from: string;     // DID 或 NodeId
  to: string;       // DID 或 NodeId
  timestamp: number;
  status: MessageStatus;
  retryCount: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 离线消息队列
// ============================================================================

export interface OfflineMessage {
  id: string;
  targetNodeId: string;
  type: string;
  payload: string;  // Base64 编码
  createdAt: number;
  transport: TransportType;
  retryCount: number;
}

// ============================================================================
// 待响应请求
// ============================================================================

export interface PendingResponse {
  id: string;
  requestId: string;
  type: string;
  payload: string;
  fromNodeId: string;
  timestamp: number;
  timeout: number;  // 超时时间 (ms)
}

// ============================================================================
// 本地待响应请求（内存中）
// ============================================================================

export interface LocalPendingRequest {
  requestId: string;
  type: string;
  payload: string;
  timestamp: number;
  resolve: (response: Uint8Array) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ============================================================================
// 消息历史查询选项
// ============================================================================

export interface MessageQueryOptions {
  direction?: MessageDirection;
  type?: string;
  from?: string;
  to?: string;
  startTime?: number;
  endTime?: number;
  status?: MessageStatus;
  limit?: number;
  offset?: number;
}

// ============================================================================
// 存储配置
// ============================================================================

export interface StorageConfig {
  baseDir: string;
  maxFileSize?: number;       // 单个文件最大大小，默认 10MB
  maxMessagesPerFile?: number; // 单个文件最大消息数，默认 1000
  fileNamingStrategy?: 'daily' | 'monthly' | 'by-node';
  maxAge?: number;           // 消息最大保留时间，默认 30 天
}

// ============================================================================
// MessageStore 接口
// ============================================================================

export interface MessageStore {
  // 消息持久化
  saveMessage(msg: Omit<StoredMessage, 'id'>): Promise<StoredMessage>;
  getMessage(id: string): Promise<StoredMessage | null>;
  updateMessageStatus(id: string, status: MessageStatus): Promise<void>;
  getMessages(options?: MessageQueryOptions): Promise<StoredMessage[]>;
  deleteMessage(id: string): Promise<void>;

  // 离线消息队列
  enqueueOfflineMessage(msg: Omit<OfflineMessage, 'id'>): Promise<OfflineMessage>;
  getOfflineMessages(targetNodeId: string): Promise<OfflineMessage[]>;
  dequeueOfflineMessage(id: string): Promise<void>;
  incrementOfflineRetry(id: string): Promise<void>;
  getPendingOfflineCount(): Promise<number>;

  // 待响应请求
  savePendingResponse(req: Omit<PendingResponse, 'id'>): Promise<PendingResponse>;
  getPendingResponse(requestId: string): Promise<PendingResponse | null>;
  removePendingResponse(requestId: string): Promise<void>;

  // 统计与清理
  getMessageCount(): Promise<number>;
  getOfflineMessageCount(): Promise<number>;
  pruneOldMessages(maxAgeMs: number): Promise<number>;

  // 生命周期
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

// ============================================================================
// Iroh 相关类型
// ============================================================================

export interface IrohPeer {
  nodeId: string;
  lastSeen: number;
  connected: boolean;
}

export interface IrohMessage {
  type: string;
  payload: Uint8Array;
  from: string;
  requestId?: string;
}

export type IrohMessageHandler = (msg: IrohMessage) => void;

// ============================================================================
// 导出默认配置
// ============================================================================

export const DEFAULT_STORAGE_CONFIG: Required<StorageConfig> = {
  baseDir: '',
  maxFileSize: 10 * 1024 * 1024,  // 10MB
  maxMessagesPerFile: 1000,
  fileNamingStrategy: 'daily',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};