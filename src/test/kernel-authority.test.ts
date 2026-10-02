/**
 * K2 模块越权门 —— **五条禁令 + 1 条派生** (Bolloon Native Macro-Kernel K0)
 *
 * 判据 (§设计页):
 *   Model 不能直接执行 Tool · Provider 不能直接写 Run · Tool 不能直接改权限 ·
 *   Channel 不能直接改 Goal · 子 Agent 不能直接结束 Goal
 *   (+ 派生) Channel 不能直接写 Run  —— 来自路线 K3「入口收口」
 *
 * 本门的两个关键设计 (否则它会变成装饰):
 *   ① 禁令落在「**写/改入口**」上, 不是「整层不许 import」——
 *      `tools → shell-guard` 只读校验是合法的; `tools → allowTool()` 才是越权。
 *      (实测证据: tools 层 import shell-guard 共 3 处, 全是只读判定 —— 若按整层禁, 门一开工就假红。)
 *   ② 台账**双向相等**: 实际违规多重集必须逐字等于 AUTHORITY_DEBT。
 *      多一条 ⇒ 红; 修掉一条却没同步减 ⇒ 也红 (强制台账与事实同步)。
 *
 * 纪律: 期望值从真实源码推导 · 判据是纯函数 · 变异每次跑测试真做 · 扫描面为空拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { AUTHORITY_DEBT, AUTHORITY_DEBT_FROZEN_AT, LAYERS, PROHIBITIONS, STAGE_STATUS, type LayerId } from '../kernel/roster.js';
import { debtDiff, groupFindings, layerOf, scanDebtPaydownStaleness, scanProhibition, type SourceFile } from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');

/** 扫描面**下限** (棘轮: 只许增)。文件被删 ⇒ 门红, 逼一次显式确认。 */
const LAYER_SCAN_MINIMUMS: Record<LayerId, number> = {
  kernel: 2,
  llm: 18,
  policy: 10,
  state: 5,
  tools: 10,
  channel: 69,
  adapter: 4,
  delegate: 6,
};

function walk(abs: string, prefix: string, out: string[]) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(abs, e.name), `${prefix}${e.name}/`, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(`${prefix}${e.name}`);
  }
}

/** 某层的真实源码面 (真读盘; 目录不存在 = 空数组, 由扫描面下限兜住) */
function filesOfLayerOnDisk(layer: LayerId): SourceFile[] {
  const spec = LAYERS.find((l) => l.id === layer);
  if (!spec) throw new Error(`名册里没有这一层: ${layer}`);
  const out: string[] = [];
  for (const p of spec.paths) {
    const abs = path.join(SRC, p);
    if (!fs.existsSync(abs)) continue;
    if (p.endsWith('/')) walk(abs, p, out);
    else out.push(p);
  }
  const rels = [...new Set(out)].sort();
  return rels.map((rel) => ({ path: rel, text: fs.readFileSync(path.join(SRC, rel), 'utf8') }));
}

/** 每条禁令涉及层的真实文件数 (防空转) */
function layerCounts(): Record<string, number> {
  const need = new Set(PROHIBITIONS.map((p) => p.fromLayer));
  const m: Record<string, number> = {};
  for (const l of need) m[l] = filesOfLayerOnDisk(l).length;
  return m;
}

const COUNTS = layerCounts();

describe('K2 扫描面自证 (门不许空转)', () => {
  it('每条禁令的 fromLayer 都有真实文件, 且不低于冻结下限', () => {
    const need = [...new Set(PROHIBITIONS.map((p) => p.fromLayer))];
    expect(need.length).toBeGreaterThan(0);
    for (const l of need) {
      expect(COUNTS[l], `层 ${l} 的扫描面为空 ⇒ 这条禁令在空转`).toBeGreaterThanOrEqual(
        LAYER_SCAN_MINIMUMS[l],
      );
    }
  });

  it('源文件的层归属判定与名册一致 (不是我手写的清单)', () => {
    const ch = filesOfLayerOnDisk('channel');
    expect(ch.length).toBeGreaterThan(0);
    expect(ch.every((f) => layerOf(f.path) === 'channel')).toBe(true);
    expect(layerOf('test/kernel-authority.test.ts')).toBeNull(); // 测试文件不在任何层
  });
});

describe('K2 禁令逐条: 实际违规 == 欠账台账 (双向相等)', () => {
  for (const p of PROHIBITIONS) {
    it(`${p.rule}${p.derivedFrom ? ' (派生)' : ''}`, () => {
      const files = filesOfLayerOnDisk(p.fromLayer);
      const findings = scanProhibition(files, p);
      const { missing, extra } = debtDiff(findings, AUTHORITY_DEBT, p.id);
      expect(missing, '实际违规未登记 (要登记就得改 AUTHORITY_DEBT, diff 里看得见)').toEqual([]);
      expect(extra, '台账里的欠账已修掉却没同步删 (台账不许烂在上面)').toEqual([]);
    });
  }
});

describe('K2 欠账棘轮', () => {
  it('欠账条数 ≤ 冻结值 (只许减不许增)', () => {
    expect(AUTHORITY_DEBT.length).toBeLessThanOrEqual(AUTHORITY_DEBT_FROZEN_AT);
  });

  it('台账每一条都指明了由哪个阶段还清 (欠账不是无主的)', () => {
    expect(AUTHORITY_DEBT.every((d) => !!d.payDownIn)).toBe(true);
  });
});

describe('K2 判别力自证 —— 每条禁令的人造违规都必须命中', () => {
  for (const p of PROHIBITIONS) {
    it(`${p.rule}: 人造违规必须命中`, () => {
      const probe: SourceFile =
        p.mode === 'import-edge'
          ? { path: `${p.fromLayer}/__probe__.ts`, text: `import { a } from '../${p.targets![0]}.js';` }
          : { path: `${p.fromLayer}/__probe__.ts`, text: (p.writeCalls as string[]).map((c) => `${c}(1,2);`).join('\n') };
      const hits = scanProhibition([probe], p);
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits.map((h) => h.what)).size).toBe(
        p.mode === 'import-edge' ? 1 : (p.writeCalls as string[]).length,
      );
    });
  }

  it('反例: 只读用法不许命中 (import 但不调用)', () => {
    const readOnly: SourceFile[] = [
      { path: 'channel/__ro__.ts', text: "const { readGoal, readRun } = await import('../agents/goal-store.js');" },
    ];
    for (const p of PROHIBITIONS.filter((x) => x.mode === 'write-call')) {
      expect(scanProhibition(readOnly, p)).toEqual([]);
    }
  });

  it('反例: 注释里的写调用不许命中', () => {
    const commented: SourceFile[] = [
      { path: 'channel/__c__.ts', text: '// setRunStatus(1,2);\n/* recordRecovery(x) */' },
    ];
    for (const p of PROHIBITIONS.filter((x) => x.mode === 'write-call')) {
      expect(scanProhibition(commented, p)).toEqual([]);
    }
  });
});

describe('K2 变异 —— 每条禁令拿真实源码注入违规必须判红', () => {
  for (const p of PROHIBITIONS) {
    it(`${p.rule}: 真实文件注入违规 ⇒ 命中数增加`, () => {
      const files = filesOfLayerOnDisk(p.fromLayer);
      const victim = files[0];
      const before = scanProhibition(files, p).length;
      const injected =
        p.mode === 'import-edge'
          ? `\nimport { a } from '../${p.targets![0]}.js';\n`
          : `\n${(p.writeCalls as string[])[0]}(1, 2);\n`;
      const mutated = files.map((f) =>
        f.path === victim.path ? { path: f.path, text: `${f.text}${injected}` } : f,
      );
      const after = scanProhibition(mutated, p).length;
      expect(after).toBeGreaterThan(before);
    });
  }

  it('变异后与台账必须不再相等 (证明这条禁令真的落在门上, 不是台账自说自话)', () => {
    const p = PROHIBITIONS.find((x) => x.id === 'model-must-not-execute-tool')!;
    const files = filesOfLayerOnDisk(p.fromLayer);
    const victim = files[0];
    const mutated = files.map((f) =>
      f.path === victim.path
        ? { path: f.path, text: `${f.text}\nimport { a } from '../${p.targets![0]}.js';\n` }
        : f,
    );
    const { missing } = debtDiff(scanProhibition(mutated, p), AUTHORITY_DEBT, p.id);
    expect(missing.length).toBeGreaterThan(0);
    // 而同一份判据在未变异的真实源码上是清的 ⇒ 门不是恒真/恒假
    expect(groupFindings(scanProhibition(files, p))).toEqual([]);
  });
});

describe('K4 欠账不许烂在账上: 排期过期 / 无还款路径 都要被抓', () => {
  it('★ 判据: 盘上台账与阶段状态一致 (无过期排期 · 每条都写明还款路径)', () => {
    expect(scanDebtPaydownStaleness(AUTHORITY_DEBT, STAGE_STATUS)).toEqual([]);
  });

  it('★ 判别力: 四种坏形状都必须判红', () => {
    const base = AUTHORITY_DEBT.map((d) => ({ ...d }));
    // ① 排期指向已收工的阶段 ⇒ 过期
    const stale = base.map((d, i) => (i === 0 ? { ...d, payDownIn: 'K5' } : d));
    expect(scanDebtPaydownStaleness(stale, STAGE_STATUS).some((f) => f.rule === 'debt-paydown-stale')).toBe(true);
    // ② 没写还款路径 ⇒ 红
    const noNote = base.map((d, i) => (i === 1 ? { ...d, note: undefined } : d));
    expect(scanDebtPaydownStaleness(noNote, STAGE_STATUS).some((f) => f.rule === 'debt-note-missing')).toBe(true);
    // ③ 没排期 ⇒ 红
    const unassigned = base.map((d, i) => (i === 2 ? { ...d, payDownIn: undefined } : d));
    expect(scanDebtPaydownStaleness(unassigned, STAGE_STATUS).some((f) => f.rule === 'debt-unassigned')).toBe(true);
    // ④ 阶段状态本身也要与事实一致: K5 已收工 ⇒ 不许写成 not-started
    expect(STAGE_STATUS.K5).toBe('done');
    expect(STAGE_STATUS.K4).not.toBe('done');   // 还没收工 ⇒ 重排到这里才是诚实的排期
  });
});
