/**
 * terminal-tool.test.ts — 2026-08-10: terminal 工具 + checkTerminalCommand 宽松护栏
 *
 * 用户要求: bolloon 自己写命令进 terminal, 少围栏, 核心不碰不搞乱.
 * 设计: denylist-only — 管道/重定向/写文件/任意命令放行; 只挡高危破坏 (提权/格式化/删根/.bolloon 数据).
 */
import { describe, it, expect } from 'vitest';
import { checkTerminalCommand } from '../agents/shell-guard.js';

describe('checkTerminalCommand (宽松护栏, denylist-only)', () => {
  it('放行: 普通命令 / 管道 / 重定向写文件 / 写 /tmp', () => {
    expect(checkTerminalCommand('ls -la').allowed).toBe(true);
    expect(checkTerminalCommand('echo hello | grep hello').allowed).toBe(true);
    expect(checkTerminalCommand('mkdir -p /tmp/site && echo "<html>hi</html>" > /tmp/site/index.html').allowed).toBe(true);
    expect(checkTerminalCommand('python3 -c "print(1)"').allowed).toBe(true);
    expect(checkTerminalCommand('npm install --save-dev vitest').allowed).toBe(true);
    expect(checkTerminalCommand('cat /etc/hosts').allowed).toBe(true);
    expect(checkTerminalCommand('rm /tmp/old.txt').allowed).toBe(true); // 删单个文件允许
  });

  it('拒绝: 提权 / 格式化 / 删根 / .bolloon 数据', () => {
    expect(checkTerminalCommand('sudo rm -rf /').allowed).toBe(false);
    expect(checkTerminalCommand('echo x | sudo tee /etc/hosts').allowed).toBe(false);
    expect(checkTerminalCommand('mkfs.ext4 /dev/sda1').allowed).toBe(false);
    expect(checkTerminalCommand('shred /dev/sda').allowed).toBe(false);
    expect(checkTerminalCommand('rm -rf ~').allowed).toBe(false);
    expect(checkTerminalCommand('rm -rf /tmp/*').allowed).toBe(false); // rm -rf 通配禁
    expect(checkTerminalCommand('rm -rf .bolloon').allowed).toBe(false);
    expect(checkTerminalCommand('echo x > ~/.bolloon/config.json').allowed).toBe(false);
    expect(checkTerminalCommand('git push --force origin master').allowed).toBe(false);
    expect(checkTerminalCommand('git reset --hard HEAD').allowed).toBe(false);
    expect(checkTerminalCommand('kill -9 1234').allowed).toBe(false);
  });

  it('拒绝原因可读 (提示核心不碰)', () => {
    const r = checkTerminalCommand('sudo anything');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('核心不碰');
  });
});
