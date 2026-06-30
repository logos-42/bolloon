/**
 * PiAgentSession 持久化 / 续接 端到端测试
 *
 * 2026-06-30: 验证 saveCurrentSession + resumeSession + peekSessionHistory 接口工作.
 *
 * 消融思路: 不调用 prompt() (避免 LLM 依赖), 直接手填 messageHistory,
 *   然后用 save/peek/resume 验证 round-trip — claude code 接入场景就是这种用法.
 *
 * 用 peekSessionHistory 验证历史内容 (不动 messageHistory), 用 resumeSession
 * 验证真的会修改 messageHistory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { createAgentSession } from '../agents/pi-sdk.js';
import { SessionStore, type PersistedMessage } from '../agents/session-store.js';

let tmpDir: string;
let testStore: SessionStore;
let testPrefix: string;
let testCounter = 0;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-resume-test-'));
  testStore = new SessionStore({ cacheDir: tmpDir });
  // unique peerId 含 ':' 让 createAgentSession 走 independent session 路径 (避免 singleton)
  testCounter++;
  testPrefix = `t${Date.now()}-${testCounter}:`;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('PiAgentSession.saveCurrentSession', () => {
  it('把当前 messageHistory 写到注入的 SessionStore (不污染 ~/.bolloon)', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'A',
      sessionStore: testStore,
    });

    (session as any).messageHistory = [
      { role: 'user', content: '用户问题 1', timestamp: 1000 },
      { role: 'assistant', content: 'AI 回复 1', timestamp: 1100 },
      { role: 'user', content: '用户问题 2', timestamp: 1200 },
      { role: 'assistant', content: 'AI 回复 2', timestamp: 1300 },
    ];

    await session.saveCurrentSession('cli:e2e-1');

    const keys = await testStore.listKeys();
    expect(keys).toContain('cli:e2e-1');

    const restored = await testStore.loadMessages('cli:e2e-1');
    expect(restored).toHaveLength(4);
    expect(restored![0].role).toBe('user');
    expect(restored![3].content).toBe('AI 回复 2');
  });

  it('完整往返: 写 → 新 session 拉 → peekSessionHistory 看到一致内容', async () => {
    // Phase 1: 写
    const sessionA = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'B',
      sessionStore: testStore,
    });

    const messages = [
      { role: 'user', content: '我在跑什么测试?', timestamp: 1000 },
      { role: 'assistant', content: 'save/resume round-trip', timestamp: 1100 },
      {
        role: 'assistant',
        content: '',
        toolCall: { id: 'c_1', name: 'shell_exec', args: { command: 'echo', args: 'hi' } },
        timestamp: 1200,
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 'c_1',
        toolResult: { success: true, output: 'hi' },
        timestamp: 1300,
      },
      { role: 'assistant', content: '跑通了', timestamp: 1400 },
    ];
    (sessionA as any).messageHistory = messages;
    await sessionA.saveCurrentSession('cli:resume-e2e');

    // Phase 2: 新 session (用同一个 store = 同一目录)
    const sessionB = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'C',
      sessionStore: testStore,
      // 故意不传 loadSessionKey — 让初始 messageHistory 空
    });

    // 用 peek — 不动 messageHistory
    const peeked = await sessionB.peekSessionHistory('cli:resume-e2e');
    expect(peeked).toHaveLength(5);
    expect(peeked[0].content).toBe('我在跑什么测试?');
    expect(peeked[2].toolCall?.name).toBe('shell_exec');
    expect(peeked[3].toolResult?.success).toBe(true);

    // peek 不应改 messageHistory
    expect((sessionB as any).messageHistory.length).toBe(0);
  });

  it('resumeSession 把历史灌进 messageHistory', async () => {
    const sessionA = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'D',
      sessionStore: testStore,
    });
    (sessionA as any).messageHistory = [
      { role: 'user', content: 'first', timestamp: 1000 },
      { role: 'assistant', content: 'reply', timestamp: 1100 },
    ];
    await sessionA.saveCurrentSession('cli:resume-msg');

    const sessionB = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'E',
      sessionStore: testStore,
    });
    expect((sessionB as any).messageHistory.length).toBe(0);

    const n = await sessionB.resumeSession('cli:resume-msg');
    expect(n).toBe(2);
    const history = (sessionB as any).messageHistory;
    expect(history.length).toBe(2);
    expect(history[0].content).toBe('first');
    expect(history[1].content).toBe('reply');
  });

  it('resumeSession 不存在的 key → 返回 0, messageHistory 不变', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'F',
      sessionStore: testStore,
    });
    const n = await session.resumeSession('cli:never-existed');
    expect(n).toBe(0);
    // messageHistory 初始为空, resume 无 key 应该仍为空
    expect((session as any).messageHistory.length).toBe(0);
  });

  it('resumeSession 限制 maxMessages', async () => {
    const sessionA = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'G',
      sessionStore: testStore,
    });
    (sessionA as any).messageHistory = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `msg-${i}`,
    }));
    await sessionA.saveCurrentSession('cli:limit');

    const sessionB = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'H',
      sessionStore: testStore,
    });
    await sessionB.resumeSession('cli:limit', 10);
    const history = (sessionB as any).messageHistory;
    expect(history).toHaveLength(10);
    expect(history[0].content).toBe('msg-40');
    expect(history[9].content).toBe('msg-49');
  });

  it('多次 save 用同 key → 后写覆盖前写 (不是 append)', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'I',
      sessionStore: testStore,
    });
    (session as any).messageHistory = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
    ];
    await session.saveCurrentSession('cli:incremental');

    // 模拟新 prompt 进入 → messageHistory 包含旧 + 新
    (session as any).messageHistory = [
      ...(session as any).messageHistory,
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second reply' },
    ];
    await session.saveCurrentSession('cli:incremental');

    const restored = await testStore.loadMessages('cli:incremental');
    expect(restored).toHaveLength(4);
    expect(restored!.map(m => m.content)).toEqual([
      'first',
      'first reply',
      'second',
      'second reply',
    ]);
  });
});

describe('PiAgentSession — peekSessionHistory (不修改状态)', () => {
  it('peek vs resume: peek 不改 messageHistory, resume 会', async () => {
    const writer = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'J',
      sessionStore: testStore,
    });
    (writer as any).messageHistory = [
      { role: 'user', content: 'peek test', timestamp: 1 },
      { role: 'assistant', content: 'hi', timestamp: 2 },
    ];
    await writer.saveCurrentSession('cli:peek');

    const reader = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'K',
      sessionStore: testStore,
    });
    expect((reader as any).messageHistory.length).toBe(0);

    const peeked = await reader.peekSessionHistory('cli:peek');
    expect(peeked).toHaveLength(2);
    expect((reader as any).messageHistory.length).toBe(0); // peek 不改

    const resumed = await reader.resumeSession('cli:peek');
    expect(resumed).toBe(2);
    expect((reader as any).messageHistory.length).toBe(2); // resume 改
  });

  it('peek 不存在的 key → 返回空数组 (不抛错)', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'L',
      sessionStore: testStore,
    });
    const peeked = await session.peekSessionHistory('cli:never-existed');
    expect(peeked).toEqual([]);
  });

  it('peek 跳过污染消息 ([AI 服务调用失败] / [错误:...])', async () => {
    // 直接用 testStore 写一个含污染消息的文件
    const polluted: PersistedMessage[] = [
      { role: 'user', content: 'good msg 1' },
      { role: 'assistant', content: '[AI 服务调用失败] timeout' },
      { role: 'user', content: 'good msg 2' },
      { role: 'assistant', content: '[错误: api down]' },
      { role: 'assistant', content: 'good reply' },
    ];
    await testStore.saveMessages('cli:filtered', polluted);

    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'M',
      sessionStore: testStore,
    });
    const peeked = await session.peekSessionHistory('cli:filtered');
    // 3 条 good 留下, 2 条 polluted 跳过
    expect(peeked).toHaveLength(3);
    const contents = peeked.map(m => m.content);
    expect(contents).toContain('good msg 1');
    expect(contents).toContain('good msg 2');
    expect(contents).toContain('good reply');
    expect(contents.every(c => !c.startsWith('[AI'))).toBe(true);
    expect(contents.every(c => !c.startsWith('[错误'))).toBe(true);
  });
});

describe('PiAgentSession — integration with loadSessionKey (构造时读)', () => {
  it('loadSessionKey 加载 new schema 文件', async () => {
    // 先写一份 new schema 历史
    const sessionA = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'N',
      sessionStore: testStore,
    });
    (sessionA as any).messageHistory = [
      { role: 'user', content: 'recovery test', timestamp: 1000 },
      { role: 'assistant', content: 'recovered!', timestamp: 1100 },
    ];
    await sessionA.saveCurrentSession('cli:new-schema');

    // 新建 session B + 用构造参数 loadSessionKey
    const sessionB = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'O',
      sessionStore: testStore,
      loadSessionKey: 'cli:new-schema',
    });
    const history = (sessionB as any).messageHistory;
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('recovery test');
    expect(history[1].content).toBe('recovered!');
  });

  it('loadSessionKey 加载旧 schema 文件 (无 role 字段) → 全跳过', async () => {
    // 直接写旧 schema 文件 (没有 role 字段)
    const oldPath = path.join(tmpDir, 'cli:legacy.json');
    await fs.writeFile(oldPath, JSON.stringify({
      key: 'cli:legacy',
      messages: [
        { type: 'user', content: '旧 schema 消息' },
        { type: 'ai', content: '旧 AI 回复' },
      ],
      metadata: { savedAt: 1000 },
    }), 'utf-8');

    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: testPrefix + 'P',
      sessionStore: testStore,
      loadSessionKey: 'cli:legacy',
    });
    // 旧 schema 没有 role 字段, _filterToMessage 会跳过 (role !== user/assistant/tool/system)
    // 结果: messageHistory 保持初始 0 条
    expect((session as any).messageHistory).toHaveLength(0);
  });
});
