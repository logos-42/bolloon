/**
 * mobile-task-views.test.ts — 手机端视图投影 (纯函数) 的纪律测试 (2026-09-25)
 *
 * 这一层是"桌面事实 → 手机能直接渲染的行"的**唯一**转换点, 所以它必须被钉死:
 *   · 原始 DID / peerId / IP / 钱包地址 / 群 store 地址 / 协议 id 原文 —— 一个都不许露
 *   · 命中红线只报规则名, 不回显内容
 *   · 双语表与 task-group 的中文名不许漂移 (有单测防漂移)
 *   · 相对时间只给毫秒差 (由 UI 写文字节点, 不在这里拼死字符串)
 */
import { describe, it, expect } from 'vitest';
import {
  shortId, isProtocolId, formatRelative, buildBoardView, buildTrailView, buildGroupsView,
  describeTaskActionForConfirm, boardItemOf, STATUS_LABELS, TRAIL_KIND_LABELS, INCONSISTENCY_LABELS,
  type Lang,
} from '../agents/mobile-task-views.js';
import { scanPublicText } from '../agents/task-public-text.js';

const NOW = 1_800_000_000_000;

describe('① 缩短 / 协议 id 识别', () => {
  it('shortId: 短的照原样, 长的截断加省略号, 空的不显示 undefined', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('ann-1234567890abcdef')).toBe('ann-12345678…');
    expect(shortId('')).toBe('');
    expect(shortId(null)).toBe('');
    expect(shortId(undefined)).toBe('');
  });

  it('isProtocolId: 公告号/动作号/OrbitDB 地址都算协议 id', () => {
    expect(isProtocolId('ann-19d92abef510ff86')).toBe(true);
    expect(isProtocolId('act-abc123')).toBe(true);
    expect(isProtocolId('zdpuAqzRawGroupStoreId')).toBe(true);
    expect(isProtocolId('/orbitdb/zdpuA')).toBe(true);
    expect(isProtocolId('research')).toBe(false);
    expect(isProtocolId('0.05')).toBe(false);
  });
});

describe('② 相对时间 (只给毫秒差, 双语人话)', () => {
  it('过去/未来/边界都有说法', () => {
    expect(formatRelative(2 * 3_600_000, 'zh')).toBe('2 小时前');
    expect(formatRelative(2 * 3_600_000, 'en')).toBe('2 h ago');
    expect(formatRelative(-90_000, 'zh')).toBe('1 分钟后');
    expect(formatRelative(-90_000, 'en')).toBe('in 1 min');
    expect(formatRelative(30_000, 'zh')).toBe('不到 1 分钟前');
    expect(formatRelative(3 * 86_400_000, 'en')).toBe('3 d ago');
    expect(formatRelative(null, 'zh')).toBe('—');
    expect(formatRelative(NaN, 'en')).toBe('—');
  });
});

describe('③ 公告板投影: 身份字段一律丢弃', () => {
  const entry = {
    announcementId: 'ann-19d92abef510ff86', capability: 'research', status: 'open',
    budget: { maxAmount: '50000', currency: 'usdc', network: 'base-sepolia' },
    deadline: NOW + 3_600_000, createdAt: NOW - 60_000, claimCount: 2,
    instructionDigest: 'a'.repeat(64), instructionPreview: '调研某类厨房用品',
    buyerDid: 'did:key:z6MkBuyerSecret', claimedBy: 'did:key:z6MkClaimerSecret',
    ip: '10.0.0.7', peerId: '12D3KooWSecretPeer', wallet: '0x1111111111111111111111111111111111111111',
    remote: true, source: 'registry', signatureVerified: false, claimable: true,
  };

  it('单条: 只有白名单字段, 标识符一个都不在', () => {
    const item = boardItemOf(entry, NOW);
    expect(Object.keys(item).sort()).toEqual([
      'budgetLabel', 'capability', 'claimCount', 'claimable', 'createdAtMs', 'deadlineInMs',
      'idShort', 'preview', 'ref', 'remote', 'signatureVerified', 'status', 'statusLabel',
    ]);
    expect(item.idShort).toBe('ann-19d92abe…');
    expect(item.ref).toBe('ann-19d92abef510ff86');   // 只给动作驱动用 (不渲染)
    expect(item.statusLabel).toBe(STATUS_LABELS.open);
    expect(item.deadlineInMs).toBe(3_600_000);
    expect(item.claimCount).toBe(2);
    expect(item.signatureVerified).toBe(false);
    const display = JSON.stringify({ ...item, ref: '' });
    for (const secret of ['did:key', 'z6MkBuyerSecret', 'z6MkClaimerSecret', '12D3KooWSecretPeer', '10.0.0.7', '0x1111', 'a'.repeat(64)]) {
      expect(display).not.toContain(secret);
    }
    expect(display).not.toContain(entry.announcementId);
  });

  it('整视图: 计数与备注如实带出, notes 里不留标识符', () => {
    const view = buildBoardView({
      entries: [entry], localCount: 0, remoteCount: 1, registryReady: true, registryError: null,
      notes: ['注册表里 1 条, 本机 0 条'],
    }, NOW);
    expect(view.items).toHaveLength(1);
    expect(view.localCount).toBe(0);
    expect(view.remoteCount).toBe(1);
    expect(view.registryReady).toBe(true);
    expect(view.openCount).toBe(1);
    expect(view.notes.join(' ')).toContain('注册表');
    expect(JSON.stringify({ ...view, items: view.items.map((i) => ({ ...i, ref: '' })) })).not.toContain('did:key');
  });

  it('坏数据不炸: 缺字段 → 状态 unknown, 预算空, 时间 null', () => {
    const item = boardItemOf({}, NOW);
    expect(item.status).toBe('unknown');
    expect(item.statusLabel).toBe(STATUS_LABELS.unknown);
    expect(item.budgetLabel).toBe('');
    expect(item.deadlineInMs).toBe(null);
    expect(item.preview).toBe(null);
    expect(buildBoardView(null, NOW).items).toEqual([]);
  });
});

describe('④ 群痕迹投影: 规则表 + 协议 id 双闸', () => {
  const summary = {
    count: 3, byKind: { announce: 1, claim: 2 }, announcements: ['ann-19d92abef510ff86'],
    entries: [
      { kind: 'announce', at: NOW - 60_000, sender: 'agent-2d86796f', announcementId: 'ann-19d92abef510ff86',
        fields: { kind: 'announce', id: 'ann-19d92abef510ff86', cap: 'research', judge: '渠道结构', v: '1' } },
      { kind: 'claim', at: NOW - 30_000, sender: 'agent-2d86796f', announcementId: 'ann-19d92abef510ff86',
        fields: { kind: 'claim', id: 'ann-19d92abef510ff86', price: '0.05', note: 'did:key:z6MkLeaked' } },
    ],
    flags: { announced: true, claimed: true, delivered: false, screened: false, finalized: false, accepted: false, rejected: false },
    inconsistencies: ['claim-without-announce'], ignoredMessages: 4, redacted: ['did@claim'],
  };

  it('协议 id 缩短; 命中规则只报规则名; 发送者保留脱敏假名', () => {
    const view = buildTrailView(summary);
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0].kindLabel).toBe(TRAIL_KIND_LABELS.announce);
    const announceFacts = view.entries[0].facts;
    expect(announceFacts.find((f) => f.k === 'id')!.v).toBe('ann-19d92abe…');
    expect(announceFacts.find((f) => f.k === 'cap')!.v).toBe('research');
    const claimFacts = view.entries[1].facts;
    expect(claimFacts.find((f) => f.k === 'note')!.v).toBe('[已遮蔽:did]');
    expect(claimFacts.some((f) => f.v.includes('z6MkLeaked'))).toBe(false);
    expect(view.entries[0].sender).toBe('agent-2d86796f');
    expect(JSON.stringify(view)).not.toContain('z6MkLeaked');
    expect(JSON.stringify(view)).not.toContain('ann-19d92abef510ff86');
  });

  it('矛盾/忽略/遮蔽计数如实带出, 且标签双语齐备', () => {
    const view = buildTrailView(summary);
    expect(view.announcementIdsShort).toEqual(['ann-19d92abe…']);
    expect(view.inconsistencies[0].code).toBe('claim-without-announce');
    expect(view.inconsistencies[0].label.zh).toBeTruthy();
    expect(view.inconsistencies[0].label.en).toBeTruthy();
    expect(view.redactedCount).toBe(1);
    expect(view.ignoredMessages).toBe(4);
    expect(view.privacyHits).toBe(true);
    expect(view.flags.claimed).toBe(true);
  });

  it('空/坏 summary 不炸', () => {
    const empty = buildTrailView(null);
    expect(empty.entries).toEqual([]);
    expect(empty.privacyHits).toBe(false);
    expect(empty.ignoredMessages).toBe(0);
    expect(buildTrailView({ entries: [{ kind: 'weird', fields: null }] }).entries[0].kindLabel.zh).toBe('weird');
  });
});

describe('⑤ 群列表投影: 不给 store 地址与邀请链接', () => {
  it('只留缩短 id / 群名 / 加入时间', () => {
    const view = buildGroupsView([{
      id: 'zdpuAqzRawGroupStoreId1234567890', name: '协作群', createdAt: '2026-09-25T02:00:00.000Z',
      address: '/orbitdb/zdpuAqzRawGroupStoreId', link: 'orbitdb:///orbitdb/zdpuAqz?type=group&name=x',
      lastSyncAt: '2026-09-25T03:00:00.000Z', messageCount: 12, memberCount: 3,
    }]);
    expect(view).toHaveLength(1);
    expect(Object.keys(view[0]).sort()).toEqual(['idShort', 'joinedAt', 'name']);
    expect(view[0].idShort).toBe('zdpuAqzRawGr…');
    const blob = JSON.stringify(view);
    expect(blob).not.toContain('/orbitdb/');
    expect(blob).not.toContain('orbitdb://');
  });
});

describe('⑥ 确认页文案: 说明"你要发出什么", 但不漏标识符', () => {
  it('按动作类型给标题与字段 (含英文标签)', () => {
    const c = describeTaskActionForConfirm('announce_to_group', {
      kind: 'announce_to_group', groupRef: 'zdpuAqzRawGroupStoreId1234567890',
      announcementId: 'ann-19d92abef510ff86', round: 'R1', criteria: '渠道结构/价格带',
    });
    expect(c.titleZh).toBe('把这期公告发进群');
    expect(c.titleEn).toContain('Post this announcement');
    const byKey = Object.fromEntries(c.lines.map((l) => [l.k, l]));
    expect(byKey['公告号'].v).toBe('ann-19d92abe…');
    expect(byKey['公告号'].kEn).toBe('announcement');
    expect(byKey['群'].v).toBe('zdpuAqzRawGroupStoreId12…');
    expect(byKey['验收判据'].v).toBe('渠道结构/价格带');
    expect(byKey['期号'].v).toBe('R1');
    // 群 store 地址原文不出现 (只给 24 位缩短形式)
    expect(JSON.stringify(c)).not.toContain('zdpuAqzRawGroupStoreId1234567890');
    expect(JSON.stringify(c)).not.toContain('ann-19d92abef510ff86');
  });

  it('发布公告 / 留痕 / 入群 / 退群 / 建群 都有话说', () => {
    const pub = describeTaskActionForConfirm('announce_publish', { capability: 'research', instruction: '调研', budgetHuman: '0.05', currency: 'usdc', deadline: '+2h' });
    expect(pub.titleZh).toBe('发布任务公告');
    const keys = pub.lines.map((l) => l.k);
    expect(keys).toEqual(expect.arrayContaining(['能力', '预算', '任务正文', '截止']));
    expect(pub.lines.find((l) => l.k === '预算')!.v).toBe('0.05 USDC');
    expect(describeTaskActionForConfirm('trail_post', { trailKind: 'claim', price: '0.05' }).lines.find((l) => l.k === '痕迹类型')!.v).toBe('接单声明');
    expect(describeTaskActionForConfirm('group_join', {}).titleZh).toBe('加入这个群');
    expect(describeTaskActionForConfirm('group_leave', {}).titleZh).toBe('退出这个群');
    expect(describeTaskActionForConfirm('group_create', {}).titleZh).toBe('建一个新群');
    expect(describeTaskActionForConfirm('不知道' as any, {}).titleZh).toBe('执行这个动作');
  });
});

describe('⑦ 投影里的每个字符串都不该命中红线 (自证)', () => {
  it('把投影结果整串过一遍规则表 → 0 命中 (除已遮蔽占位)', () => {
    const blob = JSON.stringify(buildTrailView({
      entries: [{ kind: 'announce', at: NOW, sender: 'agent-abcdef12', announcementId: 'ann-19d92abef510ff86', fields: { id: 'ann-19d92abef510ff86', cap: 'research', judge: '价格带' } }],
    }));
    expect(scanPublicText(blob)).toEqual([]);
  });

  it('双语标签表齐全 (标签缺失会被 UI 渲染成 undefined)', () => {
    for (const lang of ['zh', 'en'] as Lang[]) {
      for (const [, v] of Object.entries(TRAIL_KIND_LABELS)) expect(v[lang]).toBeTruthy();
      for (const [, v] of Object.entries(STATUS_LABELS)) expect(v[lang]).toBeTruthy();
      for (const [, v] of Object.entries(INCONSISTENCY_LABELS)) expect(v[lang]).toBeTruthy();
    }
  });
});
