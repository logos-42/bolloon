import { describe, it, expect } from 'vitest';
// #4 流式渲染: 内联 Markdown 分词 → ANSI (纯函数单测)
import { mdInline } from '../cli/markdown.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('mdInline (内联 Markdown #4)', () => {
  it('backtick code → 高亮且无残留反引号', () => {
    const out = mdInline('run `npm i` now');
    expect(out).toContain('npm i');
    expect(out).not.toContain('`');
    expect(out).toMatch(/\x1b\[36m/);            // CYAN
    expect(strip(out)).toContain('run npm i now');
  });

  it('**bold** 加粗且无残留星号', () => {
    const out = mdInline('**very** important');
    expect(out).toMatch(/\x1b\[1m/);
    expect(strip(out)).toBe('very important'.replace('very', 'very') && 'very important');
    expect(strip(out)).not.toContain('**');
  });

  it('普通文本原样保留', () => {
    const plain = 'hello world';
    expect(strip(mdInline(plain))).toBe(plain);
    expect(mdInline(plain)).toContain(plain);
  });
});
