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
import { getContextManager } from '../bootstrap/context-manager.js';
import { createRequire } from 'module';
// 2026-08-07: ESM 下裸 require 抛错被 catch 吞掉 → estimateHistoryTokens/maxContextTokens 静默失效
//   (状态栏恒 0 的第二层根因). 统一用 createRequire 加载 CJS 模块.
const _piRequire = createRequire(import.meta.url);
import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../constraints/index.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer, WorkflowContext } from './constraint-layer.js';
import { WorkflowEngine, WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
import { DeepThinkingEngine, AgentCoordinator, type ThinkResult, type AgentResult } from '@bolloon/constraint-runtime';
import { WorkflowPivotLoop, createDefaultPivotConfig, type PivotLoopConfig, type LoopResult } from './workflow-pivot-loop.js';
import { p2pDocumentTools, initDocumentReceiver } from './p2p-document-tools.js';
import { shellExec } from './shell-tool.js';
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
import { decideAfterReview, DEFAULT_MAX_REVIEWS } from './loop-review.js';

// PiSessionManager 已抽到 ./pi-sdk-session-manager.ts (2026-07-06)
// Tool / ToolResult / Message / StreamCallback / StreamEvent / HeartbeatConfig / AgentSession / TOOL_DEFINITIONS
//   已抽到 ./pi-sdk-types.ts (2026-07-06)

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
  private messageHistory: Message[] = [];
  private tools: Map<string, Tool> = new Map();
  /** 2026-06-30: tool registry 模块 — 独立 alias resolve, 测试可消融. */
  private _toolRegistry: ToolRegistry = new ToolRegistry();
  private skillRegistry: SkillRegistry = new SkillRegistry();
  /** M2.4: 缓存 tool 列表, registerTools() 之后不变, runReActLoop 多次循环复用 */
  private cachedToolDefinitions: string = '';
  /** M2.4: 缓存 persona section */
  private cachedPersonaSection: string = '';
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
  private usePivotLoop: boolean = false;
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
   * 当前 onStream 引用 + abort signal (computeJudgmentGate 需要 onStream 广播 phase)
   * 每次 prompt / promptStream / promptWithPivotLoop 入口设置, 用完即清
   */
  private currentOnStream: StreamCallback | null = null;
  private currentSignal: AbortSignal | null = null;
  /** Bootstrap SessionStart 拼的 system prompt 片段 (用完即清) */
  private bootstrapAddition: string = '';
  /** 当前 prompt 开始时间 (供 Stop hook 计算 durationMs) */
  private promptStartTime: number = 0;
  /** 当前 channel id (由 getAgentForChannel / prompt 4 参注入, 供 hook / log 使用) */
  private currentChannelId: string = '';
  /** 2026-07-04: 当前 agentId (server.ts 通过 createAgentSession 选项注入), 供 onSessionStart 加载 persona docs */
  private currentAgentId: string = '';

  /** M2.2 (2026-06-17): 当前轮的用户请求 intent, runReActLoop 拼 systemPrompt 时会读这个 */
  private currentIntent: 'question' | 'code_edit' | 'multi_step' | 'chitchat' | 'document' = 'chitchat';
  /** 2026-08-10: 本轮用户原始输入 (loop-review 任务动词兜底检测用) */
  private currentUserInput: string = '';
  private currentIntentHint: string = '';

  /**
   * 算 judgment 注入门: 失败静默, 不阻塞主对话
   * 期间通过 currentOnStream 广播 phase 事件, 前端可显示 "正在检索判断力..." 状态
   * 调用方负责用完即清 (judgmentGateAddition='')
   */
  private async computeJudgmentGate(input: string): Promise<void> {
    const safePhase = (phase: string, extra: Record<string, unknown> = {}) => {
      try {
        if (this.currentOnStream) {
          this.currentOnStream({ type: 'phase', phase, ...extra, content: '' } as any);
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
    this.cwd = config.cwd;
    this.peerId = config.peerId || 'local';
    this.identity = config.identityDoc || this.createDefaultIdentity();
    this.minimaxAvailable = this.checkMinimax();
    // 2026-07-04: 透传 agentId (server.ts 通过 createAgentSession 选项注入)
    this.currentAgentId = config.agentId || '';
    // 2026-06-30: 持久化层可注入 — 测试传 tmpDir, 业务用默认 ~/.bolloon/sessions/cache/
    this._sessionStore = (config as any).sessionStore ?? defaultSessionStore;
    this.constraintLayer = new ConstraintLayer();
    this.workflowEngine = new WorkflowEngine(this.constraintLayer);
    this.sessionManager = new PiSessionManager(this.identity.did, this.cwd);
    this.agentsManager = new DiscoveredAgentsManager();
    this.usePivotLoop = config.usePivotLoop ?? false;
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
      const loaded = await this._sessionStore.loadMessages(sessionKey);
      if (!loaded) {
        console.log(`[PiAgent] hydrate: 没有 ${sessionKey} 的历史`);
        return;
      }
      const hydrated = this._filterToMessage(loaded).slice(-maxMessages);
      if (hydrated.length > 0) {
        this.messageHistory = hydrated;
        console.log(`[PiAgent] 从 ${sessionKey} 回灌 ${hydrated.length} 条历史`);
      }
    } catch (err) {
      console.warn(`[PiAgent] hydrateMessageHistory 失败 (non-fatal): ${(err as Error).message?.slice(0, 100)}`);
    }
  }

  /**
   * 2026-06-30: 把当前 messageHistory 持久化到 SessionStore.
   * 公开方法 — claude code / 外部 harness 在每次 prompt 完成后调一下,
   *   即可获得"重启 / 跨进程接续"的语义.
   */
  async saveCurrentSession(key: string): Promise<void> {
    const persisted: PersistedMessage[] = this.messageHistory.map((m) => ({
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
    const before = this.messageHistory.length;
    await this.hydrateMessageHistory(key, maxMessages);
    return this.messageHistory.length - before;
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
          const ch = channels.find((c: any) => c.id === this.currentChannelId);
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
    const defs: string[] = ['可用工具 (name(params) - 简介):'];
    // 2026-07-29: 使用 allowedTools() 过滤掉拒绝列表中的工具
    for (const tool of this.allowedTools()) {
      // 2026-06-19: 压缩 tool 定义 — 只显示参数名 (不显示描述, 减少 60% 长度)
      //   完整 description 在 history 第一轮注入 (getToolDefinitionsFull 调用), 后续轮只看简短
      //   避免 system prompt 太大导致 minimax 撞 max_tokens 输出空
      const paramNames = Object.keys(tool.parameters).join(',');
      defs.push(`- ${tool.name}(${paramNames})`);
    }
    this.cachedToolDefinitions = defs.join('\n');
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
    return {
      did: `did:pi:${this.peerId.substring(0, 16)}`,
      name: `Agent-${this.peerId.substring(0, 8)}`,
      publicKey: this.peerId,
      createdAt: Date.now()
    };
  }

  private checkMinimax(): boolean {
    try {
      getMinimax();
      return true;
    } catch {
      return false;
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
        agentId: this.currentAgentId || 'default',
        input,
        channelId: channelId || this.currentChannelId,
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
    this.minimaxAvailable = this.checkMinimax();
    this.currentChannelId = options?.channelId ?? this.currentChannelId;

    // 2026-08-08: 运行轨迹采集 (落盘 + OrbitDB, 失败静默) — 包裹 onStream 收集步骤事件
    const trajRec = await this.createTrajectoryRecorder(input, options?.channelId);
    if (trajRec && options?.onStream) {
      options = { ...options, onStream: this.wrapTrajectoryStream(options.onStream, trajRec) };
    }

    this.messageHistory.push({
      role: 'user',
      content: input
    });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(input);
      this.messageHistory.push({ role: 'assistant', content: response });
      this.reportUsageToContextManager();
      this.finishTrajectory(trajRec, response);
      return response;
    }

    // P0 注入门
    this.currentSignal = options?.signal ?? null;
    this.currentOnStream = options?.onStream ?? null;
    await this.computeJudgmentGate(input);

    // M2.2 (2026-06-17): intent 分类 — prompt() 路径也跑 (跟 promptStream 对齐)
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.currentIntent = classifyIntent(input);
      this.currentIntentHint = intentHint(this.currentIntent);
      this.currentUserInput = input;
    } catch (err) {
      console.warn('[PiAgent] classifyIntent in prompt() failed:', err);
      this.currentIntent = 'chitchat';
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
        this.finishTrajectory(trajRec, lr.response || '');
        return lr.response || '';
      } finally {
        if (this.judgmentGateUsedIds.length > 0) {
          recordJudgmentUsage(this.judgmentGateUsedIds, { userInput: input }).catch((err) =>
            console.warn('[PiAgent] recordJudgmentUsage failed:', err)
          );
        }
        this.clearJudgmentGate();
        this.currentSignal = null;
        this.currentOnStream = null;
        this.reportUsageToContextManager();
      }
    }

    try {
      // 2026-06-16: runReActLoop 现在返回 { reply, aiFailed, aiFailureReason } — 这里只需 reply 字符串
      const loopResult = await this.runReActLoop(this.currentOnStream ?? undefined, options?.signal);
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
      this.currentSignal = null;
      this.currentOnStream = null;
      this.reportUsageToContextManager();
    }
  }

  async promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal, channelId?: string): Promise<string> {
    console.log(`[PiAgent.promptStream] ENTRY, channelId=${channelId}, input chars=${input.length}`);
    this.minimaxAvailable = this.checkMinimax();
    console.log(`[PiAgent.promptStream] minimaxAvailable=${this.minimaxAvailable}`);
    this.currentChannelId = channelId ?? this.currentChannelId;

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

    this.messageHistory.push({
      role: 'user',
      content: userText
    });
    // 2026-06-18: web server 喂的 markedPrompt 外的 contextHint 拼到 system 末尾 (而不是当 user message)
    this.contextHintAddition = contextHint;

    onStream({ type: 'thinking', content: '🤔 开始思考...' });

    if (!this.minimaxAvailable) {
      const response = await this.handleFallback(userText);
      this.messageHistory.push({ role: 'assistant', content: response });
      onStream({ type: 'done', content: '' });
      this.reportUsageToContextManager();
      this.finishTrajectory(trajRec, response);
      return response;
    }

    // P0 注入门: 缓存 onStream + signal, computeJudgmentGate 用 currentOnStream 广播 phase
    this.currentOnStream = onStream;
    this.currentSignal = signal ?? null;
    await this.computeJudgmentGate(userText);

    // M2.2 (2026-06-17): intent 分类 — 0 LLM 成本, 5 行 keyword 匹配
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.currentIntent = classifyIntent(userText);
      this.currentIntentHint = intentHint(this.currentIntent);
      this.currentUserInput = userText;
      if (this.currentIntent !== 'chitchat') {
        onStream({ type: 'phase', phase: 'intent_classified', detail: this.currentIntent, content: '' } as any);
      }
    } catch (err) {
      console.warn('[PiAgent] classifyIntent failed (non-fatal):', err);
      this.currentIntent = 'chitchat';
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
        channelId: this.currentChannelId || undefined,
        agentId: this.currentAgentId || undefined,
      });
      bootstrapAddition = ss.systemAddition || '';
    } catch (err) {
      console.warn('[PiAgent] onSessionStart failed (non-fatal):', err);
    }

    // 2026-07-07 P1-B: 注入最近 5 条项目事件日志 (L2) — 让 LLM 知道项目状态/feature 变化
    // 失败静默, append 到 bootstrapAddition 末尾 (超 800 字截断)
    if (this.currentChannelId) {
      try {
        const { getRecentEvents } = await import('../bootstrap/event-log.js');
        const events = await getRecentEvents(this.currentChannelId, 5);
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
        const state = await readState({ channelId: this.currentChannelId });
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
        const indexName = `channel-${this.currentChannelId}`;
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
          channelId: this.currentChannelId || 'unknown',
          durationMs: Date.now() - stopStartTime,
          usedJudgmentIds: [...this.judgmentGateUsedIds],
        }).catch((err) => console.warn('[PiAgent] onStop failed:', err));
        this.clearJudgmentGate();
        this.currentOnStream = null;
        this.currentSignal = null;
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
        if (!loopResult.aiFailed) break; // 正常完成, 退出 retry 循环
        lastAiFailureReason = loopResult.aiFailureReason || 'AI 调用失败';
      } catch (err: any) {
        // abort 失败: 视作"已中断", 抛错让上层用 partial 兜底
        this.currentOnStream = null;
        this.currentSignal = null;
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
        onStream({ type: 'status', content: `↻ 自动重试 loop ${attempt}/${MAX_LOOP_RETRIES} (${(backoffMs / 1000).toFixed(0)}s 后)`, tool: 'system' });
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
      if (this.messageHistory.length > 0 && this.messageHistory[this.messageHistory.length - 1].role === 'assistant') {
        this.messageHistory.pop();
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
      channelId: this.currentChannelId || 'unknown',
      durationMs: Date.now() - stopStartTime,
      usedJudgmentIds: [...this.judgmentGateUsedIds],
    }).catch((err) => console.warn('[PiAgent] onStop failed:', err));

    // 用完即清, 避免污染下一轮
    this.clearJudgmentGate();
    this.currentOnStream = null;
    this.reportUsageToContextManager();
    this.currentSignal = null;
    this.bootstrapAddition = '';
    this.promptStartTime = 0;

    // 2026-08-08: 轨迹收尾 — 落盘 + OrbitDB (失败静默, 不阻塞回复)
    this.finishTrajectory(trajRec, result);

    return result;
  }

  async promptWithPivotLoop(input: string, config?: PivotLoopConfig, channelId?: string): Promise<LoopResult> {
    this.currentChannelId = channelId ?? this.currentChannelId;
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
    const loopConfig = config || this.pivotLoopConfig || createDefaultPivotConfig();
    const loop = new WorkflowPivotLoop(loopConfig);

    for (const tool of this.tools.values()) {
      loop.registerTool(tool);
    }

    // P0 注入门: 在构造 systemPrompt 之前算一次, 拼到末尾
    await this.computeJudgmentGate(input);

    // M2.2 (2026-06-17): intent 分类 — pivot loop 也要拿到 hint
    try {
      const { classifyIntent, intentHint } = await import('./intent-classifier.js');
      this.currentIntent = classifyIntent(input);
      this.currentIntentHint = intentHint(this.currentIntent);
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

    // 2026-06-15: 把 currentOnStream 传给 loop, 让 step-timeline 在 pivot 循环里也能 emit step_start/done
    //   之前 loop.execute() 不接 streamCallback, 导致 step-timeline 只能看到老 runReActLoop 路径
    //   promptWithPivotLoop 路径 0 step events — UI 显示 timeline 但永远是空
    // 2026-06-17: 透传 signal 让 abort 工作 — loop.execute() 当前不接 signal 参数,
    //   所以 abort 行为通过 this.currentSignal 共享给 loop 内部读 (后续 M3.2 接 task plan 时一起加)
    // 2026-07-06: pivot 内 token 累计到 ~70% 时回调 (workflow-pivot-loop.ts line 270+).
    //   pivot 的 messageHistory 是 process-local, 不和 pi-sdk 的 this.messageHistory 同步.
    //   真正折叠需要把 pi-sdk 历史灌回 pivot 的 history 数组 — 侵入较大.
    //   当前 priority: 临时传空实现, 让 budget 公式放够 (workflow-pivot-loop.ts line 220)
    //   不再撞预算. 这条路径留作技术债.
    // 2026-07-17 Bug 1 修: 注入 messageHistory (hydrateMessageHistory 从 session JSON 回灌的) 到 system prompt
    //   pivot loop execute() 内部自己维护 messageHistory, 跟 pi-sdk 的 this.messageHistory 隔离,
    //   不注入的话 LLM 看不到历史对话, 每次都是新对话.
    const historyLines: string[] = [];
    const historyToInject = this.messageHistory.slice(-20, -1);
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
    const result = await loop.execute(input, llm, systemPrompt + historyBlock, this.currentOnStream ?? undefined, this.currentSignal ?? undefined, onCompact);

    if (result.response) {
      this.messageHistory.push({ role: 'assistant', content: result.response });
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
    const MAX_SAME_TOOL_FAILURES = 3; // 同一工具连续失败 3 次, 强制让 LLM 给出最终答案
    // 2026-07-29: Hermes 风格硬限制 — 防死循环 (不再靠 soft hint)
    const MAX_IDEMPOTENT_TOOL = 5;  // 同工具成功调 5 次 → 注入 hint 强制 final gen
    const MAX_TOOL_CALLS_PER_LOOP = 25; // 单轮循环总工具调用上限 → 注入 hint
    let totalToolCallsThisLoop = 0;
    const lastNTools: string[] = []; // 最近 MAX_IDEMPOTENT_TOOL 次工具名, 检测重复
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
      onStream({ type: 'status', content: '🔄 开始 ReAct 循环...', tool: 'system' });
    }

    // React Harness: 循环开始 (重置 turn 计数 + 触发 harness sessionStart)
    // 失败静默 (fail-open), 不阻塞主循环
    try {
      await this.reactHarness.onSessionStart(this.currentChannelId || undefined);
    } catch (err) {
      console.warn('[PiAgent] reactHarness.onSessionStart failed (non-fatal):', err);
    }

    // 2026-07-29: Hook onLoopStart
    try {
      await this._hooks.fire('onLoopStart', { event: 'onLoopStart', channelId: this.currentChannelId, agentId: this.currentAgentId });
    } catch { /* hook 失败静默 */ }

    while (iteration < this.MAX_REACT_ITERATIONS) {
      iteration++;

      // 停止条件 1: max turns (fail-safe 10000, 正常任务永远跑不到)
      //   2026-07-01 (v0.2.4 子任务 1): 委托给 react-loop.decideMaxIterations 纯函数
      const maxIterDecision = decideMaxIterations(iteration, this.MAX_REACT_ITERATIONS);
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
        this.messageHistory.push({ role: 'system', content: `[注意] 你已连续调用 ${MAX_TOOL_CALLS_PER_LOOP} 次工具。请基于已有结果直接回答用户, 不要再次调用任何工具。在回答末尾加 <final gen> 标记结束。` });
        totalToolCallsThisLoop = 0;  // 重置计数器, 只防连续死循环
      }
      if (lastNTools.length >= MAX_IDEMPOTENT_TOOL && new Set(lastNTools).size === 1) {
        const repeatedTool = lastNTools[0];
        console.warn(`[PiAgent] 同工具 ${repeatedTool} 连续成功调 ${MAX_IDEMPOTENT_TOOL} 次, 注入 hint 让 LLM 总结`);
        onStream?.({ type: 'error', content: `⏹️ 工具 ${repeatedTool} 重复调用 ${MAX_IDEMPOTENT_TOOL} 次, 请基于已有结果回答`, tool: 'loop' });
        this.messageHistory.push({ role: 'system', content: `[注意] 你已连续 ${MAX_IDEMPOTENT_TOOL} 次调用 ${repeatedTool}。请基于已有结果直接回答用户, 不要再次调用任何工具。在回答末尾加 <final gen> 标记结束。` });
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
        onStream?.({ type: 'status', content: `🗜️ loop 自动压缩 (token ${tokensBeforeCompact} > ${compactThreshold})`, tool: 'compactor' });
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
        onStream({ type: 'status', content: `🔄 循环 ${iteration}/${this.MAX_REACT_ITERATIONS}`, tool: 'loop' });
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

      const systemPrompt = `${this.bootstrapAddition}你是 ${this.identity.name}，基于ReAct (Reasoning + Acting)模式工作。${personaSection}
当前工作目录: ${this.cwd}
当前身份: ${this.identity.name} (${this.identity.did})
${refineContext}
${this.currentIntentHint}
${loopProgressSection}

${toolDefs}

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
      const response = await this.callLlmWithRecovery(llm, messages, systemPrompt, signal, onStream, openaiFormattedTools);
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
        this.messageHistory.push({
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
        const knownTools = new Set(Array.from(this.tools.keys()));
        toolCalls = parseAllToolCalls(reply, { tools: knownTools });
      }

      // 回退路径 C: 原生 parseToolCall (单个)
      if (toolCalls.length === 0) {
        const single = this.parseToolCall(reply);
        if (single) toolCalls.push(single);
      }

      // 给每个 toolCall 分配稳定 id
      for (const tc of toolCalls) {
        if (!(tc as any).id) {
          (tc as any).id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }
      }

      if (toolCalls.length > 0) {
        // 把原始 LLM 回复 push 进 history (仅一次)
        this.messageHistory.push({
          role: 'assistant',
          content: reply,
          toolCalls: toolCalls.length > 1 ? toolCalls : [toolCalls[0]],
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
            onStream({ type: 'status', content: `📋 参数: ${JSON.stringify(toolCall.args)}`, tool: toolCall.name });
          }
          onStream({
            type: 'step_start',
            content: `调用 ${toolCall.name}${isMulti ? ` (${ti + 1}/${toolCalls.length})` : ''}`,
            tool: toolCall.name,
            args: toolCall.args || {},
          });
        }

        // 2026-07-29: Unified Deny-First Pipeline — 统合所有拒绝检查
        let denyResult: Awaited<ReturnType<DenyPipeline['check']>> = { denied: false, reason: '', source: '' };
        try {
          denyResult = await this._denyPipeline.check({
            toolName: toolCall.name,
            toolArgs: toolCall.args || {},
            permissionMode: this.currentPermissionMode,
            channelId: this.currentChannelId,
            agentId: this.currentAgentId,
          } as DenyContext);
        } catch { /* pipeline 失败不阻塞工具调用 */ }
        if (denyResult.denied) {
          consecutiveErrors++;
          totalErrors++;
          const denyResultMsg: ToolResult = { success: false, error: `拒绝: [${denyResult.source}] ${denyResult.reason}` };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(denyResultMsg), toolResult: denyResultMsg });
          this.logToHarness(toolCall.name, toolCall.args, denyResultMsg);
          return;
        }
        if (denyResult.systemAddition) {
          this.contextHintAddition += '\n' + denyResult.systemAddition;
        }

        const tool = this.tools.get(toolCall.name);
        if (!tool) {
          consecutiveErrors++;
          totalErrors++;
          const errorResult: ToolResult = { success: false, error: `未知工具: ${toolCall.name}` };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          // 2026-07-28: 注入 Reflection 帮助 LLM 理解错误
          const obs = buildObservation(toolCall.name, toolCall.args, errorResult);
          const ref = buildReflection(toolCall.name, errorResult.error, totalErrors, lastFailedToolCount);
          this.messageHistory.push({ role: 'system', content: formatObservationWithReflection(obs, ref) });
          if (onStream) onStream({ type: 'status', content: `💡 Reflection: ${obs.summary}`, tool: 'system' });
          console.warn(`[PiAgent] 未知工具: ${toolCall.name} (累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS})，跳过并继续`);
          return;
        }

        // Bootstrap PreToolUse hook: 调工具前校验 (危险命令拦截)
        // 失败静默 — hook 自身挂掉 = 放行
        // P2: 透传 permissionMode (从 BootstrapOptions / env BOLLOON_PERM_MODE 解析)
        let toolToExecute = tool;
        try {
          const pre = await onPreToolUse({
            tool: toolCall.name,
            args: toolCall.args || {},
            permissionMode: this.currentPermissionMode,
          });
          if (!pre.allowed) {
            const deniedResult: ToolResult = {
              success: false,
              error: `PreToolUse 拒绝: ${pre.reason || '未通过安全校验'}`,
            };
            this.messageHistory.push({ role: 'tool', content: JSON.stringify(deniedResult), toolResult: deniedResult });
            this.logToHarness(toolCall.name, toolCall.args, deniedResult);
            if (onStream) {
              onStream({ type: 'error', content: `🛡️ PreToolUse 拒绝 ${toolCall.name}: ${pre.reason || '安全校验失败'}`, tool: toolCall.name });
              onStream({ type: 'step_error', content: `PreToolUse 拒绝 ${toolCall.name}`, tool: toolCall.name, error: pre.reason || '安全校验失败' });
            }
            console.warn(`[PiAgent] PreToolUse denied ${toolCall.name}: ${pre.reason}`);
            // 拒绝也算错误, 让错误恢复机制触发
            consecutiveErrors++;
            totalErrors++;
            if (toolCall.name === lastFailedTool) { lastFailedToolCount++; }
            else { lastFailedTool = toolCall.name; lastFailedToolCount = 1; }
            if (lastFailedToolCount >= MAX_SAME_TOOL_FAILURES) {
              this.messageHistory.push({ role: 'system', content: `[注意] 工具 ${toolCall.name} 被系统拒绝 (连续 ${MAX_SAME_TOOL_FAILURES} 次). 请不要再次尝试, 直接用已有信息回答用户, 末尾加 <final gen>.` });
              lastFailedTool = ''; lastFailedToolCount = 0; consecutiveErrors = 0;
            } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              this.messageHistory.push({ role: 'system', content: `[注意] 连续 ${consecutiveErrors} 次工具调用被系统拒绝. 请换其他工具或直接回答用户, 末尾加 <final gen>.` });
              consecutiveErrors = 0;
            }
            return;
          }
        } catch (err) {
          console.warn('[PiAgent] onPreToolUse failed (non-fatal, allowing):', err);
        }

        // React Harness: 8-gate + builtin-guards 校验 (串接双层)
        try {
          const pre = await this.reactHarness.preToolCall(toolCall.name, toolCall.args || {}, this.currentChannelId || undefined);
          if (!pre.allowed) {
            const deniedResult: ToolResult = { success: false, error: `Harness gate 拒绝 (${pre.details.rejectedBy}): ${pre.reason || '未通过安全校验'}` };
            this.messageHistory.push({ role: 'tool', content: JSON.stringify(deniedResult), toolResult: deniedResult });
            this.logToHarness(toolCall.name, toolCall.args, deniedResult);
            if (onStream) {
              onStream({ type: 'error', content: `🛡️ Harness ${pre.details.rejectedBy} 拒绝 ${toolCall.name}: ${pre.reason || '安全校验失败'}`, tool: toolCall.name });
              onStream({ type: 'step_error', content: `Harness 拒绝 ${toolCall.name}`, tool: toolCall.name, error: pre.reason || '安全校验失败' });
            }
            console.warn(`[PiAgent] Harness denied ${toolCall.name} (${pre.details.rejectedBy}): ${pre.reason}`);
            consecutiveErrors++; totalErrors++;
            if (toolCall.name === lastFailedTool) { lastFailedToolCount++; }
            else { lastFailedTool = toolCall.name; lastFailedToolCount = 1; }
            if (lastFailedToolCount >= MAX_SAME_TOOL_FAILURES) {
              this.messageHistory.push({ role: 'system', content: `[注意] 工具 ${toolCall.name} 被 Harness 拒绝 (连续 ${MAX_SAME_TOOL_FAILURES} 次). 请不要再次尝试, 末尾加 <final gen>.` });
              lastFailedTool = ''; lastFailedToolCount = 0; consecutiveErrors = 0;
            } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              this.messageHistory.push({ role: 'system', content: `[注意] 连续 ${consecutiveErrors} 次工具调用被 Harness 拒绝. 请换其他工具或直接回答.` });
              consecutiveErrors = 0;
            }
            return;
          }
        } catch (err) {
          console.warn('[PiAgent] reactHarness.preToolCall failed (non-fatal, allowing):', err);
        }

        try {
          const toolStart = Date.now();
          let result = await tool.execute(toolCall.args);
          const toolDurationMs = Date.now() - toolStart;
          console.log(`[PiAgent] 工具 ${toolCall.name} 执行完成: success=${result.success} (${toolDurationMs}ms)`);

          try { await onPostToolUse({ tool: toolCall.name, args: toolCall.args || {}, result: { success: result.success, output: result.output?.substring(0, 500), error: result.error }, durationMs: toolDurationMs }); }
          catch (postErr) { console.warn('[PiAgent] onPostToolUse failed (non-fatal):', postErr); }

          const routeHint = this.reactHarness.getLastRouteHint();
          if (routeHint && routeHint.systemAddition) {
            this.messageHistory.push({ role: 'system', content: `[Harness Router Hint: ${routeHint.reason}]\n${routeHint.systemAddition}` });
            this.reactHarness.clearRouteHint();
          }

          try {
            const post = await this.reactHarness.postToolCall(toolCall.name, String(result.output || ''), this.currentChannelId || undefined);
            if (!post.allowed) {
              if (onStream) { onStream({ type: 'error', content: `🛡️ Harness output 拒绝 ${toolCall.name}: ${post.reason || '输出含敏感信息'}`, tool: toolCall.name }); }
              console.warn(`[PiAgent] Harness output denied ${toolCall.name}: ${post.reason}`);
              result = { ...result, output: `[harness output gate: 输出含敏感内容, 已屏蔽. 原因: ${post.reason || 'unknown'}]`, _harnessDenied: true } as typeof result;
            }
          } catch (err) { console.warn('[PiAgent] reactHarness.postToolCall failed (non-fatal, allowing):', err); }

          this.messageHistory.push({ role: 'tool', content: JSON.stringify(result), toolResult: result, toolCallId: (toolCall as any).id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` });
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
              onStream({ type: 'status', content: `✅ ${toolCall.name} 执行成功`, tool: toolCall.name });
              if (result.output) { onStream({ type: 'tool', content: `📤 结果: ${result.output.substring(0, 200)}${result.output.length > 200 ? '...' : ''}`, tool: toolCall.name }); }
              onStream({ type: 'step_done', content: `${toolCall.name} 执行成功`, tool: toolCall.name, success: true, output: result.output });
            } else {
              onStream({ type: 'error', content: `❌ ${toolCall.name} 执行失败: ${result.error}`, tool: toolCall.name });
              onStream({ type: 'step_error', content: `${toolCall.name} 执行失败`, tool: toolCall.name, error: result.error });
            }
          }

          if (result.success) {
            consecutiveErrors = 0;
            // 2026-07-29: Hermes 风格硬限制计数
            totalToolCallsThisLoop++;
            lastNTools.push(toolCall.name);
            if (lastNTools.length > MAX_IDEMPOTENT_TOOL) lastNTools.shift();
            if (result.output) { this.successfulToolResults.push({ tool: toolCall.name, outputPreview: result.output.substring(0, 200) + (result.output.length > 200 ? '...' : '') }); }
            else { this.successfulToolResults.push({ tool: toolCall.name, outputPreview: '(无输出)' }); }
            loopReviewCompletedTools.add(toolCall.name);
            lastQualityScore = this.estimateToolResultQuality(result);
            if (lastQualityScore < this.QUALITY_THRESHOLD && refineAttempts < this.MAX_REFINE_ATTEMPTS) { refineAttempts++; }
            if (onStream) { onStream({ type: 'status', content: `🔄 工具执行完成，继续循环...`, tool: 'loop' }); }
          } else {
            consecutiveErrors++;
            totalErrors++;
            if (toolCall.name === lastFailedTool) { lastFailedToolCount++; }
            else { lastFailedTool = toolCall.name; lastFailedToolCount = 1; }
            console.warn(`[PiAgent] 工具 ${toolCall.name} 执行失败 (${lastFailedToolCount}/${MAX_SAME_TOOL_FAILURES}, 累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS}): ${result.error}`);
            // 2026-07-28: 注入 Observation + Reflection 替代旧 hardcode 提示
            const obs = buildObservation(toolCall.name, toolCall.args, { success: false, error: result.error });
            const ref = buildReflection(toolCall.name, result.error, totalErrors, lastFailedToolCount);
            this.messageHistory.push({ role: 'system', content: formatObservationWithReflection(obs, ref) + SHELL_ESCAPE_HINT });
            if (onStream) onStream({ type: 'status', content: `💡 Reflection: ${obs.summary} → ${ref[0]?.action || '放弃'}`, tool: 'system' });
            if (lastFailedToolCount >= MAX_SAME_TOOL_FAILURES) {
              this.messageHistory.push({ role: 'system', content: `[注意] 工具 ${toolCall.name} 在这个上下文中不可用 (连续 ${MAX_SAME_TOOL_FAILURES} 次失败: ${result.error}). 请不要再次调用它, 直接用你已知的信息回答用户, 并在回答开头标记 <final gen>.` });
              lastFailedTool = ''; lastFailedToolCount = 0; consecutiveErrors = 0;
              return;
            }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              this.messageHistory.push({ role: 'system', content: `[注意] 前面的工具调用连续失败。请尝试其他工具或换一种方式完成用户请求, 或用 <final gen> 给出最终回答.` });
              consecutiveErrors = 0;
            }
          }
        } catch (execError) {
          consecutiveErrors++;
          totalErrors++;
          const errorResult: ToolResult = { success: false, error: String(execError) };
          this.messageHistory.push({ role: 'tool', content: JSON.stringify(errorResult), toolResult: errorResult });
          this.logToHarness(toolCall.name, toolCall.args, errorResult);
          const obs = buildObservation(toolCall.name, toolCall.args, errorResult);
          const ref = buildReflection(toolCall.name, errorResult.error, totalErrors, lastFailedToolCount);
          this.messageHistory.push({ role: 'system', content: formatObservationWithReflection(obs, ref) + SHELL_ESCAPE_HINT });
          if (onStream) onStream({ type: 'status', content: `💡 Reflection: ${obs.summary}`, tool: 'system' });
          console.error(`[PiAgent] 工具执行异常 (累计 ${totalErrors}/${this.MAX_TOTAL_ERRORS}): ${execError}`);
        }
        })); // end Promise.all(toolCalls.map(async ...))
        // 所有工具执行完毕后, continue while 循环, 让 LLM 看到结果
        continue;
        } else {
        // LLM 返回的不是 tool call 格式
        this.messageHistory.push({
          role: 'assistant',
          content: reply
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
            this.messageHistory.push({
              role: 'system',
              content: `[dive-into stop condition] 你之前已成功执行了 ${unreported} 个工具, 但当前回复里没把它们的结果告诉用户. 请基于已有的工具结果 (在 history 里) 写一个完整总结回复给用户, 用 <final gen> 结尾. 不要再调工具.`
            });
            if (onStream) {
              onStream({ type: 'status', content: `🔄 还有 ${unreported} 个工具结果未汇报, 让 LLM 继续总结 (${unreportedRetries}/${MAX_UNREPORTED_RETRIES})`, tool: 'system' });
            }
            continue;
          } else if (unreportedDecision === 'force-final') {
            // 反复提示仍未汇报超过上限 → 清空积压强制 final, 不再死循环
            console.log(`[PiAgent] unreported 循环超限 (${unreportedRetries} 次), 清空积压强制 final`);
            this.successfulToolResults = [];
            this.messageHistory.push({
              role: 'system',
              content: `[dive-into stop condition] 已多次提示汇报工具结果仍未完成 (超过 ${MAX_UNREPORTED_RETRIES} 次). 现在直接基于你已知的信息写最终回复给用户, 用 <final gen> 结尾, 不要再调任何工具.`
            });
            if (onStream) {
              onStream({ type: 'status', content: `🔄 工具结果汇报超限, 强制收尾`, tool: 'system' });
            }
          }
lastQualityScore = this.estimateResponseQuality(reply);
          // 2026-07-29: 质量门 — 即使 LLM 声称完成, 质量太低也继续
          if (lastQualityScore < this.QUALITY_THRESHOLD && refineAttempts < this.MAX_REFINE_ATTEMPTS) {
            console.log(`[PiAgent] final gen 质量 ${lastQualityScore.toFixed(2)} < ${this.QUALITY_THRESHOLD}, 注入 refine hint`);
            this.messageHistory.push({ role: 'system', content: `[质量检查] 你的回答质量评分为 ${(lastQualityScore * 10).toFixed(1)}/10, 低于 ${(this.QUALITY_THRESHOLD * 10).toFixed(1)}/10 阈值。请提供更完整、详细的回答, 包含工具调用获取到的具体信息, 末尾加 <final gen>。` });
            refineAttempts++;
            continue;
          }

          // 2026-08-08: final 前目标对齐 review — 不潦草收尾 (见 loop-review.ts)
          //   LLM 想 <final gen> 时, 先跑 1-2 次「目标对齐 + 需求深挖」review;
          //   达成用户需求才放行真正结束. 达上限或无需深挖则以用户需求为准结束.
          const reviewDecision = decideAfterReview({
            reviewsDone: loopReviewCount,
            // 2026-08-10: 传用户原始输入 (不是派生 intentHint) — LLM 对照原文自查完成度,
            //   未完成 → 自动继续调工具 (自动触发后续步骤)
            userIntent: this.currentUserInput,
            completedTools: Array.from(loopReviewCompletedTools),
            actionLog: loopActionLog,
          }, DEFAULT_MAX_REVIEWS);
          if (reviewDecision.kind === 'continue-review') {
            loopReviewCount++;
            console.log(`[PiAgent] review ${loopReviewCount}/${DEFAULT_MAX_REVIEWS}: LLM 想 final 但先对齐需求深挖一次`);
            this.messageHistory.push({ role: 'system', content: reviewDecision.hint });
            if (onStream) {
              onStream({ type: 'status', content: `🔄 目标对齐 review ${loopReviewCount}/${DEFAULT_MAX_REVIEWS}: 深挖续跑`, tool: 'system' });
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
            onStream({ type: 'status', content: `🔄 继续处理，循环 ${iteration}...`, tool: 'loop' });
          }
          continue;
        }

        // 否则把这个当作可能的最终回答
        finalResponse = reply;
        if (onStream) {
          onStream({ type: 'status', content: `📝 提取最终回答，长度 ${reply.length}`, tool: 'system' });
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
      onStream({ type: 'status', content: `✅ 处理完成，共 ${iteration - 1} 次循环`, tool: 'system' });
    }

    this.messageHistory.push({ role: 'assistant', content: finalResponse });

    // React Harness: 循环结束
    try {
      await this.reactHarness.onSessionEnd();
    } catch (err) {
      console.warn('[PiAgent] reactHarness.onSessionEnd failed (non-fatal):', err);
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
    const source = this.projectedHistory ?? this.messageHistory;
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
      const source = this.projectedHistory ?? this.messageHistory;
      const WINDOW = 15;
      const out: Array<{ role: string; content: string }> = [];

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
          if (r === 'tool') {
            out.push({ role: 'user', content: `[工具结果]\n${(m.content || '').slice(0, 2000)}` });
            continue;
          }
          if (r === 'assistant') { out.push({ role: 'assistant', content: (m.content || '').slice(0, 4000) }); continue; }
          if (r === 'user') { out.push({ role: 'user', content: (m.content || '').slice(0, 2000) }); continue; }
          if (r === 'system') { out.push({ role: 'system', content: (m.content || '').slice(0, 2000) }); }
        }
        return out;
      }

      // 窗口内: 原逻辑 (tool 转 user role, 避免 tool_calls 配对)
      const slice = source.slice(-WINDOW);
      for (const m of slice) {
        const r = m.role;
        if (r === 'tool') {
          out.push({ role: 'user', content: `[工具结果]\n${m.content || ''}` });
          continue;
        }
        if (r === 'assistant') {
          out.push({ role: 'assistant', content: m.content || '' });
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
   * 估算 messageHistory 的 token 数 (4 字符 ≈ 1 token, 与 context-compaction 同步).
   * 失败静默: 任何异常 → 0 (不阻塞)
   */
  private estimateHistoryTokens(): number {
    try {
      const { estimateTokens } = _piRequire('../context-compaction/index.js') as typeof import('../context-compaction/index.js');
      return estimateTokens(this.messageHistory as any);
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
    tools?: any[]
  ): Promise<{ reply: string; toolCalls?: any[] }> {
    // Reactive compaction 预检: 估算 token 超 80% 阈值, 跑一次
    const estimated = this.estimateHistoryTokens();
    if (estimated > this.maxContextTokens() * 0.8) {
      console.warn(`[PiAgent] reactive compaction pre-check (${estimated} tokens > 80% threshold)`);
      onStream?.({ type: 'status', content: '⚠️ reactive compaction 预检触发', tool: 'recovery' });
      try {
        const compacted = this.compressHistorySync(this.messageHistory);
        this.messageHistory = compacted;
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
        const response = await llm.chat(contextOrMessages, systemPrompt, signal, tools);
        // 2026-06-30: 透传 toolCalls (OpenAI 协议 native) 给上层, 让 assistant message 能 emit 真 id
        return { reply: response.reply || '', toolCalls: response.toolCalls };
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
            if (this.messageHistory.length > 1) {
              const last = this.messageHistory[this.messageHistory.length - 1];
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
    if (this.messageHistory.length < 10) return;  // 历史太短, 不值得压

    onStream?.({ type: 'status', content: '🗜️ 评估是否需要压缩上下文...', tool: 'compactor' });

    // 注入 LLM (用 getMinimax().chat, 与 judgment 注入门 / ReAct 循环同一来源)
    // 给 Context Collapse (虚拟投影) 和 Auto-Compact (摘要) 共用
    const llm = getMinimax();
    const llmChat = async (systemPrompt: string, userPrompt: string): Promise<string> => {
      const r = await llm.chat(userPrompt, systemPrompt, signal);
      return r.reply;
    };

    // 2026-08-06: 预算 = ContextManager 配置 (1M * 55% ≈ 550K), 不再写死 8000.
    //   之前 8000 与 48K 触发阈值矛盾: 一触发就一路跑到 LLM 摘要 (贵), 且 8000 远小于实际窗口.
    const cm = getContextManager();
    const cfg = cm.getConfig();
    const maxTokens = Math.max(4000, Math.round(cfg.maxTokens * cfg.compressionThreshold));
    const beforeTokens = this.estimateHistoryTokens();

    const { compactPipeline, isContextCollapseEnabled } = await import('../context-compaction/index.js');
    const result = await compactPipeline(this.messageHistory as any, {
      maxTokens,
      llmChat,
      collapseLlmChat: llmChat,  // P1.2: Context Collapse 投影也用同一 LLM
      cacheScope: this.currentChannelId || 'default',
    });

    if (result.compacted && result.history.length < this.messageHistory.length) {
      const saved = this.messageHistory.length - result.history.length;
      const stagesApplied = result.stages.filter((s) => s.applied).map((s) => s.stage).join(' → ');
      const afterTokens = this.estimateHistoryTokens();
      const savedTokens = Math.max(0, beforeTokens - afterTokens);
      cm.markCompressStart(beforeTokens);
      onStream?.({
        type: 'status',
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
        this.messageHistory = result.history as Message[];  // 真破坏性更新
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
            ...this.messageHistory.filter(m => m.role === 'user').slice(-3).map(m => (m.content || '').slice(0, 80)),
          ],
          agentId: this.currentAgentId,
          channelId: this.currentChannelId,
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
        '命名建议'
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
    this.identity = { ...this.identity, ...updates };
  }

  setCurrentChannelId(channelId: string): void {
    this.currentChannelId = channelId;
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

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  registerSkill(skill: Skill): void {
    this.skillRegistry.register(skill);
  }

  async executeSkill(name: string, params: Record<string, unknown>): Promise<string> {
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

