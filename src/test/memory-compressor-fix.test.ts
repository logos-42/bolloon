/**
 * memory-compressor-fix.test.ts — memory-compressor 修复验证 (2026-08-06)
 *
 * 覆盖:
 *   - SessionStore role 字段消息 → 正确归一化为 user/ai type
 *   - 老 type 字段格式兼容
 *   - 空壳消息过滤
 *   - 真实 cache 文件 → compressSessionToMemory 统计正确 (user/ai 计数)
 *   - LLM 摘要不可用时降级模板 (不抛错)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  compressSessionToMemory,
  getSessionSummaryPath,
  getSessionCursorPath,
  sanitizeKey,
  extractValuePoints,
} from '../bootstrap/memory-compressor.js';

const TEST_HOME = path.join(os.tmpdir(), 'bolloon-mc-test', String(Date.now()));
const AGENT = 'test-agent-fix';
const CHANNEL = 'ch_1785668060213_28hyil';
const SESSION = 'sess_1785668196946';

function cachePath(channel: string, session: string): string {
  const root = path.join(TEST_HOME, '.bolloon', 'sessions', 'cache');
  return path.join(root, `${sanitizeKey(channel)}__${sanitizeKey(session)}.json`);
}

async function writeCache(channel: string, session: string, messages: any[]): Promise<void> {
  const p = cachePath(channel, session);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ channelId: channel, sessionId: session, messages, lastUpdated: new Date().toISOString() }), 'utf-8');
}

describe('compressSessionToMemory 字段兼容', () => {
  beforeEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });
  afterEach(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it('SessionStore role 字段消息 (user/assistant) 被正确统计 — 不再 user=0/ai=0', async () => {
    // 模拟 SessionStore 真实格式: {role: 'user'|'assistant', content}
    await writeCache(CHANNEL, SESSION, [
      { role: 'user', content: '你好', timestamp: '2026-08-06T00:00:00.000Z' },
      { role: 'assistant', content: '你好呀! 我是 bolloon', timestamp: '2026-08-06T00:00:01.000Z' },
      { role: 'user', content: '帮我写个脚本', timestamp: '2026-08-06T00:00:02.000Z' },
      { role: 'assistant', content: '好的, 已完成', timestamp: '2026-08-06T00:00:03.000Z' },
    ]);
    const res = await compressSessionToMemory({ agentId: AGENT, channelId: CHANNEL, sessionId: SESSION, home: TEST_HOME, minNewMessages: 4 });
    expect(res.skipped).toBeUndefined();
    expect(res.messagesCount).toBe(4);
    // 模板 fallback (测试环境 LLM 未初始化) — 但消息统计必须正确
    const summary = await fs.readFile(res.summaryPath, 'utf-8');
    expect(summary).toContain('user=2, ai=2');
    expect(summary).toContain('帮我写个脚本');  // 用户内容进入摘要
    // cursor 推进
    const cursor = await fs.readFile(res.cursorPath, 'utf-8');
    expect(cursor.trim()).toBe('4');
  });

  it('老 type 字段格式兼容', async () => {
    await writeCache(CHANNEL, SESSION, [
      { type: 'user', content: '旧格式消息', timestamp: '2026-08-06T00:00:00.000Z' },
      { type: 'ai', content: '旧格式回复', timestamp: '2026-08-06T00:00:01.000Z' },
      { type: 'user', content: '第二条', timestamp: '2026-08-06T00:00:02.000Z' },
      { type: 'ai', content: '第二条回复', timestamp: '2026-08-06T00:00:03.000Z' },
    ]);
    const res = await compressSessionToMemory({ agentId: AGENT, channelId: CHANNEL, sessionId: SESSION, home: TEST_HOME, minNewMessages: 4 });
    expect(res.messagesCount).toBe(4);
    const summary = await fs.readFile(res.summaryPath, 'utf-8');
    expect(summary).toContain('user=2, ai=2');
  });

  it('空壳消息 (无 type/role) 被过滤', async () => {
    await writeCache(CHANNEL, SESSION, [
      { role: 'user', content: '真实消息', timestamp: 'x' },
      { content: 'no-role' },  // 空壳
      { role: 'assistant', content: '回复', timestamp: 'x' },
      { role: 'user', content: '再来一条', timestamp: 'x' },
      { role: 'assistant', content: '好的', timestamp: 'x' },
      { role: 'system', content: '系统提示' },  // system 不计入 user/ai
    ]);
    const res = await compressSessionToMemory({ agentId: AGENT, channelId: CHANNEL, sessionId: SESSION, home: TEST_HOME, minNewMessages: 4 });
    // 6 条输入, 过滤空壳 1 条 → 5 条可用 (user=2, ai=2, system=1)
    expect(res.messagesCount).toBe(5);
  });

  it('消息不足不触发 (too-few-messages)', async () => {
    await writeCache(CHANNEL, SESSION, [
      { role: 'user', content: '只有一条', timestamp: 'x' },
      { role: 'assistant', content: '回复', timestamp: 'x' },
    ]);
    const res = await compressSessionToMemory({ agentId: AGENT, channelId: CHANNEL, sessionId: SESSION, home: TEST_HOME, minNewMessages: 4 });
    expect(res.skipped).toBe('too-few-messages');
  });
});

describe('extractValuePoints', () => {
  it('解析 decision/lesson/knowledge/insight 行 (上限 3 条, 设计 0-3)', () => {
    const body = `## 关键发现\n- 发现了 X\n\n## 价值点\n- (decision) 决定用 Y 方案\n- (lesson) 别在压缩时丢消息\n- (knowledge) 字段名要统一\n- (insight) 用户要的是资源管理\n`;
    const points = extractValuePoints(body);
    expect(points).toHaveLength(3);  // slice(0,3) 设计上限
    expect(points[0].type).toBe('decision');
    expect(points[1].type).toBe('lesson');
    expect(points[2].type).toBe('knowledge');
  });

  it('无价值点段 → []', () => {
    expect(extractValuePoints('## 关键发现\n- 什么都没有')).toEqual([]);
  });
});
