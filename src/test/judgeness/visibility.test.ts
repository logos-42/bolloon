import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const TEST_HOME = path.join(os.tmpdir(), `bolloon-judgeness-vis-${Date.now()}`);
process.env.BOLLOON_HOME = TEST_HOME;

import {
  resolveGate3,
  scrubForAudience,
  resolveGate2,
} from '../../judgeness/visibility.js';
import {
  saveDescription,
  saveAllowlist,
  saveVisibility,
} from '../../judgeness/store.js';
import type { JudgenessDescription, JudgenessVisibilityFile } from '../../judgeness/types.js';

const baseDesc = (over: Partial<JudgenessDescription>): JudgenessDescription => ({
  descriptionId: 'jd-t-vis-1',
  judgmentRef: 'hv-t-1',
  description_version: 1,
  facets: { judgment: 0.5, taste_aesthetic: 0.4 },
  basis: { taste_basis: 'monochrome minimalism' },
  scope: { topics: ['design'], domains: ['product'] },
  visibility: 'allowlist',
  openState: 'open',
  by: 'human',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
  ...over,
});

describe('judgeness visibility — 三道闸', () => {
  beforeEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
    await fs.mkdir(TEST_HOME, { recursive: true });
  });

  describe('闸 3: human override', () => {
    it('locked + agent → reject', async () => {
      const vis: JudgenessVisibilityFile = {
        version: 1,
        defaults: { visibility: 'private', openState: 'locked' },
        channels: [],
        cards: [],
      };
      await saveVisibility(vis);
      const d = baseDesc({ openState: 'locked' });
      const g = resolveGate3(d, { pubkey: 'pk-agent', role: 'agent' }, vis);
      expect(g.allow).toBe(false);
    });

    it('open + agent → allow', async () => {
      const vis: JudgenessVisibilityFile = {
        version: 1,
        defaults: { visibility: 'private', openState: 'locked' },
        channels: [],
        cards: [],
      };
      await saveVisibility(vis);
      const d = baseDesc({ openState: 'open' });
      const g = resolveGate3(d, { pubkey: 'pk-agent', role: 'agent' }, vis);
      expect(g.allow).toBe(true);
    });

    it('human-only + agent → reject', async () => {
      const vis: JudgenessVisibilityFile = {
        version: 1,
        defaults: { visibility: 'private', openState: 'locked' },
        channels: [],
        cards: [],
      };
      await saveVisibility(vis);
      const d = baseDesc({ openState: 'human-only' });
      const g = resolveGate3(d, { pubkey: 'pk-agent', role: 'agent' }, vis);
      expect(g.allow).toBe(false);
    });

    it('humanOverride=true 强制覆盖 agent openState=open', async () => {
      const vis: JudgenessVisibilityFile = {
        version: 1,
        defaults: { visibility: 'private', openState: 'locked' },
        channels: [
          { channelId: 'c1', visibility: 'public', openState: 'open', humanOverride: true },
        ],
        cards: [],
      };
      const d = baseDesc({ openState: 'open' });
      const g = resolveGate3(d, { pubkey: 'pk-agent', role: 'agent', channelTopic: 'c1' }, vis);
      expect(g.allow).toBe(false);
      expect(g.reason).toContain('humanOverride');
    });
  });

  describe('闸 1: scrubber', () => {
    it('private + 非 self → 只返回基础字段', async () => {
      await saveDescription(baseDesc({ visibility: 'private', openState: 'open' }));
      const s = await scrubForAudience(
        baseDesc({ visibility: 'private', openState: 'open' }),
        { pubkey: 'pk-other', role: 'agent' }
      );
      expect(s.facets).toBeUndefined();
      expect(s.descriptionId).toBe('jd-t-vis-1');
    });

    it('self 永远看到 facets', async () => {
      await saveDescription(baseDesc({ visibility: 'private', openState: 'open' }));
      const s = await scrubForAudience(
        baseDesc({ visibility: 'private', openState: 'open' }),
        { pubkey: '__self__', role: 'human' }
      );
      expect(s.facets?.judgment).toBe(0.5);
    });

    it('allowlist + 非 allowlist → 看不到 facets', async () => {
      const d = baseDesc({ visibility: 'allowlist', openState: 'open' });
      await saveDescription(d);
      await saveAllowlist({
        version: 1,
        peers: [{ pubkey: 'pk-allowed', addedAt: '2026-07-15T00:00:00.000Z' }],
      });
      const s = await scrubForAudience(d, { pubkey: 'pk-stranger', role: 'agent' });
      expect(s.facets).toBeUndefined();
    });

    it('allowlist + allowlist 内 → 看到 facets', async () => {
      const d = baseDesc({ visibility: 'allowlist', openState: 'open' });
      await saveDescription(d);
      await saveAllowlist({
        version: 1,
        peers: [{ pubkey: 'pk-friend', addedAt: '2026-07-15T00:00:00.000Z' }],
      });
      const s = await scrubForAudience(d, { pubkey: 'pk-friend', role: 'agent' });
      expect(s.facets?.judgment).toBe(0.5);
    });

    it('public → 谁都能看到', async () => {
      const d = baseDesc({ visibility: 'public', openState: 'open' });
      await saveDescription(d);
      const s = await scrubForAudience(d, { pubkey: 'pk-stranger', role: 'agent' });
      expect(s.facets?.judgment).toBe(0.5);
    });
  });

  describe('闸 2: allowlist gate', () => {
    it('channel 未登记 + peer 不在 allowlist → reject (fail-closed)', async () => {
      const g = await resolveGate2('pk-stranger', 'unknown-channel');
      expect(g.allow).toBe(false);
    });

    it('channel=public → allow always', async () => {
      const vis: JudgenessVisibilityFile = {
        version: 1,
        defaults: { visibility: 'private', openState: 'locked' },
        channels: [{ channelId: 'public-foo', visibility: 'public', openState: 'open', humanOverride: false }],
        cards: [],
      };
      const g = await resolveGate2('pk-stranger', 'public-foo', vis);
      expect(g.allow).toBe(true);
    });

    it('channel=private → reject always', async () => {
      const vis: JudgenessVisibilityFile = {
        version: 1,
        defaults: { visibility: 'private', openState: 'locked' },
        channels: [{ channelId: 'priv', visibility: 'private', openState: 'open', humanOverride: false }],
        cards: [],
      };
      const g = await resolveGate2('pk-friend', 'priv', vis);
      expect(g.allow).toBe(false);
    });
  });
});
