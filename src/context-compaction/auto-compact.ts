/**
 * Auto-Compact — 第 5 层: LLM 摘要 (最后手段)
 *
 * 论文:
 *   - 兜底层, budget > 100% 时才触发
 *   - 用 LLM 生成完整摘要, 替代前 K 对 user/assistant
 *   - 摘要 prompt 明确要求"必须保留出现过的 tool names"
 *   - 缓存到 ~/.bolloon/sessions/<channel>/compaction-cache.json
 *   - LLM 失败 → fallback 保留原文
 *
 * 关键不变量: 这是**破坏性**的 (折叠 N 对成 1 条), 调用方接受新 history
 *
 * 失败静默: LLM 失败 → 返回原 history (与现状一致)
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message, StageResult, StageOptions } from './types.js';

const DEFAULT_COLLAPSE_PAIRS = 5;
const CACHE_DIR = () => path.join(process.env.HOME || os.homedir() || '/tmp', '.bolloon', 'sessions', 'compaction-cache');

function cacheKey(history: Message[], collapsePairs: number): string {
  const slice = history.slice(0, collapsePairs * 2);
  const joined = slice.map((m) => `${m.role}:${m.content}`).join('|');
  return crypto.createHash('sha1').update(joined).digest('hex').slice(0, 12);
}

async function readCache(scope: string, key: string): Promise<string | null> {
  try {
    const file = path.join(CACHE_DIR(), `${scope}_${key}.json`);
    const raw = await fs.readFile(file, 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj.summary === 'string' && Date.now() - obj.ts < 24 * 60 * 60 * 1000) {
      return obj.summary;
    }
  } catch { /* cache miss or parse err */ }
  return null;
}

async function writeCache(scope: string, key: string, summary: string): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR(), { recursive: true });
    const file = path.join(CACHE_DIR(), `${scope}_${key}.json`);
    await fs.writeFile(file, JSON.stringify({ ts: Date.now(), summary, key }), 'utf-8');
  } catch (err) {
    console.warn('[compactor] cache write failed (silent):', err);
  }
}

const SUMMARIZE_SYSTEM = `你是一个对话历史压缩助手.
你的任务: 把给定的对话历史压缩成 1-2 句话的摘要, 保留所有出现过的 tool names.
要求:
- 保留所有用户的关键需求
- 保留所有调用过的 tool names (例如 read_file, shell_exec, use_skill 等)
- 保留关键决策和发现
- 不要添加原对话中没有的信息
- 输出纯文本, 不要 JSON, 不要 markdown 标题`;

export async function autoCompact(history: Message[], opts: StageOptions = {}): Promise<StageResult> {
  try {
    if (opts.skip) return { history, applied: false, detail: 'skipped' };
    const collapsePairs = opts.autoCompactCollapsePairs ?? DEFAULT_COLLAPSE_PAIRS;

    // 找前 K 对的边界
    let pairsFound = 0;
    let cutTo = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        pairsFound++;
        if (pairsPairsOver(pairsFound, collapsePairs)) {
          cutTo = i;
          break;
        }
      }
    }
    if (cutTo <= 0) {
      return { history, applied: false, detail: 'history too short' };
    }

    const toCollapse = history.slice(0, cutTo);
    const remaining = history.slice(cutTo);
    const scope = opts.cacheScope || 'default';

    // 1. 查缓存 (key 基于实际被切的消息, 不用理论 collapsePairs)
    const key = crypto.createHash('sha1').update(
      toCollapse.map((m) => `${m.role}:${m.content}`).join('|')
    ).digest('hex').slice(0, 12);
    let summary = await readCache(scope, key);

    // 2. 没缓存就调 LLM
    if (!summary) {
      if (!opts.llmChat) {
        // 没有 LLM 就 fallback 保留原文
        console.warn('[compactor] autoCompact: no llmChat injected, returning original');
        return { history, applied: false, detail: 'no llmChat available' };
      }
      try {
        const userPrompt = `以下是 ${cutTo} 条较早的对话历史, 请压缩为 1-2 句摘要:\n\n${formatForSummary(toCollapse)}`;
        summary = await opts.llmChat(SUMMARIZE_SYSTEM, userPrompt);
        if (!summary || summary.trim().length === 0) {
          return { history, applied: false, detail: 'llm returned empty' };
        }
        // 写缓存 (静默, 但 await 确保测试可重现)
        try { await writeCache(scope, key, summary); } catch { /* ignored */ }
      } catch (err) {
        console.warn('[compactor] autoCompact LLM call failed (silent, fallback):', err);
        return { history, applied: false, detail: 'llm call failed' };
      }
    }

    // 3. 折叠: 1 条 summary 消息替代 N 条原文
    const summaryMsg: Message = {
      role: 'system',
      content: `[Auto-Compact Summary] ${summary}`,
    } as any;
    // 2026-10-01: **摘要后面紧跟一条"保目标"锚点** ✓ —— 摘要丢目标它还在(详见 buildGoalAnchor ✓)
    const anchor = buildGoalAnchor(toCollapse, remaining);
    return {
      history: [summaryMsg, ...(anchor ? [anchor] : []), ...remaining],
      applied: true,
      detail: `collapsed ${cutTo} messages into 1 summary (cache key: ${key})${anchor ? ' + 保目标锚点' : ''}`,
    };
  } catch (err) {
    console.warn('[compactor] autoCompact failed (silent, returning original):', err);
    return { history, applied: false, detail: 'error' };
  }
}

function pairsPairsOver(found: number, target: number): boolean {
  return found > target;
}

function formatForSummary(messages: Message[]): string {
  return messages.map((m) => {
    if (m.role === 'user') return `用户: ${m.content}`;
    if (m.role === 'assistant') return `助手: ${m.content.substring(0, 500)}`;
    if (m.role === 'tool') {
      const r = (m as any).toolResult;
      return `工具: ${typeof r === 'string' ? r : JSON.stringify(r).substring(0, 300)}`;
    }
    return m.content;
  }).join('\n');
}

// ============================================================
// 测试钩子
// ============================================================

export function _resetAutoCompactCacheForTest(): void {
  // 实际缓存由 readCache/writeCache 管理, 这里只暴露接口
  // 测试可以走 fs.rm CACHE_DIR() 清理
}

/**
 * **压缩前后"保目标"锚点** (2026-10-01, 用户: 「压缩前后保目标」)。
 * 为什么: auto-compact 会把较早的历史**整段换成一句摘要** ✗ —— 摘要写给"过去发生了什么",
 *   而**当前目标**往往丢在里面 ⇒ 压完模型醒过来半失忆 ⇒ 答非所问 / 重头问 / 改目标 ✓(真机实测 ✓)。
 * 做法: 折叠前从历史里**确定性**抽出三件事(用户要什么 · 已经做到哪 · 下一步 ✓)+ 落成一条 system 消息
 *   **紧跟摘要**放回 ⇒ 摘要丢了目标它也还在 ✓。不调模型(便宜 ✓ 可测 ✓)。
 */
export function buildGoalAnchor(collapsed: Message[], remaining: Message[] = []): Message | null {
  const all = [...collapsed, ...remaining];
  if (!all.length) return null;
  const clip = (s: string, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  // ⓐ 用户当前要的(最近一条 user ✓ —— 若在 remaining 里也没关系, 取全局最后一条 ✓)
  const lastUser = [...all].reverse().find((m) => m.role === 'user');
  const ask = lastUser ? clip(String((lastUser as any).content || ''), 300) : '';
  // ⓑ 已经做到哪: 最近 3 个工具动作(名字 + 结果要点 ✓)
  const tools = all.filter((m) => m.role === 'tool').slice(-3).map((m) => {
    const r: any = (m as any).toolResult;
    const head = clip(String(r?.error || r?.output || (m as any).content || ''), 80);
    return `  · ${(m as any).tool || 'tool'}: ${head}`;
  });
  // ⓒ 助手最后说的一句话(它的意图/下一步 ✓)
  const lastAssistant = [...all].reverse().find((m) => m.role === 'assistant' && String((m as any).content || '').trim());
  const said = lastAssistant ? clip(String((lastAssistant as any).content || ''), 200) : '';

  const body = [
    '【压缩前的现场 · 别丢】',
    ask ? `用户当前要的: ${ask}` : '用户当前要的: (未捕捉到 —— 若不确定, 先按最近的目标继续, 别改题)',
    tools.length ? `已经做过:\n${tools.join('\n')}` : '',
    said ? `我上一步说的是: ${said}` : '',
    '下一步: 接着把上面这件事**做完** —— 不要重头问、不要换目标、不要重复已完成的步骤。',
  ].filter(Boolean).join('\n');
  return { role: 'system', content: body } as any;
}
