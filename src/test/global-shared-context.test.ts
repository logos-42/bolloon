import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  GlobalSharedContextManager,
  resetGlobalSharedContext
} from '../social/global-shared-context.js';

const TEST_CONTEXT_PATH = path.join('/tmp', '.bolloon-test', 'sessions', 'test-global-context.json');

describe('GlobalSharedContext', () => {
  let contextManager: GlobalSharedContextManager;

  beforeEach(async () => {
    resetGlobalSharedContext();
    contextManager = new GlobalSharedContextManager(TEST_CONTEXT_PATH);
    try {
      await fs.rm(path.dirname(TEST_CONTEXT_PATH), { recursive: true, force: true });
    } catch {}
  });

  describe('SharedMemory - recentActions', () => {
    it('should add user action', async () => {
      await contextManager.initialize();
      await contextManager.addUserAction('用户要求总结文档', 'agent1', 'channel1', 8);

      const actions = await contextManager.getRecentActions();
      expect(actions).toHaveLength(1);
      expect(actions[0].content).toBe('用户要求总结文档');
      expect(actions[0].agentId).toBe('agent1');
      expect(actions[0].channelId).toBe('channel1');
      expect(actions[0].importance).toBe(8);
    });

    it('should limit recent actions to 50', async () => {
      await contextManager.initialize();

      for (let i = 0; i < 60; i++) {
        await contextManager.addUserAction(`Action ${i}`);
      }

      const actions = await contextManager.getRecentActions(60);
      expect(actions).toHaveLength(50);
    });

    it('should return formatted summary', async () => {
      await contextManager.initialize();
      await contextManager.addUserAction('测试行动1');
      await contextManager.addUserAction('测试行动2');

      const summary = await contextManager.getRecentActionsSummary(10);
      expect(summary).toContain('测试行动1');
      expect(summary).toContain('测试行动2');
    });
  });

  describe('SharedMemory - sharedKnowledge', () => {
    it('should add shared knowledge', async () => {
      await contextManager.initialize();
      await contextManager.addSharedKnowledge('这是一个重要的跨Agent共享知识');

      const knowledge = await contextManager.getSharedKnowledge();
      expect(knowledge).toContain('这是一个重要的跨Agent共享知识');
    });

    it('should not duplicate knowledge', async () => {
      await contextManager.initialize();
      await contextManager.addSharedKnowledge('共享知识');
      await contextManager.addSharedKnowledge('共享知识');

      const knowledge = await contextManager.getSharedKnowledge();
      expect(knowledge.filter(k => k === '共享知识')).toHaveLength(1);
    });

    it('should limit shared knowledge to 100', async () => {
      await contextManager.initialize();

      for (let i = 0; i < 110; i++) {
        await contextManager.addSharedKnowledge(`Knowledge ${i}`);
      }

      const knowledge = await contextManager.getSharedKnowledge();
      expect(knowledge).toHaveLength(100);
    });
  });

  describe('SharedMemory - currentTask', () => {
    it('should set and get current task', async () => {
      await contextManager.initialize();
      const task = await contextManager.setCurrentTask({
        description: '完成文档总结',
        status: 'in_progress'
      });

      expect(task.id).toBeDefined();
      expect(task.description).toBe('完成文档总结');
      expect(task.status).toBe('in_progress');
      expect(task.createdAt).toBeDefined();

      const currentTask = await contextManager.getCurrentTask();
      expect(currentTask?.description).toBe('完成文档总结');
    });

    it('should complete current task', async () => {
      await contextManager.initialize();
      await contextManager.setCurrentTask({
        description: '完成文档总结',
        status: 'in_progress'
      });

      await contextManager.completeCurrentTask('文档总结已完成');

      const currentTask = await contextManager.getCurrentTask();
      expect(currentTask?.status).toBe('completed');
      expect(currentTask?.result).toBe('文档总结已完成');
      expect(currentTask?.completedAt).toBeDefined();
    });
  });

  describe('AgentRegistry', () => {
    it('should register agent', async () => {
      await contextManager.initialize();
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding', 'writing'],
        status: 'active',
        name: 'TestAgent'
      });

      const agent = await contextManager.getAgent('agent-001');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('TestAgent');
      expect(agent?.capabilities).toEqual(['coding', 'writing']);
      expect(agent?.status).toBe('active');
    });

    it('should update agent status', async () => {
      await contextManager.initialize();
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });

      await contextManager.updateAgentStatus('agent-001', 'busy');

      const agent = await contextManager.getAgent('agent-001');
      expect(agent?.status).toBe('busy');
    });

    it('should get all agents', async () => {
      await contextManager.initialize();
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });
      await contextManager.registerAgent({
        agentId: 'agent-002',
        sessionId: 'session-002',
        channelId: 'channel-002',
        capabilities: ['writing'],
        status: 'idle'
      });

      const agents = await contextManager.getAllAgents();
      expect(agents).toHaveLength(2);
    });

    it('should find agents by capability', async () => {
      await contextManager.initialize();
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding', 'debugging'],
        status: 'active'
      });
      await contextManager.registerAgent({
        agentId: 'agent-002',
        sessionId: 'session-002',
        channelId: 'channel-002',
        capabilities: ['writing', 'editing'],
        status: 'active'
      });

      const codingAgents = await contextManager.findAgentByCapability('coding');
      expect(codingAgents).toHaveLength(1);
      expect(codingAgents[0].agentId).toBe('agent-001');
    });

    it('should get active agents', async () => {
      await contextManager.initialize();
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });
      await contextManager.registerAgent({
        agentId: 'agent-002',
        sessionId: 'session-002',
        channelId: 'channel-002',
        capabilities: ['writing'],
        status: 'idle'
      });

      const activeAgents = await contextManager.getActiveAgents();
      expect(activeAgents).toHaveLength(1);
      expect(activeAgents[0].agentId).toBe('agent-001');
    });

    it('should unregister agent', async () => {
      await contextManager.initialize();
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });

      await contextManager.unregisterAgent('agent-001');

      const agent = await contextManager.getAgent('agent-001');
      expect(agent).toBeUndefined();
    });
  });

  describe('CooperationQueue', () => {
    it('should create cooperation task', async () => {
      await contextManager.initialize();
      const cooperation = await contextManager.createCooperation(
        'consult',
        'agent-001',
        '请帮我分析这段代码',
        'agent-002',
        'context here'
      );

      expect(cooperation.id).toBeDefined();
      expect(cooperation.type).toBe('consult');
      expect(cooperation.fromAgentId).toBe('agent-001');
      expect(cooperation.toAgentId).toBe('agent-002');
      expect(cooperation.task).toBe('请帮我分析这段代码');
      expect(cooperation.context).toBe('context here');
      expect(cooperation.status).toBe('pending');
    });

    it('should update cooperation status', async () => {
      await contextManager.initialize();
      const cooperation = await contextManager.createCooperation(
        'delegate',
        'agent-001',
        '完成这个任务'
      );

      await contextManager.updateCooperationStatus(cooperation.id, 'in_progress');

      const updated = await contextManager.getCooperation(cooperation.id);
      expect(updated?.status).toBe('in_progress');
    });

    it('should get pending cooperations for agent', async () => {
      await contextManager.initialize();
      await contextManager.createCooperation('consult', 'agent-001', 'Task 1', 'agent-002');
      await contextManager.createCooperation('delegate', 'agent-001', 'Task 2');

      const pending = await contextManager.getPendingCooperations('agent-001');
      expect(pending).toHaveLength(2);
    });

    it('should get cooperations for specific agent', async () => {
      await contextManager.initialize();
      await contextManager.createCooperation('consult', 'agent-001', 'Task for agent-002', 'agent-002');
      await contextManager.createCooperation('delegate', 'agent-003', 'Task for agent-003', 'agent-003');

      const agent002Coops = await contextManager.getCooperationsForAgent('agent-002');
      expect(agent002Coops).toHaveLength(1);
      expect(agent002Coops[0].task).toBe('Task for agent-002');
    });

    it('should add result to cooperation', async () => {
      await contextManager.initialize();
      const cooperation = await contextManager.createCooperation(
        'consult',
        'agent-001',
        '请分析'
      );

      await contextManager.updateCooperationStatus(cooperation.id, 'done', '分析结果：代码有bug');

      const updated = await contextManager.getCooperation(cooperation.id);
      expect(updated?.status).toBe('done');
      expect(updated?.result).toBe('分析结果：代码有bug');
    });
  });

  describe('Full context', () => {
    it('should get full context', async () => {
      await contextManager.initialize();
      await contextManager.addUserAction('Test action');
      await contextManager.addSharedKnowledge('Test knowledge');
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });

      const fullContext = await contextManager.getFullContext();

      expect(fullContext.memory.recentActions).toHaveLength(1);
      expect(fullContext.memory.sharedKnowledge).toHaveLength(1);
      expect(fullContext.agentRegistry['agent-001']).toBeDefined();
    });

    it('should get context summary', async () => {
      await contextManager.initialize();
      await contextManager.addUserAction('用户执行了操作A');
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active',
        name: '编码助手'
      });

      const summary = await contextManager.getContextSummary();

      expect(summary).toContain('全局共享上下文');
      expect(summary).toContain('最近行动');
      expect(summary).toContain('用户执行了操作A');
      expect(summary).toContain('Agent 注册');
      expect(summary).toContain('编码助手');
    });
  });

  describe('Persistence', () => {
    it('should persist and reload context', async () => {
      await contextManager.initialize();
      await contextManager.addUserAction('持久化测试');
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });

      const newManager = new GlobalSharedContextManager(TEST_CONTEXT_PATH);
      await newManager.initialize();

      const actions = await newManager.getRecentActions();
      expect(actions).toHaveLength(1);
      expect(actions[0].content).toBe('持久化测试');

      const agent = await newManager.getAgent('agent-001');
      expect(agent).toBeDefined();
    });
  });

  describe('Clear', () => {
    it('should clear all data', async () => {
      await contextManager.initialize();
      await contextManager.addUserAction('Test action');
      await contextManager.addSharedKnowledge('Test knowledge');
      await contextManager.registerAgent({
        agentId: 'agent-001',
        sessionId: 'session-001',
        channelId: 'channel-001',
        capabilities: ['coding'],
        status: 'active'
      });

      await contextManager.clear();

      const context = await contextManager.getFullContext();
      expect(context.memory.recentActions).toHaveLength(0);
      expect(context.memory.sharedKnowledge).toHaveLength(0);
      expect(Object.keys(context.agentRegistry)).toHaveLength(0);
    });
  });
});