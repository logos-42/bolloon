import { describe, it, expect } from 'vitest';
import type { JudgenessDescription, JudgenessFacets } from '../../judgeness/types.js';

describe('judgeness types — schema invariants', () => {
  it('5 维评分缺省视为 v0', () => {
    const e: JudgenessFacets = {};
    expect(e.judgment).toBeUndefined();
    expect(e.taste_aesthetic).toBeUndefined();
  });

  it('description 必须 pinned description_version = 1', () => {
    const d: JudgenessDescription = {
      descriptionId: 'jd-test-1',
      judgmentRef: 'hv-test',
      description_version: 1,
      facets: {},
      basis: {},
      scope: { topics: [], domains: [] },
      visibility: 'private',
      openState: 'locked',
      by: 'human',
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    };
    expect(d.description_version).toBe(1);
  });

  it('visibility + openState 取值合法', () => {
    const legalV: Array<JudgenessDescription['visibility']> = ['public', 'allowlist', 'peers', 'private'];
    const legalO: Array<JudgenessDescription['openState']> = ['open', 'locked', 'human-only'];
    expect(legalV).toHaveLength(4);
    expect(legalO).toHaveLength(3);
  });
});
