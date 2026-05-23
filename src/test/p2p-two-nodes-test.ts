/**
 * P2P Two-Node Discovery Test
 * 测试两个不同端口的节点能否发现彼此并进行 P2P 交流
 *
 * 运行方式: npx tsx src/test/p2p-two-nodes-test.ts
 */

import { config } from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createServer } from 'http';
import express from 'express';
import crypto from 'crypto';

config();

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'p2p-test');
const NODES_FILE = path.join(CONFIG_DIR, 'nodes.json');

interface NodeInfo {
  id: string;
  port: number;
  name: string;
  publicKey: string;
  lastSeen: number;
  topic: string;
}

class NodeRegistry {
  private nodes: Map<string, NodeInfo> = new Map();

  async init(): Promise<void> {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    try {
      const data = await fs.readFile(NODES_FILE, 'utf-8');
      const nodes: NodeInfo[] = JSON.parse(data);
      for (const n of nodes) {
        this.nodes.set(n.id, n);
      }
      console.log(`[Registry] Loaded ${nodes.length} nodes`);
    } catch {
      console.log('[Registry] Starting fresh');
    }
  }

  async registerNode(node: NodeInfo): Promise<void> {
    node.lastSeen = Date.now();
    this.nodes.set(node.id, node);
    await this.save();
  }

  async unregisterNode(id: string): Promise<void> {
    this.nodes.delete(id);
    await this.save();
  }

  getNodes(): NodeInfo[] {
    return Array.from(this.nodes.values()).filter(
      n => Date.now() - n.lastSeen < 60000
    );
  }

  getNodeById(id: string): NodeInfo | undefined {
    return this.nodes.get(id);
  }

  getOtherNodes(myId: string): NodeInfo[] {
    return this.getNodes().filter(n => n.id !== myId);
  }

  private async save(): Promise<void> {
    const nodes = Array.from(this.nodes.values());
    await fs.writeFile(NODES_FILE, JSON.stringify(nodes, null, 2));
  }
}

interface TestMessage {
  type: 'ping' | 'pong' | 'chat' | 'harness-sync';
  from: string;
  to?: string;
  content: string;
  timestamp: number;
  id: string;
}

class P2PNode {
  id: string;
  name: string;
  port: number;
  topic: string;
  privateKey: Uint8Array;
  publicKey: string;
  private server: any = null;
  private registry: NodeRegistry;
  private connectedPeers: Set<string> = new Set();
  private messageHandlers: Map<string, (msg: TestMessage, from: string) => void> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(name: string, port: number, registry: NodeRegistry) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.port = port;
    this.topic = 'bolloon-p2p-test';
    this.privateKey = crypto.getRandomValues(new Uint8Array(32));
    this.publicKey = Buffer.from(this.privateKey.slice(0, 16)).toString('hex');
    this.registry = registry;
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
        peers: Array.from(this.connectedPeers),
        publicKey: this.publicKey.substring(0, 16) + '...'
      });
    });

    // 发现端点 - 广播自己的存在
    app.get('/discovery', (req, res) => {
      res.json({
        id: this.id,
        name: this.name,
        port: this.port,
        topic: this.topic,
        publicKey: this.publicKey
      });
    });

    // 发现所有节点
    app.get('/nodes', async (req, res) => {
      // 先尝试发现本地网络上的其他节点
      const localNodes = await this.discoverLocalNodes();
      const registeredNodes = this.registry.getOtherNodes(this.id);

      const allNodes = [...localNodes, ...registeredNodes];
      const uniqueNodes = new Map<string, NodeInfo>();
      for (const n of allNodes) {
        uniqueNodes.set(n.id, n);
      }

      res.json(Array.from(uniqueNodes.values()));
    });

    // 消息端点
    app.post('/message', (req, res) => {
      const { type, to, content } = req.body;
      const msg: TestMessage = {
        type,
        from: this.id,
        to,
        content,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      };

      this.handleMessage(msg, 'local');
      res.json({ ok: true, msgId: msg.id });
    });

    // 接收其他节点的消息
    app.post('/relay', async (req, res) => {
      const { type, from, content } = req.body;
      const msg: TestMessage = {
        type,
        from,
        to: this.id,
        content,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      };

      this.handleMessage(msg, 'relay');
      res.json({ ok: true });
    });

    this.server = app.listen(this.port, () => {
      console.log(`✓ [${this.name}] 启动成功 on port ${this.port}`);
      console.log(`  ID: ${this.id}`);
      console.log(`  Public Key: ${this.publicKey.substring(0, 16)}...`);
    });

    // 注册到中心注册表
    await this.registry.registerNode({
      id: this.id,
      port: this.port,
      name: this.name,
      publicKey: this.publicKey,
      lastSeen: Date.now(),
      topic: this.topic
    });

    // 启动心跳
    this.startHeartbeat();
  }

  private async discoverLocalNodes(): Promise<NodeInfo[]> {
    const nodes: NodeInfo[] = [];
    const ports = [3001, 3002, 3003, 3004, 3005];

    for (const p of ports) {
      if (p === this.port) continue;

      try {
        const resp = await fetch(`http://localhost:${p}/discovery`, {
          signal: AbortSignal.timeout(1000)
        });

        if (resp.ok) {
          const info = await resp.json();
          if (info.topic === this.topic) {
            nodes.push({
              id: info.id,
              port: info.port,
              name: info.name,
              publicKey: info.publicKey,
              lastSeen: Date.now(),
              topic: info.topic
            });
          }
        }
      } catch {
        // 节点不存在
      }
    }

    return nodes;
  }

  private startHeartbeat(): void {
    // 每 5 秒更新注册表并尝试发现新节点
    this.heartbeatInterval = setInterval(async () => {
      await this.registry.registerNode({
        id: this.id,
        port: this.port,
        name: this.name,
        publicKey: this.publicKey,
        lastSeen: Date.now(),
        topic: this.topic
      });

      // 发现邻居
      const neighbors = this.registry.getOtherNodes(this.id);
      for (const n of neighbors) {
        if (!this.connectedPeers.has(n.id)) {
          await this.connectToPeer(n);
        }
      }

      // 广播存在到本地网络
      this.broadcastPresence();
    }, 5000);
  }

  private async connectToPeer(peer: NodeInfo): Promise<void> {
    try {
      // 尝试直接连接
      const resp = await fetch(`http://localhost:${peer.port}/discovery`, {
        signal: AbortSignal.timeout(1000)
      });

      if (resp.ok) {
        this.connectedPeers.add(peer.id);
        console.log(`✓ [${this.name}] 连接成功: ${peer.name} (${peer.id.substring(0, 8)}...)`);
      }
    } catch {
      // 连接失败
    }
  }

  private async broadcastPresence(): Promise<void> {
    // 广播自己的存在到本地网络
    const ports = [3001, 3002, 3003, 3004, 3005];
    for (const p of ports) {
      if (p === this.port) continue;

      try {
        await fetch(`http://localhost:${p}/relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'presence',
            from: this.id,
            content: JSON.stringify({
              name: this.name,
              port: this.port,
              publicKey: this.publicKey
            })
          }),
          signal: AbortSignal.timeout(500)
        });
      } catch {
        // 节点不存在
      }
    }
  }

  onMessage(type: string, handler: (msg: TestMessage, from: string) => void): void {
    this.messageHandlers.set(type, handler);
  }

  private handleMessage(msg: TestMessage, source: string): void {
    const handler = this.messageHandlers.get(msg.type);
    if (handler) {
      handler(msg, source === 'local' ? msg.from : source);
    }
  }

  async sendMessage(toId: string, type: string, content: string): Promise<void> {
    const peer = this.registry.getNodeById(toId);
    if (!peer) {
      console.log(`[${this.name}] Unknown peer: ${toId}`);
      return;
    }

    try {
      await fetch(`http://localhost:${peer.port}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, to: toId, content })
      });
    } catch (err) {
      console.log(`[${this.name}] Failed to send message to ${toId}:`, err);
    }
  }

  async broadcast(type: string, content: string): Promise<void> {
    const msg: TestMessage = {
      type,
      from: this.id,
      content,
      timestamp: Date.now(),
      id: crypto.randomUUID()
    };

    // 广播到本地网络
    const ports = [3001, 3002, 3003, 3004, 3005];
    for (const p of ports) {
      if (p === this.port) continue;

      try {
        await fetch(`http://localhost:${p}/relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            from: this.id,
            content: JSON.stringify(msg)
          }),
          signal: AbortSignal.timeout(500)
        });
      } catch {
        // 节点不存在
      }
    }
  }

  getPeers(): string[] {
    return Array.from(this.connectedPeers);
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    await this.registry.unregisterNode(this.id);
  }
}

// 模拟 Harness 的同步消息
interface HarnessSyncMessage {
  gate: number;
  skills: string[];
  agents: string[];
  timestamp: number;
}

// ============================================================================
// 测试场景
// ============================================================================

async function runTest() {
  console.log('\n========================================');
  console.log('  P2P Two-Node Discovery & Harness Test');
  console.log('========================================\n');

  const registry = new NodeRegistry();
  await registry.init();

  // 清理旧数据
  try {
    await fs.unlink(NODES_FILE);
  } catch {}

  // 创建两个节点
  const node1 = new P2PNode('Alice-Node', 3001, registry);
  const node2 = new P2PNode('Bob-Node', 3002, registry);

  console.log('━━━ 步骤 1: 启动两个节点 ━━━\n');

  await node1.start();
  await node2.start();

  console.log('\n━━━ 步骤 2: 等待节点发现 (3秒) ━━━\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 列出发现的节点
  console.log('━━━ 步骤 3: 检查节点发现 ━━━\n');

  const node1Peers = node1.getPeers();
  const node2Peers = node2.getPeers();

  console.log(`[Alice] 发现 ${node1Peers.length} 个邻居: ${node1Peers.map(p => p.substring(0, 8)).join(', ') || '无'}`);
  console.log(`[Bob] 发现 ${node2Peers.length} 个邻居: ${node2Peers.map(p => p.substring(0, 8)).join(', ') || '无'}`);

  // 如果没有发现，尝试手动连接
  if (node1Peers.length === 0 && node2Peers.length === 0) {
    console.log('\n⚠️ 节点未自动发现，手动连接...\n');

    // 模拟手动连接
    node1.connectedPeers.add(node2.id);
    node2.connectedPeers.add(node1.id);

    console.log(`✓ [Alice] 手动连接到 Bob`);
    console.log(`✓ [Bob] 手动连接到 Alice`);
  }

  console.log('\n━━━ 步骤 4: 测试消息发送 ━━━\n');

  // 设置消息处理器
  node2.onMessage('ping', (msg, from) => {
    console.log(`[Bob] 收到来自 ${msg.from.substring(0, 8)}... 的消息: ${msg.content}`);
    // 回复 pong
    node2.sendMessage(msg.from, 'pong', 'Pong from Bob!');
  });

  node1.onMessage('pong', (msg, from) => {
    console.log(`[Alice] 收到回复: ${msg.content}`);
  });

  node1.onMessage('presence', (msg, from) => {
    const info = JSON.parse(msg.content);
    console.log(`[Alice] 发现新节点: ${info.name} on port ${info.port}`);
    node1.connectedPeers.add(msg.from);
  });

  node2.onMessage('presence', (msg, from) => {
    const info = JSON.parse(msg.content);
    console.log(`[Bob] 发现新节点: ${info.name} on port ${info.port}`);
    node2.connectedPeers.add(msg.from);
  });

  // Alice 发送 ping 给 Bob
  await node1.sendMessage(node2.id, 'ping', 'Hello Bob, this is Alice!');

  console.log('[Alice] 发送 ping 给 Bob...');

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('\n━━━ 步骤 5: 测试 Harness 同步 ━━━\n');

  // 模拟 Harness 同步消息
  const harnessSync: HarnessSyncMessage = {
    gate: 3,
    skills: ['arch', 'lead', 'harness-eng'],
    agents: [node1.id, node2.id],
    timestamp: Date.now()
  };

  console.log(`[Harness Sync] Gate: ${harnessSync.gate}`);
  console.log(`[Harness Sync] Skills: ${harnessSync.skills.join(', ')}`);
  console.log(`[Harness Sync] Agents: ${harnessSync.agents.map(a => a.substring(0, 8)).join(', ')}...`);

  // 设置 harness 消息处理器
  node1.onMessage('harness-sync', (msg, from) => {
    console.log(`\n[Alice] 收到 Harness 同步消息:`);
    const sync = JSON.parse(msg.content);
    console.log(`  Gate: ${sync.gate}`);
    console.log(`  Skills: ${sync.skills.join(', ')}`);
  });

  node2.onMessage('harness-sync', (msg, from) => {
    console.log(`\n[Bob] 收到 Harness 同步消息:`);
    const sync = JSON.parse(msg.content);
    console.log(`  Gate: ${sync.gate}`);
    console.log(`  Skills: ${sync.skills.join(', ')}`);
  });

  // 广播 Harness 同步消息
  await node1.broadcast('harness-sync', JSON.stringify(harnessSync));

  console.log('\n[Alice] 广播 Harness 同步消息到网络...\n');

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('\n━━━ 步骤 6: 最终状态检查 ━━━\n');

  const finalNode1Peers = node1.getPeers();
  const finalNode2Peers = node2.getPeers();

  console.log(`[Alice] 最终邻居数: ${finalNode1Peers.length}`);
  console.log(`[Bob] 最终邻居数: ${finalNode2Peers.length}`);

  // 获取节点健康信息
  try {
    const aliceHealth = await fetch('http://localhost:3001/health').then(r => r.json());
    const bobHealth = await fetch('http://localhost:3002/health').then(r => r.json());

    console.log('\n[Alice Health]');
    console.log(`  ID: ${aliceHealth.id.substring(0, 16)}...`);
    console.log(`  Peers: ${aliceHealth.peers.length}`);

    console.log('\n[Bob Health]');
    console.log(`  ID: ${bobHealth.id.substring(0, 16)}...`);
    console.log(`  Peers: ${bobHealth.peers.length}`);
  } catch (err) {
    console.log('Health check failed:', err);
  }

  // 清理
  console.log('\n━━━ 清理资源 ━━━\n');
  await node1.stop();
  await node2.stop();

  console.log('✓ 两个节点已停止');
  console.log('\n========================================');
  console.log('  测试完成');
  console.log('========================================\n');
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});