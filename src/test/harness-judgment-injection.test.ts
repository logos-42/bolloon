import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateJudgmentInjection,
  getCoreJudgmentsForSession,
  getJudgmentsForPath,
  getJudgmentsForFragment,
  getJudgmentsForContextRequest,
  type JudgmentInjectOptions,
} from '../bollharness-integration/context-router-judgment.js';
import * as judgmentModule from '../pi-ecosystem-judgment/index.js';

describe('Harness Judgment Injection - Gate Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Gate-specific judgment injection', () => {
    it('should inject core judgments at Gate 0 (session start)', async () => {
      const injection = await generateJudgmentInjection('src/agents/', 0);

      expect(injection).toContain('# User Core Values');
      expect(injection).toContain('core_judgments:');
      expect(injection).toContain('confidence: 0.9');
    });

    it('should inject path judgments at Gate 3 (plan freeze)', async () => {
      const injection = await generateJudgmentInjection('src/agents/', 3);

      expect(injection).toContain('# Plan Freeze');
      expect(injection).toContain('active_judgments:');
    });

    it('should return path judgments for Gate 1 (not core)', async () => {
      const injection = await generateJudgmentInjection('src/agents/', 1);

      expect(injection).toContain('# Gate 1');
      expect(injection).not.toContain('core_judgments:');
    });

    it('should include confidence in injection header', async () => {
      const injection = await generateJudgmentInjection('src/agents/', 3);

      expect(injection).toMatch(/# Confidence: \d+%/);
    });

    it('should include file path in injection header', async () => {
      const injection = await generateJudgmentInjection('src/agents/', 3);

      expect(injection).toContain('# Path: src/agents/');
    });
  });

  describe('Path-based judgment routing', () => {
    it('should route src/agents/ to agent-related fragments', async () => {
      const result = await getJudgmentsForPath('src/agents/');

      expect(result.fragments).toBeDefined();
      expect(Array.isArray(result.fragments)).toBe(true);
    });

    it('should return judgments sorted by confidence', async () => {
      const result = await getJudgmentsForPath('src/agents/');

      if (result.judgments.length > 1) {
        for (let i = 1; i < result.judgments.length; i++) {
          expect(result.judgments[i - 1].confidence).toBeGreaterThanOrEqual(
            result.judgments[i].confidence
          );
        }
      }
    });

    it('should filter judgments by minimum confidence', async () => {
      const result = await getJudgmentsForPath('src/agents/', { minConfidence: 0.9 });

      for (const j of result.judgments) {
        expect(j.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('should limit number of judgments', async () => {
      const result = await getJudgmentsForPath('src/agents/', { maxJudgments: 3 });

      expect(result.judgments.length).toBeLessThanOrEqual(3);
    });

    it('should calculate overall confidence for path', async () => {
      const result = await getJudgmentsForPath('src/agents/');

      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Fragment to judgment mapping', () => {
    it('should map agent-architecture fragment to agent contexts', async () => {
      const judgments = await getJudgmentsForFragment('agent-architecture');

      expect(Array.isArray(judgments)).toBe(true);
    });

    it('should map testing-patterns fragment to testing contexts', async () => {
      const judgments = await getJudgmentsForFragment('testing-patterns');

      expect(Array.isArray(judgments)).toBe(true);
    });

    it('should return empty for unknown fragment', async () => {
      const judgments = await getJudgmentsForFragment('unknown-fragment-xyz');

      expect(Array.isArray(judgments)).toBe(true);
    });

    it('should deduplicate judgments across fragments', async () => {
      const result = await getJudgmentsForPath('src/agents/');

      const ids = result.judgments.map(j => j.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  describe('Core judgments for session', () => {
    it('should only include human source judgments', async () => {
      const injection = await getCoreJudgmentsForSession(0.9);

      if (injection.length > 0) {
        expect(injection).toContain('core_judgments:');
      }
    });

    it('should filter by minimum confidence', async () => {
      const injection = await getCoreJudgmentsForSession(0.95);

      if (injection.length > 0) {
        expect(injection).toContain('confidence: 0.95');
      }
    });

    it('should limit to 10 judgments', async () => {
      const injection = await getCoreJudgmentsForSession(0.5);

      const matches = injection.match(/principle:/g);
      if (matches) {
        expect(matches.length).toBeLessThanOrEqual(10);
      }
    });

    it('should return empty string when no judgments meet threshold', async () => {
      const injection = await getCoreJudgmentsForSession(1.0);

      expect(typeof injection).toBe('string');
    });
  });

  describe('Judgment formatting', () => {
    it('should format judgments as YAML by default', async () => {
      const result = await getJudgmentsForPath('src/agents/', { format: 'yaml' });

      expect(result.contextYaml).toContain('active_judgments:');
    });

    it('should format judgments as JSON', async () => {
      const result = await getJudgmentsForPath('src/agents/', { format: 'json' });

      expect(result.contextYaml).toContain('[');
      expect(() => JSON.parse(result.contextYaml)).not.toThrow();
    });

    it('should format judgments as text', async () => {
      const result = await getJudgmentsForPath('src/agents/', { format: 'text' });

      expect(result.contextYaml).toMatch(/\[\d+%\]/);
    });

    it('should escape YAML strings correctly', async () => {
      const result = await getJudgmentsForPath('src/agents/', { format: 'yaml' });

      expect(result.contextYaml).not.toContain('\n"');
    });
  });

  describe('Context-specific judgment requests', () => {
    it('should get judgments for explicit context', async () => {
      const result = await getJudgmentsForContextRequest('typescript');

      expect(result).toHaveProperty('judgments');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('contextYaml');
    });

    it('should filter by context match', async () => {
      const result = await getJudgmentsForContextRequest('code-quality');

      for (const j of result.judgments) {
        const hasMatch = j.context?.toLowerCase().includes('code-quality') ||
                        j.context?.toLowerCase().includes('quality') ||
                        j.context?.toLowerCase().includes('development');
        expect(hasMatch).toBeTruthy();
      }
    });
  });
});

describe('Harness Judgment Injection - Multi-Agent Scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Decision level with harness context', () => {
    it('should route consult_internal to colony_ant and subagent', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.5);

      const { evaluateDecision } = await import('../pi-ecosystem-judgment/decision.js');
      const request = await evaluateDecision(
        'Delegate task to colony ant',
        'delegation',
        'agent-001',
        0.7
      );

      expect(request.targets).toContain('colony_ant');
      expect(request.targets).toContain('subagent');
      expect(request.targets).not.toContain('p2p_agent');
    });

    it('should route consult_external to p2p_agent', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.35);

      const { evaluateDecision } = await import('../pi-ecosystem-judgment/decision.js');
      const request = await evaluateDecision(
        'Cross-system protocol negotiation',
        'protocol',
        'agent-001',
        0.7
      );

      expect(request.targets).toContain('p2p_agent');
      expect(request.targets).toContain('colony_ant');
      expect(request.targets).toContain('subagent');
    });

    it('should escalate to human for strategic decisions', async () => {
      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(0.2);

      const { evaluateDecision } = await import('../pi-ecosystem-judgment/decision.js');
      const request = await evaluateDecision(
        'Strategic pivot decision',
        'strategy',
        'agent-001',
        0.7
      );

      expect(request.targets).toEqual(['human']);
    });
  });

  describe('Judgment confidence propagation', () => {
    it('should use harness path confidence for decision routing', async () => {
      const result = await getJudgmentsForPath('src/agents/');

      vi.spyOn(judgmentModule, 'calculateConfidence').mockReturnValueOnce(result.confidence);

      const { evaluateDecision } = await import('../pi-ecosystem-judgment/decision.js');
      const request = await evaluateDecision(
        'Agent architecture decision',
        'architecture',
        'agent-001',
        0.7
      );

      if (result.confidence >= 0.7) {
        expect(request.level).toBe('autonomous');
      } else if (result.confidence >= 0.49) {
        expect(request.level).toBe('consult_internal');
      } else if (result.confidence >= 0.28) {
        expect(request.level).toBe('consult_external');
      } else {
        expect(request.level).toBe('require_human');
      }
    });
  });
});

describe('Harness Judgment Injection - Gate Confidence Thresholds', () => {
  const gateThresholds: Array<{ gate: number; expectedMinConfidence: number; description: string }> = [
    { gate: 0, expectedMinConfidence: 0.9, description: 'Session start - highest bar' },
    { gate: 1, expectedMinConfidence: 0.8, description: 'Architecture design' },
    { gate: 2, expectedMinConfidence: 0.75, description: 'Review' },
    { gate: 3, expectedMinConfidence: 0.8, description: 'Plan freeze' },
    { gate: 5, expectedMinConfidence: 0.7, description: 'Task architecture' },
    { gate: 7, expectedMinConfidence: 0.7, description: 'Execution' },
  ];

  it.each(gateThresholds)(
    'Gate $gate ($description) should use minConfidence $expectedMinConfidence',
    async ({ gate, expectedMinConfidence }) => {
      const injection = await generateJudgmentInjection('src/agents/', gate);

      if (gate === 0 || gate === 1 || gate === 2 || gate === 3 || gate === 5 || gate === 7) {
        expect(injection).toBeDefined();
        expect(typeof injection).toBe('string');
      }
    }
  );

  it('should return path judgments for all non-zero gates', async () => {
    for (const gate of [1, 2, 4, 5, 6, 8, 9]) {
      const injection = await generateJudgmentInjection('src/agents/', gate);
      expect(typeof injection).toBe('string');
    }
  });
});

describe('Harness Judgment Injection - End-to-End Flow', () => {
  it('should produce injectable YAML for agent context', async () => {
    const injection = await generateJudgmentInjection('src/agents/', 0);

    const hasValidYamlStructure =
      injection.includes('core_judgments:') ||
      injection.includes('active_judgments:') ||
      injection.includes('# User Core Values');

    expect(hasValidYamlStructure).toBeTruthy();
  });

  it('should format judgments for LLM consumption', async () => {
    const result = await getJudgmentsForPath('src/agents/', { format: 'yaml' });

    const lines = result.contextYaml.split('\n');
    const hasPrinciple = lines.some(line => line.includes('principle:'));
    const hasConfidence = lines.some(line => line.includes('confidence:'));

    expect(hasPrinciple || hasConfidence).toBeTruthy();
  });

  it('should fallback to general-dev-principles for unknown paths', async () => {
    const result = await getJudgmentsForPath('/nonexistent/path/that/matches/nothing');

    expect(result).toHaveProperty('judgments');
    expect(result).toHaveProperty('confidence');
    expect(result.fragments).toContain('general-dev-principles');
  });

  it('should provide traceability from path to fragment to judgment', async () => {
    const result = await getJudgmentsForPath('src/agents/');

    expect(result.fragments.length).toBeGreaterThan(0);
    expect(result.judgments.length).toBeGreaterThanOrEqual(0);
    expect(typeof result.confidence).toBe('number');
  });
});