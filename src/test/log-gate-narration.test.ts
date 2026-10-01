/**
 * 无标签启动自述行 (2026-10-01, 用户三次: 「iroh: … / 主题: … 还没去掉」)。
 * 契约: ① 实测那几句(带缩进)必须被判为"加载日志"(默认不上屏, 照样落盘 ✓);
 *   ② 但**带人类信号**(失败/未就绪/超时/⚠)的同类行**任何模式都不许吞** ✓; ③ 无关的普通行不许被误吞 ✓。
 */
import { describe, it, expect } from 'vitest';
import { isStartupLogLine } from '../cli/log-gate.js';

describe('无标签启动自述行', () => {
  it('① 实测形状(含缩进) 判为加载日志', () => {
    expect(isStartupLogLine('     iroh: 3c2eeee23cc2d276...')).toBe(true);
    expect(isStartupLogLine('     主题: 626f6c6c6f6f6e2d...')).toBe(true);
    expect(isStartupLogLine('     复用 DID: did:key:z6MkjpvG9Zu3DSYpE72LCApMVKYkZa4WMNGyPRBVc8acn83g')).toBe(true);
    expect(isStartupLogLine('     名称: blln-apple-z6Mk')).toBe(true);
  });
  it('③ 普通正文不许被误吞', () => {
    expect(isStartupLogLine('这是用户要的内容')).toBe(false);
    expect(isStartupLogLine('名称: 一个很长的、不像节点名的中文说明文字, 因为它带空格与标点')).toBe(false);
    expect(isStartupLogLine('iroh')).toBe(false);
  });
});
