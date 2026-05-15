/**
 * WorkflowEngine Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowEngine, WorkflowStep } from '../agents/workflow-engine.js';
import { WorkflowContext, ConstraintLayer } from '../agents/constraint-layer.js';

// Mock dependencies
vi.mock('../documents/reader.js', () => ({
  documentReader: {
    read: vi.fn().mockResolvedValue({
      text: 'test content',
      metadata: { filename: 'test.txt', size: 12, type: '.txt' }
    }),
    chunk: vi.fn().mockReturnValue(['test content'])
  }
}));

vi.mock('../llm/minimax.js', () => ({
  getMinimax: vi.fn().mockReturnValue({
    summarize: vi.fn().mockResolvedValue({ summary: 'test summary', qualityScore: 0.8 }),
    improveContent: vi.fn().mockResolvedValue('improved content')
  })
}));

vi.mock('../network/p2p.js', () => ({
  p2pNetwork: {
    getPeers: vi.fn().mockReturnValue(['peer1', 'peer2']),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine();
    vi.clearAllMocks();
  });

  describe('executeStep', () => {
    it('should execute read step successfully', async () => {
      const step: WorkflowStep = {
        id: 'read',
        type: 'read',
        config: { path: 'test.txt' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'abort'
      };

      const context: WorkflowContext = { peers: [], logs: [] };
      const result = await engine.executeStep(step, context);

      expect(result.status).toBe('success');
    });
  });

  describe('executeWorkflow', () => {
    it('should execute multiple steps in order', async () => {
      const steps: WorkflowStep[] = [
        {
          id: 'read',
          type: 'read',
          config: { path: 'test.txt' },
          retry: { max: 0, current: 0, backoffMs: 0 },
          onFail: 'abort'
        },
        {
          id: 'chunk',
          type: 'chunk',
          config: { maxChunkSize: 1000 },
          retry: { max: 0, current: 0, backoffMs: 0 },
          onFail: 'abort'
        }
      ];

      const workflow = await engine.executeWorkflow(steps);

      expect(workflow.status).toBe('completed');
      expect(workflow.results.size).toBe(2);
    });
  });

  describe('getConstraintLayer', () => {
    it('should return the constraint layer instance', () => {
      const layer = engine.getConstraintLayer();
      expect(layer).toBeDefined();
      expect(layer instanceof ConstraintLayer).toBe(true);
    });
  });

  describe('setConstraintLayer', () => {
    it('should allow setting a custom constraint layer', () => {
      const customLayer = new ConstraintLayer();
      engine.setConstraintLayer(customLayer);
      expect(engine.getConstraintLayer()).toBe(customLayer);
    });
  });
});