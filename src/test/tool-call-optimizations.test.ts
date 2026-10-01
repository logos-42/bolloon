/**
 * 工具调用优化 (2026-10-01): 遥测(#3) + 结果闸(#1)。两件都是"先能看见, 再能变好"的底座。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordToolCall, summarizeTelemetry, argsFingerprint, telemetryDir } from '../agents/tool-telemetry.js';
import { capToolResult, resultsDir, DEFAULT_RESULT_MAX_CHARS } from '../agents/tool-result-gate.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-toolopt-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('#3 遥测: 记下来 + 能汇总', () => {
  it('记一条能读回; 参数指纹不写正文 (秘密不进日志)', () => {
    const sig = argsFingerprint({ path: '/x/secret-key-abcdef', content: 'PRIVATE KEY MATERIAL' });
    expect(sig).toMatch(/^[0-9a-f]{12}$/);
    const r = recordToolCall({ tool: 'read_file', sig, ms: 12, ok: true, resultChars: 100, home: TMP });
    expect(r?.tool).toBe('read_file');
    const raw = fs.readFileSync(path.join(telemetryDir(TMP), 'tool-calls.jsonl'), 'utf-8');
    expect(raw).toContain('read_file');
    expect(raw).not.toContain('secret-key-abcdef');
    expect(raw).not.toContain('PRIVATE KEY MATERIAL');
  });
  it('**能算出重复率** (同签名连续 ⇒ repeatOfPrev=true) —— 这是"重复调用"的第一手证据', () => {
    const sig = argsFingerprint({ path: 'a' });
    recordToolCall({ tool: 'get_identity', sig, ms: 5, ok: true, resultChars: 90, home: TMP, prevSig: null });
    recordToolCall({ tool: 'get_identity', sig, ms: 6, ok: true, resultChars: 90, home: TMP, prevSig: sig });
    recordToolCall({ tool: 'get_identity', sig, ms: 5, ok: true, resultChars: 90, home: TMP, prevSig: sig });
    const s = summarizeTelemetry(TMP);
    expect(s.calls).toBeGreaterThanOrEqual(3);
    expect(s.repeats).toBeGreaterThanOrEqual(2);
    expect(s.repeatRate).toBeGreaterThan(0);
    expect(s.topTools[0].tool).toBe('get_identity');
  });
  it('坏目录/坏数据 ⇒ 不抛错, 汇总给零值 (fire-and-forget 纪律)', () => {
    expect(recordToolCall({ tool: 'x', sig: 'y', ms: 1, ok: true, resultChars: 1, home: '/proc/nonexistent-xyz' })).toBeNull();
    expect(summarizeTelemetry('/proc/nonexistent-xyz').calls).toBe(0);
  });
});

describe('#1 结果闸: 短的原样 / 长的头尾 + 落文件', () => {
  it('短结果一个字不动', () => {
    const r = capToolResult('hello', { tool: 't', home: TMP });
    expect(r.capped).toBe(false);
    expect(r.text).toBe('hello');
  });
  it('长结果: 保留头尾 + 标出原文长度 + 给出完整文件路径 (细节不丢)', () => {
    const long = 'H'.repeat(20000) + 'T'.repeat(5000);
    const r = capToolResult(long, { tool: 'grep_files', home: TMP });
    expect(r.capped).toBe(true);
    expect(r.text.length).toBeLessThan(DEFAULT_RESULT_MAX_CHARS + 400);
    expect(r.text).toContain('已截断');
    expect(r.spilledTo, '应该落盘').toBeTruthy();
    expect(fs.readFileSync(r.spilledTo!, 'utf-8').length).toBe(long.length);   // 原文完整在盘上
    expect(r.text.startsWith('H')).toBe(true);
    expect(r.text.trimEnd().endsWith('T')).toBe(true);
  });
  it('落盘被禁 ⇒ 只截断, 不抛错', () => {
    const r = capToolResult('x'.repeat(30000), { tool: 't', home: TMP, spill: false, maxChars: 1000 });
    expect(r.capped).toBe(true);
    expect(r.spilledTo).toBeUndefined();
    expect(r.text).toContain('已截断');
  });
});
