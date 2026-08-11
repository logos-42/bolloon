/**
 * server-types.ts — server.ts 拆出的纯类型 + 常量 + 路径
 *
 * 从 src/web/server.ts 抽出 (2026-07-06).
 * 0 副作用, 0 模块级 state, 只放 type / interface / const 路径.
 */

import * as path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';

export const SHARED_SESSION_PATH = path.join(HOME, '.bolloon', 'sessions');
export const SESSION_CACHE_PATH = path.join(SHARED_SESSION_PATH, 'cache');
export const CHANNELS_PATH = path.join(SHARED_SESSION_PATH, 'channels.json');
export const THEME_PATH = path.join(SHARED_SESSION_PATH, 'theme.json');
export const TASK_QUEUE_PATH = path.join(SHARED_SESSION_PATH, 'task-queue.json');
export const IPFS_ENDPOINT = 'http://127.0.0.1:5001';
export const REMOTE_CACHE_FILE = path.join(HOME, '.bolloon', 'remote-channels-cache.json');

export interface IrohNodeInfo {
  did: string;
  cid: string;
  irohNodeId: string;
  name: string;
  initialized: boolean;
}

export interface Channel {
  id: string;
  name: string;
  agentId: string;
  did?: string;
  persona?: {
    name?: string;
    description?: string;
    personality?: string;
    greeting?: string;
    capabilities?: string[];
    interests?: string[];
  };
  linkedDocumentIds?: string[];
  publicKey?: string;
  cid?: string;
  didDocRef?: { cid?: string; ipnsName?: string };
  walletAddress?: string;
  walletRegisteredAt?: string;
  walletBinding?: {
    address: string;
    signature: string;
    message: string;
    did: string;
    signedAt: string;
  };
  /** 加密后的私钥 (AES-GCM, 密钥派生自用户 DID), 用于 x402 自动支付 */
  encryptedPrivateKey?: string;
  /** 私钥加密时的 IV (base64), 用于解密 */
  encryptedPrivateKeyIv?: string;
  /** 是否允许智能体自动使用钱包支付 (默认 false) */
  autoPayEnabled?: boolean;
  autoInvokeTools?: boolean;
  createdAt: string;
  updatedAt: string;
  currentSessionId?: string;
  sessions?: SessionSummary[];
  bound_judgment_ids?: string[];
  shared_with_peers?: string[];
  share_id?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  messageCount: number;
  preview: string;
}

export interface SessionMessage {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: string;
  source?: 'local' | 'remote' | 'ai-mention' | 'ai-mention-remote';
  fromPublicKey?: string;
  originChannelId?: string;
  originChannelName?: string;
}

export interface Session {
  channelId: string;
  sessionId: string;
  messages: SessionMessage[];
  lastUpdated: string;
}

export interface Task {
  id: string;
  type: 'read' | 'summarize' | 'improve' | 'chat';
  title: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancel-requested' | 'cancelled' | 'review';
  progress: number;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** 2026-08-11: 父任务依赖 (认领点强制校验, Hermes kanban 模式) */
  parentIds?: string[];
  /** 2026-08-11: 认领过期时间戳 (ms epoch) — 心跳续期, TTL 过期自动释放 (Hermes claim_expires) */
  claimExpires?: number;
  /** 2026-08-11: 连续失败计数 (熔断器, Hermes consecutive_failures) — 失败递增, 成功清零 */
  consecutiveFailures?: number;
  /** 2026-08-11: 熔断阈值 (per-task 覆盖, 默认 BOLLOON_FAILURE_LIMIT=3) */
  failureLimit?: number;
  /** 最近一次失败的错误摘要 */
  lastFailureError?: string;
  /** 2026-08-11: 完成防幻觉校验的 advisory warning 列表 (Hermes suspected_hallucinated_references) */
  warnings?: string[];
  steps?: any[];
  currentStep?: number;
}

export interface SSEClient {
  res: any;
  channelId?: string;
}

export interface CreateWebServerOptions {
  selfImprove?: boolean;
  host?: string;
}
