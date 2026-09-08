// ─── 占用槽 / widget host (Hermes 学习 #8) ────────────────────────────────
//   在 UI 右侧保留一个 rails 槽位 (占用槽), 供外部 widget 注册渲染.
//   触点: registerWidget / unregisterWidget / refreshWidgets / listWidgets.
//   默认无 widget 时槽位不占宽 (布局不变); 有 widget 时才预留右侧列.
//   .mjs 热加载: hotReloadWidgets(dir) 监听目录, 动态 import 模块 (模块调用 registerWidget 注册).
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useSyncExternalStore } from 'react';

export interface Widget {
  name: string;
  render: () => string;
  text: string;
}

let widgets = new Map<string, Widget>();
let cache: Record<string, string> | null = null; // getSnapshot 必须缓存同引用, 否则 useSyncExternalStore 无限重渲
const subs = new Set<() => void>();

function rebuild(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, w] of widgets) out[name] = w.text;
  cache = out;
  return out;
}
function emit() { cache = null; subs.forEach((cb) => cb()); }

export function getWidgets(): Record<string, string> {
  if (!cache) rebuild();
  return cache!;
}

/** 4 触点之一: 注册 (render 在注册时立即执行一次, 得 text) */
export function registerWidget(name: string, render: () => string): void {
  widgets.set(name, { name, render, text: render() });
  emit();
}

export function unregisterWidget(name: string): void {
  if (widgets.delete(name)) emit();
}

/** 重新执行所有 widget 的 render (数据/间隔刷新) */
export function refreshWidgets(): void {
  for (const [name, w] of widgets) {
    try { w.text = w.render(); } catch { /* 单个 widget 渲染失败不致命 */ }
  }
  emit();
}

export function listWidgets(): string[] { return [...widgets.keys()]; }

/** 仅测试用: 清空所有 widget */
export function resetWidgetsForTest(): void { widgets = new Map(); emit(); }

export function subscribeWidgets(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/** React 订阅: 返回 {name: text} (槽位渲染用) */
export function useWidgets(): Record<string, string> {
  return useSyncExternalStore(subscribeWidgets, getWidgets, getWidgets);
}

/** .mjs 热加载: 监听 dir, 新增/变更的 .mjs 直接 import (模块内调 registerWidget); 失败静默 */
export function hotReloadWidgets(dir: string): NodeJS.Timeout | null {
  if (!fs.existsSync(dir)) return null;
  const loaded = new Set<string>();
  const load = (f: string) => {
    if (f.endsWith('.mjs') && !loaded.has(f)) {
      loaded.add(f);
      import(pathToFileURL(path.join(dir, f)).href).catch(() => { /* 模块加载失败静默 */ });
    }
  };
  for (const f of fs.readdirSync(dir)) load(f);
  return setInterval(() => { for (const f of fs.readdirSync(dir)) load(f); }, 3000);
}
