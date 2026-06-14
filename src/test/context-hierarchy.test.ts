/**
 * Context Hierarchy — 4 级 Bolloon.md 查找 + 合并测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  collectHierarchyLayers,
  mergeHierarchyLayers,
  resolveUserPath,
  resolveProjectPaths,
  DEFAULT_MAX_CHARS,
  DEFAULT_MERGE_MAX_CHARS,
  type HierarchyLayers,
} from '../bootstrap/context-hierarchy.js';

let TEST_DIR: string;
let CWD: string;

beforeEach(async () => {
  TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-hierarchy-'));
  CWD = path.join(TEST_DIR, 'project');
  await fs.mkdir(CWD, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

async function writeFile(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

describe('Context Hierarchy', () => {
  describe('路径解析', () => {
    it('resolveUserPath 用 process.env.HOME', () => {
      const original = process.env.HOME;
      process.env.HOME = '/tmp/fake-home';
      try {
        expect(resolveUserPath()).toBe('/tmp/fake-home/.bolloon/Bolloon.md');
      } finally {
        if (original === undefined) delete process.env.HOME;
        else process.env.HOME = original;
      }
    });

    it('resolveUserPath 接受显式 home', () => {
      expect(resolveUserPath('/custom')).toBe('/custom/.bolloon/Bolloon.md');
    });

    it('resolveProjectPaths 返回 3 个路径', () => {
      const r = resolveProjectPaths('/proj');
      expect(r.project).toBe('/proj/Bolloon.md');
      expect(r.projectRulesDir).toBe('/proj/.claude/rules');
      expect(r.local).toBe('/proj/CLAUDE.local.md');
    });
  });

  describe('collectHierarchyLayers — 文件查找', () => {
    it('全部缺失返回全 null', async () => {
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers).toEqual({ managed: null, user: null, project: null, local: null });
    });

    it('读到 user 层', async () => {
      const userPath = path.join(TEST_DIR, '.bolloon', 'Bolloon.md');
      await writeFile(userPath, 'user rule content');
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers.user).toBe('user rule content');
      expect(layers.managed).toBeNull();
      expect(layers.project).toBeNull();
      expect(layers.local).toBeNull();
    });

    it('读到 project 层 (Bolloon.md)', async () => {
      await writeFile(path.join(CWD, 'Bolloon.md'), 'project rule');
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers.project).toBe('project rule');
    });

    it('project 层 fallback 到 Bolloon.md', async () => {
      await writeFile(path.join(CWD, 'Bolloon.md'), 'bolloon-md fallback content');
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers.project).toBe('bolloon-md fallback content');
    });

    it('Bolloon.md 单文件 (CLAUDE.md 已合并到 Bolloon.md)', async () => {
      // 4 级层次统一用 Bolloon.md (Claude Code 的 CLAUDE.md 已合并到本文件名)
      await writeFile(path.join(CWD, 'Bolloon.md'), 'unified-content');
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers.project).toBe('unified-content');
    });

    it('project 层支持 .claude/rules/*.md 合并', async () => {
      await writeFile(path.join(CWD, '.claude', 'rules', 'a.md'), 'rule A content');
      await writeFile(path.join(CWD, '.claude', 'rules', 'b.md'), 'rule B content');
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers.project).toContain('rule A content');
      expect(layers.project).toContain('rule B content');
      expect(layers.project).toContain('### a');
      expect(layers.project).toContain('### b');
    });

    it('读到 local 层', async () => {
      await writeFile(path.join(CWD, 'CLAUDE.local.md'), 'local override');
      const layers = await collectHierarchyLayers({ cwd: CWD, home: TEST_DIR });
      expect(layers.local).toBe('local override');
    });

    it('4 层都读到', async () => {
      // managed 用 paths override (避免写 /etc)
      const managedPath = path.join(TEST_DIR, 'etc', 'bolloon', 'Bolloon.md');
      await writeFile(managedPath, 'managed rule');
      await writeFile(path.join(TEST_DIR, '.bolloon', 'Bolloon.md'), 'user rule');
      await writeFile(path.join(CWD, 'Bolloon.md'), 'project rule');
      await writeFile(path.join(CWD, 'CLAUDE.local.md'), 'local rule');

      const layers = await collectHierarchyLayers({
        cwd: CWD,
        home: TEST_DIR,
        limits: { paths: { managed: managedPath } },
      });
      expect(layers.managed).toBe('managed rule');
      expect(layers.user).toBe('user rule');
      expect(layers.project).toBe('project rule');
      expect(layers.local).toBe('local rule');
    });
  });

  describe('collectHierarchyLayers — 字符上限', () => {
    it('超过 maxChars 截断', async () => {
      const long = 'x'.repeat(3000);
      await writeFile(path.join(CWD, 'Bolloon.md'), long);
      const layers = await collectHierarchyLayers({
        cwd: CWD,
        home: TEST_DIR,
        limits: { maxChars: { project: 100 } },
      });
      expect(layers.project).toContain('truncated');
      expect(layers.project!.length).toBeLessThan(200);
    });
  });

  describe('mergeHierarchyLayers', () => {
    it('空 layers 返回空字符串', () => {
      expect(mergeHierarchyLayers({
        managed: null, user: null, project: null, local: null,
      })).toBe('');
    });

    it('按 managed → user → project → local 顺序拼接', () => {
      const layers: HierarchyLayers = {
        managed: 'M',
        user: 'U',
        project: 'P',
        local: 'L',
      };
      const merged = mergeHierarchyLayers(layers);
      const mIdx = merged.indexOf('管理规则');
      const uIdx = merged.indexOf('用户规则');
      const pIdx = merged.indexOf('项目规则');
      const lIdx = merged.indexOf('本地规则');
      expect(mIdx).toBeLessThan(uIdx);
      expect(uIdx).toBeLessThan(pIdx);
      expect(pIdx).toBeLessThan(lIdx);
    });

    it('只拼接存在的层', () => {
      const layers: HierarchyLayers = {
        managed: null, user: 'U only', project: null, local: null,
      };
      const merged = mergeHierarchyLayers(layers);
      expect(merged).toContain('用户规则');
      expect(merged).not.toContain('管理规则');
      expect(merged).not.toContain('项目规则');
      expect(merged).not.toContain('本地规则');
    });

    it('总长 < maxChars 时不截断', () => {
      const layers: HierarchyLayers = {
        managed: 'short', user: 'short', project: 'short', local: 'short',
      };
      const merged = mergeHierarchyLayers(layers, { maxChars: 10000 });
      expect(merged).not.toContain('truncated');
    });

    it('超限时反向截断, 优先保 managed', () => {
      const layers: HierarchyLayers = {
        managed: 'M-rules '.repeat(50),  // ~400 chars
        user: 'U-rules '.repeat(50),
        project: 'P-rules '.repeat(50),
        local: 'L-rules '.repeat(50),
      };
      const merged = mergeHierarchyLayers(layers, { maxChars: 500 });
      // managed 一定在
      expect(merged).toContain('管理规则');
      expect(merged).toContain('M-rules');
      // local 最先被砍 (或至少不该长于 managed)
      const mLen = (merged.match(/M-rules/g) ?? []).length;
      const lLen = (merged.match(/L-rules/g) ?? []).length;
      expect(mLen).toBeGreaterThanOrEqual(lLen);
    });
  });

  describe('端到端', () => {
    it('collect + merge 完整流程', async () => {
      // managed
      const managedPath = path.join(TEST_DIR, 'etc', 'bolloon', 'Bolloon.md');
      await writeFile(managedPath, 'system-level rule');
      // user
      await writeFile(path.join(TEST_DIR, '.bolloon', 'Bolloon.md'), 'user preference');
      // project
      await writeFile(path.join(CWD, 'Bolloon.md'), 'project rule');
      // local
      await writeFile(path.join(CWD, 'CLAUDE.local.md'), 'local override');

      const layers = await collectHierarchyLayers({
        cwd: CWD,
        home: TEST_DIR,
        limits: { paths: { managed: managedPath } },
      });
      const merged = mergeHierarchyLayers(layers);

      expect(merged).toContain('system-level rule');
      expect(merged).toContain('管理规则');
      expect(merged).toContain('用户规则');
      expect(merged).toContain('项目规则');
      expect(merged).toContain('本地规则');
      // 顺序
      expect(merged.indexOf('管理规则')).toBeLessThan(merged.indexOf('用户规则'));
    });
  });
});
