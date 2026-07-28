/**
 * 测试 parseAllToolCalls 是否能从真实 LLM 输出中解析出多工具调用
 * 运行: npx tsx src/test/test-multi-tool.ts
 */
import { parseAllToolCalls, parseToolCall } from '../agents/parse-tool-call.js';

const knownTools = new Set([
  'shell_exec', 'read_file', 'write_file', 'delete_file', 'move_file',
  'git_status', 'git_log', 'git_diff', 'git_commit', 'git_push',
  'vitest_run', 'tsc_check', 'web_fetch', 'web_search',
]);

function test(label: string, content: string, expected: number) {
  const result = parseAllToolCalls(content, { tools: knownTools });
  const single = parseToolCall(content, { tools: knownTools });
  const status = result.length === expected ? '✅' : '❌';
  console.log(`${status} ${label}: parseAll=${result.length} (期望=${expected}), parseTool=${single ? 1 : 0}`);
  if (result.length > 0) {
    result.forEach((tc, i) => console.log(`   [${i}] ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`));
  }
  if (result.length !== expected) {
    console.log(`   raw: ${content.slice(0, 200)}...`);
  }
}

console.log('=== parseAllToolCalls 多工具解析测试 ===\n');

// 1. 多行 JSON (deepseek/minimax 常见格式)
test('多行 JSON',
  '{\n  "name": "shell_exec",\n  "arguments": { "command": "ls" }\n}\n{\n  "name": "read_file",\n  "arguments": { "path": "package.json" }\n}', 2);

// 2. 多行 <invoke> XML
test('多行 XML invoke',
  '<invoke name="shell_exec"><command>git status</command></invoke>\n<invoke name="read_file"><path>README.md</path></invoke>', 2);

// 3. JSON 数组格式 (OpenAI parallel tool calls)
test('JSON 数组',
  '[{"name":"shell_exec","arguments":{"command":"pwd"}},{"name":"read_file","arguments":{"path":"index.html"}}]', 2);

// 4. <function_calls> 包裹多工具
test('function_calls 包裹',
  '<function_calls>\n<invoke name="shell_exec"><command>ls -la</command></invoke>\n<invoke name="read_file"><path>.gitignore</path></invoke>\n</function_calls>', 2);

// 5. 单工具 (基线)
test('单工具 JSON',
  '{"name": "shell_exec", "arguments": {"command": "ls"}}', 1);

// 6. 零工具 (纯文本)
test('零工具', '这个任务完成 <final gen>', 0);

// 7. 混合格式
test('混合格式',
  '我先看看目录\n<invoke name="shell_exec"><command>ls</command></invoke>\n再看看配置文件\n<invoke name="read_file"><path>package.json</path></invoke>', 2);

// 8. 思考块 + 多工具
test('think+多工具',
  '<think>我需要检查几个文件</think>\n<invoke name="read_file"><path>package.json</path></invoke>\n<invoke name="read_file"><path>tsconfig.json</path></invoke>', 2);

// 9. [TOOL_CALL] 标签
test('TOOL_CALL 多段',
  '[TOOL_CALL]{"name":"shell_exec","args":{"command":"ls"}}[/TOOL_CALL][TOOL_CALL]{"name":"read_file","args":{"path":"x"}}[/TOOL_CALL]', 2);

// 10. <tool_call> 标签
test('tool_call 多段',
  '<tool_call>{"name":"shell_exec","arguments":{"command":"pwd"}}</tool_call><tool_call>{"name":"read_file","arguments":{"path":"test.txt"}}</tool_call>', 2);

console.log('\n=== 测试完成 ===');
