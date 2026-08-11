import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { truncateToolOutput, TOOL_RESULT_MAX_CHARS } from '../agents/workflow-pivot-loop.js';
import { readContextAssets, formatLayerListing } from '../bootstrap/context-os.js';

describe('truncateToolOutput (Hermes 全限幅 — 工具输出进上下文上限)', () => {
  it('未超限 → 原样', () => {
    expect(truncateToolOutput('short')).toBe('short');
    expect(truncateToolOutput(undefined)).toBe('');
  });

  it('超限 → 保留前 max + 可见省略标记', () => {
    const big = 'x'.repeat(12001);
    const t = truncateToolOutput(big, 12000);
    expect(t.startsWith('x'.repeat(12000))).toBe(true);
    expect(t.endsWith('[truncated, 1 chars omitted]')).toBe(true);
    expect(t.length).toBe(12000 + 31); // max + 标记
  });

  it('默认上限 = TOOL_RESULT_MAX_CHARS (12K)', () => {
    expect(TOOL_RESULT_MAX_CHARS).toBe(12_000);
    const t = truncateToolOutput('y'.repeat(12_500));
    expect(t).toContain(`[truncated, ${500} chars omitted]`);
  });
});

const tmpHome = path.join(os.tmpdir(), 'bolloon-context-os-cap-' + Date.now());

beforeAll(async () => {
  await fs.mkdir(path.join(tmpHome, '.bolloon', 'context-os', 'tmp'), { recursive: true });
  const longTitle = '长标题'.repeat(50); // 150 字符
  await fs.writeFile(
    path.join(tmpHome, '.bolloon', 'context-os', 'tmp', 'long.md'),
    `---\ntitle: ${longTitle}\ncreated: 2026-08-11\n---\n正文`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(tmpHome, '.bolloon', 'context-os', 'tmp', 'short.md'),
    '---\ntitle: 短标题\ncreated: 2026-08-11\n---\n正文',
    'utf-8'
  );
});

afterAll(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('context-os 全限幅 (标题 cap + listing 有界)', () => {
  it('readContextAssets: 超长标题截断到 80 字符', async () => {
    const listings = await readContextAssets('tmp', undefined, tmpHome);
    const long = listings[0].files.find((f) => f.file === 'long.md');
    const short = listings[0].files.find((f) => f.file === 'short.md');
    expect(long?.title.length).toBeLessThanOrEqual(81); // 80 + …
    expect(long?.title.endsWith('…')).toBe(true);
    expect(short?.title).toBe('短标题');
  });

  it('formatLayerListing 只显示前 3 个资产 (files.slice(0,3))', async () => {
    const listings = await readContextAssets('tmp', undefined, tmpHome);
    expect(listings[0].files.length).toBe(2);
    const text = formatLayerListing(listings);
    expect(text).toContain('2 篇');
  });
});
