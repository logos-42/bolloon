import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 vi.stubGlobal 强制覆盖 — 跟 step-timeline-error-display.test.ts 同样的 FakeElement pattern
class FakeClassList {
  private s = new Set<string>();
  add(c: string) { this.s.add(c); }
  remove(c: string) { this.s.delete(c); }
  contains(c: string) { return this.s.has(c); }
  toString() { return Array.from(this.s).join(' '); }
}

class FakeElement {
  tag: string;
  _className = '';
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  textContent = '';
  classList = new FakeClassList();
  scrollTop = 0;
  scrollHeight = 0;
  _onclick: ((e: any) => void) | null = null;
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  get className(): string { return this._className; }
  set className(v: string) {
    this._className = String(v);
    this.classList = new FakeClassList();
    for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c);
  }
  appendChild(c: FakeElement): FakeElement { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c: FakeElement): FakeElement {
    const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  insertBefore(c: FakeElement, ref: FakeElement | null): FakeElement {
    if (!ref) return this.appendChild(c);
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(c);
    c.parentNode = this;
    this.children.splice(i, 0, c);
    return c;
  }
  replaceChild(n: FakeElement, o: FakeElement): FakeElement {
    const i = this.children.indexOf(o); if (i >= 0) { o.parentNode = null; n.parentNode = this; this.children[i] = n; }
    return o;
  }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get lastChild(): FakeElement | null { return this.children[this.children.length - 1] ?? null; }
  set onclick(fn: ((e: any) => void) | null) { this._onclick = fn; }
  get onclick() { return this._onclick; }

  querySelector(selector: string): FakeElement | null {
    let found: FakeElement | null = null;
    const visit = (el: FakeElement): void => {
      if (found) return;
      if (el._className.split(/\s+/).includes(selector.slice(1)) && selector.startsWith('.')) found = el;
      for (const c of el.children) visit(c);
    };
    visit(this);
    return found;
  }
}

const fakeDoc = {
  createElement: (tag: string) => new FakeElement(tag),
  getElementById: (_id: string) => null,
};

vi.stubGlobal('document', fakeDoc);
// window.marked 在 buildBubble 里被引用 — stub 一个无 escape 的版本 (单元测试不需要 Markdown 解析)
vi.stubGlobal('window', { marked: { parse: (s: string) => s } });

// 必须在 import message-renderer 之前 stub
// @ts-ignore
const { addMessage } = await import('../web/ui/message-renderer.js');

describe('addMessage: 历史 timestamp 保留 (Bug 2 修复 2026-07-15)', () => {
  function makeCtx(): any {
    const container = new FakeElement('div');
    const containers = new Map<string, FakeElement>();
    containers.set('ch1', container);
    return { messagesEl: null, messagesContainers: containers, currentChannelId: 'ch1', _container: container };
  }

  it('传 timestamp=ISO string 时, .time 文案用历史时间 (不用"现在")', () => {
    // 2024-01-15 10:30 UTC (历史时刻)
    const historical = '2024-01-15T10:30:00.000Z';
    const ctx: any = makeCtx();
    addMessage('你好', 'user', false, ctx._container, [], ctx, historical);
    // 容器里应该有 1 条消息 div, .time 子元素
    const msgDiv = ctx._container.children[0];
    expect(msgDiv).toBeDefined();
    // 最后一棵子节点是 .time
    const timeEl = msgDiv.lastChild; // 注意 addMessage 把 time 放在最后
    expect(timeEl).toBeDefined();
    // zh-CN locale HH:mm — UTC 10:30 → 主机 TZ 偏移, 至少含 "10:30" (UTC 范围) 或 "18:30" (UTC+8)
    // 由于容器里 textContent 是 HH:mm, 我们只检查它长度是 5 (HH:MM)
    expect(timeEl.textContent).toMatch(/^\d{2}:\d{2}$/);
    // 关键不变量: 这个时间不是"测试运行时当前小时"
    // 直接构造一个时间 iso 测一下 → 转换前确认
    const d = new Date(historical);
    const expected = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    expect(timeEl.textContent).toBe(expected);
  });

  it('传 timestamp=Date 对象时, 接受 Date', () => {
    const d = new Date('2023-05-20T14:00:00.000Z');
    const ctx: any = makeCtx();
    addMessage('reply', 'ai', false, ctx._container, [], ctx, d);
    const timeEl = ctx._container.children[0].lastChild;
    expect(timeEl.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(timeEl.textContent).toBe(d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  });

  it('不传 timestamp 时, fallback 到"现在"', () => {
    const ctx: any = makeCtx();
    const before = new Date();
    addMessage('hello', 'user', false, ctx._container, [], ctx);
    const after = new Date();
    const timeEl: any = ctx._container.children[0].lastChild;
    // 当前 HH:MM 格式
    expect(timeEl.textContent).toMatch(/^\d{2}:\d{2}$/);
    // 这个时间应该落在 [before, after] 区间 — 但分钟粒度, 用小时一致就行
    // 直接对比 toLocaleTimeString(before) 与展示, 允许 1 分钟误差
    const beforeLabel = before.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const afterLabel = after.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    expect([beforeLabel, afterLabel]).toContain(timeEl.textContent);
  });

  it('传非法 timestamp 时, fallback 到"现在"而不是崩', () => {
    const ctx: any = makeCtx();
    addMessage('boom', 'user', false, ctx._container, [], ctx, 'not-a-date' as any);
    const timeEl: any = ctx._container.children[0].lastChild;
    expect(timeEl.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it('传 null timestamp 时, 也 fallback 到"现在"', () => {
    const ctx: any = makeCtx();
    addMessage('nope', 'user', false, ctx._container, [], ctx, null as any);
    const timeEl: any = ctx._container.children[0].lastChild;
    expect(timeEl.textContent).toMatch(/^\d{2}:\d{2}$/);
  });
});
