/**
 * task-cancel.ts — 任务取消两段式状态机 (借鉴 Hermes `SubagentState`:
 *   CANCEL_REQUESTED → CANCELLED, 区分"请求已受理"与"实际已停止")
 *
 * 纯函数, 无 express/io 依赖 — 路由和 executor 共用, 可单测。
 */

export type TaskCancelableStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancel-requested'
  | 'cancelled';

export interface CancelTransition {
  /** 取消后应落到的状态 */
  status: 'cancelled' | 'cancel-requested';
  /** 语义: direct=pending 直接终态 / requested=running 先受理 / already-requested / terminal=已终态不可取消 */
  phase: 'direct' | 'requested' | 'already-requested' | 'terminal';
}

/**
 * 应用一次取消请求 (第一段)。
 * - pending: 从未开始 → 直接 cancelled (请求即完成, 不会卡在中间态)
 * - running: → cancel-requested (请求受理, 等 executor 观测后落 cancelled)
 * - cancel-requested: 幂等返回 already-requested
 * - 其余终态: terminal, 不可取消
 */
export function applyCancelRequest(status: TaskCancelableStatus): CancelTransition {
  switch (status) {
    case 'pending':
      return { status: 'cancelled', phase: 'direct' };
    case 'running':
      return { status: 'cancel-requested', phase: 'requested' };
    case 'cancel-requested':
      return { status: 'cancel-requested', phase: 'already-requested' };
    default:
      return { status: 'cancelled', phase: 'terminal' };
  }
}

/**
 * executor 完成/异常时调用 (第二段): 若任务处于 cancel-requested, 应落 cancelled 而非正常终态。
 */
export function shouldFinalizeAsCancelled(status: TaskCancelableStatus): boolean {
  return status === 'cancel-requested';
}

/** 取消请求是否已受理 (running 任务的第一段) */
export function isCancelPending(status: TaskCancelableStatus): boolean {
  return status === 'cancel-requested';
}
