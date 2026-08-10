/**
 * system-prompt health (P-Action 2) — Harness Gardening 状态扫描测试
 *
 * 覆盖:
 *   - evaluateLayer: 4 个 health 状态 (ok / stale / overdue-review / missing-frontmatter)
 *   - evaluateLayers: 整组扫描 + 汇总
 *   - markActive: active 标记
 *   - 端到端: frontmatter 解析 + 默认值 + 集成 registry
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateLayer,
  evaluateLayers,
  markActive,
  type LayerHealthEntry,
} from '../llm/system-prompt/health.js';
import type { PromptLayer, SectionMeta } from '../llm/system-prompt/registry.js';
import { listLayers, assembleSystemPrompt } from '../llm/system-prompt/registry.js';

function makeLayer(overrides: Partial<PromptLayer> = {}): PromptLayer {
  return {
    id: 'test.layer',
    version: '1.0.0',
    priority: 100,
    appliesTo: ['all'],
    source: 'static-md',
    maxChars: 1000,
    ...overrides,
  } as PromptLayer;
}

function makeMeta(overrides: Partial<SectionMeta> = {}): SectionMeta {
  return {
    addedAt: '2026-01-01T00:00:00Z',
    lastReviewedAt: '2026-06-15T00:00:00Z',
    ttlDays: 365,
    author: 'yuanjie',
    ...overrides,
  };
}

describe('evaluateLayer — 4 健康状态', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('ok: 剩余天数 > 20% ttl', () => {
    // ttl 365, reviewed 30 天前 → remaining 335 → 335/365 = 91% > 20% → ok
    const l = makeLayer({ meta: makeMeta({ lastReviewedAt: '2026-05-15T00:00:00Z' }) });
    const r = evaluateLayer(l, now);
    expect(r.health).toBe('ok');
    expect(r.ageDays).toBe(31);
    expect(r.remainingDays).toBe(334);
  });

  it('stale: 剩余天数 < 20% ttl 但 >= 0', () => {
    // ttl 90, reviewed 80 天前 → remaining 10 → 10/90 = 11% < 20% → stale
    const l = makeLayer({ meta: makeMeta({ ttlDays: 90, lastReviewedAt: '2026-03-27T00:00:00Z' }) });
    const r = evaluateLayer(l, now);
    expect(r.health).toBe('stale');
    expect(r.remainingDays).toBe(10);
  });

  it('overdue-review: 剩余 < 0', () => {
    // ttl 90, reviewed 100 天前 → remaining -10 → overdue
    const l = makeLayer({ meta: makeMeta({ ttlDays: 90, lastReviewedAt: '2026-03-07T00:00:00Z' }) });
    const r = evaluateLayer(l, now);
    expect(r.health).toBe('overdue-review');
    expect(r.remainingDays).toBe(-10);
  });

  it('missing-frontmatter: 无 meta', () => {
    const l = makeLayer({ id: 'test.no-meta' });
    const r = evaluateLayer(l, now);
    expect(r.health).toBe('missing-frontmatter');
    expect(r.author).toBeNull();
    expect(r.lastReviewedAt).toBeNull();
  });

  it('missing-frontmatter: meta.lastReviewedAt 无效', () => {
    const l = makeLayer({ meta: makeMeta({ lastReviewedAt: 'not-a-date' }) });
    const r = evaluateLayer(l, now);
    expect(r.health).toBe('missing-frontmatter');
  });

  it('dynamic: source=function 视为 runtime-managed', () => {
    const l = makeLayer({ id: 'test.dyn', source: 'function', resolver: () => '' });
    const r = evaluateLayer(l, now);
    expect(r.health).toBe('dynamic');
    expect(r.ttlDays).toBe(-1);
  });
});

describe('evaluateLayers — 整组汇总', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('汇总 counts 正确', () => {
    const layers: PromptLayer[] = [
      makeLayer({ id: 'a', meta: makeMeta({ lastReviewedAt: '2026-05-15T00:00:00Z' }) }),  // ok
      makeLayer({ id: 'b', meta: makeMeta({ ttlDays: 90, lastReviewedAt: '2026-03-27T00:00:00Z' }) }),  // stale
      makeLayer({ id: 'c', meta: makeMeta({ ttlDays: 90, lastReviewedAt: '2026-03-07T00:00:00Z' }) }),  // overdue
      makeLayer({ id: 'd' }),  // missing
      makeLayer({ id: 'e', source: 'function', resolver: () => '' }),  // dynamic
    ];
    const r = evaluateLayers(layers, now);
    expect(r.total).toBe(5);
    expect(r.okCount).toBe(1);
    expect(r.staleCount).toBe(1);
    expect(r.overdueCount).toBe(1);
    expect(r.missingCount).toBe(1);
    expect(r.dynamicCount).toBe(1);
    expect(r.entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('markActive', () => {
  it('根据 activeIds 标 active', () => {
    const layers: PromptLayer[] = [
      makeLayer({ id: 'a', meta: makeMeta() }),
      makeLayer({ id: 'b', meta: makeMeta() }),
    ];
    const base = evaluateLayers(layers);
    const r = markActive(base, new Set(['a']));
    expect(r.entries.find((e) => e.id === 'a')!.active).toBe(true);
    expect(r.entries.find((e) => e.id === 'b')!.active).toBe(false);
  });
});

describe('端到端: 真实 registry + health', () => {
  it('listLayers 26 个 layer 都能 evaluate, 不抛错', () => {
    const all = listLayers() as Array<any>;
    expect(all.length).toBeGreaterThanOrEqual(16);  // 至少 16 个静态 + dynamic
    const r = evaluateLayers(all);
    expect(r.entries.length).toBe(all.length);
    // 全部有 meta (我们刚刚 backfill 过了) 或 dynamic
    for (const e of r.entries) {
      expect(['ok', 'stale', 'overdue-review', 'missing-frontmatter', 'dynamic']).toContain(e.health);
    }
  });

  it('assembleSystemPrompt 返回的 layerIds 能 markActive', async () => {
    // 2026-08-10: assembleSystemPrompt 含 HumanValueStore 等 dynamic resolver 初始化,
    //   实测 8.7s (~/.bolloon 产物增多后变慢) — 默认 5s 超时太紧, 这是功能测试非性能测试
    const r = await assembleSystemPrompt({ channel: 'local' });
    const all = listLayers() as Array<any>;
    const base = evaluateLayers(all);
    const activeIds = new Set(r.layerIds);
    const marked = markActive(base, activeIds);
    // 至少有一个 active (assemble 应该会拼入一些 core + channel.local)
    const activeCount = marked.entries.filter((e) => e.active).length;
    expect(activeCount).toBeGreaterThan(0);
    // total chars 跟 assemble 返回的一致
    expect(r.totalChars).toBeGreaterThan(0);
  }, 15000);
});
