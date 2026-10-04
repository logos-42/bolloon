/**
 * 代码写改的"类型门" (2026-10-01, 回应「tsc 抓错这个功能 bolloon 有吗」)。
 *
 * 查到的事实: bolloon **早就**有类型检查, 而且有三层 —— pre-commit 的 `tsc-check`(lefthook) ·
 *   `build:main = tsc && …` · 以及**给智能体的工具** `tsc_check`(pi-sdk-tools.ts:1450, 60s timeout)。
 * 但**循环里没有"编辑后自动检查"** ✗ ⇒ `tsc_check` 是个"模型想得起来才会调"的工具 ✓
 *   ⇒ 和 #4(写操作读回)同一个病: **规矩写了, 没人执行** ✓。
 * 这条把它变成机制: 本回合**改过 .ts/.tsx** ⇒ 回合收尾**自动**跑一次类型检查(一轮只跑一次, 不管改了 1 个还是 8 个文件 ✓),
 *   结果以一行状态进对话流 —— "类型过没过"不再依赖模型自觉 ✓。
 * 纪律: 每个回合最多一次(tsc 是秒级开销, 但也不该每改一个文件就跑) · 只对 TS 源码生效 · 失败绝不影响回合结果 ✓。
 */

/** 写/改类工具里, 会"产出源码"的那些 */
export const CODE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'patch', 'move_file', 'copy_file']);

export function isTypeScriptFile(p: string): boolean {
  return /\.(ts|tsx|mts|cts)$/i.test(String(p || '').trim());
}

/**
 * 这次写操作是否**产生了/改动了 TS 源码** ⇒ 返回那个路径(否则 null)。
 * 只看路径, 不看内容(便宜且够用 ✓)。
 */
export function codeWriteTarget(toolName: string, args: any): string | null {
  if (!CODE_WRITE_TOOLS.has(String(toolName))) return null;
  const rel = String(args?.path ?? args?.to ?? args?.file ?? '').trim();
  if (!rel) return null;
  return isTypeScriptFile(rel) ? rel : null;
}

/**
 * 回合收尾要不要跑类型检查: 改过 TS 且本回合还没跑过 ⇒ 跑。
 * 抽成纯函数是为了**可测**: "一轮只跑一次"这条最容易写错(写成每个文件跑一次就把时间烧光 ✓)。
 */
export function decideTypecheck(touched: string[], ranThisTurn: boolean): boolean {
  return !ranThisTurn && touched.length > 0;
}

/** 类型检查结果 ⇒ **一行**状态 (给对话流看; 错误多时只给前几条 + 总数) */
export function formatTypecheckResult(ok: boolean, output: string, maxLines = 6): string {
  const body = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (ok) return '✅ 类型检查通过 (tsc --noEmit, 本回合改过 TS 后自动跑)';
  const errs = body.filter((l) => /error TS\d+/.test(l));
  const head = (errs.length ? errs : body).slice(0, maxLines);
  const more = (errs.length || body.length) - head.length;
  return `❌ 类型检查没过: ${errs.length || '?'} 个错误\n` + head.map((l) => `   ${l.slice(0, 160)}`).join('\n')
    + (more > 0 ? `\n   …还有 ${more} 条` : '')
    + '\n   ⇒ **先修类型再继续**(别在同一轮里叠加更多改动)';
}
