/**
 * 重复工具调用的**硬收尾** (2026-10-01, 用户报「一个任务不应该花这么多工具调用」)。
 *
 * 实测症状: "你是谁" 这种简单任务, 同一个 get_identity 被连调 10 次 (7 次 + 夹个 terminal + 3 次)。
 * 根因: 防重护栏原先只**注入 hint**(软提示) 然后**重置计数** ⇒ 模型无视提示就没有任何刹车。
 * 修法: 触发条件收紧为「同工具**同参数**连续 3 次」(几乎永远无意义的行为), 动作改成
 *   走仓里现成的**强制收尾**路径 (汇总已成功的工具结果 + break), 不再指望模型自觉。
 * 同时把窗口键从"工具名"改成"工具名|参数指纹" ⇒ 同工具换参数的正常迭代 (逐文件读等) 不被误判。
 *
 * 本门钉三件: ① 参数指纹是稳定序 (键序无关), 否则"同参数"判定会漏;
 *            ② 源码里触发条件是同工具同参数×3 且**带 break** (拿掉 break 必红);
 *            ③ 窗口键确实用了指纹 (防退回"只看工具名"的误伤版)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { argsFingerprint } from '../agents/pi-sdk.js';

const src = () => fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');

describe('重复工具调用硬收尾', () => {
  it('① 参数指纹: 键序无关、值不同则不同、异常输入不抛', () => {
    expect(argsFingerprint({ a: 1, b: 'x' })).toBe(argsFingerprint({ b: 'x', a: 1 }));
    expect(argsFingerprint({ a: 1 })).not.toBe(argsFingerprint({ a: 2 }));
    expect(argsFingerprint({})).toBe('');
    expect(argsFingerprint(undefined)).toBe('');
    expect(argsFingerprint('not-an-object')).toBe('');
    // 同一参数重复调用 ⇒ 指纹必须相同 (否则永不触发硬收尾)
    expect(argsFingerprint({ path: '.bolloon/active-channel.json' }))
      .toBe(argsFingerprint({ path: '.bolloon/active-channel.json' }));
  });

  it('② 触发条件 = 同工具同参数 ×3, 且分支里必须 break (拿掉即红)', () => {
    const s = src();
    expect(s).toContain('const REPEAT_HARD_STOP_TIMES = 3;');
    const i = s.indexOf('REPEAT_HARD_STOP_TIMES && new Set(lastNTools).size === 1');
    expect(i, '没有同工具同参数的硬收尾判据').toBeGreaterThan(0);
    const branch = s.slice(i, i + 1800);
    expect(branch, '硬收尾分支必须 break (否则只是又一条提示)').toContain('break;');
    expect(branch).toContain('finalResponse ='); // 且必须给出汇总后的最终回答, 不许空手 break
  });

  it('③ 窗口键必须带参数指纹 (防退回只看工具名的误伤版)', () => {
    const s = src();
    expect(s).toContain('lastNTools.push(`${toolCall.name}|${argsFingerprint(toolCall.args)}`)');
  });
});
