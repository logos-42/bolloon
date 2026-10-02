/**
 * K1 删除门 —— 删除就绪台账必须与盘上引用面**同步** (leo 的五个删除条件里可机器核验的部分)
 *
 * 这道门防三件事:
 *   ① 标 `ready` 却还有引用 (条件②没满足就想删);
 *   ② 标 `blocked` 却给不出 blocker, 或 blocker 早已消失 (把"阻塞"当永久借口 ⇒ 该改判 ready);
 *   ③ 标 `done` 却没有删除记录或目标还在 (删了不留账 / 假删)。
 *
 * 纪律: 真读盘 · 判据是纯函数 · 变异每次跑测试真做 · 拿不到事实就拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { DELETION_CONDITIONS, DELETION_VERDICTS } from '../kernel/plan-deletion.js';
import { DELETION_LEDGER } from '../kernel/plan.js';
import { type SourceFile, scanDeletionVerdictSync } from '../kernel/gate-scan.js';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

function loadFiles(): SourceFile[] {
  const out: string[] = [];
  const walk = (abs: string, prefix: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), `${rel}/`);
      else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(e.name) && !e.name.endsWith('package-lock.json')) out.push(rel);
    }
  };
  walk(SRC, 'src/');
  walk(path.join(ROOT, 'scripts'), 'scripts/');
  // 证据面不能只有 .ts: dist 的耦合证据在 Dockerfile / package.json 里
  for (const rel of ['Dockerfile', 'package.json', 'tsconfig.json', 'vitest.config.ts']) {
    if (fs.existsSync(path.join(ROOT, rel))) out.push(rel);
  }
  return out.sort().map((r) => ({ path: r, text: fs.readFileSync(path.join(ROOT, r), 'utf8') }));
}

const ALL = loadFiles();
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const LEDGER_TARGETS = DELETION_LEDGER.map((d) => d.target);

describe('K1-d 删除就绪台账与盘上事实同步', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(ALL.length).toBeGreaterThan(300);
    expect(DELETION_VERDICTS.length).toBeGreaterThan(3);
  });

  it('verdict 与盘上引用面一致 (ready 无引用 / blocked 有真实 blocker / done 有记录)', () => {
    const findings = scanDeletionVerdictSync(ALL, DELETION_VERDICTS, { exists, ledgerTargets: LEDGER_TARGETS });
    expect(findings).toEqual([]);
  });

  it('五个删除条件全列 (判据本身不许缺项)', () => {
    expect(DELETION_CONDITIONS.length).toBe(5);
    expect(DELETION_CONDITIONS.every((c) => c.trim().length > 4)).toBe(true);
  });

  it('已删的两项都在台账里, 且盘上确实不存在', () => {
    const done = DELETION_VERDICTS.filter((v) => v.verdict === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const d of done) {
      expect(exists(d.target)).toBe(false);
      expect(LEDGER_TARGETS).toContain(d.target);
    }
  });

  it('删除记录 8 字段齐全且剩余引用为 0 (复用 K0 的格式门语义)', () => {
    for (const rec of DELETION_LEDGER) {
      expect(rec.target.length).toBeGreaterThan(0);
      expect(rec.remainingRefs).toBe(0);
      expect(rec.runtimeHits).toBeGreaterThanOrEqual(0);
      expect(rec.acceptance.length).toBeGreaterThan(0);
      expect(rec.rollbackCommit.length).toBeGreaterThan(0);
      expect(rec.deletedAt.length).toBeGreaterThan(0);
    }
  });

  it('判别力自证: 三种坏形状都必须判红', () => {
    const base = { group: 'probe', reason: 'probe', blockers: [] as { file: string; why: string }[] };
    const files: SourceFile[] = [{ path: 'agents/x.ts', text: 'import { remote_runtime } from "../constraint-runtime/src/remote_runtime.js";\n' }];
    // ① ready 但有引用 + 目标存在
    const readyBad = scanDeletionVerdictSync(files, [{ ...base, target: 'src/constraint-runtime/src/remote_runtime.ts', verdict: 'ready' }],
      { exists: () => true, ledgerTargets: [] });
    expect(readyBad.some((f) => f.rule === 'deletion-ready-with-refs')).toBe(true);
    // ② blocked 但 blocker 文件不存在
    const blockedBad = scanDeletionVerdictSync(files, [{ ...base, target: 'src/x/', verdict: 'blocked', blockers: [{ file: 'src/nope.ts', why: 'x' }] }],
      { exists: () => false, ledgerTargets: [] });
    expect(blockedBad.some((f) => f.rule === 'deletion-stale-blocker')).toBe(true);
    // ③ done 但没有台账记录 / 目标还在
    const doneBad = scanDeletionVerdictSync([], [{ ...base, target: 'src/y/', verdict: 'done' }],
      { exists: () => true, ledgerTargets: [] });
    expect(doneBad.map((f) => f.rule).sort()).toEqual(['deletion-done-but-present', 'deletion-done-without-record']);
  });

  it('变异: 把已删的那条改回 ready ⇒ 立刻判红 (删了就得留 done + 账)', () => {
    const doneOne = DELETION_VERDICTS.find((v) => v.verdict === 'done')!;
    const mutated = DELETION_VERDICTS.map((v) => (v === doneOne ? { ...v, verdict: 'ready' as const } : v));
    const findings = scanDeletionVerdictSync(ALL, mutated, { exists, ledgerTargets: LEDGER_TARGETS });
    expect(findings.some((f) => f.rule === 'deletion-ready-but-missing')).toBe(true);
    // 而同一判据在真实台账上是干净的
    expect(scanDeletionVerdictSync(ALL, DELETION_VERDICTS, { exists, ledgerTargets: LEDGER_TARGETS })).toEqual([]);
  });
});
