/**
 * 2026-10-13 (leo: 「按一次 Ctrl+C 是中断当前对话; 按两次才是完整退出; 空闲时按一次就退出」):
 * Ctrl+C 两级语义的纯函数门测。决策是纯函数, 不依赖真 pty (本机 pty 夹具成功率低, 见 bolloon-development skill)。
 * 注: 2026-10-13 用户明确「我不需要阶段标识, 我要的是技能加载」→ 里程碑部分已移除, 此处只测 Ctrl+C 语义。
 */
import { describe, it, expect } from 'vitest';
import { decideCtrlCAction } from '../index.js';

describe('decideCtrlCAction — Ctrl+C 两级语义 (2026-10-13)', () => {
  it('有回合在跑且未发过 abort → 第一次中断回合', () => {
    expect(decideCtrlCAction({ turnActive: true, abortArmed: false })).toBe('abort_turn');
  });
  it('有回合但已发过 abort (第二次) → 完整退出', () => {
    expect(decideCtrlCAction({ turnActive: true, abortArmed: true })).toBe('exit');
  });
  it('空闲 (无回合) 时一次 Ctrl+C 直接完整退出', () => {
    expect(decideCtrlCAction({ turnActive: false, abortArmed: false })).toBe('exit');
    expect(decideCtrlCAction({ turnActive: false, abortArmed: true })).toBe('exit');
  });
});