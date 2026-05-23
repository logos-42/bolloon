/**
 * Context Chain Router - Session summary chain injection
 *
 * Integrates with existing ContextRouter and Judgment systems.
 *
 * Architecture:
 * - Session end → extract summary by work_type → store in .boll/state/context-chains/
 * - Session start (Gate 0/3) → lookup related chains → inject summaries
 * - Work type: code_change | review | design | question | planning | debugging
 *
 * Integration points:
 * - Uses existing context-router-judgment.ts pattern (extends, not replaces)
 * - Gate injection via gate-judgment-inject.ts
 * - Storage in .boll/state/context-chains/
 */

import * as fs from 'fs';
import * as path from 'path';

export const CONTEXT_CHAINS_DIR = path.join('.boll', 'state', 'context-chains');

export type WorkType = 'code_change' | 'review' | 'design' | 'question' | 'planning' | 'debugging';

export interface ContextChainSummary {
  session_id: string;
  work_type: WorkType;
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{
    session_id: string;
    reason: string;
    relevance: number;
  }>;
  '核心摘要': Record<string, unknown>;
  '决策缺口'?: Array<{ 描述: string; 影响: string; 需要什么才能关闭: string }>;
  '风险点'?: Array<{ 描述: string; 概率: 'high' | 'medium' | 'low'; 缓解措施: string }>;
  '遗迹'?: string[];
}

export interface ContextChainLookupOptions {
  workType?: WorkType;
  minRelevance?: number;
  maxTokens?: number;
  gate?: number;
}

/**
 * Ensure context-chains directory exists
 */
function ensureDir(): void {
  if (!fs.existsSync(CONTEXT_CHAINS_DIR)) {
    fs.mkdirSync(CONTEXT_CHAINS_DIR, { recursive: true });
  }
}

/**
 * Get current month directory path
 */
function getMonthDir(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return path.join(CONTEXT_CHAINS_DIR, `${year}-${month}`);
}

/**
 * Generate session ID
 */
function generateSessionId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const seq = getTodaySequence() + 1;
  return `${year}${month}${day}-${String(seq).padStart(3, '0')}`;
}

/**
 * Get today's sequence number
 */
function getTodaySequence(): number {
  const dir = getMonthDir();
  if (!fs.existsSync(dir)) return 0;

  const todayPrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(todayPrefix) && f.endsWith('.yaml'));

  return files.length;
}

/**
 * Save a context chain summary
 */
export function saveContextChain(summary: ContextChainSummary): string {
  ensureDir();
  const monthDir = getMonthDir();
  if (!fs.existsSync(monthDir)) {
    fs.mkdirSync(monthDir, { recursive: true });
  }

  const filename = `${summary.session_id}-${summary.work_type}-${getTodaySequence() + 1}.yaml`;
  const filepath = path.join(monthDir, filename);

  const yaml = contextChainToYaml(summary);
  fs.writeFileSync(filepath, yaml, 'utf-8');

  return filepath;
}

/**
 * Convert context chain to YAML string
 */
function contextChainToYaml(summary: ContextChainSummary): string {
  const lines: string[] = [
    `session_id: "${summary.session_id}"`,
    `work_type: ${summary.work_type}`,
    `created_at: "${summary.created_at}"`,
    `gate_at_session: ${summary.gate_at_session}`,
    '',
    '关联上下文:',
  ];

  for (const ref of summary['关联上下文']) {
    lines.push(`  - session_id: "${ref.session_id}"`);
    lines.push(`    reason: "${ref.reason}"`);
    lines.push(`    relevance: ${ref.relevance}`);
  }

  lines.push('');
  lines.push('核心摘要:');

  const core = summary['核心摘要'];
  for (const [key, value] of Object.entries(core)) {
    if (Array.isArray(value)) {
      lines.push(`  ${key}:`);
      for (const item of value) {
        if (typeof item === 'object') {
          for (const [k, v] of Object.entries(item)) {
            lines.push(`    - ${k}: ${JSON.stringify(v)}`);
          }
        } else {
          lines.push(`    - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`  ${key}:`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    } else {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  }

  if (summary['决策缺口'] && summary['决策缺口'].length > 0) {
    lines.push('');
    lines.push('决策缺口:');
    for (const gap of summary['决策缺口']) {
      lines.push(`  - 描述: "${gap.描述}"`);
      lines.push(`    影响: "${gap.影响}"`);
      lines.push(`    需要什么才能关闭: "${gap.需要什么才能关闭}"`);
    }
  }

  if (summary['风险点'] && summary['风险点'].length > 0) {
    lines.push('');
    lines.push('风险点:');
    for (const risk of summary['风险点']) {
      lines.push(`  - 描述: "${risk.描述}"`);
      lines.push(`    概率: ${risk.概率}`);
      lines.push(`    缓解措施: "${risk.缓解措施}"`);
    }
  }

  if (summary['遗迹'] && summary['遗迹'].length > 0) {
    lines.push('');
    lines.push('遗迹:');
    for (const relic of summary['遗迹']) {
      lines.push(`  - "${relic}"`);
    }
  }

  return lines.join('\n');
}

/**
 * Load a single context chain by session_id
 */
export function loadContextChain(sessionId: string): ContextChainSummary | null {
  const pattern = new RegExp(`^${sessionId.replace(/-/g, '.*')}-.*\\.yaml$`);

  const dirs = fs.existsSync(CONTEXT_CHAINS_DIR)
    ? fs.readdirSync(CONTEXT_CHAINS_DIR)
    : [];

  for (const dir of dirs) {
    const dirPath = path.join(CONTEXT_CHAINS_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath).filter(f => pattern.test(f));
    if (files.length > 0) {
      const content = fs.readFileSync(path.join(dirPath, files[0]), 'utf-8');
      return parseContextChainYaml(content);
    }
  }

  return null;
}

/**
 * Parse YAML content to ContextChainSummary
 */
function parseContextChainYaml(content: string): ContextChainSummary {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey = '';
  let currentArray: string[] = [];
  let inArray = false;

  for (const line of lines) {
    if (line.includes(':') && !line.startsWith('  ')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();

      if (inArray && currentKey) {
        result[currentKey] = currentArray;
        currentArray = [];
        inArray = false;
      }

      currentKey = key.trim();

      if (value) {
        result[currentKey] = value.replace(/^["']|["']$/g, '');
      }
    } else if (line.startsWith('  - ')) {
      inArray = true;
      currentArray.push(line.replace(/^  - /, '').replace(/^["']|["']$/g, ''));
    }
  }

  if (inArray && currentKey) {
    result[currentKey] = currentArray;
  }

  return result as unknown as ContextChainSummary;
}

/**
 * Find related context chains by work type and relevance
 */
export function findRelatedChains(options: ContextChainLookupOptions = {}): ContextChainSummary[] {
  const {
    workType,
    minRelevance = 0.5,
    maxTokens = 2000,
    gate,
  } = options;

  if (!fs.existsSync(CONTEXT_CHAINS_DIR)) {
    return [];
  }

  const chains: ContextChainSummary[] = [];
  const dirs = fs.readdirSync(CONTEXT_CHAINS_DIR);

  for (const dir of dirs) {
    const dirPath = path.join(CONTEXT_CHAINS_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const chain = parseContextChainYaml(content);

      if (workType && chain.work_type !== workType) continue;
      if (gate !== undefined && chain.gate_at_session !== gate) continue;

      chains.push(chain);
    }
  }

  // Sort by relevance and recency
  chains.sort((a, b) => {
    const aRecency = new Date(a.created_at).getTime();
    const bRecency = new Date(b.created_at).getTime();
    return bRecency - aRecency;
  });

  // Apply token budget
  let totalTokens = 0;
  const selected: ContextChainSummary[] = [];

  for (const chain of chains) {
    const estimatedTokens = estimateTokens(chain);
    if (totalTokens + estimatedTokens > maxTokens) break;

    selected.push(chain);
    totalTokens += estimatedTokens;
  }

  return selected;
}

/**
 * Estimate token count for a chain
 */
function estimateTokens(chain: ContextChainSummary): number {
  const yaml = contextChainToYaml(chain);
  return Math.ceil(yaml.length / 4);
}

/**
 * Generate injection for Gate 0/3
 */
export async function generateContextChainInjection(
  gate: number,
  workType?: WorkType
): Promise<string> {
  const chains = findRelatedChains({
    workType,
    gate: gate === 0 ? undefined : gate,
    maxTokens: 2000,
  });

  if (chains.length === 0) {
    return '';
  }

  const header = gate === 0
    ? '# Context Chains — Recent Session Summaries'
    : `# Context Chains — Gate ${gate} Related Sessions`;

  const lines: string[] = [
    header,
    `# Injected at session start — chains from related prior sessions`,
    `# Total chains: ${chains.length} | Token budget: ~2000`,
    '',
    'context_chains:',
  ];

  for (const chain of chains) {
    lines.push(`  - session_id: "${chain.session_id}"`);
    lines.push(`    work_type: ${chain.work_type}`);
    lines.push(`    created_at: "${chain.created_at}"`);
    lines.push(`    gate_at_session: ${chain.gate_at_session}`);

    if (chain['关联上下文'].length > 0) {
      lines.push(`    关联上下文:`);
      for (const ref of chain['关联上下文']) {
        lines.push(`      - session_id: "${ref.session_id}"`);
        lines.push(`        relevance: ${ref.relevance}`);
      }
    }

    lines.push(`    核心摘要:`);
    const core = chain['核心摘要'];
    for (const [key, value] of Object.entries(core)) {
      if (Array.isArray(value)) {
        lines.push(`      ${key}:`);
        for (const item of value.slice(0, 3)) {
          if (typeof item === 'object') {
            lines.push(`        - ${JSON.stringify(item).slice(0, 100)}`);
          } else {
            lines.push(`        - ${JSON.stringify(item).slice(0, 100)}`);
          }
        }
        if (value.length > 3) {
          lines.push(`        ... (${value.length - 3} more)`);
        }
      } else if (typeof value === 'string' && value.length > 100) {
        lines.push(`      ${key}: "${value.slice(0, 100)}..."`);
      } else {
        lines.push(`      ${key}: ${JSON.stringify(value)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Create a new context chain summary from conversation
 */
export function createContextChain(params: {
  workType: WorkType;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): ContextChainSummary {
  const sessionId = generateSessionId();

  const summary: ContextChainSummary = {
    session_id: sessionId,
    work_type: params.workType,
    created_at: new Date().toISOString(),
    gate_at_session: params.gate,
    '关联上下文': (params.relatedSessions || []).map(r => ({
      session_id: r.sessionId,
      reason: r.reason,
      relevance: r.relevance,
    })),
    '核心摘要': extractCoreSummary(params.workType, params.conversationText),
    '决策缺口': [],
    '风险点': [],
    '遗迹': [],
  };

  return summary;
}

/**
 * Extract core summary based on work type
 */
function extractCoreSummary(workType: WorkType, text: string): Record<string, unknown> {
  switch (workType) {
    case 'code_change':
      return extractCodeChangeSummary(text);
    case 'review':
      return extractReviewSummary(text);
    case 'design':
      return extractDesignSummary(text);
    case 'planning':
      return extractPlanningSummary(text);
    case 'debugging':
      return extractDebuggingSummary(text);
    case 'question':
      return extractQuestionSummary(text);
    default:
      return { raw: text.slice(0, 500) };
  }
}

function extractCodeChangeSummary(text: string): Record<string, unknown> {
  const files: Array<{ path: string; change_type: string; reason: string }> = [];

  // Extract file paths from common patterns
  const filePattern = /(?:modified|changed|added|deleted):\s+([^\s]+)/gi;
  let match;
  while ((match = filePattern.exec(text)) !== null) {
    files.push({ path: match[1], change_type: 'modify', reason: '' });
  }

  return { files_changed: files, decisions: [], adr_linked: [] };
}

function extractReviewSummary(text: string): Record<string, unknown> {
  const hasBlock = text.toLowerCase().includes('block') || text.toLowerCase().includes('reject');
  return {
    verdict: hasBlock ? 'BLOCK' : 'PASS',
    reviewed_artifact: '',
    blocking_issues: [],
    non_blocking_observations: [],
  };
}

function extractDesignSummary(text: string): Record<string, unknown> {
  return { design_choices: [], constraints: [], consumers: [] };
}

function extractPlanningSummary(text: string): Record<string, unknown> {
  return { goals: [], dependencies: [], risks: [], decision_gaps: [] };
}

function extractDebuggingSummary(text: string): Record<string, unknown> {
  return { root_cause: '', symptoms_observed: [], fix_applied: [], files_touched: [] };
}

function extractQuestionSummary(text: string): Record<string, unknown> {
  return { question_type: 'unknown', answer_summary: '', source: '' };
}
