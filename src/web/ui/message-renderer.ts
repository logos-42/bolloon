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
// 2026-07-01 (v0.2.6): 共享后端切 LLM 输出. 消除 <invoke>/<function_calls>/<tool_call>
//   等各种 LLM 格式在前端气泡里出现的 bug.
import { segmentChatReply } from '../../agents/chat-segmenter.js';
export type MessageType = 'user' | 'ai' | 'system' | 'error';

export interface StreamTokenEvent {
  streamType: 'token' | 'thinking';
  content: string;
}

export interface RendererCtx {
  messagesEl: HTMLElement | null;
  messagesContainers: Map<string, HTMLElement>;
  currentChannelId: string | null;
  /** 2026-07-01 (v0.2.6): 注册到 client 的工具名集合 — segmenter 用它决定 tool_call 段是否保留 */
  knownToolNames?: Set<string>;
  /** tool_call segment 渲染时回调 (外层挂到 step-timeline) */
  toolCallCallback?: (tool: { name: string; args: Record<string, string> }, hostEl: HTMLElement) => void;
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

// 2026-07-20: Bug 1 — 非流式模式 step 事件缓冲, 按 channelId 分组
const stepEventBuffer = new Map<string, StepEvent[]>();

/**
 * 2026-06-17: 流式状态查询 — 客户端用它在收到 server `ai` 事件时判断是否需要跳过 addMessage,
 *   避免和后续 `done` → finalizeTimelineAsMessage 产生双气泡.
 *   流式过程中 (streamingText > 0) server 推 `ai(content=fullResponse)` 时跳过,
 *   真正渲染走 `done` 触发的 finalizeTimelineAsMessage.
 */
export function hasStreamingText(): boolean {
  return streamingText.length > 0;
}

// 2026-07-06: SSE 重连恢复用 — 把 streamingText 替换成 server 给的 fullContent
//   然后 caller 调 finalizeTimelineAsMessage 把它落定为正式气泡
export function replaceStreamingText(fullContent: string): void {
  if (!streamingTextNode || !streamingMessageEl) {
    // 还没启动流式元素 — 不动, 让 caller 自己 addMessage
    return;
  }
  streamingTextNode.nodeValue = String(fullContent || '');
  streamingText = String(fullContent || '');
}

// 2026-07-06: SSE 重连时 server 说"还在生成", 把现有的 streamingMessageEl 填上 partialText
//   让用户看到 AI 在生成中的状态, 不会卡死
export function injectRecoveredText(partialText: string, ctx: RendererCtx = { messagesEl: null, messagesContainers: new Map(), currentChannelId: null }): void {
  if (streamingMessageEl && streamingTextNode) {
    streamingTextNode.nodeValue = String(partialText || '');
    streamingText = String(partialText || '');
    return;
  }
  // 还没流式元素 — 创建一个空流式容器, 然后把 partialText 灌进去, 用户看到"AI 在思考"
  handleStreamTokenEvent(
    {
      type: 'token',
      streamType: 'token',
      content: String(partialText || ''),
      delta: String(partialText || ''),
    } as any,
    ctx
  );
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
  ctx: RendererCtx = { messagesEl: null, messagesContainers: new Map(), currentChannelId: null },
  // 2026-07-15 修 Bug 2: 历史消息恢复时传历史 timestamp, 不传 = 用"现在" (新消息默认值, 防破坏 LLM 流式事件链).
  timestamp?: string | number | Date
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

  // 2026-07-06: 非流式模式 — AI 完整响应含 <think>...</think> + 实际回复 + <final gen>
  //   统一清洗: 去 think 块 (LLM 思考过程不渲染), 取 <final gen> 之前内容作为实际回复
  let cleanContent = content;
  if (type === 'ai') {
    cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>/g, '');
    const finalGenIdx = cleanContent.indexOf('<final gen>');
    if (finalGenIdx >= 0) {
      cleanContent = cleanContent.substring(0, finalGenIdx).trim();
    }
  }

  // 2026-07-01 (v0.2.6 前后端分离): 改用 chat-segmenter 纯函数切 LLM 输出.
  //   之前 8 行正则漏 minimax <invoke> / Qwen function_calls / <tool_call> / {tool:..}.
  //   单一来源: src/agents/chat-segmenter.ts (server + client 共享).
  //   knownToolNames: 用 ctx 传入的注册表, fallback 空集 (不识别 tool_call 就 strip 不显示).
  const knownToolNames = (ctx && ctx.knownToolNames) || new Set<string>();
  const segments = segmentChatReply(cleanContent, { knownToolNames });

  // 没有可显示的 segment, 不上屏
  if (segments.length === 0) {
    return;
  }

  // 渲染各 segment (按 type 走不同容器)
  let thinkContainer: HTMLElement | null = null;
  let renderedAny = false;
  for (const seg of segments) {
    if (seg.type === 'think' && seg.content) {
      thinkContainer = buildThinkContainer(seg.content);
      div.appendChild(thinkContainer);
      renderedAny = true;
    } else if (seg.type === 'env_details' && seg.content) {
      div.appendChild(buildEnvContainer(seg.content));
      renderedAny = true;
    } else if (seg.type === 'text' && seg.content) {
      if (thinkContainer) div.appendChild(thinkContainer);
      thinkContainer = null;
      div.appendChild(buildBubble(seg.content, type));
      renderedAny = true;
    } else if (seg.type === 'final' && seg.content) {
      if (thinkContainer) div.appendChild(thinkContainer);
      thinkContainer = null;
      // final 段渲染为特殊气泡 (顶部有标记, 表示 LLM 显式终止)
      const finalEl = buildBubble(seg.content, type);
      finalEl.classList.add('bubble-final');
      div.appendChild(finalEl);
      renderedAny = true;
    } else if (seg.type === 'tool_call' && seg.tool) {
      // tool_call segment 不渲染文字 — 走 step-timeline (步骤状态条)
      //   这里只记录到 ctx 让外层在 addMessage 后挂到 timeline
      if (ctx && ctx.toolCallCallback) {
        ctx.toolCallCallback(seg.tool, div);
      }
      renderedAny = true; // 即使没文字, tool_call 也算"有意义"
    }
  }
  if (!renderedAny) {
    return; // 没有渲染任何东西, 不上屏
  }

  // 纯文本用于复制按钮 — 现在从 segments 拼, 不再依赖 cleanContent 变量
  const rawContent = segments
    .filter(s => s.type === 'text' || s.type === 'final')
    .map(s => s.content || '')
    .join('\n');

  // 时间 — 2026-07-15 修 Bug 2: 历史消息恢复时用历史 timestamp, 不传则用"现在"
  let timeLabel = '';
  try {
    if (timestamp !== undefined && timestamp !== null) {
      const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
      if (!isNaN(d.getTime())) {
        timeLabel = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
    }
  } catch { /* fallback below */ }
  if (!timeLabel) timeLabel = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = timeLabel;

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
    // 2026-07-20 Bug 1: AI 消息创建后回放此前缓冲的 step 事件
    flushStepEventBuffer(currentChannelId, ctx);
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
/**
 * 2026-08-02: marked v15 表格解析严格 — 表格块后若无空行, 后续段落文字会被
 *   吞进表格最后一行单元格 (LLM 常输出 "| 1 | x |\n结论文字" 不带空行).
 *   渲染前给表格块 (含表头分隔行) 后补空行, 把表格与后续文字切开.
 *   只处理行首是 | 或 |- 的连续块, 不破坏 code block 内的表格.
 */
function normalizeMarkdownTables(text: string): string {
  if (!text || !text.includes('|')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inTable = false;
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // code fence 状态跟踪 (``` 开头/结束)
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      out.push(line);
      inTable = false;
      continue;
    }
    if (inCode) { out.push(line); continue; }
    // 表格行: 以 | 开头, 或分隔行 (| --- |)
    if (trimmed.startsWith('|') || /^\|?\s*:?-{2,}\s*(\|\s*:?-{2,}\s*)*\|?\s*$/.test(trimmed)) {
      out.push(line);
      inTable = true;
    } else {
      // 表格结束: 下一行非表格行 → 在表格块后插入空行 (若上一行不是空行)
      if (inTable && out.length > 0 && out[out.length - 1].trim() !== '') {
        out.push('');
      }
      inTable = false;
      out.push(line);
    }
  }
  return out.join('\n');
}

function buildBubble(text: string, type: MessageType): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = `bubble bubble-${type}`;
  // 安全降级: CDN 加载失败时 marked 是 escape 版本, 这里不需要二次 escape
  // window.marked 在 ts 类型上不一定有, 用 any 兜底
  const marked = (window as any).marked;
  const normalized = marked ? normalizeMarkdownTables(text) : text;
  bubble.innerHTML = marked ? marked.parse(normalized) : escapeHtml(text);
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
    // 2026-07-21: 流式元素创建后立即回放缓冲的 step 事件, 让用户尽早看到 tool call 状态
    //   必须先 appendChild 让元素 isConnected=true, 否则 flushStepEventBuffer → handleStepEvent
    //   会因 streamingMessageEl.isConnected===false 而丢弃缓冲中的 step.
    flushStepEventBuffer(currentChannelId, ctx);
    // B-3: 首个 token 来时切状态到 streaming (蓝徽), 提示用户 panel 在工作
    if (typeof ctx.setTimelineState === 'function') {
      ctx.setTimelineState('streaming');
    }
    scheduleScrollToBottom(container);
  }

  // 2026-07-06: pivot loop 现在用 stream: false, 每次 emit type='token' + content=reply.substring(0, 100)
  //   也就是说每个 token event 实际是"LLM 这一轮回复的前 100 字符", 不是真正的 token 增量.
  //   多次 emit 会让 streamingText 累积成 "片段1 + 片段2 + ..." 而不是最终回复.
  //   改成 "replace last segment" 语义: streamingText 始终是 LLM 最新一轮的回执的前缀.
  //   这样 finalize 出来的 ai message bubble 就是当前最完整的那一轮 (通常是最新的, pivot loop 最后一次 reply),
  //   用户看到的就是 LLM 真正的最终回答, 不是堆叠的中间产物.
  if (data.streamType === 'token') {
    // 把 streamingText 用 nodeValue 整体替换, 不累加
    if (streamingTextNode) streamingTextNode.nodeValue = delta;
    streamingText = delta;
  } else {
    // thinking 类的保持原本的 append 语义 (罕见, 留个口子)
    if (streamingTextNode) streamingTextNode.appendData(delta);
    streamingText += delta;
  }
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
  // 2. 无流式元素 → 缓冲等待 stream token 或 addMessage 后回放
  //    (2026-07-21: 不再回退到 welcome 等旧 AI 消息, 避免 step 贴错 message)
  if (!target) {
    if (currentChannelId) {
      const buf = stepEventBuffer.get(currentChannelId) || [];
      buf.push(data);
      stepEventBuffer.set(currentChannelId, buf);
    }
    return;
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

// 2026-07-20 Bug 1: 回放缓冲的 step 事件到刚创建的 AI 消息
export function flushStepEventBuffer(channelId: string | null, ctx: RendererCtx): void {
  if (!channelId) return;
  const buf = stepEventBuffer.get(channelId);
  if (!buf || buf.length === 0) return;
  stepEventBuffer.delete(channelId);
  for (const evt of buf) {
    handleStepEvent(evt, ctx);
  }
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

/**
 * 2026-08-02 fix: loadSession 渲染历史后用最后一条消息 seed 去重状态.
 *   之前 loadSession 走 save=false (不上屏去重逻辑), lastAiContent/lastUserCommand 不更新,
 *   紧接着 SSE resume 补包 (save=true) 时 lastAiContent 是空的 → 同一条 AI 消息重复渲染两次.
 */
export function seedDedupState(lastType: string | null, lastContent: string | null): void {
  if (lastType === 'user') lastUserCommand = lastContent || '';
  else if (lastType === 'ai') lastAiContent = lastContent || '';
}

export const MessageRenderer = {
  addMessage,
  handleStreamTokenEvent,
  finalizeTimelineAsMessage,
  handleStepEvent,
  flushStepEventBuffer,
  escapeHtml,
  getMessagesContainerForCurrent,
  resetRendererState,
  seedDedupState,
};

declare global {
  interface Window {
    MR?: typeof MessageRenderer;
  }
}

if (typeof window !== 'undefined') {
  window.MR = MessageRenderer;
}
