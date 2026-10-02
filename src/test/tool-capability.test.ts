/**
 * Tool Capability 层 (K1 ④) ★真跑: 真能加载领域模块, 且"走了哪一路"可观测。
 * 只证明这一层通; 各工具的**业务**行为由既有 wallet/polymarket 验证用例覆盖。
 */
import { describe, it, expect } from 'vitest';
import { DOMAIN_TARGETS, loadDomainModule, getLastLoadSource } from '../agents/tool-capability/index.js';

describe('K1 ④: Tool Capability 层', () => {
  it('① 目标清单是单一事实源 (6 项, 无重复)', () => {
    expect(DOMAIN_TARGETS).toHaveLength(6);
    expect(new Set(DOMAIN_TARGETS).size).toBe(6);
  });

  it('② 未登记的目标 ⇒ 抛错 (不做静默降级)', async () => {
    await expect(loadDomainModule('Foo/bar' as never)).rejects.toThrow(/未登记的领域目标/);
  });

  it('③ ★真跑: 真能加载 listMarkets, 并记下走的是哪一路', async () => {
    const mod: Record<string, unknown> = await loadDomainModule('PolymarketSDK/listMarkets');
    const fn = (mod.listMarkets ?? mod.default) as unknown;
    expect(typeof fn).toBe('function');
    const rec = getLastLoadSource();
    expect(rec).not.toBeNull();
    expect(rec!.target).toBe('PolymarketSDK/listMarkets');
    expect(['dist', 'src']).toContain(rec!.source);
  });

  it('④ ★真跑: 6 个目标都能加载 (dist 或 src 任一路通即可)', async () => {
    for (const target of DOMAIN_TARGETS) {
      const mod: Record<string, unknown> = await loadDomainModule(target);
      expect(mod).toBeTruthy();
    }
  });
});
