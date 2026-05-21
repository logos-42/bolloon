import {
  IrohCommunicator,
  createIrohCommunicator,
  type IrohConfig,
  type IrohMessage,
  type IrohConnection,
  type IrohMessageType,
} from '@diap/sdk';

export interface IrohNode {
  nodeId: string;
  addr: string;
}

export interface IrohMessageEvent {
  type: string;
  payload: Uint8Array;
  from: string;
  messageType: IrohMessageType;
}

export type IrohMessageHandler = (msg: IrohMessageEvent) => void;

export class IrohTransport {
  private communicator: IrohCommunicator | null = null;
  private messageHandlers: Map<string, IrohMessageHandler> = new Map();
  private running: boolean = false;
  private ownNodeId: string | null = null;

  async start(config?: IrohConfig): Promise<IrohNode> {
    if (this.communicator) {
      throw new Error('IrohTransport already started');
    }

    this.communicator = createIrohCommunicator({
      listenAddr: '0.0.0.0:0',
      maxConnections: 100,
      enableRelay: true,
      enableNatTraversal: true,
      ...config,
    });

    await this.communicator.start();

    this.ownNodeId = this.communicator.getNodeId();
    this.running = true;

    console.log('[IrohTransport] Started');
    console.log('[IrohTransport] Node ID:', this.ownNodeId);

    return {
      nodeId: this.ownNodeId,
      addr: this.communicator.getNodeAddr(),
    };
  }

  async connect(targetNodeId: string): Promise<string> {
    if (!this.communicator) {
      throw new Error('IrohTransport not started');
    }

    const conn = await this.communicator.connectToNode(targetNodeId);
    console.log('[IrohTransport] Connected to:', targetNodeId.substring(0, 12), '...');
    return conn;
  }

  async sendMessage(targetNodeId: string, type: string, payload: Uint8Array): Promise<boolean> {
    if (!this.communicator) {
      throw new Error('IrohTransport not started');
    }

    try {
      const message: IrohMessage = {
        messageId: crypto.randomUUID(),
        messageType: 'custom' as IrohMessageType,
        fromDid: this.ownNodeId || '',
        toDid: targetNodeId,
        content: new TextDecoder().decode(payload),
        timestamp: Date.now(),
        metadata: { type },
      };

      await this.communicator.sendMessage(targetNodeId, message);
      return true;
    } catch (e) {
      console.warn('[IrohTransport] Send failed:', e);
      return false;
    }
  }

  async requestResponse(targetNodeId: string, type: string, payload: Uint8Array): Promise<Uint8Array | null> {
    if (!this.communicator) {
      throw new Error('IrohTransport not started');
    }

    try {
      await this.connect(targetNodeId);

      const message: IrohMessage = {
        messageId: crypto.randomUUID(),
        messageType: 'resource_request' as IrohMessageType,
        fromDid: this.ownNodeId || '',
        toDid: targetNodeId,
        content: new TextDecoder().decode(payload),
        timestamp: Date.now(),
        metadata: { type, expectResponse: 'true' },
      };

      await this.communicator.sendMessage(targetNodeId, message);

      return payload;
    } catch (e) {
      console.warn('[IrohTransport] Request-response failed:', e);
      return null;
    }
  }

  onMessage(type: string, handler: IrohMessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  getNodeId(): string | null {
    return this.ownNodeId;
  }

  isRunning(): boolean {
    return this.running;
  }

  getConnectedNodes(): string[] {
    if (!this.communicator) return [];
    return this.communicator.getConnectedNodes();
  }

  isConnected(nodeId: string): boolean {
    if (!this.communicator) return false;
    return this.communicator.isNodeConnected(nodeId);
  }

  async shutdown(): Promise<void> {
    this.running = false;

    if (this.communicator) {
      await this.communicator.stop();
      this.communicator = null;
    }

    this.ownNodeId = null;
    console.log('[IrohTransport] Shut down');
  }
}

export const irohTransport = new IrohTransport();
