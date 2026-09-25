import * as fs from 'fs/promises';
import * as path from 'path';
import type { AgentWorkContract, AgentWorkReport } from './goal-flywheel/types.js';
// 2026-09-25 (M3 接缝): 换人必须重签合同的判据只有一份 (纯函数, 零 I/O)
import { childMatchesContract } from './goal-flywheel/wiring/contract.js';

export type SubAgentStatus = 'creating' | 'active' | 'idle' | 'busy' | 'terminated';
export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface SubAgent {
  id: string;
  name: string;
  description?: string;
  did?: string;
  sessionId?: string;
  channelId?: string;
  peerId?: string;
  p2pChannel?: string;
  cid?: string;
  ipnsName?: string;
  walletAddress?: string;
  capabilities: string[];
  status: SubAgentStatus;
  persona?: {
    name: string;
    description: string;
    capabilities: string[];
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  lastActive: string;
  parentAgentId?: string;
}

/**
 * 2026-09-25 (飞轮接线 P2): 带合同的派遣参数。
 * 只有给了 `goalId` 才会签工作合同 —— 普通/临时子任务行为完全不变 (向后兼容)。
 */
export interface DelegateContractOptions {
  goalId: string;
  parentRunId?: string;
  successCriteria?: string[];
  budget?: { maxSteps: number | null; maxDurationMs: number | null; maxAmount: number | null; currency: string | null };
  deadline?: string | null;
  /** 合同里允许子用的工具 (空 = 不限制显式工具面, 由 Harness 管) */
  allowedTools?: string[];
}

export interface SubAgentTask {
  id: string;
  type: 'delegate' | 'consult' | 'collaborate';
  title: string;
  description: string;
  priority: TaskPriority;
  fromAgentId: string;
  toAgentId?: string;
  assignedAgentId?: string;
  status: TaskStatus;
  input?: string;
  result?: string;
  error?: string;
  createdAt: string;
  assignedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
  /**
   * 2026-09-25 (飞轮接线 P2): 这次派遣关联的长期 Goal 与工作合同 id。
   * 有 `workId` 的任务: "完成"必须过 `validateChildReport` / `acceptsAsComplete` 核验。
   */
  goalId?: string;
  workId?: string;
  /**
   * 2026-09-25 (M3): **派前必须有工作合同** —— 目标语境下签不出合同时, 任务**不派出**,
   * 原因记在这里 (而不是"记个 error 照样派出去")。有它 = 这条任务根本没派给任何子 Agent。
   */
  contractRefused?: { code: string; reason: string } | null;
  /**
   * 2026-09-25 (M3): 换了执行者但**没**重签合同 → 拒绝换人, 原因记在这里 (合同把执行者钉死了)。
   * 有它 = 指派关系**没有**被改动。
   */
  reassignRefused?: { code: string; reason: string } | null;
  /** 最近一次成功的子 Agent 心跳 (P3 阻塞巡检的输入面: "任务还活着吗") */
  lastHeartbeatAt?: string | null;
  /** 心跳写入失败的原因 (不覆盖 `error`; 心跳失败会让监控看到"无进展", 必须留痕) */
  heartbeatError?: string | null;
}

export interface InterAgentMessage {
  id: string;
  type: 'task' | 'result' | 'query' | 'response' | 'notification';
  fromAgentId: string;
  toAgentId: string;
  content: string;
  taskId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SubAgentManagerConfig {
  storagePath?: string;
  autoCleanupIntervalMs?: number;
  taskTimeoutMs?: number;
  maxConcurrentTasks?: number;
}

const DEFAULT_STORAGE_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'agents');
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_TASKS = 10;

export class SubAgentManager {
  private agents: Map<string, SubAgent> = new Map();
  private tasks: Map<string, SubAgentTask> = new Map();
  private messages: Map<string, InterAgentMessage[]> = new Map();
  private config: Required<SubAgentManagerConfig>;
  private initialized: boolean = false;
  private messageListeners: Map<string, ((msg: InterAgentMessage) => void)[]> = new Map();
  private taskListeners: Map<string, ((task: SubAgentTask) => void)[]> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SubAgentManagerConfig = {}) {
    this.config = {
      storagePath: config.storagePath || DEFAULT_STORAGE_PATH,
      autoCleanupIntervalMs: config.autoCleanupIntervalMs || 60000,
      taskTimeoutMs: config.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS,
      maxConcurrentTasks: config.maxConcurrentTasks || DEFAULT_MAX_CONCURRENT_TASKS
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.config.storagePath, { recursive: true });
    await this.loadAgents();
    await this.loadTasks();

    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleTasks();
    }, this.config.autoCleanupIntervalMs);

    this.initialized = true;
  }

  private async loadAgents(): Promise<void> {
    try {
      const agentsPath = path.join(this.config.storagePath, 'agents.json');
      const data = await fs.readFile(agentsPath, 'utf-8');
      const agentsArray: SubAgent[] = JSON.parse(data);
      this.agents.clear();
      for (const agent of agentsArray) {
        if (agent.status !== 'terminated') {
          this.agents.set(agent.id, agent);
        }
      }
    } catch {
      this.agents.clear();
    }
  }

  private async loadTasks(): Promise<void> {
    try {
      const tasksPath = path.join(this.config.storagePath, 'tasks.json');
      const data = await fs.readFile(tasksPath, 'utf-8');
      const tasksArray: SubAgentTask[] = JSON.parse(data);
      this.tasks.clear();
      for (const task of tasksArray) {
        this.tasks.set(task.id, task);
      }
    } catch {
      this.tasks.clear();
    }
  }

  private async saveAgents(): Promise<void> {
    const agentsPath = path.join(this.config.storagePath, 'agents.json');
    const agentsArray = Array.from(this.agents.values());
    await fs.writeFile(agentsPath, JSON.stringify(agentsArray, null, 2));
  }

  private async saveTasks(): Promise<void> {
    const tasksPath = path.join(this.config.storagePath, 'tasks.json');
    const tasksArray = Array.from(this.tasks.values());
    await fs.writeFile(tasksPath, JSON.stringify(tasksArray, null, 2));
  }

  async registerAgent(agent: Omit<SubAgent, 'id' | 'createdAt' | 'lastActive' | 'status'>): Promise<SubAgent> {
    await this.initialize();

    const newAgent: SubAgent = {
      ...agent,
      id: `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      status: 'creating',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    };

    this.agents.set(newAgent.id, newAgent);
    await this.saveAgents();

    await this.updateAgentStatus(newAgent.id, 'active');

    return newAgent;
  }

  async unregisterAgent(agentId: string): Promise<void> {
    await this.initialize();
    await this.updateAgentStatus(agentId, 'terminated');
    this.agents.delete(agentId);
    await this.saveAgents();
  }

  async updateAgentStatus(agentId: string, status: SubAgentStatus): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.lastActive = new Date().toISOString();
      await this.saveAgents();
    }
  }

  async updateAgent(agentId: string, updates: Partial<SubAgent>): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      Object.assign(agent, updates, { lastActive: new Date().toISOString() });
      await this.saveAgents();
    }
  }

  async getAgent(agentId: string): Promise<SubAgent | undefined> {
    return this.agents.get(agentId);
  }

  async getAllAgents(): Promise<SubAgent[]> {
    return Array.from(this.agents.values());
  }

  async getActiveAgents(): Promise<SubAgent[]> {
    return Array.from(this.agents.values()).filter(a => a.status === 'active' || a.status === 'idle');
  }

  async getAgentsByCapability(capability: string): Promise<SubAgent[]> {
    return Array.from(this.agents.values()).filter(
      agent => agent.status === 'active' &&
        agent.capabilities.some(c => c.toLowerCase().includes(capability.toLowerCase()))
    );
  }

  async getAgentByDid(did: string): Promise<SubAgent | undefined> {
    return Array.from(this.agents.values()).find(a => a.did === did);
  }

  async findBestAgentForTask(requiredCapabilities: string[], excludeAgentId?: string): Promise<SubAgent | undefined> {
    const availableAgents = Array.from(this.agents.values()).filter(
      a => a.status === 'active' && a.id !== excludeAgentId
    );

    if (availableAgents.length === 0) return undefined;

    const scored = availableAgents.map(agent => {
      const matchedCapabilities = agent.capabilities.filter(c =>
        requiredCapabilities.some(req => c.toLowerCase().includes(req.toLowerCase()))
      );
      const score = matchedCapabilities.length / requiredCapabilities.length;
      return { agent, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored[0]?.agent;
  }

  async createTask(
    type: SubAgentTask['type'],
    title: string,
    description: string,
    fromAgentId: string,
    toAgentId?: string,
    priority: TaskPriority = 'normal',
    input?: string,
    metadata?: Record<string, unknown>
  ): Promise<SubAgentTask> {
    await this.initialize();

    const task: SubAgentTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type,
      title,
      description,
      priority,
      fromAgentId,
      toAgentId,
      assignedAgentId: toAgentId,
      status: toAgentId ? 'assigned' : 'pending',
      input,
      createdAt: new Date().toISOString(),
      metadata
    };

    if (toAgentId) {
      task.assignedAt = new Date().toISOString();
    }

    this.tasks.set(task.id, task);
    await this.saveTasks();

    return task;
  }

  async assignTask(taskId: string, toAgentId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      // 2026-09-25 (M3): 挂着工作合同的任务 **不许换人而不换合同**。
      //   合同把 `childAgentId` 钉死了 (回报核验要求 report.childAgentId === contract.childAgentId),
      //   把同一份合同指给另一个子 Agent ⇒ 新子的回报必然对不上合同, 合规判定整个失效。
      //   换人的正确做法是**重新派遣** (父侧 signed 新合同) —— 本方法只维护指派关系, 无权签合同,
      //   所以这里如实拒绝并留痕, 而不是"改了字段就当换成了"。
      if (task.goalId && task.workId) {
        const contract = (task.metadata?.workContract ?? null) as AgentWorkContract | null;
        if (!contract) {
          task.reassignRefused = {
            code: 'contract_unreadable',
            reason: `任务 ${taskId} 挂着 workId=${task.workId} 却读不到合同 → 无法判断新执行者是否与原合同一致, 拒绝换人 (先重签合同)`,
          };
          await this.saveTasks();
          this.notifyTaskListeners(task);
          return;
        }
        const same = childMatchesContract(contract, toAgentId);
        if (!same.ok) {
          task.reassignRefused = { code: 'requires_new_contract', reason: same.reason };
          await this.saveTasks();
          this.notifyTaskListeners(task);
          return;
        }
        task.reassignRefused = null;
      }
      task.assignedAgentId = toAgentId;
      task.toAgentId = toAgentId;
      task.status = 'assigned';
      task.assignedAt = new Date().toISOString();
      await this.heartbeatContractedTask(task, task.assignedAt);
      await this.saveTasks();

      this.notifyTaskListeners(task);
    }
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, result?: string, error?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      // 2026-09-25 (M3 接缝): 挂了合同的子任务, 任何状态更新都是"子还活着"的证据 → 记一次心跳。
      //   这是"执行中统一监控"的输入面: 没有心跳, 阻塞巡检只能看见"卡住", 看不见"在动"。
      await this.heartbeatContractedTask(task);

      // 2026-09-25 (飞轮接线 P2): 挂着工作合同的任务, "完成" 必须过回报核验 ——
      //   回一段漂亮话 (没有逐条判据证据) **不算完成**: 任务留在 in_progress, 原因写清楚,
      //   而 Goal 那边的 pendingReports 保持 (父仍然在等这份回报)。
      //
      // 2026-09-25 (M3): 判据从 `task.workId && task.goalId` 收紧成 `task.goalId` ——
      //   "派前必须有合同"的**反面**: 目标语境下的任务若**没有**合同 (签发失败 / 旧数据),
      //   它同样不许自称完成 —— 没有合同的回报不核验也不接受 (handleChildReport 的 no_contract)。
      if (status === 'completed' && task.goalId) {
        if (!task.workId) {
          task.status = 'in_progress';
          task.error = '回报不接受为完成: 这条任务在目标语境下**没有工作合同** '
            + '(签合同失败或任务早于合同接线) —— 没有合同就没有判据, 无法核验, 不许当完成记账';
          await this.saveTasks();
          this.notifyTaskListeners(task);
          return;
        }
        const verdict = await this.validateTaskReport(task, result ?? '');
        if (!verdict.accepted) {
          task.status = 'in_progress';
          if (result) task.result = result;
          task.error = `回报核验不过, 不接受为完成: ${verdict.reason}`
            + (verdict.missingEvidence.length ? ` [缺证据: ${verdict.missingEvidence.join('; ')}]` : '');
          await this.saveTasks();
          this.notifyTaskListeners(task);
          return;
        }
      }
      task.status = status;
      if (result) task.result = result;
      if (error) task.error = error;
      if (status === 'completed' || status === 'failed') {
        task.completedAt = new Date().toISOString();
      }
      await this.saveTasks();

      this.notifyTaskListeners(task);
    }
  }

  /**
   * 给挂着合同的任务记一次心跳 (P3 的输入面; 只有真写成盘才算数)。
   *
   * 为什么放在**真实派遣过程**里而不是让子 Agent 自己记得报: 心跳是"任务还活着"的事实,
   * 而子 Agent 是最没有动力报心跳的一方 (它卡住了就不会报)。所以由派遣侧在每一次
   * 真实状态变化 (派出去 / 换人 / 子更新状态) 时落一次 —— 没有这些落点, 阻塞巡检
   * 只能看到"从来没心跳过", 分不清"卡住"与"刚派出"。
   *
   * 失败**不覆盖** `task.error` (那是子 Agent 的事实), 而是记进 `heartbeatError`:
   * 心跳写不进去 = 监控会看到"无进展", 这件事必须留在任务上, 不许静默。
   */
  private async heartbeatContractedTask(task: SubAgentTask, at?: string): Promise<void> {
    if (!task.goalId || !task.workId) return;
    const now = at ?? new Date().toISOString();
    try {
      const { recordWorkHeartbeat } = await import('./goal-flywheel-wiring.js');
      await recordWorkHeartbeat(task.goalId, task.workId, now);
      task.lastHeartbeatAt = now;
      task.heartbeatError = null;
    } catch (e) {
      task.heartbeatError = `心跳写入失败 (监控会看到"无进展"): ${String((e as Error)?.message || e).slice(0, 160)}`;
    }
  }


  async getTask(taskId: string): Promise<SubAgentTask | undefined> {
    return this.tasks.get(taskId);
  }

  async getTasksForAgent(agentId: string): Promise<SubAgentTask[]> {
    return Array.from(this.tasks.values()).filter(
      t => t.fromAgentId === agentId ||
        t.toAgentId === agentId ||
        t.assignedAgentId === agentId
    );
  }

  async getPendingTasks(): Promise<SubAgentTask[]> {
    return Array.from(this.tasks.values()).filter(t => t.status === 'pending');
  }

  async getActiveTasks(): Promise<SubAgentTask[]> {
    return Array.from(this.tasks.values()).filter(
      t => t.status === 'assigned' || t.status === 'in_progress'
    );
  }

  async sendMessage(
    fromAgentId: string,
    toAgentId: string,
    content: string,
    type: InterAgentMessage['type'] = 'notification',
    taskId?: string,
    metadata?: Record<string, unknown>
  ): Promise<InterAgentMessage> {
    await this.initialize();

    const message: InterAgentMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type,
      fromAgentId,
      toAgentId,
      content,
      taskId,
      timestamp: new Date().toISOString(),
      metadata
    };

    if (!this.messages.has(toAgentId)) {
      this.messages.set(toAgentId, []);
    }
    this.messages.get(toAgentId)!.push(message);

    this.notifyMessageListeners(toAgentId, message);

    return message;
  }

  async getMessagesForAgent(agentId: string, since?: string): Promise<InterAgentMessage[]> {
    const messages = this.messages.get(agentId) || [];
    if (since) {
      const sinceTime = new Date(since).getTime();
      return messages.filter(m => new Date(m.timestamp).getTime() > sinceTime);
    }
    return [...messages];
  }

  async broadcastMessage(
    fromAgentId: string,
    content: string,
    type: InterAgentMessage['type'] = 'notification'
  ): Promise<void> {
    const agents = await this.getActiveAgents();
    for (const agent of agents) {
      if (agent.id !== fromAgentId) {
        await this.sendMessage(fromAgentId, agent.id, content, type);
      }
    }
  }

  onMessage(agentId: string, callback: (msg: InterAgentMessage) => void): () => void {
    if (!this.messageListeners.has(agentId)) {
      this.messageListeners.set(agentId, []);
    }
    this.messageListeners.get(agentId)!.push(callback);

    return () => {
      const listeners = this.messageListeners.get(agentId);
      if (listeners) {
        const index = listeners.indexOf(callback);
        if (index > -1) listeners.splice(index, 1);
      }
    };
  }

  onTask(callback: (task: SubAgentTask) => void): () => void {
    const wrapper = (task: SubAgentTask) => callback(task);
    const id = Math.random().toString(36);
    if (!this.taskListeners.has(id)) {
      this.taskListeners.set(id, []);
    }
    this.taskListeners.get(id)!.push(wrapper);

    return () => {
      const listeners = this.taskListeners.get(id);
      if (listeners) {
        const index = listeners.indexOf(wrapper);
        if (index > -1) listeners.splice(index, 1);
      }
    };
  }

  private notifyMessageListeners(agentId: string, message: InterAgentMessage): void {
    const listeners = this.messageListeners.get(agentId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (e) {
          console.error(`Message listener error for ${agentId}:`, e);
        }
      }
    }
  }

  private notifyTaskListeners(task: SubAgentTask): void {
    for (const listeners of this.taskListeners.values()) {
      for (const listener of listeners) {
        try {
          listener(task);
        } catch (e) {
          console.error('Task listener error:', e);
        }
      }
    }
  }

  private cleanupStaleTasks(): void {
    const now = Date.now();
    const timeout = this.config.taskTimeoutMs;

    for (const task of this.tasks.values()) {
      if (
        (task.status === 'assigned' || task.status === 'in_progress') &&
        task.assignedAt &&
        now - new Date(task.assignedAt).getTime() > timeout
      ) {
        task.status = 'failed';
        task.error = 'Task timeout';
        task.completedAt = new Date().toISOString();
      }
    }
  }

  async delegateTask(
    fromAgentId: string,
    taskDescription: string,
    requiredCapabilities: string[],
    priority: TaskPriority = 'normal',
    input?: string,
    contractOptions?: DelegateContractOptions,
  ): Promise<{ task: SubAgentTask; agent?: SubAgent; workContract?: AgentWorkContract }> {
    const agent = await this.findBestAgentForTask(requiredCapabilities, fromAgentId);

    if (!agent) {
      const task = await this.createTask(
        'delegate',
        taskDescription.substring(0, 50),
        taskDescription,
        fromAgentId,
        undefined,
        priority,
        input
      );
      const workContract = await this.issueWorkContractFor(fromAgentId, task, requiredCapabilities, contractOptions);
      // 派前必须有工作合同 (M3): 目标语境下签不出合同 → **(没有收件人时本来也派不出去)**, 但要如实标注
      if (!workContract && contractOptions?.goalId) {
        this.refuseDispatchWithoutContract(task, contractOptions?.goalId);
        await this.saveTasks();
        return { task, agent: undefined, workContract: undefined };
      }
      if (workContract) await this.heartbeatContractedTask(task);
      await this.saveTasks();
      return { task, agent: undefined, workContract };
    }

    const task = await this.createTask(
      'delegate',
      taskDescription.substring(0, 50),
      taskDescription,
      fromAgentId,
      agent.id,
      priority,
      input
    );
    // 2026-09-25 (P2): 派遣这件事**本身**就包含签合同 (不是事后再补一份文档);
    //   有没有空闲子 Agent 不影响合同签发 (合同锁的是能力与判据, 不是某个人)。
    //
    // 2026-09-25 (M3): 签不出合同 ⇒ **不派出**。旧形状是"记个 error 照样把任务交出去",
    //   那等于"派前必须有的合同"在失败路径上直接不存在 (子拿到一段任务描述就开始干,
    //   回来只有一段文本, 父连判据都没有)。现在: 任务退回 `pending`、不绑执行者、
    //   返回 `agent: undefined`, 让调用方**没有**可派遣的对象。
    const workContract = await this.issueWorkContractFor(fromAgentId, task, requiredCapabilities, contractOptions);
    if (!workContract && contractOptions?.goalId) {
      this.refuseDispatchWithoutContract(task, contractOptions.goalId);
      await this.saveTasks();
      return { task, agent: undefined, workContract: undefined };
    }
    if (workContract) await this.heartbeatContractedTask(task);
    await this.saveTasks();

    return { task, agent, workContract };
  }

  /**
   * 目标语境下没有合同 ⇒ **不派出** (M3 的"派前必须有合同")。
   *
   * 落成事实: 任务退回 `pending` 且**不绑执行者** (没有 `assignedAt`),
   * `contractRefused` 记下原因。于是:
   *   · 调用方拿到的 `agent` 是 `undefined` → 没有派遣对象;
   *   · 任务不会出现在 `getActiveTasks()` 里 (它没被派出去);
   *   · 原因留在任务上, 父能据此重签合同或交人 (不许静默当"没派过")。
   */
  private refuseDispatchWithoutContract(task: SubAgentTask, goalId?: string): void {
    const reason = task.error
      ? `派前必须有工作合同: 合同没签成 → 不派出 (${task.error})`
      : '派前必须有工作合同: 合同没签成 → 不派出';
    task.status = 'pending';
    task.assignedAgentId = undefined;
    task.toAgentId = undefined;
    task.assignedAt = undefined;
    // Goal 上下文要留在任务上: ① 它说明这次派遣是**为哪个目标**尝试的;
    //   ② 于是完成门 (`updateTaskStatus` 的 `task.goalId` 判据) 也管得到这条没有合同的任务
    //      —— 没有合同就不许自称完成, 不留 goalId 的话它就绕过了那道门。
    if (goalId) task.goalId = goalId;
    task.contractRefused = { code: 'contract_not_issued', reason };
  }


  /**
   * 给这次派遣签工作合同 (P2)。只有调用方给了 `goalId` 才签 —— 没有长期目标就没有合同上下文,
   * 这时行为与接线前完全一致 (只记任务)。
   */
  private async issueWorkContractFor(
    fromAgentId: string,
    task: SubAgentTask,
    requiredCapabilities: string[],
    opts?: DelegateContractOptions,
  ): Promise<AgentWorkContract | undefined> {
    if (!opts?.goalId) return undefined;
    try {
      const { dispatchChildWork } = await import('./goal-flywheel-wiring.js');
      const capability = (requiredCapabilities[0] || 'general').trim();
      const issued = await dispatchChildWork({
        goalId: opts.goalId,
        parentRunId: opts.parentRunId ?? `subagent-task:${task.id}`,
        childAgentId: task.assignedAgentId || task.toAgentId || `(unassigned:${fromAgentId})`,
        capability,
        objective: task.description,
        inputs: { taskId: task.id, input: task.input ?? null },
        allowedTools: opts.allowedTools ?? [],
        budget: opts.budget ?? { maxSteps: null, maxDurationMs: this.config.taskTimeoutMs, maxAmount: null, currency: null },
        deadline: opts.deadline ?? null,
        successCriteria: (opts.successCriteria?.length ? opts.successCriteria : [task.description]).slice(0, 20),
        issuedBy: `subagent-manager:${fromAgentId}`,
      });
      task.goalId = opts.goalId;
      task.workId = issued.workId;
      task.metadata = { ...(task.metadata ?? {}), workContract: issued };
      await this.saveTasks();
      return issued;
    } catch (err) {
      // 签合同失败 → 如实记在任务上 (不许悄悄降级成"没合同也能派")
      task.error = `工作合同签发失败: ${String((err as Error)?.message || err).slice(0, 200)}`;
      await this.saveTasks();
      return undefined;
    }
  }

  /**
   * 核验挂着合同的子任务回报 (P2)。
   * 报告可以是**结构化 JSON 文本** (推荐: 子按 `bolloon-work-report/1` 回), 也可以是纯文本 ——
   * 纯文本没有逐条证据 → **不接受为完成** (这正是要堵的"回一段漂亮话就算完成")。
   */
  private async validateTaskReport(
    task: SubAgentTask,
    result: string,
  ): Promise<{ accepted: boolean; reason: string; missingEvidence: string[] }> {
    const { handleChildReport } = await import('./goal-flywheel-wiring.js');
    const contract = (task.metadata?.workContract ?? null) as AgentWorkContract | null;
    const raw = String(result ?? '');
    let report: AgentWorkReport | null = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { status?: unknown }).status === 'string') {
        report = parsed as AgentWorkReport;
      }
    } catch { /* 不是 JSON → 当纯文本处理 */ }
    if (!report) {
      report = {
        workId: task.workId!,
        childAgentId: contract?.childAgentId ?? task.assignedAgentId ?? task.toAgentId ?? '(unknown)',
        status: 'completed',
        summary: raw.slice(0, 400),
        evidence: [],
        artifacts: [],
        checks: [],
        unresolvedItems: [],
        blockReason: null,
        nextRecommendation: '(未提供)',
        durationMs: 0,
        reportedAt: new Date().toISOString(),
      };
    }
    const out = await handleChildReport({ goalId: task.goalId!, workId: task.workId!, report });
    return { accepted: out.accepted, reason: out.reason, missingEvidence: out.missingEvidence };
  }

  async consultAgent(
    fromAgentId: string,
    toAgentId: string,
    query: string,
    taskId?: string
  ): Promise<InterAgentMessage> {
    return this.sendMessage(fromAgentId, toAgentId, query, 'query', taskId);
  }

  async getAgentStatistics(): Promise<{
    total: number;
    active: number;
    idle: number;
    busy: number;
    terminated: number;
    pendingTasks: number;
    activeTasks: number;
  }> {
    const agents = Array.from(this.agents.values());
    const tasks = Array.from(this.tasks.values());

    return {
      total: agents.length,
      active: agents.filter(a => a.status === 'active').length,
      idle: agents.filter(a => a.status === 'idle').length,
      busy: agents.filter(a => a.status === 'busy').length,
      terminated: agents.filter(a => a.status === 'terminated').length,
      pendingTasks: tasks.filter(t => t.status === 'pending').length,
      activeTasks: tasks.filter(t => t.status === 'assigned' || t.status === 'in_progress').length
    };
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.agents.clear();
    this.tasks.clear();
    this.messages.clear();
    this.messageListeners.clear();
    this.taskListeners.clear();
    this.initialized = false;
  }
}

let subAgentManagerInstance: SubAgentManager | null = null;

export function getSubAgentManager(): SubAgentManager {
  if (!subAgentManagerInstance) {
    subAgentManagerInstance = new SubAgentManager();
  }
  return subAgentManagerInstance;
}

export async function createSubAgentManager(config?: SubAgentManagerConfig): Promise<SubAgentManager> {
  if (subAgentManagerInstance) {
    return subAgentManagerInstance;
  }
  subAgentManagerInstance = new SubAgentManager(config);
  await subAgentManagerInstance.initialize();
  return subAgentManagerInstance;
}

export function resetSubAgentManager(): void {
  if (subAgentManagerInstance) {
    subAgentManagerInstance.destroy();
    subAgentManagerInstance = null;
  }
}