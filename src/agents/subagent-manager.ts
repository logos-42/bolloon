import * as fs from 'fs/promises';
import * as path from 'path';

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
      task.assignedAgentId = toAgentId;
      task.toAgentId = toAgentId;
      task.status = 'assigned';
      task.assignedAt = new Date().toISOString();
      await this.saveTasks();

      this.notifyTaskListeners(task);
    }
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, result?: string, error?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
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
    input?: string
  ): Promise<{ task: SubAgentTask; agent?: SubAgent }> {
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
      return { task, agent: undefined };
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

    return { task, agent };
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