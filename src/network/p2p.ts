import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { multiaddr as createMultiaddr } from '@multiformats/multiaddr';
import { circuitRelayTransport, circuitRelayServer, RELAY_V2_HOP_CODEC } from '@libp2p/circuit-relay-v2';
import { autoNAT } from '@libp2p/autonat';
import { uPnPNAT } from '@libp2p/upnp-nat';
import * as fs from 'fs/promises';
import * as path from 'path';

const PEER_STORE_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'peer-store.json');
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * 2026-09-11: 桌面端当 circuit relay v2 服务器 (relay v2 server)。
 *
 * 为什么必须: 手机在 iOS WKWebView 里**不能 listen 任何公网/局域网地址** ——
 * 它唯一能被别人拨入的途径就是「向中继预约 → 拿到 <relay>/p2p-circuit/p2p/<手机> 地址」。
 * 没有中继时手机 getMultiaddrs() 为空 (只能拨出, 不能被拨)。
 *
 * 协议常量 = identify 会广播的服务协议 (手机端 topology 看到它就发起预约)。
 */
export const CIRCUIT_RELAY_HOP_PROTOCOL = RELAY_V2_HOP_CODEC;
/** 允许的中继预约数 (每个预约 = 一台像手机这样的「不能 listen 的对等端」) */
const RELAY_MAX_RESERVATIONS = 64;
/**
 * 预约有效期 (单位 **毫秒**; @libp2p/circuit-relay-v2 v4 的 reservations.reservationTtl
 * 是 number, 不是 '2H' 这种字符串 —— 传字符串会让 new Date(Date.now()+NaN) 直接失效)。
 */
const RELAY_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
/** 过期预约清理间隔 (默认 5 分钟) */
const RELAY_RESERVATION_CLEAR_INTERVAL_MS = 5 * 60 * 1000;

export interface PersistentPeerInfo {
  peerId: string;
  multiaddrs: string[];
  did?: string;
  lastConnected?: number;
  lastAttempt?: number;
  name?: string;
  relayAddr?: string;
  canRelay?: boolean;
}

export interface P2PNode {
  peerId: string;
  multiaddrs: string[];
  relayAddr?: string;
  /** 2026-09-11: 桌面中继服务状态 (手机靠它判断能不能预约 /p2p-circuit) */
  relay?: RelayServiceInfo;
}

/** relay v2 服务器 (中继) 的运行时状态 */
export interface RelayServiceInfo {
  /** 中继服务真的起来了 (identify 在广播 hop 协议) */
  enabled: boolean;
  /** '/libp2p/circuit/relay/0.2.0/hop' */
  protocol: string;
  /** 当前被预约的数量 (每台手机占 1) */
  reservations: number;
  maxReservations: number;
}

export interface NatStatus {
  reachable: boolean;
  type?: 'public' | 'cone' | 'symmetric' | 'unknown';
  externalAddr?: string;
}

export interface PendingRequest {
  id: string;
  type: string;
  payload: string;
  timestamp: number;
  resolve: (response: Uint8Array) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PendingRequestInfo {
  requestId: string;
  type: string;
  payload: string;
  fromPeerId: string;
  did?: string;
  timestamp: number;
}

export interface ResponseHandler {
  (payload: string, from: string, did?: string): void;
}

export class RequestResponseManager {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private responseHandlers: Map<string, ResponseHandler> = new Map();
  private requestTimeoutMs: number = 30000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, request] of this.pendingRequests) {
        if (now - request.timestamp > this.requestTimeoutMs) {
          clearTimeout(request.timeout);
          request.reject(new Error(`Request ${id} timed out`));
          this.pendingRequests.delete(id);
        }
      }
    }, 10000);
  }

  async sendRequest(
    peerId: string,
    type: string,
    payload: string,
    sendFn: (peerId: string, data: Uint8Array) => Promise<void>,
    onResponse?: (peerId: string) => Promise<Uint8Array | null>
  ): Promise<Uint8Array | null> {
    const requestId = crypto.randomUUID();
    const data = new TextEncoder().encode(
      `REQ:${requestId}|${type}:${payload}`
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        id: requestId,
        type,
        payload,
        timestamp: Date.now(),
        resolve,
        reject,
        timeout
      });

      sendFn(peerId, data).catch(err => {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(err);
      });
    });
  }

  handleResponse(requestId: string, responseData: Uint8Array): void {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timeout);
      request.resolve(responseData);
      this.pendingRequests.delete(requestId);
    }
  }

  registerResponseHandler(type: string, handler: ResponseHandler): void {
    this.responseHandlers.set(type, handler);
  }

  getResponseHandler(type: string): ResponseHandler | undefined {
    return this.responseHandlers.get(type);
  }

  setRequestTimeout(ms: number): void {
    this.requestTimeoutMs = ms;
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Shutting down'));
    }
    this.pendingRequests.clear();
  }
}

export class P2PNetwork {
  private node: any = null;
  private messageHandlers: Map<string, (msg: Uint8Array, from: string, did?: string) => void> = new Map();
  private offlineMessages: Map<string, Uint8Array[]> = new Map();
  private persistentPeers: Map<string, PersistentPeerInfo> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private ownDid: string | null = null;
  private peerStorePath: string;
  private natStatus: NatStatus = { reachable: false };
  private relayServerAddr: string | null = null;
  /** 2026-09-11: 中继服务是否真的起来 (identify 在广播 hop 协议) */
  private relayServerEnabled = false;
  private relayMaxReservations = RELAY_MAX_RESERVATIONS;
  private requestResponseManager: RequestResponseManager = new RequestResponseManager();
  private pendingResponseHandlers: Map<string, (response: string, from: string) => void> = new Map();
  private pendingRequests: Map<string, PendingRequestInfo> = new Map();
  private requestTimeoutMs: number = 30000;

  // 新增: 消息存储层
  private messageStore: any = null;
  private offlineDeliveryInterval: ReturnType<typeof setInterval> | null = null;

  // 2026-08-15: 手机 data.* 同步提供者 (如 LLM 配置)。由上层 (server/测试) 注入, 网络层不 import config-store.
  private dataProviders: Map<string, (payload: string, fromPeerId: string, did?: string) => Promise<string | null>> = new Map();

  constructor() {
    this.peerStorePath = PEER_STORE_PATH;
  }

  /**
   * 注册 data.* 协议提供者 (手机同步请求 → 返回 payload 字符串, null = 不响应)。
   * 例: registerDataProvider('data.llm-config', async () => JSON.stringify(llmConfig))
   */
  registerDataProvider(type: string, fn: (payload: string, fromPeerId: string, did?: string) => Promise<string | null>): void {
    this.dataProviders.set(type, fn);
  }

  async enablePersistence(): Promise<void> {
    try {
      const { JsonMessageStore } = await import('./storage/adapters/json-adapter.js');
      const baseDir = path.join(process.env.HOME || '/tmp', '.bolloon', 'messages-libp2p');
      this.messageStore = new JsonMessageStore({ baseDir });
      await this.messageStore.initialize();
      this.startOfflineDeliveryLoop();
      console.log('[P2P] Persistence enabled');
    } catch (e) {
      console.warn('[P2P] Failed to enable persistence:', e);
    }
  }

  private startOfflineDeliveryLoop(): void {
    if (!this.messageStore) return;

    this.offlineDeliveryInterval = setInterval(async () => {
      for (const peerId of this.getPeers()) {
        const offlineMsgs = await this.messageStore.getOfflineMessages(peerId);

        for (const msg of offlineMsgs) {
          if (msg.retryCount >= 10) {
            await this.messageStore.dequeueOfflineMessage(msg.id);
            continue;
          }

          try {
            const payload = Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0));
            const success = await this.sendMessageDirect(peerId, msg.type, payload);

            if (success) {
              await this.messageStore.dequeueOfflineMessage(msg.id);
              console.log(`[P2P] Delivered offline message to ${peerId.substring(0, 12)}...`);
            }
          } catch {
            await this.messageStore.incrementOfflineRetry(msg.id);
          }
        }
      }
    }, 5000);
  }

  private async sendMessageDirect(peerId: string, type: string, payload: string | Uint8Array): Promise<boolean> {
    if (!this.node) return false;

    try {
      const data = typeof payload === 'string'
        ? new TextEncoder().encode(`${type}:${payload}`)
        : payload;

      const ma = createMultiaddr(`/p2p/${peerId}`);
      // libp2p 3.x: dialProtocol 返回 Stream 本体 (非 {stream})
      const stream = await this.node.dialProtocol(ma, '/agent/message');
      stream.send(data);
      return true;
    } catch {
      return false;
    }
  }

  async createNode(config?: {
    bootstrapPeers?: string[];
    ownDid?: string;
    enableRelay?: boolean;
    enableRelayServer?: boolean;
    enableAutoNat?: boolean;
    enableUPnP?: boolean;
    relayPeers?: string[];
  }): Promise<P2PNode> {
    this.ownDid = config?.ownDid || null;
    const enableRelay = config?.enableRelay ?? true;
    const enableRelayServer = config?.enableRelayServer ?? true;
    const enableAutoNat = config?.enableAutoNat ?? true;
    const enableUPnP = config?.enableUPnP ?? true;

    const transports = [tcp()];
    // 2026-08-15: 加 websockets 传输 — 让手机端 (WebView) 能通过 wss/ws 连桌面节点
    try {
      transports.push(webSockets() as any);
    } catch (e) {
      console.warn(`[P2P] Failed to add websockets transport:`, e);
    }
    const services: any = {};

    // 2026-08-15: relay 传输需要 identify 服务 (libp2p 3.x 依赖检查)
    try {
      const { identify } = await import('@libp2p/identify');
      services.identify = identify();
    } catch (e) {
      console.warn(`[P2P] Failed to setup identify:`, e);
    }

    // 2026-08-15: 加密 + 多路复用 (与手机端 websockets 节点互通必需)
    let connectionEncrypters: any[] = [];
    let streamMuxers: any[] = [];
    try {
      const { noise } = await import('@chainsafe/libp2p-noise');
      connectionEncrypters = [noise()];
    } catch (e) {
      console.warn(`[P2P] Failed to setup noise encrypter:`, e);
    }
    try {
      const { yamux } = await import('@chainsafe/libp2p-yamux');
      streamMuxers = [yamux()];
    } catch (e) {
      console.warn(`[P2P] Failed to setup yamux muxer:`, e);
    }

    if (enableRelay) {
      try {
        const relayTransport = circuitRelayTransport();
        transports.push(relayTransport as any);
      } catch (e) {
        console.warn(`[P2P] Failed to add circuit relay transport:`, e);
      }
    }

    // 2026-09-11: 中继服务器 (relay v2 server) —— 手机(WebView)唯一的入站途径。
    // 注意: relay v2 服务器必须 **不是** relayed 连接上的对端才有意义, 且需要 identify 广播 hop 协议。
    this.relayMaxReservations = RELAY_MAX_RESERVATIONS;
    if (enableRelayServer) {
      try {
        services.circuitRelay = circuitRelayServer({
          reservations: {
            maxReservations: RELAY_MAX_RESERVATIONS,
            reservationTtl: RELAY_RESERVATION_TTL_MS,
            reservationClearInterval: RELAY_RESERVATION_CLEAR_INTERVAL_MS,
            // 不套用默认 data/duration 上限 (默认仅 128KB / 2min) —— 那会把手机的
            // bitswap/大消息一次性掐断; 个人自建中继不需要这层限流。
            applyDefaultLimit: false,
          },
          hopTimeout: 30_000,
          maxInboundHopStreams: 64,
          maxOutboundHopStreams: 64,
          maxOutboundStopStreams: 128,
        });
        console.log(
          `[P2P] Circuit relay server: maxReservations=${RELAY_MAX_RESERVATIONS} ` +
            `reservationTtl=${RELAY_RESERVATION_TTL_MS}ms applyDefaultLimit=false protocol=${RELAY_V2_HOP_CODEC}`
        );
      } catch (e) {
        console.warn(`[P2P] Failed to setup circuit relay server:`, e);
      }
    }

    if (enableAutoNat) {
      try {
        services.autonat = autoNAT();
      } catch (e) {
        console.warn(`[P2P] Failed to setup AutoNAT:`, e);
      }
    }

    if (enableUPnP) {
      try {
        services.upnpNAT = uPnPNAT();
      } catch (e) {
        console.warn(`[P2P] Failed to setup UPnP:`, e);
      }
    }

    this.node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
      },
      transports,
      connectionEncrypters,
      streamMuxers,
      services
    });

    this.node.addEventListener('peer-relay-registry', (evt: any) => {
      if (evt.detail?.relayAddr) {
        this.relayServerAddr = evt.detail.relayAddr;
        console.log(`[P2P] Relay address available: ${this.relayServerAddr}`);
      }
    });

    // 中继事件日志: 谁预约上了 / 预约过期 —— 手机连不上时一眼看出问题在哪
    try {
      const relaySvc = this.getRelayService();
      relaySvc?.addEventListener?.('relay:reservation', (evt: any) => {
        console.log(`[P2P] Relay reservation taken by ${evt?.detail?.addr?.toString?.() ?? 'unknown'}`);
      });
      relaySvc?.addEventListener?.('relay:advert:error', (evt: any) => {
        console.warn(`[P2P] Relay advert error: ${evt?.detail?.message ?? evt?.detail}`);
      });
    } catch (e) {
      console.warn(`[P2P] Failed to attach relay event listeners:`, e);
    }

    await this.node.start();

    // ★ 复验: 中继服务真的起来了吗 —— 唯一判据是 identify 会广播的协议表里有 hop 协议
    this.verifyRelayService(enableRelayServer);

    const peerId = this.node.peerId.toString();
    const multiaddrs = this.node.getMultiaddrs().map((addr: any) => addr.toString());

    if (config?.relayPeers && config.relayPeers.length > 0) {
      for (const relayAddr of config.relayPeers) {
        try {
          const ma = createMultiaddr(relayAddr);
          await this.node.dial(ma);
          console.log(`[P2P] Connected to relay peer: ${relayAddr}`);
        } catch (e) {
          console.warn(`[P2P] Failed to connect to relay peer ${relayAddr}:`, e);
        }
      }
    }

    await this.loadPersistentPeers();

    if (config?.bootstrapPeers) {
      await this.connectToBootstrapPeers(config.bootstrapPeers);
    }

    await this.reconnectPersistentPeers();

    this.checkNatStatus();

    this.setupMessageHandler();

    return {
      peerId,
      multiaddrs,
      relayAddr: this.relayServerAddr || undefined,
      relay: this.getRelayServiceInfo(),
    };
  }

  /** 中继服务实例 (libp2p 的 services 是普通对象, key = createNode 里 services.circuitRelay) */
  private getRelayService(): any {
    const s = (this.node as any)?.services;
    if (!s) return null;
    return s.circuitRelay ?? s['circuit-relay'] ?? s['circuitRelayServer'] ?? null;
  }

  /**
   * 复验中继服务: 只认「identify 在广播的协议表里有 hop 协议」——
   * 手机端的 relay discovery 拓扑就是靠 identify 里的这个协议发现中继并预约的。
   * 不在 → 中继对手机**不可用**, 必须出声 (别静默假装成功)。
   */
  private verifyRelayService(requested: boolean): void {
    let protocols: string[] = [];
    try {
      protocols = this.node?.getProtocols?.() ?? [];
    } catch { /* 忽略 */ }
    const hasHop = protocols.includes(RELAY_V2_HOP_CODEC);
    const svc = this.getRelayService();
    this.relayServerEnabled = !!svc && hasHop;
    if (this.relayServerEnabled) {
      console.log(
        `[P2P] Circuit relay server ACTIVE — identify 广播 ${RELAY_V2_HOP_CODEC} ` +
          `(services.circuitRelay=${!!svc}, protocols=${protocols.length}) → 手机可向本节点预约 /p2p-circuit`
      );
    } else if (requested) {
      console.warn(
        `[P2P] Circuit relay server NOT active — hop 协议未注册 (services.circuitRelay=${!!svc}, ` +
          `hasHop=${hasHop}) → 手机将拿不到 /p2p-circuit 地址`
      );
    }
  }

  /** 中继服务运行时状态 (供 /api/p2p/mobile-connect 与诊断用) */
  getRelayServiceInfo(): RelayServiceInfo {
    const svc = this.getRelayService();
    let protocols: string[] = [];
    try {
      protocols = this.node?.getProtocols?.() ?? [];
    } catch { /* 忽略 */ }
    const hasHop = protocols.includes(RELAY_V2_HOP_CODEC);
    let reservations = 0;
    try {
      reservations = svc?.reservations?.size ?? 0;
    } catch { reservations = 0; }
    return {
      enabled: !!svc && hasHop,
      protocol: RELAY_V2_HOP_CODEC,
      reservations,
      maxReservations: this.relayMaxReservations,
    };
  }

  /**
   * 手机端(WebView)连桌面用的 ws 多地址 —— 手机不能 listen, 只能主动拨入,
   * 所以必须把桌面的 /ws 地址给手机 (WebSocket 传输, 见 start() 的 listen)。
   *
   * 注意 (2026-09-11 修): 不能再用 `endsWith('/ws')` —— libp2p 的
   * `getMultiaddrs()` 会在末尾追加 `/p2p/<PeerId>`, 实际形态是
   * `/ip4/192.168.1.5/tcp/8765/ws/p2p/12D3Koo…`, 用 endsWith 永远筛出空数组
   * (→ /api/p2p/mobile-connect 返回空 wsAddrs → 手机拿不到任何可拨地址)。
   * 正确做法: 看 multiaddr 组件里有没有 ws/wss 段。
   */
  getWsMultiaddrs(): string[] {
    if (!this.node) return [];
    try {
      return this.node
        .getMultiaddrs()
        .map((a: any) => a.toString())
        .filter((a: string) => {
          const parts = a.split('/');
          return parts.includes('ws') || parts.includes('wss');
        });
    } catch {
      return [];
    }
  }

  /** 桌面 P2P 节点 ID (手机端识别对端) */
  getNodePeerId(): string {
    try { return this.node ? this.node.peerId.toString() : ''; } catch { return ''; }
  }

  /**
   * 2026-09-11: 手机可用来「预约中继」的 ws 地址 —— 就是 /ws listen 地址, 但**保证带
   * `/p2p/<桌面PeerId>`** (circuit-relay 预约必须知道中继的 PeerID, 否则手机没法
   * listen `<relay>/p2p-circuit`)。
   */
  getRelayAddrs(): string[] {
    const peerId = this.getNodePeerId();
    if (!peerId) return this.getWsMultiaddrs();
    return this.getWsMultiaddrs().map((a) => (a.includes('/p2p/') ? a : `${a}/p2p/${peerId}`));
  }

  private async checkNatStatus(): Promise<void> {
    if (!this.node) return;

    try {
      const connections = this.node.getConnections();
      if (connections.length > 0) {
        for (const conn of connections) {
          const addr = conn.remoteAddr?.toString();
          if (addr && addr.includes('127.0.0.1')) continue;
          this.natStatus = {
            reachable: true,
            type: 'unknown',
            externalAddr: addr
          };
          console.log(`[P2P] NAT status: reachable, external address: ${addr}`);
          break;
        }
      }
    } catch (e) {
      console.warn(`[P2P] NAT status check failed:`, e);
    }
  }

  getNatStatus(): NatStatus {
    return this.natStatus;
  }

  getRelayAddress(): string | null {
    return this.relayServerAddr;
  }

  async createRelayReservation(): Promise<string | null> {
    if (!this.node) return null;

    try {
      const relayService = this.node.services.get('circuit-relay');
      if (!relayService) {
        console.log(`[P2P] Circuit relay service not available`);
        return null;
      }

      const reservation = await relayService.reserve();
      if (reservation) {
        this.relayServerAddr = `/p2p/${this.node.peerId.toString()}/p2p-circuit`;
        console.log(`[P2P] Created relay reservation: ${this.relayServerAddr}`);
        return this.relayServerAddr;
      }
    } catch (e) {
      console.warn(`[P2P] Failed to create relay reservation:`, e);
    }
    return null;
  }

  async dialViaRelay(relayAddr: string, targetPeerId: string): Promise<boolean> {
    if (!this.node) return false;

    try {
      const ma = createMultiaddr(`${relayAddr}/p2p/${targetPeerId}`);
      await this.node.dial(ma);
      console.log(`[P2P] Dialed ${targetPeerId} via relay ${relayAddr}`);
      return true;
    } catch (e) {
      console.warn(`[P2P] Failed to dial via relay:`, e);
      return false;
    }
  }

  private async loadPersistentPeers(): Promise<void> {
    try {
      const data = await fs.readFile(this.peerStorePath, 'utf-8');
      const peers: PersistentPeerInfo[] = JSON.parse(data);
      for (const peer of peers) {
        this.persistentPeers.set(peer.peerId, peer);
      }
      console.log(`[P2P] Loaded ${peers.length} persistent peers`);
    } catch {
      console.log(`[P2P] No existing peer store found, starting fresh`);
    }
  }

  private async savePersistentPeers(): Promise<void> {
    try {
      const dir = path.dirname(this.peerStorePath);
      await fs.mkdir(dir, { recursive: true });
      const peers = Array.from(this.persistentPeers.values());
      await fs.writeFile(this.peerStorePath, JSON.stringify(peers, null, 2));
    } catch (e) {
      console.warn(`[P2P] Failed to save peer store:`, e);
    }
  }

  addPersistentPeer(peerInfo: PersistentPeerInfo): void {
    peerInfo.lastConnected = Date.now();
    this.persistentPeers.set(peerInfo.peerId, peerInfo);
    this.savePersistentPeers();
  }

  removePersistentPeer(peerId: string): void {
    this.persistentPeers.delete(peerId);
    this.savePersistentPeers();
  }

  getPersistentPeers(): PersistentPeerInfo[] {
    return Array.from(this.persistentPeers.values());
  }

  private async reconnectPersistentPeers(): Promise<void> {
    const now = Date.now();
    for (const [peerId, peerInfo] of this.persistentPeers) {
      if (peerInfo.lastAttempt && now - peerInfo.lastAttempt < RECONNECT_DELAY_MS) {
        continue;
      }
      if (peerInfo.multiaddrs && peerInfo.multiaddrs.length > 0) {
        await this.attemptReconnect(peerId, peerInfo);
      }
    }
  }

  private async attemptReconnect(peerId: string, peerInfo: PersistentPeerInfo, attempt = 0): Promise<void> {
    if (!this.node) return;

    try {
      const hasConn = this.node.getConnections?.(peerInfo.peerId);
      if (hasConn && hasConn.length > 0) {
        console.log(`[P2P] Already connected to ${peerId}`);
        await this.deliverOfflineMessages(peerId);
        return;
      }
    } catch {}

    console.log(`[P2P] Reconnecting to ${peerId} (attempt ${attempt + 1})...`);

    for (const addr of peerInfo.multiaddrs) {
      try {
        const ma = createMultiaddr(addr);
        await this.node.dial(ma);
        peerInfo.lastConnected = Date.now();
        peerInfo.lastAttempt = undefined;
        this.persistentPeers.set(peerId, peerInfo);
        await this.savePersistentPeers();
        console.log(`[P2P] Reconnected to ${peerId} at ${addr}`);
        await this.deliverOfflineMessages(peerId);
        return;
      } catch (e) {
        console.warn(`[P2P] Failed to reconnect to ${addr}:`, e);
      }
    }

    peerInfo.lastAttempt = Date.now();
    this.persistentPeers.set(peerId, peerInfo);

    if (attempt < MAX_RECONNECT_ATTEMPTS - 1) {
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(peerId);
        this.attemptReconnect(peerId, peerInfo, attempt + 1);
      }, RECONNECT_DELAY_MS * (attempt + 1));
      this.reconnectTimers.set(peerId, timer);
    }
  }

  private async deliverOfflineMessages(peerId: string): Promise<void> {
    const messages = this.offlineMessages.get(peerId) || [];
    this.offlineMessages.delete(peerId);

    for (const data of messages) {
      try {
        await this.sendRawMessage(peerId, data);
      } catch (e) {
        console.warn(`[P2P] Failed to deliver offline message to ${peerId}:`, e);
      }
    }

    if (messages.length > 0) {
      console.log(`[P2P] Delivered ${messages.length} offline messages to ${peerId}`);
    }
  }

  private async connectToBootstrapPeers(peers: string[]): Promise<void> {
    if (!this.node) return;

    for (const addr of peers) {
      try {
        const ma = createMultiaddr(addr);
        await this.node.dial(ma);
        console.log(`[P2P] Connected to bootstrap peer: ${addr}`);
        const peerId = (ma as any).getPeerId?.() || (ma as any).peerId;
        if (peerId) {
          this.addPersistentPeer({ peerId, multiaddrs: [addr] });
        }
      } catch (e) {
        console.warn(`[P2P] Failed to connect to bootstrap peer ${addr}:`, e);
      }
    }
  }

  private setupMessageHandler(): void {
    if (!this.node) return;

    const network = this;

    this.node.handle('/agent/message', async (stream: any, connection: any) => {
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
        }

        const data = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }

        const fromPeerId = connection.remotePeer.toString();
        const messageStr = new TextDecoder().decode(data);
        const colonIdx = messageStr.indexOf(':');
        const didMarker = 'DID:';
        let did: string | undefined;
        let type = 'message';
        let payload = '';
        let requestId: string | undefined = undefined;

        if (messageStr.startsWith(didMarker)) {
          const didEndIdx = messageStr.indexOf('|');
          if (didEndIdx > 0) {
            did = messageStr.substring(didMarker.length, didEndIdx);
            const afterDid = messageStr.substring(didEndIdx + 1);
            const payloadColonIdx = afterDid.indexOf(':');
            if (payloadColonIdx > 0) {
              type = afterDid.substring(0, payloadColonIdx);
              payload = afterDid.substring(payloadColonIdx + 1);
            } else {
              type = afterDid;
              payload = '';
            }
          } else {
            type = 'message';
            payload = messageStr.substring(didMarker.length);
          }
        } else if (messageStr.startsWith('REQ:')) {
          // Request message format: REQ:<requestId>|<optional DID>|type:payload
          const reqMatch = messageStr.match(/^REQ:([^|]+)\|(.*)$/);
          if (reqMatch) {
            requestId = reqMatch[1];
            const afterReq = reqMatch[2];
            // Check if it has DID prefix
            if (afterReq.startsWith('DID:')) {
              const didEndIdx = afterReq.indexOf('|');
              if (didEndIdx > 0) {
                did = afterReq.substring(4, didEndIdx);
                const afterDid = afterReq.substring(didEndIdx + 1);
                const payloadColonIdx = afterDid.indexOf(':');
                if (payloadColonIdx > 0) {
                  type = afterDid.substring(0, payloadColonIdx);
                  payload = afterDid.substring(payloadColonIdx + 1);
                } else {
                  type = afterDid;
                  payload = '';
                }
              }
            } else {
              const payloadColonIdx = afterReq.indexOf(':');
              if (payloadColonIdx > 0) {
                type = afterReq.substring(0, payloadColonIdx);
                payload = afterReq.substring(payloadColonIdx + 1);
              } else {
                type = afterReq;
                payload = '';
              }
            }
          } else {
            type = 'message';
            payload = messageStr.substring(4);
          }
        } else if (messageStr.startsWith('RESP:')) {
          // Response message format: RESP:<requestId>|type:payload
          const respMatch = messageStr.match(/^RESP:([^|]+)\|(.*)$/);
          if (respMatch) {
            requestId = respMatch[1];
            const afterResp = respMatch[2];
            const payloadColonIdx = afterResp.indexOf(':');
            if (payloadColonIdx > 0) {
              type = afterResp.substring(0, payloadColonIdx);
              payload = afterResp.substring(payloadColonIdx + 1);
            } else {
              type = afterResp;
              payload = '';
            }
          } else {
            type = 'response';
            payload = messageStr.substring(5);
          }
        } else {
          type = colonIdx > 0 ? messageStr.substring(0, colonIdx) : messageStr;
          payload = colonIdx > 0 ? messageStr.substring(colonIdx + 1) : '';
        }

        if (!network.persistentPeers.has(fromPeerId)) {
          network.addPersistentPeer({
            peerId: fromPeerId,
            multiaddrs: connection.remoteAddr ? [connection.remoteAddr.toString()] : [],
            did
          });
        } else {
          const existing = network.persistentPeers.get(fromPeerId)!;
          if (did && !existing.did) {
            existing.did = did;
            network.persistentPeers.set(fromPeerId, existing);
            network.savePersistentPeers();
          }
        }

        const handler = network.messageHandlers.get(type);
        if (handler) {
          handler(data, fromPeerId, did);
        } else if (type.startsWith('data.') && network.dataProviders.has(type)) {
          // 2026-08-15: data.* 提供者 (如 data.llm-config) — 由上层注册, 返回 payload 回给请求方
          try {
            const provider = network.dataProviders.get(type)!;
            const replyPayload = await provider(payload, fromPeerId, did);
            if (replyPayload != null) {
              // 回 data.llm-config.reply 语义: <type>.reply (不带 DID 前缀, 手机端解析按 type:payload 兼容)
              const replyType = type + '.reply';
              const encoded = new TextEncoder().encode(`${replyType}:${replyPayload}`);
              console.log(`[P2P] data provider ${type} → reply ${replyType} (${replyPayload.length}B) to ${fromPeerId.slice(0, 10)}`);
              await network.sendRawMessage(fromPeerId, encoded);
            }
          } catch (e) {
            console.error(`[P2P] data provider ${type} error:`, e);
          }
        } else if (type === 'RESP' && requestId) {
          // Handle response message - resolve the pending request
          const pending = network.pendingResponses.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(payload);
            network.pendingResponses.delete(requestId);
          } else {
            console.log(`[P2P] Response for unknown request ${requestId}`);
          }
        } else if (type === 'REQ' && requestId) {
          // Handle request message - store for later response
          network.storePendingRequest(requestId, { type: payload.split(':')[0] || 'request', payload, fromPeerId, did });
        } else {
          network.storeOfflineMessage(fromPeerId, data);
        }
      } catch (e) {
        console.error(`[P2P] Message handler error:`, e);
      }
    });
  }

  private async sendRawMessage(peerId: string, data: Uint8Array): Promise<void> {
    if (!this.node) throw new Error('Node not initialized');

    // libp2p 3.x: 优先复用已建立连接 (手机经 ws 连接, 不能反向 tcp dial)
    const conns = this.node.getConnections?.() || [];
    for (const c of conns) {
      if (c.remotePeer.toString() === peerId) {
        // dialProtocol 返回 Stream 本体 (非 {stream})
        const stream = await this.node.dialProtocol(c.remotePeer, '/agent/message');
        stream.send(data);
        await stream.close().catch(() => {});
        return;
      }
    }

    const ma = createMultiaddr(`/p2p/${peerId}`);
    // libp2p 3.x: dialProtocol 返回 Stream 本体 (非 {stream})
    const stream = await this.node.dialProtocol(ma, '/agent/message');
    stream.send(data);
  }

  private storeOfflineMessage(peerId: string, data: Uint8Array): void {
    const messages = this.offlineMessages.get(peerId) || [];
    messages.push(data);
    this.offlineMessages.set(peerId, messages);
    console.log(`[P2P] Stored offline message for ${peerId}, total: ${messages.length}`);
  }

  getOfflineMessages(peerId: string): Uint8Array[] {
    const messages = this.offlineMessages.get(peerId) || [];
    this.offlineMessages.delete(peerId);
    return messages;
  }

  private storePendingRequest(requestId: string, info: Omit<PendingRequestInfo, 'requestId' | 'timestamp'>): void {
    this.pendingRequests.set(requestId, {
      ...info,
      requestId,
      timestamp: Date.now()
    });
    console.log(`[P2P] Stored pending request ${requestId} from ${info.fromPeerId}`);
  }

  getPendingRequest(requestId: string): PendingRequestInfo | undefined {
    return this.pendingRequests.get(requestId);
  }

  removePendingRequest(requestId: string): void {
    this.pendingRequests.delete(requestId);
  }

  getPendingRequests(): PendingRequestInfo[] {
    return Array.from(this.pendingRequests.values());
  }

  onMessage(type: string, handler: (msg: Uint8Array, from: string, did?: string) => void): void {
    this.messageHandlers.set(type, handler);
  }

  /**
   * Send a message and wait for a response (request-response pattern)
   */
  async sendRequest(
    peerId: string,
    type: string,
    payload: string,
    timeoutMs: number = 30000
  ): Promise<string | null> {
    if (!this.node) {
      throw new Error('Node not initialized');
    }

    const requestId = crypto.randomUUID();

    let data: Uint8Array;
    if (this.ownDid) {
      data = new TextEncoder().encode(`REQ:${requestId}|DID:${this.ownDid}|${type}:${payload}`);
    } else {
      data = new TextEncoder().encode(`REQ:${requestId}|${type}:${payload}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`Request to ${peerId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Store the pending response handler
      this.pendingResponses.set(requestId, {
        resolve: (response: string) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout
      });

      this.sendRawMessage(peerId, data).catch(err => {
        clearTimeout(timeout);
        this.pendingResponses.delete(requestId);
        reject(err);
      });
    });
  }

  private pendingResponses: Map<string, {
    resolve: (response: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  /**
   * Register a handler for responses (used by the receiving side)
   */
  onResponse(type: string, handler: (payload: string, from: string, did?: string, requestId?: string) => void): void {
    // Store as pendingResponseHandlers-shaped wrapper. Extra args (did, requestId) are not
    // available in pendingResponseHandlers signature, so ignore them when invoked.
    this.pendingResponseHandlers.set(type, (responseData: string, from: string) => {
      handler(responseData, from, undefined, undefined);
    });
  }

  /**
   * Send a response back to a peer
   */
  async sendResponse(peerId: string, requestId: string, type: string, responsePayload: string): Promise<void> {
    if (!this.node) {
      throw new Error('Node not initialized');
    }

    const data = new TextEncoder().encode(`RESP:${requestId}|${type}:${responsePayload}`);

    try {
      await this.sendRawMessage(peerId, data);
    } catch (e) {
      console.warn(`[P2P] Failed to send response to ${peerId}:`, e);
      throw e;
    }
  }

  /**
   * Handle incoming request messages and route to appropriate handlers
   */
  private handleRequest(type: string, payload: string, requestId: string, fromPeerId: string, did?: string): void {
    const handler = this.messageHandlers.get(type);
    if (handler) {
      // Forward raw payload; callers register with onMessage() and adapt as needed.
      handler(new TextEncoder().encode(payload), fromPeerId, did);
    }

    // Check if there's a response handler registered
    const responseHandler = this.pendingResponseHandlers.get(type);
    if (responseHandler) {
      responseHandler(payload, fromPeerId);
    }
  }

  /**
   * Register a pending response handler for a specific message type
   */
  registerResponseHandler(type: string, handler: (response: string, from: string) => void): void {
    this.pendingResponseHandlers.set(type, handler);
  }

  async sendMessage(peerId: string, type: string, payload: string): Promise<void> {
    if (!this.node) throw new Error('Node not initialized');

    let data: Uint8Array;
    if (this.ownDid) {
      data = new TextEncoder().encode(`DID:${this.ownDid}|${type}:${payload}`);
    } else {
      data = new TextEncoder().encode(`${type}:${payload}`);
    }

    try {
      await this.sendRawMessage(peerId, data);
    } catch (e) {
      console.warn(`[P2P] Failed to send to ${peerId}, storing offline`);
      this.storeOfflineMessage(peerId, data);
      this.scheduleReconnect(peerId);

      // 如果有持久化存储，也存入离线队列
      if (this.messageStore) {
        const payloadBase64 = btoa(String.fromCharCode(...data));
        this.messageStore.enqueueOfflineMessage({
          targetNodeId: peerId,
          type,
          payload: payloadBase64,
          createdAt: Date.now(),
          transport: 'libp2p',
          retryCount: 0,
        });
      }
    }
  }

  private scheduleReconnect(peerId: string): void {
    if (this.reconnectTimers.has(peerId)) return;

    const peerInfo = this.persistentPeers.get(peerId);
    if (!peerInfo || !peerInfo.multiaddrs || peerInfo.multiaddrs.length === 0) {
      console.log(`[P2P] No stored addresses for ${peerId}, cannot reconnect`);
      return;
    }

    console.log(`[P2P] Scheduling reconnect for ${peerId} in ${RECONNECT_DELAY_MS}ms`);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      if (this.node) {
        this.attemptReconnect(peerId, peerInfo);
      }
    }, RECONNECT_DELAY_MS);
    this.reconnectTimers.set(peerId, timer);
  }

  async broadcast(type: string, payload: string): Promise<void> {
    if (!this.node) throw new Error('Node not initialized');

    const peers = this.node.getPeers();
    let data: Uint8Array;
    if (this.ownDid) {
      data = new TextEncoder().encode(`DID:${this.ownDid}|${type}:${payload}`);
    } else {
      data = new TextEncoder().encode(`${type}:${payload}`);
    }

    for (const peer of peers) {
      const peerIdStr = peer.toString();
      try {
        await this.sendRawMessage(peerIdStr, data);
      } catch (e) {
        console.warn(`[P2P] Failed to broadcast to ${peerIdStr}:`, e);
        this.scheduleReconnect(peerIdStr);
      }
    }
  }

  getPeers(): string[] {
    if (!this.node) return [];
    return this.node.getPeers().map((p: any) => p.toString());
  }

  getConnectedPeers(): { peerId: string; did?: string; name?: string }[] {
    if (!this.node) return [];
    const result: { peerId: string; did?: string; name?: string }[] = [];
    for (const peer of this.node.getPeers()) {
      const peerIdStr = peer.toString();
      const peerInfo = this.persistentPeers.get(peerIdStr);
      result.push({
        peerId: peerIdStr,
        did: peerInfo?.did,
        name: peerInfo?.name
      });
    }
    return result;
  }

  setOwnDid(did: string): void {
    this.ownDid = did;
  }

  getNode(): any {
    return this.node;
  }

  async shutdown(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    if (this.offlineDeliveryInterval) {
      clearInterval(this.offlineDeliveryInterval);
    }

    if (this.messageStore) {
      await this.messageStore.shutdown();
      this.messageStore = null;
    }

    if (this.node) {
      await this.node.stop();
    }
  }

  /**
   * 获取消息历史
   */
  async getMessageHistory(options?: {
    direction?: 'sent' | 'received';
    type?: string;
    limit?: number;
  }): Promise<any[]> {
    if (!this.messageStore) return [];
    return this.messageStore.getMessages(options);
  }

  /**
   * 获取待投递消息数量
   */
  async getPendingOfflineCount(): Promise<number> {
    if (!this.messageStore) return 0;
    return this.messageStore.getPendingOfflineCount();
  }
}

export const p2pNetwork = new P2PNetwork();