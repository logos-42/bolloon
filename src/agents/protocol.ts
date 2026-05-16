import { p2pNetwork } from '../network/p2p.js';
import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../constraints/index.js';

export type MessageType = 'task' | 'result' | 'report' | 'feedback' | 'improve' | 'improved';

export interface AgentMessage {
  type: MessageType;
  from: string;
  to?: string;
  taskId: string;
  payload: string;
  timestamp: number;
}

export interface Task {
  taskId: string;
  action: 'read' | 'summarize' | 'improve' | 'report';
  target?: string;
  documentPath?: string;
  context?: string;
  requirements?: string;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  result?: string;
  qualityScore?: number;
  needsApproval?: boolean;
  autoSent?: boolean;
}

export interface ImproveResult {
  taskId: string;
  success: boolean;
  originalPath?: string;
  improvedContent?: string;
  qualityScore?: number;
  shouldAutoSend: boolean;
  needsApproval: boolean;
}

export class AgentProtocol {
  private peerId: string;
  private identityName: string;
  private pendingTasks: Map<string, Task> = new Map();
  private taskQueue: Task[] = [];
  private autoSendThreshold = 0.7;
  private autonomousMode = true;

  constructor(peerId: string, identityName?: string) {
    this.peerId = peerId;
    this.identityName = identityName || `Agent-${peerId.substring(0, 8)}`;
    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    p2pNetwork.onMessage('task', async (data, from) => {
      const message = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      await this.handleTask(message);
    });

    p2pNetwork.onMessage('result', async (data, from) => {
      const message = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      await this.handleResult(message);
    });

    p2pNetwork.onMessage('feedback', async (data, from) => {
      const message = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      await this.handleFeedback(message);
    });

    p2pNetwork.onMessage('improve', async (data, from) => {
      const message = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      await this.handleImproveRequest(message);
    });

    p2pNetwork.onMessage('improved', async (data, from) => {
      const message = JSON.parse(new TextDecoder().decode(data)) as AgentMessage;
      await this.handleImprovedResult(message);
    });
  }

  async sendTask(task: Task, targetPeer: string): Promise<void> {
    const message: AgentMessage = {
      type: 'task',
      from: this.peerId,
      to: targetPeer,
      taskId: task.taskId,
      payload: JSON.stringify(task),
      timestamp: Date.now()
    };

    this.pendingTasks.set(task.taskId, task);
    await p2pNetwork.sendMessage(targetPeer, 'task', JSON.stringify(message));
  }

  async broadcastTask(task: Task): Promise<void> {
    const message: AgentMessage = {
      type: 'task',
      from: this.peerId,
      taskId: task.taskId,
      payload: JSON.stringify(task),
      timestamp: Date.now()
    };

    this.pendingTasks.set(task.taskId, task);
    await p2pNetwork.broadcast('task', JSON.stringify(message));
  }

  async requestImprove(documentPath: string, requirements: string, targetPeer?: string): Promise<void> {
    const task: Task = {
      taskId: `improve-${Date.now()}`,
      action: 'improve',
      documentPath,
      requirements,
      context: `Requested by ${this.identityName}`
    };

    const message: AgentMessage = {
      type: 'improve',
      from: this.peerId,
      to: targetPeer,
      taskId: task.taskId,
      payload: JSON.stringify(task),
      timestamp: Date.now()
    };

    this.pendingTasks.set(task.taskId, task);

    if (targetPeer) {
      await p2pNetwork.sendMessage(targetPeer, 'improve', JSON.stringify(message));
    } else {
      await p2pNetwork.broadcast('improve', JSON.stringify(message));
    }
  }

  private async handleTask(message: AgentMessage): Promise<void> {
    const task = JSON.parse(message.payload) as Task;

    if (task.action === 'read' && task.documentPath) {
      const content = await documentReader.read(task.documentPath);
      const result = await this.processDocument(content, task.context);

      const resultMsg: AgentMessage = {
        type: 'result',
        from: this.peerId,
        to: message.from,
        taskId: task.taskId,
        payload: JSON.stringify(result),
        timestamp: Date.now()
      };

      await p2pNetwork.sendMessage(message.from, 'result', JSON.stringify(resultMsg));
    } else if (task.action === 'improve' && task.documentPath && task.requirements) {
      const result = await this.processImprove(task);
      const resultMsg: AgentMessage = {
        type: 'improved',
        from: this.peerId,
        to: message.from,
        taskId: task.taskId,
        payload: JSON.stringify(result),
        timestamp: Date.now()
      };

      if (result.shouldAutoSend && this.autonomousMode) {
        console.log(`\n🤖 [${this.identityName}] 自动发送改进结果 (质量: ${(result.qualityScore! * 10).toFixed(1)}/10)`);
        await p2pNetwork.sendMessage(message.from, 'improved', JSON.stringify(resultMsg));
      } else if (result.needsApproval) {
        console.log(`\n📋 [${this.identityName}] 改进完成，等待审批 (质量: ${(result.qualityScore! * 10).toFixed(1)}/10)`);
      }
    }
  }

  private async processImprove(task: Task): Promise<ImproveResult> {
    const llm = getMinimax();
    const content = await documentReader.read(task.documentPath!);
    const improvedContent = await llm.improveContent(content.text, task.requirements!, task.context);
    const qualityScore = llm.estimateQuality(content.text, improvedContent);
    const shouldAutoSend = await llm.shouldAutoSend(qualityScore, this.autoSendThreshold);

    return {
      taskId: task.taskId,
      success: true,
      originalPath: task.documentPath,
      improvedContent,
      qualityScore,
      shouldAutoSend,
      needsApproval: !shouldAutoSend
    };
  }

  private async processDocument(content: DocumentContent, context?: string): Promise<TaskResult> {
    const llm = getMinimax();
    const chunks = documentReader.chunk(content.text);
    const summaries: string[] = [];
    let totalQuality = 0;

    for (const chunk of chunks) {
      const result = await llm.summarize(chunk, context);
      summaries.push(result.summary);
      totalQuality += result.qualityScore;
    }

    const combinedSummary = summaries.join('\n\n');
    const avgQuality = totalQuality / chunks.length;

    const canAutoSend = await llm.shouldAutoSend(avgQuality, this.autoSendThreshold);

    return {
      taskId: `task-${Date.now()}`,
      success: true,
      result: combinedSummary,
      qualityScore: avgQuality,
      needsApproval: !canAutoSend,
      autoSent: canAutoSend && this.autonomousMode
    };
  }

  private async handleResult(message: AgentMessage): Promise<void> {
    const result = JSON.parse(message.payload) as TaskResult;
    const task = this.pendingTasks.get(message.taskId);

    if (result.needsApproval && !result.autoSent) {
      console.log('\n📋 文档处理完成，需要人工确认:');
      console.log(`   质量评分: ${(result.qualityScore! * 10).toFixed(1)}/10`);
      console.log(`   摘要预览: ${result.result?.substring(0, 200)}...\n`);
    } else if (result.autoSent || this.autonomousMode) {
      console.log('\n✅ 文档处理完成，自动发送汇报');
      await this.autoReport(result, message.from);
    }
  }

  private async handleImproveRequest(message: AgentMessage): Promise<void> {
    const task = JSON.parse(message.payload) as Task;
    console.log(`\n📝 [${this.identityName}] 收到改进请求: ${task.documentPath}`);
    console.log(`   要求: ${task.requirements}`);
  }

  private async handleImprovedResult(message: AgentMessage): Promise<void> {
    const result = JSON.parse(message.payload) as ImproveResult;
    const task = this.pendingTasks.get(message.taskId);

    console.log('\n✨ 改进结果已接收:');
    console.log(`   原始文档: ${result.originalPath}`);
    console.log(`   质量评分: ${(result.qualityScore! * 10).toFixed(1)}/10`);
    console.log(`   自动发送: ${result.shouldAutoSend ? '是' : '否'}`);
    console.log(`   改进预览: ${result.improvedContent?.substring(0, 200)}...\n`);
  }

  private async handleFeedback(message: AgentMessage): Promise<void> {
    const { taskId, improvements } = JSON.parse(message.payload);
    console.log(`\n📝 [${this.identityName}] 收到改进意见 for task ${taskId}:`, improvements);
  }

  private async autoReport(result: TaskResult, fromPeer: string): Promise<void> {
    const reportMsg: AgentMessage = {
      type: 'report',
      from: this.peerId,
      taskId: result.taskId,
      payload: JSON.stringify({
        summary: result.result,
        qualityScore: result.qualityScore,
        fromAgent: this.identityName
      }),
      timestamp: Date.now()
    };

    const peers = p2pNetwork.getPeers();
    for (const peer of peers) {
      if (peer !== fromPeer) {
        await p2pNetwork.sendMessage(peer, 'report', JSON.stringify(reportMsg));
      }
    }
  }

  async submitImprovements(taskId: string, improvements: string): Promise<void> {
    const feedbackMsg: AgentMessage = {
      type: 'feedback',
      from: this.peerId,
      taskId,
      payload: JSON.stringify({ taskId, improvements }),
      timestamp: Date.now()
    };

    const peers = p2pNetwork.getPeers();
    for (const peer of peers) {
      await p2pNetwork.sendMessage(peer, 'feedback', JSON.stringify(feedbackMsg));
    }
  }

  setAutoSendThreshold(threshold: number): void {
    this.autoSendThreshold = threshold;
  }

  setAutonomousMode(enabled: boolean): void {
    this.autonomousMode = enabled;
  }

  isAutonomousMode(): boolean {
    return this.autonomousMode;
  }
}