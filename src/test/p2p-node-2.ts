/**
 * P2P Node 2 - Bob
 * 运行: npx tsx src/test/p2p-node-2.ts
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

config();

const PORT = 3002;
const NAME = 'Bob';
const TOPIC = 'bolloon-p2p-test';

interface P2PMessage {
  type: string;
  from: string;
  content: string;
  timestamp: number;
}

class P2PNode {
  id = crypto.randomUUID();
  name = NAME;
  port = PORT;
  topic = TOPIC;
  private peers: Map<string, { name: string; port: number }> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  async start() {
    const app = express();
    app.use(express.json());

    app.get('/health', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port, peers: Array.from(this.peers.keys()) });
    });

    app.get('/discovery', (req, res) => {
      res.json({ id: this.id, name: this.name, port: this.port, topic: this.topic });
    });

    app.get('/nodes', (req, res) => {
      const nodes = Array.from(this.peers.entries()).map(([id, p]) => ({ id, name: p.name, port: p.port }));
      nodes.push({ id: this.id, name: this.name, port: this.port });
      res.json(nodes);
    });

    app.post('/message', (req, res) => {
      const { type, content } = req.body;
      console.log(`\n📨 [${this.name}] 收到消息: ${type} - ${content.substring(0, 50)}...`);

      if (type === 'ping') {
        console.log(`   → 回复 pong`);
        this.broadcastToAll('pong', `Pong from ${this.name}!`);
      } else if (type === 'harness-sync') {
        console.log(`\n🔄 [${this.name}] Harness 同步消息:`);
        try {
          const sync = JSON.parse(content);
          console.log(`   Gate: ${sync.gate}`);
          console.log(`   Skills: ${sync.skills?.join(', ')}`);
        } catch {}
      } else if (type === 'chat') {
        console.log(`   → 回复: 你好！我是 Bob`);
        this.broadcastToAll('chat', `你好！我是 Bob，很高兴认识你！`);
      }

      res.json({ ok: true });
    });

    app.post('/broadcast', (req, res) => {
      const { type, content } = req.body;
      console.log(`\n📢 [${this.name}] 收到广播: ${type}`);
      res.json({ ok: true });
    });

    const server = createServer(app);

    return new Promise<void>((resolve, reject) => {
      server.listen(this.port, () => {
        console.log(`\n✓ [${this.name}] 启动成功 on port ${this.port}`);
        console.log(`  ID: ${this.id.substring(0, 16)}...`);
        console.log(`  Topic: ${this.topic}`);
        this.startHeartbeat();
        resolve();
      });
      server.on('error', reject);
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      console.log(`\n💓 [${this.name}] 心跳 - 扫描邻居...`);
      await this.discoverPeers();
      console.log(`   当前邻居: ${this.peers.size}`);

      if (this.peers.size > 0) {
        // 发送测试消息
        const peer = Array.from(this.peers.entries())[0];
        const [peerId, peerInfo] = peer;

        console.log(`\n📤 [${this.name}] 发送测试消息给 ${peerInfo.name}...`);
        try {
          await fetch(`http://localhost:${peerInfo.port}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'chat',
              content: `你好 ${peerInfo.name}，我是 ${this.name}！`
            })
          });
        } catch (err) {
          console.log(`   发送失败: ${err}`);
          this.peers.delete(peerId);
        }
      }
    }, 8000);
  }

  private async discoverPeers() {
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
            if (!this.peers.has(info.id)) {
              console.log(`\n🔍 [${this.name}] 发现新节点: ${info.name} on port ${info.port}`);
              this.peers.set(info.id, { name: info.name, port: info.port });
            }
          }
        }
      } catch {}
    }
  }

  private async broadcastToAll(type: string, content: string) {
    for (const [peerId, peerInfo] of this.peers) {
      try {
        await fetch(`http://localhost:${peerInfo.port}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, content })
        });
      } catch {}
    }
  }

  async stop() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  }
}

// 启动
const node = new P2PNode();
node.start().then(() => {
  console.log('\n━━━ 等待节点发现... ━━━\n');

  process.on('SIGINT', async () => {
    console.log('\n\n🛑 正在停止...');
    await node.stop();
    process.exit(0);
  });
}).catch(console.error);