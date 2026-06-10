/**
 * p2p-direct.ts — 薄包装 hyperswarm (纯 TS, npm 包, 不改 binding)
 *
 * 为什么: @diap/sdk 的 HyperswarmCommunicator.sendToConnection 是 stub (只更新 bytesSent 计数器, 不真发).
 * 这层薄包装直接用 hyperswarm 库, 真正把数据写到 socket.
 *
 * 用法:
 *   const p2p = new P2PDirect({ name: 'bolloon' });
 *   await p2p.start();
 *   await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));
 *   p2p.on('data', (data, fromPublicKey) => { ... });
 *   p2p.broadcast(Buffer.from('hello'));
 *   await p2p.stop();
 */
// @ts-ignore — hyperswarm 没官方 .d.ts
import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import { EventEmitter } from 'events';
// @ts-ignore — b4a 没官方 .d.ts
import b4a from 'b4a';
import { loadOrCreateKeyPair, writebackPublicKey } from './p2p-secret.js';

export interface P2PDirectOptions {
  /** 节点标识 (用于日志) */
  name?: string;
  /**
   * 角色标识 (对应 ~/.bolloon/p2p-direct-secret-{role}.json).
   * 留空时, P2PDirect 自动从 IROH_ROLE / BOLLOON_ROLE / 'default' 选.
   *
   * 同一台机器同一 role → 同一 publicKey (持久化 secretKey)
   * 不同 role → 独立身份 (例: nodeA 和 nodeB 同机开发, 不冲突)
   */
  role?: string;
  /**
   * 跳过持久化 secret 加载, 完全随机 keyPair.
   * (调试 / 测试用, 真实环境应保持默认 false)
   */
  ephemeral?: boolean;
}

export interface DataEvent {
  data: Buffer;
  fromPublicKey: string;  // hex
  remoteAddress?: string; // 暂时没用到
}

export class P2PDirect extends EventEmitter {
  private swarm: Hyperswarm | null = null;
  private name: string;
  private role: string;
  private joinedTopics: Set<string> = new Set();
  // 维护: 远端 publicKey -> conn (用于主动 send)
  private conns: Map<string, any> = new Map();
  private started: boolean = false;
  private ephemeral: boolean;

  constructor(opts: P2PDirectOptions = {}) {
    super();
    this.name = opts.name || 'p2p-direct';
    this.role = opts.role || (process.env.IROH_ROLE || process.env.BOLLOON_ROLE || 'default');
    this.ephemeral = !!opts.ephemeral;
  }

  async start(): Promise<void> {
    if (this.started) return;

    // 1. 加载/生成持久化 keyPair (同一 role 跨重启同一 publicKey)
    if (this.ephemeral) {
      console.log(`[P2PDirect:${this.name}] ephemeral 模式, 不持久化`);
      this.swarm = new Hyperswarm();
    } else {
      const kp = await loadOrCreateKeyPair(this.role);
      // hyperswarm 4.x 支持 `seed` 选项, DHT.keyPair(seed) 内部派生稳定 publicKey
      this.swarm = new Hyperswarm({
        seed: Buffer.from(kp.secretKey, 'hex'),  // 32-byte ed25519/X25519 seed
      });
      // 验证 / 写回 publicKey (首次启动时文件里是空)
      const realPub = b4a.toString(this.swarm.keyPair.publicKey, 'hex');
      if (kp.publicKey !== realPub) {
        await writebackPublicKey(this.role, kp.secretKey, realPub);
      }
    }

    this.swarm.on('connection', (conn: any, info: any) => {
      const remotePubKeyHex = b4a.toString(info.publicKey, 'hex');
      console.log(`[P2PDirect:${this.name}] 新连接: ${remotePubKeyHex.substring(0, 12)}... (inbound=${info.inbound || false}, type=${typeof conn}, hasWrite=${typeof conn?.write})`);

      // 双向记录 (inbound + outbound 都能拿到)
      this.conns.set(remotePubKeyHex, conn);

      // 收到数据时 → 触发 'data' 事件
      // 注意: data 监听器必须在 emit('connection') 之前注册,
      // 否则 server 的 connection handler 发送消息后, 对端回复可能在 data 监听器就绪前到达
      conn.on('data', (chunk: Buffer | Uint8Array) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        console.log(`[P2PDirect:${this.name}] 收到数据 from ${remotePubKeyHex.substring(0,12)}... (${buf.length} bytes)`);
        this.emit('data', {
          data: buf,
          fromPublicKey: remotePubKeyHex,
        } as DataEvent);
      });

      conn.on('error', (err: Error) => {
        console.error(`[P2PDirect:${this.name}] 连接错误 (${remotePubKeyHex.substring(0,12)}...):`, err.message);
      });

      conn.on('close', () => {
        this.conns.delete(remotePubKeyHex);
      });

      // v3: 触发 'connection' 事件, 上层 (web server) 可以主动给新连接发消息
      // 注意: 放在 data/error/close 监听器之后, 确保 server 的 connection handler 不会先于 data 就绪
      this.emit('connection', { remotePublicKey: remotePubKeyHex, conn });
    });

    await this.swarm.listen(); // server 模式
    this.started = true;
    console.log(`[P2PDirect:${this.name}] 启动 OK, publicKey: ${b4a.toString(this.swarm.keyPair.publicKey, 'hex').substring(0, 12)}...`);
  }

  async joinTopic(topic: Buffer | string): Promise<void> {
    if (!this.swarm) throw new Error('P2PDirect not started');
    const topicBuf = typeof topic === 'string' ? Buffer.from(topic) : topic;
    const topicHex = b4a.toString(topicBuf, 'hex');
    if (this.joinedTopics.has(topicHex)) return;
    const discovery = this.swarm.join(topicBuf, { server: true, client: true });
    await discovery.flushed();
    this.joinedTopics.add(topicHex);
    console.log(`[P2PDirect:${this.name}] 加入 topic: ${topicHex.substring(0, 16)}...`);
  }

  /** 广播数据给所有连接 */
  broadcast(data: Buffer | string): void {
    if (!this.swarm) return;
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    let count = 0;
    for (const conn of this.conns.values()) {
      try {
        if (!conn.destroyed) {
          conn.write(buf);
          count++;
        }
      } catch (err) {
        // 忽略单条连接错误, 不影响广播
      }
    }
    if (count > 0) {
      console.log(`[P2PDirect:${this.name}] broadcast 写到 ${count} 个连接 (${buf.length} bytes)`);
    }
  }

  /** 主动 send 给单个 peer (已知 publicKey hex) */
  sendTo(publicKeyHex: string, data: Buffer | string): boolean {
    const conn = this.conns.get(publicKeyHex);
    if (!conn || conn.destroyed) return false;
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    try {
      conn.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  getPublicKey(): string {
    if (!this.swarm) return '';
    return b4a.toString(this.swarm.keyPair.publicKey, 'hex');
  }

  /** 当前 P2PDirect 用的 role (对应 secret 文件名) */
  getRole(): string {
    return this.role;
  }

  getConnectionCount(): number {
    return this.conns.size;
  }

  async stop(): Promise<void> {
    if (!this.swarm) return;
    await this.swarm.destroy();
    this.swarm = null;
    this.conns.clear();
    this.started = false;
    console.log(`[P2PDirect:${this.name}] 已停止`);
  }
}
