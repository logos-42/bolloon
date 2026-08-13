/**
 * agent-service-client.test.ts — 2026-08-13 (Phase E2)
 *
 * Agent 服务调用闭环 (x402 402 自动支付):
 *   - serviceCall 从 Registry 发现服务 → 调端点 (mock fetch) → 402 → 支付 → 结果
 *   - serviceRequestPayment 基于 Registry 价格生成支付意图
 *   - buildPaymentRequiredResponse 生成 402 响应
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { OrbitDBAgentRegistry, resetAgentRegistry } from '../agents/agent-registry.js';
import { serviceCall, serviceRequestPayment, buildPaymentRequiredResponse } from '../agents/agent-service-client.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';
import type { AgentService } from '../agents/agent-registry.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-svc-' + Date.now());
const localFile = path.join(tmpRoot, 'agent-registry.json');

function makeFakeStore(): OrbitDBStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    address: '/orbitdb/zsvc',
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

describe('agent-service-client (x402 支付闭环)', () => {
  beforeEach(async () => {
    resetAgentRegistry();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('serviceRequestPayment 基于 Registry 价格返回支付意图', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    await reg.register({
      agentId: 'did:diap:r1', name: 'R', wallet: '0xpay1',
      service: { name: 'research', description: 'd', price: { amount: '0.05', currency: 'USDC', per: 'query' } },
    } as AgentService);
    const info = await serviceRequestPayment('did:diap:r1', 'research', reg) as any;
    expect(info.price).toBe(0.05);
    expect(info.currency).toBe('USDC');
    expect(info.payTo).toBe('0xpay1');
  });

  it('serviceRequestPayment 未注册返回错误', async () => {
    const emptyReg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    const info = await serviceRequestPayment('did:none', 'x', emptyReg) as any;
    expect(info.error).toBeTruthy();
  });

  it('buildPaymentRequiredResponse 生成 402 响应 (价格头)', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    await reg.register({
      agentId: 'did:diap:r1', name: 'R', wallet: '0xpay1',
      service: { name: 'coding', description: 'd', price: { amount: '0.20', currency: 'USDC', per: 'task' } },
    } as AgentService);
    const resp = await buildPaymentRequiredResponse('did:diap:r1', 'coding', reg);
    expect(resp.status).toBe(402);
    expect(resp.headers['X-Payment-Amount']).toBe('0.2'); // parseFloat 后 0.20 → 0.2
    expect(resp.headers['X-Pay-To']).toBe('0xpay1');
    expect(resp.body).toContain('Payment Required');
  });

  it('serviceCall 服务无端点返回错误', async () => {
    const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    await reg.register({
      agentId: 'did:diap:r1', name: 'R', wallet: '0xpay1',
      service: { name: 'research', description: 'd', price: { amount: '0.05', currency: 'USDC', per: 'query' } },
    } as AgentService);
    const r = await serviceCall({ serviceName: 'research', url: 'https://example.invalid/svc', registry: reg });
    // 无 privateKey → x402Fetch 首请求 402 或网络错误 → 返回失败但 service 找到
    expect(r.service?.agentId).toBe('did:diap:r1');
    expect(r.success).toBe(false);
  });

  it('serviceCall 未找到服务返回错误', async () => {
    const emptyReg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), localFile);
    const r = await serviceCall({ serviceName: 'nonexistent', registry: emptyReg });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未找到');
  });
});

