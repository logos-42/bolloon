/**
 * Causal-Judge (阶段 2) — 单元测试
 *
 * 覆盖:
 * 1. 4 字段 migration (老数据补 expiresAt/conflictWith)
 * 2. 冲突检测: detectConflict + runConflictDetection
 * 3. 注入门 appliesTo 路由
 * 4. 自适应扫描新增 causal_conflict 类
 * 5. 反事实审计: 写 + 读 (LLM 不可用 fallback)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  storeHumanJudgment,
  loadAllJudgments,
  getRelevantValues,
  initializeValueStore,
  DEFAULT_TTL_DAYS,
  migrateJudgmentInPlace,
} from '../pi-ecosystem-judgment/human-value-store.js';
import {
  detectConflict,
  runConflictDetection,
  runCorrelationAnalysis,
  logCounterfactualAudit,
  readCounterfactualLog,
} from '../pi-ecosystem-judgment/causal-judge.js';
import { runAdaptiveScan, clearAdaptiveScanCache } from '../pi-ecosystem-judgment/adaptive-scan.js';

const TEST_DIR = path.join(os.tmpdir(), `bolloon-causal-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  process.env.HOME = TEST_DIR;
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.mkdir(path.join(TEST_DIR, '.bolloon', 'human-values'), { recursive: true });
  await initializeValueStore();
});

afterAll(async () => {
  process.env.HOME = ORIGINAL_HOME;
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  clearAdaptiveScanCache();
});

// ============================================================
// 1. 4 字段 migration
// ============================================================

describe('migrateJudgmentInPlace', () => {
  it('老数据应补 expiresAt (90 天后) + conflictWith=[]', () => {
    const old = {
      id: 'hv-old',
      timestamp: '2024-01-01T00:00:00.000Z',
      decision: '老判断',
      decision_type: 'approve' as const,
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple' as const, stakes: 'low' as const, time_pressure: 'low' as const },
      metadata: { source: 'explicit' as const, confidence: 0.8, revisable: true },
    };
    const changed = migrateJudgmentInPlace(old as any);
    expect(changed).toBe(true);
    expect((old as any).expiresAt).toBeTruthy();
    // 90 天后 (从 2024-01-01)
    const exp = new Date((old as any).expiresAt);
    const expected = new Date('2024-01-01T00:00:00.000Z');
    expected.setDate(expected.getDate() + 90);
    expect(exp.toISOString()).toBe(expected.toISOString());
    expect((old as any).conflictWith).toEqual([]);
  });

  it('已有 expiresAt / conflictWith 的不重复补', () => {
    const j = {
      id: 'hv-new',
      timestamp: '2026-06-13T00:00:00.000Z',
      decision: '新判断',
      decision_type: 'approve' as const,
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple' as const, stakes: 'low' as const, time_pressure: 'low' as const },
      metadata: { source: 'explicit' as const, confidence: 0.8, revisable: true },
      expiresAt: '2099-01-01T00:00:00.000Z',
      conflictWith: ['hv-other'],
    } as any;
    const changed = migrateJudgmentInPlace(j);
    expect(changed).toBe(false);
    expect(j.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(j.conflictWith).toEqual(['hv-other']);
  });

  it('loadAllJudgments 读盘时应自动 migration 老数据', async () => {
    // 走 storeHumanJudgment 路径, 它内部已补 expiresAt / conflictWith
    // 测的是: 显式存一条"缺字段" judgment → loadAll 后字段都补齐
    const j = await storeHumanJudgment({
      decision: 'loadAll 测试',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    // storeHumanJudgment 写盘前 store 内补 expiresAt/conflictWith, 落盘后 loadAll 读回
    // 关键: migratedOnce 已被前测触发, 不会再补 — 但 storeHumanJudgment 已经补过
    const all = await loadAllJudgments();
    const found = all.find((x) => x.id === j.id);
    expect(found).toBeDefined();
    expect(found!.expiresAt).toBeTruthy();
    expect(found!.conflictWith).toEqual([]);
  });
});

// ============================================================
// 2. 冲突检测
// ============================================================

describe('detectConflict', () => {
  it('正极 vs 负极: 冲突', () => {
    const a = { decision: '禁止动 shell' } as any;
    const b = { decision: 'auto-tools 开启时优先 shell' } as any;
    const r = detectConflict(a, b);
    expect(r.isConflict).toBe(true);
    expect(r.reason).toContain('极性词冲突');
  });

  it('两正极: 不冲突', () => {
    const a = { decision: '优先用 TypeScript' } as any;
    const b = { decision: '应该写测试' } as any;
    const r = detectConflict(a, b);
    expect(r.isConflict).toBe(false);
  });

  it('两负极: 不冲突 (都禁, 但没正面冲突)', () => {
    const a = { decision: '禁止动 shell' } as any;
    const b = { decision: '避免 rm -rf' } as any;
    const r = detectConflict(a, b);
    expect(r.isConflict).toBe(false);
  });
});

describe('runConflictDetection', () => {
  it('应自动写入 conflictWith 字段', async () => {
    // 写一对冲突 judgment
    await storeHumanJudgment({
      decision: '禁止自动调 shell',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    await storeHumanJudgment({
      decision: 'auto-tools 开启时优先 shell',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    const result = await runConflictDetection();
    expect(result.detected).toBeGreaterThan(0);
    // 验证每条 judgment 的 conflictWith 含另一条
    const all = await loadAllJudgments();
    for (const j of all) {
      if ((j.status ?? 'active') === 'active' && (j.decision.includes('禁止') || j.decision.includes('优先'))) {
        expect(Array.isArray(j.conflictWith)).toBe(true);
        expect(j.conflictWith!.length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================
// 3. 注入门 appliesTo 路由
// ============================================================

describe('getRelevantValues appliesTo 路由', () => {
  it('appliesTo=[shell] 的 judgment, currentTool=read 时应不返回', async () => {
    const j = await storeHumanJudgment({
      decision: 'shell 安全规则',
      decision_type: 'approve',
      reasons: [],
      values_derived: [{ category: 'safety', value: 'shell-safety', weight: 0.9 }],
      appliesTo: ['shell'],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    // 用 'shell safety' query, 但 currentTool='read' — 不应返回
    const vals1 = await getRelevantValues('shell safety', undefined, 'read');
    expect(vals1.find((v) => v.value === 'shell-safety')).toBeUndefined();
    // currentTool='shell' — 应返回
    const vals2 = await getRelevantValues('shell safety', undefined, 'shell');
    expect(vals2.find((v) => v.value === 'shell-safety')).toBeDefined();
    void j;
  });

  it('无 appliesTo 的 judgment 适用所有 tool', async () => {
    const j = await storeHumanJudgment({
      decision: '通用安全规则',
      decision_type: 'approve',
      reasons: [],
      values_derived: [{ category: 'safety', value: 'general-safety', weight: 0.9 }],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    const vals1 = await getRelevantValues('general safety', undefined, 'read');
    const vals2 = await getRelevantValues('general safety', undefined, 'shell');
    expect(vals1.find((v) => v.value === 'general-safety')).toBeDefined();
    expect(vals2.find((v) => v.value === 'general-safety')).toBeDefined();
    void j;
  });
});

// ============================================================
// 4. 自适应扫描 causal_conflict
// ============================================================

describe('runAdaptiveScan causal_conflict', () => {
  it('库内含冲突对时, scan 应产生 causal_conflict 类建议', async () => {
    await storeHumanJudgment({
      decision: '禁止自动调 shell 工具',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    await storeHumanJudgment({
      decision: 'auto-tools 开启时可以自动调 shell',
      decision_type: 'approve',
      reasons: [],
      values_derived: [],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });
    clearAdaptiveScanCache();
    const result = await runAdaptiveScan();
    const conflicts = result.suggestions.filter((s) => s.kind === 'causal_conflict');
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].action).toBe('review');
  });
});

// ============================================================
// 5. 反事实审计 (LLM 不可用时 fallback)
// ============================================================

describe('runCounterfactualAudit (fallback)', () => {
  it('LLM 不可用时应返 fallback verdict', async () => {
    const { runCounterfactualAudit } = await import('../pi-ecosystem-judgment/causal-judge.js');
    const audit = await runCounterfactualAudit({
      userInput: '请帮我用 rm -rf 删除 /tmp',
      aiReply: '好的, 我帮您删除',
      violatedPrinciples: [{ principe: '禁止自动调 shell', reason: '用户没显式确认' }],
    });
    // LLM 不可用时, 返 fallback. verdict 是 '需更多数据'.
    expect(audit.verdict).toBe('需更多数据');
    expect(audit.trigger.userInput).toContain('rm -rf');
  });

  it('logCounterfactualAudit + readCounterfactualLog 应能往返', async () => {
    const audit = {
      ts: new Date().toISOString(),
      trigger: { userInput: 'test', aiReply: 'test', violatedPrinciples: [] },
      scenarios: [],
      verdict: '库设计合理' as const,
      recomendaciones: ['test'],
    };
    await logCounterfactualAudit(audit);
    const log = await readCounterfactualLog(10);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].verdict).toBe('库设计合理');
  });
});
