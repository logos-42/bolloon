/**
 * 压缩前后"保目标" (2026-10-01, 用户: 「压缩前后保目标」)。
 * 契约: ① 折叠后历史里必须**紧跟摘要**有一条锚点 ✓; ② 锚点里必须有"用户当前要的"+"下一步" ✓;
 *   ③ 锚点是**确定性**抽取(不调模型 ✓); ④ 历史太短/空 ⇒ 不硬造锚点(返回 null ✓)。
 */
import { describe, it, expect } from 'vitest';
import { autoCompact, buildGoalAnchor } from '../context-compaction/auto-compact.js';

const msg = (role: string, content: string, extra: any = {}) => ({ role, content, ...extra } as any);

describe('压缩保目标锚点', () => {
  it('④ 空历史 ⇒ 不造锚点', () => {
    expect(buildGoalAnchor([], [])).toBeNull();
  });
  it('② 锚点含"用户要什么"与"下一步", 且有工具踪迹', () => {
    const h = [
      msg('user', '帮我核查 src/network 的测试覆盖'),
      msg('tool', 'ok', { tool: 'glob_files', toolResult: { success: true, output: '找到 3 个测试文件' } }),
      msg('assistant', 'Let me scope strictly to the main source tree'),
    ];
    const a = buildGoalAnchor(h, []);
    expect(a).toBeTruthy();
    expect(String((a as any).content)).toContain('帮我核查 src/network 的测试覆盖');
    expect(String((a as any).content)).toContain('下一步');
    expect(String((a as any).content)).toContain('glob_files');
  });
  it('① 真跑一次折叠: 摘要后面必须紧跟锚点', async () => {
    const history: any[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(msg('user', `第 ${i} 轮: 继续做这件事`));
      history.push(msg('assistant', `收到, 第 ${i} 轮`));
    }
    history.push(msg('user', '★★ 当前目标: 把 www 页面写出来'));
    const r = await autoCompact(history as any, { llmChat: async () => '前 12 轮的摘要' } as any);
    expect(r.applied).toBe(true);
    expect(String((r.history[0] as any).content)).toContain('Auto-Compact Summary');
    expect(String((r.history[1] as any).content)).toContain('压缩前的现场');
    expect(String((r.history[1] as any).content)).toContain('★★ 当前目标');
  });
});
