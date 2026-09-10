import { describe, it, expect, beforeEach } from 'vitest';
// 手机端 ↔ 电脑端 数据同步单测 (注入 fetch/storage, 不依赖浏览器)
import { getDesktopUrl, setDesktopUrl, syncFromDesktop, getLastSnapshot, getCachedJudgments, getSyncStatus } from '../web/mobile-sync.js';

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

const snapBody = (over: any = {}) => ({
  ok: true,
  ts: 1757300000000,
  source: 'desktop',
  active: { channelId: 'ch-1' },
  channels: [{ id: 'ch-1' }, { id: 'ch-2' }],
  judgments: [{ id: 'j1', type: 'quality', content: '先看假设', confidence: 0.9 }],
  services: [{ agentId: 'did:blln:abc' }],
  resources: [{ resourceId: 'r1' }],
  networks: [{ name: 'alpha' }],
  counts: { channels: 2, judgments: 1, services: 1, resources: 1, networks: 1 },
  ...over,
});

const fetchJson = (body: any, ok = true, status = 200): any => async () => ({ ok, status, json: async () => body });

describe('mobile-sync (手机端拉电脑端全量数据)', () => {
  beforeEach(() => { (globalThis as any).localStorage = memStorage(); });

  it('未配置电脑端地址 → 明确报错 (不静默)', async () => {
    const r = await syncFromDesktop();
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('电脑端地址');
  });

  it('配置地址 + 电脑端返回快照 → 落地本地 (counts/判断力/快照)', async () => {
    setDesktopUrl('http://192.168.1.5:7788');
    expect(getDesktopUrl()).toBe('http://192.168.1.5:7788');
    const r = await syncFromDesktop(undefined, { fetchImpl: fetchJson(snapBody()) });
    expect(r.ok).toBe(true);
    expect(r.counts?.channels).toBe(2);
    expect(r.ts).toBe(1757300000000);
    const snap: any = getLastSnapshot();
    expect(snap.counts.judgments).toBe(1);
    expect(snap.active.channelId).toBe('ch-1');
    expect(getCachedJudgments().length).toBe(1);
    expect(getCachedJudgments()[0].content).toBe('先看假设');
    expect(getSyncStatus().lastTs).toBe(1757300000000);
  });

  it('地址末尾斜杠被归一 (避免拼出 //api) + 顺带做 OrbitDB 复制', async () => {
    setDesktopUrl('http://10.0.0.9:7788///');
    expect(getDesktopUrl()).toBe('http://10.0.0.9:7788');
    const urls: string[] = [];
    const f: any = async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => snapBody() }; };
    const r = await syncFromDesktop(undefined, { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(urls[0]).toBe('http://10.0.0.9:7788/api/mobile/snapshot');
    // 快照之后自动跟随 OrbitDB 库级复制 (不再拼出 //api)
    expect(urls.some((u) => u.startsWith('http://10.0.0.9:7788/api/orbitdb/'))).toBe(true);
    expect(urls.every((u) => !u.includes('7788//'))).toBe(true);
    expect(r.orbit).toBeDefined();
  });

  it('网络异常 → ok:false 且保留上一次快照 (不清空本地)', async () => {
    setDesktopUrl('http://192.168.1.5:7788');
    await syncFromDesktop(undefined, { fetchImpl: fetchJson(snapBody()) });
    const before = getLastSnapshot();
    const boom: any = async () => { throw new Error('network down'); };
    const r = await syncFromDesktop(undefined, { fetchImpl: boom });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('network down');
    expect(getLastSnapshot()).toEqual(before);
    expect(getCachedJudgments().length).toBe(1);
  });

  it('电脑端返回非 200 → ok:false 带状态码', async () => {
    setDesktopUrl('http://192.168.1.5:7788');
    const r = await syncFromDesktop(undefined, { fetchImpl: fetchJson({}, false, 503) });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('503');
  });

  it('快照 ok:false → 视为失败, 不写本地', async () => {
    setDesktopUrl('http://192.168.1.5:7788');
    const r = await syncFromDesktop(undefined, { fetchImpl: fetchJson({ ok: false, error: 'registry 未就绪' }) });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('registry');
    expect(getLastSnapshot()).toBeNull();
  });
});
