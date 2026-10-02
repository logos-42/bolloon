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
import { HISTORY_OPS } from './plan-channel-actor.js';

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

/**
 * **豁免规则 (2026-10-02)**: 冻结面自身的文件 (KERNEL_FILES 成员 —— `kernel/roster.ts` / `kernel/plan*.ts`)
 * **不算删除候选**。它们是台账/名册, 在"0 入边"口径下天然是孤岛, 每加一个台账就会让候选集变一次
 * (已因此被迫改过三次 sha)。删除台账不是"删死代码", 走的是它自己的 8 字段记录流程。
 */
// 2026-10-02 (第 4 次候选集漂移后定的根规则): **kernel 冻结面整体不算删除候选**。
//   理由: ① 台账/名册在"0 入边"口径下天然是孤岛, 每加一个就改一次 sha (已四次);
//        ② 只被测试 import 的产品文件 (如 channel-actor.ts 这种"先落容器、后接线"的基建) 同样会被误判成死码;
//        ③ kernel 内部要删东西, 走的是它自己的 8 字段删除记录流程, 不是"删死代码"。
const LEDGER_SELF_EXEMPT = /^kernel\//;

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
    .filter((p) => (inbound.get(p) ?? 0) === 0 && !ENTRY_SHAPE_RE.test(p) && !LEDGER_SELF_EXEMPT.test(p))
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
  verdict: 'ready' | 'blocked' | 'done' | 'not-deletable';
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
    if (v.verdict === 'not-deletable') {
      // 明确"不许删"的一类 (环境声明等): 必须给出 blocker 且文件在盘上
      if (v.blockers.length === 0) out.push({ rule: 'deletion-blocked-without-evidence', file: v.target, line: 1, what: 'not-deletable 却没有依据' });
      if (!opts.exists(v.target)) out.push({ rule: 'deletion-missing', file: v.target, line: 1, what: '标了 not-deletable 但盘上没了' });
      continue;
    }
    // done
    if (opts.exists(v.target)) out.push({ rule: 'deletion-done-but-present', file: v.target, line: 1, what: '标了 done 但盘上还在' });
    if (!opts.ledgerTargets.includes(v.target)) out.push({ rule: 'deletion-done-without-record', file: v.target, line: 1, what: '标了 done 但没有删除记录' });
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// K2 门: RunContext 状态外置 —— 实例字段访问计数(棘轮) + 假完成检测
// ─────────────────────────────────────────────────────────────────────────────

export interface RunStateFieldLike {
  name: string;
  accesses: number;
  into: string;
  migrated: boolean;
}

/**
 * 判据 (吃源码文本, **先剥注释**):
 *   · 逐字段 `this.<name>` 实测计数必须与冻结值**双向相等**
 *     —— 多一处 = 新增泄漏; 少一处 = 改了代码没改账 (要求显式 rebase, 迁移必须是看得见的动作);
 *   · `migrated: true` 的字段访问必须为 0 —— 否则是假完成;
 *   · 每个字段的 `into` 必须落在 RunContext 目标清单里 —— 不然"外置"没有落点。
 */
export function scanRunContextLeaks(
  files: readonly SourceFile[],
  fields: readonly RunStateFieldLike[],
  opts: { target: readonly string[] },
): Finding[] {
  const out: Finding[] = [];
  for (const f of fields) {
    if (!opts.target.includes(f.into)) {
      out.push({ rule: 'runcontext-field-without-home', file: f.name, line: 1, what: `into='${f.into}' 不在 RunContext 目标清单里` });
    }
    // 口径: **匹配次数** (不是行数) —— 与 scanRunIdSeed 一致。一行含两处就读 2
    //   (2026-10-02 踩过: 两个判据一个按行、一个按匹配 ⇒ 同一条台账给出 37 / 38 两个答案)
    const rx = new RegExp(`this\\.${f.name}\\b`, 'g');
    let actual = 0;
    for (const file of files) {
      for (const raw of file.text.split('\n')) {
        actual += (stripLineComment(raw).match(rx) || []).length;
      }
    }
    if (actual !== f.accesses) {
      out.push({
        rule: 'runcontext-access-drift',
        file: f.name,
        line: 1,
        what: `实测 ${actual} 处 ≠ 冻结 ${f.accesses} 处 (${actual > f.accesses ? '新增泄漏' : '已减少 ⇒ 必须把台账下调到实测值'})`,
      });
    }
    if (f.migrated && actual > 0) {
      out.push({ rule: 'runcontext-migrated-but-leaking', file: f.name, line: 1, what: `标了 migrated 但还有 ${actual} 处 this. 访问` });
    }
  }
  return out;
}

/** K2 收尾: 从 seedRunContext 助手体里数"播种读取" —— 只数**助手体内**, 不数全仓同形字符串 */
export function extractSeedHelper(text: string): string {
  const i = text.indexOf('private seedRunContext(');
  if (i < 0) return '';
  const j = text.indexOf('\n  }', i);
  return j < 0 ? text.slice(i) : text.slice(i, j + 4);
}

/**
 * 判据 (吃源码文本, **先剥注释**):
 *   · `currentRunId` 总访问数 == 冻结值 (任何新读取点都判红, 含循环内部);
 *   · 播种读取 (`runId: this.currentRunId`) 恰好 `seedReads` 处, **且只在 seedRunContext 助手体内**;
 *   · 调用播种的入口数 == `seedSites` (且都必须在循环方法之外 —— 由"播种只存在于助手"间接保证);
 *   · 复位点 (`this.runCtx = createRunContext()`) 不得带播种 (清空不许携带身份)。
 */
export function scanRunIdSeed(
  files: readonly SourceFile[],
  opts: { frozenTotal: number; seedReads: number; seedSites: number },
): Finding[] {
  const out: Finding[] = [];
  const code = files.map((f) => f.text.split('\n').map(stripLineComment).join('\n')).join('\n');
  const total = (code.match(/this\.currentRunId\b/g) || []).length;
  if (total !== opts.frozenTotal) {
    out.push({ rule: 'runid-access-drift', file: 'agents/pi-sdk.ts', line: 1, what: `currentRunId 实测 ${total} 处 ≠ 冻结 ${opts.frozenTotal} (循环内不得新增读取点; 减少也要下调台账)` });
  }
  const helper = extractSeedHelper(code);
  const seedInHelper = (helper.match(/runId: this\.currentRunId\b/g) || []).length;
  const seedAnywhere = (code.match(/runId: this\.currentRunId\b/g) || []).length;
  if (seedInHelper !== opts.seedReads) {
    out.push({ rule: 'runid-seed-count', file: 'agents/pi-sdk.ts', line: 1, what: `seedRunContext 体内播种读取 ${seedInHelper} 处 ≠ 冻结 ${opts.seedReads}` });
  }
  // 注: 这里**不**判"全文件播种模式出现几次" —— harness 上下文 / startRun 等处本就有同形字符串
  // (`runId: this.currentRunId || undefined` 等), 那条规则会假阳性。别处偷偷加播种已由上面的
  // "总访问数 == 冻结值" 覆盖 (任何新读取点都会让总数变)。2026-10-02 实测: 该规则误报 8 处后删除。
  const sites = (code.match(/this\.seedRunContext\(/g) || []).length;
  if (sites !== opts.seedSites) {
    out.push({ rule: 'runid-seed-sites', file: 'agents/pi-sdk.ts', line: 1, what: `调用播种的入口 ${sites} 处 ≠ 冻结 ${opts.seedSites}` });
  }
  const resets = (code.match(/this\.runCtx = createRunContext\(\)/g) || []).length;
  if ((code.match(/this\.runCtx = this\.seedRunContext\(\)/g) || []).length > 0) {
    out.push({ rule: 'runid-seed-on-reset', file: 'agents/pi-sdk.ts', line: 1, what: '复位点带了播种 (清空不许携带身份)' });
  }
  if (resets < 5) out.push({ rule: 'runid-reset-missing', file: 'agents/pi-sdk.ts', line: 1, what: `复位点只剩 ${resets} 处 (期望 ≥5)` });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// K5 门: Channel Actor 台账 (完整性 + 与盘上事实同步 + 跨台账一致)
// ─────────────────────────────────────────────────────────────────────────────

export interface ActorStateItemLike { name: string; why: string; owner: string }
export interface K5LedgerLike {
  stateItems: readonly ActorStateItemLike[];
  acceptance: readonly string[];
  steps: readonly string[];
  preconditions: readonly string[];
  inheritedFields: readonly { name: string; into: string; accesses: number }[];
  progress: {
    stage: string; containerPath: string;
    fieldsMigrated: number; fieldsTotal: number;
    /** 已迁字段名单 —— 必须与 fieldsMigrated 数量一致 (见判据 ③b) */
    migratedFieldNames?: readonly string[];
    entriesWired: number; entriesTotal: number;
    /** K5 步骤④ 细粒度进度 (file/total/wired 都要与盘上重算结果一致) */
    entrySites: { file: string; total: number; wired: number };
    /** K5 第 4 步的 history 操作搬迁位 (与 historyOpsNames 数量必须一致) */
    historyOpsMigrated: number; historyOpsTotal: number;
    historyOpsNames?: readonly string[];
  };
}

/**
 * 判据 (纯函数; 盘上事实由 `exists` 注入):
 *   ① 清单完整: Actor 状态 9 项 (名字唯一) · 验收 ≥6 · 步骤 8 · 删除前置 7;
 *   ② **与盘上事实同步**: 标 `not-started` ⇒ 容器文件**必须不存在**; 容器存在 ⇒ stage 必须已过 not-started;
 *   ③ 进度棘轮: `fieldsMigrated ≤ fieldsTotal` · `entriesWired ≤ entriesTotal` · not-started ⇒ 两个计数都必须是 0;
 *   ④ **跨台账一致**: 从 K2 移交的 4 个 session 字段, 其冻结访问数必须与 K2 台账逐字相等;
 *   ⑤ 验收标准里必须真的接住从 K2 移过来的那条 (history 不互相污染)。
 */
export function scanActorLedger(
  ledger: K5LedgerLike,
  opts: { exists: (rel: string) => boolean; k2SessionFields: readonly { name: string; accesses: number }[] },
): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, what: string) => out.push({ rule, file: 'kernel/plan-channel-actor.ts', line: 1, what });

  // ① 完整性
  if (ledger.stateItems.length !== 9) f('actor-state-count', `Actor 状态项 ${ledger.stateItems.length} 项 ≠ 9`);
  const names = ledger.stateItems.map((i) => i.name);
  if (new Set(names).size !== names.length) f('actor-state-dup', 'Actor 状态项有重名');
  for (const i of ledger.stateItems) {
    if (!i.name || !i.why || !i.owner) f('actor-state-shape', `状态项字段不全: ${i.name || '(空)'}`);
  }
  if (ledger.acceptance.length < 6) f('actor-acceptance-count', `验收标准 ${ledger.acceptance.length} 条 < 6`);
  if (ledger.steps.length !== 8) f('actor-steps-count', `迁移步骤 ${ledger.steps.length} 步 ≠ 8`);
  if (ledger.preconditions.length !== 7) f('actor-precond-count', `删除前置 ${ledger.preconditions.length} 条 ≠ 7`);
  if (!ledger.acceptance.some((a) => a.includes('history') && (a.includes('污染') || a.includes('隔离')))) {
    f('actor-handoff-missing', '验收标准没有接住从 K2 移来的「history 不互相污染」');
  }

  // ② 与盘上事实同步
  const containerExists = opts.exists(ledger.progress.containerPath);
  if (ledger.progress.stage === 'not-started' && containerExists) {
    f('actor-stage-stale', `标了 not-started 但 ${ledger.progress.containerPath} 已存在 ⇒ 台账该改`);
  }
  if (ledger.progress.stage !== 'not-started' && !containerExists) {
    f('actor-container-missing', `stage=${ledger.progress.stage} 但容器文件不存在 ⇒ 假进度`);
  }

  // ③ 进度棘轮
  if (ledger.progress.fieldsMigrated > ledger.progress.fieldsTotal) f('actor-fields-overflow', 'fieldsMigrated > fieldsTotal');
  if (ledger.progress.entriesWired > ledger.progress.entriesTotal) f('actor-entries-overflow', 'entriesWired > entriesTotal');
  if (ledger.progress.entrySites.wired > ledger.progress.entrySites.total) f('actor-entrysites-overflow', 'entrySites.wired > entrySites.total');
  if (ledger.progress.stage === 'not-started' && (ledger.progress.fieldsMigrated !== 0 || ledger.progress.entriesWired !== 0)) {
    f('actor-progress-premature', 'not-started 阶段不许有非零进度');
  }
  // ③b 进度位不许自说自话: 迁了几个字段, 就得逐个点名 (名字还必须都在移交字段里)
  const migrated = ledger.progress.migratedFieldNames ?? [];
  if (migrated.length !== ledger.progress.fieldsMigrated) {
    f('actor-fieldnames-mismatch', `fieldsMigrated=${ledger.progress.fieldsMigrated} 但名单 ${migrated.length} 个 ⇒ 进度位与名单不一致`);
  }
  for (const n of migrated) {
    if (!ledger.inheritedFields.some((x) => x.name === n)) {
      f('actor-fieldnames-unknown', `已迁名单里的 ${n} 不在移交字段 (K5_INHERITED_FIELDS) 里`);
    }
  }
  if (ledger.progress.stage === 'fields-migrated' && ledger.progress.fieldsMigrated !== ledger.progress.fieldsTotal) {
    f('actor-stage-ahead', `stage=fields-migrated 但 fieldsMigrated=${ledger.progress.fieldsMigrated}/${ledger.progress.fieldsTotal} ⇒ 阶段名超前`);
  }
  // ③c history 操作搬迁位: 搬了几个操作就得逐个点名, 名字必须 ∈ HISTORY_OPS, 且不许超总量
  const ops = ledger.progress.historyOpsNames ?? [];
  if (ops.length !== ledger.progress.historyOpsMigrated) {
    f('actor-ops-mismatch', `historyOpsMigrated=${ledger.progress.historyOpsMigrated} 但名单 ${ops.length} 个 ⇒ 进度位与名单不一致`);
  }
  if (ledger.progress.historyOpsMigrated > ledger.progress.historyOpsTotal) f('actor-ops-overflow', 'historyOpsMigrated > historyOpsTotal');
  for (const n of ops) {
    if (!HISTORY_OPS.includes(n)) f('actor-ops-unknown', `已搬操作 ${n} 不在 HISTORY_OPS 里`);
  }

  // ④ 跨台账一致 (K2 → K5)
  for (const k5 of ledger.inheritedFields) {
    const k2 = opts.k2SessionFields.find((x) => x.name === k5.name);
    if (!k2) { f('actor-inherit-unknown', `移交字段 ${k5.name} 在 K2 台账里找不到`); continue; }
    if (k2.accesses !== k5.accesses) {
      f('actor-inherit-drift', `${k5.name} 访问数 K5=${k5.accesses} ≠ K2=${k2.accesses} (两个台账必须逐字相等)`);
    }
  }
  if (ledger.inheritedFields.length !== opts.k2SessionFields.length) {
    f('actor-inherit-count', `移交字段 ${ledger.inheritedFields.length} 个 ≠ K2 session 级 ${opts.k2SessionFields.length} 个`);
  }
  return out;
}

/**
 * **K2 ↔ K5 交接契约** (2026-10-02 定): session 级字段必须**仍是实例字段**,
 * **除非 K5 台账 (migratedFieldNames) 声明它已迁**。
 *
 * 为什么需要这条: K2 的镜像规则原本是"session 级字段一律不许离开实例" —— 那是 K2 阶段的口径;
 * K5 第 4 步要做的事正是把 `messageHistory` 迁走。若把禁令写死, K5 一到就得改门 (门就成了橡皮章);
 * 若把禁令删掉, 半搬状态没人拦。⇒ 让**台账**当唯一的开关: 声明了才放行, 声明了不存在的字段也判红。
 */
export function scanSessionFieldResidence(
  code: string,
  sessionFields: readonly { name: string }[],
  migratedByK5: readonly string[],
): Finding[] {
  const out: Finding[] = [];
  const migrated = new Set(migratedByK5);
  for (const f of sessionFields) {
    if (migrated.has(f.name)) continue;   // K5 已声明迁移 ⇒ 允许离开实例
    if (!new RegExp(`private\\s+${f.name}\\s*[=:]`).test(code)) {
      out.push({
        rule: 'session-field-vanished',
        file: 'agents/pi-sdk.ts',
        line: 1,
        what: `session 级字段 ${f.name} 既不在实例上, K5 台账也没声明迁移它 ⇒ 半搬状态`,
      });
    }
  }
  for (const n of migratedByK5) {
    if (!sessionFields.some((f) => f.name === n)) {
      out.push({
        rule: 'k5-migration-unknown-field',
        file: 'kernel/plan-channel-actor.ts',
        line: 1,
        what: `K5 声明迁移了 ${n}, 但它不是 K2 的 session 级字段`,
      });
    }
  }
  return out;
}

/**
 * **K5 第 4 步 — history 写入的"唯一漏斗"判据**。
 *
 * 迁移前的盘上事实 (2026-10-02 实测, 记在台账 `HISTORY_WRITE_SITES`):
 *   `this.messageHistory.push(` × 31 · `this.messageHistory.pop()` × 1 · 整体赋值 `this.messageHistory = ` × 3
 * 迁移目标: 全部收敛到三个漏斗方法 —— `pushHistory` / `popHistory` / `replaceHistory`。
 * ⇒ 判据: 每个直写模式在 `pi-sdk.ts` 里**必须是 0 处** (漏斗本体写 `this._history` / actor 方法, 不碰 `this.messageHistory`),
 *    且三个漏斗方法必须真的存在。
 * (注释必须先由调用方剥掉 —— 否则文档里的示例会被当成真写入。)
 */
export const HISTORY_WRITE_PATTERNS: readonly { id: string; src: string }[] = [
  { id: 'push', src: 'this\\.messageHistory\\.push\\(' },
  { id: 'pop', src: 'this\\.messageHistory\\.pop\\(\\)' },
  { id: 'assign', src: 'this\\.messageHistory\\s*=\\s' },
];

export const HISTORY_WRITE_FUNNEL: readonly string[] = ['pushHistory', 'popHistory', 'replaceHistory'];

export function scanHistoryWriteSites(code: string): Finding[] {
  const out: Finding[] = [];
  for (const p of HISTORY_WRITE_PATTERNS) {
    const n = (code.match(new RegExp(p.src, 'g')) ?? []).length;
    // 迁移后直写必须为 **0** —— 漏斗本体写的是 `this._history` / actor 的方法, 不碰 `this.messageHistory`
    if (n > 0) {
      out.push({
        rule: `history-direct-${p.id}`,
        file: 'agents/pi-sdk.ts',
        line: 1,
        what: `还有 ${n} 处 ${p.id} 直写 ⇒ 绕过了唯一漏斗 (pushHistory/popHistory/replaceHistory)`,
      });
    }
  }
  for (const name of HISTORY_WRITE_FUNNEL) {
    if (!new RegExp(`private\\s+${name}\\(`).test(code)) {
      out.push({
        rule: 'history-funnel-missing',
        file: 'agents/pi-sdk.ts',
        line: 1,
        what: `写入漏斗 ${name} 不见了 (调用点会全部落到直写或编译失败)`,
      });
    }
  }
  return out;
}

/**
 * **K5 步骤④ — 入口执行点的精确计数口径** (判据与台账必须用同一口径, 否则数字对不上):
 *   ① 只数 `.<promptStream>(` 与 `.<prompt>(` (**非流式也算** —— 它同样会启动一次执行);
 *   ② 先剥 `//` 行注释, 并丢掉 `*` 开头的块注释行 (否则注释里的示例会被当成执行点);
 *   ③ `excludeReceivers`: **已核实的非执行点 receiver** 名单 (台账里的数据, 冻结):
 *      `this` = CLI readline (`this.prompt('> ')`); `s` = index.ts 的 UI 打印助手 (`s.prompt('📩 …')`)。
 *      名单改动会出现在 diff 里 ⇒ 不能拿它偷偷把执行点数变小。
 */
export function countEntryExecutionPoints(
  code: string,
  opts: { excludeReceivers?: readonly string[]; methods?: readonly string[] } = {},
): number {
  const excludeReceivers = opts.excludeReceivers ?? ['this'];
  // **方法名单也是台账数据**: 启动一次执行的 AgentSession 方法 (不只是 prompt)
  //   —— 漏掉它会让 P2P 入站那种走 `summarizeDocument/improveDocument` 的入口永远数不到 (实测漏过 4 处)。
  const methods = opts.methods ?? ['prompt', 'promptStream'];
  let n = 0;
  for (const raw of code.split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(l)) continue;                                  // 块注释行
    for (const m of methods) {
      const rx = new RegExp(`\\.\\s*${m}\\s*\\(`, 'g');
      if (!rx.test(l)) continue;
      const recv = new RegExp(`([A-Za-z_$][\\w$]*|this)\\s*\\.\\s*${m}\\s*\\(`).exec(l);
      if (recv && excludeReceivers.includes(recv[1])) continue;        // 已核实的非执行点
      n += 1;
    }
  }
  return n;
}

/** 同一口径下**已投递**的点数 (`deliverThroughActor(` 的出现次数) */
export function countDeliveredPoints(code: string): number {
  return (code.match(/deliverThroughActor\(/g) ?? []).length;
}

/**
 * **K5 步骤④ — 入口投递的进度不许自报**: 台账里的 `total` / `wired` 都必须**从盘上重算**得到。
 *   少包一处却把 wired 写大 ⇒ 红; 新增执行点不登记 ⇒ 红; wired > total ⇒ 红; 台账里有盘上不存在的文件 ⇒ 红。
 */
export function scanEntryDelivery(
  sources: readonly { file: string; text: string }[],
  progressLike: {
    entrySites: readonly { file: string; total: number; wired: number; excludeReceivers?: readonly string[] }[];
    entryGroups?: readonly { entry: string; files: readonly string[]; wired: boolean }[];
    entriesWired?: number;
    entryMethods?: readonly string[];
  },
): Finding[] {
  const out: Finding[] = [];
  const f = (file: string, what: string) => out.push({ rule: 'entry-delivery-mismatch', file, line: 1, what });
  const methods = progressLike.entryMethods ?? ['prompt', 'promptStream'];
  const complete = new Set<string>();
  for (const s of progressLike.entrySites) {
    const src = sources.find((x) => x.file === s.file);
    if (!src) { f(s.file, `台账登记的文件在扫描面里不存在 ⇒ 口径不可信`); continue; }
    const total = countEntryExecutionPoints(src.text, { excludeReceivers: s.excludeReceivers ?? ['this'], methods });
    const wired = countDeliveredPoints(src.text);
    if (total !== s.total) f(s.file, `入口执行点盘上 ${total} 处 ≠ 台账 ${s.total} ⇒ 新增/删除没登记`);
    if (wired !== s.wired) f(s.file, `已投递盘上 ${wired} 处 ≠ 台账 ${s.wired} ⇒ 进度对不上事实`);
    if (s.wired > s.total) f(s.file, `wired ${s.wired} > total ${s.total}`);
    // `total === 0` (该文件没有执行点) 算**空真完成** —— 否则"入口声明完成"会因为它永远判红
    if (s.total === s.wired) complete.add(s.file);
  }
  // **入口级声明双向校验** (两侧都能判): 说完成了 ⇒ 它的文件必须全接完; 说没完成 ⇒ 必须真有文件没接完。
  const groups = progressLike.entryGroups ?? [];
  for (const g of groups) {
    const all = g.files.every((x) => complete.has(x));
    if (g.wired && !all) f(g.files[0], `入口「${g.entry}」标完成, 但 ${g.files.filter((x) => !complete.has(x)).join('/')} 还没接完`);
    if (!g.wired && all) f(g.files[0], `入口「${g.entry}」的文件都接完了, 却还标着未完成 ⇒ 台账该前进`);
  }
  if (progressLike.entriesWired !== undefined && progressLike.entriesWired !== groups.filter((g) => g.wired).length) {
    f('kernel/plan-channel-actor.ts', `entriesWired=${progressLike.entriesWired} ≠ 标完成的入口数 ${groups.filter((g) => g.wired).length}`);
  }
  return out;
}

/**
 * **K5 步骤⑤ — channel 级串行锁的开关必须与盘上事实一致** (双向):
 *   `enabled === true` ⇒ 必须真有调用点传了 `serializeByChannel: true`;
 *   `enabled === false` ⇒ 一个都不许有 (否则"台账说没启用, 代码却启用了");
 *   调用点数必须与台账 `callSites` 相等。
 */
export function scanChannelLock(
  sources: readonly { file: string; text: string }[],
  lock: { enabled: boolean; callSites: number },
): Finding[] {
  const out: Finding[] = [];
  const f = (what: string) => out.push({ rule: 'channel-lock-mismatch', file: 'kernel/plan-channel-actor.ts', line: 1, what });
  let sites = 0;
  for (const s of sources) {
    for (const raw of s.text.split(/\r?\n/)) {
      const l = raw.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(l)) continue;
      sites += (l.match(/serializeByChannel:\s*true/g) ?? []).length;
    }
  }
  if (sites !== lock.callSites) f(`盘上 ${sites} 个调用点传了 serializeByChannel:true ≠ 台账 ${lock.callSites}`);
  if (lock.enabled && sites === 0) f('台账说 channel 级串行已启用, 但盘上一个调用点都没传 ⇒ 假开关');
  if (!lock.enabled && sites > 0) f('台账说未启用, 但盘上已有调用点启用 ⇒ 台账落后于代码');
  return out;
}
