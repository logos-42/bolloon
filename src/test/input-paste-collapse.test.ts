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
import { collapsePaste, shouldCollapsePaste, pasteLineCount, pastesDir, PASTE_MIN_CHARS, PASTE_MIN_LINES, stripBracketedPaste, hasBracketedPasteMarker, looksLikePasteChunk, logPasteChunk, PASTE_CHUNK_MIN_CHARS, PASTE_BURST_IDLE_MS, singleLine } from '../cli/input-paste.js';

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


describe('粘贴的真实形态 (弹窗/进不去输入框 的根因)', () => {
  it('括号粘贴标记必须能剥掉 (原先"含 ESC 就不当粘贴"把整段误杀了)', () => {
    const wrapped = '\u001b[200~' + 'hello\nworld' + '\u001b[201~';
    expect(hasBracketedPasteMarker(wrapped)).toBe(true);
    expect(stripBracketedPaste(wrapped)).toBe('hello\nworld');
    expect(stripBracketedPaste('plain')).toBe('plain');
  });
  it('"像粘贴"的判断覆盖三种真实块: 带标记 / 含换行 / 够长', () => {
    expect(looksLikePasteChunk('\u001b[200~x\u001b[201~')).toBe(true);   // 带标记
    expect(looksLikePasteChunk('a\nb')).toBe(true);                       // 逐行成块
    expect(looksLikePasteChunk('x'.repeat(PASTE_CHUNK_MIN_CHARS))).toBe(true);
    expect(looksLikePasteChunk('你好')).toBe(false);                        // 手敲短词不是粘贴
    expect(looksLikePasteChunk('')).toBe(false);
    expect(PASTE_BURST_IDLE_MS).toBeGreaterThan(0);                        // 攒块要有静默窗口
  });
  it('形态观测只记"形状"不记正文, 且不抛错', () => {
    logPasteChunk({ len: 123, marker: true, nl: true, esc: true }, TMP);
    const f = path.join(TMP, '.bolloon', 'logs', 'input-chunks.jsonl');
    expect(fs.existsSync(f)).toBe(true);
    const body = fs.readFileSync(f, 'utf-8');
    expect(body).toContain('"len":123');
    expect(logPasteChunk({ len: 1, marker: false, nl: false, esc: false }, '/proc/nonexistent-xyz')).toBeUndefined();
  });
});


describe('输入框恒单行 (用户: 「发送框也会分成好几行」)', () => {
  it('换行/制表符被压成空格 ⇒ Ink 不会把输入栏撑成多行', () => {
    expect(singleLine('a\nb\nc')).toBe('a b c');
    expect(singleLine('a\r\nb')).toBe('a b');
    expect(singleLine('a\tb')).toBe('a b');
    expect(singleLine('abc')).toBe('abc');
    expect(singleLine('a\n\n\nb')).toBe('a b');
    expect(singleLine('')).toBe('');
  });
  it('净化只影响**显示**, 不影响落盘/发送的原文 (原文照旧完整)', () => {
    const r = collapsePaste(LONG, { home: TMP, counter: 11 });
    expect(singleLine(r.inputText)).toBe(r.inputText);            // 输入框那份本来就没换行
    expect(fs.readFileSync(r.path!, 'utf-8')).toBe(LONG);          // 盘上仍是原文
    expect(r.sendText.split('\n').length).toBeGreaterThan(1);      // 发给模型的那份仍可多行
  });
});
