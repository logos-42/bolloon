/**
 * 门: `bolloon task <子命令>` 的分派与入口白名单必须一致。
 *
 * 为什么需要这道门 (2026-09-24 实测踩过):
 *   `src/cli-entry.ts` 用 TASK_SUBCOMMANDS 判断 "这是子命令还是 M1 任务正文"。
 *   C7 新增 announce/trail/post 时, tasks.ts 里加了 case、help 也写了, 但**漏了白名单** →
 *   这三个子命令落进 M1 自由文本路径, 被当成"任务正文"真的去跑(会买能力、会花钱),
 *   而且输出看着像正常执行 —— 静默错, 最坏的那种。
 *
 * 本门用**源级扫描**比对两侧: 少一个(新子命令被 M1 吞) 或 多一个(白名单有死条目) 都判红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tasksSrc = fs.readFileSync(path.join(root, 'src/cli/commands/tasks.ts'), 'utf8');
const entrySrc = fs.readFileSync(path.join(root, 'src/cli-entry.ts'), 'utf8');

/** taskCommand 里 switch 到 default 之前的 case 列表 */
function dispatchedSubcommands(): string[] {
  const start = tasksSrc.indexOf('export async function taskCommand');
  const end = tasksSrc.indexOf('// ── list', start);
  const block = start >= 0 && end > start ? tasksSrc.slice(start, end) : '';
  return [...block.matchAll(/case\s+'([a-zA-Z][a-zA-Z0-9-]*)'\s*:/g)].map((m) => m[1]);
}

/** cli-entry.ts 里 TASK_SUBCOMMANDS 的条目 */
function whitelistedSubcommands(): string[] {
  const m = entrySrc.match(/TASK_SUBCOMMANDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const body = m ? m[1] : '';
  return [...body.matchAll(/'([a-zA-Z][a-zA-Z0-9-]*)'/g)].map((x) => x[1]);
}

describe('task 子命令白名单 ↔ 分派一致性', () => {
  it('两侧都真的解析出了内容 (门自身不能空转)', () => {
    const d = dispatchedSubcommands();
    const w = whitelistedSubcommands();
    expect(d.length, 'tasks.ts 的 case 解析为空 → 本门的正则失效了, 不是通过').toBeGreaterThan(8);
    expect(w.length, 'cli-entry.ts 的白名单解析为空 → 本门的正则失效了, 不是通过').toBeGreaterThan(8);
    expect(d).toContain('publish');
    expect(d).toContain('announce');
  });

  it('★ tasks.ts 里每个 case 都必须在入口白名单里 (否则会被当 M1 任务正文跑)', () => {
    const missing = dispatchedSubcommands().filter((c) => !whitelistedSubcommands().includes(c));
    expect(missing, `这些子命令没登记进 cli-entry.ts 的 TASK_SUBCOMMANDS: ${missing.join(', ')}`).toEqual([]);
  });

  it('★ 白名单里不留死条目 (写了却没有 dispatch 的会误导使用者)', () => {
    const orphan = whitelistedSubcommands().filter((c) => !dispatchedSubcommands().includes(c));
    expect(orphan, `白名单里这些没有对应的 case: ${orphan.join(', ')}`).toEqual([]);
  });
});
