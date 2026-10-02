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

import { ACTOR_STATE_ITEMS, HISTORY_WRITE_FUNNEL, K5_ACCEPTANCE, K5_ACCESSOR_SURFACE, K5_CHANNEL_LOCK, K5_DELETION_PRECONDITIONS, K5_EXECUTION_REQUEST, K5_GOAL_BINDING_RULE, K5_INHERITED_FIELDS, K5_PROGRESS, K5_RUN_BOUNDARY, K5_STEPS } from '../kernel/plan-channel-actor.js';
import { RUN_CONTEXT_FIELDS } from '../kernel/plan-runcontext.js';
import { ChannelActor, SerialMailbox, actorCount, actorCount as registrySize, channelQueueCount, createActorState, currentActorContext, deliverThroughActor, getOrCreateActor, peekActor, resetActors } from '../kernel/channel-actor.js';
import { countEntryExecutionPoints, scanAccessorSurface, scanActorLedger, scanChannelLock, scanEntryDelivery, scanExecutionRequest, scanHistoryWriteSites, scanPreconditionBacking, scanRunBoundaryResidence, type K5LedgerLike } from '../kernel/gate-scan.js';
import * as gateScan from '../kernel/gate-scan.js';

const ROOT = path.join(__dirname, '..', '..');
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
// K5 步骤⑧ 新增: 访问器棘轮 + 前置背书
const PI_SRC_TEXT = fs.readFileSync(path.join(SRC, 'agents/pi-sdk.ts'), 'utf-8');
const JUDGE_NAMES = Object.keys(gateScan).filter((k) => k.startsWith('scan'));

describe('K5 步骤⑧ 门: 访问器棘轮 + 前置背书', () => {
  it('★ 判据: pi-sdk 对已迁字段访问器的引用数 == 台账 (增=回退, 减=改了盘没改账)', () => {
    expect(scanAccessorSurface(PI_SRC_TEXT, K5_ACCESSOR_SURFACE)).toEqual([]);
    const bumped = PI_SRC_TEXT.replace(/(\n\s*private get currentChannelId)/, '\n    const _x = this.currentChannelId;$1');
    expect(scanAccessorSurface(bumped, K5_ACCESSOR_SURFACE).length).toBeGreaterThan(0);
    const shaved = PI_SRC_TEXT.replace('this.currentChannelId', 'this.actor!.state.channelId');
    expect(scanAccessorSurface(shaved, K5_ACCESSOR_SURFACE).some((f: any) => f.what.includes('盘上变了账没跟上'))).toBe(true);
    expect(scanAccessorSurface(PI_SRC_TEXT, { accessorFields: ['messageHistory'], frozenInPiSdk: {} }).length).toBe(1);
  });

  it('★ 判据: 每条删除前置都点名了[盘上存在]的背书 (只核背书存在, 不代替真跑)', () => {
    expect(scanPreconditionBacking(K5_DELETION_PRECONDITIONS as any, { repoRoot: ROOT, judgeNames: JUDGE_NAMES })).toEqual([]);
    const bogus = K5_DELETION_PRECONDITIONS.map((p: any, i: number) => (i === 3 ? { ...p, backedBy: ['src/test/no-such-file.test.ts'] } : p));
    expect(scanPreconditionBacking(bogus as any, { repoRoot: ROOT, judgeNames: JUDGE_NAMES }).length).toBe(1);
    const bogus2 = K5_DELETION_PRECONDITIONS.map((p: any, i: number) => (i === 4 ? { ...p, backedBy: ['scanNoSuchJudge'] } : p));
    expect(scanPreconditionBacking(bogus2 as any, { repoRoot: ROOT, judgeNames: JUDGE_NAMES }).length).toBe(1);
    expect(scanPreconditionBacking([{ text: 'x', backedBy: [] }] as any, { repoRoot: ROOT, judgeNames: JUDGE_NAMES }).length).toBe(1);
    expect(scanPreconditionBacking([] as any, { repoRoot: ROOT, judgeNames: JUDGE_NAMES }).length).toBe(1);
  });
});

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
    // web 入口已全部执行点投递 (server.ts 11/11 + routes-tasks 1/1) ⇒ 四入口里完成 1 条
    // web (2 面) + CLI 主入口 + 子 Agent/Supervisor 面 的执行点都已投递 ⇒ 四入口里完成 3 条
    // 四条入口 (web / CLI / P2P 入站 / Supervisor·子Agent) 的执行点都已投递
    expect(K5_PROGRESS.entriesWired).toBe(4);
    expect(K5_PROGRESS.entryGroups.length).toBe(4);
    expect(K5_PROGRESS.entrySites.filter((s) => s.total > 0 && s.total === s.wired).length).toBe(4);
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
    // ⚠️ `forceNew` 是工厂的**第二参**, 不是 config 里的字段 (塞进 config 不生效 ⇒ 会走单例)
    const mk = (cfg: any, forceNew?: boolean) => createAgentSession({ cwd: process.cwd(), ...cfg }, forceNew);
    // ① 无身份 (既无 peerId 也无 loadSessionKey) ⇒ 拿一个**私有 actor** (步骤⑧: 出生就有, 但不进注册表 ⇒ 不共享)
    const sNone: any = await mk({});
    expect(sNone.actor).toBeTruthy();
    expect(actorCount()).toBe(0);                       // **注册表为空** ⇒ 谁也拿不到它 (不共享)
    //   (注意: 无 peerId 走工厂**单例**路径 ⇒ 两次调用返回**同一个 session**, actor 自然也相同 —— 不是共享 bug)
    expect((await mk({})).actor).toBe(sNone.actor);
    // 真正要守的是"两个无身份 session 各拿一份": 用 forceNew 绕开单例
    const sNone2: any = await mk({}, true);
    expect(sNone2).not.toBe(sNone);
    expect(sNone2.actor).not.toBe(sNone.actor);        // 各一份私有 actor (隔离)
    expect(actorCount()).toBe(0);                      // 都还没进注册表
    // 注意塞的是**消息对象**不是裸字符串 (塞字符串会让 `m.content` 变成 undefined —— 实测污染过共享单例)
    await sNone.actor.submit((st: any) => { st.messageHistory.push({ role: 'user', content: 'only-mine' }); });
    expect(sNone2.actor.state.messageHistory).toEqual([]);
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

  it('★ 真跑: 无身份的会话走**私有 actor** (步骤⑧: 兜底暂存字段已删, 但隔离语义不变)', async () => {
    resetActors();
    // forceNew: 不拿工厂共享单例 (自足用例, 不受同文件其它用例影响)
    const s: any = await createAgentSession({ cwd: process.cwd() }, true);   // 无身份 ⇒ 私有 actor
    expect(s.actor).toBeTruthy();
    expect(actorCount()).toBe(0);   // 私有 ⇒ 不在注册表
    s.pushHistory({ role: 'user', content: 'local1' });
    expect(s.actor.state.messageHistory.map((m: any) => m.content)).toEqual(['local1']);
    expect(s.popHistory()?.content).toBe('local1');
    expect(s.actor.state.messageHistory.length).toBe(0);
    s.replaceHistory([{ role: 'system', content: 'local2' }] as any);
    expect(s.actor.state.messageHistory.map((m: any) => m.content)).toEqual(['local2']);
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
    expect(scanHistoryWriteSites(strip(PI_SRC), HISTORY_WRITE_FUNNEL)).toEqual([]);      // 盘上真实源码 ⇒ 绿
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
    // 步骤⑧ 起漏斗里只有一条路径 (写 actor); 注入点改到那一条上
    const injected = base.replace('this.actor!.appendMessageSync(m);', 'this.messageHistory.push(m);');
    expect(injected).not.toBe(base);
    expect(scanHistoryWriteSites(injected, HISTORY_WRITE_FUNNEL).some((f) => f.rule === 'history-direct-push')).toBe(true);
    // 漏斗方法被删 ⇒ 红
    expect(scanHistoryWriteSites('const x = 1;', HISTORY_WRITE_FUNNEL).some((f) => f.rule === 'history-funnel-missing')).toBe(true);
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

  it('★ 真跑: 重入不许自锁 —— 已在同一 actor 里跑的任务再投递 ⇒ 直跑 (否则死锁)', async () => {
    resetActors();
    const holder = { actor: new ChannelActor() };
    // 若没有重入保护, 内层 submit 会排到"自己"后面 ⇒ 永远等不到 ⇒ 本用例超时红
    const out = await deliverThroughActor(holder, async () => {
      const inner = await deliverThroughActor(holder, async () => 'inner');
      const deepest = await deliverThroughActor(holder, async () => 'deep');
      return `outer(${inner},${deepest})`;
    });
    expect(out).toBe('outer(inner,deep)');
    expect(currentActorContext()).toBeUndefined();          // 跑完上下文必须清干净
    // 反向对照: 已在外层任务里 vs 外层不在 actor 里 —— 后者照常排队 (不因重入保护而失效)
    const other = { actor: new ChannelActor() };
    const seq: string[] = [];
    await Promise.all([
      deliverThroughActor(other, async () => { seq.push('1:start'); await new Promise((r) => setTimeout(r, 20)); seq.push('1:end'); }),
      deliverThroughActor(other, async () => { seq.push('2:start'); seq.push('2:end'); }),
    ]);
    expect(seq).toEqual(['1:start', '1:end', '2:start', '2:end']);
    resetActors();
  });

  it('★ 真跑: channel 级串行锁 (opt-in) —— 同 channel 跨身份排队 / 跨 channel 并行 / 重入不自锁', async () => {
    resetActors();
    // ⚠️ `deliverThroughActor` 收的是 **holder** (带 `.actor` 的对象), 不是 actor 本身 ——
    //   生产调用点传的是 agent session (`session.actor` 由 factory 绑定); 直接传 actor 会走兜底直跑 (实测踩过)。
    const mk = (ch: string) => { const a = new ChannelActor(); a.state.channelId = ch; return { actor: a }; };
    const log: string[] = [];
    const job = (tag: string, ms: number) => async () => {
      log.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${tag}:end`);
      return tag;
    };
    // ① 同 channel、**不同身份** (两个 actor) + 开锁 ⇒ 必须排队 (这是身份锁做不到的那一半)
    const a1 = mk('ch-1'), a2 = mk('ch-1');
    await Promise.all([
      deliverThroughActor(a1, job('x', 30), { serializeByChannel: true }),
      deliverThroughActor(a2, job('y', 1), { serializeByChannel: true }),
    ]);
    expect(log).toEqual(['x:start', 'x:end', 'y:start', 'y:end']);
    // ② 不开锁 (默认) ⇒ 各自身份各自跑, 短的可先结束 (说明默认没被过度串行化)
    log.length = 0;
    await Promise.all([
      deliverThroughActor(mk('ch-1'), job('p', 30)),
      deliverThroughActor(mk('ch-1'), job('q', 1)),
    ]);
    expect(log).toEqual(['p:start', 'q:start', 'q:end', 'p:end']);
    // ③ 跨 channel 开锁 ⇒ 互不影响 (真并行)
    log.length = 0;
    await Promise.all([
      deliverThroughActor(mk('ch-A'), job('m', 30), { serializeByChannel: true }),
      deliverThroughActor(mk('ch-B'), job('n', 1), { serializeByChannel: true }),
    ]);
    expect(log).toEqual(['m:start', 'n:start', 'n:end', 'm:end']);
    // ④ 重入: 已在同 channel 队列的任务里再投递 ⇒ 直跑 (否则自锁)
    const nested = await deliverThroughActor(mk('ch-1'), async () => {
      const inner = await deliverThroughActor(mk('ch-1'), async () => 'inner', { serializeByChannel: true });
      return `outer(${inner})`;
    }, { serializeByChannel: true });
    expect(nested).toBe('outer(inner)');
    // ⑤ channelId 为空的 actor 开锁也安全 (退回身份级)
    expect(await deliverThroughActor({ actor: new ChannelActor() }, async () => 'ok', { serializeByChannel: true })).toBe('ok');
    // ⑥ 把 actor **直接**当 holder 传 ⇒ 走兜底直跑 (不算投递) —— 这条守住"holder 语义"不被误用
    const bare = new ChannelActor();
    expect(await deliverThroughActor(bare, async () => 'bare', { serializeByChannel: true })).toBe('bare');
    expect((bare as any).mailbox.processed).toBe(0);
    resetActors();
    expect(channelQueueCount()).toBe(0);
  });

  it('★ 判据: channel 级串行锁的开关必须与盘上事实一致 (双向)', () => {
    const files = ['web/server.ts', 'web/routes-tasks.ts', 'index.ts', 'agents/runner-resolver.ts'];
    const sources = files.map((file) => ({ file, text: fs.readFileSync(path.join(SRC, file), 'utf-8') }));
    // 台账与盘上一致 (当前: 能力已备, 未启用)
    expect(scanChannelLock(sources, K5_CHANNEL_LOCK)).toEqual([]);
    expect(K5_CHANNEL_LOCK.available).toBe(true);
    expect(K5_CHANNEL_LOCK.enabled).toBe(false);
    expect(K5_CHANNEL_LOCK.callSites).toBe(0);
    // 判别力: 台账说启用但盘上没有 ⇒ 红; 台账说没启用但盘上有 ⇒ 红; 数量不符 ⇒ 红
    expect(scanChannelLock(sources, { enabled: true, callSites: 0 })
      .some((f) => f.rule === 'channel-lock-mismatch')).toBe(true);
    expect(scanChannelLock([{ file: 'x.ts', text: 'deliverThroughActor(a, r, { serializeByChannel: true });' }], { enabled: false, callSites: 0 })
      .some((f) => f.rule === 'channel-lock-mismatch')).toBe(true);
    expect(scanChannelLock([{ file: 'x.ts', text: 'deliverThroughActor(a, r, { serializeByChannel: true });' }], { enabled: true, callSites: 2 })
      .some((f) => f.rule === 'channel-lock-mismatch')).toBe(true);
  });

  it('★ 真跑: Run 身份 (currentRunId) 的本体住进 actor.activeRun (K5 步骤⑥)', async () => {
    resetActors();
    const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5run:s1' });
    expect(s.actor).toBeTruthy();
    expect(s.actor.state.activeRun).toBe('');
    s.currentRunId = 'run-x';                              // 写入落 actor
    expect(s.actor.state.activeRun).toBe('run-x');
    s.actor.state.activeRun = 'run-y';                     // 直改 actor ⇒ 实例读得到 (同一个值)
    expect(s.currentRunId).toBe('run-y');
    // 播种读取 (K2 的唯一入口) 必须读到 actor 里的值 —— 它是 e2e 的 runId 来源
    expect(s.seedRunContext().runId).toBe('run-y');
    // 无身份的会话走**私有 actor** (步骤⑧), 行为不变
    const plain: any = await createAgentSession({ cwd: process.cwd() }, true);
    expect(plain.actor).toBeTruthy();
    expect(plain.actor).not.toBe(s.actor);             // 私有 ⇒ 与有身份的 actor 不是同一个
    plain.currentRunId = 'run-local';
    expect(plain.currentRunId).toBe('run-local');
    expect(plain.seedRunContext().runId).toBe('run-local');
    resetActors();
  }, 90000);

  it('★ 判据: Run 身份的归属与盘上源码双向一致 (步骤⑥)', () => {
    const PI_SRC = fs.readFileSync(path.join(SRC, 'agents/pi-sdk.ts'), 'utf-8');
    expect(scanRunBoundaryResidence(PI_SRC, K5_RUN_BOUNDARY)).toEqual([]);
    expect(K5_RUN_BOUNDARY.migrated).toBe(true);
    // 判别力: 把实例字段声明注回去 ⇒ 红; 台账说没迁 ⇒ 红
    expect(scanRunBoundaryResidence(PI_SRC + '\n  private currentRunId: string = "";\n', K5_RUN_BOUNDARY)
      .some((f) => f.rule === 'run-boundary-residence')).toBe(true);
    expect(scanRunBoundaryResidence(PI_SRC, { ...K5_RUN_BOUNDARY, migrated: false })
      .some((f) => f.rule === 'run-boundary-residence')).toBe(true);
  });

  it('★ 真跑: 一次性 ExecutionRequest 的绑定落位 (K5 步骤⑦)', async () => {
    resetActors();
    const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5req:s1' });
    expect(s.actor).toBeTruthy();
    s.applyExecutionRequest({ input: 'hi', channelId: 'ch-req', agentId: 'agent-req', goalId: 'goal-req', resumeRunId: 'run-req' });
    // 绑定全部落进 actor (步骤③/⑥ 起它们就是访问器) —— 入口不再需要散着设字段
    expect(s.actor.state.channelId).toBe('ch-req');
    expect(s.actor.state.agentId).toBe('agent-req');
    expect(s.actor.state.goalBinding).toBe('goal-req');
    expect(s.resumeRunId).toBe('run-req');           // run-boundary 值 (恢复模式), 仍是实例字段
    // **没给的不覆盖** (只覆盖显式给出的)
    s.applyExecutionRequest({ input: 'hi2', channelId: 'ch-req' });
    expect(s.actor.state.agentId).toBe('agent-req');
    expect(s.actor.state.goalBinding).toBe('goal-req');
    expect(s.resumeRunId).toBe('run-req');
    // 唯一入口存在且可调 (派发到 prompt/promptStream 由既有测试覆盖)
    expect(typeof s.runExecution).toBe('function');
    resetActors();
  }, 90000);

  it('★ 判据: 一次性请求的收敛进度可数 (步骤⑦)', () => {
    const entryFiles = K5_PROGRESS.entrySites.map((s) => s.file);
    const sources = entryFiles.map((file) => ({ file, text: fs.readFileSync(path.join(SRC, file), 'utf-8') }));
    const PI_SRC = fs.readFileSync(path.join(SRC, 'agents/pi-sdk.ts'), 'utf-8');
    expect(scanExecutionRequest(sources, PI_SRC, K5_EXECUTION_REQUEST)).toEqual([]);
    expect(K5_EXECUTION_REQUEST.methodAdded).toBe(true);
    expect(K5_EXECUTION_REQUEST.remaining).toBe(K5_EXECUTION_REQUEST.wiredTotal - K5_EXECUTION_REQUEST.converted);
    // 判别力: 盘上请求式点数写错 ⇒ 红; 台账说没加而 pi-sdk 里有 ⇒ 红; 超总量 ⇒ 红
    expect(scanExecutionRequest(sources, PI_SRC, { ...K5_EXECUTION_REQUEST, converted: 3 })
      .some((f) => f.rule === 'execution-request-mismatch')).toBe(true);
    expect(scanExecutionRequest(sources, PI_SRC, { ...K5_EXECUTION_REQUEST, methodAdded: false })
      .some((f) => f.rule === 'execution-request-mismatch')).toBe(true);
    expect(scanExecutionRequest(sources, PI_SRC, { ...K5_EXECUTION_REQUEST, converted: 1, wiredTotal: 0 })
      .some((f) => f.rule === 'execution-request-mismatch')).toBe(true);
  });

  it('★ 判据: 入口投递的进度必须能**从盘上重算** (自报无效 · 逐文件表)', () => {
    const sources = K5_PROGRESS.entrySites.map((s) => ({ file: s.file, text: fs.readFileSync(path.join(SRC, s.file), 'utf-8') }));
    // 台账写的必须就是盘上算出来的
    expect(scanEntryDelivery(sources, K5_PROGRESS)).toEqual([]);
    // 口径自证: 精确计数必须排除 `this.prompt(` (CLI readline) 与注释里的示例
    expect(countEntryExecutionPoints('this.prompt("> ");')).toBe(0);
    expect(countEntryExecutionPoints('// await agent.prompt(x)')).toBe(0);
    expect(countEntryExecutionPoints('* await agent.prompt(x)')).toBe(0);
    expect(countEntryExecutionPoints('await agent.prompt(x);')).toBe(1);
    expect(countEntryExecutionPoints('await agent.promptStream(y, cb);')).toBe(1);
    // 排除 receiver 名单是**数据**: 不排除时 `s.prompt(...)` 会被算成执行点; 排除后归 0 (它就是 UI 打印助手)
    expect(countEntryExecutionPoints('s.prompt(`📩 ${x}`);')).toBe(1);
    expect(countEntryExecutionPoints('s.prompt(`📩 ${x}`);', { excludeReceivers: ['this', 's'] })).toBe(0);
    // 每条入口面的执行点都必须「登记 == 已投递」才能算完 (web / CLI / 子Agent·Supervisor 三条已完成)
    const done = K5_PROGRESS.entrySites.filter((s) => s.total > 0 && s.total === s.wired);
    expect(done.map((s) => s.file).sort()).toEqual(['agents/runner-resolver.ts', 'index.ts', 'web/routes-tasks.ts', 'web/server.ts']);
    expect(K5_PROGRESS.entriesWired).toBe(4);
    expect(K5_PROGRESS.entryGroups.every((g) => g.wired)).toBe(true);
    // 判别力: 少包一处却把 wired 写大 ⇒ 红; 新增执行点不登记 ⇒ 红; wired > total ⇒ 红; 文件不在扫描面 ⇒ 红
    const first = K5_PROGRESS.entrySites[0];
    const withSites = (sites: any, over: any = {}) => ({ ...K5_PROGRESS, entrySites: sites, ...over });
    expect(scanEntryDelivery(sources, withSites([{ ...first, wired: first.wired + 1 }]))
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    expect(scanEntryDelivery(sources, withSites([{ ...first, total: first.total + 1 }]))
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    expect(scanEntryDelivery(sources, withSites([{ file: 'web/server.ts', total: 1, wired: 99 }]))
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    expect(scanEntryDelivery(sources, withSites([{ file: '不存在.ts', total: 0, wired: 0 }]))
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    // **入口级双向校验**: 说完成但文件没接完 ⇒ 红; 文件全接完却说没完成 ⇒ 红; entriesWired 与分组不一致 ⇒ 红
    expect(scanEntryDelivery(sources, withSites(K5_PROGRESS.entrySites, { entryGroups: [{ entry: 'x', files: ['index.ts'], wired: false }] }))
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
    expect(scanEntryDelivery(sources, withSites(K5_PROGRESS.entrySites, { entryGroups: [{ entry: 'y', files: ['index.ts'], wired: true }], entriesWired: 0 }))
      .some((f) => f.rule === 'entry-delivery-mismatch')).toBe(true);
  });

  it('★ 真跑: 三个会话绑定 (channelId/agentId/goalBinding) 的本体住进 Actor (含构造期收养)', async () => {
    resetActors();
    const s: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5bind:s1', agentId: 'agent-A' });
    expect(s.actor).toBeTruthy();
    // ① **构造期收养**: 构造里设的 agentId (落在出生时的私有 actor 上) 必须已搬进身份 actor
    expect(s.actor.state.agentId).toBe('agent-A');
    expect(registrySize()).toBe(1);   // 只有身份 actor 进注册表 (私有那个不进)
    // ② 写入落到 actor
    s.currentChannelId = 'ch-x';
    s.actor.state.goalBinding = 'goal-1';
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
    expect(s2.actor.state.goalBinding).toBe('goal-1');
    // ⑤ 不同会话身份完全隔离 (别人的绑定看不到)
    const s3: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5bind:other' });
    expect(s3.actor).not.toBe(s.actor);
    expect(s3.currentChannelId).toBe('');
    expect(s3.actor.state.goalBinding).toBe('');
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


  it('★ 钉住反例 (步骤⑧ 实测过): 构造期异步回灌必须落进**身份 actor**, 不许落进"被遗弃的私有 actor"', async () => {
    resetActors();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5hyd-'));
    try {
      const store = new SessionStore({ cacheDir: dir });
      await (store as any).saveMessages('cli:hyd-probe', [
        { role: 'user', content: 'u1', timestamp: 1, source: 'test' },
        { role: 'assistant', content: 'a1', timestamp: 2, source: 'test' },
      ]);
      const s: any = await createAgentSession(
        { cwd: process.cwd(), peerId: 'k5hyd:s1', loadSessionKey: 'cli:hyd-probe', sessionStore: store },
        true,
      );
      await s.whenReady();
      // ① 回灌必须在**这个** actor 上 (第一版 bug: 日志说回灌 2 条, 这里却是 0)
      expect(s.actor.state.messageHistory.length).toBe(2);
      expect(s.actor.state.messageHistory.length).toBe(2);
      // ② 而且必须是**注册表里那个**身份 actor (不是私有 actor 的残留)
      expect(s.actor).toBe(peekActor('cli:hyd-probe'));
      expect(s.actor.state.messageHistory.map((m: any) => m.content)).toEqual(['u1', 'a1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetActors();
    }
  }, 60000);

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
      expect((sA as any).actor.state.messageHistory.length).toBe(2);
      // B 是**独立会话** ⇒ 不许看到 A 刚灌进来的历史 (无论 actor 是否按 channel 共享)
      const sB: any = await createAgentSession({ cwd: process.cwd(), peerId: 'k5iso:s2', sessionStore: store });
      expect((sB as any).actor.state.messageHistory.length).toBe(0);
      // 只有 B 自己 resume 那个 key 之后才看得到内容
      const nB = await sB.resumeSession('k5iso:conv-1');
      expect(nB).toBe(2);
      expect((sB as any).actor.state.messageHistory.length).toBe(2);
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
