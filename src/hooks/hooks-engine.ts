/**
 * hooks-engine.ts — Phase 4: Hook 机制 (2026-07-29)
 *
 * Claude Code 式 hook 系统: 在 agent 循环的关键点触发外部回调.
 *
 * 设计决策:
 * - 事件驱动 (EventEmitter): 注册 → 触发 → 执行回调
 * - 2 种执行模式: shell (同步/异步 command) + llm (LLM 评估)
 * - 回调可以拒绝/修改/记录/中断流程
 * - 配置从 ~/.bolloon/hooks.yaml 加载
 * - Hook 是零 context 成本 — 不在 prompt 内, 不消耗 token
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { getMinimax } from '../constraints/index.js';

// ============== 类型 ==============

/** 支持的 hook 事件类型 */
export const HOOK_EVENT_TYPES = [
  'preToolUse',       // 工具调用前 — 可返回 {deny, reason} 拒绝
  'postToolUse',      // 工具调用后 — 可注入系统提示
  'onMessage',        // 用户/助手消息后
  'onSessionStart',   // 会话开始
  'onSessionEnd',     // 会话结束
  'onLoopStart',      // ReAct 循环开始
  'onLoopEnd',        // ReAct 循环结束
  'onError',          // 发生 API/工具错误
] as const;

export type HookEventType = typeof HOOK_EVENT_TYPES[number];

/** hook 执行模式 */
export type HookExecMode = 'shell' | 'llm';

export interface HookConfig {
  /** hook 唯一标识 */
  id: string;
  /** 触发事件 */
  event: HookEventType;
  /** 执行模式 */
  mode: HookExecMode;
  /** shell 命令 (mode=shell 时) */
  command?: string;
  /** LLM 评估 prompt (mode=llm 时) */
  prompt?: string;
  /** 超时毫秒, 默认 5000 */
  timeoutMs?: number;
  /** 启用/禁用 */
  enabled?: boolean;
  /** 仅匹配指定工具名 (preToolUse 时) */
  toolFilter?: string[];
  /** 描述 */
  description?: string;
}

export interface HookContext {
  /** 事件类型 */
  event: HookEventType;
  /** 当前工具名 (preToolUse/postToolUse 时) */
  toolName?: string;
  /** 当前工具参数 (preToolUse 时) */
  toolArgs?: Record<string, unknown>;
  /** 工具结果 (postToolUse 时) */
  toolResult?: unknown;
  /** 消息内容 (onMessage 时) */
  messageContent?: string;
  /** 消息角色 (onMessage 时) */
  messageRole?: string;
  /** 当前 channel id */
  channelId?: string;
  /** 当前 session id */
  sessionId?: string;
  /** 当前 agent id */
  agentId?: string;
  /** 错误信息 (onError 时) */
  error?: string;
}

export interface HookResult {
  /** hook id */
  id: string;
  /** 是否拒绝 (preToolUse 时) */
  deny?: boolean;
  /** 拒绝原因 */
  reason?: string;
  /** 是否修改了 prompt (postToolUse / onMessage 时) */
  modified?: boolean;
  /** 注入到 system prompt 的文本 */
  systemAddition?: string;
  /** 原始输出 */
  rawOutput?: string;
  /** 执行耗时 ms */
  elapsedMs?: number;
  /** 是否超时 */
  timedOut?: boolean;
  /** 是否出错 */
  error?: string;
}

// ============== Hook 引擎 ==============

export class HooksEngine {
  private hooks: Map<string, HookConfig> = new Map();
  private configPath: string;

  constructor(home?: string) {
    this.configPath = path.join(home || os.homedir(), '.bolloon', 'hooks.yaml');
  }

  /** 注册一个 hook */
  register(config: HookConfig): void {
    if (!config.id) throw new Error('Hook id 必填');
    if (!HOOK_EVENT_TYPES.includes(config.event)) {
      throw new Error(`未知 hook 事件: ${config.event}, 可用: ${HOOK_EVENT_TYPES.join(', ')}`);
    }
    this.hooks.set(config.id, { ...config, enabled: config.enabled ?? true });
  }

  /** 批量注册 */
  registerMany(configs: HookConfig[]): void {
    for (const c of configs) this.register(c);
  }

  /** 注销 hook */
  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  /** 获取指定事件的所有启用的 hook */
  getHooks(event: HookEventType): HookConfig[] {
    return Array.from(this.hooks.values()).filter(h => h.enabled !== false && h.event === event);
  }

  /** 获取所有 hook */
  listAll(): HookConfig[] {
    return Array.from(this.hooks.values());
  }

  /** 启用/禁用 */
  setEnabled(id: string, enabled: boolean): boolean {
    const h = this.hooks.get(id);
    if (!h) return false;
    h.enabled = enabled;
    return true;
  }

  /**
   * 触发一个事件, 执行所有匹配的 hook.
   * 返回 HookResult 数组.
   *
   * preToolUse 的 deny 结果: 如果任意 hook 返回 deny=true, 该工具被拒绝.
   */
  async fire(event: HookEventType, ctx: HookContext): Promise<HookResult[]> {
    const matched = this.getHooks(event);
    if (matched.length === 0) return [];

    const results: HookResult[] = [];

    for (const hook of matched) {
      // preToolUse 工具过滤
      if (event === 'preToolUse' && hook.toolFilter && ctx.toolName) {
        if (!hook.toolFilter.includes(ctx.toolName)) continue;
      }

      try {
        const result = await this.executeHook(hook, ctx);
        results.push(result);
      } catch (e: unknown) {
        results.push({
          id: hook.id,
          error: String(e),
          elapsedMs: 0,
        });
      }
    }

    return results;
  }

  /**
   * 检查 preToolUse hook 是否拒绝当前工具.
   * 返回第一个 deny 的 HookResult, 或 null.
   */
  async checkToolUse(toolName: string, args: Record<string, unknown>): Promise<HookResult | null> {
    const results = await this.fire('preToolUse', {
      event: 'preToolUse',
      toolName,
      toolArgs: args,
    });

    for (const r of results) {
      if (r.deny) return r;
    }
    return null;
  }

  /**
   * 执行单个 hook.
   */
  private async executeHook(hook: HookConfig, ctx: HookContext): Promise<HookResult> {
    const start = Date.now();
    const timeoutMs = hook.timeoutMs ?? 5000;

    if (hook.mode === 'shell' && hook.command) {
      return this.execShell(hook, ctx, start, timeoutMs);
    }

    if (hook.mode === 'llm' && hook.prompt) {
      return this.execLlm(hook, ctx, start, timeoutMs);
    }

    return {
      id: hook.id,
      error: `不支持的执行模式: ${hook.mode}`,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * shell 模式: spawn 子进程执行命令.
   * 环境变量 HOOK_EVENT / HOOK_TOOL / HOOK_ARGS / HOOK_RESULT 传递上下文.
   */
  private async execShell(
    hook: HookConfig,
    ctx: HookContext,
    start: number,
    timeoutMs: number
  ): Promise<HookResult> {
    return new Promise<HookResult>((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOOK_EVENT: ctx.event,
        HOOK_TOOL: ctx.toolName || '',
        HOOK_ARGS: ctx.toolArgs ? JSON.stringify(ctx.toolArgs) : '',
        HOOK_RESULT: ctx.toolResult ? JSON.stringify(ctx.toolResult).slice(0, 2000) : '',
        HOOK_MESSAGE: ctx.messageContent || '',
        HOOK_CHANNEL: ctx.channelId || '',
        HOOK_SESSION: ctx.sessionId || '',
        HOOK_ERROR: ctx.error || '',
      };

      const proc = spawn('sh', ['-c', hook.command!], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          id: hook.id,
          rawOutput: stdout.slice(0, 1000),
          timedOut: true,
          elapsedMs: Date.now() - start,
        });
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const elapsed = Date.now() - start;

        // 解析 stdout: 如果是 JSON, 提取 deny/系统注入
        let deny = false;
        let reason = '';
        let systemAddition = '';
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.deny) {
            deny = true;
            reason = parsed.reason || 'Hook 拒绝';
          }
          if (parsed.systemAddition) {
            systemAddition = parsed.systemAddition;
          }
        } catch {
          // 不是 JSON, 当普通输出
        }

        resolve({
          id: hook.id,
          deny,
          reason,
          systemAddition,
          rawOutput: stdout.slice(0, 1000),
          elapsedMs: elapsed,
          error: code !== 0 ? `exit ${code}: ${stderr.slice(0, 200)}` : undefined,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          id: hook.id,
          error: String(err),
          elapsedMs: Date.now() - start,
        });
      });
    });
  }

  /**
   * LLM 模式: 用当前 LLM 评估 hook prompt.
   * 将上下文注入 prompt, 获取 LLM 的判断.
   */
  private async execLlm(
    hook: HookConfig,
    ctx: HookContext,
    start: number,
    timeoutMs: number
  ): Promise<HookResult> {
    try {
      const minimax = getMinimax();
      if (!minimax) {
        return { id: hook.id, error: 'LLM 不可用 (minimax 未初始化)', elapsedMs: Date.now() - start };
      }

      // 构建评估 prompt
      const contextStr = [
        `事件: ${ctx.event}`,
        ctx.toolName ? `工具: ${ctx.toolName}` : '',
        ctx.toolArgs ? `参数: ${JSON.stringify(ctx.toolArgs).slice(0, 500)}` : '',
        ctx.toolResult ? `结果: ${JSON.stringify(ctx.toolResult).slice(0, 500)}` : '',
        ctx.messageContent ? `消息: ${ctx.messageContent.slice(0, 500)}` : '',
        ctx.error ? `错误: ${ctx.error}` : '',
      ].filter(Boolean).join('\n');

      const fullPrompt = `【Hook 评估】\n${contextStr}\n\n【规则】\n${hook.prompt}\n\n请以 JSON 格式回答, 包含字段: deny (boolean), reason (string), systemAddition (string, 可选).`;

      const response = await minimax.chat(fullPrompt, '', undefined);
      const reply = (response.reply || '').trim();

      let parsed: any;
      try {
        // 尝试提取 JSON
        const jsonMatch = reply.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { deny: false };
      } catch {
        parsed = { deny: false };
      }

      return {
        id: hook.id,
        deny: parsed.deny === true,
        reason: parsed.reason || '',
        systemAddition: parsed.systemAddition || '',
        rawOutput: reply.slice(0, 1000),
        elapsedMs: Date.now() - start,
      };
    } catch (e: unknown) {
      return {
        id: hook.id,
        error: String(e),
        elapsedMs: Date.now() - start,
      };
    }
  }

  /**
   * 从 ~/.bolloon/hooks.yaml 加载配置.
   * 失败静默 (没有 hook 配置也正常).
   */
  async loadFromConfig(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      // 简单解析 YAML-like: id/event/mode/command/prompt/toolFilter
      const lines = raw.split('\n');
      let current: Partial<HookConfig> = {};

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;

        // hook 分隔: 空行或 ---
        if (trimmed === '---' || (trimmed.length === 0 && current.id)) {
          if (current.id && current.event) {
            this.register(current as HookConfig);
          }
          current = {};
          continue;
        }

        const sep = trimmed.indexOf(':');
        if (sep < 0) continue;
        const key = trimmed.slice(0, sep).trim();
        const val = trimmed.slice(sep + 1).trim();

        switch (key) {
          case 'id': current.id = val; break;
          case 'event': current.event = val as HookEventType; break;
          case 'mode': current.mode = val as HookExecMode; break;
          case 'command': current.command = val; break;
          case 'prompt': current.prompt = val; break;
          case 'timeout_ms': current.timeoutMs = parseInt(val, 10) || 5000; break;
          case 'enabled': current.enabled = val === 'true'; break;
          case 'description': current.description = val; break;
          case 'tool_filter': current.toolFilter = val.split(',').map(s => s.trim()).filter(Boolean); break;
        }
      }

      // 最后一条
      if (current.id && current.event) {
        this.register(current as HookConfig);
      }
    } catch {
      // 文件不存在 / 无法解析 — 静默
    }
  }

  /** 获取默认配置路径 */
  getConfigPath(): string {
    return this.configPath;
  }
}
