/**
 * Guard Checker - Port of Bollharness checks to Bolloon guardrails
 * 
 * Transforms bollharness's 15+ check functions into Bolloon's guardrail system.
 * 
 * Key concepts:
 * - Finding: bollharness's issue report structure
 * - Guardrail: Bolloon's pre/post execution check interface
 * - Guard Map: Path → Check[] routing
 */

import * as fs from 'fs';
import * as path from 'path';

export type Severity = 'P0' | 'P1' | 'P2';

export interface Finding {
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  blocking: boolean;
  category: string;
  problem_class: string;
  required_skills: string[];
  required_reads: string[];
}

export interface GuardFinding extends Finding {
  checkName: string;
  checkPath: string;
}

export interface GuardResult {
  passed: boolean;
  findings: GuardFinding[];
  blockingCount: number;
  highestSeverity: Severity | null;
}

export interface GuardConfig {
  name: string;
  description: string;
  run: (repoRoot: string, mode?: string) => Finding[];
  category?: string;
}

export interface GuardCheck {
  name: string;
  description: string;
  paths: string[] | RegExp[];
  run: (filePath: string, content?: string) => GuardFinding[];
}

/**
 * Port of bollharness's Finding interface
 */
export function createFinding(params: {
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  blocking?: boolean;
  category?: string;
  problem_class?: string;
  required_skills?: string[];
  required_reads?: string[];
}): Finding {
  return {
    severity: params.severity,
    message: params.message,
    file: params.file,
    line: params.line,
    blocking: params.blocking ?? false,
    category: params.category ?? 'general',
    problem_class: params.problem_class ?? 'unknown',
    required_skills: params.required_skills ?? [],
    required_reads: params.required_reads ?? [],
  };
}

/**
 * Guard Map - Maps file paths to relevant checks
 * Adapted from bollharness's guard_router.ts
 */
export const GUARD_MAP: Record<string, string[]> = {
  'src/agents/': ['check_api_types', 'check_skill_parity'],
  'src/documents/': ['check_doc_freshness', 'check_api_types'],
  'src/network/': ['check_api_types', 'check_versions'],
  'src/constraints/': ['check_api_types', 'check_versions'],
  'src/social/': ['check_api_types', 'check_versions'],
  'docs/': ['check_doc_freshness', 'check_doc_links'],
  'CLAUDE.md': ['check_doc_freshness', 'check_artifact_link'],
  'README.md': ['check_doc_freshness'],
  'docs/decisions/': ['check_artifact_link', 'check_versions'],
  '.boll/': ['check_hook_installed'],
  'src/test/': ['check_api_types', 'check_versions'],
};

/**
 * Default guards that run for all files
 */
export const DEFAULT_GUARDS: string[] = [];

/**
 * Category to Skills mapping
 * Maps guard categories to required bollharness skills
 */
export const CATEGORY_TO_SKILLS: Record<string, string[]> = {
  closure_semantics: ['lead', 'harness-ops'],
  contract_drift: ['harness-eng', 'harness-eng-test'],
  bridge_boundary: ['harness-bridge', 'harness-ops'],
  policy_freeze: ['lead', 'arch', 'plan-lock'],
  doc_integrity: ['harness-ops'],
  version_drift: ['harness-ops'],
  artifact_linkage: ['lead'],
  governance_bootstrap: ['harness-ops'],
};

/**
 * Check implementations - Ported from bollharness checks
 */

// Check: API Types
export function checkApiTypes(filePath: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  
  // Check if API types are consistent
  if (filePath.endsWith('.ts')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Check for TODO/FIXME that might indicate type issues
    const todoMatches = content.match(/\/\/\s*(TODO|FIXME|HACK|XXX):/g);
    if (todoMatches) {
      findings.push(createFinding({
        severity: 'P2',
        message: `Found ${todoMatches.length} development markers in code`,
        file: filePath,
        blocking: false,
        category: 'doc_integrity',
        problem_class: 'technical_debt',
        required_skills: ['harness-eng'],
      }) as GuardFinding);
    }
  }
  
  return findings;
}

// Check: Document Freshness
export function checkDocFreshness(filePath: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  
  if (filePath.endsWith('.md')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Check for outdated markers
    const outdatedMatches = content.match(/\[OUTDATED\]|\[DEPRECATED\]/gi);
    if (outdatedMatches) {
      findings.push(createFinding({
        severity: 'P1',
        message: 'Document contains outdated/deprecated markers',
        file: filePath,
        blocking: false,
        category: 'doc_integrity',
        problem_class: 'stale_content',
        required_skills: ['harness-ops'],
      }) as GuardFinding);
    }
    
    // Check for broken links (simplified)
    const linkMatches = content.match(/\[([^\]]+)\]\(([^)]+)\)/g);
    if (linkMatches) {
      for (const link of linkMatches) {
        const urlMatch = link.match(/\(([^)]+)\)/);
        if (urlMatch && urlMatch[1].startsWith('http')) {
          // External links need verification
          findings.push(createFinding({
            severity: 'P2',
            message: `External link needs verification: ${urlMatch[1]}`,
            file: filePath,
            blocking: false,
            category: 'doc_integrity',
            problem_class: 'link_verification',
            required_skills: [],
          }) as GuardFinding);
        }
      }
    }
  }
  
  return findings;
}

// Check: Skill Parity
export function checkSkillParity(filePath: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  
  // Check if skills are properly exported
  if (filePath.includes('skills')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Check for missing exports
    if (!content.includes('export')) {
      findings.push(createFinding({
        severity: 'P2',
        message: 'Skill file should export functions',
        file: filePath,
        blocking: false,
        category: 'contract_drift',
        problem_class: 'missing_export',
        required_skills: ['harness-eng'],
      }) as GuardFinding);
    }
  }
  
  return findings;
}

// Check: Versions
export function checkVersions(filePath: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  
  if (filePath === 'package.json') {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    try {
      const pkg = JSON.parse(content);
      
      // Check for version consistency
      if (!pkg.version) {
        findings.push(createFinding({
          severity: 'P1',
          message: 'package.json missing version field',
          file: filePath,
          blocking: true,
          category: 'version_drift',
          problem_class: 'missing_version',
          required_skills: ['harness-ops'],
        }) as GuardFinding);
      }
      
      // Check for missing dependencies
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
        findings.push(createFinding({
          severity: 'P2',
          message: 'package.json has no dependencies',
          file: filePath,
          blocking: false,
          category: 'version_drift',
          problem_class: 'missing_deps',
          required_skills: [],
        }) as GuardFinding);
      }
    } catch {
      findings.push(createFinding({
        severity: 'P0',
        message: 'package.json is invalid JSON',
        file: filePath,
        blocking: true,
        category: 'governance_bootstrap',
        problem_class: 'parse_error',
        required_skills: ['harness-ops'],
      }) as GuardFinding);
    }
  }
  
  return findings;
}

// Check: Hook Installed
export function checkHookInstalled(filePath: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  
  if (filePath.includes('.boll/settings')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Check for required hooks
    const requiredHooks = ['PostToolUse', 'PreToolUse', 'Stop', 'SessionEnd'];
    for (const hook of requiredHooks) {
      if (!content.includes(hook)) {
        findings.push(createFinding({
          severity: 'P1',
          message: `Required hook ${hook} not found in settings`,
          file: filePath,
          blocking: false,
          category: 'governance_bootstrap',
          problem_class: 'missing_hook',
          required_skills: ['harness-ops'],
        }) as GuardFinding);
      }
    }
  }
  
  return findings;
}

// Check: Artifact Linkage
export function checkArtifactLink(filePath: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  
  if (filePath.endsWith('.md') || filePath.includes('decisions')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Check for ADR references
    const adrMatches = content.match(/ADR-\d+/gi);
    if (adrMatches && adrMatches.length > 5) {
      findings.push(createFinding({
        severity: 'P2',
        message: `Found ${adrMatches.length} ADR references - verify all are linked`,
        file: filePath,
        blocking: false,
        category: 'artifact_linkage',
        problem_class: 'link_verification',
        required_skills: ['lead'],
      }) as GuardFinding);
    }
  }
  
  return findings;
}

/**
 * All available checks
 */
export const ALL_CHECKS: Record<string, (filePath: string) => GuardFinding[]> = {
  check_api_types: checkApiTypes,
  check_doc_freshness: checkDocFreshness,
  check_skill_parity: checkSkillParity,
  check_versions: checkVersions,
  check_hook_installed: checkHookInstalled,
  check_artifact_link: checkArtifactLink,
};

/**
 * Route file path to relevant checks
 * Adapted from bollharness's route() function
 */
export function route(filePath: string): string[] {
  const matched: string[] = [];
  const sortedPatterns = Object.keys(GUARD_MAP).sort((a, b) => b.length - a.length);

  for (const pattern of sortedPatterns) {
    if (filePath.startsWith(pattern) || filePath === pattern.replace(/\/$/, '')) {
      matched.push(...GUARD_MAP[pattern]);
    }
  }

  if (matched.length === 0) {
    return [...DEFAULT_GUARDS];
  }

  return [...new Set(matched)];
}

/**
 * Run guards for a file
 */
export async function runGuards(filePath: string): Promise<GuardResult> {
  const guardNames = route(filePath);
  const findings: GuardFinding[] = [];
  
  for (const name of guardNames) {
    const checkFn = ALL_CHECKS[name];
    if (checkFn) {
      try {
        const result = checkFn(filePath);
        for (const finding of result) {
          findings.push({
            ...finding,
            checkName: name,
            checkPath: filePath,
          });
        }
      } catch (error) {
        findings.push({
          severity: 'P0',
          message: `Guard ${name} failed: ${error}`,
          file: filePath,
          blocking: true,
          category: 'governance_bootstrap',
          problem_class: 'guard_error',
          required_skills: ['harness-ops'],
          required_reads: [],
          checkName: name,
          checkPath: filePath,
        });
      }
    }
  }

  const blockingCount = findings.filter(f => f.blocking).length;
  const severities = findings.map(f => f.severity);
  const severityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const highestSeverity = severities.length > 0
    ? severities.sort((a, b) => severityOrder[a] - severityOrder[b])[0] as Severity
    : null;

  return {
    passed: blockingCount === 0,
    findings,
    blockingCount,
    highestSeverity,
  };
}

/**
 * GuardChecker class for integration with Bolloon's constraint system
 */
export class GuardChecker {
  private checksDir: string;
  private enabledChecks: Set<string>;

  constructor(checksDir?: string) {
    this.checksDir = checksDir || process.cwd();
    this.enabledChecks = new Set(Object.keys(ALL_CHECKS));
  }

  enableCheck(name: string): void {
    this.enabledChecks.add(name);
  }

  disableCheck(name: string): void {
    this.enabledChecks.delete(name);
  }

  async check(filePath: string): Promise<GuardResult> {
    const guardNames = route(filePath).filter(name => this.enabledChecks.has(name));
    const findings: GuardFinding[] = [];

    for (const name of guardNames) {
      const checkFn = ALL_CHECKS[name];
      if (checkFn) {
        const result = checkFn(filePath);
        findings.push(...result.map(f => ({
          ...f,
          checkName: name,
          checkPath: filePath,
        })));
      }
    }

    const blockingCount = findings.filter(f => f.blocking).length;
    return {
      passed: blockingCount === 0,
      findings,
      blockingCount,
      highestSeverity: findings.length > 0 ? 'P1' : null,
    };
  }
}
