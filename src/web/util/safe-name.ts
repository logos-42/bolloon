/**
 * safe-name.ts — 通用 channel / peer / agent 名兜底 (2026-07-06)
 *
 * 浏览器端 helper. 防止 name=undefined/null/'undefined'/'null' 字串时
 *   UI 渲染字面量 "undefined" / "null". 用于所有展示用户给起名字的位置.
 *
 * 用法:
 *   import { safeName, safeChannelName, safePeerName } from './safe-name.js';
 *   safeChannelName(ch.name);         // '(未命名)' 默认
 *   safeChannelName(ch.name, '...');  // 自定义 fallback
 *   safePeerName(peer.info?.name);    // 'Unknown' 默认 (英文场景)
 */
export interface SafeNameOptions {
  fallback?: string;
  /** 视为无效的字面量集合 (默认 ['undefined','null','NaN','']) */
  invalidLiterals?: string[];
}

/**
 * 通用名兜底. fallback 默认 '(未命名)'. 中文场景.
 */
export function safeChannelName(input: unknown, fallback?: string): string {
  return safeNameInternal(input, fallback ?? '(未命名)', ['undefined', 'null', 'NaN']);
}

/**
 * 英文场景兜底, 默认 'Unknown'.
 */
export function safePeerName(input: unknown, fallback?: string): string {
  return safeNameInternal(input, fallback ?? 'Unknown', ['undefined', 'null', 'NaN']);
}

/**
 * 兜底任意字段, 由 caller 指定默认 + 无效字面量集合.
 */
export function safeName(input: unknown, fallback: string, invalidLiterals: string[] = ['undefined', 'null', 'NaN']): string {
  return safeNameInternal(input, fallback, invalidLiterals);
}

function safeNameInternal(input: unknown, fallback: string, invalidLiterals: string[]): string {
  if (input === undefined || input === null) return fallback;
  if (typeof input === 'number' && Number.isNaN(input)) return fallback;
  const s = String(input).trim();
  if (!s) return fallback;
  for (const lit of invalidLiterals) {
    if (s === lit) return fallback;
  }
  return s;
}