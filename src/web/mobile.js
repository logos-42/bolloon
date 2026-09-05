(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const core = window.BolloonCore;
  const api = {
    async get(path) {
      const fn = core?.resolve?.(path);
      if (fn) return fn();
      throw new Error(`本地内核无此路径: ${path}`);
    },
    async post(path, body) {
      const fn = core?.resolvePost?.(path, body);
      if (fn) return fn();
      throw new Error(`本地内核无此路径: ${path}`);
    },
  };

  const THEMES = {
    dark: { '--bg': '#1a1a18', '--bg-card': '#222220', '--bg-hover': '#2a2a26', '--text': '#d8d8c8', '--text-secondary': '#909088', '--accent': '#c4d640', '--border': '#3a3a36' },
    light: { '--bg': '#f5f5f0', '--bg-card': '#ffffff', '--bg-hover': '#eeeeea', '--text': '#1a1a18', '--text-secondary': '#606058', '--accent': '#8a9430', '--border': '#d0d0c8' },
  };
  function systemTheme() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch { return 'dark'; }
  }
  function resolveTheme() {
    try { return localStorage.getItem('bolloon_theme') || systemTheme(); }
    catch { return systemTheme(); }
  }
  let currentTheme = 'dark';
  function applyTheme(name, persist = true) {
    const n = name === 'light' ? 'light' : 'dark';
    currentTheme = n;
    const t = THEMES[n];
    const root = document.documentElement;
    Object.entries(t).forEach(([k, v]) => root.style.setProperty(k, v));
    if (persist) localStorage.setItem('bolloon_theme', n);
  }

  const TITLES = { main: '首页', network: '网络', me: '我' };
  let currentTab = 'main';
  function switchTab(tab) {
    currentTab = tab;
    $$('.page, .page-container').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#topbar-title').textContent = TITLES[tab] || '会话';
    const cs = $('#btn-create-session'); if (cs) cs.hidden = tab !== 'main';
    if (tab === 'network') { loadContacts(); loadMcpTools(); loadApprovals(); }
    if (tab === 'main') { loadAgentCovers(); }
    window.__mobileTouch?.('tab', tab);
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  async function loadConversations() {
    try {
      const channels = await api.get('/channels');
      const list = $('#conversation-list');
      if (!list) return;
      list.innerHTML = '';
      if (!Array.isArray(channels) || channels.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无会话</div>';
        return;
      }
      channels.forEach((ch) => {
        const name = ch.persona?.name || ch.name || ch.agentId || '智能体';
        const el = document.createElement('div');
        el.className = 'conv-item';
        el.innerHTML = `<div class="conv-avatar">${escapeHtml(name.charAt(0))}</div>
          <div class="conv-body">
            <div class="conv-name">${escapeHtml(name)}</div>
            <div class="conv-preview">${escapeHtml(ch.preview || '开始对话')}</div>
          </div>`;
        el.addEventListener('click', () => openChat(ch));
        list.appendChild(el);
      });
    } catch (e) {
      const list = $('#conversation-list');
      if (list) list.innerHTML = `<div style="padding:20px;color:var(--error)">加载失败</div>`;
    }
  }

  async function loadContacts() {
    try {
      let peers = [];
      try { peers = await api.get('/api/peers'); } catch { peers = []; }
      const list = $('#contacts-list');
      if (!list) return;
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
        el.addEventListener('click', () => { window.__mobileTouch?.('mcp', name); });
        box.appendChild(el);
      });
    } catch (e) { box.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted)">MCP 工具加载失败</div>'; }
  }

  async function loadApprovals() {
    const box = $('#approval-list');
    if (!box) return;
    try {
      const r = await api.get('/api/payments/pending');
      const approvals = r.approvals || [];
      box.innerHTML = '';
      if (approvals.length === 0) {
        box.innerHTML = '<div style="padding:10px 16px;color:var(--text-muted)">无待审批支付</div>';
        return;
      }
      approvals.forEach((a) => {
        const el = document.createElement('div');
        el.className = 'conv-item';
        el.style.flexDirection = 'column';
        el.style.alignItems = 'flex-start';
        el.innerHTML = `
          <div style="width:100%"><b>${escapeHtml(a.service)}</b> $${a.amount} → ${escapeHtml(String(a.recipient).slice(0, 14))}...</div>
          <div style="color:var(--text-muted);font-size:12px">${escapeHtml(a.reason)}</div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <button class="approve-btn" data-id="${escapeHtml(a.id)}" style="background:var(--success,#22c55e);border:none;border-radius:6px;padding:4px 14px;color:#fff">批准</button>
            <button class="reject-btn" data-id="${escapeHtml(a.id)}" style="background:var(--error,#ef4444);border:none;border-radius:6px;padding:4px 14px;color:#fff">拒绝</button>
          </div>`;
        el.querySelector('.approve-btn').addEventListener('click', async () => {
          await api.post(`/api/payments/${a.id}/approve`, {}).catch(() => {});
          loadApprovals();
        });
        el.querySelector('.reject-btn').addEventListener('click', async () => {
          await api.post(`/api/payments/${a.id}/reject`, {}).catch(() => {});
          loadApprovals();
        });
        box.appendChild(el);
      });
    } catch (e) { box.innerHTML = '<div style="padding:10px;color:var(--error)">审批加载失败</div>'; }
  }

  async function loadMe() {
    try {
      const s = await api.get('/api/auth/status');
      $('#me-avatar').textContent = (s.name || 'U').charAt(0);
      $('#me-name').textContent = s.name || '未登录';
      $('#me-did').textContent = s.didShort || s.did || '';
      const hasAccount = (s.accounts && s.accounts.length > 0);
      $('#login-label').textContent = hasAccount ? '已登录账号' : '登录';
    } catch (e) { /* 默认 */ }
  }

  // === 双频滑动卡片 ===
  let currentCardIndex = 0;
  let allAgentCards = [];

  async function loadAgentCovers() {
    const track = $('#card-track');
    if (!track) return;
    track.innerHTML = '<div class="card-loading">加载智能体卡片...</div>';
    try {
      const [channels, peers] = await Promise.all([
        api.get('/channels').catch(() => []),
        api.get('/api/peers').catch(() => []),
      ]);
      const channelList = Array.isArray(channels) ? channels : [];
      const peerList = Array.isArray(peers) ? peers : [];

      // 本机智能体卡片: 任何情况下都先显示自己, 保证首页不空 (无同步/无好友也可见)
      allAgentCards = [];
      try {
        const self = await core.identity?.status?.();
        if (self && self.did) {
          allAgentCards.push({
            id: self.did, agentId: self.did,
            name: self.name || '本机智能体',
            desc: '本机 Agent (手机端自治执行)',
            avatar: null, peer: null,
            status: 'online', lastActive: '刚刚',
            capabilities: ['chat', 'local-agent'],
            deletable: false,
          });
        }
      } catch {}

      allAgentCards = allAgentCards.concat(channelList.map((ch, i) => {
        const peer = peerList.find((p) => p.id === ch.agentId || p.publicKey?.slice(0, 12) === ch.agentId?.slice(0, 12));
        return {
          id: ch.id,
          agentId: ch.agentId || `agent-${i}`,
          name: ch.persona?.name || ch.name || ch.agentId || '智能体',
          desc: ch.preview || '暂无描述',
          avatar: ch.persona?.avatar || null,
          peer: peer ? { name: peer.name || '好友', online: peer.online } : null,
          status: 'online',
          lastActive: ch.ts ? new Date(ch.ts).toLocaleDateString() : '未知',
          capabilities: ['chat', 'local-agent'],
          deletable: true,
        };
      }));

      peerList.forEach((p) => {
        const exists = allAgentCards.some((c) => c.peer?.name === p.name);
        if (!exists) {
          allAgentCards.push({
            id: p.id || p.publicKey?.slice(0, 12) || `peer-${Date.now()}`,
            agentId: p.id || p.publicKey?.slice(0, 12),
            name: p.name || '未知好友',
            desc: 'P2P 好友智能体',
            avatar: null,
            peer: { name: p.name || '好友', online: p.online || false },
            status: p.online ? 'online' : 'offline',
            lastActive: '刚刚',
            capabilities: ['chat'],
            deletable: false,
          });
        }
      });

      renderCardTrack();
      setupCardSwipe();
    } catch (e) {
      track.innerHTML = `<div class="card-empty">智能体卡片加载失败</div>`;
    }
  }

  function renderCardTrack() {
    const track = $('#card-track');
    const indicator = $('#card-indicator');
    if (!track || !indicator) return;

    if (allAgentCards.length === 0) {
      track.innerHTML = '<div class="card-empty">暂无智能体卡片</div>';
      indicator.innerHTML = '';
      return;
    }

    track.innerHTML = allAgentCards.map((card, i) => `
      <div class="card-wrap" data-index="${i}">
        ${card.deletable ? `<button class="card-delete" data-index="${i}">删除</button>` : ''}
        <div class="agent-card ${i === 0 ? 'active-card' : ''}" data-index="${i}">
          <div class="card-cover">
            <div class="card-cover-placeholder">${escapeHtml(card.name.charAt(0))}</div>
            <div class="card-cover-info">
              <div class="card-cover-name">${escapeHtml(card.name)}</div>
              <div class="card-cover-desc">${escapeHtml(card.desc)}</div>
            </div>
          </div>
          <div class="card-body">
            <div class="card-body-row">
              <span class="card-body-label">状态</span>
              <span class="card-body-value" style="color:${card.status === 'online' ? 'var(--accent)' : 'var(--text-muted)'}">${card.status === 'online' ? '在线' : '离线'}</span>
            </div>
            <div class="card-body-row">
              <span class="card-body-label">好友</span>
              <span class="card-body-value">${card.peer ? escapeHtml(card.peer.name) : '—'}</span>
            </div>
            <div class="card-body-row">
              <span class="card-body-label">活跃度</span>
              <span class="card-body-value">${escapeHtml(card.lastActive)}</span>
            </div>
            <button class="card-action-btn" data-index="${i}">开始对话</button>
          </div>
        </div>
      </div>
    `).join('');

    indicator.innerHTML = allAgentCards.map((_, i) =>
      `<div class="card-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></div>`
    ).join('');

    track.querySelectorAll('.agent-card').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        if (!isNaN(idx)) openCardDetail(idx);
      });
    });

    track.querySelectorAll('.card-action-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        if (!isNaN(idx) && allAgentCards[idx]) openChat(allAgentCards[idx]);
      });
    });

    track.querySelectorAll('.card-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        const card = allAgentCards[idx];
        if (!card || card.deletable === false) return;
        try {
          await api.post('/api/channels/delete', { id: card.id });
          loadAgentCovers();
        } catch (err) {
          alert('删除失败: ' + (err.message || err));
        }
      });
    });

    indicator.querySelectorAll('.card-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        const idx = parseInt(dot.dataset.index);
        scrollToCard(idx);
      });
    });

    currentCardIndex = 0;
    updateCardIndicator();
  }

  function closeCardReveals() {
    $$('.card-wrap .agent-card.reveal-delete').forEach((c) => c.classList.remove('reveal-delete'));
  }

  function setupCardSwipe() {
    const track = $('#card-track');
    if (!track) return;

    let startX = 0, startY = 0, isDragging = false;

    function revealAt(x, y, reveal) {
      const el = document.elementFromPoint(x, y);
      const wrap = el && el.closest ? el.closest('.card-wrap') : null;
      if (!wrap) return;
      const card = wrap.querySelector('.agent-card');
      const idx = parseInt(wrap.dataset.index);
      const c = allAgentCards[idx];
      if (!card) return;
      if (reveal && c && c.deletable === false) { closeCardReveals(); return; }
      if (reveal) closeCardReveals();
      card.classList.toggle('reveal-delete', !!reveal);
    }

    track.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isDragging = false;
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > dy && dx > 10) isDragging = true;
    }, { passive: true });

    track.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      const t = e.changedTouches[0];
      const diff = t.clientX - startX;
      const cardW = track.querySelector('.agent-card')?.offsetWidth || window.innerWidth * 0.85;
      if (Math.abs(diff) > cardW * 0.3) {
        closeCardReveals();
        if (diff < 0 && currentCardIndex < allAgentCards.length - 1) scrollToCard(currentCardIndex + 1);
        else if (diff > 0 && currentCardIndex > 0) scrollToCard(currentCardIndex - 1);
      } else if (diff < -30) {
        revealAt(t.clientX, t.clientY, true);   // 轻微左滑 → 显示删除
      } else if (diff > 30) {
        revealAt(t.clientX, t.clientY, false);  // 右滑 → 收起删除
      }
    });

    let mouseStartX = 0;
    track.addEventListener('mousedown', (e) => {
      mouseStartX = e.clientX;
      isDragging = false;
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - mouseStartX) > 10) isDragging = true;
      };
      const onUp = (ev) => {
        const diff = ev.clientX - mouseStartX;
        const cardW = track.querySelector('.agent-card')?.offsetWidth || window.innerWidth * 0.85;
        if (isDragging) {
          if (Math.abs(diff) > cardW * 0.3) {
            closeCardReveals();
            if (diff < 0 && currentCardIndex < allAgentCards.length - 1) scrollToCard(currentCardIndex + 1);
            else if (diff > 0 && currentCardIndex > 0) scrollToCard(currentCardIndex - 1);
          } else if (diff < -30) {
            revealAt(ev.clientX, ev.clientY, true);
          } else if (diff > 30) {
            revealAt(ev.clientX, ev.clientY, false);
          }
        }
        track.removeEventListener('mousemove', onMove);
        track.removeEventListener('mouseup', onUp);
      };
      track.addEventListener('mousemove', onMove);
      track.addEventListener('mouseup', onUp);
    });

    track.addEventListener('scroll', () => {
      const cards = track.querySelectorAll('.agent-card');
      cards.forEach((card, i) => {
        const rect = card.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        if (Math.abs(rect.left + rect.width / 2 - (trackRect.left + trackRect.width / 2)) < rect.width / 2) {
          currentCardIndex = i;
          updateCardIndicator();
        }
      });
    });
  }

  function scrollToCard(index) {
    const track = $('#card-track');
    if (!track) return;
    const cards = track.querySelectorAll('.agent-card');
    if (cards[index]) {
      cards[index].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      currentCardIndex = index;
      cards.forEach((c, i) => c.classList.toggle('active-card', i === index));
      updateCardIndicator();
    }
  }

  function updateCardIndicator() {
    $$('.card-dot').forEach((dot, i) => dot.classList.toggle('active', i === currentCardIndex));
  }

  function openCardDetail(index) {
    const card = allAgentCards[index];
    if (!card) return;
    const detail = $('#card-detail');
    if (!detail) return;
    $('#detail-name').textContent = card.name;
    $('#detail-body').innerHTML = `
      <div class="detail-section">
        <div class="detail-section-title">基本信息</div>
        <div class="detail-meta">
          <div class="detail-meta-item"><div class="label">智能体ID</div><div class="value">${escapeHtml(card.agentId)}</div></div>
          <div class="detail-meta-item"><div class="label">状态</div><div class="value">${card.status === 'online' ? '在线' : '离线'}</div></div>
          <div class="detail-meta-item"><div class="label">好友</div><div class="value">${card.peer ? escapeHtml(card.peer.name) : '—'}</div></div>
          <div class="detail-meta-item"><div class="label">活跃度</div><div class="value">${escapeHtml(card.lastActive)}</div></div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">能力</div>
        <div class="detail-meta">
          <div class="detail-meta-item" style="grid-column:1/-1"><div class="label">支持功能</div><div class="value">${card.capabilities.join(', ')}</div></div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">描述</div>
        <p style="color:var(--text-secondary);font-size:14px;line-height:1.6">${escapeHtml(card.desc)}</p>
      </div>
      <button class="card-action-btn" id="detail-chat-btn">开始对话</button>
    `;
    detail.hidden = false;
    const chatBtn = $('#detail-chat-btn');
    if (chatBtn) chatBtn.addEventListener('click', () => { closeCardDetail(); openChat(card); });
  }

  function closeCardDetail() {
    const d = $('#card-detail');
    if (d) d.hidden = true;
  }

  // === 聊天 ===
  let activeChannel = null;
  let chatEventSource = null;
  let streamingBubble = null;

   function openChat(ch) {
     activeChannel = ch;
     const page = document.createElement('div');
     page.className = 'chat-page';
     page.id = 'chat-page';
     const name = ch.name || ch.agentId || '智能体';
     page.innerHTML = `
       <div class="chat-topbar">
         <button class="icon-btn" id="chat-back">←</button>
         <div style="flex:1;font-weight:600">${escapeHtml(name)}</div>
       </div>
       <div class="loop-status-bar" id="loop-status-bar" hidden>
         <div class="loop-status-spinner"></div>
         <span class="loop-status-text" id="loop-status-text"></span>
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
  }

   function openChatSse() {
     if (chatEventSource) { chatEventSource.close(); chatEventSource = null; }
     if (!activeChannel || !core?.events?.subscribe) return;
     chatEventSource = { close() {} };
     const unsub = core.events.subscribe((msg) => {
       if (!activeChannel || !msg) return;
       const box = $('#chat-messages');
       if (!box) return;

       // Agent loop 循环工作流事件
       if (msg.type === 'loop-status') {
         const statusBar = $('#loop-status-bar');
         const statusText = $('#loop-status-text');
         if (statusBar && statusText) {
           statusBar.hidden = false;
           statusText.textContent = msg.message || '智能体工作中...';
         }
         // loop-status:done 时隐藏
         if (msg.status === 'done') {
           setTimeout(() => {
             const sb = $('#loop-status-bar');
             if (sb) sb.hidden = true;
           }, 1500);
         }
         return;
       }

       if (msg.type === 'ai' || msg.type === 'token' || msg.role === 'ai') {
         if (msg.channelId && msg.channelId !== activeChannel.id) return;
         if (!streamingBubble || !streamingBubble.isConnected) {
           streamingBubble = document.createElement('div');
           streamingBubble.className = 'bubble ai';
           box.appendChild(streamingBubble);
         }
         streamingBubble.textContent += (msg.content || msg.text || '');
         box.scrollTop = box.scrollHeight;
       } else if (msg.type === 'done') {
         streamingBubble = null;
         setTimeout(loadMessages, 300);
       }
     });
     chatEventSource.close = unsub;
   }

  async function loadMessages() {
    if (!activeChannel) return;
    const box = $('#chat-messages');
    if (!box) return;
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
    if (!input) return;
    const text = input.value.trim();
    if (!text || !activeChannel) return;
    input.value = '';
    const box = $('#chat-messages');
    if (!box) return;
    const userBubble = document.createElement('div');
    userBubble.className = 'bubble user';
    userBubble.textContent = text;
    box.appendChild(userBubble);
    box.scrollTop = box.scrollHeight;
    try {
      await api.post('/message', { text, channelId: activeChannel.id });
      setTimeout(() => { if (!streamingBubble) loadMessages(); }, 1500);
    } catch (e) {
      const ai = document.createElement('div');
      ai.className = 'bubble ai';
      ai.textContent = '发送失败: ' + (e.message || '');
      box.appendChild(ai);
    }
  }

  // === 设置 ===
  function openSettings() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'settings-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="settings-back">←</button>
        <div style="flex:1;font-weight:600">设置</div>
      </div>
      <div style="padding:12px">
        <div class="conv-item" id="api-config-item"><span class="list-icon">🤖</span><span>API 配置</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="theme-toggle">🌙 深色</div>
        <div class="conv-item" id="settings-network"><span class="list-icon">🌐</span><span>网络与同步</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-did">🪪 DID</div>
      </div>`;
    document.body.appendChild(page);
    applyTheme(resolveTheme(), false);
    $('#settings-back').addEventListener('click', () => page.remove());
    $('#api-config-item').addEventListener('click', openApiConfig);
    $('#theme-toggle').addEventListener('click', () => {
      applyTheme(currentTheme === 'dark' ? 'light' : 'dark', true);
    });
    $('#settings-network').addEventListener('click', () => switchTab('network'));
    $('#settings-did').addEventListener('click', () => { api.get('/api/auth/status').then((s) => alert('DID: ' + (s.did || '未生成'))); });
  }

  // === API 配置 (LLM 供应商) ===
  const LLM_PROVIDERS = ['deepseek', 'openai', 'anthropic', 'minimax', 'openrouter', '自定义'];
  const LLM_DEFAULTS = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
    minimax: { baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-M2.7' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  };
  async function openApiConfig() {
    let cfg;
    try { cfg = await api.get('/api/llm-config'); } catch { cfg = null; }
    if (!cfg || !cfg.providers) cfg = { activeProvider: 'deepseek', providers: {}, updatedAt: Date.now() };
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'api-config-page';
    const provider = cfg.activeProvider || 'deepseek';
    const pc = cfg.providers?.[provider] || {};
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="api-config-back">←</button>
        <div style="flex:1;font-weight:600">API 配置</div>
      </div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
        <label style="font-size:13px;color:var(--text-secondary)">供应商</label>
        <select id="api-provider" style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text)">
          ${LLM_PROVIDERS.map((p) => `<option value="${p}" ${p === provider ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <label style="font-size:13px;color:var(--text-secondary)">Base URL</label>
        <input id="api-baseurl" placeholder="https://api.xxx.com/v1" value="${escapeHtml(pc.baseUrl || '')}" style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text)">
        <label style="font-size:13px;color:var(--text-secondary)">API Key</label>
        <input id="api-key" type="password" placeholder="sk-..." value="${escapeHtml(pc.apiKey || '')}" style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text)">
        <label style="font-size:13px;color:var(--text-secondary)">模型</label>
        <input id="api-model" placeholder="模型名" value="${escapeHtml(pc.model || '')}" style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text)">
        <button id="api-save" style="padding:12px;border:none;border-radius:10px;background:var(--accent);color:var(--bg);font-weight:700">保存配置</button>
      </div>`;
    document.body.appendChild(page);
    $('#api-config-back').addEventListener('click', () => page.remove());
    const provSel = $('#api-provider');
    provSel.addEventListener('change', () => {
      const p = provSel.value;
      const d = LLM_DEFAULTS[p];
      if (d) { $('#api-baseurl').value = d.baseUrl; $('#api-model').value = d.model; }
      if (p === '自定义') { $('#api-baseurl').value = ''; $('#api-model').value = ''; $('#api-key').value = ''; }
    });
    $('#api-save').addEventListener('click', async () => {
      const p = provSel.value === '自定义' ? 'custom' : provSel.value;
      const next = (cfg && cfg.providers) ? cfg : { activeProvider: cfg.activeProvider, providers: {}, updatedAt: Date.now() };
      next.activeProvider = p;
      next.providers[p] = Object.assign({}, (next.providers[p] || {}), {
        enabled: true, apiKey: $('#api-key').value.trim(), baseUrl: $('#api-baseurl').value.trim(),
        model: $('#api-model').value.trim(), temperature: 0.7, maxTokens: 4096, requiresApiKey: true,
      });
      try {
        await api.post('/api/llm-config', next);
        alert('已保存 LLM 配置');
        page.remove();
      } catch (e) { alert('保存失败: ' + (e.message || e)); }
    });
  }

  // === 创建新会话 / 添加 P2P 好友 ===
  function showSheet(id) { const s = $(id); if (s) s.hidden = false; }
  function hideSheet(id) { const s = $(id); if (s) s.hidden = true; }

  // 创建智能体: 无输入框, 底部滑入加载 sheet, 完成后滑出
  async function createSession() {
    showSheet('#create-sheet');
    try {
      await api.post('/api/channels/create', {});
      await new Promise((r) => setTimeout(r, 700));
      switchTab('main');
      loadAgentCovers();
    } catch (e) {
      alert('创建失败: ' + (e.message || e));
    } finally {
      hideSheet('#create-sheet');
    }
  }

  // 添加好友: 弹出选择 sheet (扫码 / 手动)
  function addFriend() { showSheet('#addfriend-sheet'); }
  async function addFriendManual() {
    hideSheet('#addfriend-sheet');
    const addr = prompt('输入好友地址 (multiaddr, 如 /ip4/10.0.2.2/tcp/54188/ws)', '');
    if (!addr) return;
    try {
      const r = await api.post('/api/peers/add', { addr });
      alert(r && r.ok ? (r.connected ? '已连接好友' : '已记录好友地址, 连接中...') : ((r && r.error) || '添加失败'));
      if (currentTab === 'network') loadContacts();
    } catch (e) {
      alert('添加失败: ' + (e.message || e));
    }
  }
  function addFriendScan() {
    hideSheet('#addfriend-sheet');
    alert('扫码添加 (真机可用相机扫码)');
  }

  // === 菜单 ===
  function bindMenu() {
    $('#item-settings').addEventListener('click', openSettings);
    $('#item-wallet').addEventListener('click', () => { alert('钱包管理'); });
    $('#item-judgments').addEventListener('click', () => { alert('判断力 API'); });
    $('#item-did').addEventListener('click', () => { api.get('/api/auth/status').then((s) => alert('DID: ' + (s.did || '未生成'))); });
    $('#item-login').addEventListener('click', async () => {
      try {
        const s = await api.get('/api/auth/status');
        const did = (s && (s.did || s.didShort)) || '未生成';
        alert('本机 DID: ' + did + '\n\nOrbitDB 身份同步（待接入）：手机生成 DID 后经 P2P 推给桌面 publish。');
      } catch (e) { alert('DID: 获取失败'); }
    });
    $('#item-logout').addEventListener('click', () => { api.post('/api/auth/logout', {}).then(() => loadMe()); });
    $('#btn-add').addEventListener('click', addFriend);
    const cs = $('#btn-create-session'); if (cs) cs.addEventListener('click', createSession);
    const csScan = $('#choice-scan'); if (csScan) csScan.addEventListener('click', addFriendScan);
    const csMan = $('#choice-manual'); if (csMan) csMan.addEventListener('click', addFriendManual);
    const csCan = $('#choice-cancel'); if (csCan) csCan.addEventListener('click', () => hideSheet('#addfriend-sheet'));
    $('#item-p2p').addEventListener('click', () => { switchTab('network'); });
    $('#item-p2p-id').addEventListener('click', () => { api.get('/api/auth/status').then((s) => alert('P2P ID: ' + (s.did || '未生成'))); });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.__mobileTouch = (type, data) => {};

  function setupUiControl() {
    if (!core?.events?.subscribe) return;
    core.events.subscribe((msg) => {
      if (!msg || msg.type !== 'ui' || !msg.action) return;
      const d = msg.data || {};
      switch (msg.action) {
        case 'switchTab': if (d.tab && ['main', 'network', 'me'].includes(d.tab)) switchTab(d.tab); break;
        case 'openSettings': openSettings(); break;
        case 'showToast': alert(d.message || ''); break;
        case 'goBack': closeCardDetail(); closeChat(); break;
        default: break;
      }
    });
  }

  function init() {
    bindMenu();
    applyTheme(resolveTheme(), false);
    switchTab('main');
    setupUiControl();
    loadAgentCovers();
    loadMe();
    if (core?.network?.start) core.network.start().catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
