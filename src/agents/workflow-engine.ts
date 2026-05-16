/**
 * WorkflowEngine - Execution layer for document processing workflows
 * Part of OpenClaw dual-layer architecture (Constraint Layer + Execution Layer)
 */

import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../runtime/context/sys-prompt.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer, WorkflowContext } from './constraint-layer.js';

export interface WorkflowStepConfig {
  path?: string;
  requirements?: string;
  context?: string;
  peerId?: string;
  message?: string;
  content?: string;
  maxChunkSize?: number;
}

export interface WorkflowStep {
  id: string;
  type: 'read' | 'chunk' | 'summarize' | 'improve' | 'review' | 'send' | 'report';
  config?: WorkflowStepConfig;
  retry: {
    max: number;
    current: number;
    backoffMs: number;
  };
  onFail: 'skip' | 'abort' | 'retry';
  guardrail?: (context: WorkflowContext) => Promise<boolean>;
  guardrailOnRetry?: boolean;
}

export interface StepResult {
  status: 'success' | 'failed' | 'skipped' | 'blocked';
  result?: unknown;
  error?: string;
  guardrailFailed?: string;
}

export interface Workflow {
  id: string;
  steps: WorkflowStep[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  results: Map<string, StepResult>;
}

export interface ImprovementRequest {
  originalPath: string;
  requirements: string;
  context?: string;
}

/**
 * WorkflowEngine executes document processing workflows with retry logic and guardrails
 * Implements the execution layer of the OpenClaw dual-layer architecture
 */
export class WorkflowEngine {
  private constraintLayer: ConstraintLayer;

  constructor(constraintLayer?: ConstraintLayer) {
    this.constraintLayer = constraintLayer || new ConstraintLayer();
  }

  /**
   * Execute a complete workflow with all steps
   */
  async executeWorkflow(
    steps: WorkflowStep[],
    initialContext?: Partial<WorkflowContext>
  ): Promise<Workflow> {
    const workflow: Workflow = {
      id: `wf-${Date.now()}`,
      steps,
      status: 'running',
      results: new Map()
    };

    const context: WorkflowContext = {
      peers: p2pNetwork.getPeers(),
      logs: [],
      ...initialContext
    };

    for (const step of steps) {
      const result = await this.executeStep(step, context);
      workflow.results.set(step.id, result);

      // Handle blocked or critical failures
      if (result.status === 'blocked') {
        this.constraintLayer.log(
          `Workflow blocked at step ${step.id}`,
          { guardrailFailed: result.guardrailFailed },
          'blocked'
        );
        workflow.status = 'failed';
        return workflow;
      }

      if (result.status === 'failed' && step.onFail === 'abort') {
        workflow.status = 'failed';
        return workflow;
      }
    }

    workflow.status = 'completed';
    return workflow;
  }

  /**
   * Execute a single workflow step with retry logic
   */
  async executeStep(step: WorkflowStep, context: WorkflowContext): Promise<StepResult> {
    // Pre-execution guardrail check
    if (step.guardrail) {
      const guardrailPassed = await this.runGuardrail(step, context, true);
      if (!guardrailPassed) {
        this.constraintLayer.log(
          `Pre-check guardrail failed: ${step.guardrail.name}`,
          { stepId: step.id },
          'blocked'
        );
        return { status: 'blocked', guardrailFailed: step.guardrail.name };
      }
    }

    // Execute step with retry logic
    for (let attempt = 0; attempt <= step.retry.max; attempt++) {
      try {
        const result = await this.runStep(step, context);

        // Post-execution guardrail check (unless explicitly disabled for retries)
        if (step.guardrailOnRetry !== false && step.guardrail) {
          const guardrailPassed = await this.runGuardrail(step, context, false);
          if (!guardrailPassed) {
            this.constraintLayer.log(
              `Post-check guardrail failed: ${step.guardrail.name}`,
              { stepId: step.id },
              'blocked'
            );
            return { status: 'blocked', guardrailFailed: step.guardrail.name };
          }
        }

        return { status: 'success', result };
      } catch (error) {
        if (attempt === step.retry.max) {
          this.constraintLayer.log(
            `Step ${step.id} failed after ${attempt + 1} attempts`,
            { error: String(error) },
            'failed'
          );
          return {
            status: step.onFail === 'skip' ? 'skipped' : 'failed',
            error: String(error)
          };
        }

        // Exponential backoff
        const backoffMs = step.retry.backoffMs * Math.pow(2, attempt);
        this.constraintLayer.log(
          `Step ${step.id} attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`,
          {},
          'warn'
        );
        await this.sleep(backoffMs);
      }
    }

    return { status: 'failed', error: 'Max retries exceeded' };
  }

  /**
   * Run the actual step logic
   */
  private async runStep(step: WorkflowStep, context: WorkflowContext): Promise<unknown> {
    switch (step.type) {
      case 'read': {
        const path = step.config?.path;
        if (!path) throw new Error('Read step requires path config');
        const content = await documentReader.read(path);
        context.document = content;
        return content;
      }

      case 'chunk': {
        if (!context.document) throw new Error('No document loaded');
        const maxSize = step.config?.maxChunkSize || 4000;
        return documentReader.chunk(context.document.text, maxSize);
      }

      case 'summarize': {
        if (!context.document) throw new Error('No document loaded');
        if (!this.isMinimaxAvailable()) {
          throw new Error('Minimax LLM not available');
        }
        
        const llm = getMinimax();
        const chunks = documentReader.chunk(
          context.document.text,
          step.config?.maxChunkSize || 4000
        );
        const summaries: string[] = [];
        let totalQuality = 0;

        for (const chunk of chunks) {
          const result = await llm.summarize(chunk, step.config?.context);
          summaries.push(result.summary);
          totalQuality += result.qualityScore;
        }

        context.summary = summaries.join('\n\n');
        context.qualityScore = totalQuality / chunks.length;
        return { summary: context.summary, qualityScore: context.qualityScore };
      }

      case 'improve': {
        if (!context.document) throw new Error('No document loaded');
        if (!this.isMinimaxAvailable()) {
          throw new Error('Minimax LLM not available');
        }

        const llm = getMinimax();
        const improved = await llm.improveContent(
          context.document.text,
          step.config?.requirements || '',
          step.config?.context
        );
        context.improved = improved;
        return { improved };
      }

      case 'review': {
        return {
          status: 'reviewed',
          qualityScore: context.qualityScore,
          hasDocument: !!context.document,
          hasSummary: !!context.summary
        };
      }

      case 'send': {
        const peerId = step.config?.peerId;
        const message = step.config?.message || context.summary || '';
        if (!peerId) throw new Error('Send step requires peerId config');

        // Check constraint layer for unknown peer
        const checkResult = await this.constraintLayer.checkGuardrails(context, step);
        if (!checkResult.passed) {
          throw new Error(`Guardrail blocked: ${checkResult.blocked?.name}`);
        }

        await p2pNetwork.sendMessage(peerId, 'message', message);
        this.constraintLayer.log(
          `Sent message to ${peerId}`,
          { peerId, messageLength: message.length },
          'success'
        );
        return { sent: true, peerId };
      }

      case 'report': {
        const content = step.config?.content || context.summary || '';
        await p2pNetwork.broadcast('report', content);
        this.constraintLayer.log(
          'Broadcast report',
          { contentLength: content.length },
          'success'
        );
        return { broadcasted: true };
      }

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  /**
   * Run a guardrail check with error handling
   */
  private async runGuardrail(
    step: WorkflowStep,
    context: WorkflowContext,
    isPreCheck: boolean
  ): Promise<boolean> {
    if (!step.guardrail) return true;
    try {
      return await step.guardrail(context);
    } catch (error) {
      this.constraintLayer.log(
        `Guardrail ${step.guardrail.name} error`,
        { error: String(error), isPreCheck },
        'failed'
      );
      return false;
    }
  }

  /**
   * Check if Minimax LLM is available
   */
  private isMinimaxAvailable(): boolean {
    try {
      getMinimax();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sleep utility for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get the constraint layer instance
   */
  getConstraintLayer(): ConstraintLayer {
    return this.constraintLayer;
  }

  /**
   * Set a custom constraint layer
   */
  setConstraintLayer(layer: ConstraintLayer): void {
    this.constraintLayer = layer;
  }
}