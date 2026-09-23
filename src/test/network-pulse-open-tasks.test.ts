/**
 * network-pulse-open-tasks.test.ts — 公开快照的 `open_tasks[]` (2026-09-23)
 *
 * 这一块要证明的是**隐私 + 诚实筛选**两件事, 不是格式:
 *   ① 只导出**未认领且未过期**的公告 (已认领/已取消/已过期 → 一条都不上);
 *   ② 每行只有白名单 7 个字段 —— 任务正文 / 正文摘要 / 正文预览 / 买方 DID / 买方公钥 /
 *      认领者 / 公告签名 / 认领价格 **一个都不许出现** (即使探针/夹具把这些字段塞进公告文件);
 *   ③ `announcementId` 只出**前 8 位** (原 id 不上公开投影);
 *   ④ 同目录的 `remote-claims.json` (认领台账, 是个数组) 不会被当公告解析;
 *   ⑤ 反向: 把筛选/白名单敲坏时自检必须报出来 (否则这些断言只是自说自话)。
 *
 * 一律用隔离 HOME + 手写公告文件 (不碰真注册表/网络/链上)。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-pulse-open-tasks-'));
const HOME = path.join(ROOT, 'home');
const BOARD = path.join(HOME, '.bolloon', 'tasks', 'board');
fs.mkdirSync(BOARD, { recursive: true });

const NP: any = await import('../agents/network-pulse.js');

const NOW = Date.now();
const HOUR = 3600 * 1000;

/** 一条形状合法的公告 (含**全部**不该外泄的字段 —— 用来证明白名单真的在筛) */
function announcement(over: Record<string, any> = {}): any {
  const id = over.announcementId || 'ann-0123456789abcdef';
  return {
    protocol: 'bolloon-task/1',
    kind: 'task_announcement',
    announcementId: id,
    capability: 'code-review',
    instruction: 'SECRET-BODY: 内部正文, 绝不上公开页',
    instructionDigest: 'f'.repeat(64),
    instructionPreview: 'SECRET-PREVIEW: 内部预览',
    buyerDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    buyerPublicKeyHex: 'a'.repeat(64),
    budget: { maxAmount: '1000', currency: 'USDC', network: 'base-sepolia' },
    deadline: NOW + 6 * HOUR,
    paymentMode: 'policy',
    createdAt: NOW - HOUR,
    status: 'open',
    updatedAt: NOW - HOUR,
    claims: [],
    replyTo: null,
    signature: 'c'.repeat(88),
    ...over,
  };
}

function write(name: string, value: any) {
  fs.writeFileSync(path.join(BOARD, `${name}.json`), JSON.stringify(value, null, 2), 'utf8');
}

beforeAll(() => {
  // 一份真公告 (待接单) + 一份已认领 + 一份已取消 + 一份已过期 + 一份认领台账 (数组)
  write('ann-aaaaaaaaaaaaaaaa', announcement({
    announcementId: 'ann-aaaaaaaaaaaaaaaa',
    capability: 'market-research',
    budget: { maxAmount: '50000', currency: 'USDC', network: 'base-sepolia' },
    deadline: NOW + 48 * HOUR,
  }));
  write('ann-bbbbbbbbbbbbbbbb', announcement({
    announcementId: 'ann-bbbbbbbbbbbbbbbb',
    capability: 'already-claimed',
    status: 'claimed',
    claims: [{ announcementId: 'ann-bbbbbbbbbbbbbbbb', providerDid: 'did:key:zProvider', claimedAt: NOW - 1000, priceAmountAtomic: '31000', currency: 'USDC', network: 'base-sepolia' }],
  }));
  write('ann-cccccccccccccccc', announcement({ announcementId: 'ann-cccccccccccccccc', capability: 'cancelled-one', status: 'cancelled' }));
  write('ann-dddddddddddddddd', announcement({ announcementId: 'ann-dddddddddddddddd', capability: 'expired-one', deadline: NOW - HOUR }));
  // 认领台账 (同目录, 是**数组**, 不是公告) —— 必须被跳过
  fs.writeFileSync(path.join(BOARD, 'remote-claims.json'), JSON.stringify([
    { announcementId: 'ann-aaaaaaaaaaaaaaaa', providerDid: 'did:key:zClaimer', claimedAt: NOW, priceAmountAtomic: '1', currency: 'USDC', network: 'base-sepolia' },
  ], null, 2), 'utf8');
});

describe('open_tasks · 只导出未认领且未过期的公告', () => {
  it('待接单的留, 已认领/已取消/已过期的一条都不上', () => {
    const rows = NP.readOpenTasks(HOME, NOW);
    expect(rows.map((r: any) => r.capability)).toEqual(['market-research']);
    expect(rows).toHaveLength(1);
    expect(rows[0].claimed).toBe(false);
  });

  it('同目录的 remote-claims.json (认领台账) 不会被当公告解析', () => {
    const rows = NP.readOpenTasks(HOME, NOW);
    expect(rows.some((r: any) => r.capability === '' || r.announcementId === '')).toBe(false);
    // 台账里的认领者 DID 绝不该以任何形式出现在投影里
    expect(JSON.stringify(rows)).not.toContain('did:');
    expect(JSON.stringify(rows)).not.toContain('zClaimer');
  });

  it('时间推进到截止之后 → 那条公告自己从列表里消失 (不靠删文件)', () => {
    expect(NP.readOpenTasks(HOME, NOW + 49 * HOUR)).toHaveLength(0);
    expect(NP.readOpenTasks(HOME, NOW)).toHaveLength(1);
  });

  it('目录不存在 / 空目录 → 空数组, 不抛', () => {
    expect(NP.readOpenTasks(path.join(ROOT, 'no-such-home'), NOW)).toEqual([]);
    const empty = path.join(ROOT, 'empty-home');
    fs.mkdirSync(path.join(empty, '.bolloon', 'tasks', 'board'), { recursive: true });
    expect(NP.readOpenTasks(empty, NOW)).toEqual([]);
  });

  it('坏 JSON / 半个公告 → 跳过那一条, 不编数据也不崩', () => {
    const bad = path.join(ROOT, 'bad-home');
    const dir = path.join(bad, '.bolloon', 'tasks', 'board');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ann-broken.json'), '{ not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'ann-no-cap.json'), JSON.stringify({
      protocol: 'bolloon-task/1', kind: 'task_announcement', announcementId: 'ann-eeeeeeeeeeeeeeee',
      deadline: NOW + HOUR, status: 'open', claims: [],
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'ann-ok.json'), JSON.stringify(announcement({ announcementId: 'ann-ffffffffffffffff', capability: 'survivor' })), 'utf8');
    expect(NP.readOpenTasks(bad, NOW).map((r: any) => r.capability)).toEqual(['survivor']);
  });
});

describe('open_tasks · 白的只有 7 个字段 (正文/身份一个都不许出)', () => {
  it('每行的键集**逐字**等于白名单', () => {
    const rows = NP.readOpenTasks(HOME, NOW);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual([...NP.OPEN_TASK_KEYS]);
    expect(Object.keys(rows[0])).toEqual(['capability', 'budget', 'currency', 'network', 'deadline', 'claimed', 'announcementId']);
  });

  it('正文 / 摘要 / 预览 / 买方 DID / 公钥 / 签名: 整份投影的 JSON 里一个都搜不到', () => {
    const json = JSON.stringify(NP.readOpenTasks(HOME, NOW));
    for (const leak of ['SECRET-BODY', 'SECRET-PREVIEW', 'instruction', 'instructionDigest', 'instructionPreview',
      'buyerDid', 'buyerPublicKeyHex', 'did:key:', 'claims', 'signature', 'providerDid', 'paymentMode']) {
      expect(json, `不该出现 ${leak}`).not.toContain(leak);
    }
  });

  it('announcementId 只出前 8 位 (原 id 不上公开投影)', () => {
    const [row] = NP.readOpenTasks(HOME, NOW);
    expect(row.announcementId).toBe('ann-aaaa');
    expect(row.announcementId).toHaveLength(8);
    expect(JSON.stringify(row)).not.toContain('ann-aaaaaaaaaaaaaaaa');
  });

  it('预算只给原子单位串 + currency/network; 字段齐', () => {
    const [row] = NP.readOpenTasks(HOME, NOW);
    expect(row).toMatchObject({
      capability: 'market-research', budget: '50000', currency: 'USDC',
      network: 'base-sepolia', deadline: NOW + 48 * HOUR, claimed: false, announcementId: 'ann-aaaa',
    });
  });

  it('公告没给预算 → budget/currency/network 是 null (不替它猜 0)', () => {
    const h = path.join(ROOT, 'nobudget-home');
    const dir = path.join(h, '.bolloon', 'tasks', 'board');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ann-1111111111111111.json'), JSON.stringify(
      announcement({ announcementId: 'ann-1111111111111111', capability: 'no-budget', budget: null })), 'utf8');
    const [row] = NP.readOpenTasks(h, NOW);
    expect(row).toMatchObject({ budget: null, currency: null, network: null });
  });
});

describe('open_tasks · 进快照 + 自检守得住 (反向验证)', () => {
  it('getNetworkPulse 把待接单任务带进快照, 且过得了字典与自检', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, now: NOW, force: true } as any);
    expect(snap.open_tasks).toHaveLength(1);
    expect(snap.open_tasks[0].capability).toBe('market-research');
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
    expect(NP.auditPublicHexLeaks(snap)).toEqual([]);
    expect(NP.openTasksIssues(snap)).toEqual([]);
  });

  it('观察层不可用 → open_tasks 仍是数组 (不是 undefined), 自检不红', async () => {
    const down = await NP.getNetworkPulse({ home: HOME, unavailable: true } as any);
    expect(down.status).toBe('unavailable');
    expect(Array.isArray(down.open_tasks)).toBe(true);
    expect(NP.snapshotConsistencyIssues(down)).toEqual([]);
  });

  it('★ 反向: 混进白名单外的键 (展平正文) → 自检报出来', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, now: NOW, force: true } as any);
    const bad: any = { ...snap, open_tasks: [{ ...snap.open_tasks[0], instruction: 'SECRET-BODY' }] };
    expect(NP.openTasksIssues(bad).join(' ')).toContain('白名单外的键');
    expect(NP.snapshotConsistencyIssues(bad).join(' ')).toContain('instruction');
  });

  it('★ 反向: claimed=true (筛选坏了) → 自检报出来', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, now: NOW, force: true } as any);
    const bad: any = { ...snap, open_tasks: [{ ...snap.open_tasks[0], claimed: true }] };
    expect(NP.openTasksIssues(bad).join(' ')).toContain('未认领');
  });

  it('★ 反向: announcementId 给了全长 → 自检报出来', async () => {
    const snap = await NP.getNetworkPulse({ home: HOME, now: NOW, force: true } as any);
    const bad: any = { ...snap, open_tasks: [{ ...snap.open_tasks[0], announcementId: 'ann-aaaaaaaaaaaaaaaa' }] };
    expect(NP.openTasksIssues(bad).join(' ')).toContain('前 8 位');
  });

  it('★ 反向: 老缓存缺 open_tasks → 视为过期形状, 重算 (不把缺字段的快照发出去)', async () => {
    const h = path.join(ROOT, 'stale-shape-home');
    const dir = path.join(h, '.bolloon', 'network-pulse');
    fs.mkdirSync(dir, { recursive: true });
    const fresh = await NP.getNetworkPulse({ home: h, now: NOW, force: true } as any);
    const legacy: any = { ...fresh, generated_at: NOW, fresh_until: NOW + 60000 };
    delete legacy.open_tasks;
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(legacy), 'utf8');
    const again = await NP.getNetworkPulse({ home: h, now: NOW } as any);      // 不带 force: 老缓存本来会被命中
    expect(Array.isArray(again.open_tasks)).toBe(true);
    expect(NP.snapshotConsistencyIssues(again)).toEqual([]);
  });
});
