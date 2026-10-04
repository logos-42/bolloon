/**
 * k10-turn-selfcheck.test.ts — K10 余项: 回合收尾自检的**编排与政策**归内核
 *
 * 迁移前: `runTurnEndTypecheck` 的方法体里同时有 —— 该不该跑的判据 (已抽纯函数) · 取工具 ·
 * 问 Harness 门 · fail-closed 处置 · 结果格式化 · 上报。本轮把**编排与政策**整条搬进
 * `src/kernel/turn-selfcheck.ts`, pi-sdk 只剩"取工具 / 问门 / 上报"三个端口实现 (40 行 → 26 行)。
 *
 * 判据四段 (全部对着**政策**写, 不是对着实现写):
 *   A. 该不该跑: 不需要时**一个端口都不碰**;
 *   B. 过门纪律: 允许才执行 · **被拒 ⇒ 零执行 + 可见** · 门抛错同样 fail-closed;
 *   C. 失败不伤回合: 执行抛错 ⇒ 一行"没能跑起来", 函数**从不抛**;
 *   D. 反回归 (源级): pi-sdk 里不许再出现直接执行自检工具 / 自己问门的旧形状。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTurnEndSelfCheck, TURN_SELFCHECK_TOOL, type SelfCheckPorts } from '../kernel/turn-selfcheck.js';

const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/** 端口探针: 记录每次调用, 便于断言"碰没碰" */
function probe(over: Partial<SelfCheckPorts> & { allow?: boolean; gateThrows?: boolean; execThrows?: boolean; output?: string; success?: boolean } = {}) {
  const calls = { getTool: 0, askGate: 0, execute: 0, emit: [] as string[] };
  const ports: SelfCheckPorts = {
    getTool: (name) => {
      calls.getTool += 1;
      if (over.getTool === undefined && name === TURN_SELFCHECK_TOOL) {
        return { execute: async () => { calls.execute += 1; if (over.execThrows) throw new Error('执行炸了'); return { success: over.success ?? true, output: over.output ?? '' }; } };
      }
      return undefined;
    },
    askGate: async () => {
      calls.askGate += 1;
      if (over.gateThrows) throw new Error('门自己炸了');
      return { allow: over.allow ?? true, reason: over.allow === false ? '被策略拒了' : undefined };
    },
    emit: (evt) => { calls.emit.push(evt.content); },
    ...over,
  };
  return { calls, ports };
}
const TOOL = 'tsc_check';

describe('K10 余项-A. 该不该跑: 不需要时一个端口都不碰', () => {
  it('没改过 TS ⇒ 不碰任何端口 (decided=false)', async () => {
    const { calls, ports } = probe();
    const out = await runTurnEndSelfCheck({ touched: [], ranThisTurn: false }, ports);
    expect(out).toMatchObject({ ran: false, decided: false, line: '' });
    expect(calls.getTool).toBe(0);
    expect(calls.askGate).toBe(0);
    expect(calls.emit).toHaveLength(0);
  });

  it('本回合已经跑过 ⇒ 不跑 (一轮一次, 不蹭 tsc 的秒级开销)', async () => {
    const { calls, ports } = probe();
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: true }, ports);
    expect(out.decided).toBe(false);
    expect(calls.getTool).toBe(0);
  });

  it('工具缺失 ⇒ decided=true 但安静地不做 (不报错, 与迁移前一致)', async () => {
    const { calls, ports } = probe({ getTool: () => undefined });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out).toMatchObject({ ran: false, decided: true, line: '' });
    expect(out.reason).toContain('工具缺失');
    expect(calls.emit).toHaveLength(0);
  });
});

describe('K10 余项-B. 过门纪律: 允许才执行 · 被拒 ⇒ 零执行且可见 (fail-closed)', () => {
  it('门允许 ⇒ 执行一次, 结果压成一行上屏 (通过)', async () => {
    const { calls, ports } = probe({ allow: true, output: '' });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out).toMatchObject({ ran: true, decided: true, passed: true });
    expect(calls.execute).toBe(1);
    expect(calls.emit).toHaveLength(1);
    expect(calls.emit[0]).toContain('类型检查通过');
  });

  it('门允许但检查没过 ⇒ 仍执行, 行里带错误数 (状态可见)', async () => {
    const { calls, ports } = probe({ allow: true, success: false, output: 'src/x.ts(3,1): error TS2345: boom' });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out.ran).toBe(true);
    expect(out.passed).toBe(false);
    expect(calls.emit[0]).toContain('类型检查没过');
    expect(calls.emit[0]).toContain('error TS2345');
  });

  it('**门拒绝 ⇒ 零执行 + 可见** (拒绝不许静默)', async () => {
    const { calls, ports } = probe({ allow: false });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out).toMatchObject({ ran: false, decided: true, rejected: true });
    expect(calls.execute, '被拒就不许执行').toBe(0);
    expect(calls.emit).toHaveLength(1);
    expect(calls.emit[0]).toContain('被门拒绝');
    expect(calls.emit[0]).toContain('被策略拒了');
  });

  it('门**自己抛错** ⇒ 同样 fail-closed (不执行, 且说清是 harness-error)', async () => {
    const { calls, ports } = probe({ gateThrows: true });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out.rejected).toBe(true);
    expect(calls.execute).toBe(0);
    expect(calls.emit[0]).toContain('harness-error');
  });
});

describe('K10 余项-C. 失败不伤回合: 从不抛', () => {
  it('执行抛错 ⇒ 一行"没能跑起来" + 提示自己跑一次, 函数不抛', async () => {
    const { calls, ports } = probe({ execThrows: true });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out.ran).toBe(false);
    expect(out.line).toContain('没能跑起来');
    expect(out.line).toContain('记得自己跑一次');
    expect(calls.emit).toHaveLength(1);
  });

  it('门与执行都正常但输出为空 ⇒ 也算通过 (不因空输出判失败)', async () => {
    const { ports } = probe({ allow: true, output: '', success: true });
    const out = await runTurnEndSelfCheck({ touched: ['a.ts'], ranThisTurn: false }, ports);
    expect(out.passed).toBe(true);
  });
});

describe('K10 余项-D. 反回归 (源级): 旧形状不许回到 pi-sdk', () => {
  it('pi-sdk 必须调内核入口; 自己执行自检工具 / 自己问门的旧形状必须消失', () => {
    const src = readSrc('src/agents/pi-sdk.ts');
    expect(src).toMatch(/runTurnEndSelfCheck\(/);
    expect(src, '直接取 tsc_check 工具并执行的旧形状').not.toMatch(/tools\.get\('tsc_check'\)/);
    expect(src, '内联的门调用 (tool: tsc_check) 旧形状').not.toMatch(/tool: 'tsc_check'/);
    expect(src, '旧的格式化直调 (由内核负责)').not.toMatch(/formatTypecheckResult\(r\?\.success/);
  });
});
