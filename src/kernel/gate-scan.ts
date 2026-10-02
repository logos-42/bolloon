/**
 * Bolloon Native Macro-Kernel —— K0 门的**判据** (纯函数: 吃源码文本, 出违规清单)
 *
 * 为什么判据是纯函数而不是几条 `expect`:
 *   只有这样, 「变异验证」才能把**人为改坏的源码**喂给**同一份**判据 (测试里真的这么干)。
 *   先例: src/agents/goal-flywheel/wiring/* 的 scan* + src/test/goal-flywheel-wiring-freeze.test.ts。
 *
 * 本文件只 import 名册 (kernel 内部), 自己就是 K1 的样本。
 */
import {
  type LayerId,
  type Prohibition,
  LAYERS,
} from './roster.js';

/** 一个源文件 (path 相对 src/) —— 判据只认这两个字段, 不碰磁盘 */
export interface SourceFile {
  path: string;
  text: string;
}

export interface Finding {
  /** 命中的禁令 id / K1 用 'kernel-dir-boundary' */
  rule: string;
  file: string;
  line: number;
  what: string;
}

/** 行内注释剥掉 (保护 `https://` 这类) —— 拿子串当判据前先剥注释是本仓的硬规矩 */
export function stripLineComment(line: string): string {
  const m = line.indexOf('//');
  if (m < 0) return line;
  if (line[m - 1] === ':') return line; // https:// 之类
  return line.slice(0, m);
}

export function isCommentOnly(line: string): boolean {
  const s = line.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('*/');
}

// 2026-10-02 修真缺陷: 原先只认 `from '...'` 与动态 `import('...')`,
//   漏掉**副作用 import** (`import './x.js';` —— 既无 from 也无括号) ⇒ 入边被少算 ⇒ 删除候选虚高。
const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;

/** 抽出所有 import/export-from/动态 import 的说明符 + 行号 */
export function importSpecifiers(text: string): Array<{ line: number; spec: string }> {
  const out: Array<{ line: number; spec: string }> = [];
  text.split('\n').forEach((raw, i) => {
    if (isCommentOnly(raw)) return;
    const line = stripLineComment(raw);
    FROM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FROM_RE.exec(line)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec) out.push({ line: i + 1, spec });
    }
  });
  return out;
}

/**
 * 把说明符解析成「相对 src/ 的路径 (无扩展名)」。
 * 非相对说明符 (node 内置 / 第三方包) → null: **仓内跨层边**才是本门管的范围。
 */
export function resolveFrom(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const parts = (dir ? dir.split('/') : []).concat(spec.split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  let rel = stack.join('/');
  if (rel.endsWith('.js')) rel = rel.slice(0, -3);
  if (rel.endsWith('.jsx')) rel = rel.slice(0, -4);
  if (rel.endsWith('.mjs')) rel = rel.slice(0, -4);
  return rel || null;
}

/** 这个路径属于哪一层 (目录前缀 或 精确文件) */
export function layerOf(rel: string): LayerId | null {
  for (const layer of LAYERS) {
    for (const p of layer.paths) {
      if (p.endsWith('/') ? rel.startsWith(p) : rel === p) return layer.id;
    }
  }
  return null;
}

export function filesOfLayer(files: SourceFile[], layer: LayerId): SourceFile[] {
  return files.filter((f) => layerOf(f.path) === layer);
}

const KERNEL_BOUNDARY = 'kernel-dir-boundary';

/**
 * K1 —— kernel 目录的每一条仓内 import 都必须落在允许前缀里。
 * 违规 = 内核自己伸手去摸业务模块 (那正是 pi-sdk.ts 长成 4099 行单体的成因)。
 */
export function scanKernelImports(
  kernel: SourceFile[],
  allowedPrefixes: readonly string[],
): Finding[] {
  const out: Finding[] = [];
  for (const f of kernel) {
    for (const { line, spec } of importSpecifiers(f.text)) {
      const rel = resolveFrom(f.path, spec);
      if (rel === null) continue; // node / 第三方
      if (allowedPrefixes.some((p) => rel.startsWith(p))) continue;
      out.push({ rule: KERNEL_BOUNDARY, file: f.path, line, what: `${spec} → ${rel}` });
    }
  }
  return out;
}

/** K2 —— 一条禁令在给定源码面上的全部命中 */
export function scanProhibition(files: SourceFile[], p: Prohibition): Finding[] {
  const out: Finding[] = [];
  const targets = p.targets ?? [];
  const calls = p.writeCalls ?? [];
  const callRe = calls.length ? new RegExp(`\\b(${calls.join('|')})\\s*\\(`) : null;

  for (const f of files) {
    if (p.mode === 'import-edge') {
      for (const { line, spec } of importSpecifiers(f.text)) {
        const rel = resolveFrom(f.path, spec);
        if (rel === null) continue;
        if (targets.some((t) => rel === t || rel.startsWith(`${t}/`))) {
          out.push({ rule: p.id, file: f.path, line, what: `import ${spec}` });
        }
      }
      continue;
    }
    // write-call: 只认**调用**(读不算) —— 定义处/import 解构都带不出 `(`
    f.text.split('\n').forEach((raw, i) => {
      if (isCommentOnly(raw)) return;
      const line = stripLineComment(raw);
      if (!callRe) return;
      const m = callRe.exec(line);
      if (m) out.push({ rule: p.id, file: f.path, line: i + 1, what: `${m[1]}()` });
    });
  }
  return out;
}

/** 把命中归并成 (rule|file|call/import) → 次数, 供与欠账台账**逐字相等**比对 */
export function groupFindings(findings: Finding[]): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const f of findings) {
    const call = f.what.replace(/\(\)$/, '').replace(/^import\s+/, '');
    const key = `${f.rule}|${f.file}|${call}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
}

/** 与欠账台账比对: 双向相等 (多一条红 / 少一条也红, 强制台账与事实同步) */
export function debtDiff(
  findings: Finding[],
  debt: ReadonlyArray<{ prohibition: string; file: string; call: string; count: number }>,
  rule: string,
): { missing: string[]; extra: string[] } {
  const actual = groupFindings(findings).filter((g) => g.key.startsWith(`${rule}|`));
  const want = debt
    .filter((d) => d.prohibition === rule)
    .map((d) => `${d.prohibition}|${d.file}|${d.call}|${d.count}`)
    .sort();
  const got = actual.map((g) => `${g.key}|${g.count}`).sort();
  return {
    missing: got.filter((g) => !want.includes(g)),
    extra: want.filter((w) => !got.includes(w)),
  };
}

/** K3 —— 行数 (整文件行数; 空行也算, 因为预算量的是「文件有多大」) */
export function countCodeLines(files: SourceFile[]): number {
  return files.reduce((n, f) => n + f.text.split('\n').filter((_, i, a) => i < a.length - (a[a.length - 1] === '' ? 1 : 0)).length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// K0 ② 模块 owner 覆盖
// ─────────────────────────────────────────────────────────────────────────────

export interface OwnerEntry {
  key: string;
  module: string;
  owner: string;
  disposition: string;
  phase: string;
  note: string;
}

/** 归属判定 = **最长前缀** (目录键以 / 结尾按前缀, 文件键按相等)。null = 无归属 ⇒ 门判红。 */
export function ownerOfFile(rel: string, owners: readonly OwnerEntry[]): OwnerEntry | null {
  let best: OwnerEntry | null = null;
  for (const o of owners) {
    const hit = o.key.endsWith('/') ? rel.startsWith(o.key) : rel === o.key;
    if (hit && (!best || o.key.length > best.key.length)) best = o;
  }
  return best;
}

export function scanOwnerCoverage(files: SourceFile[], owners: readonly OwnerEntry[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!ownerOfFile(f.path, owners)) out.push({ rule: 'owner-coverage', file: f.path, line: 1, what: '无 owner' });
  }
  return out;
}

/** owner 名册里声明了但盘上不存在的键 (空承诺) —— 先例: 冻结门的「名册路径必须真实存在」 */
export function scanOwnerPromises(owners: readonly OwnerEntry[], exists: (rel: string) => boolean): Finding[] {
  return owners
    .filter((o) => !exists(o.key))
    .map((o) => ({ rule: 'owner-promise', file: o.key, line: 1, what: '名册声明但盘上不存在' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// K0 ③ 入口调用关系图
// ─────────────────────────────────────────────────────────────────────────────

export interface EntrySite {
  file: string;
  kind: 'agent-entry' | 'adapter-internal' | 'readline-tui';
  method: string;
  count: number;
}

const PROMPT_CALL_RE = /([\w\.\)\]]+)\s*\.\s*(prompt|promptStream|promptWithPivotLoop)\s*\(/;
const PROMPT_DEF_RE = /^(export\s+)?(async\s+)?(prompt|promptStream|promptWithPivotLoop)\s*\(/;

/** 重算全仓入口调用点 (与 ENTRY_GRAPH 逐字比对; 任何新旁路都会浮出来) */
export function scanEntrySites(files: SourceFile[], adapterFiles: readonly string[] = ['agents/pi-sdk.ts']): EntrySite[] {
  const m = new Map<string, EntrySite>();
  for (const f of files) {
    f.text.split('\n').forEach((raw) => {
      if (isCommentOnly(raw)) return;
      const line = stripLineComment(raw);
      if (PROMPT_DEF_RE.test(line.trim())) return;
      const hit = PROMPT_CALL_RE.exec(line);
      if (!hit) return;
      const recv = hit[1];
      const kind: EntrySite['kind'] = adapterFiles.includes(f.path)
        ? 'adapter-internal'
        : recv === 'this' ? 'readline-tui' : 'agent-entry';
      const key = `${f.path}|${kind}|${hit[2]}`;
      const prev = m.get(key);
      m.set(key, { file: f.path, kind, method: hit[2], count: (prev?.count ?? 0) + 1 });
    });
  }
  return [...m.values()].sort((a, b) => `${a.file}|${a.kind}|${a.method}`.localeCompare(`${b.file}|${b.kind}|${b.method}`));
}

export function entryGraphDiff(actual: EntrySite[], declared: readonly { file: string; kind: string; method: string; count: number }[]) {
  const key = (e: { file: string; kind: string; method: string; count: number }) => `${e.file}|${e.kind}|${e.method}|${e.count}`;
  const got = actual.map(key).sort();
  const want = declared.map(key).sort();
  return { extra: got.filter((g) => !want.includes(g)), missing: want.filter((w) => !got.includes(w)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// K0 ④ 旧代码删除台账
// ─────────────────────────────────────────────────────────────────────────────

const DELETION_FIELDS = [
  'target', 'oldEntry', 'replacement', 'remainingRefs',
  'runtimeHits', 'acceptance', 'rollbackCommit', 'deletedAt',
] as const;

/** 8 字段缺一律红 (leo 的五个删除条件之 ②: 剩余引用必须为 0) */
export function validateDeletionRecord(rec: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const f of DELETION_FIELDS) {
    const v = rec[f];
    if (v === undefined || v === null || v === '') bad.push(f);
    if (f === 'remainingRefs' && v !== 0) bad.push('remainingRefs≠0');
  }
  return bad;
}

/** 第一批删除候选 = 产品码里 **0 入边引用** 且非入口形态 (机械派生, 不手写) */
const ENTRY_SHAPE_RE = /(index\.ts$|cli-entry\.ts$|electron\.ts$|\.d\.ts$|server\.ts$|main\.ts$|route|command|register|setup|bootstrap|migration|types\.ts$|constants?\.ts$|config)/;

export function deletionCandidates(files: SourceFile[]): string[] {
  const paths = new Set(files.map((f) => f.path));
  const inbound = new Map<string, number>();
  for (const f of files) {
    for (const { spec } of importSpecifiers(f.text)) {
      const rel = resolveFrom(f.path, spec);
      if (!rel) continue;
      for (const c of [rel + '.ts', rel + '.tsx', rel + '/index.ts']) {
        if (paths.has(c)) inbound.set(c, (inbound.get(c) ?? 0) + 1);
      }
    }
  }
  return files
    .map((f) => f.path)
    .filter((p) => (inbound.get(p) ?? 0) === 0 && !ENTRY_SHAPE_RE.test(p))
    .sort();
}


// ─────────────────────────────────────────────────────────────────────────────
// K1 —— constraint-runtime 三层分类 / 主仓引用台账 / 越界引用
// ─────────────────────────────────────────────────────────────────────────────

export interface ConstraintRuleLike { key: string; cls: string; why: string; phase: string }

/** 归属 = 最长前缀; 入参 rel 相对 constraint-runtime/ */
export function constraintClassOf(rel: string, rules: readonly ConstraintRuleLike[]): ConstraintRuleLike | null {
  let best: ConstraintRuleLike | null = null;
  for (const r of rules) {
    const hit = r.key.endsWith('/') ? rel.startsWith(r.key) : rel === r.key;
    if (hit && (!best || r.key.length > best.key.length)) best = r;
  }
  return best;
}

/** 每个源码文件必须恰好命中一条规则 (BUILD/META 子树另算) */
export function scanConstraintCoverage(
  sourceFiles: readonly string[],
  rules: readonly ConstraintRuleLike[],
): Finding[] {
  const out: Finding[] = [];
  for (const rel of sourceFiles) {
    if (!constraintClassOf(rel, rules)) out.push({ rule: 'constraint-coverage', file: rel, line: 1, what: '未分类' });
  }
  return out;
}

/** 说明符 → 台账里的目标键 (包入口 / 去掉 src|dist 前缀与 .js) */
export function constraintTargetOf(spec: string): string | null {
  if (!spec.includes('constraint-runtime')) return null;
  if (/^@bolloon\/constraint-runtime$/.test(spec)) return '__pkg_entry__';
  const marker = 'constraint-runtime/';
  const i = spec.lastIndexOf(marker);
  if (i < 0) return '__pkg_entry__';
  return spec.slice(i + marker.length).replace(/^(src|dist)\//, '').replace(/\.js$/, '');
}

/**
 * 目标键 → 规则键。
 * 台账里的 target 是**模块名**(无扩展名, 如 `tools/SafeSDK/deploySafe`), 而名册键是**文件路径**
 * (如 `src/tools/SafeSDK/deploySafe.ts`) ⇒ 三种写法都试 (裸名 / +.ts / +/index.ts)。
 */
export function constraintRuleOfTarget(target: string, rules: readonly ConstraintRuleLike[]): ConstraintRuleLike | null {
  if (target === '__pkg_entry__') return rules.find((r) => r.key === '__pkg_entry__') ?? null;
  return constraintClassOf(`src/${target}`, rules)
    ?? constraintClassOf(`src/${target}.ts`, rules)
    ?? constraintClassOf(`src/${target}/index.ts`, rules);
}

export interface ConstraintUseRow { file: string; target: string; count: number; kind: 'prod' | 'test' }

/** 重算主仓 (非 constraint-runtime 子树) 对 constraint-runtime 的全部引用点 */
export function scanConstraintUses(
  files: SourceFile[],
  constraintRoot: string,
): ConstraintUseRow[] {
  const m = new Map<string, ConstraintUseRow>();
  for (const f of files) {
    if (f.path.startsWith(constraintRoot)) continue;
    const kind: 'prod' | 'test' = f.path.startsWith('test/') ? 'test' : 'prod';
    for (const { spec } of importSpecifiers(f.text)) {
      const target = constraintTargetOf(spec);
      if (!target) continue;
      const key = `${f.path}|${target}|${kind}`;
      const prev = m.get(key);
      m.set(key, { file: f.path, target, count: (prev?.count ?? 0) + 1, kind });
    }
  }
  return [...m.values()].sort((a, b) => key2(a).localeCompare(key2(b)));
}
function key2(r: ConstraintUseRow) { return `${r.file}|${r.target}|${r.kind}`; }

export function constraintUseDiff(
  actual: readonly ConstraintUseRow[],
  declared: readonly { file: string; target: string; count: number; kind: string }[],
) {
  const k = (r: { file: string; target: string; count: number; kind: string }) => `${r.file}|${r.target}|${r.kind}|${r.count}`;
  const got = actual.map(k).sort();
  const want = declared.map(k).sort();
  return { extra: got.filter((g) => !want.includes(g)), missing: want.filter((w) => !got.includes(w)) };
}

/**
 * 越界引用 (K1 的核心判据):
 *   · C 类被 **prod** 引用 ⇒ 违规 (不许被 Kernel 侧 import);
 *   · B 类被 **prod** 直接引用 ⇒ 欠账 (只能经 Tool Capability 接入, K7 还清)。
 */
export function scanConstraintViolations(
  uses: readonly ConstraintUseRow[],
  rules: readonly ConstraintRuleLike[],
): { cViolations: Finding[]; bDebt: ConstraintUseRow[] } {
  const cViolations: Finding[] = [];
  const bDebt: ConstraintUseRow[] = [];
  for (const u of uses) {
    if (u.kind !== 'prod') continue;
    const rule = constraintRuleOfTarget(u.target, rules);
    if (!rule) cViolations.push({ rule: 'constraint-unclassified-use', file: u.file, line: 1, what: u.target });
    else if (rule.cls === 'C' || rule.cls === 'BUILD' || rule.cls === 'META')
      cViolations.push({ rule: 'constraint-c-imported-by-prod', file: u.file, line: 1, what: `${u.target} (${rule.cls})` });
    else if (rule.cls === 'B') bDebt.push(u);
  }
  return { cViolations, bDebt };
}


// ─────────────────────────────────────────────────────────────────────────────
// K1 删除就绪台账 —— verdict 必须与盘上引用面**同步** (不许烂成永久借口)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeletionVerdictLike {
  group: string;
  target: string;
  verdict: 'ready' | 'blocked' | 'done';
  blockers: readonly { file: string; why: string }[];
  reason: string;
  /** 判据用的判别名; 缺省取 target 的 basename。目录目标的 basename 常没判别力 (`src`) ⇒ 显式给真耦合名。 */
  needle?: string;
}

/** 台账自身与门自身不算"引用" (否则会自己指自己) */
function isGateOwnFile(rel: string): boolean {
  return rel.startsWith('kernel/') || /^test\/kernel-[\w-]+\.test\.ts$/.test(rel);
}

/**
 * verdict 同步判据:
 *   ready   ⇒ 目标在盘上存在 **且** 仓内(排除门自身) 0 引用 —— 有引用就不许 ready;
 *   blocked ⇒ 每个 blocker 文件存在 **且** 它现在还真的提到这个目标 —— blocker 消失就必须改判 ready;
 *   done    ⇒ 目标不在盘上 **且** DELETION_LEDGER 里有对应记录 (删了必须留账)。
 */
export function scanDeletionVerdictSync(
  files: SourceFile[],
  verdicts: readonly DeletionVerdictLike[],
  opts: { exists: (rel: string) => boolean; ledgerTargets: readonly string[] },
): Finding[] {
  const out: Finding[] = [];
  const scannable = files.filter((f) => !isGateOwnFile(f.path) && !f.path.startsWith('constraint-runtime/dist/'));

  for (const v of verdicts) {
    // basename 去扩展名: 目标常写作路径 (.../remote_runtime.ts), 而引用处写作模块名 (remote_runtime.js)
    const basename = v.needle ?? (v.target.replace(/\/$/, '').split('/').pop() as string).replace(/\.(tsx?|js|mjs|json|cjs)$/, '');
    if (v.verdict === 'ready') {
      if (!opts.exists(v.target)) {
        out.push({ rule: 'deletion-ready-but-missing', file: v.target, line: 1, what: '标了 ready 但盘上不存在 (是不是已删? 那要改 done + 记台账)' });
        continue;
      }
      const refs = scannable.filter((f) => !f.path.startsWith(v.target.replace(/^src\//, '')) && f.text.includes(basename));
      for (const r of refs.slice(0, 5)) {
        out.push({ rule: 'deletion-ready-with-refs', file: r.path, line: 1, what: `标了 ready 但这里提到 ${basename}` });
      }
      continue;
    }
    if (v.verdict === 'blocked') {
      if (v.blockers.length === 0) {
        out.push({ rule: 'deletion-blocked-without-evidence', file: v.target, line: 1, what: '标了 blocked 却给不出 blocker' });
        continue;
      }
      for (const b of v.blockers) {
        if (!opts.exists(b.file)) {
          out.push({ rule: 'deletion-stale-blocker', file: b.file, line: 1, what: `blocker 文件已不存在 (blocker 该重算了)` });
          continue;
        }
        // blocker 的"还成立吗"判据 = 该文件现在仍然提到这个目标 (扫得到就行; 扫不到 = 借口过期)
        const hit = scannable.find((f) => f.path === b.file && f.text.includes(basename));
        if (!hit) out.push({ rule: 'deletion-stale-blocker', file: b.file, line: 1, what: `blocker 已不再提到 ${basename} ⇒ 必须改判` });
      }
      continue;
    }
    // done
    if (opts.exists(v.target)) out.push({ rule: 'deletion-done-but-present', file: v.target, line: 1, what: '标了 done 但盘上还在' });
    if (!opts.ledgerTargets.includes(v.target)) out.push({ rule: 'deletion-done-without-record', file: v.target, line: 1, what: '标了 done 但没有删除记录' });
  }
  return out;
}
