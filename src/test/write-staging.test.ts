/**
 * write-staging.test.ts — 2026-08-12 (TaskC)
 *
 * 写操作准备阶段适配 (hermes write_approval staging gate → bolloon):
 *   - stageWrite 记录变更前快照 (审计/回滚)
 *   - listStagedWrites 列出暂存记录
 *   - undoLastWrite 撤销最近一次写 (仅当文件未被后续修改)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { stageWrite, listStagedWrites, undoLastWrite, writeLogDir } from '../agents/write-staging.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-write-staging-' + Date.now());
const cwd = path.join(tmpRoot, 'work');

describe('write-staging (写操作准备阶段)', () => {
  beforeEach(async () => {
    await fs.mkdir(cwd, { recursive: true });
    // 隔离: 清空 write-log (listStagedWrites 读整个目录)
    await fs.rm(path.join(tmpRoot, '.bolloon', 'write-log'), { recursive: true, force: true });
  });

  it('stageWrite 记录一次写操作 (含变更前快照)', async () => {
    const rec = await stageWrite('src/a.ts', 'old content', 'new content', 'overwrite', cwd, tmpRoot);
    expect(rec).not.toBeNull();
    expect(rec!.relPath).toBe('src/a.ts');
    expect(rec!.beforeContent).toBe('old content');
    expect(rec!.afterContent).toBe('new content');
    expect(rec!.action).toBe('overwrite');
  });

  it('listStagedWrites 列出暂存记录 (新→旧)', async () => {
    await stageWrite('a.txt', '', 'A', 'create', cwd, tmpRoot);
    await stageWrite('b.txt', '', 'B', 'create', cwd, tmpRoot);
    const list = await listStagedWrites(tmpRoot);
    expect(list.length).toBe(2);
    expect(list[0].relPath).toBe('b.txt'); // 最新的在前
  });

  it('undoLastWrite 撤销最近一次写 (文件未被后续修改时)', async () => {
    const file = path.join(cwd, 't.txt');
    await fs.writeFile(file, 'v1', 'utf-8');
    await stageWrite('t.txt', 'v1', 'v2', 'edit', cwd, tmpRoot);
    await fs.writeFile(file, 'v2', 'utf-8'); // 应用变更
    const r = await undoLastWrite(tmpRoot);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe('v1');
  });

  it('undoLastWrite 拒绝撤销 (文件已被后续修改)', async () => {
    const file = path.join(cwd, 't.txt');
    await fs.writeFile(file, 'v1', 'utf-8');
    await stageWrite('t.txt', 'v1', 'v2', 'edit', cwd, tmpRoot);
    await fs.writeFile(file, 'v2', 'utf-8');
    await fs.writeFile(file, 'v3', 'utf-8'); // 后续又被改
    const r = await undoLastWrite(tmpRoot);
    expect(r.ok).toBe(false);
    expect(await fs.readFile(file, 'utf-8')).toBe('v3');
  });

  it('writeLogDir 路径正确', () => {
    expect(writeLogDir(tmpRoot)).toBe(path.join(tmpRoot, '.bolloon', 'write-log'));
  });
});
