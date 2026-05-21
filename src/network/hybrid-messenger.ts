import { irohTransport } from './iroh-transport.js';
import { p2pNetwork, type PersistentPeerInfo } from './p2p.js';

export type TransportType = 'hyperswarm' | 'iroh' | 'libp2p';
export type MessagePriority = 'urgent' | 'normal' | 'bulk';

export interface HybridMessage {
  type: string;
  payload: Uint8Array;
  from: string;
  transport?: TransportType;
}

export type HybridMessageHandler = (msg: HybridMessage) => void;

export interface TransportConfig {
  preferIrohForLarge: boolean;
  largeThresholdBytes: number;
  enableRelay: boolean;
}

const DEFAULT_CONFIG: TransportConfig = {
  preferIrohForLarge: true,
  largeThresholdBytes: 64 * 1024,
  enableRelay: true,
};

export class HybridMessenger {
  private messageHandlers: Map<string, HybridMessageHandler> = new Map();
  private wildcardHandler: HybridMessageHandler | null = null;
  private config: TransportConfig;
  private irohEnabled: boolean = true;

  constructor(config: Partial<TransportConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private selectTransport(
    type: string,
    payloadSize: number,
    priority: MessagePriority = 'normal'
  ): TransportType {
    if (this.irohEnabled && this.shouldUseIroh(type, payloadSize, priority)) {
      return 'iroh';
    }

    if (priority === 'urgent' || type === 'relay') {
      return 'libp2p';
    }

    return 'hyperswarm';
  }

  private shouldUseIroh(
    type: string,
    payloadSize: number,
    priority: MessagePriority
  ): boolean {
    const bulkTypes = ['blob', 'stream', 'file', 'large-data'];
    if (bulkTypes.includes(type) || payloadSize > this.config.largeThresholdBytes) {
      return true;
    }

    if (priority === 'bulk' && payloadSize > 1024) {
      return true;
    }

    return false;
  }

  async sendMessage(
    targetId: string,
    type: string,
    payload: string | Uint8Array,
    options: {
      priority?: MessagePriority;
      preferTransport?: TransportType;
      relayAddr?: string;
    } = {}
  ): Promise<boolean> {
    const { priority = 'normal', preferTransport, relayAddr } = options;

    const payloadBytes = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : payload;

    const transport = preferTransport || this.selectTransport(type, payloadBytes.length, priority);

    console.log(`[HybridMessenger] Sending "${type}" (${payloadBytes.length} bytes) via ${transport}`);

    switch (transport) {
      case 'iroh':
        return this.sendViaIroh(targetId, type, payloadBytes);

      case 'libp2p':
        return this.sendViaLibp2p(targetId, type, payloadBytes, relayAddr);

      case 'hyperswarm':
      default:
        return this.sendViaHyperswarm(targetId, type, payloadBytes);
    }
  }

  private async sendViaIroh(targetId: string, type: string, payload: Uint8Array): Promise<boolean> {
    try {
      return await irohTransport.sendMessage(targetId, type, payload);
    } catch (e) {
      console.warn('[HybridMessenger] iroh send failed:', e);
      return false;
    }
  }

  private async sendViaLibp2p(
    targetId: string,
    type: string,
    payload: Uint8Array,
    relayAddr?: string
  ): Promise<boolean> {
    try {
      await p2pNetwork.sendMessage(targetId, type, new TextDecoder().decode(payload));
      return true;
    } catch (e) {
      console.warn('[HybridMessenger] libp2p send failed:', e);
      return false;
    }
  }

  private async sendViaHyperswarm(targetId: string, type: string, payload: Uint8Array): Promise<boolean> {
    try {
      await p2pNetwork.sendMessage(targetId, type, new TextDecoder().decode(payload));
      return true;
    } catch (e) {
      console.warn('[HybridMessenger] Hyperswarm send failed:', e);
      return false;
    }
  }

  async broadcast(
    type: string,
    payload: string | Uint8Array,
    options: {
      priority?: MessagePriority;
      transport?: TransportType;
    } = {}
  ): Promise<void> {
    const { priority = 'normal', transport } = options;

    const payloadBytes = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : payload;

    const selectedTransport = transport || this.selectTransport(type, payloadBytes.length, priority);

    if (selectedTransport === 'iroh') {
      await irohTransport.broadcast(type, payloadBytes);
    } else {
      await p2pNetwork.broadcast(type, new TextDecoder().decode(payloadBytes));
    }
  }

  onMessage(type: string, handler: HybridMessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  onWildcard(handler: HybridMessageHandler): void {
    this.wildcardHandler = handler;
  }

  dispatchMessage(msg: HybridMessage): void {
    const handler = this.messageHandlers.get(msg.type);
    if (handler) {
      handler(msg);
    } else if (this.wildcardHandler) {
      this.wildcardHandler(msg);
    }
  }

  setIrohEnabled(enabled: boolean): void {
    this.irohEnabled = enabled;
  }

  isIrohEnabled(): boolean {
    return this.irohEnabled;
  }

  getConfig(): TransportConfig {
    return { ...this.config };
  }

  setLargeThreshold(bytes: number): void {
    this.config.largeThresholdBytes = bytes;
  }

  setPreferIrohForLarge(enabled: boolean): void {
    this.config.preferIrohForLarge = enabled;
  }
}

export const hybridMessenger = new HybridMessenger();
