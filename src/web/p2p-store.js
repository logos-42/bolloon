/**
 * P2P 存储层 - 浏览器端 IndexedDB 管理
 * 处理连接历史、离线队列、消息缓存
 */

(function() {
  const DB_NAME = 'bolloon-p2p';
  const DB_VERSION = 1;

  class P2PStore {
    constructor() {
      this.db = null;
      this.initPromise = null;
    }

    async init() {
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
          const db = event.target.result;

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

    async addToHistory(entry) {
      await this.init();
      const id = crypto.randomUUID();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('connectionHistory', 'readwrite');
        const store = tx.objectStore('connectionHistory');

        // 检查是否已存在
        const getRequest = store.index('did').get(entry.did);
        getRequest.onsuccess = () => {
          const existing = getRequest.result;
          if (existing) {
            const updateEntry = { ...existing, ...entry, id: existing.id, lastConnectedAt: Date.now() };
            store.put(updateEntry);
            resolve(existing.id);
          } else {
            const newEntry = { ...entry, id, lastConnectedAt: Date.now() };
            store.add(newEntry);
            resolve(id);
          }
        };
        getRequest.onerror = () => reject(getRequest.error);
      });
    }

    async getConnectionHistory() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('connectionHistory', 'readonly');
        const store = tx.objectStore('connectionHistory');
        const request = store.getAll();

        request.onsuccess = () => {
          const results = request.result.sort((a, b) => {
            if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
            return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
          });
          resolve(results);
        };
        request.onerror = () => reject(request.error);
      });
    }

    async updateHistoryEntry(id, updates) {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('connectionHistory', 'readwrite');
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

    async deleteHistoryEntry(id) {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('connectionHistory', 'readwrite');
        const store = tx.objectStore('connectionHistory');
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // ==================== 离线队列 ====================

    async addToQueue(message) {
      await this.init();
      const id = crypto.randomUUID();

      const newMessage = {
        ...message,
        id,
        createdAt: Date.now(),
        retryCount: 0,
        status: 'pending'
      };

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('offlineQueue', 'readwrite');
        const store = tx.objectStore('offlineQueue');
        store.add(newMessage);
        tx.oncomplete = () => resolve(id);
        tx.onerror = () => reject(tx.error);
      });
    }

    async getOfflineQueue() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('offlineQueue', 'readonly');
        const store = tx.objectStore('offlineQueue');
        const request = store.getAll();

        request.onsuccess = () => {
          resolve(request.result.sort((a, b) => a.createdAt - b.createdAt));
        };
        request.onerror = () => reject(request.error);
      });
    }

    async getQueueForTarget(targetDid) {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('offlineQueue', 'readonly');
        const store = tx.objectStore('offlineQueue');
        const index = store.index('targetDid');
        const request = index.getAll(targetDid);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async updateQueueMessage(id, updates) {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('offlineQueue', 'readwrite');
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

    async removeFromQueue(id) {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('offlineQueue', 'readwrite');
        const store = tx.objectStore('offlineQueue');
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async getPendingMessagesCount() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('offlineQueue', 'readonly');
        const store = tx.objectStore('offlineQueue');
        const index = store.index('status');
        const request = index.count(IDBKeyRange.only('pending'));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    // ==================== 收到的消息 ====================

    async saveReceivedMessage(message) {
      await this.init();
      const id = crypto.randomUUID();

      const newMessage = {
        ...message,
        id,
        isRead: false
      };

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('receivedMessages', 'readwrite');
        const store = tx.objectStore('receivedMessages');
        store.add(newMessage);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async getReceivedMessages() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('receivedMessages', 'readonly');
        const store = tx.objectStore('receivedMessages');
        const request = store.getAll();

        request.onsuccess = () => {
          resolve(request.result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)));
        };
        request.onerror = () => reject(request.error);
      });
    }

    async markMessageRead(id) {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('receivedMessages', 'readwrite');
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

    async markAllMessagesRead() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('receivedMessages', 'readwrite');
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

    async getUnreadCount() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('receivedMessages', 'readonly');
        const store = tx.objectStore('receivedMessages');
        const index = store.index('isRead');
        const request = index.count(IDBKeyRange.only(0));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    // ==================== 偏好设置 ====================

    getDefaultPreferences() {
      return {
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
    }

    async getPreferences() {
      await this.init();

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('preferences', 'readonly');
        const store = tx.objectStore('preferences');
        const request = store.get('main');

        request.onsuccess = () => {
          resolve(request.result?.data || this.getDefaultPreferences());
        };
        request.onerror = () => reject(request.error);
      });
    }

    async savePreferences(prefs) {
      await this.init();
      const current = await this.getPreferences();
      const updated = { ...current, ...prefs };

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('preferences', 'readwrite');
        const store = tx.objectStore('preferences');
        store.put({ id: 'main', data: updated });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // ==================== 导出/导入 ====================

    async exportData() {
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

    async clearAll() {
      await this.init();

      const stores = ['connectionHistory', 'offlineQueue', 'receivedMessages', 'preferences'];
      const tx = this.db.transaction(stores, 'readwrite');

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
  window.p2pStore = new P2PStore();
  console.log('[P2P Store] 存储层已加载');
})();