/**
 * 启动期日志缓冲 (2026-10-01, 用户: 「iroh: … / ✓ [4/5] 启动 iroh P2P，没拦住？」)。
 * 为什么拦不住: 启动步骤(第 ~425-503 行)比 `startInk()`(第 ~1380 行)**早 900 行** ⇒
 *   在那一刻装 console 拦截器根本来不及 ✗ ⇒ 那些行和启动面板**交错**打在屏幕上 ✓。
 * 契约(源级):
 *  ① `writeOut` 在 Ink 未起时**进缓冲**(不直写) ✓ 且缓冲有上限(超限退回直写, 不丢日志 ✓)
 *  ② 提供 `flushBootBuffer()` ✓ 且**在 startInk 调用之后**调用一次 ✓(顺序错了就等于没灌 ✓)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RAW = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
const SRC = RAW.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('启动日志缓冲', () => {
  it('① writeOut 未起 Ink 时进缓冲, 且有上限', () => {
    expect(SRC).toContain('bootBuffer.push(line)');
    expect(SRC).toMatch(/bootBuffer\.length\s*<\s*\d+/);
  });
  it('② flushBootBuffer 必须在 startInk(...) 调用**之后**', () => {
    const callStart = SRC.indexOf('startInk(');
    const callEnd = SRC.indexOf(');', SRC.indexOf('getStatus,', callStart));
    const flush = SRC.indexOf('flushBootBuffer();', callStart);
    expect(callStart).toBeGreaterThan(0);
    expect(callEnd).toBeGreaterThan(callStart);
    expect(flush, 'flush 必须在 startInk 收尾之后').toBeGreaterThan(callEnd);
  });
  it('③ 灌进去时不能丢(循环取尽)且异常退回直写', () => {
    const fn = /export function flushBootBuffer\(\)[\s\S]*?\n\}/.exec(SRC);
    expect(fn).toBeTruthy();
    expect(fn![0]).toMatch(/while \(bootBuffer\.length\)/);
    expect(fn![0]).toMatch(/console\.log\(line\)/);
  });
});


describe('启动期进度类**只落盘不上屏** (用户: 「继续，还没去掉」)', () => {
  const CODE = RAW.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  it('writeOut 在 Ink 未起时必须走 bootLogOnly(不是缓冲、不是直写)', () => {
    const fn = /function writeOut\(line: string\)[\s\S]*?\n\}/.exec(CODE);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('bootLogOnly(line)');
    expect(fn![0]).not.toContain('bootBuffer.push');
  });
  it('警告/错误仍要上屏(不许把问题藏起来)', () => {
    const fn = /function writeOutWarn\(line: string\)[\s\S]*?\n\}/.exec(CODE);
    expect(fn).toBeTruthy();
    expect(fn![0]).toMatch(/bootBuffer\.push|appendLine/);
    // s.warn / s.error 必须接 writeOutWarn
    expect(CODE).toMatch(/warn: \(text: string\) => writeOutWarn\(/);
    expect(CODE).toMatch(/error: \(text: string\) => writeOutWarn\(/);
  });
  it('bootLogOnly 必须真落盘(startupLogPath)且剥 ANSI', () => {
    const fn = /function bootLogOnly\(line: string\)[\s\S]*?\n\}/.exec(CODE);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('startupLogPath()');
    expect(fn![0]).toMatch(/x1b\\\[/);
  });
});
