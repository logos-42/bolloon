/**
 * 长输入/粘贴折叠 (2026-10-01)。门锁的是**性质**, 不是实现细节:
 *   ① 短输入**一个字都不动**;
 *   ② 真实量级的粘贴(实测: 479 字符 + 一个换行)必须折叠 —— 旧阈值 8 行/1200 字符漏掉了它 ✗;
 *   ③ 引用形态 = 用户指定: `[粘贴 #N: M 行 → ~/.bolloon/pastes/pN_…txt]` (输入框与发送**同一份**, 一行);
 *   ④ **路径不许骗人**: 把 `~` 展开后文件必须真的存在, 且盘上内容与原文**逐字相同**;
 *   ⑤ **引用本身不触发补全弹窗**(确定性抑制 ⇒ 所以引用里可以放心带 '#' 和路径的 '/');
 *   ⑥ 回车(单个 \n)/制表/短串 **不是粘贴** —— 否则 Enter 被吞、提交不了(踩过 ✗);
 *   ⑦ 落盘失败 ⇒ 原样发送(折叠是优化, 绝不能因为它发不出去); 观测只记形状不记正文。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collapsePaste, shouldCollapsePaste, pasteLineCount, pastesDir,
  PASTE_MIN_CHARS, PASTE_MIN_LINES, stripBracketedPaste, hasBracketedPasteMarker,
  looksLikePasteChunk, logPasteChunk, PASTE_CHUNK_MIN_CHARS, singleLine, isPasteRef, shouldSuppressMention,
} from '../cli/input-paste.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-paste-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const LONG = Array.from({ length: 12 }, (_v, i) => `第 ${i + 1} 行 内容 abcdefghijklmnop`).join('\n');
/** 真实数据量级: 用户实测那次 = 479 字符 + 一个换行 */
const REAL = '这是一段粘贴进来的内容, '.repeat(29) + '\n' + '第二行继续 '.repeat(18);

describe('折叠阈值与真实形态', () => {
  it('① 短输入不动', () => {
    expect(shouldCollapsePaste('你好')).toBe(false);
    const r = collapsePaste('你好', { home: TMP });
    expect(r.collapsed).toBe(false);
    expect(r.sendText).toBe('你好');
    expect(r.path).toBeUndefined();
  });
  it('② 实测那次(479 字符 + 一个换行)必须折叠 —— 旧阈值两个都没到', () => {
    expect(REAL.length).toBeGreaterThan(400);
    expect(pasteLineCount(REAL)).toBe(2);
    expect(REAL.length).toBeLessThan(1200);
    expect(shouldCollapsePaste(REAL), '真实量级的粘贴必须折叠').toBe(true);
    const r = collapsePaste(REAL, { home: TMP, counter: 21 });
    expect(r.collapsed).toBe(true);
    expect(fs.readFileSync(r.path!, 'utf-8')).toBe(REAL);
  });
  it('单行 300 折叠 / 299 不折叠; 多行一律折叠', () => {
    expect(shouldCollapsePaste('x'.repeat(PASTE_MIN_CHARS))).toBe(true);
    expect(shouldCollapsePaste('x'.repeat(PASTE_MIN_CHARS - 1))).toBe(false);
    expect(PASTE_MIN_LINES).toBe(2);
  });
});

describe('③④ 引用形态与"路径不许骗人"', () => {
  it('引用 = [粘贴 #N: M 行 → ~/…/pN_HHMMSS.txt], 输入框与发送同一份且只有一行', () => {
    const r = collapsePaste(LONG, { home: TMP, counter: 7 });
    expect(r.inputText).toBe(r.sendText);
    expect(r.inputText.split('\n').length).toBe(1);
    expect(isPasteRef(r.inputText), `应被认成引用: ${r.inputText}`).toBe(true);
    expect(r.inputText).toMatch(/^\[粘贴 #7: 12 行 → ~\/\.bolloon\/pastes\/p7_\d{6}\.txt\]$/);
    expect(r.inputText.length).toBeLessThan(60);
  });
  it('展开 ~ 后文件真存在, 内容逐字相同, 权限 0600', () => {
    const r = collapsePaste(LONG, { home: TMP, counter: 8 });
    expect(fs.existsSync(r.path!)).toBe(true);
    expect(fs.readFileSync(r.path!, 'utf-8')).toBe(LONG);
    expect(fs.statSync(r.path!).mode & 0o777).toBe(0o600);
    // 引用里的路径展开(把 ~ 换成 TMP)也要指向同一个文件
    const fromRef = path.join(TMP, r.inputText.replace(/^.*→ ~\//, '').replace(/\]$/, ''));
    expect(fromRef).toBe(r.path);
  });
});

describe('⑤ 引用不触发弹窗 / 回车不是粘贴', () => {
  it('引用本身一律不当补全来源(确定性); 正常 @ 补全不受影响', () => {
    const r = collapsePaste(LONG, { home: TMP, counter: 9 });
    expect(shouldSuppressMention(r.inputText, 0)).toBe(true);
    expect(shouldSuppressMention('@', 0)).toBe(false);
    expect(isPasteRef('[粘贴 #1: 3 行 → ~/a.txt]')).toBe(true);
    expect(isPasteRef('普通输入')).toBe(false);
  });
  it('回车/制表/短串不是粘贴(否则 Enter 被吞)', () => {
    for (const s of ['\n', '\r', 'a\n', '\t']) expect(looksLikePasteChunk(s), JSON.stringify(s)).toBe(false);
    expect(looksLikePasteChunk('x'.repeat(PASTE_CHUNK_MIN_CHARS - 1))).toBe(false);
    expect(looksLikePasteChunk('x'.repeat(PASTE_CHUNK_MIN_CHARS))).toBe(true);
  });
  it('括号粘贴标记可剥; 带标记且有内容算粘贴', () => {
    const wrapped = '\u001b[200~' + 'hello\nworld' + '\u001b[201~';
    expect(hasBracketedPasteMarker(wrapped)).toBe(true);
    expect(stripBracketedPaste(wrapped)).toBe('hello\nworld');
    expect(looksLikePasteChunk('\u001b[200~x\u001b[201~')).toBe(true);
  });
});

describe('⑥⑦ 失败降级 / 单行化 / 观测', () => {
  it('落盘失败 ⇒ 原样发送', () => {
    const r = collapsePaste(LONG, { home: '/proc/nonexistent-xyz' });
    expect(r.collapsed).toBe(false);
    expect(r.sendText).toBe(LONG);
  });
  it('输入框恒单行: 换行/制表压成空格, 但盘上与发送的原文不动', () => {
    expect(singleLine('a\nb\tc')).toBe('a b c');
    const r = collapsePaste(LONG, { home: TMP, counter: 11 });
    expect(singleLine(r.inputText)).toBe(r.inputText);
    expect(fs.readFileSync(r.path!, 'utf-8')).toBe(LONG);
  });
  it('观测只记形状不记正文, 坏目录不抛错', () => {
    logPasteChunk({ len: 123, marker: true, nl: true, esc: true, tab: true }, TMP);
    const body = fs.readFileSync(path.join(TMP, '.bolloon', 'logs', 'input-chunks.jsonl'), 'utf-8');
    expect(body).toContain('"len":123');
    expect(body).not.toContain('正文');
    expect(logPasteChunk({ len: 1, marker: false, nl: false, esc: false }, '/proc/nonexistent-xyz')).toBeUndefined();
    expect(fs.existsSync(pastesDir(TMP))).toBe(true);
  });
});
