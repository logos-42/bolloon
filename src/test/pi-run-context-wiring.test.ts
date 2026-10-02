/**
 * RunContext 接线门 (K2 每一格迁移后都要过的行为级检查)
 *
 * 为什么要有它: `pi-sdk.ts` 里"取消 / 推流"这类语义以前靠两个实例字段
 * (`currentOnStream` / `currentSignal`) 隐式共享给两个循环。K2 把它们搬进 `RunContext`
 * 之后, 接线一旦漏一处, **症状是"取消不生效 / 流断在半路"**, 而不是编译错误。
 * 仓里此前**没有任何测试覆盖 promptStream 的取消语义** (pi-sdk.test.ts 里那个
 * AbortController 自己标注为"装饰性"), 所以这里补上:
 *
 *   ① 单元: `createRunContext` 的语义 (未给字段显式置空, 不继承上一个 Run 的残留);
 *   ② 源码: 已迁移字段**不许**再以实例字段形式出现; 入口必须把 eventSink/abortSignal 建进 Context;
 *      两个循环必须从 Context 取值 (而不是读实例字段);
 *   ③ 变异: 把旧字段声明注回源码文本 ⇒ 判据必须判红 (在内存里变异, 不动盘)。
 *
 * 口径: 判据吃源码文本, **先剥注释**(本仓踩过三次的坑)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { createRunContext } from '../agents/run-context.js';
import { RUN_CONTEXT_FIELDS, RUN_CONTEXT_DONE } from '../kernel/plan-runcontext.js';
import { K5_PROGRESS } from '../kernel/plan-channel-actor.js';
import { scanSessionFieldResidence } from '../kernel/gate-scan.js';
import { stripLineComment } from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');

/** 剥注释 (逐行) */
function strip(text: string): string {
  return text.split('\n').map(stripLineComment).join('\n');
}

/** 检查器 (纯函数, 吃源码文本) —— 返回违规清单 */
function scanWiring(piSdk: string): string[] {
  const code = strip(piSdk);
  const bad: string[] = [];
  // a) 已迁移的字段不许再有实例字段声明
  for (const field of ['currentOnStream', 'currentSignal']) {
    if (new RegExp(`private\\s+${field}\\s*:`).test(code)) bad.push(`实例字段声明还在: ${field}`);
  }
  // b) 两个入口必须把已外置字段建进 Context
  if (!code.includes('eventSink: options?.onStream ?? null')) bad.push('promptStream 入口没把 eventSink 建进 Context');
  if (!code.includes('abortSignal: options?.signal ?? null')) bad.push('promptStream 入口没把 abortSignal 建进 Context');
  if (!code.includes('eventSink: onStream, abortSignal: signal ?? null')) bad.push('pivot 入口没把 eventSink/abortSignal 建进 Context');
  // c) 循环必须从 Context 取值
  if (!code.includes('this.runCtx.eventSink ?? undefined')) bad.push('循环没有从 Context 取 eventSink');
  if (!code.includes('this.runCtx.abortSignal ?? undefined')) bad.push('循环没有从 Context 取 abortSignal');
  // d) 已迁移字段的残留访问 (this.<field>)
  for (const field of RUN_CONTEXT_DONE) {
    if (new RegExp(`this\\.${field}\\b`).test(code)) bad.push(`已迁移字段仍有 this. 访问: ${field}`);
  }
  // e) 清空 = 换空 Context
  const resets = (code.match(/this\.runCtx = createRunContext\(\)/g) || []).length;
  if (resets < 5) bad.push(`"用完即清"不到位: createRunContext() 复位只有 ${resets} 处 (期望 ≥5)`);
  return bad;
}

const PI = fs.readFileSync(path.join(SRC, 'agents/pi-sdk.ts'), 'utf8');

describe('K2 接线门: RunContext 行为级接线', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(PI.length).toBeGreaterThan(100000);
    expect(RUN_CONTEXT_DONE.length).toBeGreaterThan(0);
  });

  it('已迁移字段不许以实例字段形式存在, 且两个循环从 Context 取值', () => {
    expect(scanWiring(PI)).toEqual([]);
  });

  it('单元: createRunContext 未给的字段显式置空 (不继承上一个 Run 的残留)', () => {
    const prev = createRunContext({ eventSink: () => {}, abortSignal: AbortSignal.abort(), channelId: 'c1', runId: 'r1' });
    const next = createRunContext({ eventSink: prev.eventSink });
    expect(next.abortSignal).toBeNull();
    expect(next.channelId).toBe('');
    expect(next.runId).toBe('');
    expect(next.eventSink).toBe(prev.eventSink);
    expect(next.requestId).not.toBe(prev.requestId);
  });

  it('单元: 取消信号能真的传到 Context 里 (AbortSignal 语义)', () => {
    const ac = new AbortController();
    const ctx = createRunContext({ abortSignal: ac.signal });
    expect(ctx.abortSignal?.aborted).toBe(false);
    ac.abort();
    expect(ctx.abortSignal?.aborted).toBe(true);
  });

  it('session 级字段必须**仍是实例字段** —— 除非 K5 台账声明已迁 (K2↔K5 交接契约)', () => {
    // `currentGoalId` 是跨 Run 的会话级绑定 (setGoalId 外部注入; run 内可能重绑并需活到下一轮)。
    // 它必须留在实例上 —— 被塞进"每次入口新建"的 Context 会让 run 内的写丢掉。
    // 2026-10-02: 唯一开关是 **K5 台账** —— 声明了才放行 (K5 第 4 步要迁 messageHistory),
    //   没声明就消失则判红 (防"半搬状态"偷偷溜过)。
    const code = strip(PI);
    const session = RUN_CONTEXT_FIELDS.filter((f) => f.scope === 'session');
    expect(session.length).toBeGreaterThan(0);
    expect(scanSessionFieldResidence(code, session, K5_PROGRESS.migratedFieldNames ?? [])).toEqual([]);
    for (const f of session) expect(RUN_CONTEXT_DONE).not.toContain(f.name);
  });

  it('★ 交接契约的判别力: 没声明却消失 ⇒ 红; 声明了不存在的字段 ⇒ 红', () => {
    const code = strip(PI);
    const session = RUN_CONTEXT_FIELDS.filter((f) => f.scope === 'session');
    // ① 真实源码 + **空**迁移名单 ⇒ messageHistory 已不在实例上 (访问器) ⇒ 必须报红
    expect(scanSessionFieldResidence(code, session, [])
      .some((x) => x.rule === 'session-field-vanished')).toBe(true);
    // ② 声明迁移一个 K2 里不存在的字段 ⇒ 红
    expect(scanSessionFieldResidence(code, session, ['不存在的字段'])
      .some((x) => x.rule === 'k5-migration-unknown-field')).toBe(true);
    // ③ 盘上真实台账名单 ⇒ 绿
    expect(scanSessionFieldResidence(code, session, K5_PROGRESS.migratedFieldNames ?? [])).toEqual([]);
  });

  it('判别力自证: 把旧字段声明注回源码 ⇒ 必须判红', () => {
    const mutated = PI.replace('private runCtx: RunContext = createRunContext();',
      'private runCtx: RunContext = createRunContext();\n  private currentSignal: AbortSignal | null = null;');
    expect(mutated).not.toBe(PI);
    expect(scanWiring(mutated).some((f) => f.includes('currentSignal'))).toBe(true);
  });

  it('判别力自证: 入口漏建 abortSignal ⇒ 必须判红', () => {
    const mutated = PI.replace('eventSink: options?.onStream ?? null, abortSignal: options?.signal ?? null', 'eventSink: options?.onStream ?? null');
    expect(scanWiring(mutated).some((f) => f.includes('abortSignal'))).toBe(true);
  });

  it('判别力自证: 循环改回读实例字段 ⇒ 必须判红', () => {
    const mutated = PI.replace('this.runCtx.abortSignal ?? undefined', 'this.currentSignal ?? undefined');
    const f = scanWiring(mutated);
    expect(f.some((x) => x.includes('currentSignal') || x.includes('abortSignal'))).toBe(true);
  });

  it('注释不算数: 注释里提到旧字段名不判红 (剥注释)', () => {
    const withComment = `${PI}\n// 历史: this.currentSignal 曾在这里\n`;
    expect(scanWiring(withComment)).toEqual([]);
  });
});
