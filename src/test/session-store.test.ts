/**
 * SessionStore 单元测试 — 验证 2026-06-30 接口扩展
 *
 * 消融思路: 完全脱离 PiAgentSession / LLM / React Harness / P2P,
 *   直接测 SessionStore 的 4 个 IO 入口 + 边界.
 *
 * 用临时目录隔离, 跑完清掉 — 不污染 ~/.bolloon/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { SessionStore, type PersistedMessage } from '../agents/session-store.js';

let tmpDir: string;
let store: SessionStore;

beforeEach(async () => {
  // 用 OS temp dir 下唯一子目录 — vitest 并行 worker 不会冲突
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-session-test-'));
  store = new SessionStore({ cacheDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sampleMessages: PersistedMessage[] = [
  { role: 'user', content: '你好', timestamp: 1000, source: 'cli' },
  { role: 'assistant', content: '你好, 我能帮什么?', timestamp: 1100 },
  {
    role: 'assistant',
    content: '',
    toolCall: { id: 'call_1', name: 'shell_exec', args: { command: 'git', args: 'status' } },
    timestamp: 1200,
  },
  {
    role: 'tool',
    content: '',
    toolCallId: 'call_1',
    toolResult: { success: true, output: 'On branch master' },
    timestamp: 1300,
  },
  { role: 'assistant', content: '当前在 master 分支', timestamp: 1400 },
];

describe('SessionStore — save/load round-trip', () => {
  it('保存 + 读取完全往返', async () => {
    await store.saveMessages('cli:test-1', sampleMessages);
    const loaded = await store.loadMessages('cli:test-1');
    expect(loaded).not.toBeNull();
    expect(loaded!).toHaveLength(5);
    expect(loaded![0].role).toBe('user');
    expect(loaded![2].toolCall?.name).toBe('shell_exec');
    expect(loaded![3].toolResult?.success).toBe(true);
  });

  it('同步 saveMessagesSync 也能 save + load', () => {
    store.saveMessagesSync('cli:sync-1', sampleMessages);
    // 同步写完, 用异步 load 读
    return store.loadMessages('cli:sync-1').then((loaded) => {
      expect(loaded).toHaveLength(5);
    });
  });

  it('空 history 也能 save (边界)', async () => {
    await store.saveMessages('cli:empty', []);
    const loaded = await store.loadMessages('cli:empty');
    expect(loaded).toEqual([]);
  });

  it('不存在 key → 返回 null (不抛错)', async () => {
    const loaded = await store.loadMessages('cli:nonexistent');
    expect(loaded).toBeNull();
  });

  it('跨 save 完整覆盖 (非 append)', async () => {
    await store.saveMessages('cli:overwrite', sampleMessages);
    const shorter: PersistedMessage[] = [{ role: 'user', content: 'only this' }];
    await store.saveMessages('cli:overwrite', shorter);
    const loaded = await store.loadMessages('cli:overwrite');
    expect(loaded).toHaveLength(1);
    expect(loaded![0].content).toBe('only this');
  });

  it('原子写: 写完后读到完整文件, 不存在 .tmp 中间态', async () => {
    await store.saveMessages('cli:atomic', sampleMessages);
    const files = await fs.readdir(tmpDir);
    // 2026-07-04: Windows 兼容 — key 含 `:` 被 escape 成 `__` (SessionStore.filenameEscape)
    expect(files).toContain('cli__atomic.json');
    expect(files).not.toContain('cli__atomic.json.tmp');
  });
});

describe('SessionStore — schema 校验', () => {
  it('JSON 损坏 → 抛错', async () => {
    const file = store.pathFor('cli:corrupted');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(file, '{not valid json', 'utf-8');
    await expect(store.loadMessages('cli:corrupted')).rejects.toThrow();
  });

  it('schema 错误 (缺 messages 数组) → 抛错带 details', async () => {
    const file = store.pathFor('cli:wrong-schema');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ key: 'cli:wrong-schema', foo: 'bar' }), 'utf-8');
    await expect(store.loadMessages('cli:wrong-schema')).rejects.toThrow(/messages\[\]/);
  });

  it('非法 key (含 / ) → 抛错防路径注入', async () => {
    await expect(store.saveMessages('../../etc/passwd', [])).rejects.toThrow(/invalid key/);
    await expect(store.loadMessages('a/b')).rejects.toThrow(/invalid key/);
  });

  it('空 key → 抛错', async () => {
    await expect(store.saveMessages('', [])).rejects.toThrow(/invalid key/);
  });
});

describe('SessionStore — listKeys + deleteKey', () => {
  beforeEach(async () => {
    await store.saveMessages('cli:a', [sampleMessages[0]]);
    await store.saveMessages('cli:b', [sampleMessages[1]]);
    await store.saveMessages('web:c', [sampleMessages[2]]);
  });

  it('listKeys 列出所有 keys (按字母排序)', async () => {
    const keys = await store.listKeys();
    expect(keys).toEqual(['cli:a', 'cli:b', 'web:c']);
  });

  it('deleteKey 删除单条', async () => {
    await store.deleteKey('cli:a');
    const keys = await store.listKeys();
    expect(keys).toEqual(['cli:b', 'web:c']);
    expect(await store.loadMessages('cli:a')).toBeNull();
  });

  it('deleteKey 不存在的 key → 静默', async () => {
    await expect(store.deleteKey('cli:nonexistent')).resolves.not.toThrow();
  });

  it('空目录 listKeys → 空数组 (不抛错)', async () => {
    const emptyStore = new SessionStore({ cacheDir: path.join(tmpDir, 'never-created') });
    const keys = await emptyStore.listKeys();
    expect(keys).toEqual([]);
  });
});

describe('SessionStore — 续接场景 (claude code 验证效果)', () => {
  it('场景 1: 完整循环 — save → 新 store 实例 → load (跨进程)', async () => {
    // 模拟 claude code 完成一轮 prompt → saveMessages
    await store.saveMessages('cli:resume-1', sampleMessages);
    // 模拟服务重启 → 新 store 实例指向同一个目录 → load
    const newStore = new SessionStore({ cacheDir: tmpDir });
    const restored = await newStore.loadMessages('cli:resume-1');
    expect(restored).not.toBeNull();
    expect(restored).toHaveLength(5);
    // 验证 tool 链路完整 — claude code 接入时关心的核心
    expect(restored![2].toolCall?.args).toEqual({ command: 'git', args: 'status' });
    expect(restored![3].toolCallId).toBe('call_1');
  });

  it('场景 2: 接续 + 追加新消息 (增量保存)', async () => {
    await store.saveMessages('cli:resume-2', sampleMessages.slice(0, 2));
    const restored = await store.loadMessages('cli:resume-2');
    expect(restored).toHaveLength(2);
    // 模拟新 prompt 追加
    const extended = [
      ...(restored ?? []),
      { role: 'user' as const, content: '再跑 git log', timestamp: 2000 },
      { role: 'assistant' as const, content: 'git log 是...', timestamp: 2100 },
    ];
    await store.saveMessages('cli:resume-2', extended);
    const final = await store.loadMessages('cli:resume-2');
    expect(final).toHaveLength(4);
    expect(final![3].content).toBe('git log 是...');
  });

  it('场景 3: 多 channel 隔离 (cli vs web), 同 store 不同 key 不串', async () => {
    await store.saveMessages('cli:channel', [sampleMessages[0]]);
    await store.saveMessages('web:channel', [sampleMessages[1], sampleMessages[2]]);
    const a = await store.loadMessages('cli:channel');
    const b = await store.loadMessages('web:channel');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(a![0].content).toBe('你好');
    expect(b![0].content).toBe('你好, 我能帮什么?');
  });
});

describe('SessionStore — persistence durability', () => {
  it('持久化文件持久存在, 多次 load 一致', async () => {
    await store.saveMessages('cli:durability', sampleMessages);
    for (let i = 0; i < 5; i++) {
      const loaded = await store.loadMessages('cli:durability');
      expect(loaded).toHaveLength(5);
    }
  });

  it('大 history (100 条消息) save/load 完整', async () => {
    const big: PersistedMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i} content`,
      timestamp: 1000 + i * 10,
    }));
    await store.saveMessages('cli:big', big);
    const loaded = await store.loadMessages('cli:big');
    expect(loaded).toHaveLength(100);
    expect(loaded![50].content).toBe('msg 50 content');
  });
});
