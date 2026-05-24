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
    console.log('[加载频道] 从服务器获取到', channels.length, '个频道');
    channels.forEach((ch, i) => {
      console.log(`  [${i}] ${ch.name} - did: "${ch.did}"`);
    });
    renderChannels();
  } catch (err) {
    console.error('[加载频道] 失败:', err);
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
    newChannelInput.value = '';

    // 后台更新 DID（如果还没有的话）
    if (!channel.did || channel.did === 'undefined') {
      console.log('[创建频道] 后台生成 DID...');
      // 触发后台刷新，DID 会在下次请求时更新
      setTimeout(() => {
        fetch('/channels').then(res => res.json()).then(allChannels => {
          channels = allChannels;
          const updated = channels.find(c => c.id === channel.id);
          if (updated && updated.did && updated.did !== 'undefined') {
            console.log('[创建频道] DID 生成完成:', updated.did);
          }
        });
      }, 2000);
    }
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
  console.log('[selectChannel] 开始切换到:', channelId);

  // 立即更新当前频道 ID
  currentChannelId = channelId;
  reconnectAttempts = 0;

  // 找到当前频道
  const channel = channels.find(c => c.id === channelId);
  if (channel && channelNameEl) {
    channelNameEl.textContent = channel.name;
    console.log('[selectChannel] 频道:', channel.name, 'DID:', channel.did || '无');
  }

  renderChannels();

  // 关闭旧 SSE 连接
  if (eventSource) {
    console.log('[selectChannel] 关闭旧 SSE 连接');
    eventSource.close();
    eventSource = null;
  }

  // 清空消息区域
  messagesEl.innerHTML = '';

  // 加载 session
  try {
    const res = await fetch(`/sessions/${channelId}`);
    const session = await res.json();
    if (session.messages && session.messages.length > 0) {
      session.messages.forEach(msg => {
        addMessage(msg.content, msg.type, false);
      });
    } else {
      addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false);
    }
  } catch (err) {
    console.error('[selectChannel] 加载 session 失败:', err);
    addMessage('你好！我是 Bolloon Agent。有什么我可以帮你的吗？', 'ai', false);
  }

  // 建立新 SSE 连接
  console.log('[selectChannel] 建立 SSE 连接');
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
      bubble.textContent = messageBody;
      div.appendChild(bubble);
    }
  } else if (cleanContent) {
    // 没有环境信息时，思考放在消息之前
    if (thinkContainer) {
      div.appendChild(thinkContainer);
    }
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

function handleTaskStatusEvent(data) {
  console.log('[工作流] 任务状态:', data);

  // 获取或创建工作流显示区域
  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    messagesEl.appendChild(workflowDisplayEl);
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

function handleWorkflowStepEvent(data) {
  console.log('[工作流] 步骤:', data);

  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    messagesEl.appendChild(workflowDisplayEl);
  }

  const streamsDiv = workflowDisplayEl.querySelector('.workflow-streams');

  // 如果有步骤标签，显示步骤信息
  if (data.step) {
    const stepEl = document.createElement('div');
    stepEl.className = 'workflow-step-stream';
    stepEl.innerHTML = `
      <div class="step-label">🔧 ${data.step}</div>
      <div class="step-content">${data.content || ''}</div>
    `;
    streamsDiv.appendChild(stepEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function handleWorkflowLoopEvent(data) {
  console.log('[工作流] 循环:', data);

  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    messagesEl.appendChild(workflowDisplayEl);
  }

  const loopCount = workflowDisplayEl.querySelector('.workflow-loop-count');
  const streamsDiv = workflowDisplayEl.querySelector('.workflow-streams');

  // 更新循环次数
  if (data.loopCount !== undefined) {
    loopCount.textContent = `循环 #${data.loopCount}`;
    loopCount.style.display = 'inline';
  }

  // 显示循环信息
  if (data.content) {
    const loopEl = document.createElement('div');
    loopEl.className = 'workflow-loop-item';
    loopEl.innerHTML = `
      <div class="loop-header">
        <span class="loop-icon">🔁</span>
        <span>循环 ${data.loopCount || '?'}</span>
        <span class="loop-status">${data.status || ''}</span>
      </div>
      <div class="loop-content">${data.content}</div>
    `;
    streamsDiv.appendChild(loopEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// 用户命令可视化 - 当用户发送命令时调用
let userCommandDisplayEl = null;

function showUserCommand(command) {
  // 移除之前的命令显示
  if (userCommandDisplayEl) {
    userCommandDisplayEl.remove();
  }

  // 创建命令显示
  userCommandDisplayEl = document.createElement('div');
  userCommandDisplayEl.className = 'user-command-display';
  userCommandDisplayEl.innerHTML = `
    <div class="command-prompt">
      <span class="prompt-icon">›</span>
      <span class="prompt-text">${command}</span>
    </div>
  `;

  // 在工作流显示之前插入
  if (workflowDisplayEl) {
    messagesEl.insertBefore(userCommandDisplayEl, workflowDisplayEl);
  } else {
    messagesEl.appendChild(userCommandDisplayEl);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function connect() {
  // 关闭已有连接
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const sseUrl = currentChannelId ? `/events?channelId=${encodeURIComponent(currentChannelId)}` : '/events';
  console.log('[connect] 创建 SSE 连接:', sseUrl);

  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    console.log('[SSE] 已连接');
    reconnectAttempts = 0;
  };

  eventSource.onerror = (err) => {
    console.error('[SSE] 连接错误', err);
    eventSource.close();
    eventSource = null;
    reconnectAttempts++;
    setTimeout(connect, Math.min(5000 * reconnectAttempts, 30000));
  };

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      console.log('[SSE] 收到消息:', data.type, 'channelId:', data.channelId);

      // 只处理当前频道的消息
      if (data.channelId && data.channelId !== currentChannelId) {
        console.log('[SSE] 忽略非当前频道消息');
        return;
      }

      if (data.type === 'user') {
          showUserCommand(data.content); // 显示用户命令
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
        } else if (data.type === 'task_status') {
          handleTaskStatusEvent(data);
        } else if (data.type === 'workflow_step') {
          handleWorkflowStepEvent(data);
        } else if (data.type === 'workflow_loop') {
          handleWorkflowLoopEvent(data);
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
const p2pMyCid = document.getElementById('p2p-my-cid');
const p2pCopyCid = document.getElementById('p2p-copy-cid');
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
    console.log('[P2P] loadP2PIdentity 开始');
    console.log('[P2P] currentChannelId:', currentChannelId);

    // 先确保 channels 数据是最新的
    const res = await fetch('/channels');
    if (res.ok) {
      channels = await res.json();
      console.log('[P2P] 加载频道:', channels.length, '个');
      channels.forEach((ch, i) => {
        console.log(`  [${i}] ${ch.name} - id: ${ch.id} - did: "${ch.did}" - cid: "${ch.cid}"`);
      });
    } else {
      console.log('[P2P] 获取频道失败:', res.status);
    }

    // 获取当前频道的身份
    console.log('[P2P] 查找频道, currentChannelId:', currentChannelId);
    const channel = channels.find(c => c.id === currentChannelId);
    console.log('[P2P] 找到频道:', channel ? channel.name : '未找到');

    if (channel && channel.did && channel.did !== 'undefined' && channel.did !== '') {
      myDID = channel.did;
      console.log('[P2P] 设置 DID:', myDID);
      if (p2pMyDid) p2pMyDid.textContent = myDID;
      if (p2pMyCid) p2pMyCid.textContent = channel.cid && channel.cid !== 'undefined' ? channel.cid : '-';
    } else {
      console.log('[P2P] 频道没有 DID，显示未配置');
      if (p2pMyDid) p2pMyDid.textContent = '未配置';
      if (p2pMyCid) p2pMyCid.textContent = '-';
    }
  } catch (err) {
    console.error('[P2P] 加载失败:', err);
    if (p2pMyDid) p2pMyDid.textContent = '加载失败';
    if (p2pMyCid) p2pMyCid.textContent = '-';
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
    <div class="p2p-channel-item ${ch.id === currentChannelId ? 'active' : ''}" onclick="selectChannel('${ch.id}')">
      <span class="p2p-channel-icon">💬</span>
      <div class="p2p-channel-info">
        <span class="p2p-channel-name">${ch.name}</span>
        <span class="p2p-channel-did">${ch.did ? ch.did.substring(0, 40) + '...' : '未生成 DID'}</span>
        ${ch.cid ? `<span class="p2p-channel-cid">CID: ${ch.cid.substring(0, 20)}...</span>` : ''}
      </div>
      <span class="p2p-channel-action">${ch.id === currentChannelId ? '当前' : '选择'}</span>
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

if (p2pCopyCid) {
  p2pCopyCid.addEventListener('click', async () => {
    const channel = channels.find(c => c.id === currentChannelId);
    if (channel && channel.cid) {
      try {
        await navigator.clipboard.writeText(channel.cid);
        const original = p2pCopyCid.title;
        p2pCopyCid.title = '已复制!';
        setTimeout(() => { p2pCopyCid.title = original; }, 1500);
      } catch {}
    }
  });
}

if (p2pCopyLink) {
  p2pCopyLink.addEventListener('click', async () => {
    if (myDID) {
      const channel = channels.find(c => c.id === currentChannelId);
      const cid = channel?.cid || '';
      let link = `bolloon://connect?did=${encodeURIComponent(myDID)}`;
      if (cid) {
        link += `&cid=${encodeURIComponent(cid)}`;
      }
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
      // 解析输入中的 did 和 cid
      let didToConnect = input;
      let cidToConnect = '';

      const didMatch = input.match(/did=([^&]+)/);
      const cidMatch = input.match(/cid=([^&]+)/);

      if (didMatch) didToConnect = decodeURIComponent(didMatch[1]);
      if (cidMatch) cidToConnect = decodeURIComponent(cidMatch[1]);

      // 如果输入不是 URL 格式，直接作为 DID 使用
      if (!input.includes('did=') && !input.includes('cid=')) {
        didToConnect = input;
      }

      console.log('[连接] 尝试连接:', { did: didToConnect, cid: cidToConnect });

      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: didToConnect, cid: cidToConnect })
      });

      if (res.ok) {
        const data = await res.json();
        if (p2pConnectInput) p2pConnectInput.value = '';
        addMessage(`连接请求已发送: ${data.message || '成功'}`, 'ai');
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

  taskList.innerHTML = tasks.map(task => `
    <div class="task-item ${task.status}" data-id="${task.id}">
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
        ${task.status === 'pending' ? `<button class="btn-sm btn-primary" onclick="executeTask('${task.id}')">▶ 执行</button>` : ''}
        ${task.status === 'running' ? `<button class="btn-sm" disabled>执行中...</button>` : ''}
        ${task.status === 'completed' ? `<button class="btn-sm" onclick="deleteTask('${task.id}')">删除</button>` : ''}
        ${task.status === 'failed' ? `<button class="btn-sm btn-primary" onclick="retryTask('${task.id}')">重试</button>` : ''}
      </div>
    </div>
  `).join('');
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
