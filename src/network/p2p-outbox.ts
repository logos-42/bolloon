/**
 * p2p-outbox.ts — 离线消息队列管理 (基于 peer-fs.ts 落盘)
 *
 * 设计目的 (2026-07-05):
 *   v3 P2PDirect 通道 sendTo 找不到 conn 就返回 false (消息扔进虚空).
 *   这个模块给所有"发往远端"的 RPC 提供 outbox 兜底:
 *     1) 发送前先 try sendToWithWait (3s 超时)
 *     2) 失败 → enqueueOutbox 到 ~/.bolloon/peers/<pk>/outbox.jsonl
 *     3) flushAllOutboxes() 周期跑 + 启动后跑, 检测到 peer 上线就批量重发
 *
 * 用法:
 *   import { sendOrQueue } from '../network/p2p-outbox.js';
 *   const r = await sendOrQueue(peerPk, 'agent.chat.send', { channelId, text }, v3P2PRef);
 *   // r: 'SENT' | 'QUEUED' | 'FAILED'
 */
import * as crypto from 'crypto';
import * as peerFs from './peer-fs.js';
import type { P2PDirect } from './p2p-direct.js';

export type SendResult = 'SENT' | 'QUEUED' | 'FAILED';

export interface SendOpts {
  /** 自定义最大重试次数 (默认 5) */
  maxRetries?: number;
  /** 强制走队列 (跳过 sendTo) — 测试用 */
  forceQueue?: boolean;
}

/**
 * 发送或入队: 优先 sendToWithWait (3s), 失败 → 写 outbox.jsonl
 */
export async function sendOrQueue(
  publicKey: string,
  op: string,
  payload: any,
  p2p: P2PDirect | null | undefined,
  opts: SendOpts = {}
): Promise<SendResult> {
  if (!publicKey) return 'FAILED';
  const rpc = JSON.stringify({ v: 3, op, payload });

  // 先尝试直发
  if (!opts.forceQueue && p2p) {
    try {
      const r = await p2p.sendToWithWait(publicKey, rpc, 15000);
      if (r === 'SENT') return 'SENT';
    } catch (err: any) {
      console.warn(`[outbox] sendToWithWait 抛错 (${publicKey.slice(0,12)}...): ${err?.message?.slice(0, 100)}`);
    }
  }

  // 直发失败 → 入队
  try {
    await peerFs.enqueueOutbox(publicKey, {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      op,
      payload,
      attempts: 0,
    });
    console.log(`[outbox] ${op} → ${publicKey.slice(0,12)}... 入队 (peer 当前不在线, 上线后自动重发)`);
    return 'QUEUED';
  } catch (err: any) {
    console.error(`[outbox] 入队失败 (${publicKey.slice(0,12)}...): ${err?.message?.slice(0, 200)}`);
    return 'FAILED';
  }
}

/**
 * 批量 flush 所有 peer 的 outbox — 对方上线后调用.
 * 返回 { totalQueued, totalSent, totalFailed }.
 */
export async function flushAllOutboxes(p2p: P2PDirect | null | undefined): Promise<{
  peers: number;
  totalQueued: number;
  totalSent: number;
  totalFailed: number;
}> {
  if (!p2p) return { peers: 0, totalQueued: 0, totalSent: 0, totalFailed: 0 };
  let peers = 0, totalQueued = 0, totalSent = 0, totalFailed = 0;
  try {
    const all = await peerFs.listPeersFromDisk();
    const myPk = p2p.getPublicKey();
    for (const peer of all) {
      if (peer.publicKey === myPk) continue;
      const outbox = await peerFs.readOutbox(peer.publicKey);
      if (outbox.length === 0) continue;
      peers++;
      totalQueued += outbox.length;
      let sent = 0;
      let failedEntries: typeof outbox = [];
      for (const entry of outbox) {
        const rpc = JSON.stringify({ v: 3, op: entry.op, payload: entry.payload });
        try {
          const r = await p2p.sendToWithWait(peer.publicKey, rpc, 15000);
          if (r === 'SENT') {
            sent++;
          } else {
            failedEntries.push({ ...entry, attempts: entry.attempts + 1, lastError: r });
          }
        } catch (err: any) {
          failedEntries.push({ ...entry, attempts: entry.attempts + 1, lastError: err?.message?.slice(0, 200) });
        }
      }
      totalSent += sent;
      totalFailed += failedEntries.length;
      // 写回未发送的 (覆盖原文件)
      if (failedEntries.length === 0) {
        await peerFs.clearOutbox(peer.publicKey);
      } else {
        // 重新写一份
        const { writeFile, mkdir } = await import('fs/promises');
        const path = await import('path');
        const file = peerFs.getPeerOutboxPath(peer.publicKey);
        await mkdir(path.dirname(file), { recursive: true });
        const lines = failedEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        await writeFile(file, lines, 'utf-8');
      }
      if (sent > 0) {
        console.log(`[outbox] flush → ${peer.publicKey.slice(0,12)}... 重发 ${sent}/${outbox.length} 条 ✓`);
      }
    }
    if (totalQueued > 0) {
      console.log(`[outbox] 累计处理: queued=${totalQueued}, sent=${totalSent}, failed=${totalFailed}`);
    }
  } catch (err: any) {
    console.warn('[outbox] flushAllOutboxes 失败:', err?.message?.slice(0, 200));
  }
  return { peers, totalQueued, totalSent, totalFailed };
}

/**
 * 给单个 peer 入队一条 — 用于明确"对方一定不在线"的场景
 */
export async function queueOnly(publicKey: string, op: string, payload: any): Promise<void> {
  await peerFs.enqueueOutbox(publicKey, {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    op,
    payload,
    attempts: 0,
  });
}

/**
 * 查 outbox 状态
 * 直接扫 ~/.bolloon/peers/ 子目录, 看每个目录里 outbox.jsonl 是否有内容 (不依赖 peer.json)
 */
export async function outboxStats(): Promise<{
  totalPeers: number;
  totalQueued: number;
  byPeer: Array<{ publicKey: string; count: number }>;
}> {
  const fsPromises = await import('fs/promises');
  const path = await import('path');
  const byPeer: Array<{ publicKey: string; count: number }> = [];
  let totalQueued = 0;
  try {
    const entries = await fsPromises.readdir(peerFs._debug.PEERS_ROOT);
    for (const e of entries) {
      const outboxFile = path.join(peerFs._debug.PEERS_ROOT, e, 'outbox.jsonl');
      try {
        const raw = await fsPromises.readFile(outboxFile, 'utf-8');
        const cnt = raw.split('\n').filter(Boolean).length;
        if (cnt > 0) {
          // 从目录名反推 publicKey (peerDirName 是 hash__prefix)
          const prefix = e.split('__').slice(1).join('__') || e;
          byPeer.push({ publicKey: prefix, count: cnt });
          totalQueued += cnt;
        }
      } catch {
        // 没 outbox.jsonl → 跳过
      }
    }
  } catch {
    // PEERS_ROOT 不存在 → 空
  }
  return { totalPeers: byPeer.length, totalQueued, byPeer };
}