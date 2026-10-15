/**
 * memory-store — P0 结构化记忆 (2026-10-14)
 * 隔离 HOME + 原子 JSONL 持久化 + 关键词召回 + importance 加权
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryStore, getMemoryStore, formatRecallBlock, formatMemorySystemBlock, heuristicImportance, resetMemoryStores } from '../agents/memory-store.js';

const tmpHome = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
  return d;
};

let HOME: string;

beforeEach(() => {
  resetMemoryStores();
  HOME = tmpHome();
});

describe('MemoryStore P0', () => {
  it('save → 落盘 → 新实例 load 能读回 (原子持久化)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '用户偏好: 全自动安装, 零手动步骤', kind: 'preference' });
    const s2 = new MemoryStore('agent-a', HOME);
    await s2.load();
    const list = await s2.list();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('preference');
    expect(list[0].content).toContain('全自动安装');
    expect(list[0].importance).toBeGreaterThan(0.4); // preference 加分
  });

  it('save 去重: 同内容不重复追加 (sha256 id)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '记住这个事实' });
    await s.save({ content: '记住这个事实' });
    expect((await s.list())).toHaveLength(1);
  });

  it('空/过短内容拒绝 (至少 2 字符)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await expect(s.save({ content: ' ' })).rejects.toThrow();
    await expect(s.save({ content: 'x' })).rejects.toThrow();
    expect((await s.list())).toHaveLength(0);
  });

  it('recall: 关键词命中 + importance 加权排序', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '用户喜欢用 Python 和 TypeScript', kind: 'preference' });
    await s.save({ content: '今天修了 baseUrl 缺 /v1 的 bug', kind: 'event' });
    const hits = await s.recall({ query: 'Python 用什么语言', limit: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].entry.content).toContain('Python');
  });

  it('recall 命中 → recallCount++ 且落盘 (动态升权)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '客户叫老王' });
    await s.recall({ query: '老王' });
    const s2 = new MemoryStore('agent-a', HOME);
    await s2.load();
    expect((await s2.list())[0].recallCount).toBe(1);
  });

  it('remove: 删除后持久化消失', async () => {
    const s = new MemoryStore('agent-a', HOME);
    const e = await s.save({ content: '要删掉的记忆' });
    expect(await s.remove(e.id)).toBe(true);
    expect((await s.list())).toHaveLength(0);
    const s2 = new MemoryStore('agent-a', HOME);
    await s2.load();
    expect((await s2.list())).toHaveLength(0);
  });

  it('手动 importance 覆盖启发式', async () => {
    expect(heuristicImportance('短', 'fact', 0.9)).toBe(0.9);
    expect(heuristicImportance('短', 'fact')).toBeLessThan(0.6);
  });

  it('getMemoryStore 按 agentId 分桶, 互不串', async () => {
    const a = getMemoryStore('agent-a', HOME);
    const b = getMemoryStore('agent-b', HOME);
    await a.save({ content: 'A 的记忆' });
    await b.save({ content: 'B 的记忆' });
    expect((await a.list())[0].content).toBe('A 的记忆');
    expect((await b.list())[0].content).toBe('B 的记忆');
  });

  it('formatRecallBlock: 摘要 + 权重, 不带 id 全文 (progressive disclosure)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '用户最重视减法思维' });
    const hits = await s.recall({ query: '减法 思维' });
    const block = formatRecallBlock(hits);
    expect(block).toContain('<memory-context>');
    expect(block).toContain('减法');
    expect(block).toContain('权重');
  });

  it('单行损坏不整文件作废 (append-only 容错)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '好记忆' });
    // 手动注入一行坏 JSON
    fs.appendFileSync(path.join(HOME, '.bolloon', 'memory', 'agent-a', 'entries.jsonl'), '{broken json}\n');
    const s2 = new MemoryStore('agent-a', HOME);
    await s2.load();
    expect((await s2.list())).toHaveLength(1);
  });
});

describe('formatMemorySystemBlock (稳态记忆块, 2026-10-15)', () => {
  it('crystallized 优先 + importance 降序, 上限 6 条', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '普通事实 1', kind: 'fact' });
    await s.save({ content: '普通事实 2', kind: 'fact' });
    await s.save({ content: '用户偏好: 全自动', kind: 'preference', importance: 0.9 });
    // 固化一条
    const all0 = await s.list();
    const target = all0.find((e) => e.content.includes('全自动'))!;
    await s.crystallize(target.id);
    const all = await s.list();
    const block = formatMemorySystemBlock(all, 6);
    expect(block).toContain('<stable-memory>');
    expect(block).toContain('★');                 // 固化标记
    expect(block.indexOf('全自动')).toBeLessThan(block.indexOf('普通事实')); // 固化排最前
  });

  it('decayed 记忆不入选 (淡化中不算稳态)', async () => {
    const s = new MemoryStore('agent-a', HOME);
    await s.save({ content: '会淡化的记忆', kind: 'fact', importance: 0.2 });
    const e = (await s.list())[0];
    await s.save({ content: '会淡化的记忆', kind: 'fact', importance: 0.2 }); // 同内容去重
    // 手动标 decayed
    const store = s as any;
    const entries = store.entries as Map<string, any>;
    entries.get(e.id)!.decayed = true;
    const block = formatMemorySystemBlock(await s.list(), 6);
    expect(block).toBe('');
  });

  it('空记忆 → 空块 (不产生空围栏)', () => {
    expect(formatMemorySystemBlock([], 6)).toBe('');
  });

  it('maxEntries 截断: 只给前 N 条', async () => {
    const s = new MemoryStore('agent-a', HOME);
    for (let i = 0; i < 10; i++) await s.save({ content: `事实 ${i}`, kind: 'fact', importance: 0.5 });
    const block = formatMemorySystemBlock(await s.list(), 3);
    const lines = block.split('\n').filter((l) => l.startsWith('- ('));
    expect(lines.length).toBe(3);
  });
});