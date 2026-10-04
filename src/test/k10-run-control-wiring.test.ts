/**
 * k10-run-control-wiring.test.ts — K10 ①(收尾) : run 状态迁移经**内核控制面**
 *
 * 这一条钉住两件事:
 *   A. **真调方法体**: `PiAgentSession.safeSetRunStatus` (私有, 运行时存在) 三态行为**保真** ——
 *      成功 ⇒ true · **被拒**(状态迁移不合法) ⇒ false 且**不许写降级**(那本来就不是持久化故障) ·
 *      端口未注入 ⇒ false **且写降级**(才算持久化失败, 与旧实现同款)。
 *   B. **反回归**: pi-sdk 不许再直接 `await setRunStatus(`; 必须经 `submitRunControl(kind: 'set-run-status')`。
 *
 * 隔离注意: 降级会写 `~/.bolloon/runs/**` ⇒ 本条把 HOME 指到临时目录 (runsDir() 每次调用时解析)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpHome: string;
let PiAgentSession: any;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'k10rc-'));
  process.env.HOME = tmpHome;                    // 降级写进临时 HOME, 不碰真实数据
  const mod = await import('../agents/pi-sdk.js');
  PiAgentSession = mod.PiAgentSession;
});

afterAll(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

/** 造一个"只提供 runControlPorts"的 this —— 直接驱动真实方法体, 不构造整个 session */
function fakeThis(ports: any) {
  return { runControlPorts: () => ports, persistenceFailure: undefined as string | undefined };
}

describe('K10 ①-A. safeSetRunStatus 三态行为保真 (真方法体)', () => {
  it('成功 ⇒ true', async () => {
    const self = fakeThis({ setRunStatus: async () => ({ ok: true }) });
    const r = await PiAgentSession.prototype.safeSetRunStatus.call(self, 'run-1', 'done');
    expect(r).toBe(true);
    expect(self.persistenceFailure, '成功不该记故障').toBeUndefined();
  });

  it('被拒 (非法迁移) ⇒ false 且 **不写降级** (口径: 那不是持久化故障)', async () => {
    const self = fakeThis({ setRunStatus: async () => ({ ok: false, reason: '非法状态迁移 done → running' }) });
    const r = await PiAgentSession.prototype.safeSetRunStatus.call(self, 'run-1', 'running');
    expect(r).toBe(false);
    expect(self.persistenceFailure, '被拒 ≠ 持久化失败 ⇒ 不许写降级').toBeUndefined();
  });

  it('端口未注入 ⇒ false **且写降级** (持久化失败要留痕)', async () => {
    const self = fakeThis({});
    const r = await PiAgentSession.prototype.safeSetRunStatus.call(self, 'run-1', 'needs_human');
    expect(r).toBe(false);
    expect(self.persistenceFailure, '未注入 = 写不进去 ⇒ 必须留痕').toMatch(/状态迁移失败/);
    expect(self.persistenceFailure).toMatch(/setRunStatus/);
  });
});

describe('K10 ①-B. 反回归: 状态迁移不许绕过控制面', () => {
  it('pi-sdk 不再直接 await setRunStatus( ; 必须经 submitRunControl 的 set-run-status', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf8');
    expect(src, '不许直接 await setRunStatus(').not.toMatch(/await\s+setRunStatus\(/);
    expect(src).toMatch(/submitRunControl\(/);
    expect(src).toMatch(/kind:\s*'set-run-status'/);
    expect(src).toMatch(/runControlPorts\(\): RunControlPorts/);
  });
});
