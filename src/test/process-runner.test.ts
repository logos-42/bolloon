/**
 * process-runner.test.ts — 2026-08-12 (TaskD)
 *
 * 长期运行 block 问题解决 (hermes terminal background session + poll/wait/kill):
 *   - spawnBackground 后台启动不阻塞, 立即返回 session_id
 *   - pollSession 查状态不阻塞
 *   - waitSession 等结束
 *   - killSession 终止
 */
import { describe, it, expect } from 'vitest';
import { spawnBackground, pollSession, waitSession, killSession, listSessions, isValidSessionId } from '../agents/process-runner.js';

const SLEEP_CMD = process.platform === 'win32'
  ? 'ping -n 3 127.0.0.1 > nul'
  : 'sleep 1';

describe('process-runner (后台进程管理, TaskD)', () => {
  it('spawnBackground 立即返回 session (不阻塞)', async () => {
    const s = spawnBackground('echo hello-taskd', process.cwd());
    expect(s.id).toBeTruthy();
    expect(isValidSessionId(s.id)).toBe(true);
    expect(s.status).toBe('running');
  });

  it('waitSession 等命令结束并拿到输出', async () => {
    const s = spawnBackground('echo done-marker', process.cwd());
    const r = await waitSession(s.id, 10000);
    expect(r.ok).toBe(true);
    expect(r.session.status).toBe('exited');
    expect(r.session.output).toContain('done-marker');
  });

  it('pollSession 查状态不阻塞', async () => {
    const s = spawnBackground('echo poll-marker', process.cwd());
    const r = pollSession(s.id);
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    expect(r.session!.id).toBe(s.id);
  });

  it('killSession 终止长时间运行进程', async () => {
    const s = spawnBackground(SLEEP_CMD, process.cwd());
    const r = killSession(s.id);
    expect(r.ok).toBe(true);
    const p = pollSession(s.id);
    expect(['killed', 'exited', 'error']).toContain(p.session!.status);
  });

  it('listSessions 列出全部后台进程', async () => {
    const before = listSessions().length;
    spawnBackground('echo x', process.cwd());
    expect(listSessions().length).toBeGreaterThanOrEqual(before + 1);
  });

  it('未知 session 查询返回 found=false', () => {
    const r = pollSession('proc-nonexistent');
    expect(r.found).toBe(false);
  });
});
