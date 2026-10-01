/**
 * 工具参数的 ~ 展开 (2026-10-01, 用户实测)。
 *
 * 症状: 智能体调 `list_files { path: "~/.bolloon" }` ⇒ ENOENT: no such file or directory, scandir '~/.bolloon'
 * 根因: 全仓没有一处做 ~ 展开 ⇒ 模型写的 `~/x` 原样进 fs, 变成字面目录名。
 * 修法: 在唯一分发点 (pi-sdk.ts 的 tool.execute) 统一展开, 只碰路径类参数。
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandTilde, expandHomeArgs, expandKnownAliases } from '../agents/tool-path-args.js';

const H = os.homedir();

describe('expandTilde', () => {
  it('用户踩到的那条: `~/.bolloon` 必须变成 HOME 下的真路径', () => {
    expect(expandTilde('~/.bolloon')).toBe(path.join(H, '.bolloon'));
    expect(expandTilde('~/.bolloon/sessions/channels.json')).toBe(path.join(H, '.bolloon/sessions/channels.json'));
  });
  it('单独的 `~` ⇒ HOME', () => expect(expandTilde('~')).toBe(H));
  it('**不碰**: `~user` · 中间的 `~` · 绝对路径 · 相对路径', () => {
    for (const s of ['~root/x', 'a~b', '/tmp/x', './x', 'src/agents/a.ts', '']) expect(expandTilde(s)).toBe(s);
  });
});

describe('已知别名 .bolloon (用户实测 list_files 「.bolloon」 报 ENOENT)', () => {
  it('.bolloon / .bolloon/... ⇒ 数据目录', () => {
    expect(expandKnownAliases('.bolloon')).toBe(path.join(H, '.bolloon'));
    expect(expandKnownAliases('.bolloon/sessions/channels.json')).toBe(path.join(H, '.bolloon/sessions/channels.json'));
  });
  it('**不碰** foo/.bolloon (避免误伤同名目录) 与其他相对路径', () => {
    for (const s of ['foo/.bolloon', './x', 'a.bolloon', '']) expect(expandKnownAliases(s)).toBe(s);
  });
  it('经 expandHomeArgs 也生效', () => {
    expect(expandHomeArgs({ path: '.bolloon' }).path).toBe(path.join(H, '.bolloon'));
  });
});

describe('expandHomeArgs', () => {
  it('用户踩到的那条: list_files 的 path', () => {
    const out = expandHomeArgs({ path: '~/.bolloon' });
    expect(out.path).toBe(path.join(H, '.bolloon'));
  });
  it('数组参数 (paths) 逐个展开', () => {
    expect(expandHomeArgs({ paths: ['~/a', '/b', '~'] }).paths).toEqual([path.join(H, 'a'), '/b', H]);
  });
  it('**非路径参数一个字都不动** (不许误伤正文/pattern/命令)', () => {
    const out = expandHomeArgs({ content: '看 ~/.bolloon 这个目录', pattern: '~/x', command: 'ls ~/x', path: '~/y' });
    expect(out.content).toBe('看 ~/.bolloon 这个目录');
    expect(out.pattern).toBe('~/x');
    expect(out.command).toBe('ls ~/x');
    expect(out.path).toBe(path.join(H, 'y'));
  });
  it('未知字段原样保留 + 不修改入参对象', () => {
    const input = { path: '~/z', extra: 1 };
    const out = expandHomeArgs(input);
    expect(out.extra).toBe(1);
    expect(input.path).toBe('~/z');
  });
});
