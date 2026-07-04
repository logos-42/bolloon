/**
 * memory-compressor.ts 单元测试
 * 覆盖: 路径函数 / compressSessionToMemory (含 LLM fallback) / cursor 推进
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  compressSessionToMemory,
  getMemoryDir,
  getSessionSummaryPath,
  getSessionCursorPath,
  sanitizeAgentId,
  type MemoryCompressResult,
} from '../bootstrap/memory-compressor.js';

const TEST_HOME = path.join(os.tmpdir(), `bolloon-memtest-${Date.now()}`);
const TEST_AGENT = 'memtest_agent';
const TEST_CHANNEL = 'ch_memtest_001';
const TEST_SESSION = 'sess_test_001';

beforeAll(async () => {
  // 建 ~/.bolloon/sessions/cache/<channel>__<session>.json
  await fs.mkdir(path.join(TEST_HOME, '.bolloon', 'sessions', 'cache'), { recursive: true });
});

afterAll(async () => {
  try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  // 每个 test 前清掉 memory dir 和 session file
  await fs.rm(path.join(TEST_HOME, '.bolloon', 'memory'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(TEST_HOME, '.bolloon', 'sessions', 'cache'), { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(TEST_HOME, '.bolloon', 'sessions', 'cache'), { recursive: true });
});

async function writeSessionMessages(messages: any[]): Promise<void> {
  const file = path.join(TEST_HOME, '.bolloon', 'sessions', 'cache', `${TEST_CHANNEL}__${TEST_SESSION}.json`);
  await fs.writeFile(file, JSON.stringify({ messages, lastUpdated: new Date().toISOString() }), 'utf-8');
}

describe('路径函数', () => {
  it('getMemoryDir 路径正确', () => {
    expect(getMemoryDir(TEST_AGENT, TEST_HOME)).toBe(path.join(TEST_HOME, '.bolloon', 'memory', TEST_AGENT));
  });
  it('getSessionSummaryPath 路径正确', () => {
    const p = getSessionSummaryPath(TEST_AGENT, TEST_CHANNEL, TEST_SESSION, TEST_HOME);
    expect(p).toContain('sessions');
    expect(p).toContain(`${TEST_CHANNEL}__${TEST_SESSION}.summary.md`);
  });
  it('getSessionCursorPath 路径正确', () => {
    const p = getSessionCursorPath(TEST_AGENT, TEST_CHANNEL, TEST_SESSION, TEST_HOME);
    expect(p).toContain(`${TEST_CHANNEL}__${TEST_SESSION}.cursor`);
  });
  it('sanitizeAgentId 安全', () => {
    expect(sanitizeAgentId('../../etc/passwd')).not.toContain('/');
    expect(sanitizeAgentId('agent/test')).toBe('agent_test');
  });
});

describe('compressSessionToMemory', () => {
  it('session 文件不存在 → skipped: no-new-messages', async () => {
    const r = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r.skipped).toBe('no-new-messages');
    expect(r.bytesWritten).toBe(0);
  });

  it('session 含 5 条 messages → 写 summary.md (LLM 失败 fallback 模板)', async () => {
    await writeSessionMessages([
      { type: 'user', content: '你好', timestamp: new Date().toISOString() },
      { type: 'ai', content: 'hi', timestamp: new Date().toISOString() },
      { type: 'user', content: '今天怎么样', timestamp: new Date().toISOString() },
      { type: 'ai', content: '还行', timestamp: new Date().toISOString() },
      { type: 'user', content: '再问一个', timestamp: new Date().toISOString() },
    ]);

    const r = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r.skipped).toBeUndefined();
    expect(r.messagesCount).toBe(5);
    expect(r.bytesWritten).toBeGreaterThan(0);

    const summaryPath = r.summaryPath;
    const exists = await fs.stat(summaryPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    const content = await fs.readFile(summaryPath, 'utf-8');
    expect(content).toContain('Session 摘要');
    expect(content).toContain('模板生成'); // LLM 调用失败 → fallback 模板
  });

  it('不足 4 条新消息 → skipped: too-few-messages', async () => {
    await writeSessionMessages([
      { type: 'user', content: 'a' },
      { type: 'ai', content: 'b' },
    ]);
    const r = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r.skipped).toBe('too-few-messages');
    expect(r.messagesCount).toBe(2);
  });

  it('二次压缩 → cursor 推进, 只压新增', async () => {
    await writeSessionMessages(Array.from({ length: 6 }, (_, i) => ({ type: i % 2 === 0 ? 'user' : 'ai', content: `msg${i}` })));
    const r1 = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r1.messagesCount).toBe(6);

    // 加 3 条新 messages (总数 9, cursor=6, 新增 3 < 4, 应 skipped)
    await writeSessionMessages([
      ...Array.from({ length: 6 }, (_, i) => ({ type: i % 2 === 0 ? 'user' : 'ai', content: `msg${i}` })),
      { type: 'user', content: 'q1' },
      { type: 'ai', content: 'a1' },
      { type: 'user', content: 'q2' },
    ]);
    const r2 = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r2.skipped).toBe('too-few-messages'); // 3 < 4

    // 再加 2 条 (总数 11, cursor=6, 新增 5 ≥ 4)
    await writeSessionMessages([
      ...Array.from({ length: 6 }, (_, i) => ({ type: i % 2 === 0 ? 'user' : 'ai', content: `msg${i}` })),
      { type: 'user', content: 'q1' },
      { type: 'ai', content: 'a1' },
      { type: 'user', content: 'q2' },
      { type: 'ai', content: 'a2' },
      { type: 'user', content: 'q3' },
    ]);
    const r3 = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r3.skipped).toBeUndefined();
    expect(r3.messagesCount).toBe(5);
  });

  it('agentId 含 / → 安全处理 (写到 sanitize 后的目录)', async () => {
    await writeSessionMessages(Array.from({ length: 5 }, (_, i) => ({ type: i % 2 === 0 ? 'user' : 'ai', content: `m${i}` })));
    const r = await compressSessionToMemory({
      agentId: 'unsafe/agent',
      channelId: TEST_CHANNEL,
      sessionId: TEST_SESSION,
      home: TEST_HOME,
    });
    expect(r.summaryPath).not.toContain('unsafe/agent');
    expect(r.summaryPath).toContain('unsafe_agent');
    const exists = await fs.stat(r.summaryPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('写入时自动 mkdir recursive', async () => {
    // 写入前 memory dir 不存在
    await fs.rm(path.join(TEST_HOME, '.bolloon', 'memory'), { recursive: true, force: true });
    await writeSessionMessages(Array.from({ length: 5 }, (_, i) => ({ type: i % 2 === 0 ? 'user' : 'ai', content: `m${i}` })));
    const r = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME,
    });
    expect(r.skipped).toBeUndefined();
    const exists = await fs.stat(r.summaryPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('minNewMessages 可配置', async () => {
    await writeSessionMessages(Array.from({ length: 2 }, (_, i) => ({ type: i % 2 === 0 ? 'user' : 'ai', content: `m${i}` })));
    // minNewMessages=1 → 2 条 ≥ 1, 应压缩
    const r = await compressSessionToMemory({
      agentId: TEST_AGENT, channelId: TEST_CHANNEL, sessionId: TEST_SESSION, home: TEST_HOME, minNewMessages: 1,
    });
    expect(r.skipped).toBeUndefined();
    expect(r.messagesCount).toBe(2);
  });
});