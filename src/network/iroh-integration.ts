import { irohTransport, type IrohMessageEvent } from './iroh-transport.js';
import {
  AgentAuthManager,
  type AgentInfo,
  type IdentityRegistration,
  type KeyPair,
  type IrohCommunicator,
  createIrohCommunicator,
} from '@diap/sdk';

export interface IrohServiceEndpoint {
  serviceType: 'iroh';
  endpoint: string;
}

export interface IrohDiscoveryResult {
  did: string;
  name: string;
  irohNodeId: string;
  lastSeen: number;
}

export interface IrohIntegrationConfig {
  agentAuthManager: AgentAuthManager;
  keyPair: KeyPair;
  agentName: string;
  agentDescription?: string;
  agentTags?: string[];
  refreshIntervalMs?: number;
  discoveryIntervalMs?: number;
  irohCommunicator?: IrohCommunicator;
}

export class IrohIntegration {
  private config: IrohIntegrationConfig;
  private irohNodeId: string | null = null;
  private registration: IdentityRegistration | null = null;
  private messageHandlers: Map<string, (msg: IrohMessageEvent) => void> = new Map();
  private discoveredPeers: Map<string, IrohDiscoveryResult> = new Map();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private connectedPeers: Set<string> = new Set();

  constructor(config: IrohIntegrationConfig) {
    this.config = {
      refreshIntervalMs: 5 * 60 * 1000,
      discoveryIntervalMs: 30 * 1000,
      ...config,
    };
  }

  async start(): Promise<string | null> {
    try {
      console.log('[IrohIntegration] Starting...');

      if (this.config.irohCommunicator) {
        console.log('[IrohIntegration] Using provided IrohCommunicator');
      } else {
        console.log('[IrohIntegration] Creating new IrohCommunicator');
      }

      const node = await irohTransport.start();
      this.irohNodeId = node.nodeId;
      console.log(`[IrohIntegration] Iroh node ID: ${this.irohNodeId}`);

      irohTransport.onMessage('*', (msg) => {
        this.dispatchMessage(msg);
      });

      await this.registerWithDIAP();

      this.startRefreshLoop();
      this.startDiscoveryLoop();

      console.log('[IrohIntegration] Started successfully');
      return this.irohNodeId;
    } catch (e) {
      console.error('[IrohIntegration] Failed to start:', e);
      return null;
    }
  }

  private async registerWithDIAP(): Promise<void> {
    if (!this.irohNodeId) {
      console.warn('[IrohIntegration] No iroh node ID');
      return;
    }

    try {
      const services = [
        { serviceType: 'iroh', endpoint: this.irohNodeId },
        { serviceType: 'iroh-quic', endpoint: `iroh://${this.irohNodeId}` },
      ];

      const agentInfo: AgentInfo = {
        name: this.config.agentName,
        services: services as any,
        description: this.config.agentDescription || 'Bolloon agent with iroh P2P',
        tags: this.config.agentTags || ['bolloon', 'iroh', 'p2p'],
      };

      this.registration = await this.config.agentAuthManager.registerAgent(
        agentInfo,
        this.config.keyPair,
        this.irohNodeId
      );

      console.log(`[IrohIntegration] Registered: DID=${this.registration.did.substring(0, 20)}...`);
    } catch (e) {
      console.error('[IrohIntegration] DIAP registration failed:', e);
    }
  }

  private startRefreshLoop(): void {
    this.refreshTimer = setInterval(async () => {
      console.log('[IrohIntegration] Refreshing DIAP registration...');
      await this.registerWithDIAP();
    }, this.config.refreshIntervalMs!);
  }

  private startDiscoveryLoop(): void {
    this.discoveryTimer = setInterval(async () => {
      await this.discoverPeers();
    }, this.config.discoveryIntervalMs!);

    setTimeout(() => this.discoverPeers(), 2000);
  }

  async discoverPeers(): Promise<IrohDiscoveryResult[]> {
    console.log('[IrohIntegration] Discovering peers...');

    const peers: IrohDiscoveryResult[] = [];

    for (const peer of this.discoveredPeers.values()) {
      if (Date.now() - peer.lastSeen > 10 * 60 * 1000) {
        this.discoveredPeers.delete(peer.irohNodeId);
      }
    }

    console.log(`[IrohIntegration] Known peers: ${this.discoveredPeers.size}`);
    return peers;
  }

  async connectToPeer(nodeId: string): Promise<boolean> {
    if (this.connectedPeers.has(nodeId)) {
      return true;
    }

    try {
      console.log(`[IrohIntegration] Connecting to ${nodeId.substring(0, 12)}...`);
      const success = await irohTransport.sendMessage(nodeId, 'hello', new TextEncoder().encode('ping'));
      if (success) {
        this.connectedPeers.add(nodeId);
        console.log(`[IrohIntegration] Connected to ${nodeId.substring(0, 12)}...`);
      }
      return success;
    } catch (e) {
      console.warn(`[IrohIntegration] Failed to connect to ${nodeId.substring(0, 12)}...:`, e);
      return false;
    }
  }

  async connectToAllDiscovered(): Promise<void> {
    for (const peer of this.discoveredPeers.values()) {
      await this.connectToPeer(peer.irohNodeId);
    }
  }

  private dispatchMessage(msg: IrohMessageEvent): void {
    const handler = this.messageHandlers.get(msg.type);
    if (handler) {
      handler(msg);
    }
  }

  onMessage(type: string, handler: (msg: IrohMessageEvent) => void): void {
    this.messageHandlers.set(type, handler);
  }

  async sendTo(targetNodeId: string, type: string, payload: Uint8Array): Promise<boolean> {
    return irohTransport.sendMessage(targetNodeId, type, payload);
  }

  async requestFrom(targetNodeId: string, type: string, payload: Uint8Array): Promise<Uint8Array | null> {
    return irohTransport.requestResponse(targetNodeId, type, payload);
  }

  getNodeId(): string | null {
    return this.irohNodeId;
  }

  getRegistration(): IdentityRegistration | null {
    return this.registration;
  }

  getDiscoveredPeers(): IrohDiscoveryResult[] {
    return Array.from(this.discoveredPeers.values());
  }

  getConnectedPeers(): string[] {
    return Array.from(this.connectedPeers);
  }

  async shutdown(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    this.connectedPeers.clear();
    await irohTransport.shutdown();
    console.log('[IrohIntegration] Shut down');
  }
}

let integrationInstance: IrohIntegration | null = null;

export async function initIrohIntegration(
  config: IrohIntegrationConfig
): Promise<IrohIntegration> {
  if (integrationInstance) {
    console.log('[IrohIntegration] Already initialized');
    return integrationInstance;
  }

  integrationInstance = new IrohIntegration(config);
  await integrationInstance.start();
  return integrationInstance;
}

export function getIrohIntegration(): IrohIntegration | null {
  return integrationInstance;
}
