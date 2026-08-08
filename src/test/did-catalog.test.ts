import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DidCatalog, createDidCatalogRegistry, didDirName } from '../storage/did-catalog.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-did-catalog-test-${Date.now()}`);
const tmpHome2 = path.join(os.tmpdir(), `bolloon-did-catalog-test2-${Date.now()}`);
let oldHome = '';

describe('did-catalog (Postgres 式 DID 主键 + 多设备同步)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    await fs.mkdir(tmpHome, { recursive: true });
    await fs.mkdir(tmpHome2, { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpHome2, { recursive: true, force: true });
  });

  it('didDirName 取 DID 后缀做目录片段', () => {
    expect(didDirName('did:key:z6MkABC')).toContain('z6MkABC');
    expect(didDirName('')).toBe('unknown');
  });

  it('以 did 分区落盘, upsert/get/all/where/persist 闭环', async () => {
    const c = new DidCatalog('did:key:AAA', { home: tmpHome, deviceId: 'devA' });
    await c.load();
    await c.upsert('memory', 'mem-1', { title: 'hello', body: 'world' });
    await c.upsert('persona', 'p-1', { name: 'bolloon' });
    await c.persist();

    // 目录按 did 分区
    expect(c.rootPath).toContain('did-catalog');
    expect(c.rootPath).toContain(didDirName('did:key:AAA'));

    // 重新加载持久化可见
    const c2 = new DidCatalog('did:key:AAA', { home: tmpHome });
    await c2.load();
    expect(c2.get('memory', 'mem-1')!.data.title).toBe('hello');
    expect(c2.all('persona')).toHaveLength(1);

    // where 过滤
    const rows = c2.where('memory', 'title', 'hello');
    expect(rows).toHaveLength(1);
    expect(rows[0].data.body).toBe('world');

    // remove
    await c2.remove('memory', 'mem-1');
    await c2.persist();
    const c3 = new DidCatalog('did:key:AAA', { home: tmpHome });
    await c3.load();
    expect(c3.get('memory', 'mem-1')).toBeUndefined();
  });

  it('不同 DID 互不干扰', async () => {
    const a = new DidCatalog('did:key:AAA', { home: tmpHome });
    const b = new DidCatalog('did:key:BBB', { home: tmpHome });
    await a.load();
    await b.load();
    await a.upsert('skills', 's1', { name: 'skill-a' });
    await b.upsert('skills', 's1', { name: 'skill-b' });
    expect(a.get('skills', 's1')!.data.name).toBe('skill-a');
    expect(b.get('skills', 's1')!.data.name).toBe('skill-b');
  });

  it('多设备同步: 设备B 拉取设备A 的 WAL 回放合并 (LWW)', async () => {
    const devA = new DidCatalog('did:key:SYNC', { home: tmpHome, deviceId: 'devA' });
    const devB = new DidCatalog('did:key:SYNC', { home: tmpHome2, deviceId: 'devB' });
    await devA.load();
    await devB.load();

    // devA 新增两条
    await devA.upsert('memory', 'm1', { title: '从A来' });
    await devA.upsert('on_policy', 'pol-1', { version: 1, allowlist: ['ls'] });
    const walA = devA.walEvents;

    // 设备 B → 拉取 A 的 WAL → 合并
    const r = devB.syncRemote(walA);
    expect(r.applied).toBe(2);
    expect(devB.get('memory', 'm1')!.data.title).toBe('从A来');
    expect(devB.get('on_policy', 'pol-1')!.data.version).toBe(1);

    // B 持久化后再加载仍可见 (模拟 B 重启后恢复)
    await devB.persist();
    const devB2 = new DidCatalog('did:key:SYNC', { home: tmpHome2 });
    await devB2.load();
    expect(devB2.get('memory', 'm1')!.data.title).toBe('从A来');
  });

  it('LWW 冲突: 本地较新保留本地, 远端较新覆盖', async () => {
    const devA = new DidCatalog('did:key:LWW', { home: tmpHome, deviceId: 'devA' });
    await devA.load();
    await devA.upsert('skills', 'k', { name: 'old', updatedAt: 100 });
    await devA.persist();

    const devB = new DidCatalog('did:key:LWW', { home: tmpHome2, deviceId: 'devB' });
    await devB.load();
    // 本地先有 {name:'local'} (updatedAt ≈ now) → 远端 ts 更老 → 保留本地 (merged)
    await devB.upsert('skills', 'k', { name: 'local', ts: 0 });
    const oldRemoteTs = Date.now() - 60_000; // 1 分钟前
    const r1 = devB.syncRemote([{ seq: 1, did: 'did:key:LWW', table: 'skills', op: 'upsert', key: 'k', row: { name: 'old' } as any, ts: oldRemoteTs, deviceId: 'x' }]);
    expect(r1.merged).toBe(1);
    expect(devB.get('skills', 'k')!.data.name).toBe('local');
    // 远端 ts 更新 → 覆盖
    const newRemoteTs = Date.now() + 60_000; // 1 分钟后
    const r2 = devB.syncRemote([{ seq: 2, did: 'did:key:LWW', table: 'skills', op: 'upsert', key: 'k', row: { name: 'new' } as any, ts: newRemoteTs, deviceId: 'x' }]);
    expect(r2.applied).toBe(1);
    expect(devB.get('skills', 'k')!.data.name).toBe('new');
  });

  it('registry.open 同 DID 复用实例', async () => {
    const reg = createDidCatalogRegistry({ home: tmpHome, deviceId: 'devR' });
    const c1 = await reg.open('did:key:CCC');
    await c1.upsert('memory', 'r1', { v: 1 });
    const c2 = await reg.open('did:key:CCC');
    expect(c2.get('memory', 'r1')).toBeDefined();
    await reg.persistAll();
  });
});