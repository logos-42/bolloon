/**
 * parseToolCall → mockTools 端到端回路测试
 *
 * 2026-06-30: 消融测试 — 完全剥离 LLM 调用, React Harness, P2P, Iroh 等
 *   只保留核心链路: LLM 输出字符串 → parseToolCall → mockTool.execute() → 结果
 *   这是验证 bolloon 工具调用失败的"控制台" — 排除上游环境问题, 单测协议层
 */
import { describe, it, expect, vi } from 'vitest';
import { parseToolCall, type ParseContext } from '../agents/parse-tool-call.js';

interface MockTool {
  name: string;
  execute: (args: Record<string, string>) => Promise<{ success: boolean; output: string }>;
  callCount: number;
  lastArgs?: Record<string, string>;
}

// 模拟 PiAgentSession.tools 的一组 mock — 这是消融测试的核心
function createMockTools(names: string[]): Map<string, MockTool> {
  const tools = new Map<string, MockTool>();
  for (const name of names) {
    tools.set(name, {
      name,
      execute: vi.fn(async (args: Record<string, string>) => {
        return { success: true, output: `mock-${name}-executed: ${JSON.stringify(args)}` };
      }),
      callCount: 0,
    });
  }
  return tools;
}

// 模拟 PiAgentSession 内部循环的"核心反应": 拿 LLM 回复 → parse → execute → 收集结果
async function runOneReactiveStep(
  reply: string,
  tools: Map<string, MockTool>
): Promise<{ toolCallName: string | null; toolCallArgs: Record<string, string> | null; result: { success: boolean; output: string } | null }> {
  const ctx: ParseContext = {
    tools: new Set(tools.keys()),
    resolveAlias: (name: string) => {
      if (tools.has(name)) return name;
      return null; // mock 不做 alias, 让 fallback 路径真实参与
    },
  };
  const tc = parseToolCall(reply, ctx);
  if (!tc) return { toolCallName: null, toolCallArgs: null, result: null };

  const tool = tools.get(tc.name);
  if (!tool) return { toolCallName: tc.name, toolCallArgs: tc.args, result: null };

  tool.callCount++;
  tool.lastArgs = tc.args;
  const result = await tool.execute(tc.args);
  return { toolCallName: tc.name, toolCallArgs: tc.args, result };
}

const TOOL_NAMES = ['shell_exec', 'read_file', 'write_file', 'edit_file', 'git_log', 'git_commit', 'vitest_run'];

describe('parseToolCall + mockTools 端到端回路', () => {
  it('minimax Hermes 自闭合 XML: <invoke name="shell_exec"> 应触发 shell_exec.execute', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = `<invoke name="shell_exec">
<command>git status</command>
</invoke>`;
    const { toolCallName, toolCallArgs, result } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    // autoSplit: 'git status' → command='git' args='status'
    expect(toolCallArgs).toEqual({ command: 'git', args: 'status' });
    expect(result?.success).toBe(true);
    expect(result?.output).toContain('shell_exec');
    expect(tools.get('shell_exec')!.callCount).toBe(1);
  });

  it('JSON function-call (minimax 默认): arguments.command 自动 split', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = '{"name": "shell_exec", "arguments": {"command": "git status"}}';
    const { toolCallName, toolCallArgs, result } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    // autoSplit: 'git status' → command='git' args='status'
    expect(toolCallArgs).toEqual({ command: 'git', args: 'status' });
    expect(result?.success).toBe(true);
  });

  it('<function_calls> + <parameter name="X"> 子标签', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = `<function_calls>
<invoke name="shell_exec">
<parameter name="command">git</parameter>
<parameter name="args">status</parameter>
</invoke>
</function_calls>`;
    const { toolCallName, toolCallArgs } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    expect(toolCallArgs?.command).toBe('git');
    expect(toolCallArgs?.args).toBe('status');
  });

  it('思考块 + invoke 混合 (think 不应误杀)', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = `我先看一下当前状态
然后跑下 git status
<invoke name="shell_exec">
<command>git status</command>
</invoke>`;
    const { toolCallName, toolCallArgs } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    // autoSplit: 'git status' → command='git' args='status'
    expect(toolCallArgs?.command).toBe('git');
    expect(toolCallArgs?.args).toBe('status');
  });

  it('write_file 工具独立测试', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = '{"name": "write_file", "arguments": {"path": "/tmp/a.txt", "content": "hello world"}}';
    const { toolCallName, toolCallArgs, result } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('write_file');
    expect(toolCallArgs?.path).toBe('/tmp/a.txt');
    expect(toolCallArgs?.content).toBe('hello world');
    expect(tools.get('write_file')!.callCount).toBe(1);
    expect(result?.success).toBe(true);
  });

  it('未注册的工具名 + fallback shell_exec (推断)', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = `<RunShell>
<command>git status</command>
</RunShell>`;
    const { toolCallName, toolCallArgs } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    expect(toolCallArgs?.command).toBe('git');
    expect(toolCallArgs?.args).toBe('status');
  });

  it('LLM 最终回复无 tool call → 不触发任何工具', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = '我看了一下, 这里就是答案 <final gen> 不需要再做了';
    const { toolCallName, toolCallArgs, result } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBeNull();
    expect(toolCallArgs).toBeNull();
    expect(result).toBeNull();
    // 所有工具都没被调
    for (const t of tools.values()) {
      expect(t.callCount).toBe(0);
    }
  });

  it('markdown ```json 代码块包裹', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = '```json\n{"name": "shell_exec", "arguments": {"command": "ls -la"}}\n```';
    const { toolCallName, toolCallArgs } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    expect(toolCallArgs?.command).toBe('ls');
    expect(toolCallArgs?.args).toBe('-la');
  });

  it('Qwen/GLM <function_calls> + <tool> + <param> 短标签', async () => {
    const tools = createMockTools(TOOL_NAMES);
    const reply = `<function_calls>
<tool name="shell_exec">
<param name="command">npm install</param>
</tool>
</function_calls>`;
    const { toolCallName, toolCallArgs } = await runOneReactiveStep(reply, tools);
    expect(toolCallName).toBe('shell_exec');
    // autoSplit: 'npm install' → command='npm' args='install'
    expect(toolCallArgs?.command).toBe('npm');
    expect(toolCallArgs?.args).toBe('install');
  });

  it('断路验证: 嵌套调多个 tool 时每个都被独立调用', async () => {
    const tools = createMockTools(TOOL_NAMES);
    // 两个独立回复, 模拟 LLM 一轮里调多个工具 (但 parseToolCall 只返一个)
    const r1 = await runOneReactiveStep(
      '<invoke name="shell_exec"><command>pwd</command></invoke>',
      tools
    );
    const r2 = await runOneReactiveStep(
      '<invoke name="shell_exec"><command>ls</command></invoke>',
      tools
    );
    expect(r1.toolCallName).toBe('shell_exec');
    expect(r2.toolCallName).toBe('shell_exec');
    expect(tools.get('shell_exec')!.callCount).toBe(2);
    expect(tools.get('shell_exec')!.lastArgs).toEqual({ command: 'ls' });
  });
});

describe('parseToolCall 负面对照 (这些都应该不触发工具)', () => {
  const TOOLS_FOR_NEG = createMockTools(TOOL_NAMES);

  it('空字符串', async () => {
    const r = await runOneReactiveStep('', TOOLS_FOR_NEG);
    expect(r.toolCallName).toBeNull();
  });

  it('只有思考块', async () => {
    const r = await runOneReactiveStep('我在分析这个问题, 但是没有任何动作', TOOLS_FOR_NEG);
    expect(r.toolCallName).toBeNull();
  });

  it('半截 JSON 不闭合', async () => {
    const r = await runOneReactiveStep('{"name": "shell_exec", "argum', TOOLS_FOR_NEG);
    expect(r.toolCallName).toBeNull();
  });
});
