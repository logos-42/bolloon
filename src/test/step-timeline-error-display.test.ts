import { describe, it, expect, vi } from 'vitest';

// 用 vi.stubGlobal 强制覆盖
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
    return walk(this, selector) as FakeElement | null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    walk(this, selector, out as any);
    return out;
  }
}

function matches(el: FakeElement, sel: string): boolean {
  const dataMatch = sel.match(/^\[data-([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (dataMatch) {
    const k = `data-${dataMatch[1]}`;
    return dataMatch[2] ? el.attrs[k] === dataMatch[2] : el.attrs[k] !== undefined;
  }
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.attrs.id === sel.slice(1);
  return el.tag === sel;
}

function walk(root: FakeElement, sel: string, out?: FakeElement[]): FakeElement | null {
  let found: FakeElement | null = null;
  const visit = (el: FakeElement): void => {
    if (found && !out) return;
    if (matches(el, sel)) {
      if (out) out.push(el);
      else found = el;
    }
    for (const c of el.children) visit(c);
  };
  visit(root);
  return out ? null : found;
}

const fakeDoc = {
  createElement: (tag: string) => new FakeElement(tag)
};

// 必须在 import step-timeline 之前 stub
vi.stubGlobal('document', fakeDoc);
vi.stubGlobal('HTMLElement', FakeElement);
vi.stubGlobal('localStorage', {
  _d: new Map<string, string>(),
  getItem(k: string) { return this._d.get(k) ?? null; },
  setItem(k: string, v: string) { this._d.set(k, v); },
  removeItem(k: string) { this._d.delete(k); }
});

// @ts-ignore
const { pushStepToTimeline, createEmptyStepTimeline } = await import('../web/ui/step-timeline.js');

describe('step-timeline: 原始 error 暴露 (2026-07-12 修复)', () => {
  it('error 状态的 step 渲染时显示原始 error 文本', () => {
    const tl = createEmptyStepTimeline('ch-1');
    pushStepToTimeline(tl, 'step_start', { tool: 'read_document', args: {} });
    pushStepToTimeline(tl, 'step_done', { tool: 'read_document', success: false, error: 'path 必填' });
    const errWrap = tl.querySelector('.step-timeline-error-wrap');
    const errEl = tl.querySelector('.step-timeline-error');
    expect(errWrap, 'errWrap 应该存在').not.toBeNull();
    expect(errWrap!.style.display).toBe('');
    expect(errEl, 'errEl 应该存在').not.toBeNull();
    expect(errEl!.textContent).toBe('path 必填');
  });

  it('error 状态带 ERR_INVALID_ARG_TYPE 原始错误完整显示', () => {
    const tl = createEmptyStepTimeline('ch-2');
    const orig = 'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined';
    pushStepToTimeline(tl, 'step_start', { tool: 'summarize_document', args: {} });
    pushStepToTimeline(tl, 'step_error', { tool: 'summarize_document', error: orig });
    const errEl = tl.querySelector('.step-timeline-error');
    expect(errEl).not.toBeNull();
    expect(errEl!.textContent).toBe(orig);
    expect(errEl!.getAttribute('title')).toBe(orig);
  });

  it('done 状态的 step 不显示 error wrap', () => {
    const tl = createEmptyStepTimeline('ch-3');
    pushStepToTimeline(tl, 'step_start', { tool: 'read_file', args: { path: 'a.md' } });
    pushStepToTimeline(tl, 'step_done', { tool: 'read_file', success: true, output: 'content' });
    const errWrap = tl.querySelector('.step-timeline-error-wrap');
    expect(errWrap).not.toBeNull();
    expect(errWrap!.style.display).toBe('none');
  });

  it('active 状态的 step 不显示 error wrap', () => {
    const tl = createEmptyStepTimeline('ch-4');
    pushStepToTimeline(tl, 'step_start', { tool: 'shell_exec', args: { command: 'ls' } });
    const errWrap = tl.querySelector('.step-timeline-error-wrap');
    expect(errWrap).not.toBeNull();
    expect(errWrap!.style.display).toBe('none');
  });

  it('混合场景: done + error + active 并存, 只 error 显示 wrap', () => {
    const tl = createEmptyStepTimeline('ch-5');
    pushStepToTimeline(tl, 'step_start', { tool: 'read_file', args: { path: 'a.md' } });
    pushStepToTimeline(tl, 'step_done', { tool: 'read_file', success: true });
    pushStepToTimeline(tl, 'step_start', { tool: 'read_document', args: {} });
    pushStepToTimeline(tl, 'step_done', { tool: 'read_document', success: false, error: 'path 必填' });
    pushStepToTimeline(tl, 'step_start', { tool: 'glob_files', args: {} });

    const wraps = tl.querySelectorAll('.step-timeline-error-wrap');
    expect(wraps.length).toBe(3);
    expect(wraps.map(w => w.style.display)).toEqual(['none', '', 'none']);
  });

  it('step_error 事件也能触发 wrap 显示', () => {
    const tl = createEmptyStepTimeline('ch-6');
    pushStepToTimeline(tl, 'step_start', { tool: 'write_file', args: { path: 'x.ts' } });
    pushStepToTimeline(tl, 'step_error', { tool: 'write_file', error: '路径被护栏拒: x.ts' });
    const errEl = tl.querySelector('.step-timeline-error');
    expect(errEl!.textContent).toBe('路径被护栏拒: x.ts');
  });
});