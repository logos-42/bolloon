import { Endpoint, Connection } from '@rayhanadev/iroh';

export interface IrohMessage {
  type: string;
  payload: Uint8Array;
  from: string;
}

export type IrohMessageHandler = (msg: IrohMessage) => void;

const IROH_ALPN = 'bolloon/iroh/1';

export class IrohTransport {
  private endpoint: Endpoint | null = null;
  private messageHandlers: Map<string, IrohMessageHandler> = new Map();
  private running: boolean = false;
  private acceptLoop: ReturnType<typeof setInterval> | null = null;
  private ownNodeId: string | null = null;

  async start(secretKey?: string): Promise<{ nodeId: string; addr: string }> {
    if (this.endpoint) {
      throw new Error('IrohTransport already started');
    }

    const options: any = { alpns: [IROH_ALPN] };
    if (secretKey) {
      options.secretKey = secretKey;
    }

    this.endpoint = await Endpoint.createWithOptions(options);
    this.ownNodeId = this.endpoint.nodeId();
    await this.endpoint.online();
    this.running = true;
    this.startAcceptLoop();

    console.log('[IrohTransport] Started, node ID:', this.ownNodeId.substring(0, 16) + '...');

    return {
      nodeId: this.endpoint.nodeId(),
      addr: this.endpoint.addr() || this.endpoint.nodeId(),
    };
  }

  private startAcceptLoop(): void {
    if (!this.endpoint) return;

    this.acceptLoop = setInterval(async () => {
      if (!this.endpoint || !this.running) return;

      try {
        const conn = await this.endpoint.accept();
        if (conn) {
          this.handleConnection(conn);
        }
      } catch (e) {
        console.warn('[IrohTransport] Accept error:', e);
      }
    }, 100);
  }

  private async handleConnection(conn: Connection): Promise<void> {
    const remoteNodeId = conn.remoteNodeId();
    console.log('[IrohTransport] Connection from:', remoteNodeId.substring(0, 16) + '...');

    try {
      const { recv } = await conn.acceptBi();
      const data = await recv.readToEnd(64 * 1024);

      if (data.length > 0) {
        const text = new TextDecoder().decode(data);
        const colonIdx = text.indexOf(':');
        const type = colonIdx > 0 ? text.substring(0, colonIdx) : 'raw';
        const payload = colonIdx > 0 ? new TextEncoder().encode(text.substring(colonIdx + 1)) : data;

        const handler = this.messageHandlers.get(type);
        if (handler) {
          handler({ type, payload, from: remoteNodeId });
        } else {
          const wildcard = this.messageHandlers.get('*');
          if (wildcard) {
            wildcard({ type, payload, from: remoteNodeId });
          }
        }
      }
    } catch (e) {
      console.warn('[IrohTransport] Error handling connection:', e);
    } finally {
      try { conn.close(); } catch {}
    }
  }

  async sendMessage(targetNodeId: string, type: string, payload: Uint8Array): Promise<boolean> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    try {
      const conn = await this.endpoint.connect(targetNodeId, IROH_ALPN);
      const { send } = await conn.openBi();

      const message = type + ':' + new TextDecoder().decode(payload);
      await send.writeAll(Buffer.from(message));
      await send.finish();

      conn.close();
      return true;
    } catch (e) {
      console.warn('[IrohTransport] Send failed to', targetNodeId.substring(0, 12) + ':', e);
      return false;
    }
  }

  async requestResponse(targetNodeId: string, type: string, payload: Uint8Array): Promise<Uint8Array | null> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    try {
      const conn = await this.endpoint.connect(targetNodeId, IROH_ALPN);
      const { send, recv } = await conn.openBi();

      const requestMsg = type + ':' + new TextDecoder().decode(payload);
      await send.writeAll(Buffer.from(requestMsg));
      await send.finish();

      const response = await recv.readToEnd(64 * 1024);
      conn.close();

      return response;
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

  async shutdown(): Promise<void> {
    this.running = false;

    if (this.acceptLoop) {
      clearInterval(this.acceptLoop);
      this.acceptLoop = null;
    }

    if (this.endpoint) {
      await this.endpoint.close();
      this.endpoint = null;
    }

    this.ownNodeId = null;
    console.log('[IrohTransport] Shut down');
  }
}

export const irohTransport = new IrohTransport();
