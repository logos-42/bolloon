/**
 * P2P 存储层 - IndexedDB 管理
 * 处理连接历史、离线队列、消息缓存
 */

const DB_NAME = 'bolloon-p2p';
const DB_VERSION = 1;

interface StoredIdentity {
  did: string;
  cid: string;
  irohNodeId: string;
  name: string;
  publicKey: string;
  createdAt: number;
  updatedAt: number;
}

interface ConnectionHistoryEntry {
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

interface QueuedMessage {
  id: string;
  targetDid: string;
  targetNodeId: string;
  type: 'chat' | 'ai-dialogue' | 'file';
  content: string;
  createdAt: number;
  retryCount: number;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  error?: string;
}

interface ReceivedMessage {
  id: string;
  fromDid: string;
  fromName: string;
  type: 'chat' | 'ai-dialogue';
  content: string;
  timestamp: number;
  isRead: boolean;
}

interface P2PPreferences {
  autoReconnect: boolean;
  autoConnectOnStartup: boolean;
  preferredNodes: string[];
  maxOfflineQueue: number;
  notifications: {
    newMessage: boolean;
    connectionEstablished: boolean;
    peerWentOnline: boolean;
    peerWentOffline: boolean;
  };
}

class P2PStore {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 连接历史
        if (!db.objectStoreNames.contains('connectionHistory')) {
          const historyStore = db.createObjectStore('connectionHistory', { keyPath: 'id' });
          historyStore.createIndex('did', 'did', { unique: true });
          historyStore.createIndex('lastMessageAt', 'lastMessageAt', { unique: false });
          historyStore.createIndex('isPinned', 'isPinned', { unique: false });
        }

        // 离线消息队列
        if (!db.objectStoreNames.contains('offlineQueue')) {
          const queueStore = db.createObjectStore('offlineQueue', { keyPath: 'id' });
          queueStore.createIndex('targetDid', 'targetDid', { unique: false });
          queueStore.createIndex('status', 'status', { unique: false });
          queueStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // 收到的消息
        if (!db.objectStoreNames.contains('receivedMessages')) {
          const msgStore = db.createObjectStore('receivedMessages', { keyPath: 'id' });
          msgStore.createIndex('fromDid', 'fromDid', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
          msgStore.createIndex('isRead', 'isRead', { unique: false });
        }

        // 用户偏好
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences', { keyPath: 'id' });
        }
      };
    });

    return this.initPromise;
  }

  // ==================== 连接历史 ====================

  async addToHistory(entry: Omit<ConnectionHistoryEntry, 'id'>): Promise<string> {
    await this.init();
    const id = crypto.randomUUID();

    const newEntry: ConnectionHistoryEntry = {
      ...entry,
      id,
      lastConnectedAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('connectionHistory', 'readwrite');
      const store = tx.objectStore('connectionHistory');

      // 检查是否已存在（按 DID）
      const getRequest = store.index('did').get(entry.did);
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (existing) {
          // 更新已有记录
          const updateEntry = { ...existing, ...entry, id: existing.id, lastConnectedAt: Date.now() };
          store.put(updateEntry);
          resolve(existing.id);
        } else {
          // 新增
          store.add(newEntry);
          resolve(id);
        }
      };
      getRequest.onerror = () => reject(getRequest.error);

      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getConnectionHistory(): Promise<ConnectionHistoryEntry[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('connectionHistory', 'readonly');
      const store = tx.objectStore('connectionHistory');
      const request = store.getAll();

      request.onsuccess = () => {
        const results = request.result.sort((a, b) => {
          // 置顶优先，然后按最后消息时间
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return b.lastMessageAt - a.lastMessageAt;
        });
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async updateHistoryEntry(id: string, updates: Partial<ConnectionHistoryEntry>): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('connectionHistory', 'readwrite');
      const store = tx.objectStore('connectionHistory');
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const entry = getRequest.result;
        if (entry) {
          store.put({ ...entry, ...updates });
        }
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async deleteHistoryEntry(id: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('connectionHistory', 'readwrite');
      const store = tx.objectStore('connectionHistory');
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== 离线队列 ====================

  async addToQueue(message: Omit<QueuedMessage, 'id' | 'createdAt' | 'retryCount' | 'status'>): Promise<string> {
    await this.init();
    const id = crypto.randomUUID();

    const newMessage: QueuedMessage = {
      ...message,
      id,
      createdAt: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offlineQueue', 'readwrite');
      const store = tx.objectStore('offlineQueue');
      store.add(newMessage);
      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getOfflineQueue(): Promise<QueuedMessage[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offlineQueue', 'readonly');
      const store = tx.objectStore('offlineQueue');
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result.sort((a, b) => a.createdAt - b.createdAt));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getQueueForTarget(targetDid: string): Promise<QueuedMessage[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offlineQueue', 'readonly');
      const store = tx.objectStore('offlineQueue');
      const index = store.index('targetDid');
      const request = index.getAll(targetDid);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async updateQueueMessage(id: string, updates: Partial<QueuedMessage>): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offlineQueue', 'readwrite');
      const store = tx.objectStore('offlineQueue');
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const msg = getRequest.result;
        if (msg) {
          store.put({ ...msg, ...updates });
        }
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async removeFromQueue(id: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offlineQueue', 'readwrite');
      const store = tx.objectStore('offlineQueue');
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getPendingMessagesCount(): Promise<number> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offlineQueue', 'readonly');
      const store = tx.objectStore('offlineQueue');
      const index = store.index('status');
      const request = index.count(IDBKeyRange.only('pending'));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ==================== 收到的消息 ====================

  async saveReceivedMessage(message: Omit<ReceivedMessage, 'id' | 'isRead'>): Promise<void> {
    await this.init();
    const id = crypto.randomUUID();

    const newMessage: ReceivedMessage = {
      ...message,
      id,
      isRead: false
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('receivedMessages', 'readwrite');
      const store = tx.objectStore('receivedMessages');
      store.add(newMessage);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getReceivedMessages(): Promise<ReceivedMessage[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('receivedMessages', 'readonly');
      const store = tx.objectStore('receivedMessages');
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result.sort((a, b) => b.timestamp - a.timestamp));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async markMessageRead(id: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('receivedMessages', 'readwrite');
      const store = tx.objectStore('receivedMessages');
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const msg = getRequest.result;
        if (msg) {
          store.put({ ...msg, isRead: true });
        }
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async markAllMessagesRead(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('receivedMessages', 'readwrite');
      const store = tx.objectStore('receivedMessages');
      const getRequest = store.getAll();

      getRequest.onsuccess = () => {
        getRequest.result.forEach(msg => {
          if (!msg.isRead) {
            store.put({ ...msg, isRead: true });
          }
        });
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async getUnreadCount(): Promise<number> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('receivedMessages', 'readonly');
      const store = tx.objectStore('receivedMessages');
      const index = store.index('isRead');
      const request = index.count(IDBKeyRange.only(0));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ==================== 偏好设置 ====================

  private defaultPreferences: P2PPreferences = {
    autoReconnect: true,
    autoConnectOnStartup: true,
    preferredNodes: [],
    maxOfflineQueue: 100,
    notifications: {
      newMessage: true,
      connectionEstablished: true,
      peerWentOnline: true,
      peerWentOffline: true
    }
  };

  async getPreferences(): Promise<P2PPreferences> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('preferences', 'readonly');
      const store = tx.objectStore('preferences');
      const request = store.get('main');

      request.onsuccess = () => {
        resolve(request.result?.data || this.defaultPreferences);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async savePreferences(prefs: Partial<P2PPreferences>): Promise<void> {
    await this.init();
    const current = await this.getPreferences();
    const updated = { ...current, ...prefs };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('preferences', 'readwrite');
      const store = tx.objectStore('preferences');
      store.put({ id: 'main', data: updated });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== 导出/导入 ====================

  async exportData(): Promise<string> {
    const history = await this.getConnectionHistory();
    const queue = await this.getOfflineQueue();
    const messages = await this.getReceivedMessages();
    const prefs = await this.getPreferences();

    return JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      history,
      queue,
      messages,
      preferences: prefs
    }, null, 2);
  }

  async clearAll(): Promise<void> {
    await this.init();

    const stores = ['connectionHistory', 'offlineQueue', 'receivedMessages', 'preferences'];
    const tx = this.db!.transaction(stores, 'readwrite');

    stores.forEach(storeName => {
      tx.objectStore(storeName).clear();
    });

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// 导出单例
const p2pStore = new P2PStore();
export default p2pStore;

// 也挂载到全局，方便浏览器控制台调试
if (typeof window !== 'undefined') {
  (window as any).p2pStore = p2pStore;
}