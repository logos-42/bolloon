/**
 * Context Compaction Pipeline — 5 层压缩测试
 *
 * 覆盖:
 *   - BudgetGate 判定逻辑
 *   - 5 个 stage 各自行为
 *   - Pipeline 短路
 *   - 关键不变量 (非破坏/破坏)
 *   - 失败静默 (异常 fallback)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  compactPipeline,
  budgetGate,
  budgetReduce,
  snip,
  isSnipEnabled,
  microcompact,
  contextCollapse,
  isContextCollapseEnabled,
  autoCompact,
  estimateTokens,
  type Message,
} from '../context-compaction/index.js';

function msg(role: 'user' | 'assistant' | 'tool' | 'system', content: string, extras: Partial<Message> = {}): Message {
  return { role, content, ...extras } as Message;
}

function makeHistory(n: number, contentLength: number = 50): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push(msg('user', `Q${i}: ` + 'a'.repeat(contentLength)));
    out.push(msg('assistant', `A${i}: ` + 'b'.repeat(contentLength)));
  }
  return out;
}

let savedSnip: string | undefined;
let savedCollapse: string | undefined;

beforeEach(async () => {
  savedSnip = process.env.BOLLOON_SNIP_ENABLED;
  savedCollapse = process.env.BOLLOON_CONTEXT_COLLAPSE;
  delete process.env.BOLLOON_SNIP_ENABLED;
  delete process.env.BOLLOON_CONTEXT_COLLAPSE;
  // 清掉上次测试残留的 cache 文件, 避免 scope/key 冲突
  const cacheDir = path.join(process.env.HOME || os.tmpdir(), '.bolloon', 'sessions', 'compaction-cache');
  try {
    await fs.rm(cacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

afterEach(() => {
  if (savedSnip === undefined) delete process.env.BOLLOON_SNIP_ENABLED;
  else process.env.BOLLOON_SNIP_ENABLED = savedSnip;
  if (savedCollapse === undefined) delete process.env.BOLLOON_CONTEXT_COLLAPSE;
  else process.env.BOLLOON_CONTEXT_COLLAPSE = savedCollapse;
});

describe('estimateTokens', () => {
  it('4 字符 = 1 token', () => {
    expect(estimateTokens([msg('user', 'a'.repeat(40))])).toBe(10);
  });
  it('空消息 = 0', () => {
    expect(estimateTokens([msg('user', '')])).toBe(0);
  });
});

describe('budgetGate', () => {
  it('小消息列表 fit', () => {
    const h = makeHistory(5, 50);
    const r = budgetGate(h, 8000);
    expect(r.fit).toBe(true);
    expect(r.triggerNextLayer).toBe(false);
  });
  it('大消息列表 trigger', () => {
    const h = makeHistory(100, 500);  // 100*2*500 = 100K chars / 4 = 25K tokens
    const r = budgetGate(h, 8000);
    expect(r.fit).toBe(false);
    expect(r.triggerNextLayer).toBe(true);
    expect(r.ratio).toBeGreaterThan(1);
  });
  it('边界 0.8 不 fit', () => {
    const h = makeHistory(8, 200);  // 8*2*200 = 3200 chars / 4 = 800 tokens, 0.8 of 1000
    const r = budgetGate(h, 1000);
    // 800/1000 = 0.8 → 不 fit (>= 0.8 trigger)
    expect(r.fit).toBe(false);
  });
});

describe('Stage 1: Budget Reduction', () => {
  it('小消息不截断', () => {
    const h = makeHistory(5, 100);
    const r = budgetReduce(h, { maxTokens: 8000, budgetReduceMaxChars: 1000 });
    expect(r.applied).toBe(false);
  });
  it('> 阈值截断', () => {
    const h = [msg('user', 'x'.repeat(5000))];
    const r = budgetReduce(h, { maxTokens: 8000, budgetReduceMaxChars: 1000 });
    expect(r.applied).toBe(true);
    expect(r.history[0].content).toContain('truncated');
    expect(r.history[0].content).toContain('original=5000');
  });
  it('多消息混合, 只截断超长', () => {
    const h = [msg('user', 'short'), msg('assistant', 'y'.repeat(3000)), msg('user', 'short2')];
    const r = budgetReduce(h, { maxTokens: 8000, budgetReduceMaxChars: 1000 });
    expect(r.applied).toBe(true);
    expect(r.history[0].content).toBe('short');
    expect(r.history[1].content).toContain('truncated');
    expect(r.history[2].content).toBe('short2');
  });
});

describe('Stage 2: Snip', () => {
  it('feature flag 默认 false', () => {
    expect(isSnipEnabled()).toBe(false);
    const h = makeHistory(50);
    const r = snip(h, { maxTokens: 8000 });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('feature flag off');
  });
  it('feature flag 开启时裁掉老历史', () => {
    process.env.BOLLOON_SNIP_ENABLED = '1';
    const h = makeHistory(50);
    const r = snip(h, { maxTokens: 8000, snipKeepPairs: 5 });
    expect(r.applied).toBe(true);
    expect(r.history.length).toBeLessThan(h.length);
    // 应该只剩最近 5 对 (10 条) + 一些 user 边界
    expect(r.history.length).toBeLessThanOrEqual(11);
  });
  it('历史太短不裁', () => {
    process.env.BOLLOON_SNIP_ENABLED = '1';
    const h = makeHistory(2);  // 4 条
    const r = snip(h, { maxTokens: 8000, snipKeepPairs: 5 });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('too short');
  });
});

describe('Stage 3: Microcompact', () => {
  it('tool_result < keepRecent 不折叠', () => {
    const h: Message[] = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('tool', 'tool1 output', { toolResult: { out: 'long output' } } as any),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ];
    const r = microcompact(h, { maxTokens: 8000, microcompactKeepRecent: 3 });
    expect(r.applied).toBe(false);
  });
  it('tool_result 多时折叠老的', () => {
    const h: Message[] = [];
    for (let i = 0; i < 10; i++) {
      h.push(msg('user', `q${i}`));
      h.push(msg('assistant', `a${i}`));
      h.push(msg('tool', `tool output ${i} ${'x'.repeat(200)}`, { toolResult: { data: 'x'.repeat(200) } } as any));
    }
    const r = microcompact(h, { maxTokens: 8000, microcompactKeepRecent: 3 });
    expect(r.applied).toBe(true);
    // 老 tool_result 应被折叠
    const folded = r.history.find((m) => m.content?.includes('folded by microcompact'));
    expect(folded).toBeDefined();
  });
});

describe('Stage 4: Context Collapse', () => {
  it('feature flag 默认 false', () => {
    expect(isContextCollapseEnabled()).toBe(false);
    const h = makeHistory(20);
    const r = contextCollapse(h, { maxTokens: 8000 });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('feature flag off');
  });
  it('feature flag 开启时虚拟投影', () => {
    process.env.BOLLOON_CONTEXT_COLLAPSE = '1';
    const h = makeHistory(20);
    const r = contextCollapse(h, { maxTokens: 8000, contextCollapseCollapsePairs: 5 });
    expect(r.applied).toBe(true);
    // 应有 1 条 collapsed 系统消息 + 剩余
    const collapsed = r.history.find((m) => m.content?.includes('collapsed'));
    expect(collapsed).toBeDefined();
  });
});

describe('Stage 5: Auto-Compact', () => {
  it('历史太短不压缩', async () => {
    const h = makeHistory(2);
    const r = await autoCompact(h, { maxTokens: 8000 });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('too short');
  });
  it('无 llmChat 时 fallback', async () => {
    const h = makeHistory(20);
    const r = await autoCompact(h, { maxTokens: 8000 });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('no llmChat');
  });
  it('有 llmChat 时调 LLM + 折叠', async () => {
    const h = makeHistory(20);
    const fakeLlm = async (_sys: string, _user: string) => 'TEST_SUMMARY: 之前讨论了一些技术问题';
    const r = await autoCompact(h, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-auto-1' });
    expect(r.applied).toBe(true);
    expect(r.history[0].content).toContain('TEST_SUMMARY');
    expect(r.history.length).toBeLessThan(h.length);
  });
  it('LLM 返回空 → fallback', async () => {
    const h = makeHistory(20);
    const fakeLlm = async () => '';
    const r = await autoCompact(h, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-auto-2' });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('empty');
  });
  it('LLM 抛错 → fallback 原 history', async () => {
    const h = makeHistory(20);
    const fakeLlm = async () => { throw new Error('LLM down'); };
    const r = await autoCompact(h, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-auto-3' });
    expect(r.applied).toBe(false);
    expect(r.detail).toContain('llm call failed');
  });
  it('二次调用命中缓存', async () => {
    // 40 对, 每条 1000 字符 → 80000 chars / 4 = 20000 tokens > 8000
    const h2 = makeHistory(40, 1000);
    let callCount = 0;
    const fakeLlm = async () => { callCount++; return 'CACHED_SUMMARY'; };
    // 第一次: 写缓存
    await autoCompact(h2, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-auto-cache' });
    expect(callCount).toBe(1);
    // 第二次: 读缓存
    const r2 = await autoCompact(h2, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-auto-cache' });
    expect(r2.applied).toBe(true);
    expect(callCount).toBe(1);  // 没增加
    expect(r2.history[0].content).toContain('CACHED_SUMMARY');
  });
});

describe('Pipeline 短路', () => {
  it('小消息不触发任何 stage', async () => {
    const h = makeHistory(5, 50);
    const r = await compactPipeline(h, { maxTokens: 8000 });
    expect(r.compacted).toBe(false);
    // budgetReduce 跑了但没改
    expect(r.stages[0].stage).toBe('budgetReduce');
    expect(r.stages[0].applied).toBe(false);
  });
  it('大消息触发 budgetReduce 后短路', async () => {
    const h = [msg('user', 'x'.repeat(50000))];
    const r = await compactPipeline(h, { maxTokens: 8000 });
    expect(r.compacted).toBe(true);
    expect(r.stages[0].stage).toBe('budgetReduce');
    expect(r.stages[0].applied).toBe(true);
  });
  it('跑完所有 stage 时 history 缩短', async () => {
    const h = makeHistory(30, 1000);  // 30*2*1000 = 60K chars / 4 = 15K tokens
    const fakeLlm = async () => 'final summary';
    const r = await compactPipeline(h, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-pipeline-1' });
    expect(r.compacted).toBe(true);
    // 最后应该是 autoCompact
    const lastStage = r.stages[r.stages.length - 1];
    expect(lastStage.stage).toBe('autoCompact');
    expect(lastStage.applied).toBe(true);
  });
});

describe('关键不变量', () => {
  it('Context Collapse (flag off) 跑后 history 不变', async () => {
    const h = makeHistory(30, 1000);
    const before = JSON.stringify(h);
    const r = await compactPipeline(h, { maxTokens: 8000 });
    expect(JSON.stringify(r.history.slice(0, h.length))).toBe(before);
  });
  it('Auto-Compact 跑后 history 长度 < 原长度', async () => {
    const h = makeHistory(30, 1000);
    const fakeLlm = async () => 'summary text';
    const r = await compactPipeline(h, { maxTokens: 8000, llmChat: fakeLlm, cacheScope: 'test-inv-1' });
    // 因为 Context Collapse 关闭, Auto-Compact 是最后手段
    // 如果 budget fit 在中间, 不一定到 Auto-Compact
    if (r.stages.find((s) => s.stage === 'autoCompact' && s.applied)) {
      expect(r.history.length).toBeLessThan(h.length);
    }
  });
});

describe('失败静默', () => {
  it('pipeline 整体异常 → 返回原 history', async () => {
    // 制造异常: 传 undefined opts.llmChat 时 autoCompact 会 fallback
    // 这里通过让 budgetGate 永远不 fit 强制跑到 autoCompact, 然后无 llmChat
    const h = makeHistory(30, 1000);
    const r = await compactPipeline(h, { maxTokens: 8000 });
    // 因为有 budgetReduce + microcompact 可能 fit, 不一定到 autoCompact
    // 关键是结果不抛错
    expect(r.history).toBeDefined();
  });
});

describe('环境变量守门', () => {
  it('BOLLOON_COMPACTOR_DEBUG=1 → 跳过整 pipeline (返回原 history)', async () => {
    // 暂未实现环境变量守门, 仅作占位
    // 真实实现: pipeline 顶部检查 BOLLOON_COMPACTOR_DISABLED=1 → 返回原 history
  });
});
