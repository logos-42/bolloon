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
  args?: Record<string, string>;
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
  | 'final_gen_marker'
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
  private messageHistory: Array<{ role: string; content: string; toolCall?: ToolDefinition; toolResult?: ToolResult }>;
  private streamCallback?: StreamCallback;
  // 2026-07-06: pivot 想看内部明细设 BOLLOON_VERBOSE=1 — 默认只保留 status 事件给 UI
  private verbose = typeof process !== 'undefined' && process.env?.BOLLOON_VERBOSE === '1';
  private vlog(msg: string) { if (this.verbose) console.log(msg); }
  private onApproachingTokenBudget?: () => Promise<void>;
  private compactedThisRun = false;  // 防止 pivot 单次 execute 反复触发 compact
  // 2026-07-06: iter ≥ 2 时用简短 systemHeader 替代完整 systemPrompt
  //   pivot 默认 moderate profile 是 30 iter, 每次调 llm 都重复装 11K persona+tools 装 + 25 layer
  //   (pi-ai.ts buildSystemPromptAsync 重复读 .md) — 真没必要. 第一轮装全, 后续用锚句占位.
  //   compactor 触发后 (旧 systemHeader 代表性弱化) 再重新装一次全量.
  private continuationSystemHeader: string | null = null;
  
  constructor(config: PivotLoopConfig) {
    this.tools = new Map();
    
    // Default configuration based on task complexity if not provided
    const defaults: Required<PivotLoopConfig> = {
      maxIterations: config.maxIterations || 1000,  // 2026-07-06: 持久循环 (旧 50)
      minIterations: config.minIterations || 2,
      qualityThreshold: config.qualityThreshold || 0.7,
      maxConsecutiveNoProgress: config.maxConsecutiveNoProgress || 8,
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
   * 2026-08-02: 把 this.tools Map 转成 OpenAI 原生 tools 格式 (含参数 schema).
   *   pivot loop 之前只把工具描述塞 system prompt, LLM 靠文本 JSON 猜格式
   *   (deepseek 输出 {"name":"X","result":{...}} 编造结果), 从不真正执行工具.
   *   传原生 tools + tool_choice auto → LLM 返回结构化 tool_calls.
   */
  private buildOpenAITools(): any[] {
    const out: any[] = [];
    for (const [name, tool] of this.tools) {
      const params = (tool as any).parameters || {};
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [pName, pDesc] of Object.entries(params)) {
        properties[pName] = { type: 'string', description: String(pDesc) };
        if (String(pDesc).includes('必填')) required.push(pName);
      }
      out.push({
        type: 'function',
        function: {
          name,
          description: (tool as any).description || name,
          parameters: { type: 'object', properties, required },
        },
      });
    }
    return out;
  }

  /**
   * 2026-08-02: 把 OpenAI 原生 tool_calls (结构化) 转成 ToolDefinition 数组.
   *   优先于文本 JSON 解析 — LLM 返回 tool_calls 时直接执行, 不再猜格式.
   */
  private nativeToolCallsToDefinitions(toolCalls: any[]): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const tc of toolCalls || []) {
      const fn = tc?.function;
      if (!fn || !fn.name) continue;
      const name = fn.name;
      if (!this.tools.has(name)) continue;
      let args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(fn.arguments || '{}');
        if (parsed && typeof parsed === 'object') args = parsed;
      } catch { /* args 保持空 */ }
      out.push({ name, args: this.normalizeArgs(args), description: '', parameters: {} });
    }
    return out;
  }
  
  /**
   * Execute the pivot loop
   */
  async execute(
    input: string,
    llm: LLMInterface,
    systemPrompt: string,
    streamCallback?: StreamCallback,
    signal?: AbortSignal,
    /**
     * 2026-07-06: token 预算接近上限时回调 — 让上层 (PiAgentSession) 跑 compactor
     *   否者单纯报 "Token 预算超支" 直接 break, 用户消息丢失.
     *   回调同步返回值 (newMessageHistory) 时替换 this.messageHistory 后继续.
     *   异步: PiAgent 触发 compactPipeline, 这里 await 等折叠完再继续.
     */
    onApproachingTokenBudget?: () => Promise<void>,
  ): Promise<LoopResult> {
    this.streamCallback = streamCallback;
    this.state = this.createInitialState();
    this.onApproachingTokenBudget = onApproachingTokenBudget;
    // 2026-07-06: 准备短 systemHeader. iter ≥ 2 用它替代完整 systemPrompt
    //   LLM 已经在 messageHistory 里看到全部历史, 不需要每次重装. compact 触发后下次再装全量.
    this.continuationSystemHeader = this.buildContinuationHeader(systemPrompt);
    // 重置 compact 状态 — 这次 execute 第一次 iter 仍用全量
    this.compactedThisRun = false;
    this.vlog(`[pivot] execute: input chars=${input.length}, systemPrompt chars=${systemPrompt.length}, signal=${!!signal}, continuationHeader chars=${this.continuationSystemHeader?.length ?? 0}`);
    this.messageHistory = [{ role: 'user', content: input }];
    
    // Analyze task complexity and adapt config
    const taskProfile = analyzeTaskComplexity(input);
    const effectiveConfig = this.adaptConfigForTask(taskProfile);
    // 2026-06-18 (supervisor): taskProfile 算的 tokenBudget 只看 input 长度, 但 systemPrompt 53K 时不够
    // 把 effectiveConfig.maxTokenBudget 提到 systemPrompt * 1.2 留余量, 简单问题也走完
    // 2026-07-06: 但累计 totalTokens = systemPrompt + sum(replies), 每 iter LLM 反 ~3-10K
    //   旧公式 budget=11K*1.2=13K, 5 iter 累计 5 × 11K + replies = ~70K → 12-13K 处直接 break.
    //   修法: budget = systemPrompt × 1.2 × maxIterations, 容纳 N 次 prompt + N-1 次 reply.
    effectiveConfig.maxTokenBudget = Math.max(
      effectiveConfig.maxTokenBudget,
      Math.ceil(systemPrompt.length * 1.2 * effectiveConfig.maxIterations),
    );

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
      // 2026-07-04: signal abort 让 pivot 提前退出 (防止 LLM hang)
      if (signal?.aborted) {
        this.emit({
          type: 'status',
          content: `⏹️ pivot loop 被 abort (iter=${this.state.iteration})`,
          tool: 'loop'
        });
        break;
      }
      this.state.iteration++;

      this.emit({
        type: 'status',
        content: `🔄 循环 ${this.state.iteration}/${effectiveConfig.maxIterations}`,
        tool: 'loop'
      });

      // Build context for LLM
      const context = this.buildContext();
      const fullPrompt = `${systemPrompt}\n\n${context}`;
      // 2026-07-06: iter ≥ 2 改用 continuationHeader — messageHistory 已经载过全 persona/tools,
      //   重装 11K + 25 layer 是浪费, 同时让 pi-ai.chat 走 < 2000 分支 (不重新装 system prompt).
      //   compact 触发 → 这次 iter 之后下一 iter 恢复用 full.
      let headerForThisIter = systemPrompt;
      let usingContinuation = false;
      const shouldUseContinuation = this.state.iteration >= 2 && !this.compactedThisRun && this.continuationSystemHeader;
      if (shouldUseContinuation) {
        headerForThisIter = this.continuationSystemHeader!;
        usingContinuation = true;
      }
      this.vlog(`[pivot] iter=${this.state.iteration} ctx=${context.length} fullPrompt=${fullPrompt.length} budget=${effectiveConfig.maxTokenBudget} iterHeader=${usingContinuation ? 'short' : 'full'} (${headerForThisIter.length}B)`);

      try {
        // Call LLM
        const t0 = Date.now();
        // 2026-08-02: 传原生 OpenAI tools — deepseek 返回结构化 tool_calls,
        //   UI 才能显示真实的工具执行 step (之前靠文本 JSON 猜格式, LLM 编造 result)
        const openAITools = this.buildOpenAITools();
        const llmResponse = await llm.chat(context, headerForThisIter, signal, openAITools);
        const reply = (llmResponse.reply || '').trim();
        this.vlog(`[pivot] iter=${this.state.iteration} LLM took=${Date.now() - t0}ms reply=${reply.length} nativeToolCalls=${llmResponse.toolCalls?.length ?? 0} head=${reply.substring(0, 80).replace(/\n/g, ' ')}`);

        this.emit({ type: 'token', content: reply.substring(0, 100) });
        // 2026-07-06: 把完整 reply 推给前端 — 前端按需更新临时气泡
        //   之前只 emit token(100B 截断), 前端拿到 100B 看不清. 现在 emit preview 带完整 content.
        //   折叠 / 清洗交给前端的 message-renderer.addMessage (类型 ai 入口统一 strip).
        this.emit({ type: 'reply-preview', content: reply, iteration: this.state.iteration } as any);

        // Estimate token usage
        this.state.totalTokens += this.estimateTokens(headerForThisIter + '\n\n' + context) + this.estimateTokens(reply);
        
        // 2026-07-06: token 接近预算时先尝试自动压缩, 而不是直接 break — 上层 PiAgentSession
        //   通过 onApproachingTokenBudget 回调触发 compactPipeline (5 层短路)
        const budgetRatio = this.state.totalTokens / effectiveConfig.maxTokenBudget;
        if (budgetRatio > 0.7 && this.onApproachingTokenBudget && !this.compactedThisRun && this.messageHistory.length >= 6) {
          this.compactedThisRun = true;
          this.emit({
            type: 'status',
            content: `🗜️ token ${this.state.totalTokens} 接近预算 (${(budgetRatio * 100).toFixed(0)}%), 尝试自动压缩上下文`,
            tool: 'compactor',
          });
          try {
            await this.onApproachingTokenBudget();
            // 重置 totalTokens 因为 compactor 折叠后本来就不准
            this.state.totalTokens = Math.ceil(systemPrompt.length * 0.5); // 粗略剩余量
            this.emit({
              type: 'status',
              content: `🗜️ 自动压缩完成, 继续循环 (剩余估算 ${this.state.totalTokens} chars)`,
              tool: 'compactor',
            });
            // 继续 loop, 不 break
            continue;
          } catch (err) {
            console.warn('[pivot] onApproachingTokenBudget failed (non-fatal, 继续走 token 阈值):', String((err as any)?.message || err).slice(0, 100));
            // compact 失败 → 回到原 check
          }
        }

        // Check token budget
        if (this.state.totalTokens > effectiveConfig.maxTokenBudget) {
          this.emit({
            type: 'error',
            content: '⚠️ Token 预算超支，中断循环'
          });
          return this.createResult(false, response, 'token_budget_exceeded');
        }
        
        // Check if this is a final response (no tool calls)
        // 2026-08-02: 优先用 OpenAI 原生 tool_calls (结构化, LLM 不会编造 result),
        //   没有才 fallback 到文本 JSON 解析 (extractPendingToolUses)
        const nativeTools = this.nativeToolCallsToDefinitions(llmResponse.toolCalls || []);
        const pendingTools = nativeTools.length > 0 ? nativeTools : this.extractPendingToolUses(reply);

        if (pendingTools.length === 0) {
          // 2026-07-06: LLM 显式 <final gen> 标记 — pivot 立即退出, 不再走 quality/iter 流程
          //   这个 marker 之前和 思考/ 同义被忽略, 害得 "你好" 类问题跑 11 iter 还不见停
          //   加上之后 iter=1 收到 <final gen> 就 accept
          if (/<final\s+gen\s*\/?>|<\/final\s+gen>/i.test(reply)) {
            const cleaned = reply.replace(/<final\s+gen\s*\/?>|<\/final\s+gen>/gi, '').trim();
            response = cleaned || reply;
            this.emit({
              type: 'status',
              content: `✅ 检测到 <final gen> 结束标记, 立即退出 (iter=${this.state.iteration})`,
              tool: 'system',
            });
            return this.createResult(true, response, 'final_gen_marker');
          }

          // Check if the reply contains tool call intent but couldn't be parsed
          // 2026-07-06: 排除合法的 思考/<final gen> 这些 tag (它们是 sentinel 不是 tool call)
          const cleanedForIntentCheck = reply
            .replace(/<final\s+gen\s*\/?>|<\/final\s+gen>/gi, '')
            .replace(/<\/?think(?:ing)?>/gi, ''); // 移除
          const containsToolCallIntent = cleanedForIntentCheck.includes('调用工具') || cleanedForIntentCheck.includes('tool(') ||
            cleanedForIntentCheck.includes('使用工具') || cleanedForIntentCheck.includes('需要获取') || cleanedForIntentCheck.includes('需要查看') ||
            cleanedForIntentCheck.includes('tool =>') || cleanedForIntentCheck.includes('[TOOL_CALL]') ||
            // 仅匹配真工具调用 tag (tool_use / function_calls / tool_call / invoke / tool_code)
            /<\s*(tool_use|tool_call|function_calls?|tool_code|invoke)\s*>/i.test(cleanedForIntentCheck);

          // If there's tool call intent but no parsed tools, continue the loop
          if (containsToolCallIntent && this.state.iteration < effectiveConfig.maxIterations) {
            this.emit({
              type: 'status',
              content: `🔄 检测到工具调用意图但格式无法解析，继续循环...`,
              tool: 'system'
            });
            this.state.consecutiveNoProgress++;
            continue;
          }

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
            // 2026-06-15: step-timeline — 未知工具也开/关一个 step 节点
            this.emit({
              type: 'step_start',
              content: `未知工具 ${toolCall.name}`,
              tool: toolCall.name,
              args: toolCall.args || {},
            });
            this.emit({
              type: 'step_error',
              content: `未知工具 ${toolCall.name}`,
              tool: toolCall.name,
              error: 'Unknown tool',
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
          // 2026-06-15: step-timeline — 开节点
          this.emit({
            type: 'step_start',
            content: `调用 ${toolCall.name}`,
            tool: toolCall.name,
            args: toolCall.args || {},
          });

          try {
            const result = await tool.execute(toolCall.args ?? {});

            // 2026-06-15: step-timeline — 关闭节点 (success / error)
            this.emit({
              type: result.success ? 'step_done' : 'step_error',
              content: result.success
                ? `${toolCall.name} 成功`
                : `${toolCall.name} 失败: ${result.error}`,
              tool: toolCall.name,
              success: result.success,
              output: result.output,
              error: result.error,
            });
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
  private extractPendingToolUses(content: string): ToolDefinition[] {
    const pending: ToolDefinition[] = [];

    // Pattern 0: <tool_use>{...JSON...}</tool_use> (Anthropic 风格 + minimax 也用)
    // 这次 LLM 输出: <tool_use>\n{"name": "read_document", "arguments": {"path": "/Users/.../README.md"}}\n</tool_use>
    const toolUseRe = /<tool_use>\s*(\{[\s\S]*?\})\s*<\/tool_use>/g;
    let match;
    while ((match = toolUseRe.exec(content)) !== null) {
      try {
        const obj = JSON.parse(match[1]);
        if (obj && obj.name && this.tools.has(obj.name)) {
          const args = this.normalizeArgs(obj.arguments || {});
          pending.push({ name: obj.name, args, description: '', parameters: {} });
        }
      } catch (e) {
        // JSON 解析失败, 继续下一 match
      }
    }

    // Pattern 0b: <function_calls><invoke name="X"><parameter name="k">v</parameter>...</invoke></function_calls>
    //   这次 minimax LLM 用这种 Anthropic 风格 XML
    const fnCallsRe = /<function_calls>([\s\S]*?)<\/function_calls>/g;
    while ((match = fnCallsRe.exec(content)) !== null) {
      const block = match[1];
      // 抓 <invoke name="X">...</invoke>
      const invokeRe = /<invoke\s+name="(\w+)"\s*>([\s\S]*?)<\/invoke>/g;
      let im;
      while ((im = invokeRe.exec(block)) !== null) {
        const name = im[1];
        if (!this.tools.has(name)) continue;
        // 抓 <parameter name="k">v</parameter> 列表
        const args: Record<string, string> = {};
        const paramRe = /<parameter\s+name="(\w+)"\s*>([\s\S]*?)<\/parameter>/g;
        let pm;
        while ((pm = paramRe.exec(im[2])) !== null) {
          args[pm[1]] = pm[2].trim().replace(/^["']|['"]$/g, '');
        }
        // 避免重复添加
        if (!pending.some(p => p.name === name)) {
          pending.push({ name, args, description: '', parameters: {} });
        }
      }
    }

    // 2026-06-18 (supervisor): Claude Code 风格 <tool_call><tool_name>...</tool_call>
    //   bolloon agent 之前一直被 model 教用这个格式, 但 pivot loop 只认 3 个旧 pattern.
    //   现在加: <tool_call><invoke name="X"><parameter name="k">v</parameter></invoke></tool_call>
    const toolCodeRe = /<tool_code>([\s\S]*?)<\/tool_code>/g;
    while ((match = toolCodeRe.exec(content)) !== null) {
      const block = match[1];
      const invokeRe = /<invoke\s+name="(\w+)"\s*>([\s\S]*?)<\/invoke>/g;
      let im;
      while ((im = invokeRe.exec(block)) !== null) {
        const name = im[1];
        if (!this.tools.has(name)) continue;
        const args: Record<string, string> = {};
        const paramRe = /<parameter\s+name="(\w+)"\s*>([\s\S]*?)<\/parameter>/g;
        let pm;
        while ((pm = paramRe.exec(im[2])) !== null) {
          args[pm[1]] = pm[2].trim().replace(/^["']|['"]$/g, '');
        }
        if (!pending.some(p => p.name === name)) {
          pending.push({ name, args, description: '', parameters: {} });
        }
      }
    }

    // Pattern 1: Chinese format "调用工具: tool_name(args)"
    const pattern1 = /调用工具[：:]\s*(\w+)\s*\(([^)]*)\)/g;
    while ((match = pattern1.exec(content)) !== null) {
      const name = match[1];
      const argsStr = match[2];
      const args = this.parseArgs(argsStr);
      if (this.tools.has(name)) {
        pending.push({ name, args, description: '', parameters: {} });
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
      pending.push({ name, args, description: '', parameters: {} });
    }

    // Pattern 3: JSON format tool calls
    try {
      const jsonMatch = content.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            if (this.tools.has(tc.name)) {
              pending.push({ name: tc.name, args: tc.args || {}, description: '', parameters: {} });
            }
          }
        }
      }
    } catch {
      // JSON parsing failed, ignore
    }

    // Pattern 4: Single JSON tool call format {"name": "tool_name", "arguments": {...}}
    // 2026-08-02 fix: 兼容 system prompt 教的 {"name":"X","input":{...}} 格式 —
    //   pi-sdk.ts 工具调用格式说明用 input 字段, 但解析器只认 arguments,
    //   导致 LLM 输出 {"name":"read_document","input":{...}} 解析不到 → 工具永不执行。
    const singleJsonRe = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"(?:arguments|input)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    let singleMatch;
    while ((singleMatch = singleJsonRe.exec(content)) !== null) {
      const name = singleMatch[1];
      if (pending.some(p => p.name === name)) continue;
      if (!this.tools.has(name)) continue;

      try {
        const args = JSON.parse(singleMatch[2]);
        if (args && typeof args === 'object') {
          const normalizedArgs = this.normalizeArgs(args);
          pending.push({ name, args: normalizedArgs, description: '', parameters: {} });
        }
      } catch {
        // JSON parsing failed, skip
      }
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
      // 2026-06-15: LLM 实际输出 3 种格式 — 全支持
      //   1) JSON 风格: {"key":"value"}     (服务器日志显示, 但 LLM 不会真输出完整 JSON)
      //   2) key="value" 含双引号         (本次 read_document(path="/Users/..."))
      //   3) key='value' 含单引号
      //   4) key:value                    (老 Chinese 格式)
      //   5) key value                    (positional 兜底)
      let m = pair.match(/^["']?([\w-]+)["']?\s*=\s*["']([^"']*)["']$/);
      if (m) { args[m[1]] = m[2]; continue; }
      m = pair.match(/^["']?([\w-]+)["']?\s*[:=]\s*([^,]+)$/);
      if (m) { args[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ''); continue; }
      m = pair.match(/^["']?([\w-]+)["']?\s*[:]\s*["']?([^"']*)["']?$/);
      if (m) { args[m[1]] = m[2].trim(); continue; }
      // positional 兜底
      const parts = pair.split(/\s+/);
      if (parts.length >= 2) {
        args[parts[0]] = parts.slice(1).join(' ');
      }
    }
    return args;
  }
  
  /**
   * 把 tool_use JSON 里的 arguments (已经是对象) 转成 Record<string, string>
   *   JSON parser 直接给对象, 但 tool.execute 期望 Record<string, string>
   *   非字符串值 JSON.stringify 一下
   */
  private normalizeArgs(args: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (v == null) continue;
      if (typeof v === 'string') out[k] = v;
      else out[k] = JSON.stringify(v);
    }
    return out;
  }

  /**
   * Build context from message history
   */
  private buildContext(): string {
    return this.messageHistory.map(m => {
      if (m.role === 'user') return `用户: ${m.content}`;
      if (m.role === 'assistant' && m.toolCall && m.toolResult) {
        // 2026-08-02 fix: 工具调用后的 assistant 消息带 toolCall/toolResult,
        //   之前只输出 content (原生 tool_calls 时 content 为空) → LLM 永远看不到结果 → 无限重试同一工具
        return `工具调用: ${m.toolCall.name}(${JSON.stringify(m.toolCall.args)})\n工具结果: ${JSON.stringify(m.toolResult)}`;
      }
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
    let score = 0.7; // 2026-07-06: 起点 0.7 — 短回复不应被当成低质量打回去重跑

    // Length bonus
    if (response.length > 100) score += 0.05;
    if (response.length > 500) score += 0.1;

    // Structure
    if (response.includes('\n')) score += 0.05;
    if (response.includes('```')) score += 0.1;

    // Conclusion language
    const conclusionWords = ['完成', '总结', '所以', '因此', '答案', '推荐', '建议'];
    if (conclusionWords.some(w => response.includes(w))) score += 0.05;

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
   * 2026-07-06: build continuation header — iter ≥ 2 的短 system 头部
   *   LLM 已在 messageHistory 里, 不需要每次 11K persona+tools 重装.
   *   短头告诉 LLM: "你已经看过首轮; 继续 conversation, 详情见历史".
   */
  private buildContinuationHeader(fullSystemPrompt: string): string {
    // 从 fullSystemPrompt 提取关键锚句: identity persona 第 1 行 + 工作模式 head 段
    //   完整重装只在 iter=1 和 compact 之后两次
    const lines = fullSystemPrompt.split('\n');
    const identityLine = lines.find((l) => l.includes('你是') && !l.includes('(续)') ) ?? '';
    return `[continuation] 你的 persona + tools + judgments 已在首轮 messageHistory 中.
${identityLine ? identityLine + '\n' : ''}当前 step 别再读 persona 全文, 继续推进任务即可.
> <final gen> 只在真完成时输出.`;
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
  // 2026-07-04: 加 signal 让 pivot loop 支持 abort (防止 LLM hang)
  // 2026-08-02: 加 tools 参数 (OpenAI 原生函数定义) + toolCalls 返回 (结构化工具调用)
  chat(context: string, systemPrompt: string, signal?: AbortSignal, tools?: any[]): Promise<{ reply: string; tokens?: number; toolCalls?: any[] }>;
}

/**
 * Factory to create a default pivot loop configuration
 */
export function createDefaultPivotConfig(complexity?: TaskComplexity): PivotLoopConfig {
  // 2026-07-06: maxIterations 默认大幅上调 — LLM 自己约束结束时机, 持久循环.
  //   真实停止由 LLM emit <final gen> / 质量达标 / 连续无进展 / user abort 触发.
  //   旧 30/60 iter 在长任务 (eg. 大文档改写) 太短, 现在跑到 N 次也不报超时.
  const profiles: Record<TaskComplexity, PivotLoopConfig> = {
    simple: {
      maxIterations: 200,
      minIterations: 1,
      qualityThreshold: 0.6,
      maxConsecutiveNoProgress: 5,
      maxTokenBudget: 10000
    },
    moderate: {
      maxIterations: 1000,
      minIterations: 2,
      qualityThreshold: 0.7,
      maxConsecutiveNoProgress: 8,
      maxTokenBudget: 30000
    },
    complex: {
      maxIterations: 2000,
      minIterations: 3,
      qualityThreshold: 0.75,
      maxConsecutiveNoProgress: 12,
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
