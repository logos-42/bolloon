/**
 * write-verify.ts — 写操作「读回自证」: 写类工具成功后**自动**核一次, 把事实拼进结果。
 *
 * 为什么要有 (2026-10-01 优化 #4 的原意): 过程纪律写了"写回一次验证", 但**没人执行** ✗
 *   ⇒ 现在由机制执行: 「工具说成功 ≠ 任务成功」。只做**便宜**的核对 (存在性 / 大小 / mtime);
 *   核对失败**不许**把工具搞失败 (它只是附加事实)。
 *
 * K10 ⑦ (2026-10-02) 把它从 `pi-sdk.ts` 拆出来的两个原因:
 *   ① **要接进 `pi-sdk-tools.ts` 的写类工具** —— 留在 `pi-sdk.ts` 里会与 tools 形成循环 import;
 *   ② **原实现踩了 ESM 陷阱**: 函数体里写 `require('node:fs')`, 而打包产物是 ESM ⇒ `require` 未定义
 *      ⇒ 被自己的 `catch` 吞成 `[未核对] 读回失败: require is not defined` ——
 *      也就是说: 它此前**一次都没成功过**, 且接上去也只会报假失败 (本仓有记录的坑)。
 *      ⇒ 本模块一律**静态 import** (同步函数也不例外)。
 */
import * as fsMod from 'node:fs';
import * as pathMod from 'node:path';

/** 哪些工具算"写类" (只有它们才读回自证) */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'mkdir',
  'move_file',
  'copy_file',
]);

/**
 * 读回一次并把事实变成一行字。
 *   返回 `null` = 不适用 (非写类工具 / 没有路径参数) —— 调用方据此决定要不要拼。
 *   返回 `[已核对] …` = 存在性/大小/mtime 已核实。
 *   返回 `[未核对] …` = 读回失败 (路径/权限), 调用方应把这句话带给模型: "别急着说已完成"。
 */
export function verifyWriteOutcome(toolName: string, args: unknown, cwd: string): string | null {
  try {
    if (!WRITE_TOOLS.has(String(toolName))) return null;
    const a = (args ?? {}) as Record<string, unknown>;
    const rel = String(a.path ?? a.to ?? a.dir ?? '').trim();
    if (!rel) return null;
    const abs = pathMod.isAbsolute(rel) ? rel : pathMod.resolve(cwd, rel);
    const st = fsMod.statSync(abs);
    if (st.isDirectory()) return `[已核对] 目录存在: ${rel}`;
    return `[已核对] 文件已落盘: ${rel} (${st.size} 字节, ${new Date(st.mtimeMs).toISOString()})`;
  } catch (e) {
    return `[未核对] 读回失败: ${String((e as Error)?.message || e).slice(0, 80)} —— 别急着说"已完成", 先确认路径/权限`;
  }
}

/**
 * 把一个成功的工具结果**拼上**读回事实 (写类工具的成功返回统一走这里)。
 *   非写类 / 没有路径 ⇒ 原样返回 (不改变既有输出)。
 */
export function withWriteVerified<T extends { success: boolean; output?: string; error?: string }>(
  toolName: string,
  args: unknown,
  cwd: string,
  result: T,
): T {
  if (!result?.success) return result;
  const fact = verifyWriteOutcome(toolName, args, cwd);
  if (!fact) return result;
  return { ...result, output: `${result.output ?? ''} ${fact}`.trim() };
}
