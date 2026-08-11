/**
 * task-verify.ts — 任务完成防幻觉校验 (借鉴 Hermes complete_task:
 *   created_cards 逐 id 验证 → 幽灵卡阻止完成; 散文引用不解析 → suspected_hallucinated_references 事件)
 *
 * Bolloon 版 (advisory 不阻塞): 完成时校验 result 里引用的任务 id 和本地文件路径,
 *   不存在的 → warning 列表 (存 task.warnings + broadcast), 不阻止完成 (单次同步执行无法返工).
 */

import * as path from 'path';

/** 提取 result 里的任务 id 引用 (task_xxx 模式) — 校验是否幽灵引用 */
export function extractTaskReferences(text: string): string[] {
  const re = /\btask_[a-z0-9]+/gi;
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[0].toLowerCase());
  return [...out];
}

/** 提取 result 里的本地文件路径引用 (markdown 链接 + 反引号路径 + path:line), 不含 URL; cap 20 条 */
export function extractFileReferences(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const p = m[1];
    if (!/^[a-z]+:\/\//i.test(p)) out.add(p);
  }
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const p = m[1].trim();
    if (p.includes('/') || p.includes('\\') || /\.(md|ts|tsx|js|jsx|json|py|txt)$/i.test(p)) out.add(p);
  }
  return [...out].slice(0, 20);
}

export interface VerifyResult {
  warnings: string[];
  /** 通过检查的引用数 (用于日志) */
  checkedCount: number;
}

/**
 * 校验任务完成结果: 任务 id 引用必须在队列中存在; 文件路径引用必须存在 (相对 cwd 解析).
 * 纯 IO 校验, 不修改任务状态 — 返回 warning 列表 (幽灵引用, advisory 不阻塞).
 */
export async function verifyTaskResult(
  result: string,
  opts: { knownTaskIds: string[]; cwd?: string; fs?: typeof import('fs/promises') }
): Promise<VerifyResult> {
  const warnings: string[] = [];
  const known = new Set(opts.knownTaskIds);

  const taskRefs = extractTaskReferences(result);
  for (const ref of taskRefs) {
    if (!known.has(ref)) {
      warnings.push(`result 引用不存在的任务 ${ref} (疑似幻觉引用)`);
    }
  }

  let checkedCount = taskRefs.length;
  const fileRefs = extractFileReferences(result);
  const fsMod = opts.fs ?? (await import('fs/promises'));
  const base = opts.cwd ?? process.cwd();
  for (const ref of fileRefs) {
    checkedCount++;
    const abs = ref.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(ref) ? ref : path.resolve(base, ref);
    try {
      await fsMod.access(abs);
    } catch {
      warnings.push(`result 引用不存在的文件 ${ref} (疑似幻觉引用)`);
    }
  }

  return { warnings, checkedCount };
}
