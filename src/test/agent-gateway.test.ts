/**
 * agent-gateway.test.ts — 2026-08-14
 *
 * Agent Gateway 协调层 (经济路由器) + 网络加入:
 *   - parseNetworkLink / detectGatewayLink 链接解析与检测
 *   - gatewayRegisterAgent / gatewayCallAgent 协调层 (发现/预算/验证门)
 *   - joinNetwork 链接加入 (http mock) + 幂等 + 成员身份持久化
 *   - maybeAutoJoinGateway 消息自动加入 (入口要小)
 *   - shareNetworkLink 分享链接生成
 *   - restoreJoinedNetworks 重启恢复
 *
 * 隔离: HOME/USERPROFILE → tmp (gateway-networks.json / agent-registry.json 不落真实 home),
 *       registry 用 fake DB 注入 (不触发真实 OrbitDB 节点).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { OrbitDBAgentRegistry, resetAgentRegistry } from '../agents/agent-registry.js';
import { gatewayRegisterAgent, gatewayCallAgent, gatewayStatus } from '../agents/agent-gateway.js';
import {
  parseNetworkLink,
  detectGatewayLink,
  joinNetwork,
  maybeAutoJoinGateway,
  listJoinedNetworks,
  shareNetworkLink,
  restoreJoinedNetworks,
} from '../agents/gateway-network.js';
import { resetPaymentGate } from '../agents/payment-gate.js';
import { resetApprovalStore } from '../agents/payment-approval.js';
import { resetEconomicPolicy } from '../agents/economic-policy.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-gw-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');
const fakeRegFile = path.join(fakeHome, '.bolloon', 'agent-registry.json');
const fakeNetFile = path.join(fakeHome, '.bolloon', 'gateway-networks.json');

function makeFakeStore(address = '/orbitdb/ztest'): OrbitDBStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    address,
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
    openStoreByAddress: async () => null, // 单测不拉真实 OrbitDB
    close: async () => {},
  };
}

/** 创建 fake registry (OrbitDB warm 走注入的 fake store → ready=true) */
async function makeFakeRegistry(): Promise<OrbitDBAgentRegistry> {
  const reg = new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), fakeRegFile);
  await reg.warm();
  return reg;
}

/** 未 warm 的 registry (ready=false, 模拟离线模式) */
function makeOfflineRegistry(): OrbitDBAgentRegistry {
  return new OrbitDBAgentRegistry('did:test', makeFakeDB(makeFakeStore()), fakeRegFile);
}

async function readNetworksFile(): Promise<any[]> {
  try {
    return JSON.parse(await fs.readFile(fakeNetFile, 'utf-8'));
  } catch {
    return [];
  }
}

describe('agent-gateway (Agent Gateway 协调层)', () => {
  beforeEach(async () => {
    // 隔离 home: agent-registry 读 process.env.HOME, gateway-network 读 os.homedir() (USERPROFILE)
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}); // Windows 句柄锁可能残留
    await fs.mkdir(fakeHome, { recursive: true });
    resetAgentRegistry();
    resetPaymentGate();
    resetApprovalStore();
    resetEconomicPolicy();
  });

  afterEach(() => {
    (globalThis as any).fetch = undefined;
  });

  // ---------- 链接解析 ----------

  it('parseNetworkLink 解析三种链接 + name query', () => {
    expect(parseNetworkLink('ipns://k51qzi5abc')?.kind).toBe('ipns');
    const ob = parseNetworkLink('orbitdb:///orbitdb/zabc?name=my%20net');
    expect(ob?.kind).toBe('orbitdb');
    expect(ob?.address).toBe('/orbitdb/zabc');
    expect(ob?.networkName).toBe('my net'); // URLSearchParams 已 decode
    expect(parseNetworkLink('https://gw.example.com/registry')?.kind).toBe('http');
    expect(parseNetworkLink('bogus')).toBeNull();
    expect(parseNetworkLink('')).toBeNull();
  });

  it('detectGatewayLink 从消息文本找链接 (含中文标点边界)', () => {
    expect(detectGatewayLink('来我们网络: orbitdb:///orbitdb/zdpu123?name=research-net')).toBe('orbitdb:///orbitdb/zdpu123?name=research-net');
    expect(detectGatewayLink('加入 https://gw.example.com/registry 吧')).toBe('https://gw.example.com/registry');
    expect(detectGatewayLink('普通消息没有链接')).toBeNull();
    expect(detectGatewayLink('')).toBeNull();
  });

  // ---------- 协调层 ----------

  it('gatewayRegisterAgent 注册服务 (本地 registry)', async () => {
    const r = await gatewayRegisterAgent(
      { capability: 'research', price: '0.05', per: 'query' },
      { did: 'did:diap:gwa', name: 'GWA', wallet: '0xgw' },
      { registry: await makeFakeRegistry() },
    );
    expect(r.ok).toBe(true);
    const status = await gatewayStatus();
    expect(status).toContain('research');
  });

  it('gatewayCallAgent 无 provider → 错误', async () => {
    const r = await gatewayCallAgent({ task: 'x', budget: 1, capability: 'nonexistent-cap-xyz' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未找到');
  });

  it('gatewayCallAgent 价格超预算 → 拒绝', async () => {
    await gatewayRegisterAgent(
      { capability: 'coding', price: '5', per: 'task' },
      { did: 'did:diap:gwb', name: 'GWB', wallet: '0xgw' },
      { registry: await makeFakeRegistry() },
    );
    const r = await gatewayCallAgent({ task: 'code x', budget: 1, capability: 'coding' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('超预算');
  });

  // ---------- 网络加入 ----------

  it('joinNetwork http 拉取远端服务合并 + 幂等 + 持久化', async () => {
    const reg = await makeFakeRegistry();
    const remote = [{ agentId: 'did:diap:remote1', name: 'R1', wallet: '0xr1', service: { name: 'data', description: 'd', price: { amount: '0.03', currency: 'USDC', per: 'dataset' } }, capabilities: ['data'] }];
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ services: remote }) });

    const r = await joinNetwork('https://gw.example.com/registry', { registry: reg });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(1);
    expect(r.joined).toBe(1);

    // 本地 registry 已有远端服务
    const status = await gatewayStatus();
    expect(status).toContain('data');

    // 幂等: 再次加入 → already
    const r2 = await joinNetwork('https://gw.example.com/registry', { registry: reg });
    expect(r2.ok).toBe(true);
    expect(r2.already).toBe(true);

    // 持久化: gateway-networks.json 有记录
    const nets = await readNetworksFile();
    expect(nets.length).toBe(1);
    expect(nets[0].link).toBe('https://gw.example.com/registry');
    expect(nets[0].kind).toBe('http');
    expect(nets[0].serviceCount).toBe(1);
  });

  it('joinNetwork 无效链接 → 错误', async () => {
    const r = await joinNetwork('bogus', { registry: await makeFakeRegistry() });
    expect(r.ok).toBe(false);
  });

  it('joinNetwork 远端不可达 → 错误且不记录成员', async () => {
    const reg = await makeFakeRegistry();
    (globalThis as any).fetch = async () => ({ ok: false });
    const r = await joinNetwork('https://gw.example.com/registry', { registry: reg });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无服务或不可达');
    expect((await readNetworksFile()).length).toBe(0);
  });

  // ---------- 自动加入 (入口要小) ----------

  it('maybeAutoJoinGateway 无链接 → null 静默', async () => {
    expect(await maybeAutoJoinGateway('你好，今天天气不错', { registry: await makeFakeRegistry() })).toBeNull();
  });

  it('maybeAutoJoinGateway 消息带链接 → 自动加入 + 通知', async () => {
    const reg = await makeFakeRegistry();
    const remote = [{ agentId: 'did:diap:auto1', name: 'A1', wallet: '0xa1', service: { name: 'research', description: 'r', price: { amount: '0.05', currency: 'USDC', per: 'query' } }, capabilities: ['research'] }];
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ services: remote }) });

    const note = await maybeAutoJoinGateway('来我们网络: https://gw.example.com/registry?name=research-net', { registry: reg });
    expect(note).toContain('已自动加入');
    expect(note).toContain('research-net');
    expect((await readNetworksFile()).length).toBe(1);

    // 已在网络 → 静默
    expect(await maybeAutoJoinGateway('https://gw.example.com/registry', { registry: reg })).toBeNull();
  });

  // ---------- 分享链接 ----------

  it('shareNetworkLink registry 就绪 → 生成 orbitdb 链接', async () => {
    const reg = await makeFakeRegistry(); // fake store address = /orbitdb/ztest
    const r = await shareNetworkLink({ name: 'bolloon-home', registry: reg });
    expect(r.ok).toBe(true);
    expect(r.link).toBe('orbitdb:///orbitdb/ztest?name=bolloon-home');
    // 链接可被 parseNetworkLink 回解析
    const parsed = parseNetworkLink(r.link!);
    expect(parsed?.kind).toBe('orbitdb');
    expect(parsed?.address).toBe('/orbitdb/ztest');
  });

  it('shareNetworkLink registry 未就绪 → 错误 (离线模式)', async () => {
    const r = await shareNetworkLink({ registry: makeOfflineRegistry() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未就绪');
  });

  // ---------- 重启恢复 ----------

  it('restoreJoinedNetworks 重启后恢复已加入网络', async () => {
    const reg = await makeFakeRegistry();
    const remote = [{ agentId: 'did:diap:restore1', name: 'R1', wallet: '0xr1', service: { name: 'data', description: 'd', price: { amount: '0.03', currency: 'USDC', per: 'dataset' } }, capabilities: ['data'] }];
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ services: remote }) });

    // 第一次加入
    await joinNetwork('https://gw.example.com/registry', { registry: reg });
    expect((await readNetworksFile()).length).toBe(1);

    // "重启": 换新 registry 实例 + 重新恢复
    const reg2 = await makeFakeRegistry();
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ services: remote }) });
    const r = await restoreJoinedNetworks();
    expect(r.total).toBe(1);
    expect(r.restored).toBe(1);
    expect(r.failed).toBe(0);

    // 恢复后 registry 有网络服务
    const services = await reg2.list();
    expect(services.some((s) => s.agentId === 'did:diap:restore1')).toBe(true);
  });

  it('listJoinedNetworks 列出成员', async () => {
    const reg = await makeFakeRegistry();
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ services: [{ agentId: 'did:diap:x1', name: 'X', wallet: '0x', service: { name: 's', description: 'd', price: { amount: '1', currency: 'USDC', per: 'q' } } }] }) });
    await joinNetwork('https://gw.example.com/registry', { registry: reg });
    const nets = await listJoinedNetworks();
    expect(nets.length).toBe(1);
    expect(nets[0].kind).toBe('http');
  });
});
