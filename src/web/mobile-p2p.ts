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
  /**
   * 2026-09-11: 中继地址 (带 /p2p/<中继PeerId>, 来自电脑端 /api/p2p/mobile-connect 的 relayAddrs)。
   * 手机不能 listen 公网地址, 向中继**预约**是它唯一能被拨入的途径 → 启动后会显式预约这些地址。
   */
  relayAddrs?: string[];
}

export interface MobileP2PState {
  connected: boolean;
  peerCount: number;
  peerIds: string[];
  nodeId?: string;
}

/**
 * 2026-09-11: relay v2 的 hop 协议 —— 中继在 identify 里广播它。
 * 客户端认证「对端是中继」就靠这个协议名 (@libp2p/circuit-relay-v2 RELAY_V2_HOP_CODEC)。
 */
export const RELAY_HOP_PROTOCOL = '/libp2p/circuit/relay/0.2.0/hop';

/** 每个中继地址的预约结果 (可观测: UI/日志能看到到底预约上没) */
export interface MobileRelayReservation {
  addr: string;
  ok: boolean;
  relay?: string;
  error?: string;
}

let node: any = null;
let state: MobileP2PState = { connected: false, peerCount: 0, peerIds: [] };
const msgHandlers: Array<(payload: string, fromPeer: string) => void> = [];
/** 中继预约结果 (最近一次) */
let relayReservationResults: MobileRelayReservation[] = [];

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
    // 已知的中继 → 直接作为「configured」listen 地址 (传输层在 start 里就会预约,
    // 不依赖 identify → relay discovery 拓扑的时机)。
    const relayListen = (cfg.relayAddrs || [])
      .map((a) => (a || '').trim().replace(/\/p2p-circuit\/?$/, ''))
      .filter((a) => /\/p2p\/[^/]+$/.test(a))
      .map((a) => `${a}/p2p-circuit`);
    node = await createLibp2p({
      // 2026-09-11: 手机唯一的「可被拨入」途径 = 向中继预约。
      // listen /p2p-circuit 会在传输层 reserveRelay() 一个待预约名额; 之后只要连上
      // 一个广播了 hop 协议的中继, 就会自动预约并拿到 <relay>/p2p-circuit/p2p/<本机>。
      // (WebView 不能 listen ip4/ip6 → 只有这一类 listen 项是有意义的。)
      addresses: { listen: ['/p2p-circuit', ...relayListen] },
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
    // 中继预约 (手机唯一的入站途径): 拨上中继还不够 —— 必须真的预约到名额,
    // 才会有 <relay>/p2p-circuit/p2p/<本机> 这个可拨入地址。
    // relayAddrs 已在 createLibp2p 的 addresses.listen 里作为 configured 中继 → start 时
    // 传输层已经预约; 这里只对「还没拿到地址」的中继再补一次运行时预约 (兜底)。
    for (const addr of cfg.relayAddrs || []) {
      if (getMobileCircuitAddrs().length > 0) break;
      const r = await reserveMobileRelay(addr);
      console.log(
        `[mobile-p2p] relay reserve ${addr} → ok=${r.ok} circuitAddrs=${r.circuitAddrs.length}` +
          (r.error ? ` err=${String(r.error).slice(0, 140)}` : '')
      );
    }
    if (getMobileCircuitAddrs().length > 0) {
      console.log(`[mobile-p2p] 可拨入地址: ${getMobileCircuitAddrs().join(' , ')}`);
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

// ─────────────────── 2026-09-11: 中继预约 (手机唯一的入站途径) ───────────────────

/** 手机只能拨 ws/wss → 可拨入地址里带 ws 段的排前面 (UI 只展示第一条) */
const wsFirstRank = (a: string): number => {
  const parts = a.split('/');
  return parts.includes('ws') || parts.includes('wss') ? 0 : 1;
};

/**
 * 本机**可拨入地址** —— getMultiaddrs() 里带 `/p2p-circuit` 的项。
 * 形如 `/ip4/192.168.1.5/tcp/8765/ws/p2p/<中继PeerId>/p2p-circuit/p2p/<本机PeerId>`。
 * 没有可用中继时返回 `[]` —— 这是**正常**的 (只代表暂时不能被别人拨入), 不是失败。
 * ws/wss 地址排在前面 (WebView 拨不了裸 tcp)。
 */
export function getMobileCircuitAddrs(): string[] {
  if (!node) return [];
  try {
    return (node.getMultiaddrs() || [])
      .map((a: any) => (typeof a?.toString === 'function' ? a.toString() : String(a)))
      .filter((a: string) => a.includes('/p2p-circuit'))
      .sort((a: string, b: string) => wsFirstRank(a) - wsFirstRank(b));
  } catch {
    return [];
  }
}

/** 已经预约上的中继 PeerId 列表 (从 /p2p-circuit 地址里解析中继那一段) */
export function getMobileRelays(): string[] {
  const out: string[] = [];
  for (const a of getMobileCircuitAddrs()) {
    const head = a.split('/p2p-circuit')[0] || '';
    const ids = head.match(/\/p2p\/([^/]+)/g) || [];
    const last = ids[ids.length - 1];
    const relay = last ? last.slice('/p2p/'.length) : '';
    if (relay && !out.includes(relay)) out.push(relay);
  }
  return out;
}

/** 最近一次各中继地址的预约结果 (UI 用来显示「预约失败: 原因」) */
export function getMobileRelayReservations(): MobileRelayReservation[] {
  return relayReservationResults.map((r) => ({ ...r }));
}

/**
 * 显式向一个中继预约 (circuit relay v2 reservation)。
 *
 * ⚠️ 血的教训 (2026-09-11, 实测): **js-libp2p 3.x 的 node 上没有 `listen()` 方法**
 * (`libp2p.d.ts` 只有 dial/start/stop/…; listen 地址只能在 createLibp2p 的
 * `addresses.listen` 里给)。所以运行时新增中继的正确 API 是
 * `node.components.transportManager.listen([ma])` —— 这正是 circuit-relay 传输
 * 自己在 `onStop` 里用的那一层 (内部但公开, interface-internal 的 TransportManager)。
 *
 * 地址必须带 `/p2p/<中继PeerId>` (预约要知道中继是谁); 不带直接报错, 不静默失败。
 * 更稳的做法是在 `startMobileP2P({ relayAddrs })` 时就把它放进 `addresses.listen`
 * (那边走的是 'configured' 预约路径, 与连接时机无关)。
 */
export async function reserveMobileRelay(relayAddr: string): Promise<{ ok: boolean; circuitAddrs: string[]; error?: string }> {
  const raw = (relayAddr || '').trim();
  if (!node) return { ok: false, circuitAddrs: [], error: 'P2P 节点未启动' };
  if (!raw) return { ok: false, circuitAddrs: [], error: '中继地址为空' };
  const base = raw.replace(/\/p2p-circuit\/?$/, '');
  if (!/\/p2p\/[^/]+$/.test(base)) {
    const err = '中继地址必须带 /p2p/<中继PeerId> (没有 PeerId 无法预约)';
    relayReservationResults.push({ addr: raw, ok: false, error: err });
    return { ok: false, circuitAddrs: [], error: err };
  }
  try {
    const listenAddr = createMultiaddr(`${base}/p2p-circuit`);
    if (typeof node.listen === 'function') {
      // 老/新版本有 node.listen 就直接用
      await node.listen(listenAddr);
    } else if (node.components?.transportManager?.listen) {
      await node.components.transportManager.listen([listenAddr]);
    } else {
      throw new Error('本版本 libp2p 既无 node.listen() 也无 components.transportManager.listen() —— 中继地址必须在 createLibp2p 的 addresses.listen 里给');
    }
    const circuitAddrs = getMobileCircuitAddrs();
    const relay = getMobileRelays().slice(-1)[0];
    relayReservationResults.push({ addr: raw, ok: circuitAddrs.length > 0, relay, error: circuitAddrs.length ? undefined : '预约返回但未拿到 /p2p-circuit 地址' });
    return { ok: circuitAddrs.length > 0, circuitAddrs };
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 240);
    relayReservationResults.push({ addr: raw, ok: false, error: err });
    console.warn('[mobile-p2p] relay reservation failed:', err);
    return { ok: false, circuitAddrs: getMobileCircuitAddrs(), error: err };
  }
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
// 2026-09-11: 带上中继可观测项 —— circuitAddrs = 本机可被拨入的地址, relays = 已预约的中继
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__mobileP2PStateSync = () => ({
    ...state,
    circuitAddrs: getMobileCircuitAddrs(),
    relays: getMobileRelays(),
    relayReservations: getMobileRelayReservations(),
  });
}