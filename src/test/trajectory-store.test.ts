import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  TrajectoryRecorder,
  saveTrajectoryToDisk,
  saveTrajectoryToOrbit,
  recordTrajectory,
  listTrajectories,
  loadTrajectory,
} from '../orbitdb/trajectory-store.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-trajectory-test-${Date.now()}`);
let oldHome = '';

/** 内存版假 OrbitDB store (keyvalue) — 单元测试不拉起 helia */
class FakeStore implements OrbitDBStore {
  readonly address = 'fake://trajectories';
  private kv = new Map<string, unknown>();
  async put(key: string, value: unknown): Promise<void> { this.kv.set(key, value); }
  async add(_value: unknown): Promise<void> { /* noop */ }
  async all(): Promise<Array<{ key: string; value: unknown }>> {
    return Array.from(this.kv.entries()).map(([key, value]) => ({ key, value }));
  }
  async get(key: string): Promise<unknown> { return this.kv.get(key); }
  onChange(_fn: () => void): () => void { return () => { }; }
  get size(): number { return this.kv.size; }
  has(key: string): boolean { return this.kv.has(key); }
}

/** 假 CIDDatabase: 只实现 openStore (轨迹只用到它) */
function fakeDb(store: FakeStore): CIDDatabase {
  return { openStore: async () => store } as unknown as CIDDatabase;
}

describe('trajectory-store (智能体运行轨迹 → 落盘 + OrbitDB)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    await fs.mkdir(tmpHome, { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('TrajectoryRecorder: 步骤/消息采集 → endRun 产出完整轨迹', () => {
    const rec = new TrajectoryRecorder({ agentId: 'agentA', input: '帮我查文件', channelId: 'ch1', did: 'did:key:ZZZ' });
    rec.recordStep({ type: 'thinking', content: '🤔 开始思考' });
    rec.recordStep({ type: 'tool', tool: 'list_files', content: '🔧 调用工具 (1/2): list_files' });
    rec.recordStep({ type: 'tool', tool: 'list_files', content: '📤 结果: 3 个文件' });
    rec.recordStep({ type: 'status', tool: 'system', content: '🔄 结束' });
    rec.recordMessage('user', '帮我查文件');
    const run = rec.endRun('已查完: 3 个文件', 'ok');

    expect(run.runId).toContain('agentA');
    expect(run.agentId).toBe('agentA');
    expect(run.channelId).toBe('ch1');
    expect(run.did).toBe('did:key:ZZZ');
    expect(run.input).toBe('帮我查文件');
    expect(run.reply).toContain('3 个文件');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.steps.length).toBeGreaterThanOrEqual(2);
    expect(run.steps[0].kind).toBe('thinking');
    expect(run.steps.some(s => s.kind === 'tool' && s.name === 'list_files')).toBe(true);
    expect(run.messages[0].role).toBe('user');
  });

  it('重复同类型同内容状态被压缩 (防步骤爆炸)', () => {
    const rec = new TrajectoryRecorder({ agentId: 'a', input: 'x' });
    rec.recordStep({ type: 'status', tool: 'system', content: '同样' });
    rec.recordStep({ type: 'status', tool: 'system', content: '同样' });
    rec.recordStep({ type: 'status', tool: 'system', content: '不同' });
    const run = rec.endRun('ok');
    expect(run.steps.length).toBe(2);
  });

  it('endRun 后不可再记录', () => {
    const rec = new TrajectoryRecorder({ agentId: 'a', input: 'x' });
    rec.endRun('done');
    rec.recordStep({ type: 'tool', tool: 't', content: 'c' });
    rec.recordMessage('user', 'after');
    expect(rec.stepCount).toBe(0);
  });

  it('saveTrajectoryToDisk + loadTrajectory + listTrajectories 闭环', async () => {
    const rec = new TrajectoryRecorder({ agentId: 'agentB', input: 'hi', did: 'did:key:YYY' });
    rec.recordStep({ type: 'tool', tool: 'get_identity', content: '🔧 get_identity' });
    const run = rec.endRun('hello');

    const file = await saveTrajectoryToDisk(run, tmpHome);
    expect(file).toContain('.bolloon');
    expect(file).toContain('trajectories');
    const loaded = await loadTrajectory(run.runId, tmpHome);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(run.runId);
    expect(loaded!.reply).toBe('hello');
    expect(loaded!.steps).toHaveLength(1);

    const list = await listTrajectories(tmpHome);
    expect(list.some(x => x.runId === run.runId)).toBe(true);
  });

  it('saveTrajectoryToOrbit: 有 did + 假 db → put 进 keyvalue store', async () => {
    const store = new FakeStore();
    const rec = new TrajectoryRecorder({ agentId: 'a', input: 'x', did: 'did:key:ORBIT' });
    const run = rec.endRun('r');
    const ok = await saveTrajectoryToOrbit(run, { db: fakeDb(store) });
    expect(ok).toBe(true);
    expect(store.has(run.runId)).toBe(true);
    const saved = await store.get(run.runId) as any;
    expect(saved.reply).toBe('r');
    expect(saved.steps).toEqual([]);
  });

  it('saveTrajectoryToOrbit: 无 did / orbit=false / db=null → 跳过', async () => {
    const rec = new TrajectoryRecorder({ agentId: 'a', input: 'x' }); // 无 did
    const run = rec.endRun('r');
    expect(await saveTrajectoryToOrbit(run, { db: fakeDb(new FakeStore()) })).toBe(false);
    const rec2 = new TrajectoryRecorder({ agentId: 'a', input: 'x', did: 'did:key:O2' });
    const run2 = rec2.endRun('r');
    expect(await saveTrajectoryToOrbit(run2, { orbit: false, db: fakeDb(new FakeStore()) })).toBe(false);
    expect(await saveTrajectoryToOrbit(run2, { db: null })).toBe(false);
  });

  it('recordTrajectory: 落盘 + orbit 一步到位 (orbit 失败静默仍返回文件)', async () => {
    const rec = new TrajectoryRecorder({ agentId: 'agentC', input: 'q', did: 'did:key:CCC' });
    rec.recordStep({ type: 'tool', tool: 'read_document', content: '🔧 read_document' });
    const run = rec.endRun('answer');
    const file = await recordTrajectory(run, { home: tmpHome, db: null });
    expect(file).not.toBeNull();
    expect(await loadTrajectory(run.runId, tmpHome)).not.toBeNull();
  });
});
