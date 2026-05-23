/**
 * Pi Judgment Integration for Bolloon
 *
 * Core module for capturing, distilling, and applying human judgment.
 *
 * Architecture:
 * Human Input → Distillation Trigger → LLM Extraction → Judgment YAML
 *                              ↓
 *                      ValueFunction
 *                              ↓
 *                    Runtime Decision
 *
 * Storage: Hybrid mode
 * - High-frequency rules: Embedded in context-fragments/*.md YAML frontmatter
 * - Long-term preferences: .bolloon/judgments/*.yaml
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type JudgmentType = 'rule' | 'preference' | 'trajectory' | 'reward';
export type JudgmentSource = 'human' | 'agent' | 'collaboration';
export type DistillationTrigger = 'explicit' | 'implicit' | 'trajectory';

export interface Judgment {
  id: string;
  type: JudgmentType;
  content: string;
  source: JudgmentSource;
  confidence: number;
  context?: string;
  createdAt: string;
  updatedAt: string;
  evidence?: JudgmentEvidence;
  metadata?: Record<string, unknown>;
}

export interface JudgmentEvidence {
  trajectory?: TrajectoryPoint[];
  preference_pair?: PreferencePair[];
  correction?: Correction;
}

export interface TrajectoryPoint {
  timestamp: string;
  action: string;
  outcome: string;
  approved: boolean;
}

export interface PreferencePair {
  query: string;
  chosen: string;
  rejected: string;
  context?: string;
}

export interface Correction {
  original: string;
  corrected: string;
  reason?: string;
  timestamp: string;
}

export interface JudgmentFile {
  judgments: Judgment[];
  filePath: string;
  lastModified: string;
}

export interface DistillationRequest {
  rawInput: string;
  trigger: DistillationTrigger;
  context: string;
  conversationHistory?: string[];
  agentPrediction?: string;
}

export interface ValueFunction {
  judgments: Judgment[];
  contextWeights: Record<string, number>;
  lastUpdated: string;
}

const JUDGMENTS_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'judgments');
const JUDGMENT_FILES = {
  rules: path.join(JUDGMENTS_DIR, 'rules.yaml'),
  preferences: path.join(JUDGMENTS_DIR, 'preferences.yaml'),
  trajectories: path.join(JUDGMENTS_DIR, 'trajectories.yaml'),
  rewards: path.join(JUDGMENTS_DIR, 'rewards.yaml'),
};

let judgmentCache: Map<string, Judgment[]> = new Map();
let valueFunctionCache: ValueFunction | null = null;
let cacheDirty: boolean = true;

function generateJudgmentId(): string {
  return `jdg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Load all judgments from YAML files
 */
export async function loadJudgments(): Promise<Map<string, Judgment[]>> {
  const judgments = new Map<string, Judgment[]>();

  await fs.mkdir(JUDGMENTS_DIR, { recursive: true });

  for (const [type, filePath] of Object.entries(JUDGMENT_FILES)) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = parseYaml(content) as { judgments?: Judgment[] } | Judgment[];
      if (data && Array.isArray(data)) {
        judgments.set(type, data as Judgment[]);
      } else if (data && 'judgments' in data && Array.isArray(data.judgments)) {
        judgments.set(type, data.judgments as Judgment[]);
      }
    } catch {
      judgments.set(type, []);
    }
  }

  judgmentCache = judgments;
  cacheDirty = false;
  return judgments;
}

/**
 * Save judgments to YAML file
 */
async function saveJudgments(type: string, judgments: Judgment[]): Promise<void> {
  await fs.mkdir(JUDGMENTS_DIR, { recursive: true });
  const filePath = JUDGMENT_FILES[type as keyof typeof JUDGMENT_FILES];
  if (!filePath) return;

  const yaml = serializeYaml({ judgments });
  await fs.writeFile(filePath, yaml, 'utf-8');
  cacheDirty = true;
}

/**
 * Create a new judgment
 */
export async function createJudgment(params: {
  type: JudgmentType;
  content: string;
  source: JudgmentSource;
  confidence: number;
  context?: string;
  evidence?: JudgmentEvidence;
}): Promise<Judgment> {
  const judgment: Judgment = {
    id: generateJudgmentId(),
    type: params.type,
    content: params.content,
    source: params.source,
    confidence: params.confidence,
    context: params.context,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidence: params.evidence,
  };

  const judgments = await loadJudgments();
  const typeJudgments = judgments.get(params.type) || [];
  typeJudgments.push(judgment);
  judgments.set(params.type, typeJudgments);

  await saveJudgments(params.type, typeJudgments);

  console.log(`[Judgment] Created ${judgment.id} (${params.type}): ${params.content.substring(0, 50)}...`);
  return judgment;
}

/**
 * Update judgment confidence based on feedback
 */
export async function updateJudgmentConfidence(
  id: string,
  delta: number,
  feedbackType: 'approve' | 'reject' | 'correct'
): Promise<Judgment | null> {
  const judgments = await loadJudgments();

  for (const [type, typeJudgments] of judgments.entries()) {
    const judgment = typeJudgments.find((j) => j.id === id);
    if (judgment) {
      let confidenceChange = delta;

      if (feedbackType === 'approve') {
        confidenceChange = Math.min(delta, 1 - judgment.confidence);
      } else if (feedbackType === 'reject') {
        confidenceChange = -delta;
      } else if (feedbackType === 'correct') {
        confidenceChange = delta * 2;
      }

      judgment.confidence = Math.max(0, Math.min(1, judgment.confidence + confidenceChange));
      judgment.updatedAt = new Date().toISOString();

      await saveJudgments(type, typeJudgments);
      return judgment;
    }
  }

  return null;
}

/**
 * Get all judgments
 */
export async function getAllJudgments(): Promise<Judgment[]> {
  const judgments = await loadJudgments();
  const all: Judgment[] = [];
  for (const typeJudgments of judgments.values()) {
    all.push(...typeJudgments);
  }
  return all;
}

/**
 * Get judgments by type
 */
export async function getJudgmentsByType(type: JudgmentType): Promise<Judgment[]> {
  const judgments = await loadJudgments();
  return judgments.get(type) || [];
}

/**
 * Get judgments relevant to a context
 */
export async function getJudgmentsForContext(context: string): Promise<Judgment[]> {
  const all = await getAllJudgments();
  return all.filter((j) => {
    if (!j.context) return false;
    return j.context.toLowerCase().includes(context.toLowerCase());
  });
}

/**
 * Calculate confidence score for a decision
 */
export function calculateConfidence(judgments: Judgment[]): number {
  if (judgments.length === 0) return 0.5;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const j of judgments) {
    const weight = j.confidence * (j.source === 'human' ? 1.5 : 1.0);
    weightedSum += weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}

/**
 * Build ValueFunction from judgments
 */
export async function buildValueFunction(context?: string): Promise<ValueFunction> {
  const judgments = context
    ? await getJudgmentsForContext(context)
    : await getAllJudgments();

  const contextWeights: Record<string, number> = {};
  const contextCounts: Record<string, number> = {};

  for (const j of judgments) {
    const ctx = j.context || 'general';
    contextCounts[ctx] = (contextCounts[ctx] || 0) + 1;
  }

  for (const [ctx, count] of Object.entries(contextCounts)) {
    contextWeights[ctx] = count / judgments.length;
  }

  return {
    judgments,
    contextWeights,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Get cached ValueFunction
 */
export async function getValueFunction(context?: string): Promise<ValueFunction> {
  if (!valueFunctionCache || cacheDirty) {
    valueFunctionCache = await buildValueFunction(context);
  }
  return valueFunctionCache;
}

/**
 * Extract judgments from context fragment YAML frontmatter
 */
export async function extractFromFragment(fragmentPath: string): Promise<Judgment[]> {
  try {
    const content = await fs.readFile(fragmentPath, 'utf-8');
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter.judgment) return [];

    const j = frontmatter.judgment as Record<string, unknown>;
    return [{
      id: generateJudgmentId(),
      type: (j.type as JudgmentType) || 'rule',
      content: extractMarkdownContent(content),
      source: (j.source as JudgmentSource) || 'human',
      confidence: typeof j.confidence === 'number' ? j.confidence : 0.9,
      context: j.category as string || path.basename(fragmentPath, '.md'),
      createdAt: j.last_reviewed as string || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { source: 'fragment', fragment: fragmentPath },
    }];
  } catch {
    return [];
  }
}

/**
 * Load judgments from all context fragments
 */
export async function loadFragmentJudgments(): Promise<Judgment[]> {
  const FRAGMENTS_DIR = path.join(process.cwd(), 'src', 'bollharness', 'scripts', 'context-fragments');
  const fragmentJudgments: Judgment[] = [];

  try {
    const files = await fs.readdir(FRAGMENTS_DIR);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const judgments = await extractFromFragment(path.join(FRAGMENTS_DIR, file));
        fragmentJudgments.push(...judgments);
      }
    }
  } catch {
    // Fragment directory doesn't exist
  }

  return fragmentJudgments;
}

/**
 * Get combined judgments (file + fragments)
 */
export async function getCombinedJudgments(): Promise<Judgment[]> {
  const [fileJudgments, fragmentJudgments] = await Promise.all([
    getAllJudgments(),
    loadFragmentJudgments(),
  ]);

  const seen = new Set<string>();
  const combined: Judgment[] = [];

  for (const j of fragmentJudgments) {
    combined.push(j);
    seen.add(j.context || j.id);
  }

  for (const j of fileJudgments) {
    if (!seen.has(j.context || j.id)) {
      combined.push(j);
    }
  }

  return combined;
}

/**
 * Simple YAML parser (handles basic judgment format)
 */
function parseYaml(content: string): unknown {
  try {
    if (!content.trim()) return [];

    const data: Record<string, unknown> = {};
    const lines = content.split('\n');
    const arrayItems: Record<string, unknown>[] = [];
    let inArray = false;
    let currentItem: Record<string, unknown> | null = null;
    let currentItemIndent = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      const indent = line.search(/\S/);
      const isArrayItem = trimmed.startsWith('-');
      const isComment = trimmed.startsWith('#');

      if (isComment) continue;

      if (trimmed.startsWith('judgments:')) {
        inArray = true;
        continue;
      }

      if (!inArray) continue;

      if (isArrayItem) {
        if (currentItem) {
          arrayItems.push(currentItem);
        }
        currentItem = {};
        currentItemIndent = indent + 1;

        const itemContent = trimmed.substring(1).trim();
        const kvMatch = itemContent.match(/^(\w+):\s*(.*)/);
        if (kvMatch) {
          currentItem[kvMatch[1]] = parseValue(kvMatch[2]);
        }
        continue;
      }

      if (currentItem && indent > currentItemIndent) {
        const kvMatch = trimmed.match(/^(\w+):\s*(.*)/);
        if (kvMatch) {
          currentItem[kvMatch[1]] = parseValue(kvMatch[2]);
        }
        continue;
      }

      if (trimmed.includes(':')) {
        const kvMatch = trimmed.match(/^(\w+):\s*(.*)/);
        if (kvMatch && !isArrayItem) {
          data[kvMatch[1]] = parseValue(kvMatch[2]);
        }
      }
    }

    if (currentItem) {
      arrayItems.push(currentItem);
    }

    if (arrayItems.length > 0) {
      data['judgments'] = arrayItems;
    }

    return data;
  } catch {
    return [];
  }
}

function parseValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === 'undefined') return null;
  if (!isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed);
  return trimmed;
}

/**
 * Simple YAML serializer
 */
function serializeYaml(data: unknown): string {
  const lines: string[] = ['# Auto-generated by Pi Judgment System', '# Do not edit manually', ''];

  if (typeof data === 'object' && data !== null) {
    lines.push('judgments:');
    const d = data as Record<string, unknown>;
    const arr = d.judgments;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        lines.push('  - ' + serializeObject(item, 4));
      }
    }
  }

  return lines.join('\n');
}

function serializeObject(obj: unknown, indent: number): string {
  if (typeof obj !== 'object' || obj === null) {
    return String(obj);
  }

  const spaces = ' '.repeat(indent);
  const innerSpace = ' '.repeat(indent + 2);
  const parts: string[] = [];

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(`${key}:`);
      parts.push(serializeObject(value, indent + 2));
    } else if (Array.isArray(value)) {
      parts.push(`${key}:`);
      for (const item of value) {
        parts.push(`${innerSpace}- ${serializeObject(item, indent + 4)}`);
      }
    } else {
      const strValue = typeof value === 'string' ? `"${value}"` : String(value);
      parts.push(`${key}: ${strValue}`);
    }
  }

  if (parts.length === 1 && !parts[0].includes(':')) {
    return parts[0];
  }

  return parts.join(`\n${spaces}`);
}

/**
 * Extract YAML frontmatter from markdown
 */
function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter: Record<string, unknown> = {};
  const lines = match[1].split('\n');

  let currentKey = '';
  let currentIndent = 0;

  for (const line of lines) {
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith('judgment:')) {
      currentKey = 'judgment';
      frontmatter[currentKey] = {};
    } else if (trimmed.startsWith('-')) {
      // Array item
    } else if (trimmed.includes(':')) {
      const [key, ...valueParts] = trimmed.split(':');
      const value = valueParts.join(':').trim();

      if (currentKey === 'judgment' && indent > 0) {
        (frontmatter[currentKey] as Record<string, unknown>)[key] = parseValue(value);
      } else {
        frontmatter[key.trim()] = parseValue(value);
        currentKey = key.trim();
      }
    }
  }

  return frontmatter;
}

/**
 * Extract markdown content (after frontmatter)
 */
function extractMarkdownContent(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

/**
 * Get judgment statistics
 */
export async function getJudgmentStats(): Promise<{
  total: number;
  byType: Record<JudgmentType, number>;
  bySource: Record<JudgmentSource, number>;
  averageConfidence: number;
}> {
  const judgments = await getAllJudgments();

  const byType: Record<JudgmentType, number> = {
    rule: 0,
    preference: 0,
    trajectory: 0,
    reward: 0,
  };

  const bySource: Record<JudgmentSource, number> = {
    human: 0,
    agent: 0,
    collaboration: 0,
  };

  let totalConfidence = 0;

  for (const j of judgments) {
    byType[j.type]++;
    bySource[j.source]++;
    totalConfidence += j.confidence;
  }

  return {
    total: judgments.length,
    byType,
    bySource,
    averageConfidence: judgments.length > 0 ? totalConfidence / judgments.length : 0,
  };
}

/**
 * Clear judgment cache
 */
export function clearCache(): void {
  valueFunctionCache = null;
  cacheDirty = true;
}