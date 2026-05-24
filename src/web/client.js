const messagesEl = document.getElementById('messages');
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

let eventSource = null;
let currentChannelId = null;
let currentAgentId = '';
let channels = [];
let isSidebarCollapsed = false;
let reconnectAttempts = 0;

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
    renderChannels();
  } catch (err) {
    console.error('Failed to load channels:', err);
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
    channels.push(channel);
    renderChannels();
    selectChannel(channel.id);
    newChannelInput.value = '';
  } catch (err) {
    console.error('Failed to create channel:', err);
  }
}

async function deleteChannel(channelId, e) {
  e.stopPropagation();
  try {
    await fetch(`/channels/${channelId}`, { method: 'DELETE' });
    channels = channels.filter(c => c.id !== channelId);
    if (currentChannelId === channelId) {
      currentChannelId = channels[0]?.id || null;
      if (currentChannelId) {
        await loadSession(currentChannelId);
      } else {
        messagesEl.innerHTML = '';
      }
    }
    renderChannels();
    renderCollapsedChannels();
  } catch (err) {
    console.error('Failed to delete channel:', err);
  }
}

function renderChannels() {
  if (!channelList) return;
  channelList.innerHTML = '';
  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = `channel-item ${ch.id === currentChannelId ? 'active' : ''}`;
    li.onclick = () => {
      expandSidebar();
      selectChannel(ch.id);
    };
    li.innerHTML = `
      <div class="channel-icon">💬</div>
      <span class="channel-name">${ch.name}</span>
      <button class="channel-delete" data-id="${ch.id}">×</button>
    `;
    channelList.appendChild(li);
  });

  channelList.querySelectorAll('.channel-delete').forEach(btn => {
    btn.onclick = (e) => deleteChannel(btn.dataset.id, e);
  });
}

function renderCollapsedChannels() {
  return;
}

async function selectChannel(channelId) {
  currentChannelId = channelId;
  reconnectAttempts = 0;
  renderChannels();
  renderCollapsedChannels();
  await loadSession(channelId);

  const channel = channels.find(c => c.id === channelId);
  if (channel && channelNameEl) {
    channelNameEl.textContent = channel.name;
  }

  connect();
}

async function loadSession(channelId) {
  try {
    const res = await fetch(`/sessions/${channelId}`);
    const session = await res.json();
    messagesEl.innerHTML = '';
    if (session.messages && session.messages.length > 0) {
      session.messages.forEach(msg => {
        addMessage(msg.content, msg.type, false);
      });
    } else {
      addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false);
    }
  } catch (err) {
    console.error('Failed to load session:', err);
    messagesEl.innerHTML = '';
    addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false);
  }
}

function addMessage(content, type, save = true) {
  const div = document.createElement('div');
  div.className = `message message-${type}`;

  // 清理内容：移除 tool call 标记和其他不应该显示的内容
  let cleanContent = content
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .replace(/TOOL_CALL[\s\S]*?\/TOOL_CALL/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/{\s*"tool":[\s\S]*?}/g, '')
    .replace(/\[Function[^\]]*\]\s*/g, '')
    .trim();

  const envMatch = cleanContent.match(/^(.+?)\n<environment_details>([\s\S]*?)<\/environment_details>\n([\s\S]*)$/);

  if (envMatch) {
    const identity = envMatch[1].trim();
    const envDetails = envMatch[2].trim();
    const messageBody = envMatch[3].trim();

    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = identity;
    div.appendChild(header);

    const envDiv = document.createElement('div');
    envDiv.className = 'environment-details';
    envDiv.textContent = `<environment_details>${envDetails}</environment_details>`;
    div.appendChild(envDiv);

    if (messageBody) {
      const bubble = document.createElement('div');
      bubble.className = `bubble bubble-${type}`;
      bubble.textContent = messageBody;
      div.appendChild(bubble);
    }
  } else if (cleanContent) {
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${type}`;
    bubble.textContent = cleanContent;
    div.appendChild(bubble);
  } else {
    return; // 没有有效内容，不显示空消息
  }

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  div.appendChild(time);
  messagesEl.appendChild(div);

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  hideTyping();
  const div = document.createElement('div');
  div.className = 'message message-ai';
  div.id = 'typing';
  div.innerHTML = '<div class="typing"><div class="typing-spinner"></div><span class="typing-text">思考中...</span></div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTyping() {
  const typing = document.getElementById('typing');
  if (typing) typing.remove();
  hideStreaming();
}

let streamingMessageEl = null;

function showStreaming() {
  hideStreaming();
  streamingMessageEl = document.createElement('div');
  streamingMessageEl.className = 'message message-ai';
  streamingMessageEl.id = 'streaming';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-ai streaming-content';
  streamingMessageEl.appendChild(bubble);
  messagesEl.appendChild(streamingMessageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideStreaming() {
  if (streamingMessageEl) {
    streamingMessageEl.remove();
    streamingMessageEl = null;
  }
}

function updateStreamingContent(content) {
  if (streamingMessageEl) {
    const bubble = streamingMessageEl.querySelector('.streaming-content');
    if (bubble) {
      bubble.textContent = content;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }
}

function handleStreamEvent(data) {
  if (data.streamType === 'thinking') {
    showStreaming();
    updateStreamingContent(data.content || '思考中...');
  } else if (data.streamType === 'token') {
    showStreaming();
    const current = streamingMessageEl?.querySelector('.streaming-content')?.textContent || '';
    updateStreamingContent(current + data.content);
  }
}

function handleStatusEvent(data) {
  showStreaming();
  const icon = data.tool ? `🔧 ${data.tool}: ` : '';
  updateStreamingContent(icon + data.content);
}

function connect() {
  if (eventSource) {
    eventSource.close();
  }

  const sseUrl = currentChannelId ? `/events?channelId=${encodeURIComponent(currentChannelId)}` : '/events';

  try {
    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      console.log('SSE connected');
      reconnectAttempts = 0;
    };

    eventSource.onerror = (err) => {
      console.error('SSE error', err);
      eventSource.close();
      reconnectAttempts++;
      setTimeout(connect, Math.min(5000 * reconnectAttempts, 30000));
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.channelId && data.channelId !== currentChannelId) {
          return;
        }

        if (data.type === 'user') {
          addMessage(data.content, 'user');
        } else if (data.type === 'ai') {
          addMessage(data.content, 'ai');
        } else if (data.type === 'stream') {
          handleStreamEvent(data);
        } else if (data.type === 'status') {
          handleStatusEvent(data);
        } else if (data.type === 'done') {
          hideTyping();
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
          addMessage('错误: ' + data.content, 'ai');
        }
      } catch (parseErr) {
        console.error('Parse error', parseErr);
      }
    };
  } catch (err) {
    console.error('SSE connect error', err);
    setTimeout(connect, 5000);
  }
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  showTyping();

  try {
    const res = await fetch('/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, channelId: currentChannelId })
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

sendBtn.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
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

async function init() {
  const themeData = await loadTheme();
  currentAgentId = themeData.agentId || `agent_${generateId().substring(0, 8)}`;
  await saveTheme(themeData.theme, currentAgentId);

  await loadChannels();

  if (channels.length > 0) {
    await selectChannel(channels[0].id);
  } else {
    await createChannel('默认会话');
  }
}

init();

// P2P Network Modal
const p2pModal = document.getElementById('p2p-modal');
const p2pNetworkBtn = document.getElementById('p2p-network-btn');
const p2pModalClose = document.getElementById('p2p-modal-close');
const p2pMyDid = document.getElementById('p2p-my-did');
const p2pCopyDid = document.getElementById('p2p-copy-did');
const p2pCopyLink = document.getElementById('p2p-copy-link');
const p2pConnectInput = document.getElementById('p2p-connect-input');
const p2pConnectBtn = document.getElementById('p2p-connect-btn');
const p2pPeersList = document.getElementById('p2p-peers-list');
const p2pPeersCount = document.getElementById('p2p-peers-count');
const p2pChannelsList = document.getElementById('p2p-channels-list');

let myDID = '';
let peers = [];

async function loadP2PIdentity() {
  try {
    const res = await fetch('/api/identity');
    if (res.ok) {
      const data = await res.json();
      myDID = data.did || '';
      if (p2pMyDid) p2pMyDid.textContent = myDID || '未配置';
    } else {
      if (p2pMyDid) p2pMyDid.textContent = '未配置';
    }
  } catch {
    if (p2pMyDid) p2pMyDid.textContent = '加载失败';
  }
}

async function loadP2PPeers() {
  try {
    const res = await fetch('/api/peers');
    if (res.ok) {
      peers = await res.json();
      renderP2PPeers();
    } else {
      peers = [];
      renderP2PPeers();
    }
  } catch {
    peers = [];
    renderP2PPeers();
  }
}

function renderP2PPeers() {
  if (!p2pPeersList) return;
  if (!p2pPeersCount) return;

  p2pPeersCount.textContent = peers.length.toString();

  if (peers.length === 0) {
    p2pPeersList.innerHTML = '<div class="p2p-empty">暂无连接的节点</div>';
    return;
  }

  p2pPeersList.innerHTML = peers.map(peer => `
    <div class="p2p-peer-item">
      <div class="p2p-peer-info">
        <span class="p2p-peer-id">${peer.publicKey || peer.id || 'unknown'}</span>
        <span class="p2p-peer-status online">已连接</span>
      </div>
      <button class="btn-small" onclick="sendToPeer('${peer.publicKey || peer.id}', 'Hello!')">发送消息</button>
    </div>
  `).join('');
}

function renderP2PChannels() {
  if (!p2pChannelsList) return;

  if (channels.length === 0) {
    p2pChannelsList.innerHTML = '<div class="p2p-empty">暂无频道</div>';
    return;
  }

  p2pChannelsList.innerHTML = channels.map(ch => `
    <div class="p2p-channel-item" onclick="selectChannel('${ch.id}')">
      <span class="p2p-channel-icon">💬</span>
      <span class="p2p-channel-name">${ch.name}</span>
      <span class="p2p-channel-action">选择</span>
    </div>
  `).join('');
}

function showP2PModal() {
  if (p2pModal) {
    p2pModal.classList.add('active');
    loadP2PIdentity();
    loadP2PPeers();
    renderP2PChannels();
  }
}

function hideP2PModal() {
  if (p2pModal) {
    p2pModal.classList.remove('active');
  }
}

if (p2pNetworkBtn) {
  p2pNetworkBtn.addEventListener('click', showP2PModal);
}

if (p2pModalClose) {
  p2pModalClose.addEventListener('click', hideP2PModal);
}

if (p2pModal) {
  p2pModal.addEventListener('click', (e) => {
    if (e.target === p2pModal) {
      hideP2PModal();
    }
  });
}

if (p2pCopyDid) {
  p2pCopyDid.addEventListener('click', async () => {
    if (myDID) {
      try {
        await navigator.clipboard.writeText(myDID);
        const original = p2pCopyDid.title;
        p2pCopyDid.title = '已复制!';
        setTimeout(() => { p2pCopyDid.title = original; }, 1500);
      } catch {}
    }
  });
}

if (p2pCopyLink) {
  p2pCopyLink.addEventListener('click', async () => {
    if (myDID) {
      const link = `bolloon://connect?did=${encodeURIComponent(myDID)}`;
      try {
        await navigator.clipboard.writeText(link);
        const original = p2pCopyLink.textContent;
        p2pCopyLink.textContent = '已复制!';
        setTimeout(() => { p2pCopyLink.textContent = original; }, 1500);
      } catch {}
    }
  });
}

if (p2pConnectBtn) {
  p2pConnectBtn.addEventListener('click', async () => {
    const input = p2pConnectInput?.value.trim();
    if (!input) return;

    try {
      let didToConnect = input;
      const match = input.match(/did=([^&]+)/);
      if (match) didToConnect = decodeURIComponent(match[1]);

      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: didToConnect })
      });

      if (res.ok) {
        if (p2pConnectInput) p2pConnectInput.value = '';
        await loadP2PPeers();
      } else {
        const data = await res.json();
        addMessage(`连接失败: ${data.error || '未知错误'}`, 'ai');
      }
    } catch (err) {
      addMessage('连接失败', 'ai');
    }
  });
}

async function sendToPeer(peerId, message) {
  try {
    const res = await fetch('/api/message-p2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId, message })
    });
    if (res.ok) {
      addMessage(`已发送消息到 ${peerId.substring(0, 16)}...`, 'ai');
    }
  } catch {
    addMessage('发送失败', 'ai');
  }
}
