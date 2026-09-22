/**
 * chain-cli.test.ts — P6 `bolloon chain` 命令组的单测 (假链, 不联网、不发交易)
 *
 * 覆盖:
 *   · 命令组装配 (SERVICE_GROUPS / GROUP_COMMANDS.chain) + 未知子命令
 *   · `chain status`: 配置缺失 → CHAIN_NOT_CONFIGURED; RPC 不可达 → CHAIN_UNAVAILABLE; 私钥绝不出现在信封里
 *   · `chain escrow show`: 非法 taskKey / 链上没有 ESCROW_NOT_FOUND / **读不到 CHAIN_UNAVAILABLE** (两者不许混)
 *   · `chain index status|stats`: 只读本机索引 (无索引 → 从不同步, 不假装有); suspect 不计入业务计数
 *   · `chain index sync`: 链未配置 → CHAIN_NOT_CONFIGURED (不猜 deployment block)
 *   · `chain timeline`: 真事件顺序还原 create→proof→release; 空 → ESCROW_NOT_FOUND; 有回退记录 → REORG_SUSPECTED
 *   · `chain trade create`: 参数/预算门 (BUDGET_EXCEEDED) / 未授权 (NOT_AUTHORIZED) / 余额不足
 *     (INSUFFICIENT_FUNDS) / 广播前回滚 (CHAIN_TX_REVERTED) / 结论未定 (CHAIN_UNCERTAIN) / 成立 (OK)
 *   · `chain trade recover`: 纯读盘 → done / verify_only→reconcile / suspect→REORG_SUSPECTED
 *
 * 真链 (真签名/真 receipt/真事件/真重组) 在 `scripts/verify-chain-cli.ts` 里跑。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseFlags, commandResult, type Envelope } from '../cli/protocol-envelope.js';
import {
  chainCommand, setChainCommandDepsForTesting, isHexTaskKey, toAtomicUnits, CHAIN_USAGE,
} from '../cli/commands/chain.js';
import { SERVICE_GROUPS, GROUP_COMMANDS, isServiceGroup } from '../cli/commands/index.js';
import { setChainIndexPathForTesting } from '../agents/chain/chain-index-query.js';
import { upsertChainTx, markSuspect, chainStatePath } from '../agents/chain/chain-state-store.js';
import { onchainTaskKey } from '../agents/chain/onchain-trade.js';
import { clientWith, fakeProvider, fakeSigner, escrowTuple, ESCROW_ADDR } from './chain-test-helpers.js';

const TEST_KEY = '0x' + '11'.repeat(32);
const TASK_ID = 'p6-cli-unit';
const TASK_KEY = onchainTaskKey(TASK_ID);
const AGENT = '0x' + 'a0'.repeat(20);
const TXH = '0x' + 'ab'.repeat(32);

let HOME: string;
let indexPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'HOME', 'BOLLOON_CHAIN_RPC_URL', 'BOLLOON_CHAIN_ID', 'BOLLOON_ESCROW_ADDRESS',
  'BOLLOON_TOKEN_ADDRESS', 'BOLLOON_AGENT_AUTHORIZED', 'BOLLOON_WALLET_PRIVATE_KEY',
];

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chain-cli-'));
  fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
  indexPath = path.join(HOME, '.bolloon', 'chain', 'index.json');
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = HOME;
  setChainCommandDepsForTesting(null);
  setChainIndexPathForTesting(indexPath);
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  setChainCommandDepsForTesting(null);
  setChainIndexPathForTesting(null);
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** 配好链配置 (但不给客户端) */
function chainConfigured(): void {
  process.env.BOLLOON_CHAIN_RPC_URL = 'http://127.0.0.1:8545';
  process.env.BOLLOON_CHAIN_ID = '31337';
  process.env.BOLLOON_ESCROW_ADDRESS = ESCROW_ADDR;
  process.env.BOLLOON_TOKEN_ADDRESS = '0x' + '55'.repeat(20);
}
function authorized(): void {
  process.env.BOLLOON_AGENT_AUTHORIZED = '1';
  process.env.BOLLOON_WALLET_PRIVATE_KEY = TEST_KEY;
}

async function run(...argv: string[]): Promise<Envelope> {
  // 与 cli-entry / MCP bridge 一致: 命令组名由入口剥掉, 命令函数只拿子命令起的 args
  const args = argv[0] === 'chain' ? argv.slice(1) : argv;
  const r = await commandResult(parseFlags(args), chainCommand);
  return r.envelope;
}

const verdict = (over: Record<string, unknown> = {}) => ({
  chainSettled: false, status: 'unknown', reason: 'fake', confirmationsRequired: 1,
  requiredGate: 'confirmed', rpcAvailable: true, checkedAt: 1, evidence: {}, txHash: TXH, ...over,
});

function chainEntry(over: Record<string, unknown> = {}) {
  const txHash = String(over.txHash ?? TXH);
  const logIndex = Number(over.logIndex ?? 0);
  return {
    key: `${txHash}:${logIndex}`, blockNumber: 120, blockHash: '0x' + 'bc'.repeat(32), txHash,
    txIndex: 0, logIndex, address: ESCROW_ADDR, eventName: 'EscrowCreatedV2', taskKey: TASK_KEY,
    args: {}, confirmations: 5, finality: 'confirmed', suspect: false, firstSeenAt: 1, updatedAt: 1, history: [],
    ...over,
  };
}

function writeIndex(entries: unknown[]): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 2, chainId: 31337, networkName: 'localhost', escrowAddress: ESCROW_ADDR,
    deploymentBlock: 111, deploymentSource: 'test', lastSyncedBlock: 199, lastSyncedAt: Date.now(),
    headBlock: 200, headBlockHash: '0x' + 'dd'.repeat(32), confirmations: { confirmed: 1, finalized: 12 },
    pageSize: 2000, reorgDepth: 32, entries, recentBlocks: [], runs: [], updatedAt: Date.now(),
  }));
}

// ── 命令组装配 ───────────────────────────────────────────────────────────────

describe('命令组装配', () => {
  it('chain 已挂进 SERVICE_GROUPS / GROUP_COMMANDS (CLI 与 MCP 共用同一张映射表)', () => {
    expect(SERVICE_GROUPS).toContain('chain');
    expect(isServiceGroup('chain')).toBe(true);
    expect(typeof GROUP_COMMANDS.chain).toBe('function');
  });
  it('未知 / 缺失子命令 → INVALID_ARGUMENT + 带用法 (不静默)', async () => {
    const none = await run('chain');
    expect(none.ok).toBe(false);
    expect(none.code).toBe('INVALID_ARGUMENT');
    const bad = await run('chain', 'nope');
    expect(bad.code).toBe('INVALID_ARGUMENT');
    expect(String(bad.data.usage)).toContain('bolloon chain');
    expect(String(bad.data.usage)).not.toContain('\u001b');   // 用法进信封前已去色
  });
  it('工具函数: taskKey 形状 / 原子单位换算 (超精度拒绝, 不静默截断)', () => {
    expect(isHexTaskKey(TASK_KEY)).toBe(true);
    expect(isHexTaskKey('0x1234')).toBe(false);
    expect(toAtomicUnits('0.02', 6)).toBe(20_000n);
    expect(toAtomicUnits('1', 6)).toBe(1_000_000n);
    expect(toAtomicUnits('0.0000001', 6)).toBeNull();  // 超精度 → 拒绝
    expect(toAtomicUnits('-1', 6)).toBeNull();
    expect(toAtomicUnits('abc', 6)).toBeNull();
    expect(CHAIN_USAGE).toContain('chain trade create');
  });
});

// ── chain status ─────────────────────────────────────────────────────────────

describe('chain status', () => {
  it('链未配置 → CHAIN_NOT_CONFIGURED + 列出缺哪些 (不猜地址)', async () => {
    delete process.env.BOLLOON_CHAIN_RPC_URL;
    delete process.env.BOLLOON_CHAIN_ID;
    delete process.env.BOLLOON_ESCROW_ADDRESS;
    const env = await run('chain', 'status', '--json');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_NOT_CONFIGURED');
    expect(env.data.missing).toEqual(expect.arrayContaining(['rpcUrl', 'chainId', 'escrowAddress']));
  });

  it('RPC 不可达 → CHAIN_UNAVAILABLE (data 仍带链配置, 不是\"读到了空状态\")', async () => {
    chainConfigured();
    setChainCommandDepsForTesting({ client: () => ({ getLatestBlockNumber: async () => { throw new Error('ECONNREFUSED'); } }) });
    const env = await run('chain', 'status');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_UNAVAILABLE');
    expect(env.data.rpcOk).toBe(false);
    expect(env.data.chainId).toBe(31337);
  });

  it('配置齐 + 链可达 → ok:true, 读真 chainId/确认数门槛, 且**信封里没有私钥**', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({ client: () => clientWith(fakeProvider({ latestBlock: 123 })) });
    const env = await run('chain', 'status', '--json');
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect(env.data.chainId).toBe(31337);
    expect(env.data.escrowAddress).toBe(ESCROW_ADDR);
    expect(env.data.confirmations).toEqual({ confirmed: 1, finalized: 12 });
    expect(env.data.rpcOk).toBe(true);
    expect(env.data.latestBlock).toBe(123);
    expect((env.data.wallet as any).available).toBe(true);
    expect(env.data.privateKeyPrinted).toBe(false);
    // ★ 红线: 整个信封 (含 nest 值) 里不允许出现私钥
    const text = JSON.stringify(env);
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(TEST_KEY.slice(2));
  });
});

// ── chain escrow show ────────────────────────────────────────────────────────

describe('chain escrow show', () => {
  it('taskKey 形状不对 → INVALID_ARGUMENT (不硬搜)', async () => {
    chainConfigured();
    const env = await run('chain', 'escrow', 'show', 'deadbeef');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('INVALID_ARGUMENT');
  });

  it('链上读到了但没有这条 escrow (buyer==0) → ESCROW_NOT_FOUND', async () => {
    chainConfigured();
    setChainCommandDepsForTesting({ client: () => clientWith(fakeProvider({ escrow: escrowTuple({ buyer: '0x' + '00'.repeat(20) }) })) });
    const env = await run('chain', 'escrow', 'show', TASK_KEY);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('ESCROW_NOT_FOUND');
    expect(env.data.taskKey).toBe(TASK_KEY);
  });

  it('★ 读不到 (RPC/合约调用失败) → CHAIN_UNAVAILABLE, 绝不当成 ESCROW_NOT_FOUND', async () => {
    chainConfigured();
    setChainCommandDepsForTesting({ client: () => ({ getEscrow: async () => { throw new Error('ECONNREFUSED 127.0.0.1:8545'); } }) });
    const env = await run('chain', 'escrow', 'show', TASK_KEY);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_UNAVAILABLE');
  });

  it('读到真 escrow → ok:true + 状态/金额/买卖双方', async () => {
    chainConfigured();
    setChainCommandDepsForTesting({ client: () => clientWith(fakeProvider({ escrow: escrowTuple({ taskKey: TASK_KEY, state: 1, agent: AGENT, amount: 20_000n }) })) });
    const env = await run('chain', 'escrow', 'show', TASK_KEY);
    expect(env.ok).toBe(true);
    expect(env.data.state).toBe('RELEASED');
    expect(env.data.amountAtomic).toBe('20000');
    expect(env.data.amountUsdc).toBe('0.02');
    expect(env.data.agent.toLowerCase()).toBe(AGENT.toLowerCase());
    expect(env.data.taskKeyMatches).toBe(true);
  });
});

// ── chain index status|stats|sync ────────────────────────────────────────────

describe('chain index', () => {
  it('从未同步 → ok:true 但 synced:false (不假装有数据)', async () => {
    const env = await run('chain', 'index', 'status');
    expect(env.ok).toBe(true);
    expect(env.data.synced).toBe(false);
    expect(env.data.lastSyncedAt).toBeNull();
    expect(env.data.entries).toBe(0);
  });

  it('读了索引 → 高度/事件数/suspect 数; stats 里 suspect 不计入业务计数', async () => {
    writeIndex([
      chainEntry({ eventName: 'EscrowCreatedV2', logIndex: 0 }),
      chainEntry({ eventName: 'ProofSubmittedV2', logIndex: 1, txHash: '0x' + 'cd'.repeat(32) }),
      chainEntry({ eventName: 'ReleasedV2', logIndex: 2, txHash: '0x' + 'ce'.repeat(32) }),
      chainEntry({ eventName: 'ReleasedV2', logIndex: 3, txHash: '0x' + 'cf'.repeat(32), suspect: true, finality: 'observed' }),
    ]);
    const st = await run('chain', 'index', 'status');
    expect(st.ok).toBe(true);
    expect(st.data.entries).toBe(4);
    expect(st.data.suspects).toBe(1);
    expect(st.data.synced).toBe(true);
    const stats = await run('chain', 'index', 'stats');
    expect(stats.ok).toBe(true);
    expect(stats.data.released).toBe(1);      // suspect 那条不计入
    expect(stats.data.tasks).toBe(1);
    expect(stats.data.created).toBe(1);
    expect(stats.data.suspects).toBe(1);
    expect(stats.data.deploymentBlock).toBe(111);
  });

  it('索引未同步时 sync 不猜起点: 链未配置 → CHAIN_NOT_CONFIGURED', async () => {
    delete process.env.BOLLOON_CHAIN_RPC_URL;
    const env = await run('chain', 'index', 'sync');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_NOT_CONFIGURED');
  });

  it('未知 index 子命令 → INVALID_ARGUMENT', async () => {
    const env = await run('chain', 'index', 'wat');
    expect(env.code).toBe('INVALID_ARGUMENT');
  });
});

// ── chain timeline ───────────────────────────────────────────────────────────

describe('chain timeline', () => {
  it('taskKey 非法 → INVALID_ARGUMENT', async () => {
    const env = await run('chain', 'timeline', '0x123');
    expect(env.code).toBe('INVALID_ARGUMENT');
  });

  it('索引与本机记录都没有 → ESCROW_NOT_FOUND (并指出先 sync)', async () => {
    const env = await run('chain', 'timeline', TASK_KEY);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('ESCROW_NOT_FOUND');
    expect(env.data.indexPath).toBe(indexPath);
  });

  it('用真事件顺序还原 create→proof→release (finality 三档语义给出)', async () => {
    writeIndex([
      chainEntry({ eventName: 'EscrowCreatedV2', logIndex: 0, blockNumber: 120, finality: 'finalized', confirmations: 80 }),
      chainEntry({ eventName: 'ProofSubmittedV2', logIndex: 1, blockNumber: 121, txHash: '0x' + 'cd'.repeat(32), finality: 'confirmed', confirmations: 3 }),
      chainEntry({ eventName: 'ReleasedV2', logIndex: 2, blockNumber: 122, txHash: '0x' + 'ce'.repeat(32), finality: 'confirmed', confirmations: 2 }),
    ]);
    const env = await run('chain', 'timeline', TASK_KEY);
    expect(env.ok).toBe(true);
    const names = (env.data.events as any[]).map((e) => e.eventName);
    expect(names).toEqual(['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2']);
    expect(env.data.state).toBe('RELEASED');
    expect(env.data.count).toBe(3);
    expect(env.evidence).toEqual(expect.arrayContaining([TASK_KEY]));
    expect((env.data.finalityLegend as any).observed).toContain('确认数');
    expect(env.data.hasSuspect).toBe(false);
  });

  it('★ 时间线里有被回退的记录 → REORG_SUSPECTED (绝不报成功)', async () => {
    writeIndex([
      chainEntry({ eventName: 'EscrowCreatedV2', logIndex: 0, blockNumber: 120 }),
      chainEntry({ eventName: 'ReleasedV2', logIndex: 1, blockNumber: 121, txHash: '0x' + 'ce'.repeat(32), suspect: true, finality: 'observed' }),
    ]);
    const env = await run('chain', 'timeline', TASK_KEY);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('REORG_SUSPECTED');
    expect(env.data.hasSuspect).toBe(true);
    expect(env.next_action).toBe('reconcile');
  });
});

/** 假客户端: 直接给 TxOutcome (不真发交易), 但走**真** sendChainTxGuarded 放行闸路径 */
function outcomeClient(outcome: Record<string, unknown>) {
  return {
    escrowAddress: ESCROW_ADDR, chainId: 31337,
    provider: fakeProvider({ latestBlock: 131 }),
    localSigner: () => fakeSigner(fakeProvider()).signer,
    createEscrowV2: async () => outcome,
    submitProofV2: async () => outcome,
    releaseV2: async () => outcome,
  } as any;
}
const txOutcome = (over: Record<string, unknown> = {}) => ({
  txHash: TXH, blockNumber: 130, gasUsed: '21000', status: 1, reverted: false, logs: [], broadcast: true, ...over,
});

// ── chain trade create ───────────────────────────────────────────────────────

describe('chain trade create', () => {
  it('缺 --task-id / --amount / --agent → INVALID_ARGUMENT (不猜金额, 不发交易)', async () => {
    chainConfigured();
    expect((await run('chain', 'trade', 'create', '--amount', '0.02', '--agent', AGENT)).code).toBe('INVALID_ARGUMENT');
    expect((await run('chain', 'trade', 'create', '--task-id', TASK_ID, '--agent', AGENT)).code).toBe('INVALID_ARGUMENT');
    expect((await run('chain', 'trade', 'create', '--task-id', TASK_ID, '--amount', '0.02')).code).toBe('INVALID_ARGUMENT');
    expect((await run('chain', 'trade', 'create', '--task-id', TASK_ID, '--amount', '0.0.1', '--agent', AGENT)).code).toBe('INVALID_ARGUMENT');
  });

  it('金额超 M1 单次上限 → BUDGET_EXCEEDED 并指明哪一层 (根本不发交易)', async () => {
    chainConfigured();
    authorized();
    let called = false;
    setChainCommandDepsForTesting({ client: () => ({ escrowAddress: ESCROW_ADDR, chainId: 31337, localSigner: () => { called = true; } }) });
    const env = await run('chain', 'trade', 'create', '--task-id', TASK_ID, '--amount', '0.5', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('BUDGET_EXCEEDED');
    expect(env.data.layer).toBe('perPurchase');
    expect(env.next_action).toBe('raise_budget');
    expect(called).toBe(false);
  });

  it('★ 未授权签名 → NOT_AUTHORIZED, 且没发交易 (txHash=null, authorized=false)', async () => {
    chainConfigured();
    delete process.env.BOLLOON_AGENT_AUTHORIZED;       // 没有授权来源
    process.env.BOLLOON_WALLET_PRIVATE_KEY = TEST_KEY; // 钱包在, 但不许自主签
    setChainCommandDepsForTesting({ client: () => clientWith(fakeProvider()) });
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-noauth`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('NOT_AUTHORIZED');
    expect(env.data.authorized).toBe(false);
    expect(env.data.txHash).toBeNull();
    expect(env.data.privateKeyTouched).toBe(false);
  });

  it('★ 余额/授权不足 → INSUFFICIENT_FUNDS (广播前被拒, 钱没动)', async () => {
    chainConfigured();
    authorized();
    const provider = fakeProvider();
    (provider as any).broadcastTransaction = async () => { throw new Error('execution reverted: "insufficient"'); };
    setChainCommandDepsForTesting({ client: () => clientWith(provider) });
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-poor`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('INSUFFICIENT_FUNDS');
    expect(env.data.txHash).toBeNull();
    expect(env.next_action).toBe('raise_budget');
  });

  it('合约在广播前拒绝 (其它 revert) → CHAIN_TX_REVERTED (不冒充钱不够)', async () => {
    chainConfigured();
    authorized();
    const provider = fakeProvider();
    (provider as any).broadcastTransaction = async () => { throw new Error('execution reverted: "deadline in past"'); };
    setChainCommandDepsForTesting({ client: () => clientWith(provider) });
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-past`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_TX_REVERTED');
    expect(env.data.txHash).toBeNull();
  });

  it('链上已回滚 (receipt.status=0) → CHAIN_TX_REVERTED', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({
      client: () => outcomeClient(txOutcome({ status: 0, reverted: true })),
      verifyOnChain: async () => verdict({ chainSettled: false, status: 'reverted', reason: 'receipt.status=0', confirmations: 1, blockNumber: 130 }),
    });
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-revert`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_TX_REVERTED');
    expect(env.data.txHash).toBe(TXH);
  });

  it('★ 结论未定 (确认数不够) → CHAIN_UNCERTAIN + next_action=reconcile (不确定绝不报成功)', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({
      client: () => outcomeClient(txOutcome()),
      verifyOnChain: async () => verdict({ chainSettled: false, status: 'pending', reason: '确认数 0 < 1', confirmations: 0 }),
    });
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-pending`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_UNCERTAIN');
    expect(env.next_action).toBe('reconcile');
    expect(env.data.chainSettled).toBe(false);
    expect(env.data.txHash).toBe(TXH);
  });

  it('链上成立 (receipt.status=1 + 确认数达标 + 事件对上) → ok:true + code OK', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({
      client: () => outcomeClient(txOutcome()),
      verifyOnChain: async () => verdict({
        chainSettled: true, status: 'confirmed', reason: 'ok', confirmations: 2, blockNumber: 130,
        eventMatched: true, matchedEvent: 'EscrowCreatedV2', escrowState: 'ACTIVE', rpcAvailable: true,
      }),
    });
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-ok`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect(env.data.txHash).toBe(TXH);
    expect(env.data.chainSettled).toBe(true);
    expect(env.data.eventMatched).toBe(true);
    expect(env.data.escrowState).toBe('ACTIVE');
    expect(env.evidence).toContain(TXH);
  });

  it('release: 链上成立但**没全过** (grantsVerified=false) → CHAIN_UNCERTAIN (不许标 verified)', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({
      client: () => outcomeClient(txOutcome()),
      verifyOnChain: async () => verdict({
        chainSettled: true, status: 'confirmed', reason: 'ok', confirmations: 2, blockNumber: 130,
        eventMatched: false, matchedEvent: 'ReleasedV2', escrowState: 'ACTIVE', rpcAvailable: true,
      }),
    });
    const env = await run('chain', 'trade', 'release', '--task-id', `${TASK_ID}-rel`);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_UNCERTAIN');
    expect(env.data.grantsVerified).toBe(false);
  });

  it('release: 全过 (事件对上 + 合约 RELEASED) → ok:true + grantsVerified=true', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({
      client: () => outcomeClient(txOutcome()),
      verifyOnChain: async () => verdict({
        chainSettled: true, status: 'confirmed', reason: 'ok', confirmations: 2, blockNumber: 130,
        eventMatched: true, matchedEvent: 'ReleasedV2', escrowState: 'RELEASED', rpcAvailable: true,
      }),
    });
    const env = await run('chain', 'trade', 'release', '--task-id', `${TASK_ID}-rel2`);
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect(env.data.grantsVerified).toBe(true);
    expect(env.data.escrowState).toBe('RELEASED');
  });

  it('submit-proof 缺 --result → INVALID_ARGUMENT; release 缺 task-id → INVALID_ARGUMENT', async () => {
    chainConfigured();
    expect((await run('chain', 'trade', 'submit-proof', '--task-id', TASK_ID)).code).toBe('INVALID_ARGUMENT');
    expect((await run('chain', 'trade', 'release')).code).toBe('INVALID_ARGUMENT');
  });
});

// ── chain trade recover (纯读盘) ─────────────────────────────────────────────

describe('chain trade recover', () => {
  it('既没 task-id 也没 task-key → INVALID_ARGUMENT', async () => {
    const env = await run('chain', 'trade', 'recover');
    expect(env.code).toBe('INVALID_ARGUMENT');
  });

  it('什么都没有 → ok:true + nextAction=create_escrow (没花过钱, 可以安全从头走)', async () => {
    const env = await run('chain', 'trade', 'recover', '--task-id', 'p6-none');
    expect(env.ok).toBe(true);
    expect(env.data.nextAction).toBe('create_escrow');
    expect(env.data.mustNotRepay).toBe(false);
  });

  it('create+proof+release 都确认 + 合约 RELEASED → done & verified (纯读盘, 不发交易)', async () => {
    const seed = (method: string, txHash: string) => upsertChainTx({
      requestId: `chaintx-${method}-unit`, method: method as any, taskKey: TASK_KEY, escrowAddress: ESCROW_ADDR,
      chainId: 31337, txHash, confirmations: 5, lastCheckedBlock: 130, blockNumber: 129,
      status: 'confirmed', reason: 'unit', escrowState: 'RELEASED',
    }, HOME);
    await seed('createEscrowV2', TXH);
    await seed('submitProofV2', '0x' + 'cd'.repeat(32));
    await seed('releaseV2', '0x' + 'ce'.repeat(32));
    const env = await run('chain', 'trade', 'recover', '--task-id', TASK_ID);
    expect(env.ok).toBe(true);
    expect(env.data.nextAction).toBe('done');
    expect(env.data.verified).toBe(true);
    expect(env.data.mustNotRepay).toBe(true);
    expect(env.data.writesMoney).toBe(false);
    expect(env.data.statePath).toBe(chainStatePath(HOME));
  });

  it('托管确认了但拿不到证明 → nextAction=needs_human + CHAIN_UNCERTAIN (不假装 done)', async () => {
    await upsertChainTx({
      requestId: 'chaintx-createEscrowV2-unit2', method: 'createEscrowV2', taskKey: TASK_KEY,
      escrowAddress: ESCROW_ADDR, chainId: 31337, txHash: TXH, confirmations: 5,
      lastCheckedBlock: 130, blockNumber: 129, status: 'confirmed', reason: 'unit',
    }, HOME);
    const env = await run('chain', 'trade', 'recover', '--task-id', TASK_ID);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_UNCERTAIN');
    expect(env.data.nextAction).toBe('needs_human');
    expect(env.data.mustNotRepay).toBe(true);
  });

  it('结论未定 (create 还 pending) → verify_only + next_action=reconcile (不许重发)', async () => {
    await upsertChainTx({
      requestId: 'chaintx-createEscrowV2-unit3', method: 'createEscrowV2', taskKey: TASK_KEY,
      escrowAddress: ESCROW_ADDR, chainId: 31337, txHash: TXH, confirmations: 0,
      lastCheckedBlock: 130, blockNumber: 130, status: 'pending', reason: '确认数不够',
    }, HOME);
    const env = await run('chain', 'trade', 'recover', '--task-id', TASK_ID);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_UNCERTAIN');
    expect(env.data.nextAction).toBe('verify_only');
    expect(env.next_action).toBe('reconcile');
  });

  it('★ 有被标可疑的记录 → REORG_SUSPECTED (待人工, 绝不当已结算)', async () => {
    const seed = (method: string, txHash: string) => upsertChainTx({
      requestId: `chaintx-${method}-unit4`, method: method as any, taskKey: TASK_KEY,
      escrowAddress: ESCROW_ADDR, chainId: 31337, txHash, confirmations: 5,
      lastCheckedBlock: 130, blockNumber: 129, status: 'confirmed', reason: 'unit', escrowState: 'RELEASED',
    }, HOME);
    await seed('createEscrowV2', TXH);
    await seed('releaseV2', '0x' + 'ce'.repeat(32));
    await markSuspect('chaintx-releaseV2-unit4', 'unit: 事件在链上消失', HOME);
    const env = await run('chain', 'trade', 'recover', '--task-id', TASK_ID);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('REORG_SUSPECTED');
    expect(env.data.mustNotRepay).toBe(true);
    expect(env.next_action).toBe('needs_human');
    expect((env.data.suspectRecords as any[])[0].method).toBe('releaseV2');
  });

  it('★ 可疑记录 + 缺 create 记录 → 仍然 REORG_SUSPECTED + mustNotRepay=true (不读成"可以从头走")', async () => {
    await upsertChainTx({
      requestId: 'chaintx-submitProofV2-orphan', method: 'submitProofV2', taskKey: TASK_KEY,
      escrowAddress: ESCROW_ADDR, chainId: 31337, txHash: TXH, confirmations: 5,
      lastCheckedBlock: 130, blockNumber: 129, status: 'confirmed', reason: 'unit',
    }, HOME);
    await markSuspect('chaintx-submitProofV2-orphan', 'unit: 重组', HOME);
    const env = await run('chain', 'trade', 'recover', '--task-id', TASK_ID);
    expect(env.code).toBe('REORG_SUSPECTED');
    expect(env.data.mustNotRepay).toBe(true);
    expect(env.data.p4NextAction).toBe('create_escrow');   // P4 原始判定原样保留 (不篡改口径)
  });

  it('也接受 --task-key (直接给链上键)', async () => {
    const env = await run('chain', 'trade', 'recover', '--task-key', TASK_KEY);
    expect(env.data.taskKey).toBe(TASK_KEY);
    expect(env.ok).toBe(true);
  });
});
