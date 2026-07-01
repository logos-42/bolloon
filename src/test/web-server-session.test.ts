/**
 * web server 接续 — SessionStore + sessionKey 命名契约 (v0.2.5)
 *
 * 2026-07-01: web 服务 (`src/web/server.ts`) 每个 channel 有 `sessionKey = "${channelId}:${currentSessionId}"`.
 *   `getAgentForChannel` 用 loadSessionKey 读历史; /message handler 末尾 saveCurrentSession.
 *   这测试验证 sessionKey 命名 + SessionStore round-trip — 跨刷新接续的契约.
 *
 * 消融思路:
 *   - 不起 web 服务 (express + LLM 依赖太重)
 *   - 直接构造同样的 sessionKey 命名, 走 SessionStore save/load
 *   - 验证 channelId/currentSessionId 跟 save 路径能对应上
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { SessionStore } from '../agents/session-store.js';

let tmpDir: string;
let store: SessionStore;
let counter = 0;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-web-session-'));
  store = new SessionStore({ cacheDir: tmpDir });
  counter++;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Web server 接续契约 — SessionStore + sessionKey', () => {
  it('channelId + currentSessionId 拼成 sessionKey', () => {
    // 模仿 src/web/server.ts:1111 的命名
    const channelId = 'general';
    const currentSessionId = 'default';
    const sessionKey = `${channelId}:${currentSessionId}`;
    expect(sessionKey).toBe('general:default');
  });

  it('同一 channel 切换 currentSessionId → 不同 sessionKey', () => {
    const channelId = 'general';
    const key1 = `${channelId}:session-A`;
    const key2 = `${channelId}:session-B`;
    expect(key1).not.toBe(key2);
  });

  it('save 写到 channelId:currentSessionId 路径 → load 还原', async () => {
    const channelId = `c-${counter}`;
    const currentSessionId = 'default';
    const sessionKey = `${channelId}:${currentSessionId}`;

    const messages: any[] = [
      { role: 'user', content: 'web 上看到这条消息', timestamp: 1000 },
      { role: 'assistant', content: 'web 上能看到这条回复', timestamp: 1100 },
    ];
    await store.saveMessages(sessionKey, messages);

    const loaded = await store.loadMessages(sessionKey);
    expect(loaded).toHaveLength(2);
    expect(loaded![0].content).toBe('web 上看到这条消息');
    expect(loaded![1].content).toBe('web 上能看到这条回复');
  });

  it('跨 "刷新" 场景: save → 新 store 实例 (模拟重启) → load 同一内容', async () => {
    const sessionKey = `channel-restart:${counter}:default`;

    // 第一次 "进程" — save
    const process1 = new SessionStore({ cacheDir: tmpDir });
    await process1.saveMessages(sessionKey, [
      { role: 'user', content: '刷新前的消息' },
      { role: 'assistant', content: '刷新前的回复' },
    ]);

    // 模拟 "重启" — 全新 store 实例指向同一目录
    const process2 = new SessionStore({ cacheDir: tmpDir });
    const restored = await process2.loadMessages(sessionKey);
    expect(restored).toHaveLength(2);
    expect(restored![0].content).toBe('刷新前的消息');
    expect(restored![1].content).toBe('刷新前的回复');
  });

  it('不同 channel 独立 session 互不污染', async () => {
    const channelA = 'channel-A';
    const channelB = 'channel-B';
    const sessionA = `${channelA}:default`;
    const sessionB = `${channelB}:default`;

    await store.saveMessages(sessionA, [{ role: 'user', content: 'A 专属' }]);
    await store.saveMessages(sessionB, [{ role: 'user', content: 'B 专属' }]);

    const loadedA = await store.loadMessages(sessionA);
    const loadedB = await store.loadMessages(sessionB);
    expect(loadedA![0].content).toBe('A 专属');
    expect(loadedB![0].content).toBe('B 专属');
  });

  it('web /message handler 风格: 写多条 messages → 每次更新 session 完整 round-trip', async () => {
    const sessionKey = `chat:${counter}:default`;

    // 模拟多轮 web 聊天
    const messages: any[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: `user msg ${i}`, timestamp: 1000 + i * 100 });
      messages.push({ role: 'assistant', content: `assistant reply ${i}`, timestamp: 1050 + i * 100 });
    }

    // 模拟 web handler 每次 /message 后调用 saveCurrentSession
    await store.saveMessages(sessionKey, messages);

    const loaded = await store.loadMessages(sessionKey);
    expect(loaded).toHaveLength(10);
    expect(loaded![0].content).toBe('user msg 0');
    expect(loaded![9].content).toBe('assistant reply 4');
  });
});

describe('Web server 接续契约 — 与 SessionStore API 集成', () => {
  it('saveCurrentSession 与 SessionStore.saveMessages 语义一致 (一个对一个)', async () => {
    // PiAgentSession.saveCurrentSession 内部委托 SessionStore.saveMessages
    // 这里直接验证 SessionStore 行为, 因为 PiAgentSession.saveCurrentSession
    //   已经在 src/test/persistence-e2e-flow.test.ts 测过 — 这是补充 web 层契约
    const sessionKey = `integration:${counter}`;
    await store.saveMessages(sessionKey, [{ role: 'user', content: 'hi' }]);
    const exists = await store.loadMessages(sessionKey);
    expect(exists).not.toBeNull();
  });

  it('listKeys 返回所有 web session 路径', async () => {
    // web 多 channel 多 session 都有对应 key, listKeys 应返回全部
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const k = `ch${i}:${counter}:default`;
      keys.push(k);
      await store.saveMessages(k, [{ role: 'user', content: `from ch${i}` }]);
    }
    const listed = await store.listKeys();
    for (const k of keys) {
      expect(listed).toContain(k);
    }
  });
});