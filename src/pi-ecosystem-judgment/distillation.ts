/**
 * Judgment Distillation Module
 *
 * Real-time LLM-based distillation of human input into Judgment principles.
 *
 * Flow:
 * Human Input → Trigger Detection → LLM Extraction → Judgment
 *                    ↓
 *            Confidence + Evidence
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  Judgment,
  JudgmentType,
  DistillationTrigger,
  DistillationRequest,
  createJudgment,
  updateJudgmentConfidence,
  getAllJudgments,
} from './index.js';
import { getModel, type PiAIModel } from '../llm/pi-ai.js';

export interface DistillationResult {
  success: boolean;
  judgment?: Judgment;
  error?: string;
  trigger: DistillationTrigger;
}

export interface FeedbackSignal {
  judgmentId: string;
  type: 'approve' | 'reject' | 'correct';
  correction?: {
    original: string;
    corrected: string;
    reason?: string;
  };
}

const TRIGGER_PATTERNS = {
  explicit: [
    /不，我想要(.+)而不是(.+)/i,
    /错了，应该是(.+)/i,
    /这不是我想要的(.+)，要(.+)/i,
    /不对，应该(.+)/i,
    /重做，要(.+)/i,
    /不对，(?:我|应该|要|必须)(.+)/i,
  ],
  implicit: [
    /^(?!.*[?!]).{10,50}$/, // Short statements that might indicate preference
  ],
};

const MIN_TRAJECTORY_COUNT = 3;
const IMPLICIT_THRESHOLD = 0.7;

let trajectoryBuffer: Map<string, TrajectoryEntry[]> = new Map();
let llmModel: PiAIModel | null = null;

export interface TrajectoryEntry {
  timestamp: string;
  action: string;
  outcome: string;
  approved: boolean;
}

interface ConversationTurn {
  role: 'human' | 'agent';
  content: string;
  timestamp: string;
}

/**
 * Initialize the distillation system
 */
export async function initializeDistillation(): Promise<void> {
  try {
    llmModel = getModel();
  } catch {
    console.warn('[Distillation] LLM model not available, using fallback');
  }
}

/**
 * Detect trigger type from human input
 */
export function detectTrigger(input: string): DistillationTrigger | null {
  for (const pattern of TRIGGER_PATTERNS.explicit) {
    if (pattern.test(input)) {
      return 'explicit';
    }
  }

  for (const pattern of TRIGGER_PATTERNS.implicit) {
    if (pattern.test(input)) {
      return 'implicit';
    }
  }

  return null;
}

/**
 * Check if input indicates a judgment correction
 */
export function detectCorrection(input: string): { original: string; corrected: string } | null {
  for (const pattern of TRIGGER_PATTERNS.explicit) {
    const match = input.match(pattern);
    if (match) {
      if (match.length >= 3) {
        return { original: match[2], corrected: match[1] };
      } else if (match.length >= 2) {
        return { original: '', corrected: match[1] };
      }
    }
  }
  return null;
}

/**
 * Add to trajectory buffer
 */
export function addToTrajectory(agentId: string, action: string, outcome: string, approved: boolean): void {
  if (!trajectoryBuffer.has(agentId)) {
    trajectoryBuffer.set(agentId, []);
  }

  const entries = trajectoryBuffer.get(agentId)!;
  entries.push({
    timestamp: new Date().toISOString(),
    action,
    outcome,
    approved,
  });

  if (entries.length > 20) {
    entries.shift();
  }
}

/**
 * Detect trajectory pattern (repeated similar actions)
 */
export function detectTrajectoryPattern(agentId: string): TrajectoryEntry[] | null {
  const entries = trajectoryBuffer.get(agentId);
  if (!entries || entries.length < MIN_TRAJECTORY_COUNT) return null;

  const approvals = entries.filter((e) => e.approved);
  const approvalRate = approvals.length / entries.length;

  if (approvalRate >= IMPLICIT_THRESHOLD) {
    return entries.slice(-MIN_TRAJECTORY_COUNT);
  }

  return null;
}

/**
 * Distill human input to judgment using LLM
 */
export async function distillInput(request: DistillationRequest): Promise<DistillationResult> {
  const { rawInput, trigger, context, conversationHistory } = request;

  console.log(`[Distillation] Distilling input (${trigger}): ${rawInput.substring(0, 50)}...`);

  try {
    const judgment = await llmDistill(rawInput, trigger, context, conversationHistory);

    const created = await createJudgment({
      type: judgment.type,
      content: judgment.content,
      source: 'human',
      confidence: judgment.confidence,
      context: context,
      evidence: judgment.evidence,
    });

    return {
      success: true,
      judgment: created,
      trigger,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
      trigger,
    };
  }
}

/**
 * LLM-based distillation
 */
async function llmDistill(
  rawInput: string,
  trigger: DistillationTrigger,
  context: string,
  conversationHistory?: string[]
): Promise<{
  type: JudgmentType;
  content: string;
  confidence: number;
  evidence?: Judgment['evidence'];
}> {
  if (!llmModel) {
    return fallbackDistill(rawInput, trigger);
  }

  const historyText = conversationHistory
    ? conversationHistory.slice(-5).join('\n')
    : 'No history';

  const prompt = `从以下人类输入中提取判断力原理。

输入类型: ${trigger}
输入内容: ${rawInput}
上下文: ${context}
对话历史:
${historyText}

请提取：
1. type: rule(明确规则) | preference(偏好) | trajectory(行为轨迹) | reward(奖励信号)
2. content: 凝练后的原理（简洁，1-2句话）
3. confidence: 0.0-1.0 的置信度
4. evidence: 支持证据（如有）

直接输出JSON格式，不需要解释。`;

  try {
    const response = await llmModel.chat(
      `对话: ${historyText}\n\n输入: ${rawInput}`,
      `你是判断力提取专家。从人类输入中提取判断力原理。输入类型: ${trigger}`
    );

    return parseDistillationResponse(response.reply, rawInput, trigger);
  } catch (error) {
    console.warn('[Distillation] LLM distillation failed, using fallback:', error);
    return fallbackDistill(rawInput, trigger);
  }
}

/**
 * Parse LLM distillation response
 */
function parseDistillationResponse(
  response: string,
  rawInput: string,
  trigger: DistillationTrigger
): {
  type: JudgmentType;
  content: string;
  confidence: number;
} {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: parsed.type || inferType(rawInput, trigger),
        content: parsed.content || rawInput,
        confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.7)),
      };
    }
  } catch {}

  return {
    ...fallbackDistill(rawInput, trigger),
  };
}

/**
 * Fallback distillation when LLM is unavailable
 */
function fallbackDistill(
  rawInput: string,
  trigger: DistillationTrigger
): {
  type: JudgmentType;
  content: string;
  confidence: number;
} {
  const correction = detectCorrection(rawInput);

  if (correction) {
    return {
      type: 'rule',
      content: `${correction.corrected}（而非 ${correction.original}）`,
      confidence: 0.95,
    };
  }

  if (trigger === 'explicit') {
    return {
      type: 'rule',
      content: rawInput,
      confidence: 0.9,
    };
  }

  if (trigger === 'trajectory') {
    return {
      type: 'trajectory',
      content: '检测到重复行为模式',
      confidence: 0.75,
    };
  }

  return {
    type: 'preference',
    content: rawInput,
    confidence: 0.6,
  };
}

/**
 * Infer judgment type from input content
 */
function inferType(input: string, trigger: DistillationTrigger): JudgmentType {
  const lower = input.toLowerCase();

  if (lower.includes('不要') || lower.includes('禁止') || lower.includes('必须') || lower.includes('应该')) {
    return 'rule';
  }

  if (lower.includes('喜欢') || lower.includes('偏好') || lower.includes('宁愿')) {
    return 'preference';
  }

  if (trigger === 'trajectory') {
    return 'trajectory';
  }

  return 'preference';
}

/**
 * Process feedback signal
 */
export async function processFeedback(signal: FeedbackSignal): Promise<void> {
  const { judgmentId, type, correction } = signal;

  if (correction) {
    await createJudgment({
      type: 'rule',
      content: correction.corrected,
      source: 'human',
      confidence: 0.95,
      evidence: {
        correction: {
          original: correction.original,
          corrected: correction.corrected,
          reason: correction.reason,
          timestamp: new Date().toISOString(),
        },
      },
    });
  }

  await updateJudgmentConfidence(judgmentId, 0.1, type);
}

/**
 * Check if human input contains judgment signal
 */
export function isJudgmentSignal(input: string): boolean {
  return detectTrigger(input) !== null;
}

/**
 * Get trajectory buffer statistics
 */
export function getTrajectoryStats(): Record<string, { count: number; approvalRate: number }> {
  const stats: Record<string, { count: number; approvalRate: number }> = {};

  for (const [agentId, entries] of trajectoryBuffer.entries()) {
    const approvals = entries.filter((e) => e.approved).length;
    stats[agentId] = {
      count: entries.length,
      approvalRate: entries.length > 0 ? approvals / entries.length : 0,
    };
  }

  return stats;
}

/**
 * Clear trajectory buffer for agent
 */
export function clearTrajectory(agentId?: string): void {
  if (agentId) {
    trajectoryBuffer.delete(agentId);
  } else {
    trajectoryBuffer.clear();
  }
}