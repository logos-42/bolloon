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

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 抽出所有 import/export-from/动态 import 的说明符 + 行号 */
export function importSpecifiers(text: string): Array<{ line: number; spec: string }> {
  const out: Array<{ line: number; spec: string }> = [];
  text.split('\n').forEach((raw, i) => {
    if (isCommentOnly(raw)) return;
    const line = stripLineComment(raw);
    FROM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FROM_RE.exec(line)) !== null) {
      const spec = m[1] ?? m[2];
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
