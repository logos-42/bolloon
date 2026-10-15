/**
 * trace 执行描述 (2026-10-01, 用户: 「这里的思考能不能变成 trace 的执行描述」+「这些 trace 是模型回复的最好」)。
 * 门锁的性质: ① 常见工具都有中文动作短语(人一眼看懂这一步干嘛) ② 认不出的工具**绝不返回空**(退回工具名, 不显示空白)
 *   ③ trace 模式下思维流**不显示**(这才是"换成 trace 描述"的关键) ④ 默认就是 trace(用户要的形态)。
 */
import { describe, it, expect } from 'vitest';
import { describeToolCall, traceLabel, toolArgsSummary } from '../cli/trace-line.js';
import { renderToolCallListItem } from '../cli/loading-tui.js';
import { renderReasoning, reasoningMode, isReasoningVisible } from '../cli/reasoning-view.js';

describe('trace 执行描述', () => {
  it('① 常见工具 => 人话(不是照搬工具名)', () => {
    expect(describeToolCall('git_status')).toBe('查看 git 状态');
    expect(describeToolCall('git_commit')).toBe('提交改动');
    expect(describeToolCall('terminal')).toBe('跑命令');
    expect(describeToolCall('write_file')).toBe('写文件');
    expect(describeToolCall('list_skills')).toBe('📚 找技能');
    expect(describeToolCall('read_skill')).toBe('📚 读技能');
    expect(describeToolCall('process')).toBe('管后台进程/服务');
  });
  it('② 认不出/空 => 退回工具名, 绝不空白', () => {
    expect(describeToolCall('some_new_tool_xyz')).toBe('');
    expect(traceLabel('some_new_tool_xyz')).toBe('some_new_tool_xyz');
    expect(traceLabel('')).toBe('');
  });
  it('③④ 默认 trace, 且 trace 模式**不显示思维流**', () => {
    expect(reasoningMode({} as any)).toBe('trace');
    expect(isReasoningVisible({} as any)).toBe(false);
    expect(renderReasoning('The user wants to push to GitHub.\nThe user wants to push.', { mode: 'trace' }).text).toBe('');
    // 老行为仍可按需打开
    expect(reasoningMode({ BOLLOON_SHOW_THINKING: 'short' } as any)).toBe('short');
    expect(reasoningMode({ BOLLOON_SHOW_THINKING: 'full' } as any)).toBe('full');
    expect(renderReasoning('x', { mode: 'short' }).text.length).toBeGreaterThan(0);
  });
});

describe('toolArgsSummary — 工具行命令缩写 (leo 2026-10-14: 「看不到过程 → 把执行的命令缩写带上」)', () => {
  it('terminal → 命令本身', () => {
    expect(toolArgsSummary('terminal', { command: 'npx vitest run src/test/x' })).toBe('npx vitest run src/test/x');
    expect(toolArgsSummary('terminal', { cmd: 'git status' })).toBe('git status');
  });
  it('read_file/write_file/list_files → 路径', () => {
    expect(toolArgsSummary('read_file', { path: 'src/index.ts' })).toBe('src/index.ts');
    expect(toolArgsSummary('write_file', { filePath: 'docs/x.md' })).toBe('docs/x.md');
    expect(toolArgsSummary('list_files', { dir: 'src' })).toBe('src');
  });
  it('grep_files → pattern · dir 拼接', () => {
    expect(toolArgsSummary('grep_files', { pattern: 'todo', path: 'src' })).toBe('todo · src');
    expect(toolArgsSummary('grep_files', { query: 'xxx' })).toBe('xxx');
  });
  it('无参数/不认识 → 空 (工具行保持现状, 不带摘要)', () => {
    expect(toolArgsSummary('read_file', {})).toBe('');
    expect(toolArgsSummary('some_tool', { a: 1 })).toBe('');
    expect(toolArgsSummary('', { a: 1 })).toBe('');
  });
  it('长命令截断 (保留头尾)', () => {
    const long = 'npm run build:main && npx vitest run src/test/workflow-pivot-loop.test.ts && echo done';
    const s = toolArgsSummary('terminal', { command: long });
    expect(s.length).toBeLessThan(long.length);
    expect(s.endsWith(long.slice(-6)));
  });
  it('string 形态 args → 空 (不解析 JSON 串)', () => {
    expect(toolArgsSummary('terminal', '{"command":"x"}')).toBe('');
  });
});

describe('renderToolCallListItem — 工具行带命令缩写渲染 (leo 2026-10-14)', () => {
  it('terminal + command → `🔧 terminal <command> <dur>ms` 形态', () => {
    const line = renderToolCallListItem(
      { tool: 'terminal', status: 'ok', args: { command: 'git status' }, durationMs: 42 },
      1, 3,
    );
    expect(line).toContain('🔧');
    expect(line).toContain('terminal');
    expect(line).toContain('git status');
    expect(line).toContain('42ms');
  });
});
