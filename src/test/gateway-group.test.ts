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
});
