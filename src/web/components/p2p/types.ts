/**
 * P2P 模块类型定义
 */

// 身份信息
export interface P2PIdentity {
  did: string;
  cid: string;
  irohNodeId: string;
  name: string;
}

// 连接状态
export enum ConnectionStatus {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  OFFLINE = 'offline',
  ERROR = 'error'
}

// 消息状态
export enum MessageStatus {
  PENDING = 'pending',
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
  QUEUED = 'queued'
}

// 连接历史条目
export interface ConnectionHistoryEntry {
  id: string;
  did: string;
  name: string;
  cid: string;
  irohNodeId: string;
  lastConnectedAt: number;
  lastMessageAt: number;
  totalMessages: number;
  isPinned: boolean;
  tags: string[];
}

// P2P 消息
export interface P2PMessage {
  id: string;
  fromDid: string;
  fromName: string;
  content: string;
  type: 'chat' | 'ai-dialogue' | 'file';
  timestamp: number;
  status: MessageStatus;
  isRead: boolean;
}

// 离线消息
export interface OfflineMessage {
  id: string;
  targetDid: string;
  targetNodeId: string;
  content: string;
  type: 'chat' | 'ai-dialogue' | 'file';
  createdAt: number;
  retryCount: number;
  status: 'pending' | 'sending' | 'sent' | 'failed';
}

// 偏好设置
export interface P2PPreferences {
  autoReconnect: boolean;
  autoConnectOnStartup: boolean;
  maxRetries: number;
  notifications: {
    newMessage: boolean;
    connectionEstablished: boolean;
  };
}

// 连接结果
export interface ConnectResult {
  success: boolean;
  error?: string;
  name?: string;
  did?: string;
  cid?: string;
  irohNodeId?: string;
}

// 连接进度
export interface ConnectProgress {
  stage: string;
  percent: number;
  message: string;
}

// 输入解析结果
export interface ParsedInput {
  type: 'cid' | 'link' | 'diapDoc' | 'invalid';
  value?: string | { did?: string; cid?: string };
  error?: string;
}

// 已连接节点
export interface ConnectedPeer {
  nodeId: string;
  status: ConnectionStatus;
  info: any;
  lastSeen: number;
}