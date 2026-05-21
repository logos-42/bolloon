import { irohTransport, type IrohMessage } from './iroh-transport.js';
import { AgentAuthManager, KeyManager, type AgentInfo, type IdentityRegistration, type KeyPair } from '@diap/sdk';

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
}

export class IrohIntegration {
  private config: IrohIntegrationConfig;
  private irohNodeId: string | null = null;
  private registration: IdentityRegistration | null = null;
  private messageHandlers: Map<string, (msg: IrohMessage, from: string) => void> = new Map();
  private discoveredPeers: Map<string, IrohDiscoveryResult> = new Map();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
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
      console.log('[IrohIntegration] Starting iroh transport...');

      const node = await irohTransport.start();
      this.irohNodeId = node.nodeId;
      console.log(`[IrohIntegration] Node ID: ${this.irohNodeId}`);

      irohTransport.onMessage('*', (msg) => {
        this.dispatchMessage(msg);
      });

      await this.registerWithDIAP();
      this.startRefreshLoop();

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

      console.log(`[IrohIntegration] DIAP registered: DID=${this.registration.did.substring(0, 20)}...`);
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

  private dispatchMessage(msg: IrohMessage): void {
    const handler = this.messageHandlers.get(msg.type);
    if (handler) {
      handler(msg, msg.from);
    }
  }

  onMessage(type: string, handler: (msg: IrohMessage, from: string) => void): void {
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

  getConnectedPeers(): string[] {
    return Array.from(this.connectedPeers);
  }

  async shutdown(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

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
