import { describe, it, expect } from 'vitest';
// 数字资源资产化 (Stage 1 轻版) 单测
import { registerResource, listResources, getResource, accessResource } from '../agents/resource-store.js';
import type { DigitalResource, ResourceServiceDeps } from '../agents/resource-store.js';

function mkDeps() {
  const map = new Map<string, string>();
  let n = 0;
  let list: DigitalResource[] = [];
  const cid = {
    save: async (c: string) => { const id = `cid-${++n}`; map.set(id, c); return id; },
    load: async (id: string) => map.get(id) ?? null,
  };
  const store = { get: () => list, set: (x: DigitalResource[]) => { list = x; } };
  const deps: ResourceServiceDeps = { cid, store };
  return { deps, map };
}

const base = (over: any = {}) => ({ ownerDid: 'did:leo', type: 'data', title: 't', content: 'hello', ...over });

describe('resource-store (数字资源 Stage 1)', () => {
  it('注册 data/art_product/product_image/tx_link 四类 + 内容寻址 CID', async () => {
    const { deps } = mkDeps();
    for (const type of ['data', 'art_product', 'product_image', 'tx_link'] as const) {
      const r = await registerResource(base({ type, title: type + '资源' }), deps);
      expect(r.ok).toBe(true);
      expect(r.resource!.contentCid).toMatch(/^cid-\d+$/);
      expect(r.resource!.type).toBe(type);
    }
    expect(listResources({}, deps).length).toBe(4);
  });

  it('discover 按 type/owner 过滤 + access 取回内容', async () => {
    const { deps } = mkDeps();
    await registerResource(base({ type: 'data', title: '数据集' }), deps);
    await registerResource(base({ type: 'art_product', title: '画作', content: 'AI 艺术数据' }), deps);
    expect(listResources({ type: 'art_product' }, deps).map((r) => r.title)).toEqual(['画作']);
    expect(listResources({ owner: 'did:leo' }, deps).length).toBe(2);
    const art = listResources({ type: 'art_product' }, deps)[0];
    const acc = await accessResource(art.resourceId, deps);
    expect(acc.ok).toBe(true);
    expect(acc.content).toBe('AI 艺术数据');
  });

  it('price 支持 USDC 默认 + 可选 token', async () => {
    const { deps } = mkDeps();
    const r = await registerResource(base({ price: { amount: '2', currency: 'token', token: 'BOLL' } }), deps);
    expect(r.resource!.price!.currency).toBe('token');
    expect(r.resource!.price!.token).toBe('BOLL');
    const r2 = await registerResource(base({ title: 'usdc', price: { amount: '0.5', currency: 'USDC' } }), deps);
    expect(r2.resource!.price!.currency).toBe('USDC');
  });

  it('chain=evm 预留 tokenURI 模板 (可升级 B)', async () => {
    const { deps } = mkDeps();
    const r = await registerResource(base({ chain: 'evm', tokenUriTemplate: 'ipfs://bafy/{id}' }), deps);
    expect(r.resource!.chain).toBe('evm');
    expect(r.resource!.tokenUriTemplate).toBe('ipfs://bafy/{id}');
    const r0 = await registerResource(base({ title: 'none' }), deps);
    expect(r0.resource!.chain).toBe('none');
    expect(r0.resource!.tokenUriTemplate).toBeUndefined();
  });

  it('非法 type / 缺必填 → 报错; getResource 命中/未命中', async () => {
    const { deps } = mkDeps();
    expect((await registerResource(base({ type: 'nope' as any }), deps)).ok).toBe(false);
    expect((await registerResource(base({ content: '' }), deps)).ok).toBe(false);
    await registerResource(base({ title: 'x' }), deps);
    expect((await getResource('res_0', deps)) === null).toBe(true);
  });
});
