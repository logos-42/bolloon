import { AgentAuthManager, type AgentInfo, type KeyPair } from '@diap/sdk';
import { irohTransport } from './iroh-transport.js';

export interface DiscoveredAgent {
  did: string;
  name: string;
  peerId: string;
  irohNodeId: string | null;
  lastSeen: number;
  services: string[];
}

export interface IrohDiscoveryConfig {
  agentAuthManager: AgentAuthManager;
  keyPair: KeyPair;
  agentName: string;
  agentDescription?: string;
  agentTags?: string[];
  discoveryIntervalMs?: number;
  refreshIntervalMs?: number;
}

export class IrohDiscoveryService {
  private config: IrohDiscoveryConfig;
  private discoveredAgents: Map<string, DiscoveredAgent> = new Map();
  private ownIrohNodeId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private isRegistered: boolean = false;

  constructor(config: IrohDiscoveryConfig) {
    this.config = {
      discoveryIntervalMs: 30000,
      refreshIntervalMs: 5 * 60 * 1000,
      ...config,
    };
  }

  async start(): Promise<string | null> {
    console.log('[IrohDiscovery] Starting...');

    const node = await irohTransport.start();
    this.ownIrohNodeId = node.nodeId;
    console.log('[IrohDiscovery] Iroh node ID:', this.ownIrohNodeId.substring(0, 16) + '...');

    await this.registerWithDIAP();
    this.isRegistered = true;

    this.startRefreshLoop();
    this.startDiscoveryLoop();

    return this.ownIrohNodeId;
  }

  private async registerWithDIAP(): Promise<void> {
    if (!this.ownIrohNodeId) return;

    try {
      const services = [
        { serviceType: 'iroh', endpoint: this.ownIrohNodeId },
        { serviceType: 'iroh-quic', endpoint: `iroh://${this.ownIrohNodeId}` },
      ];

      const agentInfo: AgentInfo = {
        name: this.config.agentName,
        services: services as any,
        description: this.config.agentDescription || 'Bolloon agent with iroh P2P',
        tags: this.config.agentTags || ['bolloon', 'iroh'],
      };

      await this.config.agentAuthManager.registerAgent(
        agentInfo,
        this.config.keyPair,
        this.ownIrohNodeId
      );

      console.log('[IrohDiscovery] Registered with DIAP');
    } catch (e) {
      console.warn('[IrohDiscovery] DIAP registration failed:', e);
    }
  }

  private startRefreshLoop(): void {
    this.refreshTimer = setInterval(async () => {
      if (!this.isRegistered) return;
      console.log('[IrohDiscovery] Refreshing DIAP registration...');
      await this.registerWithDIAP();
    }, this.config.refreshIntervalMs!);
  }

  private startDiscoveryLoop(): void {
    this.discoveryTimer = setInterval(async () => {
      await this.discoverPeers();
    }, this.discoveryIntervalMs!);

    setTimeout(() => this.discoverPeers(), 2000);
  }

  async discoverPeers(): Promise<DiscoveredAgent[]> {
    console.log('[IrohDiscovery] Discovering peers...');

    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000;

    for (const [did, agent] of this.discoveredAgents) {
      if (now - agent.lastSeen > staleThreshold) {
        this.discoveredAgents.delete(did);
      }
    }

    console.log('[IrohDiscovery] Known agents:', this.discoveredAgents.size);
    return Array.from(this.discoveredAgents.values());
  }

  async discoverViaDIAP(): Promise<DiscoveredAgent[]> {
    console.log('[IrohDiscovery] Querying DIAP for agents...');

    const agents: DiscoveredAgent[] = [];

    try {
      const ipfsClient = (this.config.agentAuthManager as any).identityManager?.ipfsClient;
      if (ipfsClient) {
        console.log('[IrohDiscovery] IPFS client available for discovery');
      }
    } catch (e) {
      console.warn('[IrohDiscovery] DIAP discovery error:', e);
    }

    return agents;
  }

  addDiscoveredAgent(agent: DiscoveredAgent): void {
    const existing = this.discoveredAgents.get(agent.did);
    this.discoveredAgents.set(agent.did, {
      ...agent,
      lastSeen: Date.now(),
      irohNodeId: agent.irohNodeId || existing?.irohNodeId || null,
    });
  }

  getDiscoveredAgents(): DiscoveredAgent[] {
    return Array.from(this.discoveredAgents.values());
  }

  getAgentByDid(did: string): DiscoveredAgent | undefined {
    return this.discoveredAgents.get(did);
  }

  getAgentsWithIroh(): DiscoveredAgent[] {
    return Array.from(this.discoveredAgents.values()).filter(
      (a) => a.irohNodeId !== null
    );
  }

  getOwnIrohNodeId(): string | null {
    return this.ownIrohNodeId;
  }

  async connectToPeer(nodeId: string): Promise<boolean> {
    return irohTransport.connect(nodeId);
  }

  async connectToAllIrohPeers(): Promise<void> {
    const agents = this.getAgentsWithIroh();
    for (const agent of agents) {
      if (agent.irohNodeId && agent.irohNodeId !== this.ownIrohNodeId) {
        await this.connectToPeer(agent.irohNodeId);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.isRegistered = false;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    this.discoveredAgents.clear();
    await irohTransport.shutdown();
    console.log('[IrohDiscovery] Shut down');
  }
}

let discoveryInstance: IrohDiscoveryService | null = null;

export async function startIrohDiscovery(
  config: IrohDiscoveryConfig
): Promise<IrohDiscoveryService> {
  if (discoveryInstance) {
    return discoveryInstance;
  }

  discoveryInstance = new IrohDiscoveryService(config);
  await discoveryInstance.start();
  return discoveryInstance;
}

export function getIrohDiscovery(): IrohDiscoveryService | null {
  return discoveryInstance;
}
