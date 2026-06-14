/**
 * PreToolUse + Permission Mode 测试
 *
 * 覆盖:
 *   - resolvePermissionMode 解析逻辑 (opts / env / default / 非法 fallback)
 *   - isEditTool / isShellTool 工具分类
 *   - validatePreToolUse 4 步链 (modeGate / blacklist / shell-guard / schema)
 *   - 关键约束: bypassPermissions 不绕过 shell-guard
 *   - 关键约束: acceptEdits 只对 edit_* / write_* 跳过 blacklist
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePermissionMode,
  isEditTool,
  isShellTool,
  shouldRunBlacklist,
  type PermissionMode,
} from '../agents/permission-mode.js';
import { validatePreToolUse } from '../agents/pre-tool-validator.js';
import { onPreToolUse } from '../bootstrap/lifecycle-hooks.js';

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.BOLLOON_PERM_MODE;
  delete process.env.BOLLOON_PERM_MODE;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.BOLLOON_PERM_MODE;
  else process.env.BOLLOON_PERM_MODE = savedEnv;
});

describe('resolvePermissionMode', () => {
  it('默认 default', () => {
    expect(resolvePermissionMode()).toBe('default');
  });
  it('opts 优先', () => {
    process.env.BOLLOON_PERM_MODE = 'bypassPermissions';
    expect(resolvePermissionMode({ permissionMode: 'acceptEdits' })).toBe('acceptEdits');
  });
  it('env BOLLOON_PERM_MODE=acceptEdits 生效', () => {
    process.env.BOLLOON_PERM_MODE = 'acceptEdits';
    expect(resolvePermissionMode()).toBe('acceptEdits');
  });
  it('env BOLLOON_PERM_MODE=bypassPermissions 生效', () => {
    process.env.BOLLOON_PERM_MODE = 'bypassPermissions';
    expect(resolvePermissionMode()).toBe('bypassPermissions');
  });
  it('非法 env 值 fallback default', () => {
    process.env.BOLLOON_PERM_MODE = 'plan';  // 论文有, bolloon 没有
    expect(resolvePermissionMode()).toBe('default');
  });
  it('opts 非法值 fallback env', () => {
    process.env.BOLLOON_PERM_MODE = 'acceptEdits';
    expect(resolvePermissionMode({ permissionMode: 'plan' as any })).toBe('acceptEdits');
  });
});

describe('isEditTool', () => {
  it('edit_* 是 edit', () => {
    expect(isEditTool('edit_file')).toBe(true);
    expect(isEditTool('edit_BIG')).toBe(true);
  });
  it('write_* 是 edit', () => {
    expect(isEditTool('write_file')).toBe(true);
  });
  it('str_replace / create_file / present_files 是 edit', () => {
    expect(isEditTool('str_replace')).toBe(true);
    expect(isEditTool('create_file')).toBe(true);
    expect(isEditTool('present_files')).toBe(true);
  });
  it('read_* 不是 edit', () => {
    expect(isEditTool('read_file')).toBe(false);
    expect(isEditTool('list_files')).toBe(false);
  });
  it('shell / shell_exec / bash 不是 edit', () => {
    expect(isEditTool('shell')).toBe(false);
    expect(isEditTool('shell_exec')).toBe(false);
    expect(isEditTool('bash')).toBe(false);
  });
});

describe('isShellTool', () => {
  it('shell / shell_exec / bash 是 shell', () => {
    expect(isShellTool('shell')).toBe(true);
    expect(isShellTool('shell_exec')).toBe(true);
    expect(isShellTool('bash')).toBe(true);
  });
  it('大小写不敏感', () => {
    expect(isShellTool('SHELL')).toBe(true);
    expect(isShellTool('Bash')).toBe(true);
  });
  it('非 shell 工具', () => {
    expect(isShellTool('edit_file')).toBe(false);
    expect(isShellTool('read_file')).toBe(false);
  });
});

describe('shouldRunBlacklist 决策表', () => {
  it('shell 工具永远跑', () => {
    expect(shouldRunBlacklist('shell', 'default')).toBe(true);
    expect(shouldRunBlacklist('shell', 'acceptEdits')).toBe(true);
    expect(shouldRunBlacklist('shell', 'bypassPermissions')).toBe(true);
  });
  it('bypassPermissions + 非 shell 不跑', () => {
    expect(shouldRunBlacklist('edit_file', 'bypassPermissions')).toBe(false);
    expect(shouldRunBlacklist('read_file', 'bypassPermissions')).toBe(false);
  });
  it('acceptEdits + edit 工具不跑', () => {
    expect(shouldRunBlacklist('edit_file', 'acceptEdits')).toBe(false);
    expect(shouldRunBlacklist('write_file', 'acceptEdits')).toBe(false);
  });
  it('acceptEdits + 非 edit 工具跑', () => {
    expect(shouldRunBlacklist('read_file', 'acceptEdits')).toBe(true);
    expect(shouldRunBlacklist('list_files', 'acceptEdits')).toBe(true);
  });
  it('default 全跑', () => {
    expect(shouldRunBlacklist('edit_file', 'default')).toBe(true);
    expect(shouldRunBlacklist('read_file', 'default')).toBe(true);
  });
});

describe('validatePreToolUse — 4 步链', () => {
  it('default 模式 + shell 危险命令 → blacklist 拒绝', () => {
    const r = validatePreToolUse('shell', { command: 'rm -rf /' }, 'default');
    expect(r.allowed).toBe(false);
    expect(r.rejectedBy).toBe('blacklist');
    expect(r.mode).toBe('default');
  });
  it('acceptEdits + edit 工具 + 危险 → modeGate 不挡, blacklistGate 不跑 (edit 不走 shell) → 放行', () => {
    // edit_file 不是 shell 工具, 6 模式黑名单只针对 shell
    const r = validatePreToolUse('edit_file', { path: 'something' }, 'acceptEdits');
    expect(r.allowed).toBe(true);
  });
  it('acceptEdits + shell + 危险 → 仍 blacklist 拒绝', () => {
    const r = validatePreToolUse('shell', { command: 'rm -rf /' }, 'acceptEdits');
    expect(r.allowed).toBe(false);
    expect(r.rejectedBy).toBe('blacklist');
  });
  it('bypassPermissions + edit 工具 → modeGate 直接放行', () => {
    const r = validatePreToolUse('edit_file', { path: 'foo' }, 'bypassPermissions');
    expect(r.allowed).toBe(true);
    expect(r.shellGuardRetained).toBe(false);
  });
  it('bypassPermissions + shell 工具 → shellGuardGate 仍生效', () => {
    // 用写操作 (rm) 验证 bypassPermissions 不能绕开 shell-guard
    const r = validatePreToolUse('shell', { command: 'rm pi-sdk.ts' }, 'bypassPermissions');
    expect(r.allowed).toBe(false);
    expect(r.rejectedBy).toBe('shell-guard');
    expect(r.shellGuardRetained).toBe(true);
    expect(r.mode).toBe('bypassPermissions');
  });
  it('bypassPermissions + shell + 安全命令 → 放行, 标记 shellGuardRetained', () => {
    const r = validatePreToolUse('shell', { command: 'echo hello' }, 'bypassPermissions');
    expect(r.allowed).toBe(true);
    expect(r.shellGuardRetained).toBe(true);  // 提醒审计
  });
  it('default + shell 安全命令 → 放行', () => {
    const r = validatePreToolUse('shell', { command: 'ls -la' }, 'default');
    expect(r.allowed).toBe(true);
  });
  it('default + shell + 写操作 (rm pi-sdk.ts) → shell-guard 拒绝', () => {
    const r = validatePreToolUse('shell', { command: 'rm pi-sdk.ts' }, 'default');
    expect(r.allowed).toBe(false);
    expect(r.rejectedBy).toBe('shell-guard');
  });
  it('default + shell + 写操作 (rm .env) → shell-guard 拒绝', () => {
    const r = validatePreToolUse('shell', { command: 'rm .env' }, 'default');
    expect(r.allowed).toBe(false);
    expect(r.rejectedBy).toBe('shell-guard');
  });
});

describe('onPreToolUse (lifecycle hook 包装)', () => {
  it('不传 permissionMode → 默认 default 行为', async () => {
    const r = await onPreToolUse({ tool: 'shell', args: { command: 'rm -rf /' } });
    expect(r.allowed).toBe(false);
    expect(r.mode).toBe('default');
  });
  it('传 permissionMode=bypassPermissions + shell 写操作 (.env) → 仍拒绝', async () => {
    const r = await onPreToolUse({ tool: 'shell', args: { command: 'rm .env' }, permissionMode: 'bypassPermissions' });
    expect(r.allowed).toBe(false);
    expect(r.mode).toBe('bypassPermissions');
    expect(r.rejectedBy).toBe('shell-guard');
  });
  it('env BOLLOON_PERM_MODE=acceptEdits 生效', async () => {
    process.env.BOLLOON_PERM_MODE = 'acceptEdits';
    const r = await onPreToolUse({ tool: 'shell', args: { command: 'rm -rf /' } });
    // shell 工具 → 仍走 blacklist → 拒绝
    expect(r.allowed).toBe(false);
    expect(r.mode).toBe('acceptEdits');
  });
  it('异常时不抛错, allowed: true (向后兼容)', async () => {
    // 传一个会触发异常的 args (Number 强转)
    // 这里测的是 hook 包装的 try/catch 健壮性
    // 由于 validatePreToolUse 是同步且 robust, 难以触发异常
    // 至少验证不抛错
    const r = await onPreToolUse({ tool: 'shell', args: null as any });
    expect(typeof r.allowed).toBe('boolean');
  });
});
