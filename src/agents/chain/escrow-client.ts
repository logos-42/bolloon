/**
 * escrow-client.ts — AgentEscrow v2 的链桥客户端 (P3: Bolloon 链桥)
 *
 * 职责 (只有这些, 不做判断):
 *   · 用 ethers v6 调 AgentEscrow v2 的 4 个写方法:
 *       createEscrowV2 / submitProofV2 / releaseV2 / claimAfterTimeoutV2
 *   · 读 escrow 结构 (19 字段) 与链上 hash 复算入口
 *   · 听 5 个 v2 事件
 *   · 读 receipt / 数确认数 (把"链上到底成没成"的**原始事实**拿出来)
 *
 * 它**不判断**"算不算已结算" —— 那是 chain-settlement.ts 的事。
 * 这样客户端能随便换 provider 做测试, 而判定逻辑只有一份。
 *
 * 两个必须照做的本机坑:
 *   ① `new JsonRpcProvider(url, null, { cacheTimeout: -1 })`:
 *      ethers v6 默认缓存 eth_getTransactionCount/eth_blockNumber 250ms。
 *      本地链瞬时出块 → 第二笔交易会拿旧 nonce → "nonce has already been used"。
 *      构造入口统一走 `createJsonRpcProvider()`, 不散落在调用方。
 *   ② signer / provider **可注入**: 测试要能用假 provider 造重组 / 掉 RPC,
 *      而不能真的去连网。
 */

import {
  JsonRpcProvider,
  Contract,
  Interface,
  Wallet,
  AbiCoder,
  encodeBytes32String,
  keccak256,
  type Provider,
  type Signer,
  type TransactionReceipt,
} from 'ethers';
import {
  loadChainConfig,
  readWalletPrivateKey,
  DEFAULT_CONFIRMATIONS,
  LOCAL_DEV_CHAIN_ID,
  type ChainConfig,
  type ChainConfirmations,
} from './chain-config.js';

// ── 冻结 hash 口径 (与 AgentEscrow.sol / MODEL_FREEZE.md §4 逐字一致) ─────────

export const TAG_TASK = encodeBytes32String('bolloon.task.v1'); // "bolloon.task.v1" → bytes32
const ABICODER = AbiCoder.defaultAbiCoder();

/** taskKey = keccak256(abi.encode(bytes32("bolloon.task.v1"), taskId)) */
export function computeTaskKeyOffChain(taskId: string): string {
  return keccak256(ABICODER.encode(['bytes32', 'string'], [TAG_TASK, taskId]));
}
/** v1 过渡兼容键 = keccak256(utf8(taskId)) */
export function computeLegacyTaskKeyOffChain(taskId: string): string {
  return keccak256(new TextEncoder().encode(taskId));
}
/** resultHash/inputHash/manifestHash = keccak256(utf8("sha256:<hex>")) */
export function computeResultHashOffChain(sha256Digest: string): string {
  return keccak256(new TextEncoder().encode(String(sha256Digest)));
}
/** proofHash = keccak256(abi.encode(bytes32("bolloon.proof.v1"), resultHash, proofVersion)) */
export function computeProofHashOffChain(resultHash: string, proofVersion: number): string {
  return keccak256(ABICODER.encode(
    ['bytes32', 'bytes32', 'uint16'],
    [encodeBytes32String('bolloon.proof.v1'), resultHash, proofVersion],
  ));
}

/** EscrowState 枚举名 (与合约顺序一致) */
export const ESCROW_STATES = ['ACTIVE', 'RELEASED', 'DISPUTED', 'REFUNDED'] as const;
export type EscrowStateName = typeof ESCROW_STATES[number];

export interface EscrowStruct {
  buyer: string;
  agent: string;
  amount: bigint;
  state: number;
  stateName: EscrowStateName | 'UNKNOWN';
  createdAt: bigint;
  proofHash: string;
  taskKey: string;
  termsHash: string;
  quoteHash: string;
  inputHash: string;
  resultHash: string;
  manifestHash: string;
  chainId: bigint;
  contractVersion: number;
  createdBlock: number;
  deadline: bigint;
  confirmationWindow: number;
  paymentAsset: string;
  proofVersion: number;
}

// ── ABI (只嵌 v2 面 + 复算入口 + 5 个 v2 事件; 不改合约, 只是本地 ABI 视图) ────

export const AGENT_ESCROW_V2_ABI = [
  // ── 写 ──
  'function createEscrowV2(bytes32 taskKey, address agent, uint256 amount, address paymentAsset, bytes32 termsHash, bytes32 quoteHash, bytes32 inputHash, bytes32 manifestHash, uint64 deadline, uint32 confirmationWindow, uint16 proofVersion) returns (bytes32)',
  'function submitProofV2(bytes32 taskKey, bytes32 resultHash, bytes32 manifestHash, uint16 proofVersion) returns (bytes32 proofHash)',
  'function releaseV2(bytes32 taskKey)',
  'function claimAfterTimeoutV2(bytes32 taskKey)',
  'function disputeV2(bytes32 taskKey, bytes32 reasonHash)',
  'function refundV2(bytes32 taskKey, bytes32 reasonHash)',
  'function releaseAfterArbitrationV2(bytes32 taskKey)',
  // ── 读 ──
  'function escrows(bytes32 taskKey) view returns (tuple(address buyer, address agent, uint256 amount, uint8 state, uint256 createdAt, bytes32 proofHash, bytes32 taskKey, bytes32 termsHash, bytes32 quoteHash, bytes32 inputHash, bytes32 resultHash, bytes32 manifestHash, uint256 chainId, uint32 contractVersion, uint64 createdBlock, uint64 deadline, uint32 confirmationWindow, address paymentAsset, uint16 proofVersion))',
  'function claimableAt(bytes32 taskKey) view returns (uint256)',
  'function balance() view returns (uint256)',
  'function token() view returns (address)',
  'function releaseTimeout() view returns (uint256)',
  'function CONTRACT_VERSION() view returns (uint32)',
  // P4 追加的只读视图 (与 contracts/deployments/abis/AgentEscrow.json 逐字一致; 只加读, 不改写面)
  'function expireGrace() view returns (uint256)',
  'function DEFAULT_EXPIRE_GRACE() view returns (uint256)',
  'function expireAt(bytes32 taskKey) view returns (uint256)',
  'function owner() view returns (address)',
  'function taskIds(uint256 index) view returns (bytes32)',
  // ── 链上复算入口 ──
  'function computeTaskKey(string taskId) pure returns (bytes32)',
  'function computeLegacyTaskKey(string taskId) pure returns (bytes32)',
  'function computeResultHash(string sha256Digest) pure returns (bytes32)',
  'function computeProofHash(bytes32 resultHash, uint16 proofVersion) pure returns (bytes32)',
  // ── 5 个 v2 事件 ──
  'event EscrowCreatedV2(bytes32 indexed taskKey, bytes32 indexed quoteHash, address indexed buyer, address agent, address paymentAsset, uint256 amount, uint256 deadline, uint32 confirmationWindow, uint16 proofVersion, uint32 contractVersion)',
  'event ProofSubmittedV2(bytes32 indexed taskKey, bytes32 resultHash, bytes32 manifestHash, bytes32 proofHash, uint16 proofVersion)',
  'event ReleasedV2(bytes32 indexed taskKey, address to, uint256 amount, uint8 by)',
  'event RefundedV2(bytes32 indexed taskKey, address to, uint256 amount, bytes32 reasonHash)',
  'event DisputedV2(bytes32 indexed taskKey, address by, bytes32 reasonHash)',
] as const;

export const V2_EVENT_NAMES = ['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2', 'RefundedV2', 'DisputedV2'] as const;
export type V2EventName = typeof V2_EVENT_NAMES[number];

export interface RawLog { address: string; topics: readonly string[]; data: string; blockNumber?: number; index?: number }

export interface TxOutcome {
  /** 空字符串 = 交易**根本没发出去** (estimateGas/revert 在广播前失败) */
  txHash: string;
  blockNumber: number | null;
  gasUsed: string | null;
  /** 1 = 成功, 0 = reverted, null = 还没拿到 receipt */
  status: number | null;
  reverted: boolean;
  logs: RawLog[];
  broadcast: boolean;
  error?: string;
}

export interface CreateEscrowV2Params {
  taskKey: string;
  agent: string;
  amount: bigint;
  paymentAsset: string;
  termsHash: string;
  quoteHash: string;
  inputHash: string;
  manifestHash: string;
  deadline: bigint | number;
  confirmationWindow: number;
  proofVersion: number;
}

export interface EscrowClientOptions {
  /** 注入 provider (测试); 不给则用 cfg.rpcUrl 建 JsonRpcProvider */
  provider?: Provider;
  /** 注入 signer (测试); 不给则用 config 解析出的本机钱包 */
  signer?: Signer;
  config?: ChainConfig;
  /** 直接给 rpc/escrow (省一层 config) */
  rpcUrl?: string;
  escrowAddress?: string;
  confirmations?: ChainConfirmations;
}

/** ★ 唯一的 provider 构造入口 (cacheTimeout: -1 是本机链的硬要求)
 *  注: ethers v6 的 TS 签名把 network 标成 `Networkish | undefined`, 但运行时支持 `null`
 *  (部署脚本 scripts/deploy.js 一直这么用)。这里保留 `null` 的运行时语义并显式转型,
 *  不改成本地默认值 —— 本地瞬时出块不缓存 nonce 才是要点。 */
export function createJsonRpcProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, null as unknown as undefined, { cacheTimeout: -1 });
}

export class EscrowClient {
  readonly provider: Provider;
  readonly escrowAddress: string;
  readonly confirmations: ChainConfirmations;
  readonly iface: Interface;
  readonly chainId: number | undefined;
  private readonly injectedSigner?: Signer;

  constructor(opts: EscrowClientOptions = {}) {
    let cfg = opts.config;
    if (!cfg && (opts.rpcUrl || opts.escrowAddress)) {
      // 允许只给部分字段的轻量构造 (测试): 缺的用默认值填, 但地址必须有
      cfg = {
        chainId: LOCAL_DEV_CHAIN_ID, networkName: 'unknown', rpcUrl: opts.rpcUrl || '',
        escrowAddress: opts.escrowAddress || '', tokenAddress: null, tokenDecimals: 6,
        confirmations: opts.confirmations || DEFAULT_CONFIRMATIONS, sources: {},
      };
    }
    if (!cfg) cfg = loadChainConfig();
    if (!cfg.escrowAddress) throw new Error('EscrowClient: 缺 escrowAddress (给 config 或 escrowAddress)');

    this.escrowAddress = cfg.escrowAddress;
    this.confirmations = opts.confirmations || cfg.confirmations || DEFAULT_CONFIRMATIONS;
    this.chainId = cfg.chainId || undefined;
    this.iface = new Interface(AGENT_ESCROW_V2_ABI as unknown as string[]);
    this.injectedSigner = opts.signer;

    if (opts.provider) this.provider = opts.provider;
    else if (cfg.rpcUrl) this.provider = createJsonRpcProvider(cfg.rpcUrl);
    else throw new Error('EscrowClient: 既没注入 provider, 也没给 rpcUrl');
  }

  /** 只读合约 (事件过滤 / 读结构都走它) */
  get readContract(): Contract {
    return new Contract(this.escrowAddress, AGENT_ESCROW_V2_ABI as unknown as string[], this.provider);
  }

  /** 造一个连着 signer 的合约 (写路径) */
  contractWith(signer: Signer): Contract {
    return new Contract(this.escrowAddress, AGENT_ESCROW_V2_ABI as unknown as string[], signer);
  }

  /**
   * 本机钱包 signer。私钥只在这里的局部变量里存在一瞬, 不返回给外部。
   * 注: 真正的"允不允许签"由 chain-wallet.ts 的放行闸决定 —— 本方法只负责造对象。
   */
  localSigner(opts: { home?: string } = {}): Signer {
    if (this.injectedSigner) return this.injectedSigner;
    const { privateKey } = readWalletPrivateKey({ home: opts.home });
    return new Wallet(privateKey, this.provider);
  }

  // ── 读: escrow 结构 ────────────────────────────────────────────────────────

  private normalizeEscrow(raw: any): EscrowStruct {
    const state = Number(raw.state);
    return {
      buyer: raw.buyer,
      agent: raw.agent,
      amount: BigInt(raw.amount),
      state,
      stateName: (ESCROW_STATES[state] as EscrowStateName) || 'UNKNOWN',
      createdAt: BigInt(raw.createdAt),
      proofHash: raw.proofHash,
      taskKey: raw.taskKey,
      termsHash: raw.termsHash,
      quoteHash: raw.quoteHash,
      inputHash: raw.inputHash,
      resultHash: raw.resultHash,
      manifestHash: raw.manifestHash,
      chainId: BigInt(raw.chainId),
      contractVersion: Number(raw.contractVersion),
      createdBlock: Number(raw.createdBlock),
      deadline: BigInt(raw.deadline),
      confirmationWindow: Number(raw.confirmationWindow),
      paymentAsset: raw.paymentAsset,
      proofVersion: Number(raw.proofVersion),
    };
  }

  /** 读 escrow; 不存在 (buyer == 0) → null (不假装读到了一条空 escrow) */
  async getEscrow(taskKey: string): Promise<EscrowStruct | null> {
    const raw = await this.readContract.escrows(taskKey);
    const e = this.normalizeEscrow(raw);
    if (/^0x0{40}$/i.test(String(e.buyer))) return null;
    return e;
  }

  async balance(): Promise<bigint> {
    return BigInt(await this.readContract.balance());
  }
  async tokenAddress(): Promise<string> {
    return await this.readContract.token();
  }
  async contractVersion(): Promise<number> {
    return Number(await this.readContract.CONTRACT_VERSION());
  }
  async claimableAt(taskKey: string): Promise<bigint> {
    return BigInt(await this.readContract.claimableAt(taskKey));
  }
  /** P4: 托管过期宽限期 (秒) 与单条 taskKey 的过期时间 (只读) */
  async expireGrace(): Promise<bigint> {
    return BigInt(await this.readContract.expireGrace());
  }
  async defaultExpireGrace(): Promise<bigint> {
    return BigInt(await this.readContract.DEFAULT_EXPIRE_GRACE());
  }
  async expireAt(taskKey: string): Promise<bigint> {
    return BigInt(await this.readContract.expireAt(taskKey));
  }
  async owner(): Promise<string> {
    return await this.readContract.owner();
  }
  /** 链上任务数组的第 index 个 taskKey (越界会 revert; 调用方自己 try/catch) */
  async taskIdAt(index: number): Promise<string> {
    return await this.readContract.taskIds(index);
  }
  async releaseTimeout(): Promise<bigint> {
    return BigInt(await this.readContract.releaseTimeout());
  }

  /** 链上复算入口 (交叉核对口径用; 与本地复算不一致 = 口径漂了) */
  async computeTaskKey(taskId: string): Promise<string> { return await this.readContract.computeTaskKey(taskId); }
  async computeLegacyTaskKey(taskId: string): Promise<string> { return await this.readContract.computeLegacyTaskKey(taskId); }
  async computeResultHash(sha256Digest: string): Promise<string> { return await this.readContract.computeResultHash(sha256Digest); }
  async computeProofHash(resultHash: string, proofVersion: number): Promise<string> {
    return await this.readContract.computeProofHash(resultHash, proofVersion);
  }

  // ── 读: receipt / 确认数 ──────────────────────────────────────────────────

  /** 读 receipt; 读不到 (未打包 / RPC 报错) → null。异常原样抛出由调用方区分"没有"和"读不到"。 */
  async getReceipt(txHash: string): Promise<TransactionReceipt | null> {
    return await (this.provider as any).getTransactionReceipt(txHash);
  }

  async getLatestBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  /**
   * 确认数 = latestBlock - receipt.blockNumber + 1。
   * 读不到 receipt 或 latestBlock → 抛错 (调用方必须如实报"不知道")。
   */
  async confirmationsOf(txHash: string): Promise<{ confirmations: number; blockNumber: number; latestBlock: number }> {
    const rc = await this.getReceipt(txHash);
    if (!rc) throw new Error(`tx 还没上链 (拿不到 receipt): ${txHash}`);
    const latestBlock = await this.getLatestBlockNumber();
    return { confirmations: latestBlock - rc.blockNumber + 1, blockNumber: rc.blockNumber, latestBlock };
  }

  /** 交易被哪个块打包 (重组检测用: 同一个 tx 换块 = 提示) */
  async transactionBlockNumber(txHash: string): Promise<number | null> {
    const tx = await (this.provider as any).getTransaction(txHash);
    return tx ? Number(tx.blockNumber) : null;
  }

  // ── 写 (全部返回 TxOutcome; 失败如实报, 不抛成"成功") ──────────────────────

  private async send(fn: (c: Contract) => Promise<any>, signer: Signer): Promise<TxOutcome> {
    const c = this.contractWith(signer);
    let tx: any = null;
    try {
      tx = await fn(c);
    } catch (e: any) {
      // 广播前就失败 (estimateGas / 非白名单) → 没有 txHash, 如实报"没发出去"
      const hash = e?.transaction?.hash || e?.receipt?.hash || '';
      if (!hash) {
        return { txHash: '', blockNumber: null, gasUsed: null, status: null, reverted: false, logs: [], broadcast: false, error: String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 300) };
      }
      // 有 hash: 交易确实发出去了
      const rc = e?.receipt as TransactionReceipt | undefined;
      return {
        txHash: hash, blockNumber: rc?.blockNumber ?? null, gasUsed: rc ? rc.gasUsed.toString() : null,
        status: rc ? Number(rc.status) : null, reverted: rc ? Number(rc.status) === 0 : false,
        logs: (rc as any)?.logs ?? [], broadcast: true,
        error: String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 300),
      };
    }
    const txHash: string = tx.hash;
    try {
      const rc: TransactionReceipt | null = await tx.wait();
      if (!rc) {
        return { txHash, blockNumber: null, gasUsed: null, status: null, reverted: false, logs: [], broadcast: true, error: 'receipt 为空 (还没打包?)' };
      }
      return {
        txHash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
        status: Number(rc.status), reverted: Number(rc.status) === 0,
        logs: (rc as any).logs ?? [], broadcast: true,
      };
    } catch (e: any) {
      // ethers v6: status 0 时 tx.wait() 会抛, 但 e.receipt 带着真 receipt
      const rc = e?.receipt as TransactionReceipt | undefined;
      return {
        txHash, blockNumber: rc?.blockNumber ?? null, gasUsed: rc ? rc.gasUsed.toString() : null,
        status: rc ? Number(rc.status) : null, reverted: rc ? Number(rc.status) === 0 : false,
        logs: (rc as any)?.logs ?? [], broadcast: true,
        error: String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 300),
      };
    }
  }

  async createEscrowV2(p: CreateEscrowV2Params, signer: Signer): Promise<TxOutcome> {
    return this.send((c) => c.createEscrowV2(
      p.taskKey, p.agent, p.amount, p.paymentAsset, p.termsHash, p.quoteHash, p.inputHash, p.manifestHash,
      p.deadline, p.confirmationWindow, p.proofVersion,
    ), signer);
  }

  async submitProofV2(taskKey: string, resultHash: string, manifestHash: string, proofVersion: number, signer: Signer): Promise<TxOutcome> {
    return this.send((c) => c.submitProofV2(taskKey, resultHash, manifestHash, proofVersion), signer);
  }

  async releaseV2(taskKey: string, signer: Signer): Promise<TxOutcome> {
    return this.send((c) => c.releaseV2(taskKey), signer);
  }

  async claimAfterTimeoutV2(taskKey: string, signer: Signer): Promise<TxOutcome> {
    return this.send((c) => c.claimAfterTimeoutV2(taskKey), signer);
  }

  async disputeV2(taskKey: string, reasonHash: string, signer: Signer): Promise<TxOutcome> {
    return this.send((c) => c.disputeV2(taskKey, reasonHash), signer);
  }

  /** 静态调用 (不花 gas 地读 revert reason; F2 门槛类断言用) */
  async staticCallClaimAfterTimeout(taskKey: string, from?: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const data = this.iface.encodeFunctionData('claimAfterTimeoutV2', [taskKey]);
      await (this.provider as any).call({ to: this.escrowAddress, from, data });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.reason || e?.shortMessage || String(e?.message || e).slice(0, 200) };
    }
  }

  // ── 5 个 v2 事件监听 ──────────────────────────────────────────────────────

  /** 只认本合约发出的、topic 匹配的日志 (别的合约发出的一律不算) */
  private escrowLogsOf(outcome: TxOutcome): RawLog[] {
    return (outcome.logs || []).filter(
      (l) => String(l.address).toLowerCase() === this.escrowAddress.toLowerCase(),
    );
  }

  /** 把一笔 receipt 的日志里属于本合约的、指定 v2 事件的解码出来 */
  decodeV2Events(outcome: TxOutcome, eventName?: V2EventName): Array<{ name: string; args: Record<string, any>; log: RawLog }> {
    const out: Array<{ name: string; args: Record<string, any>; log: RawLog }> = [];
    for (const log of this.escrowLogsOf(outcome)) {
      let parsed: any;
      try {
        parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
      } catch { continue; }
      if (!parsed) continue;
      if (eventName && parsed.name !== eventName) continue;
      const args: Record<string, any> = {};
      parsed.fragment.inputs.forEach((inp: any, i: number) => { args[inp.name] = parsed.args[i]; });
      out.push({ name: parsed.name, args, log });
    }
    return out;
  }

  /** 用**我们自己的 Interface** 从原始日志解码 (不依赖 ethers 传参形状) */
  private decodeLogArgs(eventName: V2EventName, log: RawLog): Record<string, any> | null {
    const frag = this.iface.getEvent(eventName as string);
    if (!frag || !log?.topics) return null;
    try {
      const decoded: any = this.iface.decodeEventLog(frag, log.data, [...log.topics]);
      const args: Record<string, any> = {};
      frag.inputs.forEach((inp: any, i: number) => { args[inp.name] = decoded[i]; });
      return args;
    } catch { return null; }
  }

  /**
   * 监听某个 v2 事件。可给 taskKey 过滤 (链上 indexed 字段, 在回调里核对)。
   * 返回取消订阅函数 —— 调用方必须能干净地摘掉监听 (否则重启会叠加)。
   *
   * 实现说明 (踩过的坑): 把 `contract.filters.X(...)` 这种 Filter 对象交给
   * `contract.on()` 时, ethers v6 会把 fragment 解析成 null, 于是回调只收到一个
   * ContractEventPayload (位置参数全空)。所以这里用**事件名字符串**注册, 自己按
   * topic0/taskKey 过滤, 并从原始 log 用本地 Interface 解码 —— 参数形状永远一致。
   */
  onV2Event(eventName: V2EventName, handler: (args: Record<string, any>, raw: RawLog) => void, filter?: { taskKey?: string }): () => void {
    const contract = this.readContract;
    const frag = this.iface.getEvent(eventName as string);
    if (!frag) throw new Error(`AgentEscrow ABI 里没有事件 ${eventName}`);
    const topic0 = String(frag.topicHash).toLowerCase();
    const wantKey = filter?.taskKey ? String(filter.taskKey).toLowerCase() : null;
    const selfAddr = this.escrowAddress.toLowerCase();

    const listener = (...a: any[]) => {
      const payload: any = a[a.length - 1];
      const log: RawLog | undefined = payload?.log ?? (payload?.topics ? (payload as RawLog) : undefined);
      // 只认本合约 + 本事件 topic0 (别的合约/别的事件一律不算)
      if (log?.address && String(log.address).toLowerCase() !== selfAddr) return;
      if (log?.topics?.[0] && String(log.topics[0]).toLowerCase() !== topic0) return;
      // taskKey 过滤 (indexed topic1)
      if (wantKey && log?.topics?.[1] && String(log.topics[1]).toLowerCase() !== wantKey) return;
      let args = log ? this.decodeLogArgs(eventName, log) : null;
      if (!args) {
        args = {};
        frag.inputs.forEach((inp: any, i: number) => { args![inp.name] = a[i]; });
        if (wantKey && String(args!.taskKey || '').toLowerCase() !== wantKey) return;
      }
      try { handler(args, log as RawLog); } catch { /* 监听回调不许炸主流程 */ }
    };

    contract.on(eventName as string, listener); // ethers v6: 返回 Promise, 订阅失败不抛同步异常
    const swallow = (r: any) => { if (r && typeof r.catch === 'function') r.catch(() => { /* 订阅不可用 (假 provider / 无 websocket) 时不许炸 */ }); };
    return () => { try { swallow(contract.off(eventName as string, listener)); } catch { /* 已摘 */ } };
  }

  onEscrowCreatedV2(h: (args: Record<string, any>, raw: RawLog) => void, f?: { taskKey?: string }) { return this.onV2Event('EscrowCreatedV2', h, f); }
  onProofSubmittedV2(h: (args: Record<string, any>, raw: RawLog) => void, f?: { taskKey?: string }) { return this.onV2Event('ProofSubmittedV2', h, f); }
  onReleasedV2(h: (args: Record<string, any>, raw: RawLog) => void, f?: { taskKey?: string }) { return this.onV2Event('ReleasedV2', h, f); }
  onRefundedV2(h: (args: Record<string, any>, raw: RawLog) => void, f?: { taskKey?: string }) { return this.onV2Event('RefundedV2', h, f); }
  onDisputedV2(h: (args: Record<string, any>, raw: RawLog) => void, f?: { taskKey?: string }) { return this.onV2Event('DisputedV2', h, f); }

  /** 等某个 v2 事件出现 (真等链上, 不猜); 超时 → 明确报超时, 不假装收到 */
  waitForV2Event(eventName: V2EventName, opts: { taskKey?: string; timeoutMs?: number; predicate?: (args: Record<string, any>) => boolean } = {}): Promise<{ args: Record<string, any>; raw: RawLog } | null> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise((resolve) => {
      let done = false;
      const off = this.onV2Event(eventName, (args, raw) => {
        if (done) return;
        if (opts.predicate && !opts.predicate(args)) return;
        done = true; off(); clearTimeout(timer); resolve({ args, raw });
      }, { taskKey: opts.taskKey });
      const timer = setTimeout(() => { if (done) return; done = true; off(); resolve(null); }, timeoutMs);
    });
  }

  /** 摘掉所有监听 (重启/收尾用) */
  removeAllListeners(): void {
    const swallow = (r: any) => { if (r && typeof r.catch === 'function') r.catch(() => { /* noop */ }); };
    try { swallow(this.readContract.removeAllListeners()); } catch { /* noop */ }
    try { swallow((this.provider as any).removeAllListeners?.()); } catch { /* noop */ }
  }
}
