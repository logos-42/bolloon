/**
 * k10-run-lifecycle-port.test.ts — K10 ①: **运行生命周期写口**
 *
 * 这一条钉住两件事:
 *   A. **端口本身** (照 control.ts 的形状): 未注入即拒 · 派发原样透出 · 端口 `{ok:false}` 归一化成"被拒" ·
 *      校验 (未知 op / 缺 origin / 缺 runId) · 审计流水 · `assertLifecycleOk` 把没落盘变成抛。
 *   B. **接线不许退化**: pi-sdk 那三处 (回退路径落 run 事实) **只能经端口**, 不许再直接调
 *      `startRun(` / `recordStep(` / `finishRun(` —— 这是最容易在后续批次里被改回去的一处。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RUN_LIFECYCLE_OPS,
  RUN_LIFECYCLE_NEEDS_RUN_ID,
  submitRunLifecycle,
  runLifecycleAudit,
  resetRunLifecycleAudit,
  assertLifecycleOk,
  type RunLifecyclePorts,
} from '../kernel/run-lifecycle.js';

beforeEach(() => resetRunLifecycleAudit());

describe('K10-A. 端口: 未注入即拒 / 派发 / 归一化 / 校验 / 审计', () => {
  it('未注入端口 ⇒ 每个 op 都拒 (不静默降级), detail 指明缺哪个 port', async () => {
    for (const op of RUN_LIFECYCLE_OPS) {
      const out = await submitRunLifecycle({ op, origin: 'test', runId: 'r1', payload: {} }, {});
      expect(out.ok, `${op} 未注入时必须拒`).toBe(false);
      expect(out.detail).toMatch(/port 未注入/);
      expect(out.via).toBe('kernel-run-lifecycle');
    }
  });

  it('派发: 四种 op 各走自己的 port, 入参与返回值原样透出', async () => {
    const seen: Record<string, unknown> = {};
    const ports: RunLifecyclePorts = {
      startRun: async (p) => { seen.startRun = p; return { runId: 'run-1' }; },
      recordStep: async (r, s) => { seen.recordStep = { r, s }; return { ok: true, seq: 3 }; },
      finishRun: async (r, p) => { seen.finishRun = { r, p }; return { status: 'needs_human' }; },
      saveCheckpoint: async (r, p) => { seen.saveCheckpoint = { r, p }; return { ok: true }; },
    };
    const a = await submitRunLifecycle({ op: 'start-run', origin: 'test', payload: { goal: 'g' } }, ports);
    expect(a.ok).toBe(true);
    expect((a.result as any).runId, 'start-run 的 runId 从 result 取').toBe('run-1');
    expect(a.port).toBe('startRun');

    const b = await submitRunLifecycle({ op: 'record-step', origin: 'test', runId: 'run-1', payload: { tool: 'llm' } }, ports);
    expect(b.ok).toBe(true);
    expect((b.result as any).seq).toBe(3);
    expect(seen.recordStep).toEqual({ r: 'run-1', s: { tool: 'llm' } });

    const c = await submitRunLifecycle({ op: 'finish-run', origin: 'test', runId: 'run-1', payload: { status: 'needs_human' } }, ports);
    expect(c.ok).toBe(true);
    expect(seen.finishRun).toEqual({ r: 'run-1', p: { status: 'needs_human' } });

    const d = await submitRunLifecycle({ op: 'save-checkpoint', origin: 'test', runId: 'run-1', payload: { iter: 2 } }, ports);
    expect(d.ok).toBe(true);
    expect(seen.saveCheckpoint).toEqual({ r: 'run-1', p: { iter: 2 } });
  });

  it('端口用 `{ok:false}` 表达拒绝 ⇒ 判"被拒"而不是成功 (归一化)', async () => {
    const ports: RunLifecyclePorts = {
      finishRun: async () => ({ ok: false, reason: '状态迁移不合法: completed → running' }),
    };
    const out = await submitRunLifecycle({ op: 'finish-run', origin: 'test', runId: 'r1' }, ports);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('端口拒绝');
    expect(out.detail).toContain('状态迁移不合法');
  });

  it('端口抛异常 ⇒ 判失败且 detail 带原文 (不吞)', async () => {
    const ports: RunLifecyclePorts = { recordStep: async () => { throw new Error('磁盘满 ENOSPC'); } };
    const out = await submitRunLifecycle({ op: 'record-step', origin: 'test', runId: 'r1' }, ports);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('ENOSPC');
  });

  it('校验: 未知 op / 缺 origin / 缺 runId; start-run 例外(不需要 runId)', async () => {
    const ports: RunLifecyclePorts = { startRun: async () => ({ runId: 'x' }) };
    expect((await submitRunLifecycle({ op: 'nope' as any, origin: 't' }, ports)).detail).toMatch(/未知写入类型/);
    expect((await submitRunLifecycle({ op: 'start-run', origin: '' }, ports)).detail).toMatch(/origin/);
    for (const op of RUN_LIFECYCLE_OPS.filter((o) => RUN_LIFECYCLE_NEEDS_RUN_ID[o])) {
      expect((await submitRunLifecycle({ op, origin: 't' }, ports)).detail).toMatch(/缺少 runId/);
    }
    const ok = await submitRunLifecycle({ op: 'start-run', origin: 't' }, ports);
    expect(ok.ok, 'start-run 的 runId 是结果, 不该当入参校验').toBe(true);
  });

  it('审计流水: op / origin / target / ok 都留下', async () => {
    const ports: RunLifecyclePorts = { finishRun: async () => ({ ok: false, reason: 'no' }) };
    await submitRunLifecycle({ op: 'finish-run', origin: 'pi-session', runId: 'run-9' }, ports);
    const a = runLifecycleAudit();
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ op: 'finish-run', origin: 'pi-session', target: 'run-9', ok: false });
  });

  it('assertLifecycleOk: ok ⇒ 不抛; 未落盘 ⇒ 抛且说明"这次运行在事实层面不存在"', () => {
    expect(() => assertLifecycleOk({ ok: true, op: 'finish-run', via: 'kernel-run-lifecycle' })).not.toThrow();
    expect(() => assertLifecycleOk({ ok: false, op: 'finish-run', via: 'kernel-run-lifecycle', detail: '磁盘满' }))
      .toThrow(/finish-run 未落盘.*磁盘满.*事实层面不存在/s);
  });
});

describe('K10-B. 接线不许退化: pi-sdk 的那三处只许经端口', () => {
  it('回退路径的 run 事实写入不再直接调 run-store 的 startRun/recordStep/finishRun', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf8');
    // 只许作为**端口注入**出现 (即 `startRun as unknown as ...` 这种), 不许出现 `await startRun(` 这类直接调用
    expect(src, '不许直接 await startRun(').not.toMatch(/await\s+startRun\(/);
    expect(src, '不许直接 await recordStep(').not.toMatch(/await\s+recordStep\(/);
    expect(src, '不许直接 await finishRun(').not.toMatch(/await\s+finishRun\(/);
    // 反向: 三处必须经端口 (三条都有 assert, 保证"写不进就响亮失败")
    const viaPort = (src.match(/submitRunLifecycle\(/g) || []).length;
    const asserts = (src.match(/assertLifecycleOk\(/g) || []).length;
    expect(viaPort, '三处写入都该经 submitRunLifecycle').toBeGreaterThanOrEqual(3);
    expect(asserts, '每次经端口都要 assert (不然写不进会被静默吞)').toBeGreaterThanOrEqual(3);
  });
});
