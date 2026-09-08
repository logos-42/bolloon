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

// ── 纯函数 action (bridge 与组件都走这里) ────────────────────────────────────

export function appendMsg(line: string): void {
  const c = transcriptStore.get();
  transcriptStore.set([...c, line]);
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
  uiStore.set({ ...uiStore.get(), status });
}
export function setUiThinking(thinking: boolean): void {
  uiStore.set({ ...uiStore.get(), thinking });
}
export function setUiTransient(v: string | null): void {
  uiStore.set({ ...uiStore.get(), transient: v === undefined ? null : v });
}
