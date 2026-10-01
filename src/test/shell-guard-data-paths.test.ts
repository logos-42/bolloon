/**
 * 数据目录护栏不许误伤只读命令 (2026-10-01, 用户报「偶尔会出反水 bug」)。
 *
 * 实测症状: agent 执行一条普通命令被 `[terminal-guard]` 拒, 理由却是
 *   「命令会重启或杀死 bolloon 宿主服务 (模式 /[\/\s]\.bolloon\b/) —— 会形成 supervisor 复活循环」。
 * 根因两条: ① 那个模式匹配**任何**含 .bolloon 的路径 ⇒ ls/cat/grep 这种只读命令全被拒;
 *           ② 归类靠"模式串里有没有 bolloon 等词"猜 ⇒ 数据目录那条含 ".bolloon" 被误判成自生命周期,
 *              报错文案把方向指错。
 * 本门钉住收窄后的口径: 写/删/移/重定向 → 拒(且理由不说"杀宿主"); 读 → 一律放行。
 */
import { describe, it, expect } from 'vitest';
import { checkTerminalCommand } from '../agents/shell-guard.js';

describe('数据目录护栏: 只拦写/删/移, 不误伤只读', () => {
  it('放行: 只读命令 (此前全被误拒)', () => {
    for (const cmd of [
      'ls ~/.bolloon/',
      'ls -la .bolloon/persona/',
      'cat .bolloon/active-channel.json',
      'grep -rn persona .bolloon/sessions/channels.json',
      'find ~/.bolloon -name "*.json" | head',
      'du -sh ~/.bolloon',
      'stat .bolloon/chain.json',
      'mkdir -p ~/.bolloon/persona/agent-x',
      'ls ~/.diap/',
      'cat .hermes/config.yaml',
    ]) {
      expect(checkTerminalCommand(cmd).allowed, `应放行却被拒: ${cmd}`).toBe(true);
    }
  });

  it('仍然拦: 删/移/截断/重定向写这些数据目录', () => {
    for (const cmd of ['rm .bolloon/identity.json', 'rm -rf ~/.bolloon', 'mv .bolloon .bolloon.bak', 'truncate -s 0 .bolloon/chain.json', '> .bolloon/chain.json', 'echo x >> .bolloon/chain.json', 'rm .hermes/identity.json']) {
      expect(checkTerminalCommand(cmd).allowed, `应拒却放行: ${cmd}`).toBe(false);
    }
  });

  it('理由不许指错方向: 数据目录的拒不许说"会重启/杀死宿主服务"', () => {
    const r = checkTerminalCommand('rm .bolloon/identity.json');
    expect(r.allowed).toBe(false);
    expect(r.reason).not.toContain('重启或杀死');
  });

  it('自生命周期命令仍然拦, 且理由确实是"重启/杀死宿主"', () => {
    for (const cmd of ['bolloon restart', 'pm2 restart bolloon', 'systemctl stop bolloon', 'pkill -f bolloon']) {
      const r = checkTerminalCommand(cmd);
      expect(r.allowed, `应拒却放行: ${cmd}`).toBe(false);
      expect(r.reason, `理由指错: ${cmd}`).toContain('重启或杀死');
    }
  });
});
