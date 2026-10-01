/**
 * 思考动画不许进对话流(Static) (2026-10-01, 用户: 「颜文字被加载进去了」+「可能是 ink 渲染的问题」)。
 * 为什么: 对话流走 Ink `<Static>` = 写一次永不重绘 ⇒ 任何"动画/瞬时状态"若走 appendLine,
 *   就会被**永久烙进滚动区** ✗(带 \r 也擦不掉), 残影还能被拖进输入框混进上下文 ✗。
 * 契约(源级): Thinking/clearThinking 只许用瞬时行通道(inkSetThinking), 不许 appendLine 颜文字/思考帧。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RAW = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
/** 先剥注释: 否则门会被"解释这条规矩的注释"绊倒(本门第一次就栽在这 ✗) */
const SRC = RAW.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const seg = /Thinking: \(\) => \{([\s\S]*?)\n  \},\n\n  clearThinking/.exec(SRC);

describe('思考动画通道', () => {
  it('Thinking 必须走 inkSetThinking, 不许 appendLine 帧', () => {
    expect(seg, '没找到 Thinking 回调').toBeTruthy();
    expect(seg![1]).toContain('inkSetThinking(true)');
    expect(seg![1]).not.toContain('appendLine');
  });
  it('clearThinking 必须清掉 thinking 状态', () => {
    const c = /clearThinking: \(interval[\s\S]*?\n  \},/.exec(SRC);
    expect(c).toBeTruthy();
    expect(c![0]).toContain('inkSetThinking(false)');
  });
});
