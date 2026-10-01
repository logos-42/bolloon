/**
 * 工具停滞观测 (2026-10-01) —— 用户报「一个简单的任务居然花这么多次工具调用」。
 *
 * 口径 (与"硬停"相反): 分类先做, 判据看**签名**(工具名+参数规范 JSON 的哈希), 命中后
 * **不拒绝执行**, 只产出「引导文本 + 重复结果引用」; 轮询类工具豁免; 失败宽容类工具的失败不参与判定。
 */
import { describe, it, expect } from 'vitest';
import {
  LoopStallState, observeToolCall, canonicalToolArgs, toolCallSignature, detectCycle,
  IDENTICAL_CALL_THRESHOLD, STUB_MIN_CHARS, isRepeatableTool,
} from '../agents/tool-loop-guard.js';

const call = (st: LoopStallState, toolName: string, args: any, text: string, ok = true) =>
  observeToolCall(st, { toolName, args, resultText: text, ok, seenResultBefore: st.hasSeenResult(text) });

describe('参数规范与签名', () => {
  it('键序无关 ⇒ 同签名; 值不同 ⇒ 不同签名', () => {
    expect(canonicalToolArgs({ a: 1, b: 'x' })).toBe(canonicalToolArgs({ b: 'x', a: 1 }));
    expect(toolCallSignature('t', { a: 1, b: 2 })).toBe(toolCallSignature('t', { b: 2, a: 1 }));
    expect(toolCallSignature('t', { a: 1 })).not.toBe(toolCallSignature('t', { a: 2 }));
    expect(toolCallSignature('t', {})).not.toBe(''); // 无参数也要有稳定签名
  });
  it('非对象参数不抛, 且不造出假规范串', () => {
    expect(canonicalToolArgs('abc')).toBe('');
    expect(canonicalToolArgs(null)).toBe('');
    expect(canonicalToolArgs([1, 2])).toBe('');
  });
});

describe('连续相同调用', () => {
  it(`第 ${IDENTICAL_CALL_THRESHOLD} 次同参数同结果 ⇒ 出引导 (前两次不出声)`, () => {
    const st = new LoopStallState();
    const args = { x: 1 };
    expect(call(st, 'get_identity', args, 'DID: d\n名称: A').action).toBe('allow');
    expect(call(st, 'get_identity', args, 'DID: d\n名称: A').action).toBe('allow');
    const third = call(st, 'get_identity', args, 'DID: d\n名称: A');
    expect(third.action).toBe('warn');
    expect(third.code).toBe('identical_call_streak');
    expect(third.notice).toContain('不会得到新信息');
  });

  it('换参数 ⇒ 计数归零, 不误伤正常迭代 (逐文件读)', () => {
    const st = new LoopStallState();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'a.ts']) {
      const o = call(st, 'read_file', { path: f }, `内容 ${f}`);
      expect(o.action, `换参数不该被判重复: ${f}`).toBe('allow');
    }
  });

  it('结果变了 ⇒ 不算是"相同调用"', () => {
    const st = new LoopStallState();
    const args = { path: 'x' };
    expect(call(st, 'terminal', args, 'out-1').action).toBe('allow');
    expect(call(st, 'terminal', args, 'out-2').action).toBe('allow');
    expect(call(st, 'terminal', args, 'out-3').action).toBe('allow');
  });
});

describe('豁免与宽容', () => {
  it('轮询类工具 (含 _poll / _get_result 约定) 永不触发相同调用提示', () => {
    expect(isRepeatableTool('process_manage')).toBe(true);
    expect(isRepeatableTool('task_get_result')).toBe(true);
    const st = new LoopStallState();
    for (let i = 0; i < 5; i++) {
      expect(call(st, 'process_manage', { op: 'poll' }, 'still running').action).toBe('allow');
    }
  });

  it('失败宽容类工具的失败不参与停滞判定 (红测试/空 grep 是产出)', () => {
    const st = new LoopStallState();
    for (let i = 0; i < 5; i++) {
      expect(call(st, 'terminal', { cmd: 'npm test' }, 'FAIL x', false).action).toBe('allow');
    }
  });
});

describe('重复结果引用 (省上下文)', () => {
  it(`同结果第 2 次起 + 超过 ${STUB_MIN_CHARS} 字符 ⇒ 折叠成引用 stub`, () => {
    const st = new LoopStallState();
    const long = 'x'.repeat(STUB_MIN_CHARS + 10);
    const first = call(st, 'read_file', { path: 'big.ts' }, long);
    expect(first.stub, '第一次不该折叠').toBeUndefined();
    const second = call(st, 'read_file', { path: 'big.ts', _again: 1 }, long); // 换参数 ⇒ 走 stub 而非引导
    expect(second.stub).toBeDefined();
    expect(second.stub).toContain('逐字相同');
  });

  it('短结果不折叠; 失败永不折叠', () => {
    const st = new LoopStallState();
    expect(call(st, 'read_file', { p: 1 }, 'short').stub).toBeUndefined();
    const long = 'y'.repeat(STUB_MIN_CHARS + 1);
    call(st, 'terminal', { c: 1 }, long, false);
    const fail = call(st, 'terminal', { c: 2 }, long, false);
    expect(fail.stub, '失败结果不该被折叠').toBeUndefined();
  });
});

describe('循环检测 (A→B→A→B 的相邻计数会被清零, 只抓相邻必漏)', () => {
  it('两调用交替重复 3 圈 ⇒ 出 identical_cycle', () => {
    const st = new LoopStallState();
    let last = call(st, 'read_file', { p: 'a' }, 'A');
    for (let lap = 0; lap < 3; lap++) {
      call(st, 'search_files', { q: 'x' }, 'B');
      last = call(st, 'read_file', { p: 'a' }, 'A');
    }
    expect(last.action).toBe('warn');
    expect(['identical_call_streak', 'identical_cycle']).toContain(last.code);
    expect(last.notice).toBeTruthy();
  });

  it('detectCycle 直接判: 纯 2 周期串命中, 噪声串不命中', () => {
    const step = (s: string, f: string) => ({ sig: s, fp: f });
    expect(detectCycle([step('a', '1'), step('b', '2'), step('a', '1'), step('b', '2'), step('a', '1'), step('b', '2')]))
      .toEqual({ period: 2, laps: 3 });
    expect(detectCycle([step('a', '1'), step('b', '2'), step('c', '3'), step('a', '9')])).toBeNull();
  });
});

describe('状态复位', () => {
  it('reset 后重新开始计数', () => {
    const st = new LoopStallState();
    const args = { x: 1 };
    call(st, 'get_identity', args, 'same'); call(st, 'get_identity', args, 'same');
    st.reset();
    expect(call(st, 'get_identity', args, 'same').action).toBe('allow');
  });
});
