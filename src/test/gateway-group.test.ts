/**
 * gateway-group.test.ts — 2026-08-14
 *
 * Agent Gateway P2P 群组 (微信式群聊, OrbitDB events store write:'*'):
 *   - parseGroupLink / detectGroupLink 群组链接解析
 *   - createGroup 创建群组 (accessController write:'*' + 欢迎消息 + 持久化)
 *   - joinGroup 链接加入 + 幂等
 *   - groupSend / groupMessages 消息广播与读回
 *   - groupMembers / groupInfo / restoreGroups
 *
 * 隔离: HOME/USERPROFILE → tmp; fake CIDDatabase 注入 (setGroupTestDb, 不触发真实 OrbitDB).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { KeyManager } from '@diap/sdk';
import {
  parseGroupLink,
  detectGroupLink,
  createGroup,
  joinGroup,
  groupSend,
  groupMessages,
  groupMembers,
  groupInfo,
  listGroups,
  restoreGroups,
  inviteMember,
  kickMember,
  setGroupPrivacy,
  groupStatus,
  groupLink,
  setGroupTestDb,
  resetGroupState,
} from '../agents/gateway-group.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-grp-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');
const groupsFile = path.join(fakeHome, '.bolloon', 'gateway-groups.json');

/** fake events store: add 追加, all 按序返回 */
function makeFakeStore(address: string): OrbitDBStore & { data: any[] } {
  const data: any[] = [];
  return {
    address,
    data,
    put: async () => {},
    add: async (v) => { data.push(v); },
    all: async () => data.map((v, i) => ({ key: `msg-${i}`, value: v })),
    get: async () => null,
    onChange: () => () => {},
  };
}

/** fake CIDDatabase: openStore 建新 store, openStoreByAddress 复用已有 (模拟复制) */
function makeFakeDB(): CIDDatabase {
  const stores = new Map<string, OrbitDBStore & { data: any[] }>();
  return {
    save: async (d) => ({ id: 'cid', agentId: d.agentId, timestamp: 0, type: d.type, content: d.content, metadata: {}, version: 1 }),
    load: async () => null,
    update: async () => null,
    version: async () => [],
    list: async () => [],
    share: async (c) => `bolloon-cid://${c}`,
    openStore: async (name, type, opts) => {
      const addr = `/orbitdb/fake-${String(name).replace(/[^a-zA-Z0-9-]/g, '_')}`;
      const s = makeFakeStore(addr);
      stores.set(addr, s);
      return s;
    },
    openStoreByAddress: async (address) => {
      if (!stores.has(address)) stores.set(address, makeFakeStore(address));
      return stores.get(address)!;
    },
    close: async () => {},
  };
}

async function readGroupsFile(): Promise<any[]> {
  try { return JSON.parse(await fs.readFile(groupsFile, 'utf-8')); } catch { return []; }
}

describe('gateway-group (Agent Gateway P2P 群组)', () => {
  beforeEach(async () => {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(fakeHome, { recursive: true });
    resetGroupState();
    setGroupTestDb(makeFakeDB());
  });

  afterEach(() => {
    setGroupTestDb(null);
    resetGroupState();
  });

  // ---------- 链接解析 ----------

  it('parseGroupLink 识别群组链接 (type=group)', () => {
    const r = parseGroupLink('orbitdb:///orbitdb/zdpu123?type=group&name=my%20group');
    expect(r?.address).toBe('/orbitdb/zdpu123');
    expect(r?.name).toBe('my group');
    // 非群组链接 (registry 网络) → null
    expect(parseGroupLink('orbitdb:///orbitdb/zdpu123?name=net')).toBeNull();
    expect(parseGroupLink('https://x/registry')).toBeNull();
    expect(parseGroupLink('bogus')).toBeNull();
  });

  it('detectGroupLink 从文本检测群组链接', () => {
    const t = '加入我们群: orbitdb:///orbitdb/zdpu123?type=group&name=research-net 一起协作';
    expect(detectGroupLink(t)).toContain('type=group');
    expect(detectGroupLink('普通消息')).toBeNull();
  });

  // ---------- 创建 / 加入 ----------

  it('createGroup 创建群组 (write:* + 欢迎消息 + 持久化)', async () => {
    const r = await createGroup('研究协作组', { from: 'did:diap:owner', hello: '大家好' });
    expect(r.ok).toBe(true);
    expect(r.group?.name).toBe('研究协作组');
    expect(r.group?.link).toContain('type=group');
    // 欢迎消息 (hello 覆盖默认)
    const msgs = await groupMessages(r.group!.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe('大家好');
    // 持久化
    const saved = await readGroupsFile();
    expect(saved.length).toBe(1);
    expect(saved[0].id).toBe(r.group?.id);
  });

  it('joinGroup 链接加入 + 幂等 (already)', async () => {
    const created = await createGroup('测试群', { from: 'did:diap:a' });
    const j1 = await joinGroup(created.group!.link);
    expect(j1.ok).toBe(true);
    expect(j1.already).toBe(true); // 同节点创建的群, join 幂等
    expect(j1.group?.id).toBe(created.group?.id);
  });

  it('joinGroup 无效链接 → 错误', async () => {
    const r = await joinGroup('https://x/registry');
    expect(r.ok).toBe(false);
  });

  // ---------- 消息 ----------

  it('groupSend + groupMessages 消息广播与读回 (ts 排序)', async () => {
    const g = await createGroup('消息群');
    const id = g.group!.id;
    await groupSend(id, '第一条', 'alice');
    await new Promise((r) => setTimeout(r, 5));
    await groupSend(id, '第二条', 'bob');
    const msgs = await groupMessages(id);
    // 欢迎消息 + 2 条
    expect(msgs.length).toBe(3);
    expect(msgs[msgs.length - 1].text).toBe('第二条');
    expect(msgs[msgs.length - 1].from).toBe('bob');
  });

  it('groupMembers 从消息提取成员去重', async () => {
    const g = await createGroup('成员群');
    const id = g.group!.id;
    await groupSend(id, 'hi', 'alice');
    await groupSend(id, 'hello', 'bob');
    await groupSend(id, 'again', 'alice');
    const members = await groupMembers(id);
    expect(members).toContain('alice');
    expect(members).toContain('bob');
    // 去重: alice 只出现一次
    expect(members.filter((m) => m === 'alice').length).toBe(1);
  });

  it('groupInfo 返回成员数 + 消息数', async () => {
    const g = await createGroup('信息群', { from: 'did:diap:owner' });
    const id = g.group!.id;
    await groupSend(id, 'x', 'owner');
    const info = await groupInfo(id);
    expect(info?.name).toBe('信息群');
    expect(info?.messageCount).toBe(2); // 欢迎 + 1
    expect(info?.memberCount).toBeGreaterThanOrEqual(1);
  });

  it('groupSend 空消息 → 错误', async () => {
    const g = await createGroup('空消息群');
    const r = await groupSend(g.group!.id, '   ', 'x');
    expect(r.ok).toBe(false);
  });

  // ---------- 持久化 / 恢复 ----------

  it('restoreGroups 重启后恢复已加入群组', async () => {
    const g = await createGroup('恢复群');
    await groupSend(g.group!.id, '持久消息', 'alice');
    // 模拟重启: 清缓存 + 新 db 实例 (同一 fake db 有数据)
    resetGroupState();
    const r = await restoreGroups();
    expect(r.total).toBe(1);
    expect(r.restored).toBe(1);
    // 恢复后消息可读
    const msgs = await groupMessages(g.group!.id);
    expect(msgs.some((m) => m.text === '持久消息')).toBe(true);
  });

  it('listGroups 列出已加入群组', async () => {
    await createGroup('群A');
    await createGroup('群B');
    const groups = await listGroups();
    expect(groups.length).toBe(2);
  });

  // ── 2026-10-05 (leo): 群运营能力 —— 邀请/踢出/隐私/状态/链接 ──
  describe('群运营能力 (invite/kick/privacy/status/link)', () => {
    /** 造一个真 Ed25519 成员 (did 与 publicKeyHex 同一把钥匙), orbitdbId 造 66 位合法形状 */
    function mkMember(tag: string): { did: string; publicKeyHex: string; orbitdbId: string } {
      const kp = KeyManager.generate();
      return {
        did: kp.did,
        publicKeyHex: Buffer.from(kp.publicKey).toString('hex'),
        orbitdbId: '02' + crypto.createHash('sha256').update('orbitdb:' + tag).digest('hex'),
      };
    }

    const owner = mkMember('owner');

    async function createGated(name: string) {
      return createGroup(name, {
        gate: { owner, members: [{ did: owner.did, publicKeyHex: owner.publicKeyHex, orbitdbId: owner.orbitdbId }] },
      });
    }

    it('invite 把新成员加进白名单 (重建地址)', async () => {
      const r = await createGated('invite-me');
      expect(r.ok).toBe(true);
      const gid = r.group!.id;
      const beforeAddr = r.group!.address;

      const newbie = mkMember('newbie');
      const inv = await inviteMember(gid, newbie);
      expect(inv.ok).toBe(true);
      expect(inv.group!.address).not.toBe(beforeAddr); // 重建 ⇒ 换地址
      expect(inv.group!.aclWrite).toContain(newbie.orbitdbId);   // 新白名单含被邀请者
      expect(inv.group!.aclWrite).toContain(owner.orbitdbId); // 群主仍在
      expect(inv.costs && inv.costs.length).toBeGreaterThan(0); // 代价明示
    });

    it('kick 把成员移出白名单 (重建地址)', async () => {
      const r = await createGated('kick-me');
      expect(r.ok).toBe(true);
      const gid = r.group!.id;

      const bad = mkMember('bad');
      const inv = await inviteMember(gid, bad);
      expect(inv.ok).toBe(true);
      expect(inv.group!.aclWrite).toContain(bad.orbitdbId);

      const k = await kickMember(gid, bad.orbitdbId);
      expect(k.ok).toBe(true);
      expect(k.group!.aclWrite).not.toContain(bad.orbitdbId);
      expect(k.group!.aclWrite).toContain(owner.orbitdbId);
    });

    it('kick 白名单外成员 → 报错 (不假装踢了)', async () => {
      const r = await createGated('kick-absent');
      const ghost = mkMember('ghost');
      const k = await kickMember(r.group!.id, ghost.orbitdbId);
      expect(k.ok).toBe(false);
      expect(k.error).toMatch(/不在白名单/);
    });

    it('非门控群 invite → 明确说不适用 (开放群人人可写)', async () => {
      const r = await createGroup('open-invite', { acl: 'open' });
      expect(r.ok).toBe(true);
      const inv = await inviteMember(r.group!.id, owner);
      expect(inv.ok).toBe(false);
      expect(inv.error).toMatch(/不是门控群/);
    });

    it('privacy 标记开/关', async () => {
      const r = await createGroup('privacy-me');
      const gid = r.group!.id;
      // 建群默认隐私 (创建者独占写)
      const on = await setGroupPrivacy(gid, true);
      expect(on.ok).toBe(true);
      expect(on.group!.privacy).toBe(true);
      const off = await setGroupPrivacy(gid, false);
      expect(off.ok).toBe(true);
      expect(off.group!.privacy).toBe(false);
    });

    it('status 返回状态快照 (成员/消息/白名单/门控/隐私)', async () => {
      const r = await createGroup('status-me');
      const gid = r.group!.id;
      await groupSend(gid, 'hello status', 'did:key:z6Mktest');
      const s = await groupStatus(gid);
      expect(s.ok).toBe(true);
      expect(s.status!.gated).toBe(false);      // 默认创建者独占 (gated 由 gate 才设 true)
      expect(s.status!.privacy).toBe(true);     // 但 privacy 默认 true
      expect(typeof s.status!.messageCount).toBe('number');
      expect(s.status!.memberCount).toBeGreaterThan(0);
      expect(Array.isArray(s.status!.writeList)).toBe(true);
    });

    it('link 重取当前群链接', async () => {
      const r = await createGroup('link-me');
      const l = await groupLink(r.group!.id);
      expect(l).toMatch(/^orbitdb:\/\//);
      expect(l).toContain('type=group');
    });
  });
});
