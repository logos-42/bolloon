/**
 * 手机端持续工作 Harness 验证 (2026-10-07)
 * 验证 7 项能力：目标对齐/错误恢复/生命周期/上下文管理/记忆/每日审查/定时器/世界探索
 * 用内存存储 + 模拟 LLM（确定性，不依赖网络）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GoalValidator, ErrorClassifier, RunLifecycle, ContextManager, MemoryStore,
  DailyReview, Scheduler, WorldExplorer, HarnessLoop, HarnessStorage,
} from '../web/mobile-harness.ts';

// 内存存储 (替代 IndexedDB)
function memStorage(): HarnessStorage {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, v); },
  };
}

describe('手机端持续工作 Harness (7 项能力)', () => {
  let storage: HarnessStorage;
  beforeEach(() => { storage = memStorage(); });

  it('1. 目标对齐/审查: 模糊/无动词/超范围 目标被标记', () => {
    const v = new GoalValidator();
    expect(v.review('查我的钱包余额').ok).toBe(true);
    const bad1 = v.review('你好');
    expect(bad1.ok).toBe(false);
    expect(bad1.issues.some((i) => i.kind === 'vague')).toBe(true);
    const bad2 = v.review('熊猫竹子');
    expect(bad2.ok).toBe(false);
    expect(bad2.issues.some((i) => i.kind === 'no-action')).toBe(true);
  });

  it('2. 错误恢复: 错误分类 → 动作 (auth 升级 / 超时退避 / 未知工具换策略)', () => {
    const c = new ErrorClassifier();
    expect(c.classify('401 unauthorized').action).toBe('escalate');
    expect(c.classify('auth failed').action).toBe('escalate');
    expect(c.classify('timeout').action).toBe('backoff');
    expect(c.classify('fetch failed').action).toBe('backoff');
    expect(c.classify('unknown tool').action).toBe('switch-strategy');
    expect(c.classify('工具失败').action).toBe('switch-strategy');
    expect(c.classify('').action).toBe('retry');
  });

  it('3. 生命周期: 状态机 queued→running→done + 持久化留痕', async () => {
    const lc = new RunLifecycle('查钱包', storage);
    expect(lc.state).toBe('queued');
    await lc.transition('running');
    await lc.recordStep('get_wallet', true);
    await lc.transition('done', { result: '余额 12.5 USDC', stepCount: 1 });
    expect(lc.state).toBe('done');
    expect(lc.current.stepCount).toBe(1);
    // 持久化
    const runs = await RunLifecycle.list(storage);
    expect(runs.length).toBe(1);
    expect(runs[0].goal).toBe('查钱包');
    expect(runs[0].state).toBe('done');
  });

  it('4. 上下文管理: 溢出处截断历史 + 保留最近 + 标记', () => {
    const mem = new MemoryStore(storage);
    const cm = new ContextManager(50, mem, '你是 Bolloon');
    const longHist = [];
    for (let i = 0; i < 40; i++) longHist.push({ role: 'user' as const, content: '工具' + '很长内容'.repeat(10) + ` #${i}` });
    const ctx = cm.build('目标', longHist).then((c) => c);
    // 异步拿结果
    return ctx.then((c) => {
      expect(c.truncated).toBe(true);
      expect(c.messages.length).toBeLessThan(40);
      expect(c.messages[0].content).toContain('上下文已截断');
      expect(c.system).toContain('你是 Bolloon');
    });
  });

  it('5. 记忆: 短期写入 + 长期召回（关键词匹配）', async () => {
    const mem = new MemoryStore(storage);
    await mem.remember('查了钱包余额 12.5 USDC', 'long', ['wallet']);
    await mem.remember('加入网络 P2P', 'short');
    const recall = await mem.recall('钱包', 5);
    expect(recall.length).toBeGreaterThan(0);
    expect(recall[0].content).toContain('钱包');
    const shorts = await mem.recallShort(5);
    expect(shorts.length).toBe(1);
    expect(shorts[0].kind).toBe('short');
  });

  it('6. 每日审查: 到期才跑, 复盘短期记忆沉淀长期经验', async () => {
    const mem = new MemoryStore(storage);
    const dr = new DailyReview(storage, mem);
    // 首次跑 (到期)
    await mem.remember('处理了 A 任务', 'short');
    await mem.remember('处理了 A 任务', 'short');
    const r1 = await dr.run();
    expect(r1.ran).toBe(true);
    expect(r1.reviewed).toBeGreaterThan(0);
    // 刚跑完 → 未到期
    const r2 = await dr.run();
    expect(r2.ran).toBe(false);
    // 长期记忆沉淀了经验
    const longs = await mem.all();
    expect(longs.some((m) => m.kind === 'long' && m.tags.includes('daily-review'))).toBe(true);
  });

  it('7. 自动定时 + 世界探索: 定时器触发回调 + 机会扫描写入记忆', async () => {
    // 世界探索
    const mem = new MemoryStore(storage);
    const we = new WorldExplorer(
      async () => [{ id: 'opp1', title: 'AI agent 机会', summary: '最新进展' }],
      mem,
      async () => true,
    );
    const r = await we.explore(5);
    expect(r.scanned).toBe(1);
    expect(r.generated).toContain('opp1');
    const shorts = await mem.recallShort(10);
    expect(shorts.some((m) => m.content.includes('AI agent 机会'))).toBe(true);

    // 定时器 (用短间隔测触发)
    let fired = 0;
    const sched = new Scheduler(
      { tick: async () => { fired++; } },
      { tick: 30 },
    );
    const h = sched.start();
    await new Promise((r) => setTimeout(r, 100));
    h.stop();
    expect(fired).toBeGreaterThanOrEqual(1);
  });

  it('HarnessLoop 集成: 50 步预算 + 工具链 + 记忆 + 生命周期 (模拟 LLM 两轮工具后收敛)', async () => {
    const mem = new MemoryStore(storage);
    (globalThis as any).__harnessMemory = mem;
    let llmCalls = 0;
    const loop = new HarnessLoop('查一下我的钱包和身份, 汇总', {
      maxSteps: 50, // 老循环是 5, 现在 50 = 更长连续运作
      maxContextTokens: 2000,
      tools: {
        get_wallet: async () => '{"success":true,"balance":"12.5 USDC"}',
        get_identity: async () => '{"success":true,"did":"did:key:z6Mk..."}',
      },
      llm: async () => {
        llmCalls++;
        if (llmCalls === 1) return '{"tool":"get_wallet","args":{}}';
        if (llmCalls === 2) return '{"tool":"get_identity","args":{}}';
        return '钱包余额 12.5 USDC, DID 是 did:key:z6Mk...。任务完成。';
      },
      storage,
    });
    const result = await loop.run();
    expect(result).toContain('任务完成');
    expect(llmCalls).toBe(3);
    // 生命周期 done
    expect(loop.lifecycle.state).toBe('done');
    const runs = await RunLifecycle.list(storage);
    expect(runs[0].state).toBe('done');
    // 记忆里有步骤
    const shorts = await mem.recallShort(10);
    expect(shorts.some((m) => m.content.includes('get_wallet'))).toBe(true);
    delete (globalThis as any).__harnessMemory;
  });

  it('HarnessLoop 错误恢复: LLM 连续失败后重试成功 (transient)', async () => {
    const mem = new MemoryStore(storage);
    (globalThis as any).__harnessMemory = mem;
    let calls = 0;
    const loop = new HarnessLoop('测试错误恢复', {
      maxSteps: 20,
      maxContextTokens: 2000,
      tools: { get_status: async () => '{"success":true,"status":"ok"}' },
      llm: async () => {
        calls++;
        if (calls === 1) throw new Error('timeout');
        if (calls === 2) return '{"tool":"get_status","args":{}}';
        return '状态正常';
      },
      storage,
    });
    const result = await loop.run();
    expect(result).toContain('状态正常');
    expect(calls).toBe(3);
    const runs = await RunLifecycle.list(storage);
    expect(runs[0].state).toBe('done');
    delete (globalThis as any).__harnessMemory;
  });
});