/**
 * default 模式下 git 工具的放行口径 (2026-10-01)。
 * 用户现场实录: `git_commit` 被权限拦 ⇒ 智能体**绕道** `shell_exec` + **`git add -A`** ✗
 *   (正是项目红线禁止的那条, 会卷走别的智能体在写的文件) ⇒ "拦住它"并没有更安全, 只是把它推去了更危险的路 ✗。
 * 契约(源级核对, 因为这是跨文件的策略常量):
 *   ① default: **只禁 git_push**(远端/不可逆), `git_commit`/`git_branch` 放行 ✓;
 *   ② acceptEdits: 仍显式禁 shell/git(那是**显式**收紧, 保留 ✗ 不改);
 *   ③ bypassPermissions: 一律放行。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/agents/deny-pipeline.ts'), 'utf-8');

describe('default 模式的 git 工具口径', () => {
  it('① 指定安全路径 git_commit/git_branch 在 default 下**不再被拦**', () => {
    const m = /DEFAULT_DENY_TOOLS = new Set<string>\(\[([\s\S]*?)\]\)/.exec(SRC);
    expect(m, '没找到默认禁列表').toBeTruthy();
    const body = m![1];
    expect(body).toContain("'git_push'");       // 远端/不可逆 ⇒ 仍然禁
    expect(body).not.toContain("'git_commit'");
    expect(body).not.toContain("'git_branch'");
  });
  it('② acceptEdits 仍显式禁 shell/git (收紧是有意为之, 不许顺手放开)', () => {
    expect(SRC).toMatch(/permissionMode === 'acceptEdits'/);
    expect(SRC).toMatch(/toolName === 'git_commit'/);
  });
  it('③ bypassPermissions 仍然一律放行', () => {
    expect(SRC).toMatch(/permissionMode === 'bypassPermissions'/);
  });
});
