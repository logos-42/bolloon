import { describe, it, expect } from 'vitest';
import { canonicalizeToolCallArguments } from '../agents/workflow-pivot-loop.js';

describe('canonicalizeToolCallArguments (Hermes 参数规范化模式)', () => {
  it('标准 JSON 直接通过', () => {
    expect(canonicalizeToolCallArguments('{"path": "/tmp/a.txt", "content": "hi"}'))
      .toEqual({ path: '/tmp/a.txt', content: 'hi' });
  });

  it('空/非字符串 → {}', () => {
    expect(canonicalizeToolCallArguments('')).toEqual({});
    expect(canonicalizeToolCallArguments('   ')).toEqual({});
    expect(canonicalizeToolCallArguments(undefined)).toEqual({});
    expect(canonicalizeToolCallArguments(null)).toEqual({});
    expect(canonicalizeToolCallArguments(42 as any)).toEqual({});
  });

  it('JSON 后尾随散文 → 截到最后一个 } 解析', () => {
    expect(canonicalizeToolCallArguments('{"path": "b"} 这里是我接下来的思路...'))
      .toEqual({ path: 'b' });
  });

  it('代码围栏包裹 → 去围栏解析', () => {
    expect(canonicalizeToolCallArguments('```json\n{"name": "x", "args": {}}\n```'))
      .toEqual({ name: 'x', args: {} });
  });

  it('数组/原始值不是工具参数形状 → {}', () => {
    expect(canonicalizeToolCallArguments('[1,2,3]')).toEqual({});
    expect(canonicalizeToolCallArguments('"just a string"')).toEqual({});
  });

  it('完全无法解析 → {} (不抛)', () => {
    expect(canonicalizeToolCallArguments('not json at all {{{')).toEqual({});
    expect(canonicalizeToolCallArguments('{\'single\': true}')).toEqual({});
  });

  it('多层嵌套对象保留', () => {
    const r = canonicalizeToolCallArguments('{"a": {"b": [1,2], "c": "x"}}');
    expect(r).toEqual({ a: { b: [1, 2], c: 'x' } });
  });
});
