/**
 * client-loop-status.ts — client.ts 拆出的循环状态条 UI 模块
 *
 * 包含:
 *   - LOOP_STATUS_TOOLS: 关心的 system tool 集合
 *   - loopBarState: 'loading' / 'retrying' / 'done'
 *   - renderLoopStatusBar(): 渲染状态条 (含 retry badge)
 *   - markLoopBarDone() / hideLoopStatusBar() / applyLoopBarState()
 *   - inspectLoopResult(): 点击"检查"按钮拉循环产物
 *   - openLoopInspectModal(): 弹窗展示
 *
 * 从 src/web/client.ts 抽出 (2026-07-06).
 *
 * 浏览器侧: 通过 <script type="module"> 加载, 模块主动挂到 window.LoopStatus
 * tsx 跑测试: 走 require() 同名拿
 */

const LOOP_STATUS_TOOLS = new Set(['loop', 'compactor', 'recovery', 'system']);

let loopBarState: 'loading' | 'retrying' | 'done' = 'loading';
let loopBarLastSummary: string = '';

const loopStatusBar = document.getElementById('loop-status-bar') as HTMLElement | null;
const loopStatusText = document.getElementById('loop-status-text');
const loopStatusMeta = document.getElementById('loop-status-meta');

function renderLoopStatusBar(tool: string | undefined, content: string | undefined): void {
  if (!loopStatusBar || !loopStatusText) return;
  const t = String(tool || '').toLowerCase();
  if (!LOOP_STATUS_TOOLS.has(t)) {
    console.log('[SSE] status (tool=' + t + ', ignored by UI):', content?.slice(0, 80));
    return;
  }
  const retryMatch = String(content || '').match(/自动重试(?: loop)?\s+(\d+)\/(\d+)/);
  const retryFinal = /自动重试\s+\d+\s*次后仍失败/.test(String(content || ''));

  loopStatusBar.hidden = false;
  // 2026-07-06: 静默 pivot "循环 N/M" 文字 — 只显示 spinner 动画, 不暴露计数进度
  //   LLM 自己约束结束时机, 没有 hard cap. retrying 仍保留文字 (有意义提示).
  const isPivotLoopMsg = /🔄\s*循环\s*\d+\s*\/\s*\d+/.test(String(content || ''));
  let mainText: string;
  if (isPivotLoopMsg && !retryMatch) {
    mainText = ''; // 静默 — UI 用 spinner 表达"工作中"
  } else {
    mainText = String(content || '')
      .replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]\s*/u, '')
      .replace(/^↻\s*/, '')
      .replace(/^⛔\s*/, '')
      .replace(/^⚠️\s*/, '')
      .slice(0, 200);
  }
  loopStatusText.textContent = mainText;

  if (retryMatch) {
    loopBarState = 'retrying';
    const retryEl = document.getElementById('loop-status-retry');
    if (retryEl) {
      retryEl.hidden = false;
      retryEl.textContent = `自动重试 ${retryMatch[1]}/${retryMatch[2]}`;
    }
  } else if (retryFinal) {
    loopBarState = 'done';
    const retryEl = document.getElementById('loop-status-retry');
    if (retryEl) retryEl.hidden = true;
  } else {
    if (loopBarState !== 'loading') loopBarState = 'loading';
    const retryEl = document.getElementById('loop-status-retry');
    if (retryEl) retryEl.hidden = true;
  }
  applyLoopBarState();
}

function markLoopBarDone(summary?: string): void {
  loopBarState = 'done';
  if (summary) loopBarLastSummary = summary;
  applyLoopBarState();
}

function applyLoopBarState(): void {
  if (!loopStatusBar) return;
  loopStatusBar.dataset.state = loopBarState;
  const checkBtn = document.getElementById('loop-status-check') as HTMLButtonElement | null;
  if (checkBtn) checkBtn.hidden = loopBarState !== 'done';
}

function hideLoopStatusBar(): void {
  if (!loopStatusBar) return;
  loopStatusBar.hidden = true;
  loopBarState = 'loading';
  loopBarLastSummary = '';
  const retryEl = document.getElementById('loop-status-retry');
  if (retryEl) retryEl.hidden = true;
  applyLoopBarState();
}

async function inspectLoopResult(): Promise<void> {
  const checkBtn = document.getElementById('loop-status-check') as HTMLButtonElement | null;
  if (checkBtn) {
    checkBtn.disabled = true;
    checkBtn.textContent = '⏳ 加载...';
  }
  try {
    const channelId = (window as any).currentChannelId || '';
    const r = await fetch(`/api/loop/inspect?channelId=${encodeURIComponent(channelId)}`);
    const j = await r.json().catch(() => ({}));
    openLoopInspectModal(j);
  } catch (err) {
    console.error('[inspect] error:', err);
    if (typeof (window as any).showSimpleToast === 'function') (window as any).showSimpleToast('✗ 检查失败');
  } finally {
    if (checkBtn) {
      checkBtn.disabled = false;
      checkBtn.textContent = '✓ 检查';
    }
  }
}

function openLoopInspectModal(data: { summary?: string; steps?: Array<{ name: string; status: string; durationMs?: number; output?: string }>; finalReply?: string; tokens?: { input?: number; output?: number }; error?: string }): void {
  const existing = document.getElementById('loop-inspect-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'loop-inspect-modal';
  modal.className = 'modal active';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';

  const panel = document.createElement('div');
  panel.className = 'modal-panel';
  panel.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:720px;width:90%;max-height:80vh;overflow:auto;position:relative;';

  const title = document.createElement('h3');
  title.textContent = '🔍 循环检查';
  title.style.cssText = 'margin:0 0 12px;font-size:16px;';
  panel.appendChild(title);

  const close = document.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'position:absolute;top:8px;right:12px;background:transparent;border:0;font-size:24px;cursor:pointer;color:var(--text-secondary);';
  close.onclick = () => modal.remove();
  panel.appendChild(close);

  if (data.error) {
    const e = document.createElement('div');
    e.style.cssText = 'padding:8px 12px;background:rgba(239,68,68,0.12);color:var(--error,#ef4444);border-radius:4px;margin-bottom:12px;font-size:13px;';
    e.textContent = '⚠️ ' + data.error;
    panel.appendChild(e);
  }

  if (data.summary) {
    const s = document.createElement('div');
    s.style.cssText = 'padding:8px 12px;background:var(--bg-tertiary);border-radius:4px;margin-bottom:12px;font-size:13px;';
    s.textContent = data.summary;
    panel.appendChild(s);
  }

  if (data.tokens && (data.tokens.input || data.tokens.output)) {
    const t = document.createElement('div');
    t.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:12px;';
    t.textContent = `token: input ${data.tokens.input || 0} · output ${data.tokens.output || 0}`;
    panel.appendChild(t);
  }

  if (Array.isArray(data.steps) && data.steps.length > 0) {
    const h = document.createElement('div');
    h.textContent = `步骤 (${data.steps.length})`;
    h.style.cssText = 'font-weight:600;margin-bottom:8px;';
    panel.appendChild(h);
    for (const step of data.steps) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 10px;margin-bottom:4px;background:var(--bg-secondary);border-left:3px solid var(--accent);border-radius:3px;font-size:12px;';
      const icon = step.status === 'ok' || step.status === 'completed' ? '✓' : step.status === 'error' || step.status === 'failed' ? '✗' : '○';
      const dur = step.durationMs ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : '';
      row.innerHTML = `<b>${icon} ${(window as any).escapeHtml ? (window as any).escapeHtml(step.name) : step.name}</b>${dur}`;
      if (step.output) {
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:4px 0 0;padding:6px;background:var(--bg);border-radius:3px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;';
        pre.textContent = String(step.output).slice(0, 800);
        row.appendChild(pre);
      }
      panel.appendChild(row);
    }
  }

  if (data.finalReply) {
    const h = document.createElement('div');
    h.textContent = '最终回复';
    h.style.cssText = 'font-weight:600;margin:12px 0 8px;';
    panel.appendChild(h);
    const r = document.createElement('div');
    r.style.cssText = 'padding:8px 12px;background:var(--bg-secondary);border-radius:4px;font-size:13px;white-space:pre-wrap;word-break:break-word;';
    r.textContent = data.finalReply;
    panel.appendChild(r);
  }

  if (!data.error && !data.summary && (!data.steps || data.steps.length === 0) && !data.finalReply) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);font-size:13px;';
    empty.textContent = '无循环产出 (可能已 abort, 或没产生 step)';
    panel.appendChild(empty);
  }

  modal.appendChild(panel);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

// ESM / CommonJS 双向导出
// 浏览器侧: <script type="module"> 加载, 模块主动挂到 window.LoopStatus
// tsx 跑测试: 走 require() 同名拿
const LoopStatusExports = {
  renderLoopStatusBar,
  markLoopBarDone,
  applyLoopBarState,
  hideLoopStatusBar,
  inspectLoopResult,
  openLoopInspectModal,
  get loopBarState() { return loopBarState; },
  get loopBarLastSummary() { return loopBarLastSummary; },
};

if (typeof window !== 'undefined') {
  (window as any).LoopStatus = LoopStatusExports;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LoopStatusExports;
}

export {
  renderLoopStatusBar,
  markLoopBarDone,
  applyLoopBarState,
  hideLoopStatusBar,
  inspectLoopResult,
  openLoopInspectModal,
};
