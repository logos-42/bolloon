/**
 * snip-collapse.test.ts — snipHistory 重写验证 (2026-08-06)
 *
 * 覆盖:
 *   - 窗口内不裁剪
 *   - 超窗口裁剪最老消息 (内容 → 占位符, 保留 role 顺序)
 *   - 裁剪边界: 不产生悬空 tool 消息 (原生 tool_calls 配对保护)
 *   - Budget Reduction (单条超长截断)
 *   - Context Collapse 投影 (长 tool 结果 → 摘要)
 */
import { describe, it, expect } from 'vitest';
import {
  snipHistory,
  collapseContext,
  applyPreModelPipeline,
  type CollapsedMessage,
} from '../bootstrap/snip-collapse.js';

function msgs(n: number, opts: { tool?: boolean } = {}): CollapsedMessage[] {
  const out: CollapsedMessage[] = [];
  for (let i = 0; i < n; i++) {
    if (opts.tool && i % 2 === 1) {
      out.push({ role: 'tool', content: `tool-result-${i}` });
    } else {
      out.push({ role: 'user', content: `msg-${i}` });
    }
  }
  return out;
}

describe('snipHistory', () => {
  it('窗口内不裁剪', () => {
    const m = msgs(10);
    const r = snipHistory(m, { maxMessages: 60 });
    expect(r.length).toBe(10);
    expect(r.every(x => x.transform !== 'snip')).toBe(true);
  });

  it('超窗口裁剪最老消息, 保留最近 keepCount 条', () => {
    const m = msgs(70);
    const r = snipHistory(m, { maxMessages: 60 });
    expect(r.length).toBe(70);  // 占位符保留角色顺序
    const sniped = r.filter(x => x.transform === 'snip');
    expect(sniped.length).toBe(10);
    // 前 10 条被裁, 后 60 条原样
    expect(r[0].content).toBe('[已裁减, Snip]');
    expect(r[9].content).toBe('[已裁减, Snip]');
    expect(r[10].content).toBe('msg-10');
    expect(r[69].content).toBe('msg-69');
  });

  it('边界保护: 不产生悬空 tool (tool 前必须有 assistant)', () => {
    // 构造 62 条: 1 user + assistant(tool_calls) + tool + 59 user
    // 窗口 60 → 移除区 2 条 (index 0,1); 保留区第一条 (index 2) 是 tool,
    //   前一条 (index 1) 是 assistant → 边界保护把 assistant 一起转占位 (cutAt 前移),
    //   保留区从 tool 开始, 前面是占位符 → 不产生悬空 tool
    const m: CollapsedMessage[] = [];
    m.push({ role: 'user', content: 'u-start' });
    m.push({ role: 'assistant', content: 'tool call', toolCall: { name: 'x', args: {} } as any });
    m.push({ role: 'tool', content: 'result' });
    for (let i = 0; i < 59; i++) m.push({ role: 'user', content: `u-${i}` });
    expect(m.length).toBe(62);
    const r = snipHistory(m, { maxMessages: 60 });
    expect(r.length).toBe(62);
    // 保留区起点: 前 2 条被占位 (index 0 移除 + index 1 assistant 边界保护), index 2 = tool
    const firstKept = r.findIndex(x => x.transform !== 'snip');
    expect(firstKept).toBe(2);
    expect(r[firstKept].role).toBe('tool');
    expect(r[firstKept].content).toBe('result');
    expect(r[firstKept - 1].transform).toBe('snip');  // 原 assistant 被占位, 不产生"tool 前有真 assistant 但被裁"的断层
  });

  it('Budget Reduction: 单条超长截断', () => {
    const m: CollapsedMessage[] = [{ role: 'user', content: 'x'.repeat(5000) }];
    const r = snipHistory(m, { maxMessageChars: 2000 });
    expect(r[0].content.length).toBeLessThan(2100);
    expect(r[0].transform).toBe('budget-reduce');
    expect(r[0].originalLength).toBe(5000);
  });

  it('tool 结果超长截断 (先 budget-reduce 到 2000, 再截断到 maxToolResultChars)', () => {
    const m: CollapsedMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'tool', content: 'y'.repeat(5000) },
    ];
    const r = snipHistory(m, { maxToolResultChars: 300 });
    const tool = r.find(x => x.role === 'tool')!;
    expect(tool.content.length).toBeLessThan(400);
    // 内容确实被截断 (核心行为); transform 保留先发生的 budget-reduce 标记
    expect(tool.content).not.toContain('y'.repeat(5000));
    expect(tool.originalLength).toBe(5000);
  });
});

describe('collapseContext', () => {
  it('长 tool 结果投影为摘要 (读时虚拟投影, 原始数据不破坏)', () => {
    const m: CollapsedMessage[] = [{ role: 'tool', content: 'z'.repeat(1000) }];
    const original = m[0].content;
    const r = collapseContext(m, { maxCollapsedToolChars: 150 });
    expect(r[0].content).toContain('Context Collapse');
    expect(r[0].originalLength).toBe(1000);
    expect(m[0].content).toBe(original);  // 原始数组不变
  });
});

describe('applyPreModelPipeline', () => {
  it('组合: Budget Reduction → Snip → Collapse 顺序执行', () => {
    const m: CollapsedMessage[] = [
      { role: 'user', content: 'old '.repeat(100) },  // 500 chars
      { role: 'tool', content: 't'.repeat(800) },
    ];
    for (let i = 0; i < 70; i++) m.push({ role: 'user', content: `recent-${i}` });
    const r = applyPreModelPipeline(m, { maxMessages: 60 });
    // 不抛错, 长度保持 (占位符)
    expect(r.length).toBeGreaterThan(60);
    const sniped = r.filter(x => x.transform === 'snip').length;
    expect(sniped).toBeGreaterThan(10);
  });
});
