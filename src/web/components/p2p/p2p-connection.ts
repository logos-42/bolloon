/**
 * P2P 连接管理
 */

import type { ConnectResult, ConnectProgress, ParsedInput, ConnectedPeer } from './types.js';
import { ConnectionStatus } from './types.js';
import { p2pStore } from './p2p-store-memory.js';

const CID_REGEX = /^Qm[a-zA-Z0-9]{44}$|^bafy[a-zA-Z0-9]{59}$|^bafk[a-zA-Z0-9]{59}$/;
const DID_REGEX = /^did:[a-z]+:[a-zA-Z0-9]+$/;

export class P2PConnectionManager {
  private peers: Map<string, ConnectedPeer> = new Map();
  private reconnectTimers: Map<string, number> = new Map();
  private connectionAttempts: Map<string, number> = new Map();

  // 解析输入
  parseInput(input: string): ParsedInput {
    const trimmed = input.trim();

    // URL scheme
    if (trimmed.startsWith('bolloon://connect')) {
      try {
        const url = new URL(trimmed);
        return {
          type: 'link',
          value: {
            did: url.searchParams.get('did'),
            cid: url.searchParams.get('cid')
          }
        };
      } catch {
        return { type: 'invalid', error: '无效的链接格式' };
      }
    }

    // 纯 CID
    if (CID_REGEX.test(trimmed)) {
      return { type: 'cid', value: trimmed };
    }

    // JSON DiapDoc
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.id || parsed.did) {
        return { type: 'diapDoc', value: parsed };
      }
    } catch {}

    return { type: 'invalid', error: '无法识别的格式' };
  }

  // 连接到节点
  async connect(
    input: string,
    onProgress?: (progress: ConnectProgress) => void
  ): Promise<ConnectResult> {
    const parsed = this.parseInput(input);
    if (parsed.type === 'invalid') {
      return { success: false, error: parsed.error };
    }

    onProgress?.({ stage: 'validating', percent: 10, message: '验证输入格式...' });

    let cid = '';
    if (parsed.type === 'link') {
      cid = parsed.value.cid;
    } else if (parsed.type === 'cid') {
      cid = parsed.value;
    } else if (parsed.type === 'diapDoc') {
      cid = parsed.value.cid || '';
    }

    if (!cid) {
      return { success: false, error: '未找到 CID' };
    }

    onProgress?.({ stage: 'ipfs_fetch', percent: 40, message: '从 IPFS 获取节点文档...' });

    try {
      const res = await fetch('/api/iroh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid })
      });

      const data = await res.json();

      if (res.ok) {
        onProgress?.({ stage: 'connecting', percent: 80, message: '建立 P2P 连接...' });

        // 保存到连接历史
        if (data.did) {
          await p2pStore.addToHistory({
            did: data.did,
            name: data.name || 'Unknown',
            cid: cid,
            irohNodeId: data.irohNodeId || '',
            lastConnectedAt: Date.now(),
            lastMessageAt: Date.now(),
            totalMessages: 0,
            isPinned: false,
            tags: []
          });
        }

        // 更新本地状态
        this.peers.set(data.irohNodeId, {
          nodeId: data.irohNodeId,
          status: ConnectionStatus.CONNECTED,
          info: data,
          lastSeen: Date.now()
        });

        onProgress?.({ stage: 'complete', percent: 100, message: '连接成功!' });

        return { success: true, ...data };
      } else {
        onProgress?.({ stage: 'error', percent: 0, message: data.error || '连接失败' });
        return { success: false, error: data.error };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  // 断开连接
  async disconnect(nodeId: string): Promise<void> {
    try {
      await fetch('/api/iroh/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId })
      });
    } catch {}

    this.peers.delete(nodeId);
    this.clearReconnectTimer(nodeId);
  }

  // 获取所有已连接节点
  getConnectedPeers(): ConnectedPeer[] {
    const connected: ConnectedPeer[] = [];
    this.peers.forEach((peer, nodeId) => {
      if (peer.status === ConnectionStatus.CONNECTED) {
        connected.push({ nodeId, ...peer });
      }
    });
    return connected;
  }

  // 获取节点数量
  getPeerCount(): number {
    return this.peers.size;
  }

  // 更新节点状态
  updatePeerStatus(nodeId: string, status: ConnectionStatus, info?: any): void {
    const peer = this.peers.get(nodeId) || { nodeId, status, info: {}, lastSeen: 0 };
    this.peers.set(nodeId, {
      ...peer,
      status,
      info: info || peer.info,
      lastSeen: Date.now()
    });
  }

  // 销毁
  destroy(): void {
    this.reconnectTimers.forEach((timerId) => clearTimeout(timerId));
    this.reconnectTimers.clear();
    this.peers.clear();
  }
}

export const p2pConnection = new P2PConnectionManager();