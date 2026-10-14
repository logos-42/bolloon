/**
 * memory-sync — P3 条目级 OrbitDB 复制 (2026-10-11)
 * 验证: 同步条目到 orbit / 拉回还原 / LWW 合并决策 / MemoryStore.mergeRemote
 * 全部用 fake CIDDatabase (不碰真网络), 纯逻辑验证。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CIDDatabase, CIDRecord } from '../orbitdb/cid-database.js';
import { syncMemoryEntryToOrbit, fetchRemoteEntries, shouldTakeRemote, mergeRemoteEntries, entryFromRecord } from '../orbitdb/memory-sync.js';
import { MemoryStore, resetMemoryStores } from '../agents/memory-store.js';

const tmpHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sync-'));

/** 内存版 CIDDatabase 替身 (只存 type='memory' 的记录) */
class FakeCIDDB implements CIDDatabase {
  records: CIDRecord[] = [];
  async save(data: { agentId: string; type: any; content: unknown; metadata?: Record<string, unknown> }): Promise<CIDRecord> {
    const rec: CIDRecord = {
      id: `cid-${this.records.length + 1}`,
      agentId: data.agentId,
      timestamp: Date.now(),
      type: data.type,
      content: data.content,
      metadata: data.metadata || {},
      version: 1,
    };
    this.records.push(rec);
    return rec;
  }
  async load(cid: string): Promise<CIDRecord | null> {
    return this.records.find((r) => r.id === cid) || null;
  }
  async update(): Promise<CIDRecord | null> { return null; }
  async version(): Promise<CIDRecord[]> { return []; }
  async list(filter?: { agentId?: string; type?: string }): Promise<CIDRecord[]> {
    return this.records.filter((r) => {
      if (filter?.agentId && r.agentId !== filter.agentId) return false;
      if (filter?.type && r.type !== filter.type) return false;
      return true;
    });
  }
  async share(): Promise<string> { return ''; }
  async openStore(): Promise<any> { return null; }
  async openStoreByAddress(): Promise<any> { return null; }
  async close(): Promise<void> {}
}

let db: FakeCIDDB;

beforeEach(() => {
  resetMemoryStores();
  db = new FakeCIDDB();
});

const makeEntry = (id: string, agentId: string, content: string, updatedAt: string): import('../agents/memory-store.js').MemoryEntry => ({
  id, agentId, content, kind: 'fact' as const,
  importance: 0.5, createdAt: updatedAt, updatedAt,
  source: 'tool', refs: [], crystallized: false, recallCount: 0,
});

describe('memory-sync P3', () => {
  it('syncMemoryEntryToOrbit → 记录可 fetch 还原 (条目级 CID 化)', async () => {
    const e = makeEntry('abc123', 'agent-x', '跨设备记忆', '2026-10-11T00:00:00.000Z');
    const cid = await syncMemoryEntryToOrbit(e, db);
    expect(cid).toBeTruthy();
    const remote = await fetchRemoteEntries('agent-x', db);
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('abc123');
    expect(remote[0].content).toBe('跨设备记忆');
  });

  it('fetchRemoteEntries 只返回指定 agent 的条目', async () => {
    await syncMemoryEntryToOrbit(makeEntry('a1', 'agent-a', 'A 的记忆', '2026-10-11T00:00:00.000Z'), db);
    await syncMemoryEntryToOrbit(makeEntry('b1', 'agent-b', 'B 的记忆', '2026-10-11T00:00:00.000Z'), db);
    const onlyA = await fetchRemoteEntries('agent-a', db);
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].agentId).toBe('agent-a');
  });

  it('entryFromRecord 无 entryId 的旧记录 → null (不误当条目)', async () => {
    const bad = await db.save({ agentId: 'agent-a', type: 'memory', content: { id: 'x' }, metadata: { kind: 'shared-memory' } });
    expect(entryFromRecord(bad)).toBeNull();
  });

  it('shouldTakeRemote: 本地无 → 远端; 远端更新 → 远端; 本地更新/平手 → 本地', () => {
    const remote = makeEntry('x', 'a', '远端', '2026-10-11T00:00:00.000Z');
    expect(shouldTakeRemote(remote, undefined)).toBe(true);
    const olderLocal = makeEntry('x', 'a', '本地旧', '2026-10-10T00:00:00.000Z');
    expect(shouldTakeRemote(remote, olderLocal)).toBe(true);
    const newerLocal = makeEntry('x', 'a', '本地新', '2026-10-12T00:00:00.000Z');
    expect(shouldTakeRemote(remote, newerLocal)).toBe(false);
    const sameLocal = makeEntry('x', 'a', '同时', '2026-10-11T00:00:00.000Z');
    expect(shouldTakeRemote(remote, sameLocal)).toBe(false); // 平手 → 本地胜
  });

  it('mergeRemoteEntries: LWW 合并到 Map, 返回采纳数', () => {
    const local = new Map<string, import('../agents/memory-store.js').MemoryEntry>();
    local.set('x', makeEntry('x', 'a', '本地新', '2026-10-12T00:00:00.000Z'));
    local.set('keep', makeEntry('keep', 'a', '保留', '2026-10-10T00:00:00.000Z'));
    const remote = [
      makeEntry('x', 'a', '远端旧', '2026-10-11T00:00:00.000Z'), // 本地新 → 不采纳
      makeEntry('y', 'a', '远端新条目', '2026-10-11T00:00:00.000Z'), // 本地无 → 采纳
    ];
    const n = mergeRemoteEntries(local, remote);
    expect(n).toBe(1);
    expect(local.get('x')?.content).toBe('本地新');
    expect(local.get('y')?.content).toBe('远端新条目');
    expect(local.get('keep')?.content).toBe('保留');
  });

  it('MemoryStore.mergeRemote: 合并 + 落盘 + 归属校验 (非本 agent 拒绝)', async () => {
    const HOME = tmpHome();
    const s = new MemoryStore('agent-m', HOME);
    await s.save({ content: '本地记忆' });
    await s.load();
    const remote = [
      makeEntry('r1', 'agent-m', '远端来的记忆', '2026-10-11T00:00:00.000Z'),
      makeEntry('r2', 'agent-other', '别家的记忆', '2026-10-11T00:00:00.000Z'), // 归属不符 → 跳过
    ];
    const n = await s.mergeRemote(remote);
    expect(n).toBe(1); // 只采纳 r1
    // 新实例读回 (落盘验证)
    const s2 = new MemoryStore('agent-m', HOME);
    await s2.load();
    const list = await s2.list();
    expect(list.some((e) => e.content === '远端来的记忆')).toBe(true);
    expect(list.some((e) => e.content === '别家的记忆')).toBe(false);
  });

  it('exportEntries: vec 剥离 (不跨节点携带运行时向量)', async () => {
    const HOME = tmpHome();
    const s = new MemoryStore('agent-e', HOME);
    await s.save({ content: '带向量的记忆', importance: 0.6 }, { provider: 'fake', dim: 8, embed: async () => [1, 0, 0, 0, 0, 0, 0, 0], embedBatch: async () => [] } as any);
    await s.load();
    const out = s.exportEntries();
    expect(out[0].vec).toBeUndefined();
    expect(out[0].content).toBe('带向量的记忆');
  });
});