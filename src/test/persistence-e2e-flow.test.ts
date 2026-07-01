/**
 * Persistence E2E flow 测试 — v0.2.3 plan 优先级 1 端到端验证
 *
 * 2026-06-30 写:
 *   模拟完整 tool_call 生命周期 (LLM 决策 -> tool 执行 -> result 回填) 后,
 *   验证: save -> 跨 session resume -> peek 不污染 state -> 二次 save 增量 -> listKeys/deleteKey
 *
 * 消融思路:
 *   - 不依赖真实 LLM (不调 prompt()/promptStream())
 *   - 直接构造 messageHistory 代表跑完的工具调用对话 (这是真实数据格式)
 *   - 走真实 createAgentSession 工厂 (不是 mock, 不绕开真代码路径)
 *   - 用 saveCurrentSession / resumeSession / peekSessionHistory 公开接口
 *
 * 之前 v0.2.3 已有 session-resume-e2e.test.ts (11 case), 这个文件补充:
 *   - 完整 3-step tool call message 链 (user -> assistant+toolCall -> tool+toolResult x N -> final)
 *   - tool_call_id 链接完整性断言
 *   - 二次 save 增量验证
 *   - handleFallback 在已 resume 的 session 上能跑 (LLM-disabled 实际路径)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { createAgentSession } from '../agents/pi-sdk.js';
import { SessionStore, type PersistedMessage } from '../agents/session-store.js';

let tmpDir: string;
let testStore: SessionStore;
let testCounter = 0;
let prefix: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-persist-flow-'));
  testStore = new SessionStore({ cacheDir: tmpDir });
  testCounter++;
  prefix = `persistflow-${Date.now()}-${testCounter}:`;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Persistence E2E flow — 完整 tool call 链路 round-trip', () => {
  it('phase 1-2: 手工构造 3-step tool_call 链 → save → 文件落地', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'A',
      sessionStore: testStore,
    });

    // 模拟 3 步工具调用 + 最终回复 — 这是真实 messageHistory 数据格式
    const simulatedHistory: any[] = [
      { role: 'user', content: '帮我看下当前 git 状态', timestamp: 1000 },
      {
        role: 'assistant',
        content: '',
        toolCall: {
          id: 'call_git_status',
          name: 'shell_exec',
          args: { command: 'git', args: 'status' },
        },
        timestamp: 1100,
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 'call_git_status',
        toolResult: { success: true, output: 'On branch master\nnothing to commit' },
        timestamp: 1200,
      },
      {
        role: 'assistant',
        content: '',
        toolCall: {
          id: 'call_read_readme',
          name: 'read_file',
          args: { path: 'README.md' },
        },
        timestamp: 1300,
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 'call_read_readme',
        toolResult: { success: true, output: '# Bolloon\n\nP2P AI Agent...' },
        timestamp: 1400,
      },
      {
        role: 'assistant',
        content: '当前在 master 分支无修改, README 显示 Bolloon 是 P2P AI Agent',
        timestamp: 1500,
      },
    ];
    (session as any).messageHistory = simulatedHistory;

    await session.saveCurrentSession('e2e:tool-call-roundtrip');

    // 验证文件落地到 tmpDir (不污染 ~/.bolloon/)
    const dirListing = await fs.readdir(tmpDir);
    expect(dirListing).toContain('e2e:tool-call-roundtrip.json');

    // 验证持久化的数据完整
    const persisted = await testStore.loadMessages('e2e:tool-call-roundtrip');
    expect(persisted).not.toBeNull();
    expect(persisted).toHaveLength(6);
    expect(persisted![1].toolCall?.name).toBe('shell_exec');
    expect(persisted![2].toolCallId).toBe('call_git_status');
    expect(persisted![3].toolCall?.name).toBe('read_file');
    expect(persisted![4].toolCallId).toBe('call_read_readme');
    expect(persisted![5].role).toBe('assistant');
    expect(persisted![5].content).toContain('P2P AI Agent');
  });

  it('phase 3-5: 新 session resume 后 messageHistory 完整 + tool_call_id 链接 intact', async () => {
    // 写入
    const writer = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'writer',
      sessionStore: testStore,
    });
    (writer as any).messageHistory = [
      { role: 'user', content: 'step1' },
      {
        role: 'assistant',
        content: '',
        toolCall: { id: 'tc_A', name: 'shell_exec', args: { command: 'ls' } },
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 'tc_A',
        toolResult: { success: true, output: 'file1\nfile2' },
      },
      {
        role: 'assistant',
        content: '',
        toolCall: { id: 'tc_B', name: 'read_file', args: { path: 'file1' } },
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 'tc_B',
        toolResult: { success: true, output: 'content of file1' },
      },
      { role: 'assistant', content: '完成' },
    ];
    await writer.saveCurrentSession('e2e:link');

    // 跨 session resume
    const reader = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'reader',
      sessionStore: testStore,
      // 不传 loadSessionKey — 让初始 messageHistory 空
    });
    expect((reader as any).messageHistory.length).toBe(0);

    const resumedCount = await reader.resumeSession('e2e:link');
    expect(resumedCount).toBe(6);

    // 验证 history 完整恢复
    const history = (reader as any).messageHistory;
    expect(history).toHaveLength(6);
    expect(history[0].content).toBe('step1');
    expect(history[5].content).toBe('完成');

    // 验证 tool_call_id 链接 — 每个 assistant toolCall 都能找到对应 tool result
    const toolCallIds = history.filter((m: any) => m.toolCall?.id).map((m: any) => m.toolCall.id);
    const toolCallIdRefs = history.filter((m: any) => m.toolCallId).map((m: any) => m.toolCallId);
    expect(toolCallIds).toEqual(['tc_A', 'tc_B']);
    expect(toolCallIdRefs).toEqual(['tc_A', 'tc_B']);
    // 一一对应 (assistant toolCall.id ↔ tool.toolCallId)
    for (const id of toolCallIds) {
      expect(toolCallIdRefs).toContain(id);
    }
  });

  it('phase 4: peekSessionHistory 不污染 messageHistory 状态', async () => {
    const writer = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'peek-writer',
      sessionStore: testStore,
    });
    (writer as any).messageHistory = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'world' },
    ];
    await writer.saveCurrentSession('e2e:peek');

    const reader = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'peek-reader',
      sessionStore: testStore,
    });
    const beforeLen = (reader as any).messageHistory.length;
    expect(beforeLen).toBe(0);

    const peeked = await reader.peekSessionHistory('e2e:peek');
    expect(peeked).toHaveLength(2);

    const afterLen = (reader as any).messageHistory.length;
    expect(afterLen).toBe(0); // peek 不应改 messageHistory
  });

  it('phase 6: handleFallback 在已 resume 的 session 上能跑 (LLM-disabled 实际路径)', async () => {
    // 准备一个有 messageHistory 的 session
    const writer = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'fb-writer',
      sessionStore: testStore,
    });
    (writer as any).messageHistory = [
      { role: 'user', content: 'pre' },
      {
        role: 'assistant',
        content: '',
        toolCall: { id: 't1', name: 'shell_exec', args: { command: 'git', args: 'status' } },
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 't1',
        toolResult: { success: true, output: 'On branch master' },
      },
      { role: 'assistant', content: '在 master 分支' },
    ];
    await writer.saveCurrentSession('e2e:fallback');

    // 续接 + 验证 handleFallback 可调
    const reader = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'fb-reader',
      sessionStore: testStore,
    });
    await reader.resumeSession('e2e:fallback');
    expect((reader as any).messageHistory.length).toBe(4);

    // 直接调 handleFallback — 这是 LLM-disabled 时 prompt 走的实际路径
    const fallbackResult = await (reader as any).handleFallback('identity');
    expect(typeof fallbackResult).toBe('string');
    // identity 命令应返 JSON 形式身份
    expect(fallbackResult).toContain('did');
  });

  it('phase 7: 二次 save 增量保存 (history 在 session 上增长)', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'incr',
      sessionStore: testStore,
    });

    // 第一次: 3 条
    (session as any).messageHistory = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second' },
    ];
    await session.saveCurrentSession('e2e:incr');
    const after1 = await testStore.loadMessages('e2e:incr');
    expect(after1).toHaveLength(3);

    // 模拟新 prompt: 在已有 history 上追加
    (session as any).messageHistory = [
      ...(session as any).messageHistory,
      {
        role: 'assistant',
        content: '',
        toolCall: { id: 't_2', name: 'shell_exec', args: { command: 'ls' } },
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 't_2',
        toolResult: { success: true, output: 'a\nb\nc' },
      },
      { role: 'assistant', content: '列表完成' },
    ];
    await session.saveCurrentSession('e2e:incr');

    const after2 = await testStore.loadMessages('e2e:incr');
    expect(after2).toHaveLength(6); // 3 + 3 增量
    expect(after2![0].content).toBe('first');
    expect(after2![5].content).toBe('列表完成');
  });

  it('phase 8: listKeys / deleteKey / 不存在的 key 返回 null', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'list',
      sessionStore: testStore,
    });
    (session as any).messageHistory = [{ role: 'user', content: 'hi' }];
    await session.saveCurrentSession('e2e:listA');

    const another = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'list2',
      sessionStore: testStore,
    });
    (another as any).messageHistory = [{ role: 'user', content: 'hi2' }];
    await another.saveCurrentSession('e2e:listB');

    const keys = await testStore.listKeys();
    expect(keys).toContain('e2e:listA');
    expect(keys).toContain('e2e:listB');

    // 不存在的 key → loadMessages null
    expect(await testStore.loadMessages('e2e:nonexistent')).toBeNull();

    // deleteKey
    await testStore.deleteKey('e2e:listA');
    expect(await testStore.loadMessages('e2e:listA')).toBeNull();
    expect(await testStore.loadMessages('e2e:listB')).not.toBeNull();
  });

  it('持久化的工具调用参数 (含嵌套对象) 完整往返', async () => {
    // 模拟复杂 args: shell_exec 接受 command + args (逗号分隔) + timeoutMs
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'complex',
      sessionStore: testStore,
    });
    (session as any).messageHistory = [
      { role: 'user', content: 'run tests with timeout' },
      {
        role: 'assistant',
        content: '',
        toolCall: {
          id: 'call_vitest',
          name: 'shell_exec',
          args: {
            command: 'npx',
            args: 'vitest,run,--reporter=verbose',
            timeoutMs: '60000',
          },
        },
      },
      {
        role: 'tool',
        content: '',
        toolCallId: 'call_vitest',
        toolResult: { success: true, output: 'All tests passed (35)' },
      },
    ];
    await session.saveCurrentSession('e2e:complex');

    // 重新打开并 resume
    const reader = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'complex-r',
      sessionStore: testStore,
    });
    await reader.resumeSession('e2e:complex');
    const history = (reader as any).messageHistory;

    // 验证 toolCall.args 完整
    const tc = history[1].toolCall;
    expect(tc.name).toBe('shell_exec');
    expect(tc.args.command).toBe('npx');
    expect(tc.args.args).toBe('vitest,run,--reporter=verbose');
    expect(tc.args.timeoutMs).toBe('60000');
    // tool result 完整
    expect(history[2].toolResult.output).toBe('All tests passed (35)');
  });
});

describe('Persistence E2E flow — Schema 容错与错误处理', () => {
  it('save / load 100 条消息往返不丢', async () => {
    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'bulk',
      sessionStore: testStore,
    });
    const big = Array.from({ length: 100 }, (_, i) => ({
      role: i % 3 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message #${i} payload`,
      timestamp: 1000 + i * 10,
    }));
    (session as any).messageHistory = big;
    await session.saveCurrentSession('e2e:bulk');

    const reader = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'bulk-r',
      sessionStore: testStore,
    });
    await reader.resumeSession('e2e:bulk', 200); // 拉全部
    expect((reader as any).messageHistory).toHaveLength(100);
    expect((reader as any).messageHistory[99].content).toBe('message #99 payload');
  });

  it('save 路径不污染 ~/.bolloon/ (使用注入 tmpDir)', async () => {
    // 跑前验证 ~/.bolloon/sessions/cache/ 不会有 e2e:* 文件
    const homeCache = path.join(os.homedir(), '.bolloon', 'sessions', 'cache');
    let beforeFiles: string[] = [];
    try {
      beforeFiles = await fs.readdir(homeCache);
    } catch {
      // 目录不存在 — OK
    }
    const e2eBefore = beforeFiles.filter(f => f.startsWith('e2e:'));

    const session = await createAgentSession({
      cwd: process.cwd(),
      peerId: prefix + 'iso',
      sessionStore: testStore,
    });
    (session as any).messageHistory = [{ role: 'user', content: 'iso test' }];
    await session.saveCurrentSession('e2e:isolated');

    let afterFiles: string[] = [];
    try {
      afterFiles = await fs.readdir(homeCache);
    } catch {
      // 目录不存在 — OK
    }
    const e2eAfter = afterFiles.filter(f => f.startsWith('e2e:'));

    // ~/.bolloon/sessions/cache/ 没有新增 e2e: 文件
    expect(e2eAfter.length).toBe(e2eBefore.length);
  });
});