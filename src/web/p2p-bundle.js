/**
 * P2P Bundle - 浏览器端 P2P 模块（打包版）
 * 所有 P2P 功能整合到一个文件中
 */

(function() {
  'use strict';

  // ==================== Types ====================

  const ConnectionStatus = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    OFFLINE: 'offline',
    ERROR: 'error'
  };

  const MessageStatus = {
    PENDING: 'pending',
    SENDING: 'sending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    FAILED: 'failed',
    QUEUED: 'queued'
  };

  // ==================== P2P Store Memory ====================

  class P2PStoreMemory {
    constructor() {
      this.history = [];
      this.messages = [];
      this.offlineQueue = [];
      this.unreadCount = 0;
      this.preferences = {
        autoReconnect: true,
        autoConnectOnStartup: true,
        maxRetries: 3,
        notifications: {
          newMessage: true,
          connectionEstablished: true
        }
      };
    }

    async addToHistory(entry) {
      const existingIndex = this.history.findIndex(h => h.did === entry.did);
      if (existingIndex >= 0) {
        this.history[existingIndex] = {
          ...this.history[existingIndex],
          ...entry,
          lastConnectedAt: Date.now()
        };
        return this.history[existingIndex].id;
      }
      const id = crypto.randomUUID();
      this.history.push({ ...entry, id, lastConnectedAt: Date.now() });
      return id;
    }

    async getHistory() {
      return [...this.history].sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return b.lastMessageAt - a.lastMessageAt;
      });
    }

    async updateHistory(id, updates) {
      const index = this.history.findIndex(h => h.id === id);
      if (index >= 0) {
        this.history[index] = { ...this.history[index], ...updates };
      }
    }

    async deleteHistory(id) {
      this.history = this.history.filter(h => h.id !== id);
    }

    async addMessage(msg) {
      this.messages.push({ ...msg, id: crypto.randomUUID(), isRead: false });
      if (!msg.isRead) this.unreadCount++;
    }

    async getMessages() {
      return [...this.messages].sort((a, b) => b.timestamp - a.timestamp);
    }

    async markRead(id) {
      const msg = this.messages.find(m => m.id === id);
      if (msg && !msg.isRead) {
        msg.isRead = true;
        this.unreadCount = Math.max(0, this.unreadCount - 1);
      }
    }

    async markAllRead() {
      this.messages.forEach(m => m.isRead = true);
      this.unreadCount = 0;
    }

    getUnreadCount() {
      return this.unreadCount;
    }

    async addToQueue(msg) {
      const id = crypto.randomUUID();
      this.offlineQueue.push({
        ...msg,
        id,
        createdAt: Date.now(),
        retryCount: 0,
        status: 'pending'
      });
      return id;
    }

    async getQueue() {
      return [...this.offlineQueue];
    }

    async getQueueCount() {
      return this.offlineQueue.length;
    }

    getPreferences() {
      return { ...this.preferences };
    }
  }

  const p2pStore = new P2PStoreMemory();

  // ==================== P2P Identity ====================

  class P2PIdentityManager {
    constructor() {
      this.identity = null;
      this.initialized = false;
    }

    async init() {
      if (this.initialized && this.identity) return this.identity;

      try {
        const res = await fetch('/api/iroh/init', { method: 'POST' });
        const data = await res.json();

        if (res.ok) {
          this.identity = {
            did: data.did,
            cid: data.cid,
            irohNodeId: data.irohNodeId,
            name: data.name || `bolloon-${Date.now()}`
          };
          this.initialized = true;

          await p2pStore.addToHistory({
            did: this.identity.did,
            name: '我的设备',
            cid: this.identity.cid,
            irohNodeId: this.identity.irohNodeId,
            lastConnectedAt: Date.now(),
            lastMessageAt: 0,
            totalMessages: 0,
            isPinned: true,
            tags: ['self']
          });

          console.log('[P2P Identity] 初始化成功:', this.identity.did?.substring(0, 20));
        }

        return this.identity;
      } catch (e) {
        console.error('[P2P Identity] 初始化失败:', e);
        throw e;
      }
    }

    get() {
      return this.identity;
    }

    isInitialized() {
      return this.initialized;
    }

    generateShareLink() {
      if (!this.identity?.cid || !this.identity?.did) return null;
      return `bolloon://connect?did=${encodeURIComponent(this.identity.did)}&cid=${encodeURIComponent(this.identity.cid)}`;
    }

    exportIdentityFile() {
      if (!this.identity) return;
      const data = JSON.stringify({
        did: this.identity.did,
        cid: this.identity.cid,
        irohNodeId: this.identity.irohNodeId
      }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bolloon-identity.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  const p2pIdentity = new P2PIdentityManager();

  // ==================== P2P Connection ====================

  const CID_REGEX = /^Qm[a-zA-Z0-9]{44}$|^bafy[a-zA-Z0-9]{59}$|^bafk[a-zA-Z0-9]{59}$/;

  class P2PConnectionManager {
    constructor() {
      this.peers = new Map();
    }

    parseInput(input) {
      const trimmed = input.trim();
      if (trimmed.startsWith('bolloon://connect')) {
        try {
          const url = new URL(trimmed);
          return { type: 'link', value: { did: url.searchParams.get('did'), cid: url.searchParams.get('cid') } };
        } catch { return { type: 'invalid', error: '无效的链接格式' }; }
      }
      if (CID_REGEX.test(trimmed)) return { type: 'cid', value: trimmed };
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id || parsed.did) return { type: 'diapDoc', value: parsed };
      } catch {}
      return { type: 'invalid', error: '无法识别的格式' };
    }

    async connect(input, onProgress) {
      const parsed = this.parseInput(input);
      if (parsed.type === 'invalid') return { success: false, error: parsed.error };

      onProgress?.({ stage: 'validating', percent: 10, message: '验证输入格式...' });

      let cid = '';
      if (parsed.type === 'link') cid = parsed.value.cid;
      else if (parsed.type === 'cid') cid = parsed.value;
      else if (parsed.type === 'diapDoc') cid = parsed.value.cid || '';

      if (!cid) return { success: false, error: '未找到 CID' };

      onProgress?.({ stage: 'ipfs_fetch', percent: 40, message: '从 IPFS 获取节点文档...' });

      try {
        const res = await fetch('/api/iroh/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cid })
        });
        const data = await res.json();

        if (res.ok) {
          onProgress?.({ stage: 'connecting', percent: 80, message: '建立 P2P 连接...' });

          if (data.did) {
            await p2pStore.addToHistory({
              did: data.did,
              name: data.name || 'Unknown',
              cid: cid,
              irohNodeId: data.irohNodeId || '',
              lastConnectedAt: Date.now(),
              lastMessageAt: Date.now(),
              totalMessages: 0,
              isPinned: false,
              tags: []
            });
          }

          this.peers.set(data.irohNodeId, { nodeId: data.irohNodeId, status: ConnectionStatus.CONNECTED, info: data, lastSeen: Date.now() });
          onProgress?.({ stage: 'complete', percent: 100, message: '连接成功!' });
          return { success: true, ...data };
        } else {
          onProgress?.({ stage: 'error', percent: 0, message: data.error || '连接失败' });
          return { success: false, error: data.error };
        }
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    async disconnect(nodeId) {
      try {
        await fetch('/api/iroh/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId })
        });
      } catch {}
      this.peers.delete(nodeId);
    }

    getConnectedPeers() {
      const connected = [];
      this.peers.forEach((peer, nodeId) => {
        if (peer.status === ConnectionStatus.CONNECTED) connected.push({ nodeId, ...peer });
      });
      return connected;
    }

    getPeerCount() {
      return this.peers.size;
    }

    updatePeerStatus(nodeId, status, info) {
      const peer = this.peers.get(nodeId) || { nodeId, status, info: {}, lastSeen: 0 };
      this.peers.set(nodeId, { ...peer, status, info: info || peer.info, lastSeen: Date.now() });
    }

    destroy() {
      this.peers.clear();
    }
  }

  const p2pConnection = new P2PConnectionManager();

  // ==================== P2P Messages ====================

  class P2PMessagesManager {
    constructor() {
      this.pendingMessages = new Map();
      this.messageHandlers = [];
      this.sseConnected = false;
      this.eventSource = null;
      this.maxRetries = 3;
    }

    async send(content, targetNodeId) {
      const messageId = crypto.randomUUID();
      this.pendingMessages.set(messageId, { status: MessageStatus.SENDING, retries: 0, createdAt: Date.now(), content, targetNodeId });

      try {
        const res = await fetch('/api/message-p2p', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: messageId, type: 'chat', content, target: targetNodeId || 'broadcast', requireReceipt: true })
        });

        if (res.ok) {
          this.updateStatus(messageId, MessageStatus.SENT);
          return { success: true, messageId };
        }
      } catch {}

      await p2pStore.addToQueue({ targetDid: targetNodeId, targetNodeId: targetNodeId, type: 'chat', content });
      this.updateStatus(messageId, MessageStatus.QUEUED);
      return { success: false, messageId, queued: true };
    }

    updateStatus(messageId, status) {
      const msg = this.pendingMessages.get(messageId);
      if (msg) {
        msg.status = status;
        if (status === MessageStatus.SENT || status === MessageStatus.QUEUED) msg.retries++;
      }
    }

    onMessage(handler) {
      this.messageHandlers.push(handler);
    }

    offMessage(handler) {
      const index = this.messageHandlers.indexOf(handler);
      if (index > -1) this.messageHandlers.splice(index, 1);
    }

    startListening() {
      if (this.sseConnected) return;

      this.eventSource = new EventSource('/events?channelId=p2p-global');
      this.sseConnected = true;

      this.eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'p2p_message') {
            const content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
            const msg = { id: crypto.randomUUID(), fromDid: data.from, fromName: data.fromName || 'Unknown', content, type: data.messageType || 'chat', timestamp: data.timestamp || Date.now(), status: MessageStatus.DELIVERED, isRead: false };

            p2pStore.addMessage({ fromDid: msg.fromDid, fromName: msg.fromName, content: msg.content, type: msg.type, timestamp: msg.timestamp, status: msg.status });

            p2pStore.getHistory().then(history => {
              const entry = history.find(h => h.did === msg.fromDid);
              if (entry) p2pStore.updateHistory(entry.id, { lastMessageAt: msg.timestamp, totalMessages: (entry.totalMessages || 0) + 1 });
            });

            this.messageHandlers.forEach(handler => { try { handler(msg); } catch {} });
          }
        } catch {}
      };

      this.eventSource.onerror = () => {
        this.sseConnected = false;
        setTimeout(() => this.startListening(), 5000);
      };
    }

    async getReceivedMessages() {
      return p2pStore.getMessages();
    }

    getUnreadCount() {
      return p2pStore.getUnreadCount();
    }

    async markRead(id) {
      await p2pStore.markRead(id);
    }

    async markAllRead() {
      await p2pStore.markAllRead();
    }

    async getOfflineQueue() {
      return p2pStore.getQueue();
    }

    destroy() {
      if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
      this.sseConnected = false;
      this.pendingMessages.clear();
      this.messageHandlers = [];
    }
  }

  const p2pMessages = new P2PMessagesManager();

  // ==================== P2P Manager ====================

  class P2PManager {
    get identity() { return p2pIdentity; }
    get connection() { return p2pConnection; }
    get messages() { return p2pMessages; }

    async init() {
      const identity = await this.identity.init();
      this.messages.startListening();
      return identity;
    }

    async connect(input, onProgress) {
      return this.connection.connect(input, onProgress);
    }

    async disconnect(nodeId) {
      return this.connection.disconnect(nodeId);
    }

    async sendMessage(content, targetNodeId) {
      return this.messages.send(content, targetNodeId);
    }

    async getHistory() {
      return p2pStore.getHistory();
    }

    async updateHistory(id, updates) {
      return p2pStore.updateHistory(id, updates);
    }

    async deleteHistory(id) {
      return p2pStore.deleteHistory(id);
    }

    async getMessages() {
      return this.messages.getReceivedMessages();
    }

    onMessage(handler) {
      this.messages.onMessage(handler);
    }

    getUnreadCount() {
      return this.messages.getUnreadCount();
    }

    getConnectedPeers() {
      return this.connection.getConnectedPeers();
    }

    getPeerCount() {
      return this.connection.getPeerCount();
    }

    async getOfflineQueue() {
      return this.messages.getOfflineQueue();
    }

    async getOfflineQueueCount() {
      return p2pStore.getQueueCount();
    }

    destroy() {
      this.connection.destroy();
      this.messages.destroy();
    }
  }

  const p2pManager = new P2PManager();

  // ==================== P2P Modal Web Component ====================

  class P2PModal extends HTMLElement {
    constructor() {
      super();
      this.shadow = this.attachShadow({ mode: 'open' });
      this.activeTab = 'identity';
      this.initialized = false;
    }

    connectedCallback() {
      this.render();
      this.attachEvents();
    }

    show() {
      this.classList.add('show');
      if (!this.initialized) {
        this.initP2P();
        this.initialized = true;
      }
    }

    hide() {
      this.classList.remove('show');
    }

    async initP2P() {
      const statusIndicator = this.shadow.getElementById('p2p-status-indicator');
      const statusText = this.shadow.getElementById('p2p-status-text');
      if (statusIndicator) statusIndicator.className = 'status-indicator connecting';
      if (statusText) statusText.textContent = '初始化中...';

      try {
        const identity = await p2pManager.init();
        this.updateIdentityDisplay(identity);
        if (statusIndicator) statusIndicator.className = 'status-indicator online';
        if (statusText) statusText.textContent = '已连接';
      } catch {
        if (statusIndicator) statusIndicator.className = 'status-indicator error';
        if (statusText) statusText.textContent = '初始化失败';
      }
    }

    updateIdentityDisplay(identity) {
      const didEl = this.shadow.getElementById('p2p-did');
      const cidEl = this.shadow.getElementById('p2p-cid');
      const nodeIdEl = this.shadow.getElementById('p2p-node-id');
      const shareLinkEl = this.shadow.getElementById('p2p-invite-link');
      const sharePanel = this.shadow.getElementById('p2p-share-panel');

      if (didEl && identity.did) didEl.textContent = identity.did;
      if (cidEl && identity.cid) cidEl.textContent = identity.cid;
      if (nodeIdEl && identity.irohNodeId) nodeIdEl.textContent = identity.irohNodeId;
      if (shareLinkEl && identity.did && identity.cid) {
        shareLinkEl.value = `bolloon://connect?did=${encodeURIComponent(identity.did)}&cid=${encodeURIComponent(identity.cid)}`;
      }
      if (sharePanel) sharePanel.style.display = 'block';
    }

    switchTab(tab) {
      this.activeTab = tab;
      this.render();
      this.attachEvents();
      this.loadActiveTab();
    }

    async loadActiveTab() {
      switch (this.activeTab) {
        case 'history': await this.loadHistory(); break;
        case 'messages': await this.loadMessages(); break;
        case 'connect': await this.loadPeers(); break;
      }
    }

    async loadHistory() {
      const historyList = this.shadow.getElementById('p2p-history-list');
      if (!historyList) return;
      try {
        const history = await p2pManager.getHistory();
        this.renderHistory(history, historyList);
      } catch {}
    }

    renderHistory(history, container) {
      if (!history.length) { container.innerHTML = '<div class="empty-hint">暂无连接历史</div>'; return; }
      const fragment = document.createDocumentFragment();
      history.forEach(item => {
        const div = document.createElement('div');
        div.className = `history-item ${item.isPinned ? 'pinned' : ''}`;
        div.innerHTML = `
          <div class="history-item-icon">💬</div>
          <div class="history-item-info">
            <div class="history-item-name">${this.escapeHtml(item.name || 'Unknown')} ${item.isPinned ? '<span class="pin-icon">📌</span>' : ''}</div>
            <div class="history-item-meta"><span>上次: ${new Date(item.lastConnectedAt).toLocaleString()}</span><span>消息: ${item.totalMessages || 0}</span></div>
          </div>
          <div class="history-item-actions">
            <button class="btn-sm btn-secondary" data-action="connect" data-cid="${this.escapeHtml(item.cid)}">连接</button>
            <button class="btn-sm btn-secondary" data-action="pin" data-id="${item.id}" data-pinned="${!item.isPinned}">${item.isPinned ? '取消置顶' : '置顶'}</button>
            <button class="btn-sm btn-secondary" data-action="delete" data-id="${item.id}">删除</button>
          </div>`;
        fragment.appendChild(div);
      });
      container.innerHTML = '';
      container.appendChild(fragment);
      this.attachHistoryEvents(container);
    }

    attachHistoryEvents(container) {
      container.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const el = e.currentTarget;
          const action = el.dataset.action;
          if (action === 'connect' && el.dataset.cid) {
            const input = this.shadow.getElementById('p2p-connect-input');
            if (input) input.value = el.dataset.cid;
            this.switchTab('connect');
          } else if (action === 'pin' && el.dataset.id) {
            await p2pManager.updateHistory(el.dataset.id, { isPinned: el.dataset.pinned === 'true' });
            this.loadHistory();
          } else if (action === 'delete' && el.dataset.id) {
            await p2pManager.deleteHistory(el.dataset.id);
            this.loadHistory();
          }
        });
      });
    }

    async loadMessages() {
      const messagesList = this.shadow.getElementById('p2p-messages-list');
      const unreadBadge = this.shadow.getElementById('p2p-unread-badge');
      if (!messagesList) return;
      try {
        const messages = await p2pManager.getMessages();
        this.renderMessages(messages, messagesList);
        const unread = p2pManager.getUnreadCount();
        if (unreadBadge) { unreadBadge.textContent = String(unread); unreadBadge.style.display = unread > 0 ? 'inline-flex' : 'none'; }
      } catch {}
    }

    renderMessages(messages, container) {
      if (!messages.length) { container.innerHTML = '<div class="empty-hint">暂无消息</div>'; return; }
      const fragment = document.createDocumentFragment();
      messages.slice(-20).forEach(msg => {
        const div = document.createElement('div');
        div.className = `message-item ${!msg.isRead ? 'unread' : ''}`;
        div.innerHTML = `<div class="message-header"><span class="message-sender">${this.escapeHtml(msg.fromName || msg.fromDid)}</span><span class="message-time">${new Date(msg.timestamp).toLocaleString()}</span></div><div class="message-content">${this.escapeHtml(msg.content.substring(0, 200))}</div>`;
        fragment.appendChild(div);
      });
      container.innerHTML = '';
      container.appendChild(fragment);
    }

    async loadPeers() {
      const peersList = this.shadow.getElementById('p2p-peers-list');
      const peerCount = this.shadow.getElementById('p2p-peer-count');
      if (!peersList) return;
      const peers = p2pManager.getConnectedPeers();
      if (peerCount) peerCount.textContent = String(peers.length);
      if (!peers.length) { peersList.innerHTML = '<div class="empty-hint">暂无连接</div>'; return; }
      const fragment = document.createDocumentFragment();
      peers.forEach(peer => {
        const div = document.createElement('div');
        div.className = 'peer-item';
        div.innerHTML = `<div class="peer-status"><span class="dot online"></span></div><div class="peer-info"><div class="peer-name">${this.escapeHtml(peer.info?.name || 'Unknown')}</div><div class="peer-meta">${(peer.nodeId || '').substring(0, 16)}...</div></div>`;
        fragment.appendChild(div);
      });
      peersList.innerHTML = '';
      peersList.appendChild(fragment);
    }

    async handleConnect() {
      const input = this.shadow.getElementById('p2p-connect-input');
      const progressDiv = this.shadow.getElementById('p2p-connect-progress');
      const progressFill = this.shadow.getElementById('p2p-progress-fill');
      const progressText = this.shadow.getElementById('p2p-progress-text');
      const resultDiv = this.shadow.getElementById('p2p-connect-result');
      if (!input?.value.trim()) return;
      if (progressDiv) progressDiv.style.display = 'block';

      const updateProgress = (progress) => {
        if (progressFill) progressFill.style.width = `${progress.percent}%`;
        if (progressText) progressText.textContent = progress.message;
      };

      try {
        const result = await p2pManager.connect(input.value, updateProgress);
        if (result.success) {
          this.showResult(resultDiv, 'success', `已连接到 ${result.name || '节点'}`);
          input.value = '';
          this.loadHistory();
          this.loadPeers();
        } else {
          this.showResult(resultDiv, 'error', result.error || '连接失败');
        }
      } catch (e) {
        this.showResult(resultDiv, 'error', e.message);
      } finally {
        setTimeout(() => { if (progressDiv) progressDiv.style.display = 'none'; }, 2000);
      }
    }

    showResult(el, type, text) {
      if (!el) return;
      el.className = `connect-result ${type} show`;
      el.textContent = text;
    }

    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);
    }

    render() {
      this.shadow.innerHTML = `
        <style>
          :host { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
          :host(.show) { display: flex; }
          .modal { width: 90%; max-width: 700px; max-height: 90vh; background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #3a3a4a); border-radius: 12px; padding: 24px; overflow-y: auto; }
          .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
          .modal-header h2 { margin: 0; font-size: 18px; color: var(--text-primary, #e0e0e0); }
          .modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: var(--text-secondary, #888); }
          .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border, #3a3a4a); padding-bottom: 8px; }
          .tab { padding: 8px 16px; background: transparent; border: none; border-radius: 6px 6px 0 0; color: var(--text-secondary, #888); font-size: 14px; cursor: pointer; }
          .tab:hover { color: var(--text-primary, #e0e0e0); }
          .tab.active { color: var(--accent, #7c3aed); background: var(--bg-hover, #2a2a3a); }
          .tab-content { display: none; }
          .tab-content.active { display: block; }
          .identity-card { background: var(--bg-hover, #2a2a3a); border: 1px solid var(--border, #3a3a4a); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
          .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
          .status-indicator { width: 10px; height: 10px; border-radius: 50%; background: var(--text-muted, #666); }
          .status-indicator.online { background: var(--success, #22c55e); }
          .status-indicator.connecting { background: var(--warning, #eab308); animation: pulse 1s infinite; }
          .status-indicator.error { background: var(--error, #ef4444); }
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
          .info-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border, #3a3a4a); }
          .info-row:last-child { border-bottom: none; }
          .info-label { min-width: 80px; color: var(--text-secondary, #888); font-size: 13px; }
          .info-value { flex: 1; font-size: 13px; word-break: break-all; font-family: monospace; }
          .copy-btn { padding: 4px 8px; background: var(--bg-primary, #252536); border: 1px solid var(--border, #3a3a4a); border-radius: 4px; cursor: pointer; font-size: 12px; }
          .copy-btn:hover { background: var(--accent, #7c3aed); color: white; }
          .btn-primary { padding: 12px 24px; background: var(--accent, #7c3aed); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; width: 100%; }
          .btn-primary:hover { opacity: 0.9; }
          .share-panel { background: var(--bg-hover, #2a2a3a); border: 1px solid var(--border, #3a3a4a); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
          .share-panel h4 { margin: 0 0 12px 0; color: var(--text-primary, #e0e0e0); }
          .share-actions { display: flex; gap: 8px; flex-wrap: wrap; }
          .btn-secondary { padding: 8px 16px; background: var(--bg-primary, #252536); border: 1px solid var(--border, #3a3a4a); border-radius: 6px; cursor: pointer; font-size: 13px; }
          .btn-secondary:hover { border-color: var(--accent, #7c3aed); }
          .btn-sm { padding: 6px 12px; font-size: 12px; }
          .connect-form { display: flex; gap: 8px; margin-bottom: 16px; }
          .connect-form input { flex: 1; padding: 12px 16px; background: var(--bg-hover, #2a2a3a); border: 1px solid var(--border, #3a3a4a); border-radius: 8px; color: var(--text-primary, #e0e0e0); font-size: 14px; }
          .progress { display: none; margin-bottom: 16px; padding: 16px; background: var(--bg-hover, #2a2a3a); border-radius: 8px; }
          .progress.show { display: block; }
          .progress-bar { height: 6px; background: var(--bg-primary, #252536); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
          .progress-fill { height: 100%; background: var(--accent, #7c3aed); border-radius: 3px; transition: width 0.3s; }
          .progress-text { color: var(--text-secondary, #888); font-size: 13px; }
          .connect-result { display: none; padding: 12px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; }
          .connect-result.show { display: block; }
          .connect-result.success { background: rgba(34, 197, 94, 0.1); border: 1px solid var(--success, #22c55e); color: var(--success, #22c55e); }
          .connect-result.error { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--error, #ef4444); color: var(--error, #ef4444); }
          .empty-hint { color: var(--text-muted, #666); font-size: 13px; padding: 32px; text-align: center; }
          .history-item, .peer-item { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-hover, #2a2a3a); border: 1px solid var(--border, #3a3a4a); border-radius: 8px; margin-bottom: 8px; }
          .history-item.pinned { border-left: 3px solid var(--accent, #7c3aed); }
          .history-item-icon { font-size: 20px; }
          .history-item-info { flex: 1; }
          .history-item-name { font-weight: 500; display: flex; align-items: center; gap: 6px; }
          .history-item-meta { font-size: 12px; color: var(--text-secondary, #888); display: flex; gap: 12px; margin-top: 4px; }
          .history-item-actions { display: flex; gap: 8px; }
          .peer-status { display: flex; align-items: center; }
          .peer-status .dot { width: 8px; height: 8px; border-radius: 50%; }
          .peer-status .dot.online { background: var(--success, #22c55e); }
          .peer-info { flex: 1; }
          .peer-name { font-weight: 500; }
          .peer-meta { font-size: 12px; color: var(--text-secondary, #888); }
          .message-item { padding: 12px; background: var(--bg-hover, #2a2a3a); border: 1px solid var(--border, #3a3a4a); border-radius: 8px; margin-bottom: 8px; }
          .message-item.unread { border-left: 3px solid var(--accent, #7c3aed); }
          .message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
          .message-sender { font-weight: 500; }
          .message-time { font-size: 12px; color: var(--text-secondary, #888); }
          .message-content { font-size: 14px; line-height: 1.5; }
          .peers-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border, #3a3a4a); }
          .peers-section h4 { margin-bottom: 12px; color: var(--text-secondary, #888); font-size: 13px; }
          .toolbar { margin-bottom: 12px; display: flex; justify-content: flex-end; }
        </style>

        <div class="modal">
          <div class="modal-header">
            <h2>P2P 网络</h2>
            <button class="modal-close" id="modal-close">&times;</button>
          </div>

          <div class="tabs">
            <button class="tab ${this.activeTab === 'identity' ? 'active' : ''}" data-tab="identity">我的身份</button>
            <button class="tab ${this.activeTab === 'connect' ? 'active' : ''}" data-tab="connect">连接</button>
            <button class="tab ${this.activeTab === 'history' ? 'active' : ''}" data-tab="history">历史记录</button>
            <button class="tab ${this.activeTab === 'messages' ? 'active' : ''}" data-tab="messages">消息</button>
          </div>

          <div class="tab-content ${this.activeTab === 'identity' ? 'active' : ''}" id="tab-identity">
            <div class="identity-card">
              <div class="status-row">
                <span class="status-indicator" id="p2p-status-indicator"></span>
                <span id="p2p-status-text">未初始化</span>
              </div>
              <div class="info-row">
                <span class="info-label">DID:</span>
                <code class="info-value" id="p2p-did">-</code>
                <button class="copy-btn" data-copy="p2p-did">📋</button>
              </div>
              <div class="info-row">
                <span class="info-label">CID:</span>
                <code class="info-value" id="p2p-cid">-</code>
                <button class="copy-btn" data-copy="p2p-cid">📋</button>
              </div>
              <div class="info-row">
                <span class="info-label">Node ID:</span>
                <code class="info-value" id="p2p-node-id">-</code>
                <button class="copy-btn" data-copy="p2p-node-id">📋</button>
              </div>
            </div>
            <button class="btn-primary" id="p2p-init-btn">初始化 P2P</button>

            <div class="share-panel" id="p2p-share-panel" style="display:none">
              <h4>分享给好友</h4>
              <div class="share-actions">
                <button class="btn-secondary" id="p2p-copy-link">📋 复制链接</button>
                <button class="btn-secondary" id="p2p-export-file">📁 导出文件</button>
              </div>
            </div>
          </div>

          <div class="tab-content ${this.activeTab === 'connect' ? 'active' : ''}" id="tab-connect">
            <div class="connect-form">
              <input type="text" id="p2p-connect-input" placeholder="粘贴 CID 或链接...">
              <button class="btn-secondary" id="p2p-connect-btn">连接 ▶</button>
            </div>
            <div class="progress" id="p2p-connect-progress">
              <div class="progress-bar"><div class="progress-fill" id="p2p-progress-fill"></div></div>
              <span class="progress-text" id="p2p-progress-text">验证输入格式...</span>
            </div>
            <div class="connect-result" id="p2p-connect-result"></div>
          </div>

          <div class="tab-content ${this.activeTab === 'history' ? 'active' : ''}" id="tab-history">
            <div class="toolbar">
              <button class="btn-secondary btn-sm" id="p2p-history-refresh">🔄 刷新</button>
            </div>
            <div id="p2p-history-list"></div>
          </div>

          <div class="tab-content ${this.activeTab === 'messages' ? 'active' : ''}" id="tab-messages">
            <div class="toolbar">
              <button class="btn-secondary btn-sm" id="p2p-mark-all-read">全部已读</button>
            </div>
            <div id="p2p-messages-list"></div>
          </div>

          <div class="peers-section">
            <h4>已连接节点 (<span id="p2p-peer-count">0</span>)</h4>
            <div id="p2p-peers-list"></div>
          </div>
        </div>`;
    }

    attachEvents() {
      this.shadow.getElementById('modal-close')?.addEventListener('click', () => this.hide());
      this.addEventListener('click', (e) => { if (e.target === this) this.hide(); });

      this.shadow.getElementById('p2p-init-btn')?.addEventListener('click', () => this.initP2P());

      this.shadow.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const el = e.currentTarget;
          const targetEl = this.shadow.getElementById(el.dataset.copy);
          if (targetEl?.textContent && targetEl.textContent !== '-') {
            await navigator.clipboard.writeText(targetEl.textContent);
            this.showToast('已复制');
          }
        });
      });

      this.shadow.getElementById('p2p-copy-link')?.addEventListener('click', async () => {
        const identity = p2pIdentity.get();
        if (identity) {
          const link = `bolloon://connect?did=${encodeURIComponent(identity.did)}&cid=${encodeURIComponent(identity.cid)}`;
          await navigator.clipboard.writeText(link);
          this.showToast('链接已复制');
        }
      });

      this.shadow.getElementById('p2p-export-file')?.addEventListener('click', () => p2pIdentity.exportIdentityFile());

      this.shadow.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.tab;
          if (tab) this.switchTab(tab);
        });
      });

      this.shadow.getElementById('p2p-connect-btn')?.addEventListener('click', () => this.handleConnect());
      this.shadow.getElementById('p2p-connect-input')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handleConnect(); });
      this.shadow.getElementById('p2p-history-refresh')?.addEventListener('click', () => this.loadHistory());
      this.shadow.getElementById('p2p-mark-all-read')?.addEventListener('click', async () => { await p2pManager.messages.markAllRead(); this.loadMessages(); });
    }
  }

  customElements.define('p2p-modal', P2PModal);

  // ==================== Export ====================

  window.p2pManager = p2pManager;
  window.p2pStore = p2pStore;
  window.p2pIdentity = p2pIdentity;
  window.p2pConnection = p2pConnection;
  window.p2pMessages = p2pMessages;

  console.log('[P2P Bundle] P2P 模块已加载');
})();