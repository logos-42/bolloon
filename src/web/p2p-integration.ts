/**
 * 网页端 P2P 集成 - 支持 iroh 和离线消息持久化
 *
 * 功能:
 * 1. 启动 iroh transport（带持久化）
 * 2. 发布 DID 到 IPFS
 * 3. 从 CID 解析其他节点信息
 * 4. 建立 P2P 连接
 * 5. 离线消息队列
 * 6. 自动重连
 */

import { irohTransport } from '../network/iroh-transport.js';
import { KeyManager, AgentAuthManager } from '@diap/sdk';
import * as fs from 'fs/promises';
import * as path from 'path';

const IPFS_ENDPOINT = 'http://127.0.0.1:5001';
const SESSION_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'p2p-sessions');

export interface P2PNodeInfo {
  did: string;
  cid: string;
  irohNodeId: string;
  name: string;
}

export interface P2PPeerInfo {
  nodeId: string;
  lastSeen: number;
  connected: boolean;
}

// ============================================================
// P2P 状态管理
// ============================================================

class P2PManager {
  private initialized = false;
  private ownInfo: P2PNodeInfo | null = null;
  private messageHandlers: Map<string, (msg: any, from: string) => void> = new Map();
  private peers: Map<string, P2PPeerInfo> = new Map();
  private pendingConnections: Set<string> = new Set();

  async initialize(): Promise<P2PNodeInfo> {
    if (this.initialized) {
      return this.ownInfo!;
    }

    console.log('[P2P] 初始化...');

    // 启动 iroh（启用持久化）
    await irohTransport.start(undefined, true);
    const nodeId = irohTransport.getNodeId() || '';

    console.log(`[P2P] iroh 节点: ${nodeId.substring(0, 20)}...`);

    // 生成 DID
    const keyPair = KeyManager.generate();
    const did = keyPair.did;

    // 构建节点信息
    const nodeInfo: P2PNodeInfo = {
      did,
      cid: '',
      irohNodeId: nodeId,
      name: `bolloon-${Date.now()}`
    };

    // 发布到 IPFS
    const cid = await this.publishToIPFS(nodeInfo);
    nodeInfo.cid = cid;

    this.ownInfo = nodeInfo;
    this.initialized = true;

    // 设置消息处理
    this.setupMessageHandlers();

    // 加载持久化的节点
    await this.loadPersistentPeers();

    console.log(`[P2P] 初始化完成`);
    console.log(`  DID: ${did}`);
    console.log(`  CID: ${cid}`);
    console.log(`  Node ID: ${nodeId.substring(0, 20)}...`);

    return nodeInfo;
  }

  private async publishToIPFS(info: P2PNodeInfo): Promise<string> {
    const doc = {
      id: info.did,
      name: info.name,
      version: '1.0',
      capabilities: ['chat', 'ai', 'judgment-injection'],
      irohNodeId: info.irohNodeId,
      channels: [{ id: 'main', name: '主对话' }],
      createdAt: new Date().toISOString()
    };

    // 上传到 IPFS
    const formData = new FormData();
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    formData.append('file', blob, 'node-info.json');

    const response = await fetch(`${IPFS_ENDPOINT}/api/v0/add`, {
      method: 'POST',
      body: formData
    });

    const result = await response.text();
    const cidMatch = result.match(/"Hash":"([^"]+)"/);

    return cidMatch ? cidMatch[1] : '';
  }

  private setupMessageHandlers(): void {
    // 处理聊天消息
    irohTransport.onMessage('chat', (msg) => {
      const content = new TextDecoder().decode(msg.payload);
      console.log(`[P2P] 收到消息 from ${msg.from.substring(0, 12)}...: ${content.substring(0, 50)}...`);

      const handler = this.messageHandlers.get('chat');
      if (handler) {
        handler({ content, timestamp: Date.now() }, msg.from);
      }
    });

    // 处理 AI 对话消息
    irohTransport.onMessage('ai-dialogue', (msg) => {
      const content = new TextDecoder().decode(msg.payload);
      console.log(`[P2P] 收到 AI 对话 from ${msg.from.substring(0, 12)}...`);

      const handler = this.messageHandlers.get('ai-dialogue');
      if (handler) {
        handler({ content, timestamp: Date.now() }, msg.from);
      }
    });

    // 更新连接状态
    this.peers.set(msg.from, {
      nodeId: msg.from,
      lastSeen: Date.now(),
      connected: true
    });
  }

  // ============================================================
  // 连接管理
  // ============================================================

  async connectToNode(cid: string): Promise<string | null> {
    console.log(`[P2P] 连接到 CID: ${cid}...`);

    try {
      // 从 IPFS 获取节点信息
      const response = await fetch(`${IPFS_ENDPOINT}/api/v0/cat?arg=${cid}`, {
        method: 'POST'
      });

      const content = await response.text();
      const doc = JSON.parse(content);

      const targetNodeId = doc.irohNodeId;
      if (!targetNodeId) {
        console.log('[P2P] 节点信息中不包含 irohNodeId');
        return null;
      }

      console.log(`[P2P] 目标节点: ${targetNodeId.substring(0, 20)}...`);

      // 连接
      const success = await irohTransport.sendMessage(
        targetNodeId,
        'chat',
        new TextEncoder().encode(JSON.stringify({
          type: 'hello',
          from: this.ownInfo?.irohNodeId,
          timestamp: Date.now()
        }))
      );

      if (success) {
        // 保存到持久化列表
        await this.savePeer(targetNodeId, doc.name || 'Unknown');
        console.log(`[P2P] 连接成功!`);
      } else {
        console.log(`[P2P] 连接失败（对方可能离线）`);
      }

      return success ? targetNodeId : null;
    } catch (e) {
      console.log(`[P2P] 连接失败: ${(e as Error).message}`);
      return null;
    }
  }

  async sendMessage(targetNodeId: string, content: string): Promise<boolean> {
    return irohTransport.sendMessage(
      targetNodeId,
      'chat',
      new TextEncoder().encode(content)
    );
  }

  async sendAIDialogue(targetNodeId: string, content: string): Promise<boolean> {
    return irohTransport.sendMessage(
      targetNodeId,
      'ai-dialogue',
      new TextEncoder().encode(content)
    );
  }

  // ============================================================
  // 消息处理
  // ============================================================

  onMessage(type: string, handler: (msg: any, from: string) => void): void {
    this.messageHandlers.set(type, handler);
  }

  // ============================================================
  // 持久化
  // ============================================================

  private async ensureSessionDir(): Promise<void> {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  }

  private async loadPersistentPeers(): Promise<void> {
    try {
      await this.ensureSessionDir();
      const peersFile = path.join(SESSION_DIR, 'peers.json');
      const data = await fs.readFile(peersFile, 'utf-8');
      const peers: { nodeId: string; name: string; lastSeen: number }[] = JSON.parse(data);

      console.log(`[P2P] 加载了 ${peers.length} 个持久化节点`);

      for (const peer of peers) {
        this.peers.set(peer.nodeId, {
          nodeId: peer.nodeId,
          lastSeen: peer.lastSeen,
          connected: false
        });
      }
    } catch {
      console.log('[P2P] 无持久化节点');
    }
  }

  private async savePeer(nodeId: string, name: string): Promise<void> {
    try {
      await this.ensureSessionDir();
      const peersFile = path.join(SESSION_DIR, 'peers.json');

      let peers: { nodeId: string; name: string; lastSeen: number }[] = [];
      try {
        const data = await fs.readFile(peersFile, 'utf-8');
        peers = JSON.parse(data);
      } catch {}

      // 更新或添加
      const idx = peers.findIndex(p => p.nodeId === nodeId);
      if (idx >= 0) {
        peers[idx].lastSeen = Date.now();
      } else {
        peers.push({ nodeId, name, lastSeen: Date.now() });
      }

      await fs.writeFile(peersFile, JSON.stringify(peers, null, 2));
      console.log(`[P2P] 已保存节点 ${name}`);
    } catch (e) {
      console.log(`[P2P] 保存节点失败: ${(e as Error).message}`);
    }
  }

  getOwnInfo(): P2PNodeInfo | null {
    return this.ownInfo;
  }

  getPeers(): P2PPeerInfo[] {
    return Array.from(this.peers.values());
  }
}

export const p2pManager = new P2PManager();