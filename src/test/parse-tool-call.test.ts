/**
 * parseToolCall 单元测试 — 验证 2026-06-19/30 修复
 *
 * 测试 minimax/Hermes/Qwen/GLM/Anthropic LLM 实际产出的所有 tool_call 格式.
 *
 * 2026-06-30 改造: 不再复刻核心逻辑, 改为 import 真源 (`parse-tool-call.ts`).
 *   之前测试和源码是两份独立实现 — 测试通过 ≠ 实际工作 (parseToolCall 9 正则不匹配 minimax).
 */
import { describe, it, expect } from 'vitest';
import { parseToolCall, isFinalResponse, extractFinalAnswer } from '../agents/parse-tool-call.js';

// 默认工具集 — 模拟 PiAgentSession.tools 实际注册的子集
const DEFAULT_TOOLS = new Set([
  'shell_exec',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'git_log',
  'git_commit',
  'vitest_run',
  'tsc_check',
  'get_identity',
]);

describe('parseToolCall — minimax LLM output formats', () => {
  it('JSON function-call (minimax 默认)', () => {
    const r = parseToolCall('{"name": "shell_exec", "arguments": {"command": "git status"}}', { tools: DEFAULT_TOOLS });
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('JSON arguments field with already-split command', () => {
    const r = parseToolCall('{"name": "shell_exec", "arguments": {"command": "git", "args": "status"}}', { tools: DEFAULT_TOOLS });
    expect(r).toEqual({ name: 'shell_exec', args: { command: 'git', args: 'status' } });
  });

  it('Hermes 自闭合 XML <invoke name="X"><command>git status</command></invoke>', () => {
    const r = parseToolCall(
      `<invoke name="shell_exec">
<command>git status</command>
</invoke>`,
      { tools: DEFAULT_TOOLS }
    );
    expect(r?.name).toBe('shell_exec');
    // autoSplit: 'git status' → command='git' args='status' (shell_exec 期望拆分形式)
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('<function_calls> 包裹 + <parameter name="X"> 子标签', () => {
    const r = parseToolCall(
      `<function_calls>
<invoke name="shell_exec">
<parameter name="command">git</parameter>
<parameter name="args">status</parameter>
</invoke>
</function_calls>`,
      { tools: DEFAULT_TOOLS }
    );
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('<function_calls> + <tool> + <param> (Qwen/GLM 风格)', () => {
    const r = parseToolCall(
      `<function_calls>
<tool name="shell_exec">
<param name="command">git status</param>
</tool>
</function_calls>`,
      { tools: DEFAULT_TOOLS }
    );
    expect(r?.name).toBe('shell_exec');
    // autoSplit: 'git status' → command='git' args='status'
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('思考块 + invoke 混合 (think 不应误杀)', () => {
    const r = parseToolCall(
      `让我跑 git status
<invoke name="shell_exec">
<command>git status</command>
</invoke>`,
      { tools: DEFAULT_TOOLS }
    );
    expect(r?.name).toBe('shell_exec');
    // autoSplit: 'git status' → command='git' args='status'
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('write_file tool call', () => {
    const r = parseToolCall('{"name": "write_file", "arguments": {"path": "test.txt", "content": "hello"}}', { tools: DEFAULT_TOOLS });
    expect(r?.name).toBe('write_file');
    expect(r?.args.path).toBe('test.txt');
    expect(r?.args.content).toBe('hello');
  });

  it('返回 null: 没有 tool_call 格式', () => {
    expect(parseToolCall('普通文本, 没有 tool call', { tools: DEFAULT_TOOLS })).toBeNull();
  });

  it('返回 null: 只有 think 块没有 invoke', () => {
    expect(parseToolCall('我在思考', { tools: DEFAULT_TOOLS })).toBeNull();
  });

  it('markdown ```json 代码块包裹', () => {
    const r = parseToolCall('```json\n{"name": "shell_exec", "arguments": {"command": "ls -la"}}\n```', { tools: DEFAULT_TOOLS });
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('ls');
    expect(r?.args.args).toBe('-la');
  });

  it('alias resolve: bash → shell_exec', () => {
    const r = parseToolCall('{"name": "bash", "arguments": {"command": "pwd"}}', { tools: DEFAULT_TOOLS });
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('pwd');
  });

  it('未知 tool 名 + rawArgs 含 <command> → 推断 shell_exec (fallback)', () => {
    const r = parseToolCall(
      `<RunShell>
<command>git status</command>
</RunShell>`,
      { tools: DEFAULT_TOOLS }
    );
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('JSON arguments 有 args 数组形式 (string[] 转字符串)', () => {
    const r = parseToolCall(
      '{"name": "shell_exec", "input": {"command": "sed", "args": ["-n", "1060,1095p"]}}',
      { tools: DEFAULT_TOOLS }
    );
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('sed');
    expect(r?.args.args).toContain('-n');
  });
});

describe('isFinalResponse — final gen 终止判断', () => {
  it('普通思考块里说 final 不算终止', () => {
    // 旧 bug: 思考块里 "先看一下再 <final gen>" 直接 return true → 工具调用跳了
    const content = `让我想想...
先 <final gen> 是终止信号, 但其实只是举例
<invoke name="shell_exec">
<command>ls</command>
</invoke>`;
    expect(isFinalResponse(content, { tools: DEFAULT_TOOLS })).toBe(false);
  });

  it('含可解析 tool_call + <final gen> → 不算 final (优先执行工具)', () => {
    const content = `<final gen>
<invoke name="shell_exec">
<command>ls</command>
</invoke>`;
    expect(isFinalResponse(content, { tools: DEFAULT_TOOLS })).toBe(false);
  });

  it('纯 <final gen> 无 tool call → true', () => {
    expect(isFinalResponse('回答完成 <final gen>', { tools: DEFAULT_TOOLS })).toBe(true);
  });

  it('无 <final gen> → false', () => {
    expect(isFinalResponse('随便说点啥', { tools: DEFAULT_TOOLS })).toBe(false);
  });
});

describe('extractFinalAnswer — final gen 后内容提取', () => {
  it('提取 <final gen> 之后内容', () => {
    const ans = extractFinalAnswer('思考之后 <final gen>\n这是最终答案');
    expect(ans).toBe('这是最终答案');
  });

  it('<final gen> 在末尾空 → fallback 用之前内容', () => {
    const ans = extractFinalAnswer('思考过程 <final gen>');
    expect(ans).toBe('思考过程');
  });

  it('无 <final gen> → 整段清洗 tool call 噪声', () => {
    const ans = extractFinalAnswer('answer: 我直接说 不带 final marker');
    expect(ans).toBe('answer: 我直接说 不带 final marker');
  });

  it('移除调用工具: 等中文 tool call 噪声', () => {
    const ans = extractFinalAnswer('调用工具: shell_exec (ls) 完成, 我给你答案');
    expect(ans).not.toContain('调用工具');
    expect(ans).toContain('我给你答案');
  });
});
