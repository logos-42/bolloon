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
  // 统一线性图标 (与底部 tab 同风格; currentColor 描边)
  const ICONS = {
    themeAuto: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"/></svg>',
    sun: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>',
    moon: '<svg class="ico" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
    chip: '<svg class="ico" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"/></svg>',
    globe: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.3 3.5 5.3 3.5 8.5s-1.2 6.2-3.5 8.5c-2.3-2.3-3.5-5.3-3.5-8.5S9.7 5.8 12 3.5z"/></svg>',
    idcard: '<svg class="ico" viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><circle cx="8.5" cy="11" r="2"/><path d="M5.6 15.8a3.2 3.2 0 0 1 5.8 0M13.5 10h5M13.5 13.5h5"/></svg>',
    clock: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    image: '<svg class="ico" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.8"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3L20 16"/></svg>',
    trash: '<svg class="ico" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l1 12.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5L17.5 7"/></svg>',
  };
  // 主题三档: auto(跟随系统) / light / dark. 存的是"偏好", 不是最终色.
  const THEME_MODES = ['auto', 'light', 'dark'];
  function resolveThemePref() {
    try { const v = localStorage.getItem('bolloon_theme'); return THEME_MODES.includes(v) ? v : 'auto'; }
    catch { return 'auto'; }
  }
  function effectiveTheme(pref) { return pref === 'light' || pref === 'dark' ? pref : systemTheme(); }
  let currentTheme = 'auto';        // 偏好
  function applyTheme(name, persist = true) {
    const pref = THEME_MODES.includes(name) ? name : 'auto';
    currentTheme = pref;
    const eff = effectiveTheme(pref);
    const t = THEMES[eff];
    const root = document.documentElement;
    Object.entries(t).forEach(([k, v]) => root.style.setProperty(k, v));
    root.setAttribute('data-theme', eff);
    root.style.colorScheme = eff;          // 系统控件/滚动条/状态栏跟随
    if (persist) { try { localStorage.setItem('bolloon_theme', pref); } catch (e) {} }
    const txt = document.getElementById('theme-text');
    if (txt) txt.textContent = pref === 'auto' ? '跟随系统' : (pref === 'light' ? '浅色' : '深色');
    const ico = document.getElementById('theme-icon');
    if (ico) ico.innerHTML = pref === 'auto' ? ICONS.themeAuto : (pref === 'light' ? ICONS.sun : ICONS.moon);
  }
  // 系统外观变化 → 处于 auto 时立即跟随
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentTheme === 'auto') applyTheme('auto', false);
    });
  } catch (e) {}

  const TITLES = { main: '首页', network: '网络', me: '我' };
  let currentTab = 'main';
  function switchTab(tab) {
    currentTab = tab;
    $$('.page, .page-container').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#topbar-title').textContent = TITLES[tab] || '会话';
    const cs = $('#btn-create-session'); if (cs) cs.hidden = tab !== 'main';
    const ta = $('#topbar-actions'); if (ta) ta.hidden = tab === 'me';   // 我 页不显示 加号/刷新
    if (tab === 'network') { loadContacts(); loadMcpTools(); loadApprovals(); loadNetMembers(); loadP2PStatus(); loadAgentServices(); }
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
        el.innerHTML = `<div class="conv-avatar"><svg class="ico" viewBox="0 0 24 24"><path d="M9 3.5v4.5M15 3.5v4.5"/><path d="M6.5 8h11v3.2a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.7V20.5"/></svg></div>
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
      $('#me-name').textContent = s.loggedIn ? (s.name || '未登录') : '未登录';
      $('#me-did').textContent = s.did ? ('DID: ' + (s.didShort || s.did)) : '';
      if (avatarEl && !av) avatarEl.textContent = (s.loggedIn && s.name ? s.name : 'U').charAt(0);
      $('#login-label').textContent = s.loggedIn ? '已登录' : '登录';
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

  // === 卡片封面 (docs/fig 导出 → src/web/covers, 每个 agent 唯一不重复) ===
  let _coverList = null;
  async function loadCovers() {
    if (_coverList) return _coverList;
    try { const r = await fetch('./covers/index.json'); _coverList = await r.json(); }
    catch (e) { _coverList = []; }
    return _coverList;
  }
  const COVER_MAP_KEY = 'bolloon_cover_map';
  const SELF_CARD_HIDDEN_KEY = 'bolloon_hide_self_card';   // 首页本机卡片是否已移除
  function coverFor(key, idx) {
    const list = _coverList || [];
    if (!list.length) return '';
    let map = {};
    try { map = JSON.parse(localStorage.getItem(COVER_MAP_KEY) || '{}') || {}; } catch (e) { map = {}; }
    if (map[key] && list.indexOf(map[key]) >= 0) return './covers/' + map[key];
    const used = {}; Object.keys(map).forEach((k) => { used[map[k]] = 1; });
    let pick = list.filter((c) => !used[c])[0];
    if (!pick) pick = list[idx % list.length];     // 图用完才回绕
    map[key] = pick;
    try { localStorage.setItem(COVER_MAP_KEY, JSON.stringify(map)); } catch (e) {}
    return './covers/' + pick;
  }

  async function loadAgentCovers() {
    const track = $('#card-track');
    if (!track) return;
    await loadCovers();
    track.innerHTML = '<div class="card-loading">加载智能体卡片...</div>';
    try {
      const [channels, peers] = await Promise.all([
        api.get('/channels').catch(() => []),
        api.get('/api/peers').catch(() => []),
      ]);
      const channelList = Array.isArray(channels) ? channels : [];
      const peerList = Array.isArray(peers) ? peers : [];

      // 本机智能体卡片: 任何情况下都先显示自己, 保证首页不空 (无同步/无好友也可见)
      //   2026-09-08: 本机卡片也可移除 (原硬编码 deletable:false → 首页第一张卡删不掉); 移除后记 localStorage, 设置里可恢复
      allAgentCards = [];
      const selfHidden = (() => { try { return localStorage.getItem(SELF_CARD_HIDDEN_KEY) === '1'; } catch { return false; } })();
      try {
        const self = await core.identity?.status?.();
        if (self && self.did && !selfHidden) {
          allAgentCards.push({
            id: self.did, agentId: self.did,
            name: self.name || '本机智能体',
            desc: '本机 Agent (手机端自治执行)',
            avatar: null, peer: null,
            status: 'online', lastActive: '刚刚',
            capabilities: ['chat', 'local-agent'],
            deletable: true, self: true,
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
    // 每个 agent 分配唯一封面 (持久化映射 → 不重复)
    const _seen = {};
    allAgentCards.forEach((c, i) => {
      let key = String(c.id || c.agentId || ('card' + i));   // c.id 每张唯一(self=did, 频道=ch.id)
      if (_seen[key]) key = key + '#' + i;                   // 兜底: 同键也不重复
      _seen[key] = 1;
      c.cover = coverFor(key, i);
    });

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
            ${card.cover ? `<img src="${escapeHtml(card.cover)}" alt="">` : `<div class="card-cover-placeholder">${escapeHtml(card.name.charAt(0))}</div>`}
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
        if (!card) return;
        // 本机卡片: 不是 channel → 记"已移除"标记并重绘 (设置里可恢复)
        if (card.self) {
          if (!confirm('从首页移除本机卡片? (设置里可恢复)')) return;
          try { localStorage.setItem(SELF_CARD_HIDDEN_KEY, '1'); } catch (e) {}
          showToast('已从首页移除本机卡片');
          loadAgentCovers();
          return;
        }
        if (card.deletable === false) return;
        if (!confirm('删除该智能体?')) return;
        try {
          await api.post('/api/channels/delete', { id: card.id });
          showToast('已删除智能体');
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
  let chatStepCancel = null;
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
       if (chatStepCancel) { chatStepCancel.cancel?.(); chatStepCancel = null; }
       $('#chat-back').addEventListener('click', closeChat);
       $('#chat-manage').addEventListener('click', openChatManage);
       $('#chat-send').addEventListener('click', sendChat);
       $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
       attachStepListener();
       loadMessages();
       openChatSse();
       window.__mobileTouch?.('chat', ch.id);
       }

       /** 监听 native AgentLoop 的 agent-step 事件 → 工作记录 */
       function attachStepListener() {
       const cap = window.Capacitor;
       const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
       if (!bridge || !bridge.addListener) return;
       try {
       chatStepCancel = bridge.addListener('agent-step', (ev) => {
         const txt = (ev && (ev.step || ev.message)) || '';
         if (!txt) return;
         appendWorkLog(txt);
         const st = $('#loop-status-text'); if (st) st.textContent = txt;
       });
       } catch (e) { /* 监听失败不阻塞 */ }
       }

       let traceBody = null;
       let lastUserPrompt = '';
       function appendWorkLog(txt) {
         const box = $('#chat-messages');
         if (!box) return;
         if (!traceBody || !traceBody.isConnected) {
           traceBody = document.createElement('div');
           traceBody.className = 'agent-trace';
           box.appendChild(traceBody);
         }
         const line = document.createElement('div');
         line.className = 'agent-trace-line';
         line.textContent = txt;
         traceBody.appendChild(line);
         box.scrollTop = box.scrollHeight;
       }

       // 回复气泡操作栏: 复制 / 点踩合一 / 分享 / 刷新重新来 / 分支fork
       function addReplyActions(container, text) {
         if (!container) return;
         const bar = document.createElement('div');
         bar.className = 'reply-actions';
         const t = text || '';

         // 复制
         const copyBtn = document.createElement('button'); copyBtn.className='ra-btn'; copyBtn.textContent='复制';
         copyBtn.addEventListener('click', async () => {
           try { await navigator.clipboard.writeText(t); copyBtn.textContent='✓已复制'; setTimeout(()=>copyBtn.textContent='复制',1500); }
           catch (e) { copyBtn.textContent='复制失败'; setTimeout(()=>copyBtn.textContent='复制',1500); }
         });
         bar.appendChild(copyBtn);

         // 点踩合一 (单个按钮循环: 中性 → 点赞 → 点踩)
         const voteBtn = document.createElement('button'); voteBtn.className='ra-btn ra-vote'; voteBtn.textContent='👍🏻';
         let voteState = 0;
         voteBtn.addEventListener('click', () => {
           voteState = (voteState + 1) % 3;
           voteBtn.textContent = voteState===0 ? '👍🏻' : (voteState===1 ? '👍' : '👎');
           voteBtn.classList.toggle('ra-vote-like', voteState===1);
           voteBtn.classList.toggle('ra-vote-dis', voteState===2);
         });
         bar.appendChild(voteBtn);

         // 分享 (Web Share 优先, 否则复制文本)
         const shareBtn = document.createElement('button'); shareBtn.className='ra-btn'; shareBtn.textContent='分享';
         shareBtn.addEventListener('click', async () => {
           if (navigator.share) { try { await navigator.share({ title: 'Bolloon 对话', text: t }); return; } catch (e) {} }
           try { await navigator.clipboard.writeText(t); shareBtn.textContent='✓已复制'; setTimeout(()=>shareBtn.textContent='分享',1500); } catch (e) {}
         });
         bar.appendChild(shareBtn);

         // 刷新重新来 (用同一 prompt 重新跑 Agent)
         const refreshBtn = document.createElement('button'); refreshBtn.className='ra-btn'; refreshBtn.textContent='刷新';
         refreshBtn.addEventListener('click', () => {
           const prompt = lastUserPrompt; if (!prompt) return;
           refreshBtn.textContent='重新生成…';
           const inp = $('#chat-input'); if (inp) inp.value = prompt;
           // 用直接触发 sendChat 的方式重新发起
           if (typeof sendChat === 'function') sendChat();
         });
         bar.appendChild(refreshBtn);

         // 分支 fork (新建本地智能体分支, 继承本回复上下文做起点)
         const forkBtn = document.createElement('button'); forkBtn.className='ra-btn'; forkBtn.textContent='分支';
         forkBtn.addEventListener('click', async () => {
           forkBtn.textContent='建立中…';
           try {
             const r = await api.post('/api/channels/create', { name: '分支' });
             const id = r && r.id;
             if (!id) { forkBtn.textContent='分支失败'; setTimeout(()=>forkBtn.textContent='分支',1500); return; }
             closeChat();
             loadAgentCovers();
             setTimeout(() => {
               const c = allAgentCards.find((x) => x.id === id);
               if (c) openChat(c);
             }, 600);
           } catch (e) { forkBtn.textContent='分支失败'; setTimeout(()=>forkBtn.textContent='分支',1500); }
         });
         bar.appendChild(forkBtn);

         container.appendChild(bar);
       }

  function closeChat() {
    if (chatEventSource) { chatEventSource.close(); chatEventSource = null; }
    if (chatStepCancel) { chatStepCancel.cancel?.(); chatStepCancel = null; }
    ['#chat-page', '#chat-manage-sheet', '#session-history', '#agent-cover'].forEach((sel) => {
      const el = $(sel); if (el) el.remove();
    });
    activeChannel = null;
  }

  /** 本机卡片判定 (blln-mobile): 不是会话 channel, 删除=移除卡片, 改名=改本机昵称 */
  async function isSelfAgent(ch) {
    if (!ch) return false;
    if (ch.self) return true;
    try { const s = await core.identity?.status?.(); return !!(s && s.did && String(ch.id) === String(s.did)); } catch { return false; }
  }

  /** 本机卡片: 从首页移除 (设置里可恢复) */
  function hideSelfCard() {
    try { localStorage.setItem(SELF_CARD_HIDDEN_KEY, '1'); } catch (e) {}
    showToast('已从首页移除本机卡片 (设置里可恢复)');
    loadAgentCovers();
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
        <button class="sheet-choice" id="cm-history">${ICONS.clock} 会话历史</button>
        <button class="sheet-choice" id="cm-cover">${ICONS.image} 智能体封面</button>
        <button class="sheet-choice sheet-cancel" id="cm-delete" style="color:#e5484d">${ICONS.trash} 删除智能体</button>
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
      // 本机卡片 (blln-mobile): 不是会话 → 移除卡片 (原实现拿 DID 去 /api/channels/delete, 静默失败)
      if (await isSelfAgent(activeChannel)) {
        if (!confirm('从首页移除本机卡片? (设置里可恢复)')) return;
        closeChat();
        hideSelfCard();
        return;
      }
      if (!confirm('删除该智能体?')) return;
      try {
        const r = await api.post('/api/channels/delete', { id: activeChannel.id });
        if (r && r.ok === false) { alert('删除失败: ' + (r.error || '未知错误')); return; }
        closeChat();
        showToast('已删除智能体');
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
    const isSelf = !!card.self;
    const desc = isSelf ? '本机 Agent (手机端自治执行)' : (card.desc || '');
    page.querySelector('#ac-body').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:center;gap:14px">
          <div class="avatar" style="width:72px;height:72px">${escapeHtml((card.name || 'A').charAt(0))}</div>
          <div><div class="profile-name" id="ac-cur">${escapeHtml(card.name || '')}</div><div style="font-size:12px;color:var(--text-muted)">${escapeHtml(desc)}</div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="font-size:13px;color:var(--text-secondary)">名称 (可手动输入修改)</div>
          <input id="ac-name" value="${escapeHtml(card.name || '')}" placeholder="输入名称" style="${_walletInput}">
          <button id="ac-save" style="${_walletBtn}">保存名称</button>
        </div>
        <div class="identity-row"><div class="k">智能体ID</div><div class="v">${escapeHtml(card.agentId || '')}</div></div>
        <div class="identity-row"><div class="k">状态</div><div class="v">${card.status === 'online' ? '在线' : '离线'}</div></div>
      </div>`;
    $('#ac-save').addEventListener('click', async () => {
      const name = (page.querySelector('#ac-name').value || '').trim();
      if (!name) { showToast('名称不能为空'); return; }
      try {
        if (isSelf) {
          await api.post('/api/auth/login', { name });          // 本机卡片: 改本机身份昵称
        } else {
          const r = await api.post('/api/channels/rename', { id: card.id, name });
          if (r && r.ok === false) { showToast('改名失败: ' + (r.error || '未知错误')); return; }
        }
        card.name = name;
        if (activeChannel) activeChannel.name = name;
        const cur = page.querySelector('#ac-cur'); if (cur) cur.textContent = name;
        const av = page.querySelector('.avatar'); if (av) av.textContent = name.charAt(0);
        showToast('名称已更新');
        loadAgentCovers();
      } catch (e) { showToast('改名失败: ' + (e.message || e)); }
    });
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

       // Agent 执行过程摘要 (每步 onStep) → 工作记录
       if (msg.type === 'agent-worklog' && Array.isArray(msg.lines)) {
         msg.lines.forEach((line) => appendWorkLog(String(line)));
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
    const traceHTML = (traceBody && traceBody.isConnected) ? traceBody.outerHTML : '';
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
        if (role === 'ai') addReplyActions(d, m.content || '');
      });
      if (traceHTML) { traceBody = document.createElement('div'); traceBody.innerHTML = traceHTML; traceBody = traceBody.firstChild; box.appendChild(traceBody); }
      box.scrollTop = box.scrollHeight;
    } catch (e) { box.innerHTML = '<div style="color:var(--text-muted)">暂无历史消息</div>'; }
  }

  async function sendChat() {
    const input = $('#chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !activeChannel) return;
    input.value = '';
    lastUserPrompt = text;
    const box = $('#chat-messages');
    if (!box) return;
    const userBubble = document.createElement('div');
    userBubble.className = 'bubble user';
    userBubble.textContent = text;
    box.appendChild(userBubble);
    box.scrollTop = box.scrollHeight;
    traceBody = null;   // 新消息 → 重置执行轨迹 (每条回复独立工作记录)
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
  // 轻提示 (1.6s 自动消失) — 授权/同步这类操作要有明确反馈
  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom));z-index:99999;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 16px;font-size:13px;max-width:86vw;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.35)';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }

  // === Agent 服务 (E1 自动发现) + 资源交易 (E2/E3/E4) ===
  let _svcCache = [];
  async function loadAgentServices() {
    const box = $('#agent-services');
    if (!box) return;
    box.innerHTML = '<div class="list-item"><span style="color:var(--text-secondary);font-size:13px">正在发现…</span></div>';
    let r = { services: [], error: '' };
    try { r = await api.get('/api/social/discover'); } catch (e) { r = { services: [], error: (e && e.message) || String(e) }; }
    const list = (r && r.services) || [];
    _svcCache = list;
    if (!list.length) {
      box.innerHTML = `<div class="list-item"><span style="font-size:12px;color:var(--text-secondary);line-height:1.6">暂未发现其他智能体${r && r.error ? '（' + escapeHtml(r.error) + '）' : ''}<br>连上电脑端或对端节点后会自动出现</span></div>`;
      return;
    }
    box.innerHTML = list.map((s, i) => {
      const pr = (s.service && s.service.price) || s.price || {};
      const amount = (pr && pr.amount) || (typeof pr === 'string' ? pr : '') || '';
      const cur = (pr && pr.currency) || '';
      const name = (s.service && s.service.name) || s.serviceName || s.name || s.agentId || 'agent';
      const desc = (s.service && s.service.description) || s.description || '';
      const score = (s.reputation && (s.reputation.score ?? s.reputation)) ?? '';
      return `<div class="list-item" data-i="${i}"><span style="flex:1;min-width:0"><div style="font-size:14px">${escapeHtml(String(name))}</div><div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(String(desc))}</div></span><span style="font-size:11px;color:var(--text-secondary);text-align:right">${escapeHtml(String(amount ? amount + ' ' + cur : '未定价'))}${score !== '' ? '<br>信誉 ' + escapeHtml(String(score)) : ''}</span></div>`;
    }).join('');
    box.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('click', () => openTradeCall(_svcCache[Number(el.dataset.i)])));
  }

  async function openTradeCall(entry) {
    const svc = {
      name: (entry.service && entry.service.name) || entry.serviceName || entry.name || 'service',
      agentId: entry.agent_id || entry.agentId,
      payTo: entry.wallet || (entry.service && entry.service.payTo),
      price: (entry.service && entry.service.price) || entry.price || { amount: '0', currency: 'USDC' },
      endpoint: (entry.service && entry.service.endpoint) || entry.endpoint,
      reputation: (entry.reputation && (entry.reputation.score ?? entry.reputation)) ?? entry.reputation,
    };
    const page = document.createElement('div');
    page.className = 'chat-page'; page.id = 'trade-page';
    page.innerHTML = `
      <div class="chat-topbar"><button class="icon-btn" id="td-back">←</button><div style="flex:1;font-weight:600">资源交易</div><button class="icon-btn" id="td-hist">≡</button></div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:10px" id="td-body">
        <div class="identity-row"><div class="k">服务</div><div class="v">${escapeHtml(svc.name)}</div></div>
        <div class="identity-row"><div class="k">价格</div><div class="v">${escapeHtml(String((svc.price && svc.price.amount) || '') + ' ' + String((svc.price && svc.price.currency) || ''))}</div></div>
        <div class="identity-row"><div class="k">收款方</div><div class="v" style="word-break:break-all">${escapeHtml(svc.payTo || '—')}</div></div>
        <input id="td-req" placeholder="请求内容 (如: 帮我查一条链上数据)" style="${_walletInput}">
        <button id="td-call" style="${_walletBtn}">调用服务 (402 → 策略 → 支付)</button>
        <div id="td-out" style="font-size:13px;line-height:1.7;color:var(--text-secondary)"></div>
      </div>`;
    document.body.appendChild(page);
    $('#td-back').addEventListener('click', () => page.remove());
    $('#td-hist').addEventListener('click', () => openTradeHistory());
    $('#td-call').addEventListener('click', async () => {
      const req = (page.querySelector('#td-req').value || '').trim();
      const out = page.querySelector('#td-out');
      out.textContent = '调用中…';
      try {
        const r = await api.post('/api/trade/call', { service: svc, request: { text: req } });
        const map = { denied: '⛔ 被策略拦截：', needsApproval: '⏸ 需要人工确认：', replayed: '🔁 重复请求被拒：', failed: '❌ 调用失败：' };
        if (r && r.status && map[r.status]) out.textContent = map[r.status] + (r.reason || '');
        else if (r && r.ok) {
          const cid = r.resultCid || (r.proof && r.proof.cid) || '';
          out.textContent = '✅ 成功' + (r.txHash ? '（tx ' + String(r.txHash).slice(0, 14) + '…）' : '') + '\n'
            + (typeof r.result === 'string' ? r.result : JSON.stringify(r.result || {}).slice(0, 400))
            + (cid ? '\n结果 CID: ' + cid + (r.proof && r.proof.provider ? '（' + r.proof.provider + '）' : '（仅本地计算）') : '');
        }
        else out.textContent = (r && (r.error || r.reason)) || '未知结果';
      } catch (e) { out.textContent = '调用失败: ' + ((e && e.message) || e); }
    });
  }

  async function openTradeHistory() {
    const page = document.createElement('div');
    page.className = 'chat-page'; page.id = 'trade-hist';
    page.innerHTML = `<div class="chat-topbar"><button class="icon-btn" id="th-back">←</button><div style="flex:1;font-weight:600">交易记录</div></div><div id="th-body" style="padding:12px;font-size:13px;line-height:1.8;color:var(--text-secondary)">加载中…</div>`;
    document.body.appendChild(page);
    $('#th-back').addEventListener('click', () => page.remove());
    let list = [];
    try { const r = await api.get('/api/trade/trades'); list = (r && r.trades) || []; } catch (e) {}
    const body = page.querySelector('#th-body');
    if (!list.length) { body.textContent = '暂无交易记录。'; return; }
    body.innerHTML = list.map((t) => `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;background:var(--bg-card)">
      <div style="color:var(--text)">${escapeHtml(String(t.service || ''))} · ${escapeHtml(String(t.amount || ''))} ${escapeHtml(String(t.currency || ''))}</div>
      <div style="font-size:11px">${escapeHtml(String(t.status || ''))}${t.txHash ? ' · tx ' + escapeHtml(String(t.txHash).slice(0, 12)) + '…' : ''} · ${new Date(t.ts || Date.now()).toLocaleString()}</div>
      ${t.reason ? '<div style="font-size:11px">' + escapeHtml(String(t.reason)) + '</div>' : ''}
    </div>`).join('');
  }

  // === 本机 IPFS 节点 (Helia 真节点: 前台在线, 可收发块) ===
  async function openHeliaPage() {
    const page = document.createElement('div');
    page.className = 'chat-page'; page.id = 'helia-page';
    page.innerHTML = `
      <div class="chat-topbar"><button class="icon-btn" id="hl-back">←</button><div style="flex:1;font-weight:600">本机 IPFS 节点</div></div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.7">在手机上跑一个真的 IPFS 节点（Helia + libp2p）：有 PeerID、本地块存储、能通过拨出的连接收发块。<br>限制：手机不能监听端口（只能主动连对端）；iOS 进后台会被系统挂起，所以节点只在前台在线 —— 这不是 bug，是系统限制。</div>
        <button id="hl-toggle" style="${_walletBtn}">…</button>
        <button id="hl-test" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text);border-radius:10px">测试：把一个对象存进本机节点</button>
        <div id="hl-status" style="font-size:13px;line-height:1.8;color:var(--text-secondary);word-break:break-all"></div>
      </div>`;
    document.body.appendChild(page);
    $('#hl-back').addEventListener('click', () => page.remove());
    const draw = async () => {
      let st = {};
      try { st = await api.get('/api/helia/status'); } catch (e) { st = { error: (e && e.message) || String(e) }; }
      const on = !!(st && st.running);
      const btn = page.querySelector('#hl-toggle');
      btn.textContent = on ? '停止节点' : '启动节点';
      page.querySelector('#hl-status').innerHTML = [
        '状态: ' + (on ? '运行中' : (st && st.enabled ? '已启用但未运行' : '已停止')),
        st && st.peerId ? 'PeerID: ' + escapeHtml(String(st.peerId)) : '',
        '已连对端: ' + (((st && st.peers) || []).length) + ' 个',
        st && typeof st.blockCount === 'number' ? '本地块数: ' + st.blockCount : '',
        st && st.error ? '错误: ' + escapeHtml(String(st.error)) : '',
      ].filter(Boolean).join('<br>');
      return st;
    };
    await draw();
    page.querySelector('#hl-toggle').addEventListener('click', async () => {
      const st = await draw();
      const on = !!(st && st.running);
      showToast(on ? '正在停止节点…' : '正在启动节点…');
      try { await api.post('/api/helia/enabled', { enabled: !on }); showToast(on ? '节点已停止' : '节点已启动'); }
      catch (e) { showToast('操作失败: ' + ((e && e.message) || e)); }
      await draw();
    });
    page.querySelector('#hl-test').addEventListener('click', async () => {
      const out = page.querySelector('#hl-status');
      out.textContent = '写入中…';
      try {
        const r = await api.post('/api/helia/add', { value: { hello: 'bolloon-mobile-node', ts: Date.now() } });
        const g = r && r.cid ? await api.post('/api/helia/get', { cid: r.cid }) : null;
        out.innerHTML = 'CID: ' + escapeHtml(String((r && r.cid) || '')) + '<br>取回来源: ' + escapeHtml(String((r && g && g.from) || '-')) + '<br>' + escapeHtml(JSON.stringify((g && g.value) || {}).slice(0, 200));
      } catch (e) { out.textContent = '失败: ' + ((e && e.message) || e); }
    });
  }

  // === IPFS 存储配置 (本地算 CID 恒定可用; 上传/取回按此配置) ===
  async function openIpfsConfig() {
    let cfg = {};
    try { cfg = await api.get('/api/ipfs/config'); } catch (e) {}
    const page = document.createElement('div');
    page.className = 'chat-page'; page.id = 'ipfs-config-page';
    page.innerHTML = `
      <div class="chat-topbar"><button class="icon-btn" id="ic-back">←</button><div style="flex:1;font-weight:600">IPFS 存储</div></div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.7">本地算 CID / 校验 CID 永远可用（离线）。上传/取回按下面配置：public=只走公共网关（只读为主）；remote=自建/远程 IPFS 节点；pinata=用 Pinata 上传+固定。</div>
        <input id="ic-mode" placeholder="public / remote / pinata" value="${escapeHtml(String(cfg.mode || 'public'))}" style="${_walletInput}">
        <input id="ic-api" placeholder="远程节点 API (http://host:5001)" value="${escapeHtml(String(cfg.apiUrl || ''))}" style="${_walletInput}">
        <input id="ic-gw" placeholder="网关 (https://ipfs.io)" value="${escapeHtml(String(cfg.gatewayUrl || ''))}" style="${_walletInput}">
        <input id="ic-pk" placeholder="Pinata API Key" value="${escapeHtml(String(cfg.pinataKey || ''))}" style="${_walletInput}">
        <input id="ic-ps" placeholder="Pinata Secret" value="${escapeHtml(String(cfg.pinataSecret || ''))}" style="${_walletInput}">
        <button id="ic-save" style="${_walletBtn}">保存</button>
        <button id="ic-test" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text);border-radius:10px">测试：算一个 CID</button>
        <div id="ic-out" style="font-size:12px;color:var(--text-secondary);line-height:1.7;word-break:break-all"></div>
      </div>`;
    document.body.appendChild(page);
    $('#ic-back').addEventListener('click', () => page.remove());
    $('#ic-save').addEventListener('click', async () => {
      const body = {
        mode: (page.querySelector('#ic-mode').value || 'public').trim(),
        apiUrl: (page.querySelector('#ic-api').value || '').trim(),
        gatewayUrl: (page.querySelector('#ic-gw').value || '').trim(),
        pinataKey: (page.querySelector('#ic-pk').value || '').trim(),
        pinataSecret: (page.querySelector('#ic-ps').value || '').trim(),
      };
      try { const r = await api.post('/api/ipfs/config', body); page.querySelector('#ic-out').textContent = r && r.ok === false ? ('保存失败: ' + (r.error || '')) : '已保存'; showToast('IPFS 配置已保存'); }
      catch (e) { page.querySelector('#ic-out').textContent = '保存失败: ' + ((e && e.message) || e); }
    });
    $('#ic-test').addEventListener('click', async () => {
      const out = page.querySelector('#ic-out');
      out.textContent = '计算中…';
      try { const r = await api.post('/api/ipfs/cid', { value: { hello: 'bolloon', ts: 1 } }); out.textContent = 'CID: ' + ((r && r.cid) || JSON.stringify(r)); }
      catch (e) { out.textContent = '失败: ' + ((e && e.message) || e); }
    });
  }

  // === 链上配置 (手机端独立支付/上链用的 RPC 与网络) ===
  async function openChainConfig() {
    let cfg = {};
    try { cfg = await api.get('/api/chain/config'); } catch (e) {}
    const page = document.createElement('div');
    page.className = 'chat-page'; page.id = 'chain-config-page';
    page.innerHTML = `
      <div class="chat-topbar"><button class="icon-btn" id="cc-back">←</button><div style="flex:1;font-weight:600">链上配置</div></div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.7">手机端自己签名/发交易用这个 RPC（默认 Base 主网）。x402 支付由收款方/facilitator 提交，不需要你付 gas；自己上链注册（铸 NFT）则需要该账户有一点 gas。</div>
        <input id="cc-rpc" placeholder="https://mainnet.base.org" value="${escapeHtml(String(cfg.rpcUrl || ''))}" style="${_walletInput}">
        <input id="cc-chain" placeholder="8453" value="${escapeHtml(String(cfg.chainId || ''))}" style="${_walletInput}">
        <input id="cc-network" placeholder="base / base-sepolia / mainnet / sepolia" value="${escapeHtml(String(cfg.network || ''))}" style="${_walletInput}">
        <button id="cc-save" style="${_walletBtn}">保存</button>
        <div id="cc-out" style="font-size:13px;color:var(--text-secondary);line-height:1.7"></div>
      </div>`;
    document.body.appendChild(page);
    $('#cc-back').addEventListener('click', () => page.remove());
    $('#cc-save').addEventListener('click', async () => {
      const body = {
        rpcUrl: (page.querySelector('#cc-rpc').value || '').trim(),
        chainId: Number((page.querySelector('#cc-chain').value || '').trim()) || undefined,
        network: (page.querySelector('#cc-network').value || '').trim() || undefined,
      };
      try { const r = await api.post('/api/chain/config', body); page.querySelector('#cc-out').textContent = '已保存: ' + JSON.stringify(r || {}); showToast('链上配置已保存'); }
      catch (e) { page.querySelector('#cc-out').textContent = '保存失败: ' + ((e && e.message) || e); }
    });
  }

  // === P2P 连接状态 (手机 WebView 不能 listen → 必须主动拨入电脑端) ===
  async function loadP2PStatus() {
    const box = $('#p2p-status');
    if (!box) return;
    let net = {}; let url = '';
    try { net = await api.get('/api/network/status'); } catch (e) {}
    try { const u = await api.get('/api/desktop/url'); url = (u && u.url) || ''; } catch (e) {}
    let d = { ok: false, addrs: [], error: '' };
    try { d = await api.get('/api/network/desktop-addrs'); } catch (e) {}
    // 2026-09-11: 可拨入地址 (/p2p-circuit) —— 手机在 WebView 里不能 listen,
    // 向中继预约是它唯一能被别人拨入的途径。两个节点 (P2P / Helia) 都看一眼。
    let helia = {};
    try { helia = await api.get('/api/helia/status'); } catch (e) {}
    const conn = !!(net && net.connected);
    const peers = ((net && net.peerIds) || []).length;
    const nodeId = (net && net.nodeId) || '';
    const addrs = (d && d.addrs) || [];
    const circuitAddrs = ((net && net.circuitAddrs) || []).length
      ? net.circuitAddrs
      : (((helia && helia.circuitAddrs) || []));
    const relays = ((net && net.relays) || []).length ? net.relays : (((helia && helia.relays) || []));
    const relayRes = ((net && net.relayReservations) || []).find((r) => r && !r.ok);
    const row = (k, v, small) => `<div class="list-item"><span style="flex:1">${k}</span><span style="font-size:${small ? 11 : 13}px;color:var(--text-secondary);text-align:right;word-break:break-all;max-width:60%">${escapeHtml(v)}</span></div>`;
    let html = '';
    html += row('状态', conn ? '已启动' : '未启动');
    if (nodeId) html += row('本机节点', nodeId.slice(0, 20) + '…', true);
    html += row('已连对端', peers + ' 个');
    html += row('电脑端', url || '未配置', true);
    if (addrs.length) html += row('可拨地址', addrs[0], true);
    // 可拨入地址: 没有就是「暂时不能被别人拨入」, 用大白话说清原因, 不假装成功
    html += circuitAddrs.length
      ? row('可拨入地址', circuitAddrs[0], true)
      : row('可拨入地址', relayRes ? ('预约失败: ' + String(relayRes.error || '').slice(0, 60)) : '无 (没有可用中继 / 还没预约上)', true);
    if (relays.length) html += row('已预约中继', relays.length + ' 个', true);
    box.innerHTML = html;
    // 有可拨入地址 → 给一个复制入口 (别人要用它拨你)
    if (circuitAddrs.length) {
      const cp = document.createElement('div');
      cp.className = 'list-item';
      cp.id = 'p2p-copy-circuit';
      cp.innerHTML = `<span class="list-icon">${ICONS.globe}</span><span style="flex:1">复制可拨入地址</span>`;
      cp.addEventListener('click', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(circuitAddrs[0]);
          else throw new Error('无剪贴板权限');
          showToast('已复制可拨入地址');
        } catch (e) { showToast('复制失败: ' + ((e && e.message) || e)); }
      });
      box.appendChild(cp);
    }
    // 连接/重连按钮 + 人话提示
    const btn = document.createElement('div');
    btn.className = 'list-item';
    btn.id = 'p2p-connect';
    btn.innerHTML = `<span class="list-icon">${ICONS.globe}</span><span style="flex:1">${conn ? '重新连接电脑端' : '连接电脑端'}</span>`;
    btn.addEventListener('click', async () => {
      showToast('正在连接电脑端…');
      try {
        const r = await api.post('/api/network/connect', {});
        showToast(r && r.connected ? 'P2P 已启动' : '没能连上：确认电脑端在运行、同网段、且以 BOLLOON_HOST=0.0.0.0 启动');
      } catch (e) { showToast('连接失败: ' + (e.message || e)); }
      loadP2PStatus();
    });
    box.appendChild(btn);
    // 独立入网: 手机可拨任意可拨节点 (不必非电脑端)
    const addNode = document.createElement('div');
    addNode.className = 'list-item';
    addNode.id = 'p2p-add-node';
    addNode.innerHTML = `<span class="list-icon">${ICONS.globe}</span><span style="flex:1">添加节点地址 (独立入网)</span>`;
    addNode.addEventListener('click', () => addFriendManual());
    box.appendChild(addNode);
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:10px 12px;font-size:12px;color:var(--text-secondary);line-height:1.6';
    hint.textContent = !url && !addrs.length
      ? '手机在 WebView 里不能自己监听端口 → 需要「拨入」至少一个节点才能进网。电脑端是**可选**的：点「添加节点地址」填任意可拨节点的 multiaddr (如 /ip4/1.2.3.4/tcp/4001/ws)，手机就能独立入网并从该节点收发服务请求。'
      : (conn ? (peers ? '已连上 ' + peers + ' 个对端，可收发消息/服务请求（手机拨入的连接是双向的，所以别人也能调用你的服务）。' : '已连上节点，等待其他对端…') : ('未连接：' + ((d && d.error) || '点「连接电脑端」或「添加节点地址」')));
    if (conn && !circuitAddrs.length) {
      hint.textContent += '\n「可拨入地址」还是空的 —— 手机自己不能被别人拨入，必须成功预约到中继才有。确认电脑端已开启中继 (电脑端 /api/p2p/mobile-connect 里 isRelay=true)，再点「重新连接电脑端」。';
    }
    box.appendChild(hint);
  }

  // === 判断力 API (电脑端同步下来的判断库) ===
  async function openJudgments() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'judgments-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="jg-back">←</button>
        <div style="flex:1;font-weight:600">判断力 API</div>
        <button class="icon-btn" id="jg-refresh">↻</button>
      </div>
      <div id="jg-body" style="padding:12px;padding-bottom:calc(24px + env(safe-area-inset-bottom))"></div>`;
    document.body.appendChild(page);
    $('#jg-back').addEventListener('click', () => page.remove());
    $('#jg-refresh').addEventListener('click', () => drawJudgments(page, true));
    await drawJudgments(page, false);
  }

  async function drawJudgments(page, refresh) {
    const body = page.querySelector('#jg-body');
    body.innerHTML = `<div style="color:var(--text-secondary);font-size:13px">${refresh ? '正在从电脑端同步…' : '加载中…'}</div>`;
    if (refresh) {
      const r = await api.post('/api/desktop/sync', {}).catch((e) => ({ ok: false, error: e.message || String(e) }));
      if (!r || !r.ok) {
        body.innerHTML = `<div style="padding:12px;border:1px solid var(--border);border-radius:10px;color:var(--text-secondary);font-size:13px;line-height:1.6">同步失败: ${escapeHtml((r && r.error) || '未知错误')}<br>电脑端地址在「设置 → 电脑端同步」配置 (需同一局域网, 电脑端以 BOLLOON_HOST=0.0.0.0 启动)。</div>`;
        return;
      }
    }
    let st = { url: '', lastTs: 0, counts: {} };
    try { st = await api.get('/api/desktop/status'); } catch { /* 忽略 */ }
    let list = [];
    try { const j = await api.get('/api/judgments/cached'); list = (j && j.judgments) || []; } catch { /* 忽略 */ }
    const when = st.lastTs ? new Date(st.lastTs).toLocaleString() : '尚未同步';
    const cnt = st.counts && Object.keys(st.counts).length ? Object.entries(st.counts).map(([k, v]) => k + ' ' + v).join(' · ') : '';
    const head = `<div style="font-size:12px;color:var(--text-secondary);line-height:1.7;margin-bottom:10px">同步源: ${escapeHtml(st.url || '未配置')}<br>最近同步: ${escapeHtml(when)}${cnt ? '<br>已同步: ' + escapeHtml(cnt) : ''}</div>`;
    if (!list.length) {
      body.innerHTML = head + '<div style="padding:12px;border:1px solid var(--border);border-radius:10px;color:var(--text-secondary);font-size:13px;line-height:1.6">本机暂无判断力数据。点右上角 ↻ 从电脑端同步。</div>';
      return;
    }
    body.innerHTML = head + list.map((j) => `
      <div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);margin-bottom:8px">
        <div style="font-size:13px;line-height:1.5">${escapeHtml(String(j.content || '').slice(0, 220))}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px">${escapeHtml(String(j.type || ''))} · 置信 ${escapeHtml(String(typeof j.confidence === 'number' ? j.confidence.toFixed(2) : (j.confidence || '-')))}</div>
      </div>`).join('');
  }

  // === 电脑端同步 (登录后自动 + 手动) ===
  async function openDesktopSync() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'desktop-sync-page';
    page.innerHTML = `
      <div class="chat-topbar"><button class="icon-btn" id="ds-back">←</button><div style="flex:1;font-weight:600">电脑端同步</div></div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.7">填电脑端 bolloon 地址 (同一局域网, 如 http://192.168.1.5:7788)。登录后手机端自动同步电脑端全部数据 (会话/判断力/服务/资源)。<br>电脑端需以 BOLLOON_HOST=0.0.0.0 启动, 端口见启动日志 BOLLOON_PORT=xxxx。</div>
        <input id="ds-url" placeholder="http://192.168.1.5:7788" style="${_walletInput}">
        <button id="ds-save" style="${_walletBtn}">保存地址</button>
        <button id="ds-sync" style="${_walletBtn}">立即同步</button>
        <div id="ds-status" style="font-size:13px;color:var(--text-secondary);line-height:1.8"></div>
      </div>`;
    document.body.appendChild(page);
    $('#ds-back').addEventListener('click', () => page.remove());
    const drawStatus = async () => {
      let st = { url: '', lastTs: 0, counts: {} };
      try { st = await api.get('/api/desktop/status'); } catch { /* 忽略 */ }
      const when = st.lastTs ? new Date(st.lastTs).toLocaleString() : '尚未同步';
      const cnt = st.counts && Object.keys(st.counts).length ? Object.entries(st.counts).map(([k, v]) => k + ' ' + v).join(' · ') : '—';
      const o = st.orbit;
      const orbitLine = o ? `${o.stores} store · ${o.entries} 条目 (拉 ${o.pulled} / 推 ${o.pushed})` : '未同步';
      page.querySelector('#ds-status').innerHTML = `地址: ${escapeHtml(st.url || '未配置')}<br>最近同步: ${escapeHtml(when)}<br>数据: ${escapeHtml(cnt)}<br>OrbitDB 副本: ${escapeHtml(orbitLine)}`;
    };
    try { const u = await api.get('/api/desktop/url'); page.querySelector('#ds-url').value = (u && u.url) || ''; } catch { /* 忽略 */ }
    await drawStatus();
    $('#ds-save').addEventListener('click', async () => {
      const url = (page.querySelector('#ds-url').value || '').trim();
      try { await api.post('/api/desktop/url', { url }); showToast('地址已保存'); }
      catch (e) { showToast('保存失败: ' + (e.message || e)); }
      await drawStatus();
    });
    $('#ds-sync').addEventListener('click', async () => {
      showToast('正在同步…');
      const r = await api.post('/api/desktop/sync', {}).catch((e) => ({ ok: false, error: e.message || String(e) }));
      if (r && r.ok) {
        const c = r.counts || {};
        const orb = r.orbit && r.orbit.ok ? ' · OrbitDB 副本 ' + r.orbit.stores + ' store/' + r.orbit.entries + ' 条' : '';
        showToast('已同步: ' + Object.entries(c).map(([k, v]) => k + ' ' + v).join(' · ') + orb);
      } else showToast('同步失败: ' + ((r && r.error) || '未知错误'));
      await drawStatus();
    });
  }

  /** 登录后自动同步电脑端 (未配置地址则静默跳过) */
  async function autoSyncDesktop() {
    let u = '';
    try { const r = await api.get('/api/desktop/url'); u = (r && r.url) || ''; } catch { /* 忽略 */ }
    if (!u) return null;
    const r = await api.post('/api/desktop/sync', {}).catch((e) => ({ ok: false, error: e.message || String(e) }));
    if (r && r.ok) {
      const c = r.counts || {};
      const orb = r.orbit && r.orbit.ok ? ' · OrbitDB 副本 ' + r.orbit.stores + ' store/' + r.orbit.entries + ' 条' : '';
      showToast('已同步电脑端: ' + Object.entries(c).map(([k, v]) => k + ' ' + v).join(' · ') + orb);
    } else showToast('电脑端同步失败: ' + ((r && r.error) || '未知错误'));
    return r;
  }

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
        <div class="conv-item" id="api-config-item"><span class="list-icon">${ICONS.chip}</span><span>API 配置</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="theme-toggle"><span class="list-icon" id="theme-icon">${ICONS.themeAuto}</span><span id="theme-text">跟随系统</span></div>
        <div class="conv-item" id="settings-network"><span class="list-icon">${ICONS.globe}</span><span>网络与同步</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-desktop"><span class="list-icon">${ICONS.globe}</span><span>电脑端同步</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-chain"><span class="list-icon">${ICONS.chip}</span><span>链上配置 (RPC/网络)</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-ipfs"><span class="list-icon">${ICONS.chip}</span><span>IPFS 存储</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-helia"><span class="list-icon">${ICONS.globe}</span><span>本机 IPFS 节点</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-selfcard"><span class="list-icon">${ICONS.chip}</span><span id="selfcard-text">显示本机卡片: 开</span></div>
        <div class="conv-item" id="settings-did"><span class="list-icon">${ICONS.idcard}</span><span>DID</span></div>
      </div>`;
    document.body.appendChild(page);
    applyTheme(resolveThemePref(), false);
    $('#settings-back').addEventListener('click', () => page.remove());
    $('#api-config-item').addEventListener('click', openApiConfig);
    $('#theme-toggle').addEventListener('click', () => {
      const next = currentTheme === 'auto' ? 'light' : (currentTheme === 'light' ? 'dark' : 'auto');
      applyTheme(next, true);
    });
    $('#settings-network').addEventListener('click', () => switchTab('network'));
    $('#settings-desktop').addEventListener('click', openDesktopSync);
    // 本机卡片显示开关 (移除后从这里恢复)
    const drawSelfCardToggle = () => {
      const on = (() => { try { return localStorage.getItem(SELF_CARD_HIDDEN_KEY) !== '1'; } catch { return true; } })();
      const el = $('#selfcard-text');
      if (el) el.textContent = '显示本机卡片: ' + (on ? '开' : '关');
    };
    drawSelfCardToggle();
    const sc = $('#settings-chain');
    if (sc) sc.addEventListener('click', openChainConfig);
    const si = $('#settings-ipfs');
    if (si) si.addEventListener('click', openIpfsConfig);
    const sh = $('#settings-helia');
    if (sh) sh.addEventListener('click', openHeliaPage);
    $('#settings-selfcard').addEventListener('click', () => {
      const hidden = (() => { try { return localStorage.getItem(SELF_CARD_HIDDEN_KEY) === '1'; } catch { return false; } })();
      try { localStorage.setItem(SELF_CARD_HIDDEN_KEY, hidden ? '0' : '1'); } catch (e) {}
      drawSelfCardToggle();
      loadAgentCovers();
      showToast(hidden ? '已显示本机卡片' : '已隐藏本机卡片');
    });
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
          ${w.unlocked ? `<button data-wl="export" data-id="${w.id}" style="flex:1;${_walletBtn}">导出私钥</button>` : ''}
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
      else if (act === 'export') { showWalletExport(page, id); }
    }));
  }

  async function showWalletExport(page, id) {
    const body = page.querySelector('#wallet-body');
    const _cp = 'padding:10px;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:8px;font-weight:600;width:100%';
    try {
      const r = await api.post('/api/wallet/export', { id });
      body.innerHTML = `
        <div style="font-weight:700">导出钱包</div>
        <div style="font-size:12px;color:var(--text-secondary)">⚠ 私钥=资产控制权, 切勿截图/外发。助记词仅在创建时显示一次, 不再存储。</div>
        <div style="font-weight:600;font-size:13px">地址</div>
        <div class="wallet-addr" style="word-break:break-all">${escapeHtml(r.address)}</div>
        <button data-copy="${escapeHtml(r.address)}" style="${_cp}">复制地址</button>
        <div style="font-weight:600;font-size:13px;margin-top:4px">私钥 (hex)</div>
        <div class="wallet-addr" style="word-break:break-all">${escapeHtml(r.privateKey)}</div>
        <button data-copy="${escapeHtml(r.privateKey)}" style="${_cp}">复制私钥</button>
        <button id="wl-exp-back" style="padding:12px;border:none;background:var(--bg-hover);color:var(--text-secondary);border-radius:10px">返回</button>`;
      $('#wl-exp-back').addEventListener('click', () => renderWalletList(page));
    } catch (e) { alert(e.message || '导出失败'); }
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
          const _cp = 'padding:10px;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:8px;font-weight:600';
          body.innerHTML = `<div style="background:#3a2a1a;border:1px solid var(--accent);border-radius:10px;padding:14px;font-size:13px"><div style="font-weight:700;color:var(--accent);margin-bottom:6px">⚠ 抄写并离线保存助记词</div><div style="word-break:break-all">${escapeHtml(r.mnemonic)}</div><button data-copy="${escapeHtml(r.mnemonic)}" style="${_cp};margin-top:10px;width:100%">复制助记词</button></div><div class="wallet-addr" style="word-break:break-all;font-size:12px">${escapeHtml(r.address)}</div><button data-copy="${escapeHtml(r.address)}" style="${_cp};width:100%">复制地址</button><button id="wlf-ok" style="${_walletBtn}">我已保存</button>`;
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
    const agents = (() => {
      // 去重: agentId 才是身份 (多个频道可能同属一个身份) → 每个身份只列一条
      const seen = new Set();
      const out = [];
      for (const c of channels) {
        const aid = c.agentId || c.id;
        if (!aid || seen.has(aid)) continue;
        seen.add(aid);
        out.push({ agentId: aid, name: c.persona?.name || c.name || '本机 Agent' });
      }
      return out;
    })();
    // 兜底: 没有渠道时至少能授权给本机 Agent (DID 由本机生成, 始终存在)
    if (agents.length === 0) {
      try {
        const me = await api.get('/api/auth/status');
        if (me && me.did) agents.push({ agentId: me.did, name: '本机 Agent' });
      } catch { /* 忽略 */ }
    }
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
      let n = 0;
      try {
        for (const cb of list) {
          await api.post('/api/wallet/grant', { id: walletId, agentId: cb.dataset.aid, allow: cb.checked });
          if (cb.checked) n++;
        }
        showToast('已授权 ' + n + ' 个智能体');
      } catch (e) { showToast('授权失败: ' + (e.message || e)); }
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
  // 扫码统一入口: 真机用「拍照/选图」走 jsQR 管线 (免原生插件, iOS 也可用)
  let _qrMode = 'join';   // 'join' = 入网 | 'friend' = 加好友
  function addFriendScan() {
    hideSheet('#addfriend-sheet');
    _qrMode = 'friend';
    const inp = $('#qr-scan-input');
    if (!inp) { alert('此设备不支持扫码'); return; }
    inp.click();
  }

  // === 复制 (助记词/私钥/地址 快捷复制; 全局委托 [data-copy]) ===
  async function copyText(t) {
    const txt = String(t || '');
    try { await navigator.clipboard.writeText(txt); return true; }
    catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e2) { return false; }
    }
  }
  document.addEventListener('click', async (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-copy]') : null;
    if (!b) return;
    const ok = await copyText(b.getAttribute('data-copy'));
    const old = b.textContent;
    b.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { b.textContent = old; }, 1200);
  });

  // === 登录页 (设置本机身份昵称) ===
  function openLoginPage() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'login-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="login-back">←</button>
        <div style="flex:1;font-weight:600">登录</div>
      </div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:13px;color:var(--text-secondary)">登录 = 在本机创建/启用身份并设置昵称。DID 由本机生成, 不上传服务器。</div>
        <input id="login-name" placeholder="昵称 (如 觉者)" style="${_walletInput}">
        <button id="login-submit" style="${_walletBtn}">登录</button>
      </div>`;
    document.body.appendChild(page);
    $('#login-back').addEventListener('click', () => page.remove());
    $('#login-submit').addEventListener('click', async () => {
      const name = (($('#login-name') || {}).value || '').trim();
      try {
        await api.post('/api/auth/login', { name });
        page.remove();
        await loadMe();
        switchTab('me');
        // 登录后自动同步电脑端 (未配置地址则静默跳过)
        await autoSyncDesktop();
      } catch (e) { alert('登录失败: ' + (e.message || e)); }
    });
  }

  // === 菜单 ===
  function bindMenu() {
    $('#item-settings').addEventListener('click', openSettings);
    $('#item-wallet').addEventListener('click', () => { openWallet(); });
    $('#item-judgments').addEventListener('click', () => { openJudgments(); });
    // 头顶身份栏: 头像可改, 右侧卡片开身份介绍页; DID 不再作为标签按钮
    $('#me-avatar').addEventListener('click', pickAvatar);
    $('#profile-info').addEventListener('click', openIdentityPage);
    bindAvatarInput();
    $('#item-login').addEventListener('click', () => { openLoginPage(); });
    $('#item-logout').addEventListener('click', async () => {
      if (!confirm('确定注销? 将清除本机登录态 (DID 保留, 不影响频道/P2P)。')) return;
      try { await api.post('/api/auth/logout', {}); await loadMe(); } catch (e) { alert('注销失败: ' + (e.message || e)); }
    });
    $('#btn-add').addEventListener('click', addFriend);
    const cs = $('#btn-create-session'); if (cs) cs.addEventListener('click', createSession);
    const csScan = $('#choice-scan'); if (csScan) csScan.addEventListener('click', addFriendScan);
    const csMan = $('#choice-manual'); if (csMan) csMan.addEventListener('click', addFriendManual);
    const csCan = $('#choice-cancel'); if (csCan) csCan.addEventListener('click', () => hideSheet('#addfriend-sheet'));
    $('#item-p2p').addEventListener('click', () => { switchTab('network'); });
    const itTrade = $('#item-trade');
    if (itTrade) itTrade.addEventListener('click', async () => {
      await loadAgentServices();
      const first = _svcCache[0];
      if (first) openTradeCall(first); else openTradeHistory();
    });
    $('#item-p2p-id').addEventListener('click', async () => {
      try { const net = await api.get('/api/network/status'); const p2p = net && net.nodeId; alert('P2P ID (通信ID, ≠ DID):\n' + (p2p || '未连接')); }
      catch (e) { alert('P2P ID: 获取失败'); }
    });
    // #2 极简入网按钮: 粘贴/输入链接 → BolloonCore.gateway.join (懒加载 mobile-gateway)
    const joinNetBtn = $('#item-join-net');
    if (joinNetBtn) joinNetBtn.addEventListener('click', async () => {
      const link = (window.prompt && window.prompt('粘贴网络链接\n(orbitdb://  ipns://  https://.../registry)') || '').trim();
      if (!link) return;
      try {
        const r = await (window.BolloonCore && window.BolloonCore.gateway && window.BolloonCore.gateway.join(link));
        alert(r ? (r.output || '已处理') : 'BolloonCore.gateway 不可用');
      } catch (e) { alert('加入失败: ' + String((e && e.message) || e).slice(0, 120)); }
      loadNetMembers();
    });
    // #3 扫码入网: 拍照/选图 → BolloonCore.qr.decode(jsQR) → gateway.join (免原生插件)
    const scanBtn = $('#item-scan-net');
    const scanInput = $('#qr-scan-input');
    if (scanBtn && scanInput) scanBtn.addEventListener('click', () => scanInput.click());
    if (scanInput) scanInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      scanInput.value = '';
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = async () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const c2 = c.getContext('2d');
          if (!c2) return alert('画布不可用');
          c2.drawImage(img, 0, 0);
          const id = c2.getImageData(0, 0, c.width, c.height);
          const text = await (window.BolloonCore && window.BolloonCore.qr && window.BolloonCore.qr.decode(id.data, id.width, id.height));
          if (!text) { alert('未识别到二维码 (试试 /net qr 重新出码)'); return; }
          // 加好友模式: multiaddr → peers/add; 其他内容(入网链接) → gateway.join
          if (_qrMode === 'friend') {
            _qrMode = 'join';
            if (/^\/(ip4|ip6|dns|dns4|dns6|p2p)\//.test(String(text).trim())) {
              const r = await api.post('/api/peers/add', { addr: String(text).trim() });
              alert(r && r.ok ? (r.connected ? '已连接好友' : '已记录好友地址, 连接中…') : ((r && r.error) || '添加失败'));
            } else {
              const r2 = await (window.BolloonCore && window.BolloonCore.gateway && window.BolloonCore.gateway.join(text));
              alert(r2 ? (r2.output || '已处理') : '这个二维码不是好友地址 (也不是入网链接)');
            }
            if (currentTab === 'network') { loadContacts(); loadP2PStatus(); }
            return;
          }
          const r = await (window.BolloonCore && window.BolloonCore.gateway && window.BolloonCore.gateway.join(text));
          alert(r ? (r.output || '已入网') : 'gateway.join 不可用');
          loadNetMembers();
        } catch (err) { alert('解码失败: ' + String((err && err.message) || err).slice(0, 120)); }
        finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { alert('图片读取失败'); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  async function loadNetMembers() {
    const el = $('#net-members');
    if (!el) return;
    try {
      const r = await (window.BolloonCore && window.BolloonCore.gateway && window.BolloonCore.gateway.status());
      if (r && r.output) {
        el.innerHTML = r.output.split('\n').filter(Boolean).map((l) => `<div class="list-item">${escapeHtml(l)}</div>`).join('');
      } else el.innerHTML = '<div class="list-item">（网络为空）</div>';
    } catch (e) { el.innerHTML = '<div class="list-item">网络状态获取失败</div>'; }
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

  // === 深链 (bolloon://) — iOS 系统入口 (Siri / 快捷指令 / Spotlight) 驱动智能体 (2026-09-11) ===
  // 协议: bolloon://agent/run|status?name=<name>[&goal=<text>]
  // 三条投递路径, 任意一条通就够, 互不依赖 (缺的自动跳过, 不报错):
  //   1. @capacitor/app 的 appUrlOpen —— 该插件**当前没装** (package.json 无 @capacitor/app);
  //      装上以后下面这段自动生效, 不需要再改这里。
  //   2. Swift 侧 (ios/App/App/BolloonIntents.swift) 往 WKWebView 注入 window.__bolloonPendingDeepLink
  //      并派发 'bolloon:deeplink' 事件 —— 不走插件, 现在就能用。
  //   3. 纯浏览器回退: 页面 URL 自身就是 bolloon:// (手动粘贴测试用)。
  let _lastDeepLinkKey = '';
  function handleDeepLinkUrl(rawUrl) {
    const c = window.BolloonCore;
    let res;
    try {
      res = c && c.handleDeepLink
        ? c.handleDeepLink(String(rawUrl || ''))
        : { ok: false, error: 'BolloonCore.handleDeepLink 不可用' };
    } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    if (!res || res.ok !== true) {
      showToast('这个链接没认出来: ' + ((res && res.error) || String(rawUrl || '')));
      return res;
    }
    const key = res.action + '|' + res.name + '|' + (res.goal || '');
    if (key === _lastDeepLinkKey) return res;      // 同一链接被两条路径重复投递 → 只处理一次
    _lastDeepLinkKey = key;
    openDeepLinkTarget(res).catch(() => {});
    return res;
  }

  async function openDeepLinkTarget(res) {
    switchTab('main');
    let cards = Array.isArray(allAgentCards) ? allAgentCards : [];
    if (!cards.length) { try { await loadAgentCovers(); } catch (e) {} cards = Array.isArray(allAgentCards) ? allAgentCards : []; }
    const want = String(res.name || '').trim();
    const card = want
      ? cards.find((x) => x && (x.name === want || String(x.name || '').includes(want)))
      : cards[0];
    if (!card) { showToast('没找到叫「' + (want || '(空)') + '」的智能体'); return; }
    if (res.action === 'status') {
      const idx = cards.indexOf(card);
      if (idx >= 0) openCardDetail(idx);
      showToast('智能体「' + card.name + '」: ' + (card.status === 'online' ? '在线' : '离线'));
      return;
    }
    // action === 'run': 打开它的对话页 (带 goal 就直接发一条)
    openChat(card);
    if (res.goal) {
      try { await api.post('/message', { text: String(res.goal), channelId: card.id }); }
      catch (e) { showToast('发送失败: ' + ((e && e.message) || e)); }
    }
  }

  function installDeepLinkListeners() {
    // 2. Swift 注入的 pending (冷启动时原生先注入, 这里读到)
    try {
      if (window.__bolloonPendingDeepLink) handleDeepLinkUrl(window.__bolloonPendingDeepLink);
    } catch (e) {}
    window.addEventListener('bolloon:deeplink', (ev) => {
      const u = (ev && ev.detail) || window.__bolloonPendingDeepLink || '';
      if (u) handleDeepLinkUrl(u);
    });
    // 1. @capacitor/app (未安装 → 直接跳过)
    try {
      const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (AppPlugin && typeof AppPlugin.addListener === 'function') {
        AppPlugin.addListener('appUrlOpen', (e) => { if (e && e.url) handleDeepLinkUrl(e.url); });
        if (typeof AppPlugin.getLaunchUrl === 'function') {
          AppPlugin.getLaunchUrl().then((r) => { if (r && r.url) handleDeepLinkUrl(r.url); }).catch(() => {});
        }
      }
    } catch (e) {}
    // 3. 纯浏览器回退
    try {
      const href = String((window.location && window.location.href) || '');
      if (/^bolloon:\/\//i.test(href)) handleDeepLinkUrl(href);
    } catch (e) {}
  }

  function init() {
    bindMenu();
    applyTheme(resolveThemePref(), false);
    switchTab('main');
    setupUiControl();
    installDeepLinkListeners();
    loadAgentCovers();
    loadMe();
    if (core?.network?.start) core.network.start().catch(() => {});
    // 本机 IPFS 节点: 若已启用则在启动时拉起 (iOS 回前台也走这里)
    api.get('/api/helia/status').then((st) => { if (st && st.enabled && !st.running) api.post('/api/helia/start', {}).catch(() => {}); }).catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
