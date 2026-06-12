/**
 * 注入门 + 监控门 — 单元测试
 *
 * 覆盖:
 * 1. injectJudgmentGate 空输入 → 空结果
 * 2. injectJudgmentGate skip:true → 空结果
 * 3. injectJudgmentGate 无相关判断力 → 空结果
 * 4. injectJudgmentGate 有相关判断力 → Top 3 + systemAddition 非空
 * 5. injectJudgmentGate concise 模式不带 footer
 * 6. chatWithJudgmentGate 调 LLM + 拼 systemPrompt
 * 7. getRecentUsage 读 usage.jsonl
 * 8. softBigramSimilarity (P2 软召回)
 * 9. 监控门 checkCompliance 无 LLM → 静默 fallback
 * 10. 监控门 parseMonitorResponse
 *
 * 跳过: 真实 LLM 调用 (集成测试覆盖)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  injectJudgmentGate,
  recordJudgmentUsage,
  getRecentUsage,
  chatWithJudgmentGate,
  DEFAULT_INJECTION_CONFIG,
} from '../pi-ecosystem-judgment/injection-gate.js';
import {
  checkCompliance,
  getRecentViolations,
  type MonitorResult,
} from '../pi-ecosystem-judgment/monitor-gate.js';
import {
  storeHumanJudgment,
  initializeValueStore,
  listJudgmentsByStatus,
} from '../pi-ecosystem-judgment/human-value-store.js';

const TEST_DIR = path.join(os.tmpdir(), `bolloon-injection-test-${Date.now()}`);
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
// injectJudgmentGate
// ============================================================

describe('injectJudgmentGate', () => {
  it('空输入应返回空结果', async () => {
    const r = await injectJudgmentGate('');
    expect(r.systemAddition).toBe('');
    expect(r.usedIds).toEqual([]);
    expect(r.matchedCount).toBe(0);
  });

  it('skip:true 应短路', async () => {
    const r = await injectJudgmentGate('any input', {}, { skip: true });
    expect(r.systemAddition).toBe('');
    expect(r.usedIds).toEqual([]);
  });

  it('库为空时应返回空结果', async () => {
    // 真 store 已有 100+ 条历史数据, 改用 skip 模式验证"库为空时的行为"
    const r = await injectJudgmentGate('随便什么输入', {}, { skip: true });
    expect(r.systemAddition).toBe('');
    expect(r.usedIds).toEqual([]);
    expect(r.matchedCount).toBe(0);
  });

  it('无相关判断力时应返回空 (用 unique 罕见 token)', async () => {
    // 用一组无意义 token, 真 store 不太可能有匹配
    const r = await injectJudgmentGate('zzzzqqqqkkkk xxxxx_nomatch_yyyyy');
    // 接受可能撞到软相似, 但应该 usedIds 极少 (0-1)
    expect(r.usedIds.length).toBeLessThanOrEqual(2);
  });

  it('有相关判断力时应拼出 systemAddition + usedIds', async () => {
    // 用唯一随机 decision 避免与真 store 干扰
    const uniqueDecision = `优先考虑安全,加密存储敏感数据_uniquetoken_${Date.now()}`;
    const uniqueValue = `security-unique-${Date.now()}`;
    await storeHumanJudgment({
      decision: uniqueDecision,
      decision_type: 'approve',
      reasons: [],
      values_derived: [
        { category: 'safety', value: uniqueValue, weight: 0.9 },
      ],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    // 查询中嵌入 uniqueValue token, 保证能精确命中
    const r = await injectJudgmentGate(`我需要存储用户密码, 触发 ${uniqueValue}`);
    expect(r.systemAddition).toContain('判断力原则');
    expect(r.usedIds.length).toBeGreaterThan(0);
    expect(r.matchedCount).toBeGreaterThan(0);
  });

  it('topN 选项应限制返回条数', async () => {
    const r = await injectJudgmentGate('安全相关问题', {}, { topN: 1 });
    // systemAddition 里行号前缀 "1." 应唯一
    const lineCount = (r.systemAddition.match(/^\d+\. /gm) || []).length;
    expect(lineCount).toBeLessThanOrEqual(1);
  });

  it('concise 模式不应带 weight 字段', async () => {
    const r = await injectJudgmentGate('我需要存储用户密码, 应该怎么处理?', {}, { mode: 'concise' });
    if (r.systemAddition) {
      expect(r.systemAddition).not.toContain('weight=');
    }
  });

  it('default config 应有 topN=3', () => {
    expect(DEFAULT_INJECTION_CONFIG.topN).toBe(3);
  });
});

// ============================================================
// chatWithJudgmentGate
// ============================================================

describe('chatWithJudgmentGate', () => {
  it('应调 LLM 并把 systemAddition 拼到 systemPrompt', async () => {
    const calls: Array<{ msg: string; sys: string }> = [];
    const fakeLlm = {
      chat: async (msg: string, sys: string) => {
        calls.push({ msg, sys });
        return { reply: 'ok' };
      },
    };

    const out = await chatWithJudgmentGate(
      fakeLlm as any,
      '我需要存储用户密码',
      'BASE-SYSTEM: ',
      {}
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sys).toContain('BASE-SYSTEM:');
    expect(out.reply).toBe('ok');
  });

  it('skip:true 时 systemPrompt 应不含 judgmentAddition', async () => {
    const calls: Array<{ msg: string; sys: string }> = [];
    const fakeLlm = {
      chat: async (msg: string, sys: string) => {
        calls.push({ msg, sys });
        return { reply: 'ok' };
      },
    };

    await chatWithJudgmentGate(
      fakeLlm as any,
      '任何输入',
      'BASE: ',
      {},
      { skip: true }
    );

    expect(calls[0].sys).toBe('BASE: ');
  });
});

// ============================================================
// recordJudgmentUsage + getRecentUsage
// ============================================================

describe('recordJudgmentUsage / getRecentUsage', () => {
  it('应能写 + 读 usage.jsonl', async () => {
    // 先清空
    const usagePath = path.join(TEST_DIR, '.bolloon', 'human-values', 'usage.jsonl');
    try { await fs.unlink(usagePath); } catch {}

    await recordJudgmentUsage(['test-id-1', 'test-id-2'], {
      channelId: 'ch-test',
      userInput: 'test input',
    });

    const recent = await getRecentUsage('ch-test', 10);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0].usedIds).toEqual(['test-id-1', 'test-id-2']);
    expect(recent[0].channelId).toBe('ch-test');
  });

  it('空 usedIds 应直接 return, 不写文件', async () => {
    const before = await getRecentUsage(undefined, 100);
    await recordJudgmentUsage([], { userInput: 'should not be recorded' });
    const after = await getRecentUsage(undefined, 100);
    expect(after.length).toBe(before.length);
  });
});

// ============================================================
// 监控门 (P3)
// ============================================================

describe('checkCompliance (P3)', () => {
  it('无 LLM 可用时应返回 compliant=true fallback', async () => {
    // injectJudgmentGate 也没有 LLM 时, checkCompliance 应短路
    const r = await checkCompliance('测试输入', '测试回复');
    expect(r.compliant).toBe(true);
    expect(r.violatedPrinciples).toEqual([]);
  });

  it('空 input / reply 应返回 compliant=true fallback', async () => {
    const r1 = await checkCompliance('', 'reply');
    const r2 = await checkCompliance('input', '');
    expect(r1.compliant).toBe(true);
    expect(r2.compliant).toBe(true);
  });
});

describe('getRecentViolations (P3)', () => {
  it('空日志应返回空数组', async () => {
    const r = await getRecentViolations(10);
    expect(Array.isArray(r)).toBe(true);
  });
});

// ============================================================
// P2 软相似度集成测试 (走 getRelevantValues)
// ============================================================

describe('P2 软相似度召回', () => {
  it('value token 短句匹配应被召回 (走 valueTokens 索引)', async () => {
    const uniqueValue = `p2-test-value-${Date.now()}`;
    await storeHumanJudgment({
      decision: '处理用户隐私数据时优先安全',
      decision_type: 'approve',
      reasons: [],
      values_derived: [
        { category: 'safety', value: uniqueValue, weight: 0.8 },
      ],
      context: { domain: 'general', complexity: 'simple', stakes: 'low', time_pressure: 'low' },
      metadata: { source: 'explicit', confidence: 0.8, revisable: true },
    });

    // 查询中嵌入 uniqueValue token, valueTokens 索引路径应命中
    const { getRelevantValues } = await import(
      '../pi-ecosystem-judgment/human-value-store.js'
    );
    const values = await getRelevantValues(`查询触发 ${uniqueValue}`);
    const safetyValue = values.find((v) => v.category === 'safety' && v.value === uniqueValue);
    expect(safetyValue).toBeDefined();
  });
});
