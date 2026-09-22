/**
 * network-pulse-consistency.test.ts — 公开快照**内部不许自相矛盾** (2026-09-22 leo 拍板)
 *
 * 起因 (真事): 真快照里 `totals.tasks / tasks_completed / tasks_verified / signatures` 全是 0,
 * 而同一份快照的 `confirmed_activity` 有 **25 行真实任务** —— 页面上这两个数字**同屏**, 读者只会
 * 读成"自相矛盾 / 在撒谎"。这两块本来就来自**两套口径** (totals = 本节点 24h 脉冲事件窗口;
 * confirmed_activity = 链上索引全量), 所以修法不是把数字改漂亮, 而是:
 *   · `activity_totals` = 与行**同源**的计数 (rows 恒等于 confirmed_activity.length)
 *   · `totals_scope.differs_from_activity` + notes 里的口径说明 (两套数字并存**必须**解释)
 *   · `chain_id_scope` = 这些行属于哪条链 (本机 31337 ≠ 真网 Base Sepolia 84532)
 *   · `snapshotConsistencyIssues` = 导出前自检; 本文件把它锁进单测
 *
 * 覆盖:
 *   ① 真索引 30 条 → 快照 25 行: activity_totals.rows === 行数, tasks == 独立复算值, 自检通过
 *   ② 两套口径数字不同时, notes 里**必须**有口径说明 (「0 个任务」不许与「N 行任务」并存而不解释)
 *   ③ chain_id 归属: 本机 31337 → 非公网 + 公网行数 0; 全公网 84532 → is_public_network=true
 *   ④ 认不出的 chain id 不编名字、也不算公网
 *   ⑤ 兼容: totals 仍是老 8 个字段 (顺序逐字), 老客户端不受影响
 *   ⑥ 老缓存缺新字段 → 视为过期形状重算 (不把缺字段的快照发出去)
 *   ⑦ **真跑导出脚本** (npx tsx scripts/export-network-pulse.ts): 导出的 JSON 里两个数字仍不打架
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as NP from '../agents/network-pulse.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const NOW = Date.UTC(2026, 8, 22, 5, 31, 0);            // 2026-09-22T05:31:00Z
const TASK_A = '0x' + 'ab'.repeat(32);
const TASK_B = '0x' + '12'.repeat(32);
const TASK_C = '0x' + '77'.repeat(32);
const TX_A = '0x' + 'cd'.repeat(32);
const TX_B = '0x' + '9f'.repeat(32);
const TX_C = '0x' + '31'.repeat(32);

const tmpHome = (): string => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-consistency-'));
  fs.mkdirSync(path.join(h, '.bolloon'), { recursive: true });
  return h;
};

let HOME = '';
beforeEach(() => { HOME = tmpHome(); });
afterEach(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

/** 真索引文件 (只读索引的形状): 30 条可用事件 → 快照里应被截成 25 行 */
function writeIndex(home: string, entries: any[], extra: Record<string, unknown> = {}) {
  const dir = path.join(home, '.bolloon', 'chain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    schemaVersion: 2, chainId: 31337, networkName: 'localhost', escrowAddress: '0x' + '11'.repeat(20),
    deploymentBlock: 111, deploymentSource: 'fixture', lastSyncedBlock: 676, lastSyncedAt: NOW,
    headBlock: 676, headBlockHash: '0x' + '22'.repeat(32),
    confirmations: { confirmed: 1, finalized: 12 }, pageSize: 2000, reorgDepth: 32,
    entries, recentBlocks: [], runs: [], updatedAt: NOW, ...extra,
  }), 'utf8');
}
const idxEntry = (over: Record<string, unknown> = {}) => ({
  key: `${TX_A}:0`, blockNumber: 120, blockHash: '0x' + '33'.repeat(32), txHash: TX_A, txIndex: 0, logIndex: 0,
  address: '0x' + '11'.repeat(20), eventName: 'EscrowCreatedV2', taskKey: TASK_A, args: {}, confirmations: 557,
  finality: 'finalized', suspect: false, firstSeenAt: NOW, updatedAt: NOW, history: [], ...over,
});
/** 30 条真事件 (3 个任务 × 生命周期) → 最新在前截 25 行 */
const index30 = () => {
  const tasks = [TASK_A, TASK_B, TASK_C];
  const plans: Array<[string, string]> = [
    ['EscrowCreatedV2', TX_A], ['ProofSubmittedV2', TX_B], ['ReleasedV2', TX_C], ['ExpiredV2', TX_C],
  ];
  const out: any[] = [];
  for (let i = 0; i < 30; i++) {
    const [eventName, txHash] = plans[i % plans.length];
    out.push(idxEntry({
      key: `${txHash}:${i}`, blockNumber: 600 + i, logIndex: i % 4, txHash,
      eventName, taskKey: tasks[i % tasks.length],
    }));
  }
  return out;
};

/** 独立复算 (不复用被测代码): 从索引条目算出「上表该长什么样」 */
function recompute(entries: any[], head: number, limit = 25) {
  const rows = entries
    .filter((e) => !e.suspect && NP.CHAIN_EVENT_ACTIVITY[e.eventName])
    .map((e, i) => {
      const conf = Math.max(0, head - e.blockNumber + 1);
      return {
        i, block: e.blockNumber, logIndex: e.logIndex,
        task: NP.anonShortRef(String(e.taskKey).toLowerCase(), 'task'),
        kind: NP.CHAIN_EVENT_ACTIVITY[e.eventName].kind,
        finality: conf >= 12 ? 'finalized' : (conf >= 1 ? 'confirmed' : 'observed'),
      };
    })
    .sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
    .slice(0, limit);
  return {
    rows,
    tasks: new Set(rows.map((r) => r.task)).size,
    by_finality: {
      observed: rows.filter((r) => r.finality === 'observed').length,
      confirmed: rows.filter((r) => r.finality === 'confirmed').length,
      finalized: rows.filter((r) => r.finality === 'finalized').length,
    },
  };
}

describe('公开快照 · 同源计数与口径说明 (两个数字不许打架)', () => {
  it('真索引 30 条 → 25 行: activity_totals 与行数/独立复算一致, 自检通过', async () => {
    writeIndex(HOME, index30());
    // 同时有脉冲事件: 让 totals.nodes / agents 有值, 但**没有任何经济事件** → totals.tasks 仍是 0
    await NP.recordNetworkEvent({ type: 'node_joined', did: 'did:key:zNode1', at: NOW });
    await NP.recordNetworkEvent({ type: 'capability_announced', did: 'did:key:zNode1', agentId: 'a1', capability: 'code-review', at: NOW, signed: true });

    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    const rows = snap.confirmed_activity;
    const at = snap.activity_totals;
    const exp = recompute(index30(), 676);

    // ① 形状与来源
    expect(snap.confirmed_activity_source).toBe('chain-index');
    expect(rows).toHaveLength(25);
    expect(at.source).toBe('chain-index');

    // ② 同源计数: rows 恒等于行数; 计数 == 独立复算
    expect(at.rows).toBe(rows.length);
    expect(at.rows).toBe(25);
    expect(at.tasks).toBe(exp.tasks);
    expect(at.by_finality).toEqual(exp.by_finality);
    expect(at.by_finality.observed + at.by_finality.confirmed + at.by_finality.finalized).toBe(rows.length);
    expect(at.gates).toEqual({ confirmed: 1, finalized: 12 });
    expect(rows.map((r) => `${r.block}|${r.task}|${r.kind}`)).toEqual(exp.rows.map((r) => `${r.block}|${r.task}|${r.kind}`));

    // ③ 两套口径的数字确实不同 (这就是当年"打架"的那一幕) —— 但必须**有解释**
    expect(snap.totals.tasks).toBe(0);
    expect(snap.totals.tasks_completed).toBe(0);
    expect(at.tasks).toBeGreaterThan(0);
    expect(snap.totals_scope.source).toBe('pulse-events');
    expect(snap.totals_scope.window_ms).toBe(NP.PULSE_LIMITS.windowMs);
    expect(snap.totals_scope.differs_from_activity).toBe(true);
    const notes = snap.notes.join(' ');
    expect(notes).toContain('脉冲事件');
    expect(notes).toContain('链上索引');
    expect(notes).toContain('24h');                    // 口径名写清楚
    expect(notes).toContain(String(rows.length));      // 行数写清楚
    expect(notes).toContain('activity_totals');        // 指到同源计数

    // ④ 自检通过 (导出脚本用的就是它)
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    // ⑤ 匿名兜底没被破坏
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
    expect(JSON.stringify(snap)).not.toMatch(/0x[0-9a-fA-F]{8,}/);
  });

  it('自检能抓到矛盾 (反向验证: 坏快照必须报出来, 不是永远返回空)', async () => {
    writeIndex(HOME, index30());
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);

    // rows 与行数对不上
    const bad1: any = { ...snap, activity_totals: { ...snap.activity_totals, rows: 3 } };
    expect(NP.snapshotConsistencyIssues(bad1).join(' ')).toContain('activity_totals.rows');
    // 三档之和 ≠ 行数
    const bad2: any = { ...snap, activity_totals: { ...snap.activity_totals, by_finality: { observed: 0, confirmed: 0, finalized: 1 } } };
    expect(NP.snapshotConsistencyIssues(bad2).join(' ')).toContain('by_finality');
    // 来源标注两块不一致
    const bad3: any = { ...snap, activity_totals: { ...snap.activity_totals, source: 'none' } };
    expect(NP.snapshotConsistencyIssues(bad3).join(' ')).toContain('source');
    // 「0 个任务」与「N 行任务」并存却不解释
    const bad4: any = { ...snap, notes: ['随便一句话'] };
    expect(NP.snapshotConsistencyIssues(bad4).join(' ')).toContain('口径说明');
    // 同源计数整块缺失
    const bad5: any = { ...snap }; delete bad5.activity_totals;
    expect(NP.snapshotConsistencyIssues(bad5).join(' ')).toContain('activity_totals 缺失');
  });

  it('链上索引不可用 → 同源计数跟着降级 (rows=0, source=none/pulse-events), 不编数字', async () => {
    const none = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(none.confirmed_activity_source).toBe('none');
    expect(none.confirmed_activity).toEqual([]);
    expect(none.activity_totals).toMatchObject({ source: 'none', rows: 0, tasks: 0, tasks_completed: 0, tasks_settled: 0 });
    expect(none.activity_totals.by_finality).toEqual({ observed: 0, confirmed: 0, finalized: 0 });
    expect(none.totals_scope.differs_from_activity).toBe(false);      // 没有行 → 不需要口径说明
    expect(none.chain_id_scope.chain_ids).toEqual([]);
    expect(none.chain_id_scope.activity_chain_id).toBe(0);
    expect(none.chain_id_scope.is_public_network).toBe(false);
    expect(NP.snapshotConsistencyIssues(none)).toEqual([]);

    // 有脉冲经济事件 → 降级成 pulse-events 行, 计数与行同源
    await NP.recordNetworkEvent({ type: 'task_posted', taskId: 'task-x', did: 'did:key:zA' }, HOME);
    const fb = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(fb.confirmed_activity_source).toBe('pulse-events');
    expect(fb.activity_totals.source).toBe('pulse-events');
    expect(fb.activity_totals.rows).toBe(fb.confirmed_activity.length);
    expect(fb.totals.tasks).toBe(1);                                  // 脉冲口径也数到了同一个任务
    expect(NP.snapshotConsistencyIssues(fb)).toEqual([]);
    expect(JSON.stringify(fb)).not.toContain('task-x');               // 任务正文/ID 不出网
  });

  it('观察层不可用 → 三块新字段仍在 (全 0 / none), 不崩', async () => {
    const down = await NP.getNetworkPulse({ home: HOME, unavailable: true });
    expect(down.status).toBe('unavailable');
    expect(down.activity_totals).toMatchObject({ source: 'none', rows: 0, tasks: 0 });
    expect(down.chain_id_scope.chain_ids).toEqual([]);
    expect(down.totals_scope.differs_from_activity).toBe(false);
    expect(NP.snapshotConsistencyIssues(down)).toEqual([]);
  });

  it('兼容锁: totals 仍是老 8 个字段 (顺序逐字) —— 老客户端一个字段都没少', async () => {
    writeIndex(HOME, index30());
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(Object.keys(snap.totals)).toEqual([
      'nodes', 'agents', 'active_agents', 'seen_last_24h', 'tasks', 'tasks_completed', 'tasks_verified', 'signatures',
    ]);
    for (const k of ['status', 'generated_at', 'fresh_until', 'scope', 'scope_label', 'totals', 'capabilities', 'recent_activity']) {
      expect(Object.keys(snap)).toContain(k);
    }
    // 新口径统一走 totals_scope / activity_totals / chain_id_scope 三块, 不往 totals 里塞
    expect(Object.keys(snap)).toEqual(expect.arrayContaining(['totals_scope', 'activity_totals', 'chain_id_scope']));
  });

  it('老缓存缺 totals_scope/activity_totals/chain_id_scope → 视为过期形状, 重算', async () => {
    writeIndex(HOME, index30());
    const dir = path.join(HOME, '.bolloon', 'network-pulse');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      status: 'live', generated_at: Date.now(), fresh_until: Date.now() + 60_000, scope: 'observed',
      totals: { nodes: 9 }, capabilities: [], recent_activity: [], confirmed_activity: [], confirmed_activity_source: 'none', notes: [],
    };
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(legacy), 'utf8');
    const snap = await NP.getNetworkPulse({ home: HOME });           // 不带 force: 老缓存本来会被命中
    expect(snap.totals.nodes).toBe(0);                                // 确实重算了 (老缓存里是 9)
    expect(snap.activity_totals.rows).toBe(25);
    expect(snap.confirmed_activity_source).toBe('chain-index');
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
  });
});

describe('chain_id 归属 (不许把本机开发链的行读成公网活动)', () => {
  it('本机 31337 → is_public_network=false, 公网行数 0, note 写明归属', () => {
    const rows = NP.buildConfirmedActivityFromIndex([idxEntry()], { chainId: 31337, headBlock: 200 });
    const scope = NP.buildChainIdScope(rows);
    expect(scope.chain_ids).toEqual([31337]);
    expect(scope.activity_chain_id).toBe(31337);
    expect(scope.activity_chain_label?.zh).toContain('本机隔离开发链');
    expect(scope.is_public_network).toBe(false);
    expect(scope.public_network_rows).toBe(0);
    expect(scope.public_network.chain_id).toBe(84532);
    expect(scope.note.zh).toContain('1 行');
    expect(scope.note.zh).toContain('31337');
    expect(scope.note.zh).toContain('84532');
    expect(scope.note.zh).toContain('这不是公网活动');
    expect(scope.note.en).toContain('not public-network activity');
  });

  it('公网 84532 → is_public_network=true, 公网行数如实计 (不吞)', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      idxEntry(), idxEntry({ blockNumber: 121, logIndex: 1, txHash: TX_B }),
    ], { chainId: 84532, headBlock: 200 });
    const scope = NP.buildChainIdScope(rows);
    expect(scope.is_public_network).toBe(true);
    expect(scope.public_network_rows).toBe(2);
    expect(scope.note.zh).not.toContain('这不是公网活动');
  });

  it('混合链 → 主链取行数最多 (并列取小); 识别不了的 chain id 不编名字也不算公网', () => {
    const mixed = [
      { task: 'sha256:aaaaaaaa', kind: 'task_created', state: 'active', chain_id: 31337, block: 10, tx: 'sha256:1', confirmations: 1, finality: 'confirmed', at: '2026-09-22T05:31:00Z' },
      { task: 'sha256:bbbbbbbb', kind: 'task_created', state: 'active', chain_id: 84532, block: 11, tx: 'sha256:2', confirmations: 1, finality: 'confirmed', at: '2026-09-22T05:31:00Z' },
    ] as NP.ConfirmedActivityRow[];
    const s = NP.buildChainIdScope(mixed);
    expect(s.chain_ids).toEqual([31337, 84532]);
    expect(s.activity_chain_id).toBe(31337);          // 并列 1:1 → 取小
    expect(s.public_network_rows).toBe(1);

    const unknown = NP.buildChainIdScope([{ ...mixed[0], chain_id: 424242 }]);
    expect(unknown.activity_chain_label).toBeNull();   // 不编网络名
    expect(unknown.is_public_network).toBe(false);     // 认不出 ≠ 公网
    expect(unknown.public_network_rows).toBe(0);

    expect(NP.chainLabelOf(84532)?.publicNetwork).toBe(true);
    expect(NP.isPublicChainId(999999)).toBe(false);
  });

  it('没有行 → 空归属 (0 / [] / note 不谎称"链上没事件")', () => {
    const s = NP.buildChainIdScope([]);
    expect(s.chain_ids).toEqual([]);
    expect(s.activity_chain_id).toBe(0);
    expect(s.activity_chain_label).toBeNull();
    expect(s.public_network_rows).toBe(0);
    expect(s.note.zh).toContain('没有链上活动行');
  });

  it('同源计数纯函数: 同一任务的多个动作算一个任务', () => {
    const rows = NP.buildConfirmedActivityFromIndex([
      idxEntry({ eventName: 'EscrowCreatedV2', blockNumber: 120 }),
      idxEntry({ eventName: 'ProofSubmittedV2', blockNumber: 121, logIndex: 1, txHash: TX_B }),
      idxEntry({ eventName: 'ReleasedV2', blockNumber: 122, logIndex: 2, txHash: TX_C }),
    ], { chainId: 31337, headBlock: 200 });
    const at = NP.summarizeActivityRows(rows, { source: 'chain-index', gates: { confirmed: 1, finalized: 12 } });
    expect(at.rows).toBe(3);
    expect(at.tasks).toBe(1);              // 同一个 taskKey → 一个任务
    expect(at.tasks_completed).toBe(1);
    expect(at.tasks_settled).toBe(1);
    expect(at.by_finality).toEqual({ observed: 0, confirmed: 0, finalized: 3 });
  });
});

describe('真跑导出脚本: 导出的 JSON 里两个数字仍不打架', () => {
  it('npx tsx scripts/export-network-pulse.ts (真索引 30 条) → 25 行 + 同源计数 + 口径说明', () => {
    writeIndex(HOME, index30());
    const out = path.join(HOME, 'exported.json');
    const r = spawnSync('npx', ['tsx', 'scripts/export-network-pulse.ts', '--home', HOME, '--out', out, '--no-sign'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(r.stderr).toContain('consistency=OK');

    const snap: any = JSON.parse(fs.readFileSync(out, 'utf8'));
    const rows = snap.confirmed_activity;
    const at = snap.activity_totals;
    expect(rows).toHaveLength(25);
    expect(snap.confirmed_activity_source).toBe('chain-index');
    expect(at.rows).toBe(rows.length);
    expect(at.tasks).toBe(recompute(index30(), 676).tasks);
    expect(at.by_finality.observed + at.by_finality.confirmed + at.by_finality.finalized).toBe(rows.length);
    expect(snap.totals.tasks).toBe(0);
    expect(snap.totals_scope.differs_from_activity).toBe(true);
    expect(snap.notes.join(' ')).toContain(String(rows.length));
    expect(snap.chain_id_scope.activity_chain_id).toBe(31337);
    expect(snap.chain_id_scope.public_network_rows).toBe(0);
    // 导出脚本自己也会跑一遍自检 (不过就 exit 3) —— 这里再独立跑一次
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
    expect(JSON.stringify(snap)).not.toMatch(/0x[0-9a-fA-F]{8,}/);
  }, 120_000);
});
