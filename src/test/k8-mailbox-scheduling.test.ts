/**
 * k8-mailbox-scheduling.test.ts — K8 收口正刀的**先行门** (2026-10-02)
 *
 * 为什么先写门: 正刀要把 `/message` 的 684 行内联体与 `runMessageFromQueue` 的简化版**合成一条**,
 * 让"每条消息都进内核邮箱"。动手前必须先把**要保住的性质**与**要消灭的缺陷**都钉成判据, 否则
 * 改完只能靠"看起来对"验收。
 *
 * 三条内容:
 *   ① `SerialMailbox` 的既有性质 (同通道**严格串行** + FIFO + 都会跑完) —— 这是要**保住**的;
 *   ② 邮箱**被前序任务占住**时 (现网真会发生: didFix 用同一个 `getChannelQueue(id)`, server.ts 5790),
 *      后投的消息**一条都不能丢**;
 *   ③ **对照实验 (反事实)**: 把现网形状等价复刻一遍 —— `finishChannelRun` **同步**置
 *      `running = false` 后**异步**投邮箱, 加上 `runMessageFromQueue` 的防重入守卫
 *      `if (runState.running) return;` —— 断言它**真的会静默丢掉一条消息**。
 *
 * ③ 的诚实边界 (必须写清, 免得被当成"现网复现"): 它复刻的是**机制与时序**, 不是打真 server。
 *   它证明的是"这个形状**允许**丢消息", 触发条件是: ① drain 之后那条已出队消息的邮箱任务**排在前序任务后面**
 *   ② 这期间新到一条消息 (HTTP 宏任务) 见 `running === false` 就内联起跑 ③ 前一条终于被跑到时撞上守卫 ⇒ 丢。
 *   正刀后这里要改成"每条消息都进邮箱 ⇒ 不可能丢", 那时 ③ 保留为**机制的反面教材** (它测的是复刻件, 不是产品)。
 *   ⇒ **正刀落地时必须补一条 ④**: 用**产品真函数** (`getChannelQueue(...).submit` + 抽出来的
 *     `runChannelMessage`) 跑同一套时序, 断言**一条不丢**; 那时 ③ 与 ④ 成对 = "旧形状丢 / 新形状不丢"。
 */
import { describe, it, expect } from 'vitest';
import { SerialMailbox } from '../kernel/channel-actor.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 并发重叠检测器: 同时**进**过几次 —— 串行性的硬指标 (max 必须 = 1) */
function overlapTracker() {
  let inFlight = 0;
  let max = 0;
  return {
    enter() { inFlight += 1; if (inFlight > max) max = inFlight; },
    exit() { inFlight -= 1; },
    get max() { return max; },
  };
}

describe('K8 先行门: 内核邮箱的调度性质', () => {
  it('① 同通道严格串行 + FIFO + 全部跑完 (要保住的性质)', async () => {
    const mb = new SerialMailbox();
    const ov = overlapTracker();
    const order: string[] = [];
    const jobs = ['a', 'b', 'c'].map((k, i) =>
      mb.submit(async () => {
        ov.enter();
        order.push(k);
        await sleep(30 - i * 5);      // 故意让后一条更短 ⇒ 若并行, 顺序会乱
        ov.exit();
      }),
    );
    await Promise.all(jobs);
    expect(order).toEqual(['a', 'b', 'c']);   // FIFO
    expect(ov.max).toBe(1);                    // 严格串行 (一次只有一个在跑)
  });

  it('② 邮箱被前序任务占住时, 后投的消息一条都不许丢', async () => {
    const mb = new SerialMailbox();
    const done: string[] = [];
    // 前序任务 = 现网的 didFix 之类 (同一个 getChannelQueue(id))
    const occupier = mb.submit(async () => { await sleep(60); });
    const jobs = ['m1', 'm2', 'm3'].map((m) => mb.submit(async () => { done.push(m); }));
    await Promise.all([occupier, ...jobs]);
    expect(done).toEqual(['m1', 'm2', 'm3']);  // 一条不少, 顺序不变
  });

  it('③ 对照实验: 现网形状 (同步置 running=false + 异步 handoff + 防重入守卫) 会静默丢消息', async () => {
    // ---- 等价复刻 server.ts 现形态 (每行标着对应源码位置; 真回合是**长异步**, 所以 running 在整回合里为真) ----
    const mailbox = new SerialMailbox();
    const done: string[] = [];
    let running = false;
    const queue: string[] = [];

    const drain = (): void => {                         // ≈ finishChannelRun (5746-5758)
      running = false;                                  // 5747 **同步**置位
      if (queue.length > 0) {
        const next = queue.shift()!;                    // 5752 先出队 —— 之后没人再管它
        void mailbox.submit(() => runQueued(next));     // 5754 **异步**投邮箱 (与 didFix 共用)
      }
    };

    const runQueued = async (msg: string): Promise<void> => {   // ≈ runMessageFromQueue (5650+)
      if (running) return;                                      // 5657 防重入守卫 ⇒ return 之后**这条消息谁都不再拥有**
      running = true;
      done.push(msg);
      await sleep(50);
      drain();
    };

    const runInline = async (msg: string): Promise<void> => {   // ≈ /message 主路径的 try 块 + finally
      done.push(msg);
      await sleep(200);                                         // 真回合耗时 (LLM)
      drain();                                                  // finally 里 finishChannelRun
    };

    const onMessage = (msg: string): void => {                  // ≈ /message (4839-4853)
      if (running) { queue.push(msg); return; }                 // 4839-4851 已在跑 ⇒ 入队
      running = true;                                           // 4853
      void runInline(msg);
    };

    // 邮箱先被"didFix"占住 300ms —— 现网真会发生 (5790 同一个 getChannelQueue(id))
    const occupier = mailbox.submit(async () => { await sleep(300); });

    onMessage('m1');                       // t=0    内联起跑 (跑到 ~200ms)
    onMessage('m2');                       // t≈0    running=true ⇒ 入队
    await sleep(210);                      // t≈210  m1 已跑完: drain 同步置 running=false, 并把 m2 投进邮箱
                                           //        —— 但邮箱里 occupier 要到 300ms 才让位 ⇒ m2 排着
    onMessage('m3');                       // t≈210  新消息到: 见 running === false ⇒ **内联起跑** (跑到 ~410ms)
    await occupier;                        // t≈300  occupier 让位 ⇒ m2 的邮箱任务这时才被跑到
    await sleep(260);                      // t≈560  等 m3 跑完 + 一切静止

    // ---- 断言: 这就是正刀要消灭的东西 ----
    expect(done, 'm2 在守卫处被静默丢弃 (它已从 queue 出队, 没有任何人再拥有它)').toEqual(['m1', 'm3']);
    expect(running).toBe(false);
  });
});
