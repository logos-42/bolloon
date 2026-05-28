/**
 * WorkflowPivotLoop - Robust Agent Loop with Adaptive Iteration Control
 * 
 * Based on the architecture pattern:
 * 1. Loop interrupted by max iterations
 * 2. Model decides via pending_tool_uses (empty = normal completion)
 * 3. Conditional routing based on tool call presence
 * 
 * Key improvements over simple ReAct:
 * - Dynamic loop length based on task complexity
 * - Multi-dimensional exit conditions
 * - Consecutive invalid iteration detection
 * - Token budget awareness
 */

import type { Tool, ToolResult, StreamCallback, StreamEvent } from './pi-sdk.js';

export interface PivotLoopConfig {
  maxIterations: number;
  minIterations?: number;
  qualityThreshold?: number;
  maxConsecutiveNoProgress?: number;
  maxTokenBudget?: number;
  complexity?: TaskComplexity;
}

export interface PivotLoopState {
  iteration: number;
  totalTokens: number;
  toolCallsCount: number;
  consecutiveNoProgress: number;
  qualityScores: number[];
  pendingToolUses: ToolDefinition[];
  lastMeaningfulWork: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, string>;
}

export interface LoopResult {
  success: boolean;
  response: string;
  iterations: number;
  toolCalls: number;
  qualityScore: number;
  exitReason: ExitReason;
  state: PivotLoopState;
}

export type ExitReason = 
  | 'max_iterations'
  | 'no_pending_tools'
  | 'quality_threshold_met'
  | 'no_progress_exhausted'
  | 'token_budget_exceeded'
  | 'min_iterations_not_met'
  | 'error';

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface TaskProfile {
  complexity: TaskComplexity;
  estimatedSteps: number;
  suggestedMaxIterations: number;
  tokenBudget: number;
}

/**
 * Analyze input to determine task complexity
 */
function analyzeTaskComplexity(input: string): TaskProfile {
  const inputLower = input.toLowerCase();
  const inputLength = input.length;
  
  // Simple task indicators
  const simpleIndicators = [
    '读取', '查看', '显示', '列出', '获取', 'what is', 'show me',
    'list', 'get', 'show', 'read', 'view', 'display'
  ];
  
  // Complex task indicators  
  const complexIndicators = [
    '分析', '比较', '改进', '优化', '重构', '实现', '设计', '创建',
    'analyze', 'compare', 'improve', 'optimize', 'refactor', 'implement',
    'design', 'create', 'build', 'develop'
  ];
  
  // Question patterns suggest moderate complexity
  const questionPatterns = [
    '如何', '怎么', '为什么', '什么', 'which', 'how', 'why', 'what', '?'
  ];
  
  const simpleCount = simpleIndicators.filter(i => inputLower.includes(i)).length;
  const complexCount = complexIndicators.filter(i => inputLower.includes(i)).length;
  const questionCount = questionPatterns.filter(p => inputLower.includes(p)).length;
  
  let complexity: TaskComplexity;
  let estimatedSteps: number;
  
  if (complexCount > simpleCount && complexCount > 1) {
    complexity = 'complex';
    estimatedSteps = 5 + complexCount * 2;
  } else if (questionCount > 2 || (simpleCount > 0 && complexCount > 0)) {
    complexity = 'moderate';
    estimatedSteps = 3 + questionCount;
  } else if (inputLength < 50 && simpleCount > 0) {
    complexity = 'simple';
    estimatedSteps = 1 + simpleCount;
  } else if (complexCount > 0) {
    complexity = 'complex';
    estimatedSteps = 4 + complexCount;
  } else {
    complexity = 'moderate';
    estimatedSteps = 3;
  }
  
  // Adjust based on input length (longer inputs often mean more complex tasks)
  if (inputLength > 500 && complexity !== 'complex') {
    complexity = 'moderate';
    estimatedSteps = Math.max(estimatedSteps, 4);
  }
  
  // Suggested max iterations: 2-3x estimated steps for safety margin
  const suggestedMaxIterations = Math.min(Math.max(estimatedSteps * 3, 10), 100);
  const tokenBudget = estimatedSteps * 800; // ~800 tokens per step estimate
  
  return { complexity, estimatedSteps, suggestedMaxIterations, tokenBudget };
}

/**
 * WorkflowPivotLoop - Main loop controller
 */
export class WorkflowPivotLoop {
  private config: Required<PivotLoopConfig>;
  private state: PivotLoopState;
  private tools: Map<string, Tool>;
  private messageHistory: Array<{ role: string; content: string; toolCall?: { name: string; args: Record<string, string> }; toolResult?: ToolResult }>;
  private streamCallback?: StreamCallback;
  
  constructor(config: PivotLoopConfig) {
    this.tools = new Map();
    
    // Default configuration based on task complexity if not provided
    const defaults: Required<PivotLoopConfig> = {
      maxIterations: config.maxIterations || 50,
      minIterations: config.minIterations || 2,
      qualityThreshold: config.qualityThreshold || 0.7,
      maxConsecutiveNoProgress: config.maxConsecutiveNoProgress || 5,
      maxTokenBudget: config.maxTokenBudget || 50000,
      complexity: config.complexity || 'moderate'
    };
    
    this.config = defaults;
    
    this.state = this.createInitialState();
    this.messageHistory = [];
  }
  
  private createInitialState(): PivotLoopState {
    return {
      iteration: 0,
      totalTokens: 0,
      toolCallsCount: 0,
      consecutiveNoProgress: 0,
      qualityScores: [],
      pendingToolUses: [],
      lastMeaningfulWork: 0
    };
  }
  
  /**
   * Register a tool for use in the loop
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }
  
  /**
   * Register multiple tools at once
   */
  registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }
  
  /**
   * Execute the pivot loop
   */
  async execute(
    input: string,
    llm: LLMInterface,
    systemPrompt: string,
    streamCallback?: StreamCallback
  ): Promise<LoopResult> {
    this.streamCallback = streamCallback;
    this.state = this.createInitialState();
    this.messageHistory = [{ role: 'user', content: input }];
    
    // Analyze task complexity and adapt config
    const taskProfile = analyzeTaskComplexity(input);
    const effectiveConfig = this.adaptConfigForTask(taskProfile);
    
    this.emit({
      type: 'status',
      content: `🔍 任务复杂度: ${taskProfile.complexity} (预估 ${taskProfile.estimatedSteps} 步)`,
      tool: 'system'
    });
    
    this.emit({
      type: 'status',
      content: `⚙️ 动态配置: maxIterations=${effectiveConfig.maxIterations}, tokenBudget=${effectiveConfig.maxTokenBudget}`,
      tool: 'system'
    });
    
    let response = '';
    
    while (this.shouldContinue(effectiveConfig)) {
      this.state.iteration++;
      
      this.emit({
        type: 'status',
        content: `🔄 循环 ${this.state.iteration}/${effectiveConfig.maxIterations}`,
        tool: 'loop'
      });
      
      // Build context for LLM
      const context = this.buildContext();
      const fullPrompt = `${systemPrompt}\n\n${context}`;
      
      try {
        // Call LLM
        const llmResponse = await llm.chat(context, systemPrompt);
        const reply = llmResponse.reply.trim();
        
        this.emit({ type: 'token', content: reply.substring(0, 100) });
        
        // Estimate token usage
        this.state.totalTokens += this.estimateTokens(fullPrompt) + this.estimateTokens(reply);
        
        // Check token budget
        if (this.state.totalTokens > effectiveConfig.maxTokenBudget) {
          this.emit({
            type: 'error',
            content: '⚠️ Token 预算超支，中断循环'
          });
          return this.createResult(false, response, 'token_budget_exceeded');
        }
        
        // Check if this is a final response (no tool calls)
        const pendingTools = this.extractPendingToolUses(reply);
        
        if (pendingTools.length === 0) {
          // No pending tool uses - this is a normal completion
          this.state.pendingToolUses = [];
          
          // Evaluate quality before accepting
          const quality = this.evaluateQuality(reply);
          this.state.qualityScores.push(quality);
          
          this.emit({
            type: 'status',
            content: `✅ 检测到最终回复 (质量: ${(quality * 10).toFixed(1)}/10)`,
            tool: 'system'
          });
          
          // Check if quality threshold met
          if (quality >= effectiveConfig.qualityThreshold) {
            response = reply;
            return this.createResult(true, reply, 'quality_threshold_met');
          }
          
          // Quality not met but no more tools to call
          // Accept response if we've done minimum iterations
          if (this.state.iteration >= effectiveConfig.minIterations) {
            response = reply;
            return this.createResult(true, reply, 'no_pending_tools');
          }
          
          // Too early, continue to see if we can improve
          this.state.consecutiveNoProgress++;
          this.emit({
            type: 'status',
            content: `📊 质量未达标 (${(quality * 10).toFixed(1)}/${(effectiveConfig.qualityThreshold * 10).toFixed(1)})，继续循环`,
            tool: 'system'
          });
          continue;
        }
        
        // We have pending tool uses - execute them
        this.state.pendingToolUses = pendingTools;
        this.state.lastMeaningfulWork = this.state.iteration;
        this.state.consecutiveNoProgress = 0;
        
        for (const toolCall of pendingTools) {
          this.state.toolCallsCount++;
          
          const tool = this.tools.get(toolCall.name);
          if (!tool) {
            this.emit({
              type: 'error',
              content: `❌ 未知工具: ${toolCall.name}`
            });
            this.messageHistory.push({
              role: 'tool',
              content: JSON.stringify({ success: false, error: `Unknown tool: ${toolCall.name}` })
            });
            continue;
          }
          
          this.emit({
            type: 'tool',
            content: `🔧 执行: ${toolCall.name}`,
            tool: toolCall.name
          });
          
          try {
            const result = await tool.execute(toolCall.args);
            
            this.emit({
              type: result.success ? 'status' : 'error',
              content: result.success 
                ? `✅ ${toolCall.name} 成功` 
                : `❌ ${toolCall.name} 失败: ${result.error}`
            });
            
            this.messageHistory.push({
              role: 'assistant',
              content: reply,
              toolCall,
              toolResult: result
            });
            
            // Record quality from tool result
            const toolQuality = this.evaluateToolResult(result);
            this.state.qualityScores.push(toolQuality);
            
          } catch (execError) {
            this.emit({
              type: 'error',
              content: `❌ 工具执行异常: ${execError}`
            });
            this.messageHistory.push({
              role: 'tool',
              content: JSON.stringify({ success: false, error: String(execError) })
            });
          }
        }
        
      } catch (error) {
        this.emit({
          type: 'error',
          content: `❌ 循环异常: ${error}`
        });
        return this.createResult(false, response, 'error');
      }
    }
    
    // Loop exited - determine reason
    const exitReason = this.determineExitReason(effectiveConfig);
    
    if (!response && this.messageHistory.length > 0) {
      const lastAssistant = this.messageHistory
        .filter(m => m.role === 'assistant')
        .pop();
      response = lastAssistant?.content || '任务处理超时';
    }
    
    return this.createResult(
      exitReason !== 'error',
      response,
      exitReason
    );
  }
  
  /**
   * Determine if loop should continue
   */
  private shouldContinue(config: Required<PivotLoopConfig>): boolean {
    // Hard stop: max iterations reached
    if (this.state.iteration >= config.maxIterations) {
      this.emit({
        type: 'status',
        content: `🛑 达到最大迭代次数 ${config.maxIterations}`
      });
      return false;
    }
    
    // Soft stop: consecutive no progress
    if (this.state.consecutiveNoProgress >= config.maxConsecutiveNoProgress) {
      this.emit({
        type: 'status',
        content: `🛑 连续 ${config.maxConsecutiveNoProgress} 次无进展`
      });
      return false;
    }
    
    return true;
  }
  
  /**
   * Adapt configuration based on task profile
   */
  private adaptConfigForTask(profile: TaskProfile): Required<PivotLoopConfig> {
    return {
      ...this.config,
      maxIterations: Math.min(this.config.maxIterations, profile.suggestedMaxIterations),
      maxTokenBudget: Math.min(this.config.maxTokenBudget, profile.tokenBudget),
      complexity: profile.complexity
    };
  }
  
  /**
   * Extract pending tool uses from LLM response
   */
  private extractPendingToolUses(content: string): Array<{ name: string; args: Record<string, string> }> {
    const pending: Array<{ name: string; args: Record<string, string> }> = [];
    
    // Pattern 1: Chinese format "调用工具: tool_name(args)"
    const pattern1 = /调用工具[：:]\s*(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = pattern1.exec(content)) !== null) {
      const name = match[1];
      const argsStr = match[2];
      const args = this.parseArgs(argsStr);
      if (this.tools.has(name)) {
        pending.push({ name, args });
      }
    }
    
    // Pattern 2: tool_name(args) format
    const pattern2 = /(\w+)\s*\(\s*([^)]*)\s*\)/g;
    while ((match = pattern2.exec(content)) !== null) {
      const name = match[1];
      const argsStr = match[2];
      // Skip if already matched or doesn't look like a tool call
      if (pending.some(p => p.name === name)) continue;
      if (!this.tools.has(name)) continue;
      
      const args = this.parseArgs(argsStr);
      pending.push({ name, args });
    }
    
    // Pattern 3: JSON format tool calls
    try {
      const jsonMatch = content.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            if (this.tools.has(tc.name)) {
              pending.push({ name: tc.name, args: tc.args || {} });
            }
          }
        }
      }
    } catch {
      // JSON parsing failed, ignore
    }
    
    return pending;
  }
  
  /**
   * Parse tool arguments from string
   */
  private parseArgs(argsStr: string): Record<string, string> {
    const args: Record<string, string> = {};
    if (!argsStr || !argsStr.trim()) return args;
    
    const pairs = argsStr.split(',').map(s => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx > 0) {
        const key = pair.substring(0, colonIdx).trim();
        const value = pair.substring(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        args[key] = value;
      } else {
        // No colon, try to parse as positional
        const parts = pair.split(/\s+/);
        if (parts.length >= 2) {
          args[parts[0]] = parts.slice(1).join(' ');
        }
      }
    }
    return args;
  }
  
  /**
   * Build context from message history
   */
  private buildContext(): string {
    return this.messageHistory.map(m => {
      if (m.role === 'user') return `用户: ${m.content}`;
      if (m.role === 'assistant') return `助手: ${m.content}`;
      if (m.role === 'tool' && m.toolResult) {
        return `工具结果: ${JSON.stringify(m.toolResult)}`;
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  
  /**
   * Evaluate response quality
   */
  private evaluateQuality(response: string): number {
    let score = 0.5;
    
    // Length-based scoring
    if (response.length > 100) score += 0.1;
    if (response.length > 500) score += 0.1;
    if (response.length < 30) score -= 0.2;
    
    // Structure indicators
    if (response.includes('\n')) score += 0.05;
    if (response.includes('-') || response.includes('•')) score += 0.05;
    if (response.includes('```')) score += 0.1;
    
    // Content quality indicators
    const conclusionWords = ['完成', '结果', '总结', '所以', '因此', '答案', '推荐', '建议'];
    if (conclusionWords.some(w => response.includes(w))) score += 0.1;
    
    // Negative indicators
    if (response.includes('调用工具') || response.includes('tool(')) score -= 0.15;
    if (response.includes('??') || response.includes('未知')) score -= 0.1;
    
    return Math.max(0, Math.min(1, score));
  }
  
  /**
   * Evaluate tool result quality
   */
  private evaluateToolResult(result: ToolResult): number {
    if (!result.success) return 0.2;
    
    let score = 0.6;
    if (result.output) {
      score += 0.2;
      if (result.output.length > 100) score += 0.1;
      if (result.output.includes('error') || result.output.includes('❌')) score -= 0.2;
      if (result.output.includes('success') || result.output.includes('✅')) score += 0.1;
    }
    if (result.error) score -= 0.3;
    
    return Math.max(0, Math.min(1, score));
  }
  
  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token for Chinese/English mix
    return Math.ceil(text.length / 4);
  }
  
  /**
   * Create result object
   */
  private createResult(success: boolean, response: string, exitReason: ExitReason): LoopResult {
    const avgQuality = this.state.qualityScores.length > 0
      ? this.state.qualityScores.reduce((a, b) => a + b, 0) / this.state.qualityScores.length
      : 0;
    
    return {
      success,
      response,
      iterations: this.state.iteration,
      toolCalls: this.state.toolCallsCount,
      qualityScore: avgQuality,
      exitReason,
      state: { ...this.state }
    };
  }
  
  /**
   * Determine why loop exited
   */
  private determineExitReason(config: Required<PivotLoopConfig>): ExitReason {
    if (this.state.iteration >= config.maxIterations) {
      return 'max_iterations';
    }
    if (this.state.consecutiveNoProgress >= config.maxConsecutiveNoProgress) {
      return 'no_progress_exhausted';
    }
    if (this.state.pendingToolUses.length === 0 && this.state.iteration >= config.minIterations) {
      return 'no_pending_tools';
    }
    if (this.state.totalTokens > config.maxTokenBudget) {
      return 'token_budget_exceeded';
    }
    return 'max_iterations';
  }
  
  /**
   * Emit stream event
   */
  private emit(event: StreamEvent): void {
    if (this.streamCallback) {
      this.streamCallback(event);
    }
  }
  
  /**
   * Get current state
   */
  getState(): PivotLoopState {
    return { ...this.state };
  }
  
  /**
   * Reset the loop state
   */
  reset(): void {
    this.state = this.createInitialState();
    this.messageHistory = [];
  }
}

/**
 * Interface for LLM chat capability
 */
export interface LLMInterface {
  chat(context: string, systemPrompt: string): Promise<{ reply: string; tokens?: number }>;
}

/**
 * Factory to create a default pivot loop configuration
 */
export function createDefaultPivotConfig(complexity?: TaskComplexity): PivotLoopConfig {
  const profiles: Record<TaskComplexity, PivotLoopConfig> = {
    simple: {
      maxIterations: 15,
      minIterations: 1,
      qualityThreshold: 0.6,
      maxConsecutiveNoProgress: 3,
      maxTokenBudget: 10000
    },
    moderate: {
      maxIterations: 30,
      minIterations: 2,
      qualityThreshold: 0.7,
      maxConsecutiveNoProgress: 5,
      maxTokenBudget: 30000
    },
    complex: {
      maxIterations: 60,
      minIterations: 3,
      qualityThreshold: 0.75,
      maxConsecutiveNoProgress: 8,
      maxTokenBudget: 60000
    }
  };
  
  return complexity ? profiles[complexity] : profiles.moderate;
}

/**
 * Helper to run a simple prompt through the loop
 */
export async function runPivotLoop(
  input: string,
  llm: LLMInterface,
  tools: Tool[],
  systemPrompt: string,
  config?: PivotLoopConfig,
  streamCallback?: StreamCallback
): Promise<LoopResult> {
  const loop = new WorkflowPivotLoop(config || createDefaultPivotConfig());
  loop.registerTools(tools);
  return loop.execute(input, llm, systemPrompt, streamCallback);
}
