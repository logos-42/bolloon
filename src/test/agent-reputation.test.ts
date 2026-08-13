/**
 * agent-reputation.test.ts — 2026-08-13 (Phase M4)
 *
 * Agent 信誉系统 (Agent Economic Protocol §7):
 *   - recordServiceOutcome 记录结果并更新 score
 *   - queryReputation 查询
 *   - score = success/tasks
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { OrbitDBAgentRegistry, resetAgentRegistry } from '../agents/agent-registry.js';
import { recordServiceOutcome, queryReputation } from '../agents/agent-reputation.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-rep-' + Date.now());
const localFile = path.join(tmpRoot, 'agent-registry.json');

function makeFakeStore(): OrbitDBStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    address: '/orbitdb/zrep',
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

let seededReg: OrbitDBAgentRegistry;

async function seedRegistry(): Promise<OrbitDBAgentRegistry> {
  const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
  await reg.register({
    agentId: 'did:diap:svc1', name: 'Service1', wallet: '0xsvc1',
    service: { name: 'research', description: 'd', price: { amount: '0.05', currency: 'USDC', per: 'query' } },
  } as any);
  return reg;
}

describe('agent-reputation (信誉系统)', () => {
  beforeEach(async () => {
    resetAgentRegistry();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    seededReg = await seedRegistry();
  });

  it('recordServiceOutcome success 更新信誉', async () => {
    const r = await recordServiceOutcome('did:diap:svc1', 'research', 'success', seededReg);
    expect(r.ok).toBe(true);
    expect(r.reputation?.tasks).toBe(1);
    expect(r.reputation?.success).toBe(1);
    expect(r.reputation?.score).toBe(1);
  });

  it('多次结果 score = success/tasks', async () => {
    await recordServiceOutcome('did:diap:svc1', 'research', 'success', seededReg);
    await recordServiceOutcome('did:diap:svc1', 'research', 'success', seededReg);
    await recordServiceOutcome('did:diap:svc1', 'research', 'failed', seededReg);
    const q = await queryReputation('did:diap:svc1', 'research', seededReg);
    expect(q.ok).toBe(true);
    const rep = q.entries[0].reputation;
    expect(rep.tasks).toBe(3);
    expect(rep.success).toBe(2);
    expect(rep.failed).toBe(1);
    expect(rep.score).toBeCloseTo(2 / 3, 2);
  });

  it('disputed 计入但不影响 success 比例', async () => {
    await recordServiceOutcome('did:diap:svc1', 'research', 'success', seededReg);
    await recordServiceOutcome('did:diap:svc1', 'research', 'disputed', seededReg);
    const q = await queryReputation('did:diap:svc1', 'research', seededReg);
    expect(q.entries[0].reputation.tasks).toBe(2);
    expect(q.entries[0].reputation.disputed).toBe(1);
    expect(q.entries[0].reputation.score).toBe(0.5);
  });

  it('未注册服务返回错误', async () => {
    const r = await recordServiceOutcome('did:none', 'x', 'success', seededReg);
    expect(r.ok).toBe(false);
  });

  it('queryReputation 无记录返回 ok=false', async () => {
    const q = await queryReputation('did:ghost', undefined, seededReg);
    expect(q.ok).toBe(false);
  });
});
