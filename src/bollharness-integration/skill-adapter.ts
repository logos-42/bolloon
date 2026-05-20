/**
 * Skill Adapter - Bridge between Bollharness skills and Bolloon's SkillRegistry
 * 
 * Loads skills from src/bollharness/.claude/skills/ and adapts them for Bolloon.
 * 
 * Skill structure (from bollharness):
 * - arch: Project architect (architecture decisions, boundary freezing)
 * - lead: Development workflow commander (fail-closed state machine)
 * - task-arch: Task decomposition
 * - harness-eng: Engineering execution
 * - harness-dev: Development execution
 * - harness-eng-test: Engineering testing
 * - harness-ops: Operations and truth maintenance
 * - harness-bridge: Bridge agent coordination
 * - crystal-learn: Failure pattern extraction
 * - bug-triage: Bug classification
 * - bug-pipeline: Bug fix pipeline
 * - guardian-fixer: Issue-to-fix workflow
 * - plan-lock: Plan freezing
 * - skill-discovery: Skill discovery and recommendation
 * - toolkit: Toolkit management
 */

import { SkillRegistry, Skill } from '@bolloon/constraint-runtime';
import * as fs from 'fs';
import * as path from 'path';

export const BOLLHARNESS_SKILLS_DIR = path.join('src', 'bollharness', '.claude', 'skills');

export interface HarnessSkillMetadata {
  name: string;
  description: string;
  status: 'active' | 'deprecated' | 'experimental';
  tier: 'entry' | 'intermediate' | 'advanced' | 'meta' | 'execution';
  owner?: string;
  last_audited?: string;
  triggers?: string[];
  outputs?: string[];
  truth_policy?: string[];
}

function parseYamlFrontmatter(content: string): { metadata: HarnessSkillMetadata; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { metadata: { name: '', description: '', status: 'active', tier: 'entry' }, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const metadata: Record<string, unknown> = {};

  for (const line of yamlStr.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(Number(value)) && value !== '') value = Number(value);
    metadata[key] = value;
  }

  return {
    metadata: metadata as unknown as HarnessSkillMetadata,
    body,
  };
}

function loadHarnessSkill(skillPath: string): HarnessSkillMetadata | null {
  try {
    const skillDir = path.dirname(skillPath);
    const skillName = path.basename(skillDir);
    const content = fs.readFileSync(skillPath, 'utf-8');
    const { metadata } = parseYamlFrontmatter(content);
    metadata.name = skillName;
    return metadata;
  } catch {
    return null;
  }
}

function loadAllHarnessSkills(): HarnessSkillMetadata[] {
  const skills: HarnessSkillMetadata[] = [];

  if (!fs.existsSync(BOLLHARNESS_SKILLS_DIR)) {
    console.warn(`[SkillAdapter] Bollharness skills dir not found: ${BOLLHARNESS_SKILLS_DIR}`);
    return skills;
  }

  const entries = fs.readdirSync(BOLLHARNESS_SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(BOLLHARNESS_SKILLS_DIR, entry.name, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const metadata = loadHarnessSkill(skillPath);
      if (metadata) {
        skills.push(metadata);
      }
    }
  }

  return skills;
}

export interface SkillTriggers {
  keywords: string[];
  patterns: RegExp[];
  contexts: string[];
}

export interface AdaptedSkill {
  name: string;
  description: string;
  triggers: SkillTriggers;
  execute: (params: Record<string, unknown>) => Promise<string>;
  getGatePack?: () => Record<string, unknown>;
}

export interface SkillMetadata {
  name: string;
  tier: 'entry' | 'intermediate' | 'advanced';
  status: 'active' | 'deprecated' | 'experimental';
  owner?: string;
  last_audited?: string;
}

/**
 * Base skill class for bollharness-compatible skills
 */
export abstract class BaseSkill implements Skill {
  abstract name: string;
  abstract description: string;

  abstract execute(params: Record<string, unknown>): Promise<string>;

  protected log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [${this.name}] ${message}`);
  }

  protected formatOutput(output: Record<string, unknown>): string {
    return JSON.stringify(output, null, 2);
  }
}

/**
 * Architecture Skill - Project architect for architecture decisions
 */
export class ArchSkill extends BaseSkill {
  name = 'arch';
  description = 'Project architect. Responsible for architecture decisions, scheme comparison, and boundary freezing.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = params.task as string || params.description as string;
    
    this.log('Analyzing architecture task');

    // Extract essence
    const essence = this.extractEssence(task);
    
    // Find tensions
    const tensions = this.identifyTensions(task);
    
    // Compare alternatives
    const alternatives = this.compareAlternatives(task);
    
    // Identify boundaries to freeze
    const boundaries = this.identifyBoundaries(task);

    return this.formatOutput({
      essence,
      tensions,
      alternatives,
      boundaries,
      recommendation: this.makeRecommendation(task, alternatives),
    });
  }

  private extractEssence(task: string): string {
    // Simplified essence extraction
    return `The core challenge is: ${task}`;
  }

  private identifyTensions(task: string): string[] {
    return [
      'Simplicity vs Flexibility',
      'Performance vs Maintainability',
      'Coupling vs Cohesion',
    ];
  }

  private compareAlternatives(task: string): Array<{name: string; tradeoffs: string[]; recommendation: string}> {
    return [
      {
        name: 'Option A: Direct Implementation',
        tradeoffs: ['Fast to implement', 'May not scale'],
        recommendation: 'Suitable for MVP',
      },
      {
        name: 'Option B: Abstraction Layer',
        tradeoffs: ['More upfront work', 'Better for extension'],
        recommendation: 'Suitable for long-term',
      },
    ];
  }

  private identifyBoundaries(task: string): string[] {
    return [
      'API contract boundaries',
      'Data format boundaries',
      'Capability boundaries',
    ];
  }

  private makeRecommendation(task: string, alternatives: Array<{name: string; recommendation: string}>): string {
    return alternatives[1]?.recommendation || 'Consider abstraction layer for long-term maintainability';
  }
}

/**
 * Lead Skill - Development workflow commander (fail-closed state machine)
 */
export class LeadSkill extends BaseSkill {
  name = 'lead';
  description = 'Development workflow commander. Fail-closed state machine from idea to production code.';

  private currentGate = 0;

  async execute(params: Record<string, unknown>): Promise<string> {
    const action = params.action as string;
    
    this.log('Processing lead action');

    switch (action) {
      case 'get_gate':
        return this.getGatePack();
      case 'transition':
        return this.handleTransition(params);
      case 'classify':
        return this.classifyChange(params);
      default:
        return this.getGatePack();
    }
  }

  getGatePack(): string {
    const gates = [
      { gate: 0, name: 'Problem Lock', required: 'Problem statement + Change Classification' },
      { gate: 1, name: 'Architecture Design', required: 'ADR draft + Consumer list' },
      { gate: 2, name: 'Architecture Review', required: 'Review report (PASS/BLOCK)' },
      { gate: 3, name: 'Plan', required: 'PLAN document + Coverage matrix' },
      { gate: 4, name: 'Plan Review', required: 'Review report + plan-lock' },
      { gate: 5, name: 'Task Architecture', required: 'WP split + TASK.md' },
      { gate: 6, name: 'Task Review', required: 'Review report (PASS/BLOCK)' },
      { gate: 7, name: 'Execution', required: 'Code + LOG.md' },
      { gate: 8, name: 'Final Review', required: 'Review report + Acceptance' },
    ];

    const current = gates[this.currentGate];

    return this.formatOutput({
      current_gate: this.currentGate,
      gate_name: current.name,
      entry_satisfied: true,
      blockers: [],
      required_artifact: current.required,
      required_next_skill: 'arch',
      available_actions: ['get_gate', 'transition', 'classify'],
    });
  }

  private handleTransition(params: Record<string, unknown>): string {
    const reviewResult = params.reviewResult as { verdict: string } | undefined;
    
    // Check if review gate needs PASS
    if (this.currentGate === 2 || this.currentGate === 4 || this.currentGate === 6 || this.currentGate === 8) {
      if (!reviewResult || reviewResult.verdict !== 'PASS') {
        return this.formatOutput({
          transition: 'BLOCKED',
          reason: 'Review gate requires PASS verdict from independent reviewer',
          current_gate: this.currentGate,
        });
      }
    }

    this.currentGate = Math.min(8, this.currentGate + 1);
    
    return this.formatOutput({
      transition: 'SUCCESS',
      from_gate: this.currentGate - 1,
      to_gate: this.currentGate,
      gate_pack: this.getGatePack(),
    });
  }

  private classifyChange(params: Record<string, unknown>): string {
    const description = params.description as string || '';
    
    // Simplified classification
    const isPolicy = description.includes('policy') || description.includes('boundary');
    const isContract = description.includes('API') || description.includes('contract') || description.includes('schema');
    const isImplementation = !isPolicy && !isContract;

    return this.formatOutput({
      classification: isPolicy ? 'policy' : isContract ? 'contract' : 'implementation',
      description,
      minimum_gate_path: isPolicy ? '0→8 (full)' : isContract ? '0→8 (full + consumers)' : '0→7 (fast track eligible)',
      fast_track_eligible: isImplementation,
    });
  }
}

/**
 * Task Architecture Skill - Task decomposition
 */
export class TaskArchSkill extends BaseSkill {
  name = 'task-arch';
  description = 'Task decomposition. Breaks down PLAN into parallelizable work packages (WP).';

  async execute(params: Record<string, unknown>): Promise<string> {
    const plan = params.plan as string;
    
    this.log('Decomposing plan into work packages');

    // Extract work packages
    const workPackages = this.extractWorkPackages(plan);
    
    // Identify seams
    const seams = this.identifySeams(workPackages);
    
    // Identify integration points
    const integration = this.identifyIntegration(workPackages);

    return this.formatOutput({
      work_packages: workPackages,
      seams,
      integration,
      seam_owners: this.assignSeamOwners(seams),
    });
  }

  private extractWorkPackages(plan: string): Array<{id: string; description: string; files: string[]}> {
    // Simplified WP extraction
    return [
      { id: 'WP-1', description: 'Core implementation', files: ['src/agents/*.ts'] },
      { id: 'WP-2', description: 'Network layer', files: ['src/network/*.ts'] },
      { id: 'WP-3', description: 'Testing', files: ['src/test/*.ts'] },
    ];
  }

  private identifySeams(packages: Array<{id: string}>): Array<{from: string; to: string; interface: string}> {
    return [
      { from: 'WP-1', to: 'WP-2', interface: 'P2PNetwork interface' },
      { from: 'WP-1', to: 'WP-3', interface: 'Test fixtures' },
    ];
  }

  private identifyIntegration(packages: Array<{id: string}>): string[] {
    return ['Integration test at WP-1/WP-2 boundary'];
  }

  private assignSeamOwners(seams: Array<{from: string; to: string}>): Record<string, string> {
    const owners: Record<string, string> = {};
    for (const seam of seams) {
      owners[`${seam.from}/${seam.to}`] = 'integration-owner';
    }
    return owners;
  }
}

/**
 * Harness Engineering Skill - Engineering execution
 */
export class HarnessEngSkill extends BaseSkill {
  name = 'harness-eng';
  description = 'Engineering execution. Implements code according to PLAN.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const workPackage = params.workPackage as string;
    const plan = params.plan as string;
    
    this.log(`Executing work package: ${workPackage}`);

    // Verify prerequisites
    const prereqs = this.checkPrerequisites(workPackage);
    
    // Execute implementation
    const steps = this.planImplementation(workPackage, plan);
    
    // Log execution
    const log = this.createExecutionLog(steps);

    return this.formatOutput({
      work_package: workPackage,
      prerequisites: prereqs,
      steps,
      log,
      status: prereqs.met ? 'ready' : 'blocked',
    });
  }

  private checkPrerequisites(workPackage: string): { met: boolean; missing: string[] } {
    // Simplified check
    return { met: true, missing: [] };
  }

  private planImplementation(workPackage: string, plan: string): string[] {
    return [
      'Step 1: Implement core logic',
      'Step 2: Add error handling',
      'Step 3: Write unit tests',
      'Step 4: Update documentation',
    ];
  }

  private createExecutionLog(steps: string[]): string {
    return `# Execution Log\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  }
}

/**
 * Harness Engineering Test Skill - Test strategy and execution
 * Ported from src/bollharness/.claude/skills/harness-eng-test/SKILL.md
 */
export class HarnessEngTestSkill extends BaseSkill {
  name = 'harness-eng-test';
  description = 'Testing engineering specialist. Test strategy, test case design, test execution and quality verification. Scheduled by lead at Gate 8.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const action = params.action as string;
    const plan = params.plan as string;
    const frozen = params.frozen as boolean;

    this.log('Executing test engineering');

    if (action === 'strategy') {
      return this.createTestStrategy(plan);
    }

    if (action === 'cases') {
      return this.createTestCases(plan);
    }

    if (action === 'execute') {
      return this.executeTests();
    }

    return this.formatOutput({
      skill: this.name,
      description: this.description,
      available_actions: ['strategy', 'cases', 'execute'],
      gate_8_only: true,
      truth_policy: [
        'Tests must be independent from implementation',
        'Test coverage does not equal test quality',
        'Report test results honestly',
      ],
    });
  }

  private createTestStrategy(plan: string): string {
    const layers = [
      { layer: 'Unit tests', target: 'Fast feedback', tool: 'vitest' },
      { layer: 'Integration tests', target: 'Module interfaces', tool: 'supertest' },
      { layer: 'E2E tests', target: 'User journeys', tool: 'playwright' },
    ];

    return this.formatOutput({
      test_strategy: layers,
      coverage_target: plan.includes('API') ? 'contract-focused' : 'function-focused',
      fast_track_eligible: false,
    });
  }

  private createTestCases(plan: string): string {
    return this.formatOutput({
      test_cases: [
        { id: 'TC-1', description: 'Core functionality', priority: 'P0' },
        { id: 'TC-2', description: 'Edge cases', priority: 'P1' },
        { id: 'TC-3', description: 'Error handling', priority: 'P1' },
      ],
      requirements: plan,
    });
  }

  private executeTests(): string {
    return this.formatOutput({
      execution_report: {
        status: 'NOT_EXECUTED',
        message: 'Test execution requires bollharness environment',
      },
      truth_policy: [
        '"collect passed" ≠ "tests passed"',
        'Failure is failure, do not downgrade',
        'BLOCKED must be explicitly marked',
      ],
    });
  }
}

/**
 * Crystal Learn Skill - Failure pattern extraction
 */
export class CrystalLearnSkill extends BaseSkill {
  name = 'crystal-learn';
  description = 'Extracts failure patterns and maintains invariants.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = params.task as string;
    
    this.log('Extracting failure patterns');

    // Identify failure modes
    const failures = this.identifyFailures(task);
    
    // Extract patterns
    const patterns = this.extractPatterns(failures);
    
    // Generate invariants
    const invariants = this.generateInvariants(patterns);

    return this.formatOutput({
      failure_modes: failures,
      patterns,
      invariants,
    });
  }

  private identifyFailures(task: string): string[] {
    return [
      'Truth source split',
      'Verification decay',
      'Orphaned seams',
    ];
  }

  private extractPatterns(failures: string[]): Array<{pattern: string; prevention: string}> {
    return failures.map(f => ({
      pattern: f,
      prevention: `Implement guard to prevent ${f}`,
    }));
  }

  private generateInvariants(patterns: Array<{pattern: string}>): string[] {
    return patterns.map(p => `INV: ${p.pattern} must not occur`);
  }
}

/**
 * Skill Adapter - Registers all bollharness skills with Bolloon's SkillRegistry
 */
export class SkillAdapter {
  private registry: SkillRegistry;
  private harnessSkills: HarnessSkillMetadata[] = [];

  constructor() {
    this.registry = new SkillRegistry();
    this.registerSkills();
  }

  private registerSkills(): void {
    // Load harness skills from src/bollharness/.claude/skills/
    this.harnessSkills = loadAllHarnessSkills();
    this.log(`Loaded ${this.harnessSkills.length} skills from bollharness`);

    // Register adapted skills for skills not yet fully adapted
    const adaptedSkills: Skill[] = [
      new ArchSkill(),
      new LeadSkill(),
      new TaskArchSkill(),
      new HarnessEngSkill(),
      new HarnessEngTestSkill(),
      new CrystalLearnSkill(),
    ];

    for (const skill of adaptedSkills) {
      try {
        this.registry.register(skill);
        this.log(`Registered adapted skill: ${skill.name}`);
      } catch (error) {
        this.log(`Failed to register ${skill.name}: ${error}`, 'error');
      }
    }

    // Register harness-native skills (metadata only, execution delegated)
    for (const harnessMeta of this.harnessSkills) {
      const adaptedNames = adaptedSkills.map(s => s.name);
      if (!adaptedNames.includes(harnessMeta.name)) {
        try {
          const proxySkill = createHarnessProxySkill(harnessMeta);
          this.registry.register(proxySkill);
          this.log(`Registered harness proxy skill: ${harnessMeta.name}`);
        } catch (error) {
          this.log(`Failed to register harness skill ${harnessMeta.name}: ${error}`, 'error');
        }
      }
    }
  }

  getRegistry(): SkillRegistry {
    return this.registry;
  }

  getSkill(name: string): Skill | undefined {
    return this.registry.get(name);
  }

  listSkills(): Skill[] {
    return this.registry.list();
  }

  listHarnessSkills(): HarnessSkillMetadata[] {
    return this.harnessSkills;
  }

  async executeSkill(name: string, params: Record<string, unknown>): Promise<string> {
    return this.registry.execute(name, params);
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [SkillAdapter] ${message}`);
  }
}

function createHarnessProxySkill(meta: HarnessSkillMetadata): Skill {
  return {
    name: meta.name,
    description: meta.description,
    async execute(params: Record<string, unknown>): Promise<string> {
      return JSON.stringify({
        skill: meta.name,
        description: meta.description,
        tier: meta.tier,
        status: meta.status,
        outputs: meta.outputs || [],
        message: `Harness skill '${meta.name}' requires bollharness environment for full execution`,
        params_received: params,
      }, null, 2);
    },
  };
}

export const createSkillAdapter = (): SkillAdapter => {
  return new SkillAdapter();
};
