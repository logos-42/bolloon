/**
 * chain-index-route.test.ts — 网页只读路由 (P5, ③) 的挂载/返回冒烟测试
 * =========================================================================
 * 为什么要有: 交付物里明确要求"网页读取接口写成独立模块 + 路由导出函数, 不许碰 server.ts"。
 * 独立模块必须**能挂上、能返回真数据、非法输入要报 400**, 所以这里用一个假 express app
 * 把 registerChainIndexRoutes 真正注册一遍, 然后按 express 的调用约定直接调 handler。
 *
 * 覆盖:
 *   · 4 条只读路由都注册了 (/status /stats /timeline /events) 且路径带 basePath
 *   · timeline: 合法 taskKey 返回时间线; 非法 taskKey → 400
 *   · events: cursor 解析 (含非法 → 400 / limit 非法 → 400 / 无 cursor = 从头)
 *   · status/stats: 返回索引高度、最后同步时间、计数
 *   · POST /sync 默认**不注册** (只读默认只读); allowSync=true 且注入 sync 时才注册并转发 fromBlock
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChainIndexer, INDEX_IFACE, chainIndexPath, type IndexRpcProvider } from '../agents/chain/chain-indexer.js';
import { registerChainIndexRoutes } from '../web/routes-chain-index.js';

const ESCROW = '0x162A433068F51e18b7d13932F27e66a3f99E6890';
const TASK = '0x' + 'aa'.repeat(32);

/** 假 express app: 记下 (method, path) → handler */
function fakeApp() {
  const routes = new Map<string, Function>();
  const app: any = {
    get: (p: string, h: Function) => routes.set(`GET ${p}`, h),
    post: (p: string, h: Function) => routes.set(`POST ${p}`, h),
  };
  const call = async (method: 'GET' | 'POST', p: string, req: any = {}) => {
    const h = routes.get(`${method} ${p}`);
    if (!h) throw new Error(`路由没注册: ${method} ${p}`);
    let code = 200;
    let body: any = null;
    const res: any = {
      status(c: number) { code = c; return this; },
      json(b: any) { body = b; return this; },
    };
    await h(req, res);
    return { code, body };
  };
  return { app, routes, call };
}

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-index-route-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const hashOf = (n: number) => '0x' + (7_000_000 + n).toString(16).padStart(64, '0');

async function seedIndex(): Promise<void> {
  const blocks = Array.from({ length: 31 }, (_, n) => ({ number: n, hash: hashOf(n), parentHash: n === 0 ? '0x' + '0'.repeat(64) : hashOf(n - 1) }));
  const logs: any[] = [];
  const ev = (name: string, args: any[], blockNumber: number, logIndex = 0) => {
    const frag = INDEX_IFACE.getEvent(name)!;
    const { topics, data } = INDEX_IFACE.encodeEventLog(frag, args);
    logs.push({
      address: ESCROW, topics: [...topics], data, blockNumber, index: logIndex,
      transactionHash: '0x' + `${logs.length + 1}`.padStart(2, '0').repeat(32).slice(0, 64),
      transactionIndex: 0, blockHash: hashOf(blockNumber), removed: false,
    });
  };
  ev('EscrowCreatedV2', [TASK, '0x' + '33'.repeat(32), '0x' + 'b0'.repeat(20), '0x' + 'a0'.repeat(20), '0x' + '55'.repeat(20), 100_000_000n, 9n, 3600, 1, 1], 12);
  ev('ProofSubmittedV2', [TASK, '0x' + '12'.repeat(32), '0x' + '88'.repeat(32), '0x' + '44'.repeat(32), 1], 18);
  ev('ReleasedV2', [TASK, '0x' + 'a0'.repeat(20), 100_000_000n, 0], 25);
  const provider: IndexRpcProvider = {
    async getBlockNumber() { return blocks[blocks.length - 1].number; },
    async getBlock(n: number | string) { return blocks.find((b) => b.number === Number(n)) ?? null; },
    async getLogs(f: any) {
      return logs.filter((l) => l.blockNumber >= Number(f.fromBlock) && l.blockNumber <= Number(f.toBlock)).map((l) => ({ ...l }));
    },
  };
  await new ChainIndexer({ provider, escrowAddress: ESCROW, chainId: 31337, deploymentBlock: 10, home: HOME, pageSize: 50 }).syncFrom();
  expect(fs.existsSync(chainIndexPath(HOME))).toBe(true);
}

describe('registerChainIndexRoutes (独立路由模块, 不碰 server.ts)', () => {
  it('注册 4 条只读路由, 默认**不**注册 POST /sync', async () => {
    await seedIndex();
    const { app, routes } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME });
    expect([...routes.keys()].sort()).toEqual([
      'GET /api/chain/index/events', 'GET /api/chain/index/stats',
      'GET /api/chain/index/status', 'GET /api/chain/index/timeline',
    ]);
  });

  it('GET /status → 索引高度 + 最后同步时间', async () => {
    await seedIndex();
    const { app, call } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME });
    const r = await call('GET', '/api/chain/index/status');
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.status.lastSyncedBlock).toBe(30);
    expect(r.body.status.lastSyncedAt).toBeGreaterThan(0);
    expect(r.body.status.confirmations).toEqual({ confirmed: 1, finalized: 12 });
    expect(r.body.status.entries).toBe(3);
  });

  it('GET /stats → tasks/released/refunded/disputed/expired + byFinality', async () => {
    await seedIndex();
    const { app, call } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME });
    const r = await call('GET', '/api/chain/index/stats');
    expect(r.code).toBe(200);
    expect(r.body.stats.tasks).toBe(1);
    expect(r.body.stats.released).toBe(1);
    expect(r.body.stats.expired).toBe(0);
    expect(r.body.stats.byFinality.finalized + r.body.stats.byFinality.confirmed).toBe(3);
  });

  it('GET /timeline?taskKey=… → 时间线; 非法 taskKey → 400', async () => {
    await seedIndex();
    const { app, call } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME });
    const ok = await call('GET', '/api/chain/index/timeline', { query: { taskKey: TASK } });
    expect(ok.code).toBe(200);
    expect(ok.body.timeline.state).toBe('RELEASED');
    expect(ok.body.timeline.events.map((e: any) => e.eventName)).toEqual(['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2']);
    const bad = await call('GET', '/api/chain/index/timeline', { query: { taskKey: '../../etc/passwd' } });
    expect(bad.code).toBe(400);
    expect(String(bad.body.error)).toContain('taskKey');
    const missing = await call('GET', '/api/chain/index/timeline', { query: {} });
    expect(missing.code).toBe(400);
  });

  it('GET /events → cursor 增量 (无 cursor = 从头); 非法参数 → 400', async () => {
    await seedIndex();
    const { app, call } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME });
    const p1 = await call('GET', '/api/chain/index/events', { query: { limit: '2' } });
    expect(p1.code).toBe(200);
    expect(p1.body.page.events.length).toBe(2);
    expect(p1.body.page.hasMore).toBe(true);
    expect(p1.body.page.nextCursor).toEqual({ blockNumber: 18, logIndex: 0 });
    const p2 = await call('GET', '/api/chain/index/events', { query: { blockNumber: '18', logIndex: '0' } });
    expect(p2.body.page.events.map((e: any) => e.blockNumber)).toEqual([25]);
    const badCursor = await call('GET', '/api/chain/index/events', { query: { blockNumber: '-1' } });
    expect(badCursor.code).toBe(400);
    const badLimit = await call('GET', '/api/chain/index/events', { query: { limit: 'abc' } });
    expect(badLimit.code).toBe(400);
  });

  it('挂载前缀可改 (basePath)', async () => {
    await seedIndex();
    const { app, routes } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME, basePath: '/x/chain' });
    expect(routes.has('GET /x/chain/status')).toBe(true);
    expect(routes.has('GET /x/chain/timeline')).toBe(true);
  });

  it('allowSync=true 时才注册 POST /sync, 并把 fromBlock 透传', async () => {
    await seedIndex();
    const { app, call } = fakeApp();
    const seen: any[] = [];
    registerChainIndexRoutes(app, { home: HOME, allowSync: true, sync: async (from) => { seen.push(from); return { inserted: 0 }; } });
    const r = await call('POST', '/api/chain/index/sync', { body: { fromBlock: 111 } });
    expect(r.code).toBe(200);
    expect(seen).toEqual([111]);
    const r2 = await call('POST', '/api/chain/index/sync', { body: {} });
    expect(seen).toEqual([111, undefined]);
    const bad = await call('POST', '/api/chain/index/sync', { body: { fromBlock: -5 } });
    expect(bad.code).toBe(400);
  });

  it('索引文件不存在时: 只读路由仍 200 (空统计), 不假装有数据', async () => {
    const { app, call } = fakeApp();
    registerChainIndexRoutes(app, { home: HOME });
    const st = await call('GET', '/api/chain/index/status');
    expect(st.code).toBe(200);
    expect(st.body.status.entries).toBe(0);
    expect(st.body.status.lastSyncedAt).toBeNull();
    const stats = await call('GET', '/api/chain/index/stats');
    expect(stats.body.stats.tasks).toBe(0);
    const tl = await call('GET', '/api/chain/index/timeline', { query: { taskKey: TASK } });
    expect(tl.body.timeline.count).toBe(0);
  });
});
