/**
 * mobile-helia.ts — 手机端「真 IPFS 节点」模块 (Helia + js-libp2p) (2026-09-11)
 *
 * 目标: 让手机 App (Capacitor iOS WebView) 里**真的跑一个 IPFS 节点** ——
 *   有 PeerID、有 blockstore、有 bitswap。不是只调网关。
 *
 * ───────────────────────── 设计要点 ─────────────────────────
 * 1) 复用 mobile-ipfs.computeCid() 算 CID (硬要求):
 *      内容 → jsonClean → @ipld/dag-cbor encode → sha2-256 → CIDv1(0x71)
 *    dag-cbor 编码字节与 CID 完全对应, 所以 heliaAddJson 写进 blockstore 的块
 *    就是「能重新哈希出同一个 CID」的那份字节 —— 手机与桌面 contentToCid() 逐字一致。
 * 2) blockstore 默认 **内存** (helia 内部默认 MemoryBlockstore)。
 *    持久化需要额外包 (blockstore-fs / IndexedDB), 本轮不引入 —— 前台重启即清空。
 *
 * ───────────────────────── iOS 后台限制 (务必知悉) ─────────────────────────
 *   - iOS 会挂起后台 WebView → 节点**只在前台在线**, 不做 24/7。回到前台需重新
 *     startMobileHelia()。别把手机当常驻节点, 只当「前台参与 + 能服务块」的对等端。
 *   - 手机 (WebView) **不能 listen** 公网地址, 只能拨出 (webSockets dial)。
 *     拨出的连接是**双向**的, 所以手机仍能通过它 bitswap 提供/接收块 —— 能服务块。
 *   - 传输只有 webSockets + circuit-relay (浏览器无 tcp/udp)。必须 /ws 或 /wss 地址。
 *
 * ───────────────────────── 打包 / 加载 ─────────────────────────
 *   所有重依赖 (helia / libp2p 各插件) 都用**动态 import()** 惰性加载 —— 只有真正
 *   建节点时才拉进来 (顶层只保留 `import type` 静态类型)。esbuild --platform=browser
 *   实测 0 个 node 内置引用 (见交付说明)。
 *   测试用 createMobileHeliaNode({ node: fakeNode }) 注入假节点, **不会** import helia。
 *
 * 全部导出函数**失败一律返回 { ok:false, error }**, 永不抛。
 */

import type { Helia } from 'helia';
import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { computeCid, jsonClean, normalizeCid, defaultStorage, type IpfsStorage } from './mobile-ipfs.js';

// ─────────────────────────── 类型 ───────────────────────────

const errMsg = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/** blockstore 最小结构 (helia 的 Blocks 是它的超集; 假节点只需实现这些) */
export interface MobileBlockstore {
  put(cid: unknown, bytes: Uint8Array, opts?: unknown): Promise<unknown>;
  /** helia 返回 AsyncGenerator<Uint8Array>; 也容忍 Promise<Uint8Array> */
  get(cid: unknown, opts?: unknown): AsyncIterable<Uint8Array> | Promise<Uint8Array | AsyncIterable<Uint8Array>>;
  has?(cid: unknown, opts?: unknown): Promise<boolean>;
  getAll?(opts?: unknown): AsyncIterable<unknown>;
}

/** libp2p 最小结构 */
export interface MobileLibp2p {
  peerId?: { toString(): string };
  getPeers?(): Array<{ toString(): string }>;
  isStarted?(): boolean;
  dial?(addr: unknown, opts?: unknown): Promise<unknown>;
}

/** 手机 Helia 节点 (真 Helia 与测试假节点都满足此结构) */
export interface MobileHeliaNode {
  blockstore: MobileBlockstore;
  libp2p?: MobileLibp2p;
  status?: string;
  start?(opts?: unknown): Promise<unknown>;
  stop?(opts?: unknown): Promise<unknown>;
}

export interface CreateMobileHeliaOpts {
  /** 启动后要拨的种子 multiaddr (只接受 /ws 或 /wss) */
  seedAddrs?: string[];
  /** 覆盖/追加传给 createHelia 的 libp2p 配置 (高级用法) */
  libp2pOptions?: any;
  /** 注入节点 (测试用) —— 提供后不会 import helia, 也不会起真 libp2p */
  node?: MobileHeliaNode;
  /** 是否启用 kad-dht client 模式做内容路由 (默认 false; 开启会显著增大 bundle) */
  dhtClient?: boolean;
}

export interface CreateMobileHeliaResult {
  ok: boolean;
  node?: MobileHeliaNode;
  peerId?: string;
  error?: string;
}

export interface AddJsonResult {
  ok: boolean;
  cid?: string;
  error?: string;
}

export interface GetJsonResult {
  ok: boolean;
  value?: unknown;
  /** 'local' = 本地 blockstore 命中; 'network' = 从网络 (bitswap) 取回 */
  from: 'local' | 'network';
  error?: string;
}

export interface HeliaStatusResult {
  ok: boolean;
  running: boolean;
  peerId?: string;
  peers: string[];
  blockCount?: number;
  error?: string;
}

export interface StartMobileHeliaConfig {
  /** 不传 → 自动从 mobile-p2p.listMobilePeerAddrs() 读已保存节点地址 (过滤非 /ws) */
  seedAddrs?: string[];
  libp2pOptions?: any;
  /** 注入节点 (测试用) */
  node?: MobileHeliaNode;
  dhtClient?: boolean;
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

export interface SetEnabledResult extends OpResult {
  enabled?: boolean;
}

// ─────────────────────────── 常量 ───────────────────────────

/** localStorage 开关 key (供设置页 UI 控) */
export const HELIA_ENABLED_KEY = 'bolloon_helia_enabled';

/** 手机只支持 websockets 传输: 地址必须带 /ws 或 /wss */
export const isWsCapableAddr = (addr: string): boolean =>
  typeof addr === 'string' && /\/ws(s)?(\/|$)/.test(addr.trim());

// ─────────────────────────── 模块级单例状态 ───────────────────────────

let currentNode: MobileHeliaNode | null = null;
let currentPeerId: string | null = null;
/** 并发 start 去重 (两次 startMobileHelia 同时进来只建一次) */
let startPromise: Promise<CreateMobileHeliaResult> | null = null;

/** 从节点上读 PeerID 字符串 (失败 undefined) */
function peerIdOf(node: MobileHeliaNode | null | undefined): string | undefined {
  try {
    const s = node?.libp2p?.peerId?.toString?.();
    return typeof s === 'string' && s ? s : undefined;
  } catch {
    return undefined;
  }
}

/** 从 mobile-p2p 读已保存地址 (惰性 import, 避免无谓加载 libp2p); 失败返回 [] */
async function readSavedPeerAddrs(): Promise<string[]> {
  try {
    const mod = await import('./mobile-p2p.js');
    const addrs = mod.listMobilePeerAddrs();
    return Array.isArray(addrs) ? addrs.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/** 拨种子地址 (逐个, 单个失败跳过)。假节点没有 libp2p.dial → 直接跳过。 */
async function dialSeeds(node: MobileHeliaNode, addrs: string[]): Promise<void> {
  if (!addrs.length) return;
  const libp2p = node.libp2p;
  if (!libp2p || typeof libp2p.dial !== 'function') return;
  let multiaddr: ((s: string) => unknown) | null = null;
  try {
    const mod = await import('@multiformats/multiaddr');
    multiaddr = mod.multiaddr as unknown as (s: string) => unknown;
  } catch {
    return; // 拿不到 multiaddr 构造器 → 静默跳过拨号
  }
  for (const addr of addrs) {
    try {
      await libp2p.dial.call(libp2p, multiaddr(addr));
    } catch {
      /* 单个种子失败不影响整体启动 */
    }
  }
}

// ─────────────────────────── 建节点 ───────────────────────────

/**
 * 创建并 start 一个 Helia 节点 (transports: webSockets + circuitRelay; 无 tcp)。
 * 传 opts.node → 用注入节点 (测试); 否则动态 import('helia') 建真节点。
 * 失败**不抛**, 返回 { ok:false, error }。
 */
export async function createMobileHeliaNode(opts: CreateMobileHeliaOpts = {}): Promise<CreateMobileHeliaResult> {
  try {
    // 1) 注入节点 (测试 / 外部已建好的节点)
    if (opts.node) {
      const node = opts.node;
      if (typeof node.start === 'function' && node.status !== 'started') {
        await node.start();
      }
      await dialSeeds(node, (opts.seedAddrs || []).filter(isWsCapableAddr));
      return { ok: true, node, peerId: peerIdOf(node) };
    }

    // 2) 真节点: 惰性加载 helia + 各 libp2p 插件
    const heliaMod = await import('helia');
    const { webSockets } = await import('@libp2p/websockets');
    const { circuitRelayTransport } = await import('@libp2p/circuit-relay-v2');
    const { noise } = await import('@chainsafe/libp2p-noise');
    const { yamux } = await import('@chainsafe/libp2p-yamux');
    const { identify } = await import('@libp2p/identify');
    const { ping } = await import('@libp2p/ping');

    const services: Record<string, unknown> = { identify: identify(), ping: ping() };
    if (opts.dhtClient) {
      const { kadDHT } = await import('@libp2p/kad-dht');
      services.dht = kadDHT({ clientMode: true });
    }

    // 浏览器无 tcp → 只挂 webSockets + circuit-relay。blockstore 不传 → helia 默认内存。
    const libp2pOptions: any = {
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services,
      ...(opts.libp2pOptions || {}),
    };

    const helia: Helia = await heliaMod.createHelia({ libp2p: libp2pOptions } as any);
    const node = helia as unknown as MobileHeliaNode;

    await dialSeeds(node, (opts.seedAddrs || []).filter(isWsCapableAddr));
    return { ok: true, node, peerId: peerIdOf(node) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ─────────────────────────── 生命周期 (幂等) ───────────────────────────

async function doStart(cfg: StartMobileHeliaConfig): Promise<CreateMobileHeliaResult> {
  let seedAddrs = cfg.seedAddrs;
  if (seedAddrs === undefined) {
    // 没给种子 → 从 mobile-p2p 读已保存节点地址, 过滤掉 /ws 不支持的项
    const saved = await readSavedPeerAddrs();
    seedAddrs = saved.filter(isWsCapableAddr);
  } else {
    seedAddrs = seedAddrs.filter(isWsCapableAddr);
  }

  const res = await createMobileHeliaNode({
    seedAddrs,
    libp2pOptions: cfg.libp2pOptions,
    node: cfg.node,
    dhtClient: cfg.dhtClient,
  });
  if (!res.ok || !res.node) return res;

  currentNode = res.node;
  currentPeerId = res.peerId ?? null;
  return { ok: true, node: res.node, peerId: currentPeerId ?? undefined };
}

/**
 * 启动手机 Helia 节点。**幂等**: 已在运行直接返回现有节点, 不重建。
 * 无 seedAddrs → 自动用 mobile-p2p 已保存地址 (过滤非 /ws); 允许空列表启动
 * (能启动, 只是暂时没有对端)。
 */
export async function startMobileHelia(cfg: StartMobileHeliaConfig = {}): Promise<CreateMobileHeliaResult> {
  if (currentNode) {
    return { ok: true, node: currentNode, peerId: currentPeerId ?? peerIdOf(currentNode) };
  }
  if (startPromise) return startPromise;
  startPromise = doStart(cfg);
  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

/** 停止并清空节点。**幂等**: 未启动时返回 { ok:true }。 */
export async function stopMobileHelia(): Promise<OpResult> {
  const node = currentNode;
  currentNode = null;
  currentPeerId = null;
  if (!node) return { ok: true };
  try {
    if (typeof node.stop === 'function') await node.stop();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ─────────────────────────── 读写 (CID 与 computeCid 一致) ───────────────────────────

/**
 * 把 JSON 对象写入手机节点 blockstore。
 * CID 用 mobile-ipfs.computeCid() 算 (dag-cbor + sha2-256 + CIDv1) —— 与桌面端逐字一致;
 * 写入的字节就是同一份 dag-cbor 编码, 因此块能重新哈希出该 CID。
 * 失败不抛。
 */
export async function heliaAddJson(obj: unknown): Promise<AddJsonResult> {
  try {
    const node = currentNode;
    if (!node) return { ok: false, error: 'Helia 节点未启动 (请先 startMobileHelia)' };
    const cidStr = await computeCid(obj); // 跨端一致的 CID
    const bytes = dagCbor.encode(jsonClean(obj) as Record<string, unknown>);
    await node.blockstore.put(CID.parse(cidStr), bytes);
    return { ok: true, cid: cidStr };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/** 把 blockstore.get 的返回 (async generator / Promise) 归一成字节 */
async function collectBytes(src: unknown): Promise<Uint8Array> {
  if (src == null) throw new Error('blockstore.get 无返回');
  const maybePromise = src as Promise<unknown>;
  const unwrapped =
    typeof (maybePromise as any).then === 'function' ? await maybePromise : src;
  if (unwrapped instanceof Uint8Array) return unwrapped;
  const iterable = unwrapped as any;
  if (iterable && (typeof iterable[Symbol.asyncIterator] === 'function' || typeof iterable[Symbol.iterator] === 'function')) {
    const chunks: Uint8Array[] = [];
    for await (const c of iterable) {
      chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c as ArrayLike<number>));
    }
    if (chunks.length === 0) throw new Error('块不可用 (本地 blockstore 与网络均未命中)');
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  throw new Error('无法从 blockstore.get 读取字节');
}

/**
 * 读取 JSON 块: 先本地 blockstore, 再走网络 (helia 的 blockstore.get 会经 bitswap 取块),
 * 拿到字节用 dag-cbor 解码。from 标出命中来源。失败不抛。
 */
export async function heliaGetJson(cid: string): Promise<GetJsonResult> {
  const node = currentNode;
  if (!node) return { ok: false, from: 'network', error: 'Helia 节点未启动 (请先 startMobileHelia)' };

  let parsed: CID;
  try {
    const key = normalizeCid(cid);
    if (!key) return { ok: false, from: 'network', error: 'cid 不能为空' };
    parsed = CID.parse(key);
  } catch (err) {
    return { ok: false, from: 'network', error: `非法 cid: ${errMsg(err)}` };
  }

  // 本地是否命中 (决定 from)。has 缺失时按未命中处理 → 交给 get 走网络。
  let local = false;
  try {
    local = node.blockstore.has ? await node.blockstore.has(parsed) : false;
  } catch {
    local = false;
  }

  try {
    const bytes = await collectBytes(node.blockstore.get(parsed));
    const value = dagCbor.decode(bytes);
    return { ok: true, value, from: local ? 'local' : 'network' };
  } catch (err) {
    return { ok: false, from: local ? 'local' : 'network', error: errMsg(err) };
  }
}

// ─────────────────────────── 状态 ───────────────────────────

/** 节点状态: running / PeerID / 已连接 peers / blockstore 块数。失败不抛。 */
export async function heliaStatus(): Promise<HeliaStatusResult> {
  const node = currentNode;
  if (!node) return { ok: true, running: false, peers: [] };
  try {
    const running = node.status === 'started' || node.libp2p?.isStarted?.() === true;
    const peerId = currentPeerId ?? peerIdOf(node);

    let peers: string[] = [];
    try {
      const list = node.libp2p?.getPeers?.() || [];
      peers = list.map((p) => (p && typeof p.toString === 'function' ? p.toString() : String(p)));
    } catch {
      peers = [];
    }

    let blockCount: number | undefined;
    if (typeof node.blockstore.getAll === 'function') {
      try {
        let n = 0;
        for await (const _ of node.blockstore.getAll()) n++;
        blockCount = n;
      } catch {
        blockCount = undefined;
      }
    }

    const out: HeliaStatusResult = { ok: true, running, peers };
    if (peerId) out.peerId = peerId;
    if (blockCount !== undefined) out.blockCount = blockCount;
    return out;
  } catch (err) {
    return { ok: false, running: false, peers: [], error: errMsg(err) };
  }
}

// ─────────────────────────── 开关 (UI 控) ───────────────────────────

/** 读开关 (默认关; 存储损坏一律当关)。 */
export function heliaEnabled(storage: IpfsStorage = defaultStorage()): boolean {
  try {
    return storage.getItem(HELIA_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写开关到 localStorage (key = bolloon_helia_enabled)。失败不抛。 */
export function setHeliaEnabled(enabled: boolean, storage: IpfsStorage = defaultStorage()): SetEnabledResult {
  try {
    storage.setItem(HELIA_ENABLED_KEY, enabled ? '1' : '0');
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}
