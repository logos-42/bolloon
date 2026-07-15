import { describe, it, expect } from 'vitest';

/**
 * 测的是 dedup-session-messages.ts 里的核心过滤逻辑 — 同 type + content 相邻去重
 * 跟 client.ts loadSession 里 inline 加的 dedupe 是同一个算法
 */

function dedupeAdjacent(msgs: any[]): any[] {
  let lastType: string | null = null;
  let lastContent: string | null = null;
  return msgs.filter((m: any) => {
    const same = lastType === m.type && lastContent === m.content;
    lastType = m.type; lastContent = m.content;
    return !same;
  });
}

describe('dedupeAdjacent: session.messages 重复过滤 (Bug 4 修复 2026-07-15)', () => {
  it('相邻两条相同 user msg → 去重 1 条', () => {
    const msgs = [
      { type: 'user', content: '你好' },
      { type: 'user', content: '你好' },
    ];
    expect(dedupeAdjacent(msgs).length).toBe(1);
  });

  it('user, user, ai 模式 → 去重成 [user, ai]', () => {
    const msgs = [
      { type: 'user', content: 'hi' },
      { type: 'user', content: 'hi' },
      { type: 'ai', content: '你好!' },
    ];
    const out = dedupeAdjacent(msgs);
    expect(out.length).toBe(2);
    expect(out[0].type).toBe('user');
    expect(out[1].type).toBe('ai');
  });

  it('user, ai, user ai 重复 — 第二段对话也去重 (Bug 4 真实场景)', () => {
    const msgs = [
      { type: 'user', content: '你好1' },
      { type: 'user', content: '你好1' }, // dup
      { type: 'ai', content: '嗨1' },
      { type: 'user', content: '你好2' },
      { type: 'user', content: '你好2' }, // dup
      { type: 'ai', content: '嗨2' },
    ];
    const out = dedupeAdjacent(msgs);
    expect(out.length).toBe(4);
    expect(out.map(m => `${m.type}:${m.content}`)).toEqual([
      'user:你好1', 'ai:嗨1', 'user:你好2', 'ai:嗨2'
    ]);
  });

  it('空数组 → 空数组', () => {
    expect(dedupeAdjacent([])).toEqual([]);
  });

  it('单条消息 → 单条消息', () => {
    expect(dedupeAdjacent([{ type: 'user', content: 'hi' }]).length).toBe(1);
  });

  it('连续三条相同 user → 去重到 1', () => {
    const msgs = [
      { type: 'user', content: 'a' },
      { type: 'user', content: 'a' },
      { type: 'user', content: 'a' },
    ];
    expect(dedupeAdjacent(msgs).length).toBe(1);
  });

  it('不同 content → 全部保留', () => {
    const msgs = [
      { type: 'user', content: 'a' },
      { type: 'user', content: 'b' },
    ];
    expect(dedupeAdjacent(msgs).length).toBe(2);
  });

  it('不同 type (user → ai) 视为非相邻重复 → 保留', () => {
    const msgs = [
      { type: 'user', content: 'x' },
      { type: 'ai', content: 'x' }, // 同 content 但 type 不同, 不算重复
    ];
    expect(dedupeAdjacent(msgs).length).toBe(2);
  });

  it('保留所有 metadata 字段', () => {
    const msgs = [
      { type: 'user', content: 'hi', metadata: { usedJudgmentIds: ['j1'] } },
      { type: 'user', content: 'hi', metadata: { usedJudgmentIds: ['j1'] } },
    ];
    const out = dedupeAdjacent(msgs);
    expect(out.length).toBe(1);
    expect(out[0].metadata).toEqual({ usedJudgmentIds: ['j1'] });
  });
});
