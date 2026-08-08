import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { registryOpen, type DidCatalog } from '../storage/did-catalog.js';
import { startDidCatalogReplication, replicationStoreName } from '../orbitdb/did-catalog-replication.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';
import type { DscWalEvent } from '../storage/did-catalog.js';

const DID = 'did:key:z6MkRepTest123';
const tmpHome = path.join(os.tmpdir(), `bolloon-replication-test-${Date.now()}`);
let oldHome = '';

/** 内存版假 events store: 模拟 OrbitDB 事件流 (远端 peer 写 = 直接 add) */
class FakeEventsStore implements OrbitDBStore {
  readonly address = 'fake://did-wal';
  private events: DscWalEvent[] = [];
  private listeners: Array<() => void> = [];
  async put(_k: string, _v: unknown): Promise<void> { /* noop */ }
  async add(value: unknown): Promise<void> {
    this.events.push(value as DscWalEvent);
    this.fire();
  }
  async all(): Promise<Array<{ key: string; value: unknown }>> {
    return this.events.map((e, i) => ({ key: `ev${i}`, value: e }));
  }
  async get(_k: string): Promise<unknown> { return undefined; }
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }
  fire(): void { for (const f of this.listeners) { try { f(); } catch { /* ignore */ } } }
  get length(): number { return this.events.length; }
}

function fakeDb(store: FakeEventsStore): CIDDatabase {
  return { openStore: async () => store } as unknown as CIDDatabase;
}

/** 从磁盘读当前目录状态 (registryOpen 带 home 每次新建实例 → 读盘) */
async function readCatalog(): Promise<DidCatalog> {
  return registryOpen(DID, { home: tmpHome });
}

describe('did-catalog-replication (WAL 事件流 → OrbitDB 自动复制)', () => {
  let store: FakeEventsStore;

  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    await fs.mkdir(tmpHome, { recursive: true });
    store = new FakeEventsStore();
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('store 名按 DID 确定性派生', () => {
    expect(replicationStoreName(DID)).toContain('did-wal');
  });

  it('publishPending: 本地 WAL 事件增量发布到 OrbitDB 事件流', async () => {
    const cat = await readCatalog();
    await cat.upsert('memory', 'mem-1', { note: '第一条' });
    await cat.upsert('persona', 'p-1', { name: '小星' });
    await cat.persist(); // 落盘 → 复制模块的目录实例才能看到 WAL

    const rep = await startDidCatalogReplication(DID, { home: tmpHome, db: fakeDb(store), auto: false });
    // 启动即自动发布 (自动复制): 本地积压 WAL 已进事件流
    expect(store.length).toBe(2);

    // 事件流里是完整 WAL 事件 (did/table/op/key/row)
    const all = await store.all();
    const ev = all[0].value as DscWalEvent;
    expect(ev.did).toBe(DID);
    expect(ev.table).toBe('memory');
    expect(ev.op).toBe('upsert');
    expect((ev.row as any).note).toBe('第一条');

    // 再发布 → 无新事件 (游标已推进)
    expect(await rep.publishPending()).toBe(0);
    await rep.stop();
  });

  it('syncNow: OrbitDB 事件流里的远端事件 → syncRemote 合并进本地目录', async () => {
    // 模拟远端设备写入同 DID 的数据 (更高的 seq, 不同 key)
    await store.add({
      seq: 500, did: DID, table: 'memory', op: 'upsert', key: 'mem-remote',
      row: { dscKey: 'mem-remote', note: '远端记忆', updatedAt: Date.now(), deviceId: 'devB' },
      ts: Date.now(), deviceId: 'devB',
    } as DscWalEvent);

    const rep = await startDidCatalogReplication(DID, { home: tmpHome, db: fakeDb(store), auto: false });
    // 启动即自动拉取 (自动复制): 远端事件已合并进本地目录
    const cat = await readCatalog();
    const row = cat.get('memory', 'mem-remote');
    expect(row).toBeDefined();
    expect((row!.data as any).note).toBe('远端记忆');
    expect(row!.deviceId).toBe('devB');

    // 显式再 sync → 无新事件 (游标已推进, 幂等)
    const r2 = await rep.syncNow();
    expect(r2.applied + r2.merged).toBe(0);
    await rep.stop();
  });

  it('LWW: 远端旧事件不覆盖本地新数据 (merged)', async () => {
    // 本地已有较新数据
    const cat = await readCatalog();
    await cat.upsert('skills', 's-1', { name: '本地新版', updatedAt: Date.now() + 1000 });
    await cat.persist();

    const rep = await startDidCatalogReplication(DID, { home: tmpHome, db: fakeDb(store), auto: false });
    await rep.publishPending();

    // 远端发来更旧的版本
    await store.add({
      seq: 900, did: DID, table: 'skills', op: 'upsert', key: 's-1',
      row: { dscKey: 's-1', name: '远端旧版', updatedAt: Date.now() - 5000, deviceId: 'devB' },
      ts: Date.now() - 5000, deviceId: 'devB',
    } as DscWalEvent);

    const r = await rep.syncNow();
    expect(r.merged).toBeGreaterThanOrEqual(1); // 冲突 → 保留本地
    const after = await readCatalog();
    expect((after.get('skills', 's-1')!.data as any).name).toBe('本地新版');
    await rep.stop();
  });

  it('远端 delete 事件 → 本地行删除', async () => {
    const cat = await readCatalog();
    await cat.upsert('memory', 'to-delete', { v: 1 });
    await cat.persist();

    const rep = await startDidCatalogReplication(DID, { home: tmpHome, db: fakeDb(store), auto: false });
    await rep.publishPending();
    await store.add({
      seq: 1000, did: DID, table: 'memory', op: 'delete', key: 'to-delete',
      row: null, ts: Date.now() + 100, deviceId: 'devB',
    } as DscWalEvent);
    await rep.syncNow();

    const after = await readCatalog();
    expect(after.get('memory', 'to-delete')).toBeUndefined();
    await rep.stop();
  });
});
