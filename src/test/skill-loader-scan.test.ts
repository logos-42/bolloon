/**
 * 2026-10-12 (leo: 「开始的时候没有主动扫描加载这个仓库里面的技能, 看一下 hermes 怎么做的」):
 * skill-loader 多级嵌套扫描 + 仓库级 skills 路径。
 * Hermes 式技能库是 skills/<category>/<skill>/SKILL.md 形态 (分类层 + 技能层) —
 * 旧实现只认一层 {name}/SKILL.md, 分类库整棵读不到。现在递归下钻 (≤6 层)。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSkillsDir, defaultSkillPaths } from '../agents/skill-loader.js';

function tmpSkillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-skills-'));
}

function writeSkill(dir: string, relPath: string, name: string, description: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`;
  fs.writeFileSync(full, md, 'utf8');
  return full;
}

describe('loadSkillsDir — Hermes 式多级嵌套扫描 (2026-10-12)', () => {
  it('一层 {name}/SKILL.md 照常识别 (向后兼容)', async () => {
    const dir = tmpSkillsDir();
    writeSkill(dir, 'read-file/SKILL.md', 'read-file', '读文件');
    const skills = await loadSkillsDir(dir);
    expect(skills.map((s) => s.name)).toContain('read-file');
  });

  it('多级分类库 skills/<category>/<skill>/SKILL.md 递归识别', async () => {
    const dir = tmpSkillsDir();
    writeSkill(dir, 'software-dev/bolloon-dev/SKILL.md', 'bolloon-dev', 'Bolloon 开发');
    writeSkill(dir, 'data-science/ml/experiment/SKILL.md', 'exp-design', '消融设计');
    writeSkill(dir, 'writing/essays/SKILL.md', 'essays', '写作');
    const skills = await loadSkillsDir(dir);
    const names = skills.map((s) => s.name);
    expect(names).toContain('bolloon-dev');
    expect(names).toContain('exp-design');
    expect(names).toContain('essays');
  });

  it('分类层 (无 SKILL.md) 不下钻到没有技能的深处, 空目录安全', async () => {
    const dir = tmpSkillsDir();
    fs.mkdirSync(path.join(dir, 'empty/cat/deep'), { recursive: true });
    const skills = await loadSkillsDir(dir);
    expect(skills).toHaveLength(0);
  });

  it('hidden 目录跳过 (不扫 .git 等)', async () => {
    const dir = tmpSkillsDir();
    writeSkill(dir, '.hidden/SKILL.md', 'hidden', '不该出现');
    const skills = await loadSkillsDir(dir);
    expect(skills).toHaveLength(0);
  });
});

describe('defaultSkillPaths — Hermes 式仓库级 skills 目录 (2026-10-12)', () => {
  it('包含 <cwd>/skills', () => {
    const paths = defaultSkillPaths('/tmp/home', '/tmp/repo');
    expect(paths).toContain(path.join('/tmp/repo', 'skills'));
    expect(paths).toContain(path.join('/tmp/repo', '.bolloon', 'skills'));
    expect(paths).toContain(path.join('/tmp/home', '.bolloon', 'skills'));
  });
});