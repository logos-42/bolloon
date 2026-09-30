/**
 * session-summary.ts — 用 AI 给**会话**起标题 + 一句话摘要 (leo 2026-09-30)
 *
 * 起因: `/sessions` 表格里 Title 那列原来只能显示会话 key (`20260930_171712_840093`),
 *   Preview 常常是 `—` —— leo: 「Title, Preview 要有内容, 使用 AI 来总结进去」。
 *
 * 三条纪律:
 *   1. **只算一次** —— 结果写回会话文件 `metadata.{title,preview,summarizedAt}`; 下次直接读, 不再花钱。
 *   2. **不编** —— AI 不可用/输出不合规时, 退回"真实首条用户消息"当 preview, title 保持 key,
 *      并把 `source` 如实标出来 (调用方据此决定要不要提示用户)。
 *   3. **不卡** —— 单条会话有超时 (默认 12s), 失败不留半截标题 (整条要么写成功要么不写)。
 */

import { SessionStore } from '../agents/session-store.js';
import { getMinimax } from '../llm/pi-ai.js';

export interface SessionDigest {
  title: string;
  preview: string;
  /** ai = 模型总结出来的 · raw = 退回真实首条用户消息 · none = 会话里没有真实用户内容 */
  source: 'ai' | 'raw' | 'none';
}

/**
 * 自动注入的上下文块 (不是用户说的话)。
 *   ⚠ 2026-09-30 真机发现 (leo: 「结束进程的时候没有加载 title 和总结」): CLI 把**用户那句话
 *   **附在注入块末尾**, 用 `\n---\n` 分隔 —— 实测长这样:
 *       <!-- current-turn: … -->
 *       # 你的项目上下文 (自动 bootstrap …)
 *       … [预算截断]
 *
 *       ---
 *
 *       你好
 *   ⇒ 整块丢掉的话, 所有 CLI 会话都"没有用户内容" (标题永远出不来)。
 *   正确做法: **取末尾那一段**当用户输入 (见 userTextFrom), 只把真正的上下文头当注入。
 */
const isInjected = (x: string) =>
  /^<!--/.test(x.trim()) || /^#\s*你的项目上下文/.test(x.trim()) || /^\[cron\]/.test(x.trim()) || /^<!-- current-turn/.test(x.trim());

/**
 * 从一条 user 消息里取"真正属于用户的那句话":
 *   · 普通消息 → 原样
 *   · 注入块 → 取最后一个 `---` 分隔线之后的尾巴 (那是用户的输入)
 *   · 拿不到有效尾巴 (还是上下文/太短) → 返回空串 (调用方跳过)
 */
export function userTextFrom(content: string): string {
  const c = String(content || '').trim();
  if (!c) return '';
  if (!isInjected(c)) return c;
  const parts = c.split(/\n\s*-{3,}\s*\n/);
  const tail = (parts[parts.length - 1] || '').trim();
  if (!tail || isInjected(tail)) return '';
  // 尾巴太短 (一两个字符) 多半是分隔符残渣, 不算用户内容
  return tail.length >= 2 ? tail : '';
}

const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

const SYS = '你是终端会话的命名器。只输出一行 JSON, 不要解释、不要代码块、不要多余文字。';
const buildPrompt = (head: string, tail: string) =>
  `下面是同一个终端会话的「开头」和「结尾」。请用中文输出一行 JSON:\n` +
  `{"title":"不超过 20 个字的标题, 说清这次会话在做什么", "preview":"不超过 40 个字, 一句话摘要, 最有信息量的那件事"}\n\n` +
  `【开头】\n${head}\n\n【结尾】\n${tail}\n`;

/** 从模型输出里抠出第一个 JSON 对象 (抗代码块/前后废话) */
function parseDigest(raw: string): { title: string; preview: string } | null {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { title?: unknown; preview?: unknown };
    const title = clip(String(o.title ?? ''), 28);
    const preview = clip(String(o.preview ?? ''), 56);
    if (!title) return null;
    return { title, preview };
  } catch {
    return null;
  }
}

/**
 * 给一条会话生成标题 + 摘要。已经算过 (metadata.title) 就直接返回, 不再调模型。
 * 失败时不抛错 —— 返回 raw/none, 让调用方如实显示。
 */
export async function summarizeSession(
  key: string,
  opts: { store?: SessionStore; timeoutMs?: number; force?: boolean } = {},
): Promise<SessionDigest> {
  const store = opts.store ?? new SessionStore();
  let msgs: Array<{ role?: string; content?: string }> = [];
  let meta: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await (await import('fs/promises')).readFile(store.pathFor(key), 'utf-8')) as any;
    msgs = Array.isArray(raw) ? raw : (raw?.messages || []);
    meta = (!Array.isArray(raw) && raw?.metadata) || {};
  } catch {
    return { title: key, preview: '', source: 'none' };
  }
  if (!opts.force && typeof meta.title === 'string' && meta.title.trim()) {
    return { title: String(meta.title), preview: String(meta.preview ?? ''), source: 'ai' };
  }

  // 2026-09-30: 用 userTextFrom 而不是"整块丢掉" —— 用户的话在注入块末尾 (见上面注释)
  const userTexts = msgs
    .filter(m => m?.role === 'user' && typeof m.content === 'string')
    .map(m => userTextFrom(String(m.content)))
    .filter(t => t.length > 0);
  const userMsgs = userTexts.map(t => ({ content: t }));
  const rawPreview = userMsgs.length ? clip(String(userMsgs[0].content), 56) : '';
  if (!userMsgs.length) return { title: key, preview: '', source: 'none' };

  const head = userMsgs.slice(0, 2).map(m => clip(String(m.content), 300)).join('\n');
  const tailFrom = msgs.filter(m => typeof m?.content === 'string' && m.content.trim()).slice(-2);
  const tail = tailFrom.map(m => `${m.role}: ${clip(String(m.content), 300)}`).join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(2000, opts.timeoutMs ?? 12_000));
  try {
    const llm = getMinimax();
    const res = await llm.chat(buildPrompt(head, tail), SYS, ac.signal, undefined, 'auto-compact', 'session-summary') as unknown;
    // 2026-09-30 实测: chat() 返回的是**对象** `{reply, reasoningContent, toolCalls, messages, usage}`
    //   —— 文本在 `reply` (第一版写成 String(raw) ⇒ 拿到 "[object Object]" ⇒ 总结永远退回 raw)。
    const text = typeof res === 'string'
      ? res
      : String((res as any)?.reply ?? (res as any)?.content ?? (res as any)?.text ?? '');
    const parsed = parseDigest(text);
    if (parsed) {
      // 整条写回 (要么全写, 要么不写) —— 下次 /sessions 直接读, 不再调模型
      try { await store.updateMetadata(key, { title: parsed.title, preview: parsed.preview, summarizedAt: Date.now() }); } catch { /* 写不进也不影响这次显示 */ }
      return { title: parsed.title, preview: parsed.preview, source: 'ai' };
    }
    return { title: key, preview: rawPreview, source: 'raw' };
  } catch {
    return { title: key, preview: rawPreview, source: 'raw' };
  } finally {
    clearTimeout(timer);
  }
}
