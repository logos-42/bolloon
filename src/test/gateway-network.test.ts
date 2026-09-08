import { describe, it, expect } from 'vitest';
// 网络启动包 / 画像 / merge — 纯函数单测 (入网链接 = 全量引导)
import { buildNetworkBootstrap, mergeRemoteServices, parseNetworkLink, shareNetworkLink } from '../agents/gateway-network.js';
import type { AgentService } from '../agents/agent-registry.js';

const svc = (agentId: string, name: string): AgentService => ({
  agentId, name, wallet: '0x0', service: { name, description: '', price: { amount: '0.1', currency: 'USDC', per: 'query' } },
});

describe('buildNetworkBootstrap (#1 启动包)', () => {
  it('从 meta 规整出完整启动包', () => {
    const b = buildNetworkBootstrap({ networkId: 'n-1', name: 'research-net', version: 'v2', capacityOfMembers: 12, sharedContextCid: 'Qmabc' });
    expect(b.networkId).toBe('n-1');
    expect(b.name).toBe('research-net');
    expect(b.version).toBe('v2');
    expect(b.capacityOfMembers).toBe(12);
    expect(b.sharedContextCid).toBe('Qmabc');
  });
  it('缺字段/垃圾输入 → 输出 undefined, 不抛', () => {
    const b = buildNetworkBootstrap({ networkId: '', capacityOfMembers: 'x', bogus: 1 });
    expect(b.networkId).toBeUndefined();
    expect(b.capacityOfMembers).toBeUndefined();
    const g = buildNetworkBootstrap(null);
    expect(g.networkId).toBeUndefined();
  });
});

describe('mergeRemoteServices (#2 on-join 合并)', () => {
  it('按 agentId+service.name 去重, 返回新增数', () => {
    const local = [svc('did:1', 'research')];
    const remote = [svc('did:1', 'research'), svc('did:2', 'coding'), { agentId: 'did:3' }];
    const { merged, joined } = mergeRemoteServices(remote, local);
    expect(joined).toBe(1);                 // 只有 did:2/coding 是新增
    expect(merged.length).toBe(2);          // did:1 research + did:2 coding
    expect(merged.map((s) => s.agentId)).toContain('did:2');
  });
  it('全已存在 → joined=0, 不重复', () => {
    const local = [svc('a', 'x')];
    const { merged, joined } = mergeRemoteServices([svc('a', 'x')], local);
    expect(joined).toBe(0);
    expect(merged.length).toBe(1);
  });
});

describe('parseNetworkLink (#0 链接解析)', () => {
  it('orbitdb:// 额外斜杠 + ?name=', () => {
    const p = parseNetworkLink('orbitdb:///orbitdb/Qmaddr?name=alpha');
    expect(p?.kind).toBe('orbitdb');
    expect(p?.address).toBe('/orbitdb/Qmaddr');
    expect(p?.networkName).toBe('alpha');
  });
  it('https://.../registry', () => {
    const p = parseNetworkLink('https://example.com/registry?name=beta');
    expect(p?.kind).toBe('http');
    expect(p?.url).toBe('https://example.com/registry');
  });
  it('垃圾 → null', () => {
    expect(parseNetworkLink('随便')).toBeNull();
  });
});

describe('shareNetworkLink (#1 全量启动包)', () => {
  it('写 meta 并生成 orbitdb://?name= 链接', async () => {
    let wrote: any = null;
    const fake: any = {
      ready: true,
      storeAddress: '/orbitdb/Qmaddr',
      storeName: 'bolloon-agent-registry-local',
      list: async () => [],
      register: async () => ({ ok: true }),
      discover: async () => [],
      loadLocal: async () => [],
      writeMeta: async (m: any) => { wrote = m; return { ok: true }; },
      readMeta: async () => null,
    };
    const r = await shareNetworkLink({
      name: 'my-net',
      meta: { networkId: 'n1', version: 'v3', capacityOfMembers: 4, sharedContextCid: 'Qmctx' },
      registry: fake,
    });
    expect(r.ok).toBe(true);
    expect(r.link).toContain('orbitdb:///orbitdb/Qmaddr');
    expect(r.link).toContain('?name=my-net');
    expect(wrote.networkId).toBe('n1');
    expect(wrote.capacityOfMembers).toBe(4);
    expect(wrote.sharedContextCid).toBe('Qmctx');
  });

  it('meta 写失败 → 仍分享并返回 note', async () => {
    const fake: any = {
      ready: true, storeAddress: '/orbitdb/QmB', storeName: 'n2',
      list: async () => [], register: async () => ({ ok: true }), discover: async () => [], loadLocal: async () => [],
      writeMeta: async () => ({ ok: false, error: 'read-only' }),
    };
    const r = await shareNetworkLink({ registry: fake });
    expect(r.ok).toBe(true);
    expect(r.link).toContain('?name=');
    expect(r.note).toContain('meta 写共享库失败');
  });
});
