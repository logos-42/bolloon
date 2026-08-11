import { describe, it, expect } from 'vitest';
import {
  applyCancelRequest,
  shouldFinalizeAsCancelled,
  isCancelPending,
} from '../web/task-cancel.js';

describe('task-cancel 两段式状态机 (Hermes CANCEL_REQUESTED → CANCELLED 模式)', () => {
  it('pending → cancelled (direct: 从未开始, 请求即完成)', () => {
    const t = applyCancelRequest('pending');
    expect(t).toEqual({ status: 'cancelled', phase: 'direct' });
    expect(shouldFinalizeAsCancelled('pending')).toBe(false);
  });

  it('running → cancel-requested (第一段: 请求已受理)', () => {
    const t = applyCancelRequest('running');
    expect(t).toEqual({ status: 'cancel-requested', phase: 'requested' });
    expect(isCancelPending('cancel-requested')).toBe(true);
    // executor 观测到请求后落终态 (第二段)
    expect(shouldFinalizeAsCancelled('cancel-requested')).toBe(true);
  });

  it('cancel-requested 幂等 (already-requested)', () => {
    const t = applyCancelRequest('cancel-requested');
    expect(t).toEqual({ status: 'cancel-requested', phase: 'already-requested' });
  });

  it('终态不可取消 (completed/failed/cancelled/paused)', () => {
    for (const s of ['completed', 'failed', 'cancelled', 'paused'] as const) {
      const t = applyCancelRequest(s);
      expect(t.phase).toBe('terminal');
    }
    expect(shouldFinalizeAsCancelled('completed')).toBe(false);
    expect(shouldFinalizeAsCancelled('failed')).toBe(false);
  });

  it('异常路径: 取消请求在先 → executor 落 cancelled 而非 failed', () => {
    // 语义: catch 分支里 status==='cancel-requested' 时改落 cancelled
    expect(shouldFinalizeAsCancelled('cancel-requested')).toBe(true);
    expect(shouldFinalizeAsCancelled('running')).toBe(false);
  });
});
