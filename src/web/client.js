const messagesEl = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const sidebar = document.getElementById('sidebar');
const sidebarCollapsed = document.getElementById('sidebar-collapsed');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarExpand = document.getElementById('sidebar-expand');
const themeToggle = document.getElementById('theme-toggle');
const channelList = document.getElementById('channel-list');
const newChannelBtn = document.getElementById('new-channel-btn');
const newChannelInput = document.getElementById('new-channel-input');
const channelNameEl = document.getElementById('channel-name');
const loadSessionBtn = document.getElementById('load-session-btn');
const sessionFileInput = document.getElementById('session-file-input');
const collapsedChannels = document.getElementById('collapsed-channels');

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
    sidebarCollapsed.classList.remove('hidden');
    renderCollapsedChannels();
  } else {
    sidebar.classList.remove('collapsed');
    sidebarCollapsed.classList.add('hidden');
  }
}

function expandSidebar() {
  isSidebarCollapsed = false;
  sidebar.classList.remove('collapsed');
  sidebarCollapsed.classList.add('hidden');
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
  if (!collapsedChannels) return;
  collapsedChannels.innerHTML = '';
  channels.forEach(ch => {
    const btn = document.createElement('button');
    btn.className = `collapsed-channel ${ch.id === currentChannelId ? 'active' : ''}`;
    btn.setAttribute('data-name', ch.name);
    btn.textContent = '💬';
    btn.onclick = () => {
      expandSidebar();
      selectChannel(ch.id);
    };
    collapsedChannels.appendChild(btn);
  });
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

  const envMatch = content.match(/^(.+?)\n<environment_details>([\s\S]*?)<\/environment_details>\n([\s\S]*)$/);

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
  } else {
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${type}`;
    bubble.textContent = content;
    div.appendChild(bubble);
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

if (sidebarExpand) {
  sidebarExpand.addEventListener('click', expandSidebar);
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
