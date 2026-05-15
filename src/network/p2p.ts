import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { multiaddr as createMultiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';

export interface P2PNode {
  peerId: string;
  multiaddrs: string[];
}

export class P2PNetwork {
  private node: Libp2p | null = null;
  private messageHandlers: Map<string, (msg: Uint8Array, from: string) => void> = new Map();
  private offlineMessages: Map<string, Uint8Array[]> = new Map();

  async createNode(config?: { bootstrapPeers?: string[] }): Promise<P2PNode> {
    this.node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0']
      },
      transports: [tcp()]
    });

    await this.node.start();

    const peerId = this.node.peerId.toString();
    const multiaddrs = this.node.getMultiaddrs().map(addr => addr.toString());

    if (config?.bootstrapPeers) {
      await this.connectToBootstrapPeers(config.bootstrapPeers);
    }

    this.setupMessageHandler();

    return { peerId, multiaddrs };
  }

  private async connectToBootstrapPeers(peers: string[]): Promise<void> {
    if (!this.node) return;

    for (const addr of peers) {
      try {
        const ma = createMultiaddr(addr);
        await this.node.dial(ma);
        console.log(`Connected to bootstrap peer: ${addr}`);
      } catch (e) {
        console.warn(`Failed to connect to ${addr}:`, e);
      }
    }
  }

  private setupMessageHandler(): void {
    if (!this.node) return;

    this.node.handle('/agent/message', async ({ stream, connection }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk.subarray());
      }
      const data = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      const from = connection.remotePeer.toString();
      const messageStr = new TextDecoder().decode(data);
      const [type] = messageStr.split(':');

      const handler = this.messageHandlers.get(type);
      if (handler) {
        handler(data, from);
      } else {
        this.storeOfflineMessage(from, data);
      }
    });
  }

  private storeOfflineMessage(peerId: string, data: Uint8Array): void {
    const messages = this.offlineMessages.get(peerId) || [];
    messages.push(data);
    this.offlineMessages.set(peerId, messages);
  }

  getOfflineMessages(peerId: string): Uint8Array[] {
    const messages = this.offlineMessages.get(peerId) || [];
    this.offlineMessages.delete(peerId);
    return messages;
  }

  onMessage(type: string, handler: (msg: Uint8Array, from: string) => void): void {
    this.messageHandlers.set(type, handler);
  }

  async sendMessage(peerId: string, type: string, payload: string): Promise<void> {
    if (!this.node) throw new Error('Node not initialized');

    const data = new TextEncoder().encode(`${type}:${payload}`);

    try {
      const ma = createMultiaddr(`/p2p/${peerId}`);
      const stream = await this.node.dialProtocol(ma, '/agent/message');
      await stream.sink([data]);
    } catch (e) {
      console.warn(`Failed to send to ${peerId}, storing offline`);
      this.storeOfflineMessage(peerId, data);
    }
  }

  async broadcast(type: string, payload: string): Promise<void> {
    if (!this.node) throw new Error('Node not initialized');

    const peers = this.node.getPeers();
    const data = new TextEncoder().encode(`${type}:${payload}`);

    for (const peer of peers) {
      try {
        const ma = createMultiaddr(`/p2p/${peer.toString()}`);
        const stream = await this.node.dialProtocol(ma, '/agent/message');
        await stream.sink([data]);
      } catch (e) {
        console.warn(`Failed to broadcast to ${peer}:`, e);
      }
    }
  }

  getPeers(): string[] {
    if (!this.node) return [];
    return this.node.getPeers().map(p => p.toString());
  }

  async shutdown(): Promise<void> {
    if (this.node) {
      await this.node.stop();
    }
  }
}

export const p2pNetwork = new P2PNetwork();
