import { describe, it, expect } from 'vitest';
import {
  isBenignClientWriteNoise,
  guardClientWriteNoise,
  NoiseThrottle,
} from '../web/loop-noise.js';

describe('loop-noise (借鉴 Hermes tui_gateway/loop_noise.py 错误类型+回调双重判定)', () => {
  it('良性的客户端断开写失败 → 识别为噪音 (write EPIPE / write after end / reset / 10054)', () => {
    expect(isBenignClientWriteNoise(new Error('write EPIPE'))).toBe(true);
    expect(isBenignClientWriteNoise(new Error('write after end'))).toBe(true);
    expect(isBenignClientWriteNoise(new Error('Cannot write after the client is closed'))).toBe(true);
    expect(isBenignClientWriteNoise(new Error('ECONNRESET socket hang up'))).toBe(true);
    expect(isBenignClientWriteNoise({ message: 'Error [WinError 10054]: 连接被重置' })).toBe(true);
  });

  it('真实的非写错误 → 不吞 (只吞明确的写路径), 对应 hermes 类型+回调双重 gating', () => {
    // 非写上下文: 即便含 reset / broken pipe 也不吞
    expect(isBenignClientWriteNoise(new Error('EEXIST file exists'))).toBe(false);
    expect(isBenignClientWriteNoise(new Error('Authentication failed for model'))).toBe(false);
  });

  it('guardClientWriteNoise: 良性错误被吞不抛出, 且节流成一行', async () => {
    let threw = false;
    await guardClientWriteNoise(
      () => { throw new Error('write EPIPE'); },
      { label: 'test' },
    ).catch(() => { threw = true; });
    expect(threw).toBe(false); // 不影响 test-win
  });

  it('guardClientWriteNoise: 真实错误原样交给 onError / 抛出', async () => {
    let captured: unknown = null;
    await guardClientWriteNoise(
      () => { throw new Error('real bug'); },
      { label: 'test', onError: (e) => { captured = e; } },
    );
    expect((captured as Error).message).toBe('real bug');
  });
});

describe('NoiseThrottle (同类错误窗口节流 — channel_directory 模式)', () => {
  it('同窗口内同类错误只 warn 一次', () => {
    const t = new NoiseThrottle(60000);
    expect(t.shouldWarn('a', 'same detail')).toBe(true);
    expect(t.shouldWarn('a', 'same detail')).toBe(false);
    expect(t.shouldWarn('a', 'same detail')).toBe(false);
    expect(t.shouldWarn('b', 'same detail')).toBe(true); // 不同类别不限
  });

  it('窗口过后重新 warn', () => {
    const t = new NoiseThrottle(10);
    expect(t.shouldWarn('a', 'x')).toBe(true);
    // 等窗口过去
    return new Promise<void>((res) => setTimeout(() => {
      expect(t.shouldWarn('a', 'x')).toBe(true);
      res();
    }, 15));
  });
});