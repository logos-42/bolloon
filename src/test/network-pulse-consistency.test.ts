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
 *   ② ★ **同一概念不许并排两个数** (2026-09-24): 顶部 tasks/tasks_completed/tasks_settled 就是
 *      activity_totals 的同源值; 逐字段口径 `totals_scope.fields` 九个键齐; 差一个数 / 无源却给 0 /
 *      口径缺失 / 反向矛盾 (报了数却一行都没有) 全部判红 —— 都由 `totalsScopeIssues` 钉住
 *   ③ chain_id 归属: 本机 31337 → 非公网 + 公网行数 0; 全公网 84532 → is_public_network=true
 *   ④ 认不出的 chain id 不编名字、也不算公网
 *   ⑤ 兼容: totals 老 8 个字段顺序逐字不变 (tasks_settled 只追加在最后)
 *   ⑥ 老缓存缺新字段 → 视为过期形状重算 (不把缺字段的快照发出去)
 *   ⑦ **真跑导出脚本** (npx tsx scripts/export-network-pulse.ts): 导出的 JSON 里两个数字仍不打架
 *   ⑧ ★ 钱包签名接**真源** (`wallet-signatures.jsonl` 窗口内条数) + 无源写「未接入」不写裸 0
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

    // ③ ★ 2026-09-24: 顶部任务类计数**就是**链上索引的同源值 (当年这里是与 25 行并排打架的 0)
    expect(snap.totals.tasks).toBe(at.tasks);
    expect(snap.totals.tasks_completed).toBe(at.tasks_completed);
    expect(snap.totals.tasks_settled).toBe(at.tasks_settled);
    expect(snap.totals.tasks_verified).toBeNull();                 // 链上没有「验真」事件 → 未接入, 不冒充 0
    expect(snap.totals.tasks).toBeGreaterThan(0);
    expect(at.tasks).toBeGreaterThan(0);
    expect(snap.totals_scope.source).toBe('mixed');
    expect(snap.totals_scope.window_ms).toBe(NP.PULSE_LIMITS.windowMs);
    expect(snap.totals_scope.differs_from_activity).toBe(false);   // 同源即恒等 → 没有两套数要去解释
    // 逐字段口径: 每个数都能就地说明来自哪 (页面就靠它, 不再只靠 notes)
    expect(snap.totals_scope.fields.tasks.source).toBe('chain-index');
    expect(snap.totals_scope.fields.tasks_completed.source).toBe('chain-index');
    expect(snap.totals_scope.fields.tasks_settled.source).toBe('chain-index');
    expect(snap.totals_scope.fields.nodes.source).toBe('pulse-events');
    expect(snap.totals_scope.fields.tasks_verified.source).toBe('none');
    expect(snap.totals_scope.fields.tasks_verified.label.zh).toContain('未接入');
    expect(snap.totals_scope.fields.signatures.source).toBe('none');   // 这个临时 home 没有签名审计账
    expect(snap.totals_scope.fields.signatures.short.zh).toContain('未接入');
    const notes = snap.notes.join(' ');
    expect(notes).toContain('脉冲事件');
    expect(notes).toContain('链上索引');
    expect(notes).toContain('24h');                    // 口径名写清楚
    expect(notes).toContain(String(rows.length));      // 行数写清楚
    expect(notes).toContain('activity_totals');        // 指到同源计数

    // ④ 自检通过 (导出脚本用的就是它)
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    // ⑤ 匿名兜底没被破坏 —— 2026-09-23 决定变更: 白名单键 (tx_hash/contract/explorer_*) 下的
    //    真交易哈希与 escrow 合约地址是**允许**的公开链上事实; 越界的 0x 长 hex 仍一律算泄露
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
    expect(NP.auditPublicHexLeaks(snap)).toEqual([]);
    expect(snap.confirmed_activity.every((r: any) => /^0x[0-9a-f]{64}$/.test(r.tx_hash || ''))).toBe(true);   // 真 txHash 真在
    expect(JSON.stringify(snap)).not.toMatch(/0x[0-9a-fA-F]{64}[^"]/);   // 长 hex 只许作为整值出现, 不许被拼进别的字符串
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
    // 「0 个任务」与「N 行任务」并存却不解释 (老规矩 ⑤ 仍在)
    const bad4: any = { ...snap, totals: { ...snap.totals, tasks: 0 }, notes: ['随便一句话'] };
    expect(NP.snapshotConsistencyIssues(bad4).join(' ')).toContain('口径说明');
    // 同源计数整块缺失
    const bad5: any = { ...snap }; delete bad5.activity_totals;
    expect(NP.snapshotConsistencyIssues(bad5).join(' ')).toContain('activity_totals 缺失');
    // ★ 2026-09-24 新门: 同一概念并排两个数 (顶部与下表同源, 差一个数就是矛盾 —— 任何解释都救不了)
    const bad6: any = { ...snap, totals: { ...snap.totals, tasks: 0 } };
    expect(NP.snapshotConsistencyIssues(bad6).join(' ')).toContain('同一概念两个数');
    const bad7: any = { ...snap, totals: { ...snap.totals, tasks_completed: Number(snap.totals.tasks_completed) + 1 } };
    expect(NP.snapshotConsistencyIssues(bad7).join(' ')).toContain('同一概念两个数');
    // ★ 无源却拿裸 0 冒充「没发生过」→ 判红 (本机明明有签名审计账 / 就是没有源也不许报 0)
    const bad8: any = { ...snap, totals: { ...snap.totals, signatures: 0 } };
    expect(NP.snapshotConsistencyIssues(bad8).join(' ')).toContain('裸 0');
    // ★ 逐字段口径整块缺失 → 判红 (页面就只能靠 notes 辩解了)
    const bad9: any = { ...snap, totals_scope: { ...snap.totals_scope, fields: undefined } };
    expect(NP.snapshotConsistencyIssues(bad9).join(' ')).toContain('totals_scope.fields 缺失');
    // ★ 单个字段口径缺失 → 判红
    const bad10: any = { ...snap, totals_scope: { ...snap.totals_scope, fields: { ...snap.totals_scope.fields, tasks_settled: undefined } } };
    expect(NP.snapshotConsistencyIssues(bad10).join(' ')).toContain('totals_scope.fields.tasks_settled 缺失');
    // ★ 有源却不给数 (null) → 判红
    const bad11: any = { ...snap, totals: { ...snap.totals, tasks: null } };
    expect(NP.snapshotConsistencyIssues(bad11).join(' ')).toContain('却标了源 chain-index');
    // ★ 反向矛盾: 顶部报了数而表格一行都没有 → 判红 (把字段口径拨回降级档, 单独验这条规则)
    const bad12: any = {
      ...snap, confirmed_activity: [],
      activity_totals: { ...snap.activity_totals, rows: 0, tasks: 0, tasks_completed: 0, tasks_settled: 0, by_finality: { observed: 0, confirmed: 0, finalized: 0 } },
      totals_scope: {
        ...snap.totals_scope,
        fields: { ...snap.totals_scope.fields, tasks: { ...snap.totals_scope.fields.tasks, source: 'pulse-events' } },
      },
      totals: { ...snap.totals, tasks: 5, tasks_completed: 0, tasks_settled: 0 },
      notes: [],
    };
    expect(NP.snapshotConsistencyIssues(bad12).join(' ')).toContain('反向矛盾');
    // ★ 声明与能力不符 (规则 ⑨): 字段自称链上索引口径, 而这一份快照的索引根本没读出来 → 判红
    const bad13: any = {
      ...snap, confirmed_activity: [],
      activity_totals: { ...snap.activity_totals, source: 'none', rows: 0, tasks: 0, tasks_completed: 0, tasks_settled: 0,
        by_finality: { observed: 0, confirmed: 0, finalized: 0 } },
      confirmed_activity_source: 'none',
      totals: { ...snap.totals, tasks: 0, tasks_completed: 0, tasks_settled: 0 },
      notes: [],
    };
    const b13 = NP.snapshotConsistencyIssues(bad13).join(' ');
    expect(b13).toContain('声明与能力不符');
    expect(b13).toContain('chain-index');
    // ★ 同一份快照里把口径也改成降级档 (pulse-events) → 声明与能力相符 → 这条规则不再报 (不是见 chain 就红)
    const bad14: any = {
      ...bad13,
      totals_scope: {
        ...bad13.totals_scope,
        fields: Object.fromEntries(Object.entries(bad13.totals_scope.fields)
          .map(([k, f]: [string, any]) => [k, f.source === 'chain-index' ? { ...f, source: 'pulse-events', window: 'window-24h', short: { zh: '24h 脉冲', en: '24h pulse' } } : f])),
      },
    };
    expect(NP.snapshotConsistencyIssues(bad14).join(' ')).not.toContain('声明与能力不符');
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
    expect(fb.totals.tasks).toBe(1);                                  // 降级口径下也数到了同一个任务
    expect(fb.totals_scope.fields.tasks.source).toBe('pulse-events');  // 降级就如实标降级 (不冒充链上索引)
    expect(fb.totals_scope.fields.tasks_completed.source).toBe('pulse-events');
    expect(fb.totals_scope.source).toBe('pulse-events');
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

  it('兼容锁: totals 老 8 个字段顺序逐字在前 (只新增, 一个字段都没少) + 每个数都带口径', async () => {
    writeIndex(HOME, index30());
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    const keys = Object.keys(snap.totals);
    // 老 8 个字段仍按原顺序在最前 (老客户端读法不变), 只在其后新增 tasks_settled
    expect(keys.slice(0, 8)).toEqual([
      'nodes', 'agents', 'active_agents', 'seen_last_24h', 'tasks', 'tasks_completed', 'tasks_verified', 'signatures',
    ]);
    expect(keys).toEqual([
      'nodes', 'agents', 'active_agents', 'seen_last_24h', 'tasks', 'tasks_completed', 'tasks_verified', 'signatures', 'tasks_settled',
    ]);
    for (const k of ['status', 'generated_at', 'fresh_until', 'scope', 'scope_label', 'totals', 'capabilities', 'recent_activity']) {
      expect(Object.keys(snap)).toContain(k);
    }
    // 新口径统一走 totals_scope / activity_totals / chain_id_scope 三块, 不往 totals 里塞别的东西
    expect(Object.keys(snap)).toEqual(expect.arrayContaining(['totals_scope', 'activity_totals', 'chain_id_scope']));
    // 逐字段口径九个键齐 (topls 的每个数都能就地说明来自哪)
    expect(Object.keys(snap.totals_scope.fields).sort()).toEqual([...NP.TOTALS_FIELD_KEYS].sort());
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

/**
 * 钱包签名 (2026-09-24 leo:「钱包那个数也对不上」) —— 接**真源**:
 *   · 真源 = 本机签名审计账 `<home>/.bolloon/wallet-signatures.jsonl` 窗口内条数 (只计数);
 *   · 没有审计账 → 退回脉冲事件上报数 (并如实标 pulse-events);
 *   · 两个都没有 → **null + 未接入** (绝不拿裸 0 冒充「没发生过」: 本机明明签过而脉冲事件丢了
 *     那次真事故就是这么来的)。
 */
describe('钱包签名接真源 + 「未接入」语义 (2026-09-24)', () => {
  it('审计账有 3 条 (2 条在窗口内) → 顶部签名数 = 2 (真值), 口径标 signature-audit', async () => {
    const TC = await import('../agents/task-contract.js');
    for (let i = 0; i < 2; i++) {
      await TC.recordSignatureAudit({
        kind: 'task_payment', mode: 'local-dev', requestId: `req-${i}`, taskId: 'task-audit',
        amountAtomic: '1000', currency: 'USDC', network: 'base', capability: 'chain.escrow',
        signerFingerprint: 'sha256:0123456789ab',
      }, HOME);
    }
    // 窗口外的一条 (48h 前) —— 不该被数进 24h 窗口
    const auditFile = path.join(HOME, '.bolloon', 'wallet-signatures.jsonl');
    fs.appendFileSync(auditFile, JSON.stringify({ at: Date.now() - 48 * 3600_000, kind: 'task_result', requestId: 'old' }) + '\n');
    // 再加一行坏数据 → 不该炸、也不该计数
    fs.appendFileSync(auditFile, '{ not json\n');

    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(snap.totals.signatures).toBe(2);
    expect(snap.totals_scope.fields.signatures.source).toBe('signature-audit');
    expect(snap.totals_scope.fields.signatures.window).toBe('window-24h');
    expect(snap.totals_scope.fields.signatures.short.zh).toContain('签名审计');
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    // 只数条数: 审计条目的内容 (requestId / 金额 / 指纹) 一个字都不许进快照,
    // 也不许出现绝对路径 (文件**名字**会出现在口径说明里 —— 那是公开的说法, 路径不是)
    const json = JSON.stringify(snap);
    expect(json).not.toContain('task-audit');
    expect(json).not.toContain('0123456789ab');
    expect(json).not.toContain(HOME);
    expect(json).not.toContain('/.bolloon/');
  });

  it('没有审计账、也没有脉冲 → 签名数 = null + 口径写「未接入」(绝不拿 0 冒充)', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(snap.totals.signatures).toBeNull();
    expect(snap.totals_scope.fields.signatures.source).toBe('none');
    expect(snap.totals_scope.fields.signatures.unavailable).toBe(true);
    expect(`${snap.totals_scope.fields.signatures.short.zh}${snap.totals_scope.fields.signatures.label.zh}`).toContain('未接入');
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    // 变异: 把它改成裸 0 (没有源却报 0) → 新门必须判红
    const bad: any = { ...snap, totals: { ...snap.totals, signatures: 0 } };
    expect(NP.totalsScopeIssues(bad).join(' ')).toContain('裸 0');
  });

  it('没有审计账但有脉冲上报过签名 → 降级口径 (pulse-events), 不写「未接入」也不写假值', async () => {
    await NP.recordNetworkEvent({ type: 'wallet_signed', did: 'did:key:zB', taskId: 't1', at: Date.now() }, HOME);
    const snap = await NP.getNetworkPulse({ home: HOME, force: true });
    expect(snap.totals.signatures).toBe(1);
    expect(snap.totals_scope.fields.signatures.source).toBe('pulse-events');
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
  });

  it('tallySignatureAudit 是纯读数: 文件不存在 → available=false (不当成 0 条)', () => {
    const t = NP.tallySignatureAudit(HOME, { now: Date.now() });
    expect(t.available).toBe(false);
    expect(t.count).toBe(0);
    expect(t.window_ms).toBe(NP.PULSE_LIMITS.windowMs);
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
    // ★ 顶部任务类计数 = 链上索引同源值 (导出的 JSON 里也不许出现"顶部 0 / 表格 25 行")
    expect(snap.totals.tasks).toBe(at.tasks);
    expect(snap.totals.tasks_completed).toBe(at.tasks_completed);
    expect(snap.totals.tasks_settled).toBe(at.tasks_settled);
    expect(snap.totals_scope.fields.tasks.source).toBe('chain-index');
    expect(snap.totals_scope.differs_from_activity).toBe(false);
    expect(snap.notes.join(' ')).toContain(String(rows.length));
    expect(snap.chain_id_scope.activity_chain_id).toBe(31337);
    expect(snap.chain_id_scope.public_network_rows).toBe(0);
    // 导出脚本自己也会跑一遍自检 (不过就 exit 3) —— 这里再独立跑一次
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    expect(NP.totalsScopeIssues(snap)).toEqual([]);      // ★ 新不变量门单跑一遍必须空
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
    // 导出的 JSON 里: 真 txHash / escrow 合约地址只在白名单键下 (31337 没有公网浏览器 → 无 explorer 键)
    expect(NP.auditPublicHexLeaks(snap)).toEqual([]);
    expect(rows.every((r: any) => /^0x[0-9a-f]{64}$/.test(r.tx_hash || ''))).toBe(true);
    expect(rows.every((r: any) => !('explorer_tx' in r) && !('explorer_contract' in r))).toBe(true);
    expect(snap.confirmed_activity.every((r: any) => r.contract === '0x' + '11'.repeat(20))).toBe(true);
  }, 120_000);
});
