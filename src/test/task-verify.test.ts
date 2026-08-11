import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { extractTaskReferences, extractFileReferences, verifyTaskResult } from '../web/task-verify.js';

const tmpDir = path.join(os.tmpdir(), 'bolloon-task-verify-' + Date.now());

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'real.md'), '# real', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('extractTaskReferences (幽灵任务引用检测)', () => {
  it('提取 task_xxx 引用', () => {
    expect(extractTaskReferences('完成 task_abc123 后提交了 task_def456')).toEqual(['task_abc123', 'task_def456']);
  });
  it('无引用 → 空', () => {
    expect(extractTaskReferences('正常文本 无引用')).toEqual([]);
  });
  it('大小写归一 + 去重', () => {
    expect(extractTaskReferences('TASK_AbC task_abc')).toEqual(['task_abc']);
  });
});

describe('extractFileReferences (文件路径引用提取)', () => {
  it('markdown 链接 + 反引号路径 + 扩展名', () => {
    const refs = extractFileReferences('见 [文档](docs/readme.md) 和 `src/app.ts` 和 `README.md`');
    expect(refs).toContain('docs/readme.md');
    expect(refs).toContain('src/app.ts');
    expect(refs).toContain('README.md');
  });
  it('URL 不提取', () => {
    expect(extractFileReferences('看 https://example.com/a.md')).toEqual([]);
  });
  it('cap 20 条', () => {
    const many = Array.from({ length: 30 }, (_, i) => `[f${i}](file${i}.md)`).join(' ');
    expect(extractFileReferences(many).length).toBeLessThanOrEqual(20);
  });
});

describe('verifyTaskResult (完成防幻觉校验, advisory)', () => {
  it('存在的任务/文件 → 无 warning', async () => {
    const v = await verifyTaskResult('完成 task_ok1, 写了 [real](real.md)', {
      knownTaskIds: ['task_ok1'],
      cwd: tmpDir,
    });
    expect(v.warnings).toEqual([]);
  });

  it('幽灵任务/幽灵文件 → warning', async () => {
    const v = await verifyTaskResult('引用 task_ghost 和 [missing](missing.md)', {
      knownTaskIds: ['task_ok1'],
      cwd: tmpDir,
    });
    expect(v.warnings.some((w) => w.includes('task_ghost'))).toBe(true);
    expect(v.warnings.some((w) => w.includes('missing.md'))).toBe(true);
  });

  it('相对路径按 cwd 解析', async () => {
    const v = await verifyTaskResult('写了 [real](real.md) 和 [sub](sub/deep.md)', {
      knownTaskIds: [],
      cwd: tmpDir,
    });
    expect(v.warnings.filter((w) => w.includes('real.md')).length).toBe(0);
    expect(v.warnings.some((w) => w.includes('sub/deep.md'))).toBe(true);
  });
});
