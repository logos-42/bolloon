import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  SubAgentManager,
  resetSubAgentManager,
  type SubAgent,
  type SubAgentTask
} from '../agents/subagent-manager.js';

const TEST_STORAGE_PATH = path.join('/tmp', '.bolloon-test', 'agents');

describe('SubAgentManager', () => {
  let manager: SubAgentManager;

  beforeEach(async () => {
    resetSubAgentManager();
    manager = new SubAgentManager({ storagePath: TEST_STORAGE_PATH });
    try {
      await fs.rm(TEST_STORAGE_PATH, { recursive: true, force: true });
    } catch {}
  });

  describe('Agent Registration', () => {
    it('should register a new agent', async () => {
      await manager.initialize();

      const agent = await manager.registerAgent({
        name: 'TestAgent',
        capabilities: ['coding', 'debugging'],
        parentAgentId: 'parent-001'
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('TestAgent');
      expect(agent.capabilities).toEqual(['coding', 'debugging']);
      expect(agent.status).toBe('active');
      expect(agent.parentAgentId).toBe('parent-001');
    });

    it('should update agent status', async () => {
      await manager.initialize();
      const agent = await manager.registerAgent({
        name: 'TestAgent',
        capabilities: ['coding']
      });

      await manager.updateAgentStatus(agent.id, 'busy');
      const updated = await manager.getAgent(agent.id);

      expect(updated?.status).toBe('busy');
    });

    it('should update agent info', async () => {
      await manager.initialize();
      const agent = await manager.registerAgent({
        name: 'TestAgent',
        capabilities: ['coding']
      });

      await manager.updateAgent(agent.id, {
        did: 'did:key:test123',
        walletAddress: '0x123...'
      });

      const updated = await manager.getAgent(agent.id);
      expect(updated?.did).toBe('did:key:test123');
      expect(updated?.walletAddress).toBe('0x123...');
    });

    it('should get all agents', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Agent2', capabilities: ['writing'] });

      const agents = await manager.getAllAgents();
      expect(agents).toHaveLength(2);
    });

    it('should get active agents only', async () => {
      await manager.initialize();
      const agent1 = await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Agent2', capabilities: ['writing'] });

      await manager.updateAgentStatus(agent1.id, 'terminated');

      const activeAgents = await manager.getActiveAgents();
      expect(activeAgents).toHaveLength(1);
      expect(activeAgents[0].name).toBe('Agent2');
    });

    it('should find agents by capability', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Coder', capabilities: ['coding', 'debugging'] });
      await manager.registerAgent({ name: 'Writer', capabilities: ['writing', 'editing'] });
      await manager.registerAgent({ name: 'FullStack', capabilities: ['coding', 'writing'] });

      const coders = await manager.getAgentsByCapability('coding');
      expect(coders).toHaveLength(2);
    });

    it('should find agent by DID', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'], did: 'did:key:abc' });

      const agent = await manager.getAgentByDid('did:key:abc');
      expect(agent?.name).toBe('Agent1');
    });

    it('should unregister agent', async () => {
      await manager.initialize();
      const agent = await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });

      await manager.unregisterAgent(agent.id);

      const deleted = await manager.getAgent(agent.id);
      expect(deleted).toBeUndefined();
    });
  });

  describe('Task Management', () => {
    it('should create a task', async () => {
      await manager.initialize();

      const task = await manager.createTask(
        'delegate',
        'Fix bug',
        'Fix the login bug in the authentication module',
        'parent-001',
        'agent-001',
        'high',
        'Bug ID: #1234'
      );

      expect(task.id).toBeDefined();
      expect(task.title).toBe('Fix bug');
      expect(task.type).toBe('delegate');
      expect(task.priority).toBe('high');
      expect(task.status).toBe('assigned');
    });

    it('should create pending task without assignee', async () => {
      await manager.initialize();

      const task = await manager.createTask(
        'consult',
        'Code review',
        'Review the new API implementation',
        'parent-001'
      );

      expect(task.status).toBe('pending');
      expect(task.toAgentId).toBeUndefined();
    });

    it('should assign task to agent', async () => {
      await manager.initialize();
      const agent = await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      const task = await manager.createTask('delegate', 'Task', 'Description', 'parent-001');

      await manager.assignTask(task.id, agent.id);

      const updated = await manager.getTask(task.id);
      expect(updated?.assignedAgentId).toBe(agent.id);
      expect(updated?.status).toBe('assigned');
    });

    it('should update task status', async () => {
      await manager.initialize();
      const task = await manager.createTask('delegate', 'Task', 'Description', 'parent-001');

      await manager.updateTaskStatus(task.id, 'completed', 'Task result', undefined);

      const updated = await manager.getTask(task.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.result).toBe('Task result');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should get tasks for agent', async () => {
      await manager.initialize();
      const agent = await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      await manager.createTask('delegate', 'Task1', 'Desc1', 'parent-001', agent.id);
      await manager.createTask('delegate', 'Task2', 'Desc2', 'parent-001', agent.id);

      const tasks = await manager.getTasksForAgent(agent.id);
      expect(tasks).toHaveLength(2);
    });

    it('should get pending tasks', async () => {
      await manager.initialize();
      await manager.createTask('delegate', 'Task1', 'Desc1', 'parent-001');
      await manager.createTask('delegate', 'Task2', 'Desc2', 'parent-001');
      await manager.createTask('delegate', 'Task3', 'Desc3', 'parent-001', 'agent-001');

      const pending = await manager.getPendingTasks();
      expect(pending).toHaveLength(2);
    });
  });

  describe('Task Delegation', () => {
    it('should find best agent for task', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Coder', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Writer', capabilities: ['writing'] });
      await manager.registerAgent({ name: 'FullStack', capabilities: ['coding', 'writing'] });

      const agent = await manager.findBestAgentForTask(['coding']);
      expect(agent).toBeDefined();
      expect(agent?.capabilities).toContain('coding');
    });

    it('should delegate task to best available agent', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Coder', capabilities: ['coding'] });

      const { task, agent } = await manager.delegateTask(
        'parent-001',
        'Implement the new feature',
        ['coding']
      );

      expect(task.status).toBe('assigned');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Coder');
    });

    it('should create pending task if no agent available', async () => {
      await manager.initialize();

      const { task, agent } = await manager.delegateTask(
        'parent-001',
        'Implement the new feature',
        ['quantum-computing']
      );

      expect(task.status).toBe('pending');
      expect(agent).toBeUndefined();
    });
  });

  describe('Inter-Agent Messaging', () => {
    it('should send message between agents', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Sender', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Receiver', capabilities: ['coding'] });

      const message = await manager.sendMessage(
        'sender-id',
        'receiver-id',
        'Hello, can you help with this task?',
        'query'
      );

      expect(message.id).toBeDefined();
      expect(message.content).toBe('Hello, can you help with this task?');
      expect(message.type).toBe('query');
    });

    it('should get messages for agent', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Sender', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Receiver', capabilities: ['coding'] });

      await manager.sendMessage('sender-id', 'receiver-id', 'Message 1');
      await manager.sendMessage('sender-id', 'receiver-id', 'Message 2');

      const messages = await manager.getMessagesForAgent('receiver-id');
      expect(messages).toHaveLength(2);
    });

    it('should receive messages via listener', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Sender', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Receiver', capabilities: ['coding'] });

      let receivedMessage: any = null;
      const unsubscribe = manager.onMessage('receiver-id', (msg) => {
        receivedMessage = msg;
      });

      await manager.sendMessage('sender-id', 'receiver-id', 'Test message');

      expect(receivedMessage).toBeDefined();
      expect(receivedMessage.content).toBe('Test message');

      unsubscribe();
    });

    it('should broadcast message to all agents', async () => {
      await manager.initialize();
      const agent1 = await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      const agent2 = await manager.registerAgent({ name: 'Agent2', capabilities: ['coding'] });
      const agent3 = await manager.registerAgent({ name: 'Agent3', capabilities: ['coding'] });

      await manager.broadcastMessage('parent-id', 'System-wide notification');

      const msgs1 = await manager.getMessagesForAgent(agent1.id);
      const msgs2 = await manager.getMessagesForAgent(agent2.id);
      const msgs3 = await manager.getMessagesForAgent(agent3.id);

      expect(msgs1).toHaveLength(1);
      expect(msgs2).toHaveLength(1);
      expect(msgs3).toHaveLength(1);
    });

    it('should consult another agent', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Agent2', capabilities: ['coding'] });

      const message = await manager.consultAgent(
        'agent1-id',
        'agent2-id',
        'What is the best approach for this?'
      );

      expect(message.type).toBe('query');
      expect(message.toAgentId).toBe('agent2-id');
    });
  });

  describe('Task Listeners', () => {
    it('should notify task listeners on status change', async () => {
      await manager.initialize();
      const task = await manager.createTask('delegate', 'Task', 'Desc', 'parent-001');

      let updatedTask: SubAgentTask | null = null;
      manager.onTask((t) => {
        updatedTask = t;
      });

      await manager.updateTaskStatus(task.id, 'completed', 'Done');

      expect(updatedTask).toBeDefined();
      expect(updatedTask?.status).toBe('completed');
    });
  });

  describe('Statistics', () => {
    it('should return agent statistics', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });
      await manager.registerAgent({ name: 'Agent2', capabilities: ['writing'] });
      await manager.createTask('delegate', 'Task1', 'Desc', 'parent-001');
      await manager.createTask('delegate', 'Task2', 'Desc', 'parent-001', 'agent-001');

      const stats = await manager.getAgentStatistics();

      expect(stats.total).toBe(2);
      expect(stats.pendingTasks).toBe(1);
      expect(stats.activeTasks).toBe(1);
    });
  });

  describe('Persistence', () => {
    it('should persist and reload agents', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });

      const newManager = new SubAgentManager({ storagePath: TEST_STORAGE_PATH });
      await newManager.initialize();

      const agents = await newManager.getAllAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Agent1');
    });

    it('should persist and reload tasks', async () => {
      await manager.initialize();
      await manager.createTask('delegate', 'Task1', 'Desc', 'parent-001');

      const newManager = new SubAgentManager({ storagePath: TEST_STORAGE_PATH });
      await newManager.initialize();

      const tasks = await newManager.getPendingTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  describe('Destroy', () => {
    it('should clean up all data on destroy', async () => {
      await manager.initialize();
      await manager.registerAgent({ name: 'Agent1', capabilities: ['coding'] });

      await manager.destroy();

      const agents = await manager.getAllAgents();
      expect(agents).toHaveLength(0);
    });
  });
});