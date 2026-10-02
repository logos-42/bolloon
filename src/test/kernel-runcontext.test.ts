/**
 * K2 门: RunContext 状态外置 (棘轮 + 假完成检测)
 *
 * 防三件事:
 *   ① 往 Pi 实例上**新增**可变运行状态 (实测计数超过冻结值 ⇒ 红);
 *   ② 迁了一半不回写台账 (实测减少却不改冻结值 ⇒ 红, 迁移必须是看得见的动作);
 *   ③ 标 `migrated` 却还有 `this.` 访问 (假完成)。
 *
 * 纪律: 真读盘 · 判据是纯函数 (吃源码文本, **先剥注释**) · 变异每次跑测试真做 · 拿不到事实就拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  RUN_CONTEXT_ACCESS_TOTAL,
  RUN_CONTEXT_FIELDS,
  RUN_CONTEXT_FILES,
  RUN_CONTEXT_TARGET,
} from '../kernel/plan-runcontext.js';
import { type SourceFile, scanRunContextLeaks, stripLineComment } from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');
const SCAN: SourceFile[] = (RUN_CONTEXT_FILES as readonly string[]).map((rel) => ({
  path: rel,
  text: fs.readFileSync(path.join(SRC, rel), 'utf8'),
}));

describe('K2 门: RunContext 状态外置', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(SCAN.length).toBeGreaterThan(0);
    expect(SCAN.some((f) => f.text.length > 100000)).toBe(true);
    expect(RUN_CONTEXT_FIELDS.length).toBeGreaterThanOrEqual(8);
  });

  it('逐字段计数与冻结值双向相等 (新增泄漏或改了代码不改账都判红)', () => {
    const findings = scanRunContextLeaks(SCAN, RUN_CONTEXT_FIELDS, { target: RUN_CONTEXT_TARGET });
    expect(findings).toEqual([]);
  });

  it('冻结总量与逐字段之和一致 (台账自己不许自相矛盾)', () => {
    const sum = RUN_CONTEXT_FIELDS.reduce((n, f) => n + f.accesses, 0);
    expect(sum).toBe(RUN_CONTEXT_ACCESS_TOTAL);
  });

  it('每个字段都有 RunContext 落点, 且目标清单覆盖 leo 点名的 11 项', () => {
    for (const f of RUN_CONTEXT_FIELDS) expect(RUN_CONTEXT_TARGET).toContain(f.into);
    for (const t of ['requestId', 'channelId', 'agentId', 'goalId', 'runId', 'modelSnapshot', 'history', 'abortSignal', 'budget', 'eventSink', 'harnessContext']) {
      expect(RUN_CONTEXT_TARGET).toContain(t);
    }
  });

  it('K2 尚未开工: 当前 migrated 全为 false (不许提前标完成)', () => {
    expect(RUN_CONTEXT_FIELDS.every((f) => f.migrated === false)).toBe(true);
  });

  it('判别力自证: 三种坏形状都必须判红', () => {
    const probe: SourceFile[] = [{ path: 'agents/pi-sdk.ts', text: 'const a = this.messageHistory;\nconst b = this.currentRunId;\n' }];
    // ① 新增泄漏: 冻结 1 处, 实测 2 处
    const drift = scanRunContextLeaks(probe, [{ name: 'currentRunId', accesses: 0, into: 'runId', migrated: false }], { target: ['runId'] });
    expect(drift.some((f) => f.rule === 'runcontext-access-drift' && f.what.includes('新增泄漏'))).toBe(true);
    // ② 减少不回写台账
    const shrunk = scanRunContextLeaks(probe, [{ name: 'currentRunId', accesses: 5, into: 'runId', migrated: false }], { target: ['runId'] });
    expect(shrunk.some((f) => f.rule === 'runcontext-access-drift' && f.what.includes('必须把台账下调'))).toBe(true);
    // ③ 假完成
    const fake = scanRunContextLeaks(probe, [{ name: 'messageHistory', accesses: 1, into: 'history', migrated: true }], { target: ['history'] });
    expect(fake.some((f) => f.rule === 'runcontext-migrated-but-leaking')).toBe(true);
    // ④ 注释里的访问不算数 (剥注释)
    const commented: SourceFile[] = [{ path: 'agents/pi-sdk.ts', text: '// this.currentRunId 曾经在这里\nconst x = 1;\n' }];
    expect(scanRunContextLeaks(commented, [{ name: 'currentRunId', accesses: 0, into: 'runId', migrated: false }], { target: ['runId'] })).toEqual([]);
  });

  it('变异: 往实例上加一处 this.currentRunId 访问 ⇒ 立刻判红 (真盘同款形状)', () => {
    const mutated = SCAN.map((f, i) => (i === 0 ? { ...f, text: `${f.text}\nconst __probe = this.currentRunId;\n` } : f));
    const findings = scanRunContextLeaks(mutated, RUN_CONTEXT_FIELDS, { target: RUN_CONTEXT_TARGET });
    expect(findings.some((f) => f.rule === 'runcontext-access-drift' && f.file === 'currentRunId')).toBe(true);
    // 同一判据在真实盘上是干净的
    expect(scanRunContextLeaks(SCAN, RUN_CONTEXT_FIELDS, { target: RUN_CONTEXT_TARGET })).toEqual([]);
  });
});
