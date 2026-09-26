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

  // 一键入网默认 prompt: 交给智能体去读网关入网说明并执行入网 (人类只点一下)
  const DEFAULT_JOIN_PROMPT = 'read https://bolloon.cn/bolloon-gateway-join.md';

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

  const TITLES = { main: '首页', friends: '好友', network: '网络', tasks: '任务', me: '我' };
  let currentTab = 'main';
  function switchTab(tab) {
    currentTab = tab;
    $$('.page, .page-container').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#topbar-title').textContent = TITLES[tab] || '会话';
    const cs = $('#btn-create-session'); if (cs) cs.hidden = tab !== 'main';
    const ta = $('#topbar-actions'); if (ta) ta.hidden = tab === 'me';   // 我 页不显示 加号/刷新
    if (tab === 'friends') { loadContacts(); loadP2PStatus(); }
    if (tab === 'network') { loadAgentControl(); loadApprovals(); loadNetMembers(); loadAgentServices(); loadX402Info(); }
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

  // 智能体控制 = MCP 控制 + Skills 控制 (不是屏幕触控!)
  //  - MCP 工具: 真正的工具调用 (gateway_status / join / register …)
  //  - Skills:   电脑端 ~/.bolloon/skills/ 同步下来的本机技能
  // 屏幕触控(无障碍) 挪到 设置 → 无障碍服务 (屏幕触控)。
  function mkOverlayPage(id, title, inner) {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = id;
    page.style.zIndex = '70';
    page.innerHTML = `<div class="chat-topbar">
        <button class="icon-btn" id="${id}-back">←</button>
        <div style="flex:1;font-weight:600">${escapeHtml(title)}</div>
      </div>
      <div id="${id}-body" style="padding:12px;flex:1;min-height:0;overflow:auto">${inner}</div>`;
    document.body.appendChild(page);
    page.querySelector(`#${id}-back`).addEventListener('click', () => page.remove());
    return page;
  }

  async function loadAgentControl() {
    const box = $('#agent-control');
    if (!box) return;
    const iconMcp = '<svg class="ico" viewBox="0 0 24 24"><path d="M14.5 4.5a3.5 3.5 0 0 0-4.9 4.2L4 14.3V20h5.7l5.6-5.6a3.5 3.5 0 0 0 4.2-4.9l-2.4 2.4-2.1-2.1z"/></svg>';
    const iconSkill = '<svg class="ico" viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"/><path d="M9 12h6M9 16h4M9 8h4"/></svg>';
    let tools = []; let skills = [];
    try { tools = (await api.get('/api/mcp/tools')) || []; } catch (e) { tools = []; }
    try { skills = (await api.get('/api/skills')) || []; } catch (e) { skills = []; }
    const skillSub = skills.length
      ? skills.slice(0, 3).map((s) => '/' + String(s.name || '')).join('  ')
      : '尚无本机技能 —— 点开后从电脑端同步';
    box.innerHTML = `
      <div class="list-item" id="item-mcp"><span class="list-icon">${iconMcp}</span>
        <span style="flex:1"><span style="display:block">MCP 工具 · ${tools.length} 个</span>
        <span class="conv-preview" style="display:block">点开读工具说明并调用（gateway_status / join / register / call）</span></span>
        <span class="list-arrow">›</span></div>
      <div class="list-item" id="item-skills"><span class="list-icon">${iconSkill}</span>
        <span style="flex:1"><span style="display:block">Skills · ${skills.length} 个</span>
        <span class="conv-preview" style="display:block">${escapeHtml(skillSub)}</span></span>
        <span class="list-arrow">›</span></div>`;
    const mcpEl = $('#item-mcp'); if (mcpEl) mcpEl.addEventListener('click', () => void openMcpPage(tools));
    const skEl = $('#item-skills'); if (skEl) skEl.addEventListener('click', () => void openSkillsPage());
  }

  async function openMcpPage(toolsIn) {
    if ($('#mcp-page')) return;
    const page = mkOverlayPage('mcp-page', 'MCP 工具', '<div style="font-size:12px;color:var(--text-muted)">读取中…</div>');
    let tools = toolsIn;
    if (!Array.isArray(tools) || !tools.length) {
      try { tools = (await api.get('/api/mcp/tools')) || []; } catch (e) { tools = []; }
    }
    const body = page.querySelector('#mcp-page-body');
    if (!tools.length) { body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">没有可用的 MCP 工具</div>'; return; }
    body.innerHTML = tools.map((t, i) => `<div class="conv-item" data-ti="${i}">
        <div class="conv-avatar">${escapeHtml(String(t.name || 'M').charAt(0))}</div>
        <div class="conv-body"><div class="conv-name">${escapeHtml(String(t.name || ''))}</div>
        <div class="conv-preview">${escapeHtml(String(t.description || ''))}</div></div></div>`).join('')
      + '<div style="font-size:11px;color:var(--text-muted);margin-top:12px;line-height:1.7">点一下 = 让本机智能体调用该工具（gateway_* 需要先加入 Agent 网络）</div>';
    body.querySelectorAll('[data-ti]').forEach((el) => el.addEventListener('click', () => void runMcpTool(tools[Number(el.dataset.ti)])));
  }

  async function runMcpTool(t) {
    const name = String((t && t.name) || '');
    if (!name) return;
    let args = {};
    try {
      if (name === 'gateway_join') {
        const link = prompt('gateway_join 需要网络链接：\norbitdb://… 或 ipns://… 或 https://…/registry', '');
        if (!link) return;
        args = { link };
      } else if (name === 'gateway_register') {
        const svc = prompt('注册为服务提供者，填一个服务名（例如 手机端助手）：', '');
        if (!svc) return;
        let agentId = '';
        try { const id2 = await api.get('/api/auth/status'); agentId = (id2 && (id2.agentId || id2.did)) || ''; } catch (e) { agentId = ''; }
        if (!agentId) { alert('还没有身份（我 → 登录），无法注册为服务提供者'); return; }
        args = { self: { agentId, name: svc, service: { name: svc } } };
      } else if (name === 'gateway_call') {
        const svc = prompt('要调用的服务（名称或 agentId）：', '');
        if (!svc) return;
        args = { service: svc };
      }
      const r = await api.post('/api/mcp/call', { name, args });
      const ok = r && r.ok !== false;
      alert(`${name} ${ok ? '✔' : '✘'}\n\n${(r && r.output) || JSON.stringify(r)}`);
      void loadAgentControl();
    } catch (e) {
      alert(`${name} 调用失败：${(e && e.message) || e}`);
    }
  }

  async function openSkillsPage() {
    if ($('#skills-page')) return;
    const page = mkOverlayPage('skills-page', 'Skills', '<div style="font-size:12px;color:var(--text-muted)">读取中…</div>');
    const bar = document.createElement('div');
    bar.style.cssText = 'padding:0 12px 14px';
    bar.innerHTML = '<button id="skills-sync" style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--border);background:var(--bg-hover);color:var(--accent);font-size:14px">从电脑端同步</button>';
    page.appendChild(bar);
    const render = async () => {
      let skills = []; let err = '';
      try { skills = (await api.get('/api/skills')) || []; } catch (e) { skills = []; err = (e && e.message) || ''; }
      const body = page.querySelector('#skills-page-body');
      if (!body) return;
      if (!skills.length) {
        body.innerHTML = `<div style="padding:18px 8px;text-align:center;color:var(--text-muted);line-height:1.8">
          还没有技能列表<br><span style="font-size:12px">电脑端 ~/.bolloon/skills/ 下的 skills，会在「从电脑端同步」后出现在这里</span>
          ${err ? `<div style="font-size:11px;margin-top:8px">（读取失败：${escapeHtml(err)}）</div>` : ''}</div>`;
        return;
      }
      body.innerHTML = skills.map((s, i) => `<div class="conv-item" data-sk="${i}">
          <div class="conv-avatar">${escapeHtml(String(s.name || 'S').charAt(0).toUpperCase())}</div>
          <div class="conv-body"><div class="conv-name">/${escapeHtml(String(s.name || ''))}</div>
          <div class="conv-preview">${escapeHtml(String(s.description || '（无说明）').slice(0, 60))}</div></div></div>`).join('')
        + `<div style="font-size:11px;color:var(--text-muted);margin-top:12px">共 ${skills.length} 个 · 来自电脑端 ~/.bolloon/skills/</div>`;
      body.querySelectorAll('[data-sk]').forEach((el) => el.addEventListener('click', () => {
        const s = skills[Number(el.dataset.sk)] || {};
        alert(`/${s.name || ''}\n\n${s.description || '（无说明）'}`);
      }));
    };
    await render();
    const btn = page.querySelector('#skills-sync');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true; const old = btn.textContent; btn.textContent = '同步中…';
      try {
        const r = await api.post('/api/desktop/sync');
        if (r && r.ok === false) { alert('同步失败：' + (r.error || '未知错误')); }
        else { alert('同步完成' + (r && r.counts ? '：' + JSON.stringify(r.counts) : '')); }
      } catch (e) { alert('同步失败：' + ((e && e.message) || e)); }
      finally { btn.disabled = false; btn.textContent = old; await render(); }
    });
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
  let chatLoadPromise = Promise.resolve();   // openChat 的首次历史加载 (供一键入网等自动发消息等它完成, 免被清屏抹掉)

  function fmtAgo(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  // 左上角「索引」: 最近历史会话 (本机 IndexedDB 里的 sessions, 按更新时间倒序)
  async function openIndexPanel() {
    if ($('#index-page')) return;
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'index-page';
    page.style.zIndex = '70';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="index-back">←</button>
        <div style="flex:1;font-weight:600">索引 · 最近会话</div>
        <button class="icon-btn" id="index-settings" title="设置">⚙</button>
      </div>
      <div id="index-body" style="padding:12px;flex:1;min-height:0;overflow:auto">
        <div style="font-size:12px;color:var(--text-muted)">读取最近会话…</div>
      </div>`;
    document.body.appendChild(page);
    $('#index-back').addEventListener('click', () => page.remove());
    $('#index-settings').addEventListener('click', () => { page.remove(); openSettings(); });

    let snap = null;
    try { snap = await api.get('/api/data/snapshot'); } catch (e) { snap = null; }
    const channels = (snap && snap.channels) || [];
    const sessions = (snap && snap.sessions) || [];
    const byId = new Map();
    channels.forEach((c) => byId.set(c.id, c));
    const rows = sessions.map((s) => {
      const msgs = s.messages || [];
      const last = msgs[msgs.length - 1];
      return {
        ch: byId.get(s.channelId) || { id: s.channelId, name: '（会话已删除）' },
        updatedAt: s.updatedAt || (last && last.ts) || 0,
        count: msgs.length,
        lastText: (last && last.content) || '（无消息）',
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);

    const head = `<div style="font-size:12px;color:var(--text-muted);margin:2px 0 10px">本机智能体 ${channels.length} 个 · 有历史会话 ${rows.length} 个</div>`;
    const list = rows.length
      ? rows.map((r, i) => `<div class="conv-item" data-si="${i}">
          <div class="conv-avatar">${escapeHtml(String(r.ch.name || 'A').charAt(0))}</div>
          <div class="conv-body">
            <div class="conv-name">${escapeHtml(String(r.ch.name || r.ch.id))}</div>
            <div class="conv-preview">${escapeHtml(String(r.lastText).slice(0, 40))}</div>
          </div>
          <span style="font-size:11px;color:var(--text-muted);text-align:right;flex:0 0 auto">${escapeHtml(fmtAgo(r.updatedAt))}<br>${r.count} 条</span>
        </div>`).join('')
      : '<div style="padding:24px;text-align:center;color:var(--text-muted)">还没有历史会话<br><span style="font-size:12px">从下面的 ＋ 新建一个智能体开始</span></div>';
    const body = $('#index-body');
    if (body) {
      body.innerHTML = head + list;
      body.querySelectorAll('[data-si]').forEach((el) => el.addEventListener('click', () => {
        const r = rows[Number(el.dataset.si)];
        page.remove();
        openChat(r.ch);
      }));
    }
  }

  // 右上角「搜索」: 本机智能体 + 好友 + 全局智能体 (协议发现) 一起搜
  async function openSearch() {
    if ($('#search-page')) return;
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'search-page';
    page.style.zIndex = '70';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="search-back">←</button>
        <div style="flex:1;font-weight:600">搜索</div>
      </div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0">
        <input id="search-input" type="search" autocomplete="off" placeholder="搜智能体 / 好友：名称、DID、节点 ID"
          style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-hover);color:var(--text);font-size:14px">
        <div id="search-hint" style="font-size:12px;color:var(--text-muted)">正在建立索引…</div>
        <div id="search-results" style="flex:1;overflow:auto;-webkit-overflow-scrolling:touch"></div>
      </div>`;
    document.body.appendChild(page);
    $('#search-back').addEventListener('click', () => page.remove());

    let channels = []; let peers = []; let services = [];
    try { channels = (await api.get('/channels')) || []; } catch (e) { channels = []; }
    try { const p = await api.get('/api/peers'); peers = Array.isArray(p) ? p : ((p && p.peers) || []); } catch (e) { peers = []; }
    try { const d = await api.get('/api/social/discover'); services = (d && d.services) || []; } catch (e) { services = []; }

    const rows = [
      ...channels.map((c) => ({
        tag: '本机智能体', name: c.name || c.agentId || c.id, sub: c.id || '',
        hay: [c.name, c.id, c.agentId, c.did, c.description].filter(Boolean).join(' '),
        act: () => { page.remove(); openChat(c); },
      })),
      ...peers.map((p) => ({
        tag: '好友', name: p.name || String(p.publicKey || p.id || '好友').slice(0, 12),
        sub: String(p.publicKey || p.id || p.address || '').slice(0, 28),
        hay: [p.name, p.publicKey, p.id, p.address, p.did].filter(Boolean).join(' '),
        act: () => alert(`好友信息\n名称: ${p.name || '(未命名)'}\n节点ID: ${p.publicKey || p.id || '—'}\n地址: ${p.address || '—'}`),
      })),
      ...services.map((s) => ({
        tag: '全局智能体',
        name: (s.service && s.service.name) || s.name || s.agentId || 'agent',
        sub: (s.service && s.service.description) || s.description || '',
        hay: [(s.service && s.service.name), s.serviceName, s.name, s.agentId, s.description, s.did].filter(Boolean).join(' '),
        act: () => { page.remove(); openTradeCall(s); },
      })),
    ];
    rows.forEach((r) => { r.hay = String(r.hay || '').toLowerCase(); });

    const hint = $('#search-hint');
    const box = $('#search-results');
    const render = (q) => {
      const k = String(q || '').trim().toLowerCase();
      const hits = rows.filter((r) => !k || r.hay.includes(k) || r.name.toLowerCase().includes(k));
      if (hint) hint.innerHTML = `本机智能体 ${channels.length} · 好友 ${peers.length} · 全局智能体 ${services.length}` + (k ? ` · 命中 ${hits.length}` : '');
      if (!box) return;
      if (!hits.length) {
        box.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">没有匹配「${escapeHtml(String(q))}」的智能体或好友</div>`;
        return;
      }
      let html = '';
      let lastTag = '';
      hits.forEach((r, i) => {
        if (r.tag !== lastTag) { html += `<div class="section-label">${escapeHtml(r.tag)}</div>`; lastTag = r.tag; }
        html += `<div class="conv-item" data-ri="${i}">
          <div class="conv-avatar">${escapeHtml(String(r.name || 'A').charAt(0))}</div>
          <div class="conv-body">
            <div class="conv-name">${escapeHtml(String(r.name))}</div>
            <div class="conv-preview">${escapeHtml(String(r.sub).slice(0, 48))}</div>
          </div>
        </div>`;
      });
      box.innerHTML = html;
      box.querySelectorAll('[data-ri]').forEach((el) => el.addEventListener('click', () => hits[Number(el.dataset.ri)].act()));
    };
    render('');
    const input = $('#search-input');
    if (input) { input.addEventListener('input', () => render(input.value)); input.focus(); }
  }

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
       chatLoadPromise = loadMessages().catch(() => {});
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

  /**
   * 「App 更新 (web 资源层)」页 (2026-09-26, update-protocol §13)
   *   看得见的: 当前装的是哪个源 / 哪个版本·sha / 能切回哪个源 —— 与桌面 `bolloon update --status` 同一口径。
   *   做得出的: 检查 → (智能体可自动跑到"准备并验证") → 人工确认切换 → 重载; 一键回滚。
   *   说不出的不说: 原生壳层不能在这里自更 (iOS 走商店/TestFlight, Android 侧载需允许未知来源)。
   */
  async function openUpdatePage() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'update-page';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="update-back">←</button>
        <div style="flex:1;font-weight:600">App 更新</div>
        <button class="icon-btn" id="update-check" title="检查更新">↻</button>
      </div>
      <div style="padding:12px;overflow:auto">
        <pre id="update-identity" style="white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;background:var(--bg-2,#0001);padding:10px;border-radius:10px;margin:0 0 10px">读取中…</pre>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="conv-item" id="update-ch-stable" style="flex:1;justify-content:center">stable (npm)</button>
          <button class="conv-item" id="update-ch-dev" style="flex:1;justify-content:center">dev (GitHub master)</button>
        </div>
        <div class="conv-item" id="update-apply"><span class="list-icon">${ICONS.chip}</span><span style="flex:1;min-width:0"><span style="display:block">安装更新（需要你确认）</span><span class="conv-preview" style="display:block" id="update-apply-sub">先点右上角 ↻ 检查</span></span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="update-rollback"><span class="list-icon">${ICONS.trash}</span><span style="flex:1;min-width:0"><span style="display:block">回滚到上一份</span><span class="conv-preview" style="display:block">装坏了就换回上一次能用的资源</span></span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="update-reload"><span class="list-icon">${ICONS.themeAuto}</span><span>重载界面让更新生效</span></div>
        <div id="update-ceiling" style="font-size:12px;line-height:1.6;color:var(--fg-2,#888);margin:10px 0"></div>
        <pre id="update-log" style="white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;margin:0"></pre>
      </div>`;
    document.body.appendChild(page);

    const identityEl = page.querySelector('#update-identity');
    const logEl = page.querySelector('#update-log');
    const applySub = page.querySelector('#update-apply-sub');
    const ceilingEl = page.querySelector('#update-ceiling');
    let lastCheck = null;

    const log = (line) => { logEl.textContent += `${line}\n`; logEl.scrollTop = logEl.scrollHeight; };
    const UP = () => (window.BolloonCore && window.BolloonCore.update) || null;
    const setIdentity = async () => {
      const up = UP();
      if (!up) { identityEl.textContent = '内核未就绪'; return; }
      const voc = up.vocabulary();
      ceilingEl.textContent = voc.nativeCeiling;
      const st = await up.state();
      const applied = st.installedChannel ? `${st.installedChannel}${st.installedDevSha ? ` @ ${st.installedDevSha}` : ''}` : '（还没用这个功能装过）';
      identityEl.textContent = [
        `当前装的:   ${applied}`,
        `通道偏好:   ${up.channel()}`,
        `能切回:     ${st.switchableTo ? `${st.switchableTo.channel} (${st.switchableTo.source}${st.switchableTo.target ? ` @ ${st.switchableTo.target}` : ''})` : '—'}`,
        `上次来源:   ${st.installedFrom ? `${st.installedFrom.source}${st.installedFrom.digest ? ` · ${st.installedFrom.digest}` : ''}` : '—'}`,
        `更新层:     web 资源层（界面与逻辑：入群 / 发任务公告 / 看飞轮进度 / 授权签名）`,
        `会生效吗:   ${up.nativeWired() ? '会（原生壳已指向可写目录）' : '不会 —— 原生壳还没指向可写目录，装了也不生效，所以不会切换'}`,
      ].join('\n');
    };
    const runCheck = async () => {
      const up = UP();
      if (!up) { log('内核未就绪'); return; }
      log('· 检查两源（npm + GitHub）…');
      const r = await up.report({});
      lastCheck = r.result;
      identityEl.textContent = r.lines.join('\n');
      applySub.textContent = r.result.status === 'update_available'
        ? `可装: ${r.result.targetIdentity || r.result.latestVersion}` : `结论: ${r.result.status}`;
      log(`· 结论: ${r.result.status}${r.result.reason ? ` — ${r.result.reason}` : ''}`);
      if (r.result.warnings && r.result.warnings.length) r.result.warnings.forEach((w) => log(`  ⚠ ${w}`));
      await setIdentity();
    };

    page.querySelector('#update-back').addEventListener('click', () => { page.remove(); void openSettings(); });
    page.querySelector('#update-check').addEventListener('click', () => { logEl.textContent = ''; void runCheck(); });
    page.querySelector('#update-ch-stable').addEventListener('click', async () => { const r = await UP().setChannel('stable'); log(`· ${r.detail}`); await setIdentity(); });
    page.querySelector('#update-ch-dev').addEventListener('click', async () => { const r = await UP().setChannel('dev'); log(`· ${r.detail}`); await setIdentity(); });
    page.querySelector('#update-apply').addEventListener('click', async () => {
      const up = UP();
      if (!up) return;
      const target = lastCheck && (lastCheck.targetIdentity || lastCheck.latestVersion);
      if (!lastCheck || lastCheck.status !== 'update_available') { log('· 先检查更新（右上角 ↻）：现在没有可装的目标，或源不可达/交叉校验不一致 —— 拒绝安装。'); return; }
      // 人在环: 说清要换的是哪一层, 再动手
      if (!confirm(`要装 ${target} 吗？\n\n换的是「web 资源层」（界面与逻辑）。装完需要重载界面才生效；装坏了可以一键回滚。\n原生壳层（二进制）不在这里更新。`)) return;
      log('· 准备并验证 …');
      const prep = await up.prepare({ onStage: (s, d) => log(`    [${s}] ${d}`) });
      if (!prep.ok) { log(`· 准备/验证失败: ${prep.status} — ${prep.reason}`); return; }
      log(`· 已验证 ${prep.to}（${prep.fileCount} 个文件）—— 现在切换`);
      const out = await up.apply({ confirm: true, reuseStaging: true, onStage: (s, d) => log(`    [${s}] ${d}`) });
      log(out.ok ? `· 成功: ${out.from} → ${out.to}（重载界面后生效）` : `· 未生效 (${out.stage}): ${out.reason}`);
      applySub.textContent = out.ok ? '已装好 · 点「重载界面」生效' : `未生效: ${out.status}`;
      await setIdentity();
    });
    page.querySelector('#update-rollback').addEventListener('click', async () => {
      const up = UP();
      if (!up) return;
      if (!confirm('换回上一份能用的 web 资源吗？（当前这一份会被替换掉）')) return;
      const out = await up.rollback({ confirm: true, onStage: (s, d) => log(`    [${s}] ${d}`) });
      log(out.ok ? `· 已回滚到 ${out.to}` : `· 回滚未执行 (${out.stage}): ${out.reason}`);
      await setIdentity();
    });
    page.querySelector('#update-reload').addEventListener('click', async () => {
      const r = await UP().reload();
      log(`· ${r.detail}（方式: ${r.how}）`);
    });

    await setIdentity();
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
        <div class="conv-item" id="settings-update"><span class="list-icon">${ICONS.themeAuto}</span><span style="flex:1;min-width:0"><span style="display:block">App 更新（web 资源层）</span><span class="conv-preview" style="display:block" id="update-preview">读取中…</span></span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-data"><span class="list-icon">${ICONS.chip}</span><span style="flex:1;min-width:0"><span style="display:block">本机数据</span><span class="conv-preview" style="display:block">读取中…</span></span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-desktop"><span class="list-icon">${ICONS.globe}</span><span>电脑端同步</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-chain"><span class="list-icon">${ICONS.chip}</span><span>链上配置 (RPC/网络)</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-accessibility"><span class="list-icon">${ICONS.globe}</span><span>完全访问权限<span class="conv-preview" style="display:block" id="access-preview">默认开启</span></span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-ipfs"><span class="list-icon">${ICONS.chip}</span><span>IPFS 存储</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-helia"><span class="list-icon">${ICONS.globe}</span><span>本机 IPFS 节点</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-selfcard"><span class="list-icon">${ICONS.chip}</span><span id="selfcard-text">显示本机卡片: 开</span></div>
        <div class="conv-item" id="settings-did"><span class="list-icon">${ICONS.idcard}</span><span>DID</span></div>
        <div class="conv-item" id="settings-privacy"><span class="list-icon">${ICONS.chip}</span><span>隐私政策与个人信息</span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-wipe"><span class="list-icon">${ICONS.trash}</span><span style="flex:1;min-width:0"><span style="display:block">清除本机数据（注销）</span><span class="conv-preview" style="display:block">删除本机身份、智能体、会话与钱包</span></span><span class="list-arrow">›</span></div>
        <div class="conv-item" id="settings-filing"><span class="list-icon">${ICONS.idcard}</span><span id="filing-text">APP 备案号：备案办理中</span></div>
      </div>`;
    document.body.appendChild(page);
    applyTheme(resolveThemePref(), false);
    $('#settings-back').addEventListener('click', () => page.remove());
    $('#api-config-item').addEventListener('click', openApiConfig);
    // App 更新: 预览里就说清"现在装的是哪个源 / 哪个版本·sha / 能切回谁"(= 桌面 update --status 同一口径)
    $('#settings-update').addEventListener('click', () => { page.remove(); void openUpdatePage(); });
    void (async () => {
      const el = page.querySelector('#update-preview');
      if (!el) return;
      try {
        const up = window.BolloonCore && window.BolloonCore.update;
        if (!up) { el.textContent = '内核未就绪'; return; }
        const st = await up.state();
        const applied = st.installedChannel
          ? `${st.installedChannel}${st.installedDevSha ? ` @ ${st.installedDevSha}` : ''}`
          : '内置资源';
        const back = st.switchableTo ? ` · 能切回 ${st.switchableTo.channel}` : '';
        el.textContent = `当前 ${applied}${back} · 通道 ${up.channel()}${up.nativeWired() ? '' : ' · 原生壳未接通'}`;
      } catch (e) { el.textContent = '读取失败: ' + ((e && e.message) || e); }
    })();
    $('#theme-toggle').addEventListener('click', () => {
      const next = currentTheme === 'auto' ? 'light' : (currentTheme === 'light' ? 'dark' : 'auto');
      applyTheme(next, true);
    });
    // 完全访问权限 (屏幕点按/滑动, 电脑端 phone.tap / phone.swipe 的前提) — 默认开启
    const ACCESS_AUTO_KEY = 'bolloon_access_auto_guided';
    const refreshAccessPreview = async () => {
      const el = document.querySelector('#access-preview');
      if (!el) return;
      const cap = window.Capacitor;
      const b = cap && cap.Plugins && cap.Plugins.RokidBridge;
      if (!b) { el.textContent = '仅手机 App'; return; }
      let st = {};
      try { st = (await b.touchStatus()) || {}; } catch (e) { st = {}; }
      el.textContent = st.ready ? '已开启' : '未开启 · 点这里开';
    };
    void refreshAccessPreview();
    // 默认开启: 首次启动自动把用户带到系统开关页 (只引导一次, 不反复打扰)
    void (async () => {
      try {
        const cap = window.Capacitor;
        const b = cap && cap.Plugins && cap.Plugins.RokidBridge;
        if (!b) return;
        let st = {};
        try { st = (await b.touchStatus()) || {}; } catch (e) { return; }
        if (st.ready) return;
        if (localStorage.getItem(ACCESS_AUTO_KEY) === '1') return;
        localStorage.setItem(ACCESS_AUTO_KEY, '1');
        await b.openAccessibilitySettings();
      } catch (e) {}
    })();
    $('#settings-accessibility').addEventListener('click', async () => {
      const cap = window.Capacitor;
      const bridge = cap && cap.Plugins && cap.Plugins.RokidBridge;
      if (!bridge) { alert('完全访问权限只在手机 App 里有：电脑端 / 网页版没有这项。'); return; }
      let st = {};
      try { st = (await bridge.touchStatus()) || {}; } catch (e) { st = {}; }
      if (st.ready) { alert('完全访问权限已开启：智能体可以在这台手机上点按、滑动屏幕（电脑端也能远程帮你点）。\n\n想关掉：系统设置 → 辅助功能 → 已开启的服务 → Bolloon Agent，关掉即可。'); return; }
      try {
        alert('马上打开系统设置，把「Bolloon Agent」的完全访问权限打开。\n（这一项在有些手机叫「辅助功能」，有些叫「无障碍」，指同一个开关；打开后一直有效，随时可以关掉。）');
        await bridge.openAccessibilitySettings();
        void refreshAccessPreview();
      }
      catch (e) { alert('没打开成功，请手动去：系统设置 → 辅助功能 → 已开启的服务 → Bolloon Agent，打开即可。'); }
    });

    // 本机数据: 直接读 IndexedDB 快照 (智能体/会话/消息都在本机, 重开 App 不会丢)
    const dataEl = $('#settings-data');
    if (dataEl) {
      const subEl = dataEl.querySelector('.conv-preview');
      void (async () => {
        try {
          const snap = await api.get('/api/data/snapshot');
          const chs = (snap && snap.channels) || [];
          const ses = (snap && snap.sessions) || [];
          const msgs = ses.reduce((n, s) => n + ((s.messages || []).length), 0);
          if (subEl) subEl.textContent = `已保存 ${chs.length} 个智能体 · ${ses.length} 个会话 · ${msgs} 条消息（本机 IndexedDB）`;
        } catch (e) { if (subEl) subEl.textContent = '读取失败: ' + ((e && e.message) || e); }
      })();
      dataEl.addEventListener('click', () => {
        const sp = $('#settings-page'); if (sp) sp.remove();
        void openIndexPanel();
      });
    }
    $('#settings-desktop').addEventListener('click', openDesktopSync);
    // 隐私政策 (双入口之一: 设置页; 另一个是首启同意门)
    const privacyRow = $('#settings-privacy');
    if (privacyRow) privacyRow.addEventListener('click', openPrivacyPolicy);
    // 注销: 清除本机数据
    const wipeRow = $('#settings-wipe');
    if (wipeRow) wipeRow.addEventListener('click', () => { void wipeLocalDataFlow(); });
    // 备案号展示 (未备案时如实显示"备案办理中", 不伪造编号)
    const filingRow = $('#settings-filing');
    if (filingRow) {
      const ft = $('#filing-text');
      const ptxt = privacyCore() && privacyCore().filingText ? privacyCore().filingText() : '';
      if (ft && ptxt) ft.textContent = ptxt;
      filingRow.addEventListener('click', () => { const pp = privacyCore(); alert((pp && pp.filingText ? pp.filingText() : 'APP 备案号：备案办理中') + '\n\n备案信息以工信部备案系统公示为准。'); });
    }
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

  // === 模型配置 (供应商 / 模型 / 地址) ===
  //
  // 2026-09-26 (模型链路升级 P6 的手机侧): 这一页**只显示与触发**, 自己不算配置 ——
  // 唯一事实来自桌面端的模型端点 (与 CLI `/model` / Web 桌面页**同一份**):
  //
  //   当前真实生效   GET  /api/models/providers             → body.effective
  //                       (provider · model · baseUrl · scope · configHash)
  //   目录 + 来源    GET  /api/models/options?provider=<id> → body.catalog.origin
  //                       (live | cached | curated | custom | unavailable)
  //   刷新发现       POST /api/models/discover {action:'refresh', provider}
  //   手输模型       POST /api/models/discover {action:'admit',   provider, model}
  //
  // 纪律: **不回读 /api/llm-config 自己拼 activeProvider/providers 来显示"生效配置"** —— 那是
  //   第二套读配置逻辑, 与服务端早晚漂移。下面 `localCfg` 只喂"编辑表单"和"保存"(写路径),
  //   展示层一个字都不从它取; 拿不到桌面端就如实说"显示不了", 不猜不编。
  //
  // 注意: 手机端 RemoteLlm 走 OpenAI 兼容协议 (baseUrl + /chat/completions) —— 自定义 provider
  // 必须是 OpenAI 兼容端点 (gemini 用 /v1beta/openai, 智谱 v4 / dashscope compatible-mode 都兼容)。
  const ORIGIN_LABEL = {
    live: '实时发现 (live)', cached: '缓存发现 (cached)', curated: '内置清单 (curated)',
    custom: '自定义 (custom)', unavailable: '不可用 (unavailable)',
  };
  const LLM_PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
    { id: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash' },
    { id: 'xai', label: 'Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-2-latest' },
    { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
    { id: 'moonshot', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-M2.7' },
    { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    { id: 'custom', label: '自定义', baseUrl: '', model: '' },
  ];
  const LLM_BY_ID = LLM_PROVIDERS.reduce((m, p) => (m[p.id] = p, m), {});

  /** configHash 只显示前 8 位 (完整值在桌面端 / Run 快照里, 手机屏不需要 64 位) */
  function shortConfigHash(h) {
    const s = String(h == null ? '' : h);
    return s ? s.slice(0, 8) : '—';
  }

  /** 目录来源标记 → 人话 (认不出来就原样回显, 不编) */
  function originLabel(origin) {
    const k = String(origin || '');
    return ORIGIN_LABEL[k] || (k ? k : '—');
  }

  /** 电脑端基址 (设置里填; 手机自足模式拿不到就如实说, 不假装成功) */
  async function modelApiGet(path) {
    const base = await desktopBaseUrl();
    if (!base) return { ok: false, error: '未接电脑端 —— 设置 → 电脑端同步 里填桌面地址后可看' };
    const r = await desktopFetch(path);
    if (r === null) return { ok: false, error: '电脑端不可达或返回非 200' };
    return { ok: true, data: r };
  }
  async function modelApiPost(path, body) {
    const base = await desktopBaseUrl();
    if (!base) return { ok: false, error: '未接电脑端 —— 设置 → 电脑端同步 里填桌面地址后可看' };
    return await desktopPostRaw(path, body);       // 保留后端错误原文
  }

  async function openApiConfig() {
    const page = document.createElement('div');
    page.className = 'chat-page';
    page.id = 'api-config-page';
    // 编辑表单的本地草稿 (写路径) —— 展示层不读它
    let localCfg = null;
    try { localCfg = await api.get('/api/llm-config'); } catch (e) { localCfg = null; }
    if (!localCfg || !localCfg.providers) localCfg = { activeProvider: 'deepseek', providers: {}, updatedAt: Date.now() };
    const _in = 'width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text);box-sizing:border-box';
    const _btn = 'padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-hover);color:var(--text)';
    page.innerHTML = `
      <div class="chat-topbar">
        <button class="icon-btn" id="api-config-back">←</button>
        <div style="flex:1;font-weight:600">模型配置</div>
      </div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:12px;overflow:auto">
        <div class="section-label">当前真实生效 (电脑端 /api/models/providers)</div>
        <div id="api-eff-card" style="padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);display:flex;flex-direction:column;gap:6px">
          <div style="font-size:13px">供应商: <b id="api-eff-provider">读取中…</b></div>
          <div style="font-size:13px">模型: <b id="api-eff-model">—</b></div>
          <div style="font-size:12px;color:var(--text-secondary);word-break:break-all">地址: <span id="api-eff-baseurl">—</span></div>
          <div style="font-size:12px;color:var(--text-secondary)">来源(scope): <span id="api-eff-scope">—</span> · 配置指纹: <span id="api-eff-hash">—</span></div>
          <div id="api-eff-note" style="font-size:12px;color:var(--text-muted)"></div>
        </div>

        <div class="section-label">模型目录 (电脑端 /api/models/options)</div>
        <div id="api-catalog-origin" style="font-size:13px">—</div>
        <div id="api-catalog-head" style="font-size:12px;color:var(--text-secondary)"></div>
        <div id="api-catalog-list" style="font-size:12px;color:var(--text-secondary);max-height:170px;overflow:auto;word-break:break-all"></div>
        <div id="api-catalog-note" style="font-size:12px;color:var(--text-muted)"></div>
        <button id="api-discover-refresh" style="${_btn}">刷新发现</button>
        <div style="display:flex;gap:8px">
          <input id="api-manual-model" placeholder="手输模型名 (目录里没有的)" style="flex:1;${_in}">
          <button id="api-manual-admit" style="${_btn}">加入目录</button>
        </div>
        <div id="api-discover-result" style="font-size:12px;color:var(--text-secondary)"></div>

        <div class="section-label">供应商 / 端点 / 凭据 (本机保存) <span id="api-provider-count" style="opacity:.55"></span></div>
        <div class="provider-chips" id="api-provider-chips"></div>
        <div id="api-hint" style="font-size:12px;color:var(--text-muted)"></div>
        <input id="api-baseurl" placeholder="https://api.xxx.com/v1" style="${_in}">
        <input id="api-key" type="password" placeholder="sk-..." style="${_in}">
        <input id="api-model" placeholder="模型名" style="${_in}">
        <button id="api-save" style="padding:12px;border:none;border-radius:10px;background:var(--accent);color:var(--bg);font-weight:700">保存配置</button>
      </div>`;
    document.body.appendChild(page);
    $('#api-config-back').addEventListener('click', () => page.remove());
    const setText = (sel, v) => { const el = page.querySelector(sel); if (el) el.textContent = String(v == null ? '' : v); };

    // ── ① 当前真实生效: 只认服务端 effective ──────────────────────────
    let lastProviders = null;
    async function paintEffective() {
      const r = await modelApiGet('/api/models/providers');
      if (!r.ok) {
        setText('#api-eff-provider', '—'); setText('#api-eff-model', '—');
        setText('#api-eff-baseurl', '—'); setText('#api-eff-scope', '—'); setText('#api-eff-hash', '—');
        setText('#api-eff-note', '读不到生效配置: ' + r.error);
        return null;
      }
      const eff = r.data && r.data.effective;
      if (!eff) {
        setText('#api-eff-note', '电脑端没给出 effective (不猜: 不显示任何默认值)');
        return r.data;
      }
      setText('#api-eff-provider', eff.provider);
      setText('#api-eff-model', eff.model || '—');
      setText('#api-eff-baseurl', eff.baseUrl || '—');
      setText('#api-eff-scope', eff.scope || eff.source || '—');
      setText('#api-eff-hash', shortConfigHash(eff.configHash));
      setText('#api-eff-note', '协议 ' + (eff.protocol || '?') + ' · 凭据 ' + (eff.authRef || 'none')
        + ' · 指纹前 8 位 (完整值见电脑端 Run 快照)');
      return r.data;
    }

    // ── ② 目录 + 来源标记 ────────────────────────────────────────────
    let picked = (localCfg.activeProvider && LLM_BY_ID[localCfg.activeProvider]) ? localCfg.activeProvider : 'deepseek';
    async function paintCatalog() {
      setText('#api-catalog-origin', '来源: 读取中…');
      setText('#api-catalog-head', ''); setText('#api-catalog-list', ''); setText('#api-catalog-note', '');
      const r = await modelApiGet('/api/models/options?provider=' + encodeURIComponent(picked));
      if (!r.ok) { setText('#api-catalog-origin', '来源: —'); setText('#api-catalog-note', '读不到目录: ' + r.error); return; }
      const d = r.data || {};
      const cat = d.catalog || null;
      setText('#api-catalog-origin', '来源: ' + originLabel(cat && cat.origin));
      const models = Array.isArray(d.models) ? d.models : [];
      setText('#api-catalog-head', String(d.count == null ? models.length : d.count) + ' 个模型'
        + (cat && cat.stale ? ' · 缓存已过期' : '')
        + (cat && cat.discoveryFailed ? ' · 上游发现失败' : ''));
      const listEl = page.querySelector('#api-catalog-list');
      if (listEl) {
        listEl.innerHTML = models.slice(0, 40).map((m) => {
          const id = escapeHtml(String((m && (m.id || m.name)) || ''));
          const tool = (m && m.toolCalling) ? ' · 工具调用 ' + escapeHtml(String(m.toolCalling)) : '';
          return '<div>' + id + tool + '</div>';
        }).join('') || '(空目录)';
      }
      if (cat && cat.failure) {
        const f = cat.failure;
        setText('#api-catalog-note', '上游失败类目: ' + String(f.failureClass || f.class || f.message || JSON.stringify(f)).slice(0, 160));
      }
    }

    // ── ③ 供应商芯片 (名字/可用性来自服务端 providers, 不是本机硬编码表) ──
    function paintChips() {
      const box = page.querySelector('#api-provider-chips');
      if (!box) return;
      const rows = (lastProviders && Array.isArray(lastProviders.providers) && lastProviders.providers.length)
        ? lastProviders.providers.map((p) => ({ id: String(p.id), label: String(p.name || p.id), configured: p.configured !== false, current: p.current === true, isLocal: p.isLocal === true }))
        : LLM_PROVIDERS;
      box.innerHTML = rows.map((p) => `<button type="button" class="provider-chip${p.id === picked ? ' active' : ''}" data-provider="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`).join('');
      const cn = page.querySelector('#api-provider-count');
      if (cn) {
        const ready = rows.filter((p) => p.configured !== false).length;
        cn.textContent = '（' + ready + ' / ' + rows.length + ' 家可用凭据就绪）';
      }
    }
    function fillFrom(id) {
      const saved = (localCfg.providers && localCfg.providers[id]) || {};
      const d = LLM_BY_ID[id] || {};
      const row = lastProviders && Array.isArray(lastProviders.providers) ? lastProviders.providers.find((x) => String(x.id) === String(id)) : null;
      $('#api-baseurl').value = saved.baseUrl || (row && row.baseUrl) || d.baseUrl || '';
      $('#api-model').value = saved.model || (row && row.configuredModel) || d.model || '';
      $('#api-key').value = saved.apiKey || '';
      const hint = $('#api-hint');
      if (hint) {
        hint.textContent = id === 'custom'
          ? '自定义: 填任意 OpenAI 兼容的 baseUrl (/chat/completions)'
          : (saved.apiKey ? '该供应商已保存过 key（改完记得再点保存）'
                          : '填官方文档里的 API key; 保存后本机智能体就走它');
      }
    }
    page.querySelector('#api-provider-chips').addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.provider-chip');
      if (!b) return;
      picked = b.dataset.provider;
      paintChips();
      fillFrom(picked);
      void paintCatalog();
    });

    // ── ④ 刷新发现 / ⑤ 手输模型 (都打在服务端唯一入口上) ─────────────
    page.querySelector('#api-discover-refresh').addEventListener('click', async () => {
      setText('#api-discover-result', '刷新中…');
      const r = await modelApiPost('/api/models/discover', { action: 'refresh', provider: picked, force: true });
      if (r && r.ok === false) { setText('#api-discover-result', '刷新失败: ' + String(r.error || r.message || '').slice(0, 200)); return; }
      setText('#api-discover-result', '刷新完成 · 来源 ' + originLabel(r && r.catalog && r.catalog.origin));
      await paintCatalog();
    });
    page.querySelector('#api-manual-admit').addEventListener('click', async () => {
      const model = String($('#api-manual-model').value || '').trim();
      if (!model) { setText('#api-discover-result', '先填一个模型名'); return; }
      const r = await modelApiPost('/api/models/discover', { action: 'admit', provider: picked, model });
      if (r && r.ok === false) { setText('#api-discover-result', '加入失败: ' + String(r.error || r.message || '').slice(0, 200)); return; }
      setText('#api-discover-result', '已加入目录: ' + model);
      await paintCatalog();
    });

    // ── ⑥ 编辑表单保存 (写路径, 与从前同一口) ─────────────────────────
    $('#api-save').addEventListener('click', async () => {
      const p = picked;
      const next = (localCfg && localCfg.providers) ? localCfg : { activeProvider: localCfg.activeProvider, providers: {}, updatedAt: Date.now() };
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

    // 启动: 先画芯片(服务端清单) → 再画生效卡片与目录
    lastProviders = await paintEffective();
    paintChips();
    fillFrom(picked);
    await paintCatalog();
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

  /**
   * 一键入网 (全球智能体网络): 把默认 prompt 发给智能体, 由它读网关入网说明并执行入网。
   * 人类只点一下 — 没有可用会话时先建一个 (与"新建会话"同一条路径)。
   */
  async function joinGlobalNetwork() {
    showToast('正在加入全球智能体网络…');
    try {
      let ch = activeChannel;
      if (!ch) {
        let channels = [];
        try { channels = await api.get('/channels'); } catch { channels = []; }
        ch = (Array.isArray(channels) && channels[0]) || null;
        if (!ch) {
          await api.post('/api/channels/create', {});
          await new Promise((r) => setTimeout(r, 700));
          channels = await api.get('/channels').catch(() => []);
          ch = (Array.isArray(channels) && channels[0]) || null;
        }
      }
      if (!ch) { showToast('没有可用会话: 先在电脑端连上你的智能体'); return; }
      openChat(ch);
      await chatLoadPromise;   // 等首次历史加载完成再发, 免得用户气泡被清屏抹掉
      const input = $('#chat-input');
      if (!input) return;
      input.value = DEFAULT_JOIN_PROMPT;
      await sendChat();
      showToast('入网指令已交给智能体');
    } catch (e) {
      showToast('入网失败: ' + ((e && e.message) || e));
    }
  }

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
    const bIdx = $('#btn-index'); if (bIdx) bIdx.addEventListener('click', () => void openIndexPanel());
    const bSearch = $('#btn-search'); if (bSearch) bSearch.addEventListener('click', () => void openSearch());
    const cs = $('#btn-create-session'); if (cs) cs.addEventListener('click', createSession);
    const csScan = $('#choice-scan'); if (csScan) csScan.addEventListener('click', addFriendScan);
    const csMan = $('#choice-manual'); if (csMan) csMan.addEventListener('click', addFriendManual);
    const csCan = $('#choice-cancel'); if (csCan) csCan.addEventListener('click', () => hideSheet('#addfriend-sheet'));
    $('#item-p2p').addEventListener('click', () => { switchTab('friends'); void loadContacts(); });
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
    // #1 一键入网 (全球智能体网络): 点一下 → 默认 prompt 交给智能体执行
    const joinGlobalBtn = $('#item-join-global');
    if (joinGlobalBtn) joinGlobalBtn.addEventListener('click', () => { void joinGlobalNetwork(); });

    // #2 加入网络 (点按式): sheet → [附近的电脑/设备] [扫电脑上的二维码] [粘贴链接兜底]
    const joinNetBtn = $('#item-join-net');
    if (joinNetBtn) joinNetBtn.addEventListener('click', () => showSheet('#network-sheet'));
    const cJoinNearby = $('#choice-join-nearby');
    if (cJoinNearby) cJoinNearby.addEventListener('click', () => { hideSheet('#network-sheet'); openNearbySheet('join'); });
    const cJoinScan = $('#choice-join-scan');
    if (cJoinScan) cJoinScan.addEventListener('click', () => {
      hideSheet('#network-sheet'); _qrMode = 'join';
      const inp = $('#qr-scan-input'); if (inp) inp.click();
    });
    const cJoinManual = $('#choice-join-manual');
    if (cJoinManual) cJoinManual.addEventListener('click', () => { hideSheet('#network-sheet'); joinNetworkManual(); });
    const cJoinCancel = $('#choice-join-cancel');
    if (cJoinCancel) cJoinCancel.addEventListener('click', () => hideSheet('#network-sheet'));

    // #2b 连接好友 (点按式) + 附近设备 + 待处理申请
    const addFriendBtn = $('#item-add-friend');
    if (addFriendBtn) addFriendBtn.addEventListener('click', () => showSheet('#addfriend-sheet'));
    const cNearby = $('#choice-nearby');
    if (cNearby) cNearby.addEventListener('click', () => { hideSheet('#addfriend-sheet'); openNearbySheet('friend'); });
    const cRequests = $('#choice-requests');
    if (cRequests) cRequests.addEventListener('click', () => { hideSheet('#addfriend-sheet'); openRequestsSheet(); });
    const nearbyBtn = $('#item-nearby');
    if (nearbyBtn) nearbyBtn.addEventListener('click', () => openNearbySheet('friend'));
    const nearbyRefresh = $('#nearby-refresh');
    if (nearbyRefresh) nearbyRefresh.addEventListener('click', () => loadNearbyList(_nearbyMode));
    const nearbyClose = $('#nearby-close');
    if (nearbyClose) nearbyClose.addEventListener('click', () => hideSheet('#nearby-sheet'));
    // 微信息 (x402 付费信息): 详情 → 购买并验真 / 只看元数据
    const x402Buy = $('#x402-buy');
    if (x402Buy) x402Buy.addEventListener('click', () => buyX402Info());
    const x402VerifyBtn = $('#x402-verify');
    if (x402VerifyBtn) x402VerifyBtn.addEventListener('click', () => verifyX402Info());
    const x402Close = $('#x402-close');
    if (x402Close) x402Close.addEventListener('click', () => hideSheet('#x402-sheet'));
    const x402ResultClose = $('#x402-result-close');
    if (x402ResultClose) x402ResultClose.addEventListener('click', () => hideSheet('#x402-result-sheet'));
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

  // ==================== 点按式联网 / 加好友 (2026-09-13) ====================
  // 人类手机习惯: 点按钮选一条, 而不是粘贴网址。粘贴/手动输入只作兜底放在最下面。
  let _nearbyMode = 'friend';   // 'join' = 加入网络 | 'friend' = 连接好友

  /** 电脑端基地址 (未配置 → 空字符串, 走本机能力) */
  async function desktopBaseUrl() {
    try {
      const u = await (window.BolloonCore && window.BolloonCore.desktop && window.BolloonCore.desktop.url && window.BolloonCore.desktop.url());
      // BolloonCore.desktop.url() 返回 { url }, 但也兼容直接返回字符串的实现 —
      // 直接 String(对象) 会得到 "[object Object]"，转发全部静默失败 (2026-09-13 修)
      const raw = (u && typeof u === 'object') ? (u.url || u.baseUrl || '') : u;
      return String(raw || '').replace(/\/+$/, '');
    } catch (e) { return ''; }
  }

  /** 转发到电脑端 HTTP (手机自足模式下拿不到就返回 null, 不假装成功) */
  async function desktopFetch(path, body) {
    const base = await desktopBaseUrl();
    if (!base) return null;
    try {
      const res = await fetch(base + path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : undefined);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }

  /** 加入网络 · 手动粘贴 (兜底入口, 从 sheet 底部小字进来) */
  async function joinNetworkManual() {
    const link = (window.prompt && window.prompt('粘贴网络链接\n(orbitdb://  ipns://  https://.../registry)') || '').trim();
    if (!link) return;
    try {
      const r = await (window.BolloonCore && window.BolloonCore.gateway && window.BolloonCore.gateway.join(link));
      alert(r ? (r.output || '已处理') : 'BolloonCore.gateway 不可用');
    } catch (e) { alert('加入失败: ' + String((e && e.message) || e).slice(0, 120)); }
    loadNetMembers();
  }

  function openNearbySheet(mode) {
    _nearbyMode = mode;
    const t = $('#nearby-title');
    if (t) t.textContent = mode === 'join' ? '附近的电脑 / 设备' : '附近的设备';
    showSheet('#nearby-sheet');
    loadNearbyList(mode);
  }

  /** 扫一遍"附近": 电脑端 (同一 Wi-Fi) + 已连通的 P2P 设备 (+ 待处理申请) */
  async function loadNearbyList(mode) {
    const list = $('#nearby-list');
    const hint = $('#nearby-hint');
    if (!list) return;
    list.innerHTML = '';
    if (hint) hint.textContent = '正在查找...';
    const rows = [];
    try {
      const addrs = await (window.BolloonCore && window.BolloonCore.network && window.BolloonCore.network.desktopAddrs());
      const base = await desktopBaseUrl();
      const firstAddr = (addrs && Array.isArray(addrs.addrs) && addrs.addrs[0]) || '';
      if (base || firstAddr) {
        rows.push({
          icon: '🖥️',
          title: '电脑端' + (addrs && addrs.peerId ? ' · ' + String(addrs.peerId).slice(0, 8) : ''),
          sub: base || firstAddr,
          kind: 'desktop',
        });
      }
    } catch (e) { /* 电脑端不可达 */ }
    try {
      const peers = await api.get('/api/peers');
      for (const p of (peers || [])) {
        const key = p.publicKey || p.id || '';
        rows.push({
          icon: '📱',
          title: p.name || String(key).slice(0, 12) || '设备',
          sub: '已连通 · ' + String(key).slice(0, 16),
          kind: 'peer',
          key,
        });
      }
    } catch (e) { /* 无对端 */ }
    if (mode === 'friend') {
      const fr = await desktopFetch('/api/friend-requests');
      if (fr && fr.count > 0) {
        rows.push({ icon: '📋', title: `待处理好友申请 ${fr.count} 个`, sub: '点一下处理', kind: 'requests' });
      }
    }
    if (hint) hint.textContent = rows.length ? '点一条即操作' : '没找到设备 — 让电脑端开着 (同一 Wi-Fi), 或扫电脑上的二维码';
    if (rows.length === 0) { list.innerHTML = '<div class="list-item">（暂无）</div>'; return; }
    for (const r of rows) {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `<span class="list-icon">${r.icon}</span><span><div>${escapeHtml(r.title)}</div><div style="font-size:12px;color:var(--text-muted)">${escapeHtml(r.sub || '')}</div></span><span class="list-arrow">›</span>`;
      el.addEventListener('click', () => onNearbyTap(r, mode));
      list.appendChild(el);
    }
  }

  async function onNearbyTap(row, mode) {
    if (row.kind === 'requests') { hideSheet('#nearby-sheet'); return openRequestsSheet(); }
    if (row.kind === 'desktop') {
      try {
        const r = await (window.BolloonCore && window.BolloonCore.network && window.BolloonCore.network.connect());
        const bad = r && r.ok === false;
        alert(bad ? ('连接电脑端失败: ' + String(r.error || '').slice(0, 100)) : '已连接电脑端 (数据/网络开始同步)');
        if (!bad && mode === 'join') {
          try { await (window.BolloonCore.desktop && window.BolloonCore.desktop.sync && window.BolloonCore.desktop.sync()); } catch (e) {}
        }
        loadNetMembers(); loadP2PStatus();
      } catch (e) { alert('连接失败: ' + String((e && e.message) || e).slice(0, 120)); }
      return;
    }
    if (row.kind === 'peer') {
      if (mode !== 'friend') { alert('这个设备已经和本机连通了。'); return; }
      let me = '手机端用户';
      try { const s = await api.get('/api/auth/status'); if (s && s.name) me = s.name; } catch (e) {}
      const sent = await desktopFetch('/api/friend-request', { targetPublicKey: row.key, name: me, message: '手机端请求加好友' });
      alert(sent ? '已发出好友申请' : '本机已记录该设备; 需要电脑端在线才能把申请发出去');
    }
  }

  /** 待处理好友申请: 点一条 → 通过 (取消 = 忽略) */
  async function openRequestsSheet() {
    const t = $('#nearby-title'); if (t) t.textContent = '待处理好友申请';
    showSheet('#nearby-sheet');
    const list = $('#nearby-list'); const hint = $('#nearby-hint');
    if (!list) return;
    list.innerHTML = '';
    if (hint) hint.textContent = '正在读取...';
    const fr = await desktopFetch('/api/friend-requests');
    if (!fr || !fr.requests || fr.requests.length === 0) {
      if (hint) hint.textContent = fr ? '没有待处理申请' : '需要电脑端在线 (设置里填桌面地址) 才能读取';
      list.innerHTML = '<div class="list-item">（空）</div>';
      return;
    }
    if (hint) hint.textContent = '点一条 = 通过 · 取消 = 忽略';
    for (const r of fr.requests) {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `<span class="list-icon">👤</span><span><div>${escapeHtml(r.fromName || '陌生人')}</div><div style="font-size:12px;color:var(--text-muted)">${escapeHtml(r.note || r.message || '(无备注)')}</div></span>`;
      el.addEventListener('click', async () => {
        const ok = window.confirm(`通过 ${r.fromName || '对方'} 的好友申请?\n\n确定 = 通过并加为好友\n取消 = 忽略这条申请`);
        if (ok) {
          const acc = await desktopFetch('/api/friend-accept', { fromPublicKey: r.fromPublicKey, name: r.fromName, requestId: r.requestId });
          alert(acc ? '已加为好友' : '通过失败 — 检查电脑端是否在线');
        } else {
          const ig = await desktopFetch('/api/friend-requests/ignore', { requestId: r.requestId });
          alert(ig ? '已忽略' : '忽略失败 — 检查电脑端是否在线');
        }
        hideSheet('#nearby-sheet');
        if (typeof loadContacts === 'function') loadContacts();
      });
      list.appendChild(el);
    }
  }

  // ==================== 微信息 (x402 付费信息, 2026-09-13) ====================
  // 人类手机操作: 浏览 → 点一条看详情 (价格/类别/哈希/来源) → 「购买并验真」→ 内容 + 验真分档。
  // 安全边界 (**不能破**): 手机端不持 EVM 私钥, 付款一律经电脑端 /api/x402/info/buy 代付;
  //   没配桌面地址 / 电脑端不可达 → 说人话提示, 绝不假装成功、绝不自己造数据。
  let _x402Cache = [];        // 最近一次列表 (行点击按 id 找回)
  let _x402Current = null;    // 详情 sheet 当前对应的 item

  /** 售卖端点 (付费取内容): <桌面基址>/api/x402/info/<id> */
  async function x402SellUrl(id) {
    const base = await desktopBaseUrl();
    return base ? base + '/api/x402/info/' + encodeURIComponent(String(id || '')) : '';
  }

  /**
   * 转发到电脑端并**保留后端错误原文** (购买失败要如实显示 "需要钱包私钥"/"facilitator 不可达",
   * 而 desktopFetch 失败时只回 null 会丢掉原因)。基地址仍走 desktopBaseUrl(), 不另起一套。
   */
  async function desktopPostRaw(path, body) {
    const base = await desktopBaseUrl();
    if (!base) return { ok: false, error: '需要电脑端在线 (设置里填桌面地址)' };
    try {
      const res = await fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        return { ok: false, status: res.status, error: (data && (data.error || data.message)) || ('电脑端返回 ' + res.status), data };
      }
      return data || { ok: false, error: '电脑端返回空响应' };
    } catch (e) {
      return { ok: false, error: '电脑端不可达: ' + String((e && e.message) || e).slice(0, 120) };
    }
  }

  /** 离线能核对的部分 (全部来自免费元数据, 不含内容本体) */
  function x402MetaLines(item) {
    const it = item || {};
    const p = it.price || {};
    const src = it.source || {};
    const refs = Array.isArray(src.refs) ? src.refs : [];
    const lines = [
      `价格: ${p.amount || '0'} ${p.currency || ''} (网络 ${p.network || '未声明'})`,
      `类别: ${it.category || 'other'}`,
      `提供方: ${(it.provider && (it.provider.name || '未命名')) || '未知'} · ${String((it.provider && it.provider.did) || '').slice(0, 28)}${(it.provider && it.provider.did && String(it.provider.did).length > 28) ? '…' : ''}`,
      `内容哈希: ${it.contentHash || '(无)'}`,
      `来源声明: ${src.kind || '未声明'}${refs.length ? ' · 引用 ' + refs.length + ' 条' : ' · 无引用'}`,
    ];
    for (const r of refs) lines.push('  · ' + String(r));
    if (src.note) lines.push(`来源备注: ${src.note}`);
    if (it.description) lines.push(`说明: ${it.description}`);
    lines.push('', '付款由电脑端代付 (手机端不拿私钥)');
    return lines;
  }

  /** 拉列表: 有数据 / 桌面不可达 / 空列表 三种情况都给人话 */
  async function loadX402Info() {
    const list = $('#x402-info-list');
    if (!list) return;
    list.innerHTML = '<div class="list-item">正在读取微信息...</div>';
    const base = await desktopBaseUrl();
    const r = base ? await desktopFetch('/api/x402/info') : null;
    if (!r || r.note === 'desktop-unreachable') {
      // (b) 桌面不可达: 手机端不持私钥, 浏览/代付都只能靠电脑端 — 直接说, 不假装有数据
      _x402Cache = [];
      list.innerHTML = '<div class="list-item">需要电脑端在线 (设置里填桌面地址)</div>';
      return;
    }
    const items = Array.isArray(r.items) ? r.items : [];
    _x402Cache = items;
    if (items.length === 0) {
      // (c) 电脑端在线但没发布过
      list.innerHTML = '<div class="list-item">电脑端还没发布任何付费信息</div>';
      return;
    }
    // (a) 有数据 → 每条一行: 标题 + 价格 + 类别 + 提供方
    list.innerHTML = '';
    for (const it of items) {
      const p = it.price || {};
      const amount = p.amount ? `${p.amount} ${p.currency || ''}`.trim() : '免费';
      const provName = (it.provider && (it.provider.name || it.provider.did)) || '未知提供方';
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `<span class="list-icon">💰</span><span><div>${escapeHtml(it.title || '(无标题)')}</div>` +
        `<div style="font-size:12px;color:var(--text-muted)">${escapeHtml(amount)} · ${escapeHtml(it.category || 'other')} · ${escapeHtml(String(provName).slice(0, 20))}</div></span>` +
        `<span class="list-arrow">›</span>`;
      el.addEventListener('click', () => openX402Sheet(it));
      list.appendChild(el);
    }
  }

  /** 点一条 → 详情 sheet (价格/网络/类别/提供方 DID 前缀/内容哈希/来源) */
  function openX402Sheet(item) {
    if (!item) return;
    _x402Current = item;
    const t = $('#x402-title');
    if (t) t.textContent = item.title || '微信息';
    const body = $('#x402-body');
    if (body) body.textContent = x402MetaLines(item).join('\n');
    const buy = $('#x402-buy');
    if (buy) { buy.disabled = false; buy.textContent = '购买并验真'; }
    showSheet('#x402-sheet');
  }

  /** 结果 sheet: 内容 + 验真结论 (纯文本渲染, 不用 innerHTML) */
  function showX402Result(title, text) {
    const t = $('#x402-result-title');
    if (t) t.textContent = title || '验真结果';
    const b = $('#x402-result-body');
    if (b) b.textContent = String(text || '');
    showSheet('#x402-result-sheet');
  }

  /** 购买并验真: 一律转发电脑端代付 (手机端不签名, 不持 EVM 私钥) */
  async function buyX402Info() {
    const item = _x402Current;
    if (!item) return;
    const btn = $('#x402-buy');
    const base = await desktopBaseUrl();
    if (!base) {
      alert('需要电脑端在线 (设置里填桌面地址) — 付款只能由电脑端代付, 手机端不保存私钥');
      return;
    }
    const sellUrl = base + '/api/x402/info/' + encodeURIComponent(String(item.id || ''));
    // 上限 = 标价上浮 20% (防挂单涨价); 标价读不到就不传上限
    const amt = Number((item.price || {}).amount);
    const maxPayment = Number.isFinite(amt) && amt > 0 ? String(Number((amt * 1.2).toFixed(8))) : undefined;
    if (btn) { btn.disabled = true; btn.textContent = '付款中...'; }
    try {
      const r = await desktopPostRaw('/api/x402/info/buy', {
        url: sellUrl,
        ...(maxPayment ? { maxPayment } : {}),
        allowLocalDev: true,
      });
      if (!r || r.ok !== true) {
        // 如实转述后端原因 (缺私钥 / facilitator 不可达 / 电脑端不可达), 不吞错
        alert('购买失败: ' + ((r && r.error) || '电脑端不可达 (检查设置里的桌面地址)'));
        return;
      }
      const content = String(r.content || '');
      const lines = [
        r.verifySummary || ((r.verify && r.verify.trust) ? '验真档: ' + r.verify.trust : '后端未给验真结论'),
        r.payment ? `支付模式: ${r.payment.mode || '?'}${r.payment.txHash ? ' · tx ' + String(r.payment.txHash).slice(0, 24) : ''}` : '',
        `内容哈希: ${(r.item && r.item.contentHash) || item.contentHash || '?'}`,
        `内容长度: ${content.length} 字`,
        '',
        '—— 内容 (前 2000 字) ——',
        content.slice(0, 2000) + (content.length > 2000 ? '\n…(已截断)' : ''),
      ].filter((x) => x !== '');
      showX402Result('已购买并验真', lines.join('\n'));
    } catch (e) {
      alert('购买失败: ' + String((e && e.message) || e).slice(0, 160));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '购买并验真'; }
    }
  }

  /** 只看元数据 / 离线验真: 没付款就没有信封 → 明说还差什么, 不谎称"验真通过" */
  async function verifyX402Info() {
    const item = _x402Current;
    if (!item) return;
    const btn = $('#x402-verify');
    const meta = x402MetaLines(item);
    const sellUrl = await x402SellUrl(item.id);
    if (!sellUrl) {
      showX402Result('离线查看元数据', meta.join('\n') + '\n\n没配桌面地址 → 拿不到签名信封, 无法验真。');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '核对中...'; }
    try {
      const r = await desktopPostRaw('/api/x402/info/verify', { envelope: null, url: sellUrl });
      // 注意: 后端 verify 的 ok = "信封验真是否通过", 不是 "HTTP 是否成功" —
      //   只要拿到 report 就是一次成功的请求, 不能把 report.ok=false 当成"电脑端不可达"
      const report = r && r.report ? r.report : null;
      if (!report) {
        showX402Result('还不能验真', ((r && r.error) || '电脑端不可达') + '\n\n离线可核对的:\n' + meta.join('\n'));
        return;
      }
      const checks = Array.isArray(report.checks) ? report.checks : [];
      // 没付款时后端拿到的是 402 的付款要求 (不是信封) → 报告必然是 unverified; 如实说明原因
      const noEnvelope = report.trust === 'unverified' && !checks.some((c) => c.name === 'provider-signature' && c.ok);
      if (noEnvelope) {
        const p = item.price || {};
        showX402Result('只看元数据 (还没付款)', [
          '电脑端返回 402 付款要求 → 还没付款就拿不到签名信封, 此时无法验真。',
          `付款要求 (来自元数据): ${p.amount || '0'} ${p.currency || ''} → ${String(p.payTo || '').slice(0, 20)}… (${p.network || '未声明'})`,
          '',
          '离线可核对的 (免费元数据):',
          ...meta,
          '',
          '点「购买并验真」由电脑端代付后, 才能拿到信封做分档验真。',
        ].join('\n'));
        return;
      }
      showX402Result('验真结果', [
        r.summary || ('验真档: ' + (report.trust || '?')),
        report.warnings && report.warnings.length ? '提示: ' + report.warnings.join('; ') : '',
        '',
        '逐项检查:',
        ...checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`),
      ].filter((x) => x !== '').join('\n'));
    } catch (e) {
      showX402Result('核对失败', String((e && e.message) || e).slice(0, 200));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '只看元数据 (离线验真)'; }
    }
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
        case 'switchTab': if (d.tab && ['main', 'friends', 'network', 'me'].includes(d.tab)) switchTab(d.tab); break;
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

  // === 手势 (2026-09-14): 滑动切 tab / 点空白关弹窗 / 右滑返回上一层 ===
  // 优先级: 有浮层 → 右滑 = 返回上一层 (关浮层); 无浮层 → 左右滑 = 依次切 tab
  function topOverlay() {
    const all = $$('.crop-modal:not([hidden]), .sheet:not([hidden]), .chat-page:not([hidden]), .card-detail:not([hidden])');
    if (!all.length) return null;
    return all
      .map((el) => ({ el, z: parseFloat(getComputedStyle(el).zIndex) || 0 }))
      .sort((a, b) => a.z - b.z)
      .pop().el;
  }
  function closeOverlay(el) {
    if (!el) return false;
    if (el.classList.contains('sheet')) { el.hidden = true; return true; }
    if (el.classList.contains('card-detail')) {
      const b = el.querySelector('#detail-back'); if (b) { b.click(); return true; }
      el.hidden = true; return true;
    }
    if (el.classList.contains('crop-modal')) {
      const b = el.querySelector('[id$="-cancel"], [id$="-close"], .icon-btn');
      if (b) { b.click(); return true; }
      el.hidden = true; return true;
    }
    if (el.classList.contains('chat-page')) {
      const b = el.querySelector('.chat-topbar .icon-btn');   // 各页左上角 ← : 走它自带的清理
      if (b) { b.click(); return true; }
      el.remove(); return true;
    }
    return false;
  }
  function goBack() { return closeOverlay(topOverlay()); }
  function inHorizontalScroller(node) {
    for (let n = node; n && n !== document.body && n.nodeType === 1; n = n.parentElement) {
      if (!n.scrollWidth || n.scrollWidth <= n.clientWidth + 4) continue;
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  }
  function setupGestures() {
    const TAB_ORDER = ['main', 'friends', 'network', 'me'];
    let sx = 0, sy = 0, st = 0, active = false, startTarget = null;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { active = false; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      st = Date.now(); active = true; startTarget = e.target;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Date.now() - st > 900) return;                                  // 慢拖不算滑
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;  // 不够横向
      if (inHorizontalScroller(startTarget)) return;                       // 横向列表/卡片轨道里不抢手势
      const ov = topOverlay();
      if (ov) {
        if (dx > 0) closeOverlay(ov);           // 浮层内右滑 = 返回上一层 (输入框选中文本时不触发: dx 门槛已过滤)
        return;
      }
      const i = TAB_ORDER.indexOf(currentTab);
      if (dx < 0) { if (i + 1 < TAB_ORDER.length) switchTab(TAB_ORDER[i + 1]); }
      else { if (i > 0) switchTab(TAB_ORDER[i - 1]); }
    }, { passive: true });

    // 点空白关弹窗: 点 sheet 的暗背景 (非 .sheet-inner 内容) 即关
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const sheet = t.closest('.sheet');
      if (sheet && !sheet.hasAttribute('hidden') && !t.closest('.sheet-inner')) sheet.hidden = true;
    });
  }

  // ============ 隐私合规 (2026-09-16): 同意门 / 政策页 / 注销 ============
  //  上架要求: 首次启动必须先展示隐私政策; 用户同意前不得读取本机数据、不得连网、不得申请任何权限。
  //  所以 init() 只做一件事 —— 决定"先弹门"还是"进应用"; 真正的初始化在 initApp()。

  function privacyCore() {
    return (window.BolloonCore && window.BolloonCore.privacy) || null;
  }

  function privacyNeedsConsent() {
    const p = privacyCore();
    if (!p || typeof p.needsConsent !== 'function') return true;   // 内核未就绪 → 按"需要同意"处理
    try { return !!p.needsConsent(); } catch (e) { return true; }
  }

  function escHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 政策摘要 HTML (要素来自内核常量, 单测锁了必填项) */
  function privacySummaryHtml() {
    const p = privacyCore();
    const items = (p && p.summary) || [];
    return items.map((it) => `<h3>${escHtml(it.title)}</h3><p>${escHtml(it.body)}</p>`).join('');
  }

  function showPrivacyGate() {
    const p = privacyCore();
    const t = (p && p.consentText) || {};
    const gate = $('#privacy-gate');
    if (!gate) return;
    const titleEl = $('#privacy-gate-title'), bodyEl = $('#privacy-gate-body');
    if (titleEl && t.title) titleEl.textContent = t.title;
    if (bodyEl) bodyEl.textContent = t.intro || '使用前请先阅读并同意隐私政策。';
    const linkEl = $('#privacy-gate-link');
    if (linkEl && t.policyLink) linkEl.textContent = t.policyLink + ' ›';
    const agreeEl = $('#privacy-agree'), declineEl = $('#privacy-decline');
    if (agreeEl && t.agree) agreeEl.textContent = t.agree;
    if (declineEl && t.decline) declineEl.textContent = t.decline;
    if (linkEl) linkEl.onclick = (e) => { e.preventDefault(); openPrivacyPolicy(); };
    if (agreeEl) agreeEl.onclick = () => {
      const ok = p && typeof p.grant === 'function' ? p.grant() : false;
      if (!ok) { /* 本机写不进去(隐私模式/满盘): 不假装同意, 下次启动会再问 */ }
      hideSheet('#privacy-gate');
      initApp();
    };
    if (declineEl) declineEl.onclick = () => showPrivacyDeclined();
    gate.hidden = false;
  }

  /** 不同意 → 停在说明页: 不初始化功能、不收集任何东西, 但也不强制退出应用 */
  function showPrivacyDeclined() {
    const p = privacyCore();
    const t = (p && p.consentText) || {};
    const gate = $('#privacy-gate');
    if (!gate) return;
    const titleEl = $('#privacy-gate-title'), bodyEl = $('#privacy-gate-body');
    if (titleEl) titleEl.textContent = t.declinedTitle || '未同意';
    if (bodyEl) bodyEl.textContent = t.declinedBody || '未同意隐私政策时应用不会收集任何信息。';
    const linkEl = $('#privacy-gate-link');
    if (linkEl) { linkEl.textContent = (t.declinedReread || '重新阅读') + ' ›'; linkEl.onclick = (e) => { e.preventDefault(); showPrivacyGate(); }; }
    const agreeEl = $('#privacy-agree'), declineEl = $('#privacy-decline');
    if (agreeEl) { agreeEl.textContent = t.agree || '同意并继续'; agreeEl.onclick = () => { const ok = p && p.grant ? p.grant() : false; if (!ok) {} hideSheet('#privacy-gate'); initApp(); }; }
    if (declineEl) {
      declineEl.textContent = t.declinedExit || '退出应用';
      declineEl.onclick = () => {
        const cap = window.Capacitor;
        if (cap && cap.Plugins && cap.Plugins.App && cap.Plugins.App.exitApp) { try { cap.Plugins.App.exitApp(); return; } catch (e) {} }
        alert('请手动退出应用（返回键 / 上滑关闭）。未同意隐私政策期间应用不会收集任何信息。');
      };
    }
    gate.hidden = false;
  }

  /** 应用内完整政策 (全屏, 离线可用)。权威版永远是 bolloon.cn/privacy.html (商店表单填的就是它) */
  function openPrivacyPolicy() {
    const p = privacyCore();
    const page = $('#policy-page');
    const bodyEl = $('#policy-body');
    if (!page || !bodyEl) return;
    const t = (p && p.consentText) || {};
    const url = (p && p.policyUrl) || 'https://bolloon.cn/privacy.html';
    const contact = (p && p.contact) || '';
    const filing = p && typeof p.filingText === 'function' ? p.filingText() : '';
    bodyEl.innerHTML = `
      <p class="policy-meta">${escHtml(t.intro || '')}</p>
      ${privacySummaryHtml()}
      <h3>完整政策与备案信息</h3>
      <p>在线完整版：<a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(url)}</a></p>
      <p>${escHtml(filing)}</p>
      <p class="policy-meta">联系方式：${escHtml(contact)}（承诺 7 个工作日内答复）</p>
      <p class="policy-meta">本页内容与在线版本一致；如两者不一致，以在线版本为准。</p>`;
    const back = $('#policy-back');
    if (back) back.onclick = () => { page.hidden = true; };
    page.hidden = false;
  }

  /** 注销: 清除本机全部数据 (身份 DID / 智能体 / 会话消息 / 支付 / 钱包) */
  async function wipeLocalDataFlow() {
    if (!confirm('确定清除本机数据（注销）？\n\n将删除本机上的：身份标识（DID）、智能体、会话与消息、钱包账本。\n已写入公开区块链的交易记录无法删除。\n\n此操作不可撤销。')) return;
    const p = privacyCore();
    if (!p || typeof p.wipe !== 'function') { alert('清除失败：本机内核未就绪，请重启应用后重试。'); return; }
    showToast('正在清除本机数据…');
    try {
      const r = await p.wipe();
      const failed = (r && r.failed) || [];
      const deleted = (r && r.deletedDatabases) || [];
      const cleared = (r && r.clearedStorageKeys) || [];
      if (failed.length) {
        alert(`部分数据未能清除（可重试）：\n${failed.join('\n')}\n\n已清除 ${deleted.length} 个数据库 / ${cleared.length} 个本机键。`);
      } else {
        alert(`${p.wipeNotice || '已清除本机数据。'}\n\n（本次删除 ${deleted.length} 个数据库、${cleared.length} 个本机键）`);
      }
      location.reload();   // 回到首启状态 (同意记录保留, 不再重复弹门)
    } catch (e) {
      alert('清除失败：' + ((e && e.message) || e));
    }
  }

  function init() {
    // 首启/政策版本变更 → 先弹同意门, 不做任何初始化 (不读本机数据 / 不连网 / 不申请权限)
    if (privacyNeedsConsent()) { showPrivacyGate(); return; }
    initApp();
  }

  function initApp() {
    bindMenu();
    applyTheme(resolveThemePref(), false);
    switchTab('main');
    setupUiControl();
    setupGestures();
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

// ============ 联系方式与持久授权 (2026-09-19) ============
// 独立 IIFE: 不改动既有逻辑, 只用 window.BolloonCore.contacts (编译进 mobile-core.js)。
// 分工: 手机 = 输入/OTP/确认/展示待发内容/批准/签名授权; 桌面 = 落盘/执行/等待回复/证据。
(function () {
  const $ = (sel) => document.querySelector(sel);
  const C = () => (window.BolloonCore && window.BolloonCore.contacts) || null;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function openSheet() { const el = $('#contacts-sheet'); if (el) el.hidden = false; }
  function closeSheet() { const el = $('#contacts-sheet'); if (el) el.hidden = true; }
  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

  let _lastChallenge = null;

  async function refresh() {
    const c = C();
    setText('#contacts-effective', '加载中...');
    if (!c) { setText('#contacts-effective', '内核未就绪 (mobile-core 没加载)'); return; }
    setText('#contacts-signing', c.deviceSigning()
      ? '本机可做设备签名 (Ed25519) — 授权由这台手机签名后桌面才认'
      : '⚠ 本机 WebView 不支持 Ed25519 设备签名 — 无法在手机上授权, 请在桌面端授权');
    // 桌面回来先补同步排队中的授权
    try { const fl = await c.flushQueue(); if (fl && fl.sent) setText('#contacts-signing', `已补同步 ${fl.sent} 条手机授权到桌面`); } catch (e) {}

    let card = null;
    try { card = await c.card(); } catch (e) { card = null; }
    if (!card) { setText('#contacts-effective', '读取失败'); return; }
    setText('#contacts-effective',
      `当前授权: ${card.effective}` + (card.deviceSigning ? '' : ' · 本机不能签名'));
    setText('#contacts-willnot', '不会获得权限: ' + (card.willNotGet || []).join(' · '));

    // 联系方式 (只有脱敏值)
    const list = $('#contacts-list');
    if (list) {
      list.innerHTML = (card.contacts && card.contacts.length)
        ? card.contacts.map((x) => `<div class="sheet-text">${esc(x.displayValue)} <span style="color:var(--text-secondary)">[${esc(x.kind)}] ${esc(x.state)} · ${esc(x.label)}</span></div>`).join('')
        : '<div class="sheet-text" style="color:var(--text-secondary)">还没有绑定 — 在下面输入手机号或邮箱</div>';
    }

    // 待批准 (展示待发内容 → 批准/拒绝)
    const ap = $('#contacts-approvals');
    if (ap) {
      ap.innerHTML = (card.approvals && card.approvals.length)
        ? `<div class="sheet-title" style="margin-top:10px">待你批准 (${card.approvals.length})</div>` + card.approvals.map((a) => `
          <div style="border:1px solid var(--border);border-radius:10px;padding:8px;margin-top:6px">
            <div class="sheet-text" style="font-weight:600">${esc(a.contactName)} · ${esc(a.channel)}${a.reallySent ? '' : ' · 本地落盘(未真实外发)'}</div>
            <div class="sheet-text" style="font-size:12px">${a.subject ? esc(a.subject) + ' — ' : ''}${esc(a.bodyPreview)}</div>
            <div class="sheet-text" style="font-size:11px;color:var(--text-secondary)">原因: ${esc(a.reason)}</div>
            <div style="display:flex;gap:8px;margin-top:6px">
              <button class="sheet-choice" data-approve="${esc(a.consentId)}" style="flex:1">批准并发送</button>
              <button class="sheet-choice sheet-cancel" data-reject="${esc(a.consentId)}" style="flex:1">拒绝</button>
            </div>
          </div>`).join('')
        : '<div class="sheet-text" style="color:var(--text-secondary);margin-top:10px">没有待批准的联系</div>';
      ap.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-approve');
        const r = await C().decide(id, 'approve');
        alert(r && r.ok ? '已批准并发送' : '批准失败: ' + ((r && r.error) || '未知'));
        refresh();
      }));
      ap.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-reject');
        const r = await C().decide(id, 'reject', { reason: '手机端拒绝' });
        alert(r && r.ok ? '已拒绝' : '拒绝失败: ' + ((r && r.error) || '未知'));
        refresh();
      }));
    }

    // 三个授权选项
    const ch = $('#contacts-choices');
    if (ch && !ch.dataset.bound) {
      ch.dataset.bound = '1';
      ch.innerHTML = (card.choices || []).map((x) => `<button class="sheet-choice" data-choice="${esc(x.id)}">${esc(x.label)}</button>`).join('');
      ch.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', async () => {
        const choice = b.getAttribute('data-choice');
        const warn = choice === 'full_contact_access'
          ? '完全授权联系方式能力: 手机号/邮箱能力交给 Agent, 普通与敏感内容不再逐次确认 (密钥/支付/合同承诺仍然拒绝)。确认吗?'
          : choice === 'persistent' ? '长期使用: 以后 Agent 联系已验证的人不再打断你 (仍受频率/任务/证据/撤销约束)。确认吗?'
            : '仅本次任务: 只授权当前任务使用。确认吗?';
        if (window.confirm && !window.confirm(warn)) return;
        const r = await C().authorize(choice);
        if (r && r.ok) alert('已授权: 桌面已验签接受\n' + (r.note || ''));
        else if (r && r.queued) alert('桌面暂时不在线\n授权已保存在手机本地队列, 桌面一上线自动同步\n(' + (r.error || '') + ')');
        else alert('授权失败: ' + ((r && r.error) || '未知'));
        refresh();
      }));
    }
  }

  function bindEvents() {
    const item = $('#item-contacts');
    if (item) item.addEventListener('click', () => { openSheet(); refresh(); });
    const close = $('#contacts-close');
    if (close) close.addEventListener('click', closeSheet);

    const bind = $('#contacts-bind');
    if (bind) bind.addEventListener('click', async () => {
      const v = ($('#contacts-value') || {}).value || '';
      if (!v.trim()) { alert('先输入手机号或邮箱'); return; }
      const isEmail = /@/.test(v);
      const r = await C().bind(isEmail ? 'email' : 'phone', v.trim(), isEmail ? undefined : 'CN');
      if (!r || !r.ok) { alert('绑定失败: ' + ((r && r.error) || '未知')); return; }
      _lastChallenge = r.data;
      alert('已登记 ' + r.data.displayValue + '\n通道: ' + (r.data.channelLabel || '') +
        (r.data.otpForLocalSink ? '\n本地落盘验证码: ' + r.data.otpForLocalSink : '\n验证码已通过通道发出, 收到后填在下面'));
      refresh();
    });

    const verify = $('#contacts-verify');
    if (verify) verify.addEventListener('click', async () => {
      const code = ($('#contacts-code') || {}).value || '';
      if (!_lastChallenge) { alert('先绑定一个手机号或邮箱'); return; }
      const r = await C().verify(_lastChallenge.contactId, _lastChallenge.challengeId, code.trim());
      if (!r || !r.ok) { alert('验证失败: ' + ((r && r.error) || '未知')); return; }
      alert('验证通过: ' + r.data.displayValue + '\n下一步: 选择下面的授权等级 (验证 ≠ 自动长期授权)');
      refresh();
    });

    const revoke = $('#contacts-revoke-all');
    if (revoke) revoke.addEventListener('click', async () => {
      if (window.confirm && !window.confirm('撤销全部联系方式授权? 之后 Agent 不能再自动联系任何人 (历史证据保留)')) return;
      const card = await C().card();
      const grants = (card && card.grants) || [];
      if (!grants.length) { alert('当前没有生效中的授权'); return; }
      let done = 0, err = '';
      for (const g of grants) {
        if (g.status !== 'active') continue;
        const r = await C().revoke(g.grantId, '手机端收回');
        if (r && r.ok) done++; else err = (r && r.error) || '未知';
      }
      alert(done ? `已撤销 ${done} 条授权` : ('撤销未完成: ' + err));
      refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindEvents);
  else bindEvents();
})();

// ============ 任务协作: 入群 · 发公告 · 看飞轮进度 (2026-09-25) ============
// 独立 IIFE (与联系方式面板同款): 只用 window.BolloonCore.tasks (编译进 mobile-core.js)。
// 分工**不变**: 手机 = 输入 · 展示待发内容 · 设备签名; 桌面 = 落盘 · 执行 · 等待回复 · 证据。
// 纪律:
//   · 动态文本一律 textContent (本文件这一段**不用 innerHTML** 拼任何数据)
//   · 渲染只取白名单字段 (视图对象里多出来的字段进不了 DOM)
//   · 双语走 data-zh/data-en (切语言只重写文字节点, 不重建结构)
//   · 相对时间只更新 .rel-time 文字节点 (不重渲染整页)
(function () {
  const $ = (sel) => document.querySelector(sel);
  const T = () => (window.BolloonCore && window.BolloonCore.tasks) || null;

  // ── 语言 (data-zh/data-en; 默认中文, 显式切 en 才英文) ──────────────────────
  function lang() {
    try { return localStorage.getItem('bolloon_lang') === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; }
  }
  function bilingual(el, zh, en) {
    if (!el) return el;
    el.setAttribute('data-zh', String(zh));
    el.setAttribute('data-en', String(en));
    el.textContent = lang() === 'en' ? String(en) : String(zh);
    return el;
  }
  function applyLang(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-zh][data-en]').forEach((el) => {
      el.textContent = lang() === 'en' ? el.getAttribute('data-en') : el.getAttribute('data-zh');
    });
  }
  window.__mobileLang = {
    get: lang,
    set(v) {
      try { localStorage.setItem('bolloon_lang', v === 'en' ? 'en' : 'zh'); } catch (e) {}
      applyLang();
      // 列表里的空态/描述是用 lang() 现拼的 → 切完语言重渲染一次, 免得留下上一语言的旧句子
      try {
        if (window.__mobileTasksUi && typeof window.__mobileTasksUi.refresh === 'function') window.__mobileTasksUi.refresh();
      } catch (e) {}
    },
  };

  // ── DOM 小工具 (全部 textContent) ─────────────────────────────────────────
  function mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function line(cls, text) { const e = mk('div', cls || 'sheet-text'); if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function row(text, sub) {
    const e = mk('div', 'list-item');
    const box = mk('div');
    box.style.flex = '1';
    box.appendChild(line('', text));
    if (sub !== undefined && sub !== null && String(sub) !== '') {
      const s = line('', sub);
      s.style.fontSize = '12px';
      s.style.color = 'var(--text-secondary)';
      box.appendChild(s);
    }
    e.appendChild(box);
    return e;
  }
  /** 相对时间节点: 只改这一个文字节点 (data-at 记住基准) */
  function relNode(atMs) {
    const s = mk('span', 'rel-time');
    s.setAttribute('data-at', String(Number(atMs) || 0));
    s.textContent = relText(Number(atMs) || 0);
    return s;
  }
  /** 相对时间节点 (输入是**毫秒差**, 例如 deadlineInMs / resumeInMs) —— 每 30s 只改这个文字节点 */
  function relDeltaNode(deltaMs) {
    const s = mk('span', 'rel-time');
    s.setAttribute('data-delta', String(Number(deltaMs) || 0));
    s.textContent = relDeltaText(Number(deltaMs) || 0);
    return s;
  }
  function relDeltaText(deltaMs) {
    const t = T();
    if (!t || !t.relative) return '';
    return t.relative(Number(deltaMs) || 0, lang()) || '';
  }
  function relText(atMs) {
    const t = T();
    if (!atMs) return '';
    if (t && t.relative) return t.relative(Date.now() - Number(atMs), lang()) || '';
    return '';
  }
  function shorten(v, n) { const t = T(); return t && t.shorten ? t.shorten(v, n) : String(v == null ? '' : v).slice(0, n || 12); }
  /** 最后一道自检: 命中红线就不显示原文 (桌面已经挡过, 这里只兜底) */
  function safeText(v) {
    const s = String(v == null ? '' : v);
    const t = T();
    if (t && t.scanText) {
      const hits = t.scanText(s);
      if (hits && hits.length) return '[' + (lang() === 'en' ? 'redacted:' : '已遮蔽:') + hits[0].rule + ']';
    }
    return s;
  }
  function setText(sel, text) { const el = $(sel); if (el) el.textContent = text == null ? '' : String(text); }
  /** 动态状态行: 带上 data-zh/data-en, 这样切语言时它也换 (applyLang 只管文字节点) */
  function dynText(sel, zh, en) {
    const el = $(sel);
    if (!el) return;
    el.setAttribute('data-zh', String(zh));
    el.setAttribute('data-en', String(en));
    el.textContent = lang() === 'en' ? String(en) : String(zh);
  }
  function clear(node) { if (node) while (node.firstChild) node.removeChild(node.firstChild); }
  function openSheet() { const el = $('#task-confirm-sheet'); if (el) el.hidden = false; }
  function closeSheet() { const el = $('#task-confirm-sheet'); if (el) el.hidden = true; }
  function toast(msg) {
    if (window.alert) window.alert(String(msg));
  }

  // ── 状态 (完整 id 只留在这段 JS 内存里, 不进 DOM 文本) ─────────────────────
  const state = { groups: [], groupsView: [], board: null, flywheel: null, trail: null, selectedGroupRef: '', pending: null };

  // ── 渲染: 群 ──────────────────────────────────────────────────────────────
  function renderGroups() {
    const list = $('#tasks-groups');
    if (!list) return;
    clear(list);
    if (!state.groups.length) {
      list.appendChild(line('sheet-text', lang() === 'en' ? 'No groups joined yet' : '还没有加入任何群'));
      return;
    }
    state.groups.forEach((g, i) => {
      const view = state.groupsView[i] || {};
      const r = row(String(view.name || '') + '  ·  ' + String(view.idShort || ''), '');
      const when = relNode(Date.parse(String(view.joinedAt || '')) || 0);
      const sub = line('', '');
      sub.style.fontSize = '12px';
      sub.style.color = 'var(--text-secondary)';
      sub.appendChild(document.createTextNode(lang() === 'en' ? 'joined ' : '加入于 '));
      sub.appendChild(when);
      r.firstChild.appendChild(sub);
      const b = mk('button', 'sheet-choice');
      b.style.flex = '0 0 auto';
      bilingual(b, '退群', 'Leave');
      b.setAttribute('data-group-leave', String(i));
      b.addEventListener('click', () => askLeave(i));
      r.appendChild(b);
      list.appendChild(r);
    });
  }

  // ── 渲染: 公告板 ──────────────────────────────────────────────────────────
  function renderBoard() {
    const list = $('#tasks-board');
    if (!list) return;
    clear(list);
    const d = state.board || {};
    const items = d.items || [];
    if (!items.length) {
      list.appendChild(line('sheet-text', lang() === 'en' ? 'Board is empty' : '板上暂时没有公告'));
    }
    items.forEach((it, i) => {
      const r = row(
        String(it.capability || '') + '  ·  ' + String(it.idShort || '') + '  ·  ' + String((it.statusLabel || {})[lang()] || ''),
        '',
      );
      const sub = line('', '');
      sub.style.fontSize = '12px';
      sub.style.color = 'var(--text-secondary)';
      sub.appendChild(document.createTextNode((lang() === 'en' ? 'budget ' : '预算 ') + safeText(it.budgetLabel || '—') + ' · '));
      sub.appendChild(document.createTextNode(lang() === 'en' ? 'closes ' : '截止 '));
      sub.appendChild(relDeltaNode(it.deadlineInMs));
      r.firstChild.appendChild(sub);
      if (it.claimable) {
        const b = mk('button', 'sheet-choice');
        b.style.flex = '0 0 auto';
        bilingual(b, '发进群', 'Post to group');
        b.setAttribute('data-announce', String(i));
        b.addEventListener('click', () => askAnnounceToGroup(i));
        r.appendChild(b);
      }
      list.appendChild(r);
    });
    const notes = Array.isArray(d.notes) ? d.notes : [];
    if (notes.length) list.appendChild(line('sheet-text', notes.join(' · ')));
  }

  // ── 渲染: 飞轮进度 (只读; 状态来自 goal-flywheel 的五类用户可见状态) ────────
  function renderFlywheel() {
    const list = $('#tasks-flywheel');
    if (!list) return;
    clear(list);
    const goals = (state.flywheel && state.flywheel.goals) || [];
    if (!goals.length) {
      list.appendChild(line('sheet-text', lang() === 'en' ? 'No goals yet' : '还没有目标'));
      const hint = state.flywheel && state.flywheel.hint;
      if (hint) list.appendChild(line('sheet-text', hint));
      return;
    }
    const zh = lang() === 'zh';
    goals.forEach((g) => {
      const v = g.view || {};
      const r = row(String(g.objectiveShort || '') + '  ·  ' + String((v.stateLabel || {})[lang()] || g.status || ''), '');
      const box = r.firstChild;
      const rep = v.report || {};
      if (rep.nextStep) box.appendChild(line('sheet-text', (zh ? '下一步: ' : 'next step: ') + safeText(rep.nextStep)));
      if (rep.conclusion) box.appendChild(line('sheet-text', (zh ? '结论: ' : 'conclusion: ') + safeText(rep.conclusion)));
      if (Array.isArray(rep.remaining) && rep.remaining.length) {
        box.appendChild(line('sheet-text', (zh ? '还剩: ' : 'remaining: ') + rep.remaining.map(safeText).join(' · ')));
      }
      if (Array.isArray(rep.blockReasons) && rep.blockReasons.length) {
        box.appendChild(line('sheet-text', (zh ? '卡住原因: ' : 'blocked by: ') + rep.blockReasons.map(safeText).join(' · ')));
      }
      const sub = line('', '');
      sub.style.fontSize = '12px';
      sub.style.color = 'var(--text-secondary)';
      if (v.resumeInMs !== null && v.resumeInMs !== undefined) {
        sub.appendChild(document.createTextNode(zh ? '下次醒来 ' : 'wakes '));
        sub.appendChild(relDeltaNode(v.resumeInMs));
      }
      sub.appendChild(document.createTextNode((zh ? ' · 会继续: ' : ' · will continue: ') + (rep.willContinue ? (zh ? '是' : 'yes') : (zh ? '否' : 'no'))));
      box.appendChild(sub);
      if (v.requiredAgent) box.appendChild(line('sheet-text', safeText(v.requiredAgent)));
      if (v.riskLevel) box.appendChild(line('sheet-text', (zh ? '风险: ' : 'risk: ') + safeText(v.riskLevel)));
      const blocks = Array.isArray(v.blocks) ? v.blocks : [];
      blocks.forEach((b) => {
        const label = [(b.kindLabel || {})[lang()], (b.ownerLabel || {})[lang()], (b.actionLabel || {})[lang()]].filter(Boolean).join(' · ');
        const bl = line('sheet-text', safeText(label) + (b.note ? ' — ' + safeText(b.note) : ''));
        box.appendChild(bl);
        const bd = line('', '');
        bd.style.fontSize = '12px';
        bd.style.color = 'var(--text-secondary)';
        bd.appendChild(document.createTextNode(zh ? '卡了 ' : 'blocked for '));
        bd.appendChild(relDeltaNode(b.blockedForMs));
        box.appendChild(bd);
      });
      list.appendChild(r);
    });
    const note = state.flywheel && state.flywheel.note;
    if (note) list.appendChild(line('sheet-text', note));
  }

  // ── 渲染: 群痕迹 (只读) ───────────────────────────────────────────────────
  function renderTrail() {
    const list = $('#tasks-trail');
    if (!list) return;
    clear(list);
    const t = state.trail;
    if (!t) { list.appendChild(line('sheet-text', lang() === 'en' ? 'Pick a group first' : '先选一个群')); return; }
    if (!t.entries.length) {
      list.appendChild(line('sheet-text', lang() === 'en' ? 'No trail entries for this round' : '这一期还没有过程痕迹'));
      return;
    }
    t.entries.forEach((e) => {
      const label = (e.kindLabel || {})[lang()] || e.kind;
      const r = row(String(label) + '  ·  ' + String(e.sender || ''), '');
      const box = r.firstChild;
      const sub = line('', '');
      sub.style.fontSize = '12px';
      sub.style.color = 'var(--text-secondary)';
      sub.appendChild(relNode(e.atMs || 0));
      box.appendChild(sub);
      (e.facts || []).forEach((f) => box.appendChild(line('sheet-text', safeText(f.k) + '=' + safeText(f.v))));
      list.appendChild(r);
    });
    if (t.privacyHits) list.appendChild(line('sheet-text', lang() === 'en' ? '⚠ some lines hit the privacy rules and were redacted' : '⚠ 有消息命中隐私红线, 已遮蔽'));
    if (t.ignoredMessages) list.appendChild(line('sheet-text', (lang() === 'en' ? 'ignored messages: ' : '忽略消息: ') + String(t.ignoredMessages)));
  }

  // ── 确认页 (展示待发内容 → 确认 → 签名) ───────────────────────────────────
  function renderConfirm() {
    const t = T();
    const p = state.pending;
    if (!t || !p) return;
    const d = t.describeConfirm(p.kind, p.req) || {};
    const title = $('#task-confirm-title');
    if (title) bilingual(title, d.titleZh || '确认这个动作', d.titleEn || 'Confirm this action');
    const lines = $('#task-confirm-lines');
    if (lines) {
      clear(lines);
      (d.lines || []).forEach((l) => lines.appendChild(line('sheet-text', (lang() === 'en' ? l.kEn : l.k) + ': ' + safeText(l.v))));
    }
    setText('#task-confirm-what', lang() === 'en'
      ? 'This will be signed with this device key. The desktop verifies that signature before doing anything.'
      : '这个动作会用本机设备密钥签名; 桌面验签通过后才会真正执行。');
    // 群选择 (群消息类动作必须显式选群)
    const wrap = $('#task-confirm-group-wrap');
    const box = $('#task-confirm-group');
    const needsGroup = p.needsGroup === true;
    if (wrap) wrap.hidden = !needsGroup;
    if (box && needsGroup) {
      clear(box);
      state.groups.forEach((g, i) => {
        const view = state.groupsView[i] || {};
        const b = mk('button', 'sheet-choice');
        bilingual(b, String(view.name || ''), String(view.name || ''));
        b.setAttribute('data-pick-group', String(i));
        if (p.req.groupRef === g.id) b.style.borderColor = 'var(--accent)';
        b.addEventListener('click', () => { p.req.groupRef = g.id; state.selectedGroupRef = g.id; renderConfirm(); refreshPreview(); });
        box.appendChild(b);
      });
      if (!state.groups.length) box.appendChild(line('sheet-text', lang() === 'en' ? 'no groups' : '还没有群'));
    }
    // 群消息类: 预览按钮 + 原文区
    const pv = $('#task-confirm-preview');
    if (pv) pv.hidden = !p.showPreview;
    const ct = $('#task-confirm-content-title');
    const cc = $('#task-confirm-content');
    if (ct) ct.hidden = !p.previewText;
    if (cc) { cc.hidden = !p.previewText; cc.textContent = p.previewText || ''; }
    const yes = $('#task-confirm-yes');
    if (yes) {
      const disabled = needsGroup && !p.req.groupRef;
      yes.disabled = !!disabled;
      yes.style.opacity = disabled ? '0.5' : '';
    }
  }

  async function refreshPreview() {
    const t = T();
    const p = state.pending;
    if (!t || !p || !p.showPreview) return;
    if (!p.req.groupRef) { p.previewText = ''; renderConfirm(); return; }
    const r = await t.previewGroupMessage(p.req);
    if (r && r.ok) { p.previewText = (r.data && r.data.text) || ''; setText('#tasks-hint', ''); }
    else { p.previewText = ''; setText('#tasks-hint', (lang() === 'en' ? 'preview failed: ' : '预览失败: ') + String((r && r.code) || '') + ' ' + String((r && r.error) || '')); }
    renderConfirm();
  }

  function askConfirm(kind, req, opts) {
    state.pending = Object.assign({ kind: kind, req: req, showPreview: false, previewText: '' }, opts || {});
    renderConfirm();
    openSheet();
    if (state.pending.showPreview) refreshPreview();
  }

  function requireSigning() {
    const t = T();
    if (!t) { toast(lang() === 'en' ? 'phone kernel not ready' : '手机内核未就绪 (mobile-core 没加载)'); return null; }
    if (!t.deviceSigning || !t.deviceSigning()) {
      toast(lang() === 'en'
        ? 'this WebView cannot do Ed25519 device signing — run it from the desktop instead'
        : '本机 WebView 不支持 Ed25519 设备签名 —— 这个动作请在桌面端执行 (不降级, 不假装签了)');
      return null;
    }
    return t;
  }

  // ── 四个能力的入口 ────────────────────────────────────────────────────────
  function askJoin() {
    const link = (($('#tasks-group-link') || {}).value || '').trim();
    if (!link) { toast(lang() === 'en' ? 'paste the group invite link first' : '先粘贴群邀请链接'); return; }
    if (!requireSigning()) return;
    const req = T().emptyRequest('group_join');
    req.groupRef = link;
    askConfirm('group_join', req, {});
  }
  function askCreate() {
    const name = (($('#tasks-group-name') || {}).value || '').trim();
    if (!name) { toast(lang() === 'en' ? 'give the group a name first' : '先给群起个名字'); return; }
    if (!requireSigning()) return;
    const req = T().emptyRequest('group_create');
    req.groupRef = name;
    askConfirm('group_create', req, {});
  }
  function askLeave(i) {
    if (!requireSigning()) return;
    const g = state.groups[i];
    if (!g) return;
    const req = T().emptyRequest('group_leave');
    req.groupRef = g.id;
    askConfirm('group_leave', req, {});
  }
  function askPublish() {
    if (!requireSigning()) return;
    const cap = (($('#tasks-pub-capability') || {}).value || '').trim();
    const ins = (($('#tasks-pub-instruction') || {}).value || '').trim();
    const bud = (($('#tasks-pub-budget') || {}).value || '').trim();
    const dl = (($('#tasks-pub-deadline') || {}).value || '').trim();
    if (!cap || !ins || !bud) { toast(lang() === 'en' ? 'capability / instruction / budget are required' : '能力 / 任务正文 / 预算 都要填'); return; }
    const req = T().emptyRequest('announce_publish');
    req.capability = cap; req.instruction = ins; req.budgetHuman = bud; req.currency = 'USDC';
    if (dl) req.deadline = dl;
    askConfirm('announce_publish', req, {});
  }
  function askAnnounceToGroup(i) {
    if (!requireSigning()) return;
    const it = ((state.board || {}).items || [])[i];
    if (!it) return;
    const req = T().emptyRequest('announce_to_group');
    req.announcementId = it.ref || '';
    req.groupRef = state.selectedGroupRef || (state.groups[0] && state.groups[0].id) || '';
    if (!req.announcementId) { toast(lang() === 'en' ? 'desktop did not give a usable announcement id' : '桌面没给出可用的公告号, 先刷新') ; return; }
    askConfirm('announce_to_group', req, { needsGroup: true, showPreview: true });
  }
  function askTrail(kind) {
    if (!requireSigning()) return;
    const req = T().emptyRequest('trail_post');
    req.groupRef = state.selectedGroupRef || (state.groups[0] && state.groups[0].id) || '';
    req.trailKind = kind;
    if (!req.groupRef) { toast(lang() === 'en' ? 'pick a group first' : '先选一个群'); return; }
    askConfirm('trail_post', req, { needsGroup: true, showPreview: true });
  }

  async function doConfirmed() {
    const t = T();
    const p = state.pending;
    if (!t || !p) return;
    const yes = $('#task-confirm-yes');
    if (yes) yes.disabled = true;
    const r = await t.execute(p.req);
    if (yes) yes.disabled = false;
    closeSheet();
    if (r && r.ok) {
      const text = (r.data && r.data.text) || (lang() === 'en' ? 'done' : '已执行');
      t.setHint ? t.setHint(safeText(text)) : null;
      toast(safeText(text));
    } else {
      const code = String((r && r.code) || 'unknown');
      const err = String((r && r.error) || '');
      t.setHint ? t.setHint((lang() === 'en' ? 'failed: ' : '失败: ') + code) : null;
      toast((lang() === 'en' ? 'not executed: ' : '没有执行: ') + code + (err ? '\n' + safeText(err) : ''));
    }
    state.pending = null;
    state.selectedGroupRef = '';
    await refreshAll();
  }

  // ── 刷新 ──────────────────────────────────────────────────────────────────
  async function refreshAll() {
    const t = T();
    if (!t) {
      dynText('#tasks-signing', '手机内核未就绪 (mobile-core 没加载)', 'phone kernel not ready');
      return;
    }
    const canSign = !!t.deviceSigning();
    const signingEl = $('#tasks-signing');
    if (signingEl) signingEl.setAttribute('data-signing', canSign ? 'yes' : 'no');
    setText('#tasks-hint', t.hint ? t.hint() : '');
    dynText('#tasks-signing', canSign
      ? '本机可做设备签名 (Ed25519) —— 高风险动作必须由它签名'
      : '⚠ 本机 WebView 不支持签名 —— 高风险动作请在桌面端执行',
    canSign
      ? 'this device can sign (Ed25519) — risky actions need it'
      : '⚠ this WebView cannot sign — run risky actions on the desktop');

    const g = await t.listGroups();
    state.groups = (g && g.ok && Array.isArray(g.data)) ? g.data.map((x) => ({ id: x.id, name: x.name })) : [];
    state.groups.some((x) => x.id === state.selectedGroupRef) || (state.selectedGroupRef = state.groups[0] ? state.groups[0].id : '');
    state.groupsView = (g && g.ok && Array.isArray(g.data)) ? g.data : [];
    renderGroups();
    renderTrailGroupPicker();

    const b = await t.loadBoard();
    state.board = b && b.ok ? b.data : {};
    renderBoard();

    const f = await t.loadFlywheel();
    state.flywheel = f && f.ok ? f.data : {};
    renderFlywheel();

    if (state.selectedGroupRef) await loadTrailNow();
  }

  function renderTrailGroupPicker() {
    const list = $('#tasks-trail-group-picker');
    if (!list) return;
    clear(list);
    if (!state.groups.length) { list.appendChild(line('sheet-text', lang() === 'en' ? 'join a group to see its trail' : '入群后可以看群里这一期的痕迹')); return; }
    state.groups.forEach((g, i) => {
      const view = state.groupsView[i] || {};
      const b = mk('button', 'sheet-choice');
      bilingual(b, String(view.name || ''), String(view.name || ''));
      b.setAttribute('data-pick-trail', String(i));
      if (g.id === state.selectedGroupRef) b.style.borderColor = 'var(--accent)';
      b.addEventListener('click', async () => {
        state.selectedGroupRef = g.id;
        renderTrailGroupPicker();
        await loadTrailNow();
      });
      list.appendChild(b);
    });
  }

  async function loadTrailNow() {
    const t = T();
    if (!t || !state.selectedGroupRef) return;
    const r = await t.loadTrail({ groupRef: state.selectedGroupRef });
    state.trail = (r && r.ok) ? r.data : null;
    if (!r || !r.ok) setText('#tasks-hint', (lang() === 'en' ? 'trail read failed: ' : '读群痕迹失败: ') + String((r && r.code) || '') + ' ' + String((r && r.error) || ''));
    renderTrail();
  }

  function bindEvents() {
    const tab = document.querySelector('.tab[data-tab="tasks"]');
    if (tab) tab.addEventListener('click', () => { applyLang(); refreshAll(); });
    const r = $('#tasks-refresh');
    if (r) r.addEventListener('click', refreshAll);
    const j = $('#tasks-group-join');
    if (j) j.addEventListener('click', askJoin);
    const c = $('#tasks-group-create');
    if (c) c.addEventListener('click', askCreate);
    const p = $('#tasks-pub-submit');
    if (p) p.addEventListener('click', askPublish);
    const tr = $('#tasks-trail-refresh');
    if (tr) tr.addEventListener('click', loadTrailNow);
    const pv = $('#task-confirm-preview');
    if (pv) pv.addEventListener('click', refreshPreview);
    const yes = $('#task-confirm-yes');
    if (yes) yes.addEventListener('click', doConfirmed);
    const no = $('#task-confirm-no');
    if (no) no.addEventListener('click', () => { state.pending = null; closeSheet(); });

    // 相对时间: 每 30s 只改 .rel-time 文字节点 (不重渲染, 不动结构)
    setInterval(() => {
      document.querySelectorAll('.rel-time[data-at]').forEach((el) => {
        const next = relText(Number(el.getAttribute('data-at')) || 0);
        if (next && el.textContent !== next) el.textContent = next;
      });
      document.querySelectorAll('.rel-time[data-delta]').forEach((el) => {
        const next = relDeltaText(Number(el.getAttribute('data-delta')) || 0);
        if (next && el.textContent !== next) el.textContent = next;
      });
    }, 30000);

    applyLang();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindEvents);
  else bindEvents();

  // 供验收脚本/壳层驱动 (真 headless DOM 用): 只暴露行为入口, 不暴露数据
  window.__mobileUpdateUi = { open: () => openUpdatePage(), openSettings: () => openSettings() };
  window.__mobileTasksUi = {
    refresh: refreshAll, askJoin: askJoin, askCreate: askCreate, askPublish: askPublish,
    askTrail: askTrail, askAnnounceToGroup: askAnnounceToGroup, confirm: doConfirmed,
    preview: refreshPreview, lang: window.__mobileLang, state: state,
  };
})();
