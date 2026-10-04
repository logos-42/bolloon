/**
 * k10-model-runtime-wiring.test.ts — K10 ②: 回合的模型经**内核运行时**取租约
 *
 * 背景: K6 把 `ModelRuntime` (超时/取消/退避/熔断/回退/记账/连接池/能力检查) 造好了, 判据也自述
 * `capabilitiesDone: 9`, 但**生产里没人用它** —— 回合的模型一直是 Pi 自己 `getMinimax()` 直接拿的。
 * 这一条钉住 ② 的轻版: 回合先向内核运行时 `acquire(snapshot)` 取租约 (只读), 取不到才**如实回落**。
 *
 * 判据两段:
 *   A. `snapshotFromSelection` 是**只读投影**且**不许编** (缺 provider/model 就 null);
 *   B. 接线不许退化 (必须建运行时 · 必须 acquire · 必须保留"如实回落"分支 · 调用点必须 await)。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { snapshotFromSelection, ModelRuntime } from '../kernel/model-runtime.js';

const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('K10 ②-A. snapshotFromSelection: 只读投影, 缺信息就 null (不编)', () => {
  it('有效选择 ⇒ 带 provider/model; 给了 baseUrl 才带上 baseUrl', () => {
    expect(snapshotFromSelection({ provider: 'deepseek', model: 'deepseek-chat' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    const withUrl = snapshotFromSelection({ provider: 'p', model: 'm', baseUrl: 'https://x/v1' });
    expect(withUrl).toEqual({ provider: 'p', model: 'm', baseUrl: 'https://x/v1' });
    expect(snapshotFromSelection({ provider: 'p', model: 'm', baseUrl: '   ' })!.baseUrl, '空白 baseUrl 不许带').toBeUndefined();
  });

  it('缺 provider / model ⇒ **null** (不编一个假的)', () => {
    expect(snapshotFromSelection(null)).toBeNull();
    expect(snapshotFromSelection(undefined)).toBeNull();
    expect(snapshotFromSelection({ model: 'm' })).toBeNull();
    expect(snapshotFromSelection({ provider: 'p' })).toBeNull();
    expect(snapshotFromSelection({ provider: '  ', model: 'm' })).toBeNull();
    expect(snapshotFromSelection({ provider: 'p', model: '' })).toBeNull();
  });

  it('只读: 入参被冻结也不抛 (引擎红线 —— acquire 全链不许写 snapshot)', () => {
    const sel = Object.freeze({ provider: 'p', model: 'm', baseUrl: 'https://x', capabilities: Object.freeze(['tools']) });
    expect(() => snapshotFromSelection(sel as any)).not.toThrow();
    const snap = snapshotFromSelection(sel as any)!;
    expect(snap.capabilities).toEqual(['tools']);
  });

  it('投出来的东西内核真能吃: acquire 接受它 (缺字段则明确拒, 不猜)', async () => {
    let opened = 0;
    const rt = new ModelRuntime({
      openConnection: async (s) => ({
        id: `${s.provider}:${s.model}`,
        call: async () => ({ ok: true, provider: s.provider }),
        close: async () => {},
      }),
    });
    const snap = snapshotFromSelection({ provider: 'deepseek', model: 'deepseek-chat' })!;
    const lease = await rt.acquire(snap);
    expect(lease.snapshot.provider).toBe('deepseek');
    const res = await lease.call({});
    expect(res.ok).toBe(true);
    opened += 1;
    expect(opened).toBe(1);
    lease.release();
    await expect(rt.acquire({ provider: '', model: '' } as any)).rejects.toThrow(/provider \+ model/);
  });
});

describe('K10 ②-B. 接线反回归: 回合必须经内核运行时取租约, 且保留如实回落', () => {
  it('pi-sdk: 建运行时 + acquire(snapshot) + 回落时如实记 + 调用点 await', () => {
    const src = readSrc('src/agents/pi-sdk.ts');
    expect(src, '必须建内核运行时').toMatch(/new ModelRuntime\(/);
    expect(src, '必须只读取租约').toMatch(/\.acquire\(snapshot\)/);
    expect(src, '必须有租约适配器').toMatch(/kernelLeaseAdapter/);
    expect(src, '取不到时必须如实记并回落 (不假装走了内核)').toMatch(/内核租约不可用 ⇒ 回落 Pi 直连/);
    expect(src, '选择点已改异步 ⇒ 调用点必须 await').toMatch(/const llm = await this\.inferenceAdapter\(\)/);
    // 只读红线: 端口实现里不许出现"写回 snapshot"的意图
    expect(src).not.toMatch(/snapshot\.(provider|model|baseUrl)\s*=/);
  });

  it('租约必须**每次调用现取** —— 不许在适配器创建时取一个、用完还回去 (踩过的坑)', () => {
    const src = readSrc('src/agents/pi-sdk.ts');
    // 反面形状: 适配器创建时就 acquire 一个长期租约
    expect(src, '不许在适配器创建时取长期租约 (还回去后第 2 次调用会撞「租约已归还」)')
      .not.toMatch(/const lease = await this\.kernelModelRuntime\(\)\.acquire\(/);
    // 正面形状: 在 chat 里现取
    expect(src).toMatch(/lease = await runtime\.acquire\(snapshot\)/);
    expect(src).toMatch(/lease\.release\(\)/);
  });
});
