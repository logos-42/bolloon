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

/** 台账卫生判据 (纯函数, 只吃台账对象): 台账**不许撒谎**, 也不许写过期的行号 */
function checkHarnessLedgerHygiene(ledger: {
  execSites: readonly { file: string; why: string }[];
  bypasses: readonly { target: string; why: string; status: string; evidence?: string; replacesWith?: string }[];
  progress: { bypasses: number };
}): string[] {
  const f: string[] = [];
  const LINE_REF = /\(\s*\d{2,5}\s*[,)]|:\d{2,5}\b/;
  for (const site of ledger.execSites) {
    if (LINE_REF.test(site.why)) f.push(`${site.file} why 写了行号`);
  }
  for (const b of ledger.bypasses) {
    const who = b.target.slice(0, 44);
    if (LINE_REF.test(b.target) || LINE_REF.test(b.why)) f.push(`${who} 写了行号`);
    if (b.status === 'converged' && !b.evidence) f.push(`${who} 标 converged 却没证据`);
    if (b.status === 'open' && !b.replacesWith) f.push(`${who} 开着却没写替代路径`);
  }
  const open = ledger.bypasses.filter((b) => b.status === 'open').length;
  if (open !== ledger.progress.bypasses) f.push(`开着的旁路数 台账=${ledger.progress.bypasses} 实际=${open}`);
  return f;
}

describe('K7 台账门: Harness 唯一系统调用门', () => {
  it('① 真跑: 台账与盘上事实一致 (零 finding)', () => {
    const findings = scanHarnessLedger(REAL_LEDGER, { readFile, planFileExists });
    expect(findings.map((x) => x.what)).toEqual([]);
  });

  it('①b 台账自洽: 9 阶段 / 9 覆盖面 / 执行点合计 == 18 / 开着旁路 2', () => {
    expect(HARNESS_STAGES.map((s) => s.stage)).toEqual([...HARNESS_STAGE_ORDER]);
    expect(HARNESS_SURFACES).toHaveLength(9);
    const total = HARNESS_EXEC_SITES.reduce((n, s) => n + s.count, 0);
    expect(total).toBe(18);   // 17 普查基线 + 1 (K7 第二步 b 端口内执行)
    expect(K7_PROGRESS.bypasses).toBe(1);   // 3 → 2 (pivot) → 1 (getSkillRegistry 受门包装)
    // 2026-10-02: pivot loop + skill 两条已收敛 (skill 的公开出口 `getSkillRegistry` 另立开放条目)
    expect(K7_BYPASS_CANDIDATES.filter((b) => b.status === 'converged')).toHaveLength(3);   // pivot · skill adapter · getSkillRegistry(受门包装)
    expect(total).toBe(K7_PROGRESS.execSitesTotal);
    expect(K7_BYPASS_CANDIDATES).toHaveLength(4);   // pivot(收敛) · tscTool(开放: 端到端未取) · skill(收敛) · getSkillRegistry(**已收敛**: 受门包装)
    expect(K7_PROGRESS.bypasses).toBe(1);   // 3 → 2 → 1 (pivot loop · getSkillRegistry 均已收敛)
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
    // 注意: 这里刻意用 **+2** 而不是 +1 —— 盘上数字会随实现变化, 用 +1 时一旦盘上真的
    //   长到 ledger+1, "坏样本"就恰好等于真值 ⇒ 用例静默失效 (本仓已记过同类 6 次)。
    const bad = {
      ...REAL_LEDGER,
      execSites: HARNESS_EXEC_SITES.map((s, i) => (i === 0 ? { ...s, count: s.count + 2 } : s)),
    };
    const f = scanHarnessLedger(bad, { readFile, planFileExists });
    expect(f.some((x) => /盘上=/.test(x.what))).toBe(true);
  });

  it('② 判别力: 合计与 progress 不一致 ⇒ 红', () => {
    // 用 999 而不是"当前值±1" —— 坏样本若用接近真值的数字, 实现一变它就可能变成真值而失效。
    const bad = { ...REAL_LEDGER, progress: { ...K7_PROGRESS, execSitesTotal: 999 } };
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


  it('①c 台账卫生: 不写行号 (行号会漂) · 开着的旁路数 == progress · converged 必须带证据', () => {
    expect(checkHarnessLedgerHygiene({ execSites: HARNESS_EXEC_SITES, bypasses: K7_BYPASS_CANDIDATES, progress: K7_PROGRESS })).toEqual([]);
  });

  it('② 判别力: 台账卫生三条各自都能判红', () => {
    const good = { execSites: HARNESS_EXEC_SITES, bypasses: K7_BYPASS_CANDIDATES, progress: K7_PROGRESS };
    // ① 写了行号
    expect(checkHarnessLedgerHygiene({ ...good, execSites: [{ file: 'x.ts', why: '主执行点 (2715, 经门链)' }] })).toHaveLength(1);
    // ② converged 没证据
    const conv = [{ target: 'a', why: 'w', status: 'converged', replacesWith: 'r' }];
    expect(checkHarnessLedgerHygiene({ ...good, bypasses: conv, progress: { bypasses: 0 } })[0]).toMatch(/没证据/);
    // ③ 开着的旁路数与 progress 不符 (用 999, 不写"当前值±1"以免随事实失效)
    expect(checkHarnessLedgerHygiene({ ...good, progress: { bypasses: 999 } })[0]).toMatch(/开着的旁路数/);
  });

  it('② K1 ④ (机械, 棘轮 12 → 0): 领域 SDK 不许被工具文件直接 import —— 只能走 Tool Capability 层', () => {
    // 历史: pi-sdk-tools.ts 里 6 个工具各自动态 import 领域 SDK (dist+src 两路 = 12 处)。
    // 2026-10-02: 全部改经 `src/agents/tool-capability/index.ts`。此判据锁住"不许退回去"。
    const tools = fs.readFileSync(path.join(ROOT, 'src/agents/pi-sdk-tools.ts'), 'utf8');
    expect(tools).not.toMatch(/await import\('[^']*constraint-runtime[^']*'\)/);   // 零直连 (棘轮)
    expect(tools).toContain("from './tool-capability/index.js'");

    const cap = fs.readFileSync(path.join(ROOT, 'src/agents/tool-capability/index.ts'), 'utf8');
    // 唯一入口: 目标清单是单一事实源, 且 dist/src 两路只在这里拼
    expect(cap).toMatch(/export const DOMAIN_TARGETS = \[/);
    expect((cap.match(/^\s+'[A-Za-z]+\/[A-Za-z]+',?$/gm) || []).length).toBeGreaterThanOrEqual(6);
    expect(cap).toContain('constraint-runtime/dist/tools/');
    expect(cap).toContain('constraint-runtime/src/tools/');
    expect(cap).toContain('getLastLoadSource');           // 走了哪一路必须可观测
  });

  it('② K7 系统自检 (tsc_check) 也过门: 判定在 execute 之前 + 拒绝分支不执行 + 拒绝可见 (机械)', () => {
    const sdk = fs.readFileSync(path.join(ROOT, 'src/agents/pi-sdk.ts'), 'utf8');
    const gateIdx = sdk.indexOf("const tscTool: any = this.tools.get('tsc_check');");
    const execIdx = sdk.indexOf('const r: any = await tscTool.execute({});');
    expect(gateIdx).toBeGreaterThan(0);
    expect(execIdx).toBeGreaterThan(gateIdx);          // 判定在前
    const seg = sdk.slice(gateIdx, execIdx);
    expect(seg).toContain('beforeToolCall');
    expect(seg).toContain('if (!tscAllowed)');
    expect(seg).toContain('类型检查被门拒绝, 未执行');    // 拒绝**可见** (不许静默跳过)
  });

  it('② K7 第二步 b 接线在盘上: pivot loop 的配置里注入了同一个门 (机械)', () => {
    const sdk = fs.readFileSync(path.join(ROOT, 'src/agents/pi-sdk.ts'), 'utf8');
    // 端口必须在 pivot loop 构造之前被放进配置, 且判定走的是主路径同一个 beforeToolCall
    const portIdx = sdk.indexOf('guardedExecute: async (tool, args) =>');
    const ctorIdx = sdk.indexOf('new WorkflowPivotLoop(loopConfig)');
    expect(portIdx).toBeGreaterThan(0);
    expect(ctorIdx).toBeGreaterThan(portIdx);
    const seg = sdk.slice(portIdx, ctorIdx);
    expect(seg).toContain('this.piHarness().beforeToolCall(');
    expect(seg).toContain('permissionMode: this.currentPermissionMode');
    expect(seg).toContain('harness-error');
    // 未通过 ⇒ 拒收; 通过 ⇒ 才执行 (返 tool.execute(args))
    expect(seg).toContain('decision.allow');
    expect(seg).toContain('return tool.execute(args);');
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
