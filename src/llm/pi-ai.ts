import * as path from 'path';
import * as fs from 'fs';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'gemini' | 'minimax' | 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'mimo' | 'local';

export interface ModelConfig {
  provider: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  reply: string;
  /** 2026-06-30: OpenAI 协议 native tool_calls 数组 (minimax/M3 返回)
   *  每个 tool_call 包含 id/type/function.name/function.arguments
   *  bolloon 用来给后续 tool result 提供 tool_call_id 引用 */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string; // JSON string
    };
  }>;
}

export interface SummarizeResult {
  summary: string;
  qualityScore: number;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 工具 id 列表 — 代码侧 (src/llm/tool-manifest/) 查 schema, prompt 里只嵌 oneLine + callExample */
  tools?: string[];
}

/**
 * 外部 system 注入钩子.
 * 调用方 (e.g. auto-evolve-loop) 用 setSystemPrependProvider() 注册一个返回字符串的函数,
 * generateText 在拼 finalMessages 时, 把返回的字符串作为最前一个 system message.
 *
 * 用途: P2P 协作时把"行级 reserve 状态"实时塞给 LLM,
 *       让 LLM 主动避开对方正在改的代码行.
 *
 * 返回 '' / null / undefined → 不注入.
 */
let _prependProvider: (() => string | null | undefined | Promise<string | null | undefined>) | null = null;
export function setSystemPrependProvider(
  p: (() => string | null | undefined | Promise<string | null | undefined>) | null
): void {
  _prependProvider = p;
}
export function getSystemPrependProvider(): typeof _prependProvider {
  return _prependProvider;
}

export class PiAIModel {
  private config: ModelConfig;
  private provider: ModelProvider;
  /** 单次 LLM HTTP 请求硬上限 (ms), 防止上游卡住挂死整个 loop. 可通过 BOLLOON_LLM_TIMEOUT 覆盖. */
  private requestTimeoutMs: number;

  constructor(config: ModelConfig) {
    this.config = config;
    this.provider = config.provider;
    const envTimeout = Number(process.env.BOLLOON_LLM_TIMEOUT);
    this.requestTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000;
  }

  /**
   * 把外部 signal 和内部 timeout 合并: 任一触发都 abort.
   * - 外部 signal 优先 (用户主动 abort)
   * - 否则套 120s timeout
   * - 任一不合法 (非 AbortSignal 实例) 时退到无 signal
   */
  private combinedSignal(external?: AbortSignal): AbortSignal | undefined {
    const valid = external instanceof AbortSignal ? external : undefined;
    // Node 18+ 支持 AbortSignal.timeout, 旧版本兜底用 setTimeout 构造
    if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
      const timeoutSignal = (AbortSignal as any).timeout(this.requestTimeoutMs);
      if (!valid) return timeoutSignal;
      // 合并两个 signal
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      valid.addEventListener('abort', onAbort, { once: true });
      timeoutSignal.addEventListener('abort', onAbort, { once: true });
      if (valid.aborted || timeoutSignal.aborted) ctrl.abort();
      return ctrl.signal;
    }
    return valid;
  }

  /**
   * 与 LLM 对话.
   *
   * 支持三种调用形式:
   *   - 旧: chat(message: string, context?: string, signal?)
   *       单一 user message + 附加 system context. 简单场景用.
   *   - 新: chat(messages: ChatMessage[], context?: string, signal?)
   *       完整 messages 数组, 含 user/assistant/tool/system role.
   *       工具调用场景必用 — 否则 LLM 看不到工具结果.
   *   - pivot loop 兼容: chat(context: string, systemPrompt: string, signal?)
   *       第二参超过 2K 时视为 system prompt 覆盖, 避免把 46K context 当 user message 发送.
   *
   * 2026-06-17 (M3.5 调试): buildContext() 之前把所有 history 序列化成单字符串,
   *   LLM 看不到 tool 调用的真实结果,导致 CLI loop 卡死.
   *   现在 messages 数组版本保留 role 语义, LLM 能正确看到工具返回.
   */
  async chat(
    messageOrMessages: string | ChatMessage[],
    contextOrSystemPrompt?: string,
    signal?: AbortSignal,
    tools?: string[]
  ): Promise<ChatResult> {
    const systemPrompt = await this.buildSystemPromptAsync(contextOrSystemPrompt);
    let messages: ChatMessage[];
    if (Array.isArray(messageOrMessages)) {
      messages = [{ role: 'system', content: systemPrompt }, ...messageOrMessages];
    } else if (contextOrSystemPrompt && contextOrSystemPrompt.length > 2000) {
      const baseSystem = await this.buildSystemPromptAsync(undefined);
      messages = [
        { role: 'system', content: baseSystem + '\n\n' + contextOrSystemPrompt },
        { role: 'user', content: messageOrMessages }
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: messageOrMessages }
      ];
    }

    try {
      const response = await this.generateText({
        messages,
        temperature: 0.8,
        maxTokens: 16384, // 2026-06-17: 提到 16384 — agent 注入 16K+ system prompt + 8K tool defs 时, 8K 撞上限返回空 content (见 memory: bolloon-llm-empty-large-prompt)
        signal,
        tools,  // pass through for native tool calling
      });
      return { reply: response.reply, toolCalls: response.toolCalls };
    } catch (error: any) {
      // abort 不当作错误, 透传一个 sentinel 让上层能识别
      if (signal?.aborted || error?.name === 'AbortError') {
        throw error; // 上层 try/catch 处理
      }
      console.error('PiAI chat error:', error);
      // 2026-06-15: 真实 error 信息 + 明确告诉 LLM "这是 API 错, 不要 retry"
      // 旧版: "抱歉，AI服务暂时不可用。" → LLM 看到 isTooShort=false(< 50 但 > 0),
      //       needsMoreWork 不会触发, 但 hasError 模式 (含 "error" / "失败") 会判定要继续修
      // 新版: 让 LLM 立即停止循环, 直接展示给用户
      const errMsg = (error?.message || '').slice(0, 300);
      return {
        reply: `[AI 服务调用失败] ${errMsg}\n\n这是一个**底层 API 错误**（401 / 鉴权失败 / 网络中断 / 配额耗尽等），不是你的任务有问题。**请直接把这个错误消息回复给用户，不要再循环尝试。**`,
      };
    }
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    const prompt = this.buildSummarizePrompt(text, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document summarizer.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      });

      const qualityScore = this.estimateQuality(text, response.reply);
      return { summary: response.reply, qualityScore };
    } catch (error) {
      console.error('PiAI summarize error:', error);
      return {
        summary: text.substring(0, 500) + '...',
        qualityScore: 0.5
      };
    }
  }

  async improveContent(content: string, requirements: string, context?: string): Promise<string> {
    const prompt = this.buildImprovePrompt(content, requirements, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document editor and improver.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8
      });
      return response.reply;
    } catch (error) {
      console.error('PiAI improve error:', error);
      return content;
    }
  }

  private async generateText(options: GenerateOptions): Promise<ChatResult> {
    const { messages, temperature = 0.7, maxTokens = 4096, signal, tools } = options;

    // 工具清单: 代码侧 schema → 进 system prompt (作为额外 system message)
    let finalMessages = messages;

    // 1) 外部 prepend (e.g. P2P 行级 reserve 状态), 拼到最前
    if (_prependProvider) {
      try {
        const pre = await _prependProvider();
        if (pre && typeof pre === 'string' && pre.trim()) {
          finalMessages = [{ role: 'system', content: pre }, ...finalMessages];
        }
      } catch (err: any) {
        console.warn('[pi-ai] systemPrepend 失败:', err?.message?.slice(0, 100));
      }
    }

    let openaiTools: any[] | undefined;
    if (tools && tools.length > 0) {
      // 预格式化的 tools (含参数 schema) → 直接使用
      if (typeof tools[0] === 'object' && (tools[0] as any)?.type === 'function') {
        openaiTools = tools as any[];
        const toolDescriptions = (tools as any[]).map(t =>
          `- ${t.function.name}: ${t.function.description || ''} ${Object.keys(t.function.parameters?.properties || {}).length > 0 ? `(${Object.keys(t.function.parameters.properties).join(', ')})` : ''}`
        ).join('\n');
        finalMessages = [{ role: 'system', content: `可用工具:\n${toolDescriptions}` }, ...messages];
      }
    }

    switch (this.provider) {
      case 'openai':
      case 'minimax':
      case 'deepseek':
      case 'kimi':
      case 'glm':
      case 'qwen':
      case 'mimo':
        return this.callOpenAI(finalMessages, temperature, maxTokens, signal, openaiTools);
      case 'anthropic':
        return this.callAnthropic(finalMessages, temperature, maxTokens, signal);
      case 'ollama':
        return this.callOllama(finalMessages, temperature, signal);
      case 'openrouter':
        return this.callOpenRouter(finalMessages, temperature, maxTokens, signal);
      case 'gemini':
        return this.callGemini(finalMessages, temperature, maxTokens, signal);
      case 'local':
        return this.callLocal(finalMessages, temperature, signal);
      default:
        throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  private getApiKey(): string {
    return this.config.apiKey || this.getEnvApiKey();
  }

  private getEnvApiKey(): string {
    const envVars: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_API_KEY || '',
      anthropic: process.env.ANTHROPIC_API_KEY || '',
      ollama: '',
      openrouter: process.env.OPENROUTER_API_KEY || '',
      gemini: process.env.GEMINI_API_KEY || '',
      minimax: process.env.MINIMAX_API_KEY || '',
      deepseek: process.env.DEEPSEEK_API_KEY || '',
      kimi: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
      glm: process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '',
      qwen: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
      mimo: process.env.MIMO_API_KEY || '',
      local: ''
    };
    return envVars[this.provider] || '';
  }

  private getBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }

    // 允许通过 OPENAI_BASE_URL 等环境变量覆盖默认 base URL
    const baseUrls: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      kimi: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
      glm: process.env.GLM_BASE_URL || process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      qwen: process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      // 小米 MiMo: 走 OpenAI 兼容 API, 官方 endpoint
      mimo: process.env.MIMO_BASE_URL || 'https://api.xiaomi.com/v1',
      local: 'http://localhost:11434'
    };

    return baseUrls[this.provider];
  }

  private mapModel(): string {
    const modelMap: Record<ModelProvider, string> = {
      openai: this.config.model || process.env.OPENAI_MODEL || 'gpt-4.1',
      anthropic: this.config.model || 'claude-sonnet-4-5-20250929',
      ollama: this.config.model || 'llama3.2',
      openrouter: this.config.model || 'anthropic/claude-sonnet-4.5',
      // Pinned to 2.5-pro: the only `-pro` model that is GA per Google docs.
      // The 3.x line ships as `-flash` only — there is no `gemini-3.x-pro`.
      gemini: this.config.model || 'gemini-2.5-pro',
      minimax: this.config.model || process.env.MINIMAX_MODEL || 'MiniMax-M3',
      // 2026-07-17: deepseek-chat (V3) 官方已下线, 迁 deepseek-v4-flash
      deepseek: this.config.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      kimi: this.config.model || process.env.KIMI_MODEL || process.env.MOONSHOT_MODEL || 'moonshot-v1-8k',
      glm: this.config.model || process.env.GLM_MODEL || process.env.ZHIPU_MODEL || 'glm-4-flash',
      qwen: this.config.model || process.env.QWEN_MODEL || process.env.DASHSCOPE_MODEL || 'qwen-plus',
      // 小米 MiMo (openai 兼容) — env override 优先, 默认 mimo-v2.5-pro
      mimo: this.config.model || process.env.MIMO_MODEL || 'mimo-v2.5-pro',
      local: this.config.model || 'llama3.2'
    };
    return modelMap[this.provider];
  }

  private async callOpenAI(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal, tools?: any[]): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }

    const requestBody: any = {
      model: this.mapModel(),
      messages,
      temperature,
      max_tokens: maxTokens
    };

    // Bug 3: 传入原生 tools 参数 + tool_choice auto, LLM 返回结构化 tool_calls
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = 'auto';
    }

    let lastFinishReason = '';
    const _t0 = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const _tFetch = Date.now();
      let response: Response;
      try {
        response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody),
          signal: this.combinedSignal(signal),
        });
      } catch (err: any) {
        // 2026-08-04: 网络层瞬时错误 (undici "terminated" / ECONNRESET / socket hang up / fetch failed 等)
        //   退避重试最多 2 次 — 之前直接抛给 chat() 变成 "[AI 服务调用失败] terminated" 打断 agent 流程.
        //   abort (用户主动 / 120s 超时) 不重试, 原样抛出.
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        const netMsg = String(err?.message || err?.cause?.message || '');
        const isNetworkErr = /terminated|ECONNRESET|socket hang up|fetch failed|network|ETIMEDOUT|ECONNREFUSED|UND_ERR/i.test(netMsg);
        if (attempt < 2 && isNetworkErr) {
          const backoff = 1500 * (attempt + 1);
          console.warn(`[pi-ai] 网络错误 attempt ${attempt + 1}/3: ${netMsg.slice(0, 120)}, 退避 ${backoff}ms 重试`);
          await new Promise<void>(resolve => setTimeout(resolve, backoff));
          continue;
        }
        throw err;
      }
      const _tResp = Date.now();
      if (!response.ok) {
        const errBody = await response.text().catch(() => '(no body)');
        console.log(`[pi-ai DEBUG] OpenAI 错误 ${response.status}: ${errBody.slice(0, 500)}`);
        console.log(`[pi-ai DEBUG] 请求体: model=${requestBody.model}, messages=${requestBody.messages?.length}, max_tokens=${requestBody.max_tokens}, baseUrl=${this.getBaseUrl()}`);
        throw new Error(`OpenAI API error: ${response.status} ${errBody.slice(0, 300)}`);
      }

      const data = await response.json() as {
        choices?: { message?: { content?: string; tool_calls?: any[] }; finish_reason?: string; index?: number }[];
      };
      const _tParse = Date.now();
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      const toolCalls = choice?.message?.tool_calls;
      lastFinishReason = choice?.finish_reason || '';
      // Bug 7: tool_calls 存在时不走重试 — LLM 选工具时 content 空是合法的
      if (content || (toolCalls && toolCalls.length > 0)) {
        if (lastFinishReason === 'length') {
          console.warn(`[pi-ai] hit max_tokens ceiling (model=${this.mapModel()}, max_tokens=${maxTokens}) — caller should trim prompt or raise cap`);
        }
        const _tAfter = Date.now();
        const promptBytes = JSON.stringify(messages).length;
        console.log(`[pi-ai timing] total=${_tAfter - _t0}ms attempt=${attempt + 1} fetch=${_tResp - _tFetch}ms parse=${_tParse - _tResp}ms reply=${content.length}B toolCalls=${toolCalls?.length ?? 0} model=${this.mapModel()} prompt=${promptBytes}B`);
        return { reply: content, toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined };
      }
      console.warn(`[pi-ai] attempt ${attempt + 1}/3: 空 content (finish_reason=${lastFinishReason}), 退避 1.5s 重试`);
      const _tSleep = Date.now();
      await new Promise<void>(resolve => setTimeout(resolve, 1500));
      console.log(`[pi-ai timing] attempt=${attempt + 1} empty; backoff=${Date.now() - _tSleep}ms; total=${Date.now() - _t0}ms so far`);
    }
    console.warn(`[pi-ai] 3 次重试都返回空 content (finish_reason=${lastFinishReason})`);
    return { reply: '' };
  }

  private async callAnthropic(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.getBaseUrl()}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages: userMessages,
        system: systemMessage,
        temperature,
        max_tokens: maxTokens
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { content?: { text?: string }[] };
    return { reply: data.content?.[0]?.text || '' };
  }

  private async callOllama(messages: ChatMessage[], temperature: number, signal?: AbortSignal): Promise<ChatResult> {
    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        stream: false
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    return { reply: data.message?.content || '' };
  }

  private async callOpenRouter(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }

    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://openclaw.ai',
        'X-Title': 'OpenClaw'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return { reply: data.choices?.[0]?.message?.content || '' };
  }

  private async callGemini(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = messages.find(m => m.role === 'system')?.content;

    const response = await fetch(
      `${this.getBaseUrl()}/models/${this.mapModel()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        }),
        signal: this.combinedSignal(signal),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return { reply: data.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  }

  private async callLocal(messages: ChatMessage[], temperature: number, signal?: AbortSignal): Promise<ChatResult> {
    return this.callOllama(messages, temperature, signal);
  }
  // 注: callLocal 直接代理 ollama. 工具清单由 generateText 在外层拼到 messages, 这里 messages 已是 finalMessages.

  private async buildSystemPromptAsync(context?: string): Promise<string> {
    // 走 layer registry: 装配所有相关 layer (身份/行为/工具/角色/渠道)
    try {
      const { assembleSystemPrompt, SYSTEM_PROMPT_VERSION } = await import(
        './system-prompt/registry.js' as any
      ).catch(() => import('./system-prompt/registry.js'));
      // channel = 本机 (PI SDK 直接调就是 local)
      // role = 由 prompt context 决定 (默认 expert)
      const ctx = context ? { channel: 'local' as const, role: 'expert' as const } : { channel: 'local' as const, role: 'expert' as const };
      const result = await assembleSystemPrompt(ctx);
      return `${result.text}\n\n## User Working Directory\n${context || process.cwd()}\n\n## bolloon-runtime\n${SYSTEM_PROMPT_VERSION} · layers: ${result.layerIds.join(',')}`;
    } catch (err: any) {
      // 降级: 旧硬编码 (layer registry 不可用时不挂)
      console.warn('[pi-ai] layer registry 不可用, 降级:', err.message?.slice(0, 100));
      const envDetails = this.getEnvironmentDetails();
      return `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${context || process.cwd()}

## Environment
${envDetails}`;
    }
  }

  // 同步版: 旧调用点 (buildSystemPrompt 是同步)
  // 保留但内部用 sync fallback; 后续可改成 async
  private buildSystemPrompt(context?: string): string {
    const envDetails = this.getEnvironmentDetails();
    return `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${context || process.cwd()}

## Environment
${envDetails}`;
  }

  private getEnvironmentDetails(): string {
    return `
## Available Workflows
- read - Read documents
- summarize - Summarize documents  
- improve - Improve documents
- collaborate - Multi-agent collaboration
- query - Query status
- report - Generate reports

## System Capabilities
- Document processing (Markdown, Text, PDF, DOCX)
- Multi-agent collaboration (P2P network)
- Workflow engine (constraint layer)
- Quality assessment and auto-send

## Current Time
${new Date().toISOString()}`;
  }

  private buildSummarizePrompt(text: string, context?: string): string {
    const maxLength = 8000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

    let prompt = `Please generate a concise and accurate summary for the following document:

${truncatedText}

Please output in the following format:
## Summary
[Write summary here]

## Quality Self-Assessment
[Score 1-10, with reasoning]`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  private buildImprovePrompt(content: string, requirements: string, context?: string): string {
    const maxLength = 8000;
    const truncatedContent = content.length > maxLength ? content.substring(0, maxLength) + '...' : content;

    let prompt = `Please improve the document according to the following requirements:

Requirements: ${requirements}

Original Document:
${truncatedContent}

Please output only the improved document without additional explanation.`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  estimateQuality(original: string, summary: string): number {
    const coverageRatio = summary.length / Math.max(original.length, 1);
    const hasKeyPoints = /\d+\s*[.。]/.test(summary);
    const decentLength = summary.length > 100 && summary.length < original.length * 0.5;

    let score = 0.5;
    if (coverageRatio > 0.1 && coverageRatio < 0.5) score += 0.2;
    if (hasKeyPoints) score += 0.15;
    if (decentLength) score += 0.15;

    return Math.min(1, score);
  }

  async shouldAutoSend(qualityScore: number, threshold: number = 0.7): Promise<boolean> {
    return qualityScore >= threshold;
  }
}

let modelInstance: PiAIModel | null = null;

export interface PiAIConfig {
  provider?: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function detectProvider(): ModelProvider {
  // 首先检查配置文件（优先级最高）
  try {
    const configPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'llm-config.json');
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (configData.activeProvider && configData.providers[configData.activeProvider]) {
      console.log('[PiAIModel] Detected provider from config:', configData.activeProvider);
      return configData.activeProvider;
    }
  } catch {}

  // 然后检查环境变量
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  if (process.env.MINIMAX_API_KEY) return 'minimax';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) return 'kimi';
  if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY) return 'glm';
  if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) return 'qwen';
  if (process.env.MIMO_API_KEY) return 'mimo';

  return 'openai';
}

function detectModel(provider: ModelProvider): string {
  const defaults: Record<ModelProvider, string> = {
    openai: 'gpt-4.1',
    anthropic: 'claude-sonnet-4-5-20250929',
    ollama: 'llama3.2',
    openrouter: 'anthropic/claude-sonnet-4.5',
    gemini: 'gemini-2.5-pro',
    minimax: 'MiniMax-M3',
    // 2026-07-17: V3 官方下线, 迁 V4
    deepseek: 'deepseek-v4-flash',
    kimi: 'moonshot-v1-8k',
    glm: 'glm-4-flash',
    qwen: 'qwen-plus',
    // 小米 MiMo 默认走最新旗舰版 (v2.5-Pro); 2026-06 当前公开版
    mimo: 'mimo-v2.5-pro',
    local: 'llama3.2'
  };
  return defaults[provider];
}

export function initPiAI(config: PiAIConfig = {}): PiAIModel {
  const provider = config.provider || detectProvider();
  const model = config.model || detectModel(provider);

  console.log('[PiAIModel] Initializing with provider:', provider, 'model:', model);

  // 如果没有提供 apiKey，从配置文件读取
  let apiKey = config.apiKey;
  if (!apiKey) {
    try {
      const configPath = path.join(process.env.HOME || '/tmp', '.bolloon', 'llm-config.json');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const providerConfig = configData.providers[provider];
      if (providerConfig?.apiKey) {
        apiKey = providerConfig.apiKey;
        console.log('[PiAIModel] Loaded apiKey from config for', provider);
      }
    } catch (e) {
      console.log('[PiAIModel] Error reading apiKey from config:', e);
    }
  }

  modelInstance = new PiAIModel({
    provider,
    apiKey,
    baseUrl: config.baseUrl,
    model
  });

  console.log('[PiAIModel] Model instance created, provider:', provider);
  return modelInstance;
}

export function getModel(): PiAIModel {
  if (!modelInstance) {
    throw new Error('PiAI not initialized. Call initPiAI first.');
  }
  return modelInstance;
}

export function isModelAvailable(): boolean {
  return modelInstance !== null;
}

export function getMinimax(): PiAIModel {
  return getModel();
}

export function initMinimax(config: PiAIConfig = {}): PiAIModel {
  return initPiAI(config);
}

export { PiAIModel as MinimaxLLM };
