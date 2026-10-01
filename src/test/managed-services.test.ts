/**
 * 常驻服务注册表 (2026-10-01, 用户: 「process 也要可以管理群聊和去中心化交流进程」)。
 * 门锁的性质: **如实分级** —— 能启停的才放行 ✓; 只能看的**明确拒绝**并给理由(绝不假装停掉 ✗);
 *   状态取值抛错也不许把列表带崩 ✓。
 */
import { describe, it, expect } from 'vitest';
import { ManagedServices } from '../agents/managed-services.js';

function mk() {
  const ms = new ManagedServices();
  let running = false;
  ms.register({
    name: 'social-heartbeat', description: '社交心跳(可启停)',
    status: () => (running ? '运行中' : '已停止'),
    start: () => { running = true; },
    stop: () => { running = false; },
  });
  ms.register({ name: 'p2p-network', description: 'P2P 网络(仅状态)', status: () => '已连接 2 个节点' });
  return { ms, isRunning: () => running };
}

describe('process 管常驻服务 (群聊/去中心化交流)', () => {
  it('列表: 标清"可启停" vs "仅状态", 并带上状态', () => {
    const { ms } = mk();
    const rows = ms.list();
    expect(rows.map((r) => r.name).sort()).toEqual(['p2p-network', 'social-heartbeat']);
    expect(rows.find((r) => r.name === 'social-heartbeat')!.controllable).toBe(true);
    expect(rows.find((r) => r.name === 'p2p-network')!.controllable).toBe(false);
    expect(ms.describe()).toContain('已连接 2 个节点');
    expect(ms.describe()).toContain('可启停');
  });
  it('能启停的: start/stop 真的生效并回状态', async () => {
    const { ms, isRunning } = mk();
    const a = await ms.control('social-heartbeat', 'start');
    expect(a.ok).toBe(true);
    expect(isRunning()).toBe(true);
    expect(a.output).toContain('运行中');
    const b = await ms.control('social-heartbeat', 'stop');
    expect(b.ok).toBe(true);
    expect(isRunning()).toBe(false);
  });
  it('★ 只能看的服务: 明确拒绝并说明理由(不假装停掉)', async () => {
    const { ms } = mk();
    const r = await ms.control('p2p-network', 'stop');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('不支持 stop');
    expect(r.output).toContain('没有独立启停');
  });
  it('不存在的服务 ⇒ 明确报错并提示怎么看有哪些', async () => {
    const { ms } = mk();
    expect((await ms.control('nope', 'stop')).output).toContain("action:'services'");
  });
  it('status 抛错 ⇒ 列表照常, 该行标为取状态失败', () => {
    const ms = new ManagedServices();
    ms.register({ name: 'bad', description: 'x', status: () => { throw new Error('boom'); } });
    const rows = ms.list();
    expect(rows[0].status).toContain('取状态失败');
  });
});
