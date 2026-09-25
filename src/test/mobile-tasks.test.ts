/**
 * mobile-tasks.test.ts — 手机端「任务协作」四能力的**真互操作**测试 (2026-09-25)
 *
 * 要证的三组事:
 *   ① 手机侧诚实纪律: 没桌面地址 / 没法签名 / 本地隐私闸命中 → **一个请求都不发** (绝不发未签名请求);
 *      桌面拒签 → 如实把 code 带回 (不假装成功)。
 *   ② 手机 → 桌面全链路: 手机 WebCrypto 真签名 → 桌面 Node 真验签 → 用**与 CLI 相同的函数**执行
 *      (真 express + 真 HTTP + fake 群 store): 入群 / 公告入群 / 过程留痕, 并断言群里真有那条消息。
 *   ③ 隐私: 桌面闸不是"信手机的" —— 绕开手机本地闸直发带 DID 的请求, 桌面照样拒发且群里没有新消息;
 *      手机读接口的投影里不出现 buyerDid / DID / 原始 id。
 *
 * 隔离: HOME → tmp; 群 store 用 fake CIDDatabase (不触发真实 OrbitDB/网络)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import express from 'express';

import {
  executeTaskAction, joinGroup, loadBoard, loadFlywheel, loadTrail, listGroups,
  postTrail, previewGroupMessage, publishAnnouncement, signTaskAction,
  emptyTaskActionRequest, setTaskHint, getTaskHint,
} from '../web/mobile-tasks.js';
import { signPayloadOnDevice, loadOrCreateDeviceKey, type StorageLike } from '../web/mobile-contacts.js';
import { canonicalTaskActionPayload, taskActionContentText } from '../agents/mobile-task-actions.js';
import { contentDigestOf } from '../agents/mobile-task-actions-verify.js';
import { registerMobileTaskRoutes } from '../web/routes-mobile-tasks.js';
import { createGroup, groupMessages, setGroupTestDb, resetGroupState } from '../agents/gateway-group.js';
import { createGoal } from '../agents/goal-store.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const NOW = 1_800_000_000_000;
let tmp: string;
let prevHome: string | undefined;

function memStorage(): StorageLike & { raw: Map<string, string> } {
  const m = new Map<string, string>();
  return { raw: m, getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
}

/** fake events store (与 gateway-group.test.ts 同款) */
function makeFakeStore(address: string): OrbitDBStore & { data: any[] } {
  const data: any[] = [];
  return {
    address, data,
    put: async () => {},
    add: async (v) => { data.push(v); },
    all: async () => data.map((v, i) => ({ key: `msg-${i}`, value: v })),
    get: async () => null,
    onChange: () => () => {},
  };
}

function makeFakeDB(): CIDDatabase & { stores: Map<string, any> } {
  const stores = new Map<string, any>();
  return {
    stores,
    save: async (d: any) => ({ id: 'cid', agentId: d.agentId, timestamp: 0, type: d.type, content: d.content, metadata: {}, version: 1 }),
    load: async () => null,
    update: async () => null,
    version: async () => [],
    list: async () => [],
    share: async (c: string) => `bolloon-cid://${c}`,
    openStore: async (name: string) => {
      const addr = `/orbitdb/fake-${String(name).replace(/[^a-zA-Z0-9-]/g, '_')}`;
      const s = makeFakeStore(addr);
      stores.set(addr, s);
      return s;
    },
    openStoreByAddress: async (address: string) => {
      if (!stores.has(address)) stores.set(address, makeFakeStore(address));
      return stores.get(address)!;
    },
    close: async () => {},
  } as unknown as CIDDatabase & { stores: Map<string, any> };
}

let fakeDb: ReturnType<typeof makeFakeDB>;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-mobile-tasks-'));
  process.env.HOME = tmp;
  fakeDb = makeFakeDB();
  setGroupTestDb(fakeDb);
  resetGroupState();
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  setGroupTestDb(null);
  resetGroupState();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 记录所有出站请求的 fetch 桩 */
function stubFetch(handler: (url: string, init?: any) => any) {
  const calls: Array<{ url: string; init: any; body: any }> = [];
  const f = async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const r = handler(url, init) || {};
    return { status: r.status ?? 200, json: async () => (r.json === undefined ? { ok: true } : r.json) };
  };
  return { f, calls };
}

/** 真 express + 真 HTTP: 手机与桌面的对话本身就是被测对象 */
async function startDesktop(devices: any[], now = NOW) {
  const app = express();
  app.use(express.json());
  registerMobileTaskRoutes(app, { home: tmp, ownerDid: 'did:bolln:local', devices, now: () => now });
  const srv = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => { srv.close(); (srv as any).closeAllConnections?.(); } };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('① 手机侧的诚实纪律 (不该发的请求一个都不发)', () => {
  it('没设桌面地址 → desktop_offline, 且 fetch 一次都没调', async () => {
    const { f, calls } = stubFetch(() => ({ status: 200, json: { ok: true } }));
    const r = await joinGroup('orbitdb:///orbitdb/fake-x?type=group&name=g', { fetchImpl: f, storage: memStorage(), base: '' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('desktop_offline');
    expect(calls).toHaveLength(0);
  });

  it('本机不支持 Ed25519 → device_signing_unavailable, 且 fetch 一次都没调', async () => {
    const { f, calls } = stubFetch(() => ({ status: 200, json: { ok: true } }));
    const r = await joinGroup('orbitdb:///orbitdb/fake-x?type=group&name=g', {
      fetchImpl: f, storage: memStorage(), base: 'http://127.0.0.1:1', cryptoObj: {} as any,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('device_signing_unavailable');
    expect(calls).toHaveLength(0);
  });

  it('群消息字段里带 DID → 本地隐私闸拦下, 且 fetch 一次都没调', async () => {
    const { f, calls } = stubFetch(() => ({ status: 200, json: { ok: true } }));
    const req = {
      ...emptyTaskActionRequest('trail_post'),
      groupRef: 'gid-1', announcementId: 'ann-abcdef123456', trailKind: 'claim' as const,
      round: 'did:key:z6Mkabcdefgh',
    };
    const r = await executeTaskAction(req, { fetchImpl: f, storage: memStorage(), base: 'http://127.0.0.1:1', now: () => NOW });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('privacy_denied');
    expect(r.violations?.map((v) => v.rule)).toContain('did');
    expect(calls).toHaveLength(0);
  });

  it('签名成功后: 请求体里带 device 签名, contentDigest 与桌面重算值一致', async () => {
    const storage = memStorage();
    const req = {
      ...emptyTaskActionRequest('trail_post'),
      groupRef: 'gid-1', announcementId: 'ann-abcdef123456', trailKind: 'final' as const, verdict: 'accept',
    };
    const { f, calls } = stubFetch(() => ({ status: 200, json: { ok: true, text: '已发出' } }));
    const r = await executeTaskAction(req, { fetchImpl: f, storage, base: 'http://desk.local', now: () => NOW });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://desk.local/api/mobile/tasks/execute');
    expect(calls[0].body.signature.sig).toBeTruthy();
    expect(calls[0].body.signature.deviceId).toBe(calls[0].body.action.deviceId);
    // 桌面会用同一份规范化文本重算 → 这里先证明手机算的就是那个值
    expect(calls[0].body.action.contentDigest).toBe(contentDigestOf(req));
    expect(r.data?.text).toBe('已发出');
  });

  it('桌面拒签 → 如实带回 code (不假装成功)', async () => {
    const { f } = stubFetch(() => ({ status: 403, json: { ok: false, code: 'SIGNATURE_REJECTED', error: '手机签名没通过: unknown_device' } }));
    const r = await executeTaskAction(
      { ...emptyTaskActionRequest('group_leave'), groupRef: 'gid-1' },
      { fetchImpl: f, storage: memStorage(), base: 'http://desk.local', now: () => NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SIGNATURE_REJECTED');
    expect(r.error).toContain('unknown_device');
  });

  it('桌面不可达 (fetch 抛错) → desktop_offline (不进离线队列: 任务动作队列化比失败更危险)', async () => {
    const f = async () => { throw new Error('connect ECONNREFUSED'); };
    const r = await executeTaskAction(
      { ...emptyTaskActionRequest('group_leave'), groupRef: 'gid-1' },
      { fetchImpl: f, storage: memStorage(), base: 'http://desk.local', now: () => NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('desktop_offline');
    expect(r.note).toContain('不替桌面记账');
  });
});

describe('② 读接口的投影 (标识符不出门)', () => {
  it('看板: buyerDid/claimedBy 不进手机视图, 公告号只给缩短形式', async () => {
    const entry = {
      announcementId: 'ann-1234567890abcdef', capability: 'research', status: 'open',
      budget: { maxAmount: '50000', currency: 'USDC', network: 'base-sepolia' }, deadline: NOW + 3_600_000,
      createdAt: NOW - 1000, claimCount: 2, instructionDigest: 'a'.repeat(64), instructionPreview: '调研某类厨房用品',
      buyerDid: 'did:key:z6MkBuyerSecret', claimedBy: 'did:key:z6MkClaimerSecret',
      remote: false, source: 'local', signatureVerified: true, claimable: true,
    };
    const { f } = stubFetch(() => ({ status: 200, json: { ok: true, entries: [entry], localCount: 1, remoteCount: 0, registryReady: true, registryError: null, notes: [] } }));
    const r = await loadBoard({ fetchImpl: f, base: 'http://desk.local', now: () => NOW, storage: memStorage() });
    expect(r.ok).toBe(true);
    const blob = JSON.stringify(r.data);
    expect(blob).not.toContain('did:key');
    expect(blob).not.toContain('z6MkBuyerSecret');
    expect(r.data!.items[0].idShort).toBe('ann-12345678…');
    expect(r.data!.items[0].statusLabel.zh).toBe('可接单');
    expect(r.data!.openCount).toBe(1);
  });

  it('群痕迹: 字段再过滤一遍, 命中规则的只留规则名; 发送者保留脱敏假名', async () => {
    const summary = {
      count: 1, byKind: { announce: 1 }, announcements: ['ann-1234567890abcdef'],
      entries: [{ kind: 'announce', at: NOW - 60_000, sender: 'agent-1234abcd', announcementId: 'ann-1234567890abcdef', fields: { kind: 'announce', id: 'ann-1234567890abcdef', cap: 'research', judge: 'did:key:z6MkLeak' }, text: 'x' }],
      flags: { announced: true, claimed: false, delivered: false, screened: false, finalized: false, accepted: false, rejected: false },
      inconsistencies: ['group-message-hit-privacy-rule'], ignoredMessages: 3, redacted: ['did@announce'],
    };
    const { f } = stubFetch(() => ({ status: 200, json: { ok: true, group: { id: 'g1', name: 'g' }, summary } }));
    const r = await loadTrail({ groupRef: 'g1' }, { fetchImpl: f, base: 'http://desk.local', storage: memStorage() });
    expect(r.ok).toBe(true);
    const blob = JSON.stringify(r.data);
    expect(blob).not.toContain('z6MkLeak');
    expect(r.data!.entries[0].facts.find((x) => x.k === 'judge')!.v).toBe('[已遮蔽:did]');
    expect(r.data!.entries[0].sender).toBe('agent-1234abcd');
    expect(r.data!.announcementIdsShort[0]).toBe('ann-12345678…');
    expect(r.data!.privacyHits).toBe(true);
    expect(r.data!.ignoredMessages).toBe(3);
  });

  it('群列表: 只给缩短 id/群名/时间 (store 地址与邀请链接不进来)', async () => {
    const { f } = stubFetch(() => ({ status: 200, json: { ok: true, groups: [{ id: 'zdpuAaaaaaaaaaaaaaaaaa', name: '协作群', createdAt: '2026-09-25T00:00:00.000Z', address: '/orbitdb/zdpuAaaa', link: 'orbitdb:///orbitdb/zdpuAaaa?type=group&name=x' }] } }));
    const r = await listGroups({ fetchImpl: f, base: 'http://desk.local', storage: memStorage() });
    expect(r.ok).toBe(true);
    expect(r.data![0].idShort).toBe('zdpuAaaaaaaa…');
    const blob = JSON.stringify(r.data);
    expect(blob).not.toContain('orbitdb://');
    expect(blob).not.toContain('/orbitdb/');
  });

  it('飞轮: 桌面投影里若混进内部字段 → 手机拒绝渲染 (宁可显示读不到)', async () => {
    const { f } = stubFetch(() => ({ status: 200, json: { ok: true, goals: [{ visibleState: 'executing', lease: 'worker-1' }] } }));
    const bad = await loadFlywheel({ fetchImpl: f, base: 'http://desk.local', storage: memStorage() });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('view_leak');
    expect(bad.error).toContain('lease');
  });

  it('提示文案只存极短文本', () => {
    const s = memStorage();
    setTaskHint('已入群「协作群」', s);
    expect(getTaskHint(s)).toBe('已入群「协作群」');
  });
});

describe('③ 手机 → 桌面全链路 (真 express + 真 HTTP + fake 群 store)', () => {
  it('发公告 → 入群 → 公告入群 → 留痕: 群里真有那几条消息, 且都是桌面验签后才发的', async () => {
    const { initLocalIdentity } = await import('../cli/setup-wizard.js');
    const ident = await initLocalIdentity(tmp);
    expect(ident.ok, JSON.stringify(ident)).toBe(true);

    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage as any, crypto);
    const desktop = await startDesktop([{ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, registeredAt: new Date(NOW).toISOString() }]);
    const deps = { storage, base: desktop.base, now: () => NOW, ownerDid: 'did:bolln:local' } as any;
    try {
      // ⓪ 桌面先建一个群 (等价于 CLI `task group create`) —— 手机拿邀请链接入群
      const created = await createGroup('协作群');
      expect(created.ok).toBe(true);

      // ① 入群
      const joined = await joinGroup(created.group!.link, deps);
      expect(joined.ok, JSON.stringify(joined)).toBe(true);
      expect(JSON.stringify(joined.data)).toContain('协作群');
      const groups = await listGroups(deps);
      expect(groups.data!.some((g) => g.name === '协作群')).toBe(true);

      // ② 发一条公告 (手机签名 → 桌面用本机身份签公告 + 落盘)
      const pub = await publishAnnouncement(
        { capability: 'research', instruction: '调研某类厨房用品的日本市场渠道结构', budgetHuman: '0.05' },
        deps,
      );
      expect(pub.ok, JSON.stringify(pub)).toBe(true);
      const announcementId = String(pub.data!.announcementId || '');
      expect(announcementId).toMatch(/^ann-[0-9a-f]{16}$/);

      // 看板能看回来 (手机视图: 只给缩短 id)
      const board = await loadBoard(deps);
      expect(board.ok).toBe(true);
      expect(board.data!.items.map((i) => i.idShort)).toContain(announcementId.slice(0, 12) + '…');
      // 显示面只有缩短 id; 完整公告号只作为 ref 留在 JS 内存里驱动动作 (页面不许渲染它)
      const item = board.data!.items[0];
      expect(item.ref).toBe(announcementId);
      const displayOnly = { ...item, ref: '' };
      expect(JSON.stringify(displayOnly)).not.toContain(announcementId);
      expect(JSON.stringify(item.idShort)).not.toContain(announcementId);

      // ③ 把这条公告发进群: 先预览 (桌面构造器) → 再签名执行, 两次文本必须一致
      const baseReq = {
        ...emptyTaskActionRequest('announce_to_group'),
        groupRef: created.group!.id, announcementId, criteria: '渠道结构/价格带',
      };
      const prev = await previewGroupMessage(baseReq, deps);
      expect(prev.ok, JSON.stringify(prev)).toBe(true);
      expect(prev.data!.text.startsWith('[bolloon-task]')).toBe(true);
      expect(prev.data!.text).toContain('kind=announce');

      const ann = await executeTaskAction(baseReq, deps);
      expect(ann.ok, JSON.stringify(ann)).toBe(true);
      expect(ann.data!.text).toBe(prev.data!.text);

      // ④ 过程留痕 (claim)
      const post = await postTrail({ kind: 'claim', groupRef: created.group!.id, announcementId, price: '0.05' }, deps);
      expect(post.ok, JSON.stringify(post)).toBe(true);
      expect(post.data!.text).toContain('kind=claim');

      const texts = (await groupMessages(created.group!.id, 50)).map((m) => m.text);
      expect(texts.some((t) => t.includes('kind=announce') && t.includes('cap='))).toBe(true);
      expect(texts.some((t) => t.includes('kind=claim') && t.includes('price=0.05'))).toBe(true);

      // 读回: 手机走 trail 接口能看回这两条 (脱敏 + 缩短 id)
      const trail = await loadTrail({ groupRef: created.group!.id }, deps);
      expect(trail.ok, JSON.stringify(trail)).toBe(true);
      expect(trail.data!.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['announce', 'claim']));
      expect(JSON.stringify(trail.data)).not.toContain(announcementId);   // 痕迹里连原文 id 都不留
    } finally {
      desktop.close();
    }
  });

  it('桌面闸不是"信手机的": 绕开手机本地闸直发带 DID 的留痕 → 桌面拒发(409), 群里没有新消息', async () => {
    const { initLocalIdentity } = await import('../cli/setup-wizard.js');
    await initLocalIdentity(tmp);
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage as any, crypto);
    const desktop = await startDesktop([{ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, registeredAt: new Date(NOW).toISOString() }]);
    try {
      const created = await createGroup('闸门群');
      const groupId = created.group!.id;
      const before = (await groupMessages(groupId, 50)).length;

      // 手工签一个"带 DID 的接单" (绕过手机侧 executeTaskAction 的本地闸)
      const req = {
        ...emptyTaskActionRequest('trail_post'),
        groupRef: groupId, announcementId: 'ann-1234567890abcdef', trailKind: 'claim' as const,
        price: 'did:key:z6MkShouldNotLeak',
      };
      const action = {
        actionId: 'act-manual-0001', kind: 'trail_post' as const, deviceId: dev.deviceId, ownerDid: 'did:bolln:local',
        targetRef: groupId, contentDigest: contentDigestOf(req),
        createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
        grantedBy: 'leo', via: 'mobile' as const,
      };
      const signature = await signPayloadOnDevice(canonicalTaskActionPayload(action), storage as any, crypto);
      const res = await fetch(`${desktop.base}/api/mobile/tasks/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: req, action, signature }),
      });
      const j: any = await res.json();
      expect(res.status).toBe(409);
      expect(j.code).toBe('GROUP_SEND_REFUSED');
      expect(JSON.stringify(j)).not.toContain('z6MkShouldNotLeak');
      expect((await groupMessages(groupId, 50)).length).toBe(before);
    } finally {
      desktop.close();
    }
  });

  it('未登记设备 → 403 unknown_device (不执行)', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage as any, crypto);
    const desktop = await startDesktop([{ deviceId: 'dev-someone-else', publicKeyPem: dev.publicKeyPem, registeredAt: new Date(NOW).toISOString() }]);
    try {
      const req = { ...emptyTaskActionRequest('group_leave'), groupRef: 'gid-1' };
      const signed = await signTaskAction(req, { storage: storage as any, now: () => NOW, ownerDid: 'x' });
      expect(signed.ok).toBe(true);
      const res = await fetch(`${desktop.base}/api/mobile/tasks/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: req, ...signed.data!.signed }),
      });
      const j: any = await res.json();
      expect(res.status).toBe(403);
      expect(j.reason).toBe('unknown_device');
    } finally {
      desktop.close();
    }
  });

  it('类型不符: 拿 group_leave 的签名去发 group_create → 403 (签名不覆盖这个动作), 且真的没建群', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage as any, crypto);
    const desktop = await startDesktop([{ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, registeredAt: new Date(NOW).toISOString() }]);
    try {
      const signedReq = { ...emptyTaskActionRequest('group_leave'), groupRef: 'gid-1' };
      const signed = await signTaskAction(signedReq, { storage: storage as any, now: () => NOW, ownerDid: 'x' });
      expect(signed.ok).toBe(true);
      const otherReq = { ...emptyTaskActionRequest('group_create'), groupRef: '偷袭群' };
      const res = await fetch(`${desktop.base}/api/mobile/tasks/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: otherReq, ...signed.data!.signed }),
      });
      const j: any = await res.json();
      expect(res.status).toBe(403);
      expect(j.code).toBe('SIGNATURE_REJECTED');
      expect(j.reason).toBe('kind_mismatch');
      // 真正的证据: 群里没有多出「偷袭群」
      const { listGroups: listDesktopGroups } = await import('../agents/gateway-group.js');
      expect((await listDesktopGroups()).some((g) => g.name === '偷袭群')).toBe(false);
    } finally {
      desktop.close();
    }
  });

  it('过期签名被桌面拒 (403 expired)', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage as any, crypto);
    const desktop = await startDesktop([{ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, registeredAt: new Date(NOW).toISOString() }], NOW + 3_600_000);
    try {
      const req = { ...emptyTaskActionRequest('group_leave'), groupRef: 'gid-1' };
      const signed = await signTaskAction(req, { storage: storage as any, now: () => NOW, ownerDid: 'x' });
      const res = await fetch(`${desktop.base}/api/mobile/tasks/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: req, ...signed.data!.signed }),
      });
      const j: any = await res.json();
      expect(res.status).toBe(403);
      expect(j.reason).toBe('expired');
    } finally {
      desktop.close();
    }
  });

  it('发布公告: 本机没有可签名身份 → 400 NO_LOCAL_IDENTITY (不假装发出去了)', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage as any, crypto);
    const desktop = await startDesktop([{ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, registeredAt: new Date(NOW).toISOString() }]);
    try {
      const r = await publishAnnouncement(
        { capability: 'research', instruction: '调研某类厨房用品的日本市场', budgetHuman: '0.05' },
        { storage: storage as any, base: desktop.base, now: () => NOW, ownerDid: 'x' } as any,
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('NO_LOCAL_IDENTITY');
    } finally {
      desktop.close();
    }
  });

  it('看板与飞轮进度 (只读): 空板也如实回 ok, 有 Goal 时给出五类状态之一', async () => {
    const desktop = await startDesktop([]);
    try {
      const board = await loadBoard({ base: desktop.base, now: () => NOW, storage: memStorage() } as any);
      expect(board.ok).toBe(true);
      expect(board.data!.items).toEqual([]);

      await createGoal({ objective: '把手机端任务能力补齐并与桌面/CLI 对齐', successCriteria: ['四能力可发起'], createdBy: 'leo' });
      const fw = await loadFlywheel({ base: desktop.base, now: () => NOW, storage: memStorage() } as any);
      expect(fw.ok, JSON.stringify(fw)).toBe(true);
      expect(fw.data!.goals.length).toBe(1);
      const g = fw.data!.goals[0] as any;
      expect(['executing', 'waiting_external_reply', 'child_blocked', 'no_progress', 'needs_your_decision']).toContain(g.view.visibleState);
      expect(g.view.stateLabel.zh).toBeTruthy();
      expect(g.terminal).toBe(false);
      expect(g.objectiveShort).toContain('手机端任务能力');
      // 内部字段一个都不许出现
      const blob = JSON.stringify(g);
      for (const f of ['lease', 'reducer', 'internal_status', 'retry_counter', 'worker_owner']) {
        expect(blob).not.toContain(f);
      }
      // 汇报面只允许 USER_REPORT_FIELDS 里的字段名
      const { USER_REPORT_FIELDS } = await import('../agents/goal-flywheel/types.js');
      for (const k of Object.keys(g.view.report)) {
        if (k === 'exposedFields' || k === 'generatedAt') continue;
        expect(USER_REPORT_FIELDS).toContain(k);
      }
    } finally {
      desktop.close();
    }
  });
});

describe('④ 签名载荷与桌面重算的规范化文本一致 (端到端不看约定看字节)', () => {
  it('手机签的 contentDigest = 桌面 contentDigestOf(同一请求)', async () => {
    const storage = memStorage();
    const req = {
      ...emptyTaskActionRequest('announce_to_group'),
      groupRef: 'gid-1', announcementId: 'ann-abcdef123456', round: 'R1', criteria: '判据一',
    };
    const signed = await signTaskAction(req, { storage: storage as any, now: () => NOW, ownerDid: 'x' });
    expect(signed.ok).toBe(true);
    expect(signed.data!.signed.action.contentDigest).toBe(contentDigestOf(req));
    expect(signed.data!.contentText).toBe(taskActionContentText(req));
    expect(signed.data!.confirm.titleZh).toBe('把这期公告发进群');
    expect(signed.data!.confirm.lines.map((l) => l.k)).toContain('验收判据');
  });
});

function mergedGroup(r: any): string {
  return JSON.stringify(r.data || {});
}
