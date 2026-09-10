import { describe, it, expect, beforeEach } from 'vitest';
// 手机端 OrbitDB 本地副本 (库级复制 + 双向 merge) 单测 — 注入 fetch/storage, 不依赖浏览器
import {
  stableJson, hashValue, valueTs, remoteWins, mergeStore,
  getReplica, replicaPut, replicaAll, replicaGet, replicaStats,
  listDesktopStores, replicateStore, replicateAll,
} from '../web/mobile-orbit.js';
import type { ReplicaEntry } from '../web/mobile-orbit.js';

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as any;
}

const ent = (value: any, ts: number): ReplicaEntry => ({ value, hash: hashValue(value), ts });

/** 模拟电脑端: GET /entries 返回 remote; POST /merge 收集到 sink */
function deskFetch(remote: any[], sink: { name?: string; entries: any[] }[], address = 'orbitdb://test/store') {
  return (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('/api/orbitdb/stores')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, stores: [{ name: 'bolloon-cid-store', address }] }) };
    }
    if (u.includes('/api/orbitdb/entries')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, address, entries: remote, count: remote.length }) };
    }
    if (u.includes('/api/orbitdb/merge')) {
      const b = JSON.parse(init.body);
      sink.push({ name: b.name, entries: b.entries });
      return { ok: true, status: 200, json: async () => ({ ok: true, written: b.entries.length }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as any;
}

describe('mobile-orbit (手机端 OrbitDB 本地副本)', () => {
  beforeEach(() => { (globalThis as any).localStorage = memStorage(); });

  it('stableJson/hashValue 与键序无关, 内容变哈希变', () => {
    expect(stableJson({ a: 1, b: [2, { c: 3 }] })).toBe(stableJson({ b: [2, { c: 3 }], a: 1 }));
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it('valueTs 识别 updatedAt/timestamp/ts/ISO 串', () => {
    expect(valueTs({ updatedAt: 100 })).toBe(100);
    expect(valueTs({ timestamp: 200 })).toBe(200);
    expect(valueTs({ ts: 300 })).toBe(300);
    expect(valueTs({ updatedAt: '2026-01-02T03:04:05.000Z' })).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(valueTs({ nothing: 1 })).toBe(0);
  });

  it('mergeStore: 空本地 + 远端 → 全部落地, 无需推回', () => {
    const r = mergeStore({}, [{ key: 'k1', value: { v: 'a' } }, { key: 'k2', value: { v: 'b' } }]);
    expect(Object.keys(r.merged).length).toBe(2);
    expect(r.applied).toBe(2);
    expect(r.pushed.length).toBe(0);
  });

  it('mergeStore 时间戳大者胜 (远端更新 → 覆盖本地)', () => {
    const local = { k: ent({ v: 'old', updatedAt: 1 }, 1) };
    const r = mergeStore(local, [{ key: 'k', value: { v: 'new', updatedAt: 2 } }]);
    expect(r.merged.k.value.v).toBe('new');
    expect(r.applied).toBe(1);
    expect(r.pushed.length).toBe(0);
    // 本地更新 → 保留本地并推回
    const r2 = mergeStore({ k: ent({ v: 'newer', updatedAt: 9 }, 9) }, [{ key: 'k', value: { v: 'old', updatedAt: 2 } }]);
    expect(r2.merged.k.value.v).toBe('newer');
    expect(r2.pushed.map((p) => p.key)).toEqual(['k']);
  });

  it('★ 收敛性: 两端各自合并必得同一结果 (含冲突, 顺序无关)', () => {
    const a = { v: 'A', updatedAt: 100 };
    const b = { v: 'B', updatedAt: 200 };
    // 端1: 本地 A, 收到 B   端2: 本地 B, 收到 A
    const r1 = mergeStore({ k: ent(a, 100) }, [{ key: 'k', value: b }]);
    const r2 = mergeStore({ k: ent(b, 200) }, [{ key: 'k', value: a }]);
    expect(r1.merged.k.value).toEqual(r2.merged.k.value);
    expect(r1.merged.k.value.v).toBe('B');
    // 时间戳相同 → 哈希序大者胜, 依然收敛
    const c = { v: 'C', updatedAt: 300 };
    const d = { v: 'D', updatedAt: 300 };
    const s1 = mergeStore({ k: ent(c, 300) }, [{ key: 'k', value: d }]);
    const s2 = mergeStore({ k: ent(d, 300) }, [{ key: 'k', value: c }]);
    expect(s1.merged.k.value).toEqual(s2.merged.k.value);
  });

  it('remoteWins: 相同哈希 → 不覆盖 (避免无意义写)', () => {
    const v = { v: 'x', updatedAt: 5 };
    expect(remoteWins(ent(v, 5), v, hashValue(v))).toBe(false);
  });

  it('replicaPut 本地写 (离线可写) → 可读回, 计入统计', () => {
    replicaPut('store-A', 'k1', { v: 'offline', updatedAt: 7 });
    expect(replicaGet('store-A', 'k1').v).toBe('offline');
    expect(replicaAll('store-A').length).toBe(1);
    expect(replicaStats().names).toContain('store-A');
    expect(replicaStats().entries).toBe(1);
  });

  it('replicateStore: 拉远端 → 合并落地 → 本地独有条目推回', async () => {
    replicaPut('bolloon-cid-store', 'local-only', { v: 'phone', updatedAt: 50 });
    const sink: any[] = [];
    const remote = [{ key: 'r1', value: { v: 'desk', updatedAt: 1 } }];
    const r = await replicateStore('bolloon-cid-store', { baseUrl: 'http://d:1', fetchImpl: deskFetch(remote, sink) });
    expect(r.ok).toBe(true);
    expect(r.pulled).toBe(1);
    expect(r.pushed).toBe(1);
    expect(r.total).toBe(2);
    expect(Object.keys(getReplica('bolloon-cid-store').entries).sort()).toEqual(['local-only', 'r1']);
    expect(sink.length).toBe(1);
    expect(sink[0].entries[0].key).toBe('local-only');
  });

  it('replicateStore 幂等: 第二次同步不再推回 (哈希一致)', async () => {
    replicaPut('s1', 'k', { v: 'x', updatedAt: 1 });
    const sink: any[] = [];
    const remote: any[] = [];
    const f = deskFetch(remote, sink);
    await replicateStore('s1', { baseUrl: 'http://d:1', fetchImpl: f });
    expect(sink.length).toBe(1);
    // 电脑端已收到 → 第二次同步: 远端仍为空列表 (mock 不回声) 但哈希一致判定走 merged 本地 → 仍会推
    // 真实电脑端在 put 后 entries 会回声; 这里验证"推回后再拉一次, 内容一致则不再产生新写入"
    remote.push({ key: 'k', value: { v: 'x', updatedAt: 1 } });
    const r2 = await replicateStore('s1', { baseUrl: 'http://d:1', fetchImpl: f });
    expect(r2.ok).toBe(true);
    expect(r2.pushed).toBe(0);
    expect(sink.length).toBe(1);
  });

  it('replicateAll: 按电脑端 store 列表逐个复制, 本地已有副本也纳入', async () => {
    replicaPut('old-store', 'k', { v: 'y' });
    const sink: any[] = [];
    const remote = [{ key: 'k', value: { v: 'z', updatedAt: 999 } }];
    const r = await replicateAll({ baseUrl: 'http://d:1', fetchImpl: deskFetch(remote, sink) });
    expect(r.ok).toBe(true);
    expect(r.stores).toBe(2); // bolloon-cid-store + old-store
    expect(replicaStats().stores).toBe(2);
  });

  it('未配置地址 → 明确报错', async () => {
    const r = await replicateAll({ fetchImpl: deskFetch([], []) });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('电脑端地址');
    const l = await listDesktopStores({ fetchImpl: deskFetch([], []) });
    expect(l.ok).toBe(false);
    expect(l.stores.length).toBe(0);
  });
});
