/**
 * kernel-ha.test.ts — Kernel 双活 (心跳仲裁 + 守护编排) 门 (2026-10-16, leo: 双内核冗余)
 *
 * 纯函数门 (ha-arbiter):
 *   · parseHeartbeat: 好/坏/畸形 → fail-closed
 *   · isHeartbeatStale: lastBeat 超期 / pid 死 → 过期; 新鲜 → 存活
 *   · decideTakeover: 缺失/坏/过期 → 接管; 存活 → 让位
 *   · acquirePrimaryLock: 原子创建 / 已持 / 陈旧回收
 *   · collectActiveRunIds: 扫 runs 目录 status 白名单
 *
 * 编排门 (ha-guard, 端口注入):
 *   · primary: 只写心跳, 不探测 (action=noop)
 *   · standby + primary 存活: 待命 (action=beat), 不接管
 *   · standby + primary 死: 接管 (reconcileOrphans → prepareResume → 心跳切 primary)
 *   · 锁被占 (另一进程活着): 不接管
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let HOME_TMP = '';

beforeEach(() => {
  HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-ha-test-'));
  process.env.BOLLOON_HOME = HOME_TMP;
});

afterEach(() => {
  fs.rmSync(HOME_TMP, { recursive: true, force: true });
  delete process.env.BOLLOON_HOME;
});

describe('ha-arbiter (心跳仲裁纯函数)', () => {
  it('parseHeartbeat: 好记录 / 坏 JSON / 缺字段 / 坏 role 分类', async () => {
    const { parseHeartbeat } = await import('../kernel/ha/ha-arbiter.js');
    const good = { pid: 123, host: 'h', role: 'primary', startedAt: '2026-01-01T00:00:00Z', lastBeat: '2026-01-01T00:00:00Z', runIds: ['run_1'], kernelVersion: '1' };
    expect(parseHeartbeat(JSON.stringify(good)).ok).toBe(true);
    expect(parseHeartbeat('{not json').ok).toBe(false);
    expect(parseHeartbeat(JSON.stringify({ pid: 1 })).ok).toBe(false); // 缺字段
    expect(parseHeartbeat(JSON.stringify({ ...good, role: 'boss' })).ok).toBe(false); // 坏 role
  });

  it('isHeartbeatStale: 超期 → stale; 新鲜 + pid 活 → 存活', async () => {
    const { isHeartbeatStale, STALE_MS } = await import('../kernel/ha/ha-arbiter.js');
    const now = Date.now();
    const fresh = { pid: process.pid, host: 'h', role: 'primary', startedAt: new Date(now - 1000).toISOString(), lastBeat: new Date(now - 1000).toISOString(), runIds: [], kernelVersion: '' };
    expect(isHeartbeatStale(fresh, now, STALE_MS)).toBe(false);
    const old = { ...fresh, lastBeat: new Date(now - STALE_MS - 1000).toISOString() };
    expect(isHeartbeatStale(old, now, STALE_MS)).toBe(true);
  });

  it('decideTakeover: 缺失/坏/过期 → 接管; 存活 → 让位', async () => {
    const { decideTakeover, isHeartbeatStale } = await import('../kernel/ha/ha-arbiter.js');
    expect(decideTakeover(null).takeover).toBe(true);
    expect(decideTakeover({ ok: false, error: 'bad' }).takeover).toBe(true);
    const now = Date.now();
    const fresh = { pid: process.pid, host: 'h', role: 'primary', startedAt: new Date(now - 500).toISOString(), lastBeat: new Date(now - 500).toISOString(), runIds: [], kernelVersion: '' };
    expect(decideTakeover({ ok: true, record: fresh }, now).takeover).toBe(false);
    const dead = { ...fresh, pid: 99999999 }; // pid 不存在
    expect(decideTakeover({ ok: true, record: dead }, now).takeover).toBe(true);
  });

  it('acquirePrimaryLock: 原子创建成功 → 二次获取被拒 → 陈旧回收后可再拿', async () => {
    const { acquirePrimaryLock, primaryLockPath } = await import('../kernel/ha/ha-arbiter.js');
    const home = HOME_TMP;
    // 第一次: 用本进程真实 pid 持有 (必然存活 → 二次获取必须被拒)
    const first = await acquirePrimaryLock(process.pid, 'h', home);
    expect(first.acquired).toBe(true);
    const second = await acquirePrimaryLock(222, 'h', home);
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain('held');
    // 覆盖成死 pid 的陈旧锁 → 回收后能拿
    fs.writeFileSync(primaryLockPath(home), JSON.stringify({ pid: 99999999, host: 'h', at: new Date().toISOString() }));
    const third = await acquirePrimaryLock(333, 'h', home);
    expect(third.acquired).toBe(true);
    expect(third.reason).toContain('reclaim');
  });

  it('collectActiveRunIds: 只收 running/recovering/interrupted, 跳过 .bak/坏文件', async () => {
    const { collectActiveRunIds } = await import('../kernel/ha/ha-arbiter.js');
    const runsDir = path.join(HOME_TMP, '.bolloon', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'run_a.json'), JSON.stringify({ status: 'running' }));
    fs.writeFileSync(path.join(runsDir, 'run_b.json'), JSON.stringify({ status: 'interrupted' }));
    fs.writeFileSync(path.join(runsDir, 'run_c.json'), JSON.stringify({ status: 'done' }));
    fs.writeFileSync(path.join(runsDir, 'run_d.json.bak'), JSON.stringify({ status: 'running' }));
    fs.writeFileSync(path.join(runsDir, 'run_e.json'), '{bad json');
    const ids = await collectActiveRunIds(runsDir);
    expect(ids.sort()).toEqual(['run_a', 'run_b']);
  });
});

describe('ha-guard (守护编排, 端口注入)', () => {
  it('primary: 只写心跳, 不探测 (action=noop)', async () => {
    const { guardTick } = await import('../kernel/ha/ha-guard.js');
    const state = { running: true, role: 'primary' as const, beats: 0, takeovers: 0, lastBeatAt: null, adoptedRunIds: [] };
    const r = await guardTick({
      reconcileOrphans: async () => ({ interrupted: [], stillRunning: [], failed: [] }),
      prepareResume: async () => ({ ok: true }),
    }, { role: 'primary', home: HOME_TMP }, state);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(path.join(HOME_TMP, '.bolloon', 'kernel-ha', 'primary.heartbeat'))).toBe(true);
  });

  it('standby + primary 存活: 待命不接管 (action=beat)', async () => {
    const { guardTick, makeHeartbeat } = await import('../kernel/ha/ha-guard.js');
    const { writeHeartbeat } = await import('../kernel/ha/ha-arbiter.js');
    // 先写一个新鲜的 primary 心跳 (pid = 本进程, 存活)
    await writeHeartbeat(makeHeartbeat('primary', [], 'test'), HOME_TMP);
    const state = { running: true, role: 'standby' as const, beats: 0, takeovers: 0, lastBeatAt: null, adoptedRunIds: [] };
    const r = await guardTick({
      reconcileOrphans: async () => { throw new Error('不该调 reconcile'); },
      prepareResume: async () => { throw new Error('不该调 prepare'); },
    }, { role: 'standby', home: HOME_TMP }, state);
    expect(r.action).toBe('beat');
    expect(fs.existsSync(path.join(HOME_TMP, '.bolloon', 'kernel-ha', 'standby.heartbeat'))).toBe(true);
  });

  it('standby + primary 死: 接管 (reconcile → prepareResume → 心跳切 primary)', async () => {
    const { guardTick } = await import('../kernel/ha/ha-guard.js');
    // 写一个过期 primary 心跳 (pid 不存在)
    const ha = path.join(HOME_TMP, '.bolloon', 'kernel-ha');
    fs.mkdirSync(ha, { recursive: true });
    fs.writeFileSync(path.join(ha, 'primary.heartbeat'), JSON.stringify({
      pid: 99999999, host: 'h', role: 'primary',
      startedAt: new Date(Date.now() - 100000).toISOString(),
      lastBeat: new Date(Date.now() - 100000).toISOString(),
      runIds: ['run_orphan'], kernelVersion: 'test',
    }));
    let reconciled = false;
    let resumed: string[] = [];
    const state = { running: true, role: 'standby' as const, beats: 0, takeovers: 0, lastBeatAt: null, adoptedRunIds: [] };
    const r = await guardTick({
      reconcileOrphans: async () => { reconciled = true; return { interrupted: ['run_orphan'], stillRunning: [], failed: [] }; },
      prepareResume: async (id) => { resumed.push(id); return { ok: true }; },
    }, { role: 'standby', home: HOME_TMP }, state);
    expect(r.action).toBe('takeover');
    expect(reconciled).toBe(true);
    expect(resumed).toEqual(['run_orphan']);
    expect(state.role).toBe('primary');
    expect(state.takeovers).toBe(1);
    // 心跳已切 primary
    const beat = JSON.parse(fs.readFileSync(path.join(ha, 'primary.heartbeat'), 'utf-8'));
    expect(beat.role).toBe('primary');
    expect(beat.runIds).toContain('run_orphan');
  });

  it('standby + 锁被活着的另一进程持有: 不接管 (防双主)', async () => {
    const { guardTick } = await import('../kernel/ha/ha-guard.js');
    const ha = path.join(HOME_TMP, '.bolloon', 'kernel-ha');
    fs.mkdirSync(ha, { recursive: true });
    fs.writeFileSync(path.join(ha, 'primary.heartbeat'), JSON.stringify({
      pid: 99999999, host: 'h', role: 'primary',
      startedAt: new Date(Date.now() - 100000).toISOString(),
      lastBeat: new Date(Date.now() - 100000).toISOString(),
      runIds: [], kernelVersion: 'test',
    }));
    // 本进程先持有主锁 (模拟另一备进程已抢到)
    fs.writeFileSync(path.join(ha, '.primary.lock'), JSON.stringify({ pid: process.pid, host: 'h', at: new Date().toISOString() }));
    const state = { running: true, role: 'standby' as const, beats: 0, takeovers: 0, lastBeatAt: null, adoptedRunIds: [] };
    let called = false;
    const r = await guardTick({
      reconcileOrphans: async () => { called = true; return { interrupted: [], stillRunning: [], failed: [] }; },
      prepareResume: async () => ({ ok: true }),
    }, { role: 'standby', home: HOME_TMP }, state);
    expect(r.action).toBe('noop');
    expect(called).toBe(false); // 锁没抢到 → 不执行接管
  });
});