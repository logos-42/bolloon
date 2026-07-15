import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// 每个测试独立 tmpdir (避免 vitest 池共享 state)
let TEST_HOME = '';
process.env.BOLLOON_HOME = TEST_HOME;

const { performAutoAdd, _resetAuditPathCacheForTest } = await import('../../judgeness/auto-add.js');
const { saveDescription } = await import('../../judgeness/store.js');

const make = (id: string, over: any = {}) => ({
  descriptionId: id,
  judgmentRef: 'hv-' + id,
  description_version: 1 as const,
  facets: {},
  basis: {},
  scope: { topics: [], domains: [] },
  visibility: 'public' as const,
  openState: 'open' as const,
  by: 'human' as const,
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
  ...over,
});

describe('judgeness auto-add — 频次限制 + audit', () => {
  beforeEach(async () => {
    TEST_HOME = path.join(os.tmpdir(), `bolloon-jd-aa-${Date.now()}-${Math.random().toString(36).slice(2,6)}`);
    process.env.BOLLOON_HOME = TEST_HOME;
    await fs.rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_HOME, { recursive: true });
    _resetAuditPathCacheForTest();
  });

  it('frequency limit 第 6 次拒绝', async () => {
    const now = Date.parse('2026-07-15T12:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      const r = await performAutoAdd(
        { channelTopic: 'arch', ts: now + i * 1000 },
        { nowMs: now + i * 1000 }
      );
      expect(r.frequencyLimited).toBe(false);
    }
    const sixth = await performAutoAdd(
      { channelTopic: 'arch', ts: now + 6000 },
      { nowMs: now + 6000 }
    );
    expect(sixth.frequencyLimited).toBe(true);
  });

  it('defense stub: 即使未注入 joinTopic 也不抛错', async () => {
    const id = 'jd-aa-' + Math.random().toString(36).slice(2,8);
    await saveDescription(make(id, { scope: { topics: ['arch'], domains: [] }, openState: 'open' }));
    const r = await performAutoAdd({ channelTopic: 'arch' });
    expect(r.matched).toBeGreaterThanOrEqual(1);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.joined).toBe(0);
  });

  it('openState=locked 不被 auto-add', async () => {
    const id = 'jd-aa-' + Math.random().toString(36).slice(2,8);
    await saveDescription(make(id, { scope: { topics: ['arch'], domains: [] }, openState: 'locked' }));
    const r = await performAutoAdd({ channelTopic: 'arch' });
    expect(r.matched).toBe(0);
  });

  it('不匹配 topic 不进 match', async () => {
    const id = 'jd-aa-' + Math.random().toString(36).slice(2,8);
    await saveDescription(make(id, { scope: { topics: ['security'], domains: [] } }));
    const r = await performAutoAdd({ channelTopic: 'arch' });
    expect(r.matched).toBe(0);
  });

  it('注入 joinTopic stub: joined 计数', async () => {
    const id = 'jd-aa-' + Math.random().toString(36).slice(2,8);
    await saveDescription(make(id, { scope: { topics: ['arch'], domains: [] }, openState: 'open', by: 'agent', byAgentId: 'pk-foo' }));
    const r = await performAutoAdd(
      { channelTopic: 'arch' },
      { joinTopic: async () => ({ ok: true }) }
    );
    expect(r.joined).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('audit 进 counterfactual-audit.jsonl', async () => {
    const id = 'jd-aa-' + Math.random().toString(36).slice(2,8);
    await saveDescription(make(id, { scope: { topics: ['arch'], domains: [] }, openState: 'open' }));
    await performAutoAdd({ channelTopic: 'arch' });
    const auditPath = path.join(TEST_HOME, 'human-values', 'counterfactual-audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf-8');
    expect(raw).toContain('autoadd');
  });
});
