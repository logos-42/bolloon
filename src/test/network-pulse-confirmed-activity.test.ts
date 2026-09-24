/**
 * network-pulse-confirmed-activity.test.ts — 冻结形状 `confirmed_activity` 的单测
 *
 * 覆盖 (验收点名项):
 *   ① 形状: 9 个字段齐全 + 顺序冻结 + 取值域/格式正确
 *   ② 匿名: task / tx 只出 sha256 短写, 绝不出 taskKey / taskId / txHash 原文, 也无任何私有字段
 *   ③ 上限 25 行
 *   ④ 排序: 最新在前 (block desc, logIndex desc)
 *   ⑤ state 映射: EscrowCreatedV2→active · ReleasedV2→released · RefundedV2→refunded ·
 *      ExpiredV2→expired · DisputedV2→disputed (kind 由映射表定, 不认识的事件不成行)
 *   ⑥ 降级与来源标注: 链上索引读不出/空/没有可用行 → 退回脉冲事件并标 source;
 *      确认不够门槛的行只报 observed (不冒充)
 *   ⑦ 绝不出现非匿名字段
 *
 * 数据源优先级测试用**真索引文件** (写进临时 HOME 的 ~/.bolloon/chain/index.json) 跑一遍
 * 端到端 (getNetworkPulse), 纯映射部分用夹具喂纯函数。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as NP from '../agents/network-pulse.js';

const NOW = Date.UTC(2026, 8, 22, 5, 31, 0);           // 2026-09-22T05:31:00Z
const TASK_A = '0x' + 'ab'.repeat(32);
const TASK_B = '0x' + '12'.repeat(32);
const TX_A = '0x' + 'cd'.repeat(32);
const TX_B = '0x' + '9f'.repeat(32);

/** 冻结形状的字段名与顺序 (逐字): 老 9 个 —— 脉冲降级行就是这 9 个, 一个新字段都不加 */
const FROZEN_KEYS = ['task', 'kind', 'state', 'chain_id', 'block', 'tx', 'confirmations', 'finality', 'at'];
/**
 * 链上索引行的完整形状 (2026-09-23; 同日按 leo 拍板收窄): 老 9 个 + 3 个可核验字段,
 * **追加在尾部** (老消费方按名取值不受影响)。
 *   · `tx_hash` 真交易哈希 · `explorer_tx` 交易浏览器链接 (该链有公网浏览器才有)
 *   · `contract` escrow 合约地址 —— **只在数据里**(索引/诊断), 页面不渲染、不生成合约链接
 *   · 3 个字段都是可选的 (拿不到就不给), 这里按「全给」的夹具断言完整名单, 另有断言「缺则键不存在」
 */
const CHAIN_KEYS = [...FROZEN_KEYS, 'tx_hash', 'contract', 'explorer_tx'];
const KINDS = ['task_created', 'task_accepted', 'task_completed', 'trade_settled', 'trade_verified'];
const STATES = ['active', 'released', 'refunded', 'expired', 'disputed', 'unknown'];
const FINALITIES = ['observed', 'confirmed', 'finalized'];
/** 夹具用的 escrow **合约**地址 (小写 40 hex; 与索引文件顶层 escrowAddress 同值才有合约字段) */
const ESCROW_X = '0x' + '11'.repeat(20);
/** ★ 买方/卖方 EOA (假值, 真形态): 绝不许出现在任何公开输出里 */
const BUYER_EOA = '0xb4e9dcf79055a8232670ebb1c8c664dff4e70066';
const SELLER_EOA = '0x5ca9fb35d795b436f0ebddde7f25020c35ea8f9e';

const entry = (over: Partial<NP.ChainActivitySourceEntry> = {}): NP.ChainActivitySourceEntry => ({
  blockNumber: 100, logIndex: 0, eventName: 'EscrowCreatedV2',
  taskKey: TASK_A, txHash: TX_A, address: ESCROW_X, confirmations: 1, suspect: false, firstSeenAt: NOW,
  ...over,
});

const tmpHome = (): string => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-activity-'));
  fs.mkdirSync(path.join(h, '.bolloon'), { recursive: true });
  return h;
};

let HOME = '';
beforeEach(() => { HOME = tmpHome(); });
afterEach(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

describe('confirmed_activity · 形状与匿名 (冻结字段逐字)', () => {
  it('字段齐全且顺序冻结 (链上路径: 老 9 个 + 新增 4 个可核验字段)', () => {
    const rows = NP.buildConfirmedActivityFromIndex([entry()], { chainId: 84532, headBlock: 47142233, escrowAddress: ESCROW_X });
    expect(rows).toHaveLength(1);
    // 老 9 个必须还在原位; 新增的 4 个只许追加在尾部 (键序一并冻结)
    expect(Object.keys(rows[0]).slice(0, 9)).toEqual(FROZEN_KEYS);
    expect(Object.keys(rows[0])).toEqual(CHAIN_KEYS);
    const r = rows[0];
    expect(r.task).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(r.tx).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(KINDS).toContain(r.kind);
    expect(STATES).toContain(r.state);
    expect(FINALITIES).toContain(r.finality);
    expect(r.chain_id).toBe(84532);
    expect(r.block).toBe(100);
    expect(r.confirmations).toBe(47142233 - 100 + 1);
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);   // ISO8601 UTC 秒级
    expect(r.at).toBe('2026-09-22T05:31:00Z');
    // 新增 3 个的取值: 真 txHash / escrow 合约地址 (数据) / sepolia.basescan **交易**链接
    expect(r.tx_hash).toBe(TX_A);
    expect(r.contract).toBe(ESCROW_X);
    expect(r.explorer_tx).toBe(`https://sepolia.basescan.org/tx/${TX_A}`);
    expect('explorer_contract' in r).toBe(false);      // 合约链接不存在 (合约不上页面)
  });

  it('链上行的新增字段是「有才给」: 拿不到 escrow / 链没浏览器 → 键整个不存在 (不是 null)', () => {
    const noEscrow = NP.buildConfirmedActivityFromIndex([entry()], { chainId: 84532, headBlock: 47142233 })[0] as any;
    expect(Object.keys(noEscrow)).toEqual([...FROZEN_KEYS, 'tx_hash', 'explorer_tx']);   // 没有合约地址 → 不给合约字段
    // 本机 31337: 没有公网浏览器 → explorer_tx 键**不存在** (页面据此保持纯文本, 不编死链)
    const local = NP.buildConfirmedActivityFromIndex([entry()], { chainId: 31337, headBlock: 200, escrowAddress: ESCROW_X })[0] as any;
    expect(Object.keys(local)).toEqual([...FROZEN_KEYS, 'tx_hash', 'contract']);
    expect('explorer_tx' in local).toBe(false);
  });

  it('字段齐全且顺序冻结 (脉冲降级路径: 仍只有老 9 个字段)', () => {
    const rows = NP.buildConfirmedActivityFromEvents([{
      type: 'task_posted', bucket: '1', occurredAt: NOW, sourceProof: 'node-1', taskProof: 'abcdef0123456789',
    } as any]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(FROZEN_KEYS);
    // 降级行没有链上事实 → 全 0 + observed (绝不冒充已确认)
    expect(rows[0]).toMatchObject({ chain_id: 0, block: 0, confirmations: 0, finality: 'observed', state: 'unknown', kind: 'task_created' });
    expect(rows[0].task).toBe('sha256:abcdef01');
  });

  it('任务标识只出 sha256 短写 (taskKey 原文一个都不出); txHash 只许出现在白名单键下, EOA 绝不出现', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      entry(), entry({ eventName: 'ReleasedV2', blockNumber: 101, logIndex: 2, taskKey: TASK_B, txHash: TX_B, firstSeenAt: NOW + 1000 }),
    ], { chainId: 31337, headBlock: 200, escrowAddress: ESCROW_X });
    const json = JSON.stringify(rows);
    for (const raw of [TASK_A, TASK_B]) {
      expect(json).not.toContain(raw);                       // taskKey 原文: 一个都不出 (含片段)
      expect(json).not.toContain(raw.slice(2, 10));
    }
    // 2026-09-23 决定变更: txHash **允许**出现, 但只许在 tx_hash 键下 (老 `tx` 短写照旧保留)
    expect(json).toContain(TX_A);
    expect(json).toContain(TX_B);
    // 短写照旧保留 (最新在前: 101 块那条 TX_B 排前)
    expect(rows.map((r) => r.tx)).toEqual([NP.anonShortRef(TX_B, 'tx'), NP.anonShortRef(TX_A, 'tx')]);
    expect(NP.auditPublicHexLeaks(rows)).toEqual([]);        // 新尺子: 白名单键外一律不许有 0x 长 hex
    expect(rows[0].task).not.toBe(rows[1].task);             // 不同任务 → 不同短写
    expect(NP.assertNoPrivateFields({ confirmed_activity: rows })).toEqual([]);
    // 卖方 EOA 塞进 address 键 → 立刻被新尺子抓到 (反向验证, 不是永远返回空)
    expect(NP.auditPublicHexLeaks({ confirmed_activity: [{ ...rows[0], address: SELLER_EOA }] }).join(' ')).toContain('泄露');
    expect(NP.auditPublicHexLeaks({ confirmed_activity: [{ ...rows[0], task: BUYER_EOA }] }).length).toBe(1);
  });

  it('任务/交易短写稳定且域隔离 (同值同写; task 与 tx 不串)', () => {
    const a = NP.anonShortRef(TASK_A, 'task');
    expect(a).toBe(NP.anonShortRef(TASK_A, 'task'));
    expect(a).not.toBe(NP.anonShortRef(TX_A, 'tx'));
    expect(NP.anonShortRef(TASK_A, 'task')).not.toBe(NP.anonShortRef(TASK_A, 'tx'));
    expect(a).toMatch(/^sha256:[0-9a-f]{8}$/);
  });

  it('脉冲降级行也不出任务原文 (taskId 只以 sha256 短写出现)', () => {
    const ev = { type: 'task_completed', bucket: '1', occurredAt: NOW, sourceProof: 'n1', taskProof: NP.nodeDigest('task:secret-task-id').slice(0, 16) } as any;
    const rows = NP.buildConfirmedActivityFromEvents([ev]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('secret-task-id');
    expect(json).not.toMatch(/0x[0-9a-fA-F]{8,}/);
    expect(rows[0].task).toBe(`sha256:${ev.taskProof.slice(0, 8)}`);
  });
});

describe('confirmed_activity · 上限与排序', () => {
  it('上限 25 行 (多了就截断, 不是 26)', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry({ blockNumber: 100 + i, logIndex: i }));
    const rows = NP.buildConfirmedActivityFromIndex(many, { headBlock: 500, chainId: 1 });
    expect(rows).toHaveLength(25);
    expect(NP.CONFIRMED_ACTIVITY_LIMIT).toBe(25);
    expect(NP.PULSE_LIMITS.maxConfirmedActivity).toBe(25);
  });

  it('脉冲降级路径同样封顶 25 行', () => {
    const evs = Array.from({ length: 30 }, (_, i) => ({
      type: 'task_posted', bucket: '1', occurredAt: NOW + i * 1000, sourceProof: 'n1',
      taskProof: NP.nodeDigest(`task:t-${i}`).slice(0, 16),
    })) as any;
    expect(NP.buildConfirmedActivityFromEvents(evs)).toHaveLength(25);
  });

  it('最新在前: block desc, 同块按 logIndex desc', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      entry({ blockNumber: 10, logIndex: 0 }),
      entry({ blockNumber: 12, logIndex: 5 }),
      entry({ blockNumber: 12, logIndex: 9 }),
      entry({ blockNumber: 11, logIndex: 1 }),
    ], { headBlock: 50, chainId: 1 });
    expect(rows.map((r) => r.block)).toEqual([12, 12, 11, 10]);
    expect(rows.map((r) => r.confirmations)).toEqual([39, 39, 40, 41]);
    // 同块同 logIndex 才有歧义; 这里同块两条按 logIndex 倒序 → tx 短写也跟着换位
    expect(rows[0].tx).toBe(NP.anonShortRef(TX_A, 'tx'));
  });

  it('脉冲降级行最新在前 (按发生时间 desc)', () => {
    const evs = [
      { type: 'task_posted', bucket: '1', occurredAt: NOW, sourceProof: 'n1', taskProof: NP.nodeDigest('task:old').slice(0, 16) },
      { type: 'task_completed', bucket: '1', occurredAt: NOW + 3600_000, sourceProof: 'n1', taskProof: NP.nodeDigest('task:new').slice(0, 16) },
    ] as any;
    const rows = NP.buildConfirmedActivityFromEvents(evs);
    expect(rows[0].at).toBe(NP.isoSeconds(NOW + 3600_000));
    expect(rows[1].at).toBe(NP.isoSeconds(NOW));
  });
});

describe('confirmed_activity · state 映射 (索引事件 → 冻结取值)', () => {
  it('六个 escrow 事件各映射到预期 (kind, state)', () => {
    const cases: Array<[string, string, string]> = [
      ['EscrowCreatedV2', 'task_created', 'active'],
      ['ProofSubmittedV2', 'task_completed', 'active'],
      ['ReleasedV2', 'trade_settled', 'released'],
      ['RefundedV2', 'trade_settled', 'refunded'],
      ['ExpiredV2', 'trade_settled', 'expired'],
      ['DisputedV2', 'trade_settled', 'disputed'],
    ];
    for (const [eventName, kind, state] of cases) {
      const rows = NP.buildConfirmedActivityFromIndex([entry({ eventName })], { chainId: 31337, headBlock: 200 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind, state });
    }
    expect(NP.CHAIN_EVENT_ACTIVITY.EscrowCreatedV2.state).toBe('active');
  });

  it('不认识的事件名 / 坏 taskKey / 坏 txHash / 缺观察时间 → 不成行 (不猜)', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      entry({ eventName: 'SomethingElseV2' }),
      entry({ taskKey: 'not-a-task-key' }),
      entry({ txHash: '0x1234' }),
      entry({ firstSeenAt: null }),
      entry({ blockNumber: Number.NaN }),
    ], { headBlock: 200, chainId: 1 });
    expect(rows).toEqual([]);
  });

  it('脉冲事件 → kind 映射 (没有 taskProof 的事件不成行)', () => {
    const evs = [
      { type: 'task_posted', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'a'.repeat(16) },
      { type: 'task_accepted', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'b'.repeat(16) },
      { type: 'task_completed', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'c'.repeat(16) },
      { type: 'trade_settled', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'd'.repeat(16) },
      { type: 'trade_verified', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'e'.repeat(16) },
      { type: 'node_joined', bucket: '1', occurredAt: NOW, sourceProof: 'n' },
    ] as any;
    const kinds = NP.buildConfirmedActivityFromEvents(evs).map((r) => r.kind).sort();
    expect(kinds).toEqual(['task_accepted', 'task_completed', 'task_created', 'trade_settled', 'trade_verified']);
    // 同一 (任务, 动作) 重复上报 → 只留最新一条
    const dup = [
      { type: 'task_posted', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'f'.repeat(16) },
      { type: 'task_posted', bucket: '1', occurredAt: NOW + 5000, sourceProof: 'n', taskProof: 'f'.repeat(16) },
    ] as any;
    const one = NP.buildConfirmedActivityFromEvents(dup);
    expect(one).toHaveLength(1);
    expect(one[0].at).toBe(NP.isoSeconds(NOW + 5000));
  });
});

describe('confirmed_activity · 确认数门槛 (不冒充 confirmed)', () => {
  it('finality 只按确认数复算: <confirmed → observed; >=confirmed → confirmed; >=finalized → finalized', () => {
    const gates = { confirmed: 1, finalized: 12 };
    expect(NP.finalityFromConfirmations(0, gates)).toBe('observed');
    expect(NP.finalityFromConfirmations(1, gates)).toBe('confirmed');
    expect(NP.finalityFromConfirmations(11, gates)).toBe('confirmed');
    expect(NP.finalityFromConfirmations(12, gates)).toBe('finalized');
    expect(NP.finalityFromConfirmations(Number.NaN, gates)).toBe('observed');
    expect(NP.finalityFromConfirmations(99, gates, { suspect: true })).toBe('observed');
    // 缺门槛 → chain-config 默认口径 (1/12)
    expect(NP.normalizeActivityGates()).toEqual({ confirmed: 1, finalized: 12 });
    expect(NP.normalizeActivityGates({ confirmed: 0, finalized: 0 })).toEqual({ confirmed: 1, finalized: 12 });
    expect(NP.normalizeActivityGates({ confirmed: 3, finalized: 2 })).toEqual({ confirmed: 3, finalized: 12 });
  });

  it('链上索引行: 头部最新块不够确认 → observed (不冒充)', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      entry({ blockNumber: 20, logIndex: 0, confirmations: 99 }),   // 索引自报 99, 但 head=20 → 1 确认
      entry({ blockNumber: 9, logIndex: 1, confirmations: 0 }),     // head - block + 1 = 12 → finalized
    ], { headBlock: 20, chainId: 1, gates: { confirmed: 1, finalized: 12 } });
    expect(rows.map((r) => [r.block, r.confirmations, r.finality]))
      .toEqual([[20, 1, 'confirmed'], [9, 12, 'finalized']]);
  });

  it('被回退 (suspect) 的记录不成行 —— 不在规范链上就不算活动', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      entry({ suspect: true }),
      entry({ blockNumber: 101, logIndex: 1, suspect: false }),
    ], { headBlock: 200, chainId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].block).toBe(101);
  });

  it('脉冲降级行一律 observed + 0 确认 (没有链上事实就不说确认)', () => {
    const rows = NP.buildConfirmedActivityFromEvents([
      { type: 'trade_settled', bucket: '1', occurredAt: NOW, sourceProof: 'n', taskProof: 'a'.repeat(16) },
    ] as any);
    expect(rows[0]).toMatchObject({ finality: 'observed', confirmations: 0, chain_id: 0, block: 0 });
  });
});

describe('confirmed_activity · 来源优先级与降级标注', () => {
  it('链上索引可用 → source=chain-index (真链上事实)', async () => {
    const file = {
      chainId: 31337, headBlock: 676, confirmations: { confirmed: 1, finalized: 12 },
      entries: [
        { key: `${TX_A}:0`, blockNumber: 120, blockHash: '0x' + 'aa'.repeat(32), txHash: TX_A, logIndex: 0, eventName: 'EscrowCreatedV2', taskKey: TASK_A, args: {}, confirmations: 557, finality: 'finalized', suspect: false, firstSeenAt: NOW, updatedAt: NOW, history: [] },
        { key: `${TX_B}:1`, blockNumber: 130, blockHash: '0x' + 'bb'.repeat(32), txHash: TX_B, logIndex: 1, eventName: 'ReleasedV2', taskKey: TASK_A, args: {}, confirmations: 547, finality: 'finalized', suspect: false, firstSeenAt: NOW + 1000, updatedAt: NOW + 1000, history: [] },
      ],
    };
    const res = await NP.resolveConfirmedActivity({ events: [], now: NOW, readIndex: () => file });
    expect(res.source).toBe('chain-index');
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.state)).toEqual(['released', 'active']);   // 130 块那条在前 (最新在前)
    expect(res.gates).toEqual({ confirmed: 1, finalized: 12 });
  });

  it('索引读不出 / 空 / 无可用行 → 降级到脉冲事件并标明 source', async () => {
    const evs = [{ type: 'task_posted', bucket: '1', occurredAt: NOW, sourceProof: 'n1', taskProof: 'a'.repeat(16) }] as any;

    const boom = await NP.resolveConfirmedActivity({ events: evs, now: NOW, readIndex: () => { throw new Error('索引文件坏了'); } });
    expect(boom.source).toBe('pulse-events');
    expect(boom.rows).toHaveLength(1);

    const empty = await NP.resolveConfirmedActivity({ events: evs, now: NOW, readIndex: () => ({ entries: [] }) });
    expect(empty.source).toBe('pulse-events');

    const allSuspect = await NP.resolveConfirmedActivity({
      events: evs, now: NOW,
      readIndex: () => ({ chainId: 1, headBlock: 10, entries: [entry({ suspect: true })] }),
    });
    expect(allSuspect.source).toBe('pulse-events');     // 索引里没有可用行 → 也降级 (不编行)

    const none = await NP.resolveConfirmedActivity({ events: [], now: NOW, readIndex: () => null });
    expect(none).toMatchObject({ source: 'none', rows: [] });
  });

  it('窗口外的脉冲事件不成行 (降级路径也守 24h 边界)', async () => {
    const stale = [{ type: 'task_posted', bucket: '0', occurredAt: NOW - NP.PULSE_LIMITS.windowMs - 1000, sourceProof: 'n', taskProof: 'a'.repeat(16) }] as any;
    const res = await NP.resolveConfirmedActivity({ events: stale, now: NOW, readIndex: () => null });
    expect(res).toMatchObject({ source: 'none', rows: [] });
  });
});

describe('confirmed_activity · 端到端 (getNetworkPulse)', () => {
  const writeIndex = (home: string, entries: any[], extra: Record<string, unknown> = {}) => {
    const dir = path.join(home, '.bolloon', 'chain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      schemaVersion: 2, chainId: 31337, networkName: 'localhost', escrowAddress: '0x' + '11'.repeat(20),
      deploymentBlock: 111, deploymentSource: 'fixture', lastSyncedBlock: 676, lastSyncedAt: NOW,
      headBlock: 676, headBlockHash: '0x' + '22'.repeat(32),
      confirmations: { confirmed: 1, finalized: 12 }, pageSize: 2000, reorgDepth: 32,
      entries, recentBlocks: [], runs: [], updatedAt: NOW, ...extra,
    }), 'utf8');
  };
  const idxEntry = (over: Record<string, unknown> = {}) => ({
    key: `${TX_A}:0`, blockNumber: 120, blockHash: '0x' + '33'.repeat(32), txHash: TX_A, txIndex: 0, logIndex: 0,
    address: '0x' + '11'.repeat(20), eventName: 'EscrowCreatedV2', taskKey: TASK_A, args: {}, confirmations: 557,
    finality: 'finalized', suspect: false, firstSeenAt: NOW, updatedAt: NOW, history: [], ...over,
  });

  it('本机没有链上索引 → 快照仍带冻结字段, source=none', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(Array.isArray(snap.confirmed_activity)).toBe(true);
    expect(snap.confirmed_activity).toEqual([]);
    expect(snap.confirmed_activity_source).toBe('none');
    expect(Object.keys(snap)).toContain('confirmed_activity');
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
  });

  it('有真索引文件 → 快照列出真链上活动行 (source=chain-index, 最新在前, ≤25)', async () => {
    writeIndex(HOME, [
      idxEntry({ blockNumber: 120, logIndex: 0 }),
      idxEntry({ blockNumber: 140, logIndex: 1, key: `${TX_B}:1`, txHash: TX_B, eventName: 'ReleasedV2' }),
    ]);
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(snap.confirmed_activity_source).toBe('chain-index');
    expect(snap.confirmed_activity).toHaveLength(2);
    expect(snap.confirmed_activity[0]).toMatchObject({ block: 140, state: 'released', chain_id: 31337 });
    expect(snap.confirmed_activity[1]).toMatchObject({ block: 120, state: 'active' });
    expect(snap.confirmed_activity[0].confirmations).toBe(676 - 140 + 1);
    expect(snap.confirmed_activity[0].finality).toBe('finalized');
    expect(snap.notes.join(' ')).toContain('chain-index');
    expect(np_jsonSafe(snap)).toBe(true);
  });

  it('索引文件坏掉 → 降级到脉冲事件 (source=pulse-events) 且快照里标出来源', async () => {
    fs.mkdirSync(path.join(HOME, '.bolloon', 'chain'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.bolloon', 'chain', 'index.json'), '{ broken', 'utf8');
    await NP.recordNetworkEvent({ type: 'task_posted', taskId: 'task-x', did: 'did:key:zA' }, HOME);
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(snap.confirmed_activity_source).toBe('pulse-events');
    expect(snap.confirmed_activity).toHaveLength(1);
    expect(snap.confirmed_activity[0]).toMatchObject({ kind: 'task_created', state: 'unknown', chain_id: 0, confirmations: 0, finality: 'observed' });
    expect(JSON.stringify(snap)).not.toContain('task-x');
    expect(snap.notes.join(' ')).toContain('pulse-events');
  });

  it('观察层不可用 → 冻结字段仍在 (空数组 + source=none), 不崩', async () => {
    const down = await NP.getNetworkPulse({ home: HOME, unavailable: true });
    expect(down.status).toBe('unavailable');
    expect(down.confirmed_activity).toEqual([]);
    expect(down.confirmed_activity_source).toBe('none');
  });

  it('老版本写下的缓存缺冻结字段 → 视为过期形状, 重算 (不把缺字段的快照发出去)', async () => {
    const dir = path.join(HOME, '.bolloon', 'network-pulse');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = { status: 'live', generated_at: Date.now(), fresh_until: Date.now() + 60_000, scope: 'observed', totals: { nodes: 9 }, capabilities: [], recent_activity: [], notes: [] };
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(legacy), 'utf8');
    const snap = await NP.getNetworkPulse({ home: HOME });        // 不带 force: 老缓存本来会被直接命中
    expect(snap.totals.nodes).toBe(0);                            // 确实重算了 (老缓存里是 9)
    expect(snap.confirmed_activity).toEqual([]);
    expect(snap.confirmed_activity_source).toBe('none');
  });

  it('兼容: totals / recent_activity / agent_sites 字段一个没少 (老客户端不受影响)', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    for (const k of ['status', 'generated_at', 'fresh_until', 'scope', 'scope_label', 'totals', 'capabilities', 'recent_activity']) {
      expect(Object.keys(snap)).toContain(k);
    }
    expect(snap.totals).toEqual({ nodes: 0, agents: 0, active_agents: 0, seen_last_24h: 0, tasks: 0, tasks_completed: 0, tasks_verified: 0, tasks_settled: 0, signatures: null });
    // 每个数都带逐字段口径 (页面就地在数字旁标出; signatures 无源 → 未接入, 不是 0)
    expect(Object.keys(snap.totals_scope.fields).sort()).toEqual([...NP.TOTALS_FIELD_KEYS].sort());
    expect(snap.totals_scope.fields.signatures.short.zh).toBe('未接入');
  });
});

/**
 * 快照 JSON 里不许出现私有字段 / EOA 地址 / 越界的 0x 长 hex (非匿名信息兜底)。
 * 2026-09-23 决定变更后: tx_hash / contract / explorer_* **四个白名单键下**的 0x 是合法的公开链上事实,
 * 其余位置出现 0x 长 hex (含买方/卖方 EOA) 仍算泄露 —— 由 `auditPublicHexLeaks` 逐键判定。
 */
function np_jsonSafe(snap: NP.NetworkPulseSnapshot): boolean {
  const json = JSON.stringify(snap);
  return NP.auditPublicHexLeaks(snap).length === 0
    && !/did:key|peerId|multiaddrs|privateKey/.test(json)
    && !json.includes(SELLER_EOA) && !json.includes(BUYER_EOA)
    && NP.assertNoPrivateFields(snap).length === 0;
}
