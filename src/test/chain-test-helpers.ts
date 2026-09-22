/**
 * chain-test-helpers.ts — 链桥测试的假链 (不是测试文件, 不会被 vitest 当测试跑)
 *
 * 目的: 让"确认数门 / receipt 失败 / 事件不匹配 / 重组 / RPC 不可用"这些
 * **假链场景**能被确定地造出来, 而不用真连网 (真链场景在 scripts/verify-chain-bridge.ts)。
 *
 * 关键: 日志用**真 Interface 编码** (encodeEventLog), 所以被测代码走的是真解码路径 ——
 * 造出来的 topics/data 与链上收到的一模一样。
 */

import { Interface, JsonRpcProvider } from 'ethers';
import { AGENT_ESCROW_V2_ABI, EscrowClient } from '../agents/chain/escrow-client.js';

export const IFACE = new Interface(AGENT_ESCROW_V2_ABI as unknown as string[]);

export const ESCROW_ADDR = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const TASK_KEY = '0x' + 'ab'.repeat(32);
export const OTHER_TASK_KEY = '0x' + 'cd'.repeat(32);
export const RESULT_HASH = '0x' + '12'.repeat(32);
export const BUYER = '0x' + 'b0'.repeat(20);
export const AGENT = '0x' + 'a0'.repeat(20);

/** 真 Interface 编码出来的 ReleasedV2 日志 (= 链上格式) */
export function releasedV2Log(taskKey: string, to: string = AGENT, amount = 100_000_000n, by = 0) {
  const ev = IFACE.getEvent('ReleasedV2')!;
  const { topics, data } = IFACE.encodeEventLog(ev, [taskKey, to, amount, by]);
  return { address: ESCROW_ADDR, topics: [...topics], data, blockNumber: 0, index: 0 };
}

export function escrowCreatedV2Log(taskKey: string, quoteHash = '0x' + '33'.repeat(32)) {
  const ev = IFACE.getEvent('EscrowCreatedV2')!;
  const { topics, data } = IFACE.encodeEventLog(ev, [
    taskKey, quoteHash, BUYER, AGENT, '0x' + '55'.repeat(20), 100_000_000n, 9_999_999_999n, 3600, 1, 1,
  ]);
  return { address: ESCROW_ADDR, topics: [...topics], data, blockNumber: 0, index: 0 };
}

/** 19 字段 escrow 结构的数组形态 (顺序必须与合约 ABI 一致) */
export function escrowTuple(over: Partial<{
  buyer: string; agent: string; amount: bigint; state: number; createdAt: bigint; proofHash: string;
  taskKey: string; termsHash: string; quoteHash: string; inputHash: string; resultHash: string;
  manifestHash: string; chainId: bigint; contractVersion: number; createdBlock: number; deadline: bigint;
  confirmationWindow: number; paymentAsset: string; proofVersion: number;
}> = {}): any[] {
  return [
    over.buyer ?? BUYER, over.agent ?? AGENT, over.amount ?? 100_000_000n, over.state ?? 0,
    over.createdAt ?? 1_700_000_000n, over.proofHash ?? '0x' + '44'.repeat(32),
    over.taskKey ?? TASK_KEY, over.termsHash ?? '0x' + '66'.repeat(32), over.quoteHash ?? '0x' + '33'.repeat(32),
    over.inputHash ?? '0x' + '77'.repeat(32), over.resultHash ?? RESULT_HASH, over.manifestHash ?? '0x' + '88'.repeat(32),
    over.chainId ?? 31337n, over.contractVersion ?? 1, over.createdBlock ?? 5,
    over.deadline ?? 9_999_999_999n, over.confirmationWindow ?? 3600,
    over.paymentAsset ?? '0x' + '55'.repeat(20), over.proofVersion ?? 1,
  ];
}

export interface FakeChainOptions {
  receipt?: any | null;
  latestBlock?: number;
  /** getTransactionReceipt 抛错 (模拟 RPC 掉线) */
  receiptThrows?: string | null;
  /** getBlockNumber 抛错 */
  blockThrows?: string | null;
  escrow?: any[] | null;
  txBlockNumber?: number | null;
}

/**
 * 假 provider: 只实现被测代码真正用到的方法。
 * `call` 支持 escrows(taskKey) (读合约 escrow 状态走的就是它)。
 * 写路径需要的 getTransactionCount/estimateGas/getFeeData 也给了, 好让 Contract 的
 * populateTransaction 能跑完。
 */
export function fakeProvider(opts: FakeChainOptions = {}) {
  const p: any = {
    calls: [] as any[],
    listenerFilters: [] as any[],
    listeners: [] as Array<{ filter: any; listener: (...a: any[]) => void }>,
    async getNetwork() { return { chainId: 31337n, name: 'localhost' }; },
    async getBlockNumber() {
      if (opts.blockThrows) throw new Error(opts.blockThrows);
      return opts.latestBlock ?? 100;
    },
    async getTransactionReceipt() {
      if (opts.receiptThrows) throw new Error(opts.receiptThrows);
      return opts.receipt ?? null;
    },
    async getTransaction() {
      return opts.receipt ? { blockNumber: opts.txBlockNumber ?? opts.receipt.blockNumber } : null;
    },
    async getCode() { return '0x6000'; },
    async getTransactionCount() { return 0; },
    async getFeeData() { return { gasPrice: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; },
    async estimateGas() { return 200_000n; },
    async broadcastTransaction() { throw new Error('fakeProvider: 请用 fakeSigner 的发交易路径'); },
    async call(tx: any) {
      p.calls.push(tx);
      const sel = String(tx?.data || '').slice(0, 10);
      const escrowsSel = IFACE.getFunction('escrows')!.selector;
      if (sel === escrowsSel) {
        return IFACE.encodeFunctionResult('escrows', [opts.escrow ?? escrowTuple()]);
      }
      // 其它 view: 给个 0 值 32 字节 (测试里没断言这些)
      return '0x' + '00'.repeat(32);
    },
    on(filter: any, listener?: any) { p.listenerFilters.push(filter); if (listener) p.listeners.push({ filter, listener }); },
    off(filter?: any) { p.listenerFilters.pop(); p.listeners.pop(); },
    removeAllListeners() { p.listenerFilters = []; p.listeners = []; },
  };
  // 真 provider 的 `provider` 指向自己 (ethers Contract 靠它判断"能不能订阅事件")
  p.provider = p;
  return p;
}

export function clientWith(provider: any): EscrowClient {
  return new EscrowClient({ escrowAddress: ESCROW_ADDR, provider });
}

/**
 * 假 signer (duck-typed ContractRunner): 记录合约真正发出的 tx,
 * 好让测试断言"到底调了哪个方法、参数对不对" —— 而不只是"返回了个 hash"。
 */
export function fakeSigner(provider: any, opts: { address?: string; receipt?: any } = {}) {
  const sent: any[] = [];
  const rc = opts.receipt ?? receipt();
  const signer: any = {
    provider,
    async getAddress() { return opts.address ?? AGENT; },
    async estimateGas() { return 200_000n; },
    async call(tx: any) { return provider.call(tx); },
    async resolveName(n: string) { return n; },
    async sendTransaction(tx: any) {
      sent.push(tx);
      return { hash: rc.hash, wait: async () => rc, to: tx.to, data: tx.data };
    },
  };
  return { signer, sent, receipt: rc };
}

/** 造一笔 receipt */
export function receipt(over: { status?: number; blockNumber?: number; logs?: any[]; hash?: string } = {}) {
  return {
    hash: over.hash ?? '0x' + 'de'.repeat(32),
    status: over.status ?? 1,
    blockNumber: over.blockNumber ?? 98,
    gasUsed: 71_000n,
    logs: over.logs ?? [],
  };
}

/**
 * 一个能在**真 JsonRpcProvider** 上打桩的 JSON-RPC 节点 (不联网)。
 * 用途: 证明 `cacheTimeout: -1` 真的关掉了 ethers 的 250ms 读数缓存
 * (默认缓存会让本地瞬时出块的第 2 笔交易拿旧 nonce)。
 */
export function stubRpcNode(url = 'http://127.0.0.1:1') {
  const provider = new JsonRpcProvider(url, null, { cacheTimeout: -1 });
  const calls: Record<string, number> = {};
  (provider as any)._send = async (payload: any) => {
    const arr = Array.isArray(payload) ? payload : [payload];
    return arr.map((req: any) => {
      calls[req.method] = (calls[req.method] || 0) + 1;
      if (req.method === 'eth_chainId') return { id: req.id, result: '0x7a69' };
      if (req.method === 'eth_getTransactionCount') return { id: req.id, result: '0x1' };
      if (req.method === 'eth_blockNumber') return { id: req.id, result: '0x64' };
      return { id: req.id, error: { code: -32601, message: 'unexpected ' + req.method } };
    });
  };
  return { provider, calls };
}
