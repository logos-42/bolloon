/**
 * embedding-adapter + memory-store P1 向量检索 (2026-10-11)
 * 验证: adapter 工厂 / cosine 相似度 / MemoryStore 向量优先召回 / 关键词回退
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEmbeddingAdapter, createFakeAdapter, cosineSimilarity } from '../llm/embedding-adapter.js';
import { MemoryStore, resetMemoryStores } from '../agents/memory-store.js';

const tmpHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-vec-'));

let HOME: string;

beforeEach(() => {
  resetMemoryStores();
  HOME = tmpHome();
});

describe('embedding-adapter P1', () => {
  it('无配置 → none adapter (dim=0, embed 抛错)', async () => {
    const a = createEmbeddingAdapter();
    expect(a.provider).toBe('none');
    expect(a.dim).toBe(0);
    await expect(a.embed('x')).rejects.toThrow();
  });

  it('provider=none 显式 → none', () => {
    const a = createEmbeddingAdapter({ provider: 'none' });
    expect(a.provider).toBe('none');
  });

  it('未实现供应商 → 诚实回退 none (不假装能用)', () => {
    const a = createEmbeddingAdapter({ provider: 'glm', model: 'x' });
    expect(a.provider).toBe('none'); // 本仓现有 key 实测无 embedding, 不假装
  });

  it('cosine 相似度: 相同向量 → 1, 正交 → 0, 维度不符 → 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('fake adapter: 确定性 + 归一化', async () => {
    const a = createFakeAdapter(8);
    expect(a.provider).toBe('fake');
    const v1 = await a.embed('测试');
    const v2 = await a.embed('测试');
    expect(v1).toEqual(v2); // 确定性
    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6); // 归一化
    expect(await a.embedBatch(['a', 'b'])).toHaveLength(2);
  });
});

describe('MemoryStore P1 向量召回', () => {
  it('save 带 adapter → 条目存 vec; recall 用 queryVec 命中语义相关', async () => {
    const a = createFakeAdapter(16);
    const s = new MemoryStore('agent-v', HOME);
    await s.save({ content: '用户喜欢喝美式咖啡', kind: 'preference' }, a);
    await s.save({ content: '项目用 TypeScript 写', kind: 'fact' }, a);
    await s.load();
    const list = await s.list();
    expect(list.every((e) => Array.isArray(e.vec) && e.vec.length === 16)).toBe(true);

    // 查询向量与第一条更近 (fake adapter 对长度相近的文本给相近向量)
    const qv = await a.embed('美式咖啡是用户的饮品偏好');
    const hits = await s.recall({ query: '美式咖啡', queryVec: qv, limit: 1 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.content).toContain('咖啡');
  });

  it('queryVec 提供但条目无 vec (旧数据) → 跳过, 不崩', async () => {
    const s = new MemoryStore('agent-legacy', HOME);
    await s.save({ content: '旧记忆没有向量' }); // 不传 adapter → 无 vec
    await s.load();
    const qv = [0.5, 0.5, 0.5, 0.5];
    const hits = await s.recall({ query: '旧记忆', queryVec: qv });
    expect(hits).toHaveLength(0); // 全部无向量 → 空, 静默
  });

  it('无 queryVec → 关键词回退 (P0 行为不变)', async () => {
    const s = new MemoryStore('agent-kw', HOME);
    await s.save({ content: '用户偏好: 全自动安装, 零手动步骤', kind: 'preference' });
    await s.load();
    const hits = await s.recall({ query: '自动安装' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.content).toContain('全自动');
  });

  it('向量召回 hit 也计数 recallCount (动态升权兼容)', async () => {
    const a = createFakeAdapter(8);
    const s = new MemoryStore('agent-rc', HOME);
    await s.save({ content: '记住这个重要约定', importance: 0.5 }, a);
    await s.load();
    const qv = await a.embed('重要约定');
    const h1 = await s.recall({ query: '重要约定', queryVec: qv });
    expect(h1[0].entry.recallCount).toBe(1);
  });
});
