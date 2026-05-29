/**
 * P2P 连接管理
 */

import type {
  ConnectResult,
  ConnectProgress,
  ParsedInput,
  ConnectedPeer,
  PersistentConnection,
  CIDResolveResult,
  PersistentConnectionStatus
} from './types.js';
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
            did: url.searchParams.get('did') ?? undefined,
            cid: url.searchParams.get('cid') ?? undefined
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
    const value = parsed.value;
    if (parsed.type === 'link' && typeof value !== 'string') {
      cid = (value as { did?: string; cid?: string }).cid || '';
    } else if (parsed.type === 'cid' && typeof value === 'string') {
      cid = value;
    } else if (parsed.type === 'diapDoc' && typeof value !== 'string') {
      cid = (value as { id?: string; did?: string; cid?: string }).cid || '';
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
    this.peers.forEach((peer, peerNodeId) => {
      if (peer.status === ConnectionStatus.CONNECTED) {
        connected.push({ nodeId: peerNodeId, status: peer.status, info: peer.info, lastSeen: peer.lastSeen });
      }
    });
    return connected;
  }

  // 清除重连定时器
  private clearReconnectTimer(nodeId: string): void {
    const timerId = this.reconnectTimers.get(nodeId);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      this.reconnectTimers.delete(nodeId);
    }
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

  // 从 CID 解析身份
  async resolveFromCID(cid: string): Promise<CIDResolveResult> {
    try {
      const res = await fetch('/api/p2p/resolve-cid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid })
      });

      if (res.ok) {
        const data = await res.json();
        return {
          success: true,
          did: data.doc?.id || data.doc?.did,
          cid: cid,
          name: data.doc?.name,
          peerId: data.doc?.peerId
        };
      } else {
        return { success: false, error: 'CID 解析失败' };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  // 获取所有持久连接
  async getPersistentConnections(): Promise<PersistentConnection[]> {
    try {
      const res = await fetch('/api/p2p/persistent-connections');
      if (res.ok) {
        return await res.json();
      }
      return [];
    } catch {
      return [];
    }
  }

  // 切换连接状态
  async toggleConnection(connection: PersistentConnection, enable: boolean): Promise<boolean> {
    try {
      if (enable) {
        // 建立连接
        const result = await this.connect(connection.cid);
        if (result.success) {
          await fetch('/api/p2p/connection-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: connection.id,
              status: 'connected',
              channelId: connection.channelId
            })
          });
          return true;
        }
        return false;
      } else {
        // 断开连接
        if (connection.peerId) {
          await this.disconnect(connection.peerId);
        }
        await fetch('/api/p2p/connection-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: connection.id,
            status: 'disconnected'
          })
        });
        return true;
      }
    } catch {
      return false;
    }
  }

  // 连接并创建对话通道
  async connectAndCreateChannel(
    input: string,
    onProgress?: (progress: ConnectProgress) => void
  ): Promise<ConnectResult> {
    const parsed = this.parseInput(input);
    if (parsed.type === 'invalid') {
      return { success: false, error: parsed.error };
    }

    onProgress?.({ stage: 'validating', percent: 10, message: '验证输入格式...' });

    let cid = '';
    let did = '';
    const value = parsed.value;

    if (parsed.type === 'link' && typeof value !== 'string') {
      cid = (value as { did?: string; cid?: string }).cid || '';
      did = (value as { did?: string; cid?: string }).did || '';
    } else if (parsed.type === 'cid' && typeof value === 'string') {
      cid = value;
    } else if (parsed.type === 'diapDoc' && typeof value !== 'string') {
      cid = (value as { id?: string; did?: string; cid?: string }).cid || '';
      did = (value as { id?: string; did?: string }).id || (value as { id?: string; did?: string }).did || '';
    }

    if (!cid) {
      return { success: false, error: '未找到 CID' };
    }

    // 如果没有 DID，从 CID 解析
    if (!did) {
      onProgress?.({ stage: 'resolving', percent: 30, message: '从 IPFS 解析身份...' });
      const resolveResult = await this.resolveFromCID(cid);
      if (resolveResult.success) {
        did = resolveResult.did || '';
        onProgress?.({ stage: 'identity_resolved', percent: 50, message: `身份解析完成: ${resolveResult.name}` });
      }
    }

    // 创建对话通道
    onProgress?.({ stage: 'creating_channel', percent: 60, message: '创建对话通道...' });
    try {
      const channelRes = await fetch('/api/p2p/create-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerDid: did,
          peerName: did.substring(0, 16),
          cid: cid,
          peerId: ''
        })
      });

      if (!channelRes.ok) {
        return { success: false, error: '创建对话通道失败' };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }

    // 执行连接
    onProgress?.({ stage: 'connecting', percent: 80, message: '建立 P2P 连接...' });
    return this.connect(input, onProgress);
  }
}

export const p2pConnection = new P2PConnectionManager();