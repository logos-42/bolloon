import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  migrateExternalAgent,
  migrateAllExternalAgents,
  sourceRootPath,
  sourceRootCandidates,
  workspacePath,
  sha1,
  formatMigrationNotices,
  detectSource,
} from '../migration/external-agent-migrator.js';
import type { MigratorDeps } from '../migration/external-agent-migrator.js';

let tmp: string;
let home: string;
let bolloon: string;

function openclawRoot(): string {
  return path.join(home, '.openclaw');
}
function ws(): string {
  return path.join(openclawRoot(), 'workspace');
}
function hermesRoot(la?: string): string {
  return path.join(la ?? path.join(home, 'AppData', 'Local'), 'hermes');
}
function hermesWs(la?: string): string {
  return hermesRoot(la);
}

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

/** 基于 tmp 目录构建真实 deps (只隔离 home, 其余真 IO) */
function deps(opts?: { localAppData?: string }): MigratorDeps {
  return {
    home,
    ...(opts?.localAppData ? { localAppData: opts.localAppData } : {}),
    readFile: async (p) => {
      try { return fs.readFileSync(p, 'utf-8'); } catch { return undefined; }
    },
    readdir: async (d) => {
      try { return fs.readdirSync(d); } catch { return undefined; }
    },
    stat: async (p) => {
      try {
        const s = fs.statSync(p);
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs };
      } catch { return undefined; }
    },
    mkdir: async (p) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: async (f, t) => { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(f, t); },
    writeFile: async (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d, 'utf-8'); },
    exists: async (p) => fs.existsSync(p),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-mig-'));
  home = path.join(tmp, 'home');
  bolloon = path.join(home, '.bolloon');
  fs.mkdirSync(home, { recursive: true });
});

describe('external-agent-migrator', () => {
  it('未安装源 → migrated=false, 静默不抛错', async () => {
    const r = await migrateExternalAgent('openclaw', deps());
    expect(r.migrated).toBe(false);
    expect(r.errors.length).toBe(0);
  });

  it('persona 6 文件正确映射', async () => {
    const root = openclawRoot();
    write(path.join(ws(), 'SOUL.md'), '# soul');
    write(path.join(ws(), 'IDENTITY.md'), '# identity');
    write(path.join(ws(), 'USER.md'), '# user');
    write(path.join(ws(), 'AGENTS.md'), '# agent');
    write(path.join(ws(), 'TOOLS.md'), '# project');
    write(path.join(ws(), 'MEMORY.md'), '# wiki');
    void root;

    const r = await migrateExternalAgent('openclaw', deps());
    expect(r.migrated).toBe(true);
    expect(r.persona).toEqual(expect.arrayContaining(['soul.md', 'identity.md', 'user.md', 'agent.md', 'project.md', 'wiki.md']));

    const personaDir = path.join(bolloon, 'persona', r.personaAgentId);
    expect(fs.readFileSync(path.join(personaDir, 'soul.md'), 'utf-8')).toBe('# soul');
    expect(fs.readFileSync(path.join(personaDir, 'wiki.md'), 'utf-8')).toBe('# wiki');
  });

  it('skills 整目录复制到 ~/.bolloon/skills/', async () => {
    write(path.join(ws(), 'skills', 'typescript', 'SKILL.md'), '---\nname: TypeScript\n---\n\nbody');
    write(path.join(ws(), 'skills', 'typescript', 'extra.md'), 'extra');

    const r = await migrateExternalAgent('openclaw', deps());
    expect(r.skillsCopied).toContain('typescript');
    expect(fs.readFileSync(path.join(bolloon, 'skills', 'typescript', 'SKILL.md'), 'utf-8')).toContain('TypeScript');
    expect(fs.readFileSync(path.join(bolloon, 'skills', 'typescript', 'extra.md'), 'utf-8')).toBe('extra');
  });

  it('memory + docs 也迁移', async () => {
    write(path.join(ws(), 'memory', '2026-02-15.md'), '# memory');
    write(path.join(ws(), 'README.md'), '# readme');

    const r = await migrateExternalAgent('openclaw', deps());
    expect(r.memoryCopied).toContain('2026-02-15.md');
    expect(r.docsCopied).toContain('README.md');
    expect(fs.existsSync(path.join(bolloon, 'memory', r.personaAgentId, 'sessions', '1-2026-02-15.md'))).toBe(true);
    expect(fs.existsSync(path.join(bolloon, 'context-os', '04-Projects', 'openclaw-docs', 'README.md'))).toBe(true);
  });

  it('幂等: 内容未变则跳过 (skillsCopied 空)', async () => {
    write(path.join(ws(), 'SOUL.md'), '# soul v1');
    write(path.join(ws(), 'skills', 'python', 'SKILL.md'), '---\nname: Python\n---\n\npy');

    const r1 = await migrateExternalAgent('openclaw', deps());
    expect(r1.persona.length).toBe(1);
    expect(r1.skillsCopied).toContain('python');

    const r2 = await migrateExternalAgent('openclaw', deps());
    expect(r2.persona.length).toBe(0);
    expect(r2.skillsCopied.length).toBe(0);
  });

  it('内容变化后重新迁移覆盖', async () => {
    write(path.join(ws(), 'SOUL.md'), '# soul v1');
    await migrateExternalAgent('openclaw', deps());
    write(path.join(ws(), 'SOUL.md'), '# soul v2');
    const r = await migrateExternalAgent('openclaw', deps());
    expect(r.persona).toContain('soul.md');
    const personaDir = path.join(bolloon, 'persona', r.personaAgentId);
    expect(fs.readFileSync(path.join(personaDir, 'soul.md'), 'utf-8')).toBe('# soul v2');
  });

  it('migrateAllExternalAgents 只返回已迁移的源', async () => {
    write(path.join(ws(), 'SOUL.md'), '# soul');
    const reports = await migrateAllExternalAgents(deps());
    expect(reports.length).toBe(1);
    expect(reports[0].source).toBe('openclaw');
  });

  it('sha1 稳定', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('formatMigrationNotices 汇总通告', async () => {
    write(path.join(ws(), 'SOUL.md'), '# soul');
    write(path.join(ws(), 'skills', 'go', 'SKILL.md'), '---\nname: Go\n---\n\n');
    const reports = await migrateAllExternalAgents(deps());
    const notices = formatMigrationNotices(reports);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('openclaw');
    expect(notices[0]).toContain('性格 1 份');
    expect(notices[0]).toContain('技能 1 个');
  });

  it('路径纯函数', () => {
    expect(sourceRootPath('openclaw', '/h')).toBe(path.join('/h', '.openclaw'));
    expect(sourceRootPath('hermes', '/h')).toBe(path.join('/h', '.hermes'));
    expect(workspacePath('openclaw', '/h/.openclaw')).toBe(path.join('/h/.openclaw', 'workspace'));
    expect(workspacePath('hermes', '/h/.hermes')).toBe('/h/.hermes');
  });

  it('hermes 候选根优先 LOCALAPPDATA', async () => {
    const la = path.join(tmp, 'local');
    fs.mkdirSync(path.join(la, 'hermes'), { recursive: true });
    const cands = sourceRootCandidates('hermes', deps({ localAppData: la }));
    expect(cands[0]).toBe(path.join(la, 'hermes'));
    expect(await detectSource(deps({ localAppData: la }), 'hermes')).toBe(path.join(la, 'hermes'));
  });

  it('hermes 未安装在 LOCALAPPDATA 但兜底 ~/.hermes 可检测', async () => {
    write(path.join(home, '.hermes', 'SOUL.md'), '# soul');
    const la = path.join(tmp, 'empty-local');
    const got = await detectSource(deps({ localAppData: la }), 'hermes');
    expect(got).toBe(path.join(home, '.hermes'));
  });

  it('hermes persona 从 SOUL.md + memories/ 映射', async () => {
    const la = path.join(tmp, 'local');
    const hw = hermesWs(la);
    write(path.join(hw, 'SOUL.md'), '# soul');
    write(path.join(hw, 'memories', 'USER.md'), '# user');
    write(path.join(hw, 'memories', 'MEMORY.md'), '# mem');
    void hermesRoot;

    const r = await migrateExternalAgent('hermes', deps({ localAppData: la }));
    expect(r.migrated).toBe(true);
    expect(r.persona).toEqual(expect.arrayContaining(['soul.md', 'user.md', 'wiki.md']));
    const personaDir = path.join(bolloon, 'persona', r.personaAgentId);
    expect(fs.readFileSync(path.join(personaDir, 'soul.md'), 'utf-8')).toBe('# soul');
    expect(fs.readFileSync(path.join(personaDir, 'wiki.md'), 'utf-8')).toBe('# mem');
  });

  it('hermes 分类 skills 展平为 <分类>-<技能>', async () => {
    const la = path.join(tmp, 'local');
    const hw = hermesWs(la);
    write(path.join(hw, 'SOUL.md'), '# soul');
    // devops/windows-background-jobs/SKILL.md + references
    write(path.join(hw, 'skills', 'devops', 'windows-background-jobs', 'SKILL.md'), '---\nname: wbj\n---\n\nbody');
    write(path.join(hw, 'skills', 'devops', 'windows-background-jobs', 'references', 'r.md'), 'ref');
    write(path.join(hw, 'skills', 'research', 'web-search', 'SKILL.md'), '---\nname: ws\n---\n\nsearch');

    const r = await migrateExternalAgent('hermes', deps({ localAppData: la }));
    expect(r.skillsCopied).toContain('devops-windows-background-jobs');
    expect(r.skillsCopied).toContain('research-web-search');
    const dest = path.join(bolloon, 'skills', 'devops-windows-background-jobs');
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'references', 'r.md'))).toBe(true);
  });
});
