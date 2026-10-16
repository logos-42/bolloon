/**
 * k10-run-control-wiring.test.ts — K10 ①(收尾) : run 状态迁移经**内核写口**
 *
 * 2026-10-16 同步 (并行线 3a5e3b4 把 safeSetRunStatus/runControlPorts 当死代码删了, 测试未同步):
 *   run 状态迁移的**事实写口**已从 control.ts 的 `submitRunControl(kind:'set-run-status')`
 *   演进为 kernel/run-lifecycle.ts 的 `submitRunLifecycle(op:'finish-run')` —— 语义同:
 *   未注入即拒 (不静默降级) · 端口 `{ok:false}` 拒绝要归一化 (被拒 ≠ 成功, 也不写降级)。
 *   本文件据此更新: 三态行为测 finish-run 端口的归一化, 反回归断言改认 submitRunLifecycle。
 *
 * 隔离注意: 降级会写 `~/.bolloon/runs/**` ⇒ 本条把 HOME 指到临时目录 (runsDir() 每次调用时解析)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { submitRunLifecycle, assertLifecycleOk } from '../kernel/run-lifecycle.js';

let tmpHome: string;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'k10rc-'));
  process.env.HOME = tmpHome;                    // 降级写进临时 HOME, 不碰真实数据
});

afterAll(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe('K10 run 状态迁移: finish-run 端口三态行为保真 (真方法体回调)', () => {
  it('成功 ⇒ ok:true', async () => {
    const ports = { finishRun: async () => ({ ok: true }) };
    const out = await submitRunLifecycle(
      { op: 'finish-run', origin: 'pi-session', runId: 'r1', payload: { status: 'done' } },
      ports as any,
    );
    expect(assertLifecycleOk(out)).toBeUndefined();
    expect(out.ok).toBe(true);
  });

  it('被拒 (非法迁移) ⇒ ok:false 且拒绝被归一化 (不是静默成功)', async () => {
    const ports = { finishRun: async () => ({ ok: false, reason: '非法状态迁移 done → running' }) };
    const out = await submitRunLifecycle(
      { op: 'finish-run', origin: 'pi-session', runId: 'r1', payload: { status: 'running' } },
      ports as any,
    );
    expect(out.ok).toBe(false);
    expect(String(out.detail || '')).toContain('端口拒绝'); // 拒绝被归一化, 不是静默成功
  });

  it('端口未注入 ⇒ ok:false 且写明未注入 (持久化失败要留痕)', async () => {
    const out = await submitRunLifecycle(
      { op: 'finish-run', origin: 'pi-session', runId: 'r1', payload: { status: 'done' } },
      {} as any, // 未注入 finishRun
    );
    expect(out.ok).toBe(false);
    expect(String(out.detail || '')).toMatch(/port 未注入|未注入/);
  });
});

describe('K10 反回归: run 状态迁移不许绕过内核写口', () => {
  it('pi-sdk 不再直接 await setRunStatus( ; 必须经 submitRunLifecycle 的 finish-run', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf8');
    expect(src, '不许直接 await setRunStatus(').not.toMatch(/await\s+setRunStatus\(/);
    expect(src).toMatch(/submitRunLifecycle\(/);
    expect(src).toMatch(/op: 'finish-run'/);
    expect(src).toMatch(/import \{ submitRunLifecycle/);
  });
});