import { describe, it, expect } from 'vitest';
import { CONTEXT_OS_LAYERS, resolveLayer, formatLayerListing } from '../bootstrap/context-os.js';

describe('Context OS workspace kind (Hermes kanban workspace_kind 模式)', () => {
  it('12 个原则层 = stable', () => {
    const stable = CONTEXT_OS_LAYERS.filter((l) => l.kind === 'stable');
    expect(stable.length).toBe(12);
    expect(stable[0].key).toBe('01-Me');
    expect(stable[11].key).toBe('12-Analysis');
  });

  it('output/research = work, tmp = scratch', () => {
    expect(resolveLayer('output')?.kind).toBe('work');
    expect(resolveLayer('research')?.kind).toBe('work');
    expect(resolveLayer('tmp')?.kind).toBe('scratch');
  });

  it('全部 15 层都有合法 kind', () => {
    for (const l of CONTEXT_OS_LAYERS) {
      expect(['stable', 'work', 'scratch']).toContain(l.kind);
    }
  });

  it('formatLayerListing 带 kind 徽标', () => {
    const listing = formatLayerListing([
      { layer: 'tmp', name: '一次性草稿', kind: 'scratch', fileCount: 2, files: [] },
      { layer: '01-Me', name: '我是谁', kind: 'stable', fileCount: 0, files: [] },
    ]);
    expect(listing).toContain('[scratch]');
    expect(listing).toContain('[stable]');
  });
});
