/**
 * P2P 身份管理
 */

import type { P2PIdentity } from './types.js';
import { p2pStore } from './p2p-store-memory.js';

export class P2PIdentityManager {
  private identity: P2PIdentity | null = null;
  private initialized: boolean = false;

  // 初始化身份
  async init(): Promise<P2PIdentity> {
    if (this.initialized && this.identity) {
      return this.identity;
    }

    try {
      const res = await fetch('/api/iroh/init', { method: 'POST' });
      const data = await res.json();

      if (res.ok) {
        this.identity = {
          did: data.did,
          cid: data.cid,
          irohNodeId: data.irohNodeId,
          name: data.name || `bolloon-${Date.now()}`
        };
        this.initialized = true;

        // 保存到历史
        await p2pStore.addToHistory({
          did: this.identity.did,
          name: '我的设备',
          cid: this.identity.cid,
          irohNodeId: this.identity.irohNodeId,
          lastConnectedAt: Date.now(),
          lastMessageAt: 0,
          totalMessages: 0,
          isPinned: true,
          tags: ['self']
        });

        console.log('[P2P Identity] 初始化成功:', this.identity.did?.substring(0, 20));
      }

      return this.identity!;
    } catch (e) {
      console.error('[P2P Identity] 初始化失败:', e);
      throw e;
    }
  }

  // 获取身份
  get(): P2PIdentity | null {
    return this.identity;
  }

  // 是否已初始化
  isInitialized(): boolean {
    return this.initialized;
  }

  // 生成分享链接
  generateShareLink(): string | null {
    if (!this.identity?.cid || !this.identity?.did) {
      return null;
    }
    return `bolloon://connect?did=${encodeURIComponent(this.identity.did)}&cid=${encodeURIComponent(this.identity.cid)}`;
  }

  // 导出身份文件
  exportIdentityFile(): void {
    if (!this.identity) return;

    const data = JSON.stringify({
      did: this.identity.did,
      cid: this.identity.cid,
      irohNodeId: this.identity.irohNodeId
    }, null, 2);

    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bolloon-identity.json';
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const p2pIdentity = new P2PIdentityManager();