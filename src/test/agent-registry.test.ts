/**
 * agent-registry.test.ts — 2026-08-13 (Phase E1)
 *
 * Agent 服务注册表 (Agent Economic Network Discovery 层):
 *   - register 注册/更新服务 (本地双写)
 *   - list 列出全部
 *   - discover 按名称/能力/描述发现
 *   - warm 后 OrbitDB 写穿 (mock)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { OrbitDBAgentRegistry, resetAgentRegistry } from '../agents/agent-registry.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';
import type { AgentService } from '../agents/agent-registry.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-registry-' + Date.now());
const localFile = path.join(tmpRoot, 'agent-registry.json');

function makeFakeStore(): OrbitDBStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    address: '/orbitdb/zregistry',
    data,
    put: async (k, v) => { data.set(k, v); },
    add: async () => {},
    all: async () => Array.from(data.entries()).map(([key, value]) => ({ key, value })),
    get: async (k) => data.get(k) ?? null,
    onChange: () => () => {},
  };
}

function makeFakeDB(store: OrbitDBStore): CIDDatabase {
  return {
    save: async (d) => ({ id: 'cid', agentId: d.agentId, timestamp: 0, type: d.type, content: d.content, metadata: {}, version: 1 }),
    load: async () => null,
    update: async () => null,
    version: async () => [],
    list: async () => [],
    share: async (c) => `bolloon-cid://${c}`,
    openStore: async (name, type) => store,
    close: async () => {},
  };
}

const service: AgentService = {
  agentId: 'did:diap:research1',
  name: 'Research Agent',
  wallet: '0xabc123',
  service: { name: 'research', description: '资料检索与研究', price: { amount: '0.05', currency: 'USDC', per: 'query' } },
  capabilities: ['research', 'data'],
};

describe('agent-registry (Agent 服务注册表)', () => {
  beforeEach(async () => {
    resetAgentRegistry();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('register 注册服务 + list 列出 (本地 fallback)', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    const r = await reg.register(service);
    expect(r.ok).toBe(true);
    const list = await reg.list();
    expect(list.length).toBe(1);
    expect(list[0].agentId).toBe('did:diap:research1');
    expect(list[0].service.price.amount).toBe('0.05');
  });

  it('register 同 agentId 更新 (不重复)', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    await reg.register(service);
    await reg.register({ ...service, service: { ...service.service, price: { amount: '0.10', currency: 'USDC', per: 'query' } } });
    const list = await reg.list();
    expect(list.length).toBe(1);
    expect(list[0].service.price.amount).toBe('0.10');
  });

  it('discover 按名称/能力/描述过滤', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    await reg.register(service);
    await reg.register({ ...service, agentId: 'did:diap:code1', name: 'Coding Agent', service: { name: 'coding', description: '写代码', price: { amount: '0.20', currency: 'USDC', per: 'task' } }, capabilities: ['coding'] });
    const research = await reg.discover('research');
    expect(research.length).toBe(1);
    expect(research[0].agentId).toBe('did:diap:research1');
    const code = await reg.discover('写代码');
    expect(code.length).toBe(1);
    expect(code[0].agentId).toBe('did:diap:code1');
    const all = await reg.discover('');
    expect(all.length).toBe(2);
  });

  it('register 缺 agentId/service.name 返回错误', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    const r = await reg.register({} as any);
    expect(r.ok).toBe(false);
  });

  it('warm 后 OrbitDB 写穿 (读写走 orbit)', async () => {
    const fakeStore = makeFakeStore();
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(fakeStore), localFile);
    const ok = await reg.warm();
    expect(ok).toBe(true);
    expect(reg.ready).toBe(true);
    await reg.register(service);
    // orbit 里有数据
    const orbitData = fakeStore.data.get('services') as AgentService[];
    expect(orbitData.length).toBe(1);
    expect(reg.storeName).toContain('bolloon-agent-registry');
  });
});
