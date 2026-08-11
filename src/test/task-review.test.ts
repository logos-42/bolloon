import { describe, it, expect } from 'vitest';
import {
  applyReviewRequest,
  applyReviewApprove,
  applyReviewReject,
} from '../web/task-review.js';

describe('task-review 审批通道 (Hermes request_review 模式)', () => {
  it('running/pending → review (挂起等审批)', () => {
    expect(applyReviewRequest('running')).toEqual({ status: 'review', phase: 'requested' });
    expect(applyReviewRequest('pending')).toEqual({ status: 'review', phase: 'requested' });
  });

  it('review → completed (审批通过放行)', () => {
    expect(applyReviewApprove('review')).toEqual({ status: 'completed', phase: 'approved' });
  });

  it('review → pending (审批驳回退回队列)', () => {
    expect(applyReviewReject('review')).toEqual({ status: 'pending', phase: 'rejected' });
  });

  it('非 review 态 approve/reject → not-reviewable', () => {
    for (const s of ['pending', 'running', 'completed', 'failed', 'cancelled', 'cancel-requested', 'paused'] as const) {
      expect(applyReviewApprove(s).phase).toBe('not-reviewable');
      expect(applyReviewReject(s).phase).toBe('not-reviewable');
    }
  });

  it('终态不可请求审批', () => {
    for (const s of ['completed', 'failed', 'cancelled', 'review', 'cancel-requested', 'paused'] as const) {
      expect(applyReviewRequest(s).phase).toBe('not-reviewable');
    }
  });

  it('review 不重复请求 (已在通道)', () => {
    expect(applyReviewRequest('review').phase).toBe('not-reviewable');
  });
});
