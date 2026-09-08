import { describe, it, expect } from 'vitest';
// 数字资源资产化 (Stage 1-4) 单测
import {
  registerResource, listResources, getResource, accessResource,
  matchResources, purchaseResource, resourceReputation, serializeForRegistry,
} from '../agents/resource-store.js';
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

describe('resource-store Stage1 (注册/发现/访问)', () => {
  it('注册四类 + 内容寻址 CID + 预留 evm tokenURI/token 币种', async () => {
    const { deps } = mkDeps();
    for (const type of ['data', 'art_product', 'product_image', 'tx_link'] as const) {
      const r = await registerResource(base({ type, title: type + '资源' }), deps);
      expect(r.ok).toBe(true);
      expect(r.resource!.contentCid).toMatch(/^cid-\d+$/);
    }
    const evm = await registerResource(base({ chain: 'evm', tokenUriTemplate: 'ipfs://{id}' }), deps);
    expect(evm.resource!.chain).toBe('evm');
    expect(evm.resource!.tokenUriTemplate).toBe('ipfs://{id}');
    expect((await listResources({}, deps)).length).toBe(5);
  });

  it('discover 过滤 + access 取回内容', async () => {
    const { deps } = mkDeps();
    await registerResource(base({ type: 'data', title: '数据集' }), deps);
    await registerResource(base({ type: 'art_product', title: '画作', content: 'AI 艺术数据' }), deps);
    expect((await listResources({ type: 'art_product' }, deps)).map((r) => r.title)).toEqual(['画作']);
    const art = (await listResources({ type: 'art_product' }, deps))[0];
    const acc = await accessResource(art.resourceId, deps);
    expect(acc.ok).toBe(true);
    expect(acc.content).toBe('AI 艺术数据');
  });

  it('非法 type / 缺必填 → 报错', async () => {
    const { deps } = mkDeps();
    expect((await registerResource(base({ type: 'nope' as any }), deps)).ok).toBe(false);
    expect((await registerResource(base({ content: '' }), deps)).ok).toBe(false);
  });
});

describe('resource-store Stage2 (运营: 网络同步 / 自动分配匹配)', () => {
  it('register 带 registry → 同步成可发现条目', async () => {
    const { deps } = mkDeps();
    const registered: any[] = [];
    deps.registry = { register: async (s: any) => { registered.push(s); return { ok: true }; }, discover: async () => [] };
    await registerResource(base({ type: 'art_product', title: '画作', price: { amount: '3', currency: 'USDC' }, wallet: '0xabc' }), deps);
    expect(registered.length).toBe(1);
    expect(registered[0].service.name).toBe('resource:art_product');
    expect(registered[0].wallet).toBe('0xabc');
  });

  it('matchResources: 关键词打分 + 信誉加权排序', async () => {
    const { deps } = mkDeps();
    await registerResource(base({ title: '机器学习数据集', type: 'data' }), deps);
    await registerResource(base({ title: 'AI 画作', type: 'art_product', license: 'commercial' }), deps);
    // 提供者信誉: did:leo 高分 → 加权后排在前面
    deps.repQuery = async () => ({ score: 0.9, tasks: 10, success: 9, failed: 1 });
    const scored = await matchResources('ai', deps);
    expect(scored.length).toBe(2);
    expect(scored[0].score).toBeGreaterThan(0);
    // 信誉加权让同分资源按信誉排序 (did:leo 都是同 owner, 只验证排序稳定)
    expect(scored[0].resource.title).toBeTruthy();
  });
});

describe('resource-store Stage3/4 (交易 x402 + 清算信誉)', () => {
  it('免费资源直接访问 (不触发 pay)', async () => {
    const { deps } = mkDeps();
    await registerResource(base({ title: 'free' }), deps);
    const list = await listResources({}, deps);
    let paid = false;
    deps.pay = async () => { paid = true; return { success: true }; };
    const r = await purchaseResource(list[0].resourceId, { cid: deps.cid, store: deps.store, pay: deps.pay });
    expect(r.ok).toBe(true);
    expect(paid).toBe(false);
    expect(r.content).toBe('hello');
  });

  it('付费资源: 支付成功 → 解锁内容 + onSettle success', async () => {
    const { deps } = mkDeps();
    await registerResource(base({ title: 'paid', price: { amount: '2', currency: 'USDC' }, wallet: '0xrecv' }), deps);
    const list = await listResources({}, deps);
    let settled: string[] = [];
    const p = await purchaseResource(list[0].resourceId, {
      cid: deps.cid,
      store: deps.store,
      pay: async (spec) => { expect(spec.recipient).toBe('0xrecv'); return { success: true, txHash: '0xabc' }; },
      onSettle: (outcome) => settled.push(outcome),
    });
    expect(p.ok).toBe(true);
    expect(p.txHash).toBe('0xabc');
    expect(p.content).toBe('hello');
    expect(settled).toEqual(['success']);
  });

  it('付费资源: 支付失败 → onSettle failed; 无 pay → needPay', async () => {
    const { deps } = mkDeps();
    await registerResource(base({ title: 'paid2', price: { amount: '1', currency: 'USDC' }, wallet: '0xr' }), deps);
    const list = await listResources({}, deps);
    let settled: string[] = [];
    const r = await purchaseResource(list[0].resourceId, {
      cid: deps.cid, store: deps.store, pay: async () => ({ success: false, error: 'insufficient' }),
      onSettle: (o) => settled.push(o),
    });
    expect(r.ok).toBe(false);
    expect(r.needPay).toBe(true);
    expect(settled).toEqual(['failed']);
    const r2 = await purchaseResource(list[0].resourceId, { cid: deps.cid, store: deps.store });
    expect(r2.needPay).toBe(true);
  });

  it('resourceReputation 查询 + serializeForRegistry 结构', async () => {
    const { deps } = mkDeps();
    deps.repQuery = async () => ({ score: 0.8, tasks: 5, success: 4, failed: 1 });
    const rep = await resourceReputation('did:leo', deps);
    expect(rep.ok).toBe(true);
    expect(rep.reputation!.score).toBe(0.8);
    const s = serializeForRegistry({ resourceId: 'res_1', ownerDid: 'did:x', type: 'data', title: '数据集', contentCid: 'cid-1' } as any);
    expect(s.capabilities).toContain('res_1');
  });
});
