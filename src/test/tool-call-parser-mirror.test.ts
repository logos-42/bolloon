/**
 * tool-call-parser-mirror.test.ts — Kotlin ToolCallParser 复刻镜像测试 (2026-08-15)
 *
 * 背景: 手机端 AgentLoop.kt 复刻了桌面核心 harness 的决策解析能力.
 *   Kotlin ToolCallParser.kt = 桌面 parse-tool-call.ts 的 Kotlin 移植 (手机工具集).
 *   Kotlin 无法在本仓库直接跑 JVM 单测 (需 Android 工程), 所以这里用桌面
 *   parseToolCall 作为"参考实现", 验证"手机工具集下的解析边界"在 JS 侧语义一致,
 *   作为 Kotlin 复刻的对齐锚点.
 *
 * 验证维度 (与 Kotlin ToolCallParser 逐条对应):
 *   1. JSON 工具调用 (name+arguments / tool+args)
 *   2. <invoke name="X"><parameter name="Y">v</parameter></invoke> XML
 *   3. 别名解析 (bash→shell, click→tap 等手机别名)
 *   4. 未知工具 → null (continue)
 *   5. <final gen> + 工具混合 → 工具优先
 *   6. 纯 <final gen> → final (无工具)
 *   7. 失败哨兵识别
 *   8. 对象字面量 / 中文调用格式
 */
import { describe, it, expect } from 'vitest';
import { parseToolCall, isFinalResponse } from '../agents/parse-tool-call.js';

// 手机端工具集 (对应 Kotlin ToolCallParser.TOOL_NAMES)
const PHONE_TOOLS = new Set([
  'build_llm_context', 'get_interactive_elements', 'get_screen_tree', 'classify_screen',
  'tap', 'swipe', 'type', 'back', 'home', 'launch_app',
  'shell', 'get_device_info', 'list_packages', 'done',
  'observe_screen', 'get_ui_tree',
]);

// 手机端别名表 (对应 Kotlin ToolCallParser.ALIASES, 在 resolveAlias 里模拟)
const PHONE_ALIASES: Record<string, string> = {
  bash: 'shell', shell_exec: 'shell', sh: 'shell', run_shell: 'shell', execute: 'shell',
  click: 'tap', press: 'tap', tap_at: 'tap',
  input: 'type', set_text: 'type', text: 'type', type_text: 'type',
  open_app: 'launch_app', open: 'launch_app', start_app: 'launch_app', launch: 'launch_app',
  observe: 'build_llm_context', screenshot: 'observe_screen', look: 'build_llm_context',
  ui_tree: 'get_ui_tree', tree: 'get_screen_tree', screen_tree: 'get_screen_tree',
  elements: 'get_interactive_elements', interactive_elements: 'get_interactive_elements',
  classify: 'classify_screen', classify_screen_type: 'classify_screen',
  go_back: 'back', press_back: 'back', back_button: 'back',
  go_home: 'home', press_home: 'home', home_button: 'home',
  device: 'get_device_info', device_info: 'get_device_info', get_device: 'get_device_info',
  packages: 'list_packages', list_pkg: 'list_packages', list_packages_filter: 'list_packages',
  finish: 'done', complete: 'done', end: 'done', agent_done: 'done', final: 'done',
};

function resolvePhoneAlias(name: string): string | null {
  if (PHONE_TOOLS.has(name)) return name;
  const lower = name.toLowerCase();
  return PHONE_ALIASES[lower] ?? null;
}

const CTX = { tools: PHONE_TOOLS, resolveAlias: resolvePhoneAlias };

describe('手机工具集解析 (对齐 Kotlin ToolCallParser)', () => {
  it('JSON name+arguments → tap 工具', () => {
    const r = parseToolCall('{"name": "tap", "arguments": {"x": 530, "y": 1140}}', CTX);
    expect(r).toEqual({ name: 'tap', args: { x: '530', y: '1140' } });
  });

  it('JSON tool+args (手机旧格式) → tap 工具 (Kotlin 兼容, 桌面不识别 tool 字段)', () => {
    // 桌面 parseToolCall 只认 name 字段, 对 {"tool":..,"args":..} 返回 null.
    // Kotlin ToolCallParser.jsonCall 兼容 name|tool 两字段 (手机旧 AgentLoop 格式).
    const r = parseToolCall('{"tool": "tap", "args": {"x": 530, "y": 1140}}', CTX);
    // 桌面: tool 字段不识别 → null. 该场景由 Kotlin 兼容 (本测试标记差异).
    expect(r).toBeNull();
  });

  it('<invoke name="type"><parameter name="text">你好</parameter></invoke> → type 工具', () => {
    const r = parseToolCall('<invoke name="type"><parameter name="text">你好</parameter></invoke>', CTX);
    expect(r?.name).toBe('type');
    expect(r?.args).toEqual({ text: '你好' });
  });

  it('别名 bash → shell + autoSplitCommand (command 拆成 command+args)', () => {
    const r = parseToolCall('{"name": "bash", "arguments": {"command": "pm list packages"}}', CTX);
    expect(r?.name).toBe('shell');
    // 桌面 autoSplitCommand: "pm list packages" → command=pm, args="list packages"
    expect(r?.args?.command).toBe('pm');
    expect(r?.args?.args).toBe('list packages');
  });

  it('别名 click → tap', () => {
    const r = parseToolCall('{"name": "click", "arguments": {"x": 1, "y": 2}}', CTX);
    expect(r?.name).toBe('tap');
  });

  it('未知工具 → null (continue)', () => {
    const r = parseToolCall('{"name": "completely-fake-tool", "arguments": {}}', CTX);
    expect(r).toBeNull();
  });

  it('<final gen> + 工具混合 → 工具优先 (execute-tool)', () => {
    const reply = '让我跑完给你 <final gen>\n<invoke name="shell"><parameter name="command">pm list packages</parameter></invoke>';
    expect(isFinalResponse(reply, CTX)).toBe(false);
    expect(parseToolCall(reply, CTX)?.name).toBe('shell');
  });

  it('纯 <final gen> 无工具 → final', () => {
    const reply = '任务完成 <final gen> 给你答案';
    expect(isFinalResponse(reply, CTX)).toBe(true);
  });

  it('思考块 + 工具 → 工具优先 (think 不阻断)', () => {
    const reply = '让我想想\n<invoke name="tap"><parameter name="x">10</parameter><parameter name="y">20</parameter></invoke>';
    expect(parseToolCall(reply, CTX)?.name).toBe('tap');
  });

  it('对象字面量 tool => "launch_app", args => {...}', () => {
    const r = parseToolCall('{tool => "launch_app", args => {"package": "com.tencent.mm"}}', CTX);
    expect(r?.name).toBe('launch_app');
    expect(r?.args?.package).toBe('com.tencent.mm');
  });

  it('中文 调用工具：tap(x=10, y=20)', () => {
    const r = parseToolCall('调用工具：tap(x=10, y=20)', CTX);
    // 桌面实现支持 x(...) 形式; 这里验证至少不崩且能解析
    expect(r).not.toBeNull();
  });

  it('失败哨兵 (手机 RemoteLlm 前缀)', () => {
    // 桌面 sentinel 前缀含 [AI 服务调用失败]/[AI 调用失败]/[错误:, 手机 RemoteLlm 返回 [LLM 调用失败]
    // 这里验证桌面 sentinel 语义, Kotlin isAiFailureSentinel 另含手机前缀
    expect(parseToolCall('[AI 服务调用失败] 网络超时', CTX)).toBeNull();
    expect(parseToolCall('[错误: api down]', CTX)).toBeNull();
  });
});