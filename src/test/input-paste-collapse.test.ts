/**
 * 长输入/粘贴折叠 (2026-10-01, 用户: 「输入文本框有压缩吗…教给 bolloon」)。
 * 门要锁住的**性质**(不是实现细节):
 *   ① 短输入**一个字都不动** (别把日常输入也搞成引用);
 *   ② 长输入 ⇒ 落盘 + 一行引用(含 序号/行数/路径) ⇒ 对话流短;
 *   ③ **效果上无损**: 落盘文件内容与原文**逐字相同** ⇒ 要细节读得回来(这才是敢折叠的前提);
 *   ④ 写盘失败 ⇒ **原样发送** (折叠是优化, 绝不能因为它发不出去)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collapsePaste, shouldCollapsePaste, pasteLineCount, pastesDir, PASTE_MIN_CHARS, PASTE_MIN_LINES } from '../cli/input-paste.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-paste-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const LONG = Array.from({ length: 12 }, (_v, i) => `第 ${i + 1} 行 内容 abcdefghijklmnop`).join('\n');

describe('长输入折叠', () => {
  it('① 短输入不动 (阈值以下)', () => {
    expect(shouldCollapsePaste('你好')).toBe(false);
    const r = collapsePaste('你好', { home: TMP });
    expect(r.collapsed).toBe(false);
    expect(r.sendText).toBe('你好');
    expect(r.path).toBeUndefined();
  });
  it('② 长输入: 落盘 + 一行引用(序号/行数/路径都在)', () => {
    const r = collapsePaste(LONG, { home: TMP, counter: 7 });
    expect(r.collapsed).toBe(true);
    expect(r.lines).toBe(12);
    expect(r.sendText).toContain('[粘贴 #7: 12 行');
    expect(r.sendText).toContain('paste_7_');
    // 真正的性质: 发送文本里**不该再含正文**(正文去文件里了), 且超大粘贴要缩到个位数百分比
    expect(r.sendText.includes('abcdefghijklmnop')).toBe(false);
    // 输入框版本: **只有一行引用**(不带解释), 这样它才能"暂留"在输入框里不碍事
    expect(r.inputText.split('\n').length).toBe(1);
    expect(r.inputText).toContain('[粘贴 7 · 12 行]');
    expect(r.inputText.length).toBeLessThan(60);
    // ★ 输入框那份**不许含任何补全触发字符** —— '@'/'/'/'#' 会让补全弹窗在粘贴后冒出来 ✗
    for (const bad of ['@', '/', '#']) {
      expect(r.inputText.includes(bad), `输入框引用不该含 ${bad}(会触发弹窗)`).toBe(false);
    }
    // 而**发送出去**的那份必须带完整路径(要细节读得回来)
    expect(r.sendText).toContain(r.path!);
    const huge = Array.from({ length: 500 }, (_v, i) => `第 ${i} 行 ` + 'y'.repeat(40)).join('\n');
    const rh = collapsePaste(huge, { home: TMP, counter: 9 });
    expect(rh.sendText.length).toBeLessThan(huge.length * 0.05);
  });
  it('③ 无损: 落盘内容与原文**逐字相同** (敢折叠的前提)', () => {
    const r = collapsePaste(LONG, { home: TMP, counter: 8 });
    expect(fs.readFileSync(r.path!, 'utf-8')).toBe(LONG);
    expect(fs.statSync(r.path!).mode & 0o777).toBe(0o600);     // 0600
  });
  it('④ 写盘失败 ⇒ 原样发送 (绝不因为折叠发不出去)', () => {
    const r = collapsePaste(LONG, { home: '/proc/nonexistent-xyz' });
    expect(r.collapsed).toBe(false);
    expect(r.sendText).toBe(LONG);
  });
  it('阈值: 行数或字符数任一超线即折叠', () => {
    expect(pasteLineCount('a\nb\nc')).toBe(3);
    const manyLines = Array.from({ length: PASTE_MIN_LINES }, () => 'x').join('\n');
    expect(shouldCollapsePaste(manyLines)).toBe(true);
    expect(shouldCollapsePaste('x'.repeat(PASTE_MIN_CHARS))).toBe(true);
    expect(fs.existsSync(pastesDir(TMP))).toBe(true);
  });
});
