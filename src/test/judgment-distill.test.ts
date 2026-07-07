/**
 * 判断力自动入库 + AI 演化 — 单元测试
 *
 * 覆盖:
 * 1. Jaccard 相似度 (4 个 case)
 * 2. schema 迁移 (旧数据无 status 字段 → 补 active)
 * 3. listJudgmentsByStatus (active / superseded / all)
 * 4. batchUpdateJudgments (idempotent)
 * 5. updateJudgmentStatus (含 evolvedAt 自动写入)
 *
 * 跳过 LLM 蒸馏和 LLM 演化判定 (需要在集成测试里跑)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { jaccardSimilarity } from '../pi-ecosystem-judgment/evolve-judgment.js';
import { throttleDHook, clearDHookThrottle } from '../pi-ecosystem-judgment/detect-hook.js';
import {
  storeHumanJudgment,
  loadAllJudgments,
  listJudgmentsByStatus,
  batchUpdateJudgments,
  updateJudgmentStatus,
  initializeValueStore,
  hashDecision,
  findRecentSimilarDecisions,
  type HumanJudgment,
} from '../pi-ecosystem-judgment/human-value-store.js';

const TEST_DIR = path.join(os.tmpdir(), `bolloon-test-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  process.env.HOME = TEST_DIR;
  await fs.mkdir(TEST_DIR, { recursive: true });
  await initializeValueStore();
});

afterAll(async () => {
  process.env.HOME = ORIGINAL_HOME;
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

// ============================================================
// Jaccard 相似度
// ============================================================

describe('jaccardSimilarity', () => {
  it('完全相同文本应返回 1.0', () => {
    expect(jaccardSimilarity('保持简单', '保持简单')).toBe(1.0);
  });

  it('完全不同文本应返回接近 0', () => {
    const sim = jaccardSimilarity('保守优先', '激进冒险');
    expect(sim).toBeLessThan(0.3);
  });

  it('高度重叠文本应返回 > 0.4 (bigram 改善后, 7 vs 6 字符跨阈值)', () => {
    // 实测 ~0.46 — 长度正好卡在 <8 边界, 一边 bigram 一边单字, 但仍高于字符级老值
    const sim = jaccardSimilarity('保持代码简单清晰', '保持代码简单');
    expect(sim).toBeGreaterThan(0.4);
  });

  it('中度重叠文本应在合理区间', () => {
    // 中文短句的字符级 Jaccard 通常比英文低 (字符集大), 0.1-0.6 算中度
    const sim = jaccardSimilarity(
      '不要过度设计,简单优先',
      '保持代码简单清晰易懂'
    );
    expect(sim).toBeGreaterThan(0.1);
    expect(sim).toBeLessThan(0.9);
  });

  it('空字符串应返回 0', () => {
    expect(jaccardSimilarity('', 'abc')).toBe(0);
    expect(jaccardSimilarity('abc', '')).toBe(0);
    expect(jaccardSimilarity('', '')).toBe(0);
  });

  it('标点符号应被过滤', () => {
    const a = '保持简单,不要过度设计!';
    const b = '保持简单。不要过度设计?';
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.85);
  });
});

// ============================================================
// schema 迁移
// ============================================================

describe('schema 迁移', () => {
  it('旧数据无 status 字段应被补为 active', async () => {
    const j = await storeHumanJudgment({
      decision: '不暴露用户隐私给远端 peer, 除非用户授权明确',
      decision_type: 'approve',
      reasons: ['安全原则'],
      values_derived: [{ category: 'safety', value: 'privacy-first', weight: 0.9 }],
      context: {
        domain: 'security',
        complexity: 'simple',
        stakes: 'low',
        time_pressure: 'low',
      },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    expect(j.status).toBeUndefined();

    const all = await loadAllJudgments();
    const found = all.find((x) => x.id === j.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('active');
  });
});

// ============================================================
// listJudgmentsByStatus
// ============================================================

describe('listJudgmentsByStatus', () => {
  it('不传 status 或传 all 应返回所有', async () => {
    await storeHumanJudgment({
      decision: 'listJudgmentsByStatus test',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const all = await listJudgmentsByStatus('all');
    const noArg = await listJudgmentsByStatus();
    expect(all.length).toBeGreaterThan(0);
    expect(noArg.length).toBe(all.length);
  });

  it('传 active 应只返回 active', async () => {
    const j = await storeHumanJudgment({
      decision: 'active filter test',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const active = await listJudgmentsByStatus('active');
    expect(active.find((x) => x.id === j.id)).toBeDefined();

    const superseded = await listJudgmentsByStatus('superseded');
    expect(superseded.find((x) => x.id === j.id)).toBeUndefined();
  });

  it('superseded 条应能被过滤出', async () => {
    const j = await storeHumanJudgment({
      decision: 'will be superseded',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    await updateJudgmentStatus(j.id, 'superseded', {
      supersededBy: 'test-new-id',
      evolutionReason: 'merged',
    });

    const superseded = await listJudgmentsByStatus('superseded');
    const found = superseded.find((x) => x.id === j.id);
    expect(found).toBeDefined();
    expect(found!.supersededBy).toBe('test-new-id');
    expect(found!.evolutionReason).toBe('merged');
    expect(found!.evolvedAt).toBeDefined();
  });
});

// ============================================================
// batchUpdateJudgments
// ============================================================

describe('batchUpdateJudgments', () => {
  it('应能批量更新多条, 返回 updated 数和 notFound 列表', async () => {
    const a = await storeHumanJudgment({
      decision: 'batch a',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    const b = await storeHumanJudgment({
      decision: 'batch b',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const result = await batchUpdateJudgments([
      { id: a.id, patch: { status: 'superseded', evolutionReason: 'merged' } },
      { id: b.id, patch: { status: 'superseded', evolutionReason: 'contradicted' } },
      { id: 'non-existent-id', patch: { status: 'superseded' } },
    ]);

    expect(result.updated).toBe(2);
    expect(result.notFound).toContain('non-existent-id');

    const all = await loadAllJudgments();
    const updatedA = all.find((x) => x.id === a.id);
    const updatedB = all.find((x) => x.id === b.id);
    expect(updatedA!.status).toBe('superseded');
    expect(updatedA!.evolutionReason).toBe('merged');
    expect(updatedB!.status).toBe('superseded');
    expect(updatedB!.evolutionReason).toBe('contradicted');
  });

  it('idempotent: 重复标记 superseded 不应出错', async () => {
    const j = await storeHumanJudgment({
      decision: 'idempotent test',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    await updateJudgmentStatus(j.id, 'superseded', { evolutionReason: 'merged' });
    const result = await batchUpdateJudgments([
      { id: j.id, patch: { status: 'superseded', evolutionReason: 'contradicted' } },
    ]);

    expect(result.updated).toBe(1);

    const all = await loadAllJudgments();
    const found = all.find((x) => x.id === j.id);
    expect(found!.status).toBe('superseded');
    expect(found!.evolutionReason).toBe('contradicted');
  });
});

// ============================================================
// updateJudgmentStatus 自动写 evolvedAt
// ============================================================

describe('updateJudgmentStatus', () => {
  it('应自动写入 evolvedAt', async () => {
    const j = await storeHumanJudgment({
      decision: 'evolvedAt test',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const before = Date.now();
    await updateJudgmentStatus(j.id, 'superseded', { evolutionReason: 'merged' });
    const after = Date.now();

    const all = await loadAllJudgments();
    const found = all.find((x) => x.id === j.id);
    expect(found!.evolvedAt).toBeDefined();
    const ts = new Date(found!.evolvedAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it('不传 extra 时不应报错 (只改 status)', async () => {
    const j = await storeHumanJudgment({
      decision: 'rejected test',
      decision_type: 'reject',
      reasons: [],
      values_derived: [],
      context: { domain: 'test', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const result = await updateJudgmentStatus(j.id, 'rejected');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('rejected');
  });
});

// ============================================================
// hashDecision: 归一化后相同文本 hash 相同
// ============================================================

describe('hashDecision', () => {
  it('标点+空白归一化后相同文本应返回相同 hash', () => {
    const a = hashDecision('先校验再写文件');
    const b = hashDecision('先 校验 再 写 文件！');
    const c = hashDecision('先校验再写文件,');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('大小写折叠应生效', () => {
    expect(hashDecision('Hello World')).toBe(hashDecision('hello world'));
  });

  it('空字符串应返回稳定 hash', () => {
    const h = hashDecision('');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hash 长度应为 16 字符 (64-bit 截断)', () => {
    expect(hashDecision('test')).toHaveLength(16);
  });
});

// ============================================================
// findRecentSimilarDecisions: 24h 滑窗 + channel 隔离
// ============================================================

describe('findRecentSimilarDecisions', () => {
  it('24h 内同 channel 同文本应能找到 (含归一化)', async () => {
    const channel = `ch-hash-test-${Date.now()}`;
    const a = await storeHumanJudgment({
      decision: '保持简单清晰,优先可读性',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: `channel:${channel}`, complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    // 改写标点+空白, hash 应撞
    const dups = await findRecentSimilarDecisions('保持简单清晰，优先可读性', 24 * 60 * 60 * 1000, {
      channelId: channel,
    });
    expect(dups.length).toBe(1);
    expect(dups[0].id).toBe(a.id);
  });

  it('不同 channel 隔离: A channel 的判断力不应被 B channel 的查询命中', async () => {
    const chA = `ch-iso-A-${Date.now()}`;
    const chB = `ch-iso-B-${Date.now()}`;
    await storeHumanJudgment({
      decision: '跨 channel 隔离测试专用语句',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: `channel:${chA}`, complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const dups = await findRecentSimilarDecisions('跨 channel 隔离测试专用语句', 24 * 60 * 60 * 1000, {
      channelId: chB,
    });
    expect(dups.length).toBe(0);
  });

  it('不传 channelId 应全库搜 (B 触发场景)', async () => {
    const text = 'B 触发全库搜专用语句 xyz123';
    await storeHumanJudgment({
      decision: text,
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    const dups = await findRecentSimilarDecisions(text, 24 * 60 * 60 * 1000, {});
    expect(dups.length).toBeGreaterThanOrEqual(1);
  });

  it('窗口外 (withinMs 极小) 应找不到', async () => {
    const text = '窗口外测试专用语句 abc456';
    await storeHumanJudgment({
      decision: text,
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    // withinMs=0 → 任何已存在条目都在 cutoff 之外
    const dups = await findRecentSimilarDecisions(text, 0, {});
    expect(dups.length).toBe(0);
  });
});

// ============================================================
// throttleDHook: channel 维度 5min 节流
// ============================================================

describe('throttleDHook', () => {
  it('5min 内第二次调用应返回 false, 不同 channel 互不影响', () => {
    const ch = `ch-throttle-${Date.now()}`;
    clearDHookThrottle(ch);
    expect(throttleDHook(ch, 5 * 60_000)).toBe(true);
    expect(throttleDHook(ch, 5 * 60_000)).toBe(false);

    // 不同 channel 第一次应返回 true
    const ch2 = `ch-throttle-other-${Date.now()}`;
    clearDHookThrottle(ch2);
    expect(throttleDHook(ch2, 5 * 60_000)).toBe(true);

    // 清理
    clearDHookThrottle(ch);
    clearDHookThrottle(ch2);
  });

  it('clearDHookThrottle 应重置窗口', () => {
    const ch = `ch-clear-${Date.now()}`;
    clearDHookThrottle(ch);
    expect(throttleDHook(ch, 5 * 60_000)).toBe(true);
    expect(throttleDHook(ch, 5 * 60_000)).toBe(false);
    clearDHookThrottle(ch);
    expect(throttleDHook(ch, 5 * 60_000)).toBe(true);
    clearDHookThrottle(ch);
  });
});

// ============================================================
// jaccardSimilarity bigram 改善 (短句抗措辞改写)
// ============================================================

describe('jaccardSimilarity bigram 改善', () => {
  it('短句措辞改写 (先校验 vs 写入前先校验) 应 > 0.3', () => {
    // 旧字符级 Jaccard 这种情况会跌到 ~0.2
    const sim = jaccardSimilarity('先校验再写', '写入前先校验');
    expect(sim).toBeGreaterThan(0.3);
  });

  it('短句高度重叠应 > 0.4 (bigram 改善后)', () => {
    const sim = jaccardSimilarity('保持代码简单清晰', '保持代码简单');
    expect(sim).toBeGreaterThan(0.4);
  });

  it('长句 (>8 字符) 仍走单字 set, 行为不变', () => {
    // 长句 set 模式: '不' '要' '过' '度' '设' '计' vs '保' '持' '代' '码' '简' '单' → 不重叠
    const sim = jaccardSimilarity(
      '不要过度设计,简单优先,保持务实',
      '保持代码简单清晰易懂可维护'
    );
    expect(sim).toBeLessThan(0.5);
  });
});
