/**
 * trace 执行描述 (2026-10-01, 用户: 「这里的思考能不能变成 trace 的执行描述」+「这些 trace 是模型回复的最好」)。
 * 门锁的性质: ① 常见工具都有中文动作短语(人一眼看懂这一步干嘛) ② 认不出的工具**绝不返回空**(退回工具名, 不显示空白)
 *   ③ trace 模式下思维流**不显示**(这才是"换成 trace 描述"的关键) ④ 默认就是 trace(用户要的形态)。
 */
import { describe, it, expect } from 'vitest';
import { describeToolCall, traceLabel } from '../cli/trace-line.js';
import { renderReasoning, reasoningMode, isReasoningVisible } from '../cli/reasoning-view.js';

describe('trace 执行描述', () => {
  it('① 常见工具 => 人话(不是照搬工具名)', () => {
    expect(describeToolCall('git_status')).toBe('查看 git 状态');
    expect(describeToolCall('git_commit')).toBe('提交改动');
    expect(describeToolCall('terminal')).toBe('跑命令');
    expect(describeToolCall('write_file')).toBe('写文件');
    expect(describeToolCall('list_skills')).toBe('找技能');
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
