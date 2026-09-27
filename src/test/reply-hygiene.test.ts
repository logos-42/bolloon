/**
 * reply-hygiene — 内部运行日志不进对话回复流 (2026-09-27)
 *
 * 这里只管**判据本身**和**发送点声明是否还在** (纯本地, 不需要 LLM, 秒级);
 * 端到端"真跑会话 → 回复流 0 命中 / 日志文件里还能查到"在
 * `scripts/verify-reply-hygiene.ts` (真 pty + 真 LLM) 里验, 两边缺一不可:
 * 这里防的是"改一个 emit 忘了声明", 那边防的是"整条链路真的把行搬走了"。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isInternalRunLog, internalRunLogLine, INTERNAL_RUN_LOG_PREFIX } from '../cli/reply-hygiene.js';

const PI_SDK = path.resolve(__dirname, '..', 'agents', 'pi-sdk.ts');

describe('isInternalRunLog — 只认发送点的显式声明', () => {
  it('status + internal: true 才算内部运行日志', () => {
    expect(isInternalRunLog({ type: 'status', internal: true })).toBe(true);
  });

  it('没声明的一律当用户可见 (缺省不改既有行为)', () => {
    expect(isInternalRunLog({ type: 'status' })).toBe(false);
    expect(isInternalRunLog({ type: 'status', internal: false })).toBe(false);
    expect(isInternalRunLog({ type: 'reply', internal: true })).toBe(false);
    expect(isInternalRunLog({ type: 'error', internal: true })).toBe(false);
    expect(isInternalRunLog(null)).toBe(false);
    expect(isInternalRunLog(undefined)).toBe(false);
  });
});

describe('internalRunLogLine — 落盘行: 原文一字不改, 只加可 grep 的前缀', () => {
  it('带前缀 + 来源工具', () => {
    expect(internalRunLogLine('🔄 开始 ReAct 循环...', 'system'))
      .toBe('[运行] system · 🔄 开始 ReAct 循环...');
  });

  it('没工具也要有前缀', () => {
    expect(internalRunLogLine('✅ 处理完成，共 3 次循环')).toBe('[运行] ✅ 处理完成，共 3 次循环');
    expect(INTERNAL_RUN_LOG_PREFIX).toBe('[运行] ');
  });
});

describe('发送点声明 (pi-sdk) — 这批行不许丢声明', () => {
  const src = fs.readFileSync(PI_SDK, 'utf8');
  const lines = src.split('\n');
  const INTERNAL_MARKERS = [
    '🔄 开始 ReAct 循环...',
    '🧷 运行已登记',
    '🔄 目标对齐 review',
    '✅ 处理完成，共 ${iteration - 1} 次循环',
    '🔄 工具结果汇报超限, 强制收尾',
    '✅ ${toolCall.name} 执行成功',
    '🎯 目标已达成',
  ];
  const USER_VISIBLE_MARKERS = [
    '⛔ loop 自动重试 ${MAX_LOOP_RETRIES} 次后仍失败',
    '⚠️ AI 调用失败 ${totalErrors}/${this.MAX_TOTAL_ERRORS}',
    '💡 Reflection:',
    '⚠️ 收尾被拒 (不当作收过)',
  ];

  /** 事件对象里 `type: 'status'` 那一行 (标记行上下 6 行内最近的); allowMany = 允许多个发送点 */
  function statusLineOf(marker: string, opts: { allowMany?: boolean } = {}): string[] {
    const idxs = lines.map((l, i) => (l.includes(marker) ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 0) return [];
    if (!opts.allowMany && idxs.length !== 1) return [];
    const out: string[] = [];
    for (const idx of idxs) {
      const cands: number[] = [];
      for (let i = Math.max(0, idx - 6); i <= Math.min(lines.length - 1, idx + 6); i++) {
        if (lines[i].includes("type: 'status'")) cands.push(i);
      }
      if (cands.length === 0) return [];
      const best = cands.sort((a, b) => Math.abs(a - idx) - Math.abs(b - idx))[0];
      out.push(lines[best]);
    }
    return out;
  }

  it.each(INTERNAL_MARKERS)('内部运行日志带 internal: true: %s', (marker) => {
    const l = statusLineOf(marker);
    expect(l.length, `pi-sdk 里找不到唯一发送点: ${marker}`).toBe(1);
    expect(l[0]).toContain('internal: true');
  });

  it.each(USER_VISIBLE_MARKERS)('用户可见状态不许被标成内部: %s', (marker) => {
    const l = statusLineOf(marker, { allowMany: true });
    expect(l.length, `pi-sdk 里找不到发送点: ${marker}`).toBeGreaterThan(0);
    for (const one of l) expect(one).not.toContain('internal: true');
  });
});
