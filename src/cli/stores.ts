// ─── 状态外置 (Hermes 学习 #2): 每域一小 store + 纯函数 action ──────────────
//   目的: 状态不再散在 InkApp 单组件 useState 里, 而是集中到可订阅的 store,
//         输入/桥接 handler 变为 over store 的纯函数, 便于单测与热置换.
//   用 useSyncExternalStore 订阅 (React 18+, 与 nanostores 同款订阅语义).
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(v: T): void;
  subscribe(cb: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (v: T) => {
      if (Object.is(v, state)) return;
      state = v;
      subs.forEach((cb) => cb());
    },
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
  };
}

/** 订阅 store, 值变化触发重渲染 (外部状态源统一入口) */
export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

// ── 域 store ────────────────────────────────────────────────────────────────

/** transcript: 消息列表 (agent/用户/系统行) — 供虚拟化/滚动/桥接读写 */
export const transcriptStore = createStore<string[]>([]);

/** ui: 状态栏文本 / thinking 动画开关 / transient 临时行 */
export interface UiState {
  status: string;
  thinking: boolean;
  transient: string | null;
}
export const uiStore = createStore<UiState>({ status: '', thinking: false, transient: null });

/**
 * panel: **固定区**内容 (启动面板等) —— 与会话区**分开**存放.
 *   2026-09-30 (leo: 「没有做切分区域, 导致顶部面板在回复的时候也被 AI 内容挤坏了」):
 *   原来面板和会话共用一个 transcript 缓冲 ⇒ 回复一来窗口一滚, 面板就被挤烂/切掉.
 *   现在面板活在独立 store, 渲染成"上半块固定区", 有自己的高度, 不随会话滚动.
 */
export const panelStore = createStore<string[]>([]);

// ── 纯函数 action (bridge 与组件都走这里) ────────────────────────────────────

export function appendMsg(line: string): void {
  const c = transcriptStore.get();
  transcriptStore.set([...c, line]);
}

export function appendPanelMsg(line: string): void {
  const c = panelStore.get();
  panelStore.set([...c, line]);
}

/** 清空固定区 (面板重打时用; 保证"只一块") */
export function clearPanelMsg(): void {
  if (panelStore.get().length) panelStore.set([]);
}

export function replaceLastMsg(line: string): void {
  const c = transcriptStore.get();
  if (c.length === 0) { transcriptStore.set([line]); return; }
  const n = c.slice();
  n[n.length - 1] = line;
  transcriptStore.set(n);
}

/** 按内容标记原地替换一条 (占位框 → 完整内容); 未命中不改 */
export function replaceMarkerMsg(marker: string, line: string): void {
  const c = transcriptStore.get();
  const i = c.indexOf(marker);
  if (i < 0) return;
  const n = c.slice();
  n[i] = line;
  transcriptStore.set(n);
}

export function setUiStatus(status: string): void {
  // 2026-09-27: **同值不通知** —— 状态栏每秒 tick 一次 (时钟/上下文), 但值没变时重渲染 = Ink 整帧重画,
  //   会把"用户正在框选复制"和"用户上滚暂停跟随"这两件事一起打断 (见 ink-app 的跟随冻结)。
  if (uiStore.get().status === status) return;
  uiStore.set({ ...uiStore.get(), status });
}
export function setUiThinking(thinking: boolean): void {
  if (uiStore.get().thinking === thinking) return;
  uiStore.set({ ...uiStore.get(), thinking });
}
export function setUiTransient(v: string | null): void {
  const next = v === undefined ? null : v;
  if (uiStore.get().transient === next) return;
  uiStore.set({ ...uiStore.get(), transient: next });
}

/** transcript 里最后一条**非空**消息 (面板/`/copy` 都要"最近一条回复") */
export function lastMsg(): string {
  const c = transcriptStore.get();
  for (let i = c.length - 1; i >= 0; i--) if (String(c[i] ?? '').trim()) return c[i];
  return '';
}

/** 整段会话文本 (`/copy all`) —— 内存里**完整**历史, 不裁剪 */
export function allMsgsText(): string {
  return transcriptStore.get().join('\n');
}
