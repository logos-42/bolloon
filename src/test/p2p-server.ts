/**
 * P2P Two Web Servers Integration Test
 * 测试两个独立 Web 服务器能否相互发现并进行 P2P 交流
 *
 * 需要两个终端：
 * 终端 1: npx tsx src/test/p2p-server-1.ts
 * 终端 2: npx tsx src/test/p2p-server-2.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

config();

const HEARTBEAT_INTERVAL = 5000;
const DISCOVERY_URL = process.env.DISCOVERY_URL || 'http://localhost:3000';

interface NodeInfo {
  id: string;
  name: string;
  port: number;
  topic: string;
  peers: string[];
  lastHeartbeat: number;
}

interface P2PMessage {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  id: string;
}

class P2PServer {
  id: string;
  name: string;
  port: number;
  topic: string;
  private peers: Map<string, NodeInfo> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private messageQueue: P2PMessage[] = [];

  constructor(name: string, port: number, topic: string = 'bolloon-p2p-test') {
    this.id = crypto.randomUUID();
    this.name = name;
    this.port = port;
    this.topic = topic;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    // 健康检查
    app.get('/health', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        peers: Array.from(this.peers.keys()),
        topic: this.topic
      });
    });

    // 发现端点
    app.get('/discovery', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        topic: this.topic,
        peers: Array.from(this.peers.keys())
      });
    });

    // 获取所有已知节点
    app.get('/nodes', (req, res) => {
      const nodes = Array.from(this.peers.values());
      nodes.push({
        id: this.id,
        name: this.name,
        port: this.port,
        topic: this.topic,
        peers: Array.from(this.peers.keys()),
        lastHeartbeat: Date.now()
      });
      res.json(nodes);
    });

    // 消息接收
    app.post('/message', (req, res) => {
      const { type, content } = req.body;
      const msg: P2PMessage = {
        type,
        from: this.id,
        content,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      };

      this.handleMessage(msg);
      res.json({ ok: true, msgId: msg.id });
    });

    // 广播消息
    app.post('/broadcast', (req, res) => {
      const { type, content } = req.body;
      console.log(`[${this.name}] 收到广播: ${type}`);
      res.json({ ok: true });
    });

    // 直接消息
    app.post('/send', (req, res) => {
      const { to, type, content } = req.body;
      this.sendToPeer(to, type, content);
      res.json({ ok: true });
    });

    // 设置消息处理器
    app.post('/set-handler', (req, res) => {
      const { type, handler } = req.body;
      console.log(`[${this.name}] 设置消息处理器: ${type}`);
      res.json({ ok: true });
    });

    this.server = createServer(app);

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        console.log(`✓ [${this.name}] 启动成功 on port ${this.port}`);
        console.log(`  ID: ${this.id}`);
        console.log(`  Discovery: http://localhost:${this.port}/discovery`);

        this.startHeartbeat();
        resolve();
      });

      this.server!.on('error', reject);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      await this.discoverPeers();
    }, HEARTBEAT_INTERVAL);

    // 立即执行一次
    this.discoverPeers();
  }

  private async discoverPeers(): Promise<void> {
    const ports = [3001, 3002, 3003, 3004, 3005];

    for (const port of ports) {
      if (port === this.port) continue;

      try {
        const resp = await fetch(`http://localhost:${port}/discovery`, {
          signal: AbortSignal.timeout(1000)
        });

        if (resp.ok) {
          const info = await resp.json();

          if (info.topic === this.topic && info.id !== this.id) {
            const existing = this.peers.get(info.id);
            if (!existing) {
              console.log(`\n🔍 [${this.name}] 发现新节点: ${info.name} on port ${info.port}`);
              console.log(`   Peer ID: ${info.id.substring(0, 16)}...`);

              this.peers.set(info.id, {
                id: info.id,
                name: info.name,
                port: info.port,
                topic: info.topic,
                peers: info.peers || [],
                lastHeartbeat: Date.now()
              });
            } else {
              existing.lastHeartbeat = Date.now();
            }
          }
        }
      } catch {
        // 节点不存在
      }
    }
  }

  private handleMessage(msg: P2PMessage): void {
    console.log(`\n📨 [${this.name}] 收到消息:`);
    console.log(`   Type: ${msg.type}`);
    console.log(`   From: ${msg.from.substring(0, 16)}...`);
    console.log(`   Content: ${msg.content.substring(0, 50)}...`);

    this.messageQueue.push(msg);
    if (this.messageQueue.length > 100) {
      this.messageQueue.shift();
    }

    // 处理特定类型的消息
    if (msg.type === 'ping') {
      this.sendToPeer(msg.from, 'pong', `Pong from ${this.name}!`);
    } else if (msg.type === 'harness-sync') {
      console.log(`\n🔄 [${this.name}] 收到 Harness 同步消息`);
      try {
        const sync = JSON.parse(msg.content);
        console.log(`   Gate: ${sync.gate || 'N/A'}`);
        console.log(`   Skills: ${sync.skills?.join(', ') || 'N/A'}`);
      } catch {
        console.log(`   Content: ${msg.content}`);
      }
    } else if (msg.type === 'chat') {
      console.log(`\n💬 [${this.name}] 收到聊天消息: ${msg.content}`);
    }
  }

  async sendToPeer(peerId: string, type: string, content: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.log(`[${this.name}] Unknown peer: ${peerId.substring(0, 8)}...`);
      return;
    }

    try {
      await fetch(`http://localhost:${peer.port}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content })
      });
      console.log(`[${this.name}] 消息已发送到 ${peer.name}`);
    } catch (err) {
      console.log(`[${this.name}] 发送失败:`, err);
    }
  }

  async broadcast(type: string, content: string): Promise<void> {
    console.log(`\n📢 [${this.name}] 广播消息: ${type}`);
    console.log(`   Content: ${content.substring(0, 50)}...`);

    for (const [peerId, peer] of this.peers) {
      try {
        await fetch(`http://localhost:${peer.port}/broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, content })
        });
      } catch {
        // peer unavailable
      }
    }
  }

  getPeers(): string[] {
    return Array.from(this.peers.keys());
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.server) {
      await new Promise(resolve => this.server!.close(resolve));
    }
  }
}

// 导出以便在其他地方使用
export { P2PServer };

// 入口点
async function main() {
  const args = process.argv.slice(2);
  const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] || '3001');
  const name = args.find(a => a.startsWith('--name='))?.split('=')[1] || `Node-${port}`;
  const action = args[0] || 'start';

  if (action === 'start') {
    const node = new P2PServer(name, port);
    await node.start();

    console.log('\n━━━ 节点已启动，等待发现... ━━━\n');

    // 保持运行
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 正在停止节点...');
      await node.stop();
      console.log('✓ 节点已停止');
      process.exit(0);
    });

    // 每 10 秒发送一次测试消息
    let count = 0;
    const testInterval = setInterval(async () => {
      count++;
      if (node.getPeerCount() > 0) {
        const peers = node.getPeers();
        const peerId = peers[0];

        if (count % 3 === 0) {
          // 每 30 秒发送 harness 同步
          const syncMsg = JSON.stringify({
            gate: count / 3,
            skills: ['arch', 'lead', 'harness-eng'],
            agents: [node.id, ...peers],
            timestamp: Date.now()
          });
          await node.sendToPeer(peerId, 'harness-sync', syncMsg);
        } else {
          // 普通聊天
          await node.sendToPeer(peerId, 'chat', `Hello from ${name}! Message #${count}`);
        }
      } else {
        console.log(`[${name}] 等待邻居... (${count * 10}s)`);
      }
    }, 10000);
  }
}

// 如果直接运行
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  main().catch(console.error);
}

export default P2PServer;