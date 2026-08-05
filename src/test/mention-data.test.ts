/**
 * mention-data.test.ts — CLI @ / # 弹出窗数据源单测
 *
 * 覆盖: getMention 触发检测 + 四类数据加载 (智能体/技能/插件/文件) + 文件匹配评分
 * 用 tmp HOME, 不污染真实 ~/.bolloon.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  getMention,
  loadAgents,
  loadSkills,
  loadPlugins,
  loadFiles,
  matchFileScore,
  loadCommands,
} from '../cli/mention-data.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-mention-test-${Date.now()}`);
let oldHome = '';
let oldCwd = '';

describe('mention-data', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    oldCwd = process.cwd();
    process.env.HOME = tmpHome;
    // 本地 channels
    await fs.mkdir(path.join(tmpHome, '.bolloon', 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, '.bolloon', 'sessions', 'channels.json'),
      JSON.stringify([
        { id: 'ch_1', name: '本地小蓝', agentId: 'a1' },
        { id: 'ch_2', name: '测试助手', agentId: 'a2' },
      ]),
      'utf-8',
    );
    // 远端缓存
    await fs.writeFile(
      path.join(tmpHome, '.bolloon', 'remote-channels-cache.json'),
      JSON.stringify({
        deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef: [
          { id: 'ch_r1', name: '智能体小红', publicKey: 'pk1' },
          { id: 'ch_r2', name: '布露', publicKey: 'pk2' },
        ],
        abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab: [
          { id: 'ch_r3', name: '智能体小红', publicKey: 'pk3' }, // 重名 → 去重
        ],
      }),
      'utf-8',
    );
    // 技能
    await fs.mkdir(path.join(tmpHome, '.bolloon', 'skills', 'code-review'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, '.bolloon', 'skills', 'code-review', 'SKILL.md'),
      '---\nname: code-review\ndescription: 代码审查技能\n---\n\n# 步骤\n1. 审\n',
      'utf-8',
    );
    await fs.mkdir(path.join(tmpHome, '.bolloon', 'skills', 'no-desc'), { recursive: true });
    await fs.writeFile(path.join(tmpHome, '.bolloon', 'skills', 'no-desc', 'SKILL.md'), '# 无 frontmatter', 'utf-8');
    // 插件 (MCP)
    await fs.writeFile(
      path.join(tmpHome, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'echo-mcp': { command: 'python3', args: ['s.py'] }, 'time-mcp': { command: 'date' } } }),
      'utf-8',
    );
    // 文件树 (临时 cwd)
    const tree = path.join(tmpHome, 'tree');
    await fs.mkdir(path.join(tree, 'src', 'cli'), { recursive: true });
    await fs.mkdir(path.join(tree, 'src', 'web'), { recursive: true });
    await fs.mkdir(path.join(tree, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(tree, '.git'), { recursive: true });
    await fs.writeFile(path.join(tree, 'src', 'cli', 'ink-app.tsx'), 'x');
    await fs.writeFile(path.join(tree, 'src', 'cli', 'mention-data.ts'), 'x');
    await fs.writeFile(path.join(tree, 'src', 'web', 'server.ts'), 'x');
    await fs.writeFile(path.join(tree, 'README.md'), 'x');
    await fs.writeFile(path.join(tree, 'node_modules', 'pkg', 'index.js'), 'x');
    await fs.writeFile(path.join(tree, '.git', 'config'), 'x');
    process.chdir(tree);
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    if (oldCwd) process.chdir(oldCwd);
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('getMention 检测 @ / # 触发', () => {
    expect(getMention('')).toBeNull();
    expect(getMention('hello world')).toBeNull();
    expect(getMention('@')).toEqual({ kind: 'agent', query: '', start: 0, trigger: '@' });
    expect(getMention('帮我 @小')).toEqual({ kind: 'agent', query: '小', start: 3, trigger: '@' });
    expect(getMention('帮我@小')).toEqual({ kind: 'agent', query: '小', start: 2, trigger: '@' });
    expect(getMention('/que')).toEqual({ kind: 'command', query: 'que', start: 0, trigger: '/' });
    expect(getMention('再 #src/')).toEqual({ kind: 'file', query: 'src/', start: 2, trigger: '#' });
    expect(getMention('再#src/')).toEqual({ kind: 'file', query: 'src/', start: 1, trigger: '#' });
    // 非末尾 token 不触发
    expect(getMention('@小 帮我')).toBeNull();
    // 触发符后含空格 → 该 token 结束
    expect(getMention('@小 后面')).toBeNull();
    // email / 路径末尾斜杠不误触发
    expect(getMention('a@b.com')).toBeNull();
    expect(getMention('看看 src/')).toBeNull();
    expect(getMention('a#b')).toBeNull();
    // 多个触发符: 取最后一个
    expect(getMention('/plan 然后 @小')).toEqual({ kind: 'agent', query: '小', start: 9, trigger: '@' });
  });

  it('loadAgents 本地 + 远端 + 去重', async () => {
    const items = await loadAgents();
    const labels = items.map(i => `${i.kind}:${i.label}:${i.hint}`);
    expect(labels).toContain('agent:本地小蓝:本地智能体');
    expect(labels).toContain('agent:测试助手:本地智能体');
    expect(labels).toContain('agent:智能体小红:远端 · deadbeef…');
    expect(labels).toContain('agent:布露:远端 · deadbeef…');
    // 重名 (两个 peer 都有智能体小红) → 只保留一个
    expect(labels.filter(l => l.includes('智能体小红'))).toHaveLength(1);
    // 本地优先于远端
    expect(labels[0]).toBe('agent:本地小蓝:本地智能体');
  });

  it('loadCommands 内置 + Web 斜杠命令', () => {
    const cmds = loadCommands();
    const names = cmds.map(c => c.label);
    for (const n of ['queue', 'dequeue', 'help', 'exit', 'peers', 'iroh', 'add_friend', 'plan', 'todo', 'review', 'task', 'goal', 'skill', 'add-friend']) {
      expect(names).toContain(n);
    }
  });

  it('loadSkills 读目录 + description', async () => {
    const skills = await loadSkills();
    const sr = skills.find(s => s.label === 'code-review');
    expect(sr).toBeDefined();
    expect(sr!.kind).toBe('skill');
    expect(sr!.hint).toContain('代码审查');
    expect(skills.find(s => s.label === 'no-desc')).toBeDefined();
  });

  it('loadPlugins 读 .mcp.json mcpServers', async () => {
    const plugins = await loadPlugins();
    const names = plugins.map(p => p.label).sort();
    expect(names).toEqual(['echo-mcp', 'time-mcp']);
    expect(plugins[0].kind).toBe('plugin');
  });

  it('loadFiles 有限深度遍历 + 跳过 node_modules/.git', async () => {
    const files = await loadFiles('', tmpHome + '/tree');
    const labels = files.map(f => f.label);
    expect(labels).toContain('src/cli/ink-app.tsx');
    expect(labels).toContain('src/web/server.ts');
    expect(labels).toContain('README.md');
    expect(labels.some(l => l.includes('node_modules'))).toBe(false);
    expect(labels.some(l => l.includes('.git'))).toBe(false);
    expect(files.every(f => f.kind === 'file')).toBe(true);
  });

  it('loadFiles 深度上限 (maxDepth=1 只收顶层文件)', async () => {
    const files = await loadFiles('', tmpHome + '/tree', 1);
    const labels = files.map(f => f.label);
    expect(labels).toContain('README.md');
    expect(labels.some(l => l.includes('/'))).toBe(false);
  });

  it('matchFileScore 评分: basename 前缀优先', () => {
    expect(matchFileScore('src/cli/ink-app.tsx', 'ink')).toBe(0);
    expect(matchFileScore('src/cli/ink-app.tsx', 'src/cli')).toBe(1);
    expect(matchFileScore('src/other/app.ts', 'app')).toBe(0);
    expect(matchFileScore('src/other/x.ts', 'app')).toBe(-1);
  });
});
