/**
 * P2P Modal Web Component
 */

import { p2pManager } from './p2p-manager.js';
import type { ConnectProgress, P2PMessage, ConnectionHistoryEntry } from './types.js';
import { safeName as safeAnyName } from '../../util/safe-name.js';

export class P2PModal extends HTMLElement {
  private shadow = this.attachShadow({ mode: 'open' });
  private activeTab: string = 'identity';
  private initialized: boolean = false;

  connectedCallback(): void {
    this.render();
    this.attachEvents();
  }

  show(): void {
    this.classList.add('show');
    if (!this.initialized) {
      this.initP2P();
      this.initialized = true;
    }
  }

  hide(): void {
    this.classList.remove('show');
  }

  private async initP2P(): Promise<void> {
    const statusIndicator = this.shadow.getElementById('p2p-status-indicator');
    const statusText = this.shadow.getElementById('p2p-status-text');

    statusIndicator?.classList.add('connecting');
    if (statusText) statusText.textContent = '初始化中...';

    try {
      const identity = await p2pManager.init();
      this.updateIdentityDisplay(identity);
      this.updateStatus('online', '已连接');
      statusIndicator?.classList.add('online');
    } catch (e) {
      this.updateStatus('error', '初始化失败');
    }
  }

  private updateStatus(status: string, text: string): void {
    const statusIndicator = this.shadow.getElementById('p2p-status-indicator');
    const statusText = this.shadow.getElementById('p2p-status-text');
    if (statusIndicator) {
      statusIndicator.className = 'status-indicator ' + status;
    }
    if (statusText) statusText.textContent = text;
  }

  private updateIdentityDisplay(identity: any): void {
    const didEl = this.shadow.getElementById('p2p-did');
    const cidEl = this.shadow.getElementById('p2p-cid');
    const nodeIdEl = this.shadow.getElementById('p2p-node-id');
    const shareLinkEl = this.shadow.getElementById('p2p-invite-link') as HTMLInputElement;
    const sharePanel = this.shadow.getElementById('p2p-share-panel');

    if (didEl && identity.did) didEl.textContent = identity.did;
    if (cidEl && identity.cid) cidEl.textContent = identity.cid;
    if (nodeIdEl && identity.irohNodeId) nodeIdEl.textContent = identity.irohNodeId;

    if (shareLinkEl && identity.did && identity.cid) {
      shareLinkEl.value = `bolloon://connect?did=${encodeURIComponent(identity.did)}&cid=${encodeURIComponent(identity.cid)}`;
    }
    if (sharePanel) sharePanel.style.display = 'block';
  }

  private switchTab(tab: string): void {
    this.activeTab = tab;
    this.render();
    this.attachEvents();
    this.loadActiveTab();
  }

  private async loadActiveTab(): Promise<void> {
    switch (this.activeTab) {
      case 'history':
        await this.loadHistory();
        break;
      case 'messages':
        await this.loadMessages();
        break;
      case 'connect':
        await this.loadPeers();
        break;
    }
  }

  private async loadHistory(): Promise<void> {
    const historyList = this.shadow.getElementById('p2p-history-list');
    if (!historyList) return;

    try {
      const history = await p2pManager.getHistory();
      this.renderHistory(history, historyList);
    } catch (e) {
      console.error('[P2P Modal] 加载历史失败:', e);
    }
  }

  private renderHistory(history: ConnectionHistoryEntry[], container: Element): void {
    if (history.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无连接历史</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    history.forEach(item => {
      const div = document.createElement('div');
      div.className = `history-item ${item.isPinned ? 'pinned' : ''}`;
      div.innerHTML = `
        <div class="history-item-icon">💬</div>
        <div class="history-item-info">
          <div class="history-item-name">
            ${this.escapeHtml(this.safeName(item.name, 'Unknown'))}
            ${item.isPinned ? '<span class="pin-icon">📌</span>' : ''}
          </div>
          <div class="history-item-meta">
            <span>上次: ${new Date(item.lastConnectedAt).toLocaleString()}</span>
            <span>消息: ${item.totalMessages || 0}</span>
          </div>
        </div>
        <div class="history-item-actions">
          <button class="btn-sm btn-secondary" data-action="connect" data-cid="${this.escapeHtml(item.cid)}">连接</button>
          <button class="btn-sm btn-secondary" data-action="pin" data-id="${item.id}" data-pinned="${!item.isPinned}">
            ${item.isPinned ? '取消置顶' : '置顶'}
          </button>
          <button class="btn-sm btn-secondary" data-action="delete" data-id="${item.id}">删除</button>
        </div>
      `;
      fragment.appendChild(div);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
    this.attachHistoryEvents(container);
  }

  private attachHistoryEvents(container: Element): void {
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const el = e.currentTarget as HTMLElement;
        const action = el.dataset.action;

        if (action === 'connect') {
          const cid = el.dataset.cid;
          if (cid) {
            const connectInput = this.shadow.getElementById('p2p-connect-input') as HTMLInputElement;
            if (connectInput) connectInput.value = cid;
            this.switchTab('connect');
          }
        } else if (action === 'pin') {
          const id = el.dataset.id;
          const pinned = el.dataset.pinned === 'true';
          if (id) await p2pManager.updateHistory(id, { isPinned: pinned });
          await this.loadHistory();
        } else if (action === 'delete') {
          const id = el.dataset.id;
          if (id) await p2pManager.deleteHistory(id);
          await this.loadHistory();
        }
      });
    });
  }

  private async loadMessages(): Promise<void> {
    const messagesList = this.shadow.getElementById('p2p-messages-list');
    const unreadBadge = this.shadow.getElementById('p2p-unread-badge');

    if (!messagesList) return;

    try {
      const messages = await p2pManager.getMessages();
      this.renderMessages(messages, messagesList);

      const unread = p2pManager.getUnreadCount();
      if (unreadBadge) {
        unreadBadge.textContent = String(unread);
        unreadBadge.style.display = unread > 0 ? 'inline-flex' : 'none';
      }
    } catch (e) {
      console.error('[P2P Modal] 加载消息失败:', e);
    }
  }

  private renderMessages(messages: P2PMessage[], container: Element): void {
    if (messages.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无消息</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    messages.slice(-20).forEach(msg => {
      const div = document.createElement('div');
      div.className = `message-item ${!msg.isRead ? 'unread' : ''}`;
      div.innerHTML = `
        <div class="message-header">
          <span class="message-sender">${this.escapeHtml(msg.fromName || msg.fromDid)}</span>
          <span class="message-time">${new Date(msg.timestamp).toLocaleString()}</span>
        </div>
        <div class="message-content">${this.escapeHtml(msg.content.substring(0, 200))}</div>
      `;
      fragment.appendChild(div);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
  }

  private async loadPeers(): Promise<void> {
    const peersList = this.shadow.getElementById('p2p-peers-list');
    const peerCount = this.shadow.getElementById('p2p-peer-count');

    if (!peersList) return;

    const peers = p2pManager.getConnectedPeers();

    if (peerCount) peerCount.textContent = String(peers.length);

    if (peers.length === 0) {
      peersList.innerHTML = '<div class="empty-hint">暂无连接</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    peers.forEach(peer => {
      const div = document.createElement('div');
      div.className = 'peer-item';
      div.innerHTML = `
        <div class="peer-status"><span class="dot online"></span></div>
        <div class="peer-info">
          <div class="peer-name">${this.escapeHtml(this.safeName(peer.info?.name, 'Unknown'))}</div>
          <div class="peer-meta">${(peer.nodeId || '').substring(0, 16)}...</div>
        </div>
      `;
      fragment.appendChild(div);
    });

    peersList.innerHTML = '';
    peersList.appendChild(fragment);
  }

  private async handleConnect(): Promise<void> {
    const input = this.shadow.getElementById('p2p-connect-input') as HTMLInputElement;
    const progressDiv = this.shadow.getElementById('p2p-connect-progress');
    const progressFill = this.shadow.getElementById('p2p-progress-fill');
    const progressText = this.shadow.getElementById('p2p-progress-text');
    const resultDiv = this.shadow.getElementById('p2p-connect-result');

    if (!input?.value.trim()) return;

    if (progressDiv) progressDiv.style.display = 'block';

    const updateProgress = (progress: ConnectProgress) => {
      if (progressFill) progressFill.style.width = `${progress.percent}%`;
      if (progressText) progressText.textContent = progress.message;
    };

    try {
      const result = await p2pManager.connect(input.value, updateProgress);

      if (result.success) {
        this.showResult(resultDiv, 'success', `已连接到 ${result.name || '节点'}`);
        input.value = '';
        await this.loadHistory();
        await this.loadPeers();
      } else {
        this.showResult(resultDiv, 'error', result.error || '连接失败');
      }
    } catch (e) {
      this.showResult(resultDiv, 'error', (e as Error).message);
    } finally {
      setTimeout(() => {
        if (progressDiv) progressDiv.style.display = 'none';
      }, 2000);
    }
  }

  private showResult(el: Element | null, type: string, text: string): void {
    if (!el) return;
    el.className = `connect-result ${type} show`;
    el.textContent = text;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 2026-07-06: 通用 name 兜底 — 防止 name=undefined/null/'undefined' 字串
  //   时 UI 渲染字面量 "undefined".
  private safeName(input: any, fallback: string): string {
    // 2026-07-06: 委托共享 safe-name.ts (有单测覆盖); 保持方法签名兼容旧调用.
    return safeAnyName(input, fallback || 'Unknown');
  }

  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  private render(): void {
    this.shadow.innerHTML = `
      <style>
        :host {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.7);
          z-index: 1000;
          align-items: center;
          justify-content: center;
        }
        :host(.show) {
          display: flex;
        }
        .modal {
          width: 90%;
          max-width: 700px;
          max-height: 90vh;
          background: var(--bg-secondary, #1e1e2e);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 12px;
          padding: 24px;
          overflow-y: auto;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .modal-header h2 {
          margin: 0;
          font-size: 18px;
          color: var(--text-primary, #e0e0e0);
        }
        .modal-close {
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: var(--text-secondary, #888);
        }
        .tabs {
          display: flex;
          gap: 4px;
          margin-bottom: 20px;
          border-bottom: 1px solid var(--border, #3a3a4a);
          padding-bottom: 8px;
        }
        .tab {
          padding: 8px 16px;
          background: transparent;
          border: none;
          border-radius: 6px 6px 0 0;
          color: var(--text-secondary, #888);
          font-size: 14px;
          cursor: pointer;
        }
        .tab:hover { color: var(--text-primary, #e0e0e0); }
        .tab.active {
          color: var(--accent, #7c3aed);
          background: var(--bg-hover, #2a2a3a);
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .identity-card {
          background: var(--bg-hover, #2a2a3a);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
        }
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 16px;
        }
        .status-indicator {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--text-muted, #666);
        }
        .status-indicator.online { background: var(--success, #22c55e); }
        .status-indicator.connecting { background: var(--warning, #eab308); animation: pulse 1s infinite; }
        .status-indicator.error { background: var(--error, #ef4444); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .info-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 0;
          border-bottom: 1px solid var(--border, #3a3a4a);
        }
        .info-row:last-child { border-bottom: none; }
        .info-label { min-width: 80px; color: var(--text-secondary, #888); font-size: 13px; }
        .info-value { flex: 1; font-size: 13px; word-break: break-all; font-family: monospace; }
        .copy-btn {
          padding: 4px 8px;
          background: var(--bg-primary, #252536);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .copy-btn:hover { background: var(--accent, #7c3aed); color: white; }
        .btn-primary {
          padding: 12px 24px;
          background: var(--accent, #7c3aed);
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          width: 100%;
        }
        .btn-primary:hover { opacity: 0.9; }
        .share-panel {
          background: var(--bg-hover, #2a2a3a);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 16px;
        }
        .share-panel h4 { margin: 0 0 12px 0; color: var(--text-primary, #e0e0e0); }
        .share-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .btn-secondary {
          padding: 8px 16px;
          background: var(--bg-primary, #252536);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-secondary:hover { border-color: var(--accent, #7c3aed); }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        .connect-form { display: flex; gap: 8px; margin-bottom: 16px; }
        .connect-form input {
          flex: 1;
          padding: 12px 16px;
          background: var(--bg-hover, #2a2a3a);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 8px;
          color: var(--text-primary, #e0e0e0);
          font-size: 14px;
        }
        .progress {
          display: none;
          margin-bottom: 16px;
          padding: 16px;
          background: var(--bg-hover, #2a2a3a);
          border-radius: 8px;
        }
        .progress.show { display: block; }
        .progress-bar {
          height: 6px;
          background: var(--bg-primary, #252536);
          border-radius: 3px;
          overflow: hidden;
          margin-bottom: 8px;
        }
        .progress-fill {
          height: 100%;
          background: var(--accent, #7c3aed);
          border-radius: 3px;
          transition: width 0.3s;
        }
        .progress-text { color: var(--text-secondary, #888); font-size: 13px; }
        .connect-result {
          display: none;
          padding: 12px;
          border-radius: 8px;
          font-size: 14px;
          margin-bottom: 16px;
        }
        .connect-result.show { display: block; }
        .connect-result.success { background: rgba(34, 197, 94, 0.1); border: 1px solid var(--success, #22c55e); color: var(--success, #22c55e); }
        .connect-result.error { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--error, #ef4444); color: var(--error, #ef4444); }
        .empty-hint { color: var(--text-muted, #666); font-size: 13px; padding: 32px; text-align: center; }
        .history-item, .peer-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          background: var(--bg-hover, #2a2a3a);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 8px;
          margin-bottom: 8px;
        }
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
        .message-item {
          padding: 12px;
          background: var(--bg-hover, #2a2a3a);
          border: 1px solid var(--border, #3a3a4a);
          border-radius: 8px;
          margin-bottom: 8px;
        }
        .message-item.unread { border-left: 3px solid var(--accent, #7c3aed); }
        .message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .message-sender { font-weight: 500; }
        .message-time { font-size: 12px; color: var(--text-secondary, #888); }
        .message-content { font-size: 14px; line-height: 1.5; }
        .peers-section {
          margin-top: 24px;
          padding-top: 16px;
          border-top: 1px solid var(--border, #3a3a4a);
        }
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
          <button class="tab ${this.activeTab === 'messages' ? 'active' : ''}" data-tab="messages">
            消息 <span id="p2p-unread-badge" class="unread-badge" style="display:none">0</span>
          </button>
        </div>

        <!-- 我的身份 -->
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
            <div class="info-row" style="margin-top: 12px; display:none" id="p2p-share-link-row">
              <input type="text" id="p2p-invite-link" readonly style="flex:1; padding:8px; background:var(--bg-primary); border:1px solid var(--border); border-radius:6px); color:var(--text-primary); font-size:12px; font-family:monospace;">
            </div>
          </div>
        </div>

        <!-- 连接 -->
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

        <!-- 历史记录 -->
        <div class="tab-content ${this.activeTab === 'history' ? 'active' : ''}" id="tab-history">
          <div class="toolbar">
            <button class="btn-secondary btn-sm" id="p2p-history-refresh">🔄 刷新</button>
          </div>
          <div id="p2p-history-list"></div>
        </div>

        <!-- 消息 -->
        <div class="tab-content ${this.activeTab === 'messages' ? 'active' : ''}" id="tab-messages">
          <div class="toolbar">
            <button class="btn-secondary btn-sm" id="p2p-mark-all-read">全部已读</button>
          </div>
          <div id="p2p-messages-list"></div>
        </div>

        <!-- 已连接节点 -->
        <div class="peers-section">
          <h4>已连接节点 (<span id="p2p-peer-count">0</span>)</h4>
          <div id="p2p-peers-list"></div>
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    // 关闭按钮
    this.shadow.getElementById('modal-close')?.addEventListener('click', () => this.hide());

    // 点击外部关闭
    this.addEventListener('click', (e) => {
      if (e.target === this) this.hide();
    });

    // 初始化按钮
    this.shadow.getElementById('p2p-init-btn')?.addEventListener('click', () => this.initP2P());

    // 复制按钮
    this.shadow.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const el = e.currentTarget as HTMLElement;
        const targetId = el.dataset.copy;
        const targetEl = this.shadow.getElementById(targetId!);
        if (targetEl?.textContent && targetEl.textContent !== '-') {
          await navigator.clipboard.writeText(targetEl.textContent);
          this.showToast('已复制');
        }
      });
    });

    // 复制链接
    this.shadow.getElementById('p2p-copy-link')?.addEventListener('click', async () => {
      const shareLink = this.shadow.getElementById('p2p-invite-link') as HTMLInputElement;
      if (shareLink?.value) {
        await navigator.clipboard.writeText(shareLink.value);
        this.showToast('链接已复制');
      }
    });

    // 导出文件
    this.shadow.getElementById('p2p-export-file')?.addEventListener('click', () => {
      p2pManager.identity.exportIdentityFile();
    });

    // 标签页切换
    this.shadow.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });

    // 连接按钮
    this.shadow.getElementById('p2p-connect-btn')?.addEventListener('click', () => this.handleConnect());

    // 回车连接
    this.shadow.getElementById('p2p-connect-input')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleConnect();
    });

    // 刷新历史
    this.shadow.getElementById('p2p-history-refresh')?.addEventListener('click', () => this.loadHistory());

    // 全部已读
    this.shadow.getElementById('p2p-mark-all-read')?.addEventListener('click', async () => {
      await p2pManager.messages.markAllRead();
      this.loadMessages();
    });
  }
}

customElements.define('p2p-modal', P2PModal);