import { describe, it, expect } from 'vitest';
// #7 输入层: keymap 纯函数单测 (键->意图 + 滚动平移)
import { resolveNormalKey, applyScroll } from '../cli/keymap.js';
import type { RawKey } from '../cli/keymap.js';

const ctx = { scrollable: true, input: '' };
const k = (o: RawKey, input = '') => resolveNormalKey(o, { scrollable: true, input });

describe('resolveNormalKey (#7)', () => {
  it('不可滚动时忽略滚动键', () => {
    expect(resolveNormalKey({ pageUp: true }, { scrollable: false, input: '' })).toBe('none');
  });
  it('Ctrl+U / PgUp / Alt+↑ → 上滚', () => {
    expect(k({ ctrl: true }, 'u')).toBe('scrollUp');
    expect(k({ pageUp: true })).toBe('scrollUp');
    expect(k({ meta: true, upArrow: true })).toBe('scrollUp');
  });
  it('Ctrl+D / PgDn / Alt+↓ → 下滚', () => {
    expect(k({ ctrl: true }, 'd')).toBe('scrollDown');
    expect(k({ pageDown: true })).toBe('scrollDown');
    expect(k({ meta: true, downArrow: true })).toBe('scrollDown');
  });
  it('Home/Ctrl+A → 顶部, End/Ctrl+E → 底部', () => {
    expect(k({ home: true })).toBe('scrollHome');
    expect(k({ ctrl: true }, 'a')).toBe('scrollHome');
    expect(k({ end: true })).toBe('scrollEnd');
    expect(k({ ctrl: true }, 'e')).toBe('scrollEnd');
  });
});

describe('applyScroll (#7)', () => {
  it('上滚离开底部, 不越界', () => {
    const r = applyScroll('scrollUp', 100, 40, 100);
    expect(r.next).toBe(60); expect(r.stick).toBe(false);
    expect(applyScroll('scrollUp', 10, 40, 100).next).toBe(0);
  });
  it('下滚到底部自动跟随', () => {
    const r = applyScroll('scrollDown', 60, 40, 100);
    expect(r.next).toBe(100); expect(r.stick).toBe(true);
  });
  it('Home=0, End=maxTop且跟随', () => {
    expect(applyScroll('scrollHome', 50, 40, 100).next).toBe(0);
    expect(applyScroll('scrollEnd', 0, 40, 100).stick).toBe(true);
  });
});
