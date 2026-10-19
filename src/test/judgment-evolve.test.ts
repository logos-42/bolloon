/**
 * 判断力演化留痕 + 节流 key 归一化 + CLI D-hook 挂点 (2026-10-19, leo: 「继续深挖并且补缺口」)
 *
 * 深挖结论 (三个缺口/bug, 本文件钉住前两个 + 挂点):
 *   ① evolveNewJudgment 的 merge/supersede/contradict 不写 evolution.jsonl —— audit/回滚源里
 *      从来没有演化动作, "演化到底跑没跑"只能翻 judgments.json 的 status ✗
 *   ② debounce 只读 context.channelId, 而 detect-hook 存的是 context.domain='channel:x'
 *      ⇒ 节流永不生效, 每次 D 存储都全量 jaccard 扫库 + 可能调 LLM ✗
 *   ③ D-hook 只在 web/server 消息路径, CLI 主路径没有挂点 ⇒ 捕获腿 17 天静默 (pi-sdk 已补, ③ 源级钉住)
 *
 * LLM 纪律: 全部夹具要么 jaccard>0.85 (直接 merge, 不调 LLM) 要么 <0.3 (unrelated, 不调 LLM),
 *   与 judgment-distill.test.ts 同规 —— 单测零真 LLM。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { evolveNewJudgment, clearEvolveDebounce, channelKeyOf } from '../pi-ecosystem-judgment/evolve-judgment.js';
import { readEvolutionLog } from '../pi-ecosystem-judgment/adaptive-scan.js';
import {
  storeHumanJudgment,
  listJudgmentsByStatus,
  initializeValueStore,
} from '../pi-ecosystem-judgment/human-value-store.js';

const TEST_DIR = path.join(os.tmpdir(), `bolloon-evolve-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;

/** 夹具工厂: 全带 reasons (绕过 junk 门的"短决策+无理由"启发式), 域可控 */
function fixture(decision: string, domain: string) {
  return storeHumanJudgment({
    decision,
    decision_type: 'approve',
    reasons: ['测试夹具'],
    values_derived: [],
    context: { domain, complexity: 'moderate', stakes: 'medium', time_pressure: 'low' },
    metadata: { source: 'implicit', confidence: 0.8, revisable: true },
  });
}

beforeAll(async () => {
  process.env.HOME = TEST_DIR;
  await fs.mkdir(TEST_DIR, { recursive: true });
  await initializeValueStore();
});
afterAll(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  clearEvolveDebounce();
  try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('① evolve 动作写 evolution.jsonl 留痕 (merge/supersede 不再只活在内存里)', () => {
  it('高 jaccard merge ⇒ 旧条 superseded + evolution.jsonl 出现可检索的 evolve:<newId> 行', async () => {
    const old1 = await fixture('提交代码前必须先等待预提交钩子全部跑完', 'test');
    // 尾部句号会被 normalize 剥掉 ⇒ 与 old1 字符集全同 ⇒ jaccard=1.0 > 0.85 ⇒ 直接 merge, 零 LLM
    const new1 = await fixture('提交代码前必须先等待预提交钩子全部跑完。', 'test');
    const outcome = await evolveNewJudgment(new1, { skipDebounce: true });

    expect(outcome.merged.map((m) => m.id), 'jaccard=1.0 必须直接 merge').toContain(old1.id);
    expect(outcome.llmCompared, '纯 merge 路径不许调 LLM').toBe(0);

    const active = await listJudgmentsByStatus('active');
    expect(active.map((j) => j.id), '旧条被 superseded').not.toContain(old1.id);
    expect(active.map((j) => j.id), '新条保持 active').toContain(new1.id);

    const log = await readEvolutionLog(100);
    const entry = log.find((e) => e.suggestion?.key === `evolve:${new1.id}`);
    expect(entry, 'evolution.jsonl 里必须能按 evolve:<newId> 检索到这次演化').toBeTruthy();
    expect(entry!.suggestion.reason).toContain('merged=1');
    expect(entry!.suggestion.reason).toContain(`supersededIds=${old1.id}`);
    expect(entry!.suggestion.decision).toContain('预提交钩子');
  });

  it('无 merge/无 LLM 比对 ⇒ 不写留痕 (避免给 evolution.jsonl 添噪音)', async () => {
    const lone = await fixture('完全无关的独立原则甲乙丙丁', 'test');
    const outcome = await evolveNewJudgment(lone, { skipDebounce: true });
    expect(outcome.merged).toEqual([]);
    expect(outcome.llmCompared).toBe(0);
    const log = await readEvolutionLog(100);
    expect(log.find((e) => e.suggestion?.key === `evolve:${lone.id}`)).toBeUndefined();
  });
});

describe('② debounce key 归一化: context.domain="channel:x" 也要节流 (旧代码永不生效)', () => {
  it('同 channel 第二次 evolve 必须被节流: 不碰库、不写留痕', async () => {
    clearEvolveDebounce();
    const oldA = await fixture('写入文件前先校验目标路径', 'channel:deb');
    const newA = await fixture('写入文件前先校验目标路径,', 'channel:deb');   // jaccard=1.0 ⇒ merge, 零 LLM
    const oldB = await fixture('另一条不相干的原则阿尔法', 'channel:deb');
    const newB = await fixture('另一条不相干的原则阿尔法。', 'channel:deb');  // 与 oldB 全同, 与 newA 无关

    const first = await evolveNewJudgment(newA);
    expect(first.merged.map((m) => m.id)).toContain(oldA.id);

    const second = await evolveNewJudgment(newB);   // 同 channel ⇒ 60s 内必须早退
    expect(second.merged, '被节流 ⇒ 不许 merge').toEqual([]);
    expect(second.llmCompared).toBe(0);

    const active = await listJudgmentsByStatus('active');
    expect(active.map((j) => j.id), '被节流 ⇒ oldB 不许被 superseded').toContain(oldB.id);
    const log = await readEvolutionLog(100);
    expect(log.find((e) => e.suggestion?.key === `evolve:${newB.id}`),
      '被节流 ⇒ 不许写留痕').toBeUndefined();
  });

  it('channelKeyOf 纯函数: channelId 优先, domain="channel:x" 次之, 其余 undefined', () => {
    const ctx = { domain: 'channel:abc', complexity: 'moderate' as const, stakes: 'medium' as const, time_pressure: 'low' as const };
    expect(channelKeyOf({ context: ctx })).toBe('abc');
    expect(channelKeyOf({ context: { ...ctx, domain: 'general', channelId: 'xyz' } as any })).toBe('xyz');
    expect(channelKeyOf({ context: { ...ctx, domain: 'general' } })).toBeUndefined();
    expect(channelKeyOf({ context: undefined as any })).toBeUndefined();
  });
});

describe('③ 源级反回归: CLI 主路径必须挂 D-hook (旧: 只有 web/server 消息路径有 ⇒ 捕获腿不存在)', () => {
  it('pi-sdk 收尾要调 detectAndDistillFromChannel + throttleDHook, 结果落 judgment-dhook.log', async () => {
    const src = await fs.readFile(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    expect(src).toContain('detectAndDistillFromChannel(');
    expect(src, '5min/channel 节流 (与 web 路径共用节流表, 双路径不重复触发)').toContain('throttleDHook(');
    expect(src, '结果如实落日志文件, 不进回复流').toContain('judgment-dhook.log');
    // 回合收尾 fire-and-forget: 不阻塞主回合的形态 (void import 链)
    expect(src).toMatch(/void import\('\.\.\/pi-ecosystem-judgment\/detect-hook\.js'\)/);
  });
});
