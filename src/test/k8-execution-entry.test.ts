/**
 * k8-execution-entry.test.ts — 「取唯一执行入口」的行为门 (2026-10-02)
 *
 * 为什么需要它: 这个助手原先的形状是 `return agent.runExecution;` —— **源码看起来完全正常, 类型也对**,
 * 但方法被**脱挂**后调用时 `this === undefined`; 而 `runExecution` 内部第一句正是
 * `this.applyExecutionRequest(req)` ⇒ 运行时报
 * `Cannot read properties of undefined (reading 'applyExecutionRequest')`。
 *
 * 后果 (实例真跑捞出来的): supervisor · 心跳 · 定时任务 · 消息主路径 多处调用全炸,
 * 而 UI 上只表现为"消息发了没回复", 日志里才看得到那一句。
 *
 * 门怎么判: 假 agent 的 `runExecution` **依赖 `this`** ⇒ 脱挂的实现必红; 取不到入口时响亮失败也要红。
 */
import { describe, it, expect } from 'vitest';
import { requireRunExecution } from '../agents/execution-entry.js';

describe('K8 唯一执行入口的取用 (行为门: 方法必须绑回原对象)', () => {
  it('① 取回的入口调用时 this 必须还在 (脱挂 ⇒ 判红)', async () => {
    const agent = {
      tag: 'ENTRY_BOUND_OK',
      applyExecutionRequest(_req: any) { return (this as any).tag; },
      async runExecution(req: any) {
        // 真 `runExecution` 的第一句就是这个形状 —— 脱挂调用会在这里炸
        return String((this as any).applyExecutionRequest(req));
      },
    };
    const run = requireRunExecution(agent as any);
    await expect(run({ input: 'x', channelId: 'ch' } as any)).resolves.toBe('ENTRY_BOUND_OK');
  });

  it('② 没提供唯一入口 ⇒ 响亮失败 (绝不静默回落直呼 prompt)', () => {
    expect(() => requireRunExecution({ prompt: async () => 'x' } as any))
      .toThrow(/拒绝直呼 prompt/);
  });
});
