/**
 * mobile.js — 手机端 UI 交互 (微信风格, Capacitor webview)
 * bolloon WebUI 主题配色. 数据来自 bolloon server HTTP API.
 * 触控组件: tab 切换 / 列表点击 / 聊天输入.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const api = {
    async get(path) {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    async post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  };

  // === tab 切换 ===
  const TITLES = { wechat: '微信', contacts: '通讯录', discover: '发现', me: '我' };
  function switchTab(tab) {
    $$('.page').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#topbar-title').textContent = TITLES[tab] || '微信';
    // 触控 MCP: 切换 tab 通知
    window.__mobileTouch?.('tab', tab);
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // === 会话列表 (微信 tab) — 智能体 channel ===
  async function loadConversations() {
    try {
      const channels = await api.get('/channels');
      const list = $('#conversation-list');
      list.innerHTML = '';
      if (!Array.isArray(channels) || channels.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无会话, 点右上角 + 添加</div>';
        return;
      }
      channels.forEach((ch) => {
        const name = ch.persona?.name || ch.name || ch.agentId || '智能体';
        const el = document.createElement('div');
        el.className = 'conv-item';
        el.innerHTML = `
          <div class="conv-avatar">${name.charAt(0)}</div>
          <div class="conv-body">
            <div class="conv-name">${escapeHtml(name)}</div>
            <div class="conv-preview">${escapeHtml(ch.preview || '开始对话')}</div>
          </div>`;
        el.addEventListener('click', () => openChat(ch));
        list.appendChild(el);
      });
    } catch (e) {
      $('#conversation-list').innerHTML = `<div style="padding:20px;color:var(--error)">加载失败: ${escapeHtml(e.message)}</div>`;
    }
  }

  // === 通讯录 (P2P 好友) ===
  async function loadContacts() {
    try {
      let peers = [];
      try { peers = await api.get('/api/peers'); } catch { peers = []; }
      const list = $('#contacts-list');
      list.innerHTML = '';
      if (!Array.isArray(peers) || peers.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无好友</div>';
        return;
      }
      peers.forEach((p) => {
        const name = p.name || p.publicKey?.slice(0, 12) || '好友';
        const el = document.createElement('div');
        el.className = 'conv-item';
        el.innerHTML = `<div class="conv-avatar">${escapeHtml(name.charAt(0))}</div>
          <div class="conv-body"><div class="conv-name">${escapeHtml(name)}</div></div>`;
        list.appendChild(el);
      });
    } catch (e) { /* 忽略 */ }
  }

  // === 我的页 / 登录状态 ===
  async function loadMe() {
    try {
      const s = await api.get('/api/auth/status');
      $('#me-avatar').textContent = (s.name || 'U').charAt(0);
      $('#me-name').textContent = s.name || '未登录';
      $('#me-did').textContent = s.didShort || s.did || '';
      const hasAccount = (s.accounts && s.accounts.length > 0);
      $('#login-label').textContent = hasAccount ? '已登录账号' : '登录';
    } catch (e) { /* 默认未登录 */ }
  }

  // === 聊天页 ===
  let activeChannel = null;
  function openChat(ch) {
    activeChannel = ch;
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'chat-page';
    const name = ch.persona?.name || ch.name || ch.agentId || '智能体';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="chat-back">‹</button>
        <div style="flex:1;font-weight:600">${escapeHtml(name)}</div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-bar">
        <input id="chat-input" placeholder="输入消息...">
        <button id="chat-send">发送</button>
      </div>`;
    document.body.appendChild(page);
    $('#chat-back').addEventListener('click', () => page.remove());
    $('#chat-send').addEventListener('click', sendChat);
    $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    loadMessages();
    window.__mobileTouch?.('chat', ch.id);
  }

  async function loadMessages() {
    if (!activeChannel) return;
    const box = $('#chat-messages');
    try {
      const data = await api.get(`/sessions/${encodeURIComponent(activeChannel.id)}`);
      const msgs = data?.messages || [];
      box.innerHTML = '';
      msgs.slice(-50).forEach((m) => {
        const role = (m.role || m.type || '') === 'user' ? 'user' : 'ai';
        const d = document.createElement('div');
        d.className = 'bubble ' + role;
        d.textContent = m.content || '';
        box.appendChild(d);
      });
      box.scrollTop = box.scrollHeight;
    } catch (e) { box.innerHTML = '<div style="color:var(--text-muted)">暂无历史消息</div>'; }
  }

  async function sendChat() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || !activeChannel) return;
    input.value = '';
    const box = $('#chat-messages');
    const userBubble = document.createElement('div');
    userBubble.className = 'bubble user';
    userBubble.textContent = text;
    box.appendChild(userBubble);
    box.scrollTop = box.scrollHeight;
    try {
      await api.post('/message', { text, channelId: activeChannel.id });
      setTimeout(loadMessages, 800);
    } catch (e) {
      const ai = document.createElement('div');
      ai.className = 'bubble ai';
      ai.textContent = '发送失败: ' + (e.message || '');
      box.appendChild(ai);
    }
  }

  // === 设置 / 钱包 入口 (跳回桌面 Web 对应页面或弹提示) ===
  function bindMenu() {
    $('#item-settings').addEventListener('click', () => { openUrl('/api-config'); });
    $('#item-wallet').addEventListener('click', () => { alert('钱包管理 (桌面 Web UI 提供)'); });
    $('#item-judgments').addEventListener('click', () => { alert('判断力 API (桌面 Web UI 提供)'); });
    $('#item-did').addEventListener('click', () => { api.get('/api/auth/status').then((s) => alert('DID: ' + (s.did || '未生成'))); });
    $('#item-login').addEventListener('click', () => { openUrl('/#auth'); });
    $('#item-logout').addEventListener('click', () => { api.post('/api/auth/logout', { provider: 'github' }).then(() => loadMe()); });
    $('#btn-add').addEventListener('click', () => { alert('添加好友: 在桌面 Web UI 的 P2P 好友中添加'); });
    $('#item-p2p').addEventListener('click', () => { switchTab('contacts'); });
    $('#item-p2p-id').addEventListener('click', async () => {
      try { const peers = await api.get('/api/peers'); alert('我的 P2P ID 见桌面 Web UI'); } catch { alert('P2P 未连接'); }
    });
  }

  function openUrl(url) {
    // Capacitor 环境跳转 webview; 否则新窗口
    if (window.Capacitor && window.Capacitor.isNativePlatform?.()) {
      location.href = url;
    } else {
      window.open(url, '_blank');
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // === MCP 触控钩子: 供原生/外部通过 MCP 控制触控组件 ===
  window.__mobileTouch = (type, data) => {
    // 预留: 触控事件通过 MCP 协议上报/控制
  };

  // === 初始化 ===
  function init() {
    bindMenu();
    switchTab('wechat');
    loadConversations();
    loadContacts();
    loadMe();
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
