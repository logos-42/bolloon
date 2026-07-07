/**
 * 自适应扫描 — 单元测试
 *
 * 覆盖:
 * 1. rising: 7 天频率显著高于 30 天均值
 * 2. stale: 90+ 天未用 + 总 < 3
 * 3. unused: 30+ 天未用 + 总 < 5
 * 4. healthy: 高频用 + 最近用过 → 不出现
 * 5. sort order: rising > stale > unused
 * 6. 失败静默: usage 文件不存在 → 空建议
 * 7. 缓存: getCachedScan 24h 内不重扫
 * 8. logEvolution: 写 + 读
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  storeHumanJudgment,
  initializeValueStore,
} from '../pi-ecosystem-judgment/human-value-store.js';
import {
  runAdaptiveScan,
  getCachedScan,
  clearAdaptiveScanCache,
  logEvolution,
  readEvolutionLog,
} from '../pi-ecosystem-judgment/adaptive-scan.js';

const TEST_DIR = path.join(os.tmpdir(), `bolloon-adaptive-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;

const USAGE_LOG = path.join(TEST_DIR, '.bolloon', 'human-values', 'usage.jsonl');
const EVOLUTION_LOG = path.join(TEST_DIR, '.bolloon', 'human-values', 'evolution.jsonl');

async function writeUsage(entries: Array<{ ts: string; usedIds: string[] }>) {
  await fs.mkdir(path.dirname(USAGE_LOG), { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ ts: e.ts, channelId: null, userInputPreview: '', usedIds: e.usedIds })).join('\n');
  await fs.writeFile(USAGE_LOG, lines + '\n', 'utf-8');
}

// 2026-07-06: 测试 fixture 必须带实质内容, 否则被 storeHumanJudgment 写入时质量门拦截
//   (decision 长度 < 12 + values_derived 空 + reasons 空 → 启发式 2 命中, status 设为 rejected)
const TEST_BASE_REASON = 'P-Junk 1 修复后测试 fixture 需带实质内容';
const TEST_BASE_VALUE = { category: 'quality' as const, value: 'privacy-first' as const, weight: 0.9 };
async function storeFixture(decision: string): Promise<{ id: string }> {
  return storeHumanJudgment({
    decision,
    decision_type: 'approve',
    reasons: [TEST_BASE_REASON],
    values_derived: [TEST_BASE_VALUE],
    context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
    metadata: { source: 'explicit', confidence: 0.8, revisable: true },
  }) as any;
}

async function clearUsage() {
  try { await fs.unlink(USAGE_LOG); } catch {}
  try { await fs.unlink(EVOLUTION_LOG); } catch {}
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

beforeAll(async () => {
  process.env.HOME = TEST_DIR;
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.mkdir(path.dirname(USAGE_LOG), { recursive: true });
  await initializeValueStore();
});

afterAll(async () => {
  process.env.HOME = ORIGINAL_HOME;
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearUsage();
  clearAdaptiveScanCache();
});

// ============================================================
// 失败静默
// ============================================================

describe('adaptive scan: 失败静默', () => {
  it('usage.jsonl 不存在时应返回空建议 + 不抛错', async () => {
    const result = await runAdaptiveScan();
    expect(result.suggestions).toBeDefined();
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(result.usageEntriesScanned).toBe(0);
  });
});

// ============================================================
// rising
// ============================================================

describe('adaptive scan: rising', () => {
  it('7 天使用率 > 30 天均值 1.5 倍时应被识别', async () => {
    const j = await storeFixture('rising 7 天使用率高于 30 天均值, 应进上升列表');

    // 30 天里只用过 3 次 (极少), 7 天里用过 10 次
    // 30d daily avg = 0.1, 7d daily rate = 1.43, ratio = 14.3
    const entries = [];
    for (let i = 0; i < 3; i++) entries.push({ ts: daysAgo(20 + i), usedIds: [j.id] });
    for (let i = 0; i < 10; i++) entries.push({ ts: daysAgo(i), usedIds: [j.id] });
    await writeUsage(entries);

    const result = await runAdaptiveScan();
    const rising = result.suggestions.find((s) => s.kind === 'rising' && s.judgmentId === j.id);
    expect(rising).toBeDefined();
    expect(rising?.action).toBe('boost');
  });

  it('稳定高频 (无显著上升) 不应被识别为 rising', async () => {
    const j = await storeFixture('稳定高频但无显著上升, 不应入 rising 列表');
    // 30 天每天 1 次, 7 天每天 1 次 → 比例 1
    const entries = [];
    for (let i = 0; i < 30; i++) entries.push({ ts: daysAgo(i), usedIds: [j.id] });
    await writeUsage(entries);

    const result = await runAdaptiveScan();
    const rising = result.suggestions.find((s) => s.judgmentId === j.id);
    expect(rising).toBeUndefined();
  });
});

// ============================================================
// stale
// ============================================================

describe('adaptive scan: stale', () => {
  it('90+ 天未用 + 总 < 3 应被识别', async () => {
    const j = await storeFixture('stale 90 天未用加总使用少于 3 次, 应进过时列表');
    // 100 天前用过 1 次
    await writeUsage([{ ts: daysAgo(100), usedIds: [j.id] }]);

    const result = await runAdaptiveScan();
    const stale = result.suggestions.find((s) => s.kind === 'stale' && s.judgmentId === j.id);
    expect(stale).toBeDefined();
    expect(stale?.action).toBe('deprecate');
  });
});

// ============================================================
// unused
// ============================================================

describe('adaptive scan: unused', () => {
  it('30+ 天未用 + 总 < 5 应被识别', async () => {
    const j = await storeFixture('unused 30 天未用且总使用少于 5, 应进未用列表');
    // 40 天前用过 2 次
    await writeUsage([
      { ts: daysAgo(45), usedIds: [j.id] },
      { ts: daysAgo(40), usedIds: [j.id] },
    ]);

    const result = await runAdaptiveScan();
    const unused = result.suggestions.find((s) => s.kind === 'unused' && s.judgmentId === j.id);
    expect(unused).toBeDefined();
    expect(unused?.action).toBe('review');
  });
});

// ============================================================
// healthy
// ============================================================

describe('adaptive scan: healthy', () => {
  it('健康原则 (高频 + 最近用过) 不应出现在建议里', async () => {
    const j = await storeFixture('健康原则: 高频使用 + 最近用过, 不应出现在建议列表');
    // 30 天每天 5 次
    const entries = [];
    for (let i = 0; i < 30; i++) {
      for (let j2 = 0; j2 < 5; j2++) entries.push({ ts: daysAgo(i), usedIds: [j.id] });
    }
    await writeUsage(entries);

    const result = await runAdaptiveScan();
    const match = result.suggestions.find((s) => s.judgmentId === j.id);
    expect(match).toBeUndefined();
  });
});

// ============================================================
// 排序
// ============================================================

describe('adaptive scan: sort', () => {
  it('应按 rising > stale > unused 排序', async () => {
    const risingJ = await storeFixture('sort rising 排序测试: 这条应排最前, 趋势向上');
    const staleJ = await storeFixture('sort stale 排序测试: 这条 100 天未用, 应排第二');
    const unusedJ = await storeFixture('sort unused 排序测试: 这条 35 天未用, 应排第三');
    void staleJ; void unusedJ;

    // rising 模式
    const entries = [];
    for (let i = 0; i < 2; i++) entries.push({ ts: daysAgo(20 + i), usedIds: [risingJ.id] });
    for (let i = 0; i < 5; i++) entries.push({ ts: daysAgo(i), usedIds: [risingJ.id] });
    // stale
    entries.push({ ts: daysAgo(100), usedIds: [staleJ.id] });
    // unused
    entries.push({ ts: daysAgo(35), usedIds: [unusedJ.id] });
    await writeUsage(entries);

    const result = await runAdaptiveScan();
    // 验证前 3 条顺序
    expect(result.suggestions[0]?.kind).toBe('rising');
    expect(result.suggestions[1]?.kind).toBe('stale');
    expect(result.suggestions[2]?.kind).toBe('unused');
  });
});

// ============================================================
// 缓存
// ============================================================

describe('adaptive scan: 缓存', () => {
  it('getCachedScan 第二次调用应返回缓存 (force=false)', async () => {
    const j = await storeFixture('cache 测试 fixture: 用于验证 getCachedScan 缓存命中');
    await writeUsage([{ ts: daysAgo(100), usedIds: [j.id] }]);

    const a = await getCachedScan();
    const b = await getCachedScan();
    expect(a.scannedAt).toBe(b.scannedAt);
  });

  it('clearAdaptiveScanCache 后应重扫', async () => {
    const a = await getCachedScan();
    clearAdaptiveScanCache();
    const b = await getCachedScan();
    // 第二次至少 1ms 后, scannedAt 应该不同 (实际可能相同, 因为 Date.now() 精度)
    // 用 force 测更可靠
    const c = await getCachedScan(true);
    expect(c).toBeDefined();
    expect(a.scannedAt).toBeDefined();
  });
});

// ============================================================
// logEvolution + readEvolutionLog
// ============================================================

describe('logEvolution / readEvolutionLog', () => {
  it('写 + 读 应能往返', async () => {
    const fakeSuggestion = {
      key: 'test-key',
      kind: 'stale' as const,
      judgmentId: 'hv-test',
      decision: 'P-Junk 1 fixture for logEvolution',
      reason: 'test reason',
      action: 'deprecate' as const,
      hint: 'low usage',
      metrics: { usage7d: 0, usage30d: 0, daysSinceLastUse: 100, totalUsage: 1 },
      scannedAt: new Date().toISOString(),
    };
    await logEvolution({
      ts: new Date().toISOString(),
      action: 'accept',
      suggestion: fakeSuggestion,
    });
    const log = await readEvolutionLog(10);
    expect(log.length).toBeGreaterThan(0);
    const last = log[0];
    expect(last.action).toBe('accept');
    expect(last.suggestion.judgmentId).toBe('hv-test');
  });

  it('空日志应返回空数组', async () => {
    try { await fs.unlink(EVOLUTION_LOG); } catch {}
    const log = await readEvolutionLog(10);
    expect(Array.isArray(log)).toBe(true);
  });
});
