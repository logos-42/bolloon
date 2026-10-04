/**
 * k10-run-resume.test.ts — K10 余项: 恢复一次运行的**编排与政策**归内核
 *
 * 迁移前: `pi-sdk.resumeRun` 的 47 行方法体里同时有 —— 反查模型配置 · 漂移上报口径 · 准备 ·
 * 「只在漂了/核对不了时装」的判据 · 装配失败不阻塞 · 恢复态的落/清 · 驱动同一 runId。
 * 本轮把**序列与政策**整条搬进 `src/kernel/run-resume.ts`, pi-sdk 只剩七个端口实现 (40 → 29 行)。
 *
 * 判据四段:
 *   A. 漂移政策: 漂了 ⇒ warn · 一致 ⇒ info · **核对失败不阻塞恢复**;
 *   B. 装配政策: 一致+核对过 ⇒ **一次都不装** · 漂了/核对不了 ⇒ 装 · **装失败也不阻塞** (如实留在返回值里);
 *   C. 准备失败 ⇒ 早返回 (不驱动、不落态) · 恢复态单次语义 ⇒ **驱动抛错也一定被清**;
 *   D. 反回归 (源级): 旧的内联政策形状不许回到 pi-sdk。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resumeRunViaKernel, type ResumePorts } from '../kernel/run-resume.js';

const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

function probe(over: Partial<ResumePorts> & {
  drift?: unknown; prepareOk?: boolean; prepareReason?: string; driftThrows?: boolean; applyThrows?: boolean; runThrows?: boolean;
} = {}) {
  const calls = { detect: 0, prepare: 0, apply: 0, plan: 0, run: 0, clear: 0, logs: [] as string[] };
  const ports: ResumePorts = {
    detectDrift: async () => {
      calls.detect += 1;
      if (over.driftThrows) throw new Error('核对炸了');
      return (over.drift ?? { drifted: false, verified: true, message: '一致' }) as never;
    },
    prepareResume: async () => {
      calls.prepare += 1;
      return over.prepareOk === false
        ? { ok: false, reason: over.prepareReason ?? '状态不允许恢复' }
        : { ok: true, plan: { goalId: 'g-1' } };
    },
    applySnapshot: async () => {
      calls.apply += 1;
      if (over.applyThrows) throw new Error('装配炸了');
      return { provider: 'p', model: 'm', configHash: 'abcdef1234567890' };
    },
    applyPlan: () => { calls.plan += 1; },
    continueRun: async () => {
      calls.run += 1;
      if (over.runThrows) throw new Error('驱动炸了');
      return '回复';
    },
    clearPlan: () => { calls.clear += 1; },
    log: (_lvl, body) => { calls.logs.push(body); },
    ...over,
  };
  return { calls, ports };
}

describe('K10 余项-A. 漂移政策 (核对失败不阻塞恢复)', () => {
  it('漂了 ⇒ warn;一致 ⇒ info;两种都继续恢复', async () => {
    const a = probe({ drift: { drifted: true, verified: true, message: 'provider 漂了' } });
    const ra = await resumeRunViaKernel('r1', a.ports);
    expect(ra.ok).toBe(true);
    expect(a.calls.logs.some((l) => l.includes('恢复时模型配置已偏离'))).toBe(true);
    const b = probe({ drift: { drifted: false, verified: true, message: '一致' } });
    const rb = await resumeRunViaKernel('r1', b.ports);
    expect(rb.ok).toBe(true);
    expect(b.calls.logs.some((l) => l.includes('恢复前核对: 一致'))).toBe(true);
  });

  it('核对**抛错** ⇒ 静默跳过, 恢复照走 (与迁移前一致)', async () => {
    const { calls, ports } = probe({ driftThrows: true });
    const out = await resumeRunViaKernel('r1', ports);
    expect(out.ok).toBe(true);
    expect(calls.detect).toBe(1);
    expect(calls.run).toBe(1);
    expect(out.modelDrift).toBeUndefined();
  });
});

describe('K10 余项-B. 装配政策: 只在漂了/核对不了时装, 装失败不阻塞', () => {
  it('一致+核对过 ⇒ **一次都不装** (白跑一趟)', async () => {
    const { calls, ports } = probe({ drift: { drifted: false, verified: true } });
    const out = await resumeRunViaKernel('r1', ports);
    expect(out.ok).toBe(true);
    expect(calls.apply, '一致就不该重装').toBe(0);
    expect(out.modelApplied).toBeUndefined();
  });

  it('漂了 ⇒ 装 (并把装配结果带回来)', async () => {
    const { calls, ports } = probe({ drift: { drifted: true, verified: true, snapshot: { provider: 'p' } } });
    const out = await resumeRunViaKernel('r1', ports);
    expect(calls.apply).toBe(1);
    expect(out.modelApplied?.model).toBe('m');
  });

  it('核对不了 (verified=false) ⇒ 也装', async () => {
    const { calls, ports } = probe({ drift: { drifted: false, verified: false } });
    await resumeRunViaKernel('r1', ports);
    expect(calls.apply).toBe(1);
  });

  it('**装配抛错 ⇒ 不阻塞恢复** (ok 仍 true, modelApplied 留空, 且如实 warn)', async () => {
    const { calls, ports } = probe({ drift: { drifted: true, verified: true }, applyThrows: true });
    const out = await resumeRunViaKernel('r1', ports);
    expect(out.ok).toBe(true);
    expect(out.modelApplied).toBeUndefined();
    expect(calls.run).toBe(1);
    expect(calls.logs.some((l) => l.includes('装配运行时失败'))).toBe(true);
  });
});

describe('K10 余项-C. 准备失败早返回 · 恢复态单次语义', () => {
  it('准备失败 ⇒ ok=false + reason, **不驱动也不落态**', async () => {
    const { calls, ports } = probe({ prepareOk: false, prepareReason: 'run 不在可恢复状态' });
    const out = await resumeRunViaKernel('r1', ports);
    expect(out).toMatchObject({ ok: false, reason: 'run 不在可恢复状态' });
    expect(calls.run, '没准备成功就不该驱动').toBe(0);
    expect(calls.plan).toBe(0);
    expect(calls.clear, '没落态就不用清').toBe(0);
  });

  it('落态在驱动之前 (驱动看得见计划)', async () => {
    const order: string[] = [];
    const out = await resumeRunViaKernel('r1', {
      detectDrift: async () => ({ drifted: false, verified: true }),
      prepareResume: async () => ({ ok: true, plan: { goalId: 'g' } }),
      applySnapshot: async () => ({}),
      applyPlan: () => { order.push('plan'); },
      continueRun: async () => { order.push('run'); return 'ok'; },
      clearPlan: () => { order.push('clear'); },
    });
    expect(out.ok).toBe(true);
    expect(order).toEqual(['plan', 'run', 'clear']);
  });

  it('驱动**抛错** ⇒ 恢复态照样被清 (finally), 且错误冒出去 (与迁移前一致)', async () => {
    const { calls, ports } = probe({ runThrows: true });
    await expect(resumeRunViaKernel('r1', ports)).rejects.toThrow('驱动炸了');
    expect(calls.clear, '抛错也必须清恢复态').toBe(1);
  });
});

describe('K10 余项-D. 反回归 (源级): 内联政策不许回到 pi-sdk', () => {
  it('pi-sdk 必须调内核入口; 内联的装配判据/日志文案/核对调用必须消失', () => {
    const src = readSrc('src/agents/pi-sdk.ts');
    expect(src).toMatch(/resumeRunViaKernel\(/);
    expect(src, '内联的重装判据').not.toMatch(/if \(modelDrift && decideResumeReinstall/);
    expect(src, '内联的装配日志文案 (归内核)').not.toMatch(/已按 Run 快照装配运行时/);
    expect(src, '内联的漂移上报文案').not.toMatch(/恢复时模型配置已偏离/);
    expect(src, '内联的恢复前核对文案').not.toMatch(/恢复前核对:/);
  });
});
