/**
 * mobile-helia.ts — 手机端「真 IPFS 节点」模块 (Helia + js-libp2p) (2026-09-11)
 *
 * 目标: 让手机 App (Capacitor iOS WebView) 里**真的跑一个 IPFS 节点** ——
 *   有 PeerID、有 blockstore、有 bitswap。不是只调网关。
 *
 * ─────────────────── 真节点来源: @diap/sdk/helia (2026-09-11 重接) ───────────────────
 * 上次直接 import `@diap/sdk` 在 WebView 挂了并回滚 (HeliaIpfsClient 在 `await helia.start()`
 * 之前读 `helia.libp2p` getter → NotStartedError)。SDK 0.2.7 已修, 并新增 `@diap/sdk/helia`
 * 子路径, 所以真节点现在一律经它创建:
 *   - 无种子 → `HeliaIpfsClient.newPublicOnly()`; 有种子 → `newWithRemoteNode(seedAddrs)`
 *     (工厂自带 `addresses.listen=['/p2p-circuit']` + `circuitRelayTransport()` → 中继能力已保)。
 *   - 传了 `dhtClient` / `libp2pOptions` 的高级路径 → 自建 helia 配置后 `fromHelia()` 包一层,
 *     再 `await client.start()` (SDK 内部先 `await helia.start()` 再读 getter, 顺序有保证)。
 *   - **唯一成功判据**: `client.getStartResult().ok === true` (SDK 内部已校验 peerId 非空 +
 *     `libp2p.status==='started'`)。
 *   - `heliaAddJson`/`heliaGetJson` 在有 SDK 客户端时走 `upload(JSON.stringify(...))` / `get(cid)`
 *     (SDK 的 upload **只收字符串**; get 回来的 `content` 可能是 JSON 字符串 → 解析回对象),
 *     没有客户端 (注入假节点 / 真节点起不来) 时退回本地 blockstore + computeCid, 保住本地块能力。
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
 * ────────────────── Helia 7 启动语义 (2026-09-11 修, 血的教训) ──────────────────
 *   `createHelia()` 在 Helia 7 里是**同步函数**: 它同步返回一个 status='stopped' 的
 *   节点 —— **libp2p 还没建, 更没 start**。此时读 `helia.libp2p` 会抛 NotStartedError
 *   ('Not started')。必须先 `await helia.start()`: libp2p 的 mixin 在 helia.start()
 *   内部才 `createLibp2p(opts)` 并 `libp2p.start()`。
 *   旧代码只 `await createHelia({libp2p:{...}})` (await 一个同步值等于没 await) 就返回
 *   ok:true → peerId 为空、status 报 'Not started'、底层错误被吞。
 *   本模块现在: 建 → **await helia.start()** → 校验 `libp2p.status === 'started'` 且
 *   peerId 非空 → 才算 ok:true; 任一步失败返回真实 message/stack。
 *   (实测: 把已建好的 libp2p **实例**塞给 createHelia({libp2p: instance}) 会抛
 *    `TypeError: createService is not a function` —— Helia 7 只接受 libp2p **配置**,
 *    不接受实例。所以走「配置 + helia.start()」这条路。)
 *
 * ───────────────────────── 已知限制 (WebView 环境) ─────────────────────────
 *   1) WebView 里 libp2p 若起不来 (例如 WKWebView 缺 WebSocket/缺 crypto 随机源、
 *      circuit-relay 传输初始化失败), start 返回 **ok:false + 真实 error**, 但节点仍
 *      会被装上 (currentNode 非空) —— **本地块能力 (heliaAddJson/heliaGetJson 的
 *      blockstore 路径) 不受影响, 继续可用**。状态里看 `libp2pStatus` / `lastError`。
 *   2) 手机只 listen `/p2p-circuit` (需公网中继才能拿到地址); 没有中继时 getMultiaddrs
 *      为空是**正常**的, 不代表失败 —— 失败以 peerId 为空为准。
 *   3) iOS 挂起后台 WebView 会掐断连接; 回前台重新 startMobileHelia()。
 *
 * 全部导出函数**失败一律返回 { ok:false, error }**, 永不抛。
 */

// 只作类型 (import type 编译期即被擦除, 不会在任何动态 import 之前加载 helia/libp2p)
import type { HeliaIpfsClient as SdkHeliaIpfsClient } from '@diap/sdk/helia';
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

/**
 * 比 errMsg 更"真"的错误串: `Name: message @ frame1 <- frame2 <- frame3`。
 * libp2p/helia 的启动错误常常 message 为空或只有一句, stack 才有信息量 —— 透出到 UI/探针。
 */
const errDetail = (err: unknown): string => {
  if (err instanceof Error) {
    const head = err.name && err.message ? `${err.name}: ${err.message}` : err.name || err.message || 'Error';
    const frames = (err.stack || '')
      .split('\n')
      .slice(1, 4)
      .map((s) => s.trim())
      .filter(Boolean);
    return frames.length ? `${head} @ ${frames.join(' <- ')}` : head;
  }
  return errMsg(err);
};

/** 运行环境摘要 (只读、不抛) —— 启动失败时附在 error 里, 便于在 WebView 日志里定位环境差异 */
const envHint = (): string => {
  try {
    const g = globalThis as any;
    return `env{WebSocket:${typeof g.WebSocket},protocol:${g.location?.protocol ?? 'n/a'},crypto:${typeof g.crypto?.getRandomValues === 'function'}}`;
  } catch {
    return 'env{unknown}';
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
  /** 真 libp2p 有 status: 'stopped' | 'starting' | 'started' | 'stopping' */
  status?: string;
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
  /**
   * libp2p 真实状态字符串: 'started' / 'stopped' / 'starting' / 'stopping' /
   * 'none'(节点没有 libp2p) / 'not-created'(libp2p 还没建, 读它会抛 NotStartedError) /
   * `error: <msg>` (读属性就抛错时)。
   */
  libp2pStatus?: string;
  /** 最近一次启动**真实**失败原因 (message/stack); 成功过则为空 */
  lastError?: string;
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
// ---------------------------------------------------------------------------
// 运行时垫片: iOS WebKit 缺失的 ES2024+ API (必须在 import('helia'/'@libp2p/*') 之前跑)
//   实测证据 (模拟器 iPhone 15, 2026-09-11): libp2p 启动直接抛
//     TypeError: Promise.withResolvers is not a function
//   → libp2p 根本起不来 (status: not-created)。Helia 7 的 createHelia 是同步的,
//   必须 await helia.start(), 而 start() 内部就走到了这个 API。
//   本模块在 bundle 里是顶层语句, 加载即执行 → 保证早于任何动态 import。
// ---------------------------------------------------------------------------
(() => {
  const P = Promise as any;
  if (typeof P.withResolvers !== 'function') {
    P.withResolvers = function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }
  if (typeof P.try !== 'function') {
    P.try = function promiseTry<T>(fn: (...a: any[]) => T, ...args: any[]) {
      return new Promise<T>((res, rej) => { try { res(fn(...args)); } catch (e) { rej(e); } });
    };
  }
})();

export const HELIA_ENABLED_KEY = 'bolloon_helia_enabled';

/** 手机只支持 websockets 传输: 地址必须带 /ws 或 /wss */
export const isWsCapableAddr = (addr: string): boolean =>
  typeof addr === 'string' && /\/ws(s)?(\/|$)/.test(addr.trim());

// ─────────────────────────── 模块级单例状态 ───────────────────────────

let currentNode: MobileHeliaNode | null = null;
let currentPeerId: string | null = null;
/** 真节点 → SDK HeliaIpfsClient (WeakMap: 节点释放即回收; 不用全局可变客户端, 避免和注入节点串味) */
const nodeClients = new WeakMap<object, SdkHeliaIpfsClient>();
/** 传给 SDK 工厂的超时 (秒) */
const SDK_TIMEOUT_SEC = 30;
/** 最近一次启动失败的真实原因 (给 UI/探针看) */
let lastStartError: string | null = null;
/** 并发 start 去重 (两次 startMobileHelia 同时进来只建一次) */
let startPromise: Promise<CreateMobileHeliaResult> | null = null;

/** 从节点上读 PeerID 字符串 (失败 undefined)。真 helia 未 start 时读 libp2p 会抛 NotStartedError → undefined */
function peerIdOf(node: MobileHeliaNode | null | undefined): string | undefined {
  try {
    const s = node?.libp2p?.peerId?.toString?.();
    return typeof s === 'string' && s ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安全取 libp2p: 真 helia 在 helia.start() 之前 `helia.libp2p` 的 getter 会抛
 * NotStartedError('Not started') —— 这里吞成 error 串而不是让整个流程炸掉。
 */
function libp2pOf(node: MobileHeliaNode | null | undefined): { libp2p?: MobileLibp2p; error?: string } {
  try {
    const l = node?.libp2p as MobileLibp2p | undefined;
    return l ? { libp2p: l } : { error: 'libp2p 不存在' };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

/** libp2p 状态字符串 (永不抛) —— 供 heliaStatus / 启动校验使用 */
function libp2pStatusOf(node: MobileHeliaNode | null | undefined): string {
  const { libp2p, error } = libp2pOf(node);
  if (!libp2p) return error ? `not-created(${error})` : 'none';
  try {
    if (typeof libp2p.status === 'string') return libp2p.status;
    if (typeof libp2p.isStarted === 'function') return libp2p.isStarted() ? 'started' : 'stopped';
    return 'unknown';
  } catch (err) {
    return `error:${errMsg(err)}`;
  }
}

/**
 * 启动后校验 (唯一"算成功"的标准): peerId 非空 **且** libp2p 真的 started。
 * 不满足 → 返回真实原因 (message/stack + libp2p 状态), 交给调用方返回 ok:false。
 */
function verifyStarted(node: MobileHeliaNode): { peerId?: string; error?: string } {
  const peerId = peerIdOf(node);
  const lps = libp2pStatusOf(node);
  if (!peerId) {
    const { error } = libp2pOf(node);
    return {
      error: `libp2p 未就绪: PeerID 为空 (libp2pStatus=${lps}${error ? `, ${error}` : ''}, heliaStatus=${String((node as any).status ?? 'n/a')})`,
    };
  }
  if (lps !== 'started' && lps !== 'unknown' && lps !== 'none') {
    return { error: `libp2p 未启动: status=${lps} (PeerID=${peerId})` };
  }
  return { peerId };
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

/** 拨种子地址 (逐个, 单个失败跳过)。假节点/未启动的 libp2p 没有可用的 dial → 直接跳过。 */
async function dialSeeds(node: MobileHeliaNode, addrs: string[]): Promise<void> {
  if (!addrs.length) return;
  // 用安全 getter: 真 helia 未 start 时读 node.libp2p 会抛 NotStartedError (旧代码就是在这里炸的)
  const { libp2p } = libp2pOf(node);
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
 * 高级路径专用: 自建一个 Helia 节点 (带 dhtClient / 自定义 libp2pOptions)。
 * 浏览器无 tcp → 只挂 webSockets + circuit-relay; 手机不能 listen 公网地址 → 只 listen
 * /p2p-circuit (有中继才有地址, 没中继就是空 —— 正常)。blockstore 不传 → helia 默认内存。
 * **只创建, 不 start、不读任何 getter** —— 启动/校验交给 SDK 的 HeliaIpfsClient。
 */
async function buildCustomHelia(opts: CreateMobileHeliaOpts): Promise<unknown> {
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

  const libp2pOptions: any = {
    addresses: { listen: ['/p2p-circuit'] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services,
    ...(opts.libp2pOptions || {}),
  };

  // Helia 7: createHelia 同步返回 status='stopped' 的节点 (libp2p 尚未创建)。兼容旧版返回 Promise。
  return await (heliaMod.createHelia as any)({ libp2p: libp2pOptions });
}

/**
 * 创建并 start 一个 Helia 节点 (transports: webSockets + circuitRelay; 无 tcp)。
 * 传 opts.node → 用注入节点 (测试); 否则动态 import('helia') 建真节点。
 * 失败**不抛**, 返回 { ok:false, error }。
 *
 * 成功标准 (严格): 节点真的 start 了 **且** peerId 非空。注意 Helia 7 的
 * createHelia() 是同步的、返回未启动节点 —— 必须显式 `await helia.start()`,
 * 否则 libp2p 根本不会被创建 (读 node.libp2p 直接抛 NotStartedError)。
 * libp2p 起不来时仍把 node 返回给调用方 (本地块能力不受影响), 但 ok:false。
 */
export async function createMobileHeliaNode(opts: CreateMobileHeliaOpts = {}): Promise<CreateMobileHeliaResult> {
  try {
    // 1) 注入节点 (测试 / 外部已建好的节点)
    if (opts.node) {
      const node = opts.node;
      // 单独 try: start 失败也要把 node 交回去, 保住本地块能力
      let startErr: unknown;
      if (typeof node.start === 'function' && node.status !== 'started') {
        try {
          await node.start();
        } catch (err) {
          startErr = err;
        }
      }
      // 即使 peerId 缺失也先拨种子 (拿不到 dial 会跳过), 再把真实结论返回
      await dialSeeds(node, (opts.seedAddrs || []).filter(isWsCapableAddr));
      if (startErr !== undefined) {
        return {
          ok: false,
          node,
          error: `节点 start() 失败: ${errDetail(startErr)} (libp2pStatus=${libp2pStatusOf(node)})`,
        };
      }
      const v = verifyStarted(node);
      if (v.error) return { ok: false, node, error: v.error };
      return { ok: true, node, peerId: v.peerId };
    }

    // 2) 真节点: 经 @diap/sdk/helia 的 HeliaIpfsClient 创建 (0.2.7 已修 "未 start 就读 getter" 的坑)
    //    必须用**动态** import —— iOS 的 ES2024 垫片是本模块顶层语句; 静态 import 会在模块体
    //    之前求值, 垫片就晚了 (上次 WebView 挂掉的根因之一)。
    const sdk = await import('@diap/sdk/helia');
    const seedAddrs = (opts.seedAddrs || []).filter(isWsCapableAddr);

    let client: SdkHeliaIpfsClient;
    if (opts.dhtClient || opts.libp2pOptions) {
      // 高级路径: 自建 helia 配置, 用 fromHelia 包成 SDK 客户端。
      // fromHelia 不读任何 libp2p getter; 随后的 start() 内部先 await helia.start() 再校验。
      const helia = await buildCustomHelia(opts);
      client = sdk.HeliaIpfsClient.fromHelia(helia as any);
    } else if (seedAddrs.length > 0) {
      // 有种子 → SDK 工厂: 自带 circuitRelayTransport + listen /p2p-circuit, start 成功后才拨种子
      client = await sdk.HeliaIpfsClient.newWithRemoteNode(seedAddrs, null, SDK_TIMEOUT_SEC);
    } else {
      client = await sdk.HeliaIpfsClient.newPublicOnly(SDK_TIMEOUT_SEC);
    }

    // ★ 唯一成功判据: SDK 硬化校验 `getStartResult().ok === true`
    //   (SDK 内部已确认 peerId 非空 **且** libp2p.status === 'started', 且读 getter 全在 start 之后)
    const started = client.getStartResult() ?? (await client.start());
    const node = (client.getHelia() as unknown as MobileHeliaNode | null) ?? undefined;
    if (!started.ok) {
      return {
        ok: false,
        node,
        error: `${started.error ?? 'libp2p 未就绪'} (libp2pStatus=${String(started.libp2pStatus)}) ${envHint()}`,
      };
    }
    if (!node) {
      return {
        ok: false,
        error: `Helia 已启动但没有节点实例 (libp2pStatus=${String(started.libp2pStatus)}) ${envHint()}`,
      };
    }

    // 记下 节点 → SDK 客户端, 供 heliaAddJson / heliaGetJson 走 SDK 的 upload/get
    nodeClients.set(node as object, client);
    return { ok: true, node, peerId: started.peerId ?? peerIdOf(node) };
  } catch (err) {
    // 建节点/加载依赖阶段的真实错误 (message + stack)
    return { ok: false, error: `建 Helia 节点失败: ${errDetail(err)} ${envHint()}` };
  }
}

// ─────────────────────────── 生命周期 (幂等) ───────────────────────────

async function doStart(cfg: StartMobileHeliaConfig): Promise<CreateMobileHeliaResult> {
  // 上一次没起来的半成品节点先清掉, 避免重复 start 时泄漏一个 live libp2p/datastore。
  // (注入节点路径不清 —— 由调用方/测试自己管)
  if (currentNode && !cfg.node) {
    try {
      await currentNode.stop?.();
    } catch {
      /* 半成品停不掉也不影响重建 */
    }
    currentNode = null;
    currentPeerId = null;
  }

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

  // ★ 只要拿到了节点就先装上 —— libp2p 起不来也要保住本地块能力 (add/get 走 blockstore)。
  if (res.node) {
    currentNode = res.node;
    currentPeerId = res.peerId ?? peerIdOf(res.node) ?? null;
  }

  // ★ 但只有「peerId 非空 + libp2p 真 started」才算成功, 否则透出真实错误。
  if (!res.ok || !res.peerId) {
    const error =
      res.error ??
      `libp2p 未就绪: PeerID 为空 (libp2pStatus=${libp2pStatusOf(res.node ?? currentNode)}) ${envHint()}`;
    lastStartError = error;
    return { ok: false, node: res.node, error };
  }

  lastStartError = null;
  return { ok: true, node: res.node, peerId: res.peerId };
}

/**
 * 启动手机 Helia 节点。**幂等**: 已「真起来」(peerId 非空) 直接返回现有节点, 不重建。
 * 半启动 (有节点没 peerId) 时会重试一次启动 (先停掉半成品)。
 * 无 seedAddrs → 自动用 mobile-p2p 已保存地址 (过滤非 /ws); 允许空列表启动
 * (能启动, 只是暂时没有对端)。
 */
export async function startMobileHelia(cfg: StartMobileHeliaConfig = {}): Promise<CreateMobileHeliaResult> {
  if (currentNode && currentPeerId) {
    return { ok: true, node: currentNode, peerId: currentPeerId };
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
  lastStartError = null;
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
 * 真节点 (有 SDK 客户端) → 走 `HeliaIpfsClient.upload(JSON.stringify(...))`:
 *   SDK 的 upload **只接受字符串**, 且内部会把字符串 JSON.parse 回对象再做 dag-cbor 编码,
 *   CID 与 computeCid() 完全一致 (已实测同值)。SDK 失败(不抛)时退回本地块路径。
 * 注入假节点 / 真节点起不来 → 走本地: CID 用 mobile-ipfs.computeCid() 算
 *   (dag-cbor + sha2-256 + CIDv1, 与桌面端逐字一致), 写入的字节就是同一份 dag-cbor 编码。
 * 失败不抛。
 */
export async function heliaAddJson(obj: unknown): Promise<AddJsonResult> {
  try {
    const node = currentNode;
    if (!node) return { ok: false, error: 'Helia 节点未启动 (请先 startMobileHelia)' };

    const client = nodeClients.get(node as object);
    if (client) {
      const r = await client.upload(JSON.stringify(jsonClean(obj)));
      if (r.ok && r.cid) return { ok: true, cid: r.cid };
      // 不 ok 也不抛 —— 落到本地块路径, 保住"本地块能力不受 libp2p 影响"的不变式
    }

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

  const from: 'local' | 'network' = local ? 'local' : 'network';

  // 真节点: 走 SDK 客户端的 get (blockstore → 网络 → 网关, 且网关字节会做 multihash 校验)。
  // SDK 的 content 对非字符串值会 JSON.stringify → 这里尝试解析回对象, 解析不了就当字符串。
  const client = nodeClients.get(node as object);
  if (client) {
    const r = await client.get(parsed.toString());
    if (!r.ok) return { ok: false, from, error: r.error ?? '读取失败' };
    let value: unknown = r.content;
    try {
      value = JSON.parse(r.content);
    } catch {
      value = r.content;
    }
    return { ok: true, value, from: local || r.source === 'blockstore' ? 'local' : 'network' };
  }

  try {
    const bytes = await collectBytes(node.blockstore.get(parsed));
    const value = dagCbor.decode(bytes);
    return { ok: true, value, from };
  } catch (err) {
    return { ok: false, from, error: errMsg(err) };
  }
}

// ─────────────────────────── 状态 ───────────────────────────

/**
 * 节点状态: running / PeerID / 已连接 peers / blockstore 块数 / libp2p 真实状态 / 最近启动错误。
 * 失败不抛。`running` 以 libp2p 真实状态为准 (有 libp2p 就必须 started); 没有 libp2p 的
 * 纯本地块节点才退回看 node.status。
 */
export async function heliaStatus(): Promise<HeliaStatusResult> {
  const node = currentNode;
  if (!node) {
    const out: HeliaStatusResult = {
      ok: true,
      running: false,
      peers: [],
      libp2pStatus: 'not-created',
    };
    if (lastStartError) out.lastError = lastStartError;
    return out;
  }
  try {
    const { libp2p, error: libp2pError } = libp2pOf(node);
    const libp2pStatus = libp2pStatusOf(node);
    const peerId = currentPeerId ?? peerIdOf(node);
    // 有 libp2p → 以它的状态为准; 没有 libp2p (纯本地块/假节点) → 看 node.status
    const running = libp2pError ? false : libp2p ? libp2pStatus === 'started' : node.status === 'started';

    let peers: string[] = [];
    try {
      const list = libp2p?.getPeers?.() || [];
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

    const out: HeliaStatusResult = { ok: true, running, peers, libp2pStatus };
    if (peerId) out.peerId = peerId;
    if (blockCount !== undefined) out.blockCount = blockCount;
    if (lastStartError) out.lastError = lastStartError;
    // 能拿到 libp2p 但状态异常时, 也把原因写进 error 供 UI 直接显示
    if (!peerId && libp2pError) out.error = `libp2p 未就绪: ${libp2pError}`;
    return out;
  } catch (err) {
    const out: HeliaStatusResult = {
      ok: false,
      running: false,
      peers: [],
      libp2pStatus: libp2pStatusOf(node),
      error: errDetail(err),
    };
    if (lastStartError) out.lastError = lastStartError;
    return out;
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
