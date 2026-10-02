/**
 * K1 门 —— constraint-runtime 三层分类 (leo 修订版 K1 第 ① 步: 统计真实 import 并分类)
 *
 * 判据 (对着 leo 的 K1 完成标准):
 *   · Kernel 只依赖 **A 类**(primitives) —— A 类每条都要有**接入说明**, 没证据的登记为 `unused-debt`;
 *   · **B 类**(Wallet/Safe/Polymarket/OpenCLI) 只能经 **Tool Capability** 接入 ⇒ 今天被主仓直连的量登记为欠账;
 *   · **C 类**不再被主仓 import ⇒ 立门, 现在 0 条, 多一条就红;
 *   · 现有测试继续全绿 (由 pre-commit / 全量另跑, 不在本门).
 *
 * 纪律: 真读盘 · 判据是纯函数 · 变异每次跑测试真做 · 扫描面为空拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  A_ENTRY_USES,
  A_UNUSED_DEBT_FROZEN_AT,
  B_DIRECT_IMPORT_DEBT,
  B_DIRECT_IMPORT_FROZEN_AT,
  CONSTRAINT_CLASS_FILES,
  CONSTRAINT_CLASS_LINES,
  CONSTRAINT_DIST_FILES,
  CONSTRAINT_DIST_LINES,
  CONSTRAINT_DIST_DATA_JSON,
  CONSTRAINT_NON_SOURCE,
  CONSTRAINT_ROOT,
  CONSTRAINT_RULES,
  CONSTRAINT_SRC_FILES,
  CONSTRAINT_SRC_LINES,
  CONSTRAINT_STUB_FILES,
  CONSTRAINT_STUB_LINES,
  CONSTRAINT_SCAN_EXCLUSIONS,
  CONSTRAINT_USES,
} from '../kernel/plan-constraint.js';
import {
  type SourceFile,
  constraintClassOf,
  scanConstraintCoverage,
  scanConstraintUses,
  constraintUseDiff,
  scanConstraintViolations,
} from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');

/** src/ 下全部 .ts/.tsx (含 test/ 与 constraint-runtime/; 判据自己按需过滤) */
function allFiles(): SourceFile[] {
  const out: string[] = [];
  const walk = (abs: string, prefix: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), `${rel}/`);
      else if ((e.name.endsWith('.ts') || e.name.endsWith('.tsx')) && !e.name.endsWith('.d.ts')) out.push(rel);
      else if (e.name.endsWith('.d.ts') && !e.name.endsWith('node_modules')) out.push(rel);
    }
  };
  walk(SRC, '');
  return [...new Set(out)].sort().map((r) => ({ path: r, text: fs.readFileSync(path.join(SRC, r), 'utf8') }));
}

const ALL = allFiles();
/** 台账扫描面 = 全部文件 **减去** 本门自己的测试 (那里有人造引用探针串, 不排掉就会被当成真引用) */
const EXCL_RE = CONSTRAINT_SCAN_EXCLUSIONS.map((g) => new RegExp('^' + g.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*') + '$'));
const USE_SURFACE = ALL.filter((f) => !EXCL_RE.some((re) => re.test(f.path)));
/** constraint-runtime 下**非注释**的源码文件 (相对 constraint-runtime/) */
const CR_SRC = ALL.filter((f) => f.path.startsWith(CONSTRAINT_ROOT))
  .map((f) => f.path.slice(CONSTRAINT_ROOT.length))
  .filter((r) => !CONSTRAINT_NON_SOURCE.some((p) => r.startsWith(p)));
const CR_DIST = ALL.filter((f) => f.path.startsWith(CONSTRAINT_ROOT))
  .map((f) => f.path.slice(CONSTRAINT_ROOT.length))
  .filter((r) => r.startsWith('dist/'));
const CR_USES_PROD = scanConstraintUses(USE_SURFACE, CONSTRAINT_ROOT).filter((u) => u.kind === 'prod');

describe('K1-a constraint-runtime 三层分类覆盖', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(CR_SRC.length).toBeGreaterThan(50);
  });

  it('每个源码文件恰好命中一条规则 (0 个未分类)', () => {
    expect(scanConstraintCoverage(CR_SRC, CONSTRAINT_RULES)).toEqual([]);
  });

  it('冻结量一致: 源码文件数/行数 + 各层文件数/行数', () => {
    expect(CR_SRC.length).toBe(CONSTRAINT_SRC_FILES);
    const lines = CR_SRC.reduce((n, r) => n + fs.readFileSync(path.join(SRC, CONSTRAINT_ROOT, r), 'utf8').split('\n').length, 0);
    expect(lines).toBe(CONSTRAINT_SRC_LINES);
    const byCls: Record<string, number> = {};
    const linesByCls: Record<string, number> = {};
    for (const r of CR_SRC) {
      const rule = constraintClassOf(r, CONSTRAINT_RULES)!;
      byCls[rule.cls] = (byCls[rule.cls] ?? 0) + 1;
      linesByCls[rule.cls] = (linesByCls[rule.cls] ?? 0)
        + fs.readFileSync(path.join(SRC, CONSTRAINT_ROOT, r), 'utf8').split('\n').length;
    }
    expect(byCls).toEqual({ ...CONSTRAINT_CLASS_FILES });
    expect(linesByCls).toEqual({ ...CONSTRAINT_CLASS_LINES });
  });

  it('空壳 (≤20 行 index.ts) 计数冻结 —— 它们是第一批清理的直接对象', () => {
    const stubs = CR_SRC.filter((r) => r.endsWith('index.ts')
      && fs.readFileSync(path.join(SRC, CONSTRAINT_ROOT, r), 'utf8').split('\n').length <= 20);
    expect(stubs.length).toBe(CONSTRAINT_STUB_FILES);
    expect(CR_DIST.length).toBe(CONSTRAINT_DIST_FILES);
    expect(CR_DIST.reduce((n, r) => n + fs.readFileSync(path.join(SRC, CONSTRAINT_ROOT, r), 'utf8').split('\n').length, 0))
      .toBe(CONSTRAINT_DIST_LINES);
  });

  it('K1-e dist 存在则必须完整 (抓"tsc 不复制 json"造成的静默降级)', () => {
    // 背景: CR 的 build 只跑 tsc。`rm -rf dist && tsc` 会静默丢掉 reference_data/*.json,
    // 而 tools.ts/commands.ts 启动时读它们 → PORTED_TOOLS 从 184 条变 0 (只有一行 warn, 无报错)。
    // 判据: dist 在, 就必须带着快照数据; 拿不到 dist 就不判 (本地无构建的干净克隆不背这个锅)。
    const distDir = path.join(SRC, CONSTRAINT_ROOT, 'dist');
    if (!fs.existsSync(distDir)) return;
    const dataDir = path.join(distDir, 'reference_data');
    expect(fs.existsSync(dataDir)).toBe(true);
    const data = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
    const sub = path.join(dataDir, 'subsystems');
    const subs = fs.existsSync(sub) ? fs.readdirSync(sub).filter((f) => f.endsWith('.json')) : [];
    expect(data.length + subs.length).toBe(CONSTRAINT_DIST_DATA_JSON);
    // 与源侧对齐: 源侧 reference_data 的 json 必须都在 dist 侧存在 (只多不少)
    const srcData = path.join(SRC, CONSTRAINT_ROOT, 'src', 'reference_data');
    const srcFiles = fs.readdirSync(srcData).filter((f) => f.endsWith('.json'));
    for (const f of srcFiles) expect(fs.existsSync(path.join(dataDir, f))).toBe(true);
  });

  it('判别力自证: 未登记路径必须报未分类', () => {
    const probe = ['src/nowhere/ghost.ts'];
    const hits = scanConstraintCoverage(probe, CONSTRAINT_RULES);
    expect(hits.length).toBe(1);
    expect(hits[0].what).toBe('未分类');
  });

  it('变异: 真实文件改名成未登记目录 ⇒ 覆盖门红', () => {
    const mutated = CR_SRC.map((r) => (r === CR_SRC[0] ? 'src/brand-new-subsystem/x.ts' : r));
    expect(scanConstraintCoverage(mutated, CONSTRAINT_RULES).length).toBeGreaterThan(0);
  });
});

describe('K1-b 主仓引用台账 (逐字相等)', () => {
  it('重算的主仓引用点与台账双向相等', () => {
    const actual = scanConstraintUses(USE_SURFACE, CONSTRAINT_ROOT);
    const { extra, missing } = constraintUseDiff(actual, CONSTRAINT_USES);
    expect(missing, '台账里有但盘上扫不到 (台账过期)').toEqual([]);
    expect(extra, '盘上有但台账没登记 (新引用点!)').toEqual([]);
  });

  it('台账里每条都标了 A/B (C 类不该出现在台账里)', () => {
    expect(CONSTRAINT_USES.every((u) => u.cls === 'A' || u.cls === 'B')).toBe(true);
    // 排除名单本身也是冻结面: 只有本门自己的测试文件
    expect([...CONSTRAINT_SCAN_EXCLUSIONS]).toEqual(['test/kernel-*.test.ts']);
    expect(CONSTRAINT_USES.some((u) => u.kind === 'prod')).toBe(true);
    expect(CONSTRAINT_USES.some((u) => u.kind === 'test')).toBe(true);
  });

  it('判别力自证: 人造 prod 引用必须被扫出来', () => {
    const probe: SourceFile[] = [{ path: 'web/fake.ts', text: "import { x } from '../constraint-runtime/src/tools/SafeSDK/deploySafe.js';\n" }];
    const uses = scanConstraintUses(probe, CONSTRAINT_ROOT);
    expect(uses.length).toBe(1);
    expect(uses[0].target).toBe('tools/SafeSDK/deploySafe');
    expect(uses[0].kind).toBe('prod');
  });
});

describe('K1-c 越界引用 (C 类不许被 prod import · B 类只能经 Capability)', () => {
  it('C 类被 prod 引用 = 0 (立门防未来)', () => {
    const { cViolations } = scanConstraintViolations(CR_USES_PROD, CONSTRAINT_RULES);
    expect(cViolations).toEqual([]);
  });

  it('B 类被主仓直连的欠账与登记一致, 且不超过冻结值', () => {
    const { bDebt } = scanConstraintViolations(CR_USES_PROD, CONSTRAINT_RULES);
    const total = bDebt.reduce((n, u) => n + u.count, 0);
    expect(total).toBeLessThanOrEqual(B_DIRECT_IMPORT_FROZEN_AT);
    expect(B_DIRECT_IMPORT_DEBT.reduce((n, d) => n + d.count, 0)).toBe(total);
    expect(B_DIRECT_IMPORT_DEBT.every((d) => d.payDownIn === 'K7')).toBe(true);
  });

  it('A 类每条都有接入说明; 无证据的条数不超过冻结值 (棘轮只许减)', () => {
    const keys = CONSTRAINT_RULES.filter((r) => r.cls === 'A' && r.key !== '__pkg_entry__').map((r) => r.key);
    const covered = A_ENTRY_USES.filter((a) => keys.some((k) => a.key === k));
    expect(covered.length).toBe(keys.length);
    expect(A_ENTRY_USES.filter((a) => a.usedVia === 'unused-debt').length).toBeLessThanOrEqual(A_UNUSED_DEBT_FROZEN_AT);
  });

  it('判别力自证: 人造 C 类 prod 引用必须判红', () => {
    const fake = [{ file: 'agents/x.ts', target: 'remote_runtime', count: 1, kind: 'prod' as const }];
    const { cViolations } = scanConstraintViolations(fake, CONSTRAINT_RULES);
    expect(cViolations.length).toBe(1);
    expect(cViolations[0].rule).toBe('constraint-c-imported-by-prod');
  });

  it('变异: 给真实引用面加一条 C 类 import ⇒ 越界门红', () => {
    const actual = scanConstraintUses(USE_SURFACE, CONSTRAINT_ROOT);
    const injected = [...actual, { file: 'agents/pi-sdk.ts', target: 'remote/ssh', count: 1, kind: 'prod' as const }];
    const { cViolations } = scanConstraintViolations(injected, CONSTRAINT_RULES);
    expect(cViolations.length).toBeGreaterThan(0);
    expect(scanConstraintViolations(actual, CONSTRAINT_RULES).cViolations).toEqual([]);
  });
});
