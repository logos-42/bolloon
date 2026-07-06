/**
 * P2P Modal - 纯 TypeScript 版本
 */

class P2PModalUI {
  private modal: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private connectedPeers: Map<string, { nodeId: string; name: string; time: number }> = new Map();

  constructor() {
    this.createModal();
  }

  private createModal(): void {
    // 创建遮罩层
    this.overlay = document.createElement('div');
    this.overlay.className = 'p2p-modal-overlay';
    this.overlay.style.cssText = `
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    `;

    // 创建弹窗
    this.modal = document.createElement('div');
    this.modal.className = 'p2p-modal';
    this.modal.style.cssText = `
      width: 90%;
      max-width: 650px;
      max-height: 90vh;
      background: var(--bg-sidebar, #222220);
      border: 1px solid var(--border, #3a3a36);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;

    this.overlay.appendChild(this.modal);
    document.body.appendChild(this.overlay);

    // 点击遮罩关闭
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    this.render();
  }

  private async render(): Promise<void> {
    if (!this.modal) return;

    // 加载连接历史
    await this.loadConnectionHistory();

    // 获取身份信息
    let identityHtml = '<div class="p2p-loading">加载中...</div>';
    let identityData: any = { name: '未知', did: '未知', cid: '未知' };
    try {
      // 尝试获取 iroh 身份（包含 CID）
      const irohResp = await fetch('/api/iroh/init', { method: 'POST' });
      const irohData = await irohResp.json();
      if (irohData.cid) {
        // 2026-07-06: 防御 irohData.name 是 'undefined'/'null'/空白 的情况,
        //   否则 UI 会渲染字面量 "undefined". (multi-confirmed fix: 避免再现 v0.2.7 的 bug)
        const rawName = (typeof irohData.name === 'string' && irohData.name.trim()
          && irohData.name.trim() !== 'undefined'
          && irohData.name.trim() !== 'null') ? irohData.name.trim() : '';
        const tailName = rawName.split('-').slice(-1)[0] || '';
        identityData = {
          name: rawName || tailName || 'Bolloon',
          did: irohData.did || '未知',
          cid: irohData.cid || '未知',
          nodeId: irohData.irohNodeId ? irohData.irohNodeId.substring(0, 20) + '...' : '未知'
        };
      } else {
        // 回退到 /api/identity
        const resp = await fetch('/api/identity');
        identityData = await resp.json();
        identityData.cid = identityData.cid || '未初始化';
        identityData.nodeId = identityData.nodeId || '未知';
      }
      identityHtml = `
        <div class="p2p-section">
          <h3>身份信息</h3>
          <div class="p2p-info-row">
            <span class="label">名称:</span>
            <span class="value">${this.escapeHtml(this.safeName(identityData.name, '未知'))}</span>
          </div>
          <div class="p2p-info-row">
            <span class="label">CID:</span>
            <span class="value mono">${this.escapeHtml(identityData.cid || '未知')}</span>
          </div>
          <div class="p2p-info-row">
            <span class="label">DID:</span>
            <span class="value mono">${this.escapeHtml(identityData.did || '未知')}</span>
          </div>
          <div class="p2p-info-row">
            <span class="label">Node ID:</span>
            <span class="value mono">${this.escapeHtml(identityData.nodeId || '未知')}</span>
          </div>
          <div class="p2p-actions">
            <button class="p2p-btn-secondary" id="p2p-copy-cid-btn">复制 CID</button>
            <button class="p2p-btn-secondary" id="p2p-copy-did-btn">复制 DID</button>
            <button class="p2p-btn-secondary" id="p2p-copy-nodeid-btn">复制 Node ID</button>
          </div>
        </div>
      `;
    } catch {
      identityHtml = '<div class="p2p-error">无法加载身份信息</div>';
    }

    this.modal.innerHTML = `
      <div class="p2p-header">
        <h2>P2P 网络</h2>
        <button class="p2p-close" id="p2p-close-btn">×</button>
      </div>
      <div class="p2p-tabs">
        <button class="p2p-tab active" data-tab="identity">身份</button>
        <button class="p2p-tab" data-tab="connect">连接</button>
        <button class="p2p-tab" data-tab="messages">消息</button>
      </div>
      <div class="p2p-content">
        <div class="p2p-tab-content active" data-tab="identity">
          ${identityHtml}
        </div>
        <div class="p2p-tab-content" data-tab="connect">
          <div class="p2p-section">
            <h3>连接到节点</h3>
            <div class="p2p-connect-form">
              <input type="text" id="p2p-connect-input" placeholder="输入节点 ID 或 CID">
              <button class="p2p-btn-primary" id="p2p-connect-btn">连接</button>
            </div>
            <div id="p2p-connect-result" class="p2p-result"></div>
          </div>
          <div class="p2p-section">
            <h3>已连接的节点</h3>
            <div id="p2p-connected-peers" class="p2p-connected-peers">
              暂无连接
            </div>
          </div>
        </div>
        <div class="p2p-tab-content" data-tab="messages">
          <div class="p2p-section">
            <h3>收到的消息</h3>
            <div id="p2p-messages-list" class="p2p-messages">
              暂无消息
            </div>
          </div>
        </div>
      </div>
    `;

    // 绑定事件
    this.bindEvents();
  }

  private bindEvents(): void {
    if (!this.modal) return;

    // 关闭按钮
    const closeBtn = this.modal.querySelector('#p2p-close-btn');
    closeBtn?.addEventListener('click', () => this.hide());

    // 标签切换
    this.modal.querySelectorAll('.p2p-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const tabName = target.dataset.tab;
        if (tabName) this.switchTab(tabName);
      });
    });

    // 复制 CID
    const copyCidBtn = this.modal.querySelector('#p2p-copy-cid-btn');
    copyCidBtn?.addEventListener('click', async () => {
      try {
        const irohResp = await fetch('/api/iroh/init', { method: 'POST' });
        const data = await irohResp.json();
        if (data.cid) {
          await navigator.clipboard.writeText(data.cid);
          this.showToast('CID 已复制到剪贴板');
        }
      } catch (e) {
        console.error('复制失败:', e);
      }
    });

    // 复制 DID
    const copyDidBtn = this.modal.querySelector('#p2p-copy-did-btn');
    copyDidBtn?.addEventListener('click', async () => {
      try {
        const irohResp = await fetch('/api/iroh/init', { method: 'POST' });
        const data = await irohResp.json();
        if (data.did) {
          await navigator.clipboard.writeText(data.did);
          this.showToast('DID 已复制到剪贴板');
        }
      } catch (e) {
        console.error('复制失败:', e);
      }
    });

    // 复制 Node ID
    const copyNodeIdBtn = this.modal.querySelector('#p2p-copy-nodeid-btn');
    copyNodeIdBtn?.addEventListener('click', async () => {
      try {
        const irohResp = await fetch('/api/iroh/init', { method: 'POST' });
        const data = await irohResp.json();
        if (data.irohNodeId) {
          await navigator.clipboard.writeText(data.irohNodeId);
          this.showToast('Node ID 已复制到剪贴板');
        }
      } catch (e) {
        console.error('复制失败:', e);
      }
    });

    // 连接按钮
    const connectBtn = this.modal.querySelector('#p2p-connect-btn');
    connectBtn?.addEventListener('click', () => this.handleConnect());
  }

  private switchTab(tabName: string): void {
    if (!this.modal) return;

    this.modal.querySelectorAll('.p2p-tab').forEach(tab => {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
    });

    this.modal.querySelectorAll('.p2p-tab-content').forEach(content => {
      content.classList.toggle('active', content.getAttribute('data-tab') === tabName);
    });
  }

  private async handleConnect(): Promise<void> {
    const input = document.getElementById('p2p-connect-input') as HTMLInputElement;
    const result = document.getElementById('p2p-connect-result');
    if (!input || !result) return;

    const cid = input.value.trim();
    if (!cid) return;

    result.innerHTML = '<div class="p2p-loading">连接中...</div>';
    result.className = 'p2p-result';

    try {
      const resp = await fetch('/api/iroh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid })
      });
      const data = await resp.json();

      if (data.ok) {
        result.innerHTML = `<div class="p2p-success">连接成功！节点: ${this.escapeHtml(this.safeName(data.nodeName, cid.substring(0, 16)))}...</div>`;
        result.className = 'p2p-result success';
        // 清空输入框
        input.value = '';
        // 保存已连接节点到后端
        try {
          await fetch('/api/p2p/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cid: cid,  // 输入的 CID 或 Node ID
              irohNodeId: data.targetNodeId,
              did: data.targetNodeId,  // 用 Node ID 作为 DID
              name: data.nodeName || cid.substring(0, 16)
            })
          });
        } catch (e) {
          console.error('保存连接失败:', e);
        }
      } else {
        result.innerHTML = `<div class="p2p-error">${this.escapeHtml(data.error || '连接失败')}</div>`;
        result.className = 'p2p-result error';
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '连接失败';
      result.innerHTML = `<div class="p2p-error">${this.escapeHtml(msg)}</div>`;
      result.className = 'p2p-result error';
    }
  }

  private async loadConnectionHistory(): Promise<void> {
    try {
      const resp = await fetch('/api/p2p/history');
      const history = await resp.json();
      this.connectedPeers.clear();
      for (const entry of history) {
        this.connectedPeers.set(entry.irohNodeId || entry.did, {
          nodeId: entry.irohNodeId || entry.did,
          name: entry.name || 'Unknown',
          time: entry.lastConnectedAt || Date.now()
        });
      }
      this.updateConnectedPeersDisplay();
    } catch (e) {
      console.error('加载连接历史失败:', e);
    }
  }

  private updateConnectedPeersDisplay(): void {
    const container = document.getElementById('p2p-connected-peers');
    if (!container) return;

    if (this.connectedPeers.size === 0) {
      container.innerHTML = '<div class="p2p-empty">暂无连接</div>';
      return;
    }

    let html = '';
    for (const [nodeId, info] of this.connectedPeers) {
      const shortId = nodeId.substring(0, 16) + '...';
      const time = new Date(info.time).toLocaleTimeString();
      html += `
        <div class="p2p-peer-item">
          <span class="p2p-peer-name">${this.escapeHtml(this.safeName(info.name, shortId))}</span>
          <span class="p2p-peer-id">${shortId}</span>
          <span class="p2p-peer-time">${time}</span>
        </div>
      `;
    }
    container.innerHTML = html;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // 2026-07-06: 通用 name 兜底 — 防止 name=undefined/null/'undefined' 字串
  //   时 UI 渲染字面量 "undefined".
  private safeName(input: any, fallback: string): string {
    const f = fallback || '未知';
    if (input === undefined || input === null) return f;
    const s = String(input).trim();
    if (!s || s === 'undefined' || s === 'null' || s === 'NaN') return f;
    return s;
  }

  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'p2p-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      padding: 12px 24px;
      background: var(--bg-sidebar, #222220);
      border: 1px solid var(--accent, #c4d640);
      border-radius: 8px;
      color: var(--text, #d8d8c8);
      font-size: 14px;
      z-index: 2000;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  show(): void {
    if (this.overlay) {
      this.overlay.style.display = 'flex';
      this.render();
    }
  }

  hide(): void {
    if (this.overlay) {
      this.overlay.style.display = 'none';
    }
  }
}

// 样式
const style = document.createElement('style');
style.textContent = `
  .p2p-modal-overlay { display: none; }
  .p2p-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border, #3a3a36);
  }
  .p2p-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text, #d8d8c8);
  }
  .p2p-close {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: var(--bg-active, #333330);
    border: 1px solid var(--border, #3a3a36);
    color: var(--text-muted, #606058);
    font-size: 20px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .p2p-close:hover {
    background: var(--error-bg, rgba(239, 68, 68, 0.1));
    border-color: var(--error, #ef4444);
    color: var(--error, #ef4444);
  }
  .p2p-tabs {
    display: flex;
    gap: 4px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border, #3a3a36);
  }
  .p2p-tab {
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-secondary, #909088);
    font-size: 14px;
    cursor: pointer;
  }
  .p2p-tab:hover {
    background: var(--bg-hover, #2a2a26);
    color: var(--text, #d8d8c8);
  }
  .p2p-tab.active {
    background: var(--bg-active, #333330);
    color: var(--accent, #c4d640);
  }
  .p2p-content {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
  }
  .p2p-tab-content { display: none; }
  .p2p-tab-content.active { display: block; }
  .p2p-section { margin-bottom: 20px; }
  .p2p-section h3 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: var(--text-secondary, #909088);
    font-weight: 500;
  }
  .p2p-info-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border, #3a3a36);
  }
  .p2p-info-row .label {
    min-width: 60px;
    font-size: 13px;
    color: var(--text-secondary, #909088);
  }
  .p2p-info-row .value {
    flex: 1;
    font-size: 13px;
    color: var(--text, #d8d8c8);
  }
  .p2p-info-row .value.mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    word-break: break-all;
  }
  .p2p-btn-primary {
    width: 100%;
    padding: 12px;
    background: var(--accent, #c4d640);
    color: var(--bg, #1a1a18);
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    margin-top: 12px;
  }
  .p2p-btn-primary:hover { opacity: 0.9; }
  .p2p-connect-form { display: flex; gap: 8px; }
  .p2p-connect-form input {
    flex: 1;
    padding: 12px;
    background: var(--bg, #1a1a18);
    border: 1px solid var(--border, #3a3a36);
    border-radius: 8px;
    color: var(--text, #d8d8c8);
    font-size: 14px;
    font-family: 'JetBrains Mono', monospace;
  }
  .p2p-connect-form input:focus {
    outline: none;
    border-color: var(--accent, #c4d640);
  }
  .p2p-result {
    margin-top: 12px;
    padding: 12px;
    border-radius: 8px;
    font-size: 14px;
  }
  .p2p-result.success {
    background: var(--success-bg, rgba(34, 197, 94, 0.1));
    border: 1px solid var(--success, #22c55e);
    color: var(--success, #22c55e);
  }
  .p2p-result.error {
    background: var(--error-bg, rgba(239, 68, 68, 0.1));
    border: 1px solid var(--error, #ef4444);
    color: var(--error, #ef4444);
  }
  .p2p-messages {
    background: var(--bg, #1a1a18);
    border: 1px solid var(--border, #3a3a36);
    border-radius: 8px;
    padding: 16px;
    color: var(--text-muted, #606058);
    font-size: 14px;
    text-align: center;
  }
  .p2p-loading, .p2p-error {
    padding: 20px;
    text-align: center;
    color: var(--text-muted, #606058);
  }
  .p2p-error { color: var(--error, #ef4444); }
  .p2p-connected-peers {
    background: var(--bg, #1a1a18);
    border: 1px solid var(--border, #3a3a36);
    border-radius: 8px;
    overflow: hidden;
  }
  .p2p-connected-peers .p2p-empty {
    padding: 16px;
    text-align: center;
    color: var(--text-muted, #606058);
    font-size: 14px;
  }
  .p2p-peer-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, #3a3a36);
  }
  .p2p-peer-item:last-child { border-bottom: none; }
  .p2p-peer-name {
    font-size: 14px;
    color: var(--text, #d8d8c8);
    min-width: 80px;
  }
  .p2p-peer-id {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text-secondary, #909088);
  }
  .p2p-peer-time {
    font-size: 12px;
    color: var(--text-muted, #606058);
  }
`;
document.head.appendChild(style);

// 全局实例
const p2pModal = new P2PModalUI();

// 导出到 window
(window as unknown as Record<string, unknown>).p2pModal = p2pModal;
(window as unknown as Record<string, unknown>).showP2PModal = () => p2pModal.show();
(window as unknown as Record<string, unknown>).hideP2PModal = () => p2pModal.hide();

console.log('[P2P Modal] 已初始化');
