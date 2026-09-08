import { describe, it, expect, beforeEach } from 'vitest';
// #8 占用槽: widget host 4 触点 (register/unregister/refresh/list) 纯逻辑单测
import {
  registerWidget, unregisterWidget, refreshWidgets, listWidgets, getWidgets, resetWidgetsForTest,
} from '../cli/widget-host.js';

describe('widget-host (#8)', () => {
  beforeEach(() => resetWidgetsForTest());

  it('registerWidget 渲染并可见 + list', () => {
    registerWidget('clock', () => '12:00');
    expect(getWidgets().clock).toBe('12:00');
    expect(listWidgets()).toContain('clock');
  });

  it('refreshWidgets 重跑 render (拿最新值)', () => {
    let t = 1;
    registerWidget('tick', () => `t${t}`);
    expect(getWidgets().tick).toBe('t1');
    t = 2; refreshWidgets();
    expect(getWidgets().tick).toBe('t2');
  });

  it('unregisterWidget 移除', () => {
    registerWidget('a', () => 'x');
    unregisterWidget('a');
    expect(getWidgets().a).toBeUndefined();
    expect(listWidgets()).not.toContain('a');
  });
});
