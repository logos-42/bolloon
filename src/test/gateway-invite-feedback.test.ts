/**
 * gateway-invite-feedback.test.ts — 群聊「🔗 邀请」按钮反馈修复 (2026-10-24, 用户反馈:
 * 「在打开群聊页面后, 点击邀请按钮无反应, 没有复制链接成功」)
 *
 * 根因 (源码级, 可复核):
 *   ① `gwToast()` 调 `(window as any).showToast?.(text)` — 全仓没有任何地方把 toast 挂到 window,
 *      真实的函数叫 `showSimpleToast`。⇒ 所有 gateway 反馈 (邀请/建群/加入) 只进 console,
 *      用户视角 = 点了完全没反应 (连"失败"都看不到)。
 *   ② 邀请 handler 里 `try { navigator.clipboard.writeText(...) } catch {}` — 复制失败被吞,
 *      然后照样 toast "已复制" ⇒ 假成功, 用户以为复制了。
 *   ③ 没有任何可视兜底: 复制失败时链接无处可看。
 *
 * 判据:
 *   A. **反馈真的可见** — gwToast 走 showSimpleToast, 不得再出现 window.showToast
 *   B. **复制失败不装成功** — 有 clipboard → execCommand 回退, 返回 boolean 让调用方如实报
 *   C. **链接兜底可见** — 群聊 modal 有 .gw-chat-link 可视区, 失败时把链接摆出来手选
 *   D. **dist 同步** — 编译产物含新逻辑 (忘了 build:web 就红)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('A. toast 反馈可见 (根因 ①)', () => {
  const ts = read('src/web/client.ts');

  it('gwToast 调真实存在的 showSimpleToast', () => {
    const fn = ts.match(/function gwToast\(text: string\): void \{[\s\S]*?\n\}/);
    expect(fn, 'gwToast 要存在').toBeTruthy();
    expect(fn![0]).toMatch(/showSimpleToast\(text\)/);
    expect(fn![0]).not.toMatch(/window as any\)\.showToast/);
  });

  it('全文件不再有 window.showToast 调用 (幽灵函数)', () => {
    expect(ts).not.toMatch(/\(window as any\)\.showToast/);
  });

  it('showSimpleToast 定义仍在 (gwToast 的依赖)', () => {
    expect(ts).toMatch(/function showSimpleToast\(text, kind = 'info'\)/);
  });
});

describe('B. 复制失败不装成功 (根因 ②)', () => {
  const ts = read('src/web/client.ts');

  it('copyTextToClipboard: clipboard → execCommand 回退, 返回 boolean', () => {
    const fn = ts.match(/async function copyTextToClipboard\(text: string\): Promise<boolean> \{[\s\S]*?\n\}/);
    expect(fn, 'copyTextToClipboard 要存在').toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/navigator\.clipboard/);
    expect(body).toMatch(/isSecureContext/);
    expect(body).toMatch(/execCommand\('copy'\)/);
    expect(body).toMatch(/return false/);
  });

  it('邀请 handler 用 copyTextToClipboard 的真返回值决定文案 (成功/失败都说)', () => {
    const h = ts.match(/\.gw-chat-invite'\)\?\.addEventListener\('click'[\s\S]*?\n  \}\);/);
    expect(h, '邀请 handler 要存在').toBeTruthy();
    const body = h![0];
    expect(body).toMatch(/const ok = await copyTextToClipboard\(r\.link\)/);
    expect(body).toMatch(/ok \?/);
    expect(body).toMatch(/自动复制失败/);
    // 不得再出现"吞异常后无条件说已复制"
    expect(body).not.toMatch(/catch \{ \/\* 忽略 \*\/ \}\s*\n\s*gwToast\('群邀请链接已复制/);
  });

  it('取链接失败时如实报 (带服务端 error)', () => {
    const h = ts.match(/\.gw-chat-invite'\)\?\.addEventListener\('click'[\s\S]*?\n  \}\);/);
    expect(h![0]).toMatch(/获取群邀请链接失败/);
    expect(h![0]).toMatch(/r\?\.error/);
  });
});

describe('C. 链接兜底可见 (根因 ③)', () => {
  const ts = read('src/web/client.ts');
  const css = read('src/web/style.css');

  it('群聊 modal 里有 .gw-chat-link 可视区', () => {
    expect(ts).toMatch(/<div class="gw-chat-link" style="display:none;"><\/div>/);
    const h = ts.match(/\.gw-chat-invite'\)\?\.addEventListener\('click'[\s\S]*?\n  \}\);/);
    expect(h![0]).toMatch(/box\.textContent = r\.link/);
    expect(h![0]).toMatch(/box\.style\.display = 'block'/);
  });

  it('样式: 可手选 + 长链接换行 + 按钮禁用态', () => {
    expect(css).toMatch(/\.gw-chat-link \{[\s\S]*?user-select: all/);
    expect(css).toMatch(/\.gw-chat-link \{[\s\S]*?word-break: break-all/);
    expect(css).toMatch(/\.gw-chat-invite:disabled/);
  });
});

describe('D. dist 同步 (忘了 build:web 就红)', () => {
  it('dist/web/client.js 含新反馈逻辑', () => {
    const js = read('dist/web/client.js');
    expect(js).toMatch(/showSimpleToast\(text\)/);
    expect(js).not.toMatch(/\)\.showToast\?\.\(text\)/);
    expect(js).toMatch(/execCommand\("copy"\)|execCommand\('copy'\)/);
    expect(js).toMatch(/gw-chat-link/);
  });

  it('dist/web/style.css 含 .gw-chat-link', () => {
    expect(read('dist/web/style.css')).toMatch(/\.gw-chat-link/);
  });
});
