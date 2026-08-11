/**
 * task-deps.ts — 任务父依赖校验 (借鉴 Hermes kanban 认领点父依赖不变式:
 *   claim 时强制检查所有父任务 done/archived, 否则 demote 回 todo)
 *
 * 纯函数。bolloon 终态语义: completed/cancelled 视为父已结束 (依赖解除);
 * failed 视为父未成功 (子任务不满足前提, 阻塞等人工决策)。
 */

export type DepTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancel-requested'
  | 'cancelled'
  | 'review';

const PARENT_DONE_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled']);

/** 父依赖是否满足: 无父 / 父全部 completed|cancelled → true; 父 missing/failed/running/pending → false */
export function parentsSatisfied(
  task: { parentIds?: string[] } | undefined,
  allTasks: Array<{ id: string; status: string }>
): boolean {
  const parentIds = task?.parentIds;
  if (!parentIds || parentIds.length === 0) return true;
  for (const pid of parentIds) {
    const parent = allTasks.find((t) => t.id === pid);
    // 父不存在 → 保守阻塞 (依赖悬空, 等人工修复)
    if (!parent) return false;
    if (!PARENT_DONE_STATUSES.has(parent.status)) return false;
  }
  return true;
}

/** 列出未满足的父任务 id (诊断用) */
export function unsatisfiedParents(
  task: { parentIds?: string[] } | undefined,
  allTasks: Array<{ id: string; status: string }>
): string[] {
  const parentIds = task?.parentIds;
  if (!parentIds || parentIds.length === 0) return [];
  const out: string[] = [];
  for (const pid of parentIds) {
    const parent = allTasks.find((t) => t.id === pid);
    if (!parent || !PARENT_DONE_STATUSES.has(parent.status)) out.push(pid);
  }
  return out;
}
