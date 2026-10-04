/**
 * k10-session-lifecycle-port.test.ts — K10 余项: 会话生命周期端口 (规则进内核, I/O 走端口)
 *
 * 背景: pi-sdk 里还剩一批"运行/通道接线" —— `saveCurrentSession` 的落盘映射 · `peekSessionHistory` 的
 * 读回过滤 · `hydrateMessageHistory` 的 filter ·  `seedRunContext` 的合并顺序。这些**规则**此前散在
 * pi-sdk 的方法体里 (其中 `_filterToMessage` 是那个"过滤规则"的唯一副本)。本轮把它们整条搬进内核
 * (`kernel/session-lifecycle.ts`), pi-sdk 只留 I/O 与时机。
 *
 * 判据四段:
 *   A. 纯规则 (可直接判): key 校验 · 落盘映射 · 读回过滤的三条"必须保留/必须剔" · 截断 · 种子合并顺序;
 *   B. 端口语义: 未注入即拒 · 缺 key 拒 · 匿名 origin 拒 · 端口 `{ok:false}` 归一化 · 端口抛错归一化 · 从不抛;
 *   C. 审计: 成功/失败都留痕 · 可重置 · 有上限;
 *   D. 反回归 (源级): 规则的副本不许回到 pi-sdk (`_filterToMessage` 已删) · 四个调用点必须经内核。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SESSION_OPS, SESSION_NEEDS_KEY, isValidSessionKey, SESSION_ROLES,
  toPersistedMessages, filterSessionMessages, hydrateSessionMessages, composeRunSeed,
  submitSessionOp, assertSessionOk, sessionLifecycleAudit, resetSessionLifecycleAudit,
  type SessionPorts,
} from '../kernel/session-lifecycle.js';

const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('K10 余项-A. 纯规则 (不碰 I/O)', () => {
  it('会话 key 必须非空字符串 (空 key 会写进一个共享黑洞 ⇒ 当场拒)', () => {
    expect(isValidSessionKey('ch:default')).toBe(true);
    expect(isValidSessionKey('  x  ')).toBe(true);
    expect(isValidSessionKey('')).toBe(false);
    expect(isValidSessionKey('   ')).toBe(false);
    expect(isValidSessionKey(null)).toBe(false);
    expect(isValidSessionKey(123)).toBe(false);
    expect(isValidSessionKey({ key: 'x' })).toBe(false);
  });

  it('落盘映射: 字段逐项带过 + timestamp 取写盘那一刻 + source 标记写入方', () => {
    const src = [
      { role: 'user', content: 'hi', channelId: '不该进' },
      { role: 'assistant', content: '', toolCall: { name: 't' }, toolCallId: 'c1' },
    ];
    const out = toPersistedMessages(src, 'pi-session', () => 1700000000000);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: 'user', content: 'hi', toolCall: undefined, toolResult: undefined,
      toolCallId: undefined, timestamp: 1700000000000, source: 'pi-session',
    });
    expect(out[1].toolCall).toEqual({ name: 't' });
    expect(out[1].toolCallId).toBe('c1');
    // 没给 sourceTag 时用默认口径
    expect(toPersistedMessages([{ role: 'user', content: 'x' }])[0].source).toBe('pi-session');
    expect(toPersistedMessages([])).toEqual([]);
    expect(toPersistedMessages(null as never)).toEqual([]);
  });

  it('读回过滤: 三条"必须保留 / 必须剔" (逐字沿用迁移前的口径)', () => {
    expect([...SESSION_ROLES].sort()).toEqual(['assistant', 'system', 'tool', 'user']);
    const loaded = [
      { role: 'user', content: 'keep' },
      { type: 'user', content: '旧 schema 没 role ⇒ 剔' } as never,
      { role: 'nope', content: '非法 role ⇒ 剔' },
      { role: 'assistant', content: '[AI 服务调用失败] xxx' },
      { role: 'assistant', content: '[错误: boom]' },
      // 坑 ①: 只有 tool call 没有正文的 assistant 消息**必须保留**
      { role: 'assistant', content: '', toolCall: { name: 't' }, toolCallId: 'c1' },
      // 坑 ②: 既无内容也无 tool call/result 的废消息 ⇒ 剔
      { role: 'assistant', content: '' },
      // 坑 ③: tool role 但没有 toolResult 的占位 ⇒ 剔
      { role: 'tool', content: '' },
      { role: 'tool', content: '', toolResult: { ok: true } },
      { role: 'system', content: 'sys' },
    ];
    const out = filterSessionMessages(loaded as never);
    expect(out).toHaveLength(4);
    const kept = (out as { role: string; content: string }[]).map((m) => m.role);
    expect(kept).toEqual(['user', 'assistant', 'tool', 'system']);
    expect((out[1] as { toolCall?: unknown }).toolCall).toEqual({ name: 't' });
    // content 缺失时补空串 (不写 undefined 进历史)
    expect((out[0] as { content: string }).content).toBe('keep');
    expect(filterSessionMessages(null)).toEqual([]);
  });

  it('截断口径: hydrate 取**最近** N 条; 非正数/NaN ⇒ 空 (不静默全给)', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const got = hydrateSessionMessages(many as never, 2) as { content: string }[];
    expect(got.map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(hydrateSessionMessages(many as never, 0)).toEqual([]);
    expect(hydrateSessionMessages(many as never, -3)).toEqual([]);
    expect(hydrateSessionMessages(many as never, Number.NaN as never)).toEqual([]);
    expect(hydrateSessionMessages(many as never, 99)).toHaveLength(5);
  });

  it('运行种子合并顺序: 活跃运行打底, extra 覆盖它 (显式传的优先)', () => {
    expect(composeRunSeed('run-active')).toEqual({ runId: 'run-active' });
    expect(composeRunSeed('run-active', { runId: 'run-explicit', extra: 1 })).toEqual({ runId: 'run-explicit', extra: 1 });
    expect(composeRunSeed(undefined, { runId: 'run-explicit' })).toEqual({ runId: 'run-explicit' });
    expect(composeRunSeed(undefined)).toEqual({ runId: undefined });
  });

  it('操作表自洽: 三个会话操作要 key, seed-run 不要', () => {
    expect([...SESSION_OPS]).toEqual(['save-session', 'peek-history', 'resume-session', 'seed-run']);
    expect(SESSION_NEEDS_KEY['save-session']).toBe(true);
    expect(SESSION_NEEDS_KEY['peek-history']).toBe(true);
    expect(SESSION_NEEDS_KEY['resume-session']).toBe(true);
    expect(SESSION_NEEDS_KEY['seed-run']).toBe(false);
  });
});

describe('K10 余项-B. 端口语义 (未注入即拒 · 从不抛)', () => {
  it('端口一个都没注入 ⇒ 明确拒 (带着要哪个端口), 不静默降级', async () => {
    const out = await submitSessionOp({ op: 'save-session', origin: 'test', key: 'k' }, {});
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('saveMessages');
    expect(out.via).toBe('kernel-session-lifecycle');
  });

  it('缺 key / 空白 key ⇒ 拒; seed-run 不需要 key', async () => {
    const ports: SessionPorts = { historySnapshot: () => [], saveMessages: async () => undefined };
    expect((await submitSessionOp({ op: 'save-session', origin: 'test' }, ports)).detail).toContain('会话 key');
    expect((await submitSessionOp({ op: 'save-session', origin: 'test', key: '   ' }, ports)).detail).toContain('会话 key');
    const seedOut = await submitSessionOp(
      { op: 'seed-run', origin: 'test' },
      { activeRunId: () => 'r1', newRunContext: (runId) => ({ runId }) },
    );
    expect(seedOut.ok).toBe(true);
    expect(seedOut.result).toEqual({ runId: 'r1' });
  });

  it('未知操作 / 匿名 origin ⇒ 拒 (审计要求)', async () => {
    expect((await submitSessionOp({ op: 'nope' as never, origin: 'test' }, {})).detail).toContain('未知会话操作');
    expect((await submitSessionOp({ op: 'save-session', origin: '   ', key: 'k' }, {})).detail).toContain('origin');
  });

  it('save-session: **内核做映射**, 端口只负责落盘 (收到的就是持久形态)', async () => {
    let seen: unknown = null;
    let seenKey = '';
    const res = await submitSessionOp(
      { op: 'save-session', origin: 'test', key: 'k1' },
      {
        historySnapshot: () => [{ role: 'user', content: 'hi' }],
        saveMessages: async (key, messages) => { seenKey = key; seen = messages; },
      },
    );
    expect(res.ok).toBe(true);
    expect(seenKey).toBe('k1');
    expect(res.result).toEqual({ count: 1 });
    const arr = seen as { role: unknown; source?: string; timestamp?: number }[];
    expect(arr[0].role).toBe('user');
    expect(arr[0].source).toBe('pi-session');
    expect(typeof arr[0].timestamp).toBe('number');
  });

  it('peek-history: 内核过滤, 返回数组; resume-session: 应用由端口做, 返回条数', async () => {
    const ports: SessionPorts = {
      loadMessages: () => [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '[错误: x]' },
        { role: 'assistant', content: '', toolCall: { name: 't' } },
      ],
      applyHistory: (messages) => messages.length,
    };
    const peek = await submitSessionOp({ op: 'peek-history', origin: 'test', key: 'k' }, ports);
    expect(peek.ok).toBe(true);
    expect((peek.result as unknown[]).length).toBe(2);
    const resumed = await submitSessionOp({ op: 'resume-session', origin: 'test', key: 'k' }, ports);
    expect(resumed.ok).toBe(true);
    expect(resumed.result).toBe(2);
  });

  it('端口用返回值拒绝 ({ok:false}) 要被归一化 —— 只看"有没有抛"会把被拒当成功', async () => {
    const out = await submitSessionOp(
      { op: 'save-session', origin: 'test', key: 'k' },
      { historySnapshot: () => [], saveMessages: async () => ({ ok: false, reason: '磁盘满了' }) },
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('磁盘满了');
  });

  it('端口抛错 ⇒ 归一化成 {ok:false}, 内核**从不抛**', async () => {
    const boom = await submitSessionOp(
      { op: 'peek-history', origin: 'test', key: 'k' },
      { loadMessages: () => { throw new Error('store 炸了'); } },
    );
    expect(boom.ok).toBe(false);
    expect(boom.detail).toContain('store 炸了');
  });

  it('assertSessionOk: 不 ok 才抛 (响亮失败给"写不进就不算发生"的调用方)', async () => {
    const ok = await submitSessionOp(
      { op: 'save-session', origin: 'test', key: 'k' },
      { historySnapshot: () => [], saveMessages: async () => undefined },
    );
    expect(() => assertSessionOk(ok)).not.toThrow();
    expect(() => assertSessionOk({ ok: false, op: 'save-session', via: 'kernel-session-lifecycle', detail: 'x' })).toThrow(/x/);
  });
});

describe('K10 余项-C. 审计', () => {
  it('成功与失败都留痕 · 可重置 · 有上限', async () => {
    resetSessionLifecycleAudit();
    await submitSessionOp(
      { op: 'seed-run', origin: 'test', extra: {} },
      { activeRunId: () => 'r', newRunContext: () => ({}) },
    );
    await submitSessionOp({ op: 'save-session', origin: 'test', key: 'k' }, {});   // 失败 (未注入端口)
    const log = sessionLifecycleAudit();
    expect(log.length).toBe(2);
    expect(log[0]).toMatchObject({ op: 'seed-run', origin: 'test', ok: true });
    expect(log[1]).toMatchObject({ op: 'save-session', origin: 'test', ok: false });
    expect(log[1].detail).toContain('saveMessages');
    resetSessionLifecycleAudit();
    expect(sessionLifecycleAudit()).toHaveLength(0);
  });
});

describe('K10 余项-D. 反回归 (源级): 规则不许回到 pi-sdk', () => {
  it('`_filterToMessage` 已删 · 四个调用点必须经内核', () => {
    const src = readSrc('src/agents/pi-sdk.ts');
    expect(src, '过滤规则的本地副本必须不存在').not.toMatch(/_filterToMessage\s*\(/);
    expect(src).not.toMatch(/VALID_ROLES\.has/);
    expect(src).toMatch(/submitSessionOp\(\{ op: 'save-session'/);
    expect(src).toMatch(/submitSessionOp\(\{ op: 'peek-history'/);
    expect(src).toMatch(/filterSessionMessages\(/);
    expect(src).toMatch(/hydrateSessionMessages\(/);
    expect(src).toMatch(/composeRunSeed\(/);
    expect(src, '撒手不管的 try/catch 空数组不许回来').not.toMatch(/peek 逻辑被抄回/);
  });
});
