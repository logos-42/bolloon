/**
 * mobile-p2p.ts — 手机端浏览器 P2P 节点 (2026-08-15, Phase 2)
 *
 * 目标: 让手机端 (Capacitor WebView) 真正独立 P2P 入网, 不依赖桌面.
 *
 * 与桌面 p2p.ts (node libp2p + tcp) 兼容:
 *   - 浏览器只能用 WebSockets 传输 (@libp2p/websockets) — 桌面已加 /ws listen
 *   - 同一协议栈: noise + yamux + gossipsub + kad-dht
 *   - 同一消息协议: '/agent/message' 流, 格式 "DID:<did>|type:payload"
 *
 * 连接方式: 手机 ws 连桌面节点 wss 地址 (joinNetwork 时传入), 或经 relay.
 * 离线时静默降级为单机模式 (mobile-core 内置回复).
 */

import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@libp2p/gossipsub';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { ping } from '@libp2p/ping';
import { multiaddr as createMultiaddr } from '@multiformats/multiaddr';

export interface MobileP2PConfig {
  /** 桌面/中继 wss 地址列表, 如 ['/ip4/192.168.1.5/tcp/8080/ws'] */
  seedAddrs?: string[];
  /** 自己的 DID */
  ownDid?: string;
}

export interface MobileP2PState {
  connected: boolean;
  peerCount: number;
  peerIds: string[];
  nodeId?: string;
}

let node: any = null;
let state: MobileP2PState = { connected: false, peerCount: 0, peerIds: [] };
const msgHandlers: Array<(payload: string, fromPeer: string) => void> = [];

/** 持久化好友地址 (localStorage), 供 addMobilePeer 写入 + startMobileP2P 自动重连 */
let peerAddrs: string[] = [];
function loadPeerAddrs(): void {
  try { peerAddrs = JSON.parse(localStorage.getItem('bolloon_mobile_peers') || '[]'); } catch { peerAddrs = []; }
}
function savePeerAddrs(): void {
  try { localStorage.setItem('bolloon_mobile_peers', JSON.stringify(peerAddrs)); } catch {}
}
loadPeerAddrs();

/** 创建浏览器 libp2p 节点 (websockets) */
export async function startMobileP2P(cfg: MobileP2PConfig = {}): Promise<MobileP2PState> {
  if (node) return state;
  try {
    node = await createLibp2p({
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT({ clientMode: true }),
        pubsub: gossipsub({ emitSelf: false }),
      },
    });

    // 处理入站 '/agent/message' (libp2p 3.x handler 签名: (stream, connection))
    node.handle('/agent/message', async (stream: any, connection: any) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
      }
      const data = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
      const text = new TextDecoder().decode(data);
      const fromPeer = connection.remotePeer.toString();
      console.log(`[mobile-p2p] 入站消息 ${text.slice(0, 60)} from ${fromPeer.slice(0, 10)}`);
      for (const h of msgHandlers) { try { h(text, fromPeer); } catch {} }
    });

    node.addEventListener('peer:connect', () => refreshState());
    node.addEventListener('peer:disconnect', () => refreshState());

    await node.start();
    state = {
      connected: true,
      peerCount: 0,
      peerIds: [],
      nodeId: node.peerId.toString(),
    };

    // 连接种子节点 (桌面 wss / relay)
    for (const addr of cfg.seedAddrs || []) {
      try {
        await node.dial(createMultiaddr(addr));
        console.log(`[mobile-p2p] connected to ${addr}`);
      } catch (e) {
        console.warn(`[mobile-p2p] failed to dial ${addr}:`, String(e).slice(0, 100));
      }
    }
    // 连接已保存的好友地址 (上次 addMobilePeer 记录)
    for (const addr of peerAddrs) {
      try {
        await node.dial(createMultiaddr(addr));
        console.log(`[mobile-p2p] connected to saved peer ${addr}`);
      } catch (e) {
        console.warn(`[mobile-p2p] failed to dial saved ${addr}:`, String(e).slice(0, 100));
      }
    }
    refreshState();
    return state;
  } catch (e) {
    console.warn('[mobile-p2p] start failed (单机模式):', String(e).slice(0, 150));
    return { connected: false, peerCount: 0, peerIds: [] };
  }
}

function refreshState(): void {
  if (!node) return;
  try {
    const peers = node.getPeers() || [];
    state = {
      connected: node.isStarted(),
      peerCount: peers.length,
      peerIds: peers.map((p: any) => p.toString()),
      nodeId: node.peerId.toString(),
    };
  } catch {
    /* 保持上次 */
  }
}

/** 订阅入站消息 (与 mobile-core 集成) */
export function onMobileP2PMessage(fn: (payload: string, fromPeer: string) => void): void {
  msgHandlers.push(fn);
}

/** 向指定 peer 发送 /agent/message (peerIdOrAddr: peerId 或 multiaddr 字符串) */
export async function sendMobileP2PMessage(
  peerIdOrAddr: string,
  type: string,
  payload: string,
  ownDid?: string,
): Promise<boolean> {
  if (!node) return false;
  const build = () => {
    const full = ownDid
      ? `DID:${ownDid}|${type}:${payload}`
      : `${type}:${payload}`;
    return new TextEncoder().encode(full);
  };
  // 0. '*' = 广播给所有已连接 peer
  if (peerIdOrAddr === '*') {
    const conns = node.getConnections() || [];
    let sentAny = false;
    for (const c of conns) {
      try {
        const stream = await node.dialProtocol(c.remotePeer, '/agent/message');
        stream.send(build());
        await stream.close();
        sentAny = true;
      } catch { /* 单个失败跳过 */ }
    }
    return sentAny;
  }
  // 1. 若已连接, 直接复用连接 (remotePeer 是 PeerId 对象, 最稳)
  const conns = node.getConnections() || [];
  for (const c of conns) {
    const peerStr = c.remotePeer.toString();
    if (peerIdOrAddr.includes(peerStr) || peerStr.includes(peerIdOrAddr)) {
      try {
        const stream = await node.dialProtocol(c.remotePeer, '/agent/message');
        stream.send(build());
        await stream.close();
        return true;
      } catch (e) {
        console.warn('[mobile-p2p] dial on existing conn failed:', String(e).slice(0, 100));
      }
    }
  }
  // 2. 未连接 → 尝试 dial multiaddr 字符串
  try {
    const target = /^\/ip/.test(peerIdOrAddr) || /^\/dns/.test(peerIdOrAddr)
      ? createMultiaddr(peerIdOrAddr)
      : createMultiaddr(`/p2p/${peerIdOrAddr}`);
    const stream = await node.dialProtocol(target, '/agent/message');
    stream.send(build());
    await stream.close();
    return true;
  } catch (err) {
    console.warn('[mobile-p2p] send failed:', String(err).slice(0, 120));
    return false;
  }
}

/** 当前节点状态 */
export function getMobileP2PState(): MobileP2PState {
  return { ...state };
}

/** 诊断: 当前活跃连接数 (getConnections) */
export function getMobileP2PConnections(): { peer: string; addr?: string }[] {
  if (!node) return [];
  try {
    return (node.getConnections() || []).map((c: any) => ({
      peer: c.remotePeer.toString(),
      addr: c.remoteAddr?.toString?.() || '',
    }));
  } catch {
    return [];
  }
}

/** 已保存的好友地址 */
export function listMobilePeerAddrs(): string[] {
  return [...peerAddrs];
}

/**
 * 添加 P2P 好友 (按 multiaddr 地址 dial 连接)。
 * 校验 → 记录到 localStorage (startMobileP2P 会自动重连) → 若节点已启动则立即 dial。
 */
export async function addMobilePeer(addr: string): Promise<{ ok: boolean; connected?: boolean; peerId?: string; error?: string }> {
  const normalized = (addr || '').trim();
  if (!normalized) return { ok: false, error: '地址不能为空' };
  try {
    createMultiaddr(normalized);
  } catch (e) {
    return { ok: false, error: '非法 multiaddr: ' + String((e as any)?.message || e) };
  }
  if (!peerAddrs.includes(normalized)) {
    peerAddrs.push(normalized);
    savePeerAddrs();
  }
  if (!node || !node.isStarted()) {
    return { ok: true, connected: false, error: '已记录好友地址, P2P 启动后自动连接' };
  }
  try {
    await node.dial(createMultiaddr(normalized));
    refreshState();
    return { ok: true, connected: true };
  } catch (e) {
    return { ok: false, error: '连接失败: ' + String((e as any)?.message || e).slice(0, 120) };
  }
}

// 暴露同步状态读取 (mobile-core.network.status 用)
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__mobileP2PStateSync = () => ({ ...state });
}