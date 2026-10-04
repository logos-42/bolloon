/**
 * K9 —— **第二个推理适配器 (非 Pi)** · 2026-10-02
 *
 * 为什么要有它: K10 的撤换判据里有一条是「**出现第二个推理适配器能过同一套门**」——
 * 在那之前, "Pi 可以被替换" 只是设计声明。这个适配器 **不 import 任何 Pi 模块**
 * (判据会核: 源码里不许出现 `pi-ai` / `getMinimax`), 只用 `fetch` 直连 OpenAI 兼容端点,
 * 实现 pivot loop 唯一依赖的 `LLMInterface.chat(...)`。
 *
 * **契约 (与 Pi 侧 `chat` 同形**, 见 `workflow-pivot-loop.ts` 的 `LLMInterface`):
 *   `chat(context, systemPrompt, signal?, tools?, purpose?, source?)`
 *     => `{ reply, tokens?, toolCalls?, messages? }`
 *   · `tools` = OpenAI 原生函数定义数组 (**原样转发**, 不在适配器里二次加工)
 *   · `toolCalls` = **OpenAI 原生形状** `[{ id, function: { name, arguments } }]`
 *     —— pivot 读的是 `tc.function.name` / `tc.function.arguments` (workflow-pivot-loop.ts:332)
 *
 * **自己实现的韧性** (刻意**不借** Pi/K6 那一套, 否则"第二个适配器"就变成"Pi 的壳"):
 *   超时 (自建 timer + AbortController) · 429/5xx 指数退避重试 · 调用方 abort 原样透传
 *   4xx (非 429) **不重试** (重试无意义, 直接响亮报出)。
 */
import type { LLMInterface } from '../agents/workflow-pivot-loop.js';
import { sanitizeToolsForApi } from './tool-name.js';

export interface NativeAdapterConfig {
  /** 形如 `https://api.deepseek.com/v1` (会拼 `/chat/completions`) */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 台账/日志里显示的名字 (默认 `native`) */
  providerId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** 可被 abort 打断的 sleep (退避用) */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted during backoff')); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function createNativeAdapter(cfg: NativeAdapterConfig) {
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  const maxRetries = cfg.maxRetries ?? 3;
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  let calls = 0;          // 观测: 真发出去几次 (重试也算)
  let retries = 0;

  const adapter: LLMInterface & { providerId: string; stats: () => { calls: number; retries: number } } = {
    providerId: cfg.providerId ?? 'native',
    stats: () => ({ calls, retries }),
    async chat(context: string, systemPrompt: string, signal?: AbortSignal, tools?: any[], purpose?: string) {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: String(systemPrompt ?? '') },
        { role: 'user', content: String(context ?? '') },
      ];
      let attempt = 0;
      let lastErr: any;
      while (attempt <= maxRetries) {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        if (signal?.aborted) ac.abort();
        else signal?.addEventListener?.('abort', onAbort, { once: true });
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          calls += 1;
          // ⚠️ 出程必须**净化工具名** —— 端点只接受 `^[a-zA-Z0-9_-]{1,64}$` (实测: 原样转发 183 个工具
          //   里第 124 个不合规 ⇒ HTTP 400, 整轮空回复)。净化会把映射登记进**全局路由表**,
          //   回程由 pivot 的 `resolveApiToolName` 还原 ⇒ 上下层协议不变 (这正是"适配器边界"的一部分)。
          const wireTools = Array.isArray(tools) && tools.length > 0 ? sanitizeToolsForApi(tools as any[]) : undefined;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
              model: cfg.model,
              messages,
              ...(wireTools ? { tools: wireTools } : {}),
              stream: false,
            }),
            signal: ac.signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const retryable = res.status === 429 || res.status >= 500;
            if (retryable && attempt < maxRetries) {
              lastErr = new Error(`native-adapter HTTP ${res.status}: ${text.slice(0, 160)}`);
              attempt += 1; retries += 1;
              await sleep(1000 * 2 ** (attempt - 1), signal);
              continue;
            }
            // 非 429 的 4xx ⇒ **不重试** (重试无意义)。这里必须打标记: 否则下面的 catch
            //   会把它当"网络错"再退避重试 —— 踩过 (用例⑤: 一个 400 被发了 4 次)。
            const fatal: any = new Error(`native-adapter HTTP ${res.status}: ${text.slice(0, 200)}`);
            fatal.noRetry = true;
            throw fatal;
          }
          const data: any = await res.json();
          const msg: any = data?.choices?.[0]?.message ?? {};
          const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : undefined;
          return {
            reply: String(msg.content ?? ''),
            tokens: data?.usage?.total_tokens,
            toolCalls,
            messages: messages.concat([{ role: 'assistant', content: String(msg.content ?? '') }]),
          };
        } catch (e: any) {
          // 调用方主动 abort ⇒ 原样抛出 (别当网络错去重试)
          if (signal?.aborted) throw e;
          if ((e as any)?.noRetry) throw e;      // 非 429 的 4xx 等: 不重试
          lastErr = e;
          if (attempt >= maxRetries) throw e;
          attempt += 1; retries += 1;
          await sleep(1000 * 2 ** (attempt - 1), signal);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        }
      }
      throw lastErr ?? new Error('native-adapter: 不可达');
    },
  };
  return adapter;
}

/**
 * 从环境装配一个 native 适配器 (供 `BOLLOON_NATIVE_ADAPTER=1` 开关使用)。
 * 缺 key ⇒ 返回 null (调用方回落到原适配器, 不假装可用)。
 */
export function nativeAdapterFromEnv(env: Record<string, string | undefined> = process.env): ReturnType<typeof createNativeAdapter> | null {
  const apiKey = env.BOLLOON_NATIVE_API_KEY || env.DEEPSEEK_API_KEY || '';
  if (!apiKey) return null;
  return createNativeAdapter({
    baseUrl: env.BOLLOON_NATIVE_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey,
    model: env.BOLLOON_NATIVE_MODEL || 'deepseek-chat',
    providerId: 'native-openai-compatible',
  });
}
