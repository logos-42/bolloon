import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const TEST_HOME = path.join(os.tmpdir(), `bolloon-judgeness-test-${Date.now()}`);
process.env.BOLLOON_HOME = TEST_HOME;

// dynamic import after env set
const {
  newDescriptionId,
  saveDescription,
  loadDescription,
  listDescriptions,
  addAllowlistPeer,
  removeAllowlistPeer,
  isPubkeyAllowed,
  loadVisibility,
  saveVisibility,
} = await import('../../judgeness/store.js');
import type { JudgenessDescription } from '../../judgeness/types.js';

const sample = (id: string, jref = 'hv-1'): JudgenessDescription => ({
  descriptionId: id,
  judgmentRef: jref,
  description_version: 1,
  facets: { judgment: 0.7, taste_aesthetic: 0.5 },
  basis: { taste_basis: 'cold palette, geometric' },
  scope: { domains: ['architecture'], topics: ['architecture', 'type-system'] },
  visibility: 'allowlist',
  openState: 'locked',
  by: 'human',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
});

describe('judgeness store — write/read', () => {
  beforeEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it('save/load round-trip', async () => {
    const d = sample('jd-rt-1');
    await saveDescription(d);
    const back = await loadDescription('jd-rt-1');
    expect(back).not.toBeNull();
    expect(back?.judgmentRef).toBe('hv-1');
    expect(back?.facets.judgment).toBe(0.7);
    expect(back?.scope.topics).toContain('type-system');
  });

  it('id 生成格式 jd-<ts>-<rand6>', () => {
    const id = newDescriptionId();
    expect(id).toMatch(/^jd-\d+-[0-9a-f]{6}$/);
  });

  it('list 跳过非 .md', async () => {
    await saveDescription(sample('jd-list-1'));
    const list = await listDescriptions();
    expect(list.find((d) => d.descriptionId === 'jd-list-1')).toBeTruthy();
  });

  it('allowlist add/remove/isAllowed', async () => {
    await addAllowlistPeer({ pubkey: 'abcd1234abcd1234abcd1234abcd1234', alias: 'alice', addedAt: '2026-07-15T00:00:00.000Z' });
    expect(await isPubkeyAllowed('abcd1234abcd1234abcd1234abcd1234')).toBe(true);
    await removeAllowlistPeer('abcd1234abcd1234abcd1234abcd1234');
    expect(await isPubkeyAllowed('abcd1234abcd1234abcd1234abcd1234')).toBe(false);
  });

  it('visibility save/load 保留 channel 数', async () => {
    const f = await loadVisibility();
    f.channels.push({
      channelId: 'general',
      visibility: 'allowlist',
      openState: 'locked',
      humanOverride: false,
    });
    await saveVisibility(f);
    const back = await loadVisibility();
    expect(back.channels).toHaveLength(1);
    expect(back.channels[0].channelId).toBe('general');
  });
});
