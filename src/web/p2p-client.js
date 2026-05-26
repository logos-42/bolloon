/**
 * P2P Web Client - 网页端 P2P 连接功能
 *
 * 功能: 消息状态追踪、重连管理、连接历史同步
 */

(function() {
  const IPFS_ENDPOINT = 'http://127.0.0.1:5001';
  const RECONNECT_BASE_DELAY = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  const MAX_RECONNECT_ATTEMPTS = 5;

  // CID 格式验证正则
  const CID_REGEX = /^Qm[a-zA-Z0-9]{44}$|^bafy[a-zA-Z0-9]{59}$|^bafk[a-zA-Z0-9]{59}$/;
  const DID_REGEX = /^did:[a-z]+:[a-zA-Z0-9]+$/;

  // 连接状态
  const ConnectionStatus = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    OFFLINE: 'offline',
    ERROR: 'error'
  };

  // 消息状态
  const MessageStatus = {
    PENDING: 'pending',
    SENDING: 'sending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    FAILED: 'failed',
    QUEUED: 'queued'
  };

  class P2PWebClient {
    constructor() {
      this.initialized = false;
      this.ownInfo = null;
      this.sseConnected = false;
      this.messageHandlers = [];
      this.eventSource = null;

      // 连接状态管理
      this.peers = new Map(); // nodeId -> { status, lastSeen, info }
      this.connectionAttempts = new Map(); // cid -> attemptCount

      // 消息状态追踪
      this.pendingMessages = new Map(); // messageId -> { status, retries, createdAt }

      // 重连定时器
      this.reconnectTimers = new Map(); // nodeId -> timerId

      // 偏好设置
      this.preferences = {
        autoReconnect: true,
        autoConnectOnStartup: true,
        maxRetries: 3
      };
    }

    async init() {
      if (this.initialized) return;

      console.log('[P2P Web] 初始化...');

      try {
        // 1. 初始化本地存储
        await this.initStore();

        // 2. 获取/创建身份
        const identity = await this.getOrCreateIdentity();

        // 3. 连接 SSE 获取 iroh 消息
        this.connectSSE();

        // 4. 加载偏好设置
        await this.loadPreferences();

        // 5. 启动时自动重连
        if (this.preferences.autoConnectOnStartup) {
          this.autoReconnectOnStartup();
        }

        this.initialized = true;
        console.log('[P2P Web] 初始化完成');

        return identity;
      } catch (e) {
        console.error('[P2P Web] 初始化失败:', e);
        throw e;
      }
    }

    async initStore() {
      // 等待 p2pStore 初始化
      if (window.p2pStore) {
        await window.p2pStore.init();
        console.log('[P2P Web] 本地存储已初始化');
      }
    }

    async loadPreferences() {
      if (window.p2pStore) {
        try {
          const prefs = await window.p2pStore.getPreferences();
          this.preferences = { ...this.preferences, ...prefs };
        } catch (e) {
          console.log('[P2P Web] 加载偏好失败，使用默认');
        }
      }
    }

    async getOrCreateIdentity() {
      try {
        const res = await fetch('/api/identity');
        if (res.ok) {
          const data = await res.json();
          this.ownInfo = data;
          console.log('[P2P Web] 获取到身份:', data.did?.substring(0, 20) + '...');

          // 如果有 CID，保存到历史
          if (data.cid && window.p2pStore) {
            await window.p2pStore.addToHistory({
              did: data.did,
              name: '我的设备',
              cid: data.cid,
              irohNodeId: data.irohNodeId || '',
              lastConnectedAt: Date.now(),
              lastMessageAt: 0,
              totalMessages: 0,
              isPinned: true,
              tags: ['self']
            });
          }

          return data;
        }
      } catch (e) {
        console.log('[P2P Web] 获取身份失败，使用默认');
      }

      this.ownInfo = {
        did: 'did:key:z' + Math.random().toString(36).substring(2, 15),
        cid: '',
        irohNodeId: 'temp-' + Date.now()
      };

      return this.ownInfo;
    }

    connectSSE() {
      if (this.sseConnected) return;

      console.log('[P2P Web] 连接 SSE...');

      this.eventSource = new EventSource('/events?channelId=p2p-global');

      this.eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);

          if (data.type === 'p2p_message') {
            const content = typeof data.content === 'string'
              ? data.content
              : JSON.stringify(data.content);

            console.log('[P2P Web] 收到消息:', content.substring(0, 50));

            // 保存收到的消息
            if (window.p2pStore && data.from) {
              window.p2pStore.saveReceivedMessage({
                fromDid: data.from,
                fromName: data.fromName || 'Unknown',
                type: data.messageType || 'chat',
                content: content,
                timestamp: data.timestamp || Date.now()
              });
            }

            // 更新连接历史
            if (data.from && window.p2pStore) {
              window.p2pStore.updateHistoryEntry(data.fromDid, {
                lastMessageAt: Date.now()
              }).catch(() => {});
            }

            // 通知所有处理器
            this.messageHandlers.forEach(handler => {
              try {
                handler(data);
              } catch (e) {
                console.error('[P2P Web] 消息处理错误:', e);
              }
            });

            // 更新对方在线状态
            if (data.from) {
              this.updatePeerOnline(data.from, true);
            }
          } else if (data.type === 'peer_status') {
            this.handlePeerStatus(data);
          }
        } catch (e) {
          // 忽略解析错误
        }
      };

      this.eventSource.onerror = () => {
        console.log('[P2P Web] SSE 连接断开，5秒后重连...');
        this.sseConnected = false;
        setTimeout(() => this.connectSSE(), 5000);
      };

      this.sseConnected = true;
    }

    // 解析输入（支持 CID、链接、二维码数据）
    parseInput(input) {
      const trimmed = input.trim();

      // URL scheme: bolloon://connect?did=...&cid=...
      if (trimmed.startsWith('bolloon://connect')) {
        try {
          const url = new URL(trimmed);
          return {
            type: 'link',
            did: url.searchParams.get('did'),
            cid: url.searchParams.get('cid')
          };
        } catch {
          return { type: 'invalid', error: '无效的链接格式' };
        }
      }

      // 纯 CID
      if (CID_REGEX.test(trimmed)) {
        return { type: 'cid', value: trimmed };
      }

      // 尝试解析 JSON（可能粘贴了整个 DiapDoc）
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id || parsed.did) {
          return { type: 'diapDoc', value: parsed };
        }
      } catch {}

      return { type: 'invalid', error: '无法识别的格式' };
    }

    // 生成分享链接
    generateShareLink() {
      if (!this.ownInfo?.cid || !this.ownInfo?.did) {
        return null;
      }
      return `bolloon://connect?did=${encodeURIComponent(this.ownInfo.did)}&cid=${encodeURIComponent(this.ownInfo.cid)}`;
    }

    // 生成二维码数据 URL
    generateQRCode(data) {
      // 使用内联 SVG 生成简单二维码
      // 实际应用中可以使用 qrcode.js 库
      return new Promise((resolve) => {
        if (typeof QRCode !== 'undefined') {
          const canvas = document.createElement('canvas');
          QRCode.toCanvas(canvas, data, { width: 200 }, () => {
            resolve(canvas.toDataURL());
          });
        } else {
          resolve(null);
        }
      });
    }

    // 连接到节点（带进度反馈）
    async connect(cidOrInput, onProgress) {
      const parsed = this.parseInput(cidOrInput);
      if (parsed.type === 'invalid') {
        return { success: false, error: parsed.error };
      }

      onProgress?.({ stage: 'validating', percent: 10, message: '验证输入格式...' });

      let targetCid = parsed.cid || parsed.value;

      // 如果是 DiapDoc，直接使用其中的信息
      if (parsed.type === 'diapDoc') {
        targetCid = parsed.value.cid || '';
      }

      if (!targetCid) {
        return { success: false, error: '未找到 CID' };
      }

      onProgress?.({ stage: 'ipfs_fetch', percent: 40, message: '从 IPFS 获取节点文档...' });

      try {
        const res = await fetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cid: targetCid })
        });

        const data = await res.json();

        if (res.ok) {
          onProgress?.({ stage: 'connecting', percent: 80, message: '建立 P2P 连接...' });

          // 保存到连接历史
          if (window.p2pStore && data.did) {
            await window.p2pStore.addToHistory({
              did: data.did,
              name: data.name || 'Unknown',
              cid: targetCid,
              irohNodeId: data.irohNodeId || '',
              lastConnectedAt: Date.now(),
              lastMessageAt: Date.now(),
              totalMessages: 0,
              isPinned: false,
              tags: []
            });
          }

          // 更新本地状态
          this.updatePeerStatus(data.irohNodeId, ConnectionStatus.CONNECTED, data);

          onProgress?.({ stage: 'complete', percent: 100, message: '连接成功!' });

          return { success: true, ...data };
        } else {
          onProgress?.({ stage: 'error', percent: 0, message: data.error || '连接失败' });
          return { success: false, error: data.error };
        }
      } catch (e) {
        console.error('[P2P Web] 连接错误:', e);
        return { success: false, error: e.message };
      }
    }

    // 简单连接（不带进度）
    async simpleConnect(cid) {
      return this.connect(cid, null);
    }

    // 断开连接
    async disconnect(nodeId) {
      try {
        await fetch('/api/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId })
        });
        this.updatePeerStatus(nodeId, ConnectionStatus.IDLE);
        this.clearReconnectTimer(nodeId);
      } catch (e) {
        console.error('[P2P Web] 断开连接失败:', e);
      }
    }

    // 发送消息（带状态追踪）
    async sendMessage(content, targetNodeId) {
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
          this.updateMessageStatus(messageId, MessageStatus.SENT);
          return { success: true, messageId };
        } else {
          // 离线，加入队列
          if (window.p2pStore) {
            await window.p2pStore.addToQueue({
              targetDid: targetNodeId,
              targetNodeId: targetNodeId,
              type: 'chat',
              content
            });
          }
          this.updateMessageStatus(messageId, MessageStatus.QUEUED);
          return { success: false, queued: true, messageId };
        }
      } catch (e) {
        console.error('[P2P Web] 发送失败:', e);

        // 离线，加入队列
        if (window.p2pStore) {
          await window.p2pStore.addToQueue({
            targetDid: targetNodeId,
            targetNodeId: targetNodeId,
            type: 'chat',
            content
          });
        }
        this.updateMessageStatus(messageId, MessageStatus.QUEUED);
        return { success: false, queued: true, messageId, error: e.message };
      }
    }

    // 发送消息到指定节点
    async sendToPeer(nodeId, content) {
      return this.sendMessage(content, nodeId);
    }

    // 重试发送失败的消息
    async retryFailedMessage(messageId) {
      const msg = this.pendingMessages.get(messageId);
      if (!msg) return { success: false, error: '消息不存在' };

      if (msg.retries >= this.preferences.maxRetries) {
        this.updateMessageStatus(messageId, MessageStatus.FAILED);
        return { success: false, error: '超过最大重试次数' };
      }

      return this.sendMessage(msg.content, msg.targetNodeId);
    }

    // 获取消息状态
    getMessageStatus(messageId) {
      return this.pendingMessages.get(messageId);
    }

    // 更新消息状态
    updateMessageStatus(messageId, status) {
      const msg = this.pendingMessages.get(messageId);
      if (msg) {
        msg.status = status;
        if (status === MessageStatus.SENT || status === MessageStatus.QUEUED) {
          msg.retries++;
        }
      }
    }

    // 更新节点状态
    updatePeerStatus(nodeId, status, info = {}) {
      const peer = this.peers.get(nodeId) || {};
      this.peers.set(nodeId, {
        ...peer,
        status,
        info,
        lastSeen: Date.now()
      });
    }

    // 更新节点在线状态
    updatePeerOnline(nodeId, online) {
      const peer = this.peers.get(nodeId) || {};
      this.peers.set(nodeId, {
        ...peer,
        status: online ? ConnectionStatus.CONNECTED : ConnectionStatus.OFFLINE,
        lastSeen: Date.now()
      });
    }

    // 处理节点状态变化
    handlePeerStatus(data) {
      const { nodeId, status, info } = data;
      this.updatePeerStatus(nodeId, status, info);

      if (status === ConnectionStatus.OFFLINE && this.preferences.autoReconnect) {
        this.scheduleReconnect(nodeId);
      }
    }

    // 计划重连
    scheduleReconnect(nodeId) {
      if (this.reconnectTimers.has(nodeId)) return;

      const attempt = this.connectionAttempts.get(nodeId) || 0;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[P2P Web] ${nodeId} 重连次数已达上限`);
        return;
      }

      const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
      console.log(`[P2P Web] 计划 ${delay}ms 后重连 ${nodeId}`);

      const timerId = setTimeout(async () => {
        this.connectionAttempts.set(nodeId, attempt + 1);
        this.reconnectTimers.delete(nodeId);

        console.log(`[P2P Web] 尝试重连 ${nodeId} (第 ${attempt + 1} 次)`);

        // 从历史记录获取 CID 重连
        if (window.p2pStore) {
          const history = await window.p2pStore.getConnectionHistory();
          const entry = history.find(h => h.irohNodeId === nodeId);
          if (entry?.cid) {
            await this.connect(entry.cid);
          }
        }
      }, delay);

      this.reconnectTimers.set(nodeId, timerId);
    }

    // 清除重连定时器
    clearReconnectTimer(nodeId) {
      const timerId = this.reconnectTimers.get(nodeId);
      if (timerId) {
        clearTimeout(timerId);
        this.reconnectTimers.delete(nodeId);
      }
      this.connectionAttempts.delete(nodeId);
    }

    // 启动时自动重连
    async autoReconnectOnStartup() {
      if (!window.p2pStore) return;

      try {
        const history = await window.p2pStore.getConnectionHistory();
        const pinnedNodes = history.filter(h => h.isPinned && h.irohNodeId);

        console.log(`[P2P Web] 启动时自动重连 ${pinnedNodes.length} 个节点`);

        for (const node of pinnedNodes) {
          if (node.irohNodeId && node.cid) {
            this.updatePeerStatus(node.irohNodeId, ConnectionStatus.CONNECTING);
            await this.connect(node.cid);
          }
        }
      } catch (e) {
        console.error('[P2P Web] 自动重连失败:', e);
      }
    }

    // 获取连接历史
    async getConnectionHistory() {
      if (window.p2pStore) {
        return await window.p2pStore.getConnectionHistory();
      }
      return [];
    }

    // 获取离线消息队列
    async getOfflineQueue() {
      if (window.p2pStore) {
        return await window.p2pStore.getOfflineQueue();
      }
      return [];
    }

    // 获取未读消息数
    async getUnreadCount() {
      if (window.p2pStore) {
        return await window.p2pStore.getUnreadCount();
      }
      return 0;
    }

    // 获取所有已连接节点
    getConnectedPeers() {
      const connected = [];
      this.peers.forEach((peer, nodeId) => {
        if (peer.status === ConnectionStatus.CONNECTED) {
          connected.push({ nodeId, ...peer });
        }
      });
      return connected;
    }

    // 获取所有节点状态
    getAllPeers() {
      const all = [];
      this.peers.forEach((peer, nodeId) => {
        all.push({ nodeId, ...peer });
      });
      return all;
    }

    // 监听消息
    onMessage(handler) {
      this.messageHandlers.push(handler);
    }

    // 移除消息监听
    offMessage(handler) {
      const index = this.messageHandlers.indexOf(handler);
      if (index > -1) {
        this.messageHandlers.splice(index, 1);
      }
    }

    // 获取本机信息
    getOwnInfo() {
      return this.ownInfo;
    }

    // 获取节点列表
    async getPeers() {
      try {
        const res = await fetch('/api/peers');
        if (res.ok) {
          return await res.json();
        }
      } catch (e) {
        console.error('[P2P Web] 获取节点列表失败:', e);
      }
      return [];
    }

    // 销毁
    destroy() {
      // 清除所有重连定时器
      this.reconnectTimers.forEach((timerId) => clearTimeout(timerId));
      this.reconnectTimers.clear();

      // 关闭 SSE
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      this.sseConnected = false;
      this.initialized = false;
    }
  }

  // 暴露到全局
  window.P2PClient = new P2PWebClient();

  console.log('[P2P Web] P2P 客户端已加载');
})();
