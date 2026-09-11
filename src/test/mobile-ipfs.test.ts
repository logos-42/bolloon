/**
 * mobile-ipfs.test.ts — 手机端独立 IPFS 模块测试 (2026-09-11)
 *
 * 覆盖: CID 确定性 / 键序无关 / 验 CID 正负例 / 网关回退顺序 / 全失败 /
 *       缓存命中零网络 / 缓存上限淘汰 / 配置持久化与默认值 /
 *       上传各 mode 的失败原因与成功路径 / resultCid 稳定 / 注入 SDK 客户端优先。
 */

import { describe, it, expect } from 'vitest';
import { CID } from 'multiformats/cid';
import {
  computeCid,
  cidFromText,
  verifyContent,
  resultCid,
  normalizeCid,
  jsonClean,
  createMemoryStorage,
  getIpfsConfig,
  setIpfsConfig,
  ipfsUpload,
  ipfsFetch,
  ipfsCacheGet,
  ipfsCacheSet,
  IPFS_CONFIG_KEY,
  DEFAULT_GATEWAYS,
  DEFAULT_IPFS_CONFIG,
  IPFS_CACHE_MAX_ENTRIES,
  IPFS_CACHE_MAX_BYTES,
  PINATA_PIN_URL,
  type FetchLike,
  type IpfsClientLike,
} from '../web/mobile-ipfs.js';

// ─────────────────────────── 测试工具 ───────────────────────────

interface MockReply {
  status?: number;
  body?: string;
  json?: unknown;
}
type Handler = (url: string, init?: any) => MockReply | 'throw';

/** 造一个记录调用顺序的 fetch 桩 */
function makeFetch(handler: Handler): { fn: FetchLike; calls: string[]; inits: any[] } {
  const calls: string[] = [];
  const inits: any[] = [];
  const fn = (async (url: string, init?: any) => {
    calls.push(url);
    inits.push(init);
    const r = handler(url, init);
    if (r === 'throw') throw new Error(`network down: ${url}`);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.body ?? '',
      json: async () => r.json ?? {},
    };
  }) as unknown as FetchLike;
  return { fn, calls, inits };
}

const GW_A = 'https://gw-a.example';
const GW_B = 'https://gw-b.example';
const GW_C = 'https://gw-c.example';

// ─────────────────────────── 1. CID 计算 ───────────────────────────

describe('computeCid / cidFromText (本地确定性 CID · PROOF 阶段)', () => {
  it('① 同对象不同键序 → 同 CID (dag-cbor 键排序); 嵌套也一样', async () => {
    const a = await computeCid({ agentId: 'a1', type: 'memory', content: { x: 1, y: [1, 2, 3] } });
    const b = await computeCid({ content: { y: [1, 2, 3], x: 1 }, type: 'memory', agentId: 'a1' });
    const c = await computeCid({ type: 'memory', agentId: 'a1', content: { x: 1, y: [1, 2, 3] } });
    expect(b).toBe(a);
    expect(c).toBe(a);
    // 同输入重复算 → 稳定
    expect(await computeCid({ agentId: 'a1', type: 'memory', content: { x: 1, y: [1, 2, 3] } })).toBe(a);
  });

  it('② 内容不同 → CID 不同; CID 是合法 dag-cbor v1 (bafyrei…); undefined 字段被忽略', async () => {
    const one = await computeCid({ n: 1 });
    const two = await computeCid({ n: 2 });
    expect(one).not.toBe(two);
    expect(one.startsWith('bafyrei')).toBe(true);
    expect(CID.parse(one).code).toBe(0x71);
    // JSON 语义: undefined 字段丢弃 → 与不带该字段同 CID (与桌面端 contentToCid 一致)
    const withUndef = await computeCid({ n: 1, maybe: undefined });
    const withoutUndef = await computeCid({ n: 1 });
    expect(withUndef).toBe(withoutUndef);
    // cidFromText 稳定, 且与同名字段对象区分开
    expect(await cidFromText('hello')).toBe(await cidFromText('hello'));
    expect(await cidFromText('hello')).not.toBe(await cidFromText('hellp'));
    expect(await cidFromText('hello')).not.toBe(await computeCid({ text: 'hello' }));
  });

  it('jsonClean / normalizeCid: 循环引用不抛, ipfs:// 前缀被剥掉', () => {
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    expect(jsonClean(cyc)).toEqual({ a: 1, self: '[Circular]' });
    expect(normalizeCid(' ipfs://bafyreiabc/ ')).toBe('bafyreiabc');
    expect(normalizeCid('/ipfs/bafyreiabc')).toBe('bafyreiabc');
    expect(normalizeCid('bafyreiabc')).toBe('bafyreiabc');
  });
});

// ─────────────────────────── 2. 验 CID ───────────────────────────

describe('verifyContent (校验 · PROOF 阶段对账)', () => {
  it('③ 正例: 重算一致 → ok:true match:true (接受 ipfs:// 前缀写法)', async () => {
    const obj = { agentId: 'a1', result: { ok: true, tokens: 7 } };
    const cid = await computeCid(obj);
    const r1 = await verifyContent(cid, { result: { tokens: 7, ok: true }, agentId: 'a1' }); // 键序不同也算一致
    expect(r1.ok).toBe(true);
    expect(r1.match).toBe(true);
    expect(r1.expected).toBe(cid);
    expect(r1.actual).toBe(cid);
    const r2 = await verifyContent(`ipfs://${cid}`, obj);
    expect(r2.match).toBe(true);
  });

  it('④ 负例: CID 与被验内容不符 → ok:true match:false; 空 CID → ok:false', async () => {
    const cid = await computeCid({ a: 1 });
    const bad = await verifyContent(cid, { a: 2 });
    expect(bad.ok).toBe(true);
    expect(bad.match).toBe(false);
    expect(bad.actual).not.toBe(cid);
    const empty = await verifyContent('', { a: 1 });
    expect(empty.ok).toBe(false);
    expect(empty.match).toBe(false);
    expect(empty.error).toBeTruthy();
  });

  it('文本内容走 cidFromText: 正/负例', async () => {
    const cid = await cidFromText('agent output text');
    expect((await verifyContent(cid, 'agent output text')).match).toBe(true);
    expect((await verifyContent(cid, 'agent output text!')).match).toBe(false);
  });
});

// ─────────────────────────── 3. 网关回退 ───────────────────────────

describe('ipfsFetch 网关回退 (资源读取阶段)', () => {
  it('⑤ 第一个网关 404 + 第二个抛异常 → 自动试第三个并成功; 记录尝试顺序; 成功写入缓存', async () => {
    const mem = createMemoryStorage();
    const cid = await computeCid({ hello: 'world' });
    const { fn, calls } = makeFetch((url) => {
      if (url.startsWith(GW_A)) return { status: 404, body: 'not found' };
      if (url.startsWith(GW_B)) return 'throw';
      if (url.startsWith(GW_C)) return { body: '{"hello":"world"}' };
      return { status: 500 };
    });

    const r = await ipfsFetch(cid, { gateways: [GW_A, GW_B, GW_C], fetchImpl: fn, storage: mem });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('{"hello":"world"}');
      expect(r.from).toBe(GW_C);
    }
    expect(calls).toEqual([`${GW_A}/ipfs/${cid}`, `${GW_B}/ipfs/${cid}`, `${GW_C}/ipfs/${cid}`]);
    // 命中后落缓存
    expect(ipfsCacheGet(cid, mem)).toBe('{"hello":"world"}');
  });

  it('⑥ 全网关失败 → ok:false (不抛), 缓存不写入; 网关尾斜杠被规范化', async () => {
    const mem = createMemoryStorage();
    const cid = await computeCid({ n: 1 });
    const { fn, calls } = makeFetch(() => 'throw');
    const r = await ipfsFetch(cid, { gateways: [`${GW_A}/`, GW_B], fetchImpl: fn, storage: mem });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/所有网关都失败/);
    expect(calls).toEqual([`${GW_A}/ipfs/${cid}`, `${GW_B}/ipfs/${cid}`]); // 无双斜杠
    expect(ipfsCacheGet(cid, mem)).toBeNull();
    // http 非 2xx 也算失败
    const { fn: fn404 } = makeFetch(() => ({ status: 500 }));
    const r404 = await ipfsFetch(cid, { gateways: [GW_A], fetchImpl: fn404, storage: createMemoryStorage() });
    expect(r404.ok).toBe(false);
    // 空 cid 直接失败
    const rEmpty = await ipfsFetch('   ', { fetchImpl: fn, storage: createMemoryStorage() });
    expect(rEmpty.ok).toBe(false);
  });

  it('⑦ 缓存命中 → 一次网络请求都不发 (fetch 调用次数 = 0)', async () => {
    const mem = createMemoryStorage();
    const cid = await computeCid({ cached: true });
    const set = ipfsCacheSet(cid, '{"cached":true}', mem);
    expect(set.ok).toBe(true);

    const { fn, calls } = makeFetch(() => 'throw');
    const r = await ipfsFetch(cid, { gateways: [GW_A, GW_B, GW_C], fetchImpl: fn, storage: mem });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from).toBe('cache');
      expect(r.text).toBe('{"cached":true}');
    }
    expect(calls.length).toBe(0); // 关键断言: 零网络
  });
});

// ─────────────────────────── 4. 本地缓存 ───────────────────────────

describe('ipfsCacheSet / ipfsCacheGet (本地缓存, 含上限保护)', () => {
  it('⑧ set/get 往返 + 上限淘汰 (超条数删最旧) + 超大单条拒绝', async () => {
    const mem = createMemoryStorage();
    // 往返
    expect(ipfsCacheSet('bafyreiOne', 'hello', mem).ok).toBe(true);
    expect(ipfsCacheGet('bafyreiOne', mem)).toBe('hello');
    expect(ipfsCacheGet('bafyreiMissing', mem)).toBeNull();
    // 覆盖写同一 cid 不重复计数
    expect(ipfsCacheSet('bafyreiOne', 'hello2', mem).ok).toBe(true);
    expect(ipfsCacheGet('bafyreiOne', mem)).toBe('hello2');

    // 超条数 → 最旧被淘汰, 数量被压到上限
    const mem2 = createMemoryStorage();
    const n = IPFS_CACHE_MAX_ENTRIES + 5;
    for (let i = 0; i < n; i++) {
      expect(ipfsCacheSet(`bafyreiC${i}`, `payload-${i}`, mem2).ok).toBe(true);
    }
    expect(ipfsCacheGet('bafyreiC0', mem2)).toBeNull(); // 最旧 5 条被淘汰
    expect(ipfsCacheGet(`bafyreiC${n - 1}`, mem2)).toBe(`payload-${n - 1}`);
    const idx = JSON.parse(mem2.getItem('bolloon_ipfs_cache_index') as string) as Array<{ c: string }>;
    expect(idx.length).toBe(IPFS_CACHE_MAX_ENTRIES);

    // 超大单条 → 拒绝并给出原因 (不抛)
    const mem3 = createMemoryStorage();
    const huge = 'a'.repeat(IPFS_CACHE_MAX_BYTES + 1);
    const big = ipfsCacheSet('bafyreiHuge', huge, mem3);
    expect(big.ok).toBe(false);
    expect(big.error).toMatch(/过大/);
    expect(ipfsCacheGet('bafyreiHuge', mem3)).toBeNull();
    // 空 cid / 非法输入
    expect(ipfsCacheSet('', 'x', mem3).ok).toBe(false);
    expect(ipfsCacheGet('', mem3)).toBeNull();
  });
});

// ─────────────────────────── 5. 配置 ───────────────────────────

describe('getIpfsConfig / setIpfsConfig (可注入存储)', () => {
  it('⑨ 默认值 mode=public + 三个公共网关; 持久化合并且保留默认网关; 损坏数据回落默认', () => {
    const mem = createMemoryStorage();
    const d = getIpfsConfig(mem);
    expect(d.mode).toBe('public');
    expect(d.gateways).toEqual([...DEFAULT_GATEWAYS]);
    expect([...DEFAULT_GATEWAYS]).toContain('https://ipfs.io');
    expect([...DEFAULT_GATEWAYS]).toContain('https://dweb.link');
    expect([...DEFAULT_GATEWAYS]).toContain('https://cloudflare-ipfs.com');
    expect(DEFAULT_IPFS_CONFIG.mode).toBe('public');

    // 只改 mode + apiUrl → 合并, 网关保留默认
    const s1 = setIpfsConfig({ mode: 'remote', apiUrl: 'http://127.0.0.1:5001' }, mem);
    expect(s1.ok).toBe(true);
    const c1 = getIpfsConfig(mem);
    expect(c1.mode).toBe('remote');
    expect(c1.apiUrl).toBe('http://127.0.0.1:5001');
    expect(c1.gateways).toEqual([...DEFAULT_GATEWAYS]);
    // 确实落到了存储 key
    expect(mem.getItem(IPFS_CONFIG_KEY)).toContain('127.0.0.1:5001');

    // 再改 mode=pinata → 保留 apiUrl
    expect(setIpfsConfig({ mode: 'pinata', pinataKey: 'k', pinataSecret: 's' }, mem).ok).toBe(true);
    const c2 = getIpfsConfig(mem);
    expect(c2.mode).toBe('pinata');
    expect(c2.pinataKey).toBe('k');
    expect(c2.apiUrl).toBe('http://127.0.0.1:5001');

    // 非法 mode → ok:false (不抛)
    expect(setIpfsConfig({ mode: 'bogus' as any }, mem).ok).toBe(false);

    // 损坏 JSON → 回落默认
    mem.setItem(IPFS_CONFIG_KEY, '{ this is not json');
    expect(getIpfsConfig(mem)).toEqual(DEFAULT_IPFS_CONFIG);
    // 非法 mode 的存量数据 → 回落 public
    mem.setItem(IPFS_CONFIG_KEY, JSON.stringify({ mode: 'nope' }));
    expect(getIpfsConfig(mem).mode).toBe('public');
  });
});

// ─────────────────────────── 6. 上传 ───────────────────────────

describe('ipfsUpload (资源存储阶段)', () => {
  it('⑩ mode=public 且无 Pinata 配置 → ok:false 且原因明确 (不抛, 不发请求)', async () => {
    const { fn, calls } = makeFetch(() => 'throw');
    const r = await ipfsUpload({ some: 'result' }, 'result.json', { config: { mode: 'public' }, fetchImpl: fn });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/只支持读取|无法上传/);
      expect(r.error).toMatch(/remote|pinata/i); // 给出怎么修
    }
    expect(calls.length).toBe(0);
  });

  it('mode=pinata 缺凭据 → ok:false; 配好凭据 → ok:true provider=Pinata (请求打到 Pinata)', async () => {
    const missing = await ipfsUpload('x', 'x.json', { config: { mode: 'pinata' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/pinataKey|pinataSecret/);

    const { fn, calls, inits } = makeFetch(() => ({ json: { IpfsHash: 'bafybeipinata123', PinSize: 42 } }));
    const cfg = { mode: 'pinata' as const, pinataKey: 'key-1', pinataSecret: 'secret-1' };
    const r = await ipfsUpload({ answer: 42 }, 'answer.json', { config: cfg, fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cid).toBe('bafybeipinata123');
      expect(r.provider).toBe('Pinata');
      expect(r.size).toBe(42);
    }
    expect(calls).toEqual([PINATA_PIN_URL]);
    expect(inits[0].headers.pinata_api_key).toBe('key-1');
    expect(JSON.parse(String(inits[0].body)).pinataContent).toEqual({ answer: 42 });
  });

  it('mode=remote 成功 → provider=remote_api; 网络异常 / 缺少 apiUrl → ok:false', async () => {
    const { fn, calls } = makeFetch(() => ({ json: { Hash: 'bafyreiremote456', Size: '17' } }));
    const r = await ipfsUpload('hello', 'hello.txt', {
      config: { mode: 'remote', apiUrl: 'http://127.0.0.1:5001' },
      fetchImpl: fn,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cid).toBe('bafyreiremote456');
      expect(r.provider).toBe('remote_api');
      expect(r.size).toBe(17);
    }
    expect(calls[0]).toBe('http://127.0.0.1:5001/api/v0/add?pin=true');

    // 缺 apiUrl
    const noUrl = await ipfsUpload('x', 'x', { config: { mode: 'remote' }, fetchImpl: fn });
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.error).toMatch(/apiUrl/);

    // 网络异常 → ok:false, 不抛
    const { fn: dead } = makeFetch(() => 'throw');
    const down = await ipfsUpload('x', 'x', {
      config: { mode: 'remote', apiUrl: 'http://127.0.0.1:5001' },
      fetchImpl: dead,
    });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error).toMatch(/上传/);

    // 上传后可用 gateway 读回 (端到端: upload → fetch)
    const mem = createMemoryStorage();
    const { fn: gw } = makeFetch(() => ({ body: 'hello' }));
    const up = await ipfsUpload('hello', 'hello.txt', {
      config: { mode: 'remote', apiUrl: 'http://127.0.0.1:5001' },
      fetchImpl: fn,
    });
    expect(up.ok).toBe(true);
    if (up.ok) {
      const back = await ipfsFetch(up.cid, { gateways: [GW_A], fetchImpl: gw, storage: mem });
      expect(back.ok).toBe(true);
      if (back.ok) {
        expect(back.text).toBe('hello');
        expect(back.from).toBe(GW_A);
      }
    }
  });
});

// ─────────────────────────── 7. resultCid ───────────────────────────

describe('resultCid (Agent 结果 CID → 进交易记录 / registry)', () => {
  it('⑪ 同一结果键序无关且稳定; 不同结果不同; 循环引用不抛', async () => {
    const result = { status: 'ok', output: { text: 'done', tokens: 12 }, toolCalls: [{ name: 'search' }] };
    const a = await resultCid(result);
    const b = await resultCid({ toolCalls: [{ name: 'search' }], output: { tokens: 12, text: 'done' }, status: 'ok' });
    expect(b).toBe(a);
    expect(await resultCid(result)).toBe(a);
    expect(a.startsWith('bafyrei')).toBe(true);

    const other = await resultCid({ status: 'ok', output: { text: 'done', tokens: 13 }, toolCalls: [{ name: 'search' }] });
    expect(other).not.toBe(a);

    // 循环引用: 返回字符串, 不抛
    const cyc: any = { status: 'ok' };
    cyc.self = cyc;
    const c = await resultCid(cyc);
    expect(typeof c).toBe('string');
    expect(c.length).toBeGreaterThan(0);
    // 极端输入 (undefined) 也不抛
    expect(typeof (await resultCid(undefined))).toBe('string');
  });
});

// ─────────────────────────── 8. 注入用户自己的 SDK 客户端 ───────────────────────────

describe("注入 @diap/sdk 的 IpfsClient (client 参数优先)", () => {
  it('⑫ client.upload → provider=diap-sdk; client.get → from=diap-sdk 且写入缓存; client 失败时回退网关', async () => {
    const { fn: dead, calls } = makeFetch(() => 'throw');
    const uploaded: string[] = [];
    const client: IpfsClientLike = {
      upload: async (content) => {
        uploaded.push(content);
        return { cid: 'bafyreisdk999', size: content.length, uploadedAt: 'now', provider: 'diap-sdk' };
      },
      get: async () => 'from-sdk-gateway',
    };

    // 上传: 即使 mode=public(本来会上传失败) 也优先用注入的 SDK 客户端
    const up = await ipfsUpload({ hi: 1 }, 'hi.json', { config: { mode: 'public' }, client, fetchImpl: dead });
    expect(up.ok).toBe(true);
    if (up.ok) {
      expect(up.cid).toBe('bafyreisdk999');
      expect(up.provider).toBe('diap-sdk');
    }
    expect(uploaded).toEqual(['{"hi":1}']);
    expect(calls.length).toBe(0);

    // 读取: 用 SDK 客户端, 不发网关请求; 命中写缓存 (第二次读走 cache)
    const mem = createMemoryStorage();
    const r1 = await ipfsFetch('bafyreisdk999', { client, fetchImpl: dead, storage: mem });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.from).toBe('diap-sdk');
      expect(r1.text).toBe('from-sdk-gateway');
    }
    expect(calls.length).toBe(0);
    expect(ipfsCacheGet('bafyreisdk999', mem)).toBe('from-sdk-gateway');

    // SDK 客户端抛错 → 回退网关成功
    const brokenClient: IpfsClientLike = {
      upload: async () => {
        throw new Error('sdk down');
      },
      get: async () => {
        throw new Error('sdk down');
      },
    };
    const { fn: gw, calls: gwCalls } = makeFetch(() => ({ body: 'from-public-gateway' }));
    const r2 = await ipfsFetch('bafyreiFallback', { client: brokenClient, gateways: [GW_A], fetchImpl: gw, storage: createMemoryStorage() });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.from).toBe(GW_A);
      expect(r2.text).toBe('from-public-gateway');
    }
    expect(gwCalls).toEqual([`${GW_A}/ipfs/bafyreiFallback`]);

    // SDK 上传失败 → ok:false + 明确原因
    const upFail = await ipfsUpload('x', 'x', { client: brokenClient, config: { mode: 'public' } });
    expect(upFail.ok).toBe(false);
    if (!upFail.ok) expect(upFail.error).toMatch(/diap-sdk/);
  });
});
