/**
 * task-review.ts — 任务 review 审批通道状态机 (借鉴 Hermes kanban 9 态:
 *   request_review 把任务挂进 review 通道, complete_task 接受 review→done)
 *
 * 纯函数, 无 express/io 依赖 — 路由共用, 可单测。
 */

export type ReviewableStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancel-requested'
  | 'cancelled'
  | 'review';

export interface ReviewTransition {
  /** 转换后的状态 */
  status: ReviewableStatus;
  /** 语义: requested=进入审批通道 / approved=放行完成 / rejected=退回队列 / not-reviewable=当前态不可操作 */
  phase: 'requested' | 'approved' | 'rejected' | 'not-reviewable';
}

/** 请求审批: running/pending → review (挂起等人工/审查者放行) */
export function applyReviewRequest(status: ReviewableStatus): ReviewTransition {
  if (status === 'running' || status === 'pending') {
    return { status: 'review', phase: 'requested' };
  }
  return { status, phase: 'not-reviewable' };
}

/** 审批通过: review → completed (放行) */
export function applyReviewApprove(status: ReviewableStatus): ReviewTransition {
  if (status === 'review') {
    return { status: 'completed', phase: 'approved' };
  }
  return { status, phase: 'not-reviewable' };
}

/** 审批驳回: review → pending (退回队列, 可重新认领执行) */
export function applyReviewReject(status: ReviewableStatus): ReviewTransition {
  if (status === 'review') {
    return { status: 'pending', phase: 'rejected' };
  }
  return { status, phase: 'not-reviewable' };
}
