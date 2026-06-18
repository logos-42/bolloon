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
import * as fs from 'fs';
import * as path from 'path';

export interface BollharnessConfig {
  enabled: boolean;
  guardsEnabled: boolean;
  contextEnabled: boolean;
  skillsEnabled: boolean;
  gatesEnabled: boolean;
  persistencePath?: string;
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
 * Session Archive Entry
 */
export interface SessionArchive {
  id: string;
  timestamp: number;
  gate: number;
  summary: string;
  actionCount: number;
  compressed: string;
  keyDecisions: string[];
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
  private sessionArchives: SessionArchive[] = [];
  private currentSessionId: string = '';

  constructor(config: Partial<BollharnessConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      guardsEnabled: config.guardsEnabled ?? true,
      contextEnabled: config.contextEnabled ?? true,
      skillsEnabled: config.skillsEnabled ?? true,
      gatesEnabled: config.gatesEnabled ?? true,
      persistencePath: config.persistencePath,
    };

    this.gateMachine = new GateStateMachine();
    this.guardChecker = new GuardChecker();
    this.contextRouter = new ContextRouter();
    this.skillAdapter = createSkillAdapter();

    if (this.config.persistencePath) {
      this.loadState();
    }
  }

  saveState(): void {
    if (!this.config.persistencePath) return;
    try {
      const gateState = this.gateMachine.getState();
      const data = JSON.stringify({
        gateState: {
          currentGate: gateState.currentGate,
          entrySatisfied: gateState.entrySatisfied,
          blockers: gateState.blockers,
          requiredArtifact: gateState.requiredArtifact,
          requiredNextSkill: gateState.requiredNextSkill,
          valueInjection: gateState.valueInjection,
          artifacts: Array.from(gateState.artifacts.entries()),
          conversationHistory: gateState.conversationHistory,
        },
        sessionArchives: this.sessionArchives,
        currentSessionId: this.currentSessionId,
      }, null, 2);
      const dir = path.dirname(this.config.persistencePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.config.persistencePath, data, 'utf-8');
    } catch (err: any) {
      console.warn(`[BollharnessIntegration] 持久化失败: ${err.message}`);
    }
  }

  private loadState(): void {
    if (!this.config.persistencePath) return;
    try {
      if (!fs.existsSync(this.config.persistencePath)) return;
      const raw = fs.readFileSync(this.config.persistencePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.gateState) {
        this.gateMachine.restore({
          currentGate: data.gateState.currentGate,
          entrySatisfied: data.gateState.entrySatisfied,
          blockers: data.gateState.blockers,
          requiredArtifact: data.gateState.requiredArtifact,
          requiredNextSkill: data.gateState.requiredNextSkill,
          requiredReviewSubstrate: undefined,
          valueInjection: data.gateState.valueInjection || '',
          artifacts: new Map(data.gateState.artifacts || []),
          conversationHistory: data.gateState.conversationHistory || [],
        });
      }
      if (data.sessionArchives) {
        this.sessionArchives = data.sessionArchives;
      }
      if (data.currentSessionId) {
        this.currentSessionId = data.currentSessionId;
      }
    } catch (err: any) {
      console.warn(`[BollharnessIntegration] 状态恢复失败: ${err.message}`);
    }
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
    this.saveState();
  }

  /**
   * Attempt gate transition
   */
  async transitionGate(reviewResult?: { verdict: 'PASS' | 'BLOCK'; details?: string }): Promise<{
    success: boolean;
    transition: unknown;
  }> {
    const transition = await this.gateMachine.transition(reviewResult);
    this.saveState();
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
      sessionArchives: this.sessionArchives.length,
    };
  }

  // ==================== Session Archive Methods ====================

  /**
   * Archive current session operations with compression
   */
  archiveSession(
    logs: Array<{ timestamp: number; action: string; details?: Record<string, unknown>; status: string }>,
    options?: { summary?: string; keyDecisions?: string[] }
  ): SessionArchive {
    const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const gate = this.gateMachine.getCurrentGate();

    const compressed = this.compressLogs(logs);
    const summary = options?.summary || this.generateSessionSummary(logs);
    const keyDecisions = options?.keyDecisions || this.extractKeyDecisions(logs);

    const archive: SessionArchive = {
      id,
      timestamp: Date.now(),
      gate,
      summary,
      actionCount: logs.length,
      compressed,
      keyDecisions,
    };

    this.sessionArchives.push(archive);
    this.currentSessionId = id;
    this.saveState();

    return archive;
  }

  /**
   * Compress logs by removing redundancy
   */
  private compressLogs(logs: Array<{ timestamp: number; action: string; details?: Record<string, unknown>; status: string }>): string {
    if (logs.length === 0) return '';

    const lines: string[] = [];
    const seenActions = new Set<string>();
    const recentTime = logs.length > 10 ? logs[logs.length - 10].timestamp : logs[0].timestamp;

    lines.push(`## Session Archive (${logs.length} actions)`);
    lines.push(`Gate: ${this.gateMachine.getCurrentGate()}`);
    lines.push('');

    for (const log of logs.slice(-50)) {
      const time = new Date(log.timestamp).toISOString();
      const action = log.action.padEnd(30);

      if (seenActions.has(log.action) && log.status === 'ok') {
        lines.push(`  ${time} [RPT] ${action}`);
      } else {
        lines.push(`  ${time} [${log.status.padEnd(4)}] ${action}`);
        seenActions.add(log.action);
      }

      if (log.timestamp < recentTime) {
        lines.push(`    ^ ${log.details ? JSON.stringify(log.details).substring(0, 100) : ''}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a brief summary of the session
   */
  private generateSessionSummary(logs: Array<{ action: string; status: string }>): string {
    const actions = logs.map(l => l.action);
    const unique = [...new Set(actions)];
    const okCount = logs.filter(l => l.status === 'ok').length;
    return `${this.gateMachine.getCurrentGate()}G: ${unique.slice(0, 3).join(', ')}${unique.length > 3 ? '...' : ''} (${okCount}/${logs.length} OK)`;
  }

  /**
   * Extract key decisions from logs
   */
  private extractKeyDecisions(logs: Array<{ action: string; details?: Record<string, unknown> }>): string[] {
    const decisions: string[] = [];
    for (const log of logs) {
      if (log.action.includes('decision') || log.action.includes('approve') || log.action.includes('commit')) {
        decisions.push(log.action);
      }
    }
    return decisions.slice(0, 10);
  }

  /**
   * Get session context for skills
   */
  getSessionContext(sessionId?: string): string {
    if (sessionId) {
      const archive = this.sessionArchives.find(a => a.id === sessionId);
      if (archive) {
        return `## Session ${archive.id}\nGate: ${archive.gate}\n${archive.compressed}`;
      }
    }

    if (this.sessionArchives.length === 0) {
      return 'No session archives available.';
    }

    const recent = this.sessionArchives.slice(-3);
    const lines = ['## Recent Sessions'];

    for (const archive of recent) {
      lines.push(`\n### ${archive.id}`);
      lines.push(`Gate: ${archive.gate} | Actions: ${archive.actionCount}`);
      lines.push(`Summary: ${archive.summary}`);
      if (archive.keyDecisions.length > 0) {
        lines.push(`Decisions: ${archive.keyDecisions.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get all session archives
   */
  getSessionArchives(): SessionArchive[] {
    return [...this.sessionArchives];
  }

  /**
   * Start a new session
   */
  startNewSession(): string {
    this.currentSessionId = `session_${Date.now()}`;
    this.saveState();
    return this.currentSessionId;
  }

  /**
   * Link current harness session to Pi SDK session
   */
  linkSession(sessionId: string): void {
    this.currentSessionId = sessionId;
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

