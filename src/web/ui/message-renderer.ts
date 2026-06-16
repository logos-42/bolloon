/**
 * message-renderer.ts — 对话显示 UI (2026-06-15 从 client.js 拆出, .js → .ts)
 *
 * 职责 (单一):
 *   - 把 user / AI 内容渲染成 DOM 气泡 (含 marked.parse 渲染)
 *   - 处理流式 token 累积 (textNode 增量, O(1), 不重排)
 *   - finalize 流式消息为正式 AI 气泡
 *   - 折叠 think / environment_details 块
 *   - 复制 / 重新回答 / 蒸馏为判断 按钮
 *   - 挂载 step-timeline (2026-06-15) 步骤状态条到每条 AI 消息内
 *
 * 状态 (本模块私有):
 *   - streamingMessageEl / streamingTextNode / streamingText
 *   - lastUserCommand / lastAiContent  (去重)
 *
 * 依赖 (import):
 *   - 浏览器 API (document, marked, fetch, navigator)
 *   - ./step-timeline (4 状态步骤条模块)
 *
 * 不依赖 (零业务 import, 防循环):
 *   - 不 import client.js
 *   - 不 import 任何业务模块
 *
 * 输入 (从 client.js 调用):
 *   - addMessage(content, type, save, container, usedIds, ctx)
 *   - handleStreamTokenEvent({ streamType, content }, ctx)
 *   - finalizeTimelineAsMessage(ctx)
 *   - handleStepEvent({ type: 'step_start'|'step_done'|'step_error', ... }, ctx)
 *   - escapeHtml(s)
 *   - getMessagesContainerForCurrent(currentChannelId, messagesContainers, messagesEl)
 *
 * 输出 (DOM):
 *   - .message / .bubble / .think-container / .env-container
 *   - .message-streaming (流式期间, finalize 时移除)
 *   - .message-actions (复制/重新回答/蒸馏按钮)
 *   - .used-judgments-link (P0.5 反向引用)
 *   - .step-timeline (气泡内步骤状态条, 由 ./step-timeline 渲染)
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------
import {
  mountStepTimeline,
  pushStepToTimeline,
  migrateStepTimeline,
  getStepTimeline,
} from './step-timeline.js';
export type MessageType = 'user' | 'ai' | 'system' | 'error';

export interface StreamTokenEvent {
  streamType: 'token' | 'thinking';
  content: string;
}

export interface RendererCtx {
  messagesEl: HTMLElement | null;
  messagesContainers: Map<string, HTMLElement>;
  currentChannelId: string | null;
  lastUsedJudgmentIds?: string[];
  /** 引用 client.js 函数, 避免循环 import */
  openJudgmentsModalWithFilter?: (ids: string[]) => void;
  workflowDisplayEl?: HTMLElement | null;
  /**
   * B-3 (2026-06-15) 3 状态机回调:
   *   - setTimelineState('streaming'): 首个 token 来时切到 streaming (蓝徽)
   *   - setTimelineState('done'): finalize 时切到 done (绿徽), 1.5s 后自动 hide
   * 走 ctx 注入而非直接 import, 保持 message-renderer 零业务依赖.
   */
  setTimelineState?: (state: 'idle' | 'loading' | 'streaming' | 'done') => void;
}

export interface UsedJudgmentsLink {
  length: number;
  ids: string[];
}

// ---------------------------------------------------------------------------
// 模块私有状态
// ---------------------------------------------------------------------------
let streamingMessageEl: HTMLElement | null = null;
let streamingTextNode: Text | null = null;
let streamingText = '';
let lastUserCommand = '';
let lastAiContent = '';

/**
 * 2026-06-17: 流式状态查询 — 客户端用它在收到 server `ai` 事件时判断是否需要跳过 addMessage,
 *   避免和后续 `done` → finalizeTimelineAsMessage 产生双气泡.
 *   流式过程中 (streamingText > 0) server 推 `ai(content=fullResponse)` 时跳过,
 *   真正渲染走 `done` 触发的 finalizeTimelineAsMessage.
 */
export function hasStreamingText(): boolean {
  return streamingText.length > 0;
}

// 滚动限频 (60ms 16fps, 减 reflow)
let scrollToBottomTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScrollToBottom(container: HTMLElement | null): void {
  if (!container) return;
  if (scrollToBottomTimer) return;
  scrollToBottomTimer = setTimeout(() => {
    container.scrollTop = container.scrollHeight;
    scrollToBottomTimer = null;
  }, 60);
}

// ---------------------------------------------------------------------------
// 容器选择 (主入口或 per-channel 容器)
// ---------------------------------------------------------------------------
export function getMessagesContainerForCurrent(
  currentChannelId: string | null,
  messagesContainers: Map<string, HTMLElement>,
  messagesEl: HTMLElement | null
): HTMLElement | null {
  if (currentChannelId && messagesContainers.get(currentChannelId)) {
    return messagesContainers.get(currentChannelId) || null;
  }
  return messagesEl;
}

// ---------------------------------------------------------------------------
// HTML escape (供 think / env 折叠块用)
// ---------------------------------------------------------------------------
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c] as string));
}

// ---------------------------------------------------------------------------
// 主入口: 渲染一条消息气泡 (user / ai / system)
// ---------------------------------------------------------------------------
export function addMessage(
  content: string,
  type: MessageType,
  save: boolean = true,
  container?: HTMLElement | null,
  usedJudgmentIds: string[] = [],
  ctx: RendererCtx = { messagesEl: null, messagesContainers: new Map(), currentChannelId: null }
): void {
  const messagesEl = ctx.messagesEl || (typeof document !== 'undefined' ? document.getElementById('messages') : null);
  const messagesContainers = ctx.messagesContainers || new Map<string, HTMLElement>();
  const currentChannelId = ctx.currentChannelId;
  const msgContainer = container || getMessagesContainerForCurrent(currentChannelId, messagesContainers, messagesEl);

  // 内存保护: 单个 channel 容器超过 200 条, 旧会话加载时淘汰最旧
  if (!save && msgContainer && msgContainer.children.length > 200) {
    const toRemove = msgContainer.children.length - 200;
    for (let i = 0; i < toRemove; i++) {
      const first = msgContainer.firstElementChild;
      if (first) msgContainer.removeChild(first);
    }
  }

  // 去重 (save=true 时)
  if (save) {
    const lastContent = type === 'user' ? lastUserCommand : lastAiContent;
    if (lastContent && content === lastContent) {
      console.log(`[addMessage] 跳过重复的 ${type} 消息`);
      return;
    }
    if (type === 'user') lastUserCommand = content;
    else lastAiContent = content;
  }

  const div = document.createElement('div');
  div.className = `message message-${type}`;

  // 清理: 移除 tool_call 标记
  let cleanContent = content
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .replace(/TOOL_CALL[\s\S]*?\/TOOL_CALL/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\{\s*"tool":[\s\S]*?\}/g, '')
    .replace(/\{\s*tool\s*=>\s*["'][^"']+["']\s*(?:,\s*args\s*=>\s*\{[\s\S]*?\})?\s*\}/g, '')
    .replace(/\[Function[^\]]*\]\s*/g, '')
    .trim();

  // think 折叠
  const thinkMatch = cleanContent.match(/<think>([\s\S]*?)<\/think>/);
  let mainContent = cleanContent;
  let thinkContainer: HTMLElement | null = null;
  if (thinkMatch) {
    const thinkContent = thinkMatch[1].trim();
    mainContent = cleanContent.replace(/<think>[\s\S]*?<\/think>/, '').trim();
    thinkContainer = buildThinkContainer(thinkContent);
  }

  // environment_details 折叠 + 身份头
  const envMatch = mainContent.match(/^(.+?)\n<environment_details>([\s\S]*?)<\/environment_details>\n([\s\S]*)$/);
  if (envMatch) {
    const identity = envMatch[1].trim();
    const envDetails = envMatch[2].trim();
    const messageBody = envMatch[3].trim();
    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = identity;
    div.appendChild(header);
    div.appendChild(buildEnvContainer(envDetails));
    if (thinkContainer) div.appendChild(thinkContainer);
    if (messageBody) div.appendChild(buildBubble(messageBody, type));
  } else if (cleanContent) {
    if (thinkContainer) div.appendChild(thinkContainer);
    div.appendChild(buildBubble(cleanContent, type));
  } else {
    return; // 空内容, 不上屏
  }

  // 纯文本用于复制按钮
  const rawContent = cleanContent
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');

  // 时间
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  // AI 消息操作按钮
  if (type === 'ai') {
    div.appendChild(buildMessageActions(div, rawContent, ctx));
  }

  // P0.5 反向引用
  if (type === 'ai' && Array.isArray(usedJudgmentIds) && usedJudgmentIds.length > 0) {
    const link = document.createElement('a');
    link.className = 'used-judgments-link';
    link.textContent = `📎 参考 ${usedJudgmentIds.length} 条原则`;
    link.onclick = (e) => {
      e.preventDefault();
      if (typeof ctx.openJudgmentsModalWithFilter === 'function') {
        ctx.openJudgmentsModalWithFilter(usedJudgmentIds);
      }
    };
    div.appendChild(link);
  }

  // 2026-06-15: 每条 AI 消息挂一个空 step-timeline 占位 (用户决策)
  //   后续 step_start/step_done 事件会通过 handleStepEvent 推入
  if (type === 'ai' && msgContainer) {
    mountStepTimeline(div, currentChannelId);
  }

  div.appendChild(time);
  if (msgContainer) {
    msgContainer.appendChild(div);
    scheduleScrollToBottom(msgContainer);
  }
}

// ---------------------------------------------------------------------------
// 私有: think 折叠块
// ---------------------------------------------------------------------------
function buildThinkContainer(thinkContent: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'think-container';
  const toggle = document.createElement('div');
  toggle.className = 'think-toggle';
  toggle.innerHTML = '💭 思考过程 <span class="think-arrow">▸</span>';
  toggle.onclick = function() {
    const details = container.querySelector('.think-content') as HTMLElement | null;
    const arrow = toggle.querySelector('.think-arrow') as HTMLElement | null;
    if (!details || !arrow) return;
    if (details.style.display === 'none') {
      details.style.display = 'block';
      arrow.textContent = '▾';
    } else {
      details.style.display = 'none';
      arrow.textContent = '▸';
    }
  };
  const content = document.createElement('div');
  content.className = 'think-content';
  content.style.display = 'none';
  content.innerHTML = `<pre>${escapeHtml(thinkContent)}</pre>`;
  container.appendChild(toggle);
  container.appendChild(content);
  return container;
}

// ---------------------------------------------------------------------------
// 私有: environment_details 折叠块
// ---------------------------------------------------------------------------
function buildEnvContainer(envDetails: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'env-container';
  const toggle = document.createElement('div');
  toggle.className = 'env-toggle';
  toggle.innerHTML = '⚙️ 环境信息 <span class="env-arrow">▸</span>';
  toggle.onclick = function() {
    const details = container.querySelector('.environment-details') as HTMLElement | null;
    const arrow = toggle.querySelector('.env-arrow') as HTMLElement | null;
    if (!details || !arrow) return;
    if (details.style.display === 'none') {
      details.style.display = 'block';
      arrow.textContent = '▾';
    } else {
      details.style.display = 'none';
      arrow.textContent = '▸';
    }
  };
  const content = document.createElement('div');
  content.className = 'environment-details';
  content.style.display = 'none';
  content.innerHTML = `<pre>${escapeHtml(envDetails)}</pre>`;
  container.appendChild(toggle);
  container.appendChild(content);
  return container;
}

// ---------------------------------------------------------------------------
// 私有: 气泡 (marked.parse 渲染)
// ---------------------------------------------------------------------------
function buildBubble(text: string, type: MessageType): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = `bubble bubble-${type}`;
  // 安全降级: CDN 加载失败时 marked 是 escape 版本, 这里不需要二次 escape
  // window.marked 在 ts 类型上不一定有, 用 any 兜底
  const marked = (window as any).marked;
  bubble.innerHTML = marked ? marked.parse(text) : escapeHtml(text);
  return bubble;
}

// ---------------------------------------------------------------------------
// 私有: 消息操作按钮 (复制 / 重新回答 / 蒸馏为判断)
// ---------------------------------------------------------------------------
function buildMessageActions(div: HTMLElement, rawContent: string, ctx: RendererCtx): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // 复制
  const copyBtn = document.createElement('button');
  copyBtn.className = 'action-btn copy-btn';
  copyBtn.innerHTML = copyIcon() + ' 复制';
  copyBtn.title = '复制消息';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(rawContent).then(() => {
      copyBtn.innerHTML = checkIcon() + ' 已复制';
      setTimeout(() => { copyBtn.innerHTML = copyIcon() + ' 复制'; }, 2000);
    });
  };
  actions.appendChild(copyBtn);

  // 蒸馏为判断
  const saveJudgmentBtn = document.createElement('button');
  saveJudgmentBtn.className = 'action-btn save-as-judgment';
  saveJudgmentBtn.title = 'AI 蒸馏为 30-80 字判断力 + 自动演化对齐';
  saveJudgmentBtn.setAttribute('data-decision', rawContent.substring(0, 800));
  if (ctx.currentChannelId) saveJudgmentBtn.setAttribute('data-channel-id', ctx.currentChannelId);
  saveJudgmentBtn.innerHTML = shieldIcon() + ' 蒸馏为判断';
  actions.appendChild(saveJudgmentBtn);

  // 重新回答
  const regenBtn = document.createElement('button');
  regenBtn.className = 'action-btn regenerate-btn';
  regenBtn.innerHTML = refreshIcon(false) + ' 重新回答';
  regenBtn.title = '重新生成回复';
  regenBtn.onclick = () => {
    regenBtn.innerHTML = refreshIcon(true) + ' 生成中...';
    regenBtn.disabled = true;
    const messages = div.parentElement?.querySelectorAll('.message') || [];
    let lastUserMsg = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.classList.contains('message-user')) {
        const bubble = msg.querySelector('.bubble') as HTMLElement | null;
        if (bubble) { lastUserMsg = bubble.textContent || bubble.innerText || ''; break; }
      }
    }
    fetch('/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: ctx.currentChannelId, userMessage: lastUserMsg })
    }).then(res => {
      if (!res.ok) throw new Error('regenerate failed');
    }).catch(err => {
      console.error('重新生成失败:', err);
      regenBtn.innerHTML = refreshIcon(false) + ' 失败';
      setTimeout(() => {
        regenBtn.innerHTML = refreshIcon(false) + ' 重新回答';
        regenBtn.disabled = false;
      }, 2000);
    });
  };
  actions.appendChild(regenBtn);
  return actions;
}

function copyIcon(): string { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'; }
function checkIcon(): string { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>'; }
function shieldIcon(): string { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4z"></path><path d="M9 12l2 2 4-4"></path></svg>'; }
function refreshIcon(spin: boolean = false): string { const cls = spin ? ' class="spin"' : ''; return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"${cls}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg>`; }

// ---------------------------------------------------------------------------
// 流式 token 处理 (textNode 增量, 不重排)
// ---------------------------------------------------------------------------
export function handleStreamTokenEvent(data: StreamTokenEvent, ctx: RendererCtx = { messagesEl: null, messagesContainers: new Map(), currentChannelId: null }): void {
  const messagesEl = ctx.messagesEl || (typeof document !== 'undefined' ? document.getElementById('messages') : null);
  const messagesContainers = ctx.messagesContainers || new Map<string, HTMLElement>();
  const currentChannelId = ctx.currentChannelId;
  const container = getMessagesContainerForCurrent(currentChannelId, messagesContainers, messagesEl);
  if (!container) return;
  const delta = data.content || '';
  if (!delta) return;

  if (!streamingMessageEl || !streamingMessageEl.isConnected) {
    // 新建流式消息
    streamingMessageEl = document.createElement('div');
    streamingMessageEl.className = 'message message-ai message-streaming';
    streamingTextNode = document.createTextNode('');
    streamingMessageEl.appendChild(streamingTextNode);
    streamingText = '';
    // 2026-06-15: 流式期间也挂一个空 step-timeline 占位 — step_start/done/error 事件
    //   走 handleStepEvent, getStepTimeline 找到这个流式元素内的 timeline 推入
    mountStepTimeline(streamingMessageEl, currentChannelId);
    container.appendChild(streamingMessageEl);
    // B-3: 首个 token 来时切状态到 streaming (蓝徽), 提示用户 panel 在工作
    if (typeof ctx.setTimelineState === 'function') {
      ctx.setTimelineState('streaming');
    }
    scheduleScrollToBottom(container);
  }
  if (streamingTextNode) streamingTextNode.appendData(delta);
  streamingText += delta;
  scheduleScrollToBottom(container);
}

// ---------------------------------------------------------------------------
// 流式消息 finalize (done 事件): 移除流式元素, 走 addMessage 走 marked.parse
// ---------------------------------------------------------------------------
export function finalizeTimelineAsMessage(ctx: RendererCtx = { messagesEl: null, messagesContainers: new Map(), currentChannelId: null }): void {
  const messagesEl = ctx.messagesEl || (typeof document !== 'undefined' ? document.getElementById('messages') : null);
  const messagesContainers = ctx.messagesContainers || new Map<string, HTMLElement>();
  const currentChannelId = ctx.currentChannelId;
  const container = getMessagesContainerForCurrent(currentChannelId, messagesContainers, messagesEl);
  if (streamingText.trim().length > 0) {
    // 2026-06-15: finalize 时把 streaming 内的 step-timeline 整体搬到新建的正式 AI message 内
    //   addMessage 会建一个新 timeline 占位, 先记下 streaming 的引用, addMessage 后再迁移
    //   避免节点从 0 重渲 (10+ 步的任务, 重渲闪烁会很厉害)
    const oldStreamingEl = streamingMessageEl;
    if (oldStreamingEl && oldStreamingEl.parentNode) {
      oldStreamingEl.parentNode.removeChild(oldStreamingEl);
    }
    addMessage(streamingText, 'ai', true, container, ctx.lastUsedJudgmentIds || [], ctx);
    if (oldStreamingEl && container) {
      // 找刚 addMessage 创建的最后一条 ai message
      const newAiMsg = container.querySelector('.message-ai:last-of-type') as HTMLElement | null;
      if (newAiMsg && newAiMsg !== oldStreamingEl) {
        migrateStepTimeline(oldStreamingEl, newAiMsg);
      }
    }
  }
  // 重置流式状态
  streamingMessageEl = null;
  streamingTextNode = null;
  streamingText = '';
  // B-3: finalize 时切 done 状态 (绿徽), hide 延迟由 client.js 的 hideTimelinePanel 统一管
  if (typeof ctx.setTimelineState === 'function') {
    ctx.setTimelineState('done');
  }
}

// ---------------------------------------------------------------------------
// 用户命令装饰条 (showUserCommand) — 2026-06-16 整段删除, SSE 已走 addMessage 路径
//   2026-06-11 修: 不再走 showUserCommand (› 装饰条) 路径 — 会和 user bubble 双重显示

// ---------------------------------------------------------------------------
// 2026-06-15: step-timeline 事件入口 (server 推 step_start/step_done/step_error)
//   找到当前正在流式 / 最后一条 AI 消息的 timeline 容器, 推入
// ---------------------------------------------------------------------------
export interface StepEvent {
  type: 'step_start' | 'step_done' | 'step_error';
  tool?: string;
  content?: string;
  success?: boolean;
  output?: string;
  error?: string;
  args?: Record<string, unknown>;
}

export function handleStepEvent(data: StepEvent, ctx: RendererCtx = { messagesEl: null, messagesContainers: new Map(), currentChannelId: null }): void {
  const messagesEl = ctx.messagesEl || (typeof document !== 'undefined' ? document.getElementById('messages') : null);
  const messagesContainers = ctx.messagesContainers || new Map<string, HTMLElement>();
  const currentChannelId = ctx.currentChannelId;
  const container = getMessagesContainerForCurrent(currentChannelId, messagesContainers, messagesEl);
  if (!container) return;
  if (!data || !data.type) return;

  // 1. 优先用正在流式的元素 (流式期间能即时看到)
  let target: HTMLElement | null = streamingMessageEl && streamingMessageEl.isConnected
    ? streamingMessageEl
    : null;
  // 2. 否则用最后一条 AI message
  if (!target) {
    const aiMsgs = container.querySelectorAll('.message-ai');
    if (aiMsgs.length === 0) return;
    target = aiMsgs[aiMsgs.length - 1] as HTMLElement;
  }
  if (!target) return;

  const timeline = getStepTimeline(target);
  if (!timeline) return;

  pushStepToTimeline(timeline, data.type, {
    tool: data.tool || 'unknown',
    args: data.args,
    success: data.success,
    output: data.output,
    error: data.error,
  });
}

// ---------------------------------------------------------------------------
// 重置模块状态 (切频道时调用)
// ---------------------------------------------------------------------------
export function resetRendererState(): void {
  streamingMessageEl = null;
  streamingTextNode = null;
  streamingText = '';
  lastUserCommand = '';
  lastAiContent = '';
  if (scrollToBottomTimer) {
    clearTimeout(scrollToBottomTimer);
    scrollToBottomTimer = null;
  }
}

export const MessageRenderer = {
  addMessage,
  handleStreamTokenEvent,
  finalizeTimelineAsMessage,
  handleStepEvent,
  escapeHtml,
  getMessagesContainerForCurrent,
  resetRendererState,
};

declare global {
  interface Window {
    MR?: typeof MessageRenderer;
  }
}

if (typeof window !== 'undefined') {
  window.MR = MessageRenderer;
}
