/**
 * exhaust-scrubber.test.ts — 上下文废气涡轮单测 (2026-07-22 设计 C)
 *
 * 验证: 背压等级映射 / 进气调参 (maxChars·topK) / 废气采样累计 / memory 落地 / log 落盘
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  recordExhaust,
  getBackpressure,
  getPressureLevel,
  getInjectionMaxChars,
  getRetrievalTopK,
  maybeWriteExhaustMemorySummary,
  __resetForTest,
} from '../bootstrap/exhaust-scrubber.js';

describe('exhaust-scrubber (上下文废气涡轮)', () => {
  beforeEach(() => {
    __resetForTest();
  });

  it('空缓冲 → idle, maxChars=1800 (放宽注入)', () => {
    expect(getPressureLevel()).toBe('idle');
    expect(getInjectionMaxChars()).toBe(1800);
    expect(getRetrievalTopK()).toBe(8);
  });

  it('1-2 事件/60s → low (上下文宽裕)', async () => {
    const now = Date.now();
    await recordExhaust({ source: 'memory-compressor', reason: 'compress', ts: new Date(now).toISOString() });
    expect(getPressureLevel()).toBe('low');
    expect(getInjectionMaxChars()).toBe(1800);
  });

  it('3-10 事件/60s → medium, maxChars=1500 (默认)', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await recordExhaust({ source: 'compaction', reason: 'fold', ts: new Date(now - i * 1000).toISOString() });
    }
    expect(getPressureLevel()).toBe('medium');
    expect(getInjectionMaxChars()).toBe(1500);
    expect(getRetrievalTopK()).toBe(5);
  });

  it('>10 事件/60s → high, maxChars=800, topK=3 (收紧)', async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await recordExhaust({
        source: 'context-collector',
        reason: 'truncated',
        droppedTokens: 100,
        ts: new Date(now - i * 500).toISOString(),
      });
    }
    expect(getPressureLevel()).toBe('high');
    expect(getInjectionMaxChars()).toBe(800);
    expect(getRetrievalTopK()).toBe(3);
  });

  it('droppedTokens 累计 + bySource 分桶', async () => {
    await recordExhaust({ source: 'memory-compressor', reason: 'c', droppedTokens: 200 });
    await recordExhaust({ source: 'compaction', reason: 'f', droppedTokens: 300 });
    const snap = getBackpressure();
    expect(snap.droppedTokensTotal).toBe(500);
    expect(snap.bySource['memory-compressor']).toBe(1);
    expect(snap.bySource['compaction']).toBe(1);
  });

  it('60s 外的事件不计入 dropRate (老化)', async () => {
    const now = Date.now();
    // 5 个事件在 120s 前 (老化, 不计入 recent)
    for (let i = 0; i < 5; i++) {
      await recordExhaust({ source: 'compaction', reason: 'old', ts: new Date(now - 120_000 - i * 1000).toISOString() });
    }
    // 1 个事件在 30s 前 (计入)
    await recordExhaust({ source: 'compaction', reason: 'recent', ts: new Date(now - 30_000).toISOString() });
    const snap = getBackpressure();
    expect(snap.dropRatePerMin).toBe(1); // 只算 recent
    expect(snap.level).toBe('low');
  });

  it('落盘 backpressure.jsonl (log)', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-exhaust-'));
    await recordExhaust({ source: 'memory-compressor', reason: 'compress', droppedTokens: 100 }, tmpHome);
    const logPath = path.join(tmpHome, '.bolloon', 'engine', 'backpressure.jsonl');
    const log = await fs.readFile(logPath, 'utf-8');
    expect(log).toContain('memory-compressor');
    expect(log).toContain('compress');
    expect(log).toContain('droppedTokens');
  });

  it('maybeWriteExhaustMemorySummary 仅 high 时写 memory', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-exhaust-'));
    // low 时不写
    await recordExhaust({ source: 'memory-compressor', reason: 'c' }, tmpHome);
    const r1 = await maybeWriteExhaustMemorySummary('agent1', tmpHome);
    expect(r1.written).toBe(false);

    // high 时写
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await recordExhaust({ source: 'context-collector', reason: 't', ts: new Date(now - i * 500).toISOString() }, tmpHome);
    }
    const r2 = await maybeWriteExhaustMemorySummary('agent1', tmpHome);
    expect(r2.written).toBe(true);
    expect(r2.path).toContain('engine');
    const content = await fs.readFile(r2.path!, 'utf-8');
    expect(content).toContain('引擎背压高峰');
    expect(content).toContain('level=high');
  });
});
