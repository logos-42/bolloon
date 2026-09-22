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
 *   · 链上写操作的**授权意图** (`--payment-mode` / `--request-id`): 非法值拒 · manual/policy 被闸拒 ·
 *     声明的 requestId 进放行闸派生且写审计 (不记私钥/正文) · 同一声明重复 → notDuplicate 拒
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
import { ChainIndexer } from '../agents/chain/chain-indexer.js';
import { upsertChainTx, markSuspect, chainStatePath } from '../agents/chain/chain-state-store.js';
import { onchainTaskKey } from '../agents/chain/onchain-trade.js';
import { chainRequestIdOf } from '../agents/chain/chain-wallet.js';
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
  'BOLLOON_DEPLOYMENTS_DIR',
];

/** 空的 manifest 目录: 表达"三层都拿不到" (而不是靠"恰好匹配不上") */
const EMPTY_DEPLOYMENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-no-deployments-'));

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

function writeIndex(entries: unknown[], over: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 2, chainId: 31337, networkName: 'localhost', escrowAddress: ESCROW_ADDR,
    deploymentBlock: 111, deploymentSource: 'test', lastSyncedBlock: 199, lastSyncedAt: Date.now(),
    headBlock: 200, headBlockHash: '0x' + 'dd'.repeat(32), confirmations: { confirmed: 1, finalized: 12 },
    pageSize: 2000, reorgDepth: 32, entries, recentBlocks: [], runs: [], updatedAt: Date.now(),
    ...over,
  }));
}

/** 极小假链 (只够索引器扫链): head 固定, 无日志 (另有计数, 用来证明"没读链") */
function rpcSpy(head = 20, logs: any[] = []) {
  let calls = 0;
  const hex = (n: number) => '0x' + n.toString(16).padStart(64, '0');
  const provider = {
    async getBlockNumber() { calls++; return head; },
    async getBlock(n: number | string) { calls++; return { number: Number(n), hash: hex(Number(n)), parentHash: hex(Math.max(0, Number(n) - 1)) }; },
    async getLogs() { calls++; return logs; },
  };
  return { provider, calls: () => calls };
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

  it('usage 里写着的 rebuild 子命令**真的存在** (帮助文本不许提一个不存在的命令)', async () => {
    expect(CHAIN_USAGE).toContain('chain index status|stats|sync|rebuild');
    delete process.env.BOLLOON_CHAIN_RPC_URL; // 未配置链 → 配置类失败, 但**不是** INVALID_ARGUMENT(未实现)
    const env = await run('chain', 'index', 'rebuild');
    expect(env.code).not.toBe('INVALID_ARGUMENT');
    expect(env.code).toBe('CHAIN_NOT_CONFIGURED');
  });
});

// ── chain index 身份变更 (换合约部署 / anvil 重启换链实例) ───────────────────────

describe('chain index 身份变更 (换合约部署 ≠ 重组)', () => {
  const OLD_ADDR = '0x' + '9b'.repeat(20); // 上一轮部署的 escrow (与当前 ESCROW_ADDR 是不同合约)

  /** 注入"当前链"上的索引器 (假链, 不联网) */
  const injectIndexer = (opts: { provider: any; deploymentBlock?: number; escrowAddress?: string }) => (): unknown =>
    new ChainIndexer({
      provider: opts.provider, escrowAddress: opts.escrowAddress ?? ESCROW_ADDR, chainId: 31337,
      networkName: 'localhost', deploymentBlock: opts.deploymentBlock ?? 10, home: HOME,
      pageSize: 50, checkpointEvery: 1000,
    });

  it('★ sync 遇身份变更 → INDEX_IDENTITY_CHANGED + needs_human (绝不报 REORG_SUSPECTED), 且不读链、不写盘', async () => {
    chainConfigured();
    writeIndex([chainEntry({ blockNumber: 120 })], { escrowAddress: OLD_ADDR, deploymentBlock: 111 });
    const before = fs.readFileSync(indexPath, 'utf8');
    const spy = rpcSpy();
    setChainCommandDepsForTesting({ indexer: injectIndexer({ provider: spy.provider }) });

    const env = await run('chain', 'index', 'sync');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('INDEX_IDENTITY_CHANGED');           // ★ 不是 REORG_SUSPECTED
    expect(env.code).not.toBe('REORG_SUSPECTED');
    expect(env.next_action).toBe('needs_human');
    expect(env.data.identityChanged).toBe(true);
    expect((env.data.oldIdentity as any).escrowAddress).toBe(OLD_ADDR.toLowerCase());
    expect((env.data.oldIdentity as any).deploymentBlock).toBe(111);
    expect((env.data.newIdentity as any).escrowAddress).toBe(ESCROW_ADDR.toLowerCase());
    expect((env.data.newIdentity as any).deploymentBlock).toBe(10);
    expect(String(env.data.suggestedCommand)).toContain('bolloon chain index rebuild');
    expect(env.data.scanned).toBe(false);
    expect(env.data.wroteIndex).toBe(false);
    expect(spy.calls()).toBe(0);                                // 身份门在任何 RPC 之前
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(before);    // 一个字节都没动
    expect(String(env.message)).toContain('这不是重组');
  });

  it('★ rebuild: 身份变更 → **干净重建** (ok:true + identityChanged, 丢弃旧身份记录, 文件身份改成当前)', async () => {
    chainConfigured();
    writeIndex(
      [chainEntry({ blockNumber: 120 }), chainEntry({ blockNumber: 121, logIndex: 1, txHash: '0x' + 'cd'.repeat(32) })],
      { escrowAddress: OLD_ADDR, deploymentBlock: 111 },
    );
    const spy = rpcSpy(20); // 当前链: head 20, 没有事件
    setChainCommandDepsForTesting({ indexer: injectIndexer({ provider: spy.provider }) });

    const env = await run('chain', 'index', 'rebuild');
    expect(env.ok).toBe(true);                                  // 修完了 → 报成功 (但明说身份变了)
    expect(env.data.identityChanged).toBe(true);
    expect(env.data.persisted).toBe(true);
    expect(env.data.discardedEntries).toBe(2);                  // 旧身份的两条被丢弃 (不是标 suspect)
    expect((env.data.oldIdentity as any).deploymentBlock).toBe(111);
    expect((env.data.newIdentity as any).escrowAddress).toBe(ESCROW_ADDR.toLowerCase());
    expect(env.data.entries).toBe(0);                           // 当前链上没有日志
    expect(String(env.data.note)).toContain('干净重建');
    expect(spy.calls()).toBeGreaterThan(0);                     // 真扫了链 (head + 块)

    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    expect(raw.escrowAddress).toBe(ESCROW_ADDR);                // ★ 采用当前身份写回
    expect(raw.deploymentBlock).toBe(10);
    expect(raw.entries.length).toBe(0);
    expect(raw.identity).toEqual({ chainId: 31337, escrowAddress: ESCROW_ADDR.toLowerCase(), deploymentBlock: 10 });

    // 修完之后: status 报的就是**真身份**, 而 sync 不再被拒
    const st = await run('chain', 'index', 'status');
    expect(st.data.escrowAddress).toBe(ESCROW_ADDR);
    expect(st.data.deploymentBlock).toBe(10);
    const again = await run('chain', 'index', 'sync');
    expect(again.ok).toBe(true);
    expect(again.code).toBe('OK');
  });

  it('rebuild: 身份未变 → 行为与历史一致 (identityChanged=false, 不丢弃, 走原来的保留路径)', async () => {
    chainConfigured();
    writeIndex([chainEntry({ blockNumber: 12 })], { escrowAddress: ESCROW_ADDR, deploymentBlock: 10 });
    const spy = rpcSpy(20);
    setChainCommandDepsForTesting({ indexer: injectIndexer({ provider: spy.provider }) });

    const env = await run('chain', 'index', 'rebuild');
    expect(env.ok).toBe(true);
    expect(env.data.identityChanged).toBe(false);
    expect(env.data.discardedEntries).toBe(0);
    expect((env.data.newIdentity as any)).toEqual((env.data.oldIdentity as any));
    expect(String(env.data.note)).toContain('身份未变');
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

  it('★ 真写拿不到 token → CHAIN_NOT_CONFIGURED + 可操作的修法 (不是含糊的 INVALID_ARGUMENT)', async () => {
    // 链配齐 (RPC/chainId/escrow), 但三层都没有 token 地址: env 没给、chain.json 没写、
    // 仓库 manifest 目录是空的 (模拟"这条部署不在本仓库里")
    process.env.BOLLOON_CHAIN_RPC_URL = 'http://127.0.0.1:8545';
    process.env.BOLLOON_CHAIN_ID = '31337';
    process.env.BOLLOON_ESCROW_ADDRESS = ESCROW_ADDR;
    delete process.env.BOLLOON_TOKEN_ADDRESS;
    process.env.BOLLOON_DEPLOYMENTS_DIR = EMPTY_DEPLOYMENTS;
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-notoken`, '--amount', '0.02', '--agent', AGENT);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('CHAIN_NOT_CONFIGURED');
    expect(env.data.missing).toEqual(['tokenAddress']);
    // 报错必须**可操作**: 点名三层来源 + 给出修法 (机器可读的 howToFix)
    expect(String(env.message)).toContain('BOLLOON_TOKEN_ADDRESS');
    expect(String(env.message)).toContain('chain.json');
    expect(String(env.message)).toContain('manifest');
    expect(Array.isArray(env.data.howToFix)).toBe(true);
    expect((env.data.howToFix as string[]).length).toBeGreaterThanOrEqual(3);
    // 读路径不受影响 (只拦真写)
    expect((await run('chain', 'status')).ok).toBe(true);
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

// ── 链上**写**操作的授权意图 (--payment-mode / --request-id) ───────────────────
// MCP 写 tool 会强制显式携带这两个参数; CLI 侧它们是可选的, 但一旦给了就必须照办
// (非法值拒绝 / 只能收紧 / 进放行闸的 requestId 派生 → 同一声明只签一次)。

describe('chain trade 写操作的授权意图 (--payment-mode / --request-id)', () => {
  it('--payment-mode 非法 → INVALID_ARGUMENT (不静默退回默认口径)', async () => {
    chainConfigured();
    authorized();
    const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-badmode`, '--agent', AGENT, '--amount', '0.02', '--payment-mode', 'auto-pilot');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('INVALID_ARGUMENT');
    expect(env.data.accepted).toContain('agent-authorized');
  });

  it('★ 声明 manual / policy (非自主模式) → 放行闸按 modeIsAutonomous 拒 (NOT_AUTHORIZED, 没发交易)', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({ client: () => outcomeClient(txOutcome()) });
    for (const mode of ['manual', 'policy']) {
      const env = await run('chain', 'trade', 'create', '--task-id', `${TASK_ID}-${mode}`, '--agent', AGENT, '--amount', '0.02', '--payment-mode', mode);
      expect(env.ok, mode).toBe(false);
      expect(env.code, mode).toBe('NOT_AUTHORIZED');
      expect(env.data.authorized, mode).toBe(false);
      expect(env.data.txHash, mode).toBeNull();
      // 声明被如实回显 (没有替调用方改口径)
      expect((env.data.authIntent as any).paymentMode, mode).toBe(mode);
      expect((env.data.authIntent as any).note, mode).toContain('声明 ≠ 授权');
    }
  });

  it('★ 声明 agent-authorized + requestId → 真签放行, 且审计里按声明派生 requestId (同一声明只签一次)', async () => {
    chainConfigured();
    authorized();
    setChainCommandDepsForTesting({
      client: () => outcomeClient(txOutcome()),
      verifyOnChain: async () => verdict({
        chainSettled: true, status: 'confirmed', reason: 'ok', confirmations: 2, blockNumber: 130,
        eventMatched: true, matchedEvent: 'EscrowCreatedV2', escrowState: 'ACTIVE', rpcAvailable: true,
      }),
    });
    const taskId = `${TASK_ID}-intent`;
    const rid = 'mcp-intent-rid-unit-1';
    const env = await run('chain', 'trade', 'create', '--task-id', taskId, '--agent', AGENT, '--amount', '0.02', '--payment-mode', 'agent-authorized', '--request-id', rid);
    expect(env.ok).toBe(true);
    expect(env.data.txHash).toBe(TXH);
    expect((env.data.authIntent as any).paymentMode).toBe('agent-authorized');
    expect((env.data.authIntent as any).declaredRequestId).toBe(rid);

    // 审计 (~/.bolloon/wallet-signatures.jsonl): 只记摘要, 不记私钥/任务正文
    const auditPath = path.join(HOME, '.bolloon', 'wallet-signatures.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const rows = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const row = rows[rows.length - 1];
    const expectedRequestId = chainRequestIdOf({ method: 'createEscrowV2', taskKey: onchainTaskKey(taskId), amountAtomic: '20000', intentNonce: rid } as any, 31337);
    expect(row.requestId).toBe(expectedRequestId);          // 声明的 requestId 真进了放行闸派生
    expect(row.mode).toBe('agent-authorized');
    expect(row.taskId).toBe(taskId);
    expect(JSON.stringify(row)).not.toContain(TEST_KEY);    // 私钥绝不进审计
    for (const k of ['privateKey', 'secret', 'instruction', 'taskText', 'mnemonic', 'seed']) {
      expect(JSON.stringify(row)).not.toContain(`"${k}"`);
    }

    // ★ 同一个 requestId 重复声明 → 闸按 notDuplicate 拒 (同一次意图只签一次)
    const again = await run('chain', 'trade', 'create', '--task-id', taskId, '--agent', AGENT, '--amount', '0.02', '--payment-mode', 'agent-authorized', '--request-id', rid);
    expect(again.ok).toBe(false);
    expect(again.code).toBe('NOT_AUTHORIZED');
    expect(String((again.data as any).authReason)).toContain('notDuplicate');
    expect(again.data.txHash).toBeNull();
  });
});
