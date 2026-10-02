/**
 * K5 门: Channel Actor 台账 (完整性 + **与盘上事实同步** + 跨台账一致)
 *
 * K5 要搬的 4 个字段是**会话状态** (K2 已按 leo 口径判定不搬进 RunContext)。这条路线最容易出的两种假账:
 *   ① 台账写"容器未建 / 进度 0", 但盘上其实已经建了 (或反过来: 标了进度却什么都没有);
 *   ② K2 移交清单里抄错访问数 —— 两个台账各说各话。
 * 所以判据有三件硬要求: **真读盘核对容器存在性** · **进度棘轮** · **跨台账逐字相等**。
 *
 * 纪律: 真读盘 · 判据是纯函数 · 变异每次跑测试真做 · 拿不到事实就拒跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../agents/session-store.js';
import { createAgentSession } from '../agents/pi-sdk-session-factory.js';

import {
  ACTOR_STATE_ITEMS,
  K5_ACCEPTANCE,
  K5_DELETION_PRECONDITIONS,
  K5_GOAL_BINDING_RULE,
  K5_INHERITED_FIELDS,
  K5_PROGRESS,
  K5_STEPS,
} from '../kernel/plan-channel-actor.js';
import { RUN_CONTEXT_FIELDS } from '../kernel/plan-runcontext.js';
import { ChannelActor, SerialMailbox, actorCount, createActorState, deliverThroughActor, getOrCreateActor, peekActor, resetActors } from '../kernel/channel-actor.js';
import { type K5LedgerLike, scanActorLedger, scanEntryDelivery, scanHistoryWriteSites } from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');
const KERNEL = path.join(SRC, 'kernel');
/** 台账里的路径是**相对 src** 的 (containerPath = 'kernel/channel-actor.ts') ⇒ 拼 SRC, 不是拼 KERNEL */
const exists = (rel: string) => fs.existsSync(path.join(SRC, rel));

const LEDGER: K5LedgerLike = {
  stateItems: ACTOR_STATE_ITEMS,
  acceptance: K5_ACCEPTANCE,
  steps: K5_STEPS,
  preconditions: K5_DELETION_PRECONDITIONS,
  inheritedFields: K5_INHERITED_FIELDS,
  progress: K5_PROGRESS,
};
const K2_SESSION = RUN_CONTEXT_FIELDS.filter((f) => f.scope === 'session').map((f) => ({ name: f.name, accesses: f.accesses }));

describe('K5 门: Channel Actor 台账', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(ACTOR_STATE_ITEMS.length).toBeGreaterThan(0);
    expect(K2_SESSION.length).toBe(4);
  });

  it('台账完整 + 与盘上事实同步 + 跨台账一致', () => {
    expect(scanActorLedger(LEDGER, { exists, k2SessionFields: K2_SESSION })).toEqual([]);
  });

  it('9 项 Actor 状态逐条有名有据 (不许占位)', () => {
    for (const i of ACTOR_STATE_ITEMS) {
      expect(i.name.length).toBeGreaterThan(2);
      expect(i.why.length).toBeGreaterThan(10);
      expect(i.owner.length).toBeGreaterThan(0);
    }
    for (const need of ['channelId', 'agentId', 'goalBinding', 'messageHistory', 'mailbox', 'activeRun', 'cancellation', 'outboundStream', 'serialLock']) {
      expect(ACTOR_STATE_ITEMS.map((i) => i.name)).toContain(need);
    }
  });

  it('从 K2 移交的 4 个字段的访问数与 K2 台账逐字相等', () => {
    for (const f of K5_INHERITED_FIELDS) {
      const k2 = RUN_CONTEXT_FIELDS.find((x) => x.name === f.name)!;
      expect(k2).toBeTruthy();
      expect(k2.scope).toBe('session');
      expect(f.accesses).toBe(k2.accesses);
    }
    expect(K5_INHERITED_FIELDS.map((f) => f.name).sort()).toEqual(K2_SESSION.map((f) => f.name).sort());
  });

  it('Goal 绑定必须是显式操作 (口径留档)', () => {
    expect(K5_GOAL_BINDING_RULE).toContain('显式');
    expect(K5_GOAL_BINDING_RULE).toContain('不许靠裸字段');
  });

  it('台账与盘上事实一致: 标了 registry-built ⇒ 容器文件必须真的存在', () => {
    expect(K5_PROGRESS.stage).toBe('registry-built');
    expect(fs.existsSync(path.join(SRC, K5_PROGRESS.containerPath))).toBe(true);
    // 容器建了 ≠ 字段迁了 / 入口接了 (第 4 步第一版被全量回归否掉并回退 ⇒ 两个计数都必须是 0)
    expect(K5_PROGRESS.fieldsMigrated).toBe(4);
    expect(K5_PROGRESS.migratedFieldNames).toEqual(['messageHistory', 'currentChannelId', 'currentAgentId', 'currentGoalId']);
    expect(K5_PROGRESS.entriesWired).toBe(0);
  });

  it('串行语义真跑: 同 Channel 内任务永不交错, 且按入队顺序执行', async () => {
    const actor = new ChannelActor({ channelId: 'c1' });
    const log: string[] = [];
    const task = (name: string, gapMs: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, gapMs));
      log.push(`${name}:end`);
      return name;
    };
    // 故意让后入队的任务更短 —— 若并发, 它会先结束 (交错)
    const results = await Promise.all([
      actor.submit(task('a', 30)),
      actor.submit(task('b', 10)),
      actor.submit(task('c', 1)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(actor.mailbox.pending).toBe(0);
    expect(actor.mailbox.processed).toBe(3);
  });

  it('一个任务抛错不阻塞队列 (错误交给调用方, 队列继续)', async () => {
    const mb = new SerialMailbox();
    const ran: string[] = [];
    const bad = mb.submit(async () => { ran.push('bad'); throw new Error('boom'); });
    const good = mb.submit(async () => { ran.push('good'); return 42; });
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe(42);
    expect(ran).toEqual(['bad', 'good']);
    await mb.drain();
    expect(mb.pending).toBe(0);
  });

  it('跨 Actor 隔离: 两个 channel 的 history 互不可见', async () => {
    const a = new ChannelActor({ channelId: 'a' });
    const b = new ChannelActor({ channelId: 'b' });
    await a.submit((st) => { st.messageHistory.push('A1'); });
    await b.submit((st) => { st.messageHistory.push('B1'); });
    expect(a.state.messageHistory).toEqual(['A1']);
    expect(b.state.messageHistory).toEqual(['B1']);
    expect(a.state.channelId).not.toBe(b.state.channelId);
  });

  it('取消位: beginCancellation/abort 语义 (取代 Pi 上的 currentSignal)', () => {
    const actor = new ChannelActor();
    expect(actor.state.cancellation).toBeNull();
    const signal = actor.beginCancellation();
    expect(signal.aborted).toBe(false);
    actor.abort();
    expect(signal.aborted).toBe(true);
    expect(actor.state.cancellation).toBeNull();
  });

  it('★ 注册表: 键是**会话身份** (不是 channel 前缀), 同身份幂等 / 跨身份隔离', () => {
    resetActors();
    expect(actorCount()).toBe(0);
    const a1 = getOrCreateActor('cli:conv-1', { channelId: 'cli' });
    const a2 = getOrCreateActor('cli:conv-1', { channelId: 'cli' });
    const a3 = getOrCreateActor('cli:conv-2', { channelId: 'cli' });
    expect(a1).toBe(a2);                                  // 同身份幂等
    expect(a1).not.toBe(a3);                              // **同 channel 不同会话身份必须隔离** (全量回归实证)
    expect(a1.state.channelId).toBe('cli');               // channel 归属可以相同
    expect(a3.state.channelId).toBe('cli');
    expect(actorCount()).toBe(2);
    // **身份键 ≠ channel 绑定**: 不预置 channelId ⇒ 新建时为空 (由会话/入口设置)
    expect(getOrCreateActor('chanZ').state.channelId).toBe('');
    // 已有的 actor 不被后来的 init 覆盖
    const again = getOrCreateActor('cli:conv-1', { agentId: '不该生效' });
    expect(again).toBe(a1);
    expect(a1.state.agentId).toBe('');
    expect(peekActor('不存在')).toBeUndefined();
    resetActors();
    expect(actorCount()).toBe(0);
  });

  it('★ 真跑: 会话身份决定归属 —— 同身份共享 actor, 不同身份隔离, 无身份不归属', async () => {
    resetActors();
    const { createAgentSession } = await import('../agents/pi-sdk-session-factory.js');
    const mk = (cfg: any) => createAgentSession({ cwd: process.cwd(), ...cfg });
    // ① 无身份 (既无 peerId 也无 loadSessionKey) ⇒ **不归属** (没有 default 兜底桶)
    const sNone: any = await mk({});
    expect(sNone.actor).toBeUndefined();
    // ② 同 channel 前缀、不同会话身份 ⇒ 各自 actor, history 互不可见 (当年泄漏的形状)
    const s1: any = await mk({ peerId: 'k5probe-a:s1' });
    const s2: any = await mk({ peerId: 'k5probe-a:s2' });
    expect(s1.actor).toBeTruthy();
    expect(s1.actor.state.channelId).toBe('');            // channel 绑定由入口设置 ⇒ 新建时为空 (不预置)
    expect(s1.actor).not.toBe(s2.actor);                  // **身份不同 ⇒ 不同 actor** (同前缀也隔离)
    // ③ 同身份 (同 loadSessionKey) ⇒ 同一个 actor, 同一份 history
    const s3: any = await mk({ peerId: 'k5probe-c:one', loadSessionKey: 'k5probe-c:conv' });
    const s4: any = await mk({ peerId: 'k5probe-c:two', loadSessionKey: 'k5probe-c:conv' });
    expect(s3.actor).toBe(s4.actor);
    await s3.actor.submit((st: any) => { st.messageHistory.push('shared'); });
    expect(s4.actor.state.messageHistory).toEqual(['shared']);
    resetActors();
  }, 90000);

  it('★ 真跑: hydrate / persist / append 走邮箱 ⇒ 与 append 串行 (读-改-写不再被并发踩)', async () => {
    const actor = new ChannelActor({ channelId: 'k5ops' });
    // ① hydrate 的 load 故意慢 25ms; 紧接着提交 snapshot ⇒ 若并发, snapshot 会看到**空**
    const p = actor.hydrateHistory<{ role: string; content: string }>({
      load: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return [{ role: 'user', content: 'h1' }, { role: 'assistant', content: 'h2' }];
      },
      filter: (l) => l as { role: string; content: string }[],
      maxMessages: 10,
    });
    const snap = actor.historySnapshot<{ role: string; content: string }>();
    expect(await p).toBe(2);
    expect((await snap).map((m) => m.content)).toEqual(['h1', 'h2']);   // 串行的证据: 看得见刚灌进去的
    // ② append 也排队: 先 append 再 snapshot ⇒ 一定看得见
    await actor.appendMessage({ role: 'user', content: 'a1' });
    expect((await actor.historySnapshot<{ role: string; content: string }>()).map((m) => m.content))
      .toEqual(['h1', 'h2', 'a1']);
    // ③ 截断规则: maxMessages 生效 (只留最后 N 条)
    await actor.hydrateHistory<{ role: string; content: string }>({
      load: async () => [{ role: 'user', content: 'old' }, { role: 'user', content: 'new' }],
      filter: (l) => l as { role: string; content: string }[],
      maxMessages: 1,
    });
    expect((await actor.historySnapshot<{ role: string; content: string }>()).map((m) => m.content)).toEqual(['new']);
    // ④ 空/无历史不破坏现状
    expect(await actor.hydrateHistory({ load: async () => null, filter: () => [], maxMessages: 5 })).toBe(0);
    expect((await actor.historySnapshot<{ role: string; content: string }>()).length).toBe(1);
  });

  it('★ 真跑: history 写入的唯一漏斗 (push/pop/替换) 都落到 Actor 上', async () => {
    resetActors();
    const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5fun:s1' });
    expect(s.actor).toBeTruthy();
    const before = s.actor.state.messageHistory.length;
    // 私有漏斗通过 `as any` 直驱 (它们就是"所有写入的唯一入口")
    s.pushHistory({ role: 'user', content: 'f1' }, { role: 'assistant', content: 'f2' });
    expect(s.actor.state.messageHistory.slice(before).map((m: any) => m.content)).toEqual(['f1', 'f2']);
    expect(s.popHistory()?.content).toBe('f2');
    expect(s.actor.state.messageHistory.length).toBe(before + 1);
    s.replaceHistory([{ role: 'system', content: 'r1' }] as any);
    expect(s.actor.state.messageHistory.map((m: any) => m.content)).toEqual(['r1']);
    resetActors();
  }, 90000);

  it('★ 真跑: 未绑定 actor 的会话走**本地数组**兜底分支 (曾经因机械替换变成自递归, 测试没覆盖到)', async () => {
    resetActors();
    const s: any = await createAgentSession({ cwd: process.cwd() });   // 无身份 ⇒ 不归属
    expect(s.actor).toBeUndefined();
    s.pushHistory({ role: 'user', content: 'local1' });
    expect(s.messageHistory.map((m: any) => m.content)).toEqual(['local1']);
    expect(s.popHistory()?.content).toBe('local1');
    expect(s.messageHistory.length).toBe(0);
    s.replaceHistory([{ role: 'system', content: 'local2' }] as any);
    expect(s.messageHistory.map((m: any) => m.content)).toEqual(['local2']);
    resetActors();
  }, 90000);

  it('★ 判据: 漏斗之外不许直写 history (唯一漏斗判据 + 判别力)', () => {
    const PI_SRC = fs.readFileSync(path.join(SRC, 'agents/pi-sdk.ts'), 'utf-8');
    // 剥注释 (judge 吃源码文本 ⇒ 必须先剥, 否则文档里的示例会被当成真写入)。
    //   注意: 这里刻意用正则字面量与 String.fromCharCode(10) —— 避免把 \n 写进字符串字面量 (已被转义坑过一次)。
    const NL = String.fromCharCode(10);
    const strip = (t: string) => t
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => !/^\s*\*/.test(l))
      .join(NL);
    expect(scanHistoryWriteSites(strip(PI_SRC))).toEqual([]);      // 盘上真实源码 ⇒ 绿
    // 判别力: 在漏斗之外注入一处直写 ⇒ 必须判红
    const base = strip(PI_SRC);
    // 三个直写模式在盘上源码里必须是 0 处
    const direct: [string, RegExp][] = [
      ['push', /this\.messageHistory\.push\(/g],
      ['pop', /this\.messageHistory\.pop\(\)/g],
      ['assign', /this\.messageHistory\s*=\s/g],
    ];
    for (const [id, re] of direct) {
      expect(`${id}=${(base.match(re) ?? []).length}`).toBe(`${id}=0`);
    }
    const injected = base.replace('else this._history.push(m);', 'else this.messageHistory.push(m);');
    expect(injected).not.toBe(base);
    expect(scanHistoryWriteSites(injected).some((f) => f.rule === 'history-direct-push')).toBe(true);
    // 漏斗方法被删 ⇒ 红
    expect(scanHistoryWriteSites('const x = 1;').some((f) => f.rule === 'history-funnel-missing')).toBe(true);
    // 异步压缩的落地拍必须在盘上 (rebase 是"变换期间追加不被吃掉"的唯一保障)
    expect(base.includes('this.actor.rebaseHistory<Message>(')).toBe(true);
  });

  it('★ 真跑: 入口投递 —— 同会话身份排队 / 跨身份并行 / 无身份直跑 (K5 步骤④)', async () => {
    resetActors();
    const mk = () => ({ actor: new ChannelActor() });
    const log: string[] = [];
    const job = (tag: string, ms: number) => async () => {
      log.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${tag}:end`);
      return tag;
    };
    // ① 同一会话身份: 两个输入**排队** (第二个等第一个跑完) ⇒ 不并发改 history
    const one = mk();
    const both = await Promise.all([
      deliverThroughActor(one, job('a', 30)),
      deliverThroughActor(one, job('b', 1)),
    ]);
    expect(both).toEqual(['a', 'b']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    // ② 跨会话身份: 各自独立 ⇒ 可以并行 (短的先结束)
    log.length = 0;
    await Promise.all([deliverThroughActor(mk(), job('c', 30)), deliverThroughActor(mk(), job('d', 1))]);
    expect(log).toEqual(['c:start', 'd:start', 'd:end', 'c:end']);
    // ③ 无身份 (没有 actor): 直跑, 行为不变
    log.length = 0;
    await deliverThroughActor({}, job('e', 1));
    await deliverThroughActor(null, job('f', 1));
    expect(log).toEqual(['e:start', 'e:end', 'f:start', 'f:end']);
    resetActors();
  });

  it('★ 判据: 入口投递的进度必须能**从盘上重算** (自报无效)', () => {
    const WSRC = fs.readFileSync(path.join(SRC, 'web/server.ts'), 'utf-8');
    // 盘上真实事实
    const total = (WSRC.match(/promptStream\(/g) ?? []).length;
    const wired = (WSRC.match(/deliverThroughActor\(/g) ?? []).length;
    expect(scanEntryDelivery(WSRC, { file: 'web/server.ts', total, wired })).toEqual([]);
    // 台账写的必须就是盘上算出来的 (否则红)
    expect(scanEntryDelivery(WSRC, K5_PROGRESS.entrySites)).toEqual([]);
    // 判别力: 少包一处却把 wired 写大 ⇒ 红; 新增入口点不登记 ⇒ 红; wired > total ⇒ 红
    expect(scanEntryDelivery(WSRC, { file: 'web/server.ts', total, wired: wired + 1 })
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    expect(scanEntryDelivery(WSRC, { file: 'web/server.ts', total: total + 1, wired })
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    expect(scanEntryDelivery(WSRC, { file: 'web/server.ts', total: 1, wired: 5 })
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
  });

  it('★ 真跑: 三个会话绑定 (channelId/agentId/goalBinding) 的本体住进 Actor (含构造期收养)', async () => {
    resetActors();
    const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5bind:s1', agentId: 'agent-A' });
    expect(s.actor).toBeTruthy();
    // ① **构造期收养**: 构造里设的 agentId 必须已经搬进 actor, 且实例侧暂存清空 (不许两份真相)
    expect(s.actor.state.agentId).toBe('agent-A');
    expect(s._agentId).toBe('');
    // ② 写入落到 actor
    s.currentChannelId = 'ch-x';
    s.currentGoalId = 'goal-1';
    expect(s.actor.state.channelId).toBe('ch-x');
    expect(s.actor.state.goalBinding).toBe('goal-1');
    // ③ 读也来自 actor (直接改 actor ⇒ 实例读得到)
    s.actor.state.channelId = 'ch-y';
    expect(s.currentChannelId).toBe('ch-y');
    // ④ 同会话身份的另一个 session 共享这三处绑定
    const s2: any = await createAgentSession({
      cwd: process.cwd(), peerId: 'k5bind:s2', loadSessionKey: 'k5bind:s1', agentId: 'agent-A',
    });
    expect(s2.actor).toBe(s.actor);
    expect(s2.currentChannelId).toBe('ch-y');
    expect(s2.currentGoalId).toBe('goal-1');
    // ⑤ 不同会话身份完全隔离 (别人的绑定看不到)
    const s3: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5bind:other' });
    expect(s3.actor).not.toBe(s.actor);
    expect(s3.currentChannelId).toBe('');
    expect(s3.currentGoalId).toBe('');
    resetActors();
  }, 90000);

  it('★ 真跑: compact 落地拍 (rebase) —— 变换期间追加的消息**不许被压缩吃掉**', async () => {
    const actor = new ChannelActor({ channelId: 'k5cmp' });
    await actor.appendMessage({ role: 'user', content: 'm1' });
    await actor.appendMessage({ role: 'assistant', content: 'm2' });
    const snapshotLen = (await actor.historySnapshot<{ role: string; content: string }>()).length;
    expect(snapshotLen).toBe(2);
    // 模拟真实形状: 压缩流水线 await 期间, ReAct 循环里有人**同步**追加了一条
    const landing = actor.rebaseHistory([{ role: 'user', content: 'C1' }], snapshotLen);
    actor.appendMessageSync({ role: 'user', content: 'm3' });
    const r = await landing;
    expect(r.keptTail).toBe(1);                                  // 接住了那一条
    expect((await actor.historySnapshot<{ role: string; content: string }>()).map((m) => m.content))
      .toEqual(['C1', 'm3']);                                    // 压缩结果 + 没丢的尾部
    // 反例对照: 若用"整块替换"(不带 rebase), 那条新消息就没了 —— 这正是本拍要修的行为
    const naive = new ChannelActor();
    await naive.appendMessage({ role: 'user', content: 'a' });
    await naive.replaceHistory([{ role: 'user', content: 'C1' }]);
    expect((await naive.historySnapshot<{ role: string; content: string }>()).map((m) => m.content)).toEqual(['C1']);
    // 快照长度越界也不炸 (防御: 压缩期间 history 变短)
    const r2 = await actor.rebaseHistory([{ role: 'user', content: 'X' }], 999);
    expect(r2.keptTail).toBe(0);
    expect((await actor.historySnapshot<{ role: string; content: string }>()).map((m) => m.content)).toEqual(['X']);
  });

  it('★ 真跑 (Pi 侧): resume/save 确实走了 Actor 的邮箱 (委托证据, 不是"看起来像")', async () => {
    resetActors();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-ops-'));
    try {
      const store = new SessionStore({ cacheDir: tmpDir });
      await store.saveMessages('k5ops:conv', [
        { role: 'user', content: 'p1', timestamp: 1, source: 'test' },
        { role: 'assistant', content: 'p2', timestamp: 2, source: 'test' },
      ] as any);
      const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5ops:s1', sessionStore: store });
      const before = s.actor.mailbox.processed;
      expect(await s.resumeSession('k5ops:conv')).toBe(2);
      await s.saveCurrentSession('k5ops:out');
      const after = s.actor.mailbox.processed;
      expect(after - before).toBeGreaterThanOrEqual(2);   // hydrate 一拍 + snapshot 一拍
      const back = (await store.loadMessages('k5ops:out')) as any[];
      expect(back.map((m: any) => m.content)).toEqual(['p1', 'p2']);   // round-trip 内容不变
    } finally {
      resetActors();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90000);

  it('★ 判据 ③c: history 操作搬迁位与名单必须一致', () => {
    const clone = (over: any = {}) => ({ ...LEDGER, ...over } as any);
    const base = { exists, k2SessionFields: K2_SESSION };
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, historyOpsMigrated: 3, historyOpsNames: ['hydrate'] } }), base)
      .some((f) => f.rule === 'actor-ops-mismatch')).toBe(true);
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, historyOpsNames: ['hydrate', '不存在的操作'] } }), base)
      .some((f) => f.rule === 'actor-ops-unknown')).toBe(true);
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, historyOpsMigrated: 9, historyOpsNames: ['hydrate', 'append', 'compact', 'persist', 'a', 'b', 'c', 'd', 'e'] } }), base)
      .some((f) => f.rule === 'actor-ops-overflow')).toBe(true);
  });

  it('★ 真跑: history 本体住进 Actor —— 所有权真转移 (hydrate/persist 都落在 actor 的数组上)', async () => {
    resetActors();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-own-'));
    try {
      const store = new SessionStore({ cacheDir: tmpDir });
      await store.saveMessages('k5own:conv', [
        { role: 'user', content: 'own-1', timestamp: 1, source: 'test' },
        { role: 'assistant', content: 'own-2', timestamp: 2, source: 'test' },
      ] as any);
      const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5own:s1', sessionStore: store });
      expect(s.actor).toBeTruthy();
      expect(s.actor.state.messageHistory.length).toBe(0);

      // ① hydrate 走**写路径** ⇒ 必须落进 actor
      const loaded = await s.resumeSession('k5own:conv');
      expect(loaded).toBe(2);
      expect(s.actor.state.messageHistory.length).toBe(2);

      // ② 直接改 actor 的数组 ⇒ persist 读到的必须就是它 (同一个数组对象, 不是副本)
      s.actor.state.messageHistory.push({ role: 'user', content: 'actor-only-marker' });
      await s.saveCurrentSession('k5own-out');
      const back = (await store.loadMessages('k5own-out')) as any[];
      expect(back.some((m) => m.content === 'actor-only-marker')).toBe(true);
      expect(back.length).toBe(3);

      // ③ **同会话身份**的另一个 session ⇒ 共享同一 actor 与同一份 history
      const s2: any = await createAgentSession({
        cwd: process.cwd(), peerId: 'k5own:s2', loadSessionKey: 'k5own:s1', sessionStore: store,
      });
      expect(s2.actor).toBe(s.actor);
      expect(s2.actor.state.messageHistory.length).toBe(3);

      // ④ **不同会话身份** ⇒ 自己的 actor, 看不到别人的 history
      const s3: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5own:other', sessionStore: store });
      expect(s3.actor).not.toBe(s.actor);
      expect(s3.actor.state.messageHistory.length).toBe(0);
    } finally {
      resetActors();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90000);

  it('★ 钉住反例 (全量回归实证): 同 channel 前缀的两个独立 session 不许看见彼此 history', async () => {
    // 2026-10-02: 第 4 步第一版 (把 history 本体按 channel 前缀挂进 actor) 被全量回归否掉 ——
    //   6 红, 其中 5 红就是这条: 新 session 一构造就看到别人的 history (`expected 2 to be 0`)。
    //   根因: actor 的键是 peerId 的 `:` 前段 (或 default), 而**会话身份 (SessionStore key) 在 hydrate 时才出现**。
    //   ⇒ 这条不变量在这里钉死: 谁再按"channel 前缀"共享 history, 立刻红。
    resetActors();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-iso-'));
    try {
      const store = new SessionStore({ cacheDir: tmpDir });
      await store.saveMessages('k5iso:conv-1', [
        { role: 'user', content: 'iso-1', timestamp: 1, source: 'test' },
        { role: 'assistant', content: 'iso-2', timestamp: 2, source: 'test' },
      ] as any);
      // A 与 B 的 peerId **同 channel 前缀** (k5iso) —— 正是当年泄漏的形状
      const sA: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5iso:s1', sessionStore: store });
      const nA = await sA.resumeSession('k5iso:conv-1');
      expect(nA).toBe(2);
      expect((sA as any).messageHistory.length).toBe(2);
      // B 是**独立会话** ⇒ 不许看到 A 刚灌进来的历史 (无论 actor 是否按 channel 共享)
      const sB: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5iso:s2', sessionStore: store });
      expect((sB as any).messageHistory.length).toBe(0);
      // 只有 B 自己 resume 那个 key 之后才看得到内容
      const nB = await sB.resumeSession('k5iso:conv-1');
      expect(nB).toBe(2);
      expect((sB as any).messageHistory.length).toBe(2);
    } finally {
      resetActors();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90000);

  it('★ 判据 ③b: 进度位与名单必须一致 (迁了几个字段就得逐个点名)', () => {
    const clone = (over: any = {}) => ({ ...LEDGER, ...over } as any);
    const base = { exists, k2SessionFields: K2_SESSION };
    // 名字不在移交字段里 ⇒ 红
    const bad1 = clone({ progress: { ...K5_PROGRESS, migratedFieldNames: ['messageHistory', '不存在的字段'] } });
    expect(scanActorLedger(bad1, base).some((f) => f.rule === 'actor-fieldnames-unknown')).toBe(true);
    // 数量对不上 ⇒ 红
    const bad2 = clone({ progress: { ...K5_PROGRESS, fieldsMigrated: 2, migratedFieldNames: ['messageHistory'] } });
    expect(scanActorLedger(bad2, base).some((f) => f.rule === 'actor-fieldnames-mismatch')).toBe(true);
    // 阶段名超前 (stage 说迁完了, 计数却只到 2/4) ⇒ 红 —— 现在真实是 4/4, 所以要把计数显式改小才测得到
    const bad3 = clone({ progress: { ...K5_PROGRESS, stage: 'fields-migrated', fieldsMigrated: 2, migratedFieldNames: ['messageHistory', 'currentChannelId'] } });
    expect(scanActorLedger(bad3, base).some((f) => f.rule === 'actor-stage-ahead')).toBe(true);
  });

  it('容器语义: 未给的字段显式置空 (镜像 K2 的「不继承残留」)', () => {
    const st = createActorState();
    expect(st.channelId).toBe('');
    expect(st.agentId).toBe('');
    expect(st.goalBinding).toBe('');
    expect(st.messageHistory).toEqual([]);
    expect(st.activeRun).toBe('');
    expect(st.cancellation).toBeNull();
    expect(st.outboundStream).toBeNull();
    expect(st.mailbox).toEqual({ pending: 0, processed: 0 });
  });

  it('判别力自证: 四种坏形状都必须判红', () => {
    const base = { exists, k2SessionFields: K2_SESSION };
    const clone = (o: Partial<K5LedgerLike>) => ({ ...LEDGER, ...o });
    // ① 标 not-started 但容器已存在 (假账) —— 现在容器的确是建了的, 所以要把 stage 显式改回 not-started 才测得到这条
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, stage: 'not-started' } }), { exists: () => true, k2SessionFields: K2_SESSION })
      .some((f) => f.rule === 'actor-stage-stale')).toBe(true);
    // ② 标了进度但容器不存在 (假进度) —— 现在 stage 就是 container-built, 所以注入"盘上没有"
    expect(scanActorLedger(clone({}), { exists: () => false, k2SessionFields: K2_SESSION })
      .some((f) => f.rule === 'actor-container-missing')).toBe(true);
    // ③ 移交字段访问数被抄错 (跨台账漂移)
    expect(scanActorLedger(clone({ inheritedFields: K5_INHERITED_FIELDS.map((f, i) => (i === 0 ? { ...f, accesses: f.accesses + 1 } : f)) }), base)
      .some((f) => f.rule === 'actor-inherit-drift')).toBe(true);
    // ④ 验收标准没接住从 K2 移来的那条
    expect(scanActorLedger(clone({ acceptance: K5_ACCEPTANCE.filter((a) => !a.includes('history')) }), base)
      .some((f) => f.rule === 'actor-handoff-missing')).toBe(true);
    // ⑤ not-started 阶段不许有非零进度 (显式把 stage 改回 not-started 才测得到)
    expect(scanActorLedger(clone({ progress: { ...K5_PROGRESS, stage: 'not-started', fieldsMigrated: 1 } }), base)
      .some((f) => f.rule === 'actor-progress-premature')).toBe(true);
  });

  it('变异: 台账说容器已建、盘上却没有 ⇒ 立刻判红 (假进度)', () => {
    // 镜像方向: 容器真的建了之后, 这条规则换成"标了进度却没有文件"才测得动。
    // **不许在 src/ 里真建/真删文件** —— 多个测试文件并行跑时别的 worker 正在扫这个目录, 会采集成竞态
    // (2026-10-02 实测: 造成 kernel-constraint.test.ts 的并行假红)。判据是纯函数, `exists` 就是它的接缝。
    expect(fs.existsSync(path.join(SRC, K5_PROGRESS.containerPath))).toBe(true); // 盘上事实: 现在真的有
    const findings = scanActorLedger(LEDGER, { exists: () => false, k2SessionFields: K2_SESSION });
    expect(findings.some((f) => f.rule === 'actor-container-missing')).toBe(true);
    // 复原后仍绿
    expect(scanActorLedger(LEDGER, { exists, k2SessionFields: K2_SESSION })).toEqual([]);
  });
});
