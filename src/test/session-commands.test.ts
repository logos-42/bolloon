/**
 * session-commands.test.ts — 会话命令纯逻辑测试 (2026-10-20)
 *
 * 覆盖 session-commands.ts 的纯函数: 历史文本 / 导出文档 / 标题解析 /
 * 上下文用量格式化 / 复盘输入拼接。全夹具零 I/O (导出只测拼装不落盘)。
 */
import { describe, it, expect } from 'vitest';
import {
  stripAnsi, messageSummary, buildHistoryText, buildSaveDoc, resolveTitleArg,
  formatContextUsage, buildTurnSummary, type CliMsg,
} from '../cli/session-commands.js';

const msgs = (): CliMsg[] => [
  { role: 'user', content: '帮我看看这个仓库' },
  { role: 'assistant', content: '\u001b[32m好的, 正在扫描…\u001b[0m 仓库结构如下' },
  { role: 'tool', content: 'read_file: src/index.ts ok' },
  { role: 'user', content: '删掉死代码' },
  { role: 'assistant', content: '已删除 134 行死类' },
];

describe('stripAnsi', () => {
  it('剥掉 ANSI 色码, 保留正文', () => {
    expect(stripAnsi('\u001b[32m绿色\u001b[0m 正文 \u001b[1m加粗\u001b[0m')).toBe('绿色 正文 加粗');
  });
  it('无色码原样返回', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('messageSummary', () => {
  it('角色前缀 + 压缩空白 + 截断', () => {
    const s = messageSummary(msgs()[1], 20);
    expect(s.startsWith('🤖')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(24); // 前缀 2 + 截断 20 + 省略号
  });
  it('空内容标 (空)', () => {
    expect(messageSummary({ role: 'assistant', content: '' })).toContain('(空)');
  });
});

describe('buildHistoryText', () => {
  it('默认取最近 20 条, 全量小于 20 时全显示', () => {
    const h = buildHistoryText(msgs());
    expect(h.shown).toBe(5);
    expect(h.total).toBe(5);
    expect(h.lines.length).toBe(5);
  });
  it('N 参数截取尾部', () => {
    const h = buildHistoryText(msgs(), 2);
    expect(h.shown).toBe(2);
    expect(h.lines[0]).toContain('删掉死代码');
  });
  it('非法 N 回退默认 20', () => {
    expect(buildHistoryText(msgs(), NaN as any).shown).toBe(5);
    expect(buildHistoryText(msgs(), -3).shown).toBe(5);
  });
  it('上限 100 条', () => {
    const big = Array.from({ length: 150 }, (_, i): CliMsg => ({ role: 'user', content: `m${i}` }));
    expect(buildHistoryText(big, 500).shown).toBe(100);
  });
});

describe('buildSaveDoc', () => {
  it('md: 标题 + 角色小节 + 剥 ANSI', () => {
    const doc = buildSaveDoc(msgs(), 'md', { title: '测试会话', sessionKey: 's1', exportedAt: '2026-10-20T00:00:00Z' });
    expect(doc).toContain('# 测试会话');
    expect(doc).toContain('👤 用户');
    expect(doc).toContain('🤖 Bolloon');
    expect(doc).toContain('好的, 正在扫描… 仓库结构如下'); // ANSI 已剥
    expect(doc).not.toContain('\u001b[');
  });
  it('json: 结构化输出含 role/content/元数据', () => {
    const doc = buildSaveDoc(msgs(), 'json', { title: 'T', sessionKey: 's2' });
    const parsed = JSON.parse(doc);
    expect(parsed.title).toBe('T');
    expect(parsed.sessionKey).toBe('s2');
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.messages[0]).toEqual({ role: 'user', content: '帮我看看这个仓库' });
  });
  it('空会话也能导出 (空文档)', () => {
    const doc = buildSaveDoc([], 'md', { title: '' });
    expect(doc).toContain('# ');
  });
});

describe('resolveTitleArg', () => {
  it('空参返回 null (只查看)', () => {
    expect(resolveTitleArg('')).toEqual({ set: null });
    expect(resolveTitleArg('  ')).toEqual({ set: null });
  });
  it('有参返回裁剪后的新标题', () => {
    expect(resolveTitleArg('  新标题  ').set).toBe('新标题');
  });
  it('超过 60 字截断', () => {
    expect(resolveTitleArg('x'.repeat(80)).set!.length).toBe(60);
  });
});

describe('formatContextUsage', () => {
  it('格式化用量 + 阶段', () => {
    const s = formatContextUsage({ usedTokens: 123456, maxTokens: 1000000, pct: 0.123, stage: 'normal' });
    expect(s).toContain('123k / 1000k tokens (12%)');
    expect(s).toContain('正常');
  });
  it('有上次压缩时带时间与省 token', () => {
    const s = formatContextUsage({ usedTokens: 100, maxTokens: 1000, pct: 0.1, stage: 'compressed', lastCompressedAt: 0, lastSavedTokens: 500 });
    expect(s).toContain('压缩');
    expect(s).toContain('1k');
  });
  it('未知阶段原样展示', () => {
    const s = formatContextUsage({ usedTokens: 0, maxTokens: 1000, pct: 0, stage: 'whatever' });
    expect(s).toContain('whatever');
  });
});

describe('buildTurnSummary', () => {
  it('只拼 user/assistant, 去掉 tool, 取尾部', () => {
    const s = buildTurnSummary(msgs());
    expect(s).toContain('用户: 帮我看看这个仓库');
    expect(s).toContain('Bolloon: 已删除 134 行死类');
    expect(s).not.toContain('read_file');
  });
  it('空会话返回空串', () => {
    expect(buildTurnSummary([])).toBe('');
  });
  it('超过 maxChars 截尾', () => {
    const long = Array.from({ length: 30 }, (_, i): CliMsg => ({ role: 'user', content: `内容${i}`.repeat(100) }));
    expect(buildTurnSummary(long, 500).length).toBeLessThanOrEqual(500);
  });
});
