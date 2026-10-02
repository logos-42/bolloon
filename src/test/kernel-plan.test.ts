/**
 * K4/K5/K6 —— K0 ②③④ 三道门 (模块 owner · 入口调用关系图 · 旧代码删除台账)
 *
 * 这三道门回答 leo 修订版 K0 的三个结束标准:
 *   ② 「能明确说明每段代码属于哪个模块」   → 门枚举 src/ 每个产品码文件, 必须**恰好**命中一个 owner
 *   ③ 「入口调用关系图」                  → 门重扫全仓 `prompt*(` 调用点, 多重集必须与 ENTRY_GRAPH 相等
 *   ④ 「能明确说明哪些代码准备删除」       → 候选集由**集合 sha256** 冻结; 删除记录 8 字段缺一判红
 *
 * 纪律 (与 K1/K2/K3 同款): 真读盘 · 判据是纯函数 · 变异每次跑测试真做 · 拿不到事实就拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  DELETION_CANDIDATE_COUNT,
  DELETION_CANDIDATE_DIRS,
  DELETION_CANDIDATE_SHA256,
  DELETION_LEDGER,
  ENTRY_DIRECT_CALLS_FROZEN_AT,
  ENTRY_GRAPH,
  MODULE_OWNERS,
  OUT_OF_SCOPE_ROOTS,
} from '../kernel/plan.js';
import {
  type SourceFile,
  deletionCandidates,
  entryGraphDiff,
  ownerOfFile,
  scanEntrySites,
  scanOwnerCoverage,
  scanOwnerPromises,
  validateDeletionRecord,
} from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');

/** 产品码 = src/**.ts 去掉 test/ 与 constraint-runtime/ (各有自己的册子) */
function productFiles(): SourceFile[] {
  const out: string[] = [];
  const walk = (abs: string, prefix: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), `${rel}/`);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(rel);
      else if (e.name.endsWith('.tsx')) out.push(rel);
    }
  };
  walk(SRC, '');
  const rels = out
    .filter((r) => !OUT_OF_SCOPE_ROOTS.some((p) => r.startsWith(p)))
    .sort();
  return rels.map((r) => ({ path: r, text: fs.readFileSync(path.join(SRC, r), 'utf8') }));
}

const PRODUCTS = productFiles();
const exists = (rel: string) => fs.existsSync(path.join(SRC, rel));

describe('K4 ② 模块 owner 覆盖 (每段代码属于哪个模块)', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(PRODUCTS.length).toBeGreaterThan(300);
  });

  it('每个产品码文件都恰好命中一个 owner 条目 (0 个"无归属")', () => {
    const findings = scanOwnerCoverage(PRODUCTS, MODULE_OWNERS);
    expect(findings).toEqual([]);
  });

  it('名册里声明的键在盘上都真实存在 (空承诺判红)', () => {
    expect(scanOwnerPromises(MODULE_OWNERS, exists)).toEqual([]);
  });

  it('键不重复 (重复会让归属变成"看谁先匹配"的运气)', () => {
    const keys = MODULE_OWNERS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每条 owner 都写全 module/owner/disposition/phase (没有"以后再看"的条目)', () => {
    const bad = MODULE_OWNERS.filter(
      (o) => !o.module || !o.owner || !o.disposition || !o.phase,
    );
    expect(bad.map((o) => o.key)).toEqual([]);
  });

  it('判别力自证: 人造"名册外文件"必须报无归属', () => {
    const probe: SourceFile[] = [{ path: 'nowhere/ghost.ts', text: 'export const x = 1;\n' }];
    const hits = scanOwnerCoverage(probe, MODULE_OWNERS);
    expect(hits.length).toBe(1);
    expect(hits[0].file).toBe('nowhere/ghost.ts');
  });

  it('长前缀优先: 具体文件条目胜过它所在目录的条目', () => {
    const o = ownerOfFile('agents/pi-sdk.ts', MODULE_OWNERS);
    expect(o?.module).toBe('adapter');
    expect(ownerOfFile('agents/agent-lang.ts', MODULE_OWNERS)?.module).toBe('agents-misc');
  });

  it('变异: 名册里删掉一条 ⇒ 它覆盖的文件立刻变成无归属 (门红)', () => {
    const dropped = MODULE_OWNERS.find((o) => o.key === 'llm/')!;
    const mutated = MODULE_OWNERS.filter((o) => o !== dropped);
    const findings = scanOwnerCoverage(PRODUCTS, mutated);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.file.startsWith('llm/'))).toBe(true);
  });
});

describe('K5 ③ 入口调用关系图 (全仓 prompt* 调用点必须与表逐字相等)', () => {
  it('重新扫描的真实调用点与 ENTRY_GRAPH 双向相等', () => {
    const actual = scanEntrySites(PRODUCTS);
    const { extra, missing } = entryGraphDiff(actual, ENTRY_GRAPH);
    expect(missing, '表里有但盘上扫不到 (表过期了)').toEqual([]);
    expect(extra, '盘上有但表里没登记 (新旁路!)').toEqual([]);
  });

  it('直调 prompt* 的调用点总数与冻结值一致 (K3 只许把它压到 0)', () => {
    const actual = scanEntrySites(PRODUCTS);
    const direct = actual.filter((a) => a.kind !== 'readline-tui').reduce((n, a) => n + a.count, 0);
    expect(direct).toBe(ENTRY_DIRECT_CALLS_FROZEN_AT);
  });

  it('readline 提示与 agent 入口被分开 (不分开就会把 TUI 提示当成旁路)', () => {
    const actual = scanEntrySites(PRODUCTS);
    expect(actual.some((a) => a.kind === 'readline-tui')).toBe(true);
    expect(actual.some((a) => a.kind === 'adapter-internal')).toBe(true);
    expect(actual.some((a) => a.kind === 'agent-entry')).toBe(true);
  });

  it('判别力自证: 人造旁路必须被抓到; TUI 提示不许被误判成旁路', () => {
    const probe: SourceFile[] = [
      { path: 'web/newbypass.ts', text: "await agent.prompt('hi');\n" },
      { path: 'cli/tui.ts', text: "const x = await this.prompt('> ');\n" },
    ];
    const sites = scanEntrySites(probe);
    expect(sites.find((s) => s.file === 'web/newbypass.ts')?.kind).toBe('agent-entry');
    expect(sites.find((s) => s.file === 'cli/tui.ts')?.kind).toBe('readline-tui');
  });

  it('变异: 拿真实文件注入一条直调 ⇒ 与表不再相等 (新入口当场浮出来)', () => {
    const victim = PRODUCTS.find((f) => f.path === 'web/i18n.ts')!;
    const mutated = PRODUCTS.map((f) =>
      f === victim ? { path: f.path, text: `${f.text}\nawait agent.prompt('x');\n` } : f,
    );
    const { extra } = entryGraphDiff(scanEntrySites(mutated), ENTRY_GRAPH);
    expect(extra.length).toBeGreaterThan(0);
  });
});

describe('K6 ④ 旧代码删除台账', () => {
  const actualCands = deletionCandidates(PRODUCTS);
  const shaOf = (list: string[]) => createHash('sha256').update(list.join('\n')).digest('hex');

  it('候选集非空且与冻结的集合 sha256 一致 (增/删/替换任一条都判红)', () => {
    expect(actualCands.length).toBeGreaterThan(0);
    const actual = shaOf(actualCands);
    if (actual !== DELETION_CANDIDATE_SHA256) {
      const frozenCount = DELETION_CANDIDATE_COUNT;
      const added = actualCands.slice(0, frozenCount).filter((c) => !c);
      throw new Error(
        `候选集变了: 期望 sha256=${DELETION_CANDIDATE_SHA256} (${frozenCount} 条), 实际 sha256=${actual} (${actualCands.length} 条)\n` +
          `实际集合前 20 条: ${actualCands.slice(0, 20).join(' | ')}`,
      );
    }
    expect(actual).toBe(DELETION_CANDIDATE_SHA256);
  });

  it('候选条数与冻结值一致', () => {
    expect(actualCands.length).toBe(DELETION_CANDIDATE_COUNT);
  });

  it('候选的目录分布与登记一致 (台账要能说清"删的是哪一类", 不是一团数)', () => {
    const dist: Record<string, number> = {};
    for (const c of actualCands) {
      const top = c.includes('/') ? c.split('/')[0] : '(根)';
      dist[top] = (dist[top] ?? 0) + 1;
    }
    expect(dist).toEqual({ ...DELETION_CANDIDATE_DIRS });
  });

  it('已登记的删除记录: 8 字段齐全 + 剩余引用必须为 0', () => {
    for (const rec of DELETION_LEDGER) {
      expect(validateDeletionRecord(rec as unknown as Record<string, unknown>)).toEqual([]);
      expect(exists(rec.target)).toBe(false); // 真删掉了才许登记
    }
  });

  it('判别力自证: 完整的记录必须过, 缺字段/剩余引用非 0 必须红', () => {
    const good = {
      target: 'a/b.ts', oldEntry: 'x.prompt', replacement: 'kernel.submit', remainingRefs: 0,
      runtimeHits: 0, acceptance: 'verify-x 12/0', rollbackCommit: 'deadbee', deletedAt: '2026-10-02',
    };
    expect(validateDeletionRecord(good)).toEqual([]);
    expect(validateDeletionRecord({ ...good, acceptance: '' }).length).toBe(1);
    expect(validateDeletionRecord({ ...good, remainingRefs: 3 })).toContain('remainingRefs≠0');
  });

  it('变异: 候选集少一条 (相当于真删掉一个候选文件) ⇒ sha256 必须变', () => {
    const cand = actualCands[0];
    const mutated = PRODUCTS.filter((f) => f.path !== cand);
    const after = deletionCandidates(mutated);
    expect(after.length).toBe(actualCands.length - 1);
    expect(after).not.toEqual(actualCands);
    expect(shaOf(after)).not.toBe(DELETION_CANDIDATE_SHA256);
  });

  it('变异: 用**副作用 import** (无 from 无括号) 引用候选 ⇒ 判据也必须看得见 (锁住修真缺陷)', () => {
    const cand = actualCands[0];
    const base = cand.split('/').pop()!.replace(/\.tsx?$/, '.js');
    // 自引用: 路径与目录无关, 只测判据"认不认副作用 import"
    const mutated = PRODUCTS.map((f) =>
      f.path === cand ? { path: f.path, text: `${f.text}\nimport './${base}';\n` } : f,
    );
    const after = deletionCandidates(mutated);
    expect(after).not.toContain(cand);
    expect(after.length).toBe(actualCands.length - 1);
  });

  it('变异: 候选集多一条 (新出现一个 0 入边文件) ⇒ sha256 也必须变', () => {
    const ghost: SourceFile = { path: 'agents/__ghost__.ts', text: 'export const g = 1;\n' };
    const after = deletionCandidates([...PRODUCTS, ghost]);
    expect(after).toContain('agents/__ghost__.ts');
    expect(shaOf(after)).not.toBe(DELETION_CANDIDATE_SHA256);
  });
});
