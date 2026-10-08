/**
 * 手机端原生 OrbitDB 验证 (2026-10-07)
 * 模拟浏览器: 建真 helia 节点 (SDK) + @orbitdb/core 内存 store → put/get
 * 证明手机端可以跑真 OrbitDB (不再是电脑端副本同步)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

// Node/vitest 无真实 localStorage → 用内存 polyfill (真浏览器是原生 localStorage)
const memStore = new Map<string, string>();
const fakeLS = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, v); },
  removeItem: (k: string) => { memStore.delete(k); },
};
(globalThis as any).window = { localStorage: fakeLS };
(globalThis as any).localStorage = fakeLS;
(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');

describe('手机端原生 OrbitDB (mobile-orbitdb)', () => {
  beforeEach(async () => {
    // 清掉上个测试的残留实例 (模块级 _orbit/_node), 避免状态串扰
    const orbit = await import('../web/mobile-orbitdb.ts');
    await orbit.stopMobileOrbitDB().catch(() => {});
    orbit.resetMobileOrbitDB();
  });

  it('kvstore + documents 全链路 (单节点顺序跑, 绕开 helia 单例)', async () => {
    const helia = await import('../web/mobile-helia.ts');
    const orbit = await import('../web/mobile-orbitdb.ts');

    // ── kvstore ──
    const odb = await orbit.createMobileOrbitDBWithPubsub(helia);
    expect(odb.ok, JSON.stringify(odb.error)).toBe(true);
    expect(odb.orbit).toBeTruthy();
    expect(odb.node).toBeTruthy();

    const store = await orbit.openStore('mobile-test-kv', 'keyvalue');
    expect(store.ok, JSON.stringify(store.error)).toBe(true);

    const putR = await orbit.kvPut(store.store, 'hello', { world: 1, ts: Date.now() });
    expect(putR.ok).toBe(true);
    const getR = await orbit.kvGet(store.store, 'hello');
    expect(getR.ok).toBe(true);
    expect((getR.value as any).world).toBe(1);

    const allR = await orbit.kvAll(store.store);
    expect(allR.ok).toBe(true);
    expect(Object.keys(allR.entries || {})).toContain('hello');
    // 地址是 orbitdb 格式 (@orbitdb/core 4.x: /orbitdb/<hash>)
    expect(String(store.store.address)).toMatch(/^\/orbitdb\//);

    // ── documents (同一节点) ──
    const docStore = await orbit.openStore('mobile-test-docs', 'documents', { indexBy: 'name' });
    expect(docStore.ok, JSON.stringify(docStore.error)).toBe(true);
    await docStore.store.put({ _id: 'd1', name: 'alice', role: 'agent' });
    // documents 查询可能需要等索引异步更新
    await new Promise((r) => setTimeout(r, 500));
    const found = await orbit.docQuery(docStore.store, { name: 'alice' });
    expect(found.ok).toBe(true);
    expect((found.results || []).length).toBeGreaterThan(0);

    await orbit.stopMobileOrbitDB();
    await odb.node?.stop?.().catch?.(() => {});
  }, 90000);
});
