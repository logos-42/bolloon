/**
 * goal-flywheel P6 · ① 阻塞处置**真执行** (block-executor) — 2026-09-26
 *
 * 归属: `docs/wiki/goal-flywheel-p5-acceptance.md` §2 缺口 4 的收口 (「处置动作大多只记账, 不落地」)。
 * 被验对象: `src/agents/goal-flywheel/block-executor.ts` (纯逻辑, 副作用全走注入端口)。
 *
 * 判定口径: 每一条都问同一个问题 —— 「动作**真的**被调了吗? 带的是**正确的对象与参数**吗?」
 * 因此断言不只看动作名, 还看**端口的调用记录** (`calls[]` 逐项: 端口名 + 请求对象字段)。
 *
 * 阴性对照 (怎么知道这些门不是空转; 每条都在文件里有对应用例):
 *   - `takeover` 的"执行权在手上"用例 (5) 与"执行权不在手上"用例 (6) 是同一份阻塞记录、只换
 *     `authority.leaseHeld` → 一个 `executed` 一个 `refused` 且 `claimLease` **零调用**;
 *   - 用例 (4) 把 `tool_blocked` 记录的 `suggestedAction` 篡改成 `takeover` (外部 JSON 造得出)
 *     → 必须被硬拒 (不自动绕过 Harness);
 *   - 用例 (8) 同时钉住两侧: 端口全空 → 必须报人; `blocks: []` → 必须**不**报人 (不虚报);
 *   - 用例 (2) 的"端口回 replaced=false"分支是 (2) 正例的对照 (换人没做成必须交人, 不许粉饰)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  BLOCK_RESOLUTION_ACTIONS,
  type AgentWorkContract,
  type BlockRecord,
  type BlockResolutionAction,
  type WorkBudget,
} from '../agents/goal-flywheel/types.js';
import { detectBlocks, planBlockHandling } from '../agents/goal-flywheel/work-monitor.js';
import { issueWorkContract } from '../agents/goal-flywheel/work-contract.js';
import {
  NO_AUTO_BYPASS_KINDS,
  coveredActions,
  executeBlockHandling,
  mayExecuteAction,
  summarizeBlockExecution,
  type BlockExecutionAuthority,
  type BlockExecutionPorts,
} from '../agents/goal-flywheel/block-executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// 隔离 HOME (只有"真接线输入"那一条用例需要落盘)
// ─────────────────────────────────────────────────────────────────────────────

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `p6-exec-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// 假执行器 (记录每一次调用: 端口名 + 请求对象) —— 这就是"真被调了吗"的事实来源
// ─────────────────────────────────────────────────────────────────────────────

interface Call { port: string; req: any }

function recorder(overrides: Partial<BlockExecutionPorts> = {}): { calls: Call[]; ports: BlockExecutionPorts } {
  const calls: Call[] = [];
  const ports: BlockExecutionPorts = {
    claimLease: (r) => { calls.push({ port: 'claimLease', req: r }); return true; },
    replaceChild: (r) => { calls.push({ port: 'replaceChild', req: r }); return { replaced: true, newWorkId: 'work-new' }; },
    sendAdjustment: (r) => { calls.push({ port: 'sendAdjustment', req: r }); return true; },
    requestReport: (r) => { calls.push({ port: 'requestReport', req: r }); return true; },
    changePlan: (r) => { calls.push({ port: 'changePlan', req: r }); return true; },
    escalate: (r) => { calls.push({ port: 'escalate', req: r }); return true; },
    record: (r) => { calls.push({ port: 'record', req: r }); },
    ...overrides,
  };
  return { calls, ports };
}

const budget = (maxDurationMs: number | null): WorkBudget => ({ maxSteps: 5, maxDurationMs, maxAmount: null, currency: null });

const T0 = Date.parse('2026-09-26T00:00:00.000Z');
function iso(ms: number): string { return new Date(ms).toISOString(); }

/** 真合同 (纯函数签发, 不落盘) */
function contractAt(opts: { maxDurationMs?: number | null; deadlineOffsetMs?: number | null } = {}): AgentWorkContract {
  return issueWorkContract({
    goalId: 'goal-exec-1', parentRunId: 'run-parent-1', childAgentId: 'child-1',
    capability: 'slow_cap', objective: '慢活', inputs: { a: 1 }, allowedTools: [],
    budget: budget(opts.maxDurationMs === undefined ? 3_600_000 : opts.maxDurationMs),
    deadline: opts.deadlineOffsetMs == null ? null : iso(T0 + opts.deadlineOffsetMs),
    successCriteria: ['有结论'], now: iso(T0), issuedBy: 'p6',
  });
}

const SUP: BlockExecutionAuthority = { leaseHeld: true, caller: 'supervisor', leaseOwner: null };

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-① 阻塞处置真执行: 每个动作真被调 (带正确的对象与参数)', () => {
  it('(1) 无进展第一档 → send_adjustment 真下发, 指令原文含该阻塞的事实', async () => {
    const c = contractAt({ maxDurationMs: 1_800_000 });
    expect(c.heartbeatIntervalMs).toBe(30_000);                      // 无进展窗口 = 180s
    const now = iso(T0 + 200_000);
    const [block] = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: iso(T0 + 199_000),
      lastProgressAt: iso(T0), now, leaseOwner: null, runnerAvailable: true,
    });
    expect(block.kind).toBe('no_progress');
    expect(planBlockHandling(block)).toBe('send_adjustment');

    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: c.goalId, blocks: [block], now, authority: SUP, ports });

    expect(out.executed.length).toBe(1);
    expect(out.executed[0].action).toBe('send_adjustment');
    expect(out.executed[0].called).toEqual(['sendAdjustment']);
    expect(out.refused).toEqual([]); expect(out.failed).toEqual([]); expect(out.deferred).toEqual([]);
    expect(out.needsHuman).toEqual([]);
    expect(out.silentRisk).toBe(false);
    // 端口真被调了, 且参数是**这份合同/这条阻塞**的
    const sends = calls.filter((x) => x.port === 'sendAdjustment');
    expect(sends.length).toBe(1);
    expect(sends[0].req.goalId).toBe(c.goalId);
    expect(sends[0].req.workId).toBe(c.workId);
    expect(sends[0].req.childAgentId).toBe('child-1');
    expect(sends[0].req.blockId).toBe(block.blockId);
    expect(sends[0].req.kind).toBe('no_progress');
    expect(sends[0].req.now).toBe(now);
    expect(String(sends[0].req.directive)).toContain(block.note);
    expect(String(sends[0].req.directive)).toMatch(/第一档|不是立刻换人/);
    // 记事实端口也被调到 (动作落地可核验)
    expect(calls.some((x) => x.port === 'record' && x.req.action === 'send_adjustment')).toBe(true);
  });

  it('(2) 无进展第二档 → replace_child 真换人; 端口回的 newWorkId 如实回显 (对照: replaced=false → 交人)', async () => {
    const c = contractAt({ maxDurationMs: 1_800_000 });
    const now = iso(T0 + 400_000);   // > 2×180s 窗口
    const [block] = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: iso(T0 + 399_000),
      lastProgressAt: iso(T0), now, leaseOwner: null, runnerAvailable: true,
    });
    expect(block.kind).toBe('no_progress');
    expect(planBlockHandling(block)).toBe('replace_child');

    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: c.goalId, blocks: [block], now, authority: SUP, ports });
    expect(out.executed.length).toBe(1);
    expect(out.executed[0].detail).toContain('work-new');
    const rp = calls.filter((x) => x.port === 'replaceChild');
    expect(rp.length).toBe(1);
    expect(rp[0].req.workId).toBe(c.workId);
    expect(rp[0].req.childAgentId).toBe('child-1');
    expect(rp[0].req.kind).toBe('no_progress');
    expect(rp[0].req.reason).toBe(block.note);

    // 对照: 换人没做成 (端口如实回 false) → 必须交人, 不许粉饰成"已换人"
    const bad = recorder({ replaceChild: () => ({ replaced: false }) });
    const out2 = await executeBlockHandling({ goalId: c.goalId, blocks: [block], now, authority: SUP, ports: bad.ports });
    expect(out2.executed).toEqual([]);
    expect(out2.refused.length).toBe(1);
    expect(out2.needsHuman.length).toBe(1);
    expect(out2.needsHuman[0].reason).toMatch(/换人没做成/);
  });

  it('(3) 报告缺失: 宽限内 → request_report 真催报; 超宽限 → escalate(to=human) 真上报', async () => {
    const c = contractAt({ maxDurationMs: 3_600_000, deadlineOffsetMs: 600_000 });
    const dl = Date.parse(String(c.deadline));

    // ① 宽限内 (grace = 30s×2 = 60s)
    const nowA = iso(dl + 30_000);
    const within = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: iso(T0), lastProgressAt: iso(T0),
      now: nowA, leaseOwner: null, runnerAvailable: true,
    }).find((b) => b.kind === 'report_missing')!;
    expect(planBlockHandling(within)).toBe('request_report');
    const a = recorder();
    const outA = await executeBlockHandling({ goalId: c.goalId, blocks: [within], now: nowA, authority: SUP, ports: a.ports });
    expect(outA.executed.length).toBe(1);
    const rr = a.calls.filter((x) => x.port === 'requestReport');
    expect(rr.length).toBe(1);
    expect(rr[0].req.workId).toBe(c.workId);
    expect(String(rr[0].req.what)).toContain(`report:${c.reportSchema}`);
    expect(String(rr[0].req.what)).toMatch(/不接受为完成/);

    // ② 超宽限 → 转人工
    const nowB = iso(dl + 60_000 * 3);
    const late = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: iso(T0), lastProgressAt: iso(T0),
      now: nowB, leaseOwner: null, runnerAvailable: true,
    }).find((b) => b.kind === 'report_missing')!;
    expect(planBlockHandling(late)).toBe('needs_human');
    const b = recorder();
    const outB = await executeBlockHandling({ goalId: c.goalId, blocks: [late], now: nowB, authority: SUP, ports: b.ports });
    const esc = b.calls.filter((x) => x.port === 'escalate');
    expect(esc.length).toBe(1);
    expect(esc[0].req.to).toBe('human');
    expect(esc[0].req.detail).toBe(late.note);
    expect(outB.needsHuman.some((h) => h.blockId === late.blockId && /需要人决定|超期/.test(h.reason))).toBe(true);
  });

  it('(4) tool_blocked → change_plan 真改计划; 篡改成 takeover 也必须硬拒 (不自动绕过 Harness)', async () => {
    // 子自报工具被阻 → 父侧规则表给 change_plan (never takeover/replace_child)
    const c = contractAt();
    const now = iso(T0 + 60_000);
    const toolBlocks = detectBlocks({
      contract: c,
      report: {
        workId: c.workId, childAgentId: c.childAgentId, status: 'blocked',
        summary: '工具被拒', evidence: c.requiredEvidence.map((r) => ({ kind: r, ref: r, note: null })), artifacts: [], checks: [],
        unresolvedItems: [], blockReason: {
          blockId: `blk:${c.workId}:tool_blocked`, kind: 'tool_blocked', goalId: c.goalId, runId: c.parentRunId,
          workId: c.workId, childAgentId: c.childAgentId, blockedAt: now, lastProgressAt: now, owner: 'user',
          dependency: 'tool:shell_exec', suggestedAction: 'needs_human', escalationAt: null,
          resolvedAt: null, resolution: null, note: 'shell_exec 被权限围栏拒绝',
        } as any,
        nextRecommendation: '换工具', durationMs: 1000, reportedAt: now,
      },
      lastHeartbeatAt: now, lastProgressAt: now, now, leaseOwner: null, runnerAvailable: true,
    });
    const block = toolBlocks.find((b) => b.kind === 'tool_blocked')!;
    expect(toolBlocks.length).toBe(1);
    expect(block.kind).toBe('tool_blocked');
    expect(planBlockHandling(block)).toBe('change_plan');

    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: c.goalId, blocks: [block], now, authority: SUP, ports });
    expect(out.executed.length).toBe(1);
    const cp = calls.filter((x) => x.port === 'changePlan');
    expect(cp.length).toBe(1);
    expect(cp[0].req.workId).toBe(c.workId);
    expect(cp[0].req.why).toBe(block.note);

    // 篡改: 磁盘上的 JSON 可以把 suggestedAction 写成 takeover —— 纵深防御必须挡住
    const tampered: BlockRecord = { ...block, suggestedAction: 'takeover' as BlockResolutionAction };
    expect(planBlockHandling(tampered)).toBe('takeover');            // 上游确实会给出 takeover
    expect(mayExecuteAction('takeover', tampered.kind, SUP).allowed).toBe(false);
    const t = recorder();
    const out2 = await executeBlockHandling({ goalId: c.goalId, blocks: [tampered], now, authority: SUP, ports: t.ports });
    expect(t.calls.filter((x) => x.port !== 'record').length).toBe(0);   // 一个执行器都没调
    expect(out2.refused.length).toBe(1);
    expect(out2.refused[0].detail).toMatch(/不自动绕过 Harness/);
    expect(out2.needsHuman.length).toBe(1);
  });

  it('(5) 心跳停 + 执行权空闲 + 合同允许 takeover → 真抢到执行权才接管 (参数是这份工作)', async () => {
    const base = contractAt();
    const c: AgentWorkContract = { ...base, failurePolicy: { ...base.failurePolicy, onHeartbeatMiss: 'takeover' } };
    const now = iso(T0 + 300_000);
    const [block] = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: null, lastProgressAt: iso(T0),
      now, leaseOwner: null, runnerAvailable: true,
    });
    expect(block.kind).toBe('no_heartbeat');
    expect(planBlockHandling(block)).toBe('takeover');

    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: c.goalId, blocks: [block], now, authority: SUP, ports });
    expect(out.executed.length).toBe(1);
    const cl = calls.filter((x) => x.port === 'claimLease');
    expect(cl.length).toBe(1);
    expect(cl[0].req.goalId).toBe(c.goalId);
    expect(cl[0].req.workId).toBe(c.workId);
    expect(cl[0].req.blockId).toBe(block.blockId);
    expect(cl[0].req.kind).toBe('no_heartbeat');
    expect(out.needsHuman).toEqual([]);

    // 对照: 有执行权但**抢不到** (别的 worker 拿走了) → 不接管, 交人
    const lose = recorder({ claimLease: () => false });
    const out2 = await executeBlockHandling({ goalId: c.goalId, blocks: [block], now, authority: SUP, ports: lose.ports });
    expect(out2.executed).toEqual([]);
    expect(out2.needsHuman.length).toBe(1);
    expect(out2.needsHuman[0].reason).toMatch(/没成功/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-① 越权不得执行 (执行权/身份/红线三类)', () => {
  it('(6) 执行权不在手上 → takeover 被拒, 端口**零调用** (同一份阻塞记录的对照)', async () => {
    const base = contractAt();
    const c: AgentWorkContract = { ...base, failurePolicy: { ...base.failurePolicy, onHeartbeatMiss: 'takeover' } };
    const now = iso(T0 + 300_000);
    const [block] = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: null, lastProgressAt: iso(T0),
      now, leaseOwner: null, runnerAvailable: true,
    });
    expect(planBlockHandling(block)).toBe('takeover');               // 计划动作确实是 takeover

    const { calls, ports } = recorder();
    const out = await executeBlockHandling({
      goalId: c.goalId, blocks: [block], now,
      authority: { leaseHeld: false, caller: 'supervisor', leaseOwner: 'other-worker' },
      ports,
    });
    expect(calls.length).toBe(0);                                     // 真的一次都没调
    expect(out.refused.length).toBe(1);
    expect(out.refused[0].called).toEqual([]);
    expect(out.refused[0].detail).toMatch(/执行权不在手上/);
    expect(out.executed).toEqual([]);
    expect(out.needsHuman.length).toBe(1);
    expect(out.silentRisk).toBe(false);
  });

  it('(7) 子 Agent 身份调用 → 一切父侧动作拒 (零调用, 逐条交人)', async () => {
    const c = contractAt({ maxDurationMs: 1_800_000 });
    const now = iso(T0 + 400_000);
    const np = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: iso(T0 + 399_000), lastProgressAt: iso(T0),
      now, leaseOwner: null, runnerAvailable: true,
    }).filter((b) => b.kind === 'no_progress');
    expect(np.length).toBe(1);
    expect(planBlockHandling(np[0])).toBe('replace_child');

    const child: BlockExecutionAuthority = { leaseHeld: true, caller: 'child', leaseOwner: 'child-agent' };
    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: c.goalId, blocks: np, now, authority: child, ports });
    expect(calls.length).toBe(0);
    expect(out.refused.length).toBe(1);
    expect(out.refused[0].detail).toMatch(/子 Agent 不得执行/);
    expect(out.needsHuman.length).toBe(1);
  });

  it('(8) 红线表: Harness 类阻塞在任何身份下都不给 takeover / replace_child', () => {
    for (const kind of NO_AUTO_BYPASS_KINDS) {
      for (const action of ['takeover', 'replace_child'] as BlockResolutionAction[]) {
        const v = mayExecuteAction(action, kind, { leaseHeld: true, caller: 'user' });
        expect(v.allowed).toBe(false);
        expect(String(v.reason)).toMatch(/不自动绕过 Harness/);
      }
      // 同类型的合法处置不受伤 (门不是无差别拒绝)
      expect(mayExecuteAction('change_plan', kind, SUP).allowed).toBe(true);
      expect(mayExecuteAction('needs_human', kind, SUP).allowed).toBe(true);
      expect(mayExecuteAction('wait_dependency', kind, SUP).allowed).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-① 无动作可做 → 必须显式报 needs_human, 不许静默', () => {
  it('(9) 端口全空 → 每条都 refused + 逐条给交人理由 (且不含假"已执行")', async () => {
    const c = contractAt({ maxDurationMs: 1_800_000 });
    const now = iso(T0 + 400_000);
    const blocks = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: null, lastProgressAt: iso(T0),
      now, leaseOwner: null, runnerAvailable: true,
    });
    expect(blocks.length).toBeGreaterThanOrEqual(2);                  // 心跳停 + 无进展 至少两条

    const out = await executeBlockHandling({ goalId: c.goalId, blocks, now, authority: SUP, ports: {} });
    expect(out.executed).toEqual([]);
    expect(out.refused.length).toBe(blocks.length);
    expect(out.needsHuman.length).toBe(blocks.length);
    for (const h of out.needsHuman) expect(h.reason).toMatch(/端口|执行器/);
    expect(out.needsHuman.map((h) => h.blockId).sort()).toEqual(blocks.map((b) => b.blockId).sort());
    expect(out.silentRisk).toBe(false);
    expect(summarizeBlockExecution(out)).toContain(`需人 ${blocks.length}`);
  });

  it('(10) 输入不合法 (blocks=null) → 显式报人 + silentRisk; 而无阻塞 ([]) 必须**不**报人 (不虚报)', async () => {
    const bad = await executeBlockHandling({
      goalId: 'g', blocks: null, now: iso(T0), authority: SUP, ports: {},
    });
    expect(bad.silentRisk).toBe(true);
    expect(bad.needsHuman.length).toBe(1);
    expect(bad.needsHuman[0].blockId).toBe('(input)');
    expect(bad.needsHuman[0].reason).toMatch(/不是数组|不许当成"没有阻塞"/);

    const clean = await executeBlockHandling({ goalId: 'g', blocks: [], now: iso(T0), authority: SUP, ports: {} });
    expect(clean.silentRisk).toBe(false);
    expect(clean.needsHuman).toEqual([]);
    expect(clean.attempts).toEqual([]);
  });

  it('(11) 已经在等依赖 → deferred (不是 failed, 也不是"需要人"); 端口抛错 → failed + 原因原文', async () => {
    const c = contractAt();
    const now = iso(T0 + 60_000);
    const waitBlocks = detectBlocks({
      contract: c,
      report: {
        workId: c.workId, childAgentId: c.childAgentId, status: 'blocked',
        summary: '等对端', evidence: c.requiredEvidence.map((r) => ({ kind: r, ref: r, note: null })), artifacts: [], checks: [],
        unresolvedItems: [], blockReason: {
          blockId: `blk:${c.workId}:waiting_dependency`, kind: 'waiting_dependency', goalId: c.goalId,
          runId: c.parentRunId, workId: c.workId, childAgentId: c.childAgentId, blockedAt: now, lastProgressAt: now,
          owner: 'external', dependency: 'p2p:peer-x', suggestedAction: 'wait_dependency',
          escalationAt: null, resolvedAt: null, resolution: null, note: '等 peer-x 的回执',
        } as any,
        nextRecommendation: '等', durationMs: 1000, reportedAt: now,
      },
      lastHeartbeatAt: now, lastProgressAt: now, now, leaseOwner: null, runnerAvailable: true,
    });
    const waitBlock = waitBlocks.find((b) => b.kind === 'waiting_dependency')!;
    expect(waitBlocks.length).toBe(1);                 // 报告完整 + 心跳正常 → 只有子自报这一条
    expect(planBlockHandling(waitBlock)).toBe('wait_dependency');
    const w = recorder();
    const outW = await executeBlockHandling({ goalId: c.goalId, blocks: [waitBlock], now, authority: SUP, ports: w.ports });
    expect(outW.deferred.length).toBe(1);
    expect(outW.failed).toEqual([]);
    expect(outW.needsHuman).toEqual([]);            // 合法的"继续等"不该被报成人
    expect(outW.silentRisk).toBe(false);
    expect(w.calls.filter((x) => x.port !== 'record').length).toBe(0);   // 等 = 无副作用

    // 端口抛错 → failed + 错误原文 + 交人 (不吞)
    const boom = recorder({ escalate: () => { throw new Error('SMTP 550 relay denied'); } });
    const now2 = iso(T0 + 120_000);          // > 心跳窗口 30s×2 且 < 无进展窗口 180s → 只有"心跳停"一条
    const hbBlocks = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: null, lastProgressAt: iso(T0),
      now: now2, leaseOwner: null, runnerAvailable: true,
    });
    expect(hbBlocks.length).toBe(1);
    const hb = hbBlocks[0];
    expect(planBlockHandling(hb)).toBe('escalate_parent');
    const outF = await executeBlockHandling({ goalId: c.goalId, blocks: [hb], now: now2, authority: SUP, ports: boom.ports });
    expect(outF.failed.length).toBe(1);
    expect(outF.failed[0].detail).toContain('SMTP 550 relay denied');
    expect(outF.needsHuman.some((h) => /SMTP 550/.test(h.reason))).toBe(true);
  });

  it('(12) 幂等: 同一 blockId 喂两次 → 只执行一次; 动作集覆盖门不许漏', async () => {
    const c = contractAt({ maxDurationMs: 1_800_000 });
    const now = iso(T0 + 200_000);
    const [block] = detectBlocks({
      contract: c, report: null, lastHeartbeatAt: iso(T0 + 199_000), lastProgressAt: iso(T0),
      now, leaseOwner: null, runnerAvailable: true,
    });
    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: c.goalId, blocks: [block, block], now, authority: SUP, ports });
    expect(out.executed.length).toBe(1);
    expect(calls.filter((x) => x.port === 'sendAdjustment').length).toBe(1);
    // 已解决的阻塞不再处置 (记录既是事实也是结论)
    const resolved: BlockRecord = { ...block, resolvedAt: now, resolution: 'send_adjustment' };
    const r = recorder();
    const out2 = await executeBlockHandling({ goalId: c.goalId, blocks: [resolved], now, authority: SUP, ports: r.ports });
    expect(out2.attempts).toEqual([]);
    expect(r.calls.filter((x) => x.port !== 'record').length).toBe(0);

    // 覆盖门: types.ts 的动作集必须被执行器全覆盖 (加了动作而执行器没跟上 → 红)
    expect([...coveredActions()].sort()).toEqual([...BLOCK_RESOLUTION_ACTIONS].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-① 真接线输入 (真 Goal + 真合同落盘 → collectWorkBlocks 的真 BlockRecord)', () => {
  it('(13) 用真 `dispatchChildWork` + `collectWorkBlocks` 的产物驱动执行器: 参数是盘上那份工作', async () => {
    const gs = await import('../agents/goal-store.js');
    const wiring = await import('../agents/goal-flywheel-wiring.js');
    const home = path.join(TMP, 'real-input');
    await fs.mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const g = await gs.createGoal({ objective: '等一个慢子 Agent', successCriteria: ['子回报'], createdBy: 'p6' });
    const c = await wiring.dispatchChildWork({
      goalId: g.goalId, parentRunId: 'run-parent-real', childAgentId: 'child-real', capability: 'slow_cap',
      objective: '慢活', budget: budget(600_000), successCriteria: ['有结论'], now: iso(T0), issuedBy: 'p6', home,
    });
    // 真合同策略 = stall → 计划动作应是 escalate_parent (接管不可达, 如实)
    expect(c.failurePolicy.onHeartbeatMiss).toBe('stall');
    const now = iso(T0 + 10 * 60_000);
    const blocks = await wiring.collectWorkBlocks({ goalId: g.goalId, now, runnerAvailable: true, home });
    expect(blocks.length).toBeGreaterThan(0);
    const hb = blocks.find((b) => b.kind === 'no_heartbeat')!;
    expect(planBlockHandling(hb)).toBe('escalate_parent');

    const { calls, ports } = recorder();
    const out = await executeBlockHandling({ goalId: g.goalId, blocks, now, authority: SUP, ports });
    expect(out.executed.length).toBe(blocks.length);                  // 每条都有落地动作
    expect(out.needsHuman).toEqual([]);                                // escalate_parent 不是"需要人", 不虚报
    expect(out.failed).toEqual([]); expect(out.refused).toEqual([]);
    // 每条阻塞各调了**一个**执行器 (没有一条被静默吞掉), 且参数是盘上那份工作
    expect(calls.filter((x) => x.port !== 'record').length).toBe(blocks.length);
    for (const a of out.executed) expect(a.called.length).toBe(1);
    const esc = calls.filter((x) => x.port === 'escalate');
    expect(esc.length).toBeGreaterThanOrEqual(1);
    expect(esc.every((x) => x.req.workId === c.workId && x.req.to === 'parent')).toBe(true);
    expect(esc[0].req.goalId).toBe(g.goalId);
    // 真合同文件确实在盘上 (证明参数来自真落盘, 不是测试里捏的)
    const contractFile = wiring.contractPathFor(g.goalId, c.workId, home);
    expect(JSON.parse(await fs.readFile(contractFile, 'utf8')).workId).toBe(c.workId);
  });
});
