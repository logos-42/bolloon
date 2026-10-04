/**
 * K7 端到端取证 —— **回合末尾 TS 自检真的过同一扇 Harness 门** (不是"接线完成、形状对"就收工)
 *
 * 为什么要这个文件: 台账 `K7_BYPASS_CANDIDATES` 里 `tscTool.execute` 一直是 `open` ——
 * 接线已完成、机械断言也有, 但"**在真回合里它到底走没走门**"没有运行时证据。
 * 机械断言只能证明**源码形状**, 证明不了运行时真的调了门。这个文件补的就是那半条。
 *
 * 取证方法 (不造假判定, 沿用仓里既有的"端口注入"手法):
 *   ① 起真 `createAgentSession` —— 与产品同一条构造路径 (真工具表 / 真 `PiAgentHarness` 实例)
 *   ② 在该 session 的**真门实例**上包一层 `beforeToolCall`: 只**记账**被问到的工具名, 判定仍**委托原实现**
 *   ③ 跑**真 LLM 回合**, 让模型用 `edit_file` 改一个 `.ts` 文件 ⇒ 触发"本回合改过 TS"的收尾自检
 *   ④ 断言: 门被问过 `tsc_check` (收尾自检**过门**) · `tsc_check` 真被执行过 (允许路落到执行)
 *   ⑤ 拒绝路: 包的那层只对 `tsc_check` 回 `{allow:false, reason:'K7-E2E-DENY'}` (**判定注入**),
 *      断言 ① 拒绝文案进了对话流 (拒绝不静默) ② `tsc_check` **零执行** (fail-closed)
 *
 * 如实说明边界: ⑤ 里"拒绝"这个判定是**测试注入**的, 不是产品策略自己判出来的 ——
 * 产品侧在这里的证据是"**它确实先问了门、且被拒后不执行**", 也就是**接线**这一半。
 * 无 LLM key / 离线 / CI ⇒ 整文件 skip (与 `pi-sdk.test.ts` 同口径)。
 */
import { config } from 'dotenv';
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createAgentSession, resetAgentSession } from '../agents/pi-sdk.js';
import { initMinimax } from '../llm/pi-ai.js';

config();

const SKIP = !process.env.BOLLOON_PI_SDK_E2E && (
  process.env.CI === 'true' ||
  process.env.BOLLOON_OFFLINE === '1' ||
  (!process.env.DEEPSEEK_API_KEY?.trim() && !process.env.MINIMAX_API_KEY?.trim())
);

// 位置约束: 模型的写工具受**白名单**约束, 只有 src/test/ 这类目录可写 (实测 src/tmp/ 被拒)。
const PROBE_REL = 'src/test/tmp/k7-tsc-e2e.ts';
const PROBE_ABS = path.join(process.cwd(), PROBE_REL);

function writeProbe(value: number): void {
  fs.mkdirSync(path.dirname(PROBE_ABS), { recursive: true });
  fs.writeFileSync(PROBE_ABS, `export const k7Probe: number = ${value};\n`);
}

/** 包住 session 的**真门实例**上的 `beforeToolCall`: 记账 + 可选按工具名注入拒绝 */
function spyGate(session: any, denyTools: string[] = []): string[] {
  const seen: string[] = [];
  const harness = session.piHarness();           // 私有方法, 但实例是**懒建并缓存**的 ⇒ 包住即覆盖产品路径
  const orig = harness.beforeToolCall.bind(harness);
  harness.beforeToolCall = async (req: any) => {
    const tool = String(req?.tool ?? '');
    seen.push(tool);
    if (denyTools.includes(tool)) {
      return { allow: false, reason: 'K7-E2E-DENY', rejectedBy: 'k7-e2e-test' };
    }
    return orig(req);                            // 判定仍走真实现 (不替代门的判断力)
  };
  return seen;
}

/** 包住 `tsc_check` 的执行点: 数它**真被执行了几次** */
function spyTscExec(session: any): { count: () => number; found: boolean } {
  let count = 0;
  const tools = session.tools as Map<string, any>;
  const t = tools?.get?.('tsc_check');
  if (t?.execute) {
    const orig = t.execute.bind(t);
    t.execute = async (args: any) => { count += 1; return orig(args); };
  }
  return { count: () => count, found: Boolean(t?.execute) };
}

const statusText = (events: any[]): string =>
  events.filter((e) => e?.type === 'status').map((e) => String(e?.content ?? '')).join('\n');

const EDIT_PROMPT = (from: number, to: number) =>
  `用 edit_file 工具把 ${PROBE_REL} 里的 k7Probe 的值从 ${from} 改成 ${to}。只用 edit_file, 不要跑测试, 不要做别的`;

afterAll(() => {
  try { fs.rmSync(PROBE_ABS, { force: true }); } catch { /* 清不掉不影响结论 */ }
});

(SKIP ? describe.skip : describe)('K7 端到端: 回合收尾 TS 自检过门', () => {
  // 装配照**产品面**来 (不是测试专用捷径): Web 面每次重载就是 `resetAgentSession(); initMinimax();`
  //   踩过的两个坑:
  //     · 少了 init ⇒ session 走"未初始化模型"的兜底路 (回显、不调工具), 门一次都不会被问;
  //     · 少了 reset ⇒ `createAgentSession` 复用上一条用例的**同一个 session** (带着上一轮的对话与
  //       "这个文件我已经改过了"的记忆) ⇒ 第二条用例的模型直接回"需求已完整满足"、不调工具 ⇒ 前提假红。
  beforeEach(() => {
    resetAgentSession();
    initMinimax();
  });

  it('允许路: 门被问过 tsc_check, 且它真的执行了', { timeout: 240000 }, async () => {
    writeProbe(1);
    const session: any = await createAgentSession({ cwd: process.cwd() });
    const seen = spyGate(session);
    const tsc = spyTscExec(session);
    expect(tsc.found, 'tsc_check 必须在工具表里 (否则这个门在测空气)').toBe(true);

    const events: any[] = [];
    const reply = await session.prompt(EDIT_PROMPT(1, 2), { onStream: (e: any) => events.push(e) });

    // ① 真回合确实改了 TS —— 否则收尾自检本来就不该触发 (前提证据)
    const diag = `回复: ${String(reply).slice(0, 300)} || 门被问到: [${seen.join(',')}] || 工具数: ${(session.tools as Map<string, any>)?.size ?? '?'} || 状态: ${statusText(events).slice(0, 300)}`;
    expect(fs.readFileSync(PROBE_ABS, 'utf-8'), diag).toContain('= 2');
    // ② **收尾自检过门**: 门被问过 tsc_check
    expect(seen, '收尾自检必须先问门 (beforeToolCall) 再执行').toContain('tsc_check');
    // ③ 允许路真的落到执行 (问而不执行 = 门坏了另一种形态)
    expect(tsc.count(), '允许 ⇒ 恰执行一次').toBe(1);
    // ④ 结论对用户可见
    expect(statusText(events)).toMatch(/类型检查/);
  });

  it('生产形状 (usePivotLoop 的流式路径): 收尾自检同样要过门 —— 这正是原先漏掉的一半', { timeout: 300000 }, async () => {
    // 为什么单列一条: 上面两条用的是**默认配置**(老 `runReActLoop`), 而**生产里 web 走的是 pivot 路径**
    //   (`usePivotLoop: true` + `promptStream`), 那条分支原先"提前 return", 收尾自检**一次都没跑过** ——
    //   也就是说 K7 早先那条"系统自检过门"的证据**没有覆盖生产形状**。这条用例把那个缺口钉住。
    const session: any = await createAgentSession({ cwd: process.cwd(), usePivotLoop: true });
    const seen = spyGate(session);
    const tsc = spyTscExec(session);
    const events: any[] = [];
    // 直接注入"本回合改过 TS" ⇒ 判据落在**接线** (pivot 路径是否真走到自检), 不依赖模型是否去编辑文件
    session.tsTouchedThisTurn = ['src/test/tmp/k7-tsc-e2e.ts'];
    session.typecheckRanThisTurn = false;

    await session.promptStream('只回两个字: 好的', (e: any) => events.push(e));

    expect(seen, 'pivot 流式路径必须先问门 (beforeToolCall) 再执行自检').toContain('tsc_check');
    expect(tsc.count(), '允许 ⇒ 恰执行一次').toBe(1);
    expect(statusText(events), '类型检查结论要对用户可见').toMatch(/类型检查/);
  });

  it('拒绝路: 门拒绝 ⇒ 零执行 + 可见报出 (fail-closed)', { timeout: 240000 }, async () => {
    writeProbe(1);
    const session: any = await createAgentSession({ cwd: process.cwd() });
    const seen = spyGate(session, ['tsc_check']);   // 判定注入: 只拒 tsc_check
    const tsc = spyTscExec(session);

    const events: any[] = [];
    const reply2 = await session.prompt(EDIT_PROMPT(1, 2), { onStream: (e: any) => events.push(e) });

    // 前提: 回合本身成功 (文件改了) ⇒ 拒绝的是**收尾自检**, 不是整个回合
    const diag2 = `回复: ${String(reply2).slice(0, 300)} || 门被问到: [${seen.join(',')}] || 状态: ${statusText(events).slice(0, 300)}`;
    expect(fs.readFileSync(PROBE_ABS, 'utf-8'), diag2).toContain('= 2');
    expect(seen).toContain('tsc_check');
    // ① 被拒 ⇒ **零执行** (不是"拒了还跑")
    expect(tsc.count(), '被门拒绝 ⇒ 一次都不许执行').toBe(0);
    // ② 拒绝**不许静默** —— 文案进对话流, 且带上门的理由
    const txt = statusText(events);
    expect(txt).toMatch(/类型检查被门拒绝/);
    expect(txt).toContain('K7-E2E-DENY');
  });
});
