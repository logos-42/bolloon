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
    const avatarEl = $('#me-avatar');
    const av = localStorage.getItem('bolloon_avatar');
    if (avatarEl) {
      if (av) { avatarEl.style.backgroundImage = 'url(' + av + ')'; avatarEl.style.backgroundSize = 'cover'; avatarEl.style.backgroundPosition = 'center'; avatarEl.textContent = ''; }
      else { avatarEl.style.backgroundImage = 'none'; }
    }
    try {
      const s = await api.get('/api/auth/status');
      $('#me-name').textContent = s.name || '未登录';
      $('#me-did').textContent = s.did ? ('DID: ' + (s.didShort || s.did)) : '';
      if (avatarEl && !av) avatarEl.textContent = (s.name || 'U').charAt(0);
      const hasAccount = (s.accounts && s.accounts.length > 0);
      $('#login-label').textContent = hasAccount ? '已登录账号' : '登录';
    } catch (e) { /* 默认 */ }
    // P2P ID = 通信ID, 与 DID 不同 (libp2p nodeId)
    try {
      const net = await api.get('/api/network/status');
      const p2p = net && net.nodeId;
      $('#me-p2p').textContent = p2p ? ('P2P: ' + p2p.slice(0, 14) + '…') : '';
    } catch (e) { /* 未连接 */ }
  }

  // === 身份介绍页 ===
  function openIdentityPage() {
    const page = document.createElement('div');
    page.className = 'identity-page';
    page.id = 'identity-page';
    page.innerHTML = `
      <div class="identity-header">
        <button class="icon-btn" id="identity-back">←</button>
        <div style="flex:1;font-weight:600">身份介绍</div>
      </div>
      <div class="identity-body" id="identity-body">加载中...</div>`;
    document.body.appendChild(page);
    $('#identity-back').addEventListener('click', () => page.remove());
    (async () => {
      const body = page.querySelector('#identity-body');
      let name = '未登录', did = '', p2p = '', created = '';
      try { const s = await api.get('/api/auth/status'); name = s.name || '未登录'; did = s.did || ''; created = (s.createdAt ? new Date(s.createdAt).toLocaleString() : ''); } catch {}
      try { const net = await api.get('/api/network/status'); p2p = (net && net.nodeId) || ''; } catch {}
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px">
          <div class="avatar" id="identity-avatar" style="width:72px;height:72px"></div>
          <div><div class="profile-name">${escapeHtml(name)}</div><div style="font-size:12px;color:var(--text-muted)">人类认证身份</div></div>
        </div>
        <div class="identity-row"><div class="k">DID 身份 (全局唯一)</div><div class="v">${escapeHtml(did || '未生成')}</div></div>
        <div class="identity-row"><div class="k">P2P ID (通信 ID)</div><div class="v">${escapeHtml(p2p || '未连接')}</div></div>
        <div class="identity-row"><div class="k">创建时间</div><div class="v">${escapeHtml(created || '未知')}</div></div>
        <div class="identity-row"><div class="k">说明</div><div class="v">DID 是全局唯一的人类认证身份; P2P ID 只是本机 libp2p 通信节点号, 两者不同。</div></div>`;
      const av = localStorage.getItem('bolloon_avatar');
      const ia = body.querySelector('#identity-avatar');
      if (ia) { if (av) { ia.style.backgroundImage = 'url(' + av + ')'; ia.style.backgroundSize = 'cover'; ia.textContent = ''; } else ia.textContent = (name || 'U').charAt(0); }
    })();
  }

  // === 头像: 相册选图 + 裁剪 ===
  function pickAvatar() { const input = $('#avatar-input'); if (input) input.click(); }
  function bindAvatarInput() {
    const input = $('#avatar-input');
    if (!input) return;
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => openCropModal(String(reader.result));
      reader.readAsDataURL(f);
      input.value = '';
    });
  }
  function openCropModal(dataUrl) {
    const modal = document.createElement('div');
    modal.className = 'crop-modal';
    modal.id = 'crop-modal';
    modal.innerHTML = `
      <div class="crop-stage" id="crop-stage">
        <img class="crop-img" id="crop-img" src="${dataUrl}" alt="">
        <div class="crop-box" id="crop-box"></div>
      </div>
      <div class="crop-zoom-row">
        <span style="color:#fff;font-size:13px">缩放</span>
        <input type="range" id="crop-zoom" min="1" max="3" step="0.01" value="1">
      </div>
      <div class="crop-actions">
        <button class="crop-cancel" id="crop-cancel">取消</button>
        <button class="crop-confirm" id="crop-confirm">完成</button>
      </div>`;
    document.body.appendChild(modal);
    const stage = modal.querySelector('#crop-stage');
    const img = modal.querySelector('#crop-img');
    const box = modal.querySelector('#crop-box');
    let zoom = 1, dx = 0, dy = 0, startX = 0, startY = 0;
    const stageRect = () => stage.getBoundingClientRect();
    const boxSize = () => Math.min(box.getBoundingClientRect().width, box.getBoundingClientRect().height);
    function layout() {
      const sr = stageRect(); const bs = boxSize();
      const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
      const base = Math.max(bs / nw, bs / nh);
      const w = nw * base * zoom, h = nh * base * zoom;
      img.style.width = w + 'px'; img.style.height = h + 'px';
      img.style.transform = `translate(${-w / 2 + dx}px, ${-h / 2 + dy}px)`;
    }
    img.onload = layout; layout();
    let dragging = false;
    stage.addEventListener('touchstart', (e) => { dragging = true; startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener('touchmove', (e) => { if (!dragging) return; dx += e.touches[0].clientX - startX; dy += e.touches[0].clientY - startY; startX = e.touches[0].clientX; startY = e.touches[0].clientY; layout(); }, { passive: true });
    stage.addEventListener('touchend', () => { dragging = false; }, { passive: true });
    stage.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startY = e.clientY;
      const mv = (ev) => { dx += ev.clientX - startX; dy += ev.clientY - startY; startX = ev.clientX; startY = ev.clientY; layout(); };
      const up = () => { dragging = false; stage.removeEventListener('mousemove', mv); stage.removeEventListener('mouseup', up); };
      stage.addEventListener('mousemove', mv); stage.addEventListener('mouseup', up);
    });
    $('#crop-zoom').addEventListener('input', (e) => { zoom = parseFloat(e.target.value); layout(); });
    $('#crop-cancel').addEventListener('click', () => modal.remove());
    $('#crop-confirm').addEventListener('click', () => {
      const sr = stageRect(); const bs = boxSize();
      const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
      const base = Math.max(bs / nw, bs / nh);
      const w = nw * base * zoom, h = nh * base * zoom;
      const imgLeft = sr.left + sr.width / 2 - w / 2 + dx;
      const imgTop = sr.top + sr.height / 2 - h / 2 + dy;
      const boxLeft = sr.left + sr.width / 2 - bs / 2;
      const boxTop = sr.top + sr.height / 2 - bs / 2;
      const scaleX = w / nw, scaleY = h / nh;
      const srcX = (boxLeft - imgLeft) / scaleX;
      const srcY = (boxTop - imgTop) / scaleY;
      const srcW = bs / scaleX, srcH = bs / scaleY;
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      canvas.getContext('2d').drawImage(img, Math.max(0, srcX), Math.max(0, srcY), Math.max(0, Math.min(srcW, nw - srcX)), Math.max(0, Math.min(srcH, nh - srcY)), 0, 0, 256, 256);
      localStorage.setItem('bolloon_avatar', canvas.toDataURL('image/jpeg', 0.85));
      modal.remove();
      loadMe();
    });
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
        // 点击卡片 → 直接进入对话 (卡片介绍页是遗留 bug, 不再导航)
        if (!isNaN(idx) && allAgentCards[idx]) openChat(allAgentCards[idx]);
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
    $$('.card-wrap.reveal-delete').forEach((w) => w.classList.remove('reveal-delete'));
  }

  function setupCardSwipe() {
    const track = $('#card-track');
    if (!track) return;

    let startX = 0, startY = 0, isDragging = false, startWrap = null;

    function revealWrap(wrap, reveal) {
      if (!wrap) return;
      const idx = parseInt(wrap.dataset.index);
      const c = allAgentCards[idx];
      if (reveal && c && c.deletable === false) { closeCardReveals(); return; }
      if (reveal) closeCardReveals();
      wrap.classList.toggle('reveal-delete', !!reveal);
    }

    track.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isDragging = false;
      const t = e.target;
      startWrap = (t && t.closest) ? t.closest('.card-wrap') : null;
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (Math.max(dx, dy) > 10) isDragging = true;
    }, { passive: true });

    // 垂直翻卡走原生 scroll-snap; 这里只处理水平滑动 → 删除 reveal
    track.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx < -30) revealWrap(startWrap, true);     // 左滑 → 显示删除
        else if (dx > 30) revealWrap(startWrap, false); // 右滑 → 收起删除
      }
      startWrap = null;
    });

    let mouseStartX = 0, mouseStartY = 0;
    track.addEventListener('mousedown', (e) => {
      mouseStartX = e.clientX; mouseStartY = e.clientY;
      isDragging = false;
      const t = e.target;
      startWrap = (t && t.closest) ? t.closest('.card-wrap') : null;
      const onMove = (ev) => {
        if (Math.max(Math.abs(ev.clientX - mouseStartX), Math.abs(ev.clientY - mouseStartY)) > 10) isDragging = true;
      };
      const onUp = (ev) => {
        if (isDragging) {
          const dx = ev.clientX - mouseStartX;
          if (Math.abs(dx) > 30) {
            if (dx < 0) revealWrap(startWrap, true);
            else revealWrap(startWrap, false);
          }
        }
        startWrap = null;
        track.removeEventListener('mousemove', onMove);
        track.removeEventListener('mouseup', onUp);
      };
      track.addEventListener('mousemove', onMove);
      track.addEventListener('mouseup', onUp);
    });

    track.addEventListener('scroll', () => {
      const cards = track.querySelectorAll('.card-wrap');
      const trackRect = track.getBoundingClientRect();
      let best = -1, bestDist = Infinity;
      cards.forEach((card, i) => {
        const r = card.getBoundingClientRect();
        const center = r.top + r.height / 2;
        const trackCenter = trackRect.top + trackRect.height / 2;
        const dist = Math.abs(center - trackCenter);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      if (best >= 0) { currentCardIndex = best; updateCardIndicator(); }
    });
  }

  function scrollToCard(index) {
    const track = $('#card-track');
    if (!track) return;
    const cards = track.querySelectorAll('.card-wrap');
    if (cards[index]) {
      cards[index].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      currentCardIndex = index;
      track.querySelectorAll('.agent-card').forEach((c, i) => c.classList.toggle('active-card', i === index));
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
         <button class="icon-btn" id="chat-manage" title="管理会话">⋮</button>
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
     $('#chat-manage').addEventListener('click', openChatManage);
     $('#chat-send').addEventListener('click', sendChat);
     $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
     loadMessages();
     openChatSse();
     window.__mobileTouch?.('chat', ch.id);
   }

  function closeChat() {
    if (chatEventSource) { chatEventSource.close(); chatEventSource = null; }
    ['#chat-page', '#chat-manage-sheet', '#session-history', '#agent-cover'].forEach((sel) => {
      const el = $(sel); if (el) el.remove();
    });
    activeChannel = null;
  }

  // === 聊天页右上角管理: 会话历史 / 智能体封面 / 删除 ===
  function openChatManage() {
    if (!activeChannel) return;
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'chat-manage-sheet';
    sheet.innerHTML = `
      <div class="sheet-inner sheet-inner-choices">
        <div class="sheet-title">智能体设置 · ${escapeHtml(activeChannel.name || '')}</div>
        <button class="sheet-choice" id="cm-history">📜 会话历史</button>
        <button class="sheet-choice" id="cm-cover">🖼 智能体封面</button>
        <button class="sheet-choice sheet-cancel" id="cm-delete" style="color:#e5484d">🗑 删除智能体</button>
        <button class="sheet-choice sheet-cancel" id="cm-close">取消</button>
      </div>`;
    document.body.appendChild(sheet);
    // 点遮罩任意空白处关闭
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    $('#cm-close').addEventListener('click', (e) => { e.stopPropagation(); sheet.remove(); });
    $('#cm-history').addEventListener('click', (e) => { e.stopPropagation(); sheet.remove(); openSessionHistory(); });
    $('#cm-cover').addEventListener('click', (e) => { e.stopPropagation(); sheet.remove(); openAgentCover(); });
    $('#cm-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      sheet.remove();
      if (!activeChannel) return;
      if (!confirm('删除该智能体?')) return;
      try {
        await api.post('/api/channels/delete', { id: activeChannel.id });   // 删除 agent = 删除 channel
        closeChat();
        loadAgentCovers();
      } catch (err) { alert('删除失败: ' + (err.message || err)); }
    });
  }

  async function openSessionHistory() {
    if (!activeChannel) return;
    const page = document.createElement('div');
    page.className = 'identity-page';
    page.id = 'session-history';
    page.innerHTML = `<div class="identity-header"><button class="icon-btn" id="sh-back">←</button><div style="flex:1;font-weight:600">会话历史</div></div><div class="identity-body" id="sh-body">加载中...</div>`;
    document.body.appendChild(page);
    $('#sh-back').addEventListener('click', () => page.remove());
    try {
      const s = await api.get('/sessions/' + encodeURIComponent(activeChannel.id));
      const msgs = (s && s.messages) || [];
      page.querySelector('#sh-body').innerHTML = msgs.length === 0
        ? '<div style="color:var(--text-secondary)">暂无消息</div>'
        : msgs.map((m) => `<div style="margin-bottom:8px;padding:8px 10px;border-radius:10px;background:var(--bg-card);border:1px solid var(--border)"><div style="font-size:11px;color:var(--text-muted)">${m.role === 'user' ? '你' : '智能体'} · ${new Date(m.ts).toLocaleTimeString()}</div><div style="font-size:14px;color:var(--text);white-space:pre-wrap">${escapeHtml(m.content)}</div></div>`).join('');
    } catch (e) { page.querySelector('#sh-body').innerHTML = '加载失败'; }
  }

  function openAgentCover() {
    if (!activeChannel) return;
    const card = allAgentCards.find((c) => c.id === activeChannel.id) || activeChannel;
    const page = document.createElement('div');
    page.className = 'identity-page';
    page.id = 'agent-cover';
    page.innerHTML = `<div class="identity-header"><button class="icon-btn" id="ac-back">←</button><div style="flex:1;font-weight:600">智能体封面</div></div><div class="identity-body" id="ac-body"></div>`;
    document.body.appendChild(page);
    $('#ac-back').addEventListener('click', () => page.remove());
    page.querySelector('#ac-body').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:center;gap:14px">
          <div class="avatar" style="width:72px;height:72px">${escapeHtml((card.name || 'A').charAt(0))}</div>
          <div><div class="profile-name">${escapeHtml(card.name || '')}</div><div style="font-size:12px;color:var(--text-muted)">${escapeHtml(card.desc || '')}</div></div>
        </div>
        <div class="identity-row"><div class="k">智能体ID</div><div class="v">${escapeHtml(card.agentId || '')}</div></div>
        <div class="identity-row"><div class="k">状态</div><div class="v">${card.status === 'online' ? '在线' : '离线'}</div></div>
      </div>`;
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

  // === 加密钱包 (只读 MVP) ===
  async function openWallet() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'wallet-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="wallet-back">←</button>
        <div style="flex:1;font-weight:600">加密钱包</div>
        <button class="icon-btn" id="wallet-new" title="新建钱包">＋</button>
      </div>
      <div id="wallet-body" style="padding:12px;display:flex;flex-direction:column;gap:12px">加载中...</div>`;
    document.body.appendChild(page);
    $('#wallet-back').addEventListener('click', () => page.remove());
    $('#wallet-new').addEventListener('click', () => openWalletForm(page, 'create'));
    await renderWalletList(page);
  }

  const _walletInput = 'padding:11px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text)';
  const _walletBtn = 'padding:13px;border:none;border-radius:10px;background:var(--accent);color:var(--bg);font-weight:700';

  async function renderWalletList(page) {
    const body = page.querySelector('#wallet-body');
    if (!body) return;
    let st;
    try { st = await api.get('/api/wallet/status'); }
    catch (e) { body.innerHTML = '<div>读取失败: ' + (e.message || e) + '</div>'; return; }
    const wallets = (st && st.wallets) || [];
    if (wallets.length === 0) {
      body.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:24px 0">还没有加密钱包</div>' +
        '<button id="wallet-first" style="' + _walletBtn + '">＋ 新建钱包</button>' +
        '<button id="wallet-import-first" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text-secondary);border-radius:10px">导入钱包</button>';
      $('#wallet-first').addEventListener('click', () => openWalletForm(page, 'create'));
      $('#wallet-import-first').addEventListener('click', () => openWalletForm(page, 'import'));
      return;
    }
    body.innerHTML = wallets.map((w) => `
      <div class="wallet-card" style="padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:700">${escapeHtml(w.name)} <span style="font-size:11px;color:var(--text-muted)">${w.mode === 'auto' ? '🔓自动加载' : (w.mode === 'passphrase' ? '🔐口令' : '')}</span></span>
          <span style="font-size:12px;color:${w.unlocked ? 'var(--accent)' : 'var(--text-muted)'}">${w.unlocked ? '已解锁' : '已锁定'}</span>
        </div>
        <div class="wallet-addr">${escapeHtml(w.address)}</div>
        <div style="font-size:12px;color:var(--text-secondary)">授权智能体: ${(w.allowedAgents || []).length} 个</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${w.unlocked ? `<button data-wl="lock" data-id="${w.id}" style="flex:1;${_walletBtn}">锁定</button>` : (w.mode === 'passphrase' ? `<button data-wl="unlock" data-id="${w.id}" style="flex:1;${_walletBtn}">解锁</button>` : '')}
          ${w.unlocked ? `<button data-wl="bal" data-id="${w.id}" style="flex:1;${_walletBtn}">余额</button>` : ''}
          <button data-wl="grant" data-id="${w.id}" style="flex:1;${_walletBtn}">授权</button>
        </div>
        <div data-bal="${w.id}" style="font-size:13px;color:var(--accent)"></div>
      </div>`).join('');
    body.querySelectorAll('[data-wl]').forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.dataset.wl, id = btn.dataset.id;
      if (act === 'lock') { await api.post('/api/wallet/lock', { id }); renderWalletList(page); }
      else if (act === 'unlock') { promptWalletPass(page, id); }
      else if (act === 'bal') {
        try { const b = await api.post('/api/wallet/balance', { id }); const el = body.querySelector('[data-bal="' + id + '"]'); if (el) el.textContent = b; }
        catch (e) { alert(e.message || '余额查询失败'); }
      }
      else if (act === 'grant') { grantWalletUI(page, id); }
    }));
  }

  function openWalletForm(page, which) {
    const body = page.querySelector('#wallet-body');
    const isCreate = which === 'create';
    body.innerHTML = `
      <div style="font-weight:700">${isCreate ? '新建钱包' : '导入钱包'}</div>
      <input id="wlf-name" placeholder="钱包名称 (留空默认)" style="${_walletInput}">
      <label style="font-size:12px;color:var(--text-secondary)">解锁方式</label>
      <div style="display:flex;gap:10px">
        <label style="display:flex;align-items:center;gap:6px;flex:1"><input type="radio" name="wlf-mode" value="auto" checked> 自动加载(无口令)</label>
        <label style="display:flex;align-items:center;gap:6px;flex:1"><input type="radio" name="wlf-mode" value="passphrase"> 口令解锁</label>
      </div>
      <input id="wlf-pass" type="password" placeholder="口令 (口令模式必填)" style="${_walletInput}">
      ${isCreate ? '' : '<textarea id="wlf-input" placeholder="12 词助记词 或 64 位 hex 私钥" style="' + _walletInput + ';min-height:70px"></textarea>'}
      <button id="wlf-submit" style="${_walletBtn}">${isCreate ? '创建' : '导入'}</button>
      <button id="wlf-cancel" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text-secondary);border-radius:10px">返回</button>`;
    $('#wlf-cancel').addEventListener('click', () => renderWalletList(page));
    $('#wlf-submit').addEventListener('click', async () => {
      const name = $('#wlf-name').value.trim();
      const mode = document.querySelector('input[name="wlf-mode"]:checked')?.value || 'auto';
      const pass = $('#wlf-pass').value || '';
      if (mode === 'passphrase' && !pass) { alert('口令模式需要口令'); return; }
      try {
        const r = isCreate
          ? await api.post('/api/wallet/create', { name, mode, pass })
          : await api.post('/api/wallet/import', { name, mode, pass, input: $('#wlf-input').value });
        if (r && r.mnemonic) {
          body.innerHTML = `<div style="background:#3a2a1a;border:1px solid var(--accent);border-radius:10px;padding:14px;font-size:13px"><div style="font-weight:700;color:var(--accent);margin-bottom:6px">⚠ 抄写并离线保存助记词</div><div style="word-break:break-all">${escapeHtml(r.mnemonic)}</div></div><div class="wallet-addr">${escapeHtml(r.address)}</div><button id="wlf-ok" style="${_walletBtn}">我已保存</button>`;
          $('#wlf-ok').addEventListener('click', () => renderWalletList(page));
        } else renderWalletList(page);
      } catch (e) { alert((isCreate ? '创建' : '导入') + '失败: ' + (e.message || e)); }
    });
  }

  function promptWalletPass(page, id) {
    const body = page.querySelector('#wallet-body');
    body.innerHTML = '<div style="font-weight:700">输入口令解锁</div><input id="wlf-pass" type="password" placeholder="口令" style="' + _walletInput + '">' +
      '<button id="wlf-submit2" style="' + _walletBtn + '">解锁</button><button id="wlf-cancel2" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text-secondary);border-radius:10px">返回</button>';
    $('#wlf-cancel2').addEventListener('click', () => renderWalletList(page));
    $('#wlf-submit2').addEventListener('click', async () => {
      try { await api.post('/api/wallet/unlock', { id, pass: $('#wlf-pass').value }); renderWalletList(page); }
      catch (e) { alert('解锁失败: ' + (e.message || e)); }
    });
  }

  async function grantWalletUI(page, walletId) {
    const body = page.querySelector('#wallet-body');
    let channels = [];
    try { const chs = await api.get('/channels'); channels = Array.isArray(chs) ? chs : []; } catch {}
    const agents = channels.map((c) => ({ agentId: c.agentId || c.id, name: c.persona?.name || c.name || c.agentId || '智能体' }));
    let st; try { st = await api.get('/api/wallet/status'); } catch {}
    const wallet = (st && st.wallets || []).find((w) => w.id === walletId);
    const allowed = new Set((wallet && wallet.allowedAgents) || []);
    body.innerHTML = '<div style="font-weight:700">授权钱包给智能体</div>' +
      (agents.length === 0
        ? '<div style="color:var(--text-secondary);font-size:13px">没有本地智能体 (先创建新会话)</div>'
        : agents.map((a) => `
            <label style="display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card)">
              <input type="checkbox" data-aid="${escapeHtml(a.agentId)}" ${allowed.has(a.agentId) ? 'checked' : ''}> <span style="flex:1">${escapeHtml(a.name)}</span>
            </label>`).join('')) +
      '<button id="wl-grant-save" style="' + _walletBtn + '">保存授权</button><button id="wl-grant-back" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text-secondary);border-radius:10px">返回</button>';
    $('#wl-grant-back').addEventListener('click', () => renderWalletList(page));
    $('#wl-grant-save').addEventListener('click', async () => {
      const list = Array.from(body.querySelectorAll('input[data-aid]'));
      for (const cb of list) { await api.post('/api/wallet/grant', { id: walletId, agentId: cb.dataset.aid, allow: cb.checked }); }
      renderWalletList(page);
    });
  }

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
    $('#item-wallet').addEventListener('click', () => { openWallet(); });
    $('#item-judgments').addEventListener('click', () => { alert('判断力 API'); });
    // 头顶身份栏: 头像可改, 右侧卡片开身份介绍页; DID 不再作为标签按钮
    $('#me-avatar').addEventListener('click', pickAvatar);
    $('#profile-info').addEventListener('click', openIdentityPage);
    bindAvatarInput();
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
    $('#item-p2p-id').addEventListener('click', async () => {
      try { const net = await api.get('/api/network/status'); const p2p = net && net.nodeId; alert('P2P ID (通信ID, ≠ DID):\n' + (p2p || '未连接')); }
      catch (e) { alert('P2P ID: 获取失败'); }
    });
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
