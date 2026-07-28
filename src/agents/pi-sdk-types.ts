import type { WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
import type { ActionSummary, AgentInfo, CooperationTask, CooperationType } from '../social/global-shared-context.js';
import type { PivotLoopConfig, LoopResult } from './workflow-pivot-loop.js';

export interface AgentSessionConfig {
  cwd: string;
  peerId?: string;
  identityDoc?: IdentityDoc;
  usePivotLoop?: boolean;
  pivotLoopConfig?: PivotLoopConfig;
  /**
   * Skills 加载目录列表, 后者覆盖前者同名 skill.
   * 留空时使用 defaultSkillPaths() 推断的默认路径
   * ( ~/.bolloon/skills/ → <cwd>/.bolloon/skills/ → ~/.boll/skills/ )
   */
  skillsPaths?: string[];
  /** M2.3 (2026-06-17): 指定时构造时从 ~/.bolloon/sessions/cache/<channel>:<sessionId>.json 加载历史到 messageHistory */
  loadSessionKey?: string;
  /** M2.3: 历史回灌最多取 N 条 (默认 30, 防止 context 爆) */
  loadSessionMaxMessages?: number;
  /** 2026-06-30: 注入自定义 SessionStore — 测试用临时目录, 默认 ~/.bolloon/sessions/cache/ */
  sessionStore?: any;
  /** 2026-07-04: 当前 channel 的 agentId (来自 Channel.agentId), 用来加载 persona docs */
  agentId?: string;
}

export interface IdentityDoc {
  did: string;
  name: string;
  publicKey: string;
  createdAt: number;
  peerId?: string;
  p2pChannel?: string;
  cid?: string;
  ipnsName?: string;
  walletAddress?: string;
}

export interface ImprovementRequest {
  originalPath: string;
  requirements: string;
  context?: string;
}

export type { WorkflowStep, StepResult, Workflow } from './workflow-engine.js';
export type { ActionSummary, AgentInfo, CooperationTask, CooperationType } from '../social/global-shared-context.js';

export interface PiSessionState {
  id: string;
  agentId: string;
  cwd: string;
  startedAt: string;
  lastActive: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface PiMemory {
  workingMemory: string[];
  summarizedMemory: string[];
  fileContext: Map<string, string>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, string>;
  execute: (args: Record<string, string>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCall?: {
    name: string;
    args: Record<string, string>;
    id?: string;
  };
  /** 2026-07-28: 多工具调用 — 一次 LLM 回复含多个 tool_call */
  toolCalls?: Array<{
    name: string;
    args: Record<string, string>;
    id?: string;
  }>;
  toolResult?: ToolResult;
  toolCallId?: string;
}

export interface StreamCallback {
  (event: StreamEvent): void;
}

export interface StreamEvent {
  type: 'status' | 'thinking' | 'tool' | 'token' | 'done' | 'error'
      | 'step_start' | 'step_done' | 'step_error'
      | 'reply-preview';
  content: string;
  tool?: string;
  data?: unknown;
  // step_* 专用: success / output / error
  success?: boolean;
  output?: string;
  error?: string;
  args?: Record<string, unknown>;
  // step_* 可选: 步骤耗时 (server 端用来展示 in 状态条 + 性能分析)
  durationMs?: number;
}

export const TOOL_DEFINITIONS = `
可用工具:
1. read_document(path) - 读取文档内容，支持 .txt, .md, .pdf, .docx
2. summarize_document(path, context?) - 总结文档内容，可选提供上下文
3. improve_document(path, requirements) - 改进文档，需提供文件路径和改进要求
4. list_peers() - 列出已连接的对等节点
5. send_message(peer_id, message) - 向指定对等节点发送消息
6. broadcast_message(message) - 向所有对等节点广播消息
7. get_identity() - 获取当前智能体身份信息
8. set_persona(persona_json) - 更新智能体 persona，包含 name、description、personality、greeting 等
9. run_workflow(steps) - 执行预定义工作流
10. get_operation_logs() - 获取操作日志
`;

export interface HeartbeatConfig {
  intervalMs: number;
  peerDiscoveryEnabled: boolean;
  ipnsResolveEnabled: boolean;
  autoSocialEnabled: boolean;
  greetingMessage?: string;
}

export interface AgentSession {
  prompt(input: string, options?: { onStream?: StreamCallback; signal?: AbortSignal; channelId?: string }): Promise<string>;
  promptStream(input: string, onStream: StreamCallback, signal?: AbortSignal, channelId?: string): Promise<string>;
  promptWithPivotLoop(input: string, config?: PivotLoopConfig, channelId?: string): Promise<LoopResult>;
  suggestRename(messages: { type: string; content: string }[]): Promise<string | null>;
  readDocument(filePath: string): Promise<string>;
  summarizeDocument(filePath: string, context?: string): Promise<{
    summary: string;
    qualityScore: number;
  }>;
  improveDocument(request: ImprovementRequest): Promise<{
    improved: boolean;
    newContent?: string;
    qualityScore: number;
    shouldAutoSend: boolean;
  }>;
  runWorkflow(workflow: WorkflowStep[]): Promise<Workflow>;
  getPeers(): string[];
  sendMessage(peerId: string, message: string): Promise<void>;
  broadcast(message: string): Promise<void>;
  getIdentity(): IdentityDoc;
  updateIdentity(updates: Partial<IdentityDoc>): void;
  setCurrentChannelId(channelId: string): void;
  getSessionState(): PiSessionState;
  getMemory(): PiMemory;
  getPersona(): any;
  setPersona(persona: any): Promise<void>;
  getDiscoveredAgents(): any[];
  getSocialChannels(): any[];
  sendSocialMessage(channelId: string, content: string): Promise<void>;
  startSocialHeartbeat(config?: Partial<HeartbeatConfig>): Promise<void>;
  stopSocialHeartbeat(): void;
  addUserAction(content: string, importance?: number): Promise<void>;
  addSharedKnowledge(knowledge: string): Promise<void>;
  getRecentActionsSummary(count?: number): Promise<string>;
  getSharedKnowledge(): Promise<string[]>;
  getGlobalContextSummary(): Promise<string>;
  createCooperation(type: CooperationType, task: string, toAgentId?: string, context?: string): Promise<CooperationTask>;
  getPendingCooperations(): Promise<CooperationTask[]>;
  updateCooperationStatus(cooperationId: string, status: 'pending' | 'in_progress' | 'done' | 'failed', result?: string): Promise<void>;
  getAllRegisteredAgents(): Promise<AgentInfo[]>;
  findAgentByCapability(capability: string): Promise<AgentInfo[]>;
  archiveToHarness(): void;
  getHarnessContext(): string;
  isHarnessEnabled(): boolean;
  getHarness(): any;
  getOperationLog(): Array<{ timestamp: number; action: string; args: any; result: any; status: string }>;
  // === 2026-06-30: 持久化 / 续接接口 (claue code 接入点) ===
  saveCurrentSession(key: string): Promise<void>;
  resumeSession(key: string, maxMessages?: number): Promise<number>;
  peekSessionHistory(key: string, maxMessages?: number): Promise<Message[]>;
  /** 等构造期间所有 fire-and-forget 任务完成 (hydrate 等) — claude code 接入时立即可用 */
  whenReady(): Promise<void>;
}
