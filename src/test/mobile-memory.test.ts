/**
 * mobile-memory.test.ts — 手机原生记忆内核 (2026-10-16)
 *
 * 覆盖 (leo 点名清单的手机侧落点):
 *   · memory 设计迭代: remember / recall / autoIterate (偏好/约定/关系)
 *   · 人际关系分类: relation kind (family/work/friend/acquaintance/stranger) + 信任度合并
 *   · TTL/decay: 过期条目标记 decayed, 固化条目豁免
 *   · 快照: snapshot / restore (bootstrap 合并, 不覆盖已有)
 *   · 指纹: fingerprint 稳定, 记忆变 → 指纹变
 *   · 缓存: MobileCache get/set/TTL 过期
 */
import { describe, it, expect, beforeEach } from 'vitest';

class FakeLS {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  get length() { return this.m.size; }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  (globalThis as any).localStorage = new FakeLS();
});

describe('mobile-memory (手机原生记忆内核)', () => {
  it('remember: 落库 + 幂等覆盖 (同内容同 id)', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m = new MobileMemory('did:key:test');
    const e1 = m.remember({ content: '用户喜欢清晨写代码', kind: 'preference' });
    const e2 = m.remember({ content: '用户喜欢清晨写代码', kind: 'preference' });
    expect(e1.id).toBe(e2.id);
    expect(m.all().length).toBe(1);
    expect(e1.importance).toBeGreaterThan(0.3); // 含「喜欢」信号词 → 加分
  });

  it('人际关系分类: 文本 → family/work/friend + 信任度合并', async () => {
    const { MobileMemory, classifyRelation } = await import('../web/mobile-memory.js');
    expect(classifyRelation('我妈妈是老师')).toBe('family');
    expect(classifyRelation('张总是我的客户')).toBe('work');
    expect(classifyRelation('李雷是我的朋友')).toBe('friend');
    expect(classifyRelation('来源 directory', 'phone-directory')).toBe('acquaintance');
    expect(classifyRelation('随便什么')).toBe('stranger');

    const m = new MobileMemory('did:key:test');
    m.remember({ content: '王芳 是朋友', kind: 'relationship', relation: { did: 'did:key:wang', kind: 'friend', trust: 0.4 } });
    // 二次提及 → 信任度平均上移 + 分类保持
    m.remember({ content: '王芳 是朋友', kind: 'relationship', relation: { did: 'did:key:wang', kind: 'friend', trust: 0.8 } });
    const rel = m.all().find((e) => e.kind === 'relationship');
    expect(rel).toBeDefined();
    expect(rel!.relation!.kind).toBe('friend');
    expect(rel!.relation!.trust).toBeCloseTo(0.6); // (0.4+0.8)/2
  });

  it('recall: 关键词命中 + importance 加权 + 多次召回固化', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m = new MobileMemory('did:key:test');
    m.remember({ content: '公司项目叫 Bolloon', kind: 'fact', importance: 0.9 });
    m.remember({ content: '猫叫咪咪', kind: 'fact', importance: 0.3 });
    const hits = m.recall('Bolloon 项目', { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('Bolloon');
    // 多次召回 → crystallized (固化, 不 decay)
    for (let i = 0; i < 3; i++) m.recall('Bolloon');
    const b = m.all().find((e) => e.content.includes('Bolloon'));
    expect(b!.crystallized).toBe(true);
  });

  it('TTL/decay: 过期条目标记 decayed, 固化条目豁免', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m = new MobileMemory('did:key:test');
    m.remember({ content: '临时事件 A', kind: 'event', ttlMs: 1, importance: 0.5 });
    m.remember({ content: '永久事实 B', kind: 'fact', importance: 0.8 });
    m.all().find((e) => e.content.includes('永久'))!.crystallized = true;
    m.applyTtl(new Date(Date.now() + 5000).toISOString());
    const evt = m.all().find((e) => e.content.includes('临时'));
    const fact = m.all().find((e) => e.content.includes('永久'));
    expect(evt!.decayed).toBe(true);
    expect(fact!.decayed).toBe(false); // 固化豁免
  });

  it('autoIterate: 从文本提炼偏好/约定/关系 (记忆迭代)', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m = new MobileMemory('did:key:test');
    const n = m.autoIterate({ goal: '帮我安排行程', toolResults: [], reply: '好的,我记住了: 用户喜欢午休, 张三是我的同事, 不要在工作时间打扰。' });
    expect(n).toBeGreaterThan(0);
    const kinds = m.all().map((e) => e.kind);
    expect(kinds).toContain('preference');
    expect(kinds).toContain('insight');
    expect(kinds).toContain('relationship');
  });

  it('快照/restore: bootstrap 恢复合并, 不覆盖已有', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m1 = new MobileMemory('did:key:t');
    m1.remember({ content: '旧记忆 X', kind: 'fact' });
    const snap = m1.snapshot();
    const m2 = new MobileMemory('did:key:t');
    m2.remember({ content: '新记忆 Y', kind: 'fact' });
    m2.restore(snap);
    expect(m2.all().length).toBe(2);
  });

  it('指纹: 稳定 + 记忆变则变', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m = new MobileMemory('did:key:t');
    m.remember({ content: '喜欢早起', kind: 'fact' });
    const fp1 = m.fingerprint();
    const fp2 = m.fingerprint();
    expect(fp1).toBe(fp2);
    m.remember({ content: '讨厌熬夜', kind: 'fact' });
    expect(m.fingerprint()).not.toBe(fp1);
  });

  it('稳定记忆块 stableBlock: 固化优先 + importance 降序 + 上限 + 空安全', async () => {
    const { MobileMemory } = await import('../web/mobile-memory.js');
    const m = new MobileMemory('did:key:t');
    expect(m.stableBlock(6)).toBe(''); // 空库 → 空块
    m.remember({ content: '低权重事实', kind: 'fact', importance: 0.2 });
    m.remember({ content: '高权重事实', kind: 'fact', importance: 0.9 });
    m.remember({ content: '固化条目', kind: 'fact', importance: 0.5 });
    m.all().find((e) => e.content.includes('固化'))!.crystallized = true;
    m.remember({ content: '淡化条目', kind: 'event', importance: 0.9, ttlMs: 1 });
    m.applyTtl(new Date(Date.now() + 5000).toISOString());
    const block = m.stableBlock(6);
    expect(block).toContain('<stable-memory>');
    // 固化位列第一
    const lines = block.split('\n');
    expect(lines[1]).toContain('固化条目');
    // 淡化条目不入选
    expect(block).not.toContain('淡化条目');
    // 上限: 只留 maxEntries 条
    const b2 = m.stableBlock(2);
    expect(b2.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2);
    // fingerprint 不因 stableBlock 改变自身稳定性
    expect(m.fingerprint()).toBe(m.fingerprint());
  });

  it('MobileCache: 命中 / TTL 过期 miss', async () => {
    const { MobileCache } = await import('../web/mobile-memory.js');
    const c = new MobileCache('test');
    c.set('k', { x: 1 });
    expect(c.get('k', 60_000)).toEqual({ x: 1 });
    // 过期 (写一个假的旧时间戳)
    c.set('k2', { y: 2 });
    (globalThis as any).localStorage.setItem('test_k2', JSON.stringify({ v: { y: 2 }, at: Date.now() - 120_000 }));
    expect(c.get('k2', 60_000)).toBeNull();
  });
});