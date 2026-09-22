/**
 * chain-escrow-client.test.ts — AgentEscrow v2 客户端 (P3, ①)
 *
 * 覆盖:
 *   · provider 构造必须走 createJsonRpcProvider (`cacheTimeout: -1` 真的关掉读数缓存)
 *   · 4 个 v2 写方法真的调了对应合约方法 (校验 calldata 的 selector 与参数)
 *   · Escrow v2 结构读取 (19 字段) + 空 escrow 返回 null
 *   · 5 个 v2 事件监听可注册 / 可取消
 *   · 回调 revert: 交易发出去了但 status=0 → 如实报 reverted
 *   · 广播前失败 (estimateGas revert) → broadcast:false, 没有 txHash
 */
import { describe, it, expect } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import {
  EscrowClient, createJsonRpcProvider, computeTaskKeyOffChain, computeLegacyTaskKeyOffChain,
  computeResultHashOffChain, computeProofHashOffChain, ESCROW_STATES, AGENT_ESCROW_V2_ABI,
} from '../agents/chain/escrow-client.js';
import { V2_EVENT_NAMES } from '../agents/chain/escrow-client.js';
import {
  fakeProvider, clientWith, fakeSigner, receipt, releasedV2Log, escrowTuple, stubRpcNode,
  IFACE, ESCROW_ADDR, TASK_KEY, OTHER_TASK_KEY, ZERO_ADDR, BUYER, AGENT, RESULT_HASH,
} from './chain-test-helpers.js';

describe('provider 构造 (本机坑: cacheTimeout: -1)', () => {
  it('createJsonRpcProvider 返回 JsonRpcProvider', () => {
    const p = createJsonRpcProvider('http://127.0.0.1:8545');
    expect(p).toBeInstanceOf(JsonRpcProvider);
  });

  it('★ 真的关掉了 250ms 读数缓存: 连续两次读 nonce 发两次 RPC', async () => {
    const { provider, calls } = stubRpcNode();
    await provider.getTransactionCount(BUYER);
    await provider.getTransactionCount(BUYER);
    expect(calls['eth_getTransactionCount']).toBe(2); // 缓存开着只会是 1

    // 对照: ethers 默认 (250ms 缓存) 只会发一次
    const defaultProvider = new JsonRpcProvider('http://127.0.0.1:1', null, {});
    const defCalls: Record<string, number> = {};
    (defaultProvider as any)._send = async (payload: any) => {
      const arr = Array.isArray(payload) ? payload : [payload];
      return arr.map((req: any) => {
        defCalls[req.method] = (defCalls[req.method] || 0) + 1;
        if (req.method === 'eth_chainId') return { id: req.id, result: '0x7a69' };
        if (req.method === 'eth_getTransactionCount') return { id: req.id, result: '0x1' };
        return { id: req.id, error: { code: -32601, message: 'x' } };
      });
    };
    await defaultProvider.getTransactionCount(BUYER);
    await defaultProvider.getTransactionCount(BUYER);
    expect(defCalls['eth_getTransactionCount']).toBe(1);
  });

  it('只给 rpcUrl 时内部就用 createJsonRpcProvider', () => {
    const c = new EscrowClient({ rpcUrl: 'http://127.0.0.1:8545', escrowAddress: ESCROW_ADDR });
    expect(c.provider).toBeInstanceOf(JsonRpcProvider);
  });

  it('既没 provider 也没 rpcUrl → 报错 (不静默连默认端点)', () => {
    expect(() => new EscrowClient({ escrowAddress: ESCROW_ADDR })).toThrow();
  });
});

describe('hash 口径 (链下复算)', () => {
  it('v2 ABI 里有 4 个写方法 + 链上复算入口 + 5 个事件', () => {
    for (const fn of ['createEscrowV2', 'submitProofV2', 'releaseV2', 'claimAfterTimeoutV2', 'computeTaskKey', 'computeLegacyTaskKey', 'computeResultHash', 'computeProofHash']) {
      expect(IFACE.getFunction(fn)).toBeTruthy();
    }
    for (const ev of V2_EVENT_NAMES) expect(IFACE.getEvent(ev)).toBeTruthy();
  });

  it('本地复算与部署 manifest 记录的选择器一致 (口径没漂)', () => {
    expect(IFACE.getFunction('createEscrowV2')!.selector).toBe('0x152215b8');
    expect(IFACE.getFunction('submitProofV2')!.selector).toBe('0x9037b29b');
    expect(IFACE.getFunction('releaseV2')!.selector).toBe('0xa7997ba4');
    expect(IFACE.getFunction('claimAfterTimeoutV2')!.selector).toBe('0xa53cf2b0');
    expect(IFACE.getEvent('ReleasedV2')!.topicHash).toBe('0xa36deffda98c4c141ffb1a5e30799504534a73c91d4c864ceb78359b2d1a8105');
  });

  it('computeTaskKey / legacy / result / proof 本地复算不抛且是 bytes32', () => {
    expect(computeTaskKeyOffChain('task-1')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeLegacyTaskKeyOffChain('task-1')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeResultHashOffChain('sha256:' + 'ab'.repeat(32))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeProofHashOffChain(RESULT_HASH, 1)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeTaskKeyOffChain('a')).not.toBe(computeLegacyTaskKeyOffChain('a'));
  });
});

describe('4 个 v2 写方法 (真调合约 + 校验 calldata)', () => {
  const mkClient = (rc = receipt({ blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] })) => {
    const p = fakeProvider({ receipt: rc });
    const { signer, sent } = fakeSigner(p, { receipt: rc });
    return { client: clientWith(p), signer, sent };
  };
  const low = (s: any) => String(s).toLowerCase();

  it('createEscrowV2 → 调用 createEscrowV2 且 11 个参数按序正确', async () => {
    const { client, signer, sent } = mkClient();
    const out = await client.createEscrowV2({
      taskKey: TASK_KEY, agent: AGENT, amount: 100_000_000n, paymentAsset: '0x' + '55'.repeat(20),
      termsHash: '0x' + '66'.repeat(32), quoteHash: '0x' + '33'.repeat(32), inputHash: '0x' + '77'.repeat(32),
      manifestHash: '0x' + '88'.repeat(32), deadline: 9_999_999_999n, confirmationWindow: 3600, proofVersion: 1,
    }, signer);
    expect(out.txHash).toBe(receipt().hash);
    expect(out.broadcast).toBe(true);
    expect(out.status).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe(ESCROW_ADDR);
    const decoded = IFACE.decodeFunctionData('createEscrowV2', sent[0].data);
    expect(decoded[0]).toBe(TASK_KEY);
    expect(low(decoded[1])).toBe(low(AGENT));
    expect(decoded[2]).toBe(100_000_000n);
    expect(decoded[8]).toBe(9_999_999_999n);
    expect(Number(decoded[9])).toBe(3600);
    expect(Number(decoded[10])).toBe(1);
  });

  it('submitProofV2 / releaseV2 / claimAfterTimeoutV2 各调对的方法', async () => {
    const { client, signer, sent } = mkClient();
    await client.submitProofV2(TASK_KEY, RESULT_HASH, '0x' + '88'.repeat(32), 1, signer);
    await client.releaseV2(TASK_KEY, signer);
    await client.claimAfterTimeoutV2(TASK_KEY, signer);
    expect(sent.length).toBe(3);
    const names = sent.map((tx: any) => IFACE.parseTransaction({ data: tx.data })!.name);
    expect(names).toEqual(['submitProofV2', 'releaseV2', 'claimAfterTimeoutV2']);
    expect(IFACE.decodeFunctionData('submitProofV2', sent[0].data)[0]).toBe(TASK_KEY);
    expect(IFACE.decodeFunctionData('releaseV2', sent[1].data)[0]).toBe(TASK_KEY);
  });

  it('★ 回调 revert (status=0) → reverted:true, 但不假装没发出去', async () => {
    const { client, signer } = mkClient(receipt({ status: 0, blockNumber: 98 }));
    const out = await client.releaseV2(TASK_KEY, signer);
    expect(out.txHash).toBe(receipt().hash);
    expect(out.broadcast).toBe(true);
    expect(out.status).toBe(0);
    expect(out.reverted).toBe(true);
  });

  it('★ 广播前失败 (estimateGas revert) → broadcast:false 且没有 txHash', async () => {
    const p = fakeProvider({});
    const { signer } = fakeSigner(p);
    (signer as any).sendTransaction = async () => { throw new Error('execution reverted: no proof submitted'); };
    const client = clientWith(p);
    const out = await client.releaseV2(TASK_KEY, signer);
    expect(out.broadcast).toBe(false);
    expect(out.txHash).toBe('');
    expect(out.error).toContain('no proof submitted');
  });

  it('staticCallClaimAfterTimeout 读得到 revert reason', async () => {
    const p = fakeProvider({});
    (p as any).call = async () => { throw Object.assign(new Error('reverted'), { reason: 'no proof submitted' }); };
    const r = await clientWith(p).staticCallClaimAfterTimeout(TASK_KEY, AGENT);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no proof submitted');
  });
});

describe('读 escrow 结构 / 状态', () => {
  it('19 字段解析正确 (stateName 映射)', async () => {
    const p = fakeProvider({ escrow: escrowTuple({ state: 1, resultHash: RESULT_HASH, proofVersion: 1, deadline: 123n }) });
    const e = await clientWith(p).getEscrow(TASK_KEY);
    expect(e).not.toBeNull();
    expect(String(e!.buyer).toLowerCase()).toBe(BUYER.toLowerCase());
    expect(String(e!.agent).toLowerCase()).toBe(AGENT.toLowerCase());
    expect(e!.amount).toBe(100_000_000n);
    expect(e!.stateName).toBe('RELEASED');
    expect(e!.resultHash).toBe(RESULT_HASH);
    expect(e!.proofVersion).toBe(1);
    expect(e!.deadline).toBe(123n);
    expect(ESCROW_STATES).toEqual(['ACTIVE', 'RELEASED', 'DISPUTED', 'REFUNDED']);
  });

  it('buyer == 0 的 escrow → null (不假装读到了)', async () => {
    const p = fakeProvider({ escrow: escrowTuple({ buyer: ZERO_ADDR }) });
    expect(await clientWith(p).getEscrow(TASK_KEY)).toBeNull();
  });

  it('确认数计算 = latestBlock - blockNumber + 1', async () => {
    const p = fakeProvider({ receipt: receipt({ blockNumber: 98 }), latestBlock: 100 });
    const c = await clientWith(p).confirmationsOf('0x' + 'de'.repeat(32));
    expect(c).toEqual({ confirmations: 3, blockNumber: 98, latestBlock: 100 });
  });

  it('拿不到 receipt → 抛错 (调用方必须如实报"不知道")', async () => {
    const p = fakeProvider({ receipt: null });
    await expect(clientWith(p).confirmationsOf('0x' + 'de'.repeat(32))).rejects.toThrow(/还没上链/);
  });

  it('contractVersion / balance / tokenAddress 透传', async () => {
    const p = fakeProvider({});
    (p as any).call = async (tx: any) => {
      const sel = String(tx.data).slice(0, 10);
      if (sel === IFACE.getFunction('balance')!.selector) return '0x' + '05'.repeat(32);
      return '0x' + '00'.repeat(32);
    };
    const c = clientWith(p);
    expect(await c.balance()).toBe(BigInt('0x' + '05'.repeat(32)));
    expect(await c.contractVersion()).toBe(0);
    expect(await c.tokenAddress()).toBe('0x' + '00'.repeat(20));
  });
});

describe('5 个 v2 事件监听', () => {
  // ethers v6 的 contract.on/off 是异步的 (内部要 await 拿 sub) → 断言前等一拍
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('5 个事件都能注册 (过滤器锁在 escrow 合约 + 对应 topic0) + 取消', async () => {
    const p = fakeProvider({});
    const c = clientWith(p);
    const offs: Array<() => void> = [
      c.onEscrowCreatedV2(() => {}),
      c.onProofSubmittedV2(() => {}),
      c.onReleasedV2(() => {}),
      c.onRefundedV2(() => {}),
      c.onDisputedV2(() => {}),
    ];
    await tick();
    expect(p.listenerFilters.length).toBe(5);
    for (const f of p.listenerFilters) {
      expect(String(f.address).toLowerCase()).toBe(ESCROW_ADDR.toLowerCase());
      expect(String(f.topics?.[0])).toMatch(/^0x[0-9a-f]{64}$/);
    }
    // 每个事件的 topic0 都不一样 (没串台)
    expect(new Set(p.listenerFilters.map((f) => String(f.topics[0]))).size).toBe(5);
    expect(String(p.listenerFilters[2].topics[0])).toBe(IFACE.getEvent('ReleasedV2')!.topicHash);
    for (const off of offs) expect(() => off()).not.toThrow();
    await tick();
    expect(p.listenerFilters.length).toBe(0);
  });

  it('★ 监听回调: 真事件 → 解码出 taskKey/amount/by; 别的 taskKey → 不触发', async () => {
    const p = fakeProvider({});
    const c = clientWith(p);
    const got: any[] = [];
    c.onReleasedV2((args) => { got.push(args); }, { taskKey: TASK_KEY });
    await tick();
    expect(p.listeners.length).toBe(1);
    const fire = p.listeners[0].listener;
    // 另一个 taskKey 的日志 → 不许触发
    fire(releasedV2Log(OTHER_TASK_KEY, AGENT, 7n, 2));
    await tick();
    expect(got.length).toBe(0);
    // 正确 taskKey → 触发, 且值对
    fire(releasedV2Log(TASK_KEY, AGENT, 42n, 0));
    await tick();
    expect(got.length).toBe(1);
    expect(got[0].taskKey).toBe(TASK_KEY);
    expect(got[0].amount).toBe(42n);
    expect(Number(got[0].by)).toBe(0);
  });

  it('★ 监听回调: 别的合约发来的同 topic0 日志 → 一律不算', async () => {
    // 注: topic0 不匹配的日志 ethers 自己就会抛 (provider 侧已按 topic0 过滤), 所以这里
    //     只造"地址不对但 topic0 相同"的现实场景, 验证我们的地址门。
    const p = fakeProvider({});
    const c = clientWith(p);
    const got: any[] = [];
    c.onReleasedV2((args) => { got.push(args); });
    await tick();
    const fire = p.listeners[0].listener;
    fire({ ...releasedV2Log(TASK_KEY), address: '0x' + '99'.repeat(20) });
    await tick();
    expect(got.length).toBe(0);
    fire(releasedV2Log(TASK_KEY));
    await tick();
    expect(got.length).toBe(1);
  });

  it('removeAllListeners 之后不再留着监听 (重启不叠加)', async () => {
    const p = fakeProvider({});
    const c = clientWith(p);
    c.onReleasedV2(() => {});
    await tick();
    expect(p.listenerFilters.length).toBe(1);
    c.removeAllListeners();
    await tick();
    expect(p.listenerFilters.length).toBe(0);
    expect(p.listeners.length).toBe(0);
  });

  it('waitForV2Event 超时不假装收到 (返回 null)', async () => {
    const p = fakeProvider({});
    const c = clientWith(p);
    const got = await c.waitForV2Event('ReleasedV2', { taskKey: TASK_KEY, timeoutMs: 20 });
    expect(got).toBeNull();
  });

  it('waitForV2Event 收到真事件就返回 (含 taskKey 过滤)', async () => {
    const p = fakeProvider({});
    const c = clientWith(p);
    const waiter = c.waitForV2Event('ReleasedV2', { taskKey: TASK_KEY, timeoutMs: 2000 });
    await tick();
    p.listeners[0].listener(releasedV2Log(OTHER_TASK_KEY));   // 先来一个不该匹配的
    await tick();
    p.listeners[0].listener(releasedV2Log(TASK_KEY, AGENT, 5n, 0));
    const got = await waiter;
    expect(got).not.toBeNull();
    expect(got!.args.taskKey).toBe(TASK_KEY);
    expect(got!.args.amount).toBe(5n);
  });
});

describe('decodeV2Events', () => {
  it('从 receipt 日志解码出 ReleasedV2 (只认本合约)', () => {
    const logs = [releasedV2Log(TASK_KEY, AGENT, 42n, 2), { ...releasedV2Log(TASK_KEY), address: '0x' + '99'.repeat(20) }];
    const p = fakeProvider({ receipt: receipt({ logs }) });
    const c = clientWith(p);
    const decoded = c.decodeV2Events({ txHash: '0x1', blockNumber: 98, gasUsed: null, status: 1, reverted: false, logs: logs as any, broadcast: true });
    expect(decoded.length).toBe(1);
    expect(decoded[0].name).toBe('ReleasedV2');
    expect(decoded[0].args.taskKey).toBe(TASK_KEY);
    expect(decoded[0].args.amount).toBe(42n);
    expect(Number(decoded[0].args.by)).toBe(2);
  });

  it('可以按事件名过滤', () => {
    const logs = [releasedV2Log(TASK_KEY)];
    const c = clientWith(fakeProvider({}));
    const decoded = c.decodeV2Events({ txHash: '0x1', blockNumber: 98, gasUsed: null, status: 1, reverted: false, logs: logs as any, broadcast: true }, 'ReleasedV2');
    expect(decoded.length).toBe(1);
    expect(c.decodeV2Events({ txHash: '0x1', blockNumber: 98, gasUsed: null, status: 1, reverted: false, logs: logs as any, broadcast: true }, 'ProofSubmittedV2').length).toBe(0);
  });
});

describe('ABI 完整性', () => {
  it('AGENT_ESCROW_V2_ABI 里没有 v1 legacy 写方法 (那不属于链桥范围)', () => {
    const names = (AGENT_ESCROW_V2_ABI as readonly string[]).map((s) => s.split('(')[0].replace(/^(function|event) /, ''));
    expect(names).toContain('releaseV2');
    expect(names).not.toContain('release');
  });
});
