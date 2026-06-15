/**
 * step-timeline.ts — 气泡内 4 状态步骤条 (2026-06-15)
 *
 * 职责 (单一):
 *   - 给每条 AI 消息挂一个可折叠/展开的步骤条
 *   - 状态机: idle ○ / active ● / done 🟢 / error 🔴
 *   - 摘要条 + 详情区共用同一份 Step[] 数据
 *   - 流式期间在 streaming 元素内, finalize 时搬到正式 message
 *   - 折叠状态按 channel 持久化 (localStorage)
 *
 * 状态 (模块私有, 每个 message 一个实例):
 *   - steps: Step[]
 *   - currentIndex: number
 *   - expanded: boolean  (受 localStorage 影响)
 *
 * 输入 (从 message-renderer 调用):
 *   - createEmptyStepTimeline(channelId) -> HTMLElement
 *   - mountStepTimeline(messageEl, channelId)  // 已有 message 上挂 timeline
 *   - pushStepToTimeline(timelineEl, type, data)  // 订阅 step_start/done/error
 *   - migrateStepTimeline(fromEl, toEl)  // finalize 时搬家
 *
 * 输出 (DOM):
 *   - .step-timeline / .step-timeline-summary / .step-timeline-body
 *   - .step-dot (摘要条圆点) / .step-timeline-node (详情区节点)
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type StepStatus = 'idle' | 'active' | 'done' | 'error';
export interface Step {
  name: string;
  status: StepStatus;
  args?: Record<string, unknown>;
  output?: string;
  error?: string;
  /** 该 step 对应的事件 type (供调试/扩展) */
  eventType?: 'step_start' | 'step_done' | 'step_error';
}

const MAX_VISIBLE_NODES = 8;
const STORAGE_PREFIX = 'bolloon.stepTimeline.expanded.';

// ---------------------------------------------------------------------------
// 模块私有状态 (按 timeline 元素实例化)
// 用 WeakMap 避免循环引用泄漏
// ---------------------------------------------------------------------------
interface TimelineState {
  steps: Step[];
  currentIndex: number;
  expanded: boolean;
  channelId: string | null;
  showAll: boolean;  // "+N 更多" 展开
}
const stateMap = new WeakMap<HTMLElement, TimelineState>();

// ---------------------------------------------------------------------------
// 工具: 持久化
// ---------------------------------------------------------------------------
function readExpanded(channelId: string | null): boolean {
  if (!channelId) return false;
  try {
    return localStorage.getItem(STORAGE_PREFIX + channelId) === '1';
  } catch { return false; }
}
function writeExpanded(channelId: string | null, expanded: boolean): void {
  if (!channelId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + channelId, expanded ? '1' : '0');
  } catch { /* localStorage 写失败 (隐私模式), 静默 */ }
}

// ---------------------------------------------------------------------------
// 工具: 摘要条 title
// ---------------------------------------------------------------------------
function computeTitle(steps: Step[]): string {
  if (steps.length === 0) return '执行步骤';
  // 优先 active, 其次最后一个 error
  const activeIdx = steps.findIndex(s => s.status === 'active');
  if (activeIdx >= 0) return `● 执行中 · ${steps[activeIdx].name}`;
  const lastErrorIdx = (() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].status === 'error') return i;
    }
    return -1;
  })();
  if (lastErrorIdx >= 0) return `✗ 失败 · ${steps[lastErrorIdx].name}`;
  return `✓ 已完成 · ${steps.length} 步`;
}

// ---------------------------------------------------------------------------
// 核心: 渲染 (摘要条 + 详情区, 共用 steps 状态)
// ---------------------------------------------------------------------------
function render(timelineEl: HTMLElement): void {
  const state = stateMap.get(timelineEl);
  if (!state) return;
  const { steps, expanded, showAll } = state;

  const titleEl = timelineEl.querySelector('[data-current-tool]') as HTMLElement | null;
  if (titleEl) titleEl.textContent = computeTitle(steps);

  // 摘要条 dots
  const dotsEl = timelineEl.querySelector('[data-dots]') as HTMLElement | null;
  if (dotsEl) {
    // diff: 复用现有 dot, 多余 remove, 缺少 append
    const existing = Array.from(dotsEl.children) as HTMLElement[];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let dot = existing[i];
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'step-dot';
        dot.setAttribute('data-index', String(i));
        dotsEl.appendChild(dot);
      }
      dot.setAttribute('data-status', step.status);
      dot.setAttribute('title', `${step.name} · ${step.status}`);
    }
    while (dotsEl.children.length > steps.length) {
      dotsEl.removeChild(dotsEl.lastChild!);
    }
  }

  // 详情区 list
  const listEl = timelineEl.querySelector('[data-list]') as HTMLElement | null;
  if (listEl) {
    const hiddenCount = Math.max(0, steps.length - MAX_VISIBLE_NODES);
    const visibleSteps = showAll ? steps : steps.slice(-MAX_VISIBLE_NODES);
    const existing = Array.from(listEl.children) as HTMLElement[];

    let htmlIdx = 0;
    // "+N 更多" 折叠行 (仅在 showAll=false 且有 hidden 时)
    if (!showAll && hiddenCount > 0) {
      let moreBtn = existing[htmlIdx] as HTMLElement | undefined;
      if (!moreBtn || !moreBtn.classList.contains('step-timeline-more')) {
        moreBtn = document.createElement('li');
        moreBtn.className = 'step-timeline-more';
        moreBtn.setAttribute('role', 'button');
        moreBtn.textContent = `+ ${hiddenCount} 更多`;
        moreBtn.onclick = () => {
          state.showAll = true;
          render(timelineEl);
        };
        if (existing[htmlIdx] && existing[htmlIdx] !== moreBtn) {
          listEl.replaceChild(moreBtn, existing[htmlIdx]);
        } else {
          listEl.appendChild(moreBtn);
        }
      } else {
        moreBtn.textContent = `+ ${hiddenCount} 更多`;
      }
      htmlIdx++;
    }

    for (let i = 0; i < visibleSteps.length; i++) {
      const step = visibleSteps[i];
      const realIndex = showAll ? i : (steps.length - visibleSteps.length + i);
      let node = existing[htmlIdx];
      if (!node || !node.classList.contains('step-timeline-node')) {
        node = document.createElement('li');
        node.className = 'step-timeline-node';
        node.setAttribute('data-index', String(realIndex));
        const marker = document.createElement('span');
        marker.className = 'step-timeline-marker';
        const label = document.createElement('span');
        label.className = 'step-timeline-label';
        const args = document.createElement('span');
        args.className = 'step-timeline-args';
        node.appendChild(marker);
        node.appendChild(label);
        node.appendChild(args);
        if (existing[htmlIdx] && existing[htmlIdx] !== node) {
          listEl.replaceChild(node, existing[htmlIdx]);
        } else {
          listEl.appendChild(node);
        }
      } else {
        node.setAttribute('data-index', String(realIndex));
      }
      node.setAttribute('data-status', step.status);
      const label = node.querySelector('.step-timeline-label') as HTMLElement;
      if (label) label.textContent = step.name;
      const argsEl = node.querySelector('.step-timeline-args') as HTMLElement;
      if (argsEl) {
        const argStr = step.args && Object.keys(step.args).length > 0
          ? JSON.stringify(step.args).slice(0, 60)
          : '';
        argsEl.textContent = argStr;
        argsEl.style.display = argStr ? '' : 'none';
      }
      htmlIdx++;
    }

    // 清理多余 li
    while (listEl.children.length > htmlIdx) {
      listEl.removeChild(listEl.lastChild!);
    }
  }

  // 折叠态: 空状态显示占位, 有节点就保持
  if (steps.length === 0) {
    timelineEl.setAttribute('data-empty', 'true');
  } else {
    timelineEl.removeAttribute('data-empty');
  }
  // 折叠 class
  const body = timelineEl.querySelector('[data-body]') as HTMLElement | null;
  if (body) {
    if (expanded) {
      body.style.maxHeight = body.scrollHeight + 'px';
      setTimeout(() => {
        // 动画结束后清掉, 让内容自适应 (新 step 进来时能撑开)
        if (state.expanded) body.style.maxHeight = '';
      }, 300);
    } else {
      body.style.maxHeight = '0';
    }
  }
  const arrow = timelineEl.querySelector('.step-timeline-arrow') as HTMLElement | null;
  if (arrow) arrow.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0deg)';

  // 自动滚到底 (新节点进来时, 详情区跟到底)
  if (expanded && listEl) {
    listEl.scrollTop = listEl.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// 公共: 创建一个空 timeline (AI 消息创建时挂的占位)
// ---------------------------------------------------------------------------
export function createEmptyStepTimeline(channelId: string | null = null): HTMLElement {
  const root = document.createElement('div');
  root.className = 'step-timeline';
  root.setAttribute('data-step-timeline', '');
  root.setAttribute('data-empty', 'true');

  // 摘要条
  const summary = document.createElement('div');
  summary.className = 'step-timeline-summary';
  summary.setAttribute('data-summary', '');
  const titleSpan = document.createElement('span');
  titleSpan.className = 'step-timeline-title';
  const titleContent = document.createElement('span');
  titleContent.setAttribute('data-current-tool', '');
  titleContent.textContent = '执行步骤';
  titleSpan.appendChild(titleContent);
  const dots = document.createElement('div');
  dots.className = 'step-timeline-dots';
  dots.setAttribute('data-dots', '');
  const arrow = document.createElement('span');
  arrow.className = 'step-timeline-arrow';
  arrow.textContent = '▾';
  summary.appendChild(titleSpan);
  summary.appendChild(dots);
  summary.appendChild(arrow);
  summary.onclick = () => {
    const state = stateMap.get(root);
    if (!state) return;
    state.expanded = !state.expanded;
    writeExpanded(state.channelId, state.expanded);
    render(root);
  };

  // 详情区
  const body = document.createElement('div');
  body.className = 'step-timeline-body';
  body.setAttribute('data-body', '');
  const list = document.createElement('ul');
  list.className = 'step-timeline-list';
  list.setAttribute('data-list', '');
  body.appendChild(list);

  root.appendChild(summary);
  root.appendChild(body);

  // 初始折叠态
  const initialExpanded = readExpanded(channelId);
  stateMap.set(root, {
    steps: [],
    currentIndex: -1,
    expanded: initialExpanded,
    channelId: channelId || null,
    showAll: false,
  });
  render(root);
  return root;
}

// ---------------------------------------------------------------------------
// 公共: 把 timeline 挂到 message 上 (初始化或补挂)
// ---------------------------------------------------------------------------
export function mountStepTimeline(messageEl: HTMLElement, channelId: string | null): HTMLElement {
  // 已经挂过 → 复用
  const existing = messageEl.querySelector('[data-step-timeline]') as HTMLElement | null;
  if (existing) {
    const state = stateMap.get(existing);
    if (state && channelId && !state.channelId) state.channelId = channelId;
    return existing;
  }
  // 找插入点: 在 .bubble 之后, .message-actions 之前
  const bubble = messageEl.querySelector('.bubble');
  const actions = messageEl.querySelector('.message-actions');
  const timeline = createEmptyStepTimeline(channelId);
  if (actions && actions.parentNode === messageEl) {
    messageEl.insertBefore(timeline, actions);
  } else if (bubble && bubble.parentNode === messageEl) {
    bubble.parentNode.insertBefore(timeline, bubble.nextSibling);
  } else {
    messageEl.appendChild(timeline);
  }
  return timeline;
}

// ---------------------------------------------------------------------------
// 公共: 推一个 step 事件 (start/done/error)
// ---------------------------------------------------------------------------
export function pushStepToTimeline(
  timelineEl: HTMLElement,
  eventType: 'step_start' | 'step_done' | 'step_error',
  data: { tool: string; args?: Record<string, unknown>; success?: boolean; output?: string; error?: string }
): void {
  const state = stateMap.get(timelineEl);
  if (!state) return;
  const { steps } = state;

  if (eventType === 'step_start') {
    state.currentIndex = steps.length;
    steps.push({
      name: data.tool,
      status: 'active',
      args: data.args,
      eventType,
    });
  } else {
    // step_done / step_error — 找当前 active 节点关闭
    // 优先匹配 currentIndex, 其次回退到最后一个 active
    let targetIdx = state.currentIndex;
    if (targetIdx < 0 || !steps[targetIdx] || steps[targetIdx].name !== data.tool) {
      // 兜底: 找最后一个同名 active
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].name === data.tool && steps[i].status === 'active') {
          targetIdx = i;
          break;
        }
      }
    }
    if (targetIdx < 0) {
      // 没有 active 节点匹配, 当作新 error 节点
      targetIdx = steps.length;
      steps.push({ name: data.tool, status: 'error', eventType });
    }
    if (eventType === 'step_done') {
      steps[targetIdx].status = data.success === false ? 'error' : 'done';
      if (data.output) steps[targetIdx].output = data.output;
      if (data.error) steps[targetIdx].error = data.error;
    } else {
      steps[targetIdx].status = 'error';
      if (data.error) steps[targetIdx].error = data.error;
    }
    steps[targetIdx].eventType = eventType;
    state.currentIndex = -1;
  }
  render(timelineEl);
}

// ---------------------------------------------------------------------------
// 公共: finalize 时把 timeline 元素从 from 搬到 to (避免重渲)
// 接受 timelineEl 本身或 fromEl 内部的 timeline
// ---------------------------------------------------------------------------
export function migrateStepTimeline(fromEl: HTMLElement, toEl: HTMLElement): void {
  const fromTimeline = fromEl.querySelector('[data-step-timeline]') as HTMLElement | null;
  const toTimeline = toEl.querySelector('[data-step-timeline]') as HTMLElement | null;
  if (!fromTimeline) return;
  // 移除 toEl 的占位, 搬 fromEl 的过来
  if (toTimeline && toTimeline !== fromTimeline) {
    toTimeline.remove();
  }
  if (toTimeline !== fromTimeline) {
    toEl.appendChild(fromTimeline);
  }
  // 重渲一次 (channelId 注入)
  const state = stateMap.get(fromTimeline);
  if (state) {
    render(fromTimeline);
  }
}

// ---------------------------------------------------------------------------
// 公共: 拿到一个 message 内的 timeline (无则返回 null)
// ---------------------------------------------------------------------------
export function getStepTimeline(messageEl: HTMLElement | null): HTMLElement | null {
  if (!messageEl) return null;
  return messageEl.querySelector('[data-step-timeline]') as HTMLElement | null;
}
