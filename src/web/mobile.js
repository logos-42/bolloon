/**
 * mobile.js — 手机端 UI 交互 (微信风格, Capacitor webview)
 * bolloon WebUI 主题配色. 数据来自 bolloon server HTTP API + SSE 流式聊天.
 * 触控组件: tab 切换 / 列表点击 / 聊天输入 / 设置 / MCP 工具调用.
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

  // === 主题 (外观切换, 复用 WebUI 主题变量) ===
  const THEMES = {
    dark: { '--bg': '#1a1a18', '--bg-card': '#222220', '--bg-hover': '#2a2a26', '--text': '#d8d8c8', '--text-secondary': '#909088', '--accent': '#c4d640', '--border': '#3a3a36' },
    light: { '--bg': '#f5f5f0', '--bg-card': '#ffffff', '--bg-hover': '#eeeeea', '--text': '#1a1a18', '--text-secondary': '#606058', '--accent': '#8a9430', '--border': '#d0d0c8' },
  };
  function applyTheme(name) {
    const t = THEMES[name] || THEMES.dark;
    const root = document.documentElement;
    Object.entries(t).forEach(([k, v]) => root.style.setProperty(k, v));
    localStorage.setItem('bolloon_theme', name);
    const btn = $('#theme-toggle');
    if (btn) btn.textContent = name === 'dark' ? '🌙 深色' : '☀️ 浅色';
  }

  // === tab 切换 ===
  const TITLES = { wechat: '微信', contacts: '通讯录', discover: '发现', me: '我' };
  function switchTab(tab) {
    $$('.page').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#topbar-title').textContent = TITLES[tab] || '微信';
    if (tab === 'discover') loadMcpTools();
    window.__mobileTouch?.('tab', tab);
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // === 会话列表 ===
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
          <div class="conv-avatar">${escapeHtml(name.charAt(0))}</div>
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

  // === 通讯录 ===
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

  // === 发现: MCP 工具列表 (MCP 前端支持) ===
  async function loadMcpTools() {
    const box = $('#mcp-tools');
    if (!box) return;
    box.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted)">加载 MCP 工具...</div>';
    try {
      const r = await api.get('/api/mcp/tools').catch(() => null);
      const tools = r?.tools || r || [];
      if (!Array.isArray(tools) || tools.length === 0) {
        box.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted)">暂无可用 MCP 工具</div>';
        return;
      }
      box.innerHTML = '';
      tools.forEach((t) => {
        const name = t.name || t.function?.name || '工具';
        const desc = t.description || t.function?.description || '';
        const el = document.createElement('div');
        el.className = 'conv-item';
        el.innerHTML = `<div class="conv-avatar">🔌</div>
          <div class="conv-body"><div class="conv-name">${escapeHtml(name)}</div>
          <div class="conv-preview">${escapeHtml(desc)}</div></div>`;
        el.addEventListener('click', () => { window.__mobileTouch?.('mcp', name); alert('MCP 工具: ' + name + '\n可在对话中让智能体调用'); });
        box.appendChild(el);
      });
    } catch (e) { box.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted)">MCP 工具加载失败</div>'; }
  }

  // === 我的页 ===
  async function loadMe() {
    try {
      const s = await api.get('/api/auth/status');
      $('#me-avatar').textContent = (s.name || 'U').charAt(0);
      $('#me-name').textContent = s.name || '未登录';
      $('#me-did').textContent = s.didShort || s.did || '';
      const hasAccount = (s.accounts && s.accounts.length > 0);
      $('#login-label').textContent = hasAccount ? '已登录账号' : '登录';
      $('#settings-did').textContent = 'DID: ' + (s.did || '未生成');
      $('#settings-login-state').textContent = hasAccount ? '已登录 (' + (s.accounts.map(a => a.provider).join(',')) + ')' : '未登录';
    } catch (e) { /* 默认 */ }
  }

  // === 聊天页 (SSE 流式) ===
  let activeChannel = null;
  let chatEventSource = null;
  let streamingBubble = null;

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
    $('#chat-back').addEventListener('click', closeChat);
    $('#chat-send').addEventListener('click', sendChat);
    $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    loadMessages();
    openChatSse();
    window.__mobileTouch?.('chat', ch.id);
  }

  function closeChat() {
    if (chatEventSource) { chatEventSource.close(); chatEventSource = null; }
    const p = $('#chat-page');
    if (p) p.remove();
    activeChannel = null;
    loadConversations();
  }

  function openChatSse() {
    if (chatEventSource) chatEventSource.close();
    if (!activeChannel) return;
    // 订阅全局事件流, 过滤当前 channel 的 AI 流式回复 (step/token/ai)
    try {
      chatEventSource = new EventSource('/events');
      chatEventSource.onmessage = (e) => {
        if (!activeChannel || !e.data) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        const box = $('#chat-messages');
        if (!box) return;
        // AI 消息 / token 流 → 流式气泡
        if (msg.type === 'ai' || msg.type === 'token' || msg.role === 'ai') {
          const content = msg.content || msg.text || '';
          if (msg.channelId && msg.channelId !== activeChannel.id) return;
          if (!streamingBubble || !streamingBubble.isConnected) {
            streamingBubble = document.createElement('div');
            streamingBubble.className = 'bubble ai';
            box.appendChild(streamingBubble);
          }
          streamingBubble.textContent += content;
          box.scrollTop = box.scrollHeight;
        } else if (msg.type === 'done') {
          streamingBubble = null;
          setTimeout(loadMessages, 300);
        }
      };
      chatEventSource.onerror = () => { /* SSE 断线静默重连 */ };
    } catch (e) { /* SSE 不支持则退回轮询 */ }
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
      // AI 回复走 SSE 流式 (openChatSse)
      setTimeout(() => { if (!streamingBubble) loadMessages(); }, 1500);
    } catch (e) {
      const ai = document.createElement('div');
      ai.className = 'bubble ai';
      ai.textContent = '发送失败: ' + (e.message || '');
      box.appendChild(ai);
    }
  }

  // === 设置页 (弹层) ===
  function openSettings() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'settings-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="settings-back">‹</button>
        <div style="flex:1;font-weight:600">设置</div>
      </div>
      <div style="padding:12px">
        <div class="conv-item" id="theme-toggle">🌙 深色</div>
        <div class="conv-item" id="settings-api"><span class="list-icon">🔧</span><span>API 配置</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-wallet"><span class="list-icon">👛</span><span>钱包</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-judgments"><span class="list-icon">🧠</span><span>判断力 API</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-did">🪪 DID</div>
        <div class="conv-item" id="settings-login-state">🔐 登录状态</div>
      </div>`;
    document.body.appendChild(page);
    const theme = localStorage.getItem('bolloon_theme') || 'dark';
    applyTheme(theme);
    $('#settings-back').addEventListener('click', () => page.remove());
    $('#theme-toggle').addEventListener('click', () => applyTheme(localStorage.getItem('bolloon_theme') === 'dark' ? 'light' : 'dark'));
    $('#settings-api').addEventListener('click', () => openUrl('/api-config'));
    $('#settings-wallet').addEventListener('click', () => alert('钱包管理 (桌面 Web UI 提供)'));
    $('#settings-judgments').addEventListener('click', () => alert('判断力 API (桌面 Web UI 提供)'));
    $('#settings-did').addEventListener('click', () => { api.get('/api/auth/status').then((s) => alert('DID: ' + (s.did || '未生成'))); });
  }

  // === 菜单绑定 ===
  function bindMenu() {
    $('#item-settings').addEventListener('click', openSettings);
    $('#item-wallet').addEventListener('click', () => { alert('钱包管理 (桌面 Web UI 提供)'); });
    $('#item-judgments').addEventListener('click', () => { alert('判断力 API (桌面 Web UI 提供)'); });
    $('#item-did').addEventListener('click', () => { api.get('/api/auth/status').then((s) => alert('DID: ' + (s.did || '未生成'))); });
    $('#item-login').addEventListener('click', () => { openUrl('/api-config'); });
    $('#item-logout').addEventListener('click', () => { api.post('/api/auth/logout', { provider: 'github' }).then(() => loadMe()); });
    $('#btn-add').addEventListener('click', () => { alert('添加好友: 在桌面 Web UI 的 P2P 好友中添加'); });
    $('#item-p2p').addEventListener('click', () => { switchTab('contacts'); });
    $('#item-p2p-id').addEventListener('click', () => { alert('我的 P2P ID 见桌面 Web UI'); });
  }

  function openUrl(url) {
    if (window.Capacitor && window.Capacitor.isNativePlatform?.()) location.href = url;
    else window.open(url, '_blank');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // === MCP 触控钩子 ===
  window.__mobileTouch = (type, data) => {
    // 预留: 触控事件上报/控制
  };

  function init() {
    bindMenu();
    applyTheme(localStorage.getItem('bolloon_theme') || 'dark');
    switchTab('wechat');
    loadConversations();
    loadContacts();
    loadMe();
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
