/**
 * Bollharness Integration for Bolloon
 * 
 * Main integration class that combines:
 * - Gate State Machine (8-gate workflow governance)
 * - Guard Checker (code quality checks)
 * - Context Router (automatic context injection)
 * - Skill Adapter (bollharness skills in Bolloon)
 */

import { GateStateMachine, type Gate } from './gate-state-machine.js';
import { GuardChecker, runGuards, type GuardResult } from './guard-checker.js';
import { ContextRouter } from './context-router.js';
import { SkillAdapter, createSkillAdapter } from './skill-adapter.js';

export interface BollharnessConfig {
  enabled: boolean;
  guardsEnabled: boolean;
  contextEnabled: boolean;
  skillsEnabled: boolean;
  gatesEnabled: boolean;
}

export interface IntegrationResult {
  success: boolean;
  guards?: GuardResult;
  context?: string[];
  gatePack?: Record<string, unknown>;
  skillResult?: string;
  errors: string[];
}

/**
 * Main integration class
 */
export class BollharnessIntegration {
  private config: BollharnessConfig;
  private gateMachine: GateStateMachine;
  private guardChecker: GuardChecker;
  private contextRouter: ContextRouter;
  private skillAdapter: SkillAdapter;

  constructor(config: Partial<BollharnessConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      guardsEnabled: config.guardsEnabled ?? true,
      contextEnabled: config.contextEnabled ?? true,
      skillsEnabled: config.skillsEnabled ?? true,
      gatesEnabled: config.gatesEnabled ?? true,
    };

    this.gateMachine = new GateStateMachine();
    this.guardChecker = new GuardChecker();
    this.contextRouter = new ContextRouter();
    this.skillAdapter = createSkillAdapter();
  }

  /**
   * Process a file edit with all enabled checks
   */
  async processFileEdit(filePath: string): Promise<IntegrationResult> {
    const errors: string[] = [];
    let guards: GuardResult | undefined;
    let context: string[] | undefined;

    // Run guards if enabled
    if (this.config.guardsEnabled) {
      try {
        guards = await runGuards(filePath);
        if (!guards.passed) {
          errors.push(...guards.findings.map(f => f.message));
        }
      } catch (error) {
        errors.push(`Guard check failed: ${error}`);
      }
    }

    // Get context fragments if enabled
    if (this.config.contextEnabled) {
      try {
        context = this.contextRouter.match(filePath);
      } catch (error) {
        errors.push(`Context routing failed: ${error}`);
      }
    }

    return {
      success: errors.length === 0,
      guards,
      context,
      errors,
    };
  }

  /**
   * Check file before edit (pre-check)
   */
  async preEditCheck(filePath: string): Promise<IntegrationResult> {
    const errors: string[] = [];
    let guards: GuardResult | undefined;

    if (this.config.guardsEnabled) {
      try {
        guards = await runGuards(filePath);
        if (!guards.passed && guards.blockingCount > 0) {
          errors.push(...guards.findings
            .filter(f => f.blocking)
            .map(f => `BLOCKING: ${f.message}`));
        }
      } catch (error) {
        errors.push(`Pre-check failed: ${error}`);
      }
    }

    return {
      success: errors.length === 0,
      guards,
      errors,
    };
  }

  /**
   * Get context for a file
   */
  getContext(filePath: string): string {
    if (!this.config.contextEnabled) {
      return '';
    }
    return this.contextRouter.getContext(filePath);
  }

  /**
   * Get fragments for a file
   */
  getFragments(filePath: string): string[] {
    return this.contextRouter.match(filePath);
  }

  // ==================== Gate Methods ====================

  /**
   * Get current gate state
   */
  getCurrentGate(): Gate {
    return this.gateMachine.getCurrentGate();
  }

  /**
   * Get gate pack for output
   */
  getGatePack(): Record<string, unknown> {
    return this.gateMachine.getGatePack();
  }

  /**
   * Submit artifact to current gate
   */
  submitGateArtifact(name: string, artifact: unknown): void {
    this.gateMachine.submitArtifact(name, artifact);
  }

  /**
   * Attempt gate transition
   */
  async transitionGate(reviewResult?: { verdict: 'PASS' | 'BLOCK'; details?: string }): Promise<{
    success: boolean;
    transition: unknown;
  }> {
    const transition = await this.gateMachine.transition(reviewResult);
    return {
      success: transition.blockers.length === 0,
      transition,
    };
  }

  /**
   * Classify change type
   */
  classifyChange(description: string): Record<string, unknown> {
    const isPolicy = description.includes('policy') || description.includes('boundary');
    const isContract = description.includes('API') || description.includes('contract');
    const isImplementation = !isPolicy && !isContract;

    return {
      classification: isPolicy ? 'policy' : isContract ? 'contract' : 'implementation',
      minimum_gates: isPolicy ? '0→8' : isContract ? '0→8' : '0→7',
      fast_track: isImplementation,
    };
  }

  // ==================== Skill Methods ====================

  /**
   * Execute a bollharness skill
   */
  async executeSkill(skillName: string, params: Record<string, unknown>): Promise<{
    success: boolean;
    result?: string;
    error?: string;
  }> {
    try {
      const result = await this.skillAdapter.executeSkill(skillName, params);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * List available skills
   */
  listSkills(): Array<{ name: string; description: string }> {
    return this.skillAdapter.listSkills().map(s => ({
      name: s.name,
      description: s.description,
    }));
  }

  /**
   * Get skill registry
   */
  getSkillAdapter(): SkillAdapter {
    return this.skillAdapter;
  }

  /**
   * List harness-native skills (metadata from SKILL.md files)
   */
  listHarnessSkills(): Array<{ name: string; description: string; tier: string }> {
    return this.skillAdapter.listHarnessSkills().map(s => ({
      name: s.name,
      description: s.description,
      tier: s.tier,
    }));
  }

  // ==================== Configuration Methods ====================

  /**
   * Update configuration
   */
  updateConfig(config: Partial<BollharnessConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): BollharnessConfig {
    return { ...this.config };
  }

  /**
   * Enable/disable specific checks
   */
  enableCheck(checkName: string): void {
    this.guardChecker.enableCheck(checkName);
  }

  disableCheck(checkName: string): void {
    this.guardChecker.disableCheck(checkName);
  }

  // ==================== Metrics ====================

  /**
   * Get integration metrics
   */
  getMetrics(): Record<string, unknown> {
    return {
      config: this.config,
      currentGate: this.gateMachine.getCurrentGate(),
      enabledChecks: 'multiple',
      availableSkills: this.skillAdapter.listSkills().length,
    };
  }
}

/**
 * Create a default integration instance
 */
export function createBollharnessIntegration(
  config?: Partial<BollharnessConfig>
): BollharnessIntegration {
  return new BollharnessIntegration(config);
}

// ==================== Hook System Integration ====================

export interface HookContext {
  tool: string;
  filePath?: string;
  input?: Record<string, unknown>;
}

export interface HookResult {
  allowed: boolean;
  context?: string[];
  findings?: Array<{ severity: string; message: string }>;
  blockReason?: string;
}

/**
 * Integration hooks for Bolloon's execution pipeline
 */
export class BollharnessHooks {
  private integration: BollharnessIntegration;

  constructor(integration?: BollharnessIntegration) {
    this.integration = integration || new BollharnessIntegration();
  }

  /**
   * Pre-tool-use hook
   */
  async preToolUse(context: HookContext): Promise<HookResult> {
    // Check for dangerous operations
    if (context.tool === 'Bash') {
      const cmd = context.input?.command as string;
      if (cmd?.includes('rm -rf') || cmd?.includes('sudo')) {
        return {
          allowed: false,
          blockReason: 'Dangerous command detected',
        };
      }
    }

    // Check guards if file is being edited
    if (context.filePath && ['Edit', 'Write'].includes(context.tool)) {
      const result = await this.integration.preEditCheck(context.filePath);
      if (!result.success) {
        return {
          allowed: false,
          findings: result.guards?.findings.map(f => ({
            severity: f.severity,
            message: f.message,
          })),
          blockReason: 'Guard checks failed',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Post-tool-use hook
   */
  async postToolUse(context: HookContext): Promise<HookResult> {
    if (!context.filePath) {
      return { allowed: true };
    }

    const result = await this.integration.processFileEdit(context.filePath);
    
    return {
      allowed: result.success,
      context: result.context,
      findings: result.guards?.findings.map(f => ({
        severity: f.severity,
        message: f.message,
      })),
    };
  }

  /**
   * Session start hook
   */
  async sessionStart(): Promise<void> {
    // Reset state if needed
    console.log('[Bollharness] Session started with governance enabled');
  }

  /**
   * Session end hook
   */
  async sessionEnd(): Promise<void> {
    const metrics = this.integration.getMetrics();
    console.log('[Bollharness] Session ended', JSON.stringify(metrics, null, 2));
  }
}

