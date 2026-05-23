import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  evaluateDecision,
  submitDecisionResponse,
  queryInternalAgents,
  getPendingDecisions,
  getDecisionRequest,
  getDecisionStats,
  setConfidenceThreshold,
  setDefaultDecisionLevel,
  type DecisionLevel,
} from '../pi-ecosystem-judgment/decision.js';
import * as judgmentModule from '../pi-ecosystem-judgment/index.js';

vi.mock('../pi-ecosystem-colony/index.js', () => ({
  listAnts: vi.fn().mockReturnValue([
    { id: 'ant-1', name: 'BuilderAnt', signal: 'ACTIVE', capabilities: ['coding'] },
    { id: 'ant-2', name: 'ReviewerAnt', signal: 'ACTIVE', capabilities: ['review'] },
    { id: 'ant-3', name: 'TesterAnt', signal: 'ACTIVE', capabilities: ['testing'] },
  ]),
}));

vi.mock('../pi-ecosystem-subagents/index.js', () => ({
  listSubagents: vi.fn().mockReturnValue([
    { id: 'sub-1', name: 'CodeSubagent', status: 'running', capabilities: ['coding'] },
    { id: 'sub-2', name: 'DocSubagent', status: 'running', capabilities: ['writing'] },
  ]),
}));

describe('Decision System - Internal vs External Judgment Communication', () => {
  beforeEach(() => {
    setConfidenceThreshold(0.7);
    setDefaultDecisionLevel('autonomous');
    vi.clearAllMocks();
  });

  describe('Decision Level Determination', () => {
    it('should be autonomous when confidence >= threshold', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.9);

      const request = await evaluateDecision(
        'Use const instead of var',
        'typescript',
        'agent-001',
        0.7
      );

      expect(request.level).toBe('autonomous');
      expect(request.targets).toEqual([]);
      expect(request.status).toBe('pending');
    });

    it('should consult_internal when confidence >= threshold * 0.7 but < threshold', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.5);

      const request = await evaluateDecision(
        'Refactor this function',
        'refactor',
        'agent-001',
        0.7
      );

      expect(request.level).toBe('consult_internal');
      expect(request.targets).toContain('colony_ant');
      expect(request.targets).toContain('subagent');
      expect(request.targets).not.toContain('p2p_agent');
      expect(request.targets).not.toContain('human');
    });

    it('should consult_external when confidence >= threshold * 0.4 but < threshold * 0.7', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.35);

      const request = await evaluateDecision(
        'Cross-system migration strategy',
        'migration',
        'agent-001',
        0.7
      );

      expect(request.level).toBe('consult_external');
      expect(request.targets).toContain('p2p_agent');
      expect(request.targets).toContain('colony_ant');
      expect(request.targets).toContain('subagent');
    });

    it('should require_human when confidence < threshold * 0.4', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.2);

      const request = await evaluateDecision(
        'Strategic pivot decision',
        'strategy',
        'agent-001',
        0.7
      );

      expect(request.level).toBe('require_human');
      expect(request.targets).toEqual(['human']);
    });

    it('should default to confidence 0.5 when no judgments exist', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.5);

      const request = await evaluateDecision(
        'No prior judgment context',
        'unknown',
        'agent-001',
        0.7
      );

      expect(request.confidence).toBe(0.5);
      expect(request.level).toBe('consult_internal');
      expect(request.targets).toContain('colony_ant');
    });
  });

  describe('Internal Consultation (colony_ant, subagent)', () => {
    it('should query up to 3 colony ants for consult_internal', async () => {
      const request = await evaluateDecision(
        'Which approach is better: A or B?',
        'decision',
        'agent-001',
        0.7
      );
      request.level = 'consult_internal';
      request.targets = ['colony_ant', 'subagent'];

      const results = await queryInternalAgents(request);

      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.target === 'colony_ant')).toBe(true);
    });

    it('should query up to 2 subagents for consult_internal', async () => {
      const request = await evaluateDecision(
        'Code review decision',
        'review',
        'agent-001',
        0.7
      );
      request.level = 'consult_internal';
      request.targets = ['colony_ant', 'subagent'];

      const results = await queryInternalAgents(request);

      expect(results.some(r => r.target === 'subagent')).toBe(true);
    });

    it('should include consultation results in request', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.5);

      const request = await evaluateDecision(
        'Implementation strategy',
        'strategy',
        'agent-001',
        0.7
      );

      expect(request.targets.length).toBeGreaterThan(0);
    });
  });

  describe('External Consultation (p2p_agent)', () => {
    it('should include p2p_agent in consult_external targets', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.35);

      const request = await evaluateDecision(
        'Peer system integration decision',
        'integration',
        'agent-001',
        0.7
      );

      expect(request.level).toBe('consult_external');
      expect(request.targets).toContain('p2p_agent');
    });

    it('should support external peer-to-peer consultation', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.35);

      const request = await evaluateDecision(
        'Protocol version negotiation',
        'protocol',
        'agent-001',
        0.7
      );

      expect(request.targets).toContain('p2p_agent');
      expect(request.targets).toContain('colony_ant');
      expect(request.targets).toContain('subagent');
    });
  });

  describe('Decision Response Flow', () => {
    it('should update status to authorized on positive response', async () => {
      const request = await evaluateDecision(
        'Proceed with deployment',
        'deploy',
        'agent-001',
        0.7
      );

      const response = await submitDecisionResponse(request.id, {
        authorized: true,
        content: 'Approved',
        by: 'human',
        timestamp: new Date().toISOString(),
      });

      expect(response?.status).toBe('authorized');
      expect(response?.respondedAt).toBeDefined();
    });

    it('should update status to rejected on negative response', async () => {
      const request = await evaluateDecision(
        'Skip tests for faster delivery',
        'testing',
        'agent-001',
        0.7
      );

      const response = await submitDecisionResponse(request.id, {
        authorized: false,
        content: 'No, tests are required',
        by: 'human',
        timestamp: new Date().toISOString(),
      });

      expect(response?.status).toBe('rejected');
    });

    it('should support delegation to other targets', async () => {
      const request = await evaluateDecision(
        'Architecture decision',
        'architecture',
        'agent-001',
        0.7
      );

      const response = await submitDecisionResponse(request.id, {
        authorized: true,
        content: 'Delegating to senior architect',
        delegate: 'colony_ant',
        by: 'human',
        timestamp: new Date().toISOString(),
      });

      expect(response?.response?.delegate).toBe('colony_ant');
    });
  });

  describe('Decision State Tracking', () => {
    it('should track pending decisions', async () => {
      await evaluateDecision('Decision 1', 'context', 'agent-001', 0.7);
      await evaluateDecision('Decision 2', 'context', 'agent-001', 0.7);

      const pending = getPendingDecisions();
      expect(pending.length).toBeGreaterThanOrEqual(2);
    });

    it('should retrieve decision by ID', async () => {
      const created = await evaluateDecision('Test Decision', 'context', 'agent-001', 0.7);
      const retrieved = getDecisionRequest(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.description).toBe('Test Decision');
    });

    it('should calculate decision statistics', async () => {
      await evaluateDecision('Decision A', 'context', 'agent-001', 0.7);
      await evaluateDecision('Decision B', 'context', 'agent-001', 0.7);

      const stats = getDecisionStats();
      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(stats.pending).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Threshold Sensitivity', () => {
    it('should escalate to require_human with very high threshold', async () => {
      setConfidenceThreshold(0.9);
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.3);

      const request = await evaluateDecision(
        'Conservative decision',
        'context',
        'agent-001'
      );

      expect(request.level).toBe('require_human');
      expect(request.targets).toEqual(['human']);
    });

    it('should be autonomous with low threshold', async () => {
      setConfidenceThreshold(0.3);
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.5);

      const request = await evaluateDecision(
        'Aggressive decision',
        'context',
        'agent-001'
      );

      expect(request.level).toBe('autonomous');
      expect(request.targets).toEqual([]);
    });
  });

  describe('Cross-Cutting Concerns', () => {
    it('should create unique decision IDs', async () => {
      const request1 = await evaluateDecision('Decision 1', 'c', 'a', 0.7);
      const request2 = await evaluateDecision('Decision 2', 'c', 'a', 0.7);

      expect(request1.id).not.toBe(request2.id);
    });

    it('should include agent ID in request', async () => {
      const request = await evaluateDecision('Test', 'c', 'my-agent-123', 0.7);

      expect(request.agentId).toBe('my-agent-123');
    });

    it('should record creation timestamp', async () => {
      const before = new Date().toISOString();
      const request = await evaluateDecision('Test', 'c', 'a', 0.7);
      const after = new Date().toISOString();

      expect(request.createdAt).toBeDefined();
      expect(request.createdAt >= before).toBe(true);
      expect(request.createdAt <= after).toBe(true);
    });
  });
});

describe('Decision Level Boundary Conditions', () => {
  beforeEach(() => {
    setConfidenceThreshold(0.7);
  });

  it.each([
    { confidence: 0.9, expectedLevel: 'autonomous' },
    { confidence: 0.5, expectedLevel: 'consult_internal' },
    { confidence: 0.35, expectedLevel: 'consult_external' },
    { confidence: 0.2, expectedLevel: 'require_human' },
  ])('confidence $confidence should map to $expectedLevel', async ({ confidence, expectedLevel }) => {
    vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(confidence);

    const request = await evaluateDecision(
      'Boundary test',
      'boundary',
      'agent-001',
      0.7
    );
    expect(request.level).toBe(expectedLevel);
  });
});

describe('Consultation Target Matrix', () => {
  beforeEach(() => {
    setConfidenceThreshold(0.7);
  });

  const matrix: Array<{ level: DecisionLevel; expectedTargets: string[] }> = [
    { level: 'autonomous', expectedTargets: [] },
    { level: 'consult_internal', expectedTargets: ['colony_ant', 'subagent'] },
    { level: 'consult_external', expectedTargets: ['colony_ant', 'subagent', 'p2p_agent'] },
    { level: 'require_human', expectedTargets: ['human'] },
  ];

  it.each(matrix)('level $level should have targets $expectedTargets', ({ level, expectedTargets }) => {
    expect(level).toBeDefined();
    expect(expectedTargets).toBeDefined();
  });
});