/**
 * kernel-harness.test.ts — K7 台账门 (Harness 唯一系统调用门 · 第一步: 台账与执行点普查)
 *
 * 两步:
 *  ① **真跑**: 用盘上真台账 + 真文件跑 `scanHarnessLedger`, 必须零 finding
 *     (即"台账 == 盘上事实"; 任一文件读不出来 ⇒ 判据按拒跑处理, 这里必须报红)
 *  ② **判别力**: 注入坏台账 (缺阶段/乱序/改数/假旁路/半搬状态) 必须判红
 *     —— 只说"实测这次绿了"不算, 坏形状要能证明会被抓到。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanHarnessLedger, countHarnessExecSites, stripJsComments, HARNESS_STAGE_ORDER } from '../kernel/gate-scan.js';
import {
  HARNESS_STAGES, HARNESS_SURFACES, HARNESS_EXEC_SITES, K7_BYPASS_CANDIDATES, K7_PROGRESS,
} from '../kernel/plan-harness.js';

const ROOT = process.cwd();
const readFile = (rel: string): string | null => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const planFileExists = fs.existsSync(path.join(ROOT, 'src/kernel/plan-harness.ts'));

const REAL_LEDGER = {
  stages: HARNESS_STAGES,
  surfaces: HARNESS_SURFACES,
  execSites: HARNESS_EXEC_SITES,
  bypasses: K7_BYPASS_CANDIDATES,
  progress: K7_PROGRESS,
};

describe('K7 台账门: Harness 唯一系统调用门', () => {
  it('① 真跑: 台账与盘上事实一致 (零 finding)', () => {
    const findings = scanHarnessLedger(REAL_LEDGER, { readFile, planFileExists });
    expect(findings.map((x) => x.what)).toEqual([]);
  });

  it('①b 台账自洽: 9 阶段 / 9 覆盖面 / 执行点合计 == 17 / 旁路 3', () => {
    expect(HARNESS_STAGES.map((s) => s.stage)).toEqual([...HARNESS_STAGE_ORDER]);
    expect(HARNESS_SURFACES).toHaveLength(9);
    const total = HARNESS_EXEC_SITES.reduce((n, s) => n + s.count, 0);
    expect(total).toBe(17);
    expect(total).toBe(K7_PROGRESS.execSitesTotal);
    expect(K7_BYPASS_CANDIDATES).toHaveLength(3);
    expect(K7_PROGRESS.bypasses).toBe(3);
  });

  it('①c 口径: 注释里的 .execute 不算执行点 (块注释 + 行注释都要剥)', () => {
    const withBlock = '/**\n * 例: tool.execute(args)\n * 例: mcp.executeTool(x)\n */\nconst a = 1;';
    expect(countHarnessExecSites(withBlock)).toBe(0);
    const withLine = 'const a = 1; // 旧写法 tool.execute(args)\nexecuteTool;';
    // 行注释里的剥掉, 真代码里的 executeTool 保留 ⇒ 1
    expect(countHarnessExecSites(withLine)).toBe(1);
    const real = 'await tool.execute({});\nconst r = await mcp.executeTool(t, a);';
    expect(countHarnessExecSites(real)).toBe(2);
    expect(stripJsComments('/* x\ny */\nz')).toContain('z');
  });

  it('② 判别力: 少一个阶段 ⇒ 红', () => {
    const bad = { ...REAL_LEDGER, stages: HARNESS_STAGES.slice(0, 8) };
    expect(scanHarnessLedger(bad, { readFile, planFileExists }).length).toBeGreaterThan(0);
  });

  it('② 判别力: 阶段顺序颠倒 ⇒ 红', () => {
    const swapped = [HARNESS_STAGES[1], HARNESS_STAGES[0], ...HARNESS_STAGES.slice(2)];
    const bad = { ...REAL_LEDGER, stages: swapped };
    const f = scanHarnessLedger(bad, { readFile, planFileExists });
    expect(f.some((x) => /顺序/.test(x.what))).toBe(true);
  });

  it('② 判别力: 执行点数被改 (盘上没改) ⇒ 红', () => {
    const bad = {
      ...REAL_LEDGER,
      execSites: HARNESS_EXEC_SITES.map((s, i) => (i === 0 ? { ...s, count: s.count + 1 } : s)),
    };
    const f = scanHarnessLedger(bad, { readFile, planFileExists });
    expect(f.some((x) => /台账=/.test(x.what))).toBe(true);
  });

  it('② 判别力: 合计与 progress 不一致 ⇒ 红', () => {
    const bad = { ...REAL_LEDGER, progress: { ...K7_PROGRESS, execSitesTotal: 18 } };
    const f = scanHarnessLedger(bad, { readFile, planFileExists });
    expect(f.some((x) => /普查合计/.test(x.what))).toBe(true);
  });

  it('② 判别力: 登记旁路却没写替代路径 / 普查里没 bypass ⇒ 红', () => {
    const bad1 = {
      ...REAL_LEDGER,
      bypasses: K7_BYPASS_CANDIDATES.map((b, i) => (i === 0 ? { ...b, replacesWith: '' } : b)),
    };
    expect(scanHarnessLedger(bad1, { readFile, planFileExists }).some((x) => /替代路径/.test(x.what))).toBe(true);

    const bad2 = {
      ...REAL_LEDGER,
      execSites: HARNESS_EXEC_SITES.map((s) => ({ ...s, kinds: s.kinds.filter((k) => k !== 'bypass') })),
    };
    expect(scanHarnessLedger(bad2, { readFile, planFileExists }).some((x) => /没有任何条目标 bypass/.test(x.what))).toBe(true);
  });

  it('② 判别力: gate 指向不存在的文件 ⇒ 红', () => {
    const bad = {
      ...REAL_LEDGER,
      stages: HARNESS_STAGES.map((s, i) => (i === 1 ? { ...s, gate: 'agents/does-not-exist.ts' } : s)),
    };
    expect(scanHarnessLedger(bad, { readFile, planFileExists }).some((x) => /不存在/.test(x.what))).toBe(true);
  });

  it('② 判别力: 说"未开始"但台账文件已在盘上 ⇒ 红 (半搬状态)', () => {
    const bad = { ...REAL_LEDGER, progress: { ...K7_PROGRESS, stage: 'not-started' } };
    expect(scanHarnessLedger(bad, { readFile, planFileExists }).some((x) => /半搬状态/.test(x.what))).toBe(true);
  });

  it('② 判别力: 普查里的文件读不出来 ⇒ 拒跑 (红, 不是跳过)', () => {
    const blind = (rel: string) => (rel.includes('pi-sdk.ts') ? null : readFile(rel));
    const f = scanHarnessLedger(REAL_LEDGER, { readFile: blind, planFileExists });
    expect(f.some((x) => /拒跑/.test(x.what))).toBe(true);
  });
});
