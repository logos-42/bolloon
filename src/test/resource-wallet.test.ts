import { describe, it, expect } from 'vitest';
// 资源级 x402 钱包自动配置
import { loadOrCreateWallet, walletAddress } from '../agents/resource-wallet.js';

describe('resource-wallet (x402 钱包自动配置)', () => {
  it('首次自动生成 + 持久化 (0x 地址/私钥)', async () => {
    let stored: string | null = null;
    let wrote = 0;
    const w = await loadOrCreateWallet({ read: async () => stored, write: async (p) => { stored = p; wrote++; } });
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(stored).not.toBeNull();
    expect(wrote).toBe(1);
  });

  it('幂等: 已有钱包复用, 不重建/不重写', async () => {
    const stored = JSON.stringify({ privateKey: '0x' + 'a'.repeat(64), address: '0x' + 'b'.repeat(40) });
    const w = await loadOrCreateWallet({ read: async () => stored, write: async () => { throw new Error('should not write'); } });
    expect(w.address).toBe('0x' + 'b'.repeat(40));
    expect(w.privateKey).toBe('0x' + 'a'.repeat(64));
  });

  it('数据损坏 → 重建新钱包', async () => {
    let stored = 'not-json';
    const w = await loadOrCreateWallet({ read: async () => stored, write: async (p) => { stored = p; } });
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(stored).not.toBe('not-json');
  });

  it('walletAddress 便捷取地址', async () => {
    const a = await walletAddress({
      read: async () => JSON.stringify({ privateKey: '0x' + 'c'.repeat(64), address: '0x' + 'd'.repeat(40) }),
      write: async () => {},
    });
    expect(a).toBe('0x' + 'd'.repeat(40));
  });
});
