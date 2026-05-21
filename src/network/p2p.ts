import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { multiaddr as createMultiaddr } from '@multiformats/multiaddr';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { autoNAT } from '@libp2p/autonat';
import { uPnPNAT } from '@libp2p/upnp-nat';
import * as fs from 'fs/promises';
import * as path from 'path';

const PEER_STORE_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'peer-store.json');
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;

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
}

export interface NatStatus {
  reachable: boolean;
  type?: 'public' | 'cone' | 'symmetric' | 'unknown';
  externalAddr?: string;
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

  constructor() {
    this.peerStorePath = PEER_STORE_PATH;
  }

  async createNode(config?: {
    bootstrapPeers?: string[];
    ownDid?: string;
    enableRelay?: boolean;
    enableAutoNat?: boolean;
    enableUPnP?: boolean;
    relayPeers?: string[];
  }): Promise<P2PNode> {
    this.ownDid = config?.ownDid || null;
    const enableRelay = config?.enableRelay ?? true;
    const enableAutoNat = config?.enableAutoNat ?? true;
    const enableUPnP = config?.enableUPnP ?? true;

    const transports = [tcp()];
    const services: any = {};

    if (enableRelay) {
      try {
        const relayTransport = circuitRelayTransport();
        transports.push(relayTransport as any);
      } catch (e) {
        console.warn(`[P2P] Failed to add circuit relay transport:`, e);
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
        listen: ['/ip4/0.0.0.0/tcp/0']
      },
      transports,
      services
    });

    this.node.addEventListener('peer-relay-registry', (evt: any) => {
      if (evt.detail?.relayAddr) {
        this.relayServerAddr = evt.detail.relayAddr;
        console.log(`[P2P] Relay address available: ${this.relayServerAddr}`);
      }
    });

    await this.node.start();

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
      relayAddr: this.relayServerAddr || undefined
    };
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

    this.node.handle('/agent/message', async ({ stream, connection }: any) => {
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
        let type: string;
        let payload: string;

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

    const ma = createMultiaddr(`/p2p/${peerId}`);
    const { stream } = await this.node.dialProtocol(ma, '/agent/message');
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

  onMessage(type: string, handler: (msg: Uint8Array, from: string, did?: string) => void): void {
    this.messageHandlers.set(type, handler);
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

    if (this.node) {
      await this.node.stop();
    }
  }
}

export const p2pNetwork = new P2PNetwork();