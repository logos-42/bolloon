// routes-hearth.test.ts — smoke test via express mocked
// 真实端到端测试在 scripts/ablation 跑; 这里只验 registerHearthRoutes 不会抛.
import { describe, it, expect } from 'vitest';

describe('routes-hearth registration', () => {
  it('imports 模块不抛', async () => {
    const m = await import('../../web/routes-hearth.js');
    expect(typeof m.registerHearthRoutes).toBe('function');
  });
});
