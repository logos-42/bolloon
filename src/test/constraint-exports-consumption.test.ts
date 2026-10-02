/**
 * K1 ⑤ 前置台账 (2026-10-02, 可重算) —— **v2 口径修正: 按 import 消费, 不按"提到过名字"**
 *
 * **v1 的口径错误 (已修)**: 上一版把"文件里出现过这个符号名"就当消费 —— 于是**台账/判据里提到**这些名字
 * (例如 K1/K7 台账写明 `runRemoteMode` 等 placeholder 入口) 也被算成"有消费", 把数字虚高成 19 消费 / 19 零消费。
 * 正确口径: **只有 `import { X } from '...constraint-runtime...'` 才算消费** (命名空间 import 也解析)。
 * 修正后: 导出 **38** · 被 import 消费 **14** · **零 import 消费 25**。
 *
 * **用户口径 (2026-10-02, leo) —— 已决策: 保持 0.1.x 导出面不动, 25 个零消费项只登记备查**;
 * 若要收窄须另开口径或走主版本号。判据仍每次重算 ⇒ 变化会被看见, 但**默认动作是不动**。
 *
 * **为什么零消费 ≠ 可删**: `@bolloon/constraint-runtime` 是**已发布包** (npm 0.1.1), 导出面是对外承诺;
 * 删它是破坏性变更 (等用户口径或走主版本号)。仓规亦明写「不许以『看起来没用』为依据」。
 * 本判据的作用: 把"谁在用"变成**可重算的事实**, 任何导出面变化都必须显式过账。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CR = 'src/constraint-runtime';

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

const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*constraint-runtime[^']*'/g;

/** **import 消费** (排除 constraint-runtime 自身与 test); 命名空间 import 也解析 */
function importConsumed(): Set<string> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p.includes('constraint-runtime') || e.name === 'test' || e.name === 'node_modules') continue;
        walk(p);
      } else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const consumed = new Set<string>();
  const aliases: Array<{ file: string; alias: string }> = [];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(IMPORT_RE)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(' as ').pop()!.replace(/^type\s+/, '').trim();
        if (n) consumed.add(n);
      }
    }
    for (const m of t.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+'[^']*constraint-runtime[^']*'/g)) {
      aliases.push({ file: f, alias: m[1] });
    }
  }
  for (const { file, alias } of aliases) {
    const t = fs.readFileSync(file, 'utf8');
    for (const n of exportedSymbols()) if (new RegExp(`\\b${alias}\\.${n}\\b`).test(t)) consumed.add(n);
  }
  return consumed;
}

/** 冻结: 零 import 消费的导出 (2026-10-02 v2 口径) */
const ZERO_IMPORT_CONSUMED = [
  'CostTracker',
  'DirectModeReport',
  'HistoryEvent',
  'HistoryLog',
  'ParityAuditResult',
  'PortContext',
  'RuntimeModeReport',
  'RuntimeSession',
  'SetupReport',
  'ThinkStep',
  'ToolPool',
  'TranscriptStore',
  'WorkspaceSetup',
  'assembleToolPool',
  'buildBootstrapGraph',
  'buildCommandGraph',
  'buildPortContext',
  'buildSetup',
  'runDeepLink',
  'runDirectConnect',
  'runParityAudit',
  'runRemoteMode',
  'runSetup',
  'runSshMode',
  'runTeleportMode',
].sort();

describe('K1 ⑤ 前置: constraint-runtime 导出面的仓内消费 (v2: 按 import 算)', () => {
  it('① 导出面 38 个; 零 import 消费清单 == 冻结清单 (25)', () => {
    const syms = exportedSymbols();
    expect(syms.size).toBe(38);
    const zero = [...syms].filter((n) => !importConsumed().has(n)).sort();
    expect(zero).toEqual(ZERO_IMPORT_CONSUMED);
  });

  it('② C 类 placeholder (remote/ssh/teleport + parity) 属零 import 消费 (只挂在包入口)', () => {
    const consumed = importConsumed();
    for (const n of ['runRemoteMode', 'runSshMode', 'runTeleportMode', 'runParityAudit']) {
      expect(consumed.has(n)).toBe(false);
    }
  });
});
