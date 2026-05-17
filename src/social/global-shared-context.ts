import * as fs from 'fs/promises';
import * as path from 'path';

export interface ActionSummary {
  id: string;
  content: string;
  timestamp: string;
  agentId?: string;
  channelId?: string;
  importance: number;
}

export interface ActiveTask {
  id: string;
  description: string;
  status: 'in_progress' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  result?: string;
}

export interface SharedMemory {
  recentActions: ActionSummary[];
  sharedKnowledge: string[];
  currentTask?: ActiveTask;
}

export interface AgentInfo {
  agentId: string;
  did?: string;
  sessionId: string;
  channelId: string;
  capabilities: string[];
  status: 'active' | 'idle' | 'busy';
  lastActive: string;
  name?: string;
  persona?: {
    name: string;
    description: string;
    capabilities: string[];
  };
  peerId?: string;
  p2pChannel?: string;
  cid?: string;
  ipnsName?: string;
  walletAddress?: string;
}

export interface AgentRegistry {
  [agentId: string]: AgentInfo;
}

export type CooperationType = 'consult' | 'delegate' | 'collaborate';
export type CooperationStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface CooperationTask {
  id: string;
  type: CooperationType;
  fromAgentId: string;
  toAgentId?: string;
  task: string;
  context?: string;
  status: CooperationStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
}

export interface GlobalSharedContext {
  memory: SharedMemory;
  agentRegistry: AgentRegistry;
  cooperationQueue: CooperationTask[];
}

const GLOBAL_CONTEXT_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions', 'global-context.json');

const MAX_RECENT_ACTIONS = 50;
const MAX_SHARED_KNOWLEDGE = 100;

export class GlobalSharedContextManager {
  private memory: SharedMemory = {
    recentActions: [],
    sharedKnowledge: []
  };
  private agentRegistry: AgentRegistry = {};
  private cooperationQueue: CooperationTask[] = [];
  private contextPath: string;
  private initialized: boolean = false;

  constructor(contextPath?: string) {
    this.contextPath = contextPath || GLOBAL_CONTEXT_PATH;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.contextPath), { recursive: true });
    await this.load();
    this.initialized = true;
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.contextPath, 'utf-8');
      const parsed = JSON.parse(data) as GlobalSharedContext;
      this.memory = parsed.memory || { recentActions: [], sharedKnowledge: [] };
      this.agentRegistry = parsed.agentRegistry || {};
      this.cooperationQueue = parsed.cooperationQueue || [];
    } catch {
      this.memory = { recentActions: [], sharedKnowledge: [] };
      this.agentRegistry = {};
      this.cooperationQueue = [];
    }
  }

  private async save(): Promise<void> {
    const context: GlobalSharedContext = {
      memory: this.memory,
      agentRegistry: this.agentRegistry,
      cooperationQueue: this.cooperationQueue
    };
    await fs.writeFile(this.contextPath, JSON.stringify(context, null, 2));
  }

  async addUserAction(
    content: string,
    agentId?: string,
    channelId?: string,
    importance: number = 5
  ): Promise<void> {
    await this.initialize();

    const summary: ActionSummary = {
      id: `action_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      content,
      timestamp: new Date().toISOString(),
      agentId,
      channelId,
      importance
    };

    this.memory.recentActions.push(summary);

    if (this.memory.recentActions.length > MAX_RECENT_ACTIONS) {
      this.memory.recentActions = this.memory.recentActions.slice(-MAX_RECENT_ACTIONS);
    }

    await this.save();
  }

  async getRecentActions(count: number = 10): Promise<ActionSummary[]> {
    await this.initialize();
    return this.memory.recentActions.slice(-count);
  }

  async getRecentActionsSummary(count: number = 10): Promise<string> {
    const actions = await this.getRecentActions(count);
    if (actions.length === 0) return '暂无最近行动记录';

    return actions.map((a, i) => {
      const time = new Date(a.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${a.content}`;
    }).join('\n');
  }

  async addSharedKnowledge(knowledge: string): Promise<void> {
    await this.initialize();

    if (!this.memory.sharedKnowledge.includes(knowledge)) {
      this.memory.sharedKnowledge.push(knowledge);

      if (this.memory.sharedKnowledge.length > MAX_SHARED_KNOWLEDGE) {
        this.memory.sharedKnowledge = this.memory.sharedKnowledge.slice(-MAX_SHARED_KNOWLEDGE);
      }

      await this.save();
    }
  }

  async getSharedKnowledge(): Promise<string[]> {
    await this.initialize();
    return [...this.memory.sharedKnowledge];
  }

  async setCurrentTask(task: Omit<ActiveTask, 'id' | 'createdAt'>): Promise<ActiveTask> {
    await this.initialize();

    const newTask: ActiveTask = {
      id: `task_${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...task
    };

    this.memory.currentTask = newTask;
    await this.save();
    return newTask;
  }

  async completeCurrentTask(result: string): Promise<void> {
    await this.initialize();

    if (this.memory.currentTask) {
      this.memory.currentTask.status = 'completed';
      this.memory.currentTask.completedAt = new Date().toISOString();
      this.memory.currentTask.result = result;
    }

    await this.save();
  }

  async getCurrentTask(): Promise<ActiveTask | undefined> {
    await this.initialize();
    return this.memory.currentTask;
  }

  async registerAgent(agentInfo: Omit<AgentInfo, 'lastActive'>): Promise<void> {
    await this.initialize();

    this.agentRegistry[agentInfo.agentId] = {
      ...agentInfo,
      lastActive: new Date().toISOString()
    };

    await this.save();
  }

  async updateAgentStatus(agentId: string, status: AgentInfo['status']): Promise<void> {
    await this.initialize();

    if (this.agentRegistry[agentId]) {
      this.agentRegistry[agentId].status = status;
      this.agentRegistry[agentId].lastActive = new Date().toISOString();
      await this.save();
    }
  }

  async getAgent(agentId: string): Promise<AgentInfo | undefined> {
    await this.initialize();
    return this.agentRegistry[agentId];
  }

  async getAllAgents(): Promise<AgentInfo[]> {
    await this.initialize();
    return Object.values(this.agentRegistry);
  }

  async getActiveAgents(): Promise<AgentInfo[]> {
    await this.initialize();
    return Object.values(this.agentRegistry).filter(a => a.status === 'active');
  }

  async findAgentByCapability(capability: string): Promise<AgentInfo[]> {
    await this.initialize();
    return Object.values(this.agentRegistry).filter(
      a => a.capabilities.some(c => c.toLowerCase().includes(capability.toLowerCase()))
    );
  }

  async unregisterAgent(agentId: string): Promise<void> {
    await this.initialize();
    delete this.agentRegistry[agentId];
    await this.save();
  }

  async createCooperation(
    type: CooperationType,
    fromAgentId: string,
    task: string,
    toAgentId?: string,
    context?: string
  ): Promise<CooperationTask> {
    await this.initialize();

    const cooperation: CooperationTask = {
      id: `coop_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type,
      fromAgentId,
      toAgentId,
      task,
      context,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.cooperationQueue.push(cooperation);
    await this.save();
    return cooperation;
  }

  async updateCooperationStatus(
    cooperationId: string,
    status: CooperationStatus,
    result?: string
  ): Promise<void> {
    await this.initialize();

    const cooperation = this.cooperationQueue.find(c => c.id === cooperationId);
    if (cooperation) {
      cooperation.status = status;
      cooperation.updatedAt = new Date().toISOString();
      if (result) {
        cooperation.result = result;
      }
      await this.save();
    }
  }

  async getCooperation(cooperationId: string): Promise<CooperationTask | undefined> {
    await this.initialize();
    return this.cooperationQueue.find(c => c.id === cooperationId);
  }

  async getPendingCooperations(forAgentId?: string): Promise<CooperationTask[]> {
    await this.initialize();
    return this.cooperationQueue.filter(c => {
      if (c.status !== 'pending') return false;
      if (forAgentId) return c.toAgentId === forAgentId || c.fromAgentId === forAgentId;
      return true;
    });
  }

  async getCooperationsForAgent(agentId: string): Promise<CooperationTask[]> {
    await this.initialize();
    return this.cooperationQueue.filter(
      c => c.fromAgentId === agentId || c.toAgentId === agentId
    );
  }

  async getFullContext(): Promise<GlobalSharedContext> {
    await this.initialize();
    return {
      memory: { ...this.memory },
      agentRegistry: { ...this.agentRegistry },
      cooperationQueue: [...this.cooperationQueue]
    };
  }

  async getContextSummary(): Promise<string> {
    await this.initialize();

    const agents = Object.values(this.agentRegistry);
    const activeAgents = agents.filter(a => a.status === 'active');
    const pendingCoops = this.cooperationQueue.filter(c => c.status === 'pending');

    let summary = '=== 全局共享上下文 ===\n\n';

    summary += '【最近行动】\n';
    const recentActions = this.memory.recentActions.slice(-5);
    if (recentActions.length === 0) {
      summary += '  暂无\n';
    } else {
      for (const action of recentActions) {
        const time = new Date(action.timestamp).toLocaleTimeString('zh-CN');
        summary += `  [${time}] ${action.content.substring(0, 50)}${action.content.length > 50 ? '...' : ''}\n`;
      }
    }

    summary += '\n【共享知识】\n';
    if (this.memory.sharedKnowledge.length === 0) {
      summary += '  暂无\n';
    } else {
      for (const knowledge of this.memory.sharedKnowledge.slice(-5)) {
        summary += `  - ${knowledge.substring(0, 60)}${knowledge.length > 60 ? '...' : ''}\n`;
      }
    }

    summary += '\n【当前任务】\n';
    if (this.memory.currentTask) {
      summary += `  ${this.memory.currentTask.description} (${this.memory.currentTask.status})\n`;
    } else {
      summary += '  暂无\n';
    }

    summary += '\n【Agent 注册】\n';
    summary += `  总数: ${agents.length}, 活跃: ${activeAgents.length}\n`;
    for (const agent of activeAgents.slice(0, 5)) {
      summary += `  - ${agent.name || agent.agentId}: ${agent.capabilities.join(', ')}\n`;
    }

    summary += '\n【待处理合作】\n';
    if (pendingCoops.length === 0) {
      summary += '  暂无\n';
    } else {
      for (const coop of pendingCoops.slice(0, 3)) {
        summary += `  [${coop.type}] ${coop.task.substring(0, 40)}... (${coop.fromAgentId} -> ${coop.toAgentId || 'broadcast'})\n`;
      }
    }

    return summary;
  }

  async clear(): Promise<void> {
    this.memory = { recentActions: [], sharedKnowledge: [] };
    this.agentRegistry = {};
    this.cooperationQueue = [];
    await this.save();
  }
}

let globalContextInstance: GlobalSharedContextManager | null = null;

export function getGlobalSharedContext(): GlobalSharedContextManager {
  if (!globalContextInstance) {
    globalContextInstance = new GlobalSharedContextManager();
  }
  return globalContextInstance;
}

export async function createGlobalSharedContext(
  contextPath?: string
): Promise<GlobalSharedContextManager> {
  if (globalContextInstance) {
    return globalContextInstance;
  }
  globalContextInstance = new GlobalSharedContextManager(contextPath);
  await globalContextInstance.initialize();
  return globalContextInstance;
}

export function resetGlobalSharedContext(): void {
  globalContextInstance = null;
}