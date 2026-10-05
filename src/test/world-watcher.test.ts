/**
 * world-watcher.test.ts — 世界观察器 + 用户画像 (2026-10-05, leo 三条分发规划)
 *
 * ① 自动触发机制: tickWorldWatcher 防重叠 · startWorldWatcher 幂等
 * ② 分发主体插槽: setDispatchSink 可装可卸
 * ③ 用户画像: setProfile/readProfile 读写 + 无画像 = null
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readProfile, setProfile } from '../agents/world-profile.js';
import { tickWorldWatcher, startWorldWatcher, stopWorldWatcher, setDispatchSink, worldWatcherStatus } from '../agents/world-watcher.js';

const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
let fakeHome: string;

async function makeFakeHome(): Promise<string> {
  const dir = path.join(os.tmpdir(), `bolloon-watch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(path.join(dir, 'world', 'memory'), { recursive: true });
  return dir;
}

beforeEach(async () => {
  fakeHome = await makeFakeHome();
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  stopWorldWatcher(); // 每个用例从干净状态开始
});

afterEach(async () => {
  stopWorldWatcher();
  setDispatchSink(null);
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe('world-profile (用户画像)', () => {
  it('没有画像 → readProfile 返回 null', async () => {
    expect(await readProfile()).toBeNull();
  });

  it('setProfile 写入 → readProfile 读回 (常驻意图落 world/profile.json)', async () => {
    const r = await setProfile({ name: 'leo', about: '做聚变仿真', tags: ['物理', 'AI'] });
    expect(r.ok).toBe(true);
    expect(r.profile.name).toBe('leo');
    const p = await readProfile();
    expect(p).not.toBeNull();
    expect(p!.tags).toContain('物理');
    const stored = JSON.parse(await fs.readFile(path.join(fakeHome, '.bolloon', 'world', 'profile.json'), 'utf-8'));
    expect(stored.name).toBe('leo');
  });

  it('setProfile 空输入 → 拒绝', async () => {
    const r = await setProfile({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('至少');
  });

  it('局部更新保留旧字段', async () => {
    await setProfile({ name: 'leo', tags: ['物理'] });
    const r = await setProfile({ about: '在做聚变' });
    expect(r.ok).toBe(true);
    expect(r.profile.name).toBe('leo'); // 旧字段保留
    expect(r.profile.about).toBe('在做聚变');
  });
});

describe('world-watcher (自动触发机制)', () => {
  it('tickWorldWatcher 扫描一轮 → 状态计数 +1', async () => {
    const r = await tickWorldWatcher();
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(worldWatcherStatus().ticks).toBe(1);
  });

  it('startWorldWatcher 幂等 — 重复调用不叠定时器', async () => {
    const a = startWorldWatcher(60000);
    const b = startWorldWatcher(60000);
    expect(a.started).toBe(true);
    expect(b.started).toBe(false); // 已有定时器, 不再叠
    expect(worldWatcherStatus().running).toBe(true);
    stopWorldWatcher();
    expect(worldWatcherStatus().running).toBe(false);
  });

  it('分发主体插槽可装可卸', () => {
    setDispatchSink(async () => {});
    expect(worldWatcherStatus().running).toBe(false); // 插槽本身不影响 watcher 状态
    setDispatchSink(null);
  });
});