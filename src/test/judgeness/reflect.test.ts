import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const TEST_HOME = path.join(os.tmpdir(), `bolloon-judgeness-reflect-${Date.now()}`);
process.env.BOLLOON_HOME = TEST_HOME;

import { reflectFromJudgment, reflectAfterJudgment } from '../../judgeness/reflect.js';
import { loadDescription, findDescriptionByJudgmentRef } from '../../judgeness/store.js';
import type { HumanJudgment } from '../../pi-ecosystem-judgment/human-value-store.js';

const sampleHV = (id: string): HumanJudgment => ({
  id,
  timestamp: '2026-07-15T00:00:00.000Z',
  decision: 'use P2P for sync',
  decision_type: 'approve',
  reasons: ['lowers friction'],
  values_derived: [],
  context: {
    domain: 'architecture',
    complexity: 'moderate',
    stakes: 'medium',
    time_pressure: 'low',
  },
  metadata: {
    source: 'explicit',
    confidence: 0.8,
    revisable: true,
  },
});

describe('judgeness reflect — description ↔ judgment', () => {
  beforeEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it('reflectFromJudgment 创建 jd', async () => {
    const j = await reflectFromJudgment({
      judgment: sampleHV('hv-new-1'),
      by: 'human',
      facets: { judgment: 0.7 },
      visibility: 'private',
      openState: 'locked',
    });
    const back = await loadDescription(j.descriptionId);
    expect(back?.judgmentRef).toBe('hv-new-1');
  });

  it('同 judgmentRef 二次 reflect 合并', async () => {
    const first = await reflectFromJudgment({
      judgment: sampleHV('hv-merge'),
      by: 'human',
      facets: { judgment: 0.5 },
      visibility: 'private',
    });
    const second = await reflectFromJudgment({
      judgment: sampleHV('hv-merge'),
      by: 'agent',
      byAgentId: 'agent-A',
      facets: { taste_aesthetic: 0.6 },
      visibility: 'private',
    });
    expect(second.descriptionId).toBe(first.descriptionId);
    expect((await loadDescription(first.descriptionId))?.facets.taste_aesthetic).toBe(0.6);
    expect((await loadDescription(first.descriptionId))?.facets.judgment).toBe(0.5);
  });

  it('reflectAfterJudgment 默认 private + locked', async () => {
    const d = await reflectAfterJudgment(sampleHV('hv-after'), 'human');
    expect(d?.visibility).toBe('private');
    expect(d?.openState).toBe('locked');
    expect(d?.judgmentRef).toBe('hv-after');
  });

  it('findDescriptionByJudgmentRef 能找到 jd', async () => {
    await reflectFromJudgment({ judgment: sampleHV('hv-find'), by: 'human', visibility: 'private' });
    const found = await findDescriptionByJudgmentRef('hv-find');
    expect(found).not.toBeNull();
  });
});
