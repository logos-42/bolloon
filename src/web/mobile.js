/* Bolloon 手机端前端 — Tauri 重构版
 *
 * 架构变更 (2026-11): 不再走 Capacitor 本地内核 resolve/resolvePost。
 * Tauri 内嵌 axum 服务，前端通过标准 fetch /api/* 请求（同源 HTTP）。
 * 页面由 Tauri WebView 加载 http://127.0.0.1:<port>/?app=mobile。
 */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ─────────────────────────────────────────────
  // API 层：标准 fetch /api/* (同源，Tauri axum)
  // ─────────────────────────────────────────────
  const api = {
    async get(path) {
      const r = await fetch(path, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    },
    async post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    },
  };

  function showToast(text, ms = 3000) {
    const t = $('#toast-text'); const s = $('#toast-sheet');
    if (t) t.textContent = text;
    if (s) { s.hidden = false; setTimeout(() => { s.hidden = true; }, ms); }
    console.log('[toast]', text);
  }

  // ─────────────────────────────────────────────
  // 主题
  // ─────────────────────────────────────────────
  const THEMES = {
    dark: { '--bg': '#1a1a18', '--bg-card': '#222220', '--bg-hover': '#2a2a26', '--text': '#d8d8c8', '--text-secondary': '#909088', '--accent': '#c4d640', '--border': '#3a3a36' },
    light: { '--bg': '#f5f5f0', '--bg-card': '#ffffff', '--bg-hover': '#eeeeea', '--text': '#1a1a18', '--text-secondary': '#606058', '--accent': '#8a9430', '--border': '#d0d0c8' },
  };
  function systemTheme() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch { return 'dark'; }
  }
  let currentThemePref = 'auto';
  function resolveThemePref() {
    try { const v = localStorage.getItem('bolloon_theme'); return ['auto','light','dark'].includes(v) ? v : 'auto'; }
    catch { return 'auto'; }
  }
  function applyTheme(name, persist = true) {
    currentThemePref = ['auto','light','dark'].includes(name) ? name : 'auto';
    const eff = currentThemePref === 'auto' ? systemTheme() : currentThemePref;
    const t = THEMES[eff];
    const root = document.documentElement;
    Object.entries(t).forEach(([k, v]) => root.style.setProperty(k, v));
    root.setAttribute('data-theme', eff);
    root.style.colorScheme = eff;
    if (persist) { try { localStorage.setItem('bolloon_theme', currentThemePref); } catch (e) {} }
    const btn = $('#btn-menu');
    if (btn) btn.title = currentThemePref === 'auto' ? '跟随系统' : (currentThemePref === 'light' ? '浅色' : '深色');
  }
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentThemePref === 'auto') applyTheme('auto', false);
    });
  } catch (e) {}

  // ─────────────────────────────────────────────
  // Tab 切换
  // ─────────────────────────────────────────────
  const TITLES = { home: '首页', friends: '通讯录', tasks: '任务', me: '我' };
  let currentTab = 'home';
  function switchTab(tab) {
    currentTab = tab;
    $$('.page').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#topbar-title').textContent = TITLES[tab] || '会话';
    const actions = $('#topbar-actions');
    if (actions) {
      actions.innerHTML = '';
      if (tab === 'home') {
        const themeBtn = document.createElement('button');
        themeBtn.className = 'icon-btn';
        themeBtn.title = currentThemePref === 'auto' ? '跟随系统' : (currentThemePref === 'light' ? '浅色' : '深色');
        themeBtn.innerHTML = currentThemePref === 'auto'
          ? '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"/></svg>'
          : (currentThemePref === 'light'
            ? '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>'
            : '<svg class="ico" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>');
        themeBtn.addEventListener('click', () => {
          const next = currentThemePref === 'auto' ? 'light' : (currentThemePref === 'light' ? 'dark' : 'auto');
          applyTheme(next);
          themeBtn.title = next === 'auto' ? '跟随系统' : (next === 'light' ? '浅色' : '深色');
          themeBtn.innerHTML = next === 'auto'
            ? '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"/></svg>'
            : (next === 'light'
              ? '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>'
              : '<svg class="ico" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>');
        });
        actions.appendChild(themeBtn);
      }
    }
    if (tab === 'friends') { loadP2PStatus(); loadContacts(); }
    if (tab === 'tasks') { loadTaskDashboard(); }
    if (tab === 'me') { loadMe(); }
    if (tab === 'home') { loadHome(); }
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 初始化主题 + 首屏
  applyTheme(resolveThemePref(), false);
  switchTab('home');

  // ─────────────────────────────────────────────
  // 首页：世界机会流 + 智能体卡片
  // ─────────────────────────────────────────────
  let worldFeedTimer = null;
  async function loadHome() {
    loadWorldFeed();
    loadAgentCovers();
  }
  async function loadWorldFeed() {
    const cards = $('#world-feed-cards');
    if (!cards) return;
    try {
      const data = await api.get('/api/world/cards');
      const opps = ((data && data.opportunities) || []).slice(0, 6);
      if (!opps.length) { cards.innerHTML = '<div class="world-feed-loading">世界暂无机会</div>'; return; }
      cards.innerHTML = opps.map((o) => {
        const pct = Math.round((o.score || 0) * 100);
        let tag = '世界变化';
        if (o.reason === 'inbox') tag = '✉ 外部投递';
        else if (o.reason === 'search') tag = '🔎 AI 搜索';
        else if (o.reason === 'match') tag = '与你匹配';
        else if (o.reason === 'card') tag = (o.card && o.card.scope === 'public') ? '🌐 公域' : '🎴 卡片';
        return `<div class="world-feed-card">
          <div class="world-feed-card-top">
            <span class="world-feed-title">${escapeHtml(String(o.title || '').slice(0, 34))}</span>
            <span class="world-feed-pct">${pct}%<small> ${tag}</small></span>
          </div>
          <div class="world-feed-summary">${escapeHtml(String(o.summary || '').slice(0, 60))}</div>
          <div class="world-feed-actions">
            <button class="world-feed-btn" data-wf-action="accept" data-wf-id="${escapeHtml(String(o.id))}">看看</button>
            <button class="world-feed-btn ghost" data-wf-action="ignore" data-wf-id="${escapeHtml(String(o.id))}">忽略</button>
          </div>
        </div>`;
      }).join('');
      cards.querySelectorAll('[data-wf-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.wfId;
          const action = btn.dataset.wfAction;
          try { await api.post(`/api/opportunities/${id}/${action}`, {}); } catch (e) {}
          const card = btn.closest('.world-feed-card');
          if (card) {
            card.style.opacity = '0.3';
            card.style.filter = action === 'ignore' ? 'grayscale(1)' : 'none';
            card.style.borderLeftColor = action === 'accept' ? '#c4d640' : 'transparent';
          }
        });
      });
    } catch (e) {
      cards.innerHTML = '<div class="world-feed-loading">世界机会流不可达</div>';
    }
    if (!worldFeedTimer) {
      worldFeedTimer = setInterval(loadWorldFeed, 45000);
    }
  }

  // 智能体卡片
  let allAgentCards = [];
  let currentCardIndex = 0;
  let coverListCache = null;
  const COVER_MAP_KEY = 'bolloon_cover_map';
  const SELF_CARD_HIDDEN_KEY = 'bolloon_hide_self_card';
  async function loadCovers() {
    if (coverListCache) return coverListCache;
    try {
      const r = await fetch('./covers/index.json');
      coverListCache = await r.json();
    } catch (e) { coverListCache = []; }
    return coverListCache;
  }
  function coverFor(key, idx) {
    const list = coverListCache || [];
    if (!list.length) return '';
    let map = {};
    try { map = JSON.parse(localStorage.getItem(COVER_MAP_KEY) || '{}') || {}; } catch { map = {}; }
    if (map[key] && list.indexOf(map[key]) >= 0) return './covers/' + map[key];
    const used = {}; Object.keys(map).forEach((k) => { used[map[k]] = 1; });
    let pick = list.filter((c) => !used[c])[0];
    if (!pick) pick = list[idx % list.length];
    map[key] = pick;
    try { localStorage.setItem(COVER_MAP_KEY, JSON.stringify(map)); } catch (e) {}
    return './covers/' + pick;
  }
  async function loadAgentCovers() {
    const track = $('#card-track');
    const indicator = $('#card-indicator');
    if (!track || !indicator) return;
    track.innerHTML = '<div class="card-loading">加载智能体卡片…</div>';
    try {
      const [channels, peers] = await Promise.all([
        api.get('/channels').catch(() => []),
        api.get('/api/peers').catch(() => []),
      ]);
      const channelList = Array.isArray(channels) ? channels : [];
      const peerList = Array.isArray(peers) ? peers : [];
      allAgentCards = [];
      const selfHidden = (() => { try { return localStorage.getItem(SELF_CARD_HIDDEN_KEY) === '1'; } catch { return false; } })();
      try {
        const st = await api.get('/api/auth/status');
        if (st && st.did && !selfHidden) {
          allAgentCards.push({
            id: st.did, agentId: st.did,
            name: st.name || '本机智能体',
            desc: '本机 Agent (手机端自治执行)',
            avatar: null, peer: null,
            status: 'online', lastActive: '刚刚',
            capabilities: ['chat', 'local-agent'],
            deletable: true, self: true,
          });
        }
      } catch {}
      allAgentCards = allAgentCards.concat(channelList.map((ch, i) => {
        const peer = peerList.find((p) => p.id === ch.agentId || p.publicKey?.slice(0, 12) === String(ch.agentId || '').slice(0, 12));
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
            name: p.name || '未知联系人',
            desc: '通讯录智能体',
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
    const _seen = {};
    allAgentCards.forEach((c, i) => {
      let key = String(c.id || c.agentId || ('card' + i));
      if (_seen[key]) key = key + '#' + i;
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
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      isDragging = false;
      const t = e.target;
      startWrap = (t && t.closest) ? t.closest('.card-wrap') : null;
    }, { passive: true });
    track.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (Math.max(dx, dy) > 10) isDragging = true;
    }, { passive: true });
    track.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx < -30) revealWrap(startWrap, true);
        else if (dx > 30) revealWrap(startWrap, false);
      }
      startWrap = null;
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

  // ─────────────────────────────────────────────
  // 通讯录
  // ─────────────────────────────────────────────
  async function loadP2PStatus() {
    const box = $('#p2p-status');
    if (!box) return;
    try {
      const st = await api.get('/api/network/status');
      const connected = st && st.connected;
      box.innerHTML = `
        <div class="list-item">
          <span class="list-icon">🌐</span>
          <span style="flex:1"><span style="display:block">P2P 网络</span><span class="conv-preview" style="display:block">${connected ? '已连接' : '未连接'}</span></span>
          <span class="list-arrow">›</span>
        </div>`;
    } catch (e) {
      box.innerHTML = '<div style="padding:14px 16px;color:var(--text-muted)">网络状态不可读</div>';
    }
  }
  async function loadContacts() {
    const list = $('#contacts-list');
    const idx = $('#contacts-index');
    if (!list) return;
    try {
      const peers = await api.get('/api/peers');
      const peerList = Array.isArray(peers) ? peers : [];
      list.innerHTML = '';
      if (peerList.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无联系人</div>';
        if (idx) idx.innerHTML = '';
        return;
      }
      const groups = {};
      peerList.forEach((p) => {
        const name = p.name || p.publicKey?.slice(0, 12) || '好友';
        const letter = (name.charAt(0) || '#').toUpperCase();
        const g = /[A-Z]/.test(letter) ? letter : '#';
        if (!groups[g]) groups[g] = [];
        groups[g].push({ name, peer: p });
      });
      const letters = Object.keys(groups).sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
      letters.forEach((letter) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'contacts-group';
        groupEl.setAttribute('data-letter', letter);
        const head = document.createElement('div');
        head.className = 'contacts-group-head';
        head.textContent = letter;
        groupEl.appendChild(head);
        groups[letter].forEach((c) => {
          const el = document.createElement('div');
          el.className = 'conv-item contact-row';
          el.innerHTML = `<div class="conv-avatar contact-avatar">${escapeHtml(c.name.charAt(0))}</div>
            <div class="conv-body">
              <div class="conv-name">${escapeHtml(c.name)}</div>
              <div class="contact-sub">${c.peer.online ? '在线' : '离线'}${c.peer.publicKey ? ' · ' + escapeHtml(String(c.peer.publicKey).slice(0, 10)) + '…' : ''}</div>
            </div>`;
          groupEl.appendChild(el);
        });
        list.appendChild(groupEl);
      });
      if (idx) {
        idx.innerHTML = letters.map((l) => `<div class="contacts-index-letter" data-letter="${l}">${l === '#' ? '#' : l}</div>`).join('');
        idx.querySelectorAll('.contacts-index-letter').forEach((el) => {
          el.addEventListener('click', () => {
            const target = list.querySelector(`.contacts-group[data-letter="${el.dataset.letter}"]`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      }
    } catch (e) {
      list.innerHTML = '<div style="padding:20px;color:var(--text-muted)">联系人加载失败</div>';
    }
  }

  // ─────────────────────────────────────────────
  // 聊天页 (打开智能体卡片后)
  // ─────────────────────────────────────────────
  function openChat(card) {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'chat-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="chat-back">←</button>
        <div style="flex:1;font-weight:600">${escapeHtml(card.name)}</div>
        <button class="icon-btn" id="chat-more" title="更多">⋮</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-bar">
        <input type="text" id="chat-input" placeholder="发消息给 ${escapeHtml(card.name)}… (Enter 发送)" autocomplete="off" />
        <button id="chat-send">发送</button>
      </div>`;
    document.body.appendChild(page);
    $('#chat-back').addEventListener('click', () => page.remove());
    const messages = $('#chat-messages');
    const input = $('#chat-input');
    const sendBtn = $('#chat-send');
    async function sendMsg() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      appendMsg('user', text);
      try {
        const r = await api.post('/message', { text, channelId: card.id });
        const reply = (r && (r.text || r.reply || r.content)) || '(无回复)';
        appendMsg('ai', String(reply));
      } catch (e) {
        appendMsg('ai', '[发送失败] ' + (e.message || e));
      }
    }
    function appendMsg(role, text) {
      const el = document.createElement('div');
      el.className = 'bubble ' + (role === 'user' ? 'user' : 'ai');
      el.textContent = text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }
    sendBtn.addEventListener('click', sendMsg);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
  }

  // ─────────────────────────────────────────────
  // 任务 tab：派活 + 对话
  // ─────────────────────────────────────────────
  async function loadTaskDashboard() {
    loadAgentControl();
    loadApprovals();
  }
  async function loadAgentControl() {
    const box = $('#agent-control');
    if (!box) return;
    try {
      const tools = (await api.get('/api/mcp/tools')) || [];
      const skills = (await api.get('/api/skills')) || [];
      box.innerHTML = `
        <div class="list-item" id="item-mcp">
          <span class="list-icon">🔧</span>
          <span style="flex:1"><span style="display:block">MCP 工具 · ${tools.length} 个</span>
          <span class="conv-preview" style="display:block">调用本机 MCP 工具</span></span>
          <span class="list-arrow">›</span>
        </div>
        <div class="list-item" id="item-skills">
          <span class="list-icon">🛠️</span>
          <span style="flex:1"><span style="display:block">Skills · ${skills.length} 个</span>
          <span class="conv-preview" style="display:block">本机技能 (来自 ~/.bolloon/skills/)</span></span>
          <span class="list-arrow">›</span>
        </div>`;
      $('#item-mcp')?.addEventListener('click', () => alert('MCP 工具调用页面 (需桌面端同步工具列表)'));
      $('#item-skills')?.addEventListener('click', () => {
        if (!skills.length) alert('暂无 Skills。在电脑端 ~/.bolloon/skills/ 下放置技能文件，再在「设置」同步。');
        else alert(skills.map(s => `/${s.name || ''}: ${s.description || ''}`).join('\n\n'));
      });
    } catch (e) {
      box.innerHTML = '<div style="padding:14px 16px;color:var(--text-muted)">工具列表不可读</div>';
    }
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
            <button class="approve-btn" data-id="${escapeHtml(String(a.id))}" style="background:var(--success,#22c55e);border:none;border-radius:6px;padding:4px 14px;color:#fff">批准</button>
            <button class="reject-btn" data-id="${escapeHtml(String(a.id))}" style="background:var(--error,#ef4444);border:none;border-radius:6px;padding:4px 14px;color:#fff">拒绝</button>
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
    } catch (e) {
      box.innerHTML = '<div style="padding:10px;color:var(--text-muted)">支付审批不可读</div>';
    }
  }

  // 任务派活
  async function sendTask() {
    const input = $('#task-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendTaskMsg('user', text);
    const empty = $('#task-chat-empty'); if (empty) empty.hidden = true;
    try {
      const r = await api.post('/api/chat', { text });
      const reply = (r && (r.text || r.reply || r.content)) || '(无回复)';
      appendTaskMsg('ai', String(reply));
    } catch (e) {
      appendTaskMsg('ai', '[执行失败] ' + (e.message || e));
    }
  }
  function appendTaskMsg(role, text) {
    const chat = $('#task-chat');
    if (!chat) return;
    const el = document.createElement('div');
    el.className = 'task-msg ' + (role === 'user' ? 'task-msg-user' : 'task-msg-ai');
    el.textContent = text;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }
  $('#task-input-send')?.addEventListener('click', sendTask);
  $('#task-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTask(); });

  // 网络工具覆盖层
  function openTaskNetwork() {
    const p = $('#task-network-panel'); if (p) p.hidden = false;
    try { loadAgentControl(); loadApprovals(); } catch (e) {}
  }
  function closeTaskNetwork() {
    const p = $('#task-network-panel'); if (p) p.hidden = true;
  }
  $('#task-dash-network')?.addEventListener('click', openTaskNetwork);
  $('#task-network-back')?.addEventListener('click', closeTaskNetwork);

  // ─────────────────────────────────────────────
  // 我 tab：身份 / 钱包 / 设置
  // ─────────────────────────────────────────────
  async function loadMe() {
    const avatarEl = $('#me-avatar');
    const av = localStorage.getItem('bolloon_avatar');
    if (avatarEl) {
      if (av) { avatarEl.style.backgroundImage = 'url(' + av + ')'; avatarEl.style.backgroundSize = 'cover'; avatarEl.style.backgroundPosition = 'center'; avatarEl.textContent = ''; }
      else { avatarEl.style.backgroundImage = 'none'; avatarEl.textContent = '?'; }
    }
    try {
      const s = await api.get('/api/auth/status');
      $('#me-name').textContent = s.loggedIn ? (s.name || '未登录') : '未登录';
      $('#me-did').textContent = s.did ? ('身份证明: ' + (s.didShort || s.did)) : '';
      if (avatarEl && !av) avatarEl.textContent = (s.loggedIn && s.name ? s.name : 'U').charAt(0);
      $('#login-label').textContent = s.loggedIn ? '已登录' : '登录';
    } catch (e) {}
    try {
      const net = await api.get('/api/network/status');
      const p2p = net && net.nodeId;
      $('#me-p2p').textContent = p2p ? ('连接标识: ' + p2p.slice(0, 14) + '…') : '';
    } catch (e) {}
  }

  // 头像裁剪
  $('#avatar-input')?.addEventListener('change', () => {
    const f = $('#avatar-input').files && $('#avatar-input').files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => openCropModal(String(reader.result));
    reader.readAsDataURL(f);
    $('#avatar-input').value = '';
  });
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
    const stage = $('#crop-stage');
    const img = $('#crop-img');
    const box = $('#crop-box');
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
    $('#crop-zoom')?.addEventListener('input', (e) => { zoom = parseFloat(e.target.value); layout(); });
    $('#crop-cancel')?.addEventListener('click', () => modal.remove());
    $('#crop-confirm')?.addEventListener('click', () => {
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

  // 登录/注销
  $('#item-login')?.addEventListener('click', async () => {
    const label = $('#login-label');
    const isLogged = label && label.textContent === '已登录';
    if (isLogged) { showToast('已登录'); return; }
    const name = prompt('请输入你的名字 (用于生成身份):', '');
    if (!name) return;
    try {
      await api.post('/api/auth/login', { name });
      showToast('登录成功');
      loadMe();
    } catch (e) {
      alert('登录失败: ' + (e.message || e));
    }
  });
  $('#item-logout')?.addEventListener('click', async () => {
    if (!confirm('确定注销? 本机数据将被清除。')) return;
    try { await api.post('/api/auth/logout', {}); } catch (e) {}
    localStorage.removeItem('bolloon_avatar');
    showToast('已注销');
    loadMe();
  });

  // 世界输入框
  function bindWorldInput() {
    const input = $('#world-input');
    const send = $('#world-input-send');
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tellWorld(); });
    if (send) send.addEventListener('click', tellWorld);
  }
  async function tellWorld() {
    const input = $('#world-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api.post('/api/intents', { text, priority: 3 });
      showToast('🌍 已告诉世界，正在为你匹配机会…');
      loadWorldFeed();
    } catch (e) {
      console.info('[world] 声明失败', e);
      showToast('声明意图失败');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindWorldInput);
  else bindWorldInput();

  // 顶部菜单按钮（主题已在 topbar-actions 里渲染）
  $('#btn-menu')?.addEventListener('click', () => {
    const actions = $('#topbar-actions');
    if (actions) actions.hidden = !actions.hidden;
  });

  // 隐私同意门（首启）
  (async () => {
    try {
      const need = localStorage.getItem('bolloon_privacy_consent') !== '1';
      if (need) {
        $('#privacy-gate').hidden = false;
        $('#privacy-agree')?.addEventListener('click', () => {
          localStorage.setItem('bolloon_privacy_consent', '1');
          $('#privacy-gate').hidden = true;
        });
        $('#privacy-decline')?.addEventListener('click', () => {
          alert('不同意隐私政策，应用将退出。');
          try { window.close?.(); } catch {} 
        });
      }
    } catch (e) {}
  })();

})();
