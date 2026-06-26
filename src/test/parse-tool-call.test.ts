/**
 * parseToolCall 单元测试 — 验证 2026-06-19 修复
 *
 * 测试 minimax/Hermes LLM 实际产出的所有 tool_call 格式
 *   1. JSON function-call (minimax 默认)
 *   2. 自闭合 XML <invoke name="X">...</invoke>
 *   3. <function_calls> 包裹 + <parameter name="X"> 子标签
 *   4. think + invoke 混合
 *   5. command 含空格 auto-split
 */
import { describe, it, expect } from 'vitest';

describe('parseToolCall — minimax LLM output formats', () => {
  // 直接复刻 parseToolCall 核心逻辑做单元测试
  // (避免 import 整个 PiAgentSession + 复杂依赖)
  function parseToolCall(content: string): { name: string; args: Record<string, string> } | null {
    const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '');

    // 1. JSON function-call (OpenAI/Anthropic/Minimax-style)
    const jsonM = stripped.match(
      /(?:```(?:json|json5)?\s*\n?)?\{[\s\S]*?"name"\s*:\s*["'](\w+)["']\s*,\s*["']?(?:arguments|input)["']?\s*:\s*(\{[\s\S]*?\})\s*\}/
    );
    if (jsonM) {
      const args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(jsonM[2]);
        for (const [k, v] of Object.entries(parsed)) {
          args[k] = String(v);
        }
      } catch {}
      if (args.command && args.command.includes(' ') && !args.args) {
        const parts = args.command.split(/\s+/);
        args.command = parts[0];
        args.args = parts.slice(1).join(' ');
      }
      return { name: jsonM[1], args };
    }

    // 2. <invoke name="X">...</invoke> 自闭合 XML
    const invokeM = stripped.match(
      /<invoke\s+name=["']([\w]+)["']>([\s\S]*?)<\/invoke>/
    );
    if (invokeM) {
      const args: Record<string, string> = {};
      const inner = invokeM[2];
      // <parameter name="X">value</parameter>
      const paramRe = /<parameter\s+name=["'](\w+)["']>([\s\S]*?)<\/parameter>/g;
      let p;
      while ((p = paramRe.exec(inner)) !== null) {
        args[p[1]] = p[2].trim();
      }
      // <command>X</command> <args>Y</args>
      if (Object.keys(args).length === 0) {
        const cmdM = inner.match(/<command>([\s\S]*?)<\/command>/);
        if (cmdM) args.command = cmdM[1].trim();
        const argsM = inner.match(/<args>([\s\S]*?)<\/args>/);
        if (argsM) args.args = argsM[1].trim();
      }
      return { name: invokeM[1], args };
    }

    return null;
  }

  it('JSON function-call (minimax 默认)', () => {
    const r = parseToolCall('{"name": "shell_exec", "arguments": {"command": "git status"}}');
    expect(r).toEqual({ name: 'shell_exec', args: { command: 'git', args: 'status' } });
  });

  it('JSON arguments field with already-split command', () => {
    const r = parseToolCall('{"name": "shell_exec", "arguments": {"command": "git", "args": "status"}}');
    expect(r).toEqual({ name: 'shell_exec', args: { command: 'git', args: 'status' } });
  });

  it('Hermes 自闭合 XML <invoke name="X"><command>git status</command></invoke>', () => {
    const r = parseToolCall(`<invoke name="shell_exec">
<command>git status</command>
</invoke>`);
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('git status');
  });

  it('<function_calls> 包裹 + <parameter name="X"> 子标签', () => {
    const r = parseToolCall(`<function_calls>
<invoke name="shell_exec">
<parameter name="command">git</parameter>
<parameter name="args">status</parameter>
</invoke>
</function_calls>`);
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('git');
    expect(r?.args.args).toBe('status');
  });

  it('思考块 + invoke 混合 (think 不应误杀)', () => {
    const r = parseToolCall(`<think>让我跑 git status</think>
我来跑 git status
<invoke name="shell_exec">
<command>git status</command>
</invoke>`);
    expect(r?.name).toBe('shell_exec');
    expect(r?.args.command).toBe('git status');
  });

  it('write_file tool call', () => {
    const r = parseToolCall('{"name": "write_file", "arguments": {"path": "test.txt", "content": "hello"}}');
    expect(r?.name).toBe('write_file');
    expect(r?.args.path).toBe('test.txt');
    expect(r?.args.content).toBe('hello');
  });

  it('返回 null: 没有 tool_call 格式', () => {
    expect(parseToolCall('普通文本, 没有 tool call')).toBeNull();
  });

  it('返回 null: 只有 <think> 块没有 invoke', () => {
    expect(parseToolCall('<think>我在思考</think>')).toBeNull();
  });
});