/**
 * task-store.test.ts — 2026-08-12 (Task6)
 *
 * Task 队列的 OrbitDB 主存储: OrbitDBTaskStore + 惰性 fallback.
 * 用 mock CIDDatabase (假 OrbitDB store) 验证:
 *   - warm 后 ready + storeName 确定性
 *   - saveTasks/loadTasks 走 orbit
 *   - 未 warm (ready=false) 时 load/save 返回 null/false (调用方 fallback 本地)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrbitDBTaskStore,
  taskStoreName,
  resetTaskOrbitStore,
} from '../orbitdb/task-store.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

/** 内存假 OrbitDB store */
function makeFakeStore(): OrbitDBStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    address: '/orbitdb/zbfake',
    data,
    put: async (k, v) => { data.set(k, v); },
    add: async () => {},
    all: async () => Array.from(data.entries()).map(([key, value]) => ({ key, value })),
    get: async (k) => data.get(k) ?? null,
    onChange: () => () => {},
  };
}

function makeFakeDB(store: OrbitDBStore): CIDDatabase {
  return {
    save: async (d) => ({ id: 'cid', agentId: d.agentId, timestamp: 0, type: d.type, content: d.content, metadata: {}, version: 1 }),
    load: async () => null,
    update: async () => null,
    version: async () => [],
    list: async () => [],
    share: async (c) => `bolloon-cid://${c}`,
    openStore: async (name, type) => store,
    close: async () => {},
  };
}

describe('task-store (OrbitDB 任务主存储)', () => {
  beforeEach(() => { resetTaskOrbitStore(); });

  it('taskStoreName 确定性 (跨设备同名)', () => {
    expect(taskStoreName('did:key:zABC')).toMatch(/^bolloon-tasks-/);
    expect(taskStoreName('did:key:zABC')).toBe(taskStoreName('did:key:zABC'));
  });

  it('warm 后 ready=true, saveTasks/loadTasks 走 orbit', async () => {
    const fakeStore = makeFakeStore();
    const store = new OrbitDBTaskStore('did:key:zT', makeFakeDB(fakeStore));
    const ok = await store.warm();
    expect(ok).toBe(true);
    expect(store.ready).toBe(true);
    const tasks = [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }];
    const saved = await store.saveTasks(tasks);
    expect(saved).toBe(true);
    const loaded = await store.loadTasks();
    expect(loaded).toEqual(tasks);
  });

  it('未 warm (ready=false) 时 saveTasks/loadTasks 返回 false/null (调用方 fallback 本地)', async () => {
    const fakeStore = makeFakeStore();
    const store = new OrbitDBTaskStore('did:key:zT', makeFakeDB(fakeStore));
    // 不调 warm → ready=false
    expect(store.ready).toBe(false);
    expect(await store.loadTasks()).toBeNull();
    expect(await store.saveTasks([{ id: 'x' }])).toBe(false);
  });

  it('orbit openStore 抛错时 warm 返回 false (静默回退)', async () => {
    const badDB: CIDDatabase = makeFakeDB(makeFakeStore());
    badDB.openStore = async () => { throw new Error('orbit 不可用'); };
    const store = new OrbitDBTaskStore('did:key:zT', badDB);
    const ok = await store.warm();
    expect(ok).toBe(false);
    expect(store.ready).toBe(false);
    expect(await store.loadTasks()).toBeNull();
  });
});
