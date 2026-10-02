/**
 * K1 ⑤ 前置台账 (2026-10-02, 可重算)
 *
 * **为什么要有这条判据**: `@bolloon/constraint-runtime` 是**已发布包** (npm 0.1.1)。
 * 它的导出面既包括仓内在用的 (真契约), 也包括**仓内零引用**的 (19 个) —— 后者**不许**被当成"死代码"删掉:
 * 仓规明写「**不许以『看起来没用』为依据**」删除; 发布出去的导出面是**对外承诺**, 删它是破坏性变更,
 * 要么等用户口径 (收窄口径), 要么走主版本号。
 *
 * 所以这条判据的作用是: **把"谁在用"变成可重算的事实**, 让任何一次导出面的变化都必须显式过账
 * (新增引用 ⇒ 清单变短; 新增未被引用的导出 ⇒ 清单变长), 而不是靠人肉 grep。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CR = 'src/constraint-runtime';

/** 从 dist/index.d.ts (+ 其 re-export 的子 index) 采集导出符号 */
function exportedSymbols(): Set<string> {
  const names = new Set<string>();
  const idx = fs.readFileSync(path.join(ROOT, `${CR}/dist/index.d.ts`), 'utf8');
  const collect = (text: string) => {
    for (const m of text.matchAll(/export \{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(' as ').pop()!.replace(/^type\s+/, '').trim();
        if (n) names.add(n);
      }
    }
  };
  collect(idx);
  for (const m of idx.matchAll(/export \* from '\.\/([^']+)'/g)) {
    const sub = path.join(ROOT, CR, 'dist', m[1]);
    if (fs.existsSync(sub)) collect(fs.readFileSync(sub, 'utf8'));
  }
  return names;
}

/** 仓内 (排除 constraint-runtime 自身与 test) 的引用计数 */
function inRepoCounts(): Map<string, number> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p.includes('constraint-runtime')) continue;
        if (e.name === 'test' || e.name === 'node_modules') continue;
        walk(p);
      } else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
  const counts = new Map<string, number>();
  for (const n of exportedSymbols()) {
    counts.set(n, texts.reduce((acc, t) => acc + t.split(n).length - 1, 0));
  }
  return counts;
}

/** 冻结的"仓内零引用导出"清单 (2026-10-02 量测) */
const ZERO_REF_IN_REPO = [
  'CostTracker', 'DirectModeReport', 'HistoryLog', 'ParityAuditResult', 'PortContext',
  'RuntimeModeReport', 'RuntimeSession', 'SetupReport', 'ThinkStep', 'ToolPool',
  'TranscriptStore', 'WorkspaceSetup', 'assembleToolPool', 'buildBootstrapGraph',
  'buildCommandGraph', 'buildPortContext', 'buildSetup', 'runDeepLink', 'runDirectConnect',
].sort();

describe('K1 ⑤ 前置: constraint-runtime 导出面的仓内消费 (可重算台账)', () => {
  it('① 导出面 38 个符号; 仓内零引用清单 == 冻结清单 (19)', () => {
    const counts = inRepoCounts();
    expect(counts.size).toBe(38);
    const zero = [...counts.entries()].filter(([, c]) => c === 0).map(([n]) => n).sort();
    expect(zero).toEqual(ZERO_REF_IN_REPO);
  });

  it('② 有引用的导出: 至少 19 个真契约 (仓内在用)', () => {
    const counts = inRepoCounts();
    const used = [...counts.entries()].filter(([, c]) => c > 0);
    expect(used.length).toBe(19);
    // 抽查几个必须由仓内消费的 (K7/K1 关键面)
    for (const n of ['SkillRegistry', 'Session', 'ToolPermissionContext', 'BudgetTracker']) {
      expect(counts.get(n) ?? 0).toBeGreaterThan(0);
    }
  });
});
