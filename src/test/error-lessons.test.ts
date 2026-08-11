import { describe, it, expect } from 'vitest';
import { classifyApiError, ErrorLessonStore, planRecovery, MAX_RECOVERY_ATTEMPTS } from '../llm/error-lessons.js';

describe('classifyApiError (Hermes error_classifier 模式)', () => {
  it('rate-limit: 429 / rate limit / quota', () => {
    for (const m of ['429 Too Many Requests', 'rate limit exceeded', 'quota exhausted']) {
      const c = classifyApiError(new Error(m));
      expect(c.category).toBe('rate-limit');
      expect(c.recovery).toBe('backoff-retry');
      expect(c.recoverable).toBe(true);
    }
  });

  it('context-overflow: token/context length', () => {
    for (const m of ['maximum context length exceeded', 'token limit reached', 'context window too small', '请求过长超过 token 上限']) {
      expect(classifyApiError(new Error(m)).category).toBe('context-overflow');
    }
    expect(classifyApiError(new Error('context length exceeded')).recovery).toBe('compact-retry');
  });

  it('auth: 401/403/402/invalid key → 不重试', () => {
    for (const m of ['401 Unauthorized', '403 Forbidden', 'invalid api key', 'permission denied']) {
      const c = classifyApiError(new Error(m));
      expect(c.category).toBe('auth');
      expect(c.recoverable).toBe(false);
      expect(c.recovery).toBe('no-retry');
    }
  });

  it('network: ECONNRESET/timeout/undici → retry-once', () => {
    for (const m of ['ECONNRESET', 'fetch failed: other side closed', 'ETIMEDOUT', 'undici socket error']) {
      const c = classifyApiError(new Error(m));
      expect(c.category).toBe('network');
      expect(c.recovery).toBe('retry-once');
    }
  });

  it('server: 5xx → backoff', () => {
    expect(classifyApiError(new Error('503 Service Unavailable')).category).toBe('server');
    expect(classifyApiError(new Error('internal server error')).category).toBe('server');
  });

  it('未知 → unknown, 不重试', () => {
    const c = classifyApiError(new Error('weird thing happened'));
    expect(c.category).toBe('unknown');
    expect(c.recoverable).toBe(false);
  });
});

describe('ErrorLessonStore (会话级教训: 同类只学一次)', () => {
  it('同类错误第二次 learn → isNewLesson=false (去重)', () => {
    const store = new ErrorLessonStore();
    const first = store.learn(new Error('429 Too Many Requests'));
    expect(first.isNewLesson).toBe(true);
    expect(first.classified.category).toBe('rate-limit');
    const second = store.learn(new Error('rate limit hit again'));
    expect(second.isNewLesson).toBe(false);
    expect(store.size).toBe(1);
  });

  it('不同类错误各自学一次', () => {
    const store = new ErrorLessonStore();
    store.learn(new Error('429 Too Many Requests'));
    store.learn(new Error('context length exceeded'));
    store.learn(new Error('401 Unauthorized'));
    expect(store.size).toBe(3);
  });

  it('recoveryFor 查询已学恢复动作; 未学 → undefined', () => {
    const store = new ErrorLessonStore();
    store.learn(new Error('fetch failed: other side closed'));
    expect(store.recoveryFor('network')).toBe('retry-once');
    expect(store.recoveryFor('auth')).toBeUndefined();
  });

  it('reset 清空', () => {
    const store = new ErrorLessonStore();
    store.learn(new Error('429'));
    store.reset();
    expect(store.size).toBe(0);
  });
});

describe('planRecovery (Hermes recovery hints → 可执行重试计划)', () => {
  it('rate-limit → backoff-retry, 退避指数递增', () => {
    const c = classifyApiError(new Error('429 Too Many Requests'));
    expect(planRecovery(c, 0).shouldRetry).toBe(true);
    expect(planRecovery(c, 0).backoffMs).toBe(1000);
    expect(planRecovery(c, 1).backoffMs).toBe(2000);
    expect(planRecovery(c, 2).backoffMs).toBe(4000);
  });

  it('network → retry-once 只在 attempt 0 重试', () => {
    const c = classifyApiError(new Error('ECONNRESET'));
    expect(planRecovery(c, 0).shouldRetry).toBe(true);
    expect(planRecovery(c, 0).backoffMs).toBe(1500);
    expect(planRecovery(c, 1).shouldRetry).toBe(false); // 只重试 1 次
  });

  it('context-overflow → shouldRetry false (交给上层 compact), 标注 recovery', () => {
    const c = classifyApiError(new Error('context length exceeded'));
    const p = planRecovery(c, 0);
    expect(p.shouldRetry).toBe(false);
    expect(p.recovery).toBe('compact-retry');
  });

  it('auth → 不重试', () => {
    const c = classifyApiError(new Error('401 invalid api key'));
    expect(planRecovery(c, 0).shouldRetry).toBe(false);
    expect(planRecovery(c, 0).backoffMs).toBe(0);
  });

  it('MAX_RECOVERY_ATTEMPTS 有上限 (防无限循环)', () => {
    expect(MAX_RECOVERY_ATTEMPTS).toBe(3);
  });
});
