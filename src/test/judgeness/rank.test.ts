import { describe, it, expect } from 'vitest';
import {
  computeRecency,
  computeBreadth,
  computeDepth,
  rankDescriptions,
  DEFAULT_RANK_WEIGHTS,
} from '../../judgeness/rank.js';
import type { JudgenessDescription } from '../../judgeness/types.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

const make = (over: Partial<JudgenessDescription>): JudgenessDescription => ({
  descriptionId: 'jd-rk-1',
  judgmentRef: 'hv-rk',
  description_version: 1,
  facets: {},
  basis: {},
  scope: { topics: [], domains: [] },
  visibility: 'public',
  openState: 'open',
  by: 'human',
  createdAt: '2026-07-15T12:00:00.000Z',
  updatedAt: '2026-07-15T12:00:00.000Z',
  ...over,
});

describe('judgeness rank — 可解释因子', () => {
  it('recency 在 30 天内 → 越高越好', () => {
    const now5 = NOW;
    const r1 = computeRecency(make({ createdAt: new Date(now5 - 0).toISOString() }), NOW, 30 * 24 * 3600 * 1000);
    const r2 = computeRecency(make({ createdAt: new Date(now5 - 15 * 24 * 3600 * 1000).toISOString() }), NOW, 30 * 24 * 3600 * 1000);
    expect(r1).toBeGreaterThan(r2);
  });

  it('recency 超过 30 天 → 0', () => {
    const old = make({ createdAt: new Date(NOW - 100 * 24 * 3600 * 1000).toISOString() });
    expect(computeRecency(old, NOW, 30 * 24 * 3600 * 1000)).toBe(0);
  });

  it('breadth: topic 数 3 → 满分', () => {
    const d = make({ scope: { topics: ['a', 'b', 'c'], domains: [] } });
    expect(computeBreadth(d)).toBe(1);
  });

  it('depth: 5 维 + basis 加成', () => {
    const d = make({
      facets: { judgment: 0.5, taste_aesthetic: 0.5, novelty_score: 0.5, imaginative_score: 0.5, curiosity_vector: 0.5 },
      basis: { taste_basis: 'short', novelty_basis: 'short ok', imagination_basis: 'short yes' },
    });
    expect(computeDepth(d)).toBeGreaterThanOrEqual(1); // 5/5=1 + 3*0.06 ≈ 1.18, clamp 1
  });

  it('rank: trust peer 排前', () => {
    const a = make({ descriptionId: 'jd-a', createdAt: new Date(NOW - 1000).toISOString() });
    const b = make({ descriptionId: 'jd-b', createdAt: new Date(NOW - 2000).toISOString() });
    const ranked = rankDescriptions([a, b], {
      nowMs: NOW,
      trustedPks: new Set(['pk-trusted-b']),
      ownerPkMap: new Map([
        ['jd-a', 'pk-stranger'],
        ['jd-b', 'pk-trusted-b'],
      ]),
    });
    expect(ranked[0].description.descriptionId).toBe('jd-b');
    expect(ranked[0].why.trust).toBe(1);
  });

  it('rank score clamp 到 [0,1]', () => {
    const d = make({
      facets: { judgment: 9, taste_aesthetic: 0.5, novelty_score: 0.5, imaginative_score: 0.5, curiosity_vector: 0.5 },
      scope: { topics: ['a', 'b', 'c', 'd', 'e'] },
    });
    const ranked = rankDescriptions([d], { nowMs: NOW });
    expect(ranked[0].rankScore).toBeLessThanOrEqual(1);
    expect(ranked[0].rankScore).toBeGreaterThanOrEqual(0);
  });

  it('默认权重 0.4/0.2/0.2/0.2 之和 = 1.0', () => {
    const sum = DEFAULT_RANK_WEIGHTS.recency + DEFAULT_RANK_WEIGHTS.breadth + DEFAULT_RANK_WEIGHTS.depth + DEFAULT_RANK_WEIGHTS.trust;
    expect(sum).toBeCloseTo(1.0);
  });
});
