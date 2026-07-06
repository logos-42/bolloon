/**
 * safe-name.test.ts — channel/peer/agent 名兜底单元测试
 *
 * 覆盖:
 *   - undefined / null / 空白 → fallback
 *   - 字面量 'undefined' / 'null' / 'NaN' → fallback
 *   - 正常字符串保留
 *   - 数字 0 / 负数 → 保留 (不当作 fallback)
 *   - 安全 fallback 默认值正确
 *   - 不可信数据安全 (不抛错)
 */
import { describe, it, expect } from 'vitest';
import { safeName, safeChannelName, safePeerName } from '../web/util/safe-name.js';

describe('safeChannelName', () => {
  it('undefined → (未命名)', () => {
    expect(safeChannelName(undefined)).toBe('(未命名)');
  });
  it('null → (未命名)', () => {
    expect(safeChannelName(null)).toBe('(未命名)');
  });
  it('空字符串 → (未命名)', () => {
    expect(safeChannelName('')).toBe('(未命名)');
  });
  it('全空白 → (未命名)', () => {
    expect(safeChannelName('   ')).toBe('(未命名)');
  });
  it("字面量 'undefined' → (未命名)", () => {
    expect(safeChannelName('undefined')).toBe('(未命名)');
  });
  it("字面量 'null' → (未命名)", () => {
    expect(safeChannelName('null')).toBe('(未命名)');
  });
  it("字面量 'NaN' → (未命名)", () => {
    expect(safeChannelName('NaN')).toBe('(未命名)');
  });
  it('正常字符串保留', () => {
    expect(safeChannelName('我的频道')).toBe('我的频道');
  });
  it('前后空白被 trim', () => {
    expect(safeChannelName('  hello  ')).toBe('hello');
  });
  it('自定义 fallback', () => {
    expect(safeChannelName(undefined, '加载中')).toBe('加载中');
  });
  it('数字 0 保留 (不当 fallback)', () => {
    expect(safeChannelName(0)).toBe('0');
  });
  it('负数保留', () => {
    expect(safeChannelName(-1)).toBe('-1');
  });
});

describe('safePeerName', () => {
  it('默认 fallback 是 "Unknown"', () => {
    expect(safePeerName(undefined)).toBe('Unknown');
    expect(safePeerName(null)).toBe('Unknown');
  });
  it('正常名字保留', () => {
    expect(safePeerName('Alice')).toBe('Alice');
  });
  it('字面量 "undefined" → "Unknown"', () => {
    expect(safePeerName('undefined')).toBe('Unknown');
  });
});

describe('safeName (通用)', () => {
  it('自定义 fallback + 自定义 invalidLiterals', () => {
    expect(safeName('Anonymous', 'Guest', ['Anonymous'])).toBe('Guest');
  });
  it('默认 invalidLiterals 覆盖 ["undefined","null","NaN"]', () => {
    expect(safeName('undefined', 'x')).toBe('x');
    expect(safeName('null', 'x')).toBe('x');
    expect(safeName('NaN', 'x')).toBe('x');
  });
  it('不抛错 (object / array)', () => {
    expect(() => safeName({ foo: 1 }, 'x')).not.toThrow();
    expect(() => safeName([1, 2], 'x')).not.toThrow();
    expect(safeName({ foo: 1 }, 'x')).toBe('[object Object]');
    expect(safeName([1, 2], 'x')).toBe('1,2');
  });
});