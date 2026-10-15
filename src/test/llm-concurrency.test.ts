/**
 * llm-concurrency.test.ts — 模型调用并发闸 (2026-10-15)
 *
 * 背景 (leo: 「[AI 服务调用失败] OpenAI API error: 429 ... 当前 API Key 的并发请求已达到上限」):
 *   CLI/Web/心跳/会话总结等多路会同时打同一个 provider, 上游按 API key 限并发 ⇒ 429。
 *   修法 = 在唯一咽喉 generateText 前按 providerId|baseUrl 分桶限流 (withLlmConcurrency)。
 * 这里直接测闸本身: 同 key 超限排队、不同 key 互不阻塞、abort 可退出、异常释放槽位。
 */
import { describe, it, expect } from 'vitest';
import { withLlmConcurrency } from '../llm/pi-ai.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 并发峰值: 同时启动 N 个**经过闸**的任务, 记录任意时刻在跑的最大数 */
async function peakConcurrency(key: string, fn: () => Promise<void>, count: number): Promise<number> {
  let active = 0;
  let peak = 0;
  const run = async () => {
    await withLlmConcurrency(key, undefined, async () => {
      active++;
      peak = Math.max(peak, active);
      await fn();
      active--;
    });
  };
  await Promise.all(Array.from({ length: count }, () => run()));
  return peak;
}

describe('withLlmConcurrency 并发闸', () => {
  it('同 key 同时最多 LLM_MAX_CONCURRENCY 个在途 (默认 2), 其余排队', async () => {
    const peak = await peakConcurrency('k|u', async () => { await sleep(60); }, 6);
    // 实测默认 2: 6 个并发请求, 峰值不超 2
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  }, 5_000);

  it('不同 key (provider|baseUrl) 互不阻塞, 各自独立并发', async () => {
    let activeA = 0;
    let activeB = 0;
    const runs: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      runs.push(withLlmConcurrency('a|http://x', undefined, async () => { activeA++; await sleep(50); activeA--; }));
      runs.push(withLlmConcurrency('b|http://y', undefined, async () => { activeB++; await sleep(50); activeB--; }));
    }
    await Promise.all(runs);
    expect(activeA).toBe(0);
    expect(activeB).toBe(0);
  }, 5_000);

  it('异常不占槽位: fn 抛错后, 后续排队请求仍能执行', async () => {
    let ran = 0;
    await withLlmConcurrency('k|u', undefined, async () => { throw new Error('boom'); }).catch(() => {});
    await withLlmConcurrency('k|u', undefined, async () => { ran++; });
    expect(ran).toBe(1);
  }, 5_000);

  it('排队等待时 abort → 尽快抛错退出, 不继续发请求', async () => {
    // 第一个请求占满槽位 (默认 2, 用两个占位), 第三个带已 abort 的 signal
    const ac = new AbortController();
    ac.abort(new Error('用户取消'));
    const holder = withLlmConcurrency('k|u', undefined, async () => { await sleep(200); });
    const holder2 = withLlmConcurrency('k|u', undefined, async () => { await sleep(200); });
    await expect(withLlmConcurrency('k|u', ac.signal, async () => { throw new Error('不该执行'); }))
      .rejects.toThrow(/Abort|取消/);
    await Promise.all([holder, holder2]);
  }, 5_000);
});
