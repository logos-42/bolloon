/**
 * session-window.ts — 显式 LRU 窗口 (Layer 0 热缓存)
 *
 * 2026-07-07 新增. 解决:
 *   - sessions/cache/<key>.json 单文件无限增长直到 50MB 拒加载
 *   - loadSession 返回 null 后前端 fallback "你好! 我是 Bolloon Agent" 用户以为历史没了
 *   - 切 channel 首屏读整文件慢
 *
 * 设计:
 *   - 独立窗口文件 <key>.window.json, 永远保持最近 N 条 (默认 30) raw messages
 *   - LRU 语义: saveSession 后同步调用 saveWindow, append 新消息、pop 最老的
 *   - loadSession fallback 链: window (秒开) → full json → summary
 *   - 窗口与 full json 用 lastUpdated 校验版本, 防重复显示
 *
 * 触发:
 *   - server.ts: saveSession 之后调 saveWindow
 *   - server.ts: loadSession 失败/超大时 fallback 到 loadWindow
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============== 类型 ==============

export interface WindowEntry {
  /** 'user' | 'ai' (类型继承 SessionMessage, 不强制) */
  type: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  /** 原始 id (可选, 还原 SessionMessage 时若缺失会生成) */
  id?: string;
}

export interface SessionWindow {
  channelId: string;
  sessionId: string;
  windowSize: number;
  lastUpdated: string;
  /** 最近 N 条 raw messages (LRU, 最新在末尾) */
  messages: WindowEntry[];
  /** window 之前还有多少条 (供 fallback 提示 "还有 X 条历史未加载") */
  totalBehind: number;
}

export interface SaveWindowOptions {
  home?: string;
  /** 窗口容量, 默认 30 */
  windowSize?: number;
}

export interface LoadWindowOptions {
  home?: string;
  /** 期望窗口大小 (跟落盘不一致时截断/补齐) */
  windowSize?: number;
}

// ============== 路径 ==============

/** 跟 server-storage.ts:loadSession 完全一致的 key 计算 */
export function getWindowKey(channelId: string, sessionId?: string): string {
  return sessionId ? `${channelId}:${sessionId}` : channelId;
}

/** ~/.bolloon/sessions/cache/<key>.window.json — 跟 session 文件同目录, 前缀区分 */
export function getWindowPath(channelId: string, sessionId: string | undefined, home?: string): string {
  const root = path.join(home || os.homedir(), '.bolloon', 'sessions', 'cache');
  const key = getWindowKey(channelId, sessionId);
  // Windows 兼容: 转义 : → __
  const safeKey = key.replace(/:/g, '__');
  return path.join(root, `${safeKey}.window.json`);
}

// ============== 写入 ==============

/**
 * 保存最近 N 条消息到窗口文件. LRU 语义.
 *
 * @param channelId   channel id
 * @param sessionId   session id (没有就用 'default')
 * @param messages    session 完整消息列表 (任意长度, 内部取尾 N 条)
 * @param opts        窗口容量配置
 */
export async function saveWindow(
  channelId: string,
  sessionId: string,
  messages: WindowEntry[],
  opts: SaveWindowOptions = {}
): Promise<{ windowPath: string; windowSize: number; totalBehind: number }> {
  const windowSize = opts.windowSize ?? 30;
  const winPath = getWindowPath(channelId, sessionId, opts.home);

  // LRU: 取尾 N 条
  const windowMessages = messages.length > windowSize
    ? messages.slice(-windowSize)
    : messages.slice();

  const win: SessionWindow = {
    channelId,
    sessionId,
    windowSize,
    lastUpdated: new Date().toISOString(),
    messages: windowMessages,
    totalBehind: Math.max(0, messages.length - windowMessages.length),
  };

  await fs.mkdir(path.dirname(winPath), { recursive: true });
  await fs.writeFile(winPath, JSON.stringify(win, null, 2), 'utf-8');

  return {
    windowPath: winPath,
    windowSize: win.windowSize,
    totalBehind: win.totalBehind,
  };
}

// ============== 读取 ==============

/**
 * 读窗口文件. 文件不存在 / 损坏 → 返回 null (调用方应 fallback 到 full session 或 summary).
 *
 * @param channelId
 * @param sessionId
 * @param opts.windowSize 期望窗口大小, 跟落盘不一致时按期望截断
 */
export async function loadWindow(
  channelId: string,
  sessionId: string,
  opts: LoadWindowOptions = {}
): Promise<SessionWindow | null> {
  const winPath = getWindowPath(channelId, sessionId, opts.home);

  let raw: string;
  try {
    raw = await fs.readFile(winPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: SessionWindow;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // 防御: 字段缺失/类型不对
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
    return null;
  }

  // 期望容量调整
  const wantSize = opts.windowSize ?? parsed.windowSize ?? 30;
  if (parsed.messages.length > wantSize) {
    const dropped = parsed.messages.length - wantSize;
    parsed = {
      ...parsed,
      windowSize: wantSize,
      messages: parsed.messages.slice(-wantSize),
      totalBehind: parsed.totalBehind + dropped,
    };
  }

  return parsed;
}

// ============== 删除 ==============

/**
 * 删窗口文件 (跟 session 文件一起删). 文件不存在不报错.
 */
export async function deleteWindow(channelId: string, sessionId: string, home?: string): Promise<void> {
  const winPath = getWindowPath(channelId, sessionId, home);
  try {
    await fs.unlink(winPath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
}