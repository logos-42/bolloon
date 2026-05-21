import { irohTransport, type IrohMessage } from './iroh-transport.js';
import type { AgentAuthManager, AgentInfo } from '@diap/sdk';
import type { KeyPair } from '@diap/sdk';

export interface IrohServiceInfo {
  serviceType: 'iroh';
  endpoint: string;
}

export interface IrohIntegrationConfig {
  agentAuthManager: AgentAuthManager;
  keyPair: KeyPair;
  agentName: string;
  irohSecretKey?: string;
  agentDescription?: string;
  agentTags?: string[];
}

export class IrohIntegration {
  private config: IrohIntegrationConfig;
  private irohNodeId: string | null = null;
  private messageHandlers: Map<string, (msg: IrohMessage, from: string) => void> = new Map();

  constructor(config: IrohIntegrationConfig) {
    this.config = config;
  }

  async start(): Promise<string | null> {
    try {
      console.log('[IrohIntegration] Starting iroh transport...');
      const node = await irohTransport.start(this.config.irohSecretKey);
      this.irohNodeId = node.nodeId;
      console.log(`[IrohIntegration] Iroh node ID: ${this.irohNodeId}`);

      irohTransport.onMessage('*', (msg) => {
        this.dispatchMessage(msg);
      });

      await this.registerWithDIAP();

      return this.irohNodeId;
    } catch (e) {
      console.warn('[IrohIntegration] Failed to start:', e);
      return null;
    }
  }

  private async registerWithDIAP(): Promise<void> {
    if (!this.irohNodeId) {
      console.warn('[IrohIntegration] No iroh node ID to register');
      return;
    }

    try {
      const services = [
        {
          serviceType: 'iroh',
          endpoint: this.irohNodeId,
        },
        {
          serviceType: 'iroh-quic',
          endpoint: `iroh://${this.irohNodeId}`,
        },
      ];

      const agentInfo: AgentInfo = {
        name: this.config.agentName,
        services: services as any,
        description: this.config.agentDescription || 'Bolloon agent with iroh transport',
        tags: this.config.agentTags || ['bolloon', 'iroh', 'p2p'],
      };

      const result = await this.config.agentAuthManager.registerAgent(
        agentInfo,
        this.config.keyPair,
        this.irohNodeId
      );

      console.log(`[IrohIntegration] Registered with DIAP: DID=${result.did.substring(0, 20)}..., CID=${result.cid}`);
    } catch (e) {
      console.warn('[IrohIntegration] Failed to register with DIAP:', e);
    }
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

  async shutdown(): Promise<void> {
    await irohTransport.shutdown();
    console.log('[IrohIntegration] Shut down');
  }
}

let integrationInstance: IrohIntegration | null = null;

export async function initIrohIntegration(
  config: IrohIntegrationConfig
): Promise<IrohIntegration> {
  if (integrationInstance) {
    return integrationInstance;
  }

  integrationInstance = new IrohIntegration(config);
  await integrationInstance.start();
  return integrationInstance;
}

export function getIrohIntegration(): IrohIntegration | null {
  return integrationInstance;
}
