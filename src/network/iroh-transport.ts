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
  private connectTimeoutMs: number = 10000;

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

    console.log('[IrohTransport] Started, node:', this.ownNodeId.substring(0, 16) + '...');

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
      } catch {
        // Silently ignore accept errors during shutdown
      }
    }, 100);
  }

  private async handleConnection(conn: Connection): Promise<void> {
    const remoteNodeId = conn.remoteNodeId();

    try {
      const { recv } = await conn.acceptBi();
      const data = await recv.readToEnd(64 * 1024);

      if (data.length > 0) {
        const text = new TextDecoder().decode(data);
        const colonIdx = text.indexOf(':');
        const type = colonIdx > 0 ? text.substring(0, colonIdx) : 'raw';
        const payload = new TextEncoder().encode(text.substring(colonIdx + 1));

        const handler = this.messageHandlers.get(type);
        if (handler) {
          handler({ type, payload, from: remoteNodeId });
        }
      }
    } catch {
      // Connection closed or error
    } finally {
      try { conn.close(); } catch {}
    }
  }

  async sendMessage(targetNodeId: string, type: string, payload: Uint8Array): Promise<boolean> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    try {
      const conn = await this.connectWithTimeout(targetNodeId);
      if (!conn) {
        console.warn('[IrohTransport] Connection failed');
        return false;
      }

      const { send } = await conn.openBi();
      const message = type + ':' + new TextDecoder().decode(payload);
      await send.writeAll(Buffer.from(message));
      await send.finish();
      conn.close();
      return true;
    } catch (e) {
      console.warn('[IrohTransport] Send error:', e);
      return false;
    }
  }

  private async connectWithTimeout(nodeId: string): Promise<any> {
    if (!this.endpoint) return null;

    const connectPromise = this.endpoint.connect(nodeId, IROH_ALPN);
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), this.connectTimeoutMs)
    );

    return Promise.race([connectPromise, timeout]);
  }

  async requestResponse(targetNodeId: string, type: string, payload: Uint8Array): Promise<Uint8Array | null> {
    if (!this.endpoint) {
      throw new Error('IrohTransport not started');
    }

    try {
      const conn = await this.connectWithTimeout(targetNodeId);
      if (!conn) {
        console.warn('[IrohTransport] Connection timeout');
        return null;
      }

      const { send, recv } = await conn.openBi();
      const requestMsg = type + ':' + new TextDecoder().decode(payload);
      await send.writeAll(Buffer.from(requestMsg));
      await send.finish();

      const response = await recv.readToEnd(64 * 1024);
      conn.close();
      return response;
    } catch (e) {
      console.warn('[IrohTransport] Request-response error:', e);
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

  setConnectTimeout(ms: number): void {
    this.connectTimeoutMs = ms;
  }

  async shutdown(): Promise<void> {
    this.running = false;

    if (this.acceptLoop) {
      clearInterval(this.acceptLoop);
      this.acceptLoop = null;
    }

    if (this.endpoint) {
      try {
        await this.endpoint.close();
      } catch {}
      this.endpoint = null;
    }

    this.ownNodeId = null;
  }
}

export const irohTransport = new IrohTransport();
