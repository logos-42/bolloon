/**
 * chain-indexer.test.ts — P5 链上索引器的单元测试 (假链, 不联网)
 * =========================================================================
 * 覆盖 (对应交付要求的五条):
 *   · 去重: 同一 txHash+logIndex 只入库一次; 幂等重跑 0 重复; 盘上被手改出重复键也会被压掉
 *   · 增量: 第二次 sync 从 lastSyncedBlock+1 开始 (不重扫 [deploymentBlock, lastSyncedBlock]);
 *          重启 (新实例读同一个盘) 从已记高度继续
 *   · 重组: 父哈希链变化 → 回退区间 + 被回退记录标 suspect (保留不删) + 重新上链后复位
 *   · 重建一致: rebuild() 全量重扫结果与增量结果 compareIndexes().same === true
 *   · 分页边界: 每页 ≤ pageSize 且区间**无缝无重叠**; provider 的 block-range 限制触发对半拆后
 *              边界块上的日志一条不漏
 * 外加: finality 分层 (observed/confirmed/finalized)、deployment block 从 manifest 读、只读查询接口。
 *
 * 假链的日志用**真 Interface 编码** (encodeEventLog), 走的是与真链完全一样的解码路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChainIndexer, INDEX_IFACE, INDEXED_EVENT_NAMES, chainIndexPath, resolveDeploymentInfo,
  compareIndexes, deriveEscrowState, type IndexRpcProvider, type ChainIndexEntry,
} from '../agents/chain/chain-indexer.js';
import {
  getIndexStatus, getIndexStats, getEscrowTimeline, fetchIndexSince,
} from '../agents/chain/chain-index-query.js';

// ── 假链 ────────────────────────────────────────────────────────────────────

const ESCROW = '0x162A433068F51e18b7d13932F27e66a3f99E6890';
const TASK_A = '0x' + 'aa'.repeat(32);
const TASK_B = '0x' + 'bb'.repeat(32);
const OTHER_ADDR = '0x' + 'cc'.repeat(20);

function fakeChain(startBlock = 0) {
  let epoch = 0;
  const blocks: Array<{ number: number; hash: string; parentHash: string }> = [];
  const logs: any[] = [];
  const calls: Array<{ from: number; to: number }> = [];
  let rangeLimit = Number.POSITIVE_INFINITY;
  let getLogsThrows: string | null = null;
  let seq = 0;

  const hashOf = (n: number) => '0x' + ((epoch + 1) * 1_000_000 + n).toString(16).padStart(64, '0');
  const mine = (n: number) => {
    const b = { number: n, hash: hashOf(n), parentHash: n === 0 ? '0x' + '0'.repeat(64) : hashOf(n - 1) };
    blocks.push(b);
    return b;
  };
  for (let n = 0; n <= startBlock; n++) mine(n);

  const provider: IndexRpcProvider = {
    async getBlockNumber() { return blocks[blocks.length - 1].number; },
    async getBlock(n: number | string) { return blocks.find((b) => b.number === Number(n)) ?? null; },
    async getLogs(f: any) {
      const from = Number(f.fromBlock);
      const to = Number(f.toBlock);
      if (getLogsThrows) throw new Error(getLogsThrows);
      if (to - from + 1 > rangeLimit) throw new Error(`query returned more than ${rangeLimit} results / block range too large`);
      calls.push({ from, to });
      const want = ((f.topics?.[0] as string[]) || []).map((t) => String(t).toLowerCase());
      return logs
        .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
        .filter((l) => !f.address || String(l.address).toLowerCase() === String(f.address).toLowerCase())
        .filter((l) => !want.length || want.includes(String(l.topics[0]).toLowerCase()))
        .map((l) => ({ ...l, topics: [...l.topics] }));
    },
  };

  return {
    provider, blocks, logs, calls,
    get head() { return blocks[blocks.length - 1]; },
    setRangeLimit(n: number) { rangeLimit = n; },
    setGetLogsError(msg: string | null) { getLogsThrows = msg; },
    mine(n = 1) { for (let i = 0; i < n; i++) mine(blocks[blocks.length - 1].number + 1); },
    /** 重组 depth 个块: 顶块被丢掉, 之后新挖的块哈希与旧的**不同** (epoch 变了) */
    rollback(depth: number) {
      const keep = blocks.length - depth;
      const forked = blocks.splice(keep);
      epoch++;
      for (const b of forked) { b.hash = hashOf(b.number); b.parentHash = b.number === 0 ? '0x' + '0'.repeat(64) : hashOf(b.number - 1); blocks.push(b); }
      for (let i = logs.length - 1; i >= 0; i--) if (logs[i].blockNumber > blocks[0].number) logs.splice(i, 1);
      return blocks[blocks.length - 1].number;
    },
    /**
     * 真重组: 分叉点在 forkHeight, 上面重新挖 mineCount 个块 (哈希全变),
     * 且 forkHeight 之上的日志在链上消失 (要"重新打包"得自己再 addLog)。
     */
    reorgAt(forkHeight: number, mineCount: number) {
      const keep = blocks.filter((b) => b.number <= forkHeight);
      blocks.length = 0;
      blocks.push(...keep);
      epoch++;
      for (let i = 0; i < mineCount; i++) mine(blocks[blocks.length - 1].number + 1);
      for (let i = logs.length - 1; i >= 0; i--) if (logs[i].blockNumber > forkHeight) logs.splice(i, 1);
      return blocks[blocks.length - 1].number;
    },
    /** 丢掉最上面 depth 个块, 链变短 (anvil_rollback 的语义) */
    truncate(depth: number) {
      for (let i = 0; i < depth; i++) blocks.pop();
      const top = blocks[blocks.length - 1].number;
      for (let i = logs.length - 1; i >= 0; i--) if (logs[i].blockNumber > top) logs.splice(i, 1);
      return top;
    },
    addLog(eventName: string, args: any[], blockNumber: number, logIndex = 0, txHashSeed?: string) {
      const frag = INDEX_IFACE.getEvent(eventName)!;
      const { topics, data } = INDEX_IFACE.encodeEventLog(frag, args);
      seq++;
      const seed = (txHashSeed ?? `f${seq.toString(16)}`).padEnd(64, '0').slice(0, 64);
      const txHash = '0x' + seed;
      const log = {
        address: ESCROW, topics: [...topics], data, blockNumber, logIndex,
        transactionHash: txHash, transactionIndex: 0, blockHash: hashOf(blockNumber), removed: false,
        // ethers v6 的 Log 对象里没有 logIndex, 只有 index —— 真链走的正是 index
        index: logIndex,
      };
      logs.push(log);
      return log;
    },
    getLogsCalls() { return calls; },
    /** 换地址的日志: 索引器必须无视 (只认 escrow 地址 + 认得的 topic0) */
    addForeignLog(blockNumber: number) {
      const frag = INDEX_IFACE.getEvent('ReleasedV2')!;
      const { topics, data } = INDEX_IFACE.encodeEventLog(frag, [TASK_A, OTHER_ADDR, 1n, 0]);
      logs.push({
        address: OTHER_ADDR, topics: [...topics], data, blockNumber, logIndex: 9,
        transactionHash: '0x' + 'ff'.repeat(32), transactionIndex: 1, blockHash: hashOf(blockNumber), removed: false,
      });
    },
  };
}

const createdArgs = (taskKey: string) => [taskKey, '0x' + '33'.repeat(32), '0x' + 'b0'.repeat(20), '0x' + 'a0'.repeat(20), '0x' + '55'.repeat(20), 100_000_000n, 9_999_999_999n, 3600, 1, 1];
const releasedArgs = (taskKey: string, by = 0) => [taskKey, '0x' + 'a0'.repeat(20), 100_000_000n, by];
const proofArgs = (taskKey: string) => [taskKey, '0x' + '12'.repeat(32), '0x' + '88'.repeat(32), '0x' + '44'.repeat(32), 1];
const expiredArgs = (taskKey: string) => [taskKey, '0x' + 'd0'.repeat(20), '0x' + 'b0'.repeat(20), 50_000_000n];

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-indexer-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const mkIndexer = (chain: ReturnType<typeof fakeChain>, extra: Partial<ConstructorParameters<typeof ChainIndexer>[0]> = {}) =>
  new ChainIndexer({
    provider: chain.provider, escrowAddress: ESCROW, chainId: 31337, networkName: 'fake',
    deploymentBlock: 10, home: HOME, pageSize: 50, reorgDepth: 8, checkpointEvery: 1000,
    ...extra,
  });

// ── ① 去重 / 幂等 ────────────────────────────────────────────────────────────

describe('去重 (同一 txHash+logIndex 只入库一次)', () => {
  it('同一次 getLogs 返回里重复的日志只入库一条', async () => {
    const chain = fakeChain(20);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15, 0, 'a1');
    const dup = { ...chain.logs[0] };
    chain.logs.push(dup); // 同键重复 (坏 RPC / 代理重放)
    const idx = mkIndexer(chain);
    const r = await idx.syncFrom();
    expect(r.inserted).toBe(1);
    expect(r.deduped).toBe(1);
    expect(idx.load().entries.length).toBe(1);
  });

  it('幂等重跑 (syncFrom(deploymentBlock) 手动补扫) 不产生重复', async () => {
    const chain = fakeChain(20);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15, 0, 'a1');
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 16, 1, 'a2');
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    const first = idx.load().entries.length;
    const again = await idx.syncFrom(10); // 显式从部署块重扫
    expect(first).toBe(2);
    expect(again.deduped).toBe(2);
    expect(again.inserted).toBe(0);
    expect(idx.load().entries.length).toBe(2);
  });

  it('非本合约地址 / 不认识的 topic0 一律不入库', async () => {
    const chain = fakeChain(20);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15);
    chain.addForeignLog(16); // 别的地址发的 ReleasedV2
    const idx = mkIndexer(chain);
    const r = await idx.syncFrom();
    // 真节点按 address/topic0 过滤 (假链也一样) → 只回来 1 条; 索引里也只有 1 条
    expect(r.logsFound).toBe(1);
    expect(r.inserted).toBe(1);
    expect(idx.load().entries.length).toBe(1);
    expect(idx.load().entries[0].eventName).toBe('EscrowCreatedV2');
    // 查询确实带了 address + 6 个 v2 事件的 topic0
    const q = chain.getLogsCalls();
    expect(q.length).toBeGreaterThan(0);
  });

  it('日志只带 index (ethers v6 Log 形状) 也能入库 —— 真链上没有 logIndex 字段', async () => {
    const chain = fakeChain(20);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15, 3 /* logIndex */, 'a1');
    // 模拟 ethers v6: 删掉 logIndex, 只留 index
    delete (chain.logs[0] as any).logIndex;
    const idx = mkIndexer(chain);
    const r = await idx.syncFrom();
    expect(r.inserted).toBe(1);
    expect(idx.load().entries[0].logIndex).toBe(3);
    expect(idx.load().entries[0].key).toBe(`${chain.logs[0].transactionHash.toLowerCase()}:3`);
  });

  it('盘上被手改出重复键 → 读回来被压掉 (坏文件不许渗进来)', () => {
    const f = chainIndexPath(HOME);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const e: ChainIndexEntry = {
      key: '0x' + 'a1'.repeat(32) + ':0', blockNumber: 15, blockHash: '0x' + '11'.repeat(32),
      txHash: '0x' + 'a1'.repeat(32), txIndex: 0, logIndex: 0, address: ESCROW, eventName: 'ReleasedV2',
      taskKey: TASK_A, args: {}, confirmations: 1, finality: 'confirmed', suspect: false,
      firstSeenAt: 1, updatedAt: 1, history: [],
    };
    fs.writeFileSync(f, JSON.stringify({
      schemaVersion: 2, chainId: 31337, networkName: 'fake', escrowAddress: ESCROW, deploymentBlock: 10,
      lastSyncedBlock: 20, lastSyncedAt: 1, headBlock: 20, headBlockHash: '0x' + '22'.repeat(32),
      confirmations: { confirmed: 1, finalized: 12 }, pageSize: 50, reorgDepth: 8,
      entries: [e, { ...e }], recentBlocks: [], runs: [], updatedAt: 1,
    }), 'utf8');
    const chain = fakeChain(20);
    const idx = mkIndexer(chain);
    expect(idx.load().entries.length).toBe(1);
  });
});

// ── ② 增量 / 重启继续 ───────────────────────────────────────────────────────

describe('增量同步 (不重扫全链)', () => {
  it('第一次从 deploymentBlock 开始; 第二次从 lastSyncedBlock+1 开始', async () => {
    const chain = fakeChain(40);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15);
    const idx = mkIndexer(chain, { pageSize: 10 });
    const r1 = await idx.syncFrom();
    expect(r1.scanFrom).toBe(10);
    expect(r1.scanTo).toBe(40);
    expect(r1.pages).toBe(4); // 10..19,20..29,30..39,40..40
    chain.mine(5); // → head 45
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 43);
    const r2 = await idx.syncFrom();
    expect(r2.scanFrom).toBe(41);
    expect(r2.scanTo).toBe(45);
    expect(r2.blocksScanned).toBe(5);
    expect(r2.inserted).toBe(1);
    expect(r2.deduped).toBe(0);
    // 增量: 没有一条 range 落在 [deploymentBlock, lastSyncedBlock]
    expect(r2.ranges.every((rg) => rg.from > 40)).toBe(true);
    expect(idx.load().entries.length).toBe(2);
  });

  it('重启 (新实例读同一个盘) 从已记高度继续, 且不会重复入库', async () => {
    const chain = fakeChain(30);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 12);
    const a = mkIndexer(chain);
    await a.syncFrom();
    const persisted = JSON.parse(fs.readFileSync(chainIndexPath(HOME), 'utf8'));
    expect(persisted.lastSyncedBlock).toBe(30);
    expect(persisted.lastSyncedAt).toBeGreaterThan(0);

    chain.mine(3);
    chain.addLog('ProofSubmittedV2', proofArgs(TASK_A), 32);
    const b = mkIndexer(chain); // "重启"
    const r = await b.syncFrom();
    expect(r.scanFrom).toBe(31);
    expect(r.inserted).toBe(1);
    expect(b.load().entries.length).toBe(2);
    // 确认数分层: 12 位的旧事件在 head=33 时是 finalized; 32 块上的新事件只有 2 确认 → confirmed
    const byKey = new Map(b.load().entries.map((e) => [e.blockNumber, e]));
    expect(byKey.get(12)!.finality).toBe('finalized');
    expect(byKey.get(32)!.finality).toBe('confirmed');
  });

  it('无新块时 sync 是空转 (0 页/0 入库), 不重复写', async () => {
    const chain = fakeChain(20);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15);
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    const r = await idx.syncFrom();
    expect(r.blocksScanned).toBe(0);
    expect(r.pages).toBe(0);
    expect(r.inserted).toBe(0);
    expect(idx.load().entries.length).toBe(1);
  });

  it('每 checkpointEvery 页落一次盘 (中断后可从已扫高度继续)', async () => {
    const chain = fakeChain(50);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 11);
    const idx = mkIndexer(chain, { pageSize: 10, checkpointEvery: 2 });
    await idx.syncFrom();
    const runs = idx.load().runs;
    expect(runs.length).toBe(1);
    expect(runs[0].pages).toBe(5);
    // checkpoint 落到 20/40/50 都写进了盘 → 盘上高度 = head
    expect(idx.load().lastSyncedBlock).toBe(50);
  });
});

// ── ③ 分页边界 ──────────────────────────────────────────────────────────────

describe('分页边界 (跨越多个 block-range 不错漏)', () => {
  it('区间无缝且无重叠, 边界块上的日志全部入库', async () => {
    const chain = fakeChain(0);
    for (let n = 0; n < 100; n++) chain.mine(); // head = 100
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 10);   // 第一页的第一块
    chain.addLog('ProofSubmittedV2', proofArgs(TASK_A), 19);    // 第一页的最后一块
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 20);       // 第二页的第一块
    chain.addLog('DisputedV2', [TASK_B, '0x' + 'e0'.repeat(20), '0x' + '33'.repeat(32)], 100); // 最后一块
    const idx = mkIndexer(chain, { pageSize: 10 });
    const r = await idx.syncFrom();
    expect(r.pages).toBe(10); // 10..19 … 100..100
    expect(r.ranges[0]).toEqual({ from: 10, to: 19 });
    expect(r.ranges[r.ranges.length - 1]).toEqual({ from: 100, to: 100 });
    // 无缝无重叠
    for (let i = 1; i < r.ranges.length; i++) expect(r.ranges[i].from).toBe(r.ranges[i - 1].to + 1);
    expect(r.ranges[0].from).toBe(10);
    expect(r.ranges[r.ranges.length - 1].to).toBe(100);
    expect(r.blocksScanned).toBe(91);
    expect(r.inserted).toBe(4);
    const blocks = idx.load().entries.map((e) => e.blockNumber);
    expect(blocks).toEqual([10, 19, 20, 100]);
  });

  it('provider 的 block-range 限制触发对半拆: 边界日志一条不漏, 页数上升但不丢数据', async () => {
    const chain = fakeChain(0);
    for (let n = 0; n < 60; n++) chain.mine(); // head = 60
    chain.setRangeLimit(4); // 假 provider 只接受 ≤4 块的区间
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 30);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 34);
    const idx = mkIndexer(chain, { pageSize: 30 });
    const r = await idx.syncFrom();
    expect(r.inserted).toBe(2);
    // 无缝覆盖 [10, 60]
    const covered = r.ranges.flatMap((rg) => rg.from).concat(r.ranges[r.ranges.length - 1].to);
    expect(covered[0]).toBe(10);
    expect(covered[covered.length - 1]).toBe(60);
    for (let b = 10; b <= 60; b++) {
      expect(r.ranges.some((rg) => b >= rg.from && b <= rg.to), `块 ${b} 被漏掉`).toBe(true);
    }
    // 对半拆的痕迹: 出现了 < pageSize 的区间
    expect(r.ranges.some((rg) => rg.to - rg.from + 1 < 30)).toBe(true);
  });
});

// ── ④ 重组 ──────────────────────────────────────────────────────────────────

describe('重组 (回退区间 + 标 suspect, 不静默丢弃)', () => {
  it('顶块哈希变化 → 回退受影响区块 + 记录标 suspect + lastSyncedBlock 回退', async () => {
    const chain = fakeChain(30);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 20);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 28);
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    expect(idx.load().entries.length).toBe(2);

    // 真重组: 分叉点 27, 上面重新挖 3 个块 (28/29/30 哈希全变), 28 块上的日志消失
    chain.reorgAt(27, 3);
    const r = await idx.syncFrom();
    expect(r.rewoundTo).toBe(27); // 27 块仍是同一哈希 → 分叉点定准
    expect(r.scanFrom).toBe(28);
    expect(r.markedSuspect).toBeGreaterThanOrEqual(1);

    const st = idx.load();
    const released = st.entries.find((e) => e.eventName === 'ReleasedV2')!;
    expect(released.suspect).toBe(true);          // ★ 不是丢弃
    expect(released.suspectReason).toContain('重组');
    expect(released.finality).toBe('observed');   // 被回退 → 降级为"仅观测到"
    expect(st.entries.find((e) => e.eventName === 'EscrowCreatedV2')!.suspect).toBe(false);
    expect(st.lastSyncedBlock).toBe(30);
    expect(r.orphans).toContain(released.key);    // 回退后没再扫到 → 明确列出来
  });

  it('链比索引矮 (anvil_rollback 语义) → 高于 head 的记录标 suspect + 索引高度回退', async () => {
    const chain = fakeChain(30);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 20);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 28);
    const idx = mkIndexer(chain);
    await idx.syncFrom();

    chain.truncate(5); // 链回滚到 25 块, 28 块整块没了
    const r = await idx.syncFrom();
    expect(r.markedSuspect).toBe(1);
    const st = idx.load();
    const released = st.entries.find((e) => e.eventName === 'ReleasedV2')!;
    expect(released.suspect).toBe(true);
    expect(released.suspectReason).toContain('链已回滚');
    expect(st.lastSyncedBlock).toBe(25);
    expect(st.entries.find((e) => e.eventName === 'EscrowCreatedV2')!.suspect).toBe(false);
  });

  it('回退后重新打包 (同 txHash:logIndex 出现在新块) → 复位 suspect 并记 history', async () => {
    const chain = fakeChain(30);
    const log = chain.addLog('ReleasedV2', releasedArgs(TASK_A), 28, 0, 'a1');
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    chain.reorgAt(27, 1); // 28 块的日志消失
    await idx.syncFrom();
    const suspect = idx.load().entries.find((e) => e.key === `${log.transactionHash}:0`)!;
    expect(suspect.suspect).toBe(true);

    // 同一笔交易被重新打包到新块 28 (同 txHash + 同 logIndex, 块哈希不同)
    chain.mine(2);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 29, 0, 'a1');
    const r = await idx.syncFrom();
    expect(r.restored).toBe(1);
    const after = idx.load().entries.find((e) => e.key === `${log.transactionHash}:0`)!;
    expect(after.suspect).toBe(false);
    expect(after.blockNumber).toBe(29);
    expect(after.history.some((h) => h.note.includes('重新上链'))).toBe(true);
    // 去重没被破坏: 还是只有一条
    expect(idx.load().entries.filter((e) => e.key === after.key).length).toBe(1);
    expect(idx.stats().suspects).toBe(0);
  });

  it('★ 同块同哈希再次扫到 (真链 anvil_rollback + 重放会复现同一块) → 也必须复位 suspect', async () => {
    const chain = fakeChain(30);
    const log = chain.addLog('ReleasedV2', releasedArgs(TASK_A), 28, 0, 'a1');
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    chain.truncate(3);                 // 块 28-30 整块消失 (epoch 不变 → 重挖出来哈希一样)
    await idx.syncFrom();
    expect(idx.load().entries.find((e) => e.key === `${log.transactionHash}:0`)!.suspect).toBe(true);
    chain.mine(3);                     // 重新挖回块 28-30 (哈希与原来相同)
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 28, 0, 'a1');
    const r = await idx.syncFrom();
    const back = idx.load().entries.find((e) => e.key === `${log.transactionHash}:0`)!;
    expect(r.restored).toBe(1);
    expect(back.suspect).toBe(false);
    expect(back.blockHash).toBe(chain.blocks.find((b) => b.number === 28)!.hash);
    expect(back.history.some((h) => h.note.includes('复位'))).toBe(true);
    expect(idx.load().entries.filter((e) => e.key === back.key).length).toBe(1);
    expect(idx.stats().suspects).toBe(0);
  });

  it('eth_getLogs 返回 removed=true → 标 suspect (不当作正常日志)', async () => {
    const chain = fakeChain(20);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 15, 0, 'a1');
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    chain.logs[0].removed = true;
    await idx.syncFrom(10); // 手动补扫碰到 removed 日志
    const e = idx.load().entries[0];
    expect(e.suspect).toBe(true);
    expect(e.suspectReason).toContain('removed=true');
  });

  it('RPC 读不到块 (链被重置) → 不静默当没重组: 从 deploymentBlock 重扫并标 suspect', async () => {
    const chain = fakeChain(30);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 25);
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    // 链被重置到很矮 (旧块号查不到) → 深度回退
    chain.truncate(25); // head = 5
    const r = await idx.syncFrom();
    expect(r.rewoundTo).toBe(9); // deploymentBlock - 1
    expect(r.markedSuspect).toBe(1);
    expect(idx.load().entries[0].suspect).toBe(true);
  });
});

// ── ⑤ 全量重建一致 ──────────────────────────────────────────────────────────

describe('rebuild() 全量重建与增量一致', () => {
  it('重建结果 == 增量结果 (逐条比对 same=true), 且重建后 entries 被替换', async () => {
    const chain = fakeChain(30);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 12);
    chain.addLog('ProofSubmittedV2', proofArgs(TASK_A), 13);
    chain.mine(20);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 45);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_B), 46, 1, 'b9');
    chain.addLog('ExpiredV2', expiredArgs(TASK_B), 50, 0, 'c7');
    const idx = mkIndexer(chain, { pageSize: 7 });
    await idx.syncFrom();
    const incremental = idx.load().entries;

    const rb = await idx.rebuild({ persist: false });
    expect(rb.mode).toBe('rebuild');
    expect(rb.blocksScanned).toBe(50 - 10 + 1);
    expect(rb.comparison.same).toBe(true);
    expect(rb.comparison.countA).toBe(incremental.length);
    expect(rb.comparison.countB).toBe(rb.entries);
    expect(rb.entries).toBe(5); // created A / proof A / released A / created B / expired B

    const rb2 = await idx.rebuild({ persist: true });
    expect(rb2.comparison.same).toBe(true);
    const after = idx.load();
    expect(after.rebuiltAt).toBeGreaterThan(0);
    expect(after.entries.length).toBe(5);
    expect(after.lastSyncedBlock).toBe(50);
    // 重建后继续增量: 新块照旧入库
    chain.mine(2);
    chain.addLog('DisputedV2', [TASK_A, '0x' + 'e0'.repeat(20), '0x' + '33'.repeat(32)], 52, 0, 'd1');
    const r = await idx.syncFrom();
    expect(r.scanFrom).toBe(51);
    expect(r.inserted).toBe(1);
  });

  it('重建保留"链上已消失"的 suspect 记录 (审计不丢), 但不再计入业务统计', async () => {
    const chain = fakeChain(30);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 20);
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 28);
    const idx = mkIndexer(chain);
    await idx.syncFrom();
    chain.reorgAt(27, 3); // 28 块的 release 在链上消失
    await idx.syncFrom();
    expect(idx.load().entries.filter((e) => e.suspect).length).toBe(1);

    await idx.rebuild({ persist: true });
    const entries = idx.load().entries;
    expect(entries.filter((e) => e.suspect).length).toBe(1); // 保留
    expect(entries.filter((e) => !e.suspect).length).toBe(1); // 重建的真实日志
    const stats = getIndexStats({ home: HOME });
    expect(stats.released).toBe(0);
    expect(stats.suspects).toBe(1);
  });

  it('compareIndexes 能报出差异 (重建多一条 / 块号变了)', () => {
    const mk = (key: string, blockNumber: number): ChainIndexEntry => ({
      key, blockNumber, blockHash: '0x' + '11'.repeat(32), txHash: key.split(':')[0], txIndex: 0,
      logIndex: 0, address: ESCROW, eventName: 'ReleasedV2', taskKey: TASK_A, args: { by: '0' },
      confirmations: 1, finality: 'confirmed', suspect: false, firstSeenAt: 1, updatedAt: 1, history: [],
    });
    const a = [mk('0x' + 'a1'.repeat(32) + ':0', 20)];
    const b = [mk('0x' + 'a1'.repeat(32) + ':0', 21)];
    const c = [...b, mk('0x' + 'a2'.repeat(32) + ':0', 22)];
    expect(compareIndexes(a, a).same).toBe(true);
    const d = compareIndexes(a, b);
    expect(d.same).toBe(false);
    expect(d.mismatched[0].field).toBe('blockNumber');
    expect(compareIndexes(a, c).extraInB.length).toBe(1);
    expect(compareIndexes(c, a).missingInB.length).toBe(1);
  });
});

// ── ⑥ finality 分层 ────────────────────────────────────────────────────────

describe('finality 分层 (按确认数门槛 observed|confirmed|finalized)', () => {
  it('0~1 确认 = confirmed, ≥12 = finalized; 门槛来自配置', async () => {
    const chain = fakeChain(0);
    for (let n = 0; n < 60; n++) chain.mine();
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 10, 0, 'a1');  // 51 确认
    chain.addLog('ReleasedV2', releasedArgs(TASK_A), 49, 0, 'a2');      // 12 确认 = 门槛
    chain.addLog('RefundedV2', [TASK_B, '0x' + 'b0'.repeat(20), 1n, '0x' + '33'.repeat(32)], 50, 0, 'a3'); // 11 确认
    chain.addLog('DisputedV2', [TASK_B, '0x' + 'e0'.repeat(20), '0x' + '33'.repeat(32)], 60, 0, 'a4');     // 1 确认
    const idx = mkIndexer(chain, { pageSize: 100 });
    await idx.syncFrom();
    const fin = (b: number) => idx.load().entries.find((e) => e.blockNumber === b)!.finality;
    expect(fin(10)).toBe('finalized');
    expect(fin(49)).toBe('finalized');  // 60-49+1 = 12 → 刚好过门槛
    expect(fin(50)).toBe('confirmed');  // 11
    expect(fin(60)).toBe('confirmed');  // 1
    const stats = getIndexStats({ home: HOME });
    expect(stats.byFinality.finalized).toBe(2);
    expect(stats.byFinality.confirmed).toBe(2);
    // 自定义门槛: 把门槛抬到 confirmed=20/finalized=40 → 12 确认的降为 observed
    const strict = mkIndexer(chain, { pageSize: 100, confirmations: { confirmed: 20, finalized: 40 } });
    await strict.syncFrom(); // 无新块, 但确认数分层会按新门槛重算并落盘
    expect(strict.status().confirmations).toEqual({ confirmed: 20, finalized: 40 });
    const fin2 = (b: number) => strict.load().entries.find((e) => e.blockNumber === b)!.finality;
    expect(fin2(10)).toBe('finalized'); // 51 ≥ 40
    expect(fin2(49)).toBe('observed');  // 12 < 20
    expect(fin2(60)).toBe('observed');  // 1 < 20
  });
});

// ── ⑦ deployment block 来自 manifest (不硬编码) ──────────────────────────────

describe('索引起点来自部署 manifest', () => {
  it('按 chainId + escrow 地址匹配 manifest, 读 contracts[AgentEscrow].blockNumber', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-deployments-'));
    fs.writeFileSync(path.join(dir, 'localhost.json'), JSON.stringify({
      chainId: 31337, networkName: 'localhost',
      contracts: [{ name: 'AgentEscrow', address: ESCROW, blockNumber: 111 }],
    }));
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({
      chainId: 999, networkName: 'other',
      contracts: [{ name: 'AgentEscrow', address: '0x' + '11'.repeat(20), blockNumber: 7 }],
    }));
    const info = resolveDeploymentInfo({ chainId: 31337, escrowAddress: ESCROW, deploymentsDir: dir, env: {} as any });
    expect(info.deploymentBlock).toBe(111);
    expect(info.networkName).toBe('localhost');
    expect(info.source).toContain('manifest');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('env 显式给起点时优先 env', () => {
    const info = resolveDeploymentInfo({ deploymentsDir: '/nonexistent-dir-xyz', env: { BOLLOON_ESCROW_DEPLOYMENT_BLOCK: '47142222' } as any });
    expect(info.deploymentBlock).toBe(47142222);
    expect(info.source).toContain('env');
  });

  it('找不到 manifest 且没给起点 → 抛错 (绝不猜 0)', () => {
    expect(() => resolveDeploymentInfo({ chainId: 31337, escrowAddress: ESCROW, deploymentsDir: '/nonexistent-dir-xyz', env: {} as any }))
      .toThrow(/deploymentBlock/);
  });

  it('索引器用 manifest 的块做起点 (不是 0, 也不是硬编码)', async () => {
    const chain = fakeChain(120);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 111);
    const idx = new ChainIndexer({
      provider: chain.provider, escrowAddress: ESCROW, chainId: 31337, deploymentBlock: 111,
      deploymentSource: 'test: manifest', home: HOME, pageSize: 100,
    });
    const r = await idx.syncFrom();
    expect(r.scanFrom).toBe(111);
    expect(r.inserted).toBe(1);
    expect(idx.load().deploymentBlock).toBe(111);
  });
});

// ── ⑧ 只读查询接口 ──────────────────────────────────────────────────────────

describe('只读查询 (时间线 / cursor 增量 / 统计 / 索引高度)', () => {
  let chain: ReturnType<typeof fakeChain>;
  beforeEach(async () => {
    chain = fakeChain(80);
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_A), 12, 0, 'a1');
    chain.addLog('ProofSubmittedV2', proofArgs(TASK_A), 20, 0, 'a2');
    chain.addLog('ReleasedV2', releasedArgs(TASK_A, 0), 30, 0, 'a3');
    chain.addLog('EscrowCreatedV2', createdArgs(TASK_B), 31, 1, 'b1');
    chain.addLog('DisputedV2', [TASK_B, '0x' + 'e0'.repeat(20), '0x' + '33'.repeat(32)], 40, 0, 'b2');
    chain.addLog('RefundedV2', [TASK_B, '0x' + 'b0'.repeat(20), 5n, '0x' + '33'.repeat(32)], 41, 0, 'b3');
    chain.addLog('EscrowCreatedV2', createdArgs('0x' + 'cd'.repeat(32)), 42, 0, 'c1');
    chain.addLog('ExpiredV2', expiredArgs('0x' + 'cd'.repeat(32)), 43, 0, 'c2');
    const idx = mkIndexer(chain, { pageSize: 100 });
    await idx.syncFrom();
  });

  it('getIndexStatus: 索引高度 + 最后同步时间 + 确认数门槛', () => {
    const s = getIndexStatus({ home: HOME });
    expect(s.lastSyncedBlock).toBe(80);
    expect(s.headBlock).toBe(80);
    expect(s.lastSyncedAt).toBeGreaterThan(0);
    expect(s.lastSyncedAgoMs).toBeLessThan(60_000);
    expect(s.entries).toBe(8);
    expect(s.suspects).toBe(0);
    expect(s.confirmations).toEqual({ confirmed: 1, finalized: 12 });
    expect(s.indexPath).toBe(chainIndexPath(HOME));
    expect(s.lagFromSnapshot).toBe(0);
  });

  it('getIndexStats: tasks/released/refunded/disputed/expired 计数', () => {
    const st = getIndexStats({ home: HOME });
    expect(st.tasks).toBe(3);
    expect(st.created).toBe(3);
    expect(st.proofSubmitted).toBe(1);
    expect(st.released).toBe(1);
    expect(st.refunded).toBe(1);
    expect(st.disputed).toBe(1);
    expect(st.expired).toBe(1);
    expect(st.entries).toBe(8);
    expect(st.byFinality.finalized).toBe(8); // 12..43 块, head=80 → 全部 ≥12 确认
    expect(st.byFinality.confirmed).toBe(0);
    expect(st.byFinality.observed).toBe(0);
  });

  it('getEscrowTimeline: 按 taskKey 查时间线 + 推出状态', () => {
    const a = getEscrowTimeline(TASK_A, { home: HOME });
    expect(a.count).toBe(3);
    expect(a.events.map((e) => e.eventName)).toEqual(['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2']);
    expect(a.state).toBe('RELEASED');
    expect(a.hasSuspect).toBe(false);
    expect(a.events[0].args.amount).toBe('100000000');
    expect(a.events[0].blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    const b = getEscrowTimeline(TASK_B, { home: HOME });
    expect(b.state).toBe('REFUNDED'); // refund 优先于 disputed
    const c = getEscrowTimeline('0x' + 'cd'.repeat(32), { home: HOME });
    expect(c.state).toBe('EXPIRED');
    expect(getEscrowTimeline('0x' + 'ee'.repeat(32), { home: HOME }).count).toBe(0);
    // 非法的 taskKey 不做模糊搜
    expect(getEscrowTimeline('not-a-key', { home: HOME }).count).toBe(0);
    expect(deriveEscrowState([])).toBeNull();
  });

  it('fetchIndexSince: cursor 严格递增、limit 生效、nextCursor 可续拉', () => {
    const p1 = fetchIndexSince(null, { home: HOME, limit: 3 });
    expect(p1.events.length).toBe(3);
    expect(p1.remaining).toBe(8);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toEqual({ blockNumber: 30, logIndex: 0 });
    const p2 = fetchIndexSince(p1.nextCursor, { home: HOME, limit: 3 });
    expect(p2.events[0].blockNumber).toBe(31);
    // 严格大于: 同一个 cursor 再拉不重复 (幂等)
    const p2again = fetchIndexSince(p1.nextCursor, { home: HOME, limit: 3 });
    expect(p2again.events.map((e) => e.blockNumber)).toEqual(p2.events.map((e) => e.blockNumber));
    const p3 = fetchIndexSince(p2.nextCursor, { home: HOME, limit: 10 });
    expect(p3.events.length).toBe(2);
    expect(p3.hasMore).toBe(false);
    const p4 = fetchIndexSince(p3.nextCursor, { home: HOME, limit: 10 });
    expect(p4.events.length).toBe(0);
    expect(p4.nextCursor).toEqual(p3.nextCursor);
  });

  it('只读查询绝不发 RPC (没有 provider 也能读), 且不写盘', () => {
    const before = fs.statSync(chainIndexPath(HOME)).mtimeMs;
    const st = getIndexStatus({ home: HOME });
    const stats = getIndexStats({ home: HOME });
    fetchIndexSince(null, { home: HOME });
    getEscrowTimeline(TASK_A, { home: HOME });
    expect(st.entries).toBe(8);
    expect(stats.entries).toBe(8);
    expect(fs.statSync(chainIndexPath(HOME)).mtimeMs).toBe(before);
  });

  it('索引文件不存在 → 空结果 (不假装有数据)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-noindex-'));
    const st = getIndexStatus({ home: empty });
    expect(st.entries).toBe(0);
    expect(st.lastSyncedBlock).toBe(-1);
    expect(st.lastSyncedAt).toBeNull();
    expect(getIndexStats({ home: empty }).tasks).toBe(0);
    expect(fetchIndexSince(null, { home: empty }).events).toEqual([]);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('索引器实例上的 timeline()/stats()/status() 与只读模块一致', async () => {
    const idx = mkIndexer(chain);
    expect(idx.timeline(TASK_A).count).toBe(3);
    expect(idx.stats().released).toBe(1);
    expect(idx.status().lastSyncedBlock).toBe(80);
    expect(idx.fetchAfter({ blockNumber: 30, logIndex: 0 }, 1).events[0].blockNumber).toBe(31);
  });
});

// ── ⑨ 事件名清单 ────────────────────────────────────────────────────────────

describe('事件清单', () => {
  it('索引的 v2 事件 = 5 个 + F2b 的 ExpiredV2 (与 ABI 逐字一致)', () => {
    expect([...INDEXED_EVENT_NAMES].sort()).toEqual(
      ['DisputedV2', 'EscrowCreatedV2', 'ExpiredV2', 'ProofSubmittedV2', 'RefundedV2', 'ReleasedV2'].sort(),
    );
    // topic0 与 contracts/deployments/abis/AgentEscrow.json 记录的一致
    expect(String(INDEX_IFACE.getEvent('EscrowCreatedV2')!.topicHash).toLowerCase())
      .toBe('0x048424d461a91a8484bd99f1889c08e656f61e055f494da311e157d80aab154a');
    expect(String(INDEX_IFACE.getEvent('ExpiredV2')!.topicHash).toLowerCase())
      .toBe('0x517f3d5ae4ce226ad2ddd19ebb76fbf5446cc187b99bdb98e3442e21af73a7d5');
  });
});
