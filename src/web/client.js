// marked 库可能从 CDN 加载失败, 这里做安全降级 (避免 ReferenceError 让 addMessage 整体崩溃)
if (typeof marked === 'undefined') {
  window.marked = { parse: (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') };
}

const messagesEl = document.getElementById('messages');
const agentStatusEl = document.getElementById('agent-status');
const agentStatusTextEl = document.getElementById('agent-status-text');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const themeToggle = document.getElementById('theme-toggle');
const channelList = document.getElementById('channel-list');
const newChannelBtn = document.getElementById('new-channel-btn');
const newChannelInput = document.getElementById('new-channel-input');
const channelNameEl = document.getElementById('channel-name');
const loadSessionBtn = document.getElementById('load-session-btn');
const sessionFileInput = document.getElementById('session-file-input');
const newSessionBtn = document.getElementById('new-session-btn'); // 兼容旧引用（右上角按钮已移除）

let eventSources = new Map(); // channelId -> EventSource
let currentChannelId = null;
let currentAgentId = '';
let channels = [];
let remoteChannels = []; // v3: 远端 channel UI 元数据 (按 peer 分组)
let isSidebarCollapsed = false;
let reconnectAttempts = new Map(); // channelId -> attempts
let reconnectTimers = new Map(); // channelId -> timer
let heartbeatTimers = new Map(); // channelId -> setInterval handle (防止泄漏)
let lastUserCommand = ''; // 防止用户消息重复显示

// 2026-06-10: P2P peer-group 折叠状态持久化 (跨刷新)
// key = bolloon.p2p.collapsedPeers, value = JSON array of publicKey hex
const COLLAPSED_PEERS_KEY = 'bolloon.p2p.collapsedPeers';
const SEEN_PEERS_KEY = 'bolloon.p2p.seenPeers';
let collapsedPeers = (function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_PEERS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
let seenPeers = (function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_PEERS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
function saveCollapsedPeers() {
  try { localStorage.setItem(COLLAPSED_PEERS_KEY, JSON.stringify([...collapsedPeers])); } catch {}
}
function saveSeenPeers() {
  try { localStorage.setItem(SEEN_PEERS_KEY, JSON.stringify([...seenPeers])); } catch {}
}
function togglePeerCollapsed(peerPk) {
  if (collapsedPeers.has(peerPk)) {
    collapsedPeers.delete(peerPk);
  } else {
    collapsedPeers.add(peerPk);
  }
  saveCollapsedPeers();
  renderRemoteChannels();
  // 2026-06-10: 通知 header 切换按钮同步图标
  if (typeof window.__syncP2PToggleAllBtn === 'function') window.__syncP2PToggleAllBtn();
}
// 2026-06-10: 一键展开/折叠所有 P2P peer (header 按钮调用)
function expandAllPeers() {
  // 从 remoteChannels + knownPeers 收集所有 publicKey
  const allPks = new Set([
    ...knownPeers.map(p => p.publicKey),
    ...remoteChannels.map(g => g.peerId)
  ]);
  for (const pk of allPks) collapsedPeers.delete(pk);
  saveCollapsedPeers();
  renderRemoteChannels();
  if (typeof window.__syncP2PToggleAllBtn === 'function') window.__syncP2PToggleAllBtn();
}
function collapseAllPeers() {
  const allPks = new Set([
    ...knownPeers.map(p => p.publicKey),
    ...remoteChannels.map(g => g.peerId)
  ]);
  for (const pk of allPks) collapsedPeers.add(pk);
  saveCollapsedPeers();
  renderRemoteChannels();
  if (typeof window.__syncP2PToggleAllBtn === 'function') window.__syncP2PToggleAllBtn();
}
let lastAiContent = ''; // 防止 AI 消息重复显示
let messagesContainers = new Map(); // channelId -> messages container div
let sessionMessages = new Map(); // channelId:sessionId -> messages array
let currentSessionId = null; // 当前显示的 session ID
let expandedAgents = new Set(); // 当前展开的 agent(channel) id 集合

function generateId() {
  return crypto.randomUUID();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

async function loadTheme() {
  try {
    const res = await fetch('/theme');
    const data = await res.json();
    applyTheme(data.theme);
    if (data.agentId) {
      currentAgentId = data.agentId;
    }
    return data;
  } catch {
    applyTheme('dark');
    return { theme: 'dark', agentId: '' };
  }
}

async function saveTheme(theme, agentId) {
  try {
    await fetch('/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, agentId })
    });
  } catch (err) {
    console.error('Failed to save theme:', err);
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveTheme(next, currentAgentId);
}

function toggleSidebar() {
  isSidebarCollapsed = !isSidebarCollapsed;

  if (isSidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }
}

function expandSidebar() {
  isSidebarCollapsed = false;
  sidebar.classList.remove('collapsed');
}

async function loadChannels() {
  try {
    const res = await fetch('/channels');
    channels = await res.json();
    console.log('[加载频道] 从服务器获取到', channels.length, '个频道');
    channels.forEach((ch, i) => {
      console.log(`  [${i}] ${ch.name} - did: "${ch.did}"`);
    });
    renderChannels();
  } catch (err) {
    console.error('[加载频道] 失败:', err);
  }
}

// v3: 全局 SSE 监听 (p2p-global channel) - 接收远端 chat.reply 等事件
let v3GlobalEventSource = null;
function startV3GlobalSSE() {
  if (v3GlobalEventSource) return;
  try {
    v3GlobalEventSource = new EventSource('/events?channelId=p2p-global');
    v3GlobalEventSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'remote-chat-reply') {
          // 2026-06-10: 复用本地 addMessage 渲染 — 自动 marked + 剥 think/env + 主题样式
          // 之前是 textContent 硬编码灰底, 跟 Step 3 重写的 modal 风格不一致,
          // 而且 SSE 异步回到时 modal 可能已被切到 thinking 占满, 用户看不到 reply.
          const log = document.getElementById('rcm-log');
          const thinkingEl = document.getElementById('rcm-thinking');
          if (thinkingEl) thinkingEl.style.display = 'none'; // 思考结束, 隐藏
          // 也清掉 "对方正在思考..." 行 (流式 token 留下的)
          const liveThinking = document.getElementById('rcm-thinking-live');
          if (liveThinking) liveThinking.remove();
          if (log) {
            if (msg.error) {
              // 错误用 sysmsg 样式 (跟 modal 风格一致)
              const errEl = document.createElement('div');
              errEl.className = 'remote-chat-sysmsg remote-chat-sysmsg-error';
              errEl.textContent = `❌ 对方回复出错: ${msg.error}`;
              log.appendChild(errEl);
            } else {
              // 走本地 addMessage, 跟主聊天框完全一致 (marked + think/env 折叠 + 主题色)
              const prefix = `🤖 远端 AI 回复\n\n`;
              addMessage(prefix + (msg.text || '(空回复)'), 'ai', false, log);
            }
            log.scrollTop = log.scrollHeight;
          } else {
            // modal 没开 → 用右下 toast 提示用户"对方回了, 打开聊天看"
            if (typeof showSimpleToast === 'function') {
              const preview = (msg.text || '').slice(0, 50);
              showSimpleToast(`💬 远端 channel 有新回复: ${preview}${msg.text && msg.text.length > 50 ? '…' : ''}`);
            }
          }
        } else if (msg.type === 'remote-chat-thinking') {
          // v3 新增: B 端实时显示 A 节点的思考过程
          const phase = msg.phase;
          const log = document.getElementById('rcm-log');
          if (!log) return;

          if (phase === 'start') {
            // 头部插入"判断力依据"区块 (只第一次)
            const judgments = msg.usedJudgments || { bound: [], candidates: [] };
            const judgmentBlock = document.createElement('div');
            judgmentBlock.className = 'rcm-judgment-block';
            judgmentBlock.style.cssText = 'margin:6px 0;padding:8px 10px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;';
            let jh = '<div style="font-weight:600;color:#92400e;margin-bottom:4px;">🛡️ 对方使用的判断力 (来自 ta 的 channel)</div>';
            if (judgments.bound && judgments.bound.length > 0) {
              jh += '<div style="color:#78350f;margin-bottom:4px;"><b>硬绑定</b> (必须遵循):</div>';
              for (const j of judgments.bound) {
                jh += `<div style="margin:2px 0;padding-left:8px;">• <b>${escapeHtml((j.decision || '').slice(0, 80))}</b>${j.reasons && j.reasons.length ? '<br><span style="color:#92400e;font-size:11px;">理由: ' + escapeHtml(j.reasons.join('; ').slice(0, 80)) + '</span>' : ''}</div>`;
              }
            }
            if (judgments.candidates && judgments.candidates.length > 0) {
              jh += `<div style="color:#78350f;margin-top:4px;"><b>候选池</b> (${judgments.candidates.length} 条, LLM 自选)</div>`;
            }
            log.appendChild(judgmentBlock);
            // "思考中" 区块
            const thinkingEl = document.createElement('div');
            thinkingEl.id = 'rcm-thinking-live';
            thinkingEl.style.cssText = 'margin:6px 0;padding:8px 10px;background:#ede9fe;border-left:3px solid #8b5cf6;border-radius:4px;font-size:12px;color:#5b21b6;font-style:italic;';
            thinkingEl.textContent = '💭 对方正在思考...';
            log.appendChild(thinkingEl);
            log.scrollTop = log.scrollHeight;
          } else if (phase === 'token') {
            // 实时更新思考中的 partial
            const thinkingEl = document.getElementById('rcm-thinking-live');
            if (thinkingEl) {
              thinkingEl.textContent = '💭 对方正在思考: ' + (msg.partial || '').slice(-200);
              log.scrollTop = log.scrollHeight;
            }
          }
        } else if (msg.type === 'cross-mention-received') {
          // v3 新增: A 节点上, 某个 channel 的 LLM @-mention 了另一个 channel, SSE 推过来
          // 在所有打开的 chat modal 上显示"AI 跨渠道 @-mention" 提示
          const allModals = document.querySelectorAll('.rcm-mention-toast, [id^="rcm-log"]');
          for (const log of allModals) {
            if (!log.id) continue;
            const toast = document.createElement('div');
            toast.style.cssText = 'margin:6px 0;padding:8px 10px;background:#fce7f3;border-left:3px solid #ec4899;border-radius:4px;font-size:12px;color:#831843;';
            const fromTxt = msg.source === 'ai-mention-remote' ? `远端节点 ${(msg.fromPublicKey || '').substring(0, 8)}… 的 ${msg.originChannelName}` : `${msg.originChannelName} (本地)`;
            toast.innerHTML = `📡 <b>${fromTxt}</b> @-mention → 当前 channel: <i>${escapeHtml((msg.text || '').slice(0, 100))}</i>${msg.text && msg.text.length > 100 ? '…' : ''}`;
            log.appendChild(toast);
            log.scrollTop = log.scrollHeight;
          }
        } else if (msg.type === 'remote-channel-update') {
          // v3 新增: 远端节点发来新分享 / 删除 / 改名, 立即更新本地 cache
          const peerId = msg.peerId;
          const channels = msg.channels || [];
          let group = remoteChannels.find(g => g.peerId === peerId);
          if (!group) {
            group = { peerId, channels: [], peerName: msg.peerName || ('peer-' + peerId.substring(0, 8)) };
            remoteChannels.push(group);
          }
          group.channels = channels;
          renderRemoteChannels();
          console.log(`[v3] 收到远端 ${peerId.substring(0,12)}... 的 ${channels.length} 个 channel 更新`);
        } else if (msg.type === 'friend-request') {
          // v3 新增: 收到好友申请
          showFriendRequestModal(msg);
        } else if (msg.type === 'friend-request-ack') {
          // 2026-06-10: 收到对方 ack, 给发送方提示"已送达"
          const pending = window.__pendingFriendRequests;
          if (pending && msg.requestId && pending.has(msg.requestId)) {
            const { name } = pending.get(msg.requestId);
            pending.delete(msg.requestId);
            console.log(`[v3-friend] ✅ ack 收到: ${name} 已收到好友申请`);
            // 简短 toast (右下角), 不阻塞
            showSimpleToast(`📬 ${name} 已收到你的好友申请, 等对方接受`);
          }
        }
      } catch (err) {
        console.error('[v3] 全局 SSE 解析失败:', err);
      }
    };
    v3GlobalEventSource.onerror = (e) => {
      console.warn('[v3] 全局 SSE 错误');
    };
  } catch (err) {
    console.error('[v3] 启动全局 SSE 失败:', err);
  }
}

async function createChannel(name) {
  if (!name.trim()) return;
  try {
    const res = await fetch('/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), agentId: currentAgentId })
    });
    const channel = await res.json();
    console.log('[创建频道] 服务器返回:', channel);
    console.log('[创建频道] DID:', channel.did, 'CID:', channel.cid);

    // 立即添加频道并切换（不等待 DID）
    channels.push(channel);
    renderChannels();
    selectChannel(channel.id);
    if (newChannelInput) newChannelInput.value = '';

    // 后台更新 DID（如果还没有的话）
    if (!channel.did || channel.did === 'undefined') {
      console.log('[创建频道] 后台生成 DID...');
      // 复用全局 channelRefreshTimer, 把多个刷新请求合并成一个 1.5s 后的请求
      scheduleChannelsRefresh();
    }
  } catch (err) {
    console.error('Failed to create channel:', err);
  }
}

async function deleteChannel(channelId, e) {
  e.stopPropagation();
  if (!confirm('确定要删除该智能体及其所有会话吗？此操作不可撤销。')) return;
  try {
    await fetch(`/channels/${channelId}`, { method: 'DELETE' });
    channels = channels.filter(c => c.id !== channelId);
    expandedAgents.delete(channelId);

    // 释放浏览器侧引用 + DOM, 避免长时间使用后内存累积
    cleanupChannelState(channelId);

    if (currentChannelId === channelId) {
      currentChannelId = channels[0]?.id || null;
      currentSessionId = null;
      if (currentChannelId) {
        const ch = channels.find(c => c.id === currentChannelId);
        if (channelNameEl) channelNameEl.textContent = ch?.name || 'Bolloon Agent';
        await selectChannel(currentChannelId);
      } else {
        messagesEl.innerHTML = '';
        if (channelNameEl) channelNameEl.textContent = 'Bolloon Agent';
      }
    }
    renderChannels();
    renderCollapsedChannels();
  } catch (err) {
    console.error('Failed to delete channel:', err);
  }
}

/** 释放一个 channel 在浏览器侧占用的所有资源 (DOM 容器, SSE, 缓存 session 消息) */
function cleanupChannelState(channelId) {
  // 1. SSE 连接
  if (eventSources.has(channelId)) {
    try { eventSources.get(channelId).close(); } catch {}
    eventSources.delete(channelId);
  }
  // 2. 心跳 + 重连 timer
  if (heartbeatTimers.has(channelId)) {
    clearInterval(heartbeatTimers.get(channelId));
    heartbeatTimers.delete(channelId);
  }
  if (reconnectTimers.has(channelId)) {
    clearTimeout(reconnectTimers.get(channelId));
    reconnectTimers.delete(channelId);
  }
  reconnectAttempts.delete(channelId);
  // 3. 消息容器 DOM — 真从 #messages 里移除, 不只是隐藏
  const container = messagesContainers.get(channelId);
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
  messagesContainers.delete(channelId);
  // 4. 缓存的所有 session 消息 (按 channel:session 索引)
  const prefix = `${channelId}:`;
  for (const key of sessionMessages.keys()) {
    if (key === channelId || key.startsWith(prefix)) {
      sessionMessages.delete(key);
    }
  }
}

async function createNewSession() {
  if (!currentChannelId) {
    console.log('[新会话] 没有选中的频道');
    return;
  }
  try {
    // 保存当前 session 的消息
    saveCurrentSessionMessages();

    const res = await fetch(`/channels/${currentChannelId}/sessions`, {
      method: 'POST'
    });
    const data = await res.json();
    console.log('[新会话] 创建成功:', data);

    // 更新本地频道数据
    const channel = channels.find(c => c.id === currentChannelId);
    if (channel) {
      if (!channel.sessions) channel.sessions = [];
      channel.sessions.push(data.session);
      channel.currentSessionId = data.currentSessionId;
    }

    // 切换到新 session
    currentSessionId = data.currentSessionId;

    // 清空容器并加载新 session
    const container = messagesContainers.get(currentChannelId);
    if (container) {
      container.innerHTML = '';
      showChannelView(currentChannelId);
      addMessage('你好！新会话已开始，有什么我可以帮你的吗？', 'ai', false, container);
    }

    // 展开当前智能体，刷新侧边栏让新会话显示出来
    expandedAgents.add(currentChannelId);
    renderChannels();

    console.log('[新会话] 已切换到:', data.currentSessionId);
  } catch (err) {
    console.error('Failed to create new session:', err);
  }
}

async function createNewSessionForChannel(channelId, e) {
  if (e) e.stopPropagation();
  if (!channelId) return;

  // 给自己创建：复用统一的 createNewSession
  if (channelId === currentChannelId) {
    if (currentSessionId) saveCurrentSessionMessages();
    await createNewSession();
    return;
  }

  // 给别的智能体创建：后端建好后直接 re-fetch 一次保持本地与后端一致
  try {
    const res = await fetch(`/channels/${channelId}/sessions`, { method: 'POST' });
    if (!res.ok) throw new Error('create session failed');
    const data = await res.json();
    const channel = channels.find(c => c.id === channelId);
    if (channel) {
      if (!channel.sessions) channel.sessions = [];
      channel.sessions.push(data.session);
      channel.currentSessionId = data.currentSessionId;
    }
    expandedAgents.add(channelId);
    renderChannels();
  } catch (err) {
    console.error('Failed to create new session:', err);
  }
}

async function switchSession(channelId, sessionId, e) {
  if (e) e.stopPropagation();
  if (!channelId || !sessionId) return;
  if (channelId === currentChannelId && sessionId === currentSessionId) return;

  // 先保存当前 session 的本地消息
  if (currentChannelId && currentSessionId) {
    saveCurrentSessionMessages();
  }

  try {
    const res = await fetch(`/channels/${channelId}/sessions/${sessionId}/switch`, { method: 'POST' });
    if (!res.ok) throw new Error('switch failed');
    const channel = channels.find(c => c.id === channelId);
    if (channel) {
      channel.currentSessionId = sessionId;
      await saveChannels();
    }

    // 切换到目标 agent + session
    await selectChannel(channelId, sessionId);
    renderChannels();
  } catch (err) {
    console.error('Failed to switch session:', err);
  }
}

async function deleteSession(channelId, sessionId, e) {
  if (e) e.stopPropagation();
  if (!confirm('确定要删除该会话吗？此操作不可撤销。')) return;
  try {
    const res = await fetch(`/channels/${channelId}/sessions/${sessionId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || '删除失败');
      return;
    }
    const data = await res.json();
    const channel = channels.find(c => c.id === channelId);
    if (channel) {
      if (channel.sessions) {
        channel.sessions = channel.sessions.filter(s => s.id !== sessionId);
      }
      if (data.currentSessionId) {
        channel.currentSessionId = data.currentSessionId;
      }
    }

    // 如果删的是当前打开的会话，切换到新的当前会话
    if (channelId === currentChannelId && sessionId === currentSessionId) {
      if (data.currentSessionId) {
        currentSessionId = data.currentSessionId;
        const container = messagesContainers.get(channelId);
        if (container) container.innerHTML = '';
        await loadSession(channelId);
      }
    }
    renderChannels();
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
}

let _saveSessionMessagesDirty = false;
let _saveSessionMessagesTimer = null;
function saveCurrentSessionMessages() {
  if (!currentChannelId || !currentSessionId) return;
  // 内存保护: 多次快速调用合并成一个, 避免在切会话时反复 .textContent 读 DOM
  // (每个 textContent 会序列化整棵子树, 200 条消息 = 几百 MB 临时字符串)
  _saveSessionMessagesDirty = true;
  if (_saveSessionMessagesTimer) return;
  _saveSessionMessagesTimer = setTimeout(() => {
    _saveSessionMessagesTimer = null;
    if (!_saveSessionMessagesDirty) return;
    _saveSessionMessagesDirty = false;
    if (!currentChannelId || !currentSessionId) return;
    const container = messagesContainers.get(currentChannelId);
    if (!container) return;
    const messages = Array.from(container.querySelectorAll('.message')).map(msg => ({
      type: msg.classList.contains('message-user') ? 'user' : 'ai',
      content: msg.querySelector('.message-content')?.textContent || ''
    }));
    if (messages.length > 0) {
      sessionMessages.set(`${currentChannelId}:${currentSessionId}`, messages);
    }
  }, 50);
}

async function saveChannels() {
  // 简单地 re-fetch，保持本地 channels 与服务端一致
  // 改成走 scheduleChannelsRefresh, 多个调用合并成一个请求 — 减少内存峰值和后端压力
  scheduleChannelsRefresh();
  await new Promise(r => setTimeout(r, 600));
}

let channelRefreshTimer = null;
let channelRefreshInFlight = null;
function scheduleChannelsRefresh() {
  if (channelRefreshTimer) return;
  channelRefreshTimer = setTimeout(async () => {
    channelRefreshTimer = null;
    if (channelRefreshInFlight) return channelRefreshInFlight;
    channelRefreshInFlight = (async () => {
      try {
        const res = await fetch('/channels');
        if (res.ok) {
          const fresh = await res.json();
          channels = fresh;
          renderChannels();
        }
      } catch (err) {
        console.error('Failed to re-fetch channels:', err);
      } finally {
        channelRefreshInFlight = null;
      }
    })();
    return channelRefreshInFlight;
  }, 800);
}

function toggleAgentExpand(channelId, e) {
  if (e) e.stopPropagation();
  if (expandedAgents.has(channelId)) {
    expandedAgents.delete(channelId);
  } else {
    expandedAgents.add(channelId);
  }
  renderChannels();
}

function renderChannels() {
  if (!channelList) return;
  channelList.innerHTML = '';

  const fragment = document.createDocumentFragment();

  // 滚动可见性监听只绑定一次 (channelList 是同一个 DOM 节点,
  // renderChannels 每次清空 innerHTML 都会重渲, 不能重复 addEventListener)
  if (!channelList._scrollListenersBound) {
    const onUserScroll = () => {
      channelList.classList.add('is-scrolling');
      if (channelList._scrollIdleTimer) clearTimeout(channelList._scrollIdleTimer);
      channelList._scrollIdleTimer = setTimeout(() => {
        channelList.classList.remove('is-scrolling');
      }, 1200);
    };
    channelList.addEventListener('wheel', onUserScroll, { passive: true });
    channelList.addEventListener('touchmove', onUserScroll, { passive: true });
    channelList.addEventListener('keydown', (ev) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(ev.key)) {
        onUserScroll();
      }
    });
    channelList._scrollListenersBound = true;
  }

  channels.forEach(ch => {
    const li = document.createElement('li');
    const isExpanded = expandedAgents.has(ch.id);
    li.className = `agent-group ${isExpanded ? 'expanded' : ''}`;
    li.dataset.channelId = ch.id;

    // --- 智能体行 ---
    const row = document.createElement('div');
    row.className = `agent-row ${ch.id === currentChannelId ? 'active' : ''}`;

    // 找到当前智能体（如果它是激活的）的当前 session
    const currentSess = (ch.id === currentChannelId && Array.isArray(ch.sessions))
      ? ch.sessions.find(s => s.id === ch.currentSessionId)
      : null;
    const currentSessLabel = currentSess ? formatSessionName(currentSess) : '';
    const sessionCount = Array.isArray(ch.sessions) ? ch.sessions.length : 0;

    // 2026-06-10: 隐藏 channel 行右侧的勋章 (钱包 / 工具) — UI 简洁
    const walletBadge = '';
    const toolsBadge = '';

    row.innerHTML = `
      <svg class="agent-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
      <div class="channel-icon">💬</div>
      <span class="channel-name" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</span>
      <span class="agent-row-meta">
        ${walletBadge}
        ${toolsBadge}
        ${sessionCount > 1 ? `<span class="agent-session-count" title="${sessionCount} 个会话">${sessionCount}</span>` : ''}
        ${currentSessLabel ? `<span class="agent-current-session" title="当前会话：${escapeHtml(currentSessLabel)}">· ${escapeHtml(currentSessLabel)}</span>` : ''}
        <button class="agent-config-btn" title="配置智能体 (钱包 / 工具)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
        <button class="channel-delete" title="删除智能体">×</button>
      </span>
    `;

    // 行点击：切换展开；点击名字/图标区域则切到该智能体
    row.addEventListener('click', (ev) => {
      // 如果点在删除/配置按钮上, 单独处理
      if (ev.target.closest('.channel-delete')
          || ev.target.closest('.agent-config-btn')) return;
      if (ev.target.closest('.agent-caret')) {
        toggleAgentExpand(ch.id, ev);
        return;
      }
      toggleAgentExpand(ch.id, ev);
      if (ch.id !== currentChannelId) {
        expandSidebar();
        selectChannel(ch.id);
      }
    });

    // 智能体删除
    row.querySelector('.channel-delete').addEventListener('click', (ev) => deleteChannel(ch.id, ev));
    // 配置按钮: 打开同一个 modal 编辑已有智能体
    row.querySelector('.agent-config-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      openAgentAddModal(ch);
    });

    li.appendChild(row);

    // --- Session 列表（仅展开时渲染 DOM）---
    const sessionUl = document.createElement('ul');
    sessionUl.className = 'session-list';
    if (isExpanded) {
      // "新建会话" 按钮 — 放在 session 列表最前面, 始终可见
      const newSessLi = document.createElement('li');
      newSessLi.className = 'session-new-item';
      newSessLi.setAttribute('role', 'button');
      newSessLi.setAttribute('tabindex', '0');
      newSessLi.title = '新建会话';
      newSessLi.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>新建会话</span>
      `;
      const onNewSession = (ev) => {
        ev.stopPropagation();
        createNewSessionForChannel(ch.id, ev);
      };
      newSessLi.addEventListener('click', onNewSession);
      newSessLi.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onNewSession(ev);
        }
      });
      sessionUl.appendChild(newSessLi);

      const sessions = Array.isArray(ch.sessions) ? ch.sessions : [];
      sessions.forEach(sess => {
        const sessLi = document.createElement('li');
        const isActive = ch.id === currentChannelId && sess.id === ch.currentSessionId;
        sessLi.className = `session-item ${isActive ? 'active' : ''}`;
        sessLi.innerHTML = `
          <span class="session-name" title="${escapeHtml(formatSessionName(sess))}">${escapeHtml(formatSessionName(sess))}</span>
          <button class="session-delete" title="删除会话">×</button>
        `;
        sessLi.addEventListener('click', (ev) => {
          if (ev.target.closest('.session-delete')) return;
          switchSession(ch.id, sess.id, ev);
        });
        sessLi.querySelector('.session-delete').addEventListener('click', (ev) => deleteSession(ch.id, sess.id, ev));
        sessionUl.appendChild(sessLi);
      });
    }
    li.appendChild(sessionUl);

    fragment.appendChild(li);
  });

  channelList.appendChild(fragment);

  // header 钱包徽章计数: 只在 channels 变化时刷新, 避免每次 renderChannels 都重算
  refreshWalletBadge();

  // 把当前激活的 channel 平滑滚到视口内 — 用户切换后不会看不到
  // 只在非用户主动滚动状态下执行, 避免与正在进行的滚动冲突
  if (currentChannelId) {
    requestAnimationFrame(() => scrollActiveChannelIntoView(false));
  }
}

/** 把当前激活的 channel 滚到侧边栏视口内 */
function scrollActiveChannelIntoView(smooth = true) {
  if (!channelList || !currentChannelId) return;
  const active = channelList.querySelector(`.agent-group[data-channel-id="${currentChannelId}"]`);
  if (!active) return;
  const listRect = channelList.getBoundingClientRect();
  const itemRect = active.getBoundingClientRect();
  const margin = 24; // 视口上下各留 24px
  if (itemRect.top < listRect.top + margin) {
    channelList.scrollBy({ top: itemRect.top - listRect.top - margin, behavior: smooth ? 'smooth' : 'auto' });
  } else if (itemRect.bottom > listRect.bottom - margin) {
    channelList.scrollBy({ top: itemRect.bottom - listRect.bottom + margin, behavior: smooth ? 'smooth' : 'auto' });
  }
}

function formatSessionName(sess) {
  if (!sess) return '新会话';
  if (sess.preview && sess.preview.trim()) return sess.preview.trim();
  const id = sess.id || '';
  return id ? `会话 ${id.slice(-6)}` : '新会话';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderCollapsedChannels() {
  return;
}

function ensureMessageContainer(channelId) {
  if (!messagesContainers.has(channelId)) {
    const container = document.createElement('div');
    container.className = 'channel-messages';
    container.id = `channel-messages-${channelId}`;
    container.style.display = 'none';
    messagesEl.appendChild(container);
    messagesContainers.set(channelId, container);
  }
  return messagesContainers.get(channelId);
}

function showChannelView(channelId) {
  // Hide all channel message containers (不要 innerHTML='' 销毁, 保留以便快速切换)
  messagesContainers.forEach((container, cid) => {
    container.style.display = 'none';
  });
  // Show the selected channel's container
  const container = messagesContainers.get(channelId);
  if (container) {
    container.style.display = 'block';
  }
}

async function selectChannel(channelId, targetSessionId = null) {
  console.log('[selectChannel] 开始切换到:', channelId, 'targetSession:', targetSessionId);

  // 立即更新当前频道 ID
  currentChannelId = channelId;
  reconnectAttempts.set(channelId, 0);

  // v3: 盾牌弹窗打开时, 切 channel 要刷列表 (tab 标题 + 已绑/未绑 分组)
  if (typeof judgmentsModal !== 'undefined' && judgmentsModal && judgmentsModal.classList.contains('active')) {
    if (typeof lastJudgmentsCache !== 'undefined') renderJudgments(lastJudgmentsCache);
  }

  // 找到当前频道和 session
  const channel = channels.find(c => c.id === channelId);
  if (channel) {
    if (channelNameEl) channelNameEl.textContent = channel.name;
    currentSessionId = targetSessionId || channel.currentSessionId || 'default';
    if (targetSessionId) {
      channel.currentSessionId = targetSessionId;
    }
    // 自动展开当前智能体的会话列表，让用户能切换会话
    expandedAgents.add(channelId);
    console.log('[selectChannel] 频道:', channel.name, 'session:', currentSessionId);
  }

  renderChannels();

  // 确保该频道有消息容器
  const container = ensureMessageContainer(channelId);

  // 切换到该频道的视图
  showChannelView(channelId);

  // 如果还没有 SSE 连接，建立连接
  if (!eventSources.has(channelId)) {
    console.log('[selectChannel] 建立 SSE 连接');
    connect(channelId);
  }

  // 直接从 server 拉 session 消息 (container 跨 session 共享, 先清空再加载)
  container.innerHTML = '';
  try {
    const res = await fetch(`/sessions/${channelId}?sessionId=${encodeURIComponent(currentSessionId)}`);
    const session = await res.json();
    if (session.messages && session.messages.length > 0) {
      session.messages.forEach(msg => {
        addMessage(msg.content, msg.type, false, container);
      });
    } else {
      addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false, container);
    }
  } catch (err) {
    console.error('[selectChannel] 加载 session 失败:', err);
    addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false, container);
  }
}

async function loadSession(channelId, sessionId = null) {
  const container = messagesContainers.get(channelId);
  if (!container) return;
  const targetSessionId = sessionId || currentSessionId || 'default';
  try {
    const res = await fetch(`/sessions/${channelId}?sessionId=${encodeURIComponent(targetSessionId)}`);
    const session = await res.json();
    container.innerHTML = '';
    if (session.messages && session.messages.length > 0) {
      session.messages.forEach(msg => {
        addMessage(msg.content, msg.type, false, container);
      });
    } else {
      addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false, container);
    }
  } catch (err) {
    console.error('Failed to load session:', err);
    container.innerHTML = '';
    addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false, container);
  }
}

function addMessage(content, type, save = true, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;

  // 浏览器侧内存保护: 单个 channel 的消息容器超过 MAX_MESSAGES_PER_CHANNEL
  // 就从最旧的开始淘汰。SSE 流式场景下不淘汰 (save=true 时不裁剪),
  // 因为流消息一般很短; 只对长会话加载 (save=false) 做上限。
  // 上限是 200 条: 大约相当于 100 轮对话, 足够日常使用, 又把 DOM 控制在 5MB 以内.
  if (!save && msgContainer && msgContainer.children.length > 200) {
    const toRemove = msgContainer.children.length - 200;
    for (let i = 0; i < toRemove; i++) {
      const first = msgContainer.firstElementChild;
      if (first) msgContainer.removeChild(first);
    }
  }
  // 去重：只有 save=true 时（来自 SSE）才去重，save=false 时（来自 session 加载）直接显示
  if (save) {
    const lastContent = type === 'user' ? lastUserCommand : lastAiContent;
    if (lastContent && content === lastContent) {
      console.log(`[addMessage] 跳过重复的 ${type} 消息`);
      return;
    }
    if (type === 'user') {
      lastUserCommand = content;
    } else {
      lastAiContent = content;
    }
  }

  const div = document.createElement('div');
  div.className = `message message-${type}`;

  // 清理工具结果容器（当新的 AI 消息到达时）
  if (type === 'ai' && toolResultContainer) {
    toolResultContainer.remove();
    toolResultContainer = null;
  }

  // 清理内容：移除 tool call 标记和其他不应该显示的内容
  let cleanContent = content
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .replace(/TOOL_CALL[\s\S]*?\/TOOL_CALL/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/{\s*"tool":[\s\S]*?}/g, '')
    // 兼容 pi-sdk LLM 输出: {tool => "name", args => {...}}
    .replace(/\{\s*tool\s*=>\s*["'][^"']+["']\s*(?:,\s*args\s*=>\s*\{[\s\S]*?\})?\s*\}/g, '')
    .replace(/\[Function[^\]]*\]\s*/g, '')
    .trim();

  // 处理思维链内容（</think> 标签）- 折叠显示
  const thinkMatch = cleanContent.match(/<think>([\s\S]*?)<\/think>/);
  let mainContent = cleanContent;
  let thinkContainer = null;

  if (thinkMatch) {
    const thinkContent = thinkMatch[1].trim();
    mainContent = cleanContent.replace(/<think>[\s\S]*?<\/think>/, '').trim();

    // 创建思维链折叠区域
    thinkContainer = document.createElement('div');
    thinkContainer.className = 'think-container';

    const thinkToggle = document.createElement('div');
    thinkToggle.className = 'think-toggle';
    thinkToggle.innerHTML = '💭 思考过程 <span class="think-arrow">▸</span>';
    thinkToggle.onclick = function() {
      const details = thinkContainer.querySelector('.think-content');
      const arrow = thinkToggle.querySelector('.think-arrow');
      if (details.style.display === 'none') {
        details.style.display = 'block';
        arrow.textContent = '▾';
      } else {
        details.style.display = 'none';
        arrow.textContent = '▸';
      }
    };

    const thinkDiv = document.createElement('div');
    thinkDiv.className = 'think-content';
    thinkDiv.style.display = 'none'; // 默认折叠
    thinkDiv.innerHTML = `<pre>${thinkContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;

    thinkContainer.appendChild(thinkToggle);
    thinkContainer.appendChild(thinkDiv);
  }

  const envMatch = mainContent.match(/^(.+?)\n<environment_details>([\s\S]*?)<\/environment_details>\n([\s\S]*)$/);

  if (envMatch) {
    const identity = envMatch[1].trim();
    const envDetails = envMatch[2].trim();
    const messageBody = envMatch[3].trim();

    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = identity;
    div.appendChild(header);

    // 环境信息区域（可折叠，默认折叠）
    const envContainer = document.createElement('div');
    envContainer.className = 'env-container';

    const envToggle = document.createElement('div');
    envToggle.className = 'env-toggle';
    envToggle.innerHTML = '⚙️ 环境信息 <span class="env-arrow">▸</span>';
    envToggle.onclick = function() {
      const details = envContainer.querySelector('.environment-details');
      const arrow = envToggle.querySelector('.env-arrow');
      if (details.style.display === 'none') {
        details.style.display = 'block';
        arrow.textContent = '▾';
      } else {
        details.style.display = 'none';
        arrow.textContent = '▸';
      }
    };

    const envDiv = document.createElement('div');
    envDiv.className = 'environment-details';
    envDiv.style.display = 'none'; // 默认折叠
    envDiv.innerHTML = `<pre>${envDetails}</pre>`;

    envContainer.appendChild(envToggle);
    envContainer.appendChild(envDiv);
    div.appendChild(envContainer);

    // 思考在环境信息下面
    if (thinkContainer) {
      div.appendChild(thinkContainer);
    }

    if (messageBody) {
      const bubble = document.createElement('div');
      bubble.className = `bubble bubble-${type}`;
      bubble.innerHTML = marked.parse(messageBody);
      div.appendChild(bubble);
    }
  } else if (cleanContent) {
    // 没有环境信息时，思考放在消息之前
    if (thinkContainer) {
      div.appendChild(thinkContainer);
    }
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${type}`;
    bubble.innerHTML = marked.parse(cleanContent);
    div.appendChild(bubble);
  } else {
    return; // 没有有效内容，不显示空消息
  }

  // 提取纯文本内容用于复制（去除 HTML 标签）
  const rawContent = cleanContent
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  // AI 消息添加操作按钮
  if (type === 'ai') {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn copy-btn';
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> 复制`;
    copyBtn.title = '复制消息';
    copyBtn.onclick = function() {
      navigator.clipboard.writeText(rawContent).then(() => {
        copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> 已复制`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> 复制`;
        }, 2000);
      });
    };

    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'action-btn regenerate-btn';
    regenerateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg> 重新回答`;
    regenerateBtn.title = '重新生成回复';
    regenerateBtn.onclick = function() {
      regenerateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg> 生成中...`;
      regenerateBtn.disabled = true;
      // 获取当前频道对应的用户消息
      const messages = div.parentElement.querySelectorAll('.message');
      let lastUserMsg = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.classList.contains('message-user')) {
          const bubble = msg.querySelector('.bubble');
          if (bubble) {
            lastUserMsg = bubble.textContent || bubble.innerText || '';
            break;
          }
        }
      }
      // 调用重新生成 API
      fetch('/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: currentChannelId, userMessage: lastUserMsg })
      }).then(res => {
        if (!res.ok) {
          throw new Error('regenerate failed');
        }
      }).catch(err => {
        console.error('重新生成失败:', err);
        regenerateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg> 失败`;
        setTimeout(() => {
          regenerateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg> 重新回答`;
          regenerateBtn.disabled = false;
        }, 2000);
      });
    };

    actionsDiv.appendChild(copyBtn);

    // "存为判断" 按钮: 把这条消息正文作为 decision 存到判断库
    const saveJudgmentBtn = document.createElement('button');
    saveJudgmentBtn.className = 'action-btn save-as-judgment';
    saveJudgmentBtn.title = '把这条消息存为判断';
    saveJudgmentBtn.setAttribute('data-decision', rawContent.substring(0, 800)); // 截断防超长
    saveJudgmentBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4z"></path><path d="M9 12l2 2 4-4"></path></svg> 存为判断`;
    actionsDiv.appendChild(saveJudgmentBtn);
    if (type === 'ai') {
      actionsDiv.appendChild(regenerateBtn);
    }
    div.appendChild(actionsDiv);
  }

  div.appendChild(time);
  msgContainer.appendChild(div);

  msgContainer.scrollTop = msgContainer.scrollHeight;
}

// Agent status bar — sits between the message list and the input box.
// Two visual states: "planning" (spinner) and "executing" (glowing icon).
// The text alternates to convey the action loop.
let agentStatusState = null; // 'planning' | 'executing' | null
let agentStatusTextIdx = 0;

const AGENT_STATUS_TEXTS = {
  planning: ['正在计划', '正在分析', '正在思考'],
  executing: ['正在执行', '正在调用工具', '正在处理'],
};

function setAgentStatus(state) {
  if (!agentStatusEl || !agentStatusTextEl) return;
  if (state === null) {
    agentStatusEl.hidden = true;
    agentStatusEl.removeAttribute('data-mode');
    agentStatusState = null;
    return;
  }
  agentStatusEl.hidden = false;
  agentStatusEl.setAttribute('data-mode', state);
  agentStatusState = state;
  // 重排一下文本, 避免长时间停留过于单调
  agentStatusTextIdx = (agentStatusTextIdx + 1) % AGENT_STATUS_TEXTS[state].length;
  agentStatusTextEl.textContent = AGENT_STATUS_TEXTS[state][agentStatusTextIdx];
}

function showTyping(container) {
  hideTyping();
  // 兼容旧路径: container 参数保留但不再使用, status bar 是全局唯一的
  void container;
  setAgentStatus('planning');
}

function hideTyping() {
  setAgentStatus(null);
  // 兜底: 旧版本的 #typing 元素可能还残留在 DOM 里, 顺手清掉
  const old = document.getElementById('typing');
  if (old) old.remove();
  hideStreaming();
}

let streamingMessageEl = null;

function showStreaming(container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  hideStreaming();
  streamingMessageEl = document.createElement('div');
  streamingMessageEl.className = 'message message-ai';
  streamingMessageEl.id = 'streaming';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-ai streaming-content';
  streamingMessageEl.appendChild(bubble);
  msgContainer.appendChild(streamingMessageEl);
  msgContainer.scrollTop = msgContainer.scrollHeight;
}

function hideStreaming() {
  if (streamingMessageEl) {
    streamingMessageEl.remove();
    streamingMessageEl = null;
  }
}

function updateStreamingContent(content, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  if (streamingMessageEl) {
    const bubble = streamingMessageEl.querySelector('.streaming-content');
    if (bubble) {
      bubble.textContent = content;
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  }
}

function handleStreamEvent(data, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  // 始终确保有工作流显示区域
  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    msgContainer.appendChild(workflowDisplayEl);
  }

  if (data.streamType === 'thinking') {
    showStreaming(msgContainer);
    updateStreamingContent(data.content || '思考中...', msgContainer);
  } else if (data.streamType === 'token') {
    showStreaming(msgContainer);
    const current = streamingMessageEl?.querySelector('.streaming-content')?.textContent || '';
    updateStreamingContent(current + data.content, msgContainer);
  }
}

function handleStatusEvent(data, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  // 检查是否是工具调用结果
  const content = data.content || '';
  const isJsonResult = content.startsWith('{') && content.includes('"success"');

  if (isJsonResult) {
    // 工具结果：折叠显示
    showToolResult(data.tool, content, msgContainer);
  } else {
    // 普通状态：流式显示
    showStreaming(msgContainer);
    const icon = data.tool ? `🔧 ${data.tool}: ` : '';
    updateStreamingContent(icon + data.content, msgContainer);
  }
}

// 显示工具调用结果（折叠）
let toolResultContainer = null;

function showToolResult(toolName, resultJson, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  // 清理之前的流式显示
  hideStreaming();

  // 获取或创建工具结果容器
  if (!toolResultContainer) {
    toolResultContainer = document.createElement('div');
    toolResultContainer.className = 'tool-results-container';
    msgContainer.appendChild(toolResultContainer);
  }

  // 尝试解析并格式化 JSON
  let formattedResult = resultJson;
  try {
    const parsed = JSON.parse(resultJson);
    formattedResult = formatToolResult(parsed);
  } catch {}

  // 创建折叠项
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-result-item collapsed';

  const toolDisplayName = toolName || '工具结果';
  const headerEl = document.createElement('div');
  headerEl.className = 'tool-result-header';
  headerEl.innerHTML = `
    <span class="tool-result-icon">🔧</span>
    <span class="tool-result-name">${toolDisplayName}</span>
    <span class="tool-result-toggle">▸</span>
  `;
  // 绑定事件处理器（避免内联 onclick）
  headerEl.addEventListener('click', () => {
    resultEl.classList.toggle('collapsed');
    resultEl.classList.toggle('expanded');
  });

  const contentEl = document.createElement('div');
  contentEl.className = 'tool-result-content';
  contentEl.innerHTML = `<pre>${formattedResult}</pre>`;

  resultEl.appendChild(headerEl);
  resultEl.appendChild(contentEl);
  toolResultContainer.appendChild(resultEl);
  msgContainer.scrollTop = msgContainer.scrollHeight;
}

// 格式化工具结果为易读格式
function formatToolResult(obj, indent = 0) {
  const spaces = '  '.repeat(indent);

  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      return obj.map(item => spaces + '- ' + formatToolResult(item, indent + 1)).join('\n');
    }

    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';

    return keys.map(key => {
      const value = obj[key];
      if (typeof value === 'object') {
        return `${spaces}${key}:\n${formatToolResult(value, indent + 1)}`;
      }
      return `${spaces}${key}: ${value}`;
    }).join('\n');
  }

  return String(obj);
}

// 工作流状态显示
let workflowDisplayEl = null;

function createWorkflowDisplay() {
  const container = document.createElement('div');
  container.id = 'workflow-display';
  container.className = 'workflow-display';
  container.innerHTML = `
    <div class="workflow-header">
      <span class="workflow-icon">🔄</span>
      <span class="workflow-title">工作流执行中</span>
      <span class="workflow-loop-count"></span>
    </div>
    <div class="workflow-steps-list"></div>
    <div class="workflow-streams"></div>
  `;
  return container;
}

function handleTaskStatusEvent(data, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  console.log('[工作流] 任务状态:', data);

  // 获取或创建工作流显示区域
  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    msgContainer.appendChild(workflowDisplayEl);
  }

  const stepsList = workflowDisplayEl.querySelector('.workflow-steps-list');
  const header = workflowDisplayEl.querySelector('.workflow-header');

  // 更新标题
  if (data.taskId) {
    header.querySelector('.workflow-title').textContent = `任务: ${data.taskId.substring(0, 12)}...`;
  }

  // 更新状态
  if (data.status) {
    const statusText = header.querySelector('.workflow-title');
    statusText.textContent = `任务 ${data.status === 'running' ? '执行中' : data.status}`;
  }

  // 更新进度
  if (data.progress !== undefined) {
    header.querySelector('.workflow-title').textContent = `进度: ${data.progress}%`;
  }

  // 更新步骤
  if (data.currentStep !== undefined && data.totalSteps) {
    const stepEl = document.createElement('div');
    stepEl.className = 'workflow-step-item';
    stepEl.innerHTML = `
      <span class="step-running">⟳</span>
      <span>步骤 ${data.currentStep + 1}/${data.totalSteps}</span>
    `;
    stepsList.appendChild(stepEl);
  }

  // 完成时移除显示
  if (data.status === 'completed' || data.status === 'failed') {
    setTimeout(() => {
      if (workflowDisplayEl) {
        workflowDisplayEl.remove();
        workflowDisplayEl = null;
      }
    }, 3000);
  }
}

function handleWorkflowStepEvent(data, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  console.log('[工作流] 步骤:', data);
  console.log('[工作流] 步骤标签:', data.step, '内容:', data.content?.substring(0, 80));

  // 获取或创建工作流显示区域
  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    msgContainer.appendChild(workflowDisplayEl);
  }

  const streamsDiv = workflowDisplayEl.querySelector('.workflow-streams');
  const header = workflowDisplayEl.querySelector('.workflow-header');

  // 更新工作流标题
  if (data.step && data.step !== '系统' && data.step !== '状态') {
    header.querySelector('.workflow-title').textContent = `执行: ${data.step}`;
  }

  // 如果有步骤标签，显示步骤信息
  if (data.step && data.content) {
    const stepEl = document.createElement('div');
    stepEl.className = 'workflow-step-stream';

    // 根据内容类型选择不同样式
    const isError = data.content.includes('❌') || data.content.includes('错误');
    const isSuccess = data.content.includes('✅') || data.content.includes('成功');
    const isLoop = data.content.includes('🔄') || data.content.includes('循环');

    let icon = '🔧';
    if (isError) icon = '❌';
    else if (isSuccess) icon = '✅';
    else if (isLoop) icon = '🔄';

    stepEl.innerHTML = `
      <div class="step-label">${icon} ${data.step}</div>
      <div class="step-content">${data.content}</div>
    `;
    streamsDiv.appendChild(stepEl);

    // 自动滚动
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }
}

function handleWorkflowLoopEvent(data, container) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  console.log('[工作流] 循环:', data);

  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    msgContainer.appendChild(workflowDisplayEl);
  }

  const loopCount = workflowDisplayEl.querySelector('.workflow-loop-count');
  const streamsDiv = workflowDisplayEl.querySelector('.workflow-streams');

  // 更新循环次数 — 用户不需要看到 "循环 N", 只看步骤内容
  if (data.loopCount !== undefined) {
    // 不显示循环计数, 仅在内部保留
  }

  // 显示循环信息
  if (data.content) {
    const loopEl = document.createElement('div');
    loopEl.className = 'workflow-loop-item';
    loopEl.innerHTML = `
      <div class="loop-header">
        <span class="loop-icon">🔁</span>
        <span class="loop-status">${data.status || '执行中'}</span>
      </div>
      <div class="loop-content">${data.content}</div>
    `;
    streamsDiv.appendChild(loopEl);
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }
}

// 用户命令可视化 - 当用户发送命令时调用
let userCommandDisplayEl = null;

function showUserCommand(command, container, opts) {
  const msgContainer = container || messagesContainers.get(currentChannelId) || messagesEl;
  // 先移除之前的消息中的 user bubble（如果有重复的话）
  const existingUserBubbles = msgContainer.querySelectorAll('.message-user');
  existingUserBubbles.forEach(el => el.remove());

  // 移除之前的命令显示
  if (userCommandDisplayEl) {
    userCommandDisplayEl.remove();
  }

  // 创建美化版本的命令显示
  userCommandDisplayEl = document.createElement('div');
  userCommandDisplayEl.className = 'message message-user';
  // v3 新增: 远端访客消息加 tag (source === 'remote' 表示是 B 通过 P2P 发来的)
  const sourceTag = (opts && opts.source === 'remote')
    ? `<div style="font-size:10px;color:#6b7280;margin-bottom:2px;">🌐 远端访客${opts.fromPublicKey ? ' (' + opts.fromPublicKey.substring(0, 8) + '…)' : ''} → A 的 channel</div>`
    : '';
  userCommandDisplayEl.innerHTML = `
    <div class="user-command-display">
      <div class="command-prompt">
        <span class="prompt-icon">›</span>
        <span class="prompt-text">${command}</span>
      </div>
      ${sourceTag}
    </div>
  `;

  // 在工作流显示之前插入
  if (workflowDisplayEl) {
    msgContainer.insertBefore(userCommandDisplayEl, workflowDisplayEl);
  } else {
    msgContainer.appendChild(userCommandDisplayEl);
  }

  msgContainer.scrollTop = msgContainer.scrollHeight;
}

function connect(channelId) {
  const targetChannelId = channelId || currentChannelId;
  if (!targetChannelId) return;

  // 清除该频道的重连定时器
  if (reconnectTimers.has(targetChannelId)) {
    clearTimeout(reconnectTimers.get(targetChannelId));
    reconnectTimers.delete(targetChannelId);
  }

  // 清除该频道的心跳定时器 (防止多次调用 connect 导致 setInterval 累积)
  if (heartbeatTimers.has(targetChannelId)) {
    clearInterval(heartbeatTimers.get(targetChannelId));
    heartbeatTimers.delete(targetChannelId);
  }

  // 关闭该频道的旧连接
  if (eventSources.has(targetChannelId)) {
    eventSources.get(targetChannelId).close();
    eventSources.delete(targetChannelId);
  }

  const sseUrl = `/events?channelId=${encodeURIComponent(targetChannelId)}`;
  console.log('[connect] 创建 SSE 连接:', sseUrl);

  const eventSource = new EventSource(sseUrl);
  eventSources.set(targetChannelId, eventSource);

  if (!reconnectAttempts.has(targetChannelId)) {
    reconnectAttempts.set(targetChannelId, 0);
  }

  eventSource.onopen = () => {
    console.log('[SSE] 已连接 channelId:', targetChannelId);
    reconnectAttempts.set(targetChannelId, 0);
  };

  // 心跳超时: 如果 60s 没收到任何数据 (含 ping), 强制重建
  // 覆盖网络半开 / 浏览器没触发 onerror 的情况
  let lastEventTime = Date.now();
  const heartbeatTimer = setInterval(() => {
    if (!eventSources.has(targetChannelId)) {
      clearInterval(heartbeatTimer);
      return;
    }
    if (Date.now() - lastEventTime > 60000) {
      console.warn('[SSE] 60s 无数据, 强制重建连接:', targetChannelId);
      clearInterval(heartbeatTimer);
      try { eventSource.close(); } catch {}
      eventSources.delete(targetChannelId);
      // 退避重连 (有上限)
      const attempts = (reconnectAttempts.get(targetChannelId) || 0) + 1;
      reconnectAttempts.set(targetChannelId, attempts);
      const delay = Math.min(1000 * Math.pow(2, attempts - 1), 15000);
      const timer = setTimeout(() => connect(targetChannelId), delay);
      reconnectTimers.set(targetChannelId, timer);
    }
  }, 10000);

  // onerror: 不要手动 close — 浏览器 EventSource 会自动重连
  // 我们只需在 readyState 永久 CLOSED 时 (罕见) 才介入
  eventSource.onerror = () => {
    console.warn('[SSE] 错误, 浏览器自动重连中:', targetChannelId, 'readyState=', eventSource.readyState);
    if (eventSource.readyState === EventSource.CLOSED) {
      // 浏览器放弃重连, 我们接手
      clearInterval(heartbeatTimer);
      eventSources.delete(targetChannelId);
      const attempts = (reconnectAttempts.get(targetChannelId) || 0) + 1;
      reconnectAttempts.set(targetChannelId, attempts);
      const delay = Math.min(1000 * Math.pow(2, attempts - 1), 15000);
      const timer = setTimeout(() => connect(targetChannelId), delay);
      reconnectTimers.set(targetChannelId, timer);
    }
  };

  eventSource.onmessage = (e) => {
    lastEventTime = Date.now();
    try {
      const data = JSON.parse(e.data);
      const msgChannelId = data.channelId || targetChannelId;
      console.log('[SSE] 收到消息:', data.type, 'channelId:', msgChannelId);

      // 路由消息到正确的频道
      // 只有 envelope.channelId 存在且与目标不同时才丢弃 (空/undefined 视为广播给自己)
      if (msgChannelId && msgChannelId !== targetChannelId) {
        console.log('[SSE] 忽略非目标频道消息');
        return;
      }

      // 使用正确的消息容器
      const container = messagesContainers.get(msgChannelId) || messagesEl;

      if (data.type === 'user') {
        showUserCommand(data.content, container, { source: data.source, fromPublicKey: data.fromPublicKey });
      } else if (data.type === 'ai') {
        addMessage(data.content, 'ai', true, container);
        hideTyping();
      } else if (data.type === 'stream') {
        handleStreamEvent(data, container);
        setAgentStatus('executing');
      } else if (data.type === 'regenerating') {
        const messages = container.querySelectorAll('.message-ai');
        if (messages.length > 0) {
          const lastAiMsg = messages[messages.length - 1];
          lastAiMsg.remove();
        }
        showTyping(container);
      } else if (data.type === 'status') {
        handleStatusEvent(data, container);
        setAgentStatus('executing');
      } else if (data.type === 'done') {
        hideTyping();
        // AI 回复完, 把最后一条 ai 消息落盘 (兜底, 避免 server saveSession 漏写)
        const lastAi = container.querySelector('.message-ai:last-of-type .message-content');
        if (lastAi) {
          persistLastMessageToServer('ai', lastAi.textContent || '');
        }
      } else if (data.type === 'renamed') {
        const channel = channels.find(c => c.id === data.channelId);
        if (channel) {
          channel.name = data.newName;
          renderChannels();
          if (currentChannelId === data.channelId && channelNameEl) {
            channelNameEl.textContent = data.newName;
          }
        }
      } else if (data.type === 'error') {
        hideTyping();
        addMessage('错误: ' + data.content, 'ai', true, container);
      } else if (data.type === 'task_status') {
        handleTaskStatusEvent(data, container);
      } else if (data.type === 'workflow_step') {
        handleWorkflowStepEvent(data, container);
      } else if (data.type === 'workflow_loop') {
        handleWorkflowLoopEvent(data, container);
      }
    } catch (parseErr) {
      console.error('[SSE] 解析错误', parseErr);
    }
  };
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  showTyping();

  // 立即把用户消息落盘, 避免切走再切回时丢失
  persistLastMessageToServer('user', text);

  // 获取当前频道的 DID
  const channel = channels.find(c => c.id === currentChannelId);
  const channelDid = channel?.did || '';
  console.log('[发送消息] 频道 DID:', channelDid);

  try {
    const res = await fetch('/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        channelId: currentChannelId,
        channelDid
      })
    });

    if (!res.ok) {
      hideTyping();
      addMessage('发送失败', 'ai');
    }
  } catch (err) {
    hideTyping();
    addMessage('连接错误', 'ai');
    console.error('Send error', err);
  }
}

// 主动落盘: 把当前 channelId/sessionId 最后一条消息 PATCH 到 server
// fire-and-forget, 失败只打日志, 不影响 UI
function persistLastMessageToServer(type, content) {
  if (!currentChannelId || !currentSessionId) return;
  fetch(`/sessions/${currentChannelId}/${currentSessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { type, content, timestamp: new Date().toISOString() }
    })
  }).catch(err => {
    console.warn('[persist] 落盘失败:', err);
  });
}

sendBtn.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ============ v3 新增: @-mention 单选自动补全 (主聊天框 #input) ============
let mentionChannels = []; // { id, name, source: 'local'|'remote', ownerPublicKey? }
let mentionDropdownEl = null;
let mentionHighlightIdx = -1;
let mentionQuery = null;
let mentionAnchor = -1;        // @ 字符的绝对位置 (固定, 直到 dropdown 关闭)
let mentionBlockEnd = -1;      // 插入区块的终点 (单选模式下 = anchor + 1 + query)
let mentionDocMousedownBound = false; // 防止重复注册 document mousedown

function ensureMentionDocMousedown() {
  if (mentionDocMousedownBound) return;
  mentionDocMousedownBound = true;
  document.addEventListener('mousedown', (e) => {
    if (mentionDropdownEl && !mentionDropdownEl.contains(e.target) && e.target !== input) {
      closeMentionDropdown();
    }
  });
}

async function refreshMentionChannels() {
  try {
    const res = await fetch('/channels');
    const local = res.ok ? await res.json() : [];
    const r2 = await fetch('/api/remote-channels');
    const remoteData = r2.ok ? await r2.json() : { peers: [] };
    const remote = [];
    for (const p of (remoteData.peers || [])) {
      for (const c of (p.channels || [])) {
        remote.push({ id: c.id, name: c.name, source: 'remote', ownerPublicKey: p.peerId });
      }
    }
    mentionChannels = [
      ...(Array.isArray(local) ? local.map(c => ({ id: c.id, name: c.name, source: 'local' })) : []),
      ...remote
    ];
  } catch (err) {
    console.warn('[mention] 加载渠道列表失败:', err);
  }
}

function closeMentionDropdown() {
  if (mentionDropdownEl) { mentionDropdownEl.remove(); mentionDropdownEl = null; }
  mentionHighlightIdx = -1;
  mentionQuery = null;
  mentionAnchor = -1;
  mentionBlockEnd = -1;
  // 不重置 mentionDocMousedownBound — 监听器是空操作 (mentionDropdownEl === null) 留着无妨, 避免重复绑
}

function getCurrentMentionQuery() {
  const pos = input.selectionStart || input.value.length;
  const before = input.value.slice(0, pos);
  const m = before.match(/@([一-龥A-Za-z0-9_\-]{0,30})$/);
  return m ? { query: m[1], anchor: pos - m[0].length } : null;
}

function renderMentionDropdown(items) {
  if (!mentionDropdownEl) {
    mentionDropdownEl = document.createElement('div');
    mentionDropdownEl.id = 'mention-dropdown';
    mentionDropdownEl.style.cssText = 'position:fixed;background:#fff;border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:240px;overflow-y:auto;z-index:10000;font-size:13px;min-width:240px;';
    document.body.appendChild(mentionDropdownEl);
    ensureMentionDocMousedown();
  }
  // v3 简化: 单选 + 立即填入输入框
  const headerHtml = `<div style="padding:6px 10px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;">
    <span>💡 点击或回车选中 → 自动填入输入框</span>
    <span style="color:#9ca3af;">↑↓ 移动</span>
  </div>`;

  if (items.length === 0) {
    mentionDropdownEl.innerHTML = headerHtml + '<div style="padding:10px 12px;color:#6b7280;font-size:12px;">没有匹配的渠道</div>';
  } else {
    const rows = items.map((c, i) => {
      const isLocal = c.source === 'local';
      const tag = isLocal ? '🏠 本地' : '🌐 远端';
      const owner = !isLocal && c.ownerPublicKey ? ` <span style="color:#9ca3af;font-size:11px;">(${c.ownerPublicKey.substring(0, 8)}…)</span>` : '';
      // 浅蓝 = 键盘高亮, 白 = 普通
      const bg = i === mentionHighlightIdx ? '#eff6ff' : '#fff';
      const borderLeft = i === mentionHighlightIdx ? '3px solid #93c5fd' : '3px solid transparent';
      return `<div class="mention-item" data-idx="${i}" data-channel-id="${escapeHtml(c.id)}" data-channel-name="${escapeHtml(c.name)}" style="padding:8px 12px;cursor:pointer;background:${bg};border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:8px;border-left:${borderLeft};">
        <span style="font-size:10px;color:${isLocal ? '#059669' : '#2563eb'};background:${isLocal ? '#d1fae5' : '#dbeafe'};padding:1px 6px;border-radius:3px;white-space:nowrap;">${tag}</span>
        <span style="flex:1;">${escapeHtml(c.name)}</span>${owner}
      </div>`;
    }).join('');
    mentionDropdownEl.innerHTML = headerHtml + rows;
    mentionDropdownEl.querySelectorAll('.mention-item').forEach((el) => {
      const idx = parseInt(el.getAttribute('data-idx'));
      el.onclick = () => {
        // 单击 → 立即填入输入框 + 关闭 dropdown
        applyMention(items[idx]);
      };
      // v3 关键修复: mouseenter 只更新高亮, 不重建 dropdown — 否则用户实际点击的 element 被销毁,
      // click 事件落到新 element, 但实际触发的是新 element 的 onclick (空), 而不是被销毁前那个
      el.onmouseenter = () => {
        if (mentionHighlightIdx === idx) return;
        mentionHighlightIdx = idx;
        // 只更新背景色 + 左边框, 不重建 innerHTML
        const itemEls = mentionDropdownEl.querySelectorAll('.mention-item');
        itemEls.forEach((ie, ii) => {
          const isHi = ii === idx;
          ie.style.background = isHi ? '#eff6ff' : '#fff';
          ie.style.borderLeft = isHi ? '3px solid #93c5fd' : '3px solid transparent';
        });
      };
    });
  }
  const rect = input.getBoundingClientRect();
  mentionDropdownEl.style.left = rect.left + 'px';
  mentionDropdownEl.style.top = 'auto';
  mentionDropdownEl.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
}

/** v3 单选: 把 @xxx 替换为 @渠道名 + 空格, 关闭 dropdown, 光标放空格后 */
function applyMention(channel) {
  const anchor = mentionAnchor;
  const blockEnd = mentionBlockEnd >= 0 ? mentionBlockEnd : (anchor + 1 + (mentionQuery || '').length);
  if (anchor < 0 || anchor > input.value.length || input.value[anchor] !== '@') {
    closeMentionDropdown();
    return;
  }
  const before = input.value.slice(0, anchor);   // 含 @
  const after = input.value.slice(blockEnd);     // query 之后 (可能用户已输入正文)
  const insert = `@${channel.name} `;
  input.value = before + insert + after;
  const newPos = before.length + insert.length;
  input.focus();
  input.setSelectionRange(newPos, newPos);
  closeMentionDropdown();
}

function updateMentionDropdown() {
  // 2026-06-10 修: 数组空时主动刷一次, 不再静默 return
  // 之前 `if (!mentionChannels.length) return` 导致初始化 0-8s 窗口按 @ 看不到任何 item
  if (!mentionChannels.length) {
    refreshMentionChannels().then(() => {
      // 拉完再重试一次 (异步, 不阻塞当前键击)
      if (mentionChannels.length) updateMentionDropdown();
    });
    return;
  }
  const m = getCurrentMentionQuery();
  if (!m) { closeMentionDropdown(); return; }
  // 只在 dropdown 刚打开时设置 anchor (blockEnd 跟着 insert 走)
  if (mentionAnchor === -1) {
    mentionAnchor = m.anchor;
    mentionBlockEnd = m.anchor + 1 + (m.query || '').length;
    // dropdown 首次打开 → 强制刷一次, 保证 remote 列表最新
    refreshMentionChannels();
  }
  mentionQuery = m.query;
  const q = m.query.toLowerCase();
  const items = mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  mentionHighlightIdx = items.length > 0 ? 0 : -1;
  renderMentionDropdown(items);
}

input.addEventListener('input', () => {
  updateMentionDropdown();
});
input.addEventListener('keydown', (e) => {
  if (!mentionDropdownEl) return;
  const items = mentionDropdownEl.querySelectorAll('.mention-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length === 0) return;
    mentionHighlightIdx = (mentionHighlightIdx + 1) % items.length;
    const q = (mentionQuery || '').toLowerCase();
    const filtered = mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
    renderMentionDropdown(filtered);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length === 0) return;
    mentionHighlightIdx = (mentionHighlightIdx - 1 + items.length) % items.length;
    const q = (mentionQuery || '').toLowerCase();
    const filtered = mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
    renderMentionDropdown(filtered);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    // 单选: Enter/Tab 立即填入 + 关闭 dropdown
    if (items.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      const q = (mentionQuery || '').toLowerCase();
      const filtered = mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
      const cur = filtered[mentionHighlightIdx];
      if (cur) applyMention(cur);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeMentionDropdown();
  }
}, true);  // capture phase, 先于 sendMessage 那个 keydown

// 初始化
refreshMentionChannels();
// 定时刷新 (channel 列表可能变化)
setInterval(refreshMentionChannels, 5000);
// 远端 channel 列表变化时也刷新 (loadRemoteChannels 是 function declaration, 不能重新赋值)
// 用 setInterval 兜底: 每 5s 刷一次 (已经有定时器, 这里不重复)
// 实际上 refreshMentionChannels() 已经在 setInterval 里跑了

// v3 新增: 通用版 @-autocomplete (任意 input 元素都能挂, 比如 B 端的 #rcm-input)
function setupMentionAutocomplete(inputEl) {
  if (!inputEl || inputEl.__mentionBound) return;
  inputEl.__mentionBound = true;
  let localQuery = null;
  let localAnchor = -1;       // @ 字符的绝对位置 (固定, 直到 dropdown 关闭)
  let localBlockEnd = -1;     // 插入区块的终点
  let localHighlight = -1;

  function closeLocal() {
    if (inputEl.__mentionDD) { inputEl.__mentionDD.remove(); inputEl.__mentionDD = null; }
    localHighlight = -1; localQuery = null; localAnchor = -1; localBlockEnd = -1;
  }

  function detectQuery() {
    const pos = inputEl.selectionStart || inputEl.value.length;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/@([一-龥A-Za-z0-9_\-]{0,30})$/);
    return m ? { query: m[1], anchor: pos - m[0].length } : null;
  }

  // v3 单选: 点击 / Enter 立即填入输入框 + 关闭 dropdown
  function applyLocal(channel) {
    const anchor = localAnchor;
    const blockEnd = localBlockEnd >= 0 ? localBlockEnd : (anchor + 1 + (localQuery || '').length);
    if (anchor < 0 || anchor > inputEl.value.length || inputEl.value[anchor] !== '@') {
      closeLocal();
      return;
    }
    const before = inputEl.value.slice(0, anchor);   // 含 @
    const after = inputEl.value.slice(blockEnd);
    const insert = `@${channel.name} `;
    inputEl.value = before + insert + after;
    const newPos = before.length + insert.length;
    inputEl.focus();
    inputEl.setSelectionRange(newPos, newPos);
    closeLocal();
  }

  function renderLocal(items) {
    if (!inputEl.__mentionDD) {
      inputEl.__mentionDD = document.createElement('div');
      inputEl.__mentionDD.style.cssText = 'position:fixed;background:#fff;border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:240px;overflow-y:auto;z-index:10001;font-size:13px;min-width:240px;';
      document.body.appendChild(inputEl.__mentionDD);
    }
    const headerHtml = `<div style="padding:6px 10px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;">
      <span>💡 点击或回车选中 → 自动填入输入框</span>
      <span style="color:#9ca3af;">↑↓ 移动</span>
    </div>`;
    if (items.length === 0) {
      inputEl.__mentionDD.innerHTML = headerHtml + '<div style="padding:10px 12px;color:#6b7280;font-size:12px;">没有匹配的渠道</div>';
    } else {
      inputEl.__mentionDD.innerHTML = headerHtml + items.map((c, i) => {
        const isLocal = c.source === 'local';
        const tag = isLocal ? '🏠 本地' : '🌐 远端';
        const owner = !isLocal && c.ownerPublicKey ? ` <span style="color:#9ca3af;font-size:11px;">(${c.ownerPublicKey.substring(0, 8)}…)</span>` : '';
        const bg = i === localHighlight ? '#eff6ff' : '#fff';
        const borderLeft = i === localHighlight ? '3px solid #93c5fd' : '3px solid transparent';
        return `<div class="mention-item" data-idx="${i}" data-channel-id="${escapeHtml(c.id)}" data-channel-name="${escapeHtml(c.name)}" style="padding:8px 12px;cursor:pointer;background:${bg};border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:8px;border-left:${borderLeft};">
          <span style="font-size:10px;color:${isLocal ? '#059669' : '#2563eb'};background:${isLocal ? '#d1fae5' : '#dbeafe'};padding:1px 6px;border-radius:3px;white-space:nowrap;">${tag}</span>
          <span style="flex:1;">${escapeHtml(c.name)}</span>${owner}
        </div>`;
      }).join('');
      inputEl.__mentionDD.querySelectorAll('.mention-item').forEach((el) => {
        const idx = parseInt(el.getAttribute('data-idx'));
        el.onclick = () => applyLocal(items[idx]);
        // v3 关键修复: mouseenter 只更新高亮, 不重建 dropdown (同主 input)
        el.onmouseenter = () => {
          if (localHighlight === idx) return;
          localHighlight = idx;
          const itemEls = inputEl.__mentionDD.querySelectorAll('.mention-item');
          itemEls.forEach((ie, ii) => {
            const isHi = ii === idx;
            ie.style.background = isHi ? '#eff6ff' : '#fff';
            ie.style.borderLeft = isHi ? '3px solid #93c5fd' : '3px solid transparent';
          });
        };
      });
    }
    const rect = inputEl.getBoundingClientRect();
    inputEl.__mentionDD.style.left = rect.left + 'px';
    inputEl.__mentionDD.style.top = 'auto';
    inputEl.__mentionDD.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  }

  function update() {
    // 2026-06-10 修: 与主输入框同步 — 数组空时主动刷新, 首次打开 dropdown 强制刷新
    if (!mentionChannels.length) {
      refreshMentionChannels().then(() => {
        if (mentionChannels.length) update();
      });
      return;
    }
    const m = detectQuery();
    if (!m) { closeLocal(); return; }
    if (localAnchor === -1) {
      localAnchor = m.anchor;
      localBlockEnd = m.anchor + 1 + (m.query || '').length;
      // dropdown 首次打开 → 强制刷一次保证 remote 最新
      refreshMentionChannels();
    }
    localQuery = m.query;
    const q = m.query.toLowerCase();
    const items = mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
    localHighlight = items.length > 0 ? 0 : -1;
    renderLocal(items);
  }

  inputEl.addEventListener('input', update);
  inputEl.addEventListener('keydown', (e) => {
    if (!inputEl.__mentionDD) return;
    const items = inputEl.__mentionDD.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length === 0) return;
      localHighlight = (localHighlight + 1) % items.length;
      const q = (localQuery || '').toLowerCase();
      renderLocal(mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      localHighlight = (localHighlight - 1 + items.length) % items.length;
      const q = (localQuery || '').toLowerCase();
      renderLocal(mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const q = (localQuery || '').toLowerCase();
        const filtered = mentionChannels.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
        const cur = filtered[localHighlight];
        if (cur) applyLocal(cur);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeLocal();
    }
  }, true);
}

// 拖拽落点: 把判断库里的判断拖到输入框, 直接作为指令发给 AI (走"代我决定"路径).
// 用户拖进来后输入框被预填, 点发送就把这条判断作为指令交给当前 agent.
const inputArea = document.querySelector('.input-area');
if (input && inputArea) {
  const onDragOver = (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('application/x-bolloon-judgment')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      inputArea.classList.add('drop-target');
    }
  };
  const onDragLeave = (e) => {
    if (e.target === inputArea || !inputArea.contains(e.relatedTarget)) {
      inputArea.classList.remove('drop-target');
    }
  };
  const onDrop = (e) => {
    inputArea.classList.remove('drop-target');
    const raw = e.dataTransfer.getData('application/x-bolloon-judgment');
    if (!raw) return;
    e.preventDefault();
    try {
      const { id, decision } = JSON.parse(raw);
      // 预填输入框: 用户可改, 然后发出去 AI 就知道"按这条判断做"
      const prefix = input.value.trim() ? input.value.trim() + '\n' : '';
      input.value = `${prefix}按我的判断 #${id?.substring(0, 8) || ''} 执行: ${decision}`;
      input.focus();
      // 视觉提示
      input.style.transition = 'box-shadow 0.3s';
      input.style.boxShadow = '0 0 0 2px #2563eb';
      setTimeout(() => { input.style.boxShadow = ''; }, 800);
    } catch {}
  };
  inputArea.addEventListener('dragover', onDragOver);
  inputArea.addEventListener('dragleave', onDragLeave);
  inputArea.addEventListener('drop', onDrop);
}

if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}

const apiConfigBtn = document.getElementById('api-config-btn');
if (apiConfigBtn) {
  apiConfigBtn.addEventListener('click', () => {
    window.location.href = '/api-config';
  });
}

// 钱包管理按钮
const walletBtn = document.getElementById('wallet-btn');
const walletBadge = document.getElementById('wallet-badge');
if (walletBtn) {
  walletBtn.addEventListener('click', openWalletModal);
}
/** 刷新 header 钱包徽章: 统计已绑定钱包的智能体数 */
function refreshWalletBadge() {
  if (!walletBadge) return;
  const count = channels.filter(c => c.walletAddress).length;
  if (count > 0) {
    walletBadge.textContent = String(count);
    walletBadge.style.display = '';
  } else {
    walletBadge.style.display = 'none';
  }
}

if (sidebarToggle) {
  sidebarToggle.addEventListener('click', toggleSidebar);
}

if (loadSessionBtn && sessionFileInput) {
  loadSessionBtn.addEventListener('click', () => {
    sessionFileInput.click();
  });

  sessionFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const session = JSON.parse(text);

      if (session.messages && Array.isArray(session.messages)) {
        messagesEl.innerHTML = '';
        session.messages.forEach(msg => {
          addMessage(msg.content, msg.type, false);
        });

        const channelName = session.channelId || file.name.replace('.json', '');
        if (channelNameEl) {
          channelNameEl.textContent = channelName;
        }

        addMessage(`已加载 session: ${file.name}`, 'ai', false);
      } else {
        addMessage('无效的 session 文件格式', 'ai', false);
      }
    } catch (err) {
      console.error('Failed to load session:', err);
      addMessage('加载 session 失败: ' + err.message, 'ai', false);
    }

    sessionFileInput.value = '';
  });
}

if (newChannelBtn) {
  newChannelBtn.addEventListener('click', () => {
    createChannel('智能体');
  });
}

if (newChannelInput) {
  newChannelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createChannel(newChannelInput.value);
    }
  });
}

async function checkApiConfig() {
  try {
    const res = await fetch('/api/llm-config');
    const config = await res.json();

    // 检查是否有供应商已配置
    const hasConfigured = Object.values(config.providers).some(p => p.enabled && p.apiKey);

    if (!hasConfigured) {
      // 显示 API 配置提示
      const hint = document.createElement('div');
      hint.className = 'api-config-hint';
      hint.innerHTML = `
        <div class="hint-icon">⚠️</div>
        <div class="hint-text">
          <strong>API 未配置</strong><br>
          请先配置 AI 模型才能开始对话
        </div>
        <button class="hint-btn" id="api-config-hint-btn">前往配置</button>
      `;
      document.body.appendChild(hint);

      // 绑定事件处理器（避免内联 onclick）
      const hintBtn = document.getElementById('api-config-hint-btn');
      if (hintBtn) {
        hintBtn.addEventListener('click', () => {
          window.location.href = '/api-config';
        });
      }
    }
  } catch (err) {
    console.error('Failed to check API config:', err);
  }
}

async function init() {
  const themeData = await loadTheme();
  currentAgentId = themeData.agentId || `agent_${generateId().substring(0, 8)}`;

  if (!themeData.agentId) {
    await saveTheme(themeData.theme, currentAgentId);
  }

  await loadChannels();
  await checkApiConfig();

  if (channels.length > 0) {
    await selectChannel(channels[0].id);
  } else {
    await createChannel('默认会话');
  }
}

// P2P Network Modal - React Version
const p2pNetworkBtn = document.getElementById('p2p-network-btn');

// 打开 P2P Modal (使用 React)
if (p2pNetworkBtn) {
  p2pNetworkBtn.addEventListener('click', () => {
    if (typeof window.showP2PModal === 'function') {
      window.showP2PModal();
    }
  });
}

// Task Queue
const taskModal = document.getElementById('task-modal');
const taskQueueBtn = document.getElementById('task-queue-btn');
const taskModalClose = document.getElementById('task-modal-close');
const createTaskModal = document.getElementById('create-task-modal');
const createTaskModalClose = document.getElementById('create-task-modal-close');
const taskList = document.getElementById('task-list');
const taskAddBtn = document.getElementById('task-add-btn');
const taskExecuteNextBtn = document.getElementById('task-execute-next-btn');
const taskTypeSelect = document.getElementById('task-type');
const taskTitleInput = document.getElementById('task-title');
const taskDescInput = document.getElementById('task-desc');
const taskStepsInput = document.getElementById('task-steps');
const taskCreateBtn = document.getElementById('task-create-btn');
const taskCancelBtn = document.getElementById('task-cancel-btn');
const taskBadge = document.getElementById('task-badge');

let tasks = [];

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (res.ok) {
      tasks = await res.json();
      renderTasks();
      updateTaskBadge();
    }
  } catch {
    tasks = [];
    renderTasks();
  }
}

function renderTasks() {
  if (!taskList) return;

  if (tasks.length === 0) {
    taskList.innerHTML = '<div class="task-empty">暂无任务，点击上方按钮创建</div>';
    return;
  }

  // 使用 DocumentFragment 优化性能
  const fragment = document.createDocumentFragment();

  tasks.forEach(task => {
    const div = document.createElement('div');
    div.className = `task-item ${task.status}`;
    div.dataset.id = task.id;

    div.innerHTML = `
      <div class="task-item-header">
        <div class="task-item-title">
          <span>${getTaskIcon(task.type)}</span>
          <span>${task.title}</span>
        </div>
        <span class="task-item-status ${task.status}">${getTaskStatusText(task.status)}</span>
      </div>
      ${task.description ? `<div class="task-item-desc">${task.description.substring(0, 100)}${task.description.length > 100 ? '...' : ''}</div>` : ''}
      <div class="task-item-progress">
        <div class="task-item-progress-bar" style="width: ${task.progress}%"></div>
      </div>
      ${task.steps && task.steps.length > 0 ? `
        <div class="task-item-steps">
          ${task.steps.map((step, i) => `
            <div class="task-item-step ${step.status}">
              ${step.status === 'completed' ? '✓' : step.status === 'running' ? '⟳' : step.status === 'failed' ? '✗' : '○'} ${i + 1}. ${step.name}
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="task-item-actions">
        ${task.status === 'pending' ? `<button class="btn-sm btn-primary" data-action="execute">▶ 执行</button>` : ''}
        ${task.status === 'running' ? `<button class="btn-sm" disabled>执行中...</button>` : ''}
        ${task.status === 'completed' ? `<button class="btn-sm" data-action="delete">删除</button>` : ''}
        ${task.status === 'failed' ? `<button class="btn-sm btn-primary" data-action="retry">重试</button>` : ''}
      </div>
    `;

    fragment.appendChild(div);
  });

  taskList.innerHTML = '';
  taskList.appendChild(fragment);

  // 绑定事件处理器（避免内联 onclick）
  taskList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.currentTarget.closest('.task-item');
      const taskId = item?.dataset.id;
      if (!taskId) return;

      const action = e.currentTarget.dataset.action;
      switch (action) {
        case 'execute': executeTask(taskId); break;
        case 'delete': deleteTask(taskId); break;
        case 'retry': retryTask(taskId); break;
      }
    });
  });
}

function getTaskIcon(type) {
  switch (type) {
    case 'chat': return '💬';
    case 'read': return '📄';
    case 'summarize': return '📝';
    case 'improve': return '✏️';
    case 'workflow': return '🔄';
    default: return '📋';
  }
}

function getTaskStatusText(status) {
  switch (status) {
    case 'pending': return '待执行';
    case 'running': return '执行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'paused': return '已暂停';
    default: return status;
  }
}

function updateTaskBadge() {
  if (!taskBadge) return;
  const pending = tasks.filter(t => t.status === 'pending').length;
  if (pending > 0) {
    taskBadge.textContent = pending.toString();
    taskBadge.style.display = 'block';
  } else {
    taskBadge.style.display = 'none';
  }
}

function showTaskModal() {
  if (taskModal) {
    taskModal.classList.add('active');
    loadTasks();
  }
}

function hideTaskModal() {
  if (taskModal) {
    taskModal.classList.remove('active');
  }
}

function showCreateTaskModal() {
  if (createTaskModal) {
    createTaskModal.classList.add('active');
    if (taskTitleInput) taskTitleInput.value = '';
    if (taskDescInput) taskDescInput.value = '';
    if (taskStepsInput) taskStepsInput.value = '';
  }
}

function hideCreateTaskModal() {
  if (createTaskModal) {
    createTaskModal.classList.remove('active');
  }
}

async function createTask() {
  const type = taskTypeSelect?.value || 'chat';
  const title = taskTitleInput?.value?.trim();
  const description = taskDescInput?.value?.trim();

  if (!title) {
    alert('请输入任务标题');
    return;
  }

  const taskData = {
    type,
    title,
    description
  };

  if (type === 'workflow' && taskStepsInput?.value) {
    taskData.steps = taskStepsInput.value.split('\n').filter(s => s.trim());
  }

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData)
    });

    if (res.ok) {
      const task = await res.json();

      // 自动执行任务
      if (currentChannelId) {
        await fetch(`/api/tasks/${task.id}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: currentChannelId })
        });
      }

      hideCreateTaskModal();
      await loadTasks();
    }
  } catch (err) {
    console.error('Failed to create task:', err);
  }
}

async function executeTask(taskId) {
  if (!currentChannelId) {
    alert('请先选择一个频道');
    return;
  }

  try {
    await fetch(`/api/tasks/${taskId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: currentChannelId })
    });
    await loadTasks();
  } catch (err) {
    console.error('Failed to execute task:', err);
  }
}

async function retryTask(taskId) {
  const tasks = await (await fetch('/api/tasks')).json();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = 'pending';
    task.error = undefined;
    await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' })
    });
    await executeTask(taskId);
  }
}

async function deleteTask(taskId) {
  try {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    await loadTasks();
  } catch (err) {
    console.error('Failed to delete task:', err);
  }
}

async function executeNextTask() {
  if (!currentChannelId) {
    alert('请先选择一个频道');
    return;
  }

  try {
    const res = await fetch('/api/tasks/execute-next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: currentChannelId })
    });

    if (res.ok) {
      const data = await res.json();
      if (!data.ok) {
        addMessage(data.message || '没有待执行的任务', 'ai');
      }
      await loadTasks();
    }
  } catch (err) {
    console.error('Failed to execute next task:', err);
  }
}

// Task modal events
if (taskQueueBtn) {
  taskQueueBtn.addEventListener('click', showTaskModal);
}

if (taskModalClose) {
  taskModalClose.addEventListener('click', hideTaskModal);
}

// ==================== Judgments (v1 极简) ====================
const judgmentsModal = document.getElementById('judgments-modal');
const judgmentsBtn = document.getElementById('judgments-btn');
const judgmentsModalClose = document.getElementById('judgments-modal-close');
const judgmentDecision = document.getElementById('judgment-decision');
const judgmentReason = document.getElementById('judgment-reason');
const judgmentDomain = document.getElementById('judgment-domain');
const judgmentStakes = document.getElementById('judgment-stakes');
const judgmentSubmitBtn = document.getElementById('judgment-submit-btn');
const judgmentError = document.getElementById('judgment-error');
const judgmentsList = document.getElementById('judgments-list');
const judgmentsBadge = document.getElementById('judgments-badge');

let judgmentsLoaded = false;

function showJudgmentsModal() {
  if (judgmentsModal) judgmentsModal.classList.add('active');
  if (!judgmentsLoaded) loadJudgments();
  else renderJudgments(lastJudgmentsCache); // 打开时按当前 channel / tab 重渲
}

function switchJudgmentTab(tab) {
  currentJudgmentTab = tab;
  document.querySelectorAll('.judgment-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.style.borderBottomColor = active ? '#2563eb' : 'transparent';
    btn.style.color = active ? '#2563eb' : '#6b7280';
  });
  renderJudgments(lastJudgmentsCache);
}

function hideJudgmentsModal() {
  if (judgmentsModal) judgmentsModal.classList.remove('active');
}

let currentJudgmentTab = 'channel'; // 'channel' | 'global'
let lastJudgmentsCache = []; // 最近一次 loadJudgments 拿到的原始列表, 切 tab / 切 channel 时复用

/**
 * v3 重做: 渲染判断力列表 (受 tab + 当前 channel 影响)
 *   tab = 'channel': 拆为"已绑定" + "未绑定"两组, 每条带 + / × 按钮
 *   tab = 'global':  全部 judgment 列表, 无 + / × 按钮
 * 如果没选 channel, 'channel' tab 自动显示提示 + 全部 judgment
 */
function renderJudgments(items) {
  if (!judgmentsList) return;
  const all = items || [];
  const titleEl = document.getElementById('judgments-list-title');
  const chNameEl = document.getElementById('judgments-tab-channel-name');
  const currentCh = currentChannelId
    ? channels.find(c => c.id === currentChannelId)
    : null;

  if (chNameEl) {
    chNameEl.textContent = currentCh ? `(${currentCh.name})` : '(未选)';
  }

  if (all.length === 0) {
    judgmentsList.innerHTML = '<div class="task-empty">还没有判断, 在上面记录第一条吧</div>';
    if (titleEl) titleEl.textContent = '本 channel 的判断力';
    return;
  }

  if (currentJudgmentTab === 'global') {
    // 全局 tab: 全部 judgment, 简单列表
    if (titleEl) titleEl.textContent = `全局判断力 (${all.length} 条)`;
    judgmentsList.innerHTML = renderJudgmentItems(all, { showBindToggle: false });
    return;
  }

  // channel tab: 必须有 channel
  if (!currentCh) {
    if (titleEl) titleEl.textContent = '本 channel 的判断力';
    judgmentsList.innerHTML = `
      <div style="padding:24px 12px;text-align:center;color:#6b7280;font-size:13px;">
        请先在左侧选中一个 channel,<br>然后这里会显示已绑定和可加入的判断力。
      </div>
    `;
    return;
  }

  const boundIds = new Set(
    Array.isArray(currentCh.bound_judgment_ids) ? currentCh.bound_judgment_ids : []
  );
  const bound = all.filter(j => boundIds.has(j.id));
  const unbound = all.filter(j => !boundIds.has(j.id));

  if (titleEl) titleEl.textContent = `${currentCh.name} 的判断力 (已绑 ${bound.length} / 共 ${all.length})`;

  let html = '';
  if (bound.length > 0) {
    html += `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;padding:8px 4px 4px;">已绑定 (${bound.length})</div>`;
    html += renderJudgmentItems(bound, { showBindToggle: true, isBound: true });
  }
  if (unbound.length > 0) {
    html += `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;padding:14px 4px 4px;">未绑定 (${unbound.length})</div>`;
    html += renderJudgmentItems(unbound, { showBindToggle: true, isBound: false });
  }
  judgmentsList.innerHTML = html;
}

function renderJudgmentItems(items, opts) {
  const { showBindToggle, isBound } = opts || {};
  return items.map(j => {
    const reason = (j.reasons && j.reasons[0]) ? escapeHtml(j.reasons[0]) : '';
    const domain = (j.context && j.context.domain) ? escapeHtml(j.context.domain) : 'general';
    const stakes = (j.context && j.context.stakes) ? escapeHtml(j.context.stakes) : 'medium';
    const bindBtn = showBindToggle
      ? isBound
        ? `<button class="judgment-toggle-btn" data-id="${escapeHtml(j.id)}" data-action="unbind" title="从当前 channel 移除" style="background:none;border:1px solid #fca5a5;color:#b91c1c;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">× 移除</button>`
        : `<button class="judgment-toggle-btn" data-id="${escapeHtml(j.id)}" data-action="bind" title="加进当前 channel" style="background:none;border:1px solid #6b7280;color:#6b7280;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">+ 加入</button>`
      : '';
    return `
      <div class="task-item completed judgment-row"
           data-judgment-id="${escapeHtml(j.id)}"
           draggable="true"
           style="cursor:grab;">
        <div class="task-item-header">
          <label class="judgment-checkbox" style="display:flex;align-items:center;cursor:pointer;margin-right:8px;" onclick="event.stopPropagation();">
            <input type="checkbox" class="judgment-select-cb" data-id="${escapeHtml(j.id)}" style="cursor:pointer;" onclick="event.stopPropagation();">
          </label>
          <div class="task-item-title">
            <span class="judgment-decision">${escapeHtml(j.decision)}</span>
          </div>
          <span class="task-item-status completed">${stakes}</span>
        </div>
        ${reason ? `<div class="task-item-desc" style="color:#555;font-size:13px;margin-top:4px;">理由: ${reason}</div>` : ''}
        <div class="task-item-meta" style="color:#999;font-size:11px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;">
          <span>${domain} · ${escapeHtml(j.timestamp)} · ${escapeHtml(j.id)}</span>
          <span style="display:flex;gap:4px;">
            ${bindBtn}
            <button class="judgment-edit-btn" data-id="${escapeHtml(j.id)}" title="编辑判断" style="background:none;border:1px solid #d1d5db;color:#374151;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">编辑</button>
            <button class="judgment-del-btn" data-id="${escapeHtml(j.id)}" title="删除判断" style="background:none;border:1px solid #fca5a5;color:#b91c1c;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">删除</button>
          </span>
        </div>
      </div>
    `;
  }).join('');
}

async function loadJudgments() {
  if (!judgmentsList) return;
  try {
    const res = await fetch('/api/judgments');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    lastJudgmentsCache = data.judgments || [];
    renderJudgments(lastJudgmentsCache);
    if (judgmentsBadge) {
      if (data.count > 0) {
        judgmentsBadge.textContent = data.count;
        judgmentsBadge.style.display = '';
      } else {
        judgmentsBadge.style.display = 'none';
      }
    }
    judgmentsLoaded = true;
  } catch (e) {
    if (judgmentsList) judgmentsList.innerHTML = '<div class="task-empty">加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}

/** 把 judgment id 加进 / 移出当前 channel.bound_judgment_ids, 然后刷新两边 UI */
async function toggleChannelJudgment(judgmentId, action) {
  if (!currentChannelId) {
    showJudgmentError('请先选中一个 channel');
    return;
  }
  const ch = channels.find(c => c.id === currentChannelId);
  if (!ch) return;
  const set = new Set(Array.isArray(ch.bound_judgment_ids) ? ch.bound_judgment_ids : []);
  if (action === 'bind') set.add(judgmentId);
  else set.delete(judgmentId);
  const next = Array.from(set);
  try {
    const res = await fetch(`/channels/${currentChannelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bound_judgment_ids: next })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const updated = await res.json();
    const idx = channels.findIndex(c => c.id === currentChannelId);
    if (idx >= 0) channels[idx] = updated;
    // 弹窗开着就刷新, 关着就跳过
    if (judgmentsModal && judgmentsModal.classList.contains('active')) {
      renderJudgments(lastJudgmentsCache);
    }
  } catch (err) {
    showJudgmentError('绑定失败: ' + err.message);
  }
}

// 列表内编辑/删除 + 拖拽 — 事件委托
if (judgmentsList) {
  judgmentsList.addEventListener('click', async (e) => {
    const editBtn = e.target.closest && e.target.closest('.judgment-edit-btn');
    const delBtn = e.target.closest && e.target.closest('.judgment-del-btn');
    const toggleBtn = e.target.closest && e.target.closest('.judgment-toggle-btn');
    if (editBtn) {
      const id = editBtn.getAttribute('data-id');
      await editJudgment(id);
    } else if (delBtn) {
      const id = delBtn.getAttribute('data-id');
      if (!confirm('确定删除这条判断?')) return;
      try {
        const res = await fetch('/api/judgments/' + encodeURIComponent(id), { method: 'DELETE' });
        const out = await res.json();
        if (!out.ok) throw new Error(out.error || 'delete failed');
        await loadJudgments();
      } catch (err) {
        showJudgmentError('删除失败: ' + err.message);
      }
    } else if (toggleBtn) {
      const id = toggleBtn.getAttribute('data-id');
      const action = toggleBtn.getAttribute('data-action');
      await toggleChannelJudgment(id, action);
    }
  });

  // tab 切换
  document.querySelectorAll('.judgment-tab').forEach(btn => {
    btn.addEventListener('click', () => switchJudgmentTab(btn.dataset.tab));
  });

  // 拖拽: 每条 judgment 是 drag source, dataTransfer 装 decision text
  judgmentsList.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.judgment-row');
    if (!row) return;
    const decision = row.querySelector('.judgment-decision')?.textContent || '';
    const id = row.getAttribute('data-judgment-id') || '';
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', decision);
    e.dataTransfer.setData('application/x-bolloon-judgment', JSON.stringify({ id, decision }));
  });

  // 多选 checkbox 变化 → 更新工具栏
  judgmentsList.addEventListener('change', (e) => {
    if (e.target.classList && e.target.classList.contains('judgment-select-cb')) {
      updateBulkDeleteToolbar();
    }
  });
}

// 批量选择工具栏: 全选 / 计数 / 启用删除按钮
const judgmentSelectAll = document.getElementById('judgment-select-all');
const judgmentSelectedCount = document.getElementById('judgment-selected-count');
const judgmentBulkDeleteBtn = document.getElementById('judgment-bulk-delete-btn');

function getSelectedJudgmentIds() {
  if (!judgmentsList) return [];
  return Array.from(judgmentsList.querySelectorAll('.judgment-select-cb'))
    .filter(cb => cb.checked)
    .map(cb => cb.getAttribute('data-id'))
    .filter(Boolean);
}

function updateBulkDeleteToolbar() {
  const ids = getSelectedJudgmentIds();
  if (judgmentSelectedCount) judgmentSelectedCount.textContent = `已选 ${ids.length}`;
  if (judgmentBulkDeleteBtn) {
    judgmentBulkDeleteBtn.disabled = ids.length === 0;
    judgmentBulkDeleteBtn.style.opacity = ids.length === 0 ? '0.5' : '1';
    judgmentBulkDeleteBtn.style.cursor = ids.length === 0 ? 'not-allowed' : 'pointer';
  }
  // 全选 checkbox 的 indeterminate / checked 状态同步
  if (judgmentSelectAll && judgmentsList) {
    const all = judgmentsList.querySelectorAll('.judgment-select-cb');
    const checked = Array.from(all).filter(cb => cb.checked);
    judgmentSelectAll.checked = all.length > 0 && checked.length === all.length;
    judgmentSelectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  }
}

if (judgmentSelectAll) {
  judgmentSelectAll.addEventListener('change', (e) => {
    if (!judgmentsList) return;
    const checked = e.target.checked;
    judgmentsList.querySelectorAll('.judgment-select-cb').forEach(cb => { cb.checked = checked; });
    updateBulkDeleteToolbar();
  });
}

if (judgmentBulkDeleteBtn) {
  judgmentBulkDeleteBtn.addEventListener('click', async () => {
    const ids = getSelectedJudgmentIds();
    if (ids.length === 0) return;
    if (!confirm(`确定删除选中的 ${ids.length} 条判断? 此操作不可撤销.`)) return;
    judgmentBulkDeleteBtn.disabled = true;
    try {
      const res = await fetch('/api/judgments/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || 'failed');
      showJudgmentOk(`✓ 批量删除 ${out.deleted} 条${out.notFound?.length ? ` (${out.notFound.length} 条未找到)` : ''}`);
      await loadJudgments();
    } catch (err) {
      showJudgmentError('批量删除失败: ' + err.message);
    } finally {
      if (judgmentBulkDeleteBtn) judgmentBulkDeleteBtn.disabled = false;
    }
  });
}

async function editJudgment(id) {
  // 简单做法: 用 prompt 弹 3 个字段. 想要更好的体验就用 inline editor, 但 v1 不必.
  const all = await (await fetch('/api/judgments')).json();
  const j = (all.judgments || []).find(x => x.id === id);
  if (!j) { showJudgmentError('找不到该判断 (可能已删除)'); return; }
  const newDecision = prompt('修改判断 (decision):', j.decision);
  if (newDecision === null) return;
  const newReason = prompt('修改理由 (reason, 留空不改):', (j.reasons && j.reasons[0]) || '');
  const newStakes = prompt('修改风险 (low/medium/high/critical):', (j.context && j.context.stakes) || 'medium');
  const patch = {
    decision: newDecision.trim() || j.decision,
    reasons: newReason !== null ? [newReason.trim()].filter(Boolean) : j.reasons,
    context: newStakes ? { ...(j.context || {}), stakes: newStakes } : j.context,
  };
  try {
    const res = await fetch('/api/judgments/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'update failed');
    showJudgmentOk('✓ 已更新');
    await loadJudgments();
  } catch (err) {
    showJudgmentError('更新失败: ' + err.message);
  }
}

async function submitJudgment() {
  if (!judgmentSubmitBtn) return;
  const decision = (judgmentDecision?.value || '').trim();
  const reason = (judgmentReason?.value || '').trim();
  if (!decision) {
    if (judgmentError) { judgmentError.textContent = '判断不能为空'; judgmentError.style.display = ''; }
    return;
  }
  judgmentSubmitBtn.disabled = true;
  if (judgmentError) judgmentError.style.display = 'none';
  try {
    const res = await fetch('/api/judgments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision,
        reason: reason || undefined,
        context: { domain: judgmentDomain?.value, stakes: judgmentStakes?.value },
      }),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'unknown');
    if (judgmentDecision) judgmentDecision.value = '';
    if (judgmentReason) judgmentReason.value = '';
    await loadJudgments();

    // AI 自动委派: fire-and-forget. 根据 domain 找匹配的远端 agent, 触发 agent_delegate 协议.
    // 失败也不影响本次记录.
    try {
      const del = await fetch('/api/judgments/auto-delegate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          judgmentId: out.judgment.id,
          capability: judgmentDomain?.value || 'general',
          instruction: `执行判断: ${out.judgment.decision}` + (reason ? ` (理由: ${reason})` : ''),
        }),
      });
      const delOut = await del.json();
      if (delOut.matched && delOut.sent) {
        showJudgmentOk(`✓ 已记录并自动委派给 ${delOut.targetAgent.name}`);
      } else if (delOut.matched) {
        showJudgmentOk(`✓ 已记录 (匹配到 ${delOut.targetAgent.name}, 但 ${delOut.reason || '未发送'})`);
      } else {
        showJudgmentOk('✓ 已记录 (本地, 无匹配远端 agent)');
      }
    } catch (e) {
      console.warn('[judgments] auto-delegate fire failed:', e);
    }
  } catch (e) {
    if (judgmentError) { judgmentError.textContent = '记录失败: ' + e.message; judgmentError.style.display = ''; }
  } finally {
    judgmentSubmitBtn.disabled = false;
  }
}

if (judgmentsBtn) judgmentsBtn.addEventListener('click', showJudgmentsModal);
if (judgmentsModalClose) judgmentsModalClose.addEventListener('click', hideJudgmentsModal);
if (judgmentsModal) {
  judgmentsModal.addEventListener('click', (e) => {
    if (e.target === judgmentsModal) hideJudgmentsModal();
  });
}

// --- 导入文件 (.json / .yaml / .md / .txt / .html) ---
const judgmentImportBtn = document.getElementById('judgment-import-btn');
const judgmentImportFile = document.getElementById('judgment-import-file');

function showJudgmentError(msg) {
  if (!judgmentError) return;
  judgmentError.textContent = msg;
  judgmentError.style.display = '';
  judgmentError.style.color = '#b91c1c';
}
function showJudgmentOk(msg) {
  if (!judgmentError) return;
  judgmentError.textContent = msg;
  judgmentError.style.display = '';
  judgmentError.style.color = '#15803d';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      // result is "data:<mime>;base64,<payload>" — strip prefix
      const s = String(r.result || '');
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.substring(idx + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

async function importJudgmentFile(file) {
  if (!file) return;
  if (judgmentImportBtn) judgmentImportBtn.disabled = true;
  try {
    const content = await fileToBase64(file);
    const res = await fetch('/api/judgments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, content }),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'import failed');
    showJudgmentOk(`✓ 导入 ${out.imported} 条${out.failed ? `, ${out.failed} 条失败` : ''}`);
    await loadJudgments();
  } catch (e) {
    showJudgmentError('导入失败: ' + e.message);
  } finally {
    if (judgmentImportBtn) judgmentImportBtn.disabled = false;
    if (judgmentImportFile) judgmentImportFile.value = '';
  }
}

if (judgmentImportBtn) {
  judgmentImportBtn.addEventListener('click', () => {
    if (judgmentImportFile) judgmentImportFile.click();
  });
}
if (judgmentImportFile) {
  judgmentImportFile.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJudgmentFile(f);
  });
}

// --- 从对话里 "存为判断": 事件委托到消息容器, 匹配 .save-as-judgment ---
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('.save-as-judgment');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const decision = (btn.getAttribute('data-decision') || '').trim();
  if (!decision) return;
  try {
    const res = await fetch('/api/judgments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, reason: '从对话保存' }),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'failed');
    btn.classList.add('saved');
    btn.title = '已存为判断';
    // 顶部徽章会通过 setInterval 拉新数据, 不用手动触发
  } catch (err) {
    console.error('[judgments] save-from-chat failed:', err);
    btn.title = '保存失败: ' + err.message;
  }
});
if (judgmentSubmitBtn) judgmentSubmitBtn.addEventListener('click', submitJudgment);

// 启动时拉一次, 让徽章显示总数 (不打开 modal 也能看到)
loadJudgments();
// 后台定期刷新 (与 modal 打开/关闭无关, 任何时候都保持徽章新鲜)
setInterval(loadJudgments, 10000);

// ============================================================================
// v3: P2P 好友 (known peers) + 收到的分享
// ============================================================================

let knownPeers = [];  // { name, publicKey, lastConnectedAt, addedAt }

async function loadRemoteChannels() {
  try {
    // 1) 拉 known peers (好友列表)
    const res = await fetch('/api/p2p-peers');
    if (res.ok) {
      const data = await res.json();
      knownPeers = Array.isArray(data.peers) ? data.peers : [];
    }
    // 2) 2026-06-10 修: 同时拉 /api/remote-channels, 兜底 SSE 推送漏掉的情况
    //    (页面刷新后 remoteChannels[] = [], 必须主动拉一次才有数据)
    const r2 = await fetch('/api/remote-channels');
    if (r2.ok) {
      const data2 = await r2.json();
      const peers = Array.isArray(data2.peers) ? data2.peers : [];
      // 合并到 remoteChannels[]: 按 peerId 覆盖
      for (const p of peers) {
        let group = remoteChannels.find(g => g.peerId === p.peerId);
        if (!group) {
          group = { peerId: p.peerId, channels: [], peerName: ('peer-' + p.peerId.substring(0, 8)) };
          remoteChannels.push(group);
        }
        group.channels = p.channels || [];
      }
    }
    renderRemoteChannels();
    // 3) 远端数据可能变化, 同步 @-mention 列表
    if (typeof refreshMentionChannels === 'function') {
      refreshMentionChannels();
    }
  } catch (err) {
    console.error('[v3] loadRemoteChannels 失败:', err);
  }
}

function renderRemoteChannels() {
  const list = document.getElementById('remote-channel-list');
  if (!list) return;

  // 按 peerId 分组 channels
  const channelsByPeer = {};
  for (const p of remoteChannels) {
    channelsByPeer[p.peerId] = p.channels || [];
  }

  // 2026-06-10 修: 之前 UI 只渲染 knownPeers, 但对面 publicKey 可能跟本机 known_peers 不匹配
  // (例如对面重启 / 换 role / 第一次相连还没加为好友), 导致 remoteChannels 里有数据 UI 却空白.
  // 修法: 把 remoteChannels 里的 "陌生 peer" (不在 known_peers 里) 也渲染出来, 标记为未加好友.
  const knownPks = new Set(knownPeers.map(p => p.publicKey));
  const strangerPeers = remoteChannels
    .filter(p => !knownPks.has(p.peerId))
    .map(p => ({
      publicKey: p.peerId,
      name: p.peerName || ('未授权 ' + p.peerId.substring(0, 8)),
      lastConnectedAt: null,
      _isStranger: true
    }));
  const allPeers = [...knownPeers, ...strangerPeers];

  if (allPeers.length === 0) {
    list.innerHTML = '<li style="color:var(--text-muted);font-size:11px;padding:8px 4px;text-align:center;">(暂无好友, 点 + 添加)</li>';
    return;
  }

  const html = allPeers.map(peer => {
    const peerChannels = channelsByPeer[peer.publicKey] || [];
    const lastConn = peer.lastConnectedAt
      ? new Date(peer.lastConnectedAt).toLocaleDateString()
      : (peer._isStranger ? '陌生 peer' : '从未连接');
    const strangerStyle = peer._isStranger ? 'border:1px dashed var(--border-light);' : '';
    const strangerIcon = peer._isStranger ? '❔' : '👤';
    // 2026-06-10: 折叠逻辑 (定稿)
    // - 首次见 peer: 默认 *折叠* (10+ peer 时减少视觉噪声; 标题栏右侧 "X ch" 提示有内容)
    // - 已见过: 沿用 collapsedPeers (用户上次选择)
    // - "全部展开/折叠" 按钮在 P2P header (id=p2p-expand-all-btn)
    if (!seenPeers.has(peer.publicKey)) {
      seenPeers.add(peer.publicKey);
      collapsedPeers.add(peer.publicKey);  // 首次默认折叠
      saveSeenPeers();
      saveCollapsedPeers();
    }
    const isCollapsed = collapsedPeers.has(peer.publicKey);
    const caretChar = '▾';  // CSS rotate -90deg 处理折叠态
    return `
      <li class="remote-peer-group ${isCollapsed ? 'collapsed' : ''}" style="margin-bottom:10px;${strangerStyle}">
        <div class="remote-peer-header" data-peer-name="${escapeHtml(peer.name)}" data-peer-pk="${escapeHtml(peer.publicKey)}"
             style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg-hover);border-radius:4px;cursor:pointer;">
          <button class="peer-caret-btn" data-toggle-peer="${escapeHtml(peer.publicKey)}" title="折叠/展开"
                  style="background:var(--bg-active);border:1px solid var(--border);color:var(--text);cursor:pointer;width:22px;height:22px;border-radius:4px;font-size:12px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;flex:0 0 auto;">${caretChar}</button>
          <span style="font-size:13px;">${strangerIcon}</span>
          <span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(peer.publicKey)}">${escapeHtml(peer.name)}</span>
          <span style="font-size:9px;color:var(--text-muted);">${peerChannels.length > 0 ? `${peerChannels.length} ch · ` : ''}${lastConn}</span>
        </div>
        <div class="remote-peer-channels" style="margin-top:4px;margin-left:8px;">
          ${peerChannels.length === 0
            ? '<div style="font-size:10px;color:var(--text-muted);padding:2px 4px;">(对方还没分享 channel 给你)</div>'
            : peerChannels.map(c => `
              <div class="remote-channel-row" data-peer-id="${escapeHtml(peer.publicKey)}" data-channel-id="${escapeHtml(c.id)}"
                   style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:4px;font-size:12px;">
                <span>🤖</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(c.name || '')}">${escapeHtml(c.name || '(未命名)')}</span>
              </div>
            `).join('')
          }
        </div>
      </li>
    `;
  }).join('');
  list.innerHTML = html;

  // 2026-06-10: 折叠按钮点击 → 切折叠 (stopPropagation 防止冒泡触发 header 的分享 modal)
  list.querySelectorAll('.peer-caret-btn[data-toggle-peer]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pk = btn.getAttribute('data-toggle-peer');
      togglePeerCollapsed(pk);
    });
  });

  // 绑定: 点击 channel → 弹聊天窗口
  list.querySelectorAll('.remote-channel-row').forEach(row => {
    row.addEventListener('click', () => {
      const peerId = row.dataset.peerId;
      const channelId = row.dataset.channelId;
      const channelName = row.querySelector('span[title]')?.getAttribute('title') || channelId;
      console.log('[v3] 点击远端 channel:', peerId.substring(0,12), channelId);
      openRemoteChannelChat(peerId, channelId, channelName);
    });
  });
  // 绑定: 点击 peer 头部 → 弹分享 modal (让 A 决定分享本机哪些 channel 给这个 peer)
  list.querySelectorAll('.remote-peer-header').forEach(row => {
    row.addEventListener('click', (e) => {
      // 2026-06-10: 防御 — 点 caret 时已 stopPropagation, 但万一冒泡逃逸再挡一道
      if (e.target.closest('.peer-caret')) return;
      const peerName = row.dataset.peerName;
      const peerPk = row.dataset.peerPk;
      openShareToPeerModal(peerName, peerPk);
    });
  });

  // 2026-06-10: 渲染完成后同步 header 切换按钮图标
  if (typeof window.__syncP2PToggleAllBtn === 'function') window.__syncP2PToggleAllBtn();
}

/** v3: 分享 channel 给指定 peer 的 modal (A 侧用) */
async function openShareToPeerModal(peerName, peerPublicKey) {
  document.getElementById('share-to-peer-modal')?.remove();
  let allChannels = [];
  try {
    const res = await fetch('/channels');
    if (res.ok) allChannels = await res.json();
  } catch (err) { console.error('openShareToPeerModal:', err); }
  const rows = allChannels.length === 0
    ? '<div style="color:#6b7280;padding:12px;text-align:center;">还没有 channel</div>'
    : allChannels.map(ch => {
        const isShared = Array.isArray(ch.shared_with_peers) && ch.shared_with_peers.includes(peerPublicKey);
        return `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 4px;cursor:pointer;border-bottom:1px solid #f3f4f6;">
            <input type="checkbox" data-cid="${escapeHtml(ch.id)}" ${isShared ? 'checked' : ''} style="margin-top:4px;cursor:pointer;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:500;">${escapeHtml(ch.name)}</div>
              <div style="font-size:10px;color:#9ca3af;margin-top:2px;">
                ${isShared ? '✓ 已分享' : '未分享'} · ${ch.id}
              </div>
            </div>
          </label>
        `;
      }).join('');
  const html = `
    <div id="share-to-peer-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10003;display:flex;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:8px;width:480px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.2);">
        <div style="padding:12px 16px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:15px;font-weight:600;">分享 channel 给 ${escapeHtml(peerName)}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">${escapeHtml(peerPublicKey.substring(0,16))}…</div>
          </div>
          <button id="spm-close" style="background:none;border:none;font-size:20px;color:#6b7280;cursor:pointer;">×</button>
        </div>
        <div style="padding:8px 12px;background:#f9fafb;font-size:12px;color:#6b7280;">勾选要分享的 channel, 对方才能看到</div>
        <div id="spm-list" style="flex:1;overflow-y:auto;padding:8px 16px;">${rows}</div>
        <div style="padding:12px 20px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:8px;">
          <button id="spm-cancel" style="padding:6px 14px;border:1px solid #d1d5db;background:#fff;border-radius:4px;cursor:pointer;font-size:13px;">取消</button>
          <button id="spm-save" style="padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">保存分享</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('share-to-peer-modal');
  document.getElementById('spm-close').onclick = () => overlay.remove();
  document.getElementById('spm-cancel').onclick = () => overlay.remove();
  document.getElementById('spm-save').onclick = async () => {
    const checkedIds = [...overlay.querySelectorAll('input[type=checkbox][data-cid]:checked')].map(el => el.dataset.cid);
    // 对每个 channel 单独 PATCH — 设 shared_with_peers 为 checked 列表
    let ok = 0, fail = 0;
    for (const ch of allChannels) {
      const shouldShare = checkedIds.includes(ch.id);
      const wasShared = Array.isArray(ch.shared_with_peers) && ch.shared_with_peers.includes(peerPublicKey);
      if (shouldShare === wasShared) continue; // 没变化跳过
      const newList = (ch.shared_with_peers || []).filter((p) => p !== peerPublicKey);
      if (shouldShare) newList.push(peerPublicKey);
      try {
        const res = await fetch(`/channels/${encodeURIComponent(ch.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shared_with_peers: newList })
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
    }
    alert(`分享更新完成: 成功 ${ok}, 失败 ${fail}`);
    overlay.remove();
  };
}

/** v3: 跟远端 channel 聊天的简易弹窗
 *  2026-06-10 重写: UI 完全对齐本地聊天 (复用 addMessage / .messages / .bubble 整套样式),
 *  marked.parse + cleanThink + cleanEnv 自动生效, 不再裸文本.
 */
function openRemoteChannelChat(peerPublicKey, channelId, channelName) {
  // 移除已有 modal
  document.getElementById('remote-chat-modal')?.remove();
  const html = `
    <div id="remote-chat-modal" class="remote-chat-overlay">
      <div class="remote-chat-shell">
        <div class="remote-chat-header">
          <div style="flex:1;min-width:0;">
            <div class="remote-chat-title">🌐 跟 ${escapeHtml(channelName)} 聊天</div>
            <div class="remote-chat-meta">远端 peer: ${escapeHtml(peerPublicKey.substring(0,16))}… · ${escapeHtml(channelId)}</div>
          </div>
          <button id="rcm-refresh-history" title="重新拉历史" class="remote-chat-btn-secondary">↻ 历史</button>
          <button id="rcm-close" class="remote-chat-btn-close">×</button>
        </div>
        <div id="rcm-thinking" class="remote-chat-thinking" style="display:none;">
          📥 正在从远端拉历史 + 判断力…
        </div>
        <div id="rcm-log" class="messages remote-chat-log"></div>
        <div class="remote-chat-input-row">
          <input id="rcm-input" type="text" placeholder="输入消息, 发送到远端 channel..." class="remote-chat-input">
          <button id="rcm-send" class="remote-chat-btn-send">发送</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const log = document.getElementById('rcm-log');
  const inputEl = document.getElementById('rcm-input');
  const sendBtn = document.getElementById('rcm-send');
  const thinkingEl = document.getElementById('rcm-thinking');
  let historyRefreshTimer = null;
  document.getElementById('rcm-close').onclick = () => {
    if (historyRefreshTimer) { clearInterval(historyRefreshTimer); historyRefreshTimer = null; }
    document.getElementById('remote-chat-modal').remove();
  };
  document.getElementById('rcm-refresh-history').onclick = () => loadHistory(false);

  // 2026-06-10 改: 直接复用本地 addMessage, 自动获得 marked + think 折叠 + env 折叠 + 主题变量
  const append = (text, role) => {
    addMessage(text, role === 'user' ? 'user' : 'ai', false, log);
    log.scrollTop = log.scrollHeight;
  };

  // 系统提示用更轻量的样式 (不走 addMessage, 避免被当聊天记录裁剪)
  const appendSystem = (text, kind = 'info') => {
    const el = document.createElement('div');
    el.className = `remote-chat-sysmsg remote-chat-sysmsg-${kind}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  };

  // v3 新增: 拉 A 端的 channel 历史 (含 messages + judgments)
  async function loadHistory(isSilent) {
    if (!document.getElementById('remote-chat-modal')) return; // modal 已关闭

    if (isSilent) {
      try {
        const res = await fetch(`/api/remote-channels/chat-history?targetPublicKey=${encodeURIComponent(peerPublicKey)}&channelId=${encodeURIComponent(channelId)}`);
        if (!res.ok || !document.getElementById('remote-chat-modal')) return;
        const data = await res.json();
        const newMsgs = data.messages || [];
        const oldCount = log.querySelectorAll('.message').length;
        if (newMsgs.length === oldCount) return;
        const scrollWasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
        renderHistory(data);
        if (scrollWasAtBottom) {
          setTimeout(() => { log.scrollTop = log.scrollHeight; }, 50);
        }
      } catch (_) { /* 静默失败 */ }
      return;
    }

    thinkingEl.style.display = 'block';
    log.innerHTML = '';
    try {
      const res = await fetch(`/api/remote-channels/chat-history?targetPublicKey=${encodeURIComponent(peerPublicKey)}&channelId=${encodeURIComponent(channelId)}`);
      const data = await res.json();
      if (!res.ok) {
        appendSystem(`拉取失败: ${data.error || 'unknown'}`, 'error');
        thinkingEl.style.display = 'none';
        return;
      }
      renderHistory(data);
    } catch (err) {
      appendSystem(`拉取异常: ${err.message}`, 'error');
    } finally {
      thinkingEl.style.display = 'none';
    }
  }

  function renderHistory(data) {
    log.innerHTML = '';

    // 1. 显示 judgment 依据 (header) — 保留, 但用 class 化样式
    const judgments = data.judgments || { bound: [], candidates: [] };
    if (judgments.bound && judgments.bound.length > 0) {
      const jh = document.createElement('div');
      jh.className = 'remote-chat-judgments';
      let h = `<div class="remote-chat-judgments-title">🛡️ 对方 channel 绑定的判断力 (${judgments.bound.length} 条硬约束)</div>`;
      for (const j of judgments.bound) {
        h += `<div class="remote-chat-judgment-item">• <b>${escapeHtml((j.decision || '').slice(0, 100))}</b>${j.domain ? `<span class="remote-chat-judgment-tag"> [${escapeHtml(j.domain)}${j.stakes ? '/' + escapeHtml(j.stakes) : ''}]</span>` : ''}${j.reasons && j.reasons.length ? '<br><span class="remote-chat-judgment-reason">理由: ' + escapeHtml(j.reasons.join('; ').slice(0, 100)) + '</span>' : ''}</div>`;
      }
      if (judgments.candidates && judgments.candidates.length > 0) {
        h += `<div class="remote-chat-judgments-foot">+ ${judgments.candidates.length} 条候选判断力 (LLM 可自选参考)</div>`;
      }
      jh.innerHTML = h;
      log.appendChild(jh);
    }

    // 2. 显示历史 messages — 完全复用本地 addMessage 渲染
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      appendSystem('还没有历史消息, 在下面发第一条吧', 'info');
    } else {
      for (const m of msgs) {
        // 远端 owner 的 user 消息 vs 远端访客 (B) 的 user 消息 vs A 的 LLM 回复
        // 全部走 addMessage, 让 marked/think/env 自动处理. 来源用一个小 prefix 标记.
        const type = m.type === 'user' ? 'user' : 'ai';
        let prefix = '';
        if (m.type === 'user') {
          if (m.source === 'remote') {
            prefix = `🌐 远端访客${m.fromPublicKey ? ' (' + m.fromPublicKey.substring(0, 8) + '…)' : ''}\n\n`;
          } else {
            prefix = `👤 A (内部 owner)\n\n`;
          }
        } else {
          prefix = `🤖 A 的 LLM\n\n`;
        }
        addMessage(prefix + (m.content || ''), type, false, log);
      }
      setTimeout(() => { log.scrollTop = log.scrollHeight; }, 50);
    }
  }

  const doSend = async () => {
    const text = inputEl.value.trim();
    if (!text) return;
    append(text, 'user');
    inputEl.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '...';
    try {
      const res = await fetch('/api/remote-channels/chat-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPublicKey: peerPublicKey, channelId, text })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'send failed');
      // 不再 appendSystem('已发送...') —— 用户看到自己消息已上屏就知道, 系统提示是噪音
    } catch (err) {
      appendSystem('发送失败: ' + (err.message || err), 'error');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
    }
  };
  sendBtn.onclick = doSend;
  inputEl.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };
  // v3 新增: B 端远端 chat 也支持 @-autocomplete
  setupMentionAutocomplete(inputEl);
  inputEl.focus();
  startV3GlobalSSE();

  // 打开时立即拉历史
  loadHistory(false);

  // 每 15 秒自动静默刷新, 同步远端 owner 或其他访客的新消息
  historyRefreshTimer = setInterval(() => loadHistory(true), 15000);
}

// Phase 3: 我的 ID 按钮 → 真 modal (避免 confirm 在某些环境被禁用)
const showMyIdBtn = document.getElementById('show-my-p2p-id-btn');
if (showMyIdBtn) {
  showMyIdBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // 移除已有 modal
    document.getElementById('my-p2p-id-modal')?.remove();
    // 立即弹出 loading 状态 modal
    const html = `
      <div id="my-p2p-id-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10003;display:flex;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:8px;width:480px;max-width:92vw;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.2);">
          <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
            <div style="font-size:15px;font-weight:600;">🪪 我的 P2P 身份</div>
            <button id="mpim-close" style="background:none;border:none;font-size:20px;color:#6b7280;cursor:pointer;">×</button>
          </div>
          <div id="mpim-body" style="padding:16px 18px;">
            <div style="color:#6b7280;font-size:13px;margin-bottom:10px;">正在获取 publicKey…</div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('mpim-close').onclick = () => document.getElementById('my-p2p-id-modal').remove();

    try {
      const res = await fetch('/api/p2p-publickey');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const pk = data.publicKey || '';
      const body = document.getElementById('mpim-body');
      if (!pk || pk.length !== 64) {
        body.innerHTML = `<div style="color:#b91c1c;font-size:13px;">✗ P2PDirect 还没启动, 刷新页面稍后再试</div>`;
        return;
      }
      body.innerHTML = `
        <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">把下面这串发给好友, 好友在 P2P 好友区点 "+ 好友" 粘贴即可加你:</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:12px;">
          <code id="mpim-pk" style="flex:1;padding:8px 10px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;font-family:monospace;font-size:11px;word-break:break-all;line-height:1.4;">${escapeHtml(pk)}</code>
          <button id="mpim-copy" style="padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;white-space:nowrap;">📋 复制</button>
        </div>
        <div id="mpim-status" style="font-size:12px;color:#059669;min-height:16px;"></div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;">
          💡 同一个 role 重启后 publicKey 不会变, 好友不需要重新加你.
        </div>
      `;
      document.getElementById('mpim-copy').onclick = async () => {
        const statusEl = document.getElementById('mpim-status');
        try {
          await navigator.clipboard.writeText(pk);
          statusEl.textContent = '✓ 已复制到剪贴板';
        } catch {
          const ta = document.createElement('textarea');
          ta.value = pk;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); statusEl.textContent = '✓ 已复制 (fallback)'; }
          catch { statusEl.textContent = '✗ 复制失败, 请手动选中复制'; }
          document.body.removeChild(ta);
        }
      };
    } catch (err) {
      const body = document.getElementById('mpim-body');
      if (body) body.innerHTML = `<div style="color:#b91c1c;font-size:13px;">✗ 获取失败: ${escapeHtml(err.message || String(err))}</div>`;
    }
  });
}

// Phase 3 重做: + 添加好友按钮 → 弹窗输入 publicKey + name, 同时 joinPeer
const addPeerBtn = document.getElementById('add-p2p-peer-btn');
if (addPeerBtn) {
  addPeerBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = prompt('给这个 P2P 好友起个名字 (如: 同事-张磊)');
    if (!name) return;
    const publicKey = prompt('粘贴对方的 P2PDirect publicKey (64 字符 hex):\n\n获取方式: 对方在 http://localhost:54188/api/p2p-publickey');
    if (!publicKey) return;
    if (publicKey.length !== 64) {
      alert('publicKey 长度不对, 应该是 64 字符 hex');
      return;
    }
    try {
      // v3 新增: 改用 friend-request RPC — 不光 joinPeer, 还发申请到对方
      // 对方会收到 SSE friend-request 事件, 弹一个申请 modal
      const res = await fetch('/api/friend-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPublicKey: publicKey, name, message: '想加你为 P2P 好友, 共享 channel 协作' })
      });
      const data = await res.json();
      if (res.status === 502) {
        // 2026-06-10: 区分"对方不在线"和"写失败" — 让用户知道是否需要重试
        const reason = data.code === 'NO_CONN' ? '对方未在线或 P2P 握手超时' : '写入 P2P 通道失败';
        alert(`好友申请发送失败: ${reason}\n\n本地已记住对方 publicKey (${publicKey.substring(0,8)}...), 等对方上线后可在 P2P 面板手动重试.`);
        await loadRemoteChannels();
        return;
      }
      if (!res.ok) throw new Error(data.error || 'connect failed');
      // 成功 — 但不阻塞地等 ack (ack 经 SSE 'friend-request-ack' 推回, 由 v3GlobalEventSource 处理)
      window.__pendingFriendRequests = window.__pendingFriendRequests || new Map();
      if (data.requestId) {
        window.__pendingFriendRequests.set(data.requestId, { name, publicKey, at: Date.now() });
        // 8s 后还没 ack → 提示用户对方可能跑旧版 (无 ack 协议)
        setTimeout(() => {
          if (window.__pendingFriendRequests.has(data.requestId)) {
            window.__pendingFriendRequests.delete(data.requestId);
            console.warn(`[v3-friend] 申请超时未收到 ack (requestId=${data.requestId.substring(0,8)})`);
            showSimpleToast(`⚠️ 对方未确认收到 (可能是旧版客户端, 申请已发出但无法验证)`, 'warn');
          }
        }, 8000);
      }
      alert(`已发送好友申请给 ${name} (${publicKey.substring(0, 12)}...)\n对方收到后自己端弹申请 modal, 接受后会出现在 P2P 好友区.`);
      await loadRemoteChannels();
    } catch (err) {
      alert('申请失败: ' + (err.message || err));
    }
  });
}

/**
 * v3 新增: 收到好友申请时, 弹一个 modal 让用户接受或拒绝
 */
function showFriendRequestModal(req) {
  // 移除已有 modal
  document.getElementById('friend-request-modal')?.remove();
  // 2026-06-10: 同 Step 3 远端 chat modal 一样, 改用 class + CSS 变量, 跟本地风格统一
  const html = `
    <div id="friend-request-modal" class="friend-req-overlay">
      <div class="friend-req-shell">
        <div class="friend-req-header">
          <span style="font-size:20px;">🤝</span>
          <div style="flex:1;min-width:0;">
            <div class="friend-req-title">好友申请</div>
            <div class="friend-req-meta">来自 ${escapeHtml(req.fromName)} (${escapeHtml(req.fromPublicKey.substring(0, 16))}…)</div>
          </div>
        </div>
        <div class="friend-req-body">
          <p style="margin:0 0 8px;">${escapeHtml(req.message || '想加你为 P2P 好友')}</p>
          <p style="margin:0;color:var(--text-muted);font-size:11px;">接受后: 双方互加好友, 对方分享的 channel 会自动出现在 P2P 好友区.</p>
        </div>
        <div class="friend-req-actions">
          <button id="frm-deny" class="friend-req-btn-deny">拒绝</button>
          <button id="frm-accept" class="friend-req-btn-accept">接受</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  const close = () => document.getElementById('friend-request-modal')?.remove();
  document.getElementById('frm-deny').onclick = close;
  document.getElementById('frm-accept').onclick = async () => {
    close();
    try {
      const res = await fetch('/api/friend-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromPublicKey: req.fromPublicKey, name: req.fromName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'accept failed');
      console.log('[v3-friend] 接受了好友申请:', req.fromName);
      // 立刻拉一次 — 对方刚 accept, ta 的 channel 列表会被推到我们这
      setTimeout(loadRemoteChannels, 1000);
      showSimpleToast(`✅ 已接受 ${req.fromName} 的好友申请`);
    } catch (err) {
      console.error('[v3-friend] accept 失败:', err);
      alert('接受失败: ' + (err.message || err));
    }
  };
}

/**
 * 2026-06-10: 简单的右下 toast, 3s 自动消失. 用于 ack / 接受好友 等非阻塞反馈
 */
function showSimpleToast(text, kind = 'info') {
  const containerId = 'simple-toast-container';
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10005;display:flex;flex-direction:column;gap:8px;max-width:320px;';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `simple-toast simple-toast-${kind}`;
  el.style.cssText = `background:var(--bg-sidebar);color:var(--text);border:1px solid var(--border);padding:10px 14px;border-radius:6px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:inherit;animation:toast-in .2s ease-out;`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 320);
  }, 3000);
}

// 2026-06-10: P2P 全部展开/折叠切换按钮 (单按钮, 根据当前多数态切换)
const p2pToggleAllBtn = document.getElementById('p2p-toggle-all-btn');
if (p2pToggleAllBtn) {
  // 同步图标/文字: 多数 peer 折叠 → 显示 "⊞ 展开"; 多数展开 → 显示 "⊟ 折叠"
  function syncToggleAllBtn() {
    const allPks = new Set([
      ...knownPeers.map(p => p.publicKey),
      ...remoteChannels.map(g => g.peerId)
    ]);
    if (allPks.size === 0) {
      p2pToggleAllBtn.textContent = '⊞ 展开';
      p2pToggleAllBtn.title = '切换全部展开/折叠';
      return;
    }
    let collapsedCount = 0;
    for (const pk of allPks) if (collapsedPeers.has(pk)) collapsedCount++;
    const majorityCollapsed = collapsedCount >= allPks.size / 2;
    if (majorityCollapsed) {
      p2pToggleAllBtn.textContent = '⊞ 展开';
      p2pToggleAllBtn.title = '点击展开所有 P2P 好友';
    } else {
      p2pToggleAllBtn.textContent = '⊟ 折叠';
      p2pToggleAllBtn.title = '点击折叠所有 P2P 好友';
    }
  }
  p2pToggleAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const allPks = new Set([
      ...knownPeers.map(p => p.publicKey),
      ...remoteChannels.map(g => g.peerId)
    ]);
    if (allPks.size === 0) return;
    // 多数折叠 → 全展开; 否则全折叠
    let collapsedCount = 0;
    for (const pk of allPks) if (collapsedPeers.has(pk)) collapsedCount++;
    const majorityCollapsed = collapsedCount >= allPks.size / 2;
    if (majorityCollapsed) {
      expandAllPeers();
    } else {
      collapseAllPeers();
    }
    syncToggleAllBtn();
  });
  // 暴露给 renderRemoteChannels 渲染后调用 (保持图标跟实际状态一致)
  window.__syncP2PToggleAllBtn = syncToggleAllBtn;
  syncToggleAllBtn();  // 首次同步
}

// v3 双向刷新: 主动向所有好友发 agent.meta.list, 拿到 ta 们分享给我的 channel
const refreshSharedBtn = document.getElementById('refresh-shared-btn');
if (refreshSharedBtn) {
  refreshSharedBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const originalText = refreshSharedBtn.textContent;
    refreshSharedBtn.disabled = true;
    refreshSharedBtn.textContent = '...';
    try {
      const res = await fetch('/api/remote-channels/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'refresh failed');
      // 等 1.5s 让 RPC 回复回来 (向所有 peer 广播)
      await new Promise(r => setTimeout(r, 1500));
      await loadRemoteChannels();
      console.log(`[v3] 双向刷新: 向 ${data.peerCount || 0} 个好友发 list 请求`);
    } catch (err) {
      alert('刷新失败: ' + (err.message || err));
    } finally {
      refreshSharedBtn.disabled = false;
      refreshSharedBtn.textContent = originalText;
    }
  });
}

// 启动时拉一次 + 定期轮询 (SSE 接收 P2P reply 后也会更新)
loadRemoteChannels();
setInterval(loadRemoteChannels, 8000);
// 全局 SSE — 接收 remote-channel-update / remote-chat-reply / friend-request
startV3GlobalSSE();

// ============ v3: 折叠 + 拖拽分隔线 ============

// 给本地/远端 section 加 flex 修饰类 (CSS variable 驱动比例)
const localSection = document.querySelector('.sidebar-section'); // 第一个 section = 本地 channel
const remoteSection = document.getElementById('remote-agents-section');
if (localSection) localSection.classList.add('local-flex');
if (remoteSection) remoteSection.classList.add('remote-flex');

// 折叠: 点 header 切换 collapsed 类
const remoteHeader = document.getElementById('remote-agents-header');
if (remoteHeader && remoteSection) {
  remoteHeader.addEventListener('click', (e) => {
    // 阻止刷新按钮的事件冒泡在 refreshRemoteBtn 里已处理
    remoteSection.classList.toggle('collapsed');
  });
}

// 拖拽分隔线: 鼠标按下开始拖, mousemove 改 --local-flex / --remote-flex, mouseup 结束
const splitHandle = document.getElementById('sidebar-split-handle');
if (splitHandle && localSection && remoteSection) {
  // 初始化等分
  const updateFlexVars = (localRatio, remoteRatio) => {
    localSection.style.setProperty('--local-flex', String(localRatio));
    remoteSection.style.setProperty('--remote-flex', String(remoteRatio));
  };
  updateFlexVars(1, 1);

  let isDragging = false;
  let dragStartY = 0;
  let startLocalFlex = 1;
  let startRemoteFlex = 1;
  let sidebarHeight = 0;

  splitHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    splitHandle.classList.add('dragging');
    dragStartY = e.clientY;
    // 读当前 CSS variable 拿真实 flex 值
    const lf = parseFloat(getComputedStyle(localSection).getPropertyValue('--local-flex')) || 1;
    const rf = parseFloat(getComputedStyle(remoteSection).getPropertyValue('--remote-flex')) || 1;
    startLocalFlex = lf;
    startRemoteFlex = rf;
    // 父容器可用高度 = sidebar-section 总和 (本地+远端+handle)
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebarHeight = sidebar.clientHeight;
    e.preventDefault();
    document.body.style.cursor = 'ns-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaY = e.clientY - dragStartY;
    if (sidebarHeight <= 0) return;
    // deltaY 正 = 鼠标下移 = 拉大本地 / 缩小远端
    // 转换: 1 像素 ≈ sidebarHeight 中 0.005 的比例
    const deltaRatio = deltaY / sidebarHeight * 4; // 4 倍灵敏
    let newLocal = Math.max(0.1, startLocalFlex + deltaRatio);
    let newRemote = Math.max(0.1, startRemoteFlex - deltaRatio);
    updateFlexVars(newLocal, newRemote);
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    splitHandle.classList.remove('dragging');
    document.body.style.cursor = '';
  });

  // 双击分隔线 = 重置为等分
  splitHandle.addEventListener('dblclick', () => {
    updateFlexVars(1, 1);
  });
}

if (taskModal) {
  taskModal.addEventListener('click', (e) => {
    if (e.target === taskModal) {
      hideTaskModal();
    }
  });
}

if (taskAddBtn) {
  taskAddBtn.addEventListener('click', showCreateTaskModal);
}

if (taskExecuteNextBtn) {
  taskExecuteNextBtn.addEventListener('click', executeNextTask);
}

if (taskCancelBtn) {
  taskCancelBtn.addEventListener('click', hideCreateTaskModal);
}

if (createTaskModalClose) {
  createTaskModalClose.addEventListener('click', hideCreateTaskModal);
}

if (createTaskModal) {
  createTaskModal.addEventListener('click', (e) => {
    if (e.target === createTaskModal) {
      hideCreateTaskModal();
    }
  });
}

if (taskCreateBtn) {
  taskCreateBtn.addEventListener('click', createTask);
}

if (taskTypeSelect) {
  taskTypeSelect.addEventListener('change', () => {
    const workflowSteps = document.querySelector('.workflow-steps');
    if (workflowSteps) {
      workflowSteps.style.display = taskTypeSelect.value === 'workflow' ? 'block' : 'none';
    }
  });
}

// Handle SSE task status updates
const originalOnMessage = window.addEventListener ? null : null;

// Extend SSE handler for task updates
const originalConnect = connect;
connect = async function() {
  // Call original connect
  await originalConnect();

  // Reconnect SSE for task updates
  const taskEventSource = new EventSource('/events');

  taskEventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'task_status') {
        loadTasks();
      }
    } catch {}
  };

  taskEventSource.onerror = () => {
    taskEventSource.close();
  };
};

// =====================================================
// 钱包管理 (header 钱包按钮 → 全局管理面板)
// =====================================================
const walletModal = document.getElementById('wallet-modal');
const walletModalClose = document.getElementById('wallet-modal-close');
const walletBindAddress = document.getElementById('wallet-bind-address');
const walletGenerateBtn = document.getElementById('wallet-generate-btn');
const walletAutoTools = document.getElementById('wallet-auto-tools');
const walletBindBtn = document.getElementById('wallet-bind-btn');
const walletUnbindBtn = document.getElementById('wallet-unbind-btn');
const walletNewInfo = document.getElementById('wallet-new-info');
const walletListEl = document.getElementById('wallet-list');

/** 本次会话生成的私钥/助记词, 仅用于本地签名, 永不上传 */
let walletModalPendingSecret = null;
let walletModalPendingMnemonic = null;

function openWalletModal() {
  if (!walletModal) return;
  walletModalPendingSecret = null;
  walletNewInfo.style.display = 'none';
  walletNewInfo.innerHTML = '';
  walletBindAddress.value = '';
  // 用当前 channel 的状态预填
  const ch = channels.find(c => c.id === currentChannelId);
  if (ch) {
    walletBindAddress.value = ch.walletAddress || '';
    walletAutoTools.checked = !!ch.autoInvokeTools;
  }
  renderWalletList();
  walletModal.classList.add('active');
}

function closeWalletModal() {
  if (!walletModal) return;
  walletModal.classList.remove('active');
  walletModalPendingSecret = null;
}

if (walletModalClose) walletModalClose.addEventListener('click', closeWalletModal);

if (walletGenerateBtn) {
  walletGenerateBtn.addEventListener('click', async () => {
    walletNewInfo.style.display = 'block';
    walletNewInfo.innerHTML = '⏳ 正在生成真实 EVM 钱包...';
    try {
      const wallet = await generateRealWalletAsync();
      walletBindAddress.value = wallet.address;
      walletModalPendingSecret = wallet.privateKey;
      walletModalPendingMnemonic = wallet.mnemonic;
      walletNewInfo.innerHTML = formatWalletInfoHtml(wallet);
    } catch (err) {
      walletNewInfo.innerHTML = '✗ 生成钱包失败: ' + escapeHtml(err.message);
    }
  });
}

if (walletBindBtn) {
  walletBindBtn.addEventListener('click', async () => {
    if (!currentChannelId) {
      alert('请先在侧边栏选择一个智能体');
      return;
    }
    const address = (walletBindAddress.value || '').trim();
    if (!address) {
      alert('请输入钱包地址或点击「生成」');
      return;
    }
    const ch = channels.find(c => c.id === currentChannelId);
    const did = ch?.did || '';
    if (!did || did === 'undefined' || did === 'null') {
      alert('当前智能体还没有生成 DID, 请稍等几秒后重试');
      return;
    }

    // 服务端会用 recoverMessage 校验签名, 因此必须用本会话生成的私钥签名
    // (已绑过的钱包重新签名也会过, 因为 challenge 里有 channelId + DID)
    if (!walletModalPendingSecret) {
      alert('请先在「钱包管理」面板点击「生成」或导入私钥, 临时私钥仅在本会话保留');
      return;
    }
    let challenge;
    try {
      challenge = await signDIDChallengeAsync(walletModalPendingSecret, did, currentChannelId);
    } catch (err) {
      alert('签名失败: ' + err.message);
      return;
    }
    if (challenge.address.toLowerCase() !== address.toLowerCase()) {
      alert(`签名地址 ${challenge.address} 与输入地址 ${address} 不一致, 拒绝绑定`);
      return;
    }

    try {
      const res = await fetch(`/channels/${currentChannelId}/bind-wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: challenge.address,
          signature: challenge.signature,
          message: challenge.message,
          did: challenge.did,
          autoInvokeTools: !!walletAutoTools.checked
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'bind failed');
      }
      const updated = await res.json();
      const idx = channels.findIndex(c => c.id === currentChannelId);
      if (idx >= 0) channels[idx] = updated;
      renderChannels();
      renderWalletList();
      walletModalPendingSecret = null;
      walletModalPendingMnemonic = null;
      walletNewInfo.style.display = 'block';
      walletNewInfo.innerHTML =
        '✅ 绑定成功<br>' +
        '<strong>地址:</strong> <code>' + escapeHtml(updated.walletAddress) + '</code><br>' +
        '<strong>签名 DID:</strong> <code>' + escapeHtml(did) + '</code><br>' +
        '<small style="color:#9c9;">服务端已用 recoverMessage 校验签名, 证明你持有该钱包私钥。</small>';
    } catch (err) {
      alert('绑定失败: ' + err.message);
    }
  });
}

if (walletUnbindBtn) {
  walletUnbindBtn.addEventListener('click', async () => {
    if (!currentChannelId) {
      alert('请先选择一个智能体');
      return;
    }
    if (!confirm('解绑当前智能体的钱包?')) return;
    try {
      const res = await fetch(`/channels/${currentChannelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: null })
      });
      if (!res.ok) throw new Error('unbind failed');
      const updated = await res.json();
      const idx = channels.findIndex(c => c.id === currentChannelId);
      if (idx >= 0) channels[idx] = updated;
      walletBindAddress.value = '';
      renderChannels();
      renderWalletList();
    } catch (err) {
      alert('解绑失败: ' + err.message);
    }
  });
}

/** 渲染"所有已绑定钱包"列表 */
function renderWalletList() {
  if (!walletListEl) return;
  const bound = channels.filter(c => c.walletAddress);
  if (bound.length === 0) {
    walletListEl.innerHTML = '<div class="wallet-empty">暂未绑定钱包</div>';
    return;
  }
  // 用 DocumentFragment 避免多次 reflow
  const frag = document.createDocumentFragment();
  bound.forEach(ch => {
    const isActive = ch.id === currentChannelId;
    const chain = detectChain(ch.walletAddress);
    const row = document.createElement('div');
    row.className = 'wallet-row' + (isActive ? ' is-active' : '');
    row.innerHTML = `
      <span class="wallet-chain">${escapeHtml(chain)}</span>
      <div class="wallet-info">
        <span class="wallet-agent" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</span>
        <span class="wallet-address" title="${escapeHtml(ch.walletAddress)}">${escapeHtml(ch.walletAddress)}</span>
      </div>
      <div class="wallet-actions">
        <button class="wallet-mini-btn" data-action="copy" data-addr="${escapeHtml(ch.walletAddress)}" title="复制地址">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
        <button class="wallet-mini-btn" data-action="goto" data-id="${escapeHtml(ch.id)}" title="切换到该智能体">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7"></path>
          </svg>
        </button>
        <button class="wallet-mini-btn" data-action="unbind" data-id="${escapeHtml(ch.id)}" title="解绑">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;
    frag.appendChild(row);
  });
  walletListEl.innerHTML = '';
  walletListEl.appendChild(frag);

  // 事件委托: 一次绑定处理三个动作
  walletListEl.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(btn.dataset.addr);
        btn.style.background = 'var(--accent)';
        btn.style.color = 'var(--bg)';
        setTimeout(() => { btn.style.background = ''; btn.style.color = ''; }, 800);
      } catch {}
    } else if (action === 'goto') {
      closeWalletModal();
      selectChannel(btn.dataset.id);
    } else if (action === 'unbind') {
      if (!confirm('解绑该智能体的钱包?')) return;
      try {
        const res = await fetch(`/channels/${btn.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: null })
        });
        if (!res.ok) throw new Error('unbind failed');
        const updated = await res.json();
        const idx = channels.findIndex(c => c.id === btn.dataset.id);
        if (idx >= 0) channels[idx] = updated;
        renderChannels();
        renderWalletList();
        if (btn.dataset.id === currentChannelId) walletBindAddress.value = '';
      } catch (err) {
        alert('解绑失败: ' + err.message);
      }
    }
  };
}

function detectChain(addr) {
  if (!addr) return '?';
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'EVM';
  if (/^0x[0-9a-fA-F]{64}$/.test(addr)) return 'SUI';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return 'SOL';
  return '?';
}

// 启动应用
init();

// =====================================================
// 智能体目录：catalog add 按钮 + 钱包注册 + 自动工具调用
// =====================================================
const catalogAddBtn = document.getElementById('catalog-add-btn');
const agentAddModal = document.getElementById('agent-add-modal');
const agentAddTitle = document.getElementById('agent-add-title');
const agentAddModalClose = document.getElementById('agent-add-modal-close');
const agentAddName = document.getElementById('agent-add-name');
const agentAddWallet = document.getElementById('agent-add-wallet');
const agentAddAutoTools = document.getElementById('agent-add-auto-tools');
const agentAddConfirmBtn = document.getElementById('agent-add-confirm-btn');
const agentAddCancelBtn = document.getElementById('agent-add-cancel-btn');
const agentAddWalletInfo = document.getElementById('agent-add-wallet-info');
const agentGenerateWalletBtn = document.getElementById('agent-generate-wallet-btn');

/** 客户端只为提示, 不向服务端发送私钥 */
let pendingWalletSecret = null;          // 本会话待绑定的私钥, 仅浏览器内存
let pendingWalletMnemonic = null;        // 本会话待绑定的助记词, 仅浏览器内存

function openAgentAddModal(existingChannel) {
  if (!agentAddModal) return;
  if (existingChannel) {
    agentAddTitle.textContent = '配置智能体：' + existingChannel.name;
    agentAddName.value = existingChannel.name || '';
    agentAddName.readOnly = false; // v3: 名字改成可编辑 (PATCH 支持更新 name)
    agentAddName.placeholder = '输入新名称';
    agentAddWallet.value = existingChannel.walletAddress || '';
    agentAddAutoTools.checked = !!existingChannel.autoInvokeTools;
    agentAddConfirmBtn.dataset.mode = 'update';
    agentAddConfirmBtn.dataset.channelId = existingChannel.id;
    agentAddConfirmBtn.dataset.originalName = existingChannel.name || '';
  } else {
    agentAddTitle.textContent = '添加智能体';
    agentAddName.value = '';
    agentAddName.readOnly = false;
    agentAddName.placeholder = '例如: 交易助手';
    agentAddWallet.value = '';
    agentAddAutoTools.checked = true;
    agentAddConfirmBtn.dataset.mode = 'create';
    delete agentAddConfirmBtn.dataset.channelId;
    delete agentAddConfirmBtn.dataset.originalName;
  }
  agentAddWalletInfo.style.display = 'none';
  agentAddWalletInfo.innerHTML = '';
  pendingWalletSecret = null;
  agentAddModal.classList.add('active');
}

function closeAgentAddModal() {
  if (!agentAddModal) return;
  agentAddModal.classList.remove('active');
  pendingWalletSecret = null;
}

/** 生成真实 EVM 钱包: BIP-39 助记词 + secp256k1 私钥 + EIP-55 校验和地址
 *  通过 window.WalletViem (来自 components/wallet-viem.mjs, viem 驱动) 调用.
 *  失败时降级到旧的演示模式, 但 UI 会提示用户.
 */
async function generateRealWalletAsync() {
  if (!window.WalletViem) {
    throw new Error('钱包模块尚未加载, 请稍后重试');
  }
  return window.WalletViem.generateRealWallet();
}

async function importRealWalletByPrivateKey(privateKeyHex) {
  if (!window.WalletViem) {
    throw new Error('钱包模块尚未加载, 请稍后重试');
  }
  return window.WalletViem.importEVMWallet(privateKeyHex);
}

async function signDIDChallengeAsync(privateKeyHex, did, channelId) {
  if (!window.WalletViem) {
    throw new Error('钱包模块尚未加载, 请稍后重试');
  }
  return window.WalletViem.signDIDChallenge(privateKeyHex, did, channelId);
}

function formatWalletInfoHtml({ address, privateKey, mnemonic }) {
  const parts = [
    '✓ 已生成真实 EVM 钱包 (BIP-39 + secp256k1 + EIP-55)',
    '<strong>地址:</strong> <code>' + escapeHtml(address) + '</code>',
  ];
  if (mnemonic) {
    parts.push(
      '<strong>助记词 (12 词, 请抄写保存):</strong>',
      '<code style="color:#fc6;word-break:break-all;">' + escapeHtml(mnemonic) + '</code>'
    );
  }
  parts.push(
    '<strong>私钥 (0x + 32 字节):</strong>',
    '<code style="color:#f88;word-break:break-all;">' + escapeHtml(privateKey) + '</code>',
    '<small style="color:#f88;">⚠ 助记词 + 私钥均仅在本浏览器内存, 关闭页面后无法找回。</small>',
    '<small style="color:#999;">签名绑定到 channel DID (EIP-191 personal_sign) 会发送到服务端, 用于证明钱包所有权。</small>'
  );
  return parts.join('<br>');
}

if (agentGenerateWalletBtn) {
  agentGenerateWalletBtn.addEventListener('click', async () => {
    agentAddWalletInfo.style.display = 'block';
    agentAddWalletInfo.innerHTML = '⏳ 正在生成真实 EVM 钱包...';
    try {
      const wallet = await generateRealWalletAsync();
      agentAddWallet.value = wallet.address;
      pendingWalletSecret = wallet.privateKey;
      pendingWalletMnemonic = wallet.mnemonic;
      agentAddWalletInfo.innerHTML = formatWalletInfoHtml(wallet);
    } catch (err) {
      agentAddWalletInfo.innerHTML = '✗ 生成钱包失败: ' + escapeHtml(err.message);
    }
  });
}

if (catalogAddBtn) {
  catalogAddBtn.addEventListener('click', () => openAgentAddModal(null));
}
if (agentAddModalClose) agentAddModalClose.addEventListener('click', closeAgentAddModal);
if (agentAddCancelBtn) agentAddCancelBtn.addEventListener('click', closeAgentAddModal);

if (agentAddConfirmBtn) {
  agentAddConfirmBtn.addEventListener('click', async () => {
    const mode = agentAddConfirmBtn.dataset.mode || 'create';
    const name = (agentAddName.value || '').trim();
    if (!name && mode === 'create') {
      alert('请输入智能体名称');
      return;
    }
    const walletAddress = (agentAddWallet.value || '').trim();
    const autoInvokeTools = !!agentAddAutoTools.checked;

    try {
      if (mode === 'create') {
        const res = await fetch('/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            agentId: currentAgentId,
            walletAddress: walletAddress || undefined,
            autoInvokeTools
          })
        });
        if (!res.ok) throw new Error('create failed');
        const channel = await res.json();
        channels.push(channel);
        renderChannels();
        selectChannel(channel.id);
      } else {
        // update
        const channelId = agentAddConfirmBtn.dataset.channelId;
        const originalName = agentAddConfirmBtn.dataset.originalName || '';
        // v3 新增: 名字改了才发 (没改就不发, 保持原状)
        const body = { walletAddress: walletAddress || null, autoInvokeTools };
        if (name && name !== originalName) {
          body.name = name;
        }
        const res = await fetch(`/channels/${channelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('update failed');
        const updated = await res.json();
        const idx = channels.findIndex(c => c.id === channelId);
        if (idx >= 0) channels[idx] = updated;
        renderChannels();
      }
      closeAgentAddModal();
    } catch (err) {
      console.error('Failed to save agent:', err);
      alert('保存失败: ' + err.message);
    }
  });
}
