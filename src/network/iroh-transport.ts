import { Endpoint, Connection } from '@rayhanadev/iroh';
import * as crypto from 'crypto';
import { loadOrCreateIrohSecret } from '../agents/iroh-secret.js';

export interface IrohMessage {
  type: string;
  payload: Uint8Array;
  from: string;
  requestId?: string;
}

export type IrohMessageHandler = (msg: IrohMessage) => void;

const IROH_ALPN = 'bolloon/iroh/1';

export interface IrohPeer {
  nodeId: string;
  lastSeen: number;
  connected: boolean;
}

// 导入存储层类型
interface OfflineMessage {
  id: string;
  targetNodeId: string;
  type: string;
  payload: string;  // Base64
  createdAt: number;
  transport: 'iroh' | 'libp2p';
  retryCount: number;
}

interface PendingResponse {
  id: string;
  requestId: string;
  type: string;
  payload: string;
  fromNodeId: string;
  timestamp: number;
  timeout: number;
}

interface LocalPendingRequest {
  requestId: string;
  type: string;
  payload: Uint8Array;
  timestamp: number;
  resolve: (response: Uint8Array) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface MessageStore {
  saveMessage(msg: any): Promise<any>;
  enqueueOfflineMessage(msg: Omit<OfflineMessage, 'id'>): Promise<OfflineMessage>;
  getOfflineMessages(targetNodeId: string): Promise<OfflineMessage[]>;
  dequeueOfflineMessage(id: string): Promise<void>;
  incrementOfflineRetry(id: string): Promise<void>;
  getPendingOfflineCount(): Promise<number>;
  getAllOfflineTargets(): Promise<string[]>;
  savePendingResponse(req: Omit<PendingResponse, 'id'>): Promise<PendingResponse>;
  getPendingResponse(requestId: string): Promise<PendingResponse | null>;
  removePendingResponse(requestId: string): Promise<void>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export class IrohTransport {
  private endpoint: Endpoint | null = null;
  private messageHandlers: Map<string, IrohMessageHandler> = new Map();
  private running: boolean = false;
  private ownNodeId: string | null = null;
  private peers: Map<string, IrohPeer> = new Map();
  private connectTimeoutMs: number = 10000;
  private acceptLoop: ReturnType<typeof setInterval> | null = null;

  // 新增: 存储层
  private messageStore: MessageStore | null = null;
  private offlineDeliveryInterval: ReturnType<typeof setInterval> | null = null;
  private requestTimeoutMs: number = 30000;

  // 新增: 待响应请求 (内存缓存)
  private pendingRequests: Map<string, LocalPendingRequest> = new Map();
  private requestIdToNodeId: Map<string, string> = new Map();

  async start(secretKey?: string, enablePersistence = false): Promise<{ nodeId: string; addr: string }> {
    if (this.endpoint && this.ownNodeId) {
      // 已启动，返回当前信息
      return {
        nodeId: this.ownNodeId,
        addr: this.ownNodeId // iroh 没有 listenAddresses，用 nodeId 作为 addr
      };
    }

    // 若调用方未传 secretKey，从 ~/.bolloon/iroh-secret-{role}.json 落盘/读取
    // role 可通过 IROH_ROLE 环境变量覆盖, 方便同机起多个实例 (A/B 跨用户测试)
    // 不设 IROH_ROLE 时 = 'default', 与旧行为一致
    if (!secretKey) {
      const role = process.env.IROH_ROLE || 'default';
      try {
        const sec = loadOrCreateIrohSecret(role);
        // iroh binding 的 secretKey 字段是 hex 字符串 (32 字节 Ed25519 种子)
        secretKey = Buffer.from(sec.secretKey).toString('hex');
        console.log(`[IrohTransport] ${sec.reused ? '复用' : '新建'} iroh-secret-${role}.json (createdAt=${sec.createdAt})`);
      } catch (e) {
        console.warn('[IrohTransport] iroh-secret 加载失败, 将使用临时身份:', e);
      }
    }

    const options: any = { alpns: [IROH_ALPN] };
    if (secretKey) {
      options.secretKey = secretKey;
    }

    this.endpoint = await Endpoint.createWithOptions(options);
    this.ownNodeId = this.endpoint.nodeId();
    await this.endpoint.online();
    this.running = true;

    console.log('[IrohTransport] Started, node:', this.ownNodeId.substring(0, 16) + '...');

    // 初始化存储层 (如果启用)
    if (enablePersistence) {
      this.messageStore = await this.createMessageStore();
      await this.messageStore.initialize();
      this.startOfflineDeliveryLoop();
      console.log('[IrohTransport] Persistence enabled');
    }

    this.startAcceptLoop();

    return {
      nodeId: this.endpoint.nodeId(),
      addr: this.ownNodeId // iroh 没有 addr()，用 nodeId
    };
  }

  private async createMessageStore(): Promise<MessageStore> {
    // 动态导入 JSON 存储适配器
    try {
      const { JsonMessageStore } = await import('./storage/adapters/json-adapter.js');
      const path = await import('path');
      const baseDir = path.join(process.env.HOME || '/tmp', '.bolloon', 'messages-iroh');
      return new JsonMessageStore({ baseDir });
    } catch (e) {
      console.warn('[IrohTransport] Failed to load JSON adapter, using in-memory store');
      return this.createInMemoryStore();
    }
  }

  private createInMemoryStore(): MessageStore {
    const offlineQueues: Map<string, OfflineMessage[]> = new Map();
    const pendingResponses: Map<string, PendingResponse> = new Map();

    return {
      async saveMessage() {},
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
        for (const queue of offlineQueues.values()) count += queue.length;
        return count;
      },
      async getAllOfflineTargets() {
        return Array.from(offlineQueues.keys());
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
      async initialize() {},
      async shutdown() {
        offlineQueues.clear();
        pendingResponses.clear();
      },
    };
  }

  private startOfflineDeliveryLoop(): void {
    if (!this.messageStore) return;

    this.offlineDeliveryInterval = setInterval(async () => {
      // 遍历所有有离线消息的目标节点（不仅是"已连接"的）
      // 这样目标节点一旦在线（accept 连接）就能拿到离线消息
      const allTargets = await this.messageStore!.getAllOfflineTargets();
      const connectedPeers = this.getConnectedPeers();
      // 合并：已连接 + 有离线消息但未连接（也会去尝试 connect）
      const targets = new Set<string>([...connectedPeers, ...allTargets]);

      for (const peerId of targets) {
        const offlineMsgs = await this.messageStore!.getOfflineMessages(peerId);

        for (const msg of offlineMsgs) {
          if (msg.retryCount >= 10) {
            // 超过最大重试次数，丢弃
            await this.messageStore!.dequeueOfflineMessage(msg.id);
            console.log(`[IrohTransport] Dropped offline message after ${msg.retryCount} retries`);
            continue;
          }

          try {
            const payload = Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0));
            const success = await this.sendMessageDirect(peerId, msg.type, payload);

            if (success) {
              await this.messageStore!.dequeueOfflineMessage(msg.id);
              console.log(`[IrohTransport] Delivered offline message to ${peerId.substring(0, 12)}...`);
            } else {
              await this.messageStore!.incrementOfflineRetry(msg.id);
            }
          } catch {
            await this.messageStore!.incrementOfflineRetry(msg.id);
          }
        }
      }
    }, 5000);
  }

  private startAcceptLoop(): void {
    if (!this.endpoint) return;

    this.acceptLoop = setInterval(async () => {
      if (!this.endpoint || !this.running) return;

      try {
        const conn = await this.endpoint.accept();
        if (conn) {
          this.handleConnection(conn);
        }
      } catch {
        // Silently ignore during shutdown
      }
    }, 100);
  }

  private async handleConnection(conn: Connection): Promise<void> {
    const remoteNodeId = conn.remoteNodeId();
    this.updatePeer(remoteNodeId, true);

    try {
      const { recv } = await conn.acceptBi();
      const data = await recv.readToEnd(64 * 1024);

      if (data.length > 0) {
        const text = new TextDecoder().decode(data);
        const colonIdx = text.indexOf(':');

        let type: string;
        let payload: Uint8Array;
        let requestId: string | undefined;

        // 检查是否是请求/响应消息
        if (text.startsWith('REQ:')) {
          // Request: REQ:<requestId>:<type>:<payload>
          const parts = text.substring(4).split(':');
          requestId = parts[0];
          type = parts[1] || 'request';
          const payloadStr = parts.slice(2).join(':');
          payload = new TextEncoder().encode(payloadStr);

          // 保存请求信息，以便稍后响应
          if (requestId) {
            this.requestIdToNodeId.set(requestId, remoteNodeId);
          }
        } else if (text.startsWith('RESP:')) {
          // Response: RESP:<requestId>:<payload>
          const parts = text.substring(5).split(':');
          requestId = parts[0];
          type = 'RESPONSE';
          payload = new TextEncoder().encode(parts.slice(1).join(':'));

          // 处理响应 - 解决 pending request
          this.handleResponse(requestId!, payload);
        } else {
          type = colonIdx > 0 ? text.substring(0, colonIdx) : 'raw';
          payload = new TextEncoder().encode(text.substring(colonIdx + 1));
        }

        const handler = this.messageHandlers.get(type);
        if (handler) {
          handler({ type, payload, from: remoteNodeId, requestId });
        } else if (this.messageHandlers.has('*')) {
          this.messageHandlers.get('*')!({ type, payload, from: remoteNodeId, requestId });
        }
      }
    } catch {
      // Connection closed
    } finally {
      try { conn.close(); } catch {}
    }
  }

  private handleResponse(requestId: string, responseData: Uint8Array): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(responseData);
      this.pendingRequests.delete(requestId);
      console.log(`[IrohTransport] Response received for request ${requestId}`);
    }

    // 如果有持久化存储，也从那里删除
    if (this.messageStore) {
      this.messageStore.removePendingResponse(requestId);
    }
  }

  private updatePeer(nodeId: string, connected: boolean): void {
    const existing = this.peers.get(nodeId);
    this.peers.set(nodeId, {
      nodeId,
      lastSeen: Date.now(),
      connected: existing?.connected || connected,
    });
  }

  async connect(targetNodeId: string): Promise<boolean> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    try {
      const conn = await this.connectWithTimeout(targetNodeId);
      if (!conn) {
        console.warn('[IrohTransport] Connection timeout to', targetNodeId.substring(0, 12) + '...');
        return false;
      }

      this.updatePeer(targetNodeId, true);
      conn.close();
      return true;
    } catch (e) {
      console.warn('[IrohTransport] Connect failed:', e);
      return false;
    }
  }

  private async connectWithTimeout(nodeId: string): Promise<any> {
    if (!this.endpoint) return null;

    const connectPromise = this.endpoint.connect(nodeId, IROH_ALPN);
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), this.connectTimeoutMs)
    );

    return Promise.race([connectPromise, timeout]);
  }

  async sendMessage(targetNodeId: string, type: string, payload: Uint8Array): Promise<boolean> {
    const success = await this.sendMessageDirect(targetNodeId, type, payload);

    // 如果发送失败且启用了持久化，存入离线队列
    if (!success && this.messageStore) {
      console.log(`[IrohTransport] Message send failed, enqueuing for offline delivery`);
      const payloadBase64 = btoa(String.fromCharCode(...payload));

      await this.messageStore.enqueueOfflineMessage({
        targetNodeId,
        type,
        payload: payloadBase64,
        createdAt: Date.now(),
        transport: 'iroh',
        retryCount: 0,
      });
    }

    return success;
  }

  private async sendMessageDirect(targetNodeId: string, type: string, payload: Uint8Array): Promise<boolean> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    try {
      const conn = await this.connectWithTimeout(targetNodeId);
      if (!conn) {
        return false;
      }

      const { send } = await conn.openBi();
      const message = type + ':' + new TextDecoder().decode(payload);
      await send.writeAll(Buffer.from(message));
      await send.finish();
      conn.close();

      this.updatePeer(targetNodeId, true);
      return true;
    } catch (e) {
      console.warn('[IrohTransport] Send failed:', e);
      return false;
    }
  }

  async requestResponse(
    targetNodeId: string,
    type: string,
    payload: Uint8Array,
    timeoutMs?: number
  ): Promise<Uint8Array | null> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    const timeout = timeoutMs || this.requestTimeoutMs;
    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        if (this.messageStore) {
          this.messageStore.removePendingResponse(requestId);
        }
        reject(new Error(`Request ${requestId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        requestId,
        type,
        payload,
        timestamp: Date.now(),
        resolve,
        reject,
        timeout: timer,
      });

      // 保存到持久化存储
      if (this.messageStore) {
        await this.messageStore.savePendingResponse({
          requestId,
          type,
          payload: new TextDecoder().decode(payload),
          fromNodeId: this.ownNodeId!,
          timestamp: Date.now(),
          timeout,
        });
      }

      // 尝试发送请求
      try {
        const conn = await this.connectWithTimeout(targetNodeId);
        if (!conn) {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          resolve(null);
          return;
        }

        const { send, recv } = await conn.openBi();
        const requestMsg = `REQ:${requestId}:${type}:${new TextDecoder().decode(payload)}`;
        await send.writeAll(Buffer.from(requestMsg));
        await send.finish();

        // 等待响应，带超时
        // 注意: server sendResponse 后会关闭连接，导致 readToEnd 以 "connection lost" 错误 reject
        // 这里我们把 readToEnd 的错误吞掉（视为流结束），只有超时才视为失败
        const response = await Promise.race([
          recv.readToEnd(64 * 1024).catch(() => new Uint8Array(0)),
          new Promise<null>((_, rejectTimeout) =>
            setTimeout(() => rejectTimeout(new Error('timeout')), timeout)
          ),
        ]);

        conn.close();
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);

        if (this.messageStore) {
          this.messageStore.removePendingResponse(requestId);
        }

        if (response) {
          resolve(response);
        } else {
          resolve(null);
        }
      } catch (e) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(e);
      }
    });
  }

  async sendResponse(requestId: string, type: string, responsePayload: string): Promise<boolean> {
    const targetNodeId = this.requestIdToNodeId.get(requestId);
    if (!targetNodeId) {
      console.warn(`[IrohTransport] No target node for request ${requestId}`);
      return false;
    }

    try {
      const conn = await this.connectWithTimeout(targetNodeId);
      if (!conn) return false;

      const { send } = await conn.openBi();
      const responseMsg = `RESP:${requestId}:${responsePayload}`;
      await send.writeAll(Buffer.from(responseMsg));
      await send.finish();
      conn.close();

      this.requestIdToNodeId.delete(requestId);
      console.log(`[IrohTransport] Sent response for request ${requestId}`);
      return true;
    } catch (e) {
      console.warn(`[IrohTransport] Failed to send response:`, e);
      return false;
    }
  }

  async broadcast(type: string, payload: Uint8Array): Promise<void> {
    const peers = Array.from(this.peers.keys());
    const promises = peers.map((peerId) =>
      this.sendMessage(peerId, type, payload).catch(() => false)
    );
    await Promise.all(promises);
  }

  onMessage(type: string, handler: IrohMessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  getNodeId(): string | null {
    return this.ownNodeId;
  }

  /**
   * v3: 返回 iroh endpoint 完整地址字符串 (含 relay URL)
   * 这是 connect() 真正需要的"网络地址", 光有 nodeId 不足以建连
   * 如果 endpoint 还没 online, 返回纯 nodeId
   */
  getEndpointAddr(): string | null {
    if (!this.endpoint) return null;
    try {
      return this.endpoint.addr();
    } catch (e) {
      return this.endpoint.nodeId();
    }
  }

  getPeers(): IrohPeer[] {
    return Array.from(this.peers.values());
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peers.values())
      .filter((p) => p.connected)
      .map((p) => p.nodeId);
  }

  isRunning(): boolean {
    return this.running;
  }

  setConnectTimeout(ms: number): void {
    this.connectTimeoutMs = ms;
  }

  getPendingOfflineCount(): number {
    if (!this.messageStore) return 0;
    return this.messageStore.getPendingOfflineCount() as unknown as number;
  }

  async shutdown(): Promise<void> {
    this.running = false;

    if (this.offlineDeliveryInterval) {
      clearInterval(this.offlineDeliveryInterval);
    }

    if (this.acceptLoop) {
      clearInterval(this.acceptLoop);
      this.acceptLoop = null;
    }

    // 清理 pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Shutting down'));
    }
    this.pendingRequests.clear();

    if (this.messageStore) {
      await this.messageStore.shutdown();
      this.messageStore = null;
    }

    if (this.endpoint) {
      try {
        await this.endpoint.close();
      } catch {}
      this.endpoint = null;
    }

    this.peers.clear();
    this.ownNodeId = null;
    console.log('[IrohTransport] Shut down');
  }
}

export const irohTransport = new IrohTransport();