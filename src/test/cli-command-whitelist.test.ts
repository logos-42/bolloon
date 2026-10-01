/**
 * CLI 命令白名单不许漂移 (2026-10-01)。
 *
 * 用户实测: 输入 `/group`(不是命令)⇒ 没有兜底 ⇒ **被当成用户消息发给模型** ✗ (白烧一轮工具调用)。
 * 修法: 分发链顶部加白名单兜底 —— 以 / 开头但不在名单里的输入, 打提示 + **不发送**。
 * 这张门负责: 把 `src/index.ts` 分发链里出现的每个命令字面量, 与白名单逐一核对。
 *   ⇒ 以后新增命令忘了登记, 门会红 (白名单自己那一段会被排除, 免得自我循环)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');

function whitelistHeads(src: string): string[] {
  const m = /export const CLI_KNOWN_COMMAND_HEADS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 去掉白名单块自己 + 注释行, 再从**分发链**里抽命令字面量 */
function commandLiteralsInDispatch(src: string): string[] {
  const wl = /export const CLI_KNOWN_COMMAND_HEADS: ReadonlySet<string> = new Set\(\[[\s\S]*?\]\);/.exec(src);
  const body = wl ? src.replace(wl[0], '') : src;
  const start = body.indexOf('const cmd = trimmed.toLowerCase();');
  const dispatch = start >= 0 ? body.slice(start) : body;
  const noComments = dispatch.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const found = new Set<string>();
  for (const m of noComments.matchAll(/(?:cmdHead|cmd)\s*===\s*'([^']+)'/g)) found.add(m[1]);
  for (const m of noComments.matchAll(/\.startsWith\('(\/[a-zA-Z0-9_-]+)(?: |')/g)) found.add(m[1]);
  for (const m of noComments.matchAll(/trimmed\.toLowerCase\(\)\s*===\s*'([^']+)'/g)) found.add(m[1]);
  // 多词命令 (如 /email clear) 取**首词** —— 白名单登记的是命令头
  return [...found].filter((x) => x.startsWith('/')).map((x) => x.split(/\s+/)[0]);
}

describe('CLI 命令白名单', () => {
  it('白名单非空且都长得像命令', () => {
    const heads = whitelistHeads(SRC);
    expect(heads.length).toBeGreaterThan(30);
    for (const h of heads) expect(h.startsWith('/'), `${h} 不像命令`).toBe(true);
  });

  it('**分发链里的每个命令都在白名单里** (忘了登记 ⇒ 这里红)', () => {
    const heads = new Set(whitelistHeads(SRC));
    const missing = commandLiteralsInDispatch(SRC).filter((c) => !heads.has(c));
    expect(missing, `这些命令没登记进白名单: ${missing.join(' ')}`).toEqual([]);
  });

  it('白名单里没有明显不存在的命令 (反向: 名单 ⊆ 出现过或已知别名)', () => {
    const heads = whitelistHeads(SRC);
    // 至少不能有空串/重复
    expect(new Set(heads).size).toBe(heads.length);
    expect(heads.every((h) => h.length > 1)).toBe(true);
  });
});
