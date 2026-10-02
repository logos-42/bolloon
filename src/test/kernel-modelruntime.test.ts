/**
 * K6 门: ModelRuntime 台账 —— 旧写口棘轮 + 能力清单 + "声明未实现 ⇒ 文件不许存在"。
 *
 * 为什么先落门再写运行时: K2 的实操证明"新层出现后旧写口调用点数只许不变或减少"这条判据
 * 真能拦回实现 (它拦回过一次 assistant 的写法)。K6 要动的是多供应商并发 —— 一旦新层顺手改了
 * provider 配置 / API key / 全局 model, 就会变成"两个地方都能改状态", 那是回归而不是新能力。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  K6_PROGRESS,
  MODEL_RUNTIME_ACQUIRE_RULE,
  MODEL_RUNTIME_CAPABILITIES,
  MODEL_RUNTIME_OUT_OF_SCOPE,
  MODEL_WRITE_PORTS,
  MODEL_WRITE_PORTS_FROZEN_AT,
} from '../kernel/plan-modelruntime.js';
import { ModelAbortError, ModelCapabilityError, ModelCircuitOpenError, ModelRuntime, ModelTimeoutError, backoffDelayMs, countsTowardBreaker, isRateLimited, type ModelRuntimePorts } from '../kernel/model-runtime.js';
import { countModelWritePortCalls, scanModelRuntimeFile, scanModelRuntimeLedger, type SourceTextFile } from '../kernel/gate-scan.js';

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/** 与判据同口径的扫描面: 全仓 .ts, **排除 test/ 与 kernel/** (内核里不写业务状态) */
function scanFiles(): SourceTextFile[] {
  const out: SourceTextFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'constraint-runtime', 'test', 'kernel'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts')) {
        out.push({ path: path.relative(SRC, p), text: fs.readFileSync(p, 'utf-8') });
      }
    }
  };
  walk(SRC);
  return out;
}

const FILES = scanFiles();
const RUNTIME_EXISTS = fs.existsSync(path.join(SRC, K6_PROGRESS.runtimePath));

const LEDGER = {
  writePorts: MODEL_WRITE_PORTS,
  writePortsFrozenAt: MODEL_WRITE_PORTS_FROZEN_AT,
  acquireRule: MODEL_RUNTIME_ACQUIRE_RULE,
  capabilities: MODEL_RUNTIME_CAPABILITIES,
  outOfScope: MODEL_RUNTIME_OUT_OF_SCOPE,
  progress: K6_PROGRESS,
};

describe('K6 门: ModelRuntime 台账', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.every((f) => !f.path.startsWith('test/') && !f.path.startsWith('kernel/'))).toBe(true);
  });

  it('★ 盘上台账一致: 旧写口棘轮 + 合计自洽 + 能力清单 + 越界清单 + 只读要求', () => {
    expect(scanModelRuntimeLedger(LEDGER as any, FILES, { runtimeExists: RUNTIME_EXISTS })).toEqual([]);
  });

  it('★ 口径核: 每个写口的调用点数都能从盘上重算出来 (抽查三个)', () => {
    for (const name of ['setCustomProviderSnapshot', 'clearSessionSelection', 'resetModelSelection']) {
      const entry = MODEL_WRITE_PORTS.find((p) => p.name === name)!;
      expect(countModelWritePortCalls(FILES, name), name).toBe(entry.callSites);
    }
    // 声明行不算调用点: 拿自己的名字当反例 (定义文件里那句 `export function x(` 必须没被算)
    const fake: SourceTextFile[] = [{ path: 'x.ts', text: 'export function addCustomProvider() {}\n' }];
    expect(countModelWritePortCalls(fake, 'addCustomProvider')).toBe(0);
  });

  it('★ 判别力: 六种坏形状都必须判红', () => {
    const bump = (name: string, delta: number) =>
      LEDGER.writePorts.map((p) => (p.name === name ? { ...p, callSites: p.callSites + delta } : p));
    // ① 回退: **盘上多一处调用** (模拟新层顺手改了旧状态) ⇒ 必须报"回退"
    const extraCall: SourceTextFile[] = [...FILES, { path: 'llm/new-layer.ts', text: 'clearSessionSelection(1);' }];
    expect(scanModelRuntimeLedger(LEDGER as any, extraCall, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('回退'))).toBe(true);
    // ② 账没跟上: **盘上少了调用** (拿空扫描面模拟) ⇒ 必须报"盘上变了账没跟上"
    expect(scanModelRuntimeLedger(LEDGER as any, [{ path: 'empty.ts', text: '' }], { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('账没跟上'))).toBe(true);
    // ③ 合计不自洽
    expect(scanModelRuntimeLedger({ ...LEDGER, writePortsFrozenAt: MODEL_WRITE_PORTS_FROZEN_AT - 1 } as any, FILES, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('≠ 冻结值'))).toBe(true);
    // ④ 越界清单被缩减
    expect(scanModelRuntimeLedger({ ...LEDGER, outOfScope: MODEL_RUNTIME_OUT_OF_SCOPE.slice(0, 3) } as any, FILES, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('明确不做'))).toBe(true);
    // ⑤ 假进度: 标 not-started 却说文件在 / 标 runtime-built 却说文件不在
    // 阶段已前推 ⇒ 用"把账硬写回 not-started"来构造这个坏形状 (文件真在 ⇒ 必须红)
    expect(scanModelRuntimeLedger({ ...LEDGER, progress: { ...K6_PROGRESS, stage: 'not-started' } } as any, FILES, { runtimeExists: true }).some((f) => f.what.includes('台账该改'))).toBe(true);
    expect(scanModelRuntimeLedger({ ...LEDGER, progress: { ...K6_PROGRESS, stage: 'runtime-built' } } as any, FILES, { runtimeExists: false }).some((f) => f.what.includes('假进度'))).toBe(true);
    // ⑥ 只读要求被拿掉
    expect(scanModelRuntimeLedger({ ...LEDGER, acquireRule: { ...MODEL_RUNTIME_ACQUIRE_RULE, readOnly: false } } as any, FILES, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('只读要求'))).toBe(true);
  });

  it('能力清单与越界清单都不是空壳', () => {
    expect(MODEL_RUNTIME_CAPABILITIES).toHaveLength(9);
    for (const c of MODEL_RUNTIME_CAPABILITIES) expect(c.why.length).toBeGreaterThan(3);
    expect(MODEL_RUNTIME_OUT_OF_SCOPE).toHaveLength(5);
  });
});

describe('K6 运行时骨架: acquire 只读 + 连接复用 + timeout + cancellation (真跑)', () => {
  const mkPorts = () => {
    let opened = 0;
    const closed: string[] = [];
    const seen: { signal?: AbortSignal } = {};
    const ports: ModelRuntimePorts = {
      async openConnection(_snap, signal) {
        opened += 1;
        const id = `conn-${opened}`;
        seen.signal = signal;
        return {
          id,
          async call(_req, sig) {
            // 模拟一次"慢调用": 每 5ms 检查一次取消/中止
            for (let i = 0; i < 200; i += 1) {
              if (sig.aborted) { const e: any = new Error('aborted by runtime'); e.name = 'AbortError'; throw e; }
              await new Promise((r) => setTimeout(r, 5));
              if (i >= 40) break;   // 正常返回 (200ms 上限)
            }
            return { ok: true, raw: { id } };
          },
          async close() { closed.push(id); },
        };
      },
    };
    return { ports, openedCount: () => opened, closed };
  };

  it('只读: 冻结的 snapshot 上 acquire+call 一路不抛 (运行时只读这些字段, 一个都不回写)', async () => {
    const { ports } = mkPorts();
    const rt = new ModelRuntime(ports);
    const snap = Object.freeze({ provider: 'p', model: 'm', timeoutMs: 500, capabilities: Object.freeze(['tools']) });
    const lease = await rt.acquire(snap as any);
    const res = await lease.call({ messages: [] });
    expect(res.ok).toBe(true);
    expect(lease.snapshot).toBe(snap);            // 同一对象 (没被拷贝改写)
    lease.release();
    await rt.closeAll();
  });

  it('连接复用: 同一 snapshot 两次 acquire ⇒ 只开一条连接 (opened=1, reused=1)', async () => {
    const { ports, openedCount } = mkPorts();
    const rt = new ModelRuntime(ports);
    const snap = { provider: 'p', model: 'm', timeoutMs: 300 };
    const a = await rt.acquire(snap);
    const b = await rt.acquire(snap);
    expect(openedCount()).toBe(1);
    expect(rt.snapshotStats().reused).toBe(1);
    expect(rt.snapshotStats().connections).toBe(1);
    // 不同 model ⇒ 另一个 key ⇒ 另开一条
    await rt.acquire({ provider: 'p', model: 'm2', timeoutMs: 300 });
    expect(openedCount()).toBe(2);
    a.release(); b.release();
    await rt.closeAll();
  });

  it('timeout: 超预算 ⇒ 抛 ModelTimeoutError, 且底层调用被**中止** (不是干等)', async () => {
    const { ports } = mkPorts();
    const rt = new ModelRuntime(ports);
    const lease = await rt.acquire({ provider: 'p', model: 'slow', timeoutMs: 30 });   // 30ms 预算 vs ~200ms 调用
    await expect(lease.call({})).rejects.toThrow(ModelTimeoutError);
    expect(rt.snapshotStats().timeouts).toBe(1);
    lease.release();
    await rt.closeAll();
  });

  it('cancellation: 外部 AbortSignal ⇒ 抛 ModelAbortError; 已取消的 signal 立刻抛不发起调用', async () => {
    const { ports } = mkPorts();
    const rt = new ModelRuntime(ports);
    const lease = await rt.acquire({ provider: 'p', model: 'cancel', timeoutMs: 5000 });
    const ctl = new AbortController();
    const p = lease.call({}, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow(ModelAbortError);
    expect(rt.snapshotStats().aborts).toBeGreaterThanOrEqual(1);
    const pre = new AbortController(); pre.abort();
    await expect(lease.call({}, { signal: pre.signal })).rejects.toThrow(ModelAbortError);
    lease.release();
    await rt.closeAll();
  });

  it('归还后不许再用 (租约不是永久句柄)', async () => {
    const { ports } = mkPorts();
    const rt = new ModelRuntime(ports);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 500 });
    lease.release();
    const res = await lease.call({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('租约已归还');
    await rt.closeAll();
  });

  it('★ 判据: 运行时文件读写分离 + 能力计数一致 (含判别力)', () => {
    const code = fs.readFileSync(path.join(SRC, 'kernel/model-runtime.ts'), 'utf-8');
    const names = MODEL_WRITE_PORTS.map((p) => p.name);
    expect(scanModelRuntimeFile(code, { writePortNames: names, progress: K6_PROGRESS, capabilities: MODEL_RUNTIME_CAPABILITIES })).toEqual([]);
    // 判别力: 塞一个旧写口名进去 ⇒ 红 · 去掉 acquire ⇒ 红 · 能力计数对不上 ⇒ 红
    expect(scanModelRuntimeFile(code + '\nsetCustomProviderSnapshot(x);\n', { writePortNames: names, progress: K6_PROGRESS, capabilities: MODEL_RUNTIME_CAPABILITIES }).length).toBeGreaterThan(0);
    expect(scanModelRuntimeFile('export const x = 1;\n', { writePortNames: names, progress: K6_PROGRESS, capabilities: MODEL_RUNTIME_CAPABILITIES }).length).toBeGreaterThan(0);
    // 9/9 全做完后, 计数造假必须换个值才能构造 (用 3 —— 与清单里 done 的条数不等)
    expect(scanModelRuntimeFile(code, { writePortNames: names, progress: { capabilitiesDone: 3 }, capabilities: MODEL_RUNTIME_CAPABILITIES }).length).toBe(1);
    // 空文件 ⇒ 拒跑 (不许跳过)
    expect(scanModelRuntimeFile('   ', { writePortNames: names, progress: K6_PROGRESS, capabilities: MODEL_RUNTIME_CAPABILITIES })[0].what).toContain('拒跑');
  });
});

describe('K6 第三步: 多供应商并发 + 429 退避 (真跑, 睡眠注入 ⇒ 不真等)', () => {
  /** 端口: 记录并发峰值 / 按脚本返回限流 */
  const mk = (script: Array<'ok' | '429'>, opts?: { holdMs?: number }) => {
    const hold = opts?.holdMs ?? 20;
    let live = 0; let peak = 0; const calls: number[] = []; const sleeps: number[] = [];
    let idx = 0;
    const ports: ModelRuntimePorts = {
      random: () => 0.5,                                  // 抖动因子 = 0 ⇒ 退避时长可精确断言
      sleep: async (ms: number) => { sleeps.push(ms); },
      async openConnection() {
        return {
          id: 'c1',
          async call() {
            idx += 1; live += 1; peak = Math.max(peak, live);
            const kind = script[Math.min(idx - 1, script.length - 1)];
            await new Promise((r) => setTimeout(r, hold));
            live -= 1;
            calls.push(idx);
            return kind === '429' ? { ok: false, status: 429, error: 'HTTP 429 rate limit' } : { ok: true, raw: { n: idx } };
          },
          async close() {},
        };
      },
    };
    return { ports, peak: () => peak, calls, sleeps };
  };

  it('并发上限逐 key: maxConcurrency=1 ⇒ 两次并发调用**不重叠** (峰值 1, 有人排队)', async () => {
    const m = mk(['ok', 'ok']);
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    await Promise.all([lease.call({ i: 1 }), lease.call({ i: 2 })]);
    expect(m.peak()).toBe(1);
    expect(rt.snapshotStats().concurrencyWaits).toBe(1);
    expect(rt.snapshotStats().maxObservedConcurrency).toBe(1);
    await rt.closeAll();
  });

  it('并发上限逐 key: maxConcurrency=3 ⇒ 三次并发**真重叠** (峰值 3) 且不同 key 互不阻塞', async () => {
    const m = mk(['ok', 'ok', 'ok']);
    const rt = new ModelRuntime(m.ports, 5000, 3);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    await Promise.all([lease.call({}), lease.call({}), lease.call({})]);
    expect(m.peak()).toBe(3);
    expect(rt.snapshotStats().concurrencyWaits).toBe(0);
    await rt.closeAll();
  });

  it('排队可取消: 等槽期间 abort ⇒ ModelAbortError, 且**不发起到连接**', async () => {
    const m = mk(['ok', 'ok'], { holdMs: 60 });
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    const ctl = new AbortController();
    const first = lease.call({});
    const queued = lease.call({}, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await expect(queued).rejects.toThrow(ModelAbortError);
    await first;
    expect(m.calls).toHaveLength(1);                        // 排队那个从未发起
    await rt.closeAll();
  });

  it('429 退避: 两次限流后成功 ⇒ retries=2, 退避序列按指数上升 (jitter 归零 ⇒ 可精确断言)', async () => {
    const m = mk(['429', '429', 'ok'], { holdMs: 1 });
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    const res = await lease.call({});
    expect(res.ok).toBe(true);
    expect(rt.snapshotStats().retries).toBe(2);
    expect(rt.snapshotStats().rateLimited).toBe(2);
    expect(m.sleeps).toEqual([200, 400]);                   // 200 * 2^n (jitter=0)
    await rt.closeAll();
  });

  it('429 用尽: 一直限流 ⇒ 重试到上限即如实失败 (不无限重试)', async () => {
    const m = mk(['429'], { holdMs: 1 });
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    const res = await lease.call({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('限流重试用尽');
    expect(rt.snapshotStats().retries).toBe(3);             // maxRetries=3
    await rt.closeAll();
  });

  it('退避期间取消 ⇒ 立刻抛 ModelAbortError (不再重试)', async () => {
    const m = mk(['429', '429', 'ok'], { holdMs: 1 });
    // 这个用例必须让退避**真的占住时间**, 否则整个重试循环会在 abort 之前跑完 (用例本身失效)
    m.ports.sleep = async (ms: number) => { await new Promise((r) => setTimeout(r, Math.min(ms, 60))); };
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    const ctl = new AbortController();
    const p = lease.call({}, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 15);
    await expect(p).rejects.toThrow(ModelAbortError);
    await rt.closeAll();
  });

  it('退避曲线是纯函数且尊重 Retry-After (取最大值)', () => {
    expect(backoffDelayMs(0, { random: () => 0.5 })).toBe(200);
    expect(backoffDelayMs(1, { random: () => 0.5 })).toBe(400);
    expect(backoffDelayMs(9, { random: () => 0.5 })).toBe(5000);                    // 封顶
    expect(backoffDelayMs(0, { retryAfterMs: 1200, random: () => 0.5 })).toBe(1200); // 尊重上游
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ error: 'HTTP 429 rate limit' })).toBe(true);
    expect(isRateLimited({ ok: false, error: 'boom' })).toBe(false);
  });
});

describe('K6 第四步: 熔断 (三态) + 能力检查 (拒在开连接之前)', () => {
  const mkBreaker = (script: Array<'ok' | 'fail' | '429' | 'abort' | 'timeout'>) => {
    let idx = 0; let opened = 0; let now = 1_000_000;
    const ports: ModelRuntimePorts = {
      now: () => now,
      sleep: async () => {},
      random: () => 0.5,
      async openConnection() {
        opened += 1;
        return {
          id: `c${opened}`,
          async call() {
            const kind = script[Math.min(idx, script.length - 1)]; idx += 1;
            if (kind === 'ok') return { ok: true, raw: { n: idx } };
            if (kind === '429') return { ok: false, status: 429, error: 'HTTP 429' };
            if (kind === 'abort') { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; }
            if (kind === 'timeout') { await new Promise((r) => setTimeout(r, 30)); return { ok: true }; }
            return { ok: false, error: 'provider 500' };
          },
          async close() {},
        };
      },
    };
    return { ports, advance: (ms: number) => { now += ms; }, openedCount: () => opened, calls: () => idx };
  };

  it('熔断三态: 连 3 次失败 ⇒ 开路并**快速失败** (不再发起调用) ⇒ 冷却后放一个探测 ⇒ 成功即闭合', async () => {
    const m = mkBreaker(['fail', 'fail', 'fail', 'ok']);
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    for (let i = 0; i < 3; i += 1) expect((await lease.call({})).ok).toBe(false);
    expect(rt.breakerStates()['p::m::'].state).toBe('open');
    const callsBefore = m.calls();
    await expect(lease.call({})).rejects.toThrow(ModelCircuitOpenError);   // 快速失败
    expect(m.calls()).toBe(callsBefore);                                   // **没有发起调用**
    expect(rt.snapshotStats().failFast).toBe(1);
    // 冷却还没到 ⇒ 仍快速失败
    m.advance(10_000);
    await expect(lease.call({})).rejects.toThrow(ModelCircuitOpenError);
    // 冷却已到 ⇒ 放一个探测 (脚本下一步是 ok) ⇒ 闭合
    m.advance(60_000);
    expect((await lease.call({})).ok).toBe(true);
    expect(rt.breakerStates()['p::m::'].state).toBe('closed');
    expect(rt.snapshotStats().halfOpenProbes).toBe(1);
    expect(rt.snapshotStats().breakerClosed).toBe(1);
    await rt.closeAll();
  });

  it('半开探测失败 ⇒ 立刻重新开路 (冷却重新计时)', async () => {
    const m = mkBreaker(['fail', 'fail', 'fail', 'fail']);
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    for (let i = 0; i < 3; i += 1) await lease.call({});
    m.advance(60_000);
    expect((await lease.call({})).ok).toBe(false);          // 探测失败
    expect(rt.breakerStates()['p::m::'].state).toBe('open');
    expect(rt.snapshotStats().circuitOpened).toBe(2);
    await rt.closeAll();
  });

  it('不计入熔断的失败: **调用方**取消与 429 都不许把熔断打开', async () => {
    // "调用方取消"要用**外部 signal** 制造 (运行时的 signal 被取消 ⇒ 归一化成 ModelAbortError ⇒ 不计入)。
    //   端口自己抛 AbortError 而运行时 signal 没被取消 = 供应商侧中止 ⇒ 那是**该计入**的失败 (口径写在 countsTowardBreaker)。
    let live = 0;
    const ports: ModelRuntimePorts = {
      sleep: async () => {},
      random: () => 0.5,
      async openConnection() {
        return {
          id: 'c1',
          async call(_req, sig) {
            live += 1;
            for (let i = 0; i < 40; i += 1) {
              if (sig.aborted) { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; }
              await new Promise((r) => setTimeout(r, 5));
            }
            live -= 1;
            return { ok: true };
          },
          async close() {},
        };
      },
    };
    const rt = new ModelRuntime(ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    for (let i = 0; i < 4; i += 1) {
      const ctl = new AbortController();
      const p = lease.call({}, { signal: ctl.signal });
      setTimeout(() => ctl.abort(), 5);
      await expect(p).rejects.toThrow(ModelAbortError);
    }
    expect(rt.breakerStates()['p::m::']?.state ?? 'closed').toBe('closed');
    expect(rt.snapshotStats().circuitOpened).toBe(0);
    // 429: 走退避, 用尽后也不该开路 (那是限流不是故障)
    const m2 = mkBreaker(['429']);
    const rt2 = new ModelRuntime(m2.ports, 5000, 1);
    const l2 = await rt2.acquire({ provider: 'p', model: 'm', timeoutMs: 5000 });
    expect((await l2.call({})).ok).toBe(false);
    expect(rt2.snapshotStats().circuitOpened).toBe(0);
    expect(countsTowardBreaker({ ok: false, status: 429 })).toBe(false);
    expect(countsTowardBreaker(new Error('500'))).toBe(true);
    expect(countsTowardBreaker(new ModelAbortError())).toBe(false);
    expect(countsTowardBreaker(new ModelTimeoutError(5))).toBe(true);
    await rt.closeAll(); await rt2.closeAll();
  });

  it('能力检查: 缺能力 / 能力未知 ⇒ **拒在开连接之前** (opened 仍为 0)', async () => {
    const m = mkBreaker(['ok']);
    const rt = new ModelRuntime(m.ports, 5000, 1);
    await expect(rt.acquire({ provider: 'p', model: 'm', capabilities: ['tools'] }, { require: ['vision'] })).rejects.toThrow(ModelCapabilityError);
    await expect(rt.acquire({ provider: 'p', model: 'm' }, { require: ['vision'] })).rejects.toThrow(/未知能力/);
    expect(m.openedCount()).toBe(0);                     // **一次连接都没开**
    expect(rt.snapshotStats().capabilityRejects).toBe(2);
    // 声明齐了 ⇒ 正常放行 (且冻结的 capabilities 数组没被动过)
    const caps = Object.freeze(['tools', 'vision']);
    const lease = await rt.acquire(Object.freeze({ provider: 'p', model: 'm', timeoutMs: 5000, capabilities: caps }), { require: ['vision'] });
    expect((await lease.call({})).ok).toBe(true);
    expect(caps).toEqual(['tools', 'vision']);
    await rt.closeAll();
  });
});

describe('K6 第五步 (收尾): provider fallback + usage 记录 (能力 9/9)', () => {
  const mkMulti = (behaviour: Record<string, 'ok' | 'fail' | '429'>) => {
    const opened: string[] = []; const usage: any[] = []; let innerThrow = false;
    const ports: ModelRuntimePorts = {
      sleep: async () => {},
      random: () => 0.5,
      async recordUsage(e) { if (innerThrow) throw new Error('记账服务炸了'); usage.push(e); },
      async openConnection(snap: any) {
        opened.push(snap.provider);
        return {
          id: `c-${snap.provider}`,
          async call() {
            const kind = behaviour[snap.provider] ?? 'ok';
            if (kind === '429') return { ok: false, status: 429, error: 'HTTP 429' };
            if (kind === 'fail') return { ok: false, error: `${snap.provider} 500` };
            return { ok: true, raw: { by: snap.provider }, usage: { tokens: 7 } };
          },
          async close() {},
        };
      },
    };
    return { ports, opened, usage, breakUsage: () => { innerThrow = true; } };
  };

  it('回退: 主 provider 失败 ⇒ 用 Run snapshot 里的备用 provider (且只读, 原 snapshot 不变)', async () => {
    const m = mkMulti({ p1: 'fail', p2: 'ok' });
    const rt = new ModelRuntime(m.ports, 5000, 2);
    const snap = Object.freeze({ provider: 'p1', model: 'm', timeoutMs: 3000, fallbackProviders: Object.freeze(['p2', 'p3']) });
    const lease = await rt.acquire(snap as any);
    const res = await lease.call({});
    expect(res.ok).toBe(true);
    expect(res.provider).toBe('p2');
    expect(res.fallback).toBe(true);
    expect(rt.snapshotStats().fallbacks).toBe(1);
    expect([...snap.fallbackProviders]).toEqual(['p2', 'p3']);   // 只读: 列表没被动
    expect(snap.provider).toBe('p1');                             // 只读: 主 provider 没被改写
    expect(m.opened).toEqual(['p1', 'p2']);
    await rt.closeAll();
  });

  it('没有备用 ⇒ 行为与以前一致 (如实返回失败, 不改任何全局)', async () => {
    const m = mkMulti({ p1: 'fail' });
    const rt = new ModelRuntime(m.ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p1', model: 'm', timeoutMs: 3000 });
    const res = await lease.call({});
    expect(res.ok).toBe(false);
    expect(rt.snapshotStats().fallbacks).toBe(0);
    expect(m.opened).toEqual(['p1']);
    await rt.closeAll();
  });

  it('全部候选都失败 ⇒ 如实失败并写明试过哪些 provider (不假装成功)', async () => {
    const m = mkMulti({ p1: 'fail', p2: 'fail' });
    const rt = new ModelRuntime(m.ports, 5000, 2);
    const lease = await rt.acquire({ provider: 'p1', model: 'm', timeoutMs: 3000, fallbackProviders: ['p2'] });
    const res = await lease.call({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('全部候选失败');
    expect(res.error).toContain('p1 → p2');
    await rt.closeAll();
  });

  it('调用方取消 ⇒ **不回退** (取消了还要再试别的 provider 是错的)', async () => {
    let live = 0;
    const ports: ModelRuntimePorts = {
      sleep: async () => {},
      async openConnection() {
        return {
          id: 'c', async call(_r, sig) {
            live += 1;
            for (let i = 0; i < 40; i += 1) { if (sig.aborted) { const e: any = new Error('ab'); e.name = 'AbortError'; throw e; } await new Promise((r) => setTimeout(r, 5)); }
            live -= 1; return { ok: false, error: 'x' };
          }, async close() {},
        };
      },
    };
    const rt = new ModelRuntime(ports, 5000, 1);
    const lease = await rt.acquire({ provider: 'p1', model: 'm', timeoutMs: 5000, fallbackProviders: ['p2'] });
    const ctl = new AbortController();
    const p = lease.call({}, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toThrow(ModelAbortError);
    expect(rt.snapshotStats().fallbacks).toBe(0);
    await rt.closeAll();
  });

  it('usage: 每次成功/失败都记 (带真实 provider 与回退标记); 记账端口抛错**不影响调用结果**', async () => {
    const m = mkMulti({ p1: 'fail', p2: 'ok' });
    const rt = new ModelRuntime(m.ports, 5000, 2);
    const lease = await rt.acquire({ provider: 'p1', model: 'm', timeoutMs: 3000, fallbackProviders: ['p2'] });
    const res = await lease.call({});
    expect(res.ok).toBe(true);
    expect(m.usage).toHaveLength(1);
    expect(m.usage[0]).toMatchObject({ provider: 'p2', model: 'm', fallback: true, usage: { tokens: 7 } });
    expect(rt.snapshotStats().usageRecorded).toBe(1);
    // 记账端口炸了 ⇒ 调用照样成功, 只记 usageDropped
    m.breakUsage();
    const res2 = await lease.call({});
    expect(res2.ok).toBe(true);
    expect(rt.snapshotStats().usageDropped).toBe(1);
    await rt.closeAll();
  });

  it('429 用尽也可回退 (容量问题不是 bug); 但退避与熔断口径不变', async () => {
    const m = mkMulti({ p1: '429', p2: 'ok' });
    const rt = new ModelRuntime(m.ports, 5000, 2);
    const lease = await rt.acquire({ provider: 'p1', model: 'm', timeoutMs: 3000, fallbackProviders: ['p2'] });
    const res = await lease.call({});
    expect(res.ok).toBe(true);
    expect(res.provider).toBe('p2');
    expect(rt.snapshotStats().retries).toBe(3);       // p1 上用尽重试
    expect(rt.snapshotStats().circuitOpened).toBe(0); // 限流不开路
    await rt.closeAll();
  });
});
