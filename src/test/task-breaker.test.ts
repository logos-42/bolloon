import { describe, it, expect } from 'vitest';
import { recordTaskFailure, resetTaskFailures, DEFAULT_FAILURE_LIMIT } from '../web/task-breaker.js';

describe('任务熔断器 (Hermes consecutive_failures 模式)', () => {
  it('连续失败递增, 达到默认阈值 (3) 熔断', () => {
    let task = { consecutiveFailures: 0 };
    const r1 = recordTaskFailure(task);
    expect(r1).toEqual({ consecutiveFailures: 1, tripped: false });
    const r2 = recordTaskFailure({ consecutiveFailures: r1.consecutiveFailures });
    expect(r2.consecutiveFailures).toBe(2);
    expect(r2.tripped).toBe(false);
    const r3 = recordTaskFailure({ consecutiveFailures: r2.consecutiveFailures });
    expect(r3.consecutiveFailures).toBe(3);
    expect(r3.tripped).toBe(true);
  });

  it('per-task failureLimit 覆盖默认', () => {
    const r = recordTaskFailure({ consecutiveFailures: 1, failureLimit: 2 });
    expect(r.tripped).toBe(true);
    const r2 = recordTaskFailure({ consecutiveFailures: 1, failureLimit: 10 });
    expect(r2.tripped).toBe(false);
  });

  it('env 阈值第二优先级', () => {
    const r = recordTaskFailure({ consecutiveFailures: 3 }, 5);
    expect(r).toEqual({ consecutiveFailures: 4, tripped: false });
    const r2 = recordTaskFailure({ consecutiveFailures: r.consecutiveFailures }, 5);
    expect(r2.tripped).toBe(true);
  });

  it('成功完成清零', () => {
    expect(resetTaskFailures()).toEqual({ consecutiveFailures: 0 });
  });

  it('默认阈值可导出 (3)', () => {
    expect(DEFAULT_FAILURE_LIMIT).toBe(3);
  });
});
