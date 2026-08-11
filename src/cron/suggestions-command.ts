/**
 * suggestions-command.ts — `/suggestions` CLI 子命令处理 (纯函数返回文本)
 *
 * 借鉴 Hermes agent suggestions_cmd.py 心智: 一个入口, 多个子动作, 全部返回可回显的文本.
 * 用法:
 *   /suggestions            → 列出当前待处理建议
 *   /suggestions accept <n> → 接受第 n 条 (转成任务 / 消费)
 *   /suggestions dismiss <n>
 *   /suggestions clear      → 全部清空
 *   /suggestions catalog    → 列出内置建议目录
 *   /suggestions install <dedupKey> → 从目录装机 (生成 suggestion 或 cron job)
 *
 * 返回 [text, consumedSuggestionId?]; 无副作用逻辑放在 store, 本模块只做编排与文本渲染.
 */

import {
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  clearSuggestions,
  addSuggestion,
} from './suggestions.js';
import { addJob } from './jobs-store.js';
import { findCatalogEntry, SUGGESTION_CATALOG } from './suggestion-catalog.js';
import type { Suggestion } from './suggestions.js';

function noArgs(): string {
  return '用法: /suggestions \u3000| accept <n> \u3000| dismiss <n> \u3000| clear \u3000| catalog \u3000| install <dedupKey>';
}

function renderList(items: Suggestion[]): string {
  if (items.length === 0) return '当前没有待处理建议。\n\n可用: /suggestions catalog 查看内置建议目录。';
  const lines = items.map(
    (s, i) =>
      `${i + 1}. [${s.source}] ${s.summary}${s.dueAt ? ` (到期 ${s.dueAt})` : ''}`,
  );
  return lines.join('\n') + `\n\n用 /suggestions accept <n> 接受, dismiss <n> 忽略, clear 全清。`;
}

export function renderCatalog(): string {
  return '内置建议目录:\n' +
    SUGGESTION_CATALOG.map(
      (c) => `- ${c.dedupKey}: ${c.title} — ${c.summary}`,
    ).join('\n') +
    '\n\n用 /suggestions install <dedupKey> 装机。';
}

export interface SuggestionsCommandResult {
  text: string;
  /** 若接受了一条建议, 返回它 (调用方可转成任务) */
  accepted?: Suggestion;
}

export async function handleSuggestionsCommand(
  args: string,
  home?: string,
): Promise<SuggestionsCommandResult> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0]?.toLowerCase() ?? '';

  switch (action) {
    case '':
    case 'list': {
      const items = await listSuggestions(home);
      return { text: renderList(items) };
    }
    case 'accept': {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 1) return { text: '用法: /suggestions accept <n>' };
      const items = await listSuggestions(home);
      const target = items[n - 1];
      if (!target) return { text: `没有第 ${n} 条建议。` };
      const accepted = await acceptSuggestion(target.id, home);
      if (!accepted) return { text: '该建议已被移除, 请重试。' };
      return {
        text: `已接受: ${accepted.summary}`,
        accepted,
      };
    }
    case 'dismiss': {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 1) return { text: '用法: /suggestions dismiss <n>' };
      const items = await listSuggestions(home);
      const target = items[n - 1];
      if (!target) return { text: `没有第 ${n} 条建议。` };
      const ok = await dismissSuggestion(target.id, home);
      return { text: ok ? `已忽略: ${target.summary}` : '忽略失败。' };
    }
    case 'clear': {
      const n = await clearSuggestions(home);
      return { text: `已清空 ${n} 条建议。` };
    }
    case 'catalog': {
      return {
        text: renderCatalog(),
      };
    }
    case 'install': {
      const key = parts[1];
      if (!key) return { text: '用法: /suggestions install <dedupKey>' };
      const entry = findCatalogEntry(key);
      if (!entry) return { text: `目录里没有 ${key}。用 /suggestions catalog 看。` };
      // 有 schedule + prompt → 直接生成 cron job; 否则先塞一条建议
      const s = await addSuggestion(
        { dedupKey: entry.dedupKey, summary: entry.summary, source: 'system' },
        home,
      );
      let extra = '';
      if (entry.schedule && entry.prompt) {
        await addJob({ name: entry.title, schedule: entry.schedule, prompt: entry.prompt }, home);
        extra = ` 并生成了定时任务 (${entry.schedule})。`;
      }
      return { text: `已装机: ${entry.title}${extra}\n(可用 /suggestions dismiss 1 撤销这条建议)` };
    }
    default:
      return { text: noArgs() };
  }
}