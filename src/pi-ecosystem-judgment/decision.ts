/**
 * Decision Request & Authorization Flow
 *
 * Handles decision requests when agent confidence is below threshold.
 * Supports consulting internal agents (colony/subagents) and external agents (P2P).
 *
 * Flow:
 * Agent Decision Need
 *     ↓
 * Query ValueFunction → Calculate Confidence
 *     ↓
 * Confidence > Threshold → Execute
 *     ↓ (No)
 * DecisionRequest → [Human | Internal Agents | External Agents]
 *     ↓
 * Authorization / Collaboration
 *     ↓
 * Execute & Archive Judgment
 */

import { EventEmitter } from 'events';
import {
  Judgment,
  ValueFunction,
  getValueFunction,
  getCombinedJudgments,
  calculateConfidence,
} from './index.js';
import {
  distillInput,
  isJudgmentSignal,
  detectTrigger,
  processFeedback,
  type FeedbackSignal,
} from './distillation.js';
// 2026-06-11: 蚁群模块已被用户删除, 移除 import 防止启动失败, 加本地 stub
// import { listAnts, type Ant } from '../pi-ecosystem-colony/index.js';
import { listSubagents, type Subagent } from '../pi-ecosystem-subagents/index.js';

// Stub: 蚁群删除后, 永远返回空列表
function listAnts(): any[] { return []; }
type Ant = { name: string; signal: string };

export type DecisionLevel = 'autonomous' | 'consult_internal' | 'consult_external' | 'require_human';
export type ConsultationTarget = 'human' | 'colony_ant' | 'subagent' | 'p2p_agent';
export type DecisionStatus = 'pending' | 'authorized' | 'rejected' | 'executed' | 'failed';

export interface DecisionRequest {
  id: string;
  description: string;
  context: string;
  confidence: number;
  threshold: number;
  level: DecisionLevel;
  targets: ConsultationTarget[];
  status: DecisionStatus;
  agentId: string;
  createdAt: string;
  respondedAt?: string;
  response?: DecisionResponse;
  judgment?: Judgment;
}

export interface DecisionResponse {
  authorized: boolean;
  content: string;
  modifier?: string;
  delegate?: ConsultationTarget;
  by: ConsultationTarget;
  timestamp: string;
}

export interface AgentConsultationResult {
  target: ConsultationTarget;
  agentId: string;
  response: string;
  confidence: number;
}

class DecisionEventEmitter extends EventEmitter {}
const decisionEvents = new DecisionEventEmitter();

const decisionRequests: Map<string, DecisionRequest> = new Map();
let defaultThreshold = 0.7;
let defaultLevel: DecisionLevel = 'autonomous';

function generateDecisionId(): string {
  return `dec-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Set default confidence threshold
 */
export function setConfidenceThreshold(threshold: number): void {
  defaultThreshold = Math.max(0, Math.min(1, threshold));
}

/**
 * Get default confidence threshold
 */
export function getConfidenceThreshold(): number {
  return defaultThreshold;
}

/**
 * Set default decision level
 */
export function setDefaultDecisionLevel(level: DecisionLevel): void {
  defaultLevel = level;
}

/**
 * Get default decision level
 */
export function getDefaultDecisionLevel(): DecisionLevel {
  return defaultLevel;
}

/**
 * Evaluate a decision need and determine appropriate level
 */
export async function evaluateDecision(
  description: string,
  context: string,
  agentId: string,
  threshold?: number
): Promise<DecisionRequest> {
  const effectiveThreshold = threshold ?? defaultThreshold;

  const valueFunction = await getValueFunction(context);
  const judgments = valueFunction.judgments.filter((j) =>
    j.context?.toLowerCase().includes(context.toLowerCase())
  );
  const confidence = calculateConfidence(judgments);

  const level = determineDecisionLevel(confidence, effectiveThreshold);
  const targets = determineConsultationTargets(level);

  const request: DecisionRequest = {
    id: generateDecisionId(),
    description,
    context,
    confidence,
    threshold: effectiveThreshold,
    level,
    targets,
    status: 'pending',
    agentId,
    createdAt: new Date().toISOString(),
  };

  decisionRequests.set(request.id, request);
  decisionEvents.emit('decisionCreated', request);

  console.log(
    `[Decision] Request ${request.id}: confidence=${confidence.toFixed(2)}, level=${level}`
  );

  return request;
}

/**
 * Determine decision level based on confidence
 */
function determineDecisionLevel(confidence: number, threshold: number): DecisionLevel {
  if (confidence >= threshold) {
    return 'autonomous';
  }

  if (confidence >= threshold * 0.7) {
    return 'consult_internal';
  }

  if (confidence >= threshold * 0.4) {
    return 'consult_external';
  }

  return 'require_human';
}

/**
 * Determine consultation targets based on decision level
 */
function determineConsultationTargets(level: DecisionLevel): ConsultationTarget[] {
  switch (level) {
    case 'autonomous':
      return [];
    case 'consult_internal':
      return ['colony_ant', 'subagent'];
    case 'consult_external':
      return ['colony_ant', 'subagent', 'p2p_agent'];
    case 'require_human':
      return ['human'];
    default:
      return [];
  }
}

/**
 * Submit a decision response
 */
export async function submitDecisionResponse(
  requestId: string,
  response: DecisionResponse
): Promise<DecisionRequest | null> {
  const request = decisionRequests.get(requestId);
  if (!request) return null;

  request.response = response;
  request.respondedAt = new Date().toISOString();

  if (response.authorized) {
    request.status = 'authorized';
  } else {
    request.status = 'rejected';
  }

  decisionRequests.set(requestId, request);
  decisionEvents.emit('decisionResponded', request);

  if (response.delegate) {
    console.log(`[Decision] Request ${requestId} delegated to ${response.delegate}`);
  }

  return request;
}

/**
 * Check if input is a decision response
 */
export function isDecisionResponse(input: string): boolean {
  const patterns = [
    /^(是|可以|同意|授权|执行|对|好|ok|yes|y)/i,
    /^(不|否|拒绝|不行|no|n)/i,
    /^(修改|改为|改成|用|用这个)/i,
  ];

  return patterns.some((p) => p.test(input.trim()));
}

/**
 * Parse decision response from natural language
 */
export function parseDecisionResponse(input: string): Partial<DecisionResponse> {
  const trimmed = input.trim().toLowerCase();

  if (/^(是|可以|同意|授权|执行|对|好|ok|yes|y)/.test(trimmed)) {
    return { authorized: true, content: input };
  }

  if (/^(不|否|拒绝|不行|no|n)/.test(trimmed)) {
    return { authorized: false, content: input };
  }

  if (/^(修改|改为|改成|用|用这个)/.test(trimmed)) {
    const match = input.match(/^(?:修改|改为|改成|用|用这个)\s*(.+)/i);
    return {
      authorized: true,
      modifier: match ? match[1] : input,
      content: input,
    };
  }

  return { authorized: true, content: input };
}

/**
 * Query internal agents (colony ants and subagents)
 */
export async function queryInternalAgents(
  request: DecisionRequest
): Promise<AgentConsultationResult[]> {
  const results: AgentConsultationResult[] = [];

  if (request.targets.includes('colony_ant')) {
    const ants = listAnts().filter((a) => a.signal !== 'COMPLETE' && a.signal !== 'FAILED');
    for (const ant of ants.slice(0, 3)) {
      const result = await consultColonyAnt(ant, request);
      if (result) results.push(result);
    }
  }

  if (request.targets.includes('subagent')) {
    const subagents = listSubagents().filter((s) => s.status === 'running');
    for (const subagent of subagents.slice(0, 2)) {
      const result = await consultSubagent(subagent, request);
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Consult a colony ant
 */
async function consultColonyAnt(
  ant: Ant,
  request: DecisionRequest
): Promise<AgentConsultationResult | null> {
  console.log(`[Decision] Consulting ant ${ant.name} for ${request.id}`);

  return {
    target: 'colony_ant',
    agentId: ant.id,
    response: `[Simulated] Ant ${ant.name} suggests: ${request.description.substring(0, 30)}...`,
    confidence: 0.6,
  };
}

/**
 * Consult a subagent
 */
async function consultSubagent(
  subagent: Subagent,
  request: DecisionRequest
): Promise<AgentConsultationResult | null> {
  console.log(`[Decision] Consulting subagent ${subagent.name} for ${request.id}`);

  return {
    target: 'subagent',
    agentId: subagent.id,
    response: `[Simulated] Subagent ${subagent.name} advises: ${request.description.substring(0, 30)}...`,
    confidence: 0.65,
  };
}

/**
 * Process human feedback and distill to judgment
 */
export async function processHumanFeedback(
  requestId: string,
  input: string
): Promise<DecisionRequest | null> {
  const request = decisionRequests.get(requestId);
  if (!request) return null;

  const parsed = parseDecisionResponse(input);
  const by: ConsultationTarget = 'human';

  const response: DecisionResponse = {
    authorized: parsed.authorized ?? false,
    content: parsed.content ?? input,
    modifier: parsed.modifier,
    delegate: parsed.delegate,
    by,
    timestamp: new Date().toISOString(),
  };

  await submitDecisionResponse(requestId, response);

  if (isJudgmentSignal(input)) {
    const trigger = detectTrigger(input);
    if (trigger) {
      const result = await distillInput({
        rawInput: input,
        trigger,
        context: request.context,
      });

      if (result.success && result.judgment) {
        request.judgment = result.judgment;
        decisionRequests.set(requestId, request);
      }
    }
  }

  const feedback: FeedbackSignal = {
    judgmentId: request.judgment?.id || '',
    type: parsed.authorized ? 'approve' : 'reject',
    correction: parsed.modifier
      ? {
          original: request.description,
          corrected: parsed.modifier,
        }
      : undefined,
  };

  if (feedback.judgmentId) {
    await processFeedback(feedback);
  }

  return request;
}

/**
 * Get pending decision requests
 */
export function getPendingDecisions(): DecisionRequest[] {
  return Array.from(decisionRequests.values()).filter((r) => r.status === 'pending');
}

/**
 * Get decision request by ID
 */
export function getDecisionRequest(id: string): DecisionRequest | undefined {
  return decisionRequests.get(id);
}

/**
 * Get decision statistics
 */
export function getDecisionStats(): {
  pending: number;
  authorized: number;
  rejected: number;
  total: number;
} {
  const requests = Array.from(decisionRequests.values());
  return {
    pending: requests.filter((r) => r.status === 'pending').length,
    authorized: requests.filter((r) => r.status === 'authorized').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
    total: requests.length,
  };
}

/**
 * Subscribe to decision events
 */
export function onDecisionEvent(
  event: 'decisionCreated' | 'decisionResponded' | 'decisionExecuted',
  callback: (request: DecisionRequest) => void
): void {
  decisionEvents.on(event, callback);
}

/**
 * Unsubscribe from decision events
 */
export function offDecisionEvent(
  event: 'decisionCreated' | 'decisionResponded' | 'decisionExecuted',
  callback: (request: DecisionRequest) => void
): void {
  decisionEvents.off(event, callback);
}