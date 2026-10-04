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
// K10 ①: 运行生命周期写入经内核端口 (与 kernel/control.ts 的控制面分开 —— 一个回答"谁命令我停",
//   一个回答"我这一轮发生了什么"; 失败语义也不同: 控制面被拒 → 409, 事实写不进 → 响亮失败)
import { submitRunLifecycle, assertLifecycleOk } from '../kernel/run-lifecycle.js';
// K10 ④: 通信发送入口经内核端口 (上层不再直接对某条传输说话; 换传输只改这一处注入)
import { submitTransport, transportPeersSync, type TransportPorts } from '../kernel/transport.js';
// K10 ①: run 状态迁移经内核**控制面**端口 (它本来就管"谁命令这条 run 改状态": 带 origin 审计 + 拒绝归一化)
import { submitRunControl, type RunControlPorts } from '../kernel/control.js';
// K10 ②: 回合的模型经**内核运行时**只读取租约 (传输仍是 Pi 客户端 ⇒ 行为不变; 取不到如实回落)
import { ModelRuntime, snapshotFromSelection, type ModelConnection, type ModelSnapshot } from '../kernel/model-runtime.js';
// K10 余项: 会话生命周期的**规则**归内核 (落盘映射 · key 校验 · 读回过滤/水合 · 运行种子合并顺序), I/O 留本类经端口注入
import {
  submitSessionOp, assertSessionOk, composeRunSeed, filterSessionMessages, hydrateSessionMessages,
  type SessionPorts, type PersistedLike,
} from '../kernel/session-lifecycle.js';
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
import { WorkflowPivotLoop, createDefaultPivotConfig, type PivotLoopConfig, type LoopResult, type LLMInterface } from './workflow-pivot-loop.js';
import { nativeAdapterFromEnv } from '../llm/native-adapter.js';   // K9: 第二个 (非 Pi) 推理适配器
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
 * 写操作「读回自证」的实现已拆到 `./write-verify.js` (K10 ⑦):
 *   - 要接进 `pi-sdk-tools.ts` 的写类工具 ⇒ 留在这里会形成循环 import;
 *   - 原实现在函数体里用 `require('node:fs')`, 而产物是 ESM ⇒ 它此前**一次都没成功过**
 *     (只会被 catch 吞成 `[未核对] … require is not defined`)。
 * 这里保留**同名转出**, 老的 import 点不受影响。
 */
export { verifyWriteOutcome, withWriteVerified, WRITE_TOOLS } from './write-verify.js';

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
    // **K10 余项**: 合并顺序 (活跃运行打底 · extra 覆盖) 是内核规则 —— 与 `seed-run` 端口共用 `composeRunSeed`
    //   "活跃运行"这一处读取仍**只在本方法体内** (K2 播种的唯一读点, 有门钉住); 合并顺序由内核给。
    return createRunContext(composeRunSeed(this.actor!.state.activeRun, extra as Record<string, unknown>) as Partial<RunContext>);
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
          filter: (loaded) => filterSessionMessages(loaded as PersistedLike[]) as Message[],
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
      const hydrated = hydrateSessionMessages(loaded as PersistedLike[], maxMessages) as Message[];
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
  /**
   * **K10 余项**: 取数拍 (Actor 快照, 走邮箱 ⇒ 与 append 串行) 与真写入仍是本类的;
   *   而「消息 → 持久形态」的**映射规则**与 key 校验搬进内核 (`submitSessionOp` 的 `save-session`)。
   *   写不进 ⇒ 响亮失败 (`assertSessionOk`), 不静默继续。
   */
  async saveCurrentSession(key: string): Promise<void> {
    const out = await submitSessionOp({ op: 'save-session', origin: 'pi-session', key }, this.sessionPorts());
    assertSessionOk(out);
  }

  /** K10 余项: 会话生命周期端口实现 —— I/O 留本类, 规则在内核 (`kernel/session-lifecycle.ts`) */
  private sessionPorts(): SessionPorts {
    return {
      historySnapshot: () =>
        (this.actor ? this.actor.historySnapshot<Message>() : (this.actor!.state.messageHistory as Message[])),
      saveMessages: (key, messages) => this._sessionStore.saveMessages(key, messages as unknown as PersistedMessage[]),
      loadMessages: (key) => this._sessionStore.loadMessages(key) as never,
      // 注意: **故意不提供** `activeRunId` / `newRunContext` —— "活跃运行"的读取必须只有一处 (K2 播种唯一读点, 门钉住),
      //   本类走的是**同步** `seedRunContext` + 内核的 `composeRunSeed`。异步 `seed-run` 端口留给别的调用方 (其语义由内核门覆盖)。
    };
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
    // **K10 余项**: 读回过滤/水合规则归内核; 读失败 ⇒ 空数组, 但**原因进内核审计** (不再完全静默)
    const out = await submitSessionOp({ op: 'peek-history', origin: 'pi-session', key, maxMessages }, this.sessionPorts());
    return out.ok ? (out.result as Message[]) : [];
  }

  // **K10 余项 (减法)**: 原来的 `_filterToMessage` (合法 role 白名单 · 剔污染消息 · 保留"只有 tool call 无正文"的合法消息)
  //   已整条搬进内核 `kernel/session-lifecycle.ts` 的 `filterSessionMessages` —— 规则一处一份, 这里不再留副本。
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

    // K9 (2026-10-02): 同 `promptWithPivotLoop` —— **回合入口的可用性判据必须问当前适配器**。
    //   这类 `!minimaxAvailable` 闸一共 6 处: 1223(prompt)/1466(promptStream)/1714(pivot, 已修)
    //   是**回合入口** ⇒ 全部改用 `inferenceAvailable()`; 其余三处是 Pi 自己的文档类功能
    //   (`suggestRename`/`summarizeDocument`/`improveDocument`), 不在 `LLMInterface` 面内 ⇒ 如实保留。
    if (!this.inferenceAvailable()) {
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
        // K10 ①: 三处写入均经内核端口; 写不进就 assertLifecycleOk 抛 (run-store strict: 写不进 = 这次运行在事实层面不存在)
        const startOut = await submitRunLifecycle(
          {
            op: 'start-run',
            origin: 'pi-session',
            payload: {
              surface: this.runSurface,
              goal: this.currentUserInput || input.slice(0, 200),
              goalId: boundGoalId,
              channelId: this.actor!.state.channelId || undefined,
              agentId: this.actor!.state.agentId || undefined,
              modelConfig: await this.runModelSnapshot(),
            },
          },
          { startRun: startRun as unknown as (p: Record<string, unknown>) => Promise<unknown> },
        );
        assertLifecycleOk(startOut);
        const rec = startOut.result as { runId: string };
        this.lastRunId = rec.runId;
        await attachRun(boundGoalId, rec.runId).catch(() => null);
        const stepOut = await submitRunLifecycle(
          {
            op: 'record-step',
            origin: 'pi-session',
            runId: rec.runId,
            payload: { tool: 'llm', ok: false, error: 'LLM 不可用 (provider 未初始化/无 apiKey) → 走了 fallback' },
          },
          { recordStep: recordStep as unknown as (r: string, s: Record<string, unknown>) => Promise<unknown> },
        );
        assertLifecycleOk(stepOut);
        // 收尾漏斗门的登记项按**单行**匹配 (seams.ts:564 `ls.find(...)`) ⇒ 这次调用刻意写成一行, 好让登记项能钉住它
        const finOut = await submitRunLifecycle({ op: 'finish-run', origin: 'pi-session', runId: rec.runId, payload: { status: 'needs_human', error: 'LLM 不可用: provider 未初始化或无 apiKey (fallback 不是执行结果, 需要配置或人工处理)' } }, { finishRun: finishRun as unknown as (r: string, p: Record<string, unknown>) => Promise<unknown> });
        assertLifecycleOk(finOut);
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

    // K4-B (2026-10-02): **这条路已经只有一条** —— 原先这里有个 `if (this.usePivotLoop) { ... return ... }`
    //   的提前返回分支, 它的 finally 只是**子集** (只记正极性用法), 而且**少跑了**:
    //   回合后复盘 `runExperienceReview` · `monitorAfterReply`/`onStop` · `finishTrajectory(reply, ok|error)`
    //   · 负极性用法记账 · `bootstrapAddition`/`promptStartTime` 清理。现在统一走下面那条完整收尾。
    try {
      // K4-B (2026-10-02): **合并两套 loop ⇒ 只剩 pivot 这一套** (老 `runReActLoop` 已删除)。
      //   这里保留一个与原签名同形的 `loopResult`, 让下面那段**完整收尾**(自检 → 复盘 → 轨迹 → 记账)
      //   原样继续工作, 不搬家。
      const lr = await this.promptWithPivotLoop(input, undefined, options?.channelId);
      const loopResult = {
        reply: lr.response || '',
        aiFailed: !lr.success,
        aiFailureReason: String(lr.exitReason || ''),
      };

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
    console.log(`[PiAgent.promptStream] minimaxAvailable=${this.minimaxAvailable} nativeAdapter=${process.env.BOLLOON_NATIVE_ADAPTER === '1'} usable=${this.inferenceAvailable()}`);
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

    // K9: 流式入口同样问**当前适配器** (web/手机端就走这条路 —— 只修 pivot 那道闸时,
    //   CLI 通了、web 仍然静默空回复, 现象是"适配器被选中但这条路一次没跑")。
    if (!this.inferenceAvailable()) {
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

    // K4-B (2026-10-02): **流式路径也只剩一条** —— 原先这里有个 pivot 提前 return 分支,
    //   它自己的 finally 是**子集** (且少了 `contextHintAddition` 清理)。现在统一走下面的
    //   "外层重试 + 完整收尾", 而重试体里跑的是 pivot (老 `runReActLoop` 已删除)。
    //   重试语义**刻意保留**: 临时网络抖动/配额瞬时超限可自愈, 且状态文案被
    //   `reply-hygiene.test.ts` 与 `web-loop-status-bar.spec.ts` 两个用例锁着。

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
        const lr = await this.promptWithPivotLoop(userText, undefined, channelId);
        result = lr.response || '';
        // K4-B: 收尾自检在**这条**路径上也要跑 (原先只有 pivot 分支跑, 而 pivot 分支已被合并掉)
        await this.runTurnEndTypecheck();
        // 持久化失败不重试 (写不进去就是写不进去): 直接按本次结果收尾
        if (this.runPersistenceBlocked) break;
        if (lr.success) break;   // 正常完成, 退出 retry 循环
        lastAiFailureReason = String(lr.exitReason || 'AI 调用失败');
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
    this.contextHintAddition = '';   // K4-B: 与被合并掉的那条分支对齐 (它清了这条, 老尾段漏了)
    this.promptStartTime = 0;

    // 2026-08-08: 轨迹收尾 — 落盘 + OrbitDB (失败静默, 不阻塞回复)
    this.finishTrajectory(trajRec, result);

    return result;
  }

  /**
   * K9 (2026-10-02): 推理适配器的**唯一选择点** —— "用哪个适配器"只在这里决定一次。
   *
   *   `BOLLOON_NATIVE_ADAPTER=1` ⇒ 用**非 Pi** 的 native 适配器 (`src/llm/native-adapter.ts`,
   *     源码里不 import 任何 Pi 模块, 只用 fetch 直连 OpenAI 兼容端点);
   *   否则 ⇒ Pi 侧模型 (原行为, 默认不变)。
   *
   * 关键: 上层 (pivot loop / Harness 门 / Run / Channel) **一行都不用改** ——
   * 这正是 K10 撤换判据里「**出现第二个推理适配器能过同一套门**」要证的东西。
   */
  /** K9: 当前适配器是否可用 (native 开关打开且拿到 key ⇒ 用它自己的判据, 不再借 Pi 的) */
  private inferenceAvailable(): boolean {
    if (process.env.BOLLOON_NATIVE_ADAPTER === '1' && nativeAdapterFromEnv()) return true;
    return this.minimaxAvailable;
  }

  // ── K10 ②: 内核模型运行时的接缝 ────────────────────────────────────────────
  /** 进程内的内核运行时 (懒建)。传输由 `openPiConnection` 注入 ⇒ 真传输仍是 Pi 的客户端 */
  private runtimeSingleton?: ModelRuntime;

  private kernelModelRuntime(): ModelRuntime {
    if (!this.runtimeSingleton) {
      this.runtimeSingleton = new ModelRuntime(
        { openConnection: async (snapshot) => this.openPiConnection(snapshot) },
        30_000,
        4,
      );
    }
    return this.runtimeSingleton;
  }

  /** 端口实现: "开一条连接" = 拿 Pi 的 LLM 客户端 (进程级单例, 由 installRuntime 装配) */
  private async openPiConnection(snapshot: Readonly<ModelSnapshot>): Promise<ModelConnection> {
    const client = getMinimax() as unknown as { chat: (...a: any[]) => Promise<unknown> };
    return {
      id: `${snapshot.provider}:${snapshot.model}`,
      call: async (req) => {
        try {
          const raw = await client.chat(
            (req as any).context, (req as any).systemPrompt, (req as any).signal,
            (req as any).tools, (req as any).purpose, (req as any).source,
          );
          return { ok: true, provider: snapshot.provider, raw };
        } catch (err) {
          return { ok: false, provider: snapshot.provider, error: String((err as Error)?.message ?? err).slice(0, 300) };
        }
      },
      // Pi 客户端是**进程级单例** ⇒ 不随连接关闭 (连接池负责复用/计数)
      close: async () => { /* 见上 */ },
    };
  }

  /**
   * K10 ②: 用内核运行时取一个**租约**并适配成 `LLMInterface`。
   *   拿不到有效快照 / acquire 失败 ⇒ 返回 null ⇒ 调用方**如实记**并回落 Pi 直连 (不假装走了内核)。
   */
  private async kernelLeaseAdapter(): Promise<LLMInterface | null> {
    let snapshot: ModelSnapshot | null = null;
    try {
      const eff = await captureRunModelConfig();
      snapshot = snapshotFromSelection({ provider: eff.provider, model: eff.model, baseUrl: eff.baseUrl });
    } catch {
      return null;
    }
    if (!snapshot) return null;
    // ⚠️ 踩过的坑 (2026-10-02): 一开始在**适配器创建时**取一个租约、每次 chat 后 `lease.release()`
    //   ⇒ 第二次 chat 撞上「租约已归还」(model-runtime.ts:278 的守卫) ⇒ 适配器抛错 ⇒ 回合在第 2 轮就死
    //   (实测: k7-tsc-tool-e2e 允许路/拒绝路判红, 而强制 Pi 直连全绿)。
    //   正确姿势: **每次调用现取租约** (连接由池复用, 取租约几乎零成本), 用完立刻归还。
    const runtime = this.kernelModelRuntime();
    return {
      chat: async (context: string, systemPrompt: string, signal?: AbortSignal, tools?: unknown, purpose?: string, source?: string) => {
        let lease;
        try {
          lease = await runtime.acquire(snapshot);
        } catch (err) {
          throw new Error(`[kernel-model-runtime] acquire 失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
        }
        try {
          const res = await lease.call({ context, systemPrompt, signal, tools, purpose, source }, { signal });
          if (!res.ok) throw new Error(res.error || '内核模型调用失败');
          return res.raw as any;
        } finally {
          lease.release();                          // 归还租约 (连接由池管理, 不关)
        }
      },
    } as unknown as LLMInterface;
  }

  private async inferenceAdapter(): Promise<LLMInterface> {
    if (process.env.BOLLOON_NATIVE_ADAPTER === '1') {
      const a = nativeAdapterFromEnv();
      if (a) {
        console.log(`[PiAgent] 推理适配器 = ${a.providerId} (非 Pi: fetch 直连, 不 import Pi)`);
        return a as unknown as LLMInterface;
      }
      console.warn('[PiAgent] BOLLOON_NATIVE_ADAPTER=1 但没拿到 key ⇒ 回落 Pi 适配器 (不假装切换成功)');
    }
    // K10 ②: 先向**内核运行时**取租约 (只读 `acquire(snapshot)`) —— 超时/取消/退避/熔断/回退/记账由内核负责;
    //   传输仍是 Pi 客户端 (端口注入) ⇒ 行为不变。取不到就**如实记**并回落 Pi 直连 (不假装走了内核)。
    const leased = await this.kernelLeaseAdapter();
    if (leased) {
      console.log('[PiAgent] 推理适配器 = kernel-model-runtime (只读 acquire 租约)');
      return leased;
    }
    console.warn('[PiAgent] 内核租约不可用 ⇒ 回落 Pi 直连 (如实记, 不假装走了内核)');
    return getMinimax() as unknown as LLMInterface;
  }

  async promptWithPivotLoop(input: string, config?: PivotLoopConfig, channelId?: string): Promise<LoopResult> {
    this.actor!.state.channelId = channelId ?? this.actor!.state.channelId;
    // K9 (2026-10-02): **可用性判据必须问"当前适配器"**, 不能无条件问 Pi ——
    //   原先这里是 `if (!this.minimaxAvailable)`, 于是"换成第二个(非 Pi)适配器"仍然被 **Pi 的可用性**卡死
    //   (实跑现象: 适配器被选中、但 loop 一次都没跑、回复为空)。这类"隐式仍依赖 Pi"的点正是 K10 要清的。
    if (!this.inferenceAvailable()) {
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

    const llm = await this.inferenceAdapter();   // K10 ②: 可能要向内核运行时取租约 (异步)


    // K4-B (2026-10-02): **每次模型调用也要过门面** —— `beforeModelCall`/`afterModelCall` 原先**只**由老
    //   `runReActLoop` 调用; 老 loop 删除后全仓零调用者, 而 pivot (生产: web/CLI 现在都走它) **从来没调过**
    //   ⇒ 模型调用的前后留痕一直是断的。这里把门面包在 `llm` **外面** ⇒ pivot 内部一行不用改。
    //   ⚠️ 踩过的坑 (2026-10-02, 当场复现): 一开始把 `llm` 换成**纯函数**包一层 ⇒ 第 1 轮就空回复。
    //     原因: pivot 调的是 **`llm.chat(...)`** (对象方法), 不是 `llm(...)` ⇒ 换掉对象等于把 `.chat` 抹了。
    //     正确做法: 以**原型继承**造一个代理对象, 只覆写 `chat`, 其余成员照旧从原型上取。
    const llmWithHarness = Object.create(llm as object) as typeof llm;
    (llmWithHarness as any).chat = async (...args: any[]) => {
      try { this.piHarness().beforeModelCall(this.harnessCtx()); } catch { /* 门面异常不改变模型调用本身 */ }
      const __modelT0 = Date.now();
      try {
        return await (llm as any).chat(...args);
      } finally {
        try { this.piHarness().afterModelCall(this.harnessCtx(), { ms: Date.now() - __modelT0 }); } catch { /* 同上 */ }
      }
    };

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
        const execResult: any = await tool.execute(args);

        // K4-B (2026-10-02): **工具执行后的门面阶段必须跟上** —— `afterToolCall` (输出门:
        //   敏感信息拦截 / router hint) 原先**只**在老 `runReActLoop` 的工具分发里调用;
        //   老 loop 删除后生产里**一个调用者都没有** ⇒ 输出门形同停用 (安全回归)。补在 pivot 的唯一执行点上。
        //   门面内部对"gate 自己失败"的策略是**放行但留痕** (输出已产生, 拦不住源头) ⇒ 这里同样不改写结论。
        try {
          const after = await this.piHarness().afterToolCall({
            tool: tool.name,
            output: String(execResult?.output ?? ''),
            ctx: this.harnessCtx(),
            ok: execResult?.success !== false,
          });
          if (after?.outputBlocked) {
            // API 契约: "输出被 gate 拦下 ⇒ 调用方要把 result.output 换掉"
            const blocked = `[输出已被门拦下: ${after.outputBlocked.reason}] (原始输出未交付)`;
            if (execResult && typeof execResult === 'object') execResult.output = blocked;
          }
          if (after?.routeHint?.systemAddition) {
            // 差量如实记: 老 loop 把它拼进**下一轮的 system prompt**; pivot 没有对应的注入端口,
            //   这里改拼进**工具结果文本** —— 模型同样能在下一步看到 (送达渠道不同, 效果等价)。
            const hint = `\n[路由提示] ${after.routeHint.systemAddition}`;
            if (execResult && typeof execResult === 'object') execResult.output = String(execResult.output ?? '') + hint;
          }
        } catch { /* 后置阶段失败不改变已做出的执行 (门面内部已按策略留痕) */ }

        return execResult;
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
    // K4-B (2026-10-02): **run 生命周期也要过门面** —— `sessionStart`/`sessionEnd` 原先只由老
    //   `runReActLoop` 调用 (删除后全仓零调用者), 而 pivot (生产) 从来没调过 ⇒ 这里恢复。
    await this.piHarness().sessionStart(this.harnessCtx());
    let result: any;
    try {
      result = await loop.execute(input, llmWithHarness, systemPrompt + historyBlock, this.runCtx.eventSink ?? undefined, this.runCtx.abortSignal ?? undefined, onCompact);
    } finally {
      try { await this.piHarness().sessionEnd(this.harnessCtx()); } catch { /* 收尾留痕失败不改变本次结论 */ }
    }

    // K4-B (2026-10-02): `reviewFinal` (收尾目标对齐审查) 原先同样只在老 loop 里调 ⇒ 恢复**调用与留痕**。
    //   ⚠️ 如实记边界: pivot 的收尾仍由它自己的质量判定决定, 这里**不**按 review 的返回改流程
    //   (老 loop 会据它自动续跑一轮); 且这里给的是 pivot 手上**真有的**数据 (工具调用计数),
    //   `completedTools`/`actionLog` 的逐条清单 pivot 侧目前没有 ⇒ 传空并留 TODO, **不编数据**。
    try {
      const reviewDecision = this.piHarness().reviewFinal({
        reviewsDone: 0,
        userIntent: this.currentUserInput,
        completedTools: [],
        actionLog: [],
        runId: this.actor!.state.activeRun || undefined,
        goalId: this.actor!.state.goalBinding || undefined,
      } as any);
      console.log(`[PiAgent] reviewFinal (K4-B 恢复调用, 判定不参与流程): ${JSON.stringify(reviewDecision).slice(0, 160)}`);
    } catch { /* 审查异常不改变本次结论 (门面内部对"审查失效"自有留痕策略) */ }

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

  /**
   * K10 ①: 控制面的**注入面** —— 写原语来自 run-store, 但调用一律经 `submitRunControl`
   *   (与 `transportPorts()` 同一个模式: 换实现只改这一处, 上层不直接对 store 说话)。
   */
  private runControlPorts(): RunControlPorts {
    return {
      setRunStatus: setRunStatus as unknown as (runId: string, status: string, meta?: Record<string, unknown>) => Promise<unknown>,
      recordRecovery: recordRecovery as unknown as (runId: string, info: Record<string, unknown>) => Promise<unknown>,
    };
  }

  /**
   * 核心状态迁移的兜底: 失败 → 记降级 + 交给循环顶部的持久化硬闸 (不吞错)。
   * K10 ①: 迁移动作经内核控制面; **口径不变** ——
   *   `{ok:false}` 且原因是"端口拒绝"(状态迁移不合法) ⇒ 只返回 false (那不是持久化故障);
   *   未注入 / 抛错 ⇒ 才算持久化失败, 记降级 (与旧实现同款)。
   */
  private async safeSetRunStatus(runId: string, to: RunStatus): Promise<boolean> {
    const out = await submitRunControl(
      { kind: 'set-run-status', origin: 'pi-session', runId, payload: { status: to } },
      this.runControlPorts(),
    );
    if (out.ok) return true;
    const detail = String(out.detail || '未知原因');
    if (!detail.startsWith('端口拒绝')) {
      this.persistenceFailure = `状态迁移失败 (${to}): ${detail.slice(0, 180)}`;
      await recordDegradation({ kind: 'core', op: 'pi-sdk.setRunStatus', runId, message: this.persistenceFailure }).catch(() => {});
    }
    return false;
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

  // 2026-10-02 K4-B: 老 `runReActLoop` **已删除** (原 1123 行) —— 它曾经是"第二条 loop"
  //   并行存在的根源 (与 `WorkflowPivotLoop` 各跑一套, 行为按入口分叉: web=pivot / CLI=老 loop)。
  //   删除依据 (五条件): ① 唯一替代路径 = pivot (默认已切, 三处入口全走它) ② 全仓无引用 (只剩注释/测试名)
  //   ③ 真跑覆盖 = CLI 非流式带工具改文件 ✓ · Web 流式改 TS + 自检 ✓ · 同通道并发 3 条 ✓ ④ 全量回归 ✓
  //   ⑤ 可回滚提交点 = 本提交。
  //   它独有的记账 (TS 触达) 已上移到 pivot 的唯一执行点 `guardedExecute`, 口径归一。

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

  /**
   * K10 ④: 通信端口的**注入面** —— 传输实现仍在本仓网络层 (`src/network/**`), 内核只认形状。
   *   换传输 (hyperswarm → iroh → …) 时只改这一处; 上层一律走 `submitTransport`。
   */
  private transportPorts(): TransportPorts {
    return {
      send: (peerId: string, kind: string, payload: string) => p2pNetwork.sendMessage(peerId, kind as any, payload),
      broadcast: (kind: string, payload: string) => p2pNetwork.broadcast(kind as any, payload),
      peers: () => p2pNetwork.getPeers(),
      peersSync: () => p2pNetwork.getPeers(),
    };
  }

  private listPeers(): string {
    // K10 ④ 后半: 同步读也经端口 (`transportPeersSync`); 端口未注入 ⇒ 明确说"读不到", 不假装"没有对端"
    const peers = transportPeersSync(this.transportPorts());
    if (peers === null) return '（通信端口未注入: 读不到对端列表 —— 不是"没有对端", 是没接上）';
    if (peers.length === 0) {
      return '当前无连接的对等节点';
    }
    return `已连接节点 (${peers.length}):\n${peers.map(p => `  - ${p}`).join('\n')}`;
  }

  getPeers(): string[] {
    const peers = transportPeersSync(this.transportPorts());
    if (peers !== null) return peers;
    // 端口未注入时**回落到传输直读**并留痕: 同步读路径没有"拒绝"的余地, 静默返回空列表会被误读成"没有对端"
    console.warn('[kernel-transport] peersSync 端口未注入 ⇒ 回落直读传输 (K10 ④ 未接线的调用点)');
    return p2pNetwork.getPeers();
  }

  async sendMessage(peerId: string, message: string): Promise<void> {
    // K10 ④: 经内核通信端口。发送有副作用 ⇒ 未注入/被拒**一律响亮** (静默丢消息比报错更糟)
    const out = await submitTransport(
      { op: 'send', origin: 'pi-session', peerId, kind: 'message', payload: message },
      this.transportPorts(),
    );
    if (!out.ok) throw new Error(`[kernel-transport] send 未发出: ${out.detail ?? '未知原因'}`);
  }

  async broadcast(message: string): Promise<void> {
    const out = await submitTransport(
      { op: 'broadcast', origin: 'pi-session', kind: 'message', payload: message },
      this.transportPorts(),
    );
    if (!out.ok) throw new Error(`[kernel-transport] broadcast 未发出: ${out.detail ?? '未知原因'}`);
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

