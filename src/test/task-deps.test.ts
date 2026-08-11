import { describe, it, expect } from 'vitest';
import { parentsSatisfied, unsatisfiedParents } from '../web/task-deps.js';

const all = [
  { id: 'p-done', status: 'completed' },
  { id: 'p-cancel', status: 'cancelled' },
  { id: 'p-fail', status: 'failed' },
  { id: 'p-run', status: 'running' },
  { id: 'p-pend', status: 'pending' },
  { id: 'p-review', status: 'review' },
];

describe('task 父依赖校验 (Hermes 认领点父依赖不变式)', () => {
  it('无父 / 空数组 → 满足', () => {
    expect(parentsSatisfied(undefined, all)).toBe(true);
    expect(parentsSatisfied({}, all)).toBe(true);
    expect(parentsSatisfied({ parentIds: [] }, all)).toBe(true);
  });

  it('父全部 completed/cancelled → 满足', () => {
    expect(parentsSatisfied({ parentIds: ['p-done', 'p-cancel'] }, all)).toBe(true);
  });

  it('父 failed/running/pending/review → 不满足', () => {
    expect(parentsSatisfied({ parentIds: ['p-fail'] }, all)).toBe(false);
    expect(parentsSatisfied({ parentIds: ['p-run'] }, all)).toBe(false);
    expect(parentsSatisfied({ parentIds: ['p-pend'] }, all)).toBe(false);
    expect(parentsSatisfied({ parentIds: ['p-review'] }, all)).toBe(false);
  });

  it('父不存在 (悬空依赖) → 保守阻塞', () => {
    expect(parentsSatisfied({ parentIds: ['ghost'] }, all)).toBe(false);
    expect(unsatisfiedParents({ parentIds: ['ghost'] }, all)).toEqual(['ghost']);
  });

  it('unsatisfiedParents 列出全部未满足父', () => {
    const u = unsatisfiedParents({ parentIds: ['p-done', 'p-fail', 'p-run'] }, all);
    expect(u).toEqual(['p-fail', 'p-run']);
  });
});
