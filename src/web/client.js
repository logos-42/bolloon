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
let reconnectTimer = null; // 改进: 跟踪重连定时器
let lastUserCommand = ''; // 防止用户消息重复显示
let lastAiContent = ''; // 防止 AI 消息重复显示

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

  // 使用 DocumentFragment 减少 DOM 操作
  const fragment = document.createDocumentFragment();

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

    const deleteBtn = li.querySelector('.channel-delete');
    if (deleteBtn) {
      deleteBtn.onclick = (e) => deleteChannel(ch.id, e);
    }

    fragment.appendChild(li);
  });

  channelList.appendChild(fragment);
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
    actionsDiv.appendChild(regenerateBtn);
    div.appendChild(actionsDiv);
  }

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
  // 始终确保有工作流显示区域
  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    messagesEl.appendChild(workflowDisplayEl);
  }

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
  // 检查是否是工具调用结果
  const content = data.content || '';
  const isJsonResult = content.startsWith('{') && content.includes('"success"');

  if (isJsonResult) {
    // 工具结果：折叠显示
    showToolResult(data.tool, content);
  } else {
    // 普通状态：流式显示
    showStreaming();
    const icon = data.tool ? `🔧 ${data.tool}: ` : '';
    updateStreamingContent(icon + data.content);
  }
}

// 显示工具调用结果（折叠）
let toolResultContainer = null;

function showToolResult(toolName, resultJson) {
  // 清理之前的流式显示
  hideStreaming();

  // 获取或创建工具结果容器
  if (!toolResultContainer) {
    toolResultContainer = document.createElement('div');
    toolResultContainer.className = 'tool-results-container';
    messagesEl.appendChild(toolResultContainer);
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  console.log('[工作流] 步骤标签:', data.step, '内容:', data.content?.substring(0, 80));

  // 获取或创建工作流显示区域
  if (!workflowDisplayEl) {
    workflowDisplayEl = createWorkflowDisplay();
    messagesEl.appendChild(workflowDisplayEl);
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
  // 先移除之前的消息中的 user bubble（如果有重复的话）
  const existingUserBubbles = messagesEl.querySelectorAll('.message-user');
  existingUserBubbles.forEach(el => el.remove());

  // 移除之前的命令显示
  if (userCommandDisplayEl) {
    userCommandDisplayEl.remove();
  }

  // 创建美化版本的命令显示
  userCommandDisplayEl = document.createElement('div');
  userCommandDisplayEl.className = 'message message-user';
  userCommandDisplayEl.innerHTML = `
    <div class="user-command-display">
      <div class="command-prompt">
        <span class="prompt-icon">›</span>
        <span class="prompt-text">${command}</span>
      </div>
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
  // 清除旧的重连定时器
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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

  eventSource.onerror = () => {
    console.error('[SSE] 连接错误');
    eventSource.close();
    eventSource = null;
    reconnectAttempts++;
    // 清除旧的重连定时器
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, Math.min(5000 * reconnectAttempts, 30000));
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
        showUserCommand(data.content); // 用户命令可视化（已包含 message-user）
        // 不再调用 addMessage，避免重复
      } else if (data.type === 'ai') {
          addMessage(data.content, 'ai');
        } else if (data.type === 'stream') {
          handleStreamEvent(data);
        } else if (data.type === 'regenerating') {
          // 开始重新生成，清除最后一个 AI 消息
          const messages = messagesEl.querySelectorAll('.message-ai');
          if (messages.length > 0) {
            const lastAiMsg = messages[messages.length - 1];
            lastAiMsg.remove();
          }
          showTyping();
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

const apiConfigBtn = document.getElementById('api-config-btn');
if (apiConfigBtn) {
  apiConfigBtn.addEventListener('click', () => {
    window.location.href = '/api-config';
  });
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

// 启动应用
init();

