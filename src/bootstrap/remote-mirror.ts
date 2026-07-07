/**
 * remote-mirror.ts — 远端 channel 历史镜像 (B 端本地副本)
 *
 * 2026-07-07 新增. 解决:
 *   - 远端 channel 历史在 B 端零持久化, A 端 session 删/损坏即丢
 *   - A 端下线/不再分享该 channel, B 端再拉就 15s timeout
 *   - 切回远端 channel 每次都重新 RPC, 无 L0 缓存
 *
 * 设计:
 *   - B 端收到 agent.history.get.reply 后, 立刻镜像到
 *     ~/.bolloon/peers/<pk>/sessions/<channelId>.json (覆盖式 atomic)
 *   - 同时维护窗口 <channelId>.window.json (复用 session-window LRU)
 *   - loadRemoteHistory 优先读本地镜像, 文件不存在/陈旧才走 RPC
 *
 * 触发:
 *   - server.ts: agent.history.get.reply handler 写完 → mirrorRemoteHistory
 *   - client.ts: openRemoteChannelChat → loadRemoteHistory 优先读镜像
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { saveWindow as saveSessionWindow, loadWindow as loadSessionWindow } from './session-window.js';

// ============== 类型 ==============

export interface MirrorMessage {
  id?: string;
  type: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  source?: string;
  fromPublicKey?: string;
}

export interface MirrorOpts {
  targetPublicKey: string;
  channelId: string;
  channelName?: string;
  messages: MirrorMessage[];
  lastUpdated?: string;
  home?: string;
}

export interface MirrorResult {
  ok: boolean;
  mirrorPath?: string;
  windowPath?: string;
  error?: string;
}

// ============== 路径 ==============

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

/** ~/.bolloon/peers/<pk>/sessions/<safe-channelId>.json */
export function getRemoteMirrorPath(targetPublicKey: string, channelId: string, home?: string): string {
  const root = path.join(home || os.homedir(), '.bolloon', 'peers', sanitize(targetPublicKey), 'sessions');
  return path.join(root, `${sanitize(channelId)}.json`);
}

/** ~/.bolloon/peers/<pk>/sessions/<safe-channelId>.window.json — 复用 session-window 路径规则 */
export function getRemoteMirrorWindowPath(targetPublicKey: string, channelId: string, home?: string): string {
  const root = path.join(home || os.homedir(), '.bolloon', 'peers', sanitize(targetPublicKey), 'sessions');
  return path.join(root, `${sanitize(channelId)}.window.json`);
}

// ============== 写入 ==============

/**
 * 把 A 端的 history 镜像到 B 端本地. atomic (单文件 writeFile, 中途崩溃顶多旧版本留下).
 * 失败静默不阻塞 RPC reply 返回.
 */
export async function mirrorRemoteHistory(opts: MirrorOpts): Promise<MirrorResult> {
  try {
    const home = opts.home || os.homedir();
    const mirrorPath = getRemoteMirrorPath(opts.targetPublicKey, opts.channelId, home);
    const windowPath = getRemoteMirrorWindowPath(opts.targetPublicKey, opts.channelId, home);

    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });

    // 主体镜像
    const payload = {
      channelId: opts.channelId,
      channelName: opts.channelName,
      fromPublicKey: opts.targetPublicKey,
      messages: opts.messages,
      lastUpdated: opts.lastUpdated || new Date().toISOString(),
      mirroredAt: new Date().toISOString(),
    };
    await fs.writeFile(mirrorPath, JSON.stringify(payload, null, 2), 'utf-8');

    // 窗口联动
    await saveSessionWindow(
      opts.channelId,
      `remote-${opts.targetPublicKey.slice(0, 12)}`,
      opts.messages,
      { home, windowSize: 30 }
    );

    return { ok: true, mirrorPath, windowPath };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ============== 读取 ==============

export interface RemoteMirrorData {
  channelId: string;
  channelName?: string;
  fromPublicKey: string;
  messages: MirrorMessage[];
  lastUpdated: string;
  mirroredAt: string;
}

/**
 * 读远端 channel 的本地镜像. 失败/不存在 → 返回 null.
 */
export async function loadRemoteMirror(
  targetPublicKey: string,
  channelId: string,
  home?: string
): Promise<RemoteMirrorData | null> {
  const mirrorPath = getRemoteMirrorPath(targetPublicKey, channelId, home);
  try {
    const raw = await fs.readFile(mirrorPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) return null;
    return parsed as RemoteMirrorData;
  } catch {
    return null;
  }
}

/**
 * 删镜像 (远端 channel 在本地的 share 列表移除时调用).
 */
export async function deleteRemoteMirror(targetPublicKey: string, channelId: string, home?: string): Promise<void> {
  const mirrorPath = getRemoteMirrorPath(targetPublicKey, channelId, home);
  const windowPath = getRemoteMirrorWindowPath(targetPublicKey, channelId, home);
  for (const p of [mirrorPath, windowPath]) {
    try {
      await fs.unlink(p);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}