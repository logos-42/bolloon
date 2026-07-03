/**
 * Full Loop 端到端测试 — 验证 2026-07-01 (v0.2.7)
 *
 * 把 4 个抽取模块串起来跑全链路:
 *   parse-tool-call + chat-segmenter + input-validator + session-store
 *
 * 流程:
 *   1. 模拟 minimax LLM 输出 (含 think + tool_call + text + final gen)
 *   2. chat-segmenter 切 ChatSegment[] (结构化前后端分离)
 *   3. 对 tool_call segment 调 mock 工具 → 生成 tool result
 *   4. input-validator 验证 tool result 文本合规
 *   5. SessionStore.saveMessages 保存完整 history
 *   6. 跨 session resume → 验证 history 完整
 *   7. 再次 segmenter 切某条 history message → 仍干净
 *   8. 多轮循环: 模拟第 2 轮 LLM 输出含第 2 个 tool call → segmenter 仍正确切
 *
 * 消融思路:
 *   - 0 mock 真实模块: parseToolCall / segmentChatReply / validateMessageInput / SessionStore
 *     全部 import 真源
 *   - mock tool 是用户提供的 (放在 beforeEach), 模拟 shell_exec
 *   - 跨 process: 每次 createSession 都用新 peerId, 但共享 SessionStore (模拟重启)
 *   - 完全不依赖 LLM / P2P / network
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

import { createAgentSession } from '../agents/pi-sdk.js';
import { segmentChatReply, type ChatSegment } from '../agents/chat-segmenter.js';
import { parseToolCall } from '../agents/parse-tool-call.js';
import { validateMessageInput } from '../web/input-validator.js';
import { SessionStore, type PersistedMessage } from '../agents/session-store.js';
import { ToolRegistry } from '../agents/tool-registry.js';

let tmpDir: string;
let testStore: SessionStore;
let registry: ToolRegistry;
let peerIdCounter = 0;
let sessionKey: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-full-loop-'));
  testStore = new SessionStore({ cacheDir: tmpDir });
  registry = new ToolRegistry();
  // 注册 mock 工具: shell_exec / read_file / write_file
  registry.registerAll([
    {
      name: 'shell_exec',
      description: 'mock shell exec',
      parameters: { command: 'exec name', args: 'optional args' },
      execute: async (args) => ({
        success: true,
        output: `mock-shell: ${args.command} ${args.args ?? ''}`.trim(),
      }),
    },
    {
      name: 'read_file',
      description: 'mock read file',
      parameters: { path: 'path' },
      execute: async (args) => ({
        success: true,
        output: `mock-file-content(${args.path})`,
      }),
    },
  ]);
  peerIdCounter++;
  sessionKey = `full-loop:${Date.now()}-${peerIdCounter}`;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 模拟 LLM 一轮输出. 真实场景里这个字符串从 chat completion API 来. */
const MOCK_LLM_TURN_1 = `让我先看下 git status
<think>用户想知道当前分支状态, 我先跑 git status</think>
<invoke name="shell_exec">
<command>git status</command>
</invoke>
好, 在 master 分支.
现在读 README 确认项目:
<invoke name="read_file">
<parameter name="path">README.md</parameter>
</invoke>
任务完成 <final gen>
Bolloon 在 master 分支, README 描述是 P2P AI Agent`;

/** 第 2 轮: 含 tool_call 链式 + 多种 tool 格式 + final */
const MOCK_LLM_TURN_2 = `好的, 我再 git log 看看最近提交.
<invoke name="shell_exec">
<command>git log</command>
<args>--oneline -5</args>
</invoke>
<final gen>
完成, 你可以 git push 上去了`;

describe('Full Loop — LLM 输出 → segmenter → tool → store → resume', () => {
  it('phase 1+2: 切 minimax 输出为 ChatSegment[] (干净无残留)', () => {
    const segments = segmentChatReply(MOCK_LLM_TURN_1, { knownToolNames: registry });
    const types = segments.map(s => s.type);
    // 期望: think (1) + tool_call (2) + text (若干) + final (1) + text (1)
    expect(types).toContain('think');
    expect(types).toContain('tool_call');
    expect(types).toContain('final');

    // 终极不变量: text 段不含任何 tool_call 标记
    const allText = segments.filter(s => s.type === 'text' || s.type === 'final')
      .map(s => s.content || '').join('');
    expect(allText).not.toContain('<invoke');
    expect(allText).not.toContain('</invoke>');
    expect(allText).not.toContain('<think>');
    expect(allText).not.toContain('<function_calls>');
    expect(allText).not.toContain('<tool_call>');
    expect(allText).not.toContain('[TOOL_CALL]');
  });

  it('phase 3: tool_call segment 通过 ToolRegistry 调 mock 工具, 生成 tool result', async () => {
    const segments = segmentChatReply(MOCK_LLM_TURN_1, { knownToolNames: registry });
    const toolCalls = segments.filter(s => s.type === 'tool_call');
    expect(toolCalls.length).toBe(2);

    // 实际 dispatch
    const results: Array<{ tool: string; output: string }> = [];
    for (const seg of toolCalls) {
      if (!seg.tool) continue;
      const result = await registry.invoke(seg.tool.name, seg.tool.args);
      results.push({ tool: seg.tool.name, output: String(result.output ?? '') });
    }

    expect(results).toHaveLength(2);
    expect(results[0].tool).toBe('shell_exec');
    expect(results[0].output).toContain('mock-shell: git');
    expect(results[1].tool).toBe('read_file');
    expect(results[1].output).toBe('mock-file-content(README.md)');
  });

  it('phase 4: 模拟生成的 tool result 文本能通过 input-validator', () => {
    // 模拟 phase 3 工具输出
    const toolResultText = 'On branch master\nnothing to commit, working tree clean';
    const validation = validateMessageInput({
      text: toolResultText,
      channelId: 'test-channel',
    });
    expect(validation.ok).toBe(true);
    expect(validation.cleaned).toBe(toolResultText);
  });

  it('phase 5+6: 完整 messageHistory 持久化 + 跨 session resume', async () => {
    // 模拟完整一轮: user → think + tool_call + tool_result + final
    const userMsg: PersistedMessage = { role: 'user', content: '看下 git 状态', timestamp: 1000 };

    const segments = segmentChatReply(MOCK_LLM_TURN_1, { knownToolNames: registry });
    const toolCalls = segments.filter(s => s.type === 'tool_call');
    const thinkSeg = segments.find(s => s.type === 'think');
    const finalSeg = segments.find(s => s.type === 'final');
    const textSegs = segments.filter(s => s.type === 'text');

    // 构造 LLM 单次 message (assistant) 含 think + tool_call
    const llmMessage: PersistedMessage = {
      role: 'assistant',
      content: '', // 实际 LLM reply
      toolCall: toolCalls[0].tool
        ? { id: 't1', name: toolCalls[0].tool.name, args: toolCalls[0].tool.args }
        : undefined,
      timestamp: 1100,
    };

    // tool result
    const toolResult: PersistedMessage = {
      role: 'tool',
      content: '',
      toolCallId: 't1',
      toolResult: { success: true, output: 'On branch master' },
      timestamp: 1200,
    };

    // final answer
    const finalMessage: PersistedMessage = {
      role: 'assistant',
      content: finalSeg?.content ?? '',
      timestamp: 1300,
    };

    // 整段 history
    const history: PersistedMessage[] = [userMsg, llmMessage, toolResult, finalMessage];

    // 写
    const sessionA = await createAgentSession({
      cwd: process.cwd(),
      peerId: `tA-${Date.now()}:`,
      sessionStore: testStore,
    });
    (sessionA as any).messageHistory = history;
    await sessionA.saveCurrentSession(sessionKey);

    // 跨 session resume
    const sessionB = await createAgentSession({
      cwd: process.cwd(),
      peerId: `tB-${Date.now()}:`,
      sessionStore: testStore,
    });
    const resumed = await sessionB.resumeSession(sessionKey);
    expect(resumed).toBe(4);

    const restored = (sessionB as any).messageHistory as PersistedMessage[];
    expect(restored).toHaveLength(4);
    expect(restored[0].content).toBe('看下 git 状态');
    expect(restored[1].toolCall?.name).toBe('shell_exec');
    expect(restored[1].toolCall?.args).toEqual({ command: 'git', args: 'status' });
    expect(restored[2].toolResult?.output).toBe('On branch master');
    expect(restored[3].content).toContain('Bolloon');
  });

  it('phase 7: 重新切 resume 后的某条 message → 仍干净', async () => {
    // 写一个混合 (think + invoke + text) 到 store
    const sessionA = await createAgentSession({
      cwd: process.cwd(),
      peerId: `tA2-${Date.now()}:`,
      sessionStore: testStore,
    });
    (sessionA as any).messageHistory = [
      { role: 'user', content: '执行 ls' },
      {
        role: 'assistant',
        content: MOCK_LLM_TURN_1, // 这是 LLM 原始 content, 含 think/invoke
        timestamp: 1100,
      },
    ];
    await sessionA.saveCurrentSession('full-loop:resume-check');

    // resume
    const sessionB = await createAgentSession({
      cwd: process.cwd(),
      peerId: `tB2-${Date.now()}:`,
      sessionStore: testStore,
    });
    await sessionB.resumeSession('full-loop:resume-check');
    const restored = (sessionB as any).messageHistory as PersistedMessage[];

    // 重新切 resume 后的 assistant content
    const assistantContent = restored[1].content;
    const reSegments = segmentChatReply(assistantContent, { knownToolNames: registry });
    const text = reSegments.filter(s => s.type === 'text' || s.type === 'final')
      .map(s => s.content || '').join('');
    // 仍干净
    expect(text).not.toContain('<invoke');
    expect(text).not.toContain('<think>');
  });

  it('phase 8: 多轮循环 — 第 2 轮 LLM 输出含 final segment', () => {
    const seg2 = segmentChatReply(MOCK_LLM_TURN_2, { knownToolNames: registry });
    expect(seg2.filter(s => s.type === 'final')).toHaveLength(1);
    const finalContent = seg2.find(s => s.type === 'final')?.content;
    expect(finalContent).toContain('git push');

    // tool_call 是 shell_exec
    const tcs = seg2.filter(s => s.type === 'tool_call');
    expect(tcs).toHaveLength(1);
    expect(tcs[0].tool?.name).toBe('shell_exec');
  });
});

describe('Full Loop — 错误 / 边界', () => {
  it('LLM 输出含未知 tool name → segmenter 静默丢弃 (不显示给用户)', () => {
    const reply = '我调个不存在的\n<invoke name="unknown_tool"><command>foo</command></invoke>';
    const segs = segmentChatReply(reply, { knownToolNames: new Set(['shell_exec']) });
    // 不应有 tool_call segment (unknown 不进 known)
    expect(segs.filter(s => s.type === 'tool_call')).toHaveLength(0);
    // 但 text 段不应含 invoke 标记
    const text = segs.filter(s => s.type === 'text').map(s => s.content || '').join('');
    expect(text).not.toContain('unknown_tool');
    expect(text).not.toContain('<invoke');
  });

  it('tool result 文本含控制字符 → input-validator 拒收', () => {
    const validation = validateMessageInput({
      text: '正常文字 + 不可打印 \x01 控制',
      channelId: 'ch',
    });
    expect(validation.ok).toBe(false);
    expect(validation.reason).toMatch(/不可打印/);
  });

  it('完整链路: parseToolCall + segmentChatReply 一致性', () => {
    // parseToolCall 返 1 个 tool_call (第一个)
    // segmentChatReply 返 N 个 tool_call (全部)
    const reply = '看\n<invoke name="shell_exec"><command>a</command></invoke><invoke name="read_file"><parameter name="path">b</parameter></invoke>';
    const ptc = parseToolCall(reply, { tools: new Set(['shell_exec', 'read_file']) });
    const segs = segmentChatReply(reply, { knownToolNames: new Set(['shell_exec', 'read_file']) });

    expect(ptc?.name).toBe('shell_exec'); // 第一个
    const segsTcs = segs.filter(s => s.type === 'tool_call');
    expect(segsTcs).toHaveLength(2); // 全部
    expect(segsTcs[0].tool?.name).toBe('shell_exec');
    expect(segsTcs[1].tool?.name).toBe('read_file');
  });
});