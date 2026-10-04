/**
 * Pi-SDK - Agent Session for Document Processing
 * Part of OpenClaw dual-layer architecture
 *
 * 模块拆分 (2026-07-06):
 *   - types        → ./pi-sdk-types.ts            (interface / type)
 *   - session mgr  → ./pi-sdk-session-manager.ts  (PiSessionManager 类)
 *   - tools        → ./pi-sdk-tools.ts            (registerBuiltinTools / Wallet / IdempotencyCache)
 *   - factory      → ./pi-sdk-session-factory.ts  (createAgentSession / getAgentSession / resetAgentSession / runSelfImproveLoop)
 *   - 本文件                                       (PiAgentSession 类: LLM 循环 / 系统提示 / 工具调用分发 / 压缩 / persistence)
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type RunContext, createRunContext } from './run-context.js';
import { createPrivateActor, type ChannelActor, type ExecutionRequest } from '../kernel/channel-actor.js';
import { expandHomeArgs } from './tool-path-args.js';
import { renderDelegateNotices, pushNotice, renderNoticeBlock } from './background-notices.js';
import { runWithWriteOrigin } from './skill-ledger.js';
import { createHash } from 'node:crypto';
import { shouldReview, shouldReviewTask, runExperienceReview } from './experience-review.js';
import { decideLessonSink, skillsFromDirs, logLessonSuggestions, routeLessonToSkill } from './lesson-to-skill.js';
import { managedServices } from './managed-services.js';
import { IterationBudget, isRefundableTool } from './iteration-budget.js';
import { recordToolCall, argsFingerprint } from './tool-telemetry.js';
import { capToolResult } from './tool-result-gate.js';
import { renderToolListWithParams } from './tool-subset.js';
import { codeWriteTarget, decideTypecheck, formatTypecheckResult } from './code-write-gate.js';
// 2026-10-01: 身份解析必须**静态导入** —— 之前在函数体里用 require(), 而打包后是 ESM ⇒
//   require 是 undefined ⇒ 抛错被 catch 静默吞掉 ⇒ "自愈"根本没跑, DID 一直是空的 ✗。
import { loadOrCreateAgentIdentity } from './agent-identity.js';
import { agentPersonaName } from './channel-identity.js';
import { getContextManager } from '../bootstrap/context-manager.js';
import { createRequire } from 'module';
import { currentPackageRoot } from '../utils/version-info.js';
// 2026-08-07: ESM 下裸 require 抛错被 catch 吞掉 → estimateHistoryTokens/maxContextTokens 静默失效
//   (状态栏恒 0 的第二层根因). 统一用 createRequire 加载 CJS 模块.
// 2026-09-19: 原为 createRequire(import.meta.url) —— electron 构建(CommonJS)下 TS1343。
//   createRequire 只用来解析裸模块名, 给包内任意文件路径即可, 用包根 package.json 最稳。
const _piRequire = createRequire(path.join(currentPackageRoot(), 'package.json'));
import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../constraints/index.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer, WorkflowContext } from './constraint-layer.js';
import { WorkflowEngine, WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
import { DeepThinkingEngine, AgentCoordinator, type ThinkResult, type AgentResult } from '@bolloon/constraint-runtime';
import { WorkflowPivotLoop, createDefaultPivotConfig, type PivotLoopConfig, type LoopResult } from './workflow-pivot-loop.js';
import { p2pDocumentTools, initDocumentReceiver } from './p2p-document-tools.js';
import { shellExec } from './shell-tool.js';
import { startRun, recordStep, finishRun, readRun, budgetVerdict, recordDegradation, recordHarnessEvent, recordRecovery, setRunStatus, prepareResume, markRunRunning, buildResumeInstruction, argsDigestOf, repeatedFailureCount, classifyError as classifyRunError, type RunSurface, type RunStatus, type ResumePlan } from './run-store.js';
import { createGoal, attachRun, findActiveGoal } from './goal-store.js';
import { captureRunModelConfig, type RunModelConfig, type ConfigDriftReport, type EffectiveModelConfig } from '../llm/model-selection.js';
// 2026-09-26: 工具名出网净化 (pi-ai.ts 唯一边界) + 回程派发还原 (原名 ↔ API 名)
import { resolveApiToolName, expandKnownToolNames } from '../llm/tool-name.js';
// 2026-09-28 (前缀 KV 可命中): CURRENT TURN 注入标记 —— "当前轮是否已注入"的唯一判据
import { CURRENT_TURN_MARKER } from '../llm/pi-ai.js';
import { PiAgentHarness, type HarnessRunContext, type ToolDecision } from './pi-harness.js';
import { getBranchPrefix, getCooldownMs, checkWritePath } from './shell-guard.js';
import {
  DiscoveredAgentsManager,
  SocialHeartbeat,
  createSocialHeartbeat,
  getSocialHeartbeat,
  type PersonaDoc,
  type DiscoveredAgent,
  type SessionChannel,
  type SessionMessage,
  type SocialSessionProvider
} from '../social/heartbeat.js';
import {
  GlobalSharedContextManager,
  createGlobalSharedContext,
  getGlobalSharedContext,
  type ActionSummary,
  type AgentInfo,
  type CooperationTask,
  type CooperationType,
  type GlobalSharedContext
} from '../social/global-shared-context.js';
import { Session, SkillRegistry, saveSession, loadSession, type Skill, type StoredSession } from '@bolloon/constraint-runtime';
import { loadSkillsFromPaths, defaultSkillPaths, describeSkill } from './skill-loader.js';

/** 2026-08-10: unreported 逃生门判定 — LLM 反复不把工具结果写进回复时, 超过上限强制收尾 (防死循环) */
export function decideUnreported(unreported: number, retries: number, max: number): 'retry' | 'force-final' | 'none' {
  if (unreported <= 0) return 'none';
  return retries < max ? 'retry' : 'force-final';
}

// 拆分后的子模块 — 重新导出保 backward compat
export {
  type AgentSessionConfig,
  type IdentityDoc,
  type ImprovementRequest,
  type PiSessionState,
  type PiMemory,
  type Tool,
  type ToolResult,
  type Message,
  type StreamCallback,
  type StreamEvent,
  type HeartbeatConfig,
  type AgentSession,
  TOOL_DEFINITIONS,
} from './pi-sdk-types.js';
import type { AgentSessionConfig, IdentityDoc, ImprovementRequest, PiSessionState, PiMemory, Tool, ToolResult, Message, StreamCallback, StreamEvent, HeartbeatConfig, AgentSession } from './pi-sdk-types.js';

export { PiSessionManager } from './pi-sdk-session-manager.js';
import { PiSessionManager } from './pi-sdk-session-manager.js';
import {
  registerBuiltinTools,
  registerWalletTools,
  setupInboxListener,
  IdempotencyCache,
  type ToolRegistryContext,
} from './pi-sdk-tools.js';
import { registerContactTools } from './contacts/tools.js';
import { ContactChain } from './contacts/chain.js';

export {
  createAgentSession,
  getAgentSession,
  resetAgentSession,
  runSelfImproveLoop,
} from './pi-sdk-session-factory.js';
// 给本文件 registerTools() 内部用
import { runSelfImproveLoop } from './pi-sdk-session-factory.js';

// Judgment 注入门 (P0): 在主对话 LLM 调起前自动拼入 Top 3 判断力
// 失败静默, 不阻塞主对话
import { injectJudgmentGate, injectNegativeGuard, recordJudgmentUsage } from '../pi-ecosystem-judgment/injection-gate.js';
import { getInjectionMaxChars } from '../bootstrap/exhaust-scrubber.js';
// 持续监控门 (P3): AI 回复后审计是否违反原则
import { monitorAfterReply } from '../pi-ecosystem-judgment/monitor-gate.js';
// Bootstrap 生命周期 hook (SessionStart / Stop / PreToolUse)
import { onSessionStart, onStop, onPreToolUse } from '../pi-ecosystem-judgment/human-value-pipeline.js';
import { onPostToolUse, onJudgmentInjected, onMonitorViolation } from '../bootstrap/lifecycle-hooks.js';
import { budgetReduce, snip, microcompact } from '../context-compaction/index.js';
// React Harness: 8-gate + 4-guard (防越权 / 防 prompt 注入)
import { ReactHarness } from '../security/react-harness.js';
import { HooksEngine } from '../hooks/hooks-engine.js';
import { DenyPipeline, type DenyContext } from './deny-pipeline.js';
import { parseToolCall as parseToolCallImpl, parseAllToolCalls, isFinalResponse as isFinalResponseImpl, extractFinalAnswer as extractFinalAnswerImpl, type ToolCall } from './parse-tool-call.js';
import { buildObservation, buildReflection, formatObservationWithReflection, classifyError } from './error-classifier.js';
import { sessionStore as defaultSessionStore, type SessionStore, type PersistedMessage } from './session-store.js';
import { ToolRegistry } from './tool-registry.js';
import { decideMaxIterations, decideContextOverflow, shouldCompactBeforeIteration } from './react-loop.js';
import { DEFAULT_MAX_REVIEWS } from './loop-review.js';

// PiSessionManager 已抽到 ./pi-sdk-session-manager.ts (2026-07-06)
// Tool / ToolResult / Message / StreamCallback / StreamEvent / HeartbeatConfig / AgentSession / TOOL_DEFINITIONS
//   已抽到 ./pi-sdk-types.ts (2026-07-06)

/**
 * 同一工具 + 同一组参数连续失败上限 (2026-07-01 起) —— 触发两条互不替代的动作:
 *   循环内: 注入 system 提示强制 LLM 收尾; 运行层 (M3): 熔断 → needs_human (交人)。
 */
const MAX_SAME_TOOL_FAILURES = 3;

/**
 * 2026-09-28 (前缀 KV 可命中): 把 chat() 回带的「当前轮已注入」内容写回调用方自己的 history.
 *
 * 谁是调用方: ReAct 循环每轮用 `buildMessages()` **重建全新对象** —— 注入只活在那一份里.
 *   不写回的话下一轮那条 user 就退回注入前, 前缀从它起分叉:
 *     第 1 次 `S H [D1 U1]`   第 2 次 `S H U1 U2`   ← U1 丢了 D1
 *   正确形态: `S H [D1 U1] U2` (D1 成了 U1 的一部分, 于是成为后续轮的稳定前缀).
 *
 * 为什么是纯函数 (不塞进类里): 门 `scripts/verify-kv-prefix.ts` 要能**直接驱它**断言,
 *   而不是绕一整条 ReAct 循环才验到"写回"这一下.
 *
 * 匹配判据 (只做加法, 绝不乱改历史):
 *   1. wire 最后一条 content 必须以 CURRENT TURN 标记开头 (没注入过 → 0, 不动);
 *   2. 从 history **末尾往前**找第一条 `content` 是它后缀的条目 ——
 *      去掉后缀剩下的那截必须仍以标记开头 (证明"注入是前部加了一段");
 *   3. 命中就整段写回 (tool 条目拿到的是含 `[工具结果]\n` 前缀 + 注入的整段),
 *      写回后该条 `content` 已等于 wire → 第二次调用前缀为空, 自然返回 0 (幂等).
 *
 * @returns 真写回的条数 (0 = 没注入过 / 匹配不上 / 已经写回过)
 */
export function writeBackCurrentTurnInto(
  history: Array<{ role: string; content?: string }>,
  wire: Array<{ role: string; content?: string }> | undefined
): number {
  try {
    if (!Array.isArray(history) || history.length === 0) return 0;
    if (!Array.isArray(wire) || wire.length === 0) return 0;
    const last = wire[wire.length - 1];
    const wireContent = typeof last?.content === 'string' ? last.content : '';
    if (!wireContent.startsWith(CURRENT_TURN_MARKER)) return 0;   // 没注入过 → 不动
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      const inner = typeof entry?.content === 'string' ? entry.content : '';
      if (!inner) continue;
      if (!wireContent.endsWith(inner)) continue;
      const prefix = wireContent.slice(0, wireContent.length - inner.length);
      if (!prefix || !prefix.startsWith(CURRENT_TURN_MARKER)) continue;
      entry.content = wireContent;
      return 1;
    }
    return 0;
  } catch {
    return 0;   // 写回失败绝不影响对话本身
  }
}

import { LoopStallState, observeToolCall, batchHint } from './tool-loop-guard.js';

/**
 * 写操作"读回自证" (2026-10-01 优化 #4): 写类工具成功后**自动**核一次, 把事实拼进结果。
 * 为什么: 过程纪律写了"读回一次", 但**没人执行** ✗ ⇒ 现在由机制执行: "工具说成功 ≠ 任务成功"。
 * 只做**便宜**的核对(存在性/大小); 失败静默(核对不该把工具搞失败)。
 */
export function verifyWriteOutcome(toolName: string, args: any, cwd: string): string | null {
  try {
    const fsMod = require('node:fs') as typeof import('node:fs');
    const pathMod = require('node:path') as typeof import('node:path');
    const WRITE = new Set(['write_file', 'edit_file', 'mkdir', 'move_file', 'copy_file']);
    if (!WRITE.has(String(toolName))) return null;
    const rel = String(args?.path ?? args?.to ?? args?.dir ?? '').trim();
    if (!rel) return null;
    const abs = pathMod.isAbsolute(rel) ? rel : pathMod.resolve(cwd, rel);
    const st = fsMod.statSync(abs);
    if (st.isDirectory()) return `[已核对] 目录存在: ${rel}`;
    return `[已核对] 文件已落盘: ${rel} (${st.size} 字节, ${new Date(st.mtimeMs).toISOString()})`;
  } catch (e: any) {
    return `[未核对] 读回失败: ${String(e?.message || e).slice(0, 80)} —— 别急着说"已完成", 先确认路径/权限`;
  }
}

/**
 * 过程纪律 (2026-10-01, 用户: 「智能体回复方式没有主动性 … 在过程里面更加主动考虑」)。
 *
 * 诊断: 系统提示里只有"理解→分析→调用→观察"这种**反应式**循环描述 ⇒ 模型容易"问一句答一句、
 *   试一次就收尾、把方案当交付"。主动不是靠一句"请主动"能给的, 要落成**可判定的规矩**。
 * 落地方式 (7 条, 都是"做/不做"能验收的): 先动手别先问 · 做到底别停在半成品 · 一个工具不够就换法继续 ·
 *   工具说成功 ≠ 任务成功(读回验证) · 被阻塞如实说绝不编 · 每轮要么推进要么交付 · 顺手想影响面并给下一步建议。
 */
export const PROACTIVE_WORK_DISCIPLINE = `
过程纪律 (比"答得漂亮"更重要, 逐条可判定):
0. **先动手, 别先问**: 请求有显而易见的默认解释时, 按它做, 不要为了确认而停下 —— 只有"不同解释会让我做不同的事"时才问。
0.5 **别把"主动"用在闲聊上**: 寒暄 / 感受 / 纯闲聊这类**没有任务**的消息 ⇒ 直接回答, **不要**为此调工具
    (用户实测: 一句「你好」去跑了 git_status 花 4.1s ✗ —— 那是浪费)。"主动"= 接到任务后**想在你前面**,
    不是"每句话都先把环境查一遍" ✗。
1. **做到底**: 交付的是**能跑的东西 + 真实的工具输出**, 不是"我打算怎么做"。只写方案、只搭一半、只报告打算做什么, 都算没做完。
2. **一个工具不够就换法继续**: 同一件事试到确实不通为止 —— 换参数/换命令/换路径/换工具接着试, 不要试一次就收尾。
3. **工具说成功 ≠ 任务成功**: 写入/生成/发布这类动作, **读回一次**再声称完成(内容/存在/大小/哈希都可)。
4. **被阻塞就如实说**: 讲清卡在哪一步、为什么、还缺什么; **绝不**用编造的结果顶替(编一个"看起来对"的输出比说"没做成"更糟)。
5. **每一轮要么用工具推进, 要么给出结论**: 不要把"下一步我打算…"当成回答。
6. **收尾时说三句**: 改了什么 · 验过什么(拿什么读到的) · 还剩什么。不重述过程。
7.4 **技能是"要用时先读再照做"**: 库里有一批已装载技能(名字+说明), 用 list_skills <关键词> 找,
    用 read_skill <名字> 读全文 —— **相关时先读它再动手**, 别凭印象做(技能里往往写着踩过的坑与判据 ✓)。
7.5 **一轮里可以同时调多个独立工具** (并行执行已支持): 互不依赖的读取/查询**一次发出去**, 别一个一个来回 —
    零碎调用既慢又费预算(批量工具还会退还额度 ✓)。
7.6 **收尾标记的语义**(别猜, 就按这条): 写完那个结束标记 = "**我已收尾, 且自己验过**(改了什么/拿什么验证的), 请复核"。
    只在这两种情况下写: ① 任务真的做完了(不是"我打算做") · ② 纯对话/问答也**不用**写(直接答即可)。
    没做完就**别写** —— 写了会被当成"已完成"进入复核, 反而浪费一轮 ✓。
7. **过程中主动考虑**: 动手前先想这个改动的**影响面**(同类调用点 · 相邻功能 · 已有数据/契约), 发现关联问题就说出来,
   并给出你建议的下一步 —— 主动是指"想在你前面", 不是"多问几句"。
`;

/**
 * 受门包装的 skill 面 (2026-10-02, leo 口径 (b)): **任何执行路径都经 Harness**。
 * 与裸 `SkillRegistry` 的差别: `execute` / `get().execute` / `list()[].execute` 三条都受门。
 */
export interface GuardedSkillRegistry {
  register(skill: Skill): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  /** 返回的 `Skill` 的 `execute` **也受门** (不是裸 skill) */
  get(name: string): Skill | undefined;
  /** 同上: 列表里每个 `execute` 都受门 */
  list(): Skill[];
  execute(name: string, params: Record<string, unknown>): Promise<string>;
}

export class PiAgentSession implements AgentSession {
  private cwd: string;
  private peerId: string;
  private identity: IdentityDoc;
  private persona: PersonaDoc | null = null;
  private minimaxAvailable = false;
  private workflows: Map<string, Workflow> = new Map();
  private constraintLayer: ConstraintLayer;
  private workflowEngine: WorkflowEngine;
  private sessionManager: PiSessionManager;
  private agentsManager: DiscoveredAgentsManager;
  private socialHeartbeat: SocialHeartbeat | null = null;
  /**
   * **K5 第 4 步 (所有权转移)**: history 的**本体**。
   *   · 未绑定 actor ⇒ 本体在这里 (绑定前的暂存);
   *   · 绑定 actor 后 ⇒ 本体是 `actor.state.messageHistory`, 本地那份被**收养**并清空。
   * 绑定由 `attachActor()` 做, 且**只在会话身份已知时**发生 (见 session factory) —— 没有身份就不归属。
   */

  /**
   * **K5 第 4 步 — history 写入的唯一漏斗 (push)**。
   * 为什么必须同步: 调用点遍布 ReAct 循环 / 工具回灌 / 压缩, 而且**写完立刻读** (length / 索引 / slice),
   * 改成 await 会改变同拍可见性。所以这里有意识地**不排队** —— 归属收敛 + 可数 (门能断言"零处直写"),
   * 并发安全由入口投递进 mailbox 负责 (K5 第 5 步)。
   */
  private pushHistory(...msgs: Message[]): void {
    for (const m of msgs) {
      // 步骤⑧ 起**只有一条路径**: 写 actor (实例侧暂存字段已删除) —— 也彻底消除了"自递归"的可能
      this.actor!.appendMessageSync(m);
    }
  }

  /** **K5 第 4 步 — history 写入漏斗 (pop)** —— 同 pushHistory 的性质 */
  private popHistory(): Message | undefined {
    return this.actor!.popMessageSync<Message>();
  }

  /** **K5 第 4 步 — history 写入漏斗 (整体替换)**: hydrate 回灌 / 压缩后的整块赋值都走这里 */
  /**
   * **整体替换**历史 —— 唯一漏斗之一, 步骤⑧ 起是**唯一**的"种历史"入口 (公开)。
   *   公开的理由: 上层/测试要种一份历史时必须走这里; 直接给对象赋一个新数组会**换掉数组身份**
   *   (actor 里那份仍是空的) —— 那是静默丢数据 (实测: 删掉 setter 后 `session.messageHistory = [...]`
   *   变成写在一个凭空出现的自有属性上, 测试于是看到 0 条)。
   */
  replaceHistory(next: Message[]): void {
    this.actor!.replaceHistory<Message>(next);
  }

  /**
   * **K5 步骤⑦ — 把一次性请求里的绑定落到位** (入口不再散着设字段: 只交一个请求)。
   * 写入都走访问器 ⇒ 本体落进 `actor.state` (步骤③ 起就是这样); 没给的不覆盖 (与环境变量"只覆盖显式给出的"同秩)。
   */
  applyExecutionRequest(req: ExecutionRequest): void {
    if (req.channelId) this.actor!.state.channelId = req.channelId;
    if (req.agentId) this.actor!.state.agentId = req.agentId;
    if (req.goalId) this.actor!.state.goalBinding = req.goalId;
    if (req.resumeRunId) this.resumeRunId = req.resumeRunId;
  }

  /**
   * **K5 步骤⑦ — Pi 的唯一执行入口**: 只接收一次性 `ExecutionRequest`。
   * 有 `onStream` ⇒ 走 `promptStream` (流式); 否则走 `prompt`。绑定由 `applyExecutionRequest` 落位。
   * 入口侧只需: `deliverThroughActor(session, () => session.runExecution(req))`。
   */
  async runExecution(req: ExecutionRequest): Promise<string> {
    this.applyExecutionRequest(req);
    if (req.onStream) {
      return this.promptStream(req.input, req.onStream as StreamCallback, req.signal, req.channelId);
    }
    return this.prompt(req.input, { signal: req.signal, channelId: req.channelId });
  }

  /**
   * **K5 第 4 步**: 绑定 actor 并**收养**绑定前已存在的本地历史。
   * 收养规则: actor 侧为空 且 本地非空 ⇒ 搬过去 (任何绑定时序都不丢历史); 收养后清空本地。
   * 约束 (全量回归打出来的): 调用方必须用**会话身份**当注册键; 没有身份就**不要调**这个方法。
   */
  attachActor(actor: ChannelActor): void {
    const prev = this.actor;
    this.actor = actor;
    if (!prev || prev === actor) return;
    // **收养**: 把上一个 actor (通常是"出生时的私有 actor") 的状态搬进新家。
    //   新家已有值时不覆盖 —— 同一会话身份以先到者为准 (禁止"后到的调用把先建的状态冲掉")。
    const from = prev.state;
    const to = actor.state;
    if (from.messageHistory.length > 0 && (to.messageHistory as unknown[]).length === 0) {
      (to.messageHistory as unknown[]).push(...from.messageHistory);
    }
    if (from.channelId && !to.channelId) to.channelId = from.channelId;
    if (from.agentId && !to.agentId) to.agentId = from.agentId;
    if (from.goalBinding && !to.goalBinding) to.goalBinding = from.goalBinding;
    if (from.activeRun && !to.activeRun) to.activeRun = from.activeRun;
  }
  private tools: Map<string, Tool> = new Map();
  /** 2026-06-30: tool registry 模块 — 独立 alias resolve, 测试可消融. */
  private _toolRegistry: ToolRegistry = new ToolRegistry();
  private skillRegistry: SkillRegistry = new SkillRegistry();
  /** M2.4: 缓存 tool 列表, registerTools() 之后不变, runReActLoop 多次循环复用 */
  private cachedToolDefinitions: string = '';
  /** M2.4: 缓存 persona section */

  /**
   * 当前活跃计划 (待办) 的**重注入段** (2026-10-01 落实④)。
   * 每轮都带 —— 因为上下文压缩会把早先注入的计划文本丢掉, 一次性注入等于"压完就忘"。
   * 有界 (条数/字符都封顶); 读不到就返回空串, 绝不影响主流程。
   */
  private async renderActivePlansSection(): Promise<string> {
    // 2026-10-01: 后台委派的结果**自动回灌** —— 完成后的第一轮在这里给一行提示(只提一次)
    let bg = '';
    try { bg = renderDelegateNotices(); } catch { /* 提示失败不打断主流程 */ }
    try {
      const block = renderNoticeBlock();   // 通用回流(复盘产出/后台任务) —— 空闲排空 ⇒ 新一轮 ✓
      if (block) bg = bg ? `${bg}\n${block}` : block;
    } catch { /* 回流失败不打断 */ }
    let plans = '';
    try {
      const { listActivePlans, formatPlansForPrompt } = await import('./plan-store.js');
      const list = await listActivePlans();
      plans = formatPlansForPrompt(list, { maxChars: 1200, maxItems: 3 });
    } catch { return bg; }
    return bg ? `${bg}\n${plans}` : plans;
  }

  private cachedPersonaSection: string = '';
  /** 本轮迭代预算 (每轮重置; 批处理工具会退还 —— 见 iteration-budget.ts) */
  /** 上一个工具调用的参数指纹 (遥测判"是否重复调用") */

  private lastToolSig: string | null = null;
  /** 最近一条用户消息 (按需子集档用来判 intent) */
  private lastUserIntent = '';
  /** 本回合改过的 TS 文件 (回合收尾自动类型检查用) */
  private tsTouchedThisTurn: string[] = [];
  /** 本回合是否已跑过类型检查 (一轮只跑一次) */
  private typecheckRanThisTurn = false;

  private iterBudget: any = null;
  private iterBudgetWarned: boolean = false;
  /** 上一次已复盘的**任务签名** (签名变了 ⇒ 立刻复盘, 对应"每次任务都总结" ✓) */
  private lastReviewedTaskSig: string | undefined = undefined;
  /** 上一次回合后自审的时间 (节流; 0 = 从未) */
  private lastExperienceReviewAt: number = 0;
  /** 2026-06-30: 持久化层 — 默认走 ~/.bolloon/sessions/cache/, 测试可注入临时目录. */
  private _sessionStore: SessionStore;
  /** 构造期间 fire-and-forget 任务的 promise — whenReady() 等它 */
  private _readyPromise: Promise<void> | null = null;
  // 2026-06-16 修: 父要求把 ReAct loop 上限放大到 "几乎无限", 靠自动压缩上下文 + fail-safe 兜底
  // 默认 10000 — 正常任务永远跑不到, 但作为防 LLM 死循环 / 防 OOM 的最后一道闸
  // 旧默认 100 写死导致中等复杂度任务 (10-50 个 tool call + 多步反思) 会被误杀
  private readonly MAX_REACT_ITERATIONS = 10_000;
  private readonly MAX_REFINE_ATTEMPTS = 3;
  private readonly QUALITY_THRESHOLD = 0.6;
  /** P1: 上下文溢出阈值 (单轮估算 token 数, 超过则强制终止防止 prompt-too-long)
   *  2026-08-06: 从 ContextManager 动态读 (默认 1M, env MAX_CONTEXT_TOKENS 可调).
   *  保留字段仅作降级兜底 (ContextManager 初始化失败时用 60K 老行为). */
  private readonly MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD = 60_000;  // fallback 60K tokens

  /** 2026-08-06: 上下文窗口 (tokens) — 统一走 ContextManager 配置 (1M 默认). */
  private maxContextTokens(): number {
    try {
      const { getContextManager } = _piRequire('../bootstrap/context-manager.js');
      const n = getContextManager().getConfig().maxTokens;
      return Number.isFinite(n) && n > 0 ? n : this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD;
    } catch {
      return this.MAX_OUTPUT_TOKEN_ESCALATION_THRESHOLD;
    }
  }
  /** 2026-06-16 新增: 累计错误总数兜底 (不管是否同工具, 累计 N 次就强制退出)
   *  防 LLM 轮换工具名绕开 MAX_SAME_TOOL_FAILURES 的死循环攻击 */
  private readonly MAX_TOTAL_ERRORS = 20;
  /** 2026-06-19: 记录 loop 内成功执行的工具结果, 失败退出时汇总给用户 */
  private successfulToolResults: { tool: string; outputPreview: string }[] = [];
  /** 2026-06-19: Agent Mesh 通信 — 本地 + 远端 inbox 缓存, 给 check_inbox 工具读 */
  private _inboxMessages: { id: string; from: string; fromDid?: string; type: string; payload: string; timestamp: number; source: 'p2p' | 'local' }[] = [];
  /** 2026-06-16 新增: loop 内自动压缩触发阈值 (相对 60K 阈值的比例) */
  private readonly LOOP_COMPACT_RATIO = 0.8;
  /** P1: max output token 升级重试 (LLM 截断时重试, 最多 3 次) */
  private readonly MAX_OUTPUT_TOKEN_ESCALATION_RETRIES = 3;
  private thinkingEngine = new DeepThinkingEngine(3);
  private coordinator = new AgentCoordinator(3);
  private harness: any = null;
  private harnessEnabled = false;
  /** 8-gate + 4-guard 集中调度 (防越权 / 防 prompt 注入) */
  private reactHarness: ReactHarness = new ReactHarness();
  private usePivotLoop: boolean = true;   // K4-B (2026-10-02): 默认切到 pivot —— 所有入口只跑**一套** loop (老 ReAct loop 待删)
  private pivotLoopConfig?: PivotLoopConfig;
  /** P2: 当前会话的 permission mode (每次 promptStream 入口解析) */
  private currentPermissionMode: import('./permission-mode.js').PermissionMode = 'default';
  /** P1.2: Context Collapse 读时投影结果 (feature flag 开启时由 maybeAutoCompact 写入, buildContext 优先用) */
  private projectedHistory: Message[] | null = null;

  /**
   * 2026-07-29 (Tool pre-filter): 拒绝工具列表 — 这些工具从模型视野完全删除
   * 模型"看不到"这些工具 (name/description/params 不在 system prompt 列出,
   * 也不出现在 native API tools 参数中).
   * 在 registerTools() 之后立即应用, 也可运行时通过 denyTool/allowTool 动态调整.
   * 首次 getToolDefinitions() 调用时会缓存带过滤的结果.
   */
  private _deniedToolNames: Set<string> = new Set();

  /** 2026-07-29: Hook 引擎 */
  private _hooks: HooksEngine = new HooksEngine();

  /** 2026-07-29: Unified Deny-First Pipeline */
  private _denyPipeline: DenyPipeline = new DenyPipeline();

  /** 2026-07-29: Snip + Context Collapse 启用标志 (默认启用) */
  private _enableSnipCollapse: boolean = true;

  /** 注册一个或多个工具到拒绝列表 */
  denyTool(...names: string[]): void {
    for (const name of names) this._deniedToolNames.add(name);
    // 拒绝列表变了, 清除缓存让下次 getToolDefinitions 重新生成
    this.cachedToolDefinitions = '';
  }

  /** 从拒绝列表移除一个或多个工具 */
  allowTool(...names: string[]): void {
    for (const name of names) this._deniedToolNames.delete(name);
    this.cachedToolDefinitions = '';
  }

  /** 获取当前拒绝列表 (快照) */
  getDeniedTools(): string[] {
    return Array.from(this._deniedToolNames);
  }

  /** 返回已过滤（剔除拒绝工具）的工具迭代器 */
  private allowedTools(): IterableIterator<Tool> {
    const self = this;
    return (function* () {
      for (const [name, tool] of self.tools) {
        if (!self._deniedToolNames.has(name)) yield tool;
      }
    })();
  }

  /** 2026-08-08: 公开可用工具列表 (name + description + 参数名) 供 /tools 显示 */
  getToolList(): Array<{ name: string; description: string; parameters: string[] }> {
    const out: Array<{ name: string; description: string; parameters: string[] }> = [];
    for (const tool of this.allowedTools()) {
      const paramNames = tool.parameters ? Object.keys(tool.parameters) : [];
      out.push({ name: tool.name, description: tool.description || '', parameters: paramNames });
    }
    return out;
  }

  /**
   * Judgment 注入门临时结果: 在 prompt / promptStream / promptWithPivotLoop 入口算一次, 拼到本轮 systemPrompt 末尾
   * 每次调用都会重置 (避免上一轮遗留)
   */
  private judgmentGateAddition: string = '';
  private judgmentGateUsedIds: string[] = [];
  /** 2026-07-22 设计 B: 负向判断力 (避免清单) 注入用到的 judgment id */
  private judgmentGateNegativeUsedIds: string[] = [];
  // 2026-06-18: 来自 web server markedPrompt 外的 contextHint (channel/judgment/distill/remote channels),
  //   拼到 systemPrompt 末尾, 别再混进 user message
  private contextHintAddition: string = '';

  /**
   * **K2 收尾 (leo 2026-10-02 口径)**: **唯一一处**把"已有的恢复身份"播种进 RunContext。
   *
   *   · `currentRunId` 属 **run-boundary**, 不是循环内部的可变 RunContext 状态 ⇒ 只允许这一次显式播种读取;
   *   · 冻结 `CURRENT_RUN_ID_SEED_READS = 1` (见 src/kernel/plan-runcontext.ts), 由门强制;
   *   · 只发生在**进入一次 Run 时**; 不得在循环中新增读取点; 不得成为新的写入口;
   *   · K5 Channel Actor 完成后改为 `createRunContext({ runId: request.resumeRunId })`, 届时删除 `currentRunId` 字段本体。
   */
  private seedRunContext(extra: Partial<RunContext> = {}): RunContext {
    return createRunContext({ runId: this.actor!.state.activeRun, ...extra });
  }

  /**
   * **K5 迁移中**: 本会话所属 channel 的 Actor (由 session factory 在创建时绑定)。
   * 现在只做**归属** —— 会话状态 (messageHistory / channelId / agentId / goalId) **仍然**在实例字段上,
   * 逐项迁入 Actor 见 `src/kernel/plan-channel-actor.ts` 的 8 步。
   */
  actor?: ChannelActor;

  /**
   * **K2 迁移中**: 一次 Run 的显式状态载体 (见 src/agents/run-context.ts)。
   * 入口 (prompt / promptStream / promptWithPivotLoop) 用 createRunContext() 快照一次, 用完即清。
   * **已外置**: `eventSink` (原 currentOnStream) · `abortSignal` (原 currentSignal)。
   * 其余 6 个字段仍以本类实例字段为准, 逐格迁移。
   */
  private runCtx: RunContext = createRunContext();
  /** Bootstrap SessionStart 拼的 system prompt 片段 (用完即清) */
  private bootstrapAddition: string = '';
  /** 2026-08-12 (Task3 认知卸载): 工具选择与认知卸载指南 — 注入 system prompt, 降低"模型不触发 write/edit/read"率. */
  private static readonly TOOL_SELECTION_GUIDE = `【工具选择与认知卸载指南 (严格遵循)】
- 写/改文件: 必须用 write_file / edit_file (不要用 terminal 拼字符串写文件).
- 读文件: 用 read_file / read_directory / list_files.
- 跑命令/查状态/装依赖/跑脚本: 用 terminal.
- 执行 git 操作: 用 git_* 专用工具 (git_diff/git_commit/git_push/git_branch/git_log).
- 查看/调用技能: 用 list_skills / use_skill.
- 认知卸载: 当任务对你过大或反复失败时, 不要死磕 — 用 delegate_to_engine 把编码/复杂任务委派给外部引擎 (codex/claude-code/opencode), 或把目标拆小分步完成.
- 每步只选一个最合适的工具, 先读后写, 写完验证 (跑 tsc/vitest 或读回文件).`;
  /** 当前 prompt 开始时间 (供 Stop hook 计算 durationMs) */
  private promptStartTime: number = 0;
  /**
   * **K5 步骤③ (会话绑定迁入 Actor)**: 三处绑定 (channelId / agentId / goalBinding) 的本体住进
   * `actor.state`, 实例上只留**绑定前的暂存** (`_channelId` 等), 由 `attachActor()` 收养后清空。
   * 用访问器而不是改调用点: 写入点 (prompt 入口 / Goal 绑定 / snapshot) 分散且语义各异, 逐个改风险大;
   * 访问器让所有读写自动落到 actor (同一个值对象), 调用点零改动。
   * 注意: 这三个字段的**访问数不变** (台账按 "self.currentX" 形态计数) —— 迁的是**所有权**, 不是删访问。
   *   本注释刻意不写出那种带 `this.` 前缀的字面形态: 计数口径只剥 `//` 行注释, 块注释里的同形串会被算进去
   *   (曾因此把 currentChannelId 的计数虚增 1, 被门照出)。
   */
  // **K5 步骤⑧ 批次4**: channelId 的访问器已删 —— 本体 `actor.state.channelId`, 直接影响本体。
  // M2.2 intent 已外置到 runCtx.intent (K2); 拼 systemPrompt 时读 this.runCtx.intent
  /** 2026-08-10: 本轮用户原始输入 (loop-review 任务动词兜底检测用) */
  private currentUserInput: string = '';
  /**
   * 2026-09-16: 持久化 run harness — 本次运行的落盘记录 id + 表面 (cli/web/cron/delegate)。
   * 之前只有"跑完才写"的轨迹 (trajectory-store, fire-and-forget, 崩了就没有), 没有跨重载可见的
   * 运行事实, 也没有预算闸门/失速巡检; 这里补的就是那一层。
   */
  /**
   * **K5 步骤⑥ (Run 身份归属 Actor)**: 本体是 `actor.state.activeRun`。
   *   · 未绑定 actor ⇒ 住在这里 (`_runId`, 绑定前的暂存);
   *   · 绑定后 ⇒ 读写全落 actor (同一个值), 由 `attachActor()` 收养绑定前的值。
   * 语义: "本会话当前活跃的 Run" —— 一个会话身份同时只有一个活跃 Run ✓ 与 Actor 的粒度一致。
   * 注意: 访问数**不变** —— 迁的是**所有权**不是删访问 (与步骤③同理)。
   *   本注释刻意不写出"带 self. 前缀 + 该字段名"的那种字面形态: K2 的计数只剥 `//` 行注释,
   *   块注释里的同形串会被算进去 (同类踩过三次, 每次都被门照出)。
   */
  // **K5 步骤⑧ 批次5 (收尾)**: currentRunId 访问器已删 —— Run 身份的本体是 `actor.state.activeRun`, 直接读写本体。
  /** 上一次运行的 runId (收尾不清空; 见 getLastRunId) */
  private lastRunId: string = '';
  private runSurface: RunSurface = 'cli';
  /**
   * 2026-09-16 (Milestone 1): 本次运行因**持久化失败**被硬停。
   * 标记出来是为了让外层 loop 重试逻辑别重试 —— 盘写不进去, 重试 3 次也只是再失败 3 次
   * (协议: 同一个错误不许无限重复; 该交人时交人)。
   */
  private runPersistenceBlocked = false;

  /** 由 server / CLI / cron 注入运行表面 (影响落盘记录里的 surface 字段) */
  setRunSurface(surface: RunSurface): void {
    this.runSurface = surface;
  }
  private currentIntentHint: string = '';

  /**
   * 算 judgment 注入门: 失败静默, 不阻塞主对话
   * 期间通过 runCtx.eventSink 广播 phase 事件, 前端可显示 "正在检索判断力..." 状态
   * 调用方负责用完即清 (judgmentGateAddition='')
   */
  private async computeJudgmentGate(input: string): Promise<void> {
    const safePhase = (phase: string, extra: Record<string, unknown> = {}) => {
      try {
        if (this.runCtx.eventSink) {
          this.runCtx.eventSink({ type: 'phase', phase, ...extra, content: '' } as any);
        }
      } catch { /* 静默 */ }
    };

    safePhase('gate_compute', { detail: '正在检索相关判断力...' });
    try {
      // P-Action 4 (2026-06-15) 路径 1 整合: 透传 maxChars=1500 (≈ 375 tokens 硬上限)
      // 路径 2/3 检测由 injection-gate 内部 alreadyInjectedSources 处理 (目前 assembleSystemPrompt 还没注入 value-store 标记, 所以这里不传)
      // 2026-07-22 设计 C: maxChars 读背压动态值 (涡轮增压进气调参)
      //   上下文紧张 (high) → 收紧 800; 宽裕 (idle/low) → 放宽 1800; 默认 medium 1500
      const gate = await injectJudgmentGate(input, {}, { maxChars: getInjectionMaxChars() });
      this.judgmentGateAddition = gate.systemAddition;
      this.judgmentGateUsedIds = gate.usedIds;

      // 2026-07-22 设计 B: 负向判断力回收 — "避免清单"注入 (显式, 进 prompt)
      //   判断力负向是"判断力"非"废气", 可进 prompt 作为约束 (精准 = 正向指引 + 负向避免)
      try {
        const neg = await injectNegativeGuard(input, {}, { maxChars: 300 });
        if (neg.didInject && neg.systemAddition) {
          this.judgmentGateAddition += '\n' + neg.systemAddition;
          this.judgmentGateNegativeUsedIds = neg.usedIds;
        }
      } catch (negErr) {
        console.warn('[PiAgent] negative guard failed (non-fatal):', negErr);
      }

      if (this.judgmentGateUsedIds.length > 0 || this.judgmentGateNegativeUsedIds.length > 0) {
        safePhase('gate_done', { usedCount: this.judgmentGateUsedIds.length, negativeCount: this.judgmentGateNegativeUsedIds.length, didInject: gate.didInject, skipReason: gate.skipReason });
      }
    } catch (err) {
      console.warn('[PiAgent] judgment gate failed (non-fatal):', err);
      this.judgmentGateAddition = '';
      this.judgmentGateUsedIds = [];
    }
  }

  private clearJudgmentGate(): void {
    this.judgmentGateAddition = '';
    this.judgmentGateUsedIds = [];
    this.judgmentGateNegativeUsedIds = [];
  }

  constructor(config: AgentSessionConfig) {
    // **K5 步骤⑧**: actor 从出生就在 —— 工厂通常在**构造前**就把身份 actor 注进来 (`config.actor`);
    //   没有身份时用一份**私有 actor** (不注册 ⇒ 谁也拿不到, 隔离性优先)。
    //   ⇒ 实例侧不再需要"绑定前暂存"字段 (那些字段本步删除)。
    this.actor = config.actor ?? createPrivateActor();
    this.cwd = config.cwd;
    this.peerId = config.peerId || 'local';
    this.identity = config.identityDoc || this.createDefaultIdentity();
    this.minimaxAvailable = this.checkMinimax();
    // 2026-07-04: 透传 agentId (server.ts 通过 createAgentSession 选项注入)
    this.actor!.state.agentId = config.agentId || '';
    // 2026-10-01 **身份自愈** (用户实测: get_identity 返回 "DID: " 空 + 各 channel 名字串台):
    //   工具上下文里的身份来自 this.identity, 而它可能是 config.identityDoc 与 session 实例身份的
    //   合并结果 —— **空 did 会盖掉真 did** ✗; 名字也可能缺失或被别处覆盖。
    //   规矩: 缺 did / 名字时, 按 **currentAgentId** 从真身份生成器补齐 (did:key + 落盘密钥),
    //   名字优先取该 agent 自己的 persona.json。绝不回落到全局/用户身份名。
    try {
      if (this.actor!.state.agentId) {
        const cur: any = this.identity || {};
        const curDid = String(cur.did || '');
        const badDid = !curDid || /^did:(local|pi):/i.test(curDid);
        const missingName = !String(cur.name || '').trim();
        // 2026-10-01 加固: **did 与本人密钥不符** 也算坏 —— 用户实测 get_identity 返回一个
        //   数据里根本不存在的 did (按 peerId 当 scope 新造的), 而它非空、非假值 ⇒ 上一版判据漏过 ✗。
        //   规矩: 只要 currentAgentId 有值, 身份的 did 就必须等于该 agent 自己的密钥 did。
        const mine = loadOrCreateAgentIdentity(this.actor!.state.agentId);
        const mismatch = !!mine?.did && !!curDid && curDid !== mine.did;
        if (badDid || missingName || mismatch) {
          if (badDid || mismatch) {
            console.warn(`[identity] 身份纠正: ${this.actor!.state.agentId} 的 did ${curDid ? curDid.slice(0, 26) : '(空)'} ⇒ ${mine.did.slice(0, 26)} (以该 agent 自己的密钥为准)`);
          }
          // 2026-10-01: 同样必须**原地改** —— 这段在 registerTools() **之后**跑, 工具上下文已经按引用
          //   捕获了 this.identity; 换对象 ⇒ 工具看不到纠正结果 ✗ (同类 bug, 一并修)
          Object.assign(this.identity, {
            ...(mine?.did ? { did: mine.did, publicKey: mine.publicKey || cur.publicKey } : {}),
            ...(missingName ? { name: agentPersonaName(this.actor!.state.agentId) || this.actor!.state.agentId } : {}),
          });
        }
      }
    } catch { /* 自愈失败不致命 */ }
    // 2026-06-30: 持久化层可注入 — 测试传 tmpDir, 业务用默认 ~/.bolloon/sessions/cache/
    this._sessionStore = (config as any).sessionStore ?? defaultSessionStore;
    this.constraintLayer = new ConstraintLayer();
    this.workflowEngine = new WorkflowEngine(this.constraintLayer);
    this.sessionManager = new PiSessionManager(this.identity.did, this.cwd, this.actor!.state.agentId);
    this.agentsManager = new DiscoveredAgentsManager();
    this.usePivotLoop = config.usePivotLoop ?? true;   // K4-B: 默认 true (K4-B 之前是 false ⇒ CLI 走老 loop, 与 web 分叉)
    this.pivotLoopConfig = config.pivotLoopConfig;
    this.initSession();
    initDocumentReceiver();
    this.registerTools();
    // 2026-07-29: 从环境变量加载默认拒绝工具列表 (逗号分隔)
    //   BOLLOON_DENIED_TOOLS=shell_exec,git_commit 会在启动时拒绝高危险工具
    try {
      const envDenied = process.env.BOLLOON_DENIED_TOOLS;
      if (envDenied && envDenied.trim()) {
        const names = envDenied.split(',').map(n => n.trim()).filter(Boolean);
        if (names.length > 0) this.denyTool(...names);
      }
    } catch { /* env 读失败静默 */ }

    // 2026-07-29: 从环境变量控制 Snip/Collapse
    try {
      if (process.env.BOLLOON_SNIP_COLLAPSE === '0') this._enableSnipCollapse = false;
    } catch { /* 静默 */ }

    // 2026-07-29: 从 ~/.bolloon/hooks.yaml 加载 hook 配置
    //   失败静默 (无 hook 配置也正常)
    try {
      // fire-and-forget, 不阻塞构造
      this._hooks.loadFromConfig().catch(() => {});
    } catch { /* 静默 */ }

    // 2026-07-29: 初始化 DenyPipeline — 注册所有检查器
    //   顺序: deny-list (最快) → permission → hooks → judgment
    this._denyPipeline.addChecker(
      DenyPipeline.denyListChecker(this._deniedToolNames)
    );
    this._denyPipeline.addChecker(
      DenyPipeline.permissionChecker()
    );
    // 仅当启用了 hook 时注册 hooks 检查器
    //   (hook 可能走到 LLM, 是最贵的, 放在最后)
    this._denyPipeline.addChecker(async (ctx: DenyContext) => {
      try {
        const hookResult = await this._hooks.checkToolUse(ctx.toolName, ctx.toolArgs as Record<string, unknown>);
        if (hookResult?.deny) {
          return {
            denied: true,
            reason: hookResult.reason || 'Hook 拒绝',
            source: 'hooks',
            systemAddition: hookResult.systemAddition,
          };
        }
        if (hookResult?.systemAddition) {
          this.contextHintAddition += '\n' + hookResult.systemAddition;
        }
      } catch { /* hook 失败不阻塞 */ }
      return { denied: false, reason: '', source: 'hooks' };
    });
    this.loadSkills(config.skillsPaths);
    this.initHarness();
    // M2.3 (2026-06-17): 重启后 LLM 恢复记忆 — 从 session JSON 加载历史到 messageHistory
    //   之前 messageHistory 是空的, 服务重启后 LLM 看到的是新对话
    //   现在 loadSessionKey 形如 "channel-xxx:default" 走 ~/.bolloon/sessions/cache/<key>.json
    if (config.loadSessionKey) {
      this._readyPromise = this.hydrateMessageHistory(
        config.loadSessionKey,
        config.loadSessionMaxMessages ?? 30
      ).catch((err) => {
        // 失败静默, 但不让 whenReady 永久 hang
        console.warn(`[PiAgent] hydrateMessageHistory failed: ${(err as Error).message?.slice(0, 100)}`);
      });
    }
  }

  /**
   * 2026-06-30: 让外部 await 构造期间的 hydrate 完成.
   * 解决 fire-and-forget 让 messageHistory 不可预测的问题.
   * 不传 loadSessionKey 时立即返回.
   */
  whenReady(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  /**
   * M2.3 (2026-06-30 重构): 从 SessionStore 加载历史, 转成 messageHistory 格式
   * - 失败静默 (历史加载失败不应该阻塞 agent 启动)
   * - 限制 max 条数, 防止 context 爆
   * - 跳过错误消息 ([AI 服务调用失败] / [错误:...]) 不污染 LLM
   * - 委托 SessionStore 完成 IO, 保证 save/load 路径对称
   *
   * 历史格式兼容旧 schema ({type, content}) 和新 schema (PersistedMessage[])
   */
  private async hydrateMessageHistory(sessionKey: string, maxMessages: number): Promise<void> {
    try {
      // **K5 第 4 步**: 实现体 (load → filter → 截断 → 替换) 已搬进 Actor —— 走邮箱 ⇒ 与 append/persist 串行。
      //   业务侧只交两个**纯回调** (内核因此不必 import 业务模块); 未绑定 actor 的会话走下面原路径 (行为不变)。
      if (this.actor) {
        const n = await this.actor.hydrateHistory<Message>({
          load: () => this._sessionStore.loadMessages(sessionKey),
          filter: (loaded) => this._filterToMessage(loaded as PersistedMessage[]),
          maxMessages,
        });
        if (n > 0) console.log(`[PiAgent] 从 ${sessionKey} 回灌 ${n} 条历史 (经 Channel Actor)`);
        return;
      }
      const loaded = await this._sessionStore.loadMessages(sessionKey);
      if (!loaded) {
        console.log(`[PiAgent] hydrate: 没有 ${sessionKey} 的历史`);
        return;
      }
      const hydrated = this._filterToMessage(loaded).slice(-maxMessages);
      if (hydrated.length > 0) {
        this.replaceHistory(hydrated);
        console.log(`[PiAgent] 从 ${sessionKey} 回灌 ${hydrated.length} 条历史`);
      }
    } catch (err) {
      // 2026-09-30: "会话文件不存在" 不是失败 —— 新 channel / 还没落过盘的会话就是这种情况
      //   (真机噪声: `hydrateMessageHistory 失败 (non-fatal): session not found: ch_bolloon:default`)。
      //   只有**非** not-found 的错误才值得 warn。
      const __msg = String((err as Error)?.message || err);
      if (!/session not found|ENOENT/i.test(__msg)) {
        console.warn(`[PiAgent] hydrateMessageHistory 失败 (non-fatal): ${__msg.slice(0, 100)}`);
      }
    }
  }

  /**
   * 2026-06-30: 把当前 messageHistory 持久化到 SessionStore.
   * 公开方法 — claude code / 外部 harness 在每次 prompt 完成后调一下,
   *   即可获得"重启 / 跨进程接续"的语义.
   */
  async saveCurrentSession(key: string): Promise<void> {
    // **K5 第 4 步**: 取数拍走 Actor 的快照 (走邮箱 ⇒ 与 append 串行, 不会抓到"边写边读"的半截状态);
    //   未绑定 actor 的会话走原路径 (行为不变)。
    const source: Message[] = this.actor ? await this.actor.historySnapshot<Message>() : (this.actor!.state.messageHistory as Message[]);
    const persisted: PersistedMessage[] = source.map((m) => ({
      role: m.role,
      content: m.content,
      toolCall: m.toolCall,
      toolResult: m.toolResult,
      toolCallId: m.toolCallId,
      timestamp: Date.now(),
      source: 'pi-session',
    }));
    await this._sessionStore.saveMessages(key, persisted);
  }

  /**
   * 2026-06-30: 从 disk 拉历史覆盖当前 messageHistory.
   * 返回加载条数 — 失败或空则返回 0.
   * 与 loadSessionKey (构造时读) 不同: 这个是 session 已建好后再读.
   */
  async resumeSession(key: string, maxMessages: number = 30): Promise<number> {
    const before = (this.actor!.state.messageHistory as Message[]).length;
    await this.hydrateMessageHistory(key, maxMessages);
    return (this.actor!.state.messageHistory as Message[]).length - before;
  }

  /**
   * 2026-06-30: 读历史不修改 messageHistory.
   * 给 claude code / 测试做"先看一下历史"用 — 不破坏当前会话.
   * 返回 Message[] 数组 (空数组表示无历史).
   */
  async peekSessionHistory(key: string, maxMessages: number = 30): Promise<Message[]> {
    try {
      const loaded = await this._sessionStore.loadMessages(key);
      if (!loaded) return [];
      return this._filterToMessage(loaded).slice(-maxMessages);
    } catch {
      return [];
    }
  }

  /** hydrateMessageHistory 用的过滤逻辑 — 提到外面复用 */
  private _filterToMessage(loaded: PersistedMessage[]): Message[] {
    const hydrated: Message[] = [];
    const VALID_ROLES = new Set(['user', 'assistant', 'tool', 'system']);
    for (const m of loaded) {
      // role 必须合法 (拒绝旧 schema {type:'user'} 没 role 字段的)
      if (!VALID_ROLES.has(m.role as any)) continue;
      // 跳过污染消息
      if (typeof m.content === 'string' && m.content.startsWith('[AI 服务调用失败]')) continue;
      if (typeof m.content === 'string' && m.content.startsWith('[错误:')) continue;
      // 注意: '!m.content' 会跳过 content='' 的 tool call 消息 (assistant role + toolCall 字段),
      //   这种是合法的 (LLM 输出只有 tool call, 没有正文) — 必须保留.
      //   这里只跳过"无内容 + 也没 tool call/tool result"的废消息.
      if (!m.content && !m.toolCall && !m.toolResult) continue;
      // 跳过空 tool role (tool result 占位但没有任何内容)
      if (m.role === 'tool' && !m.toolResult) continue;
      hydrated.push({
        role: m.role,
        content: m.content ?? '',
        toolCall: m.toolCall,
        toolResult: m.toolResult,
        toolCallId: m.toolCallId,
      });
    }
    return hydrated;
  }

  /** 暴露 store 给测试 / 高级集成用. */
  get sessionStoreInstance(): SessionStore {
    return this._sessionStore;
  }

  /**
   * 从 SKILL.md 目录加载 skills 进 skillRegistry.
   *
   * 路径解析优先级 (后者覆盖前者同名 skill):
   *   1. 显式传入的 skillsPaths
   *   2. ~/.bolloon/skills/         全局用户级
   *   3. <cwd>/.bolloon/skills/     项目级
   *   4. ~/.boll/skills/            全局 (兼容 bollharness 旧用户)
   *
   * 2026-07-04: 移除 18 个 bollharness builtin skill (findBolloonBuiltinSkillsPath).
   *   历史遗留: 写 pi-sdk 时为方便演示, 把 bolloon 项目里的 19 个 skill 强制注入到 system prompt.
   *   问题: system prompt 涨到 22K chars, LLM (minimax M3) 在 pivot loop 里反复 think 不输出
   *          `<final gen>`, session 落盘拿不到最终回答.
   *   现在: 只让用户放 .bolloon/skills/SKILL.md 才生效, 干净且 project-owned.
   *
   * 静默忽略不存在的目录.
   */
  private loadSkills(paths?: string[]): void {
    const resolved = (paths && paths.length > 0) ? paths : defaultSkillPaths(os.homedir(), this.cwd);
    loadSkillsFromPaths(resolved)
      .then((skills) => {
        for (const s of skills) {
          if (this.skillRegistry.has(s.name)) {
            this.skillRegistry.unregister(s.name);
          }
          this.skillRegistry.register(s);
        }
        console.log(`[loadSkills] 已加载 ${skills.length} 个 skill from ${resolved.join(', ')}`);
      })
      .catch((err) => {
        console.error('[loadSkills] 加载失败:', err);
      });
  }

  private async initHarness(): Promise<void> {
    try {
      const { createBollharnessIntegration } = await import('../bollharness-integration/index.js');
      this.harness = createBollharnessIntegration();
      this.harnessEnabled = true;
      // ReactHarness 已用 bollharness, 这里也记一份以供 archive 调用
      this.reactHarness = new ReactHarness({ harnessEnabled: true, gateEnabled: true });
    } catch (e) {
      console.warn('[PiAgentSession] Harness initialization failed:', e);
      this.harnessEnabled = false;
      // 失败 fallback: 走纯 8-gate (不带 bollharness 的 8-gate 工作流)
      this.reactHarness = new ReactHarness({ harnessEnabled: false, gateEnabled: true });
    }
  }

  private registerTools(): void {
    // 2026-07-06: 工具注册抽到 ./pi-sdk-tools.ts, 这里只调 + 镜像到 ToolRegistry
    this._inboxMessages = [];
    const toolCtx: ToolRegistryContext = {
      tools: this.tools,
      // 2026-10-01 (用户: 「process 也要可以管理群聊和去中心化交流进程」):
      //   把**常驻的交流类服务**也挂进 process —— 能启停的给启停(社交心跳 ✓), 只能看的如实标"仅状态" ✓(不假装能停 ✗)
      managedServices: (() => {
        const ms = managedServices;
        ms.register({
          name: 'social-heartbeat',
          description: '社交心跳: 主动发现节点/发起对话/组织群聊的常驻循环(去中心化交流用)',
          status: () => (this.socialHeartbeat ? '运行中' : '已停止'),
          start: () => this.startSocialHeartbeat(),
          stop: () => this.stopSocialHeartbeat(),
        });
        ms.register({
          name: 'p2p-network',
          description: 'P2P 网络: 与其他 bolloon 节点的连接(群聊/消息都走它)',
          status: () => { try { const peers = this.getPeers?.() ?? []; return `已连接 ${peers.length} 个节点`; } catch { return '状态不可用'; } },
        });
        ms.register({
          name: 'orbitdb-groups',
          description: 'OrbitDB 群聊存储: 本地群列表与消息持久化',
          status: () => { try { const g = (this as any).listGroupsShallow?.(); return g ? `本地群 ${g}` : '已就绪(用 /group 看列表)'; } catch { return '状态不可用'; } },
        });
        ms.register({
          name: 'document-receiver',
          description: '文档接收器: 监听并接收其他节点发来的文档分片',
          status: () => '监听中(随进程启动)',
        });
        return ms;
      })(),
      // 2026-10-01: 技能发现(list_skills / read_skill)的实现 —— 技能原先只注册不露面 ✗, 现在模型能自己找
      listSkills: () => this.skillRegistry.list().map((sk: any) => ({ name: sk.name, description: String(sk.description || '') })),
      getSkillBody: async (name: string) => {
        const sk: any = this.skillRegistry.get(name);
        if (!sk) return null;
        try { return await sk.execute({}); } catch { return null; }
      },
      cwd: this.cwd,
      identity: this.identity,
      persona: this.persona,
      minimaxAvailable: this.minimaxAvailable,
      setPersona: async (p) => { await this.setPersona(p); },
      sessionManager: this.sessionManager as any,
      constraintLayer: this.constraintLayer as any,
      _inboxMessages: this._inboxMessages,
      getChannelWallet: async () => {
        try {
          const { CHANNELS_PATH } = await import('../web/server-types.js');
          const { loadChannels } = await import('../web/server-storage.js');
          const channels = await loadChannels();
          const ch = channels.find((c: any) => c.id === this.actor!.state.channelId);
          if (ch && ch.encryptedPrivateKey && ch.encryptedPrivateKeyIv && ch.walletAddress) {
            return {
              encryptedPrivateKey: ch.encryptedPrivateKey,
              encryptedPrivateKeyIv: ch.encryptedPrivateKeyIv,
              walletAddress: ch.walletAddress,
              autoPayEnabled: ch.autoPayEnabled ?? false,
              did: this.identity.did,
            };
          }
          return null;
        } catch {
          return null;
        }
      },
    };
    registerBuiltinTools(toolCtx);
    // 2026-09-19: 联系方式工具 (手机/邮箱) —— Agent 拿不到明文, 只能给 contactId;
    //   所有调用都要过 contacts/policy (首次联系/敏感内容需人工批准, 批量永远禁止)。
    try {
      registerContactTools(toolCtx as any, new ContactChain({ ownerDid: this.identity?.did || 'did:bolln:local' }));
    } catch (err) {
      console.warn('[contacts] 注册联系工具失败 (非致命, 该能力不可用):', (err as any)?.message || err);
    }
    registerWalletTools(toolCtx);
    setupInboxListener(toolCtx);
    // 镜像到 ToolRegistry (alias resolve 用)
    for (const [name, tool] of this.tools.entries()) {
      this._toolRegistry.register(tool);
    }
    // M3.3: 副作用工具走幂等性 cache
    this._idempotencyCache.wrap(this.tools);
  }

  /** 清幂等性缓存 — 强制下次调用真正执行 (用于 agent 显式需要重新跑的场景) */
  clearIdempotencyCache(): void {
    this._idempotencyCache.clear();
  }



  /** M3.3: 工具结果缓存 — 防止 loop 重试时副作用 (写文件 / 改代码) 执行多次 */
  private _idempotencyCache: IdempotencyCache = new IdempotencyCache();

  private async registerP2PDocumentReceiver(): Promise<void> {
    await initDocumentReceiver();
  }

  private getToolDefinitions(): string {
    // M2.4 (2026-06-17): 缓存 tool 定义 — registerTools() 在构造时调一次, 此后不变
    // 2026-07-29: 拒绝列表变化时清空缓存, 重新生成
    if (this.cachedToolDefinitions) return this.cachedToolDefinitions;
    // 2026-07-29: 使用 allowedTools() 过滤掉拒绝列表中的工具
    const allowed = Array.from(this.allowedTools());
    const header = '可用工具 (按类分组; name(params) - 简介):';
    // 2026-06-19: 压缩 tool 定义 — 只显示参数名 (不显示描述, 减少 60% 长度)
    //   完整 description 在 history 第一轮注入 (getToolDefinitionsFull 调用), 后续轮只看简短
    //   避免 system prompt 太大导致 minimax 撞 max_tokens 输出空
    // 2026-10-01 (优化 #2 v2): 按类**分组**列 + 说明"未列出的也能按名字调" ⇒ 治选择过载, 且不丢能力。
    //   BOLLOON_TOOL_SUBSET=on 时改走"按 intent 只展开相关桶"(仍带 list_tools + 能力提示 ✓)。
    const subsetOn = String(process.env.BOLLOON_TOOL_SUBSET || '').toLowerCase() === 'on';
    const intentText = subsetOn ? this.lastUserIntent : '';
    const rendered = renderToolListWithParams(allowed, intentText, { subset: subsetOn, perBucket: 14 });
    this.cachedToolDefinitions = `${header}\n${rendered.text}`;
    return this.cachedToolDefinitions;
  }

  private async initSession(): Promise<void> {
    await this.sessionManager.initialize();
    await this.agentsManager.initialize();

    this.persona = this.sessionManager.getPersona();
    if (this.persona?.name) {
      this.identity.name = this.persona.name;
    }
  }

  private createDefaultIdentity(): IdentityDoc {
    // 2026-10-01: 原先自造 `did:pi:<peerId>` —— **不是有效 DID** (仓里 server.ts 自己都把 did:pi:
    //   当"待升级"占位; 用户实测 get_identity 报 did:pi:ch_1785668060213)。
    //   改用仓里既有的真身份生成器 (agent-identity.loadOrCreateAgentIdentity, 同步, 产 did:key + 落盘密钥)。
    const scope = this.actor!.state.agentId || this.peerId || 'default';
    try {
      
      const real = loadOrCreateAgentIdentity(scope);
      return {
        did: real.did,
        name: `Agent-${this.peerId.substring(0, 8)}`,
        publicKey: real.publicKey || this.peerId,
        createdAt: Date.now(),
      };
    } catch {
      // 真身份生成失败时**不编假 DID**: 如实留空, 由 /did 与 get_identity 报"未绑定"
      return {
        did: '',
        name: `Agent-${this.peerId.substring(0, 8)}`,
        publicKey: this.peerId,
        createdAt: Date.now(),
      };
    }
  }

  private checkMinimax(): boolean {
    try {
      getMinimax();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 2026-09-26: 这个 Run 开始那一刻**真实生效**的模型配置快照, 由 startRun 落进 Run 记录。
   * 拿不到 (配置读不出来) 就返回 undefined —— 宁可这个字段缺, 也不编一个假的进去。
   */
  private async runModelSnapshot(): Promise<RunModelConfig | undefined> {
    try {
      return await captureRunModelConfig();
    } catch {
      return undefined;
    }
  }

  /** 2026-08-07: prompt 出口统一上报 token 用量到 ContextManager (fallback/pivot/react 全路径覆盖) —
   *   之前只有 runReActLoop 迭代内上报, chitchat/fallback/pivot 路径状态栏恒 0 */
  private reportUsageToContextManager(): void {
    try {
      getContextManager().updateUsage(this.estimateHistoryTokens());
    } catch { /* 非致命 */ }
  }

  // ============================================================
  // 2026-08-08: 运行轨迹采集 (trajectory) — 每轮运行 → 落盘 + OrbitDB, 失败静默
  // ============================================================
  private async createTrajectoryRecorder(input: string, channelId?: string): Promise<any> {
    try {
      const { TrajectoryRecorder } = await import('../orbitdb/trajectory-store.js');
      const { resolveUserDid } = await import('../storage/did-catalog-bridge.js');
      const did = await resolveUserDid();
      const model = (this as any).llmConfig?.model || (this as any).model || '';
      return new TrajectoryRecorder({
        agentId: this.actor!.state.agentId || 'default',
        input,
        channelId: channelId || this.actor!.state.channelId,
        did: did || undefined,
        model: typeof model === 'string' && model ? model : undefined,
      });
    } catch {
      return null; // 轨迹采集失败静默 (增强层)
    }
  }

  private wrapTrajectoryStream(onStream: StreamCallback, rec: any): StreamCallback {
    return (ev) => {
      try { rec?.recordStep?.(ev); } catch { /* 记录失败不影响转发 */ }
      onStream(ev);
    };
  }

  private finishTrajectory(rec: any, reply: string, status: 'ok' | 'error' | 'aborted' = 'ok'): void {
    if (!rec) return;
    // fire-and-forget: 不阻塞回复返回
    (async () => {
      try {
        const { recordTrajectory } = await import('../orbitdb/trajectory-store.js');
        const run = rec.endRun(reply, status);
        await recordTrajectory(run, {});
      } catch { /* 静默 */ }
    })();
  }

  async prompt(input: string, options?: { onStream?: StreamCallback; signal?: AbortSignal; channelId?: string }): Promise<string> {
    // 2026-09-16 (M4 启动硬门禁): 初始化未就绪 → 不执行 Agent。
    //   fail-closed: 读不出初始化状态也按未就绪处理 (与 runnerResolver"解析不到只诊断"一致)。
    //   测试环境 (VITEST) 跳过: 那 1800+ 用例跑在隔离 HOME 里, 本来就没有真实配置。
    if (!process.env.VITEST) {
      try {
        const { getSetupGateCached } = await import('../setup/setup-store.js');
        const { gate, state } = await getSetupGateCached();
        if (gate !== 'ready') {
          const why = `初始化未就绪 (${gate}, 当前阶段 ${state.stage})${state.lastError ? ` — ${state.lastError.message}` : ''}`;
          const hint = (state.actions && state.actions[0]) || '运行 `bolloon setup` 完成初始化';
          this.pushHistory({ role: 'user', content: input });
          this.pushHistory({ role: 'assistant', content: `[初始化未就绪] ${why}\n${hint}` });
          console.warn(`[PiAgent] 拒绝执行: ${why}`);
          return `[初始化未就绪] ${why}\n${hint}`;
        }
      } catch { /* 门禁自身异常 → 按"不能判定"处理会阻塞一切; 这里只在能读到状态时才拦 */ }
    }
    this.minimaxAvailable = this.checkMinimax();
    this.actor!.state.channelId = options?.channelId ?? this.actor!.state.channelId;

    // 2026-08-08: 运行轨迹采集 (落盘 + OrbitDB, 失败静默) — 包裹 onStream 收集步骤事件
    const trajRec = await this.createTrajectoryRecorder(input, options?.channelId);
    if (trajRec && options?.onStream) {
      options = { ...options, onStream: this.wrapTrajectoryStream(options.onStream, trajRec) };
    }

    this.pushHistory({
      role: 'user',
      content: input
    });

    if (!this.minimaxAvailable) {
      // 2026-09-16 (2-C.2): fallback **也必须留下 Run 事实**。
      //   旧行为: 直接返回兜底文案, 连 Run 都不建 —— 上层 (独立宿主/Supervisor) 只看到"执行完成但没有 Run",
      //   于是把"什么都没跑"当成一次正常执行 (这正是"agent 跑了但没记录"的老毛病在 fallback 路径的翻版)。
      const response = await this.handleFallback(input);
      try {
        let boundGoalId = this.actor!.state.goalBinding;
        if (!boundGoalId) {
          const g = await createGoal({
            objective: this.currentUserInput || input.slice(0, 200),
            channelId: this.actor!.state.channelId || undefined,
            agentId: this.actor!.state.agentId || undefined,
            createdBy: this.runSurface,
          });
          boundGoalId = g.goalId;
        }
        this.actor!.state.goalBinding = boundGoalId;
        const rec = await startRun({
          surface: this.runSurface,
          goal: this.currentUserInput || input.slice(0, 200),
          goalId: boundGoalId,
          channelId: this.actor!.state.channelId || undefined,
          agentId: this.actor!.state.agentId || undefined,
          modelConfig: await this.runModelSnapshot(),
        });
        this.lastRunId = rec.runId;
        await attachRun(boundGoalId, rec.runId).catch(() => null);
        await recordStep(rec.runId, { tool: 'llm', ok: false, error: 'LLM 不可用 (provider 未初始化/无 apiKey) → 走了 fallback' });
        await finishRun(rec.runId, {
          status: 'needs_human',
          error: 'LLM 不可用: provider 未初始化或无 apiKey (fallback 不是执行结果, 需要配置或人工处理)',
        });
        // ★ M0: "工具/权限不可用"也是一条终止路径 → 同样进收尾漏斗 (规则 ④)。
        const wiring = await import('./goal-flywheel-wiring.js');
        const closed = await wiring.closeRunOnce({
          goalId: boundGoalId,
          runId: rec.runId,
          caller: 'runner',
          now: new Date().toISOString(),
          finalReview: `LLM 不可用 → fallback 收尾 (不是执行结果): ${response}`,
        });
        if (!wiring.isRefusal(closed) && closed.outcome) {
          const { reduceGoalState } = await import('./goal-state-reducer.js');
          await reduceGoalState({
            goalId: boundGoalId,
            intent: 'closure_outcome',
            now: new Date().toISOString(),
            by: 'runner',
            outcome: {
              goalStatus: wiring.goalStatusFromDecision(closed.outcome.decision),
              continuation: wiring.toGoalStoreContinuation(closed.outcome.continuation),
              reason: closed.outcome.decision.reason,
            },
            runId: rec.runId,
          });
        }
        console.log(`[PiAgent] LLM 不可用 → 本次仍落 Run ${rec.runId} (needs_human), 不伪装成正常执行`);
      } catch (err) {
        await recordDegradation({ kind: 'core', op: 'pi-sdk.fallbackRun', runId: this.lastRunId || '', message: String((err as Error)?.message || err).slice(0, 160) }).catch(() => {});
      }
      this.pushHistory({ role: 'assistant', content: response });
      this.reportUsageToContextManager();
      this.finishTrajectory(trajRec, response);
      return response;
    }

    // P0 注入门
    // K2: eventSink + abortSignal 已外置, 入口一次建好本轮 Context。
    //   其余字段**不在这里抄一份** —— 抄写会新增对旧实例字段的读, 违反方向判据
    //   「新层出现后旧写口调用点数只许不变或减少」。逐字段迁移时再各自搬进来。
    this.runCtx = this.seedRunContext({ eventSink: options?.onStream ?? null, abortSignal: options?.signal ?? null });
    await this.computeJudgmentGate(input);

    // M2.2 (2026-06-17): intent 分类 — prompt() 路径也跑 (跟 promptStream 对齐)
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.runCtx.intent = classifyIntent(input);
      this.currentIntentHint = intentHint(this.runCtx.intent);
      this.currentUserInput = input;
    } catch (err) {
      console.warn('[PiAgent] classifyIntent in prompt() failed:', err);
      this.runCtx.intent = 'chitchat';
      this.currentIntentHint = '';
    }

    // P2: 解析当前 permission mode
    try {
      const { resolvePermissionMode } = await import('./permission-mode.js');
      this.currentPermissionMode = resolvePermissionMode();
    } catch (err) {
      console.warn('[PiAgent] resolvePermissionMode failed (non-fatal):', err);
      this.currentPermissionMode = 'default';
    }

    // M3.1 (2026-06-17): 跟 promptStream 一样, usePivotLoop 时走 pivotLoop 路径
    //   之前 prompt() 永远跑老 runReActLoop, CLI/web 行为不一致
    if (this.usePivotLoop) {
      try {
        const lr = await this.promptWithPivotLoop(input, undefined, options?.channelId);
        // K4-B (2026-10-02): **收尾自检两条 loop 路径都要跑** —— 原先它只挂在老 `runReActLoop` 之后,
        //   而生产里 web 走 pivot 路径 (`usePivotLoop: true` + 这里提前 return) ⇒ 那条"系统自检过门"
        //   在生产**从来没触发过** (K7 的证据只在默认老 loop 上取到, 没覆盖生产形状)。这里补齐。
        await this.runTurnEndTypecheck();
        this.finishTrajectory(trajRec, lr.response || '');
        return lr.response || '';
      } finally {
        if (this.judgmentGateUsedIds.length > 0) {
          recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
            console.warn('[PiAgent] recordJudgmentUsage failed:', err)
          );
        }
        this.clearJudgmentGate();
        this.runCtx = createRunContext(); // K2: 用完即清 (换新 Context, 不继承残留);
        this.reportUsageToContextManager();
      }
    }

    try {
      // 2026-06-16: runReActLoop 现在返回 { reply, aiFailed, aiFailureReason } — 这里只需 reply 字符串
      const loopResult = await this.runReActLoop(this.runCtx.eventSink ?? undefined, options?.signal);

      // K4-B (2026-10-02): 收尾自检抽成方法, 两条 loop 路径都调 (原先只在老 loop 之后 ⇒ 生产 pivot 路径从没跑过)
      await this.runTurnEndTypecheck();
      // 2026-10-01: **回合后自审 (纯旁路)** —— 沉淀可复用经验, 对应"结束后沉淀"那一段。
      //   纪律: fire-and-forget (不阻塞主回合) · 只写 ~/.bolloon/experience/ (**不碰主对话/prompt 缓存**)
      //        · 节流 (默认 10 分钟/agent) · 失败只记一行日志, 绝不影响本回合结果。
      try {
        const reviewNow = Date.now();
        const turnSummary = `用户: ${String(this.currentUserInput || '').slice(0, 2000)}\n助手: ${String(loopResult?.reply || '').slice(0, 4000)}`;
        // 任务签名: 用户这次要的东西 + 用了哪些工具 ⇒ 换任务立刻复盘(同一任务才节流) ✓
        const taskSig = createHash('sha256')
          .update(`${String(this.currentUserInput || '').slice(0, 300)}|${(this as any).totalToolCallsThisTurn || ''}`)
          .digest('hex').slice(0, 12);
        if (shouldReviewTask(reviewNow, this.lastExperienceReviewAt, this.lastReviewedTaskSig, taskSig)) {
          this.lastExperienceReviewAt = reviewNow; // 先记账, 免得多路并发各起一次
          this.lastReviewedTaskSig = taskSig;
          // 2026-10-01 (用户: 「我没有看到执行完命令后 bolloon 知道选中更新 skills，是不是没有触发」):
          //   实测**确实没触发** ✓ —— 两个原因: ① 被调方又自己判了一次节流 ⇒ 换任务也被 throttled 掉 ✗;
          //   ② 反馈走 `console.warn`(TUI 里被吞 ✗) + `void … .catch(() => {})`(失败无声 ✗)
          //   ⇒ 你什么都看不到 ✓。现在: 传 force 尊重调用方的决定 ✓ · 复盘过程/结果/失败**都进对话流** ✓ ·
          //   同时落一份 `~/.bolloon/logs/experience-review.log` 供事后核 ✓。
          const reviewLog = (m: string) => {
            const line = `[${new Date().toISOString()}] ${m}`;
            try {
              const p = path.join(os.homedir(), '.bolloon', 'logs', 'experience-review.log');
              void fs.mkdir(path.dirname(p), { recursive: true })
                .then(() => fs.appendFile(p, line + '\n'))
                .catch(() => { /* 落日志失败不影响主流程 */ });
            } catch { /* 落日志失败不影响主流程 */ }
            try { this.runCtx.eventSink?.({ type: 'status', content: `📚 复盘: ${m}`, tool: 'system' } as any); } catch { /* 上屏失败不打断 */ }
          };
          reviewLog('开始(换了任务 ⇒ 立刻复盘)');
          void runExperienceReview({
            turnSummary,
            force: true,
            chat: async (prompt: string) => {
              const r: any = await getMinimax().chat(prompt);
              return typeof r === 'string' ? r : String(r?.content ?? r?.text ?? '');
            },
            log: reviewLog,
            // 2026-10-01: 写了经验之后再找"能沉淀进哪个已有技能"的候选 —— **只记候选, 不自动改技能** ✓
            //   (实测: 拿真实教训撞真实 1300 个技能, 最高分只有 2 且 top 命中是瞎的 ✗ ⇒ 不替人决定 ✓)
            onLesson: (lesson) => {
              try {
                // ⓐ 管理: 找"能沉淀进哪个已有技能"的候选(只记, 不自动改 ✗)
                const dirs = defaultSkillPaths(os.homedir(), process.cwd());
                const decision = decideLessonSink(lesson, skillsFromDirs(dirs));
                logLessonSuggestions(lesson, decision);
                // ⓐ' 用户要求「**都进去**」⇒ 每条教训都落进技能库: 强命中写那个技能 ✓, 否则写沉淀技能 `lessons-learned` ✓
                // 2026-10-01 **写来源隔离**: 复盘/自审产生的写, 打上 review 标记 ✓ ⇒
                //   它只许治理**自己造出来**的技能 ✓(用户在 skills 里点名要的归用户 ✓)
                runWithWriteOrigin('review', () => routeLessonToSkill(lesson, skillsFromDirs(dirs)));
                // 2026-10-01 (用户: 「复盘任务能否触发 loop?」): 教训**回流成下一轮的任务源** ✓ ——
                //   只"记下来"等于闭环断在这 ✗; 投进共享队列 ⇒ 空闲时排空 ⇒ 以**新一轮**浮现 ✓(绝不中途插队 ✓)。
                try { pushNotice('review', `${lesson.title} —— ${String(lesson.body || '').replace(/\s+/g, ' ').slice(0, 120)}`); } catch { /* 回流失败不打断 */ }
                // ⓑ 接入**判断力系统**: 同一条教训也进 HumanJudgment(带 source/confidence/revisable ⇒ 可被后续演化取代 ✓)
                //    这样经验库与判断力库**同一份来源**, 判断力注入(gate)时就能用上 ✓
                import('../pi-ecosystem-judgment/human-value-store.js').then((m) => m.storeHumanJudgment({
                  decision: lesson.title,
                  decision_type: 'modify',
                  reasons: [lesson.body],
                  values_derived: [],
                  context: { domain: lesson.klass || 'general', complexity: 'simple', stakes: 'medium', time_pressure: 'low' },
                  outcome: { approved: true },
                  metadata: { source: 'trajectory', confidence: 0.7, revisable: true },
                } as any)).catch(() => { /* 判断力写入失败不影响经验沉淀 */ });
              } catch { /* 这一段整体是锦上添花, 绝不外泄错误 */ }
            },
          }).then((r) => {
            // 结果**如实上屏** ✓: 审没审 / 写没写 / 为什么没写 —— 不再无声 ✓
            reviewLog(r?.reviewed
              ? (r?.applied ? `已沉淀经验 ✓${r?.file ? ` → ${path.basename(String(r.file))}` : ''}` : `审了但没写: ${r?.reason || '无'}`)
              : `没审: ${r?.reason || '无'}`);
          }).catch((e) => {
            reviewLog(`失败(已如实记录, 不外泄错误): ${String((e as Error)?.message || e).slice(0, 160)}`);
          });
        }
      } catch { /* 挂点自身失败也不影响主流程 */ }
      this.finishTrajectory(trajRec, loopResult.reply, loopResult.aiFailed ? 'error' : 'ok');
      return loopResult.reply;
    } finally {
      if (this.judgmentGateUsedIds.length > 0) {
        recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input, polarity: 'positive' }).catch((err) =>
          console.warn('[PiAgent] recordJudgmentUsage failed:', err)
        );
      }
      if (this.judgmentGateNegativeUsedIds.length > 0) {
        recordJudgmentUsage(this.judgmentGateNegativeUsedIds, { userInput: input, polarity: 'negative' }).catch((err) =>
          console.warn('[PiAgent] recordJudgmentUsage (negative) failed:', err)
        );
      }
      this.clearJudgmentGate();
      this.runCtx = createRunContext(); // K2: 用完即清 (换新 Context, 不继承残留);
      this.reportUsageToContextManager();
    }
  }

  async promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal, channelId?: string): Promise<string> {
    console.log(`[PiAgent.promptStream] ENTRY, channelId=${channelId}, input chars=${input.length}`);
    this.minimaxAvailable = this.checkMinimax();
    console.log(`[PiAgent.promptStream] minimaxAvailable=${this.minimaxAvailable}`);
    this.actor!.state.channelId = channelId ?? this.actor!.state.channelId;

    // 2026-08-08: 运行轨迹采集 (落盘 + OrbitDB, 失败静默) — 包裹 onStream 收集步骤事件
    const trajRec = await this.createTrajectoryRecorder(input, channelId);
    if (trajRec) onStream = this.wrapTrajectoryStream(onStream, trajRec);

    // 2026-06-18 (supervisor): web server 把 46K markedPrompt 喂过来
    //   (【本轮用户请求】\n<text>\n【请求结束】\n\n<contextHint>).
    //   整个 input 走下游, pivot loop 之前拿 47K buildContext 当 user message 发出去,
    //   模型撞 context window. 提取 userText 替代 input, contextHint 拼到 systemPrompt 末尾.
    const markerMatch = input.match(/【本轮用户请求】\s*([\s\S]*?)\s*【请求结束】/);
    const userText = markerMatch ? markerMatch[1].trim() : input;
    const contextHint = markerMatch ? input.replace(markerMatch[0], '').trim() : '';
    console.log(`[PiAgent.promptStream] marker matched=${!!markerMatch}, userText chars=${userText.length}, contextHint chars=${contextHint.length}`);

    this.pushHistory({
      role: 'user',
      content: userText
    });
    // 2026-06-18: web server 喂的 markedPrompt 外的 contextHint 拼到 system 末尾 (而不是当 user message)
    this.contextHintAddition = contextHint;

    // 2026-08-12 (TaskM1, hermes prefetch 模式): 运行时按用户消息召回历史记忆, 注入 system prompt.
    //   让 agent 能"回忆起"之前 session 的记忆 (自动获取之前 session), 而非只靠启动时批量压缩.
    try {
      const { recallMemory } = await import('./memory-recall.js');
      const recalled = await recallMemory({ query: userText, agentId: this.actor!.state.agentId || this.peerId || '' });
      if (recalled) {
        this.contextHintAddition = [this.contextHintAddition, recalled].filter(Boolean).join('\n\n');
      }
    } catch { /* 记忆召回失败静默 (增强层) */ }

    onStream({ type: 'thinking', content: '🤔 开始思考...' });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(userText);
      this.pushHistory({ role: 'assistant', content: response });
      onStream({ type: 'done', content: '' });
      this.reportUsageToContextManager();
      this.finishTrajectory(trajRec, response);
      return response;
    }

    // P0 注入门: 缓存 onStream + signal, computeJudgmentGate 用 runCtx.eventSink 广播 phase
    // K2: eventSink + abortSignal 一起建进本轮 Context (只搬已外置的字段, 不抄未迁移的)
    this.runCtx = this.seedRunContext({ eventSink: onStream, abortSignal: signal ?? null });
    await this.computeJudgmentGate(userText);

    // M2.2 (2026-06-17): intent 分类 — 0 LLM 成本, 5 行 keyword 匹配
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.runCtx.intent = classifyIntent(userText);
      this.currentIntentHint = intentHint(this.runCtx.intent);
      this.currentUserInput = userText;
      if (this.runCtx.intent !== 'chitchat') {
        onStream({ type: 'phase', phase: 'intent_classified', detail: this.runCtx.intent, content: '' } as any);
      }
    } catch (err) {
      console.warn('[PiAgent] classifyIntent failed (non-fatal):', err);
      this.runCtx.intent = 'chitchat';
      this.currentIntentHint = '';
    }

    // P1.1: 异步跑 Auto-Compact (LLM 摘要, 仅在 budget 超限时触发, 失败静默)
    // 复用 computeJudgmentGate 的 onStream 广播 phase, 跟 judgment 注入门风格一致
    try {
      await this.maybeAutoCompact(onStream, signal);
    } catch (err) {
      console.warn('[PiAgent] maybeAutoCompact failed (non-fatal):', err);
    }

    // Bootstrap SessionStart: 收集项目 Context, 拼到 systemAddition 头部
    // (失败静默, 5s 限流防止循环)
    // 2026-07-04: 透传 agentId 让 onSessionStart 加载 persona 文档
    let bootstrapAddition = '';
    try {
      const ss = await onSessionStart({
        channelId: this.actor!.state.channelId || undefined,
        agentId: this.actor!.state.agentId || undefined,
      });
      bootstrapAddition = ss.systemAddition || '';
    } catch (err) {
      console.warn('[PiAgent] onSessionStart failed (non-fatal):', err);
    }

    // 2026-07-07 P1-B: 注入最近 5 条项目事件日志 (L2) — 让 LLM 知道项目状态/feature 变化
    // 失败静默, append 到 bootstrapAddition 末尾 (超 800 字截断)
    if (this.actor!.state.channelId) {
      try {
        const { getRecentEvents } = await import('../bootstrap/event-log.js');
        const events = await getRecentEvents(this.actor!.state.channelId, 5);
        if (events.length > 0) {
          const eventBlock = [
            '## 最近项目事件 (最近 5 条, 倒序)',
            ...events.map(e => `- [${e.ts.slice(0, 16)}] [${e.type}] ${e.summary}`),
          ].join('\n');
          bootstrapAddition = (bootstrapAddition + '\n\n' + eventBlock).slice(-2000);
        }
      } catch (err) {
        console.warn('[PiAgent] getRecentEvents failed (non-fatal):', err);
      }

      // 2026-07-07 P2-C: 注入项目当前状态 (L3) — 目标/约束/待办/已完成
      try {
        const { readState, formatStateForPrompt } = await import('../bootstrap/project-state.js');
        const state = await readState({ channelId: this.actor!.state.channelId });
        const stateText = formatStateForPrompt(state);
        if (stateText) {
          bootstrapAddition = (bootstrapAddition + '\n\n' + stateText).slice(-2500);
        }
      } catch (err) {
        console.warn('[PiAgent] readState failed (non-fatal):', err);
      }

      // 2026-07-07 P2-C: 向量检索 top-3 (L4) — 按当前 channelId + userText 找历史相关片段
      try {
        const { searchIndex } = await import('../bootstrap/vector-index.js');
        const indexName = `channel-${this.actor!.state.channelId}`;
        const results = await searchIndex({
          indexName,
          query: userText,
          topK: 3,
        });
        if (results.length > 0) {
          const hitBlock = [
            '## 相关历史片段 (top-3, TF-IDF cosine)',
            ...results.map((r, i) => `- [${i + 1}] score=${r.score.toFixed(3)}: ${r.text.slice(0, 200).replace(/\n/g, ' ')}`),
          ].join('\n');
          bootstrapAddition = (bootstrapAddition + '\n\n' + hitBlock).slice(-3000);
        }
      } catch (err) {
        // 索引不存在是常见情况 (新 channel), 不打 warn
      }
    }
    this.bootstrapAddition = bootstrapAddition;

    // P2: 解析当前 permission mode (BootstrapOptions > env BOLLOON_PERM_MODE > default)
    try {
      const { resolvePermissionMode } = await import('./permission-mode.js');
      this.currentPermissionMode = resolvePermissionMode();
    } catch (err) {
      console.warn('[PiAgent] resolvePermissionMode failed (non-fatal, using default):', err);
      this.currentPermissionMode = 'default';
    }

    this.promptStartTime = Date.now();

    // M3.1 (2026-06-17): 走 WorkflowPivotLoop (usePivotLoop: true)
    //   pivot loop 自带 quality scoring / 30 iter cap / complexity analysis — 比老 runReActLoop 鲁棒
    if (this.usePivotLoop) {
      let pivotResult = '';
      try {
        const lr = await this.promptWithPivotLoop(userText, undefined, channelId);
        pivotResult = lr.response || '';
        // K4-B (2026-10-02): **流式 pivot 路径**(web 实际入口)同样要跑收尾自检 ——
        //   原先这条路径也只有"提前 return", 自检一次都没跑过。
        await this.runTurnEndTypecheck();
        onStream({ type: 'done', content: '' });
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError') {
          console.log(`[chat] pivot aborted channel=${channelId}`);
        } else {
          console.error(`[chat] pivot 失败 channel=${channelId}:`, err);
          pivotResult = `[错误: pivot loop 失败] ${String(err?.message || err).slice(0, 300)}`;
          try { onStream({ type: 'error', content: pivotResult, tool: 'system' }); } catch {}
        }
      } finally {
        if (this.judgmentGateUsedIds.length > 0) {
          try { onStream({ type: 'used_judgments', usedIds: this.judgmentGateUsedIds, content: '' } as any); } catch {}
        }
        monitorAfterReply(userText, pivotResult);
        const stopStartTime = this.promptStartTime || Date.now();
        onStop({
          channelId: this.actor!.state.channelId || 'unknown',
          durationMs: Date.now() - stopStartTime,
          usedJudgmentIds: [...this.judgmentGateUsedIds],
        }).catch((err) => console.warn('[PiAgent] onStop failed:', err));
        this.clearJudgmentGate();
        this.runCtx = createRunContext(); // K2: 用完即清 (换新 Context, 不继承残留);
        this.bootstrapAddition = '';
        this.contextHintAddition = '';
        this.promptStartTime = 0;
        this.reportUsageToContextManager();
      }
      this.finishTrajectory(trajRec, pivotResult);
      return pivotResult;
    }

    // 2026-06-16: loop 自动重试 — runReActLoop 内部遇到 [AI 服务调用失败] sentinel 时,
    //   会设 aiFailed=true 并提前 break. 这里在外层重跑整个 loop (不是单次 LLM 调用),
    //   临时网络抖动 / 配额瞬时超限可自愈. 最多 3 次, 指数退避 1s/2s/4s.
    //   用户看到 status bar 显示 "自动重试中 X/N" — 不暴露按钮.
    const MAX_LOOP_RETRIES = 3;
    let attempt = 0;
    let result: string = '';
    let lastAiFailureReason = '';
    while (attempt <= MAX_LOOP_RETRIES) {
      try {
        const loopResult = await this.runReActLoop(onStream, signal);
        result = loopResult.reply;
        // 持久化失败不重试 (写不进去就是写不进去): 直接按本次结果收尾
        if (this.runPersistenceBlocked) break;
        if (!loopResult.aiFailed) break; // 正常完成, 退出 retry 循环
        lastAiFailureReason = loopResult.aiFailureReason || 'AI 调用失败';
      } catch (err: any) {
        // abort 失败: 视作"已中断", 抛错让上层用 partial 兜底
        this.runCtx = createRunContext(); // K2: 用完即清 (换新 Context, 不继承残留);
        throw err;
      }
      attempt++;
      if (attempt > MAX_LOOP_RETRIES) {
        console.warn(`[PiAgent] loop 自动重试 ${MAX_LOOP_RETRIES} 次后仍失败, 终止`);
        if (onStream) {
          onStream({ type: 'status', content: `⛔ loop 自动重试 ${MAX_LOOP_RETRIES} 次后仍失败: ${lastAiFailureReason}`, tool: 'system' });
        }
        result = lastAiFailureReason || 'AI 服务调用失败, 自动重试后仍不可用';
        break;
      }
      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.log(`[PiAgent] loop 自动重试 ${attempt}/${MAX_LOOP_RETRIES}, 等待 ${backoffMs}ms`);
      if (onStream) {
        onStream({ type: 'status', internal: true, content: `↻ 自动重试 loop ${attempt}/${MAX_LOOP_RETRIES} (${(backoffMs / 1000).toFixed(0)}s 后)`, tool: 'system' });
      }
      // 中途 abort 也要响应
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        }, backoffMs);
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error('aborted during retry backoff'));
        };
        if (signal?.aborted) {
          clearTimeout(t);
          reject(new Error('aborted during retry backoff'));
          return;
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
      // 重试时要把这条 user message 从 history 里移除 (避免下一次 runReActLoop 又重复加入),
      // 因为 messageHistory.push({role:'user'}) 在 promptStream 顶部已经做过, 重跑 runReActLoop 不会重复 push,
      // 但 assistant 失败那条也别留 (留了会污染下一轮 LLM context).
      // 简化: 重试前 pop 一次 assistant (如果最后一条是 assistant)
      if ((this.actor!.state.messageHistory as Message[]).length > 0 && (this.actor!.state.messageHistory as Message[])[(this.actor!.state.messageHistory as Message[]).length - 1].role === 'assistant') {
        this.popHistory();
      }
    }
    onStream({ type: 'done', content: '' });

    // 回溯: 异步记录 usage (不等)
    if (this.judgmentGateUsedIds.length > 0) {
      recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
        console.warn('[PiAgent] recordJudgmentUsage failed:', err)
      );
      // P0.5: 把 usedIds 通过 stream 事件回传给调用方 (server.ts 写到 session message)
      try { onStream({ type: 'used_judgments', usedIds: this.judgmentGateUsedIds, content: '' } as any); } catch {}
    }

    // P3 监控门: fire-and-forget 审计 AI 回复是否违反原则
    monitorAfterReply(input, result);

    // Bootstrap Stop hook: fire-and-forget 写本次 session 摘要
    const stopStartTime = this.promptStartTime || Date.now();
    onStop({
      channelId: this.actor!.state.channelId || 'unknown',
      durationMs: Date.now() - stopStartTime,
      usedJudgmentIds: [...this.judgmentGateUsedIds],
    }).catch((err) => console.warn('[PiAgent] onStop failed:', err));

    // 用完即清, 避免污染下一轮
    this.clearJudgmentGate();
    this.runCtx = createRunContext(); // K2: 用完即清 (换新 Context, 不继承残留);
    this.reportUsageToContextManager();
    this.bootstrapAddition = '';
    this.promptStartTime = 0;

    // 2026-08-08: 轨迹收尾 — 落盘 + OrbitDB (失败静默, 不阻塞回复)
    this.finishTrajectory(trajRec, result);

    return result;
  }

  async promptWithPivotLoop(input: string, config?: PivotLoopConfig, channelId?: string): Promise<LoopResult> {
    this.actor!.state.channelId = channelId ?? this.actor!.state.channelId;
    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(input);
      return {
        success: false,
        response,
        iterations: 0,
        toolCalls: 0,
        qualityScore: 0,
        exitReason: 'error',
        state: {
          iteration: 0,
          totalTokens: 0,
          toolCallsCount: 0,
          consecutiveNoProgress: 0,
          qualityScores: [],
          pendingToolUses: [],
          lastMeaningfulWork: 0
        }
      };
    }

    const llm = getMinimax();
    const baseConfig = config || this.pivotLoopConfig || createDefaultPivotConfig();
    // 2026-10-02 (K7 第二步 b): pivot loop 的工具执行**必须与主路径同一个门**。
    //   接线前: pivot loop 在 workflow-pivot-loop.ts:613 直调 tool.execute —— 那条路径上
    //   没有任何 harness 调用 (K7 台账里的**真旁路** ①); 主路径则在 runReActLoop 内先过
    //   `beforeToolCall` (顺序: deny → pre-tool-validator(4 步链) → react-harness(8-gate))。
    //   这里把同一个判定包成端口注入 ⇒ 两处执行共用一扇门。
    //   **fail-closed**: 门面抛错 ⇒ 拒绝执行 (绝不回落成直调; 旧实现有过两条 fail-open 路径)。
    const loopConfig: PivotLoopConfig = {
      ...baseConfig,
      guardedExecute: async (tool, args) => {
        let decision: ToolDecision;
        try {
          decision = await this.piHarness().beforeToolCall({
            tool: tool.name,
            args,
            ctx: this.harnessCtx(),
            permissionMode: this.currentPermissionMode,
          });
        } catch (err) {
          return {
            success: false,
            error: `拒绝: [harness-error] Harness 门面异常: ${String((err as Error)?.message || err).slice(0, 150)}`,
          };
        }
        if (!decision.allow) {
          return {
            success: false,
            error: `拒绝: [${decision.rejectedBy || decision.source || 'unknown'}] ${decision.reason}`,
          };
        }
        // K4-B (2026-10-02): **改过 TS 就记账** —— 这笔账原先只记在**老 loop 的工具分发**里,
        //   pivot 路径没有 ⇒ 默认切 pivot 后 pivot 里编辑了 TS 却不记账 ⇒ 收尾自检永远不触发
        //   (与"自检只挂在老 loop"同族的缺陷: 同一件事只在一套 loop 里实现)。
        //   补在 pivot 的**唯一执行点**上 ⇒ 两条 loop 口径一致。
        {
          const tsFile = codeWriteTarget(tool.name, args);
          if (tsFile && !this.tsTouchedThisTurn.includes(tsFile)) this.tsTouchedThisTurn.push(tsFile);
        }
        return tool.execute(args);
      },
    };
    const loop = new WorkflowPivotLoop(loopConfig);

    for (const tool of this.tools.values()) {
      loop.registerTool(tool);
    }

    // P0 注入门: 在构造 systemPrompt 之前算一次, 拼到末尾
    await this.computeJudgmentGate(input);

    // M2.2 (2026-06-17): intent 分类 — pivot loop 也要拿到 hint
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.runCtx.intent = classifyIntent(input);
      this.currentIntentHint = intentHint(this.runCtx.intent);
      this.currentUserInput = input;
    } catch (err) {
      console.warn('[PiAgent] classifyIntent in pivot failed:', err);
    }

    // M2.4: persona 缓存
    if (!this.cachedPersonaSection && this.persona) {
      this.cachedPersonaSection = `
角色描述: ${this.persona.description || '无'}
性格特点: ${this.persona.personality || '无'}
问候语: ${this.persona.greeting || '无'}
`;
    }

    const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${this.cachedPersonaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})
${this.currentIntentHint}

${this.getToolDefinitions()}

${PiAgentSession.TOOL_SELECTION_GUIDE}

${PROACTIVE_WORK_DISCIPLINE}

${await this.renderActivePlansSection()}

工作模式:
1. 理解用户自然语言请求
2. 分析需要哪些工具来完成
3. 按顺序调用工具并观察结果
4. 根据观察结果决定下一步
5. 最终给出完整回答

重要 (一次命中要求):
- 每次只调用一个工具
- 仔细分析工具返回结果
- 当任务完成时，必须在回答末尾添加 <final gen> 标记表示结束
- 如果需要更多信息，继续调用工具

【工具调用格式 (严格遵守, 否则系统无法解析)】
- 你只能输出**一个**工具调用, 不要堆叠多个 invoke
- 工具调用格式: {"name":"<tool_name>","input":{"arg1":"value1"}}
- 用 markdown json code block 包裹: \`\`\`json\n{"name":"X","input":{...}}\n\`\`\`
- 工具调用前可以简短思考 (1-2 句话), 但**不要写长篇 thinking** (会撞 max_tokens)
- 工具调用后必须等结果, 不要在同一个回复里继续输出
- <final gen> 只在**真完成所有任务**时输出, 不要在工具调用前/中输出${this.judgmentGateAddition}${this.contextHintAddition}`;

    // 2026-06-15: 把 runCtx.eventSink 传给 loop, 让 step-timeline 在 pivot 循环里也能 emit step_start/done
    //   之前 loop.execute() 不接 streamCallback, 导致 step-timeline 只能看到老 runReActLoop 路径
    //   promptWithPivotLoop 路径 0 step events — UI 显示 timeline 但永远是空
    // 2026-06-17: 透传 signal 让 abort 工作 — loop.execute() 当前不接 signal 参数,
    //   所以 abort 行为通过 this.currentSignal 共享给 loop 内部读 (后续 M3.2 接 task plan 时一起加)
    // 2026-07-06: pivot 内 token 累计到 ~70% 时回调 (workflow-pivot-loop.ts line 270+).
    //   pivot 的 messageHistory 是 process-local, 不和 pi-sdk 的 actor 的 messageHistory 同步.
    //   真正折叠需要把 pi-sdk 历史灌回 pivot 的 history 数组 — 侵入较大.
    //   当前 priority: 临时传空实现, 让 budget 公式放够 (workflow-pivot-loop.ts line 220)
    //   不再撞预算. 这条路径留作技术债.
    // 2026-07-17 Bug 1 修: 注入 messageHistory (hydrateMessageHistory 从 session JSON 回灌的) 到 system prompt
    //   pivot loop execute() 内部自己维护 messageHistory, 跟 pi-sdk 的 actor 的 messageHistory 隔离,
    //   不注入的话 LLM 看不到历史对话, 每次都是新对话.
    const historyLines: string[] = [];
    const historyToInject = (this.actor!.state.messageHistory as Message[]).slice(-20, -1);
    for (const m of historyToInject) {
      const roleLabel = m.role === 'user' ? '用户' : m.role === 'assistant' ? '你' : m.role === 'tool' ? '工具结果' : m.role;
      const text = (m.content || '').slice(0, 2000);
      if (text) historyLines.push(`[${roleLabel}]: ${text}`);
    }
    const historyBlock = historyLines.length > 0
      ? `\n\n【历史对话 (最近 ${historyLines.length} 条)】\n${historyLines.join('\n')}\n【历史对话结束】`
      : '';

    const onCompact = async () => {
      // no-op (best-effort hook for future pi-sdk/pivot history sync)
    };
    const result = await loop.execute(input, llm, systemPrompt + historyBlock, this.runCtx.eventSink ?? undefined, this.runCtx.abortSignal ?? undefined, onCompact);

    if (result.response) {
      this.pushHistory({ role: 'assistant', content: result.response });
    }

    // 回溯 + 清场
    if (this.judgmentGateUsedIds.length > 0) {
      recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
        console.warn('[PiAgent] recordJudgmentUsage failed:', err)
      );
    }
    this.clearJudgmentGate();

    return result;
  }

  /**
   * 2026-09-16 (Milestone 1-B): 唯一 Harness 门面 — 约束层的**唯一**入口。
   * pi-sdk 从此刻起不再分别调用 deny-pipeline / validator / react-harness / hooks / loop-review,
   * 只调 harness.*; 由 Harness 决定约束顺序与失败处置 (见 pi-harness.ts)。
   */
  private _harness: PiAgentHarness | null = null;
  /** M2 绑定 GoalStore 后填真值; 在此之前为空 (事件里 goalId 字段已就位) */
  // **K5 步骤③/⑧**: 会话的 Goal 默认绑定本体在 `actor.state.goalBinding` (访问器已删, 直接读本体)。
  //   leo 口径不变: 这只是默认值; 每次执行开始必须把最终绑定写进 RunContext/Run 记录,
  //   运行中重绑必须走显式 Goal Binding 操作, 不许靠裸字段隐式生效。
  /** 2026-09-16 (M2): 本次执行是"从 checkpoint 恢复"的 runId (非空 = 恢复模式, 不再新建 run) */
  private resumeRunId = '';
  private resumePlan: ResumePlan | null = null;
  /** 2026-09-16 (2-C.4): 外部请求 id (工具层设; 回包必须带上才能精确匹配) */
  pendingExternalRequestId?: string;
  /** 2026-09-16 (M3): 外部等待中 (awaiting_external) —— 收到成功步骤后回 running */
  private awaitingExternal = false;
  /** 2026-09-16 (M3): 熔断原因 (同一工具连续失败达上限 → needs_human) */
  private breakerReason = '';
  /** 2026-09-16 (M3): 运行中核心写失败 (状态迁移等) —— 交给循环顶部硬闸, 不吞 */
  private persistenceFailure = '';
  /**
   * 2026-09-16 (M2-B): Supervisor 开新 Run 继续同一 Goal 时注入"上一个 Run 已成功的非幂等动作"。
   * 与 resume 的重放守卫同源 (run-store 的 buildContinuationPlan), 保证跨 Run 也不重复副作用。
   */
  private continuationGuards: { tool: string; argsDigest?: string; summary: string }[] = [];

  /** Supervisor / CLI 注入跨 Run 重放守卫 */
  setContinuationGuards(guards: { tool: string; argsDigest?: string; summary: string }[]): void {
    this.continuationGuards = Array.isArray(guards) ? guards : [];
  }

  /** CLI / Web 注入"当前目标" (有 goalId 就在该 Goal 下执行) */
  setGoalId(goalId: string): void {
    this.actor!.state.goalBinding = String(goalId || '');
  }

  /** 核心状态迁移的兜底: 失败 → 记降级 + 交给循环顶部的持久化硬闸 (不吞错) */
  private async safeSetRunStatus(runId: string, to: RunStatus): Promise<boolean> {
    try {
      const r = await setRunStatus(runId, to);
      return !!r.ok;
    } catch (err) {
      this.persistenceFailure = `状态迁移失败 (${to}): ${String((err as Error)?.message || err).slice(0, 180)}`;
      await recordDegradation({ kind: 'core', op: 'pi-sdk.setRunStatus', runId, message: this.persistenceFailure }).catch(() => {});
      return false;
    }
  }

  /**
   * 2026-09-16 (M3): 工具失败接线 —— 分类 → recovery 留痕 → 熔断 / 外部等待。
   * 这是"错误恢复闭环"的运行时接线点 (此前 recordRecovery / repeatedFailureCount 只是数据结构)。
   */
  private async wireToolFailure(tool: string, errorText: string, args: unknown): Promise<void> {
    if (!this.actor!.state.activeRun) return;
    const cls = classifyRunError(errorText);
    const digest = argsDigestOf(args);
    let repeats = 1;
    try {
      const rec = await readRun(this.actor!.state.activeRun);
      // recordStep 已经把**这次**失败记进去了, 所以"连续失败次数"直接就是当前值 (不再 +1)
      const seen = rec ? repeatedFailureCount(rec, tool, digest) : 0;
      repeats = Math.max(seen, 1);
    } catch { /* 读不到就按首次记 */ }

    const action = cls === 'transient' ? 'backoff'
      : cls === 'auth' ? 'escalate'
        : cls === 'external_no_reply' ? 'pause'
          : 'retry';
    try {
      await recordRecovery(this.actor!.state.activeRun, {
        errorClass: cls,
        message: `${tool}: ${errorText}`.slice(0, 200),
        action,
        attempt: repeats,
        recovered: false,
      });
    } catch (err) {
      await recordDegradation({ kind: 'core', op: 'pi-sdk.recordRecovery', runId: this.actor!.state.activeRun, message: String((err as Error)?.message || err) }).catch(() => {});
    }

    // 外部无响应 → awaiting_external (不算失败; 等回话后回到 running)
    if (cls === 'external_no_reply') {
      this.awaitingExternal = true;
      await this.safeSetRunStatus(this.actor!.state.activeRun, 'awaiting_external');
      // 2026-09-16 (2-C.4): 把"在等什么"写成持久化事实 (来源/关联/过期), 否则真实回包到了也不知道该唤醒谁。
      try {
        if (this.actor!.state.goalBinding) {
          const { bindExternalWait, newContinuationId, defaultWaitExpiry } = await import('./external-events.js');
          const isDelegate = /delegate/i.test(String(tool || ''));
          await bindExternalWait(this.actor!.state.goalBinding, {
            requestId: this.pendingExternalRequestId || `${this.actor!.state.activeRun}:${Date.now().toString(36)}`,
            continuationId: newContinuationId(this.actor!.state.goalBinding),
            expectedSource: isDelegate ? 'delegate' : 'p2p',
            expectedEvent: 'result',
            createdAt: new Date().toISOString(),
            expiresAt: defaultWaitExpiry(Date.now(), Number(process.env.BOLLOON_EXTERNAL_WAIT_MS || 30 * 60_000)),
            note: `${isDelegate ? 'delegate 回包' : 'P2P 协作回复'} 等待中 (tool=${tool})`,
          });
        }
      } catch (e) {
        await recordDegradation({ kind: 'core', op: 'pi-sdk.bindExternalWait', runId: this.actor!.state.activeRun, message: String((e as Error)?.message || e) }).catch(() => {});
      }
      return;
    }
    // 鉴权类: 不重试, 直接交人
    if (cls === 'auth') {
      this.breakerReason = `鉴权类错误不重试 (${tool}): ${errorText.slice(0, 120)}`;
      await this.safeSetRunStatus(this.actor!.state.activeRun, 'needs_human');
      return;
    }
    // 重复失败熔断: 同一工具 + 同一组参数连续失败达 3 次
    if (repeats >= MAX_SAME_TOOL_FAILURES) {
      this.breakerReason = `同一工具 ${tool} 连续失败 ${repeats} 次 (${cls}) → 熔断, 不再重试`;
      await this.safeSetRunStatus(this.actor!.state.activeRun, 'needs_human');
    }
  }

  getRunId(): string {
    return this.actor!.state.activeRun;
  }

  /**
   * 2026-09-16 (M2-B): **上一次**运行的 runId —— prompt 收尾时 `currentRunId` 会被清空,
   * 而 Supervisor / 控制面要在运行结束后才知道"刚才跑的是哪条 run" (否则会拿旧 run 做决策)。
   */
  getLastRunId(): string {
    return this.lastRunId || this.actor!.state.activeRun;
  }

  /**
   * 2026-09-16 (M2): 从 checkpoint 恢复一次运行 —— **不是**重发原 prompt。
   * 语义: prepareResume (校验状态 + 读 checkpoint + 记 recovery + 落 recovering) → 用恢复指令
   * 驱动同一个 runId 继续 (历史保留), 非幂等动作由重放守卫挡住。
   *
   * 2026-09-26: 恢复前**反查一次模型配置**。Run 记录里存的 `modelConfig` 快照此前只被写进
   * 快照和回显, 没人拿它核对现状 —— 于是"快照记的是 A, 现在盘上生效的是 B"这种情况会被
   * 静默继续下去 (长任务的历史执行链就说不清了)。现在: 漂了就 `console.warn` 说清哪几个字段漂了,
   * 并把结论放进返回值 (`modelDrift`) 让调用方能上报; 一致时也有一句明确结论。
   * 判断失败 (读不到 Run 等) 不阻塞恢复。
   */
  async resumeRun(runId: string): Promise<{ ok: boolean; reason?: string; reply?: string; modelDrift?: ConfigDriftReport; modelApplied?: EffectiveModelConfig }> {
    let modelDrift: ConfigDriftReport | undefined;
    let modelApplied: EffectiveModelConfig | undefined;
    try {
      const { detectRunConfigDrift } = await import('../llm/model-selection.js');
      modelDrift = (await detectRunConfigDrift(runId)) || undefined;
      if (modelDrift?.drifted) {
        console.warn('[pi-sdk] 恢复时模型配置已偏离 Run 快照:', modelDrift.message);
      } else if (modelDrift) {
        console.log('[pi-sdk] 恢复前核对:', modelDrift.message);
      }
    } catch { /* 核对本身失败不阻塞恢复 */ }
    const prep = await prepareResume(runId);
    if (!prep.ok || !prep.plan) return { ok: false, reason: prep.reason, ...(modelDrift ? { modelDrift } : {}) };
    // 2026-09-26 (P6 × P7): 恢复一个在跑的 Run, 用的是**它自己那份快照**, 不是盘上现在的全局默认 ——
    //   否则这次恢复就是"带着漂移继续跑", 之后再存快照会把漂移固化成历史。
    //   只在"漂了"或"核对不了"时重装 (一致时运行时本来就是对的, 重装是白跑一趟)。
    //   装配只有一处实现: `applyRunModelConfigToRuntime` → `installRuntime` (这里不自己 initMinimax)。
    if (modelDrift && (modelDrift.drifted || !modelDrift.verified)) {
      try {
        const { applyRunModelConfigToRuntime } = await import('../llm/model-selection.js');
        modelApplied = await applyRunModelConfigToRuntime(modelDrift.snapshot);
        console.log(`[pi-sdk] 已按 Run 快照装配运行时: ${modelApplied.provider}/${modelApplied.model} (configHash ${String(modelApplied.configHash).slice(0, 12)})`);
      } catch (e) {
        // 装配失败不阻塞恢复 (如实说; 调用方可以从返回值里看出没装成)
        console.warn('[pi-sdk] 按 Run 快照装配运行时失败, 保持当前运行时:', String((e as Error)?.message || e).slice(0, 160));
      }
    }
    this.resumeRunId = runId;
    this.resumePlan = prep.plan;
    this.actor!.state.goalBinding = prep.plan.goalId || this.actor!.state.goalBinding;
    try {
      const reply = await this.prompt(buildResumeInstruction(prep.plan), {});
      return { ok: true, reply, ...(modelDrift ? { modelDrift } : {}), ...(modelApplied ? { modelApplied } : {}) };
    } finally {
      this.resumeRunId = '';
      this.resumePlan = null;
    }
  }

  /**
   * 2026-10-02 (K7): 把**本会话的 Harness 判定**包成 skill 门, 供 `BollharnessIntegration.setSkillGuard` 注入。
   * - 只返回**判定**, 不执行 skill ⇒ "允许后执行"留在 SkillAdapter 的**唯一**执行点 (恰一次)。
   * - 身份 (runId/goalId/agentId/channelId/surface) 由 `harnessCtx()` 带齐。
   * - 不在这里 catch: 门面抛错由 adapter 侧 **fail-closed** 处理 (拒执行, 绝不回落 registry)。
   */
  createSkillGuard(): (name: string, params: Record<string, unknown>) => Promise<{ allow: boolean; reason?: string; rejectedBy?: string }> {
    return async (name, params) => {
      const decision = await this.piHarness().beforeToolCall({
        tool: `skill:${name}`,
        args: params,
        ctx: this.harnessCtx(),
        permissionMode: this.currentPermissionMode,
      });
      return {
        allow: decision.allow,
        reason: decision.reason,
        rejectedBy: decision.rejectedBy || decision.source,
      };
    };
  }

  private piHarness(): PiAgentHarness {
    if (!this._harness) {
      this._harness = new PiAgentHarness({
        reactHarness: this.reactHarness,
        denyPipeline: this._denyPipeline,
        hooks: this._hooks,
        // pre-tool-validator 4 步链 (modeGate/blacklist/shell-guard/schema), 经 human-value-pipeline 包装
        preToolUse: async (o) => onPreToolUse({ tool: o.tool, args: o.args, permissionMode: o.permissionMode as any }),
        // 事件写 Run: 观测级 (记账失败不改变已做出的决策)
        events: (e) => { if (this.actor!.state.activeRun) void recordHarnessEvent(this.actor!.state.activeRun, e); },
      });
    }
    return this._harness;
  }

  /** 每个生命周期事件都带上的运行身份 (runId / goalId / agentId / channelId / surface) */
  private harnessCtx(): HarnessRunContext {
    return {
      runId: this.actor!.state.activeRun || undefined,
      goalId: this.actor!.state.goalBinding || undefined,
      agentId: this.actor!.state.agentId || undefined,
      channelId: this.actor!.state.channelId || undefined,
      surface: this.runSurface,
    };
  }

  /**
   * 回合收尾的**受门类型自检** (K7 → K4-B 抽成方法)。
   *
   * 为什么必须抽出来: 它原先**只写在老 `runReActLoop` 之后** —— 而生产里 web 走的是 pivot 路径
   * (`usePivotLoop: true`, `promptWithPivotLoop` 提前 return) ⇒ 这条"系统自检过门"在**生产根本没触发过**。
   * 抽成方法后两条 loop 路径都调它 (一次一轮, 由 `typecheckRanThisTurn` 保证)。
   */
  private async runTurnEndTypecheck(): Promise<void> {
        // 2026-10-01: **本回合改过 TS ⇒ 收尾自动类型检查** (一轮一次) —— 复用已有的 tsc_check 工具
        if (decideTypecheck(this.tsTouchedThisTurn, this.typecheckRanThisTurn)) {
          this.typecheckRanThisTurn = true;
          try {
            const tscTool: any = this.tools.get('tsc_check');
            if (tscTool?.execute) {
              // 2026-10-02 (K7): **系统自检也过门** —— 统一成"任何工具执行都走同一扇 Harness 门"。
              //   这里不是模型发起的工具调用 (args 恒空, 是本回合改过 TS 后的收尾自检), 所以**更**不能例外:
              //   例外一旦靠"没人知道它绕过"活着, 门就不再是唯一的执行咽喉。
              //   语义: 被拒或门抛错 ⇒ **不执行** (fail-closed), 且**可见**地报出来 (拒绝不许静默)。
              let tscAllowed = true;
              let tscWhy = '';
              try {
                const d = await this.piHarness().beforeToolCall({
                  tool: 'tsc_check',
                  args: {},
                  ctx: this.harnessCtx(),
                  permissionMode: this.currentPermissionMode,
                });
                tscAllowed = d.allow;
                tscWhy = d.reason || d.rejectedBy || '';
              } catch (gateErr) {
                tscAllowed = false;
                tscWhy = `harness-error: ${String((gateErr as Error)?.message || gateErr)}`;
              }
              if (!tscAllowed) {
                this.runCtx.eventSink?.({ type: 'status', content: `🔎 类型检查被门拒绝, 未执行: ${tscWhy.slice(0, 120)}`, tool: 'system' } as any);
              } else {
                const r: any = await tscTool.execute({});
                const line = formatTypecheckResult(r?.success !== false && !/error TS\d+/.test(String(r?.output || '')), String(r?.output || ''));
                this.runCtx.eventSink?.({ type: 'status', content: `🔎 ${line}`, tool: 'system' } as any);
              }
            }
          } catch (e: any) {
            this.runCtx.eventSink?.({ type: 'status', content: `🔎 类型检查没能跑起来: ${String(e?.message || e).slice(0, 100)} (改动已落盘, 记得自己跑一次)`, tool: 'system' } as any);
          }
          this.tsTouchedThisTurn = [];
        }
  }

  private async runReActLoop(onStream?: StreamCallback, signal?: AbortSignal): Promise<{ reply: string; aiFailed: boolean; aiFailureReason?: string }> {
    const llm = getMinimax();
    let iteration = 0;
    let finalResponse = '';
    let lastQualityScore = 0;
    let refineAttempts = 0;
    let consecutiveErrors = 0;
    // 2026-06-16 新增: 累计错误数 (跨工具, 兜底防 LLM 轮换工具名死循环)
    let totalErrors = 0;
    let lastFailedTool = ''; // 跟踪最近一次失败的 tool name
    let lastFailedToolCount = 0; // 最近失败工具的连续失败次数
    // 2026-06-16: AI sentinel 标志 — runReActLoop 返回 aiFailed=true,
    //   promptStream 据此自动重跑整个 loop 最多 N 次 (不是单次 LLM 重试)
    let aiFailed = false;
    let aiFailureReason = '';
    const MAX_CONSECUTIVE_ERRORS = 3;
    // 同一工具连续失败 3 次, 强制让 LLM 给出最终答案 (模块级常量 MAX_SAME_TOOL_FAILURES 也用它做熔断)
    // 2026-07-29: Hermes 风格硬限制 — 防死循环 (不再靠 soft hint)
    const MAX_IDEMPOTENT_TOOL = 5;  // 同工具成功调 5 次 → 注入 hint 强制 final gen
    const MAX_TOOL_CALLS_PER_LOOP = 25; // 单轮循环总工具调用上限 → 注入 hint
    let totalToolCallsThisLoop = 0;
    const lastNTools: string[] = []; // 最近 MAX_IDEMPOTENT_TOOL 次工具名, 检测重复
    // 2026-10-01: 工具停滞观测状态 (分类 + 温和引导 + 重复结果引用) —— 见 agents/tool-loop-guard.ts
    //   与上面的"同工具 5 次就提示"不同: 它按 (工具名 + 参数 + 结果) 签名判定, 并抓 A→B→A→B 的循环
    const stallState = new LoopStallState();
    // 2026-08-10: unreported 循环逃生门 — LLM 反复不把工具结果写进回复时, 3 次后强制 final (不死板)
    const MAX_UNREPORTED_RETRIES = 3;
    let unreportedRetries = 0;
    // 2026-08-10: 工具失败时的终端逃生引导 (shell_exec 白名单命令可诊断环境/推进任务)
    const SHELL_ESCAPE_HINT = ' [逃生] 若工具无法响应/报错, 可用 shell_exec 跑终端命令诊断 (白名单: ls/cat/head/tail/pwd/git status/npm run test 等), 或调整参数换一种方式完成; 不要重复调用同一失败工具.';

    // 2026-08-08: final 前 review 续跑 — 目标对齐 + 需求深挖 (见 loop-review.ts)
    //   不潦草收尾: LLM 想 <final gen> 时先跑 1-2 次 review, 达成用户需求才放行.
    //   上限=2 次 (用户要求"运行一两次"), 结束后按用户需求为准.
    let loopReviewCount = 0;
    const loopReviewCompletedTools = new Set<string>();
    // 2026-08-09: 本轮行动日志 — 每轮工具执行都记录 (args + 结果摘要),
    //   final 前 review 用逐条核查目标; 也注入 system prompt 让 LLM 看到连续进度
    //   (防"每轮都像重启" — 之前 LLM 看不到自己已完成什么, 容易重复 react)
    const loopActionLog: { tool: string; argsPreview: string; resultPreview: string; success: boolean }[] = [];

    // 发送循环开始的事件
    if (onStream) {
      onStream({ type: 'status', internal: true, content: '🔄 开始 ReAct 循环...', tool: 'system' });
    }

    // React Harness: 循环开始 (重置 turn 计数 + 触发 harness sessionStart)
    // 失败静默 (fail-open), 不阻塞主循环
    // 2026-09-16 (Milestone 1-B): 会话开启走唯一门面 (react-harness 8-gate 复位 + hooks onLoopStart)
    await this.piHarness().sessionStart(this.harnessCtx());

    // 2026-09-16: 持久化 run harness — 本次运行立即落盘 (~/.bolloon/runs/<id>.json)。
    //   之后每步工具调用都追加一条, 所以刷新页面/进程重载/崩溃都能看到"做到哪一步"。
    let runStopReason = '';
    // 2026-09-16 (Milestone 1): 持久化硬约束 —— 核心 run 状态写不进去时, 运行必须停。
    //   理由: "agent 实际跑了但没记录" 比 "agent 没跑" 更危险 (UI 显示旧状态/重启后无从知晓/结果可能被错标 done)。
    let runPersistenceFailure = '';
    /** 2026-09-16 (M3): 熔断/需要人处置 → 收尾落 needs_human (不是 done, 也不是普通 failed) */
    let runNeedsHuman = '';
    /** 2026-09-16 (M5): 外部 (CLI/Web) 把 run 改成 paused/aborted → 如实停, 不再覆盖它的状态 */
    let runExternallyPaused = false;
    let runExternallyAborted = false;
    this.runPersistenceBlocked = false;
    this.breakerReason = '';
    this.awaitingExternal = false;

    if (this.resumeRunId) {
      // ── 恢复模式: 复用原来的 runId, 不新建 run (历史保留) ──
      this.actor!.state.activeRun = this.resumeRunId;
      this.lastRunId = this.resumeRunId;
      try {
        await markRunRunning(this.actor!.state.activeRun);
      } catch (err) {
        runPersistenceFailure = `恢复时状态迁移失败 (recovering → running): ${String((err as Error)?.message || err).slice(0, 180)}`;
      }
      const doneN = this.resumePlan?.completedSteps.length ?? 0;
      const guards = this.resumePlan?.replayGuards.length ?? 0;
      onStream?.({ type: 'status', internal: true, content: `♻️ 从 checkpoint 恢复运行 ${this.actor!.state.activeRun} (已完成 ${doneN} 步, 非幂等重放守卫 ${guards} 条)`, tool: 'harness' });
    } else {
      // 2026-09-16 (M2): 目标绑定 —— 有 goalId 就在该 Goal 下执行; 没有就建 Goal 再建 Run。
      //   延续规则 (确定性, 不靠猜): 该 channel/agent 上已有 open/active Goal, 且它的上一次执行**没收尾**
      //   (interrupted/stalled/needs_human/paused/awaiting_external/recovering) → 继续该 Goal; 否则新建。
      let boundGoalId = this.actor!.state.goalBinding;
      if (!boundGoalId) {
        try {
          const active = await findActiveGoal({ channelId: this.actor!.state.channelId || undefined, agentId: this.actor!.state.agentId || undefined });
          if (active?.currentRunId) {
            const prev = await readRun(active.currentRunId);
            const unfinished = prev && ['interrupted', 'stalled', 'needs_human', 'paused', 'awaiting_external', 'recovering'].includes(prev.status);
            if (unfinished) boundGoalId = active.goalId;
          }
        } catch (err) { console.warn('[PiAgent] 查找进行中 Goal 失败 (按新建处理):', (err as Error)?.message); }
        if (!boundGoalId) {
          try {
            const g = await createGoal({
              objective: this.currentUserInput || '(未记录目标)',
              channelId: this.actor!.state.channelId || undefined,
              agentId: this.actor!.state.agentId || undefined,
              createdBy: this.runSurface,
            });
            boundGoalId = g.goalId;
          } catch (err) { console.warn('[PiAgent] 创建 Goal 失败 (无目标也要有运行记录):', (err as Error)?.message); }
        }
        this.actor!.state.goalBinding = boundGoalId;
      }

      try {
        const rec = await startRun({
          surface: this.runSurface,
          goal: this.currentUserInput || '(未记录目标)',
          goalId: boundGoalId || undefined,
          channelId: this.actor!.state.channelId || undefined,
          agentId: this.actor!.state.agentId || undefined,
          modelConfig: await this.runModelSnapshot(),
        });
        this.actor!.state.activeRun = rec.runId;
        this.lastRunId = rec.runId;
        this.actor!.state.goalBinding = rec.goalId || this.actor!.state.goalBinding;
        if (this.actor!.state.goalBinding) {
          // Run → Goal 反查链: runId → goalId → objective / success criteria
          await attachRun(this.actor!.state.goalBinding, rec.runId).catch((err) => console.warn('[PiAgent] attachRun 失败:', (err as Error)?.message));
        }
        onStream?.({ type: 'status', internal: true, content: `🧷 运行已登记 (run=${rec.runId}${this.actor!.state.goalBinding ? `, goal=${this.actor!.state.goalBinding}` : ''}, 预算 ${rec.budget.maxSteps} 步 / ${Math.round(rec.budget.deadlineMs / 60000)} 分钟)`, tool: 'harness' });
      } catch (err) {
        // 核心写失败: 不再 warn 后继续 —— 没有运行记录就不执行 (strict 模式默认如此)
        runPersistenceFailure = `无法创建运行记录: ${String((err as Error)?.message || err).slice(0, 200)}`;
        this.runPersistenceBlocked = true;
        console.error('[PiAgent] run-store startRun 失败 (核心持久化) → 拒绝无记录执行:', runPersistenceFailure);
        onStream?.({ type: 'error', content: `⛔ ${runPersistenceFailure} — 已停止 (不在没有记录的情况下执行)`, tool: 'harness' });
      }
    }

    while (iteration < this.MAX_REACT_ITERATIONS) {
      iteration++;

      // 2026-09-16 (Milestone 1): 持久化失败硬闸 —— 到这一层说明记录已经不可信, 继续跑就是"无约束执行"
      if (runPersistenceFailure || this.persistenceFailure) {
        runPersistenceFailure = runPersistenceFailure || this.persistenceFailure;
        this.runPersistenceBlocked = true;
        aiFailed = true;
        aiFailureReason = aiFailureReason || runPersistenceFailure;
        finalResponse = finalResponse || `❌ 运行已停止: ${runPersistenceFailure}\n\n(运行记录无法写入/校验, 按协议停在 needs_human, 不假装完成)`;
        break;
      }

      // 2026-09-16 (M3): 熔断硬闸 —— 同一工具连续失败达上限后, 不许再"自动重试成功"式地把运行放活
      if (this.breakerReason) {
        runNeedsHuman = this.breakerReason;
        aiFailed = true;
        aiFailureReason = aiFailureReason || this.breakerReason;
        finalResponse = finalResponse || `❌ 已熔断: ${this.breakerReason}\n\n(重复失败不再重试, 按协议停在 needs_human 交人处置)`;
        break;
      }

      // 2026-09-16: 预算闸门 (持久化 harness 的约束面) —— 到点必须**如实**终止, 不许静默算完成
      if (this.actor!.state.activeRun) {
        try {
          const rec = await readRun(this.actor!.state.activeRun);
          if (!rec) throw new Error(`运行记录读不到: ${this.actor!.state.activeRun}`);
          // 2026-09-16 (M5): 外部控制面 (CLI /pause /abort, Web API) 改过状态 → 如实停在那儿。
          //   不覆盖成 done/failed: 人按下暂停就是暂停, 人按下中止就是中止。
          if (rec.status === 'paused' || rec.status === 'aborted') {
            runExternallyPaused = rec.status === 'paused';
            runExternallyAborted = rec.status === 'aborted';
            runStopReason = `外部请求: ${rec.status}`;
            onStream?.({ type: 'error', content: `⏹️ 运行被外部${rec.status === 'paused' ? '暂停' : '中止'} (run=${this.actor!.state.activeRun})`, tool: 'harness' });
            finalResponse = finalResponse || `(运行已${rec.status === 'paused' ? '暂停' : '中止'})`;
            break;
          }
          const verdict = budgetVerdict(rec);
          if (verdict.exceeded) {
            runStopReason = verdict.reason || '运行预算用尽';
            onStream?.({ type: 'error', content: `⛔ 运行预算用尽: ${runStopReason} (已如实终止, 不假装完成)`, tool: 'harness' });
            finalResponse = finalResponse || `(运行预算用尽: ${runStopReason})`;
            break;
          }
        } catch (err) {
          // 预算闸门读不到状态 = 约束失效, 不能"当作没超预算"继续跑
          runPersistenceFailure = `预算闸门无法校验运行状态: ${String((err as Error)?.message || err).slice(0, 200)}`;
          this.runPersistenceBlocked = true;
          console.error('[PiAgent] run-store 预算检查失败 (核心持久化):', runPersistenceFailure);
          onStream?.({ type: 'error', content: `⛔ ${runPersistenceFailure} — 已停止`, tool: 'harness' });
          break;
        }
      }

      // 停止条件 1: max turns (fail-safe 10000, 正常任务永远跑不到)
      //   2026-07-01 (v0.2.4 子任务 1): 委托给 react-loop.decideMaxIterations 纯函数
      // 2026-10-01 (落实②: 可退还的迭代预算): 惩罚零碎调用, **奖励批处理** ——
      //   程序化工具(execute_code, 一次能顶多次)调用后归还一次迭代 ⇒ 有效寿命被延长。
      //   退出条件仍由 decideMaxIterations 决定(读**净**用量), 不做硬刹车。
      if (iteration === 0 || !this.iterBudget) this.iterBudget = new IterationBudget(this.MAX_REACT_ITERATIONS);
      const iterBudget = this.iterBudget;
      iterBudget.consume();
      if (iterBudget.warn(0.8) && !this.iterBudgetWarned) {
        this.iterBudgetWarned = true;
        onStream?.({ type: 'status', internal: true, content: `⏳ 迭代预算已用 ${iterBudget.describe()} (批量工具会退还)` });
      }
      const maxIterDecision = decideMaxIterations(iterBudget.used, iterBudget.maxTotal);
      if (maxIterDecision.shouldExit) {
        console.warn(`[PiAgent] 达到最大循环数 ${this.MAX_REACT_ITERATIONS}, 强制终止 (fail-safe)`);
        onStream?.({ type: 'error', content: `⏹️ 达到最大循环数 (${this.MAX_REACT_ITERATIONS}, fail-safe)`, tool: 'loop' });
        finalResponse = finalResponse || maxIterDecision.finalAnswer;
        break;
      }

      // 停止条件 2: signal.aborted (显式 abort / 用户中断)
      if (signal?.aborted) {
        console.warn('[PiAgent] runReActLoop aborted by signal');
        onStream?.({ type: 'error', content: '⏹️ 用户中断', tool: 'loop' });
        finalResponse = finalResponse || '(用户中断)';
        break;
      }

      // 2026-07-29: Hermes 风格硬限制 (idempotent tool / total call cap)
      if (totalToolCallsThisLoop >= MAX_TOOL_CALLS_PER_LOOP) {
        console.warn(`[PiAgent] 单轮工具调用已达 ${MAX_TOOL_CALLS_PER_LOOP}, 注入 hint 让 LLM 总结`);
        onStream?.({ type: 'error', content: `⏹️ 工具调用已达上限 (${MAX_TOOL_CALLS_PER_LOOP}), 请基于已有结果回答`, tool: 'loop' });
        this.pushHistory({ role: 'system', content: `[注意] 你已连续调用 ${MAX_TOOL_CALLS_PER_LOOP} 次工具。请基于已有结果直接回答用户, 不要再次调用任何工具。在回答末尾加 <final gen> 标记结束。` });
        totalToolCallsThisLoop = 0;  // 重置计数器, 只防连续死循环
      }
      if (lastNTools.length >= MAX_IDEMPOTENT_TOOL && new Set(lastNTools).size === 1) {
        const repeatedTool = lastNTools[0];
        console.warn(`[PiAgent] 同工具 ${repeatedTool} 连续成功调 ${MAX_IDEMPOTENT_TOOL} 次, 注入 hint 让 LLM 总结`);
        onStream?.({ type: 'error', content: `⏹️ 工具 ${repeatedTool} 重复调用 ${MAX_IDEMPOTENT_TOOL} 次, 请基于已有结果回答`, tool: 'loop' });
        this.pushHistory({ role: 'system', content: `[注意] 你已连续 ${MAX_IDEMPOTENT_TOOL} 次调用 ${repeatedTool}。请基于已有结果直接回答用户, 不要再次调用任何工具。在回答末尾加 <final gen> 标记结束。` });
        lastNTools.length = 0;  // 重置计数器
        // 不 break — 让 LLM 在下一轮用已有信息回答
      }

      // 2026-06-16 新增: 累计错误兜底 — 跨工具, 防 LLM 轮换工具名绕过 MAX_SAME_TOOL_FAILURES
      if (totalErrors >= this.MAX_TOTAL_ERRORS) {
        console.warn(`[PiAgent] 累计错误 ${totalErrors} >= ${this.MAX_TOTAL_ERRORS}, 强制终止 (防死循环)`);
        onStream?.({ type: 'error', content: `⛔ 累计 ${totalErrors} 次错误, 强制终止 (防止 LLM 死循环)`, tool: 'loop' });
        // 2026-06-19: 即使 LLM 一直失败, 也汇总之前成功执行的 tool result 给用户
        if (this.successfulToolResults.length > 0) {
          finalResponse = `✅ 之前步骤成功执行了 ${this.successfulToolResults.length} 个工具 (但 LLM 后续 ${totalErrors} 次调用失败):\n` +
            this.successfulToolResults.map((r, i) => `  ${i+1}. ${r.tool}: ${r.outputPreview}`).join('\n') +
            `\n\n⚠️ (LLM 连续失败, 可能是上游限流/网络问题, 工具已成功执行但 LLM 没能继续总结)`;
        } else {
          finalResponse = finalResponse || `(本轮 ReAct 循环累计 ${totalErrors} 次错误, 强制结束。请换个思路或简化任务重试。)`;
        }
        break;
      }

      // 2026-06-16 新增: loop 内自动压缩 — token 超 80% 阈值时跑一次
      // compact 失败走 C 路径: 不强行 break, 让现有 60K 阈值兜底 (后面有检查)
      //   2026-07-01 (v0.2.4 子任务 1): 触发判定走 shouldCompactBeforeIteration 纯函数
      const compactThreshold = this.maxContextTokens() * this.LOOP_COMPACT_RATIO;
      const estimatedTokensBefore = this.estimateHistoryTokens();
      // 2026-08-06: 每轮上报 usage 到 ContextManager (CLI/Web 状态栏数据源, warning 事件触发点)
      getContextManager().updateUsage(estimatedTokensBefore);
      if (shouldCompactBeforeIteration(estimatedTokensBefore, compactThreshold)) {
        const tokensBeforeCompact = estimatedTokensBefore;
        console.log(`[PiAgent] loop 入口 token ${tokensBeforeCompact} > ${compactThreshold}, 触发自动压缩`);
        onStream?.({ type: 'status', internal: true, content: `🗜️ loop 自动压缩 (token ${tokensBeforeCompact} > ${compactThreshold})`, tool: 'compactor' });
        try {
          await this.maybeAutoCompact(onStream, signal);
        } catch (compactErr) {
          // C 路径: compact 失败不 break, 让 token 阈值检查兜底
          console.warn(`[PiAgent] loop 内 maybeAutoCompact 失败 (non-fatal, 继续走 token 阈值):`, compactErr);
        }
      }

      // 停止条件 3: context overflow (compact 后还超, 强制终止)
      //   2026-07-01 (v0.2.4 子任务 1): 委托给 react-loop.decideContextOverflow 纯函数
      const estimatedTokens = this.estimateHistoryTokens();
      const overflowDecision = decideContextOverflow(estimatedTokens, this.maxContextTokens());
      if (overflowDecision.shouldExit) {
        console.warn(`[PiAgent] context overflow (${estimatedTokens} tokens > ${this.maxContextTokens()})`);
        onStream?.({ type: 'error', content: `⏹️ 上下文溢出 (${estimatedTokens} tokens, 阈值 ${this.maxContextTokens()})`, tool: 'loop' });
        finalResponse = finalResponse || overflowDecision.finalAnswer;
        break;
      }

      // 调试日志：显示每次循环开始
      console.log(`[PiAgent] 循环 ${iteration}/${this.MAX_REACT_ITERATIONS} 开始`);
      if (onStream) {
        onStream({ type: 'status', internal: true, content: `🔄 循环 ${iteration}/${this.MAX_REACT_ITERATIONS}`, tool: 'loop' });
      }

      const context = this.buildContext();
      // M3.5 (2026-06-17): 也构造 messages 数组版本, 让 LLM 看到结构化 tool 角色
      //   buildContext() 把 history 序列化成字符串 — LLM 看不到 tool 调用的真实结果
      //   新版用 messages 数组直接喂给 LLM, 保留 role 语义 (user/assistant/tool/system)
      const messages = this.buildMessages();
      const toolDefs = this.getToolDefinitions();

      // 动态构建 refine 上下文
      let refineContext = '';
      if (refineAttempts > 0 && lastQualityScore < this.QUALITY_THRESHOLD) {
        refineContext = `\n【改进提示】上轮结果质量分 ${(lastQualityScore * 10).toFixed(1)}/10，请改进回答。`;
      }

      // 连续错误时的额外提示
      if (consecutiveErrors > 0) {
        refineContext += `\n【错误提示】上轮发生 ${consecutiveErrors} 次错误，请重新分析问题或换一种方式处理。`;
      }

      // M2.4: persona section 缓存 — persona 在 loadPersona() 时一次设定, 此后不变
      if (!this.cachedPersonaSection && this.persona) {
        this.cachedPersonaSection = `
角色描述: ${this.persona.description || '无'}
性格特点: ${this.persona.personality || '无'}
问候语: ${this.persona.greeting || '无'}
`;
      }
      const personaSection = this.cachedPersonaSection;

      // 2026-08-09: 循环进度段 — 让 LLM 看到本轮已完成的动作 (连续进度, 不重启)
      //   Hermes 式 Agent Runtime: 循环是状态机, LLM 每次看到的是"第 N 步 + 已完成 X"
      //   (之前每轮都是全新上下文, LLM 不知道做过什么 → 重复 react / 衔接差)
      let loopProgressSection = '';
      if (loopActionLog.length > 0) {
        const actionLines = loopActionLog
          .map((a, i) => {
            const args = a.argsPreview ? `(${a.argsPreview.slice(0, 60)})` : '';
            const res = a.success ? '✓' : '✗';
            return `  ${i + 1}. ${res} ${a.tool}${args}`;
          })
          .join('\n');
        loopProgressSection = `\n【本轮循环进度】你已完成以下 ${loopActionLog.length} 个动作, 这是连续执行的同一轮任务:\n${actionLines}\n请基于已有结果继续推进, 不要重复执行上面已成功的动作. 全部完成后用 <final gen> 结束.\n`;
      }

      // 2026-09-28 (前缀 KV 可命中): `refineContext` / `loopProgressSection` 是**每轮都在变**的段
      //   (质量分 / 连续错误数 / 本轮已完成动作). 留在 system 里 = 每轮把 IMMUTABLE PREFIX 打碎 =
      //   服务端前缀 KV 永远 miss. 移到 CURRENT TURN 区 (注入到最后一条 user 前部) —— 文本一字未改, 只换位置.
      const currentTurnContext = `${refineContext}${loopProgressSection}`;

      const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${personaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})
${this.currentIntentHint}

${toolDefs}

${PiAgentSession.TOOL_SELECTION_GUIDE}

${PROACTIVE_WORK_DISCIPLINE}

${await this.renderActivePlansSection()}

工作模式:
1. 理解用户自然语言请求
2. 分析需要哪些工具来完成
3. 按顺序调用工具并观察结果
4. 根据观察结果决定下一步
5. 最终给出完整回答

重要:
- 每次只调用一个工具
- 仔细分析工具返回结果
- 当任务完成时，必须在回答末尾添加 <final gen> 标记表示结束
- 如果需要更多信息，继续调用工具${this.judgmentGateAddition}${this.contextHintAddition}`;

      // 3 个恢复机制 (Claude Code 论文 9-step pipeline 内部):
      //   1. max output token 升级 (最多 3 次, 每次 maxOutputTokens 翻倍)
      //   2. reactive compaction (prompt 估算超阈值, 跑压缩)
      //   3. prompt-too-long (LLM 报错 4xxx token 错误, 跑 reactive compaction 再试 1 次)
      // 失败静默: 全部重试失败 → 空 reply (上层用 no tool_use 终止)
      // Bug 5: pass tool IDs for native OpenAI tool calling — 2026-07-29: 过滤拒绝工具
      const toolIds = Array.from(this.tools.keys()).filter(n => !this._deniedToolNames.has(n));
      // 2026-07-29: 从 this.tools Map 生成 OpenAI 原生 tools 格式 (含参数 schema)
      const openaiFormattedTools: any[] = [];
      for (const [name, tool] of this.tools) {
        if (this._deniedToolNames.has(name)) continue;
        const params = (tool as any).parameters || {};
        const properties: Record<string, any> = {};
        const required: string[] = [];
        for (const [pName, pDesc] of Object.entries(params)) {
          properties[pName] = { type: 'string', description: String(pDesc) };
          if (String(pDesc).includes('必填')) required.push(pName);
        }
        openaiFormattedTools.push({
          type: 'function',
          function: {
            name,
            description: (tool as any).description || name,
            parameters: { type: 'object', properties, required },
          },
        });
      }
      // 2026-09-16 (Milestone 1-B): 模型调用前后走唯一门面 (扩展点 + 计数留痕; 默认不加新 hook 事件, 避免改变现有触发次数)
      this.piHarness().beforeModelCall(this.harnessCtx());
      const _modelCallT0 = Date.now();
      const response = await this.callLlmWithRecovery(llm, messages, systemPrompt, signal, onStream, openaiFormattedTools, currentTurnContext);
      // 2026-09-28 (前缀 KV 可命中): 把注入了 CURRENT TURN 的当前轮**原样写回自己的 messageHistory** ——
      //   buildMessages() 每轮重建全新对象, 不写回的话下一轮那条 user 就退回注入前, 前缀从那里分叉.
      //   用 chat() 回带的 wire (真正发出去的那一份), 而不是把 messages 再拼一遍.
      this.writeBackCurrentTurn(response.messages);
      this.piHarness().afterModelCall(this.harnessCtx(), { ms: Date.now() - _modelCallT0 });
      const reply = (response.reply || '').trim();
      // 2026-06-30: OpenAI 协议 native tool_calls (LLM 真产了 tool_call 时, minimax/M3 会返回 id)
      const nativeToolCalls = response.toolCalls;

      // 2026-06-19 架构 fix: 不再因 [AI 服务调用失败] break
      //   旧逻辑: sentinel → aiFailed=true → break → 外层 retry 整个 loop (重置 history)
      //   新逻辑: 把错误当 tool_result push 进 history → 下一轮 LLM 看到错误能反思重试
      //   这是 dive-into 文档的"fail-open error recovery" — 错误进入 context, 不让 LLM 重复犯同样错
      // 2026-07-06: 对不可恢复的 API 错误直接终止, 不再无限重试
      if (reply.startsWith('[AI 服务调用失败]')) {
        console.log(`[PiAgent] 收到 AI 错误 sentinel`);
        console.log(`[sentinel DEBUG] 完整 reply: ${reply}`);
        console.log(`[sentinel DEBUG] 上一轮 messages 数量: ${Array.isArray(messages) ? messages.length : 'N/A'}, systemPrompt 长度: ${systemPrompt.length}`);
        aiFailureReason = reply.length > 200 ? reply.substring(0, 200) : reply;
        totalErrors++;
        consecutiveErrors++;

        // 2026-07-06: 检测不可恢复的 API 错误 — 这些错误 LLM 无法通过反思修复, 重试无意义
        const isFatalApiError =
          reply.includes('chat content is empty') ||
          reply.includes('invalid params') ||
          reply.includes('401') ||
          reply.includes('403') ||
          reply.includes('quota') ||
          reply.includes('rate limit') ||
          reply.includes('API key') ||
          reply.includes('authentication') ||
          reply.includes('unauthorized');

        if (isFatalApiError) {
          console.log(`[PiAgent] 检测到不可恢复的 API 错误, 终止 loop: ${aiFailureReason}`);
          if (onStream) {
            onStream({ type: 'error', content: `⛔ API 错误无法恢复: ${aiFailureReason}`, tool: 'system' });
          }
          finalResponse = `❌ AI 服务调用失败: ${aiFailureReason}\n\n这是一个底层 API 错误, 不是任务本身的问题。请检查 API 配置或稍后重试。`;
          aiFailed = true;
          break;
        }

        // 连续错误过多也终止, 防止 LLM 陷入死循环
        if (consecutiveErrors >= 3) {
          console.log(`[PiAgent] 连续 ${consecutiveErrors} 次 AI 错误, 终止 loop`);
          if (onStream) {
            onStream({ type: 'error', content: `⛔ 连续 ${consecutiveErrors} 次 AI 错误, 终止循环`, tool: 'system' });
          }
          finalResponse = `❌ AI 连续调用失败 ${consecutiveErrors} 次, 已终止。\n\n失败原因: ${aiFailureReason}\n\n请检查 API 配置或简化任务后重试。`;
          aiFailed = true;
          break;
        }

        // 把错误当成 tool 结果 push 进 history, 这样下一轮 LLM 看到错误能调整
        this.pushHistory({
          role: 'system',
          content: `[Loop 错误恢复 ${totalErrors}/${this.MAX_TOTAL_ERRORS}] ${aiFailureReason}\n\n请基于上轮工具结果继续完成任务, 不要重复调用同一失败操作. 如果工具已成功执行, 请基于 result.output 给用户总结; 如果工具失败, 请换其他方式或重试.`
        });
        if (onStream) {
          onStream({ type: 'status', content: `⚠️ AI 调用失败 ${totalErrors}/${this.MAX_TOTAL_ERRORS}, 已 push 错误到 history 让 LLM 反思`, tool: 'system' });
        }
        // 退避 2s 后继续 — 临时上游限流避开, 不让 loop 终止
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
        // 关键: 不设 aiFailed=true, 让外层不重试整个 loop (重置 history), 继续内层循环
        continue;
      }

      console.log(`[PiAgent] LLM 回复长度: ${reply.length}, 内容预览: "${reply.substring(0, 80)}..."`);
      console.log(`[PiAgent] LLM 完整回复:\n${reply}`);

      // 通知前端：收到 LLM 回复 (2026-08-09: 不再截断 100 字符 — 前端流式渲染完整内容,
      //   配合 Hermes 式回复框: 加载中显示完整文本, 完成后封闭底框)
      if (onStream) {
        onStream({ type: 'token', content: reply });
      }

      // 2026-06-19 架构 fix: parseToolCall 优先于 isFinalResponse
      //   之前: 思考块里的 "<final gen>" 触发 isFinalResponse 提前 break, 工具从未真正执行
      //   现在: 先尝试解析 tool_call, 有就执行; 没有才检查是不是真正的 final gen
      // Bug 5 (2026-07-17): 优先用 LLM 的 native tool_calls (response.toolCalls), 再回退到文本解析
      //   deepseek-v4-flash 用 OpenAI 协议 tools 时, 会真返回结构化 tool_calls 数组
      //   之前 nativeToolCalls 被读了不用, 只查 reply 文本, 导致 LLM 明明选了工具但代码找不到
      // 2026-07-28: 修复多工具调用 — 收集 ALL tool calls, 顺序执行后一次性返回
      let toolCalls: ToolCall[] = [];

      // 路径 A: native OpenAI 协议 tool_calls (可能多个)
      if (nativeToolCalls && nativeToolCalls.length > 0) {
        for (const nc of nativeToolCalls) {
          try {
            const args = typeof nc.function?.arguments === 'string'
              ? JSON.parse(nc.function.arguments)
              : (nc.function?.arguments || {});
            toolCalls.push({
              name: nc.function?.name,
              args,
              id: nc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            } as any);
          } catch (err) {
            console.warn(`[PiAgent] 解析 native tool_call 失败: ${(err as Error).message?.slice(0, 100)}`);
          }
        }
      }

      // 路径 B: 文本解析 (parseAllToolCalls 收集全部)
      if (toolCalls.length === 0) {
        // 2026-09-26: 已知名集合 = 注册表原名 + 它们的 API 名 (净化后的).
        //   出网时工具面给的是 API 名 (见 pi-ai.ts 的唯一净化边界), LLM 在文本里
        //   回吐的也可能是 API 名 —— 只用原名集合过滤会把这类调用整个丢掉.
        const knownTools = expandKnownToolNames(this.tools.keys());
        toolCalls = parseAllToolCalls(reply, { tools: knownTools });
      }

      // 回退路径 C: 原生 parseToolCall (单个)
      if (toolCalls.length === 0) {
        const single = this.parseToolCall(reply);
        if (single) toolCalls.push(single);
      }

      // 2026-09-26: **回程派发的唯一还原点** —— LLM 回吐的是 API 名 (净化过的), 这里
      //   还原成注册表真名再交给 this.tools.get(); 原名 (LLM 照 system prompt 抄的) 原样穿透.
      for (const tc of toolCalls) {
        if (typeof tc.name === 'string' && tc.name) tc.name = resolveApiToolName(tc.name);
      }

      // 给每个 toolCall 分配稳定 id
      for (const tc of toolCalls) {
        if (!(tc as any).id) {
          (tc as any).id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }
      }

      if (toolCalls.length > 0) {
        // 把原始 LLM 回复 push 进 history (仅一次)
        this.pushHistory({
          role: 'assistant',
          content: reply,
          toolCalls: toolCalls.length > 1 ? toolCalls : [toolCalls[0]],
          // 2026-09-15: 思考模式思维链原样存回 (下一轮带 tools 的请求必须回带, 否则 deepseek 400)
          reasoningContent: (response as any)?.reasoningContent,
        });

        // 2026-08-09: 并发执行本轮所有工具 (Hermes 式 Agent Runtime: 一轮内多工具并行,
        //   一轮没跑完之前不中断 — 工具执行不检查 abort, 全部完成才 continue 下一轮)
        //   旧实现顺序 for 循环, 一个工具等一个, 慢; 且多工具时 LLM 要等全部串完才能看到结果.
        await Promise.all(toolCalls.map(async (toolCall, ti) => {
        const isMulti = toolCalls.length > 1;

        // 通知前端
        if (onStream) {
          onStream({ type: 'tool', content: `🔧 调用工具 (${ti + 1}/${toolCalls.length}): ${toolCall.name}`, tool: toolCall.name });
          if (toolCall.args && Object.keys(toolCall.args).length > 0) {
            onStream({ type: 'status', internal: true, content: `📋 参数: ${JSON.stringify(toolCall.args)}`, tool: toolCall.name });
          }
          onStream({
            type: 'step_start',
            content: `调用 ${toolCall.name}${isMulti ? ` (${ti + 1}/${toolCalls.length})` : ''}`,
            tool: toolCall.name,
            args: toolCall.args || {},
          });
        }

        const tool = this.tools.get(toolCall.name);
        if (!tool) {
          consecutiveErrors++;
          totalErrors++;
          const errorResult: ToolResult = { success: false, error: `未知工具: ${toolCall.name}` };
          this.pushHistory({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          // 2026-07-28: 注入 Reflection 帮助 LLM 理解错误
          const obs = buildObservation(toolCall.name, toolCall.args, errorResult);
          const ref = buildReflection(toolCall.name, errorResult.error, totalErrors, lastFailedToolCount);
          this.pushHistory({ role: 'system', content: formatObservationWithReflection(obs, ref) });
          if (onStream) onStream({ type: 'status', content: `💡 Reflection: ${obs.summary}`, tool: 'system' });
          console.warn(`[PiAgent] 未知工具: ${toolCall.name} (累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS})，跳过并继续`);
          return;
        }

        // 2026-09-16 (Milestone 1-B): 工具调用前的**唯一**约束入口。
        //   顺序由 PiAgentHarness 决定: deny-pipeline → pre-tool-validator(4 步链) → react-harness(8-gate)。
        //   旧实现是这三处在不同位置各自调用 (且有两条路径 fail-open); 现在 pi-sdk 不再散调任何 gate。
        let toolDecision: ToolDecision;
        try {
          toolDecision = await this.piHarness().beforeToolCall({
            tool: toolCall.name,
            args: toolCall.args || {},
            ctx: this.harnessCtx(),
            permissionMode: this.currentPermissionMode,
          });
        } catch (err) {
          // 门面自身抛错 = 核心约束失效 → fail-closed (不执行工具, 也不静默放行)
          toolDecision = {
            allow: false,
            source: 'harness-error',
            kind: 'core_constraint',
            reason: `Harness 门面异常: ${String((err as Error)?.message || err).slice(0, 150)}`,
          };
        }

        if (!toolDecision.allow) {
          const src = toolDecision.source || 'unknown';
          if (src === 'deny-pipeline') {
            // 旧 deny-pipeline 分支: 不计连续失败计数, 文案 "拒绝: [source] reason"
            consecutiveErrors++;
            totalErrors++;
            const denyResultMsg: ToolResult = { success: false, error: `拒绝: [${toolDecision.rejectedBy || 'deny-pipeline'}] ${toolDecision.reason}` };
            this.pushHistory({ role: 'tool', content: JSON.stringify(denyResultMsg), toolResult: denyResultMsg });
            this.logToHarness(toolCall.name, toolCall.args, denyResultMsg);
            return;
          }

          const isGateDeny = src === 'react-harness';
          const isHarnessError = src === 'harness-error';
          const deniedResult: ToolResult = {
            success: false,
            error: isGateDeny
              ? `Harness gate 拒绝 (${toolDecision.rejectedBy}): ${toolDecision.reason || '未通过安全校验'}`
              : `PreToolUse 拒绝: ${toolDecision.reason || '未通过安全校验'}`,
          };
          this.pushHistory({ role: 'tool', content: JSON.stringify(deniedResult), toolResult: deniedResult });
          this.logToHarness(toolCall.name, toolCall.args, deniedResult);
          if (onStream) {
            const gateName = isGateDeny ? `Harness ${toolDecision.rejectedBy}` : (isHarnessError ? '核心约束层' : 'PreToolUse');
            onStream({ type: 'error', content: `🛡️ ${gateName} 拒绝 ${toolCall.name}: ${toolDecision.reason || '安全校验失败'}`, tool: toolCall.name });
            onStream({ type: 'step_error', content: `${gateName} 拒绝 ${toolCall.name}`, tool: toolCall.name, error: toolDecision.reason || '安全校验失败' });
          }
          console.warn(`[PiAgent] 工具被拒 ${toolCall.name} (${src}${toolDecision.rejectedBy ? ':' + toolDecision.rejectedBy : ''}): ${toolDecision.reason}`);
          consecutiveErrors++;
          totalErrors++;
          if (toolCall.name === lastFailedTool) { lastFailedToolCount++; }
          else { lastFailedTool = toolCall.name; lastFailedToolCount = 1; }
          // 达到同一工具连续失败上限 / 连续错误上限时的引导语 (按拒绝来源保持原有文案)
          const systemMaxMsg = isGateDeny
            ? `[注意] 工具 ${toolCall.name} 被 Harness 拒绝 (连续 ${MAX_SAME_TOOL_FAILURES} 次). 请不要再次尝试, 末尾加 <final gen>.`
            : isHarnessError
              ? `[注意] 工具 ${toolCall.name} 的约束校验层失效, 已按 fail-closed 阻止 (连续 ${MAX_SAME_TOOL_FAILURES} 次). 请换其他工具或直接回答用户, 末尾加 <final gen>.`
              : `[注意] 工具 ${toolCall.name} 被系统拒绝 (连续 ${MAX_SAME_TOOL_FAILURES} 次). 请不要再次尝试, 直接用已有信息回答用户, 末尾加 <final gen>.`;
          const systemConsecMsg = isGateDeny
            ? `[注意] 连续 ${consecutiveErrors} 次工具调用被 Harness 拒绝. 请换其他工具或直接回答.`
            : isHarnessError
              ? `[注意] 连续 ${consecutiveErrors} 次工具调用因约束层失效被阻止. 请换其他工具或直接回答用户, 末尾加 <final gen>.`
              : `[注意] 连续 ${consecutiveErrors} 次工具调用被系统拒绝. 请换其他工具或直接回答用户, 末尾加 <final gen>.`;
          if (lastFailedToolCount >= MAX_SAME_TOOL_FAILURES) {
            this.pushHistory({ role: 'system', content: systemMaxMsg });
            lastFailedTool = ''; lastFailedToolCount = 0; consecutiveErrors = 0;
          } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.pushHistory({ role: 'system', content: systemConsecMsg });
            consecutiveErrors = 0;
          }
          return;
        }

        if (toolDecision.systemAddition) {
          this.contextHintAddition += '\n' + toolDecision.systemAddition;
        }

        try {
          const toolStart = Date.now();
          // 2026-09-16 (M2): 恢复重放守卫 —— 中断前**已成功执行过的非幂等动作**恢复后不再重做,
          //   直接复用当时的结果 (避免重复副作用: 重复写文件/重复提交/重复付款)。
          //   (M2-B: 守卫也覆盖"上一个 Run 已做过的非幂等动作" —— 跨 Run 续跑同样不许重做)
          let replaySkip: string | null = null;
          const guards = [
            ...(this.resumePlan?.replayGuards || []),
            ...(this.continuationGuards || []),
          ];
          if (guards.length) {
            const d = argsDigestOf(toolCall.args);
            const hit = guards.find((g) => g.tool === toolCall.name && (!g.argsDigest || !d || g.argsDigest === d));
            if (hit) replaySkip = hit.summary;
          }
          let result = replaySkip
            ? { success: true, output: `[恢复保护] ${toolCall.name} 在中断前已成功执行过, 本次不重复执行 (避免重复副作用)。当时结果: ${replaySkip}`, _replaySkipped: true } as ToolResult
            : await ((toolCall as any).__t0 = Date.now(), tool.execute(expandHomeArgs(toolCall.args)));
          const toolDurationMs = Date.now() - toolStart;
          if (replaySkip) {
            console.log(`[PiAgent] 恢复重放守卫: 跳过已完成的非幂等工具 ${toolCall.name}`);
            onStream?.({ type: 'status', internal: true, content: `🛡️ 恢复保护: ${toolCall.name} 此前已成功执行, 本次不重复执行`, tool: toolCall.name });
          }
          console.log(`[PiAgent] 工具 ${toolCall.name} 执行完成: success=${result.success} (${toolDurationMs}ms)`);

          // 2026-09-16 (M3): 失败接线 —— 分类 + recovery 留痕 + 熔断 / 外部等待
          if (!result.success && this.actor!.state.activeRun && !replaySkip) {
            await this.wireToolFailure(toolCall.name, String(result.error || ''), toolCall.args);
          } else if (result.success && this.actor!.state.activeRun && this.awaitingExternal) {
            // 外部回话了: awaiting_external → running (不是"恢复完成", 只是等待结束)
            this.awaitingExternal = false;
            await this.safeSetRunStatus(this.actor!.state.activeRun, 'running');
          }

          // 2026-09-16: 持久化 run harness — 每步工具调用立即落盘 (崩在这里也能看到做到哪步)
          if (this.actor!.state.activeRun) {
            try {
              await recordStep(this.actor!.state.activeRun, {
                tool: toolCall.name,
                ok: !!result.success,
                ms: toolDurationMs,
                args: toolCall.args,
                summary: String(result.output || '').slice(0, 200),
                error: result.error ? String(result.error) : undefined,
              });
            } catch (err) {
              // 核心写失败 → 本轮工具批跑完即停 (循环顶部硬闸), 不再 warn 后继续
              runPersistenceFailure = `工具步骤写盘失败 (${toolCall.name}): ${String((err as Error)?.message || err).slice(0, 200)}`;
              this.runPersistenceBlocked = true;
              console.error('[PiAgent] run-store recordStep 失败 (核心持久化):', runPersistenceFailure);
              onStream?.({ type: 'error', content: `⛔ ${runPersistenceFailure} — 本轮结束后停止`, tool: 'harness' });
            }
          }

          try { await onPostToolUse({ tool: toolCall.name, args: toolCall.args || {}, result: { success: result.success, output: result.output?.substring(0, 500), error: result.error }, durationMs: toolDurationMs }); }
          catch (postErr) { console.warn('[PiAgent] onPostToolUse failed (non-fatal):', postErr); }

          // 2026-09-16 (Milestone 1-B): 工具调用后的唯一入口 (router hint + 输出 gate 一起判定)
          const after = await this.piHarness().afterToolCall({
            tool: toolCall.name,
            output: String(result.output || ''),
            ctx: this.harnessCtx(),
            ok: !!result.success,
          });
          if (after.routeHint?.systemAddition) {
            this.pushHistory({ role: 'system', content: `[Harness Router Hint: ${after.routeHint.reason}]\n${after.routeHint.systemAddition}` });
          }
          if (after.outputBlocked) {
            if (onStream) { onStream({ type: 'error', content: `🛡️ Harness output 拒绝 ${toolCall.name}: ${after.outputBlocked.reason}`, tool: toolCall.name }); }
            console.warn(`[PiAgent] Harness output denied ${toolCall.name}: ${after.outputBlocked.reason}`);
            result = { ...result, output: `[harness output gate: 输出含敏感内容, 已屏蔽. 原因: ${after.outputBlocked.reason}]`, _harnessDenied: true } as typeof result;
          }

          // 2026-10-01: 落库前做一次停滞观测 —— 命中的是"引导/引用", 不是"拒绝执行":
          //   完全相同的返回从第 2 次起折叠成引用 (省上下文); 连续 3 次同参数同结果或检测到循环 ⇒
          //   在结果尾部追加一条系统提示 (保留模型的选择权, 不硬停 —— 硬停那条已被用户否决)。
          try {
            const obs = observeToolCall(stallState, {
              toolName: toolCall.name,
              sameSignatureBefore: this.lastToolSig === argsFingerprint((toolCall as any).args),
              args: toolCall.args,
              resultText: String(result.output || (result.success ? '' : String(result.error || ''))),
              ok: !!result.success,
              seenResultBefore: stallState.hasSeenResult(String(result.output || '')),
            });
            if (obs.stub) {
              result = { ...result, output: obs.stub, _stubbed: true } as typeof result;
            } else if (obs.notice) {
              result = { ...result, output: `${String(result.output || '')}\n\n${obs.notice}` } as typeof result;
            }
            if (obs.action === 'warn') {
              console.warn(`[PiAgent] 工具停滞引导 (${obs.code}, 第 ${obs.count} 次): ${toolCall.name}`);
              onStream?.({ type: 'status', internal: true, content: `🩺 检测到重复调用 ${toolCall.name} (${obs.code}), 已提示模型换法`, tool: 'loop' });
            }
          } catch { /* 观测失败绝不影响主路径 */ }
          this.pushHistory({ role: 'tool', content: JSON.stringify(result), toolResult: result, toolCallId: (toolCall as any).id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` });
          // 2026-10-01 (用户: 「为什么这么慢」): 量到的事实 —— 每次 LLM 往返平均 3338ms,
          //   而"一轮发多个工具"(toolCalls>1) 只占 12/63 ✗ ⇒ 回合时长 ≈ 往返次数 × 3.3 秒 ✓。
          //   本回合**第一次**且**只发一个**工具时, 附一句带代价的提醒(不是口号 ✓), 只提一次免得刷屏。
          if (toolCalls.length === 1 && this.successfulToolResults.length <= 1) {   // 本回合头一次(免得每轮刷屏)
            const __batchHint = batchHint(toolCall.name, 1);
            if (__batchHint) this.pushHistory({ role: 'system', content: __batchHint.trim() });
          }
          this.logToHarness(toolCall.name, toolCall.args, result);

          // 2026-08-09: 记录到本轮行动日志 (循环进度 + final 前目标核查用)
          //   去重: 同一工具同 args 连续成功只记一次 (防 LLM 重复 react 刷屏)
          const argsPreview = JSON.stringify(toolCall.args || {}).slice(0, 120);
          const isDup = loopActionLog.some(
            (a) => a.tool === toolCall.name && a.argsPreview === argsPreview && a.success === !!result.success
          );
          if (!isDup) {
            loopActionLog.push({
              tool: toolCall.name,
              argsPreview,
              resultPreview: result.success
                ? String(result.output || '(无输出)').slice(0, 200)
                : String(result.error || 'failed').slice(0, 200),
              success: !!result.success,
            });
          }

          if (onStream) {
            if (result.success) {
              onStream({ type: 'status', internal: true, content: `✅ ${toolCall.name} 执行成功`, tool: toolCall.name });
              if (result.output) { onStream({ type: 'tool', content: `📤 结果: ${result.output.substring(0, 200)}${result.output.length > 200 ? '...' : ''}`, tool: toolCall.name }); }
              onStream({ type: 'step_done', content: `${toolCall.name} 执行成功`, tool: toolCall.name, success: true, output: result.output });
            } else {
              onStream({ type: 'error', content: `❌ ${toolCall.name} 执行失败: ${result.error}`, tool: toolCall.name });
              onStream({ type: 'step_error', content: `${toolCall.name} 执行失败`, tool: toolCall.name, error: result.error });
            }
          }

          // 2026-10-01 (优化 #1/#3/#4): 工具结果的**进上下文闸** + **遥测** + **写操作读回自证**
          {
            const __ms = Date.now() - Number((toolCall as any).__t0 || Date.now());
            try {
              // #1 结果闸: 超上限 ⇒ 头尾 + 完整结果落文件(给路径) ⇒ 上下文不再被一条大输出长期占住
              const capped = capToolResult(String(result.output ?? ''), { tool: toolCall.name });
              if (capped.capped) {
                result.output = capped.text;
                console.warn(`[PiAgent] ${toolCall.name} 结果过长(${capped.originalChars})已截断` + (capped.spilledTo ? `, 完整内容: ${capped.spilledTo}` : ''));
              }
              // #4 写操作"读回自证": 写类工具成功后自动核一次(存在? 大小?) ⇒ "工具说成功≠任务成功"从规矩变成机制
              // 2026-10-01: 改了 TS 源码就记账 ⇒ 回合收尾自动跑类型检查 (把"靠自觉"变成机制)
              {
                const tsFile = codeWriteTarget(toolCall.name, (toolCall as any).args);
                if (tsFile && !this.tsTouchedThisTurn.includes(tsFile)) this.tsTouchedThisTurn.push(tsFile);
              }
              const verified = verifyWriteOutcome(toolCall.name, (toolCall as any).args, this.cwd);
              if (verified) result.output = `${String(result.output ?? '')}\n${verified}`;
              // #3 遥测: 记一行(工具/指纹/耗时/成败/结果大小/是否与上一次同签名) ⇒ 重复率可算
              recordToolCall({
                tool: toolCall.name,
                sig: argsFingerprint((toolCall as any).args),
                ms: __ms,
                ok: true,
                resultChars: String(result.output ?? '').length,
                prevSig: this.lastToolSig ?? null,
              });
              this.lastToolSig = argsFingerprint((toolCall as any).args);
            } catch { /* 任何优化项失败都不影响工具结果本身 */ }
          }
          if (result.success) {
            consecutiveErrors = 0;
            // 2026-07-29: Hermes 风格硬限制计数
            totalToolCallsThisLoop++;
            // 2026-10-01: 批处理工具(一次顶多次) ⇒ **退还**这次迭代 (奖励批处理, 压零碎调用)
            if (this.iterBudget && isRefundableTool(toolCall.name)) {
              this.iterBudget.refund();
              console.warn(`[PiAgent] ${toolCall.name} 是批量工具 ⇒ 退还 1 次迭代 (现 ${this.iterBudget.describe()})`);
            }
            lastNTools.push(toolCall.name);
            if (lastNTools.length > MAX_IDEMPOTENT_TOOL) lastNTools.shift();
            if (result.output) { this.successfulToolResults.push({ tool: toolCall.name, outputPreview: result.output.substring(0, 200) + (result.output.length > 200 ? '...' : '') }); }
            else { this.successfulToolResults.push({ tool: toolCall.name, outputPreview: '(无输出)' }); }
            loopReviewCompletedTools.add(toolCall.name);
            lastQualityScore = this.estimateToolResultQuality(result);
            if (lastQualityScore < this.QUALITY_THRESHOLD && refineAttempts < this.MAX_REFINE_ATTEMPTS) { refineAttempts++; }
            if (onStream) { onStream({ type: 'status', internal: true, content: `🔄 工具执行完成，继续循环...`, tool: 'loop' }); }
          } else {
            consecutiveErrors++;
            // 2026-10-01 (优化 #3): 失败也记一行(带错误类别) ⇒ "错工具率"从这类错误里看得出来
            try {
              const __cls = classifyError(String(result.error || '')).label || '未分类';
              recordToolCall({ tool: toolCall.name, sig: argsFingerprint((toolCall as any).args), ms: 0,
                ok: false, resultChars: 0, prevSig: this.lastToolSig ?? null, errorClass: __cls });
              this.lastToolSig = argsFingerprint((toolCall as any).args);
            } catch { /* 遥测失败不影响 */ }
            totalErrors++;
            if (toolCall.name === lastFailedTool) { lastFailedToolCount++; }
            else { lastFailedTool = toolCall.name; lastFailedToolCount = 1; }
            console.warn(`[PiAgent] 工具 ${toolCall.name} 执行失败 (${lastFailedToolCount}/${MAX_SAME_TOOL_FAILURES}, 累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS}): ${result.error}`);
            // 2026-07-28: 注入 Observation + Reflection 替代旧 hardcode 提示
            const obs = buildObservation(toolCall.name, toolCall.args, { success: false, error: result.error });
            const ref = buildReflection(toolCall.name, result.error, totalErrors, lastFailedToolCount);
            this.pushHistory({ role: 'system', content: formatObservationWithReflection(obs, ref) + SHELL_ESCAPE_HINT });
            if (onStream) onStream({ type: 'status', content: `💡 Reflection: ${obs.summary} → ${ref[0]?.action || '放弃'}`, tool: 'system' });
            if (lastFailedToolCount >= MAX_SAME_TOOL_FAILURES) {
              this.pushHistory({ role: 'system', content: `[注意] 工具 ${toolCall.name} 在这个上下文中不可用 (连续 ${MAX_SAME_TOOL_FAILURES} 次失败: ${result.error}). 请不要再次调用它, 直接用你已知的信息回答用户, 并在回答开头标记 <final gen>.` });
              lastFailedTool = ''; lastFailedToolCount = 0; consecutiveErrors = 0;
              return;
            }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              this.pushHistory({ role: 'system', content: `[注意] 前面的工具调用连续失败。请尝试其他工具或换一种方式完成用户请求, 或用 <final gen> 给出最终回答.` });
              consecutiveErrors = 0;
            }
          }
        } catch (execError) {
          consecutiveErrors++;
          totalErrors++;
          const errorResult: ToolResult = { success: false, error: String(execError) };
          this.pushHistory({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          const obs = buildObservation(toolCall.name, toolCall.args, errorResult);
          const ref = buildReflection(toolCall.name, errorResult.error, totalErrors, lastFailedToolCount);
          this.pushHistory({ role: 'system', content: formatObservationWithReflection(obs, ref) + SHELL_ESCAPE_HINT });
          if (onStream) onStream({ type: 'status', content: `💡 Reflection: ${obs.summary}`, tool: 'system' });
          console.error(`[PiAgent] 工具执行异常 (累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS}): ${execError}`);
        }
        })); // end Promise.all(toolCalls.map(async ...))
        // 所有工具执行完毕后, continue while 循环, 让 LLM 看到结果
        continue;
        } else {
        // LLM 返回的不是 tool call 格式
        this.pushHistory({
          role: 'assistant',
          content: reply,
          reasoningContent: (response as any)?.reasoningContent,
        });

        // 通知前端收到非工具调用回复 (2026-08-09: 完整内容, 不再截断 150)
        if (onStream) {
          onStream({ type: 'token', content: reply });
        }

        // 2026-06-19 架构 fix: 只有 strip <think> 后才检查 isFinalResponse
        //   (parseToolCall 已先尝试, 既然没解析出 tool_call, 现在检查 final gen 是否真的在最终回答区)
        if (this.isFinalResponse(reply)) {
          // 2026-06-19 dive-into 风格修复: 如果还有 successful tool results 没汇报,
          //   LLM 不能提前 final_gen — harness 自动注入"请汇报剩余工具结果" hint 再 continue
          //   这是 dive-into 文档"step 9 stop condition check" 的具体化:
          //   stop condition = (有工具结果未汇报) ? continue : break
          
          // 检查回复是否包含工具结果内容（避免无限循环）
          const hasToolResultContent = this.successfulToolResults.some(r => 
            reply.includes(r.tool) || reply.includes(r.outputPreview.substring(0, 50))
          );
          
          // 如果回复包含工具结果内容，清除 successfulToolResults
          if (hasToolResultContent) {
            console.log(`[PiAgent] 回复包含工具结果内容, 清除 successfulToolResults (${this.successfulToolResults.length} 个)`);
            this.successfulToolResults = [];
          }
          
          // 2026-08-10: 逃生门 — decideUnreported: 未达上限 → 再提示一次; 超限 → 清空积压强制 final (防死循环)
          const unreportedDecision = decideUnreported(this.successfulToolResults.length, unreportedRetries, MAX_UNREPORTED_RETRIES);
          if (unreportedDecision === 'retry' && iteration < this.MAX_REACT_ITERATIONS) {
            unreportedRetries++;
            const unreported = this.successfulToolResults.length;
            console.log(`[PiAgent] LLM 想 final_gen 但还有 ${unreported} 个工具结果未汇报 (${unreportedRetries}/${MAX_UNREPORTED_RETRIES}), push hint 让其继续`);
            this.pushHistory({
              role: 'system',
              content: `[dive-into stop condition] 你之前已成功执行了 ${unreported} 个工具, 但当前回复里没把它们的结果告诉用户. 请基于已有的工具结果 (在 history 里) 写一个完整总结回复给用户, 用 <final gen> 结尾. 不要再调工具.`
            });
            if (onStream) {
              onStream({ type: 'status', internal: true, content: `🔄 还有 ${unreported} 个工具结果未汇报, 让 LLM 继续总结 (${unreportedRetries}/${MAX_UNREPORTED_RETRIES})`, tool: 'system' });
            }
            continue;
          } else if (unreportedDecision === 'force-final') {
            // 反复提示仍未汇报超过上限 → 清空积压强制 final, 不再死循环
            console.log(`[PiAgent] unreported 循环超限 (${unreportedRetries} 次), 清空积压强制 final`);
            this.successfulToolResults = [];
            this.pushHistory({
              role: 'system',
              content: `[dive-into stop condition] 已多次提示汇报工具结果仍未完成 (超过 ${MAX_UNREPORTED_RETRIES} 次). 现在直接基于你已知的信息写最终回复给用户, 用 <final gen> 结尾, 不要再调任何工具.`
            });
            if (onStream) {
              onStream({ type: 'status', internal: true, content: `🔄 工具结果汇报超限, 强制收尾`, tool: 'system' });
            }
          }
lastQualityScore = this.estimateResponseQuality(reply);
          // 2026-07-29: 质量门 — 即使 LLM 声称完成, 质量太低也继续
          if (lastQualityScore < this.QUALITY_THRESHOLD && refineAttempts < this.MAX_REFINE_ATTEMPTS) {
            console.log(`[PiAgent] final gen 质量 ${lastQualityScore.toFixed(2)} < ${this.QUALITY_THRESHOLD}, 注入 refine hint`);
            this.pushHistory({ role: 'system', content: `[质量检查] 你的回答质量评分为 ${(lastQualityScore * 10).toFixed(1)}/10, 低于 ${(this.QUALITY_THRESHOLD * 10).toFixed(1)}/10 阈值。请提供更完整、详细的回答, 包含工具调用获取到的具体信息, 末尾加 <final gen>。` });
            refineAttempts++;
            continue;
          }

          // 2026-08-08: final 前目标对齐 review — 不潦草收尾 (见 loop-review.ts)
          //   LLM 想 <final gen> 时, 先跑 1-2 次「目标对齐 + 需求深挖」review;
          //   达成用户需求才放行真正结束. 达上限或无需深挖则以用户需求为准结束.
          // 2026-09-16 (Milestone 1-B): 目标审查走唯一门面 (loop-review 是 Harness 的一个环节)
          const reviewDecision = this.piHarness().reviewFinal({
            reviewsDone: loopReviewCount,
            // 2026-08-10: 传用户原始输入 (不是派生 intentHint) — LLM 对照原文自查完成度,
            //   未完成 → 自动继续调工具 (自动触发后续步骤)
            userIntent: this.currentUserInput,
            completedTools: Array.from(loopReviewCompletedTools),
            actionLog: loopActionLog,
            runId: this.actor!.state.activeRun || undefined,
            goalId: this.actor!.state.goalBinding || undefined,
          }, DEFAULT_MAX_REVIEWS);
          if (reviewDecision.kind === 'continue-review') {
            loopReviewCount++;
            console.log(`[PiAgent] review ${loopReviewCount}/${DEFAULT_MAX_REVIEWS}: LLM 想 final 但先对齐需求深挖一次`);
            this.pushHistory({ role: 'system', content: reviewDecision.hint });
            if (onStream) {
              onStream({ type: 'status', internal: true, content: `🔄 目标对齐 review ${loopReviewCount}/${DEFAULT_MAX_REVIEWS}: 深挖续跑`, tool: 'system' });
            }
            continue; // 让 LLM 看到 hint, 深挖或确认完成后再次 final
          }
          finalResponse = this.extractFinalAnswer(reply);
          break;
        }

        // 检查是否需要继续循环处理
        // 更严格的判断：只有当回复明确表示需要更多信息时才继续
        const containsToolCallIntent = reply.includes('调用工具') || reply.includes('tool(') ||
          reply.includes('使用工具') || reply.includes('需要获取') || reply.includes('需要查看') ||
          // 兼容 LLM 用对象字面量输出 tool call (上轮没解析成功时, 至少要继续)
          reply.includes('tool =>') || reply.includes('[TOOL_CALL]') ||
          // 2026-06-15 修: 兼容 LLM 用 XML 标签输出 tool call (<shell_exec>...</shell_exec>)
          //   这时 parseToolCall 失败, 至少要让 loop 继续
          /<\w+>[\s\S]*?<\/\w+>/.test(reply);
        const hasError = ['不存在', '找不到', '无法找到', 'not found', 'does not exist',
          '错误', 'error', '失败', 'failed'].some(k => reply.includes(k));
        const isTooShort = reply.length < 50 && reply.length > 0;
        const hasQuestion = reply.includes('?') && (reply.includes('怎么') || reply.includes('如何') || reply.includes('什么'));

        const needsMoreWork = hasError || containsToolCallIntent || isTooShort || hasQuestion;

        if (needsMoreWork && iteration < this.MAX_REACT_ITERATIONS) {
          console.log(`[PiAgent] 继续循环处理 (${iteration}/${this.MAX_REACT_ITERATIONS}): needsMoreWork=${needsMoreWork}, hasError=${hasError}, containsToolCallIntent=${containsToolCallIntent}`);
          if (onStream) {
            onStream({ type: 'status', internal: true, content: `🔄 继续处理，循环 ${iteration}...`, tool: 'loop' });
          }
          continue;
        }

        // 否则把这个当作可能的最终回答
        finalResponse = reply;
        if (onStream) {
          onStream({ type: 'status', internal: true, content: `📝 提取最终回答，长度 ${reply.length}`, tool: 'system' });
        }
        break;
      }
    }

    if (!finalResponse) {
      // 走到这里通常是 LLM 一直在调同一个不存在的工具, 没输出 <final gen>
      // 把已知的失败信息也带回去, 让用户知道发生了什么
      const reason = lastFailedTool
        ? `(工具 ${lastFailedTool} 连续 ${MAX_SAME_TOOL_FAILURES} 次失败, 已放弃)`
        : `(共 ${iteration - 1} 轮无最终输出)`;
      finalResponse = `抱歉，任务未能完成 ${reason}。请换个方式提问，或明确告诉 agent 不要调用工具。`;
      if (onStream) {
        onStream({ type: 'error', content: `⚠️ 任务未完成: ${reason}`, tool: 'system' });
      }
    }

    // 通知前端循环完成
    if (onStream) {
      onStream({ type: 'status', internal: true, content: `✅ 处理完成，共 ${iteration - 1} 次循环`, tool: 'system' });
    }

    this.pushHistory({ role: 'assistant', content: finalResponse });

    // React Harness: 循环结束
    // 2026-09-16 (Milestone 1-B): 会话收尾走唯一门面
    await this.piHarness().sessionEnd(this.harnessCtx());

    // 2026-09-16: 收尾落盘 — done / failed / aborted / needs_human 如实写回 (不留幽灵 running)
    if (this.actor!.state.activeRun && !runExternallyPaused && !runExternallyAborted) {
      try {
        // 2026-09-16 (M4): 完成门 —— "模型说完成"不等于"系统确认完成"。
        //   证据 = 成功步骤的事实摘要; 末尾还有失败步骤没被后续成功覆盖 → 不许 done。
        const recBefore = await readRun(this.actor!.state.activeRun).catch(() => null);
        const steps = recBefore?.steps || [];
        const evidence = steps.filter((s) => s.ok).map((s) => `${s.tool}: ${(s.summary || '').slice(0, 120)}`).slice(-10);
        const lastStep = steps[steps.length - 1];
        const trailingFailure = !!lastStep && !lastStep.ok;
        /** 有工具步骤却一条成功证据都没有 → 不算完成 (证据门槛, 不是文案) */
        const noEvidence = steps.length > 0 && evidence.length === 0;

        const errText = runPersistenceFailure || this.breakerReason || runNeedsHuman || runStopReason || aiFailureReason || '';
        const cls = errText ? classifyRunError(errText) : 'unknown';
        // 持久化失败 / 熔断 / 鉴权 → needs_human; 预算/中止 → aborted; 末尾仍失败或无证据 → failed (不许 done)
        const status: 'done' | 'failed' | 'aborted' | 'needs_human' = runPersistenceFailure
          ? 'needs_human'
          : (this.breakerReason || runNeedsHuman)
            ? 'needs_human'
            : runStopReason
              ? 'aborted'
              : aiFailed
                ? (cls === 'auth' ? 'needs_human' : 'failed')
                : (trailingFailure || noEvidence)
                  ? 'failed'
                  : 'done';
        await finishRun(this.actor!.state.activeRun, {
          status,
          summary: finalResponse ? String(finalResponse).slice(0, 400) : undefined,
          error: errText
            || (trailingFailure ? `末尾步骤失败 (${lastStep.tool}): ${(lastStep.error || '').slice(0, 150)}` : undefined)
            || (noEvidence ? '有工具步骤但没有任何成功证据: 不许判 done' : undefined),
          evidence,
        });
      } catch (err) {
        // 终态也写不下去: 这是最坏情况 —— 除了留痕, 没有别的自愈手段, 所以必须显眼
        const message = `收尾落盘失败 (状态无法写回, 记录会停在 running): ${String((err as Error)?.message || err).slice(0, 200)}`;
        console.error('[PiAgent] run-store finishRun 失败 (核心持久化):', message);
        await recordDegradation({ kind: 'core', op: 'pi-sdk.finishRun', runId: this.actor!.state.activeRun, message }).catch(() => {});
        onStream?.({ type: 'error', content: `⚠️ ${message}`, tool: 'harness' });
      }

      // ★ 2026-09-25 (M0 接线冻结, 规则 ③ + ④): Run 结束**必过收尾漏斗**。
      //
      // 旧写法在这里另起了一套 Goal 侧收尾 (读证据 → `evaluateGoalCompletion` →
      // `completeGoalIfEligible` / `setUnresolved`): 它**不收尾** —— 不写 Memory、不生成 Skill 候选、
      // 不写权威 continuation、不留决策记录。于是同一条 Run 在 Supervisor 那里还会再收一次 (或反过来
      // 这条路径根本不收), 全仓就有了两套"这一轮跑完意味着什么"。那一套已删除。
      //
      // 现在: `closeRunOnce` (幂等) → 9 步收尾 → 产物落盘; 再由 Goal reducer 把"下一步是什么"
      // 落进 Goal (没有 Supervisor 宿主时 Runner 也要留下 continuation, 否则下一次还是从零开始)。
      if (this.actor!.state.goalBinding) {
        try {
          const wiring = await import('./goal-flywheel-wiring.js');
          const { reduceGoalState } = await import('./goal-state-reducer.js');
          const nowIso = new Date().toISOString();
          const closed = await wiring.closeRunOnce({
            goalId: this.actor!.state.goalBinding,
            runId: this.actor!.state.activeRun,
            caller: 'runner',
            now: nowIso,
            finalReview: finalResponse ? String(finalResponse).slice(0, 2000) : '',
          });
          if (wiring.isRefusal(closed)) {
            onStream?.({ type: 'status', content: `⚠️ 收尾被拒 (不当作收过): ${closed.reason}`, tool: 'harness' });
          } else if (closed.outcome) {
            const view = closed.outcome;
            const applied = await reduceGoalState({
              goalId: this.actor!.state.goalBinding,
              intent: 'closure_outcome',
              now: nowIso,
              by: 'runner',
              outcome: {
                goalStatus: wiring.goalStatusFromDecision(view.decision),
                continuation: wiring.toGoalStoreContinuation(view.continuation),
                reason: view.decision.reason,
              },
              runId: view.runId,
            });
            const line = view.decision.decision === 'complete'
              ? `🎯 目标已达成 (仍要过完成门): ${view.decision.reason}`
              : `🎯 目标仍在进行 (未判完成): ${view.decision.reason}`;
            onStream?.({
              type: 'status', internal: true,
              content: `${line}${applied.gateRejected ? ` [完成门拒绝: ${applied.gateRejected}]` : ''} `
                + `(收尾 ${view.steps} 步 · memory ${view.memories} · skill 候选 ${view.candidates} · goal=${this.actor!.state.goalBinding})`,
              tool: 'harness',
            });
          } else {
            // 幂等: 别处 (或上一次) 已经收过尾 —— 事实读不回来就如实说, 不重收也不假装
            onStream?.({ type: 'status', content: `🎯 ${closed.reason}`, tool: 'harness' });
          }
        } catch (err) {
          await recordDegradation({ kind: 'observational', op: 'pi-sdk.runClosure', runId: this.actor!.state.activeRun, message: String((err as Error)?.message || err).slice(0, 160) }).catch(() => {});
        }
      }
      this.actor!.state.activeRun = '';
    } else if (this.actor!.state.activeRun) {
      // 外部暂停/中止: 状态是人定的, 不覆盖 (paused 等 /resume; aborted 是终态)
      onStream?.({ type: 'status', content: `⏹️ 运行状态保持为 ${runExternallyPaused ? 'paused' : 'aborted'} (由外部控制面决定)`, tool: 'harness' });
      this.actor!.state.activeRun = '';
    }

    // 2026-06-16: 暴露 aiFailed 标志 — promptStream 据此决定是否自动重试整个 loop
    return { reply: finalResponse, aiFailed, aiFailureReason: aiFailureReason || undefined };
  }

  async deepThink(prompt: string): Promise<{ result: ThinkResult; response: string }> {
    const result = await this.thinkingEngine.think(prompt);
    let response = `深度思考完成（${result.depth}层）:\n\n`;
    for (const step of result.steps) {
      response += `第${step.step}步: ${step.thought}\n`;
      if (step.reflection) {
        response += `  反思: ${step.reflection}\n`;
      }
      if (step.improvement) {
        response += `  改进: ${step.improvement}\n`;
      }
      response += '\n';
    }
    response += `最终输出: ${result.finalOutput}`;
    return { result, response };
  }

  async processDocumentsInParallel(
    paths: string[],
    operation: 'summarize' | 'improve',
    requirements?: string
  ): Promise<{ outputs: string[]; success: boolean }> {
    if (paths.length === 0) {
      return { outputs: [], success: true };
    }

    const subtasks = paths.map((filePath, index) => ({
      id: `doc-${index}`,
      description: `${operation}:${filePath}${requirements ? `:${requirements}` : ''}`,
      priority: index
    }));

    const dispatchPrompts = subtasks.map(t => t.description);
    const results = await this.coordinator.dispatch(dispatchPrompts.join(' ||| '), paths.length);

    const outputs: string[] = [];
    let allSuccess = true;

    for (let i = 0; i < paths.length; i++) {
      const result = results.find((r: AgentResult) => r.taskId === `task-${i}`);
      if (result) {
        outputs.push(result.output);
        if (!result.success) allSuccess = false;
      } else {
        outputs.push(`No result for ${paths[i]}`);
        allSuccess = false;
      }
    }

    return { outputs, success: allSuccess };
  }

  private buildContext(): string {
    // P1 接入: 同步跑前 3 层压缩 (Budget Reduction / Snip / Microcompact)
    // 异步层 (Context Collapse / Auto-Compact) 在 promptStream 入口处单独跑 (用 LLM)
    // 失败静默: 任何 stage 抛错 → 走老 slice(-10) 逻辑
    //
    // P1.2: 如果 maybeAutoCompact 算过 Context Collapse 投影, 用 this.projectedHistory (读时投影, 非破坏)
    const source = this.projectedHistory ?? (this.actor!.state.messageHistory as Message[]);
    const recentMessages = this.compressHistorySync(source).slice(-10);
    return recentMessages.map(m => {
      if (m.role === 'user') return `用户: ${m.content}`;
      if (m.role === 'assistant') return `助手: ${m.content}`;
      if (m.role === 'tool') {
        const result = m.toolResult ? JSON.stringify(m.toolResult) : m.content;
        return `工具结果: ${result}`;
      }
      return m.content;
    }).join('\n');
  }

  /**
   * M3.5 (2026-06-17): 把 history 转成 messages 数组, 给 llm.chat() 用.
   *   不再用 buildContext() 把所有 role 压成字符串 — LLM 看不到 tool 调用结果.
   *   messages 数组保留 role 语义, tool role 单独传递, LLM 能看到完整 tool 结果.
   *
   * 取最近 N 条, 同步压缩前 3 层 (跟 buildContext 同步).
   * 跳过 projectedHistory 路径 — messages 数组必须真实, 不能用投影.
   */
  private buildMessages(): Array<{ role: string; content: string }> {
    try {
      // 2026-08-06: 来源优先用 projectedHistory (Context Collapse 投影, 非破坏) —
      //   与 buildContext 一致; 之前只让字符串路径用投影, messages 数组路径被跳过,
      //   导致 LLM 实际看到的还是未压缩的历史.
      const source = this.projectedHistory ?? (this.actor!.state.messageHistory as Message[]);
      const WINDOW = 15;
      const out: Array<{ role: string; content: string; reasoningContent?: string }> = [];

      // 2026-09-28 (前缀 KV 可命中): 带 CURRENT TURN 注入的条目要**原样回带**.
      // 两个理由: (1) 注入块是"当前轮的前缀", 重渲染 (重加 `[工具结果]` 前缀 / 再 slice 截断)
      //   会改字节 → 下一轮前缀从这条起分叉; (2) 已注入的 tool 条目在 wire 上已经是 user 形状,
      //   再套一次前缀就是双前缀, 连内容都变了.
      const isInjectedEntry = (m: { content?: string }): boolean =>
        typeof m.content === 'string' && m.content.includes(CURRENT_TURN_MARKER);

      // 早期历史压缩: 超过窗口时, 不直接丢弃 — 提取前段用户意图摘要注入 (同步, 无 LLM).
      // 结构对齐 Context OS: System Prompt(persona) + 压缩摘要 + 最近消息.
      if (source.length > WINDOW) {
        const early = source.slice(0, source.length - WINDOW);
        const slice = source.slice(-WINDOW);
        const earlyUsers = early.filter(m => m.role === 'user' && (m.content || '').trim());
        const earlyTools = early.filter(m => m.role === 'tool').length;
        const earlyAssist = early.filter(m => m.role === 'assistant' && (m.content || '').trim()).length;
        const snippet = earlyUsers.slice(-5).map(m => `- ${(m.content || '').slice(0, 120).replace(/\n/g, ' ')}`).join('\n') || '- (早期对话无用户文本)';
        out.push({
          role: 'system',
          content: `[上下文压缩] 早期 ${early.length} 条消息已压缩 (用户 ${earlyUsers.length} 条 / AI ${earlyAssist} 条 / 工具结果 ${earlyTools} 条). 关键用户意图摘要:\n${snippet}\n[压缩结束] 以下是最近消息:`,
        });
        for (const m of slice) {
          const r = m.role;
          if (isInjectedEntry(m)) { out.push({ role: 'user', content: String(m.content) }); continue; }
          if (r === 'tool') {
            out.push({ role: 'user', content: `[工具结果]\n${(m.content || '').slice(0, 2000)}` });
            continue;
          }
          if (r === 'assistant') { out.push({ role: 'assistant', content: (m.content || '').slice(0, 4000), reasoningContent: (m as any).reasoningContent }); continue; }
          if (r === 'user') { out.push({ role: 'user', content: (m.content || '').slice(0, 2000) }); continue; }
          if (r === 'system') { out.push({ role: 'system', content: (m.content || '').slice(0, 2000) }); }
        }
        return out;
      }

      // 窗口内: 原逻辑 (tool 转 user role, 避免 tool_calls 配对)
      const slice = source.slice(-WINDOW);
      for (const m of slice) {
        const r = m.role;
        if (isInjectedEntry(m)) { out.push({ role: 'user', content: String(m.content) }); continue; }
        if (r === 'tool') {
          out.push({ role: 'user', content: `[工具结果]\n${m.content || ''}` });
          continue;
        }
        if (r === 'assistant') {
          out.push({ role: 'assistant', content: m.content || '', reasoningContent: (m as any).reasoningContent });
          continue;
        }
        if (r === 'user') { out.push({ role: 'user', content: m.content || '' }); }
        if (r === 'system') { out.push({ role: 'system', content: m.content || '' }); }
      }
      return out;
    } catch (err) {
      console.warn('[PiAgent] buildMessages failed (silent, falling back to text):', err);
      // 退化: 用 buildContext 字符串包装成单 user message
      return [{ role: 'user', content: this.buildContext() }];
    }
  }

  /**
   * 2026-09-28 (前缀 KV 可命中): 把 chat() 回带的当前轮写回自己的 messageHistory.
   * 逻辑在模块级 `writeBackCurrentTurnInto` (纯函数, 门可以直接驱它断言);
   * 这里只负责接到 `actor 的 messageHistory` 上, 并保证任何异常都静默 (写回失败不影响对话).
   */
  private writeBackCurrentTurn(wire?: Array<{ role: string; content?: string }>): number {
    try {
      return writeBackCurrentTurnInto((this.actor!.state.messageHistory as Message[]), wire);
    } catch (err) {
      console.warn('[PiAgent] writeBackCurrentTurn failed (silent):', err);
      return 0;
    }
  }

  /**
   * 估算 messageHistory 的 token 数 (4 字符 ≈ 1 token, 与 context-compaction 同步).
   * 失败静默: 任何异常 → 0 (不阻塞)
   */
  private estimateHistoryTokens(): number {
    try {
      const { estimateTokens } = _piRequire('../context-compaction/index.js') as typeof import('../context-compaction/index.js');
      return estimateTokens((this.actor!.state.messageHistory as Message[]) as any);
    } catch {
      return 0;
    }
  }

  /**
   * 3 个恢复机制合一:
   *   1. max output token 升级: 最多 3 次, 每次 maxOutputTokens 翻倍 (如果 llm.chat 支持)
   *   2. reactive compaction: 估算 > 80% 阈值, 跑 sync compressHistorySync + 必要时 maybeAutoCompact
   *   3. prompt-too-long: LLM 报错 4xxx token 错误, 跑 reactive compaction 再试 1 次
   *
   * 失败静默: 全部失败 → 返回空 reply, 让上层 no-tool_use 终止
   */
  private async callLlmWithRecovery(
    llm: any,
    contextOrMessages: string | Array<{ role: string; content: string }>,
    systemPrompt: string,
    signal: AbortSignal | undefined,
    onStream?: (chunk: any) => void,
    tools?: any[],
    /** 2026-09-28: 当前轮易变段 (循环进度/改进提示) —— 进 CURRENT TURN 区, 不进 system */
    currentTurnContext?: string
  ): Promise<{ reply: string; toolCalls?: any[]; messages?: Array<{ role: string; content?: string }> }> {
    // Reactive compaction 预检: 估算 token 超 80% 阈值, 跑一次
    const estimated = this.estimateHistoryTokens();
    if (estimated > this.maxContextTokens() * 0.8) {
      console.warn(`[PiAgent] reactive compaction pre-check (${estimated} tokens > 80% threshold)`);
      onStream?.({ type: 'status', internal: true, content: '⚠️ reactive compaction 预检触发', tool: 'recovery' });
      try {
        // 同步压缩: 取快照与替换在**同一拍相邻两行** (中间没有 await) ⇒ 不存在"变换期间被追加"的窗口。
        //   若哪天这里插入 await, 必须改成 `actor.rebaseHistory(…, snapshotLen)` (见 channel-actor.ts)。
        const compacted = this.compressHistorySync((this.actor!.state.messageHistory as Message[]));
        this.replaceHistory(compacted);
        if (this.estimateHistoryTokens() > this.maxContextTokens() * 0.8) {
          await this.maybeAutoCompact(onStream, signal);
        }
      } catch (err) {
        console.warn('[PiAgent] reactive compaction pre-check failed:', err);
      }
    }

    // 错误分级 (M1.3, 2026-06-17):
    //   - 401/403/400 (认证/请求错误): 不重试, 直接 fail-fast
    //   - 429 (rate limit): 重试 2 次, 指数退避
    //   - 5xx (上游错误): 重试 2 次, 指数退避
    //   - network (ECONNRESET / fetch failed / abort/timeout): 重试 2 次
    //   - 4xx prompt-too-long: 走 reactive compaction
    // 这样以前所有错误都触发整个 runReActLoop 重跑(浪费 token),现在 4xx 直接失败
    //   让上层把失败原因广播给用户,而不是闷在 loop 里 retry 3 次后给空回复
    const classifyError = (err: any): 'auth' | 'rate_limit' | 'server' | 'network' | 'prompt_too_long' | 'other' => {
      const msg = String(err?.message || err || '');
      // 401/403: 认证失败
      if (/401|unauthor|invalid api key|api_key|forbidden|403/i.test(msg)) return 'auth';
      // 400 prompt-too-long
      if (/token|too long|exceed|length|context|4000|413/i.test(msg)) return 'prompt_too_long';
      // 429 rate limit
      if (/429|rate.?limit|too many requests/i.test(msg)) return 'rate_limit';
      // 5xx
      if (/5\d\d|internal server|bad gateway|service unavailable|gateway timeout|cloudflare|502|503|504/i.test(msg)) return 'server';
      // network
      if (/econnreset|econnrefused|enotfound|etimedout|fetch failed|network|aborted|timeout/i.test(msg)) return 'network';
      return 'other';
    };

    const isRetryable = (cls: ReturnType<typeof classifyError>) =>
      cls === 'rate_limit' || cls === 'server' || cls === 'network' || cls === 'prompt_too_long';
    const maxAttempts = (cls: ReturnType<typeof classifyError>) => isRetryable(cls) ? 3 : 1;
    const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000); // 1s, 2s, 4s, 8s cap

    let lastErr: any = null;
    let lastClass: ReturnType<typeof classifyError> = 'other';
    for (let attempt = 0; attempt < 4; attempt++) {  // 最多 4 次尝试
      try {
        // M3.5 (2026-06-17): 传 messages 数组 (如果 contextOrMessages 是数组) 或字符串
        //   数组版让 LLM 看到结构化的 user/assistant/tool role, 而不是把 history 拼成单字符串
        // Bug 5: pass tool IDs for native OpenAI tool calling
        // 2026-09-28 (前缀 KV 可命中): 显式 purpose/source —— pi-sdk 的 ReAct 循环**就是主对话**
        //   (完整 IMMUTABLE PREFIX + 工具全集 + CURRENT TURN, 也只有它带 cache_prompt);
        //   currentTurnContext 是调用方自己的当前轮易变段 (循环进度/改进提示), 走 CURRENT TURN 区.
        // 2026-09-28: 回带最终 wire messages (含注入后的当前轮) → 上层据此写回 messageHistory.
        const response = await llm.chat(contextOrMessages, systemPrompt, signal, tools, 'main-agent', 'react-loop', undefined, currentTurnContext);

        // 2026-10-01 (用户: 「思考的记录可以也显示出来吗」): 思考模型的思维链原先只被"存起来回带",
      //   **不显示** ✗。这里把它往流里送一份 —— 显示与否由 CLI 侧决定(BOLLOON_SHOW_THINKING, 默认显示) ✓。
      try {
        const rc = String((response as any)?.reasoningContent || '').trim();
        if (rc) this.runCtx.eventSink?.({ type: 'reasoning', content: rc } as any);
      } catch { /* 送不出去不影响主流程 */ }        // 2026-06-30: 透传 toolCalls (OpenAI 协议 native) 给上层, 让 assistant message 能 emit 真 id
        return { reply: response.reply || '', toolCalls: response.toolCalls, messages: response.messages };
      } catch (err: any) {
        // 用户主动 abort: 不重试, 立即抛
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        lastErr = err;
        lastClass = classifyError(err);
        const errMsg = String(err?.message || err || '').slice(0, 200);
        const attempts = maxAttempts(lastClass);
        if (attempt + 1 >= attempts) {
          console.warn(`[PiAgent] LLM 调用失败, 不再重试 (class=${lastClass}, attempt=${attempt + 1}/${attempts}): ${errMsg}`);
          break;
        }
        console.warn(`[PiAgent] LLM 调用失败 (class=${lastClass}, attempt=${attempt + 1}/${attempts}), ${backoffMs(attempt)}ms 后重试: ${errMsg}`);
        onStream?.({ type: 'status', content: `⚠️ LLM 调用失败 (${lastClass}), 重试 ${attempt + 2}/${attempts}...`, tool: 'recovery' });
        if (lastClass === 'prompt_too_long') {
          try {
            await this.maybeAutoCompact(onStream, signal);
          } catch (compactionErr) {
            console.warn('[PiAgent] reactive compaction on prompt-too-long failed:', compactionErr);
          }
          // 重新生成 context (重试 prompt_too_long 时重建 messages — 包含压缩后的 history)
          if (Array.isArray(contextOrMessages)) {
            contextOrMessages = this.buildMessages();
          } else {
            contextOrMessages = this.buildContext();
          }
        } else if (errMsg.includes('insufficient tool messages') || errMsg.includes('must be followed by tool messages')) {
          // 2026-07-29: 特殊的 400 错误 — tool_calls 配对异常, 降级为纯文本 context
          console.warn('[PiAgent] insufficient tool messages — 降级为 buildContext 文本');
          if (Array.isArray(contextOrMessages)) {
            contextOrMessages = this.buildContext();
            // 也清除最近一轮的 toolCalls, 防止再触发
            if ((this.actor!.state.messageHistory as Message[]).length > 1) {
              const last = (this.actor!.state.messageHistory as Message[])[(this.actor!.state.messageHistory as Message[]).length - 1];
              if (last.role === 'assistant' && (last as any).toolCalls) {
                delete (last as any).toolCalls;
              }
            }
          }
        } else {
          // 指数退避
          await new Promise<void>((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
    }
    // 失败: 返回结构化错误 reply (而不是空字符串), 上层可识别 + UI 可显示
    const errMsg = String(lastErr?.message || lastErr || '').slice(0, 300);
    const userMsg = lastClass === 'auth'
      ? `[AI 服务调用失败] 认证错误: ${errMsg}\n请检查 API key 配置 (env: OPENAI_API_KEY / ANTHROPIC_API_KEY 等)`
      : lastClass === 'rate_limit'
      ? `[AI 服务调用失败] 上游限流 (429): ${errMsg}\n请稍后重试`
      : lastClass === 'server'
      ? `[AI 服务调用失败] 上游错误: ${errMsg}\n已重试 2 次仍失败, 可稍后重试`
      : lastClass === 'network'
      ? `[AI 服务调用失败] 网络错误: ${errMsg}\n请检查网络连接`
      : `[AI 服务调用失败] ${errMsg}`;
    console.warn(`[PiAgent] callLlmWithRecovery 全部失败 (class=${lastClass}): ${errMsg}`);
    return { reply: userMsg };
  }

  /**
   * 同步压缩: 跑前 3 层 (Budget Reduction / Snip / Microcompact).
   * Context Collapse / Auto-Compact 是 async, 不在 buildContext 同步链里跑.
   * 失败静默: 任何 stage 抛错 → 返回原 history.
   */
  private compressHistorySync(history: Message[]): Message[] {
    try {
      // context-compaction 的 Message 与 pi-sdk 的 Message 字段兼容
      // 这里用 any cast 跳过 structural type 严格校验 (避免双向 import)
      let h: any = history;
      const r1 = budgetReduce(h);
      h = r1.history;
      const r2 = snip(h);
      h = r2.history;
      const r3 = microcompact(h);
      h = r3.history;
      return h as Message[];
    } catch (err) {
      console.warn('[PiAgent] compressHistorySync failed (silent, using original):', err);
      return history;
    }
  }

  /**
   * P1.1: 异步跑 Auto-Compact (LLM 摘要).
   * 入口: promptStream 入口, 在 computeJudgmentGate 之后, onSessionStart 之前.
   *
   * 逻辑:
   *   1. 跑完整 compactPipeline (5 层, 异步)
   *   2. 第 5 层 (Auto-Compact) 需要 LLM, 通过 getMinimax().chat 注入
   *   3. 如果 budgetGate 不超限, 5 层短路在前 3 层, 不会调 LLM → 零开销
   *   4. 失败静默: 任何异常 → console.warn + 保留原 messageHistory
   *
   * onStream 广播: 跟 computeJudgmentGate 风格一致 (phase 事件供 UI timeline 显示)
   */
  private async maybeAutoCompact(
    onStream?: (chunk: any) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if ((this.actor!.state.messageHistory as Message[]).length < 10) return;  // 历史太短, 不值得压

    onStream?.({ type: 'status', internal: true, content: '🗜️ 评估是否需要压缩上下文...', tool: 'compactor' });

    // 注入 LLM (用 getMinimax().chat, 与 judgment 注入门 / ReAct 循环同一来源)
    // 给 Context Collapse (虚拟投影) 和 Auto-Compact (摘要) 共用
    const llm = getMinimax();
    const llmChat = async (systemPrompt: string, userPrompt: string): Promise<string> => {
      // 2026-09-28 (前缀 KV 可命中): 压缩摘要是**非主对话的一次性调用** → 轻量前缀
      //   (它不该拖满 IMMUTABLE PREFIX, 更不该把主对话的 KV slot 顶掉).
      const r = await llm.chat(userPrompt, systemPrompt, signal, undefined, 'auto-compact', 'pi-sdk-compact');
      return r.reply;
    };

    // 2026-08-06: 预算 = ContextManager 配置 (1M * 55% ≈ 550K), 不再写死 8000.
    //   之前 8000 与 48K 触发阈值矛盾: 一触发就一路跑到 LLM 摘要 (贵), 且 8000 远小于实际窗口.
    const cm = getContextManager();
    const cfg = cm.getConfig();
    const maxTokens = Math.max(4000, Math.round(cfg.maxTokens * cfg.compressionThreshold));
    const beforeTokens = this.estimateHistoryTokens();

    const { compactPipeline, isContextCollapseEnabled } = await import('../context-compaction/index.js');
    // **K5 第 4 步**: 记下取快照时的长度 —— 压缩是 async, 从这一拍到 "落地" 之间是 await 窗口;
    //   期间 append 进来的消息必须由 `actor.rebaseHistory(…, snapshotLen)` 接回去, 否则会被整块替换丢掉。
    const snapshotLen = (this.actor!.state.messageHistory as Message[]).length;
    const result = await compactPipeline((this.actor!.state.messageHistory as Message[]) as any, {
      maxTokens,
      llmChat,
      collapseLlmChat: llmChat,  // P1.2: Context Collapse 投影也用同一 LLM
      cacheScope: this.actor!.state.channelId || 'default',
    });

    if (result.compacted && result.history.length < (this.actor!.state.messageHistory as Message[]).length) {
      const saved = (this.actor!.state.messageHistory as Message[]).length - result.history.length;
      const stagesApplied = result.stages.filter((s) => s.applied).map((s) => s.stage).join(' → ');
      const afterTokens = this.estimateHistoryTokens();
      const savedTokens = Math.max(0, beforeTokens - afterTokens);
      cm.markCompressStart(beforeTokens);
      onStream?.({
        type: 'status', internal: true,
        content: `🗜️ 上下文压缩: ${stagesApplied || 'no-op'} | 节省 ${saved} 条 / ${savedTokens.toLocaleString()} tokens (剩余 ${result.history.length}, collapse=${isContextCollapseEnabled() ? 'on' : 'off'})`,
        tool: 'compactor',
      });
      // 关键: 第 4 层 (Context Collapse) 是读时投影 (非破坏)
      //       第 5 层 (Auto-Compact) 是破坏性折叠
      //       这里用 if-else 区分: collapse on → 仅 buildContext 用; collapse off → 真更新
      if (isContextCollapseEnabled()) {
        this.projectedHistory = result.history as Message[];  // buildContext 用
        // messageHistory 不变 (非破坏)
      } else {
        // 真破坏性更新 —— **K5 第 4 步**: 绑定了 actor 就交它落地 (rebase: 保住变换期间的追加);
        //   未绑定的会话走原路径 (行为不变)。
        if (this.actor) {
          const { keptTail } = await this.actor.rebaseHistory<Message>(result.history as Message[], snapshotLen);
          if (keptTail > 0) {
            console.warn(`[PiAgent] 压缩落地: 保住变换期间新追加的 ${keptTail} 条消息 (快照后到达)`);
          }
        } else {
          this.replaceHistory(result.history as Message[]);
        }
        this.projectedHistory = null;
      }
      // 2026-08-06: snapshot 记录 before/after + 摘要 (供恢复/调试/UI), 事件广播
      try {
        const summaryLine = result.stages.map((s) => `${s.stage}(${s.before}→${s.after})`).join(' ');
        const snap = cm.makeSnapshot({
          beforeTokens,
          afterTokens,
          summary: `压缩管道: ${summaryLine}; 节省 ${savedTokens} tokens / ${saved} 条消息`,
          preservedMemory: [
            ...(this.actor!.state.messageHistory as Message[]).filter(m => m.role === 'user').slice(-3).map(m => (m.content || '').slice(0, 80)),
          ],
          agentId: this.actor!.state.agentId,
          channelId: this.actor!.state.channelId,
        });
        cm.markCompressComplete(snap);
      } catch (snapErr) {
        // snapshot 失败不阻塞主流程
      }
      cm.updateUsage(afterTokens);
    } else {
      // 没压成也更新 usage (数据源保持新鲜)
      cm.updateUsage(beforeTokens);
    }
  }
  private isFinalResponse(content: string): boolean {
    // 2026-06-30: 抽到 ./parse-tool-call.ts 作为纯函数 — 这里只构建 ctx 并调用
    return isFinalResponseImpl(content, this._parseCtx());
  }

  private extractFinalAnswer(content: string): string {
    // 抽取实现已挪到 ./parse-tool-call.ts (纯函数, 易测)
    return extractFinalAnswerImpl(content);
  }

  private _parseCtx() {
    return {
      tools: new Set(Array.from(this.tools.keys())),
      resolveAlias: (name: string) => this.resolveToolName(name),
    };
  }

  private parseToolCall(content: string): { name: string; args: Record<string, string> } | null {
  // 2026-06-30: 抽到 ./parse-tool-call.ts 作为纯函数 — 这里只构建 ctx 并调用
    return parseToolCallImpl(content, this._parseCtx());
  }

  // [debug-2026-06-19] 临时: 打印 parseToolCall 输入和返回
  private _dbgParseToolCall(content: string): { name: string; args: Record<string, string> } | null {
    const r = this.parseToolCall(content);
    console.log('[DBG parseToolCall] result:', JSON.stringify(r), 'content head:', JSON.stringify(content.substring(0, 200)));
    return r;
  }



  /**
   * 2026-06-19: 工具名大小写不敏感 + Claude Code 风格别名映射

  /**
   * 2026-06-19: 工具名大小写不敏感 + Claude Code 风格别名映射
   *   LLM 实际产出 Read/Edit/Write/Bash/Grep/Glob 等大写名 (Claude Code 工具命名)
   *   bolloon 注册的是 read_document / edit_file / write_file / shell_exec / list_files
   *   返回 this.tools 里的标准名, 或 null 表示未识别
   */
  /**
   * 把 LLM 给的工具名 (可能大小写不一, 或者 Claude Code 风格的别名) 解析为
   * bolloon 注册的标准工具名.
   *
   * 2026-06-30: 委托给 ToolRegistry 模块 — alias 表在 tool-registry.ts 统一维护,
   *   这里只做 thin wrapper 保留 backward compat (private API 但其它地方可能用).
   */
  private resolveToolName(name: string): string | null {
    return this._toolRegistry.resolve(name);
  }



  private estimateResponseQuality(response: string): number {
    let score = 0.5;
    if (response.length > 50) score += 0.1;
    if (response.length > 200) score += 0.1;
    if (response.length < 20) score -= 0.3;
    if (response.includes('\n')) score += 0.1;
    if (response.includes('-') || response.includes('•')) score += 0.05;
    if (response.includes('```')) score += 0.1;
    const conclusionWords = ['完成', '结果', '总结', '所以', '因此', '答案', '推荐'];
    if (conclusionWords.some(w => response.includes(w))) score += 0.1;
    if (response.includes('调用工具') || response.includes('tool(')) score -= 0.2;
    return Math.max(0, Math.min(1, score));
  }

  private estimateToolResultQuality(result: ToolResult): number {
    let score = 0.5;
    if (!result.success) return 0.2;
    if (result.output) {
      score += 0.2;
      if (result.output.length > 50) score += 0.1;
      if (result.output.length < 10) score -= 0.1;
      if (result.output.includes('❌') || result.output.includes('error')) score -= 0.2;
      if (result.output.includes('✅') || result.output.includes('success')) score += 0.1;
    }
    if (result.error) score -= 0.3;
    return Math.max(0, Math.min(1, score));
  }

  private async handleFallback(input: string): Promise<string> {
    const lowerInput = input.toLowerCase();
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    if (cmd.includes('读取') || cmd === 'read' || cmd === 'read_document') {
      if (args) return await this.readDocument(args);
    }

    if (cmd.includes('总结') || cmd === 'summary' || cmd === 'summarize') {
      if (args) return await this.summarizeText(args);
    }

    if (cmd.includes('改进') || cmd === 'improve' || cmd === 'improve_document') {
      const match = input.match(/改进[^\w]+(.+)/i) || input.match(/improve\s+(.+)/i);
      if (match) {
        return `改进需要LLM支持，请设置 MINIMAX_API_KEY 环境变量。\n文件: ${match[1]}`;
      }
    }

    if (cmd.includes('节点') || cmd === 'peers' || cmd === 'list_peers') {
      return this.listPeers();
    }

    if (cmd.includes('身份') || cmd === 'identity' || cmd === 'get_identity') {
      return JSON.stringify(this.getIdentity(), null, 2);
    }

    if (cmd.includes('日志') || cmd === 'logs') {
      const logs = this.constraintLayer.getLogs();
      if (logs.length === 0) return '暂无操作日志';
      return logs.slice(-5).map(l => `[${new Date(l.timestamp).toISOString()}] ${l.action}`).join('\n');
    }

    return this.getDefaultResponse(input);
  }

  private static OPERATIONS_REFERENCE: string | null = null;

  private static getOperationsReference(): string {
    if (this.OPERATIONS_REFERENCE === null) {
      try {
        const refPath = path.join(process.cwd(), 'src', 'bollharness', 'scripts', 'context-fragments', 'pi-agent-operations.md');
        this.OPERATIONS_REFERENCE = fsSync.readFileSync(refPath, 'utf-8');
      } catch {
        this.OPERATIONS_REFERENCE = '';
      }
    }
    return this.OPERATIONS_REFERENCE;
  }

  private getDefaultResponse(input: string): string {
    const operationsRef = PiAgentSession.getOperationsReference();

    if (operationsRef) {
      return `收到了: "${input}"

我是一个判断力处理智能体，支持自然语言交互。

可用操作（直接说出即可）:
${this.extractOperationsFromRef(operationsRef)}

示例请求:
  - "读取 src/index.ts 文件"
  - "总结一下 README.md"
  - "查看当前连接了哪些节点"
  - "向 QmABC... 发送测试消息"`;
    }

    return `收到了: "${input}"

我是一个判断力处理智能体，支持自然语言交互。

可用操作（直接说出即可）:
  - "读取 README.md" - 读取并分析文档
  - "总结文档" - 总结文档内容
  - "改进文档，按照X要求" - 改进文档
  - "查看节点" - 查看已连接的对等节点
  - "向X发送消息Y" - 向对等节点发送消息
  - "广播消息X" - 广播消息到所有节点
  - "查看身份" - 查看当前智能体身份
  - "查看日志" - 查看最近操作日志

示例请求:
  - "读取 src/index.ts 文件"
  - "总结一下 README.md"
  - "查看当前连接了哪些节点"
  - "向 QmABC... 发送测试消息"`;
  }

  private extractOperationsFromRef(ref: string): string {
    const lines = ref.split('\n');
    const inOperationsSection = false;
    const operationLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## 可用操作')) {
        for (let j = i + 1; j < lines.length; j++) {
          const opLine = lines[j];
          if (opLine.startsWith('## ') || opLine.startsWith('#')) break;
          if (opLine.includes('|') && !opLine.startsWith('|')) {
            const parts = opLine.split('|').map(p => p.trim());
            if (parts.length >= 3 && parts[1] && parts[2]) {
              operationLines.push(`  - "${parts[1]}" - ${parts[2]}`);
            }
          }
        }
        break;
      }
    }

    return operationLines.length > 0 ? operationLines.join('\n') :
        `  - "读取 README.md" - 读取并分析文档
  - "总结文档" - 总结文档内容
  - "改进文档，按照X要求" - 改进文档
  - "查看节点" - 查看已连接的对等节点
  - "向X发送消息Y" - 向对等节点发送消息
  - "广播消息X" - 广播消息到所有节点
  - "查看身份" - 查看当前智能体身份
  - "查看日志" - 查看最近操作日志`;
  }

  async suggestRename(messages: { type: string; content: string }[]): Promise<string | null> {
    if (!this.minimaxAvailable || messages.length < 2) {
      return null;
    }

    const conversation = messages.map(m => `${m.type === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n');
    const llm = getMinimax();

    try {
      const response = await llm.chat(
        `根据以下对话内容，为这个对话生成一个简短的名称（不超过20个字）：\n\n${conversation}\n\n直接输出名称，不要其他解释。`,
        '命名建议',
        undefined, undefined, 'chat', 'session-namer'   // 非主对话: 轻量前缀, 不抢主对话的 KV slot
      );

      const name = response.reply.trim();
      // 拒绝错误回退串 (LLM 不可用时返回的占位文本)
      if (!name) return null;
      if (/^(抱歉|对不起|sorry|error|错误|失败|暂不可用|服务不可用)/i.test(name)) {
        console.log(`[suggestRename] 拒绝错误回退: "${name}"`);
        return null;
      }
      if (name.length > 20) return null;
      if (name === '智能体') return null;
      // 拒绝纯符号/标点
      if (!/[一-鿿\w]/.test(name)) return null;
      return `Agent | ${name}`;
    } catch {
      // ignore
    }
    return null;
  }

  private async summarizeText(text: string): Promise<string> {
    if (!this.minimaxAvailable) {
      return '⚠️ LLM未初始化，请设置 MINIMAX_API_KEY 环境变量';
    }
    const llm = getMinimax();
    const result = await llm.summarize(text);
    return `📝 摘要:\n${result.summary}\n\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`;
  }

  async readDocument(filePath: string): Promise<string> {
    const content = await documentReader.read(filePath);
    this.sessionManager.addFileContext(filePath, content.text.substring(0, 1000));
    return `📄 ${content.metadata.filename}\n大小: ${content.metadata.size} 字节\n\n${content.text.substring(0, 500)}...`;
  }

  async summarizeDocument(filePath: string, context?: string): Promise<{
    summary: string;
    qualityScore: number;
  }> {
    if (!this.minimaxAvailable) {
      return {
        summary: '⚠️ LLM未初始化，请设置 MINIMAX_API_KEY 环境变量',
        qualityScore: 0
      };
    }

    const content = await documentReader.read(filePath);
    this.sessionManager.addFileContext(filePath, content.text.substring(0, 1000));
    const llm = getMinimax();
    const chunks = documentReader.chunk(content.text);
    const summaries: string[] = [];
    let totalQuality = 0;

    for (const chunk of chunks) {
      const result = await llm.summarize(chunk, context);
      summaries.push(result.summary);
      totalQuality += result.qualityScore;
    }

    const avgQuality = totalQuality / chunks.length;
    return {
      summary: summaries.join('\n\n'),
      qualityScore: avgQuality
    };
  }

  async improveDocument(request: ImprovementRequest): Promise<{
    improved: boolean;
    newContent?: string;
    qualityScore: number;
    shouldAutoSend: boolean;
  }> {
    if (!this.minimaxAvailable) {
      return {
        improved: false,
        qualityScore: 0,
        shouldAutoSend: false
      };
    }

    const content = await documentReader.read(request.originalPath);
    const llm = getMinimax();
    const improvedResult = await llm.summarize(content.text + '\n\n改进要求: ' + request.requirements, request.context);
    const shouldAutoSend = await llm.shouldAutoSend(improvedResult.qualityScore, 0.7);

    return {
      improved: true,
      newContent: improvedResult.summary,
      qualityScore: improvedResult.qualityScore,
      shouldAutoSend
    };
  }

  async runWorkflow(steps: WorkflowStep[]): Promise<Workflow> {
    const context: WorkflowContext = {
      peers: this.getPeers(),
      logs: []
    };

    const checkResult = await this.constraintLayer.checkGuardrails(context);
    if (!checkResult.passed && checkResult.blocked) {
      console.warn(`Guardrail blocked: ${checkResult.blocked.name}`);
    }

    return this.workflowEngine.executeWorkflow(steps, context);
  }

  async summarizeDocumentWorkflow(filePath: string, targetPeer?: string): Promise<Workflow> {
    const steps: WorkflowStep[] = [
      {
        id: 'read',
        type: 'read',
        config: { path: filePath },
        retry: { max: 3, current: 0, backoffMs: 1000 },
        onFail: 'abort'
      },
      {
        id: 'summarize',
        type: 'summarize',
        config: { context: `File: ${filePath}` },
        retry: { max: 3, current: 0, backoffMs: 1000 },
        onFail: 'skip',
        guardrail: (ctx) => Promise.resolve(ctx.qualityScore !== undefined && ctx.qualityScore >= 0.5)
      }
    ];

    if (targetPeer) {
      steps.push({
        id: 'send',
        type: 'send',
        config: { peerId: targetPeer },
        retry: { max: 2, current: 0, backoffMs: 2000 },
        onFail: 'skip'
      });
    }

    return this.runWorkflow(steps);
  }

  async improveAndSendWorkflow(filePath: string, requirements: string, targetPeer: string): Promise<Workflow> {
    const steps: WorkflowStep[] = [
      {
        id: 'read',
        type: 'read',
        config: { path: filePath },
        retry: { max: 3, current: 0, backoffMs: 1000 },
        onFail: 'abort'
      },
      {
        id: 'improve',
        type: 'improve',
        config: { requirements, context: `File: ${filePath}` },
        retry: { max: 2, current: 0, backoffMs: 1500 },
        onFail: 'skip'
      },
      {
        id: 'send',
        type: 'send',
        config: { peerId: targetPeer, message: '改进后的文档' },
        retry: { max: 2, current: 0, backoffMs: 2000 },
        onFail: 'skip'
      }
    ];

    return this.runWorkflow(steps);
  }

  getOperationLogs(): { timestamp: number; action: string; details: Record<string, unknown>; status: string }[] {
    return this.constraintLayer.getLogs();
  }

  private listPeers(): string {
    const peers = p2pNetwork.getPeers();
    if (peers.length === 0) {
      return '当前无连接的对等节点';
    }
    return `已连接节点 (${peers.length}):\n${peers.map(p => `  - ${p}`).join('\n')}`;
  }

  getPeers(): string[] {
    return p2pNetwork.getPeers();
  }

  async sendMessage(peerId: string, message: string): Promise<void> {
    await p2pNetwork.sendMessage(peerId, 'message', message);
  }

  async broadcast(message: string): Promise<void> {
    await p2pNetwork.broadcast('message', message);
  }

  getIdentity(): IdentityDoc {
    return { ...this.identity };
  }

  updateIdentity(updates: Partial<IdentityDoc>): void {
    // 2026-10-01 **修切换频道后身份不换的根因**: 上一版是 `this.identity = { ...this.identity, ...updates }`
    //   —— **换成新对象** ✗。而工具上下文是在 registerTools() 时按**对象引用**捕获的 (`identity: this.identity`),
    //   并且切频道时 session 是**复用**的(pi-sdk-session-factory 的模块级单例, 只调 updateIdentity) ⇒
    //   工具里的 ctx.identity 一直指向**旧对象** ⇒ `get_identity` 永远返回上一个频道的身份 ✗✗
    //   (实测: xiaomi/智能体频道都答「233 的 DID + 小龙」, 因为 233 是进程启动时的频道)。
    //   ⇒ 改成**原地改**: 所有持有者(工具上下文/会话/状态栏)都看到同一个对象的新值 ✓。
    Object.assign(this.identity, updates);
  }

  setCurrentChannelId(channelId: string): void {
    this.actor!.state.channelId = channelId;
  }

  getSessionState(): PiSessionState {
    return this.sessionManager.getState();
  }

  getMemory(): PiMemory {
    return this.sessionManager.getMemory();
  }

  getPersona(): PersonaDoc | null {
    return this.sessionManager.getPersona();
  }

  async setPersona(persona: PersonaDoc): Promise<void> {
    await this.sessionManager.savePersona(persona);
    // 2026-10-01: **写透** —— 有身份文档的 agent 不套 persona.json, 只写 JSON 等于没改
    //   (用户报"每次让智能体改都是同一个") ⇒ 同步落进它自己的身份文档 (标记区内)
    if (this.actor!.state.agentId) {
      try {
        const { applyPersonaToDocs } = await import('../bootstrap/persona-init.js');
        const wrote = await applyPersonaToDocs(this.actor!.state.agentId, persona as any);
        if (wrote.length) console.warn(`[persona] 已把 ${this.actor!.state.agentId} 的 persona 写进身份文档: ${wrote.join(' · ')}`);
      } catch { /* 非致命 */ }
    }
    this.persona = persona;
    if (persona.name) {
      this.identity.name = persona.name;
    }
  }

  getDiscoveredAgents(): DiscoveredAgent[] {
    return this.agentsManager.getAllAgents();
  }

  getSocialChannels(): SessionChannel[] {
    return this.sessionManager.getAllChannels();
  }

  async sendSocialMessage(channelId: string, content: string): Promise<void> {
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      type: 'ai',
      content,
      sender: 'self',
      timestamp: new Date().toISOString(),
      agentId: this.identity.did
    };

    await this.sessionManager.addMessage(channelId, message);

    const channels = this.sessionManager.getAllChannels();
    const channel = channels.find(c => c.id === channelId);
    if (channel?.peerDid) {
      const agent = this.agentsManager.getAgent(channel.peerDid);
      if (agent) {
        const comm = (global as any).hyperswarmComm;
        if (comm) {
          const connections = comm.getConnections?.() || [];
          for (const conn of connections) {
            if (conn.publicKey === agent.peerId) {
              const data = new TextEncoder().encode(`social|${JSON.stringify({ from: this.identity.did, message: content })}`);
              comm.sendToConnection?.(conn, data);
              break;
            }
          }
        }
      }
    }
  }

  async startSocialHeartbeat(config?: Partial<HeartbeatConfig>): Promise<void> {
    if (this.socialHeartbeat) {
      return;
    }
    this.socialHeartbeat = await createSocialHeartbeat(this.sessionManager, this.agentsManager, config);
    this.socialHeartbeat.setOnAgentDiscovered((agent) => {
      console.log(`[Agent] 发现新智能体: ${agent.name}`);
    });
    this.socialHeartbeat.setOnSocialMessage((fromDid, message, channelId) => {
      console.log(`[Agent] 收到来自 ${fromDid} 的社交消息: ${message.substring(0, 50)}...`);
    });
  }

  stopSocialHeartbeat(): void {
    if (this.socialHeartbeat) {
      this.socialHeartbeat.stop();
      this.socialHeartbeat = null;
    }
  }

  /**
   * **受门包装**的 skill 面 (2026-10-02 · leo 口径 (b): 原裸出口已收口)。
   *
   * 为什么不能返回裸 registry: 拿到裸 registry 就有**三条**绕过 Harness 的路径 ——
   *   ① `registry.execute(n, p)` ② `registry.get(n).execute(p)` ③ `registry.list()[i].execute(p)`
   *   (后两条藏在返回的 `Skill` 对象里, 只看方法名看不出来)。
   * 现在三条**都**经本会话唯一受门口: `executeSkill` ⇒ `createSkillGuard()` ⇒ `piHarness().beforeToolCall()`,
   * 执行落在 registry 的唯一调用点 (**恰一次**), 被拒 ⇒ **零执行** 且返回 `拒绝: [rejectedBy] reason`。
   *
   * ⚠️ **行为变更 (可能属破坏性)**: 旧用法 `.execute('x', p)` 在**被拒时不再执行**, 改为返回拒绝串
   * (与 `executeSkill` 同形)。方法名/签名不变 ⇒ **源码级兼容**; 但"被拒即不执行"是新约定。
   *
   * **管不到的一条 (如实记)**: 调用方**自己**在 `register(skill)` 时传入的那个 skill 对象仍有裸 `execute`
   * —— 那是调用方的对象, 不属本出口能管的面。收口管的是**本出口给出的任何引用**。
   */
  getSkillRegistry(): GuardedSkillRegistry {
    // 任何被交出去的 Skill 引用, 其 execute 都换成受门版本 (堵 ②③ 两条隐藏路径)
    const guarded = (sk: Skill): Skill => ({
      name: sk.name,
      description: sk.description,
      execute: (params: Record<string, unknown>) => this.executeSkill(sk.name, params),
    });
    return {
      register: (sk: Skill) => this.skillRegistry.register(sk),
      unregister: (name: string) => this.skillRegistry.unregister(name),
      has: (name: string) => this.skillRegistry.has(name),
      get: (name: string) => { const sk = this.skillRegistry.get(name); return sk ? guarded(sk) : undefined; },
      list: () => this.skillRegistry.list().map(guarded),
      execute: (name: string, params: Record<string, unknown>) => this.executeSkill(name, params),
    };
  }

  registerSkill(skill: Skill): void {
    this.skillRegistry.register(skill);
  }

  /**
   * 2026-10-02 (K7) **唯一 skill 执行口**:
   *   判定一律经 Harness (`createSkillGuard()` ⇒ `piHarness().beforeToolCall`, 身份带 runId/goalId/agentId/channelId);
   *   执行落在本会话 registry 的**唯一**调用点 (**恰一次**)。
   *   **fail-closed**: 门抛错 ⇒ 返回 `拒绝: [harness-error] …`, **绝不回落**直调 registry。
   *   公开签名不变 (仍返回 string) ⇒ 不破坏已发布契约 (leo 的方案 a: 保留 API, 内部降为经门转发)。
   */
  async executeSkill(name: string, params: Record<string, unknown>): Promise<string> {
    let decision: { allow: boolean; reason?: string; rejectedBy?: string };
    try {
      decision = await this.createSkillGuard()(name, params);
    } catch (guardErr) {
      return `拒绝: [harness-error] ${String((guardErr as Error)?.message ?? guardErr)}`;
    }
    if (!decision.allow) {
      return `拒绝: [${decision.rejectedBy || 'harness'}] ${decision.reason || '未说明理由'}`;
    }
    return this.skillRegistry.execute(name, params);
  }

  async addUserAction(content: string, importance?: number): Promise<void> {
    await this.sessionManager.addUserActionToSharedContext(content, importance);
  }

  async addSharedKnowledge(knowledge: string): Promise<void> {
    await this.sessionManager.addSharedKnowledge(knowledge);
  }

  async getRecentActionsSummary(count?: number): Promise<string> {
    return this.sessionManager.getRecentActionsSummary(count);
  }

  async getSharedKnowledge(): Promise<string[]> {
    return this.sessionManager.getSharedKnowledge();
  }

  async getGlobalContextSummary(): Promise<string> {
    return this.sessionManager.getGlobalContextSummary();
  }

  async createCooperation(
    type: CooperationType,
    task: string,
    toAgentId?: string,
    context?: string
  ): Promise<CooperationTask> {
    return this.sessionManager.createCooperation(type, task, toAgentId, context);
  }

  async getPendingCooperations(): Promise<CooperationTask[]> {
    return this.sessionManager.getPendingCooperations();
  }

  async updateCooperationStatus(
    cooperationId: string,
    status: 'pending' | 'in_progress' | 'done' | 'failed',
    result?: string
  ): Promise<void> {
    return this.sessionManager.updateCooperationStatus(cooperationId, status, result);
  }

  async getAllRegisteredAgents(): Promise<AgentInfo[]> {
    return this.sessionManager.getAllRegisteredAgents();
  }

  async findAgentByCapability(capability: string): Promise<AgentInfo[]> {
    return this.sessionManager.findAgentByCapability(capability);
  }

  // ==================== Harness Integration ====================

  private operationLog: Array<{ timestamp: number; action: string; args: any; result: any; status: string }> = [];

  private logToHarness(action: string, args: any, result: any): void {
    if (!this.harnessEnabled || !this.harness) return;

    this.operationLog.push({
      timestamp: Date.now(),
      action,
      args,
      result,
      status: result.success ? 'ok' : 'error'
    });

    if (this.operationLog.length >= 10) {
      this.archiveToHarness();
    }
  }

  archiveToHarness(): void {
    if (!this.harnessEnabled || !this.harness || this.operationLog.length === 0) return;

    this.harness.archiveSession(this.operationLog);
    this.operationLog = [];
  }

  getHarnessContext(): string {
    if (!this.harnessEnabled || !this.harness) {
      return 'Harness not available';
    }
    return this.harness.getSessionContext();
  }

  isHarnessEnabled(): boolean {
    return this.harnessEnabled;
  }

  getHarness(): any {
    return this.harness;
  }

  getOperationLog(): Array<{ timestamp: number; action: string; args: any; result: any; status: string }> {
    return [...this.operationLog];
  }
}

// createAgentSession / getAgentSession / resetAgentSession / runSelfImproveLoop
//   已抽到 ./pi-sdk-session-factory.ts (2026-07-06), 从顶部 import 并 re-export

