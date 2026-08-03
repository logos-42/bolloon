import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CONTEXT_OS_LAYERS,
  ensureContextOsDirs,
  writeContextAsset,
  readContextAssets,
  readAssetBody,
  resolveLayer,
  getContextOsRoot,
} from '../bootstrap/context-os.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-context-os-test-${Date.now()}`);
let oldHome = '';

describe('context-os 资产层 (Context OS 12+3 层文件夹体系)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    await fs.mkdir(tmpHome, { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('12+3 层定义完整 (01-Me ~ 12-Analysis + output/research/tmp)', () => {
    expect(CONTEXT_OS_LAYERS).toHaveLength(15);
    const keys = CONTEXT_OS_LAYERS.map((l) => l.key);
    expect(keys.slice(0, 12)).toEqual([
      '01-Me', '02-Network', '03-Current', '04-Projects', '05-Prompts', '06-Protocols',
      '07-Knowledge', '08-Insights', '09-Tools', '10-Skills', '11-Write', '12-Analysis',
    ]);
    expect(keys.slice(12)).toEqual(['output', 'research', 'tmp']);
  });

  it('ensureContextOsDirs 建目录 + 每层 README (职责边界)', async () => {
    await ensureContextOsDirs();
    for (const l of CONTEXT_OS_LAYERS) {
      const dir = path.join(getContextOsRoot(), l.key);
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
      const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf-8');
      expect(readme).toContain(`# ${l.key}`);
      expect(readme).toContain('价值判断标准');
      expect(readme).toContain(l.store);
      expect(readme).toContain(l.notStore);
    }
  });

  it('writeContextAsset 写入 + frontmatter stage0', async () => {
    const r = await writeContextAsset({
      layer: '07-Knowledge',
      title: 'P2P 消息可靠性设计原则',
      content: '心跳必须显式传文本, 空消息会被判为 defect.',
      tags: ['p2p', 'reliability'],
      domain: '网络',
    });
    expect(r.ok).toBe(true);
    expect(r.asset!.layer).toBe('07-Knowledge');
    expect(r.asset!.file).toMatch(/-\u0050\u0032\u0050.*\.md$/); // slug 含标题
    const raw = await fs.readFile(r.asset!.path, 'utf-8');
    expect(raw).toContain('title:');
    expect(raw).toContain('stage: stage0');
    expect(raw).toContain('schema_version: 2');
  });

  it('writeContextAsset 非法 layer → error; 同标题幂等跳过', async () => {
    const bad = await writeContextAsset({ layer: '99-Fake', title: 'x', content: 'y' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('layer 非法');

    const again = await writeContextAsset({
      layer: '07-Knowledge',
      title: 'P2P 消息可靠性设计原则',
      content: '重复内容',
    });
    expect(again.ok).toBe(true);
    expect(again.skipped).toBe(true);
  });

  it('readContextAssets 汇总 + 过滤', async () => {
    await writeContextAsset({ layer: '08-Insights', title: '不要给只读工具加白名单', content: '只读无破坏性.' });
    const all = await readContextAssets();
    expect(all).toHaveLength(15);
    const k7 = all.find((l) => l.layer === '07-Knowledge')!;
    expect(k7.fileCount).toBe(1);

    const filtered = await readContextAssets('07-Knowledge', 'P2P');
    expect(filtered[0].files.length).toBe(1);
    const none = await readContextAssets('07-Knowledge', '不存在的词');
    expect(none[0].files.length).toBe(0);
  });

  it('readAssetBody 读取正文; 非法 file 拒绝', async () => {
    await writeContextAsset({ layer: '12-Analysis', title: '一次回滚复盘', content: '回滚原因: 实测延迟更高.' });
    const listing = await readContextAssets('12-Analysis');
    const file = listing[0].files[0].file;
    const body = await readAssetBody('12-Analysis', file);
    expect(body.ok).toBe(true);
    expect(body.body).toContain('回滚原因');

    const bad = await readAssetBody('12-Analysis', '../../etc/passwd');
    expect(bad.ok).toBe(false);
  });

  it('resolveLayer 校验', () => {
    expect(resolveLayer('01-Me')?.name).toBe('我是谁');
    expect(resolveLayer('tmp')?.name).toBe('一次性草稿');
    expect(resolveLayer('bad')).toBeNull();
  });
});
