import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createSkill,
  updateSkill,
  deleteSkill,
  sanitizeSkillName,
  writeSkillCandidate,
  listSkillCandidates,
  promoteCandidate,
  writeRunEndSkillCandidates,
} from '../agents/skill-writer.js';

// 用临时目录测, 不污染真实 ~/.bolloon
const tmpHome = path.join(os.tmpdir(), `bolloon-skill-writer-test-${Date.now()}`);
let oldHome = '';

describe('skill-writer', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    // Node os.homedir() 在 Windows 优先读 USERPROFILE (不走 HOME), 需一起切到临时目录
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('sanitizeSkillName 清理非法字符', () => {
    expect(sanitizeSkillName('P2P Debug!!')).toBe('p2p-debug');
    expect(sanitizeSkillName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeSkillName('a'.repeat(100))).toHaveLength(64);
  });

  it('createSkill 写入 SKILL.md 且格式正确', async () => {
    const r = await createSkill('test-skill', '测试技能', '# 步骤\n1. 做 A\n2. 做 B', { triggers: ['test', '调试'] });
    expect(r.ok).toBe(true);
    const raw = await fs.readFile(r.path, 'utf-8');
    expect(raw.startsWith('---')).toBe(true);
    expect(raw).toContain('name: test-skill');
    expect(raw).toContain('description: 测试技能');
    expect(raw).toContain('triggers:');
    expect(raw).toContain('1. 做 A');
  });

  it('createSkill overwrite=false 拒绝覆盖', async () => {
    const r = await createSkill('test-skill', '覆盖', '新内容', { overwrite: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已存在');
  });

  it('updateSkill 追加 body + 改描述', async () => {
    const r = await updateSkill('test-skill', { appendBody: '## 新经验\n3. 做 C', description: '新描述' });
    expect(r.ok).toBe(true);
    const raw = await fs.readFile(r.path, 'utf-8');
    expect(raw).toContain('description: 新描述');
    expect(raw).toContain('3. 做 C');
    // 原内容还在
    expect(raw).toContain('1. 做 A');
  });

  it('updateSkill 不存在时报错', async () => {
    const r = await updateSkill('no-such-skill', { appendBody: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不存在');
  });

  it('writeSkillCandidate + listSkillCandidates + promoteCandidate 闭环', async () => {
    await writeSkillCandidate({
      name: 'auto-list_files-abc',
      description: '自动候选',
      body: '## 流程\n调用 list_files',
      source: 'test',
      timestamp: new Date().toISOString(),
    });
    const cands = await listSkillCandidates();
    expect(cands.length).toBe(1);
    expect(cands[0].name).toBe('auto-list_files-abc');

    const pr = await promoteCandidate('auto-list_files-abc');
    expect(pr.ok).toBe(true);
    // 转正后候选被清理
    const after = await listSkillCandidates();
    expect(after.length).toBe(0);
    // 正式 skill 存在
    const raw = await fs.readFile(pr.path, 'utf-8');
    expect(raw).toContain('name: auto-list_files-abc');
  });

  it('deleteSkill 删除', async () => {
    const r = await deleteSkill('test-skill');
    expect(r.ok).toBe(true);
  });

  it('writeRunEndSkillCandidates ≥2 连续成功工具写候选', async () => {
    const r = await writeRunEndSkillCandidates([
      { status: 'ok', name: 'read_file', output: '...' },
      { status: 'ok', name: 'grep_files', output: 'match' },
      { status: 'error', name: 'write_file' },
      { status: 'ok', name: 'system' }, // 内部步骤, 不算
    ], 'test:cli');
    expect(r.wrote).toBe(true);
    expect(r.count).toBe(2);
    expect(r.names).toContain('read_file');
    expect(r.file).toContain('skill-candidates');
    const cands = await listSkillCandidates();
    // 稳定签名名 auto-read_file_grep_files (无时间戳)
    const mine = cands.find(c => c.name === 'auto-read_file_grep_files');
    expect(mine).toBeDefined();
    expect(mine!.body).toContain('grep_files');
    expect(mine!.source).toBe('test:cli');
    expect(mine!.runs).toBe(1);
  });

  it('writeRunEndSkillCandidates 同一套工具再次运行 → 合并到同一个候选 (runs++)', async () => {
    const r2 = await writeRunEndSkillCandidates([
      { status: 'ok', name: 'read_file' },
      { status: 'ok', name: 'grep_files' },
    ], 'test:cli');
    expect(r2.wrote).toBe(true);
    expect(r2.merged).toBe(true);
    expect(r2.runs).toBe(2);
    const cands = await listSkillCandidates();
    const mine = cands.filter(c => c.name === 'auto-read_file_grep_files');
    expect(mine.length).toBe(1); // 不产生第二个文件
    expect(mine[0].runs).toBe(2);
  });

  it('writeRunEndSkillCandidates 不足 2 个不写', async () => {
    const before = (await listSkillCandidates()).length;
    const r = await writeRunEndSkillCandidates(
      [{ status: 'ok', name: 'read_file' }],
      'test:cli'
    );
    expect(r.wrote).toBe(false);
    expect(r.reason).toContain('不足');
    expect((await listSkillCandidates()).length).toBe(before);
  });

  it('writeRunEndSkillCandidates 全失败步骤不写', async () => {
    const r = await writeRunEndSkillCandidates(
      [{ status: 'error', name: 'write_file' }],
      'test:cli'
    );
    expect(r.wrote).toBe(false);
  });
});
