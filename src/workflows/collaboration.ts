/**
 * Multi-Agent Collaboration Workflow
 *
 * 工作流设计：
 * 1. 命令解析 - 理解用户意图
 * 2. DID查询 - 从IPNS/IPFS查找已注册智能体
 * 3. 协作判断 - 分析是否需要多智能体协作
 * 4. 任务分发 - 发送文档给其他智能体
 * 5. 结果汇总 - 收集并整合协作结果
 */

import { AgentProtocol, AgentMessage, Task, TaskResult, ImproveResult } from '../agents/protocol.js';
import { p2pNetwork } from '../network/p2p.js';
import { documentReader } from '../documents/reader.js';
import { getMinimax } from '../constraints/index.js';
import { IpfsClient } from '@diap/sdk';

export interface AgentInfo {
  did: string;
  name: string;
  ipnsName?: string;
  peerId?: string;
  lastSeen?: number;
}

export interface CollaborationResult {
  success: boolean;
  collaborated: boolean;
  agents: AgentInfo[];
  taskId?: string;
  result?: string;
  qualityScore?: number;
  error?: string;
}

export interface CommandIntent {
  action: 'read' | 'summarize' | 'improve' | 'collaborate' | 'report' | 'query';
  target?: string;
  requirements?: string;
  context?: string;
  needCollaboration: boolean;
  suggestedAgents?: string[];
}

/**
 * 命令解析器 - 将用户输入解析为结构化意图
 */
export class CommandParser {
  private collaborationKeywords = ['协作', '合作', '其他', '帮忙', '请教', '团队', '分享', '交给'];
  private improvementKeywords = ['改进', '优化', '修改', '完善', '润色', '修正'];
  private queryKeywords = ['查看', '列表', '查询', '有哪些', '谁在线'];

  parse(input: string, context?: string): CommandIntent {
    const lowerInput = input.toLowerCase();

    // 检测是否需要协作
    const needCollaboration = this.collaborationKeywords.some(k => lowerInput.includes(k));

    // 解析动作
    let action: CommandIntent['action'] = 'query';

    if (lowerInput.includes('改进') || lowerInput.includes('优化') || lowerInput.includes('修改')) {
      action = 'improve';
    } else if (lowerInput.includes('总结') || lowerInput.includes('摘要')) {
      action = 'summarize';
    } else if (lowerInput.includes('读取') || lowerInput.includes('阅读')) {
      action = 'read';
    } else if (lowerInput.includes('汇报') || lowerInput.includes('报告')) {
      action = 'report';
    } else if (this.queryKeywords.some(k => lowerInput.includes(k))) {
      action = 'query';
    }

    // 提取目标文件/主题
    const targetMatch = input.match(/[\w\.\/]+\.(md|txt|pdf|docx)/i);
    const target = targetMatch ? targetMatch[0] : undefined;

    // 提取需求描述
    const requirements = this.extractRequirements(input);

    // 识别建议的智能体（如果有）
    const suggestedAgents = this.extractAgentNames(input);

    return {
      action,
      target,
      requirements,
      context: context || input,
      needCollaboration,
      suggestedAgents
    };
  }

  private extractRequirements(input: string): string | undefined {
    // 查找引号内的内容或特定模式
    const quotes = input.match(/["'""]([^""']+)[""'"]/);
    if (quotes) return quotes[1];

    const afterKeywords = input.match(/(?:改进|优化|修改|要求|需要)[:：]\s*(.+)/i);
    if (afterKeywords) return afterKeywords[1];

    return undefined;
  }

  private extractAgentNames(input: string): string[] | undefined {
    const names = input.match(/[@@]\w+/g);
    return names ? names.map(n => n.substring(1)) : undefined;
  }
}

/**
 * DID注册表 - 管理已知智能体的DID信息
 */
export class DIDRegistry {
  private agents: Map<string, AgentInfo> = new Map();
  private ipfsClient: IpfsClient;

  constructor(ipfsApiUrl: string = 'http://127.0.0.1:5001') {
    this.ipfsClient = new IpfsClient(ipfsApiUrl, null);
  }

  async registerAgent(agent: AgentInfo): Promise<void> {
    this.agents.set(agent.did, {
      ...agent,
      lastSeen: Date.now()
    });
  }

  async unregisterAgent(did: string): Promise<void> {
    this.agents.delete(did);
  }

  getAgent(did: string): AgentInfo | undefined {
    return this.agents.get(did);
  }

  getAllAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  getOnlineAgents(): AgentInfo[] {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5分钟超时
    return this.getAllAgents().filter(a => a.lastSeen && (now - a.lastSeen) < timeout);
  }

  async resolveDIDFromIPNS(ipnsName: string): Promise<AgentInfo | null> {
    try {
      const cid = await this.ipfsClient.resolveIpns(ipnsName);
      const content = await this.ipfsClient.get(cid);
      const doc = JSON.parse(content);
      return {
        did: doc.id,
        name: doc.name || doc.id,
        ipnsName
      };
    } catch (error) {
      console.error(`Failed to resolve DID from IPNS ${ipnsName}:`, error);
      return null;
    }
  }

  async discoverAgents(): Promise<AgentInfo[]> {
    const discovered: AgentInfo[] = [];
    const peers = p2pNetwork.getPeers();

    for (const peerId of peers) {
      // 尝试从已知IPNS名称列表中解析
      // 实际实现中应该通过某种服务发现机制
      const agent = this.getAgentByPeerId(peerId);
      if (agent) {
        discovered.push(agent);
      }
    }

    return discovered;
  }

  private getAgentByPeerId(peerId: string): AgentInfo | undefined {
    for (const agent of this.agents.values()) {
      if (agent.peerId === peerId) {
        return agent;
      }
    }
    return undefined;
  }
}

/**
 * 协作决策器 - 判断是否需要多智能体协作
 */
export class CollaborationDecider {
  private threshold = 0.7;

  async shouldCollaborate(intent: CommandIntent, qualityScore?: number): Promise<boolean> {
    // 明确要求协作
    if (intent.needCollaboration) return true;

    // 质量问题，建议协作改进
    if (qualityScore && qualityScore < this.threshold) return true;

    // 复杂任务建议协作
    if (intent.action === 'improve' && intent.requirements) {
      if (intent.requirements.length > 200) return true; // 复杂需求
    }

    return false;
  }

  selectAgentsForTask(intent: CommandIntent, availableAgents: AgentInfo[]): AgentInfo[] {
    if (!availableAgents.length) return [];

    // 如果用户指定了智能体
    if (intent.suggestedAgents?.length) {
      return availableAgents.filter(a =>
        intent.suggestedAgents!.some(name =>
          a.name.includes(name) || a.did.includes(name)
        )
      );
    }

    // 根据任务类型选择
    switch (intent.action) {
      case 'improve':
        // 改进任务可以选多个智能体并行处理
        return availableAgents.slice(0, 3);
      case 'summarize':
        // 摘要任务选一个即可
        return [availableAgents[0]];
      default:
        return availableAgents.slice(0, 2);
    }
  }
}

/**
 * 任务分发器 - 管理多智能体任务分发和结果收集
 */
export class TaskDispatcher {
  private protocol: AgentProtocol;
  private pendingTasks: Map<string, { intent: CommandIntent; agents: AgentInfo[] }> = new Map();

  constructor(protocol: AgentProtocol) {
    this.protocol = protocol;
  }

  async dispatchSummarize(intent: CommandIntent, target: string, agents: AgentInfo[]): Promise<string> {
    const taskId = `summarize-${Date.now()}`;

    this.pendingTasks.set(taskId, { intent, agents });

    // 广播任务给选定的智能体
    for (const agent of agents) {
      const task: Task = {
        taskId,
        action: 'summarize',
        target,
        context: intent.context
      };
      await this.protocol.sendTask(task, agent.peerId || agent.did);
    }

    return taskId;
  }

  async dispatchImprove(intent: CommandIntent, target: string, agents: AgentInfo[]): Promise<string> {
    const taskId = `improve-${Date.now()}`;

    this.pendingTasks.set(taskId, { intent, agents });

    // 向每个智能体发送改进请求
    for (const agent of agents) {
      await this.protocol.requestImprove(target, intent.requirements || '', agent.peerId);
    }

    return taskId;
  }

  cancelTask(taskId: string): void {
    this.pendingTasks.delete(taskId);
  }

  getPendingTasks(): string[] {
    return Array.from(this.pendingTasks.keys());
  }
}

/**
 * 多智能体协作工作流 - 主协调器
 */
export class MultiAgentWorkflow {
  private parser: CommandParser;
  private registry: DIDRegistry;
  private decider: CollaborationDecider;
  private dispatcher: TaskDispatcher;
  private protocol: AgentProtocol;

  constructor() {
    this.parser = new CommandParser();
    this.registry = new DIDRegistry();
    this.decider = new CollaborationDecider();
    this.protocol = new AgentProtocol('local', 'coordinator');
    this.dispatcher = new TaskDispatcher(this.protocol);

    this.setupResultHandlers();
  }

  private setupResultHandlers(): void {
    // 处理返回结果
    p2pNetwork.onMessage('result', async (data, from) => {
      const msg = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      const result = JSON.parse(msg.payload) as TaskResult;
      console.log(`\n📥 收到来自 ${from} 的结果:`);
      console.log(`   质量: ${(result.qualityScore! * 10).toFixed(1)}/10`);
      console.log(`   摘要: ${result.result?.substring(0, 100)}...`);
    });

    // 处理改进结果
    p2pNetwork.onMessage('improved', async (data, from) => {
      const msg = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      const result = JSON.parse(msg.payload) as ImproveResult;
      console.log(`\n✨ 收到来自 ${from} 的改进结果:`);
      console.log(`   质量: ${(result.qualityScore! * 10).toFixed(1)}/10`);
      console.log(`   自动发送: ${result.shouldAutoSend ? '是' : '否'}`);
    });
  }

  /**
   * 处理用户输入的完整流程
   */
  async process(input: string, context?: string): Promise<CollaborationResult> {
    // 1. 命令解析
    const intent = this.parser.parse(input, context);
    console.log(`\n🔍 解析命令:`, intent);

    // 2. 发现可用的智能体
    const agents = await this.registry.discoverAgents();
    console.log(`\n👥 发现 ${agents.length} 个在线智能体`);

    // 3. 协作决策
    const shouldCollaborate = await this.decider.shouldCollaborate(intent);
    console.log(`\n🤔 协作决策: ${shouldCollaborate ? '需要协作' : '独立完成'}`);

    if (!shouldCollaborate) {
      // 独立执行
      return this.executeIndependently(intent);
    }

    // 4. 选择执行智能体
    const selectedAgents = this.decider.selectAgentsForTask(intent, agents);
    console.log(`\n🎯 选中 ${selectedAgents.length} 个智能体执行`);

    if (selectedAgents.length === 0) {
      // 没有可用智能体，降级为独立执行
      console.log(`\n⚠️ 没有可用智能体，降级为独立执行`);
      return this.executeIndependently(intent);
    }

    // 5. 分发任务
    return this.dispatchToAgents(intent, selectedAgents);
  }

  /**
   * 独立执行（无需协作）
   */
  private async executeIndependently(intent: CommandIntent): Promise<CollaborationResult> {
    try {
      let result: string;
      let qualityScore = 0.5;

      if (intent.action === 'read' || intent.action === 'summarize') {
        if (!intent.target) {
          return { success: false, collaborated: false, agents: [], error: '缺少目标文件' };
        }
        const content = await documentReader.read(intent.target);
        const llm = getMinimax();
        const summarizeResult = await llm.summarize(content.text, intent.context);
        result = summarizeResult.summary;
        qualityScore = summarizeResult.qualityScore;
      } else if (intent.action === 'improve' && intent.target) {
        const content = await documentReader.read(intent.target);
        const llm = getMinimax();
        result = await llm.improveContent(content.text, intent.requirements || '', intent.context);
        qualityScore = llm.estimateQuality(content.text, result);
      } else {
        return { success: false, collaborated: false, agents: [], error: '未知动作' };
      }

      return {
        success: true,
        collaborated: false,
        agents: [],
        result,
        qualityScore
      };
    } catch (error) {
      return {
        success: false,
        collaborated: false,
        agents: [],
        error: String(error)
      };
    }
  }

  /**
   * 分发给多个智能体协作执行
   */
  private async dispatchToAgents(intent: CommandIntent, agents: AgentInfo[]): Promise<CollaborationResult> {
    try {
      if (!intent.target) {
        return { success: false, collaborated: true, agents, error: '缺少目标文件' };
      }

      let taskId: string;

      if (intent.action === 'summarize' || intent.action === 'read') {
        taskId = await this.dispatcher.dispatchSummarize(intent, intent.target, agents);
      } else if (intent.action === 'improve') {
        taskId = await this.dispatcher.dispatchImprove(intent, intent.target, agents);
      } else {
        return { success: false, collaborated: true, agents, error: '不支持的协作动作' };
      }

      return {
        success: true,
        collaborated: true,
        agents,
        taskId,
        result: `任务已分发，等待结果...`
      };
    } catch (error) {
      return {
        success: false,
        collaborated: true,
        agents,
        error: String(error)
      };
    }
  }

  /**
   * 查询当前在线的智能体
   */
  async listAgents(): Promise<AgentInfo[]> {
    return this.registry.discoverAgents();
  }

  /**
   * 注册一个新智能体
   */
  async registerAgent(agent: AgentInfo): Promise<void> {
    await this.registry.registerAgent(agent);
  }
}
