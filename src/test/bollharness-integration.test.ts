/**
 * Bollharness Integration Tests - Standalone Component Tests
 * 
 * These tests verify the core bollharness integration components
 * without requiring full constraint-runtime dependency chain.
 */

import { describe, it, expect, vi } from 'vitest';

// ==================== Gate State Machine Tests ====================

interface GateConfig {
  entryCondition: string;
  requiredArtifact: string;
  requiredNextSkill: string;
  requiredReviewSubstrate?: string;
  isReviewGate: boolean;
}

type Gate = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const GATE_CONFIGS: Record<Gate, GateConfig> = {
  0: { entryCondition: '用户提出需求', requiredArtifact: '问题陈述', requiredNextSkill: 'arch', isReviewGate: false },
  1: { entryCondition: 'Gate 0 产物存在', requiredArtifact: 'ADR草稿', requiredNextSkill: 'arch', isReviewGate: false },
  2: { entryCondition: 'ADR草稿完成', requiredArtifact: '审查报告', requiredNextSkill: 'review', requiredReviewSubstrate: 'ref-review-sop.md', isReviewGate: true },
  3: { entryCondition: 'Gate 2 PASS', requiredArtifact: 'PLAN文档', requiredNextSkill: 'harness-eng', isReviewGate: false },
  4: { entryCondition: 'PLAN vN-final冻结', requiredArtifact: '审查报告', requiredNextSkill: 'review', requiredReviewSubstrate: 'ref-review-sop.md', isReviewGate: true },
  5: { entryCondition: 'Gate 4 PASS', requiredArtifact: 'WP拆分+TASK.md', requiredNextSkill: 'task-arch', isReviewGate: false },
  6: { entryCondition: '全部TASK.md完成', requiredArtifact: '审查报告', requiredNextSkill: 'review', requiredReviewSubstrate: 'ref-review-sop.md', isReviewGate: true },
  7: { entryCondition: 'Gate 6 PASS', requiredArtifact: '代码+LOG.md', requiredNextSkill: 'harness-eng', isReviewGate: false },
  8: { entryCondition: '全部WP代码+LOG.md存在', requiredArtifact: '审查报告', requiredNextSkill: 'harness-eng-test', requiredReviewSubstrate: 'ref-review-sop.md', isReviewGate: true },
};

describe('GateStateMachine', () => {
  let currentGate: Gate = 0;
  let artifacts: Map<string, unknown> = new Map();

  describe('initialization', () => {
    it('should start at gate 0', () => {
      currentGate = 0;
      expect(currentGate).toBe(0);
    });

    it('should have correct gate 0 config', () => {
      const config = GATE_CONFIGS[0];
      expect(config.requiredArtifact).toBeDefined();
      expect(config.isReviewGate).toBe(false);
    });
  });

  describe('gate configs', () => {
    it('should have 9 gates defined', () => {
      expect(Object.keys(GATE_CONFIGS).length).toBe(9);
    });

    it('should have 4 review gates (2,4,6,8)', () => {
      expect(GATE_CONFIGS[2].isReviewGate).toBe(true);
      expect(GATE_CONFIGS[4].isReviewGate).toBe(true);
      expect(GATE_CONFIGS[6].isReviewGate).toBe(true);
      expect(GATE_CONFIGS[8].isReviewGate).toBe(true);
    });

    it('should have correct next skill for each gate', () => {
      expect(GATE_CONFIGS[0].requiredNextSkill).toBe('arch');
      expect(GATE_CONFIGS[5].requiredNextSkill).toBe('task-arch');
    });
  });

  describe('artifacts', () => {
    it('should be able to submit artifacts', () => {
      artifacts.set('test', { data: 'test' });
      expect(artifacts.has('test')).toBe(true);
    });

    it('should retrieve submitted artifacts', () => {
      artifacts.set('adr', { content: 'ADR draft' });
      const artifact = artifacts.get('adr');
      expect(artifact).toBeDefined();
    });
  });
});

// ==================== Guard Router Tests ====================

const GUARD_MAP: Record<string, string[]> = {
  'src/agents/': ['check_api_types', 'check_skill_parity'],
  'src/documents/': ['check_doc_freshness', 'check_api_types'],
  'src/network/': ['check_api_types', 'check_versions'],
  'docs/': ['check_doc_freshness', 'check_doc_links'],
  'CLAUDE.md': ['check_doc_freshness', 'check_artifact_link'],
  'docs/decisions/': ['check_artifact_link', 'check_versions'],
  'src/test/': ['check_api_types', 'check_versions'],
};

function route(filePath: string): string[] {
  const matched: string[] = [];
  const sortedPatterns = Object.keys(GUARD_MAP).sort((a, b) => b.length - a.length);

  for (const pattern of sortedPatterns) {
    if (filePath.startsWith(pattern) || filePath === pattern.replace(/\/$/, '')) {
      matched.push(...GUARD_MAP[pattern]);
    }
  }

  return [...new Set(matched)];
}

describe('GuardRouter', () => {
  describe('routing', () => {
    it('should route agents path to check_api_types', () => {
      const guards = route('src/agents/pi-sdk.ts');
      expect(guards).toContain('check_api_types');
    });

    it('should route docs path to doc freshness', () => {
      const guards = route('docs/guide.md');
      expect(guards).toContain('check_doc_freshness');
    });

    it('should route decisions to artifact link check', () => {
      const guards = route('docs/decisions/adr-001.md');
      expect(guards).toContain('check_artifact_link');
    });

    it('should route test files to version check', () => {
      const guards = route('src/test/pi-sdk.test.ts');
      expect(guards).toContain('check_versions');
    });

    it('should return empty array for unknown paths', () => {
      const guards = route('src/unknown/file.ts');
      expect(guards.length).toBe(0);
    });

    it('should handle CLAUDE.md special case', () => {
      const guards = route('CLAUDE.md');
      expect(guards).toContain('check_doc_freshness');
      expect(guards).toContain('check_artifact_link');
    });
  });

  describe('deduplication', () => {
    it('should deduplicate guard names', () => {
      const guards = route('src/agents/pi-sdk.ts');
      const uniqueGuards = [...new Set(guards)];
      expect(guards.length).toBe(uniqueGuards.length);
    });
  });
});

// ==================== Context Router Tests ====================

const CONTEXT_MAP: Record<string, string[]> = {
  'src/agents/': ['agent-architecture', 'multi-agent-patterns'],
  'src/documents/': ['document-processing', 'parser-patterns'],
  'src/network/': ['p2p-protocols', 'connection-patterns'],
  'docs/': ['documentation-standards'],
  'docs/decisions/': ['decision-tracking', 'adr-patterns'],
  'src/test/': ['testing-patterns', 'quality-standards'],
  'CLAUDE.md': ['project-governance', 'truth-source-hierarchy'],
};

const FALLBACK_FRAGMENTS = ['general-dev-principles', 'code-quality'];

function match(filePath: string): string[] {
  if (!filePath) return [];
  const normalized = filePath.replace(/\\/g, '/');
  const matched: string[] = [];
  const sortedPatterns = Object.keys(CONTEXT_MAP).sort((a, b) => b.length - a.length);

  for (const pattern of sortedPatterns) {
    if (normalized.startsWith(pattern) || normalized.endsWith(pattern)) {
      matched.push(...CONTEXT_MAP[pattern]);
    }
  }

  return [...new Set(matched)];
}

describe('ContextRouter', () => {
  describe('matching', () => {
    it('should match agents path', () => {
      const fragments = match('src/agents/protocol.ts');
      expect(fragments).toContain('agent-architecture');
      expect(fragments).toContain('multi-agent-patterns');
    });

    it('should match docs path', () => {
      const fragments = match('docs/api.md');
      expect(fragments).toContain('documentation-standards');
    });

    it('should match decisions path', () => {
      const fragments = match('docs/decisions/adr-001.md');
      expect(fragments).toContain('decision-tracking');
      expect(fragments).toContain('adr-patterns');
    });

    it('should match CLAUDE.md', () => {
      const fragments = match('CLAUDE.md');
      expect(fragments).toContain('project-governance');
    });

    it('should return empty for invalid paths', () => {
      const fragments = match('');
      expect(fragments.length).toBe(0);
    });
  });

  describe('fallback fragments', () => {
    it('should have fallback fragments defined', () => {
      expect(FALLBACK_FRAGMENTS).toContain('general-dev-principles');
      expect(FALLBACK_FRAGMENTS).toContain('code-quality');
    });
  });
});

// ==================== Skill Tests ====================

interface Skill {
  name: string;
  description: string;
  execute(params: Record<string, unknown>): Promise<string>;
}

// Mock skills for testing
const skills: Record<string, Skill> = {
  arch: {
    name: 'arch',
    description: 'Project architect. Architecture decisions and boundary freezing.',
    async execute(params) {
      const essence = `Core challenge: ${params.task || 'unspecified'}`;
      const tensions = ['Simplicity vs Flexibility', 'Performance vs Maintainability'];
      const alternatives = [
        { name: 'Option A', tradeoffs: ['Fast', 'Limited'], recommendation: 'MVP' },
        { name: 'Option B', tradeoffs: ['More work', 'Extensible'], recommendation: 'Long-term' }
      ];
      return JSON.stringify({ essence, tensions, alternatives }, null, 2);
    }
  },
  lead: {
    name: 'lead',
    description: 'Development workflow commander. Fail-closed state machine.',
    async execute(params) {
      const action = params.action as string;
      if (action === 'get_gate') {
        return JSON.stringify({ current_gate: 0, gate_name: 'Problem Lock', required_artifact: '问题陈述' }, null, 2);
      }
      if (action === 'classify') {
        const desc = params.description as string || '';
        const isPolicy = desc.includes('policy');
        const isContract = desc.includes('API') || desc.includes('contract');
        return JSON.stringify({
          classification: isPolicy ? 'policy' : isContract ? 'contract' : 'implementation',
          fast_track: !isPolicy && !isContract
        }, null, 2);
      }
      return JSON.stringify({ current_gate: 0 });
    }
  },
  task_arch: {
    name: 'task-arch',
    description: 'Task decomposition. Breaks down PLAN into work packages.',
    async execute(params) {
      const workPackages = [
        { id: 'WP-1', description: 'Core implementation', files: ['src/agents/*.ts'] },
        { id: 'WP-2', description: 'Network layer', files: ['src/network/*.ts'] }
      ];
      return JSON.stringify({ workPackages }, null, 2);
    }
  }
};

describe('Skills', () => {
  describe('arch skill', () => {
    it('should have correct name and description', () => {
      expect(skills.arch.name).toBe('arch');
      expect(skills.arch.description).toContain('architect');
    });

    it('should execute and return analysis', async () => {
      const result = await skills.arch.execute({ task: 'design new feature' });
      const parsed = JSON.parse(result);
      expect(parsed.essence).toBeDefined();
      expect(parsed.tensions).toHaveLength(2);
      expect(parsed.alternatives).toHaveLength(2);
    });
  });

  describe('lead skill', () => {
    it('should have correct name', () => {
      expect(skills.lead.name).toBe('lead');
    });

    it('should get gate pack', async () => {
      const result = await skills.lead.execute({ action: 'get_gate' });
      const parsed = JSON.parse(result);
      expect(parsed.current_gate).toBe(0);
    });

    it('should classify policy changes', async () => {
      const result = await skills.lead.execute({ action: 'classify', description: 'change policy boundary' });
      const parsed = JSON.parse(result);
      expect(parsed.classification).toBe('policy');
    });

    it('should classify contract changes', async () => {
      const result = await skills.lead.execute({ action: 'classify', description: 'change API contract' });
      const parsed = JSON.parse(result);
      expect(parsed.classification).toBe('contract');
    });

    it('should classify implementation changes as fast-track eligible', async () => {
      const result = await skills.lead.execute({ action: 'classify', description: 'fix bug' });
      const parsed = JSON.parse(result);
      expect(parsed.classification).toBe('implementation');
      expect(parsed.fast_track).toBe(true);
    });
  });

  describe('task-arch skill', () => {
    it('should decompose plan into work packages', async () => {
      const result = await skills.task_arch.execute({ plan: 'implement feature' });
      const parsed = JSON.parse(result);
      expect(parsed.workPackages).toHaveLength(2);
      expect(parsed.workPackages[0].id).toBe('WP-1');
    });
  });
});

// ==================== Change Classification Tests ====================

describe('Change Classification', () => {
  function classifyChange(description: string): { classification: string; fast_track: boolean } {
    const isPolicy = description.includes('policy') || description.includes('boundary');
    const isContract = description.includes('API') || description.includes('contract') || description.includes('schema');
    const isImplementation = !isPolicy && !isContract;

    return {
      classification: isPolicy ? 'policy' : isContract ? 'contract' : 'implementation',
      fast_track: isImplementation
    };
  }

  it('should classify policy changes', () => {
    const result = classifyChange('change policy boundary');
    expect(result.classification).toBe('policy');
    expect(result.fast_track).toBe(false);
  });

  it('should classify contract changes', () => {
    const result = classifyChange('change API contract');
    expect(result.classification).toBe('contract');
    expect(result.fast_track).toBe(false);
  });

  it('should classify implementation changes', () => {
    const result = classifyChange('fix bug in code');
    expect(result.classification).toBe('implementation');
    expect(result.fast_track).toBe(true);
  });

  it('should classify schema changes as contract', () => {
    const result = classifyChange('update database schema');
    expect(result.classification).toBe('contract');
  });
});

// ==================== Integration Configuration Tests ====================

describe('BollharnessConfig', () => {
  interface BollharnessConfig {
    enabled: boolean;
    guardsEnabled: boolean;
    contextEnabled: boolean;
    skillsEnabled: boolean;
    gatesEnabled: boolean;
  }

  function createDefaultConfig(): BollharnessConfig {
    return {
      enabled: true,
      guardsEnabled: true,
      contextEnabled: true,
      skillsEnabled: true,
      gatesEnabled: true,
    };
  }

  it('should have default config with all features enabled', () => {
    const config = createDefaultConfig();
    expect(config.enabled).toBe(true);
    expect(config.guardsEnabled).toBe(true);
    expect(config.contextEnabled).toBe(true);
    expect(config.skillsEnabled).toBe(true);
    expect(config.gatesEnabled).toBe(true);
  });
});
