/**
 * mobile-helia.test.ts — 手机端真 IPFS 节点模块测试 (2026-09-11)
 *
 * 全部用**可注入的假节点** (createMobileHeliaNode({ node: fakeNode })),
 * 不真起 libp2p —— 否则测试会挂。
 *
 * 覆盖: ①无 seed 也能启动 ②重复 start 幂等 ③addJson CID 与 computeCid 一致
 *       ④addJson 失败不抛 ⑤getJson 本地命中 from='local' ⑥本地无 → 走网络
 *       ⑦网络也取不到 → ok:false ⑧status 返回 peers/blockCount ⑨stop 后 running=false
 *       ⑩enabled 开关持久化 (+ 非 /ws 地址过滤 / 非法 cid 拒绝)
 *       ⑪libp2p 启动失败 → ok:false + 真实 error (本地块能力不回退)   ← 回归 bug
 *       ⑫无 peerId 不算成功 ⑬heliaStatus 透出 libp2pStatus/lastError
 *       ⑭真 helia 未 start 语义 (libp2p getter 抛 NotStartedError) 被明确透出
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { computeCid, createMemoryStorage, jsonClean } from '../web/mobile-ipfs.js';
import {
  createMobileHeliaNode,
  startMobileHelia,
  stopMobileHelia,
  heliaAddJson,
  heliaGetJson,
  heliaStatus,
  heliaEnabled,
  setHeliaEnabled,
  isWsCapableAddr,
  HELIA_ENABLED_KEY,
  type MobileHeliaNode,
} from '../web/mobile-helia.js';

// ─────────────────────────── 假节点 (实现 blockstore / libp2p 接口) ───────────────────────────

interface FakeNodeHandle {
  node: MobileHeliaNode;
  /** 本地 blockstore (has 只看这里) */
  local: Map<string, Uint8Array>;
  /** 模拟网络侧可取的块 (本地没有时 get 会"经网络"拿到) */
  network: Map<string, Uint8Array>;
  getCalls: string[];
  hasCalls: string[];
  putCalls: string[];
  stats(): { started: number; stopped: number };
}

function makeFakeNode(
  opts: { peers?: string[]; local?: Map<string, Uint8Array>; network?: Map<string, Uint8Array> } = {},
): FakeNodeHandle {
  const local = opts.local ?? new Map<string, Uint8Array>();
  const network = opts.network ?? new Map<string, Uint8Array>();
  const getCalls: string[] = [];
  const hasCalls: string[] = [];
  const putCalls: string[] = [];
  let started = 0;
  let stopped = 0;

  const node: MobileHeliaNode = {
    status: 'stopped',
    blockstore: {
      put: async (cid: unknown, bytes: Uint8Array) => {
        putCalls.push(String(cid));
        local.set(String(cid), bytes);
        return cid;
      },
      has: async (cid: unknown) => {
        hasCalls.push(String(cid));
        return local.has(String(cid));
      },
      get: (cid: unknown) => {
        const key = String(cid);
        getCalls.push(key);
        return (async function* () {
          if (local.has(key)) {
            yield local.get(key) as Uint8Array;
            return;
          }
          if (network.has(key)) {
            yield network.get(key) as Uint8Array;
            return;
          }
          // 本地 + 网络都没有: 与真 helia 一致 —— 迭代时报错
          throw new Error('block not found (local + network)');
        })();
      },
      getAll: async function* () {
        for (const [c] of local) yield { cid: c };
      },
    },
    libp2p: {
      peerId: { toString: () => '12D3KooFakeMobilePeer' },
      isStarted: () => node.status === 'started',
      getPeers: () => (opts.peers ?? []).map((p) => ({ toString: () => p })),
    },
    async start() {
      started++;
      node.status = 'started';
    },
    async stop() {
      stopped++;
      node.status = 'stopped';
    },
  };

  return { node, local, network, getCalls, hasCalls, putCalls, stats: () => ({ started, stopped }) };
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// 每个用例后清掉模块单例, 避免相互污染
afterEach(async () => {
  await stopMobileHelia();
});

// ─────────────────────────── ① 无 seed 也能启动 ───────────────────────────

describe('createMobileHeliaNode / startMobileHelia (启动)', () => {
  it('① 无 seedAddrs 也能启动 (空列表 → ok, 只是没有对端)', async () => {
    const fake = makeFakeNode();
    const res = await startMobileHelia({ seedAddrs: [], node: fake.node });
    expect(res.ok).toBe(true);
    expect(res.node).toBe(fake.node);
    expect(res.peerId).toBe('12D3KooFakeMobilePeer');
    expect(fake.stats().started).toBe(1);

    const st = await heliaStatus();
    expect(st.ok).toBe(true);
    expect(st.running).toBe(true);
    expect(st.peers).toEqual([]);
  });

  it('② 重复 start 幂等 (第二次不重建, 不再次 start)', async () => {
    const fake = makeFakeNode({ peers: ['12D3KooPeerA'] });
    const r1 = await startMobileHelia({ seedAddrs: [], node: fake.node });
    const r2 = await startMobileHelia({ seedAddrs: [], node: makeFakeNode().node });
    expect(r1.ok && r2.ok).toBe(true);
    // 同一个节点实例 (未被第二次调用替换)
    expect(r2.node).toBe(fake.node);
    expect(fake.stats().started).toBe(1);
  });

  it('createMobileHeliaNode 注入节点 → 用注入的, 并 start 一次', async () => {
    const fake = makeFakeNode();
    const res = await createMobileHeliaNode({ node: fake.node });
    expect(res.ok).toBe(true);
    expect(res.peerId).toBe('12D3KooFakeMobilePeer');
    expect(fake.stats().started).toBe(1);
    expect(fake.node.status).toBe('started');
  });
});

// ─────────────────────────── ③④ 写块 ───────────────────────────

describe('heliaAddJson (写块 · CID 与 computeCid 一致)', () => {
  it('③ addJson → CID === computeCid, 且 blockstore 里的字节能哈希回同一 CID', async () => {
    const fake = makeFakeNode();
    await startMobileHelia({ seedAddrs: [], node: fake.node });

    const obj = { agentId: 'a1', type: 'memory', content: { y: [1, 2, 3], x: 1 } };
    const res = await heliaAddJson(obj);
    expect(res.ok).toBe(true);

    const expected = await computeCid(obj);
    expect(res.cid).toBe(expected);
    expect(fake.putCalls).toEqual([expected]);

    // 写入的字节 === jsonClean(obj) 的 dag-cbor 编码 (逐字节), 因此 CID 可复现
    const stored = fake.local.get(expected as string);
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(bytesEqual(stored as Uint8Array, dagCbor.encode(jsonClean(obj) as any))).toBe(true);

    // 用 multiformats 重算 CID: 写入块确实对应这个 CID
    expect(CID.parse(expected as string).toString()).toBe(expected);
  });

  it('④ addJson 失败不抛 (节点未启动 / put 抛错)', async () => {
    // 未启动 → ok:false, 不抛
    const notStarted = await heliaAddJson({ x: 1 });
    expect(notStarted.ok).toBe(false);
    if (!notStarted.ok) expect(notStarted.error).toMatch(/未启动/);

    // 节点已启动但 put 抛错 → ok:false, 不抛
    const broken: MobileHeliaNode = {
      status: 'started',
      blockstore: {
        put: async () => {
          throw new Error('blockstore 写入炸了');
        },
        get: () => (async function* () {})(),
      },
    };
    await startMobileHelia({ seedAddrs: [], node: broken });
    const res = await heliaAddJson({ x: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/blockstore/);
  });
});

// ─────────────────────────── ⑤⑥⑦ 读块 ───────────────────────────

describe('heliaGetJson (读块 · 本地优先再走网络)', () => {
  it('⑤ 本地命中 → from=local, 值正确', async () => {
    const fake = makeFakeNode();
    await startMobileHelia({ seedAddrs: [], node: fake.node });

    const obj = { hello: 'world', n: 42 };
    const add = await heliaAddJson(obj);
    expect(add.ok).toBe(true);

    const got = await heliaGetJson(add.cid as string);
    expect(got.ok).toBe(true);
    expect(got.from).toBe('local');
    expect(got.value).toEqual(obj);
  });

  it('⑥ 本地无 → 走网络 (断言调了 blockstore.get), from=network', async () => {
    const cid = await computeCid({ remote: true });
    // 只有网络侧有这块, 本地没有
    const fake = makeFakeNode({ network: new Map([[cid, dagCbor.encode({ remote: true })]]) });
    await startMobileHelia({ seedAddrs: [], node: fake.node });

    const got = await heliaGetJson(cid);
    expect(got.ok).toBe(true);
    expect(got.from).toBe('network');
    expect(got.value).toEqual({ remote: true });
    // 确实走了 get (bitswap 路径), 且 has 先查过本地
    expect(fake.hasCalls).toContain(cid);
    expect(fake.getCalls).toContain(cid);
  });

  it('⑦ 本地与网络都取不到 → ok:false, 不抛', async () => {
    const fake = makeFakeNode();
    await startMobileHelia({ seedAddrs: [], node: fake.node });
    const cid = await computeCid({ missing: true });

    const got = await heliaGetJson(cid);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/not found|不可用|未命中/);
    expect(fake.getCalls).toContain(cid);
  });

  it('非法 cid → ok:false (不抛)', async () => {
    const fake = makeFakeNode();
    await startMobileHelia({ seedAddrs: [], node: fake.node });
    const got = await heliaGetJson('not-a-cid');
    expect(got.ok).toBe(false);
  });
});

// ─────────────────────────── ⑧⑨ 状态 / 停止 ───────────────────────────

describe('heliaStatus / stopMobileHelia', () => {
  it('⑧ status 返回 peers / blockCount', async () => {
    const fake = makeFakeNode({ peers: ['12D3KooPeerA', '12D3KooPeerB'] });
    await startMobileHelia({ seedAddrs: [], node: fake.node });
    await heliaAddJson({ a: 1 });
    await heliaAddJson({ b: 2 });

    const st = await heliaStatus();
    expect(st.ok).toBe(true);
    expect(st.running).toBe(true);
    expect(st.peerId).toBe('12D3KooFakeMobilePeer');
    expect(st.peers).toEqual(['12D3KooPeerA', '12D3KooPeerB']);
    expect(st.blockCount).toBe(2);
  });

  it('⑨ stop 后 status.running=false (且幂等)', async () => {
    const fake = makeFakeNode({ peers: ['12D3KooPeerA'] });
    await startMobileHelia({ seedAddrs: [], node: fake.node });
    expect((await heliaStatus()).running).toBe(true);

    const s1 = await stopMobileHelia();
    expect(s1.ok).toBe(true);
    expect(fake.stats().stopped).toBe(1);

    const st = await heliaStatus();
    expect(st.running).toBe(false);
    expect(st.peers).toEqual([]);

    // 再 stop 一次: 幂等
    const s2 = await stopMobileHelia();
    expect(s2.ok).toBe(true);
    expect(fake.stats().stopped).toBe(1);
  });
});

// ─────────────────────────── ⑩ 开关 / 地址过滤 ───────────────────────────

describe('heliaEnabled 开关与地址过滤', () => {
  it('⑩ setHeliaEnabled → heliaEnabled 持久化 (key=bolloon_helia_enabled)', () => {
    const storage = createMemoryStorage();
    expect(heliaEnabled(storage)).toBe(false); // 默认关

    const on = setHeliaEnabled(true, storage);
    expect(on.ok).toBe(true);
    expect(on.enabled).toBe(true);
    expect(heliaEnabled(storage)).toBe(true);
    expect(storage.getItem(HELIA_ENABLED_KEY)).toBe('1');

    setHeliaEnabled(false, storage);
    expect(heliaEnabled(storage)).toBe(false);
    expect(storage.getItem(HELIA_ENABLED_KEY)).toBe('0');
  });

  it('isWsCapableAddr 只放行 /ws 与 /wss', () => {
    expect(isWsCapableAddr('/ip4/192.168.1.5/tcp/8080/ws')).toBe(true);
    expect(isWsCapableAddr('/dns4/relay.example/tcp/443/wss')).toBe(true);
    expect(isWsCapableAddr('/ip4/192.168.1.5/tcp/4001')).toBe(false);
    expect(isWsCapableAddr('/ip4/1.2.3.4/udp/4001/quic-v1')).toBe(false);
    expect(isWsCapableAddr('')).toBe(false);
  });
});

// ─────────── ⑪⑫⑬⑭ libp2p 真启动校验 (回归: start 返回 ok=true 但 peerId 为空) ───────────

/** 只有本地 blockstore 的骨架节点 (可选注入 libp2p / start) */
function makeBlockOnlyNode(extra: Partial<MobileHeliaNode> = {}): {
  node: MobileHeliaNode;
  local: Map<string, Uint8Array>;
} {
  const local = new Map<string, Uint8Array>();
  const node: MobileHeliaNode = {
    status: 'stopped',
    blockstore: {
      put: async (cid: unknown, bytes: Uint8Array) => {
        local.set(String(cid), bytes);
        return cid;
      },
      has: async (cid: unknown) => local.has(String(cid)),
      get: (cid: unknown) =>
        (async function* () {
          const k = String(cid);
          if (!local.has(k)) throw new Error('block not found (local only)');
          yield local.get(k) as Uint8Array;
        })(),
      getAll: async function* () {
        for (const [c] of local) yield { cid: c };
      },
    },
    ...extra,
  } as MobileHeliaNode;
  return { node, local };
}

describe('libp2p 真启动校验 (透出真实错误 / peerId 必需)', () => {
  it('⑪ libp2p 启动失败 → ok:false + 真实 error, 且本地块能力不回退', async () => {
    const { node } = makeBlockOnlyNode({
      libp2p: {
        peerId: { toString: () => '12D3KooShouldNotCount' },
        status: 'stopped',
        isStarted: () => false,
        getPeers: () => [],
      },
      start: async () => {
        throw new Error('libp2p start 失败: WebSocket is not defined');
      },
    });

    const res = await startMobileHelia({ seedAddrs: [], node });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    // 真实 message 必须透出 (旧代码被 doStart 吞掉)
    expect(res.error).toMatch(/WebSocket is not defined/);
    expect(res.peerId).toBeUndefined();

    // 需求 5: libp2p 起不来 → 明确报错, 但本地块能力继续工作
    const add = await heliaAddJson({ still: 'local' });
    expect(add.ok).toBe(true);
    const got = await heliaGetJson(add.cid as string);
    expect(got.ok).toBe(true);
    expect(got.from).toBe('local');
    expect(got.value).toEqual({ still: 'local' });

    const st = await heliaStatus();
    expect(st.running).toBe(false);
    expect(st.lastError).toMatch(/WebSocket is not defined/);
  });

  it('⑫ 无 peerId 不算成功 (node.status=started 也不行), 本地能力保留', async () => {
    const { node } = makeBlockOnlyNode({
      status: 'started',
      // libp2p 存在且 started, 但**没有 peerId** —— 旧代码会返回 ok:true
      libp2p: { status: 'started', isStarted: () => true, getPeers: () => [] },
    });

    const res = await startMobileHelia({ seedAddrs: [], node });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/PeerID 为空/);
    expect(res.peerId).toBeUndefined();

    const add = await heliaAddJson({ x: 1 });
    expect(add.ok).toBe(true);
    expect((await heliaGetJson(add.cid as string)).ok).toBe(true);
  });

  it('⑬ heliaStatus 透出 libp2pStatus / lastError', async () => {
    // 成功启动 → libp2pStatus='started', 没有 lastError
    const fake = makeFakeNode();
    const ok = await startMobileHelia({ seedAddrs: [], node: fake.node });
    expect(ok.ok).toBe(true);

    const good = await heliaStatus();
    expect(good.libp2pStatus).toBe('started');
    expect(good.lastError).toBeUndefined();

    // 起不来的节点 → lastError 是真实原因, libp2pStatus 反映真实状态
    await stopMobileHelia();
    const { node } = makeBlockOnlyNode({
      libp2p: {
        peerId: { toString: () => '12D3KooBroken' },
        status: 'stopped',
        isStarted: () => false,
        getPeers: () => [],
      },
      start: async () => {
        throw new Error('relay transport init failed');
      },
    });
    const bad = await startMobileHelia({ seedAddrs: [], node });
    expect(bad.ok).toBe(false);

    const st = await heliaStatus();
    expect(st.ok).toBe(true);
    expect(st.running).toBe(false);
    expect(st.libp2pStatus).toBe('stopped');
    expect(st.lastError).toMatch(/relay transport init failed/);
  });

  it('⑭ 真 helia 未 start 语义: libp2p getter 抛 NotStartedError → 明确错误, 不再静默 ok:true', async () => {
    // 复刻 Helia 7 未 start 节点的真实行为: 读 node.libp2p 直接抛 (消息就是 'Not started')
    const { node } = makeBlockOnlyNode({});
    Object.defineProperty(node, 'libp2p', {
      configurable: true,
      get() {
        throw new Error('Not started');
      },
    });

    const res = await startMobileHelia({ seedAddrs: [], node });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Not started/);

    const st = await heliaStatus();
    expect(st.running).toBe(false);
    expect(st.libp2pStatus).toMatch(/Not started/);
    expect(st.error).toMatch(/Not started/);

    // 本地块能力照样在
    const add = await heliaAddJson({ after: 'not-started' });
    expect(add.ok).toBe(true);
  });
});
