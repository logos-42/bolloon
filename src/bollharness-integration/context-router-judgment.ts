/**
 * Judgment-Aware Context Router
 *
 * Extends ContextRouter with judgment lookup and injection capabilities.
 *
 * Architecture:
 * - Path → Fragment Names → Associated Judgments
 * - Confidence-based filtering
 * - YAML format for user-language injection
 *
 * Integration with existing Bollharness:
 * - Uses existing ContextRouter.match() for fragment lookup
 * - Extends with judgment lookup based on fragment context
 * - Injects at Gate 0, Gate 3, and file-edit time
 */

import {
  match as contextMatch,
  getFragments,
  loadFragment,
  type ContextRouter,
} from './context-router.js';
import {
  getCombinedJudgments,
  getJudgmentsForContext,
  calculateConfidence,
  type Judgment,
} from '../pi-ecosystem-judgment/index.js';

export interface JudgmentInjectOptions {
  minConfidence: number;
  maxJudgments: number;
  format: 'yaml' | 'json' | 'text';
  includeEvidence: boolean;
}

export interface JudgmentContextResult {
  fragments: string[];
  judgments: Judgment[];
  contextYaml: string;
  confidence: number;
}

const DEFAULT_OPTIONS: JudgmentInjectOptions = {
  minConfidence: 0.7,
  maxJudgments: 5,
  format: 'yaml',
  includeEvidence: false,
};

/**
 * Get judgments associated with a fragment name
 */
export async function getJudgmentsForFragment(fragmentName: string): Promise<Judgment[]> {
  const allJudgments = await getCombinedJudgments();

  // Map fragment to judgment context categories
  const fragmentContextMap: Record<string, string[]> = {
    'truth-source-hierarchy': ['truth-source', 'code', 'architecture', 'hierarchy', 'priority'],
    'general-dev-principles': ['development', 'code-quality', 'best-practice'],
    'code-quality': ['code-quality', 'readability', 'maintainability'],
    'bridge-constitution': ['protocol', 'p2p', 'network'],
    'agent-architecture': ['agent', 'multi-agent', 'collaboration'],
    'multi-agent-patterns': ['multi-agent', 'delegation', 'coordination'],
    'testing-patterns': ['testing', 'quality', 'verification'],
    'decision-tracking': ['decision', 'adr', 'architecture'],
  };

  const contexts = fragmentContextMap[fragmentName] || [fragmentName];
  const relevantJudgments: Judgment[] = [];

  for (const judgment of allJudgments) {
    if (!judgment.context) continue;

    const judgmentContexts = judgment.context.toLowerCase().split(/[,\s]+/);
    for (const ctx of contexts) {
      if (judgmentContexts.some(jc => jc.includes(ctx.toLowerCase()))) {
        relevantJudgments.push(judgment);
        break;
      }
    }
  }

  return relevantJudgments;
}

/**
 * Get high-confidence judgments for a file path
 */
export async function getJudgmentsForPath(
  filePath: string,
  options: Partial<JudgmentInjectOptions> = {}
): Promise<JudgmentContextResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Get associated fragment names
  const fragmentNames = contextMatch(filePath);
  const allFragments = fragmentNames.length > 0 ? fragmentNames : ['general-dev-principles'];

  // Get judgments for each fragment
  const allJudgments: Judgment[] = [];
  for (const fragment of allFragments) {
    const judgments = await getJudgmentsForFragment(fragment);
    allJudgments.push(...judgments);
  }

  // Deduplicate and filter by confidence
  const seen = new Set<string>();
  const filteredJudgments: Judgment[] = [];
  for (const j of allJudgments) {
    if (seen.has(j.id)) continue;
    if (j.confidence < opts.minConfidence) continue;
    seen.add(j.id);
    filteredJudgments.push(j);
  }

  // Sort by confidence descending
  filteredJudgments.sort((a, b) => b.confidence - a.confidence);

  // Limit count
  const limitedJudgments = filteredJudgments.slice(0, opts.maxJudgments);

  // Calculate overall confidence
  const overallConfidence = calculateConfidence(limitedJudgments);

  // Format as YAML
  const contextYaml = formatJudgmentsAsYaml(limitedJudgments, opts);

  return {
    fragments: allFragments,
    judgments: limitedJudgments,
    contextYaml,
    confidence: overallConfidence,
  };
}

/**
 * Get core judgments for session start (high confidence only)
 */
export async function getCoreJudgmentsForSession(minConfidence = 0.9): Promise<string> {
  const allJudgments = await getCombinedJudgments();

  const highConfidence = allJudgments
    .filter(j => j.confidence >= minConfidence && j.source === 'human')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  if (highConfidence.length === 0) {
    return '';
  }

  const lines: string[] = [
    `# User Core Values (Confidence >= ${minConfidence})`,
    `# Injected at session start - these represent fundamental user principles`,
    '',
    'core_judgments:',
  ];

  for (const j of highConfidence) {
    lines.push(`  - principle: "${escapeYamlString(j.content)}"`);
    lines.push(`    type: ${j.type}`);
    lines.push(`    confidence: ${j.confidence.toFixed(2)}`);
    if (j.context) {
      lines.push(`    context: "${j.context}"`);
    }
  }

  return lines.join('\n');
}

/**
 * Get judgments for a specific context (e.g., "investment", "code-review")
 */
export async function getJudgmentsForContextRequest(
  context: string,
  options: Partial<JudgmentInjectOptions> = {}
): Promise<JudgmentContextResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const judgments = await getJudgmentsForContext(context);
  const filtered = judgments
    .filter(j => j.confidence >= opts.minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, opts.maxJudgments);

  const overallConfidence = calculateConfidence(filtered);
  const contextYaml = formatJudgmentsAsYaml(filtered, opts);

  return {
    fragments: [],
    judgments: filtered,
    contextYaml,
    confidence: overallConfidence,
  };
}

/**
 * Format judgments as YAML for injection
 */
function formatJudgmentsAsYaml(judgments: Judgment[], opts: JudgmentInjectOptions): string {
  if (judgments.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (opts.format === 'yaml') {
    lines.push('# Active Judgments');
    lines.push('# Based on user history and preferences');
    lines.push('');
    lines.push('active_judgments:');

    for (const j of judgments) {
      lines.push(`  - principle: "${escapeYamlString(j.content)}"`);
      lines.push(`    type: ${j.type}`);
      lines.push(`    confidence: ${j.confidence.toFixed(2)}`);

      if (j.context) {
        lines.push(`    context: "${j.context}"`);
      }

      if (opts.includeEvidence && j.evidence) {
        const evidenceStr = formatEvidence(j.evidence);
        lines.push(`    evidence: ${evidenceStr}`);
      }

      lines.push('');
    }
  } else if (opts.format === 'json') {
    const obj = judgments.map(j => ({
      principle: j.content,
      type: j.type,
      confidence: j.confidence,
      context: j.context,
      evidence: opts.includeEvidence ? j.evidence : undefined,
    }));
    lines.push(JSON.stringify(obj, null, 2));
  } else {
    // text format
    for (const j of judgments) {
      lines.push(`[${(j.confidence * 100).toFixed(0)}%] ${j.content}`);
      if (j.context) {
        lines.push(`  Context: ${j.context}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format evidence for YAML
 */
function formatEvidence(evidence: Judgment['evidence']): string {
  if (!evidence) return '""';

  const parts: string[] = [];

  if (evidence.trajectory && evidence.trajectory.length > 0) {
    const summary = evidence.trajectory
      .slice(-3)
      .map(t => `${t.timestamp}: ${t.action}`)
      .join(' → ');
    parts.push(`trajectory: "${escapeYamlString(summary)}"`);
  }

  if (evidence.preference_pair && evidence.preference_pair.length > 0) {
    const pp = evidence.preference_pair[0];
    parts.push(`preference: "chose '${escapeYamlString(pp.chosen)}' over '${escapeYamlString(pp.rejected)}'"`);
  }

  if (evidence.correction) {
    parts.push(`correction: "${escapeYamlString(evidence.correction.corrected)}"`);
  }

  return parts.length > 0 ? `"${parts.join('; ')}"` : '""';
}

/**
 * Escape string for YAML
 */
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Generate injection prompt for a file path
 */
export async function generateJudgmentInjection(
  filePath: string,
  gate: number,
  options: Partial<JudgmentInjectOptions> = {}
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Gate-specific confidence thresholds
  const gateConfidence = {
    0: 0.9,  // Session start - only highest confidence
    1: 0.8,  // Architecture design
    2: 0.75, // Review
    3: 0.8,  // Plan freeze
    4: 0.75, // Review
    5: 0.7,  // Task architecture
    6: 0.75, // Review
    7: 0.7,  // Execution
    8: 0.7,  // Test & Integration
  };

  const minConfidence = gateConfidence[gate as keyof typeof gateConfidence] || opts.minConfidence;
  const effectiveOptions = { ...opts, minConfidence };

  if (gate === 0) {
    // Session start - inject core judgments
    return await getCoreJudgmentsForSession(minConfidence);
  }

  // Other gates - inject path-specific judgments
  const result = await getJudgmentsForPath(filePath, effectiveOptions);

  if (result.contextYaml.length === 0) {
    return '';
  }

  const header = gate === 3
    ? '# Plan Freeze - Decision Principles'
    : `# Gate ${gate} - Active Judgments`;

  return `${header}
# Path: ${filePath}
# Confidence: ${(result.confidence * 100).toFixed(0)}%

${result.contextYaml}`;
}